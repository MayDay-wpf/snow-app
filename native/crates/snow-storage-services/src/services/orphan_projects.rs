//! 孤儿项目数据清理（设置 → 存储与资源 → 孤儿项目数据）。
//!
//! 项目从 workspace_directories 移除后，按 directory_id 归属的会话、归档、
//! 快照、记忆等数据不会随之删除。这里扫描出已无注册项目的 directory_id，
//! 由用户按「项目 + 分类」勾选删除。

use std::collections::HashSet;
use std::fs;
use std::path::Path;

use napi::bindgen_prelude::*;
use rusqlite::{Connection, TransactionBehavior};

use super::super::database;
use super::super::{
    OrphanProjectCategoryStats, OrphanProjectDeleteResult, OrphanProjectGroup,
    OrphanProjectScanResult,
};
use super::{archive, chat_conversations, checkpoint, codebase_index};

const MAX_REPORTED_ERRORS: usize = 20;
/// 单批删除的会话数
const DELETE_CHUNK: usize = 500;
const SAMPLE_TITLE_LIMIT: usize = 3;

/// 用于发现孤儿 id 的数据表（表名, 项目键列）
const KEYED_SOURCES: &[(&str, &str)] = &[
    ("chat_conversations", "directory_id"),
    ("project_memories", "directory_id"),
    ("memory_prompt_snapshots", "directory_id"),
    ("system_prompt_snapshots", "directory_id"),
    ("memos", "directory_id"),
    ("scheduled_tasks", "directory_id"),
    ("diff_review_comments", "directory_id"),
    ("collection_members", "directory_id"),
    ("git_worktrees", "directory_id"),
    ("remote_drafts", "workspace_id"),
    ("sub_agent_configs", "project_id"),
    ("system_prompts", "project_id"),
    ("custom_commands", "project_id"),
    ("codebase_embed_sessions", "project_id"),
];

/// 「元数据」分类覆盖的表（另含 worktree 绑定与项目向量表）
const METADATA_TABLES: &[(&str, &str)] = &[
    ("collection_members", "directory_id"),
    ("git_worktrees", "directory_id"),
    ("remote_drafts", "workspace_id"),
    ("sub_agent_configs", "project_id"),
    ("system_prompts", "project_id"),
    ("custom_commands", "project_id"),
    ("codebase_embed_sessions", "project_id"),
];

/// 顶层会话过滤（排除子代理与 workflow 节点会话）
const TOP_LEVEL_FILTER: &str = "NOT EXISTS (SELECT 1 FROM sub_agent_sessions s WHERE s.conversation_id = c.conversation_id)
   AND NOT EXISTS (SELECT 1 FROM workflow_node_sessions w WHERE w.conversation_id = c.conversation_id)";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OrphanCategory {
    Conversations,
    Archives,
    Snapshots,
    Memories,
    Memos,
    ScheduledTasks,
    Reviews,
    Metadata,
}

impl OrphanCategory {
    pub fn parse(value: &str) -> Result<Self> {
        match value.trim() {
            "conversations" => Ok(Self::Conversations),
            "archives" => Ok(Self::Archives),
            "snapshots" => Ok(Self::Snapshots),
            "memories" => Ok(Self::Memories),
            "memos" => Ok(Self::Memos),
            "scheduledTasks" => Ok(Self::ScheduledTasks),
            "reviews" => Ok(Self::Reviews),
            "metadata" => Ok(Self::Metadata),
            other => Err(Error::from_reason(format!(
                "Unknown orphan data category: {other}"
            ))),
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Self::Conversations => "conversations",
            Self::Archives => "archives",
            Self::Snapshots => "snapshots",
            Self::Memories => "memories",
            Self::Memos => "memos",
            Self::ScheduledTasks => "scheduledTasks",
            Self::Reviews => "reviews",
            Self::Metadata => "metadata",
        }
    }
}

#[derive(Default)]
struct ConversationStats {
    count: i64,
    messages: i64,
    last_activity: String,
    titles: Vec<String>,
}

fn table_exists(connection: &Connection, table: &str) -> bool {
    connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [table],
            |_| Ok(()),
        )
        .is_ok()
}

