//! Built-in MCP service that lets the agent read and write Snow App global
//! configuration files (`~/.snow/*.json`) through a whitelist-driven
//! key-value API.
//!
//! Tools:
//! - `config-list`   — list manageable scopes and their keys
//! - `config-get`    — read a value (sensitive keys are masked)
//! - `config-set`    — write a value (whitelist + type check + backup + atomic write)
//! - `config-delete` — remove an optional key
//!
//! Safety model:
//! - Only whitelisted scopes/keys are reachable; arbitrary paths are rejected.
//! - Values are type-checked against each key's schema before writing.
//! - Sensitive keys (apiKey, visionApiKey) are masked on read; plaintext is
//!   never returned by this service.
//! - Every write is preceded by a timestamped backup under
//!   `~/.snow/.config-backups/` (latest 10 kept per file) and the target file
//!   is replaced atomically (tmp file + rename) so a crash cannot corrupt it.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use napi::bindgen_prelude::*;
use serde_json::{json, Map, Value};

use super::super::service::McpService;
use super::super::tools::McpTool;

pub const SERVER_ID: &str = "config";

const TOOL_LIST: &str = "list";
const TOOL_GET: &str = "get";
const TOOL_SET: &str = "set";
const TOOL_DELETE: &str = "delete";

/// DB-backed 配置域：子代理配置（写入应用 SQLite 数据库，与 UI 同源）。
/// key = agentId，value = { name, description, systemPrompt, toolsJson, configProfile, model }。
const SCOPE_SUB_AGENTS: &str = "subAgents";

/// DB-backed 配置域：生命周期 hook 配置。
/// key = hookType，value = { rules: [...] }；可选 projectId 表示项目级（缺省为全局）。
const SCOPE_HOOKS: &str = "hooks";

/// 技能管理配置域（委托 SkillsConfigService 实现，存储机制与 UI 一致）。
/// key = skillId；value 含 `enabled` 时切换开关，含 `url`+`location` 时从 GitHub 安装；
/// delete 卸载 GitHub 安装的技能；可选 projectId 表示项目级。
const SCOPE_SKILLS: &str = "skills";

/// 只读日志域：让 agent 列出/读取 ~/.snow/log 下的应用日志用于异常分析。
/// key = 日志文件名（如 `2026-08-03-error.log`）或级别简写（error/warn/info/debug，
/// 读取今天的对应文件）；config-list 返回日志文件清单与错误摘要。
const SCOPE_LOGS: &str = "logs";
/// 图像生成设置域（DB-backed，SQLite system_settings 表）：让 agent 查看/配置
/// 生图多渠道（channels 数组）的启用状态与模型；apiKey 读取时脱敏。
/// key = 渠道 id / 名称 / 协议类型（openai|gemini），或全局键 maxConcurrentImages
/// （缺省返回完整设置）。
const SCOPE_IMAGEGEN: &str = "imagegen";

/// 全局规则/角色定义域（~/.snow/ROLE.md，纯文本 markdown，非 JSON）。
/// key = "role"，value 为规则全文；list 返回长度与预览（不返回全文，
/// 避免占用上下文），get 返回全文；set 原子写全文（写前备份）；
/// delete 需 confirmed，删除文件即恢复默认（应用对缺失 ROLE.md 有内置回退）。
const SCOPE_PERSONALIZATION: &str = "personalization";
/// ROLE.md 文件名（~/.snow/ROLE.md，与 personalizationHandlers.ts 约定一致）。
const ROLE_FILE_NAME: &str = "ROLE.md";
/// personalization scope 的唯一定义键。
const PERSONALIZATION_ROLE_KEY: &str = "role";
/// config-list personalization 返回的预览长度（避免全文进入上下文）。
const ROLE_PREVIEW_LEN: usize = 300;

/// 日志目录名（~/.snow/log）。
const LOG_DIR_NAME: &str = "log";
/// 日志文件名的合法形态：YYYY-MM-DD-(debug|info|warn|error).log。
const LOG_FILE_RE: &str = r"^[0-9]{4}-[0-9]{2}-[0-9]{2}-(debug|info|warn|error)\.log$";
/// 读取日志时默认返回的尾部行数。
const LOG_DEFAULT_LINES: usize = 200;
/// 读取日志时允许的最大行数。
const LOG_MAX_LINES: usize = 2000;

/// 通过 config 工具写入的配置来源标记（与 mcpServers 同步的 source 约定一致）。
const SOURCE_SNOW_CLI: &str = "snow-cli";

/// 内置通用子代理 id，禁止通过 config 工具修改或删除。
const BUILTIN_GENERAL_AGENT_ID: &str = "agent_general";

/// 配置值类型。
#[derive(Clone, Copy)]
enum ValueType {
    String,
    Bool,
    Int,
    Number,
    Object,
    Array,
}

/// 单个键的规格（白名单 + 类型 + 敏感标记）。
struct KeySpec {
    key: &'static str,
    value_type: ValueType,
    sensitive: bool,
}

/// 一个配置域（= 一个文件 + 若干白名单键）。
struct ScopeSpec {
    scope: &'static str,
    file_name: &'static str,
    /// 读写文件中的哪个对象根（如 `snowcfg`），None 表示文件顶层。
    root_key: Option<&'static str>,
    keys: &'static [KeySpec],
}

const SETTINGS_SCOPE_KEYS: &[KeySpec] = &[
    KeySpec {
        key: "mcpServers",
        value_type: ValueType::Object,
        sensitive: false,
    },
    KeySpec {
        key: "codebase",
        value_type: ValueType::Object,
        sensitive: false,
    },
    KeySpec {
        key: "sensitiveCommands",
        value_type: ValueType::Array,
        sensitive: false,
    },
    KeySpec {
        key: "yoloMode",
        value_type: ValueType::Bool,
        sensitive: false,
    },
    KeySpec {
        key: "planMode",
        value_type: ValueType::Bool,
        sensitive: false,
    },
    KeySpec {
        key: "vulnerabilityHuntingMode",
        value_type: ValueType::Bool,
        sensitive: false,
    },
    KeySpec {
        key: "toolSearchEnabled",
        value_type: ValueType::Bool,
        sensitive: false,
    },
    KeySpec {
        key: "hybridCompressEnabled",
        value_type: ValueType::Bool,
        sensitive: false,
    },
    KeySpec {
        key: "teamMode",
        value_type: ValueType::Bool,
        sensitive: false,
    },
    KeySpec {
        key: "goal",
        value_type: ValueType::Object,
        sensitive: false,
    },
    KeySpec {
        key: "ultraTodoEnabled",
        value_type: ValueType::Bool,
        sensitive: false,
    },
];

const SNOWCFG_SCOPE_KEYS: &[KeySpec] = &[
    KeySpec {
        key: "baseUrl",
        value_type: ValueType::String,
        sensitive: false,
    },
    KeySpec {
        key: "baseUrlMode",
        value_type: ValueType::String,
        sensitive: false,
    },
    KeySpec {
        key: "apiKey",
        value_type: ValueType::String,
        sensitive: true,
    },
    KeySpec {
        key: "requestMethod",
        value_type: ValueType::String,
        sensitive: false,
    },
    KeySpec {
        key: "advancedModel",
        value_type: ValueType::String,
        sensitive: false,
    },
    KeySpec {
        key: "basicModel",
        value_type: ValueType::String,
        sensitive: false,
    },
    KeySpec {
        key: "supportsVision",
        value_type: ValueType::Bool,
        sensitive: false,
    },
    KeySpec {
        key: "visionBaseUrl",
        value_type: ValueType::String,
        sensitive: false,
    },
    KeySpec {
        key: "visionBaseUrlMode",
        value_type: ValueType::String,
        sensitive: false,
    },
    KeySpec {
        key: "visionApiKey",
        value_type: ValueType::String,
        sensitive: true,
    },
    KeySpec {
        key: "visionRequestMethod",
        value_type: ValueType::String,
        sensitive: false,
    },
    KeySpec {
        key: "visionModel",
        value_type: ValueType::String,
        sensitive: false,
    },
    KeySpec {
        key: "maxContextTokens",
        value_type: ValueType::Int,
        sensitive: false,
    },
    KeySpec {
        key: "maxTokens",
        value_type: ValueType::Int,
        sensitive: false,
    },
    KeySpec {
        key: "showThinking",
        value_type: ValueType::Bool,
        sensitive: false,
    },
    KeySpec {
        key: "streamIdleTimeoutSec",
        value_type: ValueType::Int,
        sensitive: false,
    },
    KeySpec {
        key: "maxRetries",
        value_type: ValueType::Int,
        sensitive: false,
    },
    KeySpec {
        key: "retryDelayMs",
        value_type: ValueType::Int,
        sensitive: false,
    },
    KeySpec {
        key: "enableAutoCompress",
        value_type: ValueType::Bool,
        sensitive: false,
    },
    KeySpec {
        key: "autoCompressThreshold",
        value_type: ValueType::Int,
        sensitive: false,
    },
    KeySpec {
        key: "toolResultTokenLimit",
        value_type: ValueType::Int,
        sensitive: false,
    },
    KeySpec {
        key: "anthropicBeta",
        value_type: ValueType::Bool,
        sensitive: false,
    },
    KeySpec {
        key: "streamingDisplay",
        value_type: ValueType::Bool,
        sensitive: false,
    },
    KeySpec {
        key: "systemPromptId",
        value_type: ValueType::String,
        sensitive: false,
    },
    KeySpec {
        key: "customHeadersSchemeId",
        value_type: ValueType::String,
        sensitive: false,
    },
    KeySpec {
        key: "anthropicCacheTTL",
        value_type: ValueType::String,
        sensitive: false,
    },
    KeySpec {
        key: "responsesReasoning",
        value_type: ValueType::Object,
        sensitive: false,
    },
    KeySpec {
        key: "responsesVerbosity",
        value_type: ValueType::String,
        sensitive: false,
    },
    KeySpec {
        key: "responsesFastMode",
        value_type: ValueType::Bool,
        sensitive: false,
    },
    KeySpec {
        key: "chatThinking",
        value_type: ValueType::Object,
        sensitive: false,
    },
];

const PROXY_SCOPE_KEYS: &[KeySpec] = &[
    KeySpec {
        key: "enabled",
        value_type: ValueType::Bool,
        sensitive: false,
    },
    KeySpec {
        key: "host",
        value_type: ValueType::String,
        sensitive: false,
    },
    KeySpec {
        key: "port",
        value_type: ValueType::Int,
        sensitive: false,
    },
    KeySpec {
        key: "searchEngine",
        value_type: ValueType::String,
        sensitive: false,
    },
    KeySpec {
        key: "browserPath",
        value_type: ValueType::String,
        sensitive: false,
    },
    KeySpec {
        key: "browserDebugPort",
        value_type: ValueType::Int,
        sensitive: false,
    },
];

const APP_SCOPE_KEYS: &[KeySpec] = &[KeySpec {
    key: "activeProfile",
    value_type: ValueType::String,
    sensitive: false,
}];

/// 自定义请求头方案（schemes 内可能含 Authorization 等敏感头，整体脱敏）。
const CUSTOM_HEADERS_SCOPE_KEYS: &[KeySpec] = &[
    KeySpec {
        key: "active",
        value_type: ValueType::String,
        sensitive: false,
    },
    KeySpec {
        key: "schemes",
        value_type: ValueType::Array,
        sensitive: true,
    },
];

/// 系统提示词（prompts 含提示词正文，脱敏展示）。
const SYSTEM_PROMPT_SCOPE_KEYS: &[KeySpec] = &[
    KeySpec {
        key: "active",
        value_type: ValueType::Array,
        sensitive: false,
    },
    KeySpec {
        key: "prompts",
        value_type: ValueType::Array,
        sensitive: true,
    },
];

const THEME_SCOPE_KEYS: &[KeySpec] = &[
    KeySpec {
        key: "theme",
        value_type: ValueType::String,
        sensitive: false,
    },
    KeySpec {
        key: "simpleMode",
        value_type: ValueType::Bool,
        sensitive: false,
    },
    KeySpec {
        key: "diffOpacity",
        value_type: ValueType::Number,
        sensitive: false,
    },
    KeySpec {
        key: "toolDisplayMode",
        value_type: ValueType::String,
        sensitive: false,
    },
    KeySpec {
        key: "thinkDisplayMode",
        value_type: ValueType::String,
        sensitive: false,
    },
    KeySpec {
        key: "subAgentDisplayMode",
        value_type: ValueType::String,
        sensitive: false,
    },
    KeySpec {
        key: "toolIcons",
        value_type: ValueType::Object,
        sensitive: false,
    },
    KeySpec {
        key: "customColors",
        value_type: ValueType::Object,
        sensitive: false,
    },
];

const LANGUAGE_SCOPE_KEYS: &[KeySpec] = &[KeySpec {
    key: "language",
    value_type: ValueType::String,
    sensitive: false,
}];

const PERMISSIONS_SCOPE_KEYS: &[KeySpec] = &[KeySpec {
    key: "alwaysApprovedTools",
    value_type: ValueType::Array,
    sensitive: false,
}];

const LSP_CONFIG_SCOPE_KEYS: &[KeySpec] = &[
    KeySpec {
        key: "schemaVersion",
        value_type: ValueType::Int,
        sensitive: false,
    },
    KeySpec {
        key: "servers",
        value_type: ValueType::Object,
        sensitive: false,
    },
];

const BUDDY_SCOPE_KEYS: &[KeySpec] = &[
    KeySpec {
        key: "version",
        value_type: ValueType::Int,
        sensitive: false,
    },
    KeySpec {
        key: "companion",
        value_type: ValueType::Object,
        sensitive: false,
    },
    KeySpec {
        key: "muted",
        value_type: ValueType::Bool,
        sensitive: false,
    },
];

const SCOPES: &[ScopeSpec] = &[
    ScopeSpec {
        scope: "settings",
        file_name: "settings.json",
        root_key: None,
        keys: SETTINGS_SCOPE_KEYS,
    },
    ScopeSpec {
        scope: "snowcfg",
        file_name: "config.json",
        root_key: Some("snowcfg"),
        keys: SNOWCFG_SCOPE_KEYS,
    },
    ScopeSpec {
        scope: "proxy",
        file_name: "proxy-config.json",
        root_key: None,
        keys: PROXY_SCOPE_KEYS,
    },
    ScopeSpec {
        scope: "app",
        file_name: "active-profile.json",
        root_key: None,
        keys: APP_SCOPE_KEYS,
    },
    ScopeSpec {
        scope: "custom-headers",
        file_name: "custom-headers.json",
        root_key: None,
        keys: CUSTOM_HEADERS_SCOPE_KEYS,
    },
    ScopeSpec {
        scope: "system-prompt",
        file_name: "system-prompt.json",
        root_key: None,
        keys: SYSTEM_PROMPT_SCOPE_KEYS,
    },
    ScopeSpec {
        scope: "theme",
        file_name: "theme.json",
        root_key: None,
        keys: THEME_SCOPE_KEYS,
    },
    ScopeSpec {
        scope: "language",
        file_name: "language.json",
        root_key: None,
        keys: LANGUAGE_SCOPE_KEYS,
    },
    ScopeSpec {
        scope: "permissions",
        file_name: "permissions.json",
        root_key: None,
        keys: PERMISSIONS_SCOPE_KEYS,
    },
    ScopeSpec {
        scope: "lsp-config",
        file_name: "lsp-config.json",
        root_key: None,
        keys: LSP_CONFIG_SCOPE_KEYS,
    },
    ScopeSpec {
        scope: "buddy",
        file_name: "buddy.json",
        root_key: None,
        keys: BUDDY_SCOPE_KEYS,
    },
];

