use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use napi::bindgen_prelude::*;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::super::database;

const DEFAULT_LANGUAGE_SETTING_NAME: &str = "Language";
const DEFAULT_LANGUAGE_SETTING_CODE: &str = "language";
const DEFAULT_LANGUAGE_SETTING_VALUE: &str = "en";

const DEFAULT_PROXY_BROWSER_SETTING_NAME: &str = "Proxy and browser settings";
const DEFAULT_PROXY_BROWSER_SETTING_CODE: &str = "proxy_browser_settings";
const DEFAULT_PROXY_BROWSER_SETTING_VALUE: &str = "{\"enabled\":false,\"port\":7890,\"browserPath\":\"\",\"browserDebugPort\":9222,\"searchEngine\":\"duckduckgo\"}";

const DEFAULT_TERMINAL_SETTING_NAME: &str = "Terminal settings";
const DEFAULT_TERMINAL_SETTING_CODE: &str = "terminal_settings";
const DEFAULT_TERMINAL_SETTING_VALUE: &str = "{\"shellPath\":\"\",\"fontFamily\":\"\",\"fontSize\":14,\"fontWeight\":\"normal\",\"lineHeight\":1.2}";

const DEFAULT_CODEBASE_SETTING_NAME: &str = "Codebase settings";
const DEFAULT_CODEBASE_SETTING_CODE: &str = "codebase_settings";
const DEFAULT_CODEBASE_SETTING_VALUE: &str = "{\"profileName\":\"default\",\"embeddingType\":\"jina\",\"embeddingModelName\":\"\",\"embeddingBaseUrl\":\"\",\"embeddingApiKey\":\"\",\"embeddingDimensions\":1536,\"batchMaxLines\":10,\"batchConcurrency\":3,\"chunkingMaxLinesPerChunk\":200,\"chunkingMinLinesPerChunk\":10,\"chunkingMinCharsPerChunk\":20,\"chunkingOverlapLines\":20,\"rerankingModelName\":\"\",\"rerankingBaseUrl\":\"\",\"rerankingApiKey\":\"\",\"rerankingContextLength\":4096,\"rerankingTopN\":5,\"configJson\":\"{}\",\"source\":\"manual\"}";

const DEFAULT_YOLO_MODE_SETTING_NAME: &str = "YOLO mode";
const DEFAULT_YOLO_MODE_SETTING_CODE: &str = "yolo_mode";
const DEFAULT_YOLO_MODE_SETTING_VALUE: &str = "false";

const DEFAULT_REQUEST_LOGGING_SETTING_NAME: &str = "Request logging";
const DEFAULT_REQUEST_LOGGING_SETTING_CODE: &str = "request_logging";
const DEFAULT_REQUEST_LOGGING_SETTING_VALUE: &str = "false";

// 请求日志自动关闭时间（Unix epoch 毫秒）。0 表示未设置。
// 开启请求日志时必须同时写入该值，到期后 Rust 写入路径会拒绝记录并自动复位开关，
// 避免用户忘记关闭导致持续大量写盘。
const DEFAULT_REQUEST_LOGGING_EXPIRY_SETTING_NAME: &str = "Request logging expiry";
const DEFAULT_REQUEST_LOGGING_EXPIRY_SETTING_CODE: &str = "request_logging_expires_at";
const DEFAULT_REQUEST_LOGGING_EXPIRY_SETTING_VALUE: &str = "0";

const DEFAULT_IMAGE_LIBRARY_DIR_SETTING_NAME: &str = "Image library directory";
const DEFAULT_IMAGE_LIBRARY_DIR_SETTING_CODE: &str = "image_library_dir";
const DEFAULT_IMAGE_LIBRARY_DIR_SETTING_VALUE: &str = "";

const DEFAULT_PRIVACY_SETTING_NAME: &str = "Privacy settings";
const DEFAULT_PRIVACY_SETTING_CODE: &str = "privacy_settings";
const DEFAULT_PRIVACY_SETTING_VALUE: &str = "{\"enabled\":false,\"mode\":\"local\",\"api\":{\"url\":\"\",\"apiKey\":\"\",\"model\":\"openai/privacy-filter\"},\"toolResults\":{\"tools\":[\"filesystem-read\",\"grep-search\",\"bash-terminal-execute\"]}}";

