//! Anthropic SSE event block parsing and individual event processing.

use std::collections::HashMap;

use napi::bindgen_prelude::*;
use serde_json::Value;

use crate::api::common::{push_trimmed_string, read_path_i64, read_string, truncate_utf8_safe};
use crate::storage::services::chat_conversations::ChatTokenUsage;

/// Process a raw SSE event block (text between two separators) for the
/// Anthropic streaming protocol. Each `data:` line is parsed independently.
#[allow(clippy::too_many_arguments)]
pub(super) fn process_anthropic_sse_event_block(
    event_block: &str,
    raw_events: &mut Vec<Value>,
    content_chunks: &mut Vec<String>,
    thinking_chunks: &mut Vec<String>,
    thinking_blocks: &mut Vec<Value>,
    tool_calls: &mut Vec<Value>,
    tool_call_positions_by_index: &mut HashMap<usize, usize>,
    tool_input_json_by_index: &mut HashMap<usize, String>,
    response_id: &mut String,
    response_model: &mut String,
    response_status: &mut String,
    token_usage: &mut ChatTokenUsage,
    tool_args_delta: &mut String,
    tool_parse_errors: &mut Vec<String>,
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

        let event = match serde_json::from_str::<Value>(data) {
            Ok(event) => event,
            Err(error) => {
                eprintln!(
                    "Anthropic stream event parse error (skipping line): {}",
                    error
                );
                continue;
            }
        };

        // Detect message_stop to signal normal stream completion.
        let event_type = event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if event_type == "message_stop" {
            *stream_finished = true;
            raw_events.push(event);
            return;
        }

        if let Err(process_error) = process_anthropic_event(
            &event,
            content_chunks,
            thinking_chunks,
            thinking_blocks,
            tool_calls,
            tool_call_positions_by_index,
            tool_input_json_by_index,
            response_id,
            response_model,
            response_status,
            token_usage,
            tool_args_delta,
            tool_parse_errors,
        ) {
            eprintln!(
                "Anthropic stream event processing error (skipping event): {}",
                process_error.reason
            );
            continue;
        }
        raw_events.push(event);
    }

    // Fallback: some providers return a complete JSON response without SSE
    // `data:` framing. If no `data:` lines were found, try parsing the
    // entire block as raw JSON.
    if !found_data_line {
        let trimmed_block = event_block.trim();
        if trimmed_block.is_empty() || trimmed_block.starts_with(':') {
            return;
        }
        if let Ok(event) = serde_json::from_str::<Value>(trimmed_block) {
            let event_type = event
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if event_type == "message_stop" {
                *stream_finished = true;
                raw_events.push(event);
                return;
            }
            let _ = process_anthropic_event(
                &event,
                content_chunks,
                thinking_chunks,
                thinking_blocks,
                tool_calls,
                tool_call_positions_by_index,
                tool_input_json_by_index,
                response_id,
                response_model,
                response_status,
                token_usage,
                tool_args_delta,
                tool_parse_errors,
            );
            raw_events.push(event);
        }
    }
}

