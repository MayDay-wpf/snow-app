//! OAuth 插件响应侧钩子。
//!
//! 三档能力（后一档叠加前一档）：
//! - `transformResponse`：非 SSE 整段响应在协议解析前改写；
//! - `onResponseChunk`：SSE 事件逐条改写；
//! - `fetch`：插件接管传输层，原生层只保留事件解析、usage 记账与取消；返回的 SSE
//!   响应正文由主进程逐块推入（`stream`），事件仍按到达顺序解析，打字机输出保留。
//!
//! 请求上下文由 `record` 在发出请求前写入 task-local 会话；各协议适配器只需在
//! 发送前调用 `takeover`、在响应流处调用 `wrap_stream`。未声明响应钩子的档案
//! 全程直通，行为与未接入前完全一致。

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::StreamExt;
use napi::bindgen_prelude::*;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use super::host;
use super::registry::PluginHooks;
use super::stream;
use crate::api::request_proxy::ByteStream;
use crate::api::sse::find_sse_separator;

const HOOK_TRANSFORM_RESPONSE: &str = "transformResponse";
const HOOK_RESPONSE_CHUNK: &str = "onResponseChunk";
const HOOK_FETCH: &str = "fetch";

/// 整段响应改写：一次性调用，允许较重的处理。
const WHOLE_BODY_HOOK_TIMEOUT: Duration = Duration::from_secs(30);
/// 逐事件改写：单个事件超时后停用钩子，避免每个事件都等超时。
const EVENT_HOOK_TIMEOUT: Duration = Duration::from_secs(15);
/// 传输层接管：插件自己发请求，生成可能持续数分钟。
const FETCH_HOOK_TIMEOUT: Duration = Duration::from_secs(600);
/// 非 SSE 响应需要整段缓冲才能改写，超过上限直接放行。
const MAX_BUFFERED_BYTES: usize = 16 * 1024 * 1024;

/// 本次请求的响应钩子上下文；仅插件档案且声明了至少一个响应钩子时才有。
struct ResponseHook {
    provider: String,
    protocol: &'static str,
    model: String,
    url: String,
    request_headers: Value,
    request_body: Value,
    account: Value,
    hooks: PluginHooks,
    /// 逐事件钩子失败后停用，避免同一请求的后续事件/帧反复等超时。
    chunk_disabled: AtomicBool,
}

/// 插件 `fetch` 钩子返回的合成响应。
pub(crate) enum SyntheticBody {
    /// 整段正文（字符串、`{ body }` 或非事件流 `Response`）：一次交付，按旧行为解析。
    Whole {
        status: u16,
        headers: Vec<(String, String)>,
        body: String,
    },
    /// SSE 正文：主进程读一块推一块，这边以字节流消费，事件一到就上行。
    Stream {
        status: u16,
        headers: Vec<(String, String)>,
        body: ByteStream,
    },
}

/// 待解析的上游响应：原生 HTTP 或插件接管。
pub(crate) enum UpstreamBody {
    Http(reqwest::Response),
    Synthetic(SyntheticBody),
}

struct Session {
    hook: Mutex<Option<Arc<ResponseHook>>>,
}

tokio::task_local! {
    static SESSION: Arc<Session>;
}

/// 在对话流 future 上绑定响应钩子会话。摘要、代码库审查等辅助请求不绑定，
/// 因而不受插件响应钩子影响。
pub(crate) async fn with_session<F: Future>(future: F) -> F::Output {
    SESSION
        .scope(
            Arc::new(Session {
                hook: Mutex::new(None),
            }),
            future,
        )
        .await
}

fn current() -> Option<Arc<ResponseHook>> {
    let session = SESSION.try_with(Arc::clone).ok()?;
    let slot = session
        .hook
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let hook = slot.clone();
    hook
}

/// 钩子失败与超时写入系统日志（模块 `oauthPlugins`）。
async fn log_hook_warning(provider: &str, protocol: &str, message: String) {
    super::log_warning(
        "oauth_plugin_response_hook",
        &message,
        format!("provider={provider} protocol={protocol}"),
    )
    .await;
}

/// 声明整段改写或传输接管的档案只能走 HTTP/SSE 管线：WebSocket 没有整段响应体，
/// 也无法让插件接管连接。
pub(crate) fn requires_http_transport() -> bool {
    current().is_some_and(|hook| hook.hooks.fetch || hook.hooks.transform_response)
}

