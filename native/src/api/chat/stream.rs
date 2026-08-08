//! Chat Completions streaming response collection — HTTP request, retry
//! loop, idle-timeout reconnection, and SSE event dispatch.

use std::collections::HashMap;
use std::time::Duration;

use futures::StreamExt;
use napi::bindgen_prelude::*;
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT_ENCODING, AUTHORIZATION, CONTENT_TYPE};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::api::common::{
    emit_stream_chunk as emit_chat_completion_stream_chunk, emit_tool_args_probe,
    inject_custom_headers, truncate_utf8_safe,
};
use crate::api::responses::{ResponsesApiStreamCallback, ResponsesApiStreamChunk};
use crate::api::retry::{
    non_sse_response_error, should_retry, stream_idle_timeout_error, wait_before_retry,
    RetryOptions,
};
use crate::api::sse::find_sse_separator;
use crate::storage::services::chat_conversations::ChatTokenUsage;

pub(super) struct ChatCompletionStreamResult {
    pub id: String,
    pub content: String,
    pub thinking: String,
    pub model: String,
    pub status: String,
    pub token_usage: ChatTokenUsage,
    pub tool_calls_json: String,
    pub tool_parse_errors: Vec<String>,
    pub total_duration_ms: i64,
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn collect_chat_completions_stream(
    client: &reqwest::Client,
    endpoint: &str,
    api_key: &str,
    custom_headers: &HashMap<String, String>,
    payload: Value,
    on_chunk: &ResponsesApiStreamCallback,
    cancel_token: &CancellationToken,
    retry_options: &RetryOptions,
    stream_idle_timeout_sec: u64,
) -> Result<ChatCompletionStreamResult> {
    let mut attempt: u32 = 0;
    let mut stream_token_count: usize = 0;
    let stream_start = std::time::Instant::now();
    let mut ttft_ms: i64 = 0;

    // State accumulated across the stream of a single HTTP response. These are
    // declared outside the main loop so that, when the stream idle timeout
    // fires mid-stream, we can discard the partial result and reset them before
    // re-issuing the request with the original parameters.
    let mut raw_events: Vec<Value> = Vec::new();
    let mut content_chunks: Vec<String> = Vec::new();
    let mut thinking_chunks: Vec<String> = Vec::new();
    let mut tool_calls: Vec<Value> = Vec::new();
    let mut tool_call_positions_by_index: HashMap<usize, usize> = HashMap::new();
    let mut response_id = String::new();
    let mut response_model = String::new();
    let mut response_status = String::from("completed");
    let mut token_usage = ChatTokenUsage::default();
    let mut byte_buffer: Vec<u8> = Vec::new();

    let idle_timeout = Duration::from_secs(stream_idle_timeout_sec);
    // Track whether the stream completed normally (via [DONE], finish_reason,
    // or cancellation). When false after the inner loop, the response is
    // marked "incomplete".
    #[allow(unused_assignments)]
    let mut stream_completed_normally = false;
    // Set by process_sse_event_block when [DONE] is received.
    let mut stream_finished = false;

    loop {
        // ---- Phase 1: send the request (with retry on connect errors) ----
        let response = loop {
            if cancel_token.is_cancelled() {
                return Ok(ChatCompletionStreamResult {
                    id: String::new(),
                    content: String::new(),
                    thinking: String::new(),
                    model: String::new(),
                    status: String::from("cancelled"),
                    token_usage: ChatTokenUsage::default(),
                    tool_calls_json: "[]".to_string(),
                    tool_parse_errors: Vec::new(),
                    total_duration_ms: stream_start.elapsed().as_millis() as i64,
                });
            }

            let send_future = client
                .post(endpoint)
                .headers(build_header_map(api_key, custom_headers)?)
                .json(&payload)
                .send();

            let result = tokio::select! {
                biased;
                _ = cancel_token.cancelled() => {
                    return Ok(ChatCompletionStreamResult {
                        id: String::new(),
                        content: String::new(),
                        thinking: String::new(),
                        model: String::new(),
                        status: String::from("cancelled"),
                        token_usage: ChatTokenUsage::default(),
                        tool_calls_json: "[]".to_string(),
                        tool_parse_errors: Vec::new(),
                        total_duration_ms: stream_start.elapsed().as_millis() as i64,
                    });
                }
                result = send_future => {
                    result.map_err(|error| Error::from_reason(format!("Failed to create chat stream: {}", error)))
                }
            };

            match result {
                Ok(response) => {
                    let status = response.status();
                    if !status.is_success() {
                        let error_body = response.text().await.unwrap_or_default();
                        let error = Error::from_reason(format!(
                            "Chat completions request failed: {} {}",
                            status, error_body
                        ));

                        if !should_retry(&error, attempt, retry_options) {
                            return Err(error);
                        }

                        // Emit retry status to frontend
                        on_chunk.call(
                            ResponsesApiStreamChunk {
                                content_delta: String::new(),
                                thinking_delta: String::new(),
                                content: String::new(),
                                thinking: String::new(),
                                retrying: true,
                                retry_attempt: Some((attempt + 1) as i32),
                                retry_error: Some(error.reason.clone()),
                                stream_token_count: stream_token_count as i64,
                                elapsed_ms: stream_start.elapsed().as_millis() as i64,
                                ttft_ms,
                                vision_status: None,
                            },
                            ThreadsafeFunctionCallMode::NonBlocking,
                        );

                        match wait_before_retry(retry_options, cancel_token, attempt).await {
                            Ok(()) => {
                                attempt += 1;
                                continue;
                            }
                            Err(e) => return Err(e),
                        }
                    }
                    break response;
                }
                Err(error) => {
                    if !should_retry(&error, attempt, retry_options) {
                        return Err(error);
                    }

                    // Emit retry status to frontend
                    on_chunk.call(
                        ResponsesApiStreamChunk {
                            content_delta: String::new(),
                            thinking_delta: String::new(),
                            content: String::new(),
                            thinking: String::new(),
                            retrying: true,
                            retry_attempt: Some((attempt + 1) as i32),
                            retry_error: Some(error.reason.clone()),
                            stream_token_count: stream_token_count as i64,
                            elapsed_ms: stream_start.elapsed().as_millis() as i64,
                            ttft_ms,
                            vision_status: None,
                        },
                        ThreadsafeFunctionCallMode::NonBlocking,
                    );

                    match wait_before_retry(retry_options, cancel_token, attempt).await {
                        Ok(()) => {
                            attempt += 1;
                            continue;
                        }
                        Err(e) => return Err(e),
                    }
                }
            }
        };

        // ---- Phase 2: read the streaming body (with idle timeout) ----
        let mut stream = response.bytes_stream();
        stream_completed_normally = false;
        // Set to true when the idle-timeout path resets state and breaks the
        // inner loop so the outer loop re-sends the request.
        let mut idle_reset = false;
        // Idle timer: reset on every received chunk. If no data arrives within
        // `stream_idle_timeout_sec`, we abandon the stalled stream and re-issue
        // the request with the original parameters.
        let mut idle_deadline = tokio::time::Instant::now() + idle_timeout;

        loop {
            tokio::select! {
                biased;
                _ = cancel_token.cancelled() => {
                    response_status = String::from("cancelled");
                    stream_completed_normally = true;
                    break;
                }
                _ = tokio::time::sleep_until(idle_deadline) => {
                    // Stream idle timeout: no data received for the configured
                    // period. Treat as a retriable error so the agent loop
                    // re-issues the request with the original parameters.
                    let error = stream_idle_timeout_error();
                    if !should_retry(&error, attempt, retry_options) {
                        // Exhausted retries — return whatever we have so far
                        // rather than discarding partial work. The response
                        // will be marked "incomplete" since [DONE] was never
                        // received.
                        break;
                    }

                    // Emit retry status to frontend so the user sees the
                    // reconnection attempt.
                    on_chunk.call(
                        ResponsesApiStreamChunk {
                            content_delta: String::new(),
                            thinking_delta: String::new(),
                            content: String::new(),
                            thinking: String::new(),
                            retrying: true,
                            retry_attempt: Some((attempt + 1) as i32),
                            retry_error: Some(error.reason.clone()),
                            stream_token_count: stream_token_count as i64,
                            elapsed_ms: stream_start.elapsed().as_millis() as i64,
                            ttft_ms,
                            vision_status: None,
                        },
                        ThreadsafeFunctionCallMode::NonBlocking,
                    );

                    match wait_before_retry(retry_options, cancel_token, attempt).await {
                        Ok(()) => {
                            // Reset accumulated state so the retry starts fresh.
                            raw_events.clear();
                            content_chunks.clear();
                            thinking_chunks.clear();
                            tool_calls.clear();
                            tool_call_positions_by_index.clear();
                            byte_buffer.clear();
                            response_id.clear();
                            response_model.clear();
                            response_status = String::from("completed");
                            token_usage = ChatTokenUsage::default();
                            stream_finished = false;
                            attempt += 1;
                            // Jump back to Phase 1 to re-send the request.
                            idle_reset = true;
                            break;
                        }
                        Err(e) => return Err(e),
                    }
                }
                chunk_result = stream.next() => {
                    let Some(chunk_result) = chunk_result else {
                        // Stream ended without a finish_reason. Treat as
                        // incomplete rather than a hard error so partial content
                        // and tool calls remain usable.
                        break;
                    };

                    let chunk = match chunk_result {
                        Ok(chunk) => chunk,
                        Err(error) => {
                            // Network/read error mid-stream: log and break instead
                            // of returning Err. We keep whatever content and tool
                            // calls have been collected so far so the agent loop
                            // can continue with partial results.
                            eprintln!("Chat stream read error (keeping partial result): {error}");
                            break;
                        }
                    };
                    // Any data received — reset the idle timer.
                    idle_deadline = tokio::time::Instant::now() + idle_timeout;
                    byte_buffer.extend_from_slice(&chunk);

                    while let Some((separator_index, separator_len)) =
                        find_sse_separator(&byte_buffer)
                    {
                        let event_block =
                            String::from_utf8_lossy(&byte_buffer[..separator_index]).to_string();
                        byte_buffer = byte_buffer[separator_index + separator_len..].to_vec();
                        let content_start_index = content_chunks.len();
                        let thinking_start_index = thinking_chunks.len();
                        let mut tool_args_delta = String::new();
                        // Process each SSE event block with error tolerance: if a
                        // single data line is malformed, skip it and continue
                        // processing the rest of the stream.
                        super::event::process_sse_event_block(
                            &event_block,
                            &mut raw_events,
                            &mut content_chunks,
                            &mut thinking_chunks,
                            &mut tool_calls,
                            &mut tool_call_positions_by_index,
                            &mut response_id,
                            &mut response_model,
                            &mut response_status,
                            &mut token_usage,
                            &mut tool_args_delta,
                            &mut stream_finished,
                        );
                        let content_delta = content_chunks[content_start_index..].join("");
                        let thinking_delta = thinking_chunks[thinking_start_index..].join("");
                        // Emit content/thinking delta (if any) and update the
                        // token probe for those tokens.
                        if ttft_ms == 0 {
                            ttft_ms = stream_start.elapsed().as_millis() as i64;
                        }
                        emit_chat_completion_stream_chunk(
                            on_chunk,
                            content_delta,
                            thinking_delta,
                            &mut stream_token_count,
                            stream_start.elapsed().as_millis() as i64,
                            ttft_ms,
                        );
                        // Tool-call argument deltas arrive separately from the
                        // content stream. Emit a probe-only chunk so the
                        // renderer reflects long tool arguments in real time.
                        emit_tool_args_probe(
                            on_chunk,
                            &mut stream_token_count,
                            &tool_args_delta,
                            stream_start.elapsed().as_millis() as i64,
                            ttft_ms,
                        );
                    }
                }
            }
        }

        // If the idle-timeout path reset state, re-send the request.
        // Otherwise the stream is done (completed, cancelled, incomplete, or
        // error) and we proceed to finalize.
        if idle_reset {
            continue;
        }

        // Non-SSE response detection: the stream received bytes but none of
        // them formed a valid SSE event. This happens when a relay returns
        // HTTP 200 with a JSON error body (e.g. quota exhausted) instead of
        // a proper SSE stream. Treat it as a retriable error so the request
        // is re-issued, matching the idle-timeout recovery pattern.
        if !stream_completed_normally
            && response_status != "cancelled"
            && raw_events.is_empty()
            && content_chunks.is_empty()
            && thinking_chunks.is_empty()
            && tool_calls.is_empty()
            && !byte_buffer.is_empty()
        {
            let body = String::from_utf8_lossy(&byte_buffer).to_string();
            let error = non_sse_response_error(&body);

            if !should_retry(&error, attempt, retry_options) {
                return Err(error);
            }

            // Emit retry status to frontend
            on_chunk.call(
                ResponsesApiStreamChunk {
                    content_delta: String::new(),
                    thinking_delta: String::new(),
                    content: String::new(),
                    thinking: String::new(),
                    retrying: true,
                    retry_attempt: Some((attempt + 1) as i32),
                    retry_error: Some(error.reason.clone()),
                    stream_token_count: stream_token_count as i64,
                    elapsed_ms: stream_start.elapsed().as_millis() as i64,
                    ttft_ms,
                    vision_status: None,
                },
                ThreadsafeFunctionCallMode::NonBlocking,
            );

            match wait_before_retry(retry_options, cancel_token, attempt).await {
                Ok(()) => {
                    raw_events.clear();
                    content_chunks.clear();
                    thinking_chunks.clear();
                    tool_calls.clear();
                    tool_call_positions_by_index.clear();
                    byte_buffer.clear();
                    response_id.clear();
                    response_model.clear();
                    response_status = String::from("completed");
                    token_usage = ChatTokenUsage::default();
                    stream_finished = false;
                    attempt += 1;
                    continue;
                }
                Err(e) => return Err(e),
            }
        }

        // Empty-response interruption: the connection dropped (EOF or read
        // error) before ANY content, thinking, or tool call was produced.
        // Unlike the non-SSE case above, this covers streams that ended with
        // no usable data at all (including zero-byte bodies). Retrying is
        // safe — nothing was emitted to the user — and recovers transient
        // relay/proxy disconnects that would otherwise surface as a silent
        // empty "incomplete" response.
        if !stream_completed_normally
            && response_status != "cancelled"
            && content_chunks.is_empty()
            && thinking_chunks.is_empty()
            && tool_calls.is_empty()
        {
            let error = Error::from_reason(
                "Stream ended with empty response (connection dropped before any output)",
            );

            if !should_retry(&error, attempt, retry_options) {
                return Err(error);
            }

            // Emit retry status to frontend
            on_chunk.call(
                ResponsesApiStreamChunk {
                    content_delta: String::new(),
                    thinking_delta: String::new(),
                    content: String::new(),
                    thinking: String::new(),
                    retrying: true,
                    retry_attempt: Some((attempt + 1) as i32),
                    retry_error: Some(error.reason.clone()),
                    stream_token_count: stream_token_count as i64,
                    elapsed_ms: stream_start.elapsed().as_millis() as i64,
                    ttft_ms,
                    vision_status: None,
                },
                ThreadsafeFunctionCallMode::NonBlocking,
            );

            match wait_before_retry(retry_options, cancel_token, attempt).await {
                Ok(()) => {
                    raw_events.clear();
                    content_chunks.clear();
                    thinking_chunks.clear();
                    tool_calls.clear();
                    tool_call_positions_by_index.clear();
                    byte_buffer.clear();
                    response_id.clear();
                    response_model.clear();
                    response_status = String::from("completed");
                    token_usage = ChatTokenUsage::default();
                    stream_finished = false;
                    attempt += 1;
                    continue;
                }
                Err(e) => return Err(e),
            }
        }

        // Stream finalized — exit the outer loop.
        break;
    }

    // If the stream ended abnormally (no [DONE], no finish_reason, and no
    // cancellation), mark the response as incomplete so the frontend knows
    // the result is partial but still usable.
    if !stream_completed_normally && !stream_finished && response_status == "completed" {
        response_status = String::from("incomplete");
    }

    if response_status != "cancelled" && !byte_buffer.is_empty() {
        let trailing_buffer = String::from_utf8_lossy(&byte_buffer).to_string();
        if !trailing_buffer.trim().is_empty() {
            let content_start_index = content_chunks.len();
            let thinking_start_index = thinking_chunks.len();
            let mut tool_args_delta = String::new();
            super::event::process_sse_event_block(
                &trailing_buffer,
                &mut raw_events,
                &mut content_chunks,
                &mut thinking_chunks,
                &mut tool_calls,
                &mut tool_call_positions_by_index,
                &mut response_id,
                &mut response_model,
                &mut response_status,
                &mut token_usage,
                &mut tool_args_delta,
                &mut stream_finished,
            );
            let content_delta = content_chunks[content_start_index..].join("");
            let thinking_delta = thinking_chunks[thinking_start_index..].join("");
            if ttft_ms == 0 {
                ttft_ms = stream_start.elapsed().as_millis() as i64;
            }
            emit_chat_completion_stream_chunk(
                on_chunk,
                content_delta,
                thinking_delta,
                &mut stream_token_count,
                stream_start.elapsed().as_millis() as i64,
                ttft_ms,
            );
            emit_tool_args_probe(
                on_chunk,
                &mut stream_token_count,
                &tool_args_delta,
                stream_start.elapsed().as_millis() as i64,
                ttft_ms,
            );
        }
    }

    let content = content_chunks.join("").trim().to_string();
    let thinking = thinking_chunks.join("").trim().to_string();
    let tool_calls_json = serde_json::to_string(&tool_calls).unwrap_or_else(|_| "[]".to_string());

    let mut tool_parse_errors: Vec<String> = Vec::new();
    for tool_call in &tool_calls {
        if let Some(args) = tool_call
            .get("function")
            .and_then(|f| f.get("arguments"))
            .and_then(Value::as_str)
        {
            if !args.is_empty() {
                if let Err(e) = serde_json::from_str::<Value>(args) {
                    let name = tool_call
                        .get("function")
                        .and_then(|f| f.get("name"))
                        .and_then(Value::as_str)
                        .unwrap_or("unknown");
                    tool_parse_errors.push(format!(
                        "tool={}, error={}, raw={}",
                        name,
                        e,
                        truncate_utf8_safe(args, 200)
                    ));
                }
            }
        }
    }

    Ok(ChatCompletionStreamResult {
        id: response_id,
        content,
        thinking,
        model: response_model,
        status: response_status,
        token_usage,
        tool_calls_json,
        tool_parse_errors,
        total_duration_ms: stream_start.elapsed().as_millis() as i64,
    })
}

/// Build the HTTP header map for a Chat Completions request.
///
/// Sets `Authorization: Bearer` plus user-supplied custom headers (except
/// `authorization`, `content-type`, and `accept-encoding` which are
/// reserved).
pub(super) fn build_header_map(
    api_key: &str,
    custom_headers: &HashMap<String, String>,
) -> Result<HeaderMap> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(ACCEPT_ENCODING, HeaderValue::from_static("identity"));
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {}", api_key)).map_err(|error| {
            Error::from_reason(format!("Invalid authorization header value: {}", error))
        })?,
    );

    inject_custom_headers(
        &mut headers,
        custom_headers,
        &["content-type", "accept-encoding", "authorization"],
    )?;

    Ok(headers)
}
