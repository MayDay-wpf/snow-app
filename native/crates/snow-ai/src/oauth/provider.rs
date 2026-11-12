use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use napi::bindgen_prelude::*;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::{anthropic, antigravity, chatgpt, codex, header_schemes, xai};
use snow_storage::api_configs as api_configs_service;
use snow_storage_core::app_logs::log_api_warning;
use snow_storage_core::bootstrap::ensure_database_file;
use snow_storage_core::models::{ApiConfigInput, ApiConfigRecord};

pub const TOKEN_REFRESH_LEEWAY_SECS: i64 = 120;
const PROFILE_SOURCE_PREFIX: &str = "oauth";
const LEGACY_METADATA_KEY: &str = "codexOAuth";
const METADATA_KEY: &str = "oauth";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum OAuthProviderId {
    Codex,
    ChatGpt,
    Anthropic,
    Antigravity,
    Xai,
}

impl OAuthProviderId {
    pub fn all() -> &'static [OAuthProviderId] {
        &[
            OAuthProviderId::Codex,
            OAuthProviderId::ChatGpt,
            OAuthProviderId::Anthropic,
            OAuthProviderId::Antigravity,
            OAuthProviderId::Xai,
        ]
    }

    pub fn as_str(self) -> &'static str {
        match self {
            OAuthProviderId::Codex => "codex",
            OAuthProviderId::ChatGpt => "chatgpt",
            OAuthProviderId::Anthropic => "anthropic",
            OAuthProviderId::Antigravity => "antigravity",
            OAuthProviderId::Xai => "xai",
        }
    }

    pub fn parse(value: &str) -> Option<OAuthProviderId> {
        let normalized = value.trim().to_ascii_lowercase();
        OAuthProviderId::all()
            .iter()
            .copied()
            .find(|provider| provider.as_str() == normalized)
    }

    pub fn display_name(self) -> &'static str {
        match self {
            OAuthProviderId::Codex => "ChatGPT Codex",
            OAuthProviderId::ChatGpt => "ChatGPT",
            OAuthProviderId::Anthropic => "Anthropic (Claude)",
            OAuthProviderId::Antigravity => "Antigravity (Google)",
            OAuthProviderId::Xai => "xAI (Grok)",
        }
    }

    pub fn default_model(self) -> &'static str {
        match self {
            OAuthProviderId::Codex => codex::DEFAULT_MODEL,
            OAuthProviderId::ChatGpt => chatgpt::DEFAULT_MODEL,
            OAuthProviderId::Anthropic => anthropic::DEFAULT_MODEL,
            OAuthProviderId::Antigravity => antigravity::DEFAULT_MODEL,
            OAuthProviderId::Xai => xai::DEFAULT_MODEL,
        }
    }

    pub fn default_max_context_tokens(self) -> i32 {
        match self {
            OAuthProviderId::Codex => 400_000,
            OAuthProviderId::ChatGpt => 400_000,
            OAuthProviderId::Anthropic => 500_000,
            OAuthProviderId::Antigravity => 1_000_000,
            OAuthProviderId::Xai => 500_000,
        }
    }

    /// 订阅档案的默认最大输出 tokens。
    ///
    /// 仅 Claude 订阅（OAuth）有固定默认值 128k；其余提供方保持 `None`
    /// （不传 `max_tokens`，由服务端决定），与既有行为一致。
    pub fn default_max_tokens(self) -> Option<i32> {
        match self {
            OAuthProviderId::Anthropic => Some(128_000),
            _ => None,
        }
    }

    pub fn backend_base_url(self) -> &'static str {
        match self {
            OAuthProviderId::Codex => codex::BACKEND_BASE_URL,
            OAuthProviderId::ChatGpt => chatgpt::BACKEND_BASE_URL,
            OAuthProviderId::Anthropic => anthropic::BACKEND_BASE_URL,
            OAuthProviderId::Antigravity => antigravity::BACKEND_BASE_URL,
            OAuthProviderId::Xai => xai::BACKEND_BASE_URL,
        }
    }

    pub fn request_method(self) -> &'static str {
        match self {
            OAuthProviderId::Codex => "responses",
            OAuthProviderId::ChatGpt => "responses",
            OAuthProviderId::Anthropic => "anthropic",
            OAuthProviderId::Antigravity => "gemini",
            OAuthProviderId::Xai => "responses",
        }
    }

    pub fn supports_vision(self) -> bool {
        match self {
            OAuthProviderId::Codex => true,
            OAuthProviderId::ChatGpt => true,
            OAuthProviderId::Anthropic => true,
            OAuthProviderId::Antigravity => true,
            OAuthProviderId::Xai => true,
        }
    }

    pub fn profile_source(self) -> String {
        format!("{PROFILE_SOURCE_PREFIX}-{}", self.as_str())
    }

    pub fn callback_path(self) -> &'static str {
        match self {
            OAuthProviderId::Codex => codex::CALLBACK_PATH,
            OAuthProviderId::ChatGpt => chatgpt::CALLBACK_PATH,
            OAuthProviderId::Anthropic => anthropic::CALLBACK_PATH,
            OAuthProviderId::Antigravity => antigravity::CALLBACK_PATH,
            OAuthProviderId::Xai => xai::CALLBACK_PATH,
        }
    }

    pub fn callback_ports(self) -> &'static [u16] {
        match self {
            OAuthProviderId::Codex => codex::CALLBACK_PORTS,
            OAuthProviderId::ChatGpt => chatgpt::CALLBACK_PORTS,
            OAuthProviderId::Anthropic => anthropic::CALLBACK_PORTS,
            OAuthProviderId::Antigravity => antigravity::CALLBACK_PORTS,
            OAuthProviderId::Xai => xai::CALLBACK_PORTS,
        }
    }

    pub fn redirect_host(self) -> &'static str {
        match self {
            OAuthProviderId::Codex => "127.0.0.1",
            OAuthProviderId::ChatGpt => "127.0.0.1",
            OAuthProviderId::Anthropic => "localhost",
            OAuthProviderId::Antigravity => "localhost",
            OAuthProviderId::Xai => "127.0.0.1",
        }
    }

    /// 订阅档案绑定的自定义请求头方案名称；`None` 表示该提供方没有固定身份请求头。
    pub fn header_scheme_name(self) -> Option<&'static str> {
        match self {
            OAuthProviderId::Codex => Some("Codex"),
            OAuthProviderId::Anthropic => Some("Claude"),
            OAuthProviderId::Antigravity => Some("Antigravity"),
            OAuthProviderId::ChatGpt | OAuthProviderId::Xai => None,
        }
    }

    /// 订阅请求必需的固定身份请求头，作为默认值写入该提供方的自定义请求头方案。
    pub fn required_headers(self) -> Vec<(&'static str, String)> {
        match self {
            OAuthProviderId::Codex => codex::required_headers(),
            OAuthProviderId::Anthropic => anthropic::required_headers(),
            OAuthProviderId::Antigravity => antigravity::required_headers(),
            OAuthProviderId::ChatGpt | OAuthProviderId::Xai => Vec::new(),
        }
    }
}