fn has_response_hooks(hooks: &PluginHooks) -> bool {
    hooks.transform_response || hooks.on_response_chunk || hooks.fetch
}

/// 记录本次请求的响应钩子上下文；无会话或未声明响应钩子时为 no-op。
#[allow(clippy::too_many_arguments)]
pub(super) fn record(
    provider: &str,
    hooks: &PluginHooks,
    protocol: &'static str,
    model: &str,
    url: &str,
    request_headers: &HashMap<String, String>,
    request_body: &Value,
    account: Value,
) {
    if !has_response_hooks(hooks) {
        return;
    }
    let Ok(session) = SESSION.try_with(Arc::clone) else {
        return;
    };
    let hook = ResponseHook {
        provider: provider.to_string(),
        protocol,
        model: model.to_string(),
        url: url.to_string(),
        request_headers: json!(request_headers),
        request_body: request_body.clone(),
        account,
        hooks: hooks.clone(),
        chunk_disabled: AtomicBool::new(false),
    };
    *session
        .hook
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Arc::new(hook));
}

fn header_object(headers: &[(String, String)]) -> Value {
    let mut object = serde_json::Map::new();
    for (name, value) in headers {
        object.insert(name.clone(), Value::String(value.clone()));
    }
    Value::Object(object)
}

fn header_pairs_from_reply(value: Option<&Value>) -> Vec<(String, String)> {
    let Some(object) = value.and_then(Value::as_object) else {
        return Vec::new();
    };
    object
        .iter()
        .filter_map(|(name, value)| {
            value
                .as_str()
                .map(|text| (name.to_ascii_lowercase(), text.to_string()))
        })
        .collect()
}

fn header_pairs_from_response(headers: &reqwest::header::HeaderMap) -> Vec<(String, String)> {
    headers
        .iter()
        .map(|(name, value)| {
            (
                name.as_str().to_ascii_lowercase(),
                value.to_str().unwrap_or_default().to_string(),
            )
        })
        .collect()
}

fn framed(event: &str) -> Vec<u8> {
    format!("{event}\n\n").into_bytes()
}

fn event_data(block: &str) -> Value {
    for line in block.lines() {
        let line = line.trim_start();
        let Some(rest) = line.strip_prefix("data:") else {
            continue;
        };
        let rest = rest.trim_start();
        if rest.is_empty() || rest == "[DONE]" {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(rest) {
            return value;
        }
    }
    Value::Null
}

/// `onResponseChunk` 的返回：`None` 表示原样放行。
fn chunk_blocks(reply: &Value) -> Option<Vec<String>> {
    match reply.get("kind").and_then(Value::as_str) {
        Some("drop") => Some(Vec::new()),
        Some("events") => Some(
            reply
                .get("blocks")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item.as_str().map(str::to_string))
                        .collect::<Vec<String>>()
                })
                .unwrap_or_default(),
        ),
        _ => None,
    }
}

/// 非 SSE 传输（WebSocket 帧）的事件改写结果。
pub(crate) enum EventReply {
    /// 原样使用上游事件。
    Pass,
    /// 替换事件；空数组表示丢弃本事件。
    Events(Vec<Value>),
}

/// 从插件返回的事件块中取出事件对象：优先取第一条 `data:` 行，否则整块按 JSON 解析。
fn event_from_block(block: &str) -> Option<Value> {
    for line in block.lines() {
        let line = line.trim_start();
        let Some(rest) = line.strip_prefix("data:") else {
            continue;
        };
        let rest = rest.trim_start();
        if rest.is_empty() || rest == "[DONE]" {
            continue;
        }
        return serde_json::from_str::<Value>(rest).ok();
    }
    let trimmed = block.trim();
    if trimmed.is_empty() || trimmed.starts_with(':') || trimmed == "[DONE]" {
        return None;
    }
    serde_json::from_str::<Value>(trimmed).ok()
}

