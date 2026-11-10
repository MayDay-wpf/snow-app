//! config `memos` 作用域：当前项目备忘录的增删改查（memos 表，与备忘面板同源）。
//! 严格按 projectId（会话自动注入）隔离，跨项目的 memoId 一律视为不存在。

use std::path::Path;

use napi::bindgen_prelude::*;
use serde_json::{json, Map, Value};

use crate::storage::services::memos::{
    create_memo, delete_memos_by_ids, get_memo, list_memos, update_memo_content,
    update_memo_status,
};
use crate::storage::MemoRecord;

const SCOPE_NAME: &str = "memos";
const NEW_KEY: &str = "new";
const STATUS_PENDING: &str = "pending";
const STATUS_DONE: &str = "done";
const PAGE_SIZE: i32 = 200;
/// 单次列出上限（与旧 app-control 行为一致）。
const MAX_ITEMS: usize = 1000;

const GUIDANCE: &str = "MEMOS - notes of the CURRENT project (memo panel, same source as the UI; project sessions inject projectId automatically, other projects are never visible). config-manage action=list scope=memos returns every memo with full content; config-manage action=get key=<memoId> reads one memo, key=pending|done|all returns a filtered list; config-manage action=set key=\"new\" value={content} creates a memo (status pending); config-manage action=set key=<memoId> value={status?: \"pending\"|\"done\", content?} updates it (mark done after executing its content); config-manage action=delete key=<memoId> (or comma-separated memoIds) confirmed=true deletes permanently - the whole batch is refused if any id is not in the current project; prefer status done when the memo may still be useful.";

fn storage_error(error: Error) -> Error {
    Error::new(
        Status::GenericFailure,
        format!("memos storage error: {error}"),
    )
}

fn require_project(project_id: Option<&str>) -> Result<&str> {
    project_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                "memos are project-scoped and require a projectId (project sessions inject the current project automatically)".to_string(),
            )
        })
}

fn memo_json(record: &MemoRecord) -> Value {
    json!({
        "memoId": record.memo_id,
        "content": record.content,
        "status": record.status,
        "createdAt": record.created_at,
        "updatedAt": record.updated_at,
    })
}

fn load_all(db_path: &Path, project_id: &str, status: Option<&str>) -> Result<Vec<MemoRecord>> {
    let mut items = Vec::new();
    let mut offset = 0;
    loop {
        let page = list_memos(db_path, project_id, PAGE_SIZE, offset, status, None, None, None)
            .map_err(storage_error)?;
        let fetched = page.items.len() as i32;
        items.extend(page.items);
        if !page.has_more || fetched == 0 || items.len() >= MAX_ITEMS {
            break;
        }
        offset += fetched;
    }
    items.truncate(MAX_ITEMS);
    Ok(items)
}

/// 读取并校验归属当前项目，跨项目返回 None。
fn find_own(db_path: &Path, project_id: &str, memo_id: &str) -> Result<Option<MemoRecord>> {
    let record = get_memo(db_path, memo_id).map_err(storage_error)?;
    Ok(record.filter(|memo| memo.directory_id.trim() == project_id))
}

fn not_found(memo_id: &str) -> Error {
    Error::new(
        Status::InvalidArg,
        format!("Memo not found in the current project: {memo_id}"),
    )
}

fn parse_status(raw: &str) -> Result<&'static str> {
    match raw.trim().to_ascii_lowercase().as_str() {
        STATUS_PENDING => Ok(STATUS_PENDING),
        STATUS_DONE => Ok(STATUS_DONE),
        other => Err(Error::new(
            Status::InvalidArg,
            format!("memo status must be \"pending\" or \"done\", received \"{other}\""),
        )),
    }
}

fn list_view(db_path: &Path, project_id: &str, status: Option<&str>) -> Result<Value> {
    let items = load_all(db_path, project_id, status)?;
    let pending = items.iter().filter(|memo| memo.status == STATUS_PENDING).count();
    Ok(json!({
        "scope": SCOPE_NAME,
        "projectId": project_id,
        "status": status,
        "count": items.len(),
        "pending": pending,
        "done": items.len() - pending,
        "items": items.iter().map(memo_json).collect::<Vec<_>>(),
        "guidance": GUIDANCE,
    }))
}

