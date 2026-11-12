//! Chat Completions payload construction and endpoint resolution.

use std::path::Path;

use napi::bindgen_prelude::*;
use serde_json::{json, Value};

use crate::api::config::{normalize_base_url, resolve_advanced_model, resolve_sdk_api_base_url};
use crate::api::conversation::{parse_chat_message_content, ParsedChatMessageContent};
use crate::api::responses::ResponsesApiRequest;
use crate::storage::services::chat_conversations::ChatContextMessage;
use crate::storage::ApiConfigRecord;

pub(super) fn resolve_chat_completions_endpoint(api_config: &ApiConfigRecord) -> String {
    let normalized_base_url = normalize_base_url(&api_config.base_url);
    if normalized_base_url.is_empty() {
        return normalized_base_url;
    }

    if api_config.base_url_mode == "endpoint" {
        normalized_base_url
    } else {
        format!(
            "{}/chat/completions",
            resolve_sdk_api_base_url(&normalized_base_url, &api_config.base_url_mode)
        )
    }
}

pub(super) fn build_chat_completions_payload(
    messages: &[ChatContextMessage],
    database_path: &Path,
    request: &ResponsesApiRequest,
    api_config: &ApiConfigRecord,
    tools: Option<Value>,
    user_system_prompts: &[String],
    host_system_prompts: &[String],
) -> Result<Value> {
    let model = resolve_advanced_model(request.model.as_deref(), &api_config.advanced_model)?;

    let skip_image_parsing = request.skips_inline_image_parsing();
    let has_user_system_prompts = !user_system_prompts.is_empty();
    let mut builtin_system_parts = Vec::new();
    let mut payload_messages = Vec::new();
    // Chat Completions 的 tool 消息 content 只接受字符串（DeepSeek 等严格
    // 实现对数组 content 报 "Invalid input"），因此工具结果里的图片不能附
    // 在 tool 消息上。它们先累积在这里，在该 assistant 的全部 tool 消息
    // 发完（遇下一条非 tool 消息）后作为一条 user 多模态消息发出——配对
    // 顺序 assistant(tool_calls) → tool×N → user(images) 是合法形态。
    let mut pending_tool_image_parts: Vec<Value> = Vec::new();

    let last_message_index = messages.len().saturating_sub(1);
    for (message_index, message) in messages.iter().enumerate() {
        let content = message.content.trim();
        let role = message.role.trim();
        let is_last_message = message_index == last_message_index;

        // Flush accumulated tool-result images before any non-tool message:
        // the synthetic user message must come after ALL tool replies of the
        // same assistant turn to keep tool_call_id pairing consecutive.
        if role != "tool" {
            flush_tool_image_parts(&mut payload_messages, &mut pending_tool_image_parts);
        }

        // --- Tool result messages: emit as role "tool" with tool_call_id ---
        if role == "tool" {
            // tool 消息的正文在 tool_results_json（content 列只是摘要）：
            // 两者皆空才跳过。仅判 content 会把图片-only 的工具结果整条
            // 丢弃，断裂 tool 配对并触发上游 "missing tool_call_id" 400。
            if content.is_empty()
                && message
                    .tool_results_json
                    .as_deref()
                    .map(|raw| raw.is_empty() || raw == "{}")
                    .unwrap_or(true)
            {
                continue;
            }
            let results = match message.tool_results_json {
                Some(ref raw) => {
                    crate::api::conversation::tool_messages::parse_tool_results_with_images(
                        raw,
                        database_path,
                        skip_image_parsing,
                    )
                }
                None => Vec::new(),
            };
            // 无结构化结果的 tool 行否则整条被丢（含正文）：末条时前一条
            // assistant 会成为请求尾轮，上游直接 400 "Requests ending with
            // a model turn"。此处把正文降级为一条 user 消息保留上下文。
            if results.is_empty() {
                if is_last_message && !content.is_empty() {
                    payload_messages.push(json!({
                        "role": "user",
                        "content": build_chat_content(content, database_path, skip_image_parsing)?,
                    }));
                }
                continue;
            }
            for tool_result in &results {
                let text = if tool_result.text.is_empty() && !tool_result.images.is_empty() {
                    "[image attached]".to_string()
                } else {
                    tool_result.text.clone()
                };
                if tool_result.call_id.is_empty() {
                    // No paired call: emit text and images as a single user
                    // message with multimodal content blocks.
                    if tool_result.images.is_empty() {
                        payload_messages.push(json!({
                            "role": "user",
                            "content": text,
                        }));
                    } else {
                        let mut parts = Vec::new();
                        if !text.is_empty() {
                            parts.push(json!({ "type": "text", "text": text }));
                        }
                        parts.extend(tool_result.images.iter().map(|image| {
                            json!({
                                "type": "image_url",
                                "image_url": { "url": image.data_url },
                            })
                        }));
                        payload_messages.push(json!({
                            "role": "user",
                            "content": parts,
                        }));
                    }
                } else {
                    // Chat Completions 的 tool 消息 content 只接受字符串：
                    // DeepSeek 等严格实现对数组 content（含 image_url block）
                    // 报 400 "Invalid input"（param=messages.N.content）。
                    // 图片改入 pending 缓冲，随后作为一条 user 多模态消息
                    // 发出；tool 消息本身携带文本占位，保持 tool_call_id
                    // 配对完整。
                    for image in &tool_result.images {
                        pending_tool_image_parts.push(json!({
                            "type": "image_url",
                            "image_url": { "url": image.data_url },
                        }));
                    }
                    payload_messages.push(json!({
                        "role": "tool",
                        "tool_call_id": tool_result.call_id,
                        "content": text,
                    }));
                }
            }
            continue;
        }

        if content.is_empty() && message.tool_calls_json.is_none() {
            continue;
        }

        // --- Assistant messages with tool_calls ---
        if role == "assistant" {
            if let Some(ref tool_calls_raw) = message.tool_calls_json {
                // Normalize stored tool calls (any provider format — notably
                // OpenAI Responses `function_call` items) into the Chat
                // Completions shape. Passing them through verbatim makes the
                // endpoint reject the request with
                // `unknown variant function_call, expected function` when a
                // Responses-model conversation is continued with a Chat model
                // (issue #26).
                let tool_calls =
                    crate::api::conversation::tool_messages::tool_calls_as_chat_completions(
                        tool_calls_raw,
                    );
                if !tool_calls.is_empty() {
                    let mut assistant_msg = json!({
                        "role": "assistant",
                        "tool_calls": tool_calls,
                    });
                    if !content.is_empty() {
                        assistant_msg["content"] = json!(content);
                    } else {
                        assistant_msg["content"] = Value::Null;
                    }
                    // Round-trip reasoning_content for DeepSeek/OpenAI
                    // thinking models so the AI retains its prior
                    // reasoning across turns. DeepSeek V4 thinking mode
                    // (enabled by default) REQUIRES this field on every
                    // assistant message that carries tool_calls whenever
                    // the request also carries `tools` — a missing field
                    // yields a 400 "The reasoning_content in the thinking
                    // mode must be passed back to the API". An empty
                    // string is accepted when the turn produced no
                    // reasoning text.
                    assistant_msg["reasoning_content"] =
                        json!(message.thinking.as_deref().unwrap_or(""));
                    payload_messages.push(assistant_msg);
                    continue;
                }
            }
        }

        // --- System/developer messages ---
        if role == "system" || role == "developer" {
            if content.is_empty() {
                continue;
            }
            // Collect built-in system prompt parts; they will be emitted
            // either as a `system` message (no user prompts) or demoted to
            // a leading `user` message (user prompts present), matching
            // Snow CLI PR #127.
            builtin_system_parts.push(content.to_string());
            continue;
        }

        // --- Regular user/assistant messages ---
        if content.is_empty() {
            continue;
        }
        let content = build_chat_content(content, database_path, skip_image_parsing)?;

        let mut msg = json!({
            "role": normalize_message_role(role),
            "content": content,
        });
        // Round-trip reasoning_content for DeepSeek/OpenAI thinking models
        // so the AI retains its prior reasoning across turns.
        if role == "assistant" {
            if let Some(ref thinking) = message.thinking {
                if !thinking.is_empty() {
                    msg["reasoning_content"] = json!(thinking);
                }
            }
        }
        payload_messages.push(msg);
    }

    flush_tool_image_parts(&mut payload_messages, &mut pending_tool_image_parts);

    // Only actual user-configured prompts trigger built-in demotion. Host
    // facts and internal recovery remain in the system slot in either branch.
    let mut system_parts = if has_user_system_prompts {
        if !builtin_system_parts.is_empty() {
            payload_messages.insert(
                0,
                json!({
                    "role": "user", "content": builtin_system_parts.join("\n\n")
                }),
            );
        }
        user_system_prompts.to_vec()
    } else {
        builtin_system_parts
    };
    system_parts.extend(host_system_prompts.iter().cloned());
    let recovery_prompt = request
        .internal_recovery_prompt
        .as_deref()
        .map(str::trim)
        .filter(|prompt| !prompt.is_empty());
    if let Some(prompt) = recovery_prompt {
        system_parts.push(prompt.to_string());
    }
    if !system_parts.is_empty() {
        // Keep ordinary parent system content a string, including host facts.
        let content = if !has_user_system_prompts && recovery_prompt.is_none() {
            json!(system_parts.join("\n\n"))
        } else {
            json!(system_parts
                .iter()
                .map(|text| json!({ "type": "text", "text": text }))
                .collect::<Vec<_>>())
        };
        payload_messages.insert(0, json!({ "role": "system", "content": content }));
    }

    if payload_messages.is_empty() {
        return Err(Error::from_reason("Chat message content is required"));
    }

    let mut payload = json!({
        "model": model,
        "messages": payload_messages,
        "stream": true,
        "stream_options": {
            "include_usage": true,
        },
    });

    if let Some(max_tokens) = api_config.max_tokens {
        if max_tokens > 0 {
            payload["max_tokens"] = json!(max_tokens);
        }
    }

    if let Some(reasoning_effort) = build_chat_reasoning_effort(&api_config.config_json) {
        payload["reasoning_effort"] = json!(reasoning_effort);
    }

    if let Some(tools) = tools {
        if tools.as_array().is_some_and(|items| !items.is_empty()) {
            payload["tools"] = tools;
        }
    }

    Ok(payload)
}

