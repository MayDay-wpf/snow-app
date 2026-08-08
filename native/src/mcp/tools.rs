use std::path::{Component, Path, PathBuf};

use napi::bindgen_prelude::*;
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use napi_derive::napi;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::storage::services::checkpoint::CheckpointWorktreeCapture;
use crate::storage::services::system_settings::McpProjectScopeSettings;

enum ToolCheckpointCapture {
    None,
    File {
        checkpoint_ids: Vec<String>,
        work_dir: String,
        file_path: String,
    },
    Worktree(Option<CheckpointWorktreeCapture>),
}

use super::builtin::{execute_builtin_tool, get_builtin_servers_with_tools, get_builtin_tools};
use super::servers::app_control::{AppControlCallback, AppControlService};
use super::servers::bash::{BashService, BashStreamCallback, BashStreamChunk};
use super::servers::browser::{BrowserCommandCallback, BrowserService};
use super::servers::codebase::CodebaseService;
use super::servers::codelens::CodeLensService;
use super::servers::config::ConfigService;
use super::servers::filesystem::FilesystemService;
use super::servers::grep::GrepService;
use super::servers::imagegen::ImageGenService;
use super::servers::remote_workspace::{
    is_ssh_path, resolve_remote_project_workspace, resolve_remote_workspace_path,
    RemoteWorkspaceCallback,
};
use super::servers::skills::SkillsService;
use super::servers::terminal::{TerminalCommandCallback, TerminalService};
use super::servers::todo::TodoService;
use super::servers::user_interaction::{UserInteractionService, UserQuestionCallback};
use super::servers::websearch::WebSearchService;

// NOTE: list_mcp_tools 和 call_mcp_tool 的 #[napi] 导出在 exports/api.rs 中，
// 此处仅保留内部函数供 exports 层调用。

#[napi(object)]
pub struct McpToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema_json: String,
}

#[napi(object)]
pub struct McpProjectToolStatus {
    pub name: String,
    pub description: String,
    pub input_schema_json: String,
    pub enabled: bool,
}

#[napi(object)]
pub struct McpProjectServerStatus {
    pub id: String,
    pub name: String,
    pub source: String,
    pub global_enabled: bool,
    pub enabled: bool,
    pub tools: Vec<McpProjectToolStatus>,
    pub error: Option<String>,
}

#[derive(Clone)]
pub struct McpTool {
    pub server_id: String,
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

impl McpTool {
    pub fn full_name(&self) -> String {
        format!("{}-{}", self.server_id, self.name)
    }
}

/// requestApproval 工具全名（隶属于 app-control 服务器，仅 Plan Mode 下暴露）。
const REQUEST_APPROVAL_FULL_NAME: &str = "app-control-requestApproval";

/// 所有内置 MCP 服务器 ID（含动态注册的 skills），按长度降序排列，
/// 用于工具名最长前缀匹配。新格式 `{server_id}-{tool_name}` 中，server_id
/// 可能含 `-`（如 `user-interaction`），需通过此列表消除歧义；外部工具的
/// server_name 经 `sanitize_name` 后不含 `-`，可安全用第一个 `-` 分割。
pub const BUILTIN_SERVER_IDS: &[&str] = &[
    "user-interaction",
    "app-control",
    "filesystem",
    "sub-agents",
    "websearch",
    "imagegen",
    "codebase",
    "codelens",
    "browser",
    "config",
    "skills",
    "bash",
    "todo",
    "grep",
    "terminal",
];

/// 将工具全名 `{server_id}-{tool_name}` 拆分为 `(server_id, tool_name)`。
/// 先匹配已知内置 server_id 前缀（最长优先），再回退到首个 `-` 分割
/// （适用于外部工具，其 server_name 不含 `-`）。
pub fn split_tool_full_name(full_name: &str) -> Option<(&str, &str)> {
    for &server_id in BUILTIN_SERVER_IDS {
        if let Some(rest) = full_name.strip_prefix(server_id) {
            if let Some(tool_name) = rest.strip_prefix('-') {
                if !tool_name.is_empty() {
                    return Some((server_id, tool_name));
                }
            }
        }
    }
    let (server_id, tool_name) = full_name.split_once('-')?;
    if server_id.is_empty() || tool_name.is_empty() {
        return None;
    }
    Some((server_id, tool_name))
}

pub async fn list_mcp_tools() -> napi::Result<Vec<McpToolDefinition>> {
    let tools = collect_all_mcp_tools(None, false).await?;
    Ok(to_tool_definitions(&tools))
}

pub async fn list_mcp_server_tools(
    config_server_id: String,
) -> napi::Result<Vec<McpToolDefinition>> {
    let tools = super::external::discover_server_tools(None, &config_server_id).await?;
    Ok(to_tool_definitions(&tools))
}

pub async fn list_mcp_project_servers(
    project_id: String,
) -> napi::Result<Vec<McpProjectServerStatus>> {
    let project_id = required_value(project_id, "Project id")?;
    let scope = load_project_scope(Some(&project_id))
        .await?
        .ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                "Project id is required to list project MCP servers".to_string(),
            )
        })?;

    // Image generation tool is only globally available when at least one
    // channel (OpenAI / Gemini) is configured and enabled in Settings ->
    // Image generation. When both are unconfigured the server is globally
    // disabled so the front-end toggle reflects the real state (instead of
    // appearing enabled while the tool is silently excluded from context).
    let imagegen_configured =
        tokio::task::spawn_blocking(|| crate::mcp::servers::imagegen::is_imagegen_configured())
            .await
            .map_err(|error| {
                Error::new(
                    Status::GenericFailure,
                    format!("Failed to check image generation configuration: {error}"),
                )
            })??;

    let mut servers = get_builtin_servers_with_tools()
        .into_iter()
        .map(|(server_id, tools)| {
            let scope_server_id = builtin_scope_server_id(&server_id);
            let enabled = scope.is_server_enabled(&scope_server_id);
            // Reflect imagegen configuration state in global_enabled / error
            // so the front-end toggle stays in sync with collect_all_mcp_tools.
            // The error field uses a stable code (not a localized string) that
            // the front-end maps to the user's language.
            let (global_enabled, error) = if server_id == "imagegen" && !imagegen_configured {
                (false, Some("imagegen:not_configured".to_string()))
            } else {
                (true, None)
            };
            McpProjectServerStatus {
                id: scope_server_id,
                name: builtin_server_name(&server_id).to_string(),
                source: "system".to_string(),
                global_enabled,
                enabled,
                tools: to_project_tool_statuses(&tools, &scope),
                error,
            }
        })
        .collect::<Vec<_>>();

    for external_server in super::external::discover_project_servers(&project_id).await? {
        let scope_server_id =
            super::external::project_scope_server_id(&external_server.config_server_id);
        let project_owned = external_server.source == "project";
        let enabled =
            external_server.enabled && (project_owned || scope.is_server_enabled(&scope_server_id));
        servers.push(McpProjectServerStatus {
            id: scope_server_id,
            name: external_server.name,
            source: external_server.source,
            global_enabled: external_server.global_enabled,
            enabled,
            tools: Vec::new(),
            error: None,
        });
    }

    Ok(servers)
}

