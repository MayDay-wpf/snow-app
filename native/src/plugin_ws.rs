//! 插件 WebSocket 长连接（原生侧）。
//!
//! 插件通过 `pluginWsOpen` 与外部服务（例如飞书事件长连接）保持 WebSocket 连接。
//! 每条连接在 napi 的 tokio 运行时上独立运行：握手、读取、发送与关闭全部异步完成，
//! 导出函数只做参数校验、登记连接与派发任务，不会阻塞 Electron 主进程。
//! 连接的全部事件以 JSON 字符串推送给主进程（格式见 `PluginWsEvent`）。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use base64::Engine as _;
use futures::{SinkExt, StreamExt};
use napi::bindgen_prelude::{Status, Unknown};
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio_tungstenite::connect_async_tls_with_config;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::handshake::client::Request;
use tokio_tungstenite::tungstenite::http::header::{HeaderName, HeaderValue};
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, WebSocketConfig};
use tokio_tungstenite::tungstenite::Message;
use url::Url;

/// 同时打开的连接数上限。
const MAX_CONNECTIONS: usize = 32;
/// 单次打开允许的请求头数量上限。
const MAX_HEADERS: usize = 32;
/// WebSocket 地址的长度上限（字节）。
const MAX_URL_BYTES: usize = 2048;
/// 单条文本或二进制消息的发送上限（1 MiB）。
const MAX_SEND_BYTES: usize = 1024 * 1024;
/// 二进制消息按 base64 文本传入时的长度上限（解码后为 1 MiB）。
const MAX_SEND_BASE64_BYTES: usize = (MAX_SEND_BYTES / 3 + 1) * 4;
/// 入站消息与单帧的大小上限（4 MiB），超出即按异常断开处理。
const MAX_MESSAGE_BYTES: usize = 4 * 1024 * 1024;
/// 每条连接的出站队列容量。
const OUTBOUND_CAPACITY: usize = 256;
/// 握手等待上限。
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);
/// 关闭原因的字节上限（控制帧负载 125 字节，扣除 2 字节状态码）。
const MAX_CLOSE_REASON_BYTES: usize = 123;
/// 默认关闭状态码（调用方传入的状态码不合法时使用）。
const CLOSE_NORMAL: u16 = 1000;
/// 对端关闭帧未携带状态码。
const CLOSE_NO_STATUS: u16 = 1005;
/// 连接异常断开（没有收到关闭帧）。
const CLOSE_ABNORMAL: u16 = 1006;

/// 事件回调：Rust 以 NonBlocking 方式派发 JSON 字符串，不等待 JS 返回值。
pub type PluginWsEventCallback = ThreadsafeFunction<String, Unknown<'static>, String, Status, false>;

/// 出站指令：文本帧、二进制帧，或请求关闭连接。
enum Outbound {
    Text(String),
    Binary(Vec<u8>),
    Close { code: u16, reason: String },
}

type Registry = HashMap<u32, mpsc::Sender<Outbound>>;

/// 连接 id 从 1 递增，不复用。
static NEXT_ID: AtomicU32 = AtomicU32::new(1);
/// 当前存活连接的出站发送端表；连接任务结束时自行移除。
static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
/// 全局事件回调；重复注册时保留首次注册的回调。
static EVENT_SINK: OnceLock<PluginWsEventCallback> = OnceLock::new();

/// 推送给主进程的连接事件，`kind` 区分事件类型。
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum PluginWsEvent {
    Open { id: u32 },
    Message { id: u32, data: String, binary: bool },
    Error { id: u32, message: String },
    Close { id: u32, code: u16, reason: String },
}

/// `pluginWsOpen` 的参数（JSON 字符串解析而来）。
#[derive(Deserialize)]
struct OpenOptions {
    url: String,
    #[serde(default)]
    headers: HashMap<String, String>,
}

