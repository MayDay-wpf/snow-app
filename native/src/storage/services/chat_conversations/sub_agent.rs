use std::collections::HashMap;
use std::path::Path;

use napi::bindgen_prelude::*;
use rusqlite::{params, params_from_iter, OptionalExtension, TransactionBehavior};

use super::super::super::database;
use super::super::super::ChatConversationRecord;
use super::{in_clause_placeholders, map_chat_conversation_row};

pub fn list_sub_agent_conversations(
    database_path: &Path,
    parent_conversation_id: &str,
) -> Result<Vec<ChatConversationRecord>> {
    database::open_connection(database_path)
        .and_then(|connection| {
            let mut statement = connection.prepare(
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
                        'sub_agent',
                        sub_agent.parent_conversation_id,
                        sub_agent.agent_id,
                        sub_agent.agent_name,
                        sub_agent.run_status,
                        sub_agent.error_message,
                        COALESCE(conversation.total_duration_ms, 0),
                        COALESCE(conversation.emoji, ''),
                        COALESCE(conversation.api_profile_name, ''),
                        COALESCE(conversation.run_input_tokens, 0),
                        COALESCE(conversation.run_output_tokens, 0),
                        COALESCE(conversation.run_cache_creation_input_tokens, 0),
                        COALESCE(conversation.run_cache_read_input_tokens, 0),
                        COALESCE(conversation.last_run_duration_ms, 0)
                   FROM sub_agent_sessions AS sub_agent
                   JOIN chat_conversations AS conversation
                     ON conversation.conversation_id = sub_agent.conversation_id
                   WHERE sub_agent.parent_conversation_id = ?1
                  ORDER BY sub_agent.created_at ASC, sub_agent.id ASC",
            )?;

            let rows =
                statement.query_map(params![parent_conversation_id], map_chat_conversation_row)?;
            rows.collect()
        })
        .map_err(|error| {
            database::database_error(database_path, "list sub-agent conversations", error)
        })
}

/// 批量查询多个父会话的子代理会话（单条 SQL，避免 N+1 查询）。
pub fn list_sub_agent_conversations_by_parents(
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
                        'sub_agent',
                        sub_agent.parent_conversation_id,
                        sub_agent.agent_id,
                        sub_agent.agent_name,
                        sub_agent.run_status,
                        sub_agent.error_message,
                        COALESCE(conversation.total_duration_ms, 0),
                        COALESCE(conversation.emoji, ''),
                        COALESCE(conversation.api_profile_name, ''),
                        COALESCE(conversation.run_input_tokens, 0),
                        COALESCE(conversation.run_output_tokens, 0),
                        COALESCE(conversation.run_cache_creation_input_tokens, 0),
                        COALESCE(conversation.run_cache_read_input_tokens, 0),
                        COALESCE(conversation.last_run_duration_ms, 0)
                   FROM sub_agent_sessions AS sub_agent
                   JOIN chat_conversations AS conversation
                     ON conversation.conversation_id = sub_agent.conversation_id
                   WHERE sub_agent.parent_conversation_id IN ({placeholders})
                  ORDER BY sub_agent.created_at ASC, sub_agent.id ASC"
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
                "list sub-agent conversations by parents",
                error,
            )
        })
}

