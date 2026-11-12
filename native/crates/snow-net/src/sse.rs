use std::time::Duration;

use futures::{Stream, StreamExt};
use napi::bindgen_prelude::{Error, Result};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::retry::{
    log_retry_attempt_best_effort, next_stream_item_with_idle, non_sse_response_error, retry_backoff_ms,
    should_retry, RetryOptions, StreamReadOutcome,
};

/// Find the earliest SSE event separator in a byte buffer.
///
/// SSE events are separated by `\n\n` (LF line endings) or `\r\n\r\n`
/// (CRLF line endings). Some API servers use CRLF, which `str::find("\n\n")`
/// cannot match because the two `\n` bytes are separated by `\r`.
///
/// Using a `Vec<u8>` buffer instead of a `String` also avoids data
/// corruption when a TCP chunk boundary falls inside a multi-byte UTF-8
/// sequence (e.g. Chinese characters in tool-call arguments). With
/// `String::from_utf8_lossy` the incomplete bytes would be replaced by
/// U+FFFD, producing invalid JSON and causing the entire SSE event —
/// potentially the one carrying a `function.name` delta — to be silently
/// skipped, which in turn makes the agent loop terminate early.
///
/// Returns `(position, length)` of the separator, or `None` if not found.
pub fn find_sse_separator(buffer: &[u8]) -> Option<(usize, usize)> {
    let lf_pos = buffer.windows(2).position(|w| w == b"\n\n");
    let crlf_pos = buffer.windows(4).position(|w| w == b"\r\n\r\n");
    match (lf_pos, crlf_pos) {
        (Some(lf), Some(crlf)) => {
            if crlf < lf {
                Some((crlf, 4))
            } else {
                Some((lf, 2))
            }
        }
        (Some(lf), None) => Some((lf, 2)),
        (None, Some(crlf)) => Some((crlf, 4)),
        (None, None) => None,
    }
}

/// Final outcome of consuming one Provider streaming response body
/// (SSE event stream, or the WebSocket frame sequence of the Responses
/// WebSocket transport — both share the same recovery taxonomy).
///
/// The Provider-specific parser reports terminal events through the callback;
/// transport EOF, read errors, idle timeouts, and cancellation remain typed so
/// the caller can apply the shared recovery policy exactly once.
#[derive(Debug, PartialEq, Eq)]
pub enum SseStreamEnd<E> {
    ProviderTerminal,
    ReadError(E),
    UnexpectedEof,
    IdleTimeout,
    Cancelled,
}

/// Consume SSE bytes until the Provider reports a terminal event or the
/// transport ends. Complete delimiter-terminated blocks are parsed as they
/// arrive. On EOF, a final non-empty block without a trailing delimiter is
/// parsed before classifying the stream as an unexpected EOF.
///
/// 首个数据块前使用 `first_chunk_timeout`（首字节窗口，按请求体体积放宽），
/// 之后每个数据块间隔使用 `idle_timeout`。
pub async fn read_sse_stream_until_terminal<S, T, E, F>(
    stream: &mut S,
    byte_buffer: &mut Vec<u8>,
    cancel_token: &CancellationToken,
    first_chunk_timeout: Duration,
    idle_timeout: Duration,
    mut process_event_block: F,
) -> SseStreamEnd<E>
where
    S: Stream<Item = std::result::Result<T, E>> + Unpin,
    T: AsRef<[u8]>,
    F: FnMut(&str) -> bool,
{
    let mut received_any_chunk = false;
    loop {
        let timeout = if received_any_chunk {
            idle_timeout
        } else {
            first_chunk_timeout
        };
        match next_stream_item_with_idle(stream, cancel_token, timeout).await {
            StreamReadOutcome::Cancelled => return SseStreamEnd::Cancelled,
            StreamReadOutcome::Data(chunk) => {
                received_any_chunk = true;
                byte_buffer.extend_from_slice(chunk.as_ref());
                while let Some((separator_index, separator_len)) = find_sse_separator(byte_buffer) {
                    let event_block =
                        String::from_utf8_lossy(&byte_buffer[..separator_index]).to_string();
                    *byte_buffer = byte_buffer[separator_index + separator_len..].to_vec();
                    if process_event_block(&event_block) {
                        return SseStreamEnd::ProviderTerminal;
                    }
                }
            }
            StreamReadOutcome::ReadError(error) => return SseStreamEnd::ReadError(error),
            StreamReadOutcome::Eof => {
                let trailing_bytes = std::mem::take(byte_buffer);
                if !trailing_bytes.is_empty() {
                    let trailing_block = String::from_utf8_lossy(&trailing_bytes).to_string();
                    if !trailing_block.trim().is_empty() && process_event_block(&trailing_block) {
                        return SseStreamEnd::ProviderTerminal;
                    }
                }
                return SseStreamEnd::UnexpectedEof;
            }
            StreamReadOutcome::IdleTimeout => return SseStreamEnd::IdleTimeout,
        }
    }
}

// ---------------------------------------------------------------------------
// 流式请求发送
// ---------------------------------------------------------------------------

