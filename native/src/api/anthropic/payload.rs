//! Anthropic payload construction and endpoint resolution.

use std::path::Path;

use napi::bindgen_prelude::*;
use serde_json::{json, Value};
use std::sync::OnceLock;
use uuid::Uuid;

use crate::api::config::{
    normalize_base_url, resolve_advanced_model, resolve_sdk_api_base_url,
    DEFAULT_ANTHROPIC_BASE_URL, DEFAULT_OPENAI_BASE_URL,
};
use crate::api::conversation::parse_chat_message_content;
use crate::api::responses::ResponsesApiRequest;
use crate::storage::services::chat_conversations::ChatContextMessage;
use crate::storage::ApiConfigRecord;

/// Process-level persistent Anthropic user_id.
///
/// Mirrors Snow CLI's `getPersistentUserId`: the value is generated once per
/// application session and reused for every request, matching Anthropic's
/// expected `user_<hash>_account__session_<uuid>` format for tracking and
/// prompt-cache routing.
static PERSISTENT_USER_ID: OnceLock<String> = OnceLock::new();

/// Anthropic beta header value that declares 1M-token context support.
///
/// Claude Code 生态约定：模型名带 `[1M]` 后缀（如 `claude-sonnet-4-6[1M]`）
/// 表示该渠道/模型声明 100 万上下文能力。请求上游前需要剥离该本地标记，
/// 并附带此 beta 头向网关（含各类中转）显式启用 1M 上下文 —— 与
/// cc-switch 的转发行为保持一致。
pub(crate) const ANTHROPIC_ONE_M_CONTEXT_BETA: &str = "context-1m-2025-08-07";

/// 本地 1M 上下文标记（模型名后缀，大小写不敏感）。
const ONE_M_CONTEXT_MARKER: &str = "[1m]";

/// 判断模型名是否携带 `[1M]` 上下文标记（忽略尾部空格、大小写不敏感）。
pub(crate) fn has_one_m_context_marker(model: &str) -> bool {
    let trimmed = model.trim_end();
    let marker = ONE_M_CONTEXT_MARKER.as_bytes();
    let bytes = trimmed.as_bytes();
    bytes.len() >= marker.len()
        && bytes[bytes.len() - marker.len()..].eq_ignore_ascii_case(marker)
}

/// 剥离模型名末尾的 `[1M]` 上下文标记（上游 API 不接受该本地标记）。
pub(crate) fn strip_one_m_context_marker(model: &str) -> String {
    if !has_one_m_context_marker(model) {
        return model.to_string();
    }
    let trimmed = model.trim_end();
    trimmed[..trimmed.len() - ONE_M_CONTEXT_MARKER.len()]
        .trim_end()
        .to_string()
}