pub fn detect_provider_from_base_url(base_url: &str) -> Option<OAuthProviderId> {
    let normalized = base_url.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return None;
    }
    if normalized.contains(antigravity::BACKEND_BASE_URL_MARKER) {
        return Some(OAuthProviderId::Antigravity);
    }
    if normalized.contains(codex::BACKEND_BASE_URL_MARKER) {
        return Some(OAuthProviderId::Codex);
    }
    if normalized.contains(xai::BACKEND_BASE_URL_MARKER) {
        return Some(OAuthProviderId::Xai);
    }
    None
}

pub fn now_epoch_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

pub fn decode_jwt_payload(jwt: &str) -> Option<Value> {
    let payload = jwt.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn random_base64_url(bytes_len: usize) -> Result<String> {
    let mut buffer = vec![0u8; bytes_len];
    getrandom::getrandom(&mut buffer)
        .map_err(|error| Error::from_reason(format!("Failed to generate random bytes: {error}")))?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&buffer))
}

pub struct PkceCodes {
    pub verifier: String,
    pub challenge: String,
}

pub fn generate_pkce() -> Result<PkceCodes> {
    let verifier = random_base64_url(64)?;
    let digest = Sha256::digest(verifier.as_bytes());
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest);
    Ok(PkceCodes {
        verifier,
        challenge,
    })
}

