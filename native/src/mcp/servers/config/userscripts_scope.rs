//! config 工具的 userscripts 域：AI 帮用户编写并安装油猴（Tampermonkey 兼容）脚本。
//!
//! 复用 `storage::userscripts` 完整存储层：解析 `// ==UserScript==` 元数据写入
//! 应用数据库（userscripts / userscript_values 表），脚本文件存
//! `~/.snowapp/browser-script/{script_id}.user.js`。
//!
//! key = script_id，`"new"` 表示新建。value 语义：
//! - { sourcePath: "<脚本源码文件绝对路径>" }：推荐。先用 filesystem-create /
//!   filesystem-replace_edit 把完整源码写到磁盘文件（长源码放文件里，避免
//!   工具参数过大溢出），再传路径安装；后端读取文件内容后新建/更新；
//! - { raw: "<完整脚本源码>" }：小脚本可直接内联（与 sourcePath 二选一）；
//! - { enabled: bool }：启用/禁用；
//! - { values: { k: v } }：批量写入 GM_* 持久化值；
//! - { deleteValues: ["k"] }：批量删除 GM_* 持久化值。
//!
//! AI 调用方的实际传参经常不规范（把字段对象序列化成 JSON 字符串、直接传
//! 脚本文件路径或内联源码字符串、`source_path`/`path` 等别名拼写），因此
//! [`set_userscript`] 入口先用 `normalize_set_value` 做归一化容错再分发，
//! 避免调用方反复收到 "value must be an object" 后陷入无脑重试循环。

use std::path::{Path, PathBuf};

use napi::bindgen_prelude::*;
use serde_json::{json, Value};

use crate::storage::{UserscriptRecord, UserscriptValue};

/// config-set 新建脚本时使用的占位 key。
const NEW_KEY: &str = "new";

/// config-list scope=userscripts：全部脚本元数据（不含源码）+ 安装引导。
pub fn list_userscripts(db_path: &Path) -> napi::Result<Value> {
    let records = crate::storage::list_userscripts(db_path).map_err(storage_error)?;
    let items: Vec<Value> = records.iter().map(record_to_json).collect();
    Ok(json!({
        "scope": "userscripts",
        "items": items,
        "count": items.len(),
        "guidance": "USERSCRIPTS (Tampermonkey-compatible) - install a userscript written for the user.\nRECOMMENDED INSTALL FLOW (avoids huge tool args): 1) write the full source to a file with filesystem-create (or edit it with filesystem-replace_edit), e.g. ./scripts/demo.user.js; 2) config-set scope=userscripts key=\"new\" value={sourcePath: \"/abs/path/to/demo.user.js\"} - the backend reads the file, parses // ==UserScript== metadata, writes the DB row and copies the file to ~/.snowapp/browser-script/{script_id}.user.js. UPDATE: edit the same file, then config-set scope=userscripts key=<existing scriptId> value={sourcePath: ...}. Small scripts may also be inlined with value={raw: \"...\"}.\nTOGGLE: config-set scope=userscripts key=<scriptId> value={enabled: true|false}\nGM VALUES (GM_getValue/GM_setValue persistence): config-set scope=userscripts key=<scriptId> value={values: {\"k\":\"v\"}}; remove one with value={deleteValues:[\"k\"]}\nREAD: config-get scope=userscripts key=<scriptId> (returns metadata + full source + GM values)\nLIST: config-list scope=userscripts\nUNINSTALL: config-delete scope=userscripts key=<scriptId> confirmed=true (deletes DB row + file)\nMANDATORY metadata header keys: @name and at least one @match (or @include). Also supported: @version, @description, @namespace, @author, @run-at (document-start|document-end|document-idle), @noframes, @grant, @exclude, @require, localized @name:zh-CN etc. When writing the script, keep the // ==UserScript== ... // ==/UserScript== block intact.",
    }))
}

