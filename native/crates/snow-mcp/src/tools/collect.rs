use super::*;

use std::path::PathBuf;

use super::super::builtin::{get_builtin_servers_with_tools, get_builtin_tools};
use super::super::servers::skills::SkillsService;
use super::super::servers::sub_agents::{
    is_sub_agent_reserved_tool, SUB_AGENT_COMMS_TOOL_FULL_NAMES, SUB_AGENT_MAIN_TOOL_FULL_NAMES,
};
use crate::storage::services::system_settings::{McpGlobalScopeSettings, McpProjectScopeSettings};

pub async fn collect_all_mcp_tools(
    project_id: Option<&str>,
    include_workflow_tool: bool,
    active_plugin_ids: Option<&std::collections::HashSet<String>>,
) -> Result<Vec<McpTool>> {
    // 供 UI / 诊断列举工具：不做按需加载，保持完整清单。
    collect_all_mcp_tools_for_workspace(
        project_id,
        None,
        include_workflow_tool,
        active_plugin_ids,
        false,
        None,
    )
    .await
}

pub async fn collect_all_mcp_tools_for_workspace(
    project_id: Option<&str>,
    analysis_root: Option<&Path>,
    include_workflow_tool: bool,
    active_plugin_ids: Option<&std::collections::HashSet<String>>,
    defer_plugin_tools: bool,
    conversation_id: Option<&str>,
) -> Result<Vec<McpTool>> {
    let (mut tools, _) = collect_mcp_tools(
        project_id,
        include_workflow_tool,
        None,
        analysis_root,
        false,
        false,
        active_plugin_ids,
        defer_plugin_tools,
        conversation_id,
        false,
    )
    .await?;
    apply_semantic_routing(&mut tools);
    Ok(tools)
}

/// Only final request tools are allowed to contribute routing recommendations.
fn apply_semantic_routing(tools: &mut [McpTool]) {
    super::super::servers::lsp::prompt_context::append_tool_guidance(tools);
}

