//! 插件钩子内的自定义请求头方案：创建 / 更新 / 删除，并可绑定到插件自己的档案。
//!
//! 写入的是 Snow App 实际发送的请求头（custom_header_schemes 表），
//! 与设置页「自定义请求头」同源；绑定仅限该插件登录生成的 OAuth 档案。

use std::path::Path;

use napi::bindgen_prelude::*;
use serde_json::{json, Map, Value};

use super::profile::PluginProfileMetadata;
use crate::oauth::provider::input_from_record;
use snow_storage::api_configs as api_configs_service;
use snow_storage::custom_header_schemes as schemes_service;
use snow_storage_core::bootstrap::ensure_database_file;
use snow_storage_core::models::{
    ApiConfigRecord, CustomHeaderSchemeInput, CustomHeaderSchemeRecord,
};

#[derive(Default)]
struct SchemePatch {
    scheme_id: String,
    name: String,
    /// 值 None 表示删除该请求头。
    headers: Vec<(String, Option<String>)>,
    is_active: Option<bool>,
    sort_order: Option<i32>,
    profile_name: String,
    provider_id: String,
}

fn read_text(object: &Map<String, Value>, key: &str) -> String {
    object
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn parse_patch(raw: &str) -> Result<SchemePatch> {
    let value: Value = serde_json::from_str(raw)
        .map_err(|error| Error::from_reason(format!("Invalid header scheme payload: {error}")))?;
    let object = value
        .as_object()
        .ok_or_else(|| Error::from_reason("Header scheme payload must be an object"))?;
    let mut patch = SchemePatch {
        scheme_id: read_text(object, "schemeId"),
        name: read_text(object, "name"),
        profile_name: read_text(object, "profileName"),
        provider_id: read_text(object, "providerId"),
        is_active: object.get("isActive").and_then(Value::as_bool),
        sort_order: object
            .get("sortOrder")
            .and_then(Value::as_i64)
            .map(|order| order as i32),
        headers: Vec::new(),
    };
    match object.get("headers") {
        None | Some(Value::Null) => {}
        Some(Value::Object(headers)) => {
            for (name, value) in headers {
                let name = name.trim();
                if name.is_empty() {
                    continue;
                }
                match value {
                    Value::Null => patch.headers.push((name.to_string(), None)),
                    Value::String(text) => {
                        patch.headers.push((name.to_string(), Some(text.clone())))
                    }
                    _ => {
                        return Err(Error::from_reason(
                            "Header scheme values must be strings or null",
                        ))
                    }
                }
            }
        }
        Some(_) => return Err(Error::from_reason("Header scheme headers must be an object")),
    }
    Ok(patch)
}

fn apply_patch(database_path: &Path, patch: &SchemePatch) -> Result<Value> {
    let schemes = schemes_service::list_custom_header_schemes(database_path)?;
    let existing: Option<&CustomHeaderSchemeRecord> = if patch.scheme_id.is_empty() {
        if patch.name.is_empty() {
            None
        } else {
            schemes
                .iter()
                .find(|scheme| scheme.name.trim().eq_ignore_ascii_case(&patch.name))
        }
    } else {
        Some(
            schemes
                .iter()
                .find(|scheme| scheme.scheme_id == patch.scheme_id)
                .ok_or_else(|| {
                    Error::from_reason(format!(
                        "Custom header scheme '{}' does not exist",
                        patch.scheme_id
                    ))
                })?,
        )
    };

    if existing.is_none() && patch.name.is_empty() {
        return Err(Error::from_reason(
            "Creating a header scheme requires a name",
        ));
    }
    let scheme_id = existing
        .map(|scheme| scheme.scheme_id.clone())
        .unwrap_or_else(|| schemes_service::next_scheme_id(&schemes));
    let name = if patch.name.is_empty() {
        existing
            .map(|scheme| scheme.name.clone())
            .unwrap_or_default()
    } else {
        patch.name.clone()
    };
    if schemes
        .iter()
        .any(|scheme| scheme.scheme_id != scheme_id && scheme.name.trim().eq_ignore_ascii_case(&name))
    {
        return Err(Error::from_reason(format!(
            "A header scheme named '{name}' already exists"
        )));
    }

    let mut headers: Map<String, Value> = existing
        .and_then(|scheme| serde_json::from_str::<Value>(&scheme.headers_json).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    for (header_name, value) in &patch.headers {
        let current = headers
            .keys()
            .find(|key| key.eq_ignore_ascii_case(header_name))
            .cloned();
        if let Some(key) = current {
            headers.remove(&key);
        }
        if let Some(value) = value {
            headers.insert(header_name.clone(), Value::String(value.clone()));
        }
    }

    let is_active = patch
        .is_active
        .unwrap_or_else(|| existing.map(|scheme| scheme.is_active).unwrap_or(false));
    let sort_order = match patch.sort_order {
        Some(order) => order,
        None => match existing {
            Some(scheme) => scheme.sort_order,
            None => {
                schemes
                    .iter()
                    .map(|scheme| scheme.sort_order)
                    .max()
                    .unwrap_or(-1)
                    + 1
            }
        },
    };

    schemes_service::upsert_custom_header_scheme(
        database_path,
        &CustomHeaderSchemeInput {
            scheme_id: scheme_id.clone(),
            name: name.clone(),
            headers_json: Value::Object(headers.clone()).to_string(),
            is_active,
            sort_order,
        },
    )?;

    let bound = if patch.profile_name.is_empty() {
        false
    } else {
        bind_profile(
            database_path,
            &patch.profile_name,
            &scheme_id,
            &patch.provider_id,
        )?;
        true
    };

    Ok(json!({
        "schemeId": scheme_id,
        "name": name,
        "headers": Value::Object(headers),
        "isActive": is_active,
        "profileName": patch.profile_name,
        "bound": bound,
    }))
}

fn find_plugin_profile(
    database_path: &Path,
    profile_name: &str,
    provider_id: &str,
) -> Result<ApiConfigRecord> {
    let config = api_configs_service::list_api_configs(database_path)?
        .into_iter()
        .find(|config| config.profile_name == profile_name)
        .ok_or_else(|| Error::from_reason(format!("API profile '{profile_name}' not found")))?;
    let metadata = PluginProfileMetadata::from_config_json(&config.config_json).ok_or_else(|| {
        Error::from_reason("Header schemes can only be bound to an OAuth plugin profile")
    })?;
    let provider_id = provider_id.trim();
    if !provider_id.is_empty() && !metadata.provider.eq_ignore_ascii_case(provider_id) {
        return Err(Error::from_reason(
            "Header schemes can only be bound to the plugin's own OAuth profile",
        ));
    }
    Ok(config)
}

fn bind_profile(
    database_path: &Path,
    profile_name: &str,
    scheme_id: &str,
    provider_id: &str,
) -> Result<()> {
    if !scheme_id.is_empty() {
        let schemes = schemes_service::list_custom_header_schemes(database_path)?;
        if !schemes.iter().any(|scheme| scheme.scheme_id == scheme_id) {
            return Err(Error::from_reason(format!(
                "Custom header scheme '{scheme_id}' does not exist"
            )));
        }
    }
    let config = find_plugin_profile(database_path, profile_name, provider_id)?;
    let mut input = input_from_record(&config);
    input.custom_header_scheme_id = scheme_id.to_string();
    api_configs_service::upsert_api_config(database_path, &input)
}

fn remove_scheme(database_path: &Path, scheme_id: &str) -> Result<bool> {
    let scheme_id = scheme_id.trim();
    if scheme_id.is_empty() {
        return Err(Error::from_reason("schemeId is required"));
    }
    let schemes = schemes_service::list_custom_header_schemes(database_path)?;
    if !schemes.iter().any(|scheme| scheme.scheme_id == scheme_id) {
        return Ok(false);
    }
    schemes_service::delete_custom_header_scheme(database_path, scheme_id)?;
    // 清空仍指向该方案的档案绑定，避免继承全局方案的请求头
    for config in api_configs_service::list_api_configs(database_path)? {
        if config.custom_header_scheme_id == scheme_id {
            let mut input = input_from_record(&config);
            input.custom_header_scheme_id = String::new();
            api_configs_service::upsert_api_config(database_path, &input)?;
        }
    }
    Ok(true)
}

async fn blocking<T, F>(label: &str, task: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T> + Send + 'static,
{
    tokio::task::spawn_blocking(task)
        .await
        .map_err(|error| Error::from_reason(format!("{label} failed: {error}")))?
}

pub async fn upsert(payload_json: String) -> Result<Value> {
    let patch = parse_patch(&payload_json)?;
    blocking("Header scheme upsert", move || {
        let database_path = ensure_database_file()?;
        apply_patch(&database_path, &patch)
    })
    .await
}

pub async fn bind(payload_json: String) -> Result<()> {
    let patch = parse_patch(&payload_json)?;
    if patch.profile_name.is_empty() {
        return Err(Error::from_reason(
            "Binding a header scheme requires a profileName",
        ));
    }
    blocking("Header scheme bind", move || {
        let database_path = ensure_database_file()?;
        bind_profile(
            &database_path,
            &patch.profile_name,
            &patch.scheme_id,
            &patch.provider_id,
        )
    })
    .await
}

pub async fn remove(scheme_id: String) -> Result<bool> {
    blocking("Header scheme delete", move || {
        let database_path = ensure_database_file()?;
        remove_scheme(&database_path, &scheme_id)
    })
    .await
}
