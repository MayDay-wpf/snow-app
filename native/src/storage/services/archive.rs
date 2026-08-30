use std::collections::HashSet;
use std::path::Path;
use std::time::Duration;

use napi::bindgen_prelude::*;
use rusqlite::{params, params_from_iter, Connection, TransactionBehavior};

use super::super::database;
use super::super::{ChatConversationPage, ChatConversationRecord};

/// 归档冷数据库（archive.db）专用服务。
///
/// 归档语义：把会话（含消息、todo、子代理会话）从运行库整体搬移到独立的
/// 冷数据库，随后从运行库物理删除，从而在不丢失数据的前提下保持运行库
/// 体积可控。归档会话不能直接使用，必须「还原」回运行库后才能继续对话。
///
/// 归档与还原都通过 ATTACH 将归档库挂到运行库连接上，用单个事务完成
/// 拷贝 + 删除，保证两侧数据一致性。
///
/// 关键设计：
/// - 归档库使用传统 rollback journal（journal_mode=DELETE）而非 WAL。
///   WAL 模式数据库被 ATTACH 到写事务中时需要初始化 -shm 锁索引，
///   同一进程内与主库写锁协调失败会报 SQLITE_LOCKED "database is locked"；
///   rollback journal 是 SQLite 多数据库事务最经典稳定的组合。
/// - ATTACH 必须在 BEGIN IMMEDIATE 之前完成，这是 SQLite 多数据库
///   原子写事务的标准顺序。
/// - 归档/还原都以运行库连接为主连接，归档库只作为附加库参与事务。

/// SQLite 变量数上限，分块执行避免超出（与 chat_conversations 一致）。
const MAX_VARIABLES: usize = 400;

/// 与运行库 chat_conversations 完全一致的列（不含归档时间列）。
const CONVERSATION_COLUMNS: &str = "id, conversation_id, title, summary, last_message_preview, message_count, model, api_profile_name, thinking_strength, responses_fast_mode, last_response_id, status, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, total_duration_ms, run_input_tokens, run_output_tokens, run_cache_creation_input_tokens, run_cache_read_input_tokens, last_run_duration_ms, directory_id, forked_from_conversation_id, fork_message_count, emoji, plan_mode, goal_mode, worktree_mode, goal_mode_token_budget, created_at, updated_at";

const MESSAGE_COLUMNS: &str = "id, message_id, conversation_id, role, content, model, response_id, checkpoint_id, status, raw_json, thinking, thinking_duration_ms, thinking_token_count, thinking_blocks_json, tool_calls_json, created_at";

const TODO_COLUMNS: &str = "id, session_id, content, status, response_id, created_at, updated_at, parent_id";

const SESSION_COLUMNS: &str = "id, conversation_id, parent_conversation_id, agent_id, agent_name, run_status, error_message, created_at, updated_at";

/// 与运行库 workflow_node_sessions 完全一致的列。
const WORKFLOW_NODE_SESSION_COLUMNS: &str =
    "id, conversation_id, parent_conversation_id, flow_id, flow_checkpoint_id, node_id, node_name, run_status, error_message, handoff_content, created_at, updated_at";

/// 与运行库 workflow_runs 完全一致的列。
const WORKFLOW_RUN_COLUMNS: &str =
    "id, parent_conversation_id, flow_id, run_status, current_node_index, last_handoff, total_tokens, flow_checkpoint_id, directory_id, error_message, created_at, updated_at";

/// 与运行库 workflow_canvases 完全一致的列。
const WORKFLOW_CANVAS_COLUMNS: &str =
    "parent_conversation_id, interaction_id, canvas_json, updated_at";

/// 打开归档库连接。
///
/// 归档库刻意使用传统 rollback journal 而非 WAL：归档操作需要把归档库
/// ATTACH 到运行库连接的事务中，WAL 模式的 -shm 锁索引在跨库写事务中
/// 容易触发 SQLITE_LOCKED；rollback journal 无此问题。归档库是低频
/// 冷数据，读写并发极低，rollback journal 完全够用。
fn open_archive_connection(archive_path: &Path) -> rusqlite::Result<Connection> {
    let connection = Connection::open(archive_path)?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.busy_timeout(Duration::from_secs(5))?;
    connection.pragma_update(None, "journal_mode", "DELETE")?;
    connection.pragma_update(None, "synchronous", "NORMAL")?;
    Ok(connection)
}

/// 生成 `IN (?, ?, ...)` 子句占位符。
fn in_clause_placeholders(count: usize) -> String {
    std::iter::repeat("?")
        .take(count)
        .collect::<Vec<_>>()
        .join(", ")
}

/// 去重并保持传入顺序。
fn unique_conversation_ids(conversation_ids: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    conversation_ids
        .iter()
        .filter(|id| seen.insert(id.as_str()))
        .cloned()
        .collect()
}

