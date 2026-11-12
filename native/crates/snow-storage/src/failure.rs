//! The only provider-failure diagnostic boundary: redact before UTF-8 limits.
use std::{future::Future, path::Path};

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use snow_text::text::truncate_utf8_safe;
use snow_storage_core::app_logs::{insert_app_log, AppLogInput};

tokio::task_local! {
    // Request-local only; not inherited by unrelated requests or blocking logs.
    static FAILURE_API_KEY: String;
}

pub async fn with_api_key<T>(api_key: &str, future: impl Future<Output = T>) -> T {
    FAILURE_API_KEY.scope(api_key.to_string(), future).await
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProviderFailure {
    pub message: Option<String>,
    pub code: Option<String>,
    #[serde(rename = "type")]
    pub error_type: Option<String>,
}

impl ProviderFailure {
    pub(crate) fn normalize(&self, api_key: Option<&str>) -> Self {
        let field = |value: &Option<String>, limit| {
            value
                .as_deref()
                .map(|text| bounded_provider_detail(text, limit, api_key))
                .filter(|text| !text.is_empty())
        };
        Self {
            message: field(&self.message, 768),
            code: field(&self.code, 128),
            error_type: field(&self.error_type, 128),
        }
    }

    pub fn from_message(message: &str, api_key: Option<&str>) -> Self {
        Self {
            message: Some(message.to_string()),
            ..Self::default()
        }
        .normalize(api_key)
    }

    pub fn from_event(event: &Value, api_key: Option<&str>) -> Self {
        let response = event.get("response").unwrap_or(event);
        let mut details = Vec::new();
        for root in [response.get("error"), event.get("error")]
            .into_iter()
            .flatten()
        {
            let mut current = Some(root);
            while let Some(detail) = current.filter(|value| !value.is_null()) {
                details.push((detail, true));
                current = detail.get("error");
            }
        }
        details.extend([(response, false), (event, false)]);
        let field = |key, errors_only| {
            details.iter().find_map(|(detail, is_error)| {
                if errors_only && !is_error {
                    return None;
                }
                detail.get(key).and_then(|value| match value {
                    Value::String(text) if !text.trim().is_empty() => Some(text.clone()),
                    Value::Number(number) => Some(number.to_string()),
                    _ => None,
                })
            })
        };
        Self {
            message: details.iter().find_map(|(detail, _)| {
                detail
                    .as_str()
                    .or_else(|| detail.get("message").and_then(Value::as_str))
                    .filter(|text| !text.trim().is_empty())
                    .map(str::to_string)
            }),
            code: field("code", false),
            error_type: field("type", true),
        }
        .normalize(api_key)
    }

    pub fn reason(&self) -> Option<String> {
        let mut parts: Vec<&str> = Vec::new();
        for part in [
            self.message.as_deref(),
            self.code.as_deref(),
            self.error_type.as_deref(),
        ]
        .into_iter()
        .flatten()
        .filter(|part| !part.is_empty())
        {
            if !parts.contains(&part) {
                parts.push(part);
            }
        }
        (!parts.is_empty()).then(|| parts.join(" / "))
    }

    pub fn raw_json(&self) -> String {
        json!({"providerFailure": self.normalize(None)}).to_string()
    }
}

pub(crate) fn failure_reason_from_raw(raw: &str) -> Option<String> {
    let parsed: Value = serde_json::from_str(raw).ok()?;
    let failure: ProviderFailure =
        serde_json::from_value(parsed.get("providerFailure")?.clone()).ok()?;
    failure.normalize(None).reason()
}

pub(crate) fn failure_raw_json(message: &str) -> String {
    ProviderFailure::from_message(message, None).raw_json()
}

/// A single non-fatal structured terminal log. Never receives body/tool data.
#[allow(clippy::too_many_arguments)]
pub async fn log_stream_failure(
    database_path: &Path,
    conversation_id: &str,
    response_id: &str,
    provider: &str,
    status: &str,
    failure: Option<&ProviderFailure>,
    counts: Value,
) {
    if snow_runtime::ephemeral::is_active() {
        return;
    }
    let count = |name| {
        counts
            .get(name)
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .min(i64::MAX as u64)
    };
    let context = json!({
        "conversation_id": conversation_id, "response_id": response_id,
        "provider": provider, "status": status,
        "failure": failure.cloned().unwrap_or_default().normalize(None),
        "content_chars": count("content_chars"), "thinking_chars": count("thinking_chars"),
        "duration_ms": count("duration_ms"), "retry_attempts": count("retry_attempts"),
    })
    .to_string();
    let database_path = database_path.to_path_buf();
    let _ = tokio::task::spawn_blocking(move || {
        let _ = insert_app_log(
            &database_path,
            &AppLogInput {
                level: "ERROR".to_string(),
                module: "api".to_string(),
                func: "response_stream".to_string(),
                line: None,
                message: "AI response stream failed".to_string(),
                input: None,
                output: None,
                duration: None,
                context: Some(context),
                error: None,
                source: "main".to_string(),
            },
        );
    })
    .await;
}

pub fn bounded_provider_detail(
    value: &str,
    max_bytes: usize,
    api_key: Option<&str>,
) -> String {
    // Exact credentials must disappear before truncation can split them.
    let exact_redacted = if let Some(key) = api_key.filter(|key| !key.is_empty()) {
        value.replace(key, "[REDACTED]")
    } else {
        FAILURE_API_KEY
            .try_with(|key| {
                if key.is_empty() {
                    value.to_string()
                } else {
                    value.replace(key, "[REDACTED]")
                }
            })
            .unwrap_or_else(|_| value.to_string())
    };
    // Redact first: collapsing whitespace would erase HTTP header boundaries.
    let redacted = redact_provider_detail(&exact_redacted)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    // Reapply after folding lines so stored/read-back diagnostics are stable.
    // Header redaction may now conservatively consume the remaining safe tail.
    let redacted = redact_provider_detail(&redacted);
    if redacted.len() <= max_bytes {
        return redacted;
    }
    let visible = truncate_utf8_safe(&redacted, max_bytes.saturating_sub(3));
    format!("{visible}...")
}

fn redact_provider_detail(value: &str) -> String {
    const PATTERNS: &[(&str, &str)] = &[
        // URLs can hide secrets in paths, userinfo, arbitrary query names or fragments.
        (r#"(?i)\b(?:https?|wss?)://[^\s\"'<>]+"#, "[REDACTED URL]"),
        // Do not retain unrecognized structured request/exception echoes.
        (r"(?s)\{.*", "[REDACTED OBJECT]"),
        (r#"(?s)\[\s*[\"'{\[].*"#, "[REDACTED ARRAY]"),
        (r#"[?&][^\s\"'<>]+"#, "[REDACTED QUERY]"),
        // Sensitive HTTP headers include the full authentication value and
        // every cookie pair, including folded lines and unknown auth schemes.
        // Without a trustworthy line boundary, discard the entire remainder.
        (
            r#"(?im)(\b(?:proxy-authorization|authorization|set-cookie|cookie)\b(?:\\?[\"'])?[ \t]*[:=][ \t]*)[^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*"#,
            "${1}[REDACTED]",
        ),
        // Never echo structured request bodies or encrypted reasoning fragments.
        (
            r#"(?is)(\b(?:encrypted[_-]?content|encrypted[_-]?reasoning|request[_-]?body|request|headers?|messages|system[_-]?prompt|body|payload|prompt|input|contents?)\b(?:\\?[\"'])?[ \t]*[:=][ \t]*).*"#,
            "${1}[REDACTED]",
        ),
        (r"\bsk-[A-Za-z0-9_-]{16,}\b", "[REDACTED]"),
        (
            r"\b(?:ya29\.[A-Za-z0-9._~-]{12,}|gAAAAA[A-Za-z0-9_-]{24,})\b",
            "[REDACTED]",
        ),
        (
            r"\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b",
            "[REDACTED]",
        ),
        (r"(?i)(https?://)[^/\s@]+:[^/\s@]+@", "${1}[REDACTED]@"),
        (
            r"(?i)\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{4,}",
            "${1} [REDACTED]",
        ),
        (
            r#"(?i)([?&](?:api[_-]?key|key|token|access[_-]?token|refresh[_-]?token|secret|password|authorization|signature)=)[^&\s\"'<>]+"#,
            "${1}[REDACTED]",
        ),
        (
            r#"(?i)([\"']?(?:api[_-]?key|token|access[_-]?token|refresh[_-]?token|secret|password|authorization)[\"']?\s*[:=]\s*[\"'])([^\"']*)([\"'])"#,
            "${1}[REDACTED]${3}",
        ),
        (
            r#"(?i)(\b(?:api[_-]?key|token|access[_-]?token|refresh[_-]?token|secret|password|authorization)\b\s*[:=]\s*)[^\s,;&}\]\"'\[]+"#,
            "${1}[REDACTED]",
        ),
    ];

    PATTERNS
        .iter()
        .fold(value.to_string(), |redacted, (pattern, replacement)| {
            Regex::new(pattern)
                .expect("provider redaction regex")
                .replace_all(&redacted, *replacement)
                .into_owned()
        })
}
