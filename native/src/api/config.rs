use std::collections::HashMap;
use std::path::PathBuf;

use napi::bindgen_prelude::*;
use reqwest::Url;
use serde_json::Value;

use crate::storage::{initialize_app_storage, ApiConfigRecord, CustomHeaderSchemeRecord};

pub const DEFAULT_OPENAI_BASE_URL: &str = "https://api.openai.com/v1";
pub const DEFAULT_GEMINI_BASE_URL: &str = "https://generativelanguage.googleapis.com/v1beta";
pub const DEFAULT_ANTHROPIC_BASE_URL: &str = "https://api.anthropic.com/v1";

pub struct ActiveApiRequestContext {
    pub database_path: PathBuf,
    pub api_config: ApiConfigRecord,
    pub custom_headers: HashMap<String, String>,
}

pub fn get_active_api_request_context() -> Result<ActiveApiRequestContext> {
    get_api_request_context_for_profile(None)
}

pub fn get_api_request_context_for_profile(
    profile_name: Option<&str>,
) -> Result<ActiveApiRequestContext> {
    let storage_info = initialize_app_storage()?;
    let database_path = PathBuf::from(storage_info.database_path);
    let mut configs = crate::storage::services::api_configs::list_api_configs(&database_path)?;
    if configs.is_empty() {
        return Err(Error::from_reason("No API configuration found"));
    }

    let requested_profile = profile_name
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let selected_index = if let Some(requested_profile) = requested_profile {
        configs
            .iter()
            .position(|config| config.profile_name == requested_profile)
            .ok_or_else(|| {
                Error::from_reason(format!(
                    "Sub-agent API profile is not available: {requested_profile}"
                ))
            })?
    } else {
        configs
            .iter()
            .position(|config| config.is_active)
            .unwrap_or(0)
    };
    let api_config = configs.remove(selected_index);

    let custom_header_schemes =
        crate::storage::services::custom_header_schemes::list_custom_header_schemes(
            &database_path,
        )?;
    let custom_headers =
        get_api_config_custom_headers(&custom_header_schemes, &api_config.custom_header_scheme_id);

    Ok(ActiveApiRequestContext {
        database_path,
        api_config,
        custom_headers,
    })
}

/// Resolves the API request context for a conversation-scoped profile with
/// graceful degradation:
///
/// 1. When `profile_name` is provided and exists, it is used.
/// 2. When `profile_name` is provided but no longer exists (e.g. the profile
///    was deleted while the conversation kept its binding), a warning is
///    logged and the global active profile is used as a fallback so the
///    conversation keeps working instead of failing hard.
/// 3. When `profile_name` is absent, the global active profile is used.
pub fn get_api_request_context_with_fallback(
    profile_name: Option<&str>,
) -> Result<ActiveApiRequestContext> {
    let trimmed_profile = profile_name
        .map(str::trim)
        .filter(|value| !value.is_empty());

    if let Some(trimmed_profile) = trimmed_profile {
        match get_api_request_context_for_profile(Some(trimmed_profile)) {
            Ok(context) => return Ok(context),
            Err(error) => {
                // Fall back to the global active profile and record the
                // degradation so the app log shows why the requested profile
                // was skipped.
                let fallback_result = get_api_request_context_for_profile(None);
                if fallback_result.is_ok() {
                    if let Ok(storage_info) = initialize_app_storage() {
                        let database_path = PathBuf::from(storage_info.database_path);
                        let _ = crate::storage::services::app_logs::insert_app_log(
                            &database_path,
                            &crate::storage::services::app_logs::AppLogInput {
                                level: "WARN".to_string(),
                                module: "api".to_string(),
                                func: "get_api_request_context_with_fallback".to_string(),
                                line: None,
                                message: format!(
                                    "Requested API profile '{trimmed_profile}' is unavailable; fell back to the global active profile"
                                ),
                                input: None,
                                output: None,
                                duration: None,
                                context: Some(format!("requested_profile={trimmed_profile}")),
                                error: Some(error.reason.clone()),
                                source: "main".to_string(),
                            },
                        );
                    }
                }
                return fallback_result;
            }
        }
    }

    get_api_request_context_for_profile(None)
}