/// Apply request restrictions before fallback suppression and routing text.
/// `project_override`：子代理显式白名单，豁免项目级启停（仅保留全局黑名单）。
async fn collect_mcp_tools(
    project_id: Option<&str>,
    include_workflow_tool: bool,
    allowed_names: Option<&std::collections::HashSet<String>>,
    analysis_root: Option<&Path>,
    project_override: bool,
    explicit_child_comms: bool,
    active_plugin_ids: Option<&std::collections::HashSet<String>>,
    defer_plugin_tools: bool,
    conversation_id: Option<&str>,
    cache_only: bool,
) -> Result<(Vec<McpTool>, std::collections::HashSet<String>)> {
    let search_generation = super::super::servers::tool_search::generation();
    let project_override = project_override && allowed_names.is_some();
    let scope = load_project_scope(project_id).await?;
    let global_scope = load_global_scope().await?;

    // Determine whether the codebase search tool should be included.
    // It requires: (1) a project id, (2) codebase enabled in project scope,
    // and (3) at least one embedded chunk in the vector table.
    let codebase_available = is_codebase_available(project_id).await?;

    // Image generation tool is only exposed when at least one channel
    // (OpenAI / Gemini) is configured and enabled in Settings -> Image
    // generation; when both are unconfigured the tool disappears entirely.
    // The non-sensitive summary of the current default channel is also
    // loaded here (single blocking read) and injected into the tool
    // definition so the agent sees the real model/provider instead of
    // guessing from static text (issue #63).
    let imagegen_context =
        tokio::task::spawn_blocking(|| crate::mcp::servers::imagegen::default_channel_context())
            .await
            .map_err(|error| {
                Error::new(
                    Status::GenericFailure,
                    format!("Failed to check image generation configuration: {error}"),
                )
            })??;
    let imagegen_configured = imagegen_context.is_some();

    // Configuration/authorization stays project-scoped while stack detection
    // and negotiated capability/health checks use the actual analysis worktree.
    // No server is started by discovery; failures keep static fallbacks.
    let lsp_exposure = super::super::servers::lsp::prompt_context::tool_exposure_for_workspace(
        project_id,
        analysis_root,
    )
    .await
    .unwrap_or_else(|error| {
        eprintln!("LSP discovery unavailable; retaining static fallbacks: {error}");
        Default::default()
    });
    let lsp_available_tools = lsp_exposure.tools;

    // 精简模式（全局开关）：启用后 LITE_MODE_DISABLED_SERVER_IDS 中的
    // 内置服务器（browser / app-control / terminal）整体排除在请求上下文
    // 之外，为上下文窗口较短的模型节约 token。用户在 MCP 面板手动重新
    // 启用任一服务器时会自动关闭该模式（见 set_mcp_project_server_enabled）。
    let lite_mode = with_database_path(|database_path| {
        crate::storage::services::system_settings::get_lite_mode(&database_path)
    })
    .await?;
    // 上下文回溯工具只服务于分层增量压缩：开关关闭时不进入请求上下文。
    let context_fold = with_database_path(|database_path| {
        crate::storage::services::system_settings::get_context_fold(&database_path)
    })
    .await?;

    let builtin_tools = get_builtin_tools();

    // Read effective plugin configuration without connecting to plugin servers.
    let mut plugin_servers = super::super::external::available_plugin_servers(
        project_id, scope.as_ref(),
    ).await?;
    if defer_plugin_tools {
        if let Some(names) = allowed_names {
            plugin_servers.retain(|server, _| {
                let prefix = format!("{server}-");
                names.iter().any(|name| {
                    name.starts_with(&prefix)
                        && !global_scope.as_ref().is_some_and(|global| global.is_tool_disabled(name))
                        && scope.as_ref().is_none_or(|scope| scope.is_tool_enabled(name))
                })
            });
        }
    }
    let tool_search_available = !plugin_servers.is_empty();

    let mut tools = builtin_tools
        .into_iter()
        .filter(|tool| {
            if allowed_names.is_some_and(|names| !names.contains(&tool.full_name())) {
                return false;
            }
            // The WorkFlow graph tool is request-scoped: it only exists while
            // the current request is in WorkFlow Mode.
            if tool.server_id == "workflow" {
                return include_workflow_tool;
            }
            // 精简模式：LITE_MODE_DISABLED_SERVER_IDS 中的服务器整体禁用。
            if lite_mode && LITE_MODE_DISABLED_SERVER_IDS.contains(&tool.server_id.as_str()) {
                return false;
            }
            // Communication requires an explicit runtime token, even for '*'.
            // Configuration permission alone never grants per-run collaboration.
            if SUB_AGENT_COMMS_TOOL_FULL_NAMES.contains(&tool.full_name().as_str())
                && !explicit_child_comms
            {
                return false;
            }
            // Exclude codebase search tool unless the project has codebase
            // enabled and an existing index.
            if tool.server_id == "codebase" && !codebase_available {
                return false;
            }
            // Exclude image generation when no channel is configured.
            if tool.server_id == "imagegen" && !imagegen_configured {
                return false;
            }
            if tool.server_id == "context" && !context_fold {
                return false;
            }
            // LSP tools are off by default (§8.0): excluded unless at least
            // one enabled language server is configured, and further filtered
            // by the union of enabled servers' capabilities (§8.7). The
            // default-disabled server gate (project opt-in) is applied by
            // tool_is_enabled below.
            if tool.server_id == "lsp" && !lsp_available_tools.contains(&tool.full_name()) {
                return false;
            }
            if tool.server_id == "toolSearch" {
                // 搜索能力只由有效启用的工具插件派生；忽略遗留的人工启停记录。
                return tool_search_available
                    && (!defer_plugin_tools || conversation_id.is_some());
            }
            tool_visible(
                tool,
                global_scope.as_ref(),
                scope.as_ref(),
                project_override,
            )
        })
        .collect::<Vec<_>>();

    // A tool-less request must not revoke another concurrent request's state.

    // Inject the current default image channel summary (non-sensitive, no
    // API key) into the imagegen-generate description so the agent can see
    // the actual configured channel/provider/model/size/quality.
    if let Some(context) = imagegen_context {
        if let Some(tool) = tools.iter_mut().find(|tool| {
            tool.server_id == "imagegen"
                && tool.name == super::super::servers::imagegen::TOOL_GENERATE
        }) {
            tool.description = format!(
                "{}\n\nCurrent configuration:\n{}",
                tool.description, context
            );
        }
    }

    // Each tool lists only the languages/configurations supporting that operation.
    for tool in tools.iter_mut().filter(|tool| tool.server_id == "lsp") {
        if let Some(summary) = lsp_exposure.tool_summaries.get(&tool.full_name()) {
            tool.description
                .push_str(&format!("\n\nCurrent tool support:\n{summary}"));
        }
    }

    if let Some(skill_tool) = SkillsService::new().tool(project_id).await? {
        if allowed_names.is_none_or(|names| names.contains(&skill_tool.full_name()))
            && tool_visible(
                &skill_tool,
                global_scope.as_ref(),
                scope.as_ref(),
                project_override,
            )
        {
            tools.push(skill_tool);
        }
    }

    if defer_plugin_tools {
        if let Some(search_tool) = tools.iter_mut().find(|tool| {
            tool.server_id == "toolSearch" && tool.name == "discover"
        }) {
            super::super::servers::tool_search::validate_session(project_id, conversation_id, false).await?;
            let summary = super::super::servers::tool_search::plugin_summary(project_id, &plugin_servers).await?;
            search_tool.description.push_str(&format!("\n\nEnabled tool plugins (name and description):\n{summary}"));
            let matched = super::super::servers::tool_search::prepare_session(
                project_id, conversation_id, &plugin_servers, allowed_names,
                scope.as_ref(), global_scope.as_ref(), search_generation,
            )?;
            tools.extend(matched);
        }
    }

    let pending = match super::super::external::discover_tools(
        project_id, scope.as_ref(), allowed_names, project_override,
        active_plugin_ids, defer_plugin_tools, false, cache_only,
    ).await {
        Ok((external_tools, _, _, _, pending)) => {
            tools.extend(external_tools.into_iter()
                .filter(|tool| tool_is_enabled(tool, global_scope.as_ref(), None)));
            pending.into_iter()
                .filter(|name| !global_scope.as_ref().is_some_and(|global| global.is_tool_disabled(name)))
                .collect()
        }
        Err(error) => {
            super::super::external::log_discovery_failure(project_id, "external", &error.to_string());
            if defer_plugin_tools { return Err(error); }
            eprintln!("Failed to discover external MCP tools: {error}");
            std::collections::HashSet::new()
        }
    };
    Ok((tools, pending))
}