/// WebSocket 传输的事件改写入口：ctx 与 SSE 路径一致，`chunk` 仍是 data 块。
pub(crate) async fn rewrite_event(event: &Value, cancel_token: &CancellationToken) -> EventReply {
    let Some(hook) = current() else {
        return EventReply::Pass;
    };
    if !hook.hooks.on_response_chunk || hook.chunk_disabled.load(Ordering::Relaxed) {
        return EventReply::Pass;
    }
    let block = format!("data: {event}");
    let ctx = json!({
        "protocol": hook.protocol,
        "model": &hook.model,
        "url": &hook.url,
        "status": 200,
        "headers": json!({}),
        "account": &hook.account,
        "chunk": &block,
        "data": event,
    });
    let outcome = tokio::select! {
        biased;
        _ = cancel_token.cancelled() => None,
        reply = host::call(HOOK_RESPONSE_CHUNK, &hook.provider, ctx, EVENT_HOOK_TIMEOUT) => Some(reply),
    };
    let reply = match outcome {
        Some(Ok(value)) => value,
        Some(Err(error)) => {
            log_hook_warning(
                &hook.provider,
                hook.protocol,
                format!("OAuth plugin onResponseChunk failed: {}", error.reason),
            )
            .await;
            hook.chunk_disabled.store(true, Ordering::Relaxed);
            return EventReply::Pass;
        }
        None => return EventReply::Pass,
    };
    match chunk_blocks(&reply) {
        Some(blocks) => EventReply::Events(
            blocks
                .iter()
                .filter_map(|block| event_from_block(block))
                .collect(),
        ),
        None => EventReply::Pass,
    }
}

/// 声明 `fetch` 钩子时由插件接管传输层；返回 None 表示仍走原生 HTTP 请求。
pub(crate) async fn takeover(cancel_token: &CancellationToken) -> Result<Option<SyntheticBody>> {
    let Some(hook) = current() else {
        return Ok(None);
    };
    if !hook.hooks.fetch {
        return Ok(None);
    }
    // 先开通道再调用插件：插件读到的第一块可能早于本次调用返回。
    let (stream_id, receiver) = stream::open();
    let ctx = json!({
        "protocol": hook.protocol,
        "model": &hook.model,
        "url": &hook.url,
        "method": "POST",
        "headers": &hook.request_headers,
        "body": &hook.request_body,
        "account": &hook.account,
        "streamId": stream_id,
    });
    let reply = tokio::select! {
        biased;
        _ = cancel_token.cancelled() => {
            stream::discard(stream_id);
            return Err(Error::from_reason("OAuth plugin fetch hook cancelled"));
        }
        reply = host::call(HOOK_FETCH, &hook.provider, ctx, FETCH_HOOK_TIMEOUT) => reply,
    };
    let reply = match reply {
        Ok(value) => value,
        Err(error) => {
            stream::discard(stream_id);
            return Err(error);
        }
    };
    let status = reply
        .get("status")
        .and_then(Value::as_u64)
        .map(|value| value as u16)
        .unwrap_or(200);
    let headers = header_pairs_from_reply(reply.get("headers"));
    // 插件按流式返回（SSE 的 Response）：正文由主进程逐块推入，这边按字节流消费。
    if reply.get("streaming").and_then(Value::as_bool) == Some(true) && (200..300).contains(&status) {
        return Ok(Some(SyntheticBody::Stream {
            status,
            headers,
            body: stream::into_byte_stream(receiver),
        }));
    }
    stream::discard(stream_id);
    let body = reply
        .get("body")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if !(200..300).contains(&status) {
        let access_token = hook
            .account
            .get("accessToken")
            .and_then(Value::as_str)
            .unwrap_or_default();
        return Err(Error::from_reason(format!(
            "OAuth plugin fetch returned {}: {}",
            status,
            crate::api::failure::bounded_provider_detail(&body, 512, Some(access_token))
        )));
    }
    Ok(Some(SyntheticBody::Whole {
        status,
        headers,
        body,
    }))
}

#[derive(Clone, Copy)]
enum Mode {
    /// 还没有看到 SSE 分隔符：先整段缓冲。
    Undecided,
    /// 已确认是 SSE 事件流。
    Sse,
    /// 整段响应（非 SSE）。
    Whole,
}

struct HookState {
    inner: ByteStream,
    hook: Arc<ResponseHook>,
    protocol: &'static str,
    status: u16,
    headers: Vec<(String, String)>,
    cancel_token: CancellationToken,
    buffer: Vec<u8>,
    pending: VecDeque<Vec<u8>>,
    pending_error: Option<reqwest::Error>,
    finished: bool,
    mode: Mode,
    /// 缓冲超限后放弃整段改写。
    bypass: bool,
    /// `transformResponse` 声明 `content-type: text/event-stream`：改写后的正文继续按事件处理。
    force_sse: bool,
}

impl HookState {
    fn push_bytes(&mut self, bytes: Vec<u8>) {
        if !bytes.is_empty() {
            self.pending.push_back(bytes);
        }
    }

