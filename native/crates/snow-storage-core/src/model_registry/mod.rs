//! 模型注册表：嵌入 / 重排 / 决策模型各一张表（`embedding_models` /
//! `reranking_models` / `decision_models`），每行附带最近一次连接自检结果
//! （`health_*` 列，删除模型时随行清理）。
//!
//! 代码库设置、decision-evaluate 工具与敏感命令辅助只保存模型 id（表中的
//! `model_id`）；删除模型时 [`delete_model_with_connection`] 同步清空这些引用。

mod migration;

pub use self::migration::migrate_legacy_model_settings;

use std::path::Path;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::database;
use crate::system_settings::{
    invalidate_system_setting_cache, set_system_setting_with_connection,
};

pub const DEFAULT_EMBEDDING_TYPE: &str = "jina";
pub const DEFAULT_EMBEDDING_CONTEXT_LENGTH: i32 = 8192;
pub const DEFAULT_RERANKING_CONTEXT_LENGTH: i32 = 4096;

pub const DECISION_PROVIDER_TYPESAFE: &str = "typesafe";
pub const DECISION_PROVIDER_OPENAI: &str = "openai";
pub const DEFAULT_TYPESAFE_BASE_URL: &str = "https://api.typesafe.ai/v1";
pub const DEFAULT_OPENAI_BASE_URL: &str = "https://api.openai.com/v1";
pub const DEFAULT_TYPESAFE_MODEL: &str = "jev-latest";
pub const DEFAULT_TYPESAFE_NAME: &str = "Jev (TypeSafe)";
const BASE_URL_MODE_AUTO: &str = "auto";
const BASE_URL_MODE_CUSTOM: &str = "custom";

// 引用模型 id 的设置项（删除模型时清理）。
const CODEBASE_SETTING_CODE: &str = "codebase_settings";
const CODEBASE_SETTING_NAME: &str = "Codebase settings";
const DECISION_TOOL_MODEL_SETTING_CODE: &str = "decision_tool_model";
const DECISION_TOOL_MODEL_SETTING_NAME: &str = "Decision tool model";
const SENSITIVE_COMMAND_ASSIST_SETTING_CODE: &str = "sensitive_command_assist";
const SENSITIVE_COMMAND_ASSIST_SETTING_NAME: &str = "Sensitive command decision assist";

/// 三类模型共用的自检结果列（dimension 两列仅嵌入模型使用）。
const HEALTH_COLUMNS: &str = "health_ok INTEGER,
           health_http_status INTEGER,
           health_latency_ms INTEGER,
           health_endpoint TEXT,
           health_model TEXT,
           health_dimension INTEGER,
           health_expected_dimension INTEGER,
           health_error TEXT,
           health_tested_at INTEGER";

/// 注册表中的模型类别。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegisteredModelKind {
    Embedding,
    Reranking,
    Decision,
}

impl RegisteredModelKind {
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim() {
            "embedding" => Some(Self::Embedding),
            "reranking" => Some(Self::Reranking),
            "decision" => Some(Self::Decision),
            _ => None,
        }
    }

    fn table(self) -> &'static str {
        match self {
            Self::Embedding => "embedding_models",
            Self::Reranking => "reranking_models",
            Self::Decision => "decision_models",
        }
    }

    fn id_prefix(self) -> &'static str {
        match self {
            Self::Embedding => "em",
            Self::Reranking => "rm",
            Self::Decision => "dm",
        }
    }
}

/// 单个嵌入模型配置。
#[napi(object)]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct EmbeddingModelEntry {
    pub id: String,
    pub name: String,
    pub embedding_type: String,
    pub model_name: String,
    pub base_url: String,
    pub api_key: String,
    /// 0 = 不传 dimensions 参数。
    pub dimensions: i32,
    /// 单块最大输入 token；分块按其 80% 切分。
    pub context_length: i32,
    pub enabled: bool,
}

impl Default for EmbeddingModelEntry {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            embedding_type: DEFAULT_EMBEDDING_TYPE.to_string(),
            model_name: String::new(),
            base_url: String::new(),
            api_key: String::new(),
            dimensions: 0,
            context_length: DEFAULT_EMBEDDING_CONTEXT_LENGTH,
            enabled: true,
        }
    }
}

