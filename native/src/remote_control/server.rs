//! 手机远控 HTTP 服务：局域网与公网两个监听器共用同一套请求处理。
//!
//! 原先整套服务由 Node 主进程的 remoteControlServer.ts 承担（node:http、
//! 手写路由与鉴权）。迁移到 Rust 后，TCP 监听、HTTP 解析、鉴权、静态资源、
//! 附件落盘与图片解析全部在原生侧完成；只有需要桌面 UI 实时状态的操作
//! 通过 bridge 派发给 Node → 渲染进程。

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, RwLock};
use std::time::Duration;

use axum::body::Body;
use axum::extract::State;
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, Method, Request, Response, StatusCode};
use axum::Router;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use hyper::upgrade::OnUpgrade;
use hyper_util::rt::TokioIo;
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::{Role, WebSocketConfig};
use tokio_tungstenite::WebSocketStream;
use url::Url;

use super::assets::{self, MOBILE_ASSET_PATH_PREFIX};
use super::attachments::{self, AttachError, AttachmentKind, RemoteAttachmentContext};
use super::auth::{encode_query_component, now_ms, secret_matches, WanAuth};
use super::bridge::{self, BridgeError};
use super::live;
use super::unauthorized;
use crate::storage::services::app_lock;

/// 请求体上限（JSON 接口）。
const MAX_BODY_BYTES: usize = 64 * 1024;
/// 局域网令牌 Cookie 与请求头名称。
const COOKIE_NAME: &str = "snowRemoteToken";
/// 公网会话 Cookie 名称。
const WAN_COOKIE_NAME: &str = "snowRemoteSession";
const TOKEN_HEADER: &str = "x-snow-remote-token";
/// 会话图片允许的最大字节数（与手机端上传通道一致）。
const MAX_MESSAGE_IMAGE_BYTES: usize = 10 * 1024 * 1024;
/// 消息图片支持的 MIME 白名单。
const MESSAGE_IMAGE_TYPES: [&str; 4] = ["image/png", "image/jpeg", "image/gif", "image/webp"];
/// 标识符类字段（模型 id / Profile 名 / 指令 id / 思考强度）的长度上限。
const MAX_IDENTIFIER_LENGTH: usize = 200;
/// 待办内容长度上限（与 Renderer 桥、移动端输入框 maxlength 保持一致）。
const MAX_TODO_CONTENT_LENGTH: usize = 500;
/// WorkFlow 反馈内容长度上限（与 Renderer 桥、移动端输入框 maxlength 保持一致）。
const MAX_WORKFLOW_REPLY_LENGTH: usize = 2_000;
/// 可远程切换的代理行为模式白名单（必须与 renderer/types/remoteControl.ts 一致）。
const REMOTE_MODES: [&str; 5] = ["goal", "worktree", "workflow", "yolo", "lite"];
/// 已完成 send 请求的去重缓存容量。
const COMPLETED_SEND_CAPACITY: usize = 200;
/// 等待 send 派发空窗的上限（轮换凭据 / 停止服务时使用）。
const SEND_IDLE_TIMEOUT: Duration = Duration::from_secs(5);
/// 单次 send 请求内最多携带的附件数（与附件存储一致）。
const MAX_SEND_ATTACHMENTS: usize = 4;
/// 回滚 diff：单次请求携带的检查点数量、返回的文件数上限。
const MAX_ROLLBACK_CHECKPOINTS: usize = 300;
const MAX_ROLLBACK_DIFF_FILES: usize = 50;
/// 单个文件 diff 下发给手机端的行数 / 字节上限（手机屏幕消费不了更长的内容）。
const MAX_ROLLBACK_DIFF_ROWS: u32 = 400;
const MAX_ROLLBACK_DIFF_BYTES: u32 = 64 * 1024;
/// 变更面板单条文件路径的长度上限（与桥的回滚清单一致）。
const MAX_CHANGE_PATH_LENGTH: usize = 400;
/// 令牌解锁尝试限流：窗口与窗口内允许的失败次数。
const UNLOCK_FAILURE_WINDOW_MS: i64 = 5 * 60 * 1000;
const MAX_UNLOCK_FAILURES: usize = 10;
/// 动态码解锁尝试限流：6 位码空间小，窗口内允许的失败次数必须比令牌更少。
const CODE_FAILURE_WINDOW_MS: i64 = 5 * 60 * 1000;
const MAX_CODE_FAILURES: usize = 5;
/// 令牌长度上限（面板固定令牌与移动端输入都不得超过）。
const MAX_UNLOCK_TOKEN_LENGTH: usize = 512;
/// 动态码长度上限（手机端固定输入 6 位，留出容错余量）。
const MAX_UNLOCK_CODE_LENGTH: usize = 12;
/// 令牌解锁成功后写入的公网会话 Cookie 有效期（令牌本身不设过期）。
const WAN_COOKIE_MAX_AGE: i64 = 365 * 24 * 60 * 60;
/// 实时通道单条客户端消息上限（只有控制指令）。
const LIVE_MAX_MESSAGE_BYTES: usize = 64 * 1024;

/// 监听器策略：局域网或公网，两者都只认各自的长期令牌。
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ServerPolicy {
    Lan,
    Wan,
}

/// 单个监听器的共享上下文。
pub struct ServerContext {
    pub policy: ServerPolicy,
    pub mobile_dir: PathBuf,
    pub icon_bytes: Option<Arc<Vec<u8>>>,
    /// 局域网令牌（轮换时原地替换）。
    pub lan_token: Option<Arc<RwLock<String>>>,
    /// 公网入口认证：与局域网一致的单一长期令牌。
    pub wan_auth: Option<Arc<WanAuth>>,
    /// 配对代数：令牌轮换 / 服务重启后自增，旧请求据此拒绝。
    pub generation: Arc<AtomicU64>,
    /// 配对令牌解锁失败限流。
    pub unlock_tokens: FailureGuard,
    /// 身份验证器动态码解锁失败限流。
    pub unlock_codes: FailureGuard,
    /// 监听器关闭信号：实时通道据此断开长连接。
    pub closed: tokio::sync::watch::Receiver<bool>,
}

/// 解锁失败限流：滑动窗口内记录的失败时间戳，超窗自动放行。
pub struct FailureGuard {
    window_ms: i64,
    max_failures: usize,
    failures: Mutex<VecDeque<i64>>,
}

impl FailureGuard {
    /// 配对令牌解锁失败限流。
    pub const fn tokens() -> Self {
        Self::new(UNLOCK_FAILURE_WINDOW_MS, MAX_UNLOCK_FAILURES)
    }

    /// 身份验证器动态码解锁失败限流。
    pub const fn codes() -> Self {
        Self::new(CODE_FAILURE_WINDOW_MS, MAX_CODE_FAILURES)
    }

    const fn new(window_ms: i64, max_failures: usize) -> Self {
        Self {
            window_ms,
            max_failures,
            failures: Mutex::new(VecDeque::new()),
        }
    }

    /// 窗口内失败次数是否已达上限（顺带清理过期记录）。
    fn blocked(&self) -> bool {
        let now = now_ms();
        let mut failures = self.lock();
        while let Some(attempted_at) = failures.front().copied() {
            if attempted_at <= now - self.window_ms {
                failures.pop_front();
            } else {
                break;
            }
        }
        failures.len() >= self.max_failures
    }

    fn record(&self) {
        let mut failures = self.lock();
        failures.push_back(now_ms());
        while failures.len() > self.max_failures {
            failures.pop_front();
        }
    }

    fn clear(&self) {
        self.lock().clear();
    }

    fn lock(&self) -> MutexGuard<'_, VecDeque<i64>> {
        self.failures
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl ServerContext {
    fn is_wan(&self) -> bool {
        self.policy == ServerPolicy::Wan
    }

    fn current_token(&self) -> String {
        self.lan_token
            .as_ref()
            .map(|token| {
                token
                    .read()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .clone()
            })
            .unwrap_or_default()
    }

    fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }
}

/// 统一的接口错误：状态码 + 中文文案（JSON `{ error }` 契约与旧实现一致）。
pub struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }

    fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, message)
    }

    fn conflict(message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, message)
    }

    fn service_unavailable() -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "Snow 暂时无法处理该请求",
        )
    }

    fn into_response(self) -> Response<Body> {
        json_response(self.status, &json!({ "error": self.message }), Vec::new())
    }
}

/// send 派发并发计数：轮换凭据 / 停止服务前需要等待在途发送结束。
mod send_tracker {
    use super::*;
    use tokio::sync::oneshot;

    struct Tracker {
        active: usize,
        waiters: Vec<oneshot::Sender<()>>,
    }

    static TRACKER: OnceLock<Mutex<Tracker>> = OnceLock::new();

    fn tracker() -> &'static Mutex<Tracker> {
        TRACKER.get_or_init(|| {
            Mutex::new(Tracker {
                active: 0,
                waiters: Vec::new(),
            })
        })
    }

    fn lock() -> MutexGuard<'static, Tracker> {
        tracker()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// 进入一次远程变更操作。
    pub fn acquire() {
        lock().active += 1;
    }

    /// 结束一次远程变更操作；最后一个离开者唤醒全部等待者。
    pub fn release() {
        let mut guard = lock();
        guard.active = guard.active.saturating_sub(1);
        if guard.active == 0 {
            for waiter in guard.waiters.drain(..) {
                let _ = waiter.send(());
            }
        }
    }

    /// 等待所有远程变更操作结束（超时兜底，避免永久阻塞）。
    pub async fn wait_idle(timeout: Duration) {
        let receiver = {
            let mut guard = lock();
            if guard.active == 0 {
                return;
            }
            let (sender, receiver) = oneshot::channel();
            guard.waiters.push(sender);
            receiver
        };
        let _ = tokio::time::timeout(timeout, receiver).await;
    }
}

/// 已完成 send 请求的幂等缓存（requestId → 结果）。
static COMPLETED_SENDS: OnceLock<Mutex<VecDeque<(String, u64, Value)>>> = OnceLock::new();

fn completed_sends() -> &'static Mutex<VecDeque<(String, u64, Value)>> {
    COMPLETED_SENDS.get_or_init(|| Mutex::new(VecDeque::new()))
}

