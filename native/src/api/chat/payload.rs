//! Chat Completions payload construction and endpoint resolution.

use std::path::Path;

use napi::bindgen_prelude::*;
use serde_json::{json, Value};

use crate::api::config::{normalize_base_url, resolve_advanced_model, resolve_sdk_api_base_url};
use crate::api::conversation::parse_chat_message_content;
use crate::api::conversation::resolve_effective_max_tokens;
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
    // Chat Completions 的 tool 消息 content 只接受字符串（DeepSeek 等严格
    // 实现对数组 content 报 "Invalid input"），因此工具结果里的图片不能附
    // 在 tool 消息上。它们先累积在这里，在该 assistant 的全部 tool 消息
    // 发完（遇下一条非 tool 消息）后作为一条 user 多模态消息发出——配对
    // 顺序 assistant(tool_calls) → tool×N → user(images) 是合法形态。
    let mut pending_tool_image_parts: Vec<Value> = Vec::new();

    for message in messages {
        let content = message.content.trim();
        let role = message.role.trim();

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

    flush_tool_image_parts(&mut payload_messages, &mut pending_tool_image_parts);

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

    // Compaction emits a handoff summary, not a full answer: sending the
    // profile's full output budget would both shrink the usable input window
    // at the provider and waste it on a request that only needs a few
    // thousand tokens. Cap it for compaction requests.
    let effective_max_tokens = resolve_effective_max_tokens(
        api_config.max_tokens,
        request.context_compaction.unwrap_or(false),
    );
    if let Some(max_tokens) = effective_max_tokens {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_request() -> ResponsesApiRequest {
        ResponsesApiRequest {
            messages: Vec::new(),
            model: Some("gpt-4o".to_string()),
            api_profile: None,
            conversation_id: None,
            previous_response_id: None,
            directory_id: None,
            checkpoint_id: None,
            context_compaction: None,
            resume_after_compaction: None,
            sub_agent_tools_json: None,
            sub_agent_system_prompt: None,
            sub_agent_config_profile: None,
            skip_context: None,
            disable_tools: None,
            internal_recovery_prompt: None,
            plan_mode: None,
            goal_mode: None,
            worktree_mode: None,
            thinking_strength: None,
            responses_fast_mode: None,
            workflow_mode: None,
            remote_role_content: None,
            remote_include_global_rules: None,
        }
    }

    fn create_test_record() -> ApiConfigRecord {
        ApiConfigRecord {
            id: "1".to_string(),
            profile_name: "default".to_string(),
            display_name: "Default".to_string(),
            is_active: true,
            base_url: "http://localhost".to_string(),
            base_url_mode: "default".to_string(),
            api_key: "test-key".to_string(),
            request_method: "chat".to_string(),
            advanced_model: "gpt-4o".to_string(),
            basic_model: "gpt-4o".to_string(),
            supports_vision: true,
            vision_base_url: "".to_string(),
            vision_base_url_mode: "default".to_string(),
            vision_api_key: "".to_string(),
            vision_request_method: "chat".to_string(),
            vision_model: "".to_string(),
            max_context_tokens: None,
            max_tokens: None,
            stream_idle_timeout_sec: None,
            enable_auto_compress: false,
            auto_compress_threshold: None,
            max_retries: None,
            retry_base_delay_ms: None,
            partial_retry_max_chars: None,
            system_prompt_ids_json: "[]".to_string(),
            custom_header_scheme_id: "".to_string(),
            config_json: "{}".to_string(),
            source: "manual".to_string(),
            updated_at: "".to_string(),
        }
    }

    const TINY_PNG_BASE64: &str =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

    fn message(role: &str, content: &str) -> ChatContextMessage {
        ChatContextMessage {
            role: role.to_string(),
            content: content.to_string(),
            tool_calls_json: None,
            tool_results_json: None,
            thinking: None,
            thinking_blocks_json: None,
        }
    }

    fn assistant_with_calls(call_ids: &[&str]) -> ChatContextMessage {
        let calls: Vec<Value> = call_ids
            .iter()
            .map(|id| {
                json!({
                    "id": id,
                    "type": "function",
                    "function": { "name": "read", "arguments": "{}" }
                })
            })
            .collect();
        ChatContextMessage {
            role: "assistant".to_string(),
            content: String::new(),
            tool_calls_json: Some(Value::Array(calls).to_string()),
            tool_results_json: None,
            thinking: None,
            thinking_blocks_json: None,
        }
    }

    fn tool_message(call_id: &str, result: &str) -> ChatContextMessage {
        ChatContextMessage {
            role: "tool".to_string(),
            content: "tool result summary".to_string(),
            tool_calls_json: None,
            tool_results_json: Some(
                json!([{ "name": "read", "callId": call_id, "result": result }]).to_string(),
            ),
            thinking: None,
            thinking_blocks_json: None,
        }
    }

    /// The exact shape filesystem-read returns for image files
    /// (`{"content":"@@image:...@@","isImage":true}`).
    fn image_tool_message(call_id: &str) -> ChatContextMessage {
        let result = format!(
            "{{\"content\":\"@@image:data:image/png;base64,{}@@\",\"isImage\":true}}",
            TINY_PNG_BASE64
        );
        tool_message(call_id, &result)
    }

    /// The exact shape `browser-screenshot` produces: a JSON body followed by a
    /// trailing `@@image:` tag line. This is the form that triggered the
    /// production 400 `messages.N.content: Invalid input`, so it must stay
    /// covered. Recognized by `has_image_tags` case 1 (trailing tag line whose
    /// prefix parses as JSON).
    fn screenshot_tool_message(call_id: &str) -> ChatContextMessage {
        let result = format!(
            "{{\"content\":[{{\"text\":\"Browser screenshot captured: shot.png (832x1216)\",\"type\":\"text\"}}],\"fullPage\":false}}\n@@image:data:image/png;base64,{}@@",
            TINY_PNG_BASE64
        );
        tool_message(call_id, &result)
    }

    fn build_payload_with_messages(messages: Vec<ChatContextMessage>) -> Value {
        let request = create_test_request();
        let api_record = create_test_record();
        build_chat_completions_payload(&messages, Path::new(""), &request, &api_record, None, &[])
            .unwrap()
    }

    /// The synthesized user message must land only after every tool reply of
    /// the same turn, keeping tool_call_id pairing contiguous (OpenAI requires
    /// each assistant tool_calls message to be immediately followed by the
    /// matching tool messages).
    #[test]
    fn tool_result_images_flush_after_all_tool_replies() {
        let payload = build_payload_with_messages(vec![
            message("user", "read and screenshot"),
            assistant_with_calls(&["call_1", "call_2"]),
            tool_message("call_1", "file contents"),
            image_tool_message("call_2"),
            message("assistant", "done"),
        ]);
        let messages = payload["messages"].as_array().unwrap();
        // user, assistant(+tool_calls), tool, tool, synthetic user, assistant
        assert_eq!(messages.len(), 6);
        assert_eq!(messages[1]["role"], "assistant");
        assert!(messages[1]["tool_calls"].is_array());
        assert_eq!(messages[2]["role"], "tool");
        assert_eq!(messages[3]["role"], "tool");
        assert_eq!(messages[4]["role"], "user");
        assert_eq!(messages[5]["role"], "assistant");

        // Exactly one synthetic user message holds the image.
        let image_messages: Vec<_> = messages
            .iter()
            .filter(|m| m["role"] == "user" && m["content"].is_array())
            .collect();
        assert_eq!(image_messages.len(), 1);
        let parts = image_messages[0]["content"].as_array().unwrap();
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0]["type"], "image_url");
    }

    /// Tool message content stays a plain string so strict providers accept
    /// it; the base64 image never appears inside a tool message.
    #[test]
    fn tool_message_content_is_plain_text() {
        let payload = build_payload_with_messages(vec![
            message("user", "screenshot"),
            assistant_with_calls(&["call_1"]),
            image_tool_message("call_1"),
            message("assistant", "ok"),
        ]);
        let messages = payload["messages"].as_array().unwrap();
        for message in messages.iter().filter(|m| m["role"] == "tool") {
            let content = message["content"].as_str().unwrap();
            assert!(!content.contains("@@image:"));
            assert!(!content.contains(TINY_PNG_BASE64));
        }
    }

    /// Regression for the production 400 `messages.N.content: Invalid input`:
    /// a `browser-screenshot` tool result (JSON body + trailing image tag) must
    /// still hand its image to the synthetic user message while its own content
    /// stays a string. Every message in the payload is additionally checked for
    /// a type the strict endpoint accepts.
    #[test]
    fn screenshot_tool_result_keeps_tool_content_a_string() {
        let payload = build_payload_with_messages(vec![
            message("user", "take a screenshot"),
            assistant_with_calls(&["call_shot"]),
            screenshot_tool_message("call_shot"),
        ]);
        let messages = payload["messages"].as_array().unwrap();

        // Tool messages must carry a plain string: the production 400 was
        // `messages.N.content: Invalid input` caused by an image block array
        // attached to a tool message.
        for entry in messages.iter().filter(|m| m["role"] == "tool") {
            assert!(
                entry["content"].is_string(),
                "tool content must be a string, got {}",
                entry["content"]
            );
        }

        let tool_messages: Vec<_> = messages.iter().filter(|m| m["role"] == "tool").collect();
        assert_eq!(tool_messages.len(), 1);
        let text = tool_messages[0]["content"].as_str().unwrap();
        assert!(!text.contains("@@image:"));
        assert!(!text.contains(TINY_PNG_BASE64));

        // The screenshot itself must survive as a real image block on the
        // synthetic user message.
        let image_parts: Vec<_> = messages
            .iter()
            .filter(|m| m["role"] == "user")
            .filter_map(|m| m["content"].as_array())
            .flatten()
            .filter(|part| part["type"] == "image_url")
            .collect();
        assert_eq!(image_parts.len(), 1);
        assert!(image_parts[0]["image_url"]["url"]
            .as_str()
            .unwrap()
            .starts_with("data:image/png;base64,"));
    }

    /// A turn whose tool results have no images must not gain a synthetic
    /// empty user message.
    #[test]
    fn no_images_means_no_synthetic_user_message() {
        let payload = build_payload_with_messages(vec![
            message("user", "hi"),
            assistant_with_calls(&["call_1", "call_2"]),
            tool_message("call_1", "plain result"),
            tool_message("call_2", "another plain result"),
            message("assistant", "ok"),
        ]);
        let messages = payload["messages"].as_array().unwrap();
        // user, assistant, tool, tool, assistant — no extra message.
        assert_eq!(messages.len(), 5);
        let roles: Vec<_> = messages
            .iter()
            .map(|m| m["role"].as_str().unwrap())
            .collect();
        assert_eq!(roles, vec!["user", "assistant", "tool", "tool", "assistant"]);
    }

    /// If the last message of the request is a tool result with an image, the
    /// trailing flush still emits the synthetic user message.
    #[test]
    fn trailing_tool_image_flushes_at_end() {
        let payload = build_payload_with_messages(vec![
            message("user", "screenshot"),
            assistant_with_calls(&["call_1"]),
            image_tool_message("call_1"),
        ]);
        let messages = payload["messages"].as_array().unwrap();
        let last = messages.last().unwrap();
        assert_eq!(last["role"], "user");
        assert_eq!(last["content"][0]["type"], "image_url");
    }
}
