use napi::bindgen_prelude::*;

use super::ensure_database_file;
use super::services;

pub fn list_usage_records(
    conversation_id: String,
    directory_id: String,
    profile_name: String,
    limit: i32,
    offset: i32,
) -> Result<services::usage_records::UsageRecordPage> {
    let database_path = ensure_database_file()?;
    services::usage_records::list_usage_records(
        &database_path,
        &conversation_id,
        &directory_id,
        &profile_name,
        limit,
        offset,
    )
}

pub fn get_usage_summary(
    since: String,
    until: String,
    profile_name: String,
) -> Result<services::usage_records::UsageSummary> {
    let database_path = ensure_database_file()?;
    services::usage_records::get_usage_summary(&database_path, &since, &until, &profile_name)
}

pub fn get_usage_daily_breakdown(
    since: String,
    until: String,
    profile_name: String,
) -> Result<Vec<services::usage_records::DailyUsageBreakdown>> {
    let database_path = ensure_database_file()?;
    services::usage_records::get_usage_daily_breakdown(
        &database_path,
        &since,
        &until,
        &profile_name,
    )
}

pub fn get_usage_model_breakdown(
    since: String,
    until: String,
    profile_name: String,
) -> Result<Vec<services::usage_records::ModelUsageBreakdown>> {
    let database_path = ensure_database_file()?;
    services::usage_records::get_usage_model_breakdown(
        &database_path,
        &since,
        &until,
        &profile_name,
    )
}

pub fn list_usage_profile_names() -> Result<Vec<String>> {
    let database_path = ensure_database_file()?;
    services::usage_records::list_usage_profile_names(&database_path)
}

pub fn delete_usage_records(since: String, until: String) -> Result<u32> {
    let database_path = ensure_database_file()?;
    services::usage_records::delete_usage_records(&database_path, &since, &until)
}
