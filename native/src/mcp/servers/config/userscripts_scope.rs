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
pub fn set_userscript(db_path: &Path, key: &str, value: &Value) -> napi::Result<Value> {
    let obj = value.as_object().ok_or_else(|| {
        Error::new(
            Status::InvalidArg,
            "value must be an object for the userscripts scope (sourcePath | raw | enabled | values | deleteValues)"
                .to_string(),
        )
    })?;

// 源码来源：sourcePath（推荐，从磁盘文件读取，避免大工具参数）或 raw（内联），二选一。
    if obj.contains_key("sourcePath") {
        let source_path = obj.get("sourcePath").and_then(Value::as_str).ok_or_else(|| {
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

    if let Some(raw) = obj.get("raw").and_then(Value::as_str) {
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

    if let Some(enabled) = obj.get("enabled").and_then(Value::as_bool) {
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
        if let Some(map) = values.as_object() {
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
            "valuesWritten": values.as_object().map(|m| m.len()).unwrap_or(0),
        }));
    }

    if let Some(delete_values) = obj.get("deleteValues") {
        ensure_script_exists(db_path, key)?;
        let mut deleted = 0usize;
        if let Some(names) = delete_values.as_array() {
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

    Err(Error::new(
        Status::InvalidArg,
        "value must contain one of: `sourcePath` (path to a script file on disk), `raw` (inline script source), `enabled` (bool), `values` (GM values object), `deleteValues` (array of GM value keys)".to_string(),
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
