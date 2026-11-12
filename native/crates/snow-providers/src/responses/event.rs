//! Responses API stream-event helpers — SSE block parsing, token usage
//! extraction, reasoning text collection, tool-call collection, and output
//! text extraction.

use std::collections::HashMap;

use serde_json::Value;

use crate::api::common::read_first_i64;
use crate::api::failure::ProviderFailure;
use crate::storage::services::chat_conversations::ChatTokenUsage;

/// Small, bounded error metadata; never retain the full error object in diagnostics.
#[derive(Debug, Clone)]
pub(super) struct ResponsesFailure {
    pub(super) detail: ProviderFailure,
    transport_failure: bool,
    /// 服务端声明当前 WebSocket 连接已到期（60 分钟寿命上限），需换新连接继续。
    connection_expired: bool,
    /// 网关限流/并发/过载类失败对应的重试策略关键词（"rate limit" / "overloaded"）。
    throttle_reason: Option<&'static str>,
    retry_veto: bool,
}

/// 已识别传输层失败归一化后的重试策略关键词（命中 network / stream error 类别）。
pub(super) const TRANSPORT_FAILURE_POLICY_REASON: &str = "network stream error";

/// 服务端 WebSocket 连接寿命到期的错误码。
const CONNECTION_EXPIRED_CODE: &str = "websocket_connection_limit_reached";
/// 连接到期错误允许携带的错误类型（官方信封为 `invalid_request_error`）。
const CONNECTION_EXPIRED_TYPES: &[&str] = &["invalid_request_error"];

/// 识别限流、并发上限、过载类错误标识。
fn throttle_identifier(text: &str) -> Option<&'static str> {
    let lower = text.trim().to_ascii_lowercase();
    if lower.contains("overload") {
        Some("overloaded")
    } else if lower.contains("concurrency_limit")
        || lower.contains("rate_limit")
        || lower == "too_many_requests"
    {
        Some("rate limit")
    } else {
        None
    }
}

impl ResponsesFailure {
    pub(super) fn from_event(event: &Value) -> Self {
        let response = event.get("response").unwrap_or(event);
        // Inspect both error branches and every nested error before selecting
        // bounded diagnostics. An inner transport code cannot hide an outer
        // business rejection. Wrapper `type` describes the protocol event only.
        let mut details = Vec::new();
        for root in [response.get("error"), event.get("error")]
            .into_iter()
            .flatten()
        {
            let mut current = Some(root);
            while let Some(detail) = current.filter(|value| !value.is_null()) {
                details.push((detail, true));
                current = detail.get("error");
            }
        }
        details.extend([(response, false), (event, false)]);

        const ALLOWED_CODES: &[&str] = &[
            "",
            "upstream_error",
            "server_error",
            "internal_error",
            "upstream_http2_stream_error",
            "websocket_connection_limit_reached",
        ];
        const ALLOWED_TYPES: &[&str] = &[
            "",
            "error",
            "upstream_error",
            "server_error",
            "internal_error",
            "http2_error",
            "upstream_http2_stream_error",
        ];
        let allowed_identifier = |value: Option<&Value>, allowed: &[&str]| {
            value.is_none_or(|value| {
                value.is_null()
                    || value.as_str().is_some_and(|text| {
                        allowed.contains(&text.trim().to_ascii_lowercase().as_str())
                    })
            })
        };
        let identifier_is = |detail: &Value, expected: &str| {
            detail
                .get("code")
                .and_then(Value::as_str)
                .is_some_and(|code| code.trim().eq_ignore_ascii_case(expected))
        };
        // 连接到期的官方信封是 invalid_request_error：只在同一层错误对象自身的
        // code 就是到期码时放行这一 type，其余 invalid_request_error（参数、鉴权、
        // 审核等业务拒绝）仍会否决重试。
        let type_safe = |detail: &Value, error_object: bool| {
            !error_object
                || allowed_identifier(detail.get("type"), ALLOWED_TYPES)
                || (identifier_is(detail, CONNECTION_EXPIRED_CODE)
                    && allowed_identifier(detail.get("type"), CONNECTION_EXPIRED_TYPES))
        };
        let identifiers_safe = details.iter().all(|(detail, error_object)| {
            allowed_identifier(detail.get("code"), ALLOWED_CODES)
                && type_safe(detail, *error_object)
        });
        let connection_expired = identifiers_safe
            && details
                .iter()
                .any(|(detail, _)| identifier_is(detail, CONNECTION_EXPIRED_CODE));
        let transport_failure = connection_expired
            || (identifiers_safe
                && details.iter().any(|(detail, _)| {
                    identifier_is(detail, "upstream_http2_stream_error")
                        || detail
                            .as_str()
                            .or_else(|| detail.get("message").and_then(Value::as_str))
                            .is_some_and(|message| {
                                message
                                    .trim()
                                    .trim_end_matches('.')
                                    .eq_ignore_ascii_case("Upstream HTTP/2 stream failed")
                            })
                }));
        // 限流类：所有标识须为白名单或限流标识，避免掩盖其他业务拒绝。
        let throttle_or_allowed = |value: Option<&Value>, allowed: &[&str]| {
            allowed_identifier(value, allowed)
                || value
                    .and_then(Value::as_str)
                    .is_some_and(|text| throttle_identifier(text).is_some())
        };
        let throttle_safe = details.iter().all(|(detail, error_object)| {
            throttle_or_allowed(detail.get("code"), ALLOWED_CODES)
                && (!error_object || throttle_or_allowed(detail.get("type"), ALLOWED_TYPES))
        });
        let throttle_reason = if throttle_safe && !transport_failure {
            details.iter().find_map(|(detail, error_object)| {
                [
                    detail.get("code").and_then(Value::as_str),
                    if *error_object {
                        detail.get("type").and_then(Value::as_str)
                    } else {
                        None
                    },
                ]
                .into_iter()
                .flatten()
                .find_map(throttle_identifier)
            })
        } else {
            None
        };
        // Preserve the global policy's strong cancellation veto from raw
        // metadata: truncation/redaction must not erase it before normalization.
        let retry_veto = details.iter().any(|(detail, error_object)| {
            [
                detail.as_str(),
                detail.get("message").and_then(Value::as_str),
                detail.get("code").and_then(Value::as_str),
                if *error_object {
                    detail.get("type").and_then(Value::as_str)
                } else {
                    None
                },
            ]
            .into_iter()
            .flatten()
            .any(|text| {
                let lower = text.to_ascii_lowercase();
                lower.contains("aborted") || lower.contains("cancel")
            })
        });
        Self {
            detail: ProviderFailure::from_event(event, None),
            transport_failure,
            connection_expired,
            throttle_reason,
            retry_veto,
        }
    }

