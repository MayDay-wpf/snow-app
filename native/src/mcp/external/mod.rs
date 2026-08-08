mod http;
mod stdio;

use std::collections::{HashMap, HashSet};

use futures::{stream, StreamExt};

use napi::{Error, Result};
use serde_json::Value;

use crate::storage::services::system_settings::McpProjectScopeSettings;
use crate::storage::McpServerConfigRecord;

use super::protocol::RemoteMcpTool;
use super::tools::McpTool;

const DISCOVERY_CONCURRENCY: usize = 4;
const SERVER_NAME_MAX_LEN: usize = 18;
const TOOL_NAME_MAX_LEN: usize = 24;

/// 外部 MCP 服务器工具获取的默认超时（毫秒）：120 秒。
/// 服务器配置中显式设置了 timeout_ms（>0）时优先使用配置值。
const DEFAULT_DISCOVERY_TIMEOUT_MS: u64 = 120_000;

// Built-in MCP server names, used to exclude external tools with the same name.
// Kept in sync with `tools::BUILTIN_SERVER_IDS`.
const BUILTIN_SERVER_NAMES: &[&str] = super::tools::BUILTIN_SERVER_IDS;

pub struct ExternalMcpProjectServer {
    pub config_server_id: String,
    pub name: String,
    pub source: String,
    pub global_enabled: bool,
    pub enabled: bool,
}

pub struct ExternalMcpProjectToolServer {
    pub scope_server_id: String,
    pub project_owned: bool,
}

pub fn project_scope_server_id(config_server_id: &str) -> String {
    format!("external:{config_server_id}")
}

pub async fn discover_tools(
    project_id: Option<&str>,
    scope: Option<&McpProjectScopeSettings>,
) -> Result<Vec<McpTool>> {
    let configs = load_configs(project_id).await?;
    let server_names = public_server_names(&configs);
    let disabled_server_ids = scope
        .map(|settings| settings.disabled_server_ids.clone())
        .unwrap_or_default();
    let disabled_tool_names = scope
        .map(|settings| settings.disabled_tool_names.clone())
        .unwrap_or_default();
    let discoveries = stream::iter(
        configs
            .into_iter()
            .filter(|config| {
                config.enabled
                    && (config.source == "project"
                        || !disabled_server_ids
                            .contains(&project_scope_server_id(&config.server_id)))
            })
            .map(|config| {
                let server_name =
                    server_names
                        .get(&config.server_id)
                        .cloned()
                        .unwrap_or_else(|| {
                            sanitize_name(&config.name, SERVER_NAME_MAX_LEN, "external")
                        });
                async move { discover_config_tools(config, server_name).await }
            }),
    )
    .buffered(DISCOVERY_CONCURRENCY)
    .collect::<Vec<_>>()
    .await;

    let mut tools = Vec::new();
    let mut names = HashSet::new();
    for discovered in discoveries {
        match discovered {
            Ok(discovered_tools) => {
                for tool in discovered_tools {
                    let full_name = tool.full_name();
                    if !disabled_tool_names.contains(&full_name) && names.insert(full_name) {
                        tools.push(tool);
                    }
                }
            }
            Err(error) => eprintln!("Failed to discover an external MCP server: {error}"),
        }
    }

    Ok(tools)
}

pub async fn discover_project_servers(project_id: &str) -> Result<Vec<ExternalMcpProjectServer>> {
    let configs = load_configs(Some(project_id)).await?;
    Ok(configs
        .into_iter()
        .map(|config| {
            let is_project_server = config.source == "project";
            ExternalMcpProjectServer {
                config_server_id: config.server_id,
                name: config.name,
                source: if is_project_server {
                    "project".to_string()
                } else {
                    "external".to_string()
                },
                global_enabled: is_project_server || config.enabled,
                enabled: config.enabled,
            }
        })
        .collect())
}

