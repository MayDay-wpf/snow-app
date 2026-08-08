//! Privacy masking module — Rust native implementation.
//!
//! Ports the local-rule masking logic from snow-cli's `source/api/privacyMask.ts`.
//! Because Snow App's filesystem-read and terminal-execute tools run entirely
//! inside the Rust MCP backend, the masking layer must also live in Rust so
//! sensitive data is redacted before it ever crosses the NAPI boundary back to
//! Node.js / Electron.
//!
//! The module supports two modes mirroring the CLI:
//! - `local`: pure-Rust regex + checksum validation, no external dependency.
//! - `api`: POSTs the text to a configured privacy-filter HTTP endpoint and
//!   falls back to local rules on any error.
//!
//! All public entry points are async and run regex/HTTP work via
//! `spawn_blocking` or `reqwest`'s async runtime so the Node.js event loop is
//! never blocked.

use std::collections::BTreeSet;

use napi::bindgen_prelude::*;
use regex::Regex;
use serde_json::{json, Value};

use crate::storage::services::privacy_settings::PrivacySettings;

type ApiResult<T> = std::result::Result<T, String>;

/// Matches returned by the local rule engine. Byte offsets are used so the
/// merger can safely operate on the original `String` without re-validating
/// UTF-8 boundaries.
struct SensitiveMatch {
    start: usize,
    end: usize,
    match_type: String,
    confidence: f64,
}

struct DirectSecretPattern {
    pattern: Regex,
    match_type: &'static str,
    confidence: f64,
}

