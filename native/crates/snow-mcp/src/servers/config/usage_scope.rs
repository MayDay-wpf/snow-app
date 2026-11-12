//! config 服务 `usage` 作用域（只读）：让 AI 读取用量与成本相关统计。
//!
//! 真源是应用数据库 `usage_records`（与 UI「用量统计」设置页同源），每次成功的
//! API 调用都会写入一行（模型、档案、请求方式、输入/输出/缓存 token、状态、
//! 是否子代理、所属目录）。本作用域只提供读取能力——删除用量记录属于数据治理
//! 操作，仍由 UI 完成。
//!
//! 日期参数接受 `YYYY-MM-DD`（自动补全为当天 00:00:00 / 23:59:59）或
//! `YYYY-MM-DD HH:MM:SS`；两者都省略时默认最近 30 天。可选参数 `profile`
//! 按 API 配置名称精确过滤（对应用量记录里的 `api_profile_name`）。

use std::path::Path;

use napi::bindgen_prelude::*;
use serde_json::{json, Value};

use crate::storage::services::usage_records::{
    get_usage_daily_breakdown, get_usage_model_breakdown, get_usage_summary, list_usage_records,
    DailyUsageBreakdown, ModelUsageBreakdown, UsageRecord, UsageSummary,
};

/// 默认统计窗口（天）：不传日期时使用。
const DEFAULT_WINDOW_DAYS: i64 = 30;
/// 每日明细最多返回的天数（约 3 个月），避免长窗口撑爆上下文。
const MAX_DAILY_ROWS: usize = 90;
/// 模型维度最多返回的条数（按 token 量倒序取前 N）。
const MAX_MODEL_ROWS: usize = 20;
/// 明细分页的默认与最大条数。
const DEFAULT_RECORD_LIMIT: i32 = 20;
const MAX_RECORD_LIMIT: i32 = 100;

const TOOL_GET: &str = "get";
const TOOL_SET: &str = "set";

fn today() -> chrono::NaiveDate {
    chrono::Local::now().date_naive()
}

/// `YYYY-MM-DD` → `YYYY-MM-DD 00:00:00`；带时间的值原样返回。
fn normalize_since(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.len() == 10 {
        format!("{trimmed} 00:00:00")
    } else {
        trimmed.to_string()
    }
}

/// `YYYY-MM-DD` → `YYYY-MM-DD 23:59:59`（含当天）；带时间的值原样返回。
fn normalize_until(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.len() == 10 {
        format!("{trimmed} 23:59:59")
    } else {
        trimmed.to_string()
    }
}

fn read_window(args: &Value) -> (String, String) {
    let since = args
        .get("since")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(normalize_since)
        .unwrap_or_else(|| {
            let start = today() - chrono::Duration::days(DEFAULT_WINDOW_DAYS);
            format!("{} 00:00:00", start.format("%Y-%m-%d"))
        });
    let until = args
        .get("until")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(normalize_until)
        .unwrap_or_else(|| format!("{} 23:59:59", today().format("%Y-%m-%d")));
    (since, until)
}

fn optional_arg<'a>(args: &'a Value, key: &str) -> &'a str {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
}

fn summary_json(summary: &UsageSummary) -> Value {
    json!({
        "totalInputTokens": summary.total_input_tokens,
        "totalOutputTokens": summary.total_output_tokens,
        "totalCacheCreationInputTokens": summary.total_cache_creation_input_tokens,
        "totalCacheReadInputTokens": summary.total_cache_read_input_tokens,
        "totalRequests": summary.total_requests,
        "errorRequests": summary.error_requests,
        "totalTokens": summary.total_tokens,
        "effectiveCacheReadTokens": summary.effective_cache_read_tokens,
        "nonCachedInputTokens": summary.non_cached_input_tokens,
    })
}

fn daily_json(row: &DailyUsageBreakdown) -> Value {
    json!({
        "date": row.date,
        "totalRequests": row.total_requests,
        "errorRequests": row.error_requests,
        "totalInputTokens": row.total_input_tokens,
        "totalOutputTokens": row.total_output_tokens,
        "totalCacheCreationInputTokens": row.total_cache_creation_input_tokens,
        "totalCacheReadInputTokens": row.total_cache_read_input_tokens,
        "totalTokens": row.total_tokens,
    })
}

fn model_json(row: &ModelUsageBreakdown) -> Value {
    json!({
        "model": row.model,
        "requestMethod": row.request_method,
        "totalRequests": row.total_requests,
        "errorRequests": row.error_requests,
        "totalInputTokens": row.total_input_tokens,
        "totalOutputTokens": row.total_output_tokens,
        "totalCacheCreationInputTokens": row.total_cache_creation_input_tokens,
        "totalCacheReadInputTokens": row.total_cache_read_input_tokens,
        "totalTokens": row.total_tokens,
    })
}