/// 读取配置中的 1M 上下文开关（snowcfg.enable1mContext）。
///
/// 与模型名 `[1M]` 标记互为兜底：任一成立即向网关声明 1M 上下文，
/// 这样即使会话选定的模型名没有携带标记（例如纯 `claude-opus-5`），
/// 只要档案开关开启，请求依然会注入 context-1m beta 头。
pub(crate) fn config_json_enables_one_m_context(config_json: &str) -> bool {
    let Ok(parsed) = serde_json::from_str::<Value>(config_json) else {
        return false;
    };
    parsed
        .get("snowcfg")
        .and_then(|value| value.get("enable1mContext"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

pub(crate) fn get_persistent_user_id() -> &'static str {
    PERSISTENT_USER_ID.get_or_init(|| {
        let session_id = Uuid::new_v4();
        let hash_input = format!("anthropic_user_{session_id}");
        let hash = blake3::hash(hash_input.as_bytes()).to_hex();
        format!("user_{hash}_account__session_{session_id}")
    })
}

pub(super) fn resolve_anthropic_endpoint(api_config: &ApiConfigRecord) -> String {
    let normalized_base_url = normalize_base_url(&api_config.base_url);
    if normalized_base_url.is_empty() {
        return String::new();
    }

    let base_url = if normalized_base_url == DEFAULT_OPENAI_BASE_URL {
        DEFAULT_ANTHROPIC_BASE_URL.to_string()
    } else {
        normalized_base_url
    };

    if api_config.base_url_mode == "endpoint" {
        return base_url;
    }

    let resolved_base = resolve_sdk_api_base_url(&base_url, &api_config.base_url_mode);
    format!("{}/messages", resolved_base)
}

pub(super) fn build_anthropic_payload(
    messages: &[ChatContextMessage],
    database_path: &Path,
    request: &ResponsesApiRequest,
    api_config: &ApiConfigRecord,
    tools: Option<Value>,
    user_system_prompts: &[String],
) -> Result<Value> {
    let model =
        resolve_advanced_model(request.model.as_deref(), &api_config.advanced_model)?;
    // `[1M]` 后缀是 Claude Code 生态的本地上下文能力声明（见
    // ANTHROPIC_ONE_M_CONTEXT_BETA），上游 API 不接受该标记，发送前剥离；
    // 对应的 context-1m beta 头由调用方（api/anthropic/mod.rs）注入。
    let model = strip_one_m_context_marker(&model);

    let skip_image_parsing = request.skip_context.unwrap_or(false);
    let has_user_system_prompts = !user_system_prompts.is_empty();
    // When user-configured system prompts exist, they occupy the `system`
    // slot exclusively. The built-in system prompt (already injected as a
    // `system` message by `prepare_context_request`) is demoted to a
    // leading `user` message, matching Snow CLI PR #127.
    let mut builtin_system_parts = Vec::new();
    let mut anthropic_messages = Vec::new();

    for message in messages {
        let content = message.content.trim();
        let role = message.role.trim();

        // --- Tool result messages: emit as user message with tool_result blocks ---
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
            let mut tool_result_blocks = Vec::new();
            for tool_result in &results {
                if tool_result.call_id.is_empty() {
                    // No paired call: emit text and images as sibling blocks.
                    if !tool_result.text.is_empty() {
                        tool_result_blocks.push(json!({
                            "type": "text",
                            "text": tool_result.text,
                        }));
                    }
                    for image in &tool_result.images {
                        tool_result_blocks.push(json!({
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": image.media_type,
                                "data": image.data,
                            },
                        }));
                    }
                } else {
                    // Anthropic natively accepts image content blocks inside
                    // tool_result.content, keeping the screenshot attached to
                    // its tool use instead of leaking base64 into text.
                    let mut blocks: Vec<Value> = Vec::new();
                    if !tool_result.text.is_empty() {
                        blocks.push(json!({
                            "type": "text",
                            "text": tool_result.text,
                        }));
                    }
                    for image in &tool_result.images {
                        blocks.push(json!({
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": image.media_type,
                                "data": image.data,
                            },
                        }));
                    }
                    tool_result_blocks.push(json!({
                        "type": "tool_result",
                        "tool_use_id": tool_result.call_id,
                        "content": if blocks.is_empty() {
                            Value::String(String::new())
                        } else {
                            Value::Array(blocks)
                        },
                    }));
                }
            }
            if !tool_result_blocks.is_empty() {
                anthropic_messages.push(json!({
                    "role": "user",
                    "content": tool_result_blocks,
                }));
            }
            continue;
        }

        if content.is_empty() && message.tool_calls_json.is_none() {
            continue;
        }

        // --- Assistant messages with tool_calls ---
        if role == "assistant" {
            // Parse persisted thinking blocks (with signatures) so they can
            // be round-tripped verbatim to the Anthropic API, preserving
            // thinking continuity across turns.
            let thinking_blocks: Vec<Value> = message
                .thinking_blocks_json
                .as_deref()
                .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
                .and_then(|v| v.as_array().map(|a| a.clone()))
                .unwrap_or_default();

            if let Some(ref tool_calls_raw) = message.tool_calls_json {
                let tool_use_blocks =
                    crate::api::conversation::tool_messages::tool_calls_as_anthropic_blocks(
                        tool_calls_raw,
                    );
                if !tool_use_blocks.is_empty() {
                    let mut content_blocks = Vec::new();
                    // Thinking blocks must come first so the API can verify
                    // the signature chain before processing text/tool_use.
                    content_blocks.extend(thinking_blocks.iter().cloned());
                    if !content.is_empty() {
                        content_blocks.push(json!({ "type": "text", "text": content }));
                    }
                    content_blocks.extend(tool_use_blocks);
                    anthropic_messages.push(json!({
                        "role": "assistant",
                        "content": content_blocks,
                    }));
                    continue;
                }
            }
            // Fall through: assistant message without tool_calls but with
            // thinking blocks needs an array-format content so the thinking
            // blocks can be included.
            if !thinking_blocks.is_empty() && !content.is_empty() {
                let mut content_blocks: Vec<Value> = thinking_blocks;
                content_blocks.push(json!({ "type": "text", "text": content }));
                anthropic_messages.push(json!({
                    "role": "assistant",
                    "content": content_blocks,
                }));
                continue;
            }
        }

        // --- System/developer messages ---
        if role == "system" || role == "developer" {
            if !content.is_empty() {
                builtin_system_parts.push(content.to_string());
            }
            continue;
        }

        // --- Regular user/assistant messages ---
        if content.is_empty() {
            continue;
        }
        if skip_image_parsing {
            anthropic_messages.push(json!({
                "role": normalize_anthropic_role(role),
                "content": content,
            }));
            continue;
        }

        let parsed_content = parse_chat_message_content(content, database_path)?;
        let content_value = if parsed_content.images.is_empty() {
            Value::String(parsed_content.text)
        } else {
            let mut blocks = Vec::new();
            if !parsed_content.text.is_empty() {
                blocks.push(json!({ "type": "text", "text": parsed_content.text }));
            }
            blocks.extend(parsed_content.images.iter().map(|image| {
                json!({
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": image.media_type,
                        "data": image.data,
                    },
                })
            }));
            Value::Array(blocks)
        };

        anthropic_messages.push(json!({
            "role": normalize_anthropic_role(role),
            "content": content_value,
        }));
    }

    // When user system prompts are present, demote the built-in system
    // prompt to a leading `user` message so the `system` field can be
    // exclusively populated with user prompts (Snow CLI PR #127).
    if has_user_system_prompts && !builtin_system_parts.is_empty() {
        let builtin_text = builtin_system_parts.join("\n\n");
        let builtin_block = json!({
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": builtin_text,
                    "cache_control": { "type": "ephemeral", "ttl": "5m" }
                }
            ]
        });
        anthropic_messages.insert(0, builtin_block);
    }

    if anthropic_messages.is_empty() {
        return Err(Error::from_reason("Chat message content is required"));
    }

    let mut payload = json!({
        "model": model,
        "messages": anthropic_messages,
        "stream": true,
    });

    // max_tokens 为用户可选配置：留空（None）时不传该参数，由服务端决定默认值。
    if let Some(max_tokens) = api_config.max_tokens {
        if max_tokens > 0 {
            payload["max_tokens"] = json!(max_tokens);
        }
    }

    // Build the `system` field.
    // the field exclusively (each prompt as an independent text block, with
    // cache_control on the last block). Otherwise the built-in system
    // prompt parts are used. A plain string system field cannot carry
    // cache_control, so we always emit an array of text blocks.
    let mut system_parts: Vec<String> = if has_user_system_prompts {
        user_system_prompts.to_vec()
    } else {
        builtin_system_parts
    };
    if let Some(prompt) = request
        .internal_recovery_prompt
        .as_deref()
        .map(str::trim)
        .filter(|prompt| !prompt.is_empty())
    {
        system_parts.push(prompt.to_string());
    }

    if !system_parts.is_empty() {
        let system_blocks: Vec<Value> = system_parts
            .iter()
            .enumerate()
            .map(|(index, text)| {
                let mut block = json!({ "type": "text", "text": text });
                if index == system_parts.len() - 1 {
                    block["cache_control"] = json!({ "type": "ephemeral", "ttl": "5m" });
                }
                block
            })
            .collect();
        payload["system"] = json!(system_blocks);
    }

    // Add metadata.user_id for tracking and caching (matches snow-cli behavior).
    payload["metadata"] = json!({ "user_id": get_persistent_user_id() });

    if let Some((thinking, effort)) = build_anthropic_thinking(&api_config.config_json) {
        payload["thinking"] = thinking;
        if let Some(effort) = effort {
            payload["output_config"] = json!({ "effort": effort });
        }
    }

    if let Some(tools) = tools {
        if tools.as_array().is_some_and(|items| !items.is_empty()) {
            payload["tools"] = tools;
        }
    }

    // Add cache_control to the last user message's last content block.
    // This enables Anthropic to cache the conversation prefix up to and
    // including the last user turn, so subsequent tool-call rounds benefit
    // from cache hits.  Matches snow-cli's convertToAnthropicMessages logic.
    // Skip the leading built-in prompt user message (index 0) when user
    // system prompts are present, since it already carries cache_control.
    apply_last_user_message_cache_control(&mut payload, has_user_system_prompts);

    Ok(payload)
}

