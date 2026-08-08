//! Responses API streaming response collection — HTTP request, retry loop,
//! idle-timeout reconnection, and SSE event dispatch.
//!
//! Uses raw reqwest `bytes_stream()` instead of the `async_openai` SDK so that
//! the streaming behaviour (idle timeout, non-SSE detection, partial tool-call
//! reconstruction) is identical to the Chat Completions and Anthropic
//! providers.

use std::collections::HashMap;
use std::time::Duration;

use futures::StreamExt;
use napi::bindgen_prelude::*;
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use crate::api::common::{emit_stream_chunk, truncate_utf8_safe};
use crate::api::responses::{ResponsesApiStreamCallback, ResponsesApiStreamChunk};
use crate::api::retry::{
    non_sse_response_error, should_retry, stream_idle_timeout_error, wait_before_retry,
    RetryOptions,
};
use crate::api::sse::find_sse_separator;
use crate::api::token_counter::count_tokens;
use crate::storage::services::chat_conversations::ChatTokenUsage;

use super::event::{
    collect_reasoning_items, collect_reasoning_text, collect_tool_calls, extract_output_text,
    extract_response_error, extract_response_thinking, process_responses_sse_event_block,
};

pub(super) struct StreamingResponseResult {
    pub id: String,
    pub content: String,
    pub thinking: String,
    /// JSON array of reasoning output items captured from
    /// `response.output_item.done` events (each containing type=reasoning,
    /// summary, and encrypted_content). Persisted so the next request can
    /// round-trip reasoning verbatim when store:false.
    pub reasoning_items_json: String,
    pub model: String,
    pub status: String,
    pub token_usage: ChatTokenUsage,
    pub tool_calls_json: String,
    pub tool_parse_errors: Vec<String>,
    pub total_duration_ms: i64,
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn collect_streaming_response(
    client: &reqwest::Client,
    endpoint: &str,
    api_key: &str,
    custom_headers: &HashMap<String, String>,
    payload: Value,
    on_chunk: &ResponsesApiStreamCallback,
    cancel_token: &CancellationToken,
    retry_options: &RetryOptions,
    stream_idle_timeout_sec: u64,
) -> Result<StreamingResponseResult> {
    let mut attempt: u32 = 0;
    let mut stream_token_count: usize = 0;
    let stream_start = std::time::Instant::now();
    let mut ttft_ms: i64 = 0;

    // State accumulated across the stream of a single HTTP response. These are
    // declared outside the main loop so that, when the stream idle timeout
    // fires mid-stream, we can discard the partial result and reset them
    // before re-issuing the request with the original parameters.
    let mut raw_events: Vec<Value> = Vec::new();
    let mut content_chunks: Vec<String> = Vec::new();
    let mut thinking_chunks: Vec<String> = Vec::new();
    let mut tool_calls: Vec<Value> = Vec::new();
    let mut reasoning_items: Vec<Value> = Vec::new();
    let mut tool_parse_errors: Vec<String> = Vec::new();
    let mut streaming_tool_items: HashMap<u64, (Value, String)> = HashMap::new();
    let mut response_id = String::new();
    let mut response_model = String::new();
    let mut response_status;
    let mut token_usage: ChatTokenUsage;
    let mut byte_buffer: Vec<u8> = Vec::new();

    let idle_timeout = Duration::from_secs(stream_idle_timeout_sec);
    // Track whether the stream completed normally (via
    // response.completed/incomplete/failed, or cancellation). When false
    // after the inner loop, the response is marked "incomplete".
    #[allow(unused_assignments)]
    let mut stream_completed_normally = false;
    #[allow(unused_assignments)]
    let mut reasoning_text_streamed = false;

    loop {
        // ---- Phase 1: send the request (with retry on connect errors) ----
        let header_map = super::payload::build_header_map(api_key, custom_headers)?;
        let response = loop {
            if cancel_token.is_cancelled() {
                return Ok(StreamingResponseResult {
                    id: String::new(),
                    content: String::new(),
                    thinking: String::new(),
                    reasoning_items_json: "[]".to_string(),
                    model: String::new(),
                    status: String::from("cancelled"),
                    token_usage: ChatTokenUsage {
                        input_tokens: 0,
                        output_tokens: 0,
                        cache_creation_input_tokens: 0,
                        cache_read_input_tokens: 0,
                    },
                    tool_calls_json: "[]".to_string(),
                    tool_parse_errors: Vec::new(),
                    total_duration_ms: stream_start.elapsed().as_millis() as i64,
                });
            }

            let send_future = client
                .post(endpoint)
                .headers(header_map.clone())
                .json(&payload)
                .send();

            let result = tokio::select! {
                biased;
                _ = cancel_token.cancelled() => {
                    return Ok(StreamingResponseResult {
                        id: String::new(),
                        content: String::new(),
                        thinking: String::new(),
                        reasoning_items_json: "[]".to_string(),
                        model: String::new(),
                        status: String::from("cancelled"),
                        token_usage: ChatTokenUsage {
                            input_tokens: 0,
                            output_tokens: 0,
                            cache_creation_input_tokens: 0,
                            cache_read_input_tokens: 0,
                        },
                        tool_calls_json: "[]".to_string(),
                        tool_parse_errors: Vec::new(),
                        total_duration_ms: stream_start.elapsed().as_millis() as i64,
                    });
                }
                result = send_future => {
                    result.map_err(|error| Error::from_reason(format!("Failed to create response stream: {error}")))
                }
            };

            match result {
                Ok(response) => {
                    let status = response.status();
                    if !status.is_success() {
                        let error_body = response.text().await.unwrap_or_default();
                        let error = Error::from_reason(format!(
                            "Responses API request failed: {} {}",
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
        // Idle timer: reset on every received chunk. If no data arrives
        // within `stream_idle_timeout_sec`, we abandon the stalled stream and
        // re-issue the request with the original parameters.
        let mut idle_deadline = tokio::time::Instant::now() + idle_timeout;
        // Per-attempt state: declared fresh so a retry starts clean.
        raw_events.clear();
        content_chunks.clear();
        thinking_chunks.clear();
        tool_calls.clear();
        reasoning_items.clear();
        tool_parse_errors.clear();
        streaming_tool_items.clear();
        response_id.clear();
        response_model.clear();
        response_status = String::from("completed");
        token_usage = ChatTokenUsage {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
        };
        byte_buffer.clear();
        reasoning_text_streamed = false;
        let mut completed_response: Option<Value> = None;

        loop {
            tokio::select! {
                biased;
                _ = cancel_token.cancelled() => {
                    response_status = String::from("cancelled");
                    stream_completed_normally = true;
                    break;
                }
                _ = tokio::time::sleep_until(idle_deadline) => {
                    // Stream idle timeout: no data received for the
                    // configured period. Treat as a retriable error so the
                    // agent loop re-issues the request with the original
                    // parameters.
                    let error = stream_idle_timeout_error();
                    if !should_retry(&error, attempt, retry_options) {
                        // Exhausted retries — return whatever we have so far
                        // rather than discarding partial work. The response
                        // will be marked "incomplete".
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
                        // Stream ended without an explicit terminal event.
                        // Treat this as an incomplete response rather than a
                        // hard error so partial content and tool calls
                        // remain usable.
                        break;
                    };

                    let chunk = match chunk_result {
                        Ok(chunk) => chunk,
                        Err(error) => {
                            // Network/read error mid-stream: log and break
                            // instead of returning Err. We keep whatever
                            // content and tool calls have been collected so
                            // far so the agent loop can continue with partial
                            // results.
                            eprintln!("Responses stream read error (keeping partial result): {error}");
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

                        let (content_delta, thinking_delta) = process_responses_sse_event_block(
                            &event_block,
                            &mut raw_events,
                            &mut content_chunks,
                            &mut thinking_chunks,
                            &mut tool_calls,
                            &mut reasoning_items,
                            &mut streaming_tool_items,
                            &mut response_id,
                            &mut response_model,
                            &mut response_status,
                            &mut token_usage,
                            &mut completed_response,
                            &mut stream_completed_normally,
                            &mut reasoning_text_streamed,
                        );

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

                        // Emit tool-argument token probe: when
                        // function_call_arguments.delta events arrive, we
                        // need to count their tokens in real time. The
                        // process_responses_sse_event_block function
                        // accumulates args into streaming_tool_items, so we
                        // approximate by counting the raw event block size
                        // for tool-arg deltas. However, the event block
                        // function already handles this internally, so we
                        // skip a separate probe here — the token count is
                        // updated by emit_stream_chunk for content/thinking
                        // deltas.
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

        // Process a final SSE event even when the upstream closes without the
        // usual blank-line separator. Terminal failed/completed events often
        // carry the only status and error details for the request.
        if response_status != "cancelled" && !byte_buffer.is_empty() {
            let trailing_buffer = String::from_utf8_lossy(&byte_buffer).to_string();
            if !trailing_buffer.trim().is_empty() {
                let (content_delta, thinking_delta) = process_responses_sse_event_block(
                    &trailing_buffer,
                    &mut raw_events,
                    &mut content_chunks,
                    &mut thinking_chunks,
                    &mut tool_calls,
                    &mut reasoning_items,
                    &mut streaming_tool_items,
                    &mut response_id,
                    &mut response_model,
                    &mut response_status,
                    &mut token_usage,
                    &mut completed_response,
                    &mut stream_completed_normally,
                    &mut reasoning_text_streamed,
                );
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
            }
        }

        // Empty-response interruption: the connection dropped (EOF or read
        // error) before ANY content, thinking, tool call, or streaming tool
        // fragment was produced. Retrying is safe — nothing was emitted to
        // the user — and recovers transient relay/proxy disconnects that
        // would otherwise surface as a silent empty "incomplete" response.
        if !stream_completed_normally
            && response_status != "cancelled"
            && content_chunks.is_empty()
            && thinking_chunks.is_empty()
            && tool_calls.is_empty()
            && streaming_tool_items.is_empty()
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
                    // Per-attempt state is reset at the top of Phase 2
                    // (raw_events/content_chunks/... are cleared there), so
                    // just re-issue the request.
                    attempt += 1;
                    continue;
                }
                Err(e) => return Err(e),
            }
        }

        // If the stream ended abnormally (no terminal event and no
        // cancellation), mark the response as incomplete so the frontend
        // knows the result is partial but still usable.
        if !stream_completed_normally && response_status == "completed" {
            response_status = String::from("incomplete");
        }

        // Reconstruct tool calls from streaming fragments when the normal
        // `output_item.done` path did not fire for every item. This handles
        // the case where the stream was interrupted mid-tool-call: we take
        // the item metadata (name, call_id) captured in `output_item.added`
        // and attach the accumulated argument fragments. Even if the
        // arguments are partial JSON, we pass them through as a string so the
        // frontend/tool layer can decide how to handle them.
        if tool_calls.is_empty() && !streaming_tool_items.is_empty() {
            let mut indices: Vec<u64> = streaming_tool_items.keys().copied().collect();
            indices.sort_unstable();
            for index in indices {
                let (item, args) = streaming_tool_items.remove(&index).unwrap();
                if item.is_null() {
                    // We have arguments but no item metadata — cannot
                    // reconstruct a meaningful tool call without
                    // name/call_id. Skip it.
                    continue;
                }
                let mut reconstructed = item;
                if !args.is_empty() {
                    // Try to parse the accumulated arguments as JSON; if
                    // that fails, embed the raw string so the tool layer can
                    // surface a clear error rather than silently dropping the
                    // call.
                    if let Ok(parsed) = serde_json::from_str::<Value>(&args) {
                        reconstructed
                            .as_object_mut()
                            .map(|obj| obj.insert("arguments".to_string(), parsed));
                    } else {
                        tool_parse_errors.push(format!(
                            "tool=reconstructed, error=invalid JSON, raw={}",
                            truncate_utf8_safe(&args, 200)
                        ));
                        reconstructed
                            .as_object_mut()
                            .map(|obj| obj.insert("arguments".to_string(), Value::String(args)));
                    }
                }
                tool_calls.push(reconstructed);
            }
        }

        if let Some(response) = completed_response.as_ref() {
            if content_chunks.is_empty() {
                let content = extract_output_text(response);
                if !content.is_empty() {
                    content_chunks.push(content);
                }
            }

            if thinking_chunks.is_empty() {
                let thinking = extract_response_thinking(response);
                if !thinking.is_empty() {
                    thinking_chunks.push(thinking);
                }
            }

            if tool_calls.is_empty() {
                collect_tool_calls(response.get("output"), &mut tool_calls);
            }

            // Fallback: extract reasoning items from the completed response's
            // output tree. Some providers (e.g. DeepSeek's Responses API)
            // stream reasoning via `response.reasoning_text.delta` events but
            // do NOT emit `output_item.added`/`done` with type=reasoning, so
            // the streaming capture above leaves reasoning_items empty.
            // Without these items the next request cannot round-trip
            // reasoning, and DeepSeek rejects it with HTTP 400 "The
            // reasoning_text in the thinking mode must be passed back to the
            // API."
            if reasoning_items.is_empty() {
                collect_reasoning_items(response.get("output"), &mut reasoning_items);
            }
        }

        // A terminal `response.failed` event is a failed request, not a valid
        // empty assistant response. Retry transient provider failures only when
        // no output has been emitted; otherwise preserve the partial result and
        // let the caller surface it as failed.
        if response_status == "failed"
            && content_chunks.is_empty()
            && thinking_chunks.is_empty()
            && tool_calls.is_empty()
            && reasoning_items.is_empty()
        {
            let error_message = completed_response
                .as_ref()
                .and_then(extract_response_error)
                .unwrap_or_else(|| {
                    "Responses API returned failed status without error details".to_string()
                });
            let error = Error::from_reason(error_message);

            if !should_retry(&error, attempt, retry_options) {
                return Err(error);
            }

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
                Err(wait_error) => return Err(wait_error),
            }
        }

        // Last-resort synthesis: if we still have no structured reasoning
        // items but did receive reasoning text (via reasoning_text.delta or
        // reasoning_summary_text.delta), build a minimal reasoning item so
        // the next request can round-trip it. The item carries the full text
        // in a `reasoning_text` field — the same field DeepSeek expects to
        // receive back.
        if reasoning_items.is_empty() {
            let thinking = thinking_chunks.join("").trim().to_string();
            if !thinking.is_empty() {
                reasoning_items.push(json!({
                    "type": "reasoning",
                    "reasoning_text": thinking,
                }));
            }
        }

        // Non-SSE response detection: the stream received bytes but none of
        // them formed a valid SSE event. This happens when a relay returns
        // HTTP 200 with a JSON error body (e.g. quota exhausted) instead of
        // a proper SSE stream. Treat it as a retriable error so the request
        // is re-issued, matching the idle-timeout recovery pattern.
        if !stream_completed_normally
            && response_status != "cancelled"
            && raw_events.is_empty()
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

        // Stream finalized — exit the outer loop.
        break;
    }

    let content = content_chunks.join("").trim().to_string();
    let thinking = thinking_chunks.join("").trim().to_string();
    let tool_calls_json = serde_json::to_string(&tool_calls).unwrap_or_else(|_| "[]".to_string());
    let reasoning_items_json =
        serde_json::to_string(&reasoning_items).unwrap_or_else(|_| "[]".to_string());

    // Silence unused-import warning — collect_reasoning_text is re-exported
    // for downstream modules that may reference it via the responses module.
    let _ = collect_reasoning_text as fn(Option<&Value>, &mut Vec<String>);
    // Silence unused-import warning — count_tokens is used inline for
    // tool-arg token counting in the probe path.
    let _ = count_tokens as fn(&str) -> usize;

    Ok(StreamingResponseResult {
        id: response_id,
        content,
        thinking,
        reasoning_items_json,
        model: response_model,
        status: response_status,
        token_usage,
        tool_calls_json,
        tool_parse_errors,
        total_duration_ms: stream_start.elapsed().as_millis() as i64,
    })
}