/// Check whether the codebase search tool should be available for the
/// given project: the project must have codebase enabled AND have at
/// least one embedded chunk in its vector table.
pub(crate) async fn is_codebase_available(project_id: Option<&str>) -> Result<bool> {
    let Some(project_id) = project_id.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(false);
    };

    let project_id = project_id.to_string();
    let storage_info = crate::storage::initialize_app_storage()?;
    let database_path = PathBuf::from(storage_info.database_path);

    tokio::task::spawn_blocking(move || {
        let scope = crate::storage::services::system_settings::get_codebase_project_scope_settings(
            &database_path,
            &project_id,
        )?;
        if !scope.enabled.unwrap_or(false) {
            return Ok(false);
        }
        match crate::storage::services::codebase_index::get_index_stats(&database_path, &project_id)
        {
            Ok(stats) => Ok(stats.total_chunks > 0),
            Err(_) => Ok(false),
        }
    })
    .await
    .map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to check codebase availability: {error}"),
        )
    })?
}

pub async fn collect_allowed_mcp_tools_for_workspace(
    project_id: Option<&str>,
    analysis_root: Option<&Path>,
    tools_json: &str,
    allow_wildcard: bool,
    active_plugin_ids: Option<&std::collections::HashSet<String>>,
    conversation_id: Option<&str>,
) -> Result<Vec<McpTool>> {
    let (tools, unavailable) = collect_allowed_mcp_tools_with_report(
        project_id,
        analysis_root,
        tools_json,
        allow_wildcard,
        active_plugin_ids,
        conversation_id,
        false,
    )
    .await?;
    if !unavailable.is_empty() {
        eprintln!(
            "Sub-agent configured tools are unavailable (skipped): {}",
            unavailable
                .iter()
                .map(|item| format!("{} ({})", item.name, item.reason))
                .collect::<Vec<_>>()
                .join(", ")
        );
    }
    Ok(tools)
}