fn direct_secret_patterns() -> Vec<DirectSecretPattern> {
    vec![
        DirectSecretPattern {
            pattern: Regex::new(
                r"(?s)-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----.*?-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----",
            )
            .unwrap(),
            match_type: "private_key_block",
            confidence: 1.0,
        },
        DirectSecretPattern {
            pattern: Regex::new(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b").unwrap(),
            match_type: "jwt",
            confidence: 0.95,
        },
        DirectSecretPattern {
            pattern: Regex::new(r"\bsk-[A-Za-z0-9_-]{12,}\b").unwrap(),
            match_type: "api_key",
            confidence: 0.95,
        },
        DirectSecretPattern {
            pattern: Regex::new(r"\bAIza[0-9A-Za-z_-]{20,}\b").unwrap(),
            match_type: "api_key",
            confidence: 0.95,
        },
        DirectSecretPattern {
            pattern: Regex::new(r"\bgithub_pat_[A-Za-z0-9_]{22,}\b").unwrap(),
            match_type: "api_key",
            confidence: 0.95,
        },
        DirectSecretPattern {
            pattern: Regex::new(r"\bgh[opsru]_[A-Za-z0-9]{20,}\b").unwrap(),
            match_type: "api_key",
            confidence: 0.95,
        },
        DirectSecretPattern {
            pattern: Regex::new(r"\bxox[abprs]-[A-Za-z0-9-]{12,}\b").unwrap(),
            match_type: "api_key",
            confidence: 0.95,
        },
        DirectSecretPattern {
            pattern: Regex::new(r"\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b").unwrap(),
            match_type: "api_key",
            confidence: 0.95,
        },
        DirectSecretPattern {
            pattern: Regex::new(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b").unwrap(),
            match_type: "api_key",
            confidence: 0.9,
        },
        DirectSecretPattern {
            pattern: Regex::new(r"\bsnow-[A-Za-z0-9_-]{12,}\b").unwrap(),
            match_type: "api_key",
            confidence: 0.95,
        },
    ]
}

const SENSITIVE_KEY_NAME_PATTERN: &str = r"(?:api[_-]?key|openai[_-]?api[_-]?key|anthropic[_-]?api[_-]?key|gemini[_-]?api[_-]?key|google[_-]?api[_-]?key|x-api-key|x-api-token|token|access[_-]?token|refresh[_-]?token|id[_-]?token|secret|client[_-]?secret|password|passwd|pwd|authorization|cookie|session[_-]?(?:id|token|key)|access[_-]?key|secret[_-]?key|private[_-]?key|webhook[_-]?secret|signing[_-]?secret)";

fn quoted_context_pattern() -> Regex {
    let pattern = format!(
        r#"['"]?({})['"]?\s*(?:=|:)\s*(?:'([^'\r\n]+)'|"([^"\r\n]+)"|`([^`\r\n]+)`)"#,
        SENSITIVE_KEY_NAME_PATTERN
    );
    Regex::new(&pattern).unwrap()
}

fn unquoted_context_pattern() -> Regex {
    let pattern = format!(
        r#"['"]?({})['"]?\s*(?:=|:)\s*([^\s,;#{{}}\]'"`]+)"#,
        SENSITIVE_KEY_NAME_PATTERN
    );
    Regex::new(&pattern).unwrap()
}

fn cli_option_pattern() -> Regex {
    Regex::new(
        r#"(?i)(\B--(?:api-key|token|access-token|refresh-token|client-secret|secret|password)\s+)(?:'([^'\s]+)'|"([^"\s]+)"|`([^`\s]+)`|([^`'"\s]+))"#,
    )
    .unwrap()
}

fn authorization_pattern() -> Regex {
    Regex::new(r"(?i)(\b(?:Bearer|Basic)\s+)([A-Za-z0-9._~+/=-]{12,})\b").unwrap()
}

fn url_query_pattern() -> Regex {
    Regex::new(
        r"(?i)([?&](api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|client[_-]?secret|signature|x-amz-signature|sig)=)([^&#\s]+)",
    )
    .unwrap()
}

fn china_id_pattern() -> Regex {
    Regex::new(
        r"(?i)\b[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dX]\b",
    )
    .unwrap()
}

fn payment_card_pattern() -> Regex {
    Regex::new(r"\b(?:\d[ -]*?){13,19}\b").unwrap()
}

fn mask_secret_value(value: &str, visible_prefix: usize, visible_suffix: usize) -> String {
    let visible_length = visible_prefix + visible_suffix;
    if value.len() <= visible_length {
        return "*".repeat(value.len());
    }
    let prefix = &value[..visible_prefix];
    let masked = "*".repeat(value.len() - visible_length);
    let suffix = if visible_suffix > 0 {
        &value[value.len() - visible_suffix..]
    } else {
        ""
    };
    format!("{prefix}{masked}{suffix}")
}

fn is_placeholder_secret(value: &str) -> bool {
    let normalized = value.trim();
    if normalized.is_empty() {
        return true;
    }
    if Regex::new(r"(?i)^(?:undefined|null|true|false)$")
        .unwrap()
        .is_match(normalized)
    {
        return true;
    }
    if Regex::new(r"^\*+$").unwrap().is_match(normalized) {
        return true;
    }
    if Regex::new(r"(?i)^\[(?:redacted|masked|hidden|secret)[^\]]*\]$")
        .unwrap()
        .is_match(normalized)
    {
        return true;
    }
    if Regex::new(r"^\$\{[^}]+\}$").unwrap().is_match(normalized) {
        return true;
    }
    false
}

fn is_strong_sensitive_key(key_name: &str) -> bool {
    Regex::new(r"(?i)(?:password|passwd|pwd|token|secret|private|authorization|cookie|api[_-]?key|access[_-]?key|x-api-key|x-api-token)")
        .unwrap()
        .is_match(key_name)
}

fn is_definitely_code(value: &str) -> bool {
    if Regex::new(r"(?i)^(?:new|return|await|yield|throw|typeof|void|delete|class|function|async|this|super|self)$")
        .unwrap()
        .is_match(value)
    {
        return true;
    }
    if Regex::new(r"^new\s+\S").unwrap().is_match(value) {
        return true;
    }
    if Regex::new(r"^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*\s*\(")
        .unwrap()
        .is_match(value)
    {
        return true;
    }
    if Regex::new(r"^\$[A-Za-z_$][\w$]*").unwrap().is_match(value) {
        return true;
    }
    false
}

fn is_code_like_value(value: &str) -> bool {
    if is_definitely_code(value) {
        return true;
    }
    if Regex::new(r"^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*){1,}$")
        .unwrap()
        .is_match(value)
    {
        return true;
    }
    if Regex::new(r"^[A-Za-z_$][\w$]*\s*\[[^\]]+\]")
        .unwrap()
        .is_match(value)
    {
        return true;
    }
    if Regex::new(r"^\{[^}]*:").unwrap().is_match(value)
        || Regex::new(r"^\{\s*\}").unwrap().is_match(value)
    {
        return true;
    }
    false
}

fn should_mask_context_value(value: &str, key_name: &str) -> bool {
    let normalized = value.trim();
    if is_placeholder_secret(normalized) {
        return false;
    }
    if is_strong_sensitive_key(key_name) {
        if is_definitely_code(normalized) {
            return false;
        }
        return true;
    }
    if is_code_like_value(normalized) {
        return false;
    }
    if Regex::new(r"^\d+$").unwrap().is_match(normalized) && normalized.len() < 12 {
        return false;
    }
    normalized.len() >= 8
}

fn add_match(
    matches: &mut Vec<SensitiveMatch>,
    start: usize,
    end: usize,
    match_type: &str,
    confidence: f64,
) {
    if start < end {
        matches.push(SensitiveMatch {
            start,
            end,
            match_type: match_type.to_string(),
            confidence,
        });
    }
}

fn add_regex_matches(
    text: &str,
    matches: &mut Vec<SensitiveMatch>,
    pattern: &Regex,
    match_type: &str,
    confidence: f64,
) {
    for m in pattern.find_iter(text) {
        let value = m.as_str();
        if value.is_empty() || is_placeholder_secret(value) {
            continue;
        }
        add_match(matches, m.start(), m.end(), match_type, confidence);
    }
}

fn add_regex_value_group_matches(
    text: &str,
    matches: &mut Vec<SensitiveMatch>,
    pattern: &Regex,
    value_group: usize,
    match_type: &str,
    confidence: f64,
) {
    for capture in pattern.captures_iter(text) {
        let Some(m) = capture.get(value_group) else {
            continue;
        };
        let value = m.as_str();
        if value.is_empty() || is_placeholder_secret(value) {
            continue;
        }
        add_match(matches, m.start(), m.end(), match_type, confidence);
    }
}

fn add_regex_value_group_multi_matches(
    text: &str,
    matches: &mut Vec<SensitiveMatch>,
    pattern: &Regex,
    value_groups: &[usize],
    match_type: &str,
    confidence: f64,
) {
    for capture in pattern.captures_iter(text) {
        for &group in value_groups {
            let Some(m) = capture.get(group) else {
                continue;
            };
            let value = m.as_str();
            if value.is_empty() || is_placeholder_secret(value) {
                continue;
            }
            add_match(matches, m.start(), m.end(), match_type, confidence);
            break;
        }
    }
}

fn collect_context_matches_multi(
    text: &str,
    matches: &mut Vec<SensitiveMatch>,
    pattern: &Regex,
    key_group: usize,
    value_groups: &[usize],
    match_type: &str,
    confidence: f64,
) {
    for capture in pattern.captures_iter(text) {
        let key_name = capture.get(key_group).map(|m| m.as_str()).unwrap_or("");
        let mut found = false;
        for &group in value_groups {
            let Some(value_match) = capture.get(group) else {
                continue;
            };
            let value = value_match.as_str();
            if value.is_empty() || !should_mask_context_value(value, key_name) {
                continue;
            }
            add_match(
                matches,
                value_match.start(),
                value_match.end(),
                match_type,
                confidence,
            );
            found = true;
            break;
        }
        let _ = found;
    }
}

fn is_valid_chinese_id(value: &str) -> bool {
    let normalized = value.to_uppercase();
    if normalized.len() != 18 {
        return false;
    }
    let year: i32 = normalized[6..10].parse().unwrap_or(-1);
    let month: u32 = normalized[10..12].parse().unwrap_or(0);
    let day: u32 = normalized[12..14].parse().unwrap_or(0);
    if !(1900..=2100).contains(&year) || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return false;
    }
    let weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
    let checksums = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];
    let sum: usize = normalized[..17]
        .chars()
        .zip(weights.iter())
        .map(|(c, w)| c.to_digit(10).unwrap_or(0) as usize * w)
        .sum();
    checksums[sum % 11] == normalized.chars().nth(17).unwrap_or(' ')
}

