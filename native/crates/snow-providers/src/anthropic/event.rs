//! Anthropic SSE event block parsing and individual event processing.

use std::collections::HashMap;

use napi::bindgen_prelude::*;
use crate::diagnostic as eprintln;
use serde_json::Value;

use crate::api::common::{push_trimmed_string, read_path_i64, read_string, truncate_utf8_safe};
use crate::storage::services::chat_conversations::ChatTokenUsage;

/// Read the SSE content block index carried by start/stop/delta events.
fn event_block_index(event: &Value) -> Option<usize> {
    event
        .get("index")
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
}

/// Resolve the accumulated block for one SSE index. Blocks keep the exact
/// order the provider emitted them in, so replay can stay byte-for-byte.
fn block_at_index<'a>(
    content_blocks: &'a mut [Value],
    block_positions_by_index: &HashMap<usize, usize>,
    index: usize,
) -> Option<&'a mut Value> {
    block_positions_by_index
        .get(&index)
        .and_then(|position| content_blocks.get_mut(*position))
}

/// Append streamed text to one string field of a content block.
fn append_block_text(block: &mut Value, field: &str, text: &str) {
    if let Some(object) = block.as_object_mut() {
        let existing = object.get(field).and_then(Value::as_str).unwrap_or_default();
        object.insert(field.to_string(), Value::String(format!("{existing}{text}")));
    }
}

/// Process a raw SSE event block (text between two separators) for the
/// Anthropic streaming protocol. Each `data:` line is parsed independently.
#[allow(clippy::too_many_arguments)]
pub(super) fn process_anthropic_sse_event_block(
    event_block: &str,
    content_chunks: &mut Vec<String>,
    thinking_chunks: &mut Vec<String>,
    content_blocks: &mut Vec<Value>,
    block_positions_by_index: &mut HashMap<usize, usize>,
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
            return;
        }

        if let Err(process_error) = process_anthropic_event(
            &event,
            content_chunks,
            thinking_chunks,
            content_blocks,
            block_positions_by_index,
            tool_input_json_by_index,
            response_id,
            response_model,
            response_status,
            token_usage,
            tool_args_delta,
            tool_parse_errors,
            stream_finished,
        ) {
            eprintln!(
                "Anthropic stream event processing error (terminal provider error): {}",
                process_error.reason
            );
            *response_status = String::from("failed");
            *stream_finished = true;
            return;
        }
        if *stream_finished {
            return;
        }
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
                return;
            }
            if let Err(process_error) = process_anthropic_event(
                &event,
                content_chunks,
                thinking_chunks,
                content_blocks,
                block_positions_by_index,
                tool_input_json_by_index,
                response_id,
                response_model,
                response_status,
                token_usage,
                tool_args_delta,
                tool_parse_errors,
                stream_finished,
            ) {
                eprintln!(
                    "Anthropic stream event processing error (terminal provider error): {}",
                    process_error.reason
                );
                *response_status = String::from("failed");
                *stream_finished = true;
                return;
            }
        }
    }
}

/// message_start 携带的用量（输入与缓存）。
pub fn apply_message_start_usage(usage: &Value, token_usage: &mut ChatTokenUsage) {
    if let Some(input_tokens) = read_path_i64(usage, &["input_tokens"]) {
        token_usage.input_tokens = input_tokens;
    }
    if let Some(cache_creation) = read_path_i64(usage, &["cache_creation_input_tokens"]) {
        token_usage.cache_creation_input_tokens = cache_creation;
    }
    if let Some(cache_read) = read_path_i64(usage, &["cache_read_input_tokens"]) {
        token_usage.cache_read_input_tokens = cache_read;
    }
}

/// message_delta 携带的用量：输出必更新，其余只在非零时覆盖。
pub fn apply_message_delta_usage(usage: &Value, token_usage: &mut ChatTokenUsage) {
    if let Some(output_tokens) = read_path_i64(usage, &["output_tokens"]) {
        token_usage.output_tokens = output_tokens;
    }
    if let Some(input_tokens) = read_path_i64(usage, &["input_tokens"]).filter(|n| *n > 0) {
        token_usage.input_tokens = input_tokens;
    }
    if let Some(cache_creation) =
        read_path_i64(usage, &["cache_creation_input_tokens"]).filter(|n| *n > 0)
    {
        token_usage.cache_creation_input_tokens = cache_creation;
    }
    if let Some(cache_read) = read_path_i64(usage, &["cache_read_input_tokens"]).filter(|n| *n > 0)
    {
        token_usage.cache_read_input_tokens = cache_read;
    }
}

