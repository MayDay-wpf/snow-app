//! 键盘快捷键设置的 NAPI 类型、From 转换与转发。

use super::*;

// ============================================================================
// Keyboard shortcuts — 快捷键设置，32 个快捷键各自 enabled + foregroundOnly。
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
    pub open_project_explorer: KeyboardShortcutConfigNapi,
    pub open_todo: KeyboardShortcutConfigNapi,
    pub open_project_memory: KeyboardShortcutConfigNapi,
    pub open_scheduled_tasks: KeyboardShortcutConfigNapi,
    pub open_plugins: KeyboardShortcutConfigNapi,
    pub cycle_project: KeyboardShortcutConfigNapi,
    pub cycle_api_profile: KeyboardShortcutConfigNapi,
    pub toggle_window: KeyboardShortcutConfigNapi,
    pub toggle_pet: KeyboardShortcutConfigNapi,
    pub focus_input: KeyboardShortcutConfigNapi,
    pub toggle_sidebar: KeyboardShortcutConfigNapi,
    pub toggle_right_panel: KeyboardShortcutConfigNapi,
    pub new_chat: KeyboardShortcutConfigNapi,
    pub send_message: KeyboardShortcutConfigNapi,
    pub send_message_now: KeyboardShortcutConfigNapi,
    pub stop_generation: KeyboardShortcutConfigNapi,
    pub prev_conversation: KeyboardShortcutConfigNapi,
    pub next_conversation: KeyboardShortcutConfigNapi,
    pub scroll_to_top: KeyboardShortcutConfigNapi,
    pub scroll_to_bottom: KeyboardShortcutConfigNapi,
    pub open_settings: KeyboardShortcutConfigNapi,
    pub copy_last_response: KeyboardShortcutConfigNapi,
    pub toggle_right_panel_fullscreen: KeyboardShortcutConfigNapi,
    pub show_shortcut_help: KeyboardShortcutConfigNapi,
    pub toggle_message_time: KeyboardShortcutConfigNapi,
    pub ui_zoom_in: KeyboardShortcutConfigNapi,
    pub ui_zoom_out: KeyboardShortcutConfigNapi,
    pub ui_zoom_reset: KeyboardShortcutConfigNapi,
    pub new_chat_in_new_window: KeyboardShortcutConfigNapi,
    pub cycle_detached_window: KeyboardShortcutConfigNapi,
    pub browser_toggle_share_with_agent: KeyboardShortcutConfigNapi,
    pub browser_pick_element: KeyboardShortcutConfigNapi,
}

impl From<crate::storage::services::keyboard_shortcuts::KeyboardShortcutsSettings>
    for KeyboardShortcutsSettingsNapi
{
    fn from(s: crate::storage::services::keyboard_shortcuts::KeyboardShortcutsSettings) -> Self {
        KeyboardShortcutsSettingsNapi {
            cancel_session: s.cancel_session.into(),
            open_search: s.open_search.into(),
            open_memo: s.open_memo.into(),
            open_project_explorer: s.open_project_explorer.into(),
            open_project_memory: s.open_project_memory.into(),
            open_plugins: s.open_plugins.into(),
            open_scheduled_tasks: s.open_scheduled_tasks.into(),
            open_todo: s.open_todo.into(),
            cycle_project: s.cycle_project.into(),
            cycle_api_profile: s.cycle_api_profile.into(),
            toggle_window: s.toggle_window.into(),
            toggle_pet: s.toggle_pet.into(),
            focus_input: s.focus_input.into(),
            toggle_sidebar: s.toggle_sidebar.into(),
            toggle_right_panel: s.toggle_right_panel.into(),
            new_chat: s.new_chat.into(),
            send_message: s.send_message.into(),
            send_message_now: s.send_message_now.into(),
            stop_generation: s.stop_generation.into(),
            prev_conversation: s.prev_conversation.into(),
            next_conversation: s.next_conversation.into(),
            scroll_to_top: s.scroll_to_top.into(),
            scroll_to_bottom: s.scroll_to_bottom.into(),
            open_settings: s.open_settings.into(),
            copy_last_response: s.copy_last_response.into(),
            toggle_right_panel_fullscreen: s.toggle_right_panel_fullscreen.into(),
            show_shortcut_help: s.show_shortcut_help.into(),
            toggle_message_time: s.toggle_message_time.into(),
            ui_zoom_in: s.ui_zoom_in.into(),
            ui_zoom_out: s.ui_zoom_out.into(),
            ui_zoom_reset: s.ui_zoom_reset.into(),
            new_chat_in_new_window: s.new_chat_in_new_window.into(),
            cycle_detached_window: s.cycle_detached_window.into(),
            browser_toggle_share_with_agent: s.browser_toggle_share_with_agent.into(),
            browser_pick_element: s.browser_pick_element.into(),
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
            open_project_explorer: s.open_project_explorer.into(),
            open_project_memory: s.open_project_memory.into(),
            open_plugins: s.open_plugins.into(),
            open_scheduled_tasks: s.open_scheduled_tasks.into(),
            open_todo: s.open_todo.into(),
            cycle_project: s.cycle_project.into(),
            cycle_api_profile: s.cycle_api_profile.into(),
            toggle_window: s.toggle_window.into(),
            toggle_pet: s.toggle_pet.into(),
            focus_input: s.focus_input.into(),
            toggle_sidebar: s.toggle_sidebar.into(),
            toggle_right_panel: s.toggle_right_panel.into(),
            new_chat: s.new_chat.into(),
            send_message: s.send_message.into(),
            send_message_now: s.send_message_now.into(),
            stop_generation: s.stop_generation.into(),
            prev_conversation: s.prev_conversation.into(),
            next_conversation: s.next_conversation.into(),
            scroll_to_top: s.scroll_to_top.into(),
            scroll_to_bottom: s.scroll_to_bottom.into(),
            open_settings: s.open_settings.into(),
            copy_last_response: s.copy_last_response.into(),
            toggle_right_panel_fullscreen: s.toggle_right_panel_fullscreen.into(),
            show_shortcut_help: s.show_shortcut_help.into(),
            toggle_message_time: s.toggle_message_time.into(),
            ui_zoom_in: s.ui_zoom_in.into(),
            ui_zoom_out: s.ui_zoom_out.into(),
            ui_zoom_reset: s.ui_zoom_reset.into(),
            new_chat_in_new_window: s.new_chat_in_new_window.into(),
            cycle_detached_window: s.cycle_detached_window.into(),
            browser_toggle_share_with_agent: s.browser_toggle_share_with_agent.into(),
            browser_pick_element: s.browser_pick_element.into(),
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