pub fn generate_state() -> Result<String> {
    random_base64_url(32)
}

#[derive(Clone, Default)]
pub struct OAuthClaims {
    pub email: String,
    pub account_id: String,
    pub plan_type: String,
}

pub struct OAuthTokenSet {
    pub access_token: String,
    pub refresh_token: String,
    pub id_token: String,
    pub email: String,
    pub plan_type: String,
    pub project_id: String,
    pub expires_at: i64,
}

#[derive(Clone)]
pub struct OAuthProfileMetadata {
    pub provider: OAuthProviderId,
    pub refresh_token: String,
    pub client_id: String,
    pub account_id: String,
    pub email: String,
    pub plan_type: String,
    pub expires_at: i64,
}

impl OAuthProfileMetadata {
    pub fn to_json(&self) -> Value {
        json!({
            "provider": self.provider.as_str(),
            "refreshToken": self.refresh_token,
            "clientId": self.client_id,
            "accountId": self.account_id,
            "email": self.email,
            "planType": self.plan_type,
            "expiresAt": self.expires_at,
            "obtainedAt": now_epoch_secs(),
        })
    }

    pub fn from_value(value: &Value) -> Option<OAuthProfileMetadata> {
        let object = value.as_object()?;
        let provider = object
            .get("provider")
            .and_then(Value::as_str)
            .and_then(OAuthProviderId::parse)
            .unwrap_or(OAuthProviderId::Codex);
        Some(OAuthProfileMetadata {
            provider,
            refresh_token: read_string(object, "refreshToken"),
            client_id: read_string(object, "clientId"),
            account_id: read_string(object, "accountId"),
            email: read_string(object, "email"),
            plan_type: read_string(object, "planType"),
            expires_at: object.get("expiresAt").and_then(Value::as_i64).unwrap_or(0),
        })
    }

    pub fn from_config_json(config_json: &str) -> Option<OAuthProfileMetadata> {
        let parsed: Value = serde_json::from_str(config_json).ok()?;
        parsed
            .get(METADATA_KEY)
            .and_then(OAuthProfileMetadata::from_value)
            .or_else(|| {
                parsed
                    .get(LEGACY_METADATA_KEY)
                    .and_then(OAuthProfileMetadata::from_value)
            })
    }

    pub fn has_refresh_token(&self) -> bool {
        !self.refresh_token.trim().is_empty()
    }
}

pub fn antigravity_profile_metadata(config_json: &str) -> Option<OAuthProfileMetadata> {
    OAuthProfileMetadata::from_config_json(config_json)
        .filter(|metadata| metadata.provider == OAuthProviderId::Antigravity)
}

fn read_string(object: &serde_json::Map<String, Value>, key: &str) -> String {
    object
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string()
}