/// 单值计数查询；表缺失或查询失败按 0 处理。
fn scalar(connection: &Connection, sql: &str, key: &str) -> i64 {
    connection
        .query_row(sql, [key], |row| row.get::<_, i64>(0))
        .unwrap_or(0)
}

fn count_where(connection: &Connection, table: &str, column: &str, key: &str) -> i64 {
    if !table_exists(connection, table) {
        return 0;
    }
    scalar(
        connection,
        &format!("SELECT COUNT(*) FROM {table} WHERE {column} = ?1"),
        key,
    )
}

fn query_strings(connection: &Connection, sql: &str, key: &str) -> rusqlite::Result<Vec<String>> {
    let mut statement = connection.prepare(sql)?;
    let rows = statement.query_map([key], |row| row.get::<_, String>(0))?;
    rows.collect()
}

fn distinct_keys(connection: &Connection, table: &str, column: &str) -> Vec<String> {
    if !table_exists(connection, table) {
        return Vec::new();
    }
    let sql = format!(
        "SELECT DISTINCT {column} FROM {table} WHERE {column} IS NOT NULL AND {column} != ''"
    );
    let Ok(mut statement) = connection.prepare(&sql) else {
        return Vec::new();
    };
    statement
        .query_map([], |row| row.get::<_, String>(0))
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default()
}

/// 文件评审标注只有 SSH 工作区按 `ssh:<directory_id>` 归属。
fn distinct_review_keys(connection: &Connection) -> Vec<String> {
    if !table_exists(connection, "file_review_annotations") {
        return Vec::new();
    }
    let Ok(mut statement) = connection.prepare(
        "SELECT DISTINCT substr(source_key, 5) FROM file_review_annotations
          WHERE substr(source_key, 1, 4) = 'ssh:'",
    ) else {
        return Vec::new();
    };
    statement
        .query_map([], |row| row.get::<_, String>(0))
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default()
}

fn registered_directory_ids(connection: &Connection) -> rusqlite::Result<HashSet<String>> {
    let mut statement = connection.prepare("SELECT directory_id FROM workspace_directories")?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
    rows.collect()
}

/// 读取已注册项目；注册表为空时拒绝继续，避免把全部数据误判为孤儿。
fn load_registered(database_path: &Path, action: &str) -> Result<HashSet<String>> {
    let registered = database::open_connection(database_path)
        .and_then(|connection| registered_directory_ids(&connection))
        .map_err(|error| database::database_error(database_path, action, error))?;
    if registered.is_empty() {
        return Err(Error::from_reason(
            "Workspace directory registry is empty; orphan scan aborted",
        ));
    }
    Ok(registered)
}

fn conversation_stats(connection: &Connection, directory_id: &str) -> ConversationStats {
    let total = count_where(connection, "chat_conversations", "directory_id", directory_id);
    if total == 0 {
        return ConversationStats::default();
    }
    let top_level = scalar(
        connection,
        &format!(
            "SELECT COUNT(*) FROM chat_conversations c WHERE c.directory_id = ?1 AND {TOP_LEVEL_FILTER}"
        ),
        directory_id,
    );
    let messages = scalar(
        connection,
        "SELECT COUNT(*) FROM chat_messages m
           JOIN chat_conversations c ON c.conversation_id = m.conversation_id
          WHERE c.directory_id = ?1",
        directory_id,
    );
    let last_activity = connection
        .query_row(
            "SELECT COALESCE(MAX(updated_at), '') FROM chat_conversations WHERE directory_id = ?1",
            [directory_id],
            |row| row.get::<_, String>(0),
        )
        .unwrap_or_default();
    let titles = query_strings(
        connection,
        &format!(
            "SELECT c.title FROM chat_conversations c
              WHERE c.directory_id = ?1 AND c.title != '' AND {TOP_LEVEL_FILTER}
              ORDER BY c.updated_at DESC LIMIT {SAMPLE_TITLE_LIMIT}"
        ),
        directory_id,
    )
    .unwrap_or_default();

    ConversationStats {
        count: if top_level > 0 { top_level } else { total },
        messages,
        last_activity,
        titles,
    }
}

