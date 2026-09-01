//! 项目级持久记忆（project_memories 表）的存储服务。
//!
//! 记忆按 `directory_id` 做项目隔离，是跨会话的 AI 知识库：AI 通过内置
//! memory 工具集读写，系统提示词按 importance 取头部条目注入，渲染器
//! 面板经 NAPI 导出做手动管理。所有函数由调用方放入 `spawn_blocking`
//! 执行，绝不阻塞 Node.js 事件循环。
//!
//! 错误处理模式（与 memos.rs 一致）：内部 `*_with_connection` helper 一律
//! 返回 `rusqlite::Result`，入口函数在边界处经 `database_error` 转换为
//! napi::Error；参数校验错误直接返回 napi::Error。
//!
//! 检索采用轻量打分方案（SQLite 未启用 FTS5，单项目记忆量级小）：
//! 标题/内容/标签命中 + 重要性 + 近期性 + 召回次数加权排序。

use std::path::Path;

use chrono::NaiveDateTime;
use napi::bindgen_prelude::*;
use rusqlite::{params, Connection, Row};

use super::super::database;
use super::super::{MemoryPage, MemoryRecord, MemoryStats};

/// 记忆类别（写入侧校验；未知值报错而非静默归并，避免污染统计）。
pub const MEMORY_KINDS: [&str; 5] = [
    "fact",
    "decision",
    "preference",
    "pitfall",
    "task_state",
];

/// 记忆状态：active（注入+可检索）| pending（蒸馏待确认）| archived（归档）。
pub const MEMORY_STATUSES: [&str; 3] = ["active", "pending", "archived"];

/// 记忆来源：agent（AI 工具写入）| auto（自动蒸馏）| user（手动面板）。
pub const MEMORY_SOURCES: [&str; 3] = ["agent", "auto", "user"];

/// SQLite 绑定变量上限保护：IN 子句按 900 一批分块执行。
const MEMORY_SQL_CHUNK: usize = 900;

/// 记忆写入入参。`title` 是去重键（同项目内规范化后同名视为同一条）。
pub struct MemoryUpsertInput<'a> {
    pub directory_id: &'a str,
    pub kind: &'a str,
    pub title: &'a str,
    pub content: &'a str,
    pub source: &'a str,
    pub status: &'a str,
    pub importance: i32,
    pub conversation_id: &'a str,
    pub tags: Vec<String>,
}

/// 记忆更新补丁：`None` 字段保持原值不变。
pub struct MemoryUpdatePatch {
    pub kind: Option<String>,
    pub title: Option<String>,
    pub content: Option<String>,
    pub importance: Option<i32>,
    pub status: Option<String>,
    pub tags: Option<Vec<String>>,
}

// ---------------------------------------------------------------------------
// 校验与归一化
// ---------------------------------------------------------------------------

fn normalize_kind(value: &str) -> Result<&'static str> {
    let normalized = value.trim().to_ascii_lowercase();
    MEMORY_KINDS
        .iter()
        .find(|kind| **kind == normalized)
        .copied()
        .ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                format!("Memory kind must be one of: {}", MEMORY_KINDS.join(" | ")),
            )
        })
}

fn normalize_status(value: &str) -> Result<&'static str> {
    let normalized = value.trim().to_ascii_lowercase();
    MEMORY_STATUSES
        .iter()
        .find(|status| **status == normalized)
        .copied()
        .ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                format!(
                    "Memory status must be one of: {}",
                    MEMORY_STATUSES.join(" | ")
                ),
            )
        })
}

fn normalize_source(value: &str) -> Result<&'static str> {
    let normalized = value.trim().to_ascii_lowercase();
    MEMORY_SOURCES
        .iter()
        .find(|source| **source == normalized)
        .copied()
        .ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                format!(
                    "Memory source must be one of: {}",
                    MEMORY_SOURCES.join(" | ")
                ),
            )
        })
}

fn clamp_importance(value: i32) -> i32 {
    value.clamp(1, 5)
}