pub async fn list_mcp_project_server_tools(
    project_id: String,
    server_id: String,
) -> napi::Result<Vec<McpProjectToolStatus>> {
    let project_id = required_value(project_id, "Project id")?;
    let server_id = required_value(server_id, "MCP server id")?;
    let scope = load_project_scope(Some(&project_id))
        .await?
        .ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                "Project id is required to list project MCP server tools".to_string(),
            )
        })?;

    if let Some(builtin_server_id) = server_id.strip_prefix("builtin:") {
        let tools = get_builtin_servers_with_tools()
            .into_iter()
            .find(|(known_server_id, _)| known_server_id == builtin_server_id)
            .map(|(_, tools)| tools)
            .ok_or_else(|| {
                Error::new(
                    Status::InvalidArg,
                    format!("Unknown MCP project server: {server_id}"),
                )
            })?;
        return Ok(to_project_tool_statuses(&tools, &scope));
    }

    let external_server_id = server_id.strip_prefix("external:").ok_or_else(|| {
        Error::new(
            Status::InvalidArg,
            format!("Unknown MCP project server: {server_id}"),
        )
    })?;
    let tools =
        super::external::discover_server_tools(Some(&project_id), external_server_id).await?;
    Ok(to_project_tool_statuses(&tools, &scope))
}

pub async fn set_mcp_project_server_enabled(
    project_id: String,
    server_id: String,
    enabled: bool,
) -> napi::Result<()> {
    let project_id = required_value(project_id, "Project id")?;
    let server_id = required_value(server_id, "MCP server id")?;
    let known_server = if let Some(builtin_server_id) = server_id.strip_prefix("builtin:") {
        get_builtin_servers_with_tools()
            .iter()
            .any(|(known_server_id, _)| known_server_id == builtin_server_id)
    } else if let Some(external_server_id) = server_id.strip_prefix("external:") {
        super::external::discover_project_servers(&project_id)
            .await?
            .iter()
            .any(|server| server.config_server_id == external_server_id)
    } else {
        false
    };
    if !known_server {
        return Err(Error::new(
            Status::InvalidArg,
            format!("Unknown MCP project server: {server_id}"),
        ));
    }

    if let Some(external_server_id) = server_id.strip_prefix("external:") {
        let project_servers = super::external::discover_project_servers(&project_id).await?;
        if project_servers.iter().any(|server| {
            server.config_server_id == external_server_id && server.source == "project"
        }) {
            let external_server_id = external_server_id.to_string();
            return with_database_path(move |database_path| {
                crate::storage::services::project_mcp_server_configs::set_project_mcp_server_enabled(
                    &database_path,
                    &project_id,
                    &external_server_id,
                    enabled,
                )
            })
            .await;
        }
    }

    with_database_path(move |database_path| {
        crate::storage::services::system_settings::set_mcp_project_server_enabled(
            &database_path,
            &project_id,
            &server_id,
            enabled,
        )
    })
    .await
}

