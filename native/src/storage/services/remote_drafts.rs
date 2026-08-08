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

#[cfg(test)]
mod tests {
    use std::{
        fs, process,
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::*;

    fn database_path() -> std::path::PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock is after Unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "snow-remote-drafts-{}-{timestamp}.sqlite",
            process::id()
        ))
    }

    #[test]
    fn upsert_preserves_one_draft_per_remote_file_and_keeps_conflicts() {
        let path = database_path();
        let connection = Connection::open(&path).expect("open database");
        ensure_remote_drafts_table(&connection).expect("create remote drafts table");
        drop(connection);

        let pending = RemoteDraftInput {
            profile_id: "ssh-profile:snow@example.test:22".to_string(),
            workspace_id: "ssh:ssh://snow@example.test:22/workspace".to_string(),
            remote_path: "/workspace/file.txt".to_string(),
            base_version_json: r#"{"exists":true,"sha256":"abc"}"#.to_string(),
            content: "first".to_string(),
            status: "pending".to_string(),
        };
        let created = upsert_remote_draft(&path, &pending).expect("create draft");
        let conflict = RemoteDraftInput {
            content: "second".to_string(),
            status: "conflict".to_string(),
            ..pending
        };
        let updated = upsert_remote_draft(&path, &conflict).expect("update draft");

        assert_eq!(created.id, updated.id);
        let drafts = list_remote_drafts(
            &path,
            "ssh:ssh://snow@example.test:22/workspace",
            Some("ssh-profile:snow@example.test:22"),
        )
        .expect("list drafts");
        assert_eq!(drafts.len(), 1);
        assert_eq!(drafts[0].content, "second");
        assert_eq!(drafts[0].status, "conflict");

        delete_remote_draft(
            &path,
            "ssh-profile:snow@example.test:22",
            "ssh:ssh://snow@example.test:22/workspace",
            "/workspace/file.txt",
        )
        .expect("delete draft");
        assert!(
            list_remote_drafts(&path, "ssh:ssh://snow@example.test:22/workspace", None,)
                .expect("list empty drafts")
                .is_empty()
        );

        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(path.with_extension("sqlite-wal"));
        let _ = fs::remove_file(path.with_extension("sqlite-shm"));
    }
}
