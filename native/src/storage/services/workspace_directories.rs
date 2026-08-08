use std::fs;
use std::path::Path;

use napi::bindgen_prelude::*;
use rusqlite::{params, Connection, OptionalExtension};

use super::super::database;
use super::super::{WorkspaceDirectoryInput, WorkspaceDirectoryRecord};

pub fn list_workspace_directories(database_path: &Path) -> Result<Vec<WorkspaceDirectoryRecord>> {
    database::open_connection(database_path)
        .and_then(|connection| query_workspace_directories(&connection))
        .map_err(|error| {
            database::database_error(database_path, "list workspace directories", error)
        })
}

/// 校验项目名是否合法：非空、不含路径分隔符与 Windows 保留字符、不是 "." 或 ".."。
fn validate_project_name(project_name: &str) -> Result<()> {
    let trimmed = project_name.trim();
    if trimmed.is_empty() {
        return Err(Error::from_reason(
            "Project name is required and must be non-empty".to_string(),
        ));
    }
    if trimmed == "." || trimmed == ".." {
        return Err(Error::from_reason(format!(
            "Invalid project name: \"{trimmed}\""
        )));
    }
    if trimmed.contains(['/', '\\']) {
        return Err(Error::from_reason(
            "Project name must not contain path separators".to_string(),
        ));
    }
    // Windows 不允许出现在目录名中的字符
    const INVALID_CHARS: &[char] = &['<', '>', ':', '"', '|', '?', '*'];
    if trimmed
        .chars()
        .any(|character| INVALID_CHARS.contains(&character))
    {
        return Err(Error::from_reason(format!(
            "Project name contains invalid characters: \"{trimmed}\""
        )));
    }
    Ok(())
}

/// 在 `parent_path` 下创建名为 `project_name` 的项目目录，返回完整路径。
/// 仅在目标目录尚不存在时创建；目录创建由调用方通过 spawn_blocking 异步执行。
pub fn create_project_directory(parent_path: &str, project_name: &str) -> Result<String> {
    validate_project_name(project_name)?;

    let parent = Path::new(parent_path);
    if !parent.is_dir() {
        return Err(Error::from_reason(format!(
            "Parent directory does not exist or is not a directory: '{}'",
            parent.display()
        )));
    }

    let target = parent.join(project_name.trim());
    if target.exists() {
        return Err(Error::from_reason(format!(
            "Target directory already exists: '{}'",
            target.display()
        )));
    }

    fs::create_dir(&target).map_err(|error| {
        Error::from_reason(format!(
            "Failed to create project directory at '{}': {error}",
            target.display()
        ))
    })?;

    Ok(target.to_string_lossy().to_string())
}

pub fn upsert_workspace_directory(
    database_path: &Path,
    item: &WorkspaceDirectoryInput,
) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|mut connection| {
            let transaction = connection.transaction()?;

            if item.is_active {
                transaction.execute(
                    "UPDATE workspace_directories
                        SET is_active = 0,
                            updated_at = datetime('now', 'localtime')
                      WHERE is_active = 1",
                    [],
                )?;
            }

            upsert_workspace_directory_with_connection(&transaction, item)?;
            transaction.commit()
        })
        .map_err(|error| {
            database::database_error(database_path, "upsert workspace directory", error)
        })
}

/// Look up the kind of a workspace directory by its `directory_id`.
/// Returns `Ok(None)` when the directory_id does not exist.
pub fn get_workspace_directory_kind(
    database_path: &Path,
    directory_id: &str,
) -> Result<Option<String>> {
    let trimmed = directory_id.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    database::open_connection(database_path)
        .and_then(|connection| {
            connection
                .query_row(
                    "SELECT kind FROM workspace_directories WHERE directory_id = ?1 LIMIT 1",
                    [trimmed],
                    |row| row.get::<_, String>(0),
                )
                .optional()
        })
        .map_err(|error| {
            database::database_error(database_path, "get workspace directory kind", error)
        })
}