pub async fn set_mcp_project_tool_enabled(
    project_id: String,
    tool_name: String,
    enabled: bool,
) -> napi::Result<()> {
    let project_id = required_value(project_id, "Project id")?;
    let tool_name = required_value(tool_name, "MCP tool name")?;
    let tool_exists = if let Some(server_id) = server_id_from_tool_name(&tool_name) {
        if get_builtin_servers_with_tools()
            .iter()
            .any(|(builtin_server_id, _)| builtin_server_id == server_id)
        {
            get_builtin_tools()
                .iter()
                .any(|tool| tool.full_name() == tool_name)
        } else {
            super::external::resolve_project_scope_server(Some(&project_id), &tool_name)
                .await?
                .is_some()
        }
    } else {
        false
    };
    if !tool_exists {
        return Err(Error::new(
            Status::InvalidArg,
            format!("Unknown MCP project tool: {tool_name}"),
        ));
    }

    with_database_path(move |database_path| {
        crate::storage::services::system_settings::set_mcp_project_tool_enabled(
            &database_path,
            &project_id,
            &tool_name,
            enabled,
        )
    })
    .await
}

fn to_tool_definitions(tools: &[McpTool]) -> Vec<McpToolDefinition> {
    tools
        .iter()
        .map(|tool| McpToolDefinition {
            name: tool.full_name(),
            description: tool.description.clone(),
            input_schema_json: serialize_input_schema(tool),
        })
        .collect()
}

fn to_project_tool_statuses(
    tools: &[McpTool],
    scope: &McpProjectScopeSettings,
) -> Vec<McpProjectToolStatus> {
    tools
        .iter()
        .map(|tool| {
            let full_name = tool.full_name();
            McpProjectToolStatus {
                enabled: scope.is_tool_enabled(&full_name),
                name: full_name,
                description: tool.description.clone(),
                input_schema_json: serialize_input_schema(tool),
            }
        })
        .collect()
}

fn serialize_input_schema(tool: &McpTool) -> String {
    serde_json::to_string(&tool.input_schema).unwrap_or_else(|_| "{}".to_string())
}

fn required_value(value: String, label: &str) -> Result<String> {
    let normalized = value.trim();
    if normalized.is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            format!("{label} is required"),
        ));
    }

    Ok(normalized.to_string())
}