/// 项目会话关联的 checkpoint id（消息级 + workflow 级）。
fn checkpoint_ids(connection: &Connection, directory_id: &str) -> Vec<String> {
    const QUERIES: [&str; 3] = [
        "SELECT DISTINCT m.checkpoint_id FROM chat_messages m
           JOIN chat_conversations c ON c.conversation_id = m.conversation_id
          WHERE c.directory_id = ?1 AND m.checkpoint_id != ''",
        "SELECT DISTINCT w.flow_checkpoint_id FROM workflow_node_sessions w
           JOIN chat_conversations c ON c.conversation_id = w.conversation_id
          WHERE c.directory_id = ?1 AND w.flow_checkpoint_id != ''",
        "SELECT DISTINCT flow_checkpoint_id FROM workflow_runs
          WHERE directory_id = ?1 AND flow_checkpoint_id != ''",
    ];
    QUERIES
        .iter()
        .flat_map(|sql| query_strings(connection, sql, directory_id).unwrap_or_default())
        .collect()
}

/// 运行库 + 归档库的 checkpoint id（去重，过滤非法 id）。
fn collect_snapshot_ids(
    connection: Option<&Connection>,
    archive_connection: Option<&Connection>,
    directory_id: &str,
) -> Vec<String> {
    let mut seen = HashSet::new();
    [connection, archive_connection]
        .into_iter()
        .flatten()
        .flat_map(|conn| checkpoint_ids(conn, directory_id))
        .filter(|id| is_safe_checkpoint_id(id) && seen.insert(id.clone()))
        .collect()
}

fn is_safe_checkpoint_id(id: &str) -> bool {
    !id.is_empty() && !id.contains(['/', '\\']) && !id.contains("..")
}

fn directory_bytes(root: &Path) -> i64 {
    let mut bytes = 0i64;
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                pending.push(entry.path());
            } else if file_type.is_file() {
                if let Ok(metadata) = entry.metadata() {
                    bytes = bytes.saturating_add(metadata.len() as i64);
                }
            }
        }
    }
    bytes
}

/// 存在于磁盘上的快照目录：(id, 字节数)。
fn existing_snapshots(ids: &[String]) -> Vec<(String, i64)> {
    ids.iter()
        .filter_map(|id| {
            let directory = checkpoint::checkpoint_directory(id).ok()?;
            directory
                .is_dir()
                .then(|| (id.clone(), directory_bytes(&directory)))
        })
        .collect()
}

/// directory_id 形如 `local:<path>` / `ssh:<url>`。
fn split_directory_id(directory_id: &str) -> (String, String) {
    match directory_id.split_once(':') {
        Some((kind, path)) if kind == "local" || kind == "ssh" => {
            (kind.to_string(), path.to_string())
        }
        _ => (String::new(), directory_id.to_string()),
    }
}

fn stat(category: OrphanCategory, count: i64, detail_count: i64, bytes: i64) -> OrphanProjectCategoryStats {
    OrphanProjectCategoryStats {
        id: category.id().to_string(),
        count,
        detail_count,
        bytes,
    }
}

