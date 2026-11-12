use std::path::Path;

use napi::bindgen_prelude::*;
use rusqlite::{params, Connection, Row, TransactionBehavior};

use super::super::database;
use super::super::{MemoCountSummary, MemoPage, MemoRecord};

/// SQLite 绑定变量上限保护：IN 子句按 900 一批分块执行。
const MEMO_SQL_CHUNK: usize = 900;

/// Creates a new memo from the given rich-text content. The content is
/// stored verbatim; the caller (frontend) is responsible for sanitising
/// it when rendering. Returns the freshly created record so the UI can
/// prepend it to the list without an extra round-trip.
pub fn create_memo(database_path: &Path, directory_id: &str, content: &str) -> Result<MemoRecord> {
    database::open_connection(database_path)
        .and_then(|connection| create_memo_with_connection(&connection, directory_id, content))
        .map_err(|error| database::database_error(database_path, "create memo", error))
}

/// Lists a page of memos ordered by the selected timestamp column.
/// `status_filter` accepts "", "pending" or "done"; empty means all.
/// `sort_field` accepts "created" or "updated" (default "updated").
/// `sort_order` accepts "asc" or "desc" (default "desc").
/// `keyword` is a substring match on the raw content (ASCII case-insensitive);
/// an empty keyword disables the text filter.
pub fn list_memos(
    database_path: &Path,
    directory_id: &str,
    limit: i32,
    offset: i32,
    status_filter: Option<&str>,
    sort_field: Option<&str>,
    sort_order: Option<&str>,
    keyword: Option<&str>,
) -> Result<MemoPage> {
    database::open_connection(database_path)
        .and_then(|connection| {
            query_memos_page(
                &connection,
                directory_id,
                status_filter.unwrap_or(""),
                sort_field.unwrap_or(""),
                sort_order.unwrap_or("desc"),
                keyword.unwrap_or(""),
                limit,
                offset,
            )
        })
        .map_err(|error| database::database_error(database_path, "list memos", error))
}

/// 按 memo_id 读取单条备忘，不存在返回 None。
pub fn get_memo(database_path: &Path, memo_id: &str) -> Result<Option<MemoRecord>> {
    database::open_connection(database_path)
        .and_then(|connection| fetch_memo_by_id(&connection, memo_id))
        .map_err(|error| database::database_error(database_path, "get memo", error))
}

/// Updates the content of an existing memo and refreshes `updated_at`.
/// Returns the updated record, or an error if no row matched `memo_id`.
pub fn update_memo_content(
    database_path: &Path,
    memo_id: &str,
    content: &str,
) -> Result<MemoRecord> {
    database::open_connection(database_path)
        .and_then(|connection| {
            let updated = update_memo_content_with_connection(&connection, memo_id, content)?;
            updated.ok_or(rusqlite::Error::QueryReturnedNoRows)
        })
        .map_err(|error| database::database_error(database_path, "update memo content", error))
}

/// Sets the status of a memo ("pending" or "done").
/// Returns the updated record, or an error if no row matched `memo_id`.
pub fn update_memo_status(database_path: &Path, memo_id: &str, status: &str) -> Result<MemoRecord> {
    let normalized = normalize_status(status);
    database::open_connection(database_path)
        .and_then(|connection| {
            let updated = set_memo_status_with_connection(&connection, memo_id, normalized)?;
            updated.ok_or(rusqlite::Error::QueryReturnedNoRows)
        })
        .map_err(|error| database::database_error(database_path, "update memo status", error))
}

/// Deletes a memo permanently.
pub fn delete_memo(database_path: &Path, memo_id: &str) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|connection| {
            connection.execute("DELETE FROM memos WHERE memo_id = ?1", params![memo_id])?;
            Ok(())
        })
        .map_err(|error| database::database_error(database_path, "delete memo", error))
}