pub async fn collect_all_mcp_tools(
    project_id: Option<&str>,
    include_plan_mode_tool: bool,
) -> Result<Vec<McpTool>> {
    let scope = load_project_scope(project_id).await?;

    // Determine whether the codebase search tool should be included.
    // It requires: (1) a project id, (2) codebase enabled in project scope,
    // and (3) at least one embedded chunk in the vector table.
    let codebase_available = is_codebase_available(project_id).await?;

    // Image generation tool is only exposed when at least one channel
    // (OpenAI / Gemini) is configured and enabled in Settings -> Image
    // generation; when both are unconfigured the tool disappears entirely.
    let imagegen_configured =
        tokio::task::spawn_blocking(|| crate::mcp::servers::imagegen::is_imagegen_configured())
            .await
            .map_err(|error| {
                Error::new(
                    Status::GenericFailure,
                    format!("Failed to check image generation configuration: {error}"),
                )
            })??;

    let mut tools = get_builtin_tools()
        .into_iter()
        .filter(|tool| {
            // The dedicated approval tool is request-scoped: it must only be
            // exposed to the model while the current request is in Plan Mode.
            if tool.full_name() == REQUEST_APPROVAL_FULL_NAME {
                return include_plan_mode_tool;
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
            tool_is_enabled(tool, scope.as_ref())
        })
        .collect::<Vec<_>>();

    if let Some(skill_tool) = SkillsService::new().tool(project_id).await? {
        if tool_is_enabled(&skill_tool, scope.as_ref()) {
            tools.push(skill_tool);
        }
    }

    match super::external::discover_tools(project_id, scope.as_ref()).await {
        Ok(external_tools) => tools.extend(external_tools),
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
        return Ok(all_tools);
    }

    let available_names = all_tools
        .iter()
        .map(McpTool::full_name)
        .collect::<std::collections::HashSet<_>>();
    let unavailable_names = configured_names
        .difference(&available_names)
        .cloned()
        .collect::<Vec<_>>();
    if !unavailable_names.is_empty() {
        return Err(Error::new(
            Status::GenericFailure,
            format!(
                "Sub-agent configured tools are unavailable or disabled for the current project: {}",
                unavailable_names.join(", ")
            ),
        ));
    }

    Ok(all_tools
        .into_iter()
        .filter(|tool| configured_names.contains(&tool.full_name()))
        .collect())
}

/// Built-in server ids that are disabled by default and must be explicitly
/// enabled per project. This keeps their tools out of the model context
/// (saving tokens) until the user opts in.
const DEFAULT_DISABLED_SERVER_IDS: &[&str] = &["terminal"];

fn tool_is_enabled(tool: &McpTool, scope: Option<&McpProjectScopeSettings>) -> bool {
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

fn builtin_scope_server_id(server_id: &str) -> String {
    format!("builtin:{server_id}")
}

fn server_id_from_tool_name(tool_name: &str) -> Option<&str> {
    split_tool_full_name(tool_name).map(|(server_id, _)| server_id)
}

fn builtin_server_name(server_id: &str) -> &str {
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
        _ => server_id,
    }
}

async fn ensure_project_tool_enabled(project_id: Option<&str>, tool_name: &str) -> Result<()> {
    let Some(scope) = load_project_scope(project_id).await? else {
        return Ok(());
    };
    let Some(server_id) = server_id_from_tool_name(tool_name) else {
        return Err(Error::new(
            Status::InvalidArg,
            format!("Invalid MCP tool name: {tool_name}"),
        ));
    };
    let (server_scope_id, project_owned) = if server_id == "skills"
        || get_builtin_servers_with_tools()
            .iter()
            .any(|(builtin_server_id, _)| builtin_server_id == server_id)
    {
        (builtin_scope_server_id(server_id), false)
    } else {
        let resolved_server = super::external::resolve_project_scope_server(project_id, tool_name)
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

async fn load_project_scope(project_id: Option<&str>) -> Result<Option<McpProjectScopeSettings>> {
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

async fn with_database_path<T, F>(operation: F) -> Result<T>
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

pub fn tools_as_openai_chat_json(tools: &[McpTool]) -> Value {
    let functions: Vec<Value> = tools
        .iter()
        .map(|tool| {
            let sanitized_schema = sanitize_tool_input_schema(&tool.input_schema);
            json!({
                "type": "function",
                "function": {
                    "name": tool.full_name(),
                    "description": tool.description,
                    "parameters": sanitized_schema,
                }
            })
        })
        .collect();

    Value::Array(functions)
}

/// Tool APIs require the root input schema to describe an object. Some
/// compatible gateways reject root `oneOf`/`anyOf`/`allOf` combinators when a
/// branch does not explicitly declare an object, even if the root has
/// `type: "object"`. Keep nested constraints intact, but remove root
/// combinators and always emit an object schema. Runtime tool validation still
/// enforces cross-field requirements that cannot be represented at the root.
fn sanitize_tool_input_schema(schema: &Value) -> Value {
    let mut result = schema.as_object().cloned().unwrap_or_default();

    result.remove("oneOf");
    result.remove("anyOf");
    result.remove("allOf");
    result.insert("type".to_string(), Value::String("object".to_string()));

    Value::Object(result)
}

pub fn tools_as_anthropic_json(tools: &[McpTool]) -> Value {
    let tools_json: Vec<Value> = tools
        .iter()
        .map(|tool| {
            let sanitized_schema = sanitize_tool_input_schema(&tool.input_schema);
            json!({
                "name": tool.full_name(),
                "description": tool.description,
                "input_schema": sanitized_schema,
            })
        })
        .collect();

    Value::Array(tools_json)
}

pub fn tools_as_openai_responses_json(tools: &[McpTool]) -> Value {
    let tools_json: Vec<Value> = tools
        .iter()
        .map(|tool| {
            let sanitized_schema = sanitize_tool_input_schema(&tool.input_schema);
            json!({
                "type": "function",
                "name": tool.full_name(),
                "description": tool.description,
                "parameters": sanitized_schema,
            })
        })
        .collect();

    Value::Array(tools_json)
}

pub fn tools_as_gemini_json(tools: &[McpTool]) -> Value {
    let function_declarations: Vec<Value> = tools
        .iter()
        .map(|tool| {
            let sanitized_schema = sanitize_tool_input_schema(&tool.input_schema);
            json!({
                "name": tool.full_name(),
                "description": tool.description,
                "parameters": sanitized_schema,
            })
        })
        .collect();

    json!({
        "functionDeclarations": function_declarations
    })
}

/// Register a cancellation token for a remote (SSH) tool execution and emit
/// its id as a `tool_execution` stream chunk so the frontend can abort the
/// pending Electron-side command (per-tool stop button / session stop).
/// Returns the id and token; the caller must `unregister_tool_execution` when
/// the execution settles.
fn register_remote_tool_execution(
    on_chunk: &BashStreamCallback,
) -> (String, tokio_util::sync::CancellationToken) {
    let tool_execution_id = Uuid::new_v4().to_string();
    let cancel_token = crate::api::cancel::register_tool_execution(&tool_execution_id);
    on_chunk.call(
        BashStreamChunk {
            stream: "tool_execution".to_string(),
            data: tool_execution_id.clone(),
        },
        ThreadsafeFunctionCallMode::NonBlocking,
    );
    (tool_execution_id, cancel_token)
}

/// Execute an MCP tool and capture incremental checkpoint state immediately
pub async fn call_mcp_tool(
    tool_full_name: String,
    args_json: String,
    project_id: Option<String>,
    checkpoint_ids: Vec<String>,
    checkpoint_work_dir: Option<String>,
    sensitive_authorization_token: Option<String>,
    on_chunk: BashStreamCallback,
    on_browser_command: BrowserCommandCallback,
    on_user_question: UserQuestionCallback,
    on_app_control: AppControlCallback,
    on_remote_workspace_command: RemoteWorkspaceCallback,
    on_terminal_command: TerminalCommandCallback,
    sub_agent_allowed_tools: Option<Vec<String>>,
    plan_mode: bool,
    plan_approved: bool,
) -> napi::Result<String> {
    // Sanitize: AI may copy "[Tool: server-tool#callId]" from conversation
    // history or leak internal XML tags into the tool name. Normalize
    // before any matching or whitelist check.
    let tool_full_name = super::builtin::sanitize_tool_full_name(&tool_full_name);
    let is_sub_agent_call = sub_agent_allowed_tools.is_some();

    if tool_full_name == REQUEST_APPROVAL_FULL_NAME {
        if is_sub_agent_call {
            return Err(Error::new(
                Status::GenericFailure,
                "app-control-requestApproval is reserved for the main conversation; sub-agents cannot request or grant Plan Mode approval"
                    .to_string(),
            ));
        }
        if !plan_mode {
            return Err(Error::new(
                Status::GenericFailure,
                "app-control-requestApproval is only available while Plan Mode is active"
                    .to_string(),
            ));
        }
    }

    let args = parse_tool_args(&tool_full_name, &args_json)?;
    if plan_mode
        && !plan_approved
        && matches!(
            tool_full_name.as_str(),
            "filesystem-replace_edit" | "filesystem-create"
        )
        && (is_sub_agent_call
            || !is_allowed_plan_document_write(project_id.as_deref(), &args).await?)
    {
        let message = if is_sub_agent_call {
            format!(
                "PARENT_PLAN_APPROVAL_REQUIRED: {tool_full_name} cannot run because the main conversation has not approved its Plan Mode plan. Stop this sub-agent task and return control to the main conversation. Do not retry this write and do not request approval from the sub-agent."
            )
        } else {
            format!(
                "Plan Mode write blocked: {tool_full_name} cannot run before explicit user approval. Only plan documents inside .snow/plan or .trellis/tasks may be written during planning. Call app-control-requestApproval first, and retry project-file writes only when that tool returns approved=true."
            )
        };
        return Err(Error::new(Status::GenericFailure, message));
    }

    ensure_project_tool_enabled(project_id.as_deref(), &tool_full_name).await?;

    if let Some(ref allowed_tools) = sub_agent_allowed_tools {
        let wildcard_enabled = allowed_tools.iter().any(|name| name == "*");
        if !wildcard_enabled && !allowed_tools.iter().any(|name| name == &tool_full_name) {
            return Err(Error::new(
                Status::GenericFailure,
                format!("Sub-agent tool is not in the allowed whitelist: {tool_full_name}"),
            ));
        }
    }

    let (args, uses_remote_workspace) =
        prepare_remote_workspace_args(&tool_full_name, args, project_id.as_deref()).await?;

    // 本地（非 SSH）filesystem 工具：将 filePath 的相对路径（如 "."）解析到
    // 当前项目根目录，避免其被解析为 Electron 进程的工作目录。
    let args = if uses_remote_workspace {
        args
    } else {
        resolve_local_filesystem_args(&tool_full_name, args, project_id.as_deref()).await?
    };

    let checkpoint_capture = if uses_remote_workspace {
        ToolCheckpointCapture::None
    } else {
        let checkpoint_tool_name = tool_full_name.clone();
        let checkpoint_args = args.clone();
        tokio::task::spawn_blocking(move || {
            capture_checkpoint_before_tool(
                &checkpoint_tool_name,
                &checkpoint_args,
                checkpoint_ids,
                checkpoint_work_dir,
            )
        })
        .await
        .map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to capture checkpoint before tool execution: {error}"),
            )
        })??
    };

    let returns_plain_text = tool_full_name == "skills-skill-execute";
    let masking_tool_name = tool_full_name.clone();
    let result = if tool_full_name == "bash-terminal-execute" {
        let terminal_result = BashService::new()
            .execute_terminal_stream(
                &args,
                project_id.as_deref(),
                sensitive_authorization_token.as_deref(),
                on_chunk,
                &on_remote_workspace_command,
            )
            .await;
        if let ToolCheckpointCapture::Worktree(Some(capture)) = checkpoint_capture {
            tokio::task::spawn_blocking(move || {
                crate::storage::services::checkpoint::record_checkpoint_worktree_after(capture)
            })
            .await
            .map_err(|error| {
                Error::new(
                    Status::GenericFailure,
                    format!("Failed to capture checkpoint after tool execution: {error}"),
                )
            })??;
        }
        terminal_result?
    } else if tool_full_name == "grep-search" {
        // Register a cancellable tool execution only for the SSH branch; the
        // local ripgrep/native search has its own 30s timeout and cannot be
        // aborted through the exec-channel registry.
        let remote_cancel = if args
            .get("path")
            .and_then(Value::as_str)
            .is_some_and(is_ssh_path)
        {
            Some(register_remote_tool_execution(&on_chunk))
        } else {
            None
        };
        let search_result = GrepService::new()
            .execute_search(
                &args,
                &on_remote_workspace_command,
                remote_cancel.as_ref().map(|(_, token)| token),
            )
            .await;
        if let Some((tool_execution_id, _)) = remote_cancel {
            crate::api::cancel::unregister_tool_execution(&tool_execution_id);
        }
        search_result?
    } else if uses_remote_workspace {
        let filesystem_tool = tool_full_name.strip_prefix("filesystem-").ok_or_else(|| {
            Error::new(
                Status::GenericFailure,
                format!("Unsupported remote workspace MCP tool: {tool_full_name}"),
            )
        })?;
        let (tool_execution_id, cancel_token) = register_remote_tool_execution(&on_chunk);
        let fs_result = FilesystemService::new()
            .execute_async(
                filesystem_tool,
                &args,
                &on_remote_workspace_command,
                Some(&cancel_token),
            )
            .await;
        crate::api::cancel::unregister_tool_execution(&tool_execution_id);
        fs_result?
    } else if tool_full_name == "todo-todo-manage" {
        TodoService::new().execute_async(&args).await?
    } else if tool_full_name == "websearch-websearch-search" {
        WebSearchService::new().execute_search(&args).await?
    } else if tool_full_name == "websearch-websearch-fetch" {
        WebSearchService::new().execute_fetch(&args).await?
    } else if tool_full_name == "imagegen-generate" {
        ImageGenService::new()
            .execute_generate(&args, &on_chunk)
            .await?
    } else if tool_full_name == "imagegen-image-describe" {
        ImageGenService::new().execute_describe(&args).await?
    } else if let Some(tool_name) = tool_full_name.strip_prefix("browser-") {
        BrowserService::new()
            .execute_async(tool_name, &args, &on_browser_command)
            .await?
    } else if let Some(tool_name) = tool_full_name.strip_prefix("terminal-") {
        TerminalService::new()
            .execute_async(tool_name, &args, &on_terminal_command)
            .await?
    } else if tool_full_name == "user-interaction-askUserQuestion" {
        UserInteractionService::new()
            .execute_async(&args, &on_user_question)
            .await?
    } else if let Some(app_control_tool) = tool_full_name.strip_prefix("app-control-") {
        AppControlService::new()
            .execute_async(app_control_tool, &args, &on_app_control, &on_user_question)
            .await?
    } else if let Some(config_tool) = tool_full_name.strip_prefix("config-") {
        // 传入运行时已知的当前会话 projectId（directoryId）。ConfigService
        // 内部会将其注入到支持项目级作用域的调用（hooks/subAgents/skills/
        // settings 项目键），并让 config-list 返回 currentProjectId，
        // 修复 AI 无法获知当前会话项目ID导致项目级配置落到全局的问题。
        ConfigService::new()
            .execute_async(config_tool, &args, project_id.clone())
            .await?
    } else if tool_full_name == "skills-skill-execute" {
        SkillsService::new()
            .execute(&args, project_id.as_deref())
            .await?
    } else if tool_full_name == "codebase-search" {
        CodebaseService::new()
            .execute_search(&args, project_id.as_deref(), &on_chunk)
            .await?
    } else if let Some(codelens_tool) = tool_full_name.strip_prefix("codelens-") {
        let service = CodeLensService::new();
        match codelens_tool {
            "find_definition" => {
                service
                    .execute_find_definition(&args, project_id.as_deref())
                    .await?
            }
            "find_references" => {
                service
                    .execute_find_references(&args, project_id.as_deref())
                    .await?
            }
            "file_outline" => service.execute_file_outline(&args).await?,
            _ => {
                return Err(Error::new(
                    Status::GenericFailure,
                    format!(
                        "Unknown codelens tool: \"{codelens_tool}\". Available tools: [find_definition, find_references, file_outline]"
                    ),
                ));
            }
        }
    } else if let Some(result) =
        super::external::call_tool(project_id.as_deref(), &tool_full_name, &args).await?
    {
        result
    } else {
        tokio::task::spawn_blocking(move || {
            let result = execute_builtin_tool(&tool_full_name, &args);
            capture_checkpoint_after_tool(checkpoint_capture)?;
            result
        })
        .await
        .map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to execute MCP tool: {error}"),
            )
        })??
    };

    if returns_plain_text {
        let plain_text = result.as_str().map(str::to_string).ok_or_else(|| {
            Error::new(
                Status::GenericFailure,
                "Skill execution returned an invalid text result".to_string(),
            )
        })?;
        let masked =
            super::privacy_mask::mask_tool_result_if_needed(&masking_tool_name, &plain_text)
                .await?;
        return Ok(masked);
    }

    let serialized = serde_json::to_string(&result).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to serialize result: {error}"),
        )
    })?;
    super::privacy_mask::mask_tool_result_if_needed(&masking_tool_name, &serialized).await
}

