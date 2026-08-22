//! Gemini payload construction and endpoint resolution.

use std::collections::{HashMap, VecDeque};
use std::path::Path;

use napi::bindgen_prelude::*;
use serde_json::{json, Value};

use crate::api::config::{
    normalize_base_url, resolve_sdk_api_base_url, DEFAULT_GEMINI_BASE_URL, DEFAULT_OPENAI_BASE_URL,
};
use crate::api::conversation::parse_chat_message_content;
use crate::api::conversation::tool_messages::{
    extract_tool_call_entries, parse_tool_results_with_images, remove_invalid_snow_tool_calls,
    ParsedToolResult,
};
use crate::api::responses::ResponsesApiRequest;
use crate::storage::services::chat_conversations::ChatContextMessage;
use crate::storage::ApiConfigRecord;

pub(crate) fn resolve_gemini_endpoint(
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

fn build_gemini_system_instruction(
    user_system_prompts: &[String],
    builtin_system_parts: Vec<String>,
    internal_recovery_prompt: Option<&str>,
) -> Option<Value> {
    let mut system_parts = if user_system_prompts.is_empty() {
        builtin_system_parts
    } else {
        user_system_prompts.to_vec()
    };
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
) -> Result<Value> {
    // Never mutate database-backed history. Gemini requests receive a filtered
    // copy so an upstream empty built-in call and its error result cannot seed
    // a self-reinforcing function-call retry loop.
    let mut messages = messages.to_vec();
    remove_invalid_snow_tool_calls(&mut messages);
    let skip_image_parsing = request.skip_context.unwrap_or(false);
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

    for message in &messages {
        let content = message.content.trim();
        let role = message.role.trim();

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
        if skip_image_parsing {
            contents.push(json!({
                "role": normalize_gemini_role(role),
                "parts": [{ "text": content }],
            }));
            continue;
        }

        let parsed_content = parse_chat_message_content(content, database_path)?;
        let mut parts = Vec::new();
        if !parsed_content.text.is_empty() {
            parts.push(json!({ "text": parsed_content.text }));
        }
        parts.extend(parsed_content.images.iter().map(|image| {
            json!({
                "inlineData": {
                    "mimeType": image.media_type,
                    "data": image.data,
                },
            })
        }));

        contents.push(json!({
            "role": normalize_gemini_role(role),
            "parts": parts,
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

    // Build `systemInstruction`. When user system prompts are present they
    // occupy the field exclusively (each prompt as an independent part).
    // Otherwise the built-in system prompt parts are used.
    if let Some(system_instruction) = build_gemini_system_instruction(
        user_system_prompts,
        builtin_system_parts,
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
            let mut replay_part = signed_part;
            replay_part["functionCall"] = function_call_part["functionCall"].clone();
            replayed.push(replay_part);
        }
    }

    // Legacy rows may not have a signature for every stored call. Keep those
    // calls in their normalized form rather than deleting usable history.
    replayed.extend(remaining_calls);
    replayed
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

pub(crate) fn build_gemini_thinking_config(config_json: &str) -> Option<Value> {
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
pub(crate) fn build_gemini_google_search_enabled(config_json: &str) -> bool {
    serde_json::from_str::<Value>(config_json)
        .ok()
        .and_then(|parsed| parsed.get("snowcfg")?.get("googleSearch")?.as_bool())
        .unwrap_or(false)
}

pub(crate) fn should_include_gemini_google_search(config_json: &str, disable_tools: bool) -> bool {
    !disable_tools && build_gemini_google_search_enabled(config_json)
}

#[cfg(test)]
mod tests {
    use std::collections::{HashMap, VecDeque};

    use super::{
        build_function_response_part, build_gemini_system_instruction,
        build_gemini_thinking_config, has_replayable_gemini_signatures,
        replay_signed_function_call_parts, should_include_gemini_google_search,
    };
    use crate::api::conversation::images::ChatImage;
    use crate::api::conversation::tool_messages::ParsedToolResult;
    use serde_json::{json, Value};

    fn parsed_tool_result(name: &str, call_id: &str, text: &str) -> ParsedToolResult {
        ParsedToolResult {
            name: name.to_string(),
            call_id: call_id.to_string(),
            text: text.to_string(),
            images: Vec::<ChatImage>::new(),
            has_valid_shape: true,
        }
    }

    #[test]
    fn requests_thought_summaries_when_gemini_thinking_is_enabled() {
        let config = json!({
            "snowcfg": {
                "geminiThinking": {
                    "enabled": true,
                    "thinkingLevel": "high"
                }
            }
        })
        .to_string();

        assert_eq!(
            build_gemini_thinking_config(&config),
            Some(json!({
                "thinkingLevel": "high",
                "includeThoughts": true,
            }))
        );
    }

    #[test]
    fn internal_recovery_prompt_is_a_gemini_system_instruction() {
        let payload = build_gemini_system_instruction(
            &["configured system rule".to_string()],
            vec!["built-in protocol".to_string()],
            Some("Use completed results and answer without tools."),
        )
        .expect("system instruction");

        assert_eq!(
            payload,
            json!({"parts": [
                {"text": "configured system rule"},
                {"text": "Use completed results and answer without tools."}
            ]})
        );
        assert!(!payload.to_string().contains("built-in protocol"));
    }

    #[test]
    fn disabled_tools_also_disable_configured_gemini_google_search() {
        let config = json!({ "snowcfg": { "googleSearch": true } }).to_string();

        assert!(should_include_gemini_google_search(&config, false));
        assert!(!should_include_gemini_google_search(&config, true));
    }

    #[test]
    fn omits_thinking_config_when_gemini_thinking_is_explicitly_disabled() {
        let config = json!({
            "snowcfg": {
                "geminiThinking": {
                    "enabled": false,
                    "thinkingLevel": "high"
                }
            }
        })
        .to_string();

        assert_eq!(build_gemini_thinking_config(&config), None);
    }

    #[test]
    fn omits_thinking_config_when_thinking_level_is_none() {
        let config = json!({
            "snowcfg": {
                "geminiThinking": {
                    "enabled": true,
                    "thinkingLevel": "none"
                }
            }
        })
        .to_string();

        assert_eq!(build_gemini_thinking_config(&config), None);
    }

    #[test]
    fn omits_thinking_config_for_invalid_configuration() {
        assert_eq!(build_gemini_thinking_config("not json"), None);
    }

    #[test]
    fn parallel_gemini_tool_responses_keep_the_matching_call_ids_and_order() {
        let call_id_to_name = HashMap::from([
            ("call-read".to_string(), "filesystem-read".to_string()),
            ("call-list".to_string(), "filesystem-read".to_string()),
        ]);
        let mut pending_call_names = VecDeque::new();
        let first = parsed_tool_result("wrong-name", "call-read", "package content");
        let second = parsed_tool_result("wrong-name", "call-list", "directory content");

        let parts = vec![
            build_function_response_part(&first, &call_id_to_name, &mut pending_call_names),
            build_function_response_part(&second, &call_id_to_name, &mut pending_call_names),
        ];

        assert_eq!(
            json!({ "role": "user", "parts": parts }),
            json!({
                "role": "user",
                "parts": [
                    { "functionResponse": {
                        "id": "call-read",
                        "name": "filesystem-read",
                        "response": { "result": "package content" },
                    }},
                    { "functionResponse": {
                        "id": "call-list",
                        "name": "filesystem-read",
                        "response": { "result": "directory content" },
                    }},
                ],
            })
        );
        // The call map is read-only while results are matched, so parallel
        // responses cannot consume or overwrite each other's identifiers.
        assert_eq!(call_id_to_name.len(), 2);
    }

    #[test]
    fn replays_parallel_signed_function_calls_by_id() {
        let calls = vec![
            json!({ "functionCall": { "id": "readme", "name": "filesystem-read", "args": { "filePath": "README.md" } } }),
            json!({ "functionCall": { "id": "package", "name": "filesystem-read", "args": { "filePath": "package.json" } } }),
        ];
        let signatures = json!([
            { "functionCall": { "id": "package", "name": "filesystem-read", "args": {} }, "thoughtSignature": "sig-package" },
            { "functionCall": { "id": "readme", "name": "filesystem-read", "args": {} }, "thoughtSignature": "sig-readme" },
        ]).to_string();

        assert_eq!(
            replay_signed_function_call_parts(calls, Some(&signatures)),
            vec![
                json!({ "functionCall": { "id": "package", "name": "filesystem-read", "args": { "filePath": "package.json" } }, "thoughtSignature": "sig-package" }),
                json!({ "functionCall": { "id": "readme", "name": "filesystem-read", "args": { "filePath": "README.md" } }, "thoughtSignature": "sig-readme" }),
            ],
        );
    }

    #[test]
    fn replays_signature_only_parts_and_keeps_legacy_calls() {
        let calls = vec![
            json!({ "functionCall": { "id": "call-1", "name": "filesystem-read", "args": {} } }),
        ];
        let signatures = json!([
            { "thoughtSignature": "continuation-only" },
            { "functionCall": { "id": "different", "name": "filesystem-read", "args": {} }, "thoughtSignature": "unmatched" },
            { "thoughtSignature": "" },
        ]).to_string();
        assert_eq!(
            replay_signed_function_call_parts(calls.clone(), Some(&signatures)),
            vec![
                json!({ "thoughtSignature": "continuation-only" }),
                calls[0].clone(),
            ],
        );
        assert_eq!(
            replay_signed_function_call_parts(calls.clone(), None),
            calls
        );
        assert_eq!(
            replay_signed_function_call_parts(calls.clone(), Some("not json")),
            calls
        );
    }

    #[test]
    fn preserves_signature_only_model_parts_without_tool_calls() {
        let signatures = json!([
            { "text": "private reasoning", "thought": true, "thoughtSignature": "opaque" },
            { "thoughtSignature": "continuation-only" },
        ])
        .to_string();

        assert_eq!(
            replay_signed_function_call_parts(Vec::new(), Some(&signatures)),
            serde_json::from_str::<Vec<Value>>(&signatures).unwrap(),
        );
        assert!(has_replayable_gemini_signatures(Some(&signatures)));
        assert!(!has_replayable_gemini_signatures(Some("not json")));
        assert!(!has_replayable_gemini_signatures(Some("[]")));
    }
}