    fn flush_buffer(&mut self) {
        let buffered = std::mem::take(&mut self.buffer);
        self.push_bytes(buffered);
    }

    async fn drain_events(&mut self) {
        while let Some((separator_index, separator_len)) = find_sse_separator(&self.buffer) {
            let block = String::from_utf8_lossy(&self.buffer[..separator_index]).into_owned();
            self.buffer.drain(..separator_index + separator_len);
            self.process_event(block).await;
        }
    }

    /// 插件把整段响应声明为事件流时，改写后的正文仍按 SSE 事件逐条处理。
    async fn push_body_as_events(&mut self, body: Vec<u8>) {
        let mut buffer = body;
        while let Some((separator_index, separator_len)) = find_sse_separator(&buffer) {
            let block = String::from_utf8_lossy(&buffer[..separator_index]).into_owned();
            buffer.drain(..separator_index + separator_len);
            self.process_event(block).await;
        }
        if !buffer.iter().all(|byte| byte.is_ascii_whitespace()) {
            let block = String::from_utf8_lossy(&buffer).into_owned();
            self.process_event(block).await;
        }
    }

    /// 单个 SSE 事件块：插件返回事件则替换、返回 null 则丢弃、无返回则放行。
    async fn process_event(&mut self, block: String) {
        if block.trim().is_empty()
            || !self.hook.hooks.on_response_chunk
            || self.hook.chunk_disabled.load(Ordering::Relaxed)
        {
            self.push_bytes(framed(&block));
            return;
        }
        let ctx = json!({
            "protocol": self.protocol,
            "model": &self.hook.model,
            "url": &self.hook.url,
            "status": self.status,
            "headers": header_object(&self.headers),
            "account": &self.hook.account,
            "chunk": &block,
            "data": event_data(&block),
        });
        let reply = tokio::select! {
            biased;
            _ = self.cancel_token.cancelled() => None,
            reply = host::call(HOOK_RESPONSE_CHUNK, &self.hook.provider, ctx, EVENT_HOOK_TIMEOUT) => {
                Some(reply)
            }
        };
        let reply = match reply {
            Some(Ok(value)) => Some(value),
            Some(Err(error)) => {
                log_hook_warning(
                    &self.hook.provider,
                    self.protocol,
                    format!("OAuth plugin onResponseChunk failed: {}", error.reason),
                )
                .await;
                None
            }
            None => None,
        };
        let Some(reply) = reply else {
            // 失败、超时或取消：本事件原样放行，并停用本次请求后续的事件钩子。
            self.hook.chunk_disabled.store(true, Ordering::Relaxed);
            self.push_bytes(framed(&block));
            return;
        };
        match chunk_blocks(&reply) {
            Some(blocks) => {
                for event in blocks {
                    self.push_bytes(framed(&event));
                }
            }
            None => self.push_bytes(framed(&block)),
        }
    }

    async fn finish(&mut self) {
        match self.mode {
            Mode::Sse => {
                let trailing = std::mem::take(&mut self.buffer);
                if trailing.iter().all(|byte| byte.is_ascii_whitespace()) {
                    return;
                }
                let block = String::from_utf8_lossy(&trailing).into_owned();
                self.process_event(block).await;
            }
            Mode::Undecided | Mode::Whole => {
                let raw = std::mem::take(&mut self.buffer);
                if raw.is_empty() {
                    return;
                }
                let body = self.rewrite_whole_body(raw).await;
                if self.force_sse {
                    self.push_body_as_events(body).await;
                } else {
                    self.push_bytes(body);
                }
            }
        }
    }

