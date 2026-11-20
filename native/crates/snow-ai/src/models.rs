use std::collections::HashMap;
use std::time::Duration;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use reqwest::{
    blocking::Client,
    header::{HeaderMap, HeaderName, HeaderValue},
};
use serde_json::Value;

use crate::config::{
    get_active_api_request_context, get_api_config_custom_headers, normalize_base_url,
    resolve_models_endpoint, DEFAULT_ANTHROPIC_BASE_URL, DEFAULT_GEMINI_BASE_URL,
    DEFAULT_OPENAI_BASE_URL,
};
use crate::oauth::anthropic as anthropic_oauth;
use crate::oauth::antigravity as antigravity_oauth;
use crate::oauth::chatgpt as chatgpt_oauth;
use crate::oauth::codex as codex_oauth;
use crate::oauth::provider::{
    self as oauth_provider, OAuthProfileMetadata, OAuthProviderId,
};
use crate::oauth::xai as xai_oauth;
use snow_net::retry::{with_retry_sync, RetryLogContext, RetryOptions};
use snow_storage::api_configs as api_configs_service;
use snow_storage_core::bootstrap::ensure_database_file;
use snow_storage_core::models::ApiConfigRecord;

#[napi(object)]
pub struct Model {
    pub id: String,
    pub object: String,
    pub created: i64,
    pub owned_by: String,
    /// 模型上下文窗口（tokens）：渠道的模型清单自带该信息时填充。
    pub context_length: Option<i64>,
    /// 单次请求的最大输出 tokens。
    pub max_output_tokens: Option<i64>,
}

/// 单个模型的上下文 / 输出上限；字段缺失表示该来源没有提供。
#[napi(object)]
#[derive(Clone)]
pub struct ModelLimits {
    pub context_length: Option<i64>,
    pub max_output_tokens: Option<i64>,
}

const MODEL_FETCH_TIMEOUT_SECS: u64 = 15;
/// 公共模型规格数据源（llm-specs）的请求超时。
const LLM_SPECS_TIMEOUT_SECS: u64 = 6;
const LLM_SPECS_BASE_URL: &str = "https://api-llm-specs.axium-lab.com";
const LLM_SPECS_MODELS_PATH: &str = "/v1/models";
const CONTEXT_LIMIT_KEYS: &[&str] = &[
    "context_length",
    "context_window",
    "max_input_tokens",
    "max_model_len",
    "inputTokenLimit",
];
const OUTPUT_LIMIT_KEYS: &[&str] = &[
    "max_output_tokens",
    "max_completion_tokens",
    "outputTokenLimit",
];

fn create_models_http_client() -> Result<Client> {
    let proxy_config = snow_net::http_client::load_proxy_config_sync()?;
    let builder = Client::builder()
        .user_agent(snow_net::http_client::app_user_agent())
        .timeout(Duration::from_secs(MODEL_FETCH_TIMEOUT_SECS));

    proxy_config
        .apply_blocking(builder)?
        .build()
        .map_err(|error| Error::from_reason(format!("Failed to create HTTP client: {}", error)))
}

fn build_header_map(headers: &HashMap<String, String>) -> Result<HeaderMap> {
    let mut header_map = HeaderMap::new();

    for (key, value) in headers {
        let header_name = key.parse::<HeaderName>().map_err(|error| {
            Error::from_reason(format!("Invalid header name '{}': {}", key, error))
        })?;
        let header_value = HeaderValue::from_str(value).map_err(|error| {
            Error::from_reason(format!("Invalid header value for '{}': {}", key, error))
        })?;
        header_map.insert(header_name, header_value);
    }

    Ok(header_map)
}

fn build_headers(
    api_key: &str,
    custom_headers: &HashMap<String, String>,
) -> HashMap<String, String> {
    let mut headers = HashMap::new();
    headers.insert("Content-Type".to_string(), "application/json".to_string());

    for (key, value) in custom_headers {
        headers.insert(key.clone(), value.clone());
    }

    headers.insert("Accept-Encoding".to_string(), "identity".to_string());

    if !api_key.is_empty() {
        headers.insert("Authorization".to_string(), format!("Bearer {}", api_key));
    }

    headers
}

