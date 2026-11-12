//! 项目合集（project collections）的持久化服务。
//!
//! 合集是纯元数据（名称 + 颜色 + 收纳的项目 directory_id 列表），不对应磁盘目录，
//! 也不会参与「激活/会话挂载」等目录逻辑——仅用于侧边栏收纳与整理项目。
//!
//! 合集同时充当「关联项目组」：成员带 `linked` 开关（默认开），只有参与关联的
//! 成员才会被 `resolve_linked_project_roots` 解析成统一工作区，供 grep 搜索、
//! 文件搜索与系统提示词共享；断连的成员仍留在合集里，只是不参与关联。

use std::collections::HashSet;
use std::path::Path;

use napi::bindgen_prelude::*;
use rusqlite::{params, Connection, OptionalExtension};

use snow_storage_core::database;
use snow_storage_core::models::{LinkedProjectGroup, LinkedProjectRoot, ProjectCollectionRecord};

/// 合集 / 关联项目组的调色板：按创建顺序轮转分配，同一组内所有项目
/// 显示相同颜色的圆点标识。
const COLLECTION_COLORS: &[&str] = &[
    "#f59e0b", "#3b82f6", "#10b981", "#a855f7", "#ef4444", "#14b8a6", "#f97316", "#6366f1",
];

/// 第 `index` 个创建的项目组合色（超出调色板长度后循环）。
pub(crate) fn collection_color_for_index(index: usize) -> &'static str {
    COLLECTION_COLORS[index % COLLECTION_COLORS.len()]
}

pub fn list_project_collections(database_path: &Path) -> Result<Vec<ProjectCollectionRecord>> {
    database::open_connection(database_path)
        .and_then(|connection| query_project_collections(&connection))
        .map_err(|error| {
            database::database_error(database_path, "list project collections", error)
        })
}

/// 创建合集并可选地一次性收纳成员项目（关联项目组走这条路径：创建即关联）。
/// 颜色按已有序号自动分配，成员顺序即 `member_directory_ids` 的传入顺序。
pub fn create_project_collection(
    database_path: &Path,
    name: &str,
    member_directory_ids: &[String],
) -> Result<()> {
    let trimmed = validate_collection_name(name)?;

    database::with_write_lock(|| {
        database::with_write_retry(
            || {
                database::open_connection(database_path).and_then(|mut connection| {
                    let transaction = connection.transaction()?;

                    let existing_count: i64 =
                        transaction.query_row("SELECT COUNT(*) FROM project_collections", [], |row| {
                            row.get(0)
                        })?;
                    let color = collection_color_for_index(existing_count.max(0) as usize);
                    let collection_id = database::create_snowflake_id();

                    transaction.execute(
                        "INSERT INTO project_collections (
                           id,
                           collection_id,
                           name,
                           color,
                           sort_order,
                           created_at,
                           updated_at
                         ) VALUES (?1, ?2, ?3, ?4, ?5, datetime('now', 'localtime'), datetime('now', 'localtime'))",
                        params![
                            database::create_snowflake_id(),
                            collection_id,
                            trimmed,
                            color,
                            existing_count as i32,
                        ],
                    )?;

                    let mut seen: HashSet<&str> = HashSet::with_capacity(member_directory_ids.len());
                    for (index, directory_id) in member_directory_ids.iter().enumerate() {
                        let directory_id = directory_id.trim();
                        if directory_id.is_empty() || !seen.insert(directory_id) {
                            continue;
                        }
                        ensure_workspace_directory_exists(&transaction, directory_id)?;
                        // 与「移动到合集」语义一致：一个项目只属于一个关联项目组，
                        // 新组收纳时自动从旧组移出，并刷新旧组的 updated_at
                        //（旧组成员行删除后就定位不到它了）。
                        transaction.execute(
                            "UPDATE project_collections
                                SET updated_at = datetime('now', 'localtime')
                              WHERE collection_id IN (
                                SELECT DISTINCT collection_id
                                  FROM collection_members
                                 WHERE directory_id = ?1 AND collection_id != ?2
                              )",
                            params![directory_id, collection_id],
                        )?;
                        transaction.execute(
                            "DELETE FROM collection_members
                              WHERE directory_id = ?1 AND collection_id != ?2",
                            params![directory_id, collection_id],
                        )?;
transaction.execute(
                            "INSERT OR IGNORE INTO collection_members (
                               id,
                               collection_id,
                               directory_id,
                               sort_order,
                               linked,
                               created_at
                             ) VALUES (?1, ?2, ?3, ?4, 1, datetime('now', 'localtime'))",
                            params![
                                database::create_snowflake_id(),
                                collection_id,
                                directory_id,
                                index as i32,
                            ],
                        )?;
                    }

                    transaction.commit()
                })
            },
            "create project collection",
        )
    })
    .map_err(|error| {
        database::database_error(database_path, "create project collection", error)
    })
}