const DEFAULT_THEME_SETTING_NAME: &str = "Theme settings";
const DEFAULT_THEME_SETTING_CODE: &str = "theme_settings";
// 默认主题：跟随系统 + snow 预设 + 无背景图 + 100% 不透明
const DEFAULT_THEME_SETTING_VALUE: &str = "{\"mode\":\"system\",\"presetId\":\"snow\",\"custom\":{\"light\":{\"bgPrimary\":\"#ffffff\",\"bgSecondary\":\"#f9fafb\",\"bgTertiary\":\"#f3f4f6\",\"bgHover\":\"#f3f4f6\",\"bgActive\":\"#e5e7eb\",\"chromeBg\":\"#f8fafc\",\"appBg\":\"#eef2f7\",\"borderColor\":\"#e5e7eb\",\"borderLight\":\"#f3f4f6\",\"borderSubtle\":\"#d1d5db\",\"textPrimary\":\"#111827\",\"textSecondary\":\"#374151\",\"textTertiary\":\"#6b7280\",\"textMuted\":\"#9ca3af\",\"accentGreen\":\"#22c55e\",\"accentGreenBg\":\"#dcfce7\",\"accentGreenText\":\"#166534\",\"accentRed\":\"#ef4444\",\"accentRedBg\":\"#fee2e2\",\"accentRedText\":\"#991b1b\",\"accentBlue\":\"#3b82f6\",\"accentBlueBg\":\"#dbeafe\",\"accentBlueText\":\"#1d4ed8\",\"onSolid\":\"#ffffff\",\"selectionBg\":\"rgba(59, 130, 246, 0.2)\",\"focusRing\":\"rgba(17, 24, 39, 0.06)\"},\"dark\":{\"bgPrimary\":\"#0a0a0a\",\"bgSecondary\":\"#111111\",\"bgTertiary\":\"#1a1a1a\",\"bgHover\":\"#1f1f1f\",\"bgActive\":\"#2a2a2a\",\"chromeBg\":\"#141414\",\"appBg\":\"#050505\",\"borderColor\":\"#2b2b2b\",\"borderLight\":\"#202020\",\"borderSubtle\":\"#3a3a3a\",\"textPrimary\":\"#f5f5f5\",\"textSecondary\":\"#d4d4d4\",\"textTertiary\":\"#a3a3a3\",\"textMuted\":\"#737373\",\"accentGreen\":\"#4ade80\",\"accentGreenBg\":\"rgba(34, 197, 94, 0.18)\",\"accentGreenText\":\"#86efac\",\"accentRed\":\"#f87171\",\"accentRedBg\":\"rgba(239, 68, 68, 0.18)\",\"accentRedText\":\"#fca5a5\",\"accentBlue\":\"#58a6ff\",\"accentBlueBg\":\"rgba(59, 130, 246, 0.18)\",\"accentBlueText\":\"#93c5fd\",\"onSolid\":\"#0a0a0a\",\"selectionBg\":\"rgba(88, 166, 255, 0.28)\",\"focusRing\":\"rgba(212, 212, 212, 0.14)\"}},\"background\":{\"enabled\":false,\"imagePath\":\"\",\"opacity\":1.0,\"blur\":0},\"fontFamily\":\"\",\"streamCursor\":{\"iconType\":\"dot\",\"lucideName\":\"\",\"svgPath\":\"\",\"iconSize\":14.0}}";

const PROJECT_MCP_SETTING_NAME: &str = "Project MCP scope";
const PROJECT_MCP_SETTING_CODE_PREFIX: &str = "project_mcp_scope_";
const PROJECT_SKILLS_SETTING_NAME: &str = "Project Skills scope";
const PROJECT_SKILLS_SETTING_CODE_PREFIX: &str = "project_skills_scope_";

const PROJECT_CODEBASE_SETTING_NAME: &str = "Project Codebase scope";
const PROJECT_CODEBASE_SETTING_CODE_PREFIX: &str = "project_codebase_scope_";

const PROJECT_TOOL_APPROVAL_SETTING_NAME: &str = "Project Tool approval scope";
const PROJECT_TOOL_APPROVAL_SETTING_CODE_PREFIX: &str = "project_tool_approval_scope_";