fn completed_send_result(request_id: &str, generation: u64) -> Option<Value> {
    let queue = completed_sends()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    queue
        .iter()
        .rev()
        .find(|(id, recorded, _)| id == request_id && *recorded == generation)
        .map(|(_, _, value)| value.clone())
}

fn store_completed_send(request_id: String, generation: u64, result: Value) {
    let mut queue = completed_sends()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    queue.retain(|(id, _, _)| id != &request_id);
    queue.push_back((request_id, generation, result));
    while queue.len() > COMPLETED_SEND_CAPACITY {
        queue.pop_front();
    }
}

/// 清空 send 幂等缓存（轮换凭据 / 停止服务时调用）。
pub fn clear_completed_sends() {
    completed_sends()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clear();
}

/// 构建远控 HTTP 应用（两个监听器共用同一套路由）。
pub fn router(context: Arc<ServerContext>) -> Router {
    Router::new().fallback(handle).with_state(context)
}

async fn handle(State(context): State<Arc<ServerContext>>, request: Request<Body>) -> Response<Body> {
    let mutating = !matches!(*request.method(), Method::GET | Method::HEAD);
    let response = match process(&context, request).await {
        Ok(response) => response,
        Err(error) => error.into_response(),
    };
    // 变更操作后立即刷新实时通道，手机无需等下一拍。
    if mutating {
        live::nudge();
    }
    response
}

// ─── 响应构造 ──────────────────────────────────────────────────────────────

fn build_response(
    status: StatusCode,
    content_type: &str,
    body: Vec<u8>,
    extra: Vec<(&'static str, String)>,
) -> Response<Body> {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(content_type).unwrap_or_else(|_| HeaderValue::from_static("text/plain; charset=utf-8")),
    );
    headers.insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&body.len().to_string())
            .unwrap_or_else(|_| HeaderValue::from_static("0")),
    );
    for (name, value) in extra {
        if let (Ok(name), Ok(value)) = (
            HeaderName::from_bytes(name.as_bytes()),
            HeaderValue::from_str(&value),
        ) {
            headers.insert(name, value);
        }
    }
    Response::builder()
        .status(status)
        .body(Body::from(body))
        .map(|mut response| {
            *response.headers_mut() = headers;
            response
        })
        .unwrap_or_else(|_| Response::new(Body::empty()))
}

fn json_response(
    status: StatusCode,
    value: &Value,
    extra: Vec<(&'static str, String)>,
) -> Response<Body> {
    let body = serde_json::to_vec(value).unwrap_or_else(|_| b"{}".to_vec());
    let mut headers = vec![
        ("Cache-Control", "no-store".to_string()),
        ("X-Content-Type-Options", "nosniff".to_string()),
        ("Referrer-Policy", "no-referrer".to_string()),
    ];
    headers.extend(extra);
    build_response(status, "application/json; charset=utf-8", body, headers)
}

/// 移动页 HTML 的 CSP：无内联脚本权限（脚本 / 样式均为同源独立资源），
/// connect-src 显式放行同主机 ws/wss（部分 WebView 的 'self' 不覆盖 ws 协议）。
fn mobile_page_csp(headers: &HeaderMap) -> String {
    let host = header_text(headers, "host").filter(|host| {
        !host.is_empty()
            && host
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b':' | b'[' | b']'))
    });
    let connect = match host {
        Some(host) => format!("'self' ws://{host} wss://{host}"),
        None => "'self'".to_string(),
    };
    format!("default-src 'self'; script-src 'self'; style-src 'self'; connect-src {connect}; img-src 'self' data: blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
}

/// 引导页 HTML：无脚本、无外部资源。
const UNAUTHORIZED_PAGE_CSP: &str = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

fn html_response(
    status: StatusCode,
    html: String,
    extra: Vec<(&'static str, String)>,
    bodyless: bool,
) -> Response<Body> {
    let body = html.into_bytes();
    let content_length = body.len();
    let mut headers = vec![
        ("Cache-Control", "no-store".to_string()),
        ("X-Content-Type-Options", "nosniff".to_string()),
        ("X-Frame-Options", "DENY".to_string()),
        ("Referrer-Policy", "no-referrer".to_string()),
    ];
    headers.extend(extra);
    let mut response = build_response(
        status,
        "text/html; charset=utf-8",
        if bodyless { Vec::new() } else { body },
        headers,
    );
    if bodyless {
        // HEAD 只回响应头：Content-Length 保留完整 HTML 长度，但不带正文。
        if let Ok(value) = HeaderValue::from_str(&content_length.to_string()) {
            response.headers_mut().insert(header::CONTENT_LENGTH, value);
        }
    }
    response
}

// ─── 请求解析辅助 ──────────────────────────────────────────────────────────

fn parse_url(uri: &str) -> Option<Url> {
    Url::parse(&format!("http://localhost{}", uri)).ok()
}

fn header_text(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
}

/// 解析 Cookie 头（decodeURIComponent 语义，失败时忽略该项）。
fn parse_cookies(header: Option<&str>) -> Vec<(String, String)> {
    let mut cookies = Vec::new();
    for part in header.unwrap_or_default().split(';') {
        let Some(separator) = part.find('=') else {
            continue;
        };
        if separator == 0 {
            continue;
        }
        let name = part[..separator].trim().to_string();
        let raw = part[separator + 1..].trim();
        let value = percent_encoding::percent_decode_str(raw)
            .decode_utf8()
            .map(|decoded| decoded.into_owned())
            .unwrap_or_else(|_| raw.to_string());
        cookies.push((name, value));
    }
    cookies
}

fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    let raw = header_text(headers, "cookie");
    parse_cookies(raw.as_deref())
        .into_iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value)
}

fn is_json_request(headers: &HeaderMap) -> bool {
    header_text(headers, "content-type")
        .map(|value| value.to_ascii_lowercase().starts_with("application/json"))
        .unwrap_or(false)
}

/// GET/HEAD 且声明接受 HTML：典型的浏览器导航（区别于页面内 fetch 与 API 客户端）。
fn is_browser_navigation(method: &Method, headers: &HeaderMap) -> bool {
    (*method == Method::GET || *method == Method::HEAD)
        && header_text(headers, "accept")
            .map(|value| value.contains("text/html"))
            .unwrap_or(false)
}

fn is_bounded_string(value: &str, allow_empty: bool) -> bool {
    value.chars().count() <= MAX_IDENTIFIER_LENGTH && (allow_empty || !value.trim().is_empty())
}

fn is_todo_content(value: &str) -> bool {
    !value.trim().is_empty() && value.chars().count() <= MAX_TODO_CONTENT_LENGTH
}

fn is_todo_status(value: &str) -> bool {
    matches!(value, "pending" | "inProgress" | "completed")
}

fn is_workflow_reply(value: &str) -> bool {
    !value.trim().is_empty() && value.chars().count() <= MAX_WORKFLOW_REPLY_LENGTH
}

fn is_remote_mode(value: &str) -> bool {
    REMOTE_MODES.contains(&value)
}

/// 回滚方式白名单（必须与 renderer 的 RollbackMode 一致）。
fn is_rollback_mode(value: &str) -> bool {
    matches!(value, "conversation-only" | "conversation-and-files")
}

/// 检查点 id 形态校验：`cp-{secs}-{nanos}-{count}`（由检查点服务生成）。
fn is_checkpoint_id(value: &str) -> bool {
    let Some(rest) = value.strip_prefix("cp-") else {
        return false;
    };
    let mut segments = 0;
    for segment in rest.split('-') {
        if segment.is_empty() || !segment.bytes().all(|byte| byte.is_ascii_digit()) {
            return false;
        }
        segments += 1;
    }
    segments == 3
}

fn truncate_chars(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

/// 变更归属匹配用的路径规范化：与桌面 normalizePath 一致
/// （反斜杠转正斜杠、去掉开头 ./、统一小写）。
fn normalize_change_path(path: &str) -> String {
    let slashed = path.replace('\\', "/").to_lowercase();
    match slashed.strip_prefix("./") {
        Some(rest) => rest.trim_start_matches('/').to_string(),
        None => slashed,
    }
}

/// 工具记录归属查找：与桌面 findFallbackChange 同语义（全等或 tool 路径以
/// 「/检查点路径」结尾）。
fn find_change_attribution<'a>(
    normalized: &str,
    fallback: &'a [(String, Value)],
) -> Option<&'a Value> {
    fallback
        .iter()
        .find(|(path, _)| path == normalized || path.ends_with(&format!("/{normalized}")))
        .map(|(_, item)| item)
}

/// 检查点变更类型映射：与桌面 toFileChangeKind 一致。
fn change_kind(change_type: &str) -> &'static str {
    match change_type {
        "added" => "create",
        "deleted" => "delete",
        _ => "edit",
    }
}

