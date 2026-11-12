use std::time::Duration;

use napi::bindgen_prelude::*;
use serde::Serialize;
use serde_json::Value;

use super::provider::{now_epoch_secs, OAuthClaims, OAuthTokenSet};
use snow_net::http_client::{build_proxied_client_with_timeout, load_proxy_config_sync};

pub const CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
pub const DEFAULT_MODEL: &str = "claude-sonnet-4-6";
pub const BACKEND_BASE_URL: &str = "https://api.anthropic.com";
pub const CALLBACK_PATH: &str = "/callback";
pub const CALLBACK_PORTS: &[u16] = &[54545];

const AUTHORIZE_URL: &str = "https://claude.ai/oauth/authorize";
const TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";
const OAUTH_BETA: &str = "oauth-2025-04-20";
/// 订阅（OAuth）对话请求的 anthropic-beta 基线。
///
/// Claude Code 客户端固定先声明 `claude-code-20250219`，紧随其后才是
/// `oauth-2025-04-20`（与 Claude Code 及 CLIProxyAPI 的上游请求顺序一致），
/// 网关据此把请求识别为官方订阅客户端请求。
const MESSAGES_BETA: &str = "claude-code-20250219,oauth-2025-04-20";
/// Claude Code 客户端的 User-Agent 形状，订阅请求必须携带。
const CLAUDE_CODE_USER_AGENT: &str = "claude-cli/2.1.280 (external, cli)";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const OAUTH_SCOPE: &str =
    "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
const OAUTH_TOKEN_PREFIX: &str = "sk-ant-oat";
const HTTP_TIMEOUT_SECS: u64 = 30;
const MODELS_TIMEOUT_SECS: u64 = 15;
const MODELS_LIMIT: u32 = 1000;

pub fn is_oauth_access_token(api_key: &str) -> bool {
    api_key.trim().starts_with(OAUTH_TOKEN_PREFIX)
}

/// 组装 Anthropic Messages 端点。
///
/// 订阅（OAuth）令牌的端点形状与 API key 渠道不同：
/// 1. 订阅档案的 base_url 只填了域名（`https://api.anthropic.com`），而 Messages
///    API 挂在 `/v1` 前缀下，这里补上前缀，避免请求落到 `/messages` 上（404）。
/// 2. Claude Code 客户端始终在 Messages 端点上携带 `beta=true`，网关按该参数把
///    请求路由到订阅可用的 beta 通道；缺少该参数同样得到 404。
pub fn resolve_messages_endpoint(resolved_base: &str, api_key: &str) -> String {
    let base = resolved_base.trim().trim_end_matches('/');
    if !is_oauth_access_token(api_key) {
        return format!("{base}/messages");
    }
    let base = if base.ends_with("/v1") {
        base.to_string()
    } else {
        format!("{base}/v1")
    };
    format!("{base}/messages?beta=true")
}

pub fn build_authorize_url(redirect_uri: &str, challenge: &str, state: &str) -> Result<String> {
    let mut url = reqwest::Url::parse(AUTHORIZE_URL)
        .map_err(|error| Error::from_reason(format!("Invalid authorize URL: {error}")))?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("code", "true");
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

fn split_code_and_state(raw: &str) -> (String, String) {
    let trimmed = raw.trim();
    match trimmed.split_once('#') {
        Some((code, state)) => (code.trim().to_string(), state.trim().to_string()),
        None => (trimmed.to_string(), String::new()),
    }
}

// 键序与 Claude Code 客户端保持一致，服务端按此形状识别请求。
#[derive(Serialize)]
struct AuthorizationCodeExchange<'a> {
    grant_type: &'a str,
    code: &'a str,
    redirect_uri: &'a str,
    client_id: &'a str,
    code_verifier: &'a str,
    state: &'a str,
}

#[derive(Serialize)]
struct RefreshTokenRequest<'a> {
    client_id: &'a str,
    grant_type: &'a str,
    refresh_token: &'a str,
    scope: &'a str,
}

