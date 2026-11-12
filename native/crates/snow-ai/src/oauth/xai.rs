use std::time::Duration;

use napi::bindgen_prelude::*;
use serde_json::Value;

use super::provider::{decode_jwt_payload, now_epoch_secs, OAuthClaims, OAuthTokenSet};
use snow_net::http_client::{build_proxied_client_with_timeout, load_proxy_config_sync};

pub const CLIENT_ID: &str = "b1a00492-073a-47ea-816f-4c329264a828";
pub const DEFAULT_MODEL: &str = "grok-4.5";
pub const BACKEND_BASE_URL: &str = "https://api.x.ai/v1";
pub const BACKEND_BASE_URL_MARKER: &str = "api.x.ai";
pub const CALLBACK_PATH: &str = "/callback";
pub const CALLBACK_PORTS: &[u16] = &[56121];

const AUTHORIZE_URL: &str = "https://auth.x.ai/oauth2/authorize";
const TOKEN_URL: &str = "https://auth.x.ai/oauth2/token";
const OAUTH_SCOPE: &str = "openid profile email offline_access grok-cli:access api:access";
const HTTP_TIMEOUT_SECS: u64 = 30;
const MODELS_TIMEOUT_SECS: u64 = 15;

pub fn build_authorize_url(redirect_uri: &str, challenge: &str, state: &str) -> Result<String> {
    let mut url = reqwest::Url::parse(AUTHORIZE_URL)
        .map_err(|error| Error::from_reason(format!("Invalid authorize URL: {error}")))?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("client_id", CLIENT_ID);
        query.append_pair("response_type", "code");
        query.append_pair("redirect_uri", redirect_uri);
        query.append_pair("scope", OAUTH_SCOPE);
        query.append_pair("code_challenge", challenge);
        query.append_pair("code_challenge_method", "S256");
        query.append_pair("state", state);
    }
    Ok(url.to_string())
}

async fn request_tokens(params: &[(&str, &str)], action: &str) -> Result<OAuthTokenSet> {
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
) -> Result<OAuthTokenSet> {
    let params = [
        ("grant_type", "authorization_code"),
        ("client_id", CLIENT_ID),
        ("code", code),
        ("redirect_uri", redirect_uri),
        ("code_verifier", code_verifier),
    ];
    request_tokens(&params, "Token exchange").await
}

pub async fn refresh_tokens(refresh_token: &str) -> Result<OAuthTokenSet> {
    let params = [
        ("grant_type", "refresh_token"),
        ("client_id", CLIENT_ID),
        ("refresh_token", refresh_token),
    ];
    request_tokens(&params, "Token refresh").await
}

fn parse_token_response(body: &str) -> Result<OAuthTokenSet> {
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

    let id_token = parsed
        .get("id_token")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let claims = parse_claims(&id_token);
    let expires_in = parsed
        .get("expires_in")
        .and_then(Value::as_i64)
        .unwrap_or(3600);

    Ok(OAuthTokenSet {
        access_token,
        refresh_token: parsed
            .get("refresh_token")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string(),
        id_token,
        email: claims.email,
        plan_type: claims.plan_type,
        project_id: String::new(),
        expires_at: now_epoch_secs() + expires_in,
    })
}

pub fn parse_claims(id_token: &str) -> OAuthClaims {
    let Some(payload) = decode_jwt_payload(id_token) else {
        return OAuthClaims::default();
    };

    OAuthClaims {
        email: payload
            .get("email")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string(),
        account_id: payload
            .get("sub")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string(),
        plan_type: String::new(),
    }
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
        .get("data")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut models = Vec::new();
    for item in items {
        let id = item
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        if let Some(id) = id {
            if !models.contains(&id) {
                models.push(id);
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
