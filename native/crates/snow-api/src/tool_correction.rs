//! Tool-call correction agent.
//!
//! When a tool call fails, the renderer asks this module for a repaired
//! argument object. The renderer owns the retry loop (at most
//! `MAX_CORRECTION_ATTEMPTS` repaired executions) and re-executes the tool
//! itself, so this module never touches tools, files or conversation state.
//!
//! The request runs as an ephemeral auxiliary completion with the active API
//! profile's **basic model** and never blocks the Node.js event loop.

use std::collections::HashMap;
use std::path::PathBuf;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde_json::Value;

use crate::api::common::truncate_chars;
use crate::api::config::{
    get_api_request_context_with_fallback, resolve_basic_model,
};
use crate::api::conversation::context::apply_configured_system_prompts;
use crate::api::responses::{ResponsesApiMessage, ResponsesApiRequest};
use tokio_util::sync::CancellationToken;

/// Maximum number of repaired executions the renderer is allowed to perform.
/// Kept here as documentation; the renderer enforces the limit.
pub const MAX_CORRECTION_ATTEMPTS: u32 = 3;

const CORRECTION_SYSTEM_PROMPT: &str = "You are a tool-call repair agent inside a coding assistant. A tool invocation failed. Your job is to repair ONLY the arguments of the SAME tool call so it can succeed.\n\nYou will receive the tool name, its description, its JSON input schema, the original arguments, the failure message, and the previously attempted repairs.\n\nRespond with ONLY one JSON object in this exact format:\n{\"retry\": true, \"arguments\": {...}, \"reasoning\": \"one short sentence\"}\n\nRules:\n- Keep the original intent. Never switch to another tool and never invent unrelated actions.\n- Fix malformed JSON, wrong field names, wrong types, invalid enum values, missing required fields, invalid paths or obviously wrong values.\n- Use only facts from the provided context. Do not invent file contents or command output.\n- The arguments value MUST be a JSON object that conforms to the input schema.\n- If the failure cannot be fixed by changing arguments (permission denied, missing binary, network failure, user rejection, or an environmental error), respond with {\"retry\": false, \"reasoning\": \"why it cannot be repaired\"}.\n- Do not include explanations outside the JSON object.";

/// One correction request from the renderer.
#[napi(object)]
pub struct ToolCorrectionRequest {
    /// Full MCP tool name, e.g. "filesystem-replace_edit".
    pub tool_name: String,
    /// Tool description shown to the main model.
    pub tool_description: String,
    /// Provider-neutral JSON schema of the tool input.
    pub input_schema_json: String,
    /// Arguments of the failed invocation, as originally emitted by the model.
    pub original_arguments_json: String,
    /// Failure text returned by the failed invocation.
    pub failure: String,
    /// Previous repaired executions as a JSON array:
    /// `[{"argumentsJson": "...", "error": "..."}]`.
    pub attempts_json: String,
    /// 1-based number of the repair being requested.
    pub attempt: i32,
    /// API profile bound to the conversation. Empty/omitted follows the
    /// globally active profile.
    pub api_profile: Option<String>,
    /// Conversation the failed tool call belongs to; expands `{{session_id}}`
    /// custom headers the same way as the main flow.
    pub conversation_id: Option<String>,
}

/// The basic model's repair decision.
#[napi(object)]
pub struct ToolCorrectionResponse {
    /// Whether the model produced a repaired argument object.
    pub retry: bool,
    /// Serialized repaired arguments (empty when `retry` is false).
    pub arguments_json: String,
    /// Short explanation of the repair or of why it is not repairable.
    pub reasoning: String,
}

pub async fn correct_tool_call(
    request: ToolCorrectionRequest,
) -> Result<ToolCorrectionResponse> {
    let tool_name = request.tool_name.trim();
    if tool_name.is_empty() {
        return Err(Error::from_reason(
            "Tool name is required for tool-call correction.",
        ));
    }

    let (database_path, api_config, custom_headers, model) =
        resolve_correction_llm_context(
            request.api_profile.as_deref(),
            request.conversation_id.as_deref().unwrap_or(""),
        )?;
    let user_content = build_correction_user_content(&request);

    let text = tokio::time::timeout(
        std::time::Duration::from_secs(60),
        request_correction_text(
            database_path,
            api_config,
            custom_headers,
            &model,
            &user_content,
        ),
    )
    .await
    .map_err(|_| Error::from_reason("Tool correction request timed out."))??;

    parse_correction_response(&text)
}