fn is_valid_payment_card(value: &str) -> bool {
    let digits: String = value.chars().filter(|c| c.is_ascii_digit()).collect();
    if !(13..=19).contains(&digits.len()) {
        return false;
    }
    if digits
        .chars()
        .all(|c| c == digits.chars().next().unwrap_or('0'))
    {
        return false;
    }
    let mut sum = 0u32;
    let mut should_double = false;
    for digit in digits.chars().rev() {
        let mut d = digit.to_digit(10).unwrap_or(0);
        if should_double {
            d *= 2;
            if d > 9 {
                d -= 9;
            }
        }
        sum += d;
        should_double = !should_double;
    }
    sum % 10 == 0
}

fn collect_validated_matches(text: &str, matches: &mut Vec<SensitiveMatch>) {
    let china_id_re = china_id_pattern();
    for m in china_id_re.find_iter(text) {
        if is_valid_chinese_id(m.as_str()) {
            add_match(matches, m.start(), m.end(), "china_id", 0.95);
        }
    }
    let card_re = payment_card_pattern();
    for m in card_re.find_iter(text) {
        if is_valid_payment_card(m.as_str()) {
            add_match(matches, m.start(), m.end(), "payment_card", 0.9);
        }
    }
}

fn collect_local_sensitive_matches(text: &str) -> Vec<SensitiveMatch> {
    let mut matches = Vec::new();
    for pattern in direct_secret_patterns() {
        add_regex_matches(
            text,
            &mut matches,
            &pattern.pattern,
            pattern.match_type,
            pattern.confidence,
        );
    }

    collect_context_matches_multi(
        text,
        &mut matches,
        &quoted_context_pattern(),
        1,
        &[2, 3, 4],
        "context_secret",
        0.9,
    );
    collect_context_matches_multi(
        text,
        &mut matches,
        &unquoted_context_pattern(),
        1,
        &[2],
        "context_secret",
        0.85,
    );
    add_regex_value_group_multi_matches(
        text,
        &mut matches,
        &cli_option_pattern(),
        &[2, 3, 4, 5],
        "context_secret",
        0.85,
    );
    add_regex_value_group_matches(
        text,
        &mut matches,
        &authorization_pattern(),
        2,
        "authorization",
        0.95,
    );
    add_regex_value_group_matches(
        text,
        &mut matches,
        &url_query_pattern(),
        3,
        "url_query_secret",
        0.85,
    );
    collect_validated_matches(text, &mut matches);
    matches
}

