//! OAuth 登录插件：provider 由插件（plugin.json 的 oauth.entry）在主进程注册。
//!
//! Rust 负责会话、回调监听、落库与刷新调度；平台特有逻辑（授权地址、换 token、刷新、
//! 模型、配额、请求改写）通过 `host` 异步交给插件钩子。

pub mod host;
pub mod login;
pub mod profile;
pub mod registry;
pub mod response;
pub mod schemes;
pub mod stream;

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use napi::bindgen_prelude::*;
use serde_json::{json, Value};

pub use profile::{is_plugin_profile, PluginProfileMetadata, PluginTokens, METADATA_KEY};

use super::provider::{input_from_record, now_epoch_secs, TOKEN_REFRESH_LEEWAY_SECS};
use super::quota::{now_ms, QuotaBucket, QuotaGroup, QuotaSnapshot};
use crate::storage::services::api_configs as api_configs_service;
use crate::storage::services::app_logs::log_api_warning;
use crate::storage::{ensure_database_file, ApiConfigRecord};

const HOOK_TIMEOUT: Duration = Duration::from_secs(30);

type RefreshLocks = Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>;

static REFRESH_LOCKS: LazyLock<RefreshLocks> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// 同一档案的刷新串行化，避免一次性 refresh token 被并发请求重复使用。
fn refresh_lock(profile_name: &str) -> Arc<tokio::sync::Mutex<()>> {
    let mut locks = REFRESH_LOCKS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    Arc::clone(
        locks
            .entry(profile_name.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))),
    )
}

async fn load_profile(profile_name: String) -> Result<Option<ApiConfigRecord>> {
    tokio::task::spawn_blocking(move || -> Result<Option<ApiConfigRecord>> {
        let database_path = ensure_database_file()?;
        Ok(api_configs_service::list_api_configs(&database_path)?
            .into_iter()
            .find(|config| config.profile_name == profile_name))
    })
    .await
    .map_err(|error| Error::from_reason(format!("Failed to load API profile: {error}")))?
}

fn needs_refresh(metadata: &PluginProfileMetadata, lead_secs: i64) -> bool {
    !metadata.refresh_token.trim().is_empty()
        && metadata.expires_at > 0
        && metadata.expires_at <= now_epoch_secs() + lead_secs
}

async fn log_warning(func: &str, message: &str, detail: String) {
    if let Ok(database_path) = ensure_database_file() {
        log_api_warning(&database_path, func, message, &detail).await;
    }
}

pub async fn refresh_if_needed(api_config: ApiConfigRecord) -> Result<ApiConfigRecord> {
    let Some(metadata) = PluginProfileMetadata::from_config_json(&api_config.config_json) else {
        return Ok(api_config);
    };
    let Ok(spec) = registry::ensure(&metadata.provider).await else {
        return Ok(api_config);
    };
    let lead_secs = if spec.refresh_lead_secs > 0 {
        spec.refresh_lead_secs
    } else {
        TOKEN_REFRESH_LEEWAY_SECS
    };
    if !spec.hooks.refresh || !needs_refresh(&metadata, lead_secs) {
        return Ok(api_config);
    }

    let lock = refresh_lock(&api_config.profile_name);
    let _guard = lock.lock().await;
    // 等锁期间可能已被其他请求刷新，以库内记录为准
    let current = load_profile(api_config.profile_name.clone())
        .await
        .ok()
        .flatten()
        .unwrap_or(api_config);
    let Some(metadata) = PluginProfileMetadata::from_config_json(&current.config_json) else {
        return Ok(current);
    };
    if !needs_refresh(&metadata, lead_secs) {
        return Ok(current);
    }

    let ctx = json!({
        "account": metadata.account_context(&current.api_key, &current.profile_name, &current.base_url),
    });
    let tokens = match host::call("refresh", &metadata.provider, ctx, HOOK_TIMEOUT)
        .await
        .and_then(|value| PluginTokens::from_value(&value))
    {
        Ok(tokens) => tokens,
        Err(error) => {
            log_warning(
                "plugin_refresh_if_needed",
                "OAuth plugin token refresh failed; keeping the stored token",
                format!("provider={} error={}", metadata.provider, error.reason),
            )
            .await;
            return Ok(current);
        }
    };

    let updated = metadata.merged(&tokens);
    let config_json = profile::merge_into_config(&current.config_json, &updated);
    let mut input = input_from_record(&current);
    input.api_key = tokens.access_token.clone();
    input.config_json = config_json.clone();
    let profile_name = current.profile_name.clone();
    let persisted = tokio::task::spawn_blocking(move || -> Result<Option<ApiConfigRecord>> {
        let database_path = ensure_database_file()?;
        api_configs_service::upsert_api_config(&database_path, &input)?;
        Ok(api_configs_service::list_api_configs(&database_path)?
            .into_iter()
            .find(|config| config.profile_name == profile_name))
    })
    .await;

    match persisted {
        Ok(Ok(Some(record))) => Ok(record),
        _ => {
            let mut fallback = current;
            fallback.api_key = tokens.access_token;
            fallback.config_json = config_json;
            Ok(fallback)
        }
    }
}

