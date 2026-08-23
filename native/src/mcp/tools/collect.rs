use super::*;

use std::path::PathBuf;

use napi::bindgen_prelude::*;

use super::super::builtin::{get_builtin_servers_with_tools, get_builtin_tools};
use super::super::servers::skills::SkillsService;
use super::super::servers::sub_agents::{
    sub_agent_comms_tools, SUB_AGENT_COMMS_TOOL_FULL_NAMES, SUB_AGENT_MAIN_TOOL_FULL_NAMES,
};
use crate::storage::services::system_settings::{McpGlobalScopeSettings, McpProjectScopeSettings};

pub async fn collect_all_mcp_tools(
    project_id: Option<&str>,
    include_plan_mode_tool: bool,
) -> Result<Vec<McpTool>> {
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

    // LSP tools are off by default in two senses: (1) the lsp server is a
    // default-disabled server (same as terminal) — it must be explicitly
    // enabled per project via the MCP panel (checked by tool_is_enabled
    // below); (2) they are only exposed when at least one *enabled and
    // installed* language server exists (§8.0/§8.6 — enabled alone is not
    // enough: a command missing from PATH can never start). Tool-level
    // filtering follows §8.7: only the tools supported by the union of
    // enabled servers' capabilities are exposed (e.g. enabling only
    // csharp-ls hides lsp-rename / lsp-code-action / lsp-signature-help).
    // Project-scoped: evaluated against the project's effective configs
    // (project overrides global for the same lang, §8.5), matching the
    // invocation stage — project-only servers expose tools, and project
    // overrides that disable a server hide its tools. Single pass: one
    // config read + one TTL-cached PATH probe (performance: this runs on
    // every tool-list refresh).
    let lsp_exposure = super::super::servers::lsp::tool_exposure(project_id).await?;
    let lsp_available_tools = lsp_exposure.tools;

    // 精简模式（全局开关）：启用后 LITE_MODE_DISABLED_SERVER_IDS 中的
    // 内置服务器（browser / app-control / terminal）整体排除在请求上下文
    // 之外，为上下文窗口较短的模型节约 token。用户在 MCP 面板手动重新
    // 启用任一服务器时会自动关闭该模式（见 set_mcp_project_server_enabled）。
    // app-control-requestApproval 豁免此限制（Plan Mode 审批必需，仅
    // Plan Mode 请求中暴露，见下方判定）。
    let lite_mode =
        with_database_path(|database_path| {
            crate::storage::services::system_settings::get_lite_mode(&database_path)
        })
        .await?;

    let builtin_tools = get_builtin_tools();
    // 预计算「LSP 是否实际暴露」（可用能力集合 + scope 双重判定通过），供
    // codelens 互斥判定使用。lsp 是默认关闭服务器：仅凭「配置了可用服务器」
    // 就隐藏 codelens，会在用户尚未手动启用 builtin:lsp 时让两套工具同时
    // 消失，模型失去全部代码语义分析能力。
    let lsp_active = builtin_tools.iter().any(|tool| {
        tool.server_id == "lsp"
            && lsp_available_tools.contains(&tool.full_name())
            && tool_is_enabled(tool, global_scope.as_ref(), scope.as_ref())
    });

    let mut tools = builtin_tools
        .into_iter()
        .filter(|tool| {
            // The dedicated approval tool is request-scoped: it must only be
            // exposed to the model while the current request is in Plan Mode.
            if tool.full_name() == REQUEST_APPROVAL_FULL_NAME {
                return include_plan_mode_tool;
            }
            // 精简模式：LITE_MODE_DISABLED_SERVER_IDS 中的服务器整体禁用
            // （requestApproval 已在上方先行处理，保持 Plan Mode 审批可用）。
            if lite_mode
                && LITE_MODE_DISABLED_SERVER_IDS.contains(&tool.server_id.as_str())
            {
                return false;
            }
            // Sub-agent teammate communication tools are only exposed inside
            // sub-agent contexts (collect_allowed_mcp_tools appends them);
            // the main conversation never sees them.
            if SUB_AGENT_COMMS_TOOL_FULL_NAMES.contains(&tool.full_name().as_str()) {
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
            // LSP tools are off by default (§8.0): excluded unless at least
            // one enabled language server is configured, and further filtered
            // by the union of enabled servers' capabilities (§8.7). The
            // default-disabled server gate (project opt-in) is applied by
            // tool_is_enabled below.
            if tool.server_id == "lsp" && !lsp_available_tools.contains(&tool.full_name()) {
                return false;
            }
            // codelens 与 lsp-* 互斥（2026-08-16）：仅当 lsp-* 实际暴露
            //（可用能力 + 项目 scope 已启用 builtin:lsp）时隐藏 codelens
            //（语义分析更优）；LSP 未配置/不可用/未手动启用（含 SSH 远程）
            // 时暴露 codelens 作为 tree-sitter 静态分析兜底——两个工具集
            // 永远只有其一出现在模型面前，互补不冗余。
            if tool.server_id == "codelens" && lsp_active {
                return false;
            }
            tool_is_enabled(tool, global_scope.as_ref(), scope.as_ref())
        })
        .collect::<Vec<_>>();

    // Inject the current default image channel summary (non-sensitive, no
    // API key) into the imagegen-generate description so the agent can see
    // the actual configured channel/provider/model/size/quality.
    if let Some(context) = imagegen_context {
        if let Some(tool) = tools.iter_mut().find(|tool| {
            tool.server_id == "imagegen" && tool.name == super::super::servers::imagegen::TOOL_GENERATE
        }) {
            tool.description =
                format!("{}\n\nCurrent configuration:\n{}", tool.description, context);
        }
    }

    // Inject the current enabled-and-installed language-server summary into
    // every exposed lsp-* tool description (mirroring the imagegen pattern
    // above, §8.0/§8.6), so the agent sees which language servers are
    // actually active instead of guessing from static text. None when no
    // server is available — at which point no lsp-* tool is exposed anyway.
    // Project-scoped like the exposure filter above (§8.5); summary comes
    // from the same single pass (no second config read / probe).
    if let Some(summary) = lsp_exposure.summary {
        for tool in tools.iter_mut().filter(|tool| tool.server_id == "lsp") {
            tool.description =
                format!("{}\n\nCurrent configuration:\n{}", tool.description, summary);
        }
    }

    if let Some(skill_tool) = SkillsService::new().tool(project_id).await? {
        if tool_is_enabled(&skill_tool, global_scope.as_ref(), scope.as_ref()) {
            tools.push(skill_tool);
        }
    }

    match super::super::external::discover_tools(project_id, scope.as_ref()).await {
        // External tools are already filtered by the project scope inside
        // discover_tools; apply the global blacklist on top.
        Ok(external_tools) => tools.extend(
            external_tools
                .into_iter()
                .filter(|tool| tool_is_enabled(tool, global_scope.as_ref(), None)),
        ),
        Err(error) => eprintln!("Failed to discover external MCP tools: {error}"),
    }
    Ok(tools)
}
/// Check whether the codebase search tool should be available for the
/// given project: the project must have codebase enabled AND have at
/// least one embedded chunk in its vector table.
async fn is_codebase_available(project_id: Option<&str>) -> Result<bool> {
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

pub async fn collect_allowed_mcp_tools(
    project_id: Option<&str>,
    tools_json: &str,
    allow_wildcard: bool,
) -> Result<Vec<McpTool>> {
    let configured_names = serde_json::from_str::<Vec<String>>(tools_json).map_err(|error| {
        Error::new(
            Status::InvalidArg,
            format!("Sub-agent tools configuration must be a JSON string array: {error}"),
        )
    })?;
    let configured_names = configured_names
        .into_iter()
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .collect::<std::collections::HashSet<_>>();
    let wildcard_enabled = configured_names.contains("*");
    if wildcard_enabled && !allow_wildcard {
        return Err(Error::new(
            Status::InvalidArg,
            "Only built-in sub-agents may enable the wildcard tool configuration".to_string(),
        ));
    }

    let all_tools = collect_all_mcp_tools(project_id, false).await?;
    if wildcard_enabled {
        // Every sub-agent carries the teammate communication tools by default,
        // even with the wildcard configuration. The main-session management
        // tools (listSubAgents/continue) stay hidden from sub-agents: resuming
        // a finished sub-agent is the parent conversation's privilege.
        let mut result = all_tools;
        result.retain(|tool| !SUB_AGENT_MAIN_TOOL_FULL_NAMES.contains(&tool.full_name().as_str()));
        result.extend(sub_agent_comms_tools());
        return Ok(result);
    }

    // 部分工具不可用（被项目 scope 禁用、默认禁用未启用、条件工具如
    // codebase/imagegen 未就绪、外部 MCP 服务器禁用或连接失败）时，跳过
    // 不可用工具、保留可用工具，而不是整体失败。整体失败会让 provider
    // 层把子代理请求静默降级为无工具（tools=None），模型只能把工具调用
    // 输出为纯文本（表现为"输出奇怪的 tool_call 文本后立即结束"）。
    let available_names = all_tools
        .iter()
        .map(McpTool::full_name)
        .collect::<std::collections::HashSet<_>>();
    let unavailable_names = configured_names
        .difference(&available_names)
        .filter(|name| !SUB_AGENT_COMMS_TOOL_FULL_NAMES.contains(&name.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    if !unavailable_names.is_empty() {
        eprintln!(
            "Sub-agent configured tools are unavailable or disabled for the current project (skipped): {}",
            unavailable_names.join(", ")
        );
    }

    let mut result = all_tools
        .into_iter()
        .filter(|tool| {
            configured_names.contains(&tool.full_name())
                // 主会话专用的子代理管理工具（listSubAgents/continue）不进入
                // 子代理工具集：重新激活已结束的子代理是父会话的职权，
                // 子代理配置中显式写入也会被忽略，避免其误用。
                && !SUB_AGENT_MAIN_TOOL_FULL_NAMES.contains(&tool.full_name().as_str())
        })
        .collect::<Vec<_>>();
    // Teammate communication tools are always available to every sub-agent,
    // regardless of its configured tool whitelist.
    result.extend(sub_agent_comms_tools());
    Ok(result)
}

/// Built-in server ids that are disabled by default and must be explicitly
/// enabled per project. This keeps their tools out of the model context
/// (saving tokens) until the user opts in.
const DEFAULT_DISABLED_SERVER_IDS: &[&str] = &["terminal", "lsp"];

fn tool_is_enabled(
    tool: &McpTool,
    global_scope: Option<&McpGlobalScopeSettings>,
    scope: Option<&McpProjectScopeSettings>,
) -> bool {
    // The global blacklist has the highest priority: a tool disabled
    // globally stays disabled regardless of project scope.
    if global_scope
        .is_some_and(|global| global.disabled_tool_names.contains(&tool.full_name()))
    {
        return false;
    }
    // Default-disabled servers are excluded when there is no project
    // scope (no project context = user hasn't opted in).
    if DEFAULT_DISABLED_SERVER_IDS.contains(&tool.server_id.as_str()) {
        let Some(scope) = scope else {
            return false;
        };
        return scope.is_server_enabled(&builtin_scope_server_id(&tool.server_id))
            && scope.is_tool_enabled(&tool.full_name());
    }

    let Some(scope) = scope else {
        return true;
    };

    scope.is_server_enabled(&builtin_scope_server_id(&tool.server_id))
        && scope.is_tool_enabled(&tool.full_name())
}

pub(crate) fn builtin_scope_server_id(server_id: &str) -> String {
    format!("builtin:{server_id}")
}

pub(crate) fn server_id_from_tool_name(tool_name: &str) -> Option<&str> {
    split_tool_full_name(tool_name).map(|(server_id, _)| server_id)
}

pub(crate) fn builtin_server_name(server_id: &str) -> &str {
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
        "codelens" => "CodeLens",
        "terminal" => "Terminal Control",
        "config" => "Config",
        "imagegen" => "Image Generation",
        "lsp" => "LSP",
        _ => server_id,
    }
}

pub(crate) async fn ensure_project_tool_enabled(
    project_id: Option<&str>,
    tool_name: &str,
) -> Result<()> {
    // 精简模式执行层（与 collect 阶段排除保持一致）：Lite Mode 禁用的
    // browser / app-control / terminal 工具即使出现在陈旧工具列表中也
    // 拒绝执行。app-control-requestApproval 豁免——Plan Mode 审批必须
    // 始终可用，且 call_mcp_tool 已用 plan_mode 前置条件守卫该工具。
    if tool_name != REQUEST_APPROVAL_FULL_NAME {
        let lite_mode =
            with_database_path(|database_path| {
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
                    format!(
                        "MCP server \"{server_id}\" is disabled by Lite mode: {tool_name}"
                    ),
                ));
            }
        }
    }
    let global_scope = load_global_scope().await?;
    if global_scope.is_some_and(|scope| scope.disabled_tool_names.contains(tool_name)) {
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
    let scope = load_project_scope(project_id).await?;
    // 默认关闭的内置服务器（terminal/lsp）：必须在项目 scope 中显式启用
    // 才可调用。无项目 scope（无项目上下文）= 用户从未启用，直接拒绝——
    // 与 collect 阶段 tool_is_enabled 的无 scope 判定保持一致，防止绕过
    // 工具列表的调用仍被执行。
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
        return Ok(());
    };
    let (server_scope_id, project_owned) = if server_id == "skills"
        || get_builtin_servers_with_tools()
            .iter()
            .any(|(builtin_server_id, _)| builtin_server_id == server_id)
    {
        (builtin_scope_server_id(server_id), false)
    } else {
        let resolved_server = super::super::external::resolve_project_scope_server(project_id, tool_name)
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

pub(crate) async fn load_project_scope(project_id: Option<&str>) -> Result<Option<McpProjectScopeSettings>> {
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
pub(crate) async fn load_global_scope() -> Result<Option<McpGlobalScopeSettings>> {
    with_database_path(move |database_path| {
        crate::storage::services::system_settings::get_mcp_global_scope_settings(&database_path)
            .map(Some)
    })
    .await
}

pub(crate) async fn with_database_path<T, F>(operation: F) -> Result<T>
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
