//! 外部 MCP 服务器的 OAuth 2.1 授权支持。
//!
//! 远程 MCP 服务器按 MCP 授权规范在未授权时返回 401 与 `WWW-Authenticate`
//! 挑战，客户端需要完成：受保护资源元数据发现 → 客户端身份（Client ID
//! Metadata Document 优先，动态客户端注册兜底）→ PKCE 授权码流程 → 令牌
//! 交换，之后每条 MCP 请求都带 Bearer 令牌。这里基于 rmcp 的
//! `AuthorizationManager` 实现登录会话（浏览器回调 + 会话状态轮询）
//! 与凭据持久化，连接层用 `AuthClient` 自动附加并刷新令牌。

use std::collections::HashMap;
use std::error::Error as StdError;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use async_trait::async_trait;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use rmcp::transport::auth::{
    AuthError, AuthorizationManager, AuthorizationRequest, AuthorizationSession, CredentialStore,
    InMemoryStateStore, StoredCredentials,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;

use snow_storage_core::models::McpServerConfigRecord;

/// 需要 OAuth 授权的稳定错误前缀：列表项据此显示授权入口，界面据此映射文案。
const AUTH_REQUIRED_PREFIX: &str = "mcp:auth_required";

/// 浏览器授权等待上限；超时后会话自动取消，避免监听端口长期残留。
const LOGIN_TIMEOUT_SECS: u64 = 300;

/// 回调请求读取上限，超过视为非法请求。
const MAX_CALLBACK_REQUEST_BYTES: usize = 16 * 1024;

/// Client ID Metadata Document（SEP-991）地址。文档随仓库发布在
/// `resources/mcp-oauth/client-metadata.json`，授权服务器会按 URL 抓取它，
/// 并把 URL 本身当作 client_id；没有 registration_endpoint 的授权服务器
/// （如 ElevenLabs）只能走这条路径完成客户端识别。
///
/// 必须用 jsDelivr 而不是 raw.githubusercontent.com：后者的响应是
/// `text/plain`，授权服务器会以「must be served as JSON」拒绝。文档内容变更后
/// 需访问 `https://purge.jsdelivr.net/gh/MayDay-wpf/snow-app@main/...` 清缓存。
const CLIENT_METADATA_URL: &str =
    "https://cdn.jsdelivr.net/gh/MayDay-wpf/snow-app@main/resources/mcp-oauth/client-metadata.json";

/// 使用 CIMD 时的固定回调端口。文档里的 `redirect_uris` 是静态枚举，无法
/// 表达系统分配的随机端口，只能在这组端口里逐个尝试；修改这里必须同步
/// `resources/mcp-oauth/client-metadata.json` 的 `redirect_uris`。
const CIMD_CALLBACK_PORTS: [u16; 4] = [45871, 45872, 45873, 45874];

/// 登录会话状态。
#[derive(Clone, Copy, PartialEq, Eq)]
enum SessionStatus {
    Pending,
    Success,
    Error,
    Cancelled,
}

impl SessionStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Success => "success",
            Self::Error => "error",
            Self::Cancelled => "cancelled",
        }
    }
}

/// 授权登录的启动结果：前端负责在系统浏览器打开 `auth_url`。
#[napi(object)]
pub struct McpOAuthStart {
    pub session_id: String,
    pub auth_url: String,
}

/// 授权登录会话状态快照。
#[napi(object)]
pub struct McpOAuthStatus {
    pub status: String,
    pub error: Option<String>,
}

struct OAuthSessionEntry {
    config_server_id: String,
    status: SessionStatus,
    error: Option<String>,
    shutdown: Option<oneshot::Sender<()>>,
}

type SharedEntry = std::sync::Arc<Mutex<OAuthSessionEntry>>;

static SESSIONS: OnceLock<Mutex<HashMap<String, SharedEntry>>> = OnceLock::new();

