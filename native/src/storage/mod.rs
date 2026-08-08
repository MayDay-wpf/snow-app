pub mod database;
mod migrations;
mod paths;
pub mod services;

use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    sync::{Mutex, Once, OnceLock},
};

use napi::bindgen_prelude::*;
use napi_derive::napi;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::api::conversation::images::resolve_inline_images_from_disk;

#[napi(object)]
pub struct AppStorageInfo {
    pub directory_path: String,
    pub database_path: String,
}

#[napi(object)]
pub struct ApiConfigInput {
    pub profile_name: String,
    pub display_name: String,
    pub is_active: bool,
    pub base_url: String,
    pub base_url_mode: String,
    pub api_key: String,
    pub request_method: String,
    pub advanced_model: String,
    pub basic_model: String,
    pub supports_vision: bool,
    pub vision_base_url: String,
    pub vision_base_url_mode: String,
    pub vision_api_key: String,
    pub vision_request_method: String,
    pub vision_model: String,
    pub max_context_tokens: Option<i32>,
    pub max_tokens: Option<i32>,
    pub stream_idle_timeout_sec: Option<i32>,
    pub enable_auto_compress: bool,
    pub auto_compress_threshold: Option<i32>,
    pub max_retries: Option<i32>,
    pub retry_base_delay_ms: Option<i32>,
    pub system_prompt_ids_json: String,
    pub custom_header_scheme_id: String,
    pub config_json: String,
    pub source: String,
}

#[napi(object)]
pub struct ApiConfigRecord {
    pub id: String,
    pub profile_name: String,
    pub display_name: String,
    pub is_active: bool,
    pub base_url: String,
    pub base_url_mode: String,
    pub api_key: String,
    pub request_method: String,
    pub advanced_model: String,
    pub basic_model: String,
    pub supports_vision: bool,
    pub vision_base_url: String,
    pub vision_base_url_mode: String,
    pub vision_api_key: String,
    pub vision_request_method: String,
    pub vision_model: String,
    pub max_context_tokens: Option<i32>,
    pub max_tokens: Option<i32>,
    pub stream_idle_timeout_sec: Option<i32>,
    pub enable_auto_compress: bool,
    pub auto_compress_threshold: Option<i32>,
    pub max_retries: Option<i32>,
    pub retry_base_delay_ms: Option<i32>,
    pub system_prompt_ids_json: String,
    pub custom_header_scheme_id: String,
    pub config_json: String,
    pub source: String,
    pub updated_at: String,
}

#[napi(object)]
pub struct SystemPromptItemInput {
    pub prompt_id: String,
    pub name: String,
    pub content: String,
    pub is_active: bool,
    pub sort_order: i32,
    pub scope: Option<String>,
    pub project_id: Option<String>,
}

#[napi(object)]
pub struct SystemPromptItemRecord {
    pub id: String,
    pub prompt_id: String,
    pub name: String,
    pub content: String,
    pub is_active: bool,
    pub sort_order: i32,
    pub scope: String,
    pub project_id: Option<String>,
    pub updated_at: String,
}

#[napi(object)]
pub struct CustomHeaderSchemeInput {
    pub scheme_id: String,
    pub name: String,
    pub headers_json: String,
    pub is_active: bool,
    pub sort_order: i32,
}

#[napi(object)]
pub struct CustomHeaderSchemeRecord {
    pub id: String,
    pub scheme_id: String,
    pub name: String,
    pub headers_json: String,
    pub is_active: bool,
    pub sort_order: i32,
    pub updated_at: String,
}

#[napi(object)]
pub struct WorkspaceDirectoryInput {
    pub directory_id: String,
    pub name: String,
    pub path: String,
    pub kind: String,
    pub is_active: bool,
    pub sort_order: i32,
    pub source: String,
}

#[napi(object)]
pub struct WorkspaceDirectoryRecord {
    pub id: String,
    pub directory_id: String,
    pub name: String,
    pub path: String,
    pub kind: String,
    pub is_active: bool,
    pub sort_order: i32,
    pub source: String,
    pub updated_at: String,
}

#[napi(object)]
pub struct McpServerConfigInput {
    pub server_id: String,
    pub name: String,
    pub transport_type: String,
    pub url: String,
    pub command: String,
    pub args_json: String,
    pub env_json: String,
    pub headers_json: String,
    pub enabled: bool,
    pub timeout_ms: Option<i32>,
    pub sort_order: i32,
    pub source: String,
}

#[napi(object)]
pub struct McpServerConfigRecord {
    pub id: String,
    pub server_id: String,
    pub name: String,
    pub transport_type: String,
    pub url: String,
    pub command: String,
    pub args_json: String,
    pub env_json: String,
    pub headers_json: String,
    pub enabled: bool,
    pub timeout_ms: Option<i32>,
    pub sort_order: i32,
    pub source: String,
    pub updated_at: String,
}

#[napi(object)]
pub struct ProjectMcpServerConfigRecord {
    pub server_id: String,
    pub name: String,
    pub transport_type: String,
    pub url: String,
    pub command: String,
    pub args_json: String,
    pub env_json: String,
    pub headers_json: String,
    pub enabled: bool,
    pub timeout_ms: Option<i32>,
    pub sort_order: i32,
    pub source: String,
    pub updated_at: String,
}

#[napi(object)]
pub struct ImportResourceSourceInput {
    pub provider: String,
    pub scope: String,
    pub origin_path: String,
    pub project_id: Option<String>,
    pub content_hash: String,
}

#[napi(object)]
pub struct ImportResourceInput {
    pub resource_id: String,
    pub resource_type: String,
    pub scope: String,
    pub project_id: Option<String>,
    pub target_id: String,
    pub target_path: String,
    pub management: String,
    pub sources: Vec<ImportResourceSourceInput>,
}

#[napi(object)]
pub struct ProjectMcpServerImportInput {
    pub project_id: String,
    pub input: McpServerConfigInput,
}

#[napi(object)]
pub struct ImportDatabaseTransactionInput {
    pub mcp_servers: Vec<McpServerConfigInput>,
    pub project_mcp_servers: Vec<ProjectMcpServerImportInput>,
    pub system_prompts: Vec<SystemPromptItemInput>,
    pub plugins: Vec<PluginInput>,
    pub import_resources: Vec<ImportResourceInput>,
}

#[napi(object)]
pub struct ImportResourceSourceRecord {
    pub source_id: String,
    pub provider: String,
    pub scope: String,
    pub origin_path: String,
    pub project_id: Option<String>,
    pub imported_hash: String,
    pub current_hash: String,
    pub last_scanned_at: String,
}

#[napi(object)]
pub struct ImportResourceRecord {
    pub resource_id: String,
    pub resource_type: String,
    pub scope: String,
    pub project_id: Option<String>,
    pub target_id: String,
    pub target_path: String,
    pub management: String,
    pub source_count: i32,
    pub sources: Vec<ImportResourceSourceRecord>,
    pub updated_at: String,
}

#[napi(object)]
pub struct ImportResourceReleaseInput {
    pub resource_id: String,
    pub source_id: String,
    pub disposition: String,
}

#[napi(object)]
pub struct ImportResourceRelease {
    pub resource: ImportResourceRecord,
    pub cleanup_target: bool,
    pub remaining_source_count: i32,
}

#[napi(object)]
pub struct PluginComponentInput {
    pub component_id: String,
    pub component_type: String,
    pub logical_id: String,
    pub target_id: String,
    pub target_path: String,
    pub origin_path: String,
    pub content_hash: String,
    pub status: String,
    pub unsupported_reason: Option<String>,
    pub sort_order: i32,
}