pub fn create_sub_agent_session(
    database_path: &Path,
    conversation_id: &str,
    parent_conversation_id: &str,
    agent_id: &str,
    agent_name: &str,
    directory_id: &str,
    api_profile_name: &str,
    model: &str,
    title: &str,
    captured_thinking_strength: Option<String>,
    captured_responses_fast_mode: Option<bool>,
) -> Result<()> {
    database::with_write_lock(|| {
        database::with_write_retry(
            || {
                database::open_connection(database_path).and_then(|mut connection| {
                    let transaction = connection
                        .transaction_with_behavior(TransactionBehavior::Immediate)?;
                    let parent_runtime: (Option<String>, Option<bool>) = transaction
                        .query_row(
                            "SELECT thinking_strength, responses_fast_mode
                               FROM chat_conversations
                              WHERE conversation_id = ?1
                              LIMIT 1",
                            params![parent_conversation_id],
                            |row| {
                                Ok((
                                    row.get::<_, Option<String>>(0)?,
                                    row.get::<_, Option<i64>>(1)?.map(|value| value != 0),
                                ))
                            },
                        )
                        .optional()?
                        .unwrap_or((None, None));
                    let captured_thinking_strength =
                        captured_thinking_strength.as_ref().and_then(|value| {
                            let normalized = value.trim().to_string();
                            (!normalized.is_empty()).then_some(normalized)
                        });
                    // Captured effective values are authoritative for this sub-agent
                    // run. Missing values retain the legacy parent-row fallback.
                    let effective_thinking_strength =
                        captured_thinking_strength.or(parent_runtime.0);
                    let effective_responses_fast_mode =
                        captured_responses_fast_mode.or(parent_runtime.1);
                    transaction.execute(
                        "INSERT INTO chat_conversations (
                           id,
                           conversation_id,
                           title,
                           summary,
                           last_message_preview,
                           message_count,
                           model,
                           api_profile_name,
                           thinking_strength,
                           responses_fast_mode,
                           last_response_id,
                           status,
                           directory_id,
                           forked_from_conversation_id,
                           fork_message_count,
                           created_at,
                           updated_at
                         ) VALUES (
                           ?1, ?2, ?3, ?3, '', 0, ?4, ?5, ?6, ?7, '', 'active', ?8, '', 0, datetime('now', 'localtime'), datetime('now', 'localtime')
                         )",
                        params![
                            database::create_snowflake_id(),
                            conversation_id,
                            title.trim(),
                            model.trim(),
                            api_profile_name.trim(),
                            effective_thinking_strength,
                            effective_responses_fast_mode,
                            directory_id.trim(),
                        ],
                    )?;
                    transaction.execute(
                        "INSERT INTO sub_agent_sessions (
                           id,
                           conversation_id,
                           parent_conversation_id,
                           agent_id,
                           agent_name,
                           run_status,
                           error_message,
                           created_at,
                           updated_at
                         ) VALUES (
                           ?1, ?2, ?3, ?4, ?5, 'running', '', datetime('now', 'localtime'), datetime('now', 'localtime')
                         )",
                        params![
                            database::create_snowflake_id(),
                            conversation_id,
                            parent_conversation_id.trim(),
                            agent_id.trim(),
                            agent_name.trim(),
                        ],
                    )?;
                    transaction.commit()
                })
            },
            "create sub-agent session",
        )
    })
    .map_err(|error| database::database_error(database_path, "create sub-agent session", error))
}

pub fn update_sub_agent_session_status(
    database_path: &Path,
    conversation_id: &str,
    run_status: &str,
    error_message: &str,
) -> Result<()> {
    let normalized_status = match run_status.trim() {
        "completed" => "completed",
        "failed" => "failed",
        "cancelled" => "cancelled",
        _ => "running",
    };

    database::open_connection(database_path)
        .and_then(|connection| {
            connection.execute(
                "UPDATE sub_agent_sessions
                    SET run_status = ?2,
                        error_message = ?3,
                        updated_at = datetime('now', 'localtime')
                  WHERE conversation_id = ?1",
                params![conversation_id, normalized_status, error_message.trim()],
            )
        })
        .map_err(|error| {
            database::database_error(database_path, "update sub-agent session status", error)
        })
        .map(|_| ())
}

pub fn cancel_running_sub_agent_sessions(database_path: &Path) -> Result<usize> {
    database::open_connection(database_path)
        .and_then(|connection| {
            connection.execute(
                "UPDATE sub_agent_sessions
                    SET run_status = 'cancelled',
                        error_message = '',
                        updated_at = datetime('now', 'localtime')
                  WHERE run_status = 'running'",
                [],
            )
        })
        .map_err(|error| {
            database::database_error(
                database_path,
                "cancel interrupted sub-agent sessions",
                error,
            )
        })
}