/// 修改合集统一颜色（关联项目组的圆点标识色）。
pub fn update_project_collection_color(
    database_path: &Path,
    collection_id: &str,
    color: &str,
) -> Result<()> {
    let normalized = validate_collection_color(color)?;

    database::open_connection(database_path)
        .and_then(|connection| {
            let updated = connection.execute(
                "UPDATE project_collections
                    SET color = ?1,
                        updated_at = datetime('now', 'localtime')
                  WHERE collection_id = ?2",
                params![normalized, collection_id],
            )?;
            if updated == 0 {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }
            Ok(())
        })
        .map_err(|error| {
            database::database_error(database_path, "update project collection color", error)
        })
}

/// 解析 `directory_id` 所属的关联项目组（合集）。
///
/// 返回 `None` 表示该项目未关联（已断开关联、不在任何合集中，或合集内有效本地
/// 项目不足 2 个）；SSH 成员与路径为空的成员不参与，因为本地搜索工具无法读取
/// 远端路径。自身断开关联的项目也不再并入兄弟根。
pub fn resolve_linked_project_roots(
    database_path: &Path,
    directory_id: &str,
) -> Result<Option<LinkedProjectGroup>> {
    let trimmed = directory_id.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    database::open_connection(database_path)
        .and_then(|connection| {
            // 断开关联（linked = 0）的项目本身不参与关联：既不并入兄弟根，
            // 也不以它为起点搜索组内其他项目。
            let collection_id: Option<String> = connection
                .query_row(
                    "SELECT collection_id
                       FROM collection_members
                      WHERE directory_id = ?1 AND linked = 1
                      LIMIT 1",
                    [trimmed],
                    |row| row.get(0),
                )
                .optional()?;
            let Some(collection_id) = collection_id else {
                return Ok(None);
            };
            query_linked_project_group(&connection, &collection_id)
        })
        .map_err(|error| {
            database::database_error(database_path, "resolve linked project roots", error)
        })
}

/// 按项目根目录路径解析关联项目组（文件搜索等只有路径、没有 directory_id 的场景）。
/// 路径比较在 Windows 语义下大小写不敏感。
pub fn resolve_linked_project_roots_by_path(
    database_path: &Path,
    path: &str,
) -> Result<Option<LinkedProjectGroup>> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    database::open_connection(database_path)
        .and_then(|connection| {
            let directory_id: Option<String> = connection
                .query_row(
                    "SELECT directory_id
                       FROM workspace_directories
                      WHERE path = ?1 COLLATE NOCASE
                      LIMIT 1",
                    [trimmed],
                    |row| row.get(0),
                )
                .optional()?;
            let Some(directory_id) = directory_id else {
                return Ok(None);
            };
            // 断开关联（linked = 0）的项目不再以它为起点解析兄弟根，
            // 文件搜索 / grep 立即退回单根行为。
            let collection_id: Option<String> = connection
                .query_row(
                    "SELECT collection_id
                       FROM collection_members
                      WHERE directory_id = ?1 AND linked = 1
                      LIMIT 1",
                    [directory_id],
                    |row| row.get(0),
                )
                .optional()?;
            let Some(collection_id) = collection_id else {
                return Ok(None);
            };
            query_linked_project_group(&connection, &collection_id)
        })
        .map_err(|error| {
            database::database_error(database_path, "resolve linked project roots by path", error)
        })
}

