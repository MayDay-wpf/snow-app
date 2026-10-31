//! `fetch` 钩子的响应流桥。
//!
//! 插件在 `fetch(ctx)` 里返回流式 `Response`（`content-type: text/event-stream`）时，
//! 主进程逐块读上游正文并通过 `pushOAuthPluginStreamChunk` 推给 Rust；Rust 侧把接收端
//! 接成原生管线的字节流，事件按到达顺序逐个解析，回复因此逐字上屏，而不是等整段生成完
//! 再一次刷出。非流式返回值（字符串、`{ body }`、非事件流 `Response`）不建通道，行为与
//! 旧版一致。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};

use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};

use crate::api::request_proxy::ByteStream;

type StreamTable = Mutex<HashMap<u32, UnboundedSender<Vec<u8>>>>;

static STREAMS: OnceLock<StreamTable> = OnceLock::new();
/// 通道 id 从 1 起单调递增，不复用，避免取消后的迟到回调误投给新请求。
static NEXT_ID: AtomicU32 = AtomicU32::new(1);

fn streams() -> &'static StreamTable {
    STREAMS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn table_lock() -> MutexGuard<'static, HashMap<u32, UnboundedSender<Vec<u8>>>> {
    streams()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 为一次 `fetch` 调用开一条通道：id 随 ctx 交给插件，接收端接进原生字节流。
pub(crate) fn open() -> (u32, UnboundedReceiver<Vec<u8>>) {
    let (sender, receiver) = unbounded_channel();
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    table_lock().insert(id, sender);
    (id, receiver)
}

/// 放弃通道：插件没有按流式返回，或本次请求失败 / 被取消。
pub(crate) fn discard(id: u32) {
    table_lock().remove(&id);
}

/// 主进程推入一块正文；返回 false 表示通道已关闭（正文已结束或被取消），插件应停止读取。
pub(crate) fn push(id: u32, chunk: Vec<u8>) -> bool {
    let mut table = table_lock();
    match table.get(&id) {
        Some(sender) => {
            if sender.send(chunk).is_ok() {
                true
            } else {
                table.remove(&id);
                false
            }
        }
        None => false,
    }
}

/// 正文读完：移除通道让 Rust 侧流正常结束；返回 false 表示通道已被关闭（例如已取消）。
pub(crate) fn close(id: u32) -> bool {
    table_lock().remove(&id).is_some()
}

/// 把接收端接成原生管线消费的字节流（发送端全部移除后流自然结束）。
pub(crate) fn into_byte_stream(receiver: UnboundedReceiver<Vec<u8>>) -> ByteStream {
    Box::pin(futures::stream::unfold(
        receiver,
        |mut receiver| async move {
            receiver
                .recv()
                .await
                .map(|chunk| (Ok::<Vec<u8>, reqwest::Error>(chunk), receiver))
        },
    ))
}
