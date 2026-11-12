//! 模型提供方协议实现（Anthropic / Gemini / OpenAI Chat / Responses / Interactions）。

/// 辅助请求诊断输出：ephemeral 期间静默。
macro_rules! diagnostic {
    ($($args:tt)*) => {
        if !snow_runtime::ephemeral::is_active() {
            std::eprintln!($($args)*);
        }
    };
}
pub(crate) use diagnostic;

pub mod anthropic;
pub mod chat;
pub mod common;
pub mod context_port;
pub mod gemini;
pub mod interactions;
pub mod responses;
pub mod tail_guard;
pub mod vision;

/// 过渡兼容外观：providers 内部沿用 `crate::api::*` / `crate::storage::*` 路径。
pub(crate) mod api {
    pub(crate) use crate::{common, gemini, responses, vision};
    pub(crate) use snow_ai::config;
    pub(crate) use snow_ai::oauth;
    pub(crate) use snow_net::{http_client, request_proxy, retry, sse};
    pub(crate) use snow_storage::failure;
    pub(crate) use snow_text::token_counter;
    pub(crate) use snow_tools::plugin_tool_guard;

    pub(crate) mod conversation {
        pub(crate) use snow_storage::image_optimize;
        pub(crate) use snow_storage::media as images;
        pub(crate) use snow_storage::media::ChatImage;
        pub(crate) use snow_storage::tags::{parse_chat_message_content, ParsedChatMessageContent};
        pub(crate) use snow_storage::tool_messages;
        pub(crate) use snow_tools::conversation::ConversationContextRequest;

        pub(crate) mod context {
            pub(crate) use snow_storage::configured_prompts::resolve_configured_system_prompts;
        }
    }
}

pub(crate) mod storage {
    pub(crate) use snow_storage_core::models::ApiConfigRecord;

    pub(crate) mod services {
        pub(crate) use snow_storage::chat_conversations;
        pub(crate) use snow_storage_core::app_logs;
    }
}

pub(crate) mod mcp {
    pub(crate) mod tools {
        pub(crate) use snow_tools::serialize::*;
    }
}