pub async fn discover_server_tools(
    project_id: Option<&str>,
    config_server_id: &str,
) -> Result<Vec<McpTool>> {
    let configs = load_configs(project_id).await?;
    let server_names = public_server_names(&configs);
    let config = configs
        .into_iter()
        .find(|config| config.server_id == config_server_id)
        .ok_or_else(|| {
            Error::from_reason(format!(
                "External MCP server {config_server_id} is no longer configured"
            ))
        })?;
    let server_name = server_names
        .get(config_server_id)
        .cloned()
        .unwrap_or_else(|| sanitize_name(&config.name, SERVER_NAME_MAX_LEN, "external"));

    discover_config_tools(config, server_name).await
}

pub async fn resolve_project_scope_server(
    project_id: Option<&str>,
    tool_full_name: &str,
) -> Result<Option<ExternalMcpProjectToolServer>> {
    let Some((server_name, public_tool_name)) = parse_external_tool_name(tool_full_name) else {
        return Ok(None);
    };
    let configs = load_configs(project_id).await?;
    let server_names = public_server_names(&configs);
    let Some(config) = configs.into_iter().find(|config| {
        server_names.get(&config.server_id).map(String::as_str) == Some(server_name)
    }) else {
        return Ok(None);
    };
    if !config.enabled {
        return Err(Error::from_reason(format!(
            "External MCP server for tool {tool_full_name} is disabled or no longer configured"
        )));
    }

    let project_server = ExternalMcpProjectToolServer {
        scope_server_id: project_scope_server_id(&config.server_id),
        project_owned: config.source == "project",
    };
    let client = ExternalMcpClient::connect(&config).await?;
    let tools_result = client.list_all_tools().await;
    client.close().await;
    let tools = tools_result?;
    let tool_names = public_tool_names(&tools);
    let tool_exists = tools
        .iter()
        .any(|tool| tool_names.get(&tool.name).map(String::as_str) == Some(public_tool_name));
    if !tool_exists {
        return Err(Error::from_reason(format!(
            "External MCP tool {tool_full_name} is no longer available"
        )));
    }

    Ok(Some(project_server))
}

pub async fn call_tool(
    project_id: Option<&str>,
    tool_full_name: &str,
    arguments: &Value,
) -> Result<Option<Value>> {
    let Some((server_name, public_tool_name)) = parse_external_tool_name(tool_full_name) else {
        return Ok(None);
    };

    let configs = load_configs(project_id).await?;
    let server_names = public_server_names(&configs);
    let Some(config) = configs.into_iter().find(|config| {
        server_names.get(&config.server_id).map(String::as_str) == Some(server_name)
    }) else {
        return Ok(None);
    };
    if !config.enabled {
        return Err(Error::from_reason(format!(
            "External MCP server for tool {tool_full_name} is disabled or no longer configured"
        )));
    }

    let client = ExternalMcpClient::connect(&config).await?;
    let result = call_tool_with_client(&client, &public_tool_name, arguments).await;
    client.close().await;

    match result {
        Ok(result) => Ok(Some(result)),
        // 旧版本回退：Auto 协商降级后的连接可能在调用时被关闭
        // （Transport closed，如 issue #51 的 mysql-mcp-server 场景）。
        // 按 http 的 legacy 回退做法，重建连接（Initialize 握手）
        // 并重试一次；重试失败时保留原始错误（含 Transport closed
        // 诊断信息），避免掩盖根因。
        Err(error) if is_transport_closed(&error) => {
            let retry_client = ExternalMcpClient::connect_legacy(&config).await?;
            let retry = call_tool_with_client(&retry_client, &public_tool_name, arguments).await;
            retry_client.close().await;
            retry.map(Some).or_else(|_| Err(error))
        }
        Err(error) => Err(error),
    }
}

/// 在已连接的客户端上解析工具名并调用，返回服务器原始结果。
async fn call_tool_with_client(
    client: &ExternalMcpClient,
    public_tool_name: &str,
    arguments: &Value,
) -> Result<Value> {
    let tools = client.list_all_tools().await?;
    let tool_names = public_tool_names(&tools);
    let remote_tool = tools
        .into_iter()
        .find(|tool| tool_names.get(&tool.name).map(String::as_str) == Some(public_tool_name))
        .ok_or_else(|| {
            Error::from_reason(format!(
                "External MCP tool {public_tool_name} is no longer available"
            ))
        })?;
    client.call_tool(&remote_tool.name, arguments).await
}

