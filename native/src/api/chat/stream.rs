//! Chat Completions streaming response collection — HTTP request, retry
//! loop, idle-timeout reconnection, and SSE event dispatch.

use std::collections::HashMap;
use std::time::Duration;

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
    decide_stream_recovery, should_retry, stream_idle_timeout_error, visible_content_char_count,
    wait_before_retry, RetryOptions, StreamAttemptProgress, StreamEndCause,
    StreamInterruptionReason, StreamRecoveryDecision, StreamRecoveryOutcome,
};
use crate::api::sse::{read_sse_stream_until_terminal, SseStreamEnd};
use crate::storage::services::chat_conversations::ChatTokenUsage;

pub(super) struct ChatCompletionStreamResult {
    pub id: String,
    pub content: String,
    pub thinking: String,
    pub model: String,
    pub status: String,
    pub interruption_reason: Option<StreamInterruptionReason>,
    pub recovery_outcome: Option<StreamRecoveryOutcome>,
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
    let mut response_status: String;
    let mut token_usage: ChatTokenUsage;
    let mut byte_buffer: Vec<u8> = Vec::new();
    // Set once a `finish_reason` chunk arrives. The stream keeps reading
    // afterwards so the trailing `usage` chunk (sent with
    // `stream_options.include_usage`) can be collected; the transport is only
    // truly terminal on `[DONE]` (or on EOF/timeout with this flag already
    // set, which is treated as a normal completion).
    let mut finish_reason_seen: bool;

    let idle_timeout = Duration::from_secs(stream_idle_timeout_sec);
    let mut stream_finished: bool;
    let mut interruption_reason: Option<StreamInterruptionReason>;
    let mut recovery_outcome: Option<StreamRecoveryOutcome>;

    'attempt_loop: loop {
        // ---- Phase 1: send the request (with retry on connect errors) ----
        let response = loop {
            if cancel_token.is_cancelled() {
                return Ok(ChatCompletionStreamResult {
                    id: String::new(),
                    content: String::new(),
                    thinking: String::new(),
                    model: String::new(),
                    status: String::from("cancelled"),
                    interruption_reason: None,
                    recovery_outcome: None,
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
                        interruption_reason: None,
                        recovery_outcome: None,
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

        // ---- Phase 2: read one complete Provider attempt ----
        // Every retry cause returns to this single reset point, so content,
        // thinking, tools, usage, buffer, terminal state, and final metadata
        // can never leak across attempts.
        raw_events.clear();
        content_chunks.clear();
        thinking_chunks.clear();
        tool_calls.clear();
        tool_call_positions_by_index.clear();
        response_id.clear();
        response_model.clear();
        response_status = String::from("completed");
        token_usage = ChatTokenUsage::default();
        byte_buffer.clear();
        stream_finished = false;
        finish_reason_seen = false;
        interruption_reason = None;
        recovery_outcome = None;

        let mut stream = response.bytes_stream();

        macro_rules! process_event_block {
            ($event_block:expr) => {{
                let content_start_index = content_chunks.len();
                let thinking_start_index = thinking_chunks.len();
                let mut tool_args_delta = String::new();
                super::event::process_sse_event_block(
                    $event_block,
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
                    &mut finish_reason_seen,
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
            }};
        }

        let stream_end = read_sse_stream_until_terminal(
            &mut stream,
            &mut byte_buffer,
            cancel_token,
            idle_timeout,
            |event_block| {
                process_event_block!(event_block);
                stream_finished
            },
        )
        .await;

        if matches!(&stream_end, SseStreamEnd::Cancelled) {
            response_status = String::from("cancelled");
        }

        // Cancellation is authoritative even if it races with a Provider
        // terminal becoming observable at the shared reader boundary.
        if response_status == "cancelled" || cancel_token.is_cancelled() {
            response_status = String::from("cancelled");
            tool_calls.clear();
            tool_call_positions_by_index.clear();
            interruption_reason = None;
            recovery_outcome = None;
            break 'attempt_loop;
        }

        let (cause, retry_error) = match stream_end {
            SseStreamEnd::ProviderTerminal => {
                debug_assert!(stream_finished);
                if response_status == "length" {
                    interruption_reason = Some(StreamInterruptionReason::OutputLimit);
                }
                recovery_outcome = None;
                break 'attempt_loop;
            }
            SseStreamEnd::ReadError(error) => (StreamEndCause::ReadError, error.to_string()),
            SseStreamEnd::UnexpectedEof => (
                StreamEndCause::UnexpectedEof,
                "Stream ended before a Chat terminal event".to_string(),
            ),
            SseStreamEnd::IdleTimeout => (
                StreamEndCause::IdleTimeout,
                stream_idle_timeout_error().reason.clone(),
            ),
            SseStreamEnd::Cancelled => {
                unreachable!("cancelled stream is finalized before recovery")
            }
        };
        let progress = StreamAttemptProgress {
            visible_content_chars: visible_content_char_count(&content_chunks),
            has_tool_state: !tool_calls.is_empty(),
            has_pending_tool_fragments: false,
            // `finish_reason` counts as provider terminal too: the stream may
            // still deliver the trailing `usage` chunk (and then `[DONE]`),
            // but an EOF/timeout/read-error after it is a normal completion,
            // not an interruption.
            provider_terminal: stream_finished || finish_reason_seen,
            user_cancelled: cancel_token.is_cancelled(),
        };
        let decision = decide_stream_recovery(cause, attempt, retry_options, progress);

        match decision {
            StreamRecoveryDecision::Cancelled => {
                response_status = String::from("cancelled");
                tool_calls.clear();
                tool_call_positions_by_index.clear();
                interruption_reason = None;
                recovery_outcome = None;
                break 'attempt_loop;
            }
            StreamRecoveryDecision::FinishProviderResult => {
                // Normal completion after a `finish_reason` (reached on
                // EOF/timeout when the provider never sends `[DONE]`).
                // Mirror the `ProviderTerminal` handling so an output-limit
                // finish keeps its interruption classification.
                if response_status == "length" {
                    interruption_reason = Some(StreamInterruptionReason::OutputLimit);
                }
                break 'attempt_loop;
            }
            StreamRecoveryDecision::Retry => {
                on_chunk.call(
                    ResponsesApiStreamChunk {
                        content_delta: String::new(),
                        thinking_delta: String::new(),
                        content: String::new(),
                        thinking: String::new(),
                        retrying: true,
                        retry_attempt: Some((attempt + 1) as i32),
                        retry_error: Some(retry_error),
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
                        continue 'attempt_loop;
                    }
                    Err(_wait_error) if cancel_token.is_cancelled() => {
                        response_status = String::from("cancelled");
                        tool_calls.clear();
                        tool_call_positions_by_index.clear();
                        interruption_reason = None;
                        recovery_outcome = None;
                        break 'attempt_loop;
                    }
                    Err(wait_error) => return Err(wait_error),
                }
            }
            StreamRecoveryDecision::KeepUsablePartial
            | StreamRecoveryDecision::SurfaceInterrupted => {
                response_status = String::from("incomplete");
                interruption_reason = Some(cause.interruption_reason());
                recovery_outcome = decision.recovery_outcome();
                if matches!(decision, StreamRecoveryDecision::SurfaceInterrupted) {
                    // A transport-final result may keep display text/thinking,
                    // but no finalized or partial tool state may escape.
                    tool_calls.clear();
                    tool_call_positions_by_index.clear();
                }
                break 'attempt_loop;
            }
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
        interruption_reason,
        recovery_outcome,
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