/// /changes 面板数据：桥下发的回滚链描述 + 原生检查点 diff。
/// 与桌面 FileChangesPanel 同源（includeAll=false，只列出回滚真正会恢复的
/// 文件），diff 由原生检查点服务直接计算（含 SSH/SFTP 通道），不把渲染进程
/// 拉进这次只读查询；代理归属按桌面规则从桥下发的工具记录匹配，链路不可用
/// 或计算失败时整份退回工具记录（与桌面同一兜底）。
async fn build_changes_payload(descriptor: Value) -> Value {
    let conversation_id = descriptor
        .get("conversationId")
        .cloned()
        .unwrap_or(Value::Null);
    let fallback = descriptor
        .get("changes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let checkpoint_ids: Vec<String> = descriptor
        .get("checkpointIds")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let work_dir = descriptor
        .get("workDir")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let chain_usable = !work_dir.is_empty()
        && !checkpoint_ids.is_empty()
        && checkpoint_ids.len() <= MAX_ROLLBACK_CHECKPOINTS
        && checkpoint_ids.iter().all(|id| is_checkpoint_id(id));

    if chain_usable {
        if let Ok(summaries) = crate::exports::checkpoint::list_checkpoint_summaries_batch(
            checkpoint_ids,
            work_dir,
            Some(false),
        )
        .await
        {
            let attributed: Vec<(String, Value)> = fallback
                .iter()
                .map(|item| {
                    (
                        normalize_change_path(
                            item.get("path").and_then(Value::as_str).unwrap_or_default(),
                        ),
                        item.clone(),
                    )
                })
                .collect();
            let changes: Vec<Value> = summaries
                .into_iter()
                .map(|summary| {
                    let normalized = normalize_change_path(&summary.path);
                    let matched = find_change_attribution(&normalized, &attributed);
                    json!({
                        "path": truncate_chars(&summary.path, MAX_CHANGE_PATH_LENGTH),
                        "kind": change_kind(&summary.change_type),
                        "agent": matched
                            .and_then(|item| item.get("agent").and_then(Value::as_str))
                            .unwrap_or("main"),
                        "subAgentName": matched
                            .and_then(|item| item.get("subAgentName").and_then(Value::as_str)),
                        "additions": summary.additions,
                        "deletions": summary.deletions,
                    })
                })
                .collect();
            return json!({ "conversationId": conversation_id, "changes": changes });
        }
    }

    json!({ "conversationId": conversation_id, "changes": fallback })
}

async fn read_json_body(body: Option<Body>) -> Result<Value, ApiError> {
    let body = body.unwrap_or_else(Body::empty);
    let bytes = axum::body::to_bytes(body, MAX_BODY_BYTES)
        .await
        .map_err(|_| ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "请求体超过 64 KiB"))?;
    if bytes.is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| ApiError::new(StatusCode::BAD_REQUEST, "JSON 格式无效"))
}

fn ensure_current_pairing(context: &ServerContext, snapshot: u64) -> Result<(), ApiError> {
    if snapshot != context.generation() {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "配对凭据已轮换，请重新配对",
        ));
    }
    Ok(())
}

fn api_error_from_bridge(error: BridgeError) -> ApiError {
    match error {
        BridgeError::NotReady => ApiError::conflict("远程控制桥尚未就绪"),
        BridgeError::Renderer(message) => {
            let reason = truncate_chars(message.trim(), MAX_IDENTIFIER_LENGTH);
            ApiError::conflict(if reason.is_empty() {
                "Snow 暂时无法处理该请求".to_string()
            } else {
                reason
            })
        }
        BridgeError::Dispatch => ApiError::service_unavailable(),
    }
}

async fn bridge_call(action: &str, args: Value) -> Result<Value, ApiError> {
    bridge::call(action, args)
        .await
        .map_err(api_error_from_bridge)
}

fn api_error_from_attach(error: AttachError) -> ApiError {
    match error {
        AttachError::Code(code) => match code {
            attachments::ERR_INVALID_KIND => ApiError::new(StatusCode::BAD_REQUEST, "附件类型无效"),
            attachments::ERR_INVALID_MIME => {
                ApiError::new(StatusCode::UNSUPPORTED_MEDIA_TYPE, "附件 Content-Type 无效")
            }
            attachments::ERR_UNSUPPORTED_IMAGE_TYPE => ApiError::new(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "仅支持 PNG、JPEG、GIF 和 WebP 图片",
            ),
            attachments::ERR_TOO_MANY_ATTACHMENTS => {
                ApiError::new(StatusCode::BAD_REQUEST, "每次最多选择 4 个附件")
            }
            attachments::ERR_ATTACHMENT_TOO_LARGE => {
                ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "附件超过大小或总容量限制")
            }
            attachments::ERR_EMPTY_ATTACHMENT => {
                ApiError::new(StatusCode::BAD_REQUEST, "附件不能为空")
            }
            attachments::ERR_IMAGE_SIGNATURE_MISMATCH => {
                ApiError::new(StatusCode::BAD_REQUEST, "图片内容与格式不匹配")
            }
            attachments::ERR_IMAGE_DIMENSIONS_INVALID => {
                ApiError::new(StatusCode::BAD_REQUEST, "无法读取图片尺寸")
            }
            attachments::ERR_IMAGE_TOO_LARGE => {
                ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "图片像素尺寸过大")
            }
            attachments::ERR_INVALID_ATTACHMENT_IDS => {
                ApiError::new(StatusCode::BAD_REQUEST, "附件列表无效")
            }
            attachments::ERR_ATTACHMENT_NOT_AVAILABLE => {
                ApiError::new(StatusCode::CONFLICT, "附件已失效，请重新选择")
            }
            _ => ApiError::service_unavailable(),
        },
        AttachError::Internal(_) => ApiError::service_unavailable(),
    }
}

fn has_expected_wan_host(headers: &HeaderMap, context: &ServerContext) -> bool {
    let Some(auth) = &context.wan_auth else {
        return false;
    };
    header_text(headers, "host")
        .map(|host| host.eq_ignore_ascii_case(&auth.expected_host()))
        .unwrap_or(false)
}

fn has_expected_wan_origin(headers: &HeaderMap, context: &ServerContext) -> bool {
    let Some(auth) = &context.wan_auth else {
        return false;
    };
    header_text(headers, "origin")
        .map(|origin| origin == auth.origin())
        .unwrap_or(false)
}

fn is_authorized(context: &ServerContext, headers: &HeaderMap, url: &Url, request_token: &str) -> bool {
    match context.policy {
        ServerPolicy::Lan => {
            if request_token.is_empty() {
                return false;
            }
            let header_match = header_text(headers, TOKEN_HEADER)
                .map(|value| secret_matches(&value, request_token))
                .unwrap_or(false);
            let cookie_match = cookie_value(headers, COOKIE_NAME)
                .map(|value| secret_matches(&value, request_token))
                .unwrap_or(false);
            let query_match = url
                .query_pairs()
                .find(|(key, _)| key == "token")
                .map(|(_, value)| secret_matches(&value, request_token))
                .unwrap_or(false);
            header_match || cookie_match || query_match
        }
        ServerPolicy::Wan => {
            let Some(auth) = context.wan_auth.as_ref() else {
                return false;
            };
            if auth.authorize(cookie_value(headers, WAN_COOKIE_NAME).as_deref()) {
                return true;
            }
            url.query_pairs()
                .find(|(key, _)| key == "token")
                .map(|(_, value)| auth.authorize(Some(value.as_ref())))
                .unwrap_or(false)
        }
    }
}

// ─── 实时通道 ──────────────────────────────────────────────────────────────

fn header_has_token(headers: &HeaderMap, name: &str, token: &str) -> bool {
    header_text(headers, name)
        .map(|value| value.split(',').any(|part| part.trim().eq_ignore_ascii_case(token)))
        .unwrap_or(false)
}

/// WebSocket 握手必须同源（Cookie 鉴权下防跨站劫持）。
fn is_same_origin_upgrade(context: &ServerContext, headers: &HeaderMap) -> bool {
    if context.is_wan() {
        return has_expected_wan_origin(headers, context);
    }
    let (Some(origin), Some(host)) = (header_text(headers, "origin"), header_text(headers, "host")) else {
        return false;
    };
    origin
        .strip_prefix("http://")
        .or_else(|| origin.strip_prefix("https://"))
        .map(|rest| rest.eq_ignore_ascii_case(&host))
        .unwrap_or(false)
}

/// 会话存续期间的凭据复查：令牌轮换 / 服务重启后代数变化，公网令牌更换后失效。
fn live_still_authorized(context: &ServerContext, generation: u64, wan_credential: Option<&str>) -> bool {
    if context.generation() != generation {
        return false;
    }
    match context.wan_auth.as_ref() {
        Some(auth) if context.is_wan() => auth.authorize(wan_credential),
        _ => true,
    }
}

/// /api/live：校验握手后把连接交给实时通道。
fn accept_live(
    context: &Arc<ServerContext>,
    headers: &HeaderMap,
    on_upgrade: Option<OnUpgrade>,
    request_generation: u64,
    wan_credential: Option<String>,
) -> Response<Body> {
    let key = header_text(headers, "sec-websocket-key");
    let handshake_valid = header_has_token(headers, "upgrade", "websocket")
        && header_has_token(headers, "connection", "upgrade")
        && header_text(headers, "sec-websocket-version").as_deref() == Some("13");
    let (Some(key), Some(on_upgrade), true) = (key, on_upgrade, handshake_valid) else {
        return json_response(
            StatusCode::BAD_REQUEST,
            &json!({ "error": "需要 WebSocket 握手" }),
            Vec::new(),
        );
    };
    if !is_same_origin_upgrade(context, headers) {
        return json_response(
            StatusCode::FORBIDDEN,
            &json!({ "error": "请求来源无效" }),
            Vec::new(),
        );
    }
    let accept = derive_accept_key(key.trim().as_bytes());
    let session_context = context.clone();
    tokio::spawn(async move {
        let Ok(upgraded) = on_upgrade.await else {
            return;
        };
        let mut config = WebSocketConfig::default();
        config.max_message_size = Some(LIVE_MAX_MESSAGE_BYTES);
        config.max_frame_size = Some(LIVE_MAX_MESSAGE_BYTES);
        let socket =
            WebSocketStream::from_raw_socket(TokioIo::new(upgraded), Role::Server, Some(config)).await;
        let closed = session_context.closed.clone();
        live::run_session(socket, closed, move || {
            live_still_authorized(&session_context, request_generation, wan_credential.as_deref())
        })
        .await;
    });
    Response::builder()
        .status(StatusCode::SWITCHING_PROTOCOLS)
        .header(header::UPGRADE, "websocket")
        .header(header::CONNECTION, "Upgrade")
        .header(header::SEC_WEBSOCKET_ACCEPT, accept)
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::empty())
        .unwrap_or_else(|_| Response::new(Body::empty()))
}

// ─── 主流程 ────────────────────────────────────────────────────────────────