impl EmbeddingModelEntry {
    fn normalized(mut self) -> Self {
        self.id = self.id.trim().to_string();
        self.embedding_type = non_empty_or(&self.embedding_type, DEFAULT_EMBEDDING_TYPE);
        self.model_name = self.model_name.trim().to_string();
        self.name = non_empty_or(&self.name, &self.model_name);
        self.base_url = self.base_url.trim().to_string();
        self.api_key = self.api_key.trim().to_string();
        self.dimensions = self.dimensions.max(0);
        self.context_length = positive_or(self.context_length, DEFAULT_EMBEDDING_CONTEXT_LENGTH);
        self
    }
}

/// 单个重排模型配置。
#[napi(object)]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RerankingModelEntry {
    pub id: String,
    pub name: String,
    pub model_name: String,
    pub base_url: String,
    pub api_key: String,
    pub context_length: i32,
    pub enabled: bool,
}

impl Default for RerankingModelEntry {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            model_name: String::new(),
            base_url: String::new(),
            api_key: String::new(),
            context_length: DEFAULT_RERANKING_CONTEXT_LENGTH,
            enabled: true,
        }
    }
}

impl RerankingModelEntry {
    fn normalized(mut self) -> Self {
        self.id = self.id.trim().to_string();
        self.model_name = self.model_name.trim().to_string();
        self.name = non_empty_or(&self.name, &self.model_name);
        self.base_url = self.base_url.trim().to_string();
        self.api_key = self.api_key.trim().to_string();
        self.context_length = positive_or(self.context_length, DEFAULT_RERANKING_CONTEXT_LENGTH);
        self
    }
}

/// 单个决策模型配置（TypeSafe System One / OpenAI Decisions）。
#[napi(object)]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DecisionModelEntry {
    pub id: String,
    pub name: String,
    /// "typesafe" | "openai"。
    pub provider: String,
    pub base_url: String,
    /// "auto" | "custom"。
    pub base_url_mode: String,
    pub model: String,
    pub api_key: String,
    pub enabled: bool,
}

impl Default for DecisionModelEntry {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            provider: DECISION_PROVIDER_TYPESAFE.to_string(),
            base_url: String::new(),
            base_url_mode: BASE_URL_MODE_AUTO.to_string(),
            model: String::new(),
            api_key: String::new(),
            enabled: true,
        }
    }
}

impl DecisionModelEntry {
    fn normalized(mut self) -> Self {
        self.id = self.id.trim().to_string();
        self.provider = if self.provider.trim() == DECISION_PROVIDER_OPENAI {
            DECISION_PROVIDER_OPENAI.to_string()
        } else {
            DECISION_PROVIDER_TYPESAFE.to_string()
        };
        self.base_url_mode = if self.base_url_mode.trim() == BASE_URL_MODE_CUSTOM {
            BASE_URL_MODE_CUSTOM.to_string()
        } else {
            BASE_URL_MODE_AUTO.to_string()
        };
        self.model = self.model.trim().to_string();
        self.name = non_empty_or(&self.name, &self.model);
        self.base_url = self.base_url.trim().to_string();
        // 自动模式留空时写入 provider 默认端点（与前端展示一致）。
        if self.base_url.is_empty() && self.base_url_mode == BASE_URL_MODE_AUTO {
            self.base_url = if self.provider == DECISION_PROVIDER_OPENAI {
                DEFAULT_OPENAI_BASE_URL.to_string()
            } else {
                DEFAULT_TYPESAFE_BASE_URL.to_string()
            };
        }
        self.api_key = self.api_key.trim().to_string();
        self
    }
}

/// 一次连接自检的结果（持久化在模型表的 health_* 列）。
#[napi(object)]
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ModelConnectionTestResult {
    /// 检测对象：决策 / 嵌入 / 重排模型的条目 id。
    pub target_id: String,
    pub ok: bool,
    pub http_status: Option<u32>,
    pub latency_ms: f64,
    pub endpoint: String,
    pub model: String,
    /// 嵌入：实际返回的向量维度。
    pub dimension: Option<u32>,
    /// 嵌入：配置的向量维度（未指定时为空）。
    pub expected_dimension: Option<u32>,
    pub error: Option<String>,
    /// 检测时间（Unix 毫秒）。
    pub tested_at: f64,
}

/// 删除结果：`clearedReferences` 列出被清空的引用（如 `codebase.embeddingModelId`）。
#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct ModelDeleteResult {
    pub deleted: bool,
    pub cleared_references: Vec<String>,
}

