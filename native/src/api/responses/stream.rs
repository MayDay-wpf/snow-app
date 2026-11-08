//! Responses API streaming response collection — HTTP request, retry loop,
//! idle-timeout reconnection, and SSE event dispatch.
//!
//! Uses raw reqwest `bytes_stream()` instead of the `async_openai` SDK so that
//! the streaming behaviour (idle timeout, non-SSE detection, partial tool-call
//! reconstruction) is identical to the Chat Completions and Anthropic
//! providers.

use std::collections::HashMap;
use std::path::PathBuf;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use crate::api::common::StreamSink;
use crate::api::common::{emit_stream_chunk, emit_tool_args_probe, ThinkingStreamTracker};
use crate::api::responses::ResponsesApiStreamChunk;
use crate::api::retry::{
    attempt_has_payload, decide_stream_recovery, log_retry_attempt, retry_backoff_ms, send_failure_cause, should_retry,
    should_retry_empty_response, visible_content_char_count,
    wait_before_retry, RetryOptions, StreamAttemptProgress, StreamEndCause,
    StreamInterruptionReason, StreamRecoveryDecision, StreamRecoveryOutcome, StreamTimeouts,
    EMPTY_RESPONSE_RETRY_ERROR,
};
use crate::api::oauth::plugin::response as plugin_response;
use crate::api::request_proxy;
use crate::api::sse::{read_sse_stream_until_terminal, SseStreamEnd};
use crate::storage::services::chat_conversations::ChatTokenUsage;

use super::event::{
    collect_reasoning_items, collect_tool_calls, extract_output_text, extract_response_thinking,
    process_responses_sse_event_block,
};

/// 上游以 `response.failed` 收尾但未给出任何可读原因时的兜底标记，
/// 保证失败终态在 app_logs 里至少留下一条可检索的线索。
pub(super) const RESPONSES_FAILED_NO_REASON: &str =
    "Responses stream failed without a readable error payload";

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
    pub interruption_reason: Option<StreamInterruptionReason>,
    pub recovery_outcome: Option<StreamRecoveryOutcome>,
    /// Bounded, redacted reason of a provider failure after recovery stops.
    pub failure_reason: Option<String>,
    pub failure: Option<crate::api::failure::ProviderFailure>,
    pub failure_stop_reason: Option<&'static str>,
    pub token_usage: ChatTokenUsage,
    pub tool_calls_json: String,
    pub tool_parse_errors: Vec<String>,
    /// Thinking-only token count accumulated during this stream.
    pub thinking_token_count: i64,
    /// Wall-clock duration between the first and last thinking delta.
    pub thinking_duration_ms: i64,
    pub total_duration_ms: i64,
}

pub(super) struct ResponsesAttemptState {
    content_chunks: Vec<String>,
    thinking_chunks: Vec<String>,
    tool_calls: Vec<Value>,
    reasoning_items: Vec<Value>,
    tool_parse_errors: Vec<String>,
    streaming_tool_items: HashMap<u64, (Value, String)>,
    response_id: String,
    response_model: String,
    response_status: String,
    token_usage: ChatTokenUsage,
    completed_response: Option<Value>,
    stream_completed_normally: bool,
    reasoning_stream_mode: HashMap<u64, crate::api::responses::event::ReasoningStreamMode>,
    failure_reason: Option<super::event::ResponsesFailure>,
    failure_stop_reason: Option<&'static str>,
    replay_unsafe: bool,
}

#[derive(Clone, Copy)]
pub(super) enum ProviderFailureRecovery {
    Retry,
    Finish {
        outcome: StreamRecoveryOutcome,
        reason: &'static str,
    },
}

/// Hosted/unknown tools and background requests cannot be safely replayed here.
pub(super) fn request_allows_failure_retry(payload: &Value) -> bool {
    payload.get("background").and_then(Value::as_bool) != Some(true)
        && payload.get("tools").is_none_or(|tools| {
            tools.is_null()
                || tools.as_array().is_some_and(|items| {
                    items
                        .iter()
                        .all(|tool| tool.get("type").and_then(Value::as_str) == Some("function"))
                })
        })
}

