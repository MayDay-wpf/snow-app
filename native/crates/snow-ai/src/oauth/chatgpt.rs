use std::path::PathBuf;
use std::time::Duration;

use napi::bindgen_prelude::*;
use serde_json::{json, Value};

use super::provider::{decode_jwt_payload, now_epoch_secs, OAuthTokenSet};
use snow_net::http_client::{build_proxied_client_with_timeout, load_proxy_config_sync};

pub const CLIENT_ID: &str = "dynamic_agent_client";
pub const AGENT_NAME_HINT: &str = "Snow App";
pub const DEFAULT_MODEL: &str = "gpt-5.2";
pub const BACKEND_BASE_URL: &str = "https://api.openai.com/v1";
pub const CALLBACK_PATH: &str = "/auth/callback";
pub const CALLBACK_PORTS: &[u16] = &[1455, 1457];

const AUTHORIZE_URL: &str = "https://auth.openai.com/api/accounts/authorize";
const TOKEN_URL: &str = "https://auth.openai.com/api/accounts/oauth/token";
const AUTHORIZE_SCOPE: &str =
    "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const PLAN_SCOPE: &str = "chatgpt.tokens.use.direct";
const RESOURCE: &str = "https://api.openai.com/v1";
const HOST_ID_FILE_NAME: &str = "chatgpt-host.json";
const HTTP_TIMEOUT_SECS: u64 = 30;
const MODELS_TIMEOUT_SECS: u64 = 15;

pub fn build_authorize_url(
    redirect_uri: &str,
    challenge: &str,
    state: &str,
    nonce: &str,
    host_id: &str,
) -> Result<String> {
    let mut url = reqwest::Url::parse(AUTHORIZE_URL)
        .map_err(|error| Error::from_reason(format!("Invalid authorize URL: {error}")))?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("client_id", CLIENT_ID);
        query.append_pair("response_type", "code");
        query.append_pair("redirect_uri", redirect_uri);
        query.append_pair("scope", AUTHORIZE_SCOPE);
        query.append_pair("resource", RESOURCE);
        query.append_pair("state", state);
        query.append_pair("nonce", nonce);
        query.append_pair("code_challenge", challenge);
        query.append_pair("code_challenge_method", "S256");
        query.append_pair("agent_name_hint", AGENT_NAME_HINT);
        query.append_pair("ext_agent_host_id", host_id);
    }
    Ok(url.to_string())
}

pub async fn ensure_host_id() -> Result<String> {
    let path = host_id_path()?;
    if let Ok(existing) = tokio::fs::read_to_string(&path).await {
        if let Ok(parsed) = serde_json::from_str::<Value>(&existing) {
            if let Some(host_id) = parsed
                .get("ext_agent_host_id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                return Ok(host_id.to_string());
            }
        }
    }

    let host_id = format!("urn:uuid:{}", uuid::Uuid::new_v4());
    let payload = json!({ "ext_agent_host_id": host_id }).to_string();
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|error| {
            Error::from_reason(format!("Failed to create the host ID directory: {error}"))
        })?;
    }
    tokio::fs::write(&path, payload)
        .await
        .map_err(|error| Error::from_reason(format!("Failed to persist the host ID: {error}")))?;
    Ok(host_id)
}

fn host_id_path() -> Result<PathBuf> {
    Ok(snow_support::app_paths::app_storage_dir()?.join(HOST_ID_FILE_NAME))
}

pub fn verify_identity(id_token: &str, nonce: &str) -> Result<()> {
    let payload = decode_jwt_payload(id_token).ok_or_else(|| {
        Error::from_reason("ChatGPT identity could not be verified; please sign in again")
    })?;
    let returned_nonce = payload
        .get("nonce")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if returned_nonce != nonce {
        return Err(Error::from_reason(
            "ChatGPT identity could not be verified (nonce mismatch); please sign in again",
        ));
    }
    Ok(())
}

struct TokenResponse {
    tokens: OAuthTokenSet,
    scopes: Vec<String>,
}

async fn request_tokens(params: &[(&str, &str)], action: &str) -> Result<TokenResponse> {
    let client = build_proxied_client_with_timeout(Duration::from_secs(HTTP_TIMEOUT_SECS)).await?;
    let response = client
        .post(TOKEN_URL)
        .header(reqwest::header::ACCEPT, "application/json")
        .form(params)
        .send()
        .await
        .map_err(|error| Error::from_reason(format!("{action} request failed: {error}")))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(Error::from_reason(format!("{action} failed: {status} {body}")));
    }

    parse_token_response(&body)
}

