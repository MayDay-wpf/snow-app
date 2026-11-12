use crate::api::oauth::provider::keep_saved_oauth_secrets;
use napi::bindgen_prelude::*;

use super::ensure_database_file;
use super::models::*;
use super::services;
use super::services::api_config_transfer::{
    ApiConfigExportResult, ApiConfigImportOutcome, ApiConfigImportPreview,
};

pub fn list_api_configs() -> Result<Vec<ApiConfigRecord>> {
    let database_path = ensure_database_file()?;
    services::api_configs::list_api_configs(&database_path)
}

pub fn upsert_api_config(mut config: ApiConfigInput) -> Result<()> {
    let database_path = ensure_database_file()?;
    // 改名时库内记录的键是旧档案名
    let saved_name = config
        .previous_profile_name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or(config.profile_name.as_str())
        .to_string();
    if let Some(saved) = services::api_configs::list_api_configs(&database_path)?
        .into_iter()
        .find(|record| record.profile_name == saved_name)
    {
        keep_saved_oauth_secrets(&mut config, &saved);
    }
    services::api_configs::upsert_api_config(&database_path, &config)
}

pub fn delete_api_config(profile_name: String) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::api_configs::delete_api_config(&database_path, &profile_name)
}

pub fn reorder_api_configs(ordered_profile_names: Vec<String>) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::api_configs::reorder_api_configs(&database_path, &ordered_profile_names)
}

pub fn export_api_configs(profile_names: Vec<String>) -> Result<ApiConfigExportResult> {
    let database_path = ensure_database_file()?;
    services::api_config_transfer::export_api_configs(&database_path, &profile_names)
}

pub fn inspect_api_config_import(payload_json: String) -> Result<ApiConfigImportPreview> {
    services::api_config_transfer::inspect_api_config_import(&payload_json)
}

pub fn import_api_configs(
    payload_json: String,
    conflict_strategy: String,
) -> Result<ApiConfigImportOutcome> {
    let database_path = ensure_database_file()?;
    services::api_config_transfer::import_api_configs(
        &database_path,
        &payload_json,
        &conflict_strategy,
    )
}

pub fn list_system_prompts() -> Result<Vec<SystemPromptItemRecord>> {
    let database_path = ensure_database_file()?;
    services::system_prompts::list_system_prompts(&database_path)
}

pub fn upsert_system_prompt(item: SystemPromptItemInput) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::system_prompts::upsert_system_prompt(&database_path, &item)
}

pub fn delete_system_prompt(prompt_id: String) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::system_prompts::delete_system_prompt(&database_path, &prompt_id)
}

pub fn list_custom_header_schemes() -> Result<Vec<CustomHeaderSchemeRecord>> {
    let database_path = ensure_database_file()?;
    services::custom_header_schemes::list_custom_header_schemes(&database_path)
}

pub fn upsert_custom_header_scheme(item: CustomHeaderSchemeInput) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::custom_header_schemes::upsert_custom_header_scheme(&database_path, &item)
}

pub fn delete_custom_header_scheme(scheme_id: String) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::custom_header_schemes::delete_custom_header_scheme(&database_path, &scheme_id)
}
