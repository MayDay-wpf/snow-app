use std::path::Path;

use napi::bindgen_prelude::*;
use rusqlite::{params, OptionalExtension};

use super::super::super::database;
use super::super::super::{ChatConversationPage, ChatConversationRecord, ConversationSearchResult};
use super::{map_chat_conversation_row, ConversationRuntimeConfig};

pub fn list_chat_conversations(
    database_path: &Path,
    directory_id: &str,
) -> Result<Vec<ChatConversationRecord>> {
    database::open_connection(database_path)
        .and_then(|connection| {
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
                  ORDER BY updated_at DESC, id DESC",
            )?;

            let rows = statement.query_map(params![directory_id], map_chat_conversation_row)?;
            rows.collect()
        })
        .map_err(|error| database::database_error(database_path, "list chat conversations", error))
}

pub fn list_chat_conversations_paginated(
    database_path: &Path,
    directory_id: &str,
    limit: i32,
    offset: i32,
) -> Result<ChatConversationPage> {
    database::open_connection(database_path)
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
                  ORDER BY updated_at DESC, id DESC
                  LIMIT ?2 OFFSET ?3",
            )?;

            let rows = statement.query_map(
                params![directory_id, safe_limit, safe_offset],
                map_chat_conversation_row,
            )?;
            let items: Vec<ChatConversationRecord> = rows.collect::<rusqlite::Result<Vec<_>>>()?;

            Ok(ChatConversationPage { items, total })
        })
        .map_err(|error| {
            database::database_error(database_path, "list chat conversations paginated", error)
        })
}

/// 跨项目按会话 ID 查询会话记录（不按 directory_id 过滤）。
///
/// 供「跨项目通知」使用：渲染进程持有运行中/需关注的会话 ID 集合，
/// 通过此函数拿到这些会话的完整记录（含所属项目）才能在侧边栏展示
/// 其他项目的通知。子代理会话不单独作为通知条目返回（其动态归属于
/// 父会话），与分页列表的行为保持一致。
pub fn list_chat_conversations_by_ids(
    database_path: &Path,
    conversation_ids: &[String],
) -> Result<Vec<ChatConversationRecord>> {
    if conversation_ids.is_empty() {
        return Ok(Vec::new());
    }

    database::open_connection(database_path)
        .and_then(|connection| {
            let placeholders: Vec<String> = (1..=conversation_ids.len())
                .map(|index| format!("?{index}"))
                .collect();
            let placeholders = placeholders.join(", ");
            let sql = format!(
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
                  WHERE conversation_id IN ({placeholders})
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
                  ORDER BY updated_at DESC, id DESC"
            );

            let mut statement = connection.prepare(&sql)?;
            let rows = statement.query_map(
                rusqlite::params_from_iter(conversation_ids.iter()),
                map_chat_conversation_row,
            )?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        })
        .map_err(|error| {
            database::database_error(database_path, "list chat conversations by ids", error)
        })
}

pub fn search_chat_conversations(
    database_path: &Path,
    query: &str,
) -> Result<Vec<ConversationSearchResult>> {
    let pattern = format!("%{}%", query.replace('%', "\\%").replace('_', "\\_"));
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
                        COALESCE((
                            SELECT message.content
                              FROM chat_messages AS message
                             WHERE message.conversation_id = conversation.conversation_id
                               AND message.content LIKE ?1 ESCAPE '\\'
                             ORDER BY message.id DESC
                             LIMIT 1
                        ), '')
                   FROM chat_conversations AS conversation
                  WHERE conversation.status = 'active'
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
                    AND (
                         conversation.title LIKE ?1 ESCAPE '\\'
                      OR conversation.summary LIKE ?1 ESCAPE '\\'
                      OR conversation.last_message_preview LIKE ?1 ESCAPE '\\'
                      OR EXISTS (
                          SELECT 1
                            FROM chat_messages AS message
                           WHERE message.conversation_id = conversation.conversation_id
                             AND message.content LIKE ?1 ESCAPE '\\'
                      )
                    )
                  ORDER BY conversation.updated_at DESC, conversation.id DESC
                  LIMIT 50",
            )?;

            let rows = statement.query_map(params![pattern], |row| {
                let matched_content: String = row.get(16)?;
                let preview = if matched_content.is_empty() {
                    let last_preview: String = row.get(3)?;
                    last_preview
                } else {
                    create_search_snippet(&matched_content, query)
                };

                Ok(ConversationSearchResult {
                    conversation_id: row.get(0)?,
                    title: row.get(1)?,
                    summary: row.get(2)?,
                    last_message_preview: row.get(3)?,
                    message_count: row.get(4)?,
                    model: row.get(5)?,
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
                    matched_content: preview,
                })
            })?;
            rows.collect()
        })
        .map_err(|error| {
            database::database_error(database_path, "search chat conversations", error)
        })
}