fn sessions() -> &'static Mutex<HashMap<String, SharedEntry>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock_sessions() -> std::sync::MutexGuard<'static, HashMap<String, SharedEntry>> {
    sessions()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn lock_entry(entry: &SharedEntry) -> std::sync::MutexGuard<'_, OAuthSessionEntry> {
    entry
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 判定错误文本是否表示「服务器要求 OAuth 授权」。
pub(super) fn is_auth_required_message(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    message.starts_with(AUTH_REQUIRED_PREFIX)
        || lower.contains("authorization required")
        || lower.contains("auth required")
        || lower.contains("insufficient scope")
        || lower.contains("unauthorized")
}

/// 构造带稳定前缀的需授权错误。
pub(super) fn auth_required_error(detail: &str) -> Error {
    let detail = detail.trim();
    if detail.is_empty() || detail.starts_with(AUTH_REQUIRED_PREFIX) {
        Error::from_reason(AUTH_REQUIRED_PREFIX)
    } else {
        Error::from_reason(format!("{AUTH_REQUIRED_PREFIX}: {detail}"))
    }
}

/// 把任意外部 MCP 错误归一：需授权时统一成稳定前缀，供界面识别。
pub(super) fn normalize_error(error: Error) -> Error {
    if error.reason.starts_with(AUTH_REQUIRED_PREFIX) {
        return error;
    }
    if is_auth_required_message(&error.reason) {
        auth_required_error(&error.reason)
    } else {
        error
    }
}

/// 从 rmcp 客户端初始化错误链中识别 401 / 403，并保留挑战文本。
pub(super) fn auth_required_from_client_error(
    error: &rmcp::service::ClientInitializeError,
) -> Option<Error> {
    let mut source: Option<&(dyn StdError + 'static)> = Some(error);
    while let Some(current) = source {
        if is_auth_required_message(&current.to_string()) {
            return Some(auth_required_error(&current.to_string()));
        }
        source = StdError::source(current);
    }
    None
}

/// 按服务器 URL 派生的凭据文件（同一地址的全局 / 项目配置共享登录态）。
fn credential_file_path(url: &str) -> Result<PathBuf> {
    let directory = snow_support::app_paths::app_storage_dir()?.join("mcp-oauth");
    let hash = blake3::hash(url.trim().as_bytes()).to_hex();
    Ok(directory.join(format!("{}.json", &hash[..32])))
}

/// 文件持久化的 OAuth 凭据（令牌 + 注册得到的 client_id）。
#[derive(Clone)]
pub(super) struct FileCredentialStore {
    path: PathBuf,
}

impl FileCredentialStore {
    pub(super) fn for_url(url: &str) -> Result<Self> {
        Ok(Self {
            path: credential_file_path(url)?,
        })
    }

    /// 是否已存在凭据文件；只有存在时才在连接阶段做元数据发现。
    pub(super) async fn has_credentials(&self) -> bool {
        tokio::fs::metadata(&self.path).await.is_ok()
    }
}

#[async_trait]
impl CredentialStore for FileCredentialStore {
    async fn load(&self) -> std::result::Result<Option<StoredCredentials>, AuthError> {
        match tokio::fs::read(&self.path).await {
            Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(|error| {
                AuthError::InternalError(format!("Failed to parse stored MCP OAuth credentials: {error}"))
            }),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(AuthError::InternalError(format!(
                "Failed to read stored MCP OAuth credentials: {error}"
            ))),
        }
    }

    async fn save(&self, credentials: StoredCredentials) -> std::result::Result<(), AuthError> {
        if let Some(parent) = self.path.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|error| {
                AuthError::InternalError(format!(
                    "Failed to create MCP OAuth credential directory: {error}"
                ))
            })?;
        }
        let bytes = serde_json::to_vec(&credentials).map_err(|error| {
            AuthError::InternalError(format!("Failed to encode MCP OAuth credentials: {error}"))
        })?;
        tokio::fs::write(&self.path, bytes).await.map_err(|error| {
            AuthError::InternalError(format!("Failed to write MCP OAuth credentials: {error}"))
        })
    }

    async fn clear(&self) -> std::result::Result<(), AuthError> {
        match tokio::fs::remove_file(&self.path).await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(AuthError::InternalError(format!(
                "Failed to remove MCP OAuth credentials: {error}"
            ))),
        }
    }
}

fn session_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let hash = blake3::hash(format!("{nanos}:{}", std::process::id()).as_bytes()).to_hex();
    hash[..24].to_string()
}

