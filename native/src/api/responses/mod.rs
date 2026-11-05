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
mod ws;

pub(crate) use event::extract_token_usage as extract_responses_token_usage;

use std::collections::HashMap;
use std::path::PathBuf;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::ThreadsafeFunction;
use napi_derive::napi;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::api::config::resolve_advanced_model;
use crate::api::conversation::{
    prepare_context_request, resolve_request_tools_optional, ConversationContextRequest,
};
use crate::api::retry::{
    classify_final_stream_warning, resolve_empty_response_terminal,
    resolve_stream_idle_timeout_sec, FinalStreamWarningDisposition, RetryOptions,
};
use crate::storage::services::app_logs::{
    log_api_warning, maybe_log_api_request_for_conversation,
    maybe_log_api_response_for_conversation,
};
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
    pub origin: Option<String>,
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
    /// Serialized tool calls for role="assistant" messages, in the same
    /// provider-native shape the conversation history persists. Stateless
    /// callers (skip_context side channels such as the desktop pet chat) have
    /// no database history to load, so they must replay their own tool loop
    /// by sending the assistant tool calls back together with their results.
    pub tool_calls_json: Option<String>,
}

impl ResponsesApiMessage {
    pub(crate) fn to_context_message(&self) -> Result<ChatContextMessage> {
        Ok(ChatContextMessage {
            role: self.role.clone(),
            origin: crate::storage::services::chat_conversations::parse_message_origin(
                self.origin.as_deref(),
            )?.to_string(),
            content: self.content.clone(),
            tool_calls_json: self.tool_calls_json.clone(),
            tool_results_json: self.tool_results_json.clone(),
            thinking: self.thinking.clone(),
            thinking_blocks_json: self.thinking_blocks_json.clone(),
        })
    }
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
    /// Actual local worktree to analyze; independent of directory_id's config
    /// and authorization scope. Omitted clients keep the project-root default.
    pub analysis_workspace_root: Option<String>,
    pub checkpoint_id: Option<String>,
    pub context_compaction: Option<bool>,
    /// Internal auto-compaction resume mode: the compaction handoff is
    /// already persisted as the latest `context_compaction` boundary, so the
    /// request's `messages` are a placeholder that must not be re-injected
    /// into the payload nor persisted as normal user messages.
    pub resume_after_compaction: Option<bool>,
    /// 重试失败回合模式（子代理「重试」按钮）：该回合的请求消息已随失败回合落库，
    /// 本次请求只把它们作为上下文重发，不再重复落库；末尾的失败助手行由本次响应
    /// 原地替换，已完成工具结果的证据行原样保留。允许 messages 为空。
    pub retry_failed_response: Option<bool>,
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
    /// Parse inline `@@image:` tags into multimodal blocks even when
    /// `skip_context` is set (desktop pet btw chat). Without it a skip-context
    /// request passes image tags through as plain text.
    pub parse_inline_images: Option<bool>,
    /// Preserve normal context while omitting MCP tools for this request.
    /// Used to recover from a provider that repeated completed readonly calls.
    pub disable_tools: Option<bool>,
    /// Request-local instruction used only to recover a repeated-tool turn.
    /// It is applied as a provider system instruction and is never persisted
    /// as a conversation message or reused for sub-agent semantics.
    pub internal_recovery_prompt: Option<String>,
    /// When true, replace the built-in system prompt with the Goal Mode prompt
    /// that instructs the AI to work autonomously toward a defined objective.
    pub goal_mode: Option<bool>,
    /// When true, replace the built-in system prompt with the WorkTree prompt
    /// that instructs the AI to work on an isolated Git branch or worktree.
    pub worktree_mode: Option<bool>,
    /// When true, replace the built-in system prompt with the WorkFlow prompt
    /// that instructs the AI to design an executable workflow graph.
    pub workflow_mode: Option<bool>,
    /// Per-request thinking strength override ("none" | "low" | "medium" |
    /// "high" | custom). Applied in-memory over the resolved profile's
    /// config_json; never mutates the stored profile.
    pub thinking_strength: Option<String>,
    /// Per-request Responses Fast Mode override ("off" | "fast" |
    /// "ultrafast"). Applied in-memory over the resolved profile's
    /// config_json; never mutates the stored profile.
    pub responses_fast_mode: Option<String>,
    /// Project ROLE.md content of an SSH (`ssh://`) workspace, resolved by the
    /// Electron main process over SSH (mirrors RoleEditorPanel's access path).
    /// Absent for local workspaces — Rust reads the file itself.
    pub remote_role_content: Option<String>,
    pub remote_include_global_rules: Option<bool>,
    /// "Override built-in prompt" switch of an SSH workspace's project ROLE,
    /// read from its remote `.snow/settings.json` by the main process.
    pub remote_override_builtin_prompt: Option<bool>,
    /// Explicit effective workspace execution root (e.g. worktree directory path).
    /// When set, overrides directoryId-based project root for system prompt and tool execution.
    pub execution_workspace_root: Option<String>,
    /// Selected or preselected worktree ID for the conversation.
    pub worktree_id: Option<String>,
    /// Request-scoped MCP tool whitelist (JSON array of full tool names).
    /// Unlike `sub_agent_tools_json` this does not turn the request into a
    /// sub-agent request. It keeps its restricted tool set even when
    /// `skip_context` is set, which is what the desktop pet's side channel
    /// needs: no conversation history, but still web search / file tools.
    pub allowed_tools_json: Option<String>,
    /// 会话级插件激活集合（`@@plugin` chip 解析出的插件 id，JSON 数组）。
    /// 不在集合内的工具插件既不发现也不注入；空数组表示本次请求不使用插件工具。
    /// 字段缺失（None）表示非主会话请求，此时不按会话过滤插件来源。
    pub plugin_tool_ids_json: Option<String>,
}