fn non_empty_or(value: &str, fallback: &str) -> String {
    let value = value.trim();
    if value.is_empty() {
        fallback.trim().to_string()
    } else {
        value.to_string()
    }
}

fn positive_or(value: i32, fallback: i32) -> i32 {
    if value > 0 {
        value
    } else {
        fallback
    }
}

fn invalid(message: impl Into<String>) -> Error {
    Error::new(Status::InvalidArg, message.into())
}

pub(crate) fn new_model_id(kind: RegisteredModelKind) -> String {
    format!("{}-{}", kind.id_prefix(), database::create_snowflake_id())
}

/// 建表（幂等）；由 `create_schema` 在 post-schema 迁移之前调用。
pub fn ensure_model_tables(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(&format!(
        "CREATE TABLE IF NOT EXISTS embedding_models (
           id TEXT PRIMARY KEY NOT NULL,
           model_id TEXT NOT NULL UNIQUE,
           name TEXT NOT NULL DEFAULT '',
           embedding_type TEXT NOT NULL DEFAULT 'jina',
           model_name TEXT NOT NULL DEFAULT '',
           base_url TEXT NOT NULL DEFAULT '',
           api_key TEXT NOT NULL DEFAULT '',
           dimensions INTEGER NOT NULL DEFAULT 0,
           context_length INTEGER NOT NULL DEFAULT 8192,
           enabled INTEGER NOT NULL DEFAULT 1,
           sort_order INTEGER NOT NULL DEFAULT 0,
           {HEALTH_COLUMNS},
           created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
           updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
         );

         CREATE TABLE IF NOT EXISTS reranking_models (
           id TEXT PRIMARY KEY NOT NULL,
           model_id TEXT NOT NULL UNIQUE,
           name TEXT NOT NULL DEFAULT '',
           model_name TEXT NOT NULL DEFAULT '',
           base_url TEXT NOT NULL DEFAULT '',
           api_key TEXT NOT NULL DEFAULT '',
           context_length INTEGER NOT NULL DEFAULT 4096,
           enabled INTEGER NOT NULL DEFAULT 1,
           sort_order INTEGER NOT NULL DEFAULT 0,
           {HEALTH_COLUMNS},
           created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
           updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
         );

         CREATE TABLE IF NOT EXISTS decision_models (
           id TEXT PRIMARY KEY NOT NULL,
           model_id TEXT NOT NULL UNIQUE,
           name TEXT NOT NULL DEFAULT '',
           provider TEXT NOT NULL DEFAULT 'typesafe',
           base_url TEXT NOT NULL DEFAULT '',
           base_url_mode TEXT NOT NULL DEFAULT 'auto',
           model TEXT NOT NULL DEFAULT '',
           api_key TEXT NOT NULL DEFAULT '',
           enabled INTEGER NOT NULL DEFAULT 1,
           sort_order INTEGER NOT NULL DEFAULT 0,
           {HEALTH_COLUMNS},
           created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
           updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
         );"
    ))
}

fn with_connection<T>(
    database_path: &Path,
    action: &str,
    run: impl FnOnce(&Connection) -> rusqlite::Result<T>,
) -> Result<T> {
    database::open_connection(database_path)
        .and_then(|connection| run(&connection))
        .map_err(|error| database::database_error(database_path, action, error))
}

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

const ORDER_BY: &str = "ORDER BY sort_order ASC, created_at ASC, id ASC";

fn embedding_from_row(row: &Row<'_>) -> rusqlite::Result<EmbeddingModelEntry> {
    Ok(EmbeddingModelEntry {
        id: row.get(0)?,
        name: row.get(1)?,
        embedding_type: row.get(2)?,
        model_name: row.get(3)?,
        base_url: row.get(4)?,
        api_key: row.get(5)?,
        dimensions: row.get(6)?,
        context_length: row.get(7)?,
        enabled: row.get::<_, i64>(8)? != 0,
    })
}

fn reranking_from_row(row: &Row<'_>) -> rusqlite::Result<RerankingModelEntry> {
    Ok(RerankingModelEntry {
        id: row.get(0)?,
        name: row.get(1)?,
        model_name: row.get(2)?,
        base_url: row.get(3)?,
        api_key: row.get(4)?,
        context_length: row.get(5)?,
        enabled: row.get::<_, i64>(6)? != 0,
    })
}