/// config-get scope=userscripts key=<scriptId>：元数据 + 完整源码 + GM 值。
pub fn get_userscript(db_path: &Path, script_id: &str) -> napi::Result<Value> {
    let records = crate::storage::list_userscripts(db_path).map_err(storage_error)?;
    let Some(record) = records.iter().find(|r| r.script_id == script_id) else {
        return Ok(json!({
            "scope": "userscripts",
            "key": script_id,
            "value": Value::Null,
        }));
    };
    let source = crate::storage::read_userscript_source(db_path, script_id).map_err(storage_error)?;
    let values = crate::storage::get_userscript_values(db_path, script_id).map_err(storage_error)?;
    let mut item = match record_to_json(record) {
        Value::Object(map) => map,
        _ => serde_json::Map::new(),
    };
    item.insert("source".to_string(), json!(source));
    item.insert("values".to_string(), values_json(&values));
    Ok(json!({
        "scope": "userscripts",
        "key": script_id,
        "value": Value::Object(item),
    }))
}

/// config-set scope=userscripts。按 value 字段分发：
/// sourcePath | raw → 新建/更新；enabled → 开关；values → 批量写 GM 值；deleteValues → 批量删。
///
/// value 先经 [`normalize_set_value`] 归一化（兼容字符串化 JSON 对象、直接传
/// 脚本文件路径 / 内联源码、字段别名、enabled 字符串布尔），再按字段分发。
pub fn set_userscript(db_path: &Path, key: &str, value: &Value) -> napi::Result<Value> {
    let obj = normalize_set_value(value)?;

    // 源码来源：sourcePath（推荐，从磁盘文件读取，避免大工具参数）或 raw（内联），二选一。
    if obj.contains_key("sourcePath") {
        let source_path = obj
            .get("sourcePath")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .ok_or_else(|| {
                Error::new(
                    Status::InvalidArg,
                    "sourcePath must be a non-empty string path to a script file".to_string(),
                )
            })?;
        let source = read_source_file(source_path)?;
        let created = key == NEW_KEY;
        let record = if created {
            crate::storage::create_userscript(db_path, &source).map_err(storage_error)?
        } else {
            ensure_script_exists(db_path, key)?;
            crate::storage::update_userscript(db_path, key, &source).map_err(storage_error)?
        };
        return Ok(json!({
            "scope": "userscripts",
            "key": record.script_id,
            "saved": true,
            "created": created,
            "script": record_to_json(&record),
            "filePath": record.file_path,
        }));
    }

    if let Some(raw) = obj
        .get("raw")
        .and_then(Value::as_str)
        .filter(|raw| !raw.trim().is_empty())
    {
        let source = raw.to_string();
        let created = key == NEW_KEY;
        let record = if created {
            crate::storage::create_userscript(db_path, &source).map_err(storage_error)?
        } else {
            ensure_script_exists(db_path, key)?;
            crate::storage::update_userscript(db_path, key, &source).map_err(storage_error)?
        };
        return Ok(json!({
            "scope": "userscripts",
            "key": record.script_id,
            "saved": true,
            "created": created,
            "script": record_to_json(&record),
            "filePath": record.file_path,
        }));
    }

    if let Some(enabled) = obj.get("enabled").and_then(parse_bool_field) {
        ensure_script_exists(db_path, key)?;
        crate::storage::set_userscript_enabled(db_path, key, enabled).map_err(storage_error)?;
        return Ok(json!({
            "scope": "userscripts",
            "key": key,
            "saved": true,
            "enabled": enabled,
        }));
    }

    if let Some(values) = obj.get("values") {
        ensure_script_exists(db_path, key)?;
        let parsed = unwrap_json_string(values);
        if let Some(map) = parsed.as_object() {
            for (name, raw) in map {
                let stored = match raw {
                    Value::String(text) => text.clone(),
                    Value::Null => String::new(),
                    other => other.to_string(),
                };
                crate::storage::set_userscript_value(db_path, key, name, &stored)
                    .map_err(storage_error)?;
            }
        }
        return Ok(json!({
            "scope": "userscripts",
            "key": key,
            "saved": true,
            "valuesWritten": parsed.as_object().map(|m| m.len()).unwrap_or(0),
        }));
    }

    if let Some(delete_values) = obj.get("deleteValues") {
        ensure_script_exists(db_path, key)?;
        let parsed = unwrap_json_string(delete_values);
        let mut deleted = 0usize;
        if let Some(names) = parsed.as_array() {
            for item in names {
                if let Some(name) = item.as_str() {
                    crate::storage::delete_userscript_value(db_path, key, name)
                        .map_err(storage_error)?;
                    deleted += 1;
                }
            }
        }
        return Ok(json!({
            "scope": "userscripts",
            "key": key,
            "saved": true,
            "valuesDeleted": deleted,
        }));
    }

    let fields: Vec<&str> = obj.keys().map(String::as_str).collect();
    Err(Error::new(
        Status::InvalidArg,
        format!(
            "value for the userscripts scope must contain one of: `sourcePath` (absolute path to a .user.js file on disk — recommended: write the script with the filesystem server first, then pass its path), `raw` (full inline userscript source), `enabled` (bool), `values` (GM values object), `deleteValues` (array of GM value keys). Received object fields: {fields:?}"
        ),
    ))
}

