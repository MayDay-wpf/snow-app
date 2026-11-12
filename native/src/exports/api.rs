use serde_json::Value;
use std::path::PathBuf;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use tokio_util::sync::CancellationToken;

use crate::api::config::get_api_config_custom_headers;
use crate::api::conversation::create_response_stream as create_conversation_response_stream;
use crate::api::file_search_agent::{
    run_file_search_agent as run_agent, FileSearchAgentProgressCallback,
};
use crate::api::models::{
    fetch_available_models as fetch_models_with_config, fetch_available_models_for_active_config,
    fetch_plugin_models, resolve_saved_oauth_profile, ApiConfigForModels, Model,
};
use crate::api::request_proxy::{self, ProxySession, RequestProxyCallback};
use crate::api::responses::{ResponsesApiRequest, ResponsesApiResult, ResponsesApiStreamCallback};
use crate::api::summary::generate_conversation_summary as generate_summary;
use crate::api::theme_palette::generate_theme_palette_stream;
use crate::api::tool_correction::{
    correct_tool_call as correct_tool_call_impl, ToolCorrectionRequest, ToolCorrectionResponse,
};
use crate::mcp::servers::app_control::AppControlCallback;
use crate::mcp::servers::bash::{
    write_interactive_stdin as write_interactive_stdin_impl, BashStreamCallback,
};
use crate::mcp::servers::browser::BrowserCommandCallback;
use crate::mcp::servers::remote_workspace::RemoteWorkspaceCallback;
use crate::mcp::servers::skills::{ProjectSkillDefinition, SkillDefinition, SkillsService};
use crate::mcp::servers::terminal::TerminalCommandCallback;
use crate::mcp::servers::user_interaction::UserQuestionCallback;
use crate::mcp::servers::websearch::WebSearchCommandCallback;
use crate::mcp::servers::workflow::validate_graph as validate_workflow_graph_impl;
use crate::mcp::tools::{
    call_mcp_tool as call_tool, diagnose_sub_agent_tools as diagnose_sub_agent_tools_impl,
    list_mcp_global_servers as list_global_servers,
    list_mcp_global_builtin_servers as list_global_builtin_servers,
    list_mcp_project_server_tools as list_project_server_tools,
    list_mcp_project_servers as list_project_servers,
    list_mcp_project_servers_cached as list_cached_project_servers,
    list_mcp_server_tools as list_server_tools, list_mcp_tools as list_all_mcp_tools,
    set_mcp_project_server_enabled as set_project_server_enabled,
    set_mcp_project_tool_enabled as set_project_tool_enabled,
    set_mcp_project_tools_enabled as set_project_tools_enabled,
    set_mcp_tool_enabled as set_tool_enabled,
    set_mcp_global_server_enabled as set_global_server_enabled,
    set_mcp_tools_enabled as set_tools_enabled, McpProjectServerStatus, McpProjectToolStatus,
    McpToolDefinition, McpToolStatus, SubAgentUnavailableTool,
};
use crate::mcp::tools::sensitive_guard::{authorize_sensitive_operation, check_tool_call};
use crate::storage::initialize_app_storage;
use crate::storage::services::fs_explorer::FileSearchResult;
use crate::storage::{SensitiveCommandDecisionRecord, SensitiveOperationCheckRecord};

#[napi]
pub async fn fetch_available_models() -> napi::Result<Vec<Model>> {
    // 使用 spawn_blocking 确保 HTTP 请求和 SQLite I/O 不阻塞 Node.js 主线程
    tokio::task::spawn_blocking(move || fetch_available_models_for_active_config())
        .await
        .map_err(|e| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to execute fetch_available_models: {}", e),
            )
        })?
}

#[napi]
pub async fn fetch_available_models_for_config(
    config: ApiConfigForModels,
) -> napi::Result<Vec<Model>> {
    // 已保存的 OAuth 档案以库内最新 token 为准（必要时先刷新），不信任渲染层快照
    let config = resolve_saved_oauth_profile(config).await?;
    // 插件档案优先使用插件的 models 钩子
    if let Some(models) = fetch_plugin_models(&config).await? {
        return Ok(models);
    }
    // 使用 spawn_blocking 确保 HTTP 请求和 SQLite I/O 不阻塞 Node.js 主线程
    tokio::task::spawn_blocking(move || {
        let storage_info = initialize_app_storage()?;
        let database_path = PathBuf::from(storage_info.database_path);
        let custom_header_schemes =
            crate::storage::services::custom_header_schemes::list_custom_header_schemes(
                &database_path,
            )?;
        let custom_headers =
            get_api_config_custom_headers(&custom_header_schemes, &config.custom_header_scheme_id);

        fetch_models_with_config(&config, &custom_headers)
    })
    .await
    .map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to execute fetch_available_models_for_config: {}", e),
        )
    })?
}