fn build_group(
    connection: &Connection,
    archive_connection: &Connection,
    directory_id: &str,
) -> OrphanProjectGroup {
    let live = conversation_stats(connection, directory_id);
    let archived = conversation_stats(archive_connection, directory_id);
    let snapshot_ids = collect_snapshot_ids(Some(connection), Some(archive_connection), directory_id);
    let snapshots = existing_snapshots(&snapshot_ids);
    let snapshot_bytes = snapshots
        .iter()
        .fold(0i64, |sum, (_, bytes)| sum.saturating_add(*bytes));

    let memories = count_where(connection, "project_memories", "directory_id", directory_id)
        + count_where(connection, "memory_prompt_snapshots", "directory_id", directory_id)
        + count_where(connection, "system_prompt_snapshots", "directory_id", directory_id);
    let memos = count_where(connection, "memos", "directory_id", directory_id);
    let tasks = count_where(connection, "scheduled_tasks", "directory_id", directory_id);
    let task_runs = scalar(
        connection,
        "SELECT COUNT(*) FROM scheduled_task_runs
          WHERE task_id IN (SELECT id FROM scheduled_tasks WHERE directory_id = ?1)",
        directory_id,
    );
    let reviews = count_where(connection, "diff_review_comments", "directory_id", directory_id)
        + scalar(
            connection,
            "SELECT COUNT(*) FROM file_review_annotations WHERE source_key = 'ssh:' || ?1",
            directory_id,
        );
    let metadata = METADATA_TABLES
        .iter()
        .map(|(table, column)| count_where(connection, table, column, directory_id))
        .sum::<i64>()
        + i64::from(table_exists(
            connection,
            &codebase_index::vector_table_name(directory_id),
        ));

    let (kind, path) = split_directory_id(directory_id);
    let last_activity_at = if live.last_activity >= archived.last_activity {
        live.last_activity.clone()
    } else {
        archived.last_activity.clone()
    };
    let mut sample_titles = live.titles;
    sample_titles.extend(archived.titles);
    sample_titles.truncate(SAMPLE_TITLE_LIMIT);

    OrphanProjectGroup {
        directory_id: directory_id.to_string(),
        kind,
        path,
        last_activity_at,
        sample_titles,
        categories: vec![
            stat(OrphanCategory::Conversations, live.count, live.messages, 0),
            stat(OrphanCategory::Archives, archived.count, archived.messages, 0),
            stat(OrphanCategory::Snapshots, snapshots.len() as i64, 0, snapshot_bytes),
            stat(OrphanCategory::Memories, memories, 0, 0),
            stat(OrphanCategory::Memos, memos, 0, 0),
            stat(OrphanCategory::ScheduledTasks, tasks, task_runs, 0),
            stat(OrphanCategory::Reviews, reviews, 0, 0),
            stat(OrphanCategory::Metadata, metadata, 0, 0),
        ],
    }
}

/// 扫描孤儿项目：收集各表中出现过的项目键，减去已注册项目。
pub fn scan(database_path: &Path, archive_path: &Path) -> Result<OrphanProjectScanResult> {
    const ACTION: &str = "scan orphan projects";
    let registered = load_registered(database_path, ACTION)?;
    let connection = database::open_connection(database_path)
        .map_err(|error| database::database_error(database_path, ACTION, error))?;
    archive::ensure_archive_database(archive_path)?;
    let archive_connection = archive::open_archive_connection(archive_path)
        .map_err(|error| database::database_error(archive_path, ACTION, error))?;

    let mut candidates: HashSet<String> = HashSet::new();
    for (table, column) in KEYED_SOURCES {
        candidates.extend(distinct_keys(&connection, table, column));
    }
    candidates.extend(distinct_review_keys(&connection));
    candidates.extend(distinct_keys(&archive_connection, "chat_conversations", "directory_id"));

    let mut projects: Vec<OrphanProjectGroup> = candidates
        .into_iter()
        .filter(|id| !id.trim().is_empty() && !registered.contains(id))
        .map(|id| build_group(&connection, &archive_connection, &id))
        .filter(|group| group.categories.iter().any(|category| category.count > 0))
        .collect();
    projects.sort_by(|a, b| {
        b.last_activity_at
            .cmp(&a.last_activity_at)
            .then_with(|| a.directory_id.cmp(&b.directory_id))
    });

    Ok(OrphanProjectScanResult { projects })
}

fn push_error(result: &mut OrphanProjectDeleteResult, message: String) {
    if result.errors.len() < MAX_REPORTED_ERRORS {
        result.errors.push(message);
    }
}

fn delete_snapshots(
    database_path: &Path,
    archive_path: &Path,
    directory_id: &str,
    result: &mut OrphanProjectDeleteResult,
) {
    let connection = database::open_connection(database_path).ok();
    let archive_connection = archive::open_archive_connection(archive_path).ok();
    let ids = collect_snapshot_ids(
        connection.as_deref(),
        archive_connection.as_ref(),
        directory_id,
    );
    for (id, bytes) in existing_snapshots(&ids) {
        match checkpoint::delete_checkpoint(id.clone()) {
            Ok(()) => {
                result.deleted_items += 1;
                result.deleted_bytes = result.deleted_bytes.saturating_add(bytes);
            }
            Err(error) => push_error(result, format!("{id}: {error}")),
        }
    }
}

