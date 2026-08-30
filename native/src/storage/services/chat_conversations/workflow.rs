use std::collections::HashMap;
use std::path::Path;

use napi::bindgen_prelude::*;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};

use super::super::super::database;
use super::super::super::models::{
    WorkflowCanvasRecord, WorkflowNodeSessionRecord, WorkflowRunRecord,
};
use super::super::super::ChatConversationRecord;
use super::{in_clause_placeholders, map_chat_conversation_row};

/// Create a workflow node session: a `chat_conversations` row bound to the
/// node's own API profile/model plus a `workflow_node_sessions` bookkeeping row.
pub fn create_workflow_node_session(
    database_path: &Path,
    conversation_id: &str,
    parent_conversation_id: &str,
    flow_id: &str,
    flow_checkpoint_id: &str,
    node_id: &str,
    node_name: &str,
    directory_id: &str,
    api_profile_name: &str,
    model: &str,
) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|mut connection| {
            let transaction = connection.transaction()?;
            transaction.execute(
                "INSERT INTO chat_conversations (
                   id, conversation_id, title, summary, last_message_preview,
                   message_count, model, api_profile_name, last_response_id,
                   status, directory_id, created_at, updated_at
                 ) VALUES (
                   ?1, ?2, ?3, ?3, '', 0, ?4, ?5, '', 'active', ?6,
                   datetime('now', 'localtime'), datetime('now', 'localtime')
                 )",
                params![
                    database::create_snowflake_id(),
                    conversation_id,
                    node_name.trim(),
                    model.trim(),
                    api_profile_name.trim(),
                    directory_id.trim(),
                ],
            )?;
            transaction.execute(
                "INSERT INTO workflow_node_sessions (
                   id, conversation_id, parent_conversation_id, flow_id, flow_checkpoint_id,
                   node_id, node_name,
                   run_status, created_at, updated_at
                 ) VALUES (
                   ?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending',
                   datetime('now', 'localtime'), datetime('now', 'localtime')
                 )",
                params![
                    database::create_snowflake_id(),
                    conversation_id,
                    parent_conversation_id,
                    flow_id,
                    flow_checkpoint_id.trim(),
                    node_id,
                    node_name,
                ],
            )?;
            transaction.commit()?;
            Ok(())
        })
        .map_err(|error| database::database_error(database_path, "create workflow node session", error))
}

/// Update a workflow node session's run status / error / handoff content.
pub fn update_workflow_node_session(
    database_path: &Path,
    conversation_id: &str,
    run_status: &str,
    error_message: &str,
    handoff_content: &str,
) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|connection| {
            connection.execute(
                "UPDATE workflow_node_sessions
                    SET run_status = ?2, error_message = ?3, handoff_content = ?4,
                        updated_at = datetime('now', 'localtime')
                  WHERE conversation_id = ?1",
                params![conversation_id, run_status, error_message, handoff_content],
            )?;
            Ok(())
        })
        .map_err(|error| {
            database::database_error(database_path, "update workflow node session", error)
        })
}

/// Persist the extracted handoff document of a completed node.
pub fn update_workflow_node_handoff(
    database_path: &Path,
    conversation_id: &str,
    handoff_content: &str,
) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|connection| {
            connection.execute(
                "UPDATE workflow_node_sessions
                    SET handoff_content = ?2, updated_at = datetime('now', 'localtime')
                  WHERE conversation_id = ?1",
                params![conversation_id, handoff_content],
            )?;
            Ok(())
        })
        .map_err(|error| {
            database::database_error(database_path, "update workflow node handoff", error)
        })
}

/// List all workflow node sessions of a parent conversation, ordered by
/// creation time.
pub fn list_workflow_node_sessions(
    database_path: &Path,
    parent_conversation_id: &str,
) -> Result<Vec<WorkflowNodeSessionRecord>> {
    database::open_connection(database_path)
        .and_then(|connection| list_workflow_node_sessions_with(&connection, parent_conversation_id))
        .map_err(|error| {
            database::database_error(database_path, "list workflow node sessions", error)
        })
}

