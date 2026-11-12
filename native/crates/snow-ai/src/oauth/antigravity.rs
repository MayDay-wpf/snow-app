use std::collections::HashMap;
use std::time::Duration;

use napi::bindgen_prelude::*;
use serde_json::{json, Value};

use super::provider::{now_epoch_secs, OAuthClaims, OAuthTokenSet};
use snow_net::http_client::{build_proxied_client_with_timeout, load_proxy_config_sync};

pub const CLIENT_ID: &str = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
pub const DEFAULT_MODEL: &str = "gemini-3-pro-high";
pub const BACKEND_BASE_URL: &str = "https://cloudcode-pa.googleapis.com";
pub const BACKEND_BASE_URL_MARKER: &str = "cloudcode-pa.googleapis.com";
pub const CALLBACK_PATH: &str = "/oauth-callback";
pub const CALLBACK_PORTS: &[u16] = &[51121];

const CLIENT_SECRET: &str = "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";
const AUTHORIZE_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const USERINFO_URL: &str = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";
const OAUTH_SCOPE: &str = "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/cclog https://www.googleapis.com/auth/experimentsandconfigs";
const CLI_VERSION: &str = "1.0.13";
const CLI_CLIENT_NAME: &str = "aidev_client";
const API_CLIENT: &str = "google-cloud-sdk vscode_cloudshelleditor/0.1";
const HTTP_TIMEOUT_SECS: u64 = 30;
const MODELS_TIMEOUT_SECS: u64 = 15;

const CODE_ASSIST_HOSTS: &[&str] = &[
    "https://cloudcode-pa.googleapis.com",
    "https://daily-cloudcode-pa.googleapis.com",
    "https://daily-cloudcode-pa.sandbox.googleapis.com",
];

const PREFERRED_MODELS: &[&str] = &[
    "gemini-3.1-pro-high",
    "gemini-3-pro-high",
    "gemini-3-pro-low",
    "gemini-3.1-pro-low",
    "gemini-3-flash",
    "gemini-2.5-flash",
    "gemini-2.5-flash-thinking",
    "claude-sonnet-4-6",
    "claude-opus-4-6-thinking",
];

pub fn user_agent() -> String {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "amd64",
        other => other,
    };
    format!("antigravity/cli/{CLI_VERSION} ({CLI_CLIENT_NAME}; os_type={os}; arch={arch})")
}

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
        query.append_pair("access_type", "offline");
        query.append_pair("prompt", "consent");
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
        expires_at: now_epoch_secs() + expires_in,
    })
}

async fn fetch_user_email(client: &reqwest::Client, access_token: &str) -> String {
    let response = client
        .get(USERINFO_URL)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(
            reqwest::header::AUTHORIZATION,
            format!("Bearer {access_token}"),
        )
        .send()
        .await;
    let Ok(response) = response else {
        return String::new();
    };
    if !response.status().is_success() {
        return String::new();
    }
    let body = response.text().await.unwrap_or_default();
    serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|parsed| {
            parsed
                .get("email")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|email| !email.is_empty())
                .map(str::to_string)
        })
        .unwrap_or_default()
}

fn tier_label(value: Option<&Value>) -> String {
    let Some(tier) = value.and_then(Value::as_object) else {
        return String::new();
    };
    let id = tier
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    let name = tier
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    match id {
        "free-tier" => "Free".to_string(),
        "g1-pro-tier" => "Pro".to_string(),
        "g1-ultra-tier" => "Ultra".to_string(),
        "g1-ultra-lite-tier" => "Ultra Lite".to_string(),
        _ if !name.is_empty() => name.to_string(),
        _ => id.to_string(),
    }
}

fn parse_code_assist_status(payload: &Value) -> (String, String) {
    let project = payload
        .get("cloudaicompanionProject")
        .map(|value| match value {
            Value::String(text) => text.trim().to_string(),
            other => other
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string(),
        })
        .unwrap_or_default();

    let paid = tier_label(payload.get("paidTier"));
    let plan = if paid.is_empty() {
        tier_label(payload.get("currentTier"))
    } else {
        paid
    };

    (project, plan)
}

pub async fn post_code_assist(
    client: &reqwest::Client,
    method: &str,
    access_token: &str,
    body: &Value,
) -> Result<Value> {
    let mut last_error = String::new();
    for host in CODE_ASSIST_HOSTS {
        let url = format!("{host}/v1internal:{method}");
        let response = client
            .post(&url)
            .header(reqwest::header::ACCEPT, "application/json")
            .header(
                reqwest::header::AUTHORIZATION,
                format!("Bearer {access_token}"),
            )
            .header(reqwest::header::USER_AGENT, user_agent())
            .header("x-goog-api-client", API_CLIENT)
            .json(body)
            .send()
            .await;

        match response {
            Ok(response) => {
                let status = response.status();
                let body = response.text().await.unwrap_or_default();
                if status.is_success() {
                    return serde_json::from_str::<Value>(&body).map_err(|error| {
                        Error::from_reason(format!("Invalid Code Assist response: {error}"))
                    });
                }
                last_error = format!("{status} {body}");
            }
            Err(error) => last_error = error.to_string(),
        }
    }

    Err(Error::from_reason(format!(
        "Code Assist request failed: {last_error}"
    )))
}