/// 按 memo_id 批量删除备忘。单个 IMMEDIATE 事务保证原子性，返回删除条数；
/// 不存在的 id 静默跳过。
pub fn delete_memos_by_ids(database_path: &Path, memo_ids: &[String]) -> Result<i32> {
    let ids: Vec<String> = memo_ids
        .iter()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect();
    if ids.is_empty() {
        return Ok(0);
    }

    let mut connection = database::open_connection(database_path)
        .map_err(|error| database::database_error(database_path, "delete memos by ids", error))?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| database::database_error(database_path, "delete memos by ids", error))?;
    let deleted = delete_memos_by_ids_with_connection(&transaction, &ids)
        .map_err(|error| database::database_error(database_path, "delete memos by ids", error))?;
    transaction
        .commit()
        .map_err(|error| database::database_error(database_path, "delete memos by ids", error))?;
    Ok(deleted)
}

fn delete_memos_by_ids_with_connection(
    connection: &Connection,
    memo_ids: &[String],
) -> rusqlite::Result<i32> {
    let mut deleted = 0i32;
    for chunk in memo_ids.chunks(MEMO_SQL_CHUNK) {
        let placeholders = chunk
            .iter()
            .enumerate()
            .map(|(index, _)| format!("?{}", index + 1))
            .collect::<Vec<_>>()
            .join(", ");
        let mut statement =
            connection.prepare(&format!("DELETE FROM memos WHERE memo_id IN ({placeholders})"))?;
        deleted += statement.execute(rusqlite::params_from_iter(chunk.iter().cloned()))? as i32;
    }
    Ok(deleted)
}

/// Returns total / pending / done memo counts for the sidebar badge,
/// scoped to `directory_id`.
pub fn get_memo_count_summary(
    database_path: &Path,
    directory_id: &str,
) -> Result<MemoCountSummary> {
    database::open_connection(database_path)
        .and_then(|connection| {
            let total: i32 = connection.query_row(
                "SELECT COUNT(*) FROM memos WHERE directory_id = ?1",
                params![directory_id],
                |row| row.get(0),
            )?;
            let pending: i32 = connection.query_row(
                "SELECT COUNT(*) FROM memos WHERE directory_id = ?1 AND status = 'pending'",
                params![directory_id],
                |row| row.get(0),
            )?;
            let done: i32 = connection.query_row(
                "SELECT COUNT(*) FROM memos WHERE directory_id = ?1 AND status = 'done'",
                params![directory_id],
                |row| row.get(0),
            )?;
            Ok(MemoCountSummary {
                total,
                pending,
                done,
            })
        })
        .map_err(|error| database::database_error(database_path, "count memos", error))
}

fn create_memo_with_connection(
    connection: &Connection,
    directory_id: &str,
    content: &str,
) -> rusqlite::Result<MemoRecord> {
    let memo_id = database::create_snowflake_id();
    connection.execute(
        "INSERT INTO memos (id, memo_id, directory_id, content, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'pending', datetime('now', 'localtime'), datetime('now', 'localtime'))",
        params![
            database::create_snowflake_id(),
            memo_id,
            directory_id,
            content
        ],
    )?;

    fetch_memo_by_id(connection, &memo_id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
}

fn query_memos_page(
    connection: &Connection,
    directory_id: &str,
    status_filter: &str,
    sort_field: &str,
    sort_order: &str,
    keyword: &str,
    limit: i32,
    offset: i32,
) -> rusqlite::Result<MemoPage> {
    let safe_limit = if limit > 0 { limit } else { 20 };
    let safe_offset = if offset > 0 { offset } else { 0 };
    let direction = if sort_order.eq_ignore_ascii_case("asc") {
        "ASC"
    } else {
        "DESC"
    };
    let sort_column = if sort_field.eq_ignore_ascii_case("created") {
        "created_at"
    } else {
        "updated_at"
    };
    // 时间戳只精确到秒，同一秒内用自增 id 兜底，保证分页顺序稳定不重不漏。
    let order_clause = format!("ORDER BY {sort_column} {direction}, id {direction}");
    let status = normalize_status_filter(status_filter);
    let keyword_pattern = build_keyword_pattern(keyword);

    let total =
        count_memos_with_connection(connection, directory_id, status, keyword_pattern.as_deref())?;

    let mut statement = connection.prepare(&format!(
        "SELECT id, memo_id, directory_id, content, status, created_at, updated_at
           FROM memos
          WHERE directory_id = ?1
            AND (?2 IS NULL OR status = ?2)
            AND (?3 IS NULL OR content LIKE ?3 ESCAPE '\\')
          {order_clause}
          LIMIT ?4 OFFSET ?5"
    ))?;
    let items = statement
        .query_map(
            params![
                directory_id,
                status,
                keyword_pattern.as_deref(),
                safe_limit,
                safe_offset
            ],
            |row: &Row| map_memo_row(row),
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let has_more = (safe_offset + safe_limit) < total;

    Ok(MemoPage {
        items,
        total,
        has_more,
    })
}

/// 状态筛选归一化：仅 `pending` / `done` 生效，其余（含空串）视为不过滤。
fn normalize_status_filter(value: &str) -> Option<&'static str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "pending" => Some("pending"),
        "done" => Some("done"),
        _ => None,
    }
}

