//! OpenAI Responses API entry point and shared type definitions.
//!
//! This module defines the napi-exported types (`ResponsesApiRequest`,
//! `ResponsesApiResult`, etc.) shared by all four provider modules, and
//! orchestrates the full request lifecycle. Heavy logic lives in the
//! sibling `payload`, `event`, and `stream` modules so that this file
//! stays focused on type definitions and orchestration.

mod event;
pub(crate) mod payload;
mod stream;

use std::collections::HashMap;
use std::path::PathBuf;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::ThreadsafeFunction;
use napi_derive::napi;
use tokio_util::sync::CancellationToken;

use crate::api::conversation::{
    prepare_context_request, resolve_sub_agent_tools, ConversationContextRequest,
};
use crate::api::retry::{resolve_stream_idle_timeout_sec, RetryOptions};
use crate::storage::services::app_logs::{log_api_error, log_api_warning, maybe_log_api_request};
use crate::storage::services::chat_conversations::{
    store_chat_exchange, ChatContextMessage, StoreChatExchangeInput,
};
use crate::storage::ApiConfigRecord;

// ---------------------------------------------------------------------------
// Shared napi types (re-exported by all provider modules)
// ---------------------------------------------------------------------------

#[napi(object)]
pub struct ResponsesApiMessage {
    pub role: String,
    pub content: String,
    /// Structured tool results JSON for role="tool" messages.
    /// Format: `[{"name":"...","callId":"...","result":"..."}]`
    /// When present, providers use this directly instead of parsing content text.
    pub tool_results_json: Option<String>,
    /// Reasoning/thinking text for role="assistant" messages produced by a
    /// previous AI response. When present, Chat Completions providers emit it
    /// as `reasoning_content` and Gemini emits it as a `thought` text part.
    /// Anthropic thinking blocks require a cryptographic signature (not
    /// available here), so this field is ignored by the Anthropic provider.
    pub thinking: Option<String>,
    /// JSON array of complete Anthropic thinking blocks (each with
    /// type/thinking/signature). Only used by the Anthropic provider to
    /// round-trip thinking blocks verbatim.
    pub thinking_blocks_json: Option<String>,
}

#[napi(object)]
pub struct ResponsesApiRequest {
    pub messages: Vec<ResponsesApiMessage>,
    pub model: Option<String>,
    /// API config profile that should serve this request. When present it
    /// wins over the conversation's bound profile; when absent the backend
    /// falls back to the conversation's `api_profile_name` and finally to
    /// the global active profile. Used to bind a brand-new conversation to a
    /// provider on its first message.
    pub api_profile: Option<String>,
    pub conversation_id: Option<String>,
    pub previous_response_id: Option<String>,
    pub directory_id: Option<String>,
    pub checkpoint_id: Option<String>,
    pub context_compaction: Option<bool>,
    /// Internal auto-compaction resume mode: the compaction handoff is
    /// already persisted as the latest `context_compaction` boundary, so the
    /// request's `messages` are a placeholder that must not be re-injected
    /// into the payload nor persisted as normal user messages.
    pub resume_after_compaction: Option<bool>,
    pub sub_agent_tools_json: Option<String>,
    /// Sub-agent-only system prompt. Combined with Snow's built-in protocol
    /// and the selected API profile's prompts for sub-agent requests.
    pub sub_agent_system_prompt: Option<String>,
    /// Deprecated compatibility field. New sub-agent requests send
    /// `api_profile` explicitly; this value is used only when that field is
    /// absent on a request already identified as a sub-agent.
    pub sub_agent_config_profile: Option<String>,
    /// When true, skip loading conversation history and injecting the built-in
    /// system prompt. Used by lightweight single-shot completions (e.g. AI
    /// commit-message generation).
    pub skip_context: Option<bool>,
    /// When true, replace the built-in system prompt with the Plan Mode prompt
    /// that instructs the AI to plan and get user approval before executing.
    pub plan_mode: Option<bool>,
    /// When true, replace the built-in system prompt with the Goal Mode prompt
    /// that instructs the AI to work autonomously toward a defined objective.
    pub goal_mode: Option<bool>,
    /// Project ROLE.md content of an SSH (`ssh://`) workspace, resolved by the
    /// Electron main process over SSH (mirrors RoleEditorPanel's access path).
    /// Absent for local workspaces — Rust reads the file itself.
    pub remote_role_content: Option<String>,
    pub remote_include_global_rules: Option<bool>,
}

