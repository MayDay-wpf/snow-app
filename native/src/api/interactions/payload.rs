//! Google Interactions API payload construction and endpoint resolution.

use std::collections::{HashMap, VecDeque};
use std::path::Path;

use napi::bindgen_prelude::*;
use serde_json::{json, Value};

use crate::api::config::{normalize_base_url, resolve_sdk_api_base_url, DEFAULT_OPENAI_BASE_URL};
use crate::api::conversation::parse_chat_message_content;
use crate::api::conversation::tool_messages::{
    normalize_tool_calls, parse_tool_results_with_images,
};
use crate::api::gemini::payload::{
    build_gemini_thinking_config, should_include_gemini_google_search,
};
use crate::api::responses::ResponsesApiRequest;
use crate::storage::services::chat_conversations::ChatContextMessage;
use crate::storage::ApiConfigRecord;

pub const DEFAULT_INTERACTIONS_BASE_URL: &str = "https://generativelanguage.googleapis.com";

pub(crate) fn resolve_interactions_endpoint(api_config: &ApiConfigRecord, api_key: &str) -> String {
    let normalized_base_url = normalize_base_url(&api_config.base_url);
    let base_url =
        if normalized_base_url.is_empty() || normalized_base_url == DEFAULT_OPENAI_BASE_URL {
            DEFAULT_INTERACTIONS_BASE_URL.to_string()
        } else {
            normalized_base_url
        };

    let resolved_base = if api_config.base_url_mode == "endpoint" {
        base_url
    } else {
        resolve_sdk_api_base_url(&base_url, &api_config.base_url_mode)
    };

    let base_trimmed = resolved_base.trim_end_matches('/');
    let mut url = if base_trimmed.ends_with("/interactions") {
        format!("{base_trimmed}?alt=sse")
    } else if base_trimmed.ends_with("/v1beta") || base_trimmed.ends_with("/v1") {
        format!("{base_trimmed}/interactions?alt=sse")
    } else {
        format!("{base_trimmed}/v1beta/interactions?alt=sse")
    };

    if !api_key.is_empty() && !url.contains("&key=") && !url.contains("?key=") {
        url.push_str(&format!("&key={}", api_key));
    }

    url
}

