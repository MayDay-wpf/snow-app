//! Claude 订阅用量（/api/oauth/usage）与套餐（/api/oauth/profile）。

use std::collections::HashMap;

use napi::bindgen_prelude::*;
use serde_json::Value;

use super::{
    first_value, get_json, json_f64, json_text, parse_reset_ms, remaining_from_used, QuotaBucket,
    QuotaGroup, QuotaParts,
};
use crate::oauth::anthropic as anthropic_auth;
use crate::oauth::header_schemes::fill_missing_headers;

const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const PROFILE_URL: &str = "https://api.anthropic.com/api/oauth/profile";
const TOP_LEVEL_WINDOWS: [&str; 7] = [
    "five_hour",
    "seven_day",
    "seven_day_oauth_apps",
    "seven_day_opus",
    "seven_day_sonnet",
    "seven_day_cowork",
    "iguana_necktie",
];

/// `headers` 为档案绑定方案解析出的请求头；配额接口不属于用户配置的推理请求，
/// 档案未绑定方案时以 Claude Code 默认身份头补齐缺失项。
pub async fn fetch(token: &str, mut headers: HashMap<String, String>) -> Result<QuotaParts> {
    fill_missing_headers(&mut headers, anthropic_auth::required_headers());
    let (usage, profile) = futures::future::join(
        get_json(USAGE_URL, token, &headers),
        get_json(PROFILE_URL, token, &headers),
    )
    .await;

    let usage = usage?;
    let plan = profile.ok().and_then(|profile| plan_from_profile(&profile));
    let limits: Vec<Value> = usage
        .get("limits")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut buckets = Vec::new();
    for key in TOP_LEVEL_WINDOWS {
        if let Some(window) = usage.get(key).filter(|value| value.is_object()) {
            buckets.push(percent_bucket(key, window));
        }
    }
    // 顶层窗口缺失时，从 limits[] 的会话 / 周限额恢复
    if !buckets.iter().any(|bucket| bucket.key == "five_hour") {
        if let Some(limit) = find_limit(&limits, &["session"]) {
            buckets.insert(0, percent_bucket("five_hour", limit));
        }
    }
    if !buckets.iter().any(|bucket| bucket.key == "seven_day") {
        if let Some(limit) = find_limit(&limits, &["weekly", "weekly_all"]) {
            buckets.push(percent_bucket("seven_day", limit));
        }
    }

    let mut model_names: Vec<String> = Vec::new();
    for limit in &limits {
        if !is_weekly_scoped(limit) {
            continue;
        }
        let Some(name) = model_display_name(limit) else {
            continue;
        };
        if model_names.contains(&name) {
            continue;
        }
        model_names.push(name.clone());
        buckets.push(QuotaBucket {
            key: "model_weekly".to_string(),
            label: name,
            remaining_percent: percent_remaining(limit),
            reset_at_ms: reset_of(limit),
        });
    }

    if buckets.is_empty() {
        return Err(Error::from_reason("Claude usage response has no quota windows"));
    }
    Ok((
        plan,
        vec![QuotaGroup {
            id: "claude".to_string(),
            label: "Claude".to_string(),
            buckets,
        }],
    ))
}

fn percent_bucket(key: &str, window: &Value) -> QuotaBucket {
    QuotaBucket {
        key: key.to_string(),
        label: String::new(),
        remaining_percent: percent_remaining(window),
        reset_at_ms: reset_of(window),
    }
}

fn percent_remaining(window: &Value) -> Option<f64> {
    json_f64(first_value(window, &["utilization", "percent"]))
        .filter(|used| *used >= 0.0)
        .map(remaining_from_used)
}

fn reset_of(window: &Value) -> Option<f64> {
    parse_reset_ms(first_value(
        window,
        &["resets_at", "resetsAt", "reset_at", "resetAt"],
    ))
}

fn token_of(value: Option<&Value>) -> String {
    json_text(value).map(|text| text.to_lowercase()).unwrap_or_default()
}

fn find_limit<'a>(limits: &'a [Value], kinds: &[&str]) -> Option<&'a Value> {
    limits.iter().find(|limit| {
        let kind = token_of(limit.get("kind"));
        let group = token_of(limit.get("group"));
        kinds.contains(&kind.as_str()) && (group.is_empty() || kinds.contains(&group.as_str()))
    })
}

fn is_weekly_scoped(limit: &Value) -> bool {
    let kind = token_of(limit.get("kind"));
    let group = token_of(limit.get("group"));
    if !group.is_empty() && group != "weekly" {
        return false;
    }
    kind == "weekly_scoped"
        || kind == "weekly_model_scoped"
        || (kind == "model_scoped" && group == "weekly")
}

fn model_display_name(limit: &Value) -> Option<String> {
    let model = limit.get("scope").and_then(|scope| scope.get("model"))?;
    let read = |candidate: &Value| {
        json_text(first_value(candidate, &["display_name", "displayName", "name"]))
    };
    read(model).or_else(|| model.get("details").and_then(read))
}

fn plan_from_profile(profile: &Value) -> Option<String> {
    let account = profile.get("account");
    let flag = |key: &str| account.and_then(|account| flag_value(account.get(key)));
    let has_max = flag("has_claude_max");
    let has_pro = flag("has_claude_pro");
    if has_max == Some(true) {
        return Some("max".to_string());
    }
    if has_pro == Some(true) {
        return Some("pro".to_string());
    }

    let organization = profile.get("organization");
    let organization_type = organization
        .map(|org| token_of(org.get("organization_type")))
        .unwrap_or_default();
    let subscription_status = organization
        .map(|org| token_of(org.get("subscription_status")))
        .unwrap_or_default();
    if organization_type == "claude_team" && subscription_status == "active" {
        return Some("team".to_string());
    }
    if has_max == Some(false) && has_pro == Some(false) {
        return Some("free".to_string());
    }
    None
}

fn flag_value(value: Option<&Value>) -> Option<bool> {
    match value? {
        Value::Bool(flag) => Some(*flag),
        Value::String(text) => match text.trim().to_lowercase().as_str() {
            "true" => Some(true),
            "false" => Some(false),
            _ => None,
        },
        _ => None,
    }
}
