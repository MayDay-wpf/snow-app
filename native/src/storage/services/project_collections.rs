//! 项目合集（project collections）的持久化服务。
//!
//! 合集是纯元数据（名称 + 收纳的项目 directory_id 列表），不对应磁盘目录，
//! 也不会参与「激活/会话挂载」等目录逻辑——仅用于侧边栏收纳与整理项目。

use std::collections::HashSet;
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

/// 校验错误：以 SQLITE_CONSTRAINT 形式的 rusqlite 错误表达，最终由
/// `database_error` 统一包装为 napi 错误抛给上层。
fn constraint_error(reason: &str) -> rusqlite::Error {
    rusqlite::Error::SqliteFailure(
        rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CONSTRAINT),
        Some(reason.to_string()),
    )
}

fn ensure_collection_exists(connection: &Connection, collection_id: &str) -> rusqlite::Result<()> {
    let exists: bool = connection.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM project_collections WHERE collection_id = ?1
         )",
        [collection_id],
        |row| row.get(0),
    )?;
    if !exists {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }
    Ok(())
}

fn ensure_workspace_directory_exists(
    connection: &Connection,
    directory_id: &str,
) -> rusqlite::Result<()> {
    let exists: bool = connection.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM workspace_directories WHERE directory_id = ?1
         )",
        [directory_id],
        |row| row.get(0),
    )?;
    if !exists {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }
    Ok(())
}

/// 校验 ordered_member_ids：无重复，且集合恰好等于 expected（该合集应有的
/// 完整成员集合）。要求调用方传入完整成员列表，避免部分更新造成成员丢失。
fn ensure_ordered_members_match(
    ordered_member_ids: &[String],
    expected: &HashSet<&str>,
) -> rusqlite::Result<()> {
    let mut seen: HashSet<&str> = HashSet::with_capacity(ordered_member_ids.len());
    for member_id in ordered_member_ids {
        if !seen.insert(member_id.as_str()) {
            return Err(constraint_error(
                "ordered member list contains duplicate ids",
            ));
        }
    }
    if seen != *expected {
        return Err(constraint_error(
            "ordered member list must contain exactly the collection members",
        ));
    }
    Ok(())
}

/// 按给定顺序重排合集内成员（同一事务中逐个更新 sort_order）。
///
/// ordered_member_ids 必须与该合集现有成员完全一致（仅顺序不同），否则报错，
/// 防止顺带删除或凭空添加成员。
pub fn reorder_project_collection_members(
    database_path: &Path,
    collection_id: &str,
    ordered_member_ids: &[String],
) -> Result<()> {
    database::with_write_lock(|| {
        database::with_write_retry(
            || {
                database::open_connection(database_path).and_then(|mut connection| {
                    let transaction = connection.transaction()?;

                    ensure_collection_exists(&transaction, collection_id)?;
                    let existing_member_ids =
                        query_collection_members(&transaction, collection_id)?;
                    let expected: HashSet<&str> = existing_member_ids
                        .iter()
                        .map(|id| id.as_str())
                        .collect();
                    ensure_ordered_members_match(ordered_member_ids, &expected)?;

                    for (index, directory_id) in ordered_member_ids.iter().enumerate() {
                        transaction.execute(
                            "UPDATE collection_members
                                SET sort_order = ?1
                              WHERE collection_id = ?2 AND directory_id = ?3",
                            params![index as i32, collection_id, directory_id],
                        )?;
                    }
                    transaction.execute(
                        "UPDATE project_collections
                            SET updated_at = datetime('now', 'localtime')
                          WHERE collection_id = ?1",
                        [collection_id],
                    )?;

                    transaction.commit()
                })
            },
            "reorder project collection members",
        )
    })
    .map_err(|error| {
        database::database_error(database_path, "reorder project collection members", error)
    })
}

/// 把项目移动到目标合集的指定位置。
///
/// 语义：项目从所有其它合集中移除，并确保加入目标合集，然后按
/// ordered_member_ids 重排目标合集（必须等于目标合集现有成员 ∪ {directory_id}）。
/// 若项目已是目标合集成员，等价于「确认归属 + 可选重排」。
pub fn move_project_to_collection(
    database_path: &Path,
    target_collection_id: &str,
    directory_id: &str,
    ordered_member_ids: &[String],
) -> Result<()> {
    database::with_write_lock(|| {
        database::with_write_retry(
            || {
                database::open_connection(database_path).and_then(|mut connection| {
                    let transaction = connection.transaction()?;

                    ensure_collection_exists(&transaction, target_collection_id)?;
                    ensure_workspace_directory_exists(&transaction, directory_id)?;

                    let existing_member_ids =
                        query_collection_members(&transaction, target_collection_id)?;
                    let mut expected: HashSet<&str> = existing_member_ids
                        .iter()
                        .map(|id| id.as_str())
                        .collect();
                    expected.insert(directory_id);
                    ensure_ordered_members_match(ordered_member_ids, &expected)?;

                    // 受影响的其它合集 updated_at 提前刷新（删除成员后就找不到它们了）
                    transaction.execute(
                        "UPDATE project_collections
                            SET updated_at = datetime('now', 'localtime')
                          WHERE collection_id IN (
                            SELECT DISTINCT collection_id
                              FROM collection_members
                             WHERE directory_id = ?1 AND collection_id != ?2
                          )",
                        params![directory_id, target_collection_id],
                    )?;
                    transaction.execute(
                        "DELETE FROM collection_members
                          WHERE directory_id = ?1 AND collection_id != ?2",
                        params![directory_id, target_collection_id],
                    )?;
                    transaction.execute(
                        "INSERT OR IGNORE INTO collection_members (
                           id,
                           collection_id,
                           directory_id,
                           sort_order,
                           created_at
                         ) VALUES (?1, ?2, ?3, 0, datetime('now', 'localtime'))",
                        params![
                            database::create_snowflake_id(),
                            target_collection_id,
                            directory_id,
                        ],
                    )?;

                    for (index, member_id) in ordered_member_ids.iter().enumerate() {
                        transaction.execute(
                            "UPDATE collection_members
                                SET sort_order = ?1
                              WHERE collection_id = ?2 AND directory_id = ?3",
                            params![index as i32, target_collection_id, member_id],
                        )?;
                    }
                    transaction.execute(
                        "UPDATE project_collections
                            SET updated_at = datetime('now', 'localtime')
                          WHERE collection_id = ?1",
                        [target_collection_id],
                    )?;

                    transaction.commit()
                })
            },
            "move project to collection",
        )
    })
    .map_err(|error| {
        database::database_error(database_path, "move project to collection", error)
    })
}

/// 把项目从所有合集中移出（回到顶层列表）。
pub fn remove_project_from_all_collections(
    database_path: &Path,
    directory_id: &str,
) -> Result<()> {
    database::with_write_lock(|| {
        database::with_write_retry(
            || {
                database::open_connection(database_path).and_then(|mut connection| {
                    let transaction = connection.transaction()?;

                    transaction.execute(
                        "UPDATE project_collections
                            SET updated_at = datetime('now', 'localtime')
                          WHERE collection_id IN (
                            SELECT DISTINCT collection_id
                              FROM collection_members
                             WHERE directory_id = ?1
                          )",
                        [directory_id],
                    )?;
                    transaction.execute(
                        "DELETE FROM collection_members WHERE directory_id = ?1",
                        [directory_id],
                    )?;

                    transaction.commit()
                })
            },
            "remove project from all collections",
        )
    })
    .map_err(|error| {
        database::database_error(database_path, "remove project from all collections", error)
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