/// 项目全部会话 id（顶层优先，子会话随父级联删除）。
fn project_conversation_ids(connection: &Connection, directory_id: &str) -> rusqlite::Result<Vec<String>> {
    query_strings(
        connection,
        &format!(
            "SELECT c.conversation_id FROM chat_conversations c
              WHERE c.directory_id = ?1
              ORDER BY CASE WHEN {TOP_LEVEL_FILTER} THEN 0 ELSE 1 END, c.id ASC"
        ),
        directory_id,
    )
}

fn delete_live_conversations(
    database_path: &Path,
    directory_id: &str,
    result: &mut OrphanProjectDeleteResult,
) {
    let connection = match database::open_connection(database_path) {
        Ok(connection) => connection,
        Err(error) => return push_error(result, format!("{directory_id}: {error}")),
    };
    let before = count_where(&connection, "chat_conversations", "directory_id", directory_id);
    let ids = match project_conversation_ids(&connection, directory_id) {
        Ok(ids) => ids,
        Err(error) => return push_error(result, format!("{directory_id}: {error}")),
    };
    for chunk in ids.chunks(DELETE_CHUNK) {
        if let Err(error) = chat_conversations::delete_conversations(database_path, chunk, false) {
            push_error(result, format!("{directory_id}: {error}"));
        }
    }
    let after = count_where(&connection, "chat_conversations", "directory_id", directory_id);
    result.deleted_items += (before - after).max(0);
}

fn delete_archived_conversations(
    archive_path: &Path,
    directory_id: &str,
    result: &mut OrphanProjectDeleteResult,
) {
    let connection = match archive::open_archive_connection(archive_path) {
        Ok(connection) => connection,
        Err(error) => return push_error(result, format!("{directory_id}: {error}")),
    };
    let before = count_where(&connection, "chat_conversations", "directory_id", directory_id);
    let ids = match project_conversation_ids(&connection, directory_id) {
        Ok(ids) => ids,
        Err(error) => return push_error(result, format!("{directory_id}: {error}")),
    };
    // 先释放读连接，避免与删除事务争用 rollback journal 锁
    drop(connection);
    for chunk in ids.chunks(DELETE_CHUNK) {
        if let Err(error) = archive::delete_archived_conversations(archive_path, chunk) {
            push_error(result, format!("{directory_id}: {error}"));
        }
    }
    let after = archive::open_archive_connection(archive_path)
        .map(|connection| count_where(&connection, "chat_conversations", "directory_id", directory_id))
        .unwrap_or(before);
    result.deleted_items += (before - after).max(0);
}

fn execute_if_exists(
    connection: &Connection,
    table: &str,
    sql: &str,
    key: &str,
) -> rusqlite::Result<i64> {
    if !table_exists(connection, table) {
        return Ok(0);
    }
    Ok(connection.execute(sql, [key])? as i64)
}

fn delete_keyed(connection: &Connection, table: &str, column: &str, key: &str) -> rusqlite::Result<i64> {
    execute_if_exists(
        connection,
        table,
        &format!("DELETE FROM {table} WHERE {column} = ?1"),
        key,
    )
}