#[napi(
    ts_args_type = "request: ResponsesApiRequest, onChunk: (chunk: ResponsesApiStreamChunk) => void, streamId: string",
    ts_return_type = "Promise<ResponsesApiResult>"
)]
pub async fn create_response_stream(
    request: ResponsesApiRequest,
    on_chunk: ResponsesApiStreamCallback,
    stream_id: String,
) -> napi::Result<ResponsesApiResult> {
    let proxy_session = ProxySession::new(stream_id.clone(), request.conversation_id.clone());
    // 响应侧插件钩子的上下文写入 task-local 会话，需在对话流外层绑定。
    let request_id = stream_id.clone();
    let stream = crate::mcp::servers::tool_search::with_model_request(
        request_id.clone(),
        crate::api::oauth::plugin::response::with_session(request_proxy::with_session(
            proxy_session,
            create_conversation_response_stream(request, on_chunk, stream_id),
        )),
    );
    let result = crate::utils::panic_guard::guard_panic(stream).await;
    crate::mcp::servers::tool_search::finish_model_request(&request_id, result.as_ref().ok())?;
    result
}

#[napi]
pub fn release_model_request(stream_id: String) -> napi::Result<()> {
    crate::mcp::servers::tool_search::release_model_request(&stream_id)
}

#[napi]
pub fn abort_response_stream(stream_id: String) -> napi::Result<bool> {
    Ok(crate::api::cancel::cancel_stream(&stream_id))
}

/// Repair the arguments of a failed tool call with the active profile's basic
/// model. The renderer controls the retry limit and re-executes the call.
#[napi(ts_args_type = "request: ToolCorrectionRequest")]
pub async fn correct_tool_call(
    request: ToolCorrectionRequest,
) -> napi::Result<ToolCorrectionResponse> {
    crate::utils::panic_guard::guard_panic(correct_tool_call_impl(request)).await
}

/// 注册（或清除）对话请求代理回调。主进程初始化时调用一次：请求体发出前与
/// SSE 响应事件送达前，Rust 通过该回调把数据交给用户可编辑的代理脚本处理。
#[napi]
pub fn set_request_proxy_handler(handler: Option<RequestProxyCallback>) {
    request_proxy::set_handler(handler);
}

/// 告知 Rust 当前是否存在可用的代理脚本。脚本不存在时请求阶段直接放行，
/// 省掉一次全量请求体序列化与主进程 JSON 解析。
#[napi]
pub fn set_request_proxy_enabled(enabled: bool) {
    request_proxy::set_enabled(enabled);
}

/// Abort an in-flight tool execution (e.g. a bash subprocess) by the
/// execution id that was streamed to the frontend as a `tool_execution`
/// chunk.  The executing service races its wait against this cancellation
/// and kills the process tree.  `reason` records why the abort happened
/// ("user" stop button / session abort, "timeout" renderer countdown
/// watchdog, or "shutdown") so the executor can report the real
/// termination reason; unknown values fall back to "user".
/// Returns `true` if a running execution was found and cancelled.
#[napi(ts_args_type = "toolExecutionId: string, reason?: string")]
pub fn abort_tool_execution(
    tool_execution_id: String,
    reason: Option<String>,
) -> napi::Result<bool> {
    let trimmed = tool_execution_id.trim();
    if trimmed.is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            "Tool execution ID is required".to_string(),
        ));
    }
    let normalized_reason = match reason.as_deref() {
        Some("timeout") => "timeout",
        Some("shutdown") => "shutdown",
        _ => "user",
    };
    Ok(crate::api::cancel::cancel_tool_execution_with_reason(
        trimmed,
        normalized_reason,
    ))
}

/// Generate a theme palette JSON from a background image using the selected
/// API config's **advanced model** (must support vision). Dispatches to
/// whichever provider (chat / responses / anthropic / gemini) the config
/// specifies.
///
/// - `imagePath`: absolute path to the background image file
/// - `profileName`: API config profile name. Empty string means "use the
///   active profile".
/// - `onChunk`: streaming callback receiving `ResponsesApiStreamChunk`
/// - `streamId`: unique stream id for cancellation support
///
/// Returns the full `ResponsesApiResult` (`.content` holds the JSON palette).
#[napi(
    ts_args_type = "imagePath: string, profileName: string, onChunk: (chunk: ResponsesApiStreamChunk) => void, streamId: string",
    ts_return_type = "Promise<ResponsesApiResult>"
)]
pub async fn generate_theme_palette(
    image_path: String,
    profile_name: String,
    on_chunk: ResponsesApiStreamCallback,
    stream_id: String,
) -> napi::Result<ResponsesApiResult> {
    // 1. Register cancellation token
    let cancel_token = crate::api::cancel::create_and_register(&stream_id);

    // 2. Stream theme palette generation
    let result =
        generate_theme_palette_stream(image_path, profile_name, on_chunk, cancel_token).await;

    // 3. Unregister stream
    crate::api::cancel::unregister_stream(&stream_id);

    result
}