pub fn build_authorize_url(
    provider: OAuthProviderId,
    redirect_uri: &str,
    pkce: &PkceCodes,
    state: &str,
    nonce: &str,
    host_id: &str,
) -> Result<String> {
    match provider {
        OAuthProviderId::Codex => {
            codex::build_authorize_url(redirect_uri, &pkce.challenge, state)
        }
        OAuthProviderId::ChatGpt => {
            chatgpt::build_authorize_url(redirect_uri, &pkce.challenge, state, nonce, host_id)
        }
        OAuthProviderId::Anthropic => {
            anthropic::build_authorize_url(redirect_uri, &pkce.challenge, state)
        }
        OAuthProviderId::Antigravity => {
            antigravity::build_authorize_url(redirect_uri, &pkce.challenge, state)
        }
        OAuthProviderId::Xai => xai::build_authorize_url(redirect_uri, &pkce.challenge, state),
    }
}

pub async fn exchange_code(
    provider: OAuthProviderId,
    code: &str,
    redirect_uri: &str,
    code_verifier: &str,
    state: &str,
    issued_client_id: &str,
) -> Result<OAuthTokenSet> {
    match provider {
        OAuthProviderId::Codex => codex::exchange_code(code, redirect_uri, code_verifier).await,
        OAuthProviderId::ChatGpt => {
            chatgpt::exchange_code(code, redirect_uri, code_verifier, issued_client_id).await
        }
        OAuthProviderId::Anthropic => {
            anthropic::exchange_code(code, redirect_uri, code_verifier, state).await
        }
        OAuthProviderId::Antigravity => {
            antigravity::exchange_code(code, redirect_uri, code_verifier).await
        }
        OAuthProviderId::Xai => xai::exchange_code(code, redirect_uri, code_verifier).await,
    }
}

pub async fn refresh_tokens(
    provider: OAuthProviderId,
    refresh_token: &str,
    client_id: &str,
) -> Result<OAuthTokenSet> {
    match provider {
        OAuthProviderId::Codex => codex::refresh_tokens(refresh_token).await,
        OAuthProviderId::ChatGpt => chatgpt::refresh_tokens(refresh_token, client_id).await,
        OAuthProviderId::Anthropic => anthropic::refresh_tokens(refresh_token).await,
        OAuthProviderId::Antigravity => antigravity::refresh_tokens(refresh_token).await,
        OAuthProviderId::Xai => xai::refresh_tokens(refresh_token).await,
    }
}

pub async fn fetch_models(
    provider: OAuthProviderId,
    access_token: &str,
    account_id: &str,
) -> Result<Vec<String>> {
    match provider {
        OAuthProviderId::Codex => codex::fetch_models(access_token, account_id).await,
        OAuthProviderId::ChatGpt => chatgpt::fetch_models(access_token).await,
        OAuthProviderId::Anthropic => anthropic::fetch_models(access_token).await,
        OAuthProviderId::Antigravity => antigravity::fetch_models(access_token, account_id).await,
        OAuthProviderId::Xai => xai::fetch_models(access_token).await,
    }
}

/// 账号级动态请求头（随登录账号或令牌变化，无法写入共享的请求头方案）。
///
/// 固定的身份请求头由档案绑定的自定义请求头方案提供（见 `header_schemes`）。
pub fn apply_request_headers(
    config: &ApiConfigRecord,
    headers: &mut HashMap<String, String>,
) {
    super::plugin::apply_request_headers(config, headers);
    let Some(metadata) = OAuthProfileMetadata::from_config_json(&config.config_json) else {
        return;
    };
    match metadata.provider {
        OAuthProviderId::Codex => codex::apply_request_headers(&metadata, headers),
        OAuthProviderId::Antigravity => {
            antigravity::apply_request_headers(&config.api_key, headers)
        }
        OAuthProviderId::ChatGpt | OAuthProviderId::Anthropic | OAuthProviderId::Xai => {}
    }
}

pub struct PreparedProfile {
    pub profile_name: String,
    pub display_name: String,
    pub input: ApiConfigInput,
}

