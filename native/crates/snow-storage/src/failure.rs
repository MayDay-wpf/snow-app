//! Provider-failure diagnostics. AI responses are kept verbatim (no redaction, no truncation).
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use snow_storage_core::app_logs::{insert_app_log, AppLogInput};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProviderFailure {
    pub message: Option<String>,
    pub code: Option<String>,
    #[serde(rename = "type")]
    pub error_type: Option<String>,
}

impl ProviderFailure {
    pub(crate) fn normalize(&self) -> Self {
        let field = |value: &Option<String>| {
            value
                .as_deref()
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(str::to_string)
        };
        Self {
            message: field(&self.message),
            code: field(&self.code),
            error_type: field(&self.error_type),
        }
    }

    pub fn from_message(message: &str) -> Self {
        Self {
            message: Some(message.to_string()),
            ..Self::default()
        }
        .normalize()
    }

    pub fn from_event(event: &Value) -> Self {
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
        .normalize()
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
        json!({"providerFailure": self.normalize()}).to_string()
    }
}

pub(crate) fn failure_reason_from_raw(raw: &str) -> Option<String> {
    let parsed: Value = serde_json::from_str(raw).ok()?;
    let failure: ProviderFailure =
        serde_json::from_value(parsed.get("providerFailure")?.clone()).ok()?;
    failure.normalize().reason()
}

pub(crate) fn failure_raw_json(message: &str) -> String {
    ProviderFailure::from_message(message).raw_json()
}

/// A single non-fatal structured terminal log. Never receives request body/tool data.
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
        "failure": failure.cloned().unwrap_or_default().normalize(),
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
