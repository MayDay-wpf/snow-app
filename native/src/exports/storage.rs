use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::hooks::{HookExecuteInput, HookExecuteResult};
use crate::storage::services::fs_explorer::{DirectoryEntry, FileContentResult, FileSearchResult};
use crate::storage::services::privacy_settings::{
    PrivacyApiConfig, PrivacySettings, PrivacyToolResultsConfig,
};
use crate::storage::services::theme_settings::{
    CustomTheme, ThemeBackground, ThemePalette, ThemeSettings, ThemeStreamCursor,
};
use crate::storage::{
    ApiConfigInput, ApiConfigRecord, AppStorageInfo, ChatConversationPage, ChatConversationRecord,
    ChatMessagePage, ChatMessageRecord, CodebaseProjectScopeSettings, ConversationSearchResult,
    CustomHeaderSchemeInput, CustomHeaderSchemeRecord, HookConfigInput, HookConfigRecord,
    ImportDatabaseTransactionInput, ImportResourceInput, ImportResourceRecord,
    ImportResourceRelease, ImportResourceReleaseInput, McpServerConfigInput, McpServerConfigRecord,
    MemoCountSummary, MemoPage, MemoRecord, PluginInput, PluginMarketplaceInput,
    PluginMarketplaceRecord, PluginRecord, ProjectMcpServerConfigRecord,
    ProjectSensitiveCommandConfigInput, ProjectSensitiveCommandConfigRecord,
    SensitiveCommandConfigInput, SensitiveCommandConfigRecord, SensitiveCommandMatchResult,
    SubAgentConfigInput, SubAgentConfigRecord, SystemPromptItemInput, SystemPromptItemRecord,
    UserMessageSummary, WorkspaceDirectoryInput, WorkspaceDirectoryRecord,
};

// ============================================================================
// 所有 storage NAPI 函数均使用 async + spawn_blocking 模式，
// 确保 SQLite I/O 和文件系统操作不会阻塞 Node.js 主线程。
// ============================================================================

