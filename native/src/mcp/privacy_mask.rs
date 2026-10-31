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
//!
//! Image payloads are never masked: data URLs and image content blocks are
//! swapped for opaque tokens before masking and restored byte-for-byte, so a
//! filter can only ever rewrite text.

use std::collections::BTreeSet;

use napi::bindgen_prelude::*;
use regex::Regex;
use serde_json::{json, Value};

use crate::storage::services::privacy_settings::{PrivacyCustomRule, PrivacySettings};

pub(crate) mod custom_rules;
mod db_connection;

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
    rule_id: &'static str,
    pattern: Regex,
    match_type: &'static str,
    confidence: f64,
}

/// 本地脱敏规则元数据（供 UI 启停）。id 即持久化在 disabledRules 中的值。
pub(crate) struct PrivacyRuleInfo {
    pub id: &'static str,
    pub group: &'static str,
    pub label: &'static str,
    pub example: &'static str,
}

pub(crate) const PRIVACY_RULES: &[PrivacyRuleInfo] = &[
    PrivacyRuleInfo { id: "openai_key", group: "apiKey", label: "OpenAI-style key", example: "sk-..." },
    PrivacyRuleInfo { id: "google_key", group: "apiKey", label: "Google API key", example: "AIza..." },
    PrivacyRuleInfo { id: "github_token", group: "apiKey", label: "GitHub token", example: "github_pat_... / ghp_..." },
    PrivacyRuleInfo { id: "slack_token", group: "apiKey", label: "Slack token", example: "xoxb-..." },
    PrivacyRuleInfo { id: "stripe_key", group: "apiKey", label: "Stripe key", example: "sk_live_... / rk_test_..." },
    PrivacyRuleInfo { id: "aws_access_key", group: "apiKey", label: "AWS access key", example: "AKIA... / ASIA..." },
    PrivacyRuleInfo { id: "snow_key", group: "apiKey", label: "Snow key", example: "snow-..." },
    PrivacyRuleInfo { id: "private_key_block", group: "credential", label: "PEM private key", example: "-----BEGIN PRIVATE KEY-----" },
    PrivacyRuleInfo { id: "jwt", group: "credential", label: "JWT", example: "eyJ....eyJ....sig" },
    PrivacyRuleInfo { id: "authorization", group: "credential", label: "Authorization token", example: "Bearer ... / Basic ..." },
    PrivacyRuleInfo { id: "url_query_secret", group: "credential", label: "URL query secret", example: "?token=... &api_key=..." },
    PrivacyRuleInfo { id: "context_secret", group: "credential", label: "Sensitive key-value", example: "password=... / api_key: ..." },
    PrivacyRuleInfo { id: "cli_option_secret", group: "credential", label: "CLI secret option", example: "--token ... / --password ..." },
    PrivacyRuleInfo { id: "db_connection", group: "credential", label: "Database connection string", example: "Server=...;User Id=...;Password=..." },
    PrivacyRuleInfo { id: "china_id", group: "personal", label: "China ID card number", example: "15 / 18 digits, checksum validated" },
    PrivacyRuleInfo { id: "china_mobile", group: "personal", label: "China mobile number", example: "1[3-9] + 9 digits" },
    PrivacyRuleInfo { id: "global_phone", group: "personal", label: "International phone number", example: "+1 415 555 0100" },
    PrivacyRuleInfo { id: "payment_card", group: "personal", label: "Payment card number", example: "13-19 digits, Luhn validated" },
];

/// 规则启停判定：disabled 为已关闭的规则 id 集合；custom 为已编译的自定义规则。
struct RuleFilter<'a> {
    disabled: &'a [String],
    custom: &'a [custom_rules::CompiledCustomRule],
}

impl RuleFilter<'_> {
    fn on(&self, rule_id: &str) -> bool {
        !self.disabled.iter().any(|id| id == rule_id)
    }
}