/// Look up the filesystem path of a workspace directory by its `directory_id`.
/// Returns `Ok(None)` when the directory_id does not exist.
pub fn get_workspace_directory_path(
    database_path: &Path,
    directory_id: &str,
) -> Result<Option<String>> {
    let trimmed = directory_id.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    database::open_connection(database_path)
        .and_then(|connection| {
            connection
                .query_row(
                    "SELECT path FROM workspace_directories WHERE directory_id = ?1 LIMIT 1",
                    [trimmed],
                    |row| row.get::<_, String>(0),
                )
                .optional()
        })
        .map_err(|error| {
            database::database_error(database_path, "get workspace directory path", error)
        })
}

pub fn activate_workspace_directory(database_path: &Path, directory_id: &str) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|mut connection| {
            let transaction = connection.transaction()?;
            transaction.execute(
                "UPDATE workspace_directories
                    SET is_active = 0,
                        updated_at = datetime('now', 'localtime')
                  WHERE is_active = 1",
                [],
            )?;
            transaction.execute(
                "UPDATE workspace_directories
                    SET is_active = 1,
                        updated_at = datetime('now', 'localtime')
                  WHERE directory_id = ?1",
                [directory_id],
            )?;
            transaction.commit()
        })
        .map_err(|error| {
            database::database_error(database_path, "activate workspace directory", error)
        })
}

pub fn reorder_workspace_directories(
    database_path: &Path,
    items: &[WorkspaceDirectoryInput],
) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|mut connection| {
            let transaction = connection.transaction()?;

            for (index, item) in items.iter().enumerate() {
                transaction.execute(
                    "UPDATE workspace_directories
                        SET sort_order = ?1,
                            updated_at = datetime('now', 'localtime')
                      WHERE directory_id = ?2",
                    params![index as i32, &item.directory_id],
                )?;
            }

            transaction.commit()
        })
        .map_err(|error| {
            database::database_error(database_path, "reorder workspace directories", error)
        })
}

pub fn delete_workspace_directory(database_path: &Path, directory_id: &str) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|mut connection| {
            // 内置默认工作目录（source = "builtin"）不允许删除，
            // 保证系统始终至少有一个可用目录供会话记录挂载。
            let source: Option<String> = connection
                .query_row(
                    "SELECT source FROM workspace_directories WHERE directory_id = ?1",
                    [directory_id],
                    |row| row.get(0),
                )
                .optional()?;

            if source.as_deref() == Some(DEFAULT_WORKSPACE_SOURCE) {
                return Err(rusqlite::Error::SqliteFailure(
                    rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CONSTRAINT),
                    Some("Cannot delete the built-in default workspace directory".to_string()),
                ));
            }

            let transaction = connection.transaction()?;
            transaction.execute(
                "DELETE FROM workspace_directories WHERE directory_id = ?1",
                [directory_id],
            )?;
            normalize_workspace_directory_state(&transaction)?;
            transaction.commit()
        })
        .map_err(|error| {
            database::database_error(database_path, "delete workspace directory", error)
        })
}

fn normalize_workspace_directory_state(connection: &Connection) -> rusqlite::Result<()> {
    let directory_ids = {
        let mut statement = connection.prepare(
            "SELECT directory_id
               FROM workspace_directories
              ORDER BY sort_order ASC, id ASC",
        )?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<Vec<String>>>()?
    };

    for (index, directory_id) in directory_ids.iter().enumerate() {
        connection.execute(
            "UPDATE workspace_directories
                SET sort_order = ?1,
                    updated_at = datetime('now', 'localtime')
              WHERE directory_id = ?2",
            params![index as i32, directory_id],
        )?;
    }

    let active_count: i64 = connection.query_row(
        "SELECT COUNT(*) FROM workspace_directories WHERE is_active = 1",
        [],
        |row| row.get(0),
    )?;

    if active_count == 0 {
        if let Some(first_directory_id) = directory_ids.first() {
            connection.execute(
                "UPDATE workspace_directories
                SET is_active = 1,
                    updated_at = datetime('now', 'localtime')
              WHERE directory_id = ?1",
                [first_directory_id],
            )?;
        }
    }

    Ok(())
}