/// config-delete scope=userscripts key=<scriptId>：删除 DB 记录 + 脚本文件
/// （confirmed 由 config-delete 统一入口校验）。
pub fn delete_userscript(db_path: &Path, script_id: &str) -> napi::Result<Value> {
    let records = crate::storage::list_userscripts(db_path).map_err(storage_error)?;
    let exists = records.iter().any(|r| r.script_id == script_id);
    if exists {
        crate::storage::delete_userscript(db_path, script_id).map_err(storage_error)?;
    }
    Ok(json!({
        "scope": "userscripts",
        "key": script_id,
        "deleted": exists,
    }))
}

/// 把 AI 调用方传出的 value 归一化为字段对象：
/// - 对象：经 [`normalize_field_aliases`] 做字段名归一化后返回；
/// - 字符串：
///   - `{...}` 形态且可解析 → 视为被二次序列化的字段对象，解析后按对象处理；
///   - 含 `==UserScript==` 头 → `{raw: <源码>}`；
///   - 不含换行且指向磁盘上存在的文件、或 `.js` 结尾 → `{sourcePath: <路径>}`；
/// - 其他形态 → 报错并附收到的内容预览与正确用法，让调用方能自我纠正。
fn normalize_set_value(value: &Value) -> napi::Result<serde_json::Map<String, Value>> {
    match value {
        Value::Object(map) => Ok(normalize_field_aliases(map)),
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.starts_with('{') && trimmed.ends_with('}') {
                if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(trimmed) {
                    return Ok(normalize_field_aliases(&map));
                }
            }
            if trimmed.contains("==UserScript==") {
                return Ok(single_field_map("raw", json!(text)));
            }
            if !trimmed.is_empty() && !trimmed.contains('\n') && !trimmed.contains('\r') {
                let path = resolve_source_path(trimmed);
                if path.is_file() || trimmed.to_ascii_lowercase().ends_with(".js") {
                    return Ok(single_field_map("sourcePath", json!(trimmed)));
                }
            }
            Err(invalid_value_error(value))
        }
        other => Err(invalid_value_error(other)),
    }
}

/// 字段名别名归一化：AI 调用方常把 `sourcePath` 写成 snake_case 或近义词，
/// 把 `enabled` 写成 `enable`，统一映射为规范字段名。
fn normalize_field_aliases(
    map: &serde_json::Map<String, Value>,
) -> serde_json::Map<String, Value> {
    let mut result = serde_json::Map::new();
    for (field, val) in map {
        let canonical = match field.as_str() {
            "source_path" | "path" | "filePath" | "file_path" | "file" => "sourcePath",
            "enable" => "enabled",
            other => other,
        };
        result.insert(canonical.to_string(), val.clone());
    }
    result
}

