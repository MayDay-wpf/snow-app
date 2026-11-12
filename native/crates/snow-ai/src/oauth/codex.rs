use std::collections::HashMap;
use std::time::Duration;

use napi::bindgen_prelude::*;
use serde_json::Value;

use super::provider::{
    decode_jwt_payload, now_epoch_secs, OAuthClaims, OAuthProfileMetadata, OAuthTokenSet,
};
use snow_net::http_client::{build_proxied_client_with_timeout, load_proxy_config_sync};

pub const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
pub const DEFAULT_MODEL: &str = "gpt-5.2-codex";
pub const BACKEND_BASE_URL: &str = "https://chatgpt.com/backend-api/codex";
pub const BACKEND_BASE_URL_MARKER: &str = "chatgpt.com/backend-api/codex";
pub const CALLBACK_PATH: &str = "/auth/callback";
pub const CALLBACK_PORTS: &[u16] = &[1455, 1457];

const AUTHORIZE_URL: &str = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
const AUTHORIZE_SCOPE: &str = "openid email profile offline_access";
const REFRESH_SCOPE: &str = "openid profile email";
const ORIGINATOR: &str = "codex_cli_rs";
const CLIENT_VERSION: &str = "0.159.0";
const HTTP_TIMEOUT_SECS: u64 = 30;
const MODELS_TIMEOUT_SECS: u64 = 15;

pub fn user_agent() -> String {
    format!(
        "codex_cli_rs/{} ({}; {})",
        CLIENT_VERSION,
        std::env::consts::OS,
        std::env::consts::ARCH
    )
}

pub fn build_authorize_url(redirect_uri: &str, challenge: &str, state: &str) -> Result<String> {
    let mut url = reqwest::Url::parse(AUTHORIZE_URL)
        .map_err(|error| Error::from_reason(format!("Invalid authorize URL: {error}")))?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("client_id", CLIENT_ID);
        query.append_pair("response_type", "code");
        query.append_pair("redirect_uri", redirect_uri);
        query.append_pair("scope", AUTHORIZE_SCOPE);
        query.append_pair("state", state);
        query.append_pair("code_challenge", challenge);
        query.append_pair("code_challenge_method", "S256");
        query.append_pair("prompt", "login");
        query.append_pair("id_token_add_organizations", "true");
        query.append_pair("codex_cli_simplified_flow", "true");
        query.append_pair("originator", ORIGINATOR);
    }
    Ok(url.to_string())
}

fn parse_token_response(body: &str) -> Result<OAuthTokenSet> {
    let parsed: Value = serde_json::from_str(body)
        .map_err(|error| Error::from_reason(format!("Invalid token response: {error}")))?;

    let access_token = parsed
        .get("access_token")
        .and_then(Value::as_str)
        .unwrap_or_default()
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
    let expires_at = jwt_expiry(&access_token).unwrap_or_else(|| now_epoch_secs() + expires_in);

    Ok(OAuthTokenSet {
        access_token,
        refresh_token: parsed
            .get("refresh_token")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        id_token: parsed
            .get("id_token")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        email: String::new(),
        plan_type: String::new(),
        project_id: String::new(),
        expires_at,
    })
}

pub async fn exchange_code(
    code: &str,
    redirect_uri: &str,
    code_verifier: &str,
) -> Result<OAuthTokenSet> {
    let client = build_proxied_client_with_timeout(Duration::from_secs(HTTP_TIMEOUT_SECS)).await?;
    let params = [
        ("grant_type", "authorization_code"),
        ("client_id", CLIENT_ID),
        ("code", code),
        ("redirect_uri", redirect_uri),
        ("code_verifier", code_verifier),
    ];

    let response = client
        .post(TOKEN_URL)
        .header(reqwest::header::ACCEPT, "application/json")
        .form(&params)
        .send()
        .await
        .map_err(|error| Error::from_reason(format!("Token exchange request failed: {error}")))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(Error::from_reason(format!(
            "Token exchange failed: {status} {body}"
        )));
    }

    parse_token_response(&body)
}