/// 创建归档库表结构（幂等）。与运行库会话相关表结构一致，
/// chat_conversations 额外带 archived_at 归档时间列。
///
/// 供数据库修复流程复用：归档库损坏恢复时用它重建表结构。
pub(crate) fn create_archive_schema(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS chat_conversations (
           id TEXT PRIMARY KEY NOT NULL,
           conversation_id TEXT NOT NULL UNIQUE,
           title TEXT NOT NULL DEFAULT '',
           summary TEXT NOT NULL DEFAULT '',
           last_message_preview TEXT NOT NULL DEFAULT '',
           message_count INTEGER NOT NULL DEFAULT 0,
           model TEXT NOT NULL DEFAULT '',
           api_profile_name TEXT NOT NULL DEFAULT '',
           thinking_strength TEXT,
           responses_fast_mode INTEGER,
           last_response_id TEXT NOT NULL DEFAULT '',
           status TEXT NOT NULL DEFAULT 'active',
           input_tokens INTEGER NOT NULL DEFAULT 0,
           output_tokens INTEGER NOT NULL DEFAULT 0,
           cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
           cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
           total_duration_ms INTEGER NOT NULL DEFAULT 0,
           run_input_tokens INTEGER NOT NULL DEFAULT 0,
           run_output_tokens INTEGER NOT NULL DEFAULT 0,
           run_cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
           run_cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
           last_run_duration_ms INTEGER NOT NULL DEFAULT 0,
           directory_id TEXT NOT NULL DEFAULT '',
           forked_from_conversation_id TEXT NOT NULL DEFAULT '',
           fork_message_count INTEGER NOT NULL DEFAULT 0,
           emoji TEXT NOT NULL DEFAULT '',
           plan_mode INTEGER,
           goal_mode INTEGER,
           worktree_mode INTEGER,
           goal_mode_token_budget INTEGER,
           created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
           updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
           archived_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
         );
         CREATE INDEX IF NOT EXISTS idx_archive_conversations_archived_at
           ON chat_conversations(archived_at DESC, id DESC);
         CREATE INDEX IF NOT EXISTS idx_archive_conversations_updated_at
           ON chat_conversations(updated_at DESC, id DESC);
         CREATE INDEX IF NOT EXISTS idx_archive_conversations_status
           ON chat_conversations(status);

         CREATE TABLE IF NOT EXISTS chat_messages (
           id TEXT PRIMARY KEY NOT NULL,
           message_id TEXT NOT NULL UNIQUE,
           conversation_id TEXT NOT NULL,
           role TEXT NOT NULL,
           content TEXT NOT NULL,
           model TEXT NOT NULL DEFAULT '',
           response_id TEXT NOT NULL DEFAULT '',
           checkpoint_id TEXT NOT NULL DEFAULT '',
           status TEXT NOT NULL DEFAULT 'sent',
           raw_json TEXT NOT NULL DEFAULT '{}',
           thinking TEXT NOT NULL DEFAULT '',
           thinking_duration_ms INTEGER NOT NULL DEFAULT 0,
           thinking_token_count INTEGER NOT NULL DEFAULT 0,
           thinking_blocks_json TEXT NOT NULL DEFAULT '[]',
           tool_calls_json TEXT NOT NULL DEFAULT '[]',
           created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
           FOREIGN KEY(conversation_id) REFERENCES chat_conversations(conversation_id) ON DELETE CASCADE
         );
         CREATE INDEX IF NOT EXISTS idx_archive_messages_conversation_id
           ON chat_messages(conversation_id, id ASC);

         CREATE TABLE IF NOT EXISTS todo_items (
           id TEXT PRIMARY KEY NOT NULL,
           session_id TEXT NOT NULL,
           content TEXT NOT NULL,
           status TEXT NOT NULL DEFAULT 'pending',
           response_id TEXT NOT NULL DEFAULT '',
           created_at TEXT NOT NULL,
           updated_at TEXT NOT NULL,
           parent_id TEXT
         );
         CREATE INDEX IF NOT EXISTS idx_archive_todo_items_session
           ON todo_items(session_id);

         CREATE TABLE IF NOT EXISTS sub_agent_sessions (
           id TEXT PRIMARY KEY NOT NULL,
           conversation_id TEXT NOT NULL UNIQUE,
           parent_conversation_id TEXT NOT NULL,
           agent_id TEXT NOT NULL,
           agent_name TEXT NOT NULL DEFAULT '',
           run_status TEXT NOT NULL DEFAULT 'running',
           error_message TEXT NOT NULL DEFAULT '',
           created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
           updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
           FOREIGN KEY(conversation_id) REFERENCES chat_conversations(conversation_id) ON DELETE CASCADE,
           FOREIGN KEY(parent_conversation_id) REFERENCES chat_conversations(conversation_id) ON DELETE CASCADE
         );
         CREATE INDEX IF NOT EXISTS idx_archive_sub_agent_sessions_parent
           ON sub_agent_sessions(parent_conversation_id, created_at ASC, id ASC);

         CREATE TABLE IF NOT EXISTS workflow_node_sessions (
           id TEXT PRIMARY KEY NOT NULL,
           conversation_id TEXT NOT NULL UNIQUE,
           parent_conversation_id TEXT NOT NULL,
           flow_id TEXT NOT NULL DEFAULT '',
           flow_checkpoint_id TEXT NOT NULL DEFAULT '',
           node_id TEXT NOT NULL,
           node_name TEXT NOT NULL DEFAULT '',
           run_status TEXT NOT NULL DEFAULT 'pending',
           error_message TEXT NOT NULL DEFAULT '',
           handoff_content TEXT NOT NULL DEFAULT '',
           created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
           updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
           FOREIGN KEY(conversation_id) REFERENCES chat_conversations(conversation_id) ON DELETE CASCADE,
           FOREIGN KEY(parent_conversation_id) REFERENCES chat_conversations(conversation_id) ON DELETE CASCADE
         );
         CREATE INDEX IF NOT EXISTS idx_archive_workflow_node_sessions_flow
           ON workflow_node_sessions(parent_conversation_id, flow_id);
         CREATE INDEX IF NOT EXISTS idx_archive_workflow_node_sessions_parent
           ON workflow_node_sessions(parent_conversation_id, created_at ASC, id ASC);

         -- WorkFlow run 级状态（与运行库 workflow_runs 一致）：归档后还原时
         -- 保留断点续跑进度（已完成的节点/累积 handoff/token）。
         CREATE TABLE IF NOT EXISTS workflow_runs (
           id TEXT PRIMARY KEY NOT NULL,
           parent_conversation_id TEXT NOT NULL,
           flow_id TEXT NOT NULL DEFAULT '',
           run_status TEXT NOT NULL DEFAULT 'running',
           current_node_index INTEGER NOT NULL DEFAULT 0,
           last_handoff TEXT NOT NULL DEFAULT '',
           total_tokens INTEGER NOT NULL DEFAULT 0,
           flow_checkpoint_id TEXT NOT NULL DEFAULT '',
           directory_id TEXT NOT NULL DEFAULT '',
           error_message TEXT NOT NULL DEFAULT '',
           created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
           updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
           UNIQUE(parent_conversation_id, flow_id)
         );
         CREATE INDEX IF NOT EXISTS idx_archive_workflow_runs_parent
           ON workflow_runs(parent_conversation_id, flow_id);

         -- WorkFlow 画布（与运行库 workflow_canvases 一致）：归档后还原时
         -- 保留用户对节点/连线的定制。
         CREATE TABLE IF NOT EXISTS workflow_canvases (
           parent_conversation_id TEXT NOT NULL,
           interaction_id TEXT NOT NULL,
           canvas_json TEXT NOT NULL DEFAULT '{}',
           updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
           PRIMARY KEY (parent_conversation_id, interaction_id)
         );
     ",
    )?;
    migrate_archive_chat_conversations(connection)?;
    migrate_archive_chat_messages(connection)
}

fn migrate_archive_chat_conversations(connection: &Connection) -> rusqlite::Result<()> {
    let mut statement = connection.prepare("PRAGMA table_info(chat_conversations)")?;
    let columns: Vec<String> = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    for (name, definition) in [
        ("api_profile_name", "TEXT NOT NULL DEFAULT ''"),
        ("plan_mode", "INTEGER"),
        ("goal_mode", "INTEGER"),
        ("worktree_mode", "INTEGER"),
        ("goal_mode_token_budget", "INTEGER"),
        ("run_input_tokens", "INTEGER NOT NULL DEFAULT 0"),
        ("run_output_tokens", "INTEGER NOT NULL DEFAULT 0"),
        (
            "run_cache_creation_input_tokens",
            "INTEGER NOT NULL DEFAULT 0",
        ),
        ("run_cache_read_input_tokens", "INTEGER NOT NULL DEFAULT 0"),
        ("last_run_duration_ms", "INTEGER NOT NULL DEFAULT 0"),
    ] {
        if !columns.iter().any(|column| column == name) {
            connection.execute(
                &format!("ALTER TABLE chat_conversations ADD COLUMN {name} {definition}"),
                [],
            )?;
        }
    }

    Ok(())
}