    pub(super) fn reason(&self) -> String {
        // Empty is a policy input only; UI fallback belongs to its dictionary.
        self.detail.reason().unwrap_or_default()
    }

    pub(super) fn retry_vetoed(&self) -> bool {
        self.retry_veto
    }

    /// Classify raw error layers, never the independently selected diagnostics.
    /// Recovery must also check `retry_vetoed` before positive policy matching.
    pub(super) fn retry_policy_reason(&self) -> Option<&'static str> {
        if self.transport_failure {
            Some(TRANSPORT_FAILURE_POLICY_REASON)
        } else {
            self.throttle_reason
        }
    }

    /// 仅传输层故障意味着连接不可复用；限流类连接仍健康。
    pub(super) fn is_transport(&self) -> bool {
        self.transport_failure
    }

    /// 服务端声明连接寿命到期：重试时必须换一条新连接。
    pub(super) fn is_connection_expired(&self) -> bool {
        self.connection_expired
    }
}

/// Which representation of a reasoning item's text has been seen for one
/// `output_index`. The full-text stream and the summary stream are two
/// representations of the SAME text, so at most one may be counted; tracking
/// the mode per index (instead of one global flag) keeps multiple reasoning
/// items in a single response independent.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum ReasoningStreamMode {
    FullText,
    Summary,
}
// ---------------------------------------------------------------------------
// SSE block parsing
// ---------------------------------------------------------------------------

