use std::path::Path;

use napi::bindgen_prelude::*;
use rusqlite::{params, Connection};

use super::super::database;

/// Status of a persisted embedding session.
///
/// - `running`: the embedding loop is currently active in-memory.
/// - `paused`: the user explicitly paused; the loop is waiting on a Notify.
/// - `interrupted`: the app was closed (gracefully or not) while the session
///   was still `running` or `paused`. Detected on next startup by
///   `mark_interrupted_sessions`.
/// - `done`: the embedding completed successfully.
/// - `error`: the embedding failed with an unrecoverable error.
/// - `cancelled`: the user cancelled the embedding.
pub const STATUS_RUNNING: &str = "running";
pub const STATUS_PAUSED: &str = "paused";
pub const STATUS_DONE: &str = "done";
pub const STATUS_ERROR: &str = "error";

/// A persisted embedding session record. Stored in the
/// `codebase_embed_sessions` table so that pause state survives app restarts
/// and unexpected crashes.
#[derive(Debug, Clone)]
pub struct EmbedSessionRecord {
    pub session_id: String,
    pub project_id: String,
    pub status: String,
    pub total_files: i32,
    pub processed_files: i32,
    pub total_chunks: i32,
    pub processed_chunks: i32,
    pub current_file: String,
    pub error: String,
    pub created_at: String,
    pub updated_at: String,
}

/// Ensure the `codebase_embed_sessions` table exists. Called from
/// `database::ensure_database` during schema creation.
pub fn ensure_sessions_table(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS codebase_embed_sessions (
           session_id TEXT PRIMARY KEY NOT NULL,
           project_id TEXT NOT NULL,
           status TEXT NOT NULL DEFAULT 'running',
           total_files INTEGER NOT NULL DEFAULT 0,
           processed_files INTEGER NOT NULL DEFAULT 0,
           total_chunks INTEGER NOT NULL DEFAULT 0,
           processed_chunks INTEGER NOT NULL DEFAULT 0,
           current_file TEXT NOT NULL DEFAULT '',
           error TEXT NOT NULL DEFAULT '',
           created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
           updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
         );
         CREATE INDEX IF NOT EXISTS idx_codebase_embed_sessions_project
           ON codebase_embed_sessions(project_id);
         CREATE INDEX IF NOT EXISTS idx_codebase_embed_sessions_status
           ON codebase_embed_sessions(status);",
    )
}

/// Insert or replace a session record (used when starting a new embedding).
pub fn upsert_session(database_path: &Path, record: &EmbedSessionRecord) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|connection| {
            connection.execute(
                "INSERT INTO codebase_embed_sessions
                   (session_id, project_id, status, total_files, processed_files,
                    total_chunks, processed_chunks, current_file, error,
                    created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                 ON CONFLICT(session_id) DO UPDATE SET
                   status = excluded.status,
                   total_files = excluded.total_files,
                   processed_files = excluded.processed_files,
                   total_chunks = excluded.total_chunks,
                   processed_chunks = excluded.processed_chunks,
                   current_file = excluded.current_file,
                    error = excluded.error,
                    updated_at = datetime('now', 'localtime')",
                params![
                    &record.session_id,
                    &record.project_id,
                    &record.status,
                    record.total_files,
                    record.processed_files,
                    record.total_chunks,
                    record.processed_chunks,
                    &record.current_file,
                    &record.error,
                    &record.created_at,
                    &record.updated_at,
                ],
            )
        })
        .map_err(|error| database_error(database_path, "upsert codebase embed session", error))?;
    Ok(())
}

/// Update only the progress fields of a session (called from the progress
/// callback during embedding). Keeps status unchanged.
pub fn update_session_progress(
    database_path: &Path,
    session_id: &str,
    total_files: i32,
    processed_files: i32,
    total_chunks: i32,
    processed_chunks: i32,
    current_file: &str,
) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|connection| {
            connection.execute(
                "UPDATE codebase_embed_sessions
                 SET total_files = ?2,
                     processed_files = ?3,
                     total_chunks = ?4,
                     processed_chunks = ?5,
                     current_file = ?6,
                     updated_at = datetime('now', 'localtime')
                 WHERE session_id = ?1",
                params![
                    session_id,
                    total_files,
                    processed_files,
                    total_chunks,
                    processed_chunks,
                    current_file,
                ],
            )
        })
        .map_err(|error| database_error(database_path, "update codebase embed progress", error))?;
    Ok(())
}