pub fn get_active_custom_headers(schemes: &[CustomHeaderSchemeRecord]) -> HashMap<String, String> {
    schemes
        .iter()
        .find(|scheme| scheme.is_active)
        .map(parse_custom_headers)
        .unwrap_or_default()
}

pub fn get_api_config_custom_headers(
    schemes: &[CustomHeaderSchemeRecord],
    custom_header_scheme_id: &str,
) -> HashMap<String, String> {
    let scheme_id = custom_header_scheme_id.trim();

    if scheme_id == "__DISABLED__" {
        return HashMap::new();
    }

    if scheme_id.is_empty() {
        return get_active_custom_headers(schemes);
    }

    schemes
        .iter()
        .find(|scheme| scheme.scheme_id == scheme_id)
        .map(parse_custom_headers)
        .unwrap_or_default()
}

fn parse_custom_headers(scheme: &CustomHeaderSchemeRecord) -> HashMap<String, String> {
    let Ok(parsed) = serde_json::from_str::<Value>(&scheme.headers_json) else {
        return HashMap::new();
    };

    let Some(object) = parsed.as_object() else {
        return HashMap::new();
    };

    object
        .iter()
        .filter_map(|(key, value)| value.as_str().map(|value| (key.clone(), value.to_string())))
        .collect()
}

pub fn normalize_base_url(base_url: &str) -> String {
    base_url.trim().trim_end_matches('/').to_string()
}

pub fn resolve_models_endpoint(base_url: &str, base_url_mode: &str) -> String {
    let normalized_base_url = normalize_base_url(base_url);

    if base_url_mode == "endpoint" {
        return normalized_base_url;
    }

    if base_url_mode == "auto" && is_models_endpoint(&normalized_base_url) {
        return normalized_base_url;
    }

    let base_for_append = if base_url_mode == "auto" || base_url_mode == "custom" {
        strip_known_endpoint_suffix(&normalized_base_url).unwrap_or(normalized_base_url)
    } else {
        normalized_base_url
    };

    append_models_endpoint(&base_for_append)
}

pub fn resolve_sdk_api_base_url(base_url: &str, base_url_mode: &str) -> String {
    let normalized_base_url = normalize_base_url(base_url);

    if normalized_base_url.is_empty() {
        return normalized_base_url;
    }

    if base_url_mode == "endpoint" || base_url_mode == "auto" || base_url_mode == "custom" {
        return strip_known_endpoint_suffix(&normalized_base_url).unwrap_or(normalized_base_url);
    }

    normalized_base_url
}

fn append_models_endpoint(base_url: &str) -> String {
    format!("{}/models", normalize_base_url(base_url))
}

fn is_models_endpoint(base_url: &str) -> bool {
    get_normalized_pathname(base_url)
        .map(|pathname| pathname.ends_with("/models"))
        .unwrap_or(false)
}

fn strip_known_endpoint_suffix(base_url: &str) -> Option<String> {
    let mut url = Url::parse(base_url).ok()?;
    let pathname = normalize_pathname(url.path());
    let known_suffix = get_known_endpoint_suffix(&pathname)?;
    let next_pathname = pathname
        .strip_suffix(known_suffix)
        .filter(|value| !value.is_empty())
        .unwrap_or("/");

    url.set_path(next_pathname);
    url.set_query(None);
    url.set_fragment(None);

    Some(normalize_base_url(url.as_str()))
}

fn get_known_endpoint_suffix(pathname: &str) -> Option<&str> {
    for suffix in ["/chat/completions", "/responses", "/messages", "/models"] {
        if pathname.ends_with(suffix) {
            return Some(suffix);
        }
    }

    if let Some(index) = pathname.find("/models/") {
        if pathname.ends_with(":streamGenerateContent") {
            return Some(&pathname[index..]);
        }
    }

    None
}

fn get_normalized_pathname(base_url: &str) -> Option<String> {
    Url::parse(base_url)
        .ok()
        .map(|url| normalize_pathname(url.path()))
}

fn normalize_pathname(pathname: &str) -> String {
    let trimmed = pathname.trim_end_matches('/');
    if trimmed.is_empty() {
        "/".to_string()
    } else {
        trimmed.to_string()
    }
}