async fn load_server_config(
    project_id: Option<&str>,
    config_server_id: &str,
) -> Result<McpServerConfigRecord> {
    let configs = super::load_configs(project_id).await?;
    configs
        .into_iter()
        .find(|config| config.server_id == config_server_id)
        .ok_or_else(|| {
            Error::from_reason(format!(
                "External MCP server {config_server_id} is no longer configured"
            ))
        })
}

/// 探测 MCP 端点的 401 挑战：优先用 `resource_metadata` 指针做元数据发现。
async fn probe_auth_challenge(
    client: &rmcp_reqwest::Client,
    url: &str,
    headers: &HashMap<http::HeaderName, http::HeaderValue>,
) -> Option<String> {
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-11-25",
            "capabilities": {},
            "clientInfo": {
                "name": "Snow App",
                "version": env!("CARGO_PKG_VERSION"),
            },
        },
    });
    let mut request = client
        .post(url)
        .header(http::header::ACCEPT, "application/json, text/event-stream")
        .header(http::header::CONTENT_TYPE, "application/json")
        .json(&body);
    for (name, value) in headers {
        if name.as_str().eq_ignore_ascii_case("authorization") {
            continue;
        }
        request = request.header(name, value);
    }

    let response = tokio::time::timeout(Duration::from_secs(15), request.send())
        .await
        .ok()?
        .ok()?;
    if response.status() != http::StatusCode::UNAUTHORIZED
        && response.status() != http::StatusCode::FORBIDDEN
    {
        return None;
    }
    response
        .headers()
        .get(http::header::WWW_AUTHENTICATE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
}

/// 绑定本地回调监听。走 CIMD 时 client_id 指向一份静态 HTTPS 文档，其
/// `redirect_uris` 无法表达系统分配的随机端口，因此只能逐个尝试文档里预置的
/// 固定端口；动态注册流程仍使用系统分配的随机端口。
async fn bind_callback_listener(fixed_ports_required: bool) -> Result<TcpListener> {
    if !fixed_ports_required {
        return TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|error| {
                Error::from_reason(format!(
                    "Failed to start the MCP OAuth callback listener: {error}"
                ))
            });
    }
    for port in CIMD_CALLBACK_PORTS {
        if let Ok(listener) = TcpListener::bind(("127.0.0.1", port)).await {
            return Ok(listener);
        }
    }
    let ports = CIMD_CALLBACK_PORTS
        .iter()
        .map(u16::to_string)
        .collect::<Vec<_>>()
        .join(", ");
    Err(Error::from_reason(format!(
        "Failed to start the MCP OAuth callback listener: ports {ports} are all in use"
    )))
}

/// 启动浏览器授权：完成元数据发现与客户端注册，登记会话并监听本地回调。
pub async fn start_login(
    project_id: Option<&str>,
    config_server_id: &str,
) -> Result<McpOAuthStart> {
    let config = load_server_config(project_id, config_server_id).await?;
    if !config.transport_type.eq_ignore_ascii_case("http") {
        return Err(Error::from_reason(
            "OAuth sign-in is only available for HTTP MCP servers",
        ));
    }
    if !config.oauth {
        return Err(Error::from_reason(
            "OAuth sign-in is not enabled for this MCP server",
        ));
    }
    let url = config.url.trim().to_string();
    if url.is_empty() {
        return Err(Error::from_reason(format!(
            "External MCP server {} has no URL",
            config.name
        )));
    }

    let http_client = super::http::build_http_client(true).await?;
    let custom_headers = super::http::parse_headers(&config.headers_json)?;
    let challenge = probe_auth_challenge(&http_client, &url, &custom_headers).await;

    let mut manager = AuthorizationManager::new(url.as_str())
        .await
        .map_err(|error| Error::from_reason(format!("MCP OAuth setup failed: {error}")))?;
    manager
        .with_client(http_client)
        .map_err(|error| Error::from_reason(format!("MCP OAuth setup failed: {error}")))?;
    manager.set_credential_store(FileCredentialStore::for_url(&url)?);
    manager.set_state_store(InMemoryStateStore::new());
    let resolution = manager
        .resolve_metadata_from_challenge(challenge.as_deref())
        .await
        .map_err(|error| {
            Error::from_reason(format!("MCP OAuth metadata discovery failed: {error}"))
        })?;
    let supports_client_metadata = resolution
        .metadata
        .additional_fields
        .get("client_id_metadata_document_supported")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let supports_dynamic_registration = resolution.metadata.registration_endpoint.is_some();
    manager.set_metadata(resolution.metadata);

    if !supports_client_metadata && !supports_dynamic_registration {
        return Err(Error::from_reason(format!(
            "MCP OAuth failed: the authorization server of {} supports neither \
             client ID metadata documents nor dynamic client registration",
            config.name
        )));
    }

    let listener = bind_callback_listener(supports_client_metadata).await?;
    let port = listener
        .local_addr()
        .map_err(|error| {
            Error::from_reason(format!(
                "Failed to read the MCP OAuth callback address: {error}"
            ))
        })?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");

    let request = AuthorizationRequest::new(redirect_uri.clone())
        .with_client_name("Snow App")
        .with_client_metadata_url(CLIENT_METADATA_URL);
    let session = AuthorizationSession::new(manager, request)
        .await
        .map_err(|(_, error)| {
            Error::from_reason(format!("MCP OAuth client registration failed: {error}"))
        })?;
    let auth_url = session.get_authorization_url().to_string();

    reset_sessions_for_server(config_server_id);
    let session_id = register_session(
        &url,
        config_server_id,
        session,
        listener,
        redirect_uri,
    );

    Ok(McpOAuthStart {
        session_id,
        auth_url,
    })
}