fn data_text(data: &Value, key: &str) -> Option<String> {
    match data.get(key)? {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        _ => None,
    }
}

fn resolve_placeholder(key: &str, metadata: &PluginProfileMetadata, access_token: &str) -> Option<String> {
    match key {
        "accessToken" => Some(access_token.to_string()),
        "accountId" => Some(metadata.account_id.clone()),
        "email" => Some(metadata.email.clone()),
        "planType" => Some(metadata.plan_type.clone()),
        _ => key
            .strip_prefix("data.")
            .map(|path| data_text(&metadata.data, path).unwrap_or_default()),
    }
}

/// 渲染请求头模板；未知占位符（如 {{session_id}}）原样保留。
fn render_template(template: &str, metadata: &PluginProfileMetadata, access_token: &str) -> String {
    let mut output = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        output.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else {
            output.push_str(&rest[start..]);
            return output;
        };
        match resolve_placeholder(after[..end].trim(), metadata, access_token) {
            Some(value) => output.push_str(&value),
            None => output.push_str(&rest[start..start + 2 + end + 2]),
        }
        rest = &after[end + 2..];
    }
    output.push_str(rest);
    output
}

/// 账号级动态请求头（同步）：按插件声明的模板渲染。
pub fn apply_request_headers(config: &ApiConfigRecord, headers: &mut HashMap<String, String>) {
    let Some(metadata) = PluginProfileMetadata::from_config_json(&config.config_json) else {
        return;
    };
    let Some(spec) = registry::get(&metadata.provider) else {
        return;
    };
    for (name, template) in &spec.request_headers {
        let value = render_template(template, &metadata, &config.api_key);
        if !value.trim().is_empty() {
            headers.insert(name.clone(), value);
        }
    }
}

/// 发送前的请求改写钩子：可替换 URL、请求体与请求头（null 删除）。
/// 同时记录响应侧钩子所需的请求上下文（响应改写与传输层接管共用）。
pub async fn transform_request(
    config: &ApiConfigRecord,
    protocol: &'static str,
    model: &str,
    endpoint: String,
    payload: Value,
    headers: &mut HashMap<String, String>,
) -> Result<(String, Value)> {
    let Some(metadata) = PluginProfileMetadata::from_config_json(&config.config_json) else {
        return Ok((endpoint, payload));
    };
    let spec = registry::ensure(&metadata.provider).await?;
    let account = metadata.account_context(&config.api_key, &config.profile_name, &config.base_url);
    response::record(
        &metadata.provider,
        &spec.hooks,
        protocol,
        model,
        &endpoint,
        &*headers,
        &payload,
        account.clone(),
    );
    if !spec.hooks.transform_request {
        return Ok((endpoint, payload));
    }
    let ctx = json!({
        "protocol": protocol,
        "model": model,
        "url": endpoint,
        "body": &payload,
        "headers": &*headers,
        "account": account.clone(),
    });
    let result = host::call("transformRequest", &metadata.provider, ctx, HOOK_TIMEOUT).await?;
    let Some(object) = result.as_object() else {
        return Ok((endpoint, payload));
    };
    if let Some(Value::Object(changes)) = object.get("headers") {
        for (name, value) in changes {
            match value {
                Value::Null => {
                    headers.retain(|existing, _| !existing.eq_ignore_ascii_case(name));
                }
                Value::String(text) => {
                    headers.retain(|existing, _| !existing.eq_ignore_ascii_case(name));
                    headers.insert(name.clone(), text.clone());
                }
                _ => {}
            }
        }
    }
    let endpoint = object
        .get("url")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .map(str::to_string)
        .unwrap_or(endpoint);
    let payload = match object.get("body") {
        Some(body) if body.is_object() => body.clone(),
        _ => payload,
    };
    // transformRequest 可能改写了 URL / 请求体 / 请求头，响应侧钩子以最终值为准。
    response::record(
        &metadata.provider,
        &spec.hooks,
        protocol,
        model,
        &endpoint,
        &*headers,
        &payload,
        account,
    );
    Ok((endpoint, payload))
}