/// 发送流式请求并按 SSE 事件逐条回调 `on_event`（每个 `data:` 行一个 JSON）。
/// 连接失败或非 2xx 状态时按重试策略重试；一旦开始读取流即不再重试。
/// 整个流结束仍未收到任何 `data:` 事件时返回 non-SSE 错误（部分网关会以
/// 200 + JSON 错误体响应流式请求）。
/// 调用方负责取消：本函数不自带取消令牌，上游用 `tokio::select!` 竞争
/// 取消令牌并丢弃本 future 即可中止在途请求。
#[allow(clippy::too_many_arguments)]
pub async fn send_streaming_sse_request(
    client: &reqwest::Client,
    endpoint: &str,
    headers: reqwest::header::HeaderMap,
    payload: &Value,
    retry_options: &RetryOptions,
    func: &str,
    provider: &str,
    mut on_event: impl FnMut(Value) -> Result<()>,
) -> Result<()> {
    let mut attempt: u32 = 0;
    loop {
        let response = match client
            .post(endpoint)
            .headers(headers.clone())
            .json(payload)
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => {
                let error = Error::from_reason(format!("API request failed: {}", error));
                if !should_retry(&error, attempt, retry_options) {
                    return Err(error);
                }
                let backoff_ms = retry_backoff_ms(retry_options, attempt);
                log_retry_attempt_best_effort(
                    func,
                    provider,
                    provider,
                    "connect_error",
                    attempt,
                    endpoint,
                    &error.reason,
                    backoff_ms,
                )
                .await;
                attempt += 1;
                tokio::time::sleep(std::time::Duration::from_millis(
                    backoff_ms.max(0) as u64,
                ))
                .await;
                continue;
            }
        };

        let status = response.status();
        if !status.is_success() {
            let error_body = response.text().await.unwrap_or_default();
            let error =
                Error::from_reason(format!("API request failed: {} {}", status, error_body));
            if !should_retry(&error, attempt, retry_options) {
                return Err(error);
            }
            let backoff_ms = retry_backoff_ms(retry_options, attempt);
            log_retry_attempt_best_effort(
                func,
                provider,
                provider,
                "http_status",
                attempt,
                endpoint,
                &error.reason,
                backoff_ms,
            )
            .await;
            attempt += 1;
            tokio::time::sleep(std::time::Duration::from_millis(
                backoff_ms.max(0) as u64,
            ))
            .await;
            continue;
        }

        // 已进入流式读取阶段，中途失败不再重试（事件可能已部分消费）。
        let mut byte_buffer: Vec<u8> = Vec::new();
        let mut received_any_event = false;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| {
                Error::from_reason(format!("API stream read failed: {}", error))
            })?;
            byte_buffer.extend_from_slice(&chunk);
            loop {
                let Some((separator_pos, separator_len)) = find_sse_separator(&byte_buffer) else {
                    break;
                };
                let event_bytes: Vec<u8> = byte_buffer.drain(..separator_pos).collect();
                byte_buffer.drain(..separator_len);
                let event_block = String::from_utf8_lossy(&event_bytes);
                if process_sse_event_block(&event_block, &mut on_event)? {
                    received_any_event = true;
                }
            }
        }
        // 处理流末尾残余（可能是不带尾随空行的最后一个事件）。
        if !byte_buffer.is_empty() {
            let event_block = String::from_utf8_lossy(&byte_buffer);
            if process_sse_event_block(&event_block, &mut on_event)? {
                received_any_event = true;
            }
        }
        if !received_any_event {
            let body = String::from_utf8_lossy(&byte_buffer).to_string();
            return Err(non_sse_response_error(&body));
        }
        return Ok(());
    }
}

/// 解析一个 SSE 事件块（两个空行之间的文本），逐行提取 `data:` 前缀的
/// JSON 并回调。返回是否至少处理了一个事件。
/// 兼容部分网关对 `stream: true` 仍返回完整 JSON（无 `data:` 前缀）的
/// 情况：整个块按 JSON 解析后作为单个事件回调。
fn process_sse_event_block(
    event_block: &str,
    on_event: &mut impl FnMut(Value) -> Result<()>,
) -> Result<bool> {
    let mut processed = false;
    for line in event_block.lines() {
        let trimmed = line.trim_start();
        let Some(data) = trimmed.strip_prefix("data:") else {
            continue;
        };
        let data = data.trim_start();
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        let Ok(event) = serde_json::from_str::<Value>(data) else {
            continue;
        };
        processed = true;
        on_event(event)?;
    }

    // Fallback: 无 `data:` 行时，把整个块当完整 JSON 响应解析（例如
    // 网关忽略 stream 参数直接返回非流式响应，或 `: ping` 注释行）。
    if !processed {
        let trimmed_block = event_block.trim();
        if !trimmed_block.is_empty() && !trimmed_block.starts_with(':') && trimmed_block != "[DONE]"
        {
            if let Ok(event) = serde_json::from_str::<Value>(trimmed_block) {
                on_event(event)?;
                processed = true;
            }
        }
    }

    Ok(processed)
}