pub mod codebase_state_port;

pub use snow_providers::anthropic;
pub mod browser_import;
pub mod browser_history;
pub use snow_runtime::cancel;
pub use snow_providers::chat;
pub use snow_mcp::codebase_review;
pub mod commit_message;
pub use snow_providers::common;
pub use snow_ai::config;
pub mod conversation;
pub use snow_retrieval::{decision_model, embedding, model_health, reranking};
pub mod ephemeral;
pub mod prompt_optimization;
pub mod prompt_context;
pub mod file_search_agent;
pub use snow_providers::gemini;
pub use snow_net::http_client;
pub use snow_providers::interactions;
pub use snow_ai::models;
pub use snow_ai::oauth;
pub mod reply_prediction;
pub mod repo_wiki;
pub use snow_net::request_proxy;
pub use snow_providers::responses;
pub use snow_net::retry;
pub use snow_net::sse;
pub mod summary;
pub mod theme_palette;
pub use snow_text::token_counter;
pub mod tool_correction;

/// 把完整初始化注入 core，供 net 等下层 crate 取数据库路径。
#[ctor::ctor(unsafe)]
fn register_core_database_initializer() {
    snow_storage_core::bootstrap::register_database_initializer(
        snow_storage_services::ensure_database_file,
    );
    snow_storage::ports::register_conversation_worktree_resolver(resolve_worktree_binding);
    snow_tools::tool_search_port::register(
        crate::mcp::servers::tool_search::invalidate,
        crate::mcp::servers::tool_search::generation,
    );
}

/// 把 git 工作树校验注入领域层，避免 snow-storage 反向依赖 git 服务。
fn resolve_worktree_binding(
    database_path: &std::path::Path,
    conversation_id: &str,
) -> napi::Result<Option<snow_storage::ports::ConversationWorktreeBinding>> {
    Ok(
        snow_storage_services::services::git::get_conversation_worktree(
            database_path,
            conversation_id,
        )?
        .map(|info| snow_storage::ports::ConversationWorktreeBinding {
            directory_id: info.directory_id,
            worktree_path: info.worktree_path,
            is_valid: info.is_valid,
        }),
    )
}

/// 把会话准备注入 providers，避免 snow-providers 反向依赖具体工具与上层模块。
#[ctor::ctor(unsafe)]
fn register_provider_context_port() {
    snow_providers::context_port::register(
        prepare_conversation_context,
        resolve_request_tools_for_provider,
    );
}

fn prepare_conversation_context<'a>(
    request: snow_tools::conversation::ConversationContextRequest<'a>,
) -> snow_providers::context_port::PrepareFuture<'a> {
    Box::pin(conversation::context::prepare_context_request(request))
}

fn resolve_request_tools_for_provider<'a>(
    request: &'a responses::ResponsesApiRequest,
) -> snow_providers::context_port::ToolsFuture<'a> {
    Box::pin(conversation::sub_agent::resolve_request_tools_optional(request))
}

// 兼容外观：沿用搬迁前的 `crate::api::*` / `crate::mcp::*` / `crate::storage::*` 等路径。
pub(crate) mod api {
    pub use crate::{
        conversation, ephemeral, file_search_agent, prompt_context, prompt_optimization,
        repo_wiki, summary,
    };
    pub use snow_ai::{config, oauth};
    pub(crate) use snow_ai::usage;
    pub use snow_net::{http_client, retry, sse};
    pub use snow_providers::{anthropic, chat, common, gemini, interactions, responses};
    pub use snow_retrieval::{embedding, reranking};
    pub use snow_runtime::cancel;
    pub use snow_storage::failure;
    pub use snow_text::token_counter;
}

pub(crate) mod mcp {
    pub use snow_mcp::{builtin, privacy_mask, servers, service, tools};
}

pub(crate) mod storage {
    pub use snow_storage_core::models::*;
    pub use snow_storage_services::*;

    pub mod database {
        pub use snow_storage_core::database::*;
    }

    pub mod paths {
        pub use snow_support::app_paths::*;
    }

    pub mod services {
        pub use snow_storage::*;
        pub use snow_storage_services::services::*;
    }
}

pub(crate) mod prompt {
    pub use snow_prompt::*;
}

pub(crate) mod exports {
    pub mod terminal {
        pub use snow_process::terminal::*;
    }
}

pub(crate) mod utils {
    pub mod paths {
        pub use snow_support::paths::*;
    }
}
