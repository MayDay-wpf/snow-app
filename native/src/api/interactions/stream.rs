//! Google Interactions streaming response collection.

use std::collections::HashMap;
use std::time::Duration;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT_ENCODING, CONTENT_TYPE};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::api::common::{emit_stream_chunk, emit_tool_args_probe, inject_custom_headers};
use crate::api::responses::{ResponsesApiStreamCallback, ResponsesApiStreamChunk};
use crate::api::retry::{
    decide_stream_recovery, should_retry, stream_idle_timeout_error, visible_content_char_count,
    wait_before_retry, RetryOptions, StreamAttemptProgress, StreamEndCause,
    StreamInterruptionReason, StreamRecoveryDecision, StreamRecoveryOutcome,
};
use crate::api::sse::{read_sse_stream_until_terminal, SseStreamEnd};
use crate::storage::services::chat_conversations::ChatTokenUsage;

pub(super) struct InteractionsStreamResult {
    pub id: String,
    pub content: String,
    pub thinking: String,
    pub model: String,
    pub status: String,
    pub interruption_reason: Option<StreamInterruptionReason>,
    pub recovery_outcome: Option<StreamRecoveryOutcome>,
    pub token_usage: ChatTokenUsage,
    pub tool_calls_json: String,
    pub total_duration_ms: i64,
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn collect_interactions_stream(
    client: &reqwest::Client,
    endpoint: &str,
    custom_headers: &HashMap<String, String>,
    payload: Value,
    on_chunk: &ResponsesApiStreamCallback,
    cancel_token: &CancellationToken,
    retry_options: &RetryOptions,
    stream_idle_timeout_sec: u64,
) -> Result<InteractionsStreamResult> {
    let mut attempt: u32 = 0;
    let mut stream_token_count: usize = 0;
    let stream_start = std::time::Instant::now();
    let mut ttft_ms: i64 = 0;
    let idle_timeout = Duration::from_secs(stream_idle_timeout_sec);

    'attempt_loop: loop {
        if cancel_token.is_cancelled() {
            return Ok(InteractionsStreamResult {
                id: String::new(),
                content: String::new(),
                thinking: String::new(),
                model: String::new(),
                status: String::from("cancelled"),
                interruption_reason: None,
                recovery_outcome: None,
                token_usage: ChatTokenUsage::default(),
                tool_calls_json: "[]".to_string(),
                total_duration_ms: stream_start.elapsed().as_millis() as i64,
            });
        }

        let response = loop {
            if cancel_token.is_cancelled() {
                return Ok(InteractionsStreamResult {
                    id: String::new(),
                    content: String::new(),
                    thinking: String::new(),
                    model: String::new(),
                    status: String::from("cancelled"),
                    interruption_reason: None,
                    recovery_outcome: None,
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
                    return Ok(InteractionsStreamResult {
                        id: String::new(),
                        content: String::new(),
                        thinking: String::new(),
                        model: String::new(),
                        status: String::from("cancelled"),
                        interruption_reason: None,
                        recovery_outcome: None,
                        token_usage: ChatTokenUsage::default(),
                        tool_calls_json: "[]".to_string(),
                        total_duration_ms: stream_start.elapsed().as_millis() as i64,
                    });
                }
                result = send_future => {
                    result.map_err(|error| {
                        let category = if error.is_timeout() {
                            "network timeout"
                        } else if error.is_connect() {
                            "network connection error"
                        } else {
                            "network request error"
                        };
                        Error::from_reason(format!("Failed to create Interactions stream: {category}"))
                    })
                }
            };

            match result {
                Ok(response) => {
                    let status = response.status();
                    if !status.is_success() {
                        let error_text = response
                            .text()
                            .await
                            .unwrap_or_else(|_| "Failed to read response body".to_string());
                        let error_text = super::event::bounded_provider_error_response(&error_text);
                        let error = Error::from_reason(format!(
                            "Interactions stream request failed: {status} {error_text}"
                        ));

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
                            Err(err) => return Err(err),
                        }
                    }
                    break response;
                }
                Err(error) => {
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
                        Err(err) => return Err(err),
                    }
                }
            }
        };