fn direct_secret_patterns() -> Vec<DirectSecretPattern> {
    vec![
        DirectSecretPattern {
            rule_id: "private_key_block",
            pattern: Regex::new(
                r"(?s)-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----.*?-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----",
            )
            .unwrap(),
            match_type: "private_key_block",
            confidence: 1.0,
        },
        DirectSecretPattern {
            rule_id: "jwt",
            pattern: Regex::new(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b").unwrap(),
            match_type: "jwt",
            confidence: 0.95,
        },
        DirectSecretPattern {
            rule_id: "openai_key",
            pattern: Regex::new(r"\bsk-[A-Za-z0-9_-]{12,}\b").unwrap(),
            match_type: "api_key",
            confidence: 0.95,
        },
        DirectSecretPattern {
            rule_id: "google_key",
            pattern: Regex::new(r"\bAIza[0-9A-Za-z_-]{20,}\b").unwrap(),
            match_type: "api_key",
            confidence: 0.95,
        },
        DirectSecretPattern {
            rule_id: "github_token",
            pattern: Regex::new(r"\bgithub_pat_[A-Za-z0-9_]{22,}\b").unwrap(),
            match_type: "api_key",
            confidence: 0.95,
        },
        DirectSecretPattern {
            rule_id: "github_token",
            pattern: Regex::new(r"\bgh[opsru]_[A-Za-z0-9]{20,}\b").unwrap(),
            match_type: "api_key",
            confidence: 0.95,
        },
        DirectSecretPattern {
            rule_id: "slack_token",
            pattern: Regex::new(r"\bxox[abprs]-[A-Za-z0-9-]{12,}\b").unwrap(),
            match_type: "api_key",
            confidence: 0.95,
        },
        DirectSecretPattern {
            rule_id: "stripe_key",
            pattern: Regex::new(r"\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b").unwrap(),
            match_type: "api_key",
            confidence: 0.95,
        },
        DirectSecretPattern {
            rule_id: "aws_access_key",
            pattern: Regex::new(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b").unwrap(),
            match_type: "api_key",
            confidence: 0.9,
        },
        DirectSecretPattern {
            rule_id: "snow_key",
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
        r"(?i)\b(?:[1-9]\d{5}\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}|[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dX])\b",
    )
    .unwrap()
}

fn china_mobile_pattern() -> Regex {
    Regex::new(r"\b1[3-9]\d{9}\b").unwrap()
}

fn global_phone_pattern() -> Regex {
    Regex::new(r"(?x)(?:\+\d{1,3}|00\s*\d{1,3})(?:[\s().-]*\d){7,14}\b").unwrap()
}

fn payment_card_pattern() -> Regex {
    Regex::new(r"\b(?:\d[ -]*?){13,19}\b").unwrap()
}

/// 保留前 `visible_prefix` / 后 `visible_suffix` 个字符，其余替换为 `*`。
/// 按字符而非字节切分：多字节字符（中文等）落在字节切点上会 panic。
fn mask_secret_value(value: &str, visible_prefix: usize, visible_suffix: usize) -> String {
    let visible_length = visible_prefix + visible_suffix;
    let char_count = value.chars().count();
    if char_count <= visible_length {
        return "*".repeat(char_count);
    }
    let prefix: String = value.chars().take(visible_prefix).collect();
    let suffix: String = value.chars().skip(char_count - visible_suffix).collect();
    let masked = "*".repeat(char_count - visible_length);
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
    let (year, month, day) = if normalized.len() == 15 {
        (
            1900 + normalized[6..8].parse::<i32>().unwrap_or(-1),
            normalized[8..10].parse::<u32>().unwrap_or(0),
            normalized[10..12].parse::<u32>().unwrap_or(0),
        )
    } else if normalized.len() == 18 {
        (
            normalized[6..10].parse::<i32>().unwrap_or(-1),
            normalized[10..12].parse::<u32>().unwrap_or(0),
            normalized[12..14].parse::<u32>().unwrap_or(0),
        )
    } else {
        return false;
    };
    if !(1900..=2100).contains(&year) || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return false;
    }
    if normalized.len() == 15 {
        return true;
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

fn is_valid_phone_number(value: &str) -> bool {
    let digits: String = value.chars().filter(|c| c.is_ascii_digit()).collect();
    if !(7..=15).contains(&digits.len()) {
        return false;
    }
    if digits
        .chars()
        .all(|c| c == digits.chars().next().unwrap_or('0'))
    {
        return false;
    }
    true
}

fn collect_validated_matches(text: &str, matches: &mut Vec<SensitiveMatch>, filter: &RuleFilter) {
    if filter.on("china_id") {
        for m in china_id_pattern().find_iter(text) {
            if is_valid_chinese_id(m.as_str()) {
                add_match(matches, m.start(), m.end(), "china_id", 0.95);
            }
        }
    }
    if filter.on("china_mobile") {
        for m in china_mobile_pattern().find_iter(text) {
            add_match(matches, m.start(), m.end(), "phone", 0.9);
        }
    }
    if filter.on("global_phone") {
        for m in global_phone_pattern().find_iter(text) {
            if is_valid_phone_number(m.as_str()) {
                add_match(matches, m.start(), m.end(), "phone", 0.9);
            }
        }
    }
    if filter.on("payment_card") {
        for m in payment_card_pattern().find_iter(text) {
            if is_valid_payment_card(m.as_str()) {
                add_match(matches, m.start(), m.end(), "payment_card", 0.9);
            }
        }
    }
}

fn collect_local_sensitive_matches(text: &str, filter: &RuleFilter) -> Vec<SensitiveMatch> {
    let mut matches = Vec::new();
    for pattern in direct_secret_patterns() {
        if !filter.on(pattern.rule_id) {
            continue;
        }
        add_regex_matches(
            text,
            &mut matches,
            &pattern.pattern,
            pattern.match_type,
            pattern.confidence,
        );
    }

    if filter.on("context_secret") {
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
    }
    if filter.on("cli_option_secret") {
        add_regex_value_group_multi_matches(
            text,
            &mut matches,
            &cli_option_pattern(),
            &[2, 3, 4, 5],
            "context_secret",
            0.85,
        );
    }
    if filter.on("authorization") {
        add_regex_value_group_matches(
            text,
            &mut matches,
            &authorization_pattern(),
            2,
            "authorization",
            0.95,
        );
    }
    if filter.on("url_query_secret") {
        add_regex_value_group_matches(
            text,
            &mut matches,
            &url_query_pattern(),
            3,
            "url_query_secret",
            0.85,
        );
    }
    if filter.on("db_connection") {
        db_connection::collect_db_connection_matches(text, &mut matches);
    }
    collect_validated_matches(text, &mut matches, filter);
    custom_rules::collect_matches(text, filter.custom, &mut matches);
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
    if let Some(replacement) = match_type.strip_prefix(custom_rules::TEXT_PREFIX) {
        return replacement.to_string();
    }
    if match_type == custom_rules::MATCH_TYPE {
        return "*".repeat(value.chars().count());
    }
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
    if match_type == "phone" {
        let digits: String = value.chars().filter(|c| c.is_ascii_digit()).collect();
        if digits.len() >= 7 {
            let prefix_len = digits.len().min(3);
            let suffix_len = digits.len().min(4);
            let masked_len = digits.len().saturating_sub(prefix_len + suffix_len);
            let mut digit_index = 0;
            return value
                .chars()
                .map(|c| {
                    if c.is_ascii_digit() {
                        digit_index += 1;
                        if digit_index > prefix_len && digit_index <= prefix_len + masked_len {
                            '*'
                        } else {
                            c
                        }
                    } else {
                        c
                    }
                })
                .collect();
        }
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
    // 连接串的主机/用户/密码整段遮罩，不留前缀
    if match_type == "db_connection" {
        return "*".repeat(value.chars().count());
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

/// Placeholder prefix for image payloads. Tokens are plain ASCII words: they
/// survive JSON serialization unchanged and match no masking pattern.
const IMAGE_PAYLOAD_TOKEN: &str = "SNOWPRIVACYIMAGEPAYLOAD";

fn image_payload_token(index: usize) -> String {
    format!("{IMAGE_PAYLOAD_TOKEN}{index}X")
}

fn is_base64_payload_char(value: char) -> bool {
    value.is_ascii_alphanumeric() || matches!(value, '+' | '/' | '=')
}

/// Byte ranges of `data:image/...;base64,<payload>` inside `text`.
///
/// Image bytes must never pass through a text masker: replacing a single
/// base64 character corrupts the image, and an external filter must not even
/// receive it.
fn image_data_url_spans(text: &str) -> Vec<(usize, usize)> {
    const PREFIX: &str = "data:image/";
    const SEPARATOR: &str = ";base64,";
    let lowercase = text.to_ascii_lowercase();
    let mut spans = Vec::new();
    let mut search_from = 0;
    while let Some(offset) = lowercase[search_from..].find(PREFIX) {
        let start = search_from + offset;
        let header_start = start + PREFIX.len();
        let Some(header_end) = lowercase[header_start..].find(SEPARATOR) else {
            break;
        };
        let data_start = header_start + header_end + SEPARATOR.len();
        let mut end = data_start;
        for (index, character) in text[data_start..].char_indices() {
            if is_base64_payload_char(character) {
                end = data_start + index + character.len_utf8();
            } else {
                break;
            }
        }
        if end > data_start {
            spans.push((start, end));
        }
        search_from = end.max(data_start);
        if search_from >= lowercase.len() {
            break;
        }
    }
    spans
}

/// Replace every image data URL in `text` with an opaque token and remember the
/// original payload for restoration.
fn replace_image_data_url_spans(text: &mut String, payloads: &mut Vec<(String, String)>) {
    if !text.contains("data:image/") {
        return;
    }
    let spans = image_data_url_spans(text);
    if spans.is_empty() {
        return;
    }
    let original = std::mem::take(text);
    let mut protected = String::with_capacity(original.len());
    let mut cursor = 0;
    for (start, end) in spans {
        if start < cursor {
            continue;
        }
        protected.push_str(&original[cursor..start]);
        let token = image_payload_token(payloads.len());
        protected.push_str(&token);
        payloads.push((token, original[start..end].to_string()));
        cursor = end;
    }
    protected.push_str(&original[cursor..]);
    *text = protected;
}

/// Objects that describe an image content block: `{type:"image",...}`,
/// `{mimeType:"image/png","data":"<base64>"}` or `{isImage:true,content:...}`.
fn is_image_context(map: &serde_json::Map<String, Value>) -> bool {
    if map
        .get("isImage")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return true;
    }
    if map.get("type").and_then(Value::as_str) == Some("image") {
        return true;
    }
    map.get("mimeType")
        .and_then(Value::as_str)
        .is_some_and(|mime| mime.to_ascii_lowercase().starts_with("image/"))
}

fn collect_image_payloads(
    value: &mut Value,
    image_field: bool,
    payloads: &mut Vec<(String, String)>,
) {
    match value {
        Value::String(text) => {
            if text.is_empty() {
                return;
            }
            if image_field {
                let token = image_payload_token(payloads.len());
                payloads.push((token.clone(), std::mem::take(text)));
                *text = token;
                return;
            }
            replace_image_data_url_spans(text, payloads);
        }
        Value::Array(items) => {
            for item in items {
                collect_image_payloads(item, false, payloads);
            }
        }
        Value::Object(map) => {
            let image_context = is_image_context(map);
            for (key, child) in map.iter_mut() {
                let is_image_field = image_context
                    && matches!(key.as_str(), "data" | "content" | "base64" | "image");
                collect_image_payloads(child, is_image_field, payloads);
            }
        }
        _ => {}
    }
}

/// Hide image payloads behind tokens so text masking only touches text.
/// Returns `None` when the content carries no image data.
fn protect_image_payloads(content: &str) -> Option<(String, Vec<(String, String)>)> {
    // Cheap pre-check: every image payload marker contains "image".
    if !content.contains("image") {
        return None;
    }
    if let Ok(mut value) = serde_json::from_str::<Value>(content) {
        let mut payloads = Vec::new();
        collect_image_payloads(&mut value, false, &mut payloads);
        if payloads.is_empty() {
            return None;
        }
        return Some((serde_json::to_string(&value).ok()?, payloads));
    }

    let mut protected = content.to_string();
    let mut payloads = Vec::new();
    replace_image_data_url_spans(&mut protected, &mut payloads);
    if payloads.is_empty() {
        None
    } else {
        Some((protected, payloads))
    }
}

/// Put the original image payloads back. Image payloads are base64/data-URL
/// text, which needs no JSON escaping, so the raw span can be reinserted
/// verbatim. `None` means a filter rewrote a token and the caller must retry
/// without the external API.
fn restore_image_payloads(masked: &str, payloads: &[(String, String)]) -> Option<String> {
    let mut restored = masked.to_string();
    for (token, original) in payloads {
        if !restored.contains(token.as_str()) {
            return None;
        }
        restored = restored.replace(token.as_str(), original);
    }
    Some(restored)
}

fn mask_local_rules(text: &str, filter: &RuleFilter) -> String {
    let matches = collect_local_sensitive_matches(text, filter);
    apply_matches(text, matches)
}

/// 全量规则遮罩（提示词上下文等内部场景，不受用户规则开关影响）。
pub(crate) fn mask_local(text: &str) -> String {
    mask_local_with(text, &[], &[])
}

/// 按用户关闭的内置规则跳过，并叠加启用的自定义规则后遮罩。
pub(crate) fn mask_local_with(text: &str, disabled: &[String], custom: &[PrivacyCustomRule]) -> String {
    let compiled = custom_rules::compile_rules(custom);
    let filter = RuleFilter {
        disabled,
        custom: &compiled,
    };
    let mut protected = text.to_string();
    let mut payloads = Vec::new();
    replace_image_data_url_spans(&mut protected, &mut payloads);
    if payloads.is_empty() {
        return mask_local_rules(text, &filter);
    }
    let masked = mask_local_rules(&protected, &filter);
    restore_image_payloads(&masked, &payloads).unwrap_or(masked)
}

/// 仅应用自定义规则（API 模式远端脱敏后补充执行）。
fn mask_custom_only(text: &str, custom: &[PrivacyCustomRule]) -> String {
    let compiled = custom_rules::compile_rules(custom);
    if compiled.is_empty() {
        return text.to_string();
    }
    let mut matches = Vec::new();
    custom_rules::collect_matches(text, &compiled, &mut matches);
    apply_matches(text, matches)
}

/// Apply the configured privacy mode to already image-free text.
async fn mask_text_raw(text: &str, settings: &PrivacySettings) -> String {
    if settings.mode == "api" && !settings.api.url.is_empty() {
        if let Ok(masked) = mask_with_api(text, settings).await {
            if settings.custom_rules.iter().all(|rule| !rule.enabled) {
                return masked;
            }
            let custom = settings.custom_rules.clone();
            let fallback = masked.clone();
            return tokio::task::spawn_blocking(move || mask_custom_only(&masked, &custom))
                .await
                .unwrap_or(fallback);
        }
    }

    let text_owned = text.to_string();
    let disabled = settings.disabled_rules.clone();
    let custom = settings.custom_rules.clone();
    match tokio::task::spawn_blocking(move || mask_local_with(&text_owned, &disabled, &custom)).await {
        Ok(masked) => masked,
        Err(_) => text.to_string(),
    }
}

/// Mask `text` using the configured privacy mode. Local mode is pure regex
/// and runs synchronously inside `spawn_blocking`; API mode posts to the
/// configured endpoint and falls back to local rules on any failure.
/// Image payloads (data URLs and image content blocks) are opaque: they are
/// swapped for tokens before masking and restored byte-for-byte afterwards.
pub async fn mask_text(text: &str, settings: &PrivacySettings) -> String {
    if text.is_empty() {
        return text.to_string();
    }

    let prepared = {
        let text_owned = text.to_string();
        tokio::task::spawn_blocking(move || protect_image_payloads(&text_owned)).await
    };
    let Ok(Some((protected, payloads))) = prepared else {
        return mask_text_raw(text, settings).await;
    };

    let masked = mask_text_raw(&protected, settings).await;
    if let Some(restored) = restore_image_payloads(&masked, &payloads) {
        return restored;
    }

    // The remote filter rewrote a placeholder. Never let that lose the image:
    // mask locally and restore deterministically.
    let local_text = protected.clone();
    let disabled = settings.disabled_rules.clone();
    let custom = settings.custom_rules.clone();
    let local_masked = tokio::task::spawn_blocking(move || mask_local_with(&local_text, &disabled, &custom))
        .await
        .unwrap_or(protected);
    restore_image_payloads(&local_masked, &payloads).unwrap_or(local_masked)
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

    let client = crate::api::http_client::build_proxied_client()
        .await
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