#[napi(object)]
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PluginRuntimeDeclaration {
    pub entry: String,
    pub permissions: Vec<String>,
    pub timeout_ms: i32,
}

#[napi(object)]
pub struct PluginInput {
    pub plugin_id: String,
    pub name: String,
    pub version: String,
    pub provider: String,
    pub source_path: String,
    pub manifest_path: String,
    pub scope: String,
    pub project_id: Option<String>,
    pub state: String,
    pub capabilities: Vec<String>,
    pub runtime: Option<PluginRuntimeDeclaration>,
    pub content_hash: String,
    pub components: Vec<PluginComponentInput>,
}

#[napi(object)]
pub struct PluginComponentRecord {
    pub component_id: String,
    pub plugin_id: String,
    pub component_type: String,
    pub logical_id: String,
    pub target_id: String,
    pub target_path: String,
    pub origin_path: String,
    pub content_hash: String,
    pub status: String,
    pub unsupported_reason: Option<String>,
    pub sort_order: i32,
}

#[napi(object)]
pub struct PluginRecord {
    pub plugin_id: String,
    pub name: String,
    pub version: String,
    pub provider: String,
    pub source_path: String,
    pub manifest_path: String,
    pub scope: String,
    pub project_id: Option<String>,
    pub state: String,
    pub desired_state: String,
    pub capabilities: Vec<String>,
    pub runtime: Option<PluginRuntimeDeclaration>,
    pub content_hash: String,
    pub imported_at: String,
    pub updated_at: String,
    pub components: Vec<PluginComponentRecord>,
}

#[napi(object)]
pub struct PluginMarketplaceInput {
    pub marketplace_id: String,
    pub name: String,
    pub display_name: String,
    pub description: String,
    pub source_type: String,
    pub source_path: String,
    pub ref_name: Option<String>,
    pub cache_path: Option<String>,
    pub manifest_path: String,
    pub content_hash: String,
}

#[napi(object)]
pub struct PluginMarketplaceRecord {
    pub marketplace_id: String,
    pub name: String,
    pub display_name: String,
    pub description: String,
    pub source_type: String,
    pub source_path: String,
    pub ref_name: Option<String>,
    pub cache_path: Option<String>,
    pub manifest_path: String,
    pub content_hash: String,
    pub added_at: String,
    pub updated_at: String,
}

#[napi(object)]
pub struct SubAgentConfigInput {
    pub agent_id: String,
    pub name: String,
    pub description: String,
    pub system_prompt: String,
    pub tools_json: String,
    pub config_profile: String,
    pub model: String,
    pub builtin: bool,
    pub sort_order: i32,
    pub source: String,
    /// 项目 ID。空/缺省表示全局子代理；指定后为项目级子代理
    /// （项目级与全局同 agent_id 时，项目级优先）。
    pub project_id: Option<String>,
}

#[napi(object)]
pub struct SubAgentConfigRecord {
    pub id: String,
    pub agent_id: String,
    pub name: String,
    pub description: String,
    pub system_prompt: String,
    pub tools_json: String,
    pub config_profile: String,
    pub model: String,
    pub builtin: bool,
    pub sort_order: i32,
    pub source: String,
    pub updated_at: String,
    /// 项目 ID，空字符串表示全局子代理。
    pub project_id: String,
}

#[napi(object)]
pub struct SensitiveCommandConfigInput {
    pub command_id: String,
    pub pattern: String,
    pub description: String,
    pub enabled: bool,
    pub is_preset: bool,
    pub sort_order: i32,
    pub source: String,
}

#[napi(object)]
pub struct SensitiveCommandConfigRecord {
    pub id: String,
    pub command_id: String,
    pub pattern: String,
    pub description: String,
    pub enabled: bool,
    pub is_preset: bool,
    pub sort_order: i32,
    pub source: String,
    pub updated_at: String,
}

#[napi(object)]
pub struct ProjectSensitiveCommandConfigInput {
    pub command_id: String,
    pub pattern: String,
    pub description: String,
    pub enabled: bool,
    pub sort_order: i32,
}

#[napi(object)]
pub struct ProjectSensitiveCommandConfigRecord {
    pub command_id: String,
    pub pattern: String,
    pub description: String,
    pub enabled: bool,
    pub inherited: bool,
    pub global_enabled: bool,
    pub is_preset: bool,
    pub sort_order: i32,
    pub source: String,
}

#[napi(object)]
pub struct SensitiveCommandMatchResult {
    pub command_id: String,
    pub pattern: String,
    pub description: String,
}

#[napi(object)]
pub struct HookConfigInput {
    pub hook_type: String,
    pub scope: String,
    pub project_id: Option<String>,
    pub rules_json: String,
}

#[napi(object)]
pub struct HookConfigRecord {
    pub hook_type: String,
    pub scope: String,
    pub project_id: String,
    pub rules_json: String,
    pub updated_at: String,
}

#[napi(object)]
pub struct CodebaseProjectScopeSettings {
    pub project_id: String,
    pub enabled: Option<bool>,
    pub enable_agent_review: Option<bool>,
    pub enable_reranking: Option<bool>,
}

#[napi(object)]
pub struct ChatConversationRecord {
    pub conversation_id: String,
    pub title: String,
    pub summary: String,
    pub last_message_preview: String,
    pub message_count: i32,
    pub model: String,
    pub api_profile_name: String,
    pub status: String,
    pub directory_id: String,
    pub forked_from_conversation_id: String,
    pub fork_message_count: i32,
    pub conversation_type: String,
    pub parent_conversation_id: String,
    pub sub_agent_id: String,
    pub sub_agent_name: String,
    pub sub_agent_status: String,
    pub sub_agent_error: String,
    pub created_at: String,
    pub updated_at: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_creation_input_tokens: i64,
    pub cache_read_input_tokens: i64,
    pub total_duration_ms: i64,
    pub emoji: String,
}

#[napi(object)]
pub struct ChatConversationPage {
    pub items: Vec<ChatConversationRecord>,
    pub total: i32,
}

#[napi(object)]
pub struct ConversationSearchResult {
    pub conversation_id: String,
    pub title: String,
    pub summary: String,
    pub last_message_preview: String,
    pub message_count: i32,
    pub model: String,
    pub status: String,
    pub directory_id: String,
    pub forked_from_conversation_id: String,
    pub fork_message_count: i32,
    pub created_at: String,
    pub updated_at: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_creation_input_tokens: i64,
    pub cache_read_input_tokens: i64,
    pub matched_content: String,
}

#[napi(object)]
pub struct ChatMessageRecord {
    pub id: String,
    pub role: String,
    pub content: String,
    pub thinking: String,
    pub status: String,
    pub model: String,
    pub response_id: String,
    pub checkpoint_id: String,
    pub tool_calls_json: String,
    pub created_at: String,
}

#[napi(object)]
pub struct ChatMessagePage {
    pub items: Vec<ChatMessageRecord>,
    pub total: i32,
    pub has_more: bool,
}

#[napi(object)]
pub struct MemoRecord {
    pub id: String,
    pub memo_id: String,
    pub directory_id: String,
    pub content: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
}

#[napi(object)]
pub struct MemoPage {
    pub items: Vec<MemoRecord>,
    pub total: i32,
    pub has_more: bool,
}

#[napi(object)]
pub struct MemoCountSummary {
    pub total: i32,
    pub pending: i32,
    pub done: i32,
}

static INTERRUPT_MARK_INIT: Once = Once::new();
static MIGRATION_RECOVER_INIT: Once = Once::new();