/// Built-in MCP servers that are **disabled by default** — they are only
/// exposed to the model when a project scope explicitly enables them via
/// the `enabled_server_ids` whitelist. This saves request context tokens
/// for tools that are only useful on demand (e.g. terminal control).
const DEFAULT_DISABLED_BUILTIN_SERVERS: &[&str] = &["terminal"];

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct McpProjectScopeSettings {
    pub project_id: String,
    pub disabled_server_ids: BTreeSet<String>,
    pub disabled_tool_names: BTreeSet<String>,
    /// Whitelist of servers that are disabled-by-default but have been
    /// explicitly enabled by the user for this project. Used together
    /// with `DEFAULT_DISABLED_BUILTIN_SERVERS`: a server in that list is
    /// only enabled when it appears here.
    pub enabled_server_ids: BTreeSet<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SkillsProjectScopeSettings {
    pub project_id: String,
    pub skill_overrides: BTreeMap<String, bool>,
}

impl McpProjectScopeSettings {
    /// Whether a built-in server (by its scope id, e.g. `builtin:terminal`)
    /// is enabled for this project.
    ///
    /// Most servers are enabled by default and only disabled when present
    /// in `disabled_server_ids`. Servers listed in
    /// `DEFAULT_DISABLED_BUILTIN_SERVERS` are disabled by default and must
    /// be explicitly added to `enabled_server_ids` to become active.
    pub fn is_server_enabled(&self, server_id: &str) -> bool {
        if self.disabled_server_ids.contains(server_id) {
            return false;
        }
        if DEFAULT_DISABLED_BUILTIN_SERVERS
            .iter()
            .any(|id| server_id == *id || server_id == format!("builtin:{id}"))
        {
            return self.enabled_server_ids.contains(server_id);
        }
        true
    }

    pub fn is_tool_enabled(&self, tool_name: &str) -> bool {
        !self.disabled_tool_names.contains(tool_name)
    }

    fn set_server_enabled(&mut self, server_id: &str, enabled: bool) {
        if DEFAULT_DISABLED_BUILTIN_SERVERS
            .iter()
            .any(|id| server_id == *id || server_id == format!("builtin:{id}"))
        {
            // For default-disabled servers, toggle the whitelist entry.
            if enabled {
                self.enabled_server_ids.insert(server_id.to_string());
            } else {
                self.enabled_server_ids.remove(server_id);
            }
        } else {
            // For default-enabled servers, toggle the blacklist entry.
            update_disabled_set(&mut self.disabled_server_ids, server_id, enabled);
        }
    }

    fn set_tool_enabled(&mut self, tool_name: &str, enabled: bool) {
        update_disabled_set(&mut self.disabled_tool_names, tool_name, enabled);
    }

    fn normalize(&mut self) {
        self.project_id = self.project_id.trim().to_string();
        self.disabled_server_ids = normalized_set(&self.disabled_server_ids);
        self.disabled_tool_names = normalized_set(&self.disabled_tool_names);
        self.enabled_server_ids = normalized_set(&self.enabled_server_ids);
    }
}

impl SkillsProjectScopeSettings {
    pub fn effective_enabled(&self, skill_key: &str, default_enabled: bool) -> bool {
        self.skill_overrides
            .get(skill_key)
            .copied()
            .unwrap_or(default_enabled)
    }

    fn set_skill_enabled(&mut self, skill_key: &str, enabled: bool) {
        self.skill_overrides.insert(skill_key.to_string(), enabled);
    }

    fn normalize(&mut self) {
        self.project_id = self.project_id.trim().to_string();
        self.skill_overrides = self
            .skill_overrides
            .iter()
            .filter_map(|(skill_key, enabled)| {
                let normalized_skill_key = skill_key.trim();
                (!normalized_skill_key.is_empty())
                    .then(|| (normalized_skill_key.to_string(), *enabled))
            })
            .collect();
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CodebaseProjectScopeSettings {
    pub project_id: String,
    pub enabled: Option<bool>,
    pub enable_agent_review: Option<bool>,
    pub enable_reranking: Option<bool>,
}

impl CodebaseProjectScopeSettings {
    fn set_enabled(&mut self, enabled: bool) {
        self.enabled = Some(enabled);
    }

    fn set_agent_review(&mut self, enabled: bool) {
        self.enable_agent_review = Some(enabled);
    }

    fn set_reranking(&mut self, enabled: bool) {
        self.enable_reranking = Some(enabled);
    }

    fn normalize(&mut self) {
        self.project_id = self.project_id.trim().to_string();
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ToolApprovalProjectScopeSettings {
    pub project_id: String,
    pub approved_tool_names: BTreeSet<String>,
}

impl ToolApprovalProjectScopeSettings {
    fn set_tool_approved(&mut self, tool_name: &str, approved: bool) {
        if approved {
            self.approved_tool_names.insert(tool_name.to_string());
        } else {
            self.approved_tool_names.remove(tool_name);
        }
    }

    fn normalize(&mut self) {
        self.project_id = self.project_id.trim().to_string();
        self.approved_tool_names = normalized_set(&self.approved_tool_names);
    }
}

pub fn seed_default_settings(database_path: &Path) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|connection| seed_default_settings_with_connection(&connection))
        .map_err(|error| database::database_error(database_path, "seed default settings", error))
}

pub fn get_system_setting_value(
    database_path: &Path,
    setting_code: &str,
) -> Result<Option<String>> {
    database::open_connection(database_path)
        .and_then(|connection| {
            connection
                .query_row(
                    "SELECT setting_value FROM system_settings WHERE setting_code = ?1",
                    [setting_code],
                    |row| row.get(0),
                )
                .optional()
        })
        .map_err(|error| database::database_error(database_path, "read system setting", error))
}

pub fn set_system_setting(
    database_path: &Path,
    setting_name: &str,
    setting_code: &str,
    setting_value: &str,
) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|connection| {
            set_system_setting_with_connection(
                &connection,
                setting_name,
                setting_code,
                setting_value,
            )
        })
        .map_err(|error| database::database_error(database_path, "write system setting", error))
}

pub fn get_yolo_mode(database_path: &Path) -> Result<bool> {
    let Some(value) = get_system_setting_value(database_path, DEFAULT_YOLO_MODE_SETTING_CODE)?
    else {
        return Ok(false);
    };

    value.parse::<bool>().map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to parse YOLO mode setting: {error}"),
        )
    })
}

pub fn set_yolo_mode(database_path: &Path, enabled: bool) -> Result<()> {
    set_system_setting(
        database_path,
        DEFAULT_YOLO_MODE_SETTING_NAME,
        DEFAULT_YOLO_MODE_SETTING_CODE,
        if enabled { "true" } else { "false" },
    )
}