/// 子代理工具集解析，同时返回白名单中不可用的工具及原因。
/// 显式白名单豁免项目级启停（L3）；`["*"]` 仍按项目开关过滤。
pub(crate) async fn collect_allowed_mcp_tools_with_report(
    project_id: Option<&str>,
    analysis_root: Option<&Path>,
    tools_json: &str,
    allow_wildcard: bool,
    active_plugin_ids: Option<&std::collections::HashSet<String>>,
    conversation_id: Option<&str>,
    diagnostic_only: bool,
) -> Result<(Vec<McpTool>, Vec<SubAgentUnavailableTool>)> {
    let configured_names = parse_configured_tool_names(tools_json)?;
    let wildcard_enabled = configured_names.contains("*");
    if wildcard_enabled && !allow_wildcard {
        return Err(Error::new(
            Status::InvalidArg,
            "Only built-in sub-agents may enable the wildcard tool configuration".to_string(),
        ));
    }

    let (all_tools, pending_external) = collect_mcp_tools(
        project_id,
        false,
        if wildcard_enabled {
            None
        } else {
            Some(&configured_names)
        },
        analysis_root,
        !wildcard_enabled,
        configured_names.contains("sub-agents-sendMessage"),
        active_plugin_ids,
        true,
        conversation_id,
        diagnostic_only,
    )
    .await?;
    if wildcard_enabled {
        let mut result = all_tools;
        result.retain(|tool| !is_sub_agent_reserved_tool(&tool.full_name()));
        apply_semantic_routing(&mut result);
        return Ok((result, Vec::new()));
    }

    // 不可用工具跳过并结构化报因，保留可用工具，而不是整体失败（整体失败会让
    // provider 层把子代理请求静默降级为无工具）。
    let mut result = all_tools
        .into_iter()
        .filter(|tool| {
            let full_name = tool.full_name();
            configured_names.contains(&full_name) && !is_sub_agent_reserved_tool(&full_name)
        })
        .collect::<Vec<_>>();
    let available_names = result
        .iter()
        .map(McpTool::full_name)
        .collect::<std::collections::HashSet<_>>();
    let mut unavailable_names = configured_names
        .iter()
        .filter(|name| !available_names.contains(*name))
        .cloned()
        .collect::<Vec<_>>();
    // A cache miss does not prove that a configured external tool is unavailable.
    unavailable_names.retain(|name| !pending_external.contains(name));
    let search_server = super::super::servers::tool_search::SERVER_ID;
    let discover_name = format!("{}-{}", search_server, super::super::servers::tool_search::TOOL_DISCOVER);
    let list_name = format!("{}-{}", search_server, super::super::servers::tool_search::TOOL_SEARCH);
    if configured_names.contains(&discover_name) || (diagnostic_only && configured_names.contains(&list_name)) {
        // A configured plugin tool may be absent only because discovery is deferred.
        // Check ownership and switches without connecting or claiming that it exists.
        let scope = load_project_scope(project_id).await?;
        let global = load_global_scope().await?;
        let servers = super::super::external::available_plugin_servers(project_id, scope.as_ref()).await?;
        let pending = unavailable_names.iter().filter(|name| {
            split_tool_full_name(name).is_some_and(|(server, _)| servers.contains_key(server))
                && !global.as_ref().is_some_and(|global| global.is_tool_disabled(name))
                && scope.as_ref().is_none_or(|scope| scope.is_tool_enabled(name))
        }).cloned().collect::<std::collections::HashSet<_>>();
        let discover_enabled = !pending.is_empty()
            && configured_names.contains(&discover_name)
            && tool_name_is_enabled(&discover_name, search_server, global.as_ref(), scope.as_ref())
            && (diagnostic_only || available_names.contains(&discover_name));
        let list_enabled = diagnostic_only && !pending.is_empty()
            && configured_names.contains(&list_name)
            && tool_name_is_enabled(&list_name, search_server, global.as_ref(), scope.as_ref());
        unavailable_names.retain(|name| {
            !(discover_enabled && (name == &discover_name || pending.contains(name))
                || list_enabled && name == &list_name)
        });
    }
    unavailable_names.sort();
    let unavailable = if unavailable_names.is_empty() {
        Vec::new()
    } else {
        diagnose_unavailable_tools(project_id, unavailable_names).await
    };

    // No implicit communication tools: runtime whitelist is authoritative.
    apply_semantic_routing(&mut result);
    Ok((result, unavailable))
}

