use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use napi::bindgen_prelude::*;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::super::database;

mod privacy;
mod scopes;
mod theme;

pub use self::privacy::*;
pub use self::scopes::*;
pub use self::theme::*;

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
const DEFAULT_CODEBASE_SETTING_VALUE: &str = "{\"profileName\":\"default\",\"embeddingType\":\"jina\",\"embeddingModelName\":\"\",\"embeddingBaseUrl\":\"\",\"embeddingApiKey\":\"\",\"embeddingDimensions\":1536,\"batchMaxLines\":10,\"batchConcurrency\":3,\"chunkingMaxLinesPerChunk\":200,\"chunkingMinLinesPerChunk\":10,\"chunkingMinCharsPerChunk\":20,\"chunkingOverlapLines\":20,\"modelContextLength\":8192,\"rerankingModelName\":\"\",\"rerankingBaseUrl\":\"\",\"rerankingApiKey\":\"\",\"rerankingContextLength\":4096,\"rerankingTopN\":5,\"configJson\":\"{}\",\"source\":\"manual\"}";

const DEFAULT_YOLO_MODE_SETTING_NAME: &str = "YOLO mode";
const DEFAULT_YOLO_MODE_SETTING_CODE: &str = "yolo_mode";
const DEFAULT_YOLO_MODE_SETTING_VALUE: &str = "false";

// 精简模式（全局）：启用后禁用 Browser / App Control / Terminal Control
// 三个内置 MCP 服务器，节约请求上下文，适用于上下文窗口较短的模型。
const DEFAULT_LITE_MODE_SETTING_NAME: &str = "Lite mode";
const DEFAULT_LITE_MODE_SETTING_CODE: &str = "lite_mode";
const DEFAULT_LITE_MODE_SETTING_VALUE: &str = "false";

// 编辑文件后是否自动用 Prettier 格式化（默认开启）。
const DEFAULT_AUTO_FORMAT_SETTING_NAME: &str = "Auto format";
const DEFAULT_AUTO_FORMAT_SETTING_CODE: &str = "auto_format";
const DEFAULT_AUTO_FORMAT_SETTING_VALUE: &str = "true";

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
const DEFAULT_THEME_SETTING_VALUE: &str = "{\"mode\":\"system\",\"presetId\":\"snow\",\"custom\":{\"light\":{\"bgPrimary\":\"#ffffff\",\"bgSecondary\":\"#f9fafb\",\"bgTertiary\":\"#f3f4f6\",\"bgHover\":\"#f3f4f6\",\"bgActive\":\"#e5e7eb\",\"chromeBg\":\"#f8fafc\",\"appBg\":\"#eef2f7\",\"borderColor\":\"#e5e7eb\",\"borderLight\":\"#f3f4f6\",\"borderSubtle\":\"#d1d5db\",\"textPrimary\":\"#111827\",\"textSecondary\":\"#374151\",\"textTertiary\":\"#6b7280\",\"textMuted\":\"#9ca3af\",\"accentGreen\":\"#22c55e\",\"accentGreenBg\":\"#dcfce7\",\"accentGreenText\":\"#166534\",\"accentRed\":\"#ef4444\",\"accentRedBg\":\"#fee2e2\",\"accentRedText\":\"#991b1b\",\"accentBlue\":\"#3b82f6\",\"accentBlueBg\":\"#dbeafe\",\"accentBlueText\":\"#1d4ed8\",\"accentColor\":\"\",\"onSolid\":\"#ffffff\",\"selectionBg\":\"rgba(59, 130, 246, 0.2)\",\"focusRing\":\"rgba(17, 24, 39, 0.06)\"},\"dark\":{\"bgPrimary\":\"#0a0a0a\",\"bgSecondary\":\"#111111\",\"bgTertiary\":\"#1a1a1a\",\"bgHover\":\"#1f1f1f\",\"bgActive\":\"#2a2a2a\",\"chromeBg\":\"#141414\",\"appBg\":\"#050505\",\"borderColor\":\"#2b2b2b\",\"borderLight\":\"#202020\",\"borderSubtle\":\"#3a3a3a\",\"textPrimary\":\"#f5f5f5\",\"textSecondary\":\"#d4d4d4\",\"textTertiary\":\"#a3a3a3\",\"textMuted\":\"#737373\",\"accentGreen\":\"#4ade80\",\"accentGreenBg\":\"rgba(34, 197, 94, 0.18)\",\"accentGreenText\":\"#86efac\",\"accentRed\":\"#f87171\",\"accentRedBg\":\"rgba(239, 68, 68, 0.18)\",\"accentRedText\":\"#fca5a5\",\"accentBlue\":\"#58a6ff\",\"accentBlueBg\":\"rgba(59, 130, 246, 0.18)\",\"accentBlueText\":\"#93c5fd\",\"accentColor\":\"\",\"onSolid\":\"#0a0a0a\",\"selectionBg\":\"rgba(88, 166, 255, 0.28)\",\"focusRing\":\"rgba(212, 212, 212, 0.14)\"}},\"background\":{\"enabled\":false,\"imagePath\":\"\",\"opacity\":1.0,\"blur\":0},\"fontFamily\":\"\",\"streamCursor\":{\"iconType\":\"dot\",\"lucideName\":\"\",\"svgPath\":\"\",\"iconSize\":14.0}}";

const PROJECT_MCP_SETTING_NAME: &str = "Project MCP scope";
const PROJECT_MCP_SETTING_CODE_PREFIX: &str = "project_mcp_scope_";

