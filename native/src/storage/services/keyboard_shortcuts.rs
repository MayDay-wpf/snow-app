use std::path::Path;

use napi::bindgen_prelude::*;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::super::database;

const KEYBOARD_SHORTCUTS_SETTING_NAME: &str = "Keyboard shortcuts";
const KEYBOARD_SHORTCUTS_SETTING_CODE: &str = "keyboard_shortcuts";

/// 单个快捷键配置：按键绑定 + 是否启用 + 是否仅台前生效。
///
/// `key` 使用平台无关的规范化格式：`mod` 代表平台主修饰键
/// （macOS 为 Cmd，其他平台为 Ctrl），主键用小写。
/// 例如 `mod+f`、`escape`、`mod+backtick`。
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct KeyboardShortcutConfig {
    pub key: String,
    pub enabled: bool,
    pub foreground_only: bool,
}

impl Default for KeyboardShortcutConfig {
    fn default() -> Self {
        Self {
            key: String::new(),
            enabled: true,
            foreground_only: true,
        }
    }
}

/// 校验 key 是否合法：非空且仅含允许的字符集。
/// 允许：字母 / 数字 / `mod` / `+` / `-` / 反引号 / 部分命名键。
fn is_valid_key(key: &str) -> bool {
    if key.trim().is_empty() {
        return false;
    }
    key.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '`')
}

/// 完整快捷键设置：7 个快捷键各自的配置。
/// 序列化为 JSON 存储在 system_settings 表中。
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct KeyboardShortcutsSettings {
    pub cancel_session: KeyboardShortcutConfig,
    pub open_search: KeyboardShortcutConfig,
    pub open_memo: KeyboardShortcutConfig,
    pub open_todo: KeyboardShortcutConfig,
    pub cycle_project: KeyboardShortcutConfig,
    pub open_project_explorer: KeyboardShortcutConfig,
    pub cycle_api_profile: KeyboardShortcutConfig,
}

/// 7 个快捷键的默认按键绑定（与渲染层 useKeyboardShortcuts 原始硬编码一致）。
/// `mod` 为平台主修饰键占位符（macOS=Cmd，其他=Ctrl）。
/// cycleApiProfile 平台相关：macOS 用 Ctrl+P（Option/Alt 会输入特殊字符），
/// 其他平台用 Alt+P。
const DEFAULT_CANCEL_SESSION_KEY: &str = "escape";
const DEFAULT_OPEN_SEARCH_KEY: &str = "mod+f";
const DEFAULT_OPEN_MEMO_KEY: &str = "mod+b";
const DEFAULT_OPEN_TODO_KEY: &str = "mod+t";
const DEFAULT_CYCLE_PROJECT_KEY: &str = "mod+backtick";
const DEFAULT_OPEN_PROJECT_EXPLORER_KEY: &str = "mod+d";
const DEFAULT_CYCLE_API_PROFILE_KEY: &str = if cfg!(target_os = "macos") {
    "ctrl+p"
} else {
    "alt+p"
};

impl KeyboardShortcutsSettings {
    /// 规范化：对每个配置校验 key 合法性，不合法时回退到默认按键绑定。
    /// bool 字段（enabled / foreground_only）天然合法，无需校验。
    fn normalize(&mut self) {
        if !is_valid_key(&self.cancel_session.key) {
            self.cancel_session.key = DEFAULT_CANCEL_SESSION_KEY.to_string();
        }
        if !is_valid_key(&self.open_search.key) {
            self.open_search.key = DEFAULT_OPEN_SEARCH_KEY.to_string();
        }
        if !is_valid_key(&self.open_memo.key) {
            self.open_memo.key = DEFAULT_OPEN_MEMO_KEY.to_string();
        }
        if !is_valid_key(&self.open_todo.key) {
            self.open_todo.key = DEFAULT_OPEN_TODO_KEY.to_string();
        }
        if !is_valid_key(&self.cycle_project.key) {
            self.cycle_project.key = DEFAULT_CYCLE_PROJECT_KEY.to_string();
        }
        if !is_valid_key(&self.open_project_explorer.key) {
            self.open_project_explorer.key = DEFAULT_OPEN_PROJECT_EXPLORER_KEY.to_string();
        }
        // macOS 上旧默认值 alt+p 不适用（Option+P 会输入特殊字符），
        // 视为未自定义，迁移到 ctrl+p。
        if cfg!(target_os = "macos") && self.cycle_api_profile.key == "alt+p" {
            self.cycle_api_profile.key = DEFAULT_CYCLE_API_PROFILE_KEY.to_string();
        }
        if !is_valid_key(&self.cycle_api_profile.key) {
            self.cycle_api_profile.key = DEFAULT_CYCLE_API_PROFILE_KEY.to_string();
        }
    }
}