/// Generate a conversation summary (title) for the given conversation id.
///
/// Registers a cancellation token so the in-flight non-streaming HTTP
/// request can be aborted via `cancel_conversation_summary`. When cancelled,
/// the summary returns an empty string WITHOUT writing to the database,
/// releasing the SQLite lock for a subsequent delete/truncate.
#[napi(
    ts_args_type = "conversationId: string, basicModel?: string",
    ts_return_type = "Promise<string>"
)]
pub async fn generate_conversation_summary(
    conversation_id: String,
    basic_model: Option<String>,
) -> napi::Result<String> {
    let token = CancellationToken::new();
    crate::api::cancel::register_summary(&conversation_id, token.clone());
    let result = generate_summary(conversation_id.clone(), basic_model, token).await;
    crate::api::cancel::unregister_summary(&conversation_id);
    result
}

/// Cancel an in-flight conversation summary generation.
///
/// Returns `true` if a summary was found and cancelled, `false` otherwise.
/// Call this from `handleAbort` / `handleRollback` so the summary's
/// `update_conversation_summary` write transaction is skipped before the
/// delete/truncate runs, avoiding a "database is locked" race.
#[napi]
pub fn cancel_conversation_summary(conversation_id: String) -> napi::Result<bool> {
    Ok(crate::api::cancel::cancel_summary(&conversation_id))
}

/// Run a natural-language file search agent over a workspace.
///
/// The agent drives the configured basic model with the read-only MCP tools
/// (`grep-search`, `filesystem-read`) in a loop of at most 10 tool-call
/// rounds, then returns the matching files as `FileSearchResult` entries.
/// Request scheme follows the active API config (chat / responses /
/// anthropic / gemini). `onProgress` is invoked after every tool execution
/// so the UI can display the search process. Pass `linked=false` to keep the
/// search inside the given workspace path only (e.g. an explicitly scoped
/// project member), instead of covering the whole linked project group.
#[napi(
    ts_args_type = "query: string, workspacePath: string, onProgress: ((chunk: FileSearchAgentProgress) => void) | undefined, linked: boolean | undefined"
)]
pub async fn search_files_by_agent(
    query: String,
    workspace_path: String,
    on_progress: Option<FileSearchAgentProgressCallback>,
    linked: Option<bool>,
) -> napi::Result<Vec<FileSearchResult>> {
    // linked=false（`@:项目/` 显式限定某个成员）时只搜索给定工作区，不并入关联项目。
    let linked_roots = if linked.unwrap_or(true) {
        resolve_linked_roots_for_file_search(&workspace_path).await
    } else {
        Vec::new()
    };
    let token = CancellationToken::new();
    let agent = run_agent(query, workspace_path, linked_roots, token, on_progress);
    crate::utils::panic_guard::guard_panic(agent).await
}

/// 解析工作区路径所属关联项目组（合集）的成员根目录：文件搜索 agent 把这些
/// 兄弟根与主工作区同等对待，一次搜索覆盖关联起来的全部项目。
/// 远端（SSH）路径与未关联项目返回空列表；查询失败静默退化为单根搜索。
async fn resolve_linked_roots_for_file_search(
    workspace_path: &str,
) -> Vec<crate::storage::LinkedProjectRoot> {
    let path = workspace_path.trim().to_string();
    if path.is_empty() || crate::mcp::servers::remote_workspace::is_ssh_path(&path) {
        return Vec::new();
    }
    tokio::task::spawn_blocking(move || {
        crate::storage::resolve_linked_project_roots_for_path(path)
    })
    .await
    .ok()
    .and_then(Result::ok)
    .unwrap_or_default()
}

#[napi]
pub async fn list_mcp_tools() -> napi::Result<Vec<McpToolDefinition>> {
    list_all_mcp_tools().await
}

#[napi]
pub async fn list_available_skills(
    project_id: Option<String>,
) -> napi::Result<Vec<SkillDefinition>> {
    SkillsService::new()
        .list_available(project_id.as_deref())
        .await
}

#[napi]
pub async fn set_skill_enabled(
    project_id: Option<String>,
    skill_id: String,
    enabled: bool,
) -> napi::Result<()> {
    SkillsService::new()
        .set_enabled(project_id.as_deref(), &skill_id, enabled)
        .await
}