async fn process(
    context: &Arc<ServerContext>,
    request: Request<Body>,
) -> Result<Response<Body>, ApiError> {
    let (mut parts, body) = request.into_parts();
    let on_upgrade = parts.extensions.remove::<OnUpgrade>();
    let method = parts.method.clone();
    let headers = parts.headers.clone();
    let mut body = Some(body);

    let uri = parts
        .uri
        .path_and_query()
        .map(|value| value.as_str().to_string())
        .unwrap_or_else(|| "/".to_string());
    let url = parse_url(&uri).ok_or_else(|| ApiError::bad_request("请求无效"))?;
    let path = url.path().to_string();

    let request_generation = context.generation();
    let request_token = context.current_token();

    if context.is_wan() && !has_expected_wan_host(&headers, context) {
        return Ok(json_response(
            StatusCode::MISDIRECTED_REQUEST,
            &json!({ "error": "公网入口域名不匹配" }),
            Vec::new(),
        ));
    }

    if method == Method::GET && path == "/api/unlock-methods" {
        return Ok(json_response(
            StatusCode::OK,
            &json!({ "totp": totp_unlock_available().await }),
            Vec::new(),
        ));
    }

    if method == Method::POST && path == "/api/unlock" {
        return handle_unlock(context, &headers, body.take()).await;
    }

    let authorized = is_authorized(context, &headers, &url, &request_token);
    // 未授权的浏览器也可以读取移动端外壳（HTML / 静态资源 / 品牌 logo）：
    // 页面拿不到 /api/state 时会展示令牌填写页，接口本身仍由鉴权把守。
    let is_public_page = method == Method::GET
        && (path == "/" || path == "/icon.png" || path.starts_with(MOBILE_ASSET_PATH_PREFIX));
    if !authorized && !is_public_page {
        if is_browser_navigation(&method, &headers) {
            let desktop_locale = assets::read_desktop_locale().await;
            let locale = unauthorized::resolve_locale(
                desktop_locale,
                header_text(&headers, "accept-language").as_deref(),
            );
            let html = unauthorized::render_unauthorized_page(
                locale,
                context.icon_bytes.as_ref().map(|bytes| bytes.as_slice()),
            );
            return Ok(html_response(
                StatusCode::UNAUTHORIZED,
                html,
                vec![("Content-Security-Policy", UNAUTHORIZED_PAGE_CSP.to_string())],
                method == Method::HEAD,
            ));
        }
        return Ok(json_response(
            StatusCode::UNAUTHORIZED,
            &json!({ "error": "未授权：请使用 Snow 设置中显示的配对链接" }),
            Vec::new(),
        ));
    }

    if context.is_wan()
        && method != Method::GET
        && method != Method::HEAD
        && !has_expected_wan_origin(&headers, context)
    {
        return Ok(json_response(
            StatusCode::FORBIDDEN,
            &json!({ "error": "请求来源无效" }),
            Vec::new(),
        ));
    }

    if method == Method::GET && path == "/api/live" {
        let wan_credential = if context.is_wan() {
            cookie_value(&headers, WAN_COOKIE_NAME).or_else(|| query_param(&url, "token"))
        } else {
            None
        };
        return Ok(accept_live(
            context,
            &headers,
            on_upgrade,
            request_generation,
            wan_credential,
        ));
    }

    if method == Method::GET && path == "/" {
        let Some(html) = assets::read_mobile_index_html(&context.mobile_dir).await else {
            return Ok(json_response(
                StatusCode::SERVICE_UNAVAILABLE,
                &json!({ "error": "移动端页面资源尚未构建，请先运行 npm run build / npm run dev" }),
                Vec::new(),
            ));
        };
        let mut extra = vec![("Content-Security-Policy", mobile_page_csp(&headers))];
        let token_from_query = url
            .query_pairs()
            .find(|(key, _)| key == "token")
            .map(|(_, value)| value.into_owned());
        if let Some(candidate) = token_from_query {
            if let Some(cookie) = session_cookie(context, &candidate) {
                extra.push(("Set-Cookie", cookie));
            }
        }
        return Ok(html_response(StatusCode::OK, html, extra, false));
    }

    if method == Method::GET && path == "/icon.png" {
        let Some(icon) = context.icon_bytes.clone() else {
            return Ok(json_response(
                StatusCode::NOT_FOUND,
                &json!({ "error": "图标资源不可用" }),
                Vec::new(),
            ));
        };
        return Ok(build_response(
            StatusCode::OK,
            "image/png",
            (*icon).clone(),
            vec![
                ("Cache-Control", "public, max-age=86400".to_string()),
                ("X-Content-Type-Options", "nosniff".to_string()),
            ],
        ));
    }

    if method == Method::GET && path.starts_with(MOBILE_ASSET_PATH_PREFIX) {
        let Some((bytes, content_type)) =
            assets::read_mobile_asset(&context.mobile_dir, &path).await
        else {
            return Ok(json_response(
                StatusCode::NOT_FOUND,
                &json!({ "error": "资源不存在" }),
                Vec::new(),
            ));
        };
        return Ok(build_response(
            StatusCode::OK,
            content_type,
            bytes,
            vec![
                // 文件名带内容哈希：URL 变化即自动失效，可放心交给浏览器长缓存。
                (
                    "Cache-Control",
                    "public, max-age=31536000, immutable".to_string(),
                ),
                ("X-Content-Type-Options", "nosniff".to_string()),
            ],
        ));
    }

    if method == Method::GET && path == "/health" {
        return Ok(json_response(
            StatusCode::OK,
            &json!({ "ok": true, "rendererReady": bridge::is_registered() }),
            Vec::new(),
        ));
    }

    handle_api(
        context,
        &method,
        &path,
        &url,
        &headers,
        &mut body,
        request_generation,
    )
    .await
}

/// 令牌有效时返回对应的会话 Cookie：局域网与公网都写长期令牌。
fn session_cookie(context: &ServerContext, candidate: &str) -> Option<String> {
    if context.is_wan() {
        let auth = context.wan_auth.as_ref()?;
        if !auth.authorize(Some(candidate)) {
            return None;
        }
        return Some(format!(
            "{WAN_COOKIE_NAME}={}; Path=/; Max-Age={WAN_COOKIE_MAX_AGE}; Secure; HttpOnly; SameSite=Strict",
            encode_query_component(candidate)
        ));
    }
    let current = context.current_token();
    if !secret_matches(candidate, &current) {
        return None;
    }
    Some(format!(
        "{COOKIE_NAME}={}; Path=/; HttpOnly; SameSite=Strict",
        encode_query_component(&current)
    ))
}

/// 令牌解锁：移动端令牌填写页提交令牌，校验通过后写入会话 Cookie。
async fn handle_unlock(
    context: &ServerContext,
    headers: &HeaderMap,
    body: Option<Body>,
) -> Result<Response<Body>, ApiError> {
    if context.is_wan() && !has_expected_wan_origin(headers, context) {
        return Ok(json_response(
            StatusCode::FORBIDDEN,
            &json!({ "error": "请求来源无效" }),
            Vec::new(),
        ));
    }
    if !is_json_request(headers) {
        return Ok(json_response(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            &json!({ "error": "Content-Type 必须是 application/json" }),
            Vec::new(),
        ));
    }
    let payload = read_json_body(body).await?;
    let code = payload
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if !code.is_empty() {
        return unlock_with_code(context, &code).await;
    }
    if context.unlock_tokens.blocked() {
        return Ok(json_response(
            StatusCode::TOO_MANY_REQUESTS,
            &json!({ "error": "令牌错误次数过多，请稍后再试" }),
            Vec::new(),
        ));
    }
    let token = payload
        .get("token")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if token.is_empty() || token.chars().count() > MAX_UNLOCK_TOKEN_LENGTH {
        context.unlock_tokens.record();
        return Ok(json_response(
            StatusCode::BAD_REQUEST,
            &json!({ "error": "请输入有效的令牌" }),
            Vec::new(),
        ));
    }
    match session_cookie(context, &token) {
        Some(cookie) => {
            context.unlock_tokens.clear();
            Ok(json_response(
                StatusCode::OK,
                &json!({ "ok": true }),
                vec![("Set-Cookie", cookie)],
            ))
        }
        None => {
            context.unlock_tokens.record();
            let message = if context.is_wan() {
                "令牌无效或已过期"
            } else {
                "令牌无效"
            };
            Ok(json_response(
                StatusCode::UNAUTHORIZED,
                &json!({ "error": message }),
                Vec::new(),
            ))
        }
    }
}

/// 身份验证器动态码解锁：桌面端已绑定谷歌身份验证器并允许远控解锁时，
/// 6 位动态码等价于持有配对令牌，校验通过即写入同一套会话 Cookie。
async fn unlock_with_code(context: &ServerContext, code: &str) -> Result<Response<Body>, ApiError> {
    if context.unlock_codes.blocked() {
        return Ok(json_response(
            StatusCode::TOO_MANY_REQUESTS,
            &json!({ "error": "动态码错误次数过多，请稍后再试" }),
            Vec::new(),
        ));
    }
    if code.chars().count() > MAX_UNLOCK_CODE_LENGTH {
        context.unlock_codes.record();
        return Ok(json_response(
            StatusCode::BAD_REQUEST,
            &json!({ "error": "请输入 6 位动态码" }),
            Vec::new(),
        ));
    }
    let candidate = code.to_string();
    let verified = tokio::task::spawn_blocking(move || -> napi::Result<bool> {
        let database_path = crate::storage::ensure_database_file()?;
        if !app_lock::remote_unlock_enabled(&database_path)? {
            return Ok(false);
        }
        app_lock::verify_remote_unlock_code(&database_path, &candidate)
    })
    .await
    .map(|result| result.unwrap_or(false))
    .unwrap_or(false);
    let cookie = if verified {
        current_session_cookie(context)
    } else {
        None
    };
    let Some(cookie) = cookie else {
        context.unlock_codes.record();
        return Ok(json_response(
            StatusCode::UNAUTHORIZED,
            &json!({ "error": "动态码无效，或未启用验证器解锁" }),
            Vec::new(),
        ));
    };
    context.unlock_codes.clear();
    Ok(json_response(
        StatusCode::OK,
        &json!({ "ok": true }),
        vec![("Set-Cookie", cookie)],
    ))
}

/// 当前监听器生效令牌对应的会话 Cookie。
fn current_session_cookie(context: &ServerContext) -> Option<String> {
    let candidate = if context.is_wan() {
        context.wan_auth.as_ref()?.token()
    } else {
        context.current_token()
    };
    session_cookie(context, &candidate)
}

