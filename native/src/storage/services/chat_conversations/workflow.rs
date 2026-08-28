use std::path::Path;

use napi::bindgen_prelude::*;
use rusqlite::{params, Connection, OptionalExtension};

use super::super::super::database;
use super::super::super::models::WorkflowNodeSessionRecord;

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
