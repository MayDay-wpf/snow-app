//! 键盘快捷键设置的 NAPI 类型、From 转换与转发。

use super::*;

// ============================================================================
// Keyboard shortcuts — 快捷键设置，12 个快捷键各自 enabled + foregroundOnly。
// ============================================================================

#[napi(object)]
pub struct KeyboardShortcutConfigNapi {
    pub key: String,
    pub enabled: bool,
    pub foreground_only: bool,
}

impl From<crate::storage::services::keyboard_shortcuts::KeyboardShortcutConfig>
    for KeyboardShortcutConfigNapi
{
    fn from(c: crate::storage::services::keyboard_shortcuts::KeyboardShortcutConfig) -> Self {
        KeyboardShortcutConfigNapi {
            key: c.key,
            enabled: c.enabled,
            foreground_only: c.foreground_only,
        }
    }
}

impl From<KeyboardShortcutConfigNapi>
    for crate::storage::services::keyboard_shortcuts::KeyboardShortcutConfig
{
    fn from(c: KeyboardShortcutConfigNapi) -> Self {
        crate::storage::services::keyboard_shortcuts::KeyboardShortcutConfig {
            key: c.key,
            enabled: c.enabled,
            foreground_only: c.foreground_only,
        }
    }
}

#[napi(object)]
pub struct KeyboardShortcutsSettingsNapi {
    pub cancel_session: KeyboardShortcutConfigNapi,
    pub open_search: KeyboardShortcutConfigNapi,
    pub open_memo: KeyboardShortcutConfigNapi,
    pub open_todo: KeyboardShortcutConfigNapi,
    pub cycle_project: KeyboardShortcutConfigNapi,
    pub open_project_explorer: KeyboardShortcutConfigNapi,
    pub cycle_api_profile: KeyboardShortcutConfigNapi,
    pub toggle_window: KeyboardShortcutConfigNapi,
    pub toggle_pet: KeyboardShortcutConfigNapi,
    pub focus_input: KeyboardShortcutConfigNapi,
    pub toggle_sidebar: KeyboardShortcutConfigNapi,
    pub toggle_right_panel: KeyboardShortcutConfigNapi,
}

impl From<crate::storage::services::keyboard_shortcuts::KeyboardShortcutsSettings>
    for KeyboardShortcutsSettingsNapi
{
    fn from(s: crate::storage::services::keyboard_shortcuts::KeyboardShortcutsSettings) -> Self {
        KeyboardShortcutsSettingsNapi {
            cancel_session: s.cancel_session.into(),
            open_search: s.open_search.into(),
            open_memo: s.open_memo.into(),
            open_todo: s.open_todo.into(),
            cycle_project: s.cycle_project.into(),
            open_project_explorer: s.open_project_explorer.into(),
            cycle_api_profile: s.cycle_api_profile.into(),
            toggle_window: s.toggle_window.into(),
            toggle_pet: s.toggle_pet.into(),
            focus_input: s.focus_input.into(),
            toggle_sidebar: s.toggle_sidebar.into(),
            toggle_right_panel: s.toggle_right_panel.into(),
        }
    }
}

impl From<KeyboardShortcutsSettingsNapi>
    for crate::storage::services::keyboard_shortcuts::KeyboardShortcutsSettings
{
    fn from(s: KeyboardShortcutsSettingsNapi) -> Self {
        crate::storage::services::keyboard_shortcuts::KeyboardShortcutsSettings {
            cancel_session: s.cancel_session.into(),
            open_search: s.open_search.into(),
            open_memo: s.open_memo.into(),
            open_todo: s.open_todo.into(),
            cycle_project: s.cycle_project.into(),
            open_project_explorer: s.open_project_explorer.into(),
            cycle_api_profile: s.cycle_api_profile.into(),
            toggle_window: s.toggle_window.into(),
            toggle_pet: s.toggle_pet.into(),
            focus_input: s.focus_input.into(),
            toggle_sidebar: s.toggle_sidebar.into(),
            toggle_right_panel: s.toggle_right_panel.into(),
        }
    }
}

#[napi]
pub async fn get_keyboard_shortcuts_settings() -> napi::Result<KeyboardShortcutsSettingsNapi> {
    let settings = tokio::task::spawn_blocking(crate::storage::get_keyboard_shortcuts_settings)
        .await
        .map_err(map_spawn_error)??;
    Ok(settings.into())
}

#[napi]
pub async fn set_keyboard_shortcuts_settings(
    settings: KeyboardShortcutsSettingsNapi,
) -> napi::Result<()> {
    let settings = settings.into();
    tokio::task::spawn_blocking(move || crate::storage::set_keyboard_shortcuts_settings(settings))
        .await
        .map_err(map_spawn_error)?
}
