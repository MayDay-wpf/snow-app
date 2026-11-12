//! 插件 provider 的登录：授权地址、换 token、设备码轮询与档案落库。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use napi::bindgen_prelude::*;
use serde_json::{json, Map, Value};

use super::profile::{PluginProfileMetadata, PluginTokens};
use super::registry::{self, PluginProviderSpec};
use super::{host, parse_model_ids};
use crate::oauth::header_schemes;
use crate::oauth::provider::{display_name_for, profile_name_for, OAuthClaims};
use crate::oauth::sessions::{OAuthLoginOutcome, OAuthLoginSession};
use snow_storage::api_configs as api_configs_service;
use snow_storage_core::bootstrap::ensure_database_file;
use snow_storage_core::models::ApiConfigInput;

const LOGIN_HOOK_TIMEOUT: Duration = Duration::from_secs(60);

pub struct AuthorizeResult {
    pub url: String,
    pub redirect_uri: Option<String>,
    pub user_code: String,
    pub instructions: String,
    pub interval_secs: u64,
    pub expires_in_secs: u64,
    pub session: Value,
}

pub enum PollOutcome {
    Pending { slow_down: bool },
    Tokens(PluginTokens),
}

fn read_text(object: &Map<String, Value>, key: &str) -> String {
    object
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string()
}

pub async fn authorize(
    spec: &PluginProviderSpec,
    redirect_uri: &str,
    state: &str,
    nonce: &str,
    code_verifier: &str,
    code_challenge: &str,
) -> Result<AuthorizeResult> {
    let ctx = json!({
        "flow": spec.flow(),
        "redirectUri": redirect_uri,
        "state": state,
        "nonce": nonce,
        "codeVerifier": code_verifier,
        "codeChallenge": code_challenge,
        "codeChallengeMethod": "S256",
    });
    let value = host::call("authorize", &spec.id, ctx, LOGIN_HOOK_TIMEOUT).await?;
    let object = value
        .as_object()
        .ok_or_else(|| Error::from_reason("OAuth plugin authorize() must return an object"))?;
    let url = read_text(object, "url");
    // 自定义面板可以自行构建授权地址（甚至不跳浏览器）。
    if url.is_empty() && spec.flow() != "panel" {
        return Err(Error::from_reason(
            "OAuth plugin authorize() did not return a sign-in url",
        ));
    }
    let redirect_uri = Some(read_text(object, "redirectUri")).filter(|uri| !uri.is_empty());
    Ok(AuthorizeResult {
        url,
        redirect_uri,
        user_code: read_text(object, "userCode"),
        instructions: read_text(object, "instructions"),
        interval_secs: object.get("interval").and_then(Value::as_u64).unwrap_or(0),
        expires_in_secs: object.get("expiresIn").and_then(Value::as_u64).unwrap_or(0),
        session: object.get("session").cloned().unwrap_or(Value::Null),
    })
}

fn session_context(session: &OAuthLoginSession) -> Value {
    json!({
        "flow": session.flow,
        "redirectUri": session.redirect_uri,
        "state": session.state,
        "nonce": session.nonce,
        "codeVerifier": session.code_verifier,
        "userCode": session.user_code,
        "session": session.plugin_session,
    })
}

pub async fn exchange(
    session: &OAuthLoginSession,
    provider_id: &str,
    code: &str,
    params: &HashMap<String, String>,
) -> Result<PluginTokens> {
    let mut ctx = session_context(session);
    if let Some(object) = ctx.as_object_mut() {
        object.insert("code".to_string(), json!(code));
        object.insert("params".to_string(), json!(params));
    }
    let value = host::call("exchange", provider_id, ctx, LOGIN_HOOK_TIMEOUT).await?;
    PluginTokens::from_value(&value)
}

pub async fn poll(session: &OAuthLoginSession, provider_id: &str) -> Result<PollOutcome> {
    let value = host::call("poll", provider_id, session_context(session), LOGIN_HOOK_TIMEOUT).await?;
    if value.get("pending").and_then(Value::as_bool) == Some(true) {
        return Ok(PollOutcome::Pending {
            slow_down: value.get("slowDown").and_then(Value::as_bool) == Some(true),
        });
    }
    let tokens = value
        .get("tokens")
        .ok_or_else(|| Error::from_reason("OAuth plugin poll() returned no tokens"))?;
    Ok(PollOutcome::Tokens(PluginTokens::from_value(tokens)?))
}

fn pick_model(configured: &str, available: &[String], fallback: &str) -> String {
    let configured = configured.trim();
    if !configured.is_empty() {
        return configured.to_string();
    }
    let fallback = fallback.trim();
    if !fallback.is_empty() && (available.is_empty() || available.iter().any(|id| id == fallback)) {
        return fallback.to_string();
    }
    available
        .first()
        .cloned()
        .unwrap_or_else(|| fallback.to_string())
}

