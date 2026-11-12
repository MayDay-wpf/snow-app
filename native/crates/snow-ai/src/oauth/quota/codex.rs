//! ChatGPT / Codex 订阅用量（wham/usage）。

use std::collections::HashMap;

use napi::bindgen_prelude::*;
use serde_json::Value;

use super::{
    first_value, get_json, json_f64, json_text, now_ms, parse_reset_ms, remaining_from_used,
    QuotaBucket, QuotaGroup, QuotaParts,
};
use crate::oauth::codex as codex_auth;
use crate::oauth::header_schemes::fill_missing_headers;
use crate::oauth::provider::OAuthProfileMetadata;

const USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
const FIVE_HOUR_SECONDS: i64 = 18_000;
const WEEK_SECONDS: i64 = 604_800;
const MIN_MONTH_SECONDS: i64 = 28 * 24 * 60 * 60;
const MAX_MONTH_SECONDS: i64 = 31 * 24 * 60 * 60;

/// `headers` 为档案绑定方案与账号级请求头；ChatGPT 档案没有 Codex 方案，
/// 配额接口仍需 Codex 客户端身份，缺失项以 Codex 默认身份头补齐。
pub async fn fetch(
    token: &str,
    metadata: &OAuthProfileMetadata,
    mut headers: HashMap<String, String>,
) -> Result<QuotaParts> {
    fill_missing_headers(&mut headers, codex_auth::required_headers());
    codex_auth::apply_request_headers(metadata, &mut headers);
    let payload = get_json(USAGE_URL, token, &headers).await?;

    let plan = json_text(first_value(&payload, &["plan_type", "planType"]))
        .or_else(|| {
            let stored = metadata.plan_type.trim();
            (!stored.is_empty()).then(|| stored.to_string())
        })
        .map(|plan| plan.to_lowercase());
    let team = plan.as_deref() == Some("team");
    let now = now_ms();

    let mut groups = Vec::new();
    push_group(
        &mut groups,
        "codex",
        "Codex",
        limit_buckets(first_value(&payload, &["rate_limit", "rateLimit"]), team, now),
    );
    push_group(
        &mut groups,
        "code_review",
        "Code review",
        limit_buckets(
            first_value(&payload, &["code_review_rate_limit", "codeReviewRateLimit"]),
            team,
            now,
        ),
    );
    if let Some(items) = first_value(&payload, &["additional_rate_limits", "additionalRateLimits"])
        .and_then(Value::as_array)
    {
        for item in items {
            let Some(name) = json_text(first_value(
                item,
                &["limit_name", "limitName", "metered_feature", "meteredFeature"],
            )) else {
                continue;
            };
            let buckets = limit_buckets(first_value(item, &["rate_limit", "rateLimit"]), team, now);
            push_group(&mut groups, &format!("additional:{name}"), &name, buckets);
        }
    }

    if groups.is_empty() {
        return Err(Error::from_reason("Codex usage response has no quota windows"));
    }
    Ok((plan, groups))
}

fn push_group(groups: &mut Vec<QuotaGroup>, id: &str, label: &str, buckets: Vec<QuotaBucket>) {
    if buckets.is_empty() {
        return;
    }
    groups.push(QuotaGroup {
        id: id.to_string(),
        label: label.to_string(),
        buckets,
    });
}

fn limit_buckets(limit: Option<&Value>, team: bool, now: f64) -> Vec<QuotaBucket> {
    let Some(limit) = limit.filter(|value| value.is_object()) else {
        return Vec::new();
    };
    let primary = first_value(limit, &["primary_window", "primaryWindow", "primary"]);
    let secondary = first_value(limit, &["secondary_window", "secondaryWindow", "secondary"]);

    // 按窗口时长归类；无时长时主窗口视为 5 小时，次窗口视为周（团队套餐为月）
    let mut assigned: Vec<(&'static str, &Value)> = Vec::new();
    for (index, window) in [primary, secondary].into_iter().enumerate() {
        let Some(window) = window.filter(|value| value.is_object()) else {
            continue;
        };
        let key = match window_seconds(window) {
            Some(seconds) if seconds == FIVE_HOUR_SECONDS => "five_hour",
            Some(seconds) if seconds == WEEK_SECONDS => "weekly",
            Some(seconds) if (MIN_MONTH_SECONDS..=MAX_MONTH_SECONDS).contains(&seconds) => "monthly",
            Some(_) => "window",
            None if index == 0 => "five_hour",
            None if team => "monthly",
            None => "weekly",
        };
        let duplicated = assigned.iter().any(|(existing, _)| *existing == key);
        let key = if duplicated { "window" } else { key };
        assigned.push((key, window));
    }

    assigned
        .into_iter()
        .map(|(key, window)| window_bucket(key, window, now))
        .collect()
}

fn window_bucket(key: &str, window: &Value, now: f64) -> QuotaBucket {
    let used = json_f64(first_value(window, &["used_percent", "usedPercent"]));
    QuotaBucket {
        key: key.to_string(),
        label: window_seconds(window).map(format_duration).unwrap_or_default(),
        remaining_percent: used.map(remaining_from_used),
        reset_at_ms: reset_ms(window, now),
    }
}

fn window_seconds(window: &Value) -> Option<i64> {
    json_f64(first_value(window, &["limit_window_seconds", "limitWindowSeconds"]))
        .filter(|seconds| *seconds > 0.0)
        .map(|seconds| seconds as i64)
}

fn reset_ms(window: &Value, now: f64) -> Option<f64> {
    parse_reset_ms(first_value(window, &["reset_at", "resetAt"])).or_else(|| {
        json_f64(first_value(window, &["reset_after_seconds", "resetAfterSeconds"]))
            .filter(|seconds| *seconds > 0.0)
            .map(|seconds| now + seconds * 1000.0)
    })
}

fn format_duration(seconds: i64) -> String {
    const DAY: i64 = 86_400;
    const HOUR: i64 = 3_600;
    if seconds % DAY == 0 {
        format!("{}d", seconds / DAY)
    } else if seconds % HOUR == 0 {
        format!("{}h", seconds / HOUR)
    } else {
        format!("{seconds}s")
    }
}
