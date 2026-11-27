use std::time::Duration;

use napi::bindgen_prelude::*;
use serde::Deserialize;
use serde_json::{json, Value};

use snow_net::http_client::build_proxied_client_with_timeout;
use snow_storage_core::models::ApiConfigInput;

pub const DEFAULT_SERVER_URL: &str = "https://kfccrazythursday.com";
pub const CLIENT_ID: &str = "snow-app";
pub const CALLBACK_PATH: &str = "/oauth/callback";
pub const CALLBACK_PORTS: &[u16] = &[42820, 42821, 42822, 42823];
pub const PROFILE_SOURCE: &str = "snow-router";

const HTTP_TIMEOUT_SECS: u64 = 30;
const DEFAULT_MAX_CONTEXT_TOKENS: i32 = 200_000;

#[derive(Clone)]
pub struct RouterChannel {
    pub id: String,
    pub name: String,
    pub description: String,
    pub ratio: String,
    pub models: Vec<String>,
    pub has_key: bool,
}

#[derive(Clone)]
pub struct RouterSession {
    pub access_token: String,
    pub account_id: String,
    pub username: String,
    pub display_name: String,
    pub email: String,
}

#[derive(Deserialize)]
struct ApiEnvelope<T> {
    #[serde(default)]
    success: bool,
    #[serde(default)]
    message: Option<String>,
    data: Option<T>,
}

#[derive(Deserialize)]
struct TokenData {
    access_token: String,
    user: Option<TokenUser>,
}

#[derive(Deserialize)]
struct TokenUser {
    #[serde(default)]
    id: i64,
    #[serde(default)]
    username: String,
    #[serde(default)]
    display_name: String,
    #[serde(default)]
    email: String,
}

#[derive(Deserialize)]
struct ChannelsData {
    #[serde(default)]
    channels: Vec<ChannelPayload>,
}

#[derive(Deserialize)]
struct ChannelPayload {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    ratio: Value,
    #[serde(default)]
    models: Vec<String>,
    #[serde(default)]
    has_key: bool,
}

#[derive(Deserialize)]
struct KeyData {
    #[serde(default)]
    key: String,
    #[serde(default)]
    created: bool,
}

/// 站点根地址：去掉尾部斜杠与常见的 `/v1` 后缀，只接受 http(s)。
pub fn normalize_server_url(raw: &str) -> Result<String> {
    let trimmed = raw.trim();
    let with_scheme = if trimmed.is_empty() {
        DEFAULT_SERVER_URL.to_string()
    } else if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    };
    let value = with_scheme.trim_end_matches('/');
    let mut parsed = reqwest::Url::parse(value)
        .map_err(|error| Error::from_reason(format!("Invalid Snow AI Router URL: {error}")))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(Error::from_reason(
            "Snow AI Router URL must use http or https",
        ));
    }
    if parsed.host_str().unwrap_or_default().is_empty() {
        return Err(Error::from_reason("Snow AI Router URL is missing a host"));
    }
    parsed.set_query(None);
    parsed.set_fragment(None);
    let path = parsed.path().trim_end_matches('/').to_string();
    let path = path.strip_suffix("/v1").unwrap_or(&path).to_string();
    parsed.set_path(if path.is_empty() { "/" } else { &path });
    Ok(parsed
        .to_string()
        .trim_end_matches('/')
        .to_string())
}

pub fn build_authorize_url(
    server_url: &str,
    redirect_uri: &str,
    challenge: &str,
    state: &str,
) -> Result<String> {
    let mut url = reqwest::Url::parse(&format!("{server_url}/snow/authorize"))
        .map_err(|error| Error::from_reason(format!("Invalid authorize URL: {error}")))?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("client_id", CLIENT_ID);
        query.append_pair("response_type", "code");
        query.append_pair("redirect_uri", redirect_uri);
        query.append_pair("code_challenge", challenge);
        query.append_pair("code_challenge_method", "S256");
        if !state.is_empty() {
            query.append_pair("state", state);
        }
    }
    Ok(url.to_string())
}