pub fn initialize_app_storage() -> Result<AppStorageInfo> {
    let database_path = ensure_database_file()?;
    let storage_dir = paths::app_storage_dir()?;

    // Mark any embedding sessions that were still "running" or "paused" when
    // the app was last closed as "interrupted". This should only run ONCE per
    // process lifetime — at startup. Without this guard, every subsequent
    // call to initialize_app_storage() (which happens on every API call)
    // would mark genuinely-active sessions as "interrupted", causing the
    // frontend to show a false "interrupted" prompt when the user switches
    // projects and switches back. Errors here are non-fatal.
    INTERRUPT_MARK_INIT.call_once(|| {
        if let Err(error) =
            services::codebase_embed_sessions::mark_interrupted_sessions(&database_path)
        {
            eprintln!("Failed to mark interrupted codebase sessions: {error}");
        }
    });

    // Recover an image library migration that was interrupted by a crash:
    // roll back uncommitted copies or finish cleanup of a committed one.
    MIGRATION_RECOVER_INIT.call_once(|| {
        if let Err(error) = services::image_library::recover_interrupted_migration() {
            eprintln!("Failed to recover interrupted image library migration: {error}");
        }
    });

    Ok(AppStorageInfo {
        directory_path: storage_dir.to_string_lossy().into_owned(),
        database_path: database_path.to_string_lossy().into_owned(),
    })
}

pub fn get_system_setting_value(setting_code: String) -> Result<Option<String>> {
    let database_path = ensure_database_file()?;
    services::system_settings::get_system_setting_value(&database_path, &setting_code)
}

pub fn set_system_setting(
    setting_name: String,
    setting_code: String,
    setting_value: String,
) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::system_settings::set_system_setting(
        &database_path,
        &setting_name,
        &setting_code,
        &setting_value,
    )
}

pub fn get_yolo_mode() -> Result<bool> {
    let database_path = ensure_database_file()?;
    services::yolo_settings::get_yolo_mode(&database_path)
}

pub fn set_yolo_mode(enabled: bool) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::yolo_settings::set_yolo_mode(&database_path, enabled)
}

pub fn get_conversation_modes(
    conversation_id: &str,
) -> Result<services::chat_conversations::ConversationModes> {
    let database_path = ensure_database_file()?;
    services::chat_conversations::get_conversation_modes(&database_path, conversation_id)
}

pub fn set_conversation_modes(
    conversation_id: &str,
    plan_mode: Option<bool>,
    goal_mode: Option<bool>,
    goal_mode_token_budget: Option<i64>,
) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::chat_conversations::set_conversation_modes(
        &database_path,
        conversation_id,
        plan_mode,
        goal_mode,
        goal_mode_token_budget,
    )
}

pub fn get_request_logging() -> Result<bool> {
    let database_path = ensure_database_file()?;
    services::request_logging_settings::get_request_logging(&database_path)
}

pub fn set_request_logging(enabled: bool) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::request_logging_settings::set_request_logging(&database_path, enabled)
}

pub fn get_request_logging_expiry() -> Result<i64> {
    let database_path = ensure_database_file()?;
    services::request_logging_settings::get_request_logging_expiry(&database_path)
}

pub fn set_request_logging_expiry(expires_at_ms: i64) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::request_logging_settings::set_request_logging_expiry(&database_path, expires_at_ms)
}

pub fn get_privacy_settings() -> Result<services::system_settings::PrivacySettings> {
    let database_path = ensure_database_file()?;
    services::privacy_settings::get_privacy_settings(&database_path)
}

pub fn set_privacy_settings(settings: services::system_settings::PrivacySettings) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::privacy_settings::set_privacy_settings(&database_path, &settings)
}

pub fn get_theme_settings() -> Result<services::system_settings::ThemeSettings> {
    let database_path = ensure_database_file()?;
    services::theme_settings::get_theme_settings(&database_path)
}

pub fn set_theme_settings(settings: services::system_settings::ThemeSettings) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::theme_settings::set_theme_settings(&database_path, &settings)
}

/// 将用户选择的背景图文件复制到 ~/.snowapp/backgrounds/ 目录下，
/// 返回复制后的目标文件绝对路径。文件名使用时间戳 + 原始扩展名，
/// 避免覆盖已有文件。所有文件 I/O 均在调用方的 spawn_blocking 中执行。
pub fn save_theme_background_image(source_path: String) -> Result<String> {
    let trimmed_source = source_path.trim();
    if trimmed_source.is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            "Background image source path is required".to_string(),
        ));
    }

    let source = std::path::Path::new(trimmed_source);
    if !source.exists() {
        return Err(Error::new(
            Status::GenericFailure,
            format!("Background image source file does not exist: {trimmed_source}"),
        ));
    }

    let storage_dir = ensure_storage_dir()?;
    let backgrounds_dir = storage_dir.join("backgrounds");
    fs::create_dir_all(&backgrounds_dir).map_err(|error| {
        Error::from_reason(format!(
            "Failed to create backgrounds directory at '{}': {error}",
            backgrounds_dir.display()
        ))
    })?;

    let extension = source
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_lowercase())
        .filter(|ext| {
            matches!(
                ext.as_str(),
                "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg"
            )
        })
        .unwrap_or_else(|| "png".to_string());

    let timestamp = chrono::Utc::now().format("%Y%m%d%H%M%S").to_string();
    let random_suffix = uuid::Uuid::new_v4().simple().to_string();
    let dest_file_name = format!("bg-{timestamp}-{random_suffix}.{extension}");
    let dest_path = backgrounds_dir.join(&dest_file_name);

    fs::copy(source, &dest_path).map_err(|error| {
        Error::from_reason(format!(
            "Failed to copy background image to '{}': {error}",
            dest_path.display()
        ))
    })?;

    Ok(dest_path.to_string_lossy().into_owned())
}

/// 删除指定的背景图文件。传入空字符串时静默返回 Ok。
pub fn delete_theme_background_image(image_path: String) -> Result<()> {
    let trimmed = image_path.trim();
    if trimmed.is_empty() {
        return Ok(());
    }

    let path = std::path::Path::new(trimmed);
    if !path.exists() {
        return Ok(());
    }

    // 安全检查：只允许删除 ~/.snowapp/backgrounds/ 目录下的文件，
    // 防止误删用户其他位置的文件。
    let storage_dir = paths::app_storage_dir()?;
    let backgrounds_dir = storage_dir.join("backgrounds");
    let canonical_backgrounds = backgrounds_dir.canonicalize().map_err(|error| {
        Error::from_reason(format!("Failed to resolve backgrounds directory: {error}"))
    })?;
    let canonical_target = path.canonicalize().map_err(|error| {
        Error::from_reason(format!("Failed to resolve target image path: {error}"))
    })?;

    if !canonical_target.starts_with(&canonical_backgrounds) {
        return Err(Error::new(
            Status::GenericFailure,
            "Refused to delete a file outside the backgrounds directory".to_string(),
        ));
    }

    fs::remove_file(&canonical_target).map_err(|error| {
        Error::from_reason(format!("Failed to delete background image: {error}"))
    })?;

    Ok(())
}