/// 规范化标题（去重键）：压缩空白 + 转小写。
fn normalize_title_key(title: &str) -> String {
    title
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn serialize_tags(tags: &[String]) -> String {
    serde_json::to_string(tags).unwrap_or_else(|_| "[]".to_string())
}

fn parse_tags(raw: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(raw).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// 行映射
// ---------------------------------------------------------------------------

const MEMORY_COLUMNS: &str = "id, memory_id, directory_id, kind, title, content, source, \
     status, importance, conversation_id, tags_json, \
     last_recalled_at, recall_count, created_at, updated_at";

fn map_memory_row(row: &Row) -> rusqlite::Result<MemoryRecord> {
    let tags_json: String = row.get(10)?;
    Ok(MemoryRecord {
        id: row.get(0)?,
        memory_id: row.get(1)?,
        directory_id: row.get(2)?,
        kind: row.get(3)?,
        title: row.get(4)?,
        content: row.get(5)?,
        source: row.get(6)?,
        status: row.get(7)?,
        importance: row.get(8)?,
        conversation_id: row.get(9)?,
        tags: parse_tags(&tags_json),
        last_recalled_at: row.get(11)?,
        recall_count: row.get(12)?,
        created_at: row.get(13)?,
        updated_at: row.get(14)?,
    })
}

fn fetch_memory_by_memory_id(
    connection: &Connection,
    memory_id: &str,
) -> rusqlite::Result<Option<MemoryRecord>> {
    let sql = format!(
        "SELECT {MEMORY_COLUMNS} FROM project_memories WHERE memory_id = ?1"
    );
    let mut statement = connection.prepare(&sql)?;
    let mut rows = statement.query_map(params![memory_id], map_memory_row)?;
    match rows.next() {
        Some(value) => Ok(Some(value?)),
        None => Ok(None),
    }
}

// ---------------------------------------------------------------------------
// 写入（含按标题去重合并）
// ---------------------------------------------------------------------------

/// 新增或合并记忆：同项目内已存在规范化同名（非 archived）条目时合并
/// 更新（content 覆盖、importance 取较大值、tags 取并集），返回
/// `(记录, 是否新建)`。这避免 AI 反复保存同一主题产生重复条目。
pub fn upsert_memory(
    database_path: &Path,
    input: &MemoryUpsertInput,
) -> Result<(MemoryRecord, bool)> {
    // —— 参数校验（napi 层错误）——
    let kind = normalize_kind(input.kind)?;
    let source = normalize_source(input.source)?;
    let status = normalize_status(input.status)?;
    let title = input.title.trim();
    let content = input.content.trim();
    if title.is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            "Memory title is required and must not be empty".to_string(),
        ));
    }
    if content.is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            "Memory content is required and must not be empty".to_string(),
        ));
    }
    if input.directory_id.trim().is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            "Memory operations require a selected project (directory id)".to_string(),
        ));
    }

    // —— DB 操作（rusqlite 错误在边界统一转换）——
    let connection = database::open_connection(database_path)
        .map_err(|error| database::database_error(database_path, "open database", error))?;
    upsert_memory_with_connection(
        &connection,
        input,
        kind,
        source,
        status,
        title,
        content,
    )
    .map_err(|error| database::database_error(database_path, "upsert memory", error))
}

