//! config 服务 `keyboardShortcuts` 作用域：键盘快捷键（单例，32 个动作）。
//!
//! 真源是 system_settings 的 `keyboard_shortcuts`（与 UI「快捷键」设置页同源）。
//! 每个动作的配置为 `{key, enabled, foregroundOnly}`；本域按**稀疏 merge** 写入：
//! 只覆盖调用方给出的动作与字段，其余动作保持原值。
//!
//! 读取时会附带 `conflicts`：同一个键位绑定到多个已启用动作时列出冲突组，
//! 便于 AI 在改键前发现（并避免制造）冲突。
//!
//! ⚠️ 快捷键由渲染进程读取后注册，写入数据库后可能需要重新打开设置页或重启应用
//! 才会在界面上生效。

use std::collections::BTreeMap;
use std::path::Path;

use napi::bindgen_prelude::*;
use serde_json::{json, Value};

use crate::storage::services::keyboard_shortcuts::KeyboardShortcutsSettings;

const TOOL_GET: &str = "get";
const TOOL_SET: &str = "set";
const TOOL_DELETE: &str = "delete";

const SHORTCUTS_KEY: &str = "settings";

/// 32 个动作（与 KeyboardShortcutsSettings 的字段一一对应）。
const ACTIONS: &[&str] = &[
    "cancelSession",
    "openSearch",
    "openMemo",
    "openTodo",
    "cycleProject",
    "openProjectExplorer",
    "cycleApiProfile",
    "toggleWindow",
    "togglePet",
    "focusInput",
    "toggleSidebar",
    "toggleRightPanel",
    "newChat",
    "sendMessage",
    "sendMessageNow",
    "stopGeneration",
    "prevConversation",
    "nextConversation",
    "scrollToTop",
    "scrollToBottom",
    "openSettings",
    "copyLastResponse",
    "toggleRightPanelFullscreen",
    "showShortcutHelp",
    "toggleMessageTime",
    "uiZoomIn",
    "uiZoomOut",
    "uiZoomReset",
    "newChatInNewWindow",
    "cycleDetachedWindow",
    "browserToggleShareWithAgent",
    "browserPickElement",
];

/// 单个动作允许写入的字段。
const WRITABLE_FIELDS: &[&str] = &["key", "enabled", "foregroundOnly"];

const APPLY_NOTE: &str = "Shortcuts are registered by the renderer after it reads this setting; the change may need the settings page to be reopened (or the app restarted) before it takes effect in the UI.";

fn load_value() -> Result<Value> {
    let settings = crate::storage::get_keyboard_shortcuts_settings()?;
    serde_json::to_value(settings).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to serialize keyboard shortcuts: {error}"),
        )
    })
}

/// 同一键位绑定多个已启用动作 → 冲突组。
fn conflicts_from_value(value: &Value) -> Vec<Value> {
    let mut groups: BTreeMap<String, Vec<String>> = BTreeMap::new();
    if let Some(object) = value.as_object() {
        for (action, config) in object {
            let enabled = config
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let key = config
                .get("key")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("");
            if !enabled || key.is_empty() {
                continue;
            }
            groups
                .entry(key.to_ascii_lowercase())
                .or_default()
                .push(action.clone());
        }
    }

    groups
        .into_iter()
        .filter(|(_, actions)| actions.len() > 1)
        .map(|(key, actions)| json!({ "key": key, "actions": actions }))
        .collect()
}