pub fn get_request_logging(database_path: &Path) -> Result<bool> {
    let Some(value) =
        get_system_setting_value(database_path, DEFAULT_REQUEST_LOGGING_SETTING_CODE)?
    else {
        return Ok(false);
    };

    value.parse::<bool>().map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to parse Request logging setting: {error}"),
        )
    })
}

pub fn set_request_logging(database_path: &Path, enabled: bool) -> Result<()> {
    set_system_setting(
        database_path,
        DEFAULT_REQUEST_LOGGING_SETTING_NAME,
        DEFAULT_REQUEST_LOGGING_SETTING_CODE,
        if enabled { "true" } else { "false" },
    )
}

pub fn get_request_logging_expiry(database_path: &Path) -> Result<i64> {
    let Some(value) =
        get_system_setting_value(database_path, DEFAULT_REQUEST_LOGGING_EXPIRY_SETTING_CODE)?
    else {
        return Ok(0);
    };

    value.parse::<i64>().map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to parse Request logging expiry setting: {error}"),
        )
    })
}

pub fn set_request_logging_expiry(database_path: &Path, expires_at_ms: i64) -> Result<()> {
    set_system_setting(
        database_path,
        DEFAULT_REQUEST_LOGGING_EXPIRY_SETTING_NAME,
        DEFAULT_REQUEST_LOGGING_EXPIRY_SETTING_CODE,
        &expires_at_ms.to_string(),
    )
}

/// 获取图库自定义保存目录。返回空字符串表示未设置（使用默认 ~/.snowapp/image）。
pub fn get_image_library_dir(database_path: &Path) -> Result<String> {
    let Some(value) =
        get_system_setting_value(database_path, DEFAULT_IMAGE_LIBRARY_DIR_SETTING_CODE)?
    else {
        return Ok(String::new());
    };
    Ok(value.trim().to_string())
}

/// 设置图库自定义保存目录。传入空字符串可重置为默认目录。
pub fn set_image_library_dir(database_path: &Path, dir: &str) -> Result<()> {
    set_system_setting(
        database_path,
        DEFAULT_IMAGE_LIBRARY_DIR_SETTING_NAME,
        DEFAULT_IMAGE_LIBRARY_DIR_SETTING_CODE,
        dir.trim(),
    )
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PrivacyApiConfig {
    pub url: String,
    pub api_key: String,
    pub model: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PrivacyToolResultsConfig {
    pub tools: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PrivacySettings {
    pub enabled: bool,
    pub mode: String,
    pub api: PrivacyApiConfig,
    pub tool_results: PrivacyToolResultsConfig,
}

impl PrivacySettings {
    fn normalize(&mut self) {
        self.mode = self.mode.trim().to_string();
        if self.mode.is_empty() {
            self.mode = "local".to_string();
        }
        self.api.url = self.api.url.trim().to_string();
        self.api.api_key = self.api.api_key.trim().to_string();
        self.api.model = self.api.model.trim().to_string();
        if self.api.model.is_empty() {
            self.api.model = "openai/privacy-filter".to_string();
        }
        self.tool_results.tools = self
            .tool_results
            .tools
            .iter()
            .map(|tool| tool.trim().to_string())
            .filter(|tool| !tool.is_empty())
            .collect();
    }
}

pub fn get_privacy_settings(database_path: &Path) -> Result<PrivacySettings> {
    let Some(raw_value) = get_system_setting_value(database_path, DEFAULT_PRIVACY_SETTING_CODE)?
    else {
        return Ok(PrivacySettings::default());
    };

    let mut settings = serde_json::from_str::<PrivacySettings>(&raw_value).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to parse privacy settings: {error}"),
        )
    })?;
    settings.normalize();
    Ok(settings)
}

pub fn set_privacy_settings(database_path: &Path, settings: &PrivacySettings) -> Result<()> {
    let mut normalized = settings.clone();
    normalized.normalize();
    let setting_value = serde_json::to_string(&normalized).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to serialize privacy settings: {error}"),
        )
    })?;
    set_system_setting(
        database_path,
        DEFAULT_PRIVACY_SETTING_NAME,
        DEFAULT_PRIVACY_SETTING_CODE,
        &setting_value,
    )
}

// ===== Theme settings =====

