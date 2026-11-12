//! Gemini payload construction and endpoint resolution.

use std::collections::{HashMap, VecDeque};
use std::path::Path;

use napi::bindgen_prelude::*;
use serde_json::{json, Value};

use crate::api::config::{
    normalize_base_url, resolve_sdk_api_base_url, DEFAULT_GEMINI_BASE_URL, DEFAULT_OPENAI_BASE_URL,
};
use crate::api::conversation::tool_messages::{
    extract_tool_call_entries, parse_tool_results_with_images, remove_invalid_snow_tool_calls,
    ParsedToolResult,
};
use crate::api::conversation::{parse_chat_message_content, ParsedChatMessageContent};
use crate::api::oauth::antigravity as antigravity_oauth;
use crate::api::oauth::provider::antigravity_profile_metadata;
use crate::api::responses::ResponsesApiRequest;
use crate::storage::services::chat_conversations::ChatContextMessage;
use crate::storage::ApiConfigRecord;

pub fn resolve_gemini_endpoint(
    api_config: &ApiConfigRecord,
    model: &str,
    api_key: &str,
) -> String {
    let normalized_base_url = normalize_base_url(&api_config.base_url);
    if normalized_base_url.is_empty() {
        return String::new();
    }

    let base_url = if normalized_base_url == DEFAULT_OPENAI_BASE_URL {
        DEFAULT_GEMINI_BASE_URL.to_string()
    } else {
        normalized_base_url
    };

    let resolved_base = if api_config.base_url_mode == "endpoint" {
        base_url
    } else {
        resolve_sdk_api_base_url(&base_url, &api_config.base_url_mode)
    };

    if antigravity_profile_metadata(&api_config.config_json).is_some() {
        let base = if resolved_base.trim().is_empty() {
            antigravity_oauth::BACKEND_BASE_URL.to_string()
        } else {
            resolved_base
        };
        return format!("{base}/v1internal:streamGenerateContent?alt=sse");
    }

    let clean_model = model.strip_prefix("models/").unwrap_or(model);

    let mut url = format!(
        "{}/models/{}:streamGenerateContent?alt=sse",
        resolved_base, clean_model
    );

    if !api_key.is_empty() {
        url.push_str(&format!("&key={}", api_key));
    }

    url
}

pub fn wrap_antigravity_payload(payload: Value, model: &str, project_id: &str) -> Value {
    let clean_model = model.strip_prefix("models/").unwrap_or(model);
    let project_id = project_id.trim();
    let model_lower = clean_model.to_ascii_lowercase();
    let is_claude = model_lower.contains("claude");
    let require_placeholder =
        is_claude || model_lower.contains("gemini-3-pro") || model_lower.contains("gemini-3.1-pro");
    let mut payload = payload;
    if let Some(tools) = payload.get_mut("tools") {
        sanitize_antigravity_tools(tools, require_placeholder);
    }
    if is_claude {
        if let Some(object) = payload.as_object_mut() {
            object.insert(
                "toolConfig".to_string(),
                json!({ "functionCallingConfig": { "mode": "VALIDATED" } }),
            );
        }
    } else if let Some(generation_config) = payload
        .get_mut("generationConfig")
        .and_then(Value::as_object_mut)
    {
        generation_config.remove("maxOutputTokens");
    }
    let mut envelope = serde_json::Map::new();
    if !project_id.is_empty() {
        envelope.insert("project".to_string(), json!(project_id));
    }
    envelope.insert("model".to_string(), json!(clean_model));
    envelope.insert("request".to_string(), payload);
    envelope.insert("requestType".to_string(), json!("agent"));
    envelope.insert("userAgent".to_string(), json!("antigravity"));
    envelope.insert(
        "requestId".to_string(),
        json!(format!("agent-{}", uuid::Uuid::new_v4())),
    );
    Value::Object(envelope)
}