/// Process a raw SSE event block (text between two separators) for the
/// Responses API streaming protocol.
///
/// Each `data:` line is parsed independently as a JSON object, then dispatched
/// to the appropriate handler based on the `type` field. The caller passes
/// mutable references to all accumulation buffers so this function can update
/// them in place.
///
/// Returns a tuple of `(content_delta, thinking_delta)` — the text fragments
/// added during this block — so the caller can emit a streaming chunk to the
/// frontend without re-scanning the buffers.
#[allow(clippy::too_many_arguments)]
pub(super) fn process_responses_sse_event_block(
    event_block: &str,
    content_chunks: &mut Vec<String>,
    thinking_chunks: &mut Vec<String>,
    tool_calls: &mut Vec<Value>,
    reasoning_items: &mut Vec<Value>,
    streaming_tool_items: &mut HashMap<u64, (Value, String)>,
    tool_args_delta_out: &mut String,
    response_id: &mut String,
    response_model: &mut String,
    response_status: &mut String,
    token_usage: &mut ChatTokenUsage,
    completed_response: &mut Option<Value>,
    stream_completed_normally: &mut bool,
    reasoning_stream_mode: &mut HashMap<u64, ReasoningStreamMode>,
    failure_reason: &mut Option<ResponsesFailure>,
    replay_unsafe: &mut bool,
) -> (String, String) {
    let mut content_delta_out = String::new();
    let mut thinking_delta_out = String::new();

    for line in event_block.lines() {
        let trimmed = line.trim_start();
        let Some(data) = trimmed.strip_prefix("data:") else {
            continue;
        };
        let data = data.trim_start();

        if data.is_empty() {
            continue;
        }

        let Ok(event) = serde_json::from_str::<Value>(data) else {
            // Malformed JSON — skip this line and continue processing the
            // rest of the stream.
            continue;
        };

        let event_type = event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();

        // WS frames reach this parser only after stale-response filtering.
        // Protocol event IDs are not response IDs; retain the known ID when absent.
        let event_response_id = event
            .get("response")
            .and_then(|response| response.get("id"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .or_else(|| {
                event.get("response_id")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|id| !id.is_empty())
            });
        if let Some(id) = event_response_id {
            *response_id = id.to_string();
        }

        // Latch output/tool activity before terminal cleanup can erase it.
        // Reasoning alone is safe to discard for an identified transport failure.
        if event_type.starts_with("response.function_call")
            || event_type.starts_with("response.custom_tool_call")
            || matches!(
                event_type,
                "response.output_text.delta" | "response.output_text.done"
            ) && event
                .get("delta")
                .or_else(|| event.get("text"))
                .and_then(Value::as_str)
                .is_some_and(|text| !text.is_empty())
            || matches!(
                event_type,
                "response.output_item.added" | "response.output_item.done"
            ) && event
                .get("item")
                .and_then(|item| item.get("type"))
                .and_then(Value::as_str)
                != Some("reasoning")
            || event
                .get("response")
                .and_then(|response| response.get("output"))
                .is_some_and(|output| {
                    !output.is_null()
                        && !output.as_array().is_some_and(|items| {
                            items.iter().all(|item| {
                                item.get("type").and_then(Value::as_str) == Some("reasoning")
                            })
                        })
                })
        {
            *replay_unsafe = true;
        }

        match event_type {
            "response.output_text.delta" => {
                let content_delta = read_stream_text_delta(event.get("delta"));
                if !content_delta.is_empty() {
                    content_chunks.push(content_delta.clone());
                    content_delta_out.push_str(&content_delta);
                }
            }
            // Full reasoning text delta. This is the primary thinking stream
            // for reasoning models: it arrives BEFORE any
            // `response.output_text.delta` (reasoning happens first), so it
            // must be pushed to the frontend in real time — otherwise the
            // thinking block only appears after the entire response has
            // finished rendering.
            "response.reasoning_text.delta" => {
                let index = event
                    .get("output_index")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                // The summary is a re-statement of the full text. If a summary
                // was already counted for this index, counting the full text
                // too would duplicate the thinking block regardless of the
                // order in which the two arrive.
                if reasoning_stream_mode.insert(index, ReasoningStreamMode::FullText)
                    != Some(ReasoningStreamMode::Summary)
                {
                    let thinking_delta = read_stream_text_delta(event.get("delta"));
                    if !thinking_delta.is_empty() {
                        thinking_chunks.push(thinking_delta.clone());
                        thinking_delta_out.push_str(&thinking_delta);
                    }
                }
            }
            "response.reasoning_summary_text.delta" | "response.reasoning_summary.delta" => {
                let index = event
                    .get("output_index")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                // Mutual exclusion with the full-text stream (and, for the two
                // summary event names, with each other): only the first
                // representation wins for a given output index.
                if reasoning_stream_mode.insert(index, ReasoningStreamMode::Summary)
                    != Some(ReasoningStreamMode::FullText)
                {
                    let thinking_delta = match event_type {
                        "response.reasoning_summary_text.delta" => {
                            read_stream_text_delta(event.get("delta"))
                        }
                        _ => {
                            let mut delta_chunks = Vec::new();
                            if let Some(delta) = event.get("delta") {
                                collect_text_values(delta, &mut delta_chunks);
                            }
                            delta_chunks.join("")
                        }
                    };
                    if !thinking_delta.is_empty() {
                        thinking_chunks.push(thinking_delta.clone());
                        thinking_delta_out.push_str(&thinking_delta);
                    }
                }
            }
            // Tool-call argument deltas. The Responses API streams function
            // arguments as they are generated.
            //
            // Accumulate argument fragments per output item index as pending
            // state. The collector uses this map only to block usable partial;
            // it is never promoted unless `output_item.done` finalizes it.
            "response.function_call_arguments.delta" => {
                let args_delta = read_stream_text_delta(event.get("delta"));
                if !args_delta.is_empty() {
                    // 累积工具参数增量用于实时 token 计数（仅计数，不进入
                    // 消息正文；与 chat/anthropic/gemini provider 的
                    // tool_args_delta 行为一致）。
                    tool_args_delta_out.push_str(&args_delta);
                    if let Some(index) = event
                        .get("output_index")
                        .and_then(Value::as_u64)
                        .or_else(|| event.get("index").and_then(Value::as_u64))
                    {
                        streaming_tool_items
                            .entry(index)
                            .and_modify(|(_, args)| args.push_str(&args_delta))
                            .or_insert_with(|| (Value::Null, args_delta));
                    }
                }
            }
            // Track newly added function_call output items in the pending map.
            // Only `response.output_item.done` moves a tool into `tool_calls`.
            "response.output_item.added" => {
                if let Some(item) = event.get("item") {
                    let item_type = item.get("type").and_then(Value::as_str).unwrap_or_default();

                    // Capture reasoning items (with encrypted_content) as
                    // early as possible.
                    if item_type == "reasoning" {
                        reasoning_items.push(item.clone());
                    }

                    if matches!(
                        item_type,
                        "function_call" | "tool_call" | "custom_tool_call" | "mcp_call"
                    ) {
                        if let Some(index) = event
                            .get("output_index")
                            .and_then(Value::as_u64)
                            .or_else(|| event.get("index").and_then(Value::as_u64))
                        {
                            streaming_tool_items
                                .entry(index)
                                .and_modify(|(stored, _)| *stored = item.clone())
                                .or_insert_with(|| (item.clone(), String::new()));
                        }
                    }
                }
            }
            "response.output_item.done" => {
                // Capture reasoning items (with encrypted_content) for
                // round-tripping when store:false.
                if let Some(item) = event.get("item") {
                    let item_type = item.get("type").and_then(Value::as_str).unwrap_or_default();
                    if item_type == "reasoning" {
                        // Replace any prior entry from `added` with the
                        // finalised `done` version, or push if not already
                        // tracked.
                        if let Some(pos) = reasoning_items.iter().position(|existing| {
                            existing.get("id").and_then(Value::as_str)
                                == item.get("id").and_then(Value::as_str)
                        }) {
                            reasoning_items[pos] = item.clone();
                        } else {
                            reasoning_items.push(item.clone());
                        }
                    }
                }
                collect_tool_calls(event.get("item"), tool_calls);
                // Remove from the streaming map once finalized.
                if let Some(index) = event
                    .get("output_index")
                    .and_then(Value::as_u64)
                    .or_else(|| event.get("index").and_then(Value::as_u64))
                {
                    streaming_tool_items.remove(&index);
                }
            }
            "response.completed" | "response.incomplete" | "response.failed" => {
                *stream_completed_normally = true;
                *response_status = match event_type {
                    "response.incomplete" => "incomplete",
                    "response.failed" => "failed",
                    _ => "completed",
                }
                .to_string();
                if let Some(response) = event.get("response") {
                    *response_model = read_response_string(response, "model")
                        .unwrap_or_else(|| response_model.clone());
                    if let Some(status) =
                        read_response_string(response, "status").filter(|status| {
                            matches!(status.as_str(), "completed" | "incomplete" | "failed")
                        })
                    {
                        // The explicit failure event wins over an inconsistent snapshot.
                        if event_type != "response.failed" { *response_status = status; }
                    }
                    // Classify the complete envelope so response.error and a
                    // sibling event.error can both veto unsafe transport replay.
                    if *response_status == "failed" {
                        *failure_reason = extract_response_failure_reason(&event)
                            .or_else(|| Some(ResponsesFailure::from_event(&event)));
                    }
                    *token_usage = extract_token_usage(response);
                    if *response_status == "failed" {
                        // Keep only actual display output, never an error envelope.
                        if content_chunks.is_empty() {
                            let content = extract_output_text(response);
                            if !content.is_empty() { content_chunks.push(content); }
                        }
                        if thinking_chunks.is_empty() {
                            let thinking = extract_response_thinking(response);
                            if !thinking.is_empty() { thinking_chunks.push(thinking); }
                        }
                        *completed_response = None;
                    } else {
                        let mut snapshot = response.clone();
                        if let Some(object) = snapshot.as_object_mut() { object.remove("error"); }
                        *completed_response = Some(snapshot);
                    }
                }
                if *response_status == "failed" && failure_reason.is_none() {
                    *failure_reason = Some(ResponsesFailure::from_event(&event));
                }
            }
            "error" => {
                // Surface the error as a completed response with failed
                // status. The stream loop will see stream_completed_normally
                // and stop.
                *stream_completed_normally = true;
                *response_status = String::from("failed");
                let failure = ResponsesFailure::from_event(&event);
                *completed_response = None;
                *failure_reason = Some(failure);
            }
            _ => {}
        }

        if *stream_completed_normally {
            break;
        }
    }

    (content_delta_out, thinking_delta_out)
}

// ---------------------------------------------------------------------------
// Token usage extraction
// ---------------------------------------------------------------------------

/// Read a streaming text delta from a Responses API event.
pub(super) fn read_stream_text_delta(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(ToString::to_string)
        .unwrap_or_default()
}

/// Extract token usage from a Responses API `response` JSON object.
pub fn extract_token_usage(response: &Value) -> ChatTokenUsage {
    let usage = response.get("usage").unwrap_or(response);

    ChatTokenUsage {
        input_tokens: read_first_i64(
            usage,
            &[
                &["input_tokens"],
                &["prompt_tokens"],
                &["total_input_tokens"],
            ],
        ),
        output_tokens: read_first_i64(
            usage,
            &[
                &["output_tokens"],
                &["completion_tokens"],
                &["total_output_tokens"],
            ],
        ),
        cache_creation_input_tokens: read_first_i64(
            usage,
            &[
                &["cache_creation_input_tokens"],
                &["prompt_cache_creation_tokens"],
                &["input_tokens_details", "cache_creation_input_tokens"],
                &["input_tokens_details", "cache_creation_tokens"],
                &["prompt_tokens_details", "cache_creation_input_tokens"],
                &["prompt_tokens_details", "cache_creation_tokens"],
            ],
        ),
        cache_read_input_tokens: read_first_i64(
            usage,
            &[
                &["cache_read_input_tokens"],
                &["cache_hit_input_tokens"],
                &["cache_hit_tokens"],
                &["prompt_cache_hit_tokens"],
                &["cached_tokens"],
                &["input_tokens_details", "cache_read_input_tokens"],
                &["input_tokens_details", "cache_hit_tokens"],
                &["input_tokens_details", "cached_tokens"],
                &["prompt_tokens_details", "cache_read_input_tokens"],
                &["prompt_tokens_details", "cache_hit_tokens"],
                &["prompt_tokens_details", "cached_tokens"],
            ],
        ),
    }
}

// ---------------------------------------------------------------------------
// Reasoning text / items
// ---------------------------------------------------------------------------

/// Extract thinking/reasoning text from a completed Responses API response.
pub(super) fn extract_response_thinking(response: &Value) -> String {
    let mut chunks = Vec::new();
    collect_reasoning_text(response.get("output"), &mut chunks);
    chunks.join("\n").trim().to_string()
}

/// Recursively collect reasoning text from a Responses API output tree.
pub(super) fn collect_reasoning_text(value: Option<&Value>, chunks: &mut Vec<String>) {
    let Some(value) = value else {
        return;
    };

    match value {
        Value::Array(items) => {
            for item in items {
                collect_reasoning_text(Some(item), chunks);
            }
        }
        Value::Object(object) => {
            let is_reasoning = object
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(|value| value == "reasoning");
            if is_reasoning {
                collect_text_values(value, chunks);
                return;
            }

            collect_reasoning_text(object.get("summary"), chunks);
            collect_reasoning_text(object.get("content"), chunks);
        }
        _ => {}
    }
}

/// Collect text values from a JSON tree, handling strings, arrays, and
/// objects with text-like fields.
pub(super) fn collect_text_values(value: &Value, chunks: &mut Vec<String>) {
    match value {
        Value::String(text) => {
            let text = text.trim();
            if !text.is_empty() {
                chunks.push(text.to_string());
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_text_values(item, chunks);
            }
        }
        Value::Object(object) => {
            for key in ["text", "summary_text", "content", "value"] {
                if let Some(text) = object
                    .get(key)
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    chunks.push(text.to_string());
                }
            }

            for key in ["summary", "content"] {
                if let Some(child) = object.get(key) {
                    collect_text_values(child, chunks);
                }
            }
        }
        _ => {}
    }
}