/// 主题调色板，对应渲染层 CSS 变量。每个字段为合法 CSS 颜色字符串
/// （hex 或 rgba()），serde default 使旧数据缺字段时仍可反序列化。
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ThemePalette {
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

impl ThemePalette {
    /// 将空字符串字段填充为占位透明色，避免渲染层 var() 回退为 initial。
    fn normalize(&mut self) {
        let placeholder = "transparent";
        macro_rules! fill {
            ($field:ident) => {
                if self.$field.trim().is_empty() {
                    self.$field = placeholder.to_string();
                } else {
                    self.$field = self.$field.trim().to_string();
                }
            };
        }
        fill!(bg_primary);
        fill!(bg_secondary);
        fill!(bg_tertiary);
        fill!(bg_hover);
        fill!(bg_active);
        fill!(chrome_bg);
        fill!(app_bg);
        fill!(border_color);
        fill!(border_light);
        fill!(border_subtle);
        fill!(text_primary);
        fill!(text_secondary);
        fill!(text_tertiary);
        fill!(text_muted);
        fill!(accent_green);
        fill!(accent_green_bg);
        fill!(accent_green_text);
        fill!(accent_red);
        fill!(accent_red_bg);
        fill!(accent_red_text);
        fill!(accent_blue);
        fill!(accent_blue_bg);
        fill!(accent_blue_text);
        fill!(accent_color);
        fill!(on_solid);
        fill!(selection_bg);
        fill!(focus_ring);
    }
}

/// 自定义主题：亮色 + 暗色两套调色板。
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CustomTheme {
    pub light: ThemePalette,
    pub dark: ThemePalette,
}

impl CustomTheme {
    fn normalize(&mut self) {
        self.light.normalize();
        self.dark.normalize();
    }
}

/// 背景图配置。image_path 为空字符串表示未设置；opacity 范围 0.0~1.0；
/// blur 为高斯模糊像素值（0 表示不模糊）。
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ThemeBackground {
    pub enabled: bool,
    pub image_path: String,
    pub opacity: f64,
    pub blur: f64,
}

impl ThemeBackground {
    fn normalize(&mut self) {
        self.image_path = self.image_path.trim().to_string();
        if !self.opacity.is_finite() || self.opacity < 0.0 {
            self.opacity = 1.0;
        } else if self.opacity > 1.0 {
            self.opacity = 1.0;
        }
        if !self.blur.is_finite() || self.blur < 0.0 {
            self.blur = 0.0;
        } else if self.blur > 100.0 {
            self.blur = 100.0;
        }
        if self.image_path.is_empty() {
            self.enabled = false;
        }
    }
}

/// 流式光标配置。icon_type 决定渲染形态：
/// - "dot"：默认脉动圆点
/// - "lucide"：使用内置 lucide 图标，由 lucide_name 指定
/// - "custom"：使用用户上传的 SVG，由 svg_path 指定文件路径
/// icon_type 为 "lucide" 时 svg_path 应为空；为 "custom" 时 lucide_name 应为空。
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ThemeStreamCursor {
    pub icon_type: String,
    pub lucide_name: String,
    pub svg_path: String,
    pub icon_size: f64,
}

impl ThemeStreamCursor {
    fn normalize(&mut self) {
        self.icon_type = self.icon_type.trim().to_string();
        if !matches!(self.icon_type.as_str(), "dot" | "lucide" | "custom") {
            self.icon_type = "dot".to_string();
        }
        self.lucide_name = self.lucide_name.trim().to_string();
        self.svg_path = self.svg_path.trim().to_string();
        // 图标尺寸范围 8~48，默认 14。
        if !self.icon_size.is_finite() || self.icon_size < 8.0 {
            self.icon_size = 14.0;
        } else if self.icon_size > 48.0 {
            self.icon_size = 48.0;
        }
        // 根据类型清理无关字段，避免持久化数据与实际渲染形态不一致。
        match self.icon_type.as_str() {
            "dot" => {
                self.lucide_name.clear();
                self.svg_path.clear();
            }
            "lucide" => {
                self.svg_path.clear();
                if self.lucide_name.is_empty() {
                    // 退化到默认脉动圆点。
                    self.icon_type = "dot".to_string();
                }
            }
            "custom" => {
                self.lucide_name.clear();
                if self.svg_path.is_empty() {
                    self.icon_type = "dot".to_string();
                }
            }
            _ => {}
        }
    }
}

/// 完整主题设置：模式 + 预设 ID + 自定义调色板 + 背景图 + 字体 + 流式光标。
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ThemeSettings {
    pub mode: String,
    pub preset_id: String,
    pub custom: CustomTheme,
    pub background: ThemeBackground,
    pub font_family: String,
    pub stream_cursor: ThemeStreamCursor,
}

impl ThemeSettings {
    fn normalize(&mut self) {
        self.mode = self.mode.trim().to_string();
        if !matches!(self.mode.as_str(), "system" | "light" | "dark") {
            self.mode = "system".to_string();
        }
        self.preset_id = self.preset_id.trim().to_string();
        if self.preset_id.is_empty() {
            self.preset_id = "snow".to_string();
        }
        self.custom.normalize();
        self.background.normalize();
        self.font_family = self.font_family.trim().to_string();
        self.stream_cursor.normalize();
    }
}

pub fn get_theme_settings(database_path: &Path) -> Result<ThemeSettings> {
    let Some(raw_value) = get_system_setting_value(database_path, DEFAULT_THEME_SETTING_CODE)?
    else {
        return Ok(ThemeSettings::default());
    };

    let mut settings = serde_json::from_str::<ThemeSettings>(&raw_value).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to parse theme settings: {error}"),
        )
    })?;
    settings.normalize();
    Ok(settings)
}