fn parse_envelope<T: for<'de> Deserialize<'de>>(
    body: &str,
    action: &str,
) -> Result<ApiEnvelope<T>> {
    serde_json::from_str::<ApiEnvelope<T>>(body).map_err(|_| {
        let snippet: String = body.chars().take(240).collect();
        Error::from_reason(format!("{action} returned an unexpected response: {snippet}"))
    })
}

fn envelope_error<T>(envelope: &ApiEnvelope<T>, action: &str) -> Error {
    let message = envelope
        .message
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("unknown error");
    Error::from_reason(format!("{action} failed: {message}"))
}

pub async fn exchange_code(
    server_url: &str,
    code: &str,
    redirect_uri: &str,
    code_verifier: &str,
) -> Result<RouterSession> {
    let client = build_proxied_client_with_timeout(Duration::from_secs(HTTP_TIMEOUT_SECS)).await?;
    let response = client
        .post(format!("{server_url}/api/snow-app/token"))
        .json(&json!({
            "client_id": CLIENT_ID,
            "code": code,
            "redirect_uri": redirect_uri,
            "code_verifier": code_verifier,
        }))
        .send()
        .await
        .map_err(|error| Error::from_reason(format!("Token exchange request failed: {error}")))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        let envelope = parse_envelope::<TokenData>(&body, "Token exchange").ok();
        if let Some(envelope) = envelope {
            return Err(envelope_error(&envelope, "Token exchange"));
        }
        return Err(Error::from_reason(format!(
            "Token exchange failed: {status}"
        )));
    }
    let envelope = parse_envelope::<TokenData>(&body, "Token exchange")?;
    if !envelope.success {
        return Err(envelope_error(&envelope, "Token exchange"));
    }
    let data = envelope
        .data
        .ok_or_else(|| Error::from_reason("Token exchange returned no data"))?;
    if data.access_token.trim().is_empty() {
        return Err(Error::from_reason(
            "Token exchange returned an empty access token",
        ));
    }
    let user = data.user.unwrap_or(TokenUser {
        id: 0,
        username: String::new(),
        display_name: String::new(),
        email: String::new(),
    });
    let display_name = if user.display_name.trim().is_empty() {
        user.username.clone()
    } else {
        user.display_name.clone()
    };
    Ok(RouterSession {
        access_token: data.access_token,
        account_id: if user.id > 0 {
            user.id.to_string()
        } else {
            user.username.clone()
        },
        username: user.username,
        display_name,
        email: user.email,
    })
}

fn ratio_label(value: &Value) -> String {
    match value {
        Value::String(text) => text.trim().to_string(),
        Value::Number(number) => number.to_string(),
        _ => String::new(),
    }
}

pub async fn fetch_channels(server_url: &str, access_token: &str) -> Result<Vec<RouterChannel>> {
    let client = build_proxied_client_with_timeout(Duration::from_secs(HTTP_TIMEOUT_SECS)).await?;
    let response = client
        .get(format!("{server_url}/api/snow-app/channels"))
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|error| Error::from_reason(format!("Channel request failed: {error}")))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(Error::from_reason(format!(
            "Channel request failed: {status}"
        )));
    }
    let envelope = parse_envelope::<ChannelsData>(&body, "Channel request")?;
    if !envelope.success {
        return Err(envelope_error(&envelope, "Channel request"));
    }
    let channels = envelope
        .data
        .map(|data| data.channels)
        .unwrap_or_default()
        .into_iter()
        .filter(|channel| !channel.id.trim().is_empty())
        .map(|channel| {
            let name = if channel.name.trim().is_empty() {
                channel.id.clone()
            } else {
                channel.name
            };
            RouterChannel {
                id: channel.id,
                name,
                description: channel.description,
                ratio: ratio_label(&channel.ratio),
                models: channel.models,
                has_key: channel.has_key,
            }
        })
        .collect();
    Ok(channels)
}