/// Resolve the conversation's API config, its custom headers and the basic
/// model. Missing profiles fall back to the globally active profile.
fn resolve_correction_llm_context(
    api_profile: Option<&str>,
    conversation_id: &str,
) -> Result<(
    PathBuf,
    crate::storage::ApiConfigRecord,
    HashMap<String, String>,
    String,
)> {
    let context = get_api_request_context_with_fallback(api_profile)?;
    let database_path = context.database_path;
    let mut api_config = context.api_config;
    crate::api::retry::apply_auxiliary_retries(&mut api_config);

    if api_config.api_key.trim().is_empty() {
        return Err(Error::from_reason(
            "API key not configured. Please configure API settings first.",
        ));
    }

    let model = resolve_basic_model(None, &api_config.basic_model)?;

    // Session placeholders resolve to the owning conversation (same as the main
    // flow); OAuth headers keep OAuth-backed profiles working.
    let mut custom_headers = context.custom_headers;
    crate::api::common::expand_custom_header_session_id(&mut custom_headers, conversation_id);
    crate::api::oauth::provider::apply_request_headers(&api_config, &mut custom_headers);

    Ok((database_path, api_config, custom_headers, model))
}

/// Send the repair prompt through the active API config and return the
/// assistant text. Mirrors the dispatch used by the codebase review agent.
/// When the profile binds system prompts they take the system slot and the
/// repair prompt is demoted to a leading user message, same as the main flow.
async fn request_correction_text(
    database_path: PathBuf,
    api_config: crate::storage::ApiConfigRecord,
    custom_headers: HashMap<String, String>,
    model: &str,
    user_content: &str,
) -> Result<String> {
    let mut correction_messages = vec![
        ResponsesApiMessage {
            role: "system".to_string(),
            origin: Some(crate::storage::services::chat_conversations::ORIGIN_INTERNAL.to_string()),
            content: CORRECTION_SYSTEM_PROMPT.to_string(),
            tool_results_json: None,
            thinking: None,
            thinking_blocks_json: None,
            tool_calls_json: None,
        },
        ResponsesApiMessage {
            role: "user".to_string(),
            origin: Some(crate::storage::services::chat_conversations::ORIGIN_INTERNAL.to_string()),
            content: user_content.to_string(),
            tool_results_json: None,
            thinking: None,
            thinking_blocks_json: None,
            tool_calls_json: None,
        },
    ];
    apply_configured_system_prompts(
        &mut correction_messages,
        &api_config.system_prompt_ids_json,
        None,
    )
    .await;
    let request = ResponsesApiRequest {
        messages: correction_messages,
        model: Some(model.to_string()),
        api_profile: None,
        conversation_id: None,
        previous_response_id: None,
        directory_id: None,
        analysis_workspace_root: None,
        checkpoint_id: None,
        context_compaction: None,
        context_fold: None,
        resume_after_compaction: None,
        retry_failed_response: None,
        sub_agent_tools_json: None,
        sub_agent_system_prompt: None,
        sub_agent_config_profile: None,
        skip_context: Some(true),
        parse_inline_images: None,
        disable_tools: Some(true),
        internal_recovery_prompt: None,
        goal_mode: None,
        worktree_mode: None,
        workflow_mode: None,
        thinking_strength: Some("none".to_string()),
        responses_fast_mode: None,
        remote_role_content: None,
        remote_include_global_rules: None,
        remote_override_builtin_prompt: None,
        execution_workspace_root: None,
        worktree_id: None,
        allowed_tools_json: None,
        plugin_tool_ids_json: None,
    };

    let method = api_config.request_method.clone();
    let cancel_token = CancellationToken::new();
    let result = crate::api::ephemeral::run(request, move |request| async move {
        match method.as_str() {
            "responses" => crate::api::responses::create_response_stream_with_context(
                request,
                database_path,
                api_config,
                custom_headers,
                None,
                cancel_token,
            )
            .await,
            "anthropic" => crate::api::anthropic::create_anthropic_response_stream(
                request,
                database_path,
                api_config,
                custom_headers,
                None,
                cancel_token,
            )
            .await,
            "gemini" | "interactions" => crate::api::gemini::create_gemini_response_stream(
                request,
                database_path,
                api_config,
                custom_headers,
                None,
                cancel_token,
            )
            .await,
            _ => crate::api::chat::create_chat_completion_response_stream(
                request,
                database_path,
                api_config,
                custom_headers,
                None,
                cancel_token,
            )
            .await,
        }
    })
    .await?;

    let text = result.content.trim().to_string();
    if text.is_empty() {
        return Err(Error::from_reason(
            "Tool correction backend returned no usable text.",
        ));
    }

    Ok(text)
}