/// 手机端是否可用身份验证器动态码解锁（桌面端已绑定且未关闭开关）。
async fn totp_unlock_available() -> bool {
    tokio::task::spawn_blocking(|| -> napi::Result<bool> {
        let database_path = crate::storage::ensure_database_file()?;
        app_lock::remote_unlock_enabled(&database_path)
    })
    .await
    .map(|result| result.unwrap_or(false))
    .unwrap_or(false)
}

// ─── API 路由 ──────────────────────────────────────────────────────────────

fn percent_decode(value: &str) -> Option<String> {
    percent_encoding::percent_decode_str(value)
        .decode_utf8()
        .ok()
        .map(|decoded| decoded.into_owned())
}

/// 读取查询参数（URLSearchParams 语义：缺失返回 None，空串返回 Some("")）。
fn query_param(url: &Url, name: &str) -> Option<String> {
    url.query_pairs()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
}

/// 校验字符串数组字段：缺失 / null 视为空数组，非字符串元素视为非法。
fn string_array_field(value: Option<&Value>) -> Option<Vec<String>> {
    match value {
        None | Some(Value::Null) => Some(Vec::new()),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| item.as_str().map(str::to_string))
            .collect(),
        Some(_) => None,
    }
}

#[allow(clippy::too_many_arguments)]
async fn handle_api(
    context: &Arc<ServerContext>,
    method: &Method,
    path: &str,
    url: &Url,
    headers: &HeaderMap,
    body: &mut Option<Body>,
    request_generation: u64,
) -> Result<Response<Body>, ApiError> {
    if method == Method::GET && path == "/api/state" {
        ensure_current_pairing(context, request_generation)?;
        let value = bridge_call("getState", json!([])).await?;
        return Ok(json_response(StatusCode::OK, &value, Vec::new()));
    }

    if method == Method::GET && path.starts_with("/api/message-images/") {
        let parts: Vec<&str> = path["/api/message-images/".len()..].split('/').collect();
        let message_id = if parts.len() == 2 {
            percent_decode(parts[0])
        } else {
            None
        };
        let image_index = if parts.len() == 2 {
            parts[1].parse::<i64>().ok()
        } else {
            None
        };
        let (Some(message_id), Some(image_index)) = (message_id, image_index) else {
            return Ok(json_response(
                StatusCode::BAD_REQUEST,
                &json!({ "error": "图片标识无效" }),
                Vec::new(),
            ));
        };
        if !is_bounded_string(&message_id, false) || !(0..=20).contains(&image_index) {
            return Ok(json_response(
                StatusCode::BAD_REQUEST,
                &json!({ "error": "图片标识无效" }),
                Vec::new(),
            ));
        }
        ensure_current_pairing(context, request_generation)?;
        let image = resolve_message_image(&message_id, image_index).await;
        ensure_current_pairing(context, request_generation)?;
        let Some((mime_type, bytes)) = image else {
            return Ok(json_response(
                StatusCode::NOT_FOUND,
                &json!({ "error": "图片不可用" }),
                Vec::new(),
            ));
        };
        if bytes.is_empty() || bytes.len() > MAX_MESSAGE_IMAGE_BYTES {
            return Ok(json_response(
                StatusCode::NOT_FOUND,
                &json!({ "error": "图片不可用" }),
                Vec::new(),
            ));
        }
        return Ok(build_response(
            StatusCode::OK,
            &mime_type,
            bytes,
            vec![
                ("Cache-Control", "private, no-store".to_string()),
                ("X-Content-Type-Options", "nosniff".to_string()),
                ("Referrer-Policy", "no-referrer".to_string()),
            ],
        ));
    }

    // 工具结果图片（截图 / 抓取图）由 Rust 落盘为 upload/<日期>/<hash>.<ext>，
    // 手机端工具卡片按该路径取图；路径形态在存储层严格校验，拒绝越界访问。
    if method == Method::GET && path.starts_with("/api/upload-images/") {
        let relative_path = percent_decode(&path["/api/upload-images/".len()..])
            .map(|rest| format!("upload/{rest}"));
        ensure_current_pairing(context, request_generation)?;
        let image = match relative_path {
            Some(relative_path) => tokio::task::spawn_blocking(move || {
                crate::storage::read_upload_image(relative_path)
            })
            .await
            .ok()
            .and_then(Result::ok)
            .flatten(),
            None => None,
        };
        ensure_current_pairing(context, request_generation)?;
        let Some((mime_type, bytes)) = image.filter(|(mime_type, bytes)| {
            MESSAGE_IMAGE_TYPES.contains(&mime_type.as_str())
                && bytes.len() <= MAX_MESSAGE_IMAGE_BYTES
        }) else {
            return Ok(json_response(
                StatusCode::NOT_FOUND,
                &json!({ "error": "图片不可用" }),
                Vec::new(),
            ));
        };
        return Ok(build_response(
            StatusCode::OK,
            &mime_type,
            bytes,
            vec![
                ("Cache-Control", "private, no-store".to_string()),
                ("X-Content-Type-Options", "nosniff".to_string()),
                ("Referrer-Policy", "no-referrer".to_string()),
            ],
        ));
    }

    if method == Method::GET && path == "/api/skills" {
        ensure_current_pairing(context, request_generation)?;
        let value = bridge_call("getSkills", json!([])).await?;
        return Ok(json_response(StatusCode::OK, &value, Vec::new()));
    }

    if method == Method::POST && path == "/api/skills" {
        if !is_json_request(headers) {
            return Ok(json_response(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                &json!({ "error": "Content-Type 必须是 application/json" }),
                Vec::new(),
            ));
        }
        let payload = read_json_body(body.take()).await?;
        let skill_id = payload.get("skillId").and_then(Value::as_str);
        let enabled = payload.get("enabled").and_then(Value::as_bool);
        let directory_id = payload.get("directoryId");
        let directory_valid = match directory_id {
            None | Some(Value::Null) => true,
            Some(value) => value
                .as_str()
                .map(|text| is_bounded_string(text, false))
                .unwrap_or(false),
        };
        let valid = skill_id.map(|text| is_bounded_string(text, false)).unwrap_or(false)
            && enabled.is_some()
            && directory_valid;
        if !valid {
            return Ok(json_response(
                StatusCode::BAD_REQUEST,
                &json!({ "error": "Skill 请求无效" }),
                Vec::new(),
            ));
        }
        ensure_current_pairing(context, request_generation)?;
        let directory_arg = match directory_id {
            Some(Value::String(text)) => Value::String(text.clone()),
            _ => Value::Null,
        };
        let value = bridge_call(
            "setSkillEnabled",
            json!([skill_id, enabled, directory_arg]),
        )
        .await?;
        return Ok(json_response(StatusCode::OK, &value, Vec::new()));
    }

    if method == Method::GET && path == "/api/mcp" {
        ensure_current_pairing(context, request_generation)?;
        let value = bridge_call("getMcpServers", json!([])).await?;
        return Ok(json_response(StatusCode::OK, &value, Vec::new()));
    }

    if method == Method::GET && path == "/api/messages" {
        ensure_current_pairing(context, request_generation)?;
        let conversation_id = query_param(url, "conversationId").unwrap_or_default();
        let before_message_id = query_param(url, "beforeMessageId").unwrap_or_default();
        let limit = match query_param(url, "limit") {
            None => Some(20i64),
            Some(raw) => raw.parse::<i64>().ok(),
        };
        let Some(limit) = limit else {
            return Ok(json_response(
                StatusCode::BAD_REQUEST,
                &json!({ "error": "消息分页参数无效" }),
                Vec::new(),
            ));
        };
        if !is_bounded_string(&conversation_id, false)
            || !is_bounded_string(&before_message_id, true)
            || !(1..=50).contains(&limit)
        {
            return Ok(json_response(
                StatusCode::BAD_REQUEST,
                &json!({ "error": "消息分页参数无效" }),
                Vec::new(),
            ));
        }
        let value = bridge_call(
            "getMessages",
            json!([conversation_id, before_message_id, limit]),
        )
        .await?;
        return Ok(json_response(StatusCode::OK, &value, Vec::new()));
    }

    if method == Method::GET && path == "/api/conversations" {
        ensure_current_pairing(context, request_generation)?;
        let directory_id = query_param(url, "directoryId").unwrap_or_default();
        let offset = match query_param(url, "offset") {
            None => Some(0i64),
            Some(raw) => raw.parse::<i64>().ok(),
        };
        let limit = match query_param(url, "limit") {
            None => Some(20i64),
            Some(raw) => raw.parse::<i64>().ok(),
        };
        let (Some(offset), Some(limit)) = (offset, limit) else {
            return Ok(json_response(
                StatusCode::BAD_REQUEST,
                &json!({ "error": "会话分页参数无效" }),
                Vec::new(),
            ));
        };
        if !is_bounded_string(&directory_id, false)
            || !(0..=100_000).contains(&offset)
            || !(1..=100).contains(&limit)
        {
            return Ok(json_response(
                StatusCode::BAD_REQUEST,
                &json!({ "error": "会话分页参数无效" }),
                Vec::new(),
            ));
        }
        let value = bridge_call(
            "getConversations",
            json!([directory_id, limit, offset]),
        )
        .await?;
        return Ok(json_response(StatusCode::OK, &value, Vec::new()));
    }

    if method == Method::GET && path == "/api/changes" {
        ensure_current_pairing(context, request_generation)?;
        let conversation_id = query_param(url, "conversationId");
        if let Some(value) = &conversation_id {
            if !is_bounded_string(value, false) {
                return Ok(json_response(
                    StatusCode::BAD_REQUEST,
                    &json!({ "error": "会话标识无效" }),
                    Vec::new(),
                ));
            }
        }
        let argument = conversation_id.map(Value::String).unwrap_or(Value::Null);
        // 桥只回链路描述与工具记录；diff 与 +/- 统计在原生侧算（SSH 下可能
        // 超过桥调用的 12 秒上限）。
        let descriptor = bridge_call("getChanges", json!([argument])).await?;
        let value = build_changes_payload(descriptor).await;
        return Ok(json_response(StatusCode::OK, &value, Vec::new()));
    }

    if method == Method::GET && path == "/api/sensitive-commands" {
        ensure_current_pairing(context, request_generation)?;
        let value = bridge_call("getSensitiveCommands", json!([])).await?;
        return Ok(json_response(StatusCode::OK, &value, Vec::new()));
    }

    if method == Method::GET && path == "/api/review" {
        ensure_current_pairing(context, request_generation)?;
        let value = bridge_call("getReview", json!([])).await?;
        return Ok(json_response(StatusCode::OK, &value, Vec::new()));
    }

    if method == Method::GET && path == "/api/codebase" {
        ensure_current_pairing(context, request_generation)?;
        let value = bridge_call("getCodebase", json!([])).await?;
        return Ok(json_response(StatusCode::OK, &value, Vec::new()));
    }

    if method == Method::GET && path == "/api/role" {
        ensure_current_pairing(context, request_generation)?;
        let value = bridge_call("getRole", json!([])).await?;
        return Ok(json_response(StatusCode::OK, &value, Vec::new()));
    }

    if method == Method::GET && path == "/api/permissions" {
        ensure_current_pairing(context, request_generation)?;
        let value = bridge_call("getPermissions", json!([])).await?;
        return Ok(json_response(StatusCode::OK, &value, Vec::new()));
    }

    if method == Method::POST && path == "/api/mcp" {
        if !is_json_request(headers) {
            return Ok(json_response(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                &json!({ "error": "Content-Type 必须是 application/json" }),
                Vec::new(),
            ));
        }
        let payload = read_json_body(body.take()).await?;
        let target = payload.get("target").and_then(Value::as_str);
        let id = payload.get("id").and_then(Value::as_str);
        let enabled = payload.get("enabled").and_then(Value::as_bool);
        let directory_id = payload.get("directoryId").and_then(Value::as_str);
        let valid = matches!(target, Some("server") | Some("tool"))
            && id.map(|text| is_bounded_string(text, false)).unwrap_or(false)
            && enabled.is_some()
            && directory_id
                .map(|text| is_bounded_string(text, false))
                .unwrap_or(false);
        if !valid {
            return Ok(json_response(
                StatusCode::BAD_REQUEST,
                &json!({ "error": "MCP 请求无效" }),
                Vec::new(),
            ));
        }
        ensure_current_pairing(context, request_generation)?;
        let value = bridge_call("setMcpEnabled", json!([target, id, enabled, directory_id])).await?;
        return Ok(json_response(StatusCode::OK, &value, Vec::new()));
    }

    if method == Method::POST && path == "/api/attachments" {
        send_tracker::acquire();
        let result = async {
            let remote_state = bridge_call("getState", json!([])).await?;
            ensure_current_pairing(context, request_generation)?;
            let attachment_context = RemoteAttachmentContext::from_state(&remote_state);
            let kind = header_text(headers, "x-snow-attachment-kind")
                .and_then(|value| AttachmentKind::from_header(&value))
                .ok_or_else(|| api_error_from_attach(AttachError::Code(attachments::ERR_INVALID_KIND)))?;
            let mime_type = header_text(headers, "content-type")
                .unwrap_or_default()
                .split(';')
                .next()
                .unwrap_or_default()
                .trim()
                .to_ascii_lowercase();
            let file_name =
                header_text(headers, "x-snow-file-name").unwrap_or_else(|| "attachment".to_string());
            let declared_length = match header_text(headers, "content-length") {
                None => None,
                Some(raw) => raw.trim().parse::<u64>().ok(),
            };
            let body = body.take().unwrap_or_else(Body::empty);
            let summary = attachments::save_attachment(
                kind,
                &mime_type,
                &file_name,
                declared_length,
                body,
                attachment_context,
                request_generation,
            )
            .await
            .map_err(api_error_from_attach)?;
            ensure_current_pairing(context, request_generation)?;
            Ok::<Response<Body>, ApiError>(json_response(
                StatusCode::CREATED,
                &summary.to_json(),
                Vec::new(),
            ))
        }
        .await;
        send_tracker::release();
        return result;
    }

    if method == Method::DELETE && path.starts_with("/api/attachments/") {
        let Some(id) = percent_decode(&path["/api/attachments/".len()..]) else {
            return Ok(json_response(
                StatusCode::BAD_REQUEST,
                &json!({ "error": "附件标识无效" }),
                Vec::new(),
            ));
        };
        if !is_bounded_string(&id, false) {
            return Ok(json_response(
                StatusCode::BAD_REQUEST,
                &json!({ "error": "附件标识无效" }),
                Vec::new(),
            ));
        }
        let remote_state = bridge_call("getState", json!([])).await?;
        ensure_current_pairing(context, request_generation)?;
        let attachment_context = RemoteAttachmentContext::from_state(&remote_state);
        attachments::discard(&id, &attachment_context, request_generation).await;
        return Ok(json_response(
            StatusCode::OK,
            &json!({ "ok": true }),
            Vec::new(),
        ));
    }

    if method == Method::POST && path == "/api/send" {
        if !is_json_request(headers) {
            return Ok(json_response(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                &json!({ "error": "Content-Type 必须是 application/json" }),
                Vec::new(),
            ));
        }
        let payload = read_json_body(body.take()).await?;
        let Some(text) = payload.get("text").and_then(Value::as_str) else {
            return Ok(json_response(
                StatusCode::BAD_REQUEST,
                &json!({ "error": "text 必须是字符串" }),
                Vec::new(),
            ));
        };
        let attachment_ids = match string_array_field(payload.get("attachmentIds")) {
            Some(items) => items,
            None => {
                return Ok(json_response(
                    StatusCode::BAD_REQUEST,
                    &json!({ "error": "附件或请求标识无效" }),
                    Vec::new(),
                ))
            }
        };
        let request_id = payload.get("requestId").and_then(Value::as_str);
        let ids_valid = attachment_ids
            .iter()
            .all(|id| is_bounded_string(id, false))
            && attachment_ids.len() <= MAX_SEND_ATTACHMENTS;
        let valid = ids_valid
            && request_id
                .map(|value| is_bounded_string(value, false))
                .unwrap_or(false);
        if !valid {
            return Ok(json_response(
                StatusCode::BAD_REQUEST,
                &json!({ "error": "附件或请求标识无效" }),
                Vec::new(),
            ));
        }
        let request_id = request_id.unwrap_or_default().to_string();
        ensure_current_pairing(context, request_generation)?;
        if let Some(cached) = completed_send_result(&request_id, request_generation) {
            return Ok(json_response(StatusCode::OK, &cached, Vec::new()));
        }
        let result = dispatch_remote_send(
            context,
            text.to_string(),
            attachment_ids,
            request_id,
            request_generation,
        )
        .await?;
        return Ok(json_response(StatusCode::OK, &result, Vec::new()));
    }

    if method == Method::POST && path == "/api/abort" {
        if !is_json_request(headers) {
            return Ok(json_response(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                &json!({ "error": "Content-Type 必须是 application/json" }),
                Vec::new(),
            ));
        }
        let _ = read_json_body(body.take()).await?;
        let value = bridge_call("abort", json!([])).await?;
        return Ok(json_response(StatusCode::OK, &value, Vec::new()));
    }

    if method == Method::POST && path == "/api/pending" {
        if !is_json_request(headers) {
            return Ok(json_response(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                &json!({ "error": "Content-Type 必须是 application/json" }),
                Vec::new(),
            ));
        }
        let payload = read_json_body(body.take()).await?;
        let action = payload.get("action").and_then(Value::as_str);
        let index = payload.get("index").and_then(Value::as_i64);
        let queue_key = payload.get("queueKey");
        let valid_action = matches!(action, Some("send-now") | Some("withdraw"));
        if !valid_action {
            return Ok(json_response(
                StatusCode::BAD_REQUEST,
                &json!({ "error": "action 必须是 send-now 或 withdraw" }),
                Vec::new(),
            ));
        }
        let Some(index) = index.filter(|value| *value >= 0) else {
            return Ok(json_response(
                StatusCode::BAD_REQUEST,
                &json!({ "error": "index 必须是非负整数" }),
                Vec::new(),
            ));
        };
        let queue_key = match queue_key {
            None | Some(Value::Null) => Value::Null,
            Some(Value::String(text)) if is_bounded_string(text, false) => {
                Value::String(text.clone())
            }
            _ => {
                return Ok(json_response(
                    StatusCode::BAD_REQUEST,
                    &json!({ "error": "queueKey 必须是字符串或 null" }),
                    Vec::new(),
                ))
            }
        };
        ensure_current_pairing(context, request_generation)?;
        let bridge_action = if action == Some("send-now") {
            "sendPendingNow"
        } else {
            "withdrawPending"
        };
        let value = bridge_call(bridge_action, json!([index, queue_key])).await?;
        return Ok(json_response(StatusCode::OK, &value, Vec::new()));
    }

    if method == Method::POST && path == "/api/new-chat" {
        if !is_json_request(headers) {
            return Ok(json_response(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                &json!({ "error": "Content-Type 必须是 application/json" }),
                Vec::new(),
            ));
        }
        let _ = read_json_body(body.take()).await?;
        let value = bridge_call("newChat", json!([])).await?;
        return Ok(json_response(StatusCode::OK, &value, Vec::new()));
    }

    if method == Method::POST && path == "/api/todos" {
        if !is_json_request(headers) {
            return Ok(json_response(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                &json!({ "error": "Content-Type 必须是 application/json" }),
                Vec::new(),
            ));
        }
        let payload = read_json_body(body.take()).await?;
        let action = payload.get("action").and_then(Value::as_str);
        let content = payload.get("content").and_then(Value::as_str);
        let todo_id = payload.get("todoId").and_then(Value::as_str);
        let status = payload.get("status").and_then(Value::as_str);
        let is_add = action == Some("add");
        let is_update = action == Some("update");
        let is_delete = action == Some("delete");
        let valid = (is_add || is_update || is_delete)
            && (!is_add || content.map(is_todo_content).unwrap_or(false))
            && (is_add || todo_id.map(|value| is_bounded_string(value, false)).unwrap_or(false))
            && (!is_update || status.map(is_todo_status).unwrap_or(false));
        if !valid {
            return Ok(json_response(
                StatusCode::BAD_REQUEST,
                &json!({ "error": "待办请求无效" }),
                Vec::new(),
            ));
        }
        ensure_current_pairing(context, request_generation)?;
        // 未提供的字段直接省略（与旧实现 undefined 字段被 JSON 丢弃一致）。
        let mut payload_object = serde_json::Map::new();
        if is_add {
            if let Some(value) = content {
                payload_object.insert("content".to_string(), Value::String(value.to_string()));
            }
        } else {
            if let Some(value) = todo_id {
                payload_object.insert("todoId".to_string(), Value::String(value.to_string()));
            }
            if is_update {
                if let Some(value) = status {
                    payload_object.insert("status".to_string(), Value::String(value.to_string()));
                }
            }
        }
        let value = bridge_call(
            "mutateTodos",
            json!([action, Value::Object(payload_object)]),
        )
        .await?;
        return Ok(json_response(StatusCode::OK, &value, Vec::new()));
    }

    if method == Method::POST && path == "/api/workflow" {
        if !is_json_request(headers) {
            return Ok(json_response(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                &json!({ "error": "Content-Type 必须是 application/json" }),
                Vec::new(),
            ));
        }
        let payload = read_json_body(body.take()).await?;
        let action = payload.get("action").and_then(Value::as_str);
        let flow_id = payload.get("flowId").and_then(Value::as_str);
        let message = payload.get("message").and_then(Value::as_str);
        let is_run = action == Some("run");
        let is_reply = action == Some("reply");
        let valid = (is_run || is_reply)
            && flow_id
                .map(|value| is_bounded_string(value, false))
                .unwrap_or(false)
            && (!is_reply || message.map(is_workflow_reply).unwrap_or(false));
        if !valid {
            return Ok(json_response(
                StatusCode::BAD_REQUEST,
                &json!({ "error": "工作流请求无效" }),
                Vec::new(),
            ));
        }
        ensure_current_pairing(context, request_generation)?;
        // 执行在渲染进程后台运行（立即返回，进度由 /api/state 轮询），
        // 反馈直接结算挂起的工具调用；两者都与桌面卡片按钮同语义。
        let value = if is_run {
            bridge_call("runWorkflow", json!([flow_id])).await?
        } else {
            bridge_call("replyWorkflow", json!([flow_id, message])).await?
        };
        return Ok(json_response(StatusCode::OK, &value, Vec::new()));
    }

    if method == Method::GET && path == "/api/rollback" {
        ensure_current_pairing(context, request_generation)?;
        let value = bridge_call("getRollbackState", json!([])).await?;
        return Ok(json_response(StatusCode::OK, &value, Vec::new()));
    }

    if method == Method::POST && path == "/api/rollback" {
        if !is_json_request(headers) {
            return Ok(json_response(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                &json!({ "error": "Content-Type 必须是 application/json" }),
                Vec::new(),
            ));
        }
        let payload = read_json_body(body.take()).await?;
        let action = payload.get("action").and_then(Value::as_str);

        if action == Some("diff") || action == Some("diff-page") {
            // 文件变更直接在原生侧计算：与桌面共用同一套检查点服务（含
            // SSH/SFTP 通道与执行级目录锁），无需把渲染进程拉进这次只读查询。
            // diff 返回文件摘要列表；diff-page 按文件读取明细的首页。
            let Some(work_dir) = payload
                .get("workDir")
                .and_then(Value::as_str)
                .filter(|value| is_bounded_string(value, false))
            else {
                return Ok(json_response(
                    StatusCode::BAD_REQUEST,
                    &json!({ "error": "回滚工作目录无效" }),
                    Vec::new(),
                ));
            };
            let checkpoint_ids = payload
                .get("checkpointIds")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect::<Vec<String>>()
                })
                .filter(|ids| {
                    !ids.is_empty()
                        && ids.len() <= MAX_ROLLBACK_CHECKPOINTS
                        && ids.iter().all(|id| is_checkpoint_id(id))
                });
            let Some(checkpoint_ids) = checkpoint_ids else {
                return Ok(json_response(
                    StatusCode::BAD_REQUEST,
                    &json!({ "error": "回滚检查点无效" }),
                    Vec::new(),
                ));
            };
            let to_conflict = |error: napi::Error| {
                ApiError::conflict(truncate_chars(&error.to_string(), MAX_IDENTIFIER_LENGTH))
            };

            if action == Some("diff-page") {
                let Some(file_path) = payload
                    .get("path")
                    .and_then(Value::as_str)
                    .filter(|value| is_bounded_string(value, false))
                else {
                    return Ok(json_response(
                        StatusCode::BAD_REQUEST,
                        &json!({ "error": "回滚文件路径无效" }),
                        Vec::new(),
                    ));
                };
                ensure_current_pairing(context, request_generation)?;
                let page = crate::exports::checkpoint::read_checkpoint_diff_page(
                    checkpoint_ids,
                    work_dir.to_string(),
                    file_path.to_string(),
                    0,
                    MAX_ROLLBACK_DIFF_ROWS,
                    MAX_ROLLBACK_DIFF_BYTES,
                )
                .await
                .map_err(to_conflict)?;
                return Ok(json_response(
                    StatusCode::OK,
                    &json!({
                        "content": page.content,
                        "isBinary": page.is_binary,
                        "tooLarge": page.too_large,
                        "truncated": page.next_row < page.total_rows,
                    }),
                    Vec::new(),
                ));
            }

            ensure_current_pairing(context, request_generation)?;
            // include_all=false：与确认回滚时实际会恢复的文件范围一致。
            let summaries = crate::exports::checkpoint::list_checkpoint_summaries_batch(
                checkpoint_ids,
                work_dir.to_string(),
                Some(false),
            )
            .await
            .map_err(to_conflict)?;
            let items: Vec<Value> = summaries
                .into_iter()
                .take(MAX_ROLLBACK_DIFF_FILES)
                .map(|summary| {
                    json!({
                        "path": summary.path,
                        "changeType": summary.change_type,
                        "isBinary": summary.is_binary,
                        "tooLarge": summary.too_large,
                        "additions": summary.additions,
                        "deletions": summary.deletions,
                    })
                })
                .collect();
            return Ok(json_response(
                StatusCode::OK,
                &json!({ "files": items }),
                Vec::new(),
            ));
        }

        let Some(message_id) = payload
            .get("messageId")
            .and_then(Value::as_str)
            .filter(|value| is_bounded_string(value, false))
        else {
            return Ok(json_response(
                StatusCode::BAD_REQUEST,
                &json!({ "error": "回滚目标无效" }),
                Vec::new(),
            ));
        };
        if !matches!(
            action,
            Some("preview") | Some("confirm") | Some("cancel")
        ) {
            return Ok(json_response(
                StatusCode::BAD_REQUEST,
                &json!({ "error": "action 必须是 preview / confirm / cancel / diff / diff-page" }),
                Vec::new(),
            ));
        }
        ensure_current_pairing(context, request_generation)?;
        let value = match action {
            Some("preview") => bridge_call("startRollback", json!([message_id])).await?,
            Some("cancel") => bridge_call("cancelRollback", json!([message_id])).await?,
            _ => {
                let mode = payload.get("mode").and_then(Value::as_str);
                let Some(mode) = mode.filter(|value| is_rollback_mode(value)) else {
                    return Ok(json_response(
                        StatusCode::BAD_REQUEST,
                        &json!({ "error": "回滚方式无效" }),
                        Vec::new(),
                    ));
                };
                let delete_memories = payload
                    .get("deleteMemories")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                bridge_call("confirmRollback", json!([message_id, mode, delete_memories])).await?
            }
        };
        return Ok(json_response(StatusCode::OK, &value, Vec::new()));
    }

    if method == Method::POST && path == "/api/mode" {
        if !is_json_request(headers) {
            return Ok(json_response(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                &json!({ "error": "Content-Type 必须是 application/json" }),
                Vec::new(),
            ));
        }
        let payload = read_json_body(body.take()).await?;
        let mode = payload.get("mode").and_then(Value::as_str);
        let Some(mode) = mode.filter(|value| is_remote_mode(value)) else {
            return Ok(json_response(
                StatusCode::BAD_REQUEST,
                &json!({ "error": format!("mode 必须是 {} 之一", REMOTE_MODES.join(" / ")) }),
                Vec::new(),
            ));
        };
        let enabled = match payload.get("enabled") {
            None => true,
            Some(Value::Bool(value)) => *value,
            Some(_) => {
                return Ok(json_response(
                    StatusCode::BAD_REQUEST,
                    &json!({ "error": "enabled 必须是布尔值" }),
                    Vec::new(),
                ))
            }
        };
        let value = bridge_call("setMode", json!([mode, enabled])).await?;
        return Ok(json_response(StatusCode::OK, &value, Vec::new()));
    }

    // 应用级开关：工具失败自动纠错（与桌面 PlusMenu 同一偏好源）。
    if method == Method::POST && path == "/api/tool-correction" {
        if !is_json_request(headers) {
            return Ok(json_response(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                &json!({ "error": "Content-Type 必须是 application/json" }),
                Vec::new(),
            ));
        }
        let payload = read_json_body(body.take()).await?;
        let enabled = match payload.get("enabled") {
            Some(Value::Bool(value)) => *value,
            Some(_) => {
                return Ok(json_response(
                    StatusCode::BAD_REQUEST,
                    &json!({ "error": "enabled 必须是布尔值" }),
                    Vec::new(),
                ))
            }
            None => {
                return Ok(json_response(
                    StatusCode::BAD_REQUEST,
                    &json!({ "error": "enabled 必填且必须是布尔值" }),
                    Vec::new(),
                ))
            }
        };
        let value = bridge_call("setToolCorrection", json!([enabled])).await?;
        return Ok(json_response(StatusCode::OK, &value, Vec::new()));
    }

    if method == Method::POST && path == "/api/command" {
        if !is_json_request(headers) {
            return Ok(json_response(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                &json!({ "error": "Content-Type 必须是 application/json" }),
                Vec::new(),
            ));
        }
        let payload = read_json_body(body.take()).await?;
        let command_id = payload.get("commandId").and_then(Value::as_str);
        if command_id.map(|value| is_bounded_string(value, false)) != Some(true) {
            return Ok(json_response(
                StatusCode::BAD_REQUEST,
                &json!({ "error": format!("commandId 必须是长度不超过 {MAX_IDENTIFIER_LENGTH} 的非空字符串") }),
                Vec::new(),
            ));
        }
        let value = bridge_call("runCommand", json!([command_id])).await?;
        return Ok(json_response(StatusCode::OK, &value, Vec::new()));
    }

    if method == Method::POST && path == "/api/model" {
        if !is_json_request(headers) {
            return Ok(json_response(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                &json!({ "error": "Content-Type 必须是 application/json" }),
                Vec::new(),
            ));
        }
        let payload = read_json_body(body.take()).await?;
        let provided: Vec<&str> = ["model", "profile", "thinkingStrength", "responsesFastMode"]
            .into_iter()
            .filter(|key| payload.get(*key).is_some())
            .collect();
        if provided.len() != 1 {
            return Ok(json_response(
                StatusCode::BAD_REQUEST,
                &json!({ "error": "每次只能修改 model / profile / thinkingStrength / responsesFastMode 中的一项" }),
                Vec::new(),
            ));
        }
        match provided[0] {
            "model" => {
                let model = payload.get("model").and_then(Value::as_str);
                if model.map(|value| is_bounded_string(value, false)) != Some(true) {
                    return Ok(json_response(
                        StatusCode::BAD_REQUEST,
                        &json!({ "error": format!("model 必须是长度不超过 {MAX_IDENTIFIER_LENGTH} 的非空字符串") }),
                        Vec::new(),
                    ));
                }
                let value = bridge_call("setModel", json!([model])).await?;
                return Ok(json_response(StatusCode::OK, &value, Vec::new()));
            }
            "profile" => {
                let profile = payload.get("profile").and_then(Value::as_str);
                if profile.map(|value| is_bounded_string(value, false)) != Some(true) {
                    return Ok(json_response(
                        StatusCode::BAD_REQUEST,
                        &json!({ "error": format!("profile 必须是长度不超过 {MAX_IDENTIFIER_LENGTH} 的非空字符串") }),
                        Vec::new(),
                    ));
                }
                let value = bridge_call("setApiProfile", json!([profile])).await?;
                return Ok(json_response(StatusCode::OK, &value, Vec::new()));
            }
            "thinkingStrength" => {
                // 空串是合法值：表示继承 Profile 默认推理强度。
                let thinking = payload.get("thinkingStrength").and_then(Value::as_str);
                if thinking.map(|value| is_bounded_string(value, true)) != Some(true) {
                    return Ok(json_response(
                        StatusCode::BAD_REQUEST,
                        &json!({ "error": format!("thinkingStrength 必须是长度不超过 {MAX_IDENTIFIER_LENGTH} 的字符串") }),
                        Vec::new(),
                    ));
                }
                let value = bridge_call("setThinking", json!([thinking])).await?;
                return Ok(json_response(StatusCode::OK, &value, Vec::new()));
            }
            _ => {
                let fast_mode = match payload.get("responsesFastMode") {
                    Some(Value::String(text))
                        if matches!(text.trim(), "off" | "fast" | "ultrafast") =>
                    {
                        Value::String(text.trim().to_string())
                    }
                    _ => {
                        return Ok(json_response(
                            StatusCode::BAD_REQUEST,
                            &json!({ "error": "responsesFastMode 必须是 off / fast / ultrafast" }),
                            Vec::new(),
                        ));
                    }
                };
                let value = bridge_call("toggleResponsesFastMode", json!([fast_mode])).await?;
                return Ok(json_response(StatusCode::OK, &value, Vec::new()));
            }
        }
    }

    if method == Method::POST && path == "/api/select" {
        if !is_json_request(headers) {
            return Ok(json_response(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                &json!({ "error": "Content-Type 必须是 application/json" }),
                Vec::new(),
            ));
        }
        let payload = read_json_body(body.take()).await?;
        let conversation_id = payload.get("conversationId").and_then(Value::as_str);
        let directory_arg = match payload.get("directoryId") {
            None => Value::Null,
            Some(Value::String(text)) => Value::String(text.clone()),
            Some(_) => Value::Null,
        };
        let directory_valid = match payload.get("directoryId") {
            None => true,
            Some(Value::String(_)) => true,
            Some(_) => false,
        };
        if conversation_id.is_none() || !directory_valid {
            return Ok(json_response(
                StatusCode::BAD_REQUEST,
                &json!({ "error": "会话参数无效" }),
                Vec::new(),
            ));
        }
        let value = bridge_call("select", json!([conversation_id, directory_arg])).await?;
        return Ok(json_response(StatusCode::OK, &value, Vec::new()));
    }

    if method == Method::POST && path == "/api/authorization" {
        if !is_json_request(headers) {
            return Ok(json_response(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                &json!({ "error": "Content-Type 必须是 application/json" }),
                Vec::new(),
            ));
        }
        let payload = read_json_body(body.take()).await?;
        let authorization_id = payload.get("authorizationId").and_then(Value::as_str);
        let decision = payload.get("decision").and_then(Value::as_str);
        let reason = match payload.get("reason") {
            None => None,
            Some(Value::String(text)) => Some(text.clone()),
            Some(_) => {
                return Ok(json_response(
                    StatusCode::BAD_REQUEST,
                    &json!({ "error": "授权参数无效" }),
                    Vec::new(),
                ))
            }
        };
        let valid = authorization_id.is_some() && matches!(decision, Some("approve") | Some("reject"));
        if !valid {
            return Ok(json_response(
                StatusCode::BAD_REQUEST,
                &json!({ "error": "授权参数无效" }),
                Vec::new(),
            ));
        }
        let value = if decision == Some("approve") {
            bridge_call("approve", json!([authorization_id])).await?
        } else {
            bridge_call("reject", json!([authorization_id, reason])).await?
        };
        return Ok(json_response(StatusCode::OK, &value, Vec::new()));
    }

    if method == Method::POST && path == "/api/question" {
        if !is_json_request(headers) {
            return Ok(json_response(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                &json!({ "error": "Content-Type 必须是 application/json" }),
                Vec::new(),
            ));
        }
        let payload = read_json_body(body.take()).await?;
        let question_id = payload.get("questionId").and_then(Value::as_str);
        let action = payload.get("action").and_then(Value::as_str);
        let selected_options = string_array_field(payload.get("selectedOptions"));
        let custom_answers = string_array_field(payload.get("customAnswers"));
        let valid = question_id.is_some()
            && matches!(action, Some("answer") | Some("cancel"))
            && selected_options
                .as_ref()
                .map(|items| items.len() <= 20)
                .unwrap_or(false)
            && custom_answers
                .as_ref()
                .map(|items| items.len() <= 20)
                .unwrap_or(false);
        if !valid {
            return Ok(json_response(
                StatusCode::BAD_REQUEST,
                &json!({ "error": "回答参数无效" }),
                Vec::new(),
            ));
        }
        let value = if action == Some("cancel") {
            bridge_call("cancelQuestion", json!([question_id])).await?
        } else {
            bridge_call(
                "answer",
                json!([question_id, selected_options, custom_answers]),
            )
            .await?
        };
        return Ok(json_response(StatusCode::OK, &value, Vec::new()));
    }

    Ok(json_response(
        StatusCode::NOT_FOUND,
        &json!({ "error": "接口不存在" }),
        Vec::new(),
    ))
}