const PLAN_WRITE_DIRECTORIES: [[&str; 2]; 2] = [[".snow", "plan"], [".trellis", "tasks"]];

async fn is_allowed_plan_document_write(
    project_id: Option<&str>,
    args: &Value,
) -> napi::Result<bool> {
    let Some(file_path) = args
        .get("filePath")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|path| !path.is_empty())
    else {
        return Ok(false);
    };
    let Some(project_id) = project_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
    else {
        return Ok(false);
    };
    let workspace_path = with_database_path(move |database_path| {
        crate::storage::services::workspace_directories::get_workspace_directory_path(
            &database_path,
            &project_id,
        )
    })
    .await?;
    let Some(workspace_path) = workspace_path else {
        return Ok(false);
    };

    if is_ssh_path(&workspace_path) {
        return Ok(is_allowed_remote_plan_write(&workspace_path, file_path));
    }

    let workspace_path = PathBuf::from(workspace_path);
    let requested_path = PathBuf::from(file_path);
    tokio::task::spawn_blocking(move || {
        is_allowed_local_plan_write(&workspace_path, &requested_path)
    })
    .await
    .map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to validate Plan Mode write path: {error}"),
        )
    })
}

fn is_allowed_local_plan_write(workspace_path: &Path, requested_path: &Path) -> bool {
    let Some(workspace_path) = lexical_normalize_path(workspace_path) else {
        return false;
    };
    if !workspace_path.is_absolute() {
        return false;
    }

    let candidate_path = if requested_path.is_absolute() {
        lexical_normalize_path(requested_path)
    } else {
        lexical_normalize_path(&workspace_path.join(requested_path))
    };
    let Some(candidate_path) = candidate_path else {
        return false;
    };

    PLAN_WRITE_DIRECTORIES.iter().any(|segments| {
        let allowed_root = workspace_path.join(segments[0]).join(segments[1]);
        path_is_descendant(&candidate_path, &allowed_root)
            && !path_contains_symlink(&workspace_path, &candidate_path)
    })
}