pub fn list_pinned_conversations(
    database_path: &Path,
    directory_id: &str,
) -> Result<Vec<ChatConversationRecord>> {
    database::open_connection(database_path)
        .and_then(|connection| {
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
                    AND status = 'pin'
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
                  ORDER BY updated_at DESC, id DESC",
            )?;

            let rows = statement.query_map(params![directory_id], map_chat_conversation_row)?;
            rows.collect()
        })
        .map_err(|error| {
            database::database_error(database_path, "list pinned conversations", error)
        })
}

pub fn get_chat_conversation(
    database_path: &Path,
    conversation_id: &str,
) -> Result<Option<ChatConversationRecord>> {
    database::open_connection(database_path)
        .and_then(|connection| {
            connection
                .query_row(
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
                            CASE
                              WHEN workflow_node.conversation_id IS NOT NULL THEN 'workflow_node'
                              WHEN sub_agent.conversation_id IS NULL THEN 'main'
                              ELSE 'sub_agent'
                            END,
                            COALESCE(sub_agent.parent_conversation_id, workflow_node.parent_conversation_id, ''),
                            COALESCE(sub_agent.agent_id, workflow_node.node_id, ''),
                            COALESCE(sub_agent.agent_name, workflow_node.node_name, ''),
                            COALESCE(sub_agent.run_status, workflow_node.run_status, ''),
                            COALESCE(sub_agent.error_message, workflow_node.error_message, ''),
                            COALESCE(conversation.total_duration_ms, 0),
                            COALESCE(conversation.emoji, ''),
                            COALESCE(conversation.api_profile_name, ''),
                            COALESCE(conversation.run_input_tokens, 0),
                            COALESCE(conversation.run_output_tokens, 0),
                            COALESCE(conversation.run_cache_creation_input_tokens, 0),
                            COALESCE(conversation.run_cache_read_input_tokens, 0),
                            COALESCE(conversation.last_run_duration_ms, 0)
                       FROM chat_conversations AS conversation
                       LEFT JOIN sub_agent_sessions AS sub_agent
                         ON sub_agent.conversation_id = conversation.conversation_id
                       LEFT JOIN workflow_node_sessions AS workflow_node
                         ON workflow_node.conversation_id = conversation.conversation_id
                      WHERE conversation.conversation_id = ?1
                      LIMIT 1",
                    params![conversation_id],
                    map_chat_conversation_row,
                )
                .optional()
        })
        .map_err(|error| database::database_error(database_path, "get chat conversation", error))
}

/// 生成 `IN (?, ?, ...)` 子句占位符。
pub(crate) fn in_clause_placeholders(count: usize) -> String {
    std::iter::repeat("?")
        .take(count)
        .collect::<Vec<_>>()
        .join(", ")
}

fn create_search_snippet(content: &str, query: &str) -> String {
    let query_lower = query.to_lowercase();
    let content_lower = content.to_lowercase();
    let max_chars: usize = 120;

    let match_pos = content_lower.find(&query_lower).unwrap_or(0);

    let half = max_chars.saturating_sub(query.chars().count()) / 2;
    let start = match_pos.saturating_sub(half);

    let start_char = content
        .char_indices()
        .nth(start)
        .map(|(byte_pos, _)| byte_pos)
        .unwrap_or(0);

    let remaining: String = content[start_char..]
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");

    let mut chars = remaining.chars();
    let mut snippet = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        snippet.push('…');
    }
    if start > 0 {
        snippet.insert(0, '…');
    }
    snippet
}

/// Read a conversation's nullable runtime overrides without applying API
/// profile defaults. A missing conversation and a conversation with two NULL
/// columns both return an all-`None` snapshot.
pub fn get_conversation_runtime_config(
    database_path: &Path,
    conversation_id: &str,
) -> Result<ConversationRuntimeConfig> {
    database::open_connection(database_path)
        .and_then(|connection| {
            connection
                .query_row(
                    "SELECT thinking_strength, responses_fast_mode
                       FROM chat_conversations
                      WHERE conversation_id = ?1
                      LIMIT 1",
                    params![conversation_id],
                    |row| {
                        Ok(ConversationRuntimeConfig {
                            thinking_strength: row.get::<_, Option<String>>(0)?,
                            responses_fast_mode: row
                                .get::<_, Option<i64>>(1)?
                                .map(|value| value != 0),
                        })
                    },
                )
                .optional()
        })
        .map(|record| record.unwrap_or_default())
        .map_err(|error| {
            database::database_error(
                database_path,
                "get conversation runtime config",
                error,
            )
        })
}