fn query_workspace_directories(
    connection: &Connection,
) -> rusqlite::Result<Vec<WorkspaceDirectoryRecord>> {
    let mut statement = connection.prepare(
        "SELECT id,
                directory_id,
                name,
                path,
                kind,
                is_active,
                sort_order,
                source,
                updated_at
           FROM workspace_directories
          ORDER BY sort_order ASC, id ASC",
    )?;

    let rows = statement.query_map([], |row| {
        let is_active: i64 = row.get(5)?;

        Ok(WorkspaceDirectoryRecord {
            id: row.get(0)?,
            directory_id: row.get(1)?,
            name: row.get(2)?,
            path: row.get(3)?,
            kind: row.get(4)?,
            is_active: is_active != 0,
            sort_order: row.get(6)?,
            source: row.get(7)?,
            updated_at: row.get(8)?,
        })
    })?;

    rows.collect()
}

fn upsert_workspace_directory_with_connection(
    connection: &Connection,
    item: &WorkspaceDirectoryInput,
) -> rusqlite::Result<()> {
    connection.execute(
        "INSERT INTO workspace_directories (
           id,
           directory_id,
           name,
           path,
           kind,
           is_active,
           sort_order,
           source,
           created_at,
           updated_at
         ) VALUES (
           ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, datetime('now', 'localtime'), datetime('now', 'localtime')
         )
         ON CONFLICT(directory_id) DO UPDATE SET
           name = excluded.name,
           path = excluded.path,
           kind = excluded.kind,
           is_active = excluded.is_active,
           sort_order = excluded.sort_order,
           source = excluded.source,
           updated_at = datetime('now', 'localtime')",
        params![
            database::create_snowflake_id(),
            item.directory_id,
            item.name,
            item.path,
            item.kind,
            item.is_active as i32,
            item.sort_order,
            item.source,
        ],
    )?;

    Ok(())
}

const DEFAULT_WORKSPACE_DIR_NAME: &str = "workspace";
const DEFAULT_WORKSPACE_DISPLAY_NAME: &str = "Default";
const DEFAULT_WORKSPACE_SOURCE: &str = "builtin";

/// 在 `~/.snowapp/workspace` 下创建内置默认工作目录，并在数据库中幂等插入一条
/// `source = "builtin"` 的 local 工作目录记录。确保即便用户未手动添加任何目录，
/// 会话记录（依赖 directory_id）等也能正常挂载与加载。
pub fn seed_default_workspace_directory(database_path: &Path) -> Result<()> {
    let storage_dir = crate::storage::paths::app_storage_dir()?;
    let default_workspace_path = storage_dir.join(DEFAULT_WORKSPACE_DIR_NAME);
    fs::create_dir_all(&default_workspace_path).map_err(|error| {
        Error::from_reason(format!(
            "Failed to create default workspace directory at '{}': {error}",
            default_workspace_path.display()
        ))
    })?;

    let default_path_str = default_workspace_path.to_string_lossy().to_string();
    let directory_id = format!("local:{}", default_path_str);

    database::open_connection(database_path)
        .and_then(|connection| {
            seed_default_workspace_directory_with_connection(
                &connection,
                &directory_id,
                &default_path_str,
            )
        })
        .map_err(|error| {
            database::database_error(database_path, "seed default workspace directory", error)
        })
}

fn seed_default_workspace_directory_with_connection(
    connection: &Connection,
    directory_id: &str,
    path: &str,
) -> rusqlite::Result<()> {
    connection.execute(
        "INSERT INTO workspace_directories (
           id,
           directory_id,
           name,
           path,
           kind,
           is_active,
           sort_order,
           source,
           created_at,
           updated_at
         )
         SELECT ?1, ?2, ?3, ?4, 'local', 1, 0, ?5,
                datetime('now', 'localtime'), datetime('now', 'localtime')
         WHERE NOT EXISTS (SELECT 1 FROM workspace_directories)",
        params![
            database::create_snowflake_id(),
            directory_id,
            DEFAULT_WORKSPACE_DISPLAY_NAME,
            path,
            DEFAULT_WORKSPACE_SOURCE,
        ],
    )?;

    ensure_one_active_directory(connection)
}

fn ensure_one_active_directory(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute(
        "UPDATE workspace_directories
            SET is_active = 1,
                updated_at = datetime('now', 'localtime')
          WHERE directory_id = (
            SELECT directory_id
              FROM workspace_directories
             ORDER BY sort_order ASC, id ASC
             LIMIT 1
          )
          AND NOT EXISTS (
            SELECT 1
              FROM workspace_directories
             WHERE is_active = 1
          )",
        [],
    )?;

    Ok(())
}