/// 已识别的失败先按归一化的策略关键词、再按原始（脱敏）原因匹配用户重试策略，
/// 任一命中即放行；自定义关键词因此仍可作用于上游原文。
fn retry_policy_allows(policy_reason: &str, original_reason: &str, options: &RetryOptions) -> bool {
    crate::api::retry::is_retriable_error(&Error::from_reason(policy_reason.to_string()), options)
        || crate::api::retry::is_retriable_error(
            &Error::from_reason(original_reason.to_string()),
            options,
        )
}

pub(super) fn failure_log_endpoint(endpoint: &str) -> String {
    let Ok(mut url) = url::Url::parse(endpoint) else {
        return "[redacted endpoint]".to_string();
    };
    let _ = url.set_username("");
    let _ = url.set_password(None);
    url.set_query(None);
    url.set_fragment(None);
    url.to_string()
}

impl Default for ResponsesAttemptState {
    fn default() -> Self {
        Self {
            content_chunks: Vec::new(),
            thinking_chunks: Vec::new(),
            tool_calls: Vec::new(),
            reasoning_items: Vec::new(),
            tool_parse_errors: Vec::new(),
            streaming_tool_items: HashMap::new(),
            response_id: String::new(),
            response_model: String::new(),
            response_status: String::from("completed"),
            token_usage: ChatTokenUsage::default(),
            completed_response: None,
            stream_completed_normally: false,
            reasoning_stream_mode: HashMap::new(),
            failure_reason: None,
            failure_stop_reason: None,
            replay_unsafe: false,
        }
    }
}

impl ResponsesAttemptState {
    pub(super) fn process_event_block(&mut self, event_block: &str) -> (String, String, String) {
        let mut tool_args_delta_out = String::new();
        let (content_delta, thinking_delta) = process_responses_sse_event_block(
            event_block,
            &mut self.content_chunks,
            &mut self.thinking_chunks,
            &mut self.tool_calls,
            &mut self.reasoning_items,
            &mut self.streaming_tool_items,
            &mut tool_args_delta_out,
            &mut self.response_id,
            &mut self.response_model,
            &mut self.response_status,
            &mut self.token_usage,
            &mut self.completed_response,
            &mut self.stream_completed_normally,
            &mut self.reasoning_stream_mode,
            &mut self.failure_reason,
            &mut self.replay_unsafe,
        );
        (content_delta, thinking_delta, tool_args_delta_out)
    }

    pub(super) fn progress(&self, user_cancelled: bool) -> StreamAttemptProgress {
        StreamAttemptProgress {
            visible_content_chars: visible_content_char_count(&self.content_chunks),
            has_tool_state: !self.tool_calls.is_empty(),
            has_pending_tool_fragments: !self.streaming_tool_items.is_empty(),
            provider_terminal: self.stream_completed_normally,
            user_cancelled,
        }
    }

    pub(super) fn has_payload(&self) -> bool {
        attempt_has_payload(
            &self.content_chunks,
            &self.thinking_chunks,
            !self.tool_calls.is_empty() || !self.reasoning_items.is_empty(),
        )
    }

    pub(super) fn failure_replay_safe(&self, request_replay_safe: bool) -> bool {
        request_replay_safe
            && !self.replay_unsafe
            && self
                .content_chunks
                .iter()
                .all(|text| text.trim().is_empty())
            // Terminal-only text has not reached content_chunks yet. Inspect
            // the same snapshot reader as finalization without clearing tools.
            && self
                .completed_response
                .as_ref()
                .is_none_or(|response| extract_output_text(response).is_empty())
            && self.tool_calls.is_empty()
            && self.streaming_tool_items.is_empty()
            && self.tool_parse_errors.is_empty()
    }