fn apply_shortcuts(value: &Value) -> Result<Value> {
    let Some(patch) = value.as_object() else {
        return Err(Error::new(
            Status::InvalidArg,
            "keyboardShortcuts value must be an object like { openSearch: { key: \"ctrl+k\" } }"
                .to_string(),
        ));
    };

    let mut current = load_value()?;
    let Some(current_object) = current.as_object_mut() else {
        return Err(Error::new(
            Status::GenericFailure,
            "Stored keyboard shortcuts are not an object".to_string(),
        ));
    };

    for (action, fields) in patch {
        if !ACTIONS.contains(&action.as_str()) {
            return Err(Error::new(
                Status::InvalidArg,
                format!(
                    "Unknown shortcut action \"{action}\"; available actions: {}",
                    ACTIONS.join(", ")
                ),
            ));
        }
        let Some(fields) = fields.as_object() else {
            return Err(Error::new(
                Status::InvalidArg,
                format!("{action} must be an object with any of: {}", WRITABLE_FIELDS.join(", ")),
            ));
        };
        let entry = current_object
            .entry(action.clone())
            .or_insert_with(|| json!({}));
        let Some(entry) = entry.as_object_mut() else {
            return Err(Error::new(
                Status::GenericFailure,
                format!("Stored config for {action} is not an object"),
            ));
        };
        for (field, field_value) in fields {
            if !WRITABLE_FIELDS.contains(&field.as_str()) {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!(
                        "{field} is not writable for {action}; allowed fields: {}",
                        WRITABLE_FIELDS.join(", ")
                    ),
                ));
            }
            match field.as_str() {
                "key" => {
                    let key = field_value.as_str().ok_or_else(|| {
                        Error::new(
                            Status::InvalidArg,
                            format!("{action}.key must be a string"),
                        )
                    })?;
                    entry.insert(field.clone(), json!(key.trim()));
                }
                "enabled" | "foregroundOnly" => {
                    let flag = field_value.as_bool().ok_or_else(|| {
                        Error::new(
                            Status::InvalidArg,
                            format!("{action}.{field} must be a boolean"),
                        )
                    })?;
                    entry.insert(field.clone(), json!(flag));
                }
                _ => {}
            }
        }
    }

    let settings: KeyboardShortcutsSettings =
        serde_json::from_value(current.clone()).map_err(|error| {
            Error::new(
                Status::InvalidArg,
                format!("Invalid keyboard shortcut value: {error}"),
            )
        })?;
    crate::storage::set_keyboard_shortcuts_settings(settings)?;

    let updated = load_value()?;
    Ok(json!({
        "scope": "keyboardShortcuts",
        "key": SHORTCUTS_KEY,
        "note": APPLY_NOTE,
        "conflicts": conflicts_from_value(&updated),
        "value": updated,
    }))
}

/// Dispatches `config-list/get/set/delete` for the `keyboardShortcuts` scope.
pub(crate) fn execute_keyboard_shortcuts_scope(
    tool_name: &str,
    args: &Value,
    _db_path: &Path,
) -> Result<Value> {
    match tool_name {
        "list" => {
            let value = load_value()?;
            Ok(json!({
                "scope": "keyboardShortcuts",
                "file": null,
                "note": APPLY_NOTE,
                "keys": [{
                    "key": SHORTCUTS_KEY,
                    "type": "object",
                    "sensitive": false,
                    "configured": true,
                    "conflicts": conflicts_from_value(&value),
                    "value": value,
                }],
            }))
        }
        TOOL_GET => {
            let key = args.get("key").and_then(Value::as_str).unwrap_or("");
            if key != SHORTCUTS_KEY {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!("keyboardShortcuts only defines the key \"{SHORTCUTS_KEY}\""),
                ));
            }
            let value = load_value()?;
            Ok(json!({
                "scope": "keyboardShortcuts",
                "key": key,
                "conflicts": conflicts_from_value(&value),
                "value": value,
            }))
        }
        TOOL_SET => {
            let key = args.get("key").and_then(Value::as_str).unwrap_or("");
            if key != SHORTCUTS_KEY {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!("keyboardShortcuts only defines the key \"{SHORTCUTS_KEY}\""),
                ));
            }
            let value = args.get("value").cloned().ok_or_else(|| {
                Error::new(
                    Status::InvalidArg,
                    "value is required for config-set".to_string(),
                )
            })?;
            apply_shortcuts(&value)
        }
        TOOL_DELETE => Err(Error::new(
            Status::InvalidArg,
            "keyboardShortcuts does not support delete; write the desired keys with config-set (reset a single action by writing its default key)"
                .to_string(),
        )),
        other => Err(Error::new(
            Status::InvalidArg,
            format!("Unsupported config tool for scope keyboardShortcuts: {other}"),
        )),
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conflicts_detect_duplicate_enabled_keys() {
        let value = json!({
            "openSearch": { "key": "ctrl+k", "enabled": true, "foregroundOnly": true },
            "focusInput": { "key": "Ctrl+K", "enabled": true, "foregroundOnly": true },
            "openMemo": { "key": "ctrl+m", "enabled": true, "foregroundOnly": true },
            "openTodo": { "key": "", "enabled": true, "foregroundOnly": true },
            "cycleProject": { "key": "ctrl+j", "enabled": false, "foregroundOnly": true }
        });

        let conflicts = conflicts_from_value(&value);
        assert_eq!(conflicts.len(), 1, "only the ctrl+k pair conflicts");
        let group = &conflicts[0];
        assert_eq!(group.get("key").and_then(Value::as_str), Some("ctrl+k"));
        assert_eq!(
            group
                .get("actions")
                .and_then(Value::as_array)
                .map(|actions| actions.len()),
            Some(2)
        );
    }

    #[test]
    fn conflicts_ignore_disabled_and_empty_keys() {
        let value = json!({
            "openSearch": { "key": "ctrl+k", "enabled": false, "foregroundOnly": true },
            "focusInput": { "key": "", "enabled": true, "foregroundOnly": true }
        });
        assert!(conflicts_from_value(&value).is_empty());
    }
}