pub fn prepare_profile(
    provider: OAuthProviderId,
    claims: &OAuthClaims,
    metadata: &OAuthProfileMetadata,
    access_token: &str,
    advanced_model: &str,
    basic_model: &str,
) -> PreparedProfile {
    let profile_name = build_profile_name(provider, claims);
    let display_name = build_display_name(provider, claims);
    let config_json = build_config_json(provider, metadata, advanced_model, basic_model);
    let input = ApiConfigInput {
        profile_name: profile_name.clone(),
        previous_profile_name: None,
        display_name: display_name.clone(),
        is_active: true,
        base_url: provider.backend_base_url().to_string(),
        base_url_mode: "custom".to_string(),
        api_key: access_token.to_string(),
        request_method: provider.request_method().to_string(),
        advanced_model: advanced_model.to_string(),
        basic_model: basic_model.to_string(),
        supports_vision: provider.supports_vision(),
        vision_base_url: String::new(),
        vision_base_url_mode: "auto".to_string(),
        vision_api_key: String::new(),
        vision_request_method: provider.request_method().to_string(),
        vision_model: String::new(),
        max_context_tokens: Some(provider.default_max_context_tokens()),
        max_tokens: provider.default_max_tokens(),
        stream_idle_timeout_sec: None,
        enable_auto_compress: true,
        auto_compress_threshold: None,
        max_retries: None,
        retry_base_delay_ms: None,
        partial_retry_max_chars: None,
        system_prompt_ids_json: String::new(),
        custom_header_scheme_id: String::new(),
        config_json,
        source: provider.profile_source(),
    };
    PreparedProfile {
        profile_name,
        display_name,
        input,
    }
}

fn build_profile_name(provider: OAuthProviderId, claims: &OAuthClaims) -> String {
    profile_name_for(provider.as_str(), claims)
}

/// 档案名：`<prefix>-<邮箱前缀>`，无邮箱时退化为账号 id 前 8 位。
pub fn profile_name_for(prefix: &str, claims: &OAuthClaims) -> String {
    let email = claims.email.trim();
    if !email.is_empty() {
        let local = email.split('@').next().unwrap_or(email);
        let sanitized = sanitize_profile_segment(local);
        if !sanitized.is_empty() {
            return format!("{prefix}-{sanitized}");
        }
    }
    let account = claims.account_id.trim();
    if !account.is_empty() {
        let short: String = account.chars().take(8).collect();
        return format!("{prefix}-{}", sanitize_profile_segment(&short));
    }
    prefix.to_string()
}

fn sanitize_profile_segment(value: &str) -> String {
    value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
        .collect::<String>()
        .to_lowercase()
}

fn build_display_name(provider: OAuthProviderId, claims: &OAuthClaims) -> String {
    display_name_for(provider.display_name(), claims)
}

pub fn display_name_for(label: &str, claims: &OAuthClaims) -> String {
    let email = claims.email.trim();
    if !email.is_empty() {
        return format!("{label} ({email})");
    }
    let account = claims.account_id.trim();
    if !account.is_empty() {
        let short: String = account.chars().take(8).collect();
        return format!("{label} ({short})");
    }
    label.to_string()
}

fn build_config_json(
    provider: OAuthProviderId,
    metadata: &OAuthProfileMetadata,
    advanced_model: &str,
    basic_model: &str,
) -> String {
    let mut metadata = metadata.clone();
    metadata.provider = provider;
    let mut root = serde_json::Map::new();
    root.insert(
        "snowcfg".to_string(),
        json!({
            "baseUrl": provider.backend_base_url(),
            "baseUrlMode": "custom",
            "requestMethod": provider.request_method(),
            "advancedModel": advanced_model,
            "basicModel": basic_model,
            "supportsVision": provider.supports_vision(),
            "visionBaseUrl": "",
            "visionBaseUrlMode": "auto",
            "visionRequestMethod": provider.request_method(),
            "visionModel": "",
            "enableAutoCompress": true,
            "maxContextTokens": provider.default_max_context_tokens(),
            "source": provider.profile_source(),
        }),
    );
    root.insert(METADATA_KEY.to_string(), metadata.to_json());
    Value::Object(root).to_string()
}