pub(super) fn build_interactions_payload(
    messages: &[ChatContextMessage],
    database_path: &Path,
    request: &ResponsesApiRequest,
    api_config: &ApiConfigRecord,
    tools: Option<Value>,
    user_system_prompts: &[String],
) -> Result<Value> {
    let clean_model = request
        .model
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(api_config.advanced_model.as_str())
        .strip_prefix("models/")
        .unwrap_or(&api_config.advanced_model);

    // The proxy may route this request through ordinary Gemini, so replay
    // complete call/result pairs instead of relying only on interaction state.
    let mut input_parts = Vec::new();
    let paired_tools = pair_interactions_tool_history(messages, database_path, request);

    for (message_index, message) in messages.iter().enumerate() {
        let content = message.content.trim();
        let role = message.role.trim();

        if role == "tool" {
            continue;
        }

        if content.is_empty() && !paired_tools.pairs.contains_key(&message_index) {
            continue;
        }

        if !content.is_empty() {
            let parsed_content = parse_chat_message_content(content, database_path)?;
            if !parsed_content.text.is_empty() {
                input_parts.push(json!({
                    "type": "text",
                    "text": parsed_content.text,
                    "role": role,
                }));
            }
            for image in &parsed_content.images {
                input_parts.push(json!({
                    "type": "image",
                    "inline_data": {
                        "mime_type": image.media_type,
                        "data": image.data,
                    }
                }));
            }
        }

        if let Some(pairs) = paired_tools.pairs.get(&message_index) {
            for pair in pairs {
                let call = &pair.call;
                input_parts.push(json!({
                    "type": "function_call",
                    "id": call.id,
                    "name": call.name,
                    "arguments": call.arguments,
                }));
                let result = &pair.result;
                let result_text = if result.text.is_empty() {
                    if result.images.is_empty() {
                        "ok"
                    } else {
                        "[image attached]"
                    }
                } else {
                    result.text.as_str()
                };
                input_parts.push(json!({
                    "type": "function_result",
                    "call_id": result.call_id,
                    "name": result.name,
                    "result": { "result": result_text },
                }));
                for image in &result.images {
                    input_parts.push(json!({
                        "type": "image",
                        "inline_data": {
                            "mime_type": image.media_type,
                            "data": image.data,
                        }
                    }));
                }
            }
        }
    }

    if input_parts.is_empty() {
        return Err(Error::from_reason("Chat message content is required"));
    }

    let mut payload = json!({
        "model": clean_model,
        "stream": true,
        "input": input_parts,
    });

    // Previous interaction ID (for stateful continuity)
    if !paired_tools.has_pairs() {
        if let Some(prev_id) = request
            .previous_response_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
        {
            payload["previous_interaction_id"] = json!(prev_id);
        }
    }

    // The configured proxy accepts a single snake_case Gemini Tool object.
    let mut tool_entries = Vec::new();
    if let Some(tools_val) = tools {
        if let Some(arr) = tools_val.as_array() {
            tool_entries.extend(arr.iter().cloned());
        }
    }

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
    let has_function_tools = tool_entries.iter().any(|entry| {
        entry
            .get("function_declarations")
            .and_then(Value::as_array)
            .is_some_and(|declarations| !declarations.is_empty())
    });
    let include_google_search = google_search_enabled && !(is_cli_proxy_api && has_function_tools);
    if include_google_search {
        // Keep server-side and function tools as separate Tool objects. CPA
        // rejects a single object that mixes google_search with function
        // declarations even when tool_config is present.
        tool_entries.push(json!({ "google_search": {} }));
    }

    if !tool_entries.is_empty() {
        payload["tools"] = Value::Array(tool_entries);
    }

    if (include_google_search && has_function_tools) || (is_cli_proxy_api && has_function_tools) {
        payload["tool_config"] = json!({
            "include_server_side_tool_invocations": true
        });
        payload["toolConfig"] = json!({
            "includeServerSideToolInvocations": true
        });
    }

    // System instruction
    let mut system_instruction_parts = user_system_prompts.to_vec();
    if let Some(prompt) = request
        .internal_recovery_prompt
        .as_deref()
        .map(str::trim)
        .filter(|prompt| !prompt.is_empty())
    {
        system_instruction_parts.push(prompt.to_string());
    }
    if !system_instruction_parts.is_empty() {
        payload["system_instruction"] = json!({
            "parts": [{ "text": system_instruction_parts.join("\n\n") }]
        });
    }

    // Generation configuration (thinking, max output tokens, etc.)
    let mut generation_config = json!({});
    if let Some(mut thinking_config) = build_gemini_thinking_config(&api_config.config_json) {
        if let Some(level) = thinking_config
            .get("thinkingLevel")
            .and_then(Value::as_str)
            .map(str::to_string)
        {
            thinking_config["thinking_level"] = json!(level.clone());
            generation_config["thinking_level"] = json!(level);
        }
        generation_config["thinking_summaries"] = json!("auto");
        generation_config["thinking_config"] = thinking_config;
    }
    if let Some(max_tokens) = api_config.max_tokens {
        if max_tokens > 0 {
            generation_config["max_output_tokens"] = json!(max_tokens);
        }
    }

    if generation_config
        .as_object()
        .map_or(false, |o| !o.is_empty())
    {
        payload["generation_config"] = generation_config;
    }

    Ok(payload)
}

#[derive(Default)]
struct PairedToolHistory {
    pairs: HashMap<usize, Vec<PairedFunctionExchange>>,
}

impl PairedToolHistory {
    fn has_pairs(&self) -> bool {
        !self.pairs.is_empty()
    }
}

struct PairedFunctionExchange {
    call: PairedFunctionCall,
    result: PairedFunctionResult,
}

struct PairedFunctionCall {
    id: String,
    name: String,
    arguments: Value,
}

struct PairedFunctionResult {
    call_id: String,
    name: String,
    text: String,
    images: Vec<crate::api::conversation::ChatImage>,
}

