//! AI-powered commit message generation.
//!
//! Reuses the existing four provider stream functions (chat / responses /
//! anthropic / gemini) so that whichever `request_method` the active API
//! config uses, the request is dispatched correctly.
//!
//! Unlike the normal chat flow this module:
//! - Uses the **basic model** instead of the advanced model.
//! - Sets `skip_context`, so providers do not persist anything to the
//!   conversation database, do not load context history, do not inject the
//!   built-in system prompt and do not resolve MCP tools.
//! - Only adds the user's configured API profile system prompts, if any.

use napi::bindgen_prelude::*;
use tokio_util::sync::CancellationToken;

use crate::api::anthropic::create_anthropic_response_stream;
use crate::api::chat::create_chat_completion_response_stream;
use crate::api::config::{get_active_api_request_context, resolve_basic_model};
use crate::api::conversation::context::apply_configured_system_prompts;
use crate::api::gemini::create_gemini_response_stream;
use crate::api::responses::{
    create_response_stream_with_context, ResponsesApiRequest, ResponsesApiResult,
    ResponsesApiStreamCallback,
};

const COMMIT_SYSTEM_PROMPT: &str = "\
You are a helpful assistant that writes concise, meaningful git commit messages using the Conventional Commits format. \
Based on the provided staged diff, generate a commit message following these rules:\n\
1. The first line is the header, in the form \"type: summary\" or \"type(scope): summary\", where type must be one of feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert, chosen to best match the changes.\n\
2. The summary is a concise imperative-mood description (max 72 characters) without a trailing period, e.g. \"feat: add user login\" or \"fix: handle empty staged diff\".\n\
3. If more detail is needed, leave a blank line after the header and add a body explaining what and why (not how).\n\
4. Output plain text only: never wrap the message in markdown code fences or backticks, never add quotes around it, and never add prefixes like \"AI:\" or explanations about your reasoning.\n\
5. Output only the commit message, nothing else.\n\
6. The user may attach a note stating a preference (language, tone, length, type or scope) or an incomplete draft. It always has the highest priority: follow it, and refine a supplied draft instead of writing an unrelated message. A language requested in the note overrides rule 7.\n\
7. When no language is requested, write the commit message in the same language as the code changes and comments.\n\
8. Never mention, quote or restate the user's note in the output.";

fn strip_code_fence(raw: &str) -> String {
    let mut text = raw.trim();
    if let Some(rest) = text.strip_prefix("```") {
        let rest = rest.split_once('\n').map_or(rest, |(_, body)| body);
        text = rest.trim_end().strip_suffix("```").unwrap_or(rest);
    }
    text.trim().to_string()
}

/// Build a `ResponsesApiRequest` for commit-message generation, forcing the
/// basic model. `hint` is the text the user left in the commit message box:
/// it is treated as a preference (language, tone, ...) or a draft to refine.
fn build_request(staged_diff: &str, hint: &str) -> ResponsesApiRequest {
    let hint = hint.trim();
    let mut user_content = format!("Here is the staged diff:\n\n```\n{staged_diff}\n```");
    if !hint.is_empty() {
        user_content.push_str(&format!(
            "\n\nThe user's note for this commit message (a preference and/or draft; follow it and never repeat it in the output):\n\n```\n{hint}\n```"
        ));
    }

    ResponsesApiRequest {
        messages: vec![
            crate::api::responses::ResponsesApiMessage {
                role: "system".to_string(),
                origin: Some(crate::storage::services::chat_conversations::ORIGIN_INTERNAL.to_string()),
                content: COMMIT_SYSTEM_PROMPT.to_string(),
                tool_results_json: None,
                thinking: None,
                thinking_blocks_json: None,
                tool_calls_json: None,
            },
            crate::api::responses::ResponsesApiMessage {
                role: "user".to_string(),
                origin: Some(crate::storage::services::chat_conversations::ORIGIN_INTERNAL.to_string()),
                content: user_content,
                tool_results_json: None,
                thinking: None,
                thinking_blocks_json: None,
                tool_calls_json: None,
            },
        ],
        // Force the basic model for this lightweight task.
        model: None, // will be set after resolving context
        api_profile: None,
        conversation_id: None,
        previous_response_id: None,
        directory_id: None,
        analysis_workspace_root: None,
        checkpoint_id: None,
        context_compaction: None,
        resume_after_compaction: None,
        retry_failed_response: None,
        sub_agent_tools_json: None,
        sub_agent_system_prompt: None,
        sub_agent_config_profile: None,
        skip_context: Some(true),
        parse_inline_images: None,
        disable_tools: None,
        internal_recovery_prompt: None,
                goal_mode: None,
        worktree_mode: None,
        workflow_mode: None,
        thinking_strength: None,
        responses_fast_mode: None,
        remote_role_content: None,
        remote_include_global_rules: None,
        remote_override_builtin_prompt: None,
        execution_workspace_root: None,
        worktree_id: None,
        allowed_tools_json: None,
        plugin_tool_ids_json: None,
    }
}

