//! Shared helper functions used by all API provider modules
//! (anthropic, chat, gemini, responses).
//!
//! These utilities were previously duplicated across each provider file.
//! Centralising them here eliminates maintenance burden and ensures
//! consistent behaviour (token counting, JSON traversal, chunk emission).

use std::collections::HashMap;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde_json::Value;

use crate::api::responses::{ResponsesApiStreamCallback, ResponsesApiStreamChunk};

// ---------------------------------------------------------------------------
// Stream chunk emission
// ---------------------------------------------------------------------------

/// Emit a streaming chunk to the JavaScript side via ThreadsafeFunction.
///
/// Only the delta strings are sent; the `content` and `thinking` fields are
/// left empty to avoid O(n²) data transfer. The renderer accumulates deltas
/// locally and the final complete text arrives via the resolved Promise.
///
/// `stream_token_count` is the cumulative token counter for the current
/// agent-loop iteration. The counter is mutated in place: each call adds the
/// token count of the delta text (content + thinking) so the renderer always
/// receives the up-to-date probe value.
pub(crate) fn emit_stream_chunk(
    on_chunk: &ResponsesApiStreamCallback,
    content_delta: String,
    thinking_delta: String,
    stream_token_count: &mut usize,
    elapsed_ms: i64,
    ttft_ms: i64,
) {
    if content_delta.is_empty() && thinking_delta.is_empty() {
        return;
    }

    // Count tokens for the delta text only. Using `encode_ordinary` avoids
    // treating substrings as special tokens, matching the JS `tiktoken`
    // `encode_ordinary` behavior used by Snow CLI.
    let delta_text = if content_delta.is_empty() {
        &thinking_delta
    } else if thinking_delta.is_empty() {
        &content_delta
    } else {
        // Combine both deltas for a single encode pass. This branch is rare
        // (current callers always pass one empty string), but we handle it
        // for correctness.
        let combined = format!("{content_delta}{thinking_delta}");
        let count = crate::api::token_counter::count_tokens(&combined);
        *stream_token_count += count;
        on_chunk.call(
            ResponsesApiStreamChunk {
                content_delta,
                thinking_delta,
                content: String::new(),
                thinking: String::new(),
                retrying: false,
                retry_attempt: None,
                retry_error: None,
                stream_token_count: *stream_token_count as i64,
                elapsed_ms,
                ttft_ms,
                vision_status: None,
            },
            ThreadsafeFunctionCallMode::NonBlocking,
        );
        return;
    };

    let count = crate::api::token_counter::count_tokens(delta_text);
    *stream_token_count += count;

    on_chunk.call(
        ResponsesApiStreamChunk {
            content_delta,
            thinking_delta,
            content: String::new(),
            thinking: String::new(),
            retrying: false,
            retry_attempt: None,
            retry_error: None,
            stream_token_count: *stream_token_count as i64,
            elapsed_ms,
            ttft_ms,
            vision_status: None,
        },
        ThreadsafeFunctionCallMode::NonBlocking,
    );
}

/// Emit a probe-only chunk that carries just the updated token count.
///
/// Used for tool-call argument deltas, where the argument text is assembled
/// separately and must NOT be appended to the assistant message body. The
/// probe still needs to update so the renderer reflects long tool arguments
/// in real time.
pub(crate) fn emit_tool_args_probe(
    on_chunk: &ResponsesApiStreamCallback,
    stream_token_count: &mut usize,
    args_delta: &str,
    elapsed_ms: i64,
    ttft_ms: i64,
) {
    if args_delta.is_empty() {
        return;
    }
    let count = crate::api::token_counter::count_tokens(args_delta);
    *stream_token_count += count;
    on_chunk.call(
        ResponsesApiStreamChunk {
            content_delta: String::new(),
            thinking_delta: String::new(),
            content: String::new(),
            thinking: String::new(),
            retrying: false,
            retry_attempt: None,
            retry_error: None,
            stream_token_count: *stream_token_count as i64,
            elapsed_ms,
            ttft_ms,
            vision_status: None,
        },
        ThreadsafeFunctionCallMode::NonBlocking,
    );
}

// ---------------------------------------------------------------------------
// JSON value helpers
// ---------------------------------------------------------------------------

/// Push a non-empty trimmed string from a JSON value into a chunk vector.
pub(crate) fn push_trimmed_string(value: Option<&Value>, chunks: &mut Vec<String>) {
    if let Some(text) = value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
    {
        chunks.push(text.to_string());
    }
}

