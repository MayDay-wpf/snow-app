//! Gemini streaming response collection — HTTP request, retry loop, and
//! SSE event dispatch.
//!
//! The whole request+stream cycle lives in a single retry loop (matching
//! Anthropic/Chat). Non-SSE responses (HTTP 200 with a JSON error envelope
//! instead of a valid SSE stream) are retried in Rust so transient relay
//! failures can recover without bouncing back to the JS agent loop.

use std::collections::HashMap;

use futures::StreamExt;
use napi::bindgen_prelude::*;
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT_ENCODING, CONTENT_TYPE};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::api::common::{emit_stream_chunk, emit_tool_args_probe, inject_custom_headers};
use crate::api::responses::{ResponsesApiStreamCallback, ResponsesApiStreamChunk};
use crate::api::retry::{non_sse_response_error, should_retry, wait_before_retry, RetryOptions};
use crate::api::sse::find_sse_separator;
use crate::storage::services::chat_conversations::ChatTokenUsage;

pub(super) struct GeminiStreamResult {
    pub id: String,
    pub content: String,
    pub thinking: String,
    pub model: String,
    pub status: String,
    pub token_usage: ChatTokenUsage,
    pub tool_calls_json: String,
    pub total_duration_ms: i64,
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn collect_gemini_stream(
    client: &reqwest::Client,
    endpoint: &str,
    custom_headers: &HashMap<String, String>,
    payload: Value,
    on_chunk: &ResponsesApiStreamCallback,
    cancel_token: &CancellationToken,
    retry_options: &RetryOptions,
) -> Result<GeminiStreamResult> {
    let mut attempt: u32 = 0;
    let mut stream_token_count: usize = 0;
    let stream_start = std::time::Instant::now();
    let mut ttft_ms: i64 = 0;

    loop {
        if cancel_token.is_cancelled() {
            return Ok(GeminiStreamResult {
                id: String::new(),
                content: String::new(),
                thinking: String::new(),
                model: String::new(),
                status: String::from("cancelled"),
                token_usage: ChatTokenUsage::default(),
                tool_calls_json: "[]".to_string(),
                total_duration_ms: stream_start.elapsed().as_millis() as i64,
            });
        }

        let response = loop {
            if cancel_token.is_cancelled() {
                return Ok(GeminiStreamResult {
                    id: String::new(),
                    content: String::new(),
                    thinking: String::new(),
                    model: String::new(),
                    status: String::from("cancelled"),
                    token_usage: ChatTokenUsage::default(),
                    tool_calls_json: "[]".to_string(),
                    total_duration_ms: stream_start.elapsed().as_millis() as i64,
                });
            }

            let send_future = client
                .post(endpoint)
                .headers(build_header_map(custom_headers)?)
                .json(&payload)
                .send();

            let result = tokio::select! {
                biased;
                _ = cancel_token.cancelled() => {
                    return Ok(GeminiStreamResult {
                        id: String::new(),
                        content: String::new(),
                        thinking: String::new(),
                        model: String::new(),
                        status: String::from("cancelled"),
                        token_usage: ChatTokenUsage::default(),
                        tool_calls_json: "[]".to_string(),
                        total_duration_ms: stream_start.elapsed().as_millis() as i64,
                    });
                }
                result = send_future => {
                    result.map_err(|error| Error::from_reason(format!("Failed to create Gemini stream: {error}")))
                }
            };

            match result {
                Ok(response) => {
                    let status = response.status();
                    if !status.is_success() {
                        let error_body = response.text().await.unwrap_or_default();
                        let error = Error::from_reason(format!(
                            "Gemini streamGenerateContent request failed: {} {}",
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

        // ---- Phase 2: read the streaming body ----
        // All accumulated state is declared per-attempt so a retry starts fresh.
        let mut raw_events = Vec::new();
        let mut content_chunks = Vec::new();
        let mut thinking_chunks = Vec::new();
        let mut tool_calls = Vec::new();
        let mut response_id = String::new();
        let mut response_model = String::new();
        let mut response_status = String::from("completed");
        let mut token_usage = ChatTokenUsage::default();
        let mut byte_buffer: Vec<u8> = Vec::new();
        let mut stream = response.bytes_stream();
        // Track whether the stream completed normally. If the loop exits because
        // of a read error or unexpected EOF (not via a finishReason event and
        // not via cancellation), we mark the response as "incomplete" so the
        // frontend can still process any collected content and tool calls.
        #[allow(unused_assignments)]
        let mut stream_completed_normally = false;
        // Set by process_gemini_sse_event_block when finishReason is received.
        let mut stream_finished = false;
        loop {
            tokio::select! {
                biased;
                _ = cancel_token.cancelled() => {
                    response_status = String::from("cancelled");
                    stream_completed_normally = true;
                    break;
                }
                chunk_result = stream.next() => {
                    let Some(chunk_result) = chunk_result else {
                        // Stream ended without a finishReason. Treat as
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
                            eprintln!("Gemini stream read error (keeping partial result): {error}");
                            break;
                        }
                    };
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
                        super::event::process_gemini_sse_event_block(
                            &event_block,
                            &mut raw_events,
                            &mut content_chunks,
                            &mut thinking_chunks,
                            &mut tool_calls,
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
                        emit_stream_chunk(
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

        // If the stream ended abnormally (no finishReason and no cancellation),
        // mark the response as incomplete so the frontend knows the result is
        // partial but still usable.
        if !stream_completed_normally && !stream_finished && response_status == "completed" {
            response_status = String::from("incomplete");
        }

        if response_status != "cancelled" && !byte_buffer.is_empty() {
            let trailing_buffer = String::from_utf8_lossy(&byte_buffer).to_string();
            if !trailing_buffer.trim().is_empty() {
                let content_start_index = content_chunks.len();
                let thinking_start_index = thinking_chunks.len();
                let mut tool_args_delta = String::new();
                super::event::process_gemini_sse_event_block(
                    &trailing_buffer,
                    &mut raw_events,
                    &mut content_chunks,
                    &mut thinking_chunks,
                    &mut tool_calls,
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
                emit_stream_chunk(
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

        // Non-SSE response detection: the stream received bytes but none of them
        // formed a valid SSE event. This happens when a relay returns HTTP 200
        // with a JSON error body (e.g. quota exhausted) instead of a proper SSE
        // stream. Treat it as a retriable error so the request is re-issued with
        // the original parameters, matching the Anthropic/Chat recovery pattern.
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
                    // Per-attempt state is re-declared at the top of
                    // Phase 2, so just re-issue the request.
                    attempt += 1;
                    continue;
                }
                Err(e) => return Err(e),
            }
        }

        let content = content_chunks.join("").trim().to_string();
        let thinking = thinking_chunks.join("").trim().to_string();
        let tool_calls_json =
            serde_json::to_string(&tool_calls).unwrap_or_else(|_| "[]".to_string());

        return Ok(GeminiStreamResult {
            id: response_id,
            content,
            thinking,
            model: response_model,
            status: response_status,
            token_usage,
            tool_calls_json,
            total_duration_ms: stream_start.elapsed().as_millis() as i64,
        });
    }
}

/// Build the HTTP header map for a Gemini request.
///
/// Gemini authenticates via the API key in the URL query string, so no
/// `Authorization` header is needed. User-supplied custom headers are
/// injected afterwards, except `content-type` and `accept-encoding` which
/// are reserved.
pub(super) fn build_header_map(custom_headers: &HashMap<String, String>) -> Result<HeaderMap> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(ACCEPT_ENCODING, HeaderValue::from_static("identity"));

    inject_custom_headers(
        &mut headers,
        custom_headers,
        &["content-type", "accept-encoding"],
    )?;

    Ok(headers)
}