/// 批量查询多个父会话的 workflow 节点会话（单条 SQL，避免 N+1 查询）。
/// 返回按父会话 id 分组的完整会话记录：conversationType 标记为
/// `workflow_node`，node 的 id/name/run_status/error 映射到
/// subAgentId/subAgentName/subAgentStatus/subAgentError 字段供 UI 展示。
pub fn list_workflow_node_sessions_by_parents(
    database_path: &Path,
    parent_conversation_ids: &[String],
) -> Result<HashMap<String, Vec<ChatConversationRecord>>> {
    if parent_conversation_ids.is_empty() {
        return Ok(HashMap::new());
    }

    database::open_connection(database_path)
        .and_then(|connection| {
            let placeholders = in_clause_placeholders(parent_conversation_ids.len());
            let mut statement = connection.prepare(&format!(
                "SELECT conversation.conversation_id,
                        conversation.title,
                        conversation.summary,
                        conversation.last_message_preview,
                        conversation.message_count,
                        conversation.model,
                        conversation.status,
                        conversation.directory_id,
                        conversation.forked_from_conversation_id,
                        conversation.fork_message_count,
                        conversation.created_at,
                        conversation.updated_at,
                        conversation.input_tokens,
                        conversation.output_tokens,
                        conversation.cache_creation_input_tokens,
                        conversation.cache_read_input_tokens,
                        'workflow_node',
                        workflow.parent_conversation_id,
                        workflow.node_id,
                        workflow.node_name,
                        workflow.run_status,
                        workflow.error_message,
                        COALESCE(conversation.total_duration_ms, 0),
                        COALESCE(conversation.emoji, ''),
                        COALESCE(conversation.api_profile_name, ''),
                        COALESCE(conversation.run_input_tokens, 0),
                        COALESCE(conversation.run_output_tokens, 0),
                        COALESCE(conversation.run_cache_creation_input_tokens, 0),
                        COALESCE(conversation.run_cache_read_input_tokens, 0),
                        COALESCE(conversation.last_run_duration_ms, 0)
                   FROM workflow_node_sessions AS workflow
                   JOIN chat_conversations AS conversation
                     ON conversation.conversation_id = workflow.conversation_id
                  WHERE workflow.parent_conversation_id IN ({placeholders})
                  ORDER BY workflow.created_at ASC, workflow.id ASC"
            ))?;

            let rows =
                statement.query_map(params_from_iter(parent_conversation_ids.iter()), |row| {
                    let parent_id = row.get::<_, String>(17)?;
                    let record = map_chat_conversation_row(row)?;
                    Ok((parent_id, record))
                })?;

            let mut grouped: HashMap<String, Vec<ChatConversationRecord>> = HashMap::new();
            for row in rows {
                let (parent_id, record) = row?;
                grouped.entry(parent_id).or_default().push(record);
            }
            Ok(grouped)
        })
        .map_err(|error| {
            database::database_error(
                database_path,
                "list workflow node sessions by parents",
                error,
            )
        })
}

