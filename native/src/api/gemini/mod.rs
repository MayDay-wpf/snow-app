//! Gemini API entry point.
//!
//! This module orchestrates the full request lifecycle: context
//! preparation, payload construction, streaming collection, and result
//! persistence. Heavy logic lives in the sibling `payload`, `event`, and
//! `stream` modules so that this file stays focused on orchestration.

mod antigravity_schema;
mod event;
pub(crate) mod payload;
mod stream;

pub(crate) use event::apply_event_usage as apply_gemini_event_usage;

use std::collections::HashMap;
use std::path::PathBuf;

use napi::bindgen_prelude::*;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use crate::api::config::resolve_advanced_model;
use crate::api::conversation::{
    prepare_context_request, resolve_request_tools_optional, tail_guard, ConversationContextRequest,
};
use crate::api::responses::{
    ResponsesApiRequest, ResponsesApiResult, ResponsesApiStreamCallback, TokenUsage,
};
use crate::api::retry::{
    classify_final_stream_warning, resolve_empty_response_terminal,
    resolve_stream_idle_timeout_sec, FinalStreamWarningDisposition, RetryOptions,
};
use crate::storage::services::app_logs::{
    log_api_error, log_api_warning, maybe_log_api_request_for_conversation,
    maybe_log_api_response_for_conversation,
};
use crate::storage::services::chat_conversations::{
    store_chat_exchange, StoreChatExchangeInput,
};
use crate::storage::ApiConfigRecord;

