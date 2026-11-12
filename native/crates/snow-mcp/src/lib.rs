pub mod builtin;
pub mod codebase_review;
pub use snow_tools::external;
pub mod privacy_mask;
pub mod servers;
pub mod service;
pub mod tools;

pub(crate) mod i18n {
    pub use snow_storage::i18n::*;
}

// 兼容外观：沿用搬迁前的 `crate::api::*` / `crate::mcp::*` / `crate::storage::*` / `crate::utils::*` / `crate::exports::*` / `crate::remote_control::*`。
pub(crate) mod api {
    pub use crate::codebase_review;
    pub use snow_ai::config;
    pub use snow_net::http_client;
    pub use snow_net::retry;
    pub use snow_providers::{anthropic, chat, common, gemini, responses, vision};
    pub use snow_retrieval::{decision_model, embedding, reranking};
    pub use snow_runtime::cancel;
    pub use snow_text::token_counter;

    pub mod ephemeral {
        pub async fn run<T, F, Fut>(
            mut request: snow_providers::responses::ResponsesApiRequest,
            call: F,
        ) -> T
        where
            F: FnOnce(snow_providers::responses::ResponsesApiRequest) -> Fut,
            Fut: std::future::Future<Output = T>,
        {
            request.skip_context = Some(true);
            request.disable_tools = Some(true);
            request.conversation_id = None;
            request.previous_response_id = None;
            request.sub_agent_tools_json = None;
            request.sub_agent_system_prompt = None;
            request.sub_agent_config_profile = None;
            request.allowed_tools_json = None;
            request.context_compaction = None;
            request.resume_after_compaction = None;
            snow_runtime::ephemeral::scope(call(request)).await
        }
    }

    pub mod conversation {
        pub use snow_storage::image_optimize;
        pub use snow_storage::media as images;
        pub use snow_storage::tool_messages;

        pub mod context {
            use snow_providers::responses::ResponsesApiMessage;

            pub async fn apply_configured_system_prompts(
                messages: &mut Vec<ResponsesApiMessage>,
                system_prompt_ids_json: &str,
                conversation_id: Option<&str>,
            ) {
                let configured =
                    snow_storage::configured_prompts::resolve_configured_system_prompts(
                        system_prompt_ids_json,
                        conversation_id,
                    )
                    .await;
                if configured.is_empty() {
                    return;
                }
                let demoted: Vec<String> = messages
                    .iter()
                    .filter(|message| message.role == "system")
                    .map(|message| message.content.clone())
                    .collect();
                messages.retain(|message| message.role != "system");
                let mut result: Vec<ResponsesApiMessage> = configured
                    .into_iter()
                    .map(|content| text_message("system", content))
                    .collect();
                result.extend(
                    demoted
                        .into_iter()
                        .map(|content| text_message("user", content)),
                );
                result.append(messages);
                *messages = result;
            }

            fn text_message(role: &str, content: String) -> ResponsesApiMessage {
                ResponsesApiMessage {
                    role: role.to_string(),
                    origin: Some(
                        snow_storage::chat_conversations::ORIGIN_INTERNAL.to_string(),
                    ),
                    content,
                    tool_results_json: None,
                    thinking: None,
                    thinking_blocks_json: None,
                    tool_calls_json: None,
                }
            }
        }
    }
}

pub(crate) mod mcp {
    pub use crate::{builtin, privacy_mask, servers, tools};

    pub mod external {
        pub use snow_tools::external::*;
    }
}

pub(crate) mod storage {
    pub use snow_plugin::*;
    pub use snow_storage_core::models::*;
    pub use snow_storage_services::*;

    pub mod database {
        pub use snow_storage_core::database::*;
    }

    pub mod paths {
        pub use snow_support::app_paths::*;
    }

    pub mod services {
        pub use snow_storage_services::services::*;
    }
}

pub(crate) mod utils {
    pub mod panic_guard {
        pub use snow_support::panic_guard::*;
    }
    pub mod paths {
        pub use snow_support::paths::*;
    }
    pub mod process {
        pub use snow_process::process::*;
    }
    pub mod process_tree {
        pub use snow_process::process_tree::*;
    }
}

pub(crate) mod exports {
    pub mod terminal {
        pub use snow_process::terminal::*;
    }
}

pub(crate) mod remote_control {
    pub use snow_remote::*;
}
