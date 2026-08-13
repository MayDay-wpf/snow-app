//! Anthropic streaming response collection — HTTP request, retry loop,
//! idle-timeout reconnection, and SSE event dispatch.

use std::collections::HashMap;
use std::time::Duration;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use reqwest::header::{
    HeaderMap, HeaderName, HeaderValue, ACCEPT_ENCODING, AUTHORIZATION, CONTENT_TYPE,
};
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

pub(super) struct AnthropicStreamResult {
    pub id: String,
    pub content: String,
    pub thinking: String,
    /// JSON array of complete thinking blocks (each with type/thinking/signature)
    /// captured from the stream. Persisted so the assistant turn can be
    /// round-tripped back to the Anthropic API verbatim on the next request.
    pub thinking_blocks_json: String,
    pub model: String,
    pub status: String,
    pub interruption_reason: Option<StreamInterruptionReason>,
    pub recovery_outcome: Option<StreamRecoveryOutcome>,
    pub token_usage: ChatTokenUsage,
    pub tool_calls_json: String,
    pub tool_parse_errors: Vec<String>,
    pub total_duration_ms: i64,
}

struct AnthropicAttemptState {
    raw_events: Vec<Value>,
    content_chunks: Vec<String>,
    thinking_chunks: Vec<String>,
    thinking_blocks: Vec<Value>,
    tool_calls: Vec<Value>,
    tool_call_positions_by_index: HashMap<usize, usize>,
    tool_input_json_by_index: HashMap<usize, String>,
    tool_parse_errors: Vec<String>,
    response_id: String,
    response_model: String,
    response_status: String,
    token_usage: ChatTokenUsage,
    stream_finished: bool,
    interruption_reason: Option<StreamInterruptionReason>,
    recovery_outcome: Option<StreamRecoveryOutcome>,
}

impl Default for AnthropicAttemptState {
    fn default() -> Self {
        Self {
            raw_events: Vec::new(),
            content_chunks: Vec::new(),
            thinking_chunks: Vec::new(),
            thinking_blocks: Vec::new(),
            tool_calls: Vec::new(),
            tool_call_positions_by_index: HashMap::new(),
            tool_input_json_by_index: HashMap::new(),
            tool_parse_errors: Vec::new(),
            response_id: String::new(),
            response_model: String::new(),
            response_status: String::from("completed"),
            token_usage: ChatTokenUsage::default(),
            stream_finished: false,
            interruption_reason: None,
            recovery_outcome: None,
        }
    }
}

impl AnthropicAttemptState {
    fn process_event_block(&mut self, event_block: &str) -> (String, String, String) {
        let content_start_index = self.content_chunks.len();
        let thinking_start_index = self.thinking_chunks.len();
        let mut tool_args_delta = String::new();

        super::event::process_anthropic_sse_event_block(
            event_block,
            &mut self.raw_events,
            &mut self.content_chunks,
            &mut self.thinking_chunks,
            &mut self.thinking_blocks,
            &mut self.tool_calls,
            &mut self.tool_call_positions_by_index,
            &mut self.tool_input_json_by_index,
            &mut self.response_id,
            &mut self.response_model,
            &mut self.response_status,
            &mut self.token_usage,
            &mut tool_args_delta,
            &mut self.tool_parse_errors,
            &mut self.stream_finished,
        );

        (
            self.content_chunks[content_start_index..].join(""),
            self.thinking_chunks[thinking_start_index..].join(""),
            tool_args_delta,
        )
    }

    fn clear_tool_state(&mut self) {
        self.tool_calls.clear();
        self.tool_call_positions_by_index.clear();
        self.tool_input_json_by_index.clear();
        self.tool_parse_errors.clear();
    }

    fn mark_cancelled(&mut self) {
        self.response_status = String::from("cancelled");
        self.clear_tool_state();
        self.interruption_reason = None;
        self.recovery_outcome = None;
    }