/// Produce a recovery-only protocol audit without persisting prompts, tool
/// arguments/results, credentials, or opaque Gemini thought signatures.
fn gemini_recovery_outbound_audit(payload: &Value) -> String {
    let contents = payload
        .get("contents")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let (function_calls, function_responses) = contents
        .iter()
        .flat_map(|content| {
            content
                .get("parts")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .fold((0usize, 0usize), |(calls, responses), part| {
            (
                calls + usize::from(part.get("functionCall").is_some()),
                responses + usize::from(part.get("functionResponse").is_some()),
            )
        });
    let tool_entries = payload.get("tools").and_then(Value::as_array);
    let function_declarations = tool_entries
        .into_iter()
        .flatten()
        .map(|tool| {
            tool.get("functionDeclarations")
                .and_then(Value::as_array)
                .map_or(0, Vec::len)
        })
        .sum::<usize>();
    let google_search_entries = tool_entries
        .into_iter()
        .flatten()
        .filter(|tool| tool.get("googleSearch").is_some())
        .count();
    json!({
        "contents": contents.len(),
        "functionCallParts": function_calls,
        "functionResponseParts": function_responses,
        "toolsField": if tool_entries.is_some() { "present" } else { "absent" },
        "functionDeclarations": function_declarations,
        "googleSearchEntries": google_search_entries,
        "systemInstructionParts": payload
            .pointer("/systemInstruction/parts")
            .and_then(Value::as_array)
            .map_or(0, Vec::len),
    })
    .to_string()
}

fn gemini_recovery_inbound_audit(streamed_response: &stream::GeminiStreamResult) -> String {
    let tool_calls =
        serde_json::from_str::<Vec<Value>>(&streamed_response.tool_calls_json).unwrap_or_default();
    let tool_names = tool_calls
        .iter()
        .filter_map(|tool| tool.get("name").and_then(Value::as_str))
        .collect::<Vec<_>>();
    json!({
        "status": streamed_response.status,
        "contentChars": streamed_response.content.chars().count(),
        "thinkingChars": streamed_response.thinking.chars().count(),
        "toolCallCount": tool_calls.len(),
        "toolNames": tool_names,
        "durationMs": streamed_response.total_duration_ms,
    })
    .to_string()
}

/// Public entry point — create a Gemini streaming response.
pub async fn create_gemini_response_stream(
    request: ResponsesApiRequest,
    database_path: PathBuf,
    api_config: ApiConfigRecord,
    custom_headers: HashMap<String, String>,
    on_chunk: Option<ResponsesApiStreamCallback>,
    cancel_token: CancellationToken,
) -> Result<ResponsesApiResult> {
    let on_chunk = crate::api::common::StreamSink::new(on_chunk.as_ref());
    create_gemini_response_async(
        request,
        database_path,
        api_config,
        custom_headers,
        on_chunk,
        cancel_token,
    )
    .await
}

async fn create_gemini_response_async(
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
    if request.messages.is_empty() {
        return Err(Error::from_reason("At least one chat message is required"));
    }

    let api_key = api_config.api_key.trim();
    if api_key.is_empty() {
        return Err(Error::from_reason(
            "API key not configured. Please configure API settings first.",
        ));
    }

    let model = resolve_advanced_model(request.model.as_deref(), &api_config.advanced_model)?;

    let endpoint = payload::resolve_gemini_endpoint(&api_config, &model, api_key);
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

    // Session-scoped header placeholders (e.g. `{{session_id}}`) resolve to the
    // conversation this request is stored under.
    crate::api::common::expand_custom_header_session_id(
        &mut custom_headers,
        &prepared_request.conversation_id,
    );
    crate::api::oauth::provider::apply_request_headers(&api_config, &mut custom_headers);

    let client = crate::api::http_client::build_proxied_client()
        .await
        .map_err(|error| Error::from_reason(format!("Failed to create HTTP client: {}", error)))?;
    let skip_context = request.skip_context.unwrap_or(false);
    let mut prepared_messages = prepared_request.messages;
    crate::api::vision::textify_images_in_messages(
        &mut prepared_messages,
        &database_path,
        &api_config,
        &custom_headers,
        request.skips_inline_image_parsing(),
        Some(prepared_request.conversation_id.as_str()),
        on_chunk.callback(),
        Some(&cancel_token),
    )
    .await?;

    let tools = allowed_tools
        .as_deref()
        .map(crate::mcp::tools::tools_as_gemini_json);
    let mut payload = payload::build_gemini_payload(
        &prepared_messages,
        &database_path,
        &request,
        &api_config,
        tools,
        &prepared_request.user_system_prompts,
        &prepared_request.host_system_prompts,
    )?;
    // 尾轮守卫：Gemini 拒绝以 model 轮收尾的请求。
    let tail_guard = tail_guard::guard_gemini_payload(&mut payload);
    if tail_guard.fired() {
        log_api_warning(
            &database_path,
            "gemini_tail_guard",
            "Gemini payload tail turn repaired",
            &format!(
                "dropped_model_turns={}, appended_user={}, model={}, conversation_id={}",
                tail_guard.dropped_model_turns,
                tail_guard.appended_user,
                model,
                prepared_request.conversation_id,
            ),
        )
        .await;
    }
    if let Some(metadata) =
        crate::api::oauth::provider::antigravity_profile_metadata(&api_config.config_json)
    {
        payload = payload::wrap_antigravity_payload(payload, &model, metadata.account_id.trim());
    }
    let tool_guard = crate::api::plugin_tool_guard::PluginToolGuard::capture(
        crate::api::plugin_tool_guard::Protocol::Gemini,
        request.directory_id.as_deref(),
        plugin_tool_configuration,
        &payload,
    )
    .await?;
    let (endpoint, payload) = crate::api::oauth::plugin::transform_request(
        &api_config,
        "gemini",
        &model,
        endpoint,
        payload,
        &mut custom_headers,
    )
    .await?;
    let is_duplicate_recovery = request.disable_tools.unwrap_or(false);
    if is_duplicate_recovery {
        log_api_warning(
            &database_path,
            "gemini_duplicate_recovery_outbound",
            "Gemini duplicate recovery protocol audit",
            &gemini_recovery_outbound_audit(&payload),
        )
        .await;
    }
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
        "gemini".to_string(),
        endpoint.clone(),
        request_payload_json,
        prepared_request.conversation_id.clone(),
        api_config.api_key.clone(),
    )
    .await;

    let streamed_response = match stream::collect_gemini_stream(
        &client,
        database_path.clone(),
        &endpoint,
        &custom_headers,
        payload,
        &tool_guard,
        on_chunk,
        &cancel_token,
        &retry_options,
        stream_idle_timeout_sec,
    )
    .await
    {
        Ok(result) => result,
        Err(error) => {
            maybe_log_api_response_for_conversation(
                database_path.clone(),
                "gemini".to_string(),
                endpoint.clone(),
                serde_json::json!({"error": error.reason}).to_string(),
                prepared_request.conversation_id.clone(),
                api_config.api_key.clone(),
            )
            .await;
            log_api_error(
                &database_path,
                "create_gemini_response_stream",
                "Gemini API call failed",
                &error.reason,
            )
            .await;
            return Err(error);
        }
    };
    if is_duplicate_recovery {
        log_api_warning(
            &database_path,
            "gemini_duplicate_recovery_inbound",
            "Gemini duplicate recovery protocol audit",
            &gemini_recovery_inbound_audit(&streamed_response),
        )
        .await;
    }
    let response_body_json = serde_json::json!({
        "id": streamed_response.id,
        "model": streamed_response.model,
        "status": streamed_response.status,
        "content": streamed_response.content,
        "thinking": streamed_response.thinking,
        "tool_calls": serde_json::from_str::<Value>(&streamed_response.tool_calls_json)
            .unwrap_or_else(|_| serde_json::json!([])),
    });
    maybe_log_api_response_for_conversation(
        database_path.clone(),
        "gemini".to_string(),
        endpoint.clone(),
        serde_json::to_string(&response_body_json).unwrap_or_default(),
        prepared_request.conversation_id.clone(),
        api_config.api_key.clone(),
    )
    .await;

    // See chat/mod.rs: assistant raw_events are not needed for replay, so we
    // skip serializing the full SSE chunk array to avoid DB bloat.
    let raw_response_json = "{}";
    let has_response_payload = !streamed_response.content.is_empty()
        || !streamed_response.thinking.is_empty()
        || streamed_response.tool_calls_json != "[]";
    // 空响应重试预算耗尽：把「正常收尾但零载荷」显式标记为 empty_response /
    // retry_exhausted，避免落库后与正常完成同形（前端与日志都无从分辨）。
    let (terminal_reason, terminal_outcome) = resolve_empty_response_terminal(
        &streamed_response.status,
        streamed_response.interruption_reason,
        streamed_response.recovery_outcome,
        has_response_payload,
    );
    let interruption_reason = terminal_reason.map(|reason| reason.as_code().to_string());
    let recovery_outcome = terminal_outcome.map(|outcome| outcome.as_code().to_string());

    match classify_final_stream_warning(
        &streamed_response.status,
        streamed_response.interruption_reason,
        has_response_payload,
    ) {
        FinalStreamWarningDisposition::TransportInterrupted(reason) => {
            log_api_warning(
                &database_path,
                "create_gemini_response_stream",
                "AI response stream interrupted",
                &format!(
                    "provider=gemini, request_method=gemini, reason={}, outcome={}, model={}, status={}, conversation_id={}, response_id={}, content_chars={}, thinking_chars={}, duration_ms={}",
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
                "create_gemini_response_stream",
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
                // Persist the requested model, not the model echoed back by the
                // API response body. Some providers (e.g. aliased models with
                // date-stamped snapshots like `deepseek-flash-0731`) return a
                // different name than what was requested; trusting the response
                // would corrupt the conversation's recorded model and the chat
                // input's model display on the next load.
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
                response_thinking_blocks_json: &streamed_response.thinking_blocks_json,
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
        failure_reason: None,
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
