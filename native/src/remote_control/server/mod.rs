//! 手机远控 HTTP 服务：局域网与公网两个监听器共用同一套请求处理。
//!
//! 原先整套服务由 Node 主进程的 remoteControlServer.ts 承担（node:http、
//! 手写路由与鉴权）。迁移到 Rust 后，TCP 监听、HTTP 解析、鉴权、静态资源、
//! 附件落盘与图片解析全部在原生侧完成；只有需要桌面 UI 实时状态的操作
//! 通过 bridge 派发给 Node → 渲染进程。
//!
//! 路由按业务拆分在 `api/` 子模块；请求管线、访问控制、实时通道各自独立。

mod access;
mod api;
mod limits;
mod pipeline;
mod request;
mod response;
mod socket;

use std::collections::VecDeque;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, RwLock};
use std::time::Duration;

use axum::body::Body;
use axum::extract::{ConnectInfo, State};
use axum::http::{Method, Request, Response, StatusCode};
use axum::Router;
use serde_json::{json, Value};

use limits::{COMPLETED_SEND_CAPACITY, SEND_IDLE_TIMEOUT};

use super::auth::now_ms;
use super::live;

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
    pub wan_auth: Option<Arc<super::auth::WanAuth>>,
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
        Self::new(limits::UNLOCK_FAILURE_WINDOW_MS, limits::MAX_UNLOCK_FAILURES)
    }

    /// 身份验证器动态码解锁失败限流。
    pub const fn codes() -> Self {
        Self::new(limits::CODE_FAILURE_WINDOW_MS, limits::MAX_CODE_FAILURES)
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
        response::json_response(self.status, &json!({ "error": self.message }), Vec::new())
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
    // 对端地址来自 serve 注入的 connect info；缺失时按非本机处理。
    let peer_loopback = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|info| info.0.ip().is_loopback())
        .unwrap_or(false);
    let response = match pipeline::process(&context, request, peer_loopback).await {
        Ok(response) => response,
        Err(error) => error.into_response(),
    };
    // 变更操作后立即刷新实时通道，手机无需等下一拍。
    if mutating {
        live::nudge();
    }
    response
}

/// 等待在途 send 派发结束（轮换凭据 / 停止服务时使用）。
pub async fn wait_send_idle() {
    send_tracker::wait_idle(SEND_IDLE_TIMEOUT).await;
}