async fn fetch_code_assist_status(client: &reqwest::Client, access_token: &str) -> (String, String) {
    let body = json!({ "metadata": { "ideType": "ANTIGRAVITY" } });
    match post_code_assist(client, "loadCodeAssist", access_token, &body).await {
        Ok(payload) => parse_code_assist_status(&payload),
        Err(_) => (String::new(), String::new()),
    }
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
        ("client_secret", CLIENT_SECRET),
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

    let mut tokens = parse_token_response(&body)?;
    tokens.email = fetch_user_email(&client, &tokens.access_token).await;
    let (project_id, plan_type) = fetch_code_assist_status(&client, &tokens.access_token).await;
    tokens.project_id = project_id;
    tokens.plan_type = plan_type;
    Ok(tokens)
}

pub async fn refresh_tokens(refresh_token: &str) -> Result<OAuthTokenSet> {
    let client = build_proxied_client_with_timeout(Duration::from_secs(HTTP_TIMEOUT_SECS)).await?;
    let params = [
        ("grant_type", "refresh_token"),
        ("client_id", CLIENT_ID),
        ("client_secret", CLIENT_SECRET),
        ("refresh_token", refresh_token),
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

pub fn parse_claims(tokens: &OAuthTokenSet) -> OAuthClaims {
    OAuthClaims {
        email: tokens.email.trim().to_string(),
        account_id: tokens.project_id.trim().to_string(),
        plan_type: tokens.plan_type.trim().to_string(),
    }
}

fn model_rank(id: &str) -> usize {
    PREFERRED_MODELS
        .iter()
        .position(|preferred| *preferred == id)
        .unwrap_or(PREFERRED_MODELS.len())
}

fn push_model(models: &mut Vec<String>, id: &str) {
    let id = id.trim();
    if !id.is_empty() && !models.iter().any(|existing| existing == id) {
        models.push(id.to_string());
    }
}

fn parse_models_value(parsed: &Value) -> Vec<String> {
    let mut models: Vec<String> = Vec::new();

    match parsed.get("models") {
        Some(Value::Object(entries)) => {
            for key in entries.keys() {
                push_model(&mut models, key);
            }
        }
        Some(Value::Array(items)) => {
            for item in items {
                let id = item
                    .get("id")
                    .or_else(|| item.get("name"))
                    .or_else(|| item.get("model"))
                    .and_then(Value::as_str);
                if let Some(id) = id {
                    push_model(&mut models, id);
                }
            }
        }
        _ => {}
    }

    models.sort_by_key(|id| model_rank(id));
    models
}

fn parse_models_payload(body: &str) -> Result<Vec<String>> {
    let parsed: Value = serde_json::from_str(body)
        .map_err(|error| Error::from_reason(format!("Invalid model list: {error}")))?;
    Ok(parse_models_value(&parsed))
}

fn models_body(project_id: &str) -> Value {
    let project_id = project_id.trim();
    if project_id.is_empty() {
        json!({})
    } else {
        json!({ "project": project_id })
    }
}

pub async fn fetch_models(access_token: &str, project_id: &str) -> Result<Vec<String>> {
    let client = build_proxied_client_with_timeout(Duration::from_secs(HTTP_TIMEOUT_SECS)).await?;
    let payload = post_code_assist(
        &client,
        "fetchAvailableModels",
        access_token,
        &models_body(project_id),
    )
    .await?;
    Ok(parse_models_value(&payload))
}

pub fn fetch_models_blocking(
    base_url: &str,
    access_token: &str,
    project_id: &str,
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

    let normalized = base_url.trim().trim_end_matches('/');
    let mut hosts: Vec<String> = Vec::new();
    if !normalized.is_empty() {
        hosts.push(normalized.to_string());
    }
    for host in CODE_ASSIST_HOSTS {
        if !hosts.iter().any(|existing| existing.as_str() == *host) {
            hosts.push((*host).to_string());
        }
    }

    let body = models_body(project_id);
    let mut last_error = String::new();
    for host in hosts {
        let url = format!("{host}/v1internal:fetchAvailableModels");
        let response = client
            .post(&url)
            .header(reqwest::header::ACCEPT, "application/json")
            .header(
                reqwest::header::AUTHORIZATION,
                format!("Bearer {access_token}"),
            )
            .header("x-goog-api-client", API_CLIENT)
            .json(&body)
            .send();
        match response {
            Ok(response) => {
                let status = response.status();
                let text = response.text().unwrap_or_default();
                if status.is_success() {
                    return parse_models_payload(&text);
                }
                last_error = format!("{status} {text}");
            }
            Err(error) => last_error = error.to_string(),
        }
    }

    Err(Error::from_reason(format!(
        "Model list request failed: {last_error}"
    )))
}

/// Code Assist 网关要求的客户端身份头，作为默认值写入「Antigravity」自定义请求头方案。
pub fn required_headers() -> Vec<(&'static str, String)> {
    vec![
        ("User-Agent", user_agent()),
        ("x-goog-api-client", API_CLIENT.to_string()),
    ]
}

/// 授权头随令牌刷新变化，不写入共享方案，在请求时按档案当前令牌注入。
pub fn apply_request_headers(access_token: &str, headers: &mut HashMap<String, String>) {
    let access_token = access_token.trim();
    if access_token.is_empty() {
        return;
    }
    headers.insert(
        "Authorization".to_string(),
        format!("Bearer {access_token}"),
    );
}
