use std::path::PathBuf;

use napi::bindgen_prelude::*;

use crate::api::anthropic::create_anthropic_response_stream;
use crate::api::chat::create_chat_completion_response_stream;
use crate::api::config::{
    get_api_request_context_for_profile, get_api_request_context_with_fallback,
    resolve_advanced_model,
};
use crate::api::gemini::create_gemini_response_stream;
use crate::api::interactions::create_interactions_response_stream;
use crate::api::responses::{
    create_response_stream_with_context, ResponsesApiRequest, ResponsesApiResult,
    ResponsesApiStreamCallback,
};
use crate::storage::services::chat_conversations::{
    get_conversation_api_profile, store_failed_chat_exchange,
};
use crate::storage::services::usage_records::{record_usage, UsageRecordInput};

fn normalize_non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

/// 失败终态分类：只在传输层空闲超时时为 `timeout`，其余上游/连接错误为
/// `provider_error`。渲染层的 run 结束原因据此区分「超时」与「上游报错」，
/// 不需要在渲染层匹配错误文案。
fn classify_failure_kind(error: &Error) -> &'static str {
    if crate::api::retry::is_stream_idle_timeout(error) {
        "timeout"
    } else {
        "provider_error"
    }
}

/// Applies a per-request thinking strength override onto a profile's
/// config_json (in-memory only — the stored profile is never mutated).
/// Mirrors the renderer's configThinking.ts: the thinking section matching
/// the request method is replaced with the override; "none" disables thinking
/// (enabled: false). The provider payload builders
/// (build_chat_reasoning_effort / build_responses_reasoning /
/// build_anthropic_thinking / build_gemini_thinking_config) then pick up the
/// override naturally.
fn apply_thinking_strength_override(
    config_json: &str,
    request_method: &str,
    strength: &str,
) -> String {
    let mut parsed: serde_json::Value =
        serde_json::from_str(config_json).unwrap_or_else(|_| serde_json::json!({}));
    let enabled = strength != "none";

    if !parsed
        .get("snowcfg")
        .is_some_and(serde_json::Value::is_object)
    {
        parsed["snowcfg"] = serde_json::json!({});
    }
    let snowcfg = parsed["snowcfg"].as_object_mut();

    if let Some(snowcfg) = snowcfg {
        match request_method {
            "anthropic" => {
                snowcfg.insert(
                    "thinking".to_string(),
                    serde_json::json!({
                        "type": "adaptive",
                        "enabled": enabled,
                        "effort": strength,
                    }),
                );
            }
            "gemini" => {
                snowcfg.insert(
                    "geminiThinking".to_string(),
                    serde_json::json!({
                        "enabled": enabled,
                        "thinkingLevel": strength,
                    }),
                );
            }
            "responses" => {
                snowcfg.insert(
                    "responsesReasoning".to_string(),
                    serde_json::json!({
                        "enabled": enabled,
                        "effort": strength,
                    }),
                );
            }
            _ => {
                snowcfg.insert(
                    "chatThinking".to_string(),
                    serde_json::json!({
                        "enabled": enabled,
                        "reasoning_effort": strength,
                    }),
                );
            }
        }
    }

    serde_json::to_string(&parsed).unwrap_or_else(|_| config_json.to_string())
}

/// Applies a per-request Responses Fast Mode override onto a profile's
/// config_json (in-memory only — the stored profile is never mutated).
/// `None` preserves the resolved profile configuration unchanged.
fn apply_responses_fast_mode_override(config_json: &str, fast_mode: Option<&str>) -> String {
    let Some(fast_mode) = fast_mode.map(str::trim).filter(|value| !value.is_empty()) else {
        return config_json.to_string();
    };

    let mut parsed: serde_json::Value =
        serde_json::from_str(config_json).unwrap_or_else(|_| serde_json::json!({}));
    if !parsed
        .get("snowcfg")
        .is_some_and(serde_json::Value::is_object)
    {
        parsed["snowcfg"] = serde_json::json!({});
    }

    if let Some(snowcfg) = parsed["snowcfg"].as_object_mut() {
        snowcfg.insert(
            "responsesFastMode".to_string(),
            serde_json::Value::String(fast_mode.to_string()),
        );
    }

    serde_json::to_string(&parsed).unwrap_or_else(|_| config_json.to_string())
}

fn resolve_sub_agent_profile(
    explicit_api_profile: Option<&str>,
    deprecated_config_profile: Option<&str>,
) -> Result<String> {
    normalize_non_empty(explicit_api_profile)
        .or_else(|| normalize_non_empty(deprecated_config_profile))
        .map(str::to_owned)
        .ok_or_else(|| {
            Error::from_reason(
                "Sub-agent API profile snapshot is required; refusing to fall back to the global active profile",
            )
        })
}

