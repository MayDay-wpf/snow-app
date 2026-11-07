//! 请求侧历史瘦身（Issue #223）：只改发往模型的副本，入库与界面数据不变。
//!
//! - 历史图片老化：图片总量未超预算时全部保留（不破坏缓存）；超预算时，
//!   最近 [`IMAGE_KEEP_USER_TURNS`] 个用户轮次之外的图片从最旧开始省略。
//! - TODO 结果精简：去掉时间戳等字段，已完成项过多时折叠为计数。

use std::collections::HashSet;
use std::path::Path;

use serde_json::{Map, Value};

use crate::storage::services::chat_conversations::ChatContextMessage;

use super::tool_messages::{has_image_tags, parse_tool_results_json};

const IMAGE_TAG_PREFIX: &str = "@@image:";
const IMAGE_KEEP_USER_TURNS: usize = 3;
/// 请求内图片总量预算（按发送体积估算，base64 前）。
const IMAGE_TOTAL_BUDGET_BYTES: u64 = 4 * 1024 * 1024;
/// PNG/JPEG 会被降采样，单张发送体积按此封顶估算（与 image_optimize 一致）。
const OPTIMIZED_IMAGE_CAP_BYTES: u64 = 1024 * 1024;
const TODO_TOOL_NAME: &str = "todo-todo-manage";
const TODO_COMPLETED_FOLD_THRESHOLD: usize = 20;
const TODO_COMPLETED_KEEP: usize = 10;

/// 图片按总量预算决定是否老化；TODO 结果精简是确定性变换，不影响缓存稳定。
pub(super) fn trim_history_for_request(messages: &mut [ChatContextMessage], database_path: &Path) {
    // 机器注入的宿主事实消息同样是 user 角色，但不是用户轮次：把它们算进图片保护
    // 窗口会把真正的最近几轮挤出窗口。
    let user_indices: Vec<usize> = messages
        .iter()
        .enumerate()
        .filter(|(_, message)| {
            message.role.trim() == "user"
                && !message
                    .content
                    .trim_start()
                    .starts_with(super::context::HOST_FACTS_MARKER)
        })
        .map(|(index, _)| index)
        .collect();
    let image_cutoff = if user_indices.len() > IMAGE_KEEP_USER_TURNS {
        user_indices[user_indices.len() - IMAGE_KEEP_USER_TURNS]
    } else {
        0
    };
    let aged_messages = select_aged_image_messages(messages, image_cutoff, database_path);

    for (index, message) in messages.iter_mut().enumerate() {
        let aged = aged_messages.contains(&index);
        match message.role.trim() {
            "user" if aged => {
                if let Some(content) = omit_image_tags(&message.content) {
                    message.content = content;
                }
            }
            "tool" => {
                let Some(raw) = message.tool_results_json.as_deref() else {
                    continue;
                };
                if let Some(updated) = trim_tool_results(raw, aged) {
                    message.tool_results_json = Some(updated);
                }
            }
            _ => {}
        }
    }
}

/// 超预算时才老化：保护窗口外从最旧的消息开始省略，直到总量回落到预算内。
/// 图片只增不减，未新增图片时选择结果不变，请求前缀保持稳定。
fn select_aged_image_messages(
    messages: &[ChatContextMessage],
    image_cutoff: usize,
    database_path: &Path,
) -> HashSet<usize> {
    let mut aged = HashSet::new();
    let sizes: Vec<(usize, u64)> = messages
        .iter()
        .enumerate()
        .filter_map(|(index, message)| {
            let bytes = message_image_bytes(message, database_path);
            (bytes > 0).then_some((index, bytes))
        })
        .collect();
    let mut total: u64 = sizes.iter().map(|(_, bytes)| *bytes).sum();
    for (index, bytes) in sizes {
        if total <= IMAGE_TOTAL_BUDGET_BYTES || index >= image_cutoff {
            break;
        }
        aged.insert(index);
        total = total.saturating_sub(bytes);
    }
    aged
}

fn message_image_bytes(message: &ChatContextMessage, database_path: &Path) -> u64 {
    match message.role.trim() {
        "user" => text_image_bytes(&message.content, database_path),
        "tool" => message.tool_results_json.as_deref().map_or(0, |raw| {
            if !raw.contains(IMAGE_TAG_PREFIX) {
                return 0;
            }
            parse_tool_results_json(raw)
                .iter()
                .filter(|(_, _, result)| has_image_tags(result))
                .map(|(_, _, result)| text_image_bytes(result, database_path))
                .sum()
        }),
        _ => 0,
    }
}

fn text_image_bytes(text: &str, database_path: &Path) -> u64 {
    image_tag_values(text)
        .map(|value| estimate_image_bytes(value, database_path))
        .sum()
}

fn image_tag_values<'a>(text: &'a str) -> impl Iterator<Item = &'a str> + 'a {
    let mut remaining = text;
    std::iter::from_fn(move || {
        let start = remaining.find(IMAGE_TAG_PREFIX)?;
        let value_start = start + IMAGE_TAG_PREFIX.len();
        let end = remaining[value_start..].find("@@")?;
        let value = remaining[value_start..value_start + end].trim();
        remaining = &remaining[value_start + end + 2..];
        Some(value)
    })
}