/// 备份目录名（~/.snow/.config-backups）。
const BACKUP_DIR_NAME: &str = ".config-backups";
/// 每个文件保留的最大备份份数。
const MAX_BACKUPS_PER_FILE: usize = 10;
/// config-delete 等破坏性操作要求的用户确认参数。
/// 内置 agent 必须先调用 `user-interaction` 的 `askUserQuestion` 向用户展示
/// 将要删除/清空的配置与影响，获得明确同意后才能以 `confirmed: true` 调用；
/// 未携带该参数时删除操作被拒绝（防止误删，如误用 imagegen 全量清空）。
const CONFIRM_PARAM: &str = "confirmed";

pub struct ConfigService {
    db_path: String,
}

impl ConfigService {
    pub fn new() -> Self {
        let storage_info = crate::storage::initialize_app_storage().map_err(|e| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to initialize app storage: {e}"),
            )
        });
        let db_path = match storage_info {
            Ok(info) => info.database_path,
            Err(_) => String::new(),
        };
        ConfigService { db_path }
    }

    /// Async entry point used by `call_mcp_tool` in tools.rs.
    ///
    /// `session_project_id` 是运行时已知的当前会话项目ID（directoryId）。
    /// AI 调用方无法直接获知它，因此这里在支持项目级作用域的调用中自动
    /// 注入，修复"项目级配置落到全局"的问题：
    /// - 未显式传 projectId 且 scope 支持项目级 → 默认作用于当前项目；
    /// - 显式传 `""` 仍表示全局，传非空值仍表示指定项目（向后兼容）；
    /// - 不支持项目级的 scope（theme/app 等全局文件域）不注入，行为不变；
    /// - 所有 `config-list` 返回统一附加 `currentProjectId`，让 AI 能够
    ///   获取到当前会话绑定的项目。
    pub async fn execute_async(
        &self,
        tool_name: &str,
        args: &Value,
        session_project_id: Option<String>,
    ) -> napi::Result<Value> {
        let tool_name = tool_name.to_string();
        let mut args = args.clone();

        // 注入当前会话 projectId（仅当调用方未显式提供且目标支持项目级）。
        if !has_explicit_project_id(&args) {
            if let Some(pid) = session_project_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                if config_scope_supports_project_id(&args) {
                    args["projectId"] = json!(pid);
                }
            }
        }

        // 破坏性操作统一二次确认：config-delete（任何 scope，含 imagegen 全量
        // 清空 / skills 卸载 / logs 删除日志文件）必须携带 `confirmed: true`，
        // 而该参数只有在调用方先通过 `user-interaction` 的 `askUserQuestion`
        // 获得用户明确同意后才会带上；未确认一律拒绝，防止误删。
        if tool_name == TOOL_DELETE {
            require_delete_confirmation(&args)?;
        }

        // skills scope（能力委托给 SkillsConfigService）：需要 async 能力
        // （GitHub 下载等），因此在 spawn_blocking 之外直接分发。
        let result = if args.get("scope").and_then(Value::as_str) == Some(SCOPE_SKILLS) {
            self.execute_skills_scope(&tool_name, &args).await?
        } else if args.get("scope").and_then(Value::as_str) == Some(SCOPE_LOGS) {
            execute_logs_scope(&tool_name, &args)?
        } else if args.get("scope").and_then(Value::as_str) == Some(SCOPE_IMAGEGEN) {
            execute_imagegen_scope(&tool_name, &args)?
        } else if args.get("scope").and_then(Value::as_str) == Some(SCOPE_PERSONALIZATION) {
            execute_personalization_scope(&tool_name, &args)?
        } else {
            let db_path = self.db_path.clone();
            let tool_name_for_task = tool_name.clone();
            tokio::task::spawn_blocking(move || {
                let service = ConfigService { db_path };
                service.execute(&tool_name_for_task, &args)
            })
            .await
            .map_err(|error| {
                Error::new(
                    Status::GenericFailure,
                    format!("Config service task failed: {error}"),
                )
            })??
        };

        // 所有 list 类调用统一附加当前会话项目ID，让 AI 调用方能够获取到
        // 当前会话绑定的项目（directoryId），从而显式传 projectId 读写
        // 项目级配置。
        if tool_name == TOOL_LIST {
            if let Some(pid) = session_project_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                if let Value::Object(mut map) = result {
                    map.insert("currentProjectId".to_string(), json!(pid));
                    return Ok(Value::Object(map));
                }
            }
        }
        Ok(result)
    }

    /// `~/.snow` 目录路径（与 Snow CLI 共享）。
    fn snow_dir() -> PathBuf {
        dirs_next::home_dir()
            .map(|home| home.join(".snow"))
            .unwrap_or_else(|| PathBuf::from(".snow"))
    }

    /// 域对应的目标文件路径。
    fn scope_file_path(scope: &ScopeSpec) -> PathBuf {
        Self::snow_dir().join(scope.file_name)
    }

    fn find_scope(scope: &str) -> Option<&'static ScopeSpec> {
        SCOPES.iter().find(|spec| spec.scope == scope)
    }

    fn find_key<'a>(scope: &'a ScopeSpec, key: &str) -> Option<&'a KeySpec> {
        scope.keys.iter().find(|spec| spec.key == key)
    }

    /// 读取目标文件为 JSON 对象；文件不存在时返回域默认骨架。
    fn read_json(scope: &ScopeSpec) -> napi::Result<Map<String, Value>> {
        let file_path = Self::scope_file_path(scope);
        let content = match fs::read_to_string(&file_path) {
            Ok(content) => content,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Self::default_root(scope));
            }
            Err(error) => {
                return Err(Error::new(
                    Status::GenericFailure,
                    format!("Failed to read {}: {error}", file_path.display()),
                ));
            }
        };
        match serde_json::from_str::<Value>(&content) {
            Ok(Value::Object(map)) => Ok(map),
            Ok(_) => Err(Error::new(
                Status::GenericFailure,
                format!(
                    "Unexpected JSON root in {} (expected object)",
                    file_path.display()
                ),
            )),
            Err(error) => Err(Error::new(
                Status::GenericFailure,
                format!("Invalid JSON in {}: {error}", file_path.display()),
            )),
        }
    }

    /// 域默认骨架（root_key 存在时以空对象承载）。
    fn default_root(scope: &ScopeSpec) -> Map<String, Value> {
        match scope.root_key {
            Some(root_key) => {
                let mut root = Map::new();
                root.insert(root_key.to_string(), Value::Object(Map::new()));
                root
            }
            None => Map::new(),
        }
    }

    /// 获取实际存储配置的根对象（root_key 存在时取/建子对象）。
    fn config_root<'a>(
        scope: &ScopeSpec,
        root: &'a mut Map<String, Value>,
    ) -> napi::Result<&'a mut Map<String, Value>> {
        match scope.root_key {
            None => Ok(root),
            Some(root_key) => {
                if !root.contains_key(root_key) {
                    root.insert(root_key.to_string(), Value::Object(Map::new()));
                }
                match root.get_mut(root_key) {
                    Some(Value::Object(map)) => Ok(map),
                    _ => Err(Error::new(
                        Status::GenericFailure,
                        format!(
                            "Invalid JSON structure: `{root_key}` is not an object in {}",
                            scope.file_name
                        ),
                    )),
                }
            }
        }
    }

    /// 敏感值脱敏：字符串保留首尾各 4 字符，其余显示 `****`。
    fn mask_value(value: &Value) -> Value {
        match value {
            Value::String(text) => {
                let chars: Vec<char> = text.chars().collect();
                if chars.len() <= 8 {
                    json!("****")
                } else {
                    let head: String = chars[..4].iter().collect();
                    let tail: String = chars[chars.len() - 4..].iter().collect();
                    json!(format!("{head}****{tail}"))
                }
            }
            _ => json!("****"),
        }
    }

    /// 校验值的类型与结构（写前检查）。
    fn validate_value(key_spec: &KeySpec, value: &Value) -> napi::Result<()> {
        let type_ok = match key_spec.value_type {
            ValueType::String => value.is_string(),
            ValueType::Bool => value.is_boolean(),
            ValueType::Int => value.is_i64() || value.is_u64(),
            ValueType::Number => value.is_f64() || value.is_i64() || value.is_u64(),
            ValueType::Object => value.is_object(),
            ValueType::Array => value.is_array(),
        };
        if !type_ok {
            return Err(Error::new(
                Status::InvalidArg,
                format!(
                    "Invalid value type for key `{}` (expected {})",
                    key_spec.key,
                    type_name(key_spec.value_type)
                ),
            ));
        }
        // 结构性校验：mcpServers 的每个服务器条目必须是对象。
        if key_spec.key == "mcpServers" {
            if let Value::Object(servers) = value {
                for (name, entry) in servers {
                    if !entry.is_object() {
                        return Err(Error::new(
                            Status::InvalidArg,
                            format!("mcpServers.{name} must be an object"),
                        ));
                    }
                }
            }
        }
        // 嵌套结构深度校验：仅查最外层类型不足以防止 agent 写坏内部字段
        // （如 codebase.embedding.dimensions 被写成字符串）。以下 key 在白名单
        // 内唯一（codebase/schemes/prompts/servers 分属不同 scope），按 key
        // 分发到对应 schema 校验；只校验「已知字段存在时的类型」，未知字段
        // 放行以保持前向兼容。
        match key_spec.key {
            "codebase" => Self::validate_codebase_object(value)?,
            "schemes" => Self::validate_custom_header_schemes(value)?,
            "prompts" => Self::validate_system_prompt_prompts(value)?,
            "servers" => Self::validate_lsp_servers(value)?,
            _ => {}
        }
        Ok(())
    }

    /// codebase 对象结构校验（settings scope）。
    fn validate_codebase_object(value: &Value) -> napi::Result<()> {
        let obj = value
            .as_object()
            .ok_or_else(|| invalid_nested_field_error("codebase", "object"))?;
        for key in ["enabled", "enableAgentReview", "enableReranking"] {
            if let Some(v) = obj.get(key) {
                if !v.is_boolean() {
                    return Err(invalid_nested_field_error(
                        &format!("codebase.{key}"),
                        "boolean",
                    ));
                }
            }
        }
        for key in ["embedding", "reranking", "batch", "chunking"] {
            if let Some(v) = obj.get(key) {
                if !v.is_object() {
                    return Err(invalid_nested_field_error(
                        &format!("codebase.{key}"),
                        "object",
                    ));
                }
            }
        }
        if let Some(emb) = obj.get("embedding").and_then(Value::as_object) {
            for key in ["type", "modelName", "baseUrl", "apiKey"] {
                if let Some(v) = emb.get(key) {
                    if !v.is_string() {
                        return Err(invalid_nested_field_error(
                            &format!("codebase.embedding.{key}"),
                            "string",
                        ));
                    }
                }
            }
            if let Some(v) = emb.get("dimensions") {
                if !(v.is_f64() || v.is_i64() || v.is_u64()) {
                    return Err(invalid_nested_field_error(
                        "codebase.embedding.dimensions",
                        "number",
                    ));
                }
            }
        }
        if let Some(rer) = obj.get("reranking").and_then(Value::as_object) {
            for key in ["modelName", "baseUrl", "apiKey"] {
                if let Some(v) = rer.get(key) {
                    if !v.is_string() {
                        return Err(invalid_nested_field_error(
                            &format!("codebase.reranking.{key}"),
                            "string",
                        ));
                    }
                }
            }
            for key in ["contextLength", "topN"] {
                if let Some(v) = rer.get(key) {
                    if !(v.is_f64() || v.is_i64() || v.is_u64()) {
                        return Err(invalid_nested_field_error(
                            &format!("codebase.reranking.{key}"),
                            "number",
                        ));
                    }
                }
            }
        }
        if let Some(batch) = obj.get("batch").and_then(Value::as_object) {
            for key in ["maxLines", "concurrency"] {
                if let Some(v) = batch.get(key) {
                    if !(v.is_f64() || v.is_i64() || v.is_u64()) {
                        return Err(invalid_nested_field_error(
                            &format!("codebase.batch.{key}"),
                            "number",
                        ));
                    }
                }
            }
        }
        if let Some(chunk) = obj.get("chunking").and_then(Value::as_object) {
            for key in [
                "maxLinesPerChunk",
                "minLinesPerChunk",
                "minCharsPerChunk",
                "overlapLines",
            ] {
                if let Some(v) = chunk.get(key) {
                    if !(v.is_f64() || v.is_i64() || v.is_u64()) {
                        return Err(invalid_nested_field_error(
                            &format!("codebase.chunking.{key}"),
                            "number",
                        ));
                    }
                }
            }
        }
        Ok(())
    }

    /// custom-headers.schemes 数组结构校验（元素含 headers 对象）。
    fn validate_custom_header_schemes(value: &Value) -> napi::Result<()> {
        let schemes = value
            .as_array()
            .ok_or_else(|| invalid_nested_field_error("custom-headers.schemes", "array"))?;
        for (index, scheme) in schemes.iter().enumerate() {
            let obj = scheme.as_object().ok_or_else(|| {
                invalid_nested_field_error(&format!("custom-headers.schemes[{index}]"), "object")
            })?;
            for key in ["id", "name", "createdAt"] {
                if let Some(v) = obj.get(key) {
                    if !v.is_string() {
                        return Err(invalid_nested_field_error(
                            &format!("custom-headers.schemes[{index}].{key}"),
                            "string",
                        ));
                    }
                }
            }
            if let Some(headers) = obj.get("headers") {
                let header_obj = headers.as_object().ok_or_else(|| {
                    invalid_nested_field_error(
                        &format!("custom-headers.schemes[{index}].headers"),
                        "object",
                    )
                })?;
                for (header_name, header_value) in header_obj {
                    if !header_value.is_string() {
                        return Err(invalid_nested_field_error(
                            &format!("custom-headers.schemes[{index}].headers.{header_name}"),
                            "string",
                        ));
                    }
                }
            }
        }
        Ok(())
    }

    /// system-prompt.prompts 数组结构校验（元素含提示词正文）。
    fn validate_system_prompt_prompts(value: &Value) -> napi::Result<()> {
        let prompts = value
            .as_array()
            .ok_or_else(|| invalid_nested_field_error("system-prompt.prompts", "array"))?;
        for (index, prompt) in prompts.iter().enumerate() {
            let obj = prompt.as_object().ok_or_else(|| {
                invalid_nested_field_error(&format!("system-prompt.prompts[{index}]"), "object")
            })?;
            for key in ["id", "name", "content", "createdAt"] {
                if let Some(v) = obj.get(key) {
                    if !v.is_string() {
                        return Err(invalid_nested_field_error(
                            &format!("system-prompt.prompts[{index}].{key}"),
                            "string",
                        ));
                    }
                }
            }
        }
        Ok(())
    }

    /// lsp-config.servers 对象结构校验（每个语言服务器配置）。
    fn validate_lsp_servers(value: &Value) -> napi::Result<()> {
        let servers = value
            .as_object()
            .ok_or_else(|| invalid_nested_field_error("lsp-config.servers", "object"))?;
        for (lang, server) in servers {
            let obj = server.as_object().ok_or_else(|| {
                invalid_nested_field_error(&format!("lsp-config.servers.{lang}"), "object")
            })?;
            for key in ["command", "installCommand"] {
                if let Some(v) = obj.get(key) {
                    if !v.is_string() {
                        return Err(invalid_nested_field_error(
                            &format!("lsp-config.servers.{lang}.{key}"),
                            "string",
                        ));
                    }
                }
            }
            for key in ["args", "fileExtensions"] {
                if let Some(v) = obj.get(key) {
                    if let Some(arr) = v.as_array() {
                        for (i, item) in arr.iter().enumerate() {
                            if !item.is_string() {
                                return Err(invalid_nested_field_error(
                                    &format!("lsp-config.servers.{lang}.{key}[{i}]"),
                                    "string",
                                ));
                            }
                        }
                    } else {
                        return Err(invalid_nested_field_error(
                            &format!("lsp-config.servers.{lang}.{key}"),
                            "array",
                        ));
                    }
                }
            }
            if let Some(v) = obj.get("initializationOptions") {
                if !v.is_object() {
                    return Err(invalid_nested_field_error(
                        &format!("lsp-config.servers.{lang}.initializationOptions"),
                        "object",
                    ));
                }
            }
        }
        Ok(())
    }

    /// 备份目标文件。返回本次创建的备份路径：
    /// - 目标文件不存在时返回 `None`（无需备份）；
    /// - 否则创建 `~/.snow/.config-backups/<file>.<ts>.bak` 并保留
    ///   `MAX_BACKUPS_PER_FILE` 份（超出删除最旧，兜底并发/异常残留）。
    fn backup_file(file_path: &Path) -> napi::Result<Option<PathBuf>> {
        if !file_path.exists() {
            return Ok(None);
        }
        let backup_dir = Self::snow_dir().join(BACKUP_DIR_NAME);
        fs::create_dir_all(&backup_dir).map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to create backup dir: {error}"),
            )
        })?;
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or(0);
        let file_name = file_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("config");
        let backup_path = backup_dir.join(format!("{file_name}.{timestamp}.bak"));
        fs::copy(file_path, &backup_path).map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to backup {}: {error}", file_path.display()),
            )
        })?;

        // 清理超出上限的旧备份（按路径字典序即时间序）。
        let prefix = format!("{file_name}.");
        let mut backups: Vec<PathBuf> = fs::read_dir(&backup_dir)
            .map(|entries| {
                entries
                    .filter_map(|entry| entry.ok())
                    .map(|entry| entry.path())
                    .filter(|path| {
                        path.file_name()
                            .and_then(|name| name.to_str())
                            .is_some_and(|name| name.starts_with(&prefix) && name.ends_with(".bak"))
                    })
                    .collect()
            })
            .unwrap_or_default();
        backups.sort();
        while backups.len() > MAX_BACKUPS_PER_FILE {
            if let Some(oldest) = backups.first() {
                let _ = fs::remove_file(oldest);
            }
            backups.remove(0);
        }
        Ok(Some(backup_path))
    }

    /// 操作成功后的备份清理：删除本次写前生成的临时备份，保持
    /// `.config-backups` 目录干净（备份是写入期间的临时安全网，
    /// 写成功并验证后不再保留；历史/并发残留由 `MAX_BACKUPS_PER_FILE` 兜底）。
    fn cleanup_backup(backup: Option<PathBuf>) {
        if let Some(path) = backup {
            let _ = fs::remove_file(&path);
        }
    }

    /// 备份一个 DB 型配置值（imagegen_settings / subAgent / hook 记录等）到
    /// `~/.snow/.config-backups/<name>.<ts>.bak`，作为写入期间的临时安全网。
    /// 当前值为空时返回 `None`（无需备份）。调用方在写入成功并验证后应调用
    /// `cleanup_backup` 删除本次备份。
    fn backup_db_value(name: &str, content: &str) -> napi::Result<Option<PathBuf>> {
        if content.trim().is_empty() {
            return Ok(None);
        }
        let backup_dir = Self::snow_dir().join(BACKUP_DIR_NAME);
        fs::create_dir_all(&backup_dir).map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to create backup dir: {error}"),
            )
        })?;
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or(0);
        let backup_path = backup_dir.join(format!("{name}.{timestamp}.bak"));
        fs::write(&backup_path, content).map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to backup {name}: {error}"),
            )
        })?;
        Ok(Some(backup_path))
    }

    /// 原子写入：先写 tmp 文件再 rename 覆盖目标。
    fn atomic_write(file_path: &Path, content: &str) -> napi::Result<()> {
        let tmp_path = file_path.with_extension("json.tmp");
        fs::write(&tmp_path, content).map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to write {}: {error}", tmp_path.display()),
            )
        })?;
        fs::rename(&tmp_path, file_path).map_err(|error| {
            let _ = fs::remove_file(&tmp_path);
            Error::new(
                Status::GenericFailure,
                format!("Failed to replace {}: {error}", file_path.display()),
            )
        })
    }

    /// 把 settings.json 的 mcpServers 差集同步到应用 DB（生效作用域）。
    ///
    /// 语义与 UI "同步 Snow CLI MCP 设置" 完全一致：
    /// - upsert 文件中出现的每个服务器（serverId = `global:{name}`，
    ///   source = `snow-cli`）；
    /// - 删除 DB 中 source=snow-cli、serverId 以 `global:` 开头、但不在
    ///   新文件中的孤儿条目。
    ///
    /// 同步成功后配置立即生效（应用运行时直接读 DB），无需用户手动同步。
    fn sync_mcp_servers_to_db(&self, value: &Value) -> napi::Result<()> {
        use crate::storage::services::mcp_server_configs as mcp_store;

        let db_path = std::path::Path::new(&self.db_path);
        let servers = match value {
            Value::Object(servers) => servers,
            _ => return Ok(()),
        };

        let mut next_ids = std::collections::HashSet::new();
        for (index, (name, entry)) in servers.iter().enumerate() {
            let server = match entry {
                Value::Object(server) => server,
                _ => continue,
            };
            let server_id = format!("global:{name}");
            next_ids.insert(server_id.clone());

            let input = crate::storage::McpServerConfigInput {
                server_id,
                name: name.clone(),
                transport_type: server
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("stdio")
                    .to_string(),
                url: server
                    .get("url")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                command: server
                    .get("command")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                args_json: serde_json::to_string(server.get("args").unwrap_or(&json!([])))
                    .unwrap_or_else(|_| "[]".to_string()),
                env_json: serde_json::to_string(server.get("env").unwrap_or(&json!({})))
                    .unwrap_or_else(|_| "{}".to_string()),
                headers_json: serde_json::to_string(server.get("headers").unwrap_or(&json!({})))
                    .unwrap_or_else(|_| "{}".to_string()),
                enabled: server
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(true),
                timeout_ms: server
                    .get("timeoutMs")
                    .and_then(Value::as_i64)
                    .map(|value| value as i32),
                sort_order: index as i32,
                source: "snow-cli".to_string(),
            };
            mcp_store::upsert_mcp_server_config(db_path, &input).map_err(|error| {
                Error::new(
                    Status::GenericFailure,
                    format!("Failed to sync MCP server config to app database: {error}"),
                )
            })?;
        }

        // 差集删除：DB 中 source=snow-cli 的 global:* 孤儿条目。
        let existing = mcp_store::list_mcp_server_configs(db_path).map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to list MCP server configs for sync: {error}"),
            )
        })?;
        for item in existing {
            if item.source == "snow-cli"
                && item.server_id.starts_with("global:")
                && !next_ids.contains(&item.server_id)
            {
                mcp_store::delete_mcp_server_config(db_path, &item.server_id).map_err(|error| {
                    Error::new(
                        Status::GenericFailure,
                        format!("Failed to delete stale MCP server config: {error}"),
                    )
                })?;
            }
        }
        Ok(())
    }

    /// 删除 settings.mcpServers 键时，同步清空 DB 中 source=snow-cli 的
    /// global:* 服务器（与 UI 同步的差集语义对称；UI 手动添加的 manual
    /// 条目不受影响）。
    fn clear_snow_cli_mcp_servers_from_db(&self) -> napi::Result<()> {
        use crate::storage::services::mcp_server_configs as mcp_store;

        let db_path = std::path::Path::new(&self.db_path);
        let existing = mcp_store::list_mcp_server_configs(db_path).map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to list MCP server configs for cleanup: {error}"),
            )
        })?;
        for item in existing {
            if item.source == "snow-cli" && item.server_id.starts_with("global:") {
                mcp_store::delete_mcp_server_config(db_path, &item.server_id).map_err(|error| {
                    Error::new(
                        Status::GenericFailure,
                        format!("Failed to delete MCP server config: {error}"),
                    )
                })?;
            }
        }
        Ok(())
    }

    fn execute_list(&self, args: &Value) -> napi::Result<Value> {
        if let Some(scope_name) = args.get("scope").and_then(Value::as_str) {
            let project_id = optional_project_id(args);
            // DB-backed 配置域：直接查应用数据库（与 UI 同源）。
            if scope_name == SCOPE_SUB_AGENTS {
                return self.list_db_sub_agents(project_id);
            }
            if scope_name == SCOPE_HOOKS {
                return self.list_db_hooks(project_id);
            }

            let scope =
                Self::find_scope(scope_name).ok_or_else(|| invalid_scope_error(scope_name))?;
            let mut root = Self::read_json(scope)?;
            let config_root = Self::config_root(scope, &mut root)?;

            let mut keys = Vec::new();
            for key_spec in scope.keys {
                let configured = config_root.contains_key(key_spec.key);
                // 项目级视图：settings.mcpServers / settings.sensitiveCommands
                // 显示项目级（应用数据库）配置，其余键保持全局文件值。
                let display = if let Some(pid) = &project_id {
                    if scope.scope == "settings" && key_spec.key == "mcpServers" {
                        self.list_project_mcp_servers(pid)?
                    } else if scope.scope == "settings" && key_spec.key == "sensitiveCommands" {
                        self.list_project_sensitive_commands(pid)?
                    } else {
                        match config_root.get(key_spec.key) {
                            Some(value) if key_spec.sensitive => Self::mask_value(value),
                            Some(value) => value.clone(),
                            None => Value::Null,
                        }
                    }
                } else {
                    match config_root.get(key_spec.key) {
                        Some(value) if key_spec.sensitive => Self::mask_value(value),
                        Some(value) => value.clone(),
                        None => Value::Null,
                    }
                };
                keys.push(json!({
                    "key": key_spec.key,
                    "type": type_name(key_spec.value_type),
                    "sensitive": key_spec.sensitive,
                    "configured": configured,
                    "projectId": project_id,
                    "value": display,
                }));
            }
            Ok(json!({
                "scope": scope.scope,
                "file": scope.file_name,
                "keys": keys,
            }))
        } else {
            let mut scopes: Vec<Value> = SCOPES
                .iter()
                .map(|scope| {
                    json!({
                        "scope": scope.scope,
                        "file": scope.file_name,
                        "keys": scope.keys.iter().map(|spec| spec.key).collect::<Vec<_>>(),
                    })
                })
                .collect();
            // personalization（ROLE.md）不是 JSON 文件域，独立追加。
            scopes.push(json!({
                "scope": SCOPE_PERSONALIZATION,
                "file": ROLE_FILE_NAME,
                "keys": vec![PERSONALIZATION_ROLE_KEY],
            }));
            Ok(json!({ "scopes": scopes }))
        }
    }

    fn execute_get(&self, args: &Value) -> napi::Result<Value> {
        let scope_name = required_string(args, "scope")?;
        let key_name = required_string(args, "key")?;
        let project_id = optional_project_id(args);
        if scope_name == SCOPE_SUB_AGENTS {
            return self.get_db_sub_agent(key_name, project_id);
        }
        if scope_name == SCOPE_HOOKS {
            return self.get_db_hook(key_name, project_id);
        }
        // 项目级 settings：仅 mcpServers / sensitiveCommands 支持 projectId。
        if scope_name == "settings" {
            if let Some(pid) = &project_id {
                if key_name == "mcpServers" {
                    return Ok(json!({
                        "scope": "settings",
                        "key": "mcpServers",
                        "projectId": pid,
                        "value": self.list_project_mcp_servers(pid)?,
                    }));
                }
                if key_name == "sensitiveCommands" {
                    return Ok(json!({
                        "scope": "settings",
                        "key": "sensitiveCommands",
                        "projectId": pid,
                        "value": self.list_project_sensitive_commands(pid)?,
                    }));
                }
                return Err(Error::new(
                    Status::InvalidArg,
                    format!(
                        "Key \"{key_name}\" does not support projectId; only settings.mcpServers and settings.sensitiveCommands are project-scoped"
                    ),
                ));
            }
        }

        let scope = Self::find_scope(scope_name).ok_or_else(|| invalid_scope_error(scope_name))?;
        let key_spec =
            Self::find_key(scope, key_name).ok_or_else(|| invalid_key_error(scope, key_name))?;

        let mut root = Self::read_json(scope)?;
        let config_root = Self::config_root(scope, &mut root)?;
        let display = match config_root.get(key_name) {
            Some(value) if key_spec.sensitive => Self::mask_value(value),
            Some(value) => value.clone(),
            None => Value::Null,
        };
        Ok(json!({
            "scope": scope.scope,
            "key": key_name,
            "value": display,
        }))
    }

    fn execute_set(&self, args: &Value) -> napi::Result<Value> {
        let scope_name = required_string(args, "scope")?;
        let key_name = required_string(args, "key")?;
        let value = args.get("value").cloned().ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                "value is required for config-set".to_string(),
            )
        })?;
        let project_id = optional_project_id(args);
        if scope_name == SCOPE_SUB_AGENTS {
            return self.set_db_sub_agent(key_name, &value, project_id);
        }
        if scope_name == SCOPE_HOOKS {
            return self.set_db_hook(key_name, &value, project_id);
        }
        // 项目级 settings：仅 mcpServers / sensitiveCommands 支持 projectId（全量替换）。
        if scope_name == "settings" {
            if let Some(pid) = &project_id {
                if key_name == "mcpServers" {
                    return self.set_project_mcp_servers(pid, &value);
                }
                if key_name == "sensitiveCommands" {
                    return self.set_project_sensitive_commands(pid, &value);
                }
                return Err(Error::new(
                    Status::InvalidArg,
                    format!(
                        "Key \"{key_name}\" does not support projectId; only settings.mcpServers and settings.sensitiveCommands are project-scoped"
                    ),
                ));
            }
        }

        let scope = Self::find_scope(scope_name).ok_or_else(|| invalid_scope_error(scope_name))?;
        let key_spec =
            Self::find_key(scope, key_name).ok_or_else(|| invalid_key_error(scope, key_name))?;
        Self::validate_value(key_spec, &value)?;

        // settings.mcpServers 特殊处理：同步到应用 DB（生效作用域），
        // 差集语义与 UI "同步 Snow CLI MCP 设置" 完全一致，立即生效。
        // DB 同步失败时中止（文件保持不变），保证文件与 DB 一致。
        if scope.scope == "settings" && key_name == "mcpServers" && !self.db_path.is_empty() {
            self.sync_mcp_servers_to_db(&value)?;
        }

        let file_path = Self::scope_file_path(scope);
        let backup = Self::backup_file(&file_path)?;

        let mut root = Self::read_json(scope)?;
        {
            let config_root = Self::config_root(scope, &mut root)?;
            config_root.insert(key_name.to_string(), value.clone());
        }
        let content = serde_json::to_string_pretty(&Value::Object(root)).map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to serialize config: {error}"),
            )
        })?;
        Self::atomic_write(&file_path, &content)?;
        // 写入成功：删除本次写前备份（临时安全网不再需要）。
        Self::cleanup_backup(backup);

        let display = if key_spec.sensitive {
            Self::mask_value(&value)
        } else {
            value
        };
        Ok(json!({
            "scope": scope.scope,
            "key": key_name,
            "value": display,
        }))
    }

    fn execute_delete(&self, args: &Value) -> napi::Result<Value> {
        // 破坏性操作二次确认（统一在 execute_async 入口检查；此处防御性
        // 兜底直接调用 execute 的路径）。
        require_delete_confirmation(args)?;

        let scope_name = required_string(args, "scope")?;
        let key_name = required_string(args, "key")?;
        let project_id = optional_project_id(args);
        if scope_name == SCOPE_SUB_AGENTS {
            return self.delete_db_sub_agent(key_name, project_id);
        }
        if scope_name == SCOPE_HOOKS {
            return self.delete_db_hook(key_name, project_id);
        }
        // 项目级 settings：仅 mcpServers / sensitiveCommands 支持 projectId（清空）。
        if scope_name == "settings" {
            if let Some(pid) = &project_id {
                if key_name == "mcpServers" {
                    return self.clear_project_mcp_servers(pid);
                }
                if key_name == "sensitiveCommands" {
                    return self.clear_project_sensitive_commands(pid);
                }
                return Err(Error::new(
                    Status::InvalidArg,
                    format!(
                        "Key \"{key_name}\" does not support projectId; only settings.mcpServers and settings.sensitiveCommands are project-scoped"
                    ),
                ));
            }
        }

        let scope = Self::find_scope(scope_name).ok_or_else(|| invalid_scope_error(scope_name))?;
        // 仅校验键存在（白名单），无需保留绑定。
        Self::find_key(scope, key_name).ok_or_else(|| invalid_key_error(scope, key_name))?;

        let file_path = Self::scope_file_path(scope);
        let mut root = Self::read_json(scope)?;
        let removed = {
            let config_root = Self::config_root(scope, &mut root)?;
            config_root.remove(key_name).is_some()
        };
        if !removed {
            return Ok(json!({
                "scope": scope.scope,
                "key": key_name,
                "deleted": false,
            }));
        }

        // settings.mcpServers 删除时同步清空 DB 中 source=snow-cli 的
        // global:* 服务器（与 UI 同步的差集语义对称）。
        if scope.scope == "settings" && key_name == "mcpServers" && !self.db_path.is_empty() {
            self.clear_snow_cli_mcp_servers_from_db()?;
        }

        let backup = Self::backup_file(&file_path)?;
        let content = serde_json::to_string_pretty(&Value::Object(root)).map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to serialize config: {error}"),
            )
        })?;
        Self::atomic_write(&file_path, &content)?;
        // 删除成功：清理本次写前备份（临时安全网不再需要）。
        Self::cleanup_backup(backup);
        Ok(json!({
            "scope": scope.scope,
            "key": key_name,
            "deleted": true,
        }))
    }

    // ---------------------------------------------------------------------
    // Project-scoped mcpServers / sensitiveCommands
    //
    // 项目级配置存储在应用数据库（与 UI 同源）：project_mcp_server_configs /
    // project_sensitive_command_configs。传入 projectId 时，settings scope 的
    // mcpServers 与 sensitiveCommands 读写走项目级表（全量替换语义）；
    // 其余键不支持项目级（保持全局文件语义）。
    // ---------------------------------------------------------------------

    /// 组装项目级 MCP 服务器为 {name: config} 对象（与全局 settings.json 形态一致）。
    fn list_project_mcp_servers(&self, project_id: &str) -> napi::Result<Value> {
        use crate::storage::services::project_mcp_server_configs as store;
        let db_path = db_path_or_error(&self.db_path)?;
        let servers =
            store::list_project_mcp_server_configs(db_path, project_id).map_err(|error| {
                Error::new(
                    Status::GenericFailure,
                    format!("Failed to list project MCP servers: {error}"),
                )
            })?;
        let mut map = serde_json::Map::new();
        for server in &servers {
            map.insert(
                server.name.clone(),
                json!({
                    "type": server.transport_type,
                    "url": server.url,
                    "command": server.command,
                    "args": serde_json::from_str::<Value>(&server.args_json).unwrap_or(json!([])),
                    "env": serde_json::from_str::<Value>(&server.env_json).unwrap_or(json!({})),
                    "headers": serde_json::from_str::<Value>(&server.headers_json).unwrap_or(json!({})),
                    "enabled": server.enabled,
                    "timeoutMs": server.timeout_ms,
                    "serverId": server.server_id,
                    "source": server.source,
                }),
            );
        }
        Ok(Value::Object(map))
    }

    /// 全量替换项目级 MCP 服务器：清空现有项目级条目后逐条 upsert。
    fn set_project_mcp_servers(&self, project_id: &str, value: &Value) -> napi::Result<Value> {
        use crate::storage::services::project_mcp_server_configs as store;
        let db_path = db_path_or_error(&self.db_path)?;
        let existing =
            store::list_project_mcp_server_configs(db_path, project_id).map_err(|error| {
                Error::new(
                    Status::GenericFailure,
                    format!("Failed to list project MCP servers: {error}"),
                )
            })?;
        for server in &existing {
            store::delete_project_mcp_server_config(db_path, project_id, &server.server_id)
                .map_err(|error| {
                    Error::new(
                        Status::GenericFailure,
                        format!("Failed to clear project MCP servers: {error}"),
                    )
                })?;
        }
        let mut updated = 0usize;
        if let Value::Object(servers) = value {
            for (index, (name, entry)) in servers.iter().enumerate() {
                let Value::Object(server) = entry else {
                    continue;
                };
                let input = crate::storage::McpServerConfigInput {
                    server_id: format!("project:{name}"),
                    name: name.clone(),
                    transport_type: server
                        .get("type")
                        .and_then(Value::as_str)
                        .unwrap_or("stdio")
                        .to_string(),
                    url: server
                        .get("url")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    command: server
                        .get("command")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    args_json: serde_json::to_string(server.get("args").unwrap_or(&json!([])))
                        .unwrap_or_else(|_| "[]".to_string()),
                    env_json: serde_json::to_string(server.get("env").unwrap_or(&json!({})))
                        .unwrap_or_else(|_| "{}".to_string()),
                    headers_json: serde_json::to_string(
                        server.get("headers").unwrap_or(&json!({})),
                    )
                    .unwrap_or_else(|_| "{}".to_string()),
                    enabled: server
                        .get("enabled")
                        .and_then(Value::as_bool)
                        .unwrap_or(true),
                    timeout_ms: server
                        .get("timeoutMs")
                        .and_then(Value::as_i64)
                        .map(|value| value as i32),
                    sort_order: index as i32,
                    source: "snow-cli".to_string(),
                };
                store::upsert_project_mcp_server_config(db_path, project_id, &input).map_err(
                    |error| {
                        Error::new(
                            Status::GenericFailure,
                            format!("Failed to upsert project MCP server {name}: {error}"),
                        )
                    },
                )?;
                updated += 1;
            }
        }
        Ok(json!({
            "scope": "settings",
            "key": "mcpServers",
            "projectId": project_id,
            "updated": updated,
        }))
    }

    /// 清空项目级 MCP 服务器。
    fn clear_project_mcp_servers(&self, project_id: &str) -> napi::Result<Value> {
        use crate::storage::services::project_mcp_server_configs as store;
        let db_path = db_path_or_error(&self.db_path)?;
        let existing =
            store::list_project_mcp_server_configs(db_path, project_id).map_err(|error| {
                Error::new(
                    Status::GenericFailure,
                    format!("Failed to list project MCP servers: {error}"),
                )
            })?;
        let deleted = existing.len();
        for server in &existing {
            store::delete_project_mcp_server_config(db_path, project_id, &server.server_id)
                .map_err(|error| {
                    Error::new(
                        Status::GenericFailure,
                        format!("Failed to delete project MCP server: {error}"),
                    )
                })?;
        }
        Ok(json!({
            "scope": "settings",
            "key": "mcpServers",
            "projectId": project_id,
            "deleted": deleted,
        }))
    }

    /// 列出项目级敏感命令（DB 合并全局视图）。
    fn list_project_sensitive_commands(&self, project_id: &str) -> napi::Result<Value> {
        use crate::storage::services::project_sensitive_command_configs as store;
        let db_path = db_path_or_error(&self.db_path)?;
        let records = store::list_project_sensitive_command_configs(db_path, project_id).map_err(
            |error| {
                Error::new(
                    Status::GenericFailure,
                    format!("Failed to list project sensitive commands: {error}"),
                )
            },
        )?;
        let items: Vec<Value> = records
            .iter()
            .map(|record| {
                json!({
                    "commandId": record.command_id,
                    "pattern": record.pattern,
                    "description": record.description,
                    "enabled": record.enabled,
                    "inherited": record.inherited,
                    "globalEnabled": record.global_enabled,
                    "isPreset": record.is_preset,
                    "source": record.source,
                })
            })
            .collect();
        Ok(Value::Array(items))
    }

    /// 全量替换项目级敏感命令：清空自定义规则后，按传入数组逐条写入。
    /// 匹配全局规则的条目走 enabled 覆盖（set_project_sensitive_command_enabled），
    /// 其余作为项目自定义规则写入。
    fn set_project_sensitive_commands(
        &self,
        project_id: &str,
        value: &Value,
    ) -> napi::Result<Value> {
        use crate::storage::services::project_sensitive_command_configs as store;
        let db_path = db_path_or_error(&self.db_path)?;

        // 1. 清空现有项目自定义规则（inherited 的全局规则由服务端保护不可删，
        //    仅通过 enabled 覆盖表达；见下方 global 分支）。
        let existing = store::list_project_sensitive_command_configs(db_path, project_id).map_err(
            |error| {
                Error::new(
                    Status::GenericFailure,
                    format!("Failed to list project sensitive commands: {error}"),
                )
            },
        )?;
        for record in &existing {
            if record.inherited {
                continue;
            }
            store::delete_project_sensitive_command_config(db_path, project_id, &record.command_id)
                .map_err(|error| {
                    Error::new(
                        Status::GenericFailure,
                        format!("Failed to clear project sensitive commands: {error}"),
                    )
                })?;
        }

        // 2. 全局规则集合（判断某 command_id 是否匹配全局 preset）。
        let global =
            crate::storage::services::sensitive_command_configs::list_sensitive_command_configs(
                db_path,
            )
            .map_err(|error| {
                Error::new(
                    Status::GenericFailure,
                    format!("Failed to list global sensitive commands: {error}"),
                )
            })?;
        let global_ids: std::collections::HashSet<String> = global
            .iter()
            .map(|record| record.command_id.clone())
            .collect();

        // 3. 逐条写入。
        let mut updated = 0usize;
        if let Some(items) = value.as_array() {
            for (index, item) in items.iter().enumerate() {
                let Some(entry) = item.as_object() else {
                    continue;
                };
                let command_id = entry
                    .get("commandId")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if command_id.is_empty() {
                    return Err(Error::new(
                        Status::InvalidArg,
                        "sensitiveCommands[..].commandId is required for project-scoped write"
                            .to_string(),
                    ));
                }
                let enabled = entry
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(true);
                if global_ids.contains(command_id) {
                    // 匹配全局规则 → enabled 覆盖。
                    store::set_project_sensitive_command_enabled(
                        db_path, project_id, command_id, enabled,
                    )
                    .map_err(|error| {
                        Error::new(
                            Status::GenericFailure,
                            format!(
                                "Failed to override project sensitive command {command_id}: {error}"
                            ),
                        )
                    })?;
                } else {
                    let input = crate::storage::ProjectSensitiveCommandConfigInput {
                        command_id: command_id.to_string(),
                        pattern: entry
                            .get("pattern")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        description: entry
                            .get("description")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        enabled,
                        sort_order: index as i32,
                    };
                    store::upsert_project_sensitive_command_config(db_path, project_id, &input)
                        .map_err(|error| {
                            Error::new(
                                Status::GenericFailure,
                                format!(
                                "Failed to upsert project sensitive command {command_id}: {error}"
                            ),
                            )
                        })?;
                }
                updated += 1;
            }
        }
        Ok(json!({
            "scope": "settings",
            "key": "sensitiveCommands",
            "projectId": project_id,
            "updated": updated,
        }))
    }

    /// 清空项目级敏感命令（自定义规则 + enabled 覆盖）。
    fn clear_project_sensitive_commands(&self, project_id: &str) -> napi::Result<Value> {
        use crate::storage::services::project_sensitive_command_configs as store;
        let db_path = db_path_or_error(&self.db_path)?;
        let existing = store::list_project_sensitive_command_configs(db_path, project_id).map_err(
            |error| {
                Error::new(
                    Status::GenericFailure,
                    format!("Failed to list project sensitive commands: {error}"),
                )
            },
        )?;
        let deleted = existing.iter().filter(|record| !record.inherited).count();
        for record in &existing {
            if record.inherited {
                continue;
            }
            store::delete_project_sensitive_command_config(db_path, project_id, &record.command_id)
                .map_err(|error| {
                    Error::new(
                        Status::GenericFailure,
                        format!("Failed to delete project sensitive command: {error}"),
                    )
                })?;
        }
        Ok(json!({
            "scope": "settings",
            "key": "sensitiveCommands",
            "projectId": project_id,
            "deleted": deleted,
        }))
    }

    // ---------------------------------------------------------------------
    // DB-backed scopes（subAgents / hooks）
    //
    // 直接读写应用 SQLite 数据库（与 UI 设置面板同源），写入立即生效。
    // 子代理写入统一标记 source=snow-cli、builtin=false；hooks 复用
    // hooks_configs 存储服务的完整校验（hookType、rules 结构、action 类型）。
    // ---------------------------------------------------------------------

    fn list_db_sub_agents(&self, project_id: Option<String>) -> napi::Result<Value> {
        let db_path = db_path_or_error(&self.db_path)?;
        let configs = crate::storage::services::sub_agent_configs::list_sub_agent_configs(
            db_path,
            project_id.as_deref(),
        )?;
        let items: Vec<Value> = configs
            .iter()
            .map(|config| {
                json!({
                    "agentId": config.agent_id,
                    "projectId": config.project_id,
                    "name": config.name,
                    "description": config.description,
                    "systemPrompt": config.system_prompt,
                    "toolsJson": config.tools_json,
                    "configProfile": config.config_profile,
                    "model": config.model,
                    "builtin": config.builtin,
                    "sortOrder": config.sort_order,
                    "source": config.source,
                    "updatedAt": config.updated_at,
                })
            })
            .collect();
        Ok(json!({
            "scope": SCOPE_SUB_AGENTS,
            "items": items,
            "count": items.len(),
            "guidance": "CREATING A SUB-AGENT - config-set scope=subAgents key=<agentId> value={name, description?, systemPrompt?, toolsJson?, configProfile?, model?}.
        \
KEY RULES: (1) an explicit toolsJson tool-name list REQUIRES projectId (the agent becomes project-scoped); \"*\" or an empty list is allowed for global agents; (2) toolsJson accepts a JSON string or an array of tool names that must be enabled for the project; (3) empty configProfile inherits the parent conversation's effective API profile and model at activation; a fixed configProfile uses model when provided, otherwise that profile's advancedModel; (4) project-scoped agents take priority over a same-id global agent at activation; (5) the built-in agent_general cannot be modified or deleted. The systemPrompt must be fully self-contained (no conversation history).
\
        Full guide: ~/.snow/docs/zh-CN/2-使用指南/5-配置Hooks与子代理.md (en: en/2-guides/5-configure-hooks-and-subagents.md)",
        }))
    }

    fn get_db_sub_agent(&self, agent_id: &str, project_id: Option<String>) -> napi::Result<Value> {
        let db_path = db_path_or_error(&self.db_path)?;
        let config = crate::storage::services::sub_agent_configs::get_sub_agent_config(
            db_path,
            agent_id,
            project_id.as_deref(),
        )?;
        let value = match config {
            Some(config) => json!({
                "agentId": config.agent_id,
                "projectId": config.project_id,
                "name": config.name,
                "description": config.description,
                "systemPrompt": config.system_prompt,
                "toolsJson": config.tools_json,
                "configProfile": config.config_profile,
                "model": config.model,
                "builtin": config.builtin,
                "sortOrder": config.sort_order,
                "source": config.source,
                "updatedAt": config.updated_at,
            }),
            None => Value::Null,
        };
        Ok(json!({
            "scope": SCOPE_SUB_AGENTS,
            "key": agent_id,
            "value": value,
        }))
    }

    fn set_db_sub_agent(
        &self,
        agent_id: &str,
        value: &Value,
        project_id: Option<String>,
    ) -> napi::Result<Value> {
        if agent_id == BUILTIN_GENERAL_AGENT_ID {
            return Err(Error::new(
                Status::InvalidArg,
                format!(
                    "{BUILTIN_GENERAL_AGENT_ID} is a built-in sub-agent and cannot be modified via config"
                ),
            ));
        }
        let db_path = db_path_or_error(&self.db_path)?;
        let config = value.as_object().ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                "value must be an object for the subAgents scope".to_string(),
            )
        })?;

        let name = config
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| Error::new(Status::InvalidArg, "value.name is required".to_string()))?;
        if name.chars().count() > 100 {
            return Err(Error::new(
                Status::InvalidArg,
                "value.name must be no longer than 100 characters".to_string(),
            ));
        }
        let description = config
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if description.chars().count() > 500 {
            return Err(Error::new(
                Status::InvalidArg,
                "value.description must be no longer than 500 characters".to_string(),
            ));
        }
        let system_prompt = config
            .get("systemPrompt")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let config_profile = config
            .get("configProfile")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        let model = config
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();

        // toolsJson 兼容两种形式：字符串数组或 JSON 字符串。
        let tools_json = match config.get("toolsJson") {
            Some(Value::Array(tools)) => serde_json::to_string(tools).map_err(|error| {
                Error::new(
                    Status::GenericFailure,
                    format!("Failed to serialize toolsJson: {error}"),
                )
            })?,
            Some(Value::String(tools)) => {
                serde_json::from_str::<Value>(tools).map_err(|error| {
                    Error::new(
                        Status::InvalidArg,
                        format!("value.toolsJson must be valid JSON: {error}"),
                    )
                })?;
                tools.clone()
            }
            None => "[]".to_string(),
            Some(_) => {
                return Err(Error::new(
                    Status::InvalidArg,
                    "value.toolsJson must be a string or an array of tool names".to_string(),
                ));
            }
        };

        // 校验工具名在当前项目可用（对齐 TS validateSubAgentTools 的静态版本）：
        // 空/["*"] 通过；选择 MCP 工具必须项目级；内置工具严格校验，
        // 外部工具校验服务器公开名前缀须属于当前项目 enabled 的 MCP 服务器。
        validate_sub_agent_tools(db_path, project_id.as_deref(), &tools_json)?;

        // 写前备份现有记录（如有），作为写入期间的临时安全网；
        // 写入成功并验证后清理。
        let existing = crate::storage::services::sub_agent_configs::get_sub_agent_config(
            db_path,
            agent_id,
            project_id.as_deref(),
        )?;
        let backup = match existing {
            Some(config) => Self::backup_db_value(
                &format!("subAgents.{agent_id}"),
                &json!({
                    "agentId": config.agent_id,
                    "projectId": config.project_id,
                    "name": config.name,
                    "description": config.description,
                    "systemPrompt": config.system_prompt,
                    "toolsJson": config.tools_json,
                    "configProfile": config.config_profile,
                    "model": config.model,
                    "builtin": config.builtin,
                    "sortOrder": config.sort_order,
                    "source": config.source,
                    "updatedAt": config.updated_at,
                })
                .to_string(),
            )?,
            None => None,
        };

        let sort_order = config.get("sortOrder").and_then(Value::as_i64).unwrap_or(0) as i32;

        let item = crate::storage::SubAgentConfigInput {
            agent_id: agent_id.to_string(),
            name: name.to_string(),
            description,
            system_prompt,
            tools_json,
            config_profile,
            model,
            builtin: false,
            sort_order,
            source: SOURCE_SNOW_CLI.to_string(),
            project_id,
        };
        crate::storage::services::sub_agent_configs::upsert_sub_agent_config(db_path, &item)?;
        Self::cleanup_backup(backup);
        Ok(json!({
            "scope": SCOPE_SUB_AGENTS,
            "key": agent_id,
            "saved": true,
        }))
    }

    fn delete_db_sub_agent(
        &self,
        agent_id: &str,
        project_id: Option<String>,
    ) -> napi::Result<Value> {
        if agent_id == BUILTIN_GENERAL_AGENT_ID {
            return Err(Error::new(
                Status::InvalidArg,
                format!("{BUILTIN_GENERAL_AGENT_ID} is a built-in sub-agent and cannot be deleted"),
            ));
        }
        let db_path = db_path_or_error(&self.db_path)?;
        let existing = crate::storage::services::sub_agent_configs::get_sub_agent_config(
            db_path,
            agent_id,
            project_id.as_deref(),
        )?;
        let deleted = existing.is_some();
        if existing.as_ref().is_some_and(|config| config.builtin) {
            return Err(Error::new(
                Status::InvalidArg,
                "Built-in sub-agents cannot be deleted".to_string(),
            ));
        }
        // 写前备份现有记录（如有），删除成功并验证后清理。
        let backup = match &existing {
            Some(config) => Self::backup_db_value(
                &format!("subAgents.{agent_id}"),
                &json!({
                    "agentId": config.agent_id,
                    "projectId": config.project_id,
                    "name": config.name,
                    "description": config.description,
                    "systemPrompt": config.system_prompt,
                    "toolsJson": config.tools_json,
                    "configProfile": config.config_profile,
                    "model": config.model,
                    "builtin": config.builtin,
                    "sortOrder": config.sort_order,
                    "source": config.source,
                    "updatedAt": config.updated_at,
                })
                .to_string(),
            )?,
            None => None,
        };
        crate::storage::services::sub_agent_configs::delete_sub_agent_config(
            db_path,
            agent_id,
            project_id.as_deref(),
        )?;
        Self::cleanup_backup(backup);
        Ok(json!({
            "scope": SCOPE_SUB_AGENTS,
            "key": agent_id,
            "deleted": deleted,
        }))
    }

    fn list_db_hooks(&self, project_id: Option<String>) -> napi::Result<Value> {
        let db_path = db_path_or_error(&self.db_path)?;
        let scope = if project_id.is_some() {
            "project"
        } else {
            "global"
        };
        let records = crate::storage::services::hooks_configs::list_hook_configs(
            db_path,
            scope,
            project_id.as_deref(),
        )?;
        let items: Vec<Value> = records
            .iter()
            .map(|record| {
                json!({
                    "hookType": record.hook_type,
                    "scope": record.scope,
                    "projectId": record.project_id,
                    "rules": serde_json::from_str::<Value>(&record.rules_json)
                        .unwrap_or_else(|_| Value::Array(Vec::new())),
                    "rulesJson": record.rules_json,
                    "updatedAt": record.updated_at,
                })
            })
            .collect();
        Ok(json!({
            "scope": SCOPE_HOOKS,
            "projectId": project_id.unwrap_or_default(),
            "items": items,
            "count": items.len(),
            "guidance": "CONFIGURING HOOKS - config-set scope=hooks key=<hookType> value={rules:[{description, matcher?, hooks:[{type, ...}]}]}.
        \
KEY RULES: (1) hookType whitelist: onUserMessage, beforeToolCall, toolConfirmation, afterToolCall, onSubAgentComplete, beforeSubAgentStart, beforeCompress, onSessionStart, onStop; (2) command actions exit codes: 0 = pass (stdout injected as [Hook Context]), 1 = soft warning (a stdout of {\"decision\":{\"message\":\"...\"}} triggers the user decision UI), 2+ = abort; (3) prompt actions only for onSubAgentComplete/onStop, context actions only for onSessionStart/onUserMessage/beforeSubAgentStart; (4) pass projectId for a project-scoped hook (overrides the same-type global hook).
\
        Full guide: ~/.snow/docs/zh-CN/2-使用指南/5-配置Hooks与子代理.md (en: en/2-guides/5-configure-hooks-and-subagents.md)",
        }))
    }

    fn get_db_hook(&self, hook_type: &str, project_id: Option<String>) -> napi::Result<Value> {
        let list = self.list_db_hooks(project_id)?;
        let items = list
            .get("items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let found = items
            .iter()
            .find(|item| item.get("hookType").and_then(Value::as_str) == Some(hook_type))
            .cloned();
        Ok(json!({
            "scope": SCOPE_HOOKS,
            "key": hook_type,
            "value": found.unwrap_or(Value::Null),
        }))
    }

    fn set_db_hook(
        &self,
        hook_type: &str,
        value: &Value,
        project_id: Option<String>,
    ) -> napi::Result<Value> {
        let db_path = db_path_or_error(&self.db_path)?;
        let rules = value.get("rules").ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                "value.rules is required for the hooks scope".to_string(),
            )
        })?;
        if !rules.is_array() {
            return Err(Error::new(
                Status::InvalidArg,
                "value.rules must be an array of hook rules".to_string(),
            ));
        }
        let rules_json = serde_json::to_string(rules).map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to serialize hook rules: {error}"),
            )
        })?;
        let scope = if project_id.is_some() {
            "project"
        } else {
            "global"
        };
        // 写前备份现有 hook 配置（如有），作为写入期间的临时安全网；
        // 写入成功并验证后清理。
        let records = crate::storage::services::hooks_configs::list_hook_configs(
            db_path,
            &scope,
            project_id.as_deref(),
        )?;
        let backup = match records.iter().find(|record| record.hook_type == hook_type) {
            Some(record) => {
                Self::backup_db_value(&format!("hooks.{hook_type}"), &record.rules_json)?
            }
            None => None,
        };
        let item = crate::storage::HookConfigInput {
            hook_type: hook_type.to_string(),
            scope: scope.to_string(),
            project_id,
            rules_json,
        };
        // 复用 hooks_configs 的完整校验（hookType 白名单、rules 结构、action 类型）。
        crate::storage::services::hooks_configs::upsert_hook_config(db_path, &item)?;
        Self::cleanup_backup(backup);
        Ok(json!({
            "scope": SCOPE_HOOKS,
            "key": hook_type,
            "saved": true,
        }))
    }

    fn delete_db_hook(&self, hook_type: &str, project_id: Option<String>) -> napi::Result<Value> {
        let db_path = db_path_or_error(&self.db_path)?;
        let scope = if project_id.is_some() {
            "project"
        } else {
            "global"
        };
        // 先查存在性，与文件域 delete 的 deleted:false 语义对齐。
        let records = crate::storage::services::hooks_configs::list_hook_configs(
            db_path,
            &scope,
            project_id.as_deref(),
        )?;
        let deleted = records.iter().any(|record| record.hook_type == hook_type);
        // 写前备份现有 hook 配置（如有），删除成功并验证后清理。
        let backup = match records.iter().find(|record| record.hook_type == hook_type) {
            Some(record) => {
                Self::backup_db_value(&format!("hooks.{hook_type}"), &record.rules_json)?
            }
            None => None,
        };
        crate::storage::services::hooks_configs::delete_hook_config(
            db_path,
            hook_type,
            &scope,
            project_id.as_deref(),
        )?;
        Self::cleanup_backup(backup);
        Ok(json!({
            "scope": SCOPE_HOOKS,
            "key": hook_type,
            "deleted": deleted,
        }))
    }

    /// skills scope：把 config 工具的 list/get/set/delete 语义映射到
    /// SkillsConfigService 的内部工具，复用其全部校验与实现
    /// （list / setEnabled / installGithub / uninstall）。
    async fn execute_skills_scope(&self, tool_name: &str, args: &Value) -> napi::Result<Value> {
        let service = super::skills_config::SkillsConfigService::new();
        match tool_name {
            TOOL_LIST => service.execute_async("list", args).await,
            TOOL_GET => {
                let skill_id = required_string(args, "key")?;
                let list = service.execute_async("list", args).await?;
                let skills = list
                    .get("skills")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let found = skills
                    .iter()
                    .find(|skill| skill.get("id").and_then(Value::as_str) == Some(skill_id))
                    .cloned();
                Ok(json!({
                    "scope": SCOPE_SKILLS,
                    "key": skill_id,
                    "value": found.unwrap_or(Value::Null),
                }))
            }
            TOOL_SET => {
                let skill_id = required_string(args, "key")?;
                let value = args.get("value").cloned().ok_or_else(|| {
                    Error::new(
                        Status::InvalidArg,
                        "value is required for config-set".to_string(),
                    )
                })?;
                let project_id = optional_project_id(args);

                // 安装：value 含 url + location。
                if let Some(url) = value.get("url").and_then(Value::as_str) {
                    let location = value.get("location").and_then(Value::as_str).ok_or_else(|| {
                        Error::new(
                            Status::InvalidArg,
                            "value.location (\"global\" | \"project\") is required to install a skill"
                                .to_string(),
                        )
                    })?;
                    let mut install_args = json!({ "url": url, "location": location });
                    if let Some(project_id) = &project_id {
                        install_args["projectId"] = json!(project_id);
                    }
                    return service.execute_async("installGithub", &install_args).await;
                }

                // 开关：value 含 enabled。
                if let Some(enabled) = value.get("enabled").and_then(Value::as_bool) {
                    let mut set_args = json!({ "skillId": skill_id, "enabled": enabled });
                    if let Some(project_id) = &project_id {
                        set_args["projectId"] = json!(project_id);
                    }
                    return service.execute_async("setEnabled", &set_args).await;
                }

                Err(Error::new(
                    Status::InvalidArg,
                    "value must contain `enabled` (toggle) or `url` + `location` (install)".to_string(),
                ))
            }
            TOOL_DELETE => {
                let skill_id = required_string(args, "key")?;
                let mut delete_args = json!({ "skillId": skill_id });
                if let Some(project_id) = optional_project_id(args) {
                    delete_args["projectId"] = json!(project_id);
                }
                service.execute_async("uninstall", &delete_args).await
            }
            _ => Err(Error::new(
                Status::GenericFailure,
                format!(
                    "Unknown tool: \"{tool_name}\" for MCP server \"{SERVER_ID}\". Available tools: [config-list, config-get, config-set, config-delete]"
                ),
            )),
        }
    }
}