fn upsert_memory_with_connection(
    connection: &Connection,
    input: &MemoryUpsertInput,
    kind: &str,
    _source: &str,
    status: &str,
    title: &str,
    content: &str,
) -> rusqlite::Result<(MemoryRecord, bool)> {
    let title_key = normalize_title_key(title);

    // 同项目内规范化同名且未归档 → 合并更新而非新增。归一化在 Rust 侧
    // 折叠内部空白 + 转小写，SQL 侧以 trim + lower 匹配首尾空白差异。
    let existing: Option<(String, i32, String)> = connection
        .query_row(
            "SELECT memory_id, importance, tags_json FROM project_memories
              WHERE directory_id = ?1 AND status <> 'archived' AND lower(trim(title)) = ?2
              ORDER BY updated_at DESC LIMIT 1",
            params![input.directory_id.trim(), title_key],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map(Some)
        .or_else(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })?;

    if let Some((existing_memory_id, existing_importance, existing_tags_json)) = existing {
        let importance = clamp_importance(input.importance.max(existing_importance));
        let mut tags = parse_tags(&existing_tags_json);
        for tag in input.tags.iter().map(|tag| tag.trim().to_lowercase()) {
            if !tag.is_empty() && !tags.contains(&tag) {
                tags.push(tag);
            }
        }
        connection.execute(
            "UPDATE project_memories
                SET kind = ?1, content = ?2, importance = ?3, status = ?4,
                    tags_json = ?5, updated_at = datetime('now', 'localtime')
              WHERE memory_id = ?6",
            params![
                kind,
                content,
                importance,
                status,
                serialize_tags(&tags),
                existing_memory_id,
            ],
        )?;
        let record = fetch_memory_by_memory_id(connection, &existing_memory_id)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
        return Ok((record, false));
    }

    let memory_id = database::create_snowflake_id();
    connection.execute(
        "INSERT INTO project_memories
           (id, memory_id, directory_id, kind, title, content, source, status,
            importance, conversation_id, tags_json,
            created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
                 datetime('now', 'localtime'), datetime('now', 'localtime'))",
        params![
            database::create_snowflake_id(),
            memory_id,
            input.directory_id.trim(),
            kind,
            title,
            content,
            _source,
            status,
            clamp_importance(input.importance),
            input.conversation_id.trim(),
            serialize_tags(&input.tags),
        ],
    )?;
    let record = fetch_memory_by_memory_id(connection, &memory_id)?
        .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
    Ok((record, true))
}

/// 更新记忆的可编辑字段（`None` 保持不变）。条目不存在时报错。
pub fn update_memory(
    database_path: &Path,
    memory_id: &str,
    patch: &MemoryUpdatePatch,
) -> Result<MemoryRecord> {
    // —— 参数校验 ——
    let kind = match &patch.kind {
        Some(value) => Some(normalize_kind(value)?),
        None => None,
    };
    let status = match &patch.status {
        Some(value) => Some(normalize_status(value)?),
        None => None,
    };
    if let Some(title) = &patch.title {
        if title.trim().is_empty() {
            return Err(Error::new(
                Status::InvalidArg,
                "Memory title must not be empty".to_string(),
            ));
        }
    }
    if let Some(content) = &patch.content {
        if content.trim().is_empty() {
            return Err(Error::new(
                Status::InvalidArg,
                "Memory content must not be empty".to_string(),
            ));
        }
    }
    if kind.is_none()
        && status.is_none()
        && patch.title.is_none()
        && patch.content.is_none()
        && patch.importance.is_none()
        && patch.tags.is_none()
    {
        return Err(Error::new(
            Status::InvalidArg,
            "At least one field to update must be provided (title / content / kind / importance / status / tags)".to_string(),
        ));
    }

    // —— DB 操作 ——
    let connection = database::open_connection(database_path)
        .map_err(|error| database::database_error(database_path, "open database", error))?;
    let updated = connection
        .execute(
            "UPDATE project_memories SET
               kind = COALESCE(?2, kind),
               title = COALESCE(?3, title),
               content = COALESCE(?4, content),
               importance = COALESCE(?5, importance),
               status = COALESCE(?6, status),
               tags_json = COALESCE(?7, tags_json),
               updated_at = datetime('now', 'localtime')
             WHERE memory_id = ?1",
            params![
                memory_id.trim(),
                kind,
                patch.title.as_deref().map(str::trim),
                patch.content.as_deref().map(str::trim),
                patch.importance.map(clamp_importance),
                status,
                patch.tags.as_ref().map(|tags| serialize_tags(tags)),
            ],
        )
        .map_err(|error| database::database_error(database_path, "update memory", error))?;
    if updated == 0 {
        return Err(Error::new(
            Status::GenericFailure,
            format!("Memory not found: {}", memory_id.trim()),
        ));
    }
    fetch_memory_by_memory_id(&connection, memory_id.trim())
        .map_err(|error| database::database_error(database_path, "reload updated memory", error))?
        .ok_or_else(|| {
            Error::new(
                Status::GenericFailure,
                format!("Memory not found: {}", memory_id.trim()),
            )
        })
}

