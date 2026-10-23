//! Responses API payload construction and endpoint/client resolution.

use std::collections::HashMap;
use std::path::Path;

use napi::bindgen_prelude::*;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT_ENCODING, AUTHORIZATION, CONTENT_TYPE};
use serde_json::{json, Value};

use crate::api::common::inject_custom_headers;
use crate::api::config::{normalize_base_url, resolve_advanced_model, resolve_sdk_api_base_url};
use crate::api::conversation::parse_chat_message_content;
use crate::api::responses::ResponsesApiRequest;
use crate::storage::services::chat_conversations::ChatContextMessage;
use crate::storage::ApiConfigRecord;

/// Resolve the full HTTP endpoint URL for a Responses API request.
///
/// Mirrors `resolve_chat_completions_endpoint` in the Chat module: when the
/// configured base URL is an explicit endpoint (`base_url_mode == "endpoint"`),
/// it is used verbatim; otherwise the SDK base URL is combined with the
/// `/responses` suffix.
pub(super) fn resolve_responses_endpoint(api_config: &ApiConfigRecord) -> String {
    let normalized_base_url = normalize_base_url(&api_config.base_url);
    if normalized_base_url.is_empty() {
        return normalized_base_url;
    }

    if api_config.base_url_mode == "endpoint" {
        normalized_base_url
    } else {
        format!(
            "{}/responses",
            resolve_sdk_api_base_url(&normalized_base_url, &api_config.base_url_mode)
        )
    }
}

