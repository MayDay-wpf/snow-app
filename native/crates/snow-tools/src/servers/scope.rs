//! MCP 工具级 scope 辅助。

use napi::bindgen_prelude::*;
use snow_storage_core::system_settings::{McpGlobalScopeSettings, McpProjectScopeSettings};

pub fn builtin_scope_server_id(server_id: &str) -> String {
    format!("builtin:{server_id}")
}

pub async fn load_project_scope(
    project_id: Option<&str>,
) -> Result<Option<McpProjectScopeSettings>> {
    let Some(project_id) = project_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let project_id = project_id.to_string();
    crate::servers::with_database_path(move |database_path| {
        snow_storage_core::system_settings::get_mcp_project_scope_settings(
            &database_path,
            &project_id,
        )
        .map(Some)
    })
    .await
}

pub async fn load_global_scope() -> Result<Option<McpGlobalScopeSettings>> {
    crate::servers::with_database_path(move |database_path| {
        snow_storage_core::system_settings::get_mcp_global_scope_settings(&database_path).map(Some)
    })
    .await
}
