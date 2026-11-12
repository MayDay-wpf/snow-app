//! 远控快照的增量补丁：只下发变化的部分，移动端按同一规则还原。
//!
//! 补丁节点（每个节点只含一种标记）：
//! - `{"r": v}` 整体替换
//! - `{"a": "s"}` 字符串追加（流式正文）
//! - `{"p": [..]}` 数组尾部追加
//! - `{"o": {k: patch}, "d": [k]}` 对象逐键更新 / 删除
//! - `{"k": key, "i": {id: patch}, "l": [id]}` 按主键对齐的数组；`l` 仅在顺序或成员变化时出现

use std::collections::HashSet;

use serde_json::{json, Map, Value};

/// 数组元素主键候选（按优先级）。
const ARRAY_KEYS: [&str; 5] = ["id", "interactionId", "conversationId", "questionId", "memoryId"];

/// 计算 old → new 的补丁；相等时返回 None。
pub fn diff(old: &Value, new: &Value) -> Option<Value> {
    match (old, new) {
        (Value::Object(left), Value::Object(right)) => diff_object(left, right),
        (Value::String(left), Value::String(right)) => {
            if left == right {
                None
            } else if right.starts_with(left.as_str()) {
                Some(json!({ "a": &right[left.len()..] }))
            } else {
                Some(json!({ "r": right }))
            }
        }
        (Value::Array(left), Value::Array(right)) => diff_array(left, right),
        _ => {
            if old == new {
                None
            } else {
                Some(json!({ "r": new }))
            }
        }
    }
}

fn diff_object(left: &Map<String, Value>, right: &Map<String, Value>) -> Option<Value> {
    let mut changed = Map::new();
    for (key, next) in right {
        match left.get(key) {
            Some(previous) => {
                if let Some(patch) = diff(previous, next) {
                    changed.insert(key.clone(), patch);
                }
            }
            None => {
                changed.insert(key.clone(), json!({ "r": next }));
            }
        }
    }
    let removed: Vec<&String> = left.keys().filter(|key| !right.contains_key(*key)).collect();
    if changed.is_empty() && removed.is_empty() {
        return None;
    }
    let mut patch = Map::new();
    patch.insert("o".to_string(), Value::Object(changed));
    if !removed.is_empty() {
        patch.insert("d".to_string(), json!(removed));
    }
    Some(Value::Object(patch))
}

fn diff_array(left: &[Value], right: &[Value]) -> Option<Value> {
    if left == right {
        return None;
    }
    if right.len() > left.len() && right[..left.len()] == *left {
        return Some(json!({ "p": &right[left.len()..] }));
    }
    let Some(key) = array_key(left, right) else {
        return Some(json!({ "r": right }));
    };
    let id_of = |item: &Value| -> String {
        item.get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let previous: std::collections::HashMap<String, &Value> =
        left.iter().map(|item| (id_of(item), item)).collect();
    let mut items = Map::new();
    for item in right {
        let id = id_of(item);
        match previous.get(&id) {
            Some(old) => {
                if let Some(patch) = diff(old, item) {
                    items.insert(id, patch);
                }
            }
            None => {
                items.insert(id, json!({ "r": item }));
            }
        }
    }
    let same_order = left.len() == right.len()
        && left.iter().zip(right).all(|(a, b)| id_of(a) == id_of(b));
    let mut patch = Map::new();
    patch.insert("k".to_string(), Value::String(key.to_string()));
    patch.insert("i".to_string(), Value::Object(items));
    if !same_order {
        patch.insert(
            "l".to_string(),
            Value::Array(right.iter().map(|item| Value::String(id_of(item))).collect()),
        );
    }
    Some(Value::Object(patch))
}

/// 两侧元素都是带唯一字符串主键的对象时返回该主键。
fn array_key(left: &[Value], right: &[Value]) -> Option<&'static str> {
    if left.is_empty() || right.is_empty() {
        return None;
    }
    ARRAY_KEYS
        .into_iter()
        .find(|key| unique_keys(left, key) && unique_keys(right, key))
}

fn unique_keys(items: &[Value], key: &str) -> bool {
    let mut seen = HashSet::with_capacity(items.len());
    items.iter().all(|item| {
        item.get(key)
            .and_then(Value::as_str)
            .map(|id| seen.insert(id))
            .unwrap_or(false)
    })
}