    fn finish_provider_terminal(&mut self) {
        // Pending fragments are not independently usable. For output-limit
        // results, retain the tool payload itself so the renderer can classify
        // the incomplete-like response as an unsafe tool_call and block it.
        self.tool_input_json_by_index.clear();
        self.interruption_reason = if self.response_status == "max_tokens" {
            Some(StreamInterruptionReason::OutputLimit)
        } else {
            None
        };
        self.recovery_outcome = None;
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn collect_anthropic_stream(
    client: &reqwest::Client,
    endpoint: &str,
    api_key: &str,
    custom_headers: &HashMap<String, String>,
    payload: Value,
    on_chunk: &ResponsesApiStreamCallback,
    cancel_token: &CancellationToken,
    retry_options: &RetryOptions,
    stream_idle_timeout_sec: u64,
    enable_one_m_context: bool,
) -> Result<AnthropicStreamResult> {
    let mut attempt: u32 = 0;
    let mut stream_token_count: usize = 0;
    let stream_start = std::time::Instant::now();
    let mut ttft_ms: i64 = 0;

    let idle_timeout = Duration::from_secs(stream_idle_timeout_sec);
    let mut attempt_state: AnthropicAttemptState;

    'attempt_loop: loop {
        // ---- Phase 1: send the request (with retry on connect errors) ----
        let response = loop {
            if cancel_token.is_cancelled() {
                return Ok(AnthropicStreamResult {
                    id: String::new(),
                    content: String::new(),
                    thinking: String::new(),
                    thinking_blocks_json: "[]".to_string(),
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
                .headers(build_header_map(
                    api_key,
                    custom_headers,
                    enable_one_m_context,
                )?)
                .json(&payload)
                .send();

            let result = tokio::select! {
                biased;
                _ = cancel_token.cancelled() => {
                    return Ok(AnthropicStreamResult {
                        id: String::new(),
                        content: String::new(),
                        thinking: String::new(),
                        thinking_blocks_json: "[]".to_string(),
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
                    result.map_err(|error| Error::from_reason(format!("Failed to create Anthropic stream: {}", error)))
                }
            };

            match result {
                Ok(response) => {
                    let status = response.status();
                    if !status.is_success() {
                        let error_body = response.text().await.unwrap_or_default();
                        let error = Error::from_reason(format!(
                            "Anthropic messages request failed: {} {}",
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
        // A fresh value per attempt makes retry reset atomic: no content,
        // thinking, tool fragments, parse errors, usage, or terminal state leaks.
        attempt_state = AnthropicAttemptState::default();
        let mut stream = response.bytes_stream();
        let mut byte_buffer = Vec::new();

        let stream_end = read_sse_stream_until_terminal(
            &mut stream,
            &mut byte_buffer,
            cancel_token,
            idle_timeout,
            |event_block| {
                let (content_delta, thinking_delta, tool_args_delta) =
                    attempt_state.process_event_block(event_block);
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
                attempt_state.stream_finished
            },
        )
        .await;

        if matches!(&stream_end, SseStreamEnd::Cancelled) {
            attempt_state.response_status = String::from("cancelled");
        }

        // Cancellation is authoritative even if it races with a Provider
        // terminal becoming observable at the reader boundary.
        if attempt_state.response_status == "cancelled" || cancel_token.is_cancelled() {
            attempt_state.mark_cancelled();
            break 'attempt_loop;
        }

        let (cause, retry_error) = match stream_end {
            SseStreamEnd::ProviderTerminal => {
                debug_assert!(attempt_state.stream_finished);
                attempt_state.finish_provider_terminal();
                break 'attempt_loop;
            }
            SseStreamEnd::ReadError(error) => (StreamEndCause::ReadError, error.to_string()),
            SseStreamEnd::UnexpectedEof => (
                StreamEndCause::UnexpectedEof,
                "Stream ended before an Anthropic terminal event".to_string(),
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
            visible_content_chars: visible_content_char_count(&attempt_state.content_chunks),
            has_tool_state: !attempt_state.tool_calls.is_empty(),
            has_pending_tool_fragments: !attempt_state.tool_input_json_by_index.is_empty(),
            provider_terminal: attempt_state.stream_finished,
            user_cancelled: cancel_token.is_cancelled(),
        };
        let decision = decide_stream_recovery(cause, attempt, retry_options, progress);

        match decision {
            StreamRecoveryDecision::Cancelled => {
                attempt_state.mark_cancelled();
                break 'attempt_loop;
            }
            StreamRecoveryDecision::FinishProviderResult => {
                attempt_state.finish_provider_terminal();
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
                        attempt_state.mark_cancelled();
                        break 'attempt_loop;
                    }
                    Err(wait_error) => return Err(wait_error),
                }
            }
            StreamRecoveryDecision::KeepUsablePartial
            | StreamRecoveryDecision::SurfaceInterrupted => {
                attempt_state.response_status = String::from("incomplete");
                attempt_state.interruption_reason = Some(cause.interruption_reason());
                attempt_state.recovery_outcome = decision.recovery_outcome();
                if matches!(decision, StreamRecoveryDecision::SurfaceInterrupted) {
                    attempt_state.clear_tool_state();
                } else {
                    attempt_state.tool_input_json_by_index.clear();
                }
                break 'attempt_loop;
            }
        }
    }

    let content = attempt_state.content_chunks.join("").trim().to_string();
    let thinking = attempt_state.thinking_chunks.join("").trim().to_string();
    let tool_calls_json =
        serde_json::to_string(&attempt_state.tool_calls).unwrap_or_else(|_| "[]".to_string());
    let thinking_blocks_json =
        serde_json::to_string(&attempt_state.thinking_blocks).unwrap_or_else(|_| "[]".to_string());

    // Anthropic returns input_tokens, cache_creation_input_tokens, and
    // cache_read_input_tokens as disjoint values. Normalize so input_tokens
    // includes cache tokens, matching OpenAI/Gemini semantics where
    // prompt_tokens already contains cached_tokens.
    attempt_state.token_usage.input_tokens += attempt_state.token_usage.cache_creation_input_tokens
        + attempt_state.token_usage.cache_read_input_tokens;

    Ok(AnthropicStreamResult {
        id: attempt_state.response_id,
        content,
        thinking,
        thinking_blocks_json,
        model: attempt_state.response_model,
        status: attempt_state.response_status,
        interruption_reason: attempt_state.interruption_reason,
        recovery_outcome: attempt_state.recovery_outcome,
        token_usage: attempt_state.token_usage,
        tool_calls_json,
        tool_parse_errors: attempt_state.tool_parse_errors,
        total_duration_ms: stream_start.elapsed().as_millis() as i64,
    })
}

/// Build the HTTP header map for an Anthropic request.
///
/// Anthropic requires both `x-api-key` and `Authorization: Bearer` headers
/// (the latter for compatibility with relay proxies that expect OpenAI-style
/// auth). User-supplied custom headers are injected afterwards, except
/// `authorization` and `x-api-key` which are reserved.
///
/// When `enable_one_m_context` is set (model name carries the `[1M]` marker),
/// the `anthropic-beta: context-1m-2025-08-07` header is injected to declare
/// 1M-token context support, merged (comma-joined) with a user-supplied
/// `anthropic-beta` custom header so neither overwrites the other.
pub(super) fn build_header_map(
    api_key: &str,
    custom_headers: &HashMap<String, String>,
    enable_one_m_context: bool,
) -> Result<HeaderMap> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(ACCEPT_ENCODING, HeaderValue::from_static("identity"));
    headers.insert(
        HeaderName::from_static("x-api-key"),
        HeaderValue::from_str(api_key).map_err(|error| {
            Error::from_reason(format!("Invalid API key header value: {}", error))
        })?,
    );
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {}", api_key)).map_err(|error| {
            Error::from_reason(format!("Invalid authorization header value: {}", error))
        })?,
    );

    let mut reserved_keys: Vec<&str> = vec![
        "authorization",
        "x-api-key",
        "content-type",
        "accept-encoding",
    ];
    if enable_one_m_context {
        reserved_keys.push("anthropic-beta");
        let user_beta = custom_headers
            .iter()
            .find(|(key, _)| key.trim().eq_ignore_ascii_case("anthropic-beta"))
            .map(|(_, value)| value.trim())
            .filter(|value| !value.is_empty());
        let beta_value = match user_beta {
            Some(extra) => format!("{},{}", super::payload::ANTHROPIC_ONE_M_CONTEXT_BETA, extra),
            None => super::payload::ANTHROPIC_ONE_M_CONTEXT_BETA.to_string(),
        };
        headers.insert(
            HeaderName::from_static("anthropic-beta"),
            HeaderValue::from_str(&beta_value).map_err(|error| {
                Error::from_reason(format!("Invalid anthropic-beta header value: {}", error))
            })?,
        );
    }

    inject_custom_headers(&mut headers, custom_headers, &reserved_keys)?;

    Ok(headers)
}