    /// Separate failure recovery from normal payload/terminal semantics.
    /// Call before finalization clears pending tool fragments.
    pub(super) fn failure_recovery(
        &self,
        attempt: u32,
        options: &RetryOptions,
        request_replay_safe: bool,
    ) -> Option<ProviderFailureRecovery> {
        if self.response_status != "failed" {
            return None;
        }
        let stop = |reason, outcome| Some(ProviderFailureRecovery::Finish { outcome, reason });
        if self
            .failure_reason
            .as_ref()
            .is_some_and(super::event::ResponsesFailure::retry_vetoed)
        {
            return stop("non_retriable_failure", StreamRecoveryOutcome::NonRetriable);
        }
        let Some(policy_reason) = self
            .failure_reason
            .as_ref()
            .and_then(super::event::ResponsesFailure::retry_policy_reason)
        else {
            return stop("non_retriable_failure", StreamRecoveryOutcome::NonRetriable);
        };
        if !self.failure_replay_safe(request_replay_safe) {
            return stop("unsafe_to_replay", StreamRecoveryOutcome::NonRetriable);
        }
        // Normalize known transport/throttle failures for existing policy keywords;
        // preserve the provider's redacted reason for diagnostics/custom keywords.
        if !retry_policy_allows(policy_reason, &self.failure_reason(), options) {
            return stop("retry_policy_disabled", StreamRecoveryOutcome::NonRetriable);
        }
        if attempt >= options.max_retries {
            return stop("retry_exhausted", StreamRecoveryOutcome::RetryExhausted);
        }
        Some(ProviderFailureRecovery::Retry)
    }

    /// 传输读错误（WebSocket 非正常 Close / 读取失败）重放前的门槛，与
    /// [`Self::failure_recovery`] 同口径：请求本身可重放、本次尝试尚无不可安全
    /// 重放的输出或工具活动，且用户重试策略放行。返回阻止重放的原因，`None`
    /// 表示可交由剩余预算决定是否重试。
    pub(super) fn transport_replay_block(
        &self,
        request_replay_safe: bool,
        transport_error: &str,
        options: &RetryOptions,
    ) -> Option<&'static str> {
        if !self.failure_replay_safe(request_replay_safe) {
            return Some("unsafe_to_replay");
        }
        if !retry_policy_allows(
            super::event::TRANSPORT_FAILURE_POLICY_REASON,
            transport_error,
            options,
        ) {
            return Some("retry_policy_disabled");
        }
        None
    }

    pub(super) fn failure_reason(&self) -> String {
        self.failure_reason
            .as_ref()
            .map(super::event::ResponsesFailure::reason)
            .unwrap_or_else(|| RESPONSES_FAILED_NO_REASON.to_string())
    }

    pub(super) fn failure_is_transport(&self) -> bool {
        self.failure_reason
            .as_ref()
            .is_some_and(super::event::ResponsesFailure::is_transport)
    }

    pub(super) fn failure_is_connection_expired(&self) -> bool {
        self.failure_reason
            .as_ref()
            .is_some_and(super::event::ResponsesFailure::is_connection_expired)
    }

    pub(super) fn finish_failure(
        &mut self,
        outcome: StreamRecoveryOutcome,
        reason: &'static str,
    ) -> (
        Option<StreamInterruptionReason>,
        Option<StreamRecoveryOutcome>,
    ) {
        self.finalize_provider_terminal();
        self.failure_stop_reason = Some(reason);
        (None, Some(outcome))
    }

    /// 取消收尾：标记 cancelled 并丢弃未完成的工具状态。
    pub(super) fn finish_cancelled(&mut self) {
        self.response_status = String::from("cancelled");
        self.tool_calls.clear();
        self.streaming_tool_items.clear();
        self.tool_parse_errors.clear();
        self.failure_reason = None;
        self.failure_stop_reason = None;
    }

    pub(super) fn finalize_provider_terminal(
        &mut self,
    ) -> (
        Option<StreamInterruptionReason>,
        Option<StreamRecoveryOutcome>,
    ) {
        self.streaming_tool_items.clear();

        if let Some(response) = self.completed_response.as_ref() {
            if self.content_chunks.is_empty() {
                let content = extract_output_text(response);
                if !content.is_empty() {
                    self.content_chunks.push(content);
                }
            }

            if self.thinking_chunks.is_empty() {
                let thinking = extract_response_thinking(response);
                if !thinking.is_empty() {
                    self.thinking_chunks.push(thinking);
                }
            }

            // Only a trusted `response.completed` payload may act as a
            // fallback source of executable tool calls. Incomplete or failed
            // payloads never promote their output tree.
            if self.response_status == "completed" && self.tool_calls.is_empty() {
                collect_tool_calls(response.get("output"), &mut self.tool_calls);
            }

            if self.reasoning_items.is_empty() {
                collect_reasoning_items(response.get("output"), &mut self.reasoning_items);
            }
        }

        if self.response_status == "incomplete" {
            self.tool_parse_errors.clear();
            self.failure_reason = None;
            (Some(StreamInterruptionReason::ExplicitIncomplete), None)
        } else if self.response_status == "failed" {
            // Failed response fragments must never become executable tools.
            self.tool_calls.clear();
            self.streaming_tool_items.clear();
            self.tool_parse_errors.clear();
            (None, None)
        } else {
            // 成功终态：清空，避免重试成功后被上一轮的失败原因污染。
            self.failure_reason = None;
            (None, None)
        }
    }

    /// 是否已收到 Provider 终态事件（`response.completed` / `incomplete` /
    /// `failed` / `error`）。WebSocket 传输据此判断某一帧之后可以停止读取。
    pub(super) fn stream_completed_normally(&self) -> bool {
        self.stream_completed_normally
    }
}

