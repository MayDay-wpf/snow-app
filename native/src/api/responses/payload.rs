//! Responses API payload construction and endpoint/client resolution.

use std::collections::HashMap;
use std::path::Path;

use napi::bindgen_prelude::*;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT_ENCODING, AUTHORIZATION, CONTENT_TYPE};
use serde_json::{json, Value};

use crate::api::common::inject_custom_headers;
use crate::api::config::{normalize_base_url, resolve_sdk_api_base_url};
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
) -> Result<Value> {
    let model = request
        .model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| api_config.advanced_model.trim());

    if model.is_empty() {
        return Err(Error::from_reason(
            "Model not configured. Please select or configure a model first.",
        ));
    }

    let skip_image_parsing = request.skip_context.unwrap_or(false);
    let mut builtin_system_parts = Vec::new();
    let mut input = Vec::new();

    for message in messages {
        let content = message.content.trim();
        let role = message.role.trim();

        // --- Tool result messages: emit as function_call_output items ---
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
                let text = if tool_result.text.is_empty() {
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
                    // function_call_output only accepts a plain string, so the
                    // screenshot base64 must travel in a following structured
                    // user message as input_image blocks.
                    input.push(json!({
                        "type": "function_call_output",
                        "call_id": tool_result.call_id,
                        "output": text,
                    }));
                    if !tool_result.images.is_empty() {
                        let image_blocks: Vec<Value> = tool_result
                            .images
                            .iter()
                            .map(|image| {
                                json!({
                                    "type": "input_image",
                                    "image_url": image.data_url,
                                })
                            })
                            .collect();
                        input.push(json!({
                            "type": "message",
                            "role": "user",
                            "content": image_blocks,
                        }));
                    }
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

        let has_images = !skip_image_parsing
            && parse_chat_message_content(content, database_path)
                .map(|p| !p.images.is_empty())
                .unwrap_or(false);

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
            if skip_image_parsing || !has_images {
                let block_type = if role == "assistant" {
                    "output_text"
                } else {
                    "input_text"
                };
                content_blocks.push(json!({"type": block_type, "text": content}));
            } else {
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

    // Add prompt_cache_key using conversation_id so the Responses API can
    // reuse cached prompt prefixes across turns within the same conversation.
    // Matches snow-cli's behavior of passing prompt_cache_key in the payload.
    if let Some(ref conv_id) = request.conversation_id {
        if !conv_id.is_empty() {
            payload["prompt_cache_key"] = json!(conv_id);
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
    let enabled = parsed.get("snowcfg")?.get("responsesFastMode")?.as_bool()?;

    enabled.then_some("priority")
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
    use super::{build_responses_service_tier, build_responses_text_config};
    use serde_json::json;

    #[test]
    fn builds_responses_text_verbosity() {
        for verbosity in ["low", "medium", "high"] {
            let config_json = json!({
                "snowcfg": {
                    "responsesVerbosity": verbosity,
                }
            })
            .to_string();

            assert_eq!(
                build_responses_text_config(&config_json),
                Some(json!({ "verbosity": verbosity }))
            );
        }
    }

    #[test]
    fn ignores_invalid_responses_text_verbosity() {
        for config_json in [
            r#"{"snowcfg":{"responsesVerbosity":""}}"#,
            r#"{"snowcfg":{"responsesVerbosity":"verbose"}}"#,
            r#"{"snowcfg":{"responsesVerbosity":true}}"#,
            r#"{"snowcfg":{}}"#,
            "not-json",
        ] {
            assert_eq!(build_responses_text_config(config_json), None);
        }
    }

    #[test]
    fn enables_responses_fast_mode_as_priority_tier() {
        let config_json = r#"{"snowcfg":{"responsesFastMode":true}}"#;

        assert_eq!(build_responses_service_tier(config_json), Some("priority"));
    }

    #[test]
    fn omits_service_tier_when_fast_mode_is_disabled() {
        for config_json in [
            r#"{"snowcfg":{"responsesFastMode":false}}"#,
            r#"{"snowcfg":{"responsesFastMode":"true"}}"#,
            r#"{"snowcfg":{}}"#,
            "not-json",
        ] {
            assert_eq!(build_responses_service_tier(config_json), None);
        }
    }

    #[test]
    fn supports_legacy_config_without_responses_options() {
        let config_json = r#"{
            "snowcfg": {
                "requestMethod": "responses",
                "responsesReasoning": {
                    "enabled": true,
                    "effort": "high"
                },
                "legacyProviderOption": "keep"
            },
            "legacyTopLevel": {
                "enabled": true
            }
        }"#;

        assert_eq!(build_responses_text_config(config_json), None);
        assert_eq!(build_responses_service_tier(config_json), None);
    }
}