/// config-delete 破坏性操作的统一二次确认检查（所有 scope 共用）：
/// 调用方必须先通过 `user-interaction` 的 `askUserQuestion` 向用户展示
/// 将要删除/清空的配置（scope/key/projectId）与影响，获得明确同意后
/// 携带 `confirmed: true` 调用；未确认一律拒绝执行。
/// 语义提醒：imagegen 的 delete 是**全量清空所有渠道**（不是只删命名键），
/// skills 的 delete 是卸载技能，logs 的 delete 是删除日志文件。
fn require_delete_confirmation(args: &Value) -> napi::Result<()> {
    let confirmed = args
        .get(CONFIRM_PARAM)
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if confirmed {
        return Ok(());
    }
    let scope_name = args.get("scope").and_then(Value::as_str).unwrap_or("");
    let key_name = args.get("key").and_then(Value::as_str).unwrap_or("");
    let project_id = optional_project_id(args);
    Err(Error::new(
        Status::InvalidArg,
        format!(
            "config-delete is destructive and requires explicit user confirmation.\n\
             MANDATORY: before calling this tool, call the `askUserQuestion` tool from the\n\
             `user-interaction` server to show the user exactly which config will be deleted\n\
             (scope=`{scope_name}`, key=`{key_name}`{project_suffix}) and its impact, and wait\n\
             for their explicit approval. Only after the user confirms, retry this call with\n\
             `confirmed: true`. Note: for scope=`imagegen` this DELETES ALL image generation\n\
             channels (not just the named key); for `skills` it uninstalls the skill; for `logs`\n\
             it deletes a log file.",
            project_suffix = project_id
                .as_deref()
                .map(|pid| format!(", projectId=`{pid}`"))
                .unwrap_or_default(),
        ),
    ))
}

