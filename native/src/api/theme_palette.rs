//! AI-powered theme palette generation from a background image.
//!
//! Reuses the existing four provider stream functions (chat / responses /
//! anthropic / gemini) so that whichever `request_method` the selected API
//! config uses, the request is dispatched correctly.
//!
//! Unlike the commit-message flow this module:
//! - Uses the **advanced model** (which is expected to support vision) instead
//!   of the basic model.
//! - Sends the background image as an inline `@@image:data:...@@` tag so the
//!   four providers can parse it into their native multimodal payloads.
//! - Does **not** set `skip_context`, so provider image parsing stays enabled.
//!   `conversation_id` is left empty to avoid loading any chat history.
//! - Does **not** inject the built-in system prompt or load context history,
//!   because `skip_context` is false but `conversation_id` is `None` and the
//!   request carries only a system + user message pair.

use std::fs;
use std::path::Path;

use base64::Engine;
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

const PALETTE_SYSTEM_PROMPT: &str = "You are a senior UI/UX color designer. Based on the provided background image, design a coherent theme palette for a desktop application. \
The palette must work well when the image is used as a translucent, blurred window background. \
Analyze the dominant colors, mood, and contrast of the image, then derive a palette that keeps text readable and UI elements distinguishable. \
\n\nRespond with ONLY a JSON object (no markdown fences, no explanation) using exactly this schema:\n\
{\n  \"light\": { \"bgPrimary\": \"#hex\", \"bgSecondary\": \"#hex\", \"bgTertiary\": \"#hex\", \"bgHover\": \"#hex\", \"bgActive\": \"#hex\", \"chromeBg\": \"#hex\", \"appBg\": \"#hex\", \"borderColor\": \"#hex\", \"borderLight\": \"#hex\", \"borderSubtle\": \"#hex\", \"textPrimary\": \"#hex\", \"textSecondary\": \"#hex\", \"textTertiary\": \"#hex\", \"textMuted\": \"#hex\", \"accentGreen\": \"#hex\", \"accentGreenBg\": \"#hex\", \"accentGreenText\": \"#hex\", \"accentRed\": \"#hex\", \"accentRedBg\": \"#hex\", \"accentRedText\": \"#hex\", \"accentBlue\": \"#hex\", \"accentBlueBg\": \"#hex\", \"accentBlueText\": \"#hex\", \"accentColor\": \"#hex\", \"onSolid\": \"#hex\", \"selectionBg\": \"#hex\", \"focusRing\": \"#hex\" },\n  \"dark\": { ...same fields... }\n\
}\n\nRules:\n\
1. All color values must be 6-digit hex strings starting with '#'.\n\
2. The \"light\" palette should feel bright and airy, with dark text on light backgrounds.\n\
3. The \"dark\" palette should feel deep and calm, with light text on dark backgrounds.\n\
4. Keep WCAG AA contrast for textPrimary against bgPrimary in both palettes.\n\
5. Accent colors should harmonize with the image's dominant hue.\n\
6. Output only the JSON object, nothing else.";

/// Build a `ResponsesApiRequest` for theme palette generation, embedding the
/// background image as an inline data URL so the four providers can parse it.
fn build_request(image_data_url: &str) -> ResponsesApiRequest {
    ResponsesApiRequest {
        messages: vec![
            ResponsesApiMessage {
                role: "system".to_string(),
                content: PALETTE_SYSTEM_PROMPT.to_string(),
                tool_results_json: None,
                thinking: None,
                thinking_blocks_json: None,
            },
            ResponsesApiMessage {
                role: "user".to_string(),
                content: format!(
                    "Here is the background image. Design the theme palette based on it.\n\n@@image:{}@@",
                    image_data_url
                ),
                tool_results_json: None,
                thinking: None,
                thinking_blocks_json: None,
            },
        ],
        // Force the advanced model (expected to support vision) for this task.
        model: None, // will be set after resolving context
        api_profile: None,
        conversation_id: None,
        previous_response_id: None,
        directory_id: None,
        checkpoint_id: None,
        context_compaction: None,
        resume_after_compaction: None,
        // Empty tool whitelist: palette generation is a pure vision→JSON task
        // and must not carry any MCP/builtin tools in the payload.
        sub_agent_tools_json: Some("[]".to_string()),
        sub_agent_system_prompt: None,
        sub_agent_config_profile: None,
        // Keep skip_context unset (false) so providers parse the @@image:...@@
        // tag into their native multimodal payloads. An empty conversation_id
        // ensures no chat history is loaded.
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

/// Read an image file from disk and encode it as a base64 data URL.
fn read_image_as_data_url(image_path: &str) -> Result<String> {
    let path = Path::new(image_path);
    let bytes = fs::read(path).map_err(|error| {
        Error::from_reason(format!(
            "Failed to read background image '{}': {}",
            path.display(),
            error
        ))
    })?;
    if bytes.is_empty() {
        return Err(Error::from_reason("Background image file is empty."));
    }

    let media_type = extension_to_media_type(path);
    let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", media_type, data))
}

fn extension_to_media_type(path: &Path) -> &'static str {
    match path.extension().and_then(|ext| ext.to_str()) {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        Some("svg") => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

/// Generate a theme palette from a background image by streaming from the
/// selected API config's advanced model via whichever provider the config
/// specifies.
///
/// - `imagePath`: absolute path to the background image file
/// - `profileName`: API config profile name. Empty string means "use the
///   active profile".
/// - `onChunk`: streaming callback receiving `ResponsesApiStreamChunk`
/// - `cancelToken`: cancellation token for abort support
///
/// Returns the full `ResponsesApiResult` (`.content` holds the JSON palette).
pub async fn generate_theme_palette_stream(
    image_path: String,
    profile_name: String,
    on_chunk: ResponsesApiStreamCallback,
    cancel_token: CancellationToken,
) -> Result<ResponsesApiResult> {
    // --- 1. Read and encode the background image (blocking file I/O) ---
    let image_data_url = tokio::task::spawn_blocking(move || read_image_as_data_url(&image_path))
        .await
        .map_err(|join_error| {
            Error::from_reason(format!("Failed to read background image: {join_error}"))
        })??;

    // --- 2. Resolve selected API config (blocking SQLite I/O) ---
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

    // --- 3. Validate config ---
    let api_key = api_config.api_key.trim();
    if api_key.is_empty() {
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

    // --- 4. Build request with advanced model ---
    let mut request = build_request(&image_data_url);
    request.model = Some(advanced_model);

    // --- 5. Dispatch to the correct provider ---
    // We reuse the four provider stream functions directly. Each one calls
    // prepare_context_request internally; with an empty conversation_id and
    // skip_context=false, it will create a throwaway conversation but still
    // parse the @@image:...@@ tag into the provider's multimodal payload.
    let request_method = context.api_config.request_method.clone();
    let database_path = context.database_path;
    let mut api_config = context.api_config;
    let custom_headers = context.custom_headers;

    // Disable thinking/reasoning for all providers by flipping the four
    // `snowcfg` thinking switches off. The payload builders then see
    // `enabled: false` and simply omit the reasoning/thinking parameter
    // entirely (no `none`, no `disabled`) — same approach as the
    // commit-message flow.
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
                on_chunk,
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
                on_chunk,
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
                on_chunk,
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
                on_chunk,
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
                on_chunk,
                cancel_token,
            )
            .await
        }
        request_method => Err(Error::from_reason(format!(
            "Unsupported request method '{}'. Please switch the selected API request method to Chat, Responses, Anthropic, Gemini, or Interactions.",
            request_method
        ))),
    };

    result
}
