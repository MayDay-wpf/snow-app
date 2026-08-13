//! Responses API stream-event helpers — SSE block parsing, token usage
//! extraction, reasoning text collection, tool-call collection, and output
//! text extraction.

use std::collections::HashMap;

use serde_json::{json, Value};

use crate::api::common::read_first_i64;
use crate::storage::services::chat_conversations::ChatTokenUsage;

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
    raw_events: &mut Vec<Value>,
    content_chunks: &mut Vec<String>,
    thinking_chunks: &mut Vec<String>,
    tool_calls: &mut Vec<Value>,
    reasoning_items: &mut Vec<Value>,
    streaming_tool_items: &mut HashMap<u64, (Value, String)>,
    response_id: &mut String,
    response_model: &mut String,
    response_status: &mut String,
    token_usage: &mut ChatTokenUsage,
    completed_response: &mut Option<Value>,
    stream_completed_normally: &mut bool,
    reasoning_text_streamed: &mut bool,
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
                *reasoning_text_streamed = true;
                let thinking_delta = read_stream_text_delta(event.get("delta"));
                if !thinking_delta.is_empty() {
                    thinking_chunks.push(thinking_delta.clone());
                    thinking_delta_out.push_str(&thinking_delta);
                }
            }
            "response.reasoning_summary_text.delta" => {
                // The summary is a condensed re-statement of the full
                // reasoning text. If the full text was already streamed via
                // `response.reasoning_text.delta`, appending the summary
                // would duplicate the thinking block, so suppress it.
                if !*reasoning_text_streamed {
                    let thinking_delta = read_stream_text_delta(event.get("delta"));
                    if !thinking_delta.is_empty() {
                        thinking_chunks.push(thinking_delta.clone());
                        thinking_delta_out.push_str(&thinking_delta);
                    }
                }
            }
            "response.reasoning_summary.delta" => {
                // See reasoning_summary_text.delta above: skip the summary
                // when the full reasoning text is streamed.
                if !*reasoning_text_streamed {
                    if let Some(delta) = event.get("delta") {
                        let mut delta_chunks = Vec::new();
                        collect_text_values(delta, &mut delta_chunks);
                        let thinking_delta = delta_chunks.join("");
                        if !thinking_delta.is_empty() {
                            thinking_chunks.push(thinking_delta.clone());
                            thinking_delta_out.push_str(&thinking_delta);
                        }
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
                    *response_id =
                        read_response_string(response, "id").unwrap_or_else(|| response_id.clone());
                    *response_model = read_response_string(response, "model")
                        .unwrap_or_else(|| response_model.clone());
                    if let Some(status) = read_response_string(response, "status").filter(|status| {
                        matches!(status.as_str(), "completed" | "incomplete" | "failed")
                    }) {
                        *response_status = status;
                    }
                    *token_usage = extract_token_usage(response);
                    *completed_response = Some(response.clone());
                }
            }
            "error" => {
                // Surface the error as a completed response with failed
                // status. The stream loop will see stream_completed_normally
                // and stop.
                *stream_completed_normally = true;
                *response_status = String::from("failed");
                let message = event
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Responses stream failed");
                // Store the error message so the caller can surface it.
                *completed_response = Some(json!({"error": message}));
            }
            _ => {}
        }

        raw_events.push(event);
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
pub(super) fn extract_token_usage(response: &Value) -> ChatTokenUsage {
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