/// 判断错误是否为 MCP 传输层关闭（Transport closed）。
/// 传输关闭意味着子进程已退出或管道已断开，重建连接重试有机会恢复；
/// 其他协议/业务错误重试无意义，应直接返回。
fn is_transport_closed(error: &napi::Error) -> bool {
    error.reason.contains("Transport closed")
}

async fn discover_config_tools(
    config: McpServerConfigRecord,
    server_name: String,
) -> Result<Vec<McpTool>> {
    let timeout_ms = config
        .timeout_ms
        .filter(|value| *value > 0)
        .map(|value| value as u64)
        .unwrap_or(DEFAULT_DISCOVERY_TIMEOUT_MS);
    // 连接与工具列表共享同一个截止时间，保证整个获取流程有总预算；
    // 超时后仍显式 close，避免 stdio 子进程 / HTTP 连接残留。
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
    let server_label = config.name.clone();

    let client = match tokio::time::timeout_at(deadline, ExternalMcpClient::connect(&config)).await
    {
        Ok(client) => client?,
        Err(_) => {
            return Err(Error::from_reason(format!(
                "External MCP server {server_label} timed out after {timeout_ms}ms while connecting"
            )))
        }
    };

    let result = tokio::time::timeout_at(deadline, client.list_all_tools()).await;
    client.close().await;

    let tools = match result {
        Ok(tools) => tools?,
        Err(_) => {
            return Err(Error::from_reason(format!(
            "External MCP server {server_label} timed out after {timeout_ms}ms while listing tools"
        )))
        }
    };

    let tool_names = public_tool_names(&tools);
    Ok(tools
        .into_iter()
        .map(|tool| {
            let tool_name = tool_names
                .get(&tool.name)
                .cloned()
                .unwrap_or_else(|| sanitize_name(&tool.name, TOOL_NAME_MAX_LEN, "tool"));
            to_public_tool(&config, &server_name, tool_name, tool)
        })
        .collect())
}

fn to_public_tool(
    config: &McpServerConfigRecord,
    server_name: &str,
    tool_name: String,
    tool: RemoteMcpTool,
) -> McpTool {
    let description = if tool.description.trim().is_empty() {
        format!("External MCP tool provided by {}", config.name)
    } else {
        format!("[External MCP: {}] {}", config.name, tool.description)
    };

    McpTool {
        server_id: server_name.to_string(),
        name: tool_name,
        description,
        input_schema: tool.input_schema,
    }
}

async fn load_configs(project_id: Option<&str>) -> Result<Vec<McpServerConfigRecord>> {
    let project_id = project_id.map(str::to_string);
    tokio::task::spawn_blocking(move || {
        let storage_info = crate::storage::initialize_app_storage()?;
        let database_path = std::path::PathBuf::from(storage_info.database_path);
        crate::storage::services::project_mcp_server_configs::list_effective_mcp_server_configs(
            &database_path,
            project_id.as_deref(),
        )
    })
    .await
    .map_err(|error| {
        Error::from_reason(format!(
            "Failed to load external MCP server configs: {error}"
        ))
    })?
}

fn parse_external_tool_name(full_name: &str) -> Option<(&str, &str)> {
    let (server_name, tool_name) = super::tools::split_tool_full_name(full_name)?;
    if server_name.is_empty() || tool_name.is_empty() || BUILTIN_SERVER_NAMES.contains(&server_name)
    {
        return None;
    }
    Some((server_name, tool_name))
}

fn public_server_names(configs: &[McpServerConfigRecord]) -> HashMap<String, String> {
    let candidates = configs
        .iter()
        .map(|config| {
            (
                config.server_id.clone(),
                sanitize_name(&config.name, SERVER_NAME_MAX_LEN, "external"),
            )
        })
        .collect::<Vec<_>>();
    assign_unique_names(candidates, BUILTIN_SERVER_NAMES)
}