/// 将用户选择的 SVG 文件复制到 ~/.snowapp/stream-cursors/ 目录下，
/// 返回复制后的目标文件绝对路径。所有文件 I/O 均在调用方的 spawn_blocking 中执行。
pub fn save_theme_stream_cursor_svg(source_path: String) -> Result<String> {
    let trimmed_source = source_path.trim();
    if trimmed_source.is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            "Stream cursor SVG source path is required".to_string(),
        ));
    }

    let source = std::path::Path::new(trimmed_source);
    if !source.exists() {
        return Err(Error::new(
            Status::GenericFailure,
            format!("Stream cursor SVG source file does not exist: {trimmed_source}"),
        ));
    }

    let storage_dir = ensure_storage_dir()?;
    let cursors_dir = storage_dir.join("stream-cursors");
    fs::create_dir_all(&cursors_dir).map_err(|error| {
        Error::from_reason(format!(
            "Failed to create stream-cursors directory at '{}': {error}",
            cursors_dir.display()
        ))
    })?;

    // 仅允许 .svg 扩展名，拒绝其他文件类型。
    let extension = source
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_lowercase())
        .filter(|ext| ext == "svg")
        .unwrap_or_else(|| "svg".to_string());

    let timestamp = chrono::Utc::now().format("%Y%m%d%H%M%S").to_string();
    let random_suffix = uuid::Uuid::new_v4().simple().to_string();
    let dest_file_name = format!("cursor-{timestamp}-{random_suffix}.{extension}");
    let dest_path = cursors_dir.join(&dest_file_name);

    fs::copy(source, &dest_path).map_err(|error| {
        Error::from_reason(format!(
            "Failed to copy stream cursor SVG to '{}': {error}",
            dest_path.display()
        ))
    })?;

    Ok(dest_path.to_string_lossy().into_owned())
}

/// 删除指定的流式光标 SVG 文件。传入空字符串时静默返回 Ok。
pub fn delete_theme_stream_cursor_svg(svg_path: String) -> Result<()> {
    let trimmed = svg_path.trim();
    if trimmed.is_empty() {
        return Ok(());
    }

    let path = std::path::Path::new(trimmed);
    if !path.exists() {
        return Ok(());
    }

    // 安全检查：只允许删除 ~/.snowapp/stream-cursors/ 目录下的文件。
    let storage_dir = paths::app_storage_dir()?;
    let cursors_dir = storage_dir.join("stream-cursors");
    let canonical_cursors = cursors_dir.canonicalize().map_err(|error| {
        Error::from_reason(format!(
            "Failed to resolve stream-cursors directory: {error}"
        ))
    })?;
    let canonical_target = path.canonicalize().map_err(|error| {
        Error::from_reason(format!("Failed to resolve target SVG path: {error}"))
    })?;

    if !canonical_target.starts_with(&canonical_cursors) {
        return Err(Error::new(
            Status::GenericFailure,
            "Refused to delete a file outside the stream-cursors directory".to_string(),
        ));
    }

    fs::remove_file(&canonical_target).map_err(|error| {
        Error::from_reason(format!("Failed to delete stream cursor SVG: {error}"))
    })?;

    Ok(())
}

pub fn get_codebase_project_scope_settings(
    project_id: String,
) -> Result<CodebaseProjectScopeSettings> {
    let database_path = ensure_database_file()?;
    let settings = services::system_settings::get_codebase_project_scope_settings(
        &database_path,
        &project_id,
    )?;
    Ok(CodebaseProjectScopeSettings {
        project_id: settings.project_id,
        enabled: settings.enabled,
        enable_agent_review: settings.enable_agent_review,
        enable_reranking: settings.enable_reranking,
    })
}

pub fn set_codebase_project_enabled(project_id: String, enabled: bool) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::system_settings::set_codebase_project_enabled(&database_path, &project_id, enabled)
}

pub fn set_codebase_project_agent_review(project_id: String, enabled: bool) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::system_settings::set_codebase_project_agent_review(
        &database_path,
        &project_id,
        enabled,
    )
}

pub fn set_codebase_project_reranking(project_id: String, enabled: bool) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::system_settings::set_codebase_project_reranking(&database_path, &project_id, enabled)
}

pub fn list_tool_approval_project_approved_tools(project_id: String) -> Result<Vec<String>> {
    let database_path = ensure_database_file()?;
    services::system_settings::list_tool_approval_project_approved_tools(
        &database_path,
        &project_id,
    )
}

pub fn set_tool_approval_project_tool_approved(
    project_id: String,
    tool_name: String,
    approved: bool,
) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::system_settings::set_tool_approval_project_tool_approved(
        &database_path,
        &project_id,
        &tool_name,
        approved,
    )
}

pub fn check_project_has_gitignore(project_id: String) -> Result<bool> {
    let database_path = ensure_database_file()?;
    let normalized_project_id = project_id.trim().to_string();
    if normalized_project_id.is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            "Project id is required".to_string(),
        ));
    }

    let Some(project_path) = services::workspace_directories::get_workspace_directory_path(
        &database_path,
        &normalized_project_id,
    )?
    else {
        return Ok(false);
    };

    let gitignore_path = PathBuf::from(&project_path).join(".gitignore");
    Ok(gitignore_path.exists())
}

/// Returns whether the project belongs to a remote (SSH) workspace directory.
/// Remote workspaces have no local filesystem to index, so codebase features
/// are unavailable for them.
pub fn check_project_is_remote(project_id: String) -> Result<bool> {
    let database_path = ensure_database_file()?;
    let normalized_project_id = project_id.trim().to_string();
    if normalized_project_id.is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            "Project id is required".to_string(),
        ));
    }

    let Some(kind) = services::workspace_directories::get_workspace_directory_kind(
        &database_path,
        &normalized_project_id,
    )?
    else {
        return Ok(false);
    };

    Ok(kind == "ssh")
}

pub fn list_api_configs() -> Result<Vec<ApiConfigRecord>> {
    let database_path = ensure_database_file()?;
    services::api_configs::list_api_configs(&database_path)
}

pub fn upsert_api_config(config: ApiConfigInput) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::api_configs::upsert_api_config(&database_path, &config)
}

pub fn delete_api_config(profile_name: String) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::api_configs::delete_api_config(&database_path, &profile_name)
}

pub fn list_system_prompts() -> Result<Vec<SystemPromptItemRecord>> {
    let database_path = ensure_database_file()?;
    services::system_prompts::list_system_prompts(&database_path)
}

pub fn upsert_system_prompt(item: SystemPromptItemInput) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::system_prompts::upsert_system_prompt(&database_path, &item)
}

pub fn delete_system_prompt(prompt_id: String) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::system_prompts::delete_system_prompt(&database_path, &prompt_id)
}

pub fn list_custom_header_schemes() -> Result<Vec<CustomHeaderSchemeRecord>> {
    let database_path = ensure_database_file()?;
    services::custom_header_schemes::list_custom_header_schemes(&database_path)
}

pub fn upsert_custom_header_scheme(item: CustomHeaderSchemeInput) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::custom_header_schemes::upsert_custom_header_scheme(&database_path, &item)
}

pub fn delete_custom_header_scheme(scheme_id: String) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::custom_header_schemes::delete_custom_header_scheme(&database_path, &scheme_id)
}

pub fn list_workspace_directories() -> Result<Vec<WorkspaceDirectoryRecord>> {
    let database_path = ensure_database_file()?;
    services::workspace_directories::list_workspace_directories(&database_path)
}

pub fn upsert_workspace_directory(item: WorkspaceDirectoryInput) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::workspace_directories::upsert_workspace_directory(&database_path, &item)
}

pub fn activate_workspace_directory(directory_id: String) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::workspace_directories::activate_workspace_directory(&database_path, &directory_id)
}

pub fn reorder_workspace_directories(items: Vec<WorkspaceDirectoryInput>) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::workspace_directories::reorder_workspace_directories(&database_path, &items)
}
pub fn delete_workspace_directory(directory_id: String) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::workspace_directories::delete_workspace_directory(&database_path, &directory_id)
}

pub fn create_project_directory(parent_path: String, project_name: String) -> Result<String> {
    services::workspace_directories::create_project_directory(&parent_path, &project_name)
}
pub fn read_directory_entries(
    dir_path: String,
) -> Result<Vec<services::fs_explorer::DirectoryEntry>> {
    services::fs_explorer::read_directory_entries(&dir_path)
}

