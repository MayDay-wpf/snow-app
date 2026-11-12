use std::path::{Path, PathBuf};

use napi::bindgen_prelude::*;
use serde_json::{json, Value};

use crate::storage::PluginRecord;

const NEW_KEY: &str = "new";

const GUIDANCE: &str = "PLUGINS - install, reload, enable or uninstall Snow App plugins without the directory picker.\nINSTALL FLOW (recommended, avoids huge tool args): 1) write the plugin folder with the filesystem server - plugin.json plus the entry file (e.g. index.js), and any panel/locale/style files; 2) config-manage action=set scope=plugins key=\"new\" value={sourceDir: \"/abs/path/to/my-plugin\"}. The backend reads plugin.json, validates it, copies the folder to ~/.snowapp/plugins/<pluginId> (skipping .git and node_modules, 128 MB limit) and registers it enabled. value={sourcePath: \"/abs/path/to/my-plugin/plugin.json\"} (or a directory path) is accepted as well.\nUPDATE: edit the source folder, then config-manage action=set scope=plugins key=<pluginId> value={sourceDir: \"...\"} again (an installed plugin is replaced in place; its enabled state is kept); when you only edited the installed folder, use value={rescan: true} to reload plugin.json.\nTOGGLE: config-manage action=set scope=plugins key=<pluginId> value={enabled: true|false}\nREAD: config-manage action=get scope=plugins key=<pluginId> (metadata; the matching key is the plugin id from plugin.json, never a path)\nLIST: config-manage action=list scope=plugins (items + pluginsDirectory)\nUNINSTALL: config-manage action=delete scope=plugins key=<pluginId> confirmed=true value={deleteFiles: false} keeps the folder on disk; deleteFiles defaults to true (removes the DB row and the folder).\nMANDATORY plugin.json keys: id (letters, digits, dot, dash, underscore; max 96 chars; not starting with a dot) and an existing entry file (default index.js). Optional: name/description (string or {default, zh-CN, en, ...}), version, author, homepage, license, icon (lucide:IconName, relative asset path or remote URL), renderMode (esm|iframe, default esm), panels, locales, styles, privacy, privacyNote, minAppVersion.\nFull guide: ~/.snowapp/docs/zh-CN/2-使用指南/24-插件开发与安装.md (en: en/2-guides/24-plugin-development-and-installation.md)\nMETADATA: when a plugin needs to READ app data (conversations, messages, memos, memory, usage, git, projects, runtime metrics, settings and 28 more), the 37 readable metadata domains with their parameters, return fields, privacy scopes and live-vs-polled behavior are documented in ~/.snowapp/docs/zh-CN/3-参考手册/6-插件元数据域参考.md (en: en/3-reference/6-plugin-metadata-domains.md) - read it before writing the panel";

pub fn list_plugins(db_path: &Path) -> napi::Result<Value> {
    let records = crate::storage::list_plugins(db_path).map_err(storage_error)?;
    let items: Vec<Value> = records.iter().map(record_to_json).collect();
    Ok(json!({
        "scope": "plugins",
        "pluginsDirectory": plugins_directory(),
        "items": items,
        "count": items.len(),
        "guidance": GUIDANCE,
    }))
}

pub fn get_plugin(db_path: &Path, plugin_id: &str) -> napi::Result<Value> {
    let records = crate::storage::list_plugins(db_path).map_err(storage_error)?;
    let found = records
        .iter()
        .find(|record| record.plugin_id == plugin_id)
        .map(record_to_json);
    Ok(json!({
        "scope": "plugins",
        "key": plugin_id,
        "value": found.unwrap_or(Value::Null),
    }))
}

pub fn set_plugin(db_path: &Path, key: &str, value: &Value) -> napi::Result<Value> {
    let obj = normalize_set_value(value)?;

    if let Some(source_dir) = obj
        .get("sourceDir")
        .or_else(|| obj.get("sourcePath"))
        .and_then(Value::as_str)
    {
        let directory = resolve_plugin_directory(source_dir)?;
        let record = crate::storage::install_plugin(db_path, &directory.to_string_lossy())
            .map_err(storage_error)?;
        return Ok(json!({
            "scope": "plugins",
            "key": record.plugin_id,
            "saved": true,
            "installed": true,
            "requestedKey": key,
            "plugin": record_to_json(&record),
        }));
    }

    if obj.get("rescan").and_then(parse_bool_field) == Some(true) {
        let record = crate::storage::rescan_plugin(db_path, key).map_err(storage_error)?;
        return Ok(json!({
            "scope": "plugins",
            "key": record.plugin_id,
            "saved": true,
            "rescanned": true,
            "plugin": record_to_json(&record),
        }));
    }

    if let Some(enabled) = obj.get("enabled").and_then(parse_bool_field) {
        ensure_plugin_exists(db_path, key)?;
        crate::storage::set_plugin_enabled(db_path, key, enabled).map_err(storage_error)?;
        return Ok(json!({
            "scope": "plugins",
            "key": key,
            "saved": true,
            "enabled": enabled,
        }));
    }

    let fields: Vec<&str> = obj.keys().map(String::as_str).collect();
    Err(Error::new(
        Status::InvalidArg,
        format!(
            "value for the plugins scope must contain one of: `sourceDir` (absolute path to the plugin folder - recommended: write plugin.json plus the entry file with the filesystem server first, then pass the folder), `sourcePath` (absolute path to plugin.json or the plugin folder), `enabled` (bool), `rescan` (bool, reload plugin.json from the installed folder). Received object fields: {fields:?}"
        ),
    ))
}

