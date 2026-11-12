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

pub fn resolve_interactions_endpoint(api_config: &ApiConfigRecord, api_key: &str) -> String {
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
    host_system_prompts: &[String],
) -> Result<Value> {
    let selected_model = request
        .model
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(api_config.advanced_model.as_str());
    let clean_model = selected_model
        .strip_prefix("models/")
        .unwrap_or(selected_model);

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
    // Host facts belong to system_instruction, never to role=user input.
    system_instruction_parts.extend(host_system_prompts.iter().cloned());
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
                            request.skips_inline_image_parsing(),
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