/// imagegen scope（图像生成设置，DB-backed system_settings 表）：
/// - list：返回所有渠道（id/name/provider/enabled/model/configured）概览
/// - get：读取完整配置（apiKey 脱敏）；key 可选（渠道 id / 渠道名 / 协议类型，缺省全部）
/// - set：value 为 {channels: [...]} 全量替换，或 {<channelId>: {...}} 按 id 合并更新（不存在则追加）
/// - delete：清空图像生成设置（所有渠道都未配置时生图工具不再暴露）
fn execute_imagegen_scope(tool_name: &str, args: &Value) -> napi::Result<Value> {
    match tool_name {
        TOOL_LIST => {
            // 先迁移旧格式（{openai, gemini} 顶层字段）为 channels 数组
            let settings = migrate_imagegen_channels(&load_imagegen_settings_value()?);
            let channels = settings
                .get("channels")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let entries: Vec<Value> = channels
                .iter()
                .map(|channel| {
                    let enabled = channel
                        .get("enabled")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    let model = channel
                        .get("model")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    json!({
                        "key": channel.get("id").and_then(Value::as_str).unwrap_or(""),
                        "id": channel.get("id").and_then(Value::as_str).unwrap_or(""),
                        "name": channel.get("name").and_then(Value::as_str).unwrap_or(""),
                        "provider": channel.get("provider").and_then(Value::as_str).unwrap_or("openai"),
                        "enabled": enabled,
                        "model": model,
                        "configured": enabled
                            && !model.is_empty()
                            && !channel.get("apiKey").and_then(Value::as_str).unwrap_or("").is_empty(),
                    })
                })
                .collect();
            Ok(json!({
                "scope": SCOPE_IMAGEGEN,
                "keys": entries,
                "maxConcurrentImages": settings
                    .get("maxConcurrentImages")
                    .cloned()
                    .unwrap_or_else(|| json!(4)),
                "timeoutSecs": settings
                    .get("timeoutSecs")
                    .cloned()
                    .unwrap_or_else(|| json!(300)),
                "note": "Channels are independent; enable one or more at once. When none is configured the imagegen-generate tool is hidden from the model. maxConcurrentImages (top-level global field, 1-8, default 4) caps how many generation requests run in parallel when the agent asks for several images at once; read/write it via config-get / config-set with key=maxConcurrentImages. timeoutSecs (top-level global field, 60-3600, default 300) is the per-request timeout for image generation (including streaming); raise it if complex/high-resolution prompts time out. Pass provider=<channelId|channelName|openai|gemini> to imagegen-generate to pick a channel.",
            }))
        }
        TOOL_GET => {
            // 先迁移旧格式（{openai, gemini} 顶层字段）为 channels 数组
            let settings = migrate_imagegen_channels(&load_imagegen_settings_value()?);
            let requested_key = args
                .get("key")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            match requested_key.as_deref() {
                // 顶层全局字段：最大并发生成数（1-8，默认 4）
                Some(key) if key.eq_ignore_ascii_case("maxConcurrentImages") => {
                    Ok(json!({
                        "scope": SCOPE_IMAGEGEN,
                        "key": "maxConcurrentImages",
                        "value": settings
                            .get("maxConcurrentImages")
                            .cloned()
                            .unwrap_or_else(|| json!(4)),
                    }))
                }
                // 顶层全局字段：生图请求超时（秒，60-3600，默认 300）
                Some(key) if key.eq_ignore_ascii_case("timeoutSecs") => {
                    Ok(json!({
                        "scope": SCOPE_IMAGEGEN,
                        "key": "timeoutSecs",
                        "value": settings
                            .get("timeoutSecs")
                            .cloned()
                            .unwrap_or_else(|| json!(300)),
                    }))
                }
                Some(key) => {
                    let key_lower = key.to_lowercase();
                    let is_provider_type = key_lower == "openai" || key_lower == "gemini";
                    let channel = settings
                        .get("channels")
                        .and_then(Value::as_array)
                        .and_then(|channels| {
                            channels.iter().find(|channel| {
                                if is_provider_type {
                                    channel
                                        .get("provider")
                                        .and_then(Value::as_str)
                                        .map(|provider| provider.eq_ignore_ascii_case(&key_lower))
                                        .unwrap_or(false)
                                } else {
                                    channel
                                        .get("id")
                                        .and_then(Value::as_str)
                                        .map(|id| id.eq_ignore_ascii_case(key))
                                        .unwrap_or(false)
                                        || channel
                                            .get("name")
                                            .and_then(Value::as_str)
                                            .map(|name| name.eq_ignore_ascii_case(key))
                                            .unwrap_or(false)
                                }
                            })
                        })
                        .cloned();
                    match channel {
                        Some(channel) => Ok(json!({
                            "scope": SCOPE_IMAGEGEN,
                            "key": key,
                            "value": mask_channel_api_key(channel),
                        })),
                        None => Err(Error::new(
                            Status::InvalidArg,
                            format!(
                                "Unknown imagegen channel: \"{key}\". Use config-list scope=imagegen to see available channels."
                            ),
                        )),
                    }
                }
                None => Ok(json!({
                    "scope": SCOPE_IMAGEGEN,
                    "key": "settings",
                    "value": mask_channel_api_key(settings),
                })),
            }
        }
        TOOL_SET => {
            let value = args.get("value").cloned().ok_or_else(|| {
                Error::new(
                    Status::InvalidArg,
                    "value is required for config-set (an object with channels or channel overrides)",
                )
            })?;
            if !value.is_object() {
                return Err(Error::new(
                    Status::InvalidArg,
                    "value must be an object like {channels: [...]} or {<channelId>: {...}}",
                ));
            }

            // 先迁移存储为 channels 数组格式
            let mut settings = migrate_imagegen_channels(&load_imagegen_settings_value()?);
            // 写前备份当前 imagegen 设置（写入期间的临时安全网），
            // 写入成功并验证后清理；防止误操作（如误清全部渠道）无法回滚。
            let backup = ConfigService::backup_db_value(
                "imagegen_settings",
                &serde_json::to_string(&settings).unwrap_or_default(),
            )?;
            // 保留「最大并发生成数」（顶层全局字段，设置面板可调）：本次
            // value 中显式提供时采用新值（规范化到 1-8 整数），否则沿用
            // 现有存储值，避免 config-set 重建 {channels} 时把用户配置的
            // 并发上限静默重置。
            let max_concurrent_images = value
                .get("maxConcurrentImages")
                .cloned()
                .or_else(|| settings.get("maxConcurrentImages").cloned())
                .map(clamp_imagegen_max_concurrent);
            // 保留「生图请求超时（秒）」（顶层全局字段，设置面板可调）：本次
            // value 中显式提供时采用新值（规范化到 60-3600），否则沿用现有
            // 存储值，避免 config-set 重建 {channels} 时把用户配置的超时
            // 静默重置。
            let timeout_secs = value
                .get("timeoutSecs")
                .cloned()
                .or_else(|| settings.get("timeoutSecs").cloned())
                .map(clamp_imagegen_timeout_secs);
            if let Some(channels_value) = value.get("channels") {
                // 全量替换
                if !channels_value.is_array() {
                    return Err(Error::new(
                        Status::InvalidArg,
                        "value.channels must be an array",
                    ));
                }
                settings = json!({ "channels": channels_value.clone() });
                if let Some(max_concurrent_images) = max_concurrent_images {
                    settings["maxConcurrentImages"] = max_concurrent_images;
                }
                if let Some(timeout_secs) = timeout_secs {
                    settings["timeoutSecs"] = timeout_secs;
                }
            } else if let Some(value_map) = value.as_object() {
                // 按渠道 id / 名称合并更新；不存在则追加为新渠道
                let mut channels: Vec<Value> = settings
                    .get("channels")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                for (key, override_value) in value_map {
                    if key == "channels" || !override_value.is_object() {
                        continue;
                    }
                    let is_legacy_key = key == "openai" || key == "gemini";
                    let mut merged_any = false;
                    for channel in channels.iter_mut() {
                        let matches = if is_legacy_key {
                            channel
                                .get("provider")
                                .and_then(Value::as_str)
                                .map(|provider| provider == key.as_str())
                                .unwrap_or(false)
                        } else {
                            channel
                                .get("id")
                                .and_then(Value::as_str)
                                .map(|id| id == key.as_str())
                                .unwrap_or(false)
                                || channel
                                    .get("name")
                                    .and_then(Value::as_str)
                                    .map(|name| name == key.as_str())
                                    .unwrap_or(false)
                        };
                        if matches {
                            let mut merged = channel.clone();
                            if let Some(merged_map) = merged.as_object_mut() {
                                if let Some(override_map) = override_value.as_object() {
                                    for (field, val) in override_map {
                                        merged_map.insert(field.clone(), val.clone());
                                    }
                                }
                            }
                            *channel = merged;
                            merged_any = true;
                        }
                    }
                    if !merged_any {
                        let mut new_channel = override_value.clone();
                        if let Some(map) = new_channel.as_object_mut() {
                            map.entry("id".to_string())
                                .or_insert_with(|| json!(key));
                            map.entry("provider".to_string())
                                .or_insert_with(|| json!("openai"));
                            map.entry("name".to_string())
                                .or_insert_with(|| json!(""));
                        }
                        channels.push(new_channel);
                    }
                }
                settings = json!({ "channels": channels });
                if let Some(max_concurrent_images) = max_concurrent_images {
                    settings["maxConcurrentImages"] = max_concurrent_images;
                }
                if let Some(timeout_secs) = timeout_secs {
                    settings["timeoutSecs"] = timeout_secs;
                }
            }

            save_imagegen_settings_value(&settings)?;
            // 写入成功：清理本次写前备份（临时安全网不再需要）。
            ConfigService::cleanup_backup(backup);
            Ok(json!({
                "scope": SCOPE_IMAGEGEN,
                "key": "settings",
                "value": mask_channel_api_key(settings),
            }))
        }
        TOOL_DELETE => {
            // 写前备份当前 imagegen 设置（写入期间的临时安全网），
            // 清空成功并验证后清理；防止误操作无法回滚。
            let current = migrate_imagegen_channels(&load_imagegen_settings_value()?);
            let backup = ConfigService::backup_db_value(
                "imagegen_settings",
                &serde_json::to_string(&current).unwrap_or_default(),
            )?;
            save_imagegen_settings_value(&json!({}))?;
            ConfigService::cleanup_backup(backup);
            Ok(json!({
                "scope": SCOPE_IMAGEGEN,
                "key": "settings",
                "deleted": true,
            }))
        }
        _ => Err(Error::new(
            Status::GenericFailure,
            format!(
                "Unknown tool: \"{tool_name}\" for MCP server \"{SERVER_ID}\". Available tools: [config-list, config-get, config-set, config-delete]"
            ),
        )),
    }
}

