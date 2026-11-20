use std::collections::HashMap;

use http::header::{HeaderName, HeaderValue};
use napi::{Error, Result};
use rmcp::model::ClientInfo;
use rmcp::service::{ClientLifecycleMode, ClientServiceExt, RunningService};
use rmcp::transport::auth::{AuthClient, AuthorizationManager, InMemoryStateStore};
use rmcp::transport::{
    streamable_http_client::StreamableHttpClientTransportConfig, StreamableHttpClientTransport,
};

use snow_storage_core::models::McpServerConfigRecord;

use crate::protocol::RemoteMcpTool;

pub(super) type HttpRunningClient = RunningService<rmcp::RoleClient, ClientInfo>;
pub(super) type HttpTransport =
    StreamableHttpClientTransport<AuthClient<rmcp_reqwest::Client>>;

/// 构建 HTTP 客户端。MCP 传输与 OAuth 端点共用应用代理（设置 → 代理与浏览器）
/// 与统一 User-Agent。
///
/// `follow_redirects` 为 false 时禁用重定向：MCP 请求不应被端点悄悄改写；
/// OAuth 端点常经 CDN 跳转，登录流程使用 true。
pub(super) async fn build_http_client(follow_redirects: bool) -> Result<rmcp_reqwest::Client> {
    let proxy_config = snow_net::http_client::load_proxy_config().await?;
    let mut builder = rmcp_reqwest::Client::builder()
        .user_agent(snow_net::http_client::app_user_agent())
        .pool_max_idle_per_host(0);
    if !follow_redirects {
        builder = builder.redirect(rmcp_reqwest::redirect::Policy::none());
    }

    if let Some(proxy_url) = proxy_config.proxy_url() {
        let proxy = rmcp_reqwest::Proxy::all(proxy_url)
            .map_err(|error| Error::from_reason(format!("Invalid proxy settings: {error}")))?
            .no_proxy(rmcp_reqwest::NoProxy::from_string(
                &proxy_config.no_proxy_list(),
            ));
        builder = builder.proxy(proxy);
    }

    builder.build().map_err(|error| {
        Error::from_reason(format!(
            "Failed to create external MCP HTTP client: {error}"
        ))
    })
}

fn build_transport(
    url: &str,
    custom_headers: HashMap<HeaderName, HeaderValue>,
    client: AuthClient<rmcp_reqwest::Client>,
) -> HttpTransport {
    let mut transport_config = StreamableHttpClientTransportConfig::with_uri(url);
    if !custom_headers.is_empty() {
        transport_config = transport_config.custom_headers(custom_headers);
    }
    StreamableHttpClientTransport::with_client(client, transport_config)
}

/// 构建带 OAuth 能力的传输层。
///
/// `AuthClient` 在没有凭据时以无认证方式发送请求（服务器的 401 会以
/// `AuthRequired` 暴露给调用方，前端据此引导授权）；存在凭据时自动附带
/// Bearer 令牌，令牌被拒绝时静默刷新并重试一次。
async fn build_oauth_transport(
    url: &str,
    custom_headers: HashMap<HeaderName, HeaderValue>,
) -> Result<HttpTransport> {
    let http_client = build_http_client(false).await?;
    let credential_store = super::oauth::FileCredentialStore::for_url(url)?;
    let mut manager = AuthorizationManager::new(url).await.map_err(|error| {
        Error::from_reason(format!(
            "Failed to prepare external MCP OAuth client: {error}"
        ))
    })?;
    manager.with_client(http_client.clone()).map_err(|error| {
        Error::from_reason(format!(
            "Failed to prepare external MCP OAuth client: {error}"
        ))
    })?;
    manager.set_credential_store(credential_store.clone());
    manager.set_state_store(InMemoryStateStore::new());
    if credential_store.has_credentials().await {
        // 元数据发现失败时退化为无认证连接，由服务器 401 驱动重新授权。
        let _ = manager.initialize_from_store().await;
    }

    Ok(build_transport(
        url,
        custom_headers,
        AuthClient::new(http_client, manager),
    ))
}