/// 删除单条记忆。返回是否确实删除了条目。
pub fn delete_memory(database_path: &Path, memory_id: &str) -> Result<bool> {
    database::open_connection(database_path)
        .and_then(|connection| {
            connection
                .execute(
                    "DELETE FROM project_memories WHERE memory_id = ?1",
                    params![memory_id.trim()],
                )
                .map(|deleted| deleted > 0)
        })
        .map_err(|error| database::database_error(database_path, "delete memory", error))
}

/// 清空项目记忆库（用户「一键清空」），返回删除条数。
pub fn clear_project_memories(database_path: &Path, directory_id: &str) -> Result<i32> {
    database::open_connection(database_path)
        .and_then(|connection| {
            connection
                .execute(
                    "DELETE FROM project_memories WHERE directory_id = ?1",
                    params![directory_id.trim()],
                )
                .map(|deleted| deleted as i32)
        })
        .map_err(|error| database::database_error(database_path, "clear memories", error))
}

// ---------------------------------------------------------------------------
// 会话级维护（会话删除联动）
// ---------------------------------------------------------------------------

/// 列出某个会话保存的记忆（面板「查看该会话贡献的记忆」/删除前确认）。
/// 仅按 conversation_id 匹配；溯源为空的记忆不返回。
pub fn list_memories_by_conversation(
    database_path: &Path,
    conversation_id: &str,
    limit: i32,
) -> Result<Vec<MemoryRecord>> {
    let safe_limit = if limit > 0 { limit } else { 50 };
    database::open_connection(database_path)
        .and_then(|connection| {
            let sql = format!(
                "SELECT {MEMORY_COLUMNS} FROM project_memories
                  WHERE conversation_id = ?1
                  ORDER BY updated_at DESC, id DESC LIMIT ?2"
            );
            let mut statement = connection.prepare(&sql)?;
            let rows = statement.query_map(params![conversation_id.trim(), safe_limit], map_memory_row)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        })
        .map_err(|error| database::database_error(database_path, "list memories by conversation", error))
}

/// 删除某个会话保存的全部记忆（手动维护入口），返回删除条数。
pub fn delete_memories_by_conversation(
    database_path: &Path,
    conversation_id: &str,
) -> Result<i32> {
    database::open_connection(database_path)
        .and_then(|connection| {
            connection
                .execute(
                    "DELETE FROM project_memories WHERE conversation_id = ?1",
                    params![conversation_id.trim()],
                )
                .map(|deleted| deleted as i32)
        })
        .map_err(|error| database::database_error(database_path, "delete memories by conversation", error))
}

/// 会话删除联动钩子：删除这些会话保存的全部记忆（含级联子会话 ID 集）。
///
/// 用户在删除确认弹窗中勾选「同时删除记忆」时才被调用（默认保留——
/// 记忆是项目级知识资产，不随来源会话消失）；由 chat_conversations
/// 删除流程在事务内执行，保证原子性。返回 rusqlite::Result 以便调用方
/// 统一经 database_error 转换。
pub fn delete_memories_by_conversation_ids(
    connection: &Connection,
    conversation_ids: &[String],
) -> rusqlite::Result<i32> {
    let ids: Vec<String> = conversation_ids
        .iter()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect();
    if ids.is_empty() {
        return Ok(0);
    }

    let mut deleted = 0i32;
    for chunk in ids.chunks(MEMORY_SQL_CHUNK) {
        let placeholders = chunk
            .iter()
            .enumerate()
            .map(|(index, _)| format!("?{}", index + 1))
            .collect::<Vec<_>>()
            .join(", ");
        let mut statement = connection.prepare(&format!(
            "DELETE FROM project_memories WHERE conversation_id IN ({placeholders})"
        ))?;
        deleted += statement.execute(rusqlite::params_from_iter(chunk.iter().cloned()))? as i32;
    }
    Ok(deleted)
}

