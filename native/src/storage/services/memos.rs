use std::path::Path;

use napi::bindgen_prelude::*;
use rusqlite::{params, Connection, Row};

use super::super::database;
use super::super::{MemoCountSummary, MemoPage, MemoRecord};

/// Creates a new memo from the given rich-text content. The content is
/// stored verbatim; the caller (frontend) is responsible for sanitising
/// it when rendering. Returns the freshly created record so the UI can
/// prepend it to the list without an extra round-trip.
pub fn create_memo(database_path: &Path, directory_id: &str, content: &str) -> Result<MemoRecord> {
    database::open_connection(database_path)
        .and_then(|connection| create_memo_with_connection(&connection, directory_id, content))
        .map_err(|error| database::database_error(database_path, "create memo", error))
}

/// Lists a page of memos ordered by creation time descending.
/// `status_filter` accepts "", "pending" or "done"; empty means all.
pub fn list_memos(
    database_path: &Path,
    directory_id: &str,
    limit: i32,
    offset: i32,
    status_filter: Option<&str>,
) -> Result<MemoPage> {
    database::open_connection(database_path)
        .and_then(|connection| {
            query_memos_page(
                &connection,
                directory_id,
                status_filter.unwrap_or(""),
                limit,
                offset,
            )
        })
        .map_err(|error| database::database_error(database_path, "list memos", error))
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
    limit: i32,
    offset: i32,
) -> rusqlite::Result<MemoPage> {
    let safe_limit = if limit > 0 { limit } else { 20 };
    let safe_offset = if offset > 0 { offset } else { 0 };

    let total = count_memos_with_connection(connection, directory_id, status_filter)?;
    let items = if matches!(status_filter, "" | "pending" | "done") {
        let mut statement = if status_filter.is_empty() {
            connection.prepare(
                "SELECT id, memo_id, directory_id, content, status, created_at, updated_at
                   FROM memos
                  WHERE directory_id = ?1
                  ORDER BY created_at DESC, id DESC
                  LIMIT ?2 OFFSET ?3",
            )?
        } else {
            connection.prepare(
                "SELECT id, memo_id, directory_id, content, status, created_at, updated_at
                   FROM memos
                  WHERE directory_id = ?1 AND status = ?2
                  ORDER BY created_at DESC, id DESC
                  LIMIT ?3 OFFSET ?4",
            )?
        };

        let row_mapper = |row: &Row| map_memo_row(row);
        let rows = if status_filter.is_empty() {
            statement.query_map(params![directory_id, safe_limit, safe_offset], row_mapper)?
        } else {
            statement.query_map(
                params![directory_id, status_filter, safe_limit, safe_offset],
                row_mapper,
            )?
        };
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    } else {
        Vec::new()
    };

    let has_more = (safe_offset + safe_limit) < total;

    Ok(MemoPage {
        items,
        total,
        has_more,
    })
}

fn count_memos_with_connection(
    connection: &Connection,
    directory_id: &str,
    status_filter: &str,
) -> rusqlite::Result<i32> {
    let count: i32 = if status_filter.is_empty() {
        connection.query_row(
            "SELECT COUNT(*) FROM memos WHERE directory_id = ?1",
            params![directory_id],
            |row| row.get(0),
        )?
    } else if matches!(status_filter, "pending" | "done") {
        connection.query_row(
            "SELECT COUNT(*) FROM memos WHERE directory_id = ?1 AND status = ?2",
            params![directory_id, status_filter],
            |row| row.get(0),
        )?
    } else {
        0
    };
    Ok(count)
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