/// Add the thinking-phase statistics columns to archive databases created
/// before the thinking block summary existed. Restoring an archive copies
/// `chat_messages` by explicit column list, so an old archive database that
/// lacks the columns would fail the restore — patch them here on open.
fn migrate_archive_chat_messages(connection: &Connection) -> rusqlite::Result<()> {
    let mut statement = connection.prepare("PRAGMA table_info(chat_messages)")?;
    let columns: Vec<String> = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    for (name, definition) in [
        ("thinking_duration_ms", "INTEGER NOT NULL DEFAULT 0"),
        ("thinking_token_count", "INTEGER NOT NULL DEFAULT 0"),
    ] {
        if !columns.iter().any(|column| column == name) {
            connection.execute(
                &format!("ALTER TABLE chat_messages ADD COLUMN {name} {definition}"),
                [],
            )?;
        }
    }

    Ok(())
}

/// Add nullable runtime override columns to archive databases created before
/// conversation thinking/Fast Mode persistence existed. Existing archived rows
/// remain NULL and therefore continue to inherit their restored profile default.
fn migrate_archive_runtime_config(connection: &Connection) -> rusqlite::Result<()> {
    let mut statement = connection.prepare("PRAGMA table_info(chat_conversations)")?;
    let columns: Vec<String> = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    if !columns.iter().any(|column| column == "thinking_strength") {
        connection.execute(
            "ALTER TABLE chat_conversations ADD COLUMN thinking_strength TEXT",
            [],
        )?;
    }
    if !columns.iter().any(|column| column == "responses_fast_mode") {
        connection.execute(
            "ALTER TABLE chat_conversations ADD COLUMN responses_fast_mode INTEGER",
            [],
        )?;
    }

    Ok(())
}

/// 确保归档冷数据库存在且结构就绪。
pub fn ensure_archive_database(archive_path: &Path) -> Result<()> {
    let connection = open_archive_connection(archive_path).map_err(|error| {
        database::database_error(archive_path, "initialize archive database", error)
    })?;
    create_archive_schema(&connection)
        .map_err(|error| database::database_error(archive_path, "initialize archive database", error))?;
    migrate_archive_runtime_config(&connection)
        .map_err(|error| database::database_error(archive_path, "initialize archive database", error))?;
    connection
        .pragma_update(None, "user_version", 1)
        .map_err(|error| database::database_error(archive_path, "initialize archive database", error))?;
    Ok(())
}