/// 为不可用工具归因。只读诊断：任一查询失败按保守原因返回，不影响请求。
async fn diagnose_unavailable_tools(
    project_id: Option<&str>,
    names: Vec<String>,
) -> Vec<SubAgentUnavailableTool> {
    let global_scope = load_global_scope().await.ok().flatten();
    let lite_mode = with_database_path(|database_path| {
        crate::storage::services::system_settings::get_lite_mode(&database_path)
    })
    .await
    .unwrap_or(false);
    let builtin_names = get_builtin_tools()
        .iter()
        .map(McpTool::full_name)
        .collect::<std::collections::HashSet<_>>();
    let needs_external = names.iter().any(|name| {
        !builtin_names.contains(name)
            && !name.starts_with("skills-")
            && !is_sub_agent_reserved_tool(name)
    });
    let external_servers = if needs_external {
        super::super::external::discover_project_servers(project_id)
            .await
            .unwrap_or_default()
    } else {
        Vec::new()
    };

    names
        .into_iter()
        .map(|name| {
            let reason = if is_sub_agent_reserved_tool(&name) {
                "reserved"
            } else if is_globally_disabled(&name, global_scope.as_ref()) {
                "global_disabled"
            } else if builtin_names.contains(&name) {
                let server_id = split_tool_full_name(&name)
                    .map(|(server_id, _)| server_id)
                    .unwrap_or_default();
                if lite_mode && LITE_MODE_DISABLED_SERVER_IDS.contains(&server_id) {
                    "lite_mode"
                } else {
                    "not_ready"
                }
            } else if name.starts_with("skills-") {
                "not_ready"
            } else {
                match external_servers
                    .iter()
                    .find(|server| name.starts_with(&format!("{}-", server.public_name)))
                {
                    None => "not_found",
                    Some(server) if !server.global_enabled => "global_disabled",
                    Some(server) if !server.enabled => "server_disabled",
                    Some(_) => "server_unavailable",
                }
            };
            SubAgentUnavailableTool {
                name,
                reason: reason.to_string(),
            }
        })
        .collect()
}

/// 诊断子代理白名单（不发起模型请求），供渲染端激活时回传主控。
pub async fn diagnose_sub_agent_tools(
    project_id: Option<String>,
    tools_json: String,
) -> Result<Vec<SubAgentUnavailableTool>> {
    let project_id = project_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let (_, unavailable) = collect_allowed_mcp_tools_with_report(
        project_id.as_deref(), None, &tools_json, true, None, None, true,
    )
    .await?;
    Ok(unavailable)
}

/// Parse a JSON array of tool full names into a trimmed, non-empty set.
fn parse_configured_tool_names(tools_json: &str) -> Result<std::collections::HashSet<String>> {
    let names = serde_json::from_str::<Vec<String>>(tools_json).map_err(|error| {
        Error::new(
            Status::InvalidArg,
            format!("Allowed tools configuration must be a JSON string array: {error}"),
        )
    })?;
    Ok(names
        .into_iter()
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .collect())
}