pub fn rename_workspace_entry(
    root_path: String,
    entry_path: String,
    new_name: String,
) -> Result<()> {
    services::fs_explorer::rename_workspace_entry(&root_path, &entry_path, &new_name)
}

pub fn delete_workspace_entry(root_path: String, entry_path: String) -> Result<()> {
    services::fs_explorer::delete_workspace_entry(&root_path, &entry_path)
}

pub fn search_files(
    root_dir: String,
    query: String,
) -> Result<Vec<services::fs_explorer::FileSearchResult>> {
    services::fs_explorer::search_files(&root_dir, &query)
}

pub fn read_file_content(file_path: String) -> Result<services::fs_explorer::FileContentResult> {
    services::fs_explorer::read_file_content(&file_path)
}

pub fn write_file_content(file_path: String, content: String) -> Result<()> {
    services::fs_explorer::write_file_content(&file_path, &content)
}

pub fn list_mcp_server_configs() -> Result<Vec<McpServerConfigRecord>> {
    let database_path = ensure_database_file()?;
    services::mcp_server_configs::list_mcp_server_configs(&database_path)
}

pub fn upsert_mcp_server_config(item: McpServerConfigInput) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::mcp_server_configs::upsert_mcp_server_config(&database_path, &item)
}

pub fn delete_mcp_server_config(server_id: String) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::mcp_server_configs::delete_mcp_server_config(&database_path, &server_id)
}

pub fn list_project_mcp_server_configs(
    project_id: String,
) -> Result<Vec<ProjectMcpServerConfigRecord>> {
    let database_path = ensure_database_file()?;
    services::project_mcp_server_configs::list_project_mcp_server_configs(
        &database_path,
        &project_id,
    )
}

pub fn upsert_project_mcp_server_config(
    project_id: String,
    item: McpServerConfigInput,
) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::project_mcp_server_configs::upsert_project_mcp_server_config(
        &database_path,
        &project_id,
        &item,
    )
}

pub fn delete_project_mcp_server_config(project_id: String, server_id: String) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::project_mcp_server_configs::delete_project_mcp_server_config(
        &database_path,
        &project_id,
        &server_id,
    )
}

pub fn list_import_resources() -> Result<Vec<ImportResourceRecord>> {
    let database_path = ensure_database_file()?;
    services::import_resources::list_import_resources(&database_path)
}

pub fn upsert_import_resources(items: Vec<ImportResourceInput>) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::import_resources::upsert_import_resources(&database_path, &items)
}

pub fn commit_import_transaction(input: ImportDatabaseTransactionInput) -> Result<()> {
    let database_path = ensure_database_file()?;
    commit_import_transaction_at_path(&database_path, input)
}

fn commit_import_transaction_at_path(
    database_path: &std::path::Path,
    input: ImportDatabaseTransactionInput,
) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|mut connection| {
            let transaction = connection.transaction()?;
            for item in &input.mcp_servers {
                services::mcp_server_configs::upsert_mcp_server_config_with_connection(
                    &transaction,
                    item,
                )?;
            }
            for item in &input.project_mcp_servers {
                services::project_mcp_server_configs::upsert_project_mcp_server_config_with_connection(
                    &transaction,
                    &item.project_id,
                    &item.input,
                )?;
            }
            for item in &input.system_prompts {
                services::system_prompts::upsert_system_prompt_with_connection(&transaction, item)?;
            }
            for item in &input.plugins {
                services::plugins::upsert_plugin(&transaction, item)?;
            }
            for item in &input.import_resources {
                services::import_resources::upsert_resource(&transaction, item)?;
            }
            transaction.commit()
        })
        .map_err(|error| database::database_error(database_path, "commit import transaction", error))
}

pub fn release_import_resource(input: ImportResourceReleaseInput) -> Result<ImportResourceRelease> {
    let database_path = ensure_database_file()?;
    services::import_resources::release_import_resource(&database_path, &input)
}

pub fn list_plugins() -> Result<Vec<PluginRecord>> {
    let database_path = ensure_database_file()?;
    services::plugins::list_plugins(&database_path)
}

pub fn upsert_plugins(items: Vec<PluginInput>) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::plugins::upsert_plugins(&database_path, &items)
}

pub fn set_plugin_state(plugin_id: String, state: String) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::plugins::set_plugin_state(&database_path, &plugin_id, &state)
}

pub fn delete_plugin(plugin_id: String) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::plugins::delete_plugin(&database_path, &plugin_id)
}

pub fn list_plugin_marketplaces() -> Result<Vec<PluginMarketplaceRecord>> {
    let database_path = ensure_database_file()?;
    services::plugin_marketplaces::list_plugin_marketplaces(&database_path)
}

pub fn upsert_plugin_marketplace(item: PluginMarketplaceInput) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::plugin_marketplaces::upsert_plugin_marketplace(&database_path, &item)
}

pub fn delete_plugin_marketplace(marketplace_id: String) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::plugin_marketplaces::delete_plugin_marketplace(&database_path, &marketplace_id)
}
/// 列出子代理配置。project_id 为 None 时返回全部（全局 + 所有项目），
/// 指定时只返回该项目的子代理。
pub fn list_sub_agent_configs(project_id: Option<String>) -> Result<Vec<SubAgentConfigRecord>> {
    let database_path = ensure_database_file()?;
    services::sub_agent_configs::list_sub_agent_configs(&database_path, project_id.as_deref())
}

pub fn get_sub_agent_config(
    agent_id: String,
    project_id: Option<String>,
) -> Result<Option<SubAgentConfigRecord>> {
    let database_path = ensure_database_file()?;
    services::sub_agent_configs::get_sub_agent_config(
        &database_path,
        &agent_id,
        project_id.as_deref(),
    )
}

pub fn upsert_sub_agent_config(item: SubAgentConfigInput) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::sub_agent_configs::upsert_sub_agent_config(&database_path, &item)
}

pub fn delete_sub_agent_config(agent_id: String, project_id: Option<String>) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::sub_agent_configs::delete_sub_agent_config(
        &database_path,
        &agent_id,
        project_id.as_deref(),
    )
}

pub fn list_sensitive_command_configs() -> Result<Vec<SensitiveCommandConfigRecord>> {
    let database_path = ensure_database_file()?;
    services::sensitive_command_configs::list_sensitive_command_configs(&database_path)
}

pub fn upsert_sensitive_command_config(item: SensitiveCommandConfigInput) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::sensitive_command_configs::upsert_sensitive_command_config(&database_path, &item)
}

pub fn delete_sensitive_command_config(command_id: String) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::sensitive_command_configs::delete_sensitive_command_config(
        &database_path,
        &command_id,
    )
}

pub fn list_project_sensitive_command_configs(
    project_id: String,
) -> Result<Vec<ProjectSensitiveCommandConfigRecord>> {
    let database_path = ensure_database_file()?;
    services::project_sensitive_command_configs::list_project_sensitive_command_configs(
        &database_path,
        &project_id,
    )
}

pub fn set_project_sensitive_command_enabled(
    project_id: String,
    command_id: String,
    enabled: bool,
) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::project_sensitive_command_configs::set_project_sensitive_command_enabled(
        &database_path,
        &project_id,
        &command_id,
        enabled,
    )
}

pub fn upsert_project_sensitive_command_config(
    project_id: String,
    item: ProjectSensitiveCommandConfigInput,
) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::project_sensitive_command_configs::upsert_project_sensitive_command_config(
        &database_path,
        &project_id,
        &item,
    )
}

pub fn delete_project_sensitive_command_config(
    project_id: String,
    command_id: String,
) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::project_sensitive_command_configs::delete_project_sensitive_command_config(
        &database_path,
        &project_id,
        &command_id,
    )
}