fn parse_models_response(response: reqwest::blocking::Response) -> Result<Value> {
    let response_text = response.text().map_err(|error| {
        Error::from_reason(format!("Failed to read models response: {}", error))
    })?;

    let response_text = response_text
        .strip_prefix('\u{feff}')
        .unwrap_or(response_text.as_str());

    serde_json::from_str::<Value>(response_text)
        .map_err(|error| Error::from_reason(format!("Failed to parse models response: {}", error)))
}

fn optional_string(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(boolean) => Some(boolean.to_string()),
        _ => None,
    }
}

fn optional_timestamp(value: Option<&Value>) -> i64 {
    match value {
        Some(Value::Number(number)) => number
            .as_i64()
            .or_else(|| number.as_u64().and_then(|value| i64::try_from(value).ok()))
            .or_else(|| number.as_f64().map(|value| value as i64))
            .unwrap_or(0),
        Some(Value::String(text)) => {
            if let Ok(timestamp) = text.parse::<i64>() {
                return timestamp;
            }

            chrono::DateTime::parse_from_rfc3339(text)
                .map(|date_time| date_time.timestamp())
                .unwrap_or(0)
        }
        _ => 0,
    }
}

fn positive_integer(value: Option<&Value>) -> Option<i64> {
    let number = value?.as_i64().or_else(|| {
        value?
            .as_f64()
            .filter(|number| number.is_finite() && *number > 0.0)
            .map(|number| number as i64)
    })?;
    (number > 0).then_some(number)
}

fn first_positive_integer(object: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<i64> {
    keys.iter()
        .find_map(|key| positive_integer(object.get(*key)))
}

fn response_items<'a>(data: &'a Value, key: &str) -> Option<&'a Vec<Value>> {
    data.get(key)
        .and_then(Value::as_array)
        .or_else(|| data.as_array())
}

fn parse_openai_compatible_models(data: &Value) -> Vec<Model> {
    let Some(items) = response_items(data, "data") else {
        return Vec::new();
    };

    items
        .iter()
        .filter_map(|item| {
            let object = item.as_object()?;
            let id = optional_string(object.get("id").or_else(|| object.get("name")))?;

            Some(Model {
                id,
                object: optional_string(object.get("object").or_else(|| object.get("type")))
                    .unwrap_or_else(|| "model".to_string()),
                created: optional_timestamp(
                    object.get("created").or_else(|| object.get("created_at")),
                ),
                owned_by: optional_string(
                    object
                        .get("owned_by")
                        .or_else(|| object.get("owner"))
                        .or_else(|| object.get("provider")),
                )
                .unwrap_or_default(),
                context_length: first_positive_integer(object, CONTEXT_LIMIT_KEYS),
                max_output_tokens: first_positive_integer(object, OUTPUT_LIMIT_KEYS),
            })
        })
        .collect()
}

fn parse_gemini_models(data: &Value) -> Vec<Model> {
    let Some(items) = response_items(data, "models") else {
        return Vec::new();
    };

    items
        .iter()
        .filter_map(|item| {
            let object = item.as_object()?;
            let raw_id = optional_string(object.get("name").or_else(|| object.get("id")))?;
            let id = raw_id
                .strip_prefix("models/")
                .unwrap_or(raw_id.as_str())
                .to_string();

            Some(Model {
                id,
                object: "model".to_string(),
                created: optional_timestamp(
                    object.get("created").or_else(|| object.get("created_at")),
                ),
                owned_by: "google".to_string(),
                context_length: first_positive_integer(object, CONTEXT_LIMIT_KEYS),
                max_output_tokens: first_positive_integer(object, OUTPUT_LIMIT_KEYS),
            })
        })
        .collect()
}