/// Resolve a request-scoped tool whitelist without sub-agent semantics.
///
/// Used by stateless side channels (the desktop pet chat) that run with
/// `skip_context`: they still need real tools (web search, file search, file
/// read) but must never receive the full main-conversation tool set, the
/// teammate communication tools, or the main-session sub-agent management
/// tools. Tools that are disabled for the project or unavailable are silently
/// skipped so one missing tool never disables the whole set.
pub async fn collect_restricted_mcp_tools_for_workspace(
    project_id: Option<&str>,
    analysis_root: Option<&Path>,
    tools_json: &str,
    active_plugin_ids: Option<&std::collections::HashSet<String>>,
    conversation_id: Option<&str>,
) -> Result<Vec<McpTool>> {
    let configured_names = parse_configured_tool_names(tools_json)?;
    if configured_names.is_empty() {
        return Ok(Vec::new());
    }
    let (all_tools, _) = collect_mcp_tools(
        project_id,
        false,
        Some(&configured_names),
        analysis_root,
        false,
        false,
        active_plugin_ids,
        true,
        conversation_id,
        false,
    )
    .await?;
    let mut result = all_tools
        .into_iter()
        .filter(|tool| {
            configured_names.contains(&tool.full_name())
                // 子代理管理工具属于主会话职权，受限请求一律排除。
                && !SUB_AGENT_MAIN_TOOL_FULL_NAMES.contains(&tool.full_name().as_str())
        })
        .collect::<Vec<_>>();
    apply_semantic_routing(&mut result);
    Ok(result)
}

/// Built-in server ids that are disabled by default and must be explicitly
/// enabled per project. This keeps their tools out of the model context
/// (saving tokens) until the user opts in.
const DEFAULT_DISABLED_SERVER_IDS: &[&str] =
    &["terminal", "lsp", "computer-use", "browser", "html", "decision"];

/// 按「完整工具名 + server_id」判定工具级开关（`tool_is_enabled` 的按名版本）：
/// 系统提示词注入复用同一逻辑，保证「注入的工具 = 实际可见的工具」
/// （2026-09-25 一致性修复——此前 LSP 章节/清单只看域级与能力级开关，用户
/// 单独禁用某个 lsp-* 时仍会被注入，诱导模型调用不可见的工具）。
pub(crate) fn tool_name_is_enabled(
    full_name: &str,
    server_id: &str,
    global_scope: Option<&McpGlobalScopeSettings>,
    scope: Option<&McpProjectScopeSettings>,
) -> bool {
    // The global blacklist has the highest priority: a tool disabled
    // globally stays disabled regardless of project scope.
    if global_scope.is_some_and(|global| global.is_tool_disabled(full_name)) {
        return false;
    }
    // Default-disabled servers are excluded when there is no project
    // scope (no project context = user hasn't opted in).
    if DEFAULT_DISABLED_SERVER_IDS.contains(&server_id) {
        let Some(scope) = scope else {
            return false;
        };
        return scope.is_server_enabled(&builtin_scope_server_id(server_id))
            && scope.is_tool_enabled(full_name);
    }

    let Some(scope) = scope else {
        // 无项目上下文：默认关闭的工具不暴露
        return !crate::storage::services::system_settings::is_default_disabled_tool(full_name);
    };

    scope.is_server_enabled(&builtin_scope_server_id(server_id)) && scope.is_tool_enabled(full_name)
}

fn tool_is_enabled(
    tool: &McpTool,
    global_scope: Option<&McpGlobalScopeSettings>,
    scope: Option<&McpProjectScopeSettings>,
) -> bool {
    tool_name_is_enabled(&tool.full_name(), &tool.server_id, global_scope, scope)
}

fn is_globally_disabled(full_name: &str, global_scope: Option<&McpGlobalScopeSettings>) -> bool {
    global_scope.is_some_and(|global| global.is_tool_disabled(full_name))
}

/// 子代理显式白名单（project_override）只受全局黑名单约束，跳过项目级与默认关闭开关。
fn tool_visible(
    tool: &McpTool,
    global_scope: Option<&McpGlobalScopeSettings>,
    scope: Option<&McpProjectScopeSettings>,
    project_override: bool,
) -> bool {
    if project_override {
        return !is_globally_disabled(&tool.full_name(), global_scope);
    }
    tool_is_enabled(tool, global_scope, scope)
}

fn explicitly_allows_tool(allowed_tools: Option<&[String]>, name: &str) -> bool {
    allowed_tools.is_some_and(|tools| tools.iter().any(|tool| tool == name))
}