fn delete_category_rows(
    connection: &Connection,
    directory_id: &str,
    category: OrphanCategory,
) -> rusqlite::Result<i64> {
    let mut deleted = 0i64;
    match category {
        OrphanCategory::Memories => {
            deleted += delete_keyed(connection, "project_memories", "directory_id", directory_id)?;
            deleted +=
                delete_keyed(connection, "memory_prompt_snapshots", "directory_id", directory_id)?;
            deleted +=
                delete_keyed(connection, "system_prompt_snapshots", "directory_id", directory_id)?;
        }
        OrphanCategory::Memos => {
            deleted += delete_keyed(connection, "memos", "directory_id", directory_id)?;
        }
        OrphanCategory::ScheduledTasks => {
            execute_if_exists(
                connection,
                "scheduled_task_runs",
                "DELETE FROM scheduled_task_runs
                  WHERE task_id IN (SELECT id FROM scheduled_tasks WHERE directory_id = ?1)",
                directory_id,
            )?;
            deleted += delete_keyed(connection, "scheduled_tasks", "directory_id", directory_id)?;
        }
        OrphanCategory::Reviews => {
            deleted += delete_keyed(connection, "diff_review_comments", "directory_id", directory_id)?;
            deleted += execute_if_exists(
                connection,
                "file_review_annotations",
                "DELETE FROM file_review_annotations WHERE source_key = 'ssh:' || ?1",
                directory_id,
            )?;
        }
        OrphanCategory::Metadata => {
            execute_if_exists(
                connection,
                "conversation_worktree_bindings",
                "DELETE FROM conversation_worktree_bindings
                  WHERE worktree_id IN (SELECT worktree_id FROM git_worktrees WHERE directory_id = ?1)",
                directory_id,
            )?;
            for (table, column) in METADATA_TABLES {
                deleted += delete_keyed(connection, table, column, directory_id)?;
            }
            let vector_table = codebase_index::vector_table_name(directory_id);
            if table_exists(connection, &vector_table) {
                connection.execute_batch(&format!("DROP TABLE IF EXISTS {vector_table};"))?;
                deleted += 1;
            }
        }
        OrphanCategory::Conversations | OrphanCategory::Archives | OrphanCategory::Snapshots => {}
    }
    Ok(deleted)
}

/// 行级分类在单个写事务内删除。
fn delete_rows(
    database_path: &Path,
    directory_id: &str,
    categories: &[OrphanCategory],
) -> Result<i64> {
    const ACTION: &str = "delete orphan project data";
    database::with_write_lock(|| {
        database::with_write_retry(
            || {
                let mut connection = database::open_connection(database_path)?;
                let transaction =
                    connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
                let mut deleted = 0i64;
                for category in categories {
                    deleted += delete_category_rows(&transaction, directory_id, *category)?;
                }
                transaction.commit()?;
                Ok(deleted)
            },
            ACTION,
        )
    })
    .map_err(|error| database::database_error(database_path, ACTION, error))
}

/// 删除选中项目的选中分类；删除前复核项目仍未注册。
pub fn delete(
    database_path: &Path,
    archive_path: &Path,
    targets: &[(String, Vec<OrphanCategory>)],
) -> Result<OrphanProjectDeleteResult> {
    let registered = load_registered(database_path, "delete orphan project data")?;
    archive::ensure_archive_database(archive_path)?;
    let mut result = OrphanProjectDeleteResult {
        deleted_items: 0,
        deleted_bytes: 0,
        errors: Vec::new(),
    };

    for (directory_id, categories) in targets {
        let directory_id = directory_id.trim();
        if directory_id.is_empty() {
            continue;
        }
        if registered.contains(directory_id) {
            push_error(
                &mut result,
                format!("{directory_id}: project is registered again, skipped"),
            );
            continue;
        }
        let has = |category: OrphanCategory| categories.contains(&category);

        // 快照先删：会话删除后就无法再定位其 checkpoint
        if has(OrphanCategory::Snapshots) {
            delete_snapshots(database_path, archive_path, directory_id, &mut result);
        }
        if has(OrphanCategory::Conversations) {
            delete_live_conversations(database_path, directory_id, &mut result);
        }
        if has(OrphanCategory::Archives) {
            delete_archived_conversations(archive_path, directory_id, &mut result);
        }

        let row_categories: Vec<OrphanCategory> = categories
            .iter()
            .copied()
            .filter(|category| {
                !matches!(
                    category,
                    OrphanCategory::Conversations
                        | OrphanCategory::Archives
                        | OrphanCategory::Snapshots
                )
            })
            .collect();
        if !row_categories.is_empty() {
            match delete_rows(database_path, directory_id, &row_categories) {
                Ok(count) => result.deleted_items += count,
                Err(error) => push_error(&mut result, format!("{directory_id}: {error}")),
            }
        }
    }

    Ok(result)
}