/// 解析 `enabled` 字段：兼容 bool 与 `"true"`/`"false"` 字符串传参。
fn parse_bool_field(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(flag) => Some(*flag),
        Value::String(text) => match text.trim().to_ascii_lowercase().as_str() {
            "true" => Some(true),
            "false" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

/// 构造单字段对象，如 `{sourcePath: "..."}`。
fn single_field_map(field: &str, value: Value) -> serde_json::Map<String, Value> {
    let mut map = serde_json::Map::new();
    map.insert(field.to_string(), value);
    map
}

/// 字段值容错：若是被二次序列化成 JSON 字符串的对象/数组则解析还原，
/// 否则原样克隆返回。
fn unwrap_json_string(value: &Value) -> Value {
    match value {
        Value::String(text) => {
            let trimmed = text.trim();
            if (trimmed.starts_with('{') && trimmed.ends_with('}'))
                || (trimmed.starts_with('[') && trimmed.ends_with(']'))
            {
                serde_json::from_str::<Value>(trimmed).unwrap_or_else(|_| value.clone())
            } else {
                value.clone()
            }
        }
        other => other.clone(),
    }
}

/// 构造 userscripts scope 的 value 参数错误：附收到的形态预览与正确用法示例，
/// 让 AI 调用方能根据报错自我纠正而不是反复原样重试。
fn invalid_value_error(received: &Value) -> napi::Error {
    let received_desc = match received {
        Value::String(text) => {
            let preview: String = text.chars().take(80).collect();
            format!("a string of {} chars starting with {preview:?}", text.chars().count())
        }
        other => {
            let serialized =
                serde_json::to_string(other).unwrap_or_else(|_| other.to_string());
            let preview: String = serialized.chars().take(80).collect();
            format!("{preview}")
        }
    };
    Error::new(
        Status::InvalidArg,
        format!(
            "value for the userscripts scope must be an object with one of: sourcePath (recommended; absolute path to a .user.js file on disk, e.g. value={{sourcePath: \"C:/abs/path/script.user.js\"}}), raw (full inline userscript source), enabled (bool), values (object of GM_* values), deleteValues (array of keys). Received {received_desc}"
        ),
    )
}

fn ensure_script_exists(db_path: &Path, script_id: &str) -> napi::Result<()> {
    let records = crate::storage::list_userscripts(db_path).map_err(storage_error)?;
    if records.iter().any(|r| r.script_id == script_id) {
        return Ok(());
    }
    Err(Error::new(
        Status::InvalidArg,
        format!(
            "Unknown userscript: \"{script_id}\". To create a new script use key=\"{NEW_KEY}\" with value={{sourcePath: \"<abs path>\"}} or value={{raw: \"...\"}}"
        ),
    ))
}

/// 从磁盘文件读取脚本源码（推荐方式，避免工具参数过大）。
/// 支持绝对路径、`~/` 开头（home 目录）、相对路径（基于当前工作目录）。
fn read_source_file(source_path: &str) -> napi::Result<String> {
    let path = resolve_source_path(source_path);
    std::fs::read_to_string(&path).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!(
                "Failed to read userscript source file '{}': {error}",
                path.display()
            ),
        )
    })
}

fn resolve_source_path(source_path: &str) -> PathBuf {
    let trimmed = source_path.trim();
    let path = Path::new(trimmed);
    if path.is_absolute() {
        return path.to_path_buf();
    }
    if let Some(rest) = trimmed.strip_prefix("~/") {
        if let Some(home) = dirs_next::home_dir() {
            return home.join(rest);
        }
    }
    // 相对路径：基于当前工作目录解析
    std::env::current_dir()
        .map(|cwd| cwd.join(path))
        .unwrap_or_else(|_| path.to_path_buf())
}

fn record_to_json(record: &UserscriptRecord) -> Value {
    json!({
        "scriptId": record.script_id,
        "name": record.name,
        "version": record.version,
        "description": record.description,
        "namespace": record.namespace,
        "author": record.author,
        "enabled": record.enabled,
        "runAt": record.run_at,
        "noframes": record.noframes,
        "grant": record.grant,
        "matches": record.matches,
        "includes": record.includes,
        "excludes": record.excludes,
        "requires": record.requires,
        "filePath": record.file_path,
        "createdAt": record.created_at,
        "updatedAt": record.updated_at,
    })
}

fn values_json(values: &[UserscriptValue]) -> Value {
    let map: serde_json::Map<String, Value> = values
        .iter()
        .map(|item| (item.key.clone(), json!(item.value)))
        .collect();
    Value::Object(map)
}

fn storage_error(error: napi::Error) -> napi::Error {
    Error::new(
        Status::GenericFailure,
        format!("userscripts storage error: {error}"),
    )
}
