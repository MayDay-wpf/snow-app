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
    let server_id = item.server_id.trim().to_string();
    let result = services::mcp_server_configs::upsert_mcp_server_config(&database_path, &item);
    if result.is_ok() && !server_id.is_empty() {
        // 只失效被改动的那台服务器：保存一台配置不应把其他服务器的
        // 工具缓存一起清掉（那会迫使下一次列表刷新重连所有服务器）。
        crate::mcp::external::invalidate_server_discovery_cache(&server_id);
    }
    result
}

pub fn delete_mcp_server_config(server_id: String) -> Result<()> {
    let database_path = ensure_database_file()?;
    let result = services::mcp_server_configs::delete_mcp_server_config(&database_path, &server_id);
    if result.is_ok() {
        crate::mcp::external::invalidate_server_discovery_cache(&server_id);
    }
    result
}

/// 存量 LSP 配置「启用但未安装」的校正延迟到首次 LSP 探测（设置页）执行一次，
/// 应用启动不探测（builtin:lsp 默认关闭，探测会真实启动子进程拖慢启动）。
pub fn reconcile_lsp_server_install_state_once() {
    static RECONCILE_INIT: std::sync::Once = std::sync::Once::new();
    RECONCILE_INIT.call_once(|| {
        let Ok(storage_info) = initialize_app_storage() else {
            return;
        };
        let database_path = PathBuf::from(storage_info.database_path);
        if let Err(error) = services::lsp_server_configs::reconcile_enabled_by_probe(&database_path)
        {
            eprintln!("Failed to reconcile LSP server install state: {error}");
        }
    });
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
    let server_id = item.server_id.trim().to_string();
    let result = services::project_mcp_server_configs::upsert_project_mcp_server_config(
        &database_path,
        &project_id,
        &item,
    );
    if result.is_ok() && !server_id.is_empty() {
        // 同全局路径：只失效被改动的那台服务器（新建的项目服务器由存储层
        // 生成 id，尚无缓存条目）。
        crate::mcp::external::invalidate_server_discovery_cache(&server_id);
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
        crate::mcp::external::invalidate_server_discovery_cache(&server_id);
    }
    result
}
