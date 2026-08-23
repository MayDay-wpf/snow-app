//! 应用存储初始化与系统级设置（yolo / 请求日志）。

use super::*;

#[napi]
pub async fn initialize_app_storage() -> napi::Result<AppStorageInfo> {
    tokio::task::spawn_blocking(crate::storage::initialize_app_storage)
        .await
        .map_err(map_spawn_error)?
}

/// 修复数据库（"runtime" = 运行库 | "archive" = 归档库）：
/// 完整性检查 + 损坏恢复 + VACUUM 压缩。全程在 spawn_blocking 中执行，
/// 不阻塞 Node.js 主线程。
#[napi]
pub async fn repair_database(kind: String) -> napi::Result<DatabaseRepairResult> {
    tokio::task::spawn_blocking(move || crate::storage::repair_database(kind))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn get_system_setting_value(setting_code: String) -> napi::Result<Option<String>> {
    tokio::task::spawn_blocking(move || crate::storage::get_system_setting_value(setting_code))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn set_system_setting(
    setting_name: String,
    setting_code: String,
    setting_value: String,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::set_system_setting(setting_name, setting_code, setting_value)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn delete_system_setting(setting_code: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::delete_system_setting(setting_code))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn get_yolo_mode() -> napi::Result<bool> {
    tokio::task::spawn_blocking(crate::storage::get_yolo_mode)
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn set_yolo_mode(enabled: bool) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::set_yolo_mode(enabled))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn get_lite_mode() -> napi::Result<bool> {
    tokio::task::spawn_blocking(crate::storage::get_lite_mode)
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn set_lite_mode(enabled: bool) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::set_lite_mode(enabled))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn get_always_approved_tools() -> napi::Result<Vec<String>> {
    tokio::task::spawn_blocking(crate::storage::get_always_approved_tools)
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn set_always_approved_tools(tools: Vec<String>) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::set_always_approved_tools(tools))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn set_tool_approval_project_tools_approved(
    project_id: String,
    tool_names: Vec<String>,
    approved: bool,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::set_tool_approval_project_tools_approved(
            project_id,
            tool_names,
            approved,
        )
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn get_auto_format() -> napi::Result<bool> {
    tokio::task::spawn_blocking(crate::storage::get_auto_format)
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn set_auto_format(enabled: bool) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::set_auto_format(enabled))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn get_request_logging() -> napi::Result<bool> {
    tokio::task::spawn_blocking(crate::storage::get_request_logging)
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn set_request_logging(enabled: bool) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::set_request_logging(enabled))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn get_request_logging_expiry() -> napi::Result<i64> {
    tokio::task::spawn_blocking(crate::storage::get_request_logging_expiry)
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn set_request_logging_expiry(expires_at_ms: i64) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::set_request_logging_expiry(expires_at_ms))
        .await
        .map_err(map_spawn_error)?
}
