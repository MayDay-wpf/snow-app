//! MCP 服务器配置（全局与项目级）的 NAPI 转发。

use super::*;

#[napi]
pub async fn list_mcp_server_configs() -> napi::Result<Vec<McpServerConfigRecord>> {
    tokio::task::spawn_blocking(crate::storage::list_mcp_server_configs)
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn upsert_mcp_server_config(item: McpServerConfigInput) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::upsert_mcp_server_config(item))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn delete_mcp_server_config(server_id: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::delete_mcp_server_config(server_id))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn list_project_mcp_server_configs(
    project_id: String,
) -> napi::Result<Vec<ProjectMcpServerConfigRecord>> {
    tokio::task::spawn_blocking(move || crate::storage::list_project_mcp_server_configs(project_id))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn upsert_project_mcp_server_config(
    project_id: String,
    item: McpServerConfigInput,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::upsert_project_mcp_server_config(project_id, item)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn delete_project_mcp_server_config(
    project_id: String,
    server_id: String,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::delete_project_mcp_server_config(project_id, server_id)
    })
    .await
    .map_err(map_spawn_error)?
}