/// 返回全部 MCP 服务器配置的公开名映射（server_id -> public_name），
/// 已处理 sanitize 冲突与内置名保留，与 `discover_tools` 的命名一致。
/// 供 config 服务器静态校验子代理 toolsJson 中的外部工具名前缀
/// （不实际连接服务器，因此只校验服务器归属与启用状态）。
pub(crate) fn public_server_name_map(configs: &[McpServerConfigRecord]) -> HashMap<String, String> {
    public_server_names(configs)
}

fn public_tool_names(tools: &[RemoteMcpTool]) -> HashMap<String, String> {
    let candidates = tools
        .iter()
        .map(|tool| {
            (
                tool.name.clone(),
                sanitize_name(&tool.name, TOOL_NAME_MAX_LEN, "tool"),
            )
        })
        .collect::<Vec<_>>();
    assign_unique_names(candidates, &[])
}

fn assign_unique_names(
    candidates: Vec<(String, String)>,
    reserved_names: &[&str],
) -> HashMap<String, String> {
    let mut base_name_counts = HashMap::<String, usize>::new();
    for (_, base_name) in &candidates {
        *base_name_counts.entry(base_name.clone()).or_default() += 1;
    }

    let mut used_names = reserved_names
        .iter()
        .map(|name| (*name).to_string())
        .collect::<HashSet<_>>();
    let mut assigned_names = HashMap::new();
    for (identity, base_name) in candidates {
        let is_conflicting = base_name_counts
            .get(&base_name)
            .copied()
            .unwrap_or_default()
            > 1
            || used_names.contains(&base_name);
        let mut public_name = if is_conflicting {
            format!("{base_name}_{}", short_hash(&identity))
        } else {
            base_name.clone()
        };
        let mut suffix = 2;
        while used_names.contains(&public_name) {
            public_name = format!("{base_name}_{}_{suffix}", short_hash(&identity));
            suffix += 1;
        }
        used_names.insert(public_name.clone());
        assigned_names.insert(identity, public_name);
    }
    assigned_names
}