pub fn set_theme_settings(database_path: &Path, settings: &ThemeSettings) -> Result<()> {
    let mut normalized = settings.clone();
    normalized.normalize();
    let setting_value = serde_json::to_string(&normalized).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to serialize theme settings: {error}"),
        )
    })?;
    set_system_setting(
        database_path,
        DEFAULT_THEME_SETTING_NAME,
        DEFAULT_THEME_SETTING_CODE,
        &setting_value,
    )
}

pub fn get_mcp_project_scope_settings(
    database_path: &Path,
    project_id: &str,
) -> Result<McpProjectScopeSettings> {
    let normalized_project_id = normalize_required_value(project_id, "Project id")?;
    let setting_code = project_mcp_setting_code(&normalized_project_id);
    let Some(raw_value) = get_system_setting_value(database_path, &setting_code)? else {
        return Ok(McpProjectScopeSettings {
            project_id: normalized_project_id,
            ..McpProjectScopeSettings::default()
        });
    };

    let mut settings =
        serde_json::from_str::<McpProjectScopeSettings>(&raw_value).map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to parse project MCP scope settings: {error}"),
            )
        })?;
    settings.normalize();
    if settings.project_id.is_empty() {
        settings.project_id = normalized_project_id.clone();
    }
    if settings.project_id != normalized_project_id {
        return Err(Error::new(
            Status::GenericFailure,
            "Project MCP scope setting identity does not match the requested project".to_string(),
        ));
    }

    Ok(settings)
}

pub fn set_mcp_project_server_enabled(
    database_path: &Path,
    project_id: &str,
    server_id: &str,
    enabled: bool,
) -> Result<()> {
    let normalized_server_id = normalize_required_value(server_id, "MCP server id")?;
    let mut settings = get_mcp_project_scope_settings(database_path, project_id)?;
    settings.set_server_enabled(&normalized_server_id, enabled);
    write_mcp_project_scope_settings(database_path, &settings)
}

pub fn set_mcp_project_tool_enabled(
    database_path: &Path,
    project_id: &str,
    tool_name: &str,
    enabled: bool,
) -> Result<()> {
    let normalized_tool_name = normalize_required_value(tool_name, "MCP tool name")?;
    let mut settings = get_mcp_project_scope_settings(database_path, project_id)?;
    settings.set_tool_enabled(&normalized_tool_name, enabled);
    write_mcp_project_scope_settings(database_path, &settings)
}

fn write_mcp_project_scope_settings(
    database_path: &Path,
    settings: &McpProjectScopeSettings,
) -> Result<()> {
    let setting_code = project_mcp_setting_code(&settings.project_id);
    let setting_value = serde_json::to_string(settings).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to serialize project MCP scope settings: {error}"),
        )
    })?;
    set_system_setting(
        database_path,
        PROJECT_MCP_SETTING_NAME,
        &setting_code,
        &setting_value,
    )
}

pub fn get_skills_project_scope_settings(
    database_path: &Path,
    project_id: &str,
) -> Result<SkillsProjectScopeSettings> {
    let normalized_project_id = normalize_required_value(project_id, "Project id")?;
    let setting_code = project_skills_setting_code(&normalized_project_id);
    let Some(raw_value) = get_system_setting_value(database_path, &setting_code)? else {
        return Ok(SkillsProjectScopeSettings {
            project_id: normalized_project_id,
            ..SkillsProjectScopeSettings::default()
        });
    };

    let mut settings =
        serde_json::from_str::<SkillsProjectScopeSettings>(&raw_value).map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to parse project Skills scope settings: {error}"),
            )
        })?;
    settings.normalize();
    if settings.project_id.is_empty() {
        settings.project_id = normalized_project_id.clone();
    }
    if settings.project_id != normalized_project_id {
        return Err(Error::new(
            Status::GenericFailure,
            "Project Skills scope setting identity does not match the requested project"
                .to_string(),
        ));
    }

    Ok(settings)
}

pub fn set_skills_project_skill_enabled(
    database_path: &Path,
    project_id: &str,
    skill_key: &str,
    enabled: bool,
) -> Result<()> {
    let normalized_skill_key = normalize_required_value(skill_key, "Skill key")?;
    let mut settings = get_skills_project_scope_settings(database_path, project_id)?;
    settings.set_skill_enabled(&normalized_skill_key, enabled);
    write_skills_project_scope_settings(database_path, &settings)
}

fn write_skills_project_scope_settings(
    database_path: &Path,
    settings: &SkillsProjectScopeSettings,
) -> Result<()> {
    let setting_code = project_skills_setting_code(&settings.project_id);
    let setting_value = serde_json::to_string(settings).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to serialize project Skills scope settings: {error}"),
        )
    })?;
    set_system_setting(
        database_path,
        PROJECT_SKILLS_SETTING_NAME,
        &setting_code,
        &setting_value,
    )
}

fn project_mcp_setting_code(project_id: &str) -> String {
    format!(
        "{PROJECT_MCP_SETTING_CODE_PREFIX}{}",
        blake3::hash(project_id.as_bytes()).to_hex()
    )
}

fn project_skills_setting_code(project_id: &str) -> String {
    format!(
        "{PROJECT_SKILLS_SETTING_CODE_PREFIX}{}",
        blake3::hash(project_id.as_bytes()).to_hex()
    )
}

