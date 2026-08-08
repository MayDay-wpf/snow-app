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
    ApiConfigForModels, Model,
};
use crate::api::responses::{ResponsesApiRequest, ResponsesApiResult, ResponsesApiStreamCallback};
use crate::api::summary::generate_conversation_summary as generate_summary;
use crate::api::theme_palette::generate_theme_palette_stream;
use crate::mcp::servers::app_control::AppControlCallback;
use crate::mcp::servers::bash::{
    authorize_sensitive_command as authorize_command,
    write_interactive_stdin as write_interactive_stdin_impl, BashStreamCallback,
};
use crate::mcp::servers::browser::BrowserCommandCallback;
use crate::mcp::servers::remote_workspace::RemoteWorkspaceCallback;
use crate::mcp::servers::skills::{ProjectSkillDefinition, SkillDefinition, SkillsService};
use crate::mcp::servers::terminal::TerminalCommandCallback;
use crate::mcp::servers::user_interaction::UserQuestionCallback;
use crate::mcp::tools::{
    call_mcp_tool as call_tool, list_mcp_project_server_tools as list_project_server_tools,
    list_mcp_project_servers as list_project_servers, list_mcp_server_tools as list_server_tools,
    list_mcp_tools as list_all_mcp_tools,
    set_mcp_project_server_enabled as set_project_server_enabled,
    set_mcp_project_tool_enabled as set_project_tool_enabled, McpProjectServerStatus,
    McpProjectToolStatus, McpToolDefinition,
};
use crate::storage::initialize_app_storage;
use crate::storage::services::fs_explorer::FileSearchResult;

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
    create_conversation_response_stream(request, on_chunk, stream_id).await
}

#[napi]
pub fn abort_response_stream(stream_id: String) -> napi::Result<bool> {
    Ok(crate::api::cancel::cancel_stream(&stream_id))
}

/// Abort an in-flight tool execution (e.g. a bash subprocess) by the
/// execution id that was streamed to the frontend as a `tool_execution`
/// chunk.  The executing service races its wait against this cancellation
/// and kills the process tree.  Returns `true` if a running execution was
/// found and cancelled.
#[napi]
pub fn abort_tool_execution(tool_execution_id: String) -> napi::Result<bool> {
    let trimmed = tool_execution_id.trim();
    if trimmed.is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            "Tool execution ID is required".to_string(),
        ));
    }
    Ok(crate::api::cancel::cancel_tool_execution(trimmed))
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
#[napi(ts_return_type = "Promise<string>")]
pub async fn generate_conversation_summary(conversation_id: String) -> napi::Result<String> {
    let token = CancellationToken::new();
    crate::api::cancel::register_summary(&conversation_id, token.clone());
    let result = generate_summary(conversation_id.clone(), token).await;
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
/// so the UI can display the search process.
#[napi(
    ts_args_type = "query: string, workspacePath: string, onProgress: ((chunk: FileSearchAgentProgress) => void) | undefined"
)]
pub async fn search_files_by_agent(
    query: String,
    workspace_path: String,
    on_progress: Option<FileSearchAgentProgressCallback>,
) -> napi::Result<Vec<FileSearchResult>> {
    let token = CancellationToken::new();
    run_agent(query, workspace_path, token, on_progress).await
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
) -> napi::Result<Vec<McpToolDefinition>> {
    list_server_tools(config_server_id).await
}

#[napi]
pub async fn list_mcp_project_servers(
    project_id: String,
) -> napi::Result<Vec<McpProjectServerStatus>> {
    list_project_servers(project_id).await
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
pub async fn authorize_sensitive_command(command: String, token: String) -> napi::Result<()> {
    authorize_command(command, token).await
}

#[napi]
pub async fn write_interactive_stdin(session_id: String, input: String) -> napi::Result<()> {
    write_interactive_stdin_impl(session_id, input).await
}

#[napi(
    ts_args_type = "toolFullName: string, argsJson: string, projectId: string | undefined, checkpointIds: string[] | undefined, checkpointWorkDir: string | undefined, sensitiveAuthorizationToken: string | undefined, onChunk: (chunk: BashStreamChunk) => void, onBrowserCommand: (command: BrowserCommand) => Promise<string>, onUserQuestion: (question: UserQuestionCommand) => Promise<string>, onAppControl: (command: AppControlCommand) => Promise<string>, onRemoteWorkspaceCommand: (command: RemoteWorkspaceCommand) => Promise<string>, onTerminalCommand: (command: TerminalCommand) => Promise<string>, subAgentAllowedTools: string[] | undefined, planMode: boolean | undefined, planApproved: boolean | undefined",
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
    on_user_question: UserQuestionCallback,
    on_app_control: AppControlCallback,
    on_remote_workspace_command: RemoteWorkspaceCallback,
    on_terminal_command: TerminalCommandCallback,
    sub_agent_allowed_tools: Option<Vec<String>>,
    plan_mode: Option<bool>,
    plan_approved: Option<bool>,
) -> napi::Result<String> {
    call_tool(
        tool_full_name,
        args_json,
        project_id,
        checkpoint_ids.unwrap_or_default(),
        checkpoint_work_dir,
        sensitive_authorization_token,
        on_chunk,
        on_browser_command,
        on_user_question,
        on_app_control,
        on_remote_workspace_command,
        on_terminal_command,
        sub_agent_allowed_tools,
        plan_mode.unwrap_or(false),
        plan_approved.unwrap_or(false),
    )
    .await
}