/// 归档会话：从运行库搬移到归档冷库（含子代理级联），并清理运行库中的
/// 会话、消息、todo 与子代理会话行。置顶会话不参与归档（数据不搬移、
/// 不删除），保持运行库列表完整。
///
/// 以运行库连接为主连接，归档库通过 ATTACH 挂载；ATTACH 必须先于
/// BEGIN IMMEDIATE，否则同一连接在写事务中初始化归档库锁会报
/// SQLITE_LOCKED "database archive_db is locked"。
pub fn archive_conversations(
    main_database_path: &Path,
    archive_database_path: &Path,
    conversation_ids: &[String],
) -> Result<()> {
    let unique_ids = unique_conversation_ids(conversation_ids);
    if unique_ids.is_empty() {
        return Ok(());
    }

    ensure_archive_database(archive_database_path)?;

    let mut connection = database::open_connection(main_database_path).map_err(|error| {
        database::database_error(main_database_path, "archive conversations", error)
    })?;

    let archive_path_str = archive_database_path.to_str().ok_or_else(|| {
        Error::from_reason(format!(
            "Archive database path is not valid UTF-8: {}",
            archive_database_path.display()
        ))
    })?;

    // 挂载归档库必须在事务开始之前完成：在已有写事务的连接上 ATTACH 另一个
    // 数据库时，SQLite 需要初始化其锁，而连接已持有主库写锁，会报
    // "database archive_db is locked"（SQLITE_LOCKED）。先 ATTACH 再
    // BEGIN IMMEDIATE 才是 SQLite 多数据库原子事务的正确顺序。
    connection
        .execute("ATTACH DATABASE ?1 AS archive_db", params![archive_path_str])
        .map_err(|error| database::database_error(main_database_path, "archive conversations", error))?;

    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| database::database_error(main_database_path, "archive conversations", error))?;

    // 置顶会话不允许归档：只处理选中项中的非置顶会话
    let mut archivable_ids: Vec<String> = Vec::new();
    {
        let placeholders = in_clause_placeholders(unique_ids.len());
        let mut statement = transaction
            .prepare(&format!(
                "SELECT conversation_id
                   FROM chat_conversations
                  WHERE conversation_id IN ({placeholders})
                    AND status != 'pin'"
            ))
            .map_err(|error| {
                database::database_error(main_database_path, "archive conversations", error)
            })?;
        let rows = statement
            .query_map(params_from_iter(unique_ids.iter()), |row| {
                row.get::<_, String>(0)
            })
            .map_err(|error| {
                database::database_error(main_database_path, "archive conversations", error)
            })?;
        for row in rows {
            let id = row.map_err(|error| {
                database::database_error(main_database_path, "archive conversations", error)
            })?;
            archivable_ids.push(id);
        }
    }

    if archivable_ids.is_empty() {
        transaction
            .commit()
            .map_err(|error| {
                database::database_error(main_database_path, "archive conversations", error)
            })?;
        connection
            .execute_batch("DETACH DATABASE archive_db")
            .map_err(|error| {
                database::database_error(main_database_path, "archive conversations", error)
            })?;
        return Ok(());
    }

    // 子代理会话随父会话一并归档
    let mut all_target_ids = archivable_ids.clone();

    // WorkFlow 节点会话随父会话一并归档（归档库中作为普通会话保存，
    // 还原后不再作为 workflow 节点运行）
    {
        let placeholders = in_clause_placeholders(archivable_ids.len());
        let mut statement = transaction
            .prepare(&format!(
                "SELECT conversation_id
                   FROM workflow_node_sessions
                  WHERE parent_conversation_id IN ({placeholders})"
            ))
            .map_err(|error| {
                database::database_error(main_database_path, "archive conversations", error)
            })?;
        let rows = statement
            .query_map(params_from_iter(archivable_ids.iter()), |row| {
                row.get::<_, String>(0)
            })
            .map_err(|error| {
                database::database_error(main_database_path, "archive conversations", error)
            })?;
        for child_id in rows {
            let child_id = child_id.map_err(|error| {
                database::database_error(main_database_path, "archive conversations", error)
            })?;
            if !all_target_ids.contains(&child_id) {
                all_target_ids.push(child_id);
            }
        }
    }

    // 子代理查询覆盖全部父级目标（含 workflow 节点），确保节点运行期间
    // 派生的子代理随节点一并归档
    {
        let placeholders = in_clause_placeholders(all_target_ids.len());
        let mut statement = transaction
            .prepare(&format!(
                "SELECT conversation_id
                   FROM sub_agent_sessions
                  WHERE parent_conversation_id IN ({placeholders})"
            ))
            .map_err(|error| {
                database::database_error(main_database_path, "archive conversations", error)
            })?;
        let rows = statement
            .query_map(params_from_iter(all_target_ids.iter()), |row| {
                row.get::<_, String>(0)
            })
            .map_err(|error| {
                database::database_error(main_database_path, "archive conversations", error)
            })?;
        for child_id in rows {
            let child_id = child_id.map_err(|error| {
                database::database_error(main_database_path, "archive conversations", error)
            })?;
            if !all_target_ids.contains(&child_id) {
                all_target_ids.push(child_id);
            }
        }
    }

    // ---- 拷贝到归档库 ----
    // 会话先写入（外键依赖），再写子代理会话、消息、todo
    for chunk in all_target_ids.chunks(MAX_VARIABLES) {
        let placeholders = in_clause_placeholders(chunk.len());
        transaction
            .execute(
                &format!(
                    "INSERT INTO archive_db.chat_conversations ({CONVERSATION_COLUMNS}, archived_at)
                     SELECT {CONVERSATION_COLUMNS}, datetime('now', 'localtime')
                       FROM chat_conversations
                      WHERE conversation_id IN ({placeholders})"
                ),
                params_from_iter(chunk.iter()),
            )
            .map_err(|error| {
                database::database_error(main_database_path, "archive conversations", error)
            })?;
    }
    for chunk in all_target_ids.chunks(MAX_VARIABLES) {
        let placeholders = in_clause_placeholders(chunk.len());
        let mut params: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(chunk.len() * 2);
        for id in chunk {
            params.push(id);
        }
        for id in chunk {
            params.push(id);
        }
        transaction
            .execute(
                &format!(
                    "INSERT INTO archive_db.sub_agent_sessions ({SESSION_COLUMNS})
                     SELECT {SESSION_COLUMNS}
                       FROM sub_agent_sessions
                      WHERE parent_conversation_id IN ({placeholders})
                         OR conversation_id IN ({placeholders})"
                ),
                params_from_iter(params),
            )
            .map_err(|error| {
                database::database_error(main_database_path, "archive conversations", error)
            })?;
    }

    // WorkFlow 节点 bookkeeping 行随父会话一并归档：保留父子层级，
    // 还原后节点树（workflowNodeMap）可完整恢复。
    for chunk in all_target_ids.chunks(MAX_VARIABLES) {
        let placeholders = in_clause_placeholders(chunk.len());
        let mut params: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(chunk.len() * 2);
        for id in chunk {
            params.push(id);
        }
        for id in chunk {
            params.push(id);
        }
        transaction
            .execute(
                &format!(
                    "INSERT INTO archive_db.workflow_node_sessions ({WORKFLOW_NODE_SESSION_COLUMNS})
                     SELECT {WORKFLOW_NODE_SESSION_COLUMNS}
                       FROM workflow_node_sessions
                      WHERE parent_conversation_id IN ({placeholders})
                         OR conversation_id IN ({placeholders})"
                ),
                params_from_iter(params),
            )
            .map_err(|error| {
                database::database_error(main_database_path, "archive conversations", error)
            })?;
    }
    // WorkFlow run 级状态随父会话归档：断点续跑进度（已完成节点、
    // 累积 handoff/token）在还原后保留。按 parent_conversation_id 归属。
    for chunk in archivable_ids.chunks(MAX_VARIABLES) {
        let placeholders = in_clause_placeholders(chunk.len());
        transaction
            .execute(
                &format!(
                    "INSERT INTO archive_db.workflow_runs ({WORKFLOW_RUN_COLUMNS})
                     SELECT {WORKFLOW_RUN_COLUMNS}
                       FROM workflow_runs
                      WHERE parent_conversation_id IN ({placeholders})"
                ),
                params_from_iter(chunk.iter()),
            )
            .map_err(|error| {
                database::database_error(main_database_path, "archive conversations", error)
            })?;
    }
    // WorkFlow 画布随父会话归档：用户对节点/连线的定制在还原后保留。
    for chunk in archivable_ids.chunks(MAX_VARIABLES) {
        let placeholders = in_clause_placeholders(chunk.len());
        transaction
            .execute(
                &format!(
                    "INSERT INTO archive_db.workflow_canvases ({WORKFLOW_CANVAS_COLUMNS})
                     SELECT {WORKFLOW_CANVAS_COLUMNS}
                       FROM workflow_canvases
                      WHERE parent_conversation_id IN ({placeholders})"
                ),
                params_from_iter(chunk.iter()),
            )
            .map_err(|error| {
                database::database_error(main_database_path, "archive conversations", error)
            })?;
    }
    for chunk in all_target_ids.chunks(MAX_VARIABLES) {
        let placeholders = in_clause_placeholders(chunk.len());
        transaction
            .execute(
                &format!(
                    "INSERT INTO archive_db.chat_messages ({MESSAGE_COLUMNS})
                     SELECT {MESSAGE_COLUMNS}
                       FROM chat_messages
                      WHERE conversation_id IN ({placeholders})"
                ),
                params_from_iter(chunk.iter()),
            )
            .map_err(|error| {
                database::database_error(main_database_path, "archive conversations", error)
            })?;
        transaction
            .execute(
                &format!(
                    "INSERT INTO archive_db.todo_items ({TODO_COLUMNS})
                     SELECT {TODO_COLUMNS}
                       FROM todo_items
                      WHERE session_id IN ({placeholders})"
                ),
                params_from_iter(chunk.iter()),
            )
            .map_err(|error| {
                database::database_error(main_database_path, "archive conversations", error)
            })?;
    }

    // ---- 清理运行库（与 delete_conversations 语义一致）----
    for chunk in all_target_ids.chunks(MAX_VARIABLES) {
        let placeholders = in_clause_placeholders(chunk.len());
        transaction
            .execute(
                &format!("DELETE FROM chat_messages WHERE conversation_id IN ({placeholders})"),
                params_from_iter(chunk.iter()),
            )
            .map_err(|error| {
                database::database_error(main_database_path, "archive conversations", error)
            })?;
        transaction
            .execute(
                &format!("DELETE FROM todo_items WHERE session_id IN ({placeholders})"),
                params_from_iter(chunk.iter()),
            )
            .map_err(|error| {
                database::database_error(main_database_path, "archive conversations", error)
            })?;
    }
    for chunk in archivable_ids.chunks(MAX_VARIABLES) {
        let placeholders = in_clause_placeholders(chunk.len());
        let mut params: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(chunk.len() * 2);
        for id in chunk {
            params.push(id);
        }
        for id in chunk {
            params.push(id);
        }
        transaction
            .execute(
                &format!(
                    "DELETE FROM sub_agent_sessions
                      WHERE parent_conversation_id IN ({placeholders})
                         OR conversation_id IN ({placeholders})"
                ),
                params_from_iter(params),
            )
            .map_err(|error| {
                database::database_error(main_database_path, "archive conversations", error)
            })?;
    }
    for chunk in archivable_ids.chunks(MAX_VARIABLES) {
        let placeholders = in_clause_placeholders(chunk.len());
        let mut params: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(chunk.len() * 2);
        for id in chunk {
            params.push(id);
        }
        for id in chunk {
            params.push(id);
        }
        transaction
            .execute(
                &format!(
                    "DELETE FROM workflow_node_sessions
                      WHERE parent_conversation_id IN ({placeholders})
                         OR conversation_id IN ({placeholders})"
                ),
                params_from_iter(params),
            )
            .map_err(|error| {
                database::database_error(main_database_path, "archive conversations", error)
            })?;
    }
    // 已归档父会话的 run 级状态与画布一并从运行库清理（run/canvas 行
    // 按 parent_conversation_id 归属，不随节点会话级联删除）。
    for chunk in archivable_ids.chunks(MAX_VARIABLES) {
        let placeholders = in_clause_placeholders(chunk.len());
        transaction
            .execute(
                &format!(
                    "DELETE FROM workflow_runs WHERE parent_conversation_id IN ({placeholders})"
                ),
                params_from_iter(chunk.iter()),
            )
            .map_err(|error| {
                database::database_error(main_database_path, "archive conversations", error)
            })?;
        transaction
            .execute(
                &format!(
                    "DELETE FROM workflow_canvases WHERE parent_conversation_id IN ({placeholders})"
                ),
                params_from_iter(chunk.iter()),
            )
            .map_err(|error| {
                database::database_error(main_database_path, "archive conversations", error)
            })?;
    }
    for chunk in all_target_ids.chunks(MAX_VARIABLES) {
        let placeholders = in_clause_placeholders(chunk.len());
        transaction
            .execute(
                &format!("DELETE FROM chat_conversations WHERE conversation_id IN ({placeholders})"),
                params_from_iter(chunk.iter()),
            )
            .map_err(|error| {
                database::database_error(main_database_path, "archive conversations", error)
            })?;
    }

    transaction
        .commit()
        .map_err(|error| {
            database::database_error(main_database_path, "archive conversations", error)
        })?;
    connection
        .execute_batch("DETACH DATABASE archive_db")
        .map_err(|error| {
            database::database_error(main_database_path, "archive conversations", error)
        })?;

    // ---- 收缩运行库文件 ----
    // DELETE 只把页面标记为空闲页（auto_vacuum=NONE），物理文件大小不变，
    // 归档后必须 VACUUM 重建数据库文件才能立即回收这些页面。
    // VACUUM 不能在事务中、也不能在存在附加数据库时执行，故放在
    // COMMIT 与 DETACH 之后。归档事务已提交，VACUUM 仅是空间优化，
    // 失败（如其他连接占用导致 busy_timeout 超时）不应让上层误判归档
    // 失败，记录日志后忽略。
    if let Err(error) = connection.execute_batch("VACUUM") {
        eprintln!(
            "Snow App archive VACUUM failed (conversations already archived): {}",
            error
        );
    }

    Ok(())
}