/// Read bounded, redacted metadata from the complete failed-event envelope.
/// The caller supplies a generic failure when both error fields are absent/null.
pub(super) fn extract_response_failure_reason(event: &Value) -> Option<ResponsesFailure> {
    let response = event.get("response").unwrap_or(event);
    response
        .get("error")
        .filter(|error| !error.is_null())
        .or_else(|| event.get("error").filter(|error| !error.is_null()))?;
    Some(ResponsesFailure::from_event(event))
}

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

/// Collect tool calls from a Responses API JSON tree.
///
/// Detects items whose `type` is one of the known tool-call variants, or
/// objects that have a `call_id` plus `name`/`arguments` shape.
pub(super) fn collect_tool_calls(value: Option<&Value>, calls: &mut Vec<Value>) {
    let Some(value) = value else {
        return;
    };

    match value {
        Value::Array(items) => {
            for item in items {
                collect_tool_calls(Some(item), calls);
            }
        }
        Value::Object(object) => {
            let is_tool_call = object
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(|value| {
                    matches!(
                        value,
                        "function_call" | "tool_call" | "custom_tool_call" | "mcp_call"
                    )
                });
            let has_call_shape = object.contains_key("call_id")
                && (object.contains_key("name") || object.contains_key("arguments"));

            if is_tool_call || has_call_shape {
                calls.push(value.clone());
                return;
            }

            collect_tool_calls(object.get("content"), calls);
        }
        _ => {}
    }
}