fn parse_anthropic_models(data: &Value) -> Vec<Model> {
    let Some(items) = response_items(data, "data") else {
        return Vec::new();
    };

    items
        .iter()
        .filter_map(|item| {
            let object = item.as_object()?;
            let id = optional_string(object.get("id").or_else(|| object.get("name")))?;

            Some(Model {
                id,
                object: optional_string(object.get("type").or_else(|| object.get("object")))
                    .unwrap_or_else(|| "model".to_string()),
                created: optional_timestamp(
                    object.get("created_at").or_else(|| object.get("created")),
                ),
                owned_by: "anthropic".to_string(),
                context_length: first_positive_integer(object, CONTEXT_LIMIT_KEYS),
                max_output_tokens: first_positive_integer(object, OUTPUT_LIMIT_KEYS),
            })
        })
        .collect()
}

fn fetch_openai_models(
    models_url: &str,
    api_key: &str,
    custom_headers: &HashMap<String, String>,
) -> Result<Vec<Model>> {
    let client = create_models_http_client()?;
    let retry_options = RetryOptions::default();
    let data = with_retry_sync(
        || {
            let response = client
                .get(models_url)
                .headers(build_header_map(&build_headers(api_key, custom_headers))?)
                .send()
                .map_err(|error| {
                    Error::from_reason(format!("Failed to fetch models: {}", error))
                })?;

            if !response.status().is_success() {
                return Err(Error::from_reason(format!(
                    "Failed to fetch models: {} {}",
                    response.status(),
                    response.status().canonical_reason().unwrap_or("Unknown")
                )));
            }

            parse_models_response(response)
        },
        &retry_options,
        &RetryLogContext {
            func: "fetch_available_models",
            provider: "chat",
            request_method: "chat",
            endpoint: models_url,
        },
    )?;

    Ok(parse_openai_compatible_models(&data))
}
fn fetch_gemini_models(
    base_url: &str,
    api_key: &str,
    custom_headers: &HashMap<String, String>,
) -> Result<Vec<Model>> {
    if api_key.is_empty() {
        return Err(Error::from_reason("API key is required for Gemini API"));
    }

    let trimmed_base_url = normalize_base_url(base_url);
    let url = format!("{}/models?key={}", trimmed_base_url, api_key);

    let client = create_models_http_client()?;
    let retry_options = RetryOptions::default();
    let data = with_retry_sync(
        || {
            let response = client
                .get(&url)
                .headers(build_header_map(&build_headers("", custom_headers))?)
                .send()
                .map_err(|error| {
                    Error::from_reason(format!("Failed to fetch models: {}", error))
                })?;

            if !response.status().is_success() {
                return Err(Error::from_reason(format!(
                    "Failed to fetch models: {} {}",
                    response.status(),
                    response.status().canonical_reason().unwrap_or("Unknown")
                )));
            }

            parse_models_response(response)
        },
        &retry_options,
        &RetryLogContext {
            func: "fetch_available_models",
            provider: "gemini",
            request_method: "gemini",
            endpoint: &url,
        },
    )?;

    Ok(parse_gemini_models(&data))
}
fn fetch_anthropic_models(
    base_url: &str,
    api_key: &str,
    custom_headers: &HashMap<String, String>,
) -> Result<Vec<Model>> {
    if api_key.is_empty() {
        return Err(Error::from_reason("API key is required for Anthropic API"));
    }

    let trimmed_base_url = normalize_base_url(base_url);
    let url = format!("{}/models", trimmed_base_url);

    let mut headers = HashMap::new();
    headers.insert("Content-Type".to_string(), "application/json".to_string());

    for (key, value) in custom_headers {
        headers.insert(key.clone(), value.clone());
    }

    if !api_key.is_empty() {
        headers.insert("x-api-key".to_string(), api_key.to_string());
        headers.insert("Authorization".to_string(), format!("Bearer {}", api_key));
    }

    let client = create_models_http_client()?;
    let retry_options = RetryOptions::default();
    let data = with_retry_sync(
        || {
            let response = client
                .get(&url)
                .headers(build_header_map(&headers)?)
                .send()
                .map_err(|error| {
                    Error::from_reason(format!("Failed to fetch models: {}", error))
                })?;

            if !response.status().is_success() {
                return Err(Error::from_reason(format!(
                    "Failed to fetch models: {} {}",
                    response.status(),
                    response.status().canonical_reason().unwrap_or("Unknown")
                )));
            }

            parse_models_response(response)
        },
        &retry_options,
        &RetryLogContext {
            func: "fetch_available_models",
            provider: "anthropic",
            request_method: "anthropic",
            endpoint: &url,
        },
    )?;

    let anthropic_models = parse_anthropic_models(&data);
    if !anthropic_models.is_empty() {
        return Ok(anthropic_models);
    }

    Ok(parse_openai_compatible_models(&data))
}
#[napi(object)]
#[derive(Clone)]
pub struct ApiConfigForModels {
    pub base_url: String,
    pub base_url_mode: String,
    pub api_key: String,
    pub request_method: String,
    pub custom_header_scheme_id: String,
    pub config_json: Option<String>,
    /// 已保存档案的名称：OAuth 档案据此从库内读取最新 token，不信任渲染层快照。
    pub profile_name: Option<String>,
}

