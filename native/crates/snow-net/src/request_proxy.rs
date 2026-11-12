//! 对话请求代理层。
//!
//! 对话流（`createResponseStream`）发出 HTTP 请求前，请求体先交给 Electron 主进程中
//! 用户可编辑的代理脚本（`onRequest`）；SSE 响应的每个事件在送达各协议解析器前交给
//! 脚本（`onResponseEvent`）。Rust 只负责派发、超时、取消与直通；脚本运行在主进程的
//! JS 回调里并通过 Promise 异步回复，Rust 端全程以异步等待代替阻塞。
//!
//! 会话上下文经 task-local 绑定到对话流 future 上，因此各协议实现只需调用
//! `transform_request` / `wrap_response_stream`，无需改动函数签名。没有注册脚本回调、
//! 不在对话流内（摘要、图片生成、文件检索代理等）或回调失败时，全部原样放行。

use std::{
    collections::VecDeque,
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::Duration,
};

use futures::{Stream, StreamExt};
use napi::{bindgen_prelude::*, threadsafe_function::ThreadsafeFunction};
use serde_json::{json, Value};

use snow_runtime::cancel;
use crate::sse::find_sse_separator;
use snow_storage_core::app_logs::{insert_app_log, AppLogInput};

/// 主进程注册的代理回调：入参为 JSON 字符串，返回 Promise<JSON 字符串>。
pub type RequestProxyCallback = ThreadsafeFunction<String, Promise<String>, String, Status, false>;

/// 对话流统一的网络字节流输出（SSE 解析器按 `Vec<u8>` 消费）。
pub type ByteStream = Pin<Box<dyn Stream<Item = reqwest::Result<Vec<u8>>> + Send>>;

const REQUEST_HOOK_TIMEOUT: Duration = Duration::from_secs(15);
const RESPONSE_EVENT_HOOK_TIMEOUT: Duration = Duration::from_secs(5);

static HANDLER: OnceLock<Mutex<Option<Arc<RequestProxyCallback>>>> = OnceLock::new();

/// 主进程是否检测到可用的代理脚本。脚本不存在时请求阶段直接放行，不再把
/// 整个请求体序列化、跨线程传输、再在主进程解析一遍（长上下文可达数 MB）。
static ENABLED: AtomicBool = AtomicBool::new(true);

fn handler_slot() -> &'static Mutex<Option<Arc<RequestProxyCallback>>> {
    HANDLER.get_or_init(|| Mutex::new(None))
}

/// 由主进程在脚本出现/消失时调用。默认 `true`，保持没有该通知时的旧行为。
pub fn set_enabled(enabled: bool) {
    ENABLED.store(enabled, Ordering::Relaxed);
}