fn apply_oauth_headers(
    request: reqwest::RequestBuilder,
) -> reqwest::RequestBuilder {
    request
        .header(reqwest::header::ACCEPT, "application/json, text/plain, */*")
        .header(reqwest::header::USER_AGENT, "axios/1.15.2")
        .header(reqwest::header::CONNECTION, "close")
}

pub async fn exchange_code(
    code: &str,
    redirect_uri: &str,
    code_verifier: &str,
    state: &str,
) -> Result<OAuthTokenSet> {
    let (code, embedded_state) = split_code_and_state(code);
    if code.is_empty() {
        return Err(Error::from_reason("Authorization code is empty"));
    }
    let state = if embedded_state.is_empty() {
        state.trim().to_string()
    } else {
        embedded_state
    };
    let body = AuthorizationCodeExchange {
        grant_type: "authorization_code",
        code: &code,
        redirect_uri,
        client_id: CLIENT_ID,
        code_verifier,
        state: &state,
    };
    let client = build_proxied_client_with_timeout(Duration::from_secs(HTTP_TIMEOUT_SECS)).await?;
    let response = apply_oauth_headers(client.post(TOKEN_URL))
        .json(&body)
        .send()
        .await
        .map_err(|error| Error::from_reason(format!("Token exchange request failed: {error}")))?;
    read_token_response(response).await
}

pub async fn refresh_tokens(refresh_token: &str) -> Result<OAuthTokenSet> {
    let body = RefreshTokenRequest {
        client_id: CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token,
        scope: OAUTH_SCOPE,
    };
    let client = build_proxied_client_with_timeout(Duration::from_secs(HTTP_TIMEOUT_SECS)).await?;
    let response = apply_oauth_headers(client.post(TOKEN_URL))
        .json(&body)
        .send()
        .await
        .map_err(|error| Error::from_reason(format!("Token refresh failed: {error}")))?;
    read_token_response(response).await
}

async fn read_token_response(response: reqwest::Response) -> Result<OAuthTokenSet> {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(Error::from_reason(format!(
            "Token request failed: {status} {body}"
        )));
    }
    parse_token_response(&body)
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
    let email = parsed
        .get("account")
        .and_then(|account| account.get("email_address"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();

    Ok(OAuthTokenSet {
        access_token,
        refresh_token: parsed
            .get("refresh_token")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        id_token: String::new(),
        email,
        plan_type: String::new(),
        project_id: String::new(),
        expires_at: now_epoch_secs() + expires_in,
    })
}

pub fn parse_claims(tokens: &OAuthTokenSet) -> OAuthClaims {
    OAuthClaims {
        email: tokens.email.trim().to_string(),
        account_id: String::new(),
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
    format!("{base}/v1/models?limit={MODELS_LIMIT}")
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
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("anthropic-beta", OAUTH_BETA)
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
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("anthropic-beta", OAUTH_BETA)
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

/// 订阅（OAuth）对话请求需要携带的 Claude Code 身份头。
///
/// 与 API key 渠道不同，Anthropic 按官方 Claude Code 客户端的形状校验订阅令牌的
/// Messages 请求：`anthropic-beta` 必须同时声明 `claude-code-20250219`，并携带 CLI 的
/// User-Agent、`x-app: cli` 与直接浏览器访问声明，请求才会被网关当作官方订阅客户端
/// 放行（与 CLIProxyAPI 的上游伪装行为一致）。这些值作为默认值写入「Claude」自定义
/// 请求头方案，由档案绑定后随请求下发，用户可在设置中调整。
pub fn required_headers() -> Vec<(&'static str, String)> {
    vec![
        ("anthropic-version", ANTHROPIC_VERSION.to_string()),
        ("anthropic-beta", MESSAGES_BETA.to_string()),
        ("anthropic-dangerous-direct-browser-access", "true".to_string()),
        ("x-app", "cli".to_string()),
        ("user-agent", CLAUDE_CODE_USER_AGENT.to_string()),
    ]
}