/// 已保存的 OAuth 档案：access token 由刷新流程在库内维护，渲染层快照可能早已过期。
/// 这里以库内记录为准，先刷新再拉取模型列表（与聊天请求路径保持一致）。
pub async fn resolve_saved_oauth_profile(
    mut config: ApiConfigForModels,
) -> Result<ApiConfigForModels> {
    let Some(profile_name) = config
        .profile_name
        .take()
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
    else {
        return Ok(config);
    };
    let saved = tokio::task::spawn_blocking(move || -> Result<Option<ApiConfigRecord>> {
        let database_path = ensure_database_file()?;
        Ok(api_configs_service::list_api_configs(&database_path)?
            .into_iter()
            .find(|record| record.profile_name == profile_name))
    })
    .await
    .map_err(|error| Error::from_reason(format!("Failed to load API profile: {error}")))??;

    let Some(saved) = saved else {
        return Ok(config);
    };
    if OAuthProfileMetadata::from_config_json(&saved.config_json).is_none()
        && !crate::oauth::plugin::is_plugin_profile(&saved.config_json)
    {
        return Ok(config);
    }
    let refreshed = oauth_provider::refresh_if_needed(saved).await?;
    config.api_key = refreshed.api_key;
    config.config_json = Some(refreshed.config_json);
    Ok(config)
}

/// 插件档案由插件 models 钩子提供列表；未提供钩子时返回 None，走通用拉取。
pub async fn fetch_plugin_models(config: &ApiConfigForModels) -> Result<Option<Vec<Model>>> {
    let Some(config_json) = config.config_json.as_deref() else {
        return Ok(None);
    };
    let Some((provider, ids)) = crate::oauth::plugin::fetch_models(
        config_json,
        &config.api_key,
        "",
        &config.base_url,
    )
    .await?
    else {
        return Ok(None);
    };
    let mut models = ids
        .into_iter()
        .map(|id| Model {
            id,
            object: "model".to_string(),
            created: 0,
            owned_by: provider.clone(),
            context_length: None,
            max_output_tokens: None,
        })
        .collect::<Vec<_>>();
    models.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(Some(models))
}

fn resolve_oauth_metadata(
    config: &ApiConfigForModels,
    base_url: &str,
) -> Option<OAuthProfileMetadata> {
    if config
        .config_json
        .as_deref()
        .is_some_and(crate::oauth::plugin::is_plugin_profile)
    {
        return None;
    }
    if let Some(metadata) = config
        .config_json
        .as_deref()
        .and_then(OAuthProfileMetadata::from_config_json)
    {
        return Some(metadata);
    }
    oauth_provider::detect_provider_from_base_url(base_url).map(|provider| OAuthProfileMetadata {
        provider,
        client_id: String::new(),
        refresh_token: String::new(),
        account_id: String::new(),
        email: String::new(),
        plan_type: String::new(),
        expires_at: 0,
    })
}

