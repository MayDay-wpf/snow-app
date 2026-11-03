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

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use napi::bindgen_prelude::*;
use serde_json::{json, Map, Value};

use super::super::service::McpService;
use super::super::tools::McpTool;

mod app_settings_scope;
mod codebase_scope;
mod custom_commands_scope;
mod imagegen_scope;
mod keyboard_shortcuts_scope;
mod lsp_config_scope;
// Snow App logs are exposed by the dedicated config-logs-read MCP tool.
mod mcp_servers_scope;
mod memos_scope;
mod personalization_scope;
mod plugins_scope;
mod privacy_scope;
mod request_logging_scope;
mod scheduled_tasks_scope;
mod stream_cursor_scope;
mod usage_scope;
mod userscripts_scope;
mod workspace_scope;

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

/// 只读 Snow App 日志由独立的 config-logs-read MCP 工具提供。
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

/// API 档案配置域（DB-backed，应用数据库 api_configs 表，与 UI 同源、立即生效）：
/// 让 agent 新建/读取/更新/删除 API 档案，支持"无密钥建档 → 用户后补密钥"。
/// key = profileName；value 为可写字段（merge 语义，空 apiKey 保留旧值）；
/// delete 需 confirmed。
const SCOPE_API_PROFILES: &str = "apiProfiles";

/// 用户脚本域（DB-backed，应用数据库 userscripts 表，与 UI 同源）：让 AI 帮用户
/// 编写并安装油猴（Tampermonkey 兼容）脚本。key = script_id（"new" 表示新建）；
/// config-set value={raw: "..."} 创建/更新（解析元数据写 DB + 文件存
/// ~/.snowapp/browser-script/），value={enabled: bool} 开关，
/// value={values: {...}} 管理 GM 持久化值；delete 需 confirmed。
const SCOPE_USERSCRIPTS: &str = "userscripts";

const SCOPE_PLUGINS: &str = "plugins";

/// DB-backed 配置域：LSP 语言服务器配置（lsp_server_configs 表，与 UI 同源、
/// 立即生效）：agent 用现有 config-set scope=lsp-config 即可配置。
const SCOPE_LSP_CONFIG: &str = "lsp-config";

/// DB-backed 配置域：自定义请求头方案（custom_header_schemes 表，与 UI
/// 「自定义请求头」设置页同源、立即生效）——让 Snow App 直接管理自己 API
/// 请求所用的自定义请求头。key = schemeId（传 "new" 自动生成 id 新建）；
/// value = { name?, headers?, isActive?, sortOrder? }，headers 为 merge 语义
/// （键值设 `null` 删除该请求头）；isActive:true 会互斥激活该方案。
/// 注意：scope=`custom-headers` 只是 Snow CLI 兼容的同步源文件
/// （~/.snow/custom-headers.json），写入它不会自动改变 App 实际发送的请求头；
/// 要直接改 App 生效的请求头请用本域。
const SCOPE_CUSTOM_HEADER_SCHEMES: &str = "customHeaderSchemes";

/// DB-backed 配置域：MCP 服务器配置与工具级启停（应用真实生效的那一份）。
/// projectId 非空 = 项目级（会话内缺省自动注入当前项目），显式 `""` = 全局；
/// key = 服务器名（`"new"` 表示按 value.name 新建，不可改名）；
/// value = merge 语义的服务器字段
/// `{name?, type?("stdio"|"sse"|"http"), url?, command?, args?, env?, headers?,
/// enabled?, timeoutMs?}`，另可用 `tools: {toolName: bool}` 或
/// `disabledTools: [toolName]` 批量启停工具；delete 需 confirmed。
/// 与 `settings.mcpServers`（Snow CLI 同步入口）的区别：本域不需要经过文件同步。
const SCOPE_MCP_SERVERS: &str = "mcpServers";

/// DB-backed 单例配置域：请求日志开关与自动过期时间（system_settings，
/// 与「系统日志」设置页同源）。key = `"settings"`；
/// value = `{enabled: bool, expiresAt?: number(ms)|expiresInMinutes?: number}`。
/// 开启时必须给出过期时间（缺省 5 分钟，上限 30 分钟）——Rust 的记录路径会在
/// 过期后自动复位开关，避免忘记关闭导致持续写盘。不支持 delete。
const SCOPE_REQUEST_LOGGING: &str = "requestLogging";

/// 只读配置域：定时任务定义、状态与运行历史（scheduled_tasks 表）。
/// 调度器运行在渲染进程、任务 store 仅在启动时 hydrate：
/// set key="new" 在 tools/call.rs 路由到渲染端创建；改/删/暂停在界面面板操作。
const SCOPE_SCHEDULED_TASKS: &str = "scheduledTasks";

/// 工具免确认白名单（授权域）。projectId 非空 = 项目级（system_settings
/// `project_tool_approval_scope_*`，可读写）；显式 `""` = 全局视图（真源是
/// permissions.json 的 `alwaysApprovedTools`，此处只读展示，写入请用
/// `scope=permissions`）。key = `"tools"`；value = 数组，或
/// `{tools: [...]}` / `{add: [...], remove: [...]}`；项目级 delete 清空白名单（需 confirmed）。
const SCOPE_TOOL_APPROVAL: &str = "toolApproval";

/// 只读配置域：用量统计（usage_records 表，与「用量统计」设置页同源）。
/// list 支持 `since`/`until`（缺省最近 30 天）；get 的
/// key = `summary` | `daily` | `models` | `records`（records 支持
/// conversationId/directoryId/limit/offset）。不支持 set/delete。
const SCOPE_USAGE: &str = "usage";

/// DB-backed 集中开关域：把 system_settings 里的零散开关集中暴露。
/// key = `liteMode` | `autoFormat` | `toolCorrection` | `terminal` | `proxyBrowser` |
/// `imageLibraryDir` | `blockedPatterns` | `yoloMode`（只读）。terminal/proxyBrowser 为白名单字段
/// merge；blockedPatterns 的写入在 tools/call.rs 路由到渲染端（JS 正则校验）；yoloMode 故意只读。
const SCOPE_APP_SETTINGS: &str = "appSettings";

/// DB-backed 单例域：隐私过滤设置（system_settings.privacy_settings）。
/// key = `settings`；`value={enabled?, mode?("local"|"api"), api?:{url?, apiKey?, model?},
/// toolResults?:{tools?:[...]}, disabledRules?:[...], customRules?/upsertCustomRules?/removeCustomRules?}`，
/// apiKey 读取掩码、写入空/省略保留旧值；不支持 delete。
const SCOPE_PRIVACY: &str = "privacy";

/// 代码库索引配置：projectId 非空 = 项目级三态开关（key=`scope`，null 表示继承
/// 全局）；显式 `""` = 全局（key=`settings` 白名单 merge，含选中的嵌入/重排模型 id；
/// key=`embeddingModels`/`rerankingModels` 为全局模型列表，密钥掩码）。改嵌入模型后需重建索引。
const SCOPE_CODEBASE: &str = "codebase";

/// DB-backed 单例域：键盘快捷键（12 个动作，稀疏 merge；读取附带键位冲突组）。
/// key = `settings`；value=`{动作名: {key?, enabled?, foregroundOnly?}}`；不支持 delete。
const SCOPE_KEYBOARD_SHORTCUTS: &str = "keyboardShortcuts";

/// DB-backed 域：工作区清单与项目分组。key=`directories`（读；set action=create 路由到渲染端建项目）/
/// `collections`（读写，action 分发：create/rename/move/reorder/removeMember）/
/// `collection:<collectionId>`（读；config-delete 删分组需 confirmed）。
const SCOPE_WORKSPACE: &str = "workspace";

/// DB-backed 域：自定义斜杠命令（custom_commands 表，与「设置 → 自定义命令」同源）。
/// key = commandId（`"new"` 表示新建，也可用命令名定位）；value =
/// `{name?, commandType?("prompt"|"bash"), content?, description?, enabled?, scope?}`；
/// projectId 非空 = 项目级（会话内自动注入），显式 `""` = 全局；delete 需 confirmed。
const SCOPE_CUSTOM_COMMANDS: &str = "customCommands";

/// DB-backed 单例域：流式指示器（主题设置 streamCursor）。key = `settings`；
/// value = `{iconType?, lucideName?, iconSize?, sourcePath?, script?}`；delete 复位为圆点。
const SCOPE_STREAM_CURSOR: &str = "streamCursor";

/// DB-backed 项目级域：当前项目备忘录（memos 表）。key = memoId / "new"。
const SCOPE_MEMOS: &str = "memos";

/// config-list/get/set/delete 暴露的 scope 枚举（文件域 SCOPES + DB / 委托 /
/// 只读域，与 execute_* 的实际分发逻辑保持一致）。
const CONFIG_SCOPE_ENUM: &[&str] = &[
    "settings",
    "snowcfg",
    "proxy",
    "app",
    "custom-headers",
    "system-prompt",
    "theme",
    "language",
    "permissions",
    "lsp-config",
    "buddy",
    "subAgents",
    "hooks",
    "skills",
    "imagegen",
    "personalization",
    "apiProfiles",
    "userscripts",
    "customHeaderSchemes",
    "mcpServers",
    "requestLogging",
    "scheduledTasks",
    "toolApproval",
    "usage",
    "appSettings",
    "privacy",
    "codebase",
    "keyboardShortcuts",
    "workspace",
    "plugins",
    "customCommands",
    "streamCursor",
    "memos",
];