        let mut content_chunks: Vec<String> = Vec::new();
        let mut thinking_chunks: Vec<String> = Vec::new();
        let mut raw_events: Vec<Value> = Vec::new();
        let mut tool_calls = super::event::InteractionsToolCallState::default();
        let mut response_id = String::new();
        let mut response_model = String::new();
        let mut response_status = String::from("in_progress");
        let mut provider_failure = None;
        let mut token_usage = ChatTokenUsage::default();
        let mut byte_buffer: Vec<u8> = Vec::new();
        let mut stream_finished = false;
        let mut interruption_reason = None;
        let mut recovery_outcome = None;
        let mut stream = response.bytes_stream();
        let mut end_cause: Option<(StreamEndCause, String)> = None;

        macro_rules! process_event_block {
            ($event_block:expr) => {{
                let content_start_index = content_chunks.len();
                let thinking_start_index = thinking_chunks.len();
                let mut tool_args_delta = String::new();
                super::event::process_interactions_sse_event_block(
                    $event_block,
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
                    &mut provider_failure,
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

        match stream_end {
            SseStreamEnd::ProviderTerminal => {
                stream_finished = true;
            }
            SseStreamEnd::ReadError(error) => {
                end_cause = Some((StreamEndCause::ReadError, error.to_string()));
            }
            SseStreamEnd::UnexpectedEof => {
                end_cause = Some((
                    StreamEndCause::UnexpectedEof,
                    "Stream ended before an Interactions terminal event".to_string(),
                ));
            }
            SseStreamEnd::IdleTimeout => {
                end_cause = Some((
                    StreamEndCause::IdleTimeout,
                    stream_idle_timeout_error().reason.clone(),
                ));
            }
            SseStreamEnd::Cancelled => {
                response_status = String::from("cancelled");
            }
        }

        if response_status == "cancelled" || cancel_token.is_cancelled() {
            response_status = String::from("cancelled");
            tool_calls.clear();
            interruption_reason = None;
            recovery_outcome = None;
        } else if let Some(failure) = provider_failure {
            tool_calls.clear();
            return Err(Error::from_reason(failure.reason()));
        } else if stream_finished {
            recovery_outcome = None;
        } else {
            let (cause, retry_error) = end_cause.unwrap_or((
                StreamEndCause::UnexpectedEof,
                "Stream ended before an Interactions terminal event".to_string(),
            ));
            let progress = StreamAttemptProgress {
                visible_content_chars: visible_content_char_count(&content_chunks),
                has_tool_state: tool_calls.has_tool_state(),
                has_pending_tool_fragments: tool_calls.has_pending_tool_fragments(),
                provider_terminal: stream_finished,
                user_cancelled: cancel_token.is_cancelled(),
            };
            let decision = decide_stream_recovery(cause, attempt, retry_options, progress);

            match decision {
                StreamRecoveryDecision::Cancelled => {
                    response_status = String::from("cancelled");
                    tool_calls.clear();
                    interruption_reason = None;
                    recovery_outcome = None;
                }
                StreamRecoveryDecision::FinishProviderResult => {}
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
                            interruption_reason = None;
                            recovery_outcome = None;
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
                        tool_calls.clear();
                    }
                }
            }
        }

        let content = content_chunks.join("").trim().to_string();
        let thinking = thinking_chunks.join("").trim().to_string();
        let finalized_tool_calls = tool_calls.finalized_tool_calls();
        let tool_calls_json =
            serde_json::to_string(&finalized_tool_calls).unwrap_or_else(|_| "[]".to_string());

        return Ok(InteractionsStreamResult {
            id: response_id,
            content,
            thinking,
            model: response_model,
            status: response_status,
            interruption_reason,
            recovery_outcome,
            token_usage,
            tool_calls_json,
            total_duration_ms: stream_start.elapsed().as_millis() as i64,
        });
    }
}

fn build_header_map(custom_headers: &HashMap<String, String>) -> Result<HeaderMap> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(ACCEPT_ENCODING, HeaderValue::from_static("identity"));
    inject_custom_headers(
        &mut headers,
        custom_headers,
        &["authorization", "x-goog-api-key"],
    )?;
    Ok(headers)
}