/// Generate a commit message by streaming from the active API config's basic
/// model via whichever provider the config specifies.
///
/// `hint` is the text the user typed in the commit message box before asking
/// for generation; it is forwarded to the model as a preference note or draft.
///
/// Returns the `ResponsesApiResult` (we only care about `.content`).
pub async fn generate_commit_message_stream(
    staged_diff: String,
    hint: String,
    on_chunk: ResponsesApiStreamCallback,
    cancel_token: CancellationToken,
) -> Result<ResponsesApiResult> {
    // 偏好提示只是短文本，超长（历史草稿误粘贴）时截断，避免撑爆 prompt。
    const MAX_HINT_CHARS: usize = 4000;
    let hint: String = hint.trim().chars().take(MAX_HINT_CHARS).collect();

    // --- 1. Resolve active API config ---
    let context = tokio::task::spawn_blocking(get_active_api_request_context)
        .await
        .map_err(|join_error| {
            Error::from_reason(format!("Failed to resolve API configuration: {join_error}"))
        })??;

    let api_config = &context.api_config;

    // --- 2. Validate config ---
    let api_key = api_config.api_key.trim();
    if api_key.is_empty() {
        return Err(Error::from_reason(
            "API key not configured. Please configure API settings first.",
        ));
    }

    let basic_model = resolve_basic_model(None, &api_config.basic_model)?;

    // --- 3. Build request with basic model ---
    let mut request = build_request(&staged_diff, &hint);
    request.model = Some(basic_model);
    apply_configured_system_prompts(
        &mut request.messages,
        &api_config.system_prompt_ids_json,
        None,
    )
    .await;

    // --- 4. Dispatch to the correct provider ---
    // We reuse the four provider stream functions directly. With
    // `skip_context` set, each provider skips history loading, built-in
    // prompt injection and conversation persistence.
    let request_method = context.api_config.request_method.clone();
    let database_path = context.database_path;
    let mut api_config = context.api_config;
    crate::api::retry::apply_auxiliary_retries(&mut api_config);
    let custom_headers = context.custom_headers;

    // Disable thinking/reasoning for all providers — commit message
    // generation is a lightweight task that does not need extended thinking.
    {
        let mut config_value: serde_json::Value =
            serde_json::from_str(&api_config.config_json).unwrap_or_else(|_| serde_json::json!({}));
        if let Some(snowcfg) = config_value.as_object_mut().and_then(|obj| {
            obj.entry("snowcfg")
                .or_insert_with(|| serde_json::json!({}))
                .as_object_mut()
        }) {
            snowcfg.insert("chatThinking".into(), serde_json::json!({"enabled": false}));
            snowcfg.insert(
                "responsesReasoning".into(),
                serde_json::json!({"enabled": false}),
            );
            snowcfg.insert("thinking".into(), serde_json::json!({"enabled": false}));
            snowcfg.insert(
                "geminiThinking".into(),
                serde_json::json!({"enabled": false}),
            );
        }
        api_config.config_json =
            serde_json::to_string(&config_value).unwrap_or(api_config.config_json);
    }

    let result = match request_method.as_str() {
        "chat" => {
            create_chat_completion_response_stream(
                request,
                database_path,
                api_config,
        custom_headers,
        Some(on_chunk),
        cancel_token,
            )
            .await
        }
        "responses" => {
            create_response_stream_with_context(
                request,
                database_path,
                api_config,
        custom_headers,
        Some(on_chunk),
        cancel_token,
            )
            .await
        }
        "anthropic" => {
            create_anthropic_response_stream(
                request,
                database_path,
                api_config,
        custom_headers,
        Some(on_chunk),
        cancel_token,
            )
            .await
        }
        "gemini" => {
            create_gemini_response_stream(
                request,
                database_path,
                api_config,
        custom_headers,
        Some(on_chunk),
        cancel_token,
            )
            .await
        }
        "interactions" => {
            crate::api::interactions::create_interactions_response_stream(
                request,
                database_path,
                api_config,
        custom_headers,
        Some(on_chunk),
        cancel_token,
            )
            .await
        }
        request_method => Err(Error::from_reason(format!(
            "Unsupported request method '{}'. Please switch the active API request method to Chat, Responses, Anthropic, Gemini, or Interactions.",
            request_method
        ))),
    };

    result.map(|mut response| {
        response.content = strip_code_fence(&response.content);
        response
    })
}