/// ROLE.md 文件名（~/.snow/ROLE.md，与 personalizationHandlers.ts 约定一致）。
const ROLE_FILE_NAME: &str = "ROLE.md";
/// personalization scope 的唯一定义键。
const PERSONALIZATION_ROLE_KEY: &str = "role";
/// config-list personalization 返回的预览长度（避免全文进入上下文）。
const ROLE_PREVIEW_LEN: usize = 300;

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
        value_type: ValueType::String,
        sensitive: false,
    },
    KeySpec {
        key: "responsesWebSocket",
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

        // 模型兼容兜底：`value` 在 schema 中没有 type 声明（可能是对象 / 数组 /
        // 布尔 / 数字 / 字符串），部分模型会把对象、数组、布尔值先序列化成 JSON
        // 字符串再传入（如 value="{\"fontSize\": 14}" 或 value="true"）。这里按
        // 目标 scope/key 的期望类型把可解析的字符串还原为真实 JSON 值，消除
        // 「编码方式」导致的必然失败；还原后仍走原有严格类型校验，不放宽约束。
        if tool_name == TOOL_SET {
            let decoded = match (
                args.get("scope").and_then(Value::as_str),
                args.get("key").and_then(Value::as_str),
                args.get("value").and_then(Value::as_str),
            ) {
                (Some(scope), Some(key), Some(raw)) => unwrap_stringified_value(scope, key, raw),
                _ => None,
            };
            if let Some(decoded) = decoded {
                args["value"] = decoded;
            }
        }

        // 破坏性操作统一二次确认：config-delete（任何 scope，含 imagegen 全量
        // clear all channels / uninstall skills) must carry `confirmed: true`,
        // 而该参数只有在调用方先通过 `user-interaction` 的 `askUserQuestion`
        // 获得用户明确同意后才会带上；未确认一律拒绝，防止误删。
        if tool_name == TOOL_DELETE {
            require_delete_confirmation(&args)?;
        }

        // skills scope（能力委托给 SkillsConfigService）：需要 async 能力
        // （GitHub 下载等），因此在 spawn_blocking 之外直接分发。
        let result = if args.get("scope").and_then(Value::as_str) == Some(SCOPE_SKILLS) {
            self.execute_skills_scope(&tool_name, &args).await?
        } else if args.get("scope").and_then(Value::as_str) == Some(SCOPE_IMAGEGEN) {
            imagegen_scope::execute_imagegen_scope(&tool_name, &args)?
        } else if args.get("scope").and_then(Value::as_str) == Some(SCOPE_LSP_CONFIG) {
            lsp_config_scope::execute_lsp_config_scope(&tool_name, &args)?
        } else if args.get("scope").and_then(Value::as_str) == Some(SCOPE_PERSONALIZATION) {
            personalization_scope::execute_personalization_scope(&tool_name, &args)?
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
                    format!("HOST_OPERATION_FAILED: Config service task failed: {error}"),
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

    /// 脱敏 `{键: 值}` 对象中的全部值（键名保留），与 DB 域 `mcpServers`
    /// 的 env/headers 脱敏语义保持一致：非空字符串保留首尾各 4 字符，
    /// null 显示 `****`，其余类型原样保留（端口号等非秘密配置仍可读）。
    fn masked_secret_pairs(pairs: &Map<String, Value>) -> Value {
        let mut masked = Map::new();
        for (key, value) in pairs {
            let masked_value = match value {
                Value::String(text) if !text.trim().is_empty() => Self::mask_value(value),
                Value::Null => json!("****"),
                other => other.clone(),
            };
            masked.insert(key.clone(), masked_value);
        }
        Value::Object(masked)
    }

    /// `mcpServers` 形态脱敏：仅脱敏每个服务器条目的 `env` / `headers` 值，
    /// 服务器名与 type/url/command/args/enabled 等非敏感字段保持原样。
    /// `settings.mcpServers`（Snow CLI 同步源）与项目级 mcpServers 都可能
    /// 含 Authorization / API Key，读取路径必须与 DB 域 `mcpServers` 一致脱敏，
    /// 否则会违反本服务「plaintext is never returned」的安全承诺。
    fn mask_mcp_servers_value(value: &Value) -> Value {
        let Some(servers) = value.as_object() else {
            return Self::mask_value(value);
        };
        let mut masked_servers = Map::new();
        for (name, entry) in servers {
            let Some(fields) = entry.as_object() else {
                masked_servers.insert(name.clone(), Self::mask_value(entry));
                continue;
            };
            let mut masked_fields = fields.clone();
            for field in ["env", "headers"] {
                if let Some(Value::Object(pairs)) = fields.get(field) {
                    masked_fields.insert(field.to_string(), Self::masked_secret_pairs(pairs));
                }
            }
            masked_servers.insert(name.clone(), Value::Object(masked_fields));
        }
        Value::Object(masked_servers)
    }

    /// 解析 `{键: 值}` JSON 字符串并脱敏全部值（键名保留），
    /// 解析失败返回空对象。用于项目级 mcpServers 的 env/headers 读取。
    fn masked_json_pairs(json_text: &str) -> Value {
        let parsed = serde_json::from_str::<Value>(json_text).unwrap_or_else(|_| json!({}));
        match parsed.as_object() {
            Some(pairs) => Self::masked_secret_pairs(pairs),
            None => json!({}),
        }
    }

    /// 值是否满足给定类型（字符串 / 布尔 / 整数 / 数字 / 对象 / 数组）。
    fn value_matches_type(value: &Value, value_type: ValueType) -> bool {
        match value_type {
            ValueType::String => value.is_string(),
            ValueType::Bool => value.is_boolean(),
            ValueType::Int => value.is_i64() || value.is_u64(),
            ValueType::Number => value.is_f64() || value.is_i64() || value.is_u64(),
            ValueType::Object => value.is_object(),
            ValueType::Array => value.is_array(),
        }
    }

    /// 校验值的类型与结构（写前检查）。
    fn validate_value(key_spec: &KeySpec, value: &Value) -> napi::Result<()> {
        if !Self::value_matches_type(value, key_spec.value_type) {
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
    pub(crate) fn validate_lsp_servers(value: &Value) -> napi::Result<()> {
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
            // 配置写入后只失效这台服务器的工具发现缓存（其余服务器保持命中）。
            crate::mcp::external::invalidate_server_discovery_cache(&input.server_id);
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
                crate::mcp::external::invalidate_server_discovery_cache(&item.server_id);
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
                crate::mcp::external::invalidate_server_discovery_cache(&item.server_id);
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
            if scope_name == SCOPE_API_PROFILES {
                return self.list_db_api_profiles();
            }
            if scope_name == SCOPE_USERSCRIPTS {
                return userscripts_scope::list_userscripts(db_path_or_error(&self.db_path)?);
            }
            if scope_name == SCOPE_CUSTOM_HEADER_SCHEMES {
                return self.list_db_custom_header_schemes();
            }
            if scope_name == SCOPE_MCP_SERVERS {
                return mcp_servers_scope::execute_mcp_servers_scope(
                    TOOL_LIST,
                    args,
                    db_path_or_error(&self.db_path)?,
                    project_id.as_deref(),
                );
            }
            if scope_name == SCOPE_REQUEST_LOGGING {
                return request_logging_scope::execute_request_logging_scope(
                    TOOL_LIST,
                    args,
                    db_path_or_error(&self.db_path)?,
                );
            }
            if scope_name == SCOPE_SCHEDULED_TASKS {
                return scheduled_tasks_scope::execute_scheduled_tasks_scope(
                    TOOL_LIST,
                    args,
                    db_path_or_error(&self.db_path)?,
                );
            }
            if scope_name == SCOPE_TOOL_APPROVAL {
                return self.list_tool_approval(project_id);
            }
            if scope_name == SCOPE_USAGE {
                return usage_scope::execute_usage_scope(
                    TOOL_LIST,
                    args,
                    db_path_or_error(&self.db_path)?,
                );
            }
            if scope_name == SCOPE_APP_SETTINGS {
                return app_settings_scope::execute_app_settings_scope(
                    TOOL_LIST,
                    args,
                    db_path_or_error(&self.db_path)?,
                );
            }
            if scope_name == SCOPE_PRIVACY {
                return privacy_scope::execute_privacy_scope(
                    TOOL_LIST,
                    args,
                    db_path_or_error(&self.db_path)?,
                );
            }
            if scope_name == SCOPE_CODEBASE {
                return codebase_scope::execute_codebase_scope(
                    TOOL_LIST,
                    args,
                    db_path_or_error(&self.db_path)?,
                    project_id.as_deref(),
                );
            }
            if scope_name == SCOPE_KEYBOARD_SHORTCUTS {
                return keyboard_shortcuts_scope::execute_keyboard_shortcuts_scope(
                    TOOL_LIST,
                    args,
                    db_path_or_error(&self.db_path)?,
                );
            }
            if scope_name == SCOPE_WORKSPACE {
                return workspace_scope::execute_workspace_scope(
                    TOOL_LIST,
                    args,
                    db_path_or_error(&self.db_path)?,
                );
            }
            if scope_name == SCOPE_PLUGINS {
                return plugins_scope::list_plugins(db_path_or_error(&self.db_path)?);
            }
            if scope_name == SCOPE_CUSTOM_COMMANDS {
                return custom_commands_scope::execute_custom_commands_scope(
                    TOOL_LIST,
                    args,
                    db_path_or_error(&self.db_path)?,
                    project_id.as_deref(),
                );
            }
            if scope_name == SCOPE_STREAM_CURSOR {
                return stream_cursor_scope::execute_stream_cursor_scope(TOOL_LIST, args);
            }
            if scope_name == SCOPE_MEMOS {
                return memos_scope::execute_memos_scope(
                    TOOL_LIST,
                    args,
                    db_path_or_error(&self.db_path)?,
                    project_id.as_deref(),
                );
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
                            Some(value) if key_spec.key == "mcpServers" => {
                                Self::mask_mcp_servers_value(value)
                            }
                            Some(value) => value.clone(),
                            None => Value::Null,
                        }
                    }
                } else {
                    match config_root.get(key_spec.key) {
                        Some(value) if key_spec.sensitive => Self::mask_value(value),
                        Some(value) if key_spec.key == "mcpServers" => {
                            Self::mask_mcp_servers_value(value)
                        }
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
        if scope_name == SCOPE_API_PROFILES {
            return self.get_db_api_profile(key_name);
        }
        if scope_name == SCOPE_USERSCRIPTS {
            return userscripts_scope::get_userscript(db_path_or_error(&self.db_path)?, key_name);
        }
        if scope_name == SCOPE_CUSTOM_HEADER_SCHEMES {
            return self.get_db_custom_header_scheme(key_name);
        }
        if scope_name == SCOPE_MCP_SERVERS {
            return mcp_servers_scope::execute_mcp_servers_scope(
                TOOL_GET,
                args,
                db_path_or_error(&self.db_path)?,
                project_id.as_deref(),
            );
        }
        if scope_name == SCOPE_REQUEST_LOGGING {
            return request_logging_scope::execute_request_logging_scope(
                TOOL_GET,
                args,
                db_path_or_error(&self.db_path)?,
            );
        }
        if scope_name == SCOPE_SCHEDULED_TASKS {
            return scheduled_tasks_scope::execute_scheduled_tasks_scope(
                TOOL_GET,
                args,
                db_path_or_error(&self.db_path)?,
            );
        }
        if scope_name == SCOPE_TOOL_APPROVAL {
            return self.get_tool_approval(key_name, project_id);
        }
        if scope_name == SCOPE_USAGE {
            return usage_scope::execute_usage_scope(
                TOOL_GET,
                args,
                db_path_or_error(&self.db_path)?,
            );
        }
        if scope_name == SCOPE_APP_SETTINGS {
            return app_settings_scope::execute_app_settings_scope(
                TOOL_GET,
                args,
                db_path_or_error(&self.db_path)?,
            );
        }
        if scope_name == SCOPE_PRIVACY {
            return privacy_scope::execute_privacy_scope(
                TOOL_GET,
                args,
                db_path_or_error(&self.db_path)?,
            );
        }
        if scope_name == SCOPE_CODEBASE {
            return codebase_scope::execute_codebase_scope(
                TOOL_GET,
                args,
                db_path_or_error(&self.db_path)?,
                project_id.as_deref(),
            );
        }
        if scope_name == SCOPE_KEYBOARD_SHORTCUTS {
            return keyboard_shortcuts_scope::execute_keyboard_shortcuts_scope(
                TOOL_GET,
                args,
                db_path_or_error(&self.db_path)?,
            );
        }
        if scope_name == SCOPE_WORKSPACE {
            return workspace_scope::execute_workspace_scope(
                TOOL_GET,
                args,
                db_path_or_error(&self.db_path)?,
            );
        }
        if scope_name == SCOPE_PLUGINS {
            return plugins_scope::get_plugin(db_path_or_error(&self.db_path)?, key_name);
        }
        if scope_name == SCOPE_CUSTOM_COMMANDS {
            return custom_commands_scope::execute_custom_commands_scope(
                TOOL_GET,
                args,
                db_path_or_error(&self.db_path)?,
                project_id.as_deref(),
            );
        }
        if scope_name == SCOPE_STREAM_CURSOR {
            return stream_cursor_scope::execute_stream_cursor_scope(TOOL_GET, args);
        }
        if scope_name == SCOPE_MEMOS {
            return memos_scope::execute_memos_scope(
                TOOL_GET,
                args,
                db_path_or_error(&self.db_path)?,
                project_id.as_deref(),
            );
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
            Some(value) if key_spec.key == "mcpServers" => Self::mask_mcp_servers_value(value),
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
        if scope_name == SCOPE_API_PROFILES {
            return self.set_db_api_profile(key_name, &value);
        }
        if scope_name == SCOPE_USERSCRIPTS {
            return userscripts_scope::set_userscript(
                db_path_or_error(&self.db_path)?,
                key_name,
                &value,
            );
        }
        if scope_name == SCOPE_CUSTOM_HEADER_SCHEMES {
            return self.set_db_custom_header_scheme(key_name, &value);
        }
        if scope_name == SCOPE_MCP_SERVERS {
            return mcp_servers_scope::execute_mcp_servers_scope(
                TOOL_SET,
                args,
                db_path_or_error(&self.db_path)?,
                project_id.as_deref(),
            );
        }
        if scope_name == SCOPE_REQUEST_LOGGING {
            return request_logging_scope::execute_request_logging_scope(
                TOOL_SET,
                args,
                db_path_or_error(&self.db_path)?,
            );
        }
        if scope_name == SCOPE_SCHEDULED_TASKS {
            return scheduled_tasks_scope::execute_scheduled_tasks_scope(
                TOOL_SET,
                args,
                db_path_or_error(&self.db_path)?,
            );
        }
        if scope_name == SCOPE_TOOL_APPROVAL {
            return self.set_tool_approval(key_name, &value, project_id);
        }
        if scope_name == SCOPE_USAGE {
            return usage_scope::execute_usage_scope(
                TOOL_SET,
                args,
                db_path_or_error(&self.db_path)?,
            );
        }
        if scope_name == SCOPE_APP_SETTINGS {
            return app_settings_scope::execute_app_settings_scope(
                TOOL_SET,
                args,
                db_path_or_error(&self.db_path)?,
            );
        }
        if scope_name == SCOPE_PRIVACY {
            return privacy_scope::execute_privacy_scope(
                TOOL_SET,
                args,
                db_path_or_error(&self.db_path)?,
            );
        }
        if scope_name == SCOPE_CODEBASE {
            return codebase_scope::execute_codebase_scope(
                TOOL_SET,
                args,
                db_path_or_error(&self.db_path)?,
                project_id.as_deref(),
            );
        }
        if scope_name == SCOPE_KEYBOARD_SHORTCUTS {
            return keyboard_shortcuts_scope::execute_keyboard_shortcuts_scope(
                TOOL_SET,
                args,
                db_path_or_error(&self.db_path)?,
            );
        }
        if scope_name == SCOPE_WORKSPACE {
            return workspace_scope::execute_workspace_scope(
                TOOL_SET,
                args,
                db_path_or_error(&self.db_path)?,
            );
        }
        if scope_name == SCOPE_PLUGINS {
            return plugins_scope::set_plugin(db_path_or_error(&self.db_path)?, key_name, &value);
        }
        if scope_name == SCOPE_CUSTOM_COMMANDS {
            return custom_commands_scope::execute_custom_commands_scope(
                TOOL_SET,
                args,
                db_path_or_error(&self.db_path)?,
                project_id.as_deref(),
            );
        }
        if scope_name == SCOPE_STREAM_CURSOR {
            return stream_cursor_scope::execute_stream_cursor_scope(TOOL_SET, args);
        }
        if scope_name == SCOPE_MEMOS {
            return memos_scope::execute_memos_scope(
                TOOL_SET,
                args,
                db_path_or_error(&self.db_path)?,
                project_id.as_deref(),
            );
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
        } else if key_spec.key == "mcpServers" {
            Self::mask_mcp_servers_value(&value)
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
        if scope_name == SCOPE_API_PROFILES {
            return self.delete_db_api_profile(key_name);
        }
        if scope_name == SCOPE_USERSCRIPTS {
            return userscripts_scope::delete_userscript(
                db_path_or_error(&self.db_path)?,
                key_name,
            );
        }
        if scope_name == SCOPE_CUSTOM_HEADER_SCHEMES {
            return self.delete_db_custom_header_scheme(key_name);
        }
        if scope_name == SCOPE_MCP_SERVERS {
            return mcp_servers_scope::execute_mcp_servers_scope(
                TOOL_DELETE,
                args,
                db_path_or_error(&self.db_path)?,
                project_id.as_deref(),
            );
        }
        if scope_name == SCOPE_REQUEST_LOGGING {
            return request_logging_scope::execute_request_logging_scope(
                TOOL_DELETE,
                args,
                db_path_or_error(&self.db_path)?,
            );
        }
        if scope_name == SCOPE_SCHEDULED_TASKS {
            return scheduled_tasks_scope::execute_scheduled_tasks_scope(
                TOOL_DELETE,
                args,
                db_path_or_error(&self.db_path)?,
            );
        }
        if scope_name == SCOPE_TOOL_APPROVAL {
            return self.delete_tool_approval(key_name, project_id);
        }
        if scope_name == SCOPE_USAGE {
            return usage_scope::execute_usage_scope(
                TOOL_DELETE,
                args,
                db_path_or_error(&self.db_path)?,
            );
        }
        if scope_name == SCOPE_APP_SETTINGS {
            return app_settings_scope::execute_app_settings_scope(
                TOOL_DELETE,
                args,
                db_path_or_error(&self.db_path)?,
            );
        }
        if scope_name == SCOPE_PRIVACY {
            return privacy_scope::execute_privacy_scope(
                TOOL_DELETE,
                args,
                db_path_or_error(&self.db_path)?,
            );
        }
        if scope_name == SCOPE_CODEBASE {
            return codebase_scope::execute_codebase_scope(
                TOOL_DELETE,
                args,
                db_path_or_error(&self.db_path)?,
                project_id.as_deref(),
            );
        }
        if scope_name == SCOPE_KEYBOARD_SHORTCUTS {
            return keyboard_shortcuts_scope::execute_keyboard_shortcuts_scope(
                TOOL_DELETE,
                args,
                db_path_or_error(&self.db_path)?,
            );
        }
        if scope_name == SCOPE_WORKSPACE {
            return workspace_scope::execute_workspace_scope(
                TOOL_DELETE,
                args,
                db_path_or_error(&self.db_path)?,
            );
        }
        if scope_name == SCOPE_PLUGINS {
            return plugins_scope::delete_plugin(
                db_path_or_error(&self.db_path)?,
                key_name,
                args.get("value"),
            );
        }
        if scope_name == SCOPE_CUSTOM_COMMANDS {
            return custom_commands_scope::execute_custom_commands_scope(
                TOOL_DELETE,
                args,
                db_path_or_error(&self.db_path)?,
                project_id.as_deref(),
            );
        }
        if scope_name == SCOPE_STREAM_CURSOR {
            return stream_cursor_scope::execute_stream_cursor_scope(TOOL_DELETE, args);
        }
        if scope_name == SCOPE_MEMOS {
            return memos_scope::execute_memos_scope(
                TOOL_DELETE,
                args,
                db_path_or_error(&self.db_path)?,
                project_id.as_deref(),
            );
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
                    "env": Self::masked_json_pairs(&server.env_json),
                    "headers": Self::masked_json_pairs(&server.headers_json),
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
KEY RULES: (1) toolsJson is REQUIRED and must list at least one read tool (e.g. filesystem-read); an explicit toolsJson tool-name list additionally REQUIRES projectId (the agent becomes project-scoped); (2) toolsJson accepts a JSON string or an array of tool names that must exist in the project; explicitly listed tools stay available to the sub-agent even when the project disables them for the main conversation (the global tool blacklist and Lite mode still apply); the wildcard [\"*\"] is reserved for the built-in agent_general and reserved main-conversation tools (sub-agents-listSubAgents, sub-agents-continue, app-control-conversation, workflow-*) are rejected; (3) empty configProfile inherits the parent conversation's effective API profile and model at activation; a fixed configProfile uses model when provided, otherwise that profile's advancedModel; (4) project-scoped agents take priority over a same-id global agent at activation; (5) the built-in agent_general cannot be modified or deleted. The systemPrompt must be fully self-contained (no conversation history).
\
        Full guide: ~/.snowapp/docs/zh-CN/2-使用指南/5-配置Hooks与子代理.md (en: en/2-guides/5-configure-hooks-and-subagents.md)",
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

        // 工具校验（格式/通配符/保留名/项目内存在性）统一在存储层 upsert 中完成。

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
        Full guide: ~/.snowapp/docs/zh-CN/2-使用指南/5-配置Hooks与子代理.md (en: en/2-guides/5-configure-hooks-and-subagents.md)",
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

    // ---------------------------------------------------------------------
    // apiProfiles（API 档案，DB-backed，应用数据库 api_configs 表）
    //
    // 与 UI 完全同源、写入立即生效。key = profileName。
    // - list：全部档案（apiKey/visionApiKey 脱敏）+ 使用引导；
    // - get：单档案（脱敏；不存在返回 null）；
    // - set：upsert；value 字段为 merge 语义——已存在档案的未提供字段保留
    //   现值，新档案用默认值；apiKey/visionApiKey 未提供或为空一律保留旧值
    //   （新建则留空 → 无密钥档案，用户后补密钥）；isActive:true 切换生效
    //   档案；config_json 自动按 UI 规范组装，无需 agent 提供；
    // - delete：删除档案（复用统一 confirmed 确认；删除后如无 active 档案
    //   会自动指定一个 active，但不自动创建默认档案）。
    // ---------------------------------------------------------------------

    fn list_db_api_profiles(&self) -> napi::Result<Value> {
        let db_path = db_path_or_error(&self.db_path)?;
        let records = crate::storage::services::api_configs::list_api_configs(db_path)?;
        let items: Vec<Value> = records
            .iter()
            .map(|record| {
                json!({
                    "profileName": record.profile_name,
                    "displayName": record.display_name,
                    "isActive": record.is_active,
                    "baseUrl": record.base_url,
                    "baseUrlMode": record.base_url_mode,
                    "apiKey": imagegen_scope::mask_api_key(&record.api_key),
                    "requestMethod": record.request_method,
                    "advancedModel": record.advanced_model,
                    "basicModel": record.basic_model,
                    "supportsVision": record.supports_vision,
                    "visionBaseUrl": record.vision_base_url,
                    "visionBaseUrlMode": record.vision_base_url_mode,
                    "visionApiKey": imagegen_scope::mask_api_key(&record.vision_api_key),
                    "visionRequestMethod": record.vision_request_method,
                    "visionModel": record.vision_model,
                    "maxContextTokens": record.max_context_tokens,
                    "maxTokens": record.max_tokens,
                    "source": record.source,
                    "updatedAt": record.updated_at,
                })
            })
            .collect();
        Ok(json!({
            "scope": SCOPE_API_PROFILES,
            "items": items,
            "count": items.len(),
            "guidance": "API PROFILES - config-set scope=apiProfiles key=<profileName> value={...} creates or updates a profile in the app database (same as the UI; takes effect immediately).\n\
        KEY RULES: (1) an empty or omitted apiKey/visionApiKey ALWAYS keeps the existing key — create a keyless profile first (value={baseUrl, advancedModel, basicModel}), then ask the user for the key and fill it in with value={apiKey}; (2) switch the active profile with value={isActive:true} (the DB is the runtime source of truth and applies to NEW conversations - existing conversations keep the profile they bound at creation, and sub-agent sessions are strictly bound); unlike scope=app activeProfile which is only the CLI compatibility layer; (3) omitted fields keep current values for existing profiles and use defaults for new ones; configJson is generated automatically; (4) delete requires confirmed:true after askUserQuestion; (5) apiKey/visionApiKey are always masked in responses.\n\
        Full guide: ~/.snowapp/docs/zh-CN/2-使用指南/3-配置API密钥与模型.md (en: en/2-guides/3-configure-api-keys.md)",
        }))
    }

    fn get_db_api_profile(&self, profile_name: &str) -> napi::Result<Value> {
        let list = self.list_db_api_profiles()?;
        let items = list
            .get("items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let found = items
            .iter()
            .find(|item| item.get("profileName").and_then(Value::as_str) == Some(profile_name))
            .cloned();
        Ok(json!({
            "scope": SCOPE_API_PROFILES,
            "key": profile_name,
            "value": found.unwrap_or(Value::Null),
        }))
    }

    fn set_db_api_profile(&self, profile_name: &str, value: &Value) -> napi::Result<Value> {
        let db_path = db_path_or_error(&self.db_path)?;
        let profile_name = profile_name.trim().to_string();
        if profile_name.is_empty() {
            return Err(Error::new(
                Status::InvalidArg,
                "Profile name (config-set key) is required for the apiProfiles scope".to_string(),
            ));
        }
        if !value.is_object() {
            return Err(Error::new(
                Status::InvalidArg,
                "value must be an object of writable profile fields".to_string(),
            ));
        }

        // 现有记录作为 merge 基线（不存在的档案走默认值）。
        let existing = crate::storage::services::api_configs::list_api_configs(db_path)?
            .into_iter()
            .find(|record| record.profile_name == profile_name);

        // 文本字段：value 显式提供（trim 非空）→ 用之；否则保留现值；新档案用默认。
        let text_field = |key: &str, default: &str| -> String {
            if let Some(raw) = value.get(key).and_then(Value::as_str) {
                let trimmed = raw.trim().to_string();
                if !trimmed.is_empty() {
                    return trimmed;
                }
            }
            existing
                .as_ref()
                .map(|record| api_config_record_field(record, key))
                .filter(|current| !current.is_empty())
                .unwrap_or_else(|| default.to_string())
        };
        // 密钥字段：value 显式提供（含空串）→ 用之（空串保留旧值的语义由
        // upsert SQL 保证）；未提供 → 保留现值；新档案 → 空（无密钥建档）。
        let key_field = |key: &str| -> String {
            if let Some(raw) = value.get(key).and_then(Value::as_str) {
                return raw.trim().to_string();
            }
            existing
                .as_ref()
                .map(|record| match key {
                    "apiKey" => record.api_key.clone(),
                    "visionApiKey" => record.vision_api_key.clone(),
                    _ => String::new(),
                })
                .unwrap_or_default()
        };
        // 数值字段（Option<i32>）。i64/u64 超出 i32 范围时收敛到边界，
        // 避免静默截断成负数写入损坏配置。
        let int_field = |key: &str| -> Option<i32> {
            if let Some(field) = value.get(key) {
                // 显式 null = 清空该字段（retryBaseDelayMs 清空即回到指数退避）。
                if field.is_null() {
                    return None;
                }
                if let Some(number) = field.as_i64() {
                    return Some(number.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32);
                }
                if let Some(number) = field.as_u64() {
                    return Some(number.min(i32::MAX as u64) as i32);
                }
            }
            existing.as_ref().and_then(|record| match key {
                "maxContextTokens" => record.max_context_tokens,
                "maxTokens" => record.max_tokens,
                "streamIdleTimeoutSec" => record.stream_idle_timeout_sec,
                "autoCompressThreshold" => record.auto_compress_threshold,
                "maxRetries" => record.max_retries,
                "retryBaseDelayMs" => record.retry_base_delay_ms,
                _ => None,
            })
        };
        // 布尔字段。
        let bool_field = |key: &str, default: bool| -> bool {
            if let Some(field) = value.get(key) {
                if let Some(flag) = field.as_bool() {
                    return flag;
                }
                if let Some(text) = field.as_str() {
                    return matches!(text.trim().to_lowercase().as_str(), "true" | "1" | "yes");
                }
            }
            existing
                .as_ref()
                .map(|record| match key {
                    "isActive" => record.is_active,
                    "supportsVision" => record.supports_vision,
                    "enableAutoCompress" => record.enable_auto_compress,
                    _ => default,
                })
                .unwrap_or(default)
        };

        let base_url = text_field("baseUrl", "https://api.openai.com/v1");
        let base_url_mode = text_field("baseUrlMode", "auto");
        let request_method = text_field("requestMethod", "chat");
        let advanced_model = text_field("advancedModel", "");
        let basic_model = text_field("basicModel", "");
        let supports_vision = bool_field("supportsVision", true);
        let vision_base_url = text_field("visionBaseUrl", "");
        let vision_base_url_mode = text_field("visionBaseUrlMode", "auto");
        let vision_request_method = text_field("visionRequestMethod", &request_method);
        let vision_model = text_field("visionModel", "");
        let max_context_tokens = int_field("maxContextTokens");
        let max_tokens = int_field("maxTokens");
        let stream_idle_timeout_sec = int_field("streamIdleTimeoutSec");
        let enable_auto_compress = bool_field("enableAutoCompress", true);
        let auto_compress_threshold = int_field("autoCompressThreshold");
        let max_retries = int_field("maxRetries");
        let retry_base_delay_ms = int_field("retryBaseDelayMs");
        let partial_retry_max_chars = int_field("partialRetryMaxChars");
        let system_prompt_ids_json = text_field("systemPromptIdsJson", "");
        let custom_header_scheme_id = text_field("customHeaderSchemeId", "");
        let is_active = bool_field(
            "isActive",
            existing.as_ref().is_some_and(|record| record.is_active),
        );
        let source = text_field("source", "manual");

        // config_json 自动组装（与 UI normalizeApiConfigInput 的 manualConfig 规范一致）。
        let config_json = json!({
            "snowcfg": {
                "baseUrl": base_url,
                "baseUrlMode": base_url_mode,
                "apiKey": key_field("apiKey"),
                "requestMethod": request_method,
                "advancedModel": advanced_model,
                "basicModel": basic_model,
                "supportsVision": supports_vision,
                "visionBaseUrl": vision_base_url,
                "visionBaseUrlMode": vision_base_url_mode,
                "visionApiKey": key_field("visionApiKey"),
                "visionRequestMethod": vision_request_method,
                "visionModel": vision_model,
                "maxContextTokens": max_context_tokens,
                "maxTokens": max_tokens,
                "streamIdleTimeoutSec": stream_idle_timeout_sec,
                "enableAutoCompress": enable_auto_compress,
                "autoCompressThreshold": auto_compress_threshold,
                "maxRetries": max_retries,
                "retryDelayMs": retry_base_delay_ms,
                "partialRetryMaxChars": partial_retry_max_chars,
                "systemPromptIdsJson": system_prompt_ids_json,
                "customHeaderSchemeId": custom_header_scheme_id,
                "source": source,
            }
        })
        .to_string();

        let item = crate::storage::ApiConfigInput {
            profile_name: profile_name.clone(),
            previous_profile_name: None,
            display_name: text_field("displayName", &profile_name),
            is_active,
            base_url,
            base_url_mode,
            api_key: key_field("apiKey"),
            request_method,
            advanced_model,
            basic_model,
            supports_vision,
            vision_base_url,
            vision_base_url_mode,
            vision_api_key: key_field("visionApiKey"),
            vision_request_method,
            vision_model,
            max_context_tokens,
            max_tokens,
            stream_idle_timeout_sec,
            enable_auto_compress,
            auto_compress_threshold,
            max_retries,
            retry_base_delay_ms,
            partial_retry_max_chars,
            system_prompt_ids_json,
            custom_header_scheme_id,
            config_json,
            source,
        };
        // 写前备份现有 config_json（临时安全网，成功后清理）。
        let backup = match &existing {
            Some(record) => {
                Self::backup_db_value(&format!("apiProfiles.{profile_name}"), &record.config_json)?
            }
            None => None,
        };
        crate::storage::services::api_configs::upsert_api_config(db_path, &item)?;
        Self::cleanup_backup(backup);
        // 回读保存结果（密钥脱敏）。
        let saved = self.get_db_api_profile(&profile_name)?;
        Ok(json!({
            "scope": SCOPE_API_PROFILES,
            "key": profile_name,
            "saved": true,
            "value": saved.get("value").cloned().unwrap_or(Value::Null),
        }))
    }

    fn delete_db_api_profile(&self, profile_name: &str) -> napi::Result<Value> {
        let db_path = db_path_or_error(&self.db_path)?;
        let records = crate::storage::services::api_configs::list_api_configs(db_path)?;
        let existing = records
            .iter()
            .find(|record| record.profile_name == profile_name);
        let deleted = existing.is_some();
        let backup = match existing {
            Some(record) => {
                Self::backup_db_value(&format!("apiProfiles.{profile_name}"), &record.config_json)?
            }
            None => None,
        };
        crate::storage::services::api_configs::delete_api_config(db_path, profile_name)?;
        Self::cleanup_backup(backup);
        Ok(json!({
            "scope": SCOPE_API_PROFILES,
            "key": profile_name,
            "deleted": deleted,
        }))
    }

    // ---------------------------------------------------------------------
    // scope=customHeaderSchemes（DB-backed，应用数据库 custom_header_schemes 表）
    //
    // Snow App 自己管理自己 API 请求所用的自定义请求头（与 UI「自定义请求头」
    // 设置页同源）：写入立即进入运行时真相源——应用在每次请求前从该表解析
    // 方案并注入请求头，既不需要重启也不需要 Snow CLI 同步。
    // 与 scope=custom-headers（~/.snow/custom-headers.json，只是 Snow CLI 兼容的
    // 同步源文件，写入后不会被 App 自动加载）明确区分，避免「改了文件却没生效」。
    // ---------------------------------------------------------------------

    // ---------------------------------------------------------------------
    // scope=toolApproval
    //
    // 工具免确认白名单有两个真源：
    //   - 全局：~/.snow/permissions.json 的 alwaysApprovedTools（与 scope=permissions
    //     同一个文件，此处只读展示，写入仍走 permissions 域，避免两个写入口打架）；
    //   - 项目级：system_settings 的 project_tool_approval_scope_<blake3(projectId)>。
    // ---------------------------------------------------------------------

    /// 读取全局白名单（真源：~/.snow/permissions.json）。
    fn read_global_approved_tools(&self) -> napi::Result<Vec<String>> {
        let Some(scope) = Self::find_scope("permissions") else {
            return Ok(Vec::new());
        };
        let mut root = Self::read_json(scope)?;
        let config_root = Self::config_root(scope, &mut root)?;
        Ok(config_root
            .get("alwaysApprovedTools")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|name| !name.is_empty())
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default())
    }

    fn list_tool_approval(&self, project_id: Option<String>) -> napi::Result<Value> {
        match project_id {
            Some(project_id) => {
                let db_path = db_path_or_error(&self.db_path)?;
                let settings =
                    crate::storage::services::system_settings::get_tool_approval_project_scope_settings(
                        db_path,
                        &project_id,
                    )?;
                Ok(json!({
                    "scope": SCOPE_TOOL_APPROVAL,
                    "file": null,
                    "scoped": "project",
                    "projectId": project_id,
                    "keys": [{
                        "key": TOOL_APPROVAL_KEY,
                        "type": "array",
                        "sensitive": false,
                        "configured": true,
                        "value": settings.approved_tool_names,
                    }],
                }))
            }
            None => Ok(json!({
                "scope": SCOPE_TOOL_APPROVAL,
                "file": "permissions.json",
                "scoped": "global",
                "projectId": Value::Null,
                "note": GLOBAL_TOOL_APPROVAL_NOTE,
                "keys": [{
                    "key": TOOL_APPROVAL_KEY,
                    "type": "array",
                    "sensitive": false,
                    "configured": true,
                    "value": self.read_global_approved_tools()?,
                }],
            })),
        }
    }

    fn get_tool_approval(&self, key_name: &str, project_id: Option<String>) -> napi::Result<Value> {
        if key_name != TOOL_APPROVAL_KEY {
            return Err(Error::new(
                Status::InvalidArg,
                format!("toolApproval only defines the key \"{TOOL_APPROVAL_KEY}\""),
            ));
        }
        match project_id {
            Some(project_id) => {
                let db_path = db_path_or_error(&self.db_path)?;
                let tools =
                    crate::storage::services::system_settings::list_tool_approval_project_approved_tools(
                        db_path,
                        &project_id,
                    )?;
                Ok(json!({
                    "scope": SCOPE_TOOL_APPROVAL,
                    "key": TOOL_APPROVAL_KEY,
                    "scoped": "project",
                    "projectId": project_id,
                    "value": tools,
                }))
            }
            None => Ok(json!({
                "scope": SCOPE_TOOL_APPROVAL,
                "key": TOOL_APPROVAL_KEY,
                "scoped": "global",
                "projectId": Value::Null,
                "note": GLOBAL_TOOL_APPROVAL_NOTE,
                "value": self.read_global_approved_tools()?,
            })),
        }
    }

    fn set_tool_approval(
        &self,
        key_name: &str,
        value: &Value,
        project_id: Option<String>,
    ) -> napi::Result<Value> {
        if key_name != TOOL_APPROVAL_KEY {
            return Err(Error::new(
                Status::InvalidArg,
                format!("toolApproval only defines the key \"{TOOL_APPROVAL_KEY}\""),
            ));
        }
        let Some(project_id) = project_id else {
            return Err(Error::new(
                Status::InvalidArg,
                GLOBAL_TOOL_APPROVAL_NOTE.to_string(),
            ));
        };
        let db_path = db_path_or_error(&self.db_path)?;
        let current =
            crate::storage::services::system_settings::get_tool_approval_project_scope_settings(
                db_path,
                &project_id,
            )?
            .approved_tool_names;

        let (full, add, remove) = parse_tool_approval_value(value)?;
        let mut all = current.clone();

        if let Some(full) = full {
            let target = full.iter().cloned().collect::<BTreeSet<String>>();
            let to_add = target.difference(&current).cloned().collect::<Vec<_>>();
            let to_remove = current.difference(&target).cloned().collect::<Vec<_>>();
            if !to_add.is_empty() {
                crate::storage::services::system_settings::set_tool_approval_project_tools_approved(
                    db_path,
                    &project_id,
                    &to_add,
                    true,
                )?;
            }
            if !to_remove.is_empty() {
                crate::storage::services::system_settings::set_tool_approval_project_tools_approved(
                    db_path,
                    &project_id,
                    &to_remove,
                    false,
                )?;
            }
            all = target;
        }

        if !add.is_empty() {
            crate::storage::services::system_settings::set_tool_approval_project_tools_approved(
                db_path,
                &project_id,
                &add,
                true,
            )?;
            all.extend(add);
        }
        if !remove.is_empty() {
            crate::storage::services::system_settings::set_tool_approval_project_tools_approved(
                db_path,
                &project_id,
                &remove,
                false,
            )?;
            for name in &remove {
                all.remove(name);
            }
        }

        Ok(json!({
            "scope": SCOPE_TOOL_APPROVAL,
            "key": TOOL_APPROVAL_KEY,
            "scoped": "project",
            "projectId": project_id,
            "value": all.into_iter().collect::<Vec<_>>(),
        }))
    }

    fn delete_tool_approval(
        &self,
        key_name: &str,
        project_id: Option<String>,
    ) -> napi::Result<Value> {
        if key_name != TOOL_APPROVAL_KEY {
            return Err(Error::new(
                Status::InvalidArg,
                format!("toolApproval only defines the key \"{TOOL_APPROVAL_KEY}\""),
            ));
        }
        let Some(project_id) = project_id else {
            return Err(Error::new(
                Status::InvalidArg,
                GLOBAL_TOOL_APPROVAL_NOTE.to_string(),
            ));
        };
        let db_path = db_path_or_error(&self.db_path)?;
        let current =
            crate::storage::services::system_settings::get_tool_approval_project_scope_settings(
                db_path,
                &project_id,
            )?
            .approved_tool_names;

        if current.is_empty() {
            return Ok(json!({
                "scope": SCOPE_TOOL_APPROVAL,
                "key": TOOL_APPROVAL_KEY,
                "projectId": project_id,
                "deleted": false,
                "value": Vec::<String>::new(),
            }));
        }

        let names = current.iter().cloned().collect::<Vec<_>>();
        crate::storage::services::system_settings::set_tool_approval_project_tools_approved(
            db_path,
            &project_id,
            &names,
            false,
        )?;

        Ok(json!({
            "scope": SCOPE_TOOL_APPROVAL,
            "key": TOOL_APPROVAL_KEY,
            "projectId": project_id,
            "deleted": true,
            "clearedTools": names,
            "value": Vec::<String>::new(),
        }))
    }

    /// 列出全部请求头方案（值脱敏）+ 当前激活方案 + API 档案绑定概览。
    fn list_db_custom_header_schemes(&self) -> napi::Result<Value> {
        let db_path = db_path_or_error(&self.db_path)?;
        let records =
            crate::storage::services::custom_header_schemes::list_custom_header_schemes(db_path)?;
        let items: Vec<Value> = records
            .iter()
            .map(|record| {
                json!({
                    "schemeId": record.scheme_id,
                    "name": record.name,
                    "isActive": record.is_active,
                    "sortOrder": record.sort_order,
                    "headerNames": scheme_header_names(&record.headers_json),
                    "headers": masked_scheme_headers(&record.headers_json),
                    "updatedAt": record.updated_at,
                })
            })
            .collect();
        let active_scheme_id = records
            .iter()
            .find(|record| record.is_active)
            .map(|record| Value::String(record.scheme_id.clone()))
            .unwrap_or(Value::Null);
        Ok(json!({
            "scope": SCOPE_CUSTOM_HEADER_SCHEMES,
            "items": items,
            "count": items.len(),
            "activeSchemeId": active_scheme_id,
            "profiles": self.custom_header_profile_bindings()?,
            "guidance": "LIVE custom-header schemes of Snow App (app DB table custom_header_schemes; same source as the Settings > Custom headers panel) - writing here changes the headers Snow App actually sends, immediately.\n\
        WHICH SCHEME APPLIES: an API profile whose customHeaderSchemeId is set uses exactly that scheme (customHeaderSchemeId=\"__DISABLED__\" means no custom headers); a profile with an empty customHeaderSchemeId falls back to the ACTIVE scheme (activeSchemeId above). Bind a profile with config-set scope=apiProfiles key=<profileName> value={customHeaderSchemeId:\"<schemeId>\"}.\n\
        HOW TO EDIT: config-set scope=customHeaderSchemes key=<schemeId> value={name?, headers?, isActive?, sortOrder?} - headers is {headerName: value} MERGED into the existing headers (set a header to null to remove it); name is required when creating a scheme (key=\"new\" auto-generates the id); isActive:true activates this scheme exclusively; delete requires confirmed:true and reports affectedProfiles.\n\
        NOTE: scope=custom-headers only writes the Snow CLI sync file (~/.snow/custom-headers.json) and changes nothing until the user syncs it in the UI - use this scope to change what Snow App sends. Header values are masked on read (names are complete) and support the {{session_id}} placeholder.\n\
        Full guide: ~/.snowapp/docs/zh-CN/2-使用指南/19-个性化主题与快捷键.md",
        }))
    }

    /// 读取单个请求头方案（值脱敏）；不存在时返回 null。
    fn get_db_custom_header_scheme(&self, scheme_id: &str) -> napi::Result<Value> {
        let list = self.list_db_custom_header_schemes()?;
        let items = list
            .get("items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let found = items
            .iter()
            .find(|item| item.get("schemeId").and_then(Value::as_str) == Some(scheme_id))
            .cloned();
        Ok(json!({
            "scope": SCOPE_CUSTOM_HEADER_SCHEMES,
            "key": scheme_id,
            "value": found.unwrap_or(Value::Null),
        }))
    }

    /// API 档案与请求头方案的绑定概览（让调用方判断每个方案的实际生效范围）。
    fn custom_header_profile_bindings(&self) -> napi::Result<Value> {
        let db_path = db_path_or_error(&self.db_path)?;
        let records = crate::storage::services::api_configs::list_api_configs(db_path)?;
        let bindings: Vec<Value> = records
            .iter()
            .map(|record| {
                json!({
                    "profileName": record.profile_name,
                    "customHeaderSchemeId": record.custom_header_scheme_id,
                    "isActive": record.is_active,
                })
            })
            .collect();
        Ok(json!(bindings))
    }

    /// 显式绑定到指定方案的 API 档案名列表（删除方案时提示影响面）。
    fn custom_header_profiles_bound_to(&self, scheme_id: &str) -> napi::Result<Vec<String>> {
        let db_path = db_path_or_error(&self.db_path)?;
        let records = crate::storage::services::api_configs::list_api_configs(db_path)?;
        Ok(records
            .into_iter()
            .filter(|record| record.custom_header_scheme_id.trim() == scheme_id)
            .map(|record| record.profile_name)
            .collect())
    }

    /// 写入一个请求头方案（新建或更新）——直接写应用数据库，立即生效。
    ///
    /// key = schemeId；传 `""` 或 `"new"` 表示新建（自动生成 id，响应回显真实 id）。
    /// value = { name?, headers?, isActive?, sortOrder? }：
    /// - name：新建必填；已有方案缺省保留原名；
    /// - headers：{请求头名: 值}，merge 语义（只覆盖同名头），键值 `null` 表示删除该头；
    /// - isActive：true 会互斥激活本方案（其余方案自动停用）；新建且库中无方案时默认激活
    ///   （与 UI「第一个方案自动启用」一致）；
    /// - sortOrder：缺省保留现值，新建追加到末尾。
    fn set_db_custom_header_scheme(&self, key: &str, value: &Value) -> napi::Result<Value> {
        let db_path = db_path_or_error(&self.db_path)?;
        if !value.is_object() {
            return Err(Error::new(
                Status::InvalidArg,
                "value must be an object of writable scheme fields, e.g. value={name: \"My headers\", headers: {\"X-Trace\": \"on\"}}".to_string(),
            ));
        }

        let records =
            crate::storage::services::custom_header_schemes::list_custom_header_schemes(db_path)?;
        let requested = key.trim();
        let is_new = requested.is_empty() || requested == "new";
        let existing = if is_new {
            None
        } else {
            records.iter().find(|record| record.scheme_id == requested)
        };
        // key 指向不存在的方案时按新建处理：调用方显式给出的 id 会被采用。
        let scheme_id = match existing {
            Some(record) => record.scheme_id.clone(),
            None if is_new => {
                crate::storage::services::custom_header_schemes::next_scheme_id(&records)
            }
            None => requested.to_string(),
        };

        let name = match value
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty())
        {
            Some(name) => name.to_string(),
            None => existing.map(|record| record.name.clone()).ok_or_else(|| {
                Error::new(
                    Status::InvalidArg,
                    "name is required when creating a custom header scheme".to_string(),
                )
            })?,
        };

        // headers：merge 语义（JSON Merge Patch 风格，值 null 删除该请求头）。
        let mut headers = existing
            .map(|record| parse_scheme_headers(&record.headers_json))
            .unwrap_or_default();
        if let Some(raw_headers) = value.get("headers") {
            let object = raw_headers.as_object().ok_or_else(|| {
                Error::new(
                    Status::InvalidArg,
                    "headers must be an object of {headerName: value}; set a header to null to remove it".to_string(),
                )
            })?;
            for (header_name, header_value) in object {
                let header_name = header_name.trim();
                if header_name.is_empty() {
                    return Err(Error::new(
                        Status::InvalidArg,
                        "header name must not be empty".to_string(),
                    ));
                }
                match header_value {
                    Value::Null => {
                        headers.remove(header_name);
                    }
                    Value::String(text) => {
                        validate_scheme_header(header_name, text)?;
                        headers.insert(header_name.to_string(), Value::String(text.clone()));
                    }
                    _ => {
                        return Err(Error::new(
                            Status::InvalidArg,
                            format!(
                                "header \"{header_name}\" must be a string (or null to remove it)"
                            ),
                        ));
                    }
                }
            }
        }

        let is_active = match bool_arg(value.get("isActive")) {
            Some(flag) => flag,
            None => existing
                .map(|record| record.is_active)
                .unwrap_or(records.is_empty()),
        };

        let sort_order = match value.get("sortOrder") {
            Some(raw) => {
                let number = raw
                    .as_i64()
                    .or_else(|| {
                        raw.as_u64()
                            .map(|number| number.min(i32::MAX as u64) as i64)
                    })
                    .ok_or_else(|| {
                        Error::new(
                            Status::InvalidArg,
                            "sortOrder must be an integer".to_string(),
                        )
                    })?;
                number.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32
            }
            None => existing.map(|record| record.sort_order).unwrap_or_else(|| {
                records
                    .iter()
                    .map(|record| record.sort_order)
                    .max()
                    .unwrap_or(-1)
                    + 1
            }),
        };

        let headers_json = serde_json::to_string(&Value::Object(headers)).map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to serialize headers: {error}"),
            )
        })?;

        let item = crate::storage::CustomHeaderSchemeInput {
            scheme_id: scheme_id.clone(),
            name,
            headers_json,
            is_active,
            sort_order,
        };
        // 写前备份现有请求头（临时安全网，成功后清理）。
        let backup = match existing {
            Some(record) => Self::backup_db_value(
                &format!("{SCOPE_CUSTOM_HEADER_SCHEMES}.{scheme_id}"),
                &record.headers_json,
            )?,
            None => None,
        };
        crate::storage::services::custom_header_schemes::upsert_custom_header_scheme(
            db_path, &item,
        )?;
        Self::cleanup_backup(backup);

        // 回读保存结果（请求头值脱敏）。
        let saved = self.get_db_custom_header_scheme(&scheme_id)?;
        Ok(json!({
            "scope": SCOPE_CUSTOM_HEADER_SCHEMES,
            "key": scheme_id,
            "saved": true,
            "value": saved.get("value").cloned().unwrap_or(Value::Null),
        }))
    }

    /// 删除一个请求头方案（需 confirmed:true），并回报受影响（显式绑定）的 API 档案。
    fn delete_db_custom_header_scheme(&self, scheme_id: &str) -> napi::Result<Value> {
        let db_path = db_path_or_error(&self.db_path)?;
        let records =
            crate::storage::services::custom_header_schemes::list_custom_header_schemes(db_path)?;
        let existing = records.iter().find(|record| record.scheme_id == scheme_id);
        let affected_profiles = self.custom_header_profiles_bound_to(scheme_id)?;
        let backup = match existing {
            Some(record) => Self::backup_db_value(
                &format!("{SCOPE_CUSTOM_HEADER_SCHEMES}.{scheme_id}"),
                &record.headers_json,
            )?,
            None => None,
        };
        crate::storage::services::custom_header_schemes::delete_custom_header_scheme(
            db_path, scheme_id,
        )?;
        Self::cleanup_backup(backup);
        Ok(json!({
            "scope": SCOPE_CUSTOM_HEADER_SCHEMES,
            "key": scheme_id,
            "deleted": existing.is_some(),
            "affectedProfiles": affected_profiles,
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
/// skills 的 delete 是卸载技能；Snow App 日志为只读，使用 config-logs-read 查询。
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
            "PERMISSION_DENIED: config-delete is destructive and requires explicit user confirmation.\n\
             MANDATORY: before calling this tool, call the `askUserQuestion` tool from the\n\
             `user-interaction` server to show the user exactly which config will be deleted\n\
             (scope=`{scope_name}`, key=`{key_name}`{project_suffix}) and its impact, and wait\n\
             for their explicit approval. Only after the user confirms, retry this call with\n\
             `confirmed: true`. Note: for scope=`imagegen` this DELETES ALL image generation\n\
channels (not just the named key); for `skills` it uninstalls the skill. Snow App logs are read-only via `config-logs-read`.",
            project_suffix = project_id
                .as_deref()
                .map(|pid| format!(", projectId=`{pid}`"))
                .unwrap_or_default(),
        ),
    ))
}

/// apiProfiles 域 merge 语义的辅助：取 ApiConfigRecord 中某个文本字段的现值
/// （未映射的字段返回空串，调用方回退到默认值）。
fn api_config_record_field(record: &crate::storage::ApiConfigRecord, key: &str) -> String {
    match key {
        "displayName" => record.display_name.clone(),
        "baseUrl" => record.base_url.clone(),
        "baseUrlMode" => record.base_url_mode.clone(),
        "requestMethod" => record.request_method.clone(),
        "advancedModel" => record.advanced_model.clone(),
        "basicModel" => record.basic_model.clone(),
        "visionBaseUrl" => record.vision_base_url.clone(),
        "visionBaseUrlMode" => record.vision_base_url_mode.clone(),
        "visionRequestMethod" => record.vision_request_method.clone(),
        "visionModel" => record.vision_model.clone(),
        "systemPromptIdsJson" => record.system_prompt_ids_json.clone(),
        "customHeaderSchemeId" => record.custom_header_scheme_id.clone(),
        "source" => record.source.clone(),
        _ => String::new(),
    }
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

/// 解析请求头方案的 headers_json；非法 JSON 或非对象时返回空映射。
fn parse_scheme_headers(headers_json: &str) -> Map<String, Value> {
    match serde_json::from_str::<Value>(headers_json) {
        Ok(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

/// 方案内的请求头名称列表（值不外泄）。
fn scheme_header_names(headers_json: &str) -> Vec<String> {
    parse_scheme_headers(headers_json).keys().cloned().collect()
}

/// 方案内的请求头 `{名称: 掩码值}`（名称完整保留，值脱敏）。
fn masked_scheme_headers(headers_json: &str) -> Value {
    let masked: Map<String, Value> = parse_scheme_headers(headers_json)
        .into_iter()
        .map(|(name, value)| (name, ConfigService::mask_value(&value)))
        .collect();
    Value::Object(masked)
}

/// 校验自定义请求头名称/值：拒绝空名与会破坏 HTTP 请求的字符（名称的 `:` /
/// CR / LF，值的 CR / LF），避免写入后请求头注入或请求构造失败。
fn validate_scheme_header(name: &str, value: &str) -> napi::Result<()> {
    if name.contains(':') || name.chars().any(|ch| ch == '\r' || ch == '\n') {
        return Err(Error::new(
            Status::InvalidArg,
            format!("invalid header name \"{name}\" (must not contain ':', CR or LF)"),
        ));
    }
    if value.chars().any(|ch| ch == '\r' || ch == '\n') {
        return Err(Error::new(
            Status::InvalidArg,
            format!("invalid value for header \"{name}\" (must not contain CR or LF)"),
        ));
    }
    Ok(())
}

/// 宽松布尔解析（bool，或 "true"/"1"/"yes" 字符串），供 config-set 的开关字段使用。
fn bool_arg(value: Option<&Value>) -> Option<bool> {
    let value = value?;
    if let Some(flag) = value.as_bool() {
        return Some(flag);
    }
    value
        .as_str()
        .map(|text| matches!(text.trim().to_lowercase().as_str(), "true" | "1" | "yes"))
}

/// 该 scope/key 的期望值类型是否为字符串。此类键不做「字符串化 JSON」还原：
/// 其字面值本身可能恰好是合法 JSON（如路径 `"123"`），还原会改变用户意图。
fn expects_string_value(scope: &str, key: &str) -> bool {
    if let Some(spec) =
        ConfigService::find_scope(scope).and_then(|spec| ConfigService::find_key(spec, key))
    {
        return matches!(spec.value_type, ValueType::String);
    }
    // DB / 委托域中值为字符串的键（其余 DB 域的 value 均为对象或数组）。
    matches!(
        (scope, key),
        (SCOPE_APP_SETTINGS, "imageLibraryDir") | (SCOPE_PERSONALIZATION, "role")
    )
}

/// 把模型错误序列化成字符串的 JSON 值还原为真实值。
///
/// 工具 schema 的 `value` 参数没有 type 声明（它可能是对象 / 数组 / 布尔 /
/// 数字 / 字符串），部分模型在无类型约束下会把对象、数组、布尔值先序列化成
/// JSON 字符串再作为 `value` 传入（如 `value: "{\"fontSize\": 14}"` 或
/// `value: "true"`），使后续按真实类型的严格校验必然失败。这里只在该字符串
/// 能解析成「非字符串」的 JSON 时替换为解析结果（最多剥离两层字符串包裹），
/// 还原后仍走原有严格校验——只是纠正编码方式，不放宽校验。
fn unwrap_stringified_value(scope: &str, key: &str, raw: &str) -> Option<Value> {
    if expects_string_value(scope, key) {
        return None;
    }
    let mut text = raw.trim().to_string();
    for _ in 0..2 {
        match serde_json::from_str::<Value>(&text) {
            Ok(Value::String(inner)) => text = inner,
            Ok(other) => return Some(other),
            Err(_) => return None,
        }
    }
    None
}

/// toolApproval 域的唯一定义键。
const TOOL_APPROVAL_KEY: &str = "tools";
/// 全局工具授权的写入口提示：真源在 permissions.json，写入走 permissions 域。
const GLOBAL_TOOL_APPROVAL_NOTE: &str = "The global allow-list lives in ~/.snow/permissions.json (`alwaysApprovedTools`); this scope only shows it. Write the global list with scope=permissions key=alwaysApprovedTools. Pass a projectId (project sessions inject the current project automatically) to read or write the project-level allow-list.";

/// 解析 toolApproval 的 value：
/// 数组 = 全量替换；对象 = `{tools: [...]}` 全量替换，
/// 或 `{add: [...], remove: [...]}` 增量。
fn parse_tool_approval_value(
    value: &Value,
) -> napi::Result<(Option<Vec<String>>, Vec<String>, Vec<String>)> {
    let read_array = |items: &[Value], field: &str| -> napi::Result<Vec<String>> {
        let mut names = Vec::new();
        for item in items {
            let name = item
                .as_str()
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .ok_or_else(|| {
                    Error::new(
                        Status::InvalidArg,
                        format!("{field} must be an array of tool names"),
                    )
                })?;
            names.push(name.to_string());
        }
        Ok(names)
    };

    match value {
        Value::Array(items) => Ok((Some(read_array(items, "value")?), Vec::new(), Vec::new())),
        Value::Object(map) => {
            let full = match map.get("tools") {
                Some(Value::Array(items)) => Some(read_array(items, "tools")?),
                Some(_) => {
                    return Err(Error::new(
                        Status::InvalidArg,
                        "tools must be an array of tool names".to_string(),
                    ))
                }
                None => None,
            };
            let add = match map.get("add") {
                Some(Value::Array(items)) => read_array(items, "add")?,
                Some(_) => {
                    return Err(Error::new(
                        Status::InvalidArg,
                        "add must be an array of tool names".to_string(),
                    ))
                }
                None => Vec::new(),
            };
            let remove = match map.get("remove") {
                Some(Value::Array(items)) => read_array(items, "remove")?,
                Some(_) => {
                    return Err(Error::new(
                        Status::InvalidArg,
                        "remove must be an array of tool names".to_string(),
                    ))
                }
                None => Vec::new(),
            };
            if full.is_none() && add.is_empty() && remove.is_empty() {
                return Err(Error::new(
                    Status::InvalidArg,
                    "toolApproval value must be an array of tool names, {tools: [...]}, or {add: [...], remove: [...]}".to_string(),
                ));
            }
            Ok((full, add, remove))
        }
        _ => Err(Error::new(
            Status::InvalidArg,
            "toolApproval value must be an array of tool names, {tools: [...]}, or {add: [...], remove: [...]}"
                .to_string(),
        )),
    }
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
        SCOPE_SUB_AGENTS | SCOPE_HOOKS | SCOPE_SKILLS | SCOPE_LSP_CONFIG => true,
        // 项目级 MCP 服务器与项目级工具授权：缺省注入会话项目（显式 "" 走全局）。
        SCOPE_MCP_SERVERS | SCOPE_TOOL_APPROVAL | SCOPE_CODEBASE => true,
        SCOPE_CUSTOM_COMMANDS | SCOPE_MEMOS => true,
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
        let mut tools = vec![
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: TOOL_LIST.to_string(),
                description: "List configuration scopes and their keys; pass `scope` to inspect one scope (returns current values; sensitive keys masked).\nSCOPE REFERENCE:\n1. settings (~/.snow/settings.json): mcpServers, codebase, sensitiveCommands, yoloMode, goal, toolSearchEnabled, ...; MCP tool-level enable/disable (global/project) is managed in the MCP Settings panel (app database), not in settings.json.\n2. snowcfg (~/.snow/config.json): baseUrl, apiKey, advancedModel, basicModel, maxTokens, chatThinking, ...\n3. proxy (~/.snow/proxy-config.json): enabled, host, port, searchEngine, browserPath, browserDebugPort\n4. app (~/.snow/active-profile.json): activeProfile\n5. custom-headers (~/.snow/custom-headers.json): active, schemes (sensitive); this is the Snow CLI compatibility SYNC SOURCE only - writing this file does NOT change the request headers Snow App actually sends (the running app reads the custom_header_schemes table); use scope=customHeaderSchemes to edit the app's live request headers\n6. system-prompt (~/.snow/system-prompt.json): active, prompts (sensitive)\n7. theme (~/.snow/theme.json): theme, simpleMode, diffOpacity, toolIcons, customColors, ...\n8. language (~/.snow/language.json): language\n9. permissions (~/.snow/permissions.json): alwaysApprovedTools (global no-confirmation tool list; the UI authorization flow reads it and merges it with project-level approvals)\n10. lsp-config (~/.snow/lsp-config.json): schemaVersion, servers\n11. buddy (~/.snow/buddy.json): version, companion, muted\n12. subAgents (app DB): sub-agent configs, key=agentId; list returns items + CREATING guidance\n13. hooks (app DB): lifecycle hook configs, key=hookType; list returns items + CONFIGURING guidance\n14. imagegen (app DB): image generation channels + top-level maxConcurrentImages (1-8, default 4) and timeoutSecs (60-3600, default 300); list returns keys + note\n15. skills (delegated): skillId toggles / GitHub installs\n16. Snow App logs are read with the dedicated `config-logs-read` tool; `~/.snow/log/` belongs to Snow CLI and is not exposed here\n17. personalization (~/.snow/ROLE.md): global role/rules file (plain markdown, non-JSON), key=role; list returns length + preview, get returns the full rules text, set writes the whole file, delete removes it (restores defaults)\n18. apiProfiles (app DB): API profiles (api_configs table, same as the UI); key=profileName; list returns all profiles with masked apiKey/visionApiKey; set creates/updates a profile (empty/omitted apiKey keeps the existing key - create keyless profiles first, then fill the key; isActive:true switches the active profile; omitted fields keep current values); delete removes a profile (requires confirmed)\n19. userscripts (app DB): Tampermonkey-compatible userscripts (userscripts table + files under ~/.snowapp/browser-script/); key=scriptId (\"new\" creates one); RECOMMENDED: write the full source to a file with the filesystem server first (filesystem-create / filesystem-replace_edit), then install/update via config-set value={sourcePath: \"/abs/path/script.user.js\"} - the backend reads the file, avoiding huge tool args; small scripts can be inlined with value={raw: \"...\"}; value={enabled: bool} toggles a script, value={values: {...}} writes GM_* persisted values, value={deleteValues: [...]} removes GM values; get returns metadata + full source + GM values; delete removes a script (requires confirmed)\n20. customHeaderSchemes (app DB): Snow App's LIVE custom request headers (custom_header_schemes table, same as the Settings > Custom headers panel; takes effect immediately, no restart and no CLI sync needed). key=schemeId (\"new\" creates one and returns the generated id); set value={name?, headers?, isActive?, sortOrder?} writes a scheme (headers is {headerName: value} MERGED into the existing headers, null removes a header; name is required for a new scheme; isActive:true activates it exclusively, and an API profile with an empty customHeaderSchemeId then uses the active scheme - bind one with config-set scope=apiProfiles value={customHeaderSchemeId: \"<schemeId>\"}); delete removes a scheme and reports affectedProfiles (requires confirmed); header values are masked on read\n21. mcpServers (app DB): Snow App's LIVE MCP servers (mcp_server_configs table + project-level records) with tool-level enable/disable - no settings.json sync needed. projectId = project scope (project sessions inject the current project automatically; pass \"\" for global); key = server name (\"new\" creates one from value.name; renaming is not supported); set value = {name?, type?(\"stdio\"|\"sse\"|\"http\"), url?, command?, args?, env?, headers?, enabled?, timeoutMs?} MERGED into the existing server (stdio requires command, http/sse requires url; servers written here use source=manual so the Snow CLI sync never deletes them); value.tools={toolName:bool} or value.disabledTools=[...] flips tool-level switches; env/headers values are masked on read; delete removes a server (requires confirmed). Changes apply to the next tool discovery; a live MCP session may need an app restart/reconnect.\n22. requestLogging (app DB, singleton): API request-body logging switch used for debugging. key=\"settings\"; set value={enabled: bool, expiresInMinutes?: number} or {enabled: true, expiresAt: <epoch ms>} - enabling always requires an expiry (default 5 minutes, maximum 30 minutes) because the backend auto-resets the switch once the expiry passes and stops writing request bodies; enabling with enabled=false clears the expiry. Use `config-logs-read` for Snow App SQLite logs; delete is not supported (set enabled=false instead).\n23. scheduledTasks (app DB): scheduled task definitions, state and run history (scheduled_tasks table, same as the UI Scheduled Tasks panel). list returns a compact view (promptPreview, schedule, status, paused, nextRunAt, lastRunAt, runCount, lastError, skip counters, historyCount) and accepts directoryId filtering; get key=<taskId> returns the full record including the prompt and the last 20 runs. CREATE a task with config-set key=\"new\" value={name, prompt, schedule, id?, preScript?, apiProfile?, model?, workflow?, ...} - the renderer registers the timer immediately; pass workflow={contextMode?, nodes:[{id, label?, prompt, model?...}], edges?:[{source, target, delayMs?}]} instead of prompt to create a WORKFLOW scheduled task (DAG of AI nodes, validated); list returns createGuidance with the full field contract (schedule forms, workflow graph, preScript protocol, model overrides). MANAGE an existing task (current project or global only) with config-set key=<taskId>: value={name?, prompt?, schedule?, workflow?, apiProfile?, model?, preScript?, ..., paused?} (omitted fields are kept, null clears run overrides), value={action:\"runNow\"} or value={action:\"cancelRun\"} (stops a running workflow); DELETE with config-delete key=<taskId> confirmed=true; see manageGuidance.\n24. toolApproval: tool no-confirmation allow-list (authorization). Project sessions auto-inject projectId -> the project-level list is stored in system_settings; key=\"tools\"; set value = an array of tool names, {tools: [...]} (full replace), or {add: [...], remove: [...]}; delete clears the project list and requires confirmed. With projectId=\"\" the GLOBAL list is returned READ-ONLY - it lives in ~/.snow/permissions.json (alwaysApprovedTools) and must be written with scope=permissions key=alwaysApprovedTools.\n25. usage (app DB, READ-ONLY): token and request usage statistics (usage_records table, same as the UI Usage panel). list accepts since/until (YYYY-MM-DD or \"YYYY-MM-DD HH:MM:SS\", default the last 30 days) and returns summary + daily breakdown (<=90 rows) + per-model breakdown (<=20 rows); get key=summary|daily|models returns one of those, and key=records returns paginated details (conversationId, directoryId, limit<=100, offset); an optional `profile` argument filters every result by exact API profile name. set/delete are rejected - usage rows are written by the app itself.\n26. appSettings (app DB): centralized switches from system_settings. key=liteMode | autoFormat | toolCorrection | terminal | proxyBrowser | imageLibraryDir | blockedPatterns | yoloMode. liteMode disables the Browser / App Control / Terminal built-in MCP servers; autoFormat runs Prettier after file edits; toolCorrection retries a failed tool call after the basic model repairs its arguments; terminal and proxyBrowser are whitelist-merged JSON blobs (terminal: shellPath, fontFamily, fontSize, fontWeight, lineHeight; proxyBrowser: enabled, host, port, browserPath, browserDebugPort, searchEngine); blockedPatterns = global site-blocking regex list used by web search / page fetching (JavaScript regex strings; set value = an array (full replace) or {add: [...]} | {remove: [...]} | {replace: [...]}; add skips empty values and exact duplicates, remove deletes exact strings, invalid regex is rejected); imageLibraryDir accepts an empty string to restore the default directory; yoloMode is READ-ONLY (only the user can change it in the UI, so an agent can never silently disable tool confirmation). delete is not supported.\n27. privacy (app DB, singleton): privacy filtering. key=settings; set value={enabled?, mode?(\"local\"|\"api\"), api?:{url?, apiKey?, model?}, toolResults?:{tools?:[...]}, disabledRules?:[...]} MERGED into the stored settings; apiKey is masked on read and an empty/omitted apiKey keeps the existing secret; toolResults.tools replaces the list (any MCP tool full name); disabledRules replaces the list of switched-off local masking rule ids (valid ids are returned as availableRules on read). CUSTOM RULES (user-defined regex masking, applied to tool results in both local and api mode): customRules=[{id?, name, pattern, group?, replacement?, enabled?}] replaces the whole list; upsertCustomRules=[...] updates rules matched by id (then name) and appends new ones (omitted fields keep current values; new rules default enabled=true); removeCustomRules=[idOrName,...] deletes rules. pattern is Rust regex syntax (use (?i) for case-insensitive, no look-around); group masks only that capture group (default 0 = whole match); replacement is literal text (empty = mask every character with *). Invalid regex is rejected. Read responses include customRules and customRuleFormat. Enabling routes tool results through the filter (local or remote). No delete (set enabled=false).\n28. codebase: index configuration. projectId non-empty = project scope (key=scope, value={enabled?, enableAgentReview?, enableReranking?} stored as three-state overrides; an unset field follows the global default); projectId=\"\" = global (key=settings: embeddingModelId / rerankingModelId (the selected entries of the global embedding / reranking model lists; empty = none) plus rerankingTopN/chunking*/batch*/agentReviewModelId (the decision model selected for agent review; empty means the basic LLM model; the models themselves live in the decision_models table and are edited in the API settings > Decision models tab; deleting a model clears every reference to it), agentReviewRelevanceThreshold (0.0-1.0 probability that switches the decision model review from binary choice to predicate/noul probability filtering; null or missing = binary) etc., whitelist-merged; key=embeddingModels / rerankingModels: the global model lists (embedding_models / reranking_models tables) shared with API settings > Embedding models / Reranking models (apiKey masked on read; set value={upsert?: [{id?, name?, modelName, baseUrl, apiKey, embeddingType?, dimensions?, contextLength?, enabled?}], remove?: [idOrName]}, upsert matches by id then name, empty apiKey keeps the stored key, removing a selected model clears the selection; see modelsGuidance in the list response)). Changing the selected embedding model or its model/baseUrl/dimensions/key requires rebuilding the index before existing files use the new configuration. No delete.\n29. keyboardShortcuts (app DB, singleton): key=settings; set value={action: {key?, enabled?, foregroundOnly?}} SPARSE-MERGED (only the actions you pass change). Actions: cancelSession, openSearch, openMemo, openTodo, cycleProject, openProjectExplorer, cycleApiProfile, toggleWindow, togglePet, focusInput, toggleSidebar, toggleRightPanel. Read responses include `conflicts` (the same key bound to several enabled actions). The renderer registers shortcuts after reading this setting, so the UI may need a settings-page reopen or app restart. No delete.\n30. workspace (app DB): workspaces and project groups. key=directories (read: directoryId, name, path, kind, isActive, sortOrder, pathState; set value={action:\"create\", name, parentPath?} creates a project folder on disk and makes it the active project - omit parentPath to let the user pick the save location); key=collections (read/write; set value={action:\"create\", name} | {action:\"rename\", collectionId, name} | {action:\"move\", collectionId, directoryId, orderedMemberIds?} | {action:\"reorder\", collectionId, orderedMemberIds} | {action:\"removeMember\", collectionId, directoryId}); key=collection:<collectionId> reads one group and config-delete removes it (requires confirmed). Deleting/relocating projects stays in the UI.\n31. plugins (app DB + filesystem): Snow App plugin packages (app_plugins table + one folder per plugin under ~/.snowapp/plugins/<pluginId>/). key=pluginId (\"new\" for installs - the id in plugin.json wins); list returns items + pluginsDirectory + INSTALL guidance; set value={sourceDir: \"<abs folder path>\"} installs or replaces a plugin folder (write plugin.json plus the entry file with the filesystem server first), {sourcePath: \"<abs path to plugin.json or the folder>\"} behaves the same, {rescan: true} reloads plugin.json from the installed folder after hand edits, {enabled: bool} toggles it; delete uninstalls a plugin (requires confirmed) and deletes its folder unless value={deleteFiles: false}. Installed plugins show up in the sidebar Plugins panel, which reloads its list when opened. Plugin metadata: the 35 app metadata domains a plugin may read (parameters, return fields, privacy scopes, live vs polled) are documented in ~/.snowapp/docs/zh-CN/3-参考手册/6-插件元数据域参考.md (en: en/3-reference/6-plugin-metadata-domains.md).\n32. customCommands (app DB): user-defined slash commands offered in the chat input as /<name> (custom_commands table, same as the Settings > Custom commands panel). key = commandId (\"new\" creates one and returns the generated id; a command name also works as key); set value = {name, commandType: \"prompt\"|\"bash\", content, description?, enabled?, scope?} - commandType \"prompt\" sends content as a user message when the user runs /<name> ($ARGUMENTS is replaced by the text typed after the command, or appended when the placeholder is absent), \"bash\" runs content in a right-panel terminal tab of the project directory; project sessions auto-inject projectId, so key=\"new\" creates a PROJECT command (a project command shadows a same-named global one) - pass projectId=\"\" or value={scope: \"global\"} for a command that applies everywhere; the built-in names (clear, changes, memory, mcp, permissions, role, sensitive, skills, codebase, review, compact, custom, help) are rejected; list returns metadata + contentPreview, get returns the full content, delete removes one command (requires confirmed)\n33. streamCursor (app DB, singleton): the chat streaming indicator from Settings > Theme (same source as the UI). key=settings; set value={iconType?: dot|lucide|snowbot|custom|image|canvas, lucideName?, iconSize? (8-48), sourcePath? (absolute path to an .svg / any image incl. GIF / .js drawing script; copied into ~/.snowapp/stream-cursors/), script? (inline canvas source)}; iconType=canvas runs a script that defines draw(ctx, size, t, dark) in a Worker - list/get return the full canvasContract including how to convert an HTML/canvas prototype; get also returns the current script source; delete resets to the pulsing dot and removes the asset file (requires confirmed). The UI updates immediately after a write.\n34. memos (app DB, project-scoped): notes of the CURRENT project's memo panel (projectId auto-injected; other projects are never visible). list returns every memo with full content; get key=<memoId> reads one, key=pending|done|all returns a filtered list; set key=\"new\" value={content} creates one (status pending); set key=<memoId> value={status?: \"pending\"|\"done\", content?} updates it (mark done after executing its content); delete key=<memoId> or comma-separated memoIds (requires confirmed; the whole batch is refused if any id is not in the current project; prefer status done when it may still be useful). The memo panel refreshes immediately.\nRULES: pass projectId to scope subAgents/hooks/skills listings to a specific project (omitted = auto-injects the CURRENT SESSION's projectId, so you get/configure the active project's settings; pass an empty string \"\" for global); every list response includes the current session's projectId as `currentProjectId` — read it to obtain the project id bound to the current conversation; sensitive values (apiKey, visionApiKey, custom-header schemes, system-prompt prompts, imagegen apiKey) are always masked."
                    .to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "scope": {
                            "type": "string",
"enum": CONFIG_SCOPE_ENUM,
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
                description: "Read the value of a configuration key. Sensitive keys (apiKey, visionApiKey) are always returned masked (e.g. sk-****abcd); this tool never exposes plaintext secrets. Returns null when the key is not configured. DB-backed scopes: subAgents (key=agentId) and hooks (key=hookType) read directly from the app database; apiProfiles (key=profileName) reads an API profile from the app database (apiKey/visionApiKey masked, null when the profile does not exist); pass optional `projectId` to read a project-scoped config (omitted = global). Snow App logs are read with `config-logs-read`; it returns current-conversation API request/response bodies with secret values redacted. Config does not expose Snow CLI log files. personalization (key=role): returns the full ~/.snow/ROLE.md rules text (null when the file does not exist). userscripts (key=scriptId): returns the script metadata + full source + GM values (null when the script does not exist). customHeaderSchemes (key=schemeId): reads one LIVE custom-header scheme from the app database (scheme metadata + masked header values; null when it does not exist).  mcpServers (key=server name or serverId, optional projectId): reads one LIVE MCP server (mcp_server_configs / project-level records; env and headers values masked) plus the scope tool state. requestLogging (key=settings): reads the request-logging switch, its expiry and remaining time. scheduledTasks (key=taskId): reads one scheduled task with its prompt and the last 20 runs. toolApproval (key=tools): reads the no-confirmation allow-list (project-level with a projectId, otherwise the global list from permissions.json). usage (key=summary|daily|models|records; optional since/until/profile): reads usage statistics (read-only scope; records also accept conversationId/directoryId/limit/offset). appSettings (key=liteMode|autoFormat|toolCorrection|terminal|proxyBrowser|imageLibraryDir|blockedPatterns|yoloMode): reads the centralized switches (yoloMode is read-only). privacy (key=settings): reads the privacy filter with the API key masked. codebase (key=settings for the global config, key=embeddingModels / rerankingModels for the global model lists, or key=scope with a projectId): reads the index configuration (selected embedding / reranking model ids, agent review decision model id), the model lists (apiKey masked) or the project-level overrides. keyboardShortcuts (key=settings): reads all 12 shortcut actions plus the conflict groups. workspace (key=directories|collections|collection:<id>): reads workspaces and project groups. plugins (key=pluginId): reads one installed plugin's metadata (id, name, description, version, renderMode, entry, panels, locales, styles, privacy, enabled, installPath, sourcePath; null when it does not exist). customCommands (key=commandId or command name, optional projectId): reads one custom slash command with its full content plus its scope/enabled/shadowed state (null when it does not exist); config-list scope=customCommands returns metadata + contentPreview for the global commands plus the current project's ones. streamCursor (key=settings): reads the streaming indicator (iconType, lucideName, svgPath, iconSize), the current canvas script source when iconType=canvas, and the canvasContract that explains how to write or convert a drawing script.Project-scoped settings: pass `projectId` to read settings.mcpServers / settings.sensitiveCommands from the project-scoped app database (other keys reject projectId).".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "scope": {
                            "type": "string",
"enum": CONFIG_SCOPE_ENUM,
                            "description": "Config scope name."
                        },
                        "key": {
                            "type": "string",
"description": "Key name within the scope (see config-list). For imagegen: a channel id/name or provider type (openai|gemini), or a global key (maxConcurrentImages / timeoutSecs). For customHeaderSchemes: a schemeId. For customCommands: a commandId or a command name."
                        },
                        "projectId": {
                            "type": "string",
                            "description": "Optional project id for project-scoped targets (subAgents/hooks/skills/customCommands/memos/settings.mcpServers/settings.sensitiveCommands); omitted = auto-injects the CURRENT SESSION's projectId (pass \"\" for global config)."
                        },
                    },
                    "required": ["scope", "key"],
                    "additionalProperties": false
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: TOOL_SET.to_string(),
                description: "Write a value for a configuration key (whitelisted scopes only; type-checked; auto-backup to ~/.snow/.config-backups as a temporary safety net before the write, removed after a successful write; atomic write).\nRULES:\n- settings.mcpServers: syncs into the app database on write and takes effect immediately (same diff semantics as the UI sync action). MCP tool-level enable/disable (global/project) is managed in the MCP Settings panel (app database), not in settings.json.\n- Other file-backed scopes (snowcfg/proxy/app/custom-headers/system-prompt/theme/language/permissions/lsp-config/buddy): changes may need an app restart or a UI re-save. personalization (key=role, value must be a string): replaces the whole ~/.snow/ROLE.md file (markdown text); takes effect in the next conversation.\n- DB-backed scopes (take effect immediately): subAgents (key=agentId, value={name, description?, systemPrompt?, toolsJson?, configProfile?, model?}; an explicit toolsJson tool list requires projectId, see the guidance from config-list scope=subAgents); hooks (key=hookType, value={rules:[...]}, see the guidance from config-list scope=hooks); apiProfiles (key=profileName, value={displayName?, baseUrl?, baseUrlMode?, apiKey?, requestMethod?, advancedModel?, basicModel?, supportsVision?, visionBaseUrl?, visionApiKey?, visionRequestMethod?, visionModel?, maxContextTokens?, maxTokens?, isActive?, ...} - creates or updates the profile in the app database (same as the UI); an empty or omitted apiKey/visionApiKey ALWAYS keeps the existing key, so you can create a keyless profile first and fill the key later; isActive:true switches the active profile immediately; omitted fields keep current values for existing profiles and use defaults for new ones; configJson is generated automatically); imagegen (value={channels:[...]} full replace, {<channelId>: {...}} per-channel merge keeping omitted fields, or a global field alone: {maxConcurrentImages: N} clamped to 1-8 / {timeoutSecs: N} clamped to 60-3600). A channel supports MULTIPLE image models via its `models` array (each item: {id, model, name?, defaultSize?, defaultQuality?, supportedRatios?, supportedResolutions?, supportedThinking?, customPrompt?, enabled?}); the channel's top-level `model` is the default primary. When merging with {<channelId>: {models:[...]}}, the models array is DEEP-merged by model id (only the fields you pass change; other models and their fields are preserved) - use {channels:[...]} if you need to fully replace the list.\nuserscripts (key=scriptId, value={sourcePath: \"<abs path>\"} RECOMMENDED - write the full source to a file with the filesystem server first, then pass the path here to avoid huge tool args; the backend reads the file, parses the // ==UserScript== metadata and writes the DB + file; value={raw: \"<full source>\"} is also supported for small scripts; value={enabled: bool} toggles it; value={values: {...}} writes GM_* persisted values; value={deleteValues: [...]} removes GM values).\n- Project-scoped: pass projectId for settings.mcpServers (full replace of {name: {type,url,command,args,env,headers,enabled,timeoutMs}}) or settings.sensitiveCommands (full replace of [{commandId, pattern, description, enabled}]); other scopes ignore projectId. customHeaderSchemes: key=schemeId (or \"new\" to create one and get the generated id back), value={name?, headers?, isActive?, sortOrder?} writes a request-header scheme STRAIGHT INTO the app database (same source as the Settings > Custom headers panel, effective immediately - use THIS scope instead of scope=custom-headers, which only writes the Snow CLI sync file ~/.snow/custom-headers.json and changes nothing until the user syncs it in the UI): headers is {headerName: value} MERGED into the existing headers (set a header to null to remove it); name is required when creating a scheme; isActive:true activates this scheme exclusively, so an API profile with an empty customHeaderSchemeId immediately uses it (bind one explicitly with scope=apiProfiles value={customHeaderSchemeId}); sortOrder defaults to last; header values are masked on read and support the {{session_id}} placeholder. mcpServers: key=server name (\"new\" creates one from value.name), value={name?, type?, url?, command?, args?, env?, headers?, enabled?, timeoutMs?} MERGED into the app database record (stdio needs command, http/sse need url; projectId selects the project scope; value.tools={toolName:bool} or value.disabledTools=[...] flips tool-level switches; env/headers are masked on read). requestLogging: key=settings, value={enabled: bool, expiresInMinutes?: number} - enabling requires an expiry (default 5 minutes, maximum 30 minutes) because the backend auto-resets the switch afterwards. toolApproval: key=tools (projectId required; project sessions inject it automatically), value = an array of tool names, {tools: [...]} (full replace), or {add: [...], remove: [...]}; the global list is written with scope=permissions key=alwaysApprovedTools. scheduledTasks: key=\"new\" creates a task (value={name, prompt, schedule, ...}, or value={name, schedule, workflow:{contextMode?, nodes, edges?}} for a workflow task; see createGuidance from config-list scope=scheduledTasks); key=<taskId> updates a task of the current project or a global task (value={fields to change..., paused?}; omitted fields are kept) or runs an action (value={action:\"runNow\"|\"cancelRun\"}), see manageGuidance. usage is a READ-ONLY scope and rejects set. appSettings: key=liteMode|autoFormat|toolCorrection (boolean), terminal|proxyBrowser (whitelist-merged objects), imageLibraryDir (string; empty restores the default), blockedPatterns (array full replace, or {add|remove|replace: [...]}) - yoloMode is read-only. privacy: key=settings (merge; an empty apiKey keeps the existing secret; custom regex masking rules via customRules (full replace) / upsertCustomRules (add or update by id/name) / removeCustomRules (ids or names)). codebase: key=settings (global, whitelist-merged; select models via embeddingModelId / rerankingModelId), key=embeddingModels / rerankingModels ({upsert?: [...], remove?: [...]}; an empty apiKey keeps the stored key) or key=scope (project-level overrides). keyboardShortcuts: key=settings, sparse-merged per action. workspace: key=collections with {action: create|rename|move|reorder|removeMember}; key=directories with {action:\"create\", name, parentPath?} creates a project (omit parentPath to let the user pick the folder). plugins (key=pluginId, \"new\" to install): value={sourceDir: \"<abs folder path>\"} RECOMMENDED - write the plugin folder (plugin.json + entry file + optional panels/locales/styles) with the filesystem server first, then pass the folder; the backend validates plugin.json, copies the folder to ~/.snowapp/plugins/<pluginId> (skips .git and node_modules, 128 MB limit) and registers it as enabled (installing over an existing plugin replaces it in place and keeps its enabled state). value={sourcePath: \"<abs path to plugin.json or the folder>\"} is accepted too; value={rescan: true} reloads plugin.json from the installed folder; value={enabled: bool} toggles the plugin. When the plugin needs app data, follow ~/.snowapp/docs/zh-CN/3-参考手册/6-插件元数据域参考.md (en: en/3-reference/6-plugin-metadata-domains.md) - it documents the 36 readable metadata domains, their fields, parameters and privacy scopes. customCommands (key=commandId, or \"new\" to create one): value={name, commandType: \"prompt\"|\"bash\", content, description?, enabled?, scope?} creates or updates a custom slash command in the app database (same as the Settings > Custom commands panel); omitted fields keep their current values, an existing command keeps its scope, and the built-in command names are rejected; project sessions auto-inject projectId, so key=\"new\" creates a project command - pass projectId=\"\" (or value={scope: \"global\"}) for a global one. The UI is notified after a successful write, so the chat input's / menu and the Settings > Custom commands panel refresh immediately. streamCursor (key=settings): value={iconType?, lucideName?, iconSize?, sourcePath?, script?} sets the chat streaming indicator; for HTML/canvas prototypes, read the canvasContract from config-get scope=streamCursor first, write a .js file that defines draw(ctx, size, t, dark) with the filesystem server, then pass {iconType: \"canvas\", sourcePath: \"<abs path>\"}; images/GIFs use {iconType: \"image\", sourcePath}, SVGs use {iconType: \"custom\", sourcePath}; the replaced asset file is deleted and the UI updates immediately.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "scope": {
                            "type": "string",
"enum": CONFIG_SCOPE_ENUM,
                            "description": "Config scope name."
                        },
                        "key": {
                            "type": "string",
"description": "Key name within the scope (see config-list). For imagegen: a channel id/name or provider type (openai|gemini), or the global key maxConcurrentImages. For customHeaderSchemes: a schemeId, or \"new\" to create one. For customCommands: a commandId (or a command name), or \"new\" to create one."
                        },
                        "value": {
"description": "New value; type must match the key schema (see config-list). ALWAYS pass the real JSON value (object / array / boolean / number / string) - NEVER a JSON-encoded string such as \"{\\\"fontSize\\\": 14}\", \"[\\\"a\\\"]\" or \"true\". subAgents/hooks/apiProfiles/userscripts/imagegen/customHeaderSchemes/customCommands require a JSON OBJECT here (e.g. userscripts: {sourcePath: \"C:/abs/path/script.user.js\"}; customHeaderSchemes: {name: \"My headers\", headers: {\"X-Trace\": \"on\"}}), not a string or path."
                        },
                        "projectId": {
                            "type": "string",
                            "description": "Optional project id for project-scoped targets (subAgents/hooks/skills/customCommands/memos/settings.mcpServers/settings.sensitiveCommands); omitted = auto-injects the CURRENT SESSION's projectId (pass \"\" for global config)."
                        }
                    },
                    "required": ["scope", "key", "value"],
                    "additionalProperties": false
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: TOOL_DELETE.to_string(),
                description: "Delete a configuration key (e.g. clear an apiKey). DESTRUCTIVE — REQUIRES EXPLICIT USER CONFIRMATION: before calling this tool you MUST call the `askUserQuestion` tool from the `user-interaction` server to show the user exactly which config will be deleted (scope, key, projectId) and its impact, then wait for their explicit approval; only then retry this call with `confirmed: true`. Calls without `confirmed: true` are rejected. Scope-specific semantics: `imagegen` DELETES ALL image generation channels (not just the named key — the whole image generation config is cleared); `skills` uninstalls the skill; `subAgents` deletes a sub-agent (built-in agent_general cannot be deleted); `hooks` deletes the hookType config; `apiProfiles` deletes an API profile (no default profile is auto-created; if no profile is active after the deletion, one remaining profile is activated automatically). `userscripts` deletes a userscript (DB row + ~/.snowapp/browser-script file). `customHeaderSchemes` deletes one request-header scheme from the app database (API profiles bound to it stop applying those headers; the response lists them as affectedProfiles). `personalization` deletes ~/.snow/ROLE.md (restores default rules). The current value is backed up before the write (temporary safety net) and the backup is removed after a successful write. Returns deleted=false when the key was not configured. Pass optional `projectId` to delete a project-scoped config (omitted = global). Project-scoped settings: projectId + settings.mcpServers clears all project MCP servers; projectId + settings.sensitiveCommands clears all project sensitive-command overrides. `mcpServers` deletes one LIVE MCP server (pass projectId for the project scope; requires confirmed; the response echoes the removed serverId). `toolApproval` clears the project-level no-confirmation allow-list (requires confirmed; the global list must be cleared with scope=permissions). `scheduledTasks` deletes one scheduled task and its run history (key=taskId; current project or global tasks only; requires confirmed). `usage` is a read-only scope and rejects delete; `requestLogging` has no delete (set enabled=false instead). `appSettings`, `privacy`, `codebase` and `keyboardShortcuts` do not support delete (write explicit values instead). `workspace` deletes a project group with key=\"collection:<collectionId>\" (requires confirmed; the response reports how many members were detached - projects themselves are never deleted here). `plugins` uninstalls a plugin: it removes the app_plugins row and deletes the plugin folder (requires confirmed); pass value={deleteFiles: false} to keep the folder on disk and only drop the registration. `customCommands` deletes one custom slash command (key=commandId or command name; requires confirmed; a project command needs the owning project's projectId - project sessions inject it automatically). `streamCursor` (key=settings) resets the streaming indicator to the pulsing dot and deletes its asset file (requires confirmed).".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "scope": {
                            "type": "string",
"enum": CONFIG_SCOPE_ENUM,
                            "description": "Config scope name."
                        },
                        "key": {
                            "type": "string",
                            "description": "Key name within the scope (see config-list). For imagegen: the whole image generation config is cleared regardless of this key. For customCommands: the commandId (or command name) to delete."
                        },
                        "value": {
                            "type": "object",
                            "description": "Optional delete options. For the plugins scope: {deleteFiles: false} keeps the plugin folder on disk and only removes the registration from the app database (default true deletes the folder as well)."
                        },
                        "confirmed": {
                            "type": "boolean",
                            "description": "MUST be true. Set it only after the user has explicitly approved the deletion via the `user-interaction` `askUserQuestion` tool; the deletion is rejected without user confirmation."
                        },
                        "projectId": {
                            "type": "string",
                            "description": "Optional project id for project-scoped targets (subAgents/hooks/skills/customCommands/memos/settings.mcpServers/settings.sensitiveCommands); omitted = auto-injects the CURRENT SESSION's projectId (pass \"\" for global config)."
                        }
                    },
                    "required": ["scope", "key", "confirmed"],
                    "additionalProperties": false
                }),
            },
        ];
        tools.extend(super::app_logs::AppLogsService::new().tools());
        tools
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
    CONFIG_SCOPE_ENUM.join(", ")
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