fn sanitize_antigravity_tools(tools: &mut Value, require_placeholder: bool) {
    let Some(entries) = tools.as_array_mut() else {
        return;
    };
    for tool in entries.iter_mut() {
        for key in ["functionDeclarations", "function_declarations"] {
            let Some(declarations) = tool.get_mut(key).and_then(Value::as_array_mut) else {
                continue;
            };
            for declaration in declarations.iter_mut() {
                let Some(parameters) = declaration.get_mut("parameters") else {
                    continue;
                };
                let cleaned =
                    super::antigravity_schema::clean_tool_schema(parameters, require_placeholder);
                *parameters = cleaned;
            }
        }
    }
}

/// 构建一条文本消息的 Gemini parts（文本块 + 图片 inlineData）。
///
/// 解析后为空的标签消息用原始文本兜底：空 user 轮会被上游丢弃，丢弃后前
/// 一条 model 轮成为请求尾轮（Gemini 400 "Requests ending with a model turn"）。
fn build_gemini_content_parts(
    content: &str,
    database_path: &Path,
    skip_image_parsing: bool,
) -> Result<Vec<Value>> {
    if skip_image_parsing {
        return Ok(vec![json!({ "text": content })]);
    }
    let ParsedChatMessageContent { text, images } =
        parse_chat_message_content(content, database_path)?;
    let text = if text.is_empty() {
        content.to_string()
    } else {
        text
    };
    let mut parts = vec![json!({ "text": text })];
    parts.extend(images.iter().map(|image| {
        json!({
            "inlineData": {
                "mimeType": image.media_type,
                "data": image.data,
            },
        })
    }));
    Ok(parts)
}

fn build_gemini_system_instruction(
    user_system_prompts: &[String],
    builtin_system_parts: Vec<String>,
    host_system_prompts: &[String],
    internal_recovery_prompt: Option<&str>,
) -> Option<Value> {
    let mut system_parts = if user_system_prompts.is_empty() {
        builtin_system_parts
    } else {
        user_system_prompts.to_vec()
    };
    system_parts.extend(host_system_prompts.iter().cloned());
    if let Some(prompt) = internal_recovery_prompt
        .map(str::trim)
        .filter(|prompt| !prompt.is_empty())
    {
        system_parts.push(prompt.to_string());
    }
    (!system_parts.is_empty()).then(|| {
        json!({
            "parts": system_parts.into_iter().map(|text| json!({ "text": text })).collect::<Vec<_>>()
        })
    })
}