#[napi]
pub async fn list_project_skills(project_id: String) -> napi::Result<Vec<ProjectSkillDefinition>> {
    SkillsService::new().list_project(&project_id).await
}

#[napi]
pub async fn set_project_skill_enabled(
    project_id: String,
    skill_id: String,
    enabled: bool,
) -> napi::Result<()> {
    SkillsService::new()
        .set_project_enabled(&project_id, &skill_id, enabled)
        .await
}

#[napi]
pub async fn list_mcp_server_tools(
    config_server_id: String,
) -> napi::Result<Vec<McpToolStatus>> {
    list_server_tools(config_server_id).await
}

/// 自定义 API MCP：按草稿配置发送一次测试请求（无需先保存）。
#[napi]
pub async fn test_mcp_api_endpoint(
    input: crate::mcp::external::api::McpApiTestInput,
) -> napi::Result<crate::mcp::external::api::McpApiTestResult> {
    crate::mcp::external::api::test_api_endpoint(input).await
}

#[napi]
pub async fn list_mcp_project_servers(
    project_id: String,
) -> napi::Result<Vec<McpProjectServerStatus>> {
    list_project_servers(project_id).await
}

/// 全局 MCP 服务器目录（不依赖项目）：全局子代理选择工具使用，只叠加全局层开关。
#[napi]
pub async fn list_mcp_global_servers() -> napi::Result<Vec<McpProjectServerStatus>> {
    list_global_servers().await
}

/// 全局内置 MCP 服务器目录（不连接外部服务器），供 MCP 设置全局内置页使用。
#[napi]
pub async fn list_mcp_global_builtin_servers() -> napi::Result<Vec<McpProjectServerStatus>> {
    list_global_builtin_servers().await
}

/// 诊断子代理白名单中当前不可用的工具及原因（子代理激活时调用）。
#[napi]
pub async fn diagnose_sub_agent_tools(
    project_id: Option<String>,
    tools_json: String,
) -> napi::Result<Vec<SubAgentUnavailableTool>> {
    diagnose_sub_agent_tools_impl(project_id, tools_json).await
}

/// 项目 MCP 服务器快速列表：外部服务器工具只读进程内缓存（不连接服务器），
/// 未命中的服务器以 `toolsPending` 标记，交给前端后台补发现。保存 / 启停 /
/// 删除配置后的列表刷新使用它，避免被慢服务器的 connect + tools/list 阻塞。
#[napi]
pub async fn list_mcp_project_servers_cached(
    project_id: String,
) -> napi::Result<Vec<McpProjectServerStatus>> {
    list_cached_project_servers(project_id).await
}

/// 返回仍注册在案的只读内置工具全名（UI 权限面板默认授权用）。
#[napi]
pub fn list_readonly_tools() -> Vec<String> {
    crate::mcp::builtin::list_readonly_tools()
}

/// 统一工具（单工具 + action）里真正只读的 action 列表：
/// 前端据此判定免审批、并行与缓存，避免在 TS 里再维护一份名单。
/// 以 JSON 字符串返回（napi 不支持直接导出 serde_json::Value）。
#[napi]
pub fn list_tool_readonly_actions() -> String {
    crate::mcp::builtin::tool_readonly_actions().to_string()
}

#[napi]
pub async fn list_mcp_project_server_tools(
    project_id: String,
    server_id: String,
) -> napi::Result<Vec<McpProjectToolStatus>> {
    list_project_server_tools(project_id, server_id).await
}

#[napi]
pub async fn set_mcp_project_server_enabled(
    project_id: String,
    server_id: String,
    enabled: bool,
) -> napi::Result<()> {
    set_project_server_enabled(project_id, server_id, enabled).await
}

#[napi]
pub async fn set_mcp_project_tool_enabled(
    project_id: String,
    tool_name: String,
    enabled: bool,
) -> napi::Result<()> {
    set_project_tool_enabled(project_id, tool_name, enabled).await
}

#[napi]
pub async fn set_mcp_tool_enabled(tool_name: String, enabled: bool) -> napi::Result<()> {
    set_tool_enabled(tool_name, enabled).await
}

/// 全局启停内置 MCP 服务器（总闸，项目层无法覆盖）。
#[napi]
pub async fn set_mcp_global_server_enabled(server_id: String, enabled: bool) -> napi::Result<()> {
    set_global_server_enabled(server_id, enabled).await
}

#[napi]
pub async fn set_mcp_tools_enabled(tool_names: Vec<String>, enabled: bool) -> napi::Result<()> {
    set_tools_enabled(tool_names, enabled).await
}