/// 规范化「最大并发生成数」：必须是有限数字，取整后收敛到 1-8 范围
/// （与设置面板 IMAGE_GEN_MAX_CONCURRENT_RANGE 一致）；非法值回退默认 4。
fn clamp_imagegen_max_concurrent(value: Value) -> Value {
    let Some(number) = value.as_f64().filter(|n| n.is_finite()) else {
        return json!(4);
    };
    json!(number.round().clamp(1.0, 8.0) as i64)
}

/// 规范化「生图请求超时（秒）」：必须是有限数字，取整后收敛到 60-3600
/// （与设置面板 IMAGE_GEN_TIMEOUT_RANGE 一致）；非法值回退默认 300。
fn clamp_imagegen_timeout_secs(value: Value) -> Value {
    let Some(number) = value.as_f64().filter(|n| n.is_finite()) else {
        return json!(300);
    };
    json!(number.round().clamp(60.0, 3600.0) as i64)
}

/// 将任意 imagegen 存储格式迁移为 { channels: [...] } 新格式：
/// - 已有 channels 数组 → 原样返回
/// - 旧双渠道 {openai, gemini} → 转为渠道数组
/// - 更旧单渠道（顶层字段）→ 转为单个渠道
fn migrate_imagegen_channels(settings: &Value) -> Value {
    if let Some(channels) = settings.get("channels") {
        if channels.is_array() {
            return settings.clone();
        }
    }

    let mut channels: Vec<Value> = Vec::new();
    for (key, provider) in [("openai", "openai"), ("gemini", "gemini")] {
        if let Some(channel) = settings.get(key) {
            if channel.is_object() {
                let mut migrated = channel.clone();
                if let Some(map) = migrated.as_object_mut() {
                    map.entry("id".to_string()).or_insert_with(|| json!(key));
                    map.entry("provider".to_string())
                        .or_insert_with(|| json!(provider));
                    map.entry("name".to_string()).or_insert_with(|| json!(""));
                }
                channels.push(migrated);
            }
        }
    }

    // 更旧单渠道格式（顶层 apiKey/model/...）
    if channels.is_empty() && settings.get("apiKey").is_some() {
        let old_provider = settings
            .get("provider")
            .and_then(Value::as_str)
            .unwrap_or("");
        let old_base_url = settings
            .get("baseUrl")
            .and_then(Value::as_str)
            .unwrap_or("");
        let is_gemini = old_provider == "gemini"
            || old_base_url.contains("generativelanguage")
            || old_base_url.contains("googleapis.com");
        let mut channel = settings.clone();
        if let Some(map) = channel.as_object_mut() {
            map.insert(
                "id".to_string(),
                json!(if is_gemini { "gemini" } else { "openai" }),
            );
            map.insert(
                "provider".to_string(),
                json!(if is_gemini { "gemini" } else { "openai" }),
            );
            map.insert("enabled".to_string(), json!(true));
        }
        channels.push(channel);
    }

    json!({ "channels": channels })
}

