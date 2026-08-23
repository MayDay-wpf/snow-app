//! Chat Completions API entry point.
//!
//! This module orchestrates the full request lifecycle: context
//! preparation, payload construction, streaming collection, and result
//! persistence. Heavy logic lives in the sibling `payload`, `event`, and
//! `stream` modules so that this file stays focused on orchestration.

mod event;
pub(crate) mod payload;
mod stream;

use std::collections::HashMap;
use std::path::PathBuf;

use napi::bindgen_prelude::*;
use tokio_util::sync::CancellationToken;

use crate::api::config::resolve_advanced_model;
use crate::api::conversation::{
    prepare_context_request, resolve_sub_agent_tools, ConversationContextRequest,
};
use crate::api::responses::{
    ResponsesApiRequest, ResponsesApiResult, ResponsesApiStreamCallback, TokenUsage,
};
use crate::api::retry::{
    classify_final_stream_warning, resolve_stream_idle_timeout_sec, FinalStreamWarningDisposition,
    RetryOptions,
};
use crate::storage::services::app_logs::{log_api_error, log_api_warning, maybe_log_api_request};
use crate::storage::services::chat_conversations::{
    store_chat_exchange, ChatContextMessage, StoreChatExchangeInput,
};
use crate::storage::ApiConfigRecord;

/// Public entry point — create a Chat Completions streaming response.
pub async fn create_chat_completion_response_stream(
    request: ResponsesApiRequest,
    database_path: PathBuf,
    api_config: ApiConfigRecord,
    custom_headers: HashMap<String, String>,
    on_chunk: ResponsesApiStreamCallback,
    cancel_token: CancellationToken,
) -> Result<ResponsesApiResult> {
    create_chat_completion_response_async(
        request,
        database_path,
        api_config,
        custom_headers,
        &on_chunk,
        cancel_token,
    )
    .await
}

async fn create_chat_completion_response_async(
    request: ResponsesApiRequest,
    database_path: PathBuf,
    api_config: ApiConfigRecord,
    custom_headers: HashMap<String, String>,
    on_chunk: &ResponsesApiStreamCallback,
    cancel_token: CancellationToken,
) -> Result<ResponsesApiResult> {
    if request.messages.is_empty() {
        return Err(Error::from_reason("At least one chat message is required"));
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
    let model =
        resolve_advanced_model(request.model.as_deref(), &api_config.advanced_model)?;

    let endpoint = payload::resolve_chat_completions_endpoint(&api_config);
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
        worktree_mode: request.worktree_mode.unwrap_or(false),
        is_sub_agent: request.is_sub_agent_request(),
        sub_agent_system_prompt: request.sub_agent_system_prompt.as_deref(),
        system_prompt_ids_json: &api_config.system_prompt_ids_json,
        remote_role_content: request.remote_role_content.as_deref(),
        remote_include_global_rules: request.remote_include_global_rules,
    }).await?;

    let skip_context = request.skip_context.unwrap_or(false);
    let mut prepared_messages = prepared_request.messages;
    crate::api::vision::textify_images_in_messages(
        &mut prepared_messages,
        &database_path,
        &api_config,
        &custom_headers,
        skip_context,
        Some(on_chunk),
        Some(&cancel_token),
    )
    .await?;

    let client = crate::api::http_client::build_proxied_client()
        .await
        .map_err(|error| Error::from_reason(format!("Failed to create HTTP client: {}", error)))?;
    let tools = if request.context_compaction.unwrap_or(false)
        || skip_context
        || request.disable_tools.unwrap_or(false)
    {
        None
    } else {
        match resolve_sub_agent_tools(&request).await {
            Ok(tools) => Some(crate::mcp::tools::tools_as_openai_chat_json(&tools)),
            Err(error) => {
                eprintln!("Failed to prepare MCP tools for OpenAI Chat: {error}");
                None
            }
        }
    };
    let payload = payload::build_chat_completions_payload(
        &prepared_messages,
        &database_path,
        &request,
        &api_config,
        tools,
        &prepared_request.user_system_prompts,
    )?;
    let retry_options = RetryOptions::from_config(
        api_config.max_retries,
        api_config.retry_base_delay_ms,
        api_config.partial_retry_max_chars,
    );
    let stream_idle_timeout_sec =
        resolve_stream_idle_timeout_sec(api_config.stream_idle_timeout_sec);

    let request_payload_json = serde_json::to_string(&payload).unwrap_or_default();
    maybe_log_api_request(
        database_path.clone(),
        "chat".to_string(),
        endpoint.clone(),
        request_payload_json,
    )
    .await;

    let streamed_response = match stream::collect_chat_completions_stream(
        &client,
        &endpoint,
        api_key,
        &custom_headers,
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
                "create_chat_completion_response_stream",
                "Chat completions API call failed",
                &error.reason,
            );
            return Err(error);
        }
    };
    // The full SSE chunk array (raw_events) used to be serialized into
    // raw_response_json and persisted into chat_messages.raw_json for assistant
    // messages. That column is only read back for tool-role messages (to
    // reconstruct tool_call_id) and for image-ref stripping (which only
    // operates on the [{name,callId,result}] tool format). Persisting the
    // entire chunk stream for assistant messages wasted ~90% of the database
    // space (each token produced a chunk repeating id/model/fingerprint), so we
    // now store "{}" instead.
    let raw_response_json = "{}";
    let transport_interruption_reason = streamed_response
        .interruption_reason
        .filter(|reason| reason.is_transport());
    let interruption_reason = streamed_response
        .interruption_reason
        .map(|reason| reason.as_code().to_string());
    let recovery_outcome = streamed_response
        .recovery_outcome
        .map(|outcome| outcome.as_code().to_string());

    if transport_interruption_reason.is_none() {
        for parse_error in &streamed_response.tool_parse_errors {
            log_api_warning(
                &database_path,
                "create_chat_completion_response_stream",
                "Tool call JSON parse failed after streaming",
                parse_error,
            );
        }
    }

    let has_response_payload = !streamed_response.content.is_empty()
        || !streamed_response.thinking.is_empty()
        || streamed_response.tool_calls_json != "[]";
    match classify_final_stream_warning(
        &streamed_response.status,
        streamed_response.interruption_reason,
        has_response_payload,
    ) {
        FinalStreamWarningDisposition::TransportInterrupted(reason) => {
            log_api_warning(
                &database_path,
                "create_chat_completion_response_stream",
                "AI response stream interrupted",
                &format!(
                    "provider=chat_completions, request_method=chat, reason={}, outcome={}, model={}, status={}, conversation_id={}, response_id={}, content_chars={}, thinking_chars={}, duration_ms={}",
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
            );
        }
        FinalStreamWarningDisposition::EmptyResponse => {
            log_api_warning(
                &database_path,
                "create_chat_completion_response_stream",
                "AI returned empty response",
                &format!(
                    "model={}, status={}",
                    streamed_response.model, streamed_response.status
                ),
            );
        }
        FinalStreamWarningDisposition::None => {}
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
                model: &model,
                api_profile_name: &api_config.profile_name,
                status: &streamed_response.status,
                interruption_reason: interruption_reason.as_deref(),
                recovery_outcome: recovery_outcome.as_deref(),
                raw_response_json: &raw_response_json,
                token_usage: streamed_response.token_usage,
                response_thinking: &streamed_response.thinking,
                response_thinking_blocks_json: "[]",
                tool_calls_json: &streamed_response.tool_calls_json,
                directory_id: request.directory_id.as_deref().unwrap_or(""),
                context_compaction: request.context_compaction.unwrap_or(false),
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
        interruption_reason,
        recovery_outcome,
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