pub(super) struct HttpMcpClient {
    client: HttpRunningClient,
}

impl HttpMcpClient {
    pub(super) async fn connect(config: &McpServerConfigRecord) -> Result<Self> {
        let url = config.url.trim();
        if url.is_empty() {
            return Err(Error::from_reason(format!(
                "External MCP server {} has no URL",
                config.name
            )));
        }

        let memory_key = format!("http:{url}");
        if super::requires_legacy_handshake(&memory_key) {
            eprintln!(
                "[MCP] HTTP server {} is known to require the legacy initialize handshake, skipping server/discover probe",
                config.name
            );
            return Self::connect_legacy(config).await;
        }

        let custom_headers = parse_headers(&config.headers_json)?;

        // 优先尝试 2026-07-28 无状态协议。SDK 的 Auto 模式只对规范协商错误
        // （-32601 Method Not Found / -32022 Unsupported Protocol Version）
        // 自动降级或换版本重试；旧服务器若返回其他 JSON-RPC 错误（如 deepwiki
        // 的 -32600 "Unsupported protocol version"），需在下面用 legacy
        // initialize 握手手动重试一次。
        let auto_lifecycle = ClientLifecycleMode::Auto {
            preferred_versions: vec![rmcp::model::ProtocolVersion::V_2026_07_28],
            legacy_version: Some(rmcp::model::ProtocolVersion::V_2025_11_25),
        };

        let client_info = ClientInfo::default();

        let transport = build_oauth_transport(url, custom_headers).await?;

        // 旧 SDK 服务器（如 fastmcp 构建的 firecrawl-mcp）对带 `_meta` 的
        // `server/discover` 探测会静默不响应——既不返回 JSON-RPC 错误也不
        // 关闭连接，导致 Auto 协商无限挂起。加超时：超时视为服务器不支持
        // 2026-07-28 无状态协议，回退 legacy initialize 握手重连。取 3 秒
        // （issue #172）：正常探测往返远小于该值，超时即回退；响应慢的
        // 服务器可能被误判，但 legacy 握手仍可正常使用，且结果被记忆。
        const DISCOVER_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);
        let auto_result = tokio::time::timeout(
            DISCOVER_PROBE_TIMEOUT,
            client_info
                .clone()
                .serve_with_lifecycle(transport, auto_lifecycle),
        )
        .await;