/// Add `cache_control` to the last user message's last content block so
/// Anthropic can cache the conversation prefix up to and including the last
/// user turn. Shared by the main conversation flow and the file-search agent
/// so both send identical parameters.
pub(crate) fn apply_last_user_message_cache_control(
    payload: &mut Value,
    has_user_system_prompts: bool,
) {
    if let Some(messages) = payload.get_mut("messages").and_then(Value::as_array_mut) {
        let total = messages.len();
        for index in (0..total).rev() {
            let is_first_user_message = index == 0;
            let is_user_message =
                messages[index].get("role").and_then(Value::as_str) == Some("user");
            if !is_user_message {
                continue;
            }
            // When user system prompts are present, the first user message
            // is the demoted built-in prompt which already has cache_control;
            // skip it so we don't double-tag.
            if has_user_system_prompts && is_first_user_message {
                continue;
            }
            let msg = &mut messages[index];
            match msg.get_mut("content") {
                Some(Value::String(_)) => {
                    // Convert plain string content to structured array
                    // so we can attach cache_control.
                    let text = msg["content"].as_str().unwrap_or("").to_string();
                    msg["content"] = json!([
                        {
                            "type": "text",
                            "text": text,
                            "cache_control": { "type": "ephemeral", "ttl": "5m" }
                        }
                    ]);
                }
                Some(Value::Array(arr)) => {
                    if let Some(last_block) = arr.last_mut() {
                        last_block["cache_control"] = json!({ "type": "ephemeral", "ttl": "5m" });
                    }
                }
                _ => {}
            }
            break;
        }
    }
}

fn normalize_anthropic_role(role: &str) -> &str {
    match role.trim() {
        "assistant" => "assistant",
        _ => "user",
    }
}

pub(crate) fn build_anthropic_thinking(config_json: &str) -> Option<(Value, Option<String>)> {
    let parsed = serde_json::from_str::<Value>(config_json).ok()?;
    let thinking = parsed.get("snowcfg")?.get("thinking")?.as_object()?;
    let enabled = thinking
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    if !enabled {
        return None;
    }

    let effort = thinking
        .get("effort")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "none")
        .map(|value| value.to_string());

    Some((json!({ "type": "adaptive" }), effort))
}