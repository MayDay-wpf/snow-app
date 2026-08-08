//! Chat Completions SSE event block parsing and individual event processing.

use std::collections::HashMap;

use crate::api::common::{push_reasoning_text, push_trimmed_string, read_first_i64, read_string};
use crate::storage::services::chat_conversations::ChatTokenUsage;
use napi::bindgen_prelude::*;
use serde_json::Value;

/// Process a raw SSE event block (text between two separators) for the
/// Chat Completions streaming protocol. Each `data:` line is parsed
/// independently.
#[allow(clippy::too_many_arguments)]
pub(super) fn process_sse_event_block(
    event_block: &str,
    raw_events: &mut Vec<Value>,
    content_chunks: &mut Vec<String>,
    thinking_chunks: &mut Vec<String>,
    tool_calls: &mut Vec<Value>,
    tool_call_positions_by_index: &mut HashMap<usize, usize>,
    response_id: &mut String,
    response_model: &mut String,
    response_status: &mut String,
    token_usage: &mut ChatTokenUsage,
    tool_args_delta: &mut String,
    stream_finished: &mut bool,
) {
    // Process each `data:` line independently as a separate SSE event.
    // This matches the TypeScript reference implementation where each line
    // is parsed on its own. Joining multiple data lines into one string
    // (the old behavior) produces invalid JSON when a proxy or server
    // batches multiple events within a single block, causing tool-call
    // deltas to be silently dropped.
    let mut found_data_line = false;
    for line in event_block.lines() {
        let trimmed = line.trim_start();
        let Some(data) = trimmed.strip_prefix("data:") else {
            continue;
        };
        found_data_line = true;
        let data = data.trim_start();

        if data.is_empty() {
            continue;
        }
        if data == "[DONE]" {
            *stream_finished = true;
            return;
        }

        let event = match serde_json::from_str::<Value>(data) {
            Ok(event) => event,
            Err(error) => {
                eprintln!("Chat stream event parse error (skipping line): {}", error);
                continue;
            }
        };

        if let Err(process_error) = process_chat_completion_event(
            &event,
            content_chunks,
            thinking_chunks,
            tool_calls,
            tool_call_positions_by_index,
            response_id,
            response_model,
            response_status,
            token_usage,
            tool_args_delta,
        ) {
            eprintln!(
                "Chat stream event processing error (skipping event): {}",
                process_error.reason
            );
            continue;
        }
        raw_events.push(event);
    }

    // Fallback: some providers return a complete JSON response without SSE
    // `data:` framing (non-streaming response to a stream request). If no
    // `data:` lines were found, try parsing the entire block as raw JSON.
    if !found_data_line {
        let trimmed_block = event_block.trim();
        if trimmed_block.is_empty() || trimmed_block.starts_with(':') {
            return;
        }
        if trimmed_block == "[DONE]" {
            *stream_finished = true;
            return;
        }
        if let Ok(event) = serde_json::from_str::<Value>(trimmed_block) {
            let _ = process_chat_completion_event(
                &event,
                content_chunks,
                thinking_chunks,
                tool_calls,
                tool_call_positions_by_index,
                response_id,
                response_model,
                response_status,
                token_usage,
                tool_args_delta,
            );
            raw_events.push(event);
        }
    }
}

/// Process a single parsed Chat Completions SSE event.
#[allow(clippy::too_many_arguments)]
fn process_chat_completion_event(
    event: &Value,
    content_chunks: &mut Vec<String>,
    thinking_chunks: &mut Vec<String>,
    tool_calls: &mut Vec<Value>,
    tool_call_positions_by_index: &mut HashMap<usize, usize>,
    response_id: &mut String,
    response_model: &mut String,
    response_status: &mut String,
    token_usage: &mut ChatTokenUsage,
    tool_args_delta: &mut String,
) -> Result<()> {
    if let Some(error) = event.get("error") {
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("Chat completions stream failed");
        return Err(Error::from_reason(message.to_string()));
    }

    if let Some(id) = read_string(event, "id") {
        *response_id = id;
    }
    if let Some(model) = read_string(event, "model") {
        *response_model = model;
    }
    if let Some(usage) = event.get("usage").filter(|value| !value.is_null()) {
        *token_usage = extract_token_usage(usage);
    }

    if let Some(choices) = event.get("choices").and_then(Value::as_array) {
        for choice in choices {
            if let Some(delta) = choice.get("delta") {
                push_trimmed_string(delta.get("content"), content_chunks);
                // Normalise reasoning across providers: DeepSeek emits
                // `reasoning_content`, OpenRouter emits `reasoning` /
                // `reasoning_details`. `push_reasoning_text` checks all three
                // so the thinking block is populated regardless of provider.
                push_reasoning_text(Some(delta), thinking_chunks);
                // Extract tool-call argument deltas so the token probe can
                // reflect long tool arguments in real time. The full
                // arguments are still assembled by `collect_tool_calls`; we
                // only need the delta text for counting.
                collect_tool_call_argument_delta(delta, tool_args_delta);
                collect_tool_calls(
                    delta.get("tool_calls"),
                    tool_calls,
                    tool_call_positions_by_index,
                    true,
                );
            }

            if let Some(message) = choice.get("message") {
                push_trimmed_string(message.get("content"), content_chunks);
                push_reasoning_text(Some(message), thinking_chunks);
                collect_tool_calls(
                    message.get("tool_calls"),
                    tool_calls,
                    tool_call_positions_by_index,
                    false,
                );
            }

            // Fallback: some non-standard providers place tool_calls directly
            // on the choice object (not inside delta or message).
            if choice.get("delta").is_none() && choice.get("message").is_none() {
                push_trimmed_string(choice.get("content"), content_chunks);
                collect_tool_calls(
                    choice.get("tool_calls"),
                    tool_calls,
                    tool_call_positions_by_index,
                    false,
                );
            }

            if let Some(finish_reason) = choice
                .get("finish_reason")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
            {
                *response_status = if finish_reason == "stop" {
                    "completed".to_string()
                } else {
                    finish_reason.to_string()
                };
            }
        }
    }

    Ok(())
}