/// 构建一条文本消息的 content 值。
///
/// 解析后为空的标签消息（如空 `@@command:` / `@@review:`）用原始文本兜底：
/// 空 user 轮会被上游丢弃，丢弃后前一条 assistant 成为尾轮，Gemini 以
/// "Requests ending with a model turn" 400 拒绝。
fn build_chat_content(
    content: &str,
    database_path: &Path,
    skip_image_parsing: bool,
) -> Result<Value> {
    if skip_image_parsing {
        return Ok(Value::String(content.to_string()));
    }
    let ParsedChatMessageContent { text, images } =
        parse_chat_message_content(content, database_path)?;
    let text = if text.is_empty() {
        content.to_string()
    } else {
        text
    };
    if images.is_empty() {
        return Ok(Value::String(text));
    }
    let mut parts = Vec::new();
    if !text.is_empty() {
        parts.push(json!({ "type": "text", "text": text }));
    }
    parts.extend(images.iter().map(|image| {
        json!({
            "type": "image_url",
            "image_url": { "url": image.data_url },
        })
    }));
    Ok(Value::Array(parts))
}

/// Flush accumulated tool-result image parts as one synthetic user message.
///
/// Chat Completions 的 tool 消息 content 只接受字符串，工具结果里的图片
/// 因此暂存在 `pending` 中；等该 assistant 回合的全部 tool 消息发完后，
/// 以一条 user 多模态消息统一发出，保持 tool_call_id 配对连续。
/// 用 `std::mem::take` 转移所有权，避免对含 base64 的大 part 做深拷贝。
fn flush_tool_image_parts(payload_messages: &mut Vec<Value>, pending: &mut Vec<Value>) {
    if pending.is_empty() {
        return;
    }
    payload_messages.push(json!({
        "role": "user",
        "content": std::mem::take(pending),
    }));
}

fn normalize_message_role(role: &str) -> &str {
    match role.trim() {
        "assistant" => "assistant",
        "system" => "system",
        "developer" => "developer",
        _ => "user",
    }
}

pub fn build_chat_reasoning_effort(config_json: &str) -> Option<String> {
    let parsed = serde_json::from_str::<Value>(config_json).ok()?;
    let chat_thinking = parsed.get("snowcfg")?.get("chatThinking")?.as_object()?;
    let enabled = chat_thinking
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    if !enabled {
        return None;
    }

    chat_thinking
        .get("reasoning_effort")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "none")
        .map(ToString::to_string)
}
