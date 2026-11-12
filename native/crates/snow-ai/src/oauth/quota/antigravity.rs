//! Antigravity（Google Code Assist）订阅与配额。

use std::time::Duration;

use napi::bindgen_prelude::*;
use serde_json::{json, Value};

use super::{
    first_value, json_f64, json_text, parse_reset_ms, QuotaBucket, QuotaGroup, QuotaParts,
};
use snow_net::http_client::build_proxied_client_with_timeout;
use crate::oauth::antigravity::post_code_assist;

const HTTP_TIMEOUT_SECS: u64 = 30;
const CLAUDE_MARKERS: [&str; 4] = ["claude", "gpt", "openai", "anthropic"];

pub async fn fetch(token: &str) -> Result<QuotaParts> {
    let client = build_proxied_client_with_timeout(Duration::from_secs(HTTP_TIMEOUT_SECS)).await?;
    let status = post_code_assist(
        &client,
        "loadCodeAssist",
        token,
        &json!({ "metadata": { "ideType": "ANTIGRAVITY" } }),
    )
    .await
    .unwrap_or(Value::Null);
    let plan = plan_from_status(&status);
    let body = project_body(&status);

    let summary = post_code_assist(&client, "retrieveUserQuotaSummary", token, &body).await;
    let mut groups = summary
        .map(|payload| summary_groups(&payload))
        .unwrap_or_default();
    if groups.is_empty() {
        let models = post_code_assist(&client, "fetchAvailableModels", token, &body).await?;
        groups = model_groups(&models);
    }
    if groups.is_empty() {
        return Err(Error::from_reason(
            "Antigravity quota response has no quota buckets",
        ));
    }
    Ok((plan, groups))
}

fn plan_from_status(status: &Value) -> Option<String> {
    let tier = status
        .get("paidTier")
        .filter(|tier| tier.get("id").is_some())
        .or_else(|| status.get("currentTier"))?;
    let id = json_text(tier.get("id"))?;
    Some(match id.as_str() {
        "free-tier" => "free".to_string(),
        "g1-pro-tier" => "pro".to_string(),
        "g1-ultra-tier" => "ultra".to_string(),
        "g1-ultra-lite-tier" => "ultra_lite".to_string(),
        _ => id.clone(),
    })
}

fn project_body(status: &Value) -> Value {
    let project = match status.get("cloudaicompanionProject") {
        Some(Value::String(text)) => text.trim().to_string(),
        Some(object) => json_text(object.get("id")).unwrap_or_default(),
        None => String::new(),
    };
    if project.is_empty() {
        json!({})
    } else {
        json!({ "project": project })
    }
}

fn summary_groups(payload: &Value) -> Vec<QuotaGroup> {
    let Some(groups) = payload.get("groups").and_then(Value::as_array) else {
        return Vec::new();
    };
    groups
        .iter()
        .enumerate()
        .filter_map(|(index, group)| {
            let label = json_text(first_value(group, &["displayName", "display_name"]))
                .unwrap_or_else(|| format!("Quota Group {}", index + 1));
            let buckets: Vec<QuotaBucket> = group
                .get("buckets")
                .and_then(Value::as_array)
                .map(|items| items.iter().filter_map(summary_bucket).collect())
                .unwrap_or_default();
            if buckets.is_empty() {
                return None;
            }
            Some(QuotaGroup {
                id: slug(&label, index),
                label,
                buckets,
            })
        })
        .collect()
}

fn summary_bucket(bucket: &Value) -> Option<QuotaBucket> {
    let fraction = json_f64(first_value(bucket, &["remainingFraction", "remaining_fraction"]))?;
    let window = json_text(bucket.get("window")).unwrap_or_default();
    let key = match window.to_lowercase().as_str() {
        "5h" | "five-hour" | "five_hour" => "five_hour",
        "weekly" | "week" => "weekly",
        _ => "window",
    };
    let label = json_text(first_value(bucket, &["displayName", "display_name"]))
        .or_else(|| json_text(first_value(bucket, &["bucketId", "bucket_id"])))
        .unwrap_or_else(|| window.clone());
    Some(QuotaBucket {
        key: key.to_string(),
        label,
        remaining_percent: Some(fraction_percent(fraction)),
        reset_at_ms: parse_reset_ms(first_value(bucket, &["resetTime", "reset_time"])),
    })
}

/// 回退路径：按模型归入 Claude / Gemini 两组，组内取最低剩余，重置取最晚的一个。
fn model_groups(payload: &Value) -> Vec<QuotaGroup> {
    let Some(models) = payload.get("models").and_then(Value::as_object) else {
        return Vec::new();
    };
    let mut claude: Vec<(f64, Option<f64>)> = Vec::new();
    let mut gemini: Vec<(f64, Option<f64>)> = Vec::new();
    for (id, entry) in models {
        let quota = entry.get("quotaInfo").or_else(|| entry.get("quota_info"));
        let Some(fraction) = json_f64(
            quota.and_then(|quota| first_value(quota, &["remainingFraction", "remaining_fraction"])),
        ) else {
            continue;
        };
        let reset = parse_reset_ms(
            quota.and_then(|quota| first_value(quota, &["resetTime", "reset_time"])),
        );
        let name = json_text(first_value(entry, &["displayName", "display_name"]))
            .unwrap_or_default();
        let text = format!("{id} {name}").to_lowercase();
        if text.contains("gemini") {
            gemini.push((fraction, reset));
        } else if CLAUDE_MARKERS.iter().any(|marker| text.contains(*marker)) {
            claude.push((fraction, reset));
        }
    }
    [("claude", "Claude", claude), ("gemini", "Gemini", gemini)]
        .into_iter()
        .filter_map(|(id, label, entries)| shared_group(id, label, &entries))
        .collect()
}

fn shared_group(id: &str, label: &str, entries: &[(f64, Option<f64>)]) -> Option<QuotaGroup> {
    let lowest = entries
        .iter()
        .map(|(fraction, _)| *fraction)
        .fold(f64::INFINITY, f64::min);
    if !lowest.is_finite() {
        return None;
    }
    let limiting: Vec<Option<f64>> = entries
        .iter()
        .filter(|(fraction, _)| *fraction == lowest)
        .map(|(_, reset)| *reset)
        .collect();
    Some(QuotaGroup {
        id: format!("models-{id}"),
        label: label.to_string(),
        buckets: vec![QuotaBucket {
            key: "shared".to_string(),
            label: String::new(),
            remaining_percent: Some(fraction_percent(lowest)),
            reset_at_ms: latest_reset(&limiting),
        }],
    })
}

fn latest_reset(values: &[Option<f64>]) -> Option<f64> {
    let mut latest: Option<f64> = None;
    for value in values {
        let value = (*value)?;
        latest = Some(latest.map_or(value, |current| current.max(value)));
    }
    latest
}

fn fraction_percent(fraction: f64) -> f64 {
    (fraction * 100.0).clamp(0.0, 100.0)
}

fn slug(label: &str, index: usize) -> String {
    let slug: String = label
        .to_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect();
    let trimmed = slug.trim_matches('-');
    if trimmed.is_empty() {
        format!("quota-group-{}", index + 1)
    } else {
        trimmed.to_string()
    }
}