pub async fn create_response_stream(
    mut request: ResponsesApiRequest,
    on_chunk: ResponsesApiStreamCallback,
    stream_id: String,
) -> Result<ResponsesApiResult> {
    let failure_messages = request
        .messages
        .iter()
        .map(|message| {
            let mut context = message.to_context_message()?;
            context.tool_calls_json = None;
            Ok(context)
        })
        .collect::<Result<Vec<_>>>()?;
    let is_sub_agent = request.is_sub_agent_request();
    if is_sub_agent {
        // Goal Mode, WorkTree Mode, and WorkFlow Mode belong exclusively to the main conversation.
        // Keep the provider prompt and request-scoped tool injection in normal
        // mode for every sub-agent, even if a caller accidentally forwards
        // any mode flag.
        request.goal_mode = Some(false);
        request.worktree_mode = Some(false);
        request.workflow_mode = Some(false);
    }
    let deprecated_sub_agent_profile =
        normalize_non_empty(request.sub_agent_config_profile.as_deref()).map(str::to_owned);
    let explicit_api_profile =
        normalize_non_empty(request.api_profile.as_deref()).map(str::to_owned);
    let strict_sub_agent_profile = if is_sub_agent {
        Some(resolve_sub_agent_profile(
            explicit_api_profile.as_deref(),
            deprecated_sub_agent_profile.as_deref(),
        )?)
    } else {
        None
    };
    let request_conversation_id =
        normalize_non_empty(request.conversation_id.as_deref()).map(str::to_owned);

    let context = tokio::task::spawn_blocking(move || {
        if let Some(profile) = strict_sub_agent_profile {
            // Sub-agent snapshots are strict: credentials are reloaded by the
            // fixed profile name on every request, but a deleted profile must
            // fail instead of silently switching providers.
            get_api_request_context_for_profile(Some(&profile))
        } else {
            // Conversation-scoped profile resolution with graceful fallback:
            //   1. explicit apiProfile on the request (first message of a
            //      brand-new conversation binds its provider this way)
            //   2. the conversation's persisted api_profile_name binding
            //   3. the global active profile (legacy behaviour)
            let database_path = crate::storage::initialize_app_storage()
                .map(|storage_info| PathBuf::from(storage_info.database_path))
                .ok();
            let resolved_profile = explicit_api_profile.or_else(|| {
                request_conversation_id
                    .as_deref()
                    .and_then(|conversation_id| {
                        database_path.as_ref().and_then(|database_path| {
                            get_conversation_api_profile(database_path, conversation_id)
                                .ok()
                                .flatten()
                        })
                    })
            });
            get_api_request_context_with_fallback(resolved_profile.as_deref())
        }
    })
    .await
    .map_err(|join_error| {
        Error::from_reason(format!("Failed to resolve API configuration: {join_error}"))
    })??;
    // Tool discovery precedes context preparation. Give a new conversation its
    // final id before discovery so deferred tools never share a project-wide key.
    if !request.skip_context.unwrap_or(false)
        && !crate::api::ephemeral::is_active()
        && super::should_resolve_tools(&request)
    {
        request.conversation_id = Some(
            crate::storage::services::chat_conversations::resolve_conversation_id(
                &context.database_path,
                request.conversation_id.as_deref(),
                request.previous_response_id.as_deref(),
            )?,
        );
    }
    let resolved_model =
        resolve_advanced_model(request.model.as_deref(), &context.api_config.advanced_model)?;
    request.model = Some(resolved_model.clone());

    let failure_conversation_id = request.conversation_id.clone();
    let failure_previous_response_id = request.previous_response_id.clone();
    let failure_checkpoint_id = request.checkpoint_id.clone().unwrap_or_default();
    let failure_model = resolved_model;
    let failure_directory_id = request.directory_id.clone().unwrap_or_default();
    let failure_context_compaction = request.context_compaction.unwrap_or(false);
    let failure_skip_context = request.skip_context.unwrap_or(false);
    let failure_resume_after_compaction = request.resume_after_compaction.unwrap_or(false);
    // 重试失败回合：请求消息已随失败回合落库，失败重落库时不再重复写入，
    // 末尾的失败助手行由本次错误信息替换。
    let failure_retry_failed_response = request.retry_failed_response.unwrap_or(false);
    let failure_database_path = context.database_path.clone();
    // The profile that actually served this request. Persisted on failed
    // exchanges too so a conversation created by a failed first message is
    // still bound to the provider the user picked.
    let failure_api_profile = context.api_config.profile_name.clone();

    // Capture API config metadata for usage accounting. These are cloned
    // before `context` is moved into the provider call so they remain
    // available after the response returns.
    let usage_api_profile_name = context.api_config.profile_name.clone();
    let usage_api_config_id = context.api_config.id.clone();
    let usage_request_method = context.api_config.request_method.clone();
    let usage_database_path = context.database_path.clone();

    let cancel_token = crate::api::cancel::create_and_register(&stream_id);

    // Per-request runtime overrides (thinking strength / Responses Fast Mode):
    // overlay them onto the resolved profile's config_json in memory so the
    // provider payload builders pick them up. The stored profile is untouched.
    let mut api_config = context.api_config;
    api_config.config_json = apply_responses_fast_mode_override(
        &api_config.config_json,
        request.responses_fast_mode.as_deref(),
    );
    if let Some(strength) = normalize_non_empty(request.thinking_strength.as_deref()) {
        api_config.config_json = apply_thinking_strength_override(
            &api_config.config_json,
            &api_config.request_method,
            strength,
        );
    }

    let failure_api_key = api_config.api_key.clone();
    let result = match api_config.request_method.as_str() {
        "chat" => {
            create_chat_completion_response_stream(
                request,
                context.database_path,
                api_config,
            context.custom_headers,
            Some(on_chunk),
            cancel_token.clone(),
            )
            .await
        }
        "responses" => {
            create_response_stream_with_context(
                request,
                context.database_path,
                api_config,
            context.custom_headers,
            Some(on_chunk),
            cancel_token.clone(),
            )
            .await
        }
        "anthropic" => {
            create_anthropic_response_stream(
                request,
                context.database_path,
                api_config,
            context.custom_headers,
            Some(on_chunk),
            cancel_token.clone(),
            )
            .await
        }
        "gemini" => {
            create_gemini_response_stream(
                request,
                context.database_path,
                api_config,
            context.custom_headers,
            Some(on_chunk),
            cancel_token.clone(),
            )
            .await
        }
        "interactions" => {
            create_interactions_response_stream(
                request,
                context.database_path,
                api_config,
            context.custom_headers,
            Some(on_chunk),
            cancel_token.clone(),
            )
            .await
        }
        request_method => Err(Error::from_reason(format!(
            "Unsupported chat request method '{}'. Please switch the active API request method to Chat, Responses, Anthropic, Gemini, or Interactions.",
            request_method
        ))),
    };

    crate::api::cancel::unregister_stream(&stream_id);
    match result {
        Ok(response) => {
            if crate::api::ephemeral::is_active() { return Ok(response); }
            // Record token usage for every successful API call. Context
            // compaction requests also consume tokens and must be accounted
            // for. Errors here are non-fatal: we log and continue so the
            // chat response still reaches the user.
            let usage_response_id = response.id.clone();
            let usage_conversation_id = response.conversation_id.clone();
            let usage_model = response.model.clone();
            let usage_status = response.status.clone();
            let usage_input_tokens = response.token_usage.input_tokens;
            let usage_output_tokens = response.token_usage.output_tokens;
            let usage_cache_creation = response.token_usage.cache_creation_input_tokens;
            let usage_cache_read = response.token_usage.cache_read_input_tokens;
            let usage_is_sub_agent = is_sub_agent;
            let usage_dir_id = failure_directory_id.clone();
            let usage_api_profile = usage_api_profile_name.clone();
            let usage_api_config_id = usage_api_config_id.clone();
            let usage_req_method = usage_request_method.clone();
            let usage_db_path = usage_database_path.clone();
            if let Err(record_error) = tokio::task::spawn_blocking(move || {
                record_usage(
                    &usage_db_path,
                    &UsageRecordInput {
                        conversation_id: &usage_conversation_id,
                        response_id: &usage_response_id,
                        model: &usage_model,
                        api_profile_name: &usage_api_profile,
                        api_config_id: &usage_api_config_id,
                        request_method: &usage_req_method,
                        input_tokens: usage_input_tokens,
                        output_tokens: usage_output_tokens,
                        cache_creation_input_tokens: usage_cache_creation,
                        cache_read_input_tokens: usage_cache_read,
                        status: &usage_status,
                        is_sub_agent: usage_is_sub_agent,
                        directory_id: &usage_dir_id,
                    },
                )
            })
            .await
            {
                eprintln!("Failed to record usage: {record_error}");
            }
            Ok(response)
        }
        Err(error) => {
            let failure = crate::api::failure::ProviderFailure::from_message(
                &error.reason, Some(&failure_api_key),
            );
            let failure_reason = failure.reason();
            if cancel_token.is_cancelled() {
                return Ok(ResponsesApiResult {
                    id: String::new(), conversation_id: failure_conversation_id.unwrap_or_default(),
                    content: String::new(), thinking: String::new(), model: failure_model,
                    status: "cancelled".to_string(), interruption_reason: None,
                    recovery_outcome: None, failure_reason: None, failure_kind: None,
                    tool_calls_json: "[]".to_string(),
                    token_usage: crate::api::responses::TokenUsage {
                        input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0,
                        cache_read_input_tokens: 0,
                    },
                    persisted_user_message_ids: Vec::new(),
                    persisted_assistant_message_id: String::new(),
                });
            }
            if failure_context_compaction {
                crate::api::failure::log_stream_failure(
                    &failure_database_path, failure_conversation_id.as_deref().unwrap_or(""),
                    "", &usage_request_method, "error", Some(&failure), serde_json::json!({}),
                ).await;
                return Err(Error::from_reason(failure_reason.unwrap_or_default()));
            }
            let failure_log_db = failure_database_path.clone();
            let error_message = failure_reason.clone().unwrap_or_default();
            let persisted_error_message = error_message.clone();
            let persisted_failure_model = failure_model.clone();
            let failure_dir_id = failure_directory_id.clone();
            let persisted_failure_api_profile = failure_api_profile.clone();
            let persisted_failure_resume = failure_resume_after_compaction;
            let (conversation_id, persisted_user_message_ids) =
                if failure_skip_context || crate::api::ephemeral::is_active() {
                    (failure_conversation_id.unwrap_or_default(), Vec::new())
                } else {
                tokio::task::spawn_blocking(move || {
                    store_failed_chat_exchange(
                        &failure_database_path,
                        failure_conversation_id.as_deref(),
                        failure_previous_response_id.as_deref(),
                        &failure_messages,
                        &failure_checkpoint_id,
                        &persisted_failure_model,
                        &persisted_failure_api_profile,
                        &failure_directory_id,
                        persisted_failure_resume,
                        failure_retry_failed_response,
                        &persisted_error_message,
                    )
                })
                .await
                .map_err(|join_error| {
                    Error::from_reason(format!(
                        "Failed to persist chat request error: {}",
                        join_error
                    ))
                })??
                };
            // Resolve/create the conversation before emitting its terminal log.
            crate::api::failure::log_stream_failure(
                &failure_log_db, &conversation_id, "", &usage_request_method, "error",
                Some(&failure), serde_json::json!({}),
            ).await;

            // Record the failed API call with zero token usage so the usage
            // history reflects every attempt, not just successful ones.
            let usage_conversation_id = conversation_id.clone();
            let usage_model = failure_model.clone();
            let usage_api_profile = usage_api_profile_name.clone();
            let usage_api_config_id = usage_api_config_id.clone();
            let usage_req_method = usage_request_method.clone();
            let usage_db_path = usage_database_path.clone();
            let usage_is_sub_agent = is_sub_agent;
            if !crate::api::ephemeral::is_active() {
            if let Err(record_error) = tokio::task::spawn_blocking(move || {
                record_usage(
                    &usage_db_path,
                    &UsageRecordInput {
                        conversation_id: &usage_conversation_id,
                        response_id: "",
                        model: &usage_model,
                        api_profile_name: &usage_api_profile,
                        api_config_id: &usage_api_config_id,
                        request_method: &usage_req_method,
                        input_tokens: 0,
                        output_tokens: 0,
                        cache_creation_input_tokens: 0,
                        cache_read_input_tokens: 0,
                        status: "error",
                        is_sub_agent: usage_is_sub_agent,
                        directory_id: &failure_dir_id,
                    },
                )
            })
            .await
            {
                eprintln!("Failed to record failed usage: {record_error}");
            }
            }

            let failure_kind = classify_failure_kind(&error);
            Ok(ResponsesApiResult {
                id: String::new(),
                conversation_id,
                content: String::new(),
                thinking: String::new(),
                model: failure_model,
                status: "error".to_string(),
                interruption_reason: None,
                recovery_outcome: None,
                failure_reason,
                failure_kind: Some(failure_kind.to_string()),
                tool_calls_json: "[]".to_string(),
                token_usage: crate::api::responses::TokenUsage {
                    input_tokens: 0,
                    output_tokens: 0,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                },
                persisted_user_message_ids,
                persisted_assistant_message_id: String::new(),
            })
        }
    }
}