impl ResponsesApiRequest {
    pub fn is_sub_agent_request(&self) -> bool {
        self.sub_agent_tools_json
            .as_deref()
            .map(str::trim)
            .is_some_and(|value| !value.is_empty())
    }
}

#[napi(object)]
pub struct TokenUsage {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_creation_input_tokens: i64,
    pub cache_read_input_tokens: i64,
}

#[napi(object)]
pub struct ResponsesApiResult {
    pub id: String,
    pub conversation_id: String,
    pub content: String,
    pub thinking: String,
    pub model: String,
    pub status: String,
    pub tool_calls_json: String,
    pub token_usage: TokenUsage,
    pub persisted_user_message_ids: Vec<String>,
}

#[napi(object)]
pub struct ResponsesApiStreamChunk {
    pub content_delta: String,
    pub thinking_delta: String,
    pub content: String,
    pub thinking: String,
    pub retrying: bool,
    pub retry_attempt: Option<i32>,
    pub retry_error: Option<String>,
    /// Cumulative token count for the current agent-loop iteration.
    ///
    /// The Rust backend counts tokens for every streamed delta (content and
    /// thinking) using the `o200k_base` tokenizer and accumulates them across
    /// chunks within a single `collect_streaming_response` call. The renderer
    /// treats this as a real-time probe: it resets to zero when a new
    /// iteration starts and ignores it for non-streaming chunks (retry
    /// events), where the field stays at the previously-accumulated value.
    pub stream_token_count: i64,
    /// Elapsed milliseconds since the streaming request started. Updated
    /// on every chunk so the renderer can display a live timer.
    pub elapsed_ms: i64,
    /// Time to first token in milliseconds. Zero until the first content
    /// or thinking delta arrives, then frozen at that value for the
    /// remainder of the streaming iteration.
    pub ttft_ms: i64,
    /// External-vision textify progress event. `None` for regular chunks;
    /// when set, the payload is a JSON string such as
    /// `{"phase":"describing","index":1,"total":2,"model":"..."}` pushed by
    /// `api::vision::textify_images_in_messages` while it describes user
    /// images with the external vision model. The renderer uses it to show
    /// an intermediate "analyzing image with vision model" status card.
    pub vision_status: Option<String>,
}

/// ThreadsafeFunction variant of the streaming callback.
///
/// Using `CalleeHandled = false` so the JavaScript callback receives the chunk
/// directly as its first argument (no error-first `null`), matching the existing
/// `(chunk: ResponsesApiStreamChunk) => void` signature on the JS side.
///
/// `ThreadsafeFunction` is `Send + Sync`, which allows it to be called from the
/// background tokio worker thread without blocking the Node.js main thread.
pub type ResponsesApiStreamCallback = ThreadsafeFunction<
    ResponsesApiStreamChunk,
    Unknown<'static>,
    ResponsesApiStreamChunk,
    Status,
    false,
>;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/// Public entry point — create an OpenAI Responses streaming response.
pub async fn create_response_stream_with_context(
    request: ResponsesApiRequest,
    database_path: PathBuf,
    api_config: ApiConfigRecord,
    custom_headers: HashMap<String, String>,
    on_chunk: ResponsesApiStreamCallback,
    cancel_token: CancellationToken,
) -> Result<ResponsesApiResult> {
    create_response_async(
        request,
        database_path,
        api_config,
        custom_headers,
        &on_chunk,
        cancel_token,
    )
    .await
}

