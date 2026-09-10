use serde_json::{json, Value};

use crate::api::token_counter::{count_tokens, count_tokens_bounded, truncate_to_token_prefix};

const DEFAULT_TOOL_RESULT_LIMIT_PERCENT: usize = 30;
const DEFAULT_MAX_CONTEXT_TOKENS: usize = 256_000;
const TRUNCATION_BUDGET_TOLERANCE: usize = 4;
const TRUNCATION_MAX_ROUNDS: usize = 3;

pub async fn limit_tool_result(tool_full_name: &str, serialized: String) -> String {
    if should_skip_limit(tool_full_name, &serialized) {
        return serialized;
    }

    let (max_context_tokens, limit_percent) = load_limits().await;
    let max_result_tokens = (max_context_tokens.saturating_mul(limit_percent) / 100).max(1);

    if serialized.len() <= max_result_tokens {
        return serialized;
    }

    tokio::task::spawn_blocking(move || {
        apply_result_limit(serialized, max_result_tokens, limit_percent)
    })
    .await
    .unwrap_or_else(|error| {
        json!({
            "truncated": true,
            "truncationMessage": format!("Tool result token limiting failed: {error}"),
            "content": ""
        })
        .to_string()
    })
}

fn apply_result_limit(
    serialized: String,
    max_result_tokens: usize,
    limit_percent: usize,
) -> String {
    let measured = count_tokens_bounded(&serialized, max_result_tokens);
    if !measured.exceeded {
        return serialized;
    }

    let estimated_tokens = measured.estimated_total();
    let message = format!(
        "Tool result truncated: about {estimated_tokens} tokens exceeded the {max_result_tokens}-token limit ({limit_percent}% of the model context). Please narrow the scope, reduce the requested range, or paginate the request and try again."
    );

    truncate_result(&serialized, &message, estimated_tokens, max_result_tokens)
}

async fn load_limits() -> (usize, usize) {
    let context = tokio::task::spawn_blocking(crate::api::config::get_active_api_request_context)
        .await
        .ok()
        .and_then(Result::ok);

    let Some(context) = context else {
        return (DEFAULT_MAX_CONTEXT_TOKENS, DEFAULT_TOOL_RESULT_LIMIT_PERCENT);
    };

    let snowcfg = serde_json::from_str::<Value>(&context.api_config.config_json)
        .ok()
        .and_then(|value| value.get("snowcfg").cloned())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();

    let max_context_tokens = context
        .api_config
        .max_context_tokens
        .and_then(|value| usize::try_from(value).ok())
        .filter(|value| *value > 0)
        .or_else(|| {
            snowcfg
                .get("maxContextTokens")
                .and_then(Value::as_i64)
                .and_then(|value| usize::try_from(value).ok())
                .filter(|value| *value > 0)
        })
        .unwrap_or(DEFAULT_MAX_CONTEXT_TOKENS);

    let limit_percent = snowcfg
        .get("toolResultTokenLimit")
        .and_then(Value::as_i64)
        .and_then(|value| usize::try_from(value).ok())
        .map(|value| value.clamp(1, 100))
        .unwrap_or(DEFAULT_TOOL_RESULT_LIMIT_PERCENT);

    (max_context_tokens, limit_percent)
}

fn should_skip_limit(tool_full_name: &str, serialized: &str) -> bool {
    if matches!(tool_full_name, "imagegen-generate" | "imagegen-image-describe") {
        return true;
    }

    let may_carry_image = serialized.contains("isImage")
        || serialized.contains("mimeType")
        || serialized.contains("@@image:")
        || serialized.contains("data:image/");
    if !may_carry_image {
        return false;
    }

    serde_json::from_str::<Value>(serialized)
        .map(|value| contains_image_content(&value))
        .unwrap_or_else(|_| {
            serialized.contains("@@image:")
                || serialized.contains("data:image/")
                || serialized.contains("\"mimeType\":\"image/")
        })
}

fn contains_image_content(value: &Value) -> bool {
    match value {
        Value::Array(items) => items.iter().any(contains_image_content),
        Value::Object(object) => {
            if object
                .get("isImage")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                return true;
            }

            if object
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(|value| value.eq_ignore_ascii_case("image"))
                && object
                    .get("mimeType")
                    .and_then(Value::as_str)
                    .is_some_and(|value| value.starts_with("image/"))
            {
                return true;
            }

            object.values().any(contains_image_content)
        }
        Value::String(value) => {
            value.contains("@@image:") || value.starts_with("data:image/")
        }
        _ => false,
    }
}

fn truncate_result(
    serialized: &str,
    message: &str,
    original_tokens: usize,
    max_result_tokens: usize,
) -> String {
    let Ok(Value::Object(mut object)) = serde_json::from_str::<Value>(serialized) else {
        return fallback_result(serialized, message, original_tokens, max_result_tokens);
    };
    let Some(content) = object.get("content").and_then(Value::as_str).map(str::to_owned) else {
        return fallback_result(serialized, message, original_tokens, max_result_tokens);
    };

    object.insert("truncated".to_string(), Value::Bool(true));
    object.insert(
        "truncationMessage".to_string(),
        Value::String(message.to_string()),
    );
    object.insert(
        "originalTokenCount".to_string(),
        Value::from(original_tokens),
    );
    object.insert("tokenLimit".to_string(), Value::from(max_result_tokens));
    object.insert("content".to_string(), Value::String(String::new()));

    let base_tokens = serde_json::to_string(&Value::Object(object.clone()))
        .map(|value| count_tokens(&value))
        .unwrap_or(max_result_tokens);
    let mut content_budget = max_result_tokens.saturating_sub(base_tokens);

    for _ in 0..TRUNCATION_MAX_ROUNDS {
        let (piece, _) = truncate_to_token_prefix(&content, content_budget);
        object.insert("content".to_string(), Value::String(piece));

        let Ok(candidate) = serde_json::to_string(&Value::Object(object.clone())) else {
            return fallback_result(serialized, message, original_tokens, max_result_tokens);
        };
        let candidate_tokens = count_tokens(&candidate);
        if candidate_tokens <= max_result_tokens {
            return candidate;
        }
        content_budget = content_budget.saturating_sub(
            candidate_tokens
                .saturating_sub(max_result_tokens)
                .saturating_add(TRUNCATION_BUDGET_TOLERANCE),
        );
    }

    serde_json::to_string(&Value::Object(object))
        .unwrap_or_else(|_| fallback_result(serialized, message, original_tokens, max_result_tokens))
}

fn fallback_result(
    serialized: &str,
    message: &str,
    original_tokens: usize,
    max_result_tokens: usize,
) -> String {
    let mut result = json!({
        "truncated": true,
        "truncationMessage": message,
        "originalTokenCount": original_tokens,
        "tokenLimit": max_result_tokens,
        "content": "",
    });
    let base_tokens = crate::api::token_counter::count_tokens(&result.to_string());
    let content_budget = max_result_tokens.saturating_sub(base_tokens);
    let (piece, _) = truncate_to_token_prefix(serialized, content_budget);
    result["content"] = Value::String(piece);
    serde_json::to_string(&result).unwrap_or_else(|_| message.to_string())
}
