use std::path::Path;

use napi::bindgen_prelude::*;
use rusqlite::{params, Connection, Row};

use super::super::database;
use super::super::{RemoteDraftInput, RemoteDraftRecord};

pub fn ensure_remote_drafts_table(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS remote_drafts (
           id TEXT PRIMARY KEY NOT NULL,
           profile_id TEXT NOT NULL,
           workspace_id TEXT NOT NULL,
           remote_path TEXT NOT NULL,
           base_version_json TEXT NOT NULL DEFAULT '{}',
           content TEXT NOT NULL DEFAULT '',
           status TEXT NOT NULL DEFAULT 'pending',
           created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
           updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
           UNIQUE(profile_id, workspace_id, remote_path)
         );
         CREATE INDEX IF NOT EXISTS idx_remote_drafts_workspace_status
           ON remote_drafts(workspace_id, status, updated_at DESC);",
    )
}

pub fn list_remote_drafts(
    database_path: &Path,
    workspace_id: &str,
    profile_id: Option<&str>,
) -> Result<Vec<RemoteDraftRecord>> {
    database::open_connection(database_path)
        .and_then(|connection| {
            let mut statement = if profile_id.is_some() {
                connection.prepare(
                    "SELECT id, profile_id, workspace_id, remote_path, base_version_json, content, status, updated_at
                       FROM remote_drafts
                      WHERE workspace_id = ?1 AND profile_id = ?2
                      ORDER BY updated_at DESC, id DESC",
                )?
            } else {
                connection.prepare(
                    "SELECT id, profile_id, workspace_id, remote_path, base_version_json, content, status, updated_at
                       FROM remote_drafts
                      WHERE workspace_id = ?1
                      ORDER BY updated_at DESC, id DESC",
                )?
            };
            let rows = if let Some(profile_id) = profile_id {
                statement.query_map(params![workspace_id, profile_id], map_draft_row)?
            } else {
                statement.query_map(params![workspace_id], map_draft_row)?
            };
            rows.collect::<rusqlite::Result<Vec<_>>>()
        })
        .map_err(|error| database::database_error(database_path, "list remote drafts", error))
}

pub fn upsert_remote_draft(
    database_path: &Path,
    item: &RemoteDraftInput,
) -> Result<RemoteDraftRecord> {
    validate_draft(item)?;
    database::open_connection(database_path)
        .and_then(|connection| {
            connection.execute(
                "INSERT INTO remote_drafts (
                   id, profile_id, workspace_id, remote_path, base_version_json, content, status, created_at, updated_at
                 ) VALUES (
                   ?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now', 'localtime'), datetime('now', 'localtime')
                 ) ON CONFLICT(profile_id, workspace_id, remote_path) DO UPDATE SET
                   base_version_json = excluded.base_version_json,
                   content = excluded.content,
                   status = excluded.status,
                   updated_at = datetime('now', 'localtime')",
                params![
                    database::create_snowflake_id(),
                    &item.profile_id,
                    &item.workspace_id,
                    &item.remote_path,
                    &item.base_version_json,
                    &item.content,
                    &item.status,
                ],
            )?;
            connection.query_row(
                "SELECT id, profile_id, workspace_id, remote_path, base_version_json, content, status, updated_at
                   FROM remote_drafts
                  WHERE profile_id = ?1 AND workspace_id = ?2 AND remote_path = ?3",
                params![&item.profile_id, &item.workspace_id, &item.remote_path],
                map_draft_row,
            )
        })
        .map_err(|error| database::database_error(database_path, "upsert remote draft", error))
}

pub fn delete_remote_draft(
    database_path: &Path,
    profile_id: &str,
    workspace_id: &str,
    remote_path: &str,
) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|connection| {
            connection.execute(
                "DELETE FROM remote_drafts
                  WHERE profile_id = ?1 AND workspace_id = ?2 AND remote_path = ?3",
                params![profile_id, workspace_id, remote_path],
            )?;
            Ok(())
        })
        .map_err(|error| database::database_error(database_path, "delete remote draft", error))
}

fn validate_draft(item: &RemoteDraftInput) -> Result<()> {
    if !item.profile_id.starts_with("ssh-profile:") {
        return Err(Error::from_reason(
            "Remote draft profile ID is invalid".to_string(),
        ));
    }
    if item.workspace_id.trim().is_empty() || item.remote_path.trim().is_empty() {
        return Err(Error::from_reason(
            "Remote draft workspace and path are required".to_string(),
        ));
    }
    if !matches!(item.status.as_str(), "pending" | "conflict") {
        return Err(Error::from_reason(
            "Remote draft status is invalid".to_string(),
        ));
    }
    serde_json::from_str::<serde_json::Value>(&item.base_version_json)
        .map_err(|_| Error::from_reason("Remote draft base version must be JSON".to_string()))?;
    Ok(())
}

fn map_draft_row(row: &Row) -> rusqlite::Result<RemoteDraftRecord> {
    Ok(RemoteDraftRecord {
        id: row.get(0)?,
        profile_id: row.get(1)?,
        workspace_id: row.get(2)?,
        remote_path: row.get(3)?,
        base_version_json: row.get(4)?,
        content: row.get(5)?,
        status: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