fn fetch_oauth_models(
    metadata: &OAuthProfileMetadata,
    base_url: &str,
    api_key: &str,
    custom_headers: &HashMap<String, String>,
) -> Result<Vec<Model>> {
    // OAuth 订阅渠道的模型列表与 API key 渠道使用同一套重试口径。
    let ids = with_retry_sync(
        || match metadata.provider {
            OAuthProviderId::Codex => codex_oauth::fetch_models_blocking(
                base_url,
                api_key,
                &metadata.account_id,
                custom_headers,
            ),
            OAuthProviderId::ChatGpt => {
                chatgpt_oauth::fetch_models_blocking(base_url, api_key, custom_headers)
            }
            OAuthProviderId::Anthropic => {
                anthropic_oauth::fetch_models_blocking(base_url, api_key, custom_headers)
            }
            OAuthProviderId::Antigravity => antigravity_oauth::fetch_models_blocking(
                base_url,
                api_key,
                &metadata.account_id,
                custom_headers,
            ),
            OAuthProviderId::Xai => {
                xai_oauth::fetch_models_blocking(base_url, api_key, custom_headers)
            }
        },
        &RetryOptions::default(),
        &RetryLogContext {
            func: "fetch_available_models",
            provider: metadata.provider.as_str(),
            request_method: "oauth",
            endpoint: base_url,
        },
    )?;
    Ok(ids
        .into_iter()
        .map(|id| Model {
            id,
            object: "model".to_string(),
            created: 0,
            owned_by: metadata.provider.as_str().to_string(),
            context_length: None,
            max_output_tokens: None,
        })
        .collect())
}

pub fn fetch_available_models(
    config: &ApiConfigForModels,
    custom_headers: &HashMap<String, String>,
) -> Result<Vec<Model>> {
    // A model listing belongs to no conversation: session-scoped header
    // placeholders (`{{session_id}}`) are dropped instead of sending the
    // literal template to the provider.
    let mut resolved_headers = custom_headers.clone();
    snow_text::text::expand_custom_header_session_id(&mut resolved_headers, "");
    let custom_headers = &resolved_headers;

    let base_url = normalize_base_url(&config.base_url);

    if base_url.is_empty() {
        return Err(Error::from_reason(
            "Base URL not configured. Please configure API settings first.",
        ));
    }

    if let Some(metadata) = resolve_oauth_metadata(config, &base_url) {
        let mut models =
            fetch_oauth_models(&metadata, &base_url, &config.api_key, custom_headers)?;
        models.sort_by(|a, b| a.id.cmp(&b.id));
        return Ok(models);
    }

    let is_default_base_url = base_url == DEFAULT_OPENAI_BASE_URL;

    let mut models = match config.request_method.as_str() {
        "gemini" | "interactions" => {
            let gemini_base_url = if is_default_base_url {
                DEFAULT_GEMINI_BASE_URL.to_string()
            } else {
                base_url.clone()
            };
            fetch_gemini_models(&gemini_base_url, &config.api_key, custom_headers)?
        }
        "anthropic" => {
            let anthropic_base_url = if is_default_base_url {
                DEFAULT_ANTHROPIC_BASE_URL.to_string()
            } else {
                base_url.clone()
            };
            fetch_anthropic_models(&anthropic_base_url, &config.api_key, custom_headers)?
        }
        _ => {
            let openai_base_url = if is_default_base_url {
                DEFAULT_OPENAI_BASE_URL.to_string()
            } else {
                base_url.clone()
            };
            fetch_openai_models(
                &resolve_models_endpoint(&openai_base_url, &config.base_url_mode),
                &config.api_key,
                custom_headers,
            )?
        }
    };

    models.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(models)
}