pub async fn refresh_if_needed(api_config: ApiConfigRecord) -> Result<ApiConfigRecord> {
    if super::plugin::is_plugin_profile(&api_config.config_json) {
        return super::plugin::refresh_if_needed(api_config).await;
    }
    let Some(metadata) = OAuthProfileMetadata::from_config_json(&api_config.config_json) else {
        return Ok(api_config);
    };
    if !metadata.has_refresh_token() {
        return Ok(api_config);
    }
    if metadata.expires_at > now_epoch_secs() + TOKEN_REFRESH_LEEWAY_SECS {
        return Ok(api_config);
    }

    let provider = metadata.provider;
    let tokens = match refresh_tokens(provider, &metadata.refresh_token, &metadata.client_id).await {
        Ok(tokens) => tokens,
        Err(error) => {
            if let Ok(database_path) = ensure_database_file() {
                log_api_warning(
                    &database_path,
                    "refresh_if_needed",
                    "OAuth token refresh failed; keeping the stored token",
                    &format!("provider={} error={}", provider.as_str(), error.reason),
                )
                .await;
            }
            return Ok(api_config);
        }
    };

    let claims = match provider {
        OAuthProviderId::Codex | OAuthProviderId::ChatGpt => codex::parse_claims(&tokens.id_token),
        OAuthProviderId::Anthropic => anthropic::parse_claims(&tokens),
        OAuthProviderId::Antigravity => antigravity::parse_claims(&tokens),
        OAuthProviderId::Xai => xai::parse_claims(&tokens.id_token),
    };

    let updated_metadata = OAuthProfileMetadata {
        provider,
        client_id: metadata.client_id.clone(),
        refresh_token: pick_fresh(&tokens.refresh_token, &metadata.refresh_token),
        account_id: pick_fresh(&claims.account_id, &metadata.account_id),
        email: pick_fresh(&claims.email, &metadata.email),
        plan_type: pick_fresh(&claims.plan_type, &metadata.plan_type),
        expires_at: tokens.expires_at,
    };
    let config_json = merge_metadata_into_config(&api_config.config_json, &updated_metadata);

    let database_path = ensure_database_file()?;
    let profile_name = api_config.profile_name.clone();
    let mut input = input_from_record(&api_config);
    input.api_key = tokens.access_token.clone();
    input.config_json = config_json.clone();

    let persisted = {
        let db_path = database_path.clone();
        tokio::task::spawn_blocking(move || -> Result<ApiConfigRecord> {
            api_configs_service::upsert_api_config(&db_path, &input)?;
            let configs = api_configs_service::list_api_configs(&db_path)?;
            configs
                .into_iter()
                .find(|config| config.profile_name == profile_name)
                .ok_or_else(|| {
                    Error::from_reason("OAuth profile could not be reloaded after refresh")
                })
        })
        .await
        .map_err(|error| {
            Error::from_reason(format!("Failed to persist refreshed OAuth tokens: {error}"))
        })?
    };

    match persisted {
        Ok(updated) => Ok(updated),
        Err(_) => {
            let mut fallback = api_config;
            fallback.api_key = tokens.access_token;
            fallback.config_json = config_json;
            Ok(fallback)
        }
    }
}

fn pick_fresh(fresh: &str, existing: &str) -> String {
    if fresh.trim().is_empty() {
        existing.to_string()
    } else {
        fresh.to_string()
    }
}

