//! 用量记录与应用日志的 NAPI 转发。

use super::*;

// ===== Usage records NAPI 导出 =====

#[napi]
pub async fn list_usage_records(
    conversation_id: String,
    directory_id: String,
    profile_name: String,
    limit: i32,
    offset: i32,
) -> napi::Result<crate::storage::services::usage_records::UsageRecordPage> {
    tokio::task::spawn_blocking(move || {
        crate::storage::list_usage_records(conversation_id, directory_id, profile_name, limit, offset)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn get_usage_summary(
    since: String,
    until: String,
    profile_name: String,
) -> napi::Result<crate::storage::services::usage_records::UsageSummary> {
    tokio::task::spawn_blocking(move || {
        crate::storage::get_usage_summary(since, until, profile_name)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn get_usage_daily_breakdown(
    since: String,
    until: String,
    profile_name: String,
) -> napi::Result<Vec<crate::storage::services::usage_records::DailyUsageBreakdown>> {
    tokio::task::spawn_blocking(move || {
        crate::storage::get_usage_daily_breakdown(since, until, profile_name)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn get_usage_model_breakdown(
    since: String,
    until: String,
    profile_name: String,
) -> napi::Result<Vec<crate::storage::services::usage_records::ModelUsageBreakdown>> {
    tokio::task::spawn_blocking(move || {
        crate::storage::get_usage_model_breakdown(since, until, profile_name)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn list_usage_profile_names() -> napi::Result<Vec<String>> {
    tokio::task::spawn_blocking(crate::storage::list_usage_profile_names)
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn delete_usage_records(since: String, until: String) -> napi::Result<u32> {
    tokio::task::spawn_blocking(move || crate::storage::delete_usage_records(since, until))
        .await
        .map_err(map_spawn_error)?
}

// ===== App logs NAPI 导出 =====

#[napi]
pub async fn write_app_log(
    input: crate::storage::services::app_logs::AppLogInput,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::write_app_log(input))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn list_app_logs(
    level: String,
    module: String,
    since: String,
    until: String,
    limit: i32,
    offset: i32,
) -> napi::Result<crate::storage::services::app_logs::AppLogPage> {
    tokio::task::spawn_blocking(move || {
        crate::storage::list_app_logs(level, module, since, until, limit, offset)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn clear_app_logs() -> napi::Result<u32> {
    tokio::task::spawn_blocking(crate::storage::clear_app_logs)
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn export_app_logs(
    level: String,
    module: String,
    since: String,
    until: String,
    ids: Vec<String>,
    format: String,
    group_by_day: bool,
) -> napi::Result<Vec<crate::storage::services::app_logs::AppLogExportFile>> {
    tokio::task::spawn_blocking(move || {
        crate::storage::export_app_logs(level, module, since, until, ids, format, group_by_day)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn list_app_log_modules() -> napi::Result<Vec<String>> {
    tokio::task::spawn_blocking(crate::storage::list_app_log_modules)
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn get_app_logs_retention_days() -> napi::Result<i32> {
    tokio::task::spawn_blocking(crate::storage::get_app_logs_retention_days)
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn set_app_logs_retention_days(days: i32) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::set_app_logs_retention_days(days))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn prune_app_logs() -> napi::Result<u32> {
    tokio::task::spawn_blocking(crate::storage::prune_app_logs)
        .await
        .map_err(map_spawn_error)?
}