impl ResponsesApiRequest {
    /// skip_context side channels skip inline image parsing by default (no file
    /// I/O); `parse_inline_images` opts a caller like the pet chat back in.
    pub fn skips_inline_image_parsing(&self) -> bool {
        self.skip_context.unwrap_or(false) && !self.parse_inline_images.unwrap_or(false)
    }

    pub fn is_sub_agent_request(&self) -> bool {
        self.sub_agent_tools_json
            .as_deref()
            .map(str::trim)
            .is_some_and(|value| !value.is_empty())
    }

    /// Whether this request carries an explicit request-scoped tool whitelist.
    pub fn has_allowed_tools(&self) -> bool {
        self.allowed_tools_json
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
    pub interruption_reason: Option<String>,
    pub recovery_outcome: Option<String>,
    /// 失败终态时上游给出的（已脱敏）原因，供前端展示。
    pub failure_reason: Option<String>,
    /// 失败终态的分类（`timeout` / `provider_error`），仅在 `Err` 分支由
    /// `conversation::stream` 统一给出：渲染层的结束原因需要区分「传输超时」
    /// 与「上游报错」，不应依赖匹配错误文案。
    pub failure_kind: Option<String>,
    pub tool_calls_json: String,
    pub token_usage: TokenUsage,
    pub persisted_user_message_ids: Vec<String>,
    /// 本次落库的助手消息 id（未落库为空），渲染层据此作为消息窗口的分页游标。
    pub persisted_assistant_message_id: String,
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
    /// 本次重试前的退避时长（毫秒）。仅在 `retrying == true` 的分片上为
    /// `Some(...)`，供前端渲染「N 秒后重试」倒计时——否则用户面对 3s→30s 的
    /// 指数退避只能盲等，不知道还要多久。普通分片恒为 `None`。
    pub retry_backoff_ms: Option<i64>,
    /// Cumulative token count for the current agent-loop iteration.
    ///
    /// The Rust backend counts tokens for every streamed delta (content and
    /// thinking) using the `o200k_base` tokenizer and accumulates them across
    /// chunks within a single `collect_streaming_response` call. The renderer
    /// treats this as a real-time probe: it resets to zero when a new
    /// iteration starts and ignores it for non-streaming chunks (retry
    /// events), where the field stays at the previously-accumulated value.
    pub stream_token_count: i64,
    /// Cumulative thinking-only token count for the current agent-loop
    /// iteration (the subset of `stream_token_count` produced by thinking
    /// deltas). Drives the live "thinking tokens" readout on the thinking
    /// block and is persisted on the assistant message when the run ends.
    pub thinking_token_count: i64,
    /// Milliseconds elapsed between the first and the most recent thinking
    /// delta of the current iteration (0 while no thinking has streamed).
    /// Grows live while the model is thinking and freezes once the last
    /// thinking delta has been emitted.
    pub thinking_duration_ms: i64,
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
    on_chunk: Option<ResponsesApiStreamCallback>,
    cancel_token: CancellationToken,
) -> Result<ResponsesApiResult> {
    let on_chunk = crate::api::common::StreamSink::new(on_chunk.as_ref());
    create_response_async(
        request,
        database_path,
        api_config,
        custom_headers,
        on_chunk,
        cancel_token,
    )
    .await
}

async fn create_response_async(
    request: ResponsesApiRequest,
    database_path: PathBuf,
    api_config: ApiConfigRecord,
    mut custom_headers: HashMap<String, String>,
    on_chunk: crate::api::common::StreamSink<'_>,
    cancel_token: CancellationToken,
) -> Result<ResponsesApiResult> {
    // 重试探针：记录本轮出现过的最大重试序号与最后一次上游错误，随消息落库。
    let retry_probe = crate::api::common::RetryProbe::default();
    let on_chunk = on_chunk.with_retry_probe(&retry_probe);
    let api_config = crate::api::oauth::provider::refresh_if_needed(api_config).await?;
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
    let model = resolve_advanced_model(request.model.as_deref(), &api_config.advanced_model)?;

    let endpoint = payload::resolve_responses_endpoint(&api_config);
    if endpoint.is_empty() {
        return Err(Error::from_reason(
            "Base URL not configured. Please configure API settings first.",
        ));
    }

    let request_messages = request
        .messages
        .iter()
        .map(|message| message.to_context_message())
        .collect::<Result<Vec<_>>>()?;
    // Collect once, before prompt generation; providers serialize this same snapshot.
    let plugin_tool_configuration = crate::api::plugin_tool_guard::PluginToolGuard::configuration(
        request.directory_id.as_deref(),
    )
    .await?;
    let allowed_tools = resolve_request_tools_optional(&request).await?;
    let prepared_request = prepare_context_request(ConversationContextRequest {
        allowed_tools: allowed_tools.as_deref().unwrap_or_default(),
        database_path: &database_path,
        conversation_id: request.conversation_id.as_deref(),
        previous_response_id: request.previous_response_id.as_deref(),
        messages: &request_messages,
        directory_id: request.directory_id.as_deref(),
        analysis_workspace_root: request.analysis_workspace_root.as_deref(),
        context_compaction: request.context_compaction.unwrap_or(false),
        resume_after_compaction: request.resume_after_compaction.unwrap_or(false),
        retry_failed_response: request.retry_failed_response.unwrap_or(false),
        skip_context: request.skip_context.unwrap_or(false),
        goal_mode: request.goal_mode.unwrap_or(false),
        worktree_mode: request.worktree_mode.unwrap_or(false),
        workflow_mode: request.workflow_mode.unwrap_or(false),
        is_sub_agent: request.is_sub_agent_request(),
        sub_agent_system_prompt: request.sub_agent_system_prompt.as_deref(),
        system_prompt_ids_json: &api_config.system_prompt_ids_json,
        remote_role_content: request.remote_role_content.as_deref(),
        remote_include_global_rules: request.remote_include_global_rules,
        remote_override_builtin_prompt: request.remote_override_builtin_prompt,
        execution_workspace_root: request.execution_workspace_root.as_deref(),
        worktree_id: request.worktree_id.as_deref(),
    })
    .await?;

    // Use the resolved ID so every normal Responses request is cache-routed.
    let cache_key = prepared_request.conversation_id.trim();
    // Session-scoped header placeholders (e.g. `{{session_id}}`) resolve to the
    // conversation this request is stored under.
    crate::api::common::expand_custom_header_session_id(&mut custom_headers, cache_key);
    let mut effective_headers = custom_headers;
    crate::api::oauth::provider::apply_request_headers(&api_config, &mut effective_headers);
    if !cache_key.is_empty() {
        effective_headers.insert("conversation_id".to_string(), cache_key.to_string());
        effective_headers.insert("session_id".to_string(), cache_key.to_string());
    }

    let skip_context = request.skip_context.unwrap_or(false);
    let mut prepared_messages = prepared_request.messages;
    crate::api::vision::textify_images_in_messages(
        &mut prepared_messages,
        &database_path,
        &api_config,
        &effective_headers,
        request.skips_inline_image_parsing(),
        Some(prepared_request.conversation_id.as_str()),
        on_chunk.callback(),
        Some(&cancel_token),
    )
    .await?;

    let tools = allowed_tools
        .as_deref()
        .map(crate::mcp::tools::tools_as_openai_responses_json);
    let payload = payload::build_responses_payload(
        &prepared_messages,
        &database_path,
        &request,
        &api_config,
        tools,
        &prepared_request.user_system_prompts,
        &prepared_request.host_system_prompts,
        cache_key,
    )?;
    let tool_guard = crate::api::plugin_tool_guard::PluginToolGuard::capture(
        crate::api::plugin_tool_guard::Protocol::Responses,
        request.directory_id.as_deref(),
        plugin_tool_configuration,
        &payload,
    )
    .await?;
    let (endpoint, payload) = crate::api::oauth::plugin::transform_request(
        &api_config,
        "responses",
        &model,
        endpoint,
        payload,
        &mut effective_headers,
    )
    .await?;
    let retry_options = RetryOptions::from_config(
        api_config.max_retries,
        api_config.retry_base_delay_ms,
        api_config.partial_retry_max_chars,
    );
    let stream_idle_timeout_sec =
        resolve_stream_idle_timeout_sec(api_config.stream_idle_timeout_sec);
    let request_payload_json = serde_json::to_string(&payload).unwrap_or_default();
    maybe_log_api_request_for_conversation(
        database_path.clone(),
        "responses".to_string(),
        endpoint.clone(),
        request_payload_json,
        prepared_request.conversation_id.clone(),
        api_key.to_string(),
    )
    .await;

    // WebSocket 传输复用同一份 payload、事件解析与恢复策略，只是把 SSE 长连接
    // 换成 WebSocket 连接（snowcfg.responsesWebSocket），因此不需要 reqwest 客户端。
    // 整段改写与传输接管只能走 HTTP/SSE：WebSocket 没有整段响应体，也无法让插件
    // 接管连接；逐事件钩子在两条传输上都生效。
    let force_http_transport = crate::api::oauth::plugin::response::requires_http_transport();
    let streamed_response = crate::api::failure::with_api_key(api_key, async {
        if responses_web_socket_enabled(&api_config.config_json) && !force_http_transport {
            ws::collect_streaming_response_ws(
                database_path.clone(),
                &endpoint,
                api_key,
                &effective_headers,
                payload,
                &tool_guard,
                on_chunk,
                &cancel_token,
                &retry_options,
                stream_idle_timeout_sec,
            )
            .await
        } else {
            let client = crate::api::http_client::build_proxied_client()
                .await
                .map_err(|error| {
                    Error::from_reason(format!("Failed to create HTTP client: {}", error))
                })?;
            stream::collect_streaming_response(
                &client,
                database_path.clone(),
                &endpoint,
                api_key,
                &effective_headers,
                payload,
                &tool_guard,
                on_chunk,
                &cancel_token,
                &retry_options,
                stream_idle_timeout_sec,
            )
            .await
        }
    })
    .await;
    let streamed_response = match streamed_response {
        Ok(result) => result,
        Err(error) => {
            let failure =
                crate::api::failure::ProviderFailure::from_message(&error.reason, Some(api_key));
            // The conversation boundary logs once its final persisted ID exists.
            return Err(Error::from_reason(failure.reason().unwrap_or_default()));
        }
    };
    let response_body_json = serde_json::json!({
        "id": streamed_response.id,
        "model": streamed_response.model,
        "status": streamed_response.status,
        "content": streamed_response.content,
        "thinking": streamed_response.thinking,
        "tool_calls": serde_json::from_str::<Value>(&streamed_response.tool_calls_json)
            .unwrap_or_else(|_| serde_json::json!([])),
        "reasoning_items": serde_json::from_str::<Value>(&streamed_response.reasoning_items_json)
            .unwrap_or_else(|_| serde_json::json!([])),
    });
    maybe_log_api_response_for_conversation(
        database_path.clone(),
        "responses".to_string(),
        endpoint.clone(),
        if streamed_response.status == "failed" {
            streamed_response
                .failure
                .as_ref()
                .map(|failure| failure.raw_json())
                .unwrap_or_else(|| "{}".to_string())
        } else {
            serde_json::to_string(&response_body_json).unwrap_or_default()
        },
        prepared_request.conversation_id.clone(),
        api_key.to_string(),
    )
    .await;

    // See chat/mod.rs: assistant raw_events are not needed for replay, so we
    // skip serializing the full SSE chunk array to avoid DB bloat.
    let raw_response_json = streamed_response
        .failure
        .as_ref()
        .map(|failure| failure.raw_json())
        .unwrap_or_else(|| "{}".to_string());
    let transport_interruption_reason = streamed_response
        .interruption_reason
        .filter(|reason| reason.is_transport());

    let has_response_payload = !streamed_response.content.is_empty()
        || !streamed_response.thinking.is_empty()
        || streamed_response.tool_calls_json != "[]"
        || streamed_response.reasoning_items_json != "[]";
    // A classified provider failure must keep its actual recovery outcome;
    // zero output does not turn a policy rejection into exhausted empty retries.
    let (terminal_reason, terminal_outcome) = if streamed_response.status == "failed" {
        (
            streamed_response.interruption_reason,
            streamed_response.recovery_outcome,
        )
    } else {
        resolve_empty_response_terminal(
            &streamed_response.status,
            streamed_response.interruption_reason,
            streamed_response.recovery_outcome,
            has_response_payload,
        )
    };
    let interruption_reason = terminal_reason.map(|reason| reason.as_code().to_string());
    let recovery_outcome = terminal_outcome.map(|outcome| outcome.as_code().to_string());

    if transport_interruption_reason.is_none() {
        for parse_error in &streamed_response.tool_parse_errors {
            log_api_warning(
                &database_path,
                "create_response_stream_with_context",
                "Tool call JSON parse failed after streaming",
                parse_error,
            )
            .await;
        }
    }

    let final_warning = if streamed_response.status == "failed" {
        FinalStreamWarningDisposition::None
    } else {
        classify_final_stream_warning(
            &streamed_response.status,
            streamed_response.interruption_reason,
            has_response_payload,
        )
    };
    match final_warning {
        FinalStreamWarningDisposition::TransportInterrupted(reason) => {
            log_api_warning(
                &database_path,
                "create_response_stream_with_context",
                "AI response stream interrupted",
                &format!(
                    "provider=openai, request_method=responses, reason={}, outcome={}, model={}, status={}, conversation_id={}, response_id={}, content_chars={}, thinking_chars={}, duration_ms={}",
                    reason.as_code(),
                    recovery_outcome.as_deref().unwrap_or(""),
                    model,
                    streamed_response.status,
                    prepared_request.conversation_id,
                    streamed_response.id,
                    streamed_response.content.chars().count(),
                    streamed_response.thinking.chars().count(),
                    streamed_response.total_duration_ms,
                ),
            )
            .await;
        }
        FinalStreamWarningDisposition::EmptyResponse => {
            log_api_warning(
                &database_path,
                "create_response_stream_with_context",
                "AI returned empty response",
                &format!(
                    "model={}, status={}",
                    streamed_response.model, streamed_response.status
                ),
            )
            .await;
        }
        FinalStreamWarningDisposition::None => {}
    }

    let persisted_exchange = if !skip_context {
        store_chat_exchange(
            &database_path,
            &StoreChatExchangeInput {
                conversation_id: &prepared_request.conversation_id,
                request_messages: &prepared_request.current_messages,
                response_content: &streamed_response.content,
                response_id: &streamed_response.id,
                checkpoint_id: request.checkpoint_id.as_deref().unwrap_or(""),
                model: &model,
                api_profile_name: &api_config.profile_name,
                status: &streamed_response.status,
                interruption_reason: interruption_reason.as_deref(),
                recovery_outcome: recovery_outcome.as_deref(),
                retry_attempts: retry_probe.attempts(),
                retry_error: &retry_probe.last_error(),
                raw_response_json: &raw_response_json,
                token_usage: streamed_response.token_usage,
                response_thinking: &streamed_response.thinking,
                response_thinking_blocks_json: &streamed_response.reasoning_items_json,
                response_thinking_duration_ms: streamed_response.thinking_duration_ms,
                response_thinking_token_count: streamed_response.thinking_token_count,
                tool_calls_json: &streamed_response.tool_calls_json,
                directory_id: request.directory_id.as_deref().unwrap_or(""),
                context_compaction: request.context_compaction.unwrap_or(false),
                total_duration_ms: streamed_response.total_duration_ms,
                retry_failed_response: request.retry_failed_response.unwrap_or(false),
            },
        )?
    } else {
        crate::storage::services::chat_conversations::StoredChatExchange::default()
    };

    if streamed_response.status == "failed" {
        crate::api::failure::log_stream_failure(
            &database_path,
            &prepared_request.conversation_id,
            &streamed_response.id,
            "responses",
            &streamed_response.status,
            streamed_response.failure.as_ref(),
            serde_json::json!({
                "content_chars": streamed_response.content.chars().count(),
                "thinking_chars": streamed_response.thinking.chars().count(),
                "duration_ms": streamed_response.total_duration_ms,
                "retry_attempts": retry_probe.attempts(),
                "stop_reason": streamed_response.failure_stop_reason,
            }),
        )
        .await;
    }

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
        interruption_reason,
        recovery_outcome,
        failure_reason: streamed_response.failure_reason,
        failure_kind: None,
        tool_calls_json: streamed_response.tool_calls_json,
        token_usage: TokenUsage {
            input_tokens: streamed_response.token_usage.input_tokens,
            output_tokens: streamed_response.token_usage.output_tokens,
            cache_creation_input_tokens: streamed_response.token_usage.cache_creation_input_tokens,
            cache_read_input_tokens: streamed_response.token_usage.cache_read_input_tokens,
        },
        persisted_user_message_ids: persisted_exchange.user_message_ids,
        persisted_assistant_message_id: persisted_exchange.assistant_message_id,
    })
}

/// 该 API 档案是否启用 Responses WebSocket 传输
/// （`snowcfg.responsesWebSocket`，缺省关闭）。
fn responses_web_socket_enabled(config_json: &str) -> bool {
    serde_json::from_str::<Value>(config_json)
        .ok()
        .and_then(|parsed| parsed.get("snowcfg")?.get("responsesWebSocket")?.as_bool())
        .unwrap_or(false)
}
