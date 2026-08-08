use std::path::PathBuf;

use napi::bindgen_prelude::*;

use crate::api::anthropic::create_anthropic_response_stream;
use crate::api::chat::create_chat_completion_response_stream;
use crate::api::config::{
    get_api_request_context_for_profile, get_api_request_context_with_fallback,
};
use crate::api::gemini::create_gemini_response_stream;
use crate::api::responses::{
    create_response_stream_with_context, ResponsesApiRequest, ResponsesApiResult,
    ResponsesApiStreamCallback,
};
use crate::storage::services::app_logs::{insert_app_log, AppLogInput};
use crate::storage::services::chat_conversations::{
    get_conversation_api_profile, store_failed_chat_exchange, ChatContextMessage,
};
use crate::storage::services::usage_records::{record_usage, UsageRecordInput};

fn normalize_non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
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

fn resolve_sub_agent_model(requested_model: Option<&str>, advanced_model: &str) -> Result<String> {
    normalize_non_empty(requested_model)
        .or_else(|| normalize_non_empty(Some(advanced_model)))
        .map(str::to_owned)
        .ok_or_else(|| Error::from_reason("Sub-agent model snapshot is not available"))
}

pub async fn create_response_stream(
    mut request: ResponsesApiRequest,
    on_chunk: ResponsesApiStreamCallback,
    stream_id: String,
) -> Result<ResponsesApiResult> {
    let is_sub_agent = request.is_sub_agent_request();
    if is_sub_agent {
        // Plan Mode and Goal Mode belong exclusively to the main conversation.
        // Keep the provider prompt and request-scoped tool injection in normal
        // mode for every sub-agent, even if a caller accidentally forwards
        // plan_mode or goal_mode.
        request.plan_mode = Some(false);
        request.goal_mode = Some(false);
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
    if is_sub_agent {
        request.model = Some(resolve_sub_agent_model(
            request.model.as_deref(),
            &context.api_config.advanced_model,
        )?);
    }

    let failure_messages = request
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
    let failure_conversation_id = request.conversation_id.clone();
    let failure_previous_response_id = request.previous_response_id.clone();
    let failure_checkpoint_id = request.checkpoint_id.clone().unwrap_or_default();
    let failure_model = request
        .model
        .clone()
        .unwrap_or_else(|| context.api_config.advanced_model.clone());
    let failure_directory_id = request.directory_id.clone().unwrap_or_default();
    let failure_context_compaction = request.context_compaction.unwrap_or(false);
    let failure_resume_after_compaction = request.resume_after_compaction.unwrap_or(false);
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

    let result = match context.api_config.request_method.as_str() {
        "chat" => {
            create_chat_completion_response_stream(
                request,
                context.database_path,
                context.api_config,
                context.custom_headers,
                on_chunk,
                cancel_token.clone(),
            )
            .await
        }
        "responses" => {
            create_response_stream_with_context(
                request,
                context.database_path,
                context.api_config,
                context.custom_headers,
                on_chunk,
                cancel_token.clone(),
            )
            .await
        }
        "anthropic" => {
            create_anthropic_response_stream(
                request,
                context.database_path,
                context.api_config,
                context.custom_headers,
                on_chunk,
                cancel_token.clone(),
            )
            .await
        }
        "gemini" => {
            create_gemini_response_stream(
                request,
                context.database_path,
                context.api_config,
                context.custom_headers,
                on_chunk,
                cancel_token.clone(),
            )
            .await
        }
        request_method => Err(Error::from_reason(format!(
            "Unsupported chat request method '{}'. Please switch the active API request method to Chat, Responses, Anthropic or Gemini.",
            request_method
        ))),
    };

    crate::api::cancel::unregister_stream(&stream_id);
    match result {
        Ok(response) => {
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
            if failure_context_compaction {
                // Context compaction failures are surfaced to the renderer
                // as a raw Err (no persisted error exchange). Log the full
                // request metadata here so the app_logs table captures enough
                // detail to diagnose provider/model/config issues without
                // needing to reproduce the failure.
                let compaction_error = error.to_string();
                let compaction_db = failure_database_path.clone();
                let compaction_context = serde_json::json!({
                    "conversation_id": failure_conversation_id,
                    "model": failure_model,
                    "directory_id": failure_directory_id,
                    "request_method": usage_request_method,
                    "api_profile": usage_api_profile_name,
                })
                .to_string();
                tokio::task::spawn_blocking(move || {
                    let _ = insert_app_log(
                        &compaction_db,
                        &AppLogInput {
                            level: "ERROR".to_string(),
                            module: "api".to_string(),
                            func: "create_response_stream".to_string(),
                            line: None,
                            message: "Context compaction request failed".to_string(),
                            input: None,
                            output: None,
                            duration: None,
                            context: Some(compaction_context),
                            error: Some(compaction_error),
                            source: "main".to_string(),
                        },
                    );
                });
                return Err(error);
            }
            let error_message = error.to_string();
            let persisted_error_message = error_message.clone();
            let persisted_failure_model = failure_model.clone();
            let failure_dir_id = failure_directory_id.clone();
            let persisted_failure_api_profile = failure_api_profile.clone();
            let persisted_failure_resume = failure_resume_after_compaction;
            let conversation_id = tokio::task::spawn_blocking(move || {
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
                    &persisted_error_message,
                )
            })
            .await
            .map_err(|join_error| {
                Error::from_reason(format!(
                    "Failed to persist chat request error: {}",
                    join_error
                ))
            })??;

            // Record the failed API call with zero token usage so the usage
            // history reflects every attempt, not just successful ones.
            let usage_conversation_id = conversation_id.clone();
            let usage_model = failure_model.clone();
            let usage_api_profile = usage_api_profile_name.clone();
            let usage_api_config_id = usage_api_config_id.clone();
            let usage_req_method = usage_request_method.clone();
            let usage_db_path = usage_database_path.clone();
            let usage_is_sub_agent = is_sub_agent;
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

            Ok(ResponsesApiResult {
                id: String::new(),
                conversation_id,
                content: error_message,
                thinking: String::new(),
                model: failure_model,
                status: "error".to_string(),
                tool_calls_json: "[]".to_string(),
                token_usage: crate::api::responses::TokenUsage {
                    input_tokens: 0,
                    output_tokens: 0,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                },
                persisted_user_message_ids: Vec::new(),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{resolve_sub_agent_model, resolve_sub_agent_profile};

    #[test]
    fn explicit_sub_agent_profile_is_trimmed_and_preferred() {
        let profile =
            resolve_sub_agent_profile(Some("  pinned-profile  "), Some("deprecated-profile"))
                .expect("resolve explicit profile");

        assert_eq!(profile, "pinned-profile");
    }

    #[test]
    fn deprecated_sub_agent_profile_remains_a_legacy_fallback() {
        let profile = resolve_sub_agent_profile(Some("  "), Some(" legacy-profile "))
            .expect("resolve deprecated profile");

        assert_eq!(profile, "legacy-profile");
    }

    #[test]
    fn blank_sub_agent_profiles_fail_instead_of_using_global_active_profile() {
        let error = resolve_sub_agent_profile(Some(" \n "), Some("\t"))
            .expect_err("blank snapshots must fail");

        assert!(error
            .to_string()
            .contains("refusing to fall back to the global active profile"));
    }

    #[test]
    fn explicit_sub_agent_model_is_trimmed_and_preferred() {
        let model = resolve_sub_agent_model(Some("  pinned-model  "), "advanced-model")
            .expect("resolve explicit model");

        assert_eq!(model, "pinned-model");
    }

    #[test]
    fn blank_sub_agent_model_uses_profile_advanced_model() {
        let model = resolve_sub_agent_model(Some("  "), "  advanced-model  ")
            .expect("resolve advanced model");

        assert_eq!(model, "advanced-model");
    }

    #[test]
    fn missing_sub_agent_model_snapshot_fails() {
        let error =
            resolve_sub_agent_model(None, " \n ").expect_err("missing model snapshots must fail");

        assert!(error
            .to_string()
            .contains("Sub-agent model snapshot is not available"));
    }
}
