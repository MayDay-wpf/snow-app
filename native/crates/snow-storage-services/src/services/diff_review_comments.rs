use std::path::Path;

use napi::bindgen_prelude::*;
use rusqlite::{params, Connection, Row, TransactionBehavior};

use super::super::database;
use super::super::DiffReviewCommentRecord;

/// 列出某文件在本目录下的全部评论（按创建时间升序）。
pub fn list_diff_review_comments(
    database_path: &Path,
    directory_id: &str,
    file_path: &str,
) -> Result<Vec<DiffReviewCommentRecord>> {
    database::open_connection(database_path)
        .and_then(|connection| query_comments(&connection, directory_id, file_path))
        .map_err(|error| {
            database::database_error(database_path, "list diff review comments", error)
        })
}

/// 新增一条评论并返回落库后的完整记录。
pub fn create_diff_review_comment(
    database_path: &Path,
    directory_id: &str,
    file_path: &str,
    side: &str,
    line_number: i32,
    line_content: &str,
    content: &str,
) -> Result<DiffReviewCommentRecord> {
    database::with_write_lock(|| {
        database::with_write_retry(
            || {
                database::open_connection(database_path).and_then(|mut connection| {
                    let transaction =
                        connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
                    let comment_id = database::create_snowflake_id();
                    transaction.execute(
                        "INSERT INTO diff_review_comments (
                           id, comment_id, directory_id, file_path, side,
                           line_number, line_content, content, created_at, updated_at
                         ) VALUES (
                           ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
                           datetime('now', 'localtime'), datetime('now', 'localtime')
                         )",
                        params![
                            database::create_snowflake_id(),
                            comment_id,
                            directory_id,
                            file_path,
                            side,
                            line_number,
                            line_content,
                            content
                        ],
                    )?;
                    let record = fetch_comment_by_id(&transaction, &comment_id)?
                        .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
                    transaction.commit()?;
                    Ok(record)
                })
            },
            "create diff review comment",
        )
    })
    .map_err(|error| database::database_error(database_path, "create diff review comment", error))
}

/// 更新评论正文并刷新 `updated_at`，返回更新后的记录。
pub fn update_diff_review_comment(
    database_path: &Path,
    comment_id: &str,
    content: &str,
) -> Result<DiffReviewCommentRecord> {
    database::with_write_lock(|| {
        database::with_write_retry(
            || {
                database::open_connection(database_path).and_then(|mut connection| {
                    let transaction =
                        connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
                    transaction.execute(
                        "UPDATE diff_review_comments
                            SET content = ?1,
                                updated_at = datetime('now', 'localtime')
                          WHERE comment_id = ?2",
                        params![content, comment_id],
                    )?;
                    let record = fetch_comment_by_id(&transaction, comment_id)?
                        .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
                    transaction.commit()?;
                    Ok(record)
                })
            },
            "update diff review comment",
        )
    })
    .map_err(|error| database::database_error(database_path, "update diff review comment", error))
}

/// 删除单条评论。
pub fn delete_diff_review_comment(database_path: &Path, comment_id: &str) -> Result<()> {
    database::with_write_lock(|| {
        database::with_write_retry(
            || {
                database::open_connection(database_path).and_then(|mut connection| {
                    let transaction =
                        connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
                    transaction.execute(
                        "DELETE FROM diff_review_comments WHERE comment_id = ?1",
                        params![comment_id],
                    )?;
                    transaction.commit()
                })
            },
            "delete diff review comment",
        )
    })
    .map_err(|error| database::database_error(database_path, "delete diff review comment", error))
}

/// 清空某文件在本目录下的全部评论，返回删除条数。
pub fn delete_diff_review_comments_for_file(
    database_path: &Path,
    directory_id: &str,
    file_path: &str,
) -> Result<u32> {
    database::with_write_lock(|| {
        database::with_write_retry(
            || {
                database::open_connection(database_path).and_then(|mut connection| {
                    let transaction =
                        connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
                    let removed = transaction.execute(
                        "DELETE FROM diff_review_comments
                          WHERE directory_id = ?1 AND file_path = ?2",
                        params![directory_id, file_path],
                    )?;
                    transaction.commit()?;
                    Ok(removed as u32)
                })
            },
            "clear diff review comments",
        )
    })
    .map_err(|error| database::database_error(database_path, "clear diff review comments", error))
}

fn query_comments(
    connection: &Connection,
    directory_id: &str,
    file_path: &str,
) -> rusqlite::Result<Vec<DiffReviewCommentRecord>> {
    let mut statement = connection.prepare(
        "SELECT id, comment_id, directory_id, file_path, side, line_number,
                line_content, content, created_at, updated_at
           FROM diff_review_comments
          WHERE directory_id = ?1 AND file_path = ?2
          ORDER BY created_at ASC, id ASC",
    )?;
    let rows = statement.query_map(params![directory_id, file_path], map_comment_row)?;
    rows.collect()
}

fn fetch_comment_by_id(
    connection: &Connection,
    comment_id: &str,
) -> rusqlite::Result<Option<DiffReviewCommentRecord>> {
    let mut statement = connection.prepare(
        "SELECT id, comment_id, directory_id, file_path, side, line_number,
                line_content, content, created_at, updated_at
           FROM diff_review_comments
          WHERE comment_id = ?1",
    )?;
    let mut rows = statement.query_map(params![comment_id], map_comment_row)?;
    match rows.next() {
        Some(value) => Ok(Some(value?)),
        None => Ok(None),
    }
}

fn map_comment_row(row: &Row) -> rusqlite::Result<DiffReviewCommentRecord> {
    Ok(DiffReviewCommentRecord {
        id: row.get(0)?,
        comment_id: row.get(1)?,
        directory_id: row.get(2)?,
        file_path: row.get(3)?,
        side: row.get(4)?,
        line_number: row.get(5)?,
        line_content: row.get(6)?,
        content: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}