pub fn get_codebase_project_scope_settings(
    database_path: &Path,
    project_id: &str,
) -> Result<CodebaseProjectScopeSettings> {
    let normalized_project_id = normalize_required_value(project_id, "Project id")?;
    let setting_code = project_codebase_setting_code(&normalized_project_id);
    let Some(raw_value) = get_system_setting_value(database_path, &setting_code)? else {
        return Ok(CodebaseProjectScopeSettings {
            project_id: normalized_project_id,
            ..CodebaseProjectScopeSettings::default()
        });
    };

    let mut settings =
        serde_json::from_str::<CodebaseProjectScopeSettings>(&raw_value).map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to parse project Codebase scope settings: {error}"),
            )
        })?;
    settings.normalize();
    if settings.project_id.is_empty() {
        settings.project_id = normalized_project_id.clone();
    }
    if settings.project_id != normalized_project_id {
        return Err(Error::new(
            Status::GenericFailure,
            "Project Codebase scope setting identity does not match the requested project"
                .to_string(),
        ));
    }

    Ok(settings)
}

pub fn set_codebase_project_enabled(
    database_path: &Path,
    project_id: &str,
    enabled: bool,
) -> Result<()> {
    let mut settings = get_codebase_project_scope_settings(database_path, project_id)?;
    settings.set_enabled(enabled);
    write_codebase_project_scope_settings(database_path, &settings)
}

pub fn set_codebase_project_agent_review(
    database_path: &Path,
    project_id: &str,
    enabled: bool,
) -> Result<()> {
    let mut settings = get_codebase_project_scope_settings(database_path, project_id)?;
    settings.set_agent_review(enabled);
    write_codebase_project_scope_settings(database_path, &settings)
}

pub fn set_codebase_project_reranking(
    database_path: &Path,
    project_id: &str,
    enabled: bool,
) -> Result<()> {
    let mut settings = get_codebase_project_scope_settings(database_path, project_id)?;
    settings.set_reranking(enabled);
    write_codebase_project_scope_settings(database_path, &settings)
}

fn write_codebase_project_scope_settings(
    database_path: &Path,
    settings: &CodebaseProjectScopeSettings,
) -> Result<()> {
    let setting_code = project_codebase_setting_code(&settings.project_id);
    let setting_value = serde_json::to_string(settings).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to serialize project Codebase scope settings: {error}"),
        )
    })?;
    set_system_setting(
        database_path,
        PROJECT_CODEBASE_SETTING_NAME,
        &setting_code,
        &setting_value,
    )
}

fn project_codebase_setting_code(project_id: &str) -> String {
    format!(
        "{PROJECT_CODEBASE_SETTING_CODE_PREFIX}{}",
        blake3::hash(project_id.as_bytes()).to_hex()
    )
}

pub fn get_tool_approval_project_scope_settings(
    database_path: &Path,
    project_id: &str,
) -> Result<ToolApprovalProjectScopeSettings> {
    let normalized_project_id = normalize_required_value(project_id, "Project id")?;
    let setting_code = project_tool_approval_setting_code(&normalized_project_id);
    let Some(raw_value) = get_system_setting_value(database_path, &setting_code)? else {
        return Ok(ToolApprovalProjectScopeSettings {
            project_id: normalized_project_id,
            ..ToolApprovalProjectScopeSettings::default()
        });
    };

    let mut settings = serde_json::from_str::<ToolApprovalProjectScopeSettings>(&raw_value)
        .map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to parse project Tool approval scope settings: {error}"),
            )
        })?;
    settings.normalize();
    if settings.project_id.is_empty() {
        settings.project_id = normalized_project_id.clone();
    }
    if settings.project_id != normalized_project_id {
        return Err(Error::new(
            Status::GenericFailure,
            "Project Tool approval scope setting identity does not match the requested project"
                .to_string(),
        ));
    }

    Ok(settings)
}

pub fn list_tool_approval_project_approved_tools(
    database_path: &Path,
    project_id: &str,
) -> Result<Vec<String>> {
    let settings = get_tool_approval_project_scope_settings(database_path, project_id)?;
    Ok(settings.approved_tool_names.into_iter().collect())
}

pub fn set_tool_approval_project_tool_approved(
    database_path: &Path,
    project_id: &str,
    tool_name: &str,
    approved: bool,
) -> Result<()> {
    let normalized_tool_name = normalize_required_value(tool_name, "Tool name")?;
    let mut settings = get_tool_approval_project_scope_settings(database_path, project_id)?;
    settings.set_tool_approved(&normalized_tool_name, approved);
    write_tool_approval_project_scope_settings(database_path, &settings)
}

fn write_tool_approval_project_scope_settings(
    database_path: &Path,
    settings: &ToolApprovalProjectScopeSettings,
) -> Result<()> {
    let setting_code = project_tool_approval_setting_code(&settings.project_id);
    let setting_value = serde_json::to_string(settings).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to serialize project Tool approval scope settings: {error}"),
        )
    })?;
    set_system_setting(
        database_path,
        PROJECT_TOOL_APPROVAL_SETTING_NAME,
        &setting_code,
        &setting_value,
    )
}