/// 读取 imagegen_settings 的 JSON 值（无配置时返回空对象）。
fn load_imagegen_settings_value() -> napi::Result<Value> {
    let storage_info = crate::storage::initialize_app_storage()?;
    let database_path = std::path::PathBuf::from(storage_info.database_path);
    let value = crate::storage::services::system_settings::get_system_setting_value(
        &database_path,
        "imagegen_settings",
    )?;
    match value {
        Some(raw) if !raw.trim().is_empty() => serde_json::from_str(&raw).map_err(|error| {
            Error::from_reason(format!("Failed to parse imagegen settings: {error}"))
        }),
        _ => Ok(json!({})),
    }
}

/// 写入 imagegen_settings。
fn save_imagegen_settings_value(settings: &Value) -> napi::Result<()> {
    let storage_info = crate::storage::initialize_app_storage()?;
    let database_path = std::path::PathBuf::from(storage_info.database_path);
    crate::storage::services::system_settings::set_system_setting(
        &database_path,
        "Image Generation Settings",
        "imagegen_settings",
        &serde_json::to_string(settings).map_err(|error| {
            Error::from_reason(format!("Failed to serialize imagegen settings: {error}"))
        })?,
    )
    .map_err(|error| Error::from_reason(format!("Failed to save imagegen settings: {error}")))
}