#[napi]
pub async fn initialize_app_storage() -> napi::Result<AppStorageInfo> {
    tokio::task::spawn_blocking(crate::storage::initialize_app_storage)
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn get_system_setting_value(setting_code: String) -> napi::Result<Option<String>> {
    tokio::task::spawn_blocking(move || crate::storage::get_system_setting_value(setting_code))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn set_system_setting(
    setting_name: String,
    setting_code: String,
    setting_value: String,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::set_system_setting(setting_name, setting_code, setting_value)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn get_yolo_mode() -> napi::Result<bool> {
    tokio::task::spawn_blocking(crate::storage::get_yolo_mode)
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn set_yolo_mode(enabled: bool) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::set_yolo_mode(enabled))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn get_request_logging() -> napi::Result<bool> {
    tokio::task::spawn_blocking(crate::storage::get_request_logging)
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn set_request_logging(enabled: bool) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::set_request_logging(enabled))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn get_request_logging_expiry() -> napi::Result<i64> {
    tokio::task::spawn_blocking(crate::storage::get_request_logging_expiry)
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn set_request_logging_expiry(expires_at_ms: i64) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::set_request_logging_expiry(expires_at_ms))
        .await
        .map_err(map_spawn_error)?
}

#[napi(object)]
pub struct PrivacyApiConfigNapi {
    pub url: String,
    pub api_key: String,
    pub model: String,
}

#[napi(object)]
pub struct PrivacyToolResultsConfigNapi {
    pub tools: Vec<String>,
}

#[napi(object)]
pub struct PrivacySettingsNapi {
    pub enabled: bool,
    pub mode: String,
    pub api: PrivacyApiConfigNapi,
    pub tool_results: PrivacyToolResultsConfigNapi,
}

impl From<PrivacySettings> for PrivacySettingsNapi {
    fn from(settings: PrivacySettings) -> Self {
        PrivacySettingsNapi {
            enabled: settings.enabled,
            mode: settings.mode,
            api: PrivacyApiConfigNapi {
                url: settings.api.url,
                api_key: settings.api.api_key,
                model: settings.api.model,
            },
            tool_results: PrivacyToolResultsConfigNapi {
                tools: settings.tool_results.tools,
            },
        }
    }
}

impl From<PrivacySettingsNapi> for PrivacySettings {
    fn from(settings: PrivacySettingsNapi) -> Self {
        PrivacySettings {
            enabled: settings.enabled,
            mode: settings.mode,
            api: PrivacyApiConfig {
                url: settings.api.url,
                api_key: settings.api.api_key,
                model: settings.api.model,
            },
            tool_results: PrivacyToolResultsConfig {
                tools: settings.tool_results.tools,
            },
        }
    }
}

#[napi]
pub async fn get_privacy_settings() -> napi::Result<PrivacySettingsNapi> {
    let settings = tokio::task::spawn_blocking(crate::storage::get_privacy_settings)
        .await
        .map_err(map_spawn_error)??;
    Ok(settings.into())
}

#[napi]
pub async fn set_privacy_settings(settings: PrivacySettingsNapi) -> napi::Result<()> {
    let settings = settings.into();
    tokio::task::spawn_blocking(move || crate::storage::set_privacy_settings(settings))
        .await
        .map_err(map_spawn_error)?
}

// ===== Theme settings NAPI 导出 =====

#[napi(object)]
pub struct ThemePaletteNapi {
    pub bg_primary: String,
    pub bg_secondary: String,
    pub bg_tertiary: String,
    pub bg_hover: String,
    pub bg_active: String,
    pub chrome_bg: String,
    pub app_bg: String,
    pub border_color: String,
    pub border_light: String,
    pub border_subtle: String,
    pub text_primary: String,
    pub text_secondary: String,
    pub text_tertiary: String,
    pub text_muted: String,
    pub accent_green: String,
    pub accent_green_bg: String,
    pub accent_green_text: String,
    pub accent_red: String,
    pub accent_red_bg: String,
    pub accent_red_text: String,
    pub accent_blue: String,
    pub accent_blue_bg: String,
    pub accent_blue_text: String,
    pub accent_color: String,
    pub on_solid: String,
    pub selection_bg: String,
    pub focus_ring: String,
}

impl From<ThemePalette> for ThemePaletteNapi {
    fn from(p: ThemePalette) -> Self {
        ThemePaletteNapi {
            bg_primary: p.bg_primary,
            bg_secondary: p.bg_secondary,
            bg_tertiary: p.bg_tertiary,
            bg_hover: p.bg_hover,
            bg_active: p.bg_active,
            chrome_bg: p.chrome_bg,
            app_bg: p.app_bg,
            border_color: p.border_color,
            border_light: p.border_light,
            border_subtle: p.border_subtle,
            text_primary: p.text_primary,
            text_secondary: p.text_secondary,
            text_tertiary: p.text_tertiary,
            text_muted: p.text_muted,
            accent_green: p.accent_green,
            accent_green_bg: p.accent_green_bg,
            accent_green_text: p.accent_green_text,
            accent_red: p.accent_red,
            accent_red_bg: p.accent_red_bg,
            accent_red_text: p.accent_red_text,
            accent_blue: p.accent_blue,
            accent_blue_bg: p.accent_blue_bg,
            accent_blue_text: p.accent_blue_text,
            accent_color: p.accent_color,
            on_solid: p.on_solid,
            selection_bg: p.selection_bg,
            focus_ring: p.focus_ring,
        }
    }
}

impl From<ThemePaletteNapi> for ThemePalette {
    fn from(p: ThemePaletteNapi) -> Self {
        ThemePalette {
            bg_primary: p.bg_primary,
            bg_secondary: p.bg_secondary,
            bg_tertiary: p.bg_tertiary,
            bg_hover: p.bg_hover,
            bg_active: p.bg_active,
            chrome_bg: p.chrome_bg,
            app_bg: p.app_bg,
            border_color: p.border_color,
            border_light: p.border_light,
            border_subtle: p.border_subtle,
            text_primary: p.text_primary,
            text_secondary: p.text_secondary,
            text_tertiary: p.text_tertiary,
            text_muted: p.text_muted,
            accent_green: p.accent_green,
            accent_green_bg: p.accent_green_bg,
            accent_green_text: p.accent_green_text,
            accent_red: p.accent_red,
            accent_red_bg: p.accent_red_bg,
            accent_red_text: p.accent_red_text,
            accent_blue: p.accent_blue,
            accent_blue_bg: p.accent_blue_bg,
            accent_blue_text: p.accent_blue_text,
            accent_color: p.accent_color,
            on_solid: p.on_solid,
            selection_bg: p.selection_bg,
            focus_ring: p.focus_ring,
        }
    }
}

#[napi(object)]
pub struct CustomThemeNapi {
    pub light: ThemePaletteNapi,
    pub dark: ThemePaletteNapi,
}

impl From<CustomTheme> for CustomThemeNapi {
    fn from(c: CustomTheme) -> Self {
        CustomThemeNapi {
            light: c.light.into(),
            dark: c.dark.into(),
        }
    }
}

impl From<CustomThemeNapi> for CustomTheme {
    fn from(c: CustomThemeNapi) -> Self {
        CustomTheme {
            light: c.light.into(),
            dark: c.dark.into(),
        }
    }
}

#[napi(object)]
pub struct ThemeBackgroundNapi {
    pub enabled: bool,
    pub image_path: String,
    pub opacity: f64,
    pub blur: f64,
}

impl From<ThemeBackground> for ThemeBackgroundNapi {
    fn from(b: ThemeBackground) -> Self {
        ThemeBackgroundNapi {
            enabled: b.enabled,
            image_path: b.image_path,
            opacity: b.opacity,
            blur: b.blur,
        }
    }
}

impl From<ThemeBackgroundNapi> for ThemeBackground {
    fn from(b: ThemeBackgroundNapi) -> Self {
        ThemeBackground {
            enabled: b.enabled,
            image_path: b.image_path,
            opacity: b.opacity,
            blur: b.blur,
        }
    }
}

#[napi(object)]
pub struct ThemeStreamCursorNapi {
    pub icon_type: String,
    pub lucide_name: String,
    pub svg_path: String,
    pub icon_size: f64,
}

impl From<ThemeStreamCursor> for ThemeStreamCursorNapi {
    fn from(c: ThemeStreamCursor) -> Self {
        ThemeStreamCursorNapi {
            icon_type: c.icon_type,
            lucide_name: c.lucide_name,
            svg_path: c.svg_path,
            icon_size: c.icon_size,
        }
    }
}

impl From<ThemeStreamCursorNapi> for ThemeStreamCursor {
    fn from(c: ThemeStreamCursorNapi) -> Self {
        ThemeStreamCursor {
            icon_type: c.icon_type,
            lucide_name: c.lucide_name,
            svg_path: c.svg_path,
            icon_size: c.icon_size,
        }
    }
}

#[napi(object)]
pub struct ThemeSettingsNapi {
    pub mode: String,
    pub preset_id: String,
    pub custom: CustomThemeNapi,
    pub background: ThemeBackgroundNapi,
    pub font_family: String,
    pub stream_cursor: ThemeStreamCursorNapi,
}

impl From<ThemeSettings> for ThemeSettingsNapi {
    fn from(s: ThemeSettings) -> Self {
        ThemeSettingsNapi {
            mode: s.mode,
            preset_id: s.preset_id,
            custom: s.custom.into(),
            background: s.background.into(),
            font_family: s.font_family,
            stream_cursor: s.stream_cursor.into(),
        }
    }
}

impl From<ThemeSettingsNapi> for ThemeSettings {
    fn from(s: ThemeSettingsNapi) -> Self {
        ThemeSettings {
            mode: s.mode,
            preset_id: s.preset_id,
            custom: s.custom.into(),
            background: s.background.into(),
            font_family: s.font_family,
            stream_cursor: s.stream_cursor.into(),
        }
    }
}

#[napi]
pub async fn get_theme_settings() -> napi::Result<ThemeSettingsNapi> {
    let settings = tokio::task::spawn_blocking(crate::storage::get_theme_settings)
        .await
        .map_err(map_spawn_error)??;
    Ok(settings.into())
}

#[napi]
pub async fn set_theme_settings(settings: ThemeSettingsNapi) -> napi::Result<()> {
    let settings = settings.into();
    tokio::task::spawn_blocking(move || crate::storage::set_theme_settings(settings))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn save_theme_background_image(source_path: String) -> napi::Result<String> {
    tokio::task::spawn_blocking(move || crate::storage::save_theme_background_image(source_path))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn delete_theme_background_image(image_path: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::delete_theme_background_image(image_path))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn save_theme_stream_cursor_svg(source_path: String) -> napi::Result<String> {
    tokio::task::spawn_blocking(move || crate::storage::save_theme_stream_cursor_svg(source_path))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn delete_theme_stream_cursor_svg(svg_path: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::delete_theme_stream_cursor_svg(svg_path))
        .await
        .map_err(map_spawn_error)?
}

#[napi(object)]
pub struct ConversationModesResult {
    /// Whether Plan Mode is enabled (true) or disabled (false) for this
    /// conversation. Legacy rows with a NULL flag are read as disabled;
    /// null is only returned when the conversation row does not exist
    /// (follow the global default).
    pub plan_mode: Option<bool>,
    /// Whether Goal Mode is enabled (true) or disabled (false) for this
    /// conversation. Legacy rows with a NULL flag are read as disabled;
    /// null is only returned when the conversation row does not exist
    /// (follow the global default).
    pub goal_mode: Option<bool>,
    /// Per-conversation Goal Mode token budget override (null → follow the
    /// global default budget).
    pub goal_mode_token_budget: Option<i64>,
}

#[napi]
pub async fn get_conversation_modes(
    conversation_id: String,
) -> napi::Result<ConversationModesResult> {
    tokio::task::spawn_blocking(move || {
        crate::storage::get_conversation_modes(&conversation_id).map(|modes| {
            ConversationModesResult {
                plan_mode: modes.plan_mode,
                goal_mode: modes.goal_mode,
                goal_mode_token_budget: modes.goal_mode_token_budget,
            }
        })
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn set_conversation_modes(
    conversation_id: String,
    plan_mode: Option<bool>,
    goal_mode: Option<bool>,
    goal_mode_token_budget: Option<i64>,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::set_conversation_modes(
            &conversation_id,
            plan_mode,
            goal_mode,
            goal_mode_token_budget,
        )
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn get_codebase_project_scope_settings(
    project_id: String,
) -> napi::Result<CodebaseProjectScopeSettings> {
    tokio::task::spawn_blocking(move || {
        crate::storage::get_codebase_project_scope_settings(project_id)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn set_codebase_project_enabled(project_id: String, enabled: bool) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::set_codebase_project_enabled(project_id, enabled)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn set_codebase_project_agent_review(
    project_id: String,
    enabled: bool,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::set_codebase_project_agent_review(project_id, enabled)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn set_codebase_project_reranking(project_id: String, enabled: bool) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::set_codebase_project_reranking(project_id, enabled)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn check_project_has_gitignore(project_id: String) -> napi::Result<bool> {
    tokio::task::spawn_blocking(move || crate::storage::check_project_has_gitignore(project_id))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn check_project_is_remote(project_id: String) -> napi::Result<bool> {
    tokio::task::spawn_blocking(move || crate::storage::check_project_is_remote(project_id))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn list_tool_approval_project_approved_tools(
    project_id: String,
) -> napi::Result<Vec<String>> {
    tokio::task::spawn_blocking(move || {
        crate::storage::list_tool_approval_project_approved_tools(project_id)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn set_tool_approval_project_tool_approved(
    project_id: String,
    tool_name: String,
    approved: bool,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::set_tool_approval_project_tool_approved(project_id, tool_name, approved)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn list_api_configs() -> napi::Result<Vec<ApiConfigRecord>> {
    tokio::task::spawn_blocking(crate::storage::list_api_configs)
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn upsert_api_config(config: ApiConfigInput) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::upsert_api_config(config))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn delete_api_config(profile_name: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::delete_api_config(profile_name))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn list_system_prompts() -> napi::Result<Vec<SystemPromptItemRecord>> {
    tokio::task::spawn_blocking(crate::storage::list_system_prompts)
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn upsert_system_prompt(item: SystemPromptItemInput) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::upsert_system_prompt(item))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn delete_system_prompt(prompt_id: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::delete_system_prompt(prompt_id))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn list_custom_header_schemes() -> napi::Result<Vec<CustomHeaderSchemeRecord>> {
    tokio::task::spawn_blocking(crate::storage::list_custom_header_schemes)
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn upsert_custom_header_scheme(item: CustomHeaderSchemeInput) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::upsert_custom_header_scheme(item))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn delete_custom_header_scheme(scheme_id: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::delete_custom_header_scheme(scheme_id))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn list_workspace_directories() -> napi::Result<Vec<WorkspaceDirectoryRecord>> {
    tokio::task::spawn_blocking(crate::storage::list_workspace_directories)
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn upsert_workspace_directory(item: WorkspaceDirectoryInput) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::upsert_workspace_directory(item))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn activate_workspace_directory(directory_id: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::activate_workspace_directory(directory_id))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn reorder_workspace_directories(
    items: Vec<WorkspaceDirectoryInput>,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::reorder_workspace_directories(items))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn delete_workspace_directory(directory_id: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::delete_workspace_directory(directory_id))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn create_project_directory(
    parent_path: String,
    project_name: String,
) -> napi::Result<String> {
    tokio::task::spawn_blocking(move || {
        crate::storage::create_project_directory(parent_path, project_name)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn read_directory_entries(dir_path: String) -> napi::Result<Vec<DirectoryEntry>> {
    tokio::task::spawn_blocking(move || crate::storage::read_directory_entries(dir_path))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn rename_workspace_entry(
    root_path: String,
    entry_path: String,
    new_name: String,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::rename_workspace_entry(root_path, entry_path, new_name)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn delete_workspace_entry(root_path: String, entry_path: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::delete_workspace_entry(root_path, entry_path)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn search_files(root_dir: String, query: String) -> napi::Result<Vec<FileSearchResult>> {
    tokio::task::spawn_blocking(move || crate::storage::search_files(root_dir, query))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn read_file_content(file_path: String) -> napi::Result<FileContentResult> {
    tokio::task::spawn_blocking(move || crate::storage::read_file_content(file_path))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn write_file_content(file_path: String, content: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::write_file_content(file_path, content))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn list_mcp_server_configs() -> napi::Result<Vec<McpServerConfigRecord>> {
    tokio::task::spawn_blocking(crate::storage::list_mcp_server_configs)
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn upsert_mcp_server_config(item: McpServerConfigInput) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::upsert_mcp_server_config(item))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn delete_mcp_server_config(server_id: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::delete_mcp_server_config(server_id))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn list_project_mcp_server_configs(
    project_id: String,
) -> napi::Result<Vec<ProjectMcpServerConfigRecord>> {
    tokio::task::spawn_blocking(move || crate::storage::list_project_mcp_server_configs(project_id))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn upsert_project_mcp_server_config(
    project_id: String,
    item: McpServerConfigInput,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::upsert_project_mcp_server_config(project_id, item)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn delete_project_mcp_server_config(
    project_id: String,
    server_id: String,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::delete_project_mcp_server_config(project_id, server_id)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn list_import_resources() -> napi::Result<Vec<ImportResourceRecord>> {
    tokio::task::spawn_blocking(crate::storage::list_import_resources)
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn upsert_import_resources(items: Vec<ImportResourceInput>) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::upsert_import_resources(items))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn commit_import_transaction(input: ImportDatabaseTransactionInput) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::commit_import_transaction(input))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn release_import_resource(
    input: ImportResourceReleaseInput,
) -> napi::Result<ImportResourceRelease> {
    tokio::task::spawn_blocking(move || crate::storage::release_import_resource(input))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn list_plugins() -> napi::Result<Vec<PluginRecord>> {
    tokio::task::spawn_blocking(crate::storage::list_plugins)
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn upsert_plugins(items: Vec<PluginInput>) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::upsert_plugins(items))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn set_plugin_state(plugin_id: String, state: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::set_plugin_state(plugin_id, state))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn delete_plugin(plugin_id: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::delete_plugin(plugin_id))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn list_plugin_marketplaces() -> napi::Result<Vec<PluginMarketplaceRecord>> {
    tokio::task::spawn_blocking(crate::storage::list_plugin_marketplaces)
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn upsert_plugin_marketplace(item: PluginMarketplaceInput) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::upsert_plugin_marketplace(item))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn delete_plugin_marketplace(marketplace_id: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::delete_plugin_marketplace(marketplace_id))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn list_hook_configs(
    scope: String,
    project_id: Option<String>,
) -> napi::Result<Vec<HookConfigRecord>> {
    tokio::task::spawn_blocking(move || crate::storage::list_hook_configs(scope, project_id))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn upsert_hook_config(item: HookConfigInput) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::upsert_hook_config(item))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn delete_hook_config(
    hook_type: String,
    scope: String,
    project_id: Option<String>,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::delete_hook_config(hook_type, scope, project_id)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn execute_hooks(input: HookExecuteInput) -> napi::Result<HookExecuteResult> {
    // 获取数据库路径需要文件系统 I/O，使用 spawn_blocking 避免阻塞 Node.js 主线程
    let database_path = tokio::task::spawn_blocking(crate::storage::get_storage_dir)
        .await
        .map_err(map_spawn_error)??;
    // execute_hooks 内部使用 tokio::process::Command 异步执行命令，直接 await
    crate::hooks::execute_hooks(&database_path, &input).await
}

#[napi]
pub async fn list_sub_agent_configs(
    project_id: Option<String>,
) -> napi::Result<Vec<SubAgentConfigRecord>> {
    tokio::task::spawn_blocking(move || crate::storage::list_sub_agent_configs(project_id))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn get_sub_agent_config(
    agent_id: String,
    project_id: Option<String>,
) -> napi::Result<Option<SubAgentConfigRecord>> {
    tokio::task::spawn_blocking(move || crate::storage::get_sub_agent_config(agent_id, project_id))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn upsert_sub_agent_config(item: SubAgentConfigInput) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::upsert_sub_agent_config(item))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn delete_sub_agent_config(
    agent_id: String,
    project_id: Option<String>,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::delete_sub_agent_config(agent_id, project_id)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn list_sensitive_command_configs() -> napi::Result<Vec<SensitiveCommandConfigRecord>> {
    tokio::task::spawn_blocking(crate::storage::list_sensitive_command_configs)
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn upsert_sensitive_command_config(
    item: SensitiveCommandConfigInput,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::upsert_sensitive_command_config(item))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn delete_sensitive_command_config(command_id: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::delete_sensitive_command_config(command_id))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn list_project_sensitive_command_configs(
    project_id: String,
) -> napi::Result<Vec<ProjectSensitiveCommandConfigRecord>> {
    tokio::task::spawn_blocking(move || {
        crate::storage::list_project_sensitive_command_configs(project_id)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn set_project_sensitive_command_enabled(
    project_id: String,
    command_id: String,
    enabled: bool,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::set_project_sensitive_command_enabled(project_id, command_id, enabled)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn upsert_project_sensitive_command_config(
    project_id: String,
    item: ProjectSensitiveCommandConfigInput,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::upsert_project_sensitive_command_config(project_id, item)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn delete_project_sensitive_command_config(
    project_id: String,
    command_id: String,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::delete_project_sensitive_command_config(project_id, command_id)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn check_sensitive_command_match(
    command: String,
    project_id: Option<String>,
) -> napi::Result<Vec<SensitiveCommandMatchResult>> {
    tokio::task::spawn_blocking(move || {
        crate::storage::check_sensitive_command_match(command, project_id)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn list_chat_conversations(
    directory_id: String,
) -> napi::Result<Vec<ChatConversationRecord>> {
    tokio::task::spawn_blocking(move || crate::storage::list_chat_conversations(directory_id))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn list_chat_conversations_paginated(
    directory_id: String,
    limit: i32,
    offset: i32,
) -> napi::Result<ChatConversationPage> {
    tokio::task::spawn_blocking(move || {
        crate::storage::list_chat_conversations_paginated(directory_id, limit, offset)
    })
    .await
    .map_err(map_spawn_error)?
}

/// 跨项目按会话 ID 查询会话记录（供「跨项目通知」使用）。
#[napi]
pub async fn list_chat_conversations_by_ids(
    conversation_ids: Vec<String>,
) -> napi::Result<Vec<ChatConversationRecord>> {
    tokio::task::spawn_blocking(move || {
        crate::storage::list_chat_conversations_by_ids(conversation_ids)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn list_pinned_conversations(
    directory_id: String,
) -> napi::Result<Vec<ChatConversationRecord>> {
    tokio::task::spawn_blocking(move || crate::storage::list_pinned_conversations(directory_id))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn search_chat_conversations(
    query: String,
) -> napi::Result<Vec<ConversationSearchResult>> {
    tokio::task::spawn_blocking(move || crate::storage::search_chat_conversations(query))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn get_chat_conversation(
    conversation_id: String,
) -> napi::Result<Option<ChatConversationRecord>> {
    tokio::task::spawn_blocking(move || crate::storage::get_chat_conversation(conversation_id))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn list_sub_agent_conversations(
    parent_conversation_id: String,
) -> napi::Result<Vec<ChatConversationRecord>> {
    tokio::task::spawn_blocking(move || {
        crate::storage::list_sub_agent_conversations(parent_conversation_id)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn list_sub_agent_conversations_by_parents(
    parent_conversation_ids: Vec<String>,
) -> napi::Result<std::collections::HashMap<String, Vec<ChatConversationRecord>>> {
    tokio::task::spawn_blocking(move || {
        crate::storage::list_sub_agent_conversations_by_parents(parent_conversation_ids)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn create_sub_agent_session(
    conversation_id: String,
    parent_conversation_id: String,
    agent_id: String,
    agent_name: String,
    directory_id: String,
    api_profile_name: String,
    model: String,
    title: String,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::create_sub_agent_session(
            conversation_id,
            parent_conversation_id,
            agent_id,
            agent_name,
            directory_id,
            api_profile_name,
            model,
            title,
        )
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn update_sub_agent_session_status(
    conversation_id: String,
    run_status: String,
    error_message: String,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::update_sub_agent_session_status(conversation_id, run_status, error_message)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn cancel_running_sub_agent_sessions() -> napi::Result<u32> {
    tokio::task::spawn_blocking(crate::storage::cancel_running_sub_agent_sessions)
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn update_conversation_status(
    conversation_id: String,
    status: String,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::update_conversation_status(conversation_id, status)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn rename_conversation(conversation_id: String, title: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::rename_conversation(conversation_id, title))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn update_conversation_emoji(conversation_id: String, emoji: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::update_conversation_emoji(conversation_id, emoji)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn update_conversation_api_profile(
    conversation_id: String,
    profile_name: String,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::update_conversation_api_profile(conversation_id, profile_name)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn delete_conversation(conversation_id: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::delete_conversation(conversation_id))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn delete_conversations(conversation_ids: Vec<String>) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::delete_conversations(conversation_ids))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn append_tool_message(conversation_id: String, content: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::append_tool_message(conversation_id, content)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn list_chat_messages(conversation_id: String) -> napi::Result<Vec<ChatMessageRecord>> {
    tokio::task::spawn_blocking(move || crate::storage::list_chat_messages(conversation_id))
        .await
        .map_err(map_spawn_error)?
}

/// Lightweight list of user messages for the chat UI's user-message rail.
/// Runs on a blocking thread so the Node.js event loop is never blocked.
#[napi]
pub async fn list_user_messages(conversation_id: String) -> napi::Result<Vec<UserMessageSummary>> {
    tokio::task::spawn_blocking(move || crate::storage::list_user_messages(conversation_id))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn list_chat_messages_paginated(
    conversation_id: String,
    before_message_id: String,
    limit: i32,
) -> napi::Result<ChatMessagePage> {
    tokio::task::spawn_blocking(move || {
        crate::storage::list_chat_messages_paginated(conversation_id, before_message_id, limit)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn find_latest_tool_result(
    conversation_id: String,
    tool_name: String,
) -> napi::Result<Option<String>> {
    tokio::task::spawn_blocking(move || {
        crate::storage::find_latest_tool_result(conversation_id, tool_name)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn fork_conversation(
    source_conversation_id: String,
    up_to_response_id: String,
) -> napi::Result<ChatConversationRecord> {
    tokio::task::spawn_blocking(move || {
        crate::storage::fork_conversation(source_conversation_id, up_to_response_id)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn truncate_conversation_from_response(
    conversation_id: String,
    response_id: String,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::truncate_conversation_from_response(conversation_id, response_id)
    })
    .await
    .map_err(map_spawn_error)?
}

/// List TODO items that will be deleted when rolling back to the given
/// response_id within a conversation.  Returns a JSON string.
#[napi]
pub async fn list_todos_for_rollback(
    session_id: String,
    response_id: String,
) -> napi::Result<String> {
    tokio::task::spawn_blocking(move || {
        crate::mcp::servers::todo::TodoService::list_todos_for_rollback(&session_id, &response_id)
    })
    .await
    .map_err(map_spawn_error)?
}

// ===== Usage records NAPI 导出 =====

#[napi]
pub async fn list_usage_records(
    conversation_id: String,
    directory_id: String,
    limit: i32,
    offset: i32,
) -> napi::Result<crate::storage::services::usage_records::UsageRecordPage> {
    tokio::task::spawn_blocking(move || {
        crate::storage::list_usage_records(conversation_id, directory_id, limit, offset)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn get_usage_summary(
    since: String,
    until: String,
) -> napi::Result<crate::storage::services::usage_records::UsageSummary> {
    tokio::task::spawn_blocking(move || crate::storage::get_usage_summary(since, until))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn get_usage_daily_breakdown(
    since: String,
    until: String,
) -> napi::Result<Vec<crate::storage::services::usage_records::DailyUsageBreakdown>> {
    tokio::task::spawn_blocking(move || crate::storage::get_usage_daily_breakdown(since, until))
        .await
        .map_err(map_spawn_error)?
}

// ===== App logs NAPI 导出 =====

#[napi]
pub async fn write_app_log(
    input: crate::storage::services::app_logs::AppLogInput,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::write_app_log(input))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn list_app_logs(
    level: String,
    module: String,
    since: String,
    until: String,
    limit: i32,
    offset: i32,
) -> napi::Result<crate::storage::services::app_logs::AppLogPage> {
    tokio::task::spawn_blocking(move || {
        crate::storage::list_app_logs(level, module, since, until, limit, offset)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn clear_app_logs() -> napi::Result<u32> {
    tokio::task::spawn_blocking(crate::storage::clear_app_logs)
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn export_conversation(conversation_id: String, format: String) -> napi::Result<String> {
    tokio::task::spawn_blocking(move || {
        crate::storage::export_conversation(conversation_id, format)
    })
    .await
    .map_err(map_spawn_error)?
}

// ============================================================================
// Memos — 快速备忘录，状态为 pending / done。
// 所有 SQLite I/O 均在 spawn_blocking 中执行，不阻塞 Node.js。
// ============================================================================

#[napi]
pub async fn list_memos(
    directory_id: String,
    limit: i32,
    offset: i32,
    status: Option<String>,
) -> napi::Result<MemoPage> {
    tokio::task::spawn_blocking(move || {
        crate::storage::list_memos(directory_id, limit, offset, status)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn create_memo(directory_id: String, content: String) -> napi::Result<MemoRecord> {
    tokio::task::spawn_blocking(move || crate::storage::create_memo(directory_id, content))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn update_memo_content(memo_id: String, content: String) -> napi::Result<MemoRecord> {
    tokio::task::spawn_blocking(move || crate::storage::update_memo_content(memo_id, content))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn update_memo_status(memo_id: String, status: String) -> napi::Result<MemoRecord> {
    tokio::task::spawn_blocking(move || crate::storage::update_memo_status(memo_id, status))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn delete_memo(memo_id: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::delete_memo(memo_id))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn get_memo_count_summary(directory_id: String) -> napi::Result<MemoCountSummary> {
    tokio::task::spawn_blocking(move || crate::storage::get_memo_count_summary(directory_id))
        .await
        .map_err(map_spawn_error)?
}

/// 将 tokio JoinError 转换为 napi Error
fn map_spawn_error(e: tokio::task::JoinError) -> Error {
    Error::new(
        Status::GenericFailure,
        format!("Spawned blocking task failed: {}", e),
    )
}

// ============================================================================
// Keyboard shortcuts — 快捷键设置，6 个快捷键各自 enabled + foregroundOnly。
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
