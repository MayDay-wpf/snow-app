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
    // 写锁串行化同进程写事务，忙等重试兜底外部进程短暂持锁，
    // 避免并发写操作触发 "database is locked"。
    database::with_write_lock(|| {
        database::with_write_retry(
            || {
                database::open_connection(database_path).and_then(|mut connection| {
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
            },
            "upsert workspace directory",
        )
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

/// 将项目重定向到新路径：在单个事务内更新 `workspace_directories` 行的
/// `path`/`directory_id`，并把所有以旧 `directory_id` 为主键或内嵌键的项目
/// 数据（会话、记忆、备忘录、定时任务、用量、合集成员、项目级配置等）
/// 一并迁移到新 ID，保证项目历史不丢。任一步失败整体回滚。
///
/// - 显示名（name）保持不变：项目名与文件夹解耦，改路径不重命名项目。
/// - `kind` 复用旧值：local 项目的新路径必须是真实存在的本地目录；
///   ssh 项目的新路径必须以 `ssh://` 开头。
pub fn update_workspace_directory_path(
    database_path: &Path,
    directory_id: &str,
    new_path: &str,
) -> Result<()> {
    let old_id = directory_id.trim();
    let trimmed_new_path = new_path.trim();
    if old_id.is_empty() {
        return Err(Error::from_reason(
            "Workspace directory ID is required".to_string(),
        ));
    }
    if trimmed_new_path.is_empty() {
        return Err(Error::from_reason(
            "New workspace directory path is required".to_string(),
        ));
    }

    // local 项目的新路径必须真实存在且为目录，避免把项目指向无效位置。
    if !old_id.starts_with("ssh:") {
        let target = Path::new(trimmed_new_path);
        if !target.is_dir() {
            return Err(Error::from_reason(format!(
                "New project folder does not exist or is not a directory: '{trimmed_new_path}'"
            )));
        }
    }

    database::with_write_lock(|| {
        database::with_write_retry(
            || {
                database::open_connection(database_path).and_then(|mut connection| {
                    let transaction = connection.transaction()?;

                    let (old_path, kind, source): (String, String, Option<String>) = {
                        let mut statement = transaction.prepare(
                            "SELECT path, kind, source
                                FROM workspace_directories
                               WHERE directory_id = ?1
                               LIMIT 1",
                        )?;
                        statement
                            .query_row([old_id], |row| {
                                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                            })
                            .optional()?
                    }
                    .ok_or_else(|| {
                        rusqlite::Error::InvalidParameterName(format!(
                            "Workspace directory not found: '{old_id}'"
                        ))
                    })?;

                    // 内置默认工作目录（source = "builtin"）不允许重定向，
                    // 与“不允许删除”保持一致，保证系统始终有可用的默认目录。
                    if source.as_deref() == Some(DEFAULT_WORKSPACE_SOURCE) {
                        return Err(rusqlite::Error::SqliteFailure(
                            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CONSTRAINT),
                            Some(
                                "Cannot update the path of the built-in default workspace directory"
                                    .to_string(),
                            ),
                        ));
                    }

                    if kind == "ssh" && !trimmed_new_path.starts_with("ssh://") {
                        return Err(rusqlite::Error::InvalidParameterName(
                            "SSH workspace directory must start with ssh://".to_string(),
                        ));
                    }

                    let new_id = format!("{kind}:{trimmed_new_path}");
                    if new_id == old_id {
                        return Ok(());
                    }

                    let existing: Option<i64> = transaction
                        .query_row(
                            "SELECT 1 FROM workspace_directories WHERE directory_id = ?1 LIMIT 1",
                            [&new_id],
                            |row| row.get(0),
                        )
                        .optional()?;
                    if existing.is_some() {
                        return Err(rusqlite::Error::SqliteFailure(
                            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CONSTRAINT),
                            Some(format!(
                                "Target folder is already registered as another project: '{trimmed_new_path}'"
                            )),
                        ));
                    }

                    migrate_workspace_directory_in_transaction(
                        &transaction,
                        old_id,
                        old_path.as_str(),
                        &new_id,
                        trimmed_new_path,
                    )?;

                    transaction.commit()
                })
            },
            "update workspace directory path",
        )
    })
    .map_err(|error| {
        database::database_error(database_path, "update workspace directory path", error)
    })
}

/// 事务内执行 directory_id 重定向的全部数据迁移。
///
/// 分两类处理：
/// 1. 独立列（directory_id / project_id）：直接 `UPDATE ... SET 列 = 新值`；
/// 2. 内嵌键（prompt_id、setting_code、JSON value）：`REPLACE` 子串替换，
///    JSON 值还需额外替换反斜杠/引号转义后的形式（Windows 路径在
///    JSON 文本中存储为 `D:\\dir` 而非 `D:\dir`）。
fn migrate_workspace_directory_in_transaction(
    connection: &Connection,
    old_id: &str,
    old_path: &str,
    new_id: &str,
    new_path: &str,
) -> rusqlite::Result<()> {
    // —— 1. 项目登记行本身 ——
    connection.execute(
        "UPDATE workspace_directories
            SET directory_id = ?1,
                path = ?2,
                updated_at = datetime('now', 'localtime')
          WHERE directory_id = ?3",
        params![new_id, new_path, old_id],
    )?;

    // —— 2. 以 directory_id 为列的业务表 ——
    for table in [
        "chat_conversations",
        "workflow_runs",
        "usage_records",
        "memos",
        "scheduled_tasks",
        "project_memories",
        "collection_members",
    ] {
        connection.execute(
            &format!("UPDATE {table} SET directory_id = ?1 WHERE directory_id = ?2"),
            params![new_id, old_id],
        )?;
    }

    // —— 3. 以 project_id 为列的配置表 ——
    for table in [
        "sub_agent_configs",
        "codebase_embed_sessions",
        "import_resources",
    ] {
        connection.execute(
            &format!("UPDATE {table} SET project_id = ?1 WHERE project_id = ?2"),
            params![new_id, old_id],
        )?;
    }

    // —— 4. 内嵌键：target_id（prompt/command/agent 导入跟踪）——
    connection.execute(
        "UPDATE import_resources
            SET target_id = REPLACE(target_id, ?1, ?2)
          WHERE instr(target_id, ?1) > 0",
        params![old_id, new_id],
    )?;

    // —— 5. 内嵌键：项目级 system prompt 的 prompt_id ——
    connection.execute(
        "UPDATE system_prompts
            SET prompt_id = REPLACE(prompt_id, ?1, ?2),
                updated_at = datetime('now', 'localtime')
          WHERE instr(prompt_id, ?1) > 0",
        params![old_id, new_id],
    )?;

    // —— 6. 内嵌键：system_settings ——
    // setting_code 形如 `project_mcp_server_configs_<id>` / `hooks_project_<id>` 等，
    // 直接原样替换。setting_value 是 JSON 文本，Windows 路径中的反斜杠会被
    // 转义存储，因此需要同时替换原始形式与 JSON 转义形式。
    let json_escaped = |value: &str| -> String { value.replace('\\', "\\\\").replace('"', "\\\"") };
    let old_id_escaped = json_escaped(old_id);
    let new_id_escaped = json_escaped(new_id);
    // 旧路径（而非旧 id）也可能出现在配置 JSON 中（如历史快照的绝对路径），
    // 一并替换；旧路径通常含旧 id 前缀，替换顺序：先 id 后路径的转义形式。
    let old_path_escaped = json_escaped(old_path);
    let new_path_escaped = json_escaped(new_path);

    connection.execute(
        "UPDATE system_settings
            SET setting_code = REPLACE(setting_code, ?1, ?2)
          WHERE instr(setting_code, ?1) > 0",
        params![old_id, new_id],
    )?;

    // 项目级设置（MCP scope / MCP server configs / Skills / Codebase / Tool
    // approval / LSP / sensitive commands / hooks）的 setting_code 以
    // `前缀 + blake3(project_id)` 结尾——哈希不含 id 原文，上面的 REPLACE
    // 无法命中。这里按新旧 id 重算 code 整体重命名记录；漏掉这一步会让
    // 重定向后的项目读不到旧设置（表现为设置“丢失”），且 JSON 内嵌的
    // projectId 与 code 脱节会让后续 MCP 调用报 identity mismatch。
    const PROJECT_SETTING_CODE_PREFIXES: [&str; 8] = [
        "project_mcp_scope_",
        "project_mcp_server_configs_",
        "project_skills_scope_",
        "project_codebase_scope_",
        "project_tool_approval_scope_",
        "project_lsp_server_configs_",
        "project_sensitive_command_scope_",
        "hooks_project_",
    ];
    for prefix in PROJECT_SETTING_CODE_PREFIXES {
        let old_code = format!("{prefix}{}", blake3::hash(old_id.as_bytes()).to_hex());
        let new_code = format!("{prefix}{}", blake3::hash(new_id.as_bytes()).to_hex());
        connection.execute(
            "UPDATE system_settings SET setting_code = ?1 WHERE setting_code = ?2",
            params![new_code, old_code],
        )?;
    }

    connection.execute(
        "UPDATE system_settings
            SET setting_value = REPLACE(
                  REPLACE(
                    REPLACE(REPLACE(setting_value, ?3, ?4), ?1, ?2),
                    ?5, ?6),
                  ?1, ?2)
          WHERE instr(setting_value, ?1) > 0
             OR instr(setting_value, ?3) > 0",
        params![
            old_id,
            new_id,
            old_id_escaped,
            new_id_escaped,
            old_path_escaped,
            new_path_escaped
        ],
    )?;

    // —— 7. 代码库向量索引：表名由 directory_id 哈希派生（cb_vec_<hash16>）。
    //      直接整体改名即可保留全部向量数据（无需重新 embedding）；
    //      表内 project_id 与 file_path（绝对路径）同步替换，relative_path
    //      是相对项目的路径，不随文件夹位置变化。old_table 不存在说明该
    //      项目从未建立索引，直接跳过。新表名若残留同 id 历史项目的孤儿
    //      表（新 directoryId 此前已确保未被登记），先删避免 RENAME 冲突。
    let old_table = format!("cb_vec_{}", &blake3::hash(old_id.as_bytes()).to_hex()[..16]);
    let new_table = format!("cb_vec_{}", &blake3::hash(new_id.as_bytes()).to_hex()[..16]);
    let old_table_exists = connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1 LIMIT 1",
            [&old_table],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .is_some();
    if old_table_exists {
        connection.execute_batch(&format!("DROP TABLE IF EXISTS {new_table};"))?;
        connection.execute_batch(&format!("ALTER TABLE {old_table} RENAME TO {new_table};"))?;
        connection.execute(
            &format!("UPDATE {new_table} SET project_id = ?1 WHERE project_id = ?2"),
            params![new_id, old_id],
        )?;
        connection.execute(
            &format!(
                "UPDATE {new_table}
                    SET file_path = REPLACE(file_path, ?1, ?2)
                  WHERE instr(file_path, ?1) > 0"
            ),
            params![new_path, old_path],
        )?;
    }

    // —— 8. LSP 诊断缓存（按绝对路径为键的易失缓存）：旧路径下的条目
    //      不会再被命中，直接清理，新路径会随使用自动重建。
    connection.execute(
        "DELETE FROM lsp_diagnostic_cache WHERE instr(file_path, ?1) = 1",
        params![old_path],
    )?;

    Ok(())
}

pub fn activate_workspace_directory(database_path: &Path, directory_id: &str) -> Result<()> {
    // 写锁串行化同进程写事务，忙等重试兜底外部进程短暂持锁，
    // 避免切换工作区时与其他写操作竞争触发 "database is locked"。
    database::with_write_lock(|| {
        database::with_write_retry(
            || {
                database::open_connection(database_path).and_then(|mut connection| {
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
            },
            "activate workspace directory",
        )
    })
    .map_err(|error| {
        database::database_error(database_path, "activate workspace directory", error)
    })
}

pub fn reorder_workspace_directories(
    database_path: &Path,
    items: &[WorkspaceDirectoryInput],
) -> Result<()> {
    database::with_write_lock(|| {
        database::with_write_retry(
            || {
                database::open_connection(database_path).and_then(|mut connection| {
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
            },
            "reorder workspace directories",
        )
    })
    .map_err(|error| {
        database::database_error(database_path, "reorder workspace directories", error)
    })
}

pub fn delete_workspace_directory(database_path: &Path, directory_id: &str) -> Result<()> {
    database::with_write_lock(|| {
        database::with_write_retry(
            || {
                database::open_connection(database_path).and_then(|mut connection| {
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

                    // 项目路径用于清理按绝对路径为键的 LSP 诊断缓存。
                    let directory_path: Option<String> = transaction
                        .query_row(
                            "SELECT path FROM workspace_directories WHERE directory_id = ?1",
                            [directory_id],
                            |row| row.get(0),
                        )
                        .optional()?;

                    transaction.execute(
                        "DELETE FROM workspace_directories WHERE directory_id = ?1",
                        [directory_id],
                    )?;

                    // 代码库向量索引表名由 directory_id 哈希派生（cb_vec_<hash16>），
                    // 属于项目的派生数据：项目移除登记后索引失去归属，一并删除，
                    // 避免孤儿向量表长期占用存储。索引会话表同步清理；会话、
                    // 记忆等业务数据保留，重新添加该文件夹即可找回。
                    let vector_table = format!(
                        "cb_vec_{}",
                        &blake3::hash(directory_id.as_bytes()).to_hex()[..16]
                    );
                    transaction.execute_batch(&format!("DROP TABLE IF EXISTS {vector_table};"))?;
                    transaction.execute(
                        "DELETE FROM codebase_embed_sessions WHERE project_id = ?1",
                        [directory_id],
                    )?;

                    // 按绝对路径为键的 LSP 诊断缓存（易失，删除后随使用重建）。
                    if let Some(path) = directory_path.as_deref() {
                        transaction.execute(
                            "DELETE FROM lsp_diagnostic_cache WHERE instr(file_path, ?1) = 1",
                            [path],
                        )?;
                    }

                    normalize_workspace_directory_state(&transaction)?;
                    transaction.commit()
                })
            },
            "delete workspace directory",
        )
    })
    .map_err(|error| database::database_error(database_path, "delete workspace directory", error))
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

    database::with_write_lock(|| {
        database::with_write_retry(
            || {
                database::open_connection(database_path).and_then(|connection| {
                    seed_default_workspace_directory_with_connection(
                        &connection,
                        &directory_id,
                        &default_path_str,
                    )
                })
            },
            "seed default workspace directory",
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
