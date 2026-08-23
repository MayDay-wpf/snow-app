use std::path::Path;
use std::time::{Duration, Instant};

use futures::{stream, StreamExt};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde_json::Value;

use crate::mcp::servers::bash::stream_io::emit_stream_chunk;
use crate::mcp::servers::bash::BashStreamCallback;
use crate::storage::services::checkpoint::remote::RemoteCheckpointClient;
use crate::storage::services::checkpoint::CheckpointWorktreeCapture;
use crate::storage::services::system_settings::{McpGlobalScopeSettings, McpProjectScopeSettings};

enum ToolCheckpointCapture {
    None,
    File {
        checkpoint_ids: Vec<String>,
        work_dir: String,
        file_path: String,
    },
    Worktree(Option<CheckpointWorktreeCapture>),
}

/// 持有完整 before → 工具执行 → after 周期的异步锁。单文件工具共享目录
/// 读锁并按文件串行；影响范围未知的外部 MCP 独占目录锁。bash 命令执行
/// 期间不持任何执行级锁——跨会话命令并行运行，回滚/预览也不会被长时间
/// 命令阻塞（bash 的 before/after 扫描内部另有短时共享读锁 + 回滚纪元）。
/// 字段只用于 RAII，离开调用作用域时自动释放。
enum ToolCheckpointOperationGuard {
    None,
    File {
        _work_dir_guard: tokio::sync::OwnedRwLockReadGuard<()>,
        _file_guard: tokio::sync::OwnedMutexGuard<()>,
    },
    /// 影响范围未知的外部 MCP 工具：整树独占锁，避免污染可捕获工具
    /// （bash / 文件工具）的 before/after 记录。
    Exclusive {
        _work_dir_guard: tokio::sync::OwnedRwLockWriteGuard<()>,
    },
}

use super::builtin::{get_builtin_servers_with_tools, get_builtin_tools};
use super::servers::remote_workspace::{
    is_ssh_path, is_windows_absolute_path, resolve_remote_project_workspace,
    resolve_remote_workspace_path, RemoteWorkspaceCallback,
};

mod call;
mod collect;
mod plan_write;
mod result_limit;
mod serialize;

pub use super::servers::sub_agents::SUB_AGENT_COMMS_TOOL_FULL_NAMES;
pub use call::call_mcp_tool;
pub(crate) use collect::{
    builtin_scope_server_id, builtin_server_name, load_global_scope, load_project_scope,
    server_id_from_tool_name, with_database_path,
};
pub use collect::{collect_all_mcp_tools, collect_allowed_mcp_tools};
pub use serialize::{
    tools_as_anthropic_json, tools_as_gemini_json, tools_as_interactions_json,
    tools_as_openai_chat_json, tools_as_openai_responses_json,
};

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
pub struct McpToolStatus {
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

/// 项目 MCP 服务器工具发现的并发度：外部服务器并行连接发现，
/// 避免串行等待（与 external 模块的 DISCOVERY_CONCURRENCY 一致）。
const PROJECT_SERVER_DISCOVERY_CONCURRENCY: usize = 4;

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

pub async fn list_mcp_server_tools(config_server_id: String) -> napi::Result<Vec<McpToolStatus>> {
    let tools = super::external::discover_server_tools(None, &config_server_id, true).await?;
    let global_scope = load_global_scope().await?;
    Ok(to_tool_statuses(&tools, global_scope.as_ref()))
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

    // 外部服务器：并发发现已启用服务器的工具并随列表一并返回
    // （进程内 TTL 缓存，重复请求直接命中，无需前端逐个 IPC）。
    // 单个服务器发现失败只记录 error、工具留空，不影响其他服务器
    // 与整体列表——避免「一个服务器连不上，全部工具加载失败」。
    let discovered = stream::iter(
        super::external::discover_project_servers(&project_id)
            .await?
            .into_iter()
            .map(|external_server| {
                let project_id = project_id.clone();
                let scope = scope.clone();
                let scope_server_id =
                    super::external::project_scope_server_id(&external_server.config_server_id);
                let project_owned = external_server.source == "project";
                let enabled = external_server.enabled
                    && (project_owned || scope.is_server_enabled(&scope_server_id));
                let global_enabled = external_server.global_enabled;
                async move {
                    let (tools, error) = if enabled && global_enabled {
                        match super::external::discover_server_tools(
                            Some(&project_id),
                            &external_server.config_server_id,
                            false,
                        )
                        .await
                        {
                            Ok(found) => (to_project_tool_statuses(&found, &scope), None),
                            Err(discovery_error) => {
                                (Vec::new(), Some(discovery_error.reason.clone()))
                            }
                        }
                    } else {
                        (Vec::new(), None)
                    };
                    McpProjectServerStatus {
                        id: scope_server_id,
                        name: external_server.name,
                        source: external_server.source,
                        global_enabled,
                        enabled,
                        tools,
                        error,
                    }
                }
            }),
    )
    .buffered(PROJECT_SERVER_DISCOVERY_CONCURRENCY)
    .collect::<Vec<_>>()
    .await;
    servers.extend(discovered);

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
        super::external::discover_server_tools(Some(&project_id), external_server_id, false)
            .await?;
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
            let result = with_database_path(move |database_path| {
                crate::storage::services::project_mcp_server_configs::set_project_mcp_server_enabled(
                    &database_path,
                    &project_id,
                    &external_server_id,
                    enabled,
                )
            })
            .await;
            super::external::invalidate_discovery_cache();
            return result;
        }
    }

    let result = with_database_path(move |database_path| {
        crate::storage::services::system_settings::set_mcp_project_server_enabled(
            &database_path,
            &project_id,
            &server_id,
            enabled,
        )
    })
    .await;
    super::external::invalidate_discovery_cache();
    result
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

    let result = with_database_path(move |database_path| {
        crate::storage::services::system_settings::set_mcp_project_tool_enabled(
            &database_path,
            &project_id,
            &tool_name,
            enabled,
        )
    })
    .await;
    super::external::invalidate_discovery_cache();
    result
}