#[napi]
pub async fn set_mcp_project_tools_enabled(
    project_id: String,
    tool_names: Vec<String>,
    enabled: bool,
) -> napi::Result<()> {
    set_project_tools_enabled(project_id, tool_names, enabled).await
}

/// 登记一次性授权令牌（用户确认或决策模型托管放行后由主进程调用），令牌绑定
/// `check_tool_sensitive_operation` 返回的操作主体文本。
#[napi]
pub async fn authorize_sensitive_command(subject: String, token: String) -> napi::Result<()> {
    authorize_sensitive_operation(subject, token).await
}

/// 工具调用授权前的敏感操作预检查：命令、终端输入、键入文本与会被执行的配置
/// 写入命中规则（或修改敏感规则本身、检查出错）时返回主体与命中项，否则 null。
#[napi]
pub async fn check_tool_sensitive_operation(
    tool_name: String,
    args_json: String,
    project_id: Option<String>,
) -> napi::Result<Option<SensitiveOperationCheckRecord>> {
    Ok(check_tool_call(tool_name, args_json, project_id).await)
}

/// Evaluate a command that matched a sensitive rule with the configured decision
/// model (TypeSafe System One or OpenAI Decisions).
///
/// The verdict is a risk judgement of the command's real effect in
/// `workingDirectory` (with the model's own `description` as context) — a rule
/// match alone never decides it. Returns `None` when the assist is disabled or
/// the command matches no rule. When the assist is on but the decision model
/// cannot judge (none selected and no default, disabled, incomplete, or the
/// request failed) a
/// record with `error` set is returned: the caller falls back to the plain
/// confirmation prompt and tells the user why. Request failures are also in the
/// system log (module `decision_model`).
///
/// `conversation_context` is an optional JSON array of recent messages already
/// trimmed by the renderer; it is used only when the assist's
/// `useConversationContext` switch is on. A malformed array returns an error
/// record (manual confirmation), never a silent context-free verdict.
///
/// `matched_rules` is the JSON array of matches the caller's pre-check already
/// verified (`SensitiveOperationCheckRecord.matches`). It covers matches the
/// command text alone cannot reproduce — indirect script content and the
/// built-in diagnostics — and is used verbatim when present. Only when the
/// caller passes nothing does the command text get matched again, so the two
/// sides can never disagree about whether the assist should run.
#[napi]
pub async fn evaluate_sensitive_command_decision(
    command: String,
    project_id: Option<String>,
    working_directory: Option<String>,
    description: Option<String>,
    conversation_context: Option<String>,
    matched_rules: Option<String>,
) -> napi::Result<Option<SensitiveCommandDecisionRecord>> {
    // 原文参与匹配与判定：调用方的命中高亮、规则锚点都基于未裁剪的文本。
    if command.trim().is_empty() {
        return Ok(None);
    }

    let working_directory = working_directory.unwrap_or_default().trim().to_string();
    let description = description.unwrap_or_default().trim().to_string();
    // 敏感命令判定不属于任何会话；项目归属照常用量记录。
    let usage_directory_id = project_id
        .as_deref()
        .map(str::trim)
        .unwrap_or_default()
        .to_string();

    let database_path = PathBuf::from(initialize_app_storage()?.database_path);

    // 设置、规则表与决策模型配置都是同步 SQLite 读取，放入阻塞线程执行，
    // 避免阻塞 Node.js 主线程。
    let (assist, matched_rules, decision_models, default_decision_model_id) = {
        let db_path = database_path.clone();
        let candidate = command.clone();
        let caller_matches = matched_rules;
        tokio::task::spawn_blocking(move || {
            let assist =
                crate::storage::services::system_settings::get_sensitive_command_assist(&db_path)?;
            // 调用方预检查的命中项优先：命中可能来自间接执行的脚本内容或内置诊断，
            // 只用命令文本重算会把这些命中当成「未命中」而静默跳过判定。
            let matched_rules = match caller_matches {
                Some(raw) if !raw.trim().is_empty() => parse_caller_matched_rules(&raw)?,
                _ => crate::storage::check_sensitive_command_match(
                    vec![(candidate, None)],
                    project_id,
                )?,
            };
            let decision_models = crate::api::decision_model::load_decision_models(&db_path);
            let default_decision_model_id =
                crate::api::decision_model::load_decision_tool_model_id(&db_path);
            Ok::<_, Error>((
                assist,
                matched_rules,
                decision_models,
                default_decision_model_id,
            ))
        })
        .await
        .map_err(|e| {
            Error::from_reason(format!(
                "Failed to load sensitive command decision context: {e}"
            ))
        })?
    }?;

    // 未开启辅助或未命中规则时，保持原有确认流程。
    if !assist.enabled || matched_rules.is_empty() {
        return Ok(None);
    }

    // 命中项缺少可核验内容（脚本不可读、规则检查失败、脚本片段缺失）：
    // 判定只能作为建议，不允许托管放行，必须由用户确认（fail-closed）。
    let evidence_incomplete = matched_rules.iter().any(|rule| {
        rule.pattern.trim().is_empty()
            || (rule.source_path.is_some() && rule.source_excerpt.is_none())
    });
    let delegate = assist.delegate && !evidence_incomplete;
    // 拒绝转人工只在托管下有意义：合并后下发，渲染层无需二次读取设置。
    let ask_on_deny = delegate && assist.ask_on_deny;
    let context_enabled = assist.use_conversation_context;

    let unavailable = |model_name: String, error: String| SensitiveCommandDecisionRecord {
        allow: false,
        reason: "unclear".to_string(),
        confidence: 0.0,
        severity: None,
        severity_score: None,
        delegate,
        ask_on_deny,
        model_name,
        context_enabled,
        context_messages: 0,
        context_truncated: false,
        context_empty: false,
        preference_records: 0,
        error: Some(error),
    };

    // 未选择模型时跟随「API 配置 → 决策模型」中的默认模型（decision-evaluate 的默认模型）。
    let follow_default = assist.model_id.trim().is_empty();
    let selected_model_id = if follow_default {
        default_decision_model_id
    } else {
        assist.model_id.clone()
    };

    let (model_name, config) = match crate::api::decision_model::resolve_decision_model(
        &decision_models,
        &selected_model_id,
    ) {
        crate::api::decision_model::DecisionModelResolution::Ready { name, config } => {
            (name, config)
        }
        crate::api::decision_model::DecisionModelResolution::Unavailable { name, reason } => {
            let reason = if follow_default {
                format!("The default decision model is unavailable: {reason}")
            } else {
                reason
            };
            return Ok(Some(unavailable(name, reason)));
        }
        crate::api::decision_model::DecisionModelResolution::NotSelected => {
            let reason = if follow_default {
                "No default decision model is set for the sensitive command assist"
            } else {
                "No decision model is selected for the sensitive command assist"
            };
            return Ok(Some(unavailable(String::new(), reason.to_string())));
        }
    };

    // 开关关闭时完全忽略调用方传入的上下文，请求体与无上下文版本一致。
    let conversation = if context_enabled {
        let raw = conversation_context.unwrap_or_default();
        let parsed = if raw.trim().is_empty() {
            Ok(Vec::new())
        } else {
            crate::api::decision_model::parse_conversation_context(&raw)
        };
        match parsed {
            Ok(mut messages) => {
                // 只保留配置条数内的最新消息（渲染层按上限传入）。
                let keep = crate::api::decision_model::resolve_context_message_count(
                    assist.context_message_count,
                );
                if messages.len() > keep {
                    messages.drain(..messages.len() - keep);
                }
                match mask_conversation_tool_outputs(messages).await {
                    Ok(messages) => Some(messages),
                    Err(error) => return Ok(Some(unavailable(model_name, error))),
                }
            }
            Err(error) => return Ok(Some(unavailable(model_name, error))),
        }
    } else {
        None
    };

    // 偏好学习：建议与托管两种模式都附带与本命令相似的历史选择。读取失败只少了
    // 参考依据（判定更保守），记 WARN 后照常判定。
    let preferences = if assist.learn_preferences {
        let db_path = database_path.clone();
        let candidate = command.clone();
        let rule_ids: Vec<String> = matched_rules
            .iter()
            .map(|rule| rule.command_id.clone())
            .collect();
        let project = usage_directory_id.clone();
        let loaded = tokio::task::spawn_blocking(move || {
            crate::storage::services::sensitive_command_feedback::find_relevant_preferences(
                &db_path, &candidate, &rule_ids, &project,
            )
            .map_err(|error| error.reason.clone())
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result);
        match loaded {
            Ok(items) => Some(items),
            Err(error) => {
                crate::storage::services::app_logs::log_api_warning(
                    &database_path,
                    "evaluate_sensitive_command_decision",
                    "Failed to load learned sensitive command preferences; judging without them",
                    &error,
                )
                .await;
                None
            }
        }
    } else {
        None
    };

    let verdict = crate::api::decision_model::evaluate_command(
        &config,
        &crate::api::decision_model::DecisionUsageScope {
            model_name: model_name.clone(),
            conversation_id: String::new(),
            directory_id: usage_directory_id,
        },
        &crate::api::decision_model::CommandContext {
            command: &command,
            description: &description,
            working_directory: &working_directory,
            matched_rules: &matched_rules,
            conversation: conversation.as_deref(),
            preferences: preferences.as_deref(),
        },
    )
    .await;

    Ok(Some(match verdict {
        Ok(verdict) => {
            let usage = verdict.context.unwrap_or_default();
            SensitiveCommandDecisionRecord {
                allow: verdict.allow,
                reason: verdict.reason,
                confidence: verdict.confidence,
                severity: verdict.severity,
                severity_score: verdict.severity_score,
                delegate,
                ask_on_deny,
                model_name,
                context_enabled,
                context_messages: u32::try_from(usage.messages).unwrap_or(u32::MAX),
                context_truncated: usage.truncated,
                context_empty: usage.empty,
                preference_records: u32::try_from(verdict.preference_examples)
                    .unwrap_or(u32::MAX),
                error: None,
            }
        }
        Err(error) => unavailable(model_name, error.reason.clone()),
    }))
}

/// 偏好学习：记录用户在敏感命令拦截提示中的一次选择（JSON）。
/// 开关以 Rust 读取的设置为准，未开启时直接忽略并返回 false。
#[napi]
pub async fn record_sensitive_command_feedback(feedback: String) -> napi::Result<bool> {
    let database_path = PathBuf::from(initialize_app_storage()?.database_path);
    tokio::task::spawn_blocking(move || -> napi::Result<bool> {
        let assist =
            crate::storage::services::system_settings::get_sensitive_command_assist(&database_path)?;
        if !assist.enabled || !assist.learn_preferences {
            return Ok(false);
        }
        let input =
            crate::storage::services::sensitive_command_feedback::parse_feedback_input(&feedback)?;
        crate::storage::services::sensitive_command_feedback::insert_feedback(
            &database_path,
            &input,
        )?;
        Ok(true)
    })
    .await
    .map_err(|e| Error::from_reason(format!("Failed to record sensitive command feedback: {e}")))?
}

/// 偏好学习：已记录的用户选择条数。
#[napi]
pub async fn get_sensitive_command_feedback_count() -> napi::Result<u32> {
    let database_path = PathBuf::from(initialize_app_storage()?.database_path);
    tokio::task::spawn_blocking(move || {
        crate::storage::services::sensitive_command_feedback::count_feedback(&database_path)
    })
    .await
    .map_err(|e| Error::from_reason(format!("Failed to count sensitive command feedback: {e}")))?
}

/// 偏好学习：清空全部记录，返回删除条数。
#[napi]
pub async fn clear_sensitive_command_feedback() -> napi::Result<u32> {
    let database_path = PathBuf::from(initialize_app_storage()?.database_path);
    tokio::task::spawn_blocking(move || {
        crate::storage::services::sensitive_command_feedback::clear_feedback(&database_path)
    })
    .await
    .map_err(|e| Error::from_reason(format!("Failed to clear sensitive command feedback: {e}")))?
}

/// 解析调用方预检查给出的命中项（`SensitiveOperationCheckRecord.matches` 的 JSON）。
///
/// 结构非法按错误处理：调用方回退人工确认，绝不静默当成「未命中」。
fn parse_caller_matched_rules(
    raw: &str,
) -> Result<Vec<crate::storage::SensitiveCommandMatchResult>> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct CallerMatch {
        #[serde(default)]
        command_id: String,
        #[serde(default)]
        pattern: String,
        #[serde(default)]
        description: String,
        #[serde(default)]
        source_path: Option<String>,
        #[serde(default)]
        source_excerpt: Option<String>,
    }

    let items: Vec<CallerMatch> = serde_json::from_str(raw)
        .map_err(|error| Error::from_reason(format!("Invalid matched rules: {error}")))?;

    Ok(items
        .into_iter()
        .map(|item| crate::storage::SensitiveCommandMatchResult {
            command_id: item.command_id,
            pattern: item.pattern,
            description: item.description,
            // 高亮区间只用于拦截提示，判定请求只带规则与说明。
            ranges: Vec::new(),
            source_path: item.source_path,
            // 脚本命中片段是判定证据，必须原样带给模型。
            source_excerpt: item.source_excerpt,
        })
        .collect())
}