/// 同一服务器重新发起授权时：取消仍在等待的旧会话，并清理该服务器的
/// 已结束会话记录（避免会话表长期累积）。
fn reset_sessions_for_server(config_server_id: &str) {
    let mut sessions = lock_sessions();
    sessions.retain(|_, entry| {
        let mut guard = lock_entry(entry);
        if guard.config_server_id != config_server_id {
            return true;
        }
        if guard.status == SessionStatus::Pending {
            guard.status = SessionStatus::Cancelled;
            if let Some(sender) = guard.shutdown.take() {
                let _ = sender.send(());
            }
        }
        false
    });
}

fn register_session(
    url: &str,
    config_server_id: &str,
    session: AuthorizationSession,
    listener: TcpListener,
    redirect_uri: String,
) -> String {
    let session_id = session_id();
    let session = std::sync::Arc::new(session);
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let entry: SharedEntry = std::sync::Arc::new(Mutex::new(OAuthSessionEntry {
        config_server_id: config_server_id.to_string(),
        status: SessionStatus::Pending,
        error: None,
        shutdown: Some(shutdown_tx),
    }));

    lock_sessions().insert(session_id.clone(), entry.clone());

    let listener_entry = entry.clone();
    let listener_server_id = config_server_id.to_string();
    let listener_url = url.to_string();
    tokio::spawn(async move {
        tokio::select! {
            _ = shutdown_rx => {}
            _ = run_callback_listener(
                listener,
                session,
                listener_entry,
                redirect_uri,
                listener_server_id,
                listener_url,
            ) => {}
        }
    });

    let timeout_entry = entry;
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(LOGIN_TIMEOUT_SECS)).await;
        let mut guard = lock_entry(&timeout_entry);
        if guard.status == SessionStatus::Pending {
            guard.status = SessionStatus::Error;
            guard.error = Some("OAuth authorization timed out".to_string());
            if let Some(sender) = guard.shutdown.take() {
                let _ = sender.send(());
            }
        }
    });

    session_id
}