/// Process a single parsed Anthropic SSE event.
#[allow(clippy::too_many_arguments)]
fn process_anthropic_event(
    event: &Value,
    content_chunks: &mut Vec<String>,
    thinking_chunks: &mut Vec<String>,
    thinking_blocks: &mut Vec<Value>,
    tool_calls: &mut Vec<Value>,
    tool_call_positions_by_index: &mut HashMap<usize, usize>,
    tool_input_json_by_index: &mut HashMap<usize, String>,
    response_id: &mut String,
    response_model: &mut String,
    response_status: &mut String,
    token_usage: &mut ChatTokenUsage,
    tool_args_delta: &mut String,
    tool_parse_errors: &mut Vec<String>,
) -> Result<()> {
    let event_type = event
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();

    match event_type {
        "message_start" => {
            if let Some(message) = event.get("message") {
                if let Some(id) = read_string(message, "id") {
                    *response_id = id;
                }
                if let Some(model) = read_string(message, "model") {
                    *response_model = model;
                }
                if let Some(usage) = message.get("usage").filter(|v| !v.is_null()) {
                    if let Some(input_tokens) = read_path_i64(usage, &["input_tokens"]) {
                        token_usage.input_tokens = input_tokens;
                    }
                    if let Some(cache_creation) =
                        read_path_i64(usage, &["cache_creation_input_tokens"])
                    {
                        token_usage.cache_creation_input_tokens = cache_creation;
                    }
                    if let Some(cache_read) = read_path_i64(usage, &["cache_read_input_tokens"]) {
                        token_usage.cache_read_input_tokens = cache_read;
                    }
                }
            }
        }
        "content_block_start" => {
            if let Some(content_block) = event.get("content_block") {
                let block_type = content_block
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if block_type == "tool_use" {
                    if let Some(index) = event
                        .get("index")
                        .and_then(Value::as_u64)
                        .and_then(|value| usize::try_from(value).ok())
                    {
                        tool_call_positions_by_index.insert(index, tool_calls.len());
                    }
                    tool_calls.push(content_block.clone());
                } else if block_type == "thinking" || block_type == "redacted_thinking" {
                    // Capture the raw thinking block so it can be round-tripped
                    // back to the API verbatim on the next request (with its
                    // signature intact). thinking_delta and signature_delta
                    // events that follow will mutate the last block in-place.
                    thinking_blocks.push(content_block.clone());
                }
            }
        }
        "content_block_stop" => {
            // Finalize tool input: parse the accumulated JSON fragments
            // and update the tool_call's "input" field. This is critical
            // because input_json_delta only sets "input" when the
            // accumulated string happens to be valid JSON at an
            // intermediate point — the complete JSON is only available
            // after all deltas have been received.
            if let Some(index) = event
                .get("index")
                .and_then(Value::as_u64)
                .and_then(|value| usize::try_from(value).ok())
            {
                if let Some(accumulated) = tool_input_json_by_index.get(&index) {
                    match serde_json::from_str::<Value>(accumulated.as_str()) {
                        Ok(input) => {
                            if let Some(position) =
                                tool_call_positions_by_index.get(&index).copied()
                            {
                                if let Some(tool_call) =
                                    tool_calls.get_mut(position).and_then(Value::as_object_mut)
                                {
                                    tool_call.insert("input".to_string(), input);
                                }
                            }
                        }
                        Err(parse_err) => {
                            let tool_name = tool_call_positions_by_index
                                .get(&index)
                                .and_then(|pos| tool_calls.get(*pos))
                                .and_then(|tc| tc.get("name"))
                                .and_then(Value::as_str)
                                .unwrap_or("unknown");
                            tool_parse_errors.push(format!(
                                "tool={}, index={}, error={}, raw={}",
                                tool_name,
                                index,
                                parse_err,
                                truncate_utf8_safe(&accumulated, 200)
                            ));
                        }
                    }
                }
            }
        }
        "content_block_delta" => {
            if let Some(delta) = event.get("delta") {
                let delta_type = delta
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                match delta_type {
                    "text_delta" => {
                        push_trimmed_string(delta.get("text"), content_chunks);
                    }
                    "thinking_delta" => {
                        push_trimmed_string(delta.get("thinking"), thinking_chunks);
                        // Append the thinking text to the last thinking block
                        // so the block stays complete for round-tripping.
                        if let Some(thinking_block) = thinking_blocks.last_mut() {
                            if let Some(text) = delta.get("thinking").and_then(Value::as_str) {
                                if !text.is_empty() {
                                    if let Some(obj) = thinking_block.as_object_mut() {
                                        let existing = obj
                                            .get("thinking")
                                            .and_then(Value::as_str)
                                            .unwrap_or_default();
                                        obj.insert(
                                            "thinking".to_string(),
                                            Value::String(format!("{existing}{text}")),
                                        );
                                    }
                                }
                            }
                        }
                    }
                    "signature_delta" => {
                        // Write the cryptographic signature into the last
                        // thinking block. Anthropic requires thinking blocks
                        // to carry their original signature when passed back.
                        if let Some(signature) = delta.get("signature").and_then(Value::as_str) {
                            if !signature.is_empty() {
                                if let Some(thinking_block) = thinking_blocks.last_mut() {
                                    if let Some(obj) = thinking_block.as_object_mut() {
                                        obj.insert(
                                            "signature".to_string(),
                                            Value::String(signature.to_string()),
                                        );
                                    }
                                }
                            }
                        }
                    }
                    "input_json_delta" => {
                        if let Some(index) = event
                            .get("index")
                            .and_then(Value::as_u64)
                            .and_then(|value| usize::try_from(value).ok())
                        {
                            if let Some(partial_json) = delta
                                .get("partial_json")
                                .and_then(Value::as_str)
                                .filter(|value| !value.is_empty())
                            {
                                let input_json = tool_input_json_by_index.entry(index).or_default();
                                input_json.push_str(partial_json);
                                // Also accumulate the argument delta for the
                                // token probe so the renderer reflects long
                                // tool arguments in real time.
                                tool_args_delta.push_str(partial_json);

                                // Best-effort intermediate parse for early UI updates.
                                // The final, authoritative parse happens in content_block_stop.
                                if let Ok(input) =
                                    serde_json::from_str::<Value>(input_json.as_str())
                                {
                                    if let Some(position) =
                                        tool_call_positions_by_index.get(&index).copied()
                                    {
                                        if let Some(tool_call) = tool_calls
                                            .get_mut(position)
                                            .and_then(Value::as_object_mut)
                                        {
                                            tool_call.insert("input".to_string(), input);
                                        }
                                    }
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        "message_delta" => {
            if let Some(delta) = event.get("delta") {
                if let Some(stop_reason) = delta
                    .get("stop_reason")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                {
                    *response_status = if stop_reason == "end_turn" {
                        "completed".to_string()
                    } else {
                        stop_reason.to_string()
                    };
                }
            }
            if let Some(usage) = event.get("usage").filter(|v| !v.is_null()) {
                if let Some(output_tokens) = read_path_i64(usage, &["output_tokens"]) {
                    token_usage.output_tokens = output_tokens;
                }
                if let Some(input_tokens) =
                    read_path_i64(usage, &["input_tokens"]).filter(|n| *n > 0)
                {
                    token_usage.input_tokens = input_tokens;
                }
                if let Some(cache_creation) =
                    read_path_i64(usage, &["cache_creation_input_tokens"]).filter(|n| *n > 0)
                {
                    token_usage.cache_creation_input_tokens = cache_creation;
                }
                if let Some(cache_read) =
                    read_path_i64(usage, &["cache_read_input_tokens"]).filter(|n| *n > 0)
                {
                    token_usage.cache_read_input_tokens = cache_read;
                }
            }
        }
        "error" => {
            let message = event
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("Anthropic stream failed");
            return Err(Error::from_reason(message.to_string()));
        }
        _ => {}
    }

    Ok(())
}