fn decision_from_row(row: &Row<'_>) -> rusqlite::Result<DecisionModelEntry> {
    Ok(DecisionModelEntry {
        id: row.get(0)?,
        name: row.get(1)?,
        provider: row.get(2)?,
        base_url: row.get(3)?,
        base_url_mode: row.get(4)?,
        model: row.get(5)?,
        api_key: row.get(6)?,
        enabled: row.get::<_, i64>(7)? != 0,
    })
}

pub fn list_embedding_models_with_connection(
    connection: &Connection,
) -> rusqlite::Result<Vec<EmbeddingModelEntry>> {
    let mut statement = connection.prepare(&format!(
        "SELECT model_id, name, embedding_type, model_name, base_url, api_key, dimensions,
                context_length, enabled
         FROM embedding_models {ORDER_BY}"
    ))?;
    let rows = statement.query_map([], embedding_from_row)?;
    rows.collect()
}

pub fn list_reranking_models_with_connection(
    connection: &Connection,
) -> rusqlite::Result<Vec<RerankingModelEntry>> {
    let mut statement = connection.prepare(&format!(
        "SELECT model_id, name, model_name, base_url, api_key, context_length, enabled
         FROM reranking_models {ORDER_BY}"
    ))?;
    let rows = statement.query_map([], reranking_from_row)?;
    rows.collect()
}

pub fn list_decision_models_with_connection(
    connection: &Connection,
) -> rusqlite::Result<Vec<DecisionModelEntry>> {
    let mut statement = connection.prepare(&format!(
        "SELECT model_id, name, provider, base_url, base_url_mode, model, api_key, enabled
         FROM decision_models {ORDER_BY}"
    ))?;
    let rows = statement.query_map([], decision_from_row)?;
    rows.collect()
}

pub fn list_embedding_models(database_path: &Path) -> Result<Vec<EmbeddingModelEntry>> {
    with_connection(
        database_path,
        "list embedding models",
        list_embedding_models_with_connection,
    )
}

pub fn list_reranking_models(database_path: &Path) -> Result<Vec<RerankingModelEntry>> {
    with_connection(
        database_path,
        "list reranking models",
        list_reranking_models_with_connection,
    )
}

pub fn list_decision_models(database_path: &Path) -> Result<Vec<DecisionModelEntry>> {
    with_connection(
        database_path,
        "list decision models",
        list_decision_models_with_connection,
    )
}

/// 宽松读取：失败时返回空列表（运行时调用方按「未配置」处理）。
pub fn load_embedding_models(database_path: &Path) -> Vec<EmbeddingModelEntry> {
    list_embedding_models(database_path).unwrap_or_default()
}

pub fn load_reranking_models(database_path: &Path) -> Vec<RerankingModelEntry> {
    list_reranking_models(database_path).unwrap_or_default()
}

pub fn load_decision_models(database_path: &Path) -> Vec<DecisionModelEntry> {
    list_decision_models(database_path).unwrap_or_default()
}

pub(crate) fn model_exists_with_connection(
    connection: &Connection,
    kind: RegisteredModelKind,
    model_id: &str,
) -> rusqlite::Result<bool> {
    connection
        .query_row(
            &format!("SELECT 1 FROM {} WHERE model_id = ?1", kind.table()),
            [model_id.trim()],
            |_| Ok(()),
        )
        .optional()
        .map(|found| found.is_some())
}

// ---------------------------------------------------------------------------
// 写入
// ---------------------------------------------------------------------------

fn next_sort_order(connection: &Connection, kind: RegisteredModelKind) -> rusqlite::Result<i64> {
    connection.query_row(
        &format!(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM {}",
            kind.table()
        ),
        [],
        |row| row.get(0),
    )
}