fn lexical_normalize_path(path: &Path) -> Option<PathBuf> {
    let mut normalized = PathBuf::new();
    let mut normal_depth = 0usize;

    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if normal_depth == 0 || !normalized.pop() {
                    return None;
                }
                normal_depth -= 1;
            }
            Component::Normal(segment) => {
                normalized.push(segment);
                normal_depth += 1;
            }
        }
    }

    Some(normalized)
}

fn path_is_descendant(candidate_path: &Path, root_path: &Path) -> bool {
    let candidate_components = candidate_path.components().collect::<Vec<_>>();
    let root_components = root_path.components().collect::<Vec<_>>();
    candidate_components.len() > root_components.len()
        && root_components
            .iter()
            .zip(candidate_components.iter())
            .all(|(root, candidate)| local_component_eq(*root, *candidate))
}

fn local_component_eq(left: Component<'_>, right: Component<'_>) -> bool {
    if cfg!(windows) {
        left.as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case(&right.as_os_str().to_string_lossy())
    } else {
        left == right
    }
}

fn path_contains_symlink(workspace_path: &Path, candidate_path: &Path) -> bool {
    let workspace_depth = workspace_path.components().count();
    let mut current_path = workspace_path.to_path_buf();

    for component in candidate_path.components().skip(workspace_depth) {
        current_path.push(component.as_os_str());
        match std::fs::symlink_metadata(&current_path) {
            Ok(metadata) if metadata.file_type().is_symlink() => return true,
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return false,
            Err(_) => return true,
        }
    }

    false
}