/// Truncate a string to at most `max_bytes` bytes without splitting a UTF-8
/// character in half. Returns a slice of the original string; use `.to_string()`
/// if an owned value is needed.
///
/// Slicing `&value[..value.len().min(max_bytes)]` directly panics when the cut
/// lands inside a multi-byte character (e.g. CJK text), which can abort the
/// whole streaming task. This helper always walks back to a char boundary.
pub(crate) fn truncate_utf8_safe(value: &str, max_bytes: usize) -> &str {
    if value.len() <= max_bytes {
        return value;
    }
    let mut end = max_bytes;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}

/// Push reasoning/thinking text from a Chat Completions delta or message object
/// into a chunk vector, normalising the three field shapes providers emit:
///
/// - `reasoning_content` (DeepSeek official, plain string)
/// - `reasoning` (OpenRouter normalised, plain string)
/// - `reasoning_details` (OpenRouter structured array; each item may be a
///   `reasoning.text` / `reasoning.summary` block carrying a text-like field)
///
/// All three are checked so a single call works across DeepSeek-direct,
/// OpenRouter, and any provider that mimics either convention.
pub(crate) fn push_reasoning_text(value: Option<&Value>, chunks: &mut Vec<String>) {
    let Some(object) = value.and_then(Value::as_object) else {
        // Fallback: a bare string value (rare, but some relays do this).
        push_trimmed_string(value, chunks);
        return;
    };

    // 1. DeepSeek official field (also used as an alias by some relays).
    push_trimmed_string(object.get("reasoning_content"), chunks);

    // 2. OpenRouter normalised field. Checked after reasoning_content so that,
    //    if a provider emits both, the canonical DeepSeek value wins ordering
    //    (the two are semantically identical anyway).
    push_trimmed_string(object.get("reasoning"), chunks);

    // 3. OpenRouter structured reasoning_details array. Each item is one of:
    //    { "type": "reasoning.text",    "text": "..." }
    //    { "type": "reasoning.summary", "summary": "..." }
    //    { "type": "reasoning.encrypted", "data": "..." }  (ignored — opaque)
    if let Some(details) = object.get("reasoning_details").and_then(Value::as_array) {
        for detail in details {
            let detail_obj = match detail.as_object() {
                Some(obj) => obj,
                None => continue,
            };
            let item_type = detail_obj.get("type").and_then(Value::as_str).unwrap_or("");
            // Only harvest human-readable text; skip encrypted/redacted blobs.
            if item_type == "reasoning.encrypted" {
                continue;
            }
            push_trimmed_string(detail_obj.get("text"), chunks);
            push_trimmed_string(detail_obj.get("summary"), chunks);
        }
    }
}

/// Read a string field from a JSON object.
pub(crate) fn read_string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

/// Traverse a dotted path in a JSON value and return the leaf as `i64`.
pub(crate) fn read_path_i64(value: &Value, path: &[&str]) -> Option<i64> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    value_as_i64(current)
}

/// Convert a JSON value to `i64`, handling i64/u64/f64 representations.
pub(crate) fn value_as_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|number| i64::try_from(number).ok()))
        .or_else(|| value.as_f64().map(|number| number as i64))
}

/// Try multiple JSON paths and return the first positive `i64` value.
pub(crate) fn read_first_i64(value: &Value, paths: &[&[&str]]) -> i64 {
    paths
        .iter()
        .find_map(|path| read_path_i64(value, path).filter(|number| *number > 0))
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Header building
// ---------------------------------------------------------------------------

/// Inject custom user-supplied headers into a `HeaderMap`, skipping entries
/// whose key matches any of the `reserved_keys` (case-insensitive).
///
/// Each provider calls this after setting its own authentication headers,
/// passing the keys it manages internally so user headers cannot override
/// them.
pub(crate) fn inject_custom_headers(
    headers: &mut HeaderMap,
    custom_headers: &HashMap<String, String>,
    reserved_keys: &[&str],
) -> Result<()> {
    for (key, value) in custom_headers {
        let trimmed_key = key.trim();
        let trimmed_value = value.trim();
        if trimmed_key.is_empty() || trimmed_value.is_empty() {
            continue;
        }

        if reserved_keys
            .iter()
            .any(|reserved| trimmed_key.eq_ignore_ascii_case(reserved))
        {
            continue;
        }

        let header_name = trimmed_key.parse::<HeaderName>().map_err(|error| {
            Error::from_reason(format!(
                "Invalid custom header '{}': {}",
                trimmed_key, error
            ))
        })?;
        let header_value = HeaderValue::from_str(trimmed_value).map_err(|error| {
            Error::from_reason(format!(
                "Invalid custom header value for '{}': {}",
                trimmed_key, error
            ))
        })?;
        headers.insert(header_name, header_value);
    }
    Ok(())
}
