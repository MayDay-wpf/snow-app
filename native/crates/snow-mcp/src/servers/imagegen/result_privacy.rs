//! Mask free text without rewriting routing identifiers or image references.

use super::*;

pub(super) fn redact_text(text: &str, settings: Option<&ImageGenSettings>) -> String {
    let mut text = text.to_string();
    if let Some(settings) = settings {
        for channel in &settings.channels {
            let key = channel.api_key.trim();
            if !key.is_empty() {
                text = text.replace(key, "[REDACTED]");
                let encoded: String =
                    url::form_urlencoded::byte_serialize(key.as_bytes()).collect();
                text = text.replace(&encoded, "[REDACTED]");
            }
        }
    }
    for (pattern, replacement) in [
        (r#"(?i)https?://[^\s<>\"']+"#, "[endpoint]"),
        (
            r"(?i)\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+",
            "[REDACTED]",
        ),
        (r"\bsk-[A-Za-z0-9_-]{16,}\b", "[REDACTED]"),
        (
            r#"(?im)\b(?:authorization|cookie|set-cookie|x-goog-api-key|api[_-]?key|access[_-]?token|secret|password)\b[\"']?\s*[:=]\s*[^\r\n]+"#,
            "[REDACTED]",
        ),
    ] {
        if let Ok(regex) = regex::Regex::new(pattern) {
            text = regex.replace_all(&text, replacement).into_owned();
        }
    }
    text
}

pub(super) fn safe_error(error: &napi::Error, settings: Option<&ImageGenSettings>) -> String {
    if error.reason.starts_with("panic from Rust code:") {
        return "Image generation stopped after a native worker failure.".to_string();
    }
    redact_text(&error.reason, settings)
        .chars()
        .take(1200)
        .collect()
}

pub(super) async fn mask_result(
    mut result: Value,
    settings: Option<&ImageGenSettings>,
) -> napi::Result<Value> {
    // Only model-visible natural language goes through the free-text privacy API.
    // JSON, UUIDs, paths, URLs, base64 and MIME types stay independently parseable.
    for field in [
        "prompt",
        "contentPreview",
        "error",
        "message",
        "revisedPrompt",
        "revised_prompt",
    ] {
        if let Some(text) = result.get(field).and_then(Value::as_str) {
            let redacted = redact_text(text, settings);
            let masked = crate::mcp::privacy_mask::mask_tool_result_if_needed(
                "imagegen-generate",
                &redacted,
            )
            .await?;
            result[field] = json!(redact_text(&masked, settings));
        }
    }
    if let Some(content) = result.get_mut("content").and_then(Value::as_array_mut) {
        for block in content {
            for field in ["text", "revisedPrompt", "revised_prompt"] {
                if let Some(text) = block.get(field).and_then(Value::as_str) {
                    let redacted = redact_text(text, settings);
                    let masked = crate::mcp::privacy_mask::mask_tool_result_if_needed(
                        "imagegen-generate",
                        &redacted,
                    )
                    .await?;
                    block[field] = json!(redact_text(&masked, settings));
                }
            }
        }
    }
    Ok(result)
}