fn build_correction_user_content(request: &ToolCorrectionRequest) -> String {
    let attempts = parse_attempts(&request.attempts_json);
    let mut content = String::new();
    content.push_str(&format!("Tool: {}\n", request.tool_name.trim()));
    content.push_str(&format!(
        "Description: {}\n",
        truncate_chars(request.tool_description.trim(), 2_000)
    ));
    content.push_str(&format!(
        "Input schema:\n{}\n",
        truncate_chars(request.input_schema_json.trim(), 12_000)
    ));
    content.push_str(&format!(
        "Original arguments:\n{}\n",
        truncate_chars(request.original_arguments_json.trim(), 8_000)
    ));
    content.push_str(&format!(
        "Failure:\n{}\n",
        truncate_chars(request.failure.trim(), 6_000)
    ));
    content.push_str(&format!(
        "Repair attempt: {}/{}\n",
        request.attempt.max(1),
        MAX_CORRECTION_ATTEMPTS
    ));

    if !attempts.is_empty() {
        content.push_str("Previous repair attempts (all failed):\n");
        for (index, attempt) in attempts.iter().enumerate() {
            let arguments = attempt
                .get("argumentsJson")
                .or_else(|| attempt.get("arguments_json"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let error = attempt
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("");
            content.push_str(&format!(
                "{}. arguments: {}\n   error: {}\n",
                index + 1,
                truncate_chars(arguments.trim(), 2_000),
                truncate_chars(error.trim(), 1_500)
            ));
        }
    }

    content
}

fn parse_attempts(raw: &str) -> Vec<Value> {
    serde_json::from_str::<Vec<Value>>(raw).unwrap_or_default()
}

/// Parse the model's repair JSON, tolerating markdown fences and surrounding
/// prose. The repaired arguments must be a JSON object.
fn parse_correction_response(text: &str) -> Result<ToolCorrectionResponse> {
    let trimmed = text.trim();
    let json_str = strip_code_fence(trimmed);
    let json_str = extract_json_object(json_str).unwrap_or(json_str);

    let parsed: Value = serde_json::from_str(json_str).map_err(|error| {
        Error::from_reason(format!(
            "Failed to parse tool correction response as JSON: {}. Raw text: {}",
            error,
            truncate_chars(text, 300)
        ))
    })?;

    let retry = parsed.get("retry").and_then(Value::as_bool).unwrap_or(false);
    let reasoning = parsed
        .get("reasoning")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();

    if !retry {
        return Ok(ToolCorrectionResponse {
            retry: false,
            arguments_json: String::new(),
            reasoning,
        });
    }

    let arguments = parsed
        .get("arguments")
        .or_else(|| parsed.get("argumentsJson"))
        .or_else(|| parsed.get("arguments_json"));

    let normalized = match arguments {
        Some(Value::String(raw)) => serde_json::from_str::<Value>(raw).ok(),
        Some(value @ Value::Object(_)) => Some(value.clone()),
        _ => None,
    };

    let Some(value @ Value::Object(_)) = normalized else {
        return Err(Error::from_reason(
            "Tool correction response did not contain a JSON object of arguments.",
        ));
    };

    let arguments_json = serde_json::to_string(&value).map_err(|error| {
        Error::from_reason(format!(
            "Failed to serialize corrected tool arguments: {}",
            error
        ))
    })?;

    Ok(ToolCorrectionResponse {
        retry: true,
        arguments_json,
        reasoning,
    })
}

fn strip_code_fence(text: &str) -> &str {
    let without_open = if let Some(rest) = text.strip_prefix("```json") {
        rest
    } else if let Some(rest) = text.strip_prefix("```JSON") {
        rest
    } else if let Some(rest) = text.strip_prefix("```") {
        rest
    } else {
        return text;
    };
    without_open
        .strip_suffix("```")
        .map(str::trim)
        .unwrap_or_else(|| without_open.trim())
}

fn extract_json_object(text: &str) -> Option<&str> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    if end >= start {
        Some(&text[start..=end])
    } else {
        None
    }
}