async fn create_response_async(
    request: ResponsesApiRequest,
    database_path: PathBuf,
    api_config: ApiConfigRecord,
    custom_headers: HashMap<String, String>,
    on_chunk: &ResponsesApiStreamCallback,
    cancel_token: CancellationToken,
) -> Result<ResponsesApiResult> {
    if api_config.request_method != "responses" {
        return Err(Error::from_reason(
            "Only OpenAI Responses API is supported for chat right now. Please switch the active API request method to Responses.",
        ));
    }

    let api_key = api_config.api_key.trim();
    if api_key.is_empty() {
        return Err(Error::from_reason(
            "API key not configured. Please configure API settings first.",
        ));
    }

    // Resolve the requested model up front so conversation/message persistence
    // and the stream result use the model the user asked for, never the model
    // echoed back by the API response body (some providers return aliased or
    // date-stamped names, e.g. `deepseek-flash-0731`, which would otherwise
    // overwrite the chat input's displayed model).
    let model = request
        .model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| api_config.advanced_model.trim());

    let endpoint = payload::resolve_responses_endpoint(&api_config);
    if endpoint.is_empty() {
        return Err(Error::from_reason(
            "Base URL not configured. Please configure API settings first.",
        ));
    }

    let request_messages = request
        .messages
        .iter()
        .map(|message| ChatContextMessage {
            role: message.role.clone(),
            content: message.content.clone(),
            tool_calls_json: None,
            tool_results_json: message.tool_results_json.clone(),
            thinking: message.thinking.clone(),
            thinking_blocks_json: message.thinking_blocks_json.clone(),
        })
        .collect::<Vec<_>>();
    let prepared_request = prepare_context_request(ConversationContextRequest {
        database_path: &database_path,
        conversation_id: request.conversation_id.as_deref(),
        previous_response_id: request.previous_response_id.as_deref(),
        messages: &request_messages,
        max_context_tokens: api_config.max_context_tokens,
        directory_id: request.directory_id.as_deref(),
        context_compaction: request.context_compaction.unwrap_or(false),
        resume_after_compaction: request.resume_after_compaction.unwrap_or(false),
        skip_context: request.skip_context.unwrap_or(false),
        plan_mode: request.plan_mode.unwrap_or(false),
        goal_mode: request.goal_mode.unwrap_or(false),
        is_sub_agent: request.is_sub_agent_request(),
        sub_agent_system_prompt: request.sub_agent_system_prompt.as_deref(),
        system_prompt_ids_json: &api_config.system_prompt_ids_json,
        remote_role_content: request.remote_role_content.as_deref(),
        remote_include_global_rules: request.remote_include_global_rules,
    })?;

    // Inject conversation_id and session_id as request headers for prompt
    // caching.  OpenAI's Responses API uses these headers (along with
    // prompt_cache_key in the payload) to route requests to the same cache
    // shard.  Matches snow-cli's header injection behavior.
    let mut effective_headers = custom_headers;
    if let Some(ref conv_id) = request.conversation_id {
        if !conv_id.is_empty() {
            effective_headers.insert("conversation_id".to_string(), conv_id.clone());
            effective_headers.insert("session_id".to_string(), conv_id.clone());
        }
    }

    let client = crate::api::http_client::build_proxied_client()
        .await
        .map_err(|error| Error::from_reason(format!("Failed to create HTTP client: {}", error)))?;
    let skip_context = request.skip_context.unwrap_or(false);
    let mut prepared_messages = prepared_request.messages;
    crate::api::vision::textify_images_in_messages(
        &mut prepared_messages,
        &database_path,
        &api_config,
        &effective_headers,
        skip_context,
        Some(on_chunk),
    )
    .await?;

    let tools = if request.context_compaction.unwrap_or(false) || skip_context {
        None
    } else {
        match resolve_sub_agent_tools(&request).await {
            Ok(tools) => Some(crate::mcp::tools::tools_as_openai_responses_json(&tools)),
            Err(error) => {
                eprintln!("Failed to prepare MCP tools for OpenAI Responses: {error}");
                None
            }
        }
    };
    let payload = payload::build_responses_payload(
        &prepared_messages,
        &database_path,
        &request,
        &api_config,
        tools,
        &prepared_request.user_system_prompts,
    )?;
    let retry_options =
        RetryOptions::from_config(api_config.max_retries, api_config.retry_base_delay_ms);
    let stream_idle_timeout_sec =
        resolve_stream_idle_timeout_sec(api_config.stream_idle_timeout_sec);
    let request_payload_json = serde_json::to_string(&payload).unwrap_or_default();
    maybe_log_api_request(
        database_path.clone(),
        "responses".to_string(),
        endpoint.clone(),
        request_payload_json,
    )
    .await;

    let streamed_response = match stream::collect_streaming_response(
        &client,
        &endpoint,
        api_key,
        &effective_headers,
        payload,
        on_chunk,
        &cancel_token,
        &retry_options,
        stream_idle_timeout_sec,
    )
    .await
    {
        Ok(result) => result,
        Err(error) => {
            log_api_error(
                &database_path,
                "create_response_stream_with_context",
                "Responses API call failed",
                &error.reason,
            );
            return Err(error);
        }
    };
    // See chat/mod.rs: assistant raw_events are not needed for replay, so we
    // skip serializing the full SSE chunk array to avoid DB bloat.
    let raw_response_json = "{}";

    for parse_error in &streamed_response.tool_parse_errors {
        log_api_warning(
            &database_path,
            "create_response_stream_with_context",
            "Tool call JSON parse failed after streaming",
            parse_error,
        );
    }

    if streamed_response.status != "cancelled"
        && streamed_response.content.is_empty()
        && streamed_response.thinking.is_empty()
        && streamed_response.tool_calls_json == "[]"
        && streamed_response.reasoning_items_json == "[]"
    {
        log_api_warning(
            &database_path,
            "create_response_stream_with_context",
            "AI returned empty response",
            &format!(
                "model={}, status={}",
                streamed_response.model, streamed_response.status
            ),
        );
    }

    let persisted_user_message_ids = if !skip_context {
        store_chat_exchange(
            &database_path,
            &StoreChatExchangeInput {
                conversation_id: &prepared_request.conversation_id,
                request_messages: &prepared_request.current_messages,
                response_content: &streamed_response.content,
                response_id: &streamed_response.id,
                checkpoint_id: request.checkpoint_id.as_deref().unwrap_or(""),
                model,
                api_profile_name: &api_config.profile_name,
                status: &streamed_response.status,
                raw_response_json: &raw_response_json,
                token_usage: streamed_response.token_usage,
                response_thinking: &streamed_response.thinking,
                response_thinking_blocks_json: &streamed_response.reasoning_items_json,
                tool_calls_json: &streamed_response.tool_calls_json,
                directory_id: request.directory_id.as_deref().unwrap_or(""),
                context_compaction: request.context_compaction.unwrap_or(false),
                resume_after_compaction: request.resume_after_compaction.unwrap_or(false),
                total_duration_ms: streamed_response.total_duration_ms,
            },
        )?
    } else {
        Vec::new()
    };

    Ok(ResponsesApiResult {
        id: streamed_response.id,
        conversation_id: prepared_request.conversation_id,
        content: streamed_response.content,
        thinking: streamed_response.thinking,
        // Return the requested model so the renderer's assistant message
        // records match what was persisted (the response body's model is
        // unreliable across providers and may carry date-stamped aliases).
        model: model.to_string(),
        status: streamed_response.status,
        tool_calls_json: streamed_response.tool_calls_json,
        token_usage: TokenUsage {
            input_tokens: streamed_response.token_usage.input_tokens,
            output_tokens: streamed_response.token_usage.output_tokens,
            cache_creation_input_tokens: streamed_response.token_usage.cache_creation_input_tokens,
            cache_read_input_tokens: streamed_response.token_usage.cache_read_input_tokens,
        },
        persisted_user_message_ids,
    })
}
