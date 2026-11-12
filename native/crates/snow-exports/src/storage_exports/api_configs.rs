//! API 配置、系统提示词与自定义请求头方案的 NAPI 转发。

use super::*;

#[napi]
pub async fn list_api_configs() -> napi::Result<Vec<ApiConfigRecord>> {
    tokio::task::spawn_blocking(crate::storage::list_api_configs)
        .await
        .map_err(map_spawn_error)?
}

/// 重试错误分类的默认关键词（UI 预填用，单一来源在 api::retry）。
#[napi]
pub fn get_retry_defaults() -> napi::Result<String> {
    Ok(crate::api::retry::retry_defaults_json())
}

#[napi]
pub async fn upsert_api_config(config: ApiConfigInput) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::upsert_api_config(config))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn delete_api_config(profile_name: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::delete_api_config(profile_name))
        .await
        .map_err(map_spawn_error)?
}

/// 重排 API 档案（设置页表格 / 模型菜单渠道列表的拖拽与上移下移）：
/// 按给定档案名顺序重写 sort_order。
#[napi]
pub async fn reorder_api_configs(ordered_profile_names: Vec<String>) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::reorder_api_configs(ordered_profile_names))
        .await
        .map_err(map_spawn_error)?
}

/// 导出选中配置为迁移文档（含明文密钥），文件写入由主进程完成。
#[napi]
pub async fn export_api_configs(profile_names: Vec<String>) -> napi::Result<ApiConfigExportResult> {
    tokio::task::spawn_blocking(move || crate::storage::export_api_configs(profile_names))
        .await
        .map_err(map_spawn_error)?
}

/// 解析导入文件并返回预览信息（不写库）。
#[napi]
pub async fn inspect_api_config_import(
    payload_json: String,
) -> napi::Result<ApiConfigImportPreview> {
    tokio::task::spawn_blocking(move || crate::storage::inspect_api_config_import(payload_json))
        .await
        .map_err(map_spawn_error)?
}

/// 执行导入；conflict_strategy 为 "overwrite" 或 "duplicate"。
#[napi]
pub async fn import_api_configs(
    payload_json: String,
    conflict_strategy: String,
) -> napi::Result<ApiConfigImportOutcome> {
    tokio::task::spawn_blocking(move || {
        crate::storage::import_api_configs(payload_json, conflict_strategy)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn list_system_prompts() -> napi::Result<Vec<SystemPromptItemRecord>> {
    tokio::task::spawn_blocking(crate::storage::list_system_prompts)
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn upsert_system_prompt(item: SystemPromptItemInput) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::upsert_system_prompt(item))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn delete_system_prompt(prompt_id: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::delete_system_prompt(prompt_id))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn list_custom_header_schemes() -> napi::Result<Vec<CustomHeaderSchemeRecord>> {
    tokio::task::spawn_blocking(crate::storage::list_custom_header_schemes)
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn upsert_custom_header_scheme(item: CustomHeaderSchemeInput) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::upsert_custom_header_scheme(item))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn delete_custom_header_scheme(scheme_id: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::delete_custom_header_scheme(scheme_id))
        .await
        .map_err(map_spawn_error)?
}