fn get_view(db_path: &Path, project_id: &str, key: &str) -> Result<Value> {
    match key.to_ascii_lowercase().as_str() {
        "all" => return list_view(db_path, project_id, None),
        STATUS_PENDING => return list_view(db_path, project_id, Some(STATUS_PENDING)),
        STATUS_DONE => return list_view(db_path, project_id, Some(STATUS_DONE)),
        _ => {}
    }
    let found = find_own(db_path, project_id, key)?;
    Ok(json!({
        "scope": SCOPE_NAME,
        "key": key,
        "value": found.as_ref().map(memo_json).unwrap_or(Value::Null),
    }))
}

/// value 归一化为对象；纯文本视为 content。
fn normalize_fields(value: &Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map.clone(),
        Value::String(text) => {
            let mut map = Map::new();
            map.insert("content".to_string(), json!(text));
            map
        }
        Value::Null => Map::new(),
        other => {
            let mut map = Map::new();
            map.insert("content".to_string(), json!(other.to_string()));
            map
        }
    }
}

fn read_content(fields: &Map<String, Value>) -> Option<String> {
    fields
        .get("content")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn set_memo(db_path: &Path, project_id: &str, key: &str, value: &Value) -> Result<Value> {
    let fields = normalize_fields(value);
    let content = read_content(&fields);

    if key.eq_ignore_ascii_case(NEW_KEY) {
        let content = content.ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                "value.content is required to create a memo (config-manage action=set scope=memos key=\"new\" value={content: \"...\"})".to_string(),
            )
        })?;
        let created = create_memo(db_path, project_id, &content).map_err(storage_error)?;
        return Ok(json!({
            "scope": SCOPE_NAME,
            "key": NEW_KEY,
            "saved": true,
            "created": true,
            "memoId": created.memo_id,
            "value": memo_json(&created),
        }));
    }

    let status = fields
        .get("status")
        .and_then(Value::as_str)
        .map(parse_status)
        .transpose()?;
    if status.is_none() && content.is_none() {
        return Err(Error::new(
            Status::InvalidArg,
            "value must contain status (\"pending\"|\"done\") and/or content to update a memo".to_string(),
        ));
    }
    if find_own(db_path, project_id, key)?.is_none() {
        return Err(not_found(key));
    }

    let mut updated = None;
    if let Some(content) = content {
        updated = Some(update_memo_content(db_path, key, &content).map_err(storage_error)?);
    }
    if let Some(status) = status {
        updated = Some(update_memo_status(db_path, key, status).map_err(storage_error)?);
    }
    Ok(json!({
        "scope": SCOPE_NAME,
        "key": key,
        "saved": true,
        "created": false,
        "value": updated.as_ref().map(memo_json).unwrap_or(Value::Null),
    }))
}

fn delete_memos(db_path: &Path, project_id: &str, key: &str) -> Result<Value> {
    let memo_ids: Vec<String> = key
        .split(',')
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .collect();
    if memo_ids.is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            "memos delete requires key = memoId (or comma-separated memoIds)".to_string(),
        ));
    }
    // 整批校验后再删，任一不属于当前项目则全部拒绝。
    let mut missing = Vec::new();
    for memo_id in &memo_ids {
        if find_own(db_path, project_id, memo_id)?.is_none() {
            missing.push(memo_id.clone());
        }
    }
    if !missing.is_empty() {
        return Err(not_found(&missing.join(", ")));
    }
    let deleted = delete_memos_by_ids(db_path, &memo_ids).map_err(storage_error)?;
    Ok(json!({
        "scope": SCOPE_NAME,
        "key": key,
        "deleted": deleted > 0,
        "deletedCount": deleted,
        "memoIds": memo_ids,
    }))
}

pub(crate) fn execute_memos_scope(
    tool_name: &str,
    args: &Value,
    db_path: &Path,
    project_id: Option<&str>,
) -> Result<Value> {
    let project_id = require_project(project_id)?;
    let key = args
        .get("key")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if tool_name != "list" && key.is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            format!("memos requires key = memoId (or \"{NEW_KEY}\" for action=set)"),
        ));
    }

    match tool_name {
        "list" => list_view(db_path, project_id, None),
        "get" => get_view(db_path, project_id, key),
        "set" => {
            let value = args.get("value").cloned().unwrap_or(Value::Null);
            set_memo(db_path, project_id, key, &value)
        }
        "delete" => delete_memos(db_path, project_id, key),
        other => Err(Error::new(
            Status::InvalidArg,
            format!("Unsupported config tool for scope memos: {other}"),
        )),
    }
}