fn merge_sensitive_matches(mut matches: Vec<SensitiveMatch>) -> Vec<SensitiveMatch> {
    matches.retain(|m| m.end > m.start);
    matches.sort_by(|a, b| {
        a.start
            .cmp(&b.start)
            .then_with(|| b.end.cmp(&a.end))
            .then_with(|| {
                b.confidence
                    .partial_cmp(&a.confidence)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });

    let mut merged: Vec<SensitiveMatch> = Vec::new();
    for m in matches {
        let Some(last) = merged.last_mut() else {
            merged.push(m);
            continue;
        };
        if m.start >= last.end {
            merged.push(m);
            continue;
        }
        let match_len = m.end - m.start;
        let last_len = last.end - last.start;
        if m.end > last.end && m.confidence >= last.confidence - 0.1 {
            last.end = m.end;
        }
        if match_len > last_len && m.confidence > last.confidence {
            last.start = m.start;
            last.end = m.end;
            last.match_type = m.match_type.clone();
            last.confidence = m.confidence;
        }
    }
    merged
}

fn mask_payment_card(value: &str) -> String {
    let digit_count = value.chars().filter(|c| c.is_ascii_digit()).count();
    let mut digit_index = 0;
    value
        .chars()
        .map(|c| {
            if c.is_ascii_digit() {
                digit_index += 1;
                if digit_index <= digit_count.saturating_sub(4) {
                    '*'
                } else {
                    c
                }
            } else {
                c
            }
        })
        .collect()
}

fn mask_value_by_type(match_type: &str, value: &str) -> String {
    if match_type == "private_key_block" {
        let lines: Vec<&str> = value.split('\n').collect();
        if lines.len() >= 2 {
            return format!(
                "{}\n[REDACTED PRIVATE KEY]\n{}",
                lines[0],
                lines[lines.len() - 1]
            );
        }
        return "[REDACTED PRIVATE KEY]".to_string();
    }
    if match_type == "payment_card" {
        return mask_payment_card(value);
    }
    if match_type == "china_id" {
        let len = value.chars().count();
        if len <= 10 {
            return "*".repeat(len);
        }
        let prefix: String = value.chars().take(6).collect();
        let suffix: String = value.chars().skip(len - 4).collect();
        let masked = "*".repeat(len - 10);
        return format!("{prefix}{masked}{suffix}");
    }
    if match_type == "jwt" {
        return mask_secret_value(value, 6, 4);
    }
    mask_secret_value(value, 3, 0)
}

fn apply_matches(text: &str, matches: Vec<SensitiveMatch>) -> String {
    let merged = merge_sensitive_matches(matches);
    let mut masked_text = text.to_string();
    for m in merged.into_iter().rev() {
        if m.start >= masked_text.len() || m.end > masked_text.len() {
            continue;
        }
        let value = &masked_text[m.start..m.end];
        let masked = mask_value_by_type(&m.match_type, value);
        masked_text.replace_range(m.start..m.end, &masked);
    }
    masked_text
}

fn mask_local(text: &str) -> String {
    let matches = collect_local_sensitive_matches(text);
    apply_matches(text, matches)
}

/// Mask `text` using the configured privacy mode. Local mode is pure regex
/// and runs synchronously inside `spawn_blocking`; API mode posts to the
/// configured endpoint and falls back to local rules on any failure.
pub async fn mask_text(text: &str, settings: &PrivacySettings) -> String {
    if text.is_empty() {
        return text.to_string();
    }

    if settings.mode == "api" && !settings.api.url.is_empty() {
        match mask_with_api(text, settings).await {
            Ok(masked) => return masked,
            Err(_) => {
                // fall back to local rules below
            }
        }
    }

    let text_owned = text.to_string();
    match tokio::task::spawn_blocking(move || mask_local(&text_owned)).await {
        Ok(masked) => masked,
        Err(_) => text.to_string(),
    }
}

async fn mask_with_api(text: &str, settings: &PrivacySettings) -> ApiResult<String> {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::ACCEPT,
        "*/*"
            .parse()
            .map_err(|e: reqwest::header::InvalidHeaderValue| e.to_string())?,
    );
    headers.insert(
        reqwest::header::CONTENT_TYPE,
        "application/json"
            .parse()
            .map_err(|e: reqwest::header::InvalidHeaderValue| e.to_string())?,
    );
    if !settings.api.api_key.is_empty() {
        if let Ok(value) = settings.api.api_key.parse() {
            headers.insert("x-api-key", value);
        }
        if let Ok(value) = format!("Bearer {}", settings.api.api_key).parse() {
            headers.insert(reqwest::header::AUTHORIZATION, value);
        }
    }

    let client = reqwest::Client::builder()
        .user_agent(crate::api::http_client::app_user_agent())
        .build()
        .map_err(|e| e.to_string())?;
    let body = json!({
        "text": text,
        "aggregation_strategy": "simple",
        "mask_token": "[{label}]",
    });

    let response = client
        .post(settings.api.url.as_str())
        .headers(headers)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        return Err(format!("privacy API returned {}", response.status()));
    }

    let payload: Value = response.json().await.map_err(|e| e.to_string())?;
    if let Some(masked) = payload.get("masked_text").and_then(Value::as_str) {
        return Ok(masked.to_string());
    }
    Err("privacy API response missing masked_text".to_string())
}

/// Decide whether a tool result should be masked based on the stored privacy
/// settings, then apply masking if needed. Reads from SQLite via
/// `spawn_blocking` so the Node.js event loop is never blocked.
pub async fn mask_tool_result_if_needed(tool_full_name: &str, content: &str) -> Result<String> {
    if content.is_empty() {
        return Ok(content.to_string());
    }

    let settings = tokio::task::spawn_blocking(|| {
        let database_path = crate::storage::ensure_database_file()?;
        crate::storage::services::privacy_settings::get_privacy_settings(&database_path)
    })
    .await
    .map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to load privacy settings: {error}"),
        )
    })??;

    if !settings.enabled {
        return Ok(content.to_string());
    }

    let tool_results: BTreeSet<String> = settings.tool_results.tools.iter().cloned().collect();
    if !tool_results.contains(tool_full_name) {
        return Ok(content.to_string());
    }

    Ok(mask_text(content, &settings).await)
}
