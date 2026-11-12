pub mod api_exports;
pub mod checkpoint;
pub mod codebase;
pub mod detached_tasks;
pub mod engine;
pub mod explorer_menu;
pub mod formatting;
pub mod git;
pub mod html_preview;
pub mod ide;
pub mod image_generation;
pub mod images;
pub mod market;
pub mod model_health;
pub mod model_registry;
pub mod oauth;
pub mod pets;
pub mod plugin_ws_exports;
pub mod prompt_optimization;
pub mod pre_script;
pub mod remote_control_exports;
pub mod reply_prediction;
pub mod repo_wiki;
pub mod sample;
pub mod scheduled_wake;
pub mod sphere_layout;
pub mod storage_exports;
pub mod table;
pub mod terminal;
pub mod team_exports;
pub mod team_service;
pub mod updater;
pub mod window_frame;

// 兼容外观：沿用搬迁前的 `crate::api::*` / `crate::mcp::*` / `crate::storage::*` 等路径。
pub(crate) mod core_compat {
    pub use snow_api::{
        commit_message, conversation, ephemeral, file_search_agent, prompt_context,
        prompt_optimization, reply_prediction, repo_wiki, summary, theme_palette, tool_correction,
    };
    pub use snow_ai::{config, models, oauth};
    pub use snow_net::{request_proxy, retry};
    pub use snow_providers::responses;
    pub use snow_retrieval::{decision_model, embedding, model_health, reranking};
    pub use snow_runtime::cancel;
}

pub(crate) mod api {
    pub use crate::core_compat::*;
}

pub(crate) mod mcp {
    pub use snow_mcp::{builtin, privacy_mask, servers, tools};
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

    pub mod services {
        pub use snow_storage::*;
        pub use snow_storage_services::services::*;
    }
}

pub(crate) mod utils {
    pub mod panic_guard {
        pub use snow_support::panic_guard::*;
    }
    pub mod process {
        pub use snow_process::process::*;
    }
}

pub use snow_api::codebase_state_port;
pub use snow_hooks as hooks;
pub use snow_plugin::{community as plugin_community, market as plugin_market, ws as plugin_ws};
pub use snow_remote as remote_control;
pub use snow_team as team;
