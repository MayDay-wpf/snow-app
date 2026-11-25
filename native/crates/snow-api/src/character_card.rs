//! AI character-card generation for the IM chat style.
//!
//! Reuses the same four provider stream functions as theme-palette generation
//! (chat / responses / anthropic / gemini), so whichever `request_method` the
//! selected API config uses, the request is dispatched correctly.
//!
//! Like the palette flow this module:
//! - Uses the **advanced model** (expected to support vision).
//! - Sends the source image as an inline `@@image:data:...@@` tag.
//! - Keeps `skip_context` unset so providers parse the inline image, while the
//!   empty `conversation_id` avoids loading any chat history.
//! - Carries no tools and forces thinking off (pure vision → JSON task).

use napi::bindgen_prelude::*;
use tokio_util::sync::CancellationToken;

use crate::api::anthropic::create_anthropic_response_stream;
use crate::api::chat::create_chat_completion_response_stream;
use crate::api::config::{get_api_request_context_for_profile, resolve_advanced_model};
use crate::api::gemini::create_gemini_response_stream;
use crate::api::responses::{
    create_response_stream_with_context, ResponsesApiMessage, ResponsesApiRequest,
    ResponsesApiResult, ResponsesApiStreamCallback,
};
use crate::theme_palette::read_image_as_data_url;

const CHARACTER_CARD_SYSTEM_PROMPT: &str = "You are a character designer for an instant-messaging style chat app. \
Based on the provided image, create an original character that the AI assistant will role-play in a one-on-one chat with the user. \
Analyze the image carefully: apparent age, gender presentation, clothing, art style, mood, colors, props and setting. The character must visibly match the image.\n\n\
Respond with ONLY a JSON object (no markdown fences, no explanation) using exactly this schema:\n\
{\n  \"name\": \"...\",\n  \"tagline\": \"...\",\n  \"personality\": \"...\",\n  \"speakingStyle\": \"...\",\n  \"background\": \"...\",\n  \"greeting\": \"...\"\n}\n\n\
Rules:\n\
1. \"name\": the character's name, 1-4 words, fitting the character.\n\
2. \"tagline\": one short memorable line describing the character.\n\
3. \"personality\": 2-4 sentences of concrete traits, habits, likes, dislikes and one small flaw. Avoid generic adjectives.\n\
4. \"speakingStyle\": concrete verbal habits - sentence length, tone, punctuation or emoji usage, catchphrases, how the character addresses the user.\n\
5. \"background\": 2-4 sentences of the setting and the character's relationship with the user.\n\
6. \"greeting\": the first chat message the character would send, 1-2 sentences, fully in character.\n\
7. Write every field in the requested language, even if the image contains text in another language.\n\
8. Output only the JSON object, nothing else.";

/// Build the request with the source image and the target output language.
fn build_request(image_data_url: &str, language: &str) -> ResponsesApiRequest {
    let language = language.trim();
    let language_line = if language.is_empty() {
        "Write every field in the same language the user is using.".to_string()
    } else {
        format!("Write every field in {language}.")
    };

    ResponsesApiRequest {
        messages: vec![
            ResponsesApiMessage {
                role: "system".to_string(),
                origin: Some(
                    crate::storage::services::chat_conversations::ORIGIN_INTERNAL.to_string(),
                ),
                content: CHARACTER_CARD_SYSTEM_PROMPT.to_string(),
                tool_results_json: None,
                thinking: None,
                tool_calls_json: None,
            },
            ResponsesApiMessage {
                role: "user".to_string(),
                origin: Some(
                    crate::storage::services::chat_conversations::ORIGIN_INTERNAL.to_string(),
                ),
                content: format!(
                    "Here is the character image. Design the character card based on it. {language_line}\n\n@@image:{}@@",
                    image_data_url
                ),
                tool_results_json: None,
                thinking: None,
                tool_calls_json: None,
            },
        ],
        // The concrete model is resolved from the API config below.
        model: None,
        api_profile: None,
        conversation_id: None,
        previous_response_id: None,
        directory_id: None,
        analysis_workspace_root: None,
        checkpoint_id: None,
        context_compaction: None,
        context_fold: None,
        resume_after_compaction: None,
        compaction_tail_messages: None,
        retry_failed_response: None,
        // No tools: character-card generation is a pure vision -> JSON task.
        sub_agent_tools_json: Some("[]".to_string()),
        sub_agent_system_prompt: None,
        sub_agent_config_profile: None,
        skip_context: None,
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

/// 角色卡图片来源：data URL 直接使用（默认头像由渲染层裁切生成），
/// 其余按磁盘路径读取并编码。
fn read_character_image_data_url(input: &str) -> Result<String> {
    let trimmed = input.trim();
    if trimmed.starts_with("data:") {
        return Ok(trimmed.to_string());
    }
    read_image_as_data_url(trimmed)
}

/// Generate a character card from an image by streaming from the selected API
/// config's advanced model via whichever provider the config specifies.
///
/// - `image_path`: absolute path to the character image, or an inline
///   `data:<mime>;base64,...` URL (used for the built-in default avatar)
/// - `profile_name`: API config profile name (empty = active profile)
/// - `language`: human-readable target language for the generated fields
/// - `on_chunk`: streaming callback
/// - `cancel_token`: cancellation token for abort support
///
/// Returns the full `ResponsesApiResult` (`.content` holds the JSON card).
pub async fn generate_character_card_stream(
    image_path: String,
    profile_name: String,
    language: String,
    on_chunk: ResponsesApiStreamCallback,
    cancel_token: CancellationToken,
) -> Result<ResponsesApiResult> {
    // 1. Read and encode the character image (blocking file I/O; data URLs pass through).
    let image_data_url =
        tokio::task::spawn_blocking(move || read_character_image_data_url(&image_path))
            .await
            .map_err(|join_error| {
                Error::from_reason(format!("Failed to read character image: {join_error}"))
            })??;

    // 2. Resolve the selected API config (blocking SQLite I/O).
    let profile_arg: Option<String> = if profile_name.trim().is_empty() {
        None
    } else {
        Some(profile_name.trim().to_string())
    };
    let context = tokio::task::spawn_blocking(move || {
        get_api_request_context_for_profile(profile_arg.as_deref())
    })
    .await
    .map_err(|join_error| {
        Error::from_reason(format!("Failed to resolve API configuration: {join_error}"))
    })??;

    let api_config = &context.api_config;

    // 3. Validate the config.
    if api_config.api_key.trim().is_empty() {
        return Err(Error::from_reason(
            "API key not configured. Please configure API settings first.",
        ));
    }

    let advanced_model = resolve_advanced_model(None, &api_config.advanced_model)?;

    if !api_config.supports_vision {
        return Err(Error::from_reason(
            "The selected API profile's advanced model does not support vision. \
             Please enable \"Supports vision\" in the API settings or choose a vision-capable model.",
        ));
    }

    // 4. Build the request with the advanced model.
    let mut request = build_request(&image_data_url, &language);
    request.model = Some(advanced_model);

    // 5. Dispatch to the correct provider.
    let request_method = context.api_config.request_method.clone();
    let database_path = context.database_path;
    let mut api_config = context.api_config;
    crate::api::retry::apply_auxiliary_retries(&mut api_config);
    let custom_headers = context.custom_headers;

    // Force thinking off for all providers: this task only needs the JSON.
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

    match request_method.as_str() {
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
            "Unsupported request method '{}'. Please switch the selected API request method to Chat, Responses, Anthropic, Gemini, or Interactions.",
            request_method
        ))),
    }
}