/// Update the status (and optionally the error message) of a session.
pub fn update_session_status(
    database_path: &Path,
    session_id: &str,
    status: &str,
    error: Option<&str>,
) -> Result<()> {
    let error_value = error.unwrap_or("");
    database::open_connection(database_path)
        .and_then(|connection| {
            connection.execute(
                "UPDATE codebase_embed_sessions
                 SET status = ?2,
                     error = ?3,
                     updated_at = datetime('now', 'localtime')
                 WHERE session_id = ?1",
                params![session_id, status, error_value],
            )
        })
        .map_err(|error| database_error(database_path, "update codebase embed status", error))?;
    Ok(())
}

/// Delete a session record (used when embedding completes/cancels and the
/// record is no longer needed).
pub fn delete_session(database_path: &Path, session_id: &str) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|connection| {
            connection.execute(
                "DELETE FROM codebase_embed_sessions WHERE session_id = ?1",
                params![session_id],
            )
        })
        .map_err(|error| database_error(database_path, "delete codebase embed session", error))?;
    Ok(())
}

/// List all sessions for a project that are in a resumable state
/// (`paused` or `interrupted`). Ordered by most recently updated first.
pub fn list_resumable_sessions(
    database_path: &Path,
    project_id: &str,
) -> Result<Vec<EmbedSessionRecord>> {
    let records = database::open_connection(database_path)
        .and_then(|connection| {
            let mut statement = connection.prepare(
                "SELECT session_id, project_id, status, total_files, processed_files,
                        total_chunks, processed_chunks, current_file, error,
                        created_at, updated_at
                 FROM codebase_embed_sessions
                 WHERE project_id = ?1 AND status IN ('paused', 'interrupted')
                 ORDER BY updated_at DESC",
            )?;
            let rows = statement.query_map(params![project_id], |row| {
                Ok(EmbedSessionRecord {
                    session_id: row.get(0)?,
                    project_id: row.get(1)?,
                    status: row.get(2)?,
                    total_files: row.get(3)?,
                    processed_files: row.get(4)?,
                    total_chunks: row.get(5)?,
                    processed_chunks: row.get(6)?,
                    current_file: row.get(7)?,
                    error: row.get(8)?,
                    created_at: row.get(9)?,
                    updated_at: row.get(10)?,
                })
            })?;
            let mut collected = Vec::new();
            for row in rows {
                collected.push(row?);
            }
            Ok(collected)
        })
        .map_err(|error| {
            database_error(database_path, "list resumable codebase sessions", error)
        })?;
    Ok(records)
}

/// Mark all sessions that are still `running` or `paused` as `interrupted`.
/// Called once during `initialize_app_storage` to recover from an unexpected
/// shutdown (crash, power loss, task kill). After this call, those sessions
/// become resumable via `list_resumable_sessions`.
pub fn mark_interrupted_sessions(database_path: &Path) -> Result<u32> {
    let updated = database::open_connection(database_path)
        .and_then(|connection| {
            connection.execute(
                "UPDATE codebase_embed_sessions
                 SET status = 'interrupted',
                     updated_at = datetime('now', 'localtime')
                 WHERE status IN ('running', 'paused')",
                [],
            )
        })
        .map_err(|error| {
            database_error(database_path, "mark interrupted codebase sessions", error)
        })?;
    u32::try_from(updated).map_err(|_| {
        Error::new(
            Status::GenericFailure,
            "Interrupted session count exceeds u32 range".to_string(),
        )
    })
}

/// Delete all session records for a project (used when clearing the index).
pub fn delete_sessions_for_project(database_path: &Path, project_id: &str) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|connection| {
            connection.execute(
                "DELETE FROM codebase_embed_sessions WHERE project_id = ?1",
                params![project_id],
            )
        })
        .map_err(|error| {
            database_error(database_path, "delete codebase sessions for project", error)
        })?;
    Ok(())
}

fn database_error(database_path: &Path, action: &str, error: rusqlite::Error) -> Error {
    database::database_error(database_path, action, error)
}