pub(super) fn finalize_transport_interruption(
    state: &mut ResponsesAttemptState,
    decision: StreamRecoveryDecision,
    cause: StreamEndCause,
) -> (
    Option<StreamInterruptionReason>,
    Option<StreamRecoveryOutcome>,
) {
    state.response_status = String::from("incomplete");
    state.streaming_tool_items.clear();
    if matches!(decision, StreamRecoveryDecision::SurfaceInterrupted) {
        // Display text/reasoning may survive a final interruption, but neither
        // finalized nor pending tool state is trusted.
        state.tool_calls.clear();
        state.tool_parse_errors.clear();
    }

    (
        Some(cause.interruption_reason()),
        decision.recovery_outcome(),
    )
}

/// 连接阶段、或已丢弃失败尝试后的取消结果。SSE 与 WebSocket 传输共用，
/// 不回传旧尝试的输出、usage 或失败元数据，保留整个请求的耗时/思考统计。
pub(super) fn cancelled_stream_result(
    thinking_tracker: &ThinkingStreamTracker,
    stream_start: std::time::Instant,
) -> StreamingResponseResult {
    StreamingResponseResult {
        id: String::new(),
        content: String::new(),
        thinking: String::new(),
        reasoning_items_json: "[]".to_string(),
        model: String::new(),
        status: String::from("cancelled"),
        interruption_reason: None,
        recovery_outcome: None,
        failure_reason: None,
        failure: None,
        failure_stop_reason: None,
        token_usage: ChatTokenUsage {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
        },
        tool_calls_json: "[]".to_string(),
        tool_parse_errors: Vec::new(),
        thinking_token_count: thinking_tracker.token_count as i64,
        thinking_duration_ms: thinking_tracker.duration_ms(),
        total_duration_ms: stream_start.elapsed().as_millis() as i64,
    }
}