        match auto_result {
            Ok(Ok(running)) => Ok(Self { client: running }),
            Ok(Err(error)) => {
                // 401 / 403：服务器要求 OAuth 授权。此时任何协议回退都没有
                // 意义，直接以稳定错误前缀上报，由界面引导浏览器授权。
                if let Some(auth_error) = super::oauth::auth_required_from_client_error(&error) {
                    return Err(auth_error);
                }
                if !super::should_retry_with_legacy_handshake(&error) {
                    return Err(Error::from_reason(format!(
                        "Failed to connect external MCP HTTP server {}: {error}",
                        config.name
                    )));
                }
                // 服务器不支持 server/discover（规范 JSON-RPC 错误 / discover
                // 阶段传输失败，如仅支持 2024-11-05 会话式的服务器对 discover
                // 探测回 HTTP 400 非 JSON-RPC 响应，issue #119）。记录回退
                // 原因便于诊断，再用 legacy initialize 握手重连。
                eprintln!(
                    "[MCP] HTTP server {} does not support server/discover ({error}), falling back to legacy initialize",
                    config.name
                );
                // 重建 transport 避免复用失败连接的状态,改用 legacy 握手重连。
                match Self::connect_legacy(config).await {
                    Ok(client) => {
                        super::remember_legacy_handshake(&memory_key);
                        Ok(client)
                    }
                    Err(error) => Err(super::oauth::normalize_error(error)),
                }
            }
            Err(_elapsed) => {
                // server/discover 探测超时：服务器静默不响应（如 fastmcp 构建的
                // firecrawl-mcp），回退 legacy 握手。
                match Self::connect_legacy(config).await {
                    Ok(client) => {
                        super::remember_legacy_handshake(&memory_key);
                        Ok(client)
                    }
                    Err(error) => Err(super::oauth::normalize_error(error)),
                }
            }
        }
    }

    /// 旧版本回退:直接以 legacy `initialize` 握手建立连接,跳过
    /// Auto 模式对 2026-07-28 无状态协议的 `server/discover` 探测。
    /// 当 Auto 协商降级后的连接不稳定(如旧 SDK 服务器调用时报
    /// Transport closed)时,用本方法重连可绕过协商探测路径。
    pub(super) async fn connect_legacy(config: &McpServerConfigRecord) -> Result<Self> {
        let url = config.url.trim();
        if url.is_empty() {
            return Err(Error::from_reason(format!(
                "External MCP server {} has no URL",
                config.name
            )));
        }

        let custom_headers = parse_headers(&config.headers_json)?;

        let transport = build_oauth_transport(url, custom_headers).await?;

        let client_info = ClientInfo::default();
        let running = client_info
            .serve_with_lifecycle(transport, ClientLifecycleMode::Initialize)
            .await
            .map_err(|error| {
                super::oauth::auth_required_from_client_error(&error).unwrap_or_else(|| {
                    Error::from_reason(format!(
                        "Failed to connect external MCP HTTP server {}: {error}",
                        config.name
                    ))
                })
            })?;

        Ok(Self { client: running })
    }

    pub(super) async fn list_all_tools(&self) -> Result<Vec<RemoteMcpTool>> {
        let tools = self.client.list_all_tools().await.map_err(|error| {
            Error::from_reason(format!("External MCP tools/list failed: {error}"))
        })?;
        Ok(tools.into_iter().map(rmcp_tool_to_remote).collect())
    }

    pub(super) async fn call_tool(
        &self,
        name: &str,
        arguments: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let params = rmcp::model::CallToolRequestParams::new(name.to_string());
        let params = if let Some(obj) = arguments.as_object() {
            params.with_arguments(obj.clone())
        } else {
            params
        };

        let result = self.client.call_tool(params).await.map_err(|error| {
            Error::from_reason(format!("External MCP tools/call failed: {error}"))
        })?;

        Ok(call_tool_result_to_value(result))
    }

    pub(super) async fn close(mut self) {
        let _ = self.client.close().await;
    }
}

fn rmcp_tool_to_remote(tool: rmcp::model::Tool) -> RemoteMcpTool {
    let name = tool.name.to_string();
    let description = tool.description.as_deref().unwrap_or_default().to_string();
    let input_schema = serde_json::to_value(tool.input_schema.as_ref())
        .unwrap_or_else(|_| serde_json::json!({ "type": "object", "properties": {} }));
    RemoteMcpTool {
        name,
        description,
        input_schema,
    }
}

fn call_tool_result_to_value(result: rmcp::model::CallToolResult) -> serde_json::Value {
    // Serialize the entire CallToolResult as JSON. This preserves content blocks,
    // is_error flag, and structured_content so callers can interpret it fully.
    serde_json::to_value(&result)
        .unwrap_or_else(|_| serde_json::json!({ "content": [], "isError": false }))
}

/// 解析配置里的自定义请求头 JSON（env/headers 编辑器写入的表单）。
pub(super) fn parse_headers(value: &str) -> Result<HashMap<HeaderName, HeaderValue>> {
    let headers: HashMap<String, String> = serde_json::from_str(value).map_err(|error| {
        Error::from_reason(format!("Invalid external MCP headers JSON: {error}"))
    })?;
    let mut result = HashMap::new();
    for (name, value) in headers {
        let name = name.parse::<HeaderName>().map_err(|error| {
            Error::from_reason(format!("Invalid external MCP header name: {error}"))
        })?;
        let value = HeaderValue::from_str(&value).map_err(|error| {
            Error::from_reason(format!("Invalid external MCP header value: {error}"))
        })?;
        result.insert(name, value);
    }
    Ok(result)
}