pub fn check_sensitive_command_match(
    command: String,
    project_id: Option<String>,
) -> Result<Vec<SensitiveCommandMatchResult>> {
    let database_path = ensure_database_file()?;
    let configs = if let Some(project_id) = project_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        services::project_sensitive_command_configs::list_project_sensitive_command_configs(
            &database_path,
            project_id,
        )?
        .into_iter()
        .map(|config| {
            (
                config.command_id,
                config.pattern,
                config.description,
                config.enabled,
            )
        })
        .collect::<Vec<_>>()
    } else {
        services::sensitive_command_configs::list_sensitive_command_configs(&database_path)?
            .into_iter()
            .map(|config| {
                (
                    config.command_id,
                    config.pattern,
                    config.description,
                    config.enabled,
                )
            })
            .collect::<Vec<_>>()
    };

    let mut matches = Vec::new();
    for (command_id, pattern, description, enabled) in configs {
        if !enabled {
            continue;
        }

        // Sensitive command patterns are user-provided regular expressions.
        // Skip a malformed rule so one invalid configuration cannot disable
        // all remaining checks.
        let Ok(regex) = Regex::new(&pattern) else {
            continue;
        };
        if regex.is_match(&command) {
            matches.push(SensitiveCommandMatchResult {
                command_id,
                pattern,
                description,
            });
        }
    }

    Ok(matches)
}

pub fn list_hook_configs(
    scope: String,
    project_id: Option<String>,
) -> Result<Vec<HookConfigRecord>> {
    let database_path = ensure_database_file()?;
    services::hooks_configs::list_hook_configs(&database_path, &scope, project_id.as_deref())
}

pub fn upsert_hook_config(item: HookConfigInput) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::hooks_configs::upsert_hook_config(&database_path, &item)
}

pub fn delete_hook_config(
    hook_type: String,
    scope: String,
    project_id: Option<String>,
) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::hooks_configs::delete_hook_config(
        &database_path,
        &hook_type,
        &scope,
        project_id.as_deref(),
    )
}

pub fn list_chat_conversations(directory_id: String) -> Result<Vec<ChatConversationRecord>> {
    let database_path = ensure_database_file()?;
    services::chat_conversations::list_chat_conversations(&database_path, &directory_id)
}
pub fn list_chat_conversations_paginated(
    directory_id: String,
    limit: i32,
    offset: i32,
) -> Result<ChatConversationPage> {
    let database_path = ensure_database_file()?;
    services::chat_conversations::list_chat_conversations_paginated(
        &database_path,
        &directory_id,
        limit,
        offset,
    )
}

/// 跨项目按会话 ID 查询会话记录（供「跨项目通知」使用）。
pub fn list_chat_conversations_by_ids(
    conversation_ids: Vec<String>,
) -> Result<Vec<ChatConversationRecord>> {
    let database_path = ensure_database_file()?;
    services::chat_conversations::list_chat_conversations_by_ids(
        &database_path,
        &conversation_ids,
    )
}

pub fn list_pinned_conversations(directory_id: String) -> Result<Vec<ChatConversationRecord>> {
    let database_path = ensure_database_file()?;
    services::chat_conversations::list_pinned_conversations(&database_path, &directory_id)
}

pub fn search_chat_conversations(query: String) -> Result<Vec<ConversationSearchResult>> {
    let database_path = ensure_database_file()?;
    services::chat_conversations::search_chat_conversations(&database_path, &query)
}

pub fn get_chat_conversation(conversation_id: String) -> Result<Option<ChatConversationRecord>> {
    let database_path = ensure_database_file()?;
    services::chat_conversations::get_chat_conversation(&database_path, &conversation_id)
}

pub fn list_sub_agent_conversations(
    parent_conversation_id: String,
) -> Result<Vec<ChatConversationRecord>> {
    let database_path = ensure_database_file()?;
    services::chat_conversations::list_sub_agent_conversations(
        &database_path,
        &parent_conversation_id,
    )
}

pub fn list_sub_agent_conversations_by_parents(
    parent_conversation_ids: Vec<String>,
) -> Result<HashMap<String, Vec<ChatConversationRecord>>> {
    let database_path = ensure_database_file()?;
    services::chat_conversations::list_sub_agent_conversations_by_parents(
        &database_path,
        &parent_conversation_ids,
    )
}

pub fn create_sub_agent_session(
    conversation_id: String,
    parent_conversation_id: String,
    agent_id: String,
    agent_name: String,
    directory_id: String,
    api_profile_name: String,
    model: String,
    title: String,
) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::chat_conversations::create_sub_agent_session(
        &database_path,
        &conversation_id,
        &parent_conversation_id,
        &agent_id,
        &agent_name,
        &directory_id,
        &api_profile_name,
        &model,
        &title,
    )
}

pub fn update_sub_agent_session_status(
    conversation_id: String,
    run_status: String,
    error_message: String,
) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::chat_conversations::update_sub_agent_session_status(
        &database_path,
        &conversation_id,
        &run_status,
        &error_message,
    )
}

pub fn cancel_running_sub_agent_sessions() -> Result<u32> {
    let database_path = ensure_database_file()?;
    let cancelled_count =
        services::chat_conversations::cancel_running_sub_agent_sessions(&database_path)?;
    u32::try_from(cancelled_count).map_err(|_| {
        Error::new(
            Status::GenericFailure,
            "Cancelled sub-agent session count exceeds u32 range".to_string(),
        )
    })
}

pub fn update_conversation_status(conversation_id: String, status: String) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::chat_conversations::update_conversation_status(
        &database_path,
        &conversation_id,
        &status,
    )
}

pub fn rename_conversation(conversation_id: String, title: String) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::chat_conversations::rename_conversation(&database_path, &conversation_id, &title)
}

pub fn update_conversation_emoji(conversation_id: String, emoji: String) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::chat_conversations::update_conversation_emoji(
        &database_path,
        &conversation_id,
        &emoji,
    )
}

pub fn update_conversation_api_profile(
    conversation_id: String,
    profile_name: String,
) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::chat_conversations::update_conversation_api_profile(
        &database_path,
        &conversation_id,
        &profile_name,
    )
}

pub fn delete_conversation(conversation_id: String) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::chat_conversations::delete_conversation(&database_path, &conversation_id)
}

pub fn delete_conversations(conversation_ids: Vec<String>) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::chat_conversations::delete_conversations(&database_path, &conversation_ids)
}

pub fn append_tool_message(conversation_id: String, content: String) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::chat_conversations::append_tool_message(&database_path, &conversation_id, &content)
}

pub fn list_chat_messages(conversation_id: String) -> Result<Vec<ChatMessageRecord>> {
    let database_path = ensure_database_file()?;
    let mut records =
        services::chat_conversations::list_chat_messages(&database_path, &conversation_id)?;
    for record in &mut records {
        record.content = resolve_inline_images_from_disk(&record.content, &database_path);
    }
    Ok(records)
}

/// Lightweight summary of a single user message, used by the chat UI's
/// user-message rail for quick navigation. Only carries the fields the rail
/// needs (id for DOM lookup, content for preview, created_at for ordering),
/// so long conversations do not pay the cost of loading full tool_calls_json
/// and thinking blobs for every message.
#[napi(object)]
pub struct UserMessageSummary {
    pub id: String,
    pub content: String,
    pub created_at: String,
}

pub fn list_user_messages(conversation_id: String) -> Result<Vec<UserMessageSummary>> {
    let database_path = ensure_database_file()?;
    let mut records =
        services::chat_conversations::list_user_messages(&database_path, &conversation_id)?;
    for record in &mut records {
        record.content = resolve_inline_images_from_disk(&record.content, &database_path);
    }
    Ok(records)
}