pub(super) fn build_responses_payload(
    messages: &[ChatContextMessage],
    database_path: &Path,
    request: &ResponsesApiRequest,
    api_config: &ApiConfigRecord,
    tools: Option<Value>,
    user_system_prompts: &[String],
    cache_key: &str,
) -> Result<Value> {
    let model =
        resolve_advanced_model(request.model.as_deref(), &api_config.advanced_model)?;

    let skip_image_parsing = request.skip_context.unwrap_or(false);
    let mut builtin_system_parts = Vec::new();
    let mut input = Vec::new();

    for message in messages {
        let content = message.content.trim();
        let role = message.role.trim();

        // --- Tool result messages: emit as function_call_output items ---
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
                    let mut content_blocks = Vec::new();
                    if !text.is_empty() {
                        content_blocks.push(json!({"type": "input_text", "text": text}));
                    }
                    content_blocks.extend(tool_result.images.iter().map(|image| {
                        json!({
                            "type": "input_image",
                            "image_url": image.data_url,
                        })
                    }));
                    input.push(json!({
                        "type": "message",
                        "role": "user",
                        "content": content_blocks,
                    }));
                } else {
                    // Responses supports multimodal function outputs. Keep each
                    // image with its call instead of inserting user messages
                    // between the outputs of parallel tool calls.
                    let output = if tool_result.images.is_empty() {
                        json!(text)
                    } else {
                        let mut parts = Vec::with_capacity(tool_result.images.len() + 1);
                        parts.push(json!({"type": "input_text", "text": text}));
                        parts.extend(tool_result.images.iter().map(|image| {
                            json!({
                                "type": "input_image",
                                "image_url": image.data_url,
                            })
                        }));
                        json!(parts)
                    };
                    input.push(json!({
                        "type": "function_call_output",
                        "call_id": tool_result.call_id,
                        "output": output,
                    }));
                }
            }
            continue;
        }

        let has_thinking = message
            .thinking
            .as_deref()
            .map(|t| !t.is_empty())
            .unwrap_or(false);

        // Parse persisted reasoning items (with encrypted_content) so they
        // can be emitted as independent top-level items. store:false means
        // the server does not retain reasoning, so we must round-trip it.
        let reasoning_items: Vec<Value> = message
            .thinking_blocks_json
            .as_deref()
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            .and_then(|v| v.as_array().map(|a| a.clone()))
            .unwrap_or_default();
        let has_reasoning = !reasoning_items.is_empty();

        if content.is_empty()
            && message.tool_calls_json.is_none()
            && !has_thinking
            && !has_reasoning
        {
            continue;
        }

        // --- Assistant messages with tool_calls: emit as function_call items ---
        if role == "assistant" {
            if let Some(ref tool_calls_raw) = message.tool_calls_json {
                if let Ok(parsed) = serde_json::from_str::<Value>(tool_calls_raw) {
                    if let Some(calls) = parsed.as_array() {
                        if !calls.is_empty() {
                            // Emit persisted reasoning items as independent
                            // top-level items before the assistant message.
                            for item in &reasoning_items {
                                input.push(item.clone());
                            }
                            // Emit assistant message with text content.
                            if !content.is_empty() {
                                input.push(json!({
                                    "type": "message",
                                    "role": "assistant",
                                    "content": [{"type": "output_text", "text": content}],
                                }));
                            }
                            // Emit each tool call as a function_call item.
                            // Handles both Responses flat format (call_id /
                            // name / arguments at top level) and Chat
                            // Completions nested format (id / function.name /
                            // function.arguments).
                            for call in calls {
                                let call_id = call
                                    .get("call_id")
                                    .and_then(Value::as_str)
                                    .or_else(|| call.get("id").and_then(Value::as_str))
                                    .unwrap_or("")
                                    .to_string();
                                let name = call
                                    .get("name")
                                    .and_then(Value::as_str)
                                    .or_else(|| {
                                        call.get("function")
                                            .and_then(|f| f.get("name"))
                                            .and_then(Value::as_str)
                                    })
                                    .unwrap_or("")
                                    .to_string();
                                let arguments = call
                                    .get("arguments")
                                    .and_then(Value::as_str)
                                    .or_else(|| {
                                        call.get("function")
                                            .and_then(|f| f.get("arguments"))
                                            .and_then(Value::as_str)
                                    })
                                    .unwrap_or("{}")
                                    .to_string();
                                input.push(json!({
                                    "type": "function_call",
                                    "call_id": call_id,
                                    "name": name,
                                    "arguments": arguments,
                                }));
                            }
                            continue;
                        }
                    }
                }
            }
        }

        // --- System/developer messages: collect into instructions ---
        if role == "system" || role == "developer" {
            if content.is_empty() {
                continue;
            }
            builtin_system_parts.push(content.to_string());
            continue;
        }

        // --- Regular user/assistant messages ---
        if content.is_empty() && !has_thinking && !has_reasoning {
            continue;
        }

        // Emit persisted reasoning items as independent top-level items
        // before the assistant message (store:false requires manual
        // round-trip of encrypted_content).
        if role == "assistant" {
            for item in &reasoning_items {
                input.push(item.clone());
            }
        }

        // Build content blocks: user uses input_text, assistant uses output_text.
        let mut content_blocks = Vec::new();

        if !content.is_empty() {
            if skip_image_parsing {
                let block_type = if role == "assistant" {
                    "output_text"
                } else {
                    "input_text"
                };
                content_blocks.push(json!({"type": block_type, "text": content}));
            } else {
                // 统一解析消息内容：@@image: 拆分为图片块，
                // @@review: / @@element: / @@conversation: 标签展开为文本
                // （conversation 标签展开为被引用会话的精简对话记录）。
                // 不能像旧实现那样仅在含图片时解析——否则无图消息里的
                // 标签会原样进入请求。
                let parsed_content = parse_chat_message_content(content, database_path)?;
                if !parsed_content.text.is_empty() {
                    let block_type = if role == "assistant" {
                        "output_text"
                    } else {
                        "input_text"
                    };
                    content_blocks.push(json!({"type": block_type, "text": parsed_content.text}));
                }
                for image in &parsed_content.images {
                    content_blocks.push(json!({
                        "type": "input_image",
                        "image_url": image.data_url,
                    }));
                }
            }
        }

        // 解析后无任何内容块（如整条消息只有一个渲染为空的引用会话标签）：
        // 跳过该消息，避免向 API 推送空内容块。
        if content_blocks.is_empty() && !content.is_empty() {
            continue;
        }

        input.push(json!({
            "type": "message",
            "role": normalize_message_role(role),
            "content": content_blocks,
        }));
    }

    // Build `instructions` field. User-configured system prompts take
    // precedence; otherwise the built-in system prompt parts are used. When
    // user system prompts are present, the built-in prompt is demoted to a
    // leading user message (Snow CLI PR #127).
    let mut instructions: Option<String> = None;
    if !user_system_prompts.is_empty() {
        instructions = Some(user_system_prompts.join("\n\n"));

        if !builtin_system_parts.is_empty() {
            let builtin_text = builtin_system_parts.join("\n\n");
            let builtin_message = json!({
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": builtin_text}],
            });
            input.insert(0, builtin_message);
        }
    } else if !builtin_system_parts.is_empty() {
        instructions = Some(builtin_system_parts.join("\n\n"));
    }
    if let Some(prompt) = request
        .internal_recovery_prompt
        .as_deref()
        .map(str::trim)
        .filter(|prompt| !prompt.is_empty())
    {
        instructions = Some(match instructions {
            Some(existing) => format!("{existing}\n\n{prompt}"),
            None => prompt.to_string(),
        });
    }

    if input.is_empty() {
        return Err(Error::from_reason("Chat message content is required"));
    }

    let mut payload = json!({
        "model": model,
        "input": input,
        "stream": true,
        "store": false,
        "include": ["reasoning.encrypted_content"],
    });

    if let Some(ref instructions) = instructions {
        payload["instructions"] = json!(instructions);
    }

    if let Some(max_tokens) = api_config.max_tokens {
        if max_tokens > 0 {
            payload["max_output_tokens"] = json!(max_tokens);
        }
    }

    if let Some(reasoning) = build_responses_reasoning(&api_config.config_json) {
        payload["reasoning"] = reasoning;
    }

    if let Some(text) = build_responses_text_config(&api_config.config_json) {
        payload["text"] = text;
    }

    if let Some(service_tier) = build_responses_service_tier(&api_config.config_json) {
        payload["service_tier"] = json!(service_tier);
    }

    if let Some(tools) = tools {
        if tools.as_array().is_some_and(|items| !items.is_empty()) {
            payload["tools"] = tools;
        }
    }

    // Use the resolved conversation ID so the first main request is cacheable too.
    if !cache_key.is_empty() {
        payload["prompt_cache_key"] = json!(cache_key);
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

pub(crate) fn build_responses_reasoning(config_json: &str) -> Option<Value> {
    let parsed = serde_json::from_str::<Value>(config_json).ok()?;
    let responses_reasoning = parsed
        .get("snowcfg")?
        .get("responsesReasoning")?
        .as_object()?;

    let enabled = responses_reasoning
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    if !enabled {
        return None;
    }

    let effort = responses_reasoning
        .get("effort")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "none")?;

    Some(json!({
        "effort": effort,
        "summary": "auto",
    }))
}