fn query_linked_project_group(
    connection: &Connection,
    collection_id: &str,
) -> rusqlite::Result<Option<LinkedProjectGroup>> {
    let name: Option<String> = connection
        .query_row(
            "SELECT name FROM project_collections WHERE collection_id = ?1",
            [collection_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(name) = name else {
        return Ok(None);
    };

let members: Vec<(String, String, String, String)> = {
        let mut statement = connection.prepare(
            "SELECT members.directory_id,
                    directories.name,
                    directories.path,
                    directories.kind
               FROM collection_members AS members
               JOIN workspace_directories AS directories
                 ON directories.directory_id = members.directory_id
              WHERE members.collection_id = ?1 AND members.linked = 1
              ORDER BY members.sort_order ASC, members.id ASC",
        )?;
        let rows = statement.query_map([collection_id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };

    let mut roots = Vec::new();
    for (directory_id, name, path, kind) in members {
        if kind != "local" || path.trim().is_empty() {
            continue;
        }
        roots.push(LinkedProjectRoot {
            directory_id,
            name,
            path,
        });
    }

    if roots.len() < 2 {
        return Ok(None);
    }

    Ok(Some(LinkedProjectGroup { name, roots }))
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

/// 校验有序 id 列表：无重复，且集合恰好等于 expected（期望的完整 id 集合）。
/// 要求调用方传入完整列表，避免部分更新造成条目丢失。
fn ensure_ordered_ids_match(
    ordered_ids: &[String],
    expected: &HashSet<&str>,
) -> rusqlite::Result<()> {
    let mut seen: HashSet<&str> = HashSet::with_capacity(ordered_ids.len());
    for id in ordered_ids {
        if !seen.insert(id.as_str()) {
            return Err(constraint_error("ordered id list contains duplicate ids"));
        }
    }
    if seen != *expected {
        return Err(constraint_error(
            "ordered id list must contain exactly the existing ids",
        ));
    }
    Ok(())
}

/// 按给定顺序重排合集（同一事务中逐个更新 sort_order）。
///
/// ordered_collection_ids 必须与现有合集完整一致（仅顺序不同），否则报错。
pub fn reorder_project_collections(
    database_path: &Path,
    ordered_collection_ids: &[String],
) -> Result<()> {
    database::with_write_lock(|| {
        database::with_write_retry(
            || {
                database::open_connection(database_path).and_then(|mut connection| {
                    let transaction = connection.transaction()?;

                    let existing_collection_ids: Vec<String> = {
                        let mut statement = transaction
                            .prepare("SELECT collection_id FROM project_collections")?;
                        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
                        rows.collect::<rusqlite::Result<Vec<_>>>()?
                    };
                    let expected: HashSet<&str> = existing_collection_ids
                        .iter()
                        .map(|id| id.as_str())
                        .collect();
                    ensure_ordered_ids_match(ordered_collection_ids, &expected)?;

                    for (index, collection_id) in ordered_collection_ids.iter().enumerate() {
                        transaction.execute(
                            "UPDATE project_collections
                                SET sort_order = ?1
                              WHERE collection_id = ?2",
                            params![index as i32, collection_id],
                        )?;
                    }

                    transaction.commit()
                })
            },
            "reorder project collections",
        )
    })
    .map_err(|error| {
        database::database_error(database_path, "reorder project collections", error)
    })
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
query_collection_members(&transaction, collection_id, false)?;
                    let expected: HashSet<&str> = existing_member_ids
                        .iter()
                        .map(|id| id.as_str())
                        .collect();
                    ensure_ordered_ids_match(ordered_member_ids, &expected)?;

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
query_collection_members(&transaction, target_collection_id, false)?;
                    let mut expected: HashSet<&str> = existing_member_ids
                        .iter()
                        .map(|id| id.as_str())
                        .collect();
                    expected.insert(directory_id);
                    ensure_ordered_ids_match(ordered_member_ids, &expected)?;

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

/// 切换合集成员的「参与关联」开关：断连（`linked = false`）的成员仍留在合集里，
/// 只是不再参与 grep / 文件搜索 / 系统提示词的统一项目解析。
pub fn set_project_collection_member_linked(
    database_path: &Path,
    collection_id: &str,
    directory_id: &str,
    linked: bool,
) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|connection| {
            let updated = connection.execute(
                "UPDATE collection_members
                    SET linked = ?1
                  WHERE collection_id = ?2 AND directory_id = ?3",
                params![linked as i32, collection_id, directory_id],
            )?;
            if updated == 0 {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }
            connection.execute(
                "UPDATE project_collections
                    SET updated_at = datetime('now', 'localtime')
                  WHERE collection_id = ?1",
                [collection_id],
            )?;
            Ok(())
        })
        .map_err(|error| {
            database::database_error(database_path, "set collection member linked", error)
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

/// 只接受 `#rrggbb` 形式的颜色，避免任意字符串落库后污染界面样式。
fn validate_collection_color(color: &str) -> Result<&str> {
    let trimmed = color.trim();
    let is_hex = trimmed.len() == 7
        && trimmed.starts_with('#')
        && trimmed[1..].chars().all(|c| c.is_ascii_hexdigit());
    if !is_hex {
        return Err(Error::from_reason(
            "Collection color must be a hex value like #f59e0b".to_string(),
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
                color,
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
        let color: String = row.get(3)?;
        let sort_order: i32 = row.get(4)?;
        let created_at: String = row.get(5)?;
        let updated_at: String = row.get(6)?;
        Ok((
            id,
            collection_id,
            name,
            color,
            sort_order,
            created_at,
            updated_at,
        ))
    })?;

let mut collections = Vec::new();
    for (index, row) in rows.enumerate() {
        let (id, collection_id, name, color, sort_order, created_at, updated_at) = row?;
        let member_directory_ids = query_collection_members(connection, &collection_id, false)?;
        let linked_directory_ids = query_collection_members(connection, &collection_id, true)?;
        collections.push(ProjectCollectionRecord {
            id,
            collection_id,
            name,
            color: if color.trim().is_empty() {
                // 极少数历史行（迁移前写入且无颜色）兜底为稳定的调色板色。
                collection_color_for_index(index).to_string()
            } else {
                color
            },
            sort_order,
            member_directory_ids,
            linked_directory_ids,
            created_at,
            updated_at,
        });
    }

    Ok(collections)
}

/// 读取合集成员：`linked_only` 为真时只返回参与关联的成员。
fn query_collection_members(
    connection: &Connection,
    collection_id: &str,
    linked_only: bool,
) -> rusqlite::Result<Vec<String>> {
    let sql = if linked_only {
        "SELECT directory_id
           FROM collection_members
          WHERE collection_id = ?1 AND linked = 1
          ORDER BY sort_order ASC, id ASC"
    } else {
        "SELECT directory_id
           FROM collection_members
          WHERE collection_id = ?1
          ORDER BY sort_order ASC, id ASC"
    };
    let mut statement = connection.prepare(sql)?;
    let rows = statement.query_map([collection_id], |row| row.get::<_, String>(0))?;
    rows.collect()
}