/// 估算单张图片发送体积；文件不可读时请求里也不会带它，按 0 计。
fn estimate_image_bytes(value: &str, database_path: &Path) -> u64 {
    if let Some(rest) = value.strip_prefix("data:") {
        let (metadata, data) = rest.split_once(',').unwrap_or(("", rest));
        let raw = (data.len() as u64) * 3 / 4;
        let optimizable =
            metadata.starts_with("image/png") || metadata.starts_with("image/jpeg");
        return if optimizable { raw.min(OPTIMIZED_IMAGE_CAP_BYTES) } else { raw };
    }
    let path = database_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(value);
    let Ok(metadata) = std::fs::metadata(&path) else {
        return 0;
    };
    let optimizable = path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .is_some_and(|extension| matches!(extension.as_str(), "png" | "jpg" | "jpeg"));
    if optimizable {
        metadata.len().min(OPTIMIZED_IMAGE_CAP_BYTES)
    } else {
        metadata.len()
    }
}

fn trim_tool_results(raw: &str, aged: bool) -> Option<String> {
    // 廉价预检：绝大多数工具消息无需改写，避免解析。
    let may_todo = raw.contains(TODO_TOOL_NAME);
    let may_image = aged && raw.contains(IMAGE_TAG_PREFIX);
    if !may_todo && !may_image {
        return None;
    }
    let Ok(Value::Array(mut entries)) = serde_json::from_str::<Value>(raw) else {
        return None;
    };

    let mut changed = false;
    for entry in entries.iter_mut() {
        let is_todo = entry.get("name").and_then(Value::as_str) == Some(TODO_TOOL_NAME);
        let Some(result) = entry.get("result").and_then(Value::as_str) else {
            continue;
        };
        let mut updated: Option<String> = None;
        if is_todo {
            updated = compact_todo_result(result);
        }
        if aged {
            let current = updated.as_deref().unwrap_or(result);
            if has_image_tags(current) {
                if let Some(next) = omit_image_tags(current) {
                    updated = Some(next);
                }
            }
        }
        if let Some(next) = updated {
            entry["result"] = Value::String(next);
            changed = true;
        }
    }

    if !changed {
        return None;
    }
    serde_json::to_string(&entries).ok()
}

/// 把 `@@image:...@@` 标签替换为文本占位；路径保留，便于模型按需重新读取。
fn omit_image_tags(text: &str) -> Option<String> {
    if !text.contains(IMAGE_TAG_PREFIX) {
        return None;
    }
    let mut output = String::with_capacity(text.len());
    let mut remaining = text;
    let mut changed = false;
    while let Some(start) = remaining.find(IMAGE_TAG_PREFIX) {
        let value_start = start + IMAGE_TAG_PREFIX.len();
        let Some(end) = remaining[value_start..].find("@@") else {
            break;
        };
        let value = remaining[value_start..value_start + end].trim();
        output.push_str(&remaining[..start]);
        if value.is_empty() || value.starts_with("data:") {
            output.push_str("[Earlier image omitted from context]");
        } else {
            output.push_str(&format!("[Earlier image omitted from context: {value}]"));
        }
        changed = true;
        remaining = &remaining[value_start + end + 2..];
    }
    output.push_str(remaining);
    changed.then_some(output)
}

/// TODO 结果仅保留 id/content/status/parentId；已完成项过多时只留最近几条。
fn compact_todo_result(result: &str) -> Option<String> {
    let Ok(Value::Object(mut object)) = serde_json::from_str::<Value>(result) else {
        return None;
    };
    let Some(Value::Array(items)) = object.remove("todos") else {
        return None;
    };

    let completed_total = items.iter().filter(|item| is_completed_todo(item)).count();
    let omitted = if completed_total > TODO_COMPLETED_FOLD_THRESHOLD {
        completed_total - TODO_COMPLETED_KEEP
    } else {
        0
    };

    let mut completed_seen = 0usize;
    let mut compact = Vec::with_capacity(items.len());
    for item in &items {
        if is_completed_todo(item) {
            completed_seen += 1;
            if completed_seen <= omitted {
                continue;
            }
        }
        compact.push(compact_todo_item(item));
    }

    object.insert("todos".to_string(), Value::Array(compact));
    if omitted > 0 {
        object.insert("omittedCompletedCount".to_string(), Value::from(omitted));
        object.insert(
            "note".to_string(),
            Value::String("Older completed TODO items are omitted from this view.".to_string()),
        );
    }
    serde_json::to_string(&Value::Object(object)).ok()
}

fn is_completed_todo(item: &Value) -> bool {
    item.get("status").and_then(Value::as_str) == Some("completed")
}

fn compact_todo_item(item: &Value) -> Value {
    let mut output = Map::new();
    for key in ["id", "content", "status", "parentId"] {
        if let Some(value) = item.get(key).filter(|value| !value.is_null()) {
            output.insert(key.to_string(), value.clone());
        }
    }
    Value::Object(output)
}