/// 分页列出归档会话（仅顶层会话，子代理随父会话归档不单独展示），
/// 按归档时间倒序。
pub fn list_archived_conversations_paginated(
    archive_path: &Path,
    directory_id: &str,
    limit: i32,
    offset: i32,
) -> Result<ChatConversationPage> {
    // 确保归档库 schema 就绪（旧归档库可能缺少 workflow_node_sessions 表）
    ensure_archive_database(archive_path)?;
    open_archive_connection(archive_path)
        .and_then(|connection| {
            let total: i32 = connection.query_row(
                "SELECT COUNT(*)
                   FROM chat_conversations AS conversation
                  WHERE directory_id = ?1
                    AND status = 'active'
                    AND NOT EXISTS (
                      SELECT 1
                        FROM sub_agent_sessions AS sub_agent
                       WHERE sub_agent.conversation_id = conversation.conversation_id
                    )
                    AND NOT EXISTS (
                      SELECT 1
                        FROM workflow_node_sessions AS workflow_node
                       WHERE workflow_node.conversation_id = conversation.conversation_id
                    )",
                params![directory_id],
                |row| row.get(0),
            )?;

            let safe_limit = if limit > 0 { limit } else { 20 };
            let safe_offset = if offset > 0 { offset } else { 0 };

            let mut statement = connection.prepare(
                "SELECT conversation_id,
                        title,
                        summary,
                        last_message_preview,
                        message_count,
                        model,
                        status,
                        directory_id,
                        forked_from_conversation_id,
                        fork_message_count,
                        created_at,
                        updated_at,
                        input_tokens,
                        output_tokens,
                        cache_creation_input_tokens,
                        cache_read_input_tokens,
                       'main',
                       '',
                       '',
                       '',
                       '',
                       '',
                       0,
                       COALESCE(emoji, ''),
                       api_profile_name,
                       conversation.run_input_tokens,
                       conversation.run_output_tokens,
                       conversation.run_cache_creation_input_tokens,
                       conversation.run_cache_read_input_tokens,
                       COALESCE(conversation.last_run_duration_ms, 0)
                  FROM chat_conversations AS conversation
                  WHERE directory_id = ?1
                    AND status = 'active'
                    AND NOT EXISTS (
                      SELECT 1
                        FROM sub_agent_sessions AS sub_agent
                       WHERE sub_agent.conversation_id = conversation.conversation_id
                    )
                    AND NOT EXISTS (
                      SELECT 1
                        FROM workflow_node_sessions AS workflow_node
                       WHERE workflow_node.conversation_id = conversation.conversation_id
                    )
                  ORDER BY archived_at DESC, id DESC
                  LIMIT ?2 OFFSET ?3",
            )?;

            let rows = statement.query_map(
                params![directory_id, safe_limit, safe_offset],
                map_archived_conversation_row,
            )?;
            let items: Vec<ChatConversationRecord> =
                rows.collect::<rusqlite::Result<Vec<_>>>()?;

            Ok(ChatConversationPage { items, total })
        })
        .map_err(|error| {
            database::database_error(archive_path, "list archived conversations paginated", error)
        })
}

fn map_archived_conversation_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<ChatConversationRecord> {
    Ok(ChatConversationRecord {
        conversation_id: row.get(0)?,
        title: row.get(1)?,
        summary: row.get(2)?,
        last_message_preview: row.get(3)?,
        message_count: row.get(4)?,
        model: row.get(5)?,
        api_profile_name: row.get(24)?,
        status: row.get(6)?,
        directory_id: row.get(7)?,
        forked_from_conversation_id: row.get(8)?,
        fork_message_count: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
        input_tokens: row.get(12)?,
        output_tokens: row.get(13)?,
        cache_creation_input_tokens: row.get(14)?,
        cache_read_input_tokens: row.get(15)?,
        conversation_type: row.get(16)?,
        parent_conversation_id: row.get(17)?,
        sub_agent_id: row.get(18)?,
        sub_agent_name: row.get(19)?,
        sub_agent_status: row.get(20)?,
        sub_agent_error: row.get(21)?,
        total_duration_ms: row.get(22)?,
        emoji: row.get(23)?,
        run_input_tokens: row.get(25)?,
        run_output_tokens: row.get(26)?,
        run_cache_creation_input_tokens: row.get(27)?,
        run_cache_read_input_tokens: row.get(28)?,
        last_run_duration_ms: row.get(29)?,
    })
}