/// 默认值：7 个快捷键各自默认 key + enabled=true + foreground_only=true。
/// 与 DEFAULT_*_KEY 常量保持一致；cycleApiProfile 的 key 平台相关，动态构造。
fn default_keyboard_shortcuts_value() -> String {
    format!(
        r#"{{"cancelSession":{{"key":"escape","enabled":true,"foregroundOnly":true}},"openSearch":{{"key":"mod+f","enabled":true,"foregroundOnly":true}},"openMemo":{{"key":"mod+b","enabled":true,"foregroundOnly":true}},"openTodo":{{"key":"mod+t","enabled":true,"foregroundOnly":true}},"cycleProject":{{"key":"mod+backtick","enabled":true,"foregroundOnly":true}},"openProjectExplorer":{{"key":"mod+d","enabled":true,"foregroundOnly":true}},"cycleApiProfile":{{"key":"{DEFAULT_CYCLE_API_PROFILE_KEY}","enabled":true,"foregroundOnly":true}}}}"#
    )
}

pub fn get_keyboard_shortcuts_settings(database_path: &Path) -> Result<KeyboardShortcutsSettings> {
    let raw_value = match database::open_connection(database_path).and_then(|connection| {
        connection
            .query_row(
                "SELECT setting_value FROM system_settings WHERE setting_code = ?1",
                [KEYBOARD_SHORTCUTS_SETTING_CODE],
                |row| row.get::<_, String>(0),
            )
            .optional()
    }) {
        Ok(value) => value,
        Err(error) => {
            return Err(database::database_error(
                database_path,
                "read keyboard shortcuts settings",
                error,
            ))
        }
    };

    match raw_value {
        Some(value) => {
            let mut settings =
                serde_json::from_str::<KeyboardShortcutsSettings>(&value).map_err(|error| {
                    Error::new(
                        Status::GenericFailure,
                        format!("Failed to parse keyboard shortcuts settings: {error}"),
                    )
                })?;
            settings.normalize();
            Ok(settings)
        }
        None => Ok(KeyboardShortcutsSettings::default()),
    }
}

pub fn set_keyboard_shortcuts_settings(
    database_path: &Path,
    settings: &KeyboardShortcutsSettings,
) -> Result<()> {
    let mut normalized = settings.clone();
    normalized.normalize();
    let setting_value = serde_json::to_string(&normalized).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to serialize keyboard shortcuts settings: {error}"),
        )
    })?;

    database::open_connection(database_path)
        .and_then(|connection| {
            connection.execute(
                "INSERT INTO system_settings (id, setting_name, setting_code, setting_value, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, datetime('now', 'localtime'), datetime('now', 'localtime'))
                 ON CONFLICT(setting_code) DO UPDATE SET
                   setting_name = excluded.setting_name,
                   setting_value = excluded.setting_value,
                   updated_at = datetime('now', 'localtime')",
                (
                    database::create_snowflake_id(),
                    KEYBOARD_SHORTCUTS_SETTING_NAME,
                    KEYBOARD_SHORTCUTS_SETTING_CODE,
                    setting_value,
                ),
            )
        })
        .map_err(|error| {
            database::database_error(
                database_path,
                "write keyboard shortcuts settings",
                error,
            )
        })?;

    Ok(())
}

/// Seed 默认快捷键设置（仅在首次创建时插入，不覆盖已有值）。
pub fn seed_default_keyboard_shortcuts(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute(
        "INSERT OR IGNORE INTO system_settings (id, setting_name, setting_code, setting_value, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, datetime('now', 'localtime'), datetime('now', 'localtime'))",
        (
            database::create_snowflake_id(),
            KEYBOARD_SHORTCUTS_SETTING_NAME,
            KEYBOARD_SHORTCUTS_SETTING_CODE,
            default_keyboard_shortcuts_value(),
        ),
    )?;

    Ok(())
}