fn build_config_json(
    spec: &PluginProviderSpec,
    metadata: &PluginProfileMetadata,
    advanced_model: &str,
    basic_model: &str,
) -> String {
    let mut root = Map::new();
    root.insert(
        "snowcfg".to_string(),
        json!({
            "baseUrl": spec.base_url,
            "baseUrlMode": "custom",
            "requestMethod": spec.request_method(),
            "advancedModel": advanced_model,
            "basicModel": basic_model,
            "supportsVision": spec.supports_vision,
            "visionBaseUrl": "",
            "visionBaseUrlMode": "auto",
            "visionRequestMethod": spec.request_method(),
            "visionModel": "",
            "enableAutoCompress": true,
            "maxContextTokens": spec.max_context_tokens(),
            "source": spec.source(),
        }),
    );
    root.insert(super::METADATA_KEY.to_string(), metadata.to_json());
    Value::Object(root).to_string()
}

#[allow(clippy::too_many_arguments)]
fn build_input(
    spec: &PluginProviderSpec,
    metadata: &PluginProfileMetadata,
    access_token: &str,
    profile_name: &str,
    display_name: &str,
    advanced_model: &str,
    basic_model: &str,
) -> ApiConfigInput {
    ApiConfigInput {
        profile_name: profile_name.to_string(),
        previous_profile_name: None,
        display_name: display_name.to_string(),
        is_active: true,
        base_url: spec.base_url.clone(),
        base_url_mode: "custom".to_string(),
        api_key: access_token.to_string(),
        request_method: spec.request_method().to_string(),
        advanced_model: advanced_model.to_string(),
        basic_model: basic_model.to_string(),
        supports_vision: spec.supports_vision,
        vision_base_url: String::new(),
        vision_base_url_mode: "auto".to_string(),
        vision_api_key: String::new(),
        vision_request_method: spec.request_method().to_string(),
        vision_model: String::new(),
        max_context_tokens: Some(spec.max_context_tokens()),
        max_tokens: spec.max_tokens.filter(|value| *value > 0),
        stream_idle_timeout_sec: None,
        enable_auto_compress: true,
        auto_compress_threshold: None,
        max_retries: None,
        retry_base_delay_ms: None,
        partial_retry_max_chars: None,
        system_prompt_ids_json: String::new(),
        custom_header_scheme_id: String::new(),
        config_json: build_config_json(spec, metadata, advanced_model, basic_model),
        source: spec.source(),
    }
}

/// 写入档案；插件声明了固定请求头时补建同名请求头方案并绑定。
async fn persist(spec: Arc<PluginProviderSpec>, mut input: ApiConfigInput) -> Result<()> {
    tokio::task::spawn_blocking(move || -> Result<()> {
        let database_path = ensure_database_file()?;
        if !spec.headers.is_empty() {
            let scheme_name = match spec.header_scheme_name.trim() {
                "" => spec.label().to_string(),
                name => name.to_string(),
            };
            let required = spec
                .headers
                .iter()
                .map(|(name, value)| (name.clone(), value.clone()))
                .collect();
            input.custom_header_scheme_id =
                header_schemes::ensure_named_scheme(&database_path, &scheme_name, required)?;
        }
        api_configs_service::upsert_api_config(&database_path, &input)?;
        api_configs_service::reorder_api_configs(&database_path, &[input.profile_name.clone()])
    })
    .await
    .map_err(|error| Error::from_reason(format!("Failed to persist OAuth profile: {error}")))?
}

pub async fn finish(
    session: &OAuthLoginSession,
    provider_id: &str,
    tokens: PluginTokens,
) -> Result<OAuthLoginOutcome> {
    let spec = registry::ensure(provider_id).await?;
    let metadata = PluginProfileMetadata::from_tokens(&spec.id, &spec.plugin_id, &tokens);
    let available_models = if spec.hooks.models {
        let ctx = json!({
            "account": metadata.account_context(&tokens.access_token, "", &spec.base_url),
        });
        host::call("models", &spec.id, ctx, LOGIN_HOOK_TIMEOUT)
            .await
            .map(|value| parse_model_ids(&value))
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let advanced_model = pick_model(&session.advanced_model, &available_models, &spec.default_model);
    let basic_model = pick_model(&session.basic_model, &available_models, &spec.default_model);

    let claims = OAuthClaims {
        email: metadata.email.clone(),
        account_id: metadata.account_id.clone(),
        plan_type: metadata.plan_type.clone(),
    };
    let profile_name = profile_name_for(&spec.id, &claims);
    let display_name = display_name_for(spec.label(), &claims);
    let input = build_input(
        &spec,
        &metadata,
        &tokens.access_token,
        &profile_name,
        &display_name,
        &advanced_model,
        &basic_model,
    );
    persist(Arc::clone(&spec), input).await?;

    Ok(OAuthLoginOutcome {
        provider: spec.id.clone(),
        profile_name,
        display_name,
        email: metadata.email,
        plan_type: metadata.plan_type,
        account_id: metadata.account_id,
        available_models,
    })
}