pub async fn ensure_key(
    server_url: &str,
    access_token: &str,
    group: &str,
) -> Result<(String, bool)> {
    let client = build_proxied_client_with_timeout(Duration::from_secs(HTTP_TIMEOUT_SECS)).await?;
    let response = client
        .post(format!("{server_url}/api/snow-app/key"))
        .bearer_auth(access_token)
        .json(&json!({ "group": group }))
        .send()
        .await
        .map_err(|error| Error::from_reason(format!("API key request failed: {error}")))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        let envelope = parse_envelope::<KeyData>(&body, "API key request").ok();
        if let Some(envelope) = envelope {
            return Err(envelope_error(&envelope, "API key request"));
        }
        return Err(Error::from_reason(format!(
            "API key request failed: {status}"
        )));
    }
    let envelope = parse_envelope::<KeyData>(&body, "API key request")?;
    if !envelope.success {
        return Err(envelope_error(&envelope, "API key request"));
    }
    let data = envelope
        .data
        .ok_or_else(|| Error::from_reason("API key request returned no data"))?;
    if data.key.trim().is_empty() {
        return Err(Error::from_reason(
            "API key request returned an empty key",
        ));
    }
    Ok((data.key, data.created))
}

fn short_hash(value: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    value.hash(&mut hasher);
    format!("{:08x}", hasher.finish() as u32)
}

/// 档案名：保留可读的 ASCII 分组名；非 ASCII 时附加短哈希避免撞名。
pub fn profile_name_for(group: &str) -> String {
    let sanitized: String = group
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                ch.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = sanitized.trim_matches('-').to_string();
    if trimmed.is_empty() {
        return format!("snowrouter-{}", short_hash(group));
    }
    if trimmed != group.to_ascii_lowercase() {
        return format!("snowrouter-{trimmed}-{}", short_hash(group));
    }
    format!("snowrouter-{trimmed}")
}

pub fn build_profile_input(
    server_url: &str,
    channel: &RouterChannel,
    api_key: String,
    advanced_model: String,
    basic_model: String,
    max_context_tokens: i32,
    max_tokens: Option<i32>,
    is_active: bool,
) -> ApiConfigInput {
    let base_url = format!("{server_url}/v1");
    let config_json = json!({
        "snowcfg": {
            "baseUrl": base_url,
            "baseUrlMode": "custom",
            "requestMethod": "chat",
            "advancedModel": advanced_model,
            "basicModel": basic_model,
            "supportsVision": true,
            "visionBaseUrl": "",
            "visionBaseUrlMode": "auto",
            "visionRequestMethod": "chat",
            "visionModel": "",
            "enableAutoCompress": true,
            "maxContextTokens": max_context_tokens,
            "source": PROFILE_SOURCE,
        },
        "snowRouter": {
            "serverUrl": server_url,
            "group": channel.id,
            "channelName": channel.name,
        },
    })
    .to_string();

    ApiConfigInput {
        profile_name: profile_name_for(&channel.id),
        previous_profile_name: None,
        display_name: format!("Snow AI Router · {}", channel.name),
        is_active,
        base_url,
        base_url_mode: "custom".to_string(),
        api_key,
        request_method: "chat".to_string(),
        advanced_model,
        basic_model,
        supports_vision: true,
        vision_base_url: String::new(),
        vision_base_url_mode: "auto".to_string(),
        vision_api_key: String::new(),
        vision_request_method: "chat".to_string(),
        vision_model: String::new(),
        max_context_tokens: Some(max_context_tokens.max(1)),
        max_tokens,
        stream_idle_timeout_sec: None,
        enable_auto_compress: true,
        auto_compress_threshold: None,
        max_retries: None,
        retry_base_delay_ms: None,
        partial_retry_max_chars: None,
        system_prompt_ids_json: String::new(),
        custom_header_scheme_id: String::new(),
        config_json,
        source: PROFILE_SOURCE.to_string(),
    }
}

pub fn default_max_context_tokens() -> i32 {
    DEFAULT_MAX_CONTEXT_TOKENS
}
