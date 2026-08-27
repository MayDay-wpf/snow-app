use std::path::PathBuf;

use napi::bindgen_prelude::*;

use super::ensure_database_file;
use super::initialize_app_storage;
use super::models::*;
use super::services;

pub fn list_mcp_server_configs() -> Result<Vec<McpServerConfigRecord>> {
    let database_path = ensure_database_file()?;
    services::mcp_server_configs::list_mcp_server_configs(&database_path)
}

pub fn upsert_mcp_server_config(item: McpServerConfigInput) -> Result<()> {
    let database_path = ensure_database_file()?;
    let result =
        services::mcp_server_configs::upsert_mcp_server_config(&database_path, &item);
    if result.is_ok() {
        crate::mcp::external::invalidate_discovery_cache();
    }
    result
}

pub fn delete_mcp_server_config(server_id: String) -> Result<()> {
    let database_path = ensure_database_file()?;
    let result =
        services::mcp_server_configs::delete_mcp_server_config(&database_path, &server_id);
    if result.is_ok() {
        crate::mcp::external::invalidate_discovery_cache();
    }
    result
}

pub fn list_lsp_server_configs() -> Result<Vec<LspServerConfigRecord>> {
    // 必须走 initialize_app_storage：触发 LSP_CONFIG_SEED_INIT（迁移 + 种子 Once）。
    let storage_info = initialize_app_storage()?;
    let database_path = PathBuf::from(storage_info.database_path);
    services::lsp_server_configs::list_lsp_server_configs(&database_path)
}

pub fn upsert_lsp_server_config(item: LspServerConfigInput) -> Result<()> {
    let storage_info = initialize_app_storage()?;
    let database_path = PathBuf::from(storage_info.database_path);
    services::lsp_server_configs::upsert_lsp_server_config(&database_path, &item)
}

pub fn delete_lsp_server_config(lang: String) -> Result<()> {
    let storage_info = initialize_app_storage()?;
    let database_path = PathBuf::from(storage_info.database_path);
    services::lsp_server_configs::delete_lsp_server_config(&database_path, &lang)
}

pub fn clear_lsp_server_configs() -> Result<()> {
    let storage_info = initialize_app_storage()?;
    let database_path = PathBuf::from(storage_info.database_path);
    services::lsp_server_configs::clear_lsp_server_configs(&database_path)
}

pub fn list_project_lsp_server_configs(
    project_id: String,
) -> Result<Vec<LspServerConfigRecord>> {
    let storage_info = initialize_app_storage()?;
    let database_path = PathBuf::from(storage_info.database_path);
    services::project_lsp_server_configs::list_project_lsp_server_configs(
        &database_path,
        &project_id,
    )
}

pub fn list_effective_lsp_server_configs(
    project_id: Option<String>,
) -> Result<Vec<LspServerConfigRecord>> {
    let storage_info = initialize_app_storage()?;
    let database_path = PathBuf::from(storage_info.database_path);
    services::project_lsp_server_configs::list_effective_lsp_server_configs(
        &database_path,
        project_id.as_deref(),
    )
}

pub fn upsert_project_lsp_server_config(
    project_id: String,
    item: LspServerConfigInput,
) -> Result<()> {
    let storage_info = initialize_app_storage()?;
    let database_path = PathBuf::from(storage_info.database_path);
    services::project_lsp_server_configs::upsert_project_lsp_server_config(
        &database_path,
        &project_id,
        &item,
    )
}

pub fn delete_project_lsp_server_config(project_id: String, lang: String) -> Result<()> {
    let storage_info = initialize_app_storage()?;
    let database_path = PathBuf::from(storage_info.database_path);
    services::project_lsp_server_configs::delete_project_lsp_server_config(
        &database_path,
        &project_id,
        &lang,
    )
}

pub fn clear_project_lsp_server_configs(project_id: String) -> Result<()> {
    let storage_info = initialize_app_storage()?;
    let database_path = PathBuf::from(storage_info.database_path);
    services::project_lsp_server_configs::clear_project_lsp_server_configs(
        &database_path,
        &project_id,
    )
}

pub fn list_project_mcp_server_configs(
    project_id: String,
) -> Result<Vec<ProjectMcpServerConfigRecord>> {
    let database_path = ensure_database_file()?;
    services::project_mcp_server_configs::list_project_mcp_server_configs(
        &database_path,
        &project_id,
    )
}

pub fn upsert_project_mcp_server_config(
    project_id: String,
    item: McpServerConfigInput,
) -> Result<()> {
    let database_path = ensure_database_file()?;
    let result = services::project_mcp_server_configs::upsert_project_mcp_server_config(
        &database_path,
        &project_id,
        &item,
    );
    if result.is_ok() {
        crate::mcp::external::invalidate_discovery_cache();
    }
    result
}

pub fn delete_project_mcp_server_config(project_id: String, server_id: String) -> Result<()> {
    let database_path = ensure_database_file()?;
    let result = services::project_mcp_server_configs::delete_project_mcp_server_config(
        &database_path,
        &project_id,
        &server_id,
    );
    if result.is_ok() {
        crate::mcp::external::invalidate_discovery_cache();
    }
    result
}