const GLOBAL_MCP_SETTING_NAME: &str = "Global MCP scope";
const GLOBAL_MCP_SETTING_CODE: &str = "mcp_global_scope";

const PROJECT_SKILLS_SETTING_NAME: &str = "Project Skills scope";
const PROJECT_SKILLS_SETTING_CODE_PREFIX: &str = "project_skills_scope_";

const PROJECT_CODEBASE_SETTING_NAME: &str = "Project Codebase scope";
const PROJECT_CODEBASE_SETTING_CODE_PREFIX: &str = "project_codebase_scope_";

const PROJECT_TOOL_APPROVAL_SETTING_NAME: &str = "Project Tool approval scope";
const PROJECT_TOOL_APPROVAL_SETTING_CODE_PREFIX: &str = "project_tool_approval_scope_";

/// Built-in MCP servers that are **disabled by default** — they are only
/// exposed to the model when a project scope explicitly enables them via
/// the `enabled_server_ids` whitelist. This saves request context tokens
/// for tools that are only useful on demand (e.g. terminal control, LSP
/// semantic analysis — the latter requires user opt-in because it spawns
/// external language-server processes).
const DEFAULT_DISABLED_BUILTIN_SERVERS: &[&str] = &["terminal", "lsp"];

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
pub struct McpGlobalScopeSettings {
    pub disabled_tool_names: BTreeSet<String>,
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

/// 系统设置读取 TTL 缓存。设置项极少变更，而读取路径会被高频调用
/// （team 身份轮询、yolo 模式检查等）；每次读取都 open_connection 会
/// 反复执行 PRAGMA 初始化并解析全库 schema，主进程 CPU 持续高位。
/// 短 TTL 让设置变更最多延迟 200ms 感知，且天然兼容绕过 set/delete
/// 的直接 SQL 写入路径（keyboard_shortcuts 等）。
const SETTINGS_CACHE_TTL: Duration = Duration::from_millis(200);

static SETTINGS_CACHE: OnceLock<Mutex<HashMap<String, (Instant, Option<String>)>>> =
    OnceLock::new();

fn settings_cache() -> &'static Mutex<HashMap<String, (Instant, Option<String>)>> {
    SETTINGS_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn get_system_setting_value(
    database_path: &Path,
    setting_code: &str,
) -> Result<Option<String>> {
    {
        let cache = settings_cache()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some((inserted_at, value)) = cache.get(setting_code) {
            if inserted_at.elapsed() < SETTINGS_CACHE_TTL {
                return Ok(value.clone());
            }
        }
    }

    let value = database::open_connection(database_path)
        .and_then(|connection| {
            connection
                .query_row(
                    "SELECT setting_value FROM system_settings WHERE setting_code = ?1",
                    [setting_code],
                    |row| row.get(0),
                )
                .optional()
        })
        .map_err(|error| database::database_error(database_path, "read system setting", error))?;

    let mut cache = settings_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    cache.insert(setting_code.to_string(), (Instant::now(), value.clone()));
    Ok(value)
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
        .map(|()| {
            // 写入后立即失效缓存，避免 TTL 内的读操作拿到旧值
            // （pets:changed 等广播触发的回读会覆盖界面的乐观更新）。
            settings_cache()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .remove(setting_code);
        })
        .map_err(|error| database::database_error(database_path, "write system setting", error))
}

pub fn delete_system_setting(database_path: &Path, setting_code: &str) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|connection| {
            connection.execute(
                "DELETE FROM system_settings WHERE setting_code = ?1",
                [setting_code],
            )
        })
        .map(|_| {
            // 删除后同样失效缓存，避免读到已删除的旧值。
            settings_cache()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .remove(setting_code);
        })
        .map_err(|error| database::database_error(database_path, "delete system setting", error))
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

pub fn get_lite_mode(database_path: &Path) -> Result<bool> {
    let Some(value) = get_system_setting_value(database_path, DEFAULT_LITE_MODE_SETTING_CODE)?
    else {
        return Ok(false);
    };

    value.parse::<bool>().map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to parse Lite mode setting: {error}"),
        )
    })
}

pub fn set_lite_mode(database_path: &Path, enabled: bool) -> Result<()> {
    set_system_setting(
        database_path,
        DEFAULT_LITE_MODE_SETTING_NAME,
        DEFAULT_LITE_MODE_SETTING_CODE,
        if enabled { "true" } else { "false" },
    )
}

/// 读取「编辑后自动格式化」开关，未配置时默认开启。
pub fn get_auto_format(database_path: &Path) -> Result<bool> {
    let Some(value) =
        get_system_setting_value(database_path, DEFAULT_AUTO_FORMAT_SETTING_CODE)?
    else {
        return Ok(true);
    };

    value.parse::<bool>().map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to parse Auto format setting: {error}"),
        )
    })
}

pub fn set_auto_format(database_path: &Path, enabled: bool) -> Result<()> {
    set_system_setting(
        database_path,
        DEFAULT_AUTO_FORMAT_SETTING_NAME,
        DEFAULT_AUTO_FORMAT_SETTING_CODE,
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
        DEFAULT_LITE_MODE_SETTING_NAME,
        DEFAULT_LITE_MODE_SETTING_CODE,
        DEFAULT_LITE_MODE_SETTING_VALUE,
    )?;
    insert_default_setting(
        connection,
        DEFAULT_AUTO_FORMAT_SETTING_NAME,
        DEFAULT_AUTO_FORMAT_SETTING_CODE,
        DEFAULT_AUTO_FORMAT_SETTING_VALUE,
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
