//! xAI（Grok）订阅账单用量（cli-chat-proxy billing）。

use std::collections::HashMap;

use napi::bindgen_prelude::*;
use serde_json::Value;

use super::{
    first_value, get_json, json_f64, json_text, parse_reset_ms, remaining_from_used, QuotaBucket,
    QuotaGroup, QuotaParts,
};

const WEEKLY_BILLING_URL: &str = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const MONTHLY_BILLING_URL: &str = "https://cli-chat-proxy.grok.com/v1/billing";
const GROK_CLIENT_VERSION: &str = "1.0.44";

pub async fn fetch(token: &str, account_id: &str) -> Result<QuotaParts> {
    let headers = identity_headers(account_id);
    let (weekly, monthly) = futures::future::join(
        get_json(WEEKLY_BILLING_URL, token, &headers),
        get_json(MONTHLY_BILLING_URL, token, &headers),
    )
    .await;

    let mut buckets = Vec::new();
    let mut first_error = None;
    match weekly {
        Ok(payload) => buckets.extend(weekly_buckets(&payload)),
        Err(error) => first_error = Some(error),
    }
    match monthly {
        Ok(payload) => buckets.extend(monthly_buckets(&payload)),
        Err(error) => {
            if first_error.is_none() {
                first_error = Some(error);
            }
        }
    }

    if buckets.is_empty() {
        return Err(first_error
            .unwrap_or_else(|| Error::from_reason("xAI billing response has no usage data")));
    }
    Ok((
        None,
        vec![QuotaGroup {
            id: "xai".to_string(),
            label: "Grok".to_string(),
            buckets,
        }],
    ))
}

fn identity_headers(account_id: &str) -> HashMap<String, String> {
    let mut headers = HashMap::new();
    headers.insert("x-xai-token-auth".to_string(), "xai-grok-cli".to_string());
    headers.insert(
        "x-grok-client-version".to_string(),
        GROK_CLIENT_VERSION.to_string(),
    );
    headers.insert(
        "user-agent".to_string(),
        format!(
            "grok-pager/{GROK_CLIENT_VERSION} grok-shell/{GROK_CLIENT_VERSION} ({}; {})",
            std::env::consts::OS,
            std::env::consts::ARCH
        ),
    );
    let account_id = account_id.trim();
    if !account_id.is_empty() {
        headers.insert("x-userid".to_string(), account_id.to_string());
    }
    headers
}

fn config_of(payload: &Value) -> &Value {
    payload
        .get("config")
        .filter(|value| value.is_object())
        .unwrap_or(payload)
}

fn weekly_buckets(payload: &Value) -> Vec<QuotaBucket> {
    let config = config_of(payload);
    let period = first_value(config, &["currentPeriod", "current_period"]);
    let reset_at_ms = parse_reset_ms(period.and_then(|period| period.get("end")));
    let period_is_weekly = period
        .and_then(|period| json_text(period.get("type")))
        .is_some_and(|kind| kind.to_lowercase().contains("weekly"));

    let mut buckets = Vec::new();
    // 统一账单为 proto3 JSON：零值标量会被省略，周用量为 0 时没有
    // creditUsagePercent。此时仍按 currentPeriod 判定周额度存在，百分比保持未知。
    let used = json_f64(first_value(
        config,
        &["creditUsagePercent", "credit_usage_percent"],
    ));
    if used.is_some() || period_is_weekly {
        buckets.push(QuotaBucket {
            key: "weekly".to_string(),
            label: String::new(),
            remaining_percent: used.map(remaining_from_used),
            reset_at_ms,
        });
    }

    for (index, (product, product_used)) in product_usage(config).into_iter().enumerate() {
        buckets.push(QuotaBucket {
            key: "model_weekly".to_string(),
            label: product.unwrap_or_else(|| format!("Product {}", index + 1)),
            remaining_percent: product_used.map(remaining_from_used),
            reset_at_ms,
        });
    }
    buckets
}

fn product_usage(config: &Value) -> Vec<(Option<String>, Option<f64>)> {
    let Some(items) = first_value(config, &["productUsage", "product_usage"]).and_then(Value::as_array)
    else {
        return Vec::new();
    };
    items
        .iter()
        .filter(|item| item.is_object())
        .map(|item| {
            (
                json_text(first_value(item, &["product", "name"])),
                json_f64(first_value(item, &["usagePercent", "usage_percent"])),
            )
        })
        .collect()
}

fn monthly_buckets(payload: &Value) -> Vec<QuotaBucket> {
    let config = config_of(payload);
    let usage = config.get("usage").filter(|value| value.is_object());
    let limit = cents(first_value(config, &["monthlyLimit", "monthly_limit"]));
    let used_total = cents(
        first_value(config, &["used"])
            .or_else(|| usage.and_then(|usage| first_value(usage, &["totalUsed", "total_used"]))),
    );
    let included = cents(
        usage.and_then(|usage| first_value(usage, &["includedUsed", "included_used"])),
    )
    .or_else(|| match (used_total, limit) {
        (Some(used), Some(limit)) if limit > 0.0 => Some(used.min(limit)),
        (Some(used), _) => Some(used),
        _ => None,
    });
    let reset = billing_reset(config);

    let mut buckets = Vec::new();
    if let (Some(included), Some(limit)) = (included, limit) {
        if limit > 0.0 {
            buckets.push(QuotaBucket {
                key: "monthly".to_string(),
                label: String::new(),
                remaining_percent: Some(remaining_from_used(included / limit * 100.0)),
                reset_at_ms: reset,
            });
        }
    }

    let cap = cents(first_value(config, &["onDemandCap", "on_demand_cap"]));
    let on_demand_used = cents(
        first_value(config, &["onDemandUsed", "on_demand_used"]).or_else(|| {
            usage.and_then(|usage| first_value(usage, &["onDemandUsed", "on_demand_used"]))
        }),
    )
    .or_else(|| match (used_total, limit) {
        (Some(used), Some(limit)) => Some((used - limit).max(0.0)),
        _ => None,
    });
    if let (Some(cap), Some(used)) = (cap, on_demand_used) {
        if cap > 0.0 {
            buckets.push(QuotaBucket {
                key: "on_demand".to_string(),
                label: String::new(),
                remaining_percent: Some(remaining_from_used(used / cap * 100.0)),
                reset_at_ms: reset,
            });
        }
    }
    buckets
}

/// 金额字段可能是数字，也可能是 `{ val / value }` 对象（单位为分）。
fn cents(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Object(record) => json_f64(record.get("val")).or_else(|| json_f64(record.get("value"))),
        other => json_f64(Some(other)),
    }
}

fn billing_reset(config: &Value) -> Option<f64> {
    let cycle = config
        .get("billingCycle")
        .or_else(|| config.get("billing_cycle"));
    parse_reset_ms(first_value(config, &["billingPeriodEnd", "billing_period_end"])).or_else(|| {
        parse_reset_ms(cycle.and_then(|cycle| {
            first_value(cycle, &["billingPeriodEnd", "billing_period_end"])
        }))
    })
}