/// Call-time LSP visibility. Use the caller's existing allowed-tools snapshot
/// and intersect it with current exposure/scope (configuration can change after
/// the model request). Failure omits advisory text without blocking grep.
pub(crate) async fn visible_lsp_tool_names(
    project_id: Option<&str>,
    allowed_tools: Option<&[String]>,
    analysis_root: Option<&Path>,
) -> Vec<String> {
    let Ok(exposure) = super::super::servers::lsp::prompt_context::tool_exposure_for_workspace(
        project_id,
        analysis_root,
    )
    .await
    else {
        return Vec::new();
    };
    let Ok(global_scope) = load_global_scope().await else {
        return Vec::new();
    };
    let Ok(scope) = load_project_scope(project_id).await else {
        return Vec::new();
    };
    get_builtin_tools()
        .iter()
        .filter(|tool| {
            let full_name = tool.full_name();
            tool.server_id == "lsp"
                && exposure.tools.contains(&full_name)
                && request_allows_tool(allowed_tools, &full_name)
                && tool_visible(
                    tool,
                    global_scope.as_ref(),
                    scope.as_ref(),
                    explicitly_allows_tool(allowed_tools, &full_name),
                )
        })
        .map(McpTool::full_name)
        .collect()
}

pub(super) fn request_allows_tool(allowed_tools: Option<&[String]>, name: &str) -> bool {
    allowed_tools.is_none_or(|tools| tools.iter().any(|tool| tool == "*" || tool == name))
}

pub fn builtin_scope_server_id(server_id: &str) -> String {
    format!("builtin:{server_id}")
}

pub fn server_id_from_tool_name(tool_name: &str) -> Option<&str> {
    split_tool_full_name(tool_name).map(|(server_id, _)| server_id)
}

pub fn builtin_server_name(server_id: &str) -> &str {
    match server_id {
        "filesystem" => "Filesystem",
        "bash" => "Terminal",
        "todo" => "TODO",
        "grep" => "Search",
        "websearch" => "Web search",
        "browser" => "Browser",
        "user-interaction" => "User interaction",
        "app-control" => "App Control",
        "sub-agents" => "Sub-agents",
        "codebase" => "Codebase",
        "computer-use" => "Computer Use",
        "terminal" => "Terminal Control",
        "config" => "Config",
        "imagegen" => "Image Generation",
        "lsp" => "LSP",
        "memory" => "Project Memory",
        "workflow" => "WorkFlow",
        "html" => "HTML Renderer",
        "decision" => "Decision Model",
        "toolSearch" => "ToolSearch",
        "context" => "Context Recall",
        _ => server_id,
    }
}