/// 派发一次远程发送：绑定当前上下文、消费附件并缓存幂等结果。
async fn dispatch_remote_send(
    context: &ServerContext,
    text: String,
    attachment_ids: Vec<String>,
    request_id: String,
    generation: u64,
) -> Result<Value, ApiError> {
    send_tracker::acquire();
    let result = async {
        ensure_current_pairing(context, generation)?;
        let remote_state = bridge_call("getState", json!([])).await?;
        ensure_current_pairing(context, generation)?;
        let attachment_context = RemoteAttachmentContext::from_state(&remote_state);
        let value = bridge_call(
            "send",
            json!([
                text,
                attachment_ids,
                request_id,
                attachment_context.to_json(),
                generation
            ]),
        )
        .await?;
        attachments::mark_consumed(&attachment_ids, &attachment_context, generation)
            .await
            .map_err(api_error_from_attach)?;
        store_completed_send(request_id, generation, value.clone());
        Ok::<Value, ApiError>(value)
    }
    .await;
    send_tracker::release();
    result
}

/// 校验桥返回的图片载荷（MIME 白名单 + 非空 base64）。
fn parse_image_payload(value: &Value) -> Option<(String, Vec<u8>)> {
    let mime_type = value.get("mimeType").and_then(Value::as_str)?;
    if !MESSAGE_IMAGE_TYPES.contains(&mime_type) {
        return None;
    }
    let base64 = value.get("base64").and_then(Value::as_str)?;
    if base64.is_empty() {
        return None;
    }
    let bytes = BASE64_STANDARD.decode(base64).ok()?;
    Some((mime_type.to_string(), bytes))
}

/// 解析消息图片：优先从桌面渲染进程的会话内存取（覆盖尚未落库的即时
/// 消息），失败时回退到 Rust 数据库 + upload 磁盘解析。
async fn resolve_message_image(message_id: &str, image_index: i64) -> Option<(String, Vec<u8>)> {
    if let Ok(value) = bridge::call("getMessageImage", json!([message_id, image_index])).await {
        if let Some(result) = parse_image_payload(&value) {
            return Some(result);
        }
    }
    let owned_id = message_id.to_string();
    let stored = tokio::task::spawn_blocking(move || {
        crate::storage::get_chat_message_image(owned_id, image_index as i32)
    })
    .await
    .ok()?
    .ok()??;
    if !MESSAGE_IMAGE_TYPES.contains(&stored.mime_type.as_str()) || stored.base64.is_empty() {
        return None;
    }
    let bytes = BASE64_STANDARD.decode(stored.base64).ok()?;
    Some((stored.mime_type, bytes))
}

/// 等待在途 send 派发结束（轮换凭据 / 停止服务时使用）。
pub async fn wait_send_idle() {
    send_tracker::wait_idle(SEND_IDLE_TIMEOUT).await;
}
