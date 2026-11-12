//! 订阅档案配额查询：按 provider 调用上游用量接口，归一化为分组进度。

use std::collections::HashMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use napi::bindgen_prelude::*;
use serde_json::Value;

use super::header_schemes::resolve_profile_headers;
use super::provider::{OAuthProfileMetadata, OAuthProviderId};
use snow_net::http_client::build_proxied_client_with_timeout;
use snow_storage_core::models::ApiConfigRecord;

pub mod antigravity;
pub mod claude;
pub mod codex;
pub mod xai;

const HTTP_TIMEOUT_SECS: u64 = 20;
const ERROR_BODY_CHARS: usize = 200;

#[derive(Clone)]
pub struct QuotaBucket {
    pub key: String,
    pub label: String,
    pub remaining_percent: Option<f64>,
    pub reset_at_ms: Option<f64>,
}

#[derive(Clone)]
pub struct QuotaGroup {
    pub id: String,
    pub label: String,
    pub buckets: Vec<QuotaBucket>,
}

pub struct QuotaSnapshot {
    pub provider: String,
    pub plan: Option<String>,
    pub groups: Vec<QuotaGroup>,
    pub fetched_at_ms: f64,
}

pub type QuotaParts = (Option<String>, Vec<QuotaGroup>);

pub async fn fetch_snapshot(config: &ApiConfigRecord) -> Result<QuotaSnapshot> {
    if let Some(snapshot) = super::plugin::fetch_quota(config).await? {
        return Ok(snapshot);
    }
    let metadata = OAuthProfileMetadata::from_config_json(&config.config_json)
        .ok_or_else(|| Error::from_reason("API profile is not an OAuth subscription login"))?;
    let token = config.api_key.trim();
    if token.is_empty() {
        return Err(Error::from_reason("OAuth access token is missing"));
    }

    let provider = metadata.provider;
    let (plan, groups) = match provider {
        OAuthProviderId::Codex | OAuthProviderId::ChatGpt => {
            let headers = resolve_profile_headers(config).await?;
            codex::fetch(token, &metadata, headers).await?
        }
        OAuthProviderId::Anthropic => {
            let headers = resolve_profile_headers(config).await?;
            claude::fetch(token, headers).await?
        }
        OAuthProviderId::Antigravity => antigravity::fetch(token).await?,
        OAuthProviderId::Xai => xai::fetch(token, &metadata.account_id).await?,
    };

    Ok(QuotaSnapshot {
        provider: provider.as_str().to_string(),
        plan,
        groups,
        fetched_at_ms: now_ms(),
    })
}

pub fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as f64)
        .unwrap_or(0.0)
}

pub async fn get_json(
    url: &str,
    token: &str,
    headers: &HashMap<String, String>,
) -> Result<Value> {
    let client = build_proxied_client_with_timeout(Duration::from_secs(HTTP_TIMEOUT_SECS)).await?;
    let mut request = client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"));
    for (name, value) in headers {
        request = request.header(name.as_str(), value.as_str());
    }

    let response = request
        .send()
        .await
        .map_err(|error| Error::from_reason(format!("Quota request failed: {error}")))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        let snippet: String = body.chars().take(ERROR_BODY_CHARS).collect();
        return Err(Error::from_reason(format!(
            "Quota request failed: {status} {snippet}"
        )));
    }

    serde_json::from_str(&body)
        .map_err(|error| Error::from_reason(format!("Invalid quota response: {error}")))
}

pub fn first_value<'a>(object: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter()
        .filter_map(|key| object.get(*key))
        .find(|value| !value.is_null())
}

pub fn json_f64(value: Option<&Value>) -> Option<f64> {
    let number = match value? {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.trim().parse::<f64>().ok(),
        _ => None,
    };
    number.filter(|value| value.is_finite())
}

pub fn json_text(value: Option<&Value>) -> Option<String> {
    value?
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

/// 绝对重置时间：数字小于 1e12 视为秒，否则视为毫秒；字符串按 RFC3339 解析。
pub fn parse_reset_ms(value: Option<&Value>) -> Option<f64> {
    let value = value?;
    if let Some(number) = json_f64(Some(value)) {
        if number <= 0.0 {
            return None;
        }
        return Some(if number < 1e12 { number * 1000.0 } else { number });
    }
    let text = value.as_str()?.trim();
    chrono::DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|time| time.timestamp_millis() as f64)
}

pub fn remaining_from_used(used_percent: f64) -> f64 {
    (100.0 - used_percent).clamp(0.0, 100.0)
}