/// 统计一组会话（含级联子会话）关联的记忆条数。删除确认弹窗用它决定
/// 是否展示「同时删除记忆」选项——为 0 时不打扰用户。
pub fn count_memories_by_conversation_ids(
    database_path: &Path,
    conversation_ids: &[String],
) -> Result<i32> {
    let ids: Vec<String> = conversation_ids
        .iter()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect();
    if ids.is_empty() {
        return Ok(0);
    }

    database::open_connection(database_path)
        .and_then(|connection| {
            let mut count = 0i32;
            for chunk in ids.chunks(MEMORY_SQL_CHUNK) {
                let placeholders = chunk
                    .iter()
                    .enumerate()
                    .map(|(index, _)| format!("?{}", index + 1))
                    .collect::<Vec<_>>()
                    .join(", ");
                let mut statement = connection.prepare(&format!(
                    "SELECT COUNT(*) FROM project_memories WHERE conversation_id IN ({placeholders})"
                ))?;
                let chunk_count: i32 = statement.query_row(
                    rusqlite::params_from_iter(chunk.iter().cloned()),
                    |row| row.get(0),
                )?;
                count += chunk_count;
            }
            Ok(count)
        })
        .map_err(|error| database::database_error(database_path, "count memories by conversation", error))
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

/// 分页列出项目记忆。`status_filter` / `kind_filter` 为空串表示不过滤。
pub fn list_memories(
    database_path: &Path,
    directory_id: &str,
    status_filter: Option<&str>,
    kind_filter: Option<&str>,
    limit: i32,
    offset: i32,
) -> Result<MemoryPage> {
    database::open_connection(database_path)
        .and_then(|connection| {
            query_memories_page(
                &connection,
                directory_id.trim(),
                status_filter.unwrap_or(""),
                kind_filter.unwrap_or(""),
                limit,
                offset,
            )
        })
        .map_err(|error| database::database_error(database_path, "list memories", error))
}

fn query_memories_page(
    connection: &Connection,
    directory_id: &str,
    status_filter: &str,
    kind_filter: &str,
    limit: i32,
    offset: i32,
) -> rusqlite::Result<MemoryPage> {
    let safe_limit = if limit > 0 { limit } else { 50 };
    let safe_offset = if offset > 0 { offset } else { 0 };
    let status_ok = MEMORY_STATUSES.contains(&status_filter);
    let kind_ok = MEMORY_KINDS.contains(&kind_filter);

    // WHERE 子句按 (status_ok, kind_ok) 依次占用 ?1..?n；LIMIT/OFFSET 由
    // 内部 sanitize 过的整数直接内联（非用户可控文本，无注入风险），
    // 避免各分支占位符数量不一致造成 rusqlite 参数个数校验失败。
    let where_clause = match (status_ok, kind_ok) {
        (true, true) => "WHERE directory_id = ?1 AND status = ?2 AND kind = ?3",
        (true, false) => "WHERE directory_id = ?1 AND status = ?2",
        (false, true) => "WHERE directory_id = ?1 AND kind = ?2",
        (false, false) => "WHERE directory_id = ?1",
    };

    let total: i32 = {
        let sql = format!("SELECT COUNT(*) FROM project_memories {where_clause}");
        let mut statement = connection.prepare(&sql)?;
        match (status_ok, kind_ok) {
            (true, true) => statement
                .query_row(params![directory_id, status_filter, kind_filter], |row| {
                    row.get(0)
                })?,
            (true, false) => statement.query_row(params![directory_id, status_filter], |row| {
                row.get(0)
            })?,
            (false, true) => statement.query_row(params![directory_id, kind_filter], |row| {
                row.get(0)
            })?,
            (false, false) => statement.query_row(params![directory_id], |row| row.get(0))?,
        }
    };

    let sql = format!(
        "SELECT {MEMORY_COLUMNS} FROM project_memories {where_clause}
          ORDER BY importance DESC, updated_at DESC, id DESC
          LIMIT {safe_limit} OFFSET {safe_offset}"
    );
    let mut statement = connection.prepare(&sql)?;
    let items: Vec<MemoryRecord> = match (status_ok, kind_ok) {
        (true, true) => statement
            .query_map(
                params![directory_id, status_filter, kind_filter],
                map_memory_row,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?,
        (true, false) => statement
            .query_map(params![directory_id, status_filter], map_memory_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?,
        (false, true) => statement
            .query_map(params![directory_id, kind_filter], map_memory_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?,
        (false, false) => statement
            .query_map(params![directory_id], map_memory_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?,
    };

    Ok(MemoryPage {
        has_more: (safe_offset + safe_limit) < total,
        items,
        total,
    })
}

/// 项目记忆库统计（面板徽标与注入章节汇总）。
pub fn get_memory_stats(database_path: &Path, directory_id: &str) -> Result<MemoryStats> {
    database::open_connection(database_path)
        .and_then(|connection| {
            let (total, active, pending, archived): (i32, i32, i32, i32) = connection.query_row(
                "SELECT COUNT(*),
                        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END),
                        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END),
                        SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END)
                   FROM project_memories WHERE directory_id = ?1",
                params![directory_id.trim()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;
            Ok(MemoryStats {
                total,
                active,
                pending,
                archived,
            })
        })
        .map_err(|error| database::database_error(database_path, "count memories", error))
}

/// 系统提示词注入用的头部记忆：active + importance >= min_importance，
/// 按 importance、更新时间倒序取前 `max_entries` 条。
pub fn top_memories_for_injection(
    database_path: &Path,
    directory_id: &str,
    min_importance: i32,
    max_entries: i32,
) -> Result<Vec<MemoryRecord>> {
    database::open_connection(database_path)
        .and_then(|connection| {
            let sql = format!(
                "SELECT {MEMORY_COLUMNS} FROM project_memories
                  WHERE directory_id = ?1 AND status = 'active' AND importance >= ?2
                  ORDER BY importance DESC, updated_at DESC, id DESC
                  LIMIT ?3"
            );
            let mut statement = connection.prepare(&sql)?;
            let rows = statement.query_map(
                params![directory_id.trim(), min_importance, max_entries],
                map_memory_row,
            )?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        })
        .map_err(|error| database::database_error(database_path, "load injection memories", error))
}

// ---------------------------------------------------------------------------
// 检索打分
// ---------------------------------------------------------------------------

/// 按查询词检索记忆：标题/内容/标签命中加权 + 重要性 + 近期性 + 召回
/// 次数排序；同时为命中条目累加召回统计（治理衰减依据）。
/// `status_filter` 为 "active" / "pending" / "archived" / ""（active+pending）。
pub fn search_memories(
    database_path: &Path,
    directory_id: &str,
    query: &str,
    kind_filter: Option<&str>,
    status_filter: Option<&str>,
    limit: i32,
) -> Result<Vec<MemoryRecord>> {
    // —— 参数校验 ——
    let query = query.trim();
    if query.is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            "Search query must not be empty".to_string(),
        ));
    }
    let directory_id = directory_id.trim();
    if directory_id.is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            "Memory search requires a selected project (directory id)".to_string(),
        ));
    }
    let safe_limit = if limit > 0 { limit } else { 10 };
    let status_filter = status_filter.unwrap_or("");
    let status_explicit = MEMORY_STATUSES.contains(&status_filter);
    let kind_filter = kind_filter
        .map(str::trim)
        .filter(|value| MEMORY_KINDS.contains(value));

    // —— DB 操作 ——
    let connection = database::open_connection(database_path)
        .map_err(|error| database::database_error(database_path, "open database", error))?;
    let results = search_memories_with_connection(
        &connection,
        directory_id,
        query,
        status_filter,
        status_explicit,
        kind_filter,
        safe_limit,
    )
    .map_err(|error| database::database_error(database_path, "search memories", error))?;
    Ok(results)
}