fn current_handler() -> Option<Arc<RequestProxyCallback>> {
    handler_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

/// 注册（或清除）代理回调。主进程初始化时调用一次。
pub fn set_handler(handler: Option<RequestProxyCallback>) {
    *handler_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = handler.map(Arc::new);
}

/// 单条对话流的代理会话。`response_hook` 由请求阶段的脚本回复决定：脚本未导出
/// `onResponseEvent` 时不包装响应流，避免无意义的逐事件往返。
pub struct ProxySession {
    stream_id: String,
    conversation_id: Option<String>,
    response_hook: AtomicBool,
}

impl ProxySession {
    pub fn new(stream_id: String, conversation_id: Option<String>) -> Self {
        Self {
            stream_id,
            conversation_id,
            response_hook: AtomicBool::new(false),
        }
    }
}

tokio::task_local! {
    static SESSION: Arc<ProxySession>;
}

/// 在对话流 future 上绑定代理会话（由 `create_response_stream` 入口调用）。
pub async fn with_session<F: Future>(session: ProxySession, future: F) -> F::Output {
    SESSION.scope(Arc::new(session), future).await
}

fn current_session() -> Option<Arc<ProxySession>> {
    SESSION.try_with(|session| Arc::clone(session)).ok()
}

fn context_json(session: &ProxySession, provider: &str) -> Value {
    json!({
        "streamId": &session.stream_id,
        "conversationId": &session.conversation_id,
        "provider": provider,
    })
}

fn framed(event: &str) -> Vec<u8> {
    format!("{event}\n\n").into_bytes()
}

/// 脚本失败与超时记入应用日志；写库放在阻塞线程，不占用异步运行时。
fn log_warning(stream_id: &str, message: String) {
    let context = json!({ "streamId": stream_id }).to_string();
    tokio::task::spawn_blocking(move || {
        let Ok(database_path) = snow_storage_core::bootstrap::ensure_database_file() else {
            return;
        };
        let _ = insert_app_log(
            &database_path,
            &AppLogInput {
                level: "WARN".to_string(),
                module: "api".to_string(),
                func: "request_proxy".to_string(),
                line: None,
                message,
                input: None,
                output: None,
                duration: None,
                context: Some(context),
                error: None,
                source: "main".to_string(),
            },
        );
    });
}

async fn invoke_hook(
    handler: &RequestProxyCallback,
    message: String,
) -> std::result::Result<Value, String> {
    let promise = handler
        .call_async_catch(message)
        .await
        .map_err(|error| error.to_string())?;
    let reply = promise.await.map_err(|error| error.to_string())?;
    serde_json::from_str::<Value>(&reply).map_err(|error| error.to_string())
}

/// 调用脚本钩子并异步等待回复。流被取消、超时或调用失败时返回 None，调用方原样放行。
async fn call_hook(
    handler: &RequestProxyCallback,
    message: String,
    timeout: Duration,
    session: &ProxySession,
) -> Option<Value> {
    let cancel_token = cancel::get_token(&session.stream_id)?;
    tokio::select! {
        biased;
        _ = cancel_token.cancelled() => None,
        outcome = tokio::time::timeout(timeout, invoke_hook(handler, message)) => {
            match outcome {
                Ok(Ok(reply)) => Some(reply),
                Ok(Err(error)) => {
                    log_warning(&session.stream_id, format!("request proxy hook failed: {error}"));
                    None
                }
                Err(_) => {
                    log_warning(
                        &session.stream_id,
                        format!("request proxy hook timed out after {}s", timeout.as_secs()),
                    );
                    None
                }
            }
        }
    }
}

/// 请求体发出前的代理点。返回脚本替换后的请求体；无脚本、无会话或失败时返回原样。
/// 同时决定本次对话流是否需要逐事件处理响应（见 `ProxySession::response_hook`）。
pub async fn transform_request(provider: &'static str, payload: Value) -> Value {
    if !ENABLED.load(Ordering::Relaxed) {
        return payload;
    }
    let Some(session) = current_session() else {
        return payload;
    };
    let Some(handler) = current_handler() else {
        return payload;
    };
    let message = json!({
        "stage": "request",
        "context": context_json(&session, provider),
        "body": &payload,
    })
    .to_string();
    let Some(reply) = call_hook(&handler, message, REQUEST_HOOK_TIMEOUT, &session).await else {
        return payload;
    };
    if reply.get("responseEvents").and_then(Value::as_bool) == Some(true) {
        session.response_hook.store(true, Ordering::Relaxed);
    }
    match reply.get("body") {
        Some(body) if body.is_object() => body.clone(),
        _ => payload,
    }
}

struct ResponseHookState<S> {
    inner: S,
    session: Arc<ProxySession>,
    handler: Arc<RequestProxyCallback>,
    provider: &'static str,
    buffer: Vec<u8>,
    pending: VecDeque<Vec<u8>>,
    finished: bool,
}

impl<S> ResponseHookState<S> {
    /// 处理一个完整 SSE 事件块：脚本返回字符串则替换、返回 null 则丢弃、缺省则原样放行。
    async fn process_event(&mut self, event: String) {
        if event.trim().is_empty() {
            self.pending.push_back(framed(&event));
            return;
        }
        let message = json!({
            "stage": "response",
            "context": context_json(&self.session, self.provider),
            "event": &event,
        })
        .to_string();
        let Some(reply) = call_hook(
            &self.handler,
            message,
            RESPONSE_EVENT_HOOK_TIMEOUT,
            &self.session,
        )
        .await
        else {
            // 失败或取消：本事件原样放行，并停用本流后续事件的钩子，避免每个事件都等待超时。
            self.session.response_hook.store(false, Ordering::Relaxed);
            self.pending.push_back(framed(&event));
            return;
        };
        match reply.get("event") {
            Some(Value::Null) => {}
            Some(Value::String(replacement)) => self.pending.push_back(framed(replacement)),
            _ => self.pending.push_back(framed(&event)),
        }
    }

    async fn drain_events(&mut self) {
        while let Some((separator_index, separator_len)) = find_sse_separator(&self.buffer) {
            let event = String::from_utf8_lossy(&self.buffer[..separator_index]).into_owned();
            self.buffer.drain(..separator_index + separator_len);
            self.process_event(event).await;
        }
    }

    async fn flush_trailing(&mut self) {
        let trailing = std::mem::take(&mut self.buffer);
        if trailing.iter().all(|byte| byte.is_ascii_whitespace()) {
            return;
        }
        let event = String::from_utf8_lossy(&trailing).into_owned();
        self.process_event(event).await;
    }
}

async fn next_response_chunk<S, T>(
    mut state: ResponseHookState<S>,
) -> Option<(reqwest::Result<Vec<u8>>, ResponseHookState<S>)>
where
    S: Stream<Item = reqwest::Result<T>> + Unpin,
    T: AsRef<[u8]>,
{
    loop {
        if let Some(chunk) = state.pending.pop_front() {
            return Some((Ok(chunk), state));
        }
        if state.finished {
            return None;
        }
        match state.inner.next().await {
            Some(Ok(bytes)) => {
                state.buffer.extend_from_slice(bytes.as_ref());
                state.drain_events().await;
            }
            Some(Err(error)) => {
                state.finished = true;
                return Some((Err(error), state));
            }
            None => {
                state.finished = true;
                state.flush_trailing().await;
            }
        }
    }
}

/// 响应字节流的代理点。仅当本次对话流启用了响应钩子时才按 SSE 事件切分并逐个交给脚本，
/// 否则直通（统一输出为 `Vec<u8>`）。非 SSE 响应在流结束时整体作为一个事件处理。
pub fn wrap_response_stream<S, T>(provider: &'static str, stream: S) -> ByteStream
where
    S: Stream<Item = reqwest::Result<T>> + Send + Unpin + 'static,
    T: AsRef<[u8]> + Send + 'static,
{
    let hooked = current_session()
        .filter(|session| session.response_hook.load(Ordering::Relaxed))
        .zip(current_handler());
    match hooked {
        Some((session, handler)) => Box::pin(futures::stream::unfold(
            ResponseHookState {
                inner: stream,
                session,
                handler,
                provider,
                buffer: Vec::new(),
                pending: VecDeque::new(),
                finished: false,
            },
            |state| next_response_chunk::<S, T>(state),
        )),
        None => Box::pin(stream.map(|chunk| chunk.map(|bytes| bytes.as_ref().to_vec()))),
    }
}
