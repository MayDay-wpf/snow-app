//! 订阅档案的固定身份请求头由「自定义请求头方案」承载，而不是写死在请求代码里。
//!
//! 登录时按提供方约定的方案名（如 Claude）查找同名方案：已存在则逐个检查必需请求头，
//! 缺失的补齐、已有的（含用户改过的值与额外添加的请求头）保持不动；不存在则新建。
//! 随后把档案绑定到该方案，应用提供默认值，用户也可在设置中自行调整。

use std::collections::HashMap;
use std::path::Path;

use napi::bindgen_prelude::*;
use serde_json::{Map, Value};

use super::provider::{self, OAuthProfileMetadata, OAuthProviderId};
use snow_storage::api_configs as api_configs_service;
use snow_storage::custom_header_schemes as schemes_service;
use snow_storage_core::bootstrap::ensure_database_file;
use snow_storage_core::models::{ApiConfigRecord, CustomHeaderSchemeInput};
use snow_storage_core::system_settings;

const LEGACY_BINDING_SETTING_CODE: &str = "oauth_header_scheme_binding_migrated";
const LEGACY_BINDING_SETTING_NAME: &str = "OAuth header scheme binding migrated";

fn has_header<'a>(mut names: impl Iterator<Item = &'a String>, name: &str) -> bool {
    names.any(|existing| existing.trim().eq_ignore_ascii_case(name))
}

/// 确保提供方的请求头方案存在且包含全部必需请求头，返回方案 id。
///
/// 提供方没有固定身份请求头时返回 `None`，档案保持原有绑定。
pub fn ensure_provider_scheme(
    database_path: &Path,
    provider: OAuthProviderId,
) -> Result<Option<String>> {
    let Some(scheme_name) = provider.header_scheme_name() else {
        return Ok(None);
    };
    let required = provider
        .required_headers()
        .into_iter()
        .map(|(name, value)| (name.to_string(), value))
        .collect();
    ensure_named_scheme(database_path, scheme_name, required).map(Some)
}

/// 按方案名补建 / 补齐请求头方案（内置 provider 与插件共用），返回方案 id。
pub fn ensure_named_scheme(
    database_path: &Path,
    scheme_name: &str,
    required: Vec<(String, String)>,
) -> Result<String> {
    let schemes = schemes_service::list_custom_header_schemes(database_path)?;
    let existing = schemes
        .iter()
        .find(|scheme| scheme.name.trim().eq_ignore_ascii_case(scheme_name));

    let mut headers: Map<String, Value> = existing
        .and_then(|scheme| serde_json::from_str::<Value>(&scheme.headers_json).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    let mut changed = existing.is_none();
    for (name, value) in required {
        if !has_header(headers.keys(), &name) {
            headers.insert(name, Value::String(value));
            changed = true;
        }
    }

    let scheme_id = existing
        .map(|scheme| scheme.scheme_id.clone())
        .unwrap_or_else(|| schemes_service::next_scheme_id(&schemes));
    if changed {
        let item = CustomHeaderSchemeInput {
            scheme_id: scheme_id.clone(),
            name: existing
                .map(|scheme| scheme.name.clone())
                .unwrap_or_else(|| scheme_name.to_string()),
            headers_json: Value::Object(headers).to_string(),
            is_active: existing.map(|scheme| scheme.is_active).unwrap_or(false),
            sort_order: existing.map(|scheme| scheme.sort_order).unwrap_or_else(|| {
                schemes
                    .iter()
                    .map(|scheme| scheme.sort_order)
                    .max()
                    .unwrap_or(-1)
                    + 1
            }),
        };
        schemes_service::upsert_custom_header_scheme(database_path, &item)?;
    }
    Ok(scheme_id)
}

/// 旧版本的订阅档案未绑定请求头方案（身份请求头曾写死在请求代码中）。
///
/// 每个数据库只迁移一次：为仍是空绑定（跟随全局方案）的订阅档案补建方案并绑定；
/// 迁移完成后用户再把档案改回空绑定也不会被覆盖。
pub fn bind_legacy_profiles_once(database_path: &Path) -> Result<()> {
    if system_settings::get_system_setting_value(database_path, LEGACY_BINDING_SETTING_CODE)?
        .is_some()
    {
        return Ok(());
    }
    for config in api_configs_service::list_api_configs(database_path)? {
        if !config.custom_header_scheme_id.trim().is_empty() {
            continue;
        }
        let Some(metadata) = OAuthProfileMetadata::from_config_json(&config.config_json) else {
            continue;
        };
        let Some(scheme_id) = ensure_provider_scheme(database_path, metadata.provider)? else {
            continue;
        };
        let mut input = provider::input_from_record(&config);
        input.custom_header_scheme_id = scheme_id;
        api_configs_service::upsert_api_config(database_path, &input)?;
    }
    system_settings::set_system_setting(
        database_path,
        LEGACY_BINDING_SETTING_NAME,
        LEGACY_BINDING_SETTING_CODE,
        "1",
    )
}

/// 按名称（不区分大小写）补齐缺失的请求头，已存在的请求头保持不变。
pub fn fill_missing_headers(
    headers: &mut HashMap<String, String>,
    required: Vec<(&'static str, String)>,
) {
    for (name, value) in required {
        if !has_header(headers.keys(), name) {
            headers.insert(name.to_string(), value);
        }
    }
}

/// 解析订阅档案在非会话请求（如配额查询）中使用的请求头：
/// 档案绑定的请求头方案 + 账号级动态请求头。
pub async fn resolve_profile_headers(config: &ApiConfigRecord) -> Result<HashMap<String, String>> {
    let scheme_id = config.custom_header_scheme_id.clone();
    let mut headers = tokio::task::spawn_blocking(move || -> Result<HashMap<String, String>> {
        let database_path = ensure_database_file()?;
        let schemes = schemes_service::list_custom_header_schemes(&database_path)?;
        Ok(crate::config::get_api_config_custom_headers(
            &schemes, &scheme_id,
        ))
    })
    .await
    .map_err(|error| Error::from_reason(format!("Failed to load custom headers: {error}")))??;
    // 不属于任何会话：会话级占位符置空，避免把模板原样发给上游。
    snow_text::text::expand_custom_header_session_id(&mut headers, "");
    provider::apply_request_headers(config, &mut headers);
    Ok(headers)
}