/// Process a single parsed Anthropic SSE event.
#[allow(clippy::too_many_arguments)]
fn process_anthropic_event(
    event: &Value,
    content_chunks: &mut Vec<String>,
    thinking_chunks: &mut Vec<String>,
    content_blocks: &mut Vec<Value>,
    block_positions_by_index: &mut HashMap<usize, usize>,
    tool_input_json_by_index: &mut HashMap<usize, String>,
    response_id: &mut String,
    response_model: &mut String,
    response_status: &mut String,
    token_usage: &mut ChatTokenUsage,
    tool_args_delta: &mut String,
    tool_parse_errors: &mut Vec<String>,
    stream_finished: &mut bool,
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
                    apply_message_start_usage(usage, token_usage);
                }
            }
        }
        "content_block_start" => {
            if let (Some(index), Some(content_block)) =
                (event_block_index(event), event.get("content_block"))
            {
                let block_type = content_block
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                // Only replayable Anthropic blocks are captured. Snow never
                // produces server-side tool blocks, and unknown block types
                // have no replay semantics, so they are ignored.
                if matches!(
                    block_type,
                    "text" | "thinking" | "redacted_thinking" | "tool_use"
                ) {
                    block_positions_by_index.insert(index, content_blocks.len());
                    content_blocks.push(content_block.clone());
                }
            }
        }
        "content_block_stop" => {
            // Finalize tool input: parse the accumulated JSON fragments and
            // update the tool_use block's "input" field. input_json_delta only
            // sets "input" when the accumulated string already happens to be
            // valid JSON, so the authoritative value only exists once every
            // delta has arrived.
            let Some(index) = event_block_index(event) else {
                return Ok(());
            };
            let Some(accumulated) = tool_input_json_by_index.get(&index) else {
                return Ok(());
            };
            match serde_json::from_str::<Value>(accumulated.as_str()) {
                Ok(input) => {
                    if let Some(block) =
                        block_at_index(content_blocks, block_positions_by_index, index)
                    {
                        if let Some(object) = block.as_object_mut() {
                            object.insert("input".to_string(), input);
                        }
                    }
                }
                Err(parse_err) => {
                    let tool_name = block_at_index(content_blocks, block_positions_by_index, index)
                        .and_then(|block| block.get("name"))
                        .and_then(Value::as_str)
                        .unwrap_or("unknown");
                    tool_parse_errors.push(format!(
                        "tool={}, index={}, error={}, raw={}",
                        tool_name,
                        index,
                        parse_err,
                        truncate_utf8_safe(accumulated, 200)
                    ));
                }
            }
        }
        "content_block_delta" => {
            if let Some(delta) = event.get("delta") {
                let delta_type = delta
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let index = event_block_index(event);
                match delta_type {
                    "text_delta" => {
                        push_trimmed_string(delta.get("text"), content_chunks);
                        if let (Some(index), Some(text)) =
                            (index, delta.get("text").and_then(Value::as_str))
                        {
                            if let Some(block) =
                                block_at_index(content_blocks, block_positions_by_index, index)
                            {
                                append_block_text(block, "text", text);
                            }
                        }
                    }
                    "thinking_delta" => {
                        push_trimmed_string(delta.get("thinking"), thinking_chunks);
                        if let (Some(index), Some(text)) =
                            (index, delta.get("thinking").and_then(Value::as_str))
                        {
                            if let Some(block) =
                                block_at_index(content_blocks, block_positions_by_index, index)
                            {
                                append_block_text(block, "thinking", text);
                            }
                        }
                    }
                    "signature_delta" => {
                        // The signature must stay attached to the exact block it
                        // was issued for: the API rejects any reissue.
                        if let (Some(index), Some(signature)) = (
                            index,
                            delta
                                .get("signature")
                                .and_then(Value::as_str)
                                .filter(|signature| !signature.is_empty()),
                        ) {
                            if let Some(block) =
                                block_at_index(content_blocks, block_positions_by_index, index)
                            {
                                if let Some(object) = block.as_object_mut() {
                                    object.insert(
                                        "signature".to_string(),
                                        Value::String(signature.to_string()),
                                    );
                                }
                            }
                        }
                    }
                    "input_json_delta" => {
                        if let Some(index) = index {
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

                                // Best-effort intermediate parse for early UI
                                // updates; content_block_stop is authoritative.
                                if let Ok(input) =
                                    serde_json::from_str::<Value>(input_json.as_str())
                                {
                                    if let Some(block) = block_at_index(
                                        content_blocks,
                                        block_positions_by_index,
                                        index,
                                    ) {
                                        if let Some(object) = block.as_object_mut() {
                                            object.insert("input".to_string(), input);
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
                    *stream_finished = true;
                    *response_status = if stop_reason == "end_turn" {
                        "completed".to_string()
                    } else {
                        stop_reason.to_string()
                    };
                }
            }
            if let Some(usage) = event.get("usage").filter(|v| !v.is_null()) {
                apply_message_delta_usage(usage, token_usage);
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