/// 连接结束的原因，决定最终 close 事件的状态码与原因。
enum Ending {
    /// 对端发来关闭帧（可能不携带状态码）。
    Peer(Option<CloseFrame<'static>>),
    /// 本端通过 `pluginWsClose` 请求关闭。
    Local { code: u16, reason: String },
    /// 读写出错或连接无预期地结束。
    Abnormal,
}

impl Ending {
    fn into_close(self) -> (u16, String) {
        match self {
            Ending::Peer(Some(frame)) => (u16::from(frame.code), frame.reason.into_owned()),
            Ending::Peer(None) => (CLOSE_NO_STATUS, String::new()),
            Ending::Local { code, reason } => (code, reason),
            Ending::Abnormal => (CLOSE_ABNORMAL, String::new()),
        }
    }
}

/// 打开连接：校验参数、登记连接并派发后台任务，立即返回连接 id（不等待握手）。
pub fn open(options_json: &str) -> napi::Result<u32> {
    let options: OpenOptions = serde_json::from_str(options_json)
        .map_err(|error| invalid_argument(format!("连接参数不是合法的 JSON：{error}")))?;
    if options.url.len() > MAX_URL_BYTES {
        return Err(invalid_argument("WebSocket 地址长度超过 2048 字节"));
    }
    let parsed = Url::parse(&options.url).map_err(|_| invalid_argument("WebSocket 地址格式非法"))?;
    if !matches!(parsed.scheme(), "ws" | "wss") {
        return Err(invalid_argument("WebSocket 地址仅支持 ws 或 wss 协议"));
    }
    if options.headers.len() > MAX_HEADERS {
        return Err(invalid_argument("请求头数量超过 32 项"));
    }
    let mut request = options
        .url
        .as_str()
        .into_client_request()
        .map_err(|error| invalid_argument(format!("WebSocket 地址无效：{error}")))?;
    for (raw_name, raw_value) in &options.headers {
        let name = HeaderName::from_bytes(raw_name.as_bytes())
            .map_err(|_| invalid_argument(format!("请求头名称非法：{raw_name}")))?;
        let value = HeaderValue::from_str(raw_value)
            .map_err(|_| invalid_argument(format!("请求头 {raw_name} 的值非法")))?;
        request.headers_mut().insert(name, value);
    }

    let (sender, receiver) = mpsc::channel(OUTBOUND_CAPACITY);
    let id = {
        let mut registry = lock_registry();
        if registry.len() >= MAX_CONNECTIONS {
            return Err(invalid_argument("同时打开的 WebSocket 连接数已达上限（32）"));
        }
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        registry.insert(id, sender);
        id
    };
    let _ = napi::bindgen_prelude::spawn(run_connection(id, request, receiver));
    Ok(id)
}

/// 发送一条文本消息：通道满、连接不存在或已关闭时返回 false，不阻塞。
pub fn send(raw_id: f64, text: String) -> bool {
    if text.len() > MAX_SEND_BYTES {
        return false;
    }
    let Some(id) = connection_id(raw_id) else {
        return false;
    };
    let Some(sender) = sender_of(id) else {
        return false;
    };
    sender.try_send(Outbound::Text(text)).is_ok()
}

/// 发送一条二进制消息（入参为 base64）：解码失败、超过上限、连接不存在或已关闭时返回 false。
pub fn send_binary(raw_id: f64, base64_text: String) -> bool {
    if base64_text.len() > MAX_SEND_BASE64_BYTES {
        return false;
    }
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(base64_text.as_bytes()) else {
        return false;
    };
    if bytes.is_empty() || bytes.len() > MAX_SEND_BYTES {
        return false;
    }
    let Some(id) = connection_id(raw_id) else {
        return false;
    };
    let Some(sender) = sender_of(id) else {
        return false;
    };
    sender.try_send(Outbound::Binary(bytes)).is_ok()
}

/// 请求关闭连接：状态码不合法时使用 1000，原因按 UTF-8 截断到 123 字节。
pub fn close(raw_id: f64, code: f64, reason: String) -> bool {
    let Some(id) = connection_id(raw_id) else {
        return false;
    };
    let Some(sender) = sender_of(id) else {
        return false;
    };
    sender
        .try_send(Outbound::Close {
            code: close_code(code),
            reason: truncate_utf8(reason, MAX_CLOSE_REASON_BYTES),
        })
        .is_ok()
}

/// 注册全局事件回调（重复注册时保留首次注册的回调）。
pub fn set_event_handler(callback: PluginWsEventCallback) {
    let _ = EVENT_SINK.set(callback);
}

/// 单条连接的后台任务：握手、双向收发直到结束，最后注销并发出唯一的 close 事件。
async fn run_connection(id: u32, request: Request, mut outbound: mpsc::Receiver<Outbound>) {
    let config = WebSocketConfig {
        max_message_size: Some(MAX_MESSAGE_BYTES),
        max_frame_size: Some(MAX_MESSAGE_BYTES),
        ..Default::default()
    };
    let handshake = tokio::time::timeout(
        HANDSHAKE_TIMEOUT,
        connect_async_tls_with_config(request, Some(config), false, None),
    )
    .await;
    let socket = match handshake {
        Ok(Ok((socket, _response))) => socket,
        Ok(Err(error)) => return fail(id, format!("连接失败：{error}")),
        Err(_) => return fail(id, "握手超时".to_string()),
    };

    emit(PluginWsEvent::Open { id });
    let (mut sink, mut stream) = socket.split();
    let ending = loop {
        tokio::select! {
            incoming = stream.next() => match incoming {
                Some(Ok(Message::Text(data))) => {
                    emit(PluginWsEvent::Message { id, data, binary: false });
                }
                Some(Ok(Message::Binary(bytes))) => {
                    let data = base64::engine::general_purpose::STANDARD.encode(bytes);
                    emit(PluginWsEvent::Message { id, data, binary: true });
                }
                Some(Ok(Message::Close(frame))) => break Ending::Peer(frame),
                Some(Ok(_)) => {}
                Some(Err(error)) => {
                    emit(PluginWsEvent::Error { id, message: format!("连接异常：{error}") });
                    break Ending::Abnormal;
                }
                None => break Ending::Abnormal,
            },
            command = outbound.recv() => match command {
                Some(Outbound::Text(text)) => {
                    if let Err(error) = sink.send(Message::Text(text)).await {
                        emit(PluginWsEvent::Error { id, message: format!("发送失败：{error}") });
                        break Ending::Abnormal;
                    }
                }
                Some(Outbound::Binary(bytes)) => {
                    if let Err(error) = sink.send(Message::Binary(bytes.into())).await {
                        emit(PluginWsEvent::Error { id, message: format!("发送失败：{error}") });
                        break Ending::Abnormal;
                    }
                }
                Some(Outbound::Close { code, reason }) => {
                    let frame = CloseFrame {
                        code: code.into(),
                        reason: reason.clone().into(),
                    };
                    let _ = sink.send(Message::Close(Some(frame))).await;
                    break Ending::Local { code, reason };
                }
                None => break Ending::Abnormal,
            },
        }
    };
    let (code, reason) = ending.into_close();
    finish(id, code, reason);
}

/// 握手阶段失败：先发 error 事件，再发 close 事件。
fn fail(id: u32, message: String) {
    emit(PluginWsEvent::Error { id, message });
    finish(id, CLOSE_ABNORMAL, String::new());
}

/// 注销连接并发出 close 事件（每条连接只发一次，且是最后一个事件）。
fn finish(id: u32, code: u16, reason: String) {
    lock_registry().remove(&id);
    emit(PluginWsEvent::Close { id, code, reason });
}

/// 推送一条事件给主进程；未注册回调时直接丢弃。
fn emit(event: PluginWsEvent) {
    let Some(sink) = EVENT_SINK.get() else {
        return;
    };
    let Ok(payload) = serde_json::to_string(&event) else {
        return;
    };
    let _ = sink.call(payload, ThreadsafeFunctionCallMode::NonBlocking);
}

fn lock_registry() -> MutexGuard<'static, Registry> {
    REGISTRY
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|error| error.into_inner())
}

fn sender_of(id: u32) -> Option<mpsc::Sender<Outbound>> {
    lock_registry().get(&id).cloned()
}

/// JS 传入的连接 id 必须是 1 到 u32::MAX 之间的整数。
fn connection_id(raw: f64) -> Option<u32> {
    if raw.fract() != 0.0 || raw < 1.0 || raw > f64::from(u32::MAX) {
        return None;
    }
    Some(raw as u32)
}

/// 关闭状态码必须是 1000 到 4999 之间的整数，否则使用 1000。
fn close_code(raw: f64) -> u16 {
    if raw.fract() == 0.0 && (1000.0..=4999.0).contains(&raw) {
        raw as u16
    } else {
        CLOSE_NORMAL
    }
}

/// 按字节上限截断到合法的 UTF-8 字符边界。
fn truncate_utf8(text: String, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text;
    }
    let mut end = max_bytes;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_string()
}

fn invalid_argument(message: impl Into<String>) -> napi::Error {
    napi::Error::from_reason(message)
}