/// 新增或更新（按 model_id）；id 为空时生成。更新保留原排序与自检结果。
pub fn upsert_embedding_model_with_connection(
    connection: &Connection,
    model: EmbeddingModelEntry,
) -> rusqlite::Result<EmbeddingModelEntry> {
    let mut model = model.normalized();
    if model.id.is_empty() {
        model.id = new_model_id(RegisteredModelKind::Embedding);
    }
    let sort_order = next_sort_order(connection, RegisteredModelKind::Embedding)?;
    connection.execute(
        "INSERT INTO embedding_models (
           id, model_id, name, embedding_type, model_name, base_url, api_key, dimensions,
           context_length, enabled, sort_order
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(model_id) DO UPDATE SET
           name = excluded.name,
           embedding_type = excluded.embedding_type,
           model_name = excluded.model_name,
           base_url = excluded.base_url,
           api_key = excluded.api_key,
           dimensions = excluded.dimensions,
           context_length = excluded.context_length,
           enabled = excluded.enabled,
           updated_at = datetime('now', 'localtime')",
        params![
            database::create_snowflake_id(),
            model.id,
            model.name,
            model.embedding_type,
            model.model_name,
            model.base_url,
            model.api_key,
            model.dimensions,
            model.context_length,
            i64::from(model.enabled),
            sort_order,
        ],
    )?;
    Ok(model)
}

pub fn upsert_reranking_model_with_connection(
    connection: &Connection,
    model: RerankingModelEntry,
) -> rusqlite::Result<RerankingModelEntry> {
    let mut model = model.normalized();
    if model.id.is_empty() {
        model.id = new_model_id(RegisteredModelKind::Reranking);
    }
    let sort_order = next_sort_order(connection, RegisteredModelKind::Reranking)?;
    connection.execute(
        "INSERT INTO reranking_models (
           id, model_id, name, model_name, base_url, api_key, context_length, enabled, sort_order
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(model_id) DO UPDATE SET
           name = excluded.name,
           model_name = excluded.model_name,
           base_url = excluded.base_url,
           api_key = excluded.api_key,
           context_length = excluded.context_length,
           enabled = excluded.enabled,
           updated_at = datetime('now', 'localtime')",
        params![
            database::create_snowflake_id(),
            model.id,
            model.name,
            model.model_name,
            model.base_url,
            model.api_key,
            model.context_length,
            i64::from(model.enabled),
            sort_order,
        ],
    )?;
    Ok(model)
}

pub fn upsert_decision_model_with_connection(
    connection: &Connection,
    model: DecisionModelEntry,
) -> rusqlite::Result<DecisionModelEntry> {
    let mut model = model.normalized();
    if model.id.is_empty() {
        model.id = new_model_id(RegisteredModelKind::Decision);
    }
    let sort_order = next_sort_order(connection, RegisteredModelKind::Decision)?;
    connection.execute(
        "INSERT INTO decision_models (
           id, model_id, name, provider, base_url, base_url_mode, model, api_key, enabled, sort_order
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(model_id) DO UPDATE SET
           name = excluded.name,
           provider = excluded.provider,
           base_url = excluded.base_url,
           base_url_mode = excluded.base_url_mode,
           model = excluded.model,
           api_key = excluded.api_key,
           enabled = excluded.enabled,
           updated_at = datetime('now', 'localtime')",
        params![
            database::create_snowflake_id(),
            model.id,
            model.name,
            model.provider,
            model.base_url,
            model.base_url_mode,
            model.model,
            model.api_key,
            i64::from(model.enabled),
            sort_order,
        ],
    )?;
    Ok(model)
}

pub fn upsert_embedding_model(
    database_path: &Path,
    model: EmbeddingModelEntry,
) -> Result<EmbeddingModelEntry> {
    if model.model_name.trim().is_empty() {
        return Err(invalid("Embedding model name is required"));
    }
    with_connection(database_path, "save embedding model", |connection| {
        upsert_embedding_model_with_connection(connection, model)
    })
}

pub fn upsert_reranking_model(
    database_path: &Path,
    model: RerankingModelEntry,
) -> Result<RerankingModelEntry> {
    if model.model_name.trim().is_empty() {
        return Err(invalid("Reranking model name is required"));
    }
    with_connection(database_path, "save reranking model", |connection| {
        upsert_reranking_model_with_connection(connection, model)
    })
}

pub fn upsert_decision_model(
    database_path: &Path,
    model: DecisionModelEntry,
) -> Result<DecisionModelEntry> {
    if model.model.trim().is_empty() {
        return Err(invalid("Decision model name is required"));
    }
    if model.base_url_mode.trim() == BASE_URL_MODE_CUSTOM && model.base_url.trim().is_empty() {
        return Err(invalid(
            "The full request URL is required in custom base URL mode",
        ));
    }
    with_connection(database_path, "save decision model", |connection| {
        upsert_decision_model_with_connection(connection, model)
    })
}