fn search_memories_with_connection(
    connection: &Connection,
    directory_id: &str,
    query: &str,
    status_filter: &str,
    status_explicit: bool,
    kind_filter: Option<&str>,
    safe_limit: i32,
) -> rusqlite::Result<Vec<MemoryRecord>> {
    let mut sql = format!(
        "SELECT {MEMORY_COLUMNS} FROM project_memories WHERE directory_id = ?1"
    );
    if status_explicit {
        sql.push_str(" AND status = ?2");
    } else {
        sql.push_str(" AND status IN ('active', 'pending')");
    }
    if kind_filter.is_some() {
        sql.push_str(" AND kind = ?3");
    }
    sql.push_str(" ORDER BY importance DESC, updated_at DESC, id DESC");

    let mut statement = connection.prepare(&sql)?;
    let rows: Vec<MemoryRecord> = match (status_explicit, kind_filter) {
        (true, Some(kind)) => statement
            .query_map(params![directory_id, status_filter, kind], map_memory_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?,
        (true, None) => statement
            .query_map(params![directory_id, status_filter], map_memory_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?,
        (false, Some(kind)) => statement
            .query_map(params![directory_id, kind], map_memory_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?,
        (false, None) => statement
            .query_map(params![directory_id], map_memory_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?,
    };

    let now = chrono::Local::now().naive_local();
    let query_lower = query.to_lowercase();
    let tokens: Vec<String> = query_lower
        .split_whitespace()
        .filter(|token| !token.is_empty())
        .map(String::from)
        .collect();

    let mut scored: Vec<(f64, MemoryRecord)> = rows
        .into_iter()
        .filter_map(|record| {
            let (score, hit) = score_memory(&record, &query_lower, &tokens, now);
            hit.then(|| (score, record))
        })
        .collect();
    scored.sort_by(|a, b| {
        b.0.partial_cmp(&a.0)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let results: Vec<MemoryRecord> = scored
        .into_iter()
        .take(safe_limit as usize)
        .map(|(_, record)| record)
        .collect();

    // 累加召回统计（失败静默——统计仅用于治理，不影响检索结果）。
    for record in results.iter() {
        let _ = connection.execute(
            "UPDATE project_memories
                SET last_recalled_at = datetime('now', 'localtime'),
                    recall_count = recall_count + 1
              WHERE memory_id = ?1",
            params![record.memory_id],
        );
    }

    Ok(results)
}

/// 打分：返回 `(分数, 是否有文本命中)`。无任何文本命中的条目不进入
/// 结果（否则结果退化为按重要性的普通列表，失去检索意义）。
fn score_memory(
    record: &MemoryRecord,
    query_lower: &str,
    tokens: &[String],
    now: NaiveDateTime,
) -> (f64, bool) {
    let title_lower = record.title.to_lowercase();
    let content_lower = record.content.to_lowercase();
    let mut score = 0.0f64;
    let mut hit = false;

    // 整句子串命中（对 CJK 无分词场景尤其重要）。
    if !query_lower.is_empty() && title_lower.contains(query_lower) {
        score += 6.0;
        hit = true;
    }
    if !query_lower.is_empty() && content_lower.contains(query_lower) {
        score += 3.0;
        hit = true;
    }
    for token in tokens {
        // 单字符 ASCII token 噪声大，跳过；单 CJK 字符保留（有区分度）。
        if token.len() < 2 && token.chars().all(|c| c.is_ascii()) {
            continue;
        }
        if title_lower.contains(token.as_str()) {
            score += 3.0;
            hit = true;
        }
        if content_lower.contains(token.as_str()) {
            score += 1.5;
            hit = true;
        }
        if record.tags.iter().any(|tag| tag.to_lowercase() == *token) {
            score += 2.0;
            hit = true;
        }
    }

    // 重要性（1-5）：稳定的基础权重。
    score += record.importance as f64;
    // 近期性：90 天内线性衰减的加成。
    if let Ok(updated_at) = NaiveDateTime::parse_from_str(&record.updated_at, "%Y-%m-%d %H:%M:%S") {
        let days = (now - updated_at).num_days().max(0) as f64;
        score += 2.0 * (1.0 - (days / 90.0).min(1.0));
    }
    // 召回次数：微弱加成，封顶避免热条目固化。
    score += 0.1 * record.recall_count.min(10) as f64;

    (score, hit)
}
