//! config 服务 `requestLogging` 作用域：请求日志开关与自动过期时间。
//!
//! 真源是应用数据库 `system_settings`（与 UI「系统日志」设置页同源）：
//! `request_logging` 保存开关，`request_logging_expires_at` 保存自动关闭时间
//! （Unix epoch 毫秒，0 表示未设置）。Rust 的记录路径会拒绝超过过期时间的
//! 写入并自动复位开关，因此开启时必须给出过期时间——避免 AI 或用户打开日志
//! 后忘记关闭、持续把请求体写进磁盘。
//!
//! key = `settings`（单例）。

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use napi::bindgen_prelude::*;
use serde_json::{json, Value};

use crate::storage::services::system_settings::{
    get_request_logging, get_request_logging_expiry, set_request_logging,
    set_request_logging_expiry,
};

/// 单例键：本作用域只有一个设置对象。
const REQUEST_LOGGING_KEY: &str = "settings";
/// 未指定过期时间时默认开启时长（分钟）。
const DEFAULT_EXPIRES_IN_MINUTES: i64 = 5;
const MIN_EXPIRES_IN_MINUTES: i64 = 1;
/// 上限 30 分钟：请求/响应体仅用于短时排障，避免日志长期留存。
const MAX_EXPIRES_IN_MINUTES: i64 = 30;

const TOOL_GET: &str = "get";
const TOOL_SET: &str = "set";

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn to_iso_utc(ms: i64) -> Option<String> {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ms).map(|value| value.to_rfc3339())
}

fn read_state(db_path: &Path) -> Result<Value> {
    let enabled = get_request_logging(db_path)?;
    let expires_at = get_request_logging_expiry(db_path)?;
    let now = now_ms();
    let expired = enabled && expires_at > 0 && expires_at <= now;
    let remaining_seconds = if enabled && expires_at > now {
        (expires_at - now) / 1000
    } else {
        0
    };

    Ok(json!({
        "enabled": enabled,
        "expiresAt": expires_at,
        "expiresAtIso": if expires_at > 0 { to_iso_utc(expires_at) } else { None },
        "remainingSeconds": remaining_seconds,
        "expired": expired,
    }))
}

fn read_positive_i64(value: &Value, key: &str) -> Result<Option<i64>> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(number)) => number.as_i64().map(Some).ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                format!("{key} must be an integer timestamp in milliseconds"),
            )
        }),
        Some(other) => Err(Error::new(
            Status::InvalidArg,
            format!("{key} must be a number, got: {other}"),
        )),
    }
}

fn apply_settings(db_path: &Path, value: &Value) -> Result<Value> {
    let Some(object) = value.as_object() else {
        return Err(Error::new(
            Status::InvalidArg,
            "requestLogging value must be an object like { enabled: true, expiresInMinutes: 30 }"
                .to_string(),
        ));
    };

    let enabled = object
        .get("enabled")
        .and_then(Value::as_bool)
        .ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                "requestLogging value requires a boolean `enabled` field".to_string(),
            )
        })?;

    if !enabled {
        // 关闭时同步清空过期时间，避免残留时间戳让后续读取误判为"仍会开启"。
        set_request_logging(db_path, false)?;
        set_request_logging_expiry(db_path, 0)?;
        return Ok(json!({
            "scope": "requestLogging",
            "key": REQUEST_LOGGING_KEY,
            "changed": { "enabled": false, "expiresAt": 0 },
            "state": read_state(db_path)?,
        }));
    }

    let now = now_ms();
    let expires_at = match read_positive_i64(value, "expiresAt")? {
        Some(expires_at) => {
            if expires_at <= now {
                return Err(Error::new(
                    Status::InvalidArg,
                    "expiresAt must be in the future (Unix epoch milliseconds)".to_string(),
                ));
            }
            expires_at
        }
        None => {
            let minutes = match read_positive_i64(value, "expiresInMinutes")? {
                Some(minutes) => minutes,
                None => DEFAULT_EXPIRES_IN_MINUTES,
            };
            if !(MIN_EXPIRES_IN_MINUTES..=MAX_EXPIRES_IN_MINUTES).contains(&minutes) {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!(
                        "expiresInMinutes must be between {MIN_EXPIRES_IN_MINUTES} and {MAX_EXPIRES_IN_MINUTES}"
                    ),
                ));
            }
            now + minutes * 60 * 1000
        }
    };

    // 先写过期时间再开开关：即使中途失败也不会出现"开启但无过期时间"的状态。
    set_request_logging_expiry(db_path, expires_at)?;
    set_request_logging(db_path, true)?;

    Ok(json!({
        "scope": "requestLogging",
        "key": REQUEST_LOGGING_KEY,
        "changed": { "enabled": true, "expiresAt": expires_at },
        "state": read_state(db_path)?,
    }))
}

/// Dispatches the `config-manage` list/get/set/delete actions for the `requestLogging` scope.
pub(crate) fn execute_request_logging_scope(
    tool_name: &str,
    args: &Value,
    db_path: &Path,
) -> Result<Value> {
    match tool_name {
        "list" => Ok(json!({
            "scope": "requestLogging",
            "file": null,
            "keys": [{
                "key": REQUEST_LOGGING_KEY,
                "type": "object",
                "sensitive": false,
                "configured": true,
                "value": read_state(db_path)?,
            }],
        })),
        TOOL_GET => {
            let key = args.get("key").and_then(Value::as_str).unwrap_or("");
            if key != REQUEST_LOGGING_KEY {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!("requestLogging only defines the key \"{REQUEST_LOGGING_KEY}\""),
                ));
            }
            Ok(json!({
                "scope": "requestLogging",
                "key": key,
                "value": read_state(db_path)?,
            }))
        }
        TOOL_SET => {
            let key = args.get("key").and_then(Value::as_str).unwrap_or("");
            if key != REQUEST_LOGGING_KEY {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!("requestLogging only defines the key \"{REQUEST_LOGGING_KEY}\""),
                ));
            }
            let value = args.get("value").cloned().ok_or_else(|| {
                Error::new(
                    Status::InvalidArg,
                    "value is required for action=set".to_string(),
                )
            })?;
            apply_settings(db_path, &value)
        }
        "delete" => Err(Error::new(
            Status::InvalidArg,
            "requestLogging does not support delete; use action=set with {\"enabled\": false} to turn logging off".to_string(),
        )),
        other => Err(Error::new(
            Status::InvalidArg,
            format!("Unsupported config tool for scope requestLogging: {other}"),
        )),
    }
}
