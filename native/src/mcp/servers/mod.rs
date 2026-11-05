use napi::{Error, Status};
use serde_json::Value;

pub mod app_control;
pub mod app_logs;
pub mod bash;
pub mod browser;
pub mod codebase;
pub mod computer_use;
pub mod config;
pub mod decision;
pub mod filesystem;
pub mod grep;
pub mod html_render;
pub mod imagegen;
pub mod lsp;
pub mod memory;
pub mod remote_workspace;
pub mod skills;
pub mod skills_config;
pub mod skills_installer;
pub mod skills_remote;
pub mod sub_agents;
pub mod terminal;
pub mod todo;
pub mod tool_search;
pub mod user_interaction;
pub mod websearch;
pub mod workflow;

/// 解析「单个 id 或 id 数组」形式的参数（memory / app-control 批量工具共用）。
/// 去除首尾空白与空值、按出现顺序去重；参数缺失、类型不符或全部为空时返回 InvalidArg。
pub(crate) fn id_list_arg(args: &Value, key: &str) -> napi::Result<Vec<String>> {
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