fn is_allowed_remote_plan_write(workspace_path: &str, requested_path: &str) -> bool {
    let resolved_path =
        resolve_remote_workspace_path(workspace_path, &requested_path.trim().replace('\\', "/"));
    let Some((workspace_authority, workspace_segments)) = normalize_ssh_path(workspace_path) else {
        return false;
    };
    let Some((candidate_authority, candidate_segments)) = normalize_ssh_path(&resolved_path) else {
        return false;
    };
    if workspace_authority != candidate_authority
        || !remote_segments_start_with(&candidate_segments, &workspace_segments)
    {
        return false;
    }

    let relative_segments = &candidate_segments[workspace_segments.len()..];
    PLAN_WRITE_DIRECTORIES.iter().any(|segments| {
        relative_segments.len() > segments.len()
            && relative_segments[0] == segments[0]
            && relative_segments[1] == segments[1]
    })
}

fn normalize_ssh_path(path: &str) -> Option<(String, Vec<String>)> {
    let normalized = path.trim().replace('\\', "/");
    let remainder = normalized.strip_prefix("ssh://")?;
    let (authority, raw_path) = remainder.split_once('/').unwrap_or((remainder, ""));
    if authority.is_empty() {
        return None;
    }

    let mut segments = Vec::new();
    for segment in raw_path.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                segments.pop()?;
            }
            value => segments.push(value.to_string()),
        }
    }

    Some((authority.to_string(), segments))
}

fn remote_segments_start_with(candidate: &[String], root: &[String]) -> bool {
    candidate.len() >= root.len()
        && root
            .iter()
            .zip(candidate.iter())
            .all(|(root_segment, candidate_segment)| root_segment == candidate_segment)
}

async fn prepare_remote_workspace_args(
    tool_full_name: &str,
    mut args: Value,
    project_id: Option<&str>,
) -> napi::Result<(Value, bool)> {
    let Some(path_field) = remote_workspace_path_field(tool_full_name) else {
        return Ok((args, false));
    };
    let Some(path) = args.get(path_field).and_then(Value::as_str) else {
        return Ok((args, false));
    };
    if is_ssh_path(path) {
        return Ok((args, true));
    }

    let Some(workspace_path) = resolve_remote_project_workspace(project_id).await? else {
        return Ok((args, false));
    };
    args[path_field] = Value::String(resolve_remote_workspace_path(&workspace_path, path));
    Ok((args, true))
}