pub fn fetch_available_models_for_active_config() -> Result<Vec<Model>> {
    let context = get_active_api_request_context()?;
    let config = ApiConfigForModels {
        base_url: context.api_config.base_url,
        base_url_mode: context.api_config.base_url_mode,
        api_key: context.api_config.api_key,
        request_method: context.api_config.request_method,
        custom_header_scheme_id: context.api_config.custom_header_scheme_id,
        config_json: Some(context.api_config.config_json),
        profile_name: None,
    };

    fetch_available_models(&config, &context.custom_headers)
}

fn create_llm_specs_http_client() -> Option<Client> {
    let proxy_config = snow_net::http_client::load_proxy_config_sync().ok()?;
    let builder = Client::builder()
        .user_agent(snow_net::http_client::app_user_agent())
        .timeout(Duration::from_secs(LLM_SPECS_TIMEOUT_SECS));
    proxy_config.apply_blocking(builder).ok()?.build().ok()
}

/// 规范化模型 id：去掉渠道前缀与大小写差异，只保留可比较的主体。
fn normalize_model_id(value: &str) -> String {
    let lowered = value.trim().to_ascii_lowercase();
    let base = lowered.rsplit('/').next().unwrap_or(lowered.as_str());
    base.chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_'))
        .collect()
}

/// 两个模型 id 是否指同一模型（允许日期/版本后缀不同）。
fn model_ids_related(target: &str, candidate: &str) -> bool {
    if target == candidate {
        return true;
    }
    for (short, long) in [(target, candidate), (candidate, target)] {
        let Some(rest) = long.strip_prefix(short) else {
            continue;
        };
        if !rest.is_empty()
            && rest
                .chars()
                .all(|ch| ch.is_ascii_digit() || matches!(ch, '.' | '-' | '_'))
        {
            return true;
        }
    }
    false
}

fn model_limits_from_spec(value: &Value) -> ModelLimits {
    let context_length = positive_integer(value.get("max_input_tokens"))
        .or_else(|| positive_integer(value.get("context_window")))
        .or_else(|| positive_integer(value.get("context_length")));
    ModelLimits {
        context_length,
        max_output_tokens: positive_integer(value.get("max_output_tokens")),
    }
}

fn model_limits_empty(limits: &ModelLimits) -> bool {
    limits.context_length.is_none() && limits.max_output_tokens.is_none()
}

/// 查询公共模型规格数据源（llm-specs）。同步阻塞，调用方必须在阻塞线程中执行。
fn fetch_llm_spec_limits_blocking(model_id: &str) -> Option<ModelLimits> {
    let model_id = model_id.trim();
    if model_id.is_empty() {
        return None;
    }
    let client = create_llm_specs_http_client()?;

    let exact_url = format!(
        "{LLM_SPECS_BASE_URL}{LLM_SPECS_MODELS_PATH}/{}",
        model_id.trim_start_matches('/')
    );
    if let Ok(response) = client.get(&exact_url).send() {
        if response.status().is_success() {
            if let Ok(data) = parse_models_response(response) {
                let limits = model_limits_from_spec(&data);
                if !model_limits_empty(&limits) {
                    return Some(limits);
                }
            }
        }
    }

    // 精确 id 未命中（渠道前缀/日期后缀不同）时按模型名检索，只接受同一模型的变体。
    let base_name = model_id.rsplit('/').next().unwrap_or(model_id).trim();
    if base_name.is_empty() {
        return None;
    }
    let keyword: String = url::form_urlencoded::byte_serialize(base_name.as_bytes()).collect();
    let search_url = format!(
        "{LLM_SPECS_BASE_URL}{LLM_SPECS_MODELS_PATH}?q={keyword}&limit=20&fields=id,max_input_tokens,max_output_tokens"
    );
    let response = client.get(&search_url).send().ok()?;
    if !response.status().is_success() {
        return None;
    }
    let data = parse_models_response(response).ok()?;
    let items = data.get("data").and_then(Value::as_array)?;
    let target = normalize_model_id(model_id);
    for item in items {
        let Some(candidate) = item.get("id").and_then(Value::as_str) else {
            continue;
        };
        let limits = model_limits_from_spec(item);
        if model_limits_empty(&limits) {
            continue;
        }
        if model_ids_related(&target, &normalize_model_id(candidate)) {
            return Some(limits);
        }
    }
    None
}