/// 递归脱敏对象中的 apiKey 字段（如 sk-****abcd），防止明文密钥外泄。
fn mask_channel_api_key(value: Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut masked = serde_json::Map::new();
            for (key, val) in map {
                if key == "apiKey" {
                    if let Some(text) = val.as_str() {
                        masked.insert(key, json!(mask_api_key(text)));
                        continue;
                    }
                }
                masked.insert(key, mask_channel_api_key(val));
            }
            Value::Object(masked)
        }
        Value::Array(items) => Value::Array(items.into_iter().map(mask_channel_api_key).collect()),
        other => other,
    }
}

fn mask_api_key(key: &str) -> String {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.len() <= 8 {
        return "****".to_string();
    }
    let prefix = &trimmed[..4];
    let suffix = &trimmed[trimmed.len() - 4..];
    format!("{prefix}****{suffix}")
}

/// personalization scope：全局规则/角色定义文件（~/.snow/ROLE.md）。
/// ROLE.md 是纯文本 markdown（非 JSON），key = "role"，值为规则全文：
/// - list：返回键规格 + configured/长度/预览（不返回全文，避免上下文膨胀）；
/// - get：返回规则全文（文件不存在时返回 null）；
/// - set：备份后原子写入全文（值必须是字符串）；
/// - delete：需 confirmed，删除文件即恢复默认（应用对缺失 ROLE.md 有内置回退）。
fn execute_personalization_scope(tool_name: &str, args: &Value) -> napi::Result<Value> {
    match tool_name {
        TOOL_LIST => list_personalization_role(),
        TOOL_GET => get_personalization_role(args),
        TOOL_SET => set_personalization_role(args),
        TOOL_DELETE => delete_personalization_role(args),
        _ => Err(Error::new(
            Status::GenericFailure,
            format!(
                "Unknown tool: \"{tool_name}\" for MCP server \"{SERVER_ID}\". Available tools: [config-list, config-get, config-set, config-delete]"
            ),
        )),
    }
}

/// ~/.snow/ROLE.md 的完整路径。
fn role_file_path() -> PathBuf {
    ConfigService::snow_dir().join(ROLE_FILE_NAME)
}

/// 读取 ROLE.md 全文；文件不存在时返回 None。
fn read_role_file() -> napi::Result<Option<String>> {
    let file_path = role_file_path();
    match fs::read_to_string(&file_path) {
        Ok(content) => Ok(Some(content)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(Error::new(
            Status::GenericFailure,
            format!("Failed to read {}: {error}", file_path.display()),
        )),
    }
}

/// 原子写入 ROLE.md（临时文件 + rename，崩溃不损坏目标文件）。
fn atomic_write_role(content: &str) -> napi::Result<()> {
    let file_path = role_file_path();
    let tmp_path = file_path.with_extension("role.tmp");
    fs::write(&tmp_path, content).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to write {}: {error}", tmp_path.display()),
        )
    })?;
    fs::rename(&tmp_path, &file_path).map_err(|error| {
        let _ = fs::remove_file(&tmp_path);
        Error::new(
            Status::GenericFailure,
            format!("Failed to replace {}: {error}", file_path.display()),
        )
    })
}

/// config-list personalization：返回键规格（role）+ configured/长度/预览。
fn list_personalization_role() -> napi::Result<Value> {
    let content = read_role_file()?;
    let (configured, length, preview) = match &content {
        Some(text) => {
            let preview: String = text.chars().take(ROLE_PREVIEW_LEN).collect();
            (true, text.len(), preview)
        }
        None => (false, 0, String::new()),
    };
    Ok(json!({
        "scope": SCOPE_PERSONALIZATION,
        "file": ROLE_FILE_NAME,
        "keys": [{
            "key": PERSONALIZATION_ROLE_KEY,
            "type": "string",
            "sensitive": false,
            "configured": configured,
            "length": length,
            "preview": preview,
            "value": Value::Null,
        }],
        "note": "Use config-get scope=personalization key=role to read the full rules; config-set key=role writes the whole file (markdown text); config-delete removes ROLE.md and restores defaults.",
    }))
}

/// config-get personalization：key=role 返回规则全文（文件不存在时返回 null）。
fn get_personalization_role(args: &Value) -> napi::Result<Value> {
    let key_name = required_string(args, "key")?;
    if key_name != PERSONALIZATION_ROLE_KEY {
        return Err(invalid_personalization_key_error(key_name));
    }
    let display = match read_role_file()? {
        Some(text) => Value::String(text),
        None => Value::Null,
    };
    Ok(json!({
        "scope": SCOPE_PERSONALIZATION,
        "key": PERSONALIZATION_ROLE_KEY,
        "value": display,
    }))
}

/// config-set personalization：key=role value=<字符串> 备份后原子写入全文。
fn set_personalization_role(args: &Value) -> napi::Result<Value> {
    let key_name = required_string(args, "key")?;
    if key_name != PERSONALIZATION_ROLE_KEY {
        return Err(invalid_personalization_key_error(key_name));
    }
    let value = args.get("value").cloned().ok_or_else(|| {
        Error::new(
            Status::InvalidArg,
            "value is required for config-set".to_string(),
        )
    })?;
    if !value.is_string() {
        return Err(Error::new(
            Status::InvalidArg,
            format!(
                "Invalid value type for key `{}` (expected string)",
                PERSONALIZATION_ROLE_KEY
            ),
        ));
    }
    let content = value.as_str().unwrap_or_default().to_string();

    let file_path = role_file_path();
    let backup = ConfigService::backup_file(&file_path)?;
    atomic_write_role(&content)?;
    // 写入成功：删除本次写前备份（临时安全网不再需要）。
    ConfigService::cleanup_backup(backup);

    Ok(json!({
        "scope": SCOPE_PERSONALIZATION,
        "key": PERSONALIZATION_ROLE_KEY,
        "value": content,
    }))
}

/// config-delete personalization：key=role 需 confirmed，删除 ROLE.md（恢复默认）。
fn delete_personalization_role(args: &Value) -> napi::Result<Value> {
    // 破坏性操作二次确认（统一在 execute_async 入口检查；此处防御性兜底）。
    require_delete_confirmation(args)?;
    let key_name = required_string(args, "key")?;
    if key_name != PERSONALIZATION_ROLE_KEY {
        return Err(invalid_personalization_key_error(key_name));
    }
    let file_path = role_file_path();
    if !file_path.exists() {
        return Ok(json!({
            "scope": SCOPE_PERSONALIZATION,
            "key": PERSONALIZATION_ROLE_KEY,
            "deleted": false,
        }));
    }
    let backup = ConfigService::backup_file(&file_path)?;
    fs::remove_file(&file_path).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to delete {}: {error}", file_path.display()),
        )
    })?;
    // 删除成功：清理本次写前备份。
    ConfigService::cleanup_backup(backup);
    Ok(json!({
        "scope": SCOPE_PERSONALIZATION,
        "key": PERSONALIZATION_ROLE_KEY,
        "deleted": true,
    }))
}

/// personalization scope 键白名单错误。
fn invalid_personalization_key_error(key: &str) -> Error {
    Error::new(
        Status::InvalidArg,
        format!(
            "Unknown config key: \"{key}\" in scope \"{SCOPE_PERSONALIZATION}\". Available keys: [{PERSONALIZATION_ROLE_KEY}]"
        ),
    )
}

/// 校验并返回应用数据库路径；native 存储未初始化时给出明确错误。
/// logs scope（只读日志域）：列出/读取/清理 ~/.snow/log 下的应用日志，
/// 供 agent 自主进行异常分析。set 只读；delete 需精确文件名（防路径穿越）。
fn execute_logs_scope(tool_name: &str, args: &Value) -> napi::Result<Value> {
    match tool_name {
            TOOL_LIST => list_log_files(),
            TOOL_GET => read_log_file(args),
            TOOL_SET => Err(Error::new(
                Status::InvalidArg,
                "logs scope is read-only: use config-list / config-get to inspect logs; config-delete removes one log file".to_string(),
            )),
            TOOL_DELETE => delete_log_file(args),
            _ => Err(Error::new(
                Status::GenericFailure,
                format!(
                    "Unknown tool: \"{tool_name}\" for MCP server \"{SERVER_ID}\". Available tools: [config-list, config-get, config-set, config-delete]"
                ),
            )),
        }
}

/// 日志文件名校验（YYYY-MM-DD-level.log，防路径穿越）。
fn valid_log_name(name: &str) -> bool {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re =
        RE.get_or_init(|| regex::Regex::new(LOG_FILE_RE).expect("LOG_FILE_RE is a valid regex"));
    re.is_match(name)
}

/// 日志目录（~/.snow/log）。
fn log_dir() -> PathBuf {
    ConfigService::snow_dir().join(LOG_DIR_NAME)
}

/// config-list logs：列出日志文件（按日期倒序）+ 错误摘要。
fn list_log_files() -> napi::Result<Value> {
    let dir = log_dir();
    if !dir.exists() {
        return Ok(json!({
            "scope": SCOPE_LOGS,
            "directory": dir.to_string_lossy(),
            "files": [],
            "summary": { "totalFiles": 0, "totalBytes": 0, "latestErrorFile": null },
        }));
    }
    let mut files: Vec<Value> = Vec::new();
    let mut total_bytes: u64 = 0;
    let mut latest_error: Option<String> = None;
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if !valid_log_name(name) {
                continue;
            }
            let metadata = entry.metadata().ok();
            let size = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
            total_bytes += size;
            let level = name
                .strip_suffix(".log")
                .and_then(|stem| stem.rsplit('-').next())
                .unwrap_or("")
                .to_string();
            if level == "error" {
                if latest_error.is_none() || name > latest_error.as_deref().unwrap_or("") {
                    latest_error = Some(name.to_string());
                }
            }
            let last_modified = metadata
                .and_then(|m| m.modified().ok())
                .map(|t| {
                    t.duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis() as i64)
                        .unwrap_or(0)
                })
                .unwrap_or(0);
            files.push(json!({
                "file": name,
                "date": name.get(..10),
                "level": level,
                "size": size,
                "lastModified": last_modified,
            }));
        }
    }
    // 按日期倒序（文件名前缀即日期）。
    files.sort_by(|a, b| {
        b.get("file")
            .and_then(Value::as_str)
            .cmp(&a.get("file").and_then(Value::as_str))
    });
    Ok(json!({
        "scope": SCOPE_LOGS,
        "directory": dir.to_string_lossy(),
        "files": files,
        "summary": {
            "totalFiles": files.len(),
            "totalBytes": total_bytes,
            "latestErrorFile": latest_error,
        },
    }))
}

/// config-get logs：读取指定日志文件的尾部内容。
/// key 支持精确文件名（`2026-08-03-error.log`）或级别简写（error/warn/info/debug，
/// 读取今天的对应文件）。可选 `limit` 控制返回行数（默认 200，最大 2000）。
fn read_log_file(args: &Value) -> napi::Result<Value> {
    let key = required_string(args, "key")?;
    let limit = args
        .get("limit")
        .and_then(Value::as_u64)
        .map(|v| (v as usize).clamp(1, LOG_MAX_LINES))
        .unwrap_or(LOG_DEFAULT_LINES);

    let file_name = if valid_log_name(key) {
        key.to_string()
    } else if ["debug", "info", "warn", "error"].contains(&key) {
        format!("{}-{}.log", chrono::Local::now().format("%Y-%m-%d"), key)
    } else {
        return Err(Error::new(
                Status::InvalidArg,
                format!(
                    "Invalid log key: \"{key}\". Use a log file name (e.g. 2026-08-03-error.log) or a level shortcut (debug/info/warn/error for today's file)"
                ),
            ));
    };

    let path = log_dir().join(&file_name);
    if !path.exists() {
        return Ok(json!({
            "scope": SCOPE_LOGS,
            "key": key,
            "file": file_name,
            "exists": false,
            "content": "",
            "totalLines": 0,
            "truncated": false,
        }));
    }
    let file = std::fs::File::open(&path).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!(
                "Failed to open log file {}: {error}",
                path.to_string_lossy()
            ),
        )
    })?;
    // 环形缓冲保留最后 limit 行，避免大文件全量加载。
    use std::io::BufRead;
    let reader = std::io::BufReader::new(file);
    let mut tail: std::collections::VecDeque<String> =
        std::collections::VecDeque::with_capacity(limit);
    let mut total_lines: usize = 0;
    for line in reader.lines().map_while(|l| l.ok()) {
        total_lines += 1;
        if tail.len() == limit {
            tail.pop_front();
        }
        tail.push_back(line);
    }
    let truncated = total_lines > limit;
    Ok(json!({
        "scope": SCOPE_LOGS,
        "key": key,
        "file": file_name,
        "exists": true,
        "content": tail.make_contiguous().join("\n"),
        "totalLines": total_lines,
        "returnedLines": tail.len(),
        "truncated": truncated,
        "hint": truncated.then(|| format!("file has {total_lines} lines; showing the last {limit} — read with a larger `limit` if needed")),
    }))
}

/// config-delete logs：删除指定日志文件（仅精确文件名，防路径穿越）。
fn delete_log_file(args: &Value) -> napi::Result<Value> {
    let key = required_string(args, "key")?;
    if !valid_log_name(key) {
        return Err(Error::new(
                Status::InvalidArg,
                format!(
                    "Invalid log key: \"{key}\". config-delete logs only accepts an exact log file name (e.g. 2026-08-03-error.log)"
                ),
            ));
    }
    let path = log_dir().join(key);
    let deleted = if path.exists() {
        std::fs::remove_file(&path).is_ok()
    } else {
        false
    };
    Ok(json!({
        "scope": SCOPE_LOGS,
        "key": key,
        "deleted": deleted,
    }))
}

fn db_path_or_error(db_path: &str) -> napi::Result<&Path> {
    if db_path.is_empty() {
        return Err(Error::new(
            Status::GenericFailure,
            "App database is not available (native storage failed to initialize)".to_string(),
        ));
    }
    Ok(Path::new(db_path))
}