fn project_tool_approval_setting_code(project_id: &str) -> String {
    format!(
        "{PROJECT_TOOL_APPROVAL_SETTING_CODE_PREFIX}{}",
        blake3::hash(project_id.as_bytes()).to_hex()
    )
}

fn normalize_required_value(value: &str, label: &str) -> Result<String> {
    let normalized = value.trim();
    if normalized.is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            format!("{label} is required"),
        ));
    }

    Ok(normalized.to_string())
}

fn normalized_set(values: &BTreeSet<String>) -> BTreeSet<String> {
    values
        .iter()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect()
}

fn update_disabled_set(values: &mut BTreeSet<String>, value: &str, enabled: bool) {
    if enabled {
        values.remove(value);
    } else {
        values.insert(value.to_string());
    }
}

pub(crate) fn set_system_setting_with_connection(
    connection: &Connection,
    setting_name: &str,
    setting_code: &str,
    setting_value: &str,
) -> rusqlite::Result<()> {
    connection.execute(
        "INSERT INTO system_settings (id, setting_name, setting_code, setting_value, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, datetime('now', 'localtime'), datetime('now', 'localtime'))
         ON CONFLICT(setting_code) DO UPDATE SET
           setting_name = excluded.setting_name,
           setting_value = excluded.setting_value,
           updated_at = datetime('now', 'localtime')",
        (
            database::create_snowflake_id(),
            setting_name,
            setting_code,
            setting_value,
        ),
    )?;

    Ok(())
}

fn insert_default_setting(
    connection: &Connection,
    setting_name: &str,
    setting_code: &str,
    setting_value: &str,
) -> rusqlite::Result<()> {
    connection.execute(
        "INSERT OR IGNORE INTO system_settings (id, setting_name, setting_code, setting_value, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, datetime('now', 'localtime'), datetime('now', 'localtime'))",
        (
            database::create_snowflake_id(),
            setting_name,
            setting_code,
            setting_value,
        ),
    )?;

    Ok(())
}

fn seed_default_settings_with_connection(connection: &Connection) -> rusqlite::Result<()> {
    insert_default_setting(
        connection,
        DEFAULT_LANGUAGE_SETTING_NAME,
        DEFAULT_LANGUAGE_SETTING_CODE,
        DEFAULT_LANGUAGE_SETTING_VALUE,
    )?;
    insert_default_setting(
        connection,
        DEFAULT_PROXY_BROWSER_SETTING_NAME,
        DEFAULT_PROXY_BROWSER_SETTING_CODE,
        DEFAULT_PROXY_BROWSER_SETTING_VALUE,
    )?;
    insert_default_setting(
        connection,
        DEFAULT_TERMINAL_SETTING_NAME,
        DEFAULT_TERMINAL_SETTING_CODE,
        DEFAULT_TERMINAL_SETTING_VALUE,
    )?;
    insert_default_setting(
        connection,
        DEFAULT_CODEBASE_SETTING_NAME,
        DEFAULT_CODEBASE_SETTING_CODE,
        DEFAULT_CODEBASE_SETTING_VALUE,
    )?;
    insert_default_setting(
        connection,
        DEFAULT_YOLO_MODE_SETTING_NAME,
        DEFAULT_YOLO_MODE_SETTING_CODE,
        DEFAULT_YOLO_MODE_SETTING_VALUE,
    )?;
    insert_default_setting(
        connection,
        DEFAULT_REQUEST_LOGGING_SETTING_NAME,
        DEFAULT_REQUEST_LOGGING_SETTING_CODE,
        DEFAULT_REQUEST_LOGGING_SETTING_VALUE,
    )?;
    insert_default_setting(
        connection,
        DEFAULT_REQUEST_LOGGING_EXPIRY_SETTING_NAME,
        DEFAULT_REQUEST_LOGGING_EXPIRY_SETTING_CODE,
        DEFAULT_REQUEST_LOGGING_EXPIRY_SETTING_VALUE,
    )?;
    insert_default_setting(
        connection,
        DEFAULT_IMAGE_LIBRARY_DIR_SETTING_NAME,
        DEFAULT_IMAGE_LIBRARY_DIR_SETTING_CODE,
        DEFAULT_IMAGE_LIBRARY_DIR_SETTING_VALUE,
    )?;
    insert_default_setting(
        connection,
        DEFAULT_PRIVACY_SETTING_NAME,
        DEFAULT_PRIVACY_SETTING_CODE,
        DEFAULT_PRIVACY_SETTING_VALUE,
    )?;
    insert_default_setting(
        connection,
        DEFAULT_THEME_SETTING_NAME,
        DEFAULT_THEME_SETTING_CODE,
        DEFAULT_THEME_SETTING_VALUE,
    )?;

    // Seed keyboard shortcuts default settings (enabled + foregroundOnly).
    super::keyboard_shortcuts::seed_default_keyboard_shortcuts(connection)?;

    Ok(())
}