pub fn set_model_enabled_with_connection(
    connection: &Connection,
    kind: RegisteredModelKind,
    model_id: &str,
    enabled: bool,
) -> rusqlite::Result<bool> {
    let changed = connection.execute(
        &format!(
            "UPDATE {} SET enabled = ?1, updated_at = datetime('now', 'localtime') WHERE model_id = ?2",
            kind.table()
        ),
        params![i64::from(enabled), model_id.trim()],
    )?;
    Ok(changed > 0)
}

pub fn set_model_enabled(
    database_path: &Path,
    kind: RegisteredModelKind,
    model_id: &str,
    enabled: bool,
) -> Result<()> {
    let found = with_connection(database_path, "toggle model", |connection| {
        set_model_enabled_with_connection(connection, kind, model_id, enabled)
    })?;
    if found {
        Ok(())
    } else {
        Err(invalid(format!("Model \"{}\" does not exist", model_id.trim())))
    }
}

pub(crate) fn read_setting_with_connection(
    connection: &Connection,
    setting_code: &str,
) -> rusqlite::Result<Option<String>> {
    connection
        .query_row(
            "SELECT setting_value FROM system_settings WHERE setting_code = ?1",
            [setting_code],
            |row| row.get(0),
        )
        .optional()
}

/// JSON 对象设置中 `field` 等于 `model_id` 时清空并写回，返回是否改动。
fn clear_json_reference(
    connection: &Connection,
    setting_code: &str,
    setting_name: &str,
    field: &str,
    model_id: &str,
) -> rusqlite::Result<bool> {
    let Some(raw) = read_setting_with_connection(connection, setting_code)? else {
        return Ok(false);
    };
    let Ok(Value::Object(mut object)) = serde_json::from_str::<Value>(&raw) else {
        return Ok(false);
    };
    let matched = object
        .get(field)
        .and_then(Value::as_str)
        .is_some_and(|value| value.trim() == model_id);
    if !matched {
        return Ok(false);
    }
    object.insert(field.to_string(), json!(""));
    set_system_setting_with_connection(
        connection,
        setting_name,
        setting_code,
        &Value::Object(object).to_string(),
    )?;
    Ok(true)
}

fn clear_model_references(
    connection: &Connection,
    kind: RegisteredModelKind,
    model_id: &str,
) -> rusqlite::Result<Vec<String>> {
    let mut cleared = Vec::new();
    let codebase_field = match kind {
        RegisteredModelKind::Embedding => "embeddingModelId",
        RegisteredModelKind::Reranking => "rerankingModelId",
        RegisteredModelKind::Decision => "agentReviewModelId",
    };
    if clear_json_reference(
        connection,
        CODEBASE_SETTING_CODE,
        CODEBASE_SETTING_NAME,
        codebase_field,
        model_id,
    )? {
        cleared.push(format!("codebase.{codebase_field}"));
    }

    if kind == RegisteredModelKind::Decision {
        let tool_model = read_setting_with_connection(connection, DECISION_TOOL_MODEL_SETTING_CODE)?;
        if tool_model.is_some_and(|value| value.trim() == model_id) {
            set_system_setting_with_connection(
                connection,
                DECISION_TOOL_MODEL_SETTING_NAME,
                DECISION_TOOL_MODEL_SETTING_CODE,
                "",
            )?;
            cleared.push("decisionToolModel".to_string());
        }
        if clear_json_reference(
            connection,
            SENSITIVE_COMMAND_ASSIST_SETTING_CODE,
            SENSITIVE_COMMAND_ASSIST_SETTING_NAME,
            "modelId",
            model_id,
        )? {
            cleared.push("sensitiveCommandAssist.modelId".to_string());
        }
    }
    Ok(cleared)
}

/// 删除模型并清空引用它的设置（同一事务）。
pub fn delete_model_with_connection(
    connection: &Connection,
    kind: RegisteredModelKind,
    model_id: &str,
) -> rusqlite::Result<ModelDeleteResult> {
    let model_id = model_id.trim();
    let transaction = connection.unchecked_transaction()?;
    let deleted = transaction.execute(
        &format!("DELETE FROM {} WHERE model_id = ?1", kind.table()),
        [model_id],
    )? > 0;
    let cleared_references = if deleted {
        clear_model_references(&transaction, kind, model_id)?
    } else {
        Vec::new()
    };
    transaction.commit()?;
    Ok(ModelDeleteResult {
        deleted,
        cleared_references,
    })
}