pub async fn resolve_external_model_limits(model_id: &str) -> Option<ModelLimits> {
    let model_id = model_id.trim().to_string();
    if model_id.is_empty() {
        return None;
    }
    tokio::task::spawn_blocking(move || fetch_llm_spec_limits_blocking(&model_id))
        .await
        .ok()
        .flatten()
}

fn limits_from_catalog(models: &[Model], model_id: &str) -> Option<ModelLimits> {
    let target = model_id.trim();
    if target.is_empty() {
        return None;
    }
    let normalized = normalize_model_id(target);
    let model = models
        .iter()
        .find(|model| model.id.eq_ignore_ascii_case(target))
        .or_else(|| {
            models
                .iter()
                .find(|model| normalize_model_id(&model.id) == normalized)
        })?;
    let limits = ModelLimits {
        context_length: model.context_length,
        max_output_tokens: model.max_output_tokens,
    };
    if model_limits_empty(&limits) {
        return None;
    }
    Some(limits)
}

fn merge_limits(primary: Option<ModelLimits>, secondary: Option<ModelLimits>) -> Option<ModelLimits> {
    match (primary, secondary) {
        (Some(primary), Some(secondary)) => Some(ModelLimits {
            context_length: primary.context_length.or(secondary.context_length),
            max_output_tokens: primary.max_output_tokens.or(secondary.max_output_tokens),
        }),
        (primary, secondary) => primary.or(secondary),
    }
}

/// 解析某个模型在指定渠道下的上下文 / 输出上限：优先使用渠道模型清单自带的数值，
/// 缺失部分再查公共规格数据源。
pub async fn resolve_limits_for_config(
    config: &ApiConfigForModels,
    custom_headers: &HashMap<String, String>,
    model_id: &str,
) -> Option<ModelLimits> {
    let model_id = model_id.trim().to_string();
    if model_id.is_empty() {
        return None;
    }

    let catalog_config = config.clone();
    let catalog_headers = custom_headers.clone();
    let catalog_model_id = model_id.clone();
    let from_catalog = tokio::task::spawn_blocking(move || {
        fetch_available_models(&catalog_config, &catalog_headers)
    })
    .await
    .ok()
    .and_then(|result| result.ok())
    .and_then(|models| limits_from_catalog(&models, &catalog_model_id));

    let catalog_complete = from_catalog.as_ref().is_some_and(|limits| {
        limits.context_length.is_some() && limits.max_output_tokens.is_some()
    });
    if catalog_complete {
        return from_catalog;
    }

    let external = resolve_external_model_limits(&model_id).await;
    merge_limits(from_catalog, external)
}

const DEFAULT_AUTO_COMPRESS_THRESHOLD_PERCENT: i32 = 80;
const AUTO_COMPRESS_THRESHOLD_MIN_PERCENT: i32 = 30;
const AUTO_COMPRESS_THRESHOLD_MAX_PERCENT: i32 = 100;

/// 上下文窗口变化时按原百分比换算绝对压缩阈值，保持用户设置的压缩时机不变。
fn rescale_auto_compress_threshold(
    threshold: Option<i32>,
    previous_context: Option<i32>,
    next_context: i32,
) -> Option<i32> {
    let threshold = threshold?;
    if threshold <= 0 {
        return Some(threshold);
    }
    let percent = match previous_context {
        Some(previous) if previous > 0 => {
            if threshold <= AUTO_COMPRESS_THRESHOLD_MAX_PERCENT {
                threshold
            } else {
                ((threshold as f64 / previous as f64) * 100.0).round() as i32
            }
        }
        _ => DEFAULT_AUTO_COMPRESS_THRESHOLD_PERCENT,
    };
    let percent = percent.clamp(
        AUTO_COMPRESS_THRESHOLD_MIN_PERCENT,
        AUTO_COMPRESS_THRESHOLD_MAX_PERCENT,
    );
    Some(((next_context as i64 * percent as i64) / 100).max(1) as i32)
}