pub fn list_chat_messages_paginated(
    conversation_id: String,
    before_message_id: String,
    limit: i32,
) -> Result<ChatMessagePage> {
    let database_path = ensure_database_file()?;
    let mut page = services::chat_conversations::list_chat_messages_paginated(
        &database_path,
        &conversation_id,
        &before_message_id,
        limit,
    )?;
    for record in &mut page.items {
        record.content = resolve_inline_images_from_disk(&record.content, &database_path);
    }
    Ok(page)
}

pub fn find_latest_tool_result(
    conversation_id: String,
    tool_name: String,
) -> Result<Option<String>> {
    let database_path = ensure_database_file()?;
    services::chat_conversations::find_latest_tool_result(
        &database_path,
        &conversation_id,
        &tool_name,
    )
}
pub fn fork_conversation(
    source_conversation_id: String,
    up_to_response_id: String,
) -> Result<ChatConversationRecord> {
    let database_path = ensure_database_file()?;
    services::chat_conversations::fork_conversation(
        &database_path,
        &source_conversation_id,
        &up_to_response_id,
    )
}

pub fn truncate_conversation_from_response(
    conversation_id: String,
    response_id: String,
) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::chat_conversations::truncate_conversation_from_response(
        &database_path,
        &conversation_id,
        &response_id,
    )
}

pub fn list_usage_records(
    conversation_id: String,
    directory_id: String,
    limit: i32,
    offset: i32,
) -> Result<services::usage_records::UsageRecordPage> {
    let database_path = ensure_database_file()?;
    services::usage_records::list_usage_records(
        &database_path,
        &conversation_id,
        &directory_id,
        limit,
        offset,
    )
}

pub fn get_usage_summary(
    since: String,
    until: String,
) -> Result<services::usage_records::UsageSummary> {
    let database_path = ensure_database_file()?;
    services::usage_records::get_usage_summary(&database_path, &since, &until)
}

pub fn get_usage_daily_breakdown(
    since: String,
    until: String,
) -> Result<Vec<services::usage_records::DailyUsageBreakdown>> {
    let database_path = ensure_database_file()?;
    services::usage_records::get_usage_daily_breakdown(&database_path, &since, &until)
}

pub fn write_app_log(input: services::app_logs::AppLogInput) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::app_logs::insert_app_log(&database_path, &input)
}

pub fn list_app_logs(
    level: String,
    module: String,
    since: String,
    until: String,
    limit: i32,
    offset: i32,
) -> Result<services::app_logs::AppLogPage> {
    let database_path = ensure_database_file()?;
    services::app_logs::list_app_logs(
        &database_path,
        &level,
        &module,
        &since,
        &until,
        limit,
        offset,
    )
}

pub fn clear_app_logs() -> Result<u32> {
    let database_path = ensure_database_file()?;
    services::app_logs::clear_app_logs(&database_path)
}

/// Cached database path after the first successful initialization.
static DATABASE_PATH_CACHE: OnceLock<PathBuf> = OnceLock::new();

/// Serializes the first-time initialization so that even if multiple
/// `spawn_blocking` tasks call `ensure_database_file()` concurrently at
/// startup, only one thread actually performs schema creation and seeding.
/// All others block on this mutex, wake up, find the cache populated, and
/// return immediately.
static DATABASE_INIT_MUTEX: Mutex<()> = Mutex::new(());

/// Ensures the `.snowapp` storage directory and database schema exist.
///
/// Uses double-checked locking:
/// 1. **Fast path** (no lock): if the cache is already populated, return
///    immediately — this is the hot path for the 80+ API entry points.
/// 2. **Slow path** (mutex-guarded): acquire the mutex, then re-check the
///    cache. If still empty, perform the one-time initialization (create
///    directory, set WAL, create tables, seed defaults) and store the path.
///
/// This guarantees the heavy initialization runs **exactly once** per
/// process lifetime, regardless of how many threads race in.
pub fn ensure_database_file() -> Result<PathBuf> {
    // Fast path: cache hit — no lock, no I/O.
    if let Some(cached) = DATABASE_PATH_CACHE.get() {
        return Ok(cached.clone());
    }

    // Slow path: acquire the init mutex so only one thread initializes.
    let _guard = DATABASE_INIT_MUTEX
        .lock()
        .map_err(|_| Error::from_reason("Snow App database initialization mutex poisoned"))?;

    // Re-check after acquiring the lock — the thread that held the mutex
    // before us may have already populated the cache.
    if let Some(cached) = DATABASE_PATH_CACHE.get() {
        return Ok(cached.clone());
    }

    let storage_dir = ensure_storage_dir()?;
    let database_path = paths::database_file_path(&storage_dir);
    database::ensure_database(&database_path)?;
    services::system_settings::seed_default_settings(&database_path)?;
    services::api_configs::seed_default_api_config(&database_path)?;
    services::sub_agent_configs::seed_default_sub_agent_configs(&database_path)?;
    services::sensitive_command_configs::seed_default_sensitive_command_configs(&database_path)?;
    services::workspace_directories::seed_default_workspace_directory(&database_path)?;

    // Store into the cache so all future calls hit the fast path.
    let _ = DATABASE_PATH_CACHE.set(database_path.clone());
    Ok(database_path)
}

fn ensure_storage_dir() -> Result<PathBuf> {
    let storage_dir = paths::app_storage_dir()?;
    fs::create_dir_all(&storage_dir).map_err(|error| {
        Error::from_reason(format!(
            "Failed to create Snow App storage directory at '{}': {error}",
            storage_dir.display()
        ))
    })?;

    Ok(storage_dir)
}

pub fn get_storage_dir() -> Result<PathBuf> {
    let database_path = ensure_database_file()?;
    Ok(database_path)
}

/// 导出指定会话为 markdown / html / json / csv 格式文本。
/// 文件路径选择与写入由 Electron 主进程 IPC handler 负责，
/// Rust 端仅负责从 SQLite 读取数据并格式化，所有 I/O 在 spawn_blocking 中执行。
pub fn export_conversation(conversation_id: String, format: String) -> Result<String> {
    let database_path = ensure_database_file()?;
    services::conversation_export::export_conversation(&database_path, &conversation_id, &format)
}

// ===== Memos =====

pub fn list_memos(
    directory_id: String,
    limit: i32,
    offset: i32,
    status: Option<String>,
) -> Result<MemoPage> {
    let database_path = ensure_database_file()?;
    services::memos::list_memos(
        &database_path,
        &directory_id,
        limit,
        offset,
        status.as_deref(),
    )
}

pub fn create_memo(directory_id: String, content: String) -> Result<MemoRecord> {
    let database_path = ensure_database_file()?;
    services::memos::create_memo(&database_path, &directory_id, &content)
}

pub fn update_memo_content(memo_id: String, content: String) -> Result<MemoRecord> {
    let database_path = ensure_database_file()?;
    services::memos::update_memo_content(&database_path, &memo_id, &content)
}

pub fn update_memo_status(memo_id: String, status: String) -> Result<MemoRecord> {
    let database_path = ensure_database_file()?;
    services::memos::update_memo_status(&database_path, &memo_id, &status)
}

pub fn delete_memo(memo_id: String) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::memos::delete_memo(&database_path, &memo_id)
}

pub fn get_memo_count_summary(directory_id: String) -> Result<MemoCountSummary> {
    let database_path = ensure_database_file()?;
    services::memos::get_memo_count_summary(&database_path, &directory_id)
}

// ===== Keyboard shortcuts =====

