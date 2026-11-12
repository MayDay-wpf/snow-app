//! MCP 工具契约与轻量工具能力。

pub mod contract;
pub mod conversation;
pub mod external;
pub mod file_tracking;
pub mod plugin_tool_guard;
pub mod protocol;
pub mod remote_path;
pub mod result_limit;
pub mod serialize;
pub mod servers;
pub mod skills_remote;
pub mod sub_agents;
pub mod tool_search_port;

/// 工具层沿用的存储类型别名。
pub(crate) mod storage {
    pub use snow_storage_core::models::{MemoryRecord, MemoryStats};
}