    /// 非 SSE 整段响应在协议解析前交给 `transformResponse`。
    async fn rewrite_whole_body(&mut self, raw: Vec<u8>) -> Vec<u8> {
        if self.bypass || !self.hook.hooks.transform_response {
            return raw;
        }
        let text = String::from_utf8_lossy(&raw).into_owned();
        if text.trim().is_empty() {
            return raw;
        }
        let parsed = serde_json::from_str::<Value>(&text).ok();
        let body_value = parsed.unwrap_or(Value::String(text));
        let ctx = json!({
            "protocol": self.protocol,
            "model": &self.hook.model,
            "url": &self.hook.url,
            "status": self.status,
            "headers": header_object(&self.headers),
            "body": body_value,
            "account": &self.hook.account,
        });
        let outcome = tokio::select! {
            biased;
            _ = self.cancel_token.cancelled() => None,
            reply = host::call(
                HOOK_TRANSFORM_RESPONSE,
                &self.hook.provider,
                ctx,
                WHOLE_BODY_HOOK_TIMEOUT,
            ) => Some(reply),
        };
        let reply = match outcome {
            Some(Ok(value)) => value,
            Some(Err(error)) => {
                log_hook_warning(
                    &self.hook.provider,
                    self.protocol,
                    format!("OAuth plugin transformResponse failed: {}", error.reason),
                )
                .await;
                return raw;
            }
            None => return raw,
        };
        // 响应头覆盖：null 删除同名头、字符串替换；其中 content-type 决定正文如何续接。
        if let Some(Value::Object(changes)) = reply.get("headers") {
            for (name, value) in changes {
                match value {
                    Value::Null => self
                        .headers
                        .retain(|(existing, _)| !existing.eq_ignore_ascii_case(name)),
                    Value::String(text) => {
                        self.headers
                            .retain(|(existing, _)| !existing.eq_ignore_ascii_case(name));
                        self.headers
                            .push((name.to_ascii_lowercase(), text.clone()));
                    }
                    _ => {}
                }
            }
        }
        self.force_sse = self.headers.iter().any(|(name, value)| {
            name.eq_ignore_ascii_case("content-type")
                && value.to_ascii_lowercase().contains("text/event-stream")
        });
        match reply.get("body") {
            Some(Value::String(replacement)) => replacement.clone().into_bytes(),
            Some(value) if value.is_object() || value.is_array() => {
                serde_json::to_vec(value).unwrap_or(raw)
            }
            _ => raw,
        }
    }
}

async fn next_chunk(mut state: HookState) -> Option<(reqwest::Result<Vec<u8>>, HookState)> {
    loop {
        if let Some(chunk) = state.pending.pop_front() {
            return Some((Ok(chunk), state));
        }
        if let Some(error) = state.pending_error.take() {
            return Some((Err(error), state));
        }
        if state.finished {
            return None;
        }
        let item = state.inner.next().await;
        match item {
            Some(Ok(bytes)) => {
                state.buffer.extend_from_slice(&bytes);
                match state.mode {
                    Mode::Sse => state.drain_events().await,
                    Mode::Whole => {}
                    Mode::Undecided => {
                        if find_sse_separator(&state.buffer).is_some() {
                            state.mode = Mode::Sse;
                            state.drain_events().await;
                        } else if state.buffer.len() > MAX_BUFFERED_BYTES {
                            state.bypass = true;
                            state.mode = Mode::Whole;
                            state.flush_buffer();
                            log_hook_warning(
                                &state.hook.provider,
                                state.protocol,
                                "OAuth plugin response body exceeded the rewrite buffer limit; passing it through".to_string(),
                            )
                            .await;
                        }
                    }
                }
            }
            Some(Err(error)) => {
                state.finished = true;
                state.flush_buffer();
                state.pending_error = Some(error);
            }
            None => {
                state.finished = true;
                state.finish().await;
            }
        }
    }
}

/// 统一的响应流入口：合成响应与原生 HTTP 响应都在此接入插件钩子。
pub(crate) fn wrap_stream(
    protocol: &'static str,
    upstream: UpstreamBody,
    cancel_token: CancellationToken,
) -> ByteStream {
    let hook = current();
    let (status, headers, inner) = match upstream {
        UpstreamBody::Synthetic(SyntheticBody::Whole {
            status,
            headers,
            body,
        }) => {
            let bytes = body.into_bytes();
            let body_stream: ByteStream = Box::pin(futures::stream::once(async move {
                Ok::<Vec<u8>, reqwest::Error>(bytes)
            }));
            (status, headers, body_stream)
        }
        UpstreamBody::Synthetic(SyntheticBody::Stream {
            status,
            headers,
            body,
        }) => (status, headers, body),
        UpstreamBody::Http(response) => {
            let status = response.status().as_u16();
            let headers = header_pairs_from_response(response.headers());
            let inner =
                crate::api::request_proxy::wrap_response_stream(protocol, response.bytes_stream());
            (status, headers, inner)
        }
    };
    let Some(hook) = hook else {
        return inner;
    };
    let state = HookState {
        inner,
        hook,
        protocol,
        status,
        headers,
        cancel_token,
        buffer: Vec::new(),
        pending: VecDeque::new(),
        pending_error: None,
        finished: false,
        mode: Mode::Undecided,
        bypass: false,
        force_sse: false,
    };
    Box::pin(futures::stream::unfold(state, next_chunk))
}
