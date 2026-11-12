//! Gemini SSE event block parsing and individual event processing.

use napi::bindgen_prelude::*;
use crate::diagnostic as eprintln;
use serde_json::Value;

use crate::api::common::{read_first_i64, read_string};
use crate::storage::services::chat_conversations::ChatTokenUsage;

fn unwrap_response_envelope(event: &Value) -> &Value {
    event
        .get("response")
        .filter(|value| value.is_object())
        .unwrap_or(event)
}

/// 解析 usageMetadata（兼容 CLIProxyAPI 等别名字段）。
fn apply_usage_metadata(usage: &Value, token_usage: &mut ChatTokenUsage) {
    token_usage.input_tokens = read_first_i64(
        usage,
        &[
            &["promptTokenCount"],
            &["prompt_tokens"],
            &["input_tokens"],
            &["total_input_tokens"],
        ],
    );
    let has_cpa_output = usage.get("total_output_tokens").is_some();
    let mut output_tokens = read_first_i64(
        usage,
        &[
            &["candidatesTokenCount"],
            &["completion_tokens"],
            &["output_tokens"],
            &["total_output_tokens"],
            &["totalTokenCount"],
        ],
    );
    // CLIProxyAPI reports thinking/tool-use tokens separately. Include
    // them in Snow's output total when the CPA total is present, matching
    // the Interactions usage mapping and preventing under-counted runs.
    if has_cpa_output {
        output_tokens += read_first_i64(usage, &[&["total_thought_tokens"]]);
        output_tokens += read_first_i64(usage, &[&["total_tool_use_tokens"]]);
    }
    token_usage.output_tokens = output_tokens;
    token_usage.cache_read_input_tokens = read_first_i64(
        usage,
        &[
            &["cachedContentTokenCount"],
            &["cache_read_input_tokens"],
            &["cached_tokens"],
            &["total_cached_tokens"],
        ],
    );
}

/// 从原始 SSE 事件（可能带 response 包裹）读取用量。
pub fn apply_event_usage(event: &Value, token_usage: &mut ChatTokenUsage) {
    let event = unwrap_response_envelope(event);
    if let Some(usage) = event
        .get("usageMetadata")
        .or_else(|| event.get("usage"))
        .filter(|value| !value.is_null())
    {
        apply_usage_metadata(usage, token_usage);
    }
}

/// Process a raw SSE event block (text between two separators) for the
/// Gemini streaming protocol. Each `data:` line is parsed independently.
#[allow(clippy::too_many_arguments)]
pub(super) fn process_gemini_sse_event_block(
    event_block: &str,
    content_chunks: &mut Vec<String>,
    thinking_chunks: &mut Vec<String>,
    tool_calls: &mut Vec<Value>,
    signature_parts: &mut Vec<Value>,
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
        let event = unwrap_response_envelope(&event);

        if let Err(process_error) = process_gemini_event(
            event,
            content_chunks,
            thinking_chunks,
            tool_calls,
            signature_parts,
            response_id,
            response_model,
            response_status,
            token_usage,
            tool_args_delta,
        ) {
            eprintln!(
                "Gemini stream event processing error (terminal provider error): {}",
                process_error.reason
            );
            *response_status = String::from("failed");
            *stream_finished = true;
            return;
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
            let event = unwrap_response_envelope(&event);
            if let Err(process_error) = process_gemini_event(
                event,
                content_chunks,
                thinking_chunks,
                tool_calls,
                signature_parts,
                response_id,
                response_model,
                response_status,
                token_usage,
                tool_args_delta,
            ) {
                eprintln!(
                    "Gemini stream event processing error (terminal provider error): {}",
                    process_error.reason
                );
                *response_status = String::from("failed");
                *stream_finished = true;
                return;
            }
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
    signature_parts: &mut Vec<Value>,
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

    if let Some(usage) = event
        .get("usageMetadata")
        .or_else(|| event.get("usage"))
        .filter(|value| !value.is_null())
    {
        apply_usage_metadata(usage, token_usage);
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
                        // Gemini thoughtSignature is opaque continuation data,
                        // not displayable thought text. Preserve the complete
                        // Part so a later functionResponse can continue the
                        // same reasoning chain without exposing the signature.
                        if part
                            .get("thoughtSignature")
                            .and_then(Value::as_str)
                            .is_some_and(|signature| !signature.is_empty())
                        {
                            signature_parts.push(part.clone());
                        }
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
                            // 流式 relay（如 Antigravity）可能把单个
                            // functionCall 拆成多个 SSE chunk：先返回带
                            // name 的空 args 调用，再返回无 name 的 args
                            // 增量。若每个 chunk 独立入库，工具执行会拿到
                            // 空参数（"Received keys: []"）。原生 Gemini
                            // 一次返回完整对象，合并逻辑无副作用。
                            merge_function_call(tool_calls, function_call);
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

/// 将一条 functionCall 合并进工具调用列表，兼容流式 relay 的增量返回：
/// - 有 id 时按 id 合并，保留同名并行调用各自的参数
/// - 无 id 且有 name 时按名称合并（旧版原生 Gemini 的增量兼容）
/// - 有 name 且无匹配调用 → 作为新调用追加
/// - 无 name（纯增量 chunk）→ 合并进最后一个调用
fn merge_function_call(tool_calls: &mut Vec<Value>, incoming: &Value) {
    if let Some(id) = incoming.get("id").and_then(Value::as_str) {
        if let Some(existing) = tool_calls
            .iter_mut()
            .rev()
            .find(|call| call.get("id").and_then(Value::as_str) == Some(id))
        {
            merge_function_call_args(existing, incoming);
            return;
        }
        tool_calls.push(incoming.clone());
        return;
    }
    let incoming_name = incoming.get("name").and_then(Value::as_str);
    if let Some(name) = incoming_name {
        if let Some(existing) = tool_calls
            .iter_mut()
            .rev()
            .find(|call| call.get("name").and_then(Value::as_str) == Some(name))
        {
            merge_function_call_args(existing, incoming);
            return;
        }
        tool_calls.push(incoming.clone());
        return;
    }
    if let Some(last) = tool_calls.last_mut() {
        merge_function_call_args(last, incoming);
    } else {
        tool_calls.push(incoming.clone());
    }
}

/// 将 incoming 的 args 深合并进 target（后者覆盖前者），并补齐 target
/// 缺失的其他字段（如 thoughtSignature）。
fn merge_function_call_args(target: &mut Value, incoming: &Value) {
    let incoming_args = incoming
        .get("args")
        .or_else(|| incoming.get("arguments"))
        .filter(|args| args.is_object());
    if let Some(incoming_args) = incoming_args {
        let incoming_map = incoming_args.as_object().cloned().unwrap_or_default();
        if !incoming_map.is_empty() {
            let target_args_key = if target.get("args").is_some() {
                "args"
            } else if target.get("arguments").is_some() {
                "arguments"
            } else {
                "args"
            };
            match target.get_mut(target_args_key) {
                Some(existing) if existing.is_object() => {
                    if let Some(target_map) = existing.as_object_mut() {
                        for (key, value) in incoming_map {
                            target_map.insert(key, value);
                        }
                    }
                }
                _ => {
                    target[target_args_key] = Value::Object(incoming_map);
                }
            }
        }
    }
    if let Some(incoming_map) = incoming.as_object() {
        if let Some(target_map) = target.as_object_mut() {
            for (key, value) in incoming_map {
                if key != "args" && key != "arguments" && !target_map.contains_key(key) {
                    target_map.insert(key.clone(), value.clone());
                }
            }
        }
    }
}
