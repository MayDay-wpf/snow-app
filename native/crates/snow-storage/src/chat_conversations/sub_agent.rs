use std::collections::HashMap;
use std::path::Path;

use napi::bindgen_prelude::*;
use rusqlite::{params, params_from_iter};

use snow_storage_core::database;
use snow_storage_core::models::ChatConversationRecord;
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
                        COALESCE(conversation.api_profile_name, ''),
                        COALESCE(conversation.run_input_tokens, 0),
                        COALESCE(conversation.run_output_tokens, 0),
                        COALESCE(conversation.run_cache_creation_input_tokens, 0),
                        COALESCE(conversation.run_cache_read_input_tokens, 0),
                        COALESCE(conversation.last_run_duration_ms, 0),
                        COALESCE(conversation.run_ttft_sum_ms, 0),
                        COALESCE(conversation.run_request_count, 0)
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
                        COALESCE(conversation.api_profile_name, ''),
                        COALESCE(conversation.run_input_tokens, 0),
                        COALESCE(conversation.run_output_tokens, 0),
                        COALESCE(conversation.run_cache_creation_input_tokens, 0),
                        COALESCE(conversation.run_cache_read_input_tokens, 0),
                        COALESCE(conversation.last_run_duration_ms, 0),
                        COALESCE(conversation.run_ttft_sum_ms, 0),
                        COALESCE(conversation.run_request_count, 0)
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