pub fn delete_plugin(db_path: &Path, plugin_id: &str, value: Option<&Value>) -> napi::Result<Value> {
    let delete_files = value
        .and_then(|value| value.get("deleteFiles"))
        .and_then(parse_bool_field)
        .unwrap_or(true);
    let records = crate::storage::list_plugins(db_path).map_err(storage_error)?;
    let exists = records.iter().any(|record| record.plugin_id == plugin_id);
    if exists {
        crate::storage::delete_plugin(db_path, plugin_id, delete_files).map_err(storage_error)?;
    }
    Ok(json!({
        "scope": "plugins",
        "key": plugin_id,
        "deleted": exists,
        "deleteFiles": delete_files,
    }))
}

fn record_to_json(record: &PluginRecord) -> Value {
    json!({
        "pluginId": record.plugin_id,
        "name": parse_json_field(&record.name, json!({})),
        "description": parse_json_field(&record.description, json!({})),
        "version": record.version,
        "author": record.author,
        "homepage": record.homepage,
        "license": record.license,
        "icon": record.icon,
        "renderMode": record.render_mode,
        "kind": record.kind,
        "entry": record.entry,
        "enabled": record.enabled,
        "installPath": record.install_path,
        "sourcePath": record.source_path,
        "panels": parse_json_field(&record.panels, json!([])),
        "locales": parse_json_field(&record.locales, json!({})),
        "styles": parse_json_field(&record.styles, json!([])),
        "privacy": record.privacy,
        "privacyNote": record.privacy_note,
        "minAppVersion": record.min_app_version,
        "sortOrder": record.sort_order,
        "createdAt": record.created_at,
        "updatedAt": record.updated_at,
    })
}

fn parse_json_field(raw: &str, fallback: Value) -> Value {
    serde_json::from_str::<Value>(raw).unwrap_or(fallback)
}

fn plugins_directory() -> String {
    crate::storage::plugins_dir()
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_default()
}

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
            if !trimmed.is_empty() && !trimmed.contains('\n') && !trimmed.contains('\r') {
                return Ok(single_field_map("sourceDir", json!(trimmed)));
            }
            Err(invalid_value_error(value))
        }
        other => Err(invalid_value_error(other)),
    }
}

fn normalize_field_aliases(
    map: &serde_json::Map<String, Value>,
) -> serde_json::Map<String, Value> {
    let mut result = serde_json::Map::new();
    for (field, val) in map {
        let canonical = match field.as_str() {
            "source_dir" | "dir" | "directory" | "folder" | "path" | "installPath"
            | "install_path" => "sourceDir",
            "source_path" | "manifest" | "manifestPath" | "pluginJson" | "file" | "filePath"
            | "file_path" => "sourcePath",
            "enable" => "enabled",
            "reload" => "rescan",
            other => other,
        };
        result.insert(canonical.to_string(), val.clone());
    }
    result
}

fn single_field_map(field: &str, value: Value) -> serde_json::Map<String, Value> {
    let mut map = serde_json::Map::new();
    map.insert(field.to_string(), value);
    map
}

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

fn invalid_value_error(received: &Value) -> Error {
    let received_desc = match received {
        Value::String(text) => {
            let preview: String = text.chars().take(80).collect();
            format!("a string of {} chars starting with {preview:?}", text.chars().count())
        }
        other => {
            let serialized = serde_json::to_string(other).unwrap_or_else(|_| other.to_string());
            let preview: String = serialized.chars().take(80).collect();
            format!("{preview}")
        }
    };
    Error::new(
        Status::InvalidArg,
        format!(
            "value for the plugins scope must be an object with one of: sourceDir (recommended; absolute path to the plugin folder, e.g. value={{sourceDir: \"/abs/path/my-plugin\"}}), sourcePath (absolute path to plugin.json or the folder), enabled (bool), rescan (bool). Received {received_desc}"
        ),
    )
}

fn ensure_plugin_exists(db_path: &Path, plugin_id: &str) -> napi::Result<()> {
    let records = crate::storage::list_plugins(db_path).map_err(storage_error)?;
    if records.iter().any(|record| record.plugin_id == plugin_id) {
        return Ok(());
    }
    Err(Error::new(
        Status::InvalidArg,
        format!(
            "Unknown plugin: \"{plugin_id}\". Use config-manage action=list scope=plugins to see installed plugin ids; install a new plugin with key=\"{NEW_KEY}\" and value={{sourceDir: \"<abs path>\"}}"
        ),
    ))
}

fn resolve_plugin_directory(source: &str) -> napi::Result<PathBuf> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            "sourceDir must be a non-empty path to the plugin folder".to_string(),
        ));
    }
    let path = resolve_source_path(trimmed);
    if path.is_dir() {
        return Ok(path);
    }
    if path.is_file() {
        if let Some(parent) = path.parent() {
            return Ok(parent.to_path_buf());
        }
    }
    Err(Error::new(
        Status::GenericFailure,
        format!(
            "Plugin source path '{}' does not exist (pass the folder that contains plugin.json)",
            path.display()
        ),
    ))
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
    std::env::current_dir()
        .map(|cwd| cwd.join(path))
        .unwrap_or_else(|_| path.to_path_buf())
}

fn storage_error(error: napi::Error) -> napi::Error {
    Error::new(
        Status::GenericFailure,
        format!("plugins storage error: {error}"),
    )
}