/// 还原归档会话：从归档冷库搬移回运行库（含子代理级联），并清理归档库。
/// 还原后的会话恢复为可用状态（status 保持归档时的 active）。
///
/// 与归档一致：以运行库连接为主连接、归档库为附加库，先 ATTACH 再
/// BEGIN IMMEDIATE，单事务完成 拷贝 + 删除。
pub fn restore_archived_conversations(
    main_database_path: &Path,
    archive_database_path: &Path,
    conversation_ids: &[String],
) -> Result<()> {
    let unique_ids = unique_conversation_ids(conversation_ids);
    if unique_ids.is_empty() {
        return Ok(());
    }

    // 确保归档库 schema 就绪（旧归档库可能缺少 workflow_node_sessions 表）
    ensure_archive_database(archive_database_path)?;

    let mut connection = database::open_connection(main_database_path).map_err(|error| {
        database::database_error(main_database_path, "restore archived conversations", error)
    })?;

    let archive_path_str = archive_database_path.to_str().ok_or_else(|| {
        Error::from_reason(format!(
            "Archive database path is not valid UTF-8: {}",
            archive_database_path.display()
        ))
    })?;

    // 先 ATTACH 再 BEGIN IMMEDIATE（与归档一致，见 archive_conversations）
    connection
        .execute("ATTACH DATABASE ?1 AS archive_db", params![archive_path_str])
        .map_err(|error| {
            database::database_error(main_database_path, "restore archived conversations", error)
        })?;

    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| {
            database::database_error(main_database_path, "restore archived conversations", error)
        })?;

    // 还原目标：选中会话 + 其 workflow 节点会话 + 子代理会话
    // （子代理覆盖节点运行期间派生的层级）
    let mut all_target_ids = unique_ids.clone();
    {
        // WorkFlow 节点会话：层级关系从归档库 workflow_node_sessions 恢复
        let placeholders = in_clause_placeholders(unique_ids.len());
        let mut statement = transaction
            .prepare(&format!(
                "SELECT conversation_id
                   FROM archive_db.workflow_node_sessions
                  WHERE parent_conversation_id IN ({placeholders})"
            ))
            .map_err(|error| {
                database::database_error(main_database_path, "restore archived conversations", error)
            })?;
        let rows = statement
            .query_map(params_from_iter(unique_ids.iter()), |row| {
                row.get::<_, String>(0)
            })
            .map_err(|error| {
                database::database_error(main_database_path, "restore archived conversations", error)
            })?;
        for child_id in rows {
            let child_id = child_id.map_err(|error| {
                database::database_error(main_database_path, "restore archived conversations", error)
            })?;
            if !all_target_ids.contains(&child_id) {
                all_target_ids.push(child_id);
            }
        }
    }
    {
        let placeholders = in_clause_placeholders(all_target_ids.len());
        let mut statement = transaction
            .prepare(&format!(
                "SELECT conversation_id
                   FROM archive_db.sub_agent_sessions
                  WHERE parent_conversation_id IN ({placeholders})"
            ))
            .map_err(|error| {
                database::database_error(main_database_path, "restore archived conversations", error)
            })?;
        let rows = statement
            .query_map(params_from_iter(all_target_ids.iter()), |row| {
                row.get::<_, String>(0)
            })
            .map_err(|error| {
                database::database_error(main_database_path, "restore archived conversations", error)
            })?;
        for child_id in rows {
            let child_id = child_id.map_err(|error| {
                database::database_error(main_database_path, "restore archived conversations", error)
            })?;
            if !all_target_ids.contains(&child_id) {
                all_target_ids.push(child_id);
            }
        }
    }

    // ---- 拷贝回运行库 ----
    // 会话 → 子代理会话 → 消息 → todo（外键依赖顺序）。
    // 还原的会话 updated_at 刷新为当前时间：会话列表按 updated_at 倒序，
    // 归档前的旧时间戳会让还原的会话排到列表深处甚至不可见。
    for chunk in all_target_ids.chunks(MAX_VARIABLES) {
        let placeholders = in_clause_placeholders(chunk.len());
        transaction
            .execute(
                &format!(
                    "INSERT INTO chat_conversations ({CONVERSATION_COLUMNS})
                     SELECT id, conversation_id, title, summary, last_message_preview,
                            message_count, model, api_profile_name, thinking_strength,
                            responses_fast_mode, last_response_id, status,
                            input_tokens, output_tokens, cache_creation_input_tokens,
                            cache_read_input_tokens, total_duration_ms,
                            run_input_tokens, run_output_tokens,
                            run_cache_creation_input_tokens, run_cache_read_input_tokens,
                            last_run_duration_ms, directory_id,
                            forked_from_conversation_id, fork_message_count, emoji,
                            plan_mode, goal_mode, worktree_mode, goal_mode_token_budget, created_at,
                            datetime('now', 'localtime')
                       FROM archive_db.chat_conversations
                      WHERE conversation_id IN ({placeholders})"
                ),
                params_from_iter(chunk.iter()),
            )
            .map_err(|error| {
                database::database_error(main_database_path, "restore archived conversations", error)
            })?;
    }
    for chunk in all_target_ids.chunks(MAX_VARIABLES) {
        let placeholders = in_clause_placeholders(chunk.len());
        let mut params: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(chunk.len() * 2);
        for id in chunk {
            params.push(id);
        }
        for id in chunk {
            params.push(id);
        }
        transaction
            .execute(
                &format!(
                    "INSERT INTO sub_agent_sessions ({SESSION_COLUMNS})
                     SELECT {SESSION_COLUMNS}
                       FROM archive_db.sub_agent_sessions
                      WHERE parent_conversation_id IN ({placeholders})
                         OR conversation_id IN ({placeholders})"
                ),
                params_from_iter(params),
            )
            .map_err(|error| {
                database::database_error(main_database_path, "restore archived conversations", error)
            })?;
    }

    // WorkFlow 节点 bookkeeping 行还原：恢复 主会话 → 节点 的父子层级
    for chunk in all_target_ids.chunks(MAX_VARIABLES) {
        let placeholders = in_clause_placeholders(chunk.len());
        let mut params: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(chunk.len() * 2);
        for id in chunk {
            params.push(id);
        }
        for id in chunk {
            params.push(id);
        }
        transaction
            .execute(
                &format!(
                    "INSERT INTO workflow_node_sessions ({WORKFLOW_NODE_SESSION_COLUMNS})
                     SELECT {WORKFLOW_NODE_SESSION_COLUMNS}
                       FROM archive_db.workflow_node_sessions
                      WHERE parent_conversation_id IN ({placeholders})
                         OR conversation_id IN ({placeholders})"
                ),
                params_from_iter(params),
            )
.map_err(|error| {
                database::database_error(main_database_path, "restore archived conversations", error)
            })?;
    }
    // WorkFlow run 级状态还原：从归档库恢复断点续跑进度。
    for chunk in unique_ids.chunks(MAX_VARIABLES) {
        let placeholders = in_clause_placeholders(chunk.len());
        transaction
            .execute(
                &format!(
                    "INSERT INTO workflow_runs ({WORKFLOW_RUN_COLUMNS})
                     SELECT {WORKFLOW_RUN_COLUMNS}
                       FROM archive_db.workflow_runs
                      WHERE parent_conversation_id IN ({placeholders})"
                ),
                params_from_iter(chunk.iter()),
            )
            .map_err(|error| {
                database::database_error(main_database_path, "restore archived conversations", error)
            })?;
    }
    // WorkFlow 画布还原：从归档库恢复用户对节点/连线的定制。
    for chunk in unique_ids.chunks(MAX_VARIABLES) {
        let placeholders = in_clause_placeholders(chunk.len());
        transaction
            .execute(
                &format!(
                    "INSERT INTO workflow_canvases ({WORKFLOW_CANVAS_COLUMNS})
                     SELECT {WORKFLOW_CANVAS_COLUMNS}
                       FROM archive_db.workflow_canvases
                      WHERE parent_conversation_id IN ({placeholders})"
                ),
                params_from_iter(chunk.iter()),
            )
            .map_err(|error| {
                database::database_error(main_database_path, "restore archived conversations", error)
            })?;
    }
    for chunk in all_target_ids.chunks(MAX_VARIABLES) {
        let placeholders = in_clause_placeholders(chunk.len());
        transaction
            .execute(
                &format!(
                    "INSERT INTO chat_messages ({MESSAGE_COLUMNS})
                     SELECT {MESSAGE_COLUMNS}
                       FROM archive_db.chat_messages
                      WHERE conversation_id IN ({placeholders})"
                ),
                params_from_iter(chunk.iter()),
            )
            .map_err(|error| {
                database::database_error(main_database_path, "restore archived conversations", error)
            })?;
        transaction
            .execute(
                &format!(
                    "INSERT INTO todo_items ({TODO_COLUMNS})
                     SELECT {TODO_COLUMNS}
                       FROM archive_db.todo_items
                      WHERE session_id IN ({placeholders})"
                ),
                params_from_iter(chunk.iter()),
            )
            .map_err(|error| {
                database::database_error(main_database_path, "restore archived conversations", error)
            })?;
    }

    // ---- 清理归档库 ----
    let mut deleted_rows: usize = 0;
    for chunk in all_target_ids.chunks(MAX_VARIABLES) {
        let placeholders = in_clause_placeholders(chunk.len());
        deleted_rows += transaction
            .execute(
                &format!("DELETE FROM archive_db.chat_messages WHERE conversation_id IN ({placeholders})"),
                params_from_iter(chunk.iter()),
            )
            .map_err(|error| {
                database::database_error(main_database_path, "restore archived conversations", error)
            })?;
        deleted_rows += transaction
            .execute(
                &format!("DELETE FROM archive_db.todo_items WHERE session_id IN ({placeholders})"),
                params_from_iter(chunk.iter()),
            )
            .map_err(|error| {
                database::database_error(main_database_path, "restore archived conversations", error)
            })?;
    }
    for chunk in unique_ids.chunks(MAX_VARIABLES) {
        let placeholders = in_clause_placeholders(chunk.len());
        let mut params: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(chunk.len() * 2);
        for id in chunk {
            params.push(id);
        }
        for id in chunk {
            params.push(id);
        }
        deleted_rows += transaction
            .execute(
                &format!(
                    "DELETE FROM archive_db.sub_agent_sessions
                      WHERE parent_conversation_id IN ({placeholders})
                         OR conversation_id IN ({placeholders})"
                ),
                params_from_iter(params),
            )
            .map_err(|error| {
                database::database_error(main_database_path, "restore archived conversations", error)
            })?;
    }
    for chunk in all_target_ids.chunks(MAX_VARIABLES) {
        let placeholders = in_clause_placeholders(chunk.len());
        let mut params: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(chunk.len() * 2);
        for id in chunk {
            params.push(id);
        }
        for id in chunk {
            params.push(id);
        }
        deleted_rows += transaction
            .execute(
                &format!(
                    "DELETE FROM archive_db.workflow_node_sessions
                      WHERE parent_conversation_id IN ({placeholders})
                         OR conversation_id IN ({placeholders})"
                ),
                params_from_iter(params),
            )
            .map_err(|error| {
                database::database_error(main_database_path, "restore archived conversations", error)
            })?;
    }
    // 已还原父会话的 run 级状态与画布从归档库清理。
    for chunk in unique_ids.chunks(MAX_VARIABLES) {
        let placeholders = in_clause_placeholders(chunk.len());
        deleted_rows += transaction
            .execute(
                &format!(
                    "DELETE FROM archive_db.workflow_runs WHERE parent_conversation_id IN ({placeholders})"
                ),
                params_from_iter(chunk.iter()),
            )
            .map_err(|error| {
                database::database_error(main_database_path, "restore archived conversations", error)
            })?;
        deleted_rows += transaction
            .execute(
                &format!(
                    "DELETE FROM archive_db.workflow_canvases WHERE parent_conversation_id IN ({placeholders})"
                ),
                params_from_iter(chunk.iter()),
            )
            .map_err(|error| {
                database::database_error(main_database_path, "restore archived conversations", error)
            })?;
    }
    for chunk in all_target_ids.chunks(MAX_VARIABLES) {
        let placeholders = in_clause_placeholders(chunk.len());
        deleted_rows += transaction
            .execute(
                &format!("DELETE FROM archive_db.chat_conversations WHERE conversation_id IN ({placeholders})"),
                params_from_iter(chunk.iter()),
            )
            .map_err(|error| {
                database::database_error(main_database_path, "restore archived conversations", error)
            })?;
    }

    transaction
        .commit()
        .map_err(|error| {
            database::database_error(main_database_path, "restore archived conversations", error)
        })?;
    connection
        .execute_batch("DETACH DATABASE archive_db")
        .map_err(|error| {
            database::database_error(main_database_path, "restore archived conversations", error)
        })?;

    // ---- 收缩归档库文件（与归档运行库对称）----
    // 还原从归档库删除了数据，归档库同样不会自动回收空闲页（auto_vacuum=NONE）。
    // VACUUM 不能在事务中、也不能在存在附加数据库时执行，故在 COMMIT+DETACH
    // 之后单独打开归档库连接执行；仅当确实删除了行时才执行。
    // 还原事务已提交，VACUUM 仅是空间优化，失败记录日志后忽略。
    if deleted_rows > 0 {
        let vacuum_result = open_archive_connection(archive_database_path)
            .and_then(|archive_connection| archive_connection.execute_batch("VACUUM"));
        if let Err(error) = vacuum_result {
            eprintln!(
                "Snow App restore VACUUM failed (conversations already restored): {}",
                error
            );
        }
    }

    Ok(())
}