/// `project_override`：子代理显式白名单中的工具，跳过项目级与默认关闭开关，
/// 精简模式与全局黑名单仍然生效。
pub async fn ensure_project_tool_enabled(
    project_id: Option<&str>,
    tool_name: &str,
    project_override: bool,
) -> Result<()> {
    // 精简模式执行层（与 collect 阶段排除保持一致）：Lite Mode 禁用的
    // browser / app-control / terminal 工具即使出现在陈旧工具列表中也
    // 拒绝执行。
    {
        let lite_mode = with_database_path(|database_path| {
            crate::storage::services::system_settings::get_lite_mode(&database_path)
        })
        .await?;
        if lite_mode {
            let Some(server_id) = server_id_from_tool_name(tool_name) else {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!("Invalid MCP tool name: {tool_name}"),
                ));
            };
            if LITE_MODE_DISABLED_SERVER_IDS.contains(&server_id) {
                return Err(Error::new(
                    Status::GenericFailure,
                    format!("MCP server \"{server_id}\" is disabled by Lite mode: {tool_name}"),
                ));
            }
        }
    }
    let global_scope = load_global_scope().await?;
    if global_scope
        .as_ref()
        .is_some_and(|scope| scope.disabled_tool_names.contains(tool_name))
    {
        return Err(Error::new(
            Status::GenericFailure,
            format!("MCP tool is disabled globally: {tool_name}"),
        ));
    }
    let Some(server_id) = server_id_from_tool_name(tool_name) else {
        return Err(Error::new(
            Status::InvalidArg,
            format!("Invalid MCP tool name: {tool_name}"),
        ));
    };
    // 全局服务器总闸。
    if global_scope
        .as_ref()
        .is_some_and(|scope| scope.is_server_disabled(&builtin_scope_server_id(server_id)))
    {
        return Err(Error::new(
            Status::GenericFailure,
            format!("MCP server is disabled globally: builtin:{server_id}"),
        ));
    }
    if project_override {
        return Ok(());
    }
    let scope = load_project_scope(project_id).await?;
    // 默认关闭的内置服务器（terminal/lsp/computer-use/browser/html）：必须在项目 scope
    // 中显式启用才可调用。无项目 scope（无项目上下文）= 用户从未启用，直接
    // 拒绝——与 collect 阶段 tool_is_enabled 的无 scope 判定保持一致，防止
    // 绕过工具列表的调用仍被执行。
    if DEFAULT_DISABLED_SERVER_IDS.contains(&server_id) {
        let Some(scope) = scope else {
            return Err(Error::new(
                Status::GenericFailure,
                format!(
                    "MCP server \"{server_id}\" is disabled by default and requires explicit per-project enablement: {tool_name}"
                ),
            ));
        };
        if !scope.is_server_enabled(&builtin_scope_server_id(server_id)) {
            return Err(Error::new(
                Status::GenericFailure,
                format!("MCP server is disabled for the current project: builtin:{server_id}"),
            ));
        }
        if !scope.is_tool_enabled(tool_name) {
            return Err(Error::new(
                Status::GenericFailure,
                format!("MCP tool is disabled for the current project: {tool_name}"),
            ));
        }
        return Ok(());
    }
    let Some(scope) = scope else {
        if crate::storage::services::system_settings::is_default_disabled_tool(tool_name) {
            return Err(Error::new(
                Status::GenericFailure,
                format!(
                    "MCP tool is disabled by default and requires explicit per-project enablement: {tool_name}"
                ),
            ));
        }
        return Ok(());
    };
    let (server_scope_id, project_owned) = if server_id == "skills"
        || get_builtin_servers_with_tools()
            .iter()
            .any(|(builtin_server_id, _)| builtin_server_id == server_id)
    {
        (builtin_scope_server_id(server_id), false)
    } else {
        let resolved_server =
            super::super::external::resolve_project_scope_server(project_id, tool_name)
                .await?
                .ok_or_else(|| {
                    Error::new(
                        Status::GenericFailure,
                        format!("MCP tool is no longer available: {tool_name}"),
                    )
                })?;
        (
            resolved_server.scope_server_id,
            resolved_server.project_owned,
        )
    };

    if !project_owned && !scope.is_server_enabled(&server_scope_id) {
        return Err(Error::new(
            Status::GenericFailure,
            format!("MCP server is disabled for the current project: {server_scope_id}"),
        ));
    }
    if !scope.is_tool_enabled(tool_name) {
        return Err(Error::new(
            Status::GenericFailure,
            format!("MCP tool is disabled for the current project: {tool_name}"),
        ));
    }

    Ok(())
}

pub async fn load_project_scope(
    project_id: Option<&str>,
) -> Result<Option<McpProjectScopeSettings>> {
    let Some(project_id) = project_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let project_id = project_id.to_string();
    with_database_path(move |database_path| {
        crate::storage::services::system_settings::get_mcp_project_scope_settings(
            &database_path,
            &project_id,
        )
        .map(Some)
    })
    .await
}

/// 加载全局 MCP 工具级 scope（无记录时 storage 层返回默认空黑名单）。
pub async fn load_global_scope() -> Result<Option<McpGlobalScopeSettings>> {
    with_database_path(move |database_path| {
        crate::storage::services::system_settings::get_mcp_global_scope_settings(&database_path)
            .map(Some)
    })
    .await
}

pub async fn with_database_path<T, F>(operation: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce(PathBuf) -> Result<T> + Send + 'static,
{
    tokio::task::spawn_blocking(move || {
        let storage_info = crate::storage::initialize_app_storage()?;
        operation(PathBuf::from(storage_info.database_path))
    })
    .await
    .map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to access project MCP scope storage: {error}"),
        )
    })?
}