/// 收尾一次流式尝试：补全 reasoning round-trip、拼接正文，并附上中断元数据。
/// SSE 与 WebSocket 传输共用，保证持久化字段完全一致。
pub(super) fn finalize_attempt_result(
    attempt_state: &mut ResponsesAttemptState,
    interruption_reason: Option<StreamInterruptionReason>,
    recovery_outcome: Option<StreamRecoveryOutcome>,
    thinking_tracker: &ThinkingStreamTracker,
    stream_start: std::time::Instant,
) -> StreamingResponseResult {
    // If no structured reasoning item arrived, preserve streamed reasoning text
    // in the existing minimal round-trip shape.
    if attempt_state.reasoning_items.is_empty() {
        let thinking = attempt_state.thinking_chunks.join("").trim().to_string();
        if !thinking.is_empty() {
            attempt_state.reasoning_items.push(json!({
                "type": "reasoning",
                "reasoning_text": thinking,
            }));
        }
    }

    if matches!(attempt_state.response_status.as_str(), "failed" | "cancelled") {
        attempt_state.tool_calls.clear();
        attempt_state.streaming_tool_items.clear();
        attempt_state.tool_parse_errors.clear();
    }
    if attempt_state.response_status != "failed" { attempt_state.failure_reason = None; }
    let content = attempt_state.content_chunks.join("").trim().to_string();
    let thinking = attempt_state.thinking_chunks.join("").trim().to_string();
    let tool_calls_json =
        serde_json::to_string(&attempt_state.tool_calls).unwrap_or_else(|_| "[]".to_string());
    let reasoning_items_json =
        serde_json::to_string(&attempt_state.reasoning_items).unwrap_or_else(|_| "[]".to_string());

    StreamingResponseResult {
        id: attempt_state.response_id.clone(),
        content,
        thinking,
        reasoning_items_json,
        model: attempt_state.response_model.clone(),
        status: attempt_state.response_status.clone(),
        interruption_reason,
        recovery_outcome,
        failure_reason: attempt_state.failure_reason.as_ref().and_then(|failure| failure.detail.reason()),
        failure: attempt_state.failure_reason.as_ref().map(|failure| failure.detail.clone()),
        failure_stop_reason: attempt_state.failure_stop_reason,
        token_usage: attempt_state.token_usage,
        tool_calls_json,
        tool_parse_errors: attempt_state.tool_parse_errors.clone(),
        thinking_token_count: thinking_tracker.token_count as i64,
        thinking_duration_ms: thinking_tracker.duration_ms(),
        total_duration_ms: stream_start.elapsed().as_millis() as i64,
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn collect_streaming_response(
    client: &reqwest::Client,
    database_path: PathBuf,
    endpoint: &str,
    api_key: &str,
    custom_headers: &HashMap<String, String>,
    payload: Value,
    tool_guard: &crate::api::plugin_tool_guard::PluginToolGuard,
    on_chunk: StreamSink<'_>,
    cancel_token: &CancellationToken,
    retry_options: &RetryOptions,
    stream_idle_timeout_sec: u64,
) -> Result<StreamingResponseResult> {
    let payload = request_proxy::transform_request("responses", payload).await;
    tool_guard.validate(&payload)?;
    let mut attempt: u32 = 0;
    let mut stream_token_count: usize = 0;
    let mut thinking_tracker = ThinkingStreamTracker::default();
    let stream_start = std::time::Instant::now();
    let mut ttft_ms: i64 = 0;

    let timeouts = StreamTimeouts::for_payload(stream_idle_timeout_sec, &payload);
    let failure_retry_safe = request_allows_failure_retry(&payload);
    let retry_endpoint = failure_log_endpoint(endpoint);

    macro_rules! retry_empty_attempt {
        () => {{
            retry_empty_attempt!("empty_response", EMPTY_RESPONSE_RETRY_ERROR);
        }};
        ($cause:expr, $error:expr) => {{
            let retry_error = ($error).to_string();
            on_chunk.call(
                ResponsesApiStreamChunk {
                    content_delta: String::new(),
                    thinking_delta: String::new(),
                    content: String::new(),
                    thinking: String::new(),
                    retrying: true,
                    retry_attempt: Some((attempt + 1) as i32),
                    retry_error: Some(retry_error.clone()),
                    stream_token_count: stream_token_count as i64,
                    thinking_token_count: thinking_tracker.token_count as i64,
                    thinking_duration_ms: thinking_tracker.duration_ms(),
                    elapsed_ms: stream_start.elapsed().as_millis() as i64,
                    ttft_ms,
                    vision_status: None,
                    retry_backoff_ms: Some(retry_backoff_ms(retry_options, attempt)),
                },
                ThreadsafeFunctionCallMode::NonBlocking,
            );

            log_retry_attempt(
                &database_path,
                "create_response_stream_with_context",
                "openai",
                "responses",
                $cause,
                attempt,
                &retry_endpoint,
                &retry_error,
                retry_backoff_ms(retry_options, attempt),
            )
            .await;

            match wait_before_retry(retry_options, cancel_token, attempt).await {
                Ok(()) => {}
                Err(_) if cancel_token.is_cancelled() => {
                    return Ok(cancelled_stream_result(&thinking_tracker, stream_start));
                }
                Err(error) => return Err(error),
            }
            if cancel_token.is_cancelled() {
                return Ok(cancelled_stream_result(&thinking_tracker, stream_start));
            }
            attempt += 1;
        }};
    }

    let (mut attempt_state, interruption_reason, recovery_outcome) = 'attempt_loop: loop {
        // Every HTTP response gets fresh Provider-local state. Retrying drops
        // the entire prior attempt, including pending tool fragments and parser
        // flags, before the original request is issued again.
        // ---- Phase 1: send the request (with retry on connect errors) ----
        let header_map = super::payload::build_header_map(api_key, custom_headers)?;
        let upstream = loop {
            if cancel_token.is_cancelled() {
                return Ok(cancelled_stream_result(&thinking_tracker, stream_start));
            }

            // 声明 fetch 钩子的插件在此接管传输层，后续仍走同一套解析与记账。
            if let Some(body) = plugin_response::takeover(cancel_token).await? {
                break plugin_response::UpstreamBody::Synthetic(body);
            }

            let send_future = client
                .post(endpoint)
                .headers(header_map.clone())
                .json(&payload)
                .send();

            let result = tokio::select! {
                biased;
                _ = cancel_token.cancelled() => {
                    return Ok(cancelled_stream_result(&thinking_tracker, stream_start));
                }
                result = send_future => {
                    result.map_err(|error| Error::from_reason(format!("Failed to create response stream: {error}")))
                }
                // 半开连接下响应头可能永远不到：以首字节窗口（按请求体体积放宽、
                // 随空闲超时次数递增）兜底，超时后按重试策略重试并留痕。
                _ = tokio::time::sleep(timeouts.first_byte()) => {
                    Err(timeouts.send_timeout_error())
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
                            return Err(Error::from_reason(crate::api::failure::bounded_provider_detail(&error.reason, 768, Some(api_key))));
                        }
                        let error = Error::from_reason(crate::api::failure::bounded_provider_detail(&error.reason, 768, Some(api_key)));

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
                                thinking_token_count: thinking_tracker.token_count as i64,
                                thinking_duration_ms: thinking_tracker.duration_ms(),
                                elapsed_ms: stream_start.elapsed().as_millis() as i64,
                                ttft_ms,
                                vision_status: None,
                                retry_backoff_ms: Some(retry_backoff_ms(retry_options, attempt)),
                            },
                            ThreadsafeFunctionCallMode::NonBlocking,
                        );

                        // 记录重试到本地日志：即使后续重试成功也留痕，便于
                        // 事后对账「上游抖动过几次、最后一次错误是什么」。
                        log_retry_attempt(
                            &database_path,
                            "create_response_stream_with_context",
                            "openai",
                            "responses",
                            "http_status",
                            attempt,
                            "[redacted endpoint]",
                            &error.reason,
                            retry_backoff_ms(retry_options, attempt),
                        )
                        .await;

                        match wait_before_retry(retry_options, cancel_token, attempt).await {
                            Ok(()) => {
                                attempt += 1;
                                continue;
                            }
                            Err(e) => return Err(e),
                        }
                    }
                    break plugin_response::UpstreamBody::Http(response);
                }
                Err(error) => {
                    if !should_retry(&error, attempt, retry_options) {
                        return Err(Error::from_reason(crate::api::failure::bounded_provider_detail(&error.reason, 768, Some(api_key))));
                    }
                    let error = Error::from_reason(crate::api::failure::bounded_provider_detail(&error.reason, 768, Some(api_key)));

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
                            thinking_token_count: thinking_tracker.token_count as i64,
                            thinking_duration_ms: thinking_tracker.duration_ms(),
                            elapsed_ms: stream_start.elapsed().as_millis() as i64,
                            ttft_ms,
                            vision_status: None,
                            retry_backoff_ms: Some(retry_backoff_ms(retry_options, attempt)),
                        },
                        ThreadsafeFunctionCallMode::NonBlocking,
                    );

                    // 连接层失败（DNS / TCP / TLS / 超时）同样必须留痕。
                    log_retry_attempt(
                        &database_path,
                        "create_response_stream_with_context",
                        "openai",
                        "responses",
                        send_failure_cause(&error),
                        attempt,
                        "[redacted endpoint]",
                        &error.reason,
                        retry_backoff_ms(retry_options, attempt),
                    )
                    .await;

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
        let mut attempt_state = ResponsesAttemptState::default();
        let mut byte_buffer = Vec::new();
        let mut stream =
            plugin_response::wrap_stream("responses", upstream, cancel_token.clone());

        let stream_end = read_sse_stream_until_terminal(
            &mut stream,
            &mut byte_buffer,
            cancel_token,
            timeouts.first_byte(),
            timeouts.idle(),
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
                    &mut thinking_tracker,
                    stream_start.elapsed().as_millis() as i64,
                    ttft_ms,
                );
                emit_tool_args_probe(
                    on_chunk,
                    &mut stream_token_count,
                    &thinking_tracker,
                    &tool_args_delta,
                    stream_start.elapsed().as_millis() as i64,
                    ttft_ms,
                );
                attempt_state.stream_completed_normally
            },
        )
        .await;

        if let SseStreamEnd::Cancelled = &stream_end {
            attempt_state.response_status = String::from("cancelled");
        }

        // Cancellation is checked first after the reader returns. It must beat
        // a simultaneously observed Provider terminal and must not leave any
        // interruption metadata or executable tool state behind.
        if attempt_state.response_status == "cancelled" || cancel_token.is_cancelled() {
            attempt_state.finish_cancelled();
            break 'attempt_loop (attempt_state, None, None);
        }

        // A failed event closes this stream, but an identified transport failure
        // may replay a safe attempt. Decide before terminal cleanup drops tools.
        if let Some(recovery) =
            attempt_state.failure_recovery(attempt, retry_options, failure_retry_safe)
        {
            match recovery {
                ProviderFailureRecovery::Retry => {
                    retry_empty_attempt!("provider_error", attempt_state.failure_reason());
                    continue 'attempt_loop;
                }
                ProviderFailureRecovery::Finish { outcome, reason } => {
                    let (failure_reason, failure_outcome) =
                        attempt_state.finish_failure(outcome, reason);
                    break 'attempt_loop (attempt_state, failure_reason, failure_outcome);
                }
            }
        }

        // Normal provider terminals retain their existing completion semantics.
        if let SseStreamEnd::ProviderTerminal = &stream_end {
            let (terminal_interruption_reason, terminal_recovery_outcome) =
                attempt_state.finalize_provider_terminal();
            if attempt_state.response_status == "completed"
                && terminal_interruption_reason.is_none()
                && should_retry_empty_response(attempt, retry_options, attempt_state.has_payload())
            {
                retry_empty_attempt!();
                continue 'attempt_loop;
            }
            break 'attempt_loop (
                attempt_state,
                terminal_interruption_reason,
                terminal_recovery_outcome,
            );
        }

        let (cause, retry_error) = match stream_end {
            SseStreamEnd::ReadError(error) => (StreamEndCause::ReadError, error.to_string()),
            SseStreamEnd::UnexpectedEof => (
                StreamEndCause::UnexpectedEof,
                "Stream ended before a Responses terminal event".to_string(),
            ),
            SseStreamEnd::IdleTimeout => {
                (StreamEndCause::IdleTimeout, timeouts.read_timeout_reason())
            }
            SseStreamEnd::ProviderTerminal | SseStreamEnd::Cancelled => {
                unreachable!("terminal and cancellation are handled before transport recovery")
            }
        };
        let progress = attempt_state.progress(cancel_token.is_cancelled());
        let decision = decide_stream_recovery(cause, attempt, retry_options, progress);
        let retry_error = crate::api::failure::bounded_provider_detail(&retry_error, 768, Some(api_key));

        match decision {
            StreamRecoveryDecision::Cancelled => {
                attempt_state.finish_cancelled();
                break 'attempt_loop (attempt_state, None, None);
            }
            StreamRecoveryDecision::FinishProviderResult => {
                let (provider_reason, provider_outcome) =
                    attempt_state.finalize_provider_terminal();
                if attempt_state.response_status == "completed"
                    && provider_reason.is_none()
                    && should_retry_empty_response(
                        attempt,
                        retry_options,
                        attempt_state.has_payload(),
                    )
                {
                    retry_empty_attempt!();
                    continue 'attempt_loop;
                }
                break 'attempt_loop (attempt_state, provider_reason, provider_outcome);
            }
            StreamRecoveryDecision::Retry => {
                // 流中断恢复重试留痕：重试成功时中断原因不会写
                // interruption_reason，此前完全无痕。
                log_retry_attempt(
                    &database_path,
                    "create_response_stream_with_context",
                    "openai",
                    "responses",
                    cause.interruption_reason().as_code(),
                    attempt,
                    "[redacted endpoint]",
                    &retry_error,
                    retry_backoff_ms(retry_options, attempt),
                )
                .await;

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
                        thinking_token_count: thinking_tracker.token_count as i64,
                        thinking_duration_ms: thinking_tracker.duration_ms(),
                        elapsed_ms: stream_start.elapsed().as_millis() as i64,
                        ttft_ms,
                        vision_status: None,
                        retry_backoff_ms: Some(retry_backoff_ms(retry_options, attempt)),
                    },
                    ThreadsafeFunctionCallMode::NonBlocking,
                );

                match wait_before_retry(retry_options, cancel_token, attempt).await {
                    Ok(()) => {
                        attempt += 1;
                        continue 'attempt_loop;
                    }
                    Err(_wait_error) if cancel_token.is_cancelled() => {
                        attempt_state.finish_cancelled();
                        break 'attempt_loop (attempt_state, None, None);
                    }
                    Err(wait_error) => return Err(wait_error),
                }
            }
            StreamRecoveryDecision::KeepUsablePartial
            | StreamRecoveryDecision::SurfaceInterrupted => {
                let (transport_reason, transport_outcome) =
                    finalize_transport_interruption(&mut attempt_state, decision, cause);
                break 'attempt_loop (attempt_state, transport_reason, transport_outcome);
            }
        }
    };

    Ok(finalize_attempt_result(
        &mut attempt_state,
        interruption_reason,
        recovery_outcome,
        &thinking_tracker,
        stream_start,
    ))
}