pub async fn exchange_code(
    code: &str,
    redirect_uri: &str,
    code_verifier: &str,
    issued_client_id: &str,
) -> Result<OAuthTokenSet> {
    let issued_client_id = issued_client_id.trim();
    if issued_client_id.is_empty() || issued_client_id == CLIENT_ID {
        return Err(Error::from_reason(
            "ChatGPT app registration did not complete; please restart the sign-in",
        ));
    }

    let params = [
        ("grant_type", "authorization_code"),
        ("client_id", issued_client_id),
        ("code", code),
        ("redirect_uri", redirect_uri),
        ("code_verifier", code_verifier),
        ("resource", RESOURCE),
    ];
    let response = request_tokens(&params, "Token exchange")
        .await
        .map_err(|error| {
            if error.reason.contains("invalid_grant") {
                Error::from_reason(format!(
                    "{}. Retry the sign-in; if it keeps failing, the account may not be eligible for ChatGPT plan usage (Plus or Pro plan required)",
                    error.reason
                ))
            } else {
                error
            }
        })?;
    if !response.scopes.iter().any(|scope| scope == PLAN_SCOPE) {
        return Err(Error::from_reason(
            "ChatGPT plan usage was not authorized. Sign in again and allow plan usage; if the option is unavailable, the account may not be eligible (Plus or Pro plan required)",
        ));
    }
    Ok(response.tokens)
}

pub async fn refresh_tokens(refresh_token: &str, client_id: &str) -> Result<OAuthTokenSet> {
    let client_id = client_id.trim();
    if client_id.is_empty() {
        return Err(Error::from_reason(
            "ChatGPT client registration is missing; please sign in again",
        ));
    }

    let params = [
        ("grant_type", "refresh_token"),
        ("client_id", client_id),
        ("refresh_token", refresh_token),
        ("resource", RESOURCE),
    ];
    request_tokens(&params, "Token refresh")
        .await
        .map(|response| response.tokens)
}

fn parse_token_response(body: &str) -> Result<TokenResponse> {
    let parsed: Value = serde_json::from_str(body)
        .map_err(|error| Error::from_reason(format!("Invalid token response: {error}")))?;

    let access_token = parsed
        .get("access_token")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if access_token.is_empty() {
        return Err(Error::from_reason(
            "Token response did not include an access token",
        ));
    }

    let expires_in = parsed
        .get("expires_in")
        .and_then(Value::as_i64)
        .unwrap_or(3600);
    let scopes = parsed
        .get("scope")
        .and_then(Value::as_str)
        .map(|raw| {
            raw.split_whitespace()
                .map(str::to_string)
                .collect::<Vec<String>>()
        })
        .unwrap_or_default();

    Ok(TokenResponse {
        tokens: OAuthTokenSet {
            access_token,
            refresh_token: parsed
                .get("refresh_token")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string(),
            id_token: parsed
                .get("id_token")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string(),
            email: String::new(),
            plan_type: String::new(),
            project_id: String::new(),
            expires_at: now_epoch_secs() + expires_in,
        },
        scopes,
    })
}

fn models_url(base_url: &str) -> String {
    let normalized = base_url.trim().trim_end_matches('/');
    let base = if normalized.is_empty() {
        BACKEND_BASE_URL
    } else {
        normalized
    };
    format!("{base}/models")
}

fn parse_models_payload(body: &str) -> Result<Vec<String>> {
    let parsed: Value = serde_json::from_str(body)
        .map_err(|error| Error::from_reason(format!("Invalid model list: {error}")))?;
    let items = parsed
        .get("models")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut models = Vec::new();
    for item in items {
        if item.get("visibility").and_then(Value::as_str) != Some("list") {
            continue;
        }
        let slug = item
            .get("slug")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        if let Some(slug) = slug {
            if !models.contains(&slug) {
                models.push(slug);
            }
        }
    }
    Ok(models)
}

pub async fn fetch_models(access_token: &str) -> Result<Vec<String>> {
    let client = build_proxied_client_with_timeout(Duration::from_secs(HTTP_TIMEOUT_SECS)).await?;
    let response = client
        .get(models_url(BACKEND_BASE_URL))
        .header(reqwest::header::ACCEPT, "application/json")
        .header(
            reqwest::header::AUTHORIZATION,
            format!("Bearer {access_token}"),
        )
        .send()
        .await
        .map_err(|error| Error::from_reason(format!("Model list request failed: {error}")))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(Error::from_reason(format!(
            "Model list request failed: {status} {body}"
        )));
    }

    parse_models_payload(&body)
}

pub fn fetch_models_blocking(base_url: &str, access_token: &str) -> Result<Vec<String>> {
    let proxy_config = load_proxy_config_sync()?;
    let client = proxy_config
        .apply_blocking(
            reqwest::blocking::Client::builder()
                .timeout(Duration::from_secs(MODELS_TIMEOUT_SECS)),
        )?
        .build()
        .map_err(|error| Error::from_reason(format!("Failed to create HTTP client: {error}")))?;

    let response = client
        .get(models_url(base_url))
        .header(reqwest::header::ACCEPT, "application/json")
        .header(
            reqwest::header::AUTHORIZATION,
            format!("Bearer {access_token}"),
        )
        .send()
        .map_err(|error| Error::from_reason(format!("Model list request failed: {error}")))?;

    let status = response.status();
    let body = response.text().unwrap_or_default();
    if !status.is_success() {
        return Err(Error::from_reason(format!(
            "Model list request failed: {status} {body}"
        )));
    }

    parse_models_payload(&body)
}