/// 关键词归一化为 `LIKE` 模式：转义 `%` / `_` / `\` 避免被当通配符，
/// 空关键词返回 `None`（SQL 对应「不过滤」分支）。SQLite 默认的 `LIKE`
/// 对 ASCII 不区分大小写，中文等无大小写字符按原样匹配。
fn build_keyword_pattern(keyword: &str) -> Option<String> {
    let trimmed = keyword.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut pattern = String::with_capacity(trimmed.len() + 2);
    pattern.push('%');
    for character in trimmed.chars() {
        if matches!(character, '%' | '_' | '\\') {
            pattern.push('\\');
        }
        pattern.push(character);
    }
    pattern.push('%');
    Some(pattern)
}

fn count_memos_with_connection(
    connection: &Connection,
    directory_id: &str,
    status: Option<&str>,
    keyword_pattern: Option<&str>,
) -> rusqlite::Result<i32> {
    connection.query_row(
        "SELECT COUNT(*) FROM memos
          WHERE directory_id = ?1
            AND (?2 IS NULL OR status = ?2)
            AND (?3 IS NULL OR content LIKE ?3 ESCAPE '\\')",
        params![directory_id, status, keyword_pattern],
        |row| row.get(0),
    )
}

fn update_memo_content_with_connection(
    connection: &Connection,
    memo_id: &str,
    content: &str,
) -> rusqlite::Result<Option<MemoRecord>> {
    connection.execute(
        "UPDATE memos
            SET content = ?1,
                updated_at = datetime('now', 'localtime')
          WHERE memo_id = ?2",
        params![content, memo_id],
    )?;
    fetch_memo_by_id(connection, memo_id)
}

fn set_memo_status_with_connection(
    connection: &Connection,
    memo_id: &str,
    status: &str,
) -> rusqlite::Result<Option<MemoRecord>> {
    connection.execute(
        "UPDATE memos
            SET status = ?1,
                updated_at = datetime('now', 'localtime')
          WHERE memo_id = ?2",
        params![status, memo_id],
    )?;
    fetch_memo_by_id(connection, memo_id)
}

fn fetch_memo_by_id(
    connection: &Connection,
    memo_id: &str,
) -> rusqlite::Result<Option<MemoRecord>> {
    let mut statement = connection.prepare(
        "SELECT id, memo_id, directory_id, content, status, created_at, updated_at
           FROM memos
          WHERE memo_id = ?1",
    )?;
    let mut rows = statement.query_map(params![memo_id], |row| map_memo_row(row))?;
    match rows.next() {
        Some(value) => Ok(Some(value?)),
        None => Ok(None),
    }
}

fn map_memo_row(row: &Row) -> rusqlite::Result<MemoRecord> {
    Ok(MemoRecord {
        id: row.get(0)?,
        memo_id: row.get(1)?,
        directory_id: row.get(2)?,
        content: row.get(3)?,
        status: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

fn normalize_status(status: &str) -> &'static str {
    match status.trim().to_ascii_lowercase().as_str() {
        "done" | "completed" | "finished" => "done",
        _ => "pending",
    }
}