pub fn delete_model(
    database_path: &Path,
    kind: RegisteredModelKind,
    model_id: &str,
) -> Result<ModelDeleteResult> {
    let result = with_connection(database_path, "delete model", |connection| {
        delete_model_with_connection(connection, kind, model_id)
    })?;
    if !result.cleared_references.is_empty() {
        invalidate_system_setting_cache(&[
            CODEBASE_SETTING_CODE,
            DECISION_TOOL_MODEL_SETTING_CODE,
            SENSITIVE_COMMAND_ASSIST_SETTING_CODE,
        ]);
    }
    Ok(result)
}

// ---------------------------------------------------------------------------
// 连接自检结果
// ---------------------------------------------------------------------------

fn to_column_int(value: f64) -> i64 {
    if value.is_finite() {
        value.round() as i64
    } else {
        0
    }
}

/// 写入自检结果；模型不存在（如未保存的草稿）时返回 false。
pub fn record_model_health_with_connection(
    connection: &Connection,
    kind: RegisteredModelKind,
    result: &ModelConnectionTestResult,
) -> rusqlite::Result<bool> {
    let changed = connection.execute(
        &format!(
            "UPDATE {} SET
               health_ok = ?1,
               health_http_status = ?2,
               health_latency_ms = ?3,
               health_endpoint = ?4,
               health_model = ?5,
               health_dimension = ?6,
               health_expected_dimension = ?7,
               health_error = ?8,
               health_tested_at = ?9
             WHERE model_id = ?10",
            kind.table()
        ),
        params![
            i64::from(result.ok),
            result.http_status.map(i64::from),
            to_column_int(result.latency_ms),
            result.endpoint,
            result.model,
            result.dimension.map(i64::from),
            result.expected_dimension.map(i64::from),
            result.error,
            to_column_int(result.tested_at),
            result.target_id.trim(),
        ],
    )?;
    Ok(changed > 0)
}

pub fn record_model_health(
    database_path: &Path,
    kind: RegisteredModelKind,
    result: &ModelConnectionTestResult,
) -> Result<bool> {
    with_connection(database_path, "save model health", |connection| {
        record_model_health_with_connection(connection, kind, result)
    })
}

fn optional_u32(value: Option<i64>) -> Option<u32> {
    value.and_then(|number| u32::try_from(number).ok())
}

pub fn list_model_health_with_connection(
    connection: &Connection,
    kind: RegisteredModelKind,
) -> rusqlite::Result<Vec<ModelConnectionTestResult>> {
    let mut statement = connection.prepare(&format!(
        "SELECT model_id, health_ok, health_http_status, health_latency_ms, health_endpoint,
                health_model, health_dimension, health_expected_dimension, health_error,
                health_tested_at
         FROM {} WHERE health_tested_at IS NOT NULL {ORDER_BY}",
        kind.table()
    ))?;
    let rows = statement.query_map([], |row| {
        Ok(ModelConnectionTestResult {
            target_id: row.get(0)?,
            ok: row.get::<_, Option<i64>>(1)?.unwrap_or(0) != 0,
            http_status: optional_u32(row.get(2)?),
            latency_ms: row.get::<_, Option<i64>>(3)?.unwrap_or(0) as f64,
            endpoint: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
            model: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
            dimension: optional_u32(row.get(6)?),
            expected_dimension: optional_u32(row.get(7)?),
            error: row.get(8)?,
            tested_at: row.get::<_, Option<i64>>(9)?.unwrap_or(0) as f64,
        })
    })?;
    rows.collect()
}

/// 三类模型的最近自检结果：(决策, 嵌入, 重排)。
pub fn load_model_health(
    database_path: &Path,
) -> Result<(
    Vec<ModelConnectionTestResult>,
    Vec<ModelConnectionTestResult>,
    Vec<ModelConnectionTestResult>,
)> {
    with_connection(database_path, "load model health", |connection| {
        Ok((
            list_model_health_with_connection(connection, RegisteredModelKind::Decision)?,
            list_model_health_with_connection(connection, RegisteredModelKind::Embedding)?,
            list_model_health_with_connection(connection, RegisteredModelKind::Reranking)?,
        ))
    })
}