/// 工具输出沿用现有隐私过滤链路（按工具名套用隐私设置）后再发给决策模型。
async fn mask_conversation_tool_outputs(
    mut messages: Vec<crate::api::decision_model::ConversationMessage>,
) -> std::result::Result<Vec<crate::api::decision_model::ConversationMessage>, String> {
    let masked = futures::future::join_all(messages.iter().flat_map(|message| {
        message.tool_calls.iter().map(|call| async move {
            match call.output.as_deref() {
                Some(output) => crate::mcp::privacy_mask::mask_tool_result_if_needed(
                    &call.name, output,
                )
                .await
                .map(Some),
                None => Ok(None),
            }
        })
    }))
    .await;

    let mut masked = masked.into_iter();
    for message in &mut messages {
        for call in &mut message.tool_calls {
            if let Some(result) = masked.next() {
                call.output = result.map_err(|error| {
                    format!("Failed to apply privacy filtering to the conversation context: {error}")
                })?;
            }
        }
    }
    Ok(messages)
}

#[napi]
pub async fn write_interactive_stdin(session_id: String, input: String) -> napi::Result<()> {
    write_interactive_stdin_impl(session_id, input).await
}

#[napi(
    ts_args_type = "toolFullName: string, argsJson: string, projectId: string | undefined, checkpointIds: string[] | undefined, checkpointWorkDir: string | undefined, sensitiveAuthorizationToken: string | undefined, onChunk: (chunk: BashStreamChunk) => void, onBrowserCommand: (command: BrowserCommand) => Promise<string>, onWebSearchCommand: (command: WebSearchCommand) => Promise<string>, onUserQuestion: (question: UserQuestionCommand) => Promise<string>, onAppControl: (command: AppControlCommand) => Promise<string>, onRemoteWorkspaceCommand: (command: RemoteWorkspaceCommand) => Promise<string>, onTerminalCommand: (command: TerminalCommand) => Promise<string>, subAgentAllowedTools: string[] | undefined, conversationId: string | undefined, modelRequestId?: string",
    ts_return_type = "Promise<string>"
)]
pub async fn call_mcp_tool(
    tool_full_name: String,
    args_json: String,
    project_id: Option<String>,
    checkpoint_ids: Option<Vec<String>>,
    checkpoint_work_dir: Option<String>,
    sensitive_authorization_token: Option<String>,
    on_chunk: BashStreamCallback,
    on_browser_command: BrowserCommandCallback,
    on_websearch_command: WebSearchCommandCallback,
    on_user_question: UserQuestionCallback,
    on_app_control: AppControlCallback,
    on_remote_workspace_command: RemoteWorkspaceCallback,
    on_terminal_command: TerminalCommandCallback,
    sub_agent_allowed_tools: Option<Vec<String>>,
    conversation_id: Option<String>,
    model_request_id: Option<String>,
) -> napi::Result<String> {
    let cancellable =
        crate::mcp::tools::begin_external_tool_execution(&tool_full_name, &on_chunk);
    let execution = call_tool(
        tool_full_name,
        args_json,
        project_id,
        checkpoint_ids.unwrap_or_default(),
        checkpoint_work_dir,
        sensitive_authorization_token,
        on_chunk,
        on_browser_command,
        on_websearch_command,
        on_user_question,
        on_app_control,
        on_remote_workspace_command,
        on_terminal_command,
        sub_agent_allowed_tools,
        conversation_id,
        model_request_id,
    );
    let Some((tool_execution_id, cancel_token)) = cancellable else {
        return crate::utils::panic_guard::guard_panic(execution).await;
    };
    // 停止按钮取消时丢弃整条调用链（连接、子进程或 HTTP 请求随之释放）。
    let outcome = tokio::select! {
        result = crate::utils::panic_guard::guard_panic(execution) => result,
        _ = cancel_token.cancelled() => Err(Error::new(
            Status::GenericFailure,
            "Tool execution was aborted".to_string(),
        )),
    };
    crate::api::cancel::unregister_tool_execution(&tool_execution_id);
    outcome
}

#[napi(object)]
pub struct WorkflowGraphValidationResult {
    /// Topological execution order of node ids (Kahn's algorithm).
    pub order: Vec<String>,
    /// Structural validation problems; empty when the graph is valid.
    pub errors: Vec<String>,
}

/// Validate a WorkFlow graph and compute its topological execution order in
/// Rust — the single source of truth for topology. The renderer runner calls
/// this instead of re-implementing Kahn's algorithm / cycle detection, so the
/// executed order always matches the MCP tool's own validation.
#[napi]
pub async fn validate_workflow_graph(
    nodes_json: String,
    edges_json: String,
) -> napi::Result<WorkflowGraphValidationResult> {
    tokio::task::spawn_blocking(move || {
        let nodes: Vec<Value> = serde_json::from_str(&nodes_json).unwrap_or_default();
        let edges: Vec<Value> = serde_json::from_str(&edges_json).unwrap_or_default();
        let (order, errors) = validate_workflow_graph_impl(&nodes, &edges);
        Ok(WorkflowGraphValidationResult { order, errors })
    })
    .await
    .map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to execute validate_workflow_graph: {e}"),
        )
    })?
}