/// 以库内记录为底构造回写输入；视觉 key 留空，由 upsert 保留库内原值。
pub fn input_from_record(record: &ApiConfigRecord) -> ApiConfigInput {
    ApiConfigInput {
        profile_name: record.profile_name.clone(),
        previous_profile_name: None,
        display_name: record.display_name.clone(),
        is_active: record.is_active,
        base_url: record.base_url.clone(),
        base_url_mode: record.base_url_mode.clone(),
        api_key: record.api_key.clone(),
        request_method: record.request_method.clone(),
        advanced_model: record.advanced_model.clone(),
        basic_model: record.basic_model.clone(),
        supports_vision: record.supports_vision,
        vision_base_url: record.vision_base_url.clone(),
        vision_base_url_mode: record.vision_base_url_mode.clone(),
        vision_api_key: String::new(),
        vision_request_method: record.vision_request_method.clone(),
        vision_model: record.vision_model.clone(),
        max_context_tokens: record.max_context_tokens,
        max_tokens: record.max_tokens,
        stream_idle_timeout_sec: record.stream_idle_timeout_sec,
        enable_auto_compress: record.enable_auto_compress,
        auto_compress_threshold: record.auto_compress_threshold,
        max_retries: record.max_retries,
        retry_base_delay_ms: record.retry_base_delay_ms,
        partial_retry_max_chars: record.partial_retry_max_chars,
        system_prompt_ids_json: record.system_prompt_ids_json.clone(),
        custom_header_scheme_id: record.custom_header_scheme_id.clone(),
        config_json: record.config_json.clone(),
        source: record.source.clone(),
    }
}

pub fn merge_metadata_into_config(
    config_json: &str,
    metadata: &OAuthProfileMetadata,
) -> String {
    let mut parsed: Value = serde_json::from_str(config_json).unwrap_or_else(|_| json!({}));
    if !parsed.is_object() {
        parsed = json!({});
    }
    if let Some(object) = parsed.as_object_mut() {
        object.insert(METADATA_KEY.to_string(), metadata.to_json());
    }
    parsed.to_string()
}

/// 渲染层保存的是打开编辑框时的快照，其中的 access token 与 oauth 元数据（refreshToken、expiresAt）
/// 可能已被后台刷新过期或轮换。已有 OAuth 档案的这两部分只能由登录与刷新流程写入，
/// 保存时以库内记录为准，避免把旧令牌回写覆盖新令牌。
pub fn keep_saved_oauth_secrets(config: &mut ApiConfigInput, saved: &ApiConfigRecord) {
    if OAuthProfileMetadata::from_config_json(&saved.config_json).is_none()
        && !super::plugin::is_plugin_profile(&saved.config_json)
    {
        return;
    }
    config.api_key = saved.api_key.clone();
    let mut incoming: Value =
        serde_json::from_str(&config.config_json).unwrap_or_else(|_| json!({}));
    let saved_root: Value = serde_json::from_str(&saved.config_json).unwrap_or_else(|_| json!({}));
    if let (Some(incoming_object), Some(saved_object)) =
        (incoming.as_object_mut(), saved_root.as_object())
    {
        for key in [METADATA_KEY, LEGACY_METADATA_KEY, super::plugin::METADATA_KEY] {
            match saved_object.get(key) {
                Some(value) => {
                    incoming_object.insert(key.to_string(), value.clone());
                }
                None => {
                    incoming_object.remove(key);
                }
            }
        }
    }
    config.config_json = incoming.to_string();
}

/// 写入登录得到的订阅档案，并把档案绑定到提供方的自定义请求头方案（缺失则补建）。
pub async fn persist_profile(
    database_path: PathBuf,
    provider: OAuthProviderId,
    mut input: ApiConfigInput,
) -> Result<()> {
    tokio::task::spawn_blocking(move || {
        if let Some(scheme_id) = header_schemes::ensure_provider_scheme(&database_path, provider)? {
            input.custom_header_scheme_id = scheme_id;
        }
        api_configs_service::upsert_api_config(&database_path, &input)?;
        api_configs_service::reorder_api_configs(&database_path, &[input.profile_name.clone()])
    })
    .await
    .map_err(|error| Error::from_reason(format!("Failed to persist OAuth profile: {error}")))?
}