/// 全局启停单个工具：校验工具存在于全局可见的工具集（内置或全局外部服务器）。
pub async fn set_mcp_tool_enabled(tool_name: String, enabled: bool) -> napi::Result<()> {
    let tool_name = required_value(tool_name, "MCP tool name")?;
    ensure_global_tool_exists(&tool_name).await?;

    let result = with_database_path(move |database_path| {
        crate::storage::services::system_settings::set_mcp_global_tool_enabled(
            &database_path,
            &tool_name,
            enabled,
        )
    })
    .await;
    super::external::invalidate_discovery_cache();
    result
}

/// 全局批量启停工具：逐个校验存在性，全部通过后一次写入存储。
pub async fn set_mcp_tools_enabled(tool_names: Vec<String>, enabled: bool) -> napi::Result<()> {
    for tool_name in &tool_names {
        let tool_name = required_value(tool_name.clone(), "MCP tool name")?;
        ensure_global_tool_exists(&tool_name).await?;
    }

    let result = with_database_path(move |database_path| {
        crate::storage::services::system_settings::set_mcp_global_tools_enabled(
            &database_path,
            &tool_names,
            enabled,
        )
    })
    .await;
    super::external::invalidate_discovery_cache();
    result
}

/// 项目批量启停工具：逐个校验存在性（builtin/external 分支），全部通过后一次写入存储。
pub async fn set_mcp_project_tools_enabled(
    project_id: String,
    tool_names: Vec<String>,
    enabled: bool,
) -> napi::Result<()> {
    let project_id = required_value(project_id, "Project id")?;
    for tool_name in &tool_names {
        let tool_name = required_value(tool_name.clone(), "MCP tool name")?;
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
    }

    let result = with_database_path(move |database_path| {
        crate::storage::services::system_settings::set_mcp_project_tools_enabled(
            &database_path,
            &project_id,
            &tool_names,
            enabled,
        )
    })
    .await;
    super::external::invalidate_discovery_cache();
    result
}