pub(super) fn build_gemini_payload(
    messages: &[ChatContextMessage],
    database_path: &Path,
    request: &ResponsesApiRequest,
    api_config: &ApiConfigRecord,
    tools: Option<Value>,
    user_system_prompts: &[String],
    host_system_prompts: &[String],
) -> Result<Value> {
    // Never mutate database-backed history. Gemini requests receive a filtered
    // copy so an upstream empty built-in call and its error result cannot seed
    // a self-reinforcing function-call retry loop.
    let mut messages = messages.to_vec();
    remove_invalid_snow_tool_calls(&mut messages);
    let skip_image_parsing = request.skips_inline_image_parsing();
    let has_user_system_prompts = !user_system_prompts.is_empty();
    let mut builtin_system_parts = Vec::new();
    let mut contents = Vec::new();

    // Gemini relays reject histories whose functionResponse.name does not
    // exactly match the corresponding functionCall.name. The stored tool
    // result name can drift from the model-echoed call name (e.g. frontend
    // name normalization truncating relay formats like "server:tool"), so
    // functionResponse names are resolved from the conversation's own
    // functionCall names instead — mirroring Snow CLI's
    // `toolCallIdToFunctionName` map (see snow-cli/source/api/gemini.ts).
    // Calls carrying an id match by id; Gemini calls have no id, so their
    // names are queued and consumed in order (the renderer pushes exactly
    // one result per call, in call order).
    let mut call_id_to_name: HashMap<String, String> = HashMap::new();
    let mut pending_call_names: VecDeque<String> = VecDeque::new();

    let last_message_index = messages.len().saturating_sub(1);
    for (message_index, message) in messages.iter().enumerate() {
        let content = message.content.trim();
        let role = message.role.trim();
        let is_last_message = message_index == last_message_index;

        // --- Tool result messages: emit as user content with functionResponse parts ---
        if role == "tool" {
            if content.is_empty() && message.tool_results_json.is_none() {
                continue;
            }
            let results = match message.tool_results_json {
                Some(ref raw) => {
                    parse_tool_results_with_images(raw, database_path, skip_image_parsing)
                }
                None => Vec::new(),
            };
            // 无结构化结果的 tool 行否则整条被丢：末条时前一条 model 轮会
            // 成为请求尾轮（Gemini 400 "Requests ending with a model turn"）。
            // 降级为一条 user 文本内容，既保上下文又保持尾轮合法。
            if results.is_empty() {
                if is_last_message && !content.is_empty() {
                    contents.push(json!({
                        "role": "user",
                        "parts": build_gemini_content_parts(
                            content,
                            database_path,
                            skip_image_parsing,
                        )?,
                    }));
                }
                continue;
            }
            // Gemini requires tool results as user Content with ordered
            // functionResponse parts. Keep image-bearing responses separate:
            // their inlineData must remain a following user content block.
            if results
                .iter()
                .all(|tool_result| tool_result.images.is_empty())
            {
                let parts: Vec<Value> = results
                    .iter()
                    .map(|tool_result| {
                        build_function_response_part(
                            tool_result,
                            &call_id_to_name,
                            &mut pending_call_names,
                        )
                    })
                    .collect();
                if !parts.is_empty() {
                    contents.push(json!({
                        "role": "user",
                        "parts": parts,
                    }));
                }
                continue;
            }

            for tool_result in &results {
                contents.push(json!({
                    "role": "user",
                    "parts": [build_function_response_part(
                        tool_result,
                        &call_id_to_name,
                        &mut pending_call_names,
                    )],
                }));
                // functionResponse only accepts plain JSON, so the screenshot
                // base64 must travel in a following user message as inlineData
                // parts.
                if !tool_result.images.is_empty() {
                    let image_parts: Vec<Value> = tool_result
                        .images
                        .iter()
                        .map(|image| {
                            json!({
                                "inlineData": {
                                    "mimeType": image.media_type,
                                    "data": image.data,
                                }
                            })
                        })
                        .collect();
                    contents.push(json!({
                        "role": "user",
                        "parts": image_parts,
                    }));
                }
            }
            continue;
        }

        let has_replayable_signatures =
            has_replayable_gemini_signatures(message.thinking_blocks_json.as_deref());
        if content.is_empty() && message.tool_calls_json.is_none() && !has_replayable_signatures {
            continue;
        }

        // --- Assistant messages with tool_calls ---
        if role == "assistant" {
            if let Some(ref tool_calls_raw) = message.tool_calls_json {
                let function_call_parts =
                    crate::api::conversation::tool_messages::tool_calls_as_gemini_parts(
                        tool_calls_raw,
                    );
                // 收集本消息 functionCall 的名称，供后续 functionResponse
                // 配对：有 id 的进映射，无 id 的（Gemini 原生格式）入队列。
                for (call_id, call_name) in extract_tool_call_entries(tool_calls_raw) {
                    if call_id.is_empty() {
                        pending_call_names.push_back(call_name);
                    } else {
                        call_id_to_name.insert(call_id, call_name);
                    }
                }
                if !function_call_parts.is_empty() {
                    let mut parts = Vec::new();
                    // Signed Parts carry their own thought text when present.
                    // Replaying the display-oriented thinking mirror beside
                    // them would duplicate model reasoning in the next turn.
                    if !has_replayable_signatures {
                        if let Some(ref thinking) = message.thinking {
                            if !thinking.is_empty() {
                                parts.push(json!({ "text": thinking, "thought": true }));
                            }
                        }
                    }
                    if !content.is_empty() {
                        parts.push(json!({ "text": content }));
                    }
                    parts.extend(replay_signed_function_call_parts(
                        function_call_parts,
                        message.thinking_blocks_json.as_deref(),
                    ));
                    contents.push(json!({
                        "role": "model",
                        "parts": parts,
                    }));
                    continue;
                }
            }

            // Gemini may emit a thoughtSignature on a normal model Part
            // without a functionCall. It is still required continuation data
            // and must be replayed as a model Part, even though there is no
            // tool result in the following turn.
            if has_replayable_signatures {
                let mut parts = Vec::new();
                if !content.is_empty() {
                    parts.push(json!({ "text": content }));
                }
                parts.extend(replay_signed_function_call_parts(
                    Vec::new(),
                    message.thinking_blocks_json.as_deref(),
                ));
                if !parts.is_empty() {
                    contents.push(json!({
                        "role": "model",
                        "parts": parts,
                    }));
                }
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

        // --- Regular user/model messages ---
        if content.is_empty() {
            continue;
        }

        contents.push(json!({
            "role": normalize_gemini_role(role),
            "parts": build_gemini_content_parts(content, database_path, skip_image_parsing)?,
        }));
    }

    // When user system prompts are present, they occupy `systemInstruction`
    // exclusively and the built-in prompt is demoted to a leading `user`
    // message (Snow CLI PR #127).
    if has_user_system_prompts && !builtin_system_parts.is_empty() {
        let builtin_text = builtin_system_parts.join("\n\n");
        let builtin_message = json!({
            "role": "user",
            "parts": [{ "text": builtin_text }],
        });
        contents.insert(0, builtin_message);
    }

    if contents.is_empty() {
        return Err(Error::from_reason("Chat message content is required"));
    }

    let mut payload = json!({
        "contents": contents,
    });

    // Preserve user/built-in precedence; host facts and recovery are appended
    // as independent systemInstruction parts without causing demotion.
    if let Some(system_instruction) = build_gemini_system_instruction(
        user_system_prompts,
        builtin_system_parts,
        host_system_prompts,
        request.internal_recovery_prompt.as_deref(),
    ) {
        payload["systemInstruction"] = system_instruction;
    }

    let mut generation_config = json!({});

    if let Some(max_tokens) = api_config.max_tokens {
        if max_tokens > 0 {
            generation_config["maxOutputTokens"] = json!(max_tokens);
        }
    }

    if let Some(thinking_config) = build_gemini_thinking_config(&api_config.config_json) {
        generation_config["thinkingConfig"] = thinking_config;
    }

    if !generation_config
        .as_object()
        .map(|obj| obj.is_empty())
        .unwrap_or(true)
    {
        payload["generationConfig"] = generation_config;
    }

    if let Some(tools) = tools {
        if tools.as_array().is_some_and(|items| !items.is_empty()) {
            payload["tools"] = tools;
        }
    }

    // Google Search grounding（Gemini 原生联网搜索）：
    // 配置 snowcfg.googleSearch 开启时，合并注入 google_search。
    // 与 MCP function tools 共存时，放入同一个 Tool 对象并配置 tool_config.include_server_side_tool_invocations。
    // A duplicate-read recovery deliberately has no provider tools at all.
    // Google Search is a provider tool too, even though it is configured
    // independently from MCP function declarations.
    let google_search_enabled = should_include_gemini_google_search(
        &api_config.config_json,
        request.disable_tools.unwrap_or(false),
    );
    let is_cli_proxy_api = api_config
        .base_url
        .to_ascii_lowercase()
        .contains("cliproxyapi");
    let has_function_tools = payload
        .get("tools")
        .and_then(Value::as_array)
        .is_some_and(|items| !items.is_empty());
    // The current CPA/Antigravity route rejects built-in tools mixed with
    // function declarations. MCP tools remain usable, so omit only the
    // built-in search tool for that route when both are configured.
    let include_google_search = google_search_enabled && !(is_cli_proxy_api && has_function_tools);
    if include_google_search {
        if let Some(tools_arr) = payload.get_mut("tools").and_then(Value::as_array_mut) {
            // Keep server-side and function tools as separate Tool objects.
            // CPA rejects a single object that mixes google_search with
            // functionDeclarations even when tool_config is present.
            tools_arr.push(json!({ "google_search": {} }));
        } else {
            payload["tools"] = json!([{ "google_search": {} }]);
        }
        // CPA requires this flag whenever a built-in tool is combined with
        // function calling, including the Google-Search-only case where the
        // tools array did not exist before the branch above.
        payload["tool_config"] = json!({
            "include_server_side_tool_invocations": true
        });
        payload["toolConfig"] = json!({
            "includeServerSideToolInvocations": true
        });
    } else if is_cli_proxy_api && has_function_tools {
        // CPA can inject/enable built-in tools while Snow only sees the MCP
        // function declarations. Send the compatibility flag for any
        // function-tool request as well, otherwise CPA rejects the request
        // before streaming starts.
        payload["tool_config"] = json!({
            "include_server_side_tool_invocations": true,
            "function_calling_config": { "mode": "AUTO" }
        });
        payload["toolConfig"] = json!({
            "includeServerSideToolInvocations": true,
            "functionCallingConfig": { "mode": "AUTO" }
        });
    }

    Ok(payload)
}

/// Rehydrate Gemini's opaque thoughtSignature Parts for tool continuation.
/// Old rows and signatures from other providers are ignored, leaving the
/// normal normalized functionCall representation untouched.
fn replay_signed_function_call_parts(
    function_call_parts: Vec<Value>,
    thinking_blocks_json: Option<&str>,
) -> Vec<Value> {
    let Some(signature_parts) = thinking_blocks_json
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .and_then(|value| value.as_array().cloned())
    else {
        return function_call_parts;
    };

    let remaining = signature_parts
        .into_iter()
        .filter(|part| {
            part.get("thoughtSignature")
                .and_then(Value::as_str)
                .is_some_and(|signature| !signature.is_empty())
        })
        .collect::<Vec<_>>();
    let mut remaining_calls = function_call_parts;
    let mut replayed = Vec::new();

    // Preserve the provider's Part order. A thoughtSignature can occur on a
    // function-call Part or on a signature-only thought Part; both must remain
    // before the matching user functionResponse in the next request.
    for signed_part in remaining {
        let Some(signed_call) = signed_part.get("functionCall") else {
            replayed.push(signed_part);
            continue;
        };
        let signed_id = signed_call.get("id").and_then(Value::as_str);
        let signed_name = signed_call.get("name").and_then(Value::as_str);
        // 规范化结果可能因历史存储格式丢参；此时沿用签名 part 中上游返回的
        // 原始 args，避免空参数覆盖完整参数（issue #170）。
        let signed_args = signed_call
            .get("args")
            .filter(|args| args.as_object().is_some_and(|map| !map.is_empty()))
            .cloned();
        let match_index = remaining_calls.iter().position(|function_call_part| {
            let function_call = function_call_part.get("functionCall");
            let call_id = function_call
                .and_then(|call| call.get("id"))
                .and_then(Value::as_str);
            let call_name = function_call
                .and_then(|call| call.get("name"))
                .and_then(Value::as_str);
            match (call_id, signed_id) {
                (Some(call_id), Some(signed_id)) => call_id == signed_id,
                (None, None) => call_name == signed_name,
                _ => false,
            }
        });
        if let Some(index) = match_index {
            let function_call_part = remaining_calls.remove(index);
            let mut replay_call = function_call_part["functionCall"].clone();
            if !function_call_has_usable_args(&replay_call) {
                if let Some(call_object) = replay_call.as_object_mut() {
                    call_object
                        .insert("args".to_string(), signed_args.unwrap_or_else(|| json!({})));
                }
            }
            let mut replay_part = signed_part;
            replay_part["functionCall"] = replay_call;
            replayed.push(replay_part);
        }
    }

    // Legacy rows may not have a signature for every stored call. Keep those
    // calls in their normalized form rather than deleting usable history.
    replayed.extend(remaining_calls);
    replayed
}

/// functionCall 是否带有非空 args 对象。
fn function_call_has_usable_args(function_call: &Value) -> bool {
    function_call
        .get("args")
        .and_then(Value::as_object)
        .is_some_and(|args| !args.is_empty())
}

fn has_replayable_gemini_signatures(thinking_blocks_json: Option<&str>) -> bool {
    thinking_blocks_json
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .and_then(|value| value.as_array().cloned())
        .is_some_and(|parts| {
            parts.iter().any(|part| {
                part.get("thoughtSignature")
                    .and_then(Value::as_str)
                    .is_some_and(|signature| !signature.is_empty())
            })
        })
}

fn normalize_gemini_role(role: &str) -> &str {
    match role.trim() {
        "assistant" => "model",
        _ => "user",
    }
}

/// Resolve the functionResponse name for a tool result so it exactly
/// matches the functionCall name the model emitted (Gemini relays reject
/// mismatched histories with a 400).
///
/// Priority: the call's own id mapping (OpenAI/Anthropic histories) → the
/// next unmatched id-less functionCall name in conversation order (Gemini
/// calls carry no id; the renderer pushes exactly one result per call in
/// call order) → the stored result name as a final fallback.
fn resolve_function_response_name(
    tool_result: &ParsedToolResult,
    call_id_to_name: &HashMap<String, String>,
    pending_call_names: &mut VecDeque<String>,
) -> String {
    if !tool_result.call_id.is_empty() {
        if let Some(name) = call_id_to_name.get(&tool_result.call_id) {
            return name.clone();
        }
    }
    if let Some(name) = pending_call_names.pop_front() {
        return name;
    }
    if tool_result.name.is_empty() {
        "unknown_tool".to_string()
    } else {
        tool_result.name.clone()
    }
}

fn build_function_response_part(
    tool_result: &ParsedToolResult,
    call_id_to_name: &HashMap<String, String>,
    pending_call_names: &mut VecDeque<String>,
) -> Value {
    let response_content = if tool_result.text.is_empty() {
        if tool_result.images.is_empty() {
            json!({"result": "ok"})
        } else {
            json!({"result": "[image attached]"})
        }
    } else {
        json!({"result": tool_result.text})
    };
    let mut function_response = serde_json::Map::new();
    if !tool_result.call_id.is_empty() {
        function_response.insert("id".to_string(), Value::String(tool_result.call_id.clone()));
    }
    function_response.insert(
        "name".to_string(),
        Value::String(resolve_function_response_name(
            tool_result,
            call_id_to_name,
            pending_call_names,
        )),
    );
    function_response.insert("response".to_string(), response_content);
    json!({ "functionResponse": function_response })
}

pub fn build_gemini_thinking_config(config_json: &str) -> Option<Value> {
    let parsed = serde_json::from_str::<Value>(config_json).ok()?;
    let gemini_thinking = parsed.get("snowcfg")?.get("geminiThinking")?.as_object()?;
    let enabled = gemini_thinking
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    if !enabled {
        return None;
    }

    let thinking_level = gemini_thinking
        .get("thinkingLevel")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "none")?;

    Some(json!({
        "thinkingLevel": thinking_level,
        "includeThoughts": true,
    }))
}

/// 读取配置中的谷歌搜索联网开关（snowcfg.googleSearch）。
/// 开启时 gemini 请求会注入 google_search 工具（Gemini 原生 grounding）。
pub fn build_gemini_google_search_enabled(config_json: &str) -> bool {
    serde_json::from_str::<Value>(config_json)
        .ok()
        .and_then(|parsed| parsed.get("snowcfg")?.get("googleSearch")?.as_bool())
        .unwrap_or(false)
}

pub fn should_include_gemini_google_search(config_json: &str, disable_tools: bool) -> bool {
    !disable_tools && build_gemini_google_search_enabled(config_json)
}