/// Extract the concatenated argument deltas from a Chat Completions
/// `delta.tool_calls` array. The delta object looks like:
///
/// ```json
/// { "tool_calls": [{ "index": 0, "function": { "arguments": "..." } }] }
/// ```
///
/// Only the `arguments` string fragments are appended to `out` because
/// those are the streaming pieces that grow over time. Name/id fields
/// appear once at the start and are not useful for the token probe.
fn collect_tool_call_argument_delta(delta: &Value, out: &mut String) {
    let Some(tool_calls) = delta.get("tool_calls").and_then(Value::as_array) else {
        return;
    };
    for tool_call in tool_calls {
        if let Some(args) = tool_call
            .get("function")
            .and_then(|function| function.get("arguments"))
            .and_then(Value::as_str)
        {
            if !args.is_empty() {
                out.push_str(args);
            }
        }
    }
}

/// Extract token usage from a Chat Completions `usage` JSON object.
pub(super) fn extract_token_usage(usage: &Value) -> ChatTokenUsage {
    ChatTokenUsage {
        input_tokens: read_first_i64(usage, &[&["prompt_tokens"], &["input_tokens"]]),
        output_tokens: read_first_i64(usage, &[&["completion_tokens"], &["output_tokens"]]),
        cache_creation_input_tokens: read_first_i64(
            usage,
            &[
                &["prompt_cache_creation_tokens"],
                &["cache_creation_input_tokens"],
                &["prompt_tokens_details", "cache_creation_input_tokens"],
                &["prompt_tokens_details", "cache_creation_tokens"],
            ],
        ),
        cache_read_input_tokens: read_first_i64(
            usage,
            &[
                &["cached_tokens"],
                &["prompt_cache_hit_tokens"],
                &["cache_read_input_tokens"],
                &["cache_hit_input_tokens"],
                &["cache_hit_tokens"],
                &["prompt_tokens_details", "cache_read_input_tokens"],
                &["prompt_tokens_details", "cache_hit_tokens"],
                &["prompt_tokens_details", "cached_tokens"],
            ],
        ),
    }
}

// ---------------------------------------------------------------------------
// Tool call accumulation (streaming merge)
// ---------------------------------------------------------------------------

/// Collect tool calls from a streaming delta or a complete message.
///
/// When `merge_by_index` is `true` (delta mode), tool calls with the same
/// `index` field are merged in place instead of appended — this is how
/// Chat Completions streams incremental argument fragments.
#[allow(clippy::too_many_arguments)]
pub(super) fn collect_tool_calls(
    value: Option<&Value>,
    calls: &mut Vec<Value>,
    positions_by_index: &mut HashMap<usize, usize>,
    merge_by_index: bool,
) {
    let Some(value) = value else {
        return;
    };

    match value {
        Value::Array(items) => {
            for item in items {
                collect_tool_calls(Some(item), calls, positions_by_index, merge_by_index);
            }
        }
        Value::Object(object) => {
            if merge_by_index {
                if let Some(index) = object
                    .get("index")
                    .and_then(Value::as_u64)
                    .and_then(|value| usize::try_from(value).ok())
                {
                    if let Some(position) = positions_by_index.get(&index).copied() {
                        if let Some(target) = calls.get_mut(position) {
                            merge_tool_call_value(target, value);
                            return;
                        }
                    }
                    positions_by_index.insert(index, calls.len());
                }
            }

            calls.push(value.clone());
        }
        _ => {}
    }
}

fn merge_tool_call_value(target: &mut Value, delta: &Value) {
    match (target, delta) {
        (Value::Object(target_object), Value::Object(delta_object)) => {
            for (key, delta_value) in delta_object {
                if is_ignorable_tool_call_delta_value(delta_value) {
                    continue;
                }

                if let Some(target_value) = target_object.get_mut(key) {
                    merge_tool_call_field(key, target_value, delta_value);
                } else {
                    target_object.insert(key.clone(), delta_value.clone());
                }
            }
        }
        (target_value, delta_value) => {
            if !is_ignorable_tool_call_delta_value(delta_value) {
                *target_value = delta_value.clone();
            }
        }
    }
}

fn merge_tool_call_field(key: &str, target: &mut Value, delta: &Value) {
    if key == "arguments" {
        if let (Value::String(target_text), Value::String(delta_text)) = (&mut *target, delta) {
            target_text.push_str(delta_text);
            return;
        }
    }

    merge_tool_call_value(target, delta);
}

fn is_ignorable_tool_call_delta_value(value: &Value) -> bool {
    value.is_null() || value.as_str().is_some_and(str::is_empty)
}