fn sanitize_name(value: &str, max_len: usize, fallback: &str) -> String {
    let mut result = String::new();
    let mut previous_underscore = false;
    for character in value.chars() {
        let normalized = if character.is_ascii_alphanumeric() {
            character.to_ascii_lowercase()
        } else {
            '_'
        };
        if normalized == '_' && previous_underscore {
            continue;
        }
        result.push(normalized);
        previous_underscore = normalized == '_';
        if result.len() >= max_len {
            break;
        }
    }

    let trimmed = result.trim_matches('_');
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

fn short_hash(value: &str) -> String {
    blake3::hash(value.as_bytes()).to_hex()[..6].to_string()
}

/// Trait abstracting the operations all transport-specific MCP clients must
/// provide. Implemented by both `StdioMcpClient` and `HttpMcpClient`.
pub(super) trait ClientHandle: Send + Sync {
    fn list_all_tools(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Vec<RemoteMcpTool>>> + Send + '_>>;
    fn call_tool<'a>(
        &'a self,
        name: &'a str,
        arguments: &'a Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value>> + Send + 'a>>;
    fn close(self: Box<Self>);
}

/// Adapter so `StdioMcpClient` / `HttpMcpClient` (which own a
/// `RunningService`) can be stored behind a single `Box<dyn ClientHandle>`.
macro_rules! impl_client_handle {
    ($ty:ty) => {
        impl ClientHandle for $ty {
            fn list_all_tools(
                &self,
            ) -> std::pin::Pin<
                Box<dyn std::future::Future<Output = Result<Vec<RemoteMcpTool>>> + Send + '_>,
            > {
                Box::pin(<$ty>::list_all_tools(self))
            }

            fn call_tool<'a>(
                &'a self,
                name: &'a str,
                arguments: &'a Value,
            ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value>> + Send + 'a>>
            {
                Box::pin(<$ty>::call_tool(self, name, arguments))
            }

            fn close(self: Box<Self>) {
                // We need to consume `self` inside an async context. Spawn a
                // detached task so the child process / HTTP connection is
                // gracefully shut down without blocking the caller.
                tokio::spawn(async move {
                    let inner = *self;
                    inner.close().await;
                });
            }
        }
    };
}

impl_client_handle!(stdio::StdioMcpClient);
impl_client_handle!(http::HttpMcpClient);

/// Returns true when an `Auto`-mode negotiation failed in a way that a retry
/// with the legacy `initialize` handshake is worthwhile:
/// - JSON-RPC errors the rmcp SDK could not negotiate around on its own
///   (anything other than -32601 Method Not Found / -32022 Unsupported
///   Protocol Version, which the SDK already handles internally by falling
///   back or retrying versions). Legacy servers such as deepwiki reply
///   -32600 "Unsupported protocol version" here.
/// - A connection closed during the `discover` phase. Legacy servers built
///   with pre-2026 SDKs (e.g. DBX 0.4.51) exit the process on `discover`
///   instead of replying with a JSON-RPC error, so a closed connection is a
///   strong signal that the server only understands the legacy handshake.
pub(super) fn should_retry_with_legacy_handshake(
    error: &rmcp::service::ClientInitializeError,
) -> bool {
    match error {
        rmcp::service::ClientInitializeError::JsonRpcError(error_data) => {
            error_data.code != rmcp::model::ErrorCode::METHOD_NOT_FOUND
                && error_data.code != rmcp::model::ErrorCode::UNSUPPORTED_PROTOCOL_VERSION
        }
        rmcp::service::ClientInitializeError::ConnectionClosed(_) => true,
        _ => false,
    }
}

/// A transport-agnostic external MCP client. The underlying connection is
/// managed by the rmcp SDK and automatically negotiated using the
/// `ClientLifecycleMode::Auto` strategy, which prefers the 2026-07-28
/// stateless protocol and falls back to the legacy initialize handshake when
/// the remote server does not support `server/discover`.
pub(super) struct ExternalMcpClient {
    inner: Box<dyn ClientHandle>,
}

impl ExternalMcpClient {
    pub(super) async fn connect(config: &McpServerConfigRecord) -> Result<Self> {
        let inner: Box<dyn ClientHandle> = match config.transport_type.as_str() {
            "stdio" | "local" => {
                let client = stdio::StdioMcpClient::connect(config).await?;
                Box::new(client)
            }
            "http" => {
                let client = http::HttpMcpClient::connect(config).await?;
                Box::new(client)
            }
            transport => {
                return Err(Error::from_reason(format!(
                    "Unsupported external MCP transport: {transport}"
                )))
            }
        };
        Ok(Self { inner })
    }

    /// 旧版本回退：直接以 legacy `initialize` 握手建立连接，跳过
    /// Auto 模式对 2026-07-28 无状态协议的 `server/discover` 探测。
    /// 当 Auto 协商降级后的连接不稳定（如旧 SDK 服务器调用时报
    /// Transport closed）时，用本方法重连可绕过协商探测路径。
    pub(super) async fn connect_legacy(config: &McpServerConfigRecord) -> Result<Self> {
        let inner: Box<dyn ClientHandle> = match config.transport_type.as_str() {
            "stdio" | "local" => {
                let client = stdio::StdioMcpClient::connect_legacy(config).await?;
                Box::new(client)
            }
            "http" => {
                let client = http::HttpMcpClient::connect_legacy(config).await?;
                Box::new(client)
            }
            transport => {
                return Err(Error::from_reason(format!(
                    "Unsupported external MCP transport: {transport}"
                )))
            }
        };
        Ok(Self { inner })
    }

    pub(super) async fn list_all_tools(&self) -> Result<Vec<RemoteMcpTool>> {
        self.inner.list_all_tools().await
    }

    pub(super) async fn call_tool(&self, name: &str, arguments: &Value) -> Result<Value> {
        self.inner.call_tool(name, arguments).await
    }

    pub(super) async fn close(self) {
        self.inner.close();
    }
}
