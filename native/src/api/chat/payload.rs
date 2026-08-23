//! Chat Completions payload construction and endpoint resolution.

use std::path::Path;

use napi::bindgen_prelude::*;
use serde_json::{json, Value};

use crate::api::config::{normalize_base_url, resolve_advanced_model, resolve_sdk_api_base_url};
use crate::api::conversation::parse_chat_message_content;
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
) -> Result<Value> {
    let model =
        resolve_advanced_model(request.model.as_deref(), &api_config.advanced_model)?;

    let skip_image_parsing = request.skip_context.unwrap_or(false);
    let has_user_system_prompts = !user_system_prompts.is_empty();
    let mut builtin_system_parts = Vec::new();
    let mut payload_messages = Vec::new();

    for message in messages {
        let content = message.content.trim();
        let role = message.role.trim();

        // --- Tool result messages: emit as role "tool" with tool_call_id ---
        if role == "tool" {
            if content.is_empty() {
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
                    // Chat Completions `tool` messages only accept a plain
                    // string content, so the screenshot base64 must travel in
                    // a following structured user message as image_url blocks.
                    payload_messages.push(json!({
                        "role": "tool",
                        "tool_call_id": tool_result.call_id,
                        "content": text,
                    }));
                    if !tool_result.images.is_empty() {
                        let mut parts = Vec::new();
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
        let content = if skip_image_parsing {
            Value::String(content.to_string())
        } else {
            let parsed_content = parse_chat_message_content(content, database_path)?;
            if parsed_content.images.is_empty() {
                Value::String(parsed_content.text)
            } else {
                let mut parts = Vec::new();
                if !parsed_content.text.is_empty() {
                    parts.push(json!({ "type": "text", "text": parsed_content.text }));
                }
                parts.extend(parsed_content.images.iter().map(|image| {
                    json!({
                        "type": "image_url",
                        "image_url": { "url": image.data_url },
                    })
                }));
                Value::Array(parts)
            }
        };

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

    // When user system prompts are present, emit them as a single `system`
    // message with multiple content blocks and demote the built-in prompt
    // to a leading `user` message (Snow CLI PR #127).
    if has_user_system_prompts
        || request
            .internal_recovery_prompt
            .as_deref()
            .is_some_and(|prompt| !prompt.trim().is_empty())
    {
        let mut user_prompt_blocks: Vec<Value> = user_system_prompts
            .iter()
            .map(|text| json!({ "type": "text", "text": text }))
            .collect();
        if let Some(prompt) = request
            .internal_recovery_prompt
            .as_deref()
            .map(str::trim)
            .filter(|prompt| !prompt.is_empty())
        {
            user_prompt_blocks.push(json!({ "type": "text", "text": prompt }));
        }
        let system_message = json!({
            "role": "system",
            "content": user_prompt_blocks,
        });
        payload_messages.insert(0, system_message);

        if !builtin_system_parts.is_empty() {
            let builtin_text = builtin_system_parts.join("\n\n");
            let builtin_message = json!({
                "role": "user",
                "content": builtin_text,
            });
            payload_messages.insert(1, builtin_message);
        }
    } else if !builtin_system_parts.is_empty() {
        // No user prompts: keep built-in prompt as a `system` message.
        let builtin_text = builtin_system_parts.join("\n\n");
        let system_message = json!({
            "role": "system",
            "content": builtin_text,
        });
        payload_messages.insert(0, system_message);
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

fn normalize_message_role(role: &str) -> &str {
    match role.trim() {
        "assistant" => "assistant",
        "system" => "system",
        "developer" => "developer",
        _ => "user",
    }
}

pub(crate) fn build_chat_reasoning_effort(config_json: &str) -> Option<String> {
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