async fn load_api_profiles() -> Result<Vec<ApiConfigRecord>> {
    tokio::task::spawn_blocking(move || -> Result<Vec<ApiConfigRecord>> {
        let database_path = ensure_database_file()?;
        Ok(api_configs_service::list_api_configs(&database_path)?)
    })
    .await
    .map_err(|error| Error::from_reason(format!("Failed to load API profiles: {error}")))?
}

/// 把指定档案的上下文 / 输出上限同步到该模型（模型切换、设置页选择模型时调用）。
/// 返回写入后的完整档案列表；无法解析到模型规格时原样返回。
pub async fn sync_profile_model_limits(
    profile_name: &str,
    model_id: &str,
) -> Result<Vec<ApiConfigRecord>> {
    let profile_name = profile_name.trim().to_string();
    let model_id = model_id.trim().to_string();
    if profile_name.is_empty() || model_id.is_empty() {
        return load_api_profiles().await;
    }

    let profile = tokio::task::spawn_blocking({
        let profile_name = profile_name.clone();
        move || -> Result<Option<ApiConfigRecord>> {
            let database_path = ensure_database_file()?;
            Ok(api_configs_service::list_api_configs(&database_path)?
                .into_iter()
                .find(|record| record.profile_name == profile_name))
        }
    })
    .await
    .map_err(|error| Error::from_reason(format!("Failed to load API profile: {error}")))??;
    let Some(record) = profile else {
        return load_api_profiles().await;
    };

    let scheme_id = record.custom_header_scheme_id.clone();
    let custom_headers = tokio::task::spawn_blocking(move || -> Result<HashMap<String, String>> {
        let database_path = ensure_database_file()?;
        let schemes =
            snow_storage::custom_header_schemes::list_custom_header_schemes(&database_path)?;
        Ok(get_api_config_custom_headers(&schemes, &scheme_id))
    })
    .await
    .map_err(|error| Error::from_reason(format!("Failed to load custom headers: {error}")))??;

    let config = ApiConfigForModels {
        base_url: record.base_url.clone(),
        base_url_mode: record.base_url_mode.clone(),
        api_key: record.api_key.clone(),
        request_method: record.request_method.clone(),
        custom_header_scheme_id: record.custom_header_scheme_id.clone(),
        config_json: Some(record.config_json.clone()),
        profile_name: Some(record.profile_name.clone()),
    };
    let Some(limits) = resolve_limits_for_config(&config, &custom_headers, &model_id).await else {
        return load_api_profiles().await;
    };

    let next_context = limits
        .context_length
        .and_then(|value| i32::try_from(value).ok())
        .filter(|value| *value > 0);
    let next_max_tokens = limits
        .max_output_tokens
        .and_then(|value| i32::try_from(value).ok())
        .filter(|value| *value > 0);
    let context_changed = next_context.is_some() && next_context != record.max_context_tokens;
    let max_tokens_changed = next_max_tokens.is_some() && next_max_tokens != record.max_tokens;
    if !context_changed && !max_tokens_changed {
        return load_api_profiles().await;
    }

    let mut input = crate::oauth::provider::input_from_record(&record);
    if context_changed {
        if let Some(context) = next_context {
            input.max_context_tokens = Some(context);
            input.auto_compress_threshold = rescale_auto_compress_threshold(
                record.auto_compress_threshold,
                record.max_context_tokens,
                context,
            );
        }
    }
    if max_tokens_changed {
        input.max_tokens = next_max_tokens;
    }

    tokio::task::spawn_blocking(move || -> Result<()> {
        let database_path = ensure_database_file()?;
        api_configs_service::upsert_api_config(&database_path, &input)
    })
    .await
    .map_err(|error| Error::from_reason(format!("Failed to update API profile: {error}")))??;

    load_api_profiles().await
}