/// 校验工具存在于全局可见的工具集（内置工具或已配置的全局外部服务器）中。
async fn ensure_global_tool_exists(tool_name: &str) -> Result<()> {
    if let Some(server_id) = server_id_from_tool_name(tool_name) {
        if get_builtin_servers_with_tools()
            .iter()
            .any(|(builtin_server_id, _)| builtin_server_id == server_id)
        {
            if get_builtin_tools()
                .iter()
                .any(|tool| tool.full_name() == tool_name)
            {
                return Ok(());
            }
        } else if super::external::resolve_project_scope_server(None, tool_name)
            .await?
            .is_some()
        {
            return Ok(());
        }
    }
    Err(Error::new(
        Status::InvalidArg,
        format!("Unknown MCP tool: {tool_name}"),
    ))
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

/// 工具状态转换：enabled 反映全局 scope 黑名单（默认全部启用）。
fn to_tool_statuses(
    tools: &[McpTool],
    global_scope: Option<&McpGlobalScopeSettings>,
) -> Vec<McpToolStatus> {
    tools
        .iter()
        .map(|tool| {
            let full_name = tool.full_name();
            McpToolStatus {
                enabled: !global_scope
                    .is_some_and(|scope| scope.disabled_tool_names.contains(&full_name)),
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
    // Windows 盘符与 UNC 路径属于 App Host（本机）路径，不能拼入 SSH
    // 工作区；直接走本机通道，由 Electron 在本机读取。
    if is_windows_absolute_path(path) {
        return Ok((args, false));
    }
    let remote_project_workspace = resolve_remote_project_workspace(project_id).await?;
    if is_ssh_path(path) {
        // ssh:// 路径必须属于当前项目 SSH 工作区，否则是跨区域操作，
        // 直接拦截，避免缺失 workspaceRoot 时 Electron 抛底层异常。
        let Some(workspace_path) = remote_project_workspace.as_deref() else {
            return Err(Error::new(
                Status::GenericFailure,
                format!(
                    "[BLOCKED] 跨区域操作被拒绝：{path_field}（{path}）是 SSH 工作区路径，但当前项目不是 SSH 工作区。工具只能访问当前项目工作区内的路径。"
                ),
            ));
        };
        if let (
            Some((workspace_authority, workspace_segments)),
            Some((candidate_authority, candidate_segments)),
        ) = (
            plan_write::normalize_ssh_path(workspace_path),
            plan_write::normalize_ssh_path(path),
        ) {
            if workspace_authority == candidate_authority
                && plan_write::remote_segments_start_with(&candidate_segments, &workspace_segments)
            {
                args["workspaceRoot"] = Value::String(workspace_path.to_string());
                return Ok((args, true));
            }
        }
        return Err(Error::new(
            Status::GenericFailure,
            format!(
                "[BLOCKED] 跨区域操作被拒绝：{path} 不属于当前项目的 SSH 工作区（{workspace_path}）。工具只能访问当前项目工作区内的路径。"
            ),
        ));
    }

    let Some(workspace_path) = remote_project_workspace else {
        return Ok((args, false));
    };
    args[path_field] = Value::String(resolve_remote_workspace_path(&workspace_path, path));
    args["workspaceRoot"] = Value::String(workspace_path);
    Ok((args, true))
}

fn remote_workspace_path_field(tool_full_name: &str) -> Option<&'static str> {
    match tool_full_name {
        "filesystem-read" | "filesystem-replace_edit" | "filesystem-create" => Some("filePath"),
        name if name.starts_with("codelens-") => Some("filePath"),
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

/// 将本地 filesystem / grep / codelens 工具的相对路径解析到当前项目根目录。
/// 当 AI 以 "."、"./src"、"src/main.ts" 等相对路径调用工具时，避免路径被
/// Rust 解析为 Electron 进程的工作目录（通常并非项目根目录）。grep 未提供 path
/// 时也应默认搜索项目根目录，而不是 Electron 进程目录。
/// 绝对路径、SSH 路径或无法解析出项目根目录时保持原样。
async fn resolve_local_workspace_args(
    tool_full_name: &str,
    mut args: Value,
    project_id: Option<&str>,
) -> napi::Result<Value> {
    let (path_field, default_to_workspace) = match tool_full_name {
        "grep-search" => ("path", true),
        name if name.starts_with("filesystem-") || name.starts_with("codelens-") => {
            ("filePath", false)
        }
        _ => return Ok(args),
    };

    let requested_path = args
        .get(path_field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|path| !path.is_empty());
    let Some(requested_path) = requested_path.or(default_to_workspace.then_some(".")) else {
        return Ok(args);
    };
    if is_ssh_path(requested_path) || Path::new(requested_path).is_absolute() {
        return Ok(args);
    }

    let Some(project_root) = resolve_local_project_root(project_id).await? else {
        return Ok(args);
    };
    let resolved = if requested_path == "." {
        project_root
    } else {
        Path::new(&project_root)
            .join(requested_path)
            .to_string_lossy()
            .to_string()
    };
    args[path_field] = Value::String(resolved);
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

#[derive(Clone, Copy)]
enum ToolCheckpointScope {
    None,
    File,
    Worktree,
    Unknown,
}

fn tool_checkpoint_scope(tool_full_name: &str) -> ToolCheckpointScope {
    match tool_full_name {
        "filesystem-replace_edit" | "filesystem-create" => ToolCheckpointScope::File,
        "bash-terminal-execute" => ToolCheckpointScope::Worktree,
        _ => {
            // 内置 server 其余工具不修改工作区；外部 MCP 影响范围未知。
            let builtin = split_tool_full_name(tool_full_name)
                .is_some_and(|(server_id, _)| BUILTIN_SERVER_IDS.contains(&server_id));
            if builtin {
                ToolCheckpointScope::None
            } else {
                ToolCheckpointScope::Unknown
            }
        }
    }
}

async fn acquire_tool_checkpoint_operation_guard(
    scope: ToolCheckpointScope,
    args: &Value,
    checkpoint_work_dir: Option<&str>,
) -> napi::Result<ToolCheckpointOperationGuard> {
    let Some(work_dir) = checkpoint_work_dir else {
        return Ok(ToolCheckpointOperationGuard::None);
    };

    match scope {
        ToolCheckpointScope::File => {
            let file_path = args
                .get("filePath")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    Error::new(
                        Status::InvalidArg,
                        "filePath is required for checkpoint operation locking".to_string(),
                    )
                })?;
            // 先等同文件锁，再进入目录共享锁：等待同文件的调用不会长期占住
            // 目录读锁，回滚可在两次文件编辑之间公平取得独占锁。
            let file_lock = crate::storage::services::checkpoint::checkpoint_file_operation_lock(
                work_dir, file_path,
            )?;
            let file_guard = file_lock.lock_owned().await;
            let work_dir_lock =
                crate::storage::services::checkpoint::checkpoint_operation_lock(work_dir)?;
            let work_dir_guard = work_dir_lock.read_owned().await;
            Ok(ToolCheckpointOperationGuard::File {
                _work_dir_guard: work_dir_guard,
                _file_guard: file_guard,
            })
        }
        ToolCheckpointScope::Worktree => {
            // bash 命令执行期间不持有执行级锁：跨会话命令并行运行，回滚/
            // 预览也不再被长时间运行的命令阻塞。变更捕获由 before/after
            // 扫描内部的短时共享读锁与回滚纪元（见 checkpoint 模块）保证
            // 不与回滚混淆。
            Ok(ToolCheckpointOperationGuard::None)
        }
        ToolCheckpointScope::Unknown => {
            // 外部 MCP 的影响范围未知：虽然无法生成可靠 checkpoint，仍按整树
            // 独占锁隔离，避免它与可捕获工具并行时污染后者的 before/after。
            let work_dir_lock =
                crate::storage::services::checkpoint::checkpoint_operation_lock(work_dir)?;
            let work_dir_guard = work_dir_lock.write_owned().await;
            Ok(ToolCheckpointOperationGuard::Exclusive {
                _work_dir_guard: work_dir_guard,
            })
        }
        ToolCheckpointScope::None => Ok(ToolCheckpointOperationGuard::None),
    }
}

fn require_checkpoint_work_dir(checkpoint_work_dir: Option<String>) -> napi::Result<String> {
    checkpoint_work_dir.ok_or_else(|| {
        Error::new(
            Status::InvalidArg,
            "Checkpoint working directory is required".to_string(),
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
    // 先定范围再校验 work_dir，Skill / 外部 MCP 不被前置阶段阻断。
    match tool_checkpoint_scope(tool_full_name) {
        ToolCheckpointScope::None | ToolCheckpointScope::Unknown => Ok(ToolCheckpointCapture::None),
        ToolCheckpointScope::File => {
            let work_dir = require_checkpoint_work_dir(checkpoint_work_dir)?;
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
        ToolCheckpointScope::Worktree => {
            // 软失败：快照失败降级为无回滚保护，不阻断命令。
            let locale = crate::i18n::app_locale_blocking();
            let Some(work_dir) = checkpoint_work_dir else {
                eprintln!(
                    "{}",
                    crate::i18n::fill(
                        locale.checkpoint_text(crate::i18n::CheckpointText::MissingWorkDir),
                        &[],
                    )
                );
                return Ok(ToolCheckpointCapture::Worktree(None));
            };
            match crate::storage::services::checkpoint::capture_checkpoint_worktree_before(
                checkpoint_ids,
                work_dir,
            ) {
                Ok(capture) => Ok(ToolCheckpointCapture::Worktree(capture)),
                Err(error) => {
                    eprintln!(
                        "{}",
                        crate::i18n::fill(
                            locale.checkpoint_text(crate::i18n::CheckpointText::BeforeFailed),
                            &[&error],
                        )
                    );
                    Ok(ToolCheckpointCapture::Worktree(None))
                }
            }
        }
    }
}

/// 远程 checkpoint 阶段软超时上限（毫秒），超时跳过快照/变更记录，
/// 避免工具调用卡死（快照仅用于回滚保护，跳过只损失回滚能力）。
const REMOTE_CHECKPOINT_TIMEOUT_MS: u64 = 30_000;

/// 远程（SSH）工具的 checkpoint before 捕获：文件 IO 经 Electron SFTP 完成，
/// 与本地版本行为一致（filesystem 工具记录单文件，bash 记录整个工作区）。
async fn capture_checkpoint_before_tool_remote(
    tool_full_name: &str,
    args: &Value,
    checkpoint_ids: Vec<String>,
    checkpoint_work_dir: Option<String>,
    on_remote_workspace_command: &RemoteWorkspaceCallback,
    on_chunk: &BashStreamCallback,
) -> napi::Result<ToolCheckpointCapture> {
    if checkpoint_ids.is_empty() {
        return Ok(ToolCheckpointCapture::None);
    }
    // 先定范围再校验 work_dir（与本地版本一致），Skill / 外部 MCP 不阻断。
    match tool_checkpoint_scope(tool_full_name) {
        ToolCheckpointScope::None | ToolCheckpointScope::Unknown => Ok(ToolCheckpointCapture::None),
        ToolCheckpointScope::File => {
            // 单文件回滚语义保持不变：记录失败按工具错误上抛。
            let work_dir = require_checkpoint_work_dir(checkpoint_work_dir)?;
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
            let client = RemoteCheckpointClient::new(on_remote_workspace_command);
            crate::storage::services::checkpoint::remote::record_checkpoint_file_remote(
                &client,
                checkpoint_ids.clone(),
                work_dir.clone(),
                file_path.clone(),
            )
            .await?;
            Ok(ToolCheckpointCapture::File {
                checkpoint_ids,
                work_dir,
                file_path,
            })
        }
        ToolCheckpointScope::Worktree => {
            // 跨项目时命令作用范围在会话项目之外，扫描会话项目无意义，
            // 降级并明确提示，不套用当前项目的 checkpoint。
            let locale = crate::i18n::app_locale().await;
            if let Some(work_dir) = checkpoint_work_dir.as_deref() {
                if let Some(reason) = remote_bash_checkpoint_skip_reason(args, work_dir) {
                    let reason_text = locale.checkpoint_skip_reason(&reason);
                    emit_stream_chunk(
                        on_chunk,
                        "stdout",
                        crate::i18n::fill(
                            locale
                                .checkpoint_text(crate::i18n::CheckpointText::SkipOutsideWorkspace),
                            &[&reason_text],
                        ),
                    );
                    return Ok(ToolCheckpointCapture::Worktree(None));
                }
            }
            let Some(work_dir) = checkpoint_work_dir else {
                emit_stream_chunk(
                    on_chunk,
                    "stdout",
                    crate::i18n::fill(
                        locale.checkpoint_text(crate::i18n::CheckpointText::MissingWorkDir),
                        &[],
                    ),
                );
                return Ok(ToolCheckpointCapture::Worktree(None));
            };
            // SFTP 遍历可能很慢：使用独立超时上限（不与命令 timeout 挂钩），
            // 超时/失败软失败降级，并通知 Electron 中止仍在进行的扫描。
            let scan_id = uuid::Uuid::new_v4().to_string();
            let client = RemoteCheckpointClient::with_scan_id(on_remote_workspace_command, scan_id);
            let started = Instant::now();
            emit_stream_chunk(
                on_chunk,
                "stdout",
                crate::i18n::fill(
                    locale.checkpoint_text(crate::i18n::CheckpointText::ScanStarted),
                    &[],
                ),
            );
            let captured = tokio::time::timeout(
                Duration::from_millis(REMOTE_CHECKPOINT_TIMEOUT_MS),
                crate::storage::services::checkpoint::remote::capture_checkpoint_worktree_before_remote(
                    &client,
                    checkpoint_ids,
                    work_dir,
                ),
            )
            .await;
            match captured {
                Ok(Ok(capture)) => {
                    emit_stream_chunk(
                        on_chunk,
                        "stdout",
                        crate::i18n::fill(
                            locale.checkpoint_text(crate::i18n::CheckpointText::ScanCompleted),
                            &[&started.elapsed().as_millis()],
                        ),
                    );
                    Ok(ToolCheckpointCapture::Worktree(capture))
                }
                Ok(Err(error)) => {
                    emit_stream_chunk(
                        on_chunk,
                        "stdout",
                        crate::i18n::fill(
                            locale.checkpoint_text(crate::i18n::CheckpointText::BeforeFailed),
                            &[&error],
                        ),
                    );
                    Ok(ToolCheckpointCapture::Worktree(None))
                }
                Err(_) => {
                    // 超时后真正取消 Electron/SFTP 侧仍在运行的扫描。
                    client.abort_scan().await;
                    emit_stream_chunk(
                        on_chunk,
                        "stdout",
                        crate::i18n::fill(
                            locale.checkpoint_text(crate::i18n::CheckpointText::BeforeTimeout),
                            &[&REMOTE_CHECKPOINT_TIMEOUT_MS],
                        ),
                    );
                    Ok(ToolCheckpointCapture::Worktree(None))
                }
            }
        }
    }
}

/// 远程（SSH）工具的 checkpoint after 捕获。`on_chunk` 可选：bash 分支的
/// 流式回调已被执行器按值占用，传 None 仅失去提示（超时保护仍生效）。
async fn capture_checkpoint_after_tool_remote(
    capture: ToolCheckpointCapture,
    on_remote_workspace_command: &RemoteWorkspaceCallback,
    on_chunk: Option<&BashStreamCallback>,
) -> napi::Result<()> {
    // 流式提示按界面语言本地化（bash 分支 on_chunk 被占用时走日志）。
    let locale = crate::i18n::app_locale().await;
    let warn = |message: String| {
        if let Some(chunk) = on_chunk {
            emit_stream_chunk(chunk, "stdout", message);
        } else {
            eprintln!("{message}");
        }
    };
    match capture {
        ToolCheckpointCapture::File {
            checkpoint_ids,
            work_dir,
            file_path,
        } => {
            // 单文件回滚语义保持不变：记录失败仍按工具错误上抛。
            let client = RemoteCheckpointClient::new(on_remote_workspace_command);
            crate::storage::services::checkpoint::remote::record_checkpoint_file_after_remote(
                &client,
                checkpoint_ids,
                work_dir,
                file_path,
            )
            .await
        }
        ToolCheckpointCapture::Worktree(Some(capture)) => {
            // 命令已结束：after 失败只意味着变更记录不完整，软失败降级，
            // 不能把已成功的命令结果覆盖为失败（避免模型重试）。
            let scan_id = uuid::Uuid::new_v4().to_string();
            let client = RemoteCheckpointClient::with_scan_id(on_remote_workspace_command, scan_id);
            let started = Instant::now();
            if on_chunk.is_some() {
                warn(crate::i18n::fill(
                    locale.checkpoint_text(crate::i18n::CheckpointText::AfterStarted),
                    &[],
                ));
            }
            let recorded = tokio::time::timeout(
                Duration::from_millis(REMOTE_CHECKPOINT_TIMEOUT_MS),
                crate::storage::services::checkpoint::remote::record_checkpoint_worktree_after_remote(
                    &client, capture,
                ),
            )
            .await;
            match recorded {
                Ok(Ok(())) => {
                    warn(crate::i18n::fill(
                        locale.checkpoint_text(crate::i18n::CheckpointText::AfterCompleted),
                        &[&started.elapsed().as_millis()],
                    ));
                    Ok(())
                }
                Ok(Err(error)) => {
                    warn(crate::i18n::fill(
                        locale.checkpoint_text(crate::i18n::CheckpointText::AfterFailed),
                        &[&error],
                    ));
                    Ok(())
                }
                Err(_) => {
                    // 超时后真正取消 Electron/SFTP 侧仍在运行的扫描。
                    client.abort_scan().await;
                    warn(crate::i18n::fill(
                        locale.checkpoint_text(crate::i18n::CheckpointText::AfterTimeout),
                        &[&REMOTE_CHECKPOINT_TIMEOUT_MS],
                    ));
                    Ok(())
                }
            }
        }
        ToolCheckpointCapture::None | ToolCheckpointCapture::Worktree(None) => Ok(()),
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
            // 软失败：after 记录失败只意味着回滚保护可能不完整，不能把
            // 已经成功的工具结果覆盖为失败（避免模型重试已执行的命令）。
            match crate::storage::services::checkpoint::record_checkpoint_worktree_after(capture) {
                Ok(()) => Ok(()),
                Err(error) => {
                    eprintln!(
                        "{}",
                        crate::i18n::fill(
                            crate::i18n::app_locale_blocking()
                                .checkpoint_text(crate::i18n::CheckpointText::AfterFailed),
                            &[&error],
                        )
                    );
                    Ok(())
                }
            }
        }
        ToolCheckpointCapture::None | ToolCheckpointCapture::Worktree(None) => Ok(()),
    }
}

/// 判断 bash 命令是否只读（可安全跳过 checkpoint 工作区快照）。
/// 保守策略：只有明确命中的只读模式才返回 true；命令链逐语句判定
/// （`cd /b && sed -n '1,200p' f` 读取项目外文件不需要当前项目保护）。
fn is_readonly_bash_command(command: &str) -> bool {
    let trimmed = command.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return true;
    }

    // 重定向到文件（> file / >> file）会修改工作区；排除 >/dev/null 与 >& 形式
    if has_file_redirect(trimmed) {
        return false;
    }

    // `set -euo pipefail; cmd`、`set -x && cmd`、`set -o pipefail\ncmd`
    // 这类 Shell 状态前缀本身不修改工作区文件（非交互 SSH exec 不写
    // history），剥离后继续按只读规则分析剩余命令——避免仅因包含 `set`
    // 或分号就触发全工作区 checkpoint 快照。
    if let Some(rest) = strip_shell_state_prefix(trimmed) {
        return is_readonly_bash_command(rest);
    }

    // 命令链：按语句分隔符拆分后逐条判定；无法可靠拆分时保守保留快照。
    if trimmed.contains([';', '&', '\n']) || trimmed.contains("||") {
        let Some(statements) = split_shell_statements(trimmed) else {
            return false;
        };
        return statements
            .iter()
            .all(|statement| is_readonly_single_statement(statement));
    }

    is_readonly_single_statement(trimmed)
}

/// 单条语句（不含语句分隔符）的只读判定。
fn is_readonly_single_statement(statement: &str) -> bool {
    let trimmed = statement.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return true;
    }
    if has_file_redirect(trimmed) {
        return false;
    }

    // 管道 / 命令替换 / 子 shell / 输入重定向无法静态判定读写性，保守保留。
    if trimmed.contains(['|', '`', '<', '(', '{', ';', '&', '\n']) {
        return false;
    }

    // curl -o/-O/--output、wget --output-file 等会把响应写入文件。
    if trimmed.contains(" -o") || trimmed.contains(" -O") || trimmed.contains("--output") {
        return false;
    }

    // sed 的严格纯打印形式（如 `sed -n '1,200p' file`）只输出不写文件。
    if is_readonly_sed_print(trimmed) {
        return true;
    }

    // 只读命令模式白名单。注意：sed/awk 未列入（sed -i / awk 重定向会写
    // 文件，仅上面的纯打印形式例外），node/python/curl/wget/git 写类子命令
    // 未列入；time/for/while/if/source 等控制流/包裹关键字未列入（可包裹
    // 任意命令，无法静态判定），均保守保留 checkpoint。
    const READONLY_PATTERNS: &[&str] = &[
        // 纯读命令（可带参数）
        "echo",
        "ls",
        "pwd",
        "grep",
        "rg",
        "cat",
        "head",
        "tail",
        "wc",
        "sort",
        "uniq",
        "find",
        "which",
        "type",
        "date",
        "printf",
        "dirname",
        "basename",
        "readlink",
        "realpath",
        "stat",
        "file",
        "tree",
        "du",
        "df",
        "nproc",
        "uname",
        "hostname",
        "ps",
        "top",
        "ping",
        "nslookup",
        "dig",
        "history",
        "jobs",
        "true",
        "false",
        "sleep",
        "test",
        "[",
        "exit",
        "cd",
        "export",
        "unset",
        "set",
        // git 只读子命令（写类子命令 add/commit/push/pull/checkout 等不在列）
        "git status",
        "git log",
        "git diff",
        "git branch",
        "git rev-parse",
        "git remote",
        "git show",
        "git ls-files",
        "git tag",
        "git blame",
        "git reflog",
        "git describe",
        "git shortlog",
        "git config --get",
        "git help",
        // 只读网络探测
        "curl -I",
        "curl -i",
        "curl -sI",
        "wget --spider",
    ];

    READONLY_PATTERNS.iter().any(|pattern| {
        let p = pattern.trim_end();
        trimmed == p
            || (trimmed.len() > p.len()
                && trimmed.starts_with(p)
                && trimmed.as_bytes()[p.len()].is_ascii_whitespace())
    })
}

/// 按 shell 词法拆分语句为 token（去引号、处理反斜杠转义）；引号不闭合
/// 返回 None，调用方保守处理。
fn tokenize_shell_tokens(statement: &str) -> Option<Vec<String>> {
    let mut tokens: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut has_current = false;
    let mut in_single = false;
    let mut in_double = false;
    let mut chars = statement.chars().peekable();
    while let Some(c) = chars.next() {
        if in_single {
            if c == '\'' {
                in_single = false;
            } else {
                current.push(c);
            }
            continue;
        }
        if in_double {
            match c {
                '\\' => {
                    // 双引号内仅 \" \\ \$ \` 保留转义语义，其余情况反斜杠
                    // 按字面保留（此处只需 token 文本，不做展开）。
                    match chars.peek() {
                        Some(&next @ ('"' | '\\' | '$' | '`')) => {
                            chars.next();
                            current.push(next);
                        }
                        _ => current.push('\\'),
                    }
                }
                '"' => in_double = false,
                _ => current.push(c),
            }
            continue;
        }
        match c {
            c if c.is_whitespace() => {
                if has_current {
                    tokens.push(std::mem::take(&mut current));
                    has_current = false;
                }
            }
            '\'' => {
                in_single = true;
                has_current = true;
            }
            '"' => {
                in_double = true;
                has_current = true;
            }
            '\\' => {
                if let Some(next) = chars.next() {
                    current.push(next);
                    has_current = true;
                }
            }
            _ => {
                current.push(c);
                has_current = true;
            }
        }
    }
    if in_single || in_double {
        return None;
    }
    if has_current {
        tokens.push(current);
    }
    Some(tokens)
}

/// 按语句分隔符（`;`、`&`、`&&`、`||`、换行）拆分 shell 命令，忽略引号内
/// 分隔符；管道 `|` 不拆分（属语句内部结构）。引号不闭合返回 None。
fn split_shell_statements(command: &str) -> Option<Vec<&str>> {
    let bytes = command.as_bytes();
    let mut statements: Vec<&str> = Vec::new();
    let mut start = 0usize;
    let mut i = 0usize;
    let mut in_single = false;
    let mut in_double = false;
    while i < bytes.len() {
        let c = bytes[i];
        if in_single {
            if c == b'\'' {
                in_single = false;
            }
            i += 1;
            continue;
        }
        if in_double {
            match c {
                b'\\' => i += 1, // 跳过被转义的字符
                b'"' => in_double = false,
                _ => {}
            }
            i += 1;
            continue;
        }
        match c {
            b'\'' => in_single = true,
            b'"' => in_double = true,
            b'\\' => i += 1, // 跳过被转义的字符（含转义的换行/分号）
            b';' | b'\n' => {
                statements.push(&command[start..i]);
                start = i + 1;
            }
            b'&' => {
                let sep_len = if bytes.get(i + 1) == Some(&b'&') {
                    2
                } else {
                    1
                };
                statements.push(&command[start..i]);
                start = i + sep_len;
                i += sep_len - 1;
            }
            b'|' if bytes.get(i + 1) == Some(&b'|') => {
                statements.push(&command[start..i]);
                start = i + 2;
                i += 1;
            }
            _ => {}
        }
        i += 1;
    }
    if in_single || in_double {
        return None;
    }
    statements.push(&command[start..]);
    Some(statements)
}

/// 严格识别 sed 的纯打印形式（如 `sed -n '1,200p' file`）：脚本仅允许
/// 数字/$ 行地址 + `p` 命令，禁止 -i（原地写）与 -f（脚本文件），其余
/// 形式（正则地址、w/e 命令等）保守保留 checkpoint。
fn is_readonly_sed_print(statement: &str) -> bool {
    let Some(tokens) = tokenize_shell_tokens(statement) else {
        return false;
    };
    let mut iter = tokens.iter().map(String::as_str);
    if iter.next() != Some("sed") {
        return false;
    }
    let mut scripts: Vec<&str> = Vec::new();
    let mut expect_script = false;
    for token in iter {
        if expect_script {
            scripts.push(token);
            expect_script = false;
            continue;
        }
        if let Some(long_flag) = token.strip_prefix("--") {
            // 仅放行与写行为无关的长选项；--in-place / --file 等一律保守。
            if long_flag == "silent" || long_flag == "quiet" || long_flag == "posix" {
                continue;
            }
            return false;
        }
        if let Some(flags) = token.strip_prefix('-') {
            if flags.is_empty() {
                return false;
            }
            // -i 原地写、-f 从文件读脚本（内容无法静态校验）→ 保守。
            if flags.contains('i') || flags.contains('f') {
                return false;
            }
            if flags.contains('e') {
                expect_script = true;
            }
            continue;
        }
        if scripts.is_empty() {
            // 无 -e 时第一个非选项参数即脚本，其余为输入文件（只读）。
            scripts.push(token);
        }
    }
    !scripts.is_empty()
        && scripts.iter().all(|script| {
            script
                .split(';')
                .all(|expression| is_line_address_print(expression))
        })
}

/// 行地址区间 + `p` 打印表达式：`p`、`1p`、`1,200p`、`1,$p` 等。
fn is_line_address_print(expression: &str) -> bool {
    let Some(address) = expression.trim().strip_suffix('p') else {
        return false;
    };
    let address = address.trim();
    if address.is_empty() {
        return true;
    }
    address.split(',').all(|part| {
        let part = part.trim();
        part == "$" || (!part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
    })
}

/// 判断远程 bash 命令是否应跳过当前会话项目的 checkpoint 扫描。
/// Some(原因) = 命令作用范围在会话项目之外（扫描会话项目无意义，
/// 不能把当前项目的 checkpoint 当作有效保护）；None = 保守保留扫描。
fn remote_bash_checkpoint_skip_reason(
    args: &Value,
    work_dir: &str,
) -> Option<crate::i18n::CheckpointSkipReason> {
    let Some((workspace_authority, workspace_segments)) = plan_write::normalize_ssh_path(work_dir)
    else {
        return None; // 工作区无法解析时保守保留扫描
    };

    // 1. workingDirectory（已解析为 ssh:// URI）不在会话项目工作区内。
    let mut cwd_segments = workspace_segments.clone();
    if let Some(working_directory) = args
        .get("workingDirectory")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if !is_ssh_path(working_directory) {
            return Some(crate::i18n::CheckpointSkipReason::NotSshWorkingDir {
                dir: working_directory.to_string(),
            });
        }
        let Some((authority, segments)) = plan_write::normalize_ssh_path(working_directory) else {
            return None; // 无法解析时保守保留扫描
        };
        if authority != workspace_authority
            || !plan_write::remote_segments_start_with(&segments, &workspace_segments)
        {
            return Some(crate::i18n::CheckpointSkipReason::WorkingDirOutside {
                dir: working_directory.to_string(),
            });
        }
        cwd_segments = segments;
    }

    // 2. 命令体：仅当能静态确认所有可能的写入都在工作区之外时跳过扫描。
    let command = args.get("command").and_then(Value::as_str)?;
    command_targets_outside_workspace(command, &cwd_segments, &workspace_segments)
        .then_some(crate::i18n::CheckpointSkipReason::WritesOutside)
}

/// 沿命令链追踪实际执行目录（cd 语句）与路径证据，判断是否所有可能的
/// 写入都在项目工作区之外；任何不确定情况返回 false（保守保留扫描）。
fn command_targets_outside_workspace(
    command: &str,
    initial_cwd: &[String],
    workspace_segments: &[String],
) -> bool {
    let Some(statements) = split_shell_statements(command) else {
        return false;
    };
    let mut cwd: Option<Vec<String>> = Some(initial_cwd.to_vec());
    let mut writes_inside_or_uncertain = false;
    let mut writes_outside = false;
    for raw_statement in statements {
        let statement = raw_statement.trim();
        if statement.is_empty() || statement.starts_with('#') {
            continue;
        }
        // cd 语句：更新 cwd；目标无法静态确定时记为不确定。
        if let Some(target) = pure_cd_target(statement) {
            cwd = match (cwd.take(), target) {
                (_, None) | (None, _) => None,
                (Some(base), Some(target)) => Some(resolve_cd_target(&base, &target)),
            };
            continue;
        }
        if is_shell_state_statement(statement) {
            continue;
        }
        if is_readonly_single_statement(statement) {
            continue;
        }

        // 可能写入的语句：按 cwd 位置与绝对路径证据判断写入位置。
        let cwd_inside_or_uncertain = match &cwd {
            None => true,
            Some(segments) => plan_write::remote_segments_start_with(segments, workspace_segments),
        };
        let Some(tokens) = tokenize_shell_tokens(statement) else {
            return false; // 无法解析 → 保守保留扫描
        };
        let mut absolute_inside = false;
        let mut absolute_outside = false;
        for token in &tokens {
            if token.starts_with('/') {
                let segments = resolve_cd_target(&[], token);
                if plan_write::remote_segments_start_with(&segments, workspace_segments) {
                    absolute_inside = true;
                } else {
                    absolute_outside = true;
                }
            }
        }
        if cwd_inside_or_uncertain || absolute_inside {
            writes_inside_or_uncertain = true;
        }
        if !cwd_inside_or_uncertain || absolute_outside {
            writes_outside = true;
        }
    }
    writes_outside && !writes_inside_or_uncertain
}

/// 识别纯 `cd` 语句的目标：外层 None = 非纯 cd；Some(None) = 目标无法
/// 静态确定；Some(Some(target)) = 字面目标路径。
fn pure_cd_target(statement: &str) -> Option<Option<String>> {
    let tokens = tokenize_shell_tokens(statement)?;
    let mut iter = tokens.iter().map(String::as_str);
    if iter.next() != Some("cd") {
        return None;
    }
    let mut target: Option<String> = None;
    for token in iter {
        if let Some(stripped) = token.strip_prefix('-') {
            // cd -P / -L 等选项；`cd -`（上一目录）同样无法静态确定。
            if stripped.is_empty() {
                return Some(None);
            }
            continue;
        }
        if target.is_some() {
            return None; // 多个位置参数 → 非纯 cd，按普通语句保守处理
        }
        target = Some(token.to_string());
    }
    Some(target.and_then(|value| {
        if value.contains(['~', '$', '`']) {
            None // 依赖运行时展开，无法静态确定
        } else {
            Some(value)
        }
    }))
}

/// 解析 cd 目标为目录段序列（词法归一化 `.` / `..`，不做 IO）。
fn resolve_cd_target(base: &[String], target: &str) -> Vec<String> {
    let mut segments = if target.starts_with('/') {
        Vec::new()
    } else {
        base.to_vec()
    };
    for segment in target.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                segments.pop();
            }
            value => segments.push(value.to_string()),
        }
    }
    segments
}

/// 判断语句是否为纯 shell 状态语句（set/export/unset 等，不写工作区）。
fn is_shell_state_statement(statement: &str) -> bool {
    let Some(tokens) = tokenize_shell_tokens(statement) else {
        return false;
    };
    matches!(
        tokens.first().map(String::as_str),
        Some("set" | "export" | "unset" | "readonly" | "shopt" | ":")
    )
}

/// 剥离 `set` 开头的 Shell 状态语句前缀（如 `set -euo pipefail; cmd`、
/// `set -x && cmd`、`set -o pipefail\ncmd`）。`set` 只修改 shell 选项与
/// 位置参数，不写工作区文件（非交互 SSH exec 不写 history），剥离后由
/// 调用方继续分析剩余命令。当第一个语句无法确认是纯 `set` 调用（含命令
/// 替换、子 shell、重定向等副作用构造）时返回 None，保守保留 checkpoint。
fn strip_shell_state_prefix(command: &str) -> Option<&str> {
    let rest = command.strip_prefix("set")?;
    // set 后必须是空白、-、+ 或直接结束；`setx ...` 等非 set 命令不剥离。
    match rest.chars().next() {
        None => return Some(""),
        Some(c) if c.is_whitespace() || c == '-' || c == '+' => {}
        Some(_) => return None,
    }

    let bytes = command.as_bytes();
    let mut i = "set".len();
    let mut in_single = false;
    let mut in_double = false;
    let mut suspicious = false;
    while i < bytes.len() {
        let c = bytes[i];
        if in_single {
            if c == b'\'' {
                in_single = false;
            }
            i += 1;
            continue;
        }
        if in_double {
            if c == b'\\' {
                i += 2; // 双引号内转义：跳过下一个字符
                continue;
            }
            if c == b'"' {
                in_double = false;
            } else if c == b'$' && bytes.get(i + 1) == Some(&b'(') {
                suspicious = true; // "$(cmd)" 在双引号内仍执行命令替换
            }
            i += 1;
            continue;
        }
        match c {
            b'\'' => in_single = true,
            b'"' => in_double = true,
            // 语句分隔符：`;`、换行、`&&`、`||`
            b';' | b'\n' => {
                return if suspicious {
                    None
                } else {
                    Some(command[i + 1..].trim_start())
                }
            }
            b'&' | b'|' if bytes.get(i + 1) == Some(&c) => {
                return if suspicious {
                    None
                } else {
                    Some(command[i + 2..].trim_start())
                }
            }
            // 命令替换 / 子 shell / 重定向等副作用构造 → 不剥离
            b'`' | b'(' | b'{' | b'<' | b'>' => suspicious = true,
            b'$' if bytes.get(i + 1) == Some(&b'(') => suspicious = true,
            _ => {}
        }
        i += 1;
    }
    // 无分隔符：整条命令就是 set 语句，交由白名单匹配。
    None
}

/// 检测命令字符串中的文件重定向（`>` / `>>`），排除 `>/dev/null` 与 `>&` / `2>&1`。
fn has_file_redirect(command: &str) -> bool {
    let bytes = command.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'>' {
            let mut j = i + 1;
            while j < bytes.len() && bytes[j] == b'>' {
                j += 1;
            }
            let after = command[j..].trim_start();
            if !after.starts_with("/dev/null") && !after.starts_with('&') {
                return true;
            }
            i = j;
        } else {
            i += 1;
        }
    }
    false
}
