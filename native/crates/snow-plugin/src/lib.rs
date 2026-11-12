//! 插件体系：安装/卸载、市场、社区、用户脚本与 WebSocket 长连接。

pub mod community;
pub mod market;
pub mod store;
pub mod userscripts;
pub mod ws;

pub use store::*;
pub use userscripts::*;

pub(crate) mod database {
    pub use snow_storage_core::database::*;
}

pub(crate) mod models {
    pub use snow_storage_core::models::*;
}

pub(crate) mod i18n {
    pub use snow_storage::i18n::*;
}

pub(crate) mod paths {
    pub use snow_support::app_paths::*;
}

pub(crate) mod storage {
    pub use crate::store::*;
    pub use crate::userscripts::*;
    pub use snow_storage_core::bootstrap::ensure_database_file;
    pub use snow_storage_core::models::*;
    pub use snow_support::app_paths as paths;
}

pub(crate) mod api {
    pub use snow_net::http_client;
}

pub(crate) mod mcp {
    pub mod external {
        pub use snow_tools::external::invalidate_plugin_discovery_cache;
    }
}