fn pair_interactions_tool_history(
    messages: &[ChatContextMessage],
    database_path: &Path,
    request: &ResponsesApiRequest,
) -> PairedToolHistory {
    let mut pending: HashMap<(String, String), VecDeque<(usize, usize)>> = HashMap::new();
    let mut calls_by_message = HashMap::new();
    let mut matched_results: HashMap<(usize, usize), PairedFunctionResult> = HashMap::new();

    for (message_index, message) in messages.iter().enumerate() {
        match message.role.trim() {
            "assistant" => {
                // A new model turn cannot complete calls left unresolved by an
                // earlier model turn.
                pending.clear();
                let calls = message
                    .tool_calls_json
                    .as_deref()
                    .map(normalize_tool_calls)
                    .unwrap_or_default();
                for (call_index, call) in calls.iter().enumerate() {
                    if !call.has_valid_name || !call.has_valid_input {
                        continue;
                    }
                    pending
                        .entry((call.id.clone(), call.name.clone()))
                        .or_default()
                        .push_back((message_index, call_index));
                }
                calls_by_message.insert(message_index, calls);
            }
            "tool" => {
                let results = message
                    .tool_results_json
                    .as_deref()
                    .map(|raw| {
                        parse_tool_results_with_images(
                            raw,
                            database_path,
                            request.skip_context.unwrap_or(false),
                        )
                    })
                    .unwrap_or_default();
                for result in results {
                    if !result.has_valid_shape {
                        continue;
                    }
                    let key = (result.call_id.clone(), result.name.clone());
                    if key.0.trim().is_empty() || key.1.trim().is_empty() {
                        continue;
                    }
                    let Some(call_position) = pending.get_mut(&key).and_then(VecDeque::pop_front)
                    else {
                        continue;
                    };
                    matched_results.insert(
                        call_position,
                        PairedFunctionResult {
                            call_id: result.call_id,
                            name: result.name,
                            text: result.text,
                            images: result.images,
                        },
                    );
                }
            }
            _ => pending.clear(),
        }
    }

    let pairs = calls_by_message
        .into_iter()
        .filter_map(|(message_index, calls)| {
            let matched = calls
                .into_iter()
                .enumerate()
                .filter_map(|(call_index, call)| {
                    let result = matched_results.remove(&(message_index, call_index))?;
                    Some(PairedFunctionExchange {
                        call: PairedFunctionCall {
                            id: call.id,
                            name: call.name,
                            arguments: call.input,
                        },
                        result,
                    })
                })
                .collect::<Vec<_>>();
            (!matched.is_empty()).then_some((message_index, matched))
        })
        .collect();

    PairedToolHistory { pairs }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_request() -> ResponsesApiRequest {
        ResponsesApiRequest {
            messages: Vec::new(),
            model: Some("gemini-3.7-flash".to_string()),
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
            remote_role_content: None,
            remote_include_global_rules: None,
        }
    }

    fn create_test_message() -> ChatContextMessage {
        ChatContextMessage {
            role: "user".to_string(),
            content: "Read package.json".to_string(),
            tool_calls_json: None,
            tool_results_json: None,
            thinking: None,
            thinking_blocks_json: None,
        }
    }

    fn message(
        role: &str,
        content: &str,
        tool_calls_json: Option<Value>,
        tool_results_json: Option<Value>,
    ) -> ChatContextMessage {
        ChatContextMessage {
            role: role.to_string(),
            content: content.to_string(),
            tool_calls_json: tool_calls_json.map(|value| value.to_string()),
            tool_results_json: tool_results_json.map(|value| value.to_string()),
            thinking: None,
            thinking_blocks_json: None,
        }
    }

    fn create_test_record(base_url: &str) -> ApiConfigRecord {
        ApiConfigRecord {
            id: "1".to_string(),
            profile_name: "default".to_string(),
            display_name: "Default".to_string(),
            is_active: true,
            base_url: base_url.to_string(),
            base_url_mode: "default".to_string(),
            api_key: "test-key".to_string(),
            request_method: "interactions".to_string(),
            advanced_model: "gemini-3.7-flash".to_string(),
            basic_model: "gemini-3.7-flash".to_string(),
            supports_vision: true,
            vision_base_url: "".to_string(),
            vision_base_url_mode: "default".to_string(),
            vision_api_key: "".to_string(),
            vision_request_method: "interactions".to_string(),
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

    #[test]
    fn test_resolve_interactions_endpoint() {
        let config = create_test_record("");
        let ep = resolve_interactions_endpoint(&config, "test-key");
        assert_eq!(
            ep,
            "https://generativelanguage.googleapis.com/v1beta/interactions?alt=sse&key=test-key"
        );

        let config2 = create_test_record("http://localhost:8317/v1beta");
        let ep2 = resolve_interactions_endpoint(&config2, "local-key");
        assert_eq!(
            ep2,
            "http://localhost:8317/v1beta/interactions?alt=sse&key=local-key"
        );
    }

    #[test]
    fn requests_interactions_thinking_summaries_when_thinking_is_enabled() {
        let mut config = create_test_record("");
        config.config_json = json!({
            "snowcfg": {
                "geminiThinking": {
                    "enabled": true,
                    "thinkingLevel": "high"
                }
            }
        })
        .to_string();

        let payload = build_interactions_payload(
            &[create_test_message()],
            Path::new("."),
            &create_test_request(),
            &config,
            None,
            &[],
        )
        .expect("Interactions payload");

        assert_eq!(payload["generation_config"]["thinking_level"], "high");
        assert_eq!(payload["generation_config"]["thinking_summaries"], "auto");
        assert_eq!(
            payload["generation_config"]["thinking_config"],
            json!({
                "thinkingLevel": "high",
                "includeThoughts": true,
                "thinking_level": "high"
            })
        );
    }

    #[test]
    fn omits_interactions_thinking_fields_when_thinking_is_disabled() {
        let payload = build_interactions_payload(
            &[create_test_message()],
            Path::new("."),
            &create_test_request(),
            &create_test_record(""),
            None,
            &[],
        )
        .expect("Interactions payload");

        assert!(payload.get("generation_config").is_none());
    }

    #[test]
    fn internal_recovery_prompt_is_an_interactions_system_instruction() {
        let mut request = create_test_request();
        request.internal_recovery_prompt =
            Some("Use completed results and answer without tools.".to_string());
        let payload = build_interactions_payload(
            &[create_test_message()],
            Path::new("."),
            &request,
            &create_test_record(""),
            None,
            &["configured system rule".to_string()],
        )
        .expect("Interactions payload");

        assert_eq!(
            payload["system_instruction"],
            json!({"parts": [{"text": "configured system rule\n\nUse completed results and answer without tools."}]})
        );
        assert!(payload["input"]
            .as_array()
            .expect("input array")
            .iter()
            .all(|entry| entry["text"] != "Use completed results and answer without tools."));
    }

    #[test]
    fn builds_one_grouped_function_and_google_search_tool_object() {
        let mut config = create_test_record("");
        config.config_json = json!({
            "snowcfg": {
                "googleSearch": true
            }
        })
        .to_string();
        let tools = json!([
            {
                "function_declarations": [
                    {
                        "name": "todo-todo-manage",
                        "description": "Manage todos",
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "action": { "type": "string" }
                            },
                            "required": ["action"]
                        }
                    },
                    {
                        "name": "filesystem-read",
                        "description": "Read a file",
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "filePath": { "type": "string" }
                            },
                            "required": ["filePath"]
                        }
                    },
                ]
            }
        ]);

        let payload = build_interactions_payload(
            &[create_test_message()],
            Path::new("."),
            &create_test_request(),
            &config,
            Some(tools),
            &[],
        )
        .expect("Interactions payload");
        let tool_entries = payload["tools"].as_array().expect("tools array");
        let declarations = tool_entries[0]["function_declarations"]
            .as_array()
            .expect("function declarations");

        assert_eq!(tool_entries.len(), 2);
        assert!(tool_entries[0].get("type").is_none());
        assert_eq!(declarations.len(), 2);
        assert_eq!(declarations[0]["name"], "todo-todo-manage");
        assert_eq!(declarations[0]["parameters"]["required"], json!(["action"]));
        assert_eq!(
            declarations[0]["parameters"]["properties"]["action"]["type"],
            "string"
        );
        assert_eq!(declarations[1]["name"], "filesystem-read");
        assert_eq!(
            declarations[1]["parameters"]["required"],
            json!(["filePath"])
        );
        assert_eq!(
            declarations[1]["parameters"]["properties"]["filePath"]["type"],
            "string"
        );
        assert_eq!(tool_entries[1]["google_search"], json!({}));
        assert!(tool_entries[1].get("function_declarations").is_none());
        assert_eq!(
            payload["tool_config"],
            json!({ "include_server_side_tool_invocations": true })
        );
        assert_eq!(
            payload["toolConfig"],
            json!({ "includeServerSideToolInvocations": true })
        );
    }

    #[test]
    fn builds_google_search_only_without_a_type_discriminator() {
        let mut config = create_test_record("");
        config.config_json = json!({
            "snowcfg": {
                "googleSearch": true
            }
        })
        .to_string();

        let payload = build_interactions_payload(
            &[create_test_message()],
            Path::new("."),
            &create_test_request(),
            &config,
            None,
            &[],
        )
        .expect("Interactions payload");

        assert_eq!(payload["tools"], json!([{ "google_search": {} }]));
        assert!(payload["tools"][0].get("type").is_none());
        assert!(payload.get("tool_config").is_none());
        assert!(payload.get("toolConfig").is_none());
    }

    #[test]
    fn does_not_add_google_search_when_it_is_disabled() {
        let config = create_test_record("");
        let tools = json!([{
            "function_declarations": [{
                "name": "filesystem-read",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "filePath": { "type": "string" }
                    },
                    "required": ["filePath"]
                }
            }]
        }]);

        let payload = build_interactions_payload(
            &[create_test_message()],
            Path::new("."),
            &create_test_request(),
            &config,
            Some(tools.clone()),
            &[],
        )
        .expect("Interactions payload");

        assert_eq!(payload["tools"], tools);
        assert!(payload["tools"][0].get("google_search").is_none());
        assert!(payload["tools"][0].get("type").is_none());
        assert!(payload.get("tool_config").is_none());
        assert!(payload.get("toolConfig").is_none());
    }

    #[test]
    fn does_not_enable_server_side_invocations_for_empty_or_malformed_tools() {
        let mut config = create_test_record("");
        config.config_json = json!({
            "snowcfg": {
                "googleSearch": true
            }
        })
        .to_string();

        let cases = [
            None,
            Some(json!([])),
            Some(json!({
                "function_declarations": [{ "name": "ignored-non-array" }]
            })),
            Some(json!([{ "function_declarations": [] }])),
            Some(json!([null])),
        ];

        for tools in cases {
            let payload = build_interactions_payload(
                &[create_test_message()],
                Path::new("."),
                &create_test_request(),
                &config,
                tools,
                &[],
            )
            .expect("Interactions payload");

            assert!(payload.get("tools").is_some());
            assert!(payload.get("tool_config").is_none());
            assert!(payload.get("toolConfig").is_none());
        }
    }

    #[test]
    fn replays_ordered_id_and_name_matched_function_pairs() {
        let messages = vec![
            message("user", "Inspect the project", None, None),
            message(
                "assistant",
                "",
                Some(json!([
                    {
                        "type": "function_call",
                        "id": "call-1",
                        "name": "filesystem-read",
                        "arguments": { "filePath": "package.json" }
                    },
                    {
                        "type": "function_call",
                        "id": "call-2",
                        "name": "filesystem-read",
                        "arguments": { "filePath": "native/Cargo.toml" }
                    }
                ])),
                None,
            ),
            message(
                "tool",
                "",
                None,
                Some(json!([
                    {
                        "name": "filesystem-read",
                        "callId": "call-1",
                        "result": "package result"
                    },
                    {
                        "name": "filesystem-read",
                        "callId": "call-2",
                        "result": "cargo result"
                    }
                ])),
            ),
            message("user", "Continue", None, None),
        ];
        let payload = build_interactions_payload(
            &messages,
            Path::new("."),
            &create_test_request(),
            &create_test_record(""),
            None,
            &[],
        )
        .expect("Interactions payload");
        let input = payload["input"].as_array().expect("input array");

        assert_eq!(
            input
                .iter()
                .map(|step| step["type"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec![
                "text",
                "function_call",
                "function_result",
                "function_call",
                "function_result",
                "text"
            ]
        );
        assert_eq!(input[1]["id"], "call-1");
        assert_eq!(input[1]["name"], "filesystem-read");
        assert_eq!(input[1]["arguments"], json!({ "filePath": "package.json" }));
        assert_eq!(input[2]["call_id"], "call-1");
        assert_eq!(input[2]["name"], "filesystem-read");
        assert_eq!(input[2]["result"], json!({ "result": "package result" }));
        assert_eq!(input[3]["id"], "call-2");
        assert_eq!(input[4]["call_id"], "call-2");
        assert!(payload.get("previous_interaction_id").is_none());
    }

    #[test]
    fn pairs_repeated_same_name_calls_by_distinct_ids() {
        let messages = vec![
            message("user", "Read both", None, None),
            message(
                "assistant",
                "",
                Some(json!([
                    {
                        "type": "function_call",
                        "id": "first",
                        "name": "filesystem-read",
                        "arguments": "{\"filePath\":\"one.txt\"}"
                    },
                    {
                        "type": "function_call",
                        "id": "second",
                        "name": "filesystem-read",
                        "arguments": {}
                    }
                ])),
                None,
            ),
            message(
                "tool",
                "",
                None,
                Some(json!([
                    { "name": "filesystem-read", "callId": "first", "result": "one" },
                    { "name": "filesystem-read", "callId": "second", "result": "two" }
                ])),
            ),
        ];
        let payload = build_interactions_payload(
            &messages,
            Path::new("."),
            &create_test_request(),
            &create_test_record(""),
            None,
            &[],
        )
        .expect("Interactions payload");
        let input = payload["input"].as_array().expect("input array");

        assert_eq!(input[1]["id"], "first");
        assert_eq!(input[1]["arguments"], json!({ "filePath": "one.txt" }));
        assert_eq!(input[2]["call_id"], "first");
        assert_eq!(input[3]["id"], "second");
        assert_eq!(input[3]["arguments"], json!({}));
        assert_eq!(input[4]["call_id"], "second");
    }

    #[test]
    fn omits_orphan_mismatched_and_malformed_tool_history() {
        let messages = vec![
            message("user", "Inspect", None, None),
            message(
                "assistant",
                "",
                Some(json!([
                    {
                        "type": "function_call",
                        "id": "orphan-call",
                        "name": "filesystem-read",
                        "arguments": { "filePath": "missing.txt" }
                    },
                    {
                        "type": "function_call",
                        "id": "wrong-name",
                        "name": "filesystem-read",
                        "arguments": { "filePath": "wrong.txt" }
                    },
                    {
                        "type": "function_call",
                        "id": "malformed",
                        "name": "filesystem-read",
                        "arguments": "{\"filePath\":"
                    },
                    {
                        "type": "function_call",
                        "id": "missing-result",
                        "name": "filesystem-read",
                        "arguments": {}
                    }
                ])),
                None,
            ),
            message(
                "tool",
                "",
                None,
                Some(json!([
                    { "name": "todo-todo-manage", "callId": "wrong-name", "result": "wrong" },
                    { "name": "filesystem-read", "callId": "orphan-result", "result": "orphan" },
                    { "name": "filesystem-read", "callId": "malformed", "result": "unsafe" },
                    { "name": "filesystem-read", "callId": "missing-result" }
                ])),
            ),
            ChatContextMessage {
                role: "assistant".to_string(),
                content: String::new(),
                tool_calls_json: Some("not-json".to_string()),
                tool_results_json: None,
                thinking: None,
                thinking_blocks_json: None,
            },
            ChatContextMessage {
                role: "tool".to_string(),
                content: String::new(),
                tool_calls_json: None,
                tool_results_json: Some("not-json".to_string()),
                thinking: None,
                thinking_blocks_json: None,
            },
        ];
        let mut request = create_test_request();
        request.previous_response_id = Some("interaction-stateful".to_string());
        let payload = build_interactions_payload(
            &messages,
            Path::new("."),
            &request,
            &create_test_record(""),
            None,
            &[],
        )
        .expect("Interactions payload");
        let input = payload["input"].as_array().expect("input array");

        assert_eq!(input.len(), 1);
        assert_eq!(input[0]["type"], "text");
        assert_eq!(payload["previous_interaction_id"], "interaction-stateful");
    }

    #[test]
    fn stateless_pairs_take_precedence_over_previous_interaction_id() {
        let messages = vec![
            message("user", "Inspect", None, None),
            message(
                "assistant",
                "",
                Some(json!([{
                    "type": "function_call",
                    "id": "call-1",
                    "name": "filesystem-read",
                    "arguments": { "filePath": "package.json" }
                }])),
                None,
            ),
            message(
                "tool",
                "",
                None,
                Some(json!([{
                    "name": "filesystem-read",
                    "callId": "call-1",
                    "result": "done"
                }])),
            ),
        ];
        let mut request = create_test_request();
        request.previous_response_id = Some("interaction-previous".to_string());
        let payload = build_interactions_payload(
            &messages,
            Path::new("."),
            &request,
            &create_test_record(""),
            None,
            &[],
        )
        .expect("Interactions payload");

        assert!(payload.get("previous_interaction_id").is_none());
        assert_eq!(payload["input"][1]["type"], "function_call");
        assert_eq!(payload["input"][2]["type"], "function_result");
    }

    #[test]
    fn rejects_result_before_call_without_retroactive_pairing() {
        let messages = vec![
            message("user", "Inspect", None, None),
            message(
                "tool",
                "",
                None,
                Some(json!([{
                    "name": "filesystem-read",
                    "callId": "call-late",
                    "result": "must not be replayed"
                }])),
            ),
            message(
                "assistant",
                "",
                Some(json!([{
                    "type": "function_call",
                    "id": "call-late",
                    "name": "filesystem-read",
                    "arguments": {}
                }])),
                None,
            ),
            message("user", "Continue", None, None),
        ];
        let payload = build_interactions_payload(
            &messages,
            Path::new("."),
            &create_test_request(),
            &create_test_record(""),
            None,
            &[],
        )
        .expect("Interactions payload");
        let input = payload["input"].as_array().expect("input array");

        assert_eq!(input.len(), 2);
        assert!(input.iter().all(|step| {
            !matches!(
                step["type"].as_str(),
                Some("function_call" | "function_result")
            )
        }));
    }

    #[test]
    fn keeps_each_call_with_its_result_and_images_before_the_next_call() {
        let messages = vec![
            message("user", "Inspect", None, None),
            message(
                "assistant",
                "",
                Some(json!([
                    {
                        "type": "function_call",
                        "id": "image-call",
                        "name": "browser-screenshot",
                        "arguments": {}
                    },
                    {
                        "type": "function_call",
                        "id": "text-call",
                        "name": "filesystem-read",
                        "arguments": {}
                    }
                ])),
                None,
            ),
            message(
                "tool",
                "",
                None,
                Some(json!([
                    {
                        "name": "browser-screenshot",
                        "callId": "image-call",
                        "result": "captured @@image:data:image/png;base64,YQ==@@"
                    },
                    {
                        "name": "filesystem-read",
                        "callId": "text-call",
                        "result": "done"
                    }
                ])),
            ),
        ];
        let payload = build_interactions_payload(
            &messages,
            Path::new("."),
            &create_test_request(),
            &create_test_record(""),
            None,
            &[],
        )
        .expect("Interactions payload");
        let input = payload["input"].as_array().expect("input array");
        let types = input
            .iter()
            .map(|step| step["type"].as_str().expect("step type"))
            .collect::<Vec<_>>();

        assert_eq!(
            types,
            vec![
                "text",
                "function_call",
                "function_result",
                "image",
                "function_call",
                "function_result"
            ]
        );
        assert_eq!(input[2]["call_id"], "image-call");
        assert_eq!(
            input[2]["result"],
            json!({ "result": "captured [Image #1]" })
        );
        assert_eq!(input[3]["inline_data"]["mime_type"], "image/png");
        assert_eq!(input[3]["inline_data"]["data"], "YQ==");
        assert_eq!(input[4]["id"], "text-call");
        assert_eq!(input[5]["call_id"], "text-call");
    }
}