pub async fn refresh_tokens(refresh_token: &str) -> Result<OAuthTokenSet> {
    let client = build_proxied_client_with_timeout(Duration::from_secs(HTTP_TIMEOUT_SECS)).await?;
    let params = [
        ("client_id", CLIENT_ID),
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("scope", REFRESH_SCOPE),
    ];

    let response = client
        .post(TOKEN_URL)
        .header(reqwest::header::ACCEPT, "application/json")
        .form(&params)
        .send()
        .await
        .map_err(|error| Error::from_reason(format!("Token refresh failed: {error}")))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(Error::from_reason(format!(
            "Token refresh failed: {status} {body}"
        )));
    }

    parse_token_response(&body)
}

fn models_url(base_url: &str) -> String {
    let normalized = base_url.trim().trim_end_matches('/');
    let base = if normalized.is_empty() {
        BACKEND_BASE_URL
    } else {
        normalized
    };
    format!("{base}/models?client_version={CLIENT_VERSION}")
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
        let id = item
            .get("id")
            .or_else(|| item.get("slug"))
            .or_else(|| item.get("model"))
            .or_else(|| item.get("name"))
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

pub async fn fetch_models(access_token: &str, account_id: &str) -> Result<Vec<String>> {
    let client = build_proxied_client_with_timeout(Duration::from_secs(HTTP_TIMEOUT_SECS)).await?;
    let mut request = client
        .get(models_url(BACKEND_BASE_URL))
        .header(reqwest::header::ACCEPT, "application/json")
        .header(
            reqwest::header::AUTHORIZATION,
            format!("Bearer {access_token}"),
        )
        .header("originator", ORIGINATOR)
        .header(reqwest::header::USER_AGENT, user_agent());
    let account_id = account_id.trim();
    if !account_id.is_empty() {
        request = request.header("chatgpt-account-id", account_id);
    }

    let response = request
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

pub fn fetch_models_blocking(
    base_url: &str,
    access_token: &str,
    account_id: &str,
) -> Result<Vec<String>> {
    let proxy_config = load_proxy_config_sync()?;
    let client = proxy_config
        .apply_blocking(
            reqwest::blocking::Client::builder()
                .user_agent(user_agent())
                .timeout(Duration::from_secs(MODELS_TIMEOUT_SECS)),
        )?
        .build()
        .map_err(|error| Error::from_reason(format!("Failed to create HTTP client: {error}")))?;

    let mut request = client
        .get(models_url(base_url))
        .header(reqwest::header::ACCEPT, "application/json")
        .header(
            reqwest::header::AUTHORIZATION,
            format!("Bearer {access_token}"),
        )
        .header("originator", ORIGINATOR)
        .header(reqwest::header::USER_AGENT, user_agent());
    let account_id = account_id.trim();
    if !account_id.is_empty() {
        request = request.header("chatgpt-account-id", account_id);
    }

    let response = request
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

fn jwt_expiry(jwt: &str) -> Option<i64> {
    decode_jwt_payload(jwt)?
        .get("exp")
        .and_then(Value::as_i64)
}

pub fn parse_claims(id_token: &str) -> OAuthClaims {
    let Some(payload) = decode_jwt_payload(id_token) else {
        return OAuthClaims::default();
    };

    let email = payload
        .get("email")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            payload
                .get("https://api.openai.com/profile")
                .and_then(|profile| profile.get("email"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_default();

    let auth = payload.get("https://api.openai.com/auth");
    let account_id = auth
        .and_then(|auth| auth.get("chatgpt_account_id"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let plan_type = auth
        .and_then(|auth| auth.get("chatgpt_plan_type"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    OAuthClaims {
        email,
        account_id,
        plan_type,
    }
}

/// Codex 后端要求的客户端身份头，作为默认值写入「Codex」自定义请求头方案。
pub fn required_headers() -> Vec<(&'static str, String)> {
    vec![
        ("originator", ORIGINATOR.to_string()),
        ("OpenAI-Beta", "responses=experimental".to_string()),
        ("User-Agent", user_agent()),
    ]
}

/// 账号级请求头随登录账号变化，不写入共享方案，按档案元数据在请求时注入。
pub fn apply_request_headers(
    metadata: &OAuthProfileMetadata,
    headers: &mut HashMap<String, String>,
) {
    if !metadata.account_id.trim().is_empty() {
        headers.insert(
            "chatgpt-account-id".to_string(),
            metadata.account_id.trim().to_string(),
        );
    }
}