fn record_json(row: &UsageRecord) -> Value {
    json!({
        "id": row.id,
        "conversationId": row.conversation_id,
        "responseId": row.response_id,
        "model": row.model,
        "apiProfileName": row.api_profile_name,
        "requestMethod": row.request_method,
        "inputTokens": row.input_tokens,
        "outputTokens": row.output_tokens,
        "cacheCreationInputTokens": row.cache_creation_input_tokens,
        "cacheReadInputTokens": row.cache_read_input_tokens,
        "status": row.status,
        "isSubAgent": row.is_sub_agent,
        "directoryId": row.directory_id,
        "createdAt": row.created_at,
        "totalTokens": row.total_tokens,
    })
}

fn summary_payload(db_path: &Path, since: &str, until: &str, profile: &str) -> Result<Value> {
    let summary = get_usage_summary(db_path, since, until, profile)?;
    let daily = get_usage_daily_breakdown(db_path, since, until, profile)?;
    let daily_truncated = daily.len() > MAX_DAILY_ROWS;
    let models = get_usage_model_breakdown(db_path, since, until, profile)?;
    let model_truncated = models.len() > MAX_MODEL_ROWS;

    Ok(json!({
        "since": since,
        "until": until,
        "profile": profile,
        "summary": summary_json(&summary),
        "daily": daily.iter().take(MAX_DAILY_ROWS).map(daily_json).collect::<Vec<_>>(),
        "dailyTruncated": daily_truncated,
        "models": models.iter().take(MAX_MODEL_ROWS).map(model_json).collect::<Vec<_>>(),
        "modelsTruncated": model_truncated,
    }))
}

/// Dispatches the `config-manage` list/get actions for the `usage` scope (read-only).
pub(crate) fn execute_usage_scope(
    tool_name: &str,
    args: &Value,
    db_path: &Path,
) -> Result<Value> {
    match tool_name {
        "list" => {
            let (since, until) = read_window(args);
            let profile = optional_arg(args, "profile");
            Ok(json!({
                "scope": "usage",
                "file": null,
                "keys": [{
                    "key": "summary",
                    "type": "object",
                    "sensitive": false,
                    "configured": true,
                    "value": summary_payload(db_path, &since, &until, profile)?,
                }],
            }))
        }
        TOOL_GET => {
            let key = optional_arg(args, "key");
            let (since, until) = read_window(args);
            let profile = optional_arg(args, "profile");
            match key {
                "summary" => Ok(json!({
                    "scope": "usage",
                    "key": key,
                    "since": since,
                    "until": until,
                    "profile": profile,
                    "value": summary_json(&get_usage_summary(db_path, &since, &until, profile)?),
                })),
                "daily" => {
                    let rows = get_usage_daily_breakdown(db_path, &since, &until, profile)?;
                    let truncated = rows.len() > MAX_DAILY_ROWS;
                    Ok(json!({
                        "scope": "usage",
                        "key": key,
                        "since": since,
                        "until": until,
                        "profile": profile,
                        "truncated": truncated,
                        "value": rows.iter().take(MAX_DAILY_ROWS).map(daily_json).collect::<Vec<_>>(),
                    }))
                }
                "models" => {
                    let rows = get_usage_model_breakdown(db_path, &since, &until, profile)?;
                    let truncated = rows.len() > MAX_MODEL_ROWS;
                    Ok(json!({
                        "scope": "usage",
                        "key": key,
                        "since": since,
                        "until": until,
                        "profile": profile,
                        "truncated": truncated,
                        "value": rows.iter().take(MAX_MODEL_ROWS).map(model_json).collect::<Vec<_>>(),
                    }))
                }
                "records" => {
                    let limit = args
                        .get("limit")
                        .and_then(Value::as_i64)
                        .map(|value| value as i32)
                        .filter(|value| *value > 0)
                        .unwrap_or(DEFAULT_RECORD_LIMIT)
                        .min(MAX_RECORD_LIMIT);
                    let offset = args
                        .get("offset")
                        .and_then(Value::as_i64)
                        .map(|value| value as i32)
                        .filter(|value| *value > 0)
                        .unwrap_or(0);
                    let page = list_usage_records(
                        db_path,
                        optional_arg(args, "conversationId"),
                        optional_arg(args, "directoryId"),
                        profile,
                        limit,
                        offset,
                    )?;
                    Ok(json!({
                        "scope": "usage",
                        "key": key,
                        "limit": limit,
                        "offset": offset,
                        "total": page.total,
                        "value": page.items.iter().map(record_json).collect::<Vec<_>>(),
                    }))
                }
                "" => Err(Error::new(
                    Status::InvalidArg,
                    "usage requires a key: summary | daily | models | records".to_string(),
                )),
                other => Err(Error::new(
                    Status::InvalidArg,
                    format!(
                        "Unknown usage key \"{other}\"; supported keys: summary, daily, models, records"
                    ),
                )),
            }
        }
        TOOL_SET => Err(Error::new(
            Status::InvalidArg,
            "usage is a read-only scope; usage records are written by the app itself".to_string(),
        )),
        "delete" => Err(Error::new(
            Status::InvalidArg,
            "usage is a read-only scope; usage records can only be cleared from the app UI"
                .to_string(),
        )),
        other => Err(Error::new(
            Status::InvalidArg,
            format!("Unsupported config tool for scope usage: {other}"),
        )),
    }
}