/// 本地回调监听：只处理 `/callback`，其余请求回 404 后继续等待。
async fn run_callback_listener(
    listener: TcpListener,
    session: std::sync::Arc<AuthorizationSession>,
    entry: SharedEntry,
    redirect_uri: String,
    config_server_id: String,
    url: String,
) {
    loop {
        let Ok((mut stream, _address)) = listener.accept().await else {
            return;
        };
        let Some(target) = read_request_target(&mut stream).await else {
            respond(&mut stream, "400 Bad Request", &callback_page(&failure_body())).await;
            continue;
        };
        let path = target.split('?').next().unwrap_or("");
        if path != "/callback" {
            respond(&mut stream, "404 Not Found", &callback_page(&failure_body())).await;
            continue;
        }

        let query = target.split_once('?').map(|(_, value)| value).unwrap_or("");
        let params: HashMap<String, String> =
            url::form_urlencoded::parse(query.as_bytes()).into_owned().collect();

        if let Some(error_code) = params.get("error").filter(|value| !value.trim().is_empty()) {
            let description = params
                .get("error_description")
                .map(String::as_str)
                .unwrap_or("");
            let message = if description.trim().is_empty() {
                format!("Authorization failed: {error_code}")
            } else {
                format!("Authorization failed: {description}")
            };
            fail_session(&entry, message.clone());
            respond(
                &mut stream,
                "400 Bad Request",
                &callback_page(&failure_body()),
            )
            .await;
            return;
        }

        let callback_url = format!("{redirect_uri}?{query}");
        match session.handle_callback_url(&callback_url).await {
            Ok(_) => {
                {
                    let mut guard = lock_entry(&entry);
                    guard.status = SessionStatus::Success;
                    guard.error = None;
                }
                super::invalidate_server_discovery_cache(&config_server_id);
                eprintln!("[MCP] OAuth authorization completed for {url}");
                respond(&mut stream, "200 OK", &callback_page(&success_body())).await;
                return;
            }
            Err(error) => {
                fail_session(&entry, format!("{error}"));
                respond(
                    &mut stream,
                    "400 Bad Request",
                    &callback_page(&failure_body()),
                )
                .await;
                return;
            }
        }
    }
}

fn fail_session(entry: &SharedEntry, message: String) {
    let mut guard = lock_entry(entry);
    guard.status = SessionStatus::Error;
    guard.error = Some(message);
}

async fn read_request_target(stream: &mut TcpStream) -> Option<String> {
    let mut buffer = Vec::with_capacity(2048);
    let mut chunk = [0u8; 1024];
    loop {
        let read = tokio::time::timeout(Duration::from_secs(10), stream.read(&mut chunk))
            .await
            .ok()?
            .ok()?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
        if buffer.len() > MAX_CALLBACK_REQUEST_BYTES {
            return None;
        }
    }

    let text = String::from_utf8_lossy(&buffer);
    let mut parts = text.lines().next()?.split_whitespace();
    if parts.next()? != "GET" {
        return None;
    }
    parts.next().map(str::to_string)
}

async fn respond(stream: &mut TcpStream, status: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.as_bytes().len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

fn callback_page(body: &str) -> String {
    format!(
        r#"<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Snow App</title>
<style>
:root {{ color-scheme: light dark; }}
body {{ margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #0f1115; color: #e8eaed; font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; }}
main {{ max-width: 420px; padding: 40px 32px; text-align: center; }}
h1 {{ font-size: 20px; font-weight: 600; margin: 0 0 12px; }}
p {{ font-size: 13px; line-height: 1.7; color: #9aa0a6; margin: 6px 0; }}
</style>
</head>
<body>
<main>
{body}
</main>
</body>
</html>"#
    )
}

fn success_body() -> &'static str {
    "<h1>Authorization complete</h1>\n<p>You can close this window and return to Snow App.</p>\n<p>授权已完成，可以关闭此窗口并返回 Snow App。</p>"
}

fn failure_body() -> &'static str {
    "<h1>Authorization failed</h1>\n<p>Return to Snow App and start the sign-in again.</p>\n<p>授权失败，请返回 Snow App 重新发起授权。</p>"
}

/// 读取登录会话状态；会话不存在（已过期或被清理）时返回 None。
pub fn login_status(session_id: &str) -> Option<McpOAuthStatus> {
    let entry = {
        let sessions = lock_sessions();
        sessions.get(session_id).cloned()
    }?;
    let guard = lock_entry(&entry);
    Some(McpOAuthStatus {
        status: guard.status.as_str().to_string(),
        error: guard.error.clone(),
    })
}

/// 取消仍在等待的登录会话；已结束的会话返回 false。
pub fn cancel_login(session_id: &str) -> bool {
    let entry = {
        let sessions = lock_sessions();
        sessions.get(session_id).cloned()
    };
    let Some(entry) = entry else {
        return false;
    };
    let mut guard = lock_entry(&entry);
    if guard.status != SessionStatus::Pending {
        return false;
    }
    guard.status = SessionStatus::Cancelled;
    if let Some(sender) = guard.shutdown.take() {
        let _ = sender.send(());
    }
    true
}