pub fn get_keyboard_shortcuts_settings(
) -> Result<services::keyboard_shortcuts::KeyboardShortcutsSettings> {
    let database_path = ensure_database_file()?;
    services::keyboard_shortcuts::get_keyboard_shortcuts_settings(&database_path)
}

pub fn set_keyboard_shortcuts_settings(
    settings: services::keyboard_shortcuts::KeyboardShortcutsSettings,
) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::keyboard_shortcuts::set_keyboard_shortcuts_settings(&database_path, &settings)
}

// ============================================================================
// 图像管理系统（Image Library）
// ============================================================================

#[napi(object)]
pub struct ImageLibraryRecord {
    pub id: String,
    pub relative_path: String,
    pub file_name: String,
    pub mime_type: String,
    pub size_bytes: i64,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub prompt: String,
    pub model: String,
    pub provider: String,
    pub created_at: String,
    /// 所属相册 id；null = 未归类
    pub album_id: Option<String>,
}

impl From<services::image_library::ImageLibraryRecord> for ImageLibraryRecord {
    fn from(record: services::image_library::ImageLibraryRecord) -> Self {
        ImageLibraryRecord {
            id: record.id,
            relative_path: record.relative_path,
            file_name: record.file_name,
            mime_type: record.mime_type,
            size_bytes: record.size_bytes,
            width: record.width,
            height: record.height,
            prompt: record.prompt,
            model: record.model,
            provider: record.provider,
            created_at: record.created_at,
            album_id: record.album_id,
        }
    }
}

/// 相册记录（napi 结构体）。
#[napi(object)]
pub struct ImageAlbumRecord {
    pub id: String,
    pub name: String,
    pub created_at: String,
    /// 相册封面：最新一张图的图库相对路径（image/...）；空相册为 null
    pub cover_path: Option<String>,
    /// 相册内图片数量
    pub image_count: i64,
}

impl From<services::image_library::ImageAlbumRecord> for ImageAlbumRecord {
    fn from(record: services::image_library::ImageAlbumRecord) -> Self {
        ImageAlbumRecord {
            id: record.id,
            name: record.name,
            created_at: record.created_at,
            cover_path: record.cover_path,
            image_count: record.image_count,
        }
    }
}

/// 图库根目录绝对路径（优先用户自定义路径，回退 `~/.snowapp/image`）。
pub fn get_image_library_root() -> Result<String> {
    services::image_library::image_library_root().map(|path| path.to_string_lossy().into_owned())
}

/// 读取图库自定义保存目录（空字符串表示使用默认目录）。
pub fn get_image_library_dir() -> Result<String> {
    let database_path = ensure_database_file()?;
    services::system_settings::get_image_library_dir(&database_path)
}

/// 设置图库自定义保存目录（传入空字符串重置为默认目录）。
pub fn set_image_library_dir(dir: String) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::system_settings::set_image_library_dir(&database_path, &dir)
}

/// 列出图库全部图片（按创建时间倒序）。
pub fn list_image_library() -> Result<Vec<ImageLibraryRecord>> {
    let database_path = ensure_database_file()?;
    services::image_library::list_images(&database_path)
        .map(|records| records.into_iter().map(ImageLibraryRecord::from).collect())
}

/// 列出全部相册（按创建时间倒序），含封面路径与图片数量。
pub fn list_image_albums() -> Result<Vec<ImageAlbumRecord>> {
    let database_path = ensure_database_file()?;
    services::image_library::list_albums(&database_path)
        .map(|records| records.into_iter().map(ImageAlbumRecord::from).collect())
}

/// 创建相册（名称去除首尾空白，不允许为空）。
pub fn create_image_album(name: String) -> Result<ImageAlbumRecord> {
    let database_path = ensure_database_file()?;
    services::image_library::create_album(&database_path, &name).map(ImageAlbumRecord::from)
}

/// 重命名相册。
pub fn rename_image_album(id: String, name: String) -> Result<ImageAlbumRecord> {
    let database_path = ensure_database_file()?;
    services::image_library::rename_album(&database_path, &id, &name).map(ImageAlbumRecord::from)
}

/// 删除相册：相册内图片保留（album_id 置空）。
pub fn delete_image_album(id: String) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::image_library::delete_album(&database_path, &id)
}

/// 将图片移入 / 移出相册（album_id 传 null 表示移出到未分类）。
pub fn set_image_album(image_id: String, album_id: Option<String>) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::image_library::set_image_album(&database_path, &image_id, album_id.as_deref())
}

/// 手动导入图片文件（复制进图库目录并写入索引），返回成功导入的记录。
pub fn import_image_files(file_paths: Vec<String>) -> Result<Vec<ImageLibraryRecord>> {
    let database_path = ensure_database_file()?;
    services::image_library::import_image_files(&database_path, &file_paths)
        .map(|records| records.into_iter().map(ImageLibraryRecord::from).collect())
}

/// 读取图库图片并返回 data URL；路径非法或文件不存在返回 None。
pub fn read_image_library_file(relative_path: &str) -> Result<Option<String>> {
    services::image_library::read_image_file(relative_path)
}

/// 删除图片：物理文件 + 索引 + 同步重写引用该图的会话消息。
pub fn delete_image_library_image(id: &str) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::image_library::delete_image(&database_path, id)
}

/// 生成结果落盘 + 索引（由 imagegen 工具调用；失败不阻断，保留 base64）。
pub fn persist_generated_images(
    prompt: &str,
    model: &str,
    provider: &str,
    blocks: &mut Vec<Value>,
) -> Result<Vec<String>> {
    let database_path = ensure_database_file()?;
    services::image_library::persist_generated_images(
        &database_path,
        prompt,
        model,
        provider,
        blocks,
    )
}

/// 统计指定会话中引用的图库图片数量（删除会话确认框展示用）。
pub fn count_conversation_images(conversation_ids: Vec<String>) -> Result<i64> {
    let database_path = ensure_database_file()?;
    services::image_library::count_conversation_images(&database_path, &conversation_ids)
}

/// 级联删除指定会话中引用的图库图片（物理文件 + 索引行）。
/// 由删除会话流程调用；会话本身随后被删除，无需重写消息。
pub fn delete_conversation_images(conversation_ids: Vec<String>) -> Result<i64> {
    let database_path = ensure_database_file()?;
    services::image_library::delete_conversation_images(&database_path, &conversation_ids)
}

/// 图库目录迁移进度。
#[napi(object)]
pub struct MigrationProgress {
    pub copied: u32,
    pub total: u32,
    pub done: bool,
}

/// 准备图库迁移：校验目标目录并写入迁移日志；返回待迁移图片数量（0 表示无需迁移）。
pub fn prepare_image_library_migration(target_dir: String) -> Result<u32> {
    let database_path = ensure_database_file()?;
    services::image_library::prepare_migration(&database_path, &target_dir)
        .map(|count| count as u32)
}

/// 复制下一批图库文件并返回迁移进度（每批最多 16 个，逐文件写入日志保证崩溃可恢复）。
pub fn migrate_image_library_chunk() -> Result<MigrationProgress> {
    let (copied, total, done) = services::image_library::migrate_chunk(16)?;
    Ok(MigrationProgress {
        copied: copied as u32,
        total: total as u32,
        done,
    })
}

/// 提交迁移：写入新目录设置（提交点）并清理旧根目录文件。
pub fn commit_image_library_migration() -> Result<()> {
    let database_path = ensure_database_file()?;
    services::image_library::commit_migration(&database_path)
}

/// 回滚迁移：删除已复制到新目录的文件并移除日志（幂等；无进行中的迁移时直接成功）。
pub fn rollback_image_library_migration() -> Result<()> {
    services::image_library::rollback_migration()
}