pub fn parse_model_ids(value: &Value) -> Vec<String> {
    let mut models = Vec::<String>::new();
    for item in value.as_array().into_iter().flatten() {
        let id = match item {
            Value::String(text) => text.trim().to_string(),
            Value::Object(object) => object
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string(),
            _ => String::new(),
        };
        if !id.is_empty() && !models.contains(&id) {
            models.push(id);
        }
    }
    models
}

/// 插件档案的模型列表；非插件档案或插件未提供 models 钩子时返回 None（走通用拉取）。
pub async fn fetch_models(
    config_json: &str,
    access_token: &str,
    profile_name: &str,
    base_url: &str,
) -> Result<Option<(String, Vec<String>)>> {
    let Some(metadata) = PluginProfileMetadata::from_config_json(config_json) else {
        return Ok(None);
    };
    let spec = registry::ensure(&metadata.provider).await?;
    if !spec.hooks.models {
        return Ok(None);
    }
    let ctx = json!({ "account": metadata.account_context(access_token, profile_name, base_url) });
    let value = host::call("models", &metadata.provider, ctx, HOOK_TIMEOUT).await?;
    Ok(Some((metadata.provider, parse_model_ids(&value))))
}

fn quota_text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn parse_quota_groups(value: Option<&Value>) -> Vec<QuotaGroup> {
    let mut groups = Vec::new();
    for (group_index, group) in value.and_then(Value::as_array).into_iter().flatten().enumerate() {
        let buckets = group
            .get("buckets")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .enumerate()
            .map(|(index, bucket)| QuotaBucket {
                key: quota_text(bucket.get("key")).unwrap_or_else(|| format!("bucket-{index}")),
                label: quota_text(bucket.get("label")).unwrap_or_default(),
                remaining_percent: bucket
                    .get("remainingPercent")
                    .and_then(Value::as_f64)
                    .filter(|value| value.is_finite())
                    .map(|value| value.clamp(0.0, 100.0)),
                reset_at_ms: bucket
                    .get("resetAtMs")
                    .and_then(Value::as_f64)
                    .filter(|value| value.is_finite() && *value > 0.0),
            })
            .collect::<Vec<_>>();
        if buckets.is_empty() {
            continue;
        }
        groups.push(QuotaGroup {
            id: quota_text(group.get("id")).unwrap_or_else(|| format!("group-{group_index}")),
            label: quota_text(group.get("label")).unwrap_or_default(),
            buckets,
        });
    }
    groups
}

/// 插件档案的配额；非插件档案返回 None，插件未提供 quota 钩子时返回空快照。
pub async fn fetch_quota(config: &ApiConfigRecord) -> Result<Option<QuotaSnapshot>> {
    let Some(metadata) = PluginProfileMetadata::from_config_json(&config.config_json) else {
        return Ok(None);
    };
    let spec = registry::ensure(&metadata.provider).await?;
    if !spec.hooks.quota {
        return Ok(Some(QuotaSnapshot {
            provider: metadata.provider,
            plan: None,
            groups: Vec::new(),
            fetched_at_ms: now_ms(),
        }));
    }
    let ctx = json!({
        "account": metadata.account_context(&config.api_key, &config.profile_name, &config.base_url),
    });
    let value = host::call("quota", &metadata.provider, ctx, HOOK_TIMEOUT).await?;
    let plan = quota_text(value.get("plan")).or_else(|| {
        Some(metadata.plan_type.clone()).filter(|plan| !plan.trim().is_empty())
    });
    Ok(Some(QuotaSnapshot {
        provider: metadata.provider,
        plan,
        groups: parse_quota_groups(value.get("groups")),
        fetched_at_ms: now_ms(),
    }))
}