fn build_responses_text_config(config_json: &str) -> Option<Value> {
    let parsed = serde_json::from_str::<Value>(config_json).ok()?;
    let verbosity = parsed
        .get("snowcfg")?
        .get("responsesVerbosity")?
        .as_str()?
        .trim();

    match verbosity {
        "low" | "medium" | "high" => Some(json!({
            "verbosity": verbosity,
        })),
        _ => None,
    }
}

fn build_responses_service_tier(config_json: &str) -> Option<&'static str> {
    let parsed = serde_json::from_str::<Value>(config_json).ok()?;
    let tier = match parsed.get("snowcfg")?.get("responsesFastMode")? {
        Value::Bool(true) => "fast",
        Value::String(text) => text.trim(),
        _ => return None,
    };

    match tier {
        "fast" => Some("priority"),
        "ultrafast" => Some("ultrafast"),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// HTTP header building
// ---------------------------------------------------------------------------

/// Build the HTTP header map for a Responses API request.
///
/// Sets `Authorization: Bearer` plus user-supplied custom headers (except
/// `authorization`, `content-type`, and `accept-encoding` which are
/// reserved).
pub(super) fn build_header_map(
    api_key: &str,
    custom_headers: &HashMap<String, String>,
) -> Result<HeaderMap> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(ACCEPT_ENCODING, HeaderValue::from_static("identity"));
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {}", api_key)).map_err(|error| {
            Error::from_reason(format!("Invalid authorization header value: {}", error))
        })?,
    );

    inject_custom_headers(
        &mut headers,
        custom_headers,
        &["content-type", "accept-encoding", "authorization"],
    )?;

    Ok(headers)
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let mut assistant = message("assistant", "");
        assistant.tool_calls_json = Some(
            json!(call_ids
                .iter()
                .map(|call_id| json!({
                    "type": "function_call",
                    "call_id": call_id,
                    "name": "read",
                    "arguments": "{}",
                }))
                .collect::<Vec<_>>())
            .to_string(),
        );
        assistant
    }

    fn tool_message(results: Value) -> ChatContextMessage {
        // Image-only tool messages can have an empty content summary.
        let mut tool = message("tool", "");
        tool.tool_results_json = Some(results.to_string());
        tool
    }

    fn screenshot_result(label: &str) -> String {
        format!("{{\"text\":\"{label}\"}}\n@@image:data:image/png;base64,{TINY_PNG_BASE64}@@")
    }

    fn build_payload(messages: &[ChatContextMessage], skip_context: bool) -> Value {
        let request = ResponsesApiRequest {
            messages: Vec::new(),
            model: Some("test-model".to_string()),
            api_profile: None,
            conversation_id: None,
            previous_response_id: None,
            directory_id: None,
            analysis_workspace_root: None,
            execution_workspace_root: None,
            worktree_id: None,
            checkpoint_id: None,
            context_compaction: None,
            resume_after_compaction: None,
            sub_agent_tools_json: None,
            sub_agent_system_prompt: None,
            sub_agent_config_profile: None,
            skip_context: Some(skip_context),
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
            remote_override_builtin_prompt: None,
            allowed_tools_json: None,
        };
        let api_config = ApiConfigRecord {
            id: "1".to_string(),
            profile_name: "test".to_string(),
            display_name: "Test".to_string(),
            is_active: true,
            base_url: "http://localhost".to_string(),
            base_url_mode: "default".to_string(),
            api_key: String::new(),
            request_method: "responses".to_string(),
            advanced_model: "test-model".to_string(),
            basic_model: "test-model".to_string(),
            supports_vision: true,
            vision_base_url: String::new(),
            vision_base_url_mode: "default".to_string(),
            vision_api_key: String::new(),
            vision_request_method: "chat".to_string(),
            vision_model: String::new(),
            max_context_tokens: None,
            max_tokens: None,
            stream_idle_timeout_sec: None,
            enable_auto_compress: false,
            auto_compress_threshold: None,
            max_retries: None,
            retry_base_delay_ms: None,
            partial_retry_max_chars: None,
            system_prompt_ids_json: "[]".to_string(),
            custom_header_scheme_id: String::new(),
            config_json: "{}".to_string(),
            source: "manual".to_string(),
            sort_order: 0,
            updated_at: String::new(),
        };
        build_responses_payload(
            messages,
            Path::new(""),
            &request,
            &api_config,
            None,
            &[],
            "",
        )
        .unwrap()
    }

    #[test]
    fn parallel_image_results_stay_inside_their_matching_outputs() {
        // Cover results persisted both together and in separate tool messages.
        for separate_messages in [false, true] {
            let results = vec![
                json!({"name": "read", "callId": "call_a", "result": screenshot_result("first")}),
                json!({"name": "read", "callId": "call_b", "result": screenshot_result("second")}),
            ];
            let mut messages = vec![
                message("user", "read images"),
                assistant_with_calls(&["call_a", "call_b"]),
            ];
            if separate_messages {
                messages.extend(
                    results
                        .into_iter()
                        .map(|result| tool_message(json!([result]))),
                );
            } else {
                messages.push(tool_message(json!(results)));
            }
            messages.push(message("assistant", "done"));
            let payload = build_payload(&messages, false);
            let input = payload["input"].as_array().unwrap();
            let types: Vec<_> = input
                .iter()
                .map(|item| item["type"].as_str().unwrap())
                .collect();
            assert_eq!(
                types,
                vec![
                    "message",
                    "function_call",
                    "function_call",
                    "function_call_output",
                    "function_call_output",
                    "message"
                ]
            );
            for (index, call_id, label) in [(3, "call_a", "first"), (4, "call_b", "second")] {
                assert_eq!(input[index]["call_id"], call_id);
                assert_eq!(
                    input[index]["output"],
                    json!([
                        {"type": "input_text", "text": format!("{{\"text\":\"{label}\"}}\n[Image #1]")},
                        {"type": "input_image", "image_url": format!("data:image/png;base64,{TINY_PNG_BASE64}")},
                    ])
                );
            }
        }
    }

    #[test]
    fn multiple_images_remain_in_one_tool_output() {
        let result = format!(
            "{}\n@@image:data:image/png;base64,{TINY_PNG_BASE64}@@",
            screenshot_result("two images")
        );
        let payload = build_payload(
            &[
                assistant_with_calls(&["call_a"]),
                tool_message(json!([{"name": "read", "callId": "call_a", "result": result}])),
            ],
            false,
        );
        let input = payload["input"].as_array().unwrap();
        assert_eq!(input.len(), 2);
        let parts = input[1]["output"].as_array().unwrap();
        assert_eq!(parts.len(), 3);
        for part in &parts[1..] {
            assert_eq!(part["type"], "input_image");
            assert_eq!(
                part["image_url"],
                format!("data:image/png;base64,{TINY_PNG_BASE64}")
            );
        }
    }

    #[test]
    fn text_only_results_keep_string_outputs_in_mixed_batches() {
        let payload = build_payload(
            &[
                assistant_with_calls(&["call_a", "call_b"]),
                tool_message(json!([
                    {"name": "read", "callId": "call_a", "result": "file contents"},
                    {"name": "read", "callId": "call_b", "result": screenshot_result("image")},
                ])),
            ],
            false,
        );
        let input = payload["input"].as_array().unwrap();
        assert_eq!(input.len(), 4);
        assert_eq!(
            input[2],
            json!({"type": "function_call_output", "call_id": "call_a", "output": "file contents"})
        );
        assert!(input[3]["output"].is_array());
    }

    #[test]
    fn call_less_images_still_fall_back_to_a_user_message() {
        let payload = build_payload(
            &[tool_message(
                json!([{"name": "read", "callId": "", "result": screenshot_result("unpaired")}]),
            )],
            false,
        );
        assert_eq!(
            payload["input"],
            json!([{
                "type": "message", "role": "user", "content": [
                    {"type": "input_text", "text": "{\"text\":\"unpaired\"}\n[Image #1]"},
                    {"type": "input_image", "image_url": format!("data:image/png;base64,{TINY_PNG_BASE64}")},
                ],
            }])
        );
    }

    #[test]
    fn skip_context_keeps_image_tags_as_literal_text() {
        let result = screenshot_result("literal");
        let payload = build_payload(
            &[
                assistant_with_calls(&["call_a"]),
                tool_message(json!([{"name": "read", "callId": "call_a", "result": result}])),
            ],
            true,
        );
        assert_eq!(
            payload["input"][1],
            json!({
                "type": "function_call_output", "call_id": "call_a", "output": result,
            })
        );
        assert_eq!(payload["input"].as_array().unwrap().len(), 2);
    }
}
