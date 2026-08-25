//! 项目合集（project collections）的持久化服务。
//!
//! 合集是纯元数据（名称 + 收纳的项目 directory_id 列表），不对应磁盘目录，
//! 也不会参与「激活/会话挂载」等目录逻辑——仅用于侧边栏收纳与整理项目。

use std::path::Path;

use napi::bindgen_prelude::*;
use rusqlite::{params, Connection};

use super::super::database;
use super::super::ProjectCollectionRecord;

pub fn list_project_collections(database_path: &Path) -> Result<Vec<ProjectCollectionRecord>> {
    database::open_connection(database_path)
        .and_then(|connection| query_project_collections(&connection))
        .map_err(|error| {
            database::database_error(database_path, "list project collections", error)
        })
}

pub fn create_project_collection(database_path: &Path, name: &str) -> Result<()> {
    let trimmed = validate_collection_name(name)?;

    database::open_connection(database_path)
        .and_then(|connection| {
            connection.execute(
                "INSERT INTO project_collections (
                   id,
                   collection_id,
                   name,
                   sort_order,
                   created_at,
                   updated_at
                 ) VALUES (?1, ?2, ?3, ?4, datetime('now', 'localtime'), datetime('now', 'localtime'))",
                params![
                    database::create_snowflake_id(),
                    database::create_snowflake_id(),
                    trimmed,
                    0,
                ],
            )?;
            Ok(())
        })
        .map_err(|error| {
            database::database_error(database_path, "create project collection", error)
        })
}

pub fn rename_project_collection(
    database_path: &Path,
    collection_id: &str,
    name: &str,
) -> Result<()> {
    let trimmed = validate_collection_name(name)?;

    database::open_connection(database_path)
        .and_then(|connection| {
            let updated = connection.execute(
                "UPDATE project_collections
                    SET name = ?1,
                        updated_at = datetime('now', 'localtime')
                  WHERE collection_id = ?2",
                params![trimmed, collection_id],
            )?;
            if updated == 0 {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }
            Ok(())
        })
        .map_err(|error| {
            database::database_error(database_path, "rename project collection", error)
        })
}

pub fn delete_project_collection(database_path: &Path, collection_id: &str) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|mut connection| {
            // 不使用外键级联：在同一事务中先删除成员记录，再删除合集本体
            let transaction = connection.transaction()?;
            transaction.execute(
                "DELETE FROM collection_members WHERE collection_id = ?1",
                [collection_id],
            )?;
            transaction.execute(
                "DELETE FROM project_collections WHERE collection_id = ?1",
                [collection_id],
            )?;
            transaction.commit()
        })
        .map_err(|error| {
            database::database_error(database_path, "delete project collection", error)
        })
}

/// 把项目加入合集。幂等：重复加入同一项目时静默忽略。
///
/// 要求合集与项目（workspace_directories）都必须存在，避免产生孤儿成员记录。
pub fn add_project_to_collection(
    database_path: &Path,
    collection_id: &str,
    directory_id: &str,
) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|mut connection| {
            let transaction = connection.transaction()?;

            let collection_exists: bool = transaction.query_row(
                "SELECT EXISTS(
                   SELECT 1 FROM project_collections WHERE collection_id = ?1
                 )",
                [collection_id],
                |row| row.get(0),
            )?;
            if !collection_exists {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }

            let directory_exists: bool = transaction.query_row(
                "SELECT EXISTS(
                   SELECT 1 FROM workspace_directories WHERE directory_id = ?1
                 )",
                [directory_id],
                |row| row.get(0),
            )?;
            if !directory_exists {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }

            let next_sort_order: i32 = transaction.query_row(
                "SELECT COALESCE(MAX(sort_order) + 1, 0)
                   FROM collection_members
                  WHERE collection_id = ?1",
                [collection_id],
                |row| row.get(0),
            )?;

            transaction.execute(
                "INSERT OR IGNORE INTO collection_members (
                   id,
                   collection_id,
                   directory_id,
                   sort_order,
                   created_at
                 ) VALUES (?1, ?2, ?3, ?4, datetime('now', 'localtime'))",
                params![
                    database::create_snowflake_id(),
                    collection_id,
                    directory_id,
                    next_sort_order,
                ],
            )?;

            transaction.commit()
        })
        .map_err(|error| {
            database::database_error(database_path, "add project to collection", error)
        })
}

pub fn remove_project_from_collection(
    database_path: &Path,
    collection_id: &str,
    directory_id: &str,
) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|connection| {
            connection.execute(
                "DELETE FROM collection_members
                  WHERE collection_id = ?1 AND directory_id = ?2",
                params![collection_id, directory_id],
            )?;
            Ok(())
        })
        .map_err(|error| {
            database::database_error(database_path, "remove project from collection", error)
        })
}

fn validate_collection_name(name: &str) -> Result<&str> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(Error::from_reason(
            "Collection name is required and must be non-empty".to_string(),
        ));
    }
    if trimmed.chars().count() > 60 {
        return Err(Error::from_reason(
            "Collection name must be at most 60 characters".to_string(),
        ));
    }
    Ok(trimmed)
}

fn query_project_collections(
    connection: &Connection,
) -> rusqlite::Result<Vec<ProjectCollectionRecord>> {
    let mut statement = connection.prepare(
        "SELECT id,
                collection_id,
                name,
                sort_order,
                created_at,
                updated_at
           FROM project_collections
          ORDER BY sort_order ASC, id ASC",
    )?;

    let rows = statement.query_map([], |row| {
        let id: String = row.get(0)?;
        let collection_id: String = row.get(1)?;
        let name: String = row.get(2)?;
        let sort_order: i32 = row.get(3)?;
        let created_at: String = row.get(4)?;
        let updated_at: String = row.get(5)?;
        Ok((id, collection_id, name, sort_order, created_at, updated_at))
    })?;

    let mut collections = Vec::new();
    for row in rows {
        let (id, collection_id, name, sort_order, created_at, updated_at) = row?;
        let member_directory_ids = query_collection_members(connection, &collection_id)?;
        collections.push(ProjectCollectionRecord {
            id,
            collection_id,
            name,
            sort_order,
            member_directory_ids,
            created_at,
            updated_at,
        });
    }

    Ok(collections)
}

fn query_collection_members(
    connection: &Connection,
    collection_id: &str,
) -> rusqlite::Result<Vec<String>> {
    let mut statement = connection.prepare(
        "SELECT directory_id
           FROM collection_members
          WHERE collection_id = ?1
          ORDER BY sort_order ASC, id ASC",
    )?;
    let rows = statement.query_map([collection_id], |row| row.get::<_, String>(0))?;
    rows.collect()
}
