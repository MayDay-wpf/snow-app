//! Gemini SSE event block parsing and individual event processing.

use napi::bindgen_prelude::*;
use serde_json::Value;

use crate::api::common::{read_first_i64, read_string};
use crate::storage::services::chat_conversations::ChatTokenUsage;

/// Process a raw SSE event block (text between two separators) for the
/// Gemini streaming protocol. Each `data:` line is parsed independently.
#[allow(clippy::too_many_arguments)]
pub(super) fn process_gemini_sse_event_block(
    event_block: &str,
    raw_events: &mut Vec<Value>,
    content_chunks: &mut Vec<String>,
    thinking_chunks: &mut Vec<String>,
    tool_calls: &mut Vec<Value>,
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
    // data to be silently dropped.
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
                eprintln!("Gemini stream event parse error (skipping line): {}", error);
                continue;
            }
        };

        if let Err(process_error) = process_gemini_event(
            &event,
            content_chunks,
            thinking_chunks,
            tool_calls,
            response_id,
            response_model,
            response_status,
            token_usage,
            tool_args_delta,
        ) {
            eprintln!(
                "Gemini stream event processing error (skipping event): {}",
                process_error.reason
            );
            continue;
        }

        // Detect finishReason to signal normal stream completion.
        if let Some(candidates) = event.get("candidates").and_then(Value::as_array) {
            for candidate in candidates {
                if candidate
                    .get("finishReason")
                    .and_then(Value::as_str)
                    .is_some_and(|r| !r.is_empty())
                {
                    *stream_finished = true;
                }
            }
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
            let _ = process_gemini_event(
                &event,
                content_chunks,
                thinking_chunks,
                tool_calls,
                response_id,
                response_model,
                response_status,
                token_usage,
                tool_args_delta,
            );
            // Detect finishReason in raw JSON fallback.
            if let Some(candidates) = event.get("candidates").and_then(Value::as_array) {
                for candidate in candidates {
                    if candidate
                        .get("finishReason")
                        .and_then(Value::as_str)
                        .is_some_and(|r| !r.is_empty())
                    {
                        *stream_finished = true;
                    }
                }
            }
            raw_events.push(event);
        }
    }
}

/// Process a single parsed Gemini SSE event.
#[allow(clippy::too_many_arguments)]
fn process_gemini_event(
    event: &Value,
    content_chunks: &mut Vec<String>,
    thinking_chunks: &mut Vec<String>,
    tool_calls: &mut Vec<Value>,
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
            .unwrap_or("Gemini stream failed");
        return Err(Error::from_reason(message.to_string()));
    }

    if let Some(id) = read_string(event, "responseId") {
        *response_id = id;
    }
    if let Some(model) = read_string(event, "modelVersion") {
        *response_model = model;
    }

    if let Some(usage) = event.get("usageMetadata").filter(|value| !value.is_null()) {
        token_usage.input_tokens = read_first_i64(usage, &[&["promptTokenCount"]]);
        token_usage.output_tokens =
            read_first_i64(usage, &[&["candidatesTokenCount"], &["totalTokenCount"]]);
        token_usage.cache_read_input_tokens =
            read_first_i64(usage, &[&["cachedContentTokenCount"]]);
    }

    if let Some(prompt_feedback) = event.get("promptFeedback") {
        if let Some(block_reason) = prompt_feedback
            .get("blockReason")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            *response_status = block_reason.to_lowercase();
            return Ok(());
        }
    }

    if let Some(candidates) = event.get("candidates").and_then(Value::as_array) {
        for candidate in candidates {
            if let Some(content) = candidate.get("content") {
                if let Some(parts) = content.get("parts").and_then(Value::as_array) {
                    for part in parts {
                        let is_thought = part
                            .get("thought")
                            .and_then(Value::as_bool)
                            .unwrap_or(false);

                        if let Some(text) = part
                            .get("text")
                            .and_then(Value::as_str)
                            .filter(|text| !text.is_empty())
                        {
                            if is_thought {
                                thinking_chunks.push(text.to_string());
                            } else {
                                content_chunks.push(text.to_string());
                            }
                        }

                        if let Some(function_call) = part.get("functionCall") {
                            // Serialize the function call so the token
                            // probe can reflect tool arguments in real
                            // time. Gemini returns the complete object
                            // at once (no streaming argument deltas), so
                            // we count it immediately when it appears.
                            if let Ok(json) = serde_json::to_string(function_call) {
                                tool_args_delta.push_str(&json);
                            }
                            tool_calls.push(function_call.clone());
                        }
                    }
                }
            }

            if let Some(finish_reason) = candidate
                .get("finishReason")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
            {
                *response_status = match finish_reason {
                    "STOP" => "completed".to_string(),
                    "MAX_TOKENS" => "max_tokens".to_string(),
                    other => other.to_lowercase(),
                };
            }
        }
    }

    Ok(())
}