fn list_workflow_node_sessions_with(
    connection: &Connection,
    parent_conversation_id: &str,
) -> rusqlite::Result<Vec<WorkflowNodeSessionRecord>> {
    let mut statement = connection.prepare(
        "SELECT conversation_id, parent_conversation_id, flow_id, flow_checkpoint_id,
                node_id, node_name, run_status, error_message, handoff_content,
                created_at, updated_at
           FROM workflow_node_sessions
          WHERE parent_conversation_id = ?1
          ORDER BY created_at ASC, id ASC",
    )?;
    let records = statement
        .query_map(params![parent_conversation_id], |row| {
            Ok(WorkflowNodeSessionRecord {
                conversation_id: row.get(0)?,
                parent_conversation_id: row.get(1)?,
                flow_id: row.get(2)?,
                flow_checkpoint_id: row.get(3)?,
                node_id: row.get(4)?,
                node_name: row.get(5)?,
                run_status: row.get(6)?,
                error_message: row.get(7)?,
                handoff_content: row.get(8)?,
                created_at: row.get(9)?,
                updated_at: row.get(10)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(records)
}

/// Read a single workflow node session by conversation id.
pub fn get_workflow_node_session(
    database_path: &Path,
    conversation_id: &str,
) -> Result<Option<WorkflowNodeSessionRecord>> {
    database::open_connection(database_path)
        .and_then(|connection| {
            connection
                .query_row(
                    "SELECT conversation_id, parent_conversation_id, flow_id, flow_checkpoint_id,
                            node_id, node_name, run_status, error_message, handoff_content,
                            created_at, updated_at
                       FROM workflow_node_sessions
                      WHERE conversation_id = ?1
                      LIMIT 1",
                    params![conversation_id],
                    |row| {
                        Ok(WorkflowNodeSessionRecord {
                            conversation_id: row.get(0)?,
                            parent_conversation_id: row.get(1)?,
                            flow_id: row.get(2)?,
                            flow_checkpoint_id: row.get(3)?,
                            node_id: row.get(4)?,
                            node_name: row.get(5)?,
                            run_status: row.get(6)?,
                            error_message: row.get(7)?,
                            handoff_content: row.get(8)?,
                            created_at: row.get(9)?,
                            updated_at: row.get(10)?,
                        })
                    },
                )
                .optional()
        })
        .map_err(|error| {
            database::database_error(database_path, "get workflow node session", error)
        })
}

// ---------------------------------------------------------------------------
// Workflow run-level state (workflow_runs) & canvas persistence (workflow_canvases)
// ---------------------------------------------------------------------------

/// Upsert a workflow run row keyed by (parent_conversation_id, flow_id).
/// The runner calls this when a flow starts and as each node progresses so
/// the run survives app restarts and can be resumed from the last node.
pub fn upsert_workflow_run(
    database_path: &Path,
    parent_conversation_id: &str,
    flow_id: &str,
    run_status: &str,
    current_node_index: i64,
    last_handoff: &str,
    total_tokens: i64,
    flow_checkpoint_id: &str,
    directory_id: &str,
    error_message: &str,
) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|mut connection| {
            let transaction = connection.transaction()?;
            transaction.execute(
                "INSERT INTO workflow_runs (
                   id, parent_conversation_id, flow_id, run_status, current_node_index,
                   last_handoff, total_tokens, flow_checkpoint_id, directory_id, error_message,
                   created_at, updated_at
                 ) VALUES (
                   ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                   datetime('now', 'localtime'), datetime('now', 'localtime')
                 )
                 ON CONFLICT(parent_conversation_id, flow_id) DO UPDATE SET
                   run_status = excluded.run_status,
                   current_node_index = excluded.current_node_index,
                   last_handoff = excluded.last_handoff,
                   total_tokens = excluded.total_tokens,
                   flow_checkpoint_id = excluded.flow_checkpoint_id,
                   directory_id = excluded.directory_id,
                   error_message = excluded.error_message,
                   updated_at = datetime('now', 'localtime')",
                params![
                    database::create_snowflake_id(),
                    parent_conversation_id,
                    flow_id,
                    run_status,
                    current_node_index,
                    last_handoff,
                    total_tokens,
                    flow_checkpoint_id,
                    directory_id,
                    error_message,
                ],
            )?;
            transaction.commit()?;
            Ok(())
        })
        .map_err(|error| database::database_error(database_path, "upsert workflow run", error))
}

/// Read a workflow run by (parent_conversation_id, flow_id); `None` when no
/// run has been recorded yet.
pub fn get_workflow_run(
    database_path: &Path,
    parent_conversation_id: &str,
    flow_id: &str,
) -> Result<Option<WorkflowRunRecord>> {
    database::open_connection(database_path)
        .and_then(|connection| {
            connection
                .query_row(
                    "SELECT parent_conversation_id, flow_id, run_status, current_node_index,
                            last_handoff, total_tokens, flow_checkpoint_id, directory_id,
                            error_message, created_at, updated_at
                       FROM workflow_runs
                      WHERE parent_conversation_id = ?1 AND flow_id = ?2
                      LIMIT 1",
                    params![parent_conversation_id, flow_id],
                    |row| {
                        Ok(WorkflowRunRecord {
                            parent_conversation_id: row.get(0)?,
                            flow_id: row.get(1)?,
                            run_status: row.get(2)?,
                            current_node_index: row.get(3)?,
                            last_handoff: row.get(4)?,
                            total_tokens: row.get(5)?,
                            flow_checkpoint_id: row.get(6)?,
                            directory_id: row.get(7)?,
                            error_message: row.get(8)?,
                            created_at: row.get(9)?,
                            updated_at: row.get(10)?,
                        })
                    },
                )
                .optional()
        })
        .map_err(|error| database::database_error(database_path, "get workflow run", error))
}

/// Upsert a workflow canvas row keyed by (parent_conversation_id, interaction_id).
/// Replaces the old localStorage-based canvas persistence.
pub fn upsert_workflow_canvas(
    database_path: &Path,
    parent_conversation_id: &str,
    interaction_id: &str,
    canvas_json: &str,
) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|connection| {
            connection.execute(
                "INSERT INTO workflow_canvases (
                   parent_conversation_id, interaction_id, canvas_json, updated_at
                 ) VALUES (
                   ?1, ?2, ?3, datetime('now', 'localtime')
                 )
                 ON CONFLICT(parent_conversation_id, interaction_id) DO UPDATE SET
                   canvas_json = excluded.canvas_json,
                   updated_at = datetime('now', 'localtime')",
                params![parent_conversation_id, interaction_id, canvas_json],
            )?;
            Ok(())
        })
        .map_err(|error| database::database_error(database_path, "upsert workflow canvas", error))
}

/// Read a workflow canvas by (parent_conversation_id, interaction_id);
/// `None` when no canvas has been persisted yet.
pub fn get_workflow_canvas(
    database_path: &Path,
    parent_conversation_id: &str,
    interaction_id: &str,
) -> Result<Option<WorkflowCanvasRecord>> {
    database::open_connection(database_path)
        .and_then(|connection| {
            connection
                .query_row(
                    "SELECT parent_conversation_id, interaction_id, canvas_json, updated_at
                       FROM workflow_canvases
                      WHERE parent_conversation_id = ?1 AND interaction_id = ?2
                      LIMIT 1",
                    params![parent_conversation_id, interaction_id],
                    |row| {
                        Ok(WorkflowCanvasRecord {
                            parent_conversation_id: row.get(0)?,
                            interaction_id: row.get(1)?,
                            canvas_json: row.get(2)?,
                            updated_at: row.get(3)?,
                        })
                    },
                )
                .optional()
        })
        .map_err(|error| database::database_error(database_path, "get workflow canvas", error))
}
