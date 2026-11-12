//! 内置 MCP 工具服务器实现。

pub mod app_logs;
pub mod memory;
pub mod scope;
pub mod terminal;
pub mod todo;

use std::path::PathBuf;

use napi::bindgen_prelude::*;
use napi::{Error, Status};
use serde_json::Value;

/// 在阻塞线程上准备数据库路径后执行操作。
pub async fn with_database_path<T, F>(operation: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce(PathBuf) -> Result<T> + Send + 'static,
{
    tokio::task::spawn_blocking(move || {
        let database_path = snow_storage_core::bootstrap::ensure_database_file()?;
        operation(database_path)
    })
    .await
    .map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to access project MCP scope storage: {error}"),
        )
    })?
}

/// 解析「单个 id 或 id 数组」形式的参数：去空白、去空值、按序去重。
pub fn id_list_arg(args: &Value, key: &str) -> napi::Result<Vec<String>> {
    let invalid = || {
        Error::new(
            Status::InvalidArg,
            format!("Missing or invalid parameter: {key} (a non-empty string or an array of non-empty strings)"),
        )
    };
    let raw: Vec<&str> = match args.get(key) {
        Some(Value::String(id)) => vec![id.as_str()],
        Some(Value::Array(items)) => {
            let mut collected = Vec::with_capacity(items.len());
            for item in items {
                collected.push(item.as_str().ok_or_else(invalid)?);
            }
            collected
        }
        _ => return Err(invalid()),
    };

    let mut ids: Vec<String> = Vec::new();
    for id in raw.into_iter().map(str::trim).filter(|id| !id.is_empty()) {
        if !ids.iter().any(|existing| existing == id) {
            ids.push(id.to_string());
        }
    }
    if ids.is_empty() {
        return Err(invalid());
    }
    Ok(ids)
}