/// 永久删除归档会话（含子代理级联）。
pub fn delete_archived_conversations(
    archive_database_path: &Path,
    conversation_ids: &[String],
) -> Result<()> {
    let unique_ids = unique_conversation_ids(conversation_ids);
    if unique_ids.is_empty() {
        return Ok(());
    }

    // 确保归档库 schema 就绪（旧归档库可能缺少 workflow_node_sessions 表）
    ensure_archive_database(archive_database_path)?;

    let mut connection = open_archive_connection(archive_database_path).map_err(|error| {
        database::database_error(archive_database_path, "delete archived conversations", error)
    })?;

    // 与单条删除一致：先取写锁快照，避免 WAL 下读后写升级导致 BUSY_SNAPSHOT
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| {
            database::database_error(archive_database_path, "delete archived conversations", error)
        })?;

    // 一次查出所有直接子代理会话 id（覆盖全部选中父会话）
    let mut all_target_ids = unique_ids.clone();
    {
        // WorkFlow 节点会话随父会话级联删除
        let placeholders = in_clause_placeholders(unique_ids.len());
        let mut statement = transaction
            .prepare(&format!(
                "SELECT conversation_id
                   FROM workflow_node_sessions
                  WHERE parent_conversation_id IN ({placeholders})"
            ))
            .map_err(|error| {
                database::database_error(archive_database_path, "delete archived conversations", error)
            })?;
        let rows = statement
            .query_map(params_from_iter(unique_ids.iter()), |row| {
                row.get::<_, String>(0)
            })
            .map_err(|error| {
                database::database_error(archive_database_path, "delete archived conversations", error)
            })?;
        for child_id in rows {
            let child_id = child_id.map_err(|error| {
                database::database_error(archive_database_path, "delete archived conversations", error)
            })?;
            if !all_target_ids.contains(&child_id) {
                all_target_ids.push(child_id);
            }
        }
    }
    {
        // 子代理查询覆盖全部父级目标（含 workflow 节点），确保节点运行期间
        // 派生的子代理随节点一并删除
        let placeholders = in_clause_placeholders(all_target_ids.len());
        let mut statement = transaction
            .prepare(&format!(
                "SELECT conversation_id
                   FROM sub_agent_sessions
                  WHERE parent_conversation_id IN ({placeholders})"
            ))
            .map_err(|error| {
                database::database_error(archive_database_path, "delete archived conversations", error)
            })?;
        let rows = statement
            .query_map(params_from_iter(all_target_ids.iter()), |row| {
                row.get::<_, String>(0)
            })
            .map_err(|error| {
                database::database_error(archive_database_path, "delete archived conversations", error)
            })?;
        for child_id in rows {
            let child_id = child_id.map_err(|error| {
                database::database_error(archive_database_path, "delete archived conversations", error)
            })?;
            if !all_target_ids.contains(&child_id) {
                all_target_ids.push(child_id);
            }
        }
    }

    let mut deleted_rows: usize = 0;
    for chunk in all_target_ids.chunks(MAX_VARIABLES) {
        let placeholders = in_clause_placeholders(chunk.len());
        deleted_rows += transaction
            .execute(
                &format!("DELETE FROM chat_messages WHERE conversation_id IN ({placeholders})"),
                params_from_iter(chunk.iter()),
            )
            .map_err(|error| {
                database::database_error(archive_database_path, "delete archived conversations", error)
            })?;
        deleted_rows += transaction
            .execute(
                &format!("DELETE FROM todo_items WHERE session_id IN ({placeholders})"),
                params_from_iter(chunk.iter()),
            )
            .map_err(|error| {
                database::database_error(archive_database_path, "delete archived conversations", error)
            })?;
    }

    for chunk in unique_ids.chunks(MAX_VARIABLES) {
        let placeholders = in_clause_placeholders(chunk.len());
        let mut params: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(chunk.len() * 2);
        for id in chunk {
            params.push(id);
        }
        for id in chunk {
            params.push(id);
        }
        deleted_rows += transaction
            .execute(
                &format!(
                    "DELETE FROM sub_agent_sessions
                      WHERE parent_conversation_id IN ({placeholders})
                         OR conversation_id IN ({placeholders})"
                ),
                params_from_iter(params),
            )
            .map_err(|error| {
                database::database_error(archive_database_path, "delete archived conversations", error)
            })?;
    }

    for chunk in all_target_ids.chunks(MAX_VARIABLES) {
        let placeholders = in_clause_placeholders(chunk.len());
        deleted_rows += transaction
            .execute(
                &format!(
                    "DELETE FROM workflow_node_sessions WHERE conversation_id IN ({placeholders})"
                ),
                params_from_iter(chunk.iter()),
            )
            .map_err(|error| {
                database::database_error(archive_database_path, "delete archived conversations", error)
            })?;
    }

    // 已删除父会话的 run 级状态与画布从归档库清理（按 parent_conversation_id 归属）。
    for chunk in unique_ids.chunks(MAX_VARIABLES) {
        let placeholders = in_clause_placeholders(chunk.len());
        deleted_rows += transaction
            .execute(
                &format!(
                    "DELETE FROM workflow_runs WHERE parent_conversation_id IN ({placeholders})"
                ),
                params_from_iter(chunk.iter()),
            )
            .map_err(|error| {
                database::database_error(archive_database_path, "delete archived conversations", error)
            })?;
        deleted_rows += transaction
            .execute(
                &format!(
                    "DELETE FROM workflow_canvases WHERE parent_conversation_id IN ({placeholders})"
                ),
                params_from_iter(chunk.iter()),
            )
            .map_err(|error| {
                database::database_error(archive_database_path, "delete archived conversations", error)
            })?;
    }

    for chunk in all_target_ids.chunks(MAX_VARIABLES) {
        let placeholders = in_clause_placeholders(chunk.len());
        deleted_rows += transaction
            .execute(
                &format!("DELETE FROM chat_conversations WHERE conversation_id IN ({placeholders})"),
                params_from_iter(chunk.iter()),
            )
            .map_err(|error| {
                database::database_error(archive_database_path, "delete archived conversations", error)
            })?;
    }

    transaction
        .commit()
        .map_err(|error| {
            database::database_error(archive_database_path, "delete archived conversations", error)
        })?;

    // ---- 收缩归档库文件（与归档运行库对称）----
    // 永久删除从归档库删除了数据，归档库同样不会自动回收空闲页（auto_vacuum=NONE），
    // 需 VACUUM 重建文件才能立即回收。删除事务已提交，VACUUM 仅是空间优化，
    // 失败记录日志后忽略；仅当确实删除了行时才执行。
    if deleted_rows > 0 {
        if let Err(error) = connection.execute_batch("VACUUM") {
            eprintln!(
                "Snow App delete archived VACUUM failed (conversations already deleted): {}",
                error
            );
        }
    }

    Ok(())
}