/// 校验子代理 toolsJson 中的工具名在当前项目可用（对齐 TS validateSubAgentTools 的静态版本）：
/// - 空数组或 ["*"] 直接通过；
/// - 选择 MCP 工具时必须提供 projectId（全局子代理仅允许空/["*"]，与 UI 一致）；
/// - 工具全名 `{server_id}-{tool_name}`：内置服务器须命中内置工具集；
///   外部服务器须命中当前项目 enabled 的 MCP 服务器公开名（不实际连接服务器，
///   因此只校验服务器归属，具体工具名留给运行时发现）。
fn validate_sub_agent_tools(
    db_path: &Path,
    project_id: Option<&str>,
    tools_json: &str,
) -> napi::Result<()> {
    use crate::mcp::builtin::get_builtin_tools;
    use crate::mcp::external::public_server_name_map;
    use crate::mcp::tools::split_tool_full_name;

    let parsed: Value = serde_json::from_str(tools_json).map_err(|error| {
        Error::new(
            Status::InvalidArg,
            format!("value.toolsJson must be valid JSON: {error}"),
        )
    })?;
    let tool_names: Vec<&str> = parsed
        .as_array()
        .map(|items| items.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    if tool_names.is_empty() || (tool_names.len() == 1 && tool_names[0] == "*") {
        return Ok(());
    }
    let Some(project_id) = project_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return Err(Error::new(
            Status::InvalidArg,
            "Project id is required when sub-agent MCP tools are selected".to_string(),
        ));
    };

    let builtin_tool_names: HashSet<String> = get_builtin_tools()
        .iter()
        .map(|tool| tool.full_name())
        .collect();
    let configs =
        crate::storage::services::project_mcp_server_configs::list_effective_mcp_server_configs(
            db_path,
            Some(project_id),
        )?;
    let public_names = public_server_name_map(&configs);
    let enabled_server_names: HashSet<String> = configs
        .iter()
        .filter(|config| config.enabled)
        .filter_map(|config| public_names.get(&config.server_id).cloned())
        .collect();

    for tool_name in tool_names {
        if builtin_tool_names.contains(tool_name) {
            continue;
        }
        let is_external = split_tool_full_name(tool_name)
            .is_some_and(|(server_name, _)| enabled_server_names.contains(server_name));
        if !is_external {
            return Err(Error::new(
                Status::InvalidArg,
                format!(
                    "Selected sub-agent MCP tool is not enabled for the current project: {tool_name}"
                ),
            ));
        }
    }
    Ok(())
}

/// 可选 projectId 参数：去空白，空串视为未提供（全局作用域）。
fn optional_project_id(args: &Value) -> Option<String> {
    args.get("projectId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// args 是否显式提供了 projectId（哪怕为空串）。只要调用方显式传了
/// projectId 字段就以调用方为准，绝不覆盖：
/// - 显式传 `""` 表示全局；
/// - 显式传非空值表示指定项目；
/// - 未传该字段时才允许自动注入当前会话项目ID。
fn has_explicit_project_id(args: &Value) -> bool {
    args.get("projectId").is_some()
}

/// 当前调用（scope 与可选 key）是否支持项目级作用域。只有这些目标在
/// 未显式传 projectId 时才允许自动注入当前会话项目ID：
/// - subAgents / hooks / skills（DB 域，projectId 表示项目级）
/// - settings 的 mcpServers / sensitiveCommands（项目级 settings 键）
/// 其余 scope（theme/app/snowcfg 等全局文件域）不支持项目级，不注入，
/// 保持全局语义不变。
fn config_scope_supports_project_id(args: &Value) -> bool {
    let Some(scope) = args.get("scope").and_then(Value::as_str) else {
        return false;
    };
    match scope {
        SCOPE_SUB_AGENTS | SCOPE_HOOKS | SCOPE_SKILLS => true,
        "settings" => {
            let key = args.get("key").and_then(Value::as_str).unwrap_or("");
            key == "mcpServers" || key == "sensitiveCommands"
        }
        _ => false,
    }
}

impl McpService for ConfigService {
    fn id(&self) -> &str {
        SERVER_ID
    }

    fn tools(&self) -> Vec<McpTool> {
        vec![
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: TOOL_LIST.to_string(),
                description: "List configuration scopes and their keys; pass `scope` to inspect one scope (returns current values; sensitive keys masked).\nSCOPE REFERENCE:\n1. settings (~/.snow/settings.json): mcpServers, codebase, sensitiveCommands, yoloMode, planMode, goal, toolSearchEnabled, ...\n2. snowcfg (~/.snow/config.json): baseUrl, apiKey, advancedModel, basicModel, maxTokens, chatThinking, ...\n3. proxy (~/.snow/proxy-config.json): enabled, host, port, searchEngine, browserPath, browserDebugPort\n4. app (~/.snow/active-profile.json): activeProfile\n5. custom-headers (~/.snow/custom-headers.json): active, schemes (sensitive)\n6. system-prompt (~/.snow/system-prompt.json): active, prompts (sensitive)\n7. theme (~/.snow/theme.json): theme, simpleMode, diffOpacity, toolIcons, customColors, ...\n8. language (~/.snow/language.json): language\n9. permissions (~/.snow/permissions.json): alwaysApprovedTools\n10. lsp-config (~/.snow/lsp-config.json): schemaVersion, servers\n11. buddy (~/.snow/buddy.json): version, companion, muted\n12. subAgents (app DB): sub-agent configs, key=agentId; list returns items + CREATING guidance\n13. hooks (app DB): lifecycle hook configs, key=hookType; list returns items + CONFIGURING guidance\n14. imagegen (app DB): image generation channels + top-level maxConcurrentImages (1-8, default 4) and timeoutSecs (60-3600, default 300); list returns keys + note\n15. skills (delegated): skillId toggles / GitHub installs\n16. logs (read-only): log files under ~/.snow/log\n17. personalization (~/.snow/ROLE.md): global role/rules file (plain markdown, non-JSON), key=role; list returns length + preview, get returns the full rules text, set writes the whole file, delete removes it (restores defaults)\nRULES: pass projectId to scope subAgents/hooks/skills listings to a specific project (omitted = auto-injects the CURRENT SESSION's projectId, so you get/configure the active project's settings; pass an empty string \"\" for global); every list response includes the current session's projectId as `currentProjectId` — read it to obtain the project id bound to the current conversation; sensitive values (apiKey, visionApiKey, custom-header schemes, system-prompt prompts, imagegen apiKey) are always masked."
                    .to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "scope": {
                            "type": "string",
"enum": ["settings", "snowcfg", "proxy", "app", "custom-headers", "system-prompt", "theme", "language", "permissions", "lsp-config", "buddy", "subAgents", "hooks", "skills", "logs", "imagegen", "personalization"],
                            "description": "Optional config scope name; when omitted, lists all scopes."
                        },
                        "projectId": {
                            "type": "string",
                            "description": "Optional project id. For subAgents/hooks scopes: when provided, lists configs for that project; when omitted, the CURRENT SESSION's projectId is auto-injected (lists the active project's configs; pass an empty string \"\" for global; subAgents without any projectId context returns ALL configs incl. project ones)."
                        }
                    },
                    "additionalProperties": false
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: TOOL_GET.to_string(),
                description: "Read the value of a configuration key. Sensitive keys (apiKey, visionApiKey) are always returned masked (e.g. sk-****abcd); this tool never exposes plaintext secrets. Returns null when the key is not configured. DB-backed scopes: subAgents (key=agentId) and hooks (key=hookType) read directly from the app database; pass optional `projectId` to read a project-scoped config (omitted = global). Read-only logs scope: key is a log file name (e.g. 2026-08-03-error.log) or a level shortcut (error/warn/info/debug for today's file); optional `limit` controls returned tail lines (default 200, max 2000). personalization (key=role): returns the full ~/.snow/ROLE.md rules text (null when the file does not exist). Project-scoped settings: pass `projectId` to read settings.mcpServers / settings.sensitiveCommands from the project-scoped app database (other keys reject projectId).".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "scope": {
                            "type": "string",
"enum": ["settings", "snowcfg", "proxy", "app", "custom-headers", "system-prompt", "theme", "language", "permissions", "lsp-config", "buddy", "subAgents", "hooks", "skills", "logs", "imagegen", "personalization"],
                            "description": "Config scope name."
                        },
                        "key": {
                            "type": "string",
                            "description": "Key name within the scope (see config-list). For imagegen: a channel id/name or provider type (openai|gemini), or a global key (maxConcurrentImages / timeoutSecs)."
                        },
                        "projectId": {
                            "type": "string",
                            "description": "Optional project id for project-scoped targets (subAgents/hooks/skills/settings.mcpServers/settings.sensitiveCommands); omitted = auto-injects the CURRENT SESSION's projectId (pass \"\" for global config)."
                        },
                        "limit": {
                            "type": "integer",
                            "minimum": 1,
                            "maximum": 2000,
                            "description": "For the read-only logs scope: max tail lines to return (default 200, max 2000)."
                        }
                    },
                    "required": ["scope", "key"],
                    "additionalProperties": false
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: TOOL_SET.to_string(),
                description: "Write a value for a configuration key (whitelisted scopes only; type-checked; auto-backup to ~/.snow/.config-backups as a temporary safety net before the write, removed after a successful write; atomic write).\nRULES:\n- settings.mcpServers: syncs into the app database on write and takes effect immediately (same diff semantics as the UI sync action).\n- Other file-backed scopes (snowcfg/proxy/app/custom-headers/system-prompt/theme/language/permissions/lsp-config/buddy): changes may need an app restart or a UI re-save. personalization (key=role, value must be a string): replaces the whole ~/.snow/ROLE.md file (markdown text); takes effect in the next conversation.\n- DB-backed scopes (take effect immediately): subAgents (key=agentId, value={name, description?, systemPrompt?, toolsJson?, configProfile?, model?}; an explicit toolsJson tool list requires projectId, see the guidance from config-list scope=subAgents); hooks (key=hookType, value={rules:[...]}, see the guidance from config-list scope=hooks); imagegen (value={channels:[...]} full replace, {<channelId>: {...}} per-channel merge keeping omitted fields, or a global field alone: {maxConcurrentImages: N} clamped to 1-8 / {timeoutSecs: N} clamped to 60-3600).\n- Project-scoped: pass projectId for settings.mcpServers (full replace of {name: {type,url,command,args,env,headers,enabled,timeoutMs}}) or settings.sensitiveCommands (full replace of [{commandId, pattern, description, enabled}]); other scopes ignore projectId.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "scope": {
                            "type": "string",
"enum": ["settings", "snowcfg", "proxy", "app", "custom-headers", "system-prompt", "theme", "language", "permissions", "lsp-config", "buddy", "subAgents", "hooks", "skills", "logs", "imagegen", "personalization"],
                            "description": "Config scope name."
                        },
                        "key": {
                            "type": "string",
                            "description": "Key name within the scope (see config-list). For imagegen: a channel id/name or provider type (openai|gemini), or the global key maxConcurrentImages."
                        },
                        "value": {
                            "description": "New value; type must match the key schema (see config-list)."
                        },
                        "projectId": {
                            "type": "string",
                            "description": "Optional project id for project-scoped targets (subAgents/hooks/skills/settings.mcpServers/settings.sensitiveCommands); omitted = auto-injects the CURRENT SESSION's projectId (pass \"\" for global config)."
                        }
                    },
                    "required": ["scope", "key", "value"],
                    "additionalProperties": false
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: TOOL_DELETE.to_string(),
                description: "Delete a configuration key (e.g. clear an apiKey). DESTRUCTIVE — REQUIRES EXPLICIT USER CONFIRMATION: before calling this tool you MUST call the `askUserQuestion` tool from the `user-interaction` server to show the user exactly which config will be deleted (scope, key, projectId) and its impact, then wait for their explicit approval; only then retry this call with `confirmed: true`. Calls without `confirmed: true` are rejected. Scope-specific semantics: `imagegen` DELETES ALL image generation channels (not just the named key — the whole image generation config is cleared); `skills` uninstalls the skill; `logs` deletes one log file; `subAgents` deletes a sub-agent (built-in agent_general cannot be deleted); `hooks` deletes the hookType config. `personalization` deletes ~/.snow/ROLE.md (restores default rules). The current value is backed up before the write (temporary safety net) and the backup is removed after a successful write. Returns deleted=false when the key was not configured. Pass optional `projectId` to delete a project-scoped config (omitted = global). Project-scoped settings: projectId + settings.mcpServers clears all project MCP servers; projectId + settings.sensitiveCommands clears all project sensitive-command overrides.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "scope": {
                            "type": "string",
"enum": ["settings", "snowcfg", "proxy", "app", "custom-headers", "system-prompt", "theme", "language", "permissions", "lsp-config", "buddy", "subAgents", "hooks", "skills", "logs", "imagegen", "personalization"],
                            "description": "Config scope name."
                        },
                        "key": {
                            "type": "string",
                            "description": "Key name within the scope (see config-list). For imagegen: the whole image generation config is cleared regardless of this key."
                        },
                        "confirmed": {
                            "type": "boolean",
                            "description": "MUST be true. Set it only after the user has explicitly approved the deletion via the `user-interaction` `askUserQuestion` tool; the deletion is rejected without user confirmation."
                        },
                        "projectId": {
                            "type": "string",
                            "description": "Optional project id for project-scoped targets (subAgents/hooks/skills/settings.mcpServers/settings.sensitiveCommands); omitted = auto-injects the CURRENT SESSION's projectId (pass \"\" for global config)."
                        }
                    },
                    "required": ["scope", "key", "confirmed"],
                    "additionalProperties": false
                }),
            },
        ]
    }

    fn execute(&self, tool_name: &str, args: &Value) -> napi::Result<Value> {
        match tool_name {
            TOOL_LIST => self.execute_list(args),
            TOOL_GET => self.execute_get(args),
            TOOL_SET => self.execute_set(args),
            TOOL_DELETE => self.execute_delete(args),
            _ => Err(Error::new(
                Status::GenericFailure,
                format!(
                    "Unknown tool: \"{tool_name}\" for MCP server \"{SERVER_ID}\". Available tools: [config-list, config-get, config-set, config-delete]"
                ),
            )),
        }
    }
}

fn type_name(value_type: ValueType) -> &'static str {
    match value_type {
        ValueType::String => "string",
        ValueType::Bool => "boolean",
        ValueType::Int => "integer",
        ValueType::Number => "number",
        ValueType::Object => "object",
        ValueType::Array => "array",
    }
}

fn available_scopes() -> String {
    let mut scopes: Vec<&str> = SCOPES.iter().map(|spec| spec.scope).collect();
    scopes.push(SCOPE_SUB_AGENTS);
    scopes.push(SCOPE_HOOKS);
    scopes.push(SCOPE_SKILLS);
    scopes.push(SCOPE_LOGS);
    scopes.push(SCOPE_IMAGEGEN);
    scopes.push(SCOPE_PERSONALIZATION);
    scopes.join(", ")
}

fn available_keys(scope: &ScopeSpec) -> String {
    scope
        .keys
        .iter()
        .map(|spec| spec.key)
        .collect::<Vec<_>>()
        .join(", ")
}

fn invalid_scope_error(scope: &str) -> Error {
    Error::new(
        Status::InvalidArg,
        format!(
            "Unknown config scope: \"{scope}\". Available scopes: [{}]",
            available_scopes()
        ),
    )
}

fn invalid_key_error(scope: &ScopeSpec, key: &str) -> Error {
    Error::new(
        Status::InvalidArg,
        format!(
            "Unknown config key: \"{key}\" in scope \"{}\". Available keys: [{}]",
            scope.scope,
            available_keys(scope)
        ),
    )
}

fn invalid_nested_field_error(field: &str, expected: &str) -> Error {
    Error::new(
        Status::InvalidArg,
        format!("Invalid value for `{field}` (expected {expected})"),
    )
}

fn required_string<'a>(args: &'a Value, key: &str) -> napi::Result<&'a str> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| Error::new(Status::InvalidArg, format!("{key} is required")))
}