// ---------------------------------------------------------------------------
// Reasoning items
// ---------------------------------------------------------------------------

/// Collect reasoning output items from a Responses API output tree.
///
/// Unlike `collect_reasoning_text` (which extracts text only), this function
/// clones the entire reasoning item so it can be round-tripped verbatim on
/// the next request when `store: false`. Recursively traverses arrays and
/// nested objects (e.g. `content`, `summary`) to find all items with
/// `type == "reasoning"`.
pub(super) fn collect_reasoning_items(value: Option<&Value>, items: &mut Vec<Value>) {
    let Some(value) = value else {
        return;
    };

    match value {
        Value::Array(elements) => {
            for element in elements {
                collect_reasoning_items(Some(element), items);
            }
        }
        Value::Object(object) => {
            let is_reasoning = object
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(|value| value == "reasoning");
            if is_reasoning {
                items.push(value.clone());
                return;
            }

            collect_reasoning_items(object.get("content"), items);
            collect_reasoning_items(object.get("summary"), items);
            collect_reasoning_items(object.get("output"), items);
        }
        _ => {}
    }
}

// ---------------------------------------------------------------------------
// Output text
// ---------------------------------------------------------------------------

/// Read a string field from a Responses API response object.
pub(super) fn read_response_string(response: &Value, key: &str) -> Option<String> {
    response
        .get(key)
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

/// Extract output text from a completed Responses API response.
pub(super) fn extract_output_text(response: &Value) -> String {
    if let Some(output_text) = response
        .get("output_text")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return output_text.to_string();
    }

    let mut chunks = Vec::new();
    collect_output_text(response.get("output"), &mut chunks);

    chunks.join("\n").trim().to_string()
}

/// Recursively collect output text from a Responses API output tree.
pub(super) fn collect_output_text(value: Option<&Value>, chunks: &mut Vec<String>) {
    let Some(value) = value else {
        return;
    };

    match value {
        Value::Array(items) => {
            for item in items {
                collect_output_text(Some(item), chunks);
            }
        }
        Value::Object(object) => {
            for key in ["text", "output_text", "value"] {
                if let Some(text) = object
                    .get(key)
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    chunks.push(text.to_string());
                    return;
                }
            }

            collect_output_text(object.get("content"), chunks);
        }
        _ => {}
    }
}