fn remote_workspace_path_field(tool_full_name: &str) -> Option<&'static str> {
    match tool_full_name {
        "filesystem-read" | "filesystem-replace_edit" | "filesystem-create" => Some("filePath"),
        "grep-search" => Some("path"),
        "bash-terminal-execute" => Some("workingDirectory"),
        _ => None,
    }
}

/// 解析 project_id 对应的本地（非 SSH）工作区根目录。
/// 通过应用数据库中的 workspace_directories 表查询该项目的本地根路径。
/// 数据库访问放在 Tokio 阻塞池中执行，避免阻塞 N-API 异步运行时。
/// SSH 工作区不在此处理，由 prepare_remote_workspace_args 统一路由到远端。
async fn resolve_local_project_root(project_id: Option<&str>) -> napi::Result<Option<String>> {
    let Some(project_id) = project_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let project_id = project_id.to_string();

    let workspace_path = tokio::task::spawn_blocking(move || {
        let storage_info = crate::storage::initialize_app_storage()?;
        let database_path = std::path::PathBuf::from(storage_info.database_path);
        crate::storage::services::workspace_directories::get_workspace_directory_path(
            &database_path,
            &project_id,
        )
    })
    .await
    .map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to resolve local project workspace: {error}"),
        )
    })??;

    Ok(workspace_path.filter(|path| !is_ssh_path(path)))
}

/// 将本地 filesystem 工具的 filePath 相对路径解析到当前项目根目录。
/// 当 AI 以 "."、"./src"、"src/main.ts" 等相对路径调用 filesystem 工具时，
/// 避免它们被 Rust 解析为 Electron 进程的工作目录（通常并非项目根目录）。
/// 绝对路径、空路径、SSH 路径或无法解析出项目根目录时保持原样。
async fn resolve_local_filesystem_args(
    tool_full_name: &str,
    mut args: Value,
    project_id: Option<&str>,
) -> napi::Result<Value> {
    if !tool_full_name.starts_with("filesystem-") {
        return Ok(args);
    }
    let Some(file_path) = args.get("filePath").and_then(Value::as_str) else {
        return Ok(args);
    };
    let trimmed = file_path.trim();
    if trimmed.is_empty() || is_ssh_path(trimmed) {
        return Ok(args);
    }
    let path = Path::new(trimmed);
    if path.is_absolute() {
        return Ok(args);
    }
    let Some(project_root) = resolve_local_project_root(project_id).await? else {
        return Ok(args);
    };

    let resolved = Path::new(&project_root)
        .join(path)
        .to_string_lossy()
        .to_string();
    args["filePath"] = Value::String(resolved);
    Ok(args)
}

fn parse_tool_args(tool_full_name: &str, args_json: &str) -> napi::Result<Value> {
    serde_json::from_str(args_json).map_err(|error| {
        let received = args_json.chars().take(200).collect::<String>();
        let suffix = if args_json.chars().count() > 200 {
            "..."
        } else {
            ""
        };

        Error::new(
            Status::InvalidArg,
            format!(
                "Failed to parse arguments JSON for tool \"{tool_full_name}\": {error}. Received: {received}{suffix}"
            ),
        )
    })
}

fn capture_checkpoint_before_tool(
    tool_full_name: &str,
    args: &Value,
    checkpoint_ids: Vec<String>,
    checkpoint_work_dir: Option<String>,
) -> napi::Result<ToolCheckpointCapture> {
    if checkpoint_ids.is_empty() {
        return Ok(ToolCheckpointCapture::None);
    }
    let work_dir = checkpoint_work_dir.ok_or_else(|| {
        Error::new(
            Status::InvalidArg,
            "Checkpoint working directory is required".to_string(),
        )
    })?;

    match tool_full_name {
        "filesystem-replace_edit" | "filesystem-create" => {
            let file_path = args
                .get("filePath")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    Error::new(
                        Status::InvalidArg,
                        "filePath is required for checkpoint capture".to_string(),
                    )
                })?
                .to_string();
            crate::storage::services::checkpoint::record_checkpoint_file(
                checkpoint_ids.clone(),
                work_dir.clone(),
                file_path.clone(),
            )?;
            Ok(ToolCheckpointCapture::File {
                checkpoint_ids,
                work_dir,
                file_path,
            })
        }
        "bash-terminal-execute" => Ok(ToolCheckpointCapture::Worktree(
            crate::storage::services::checkpoint::capture_checkpoint_worktree_before(
                checkpoint_ids,
                work_dir,
            )?,
        )),
        _ => Ok(ToolCheckpointCapture::None),
    }
}

fn capture_checkpoint_after_tool(capture: ToolCheckpointCapture) -> napi::Result<()> {
    match capture {
        ToolCheckpointCapture::File {
            checkpoint_ids,
            work_dir,
            file_path,
        } => crate::storage::services::checkpoint::record_checkpoint_file_after(
            checkpoint_ids,
            work_dir,
            file_path,
        ),
        ToolCheckpointCapture::Worktree(Some(capture)) => {
            crate::storage::services::checkpoint::record_checkpoint_worktree_after(capture)
        }
        ToolCheckpointCapture::None | ToolCheckpointCapture::Worktree(None) => Ok(()),
    }
}
