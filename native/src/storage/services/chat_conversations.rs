use std::collections::{HashMap, HashSet};
use std::path::Path;

use chrono::Utc;
use napi::bindgen_prelude::*;
use rusqlite::{
    params, params_from_iter, Connection, OptionalExtension, Row, ToSql, TransactionBehavior,
};

use super::super::database;
use super::super::{
    ChatConversationPage, ChatConversationRecord, ChatMessagePage, ChatMessageRecord,
    ConversationSearchResult, UserMessageSummary,
};
use crate::api::conversation::images::{
    expand_element_tags_in_content, expand_review_tags_in_content,
};

#[derive(Clone, Debug)]
pub struct ChatContextMessage {
    pub role: String,
    pub content: String,
    /// For assistant messages that contain tool calls, this holds the
    /// serialized JSON array of tool call objects (OpenAI Chat format:
    /// `[{"id":"...","type":"function","function":{"name":"...","arguments":"..."}}]`).
    /// Providers convert this to their own API format when building payloads.
    pub tool_calls_json: Option<String>,
    /// For tool result messages (role="tool"), structured JSON array:
    /// `[{"name":"...","callId":"...","result":"..."}]`
    /// When present, providers use this directly instead of parsing content text.
    pub tool_results_json: Option<String>,
    /// For assistant messages, the reasoning/thinking text produced by the
    /// model. Chat Completions providers emit this as `reasoning_content`;
    /// Gemini emits it as a `thought` text part. The plain text is NOT
    /// round-tripped to Anthropic (which needs signed blocks); use
    /// `thinking_blocks_json` for Anthropic round-tripping instead.
    pub thinking: Option<String>,
    /// JSON array of complete Anthropic thinking blocks (each with
    /// type/thinking/signature). Only populated for assistant messages from
    /// the Anthropic provider. Passed back verbatim to the Anthropic API so
    /// thinking continuity is preserved across turns.
    pub thinking_blocks_json: Option<String>,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct ChatTokenUsage {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_creation_input_tokens: i64,
    pub cache_read_input_tokens: i64,
}

pub struct StoreChatExchangeInput<'a> {
    pub conversation_id: &'a str,
    pub request_messages: &'a [ChatContextMessage],
    pub response_content: &'a str,
    pub response_id: &'a str,
    pub checkpoint_id: &'a str,
    pub model: &'a str,
    /// API config profile that served this exchange. Persisted on the
    /// conversation row at creation time so the conversation stays bound to
    /// its provider for subsequent turns. Empty string means "follow the
    /// global active profile" (legacy behaviour).
    pub api_profile_name: &'a str,
    pub status: &'a str,
    pub raw_response_json: &'a str,
    pub token_usage: ChatTokenUsage,
    pub response_thinking: &'a str,
    pub response_thinking_blocks_json: &'a str,
    pub tool_calls_json: &'a str,
    pub directory_id: &'a str,
    pub context_compaction: bool,
    /// Internal auto-compaction resume mode: `request_messages` is a
    /// placeholder that must NOT be persisted as normal user messages — the
    /// handoff is already stored as the latest `context_compaction` boundary.
    /// The assistant response is still persisted as usual.
    pub resume_after_compaction: bool,
    pub total_duration_ms: i64,
}

pub fn resolve_conversation_id(
    database_path: &Path,
    conversation_id: Option<&str>,
    previous_response_id: Option<&str>,
) -> Result<String> {
    if let Some(conversation_id) = conversation_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Ok(conversation_id.to_string());
    }

    if let Some(previous_response_id) = previous_response_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if let Some(conversation_id) =
            find_conversation_id_by_response_id(database_path, previous_response_id)?
        {
            return Ok(conversation_id);
        }

        if conversation_exists(database_path, previous_response_id)? {
            return Ok(previous_response_id.to_string());
        }
    }

    Ok(create_chat_id("conv"))
}

pub fn load_context_messages(
    database_path: &Path,
    conversation_id: &str,
) -> Result<Vec<ChatContextMessage>> {
    database::open_connection(database_path)
        .and_then(|connection| {
            let mut statement = connection.prepare(
                "SELECT role, content, tool_calls_json, raw_json, thinking, thinking_blocks_json
                   FROM chat_messages
                  WHERE conversation_id = ?1
                    AND id >= COALESCE(
                      (SELECT id
                         FROM chat_messages
                        WHERE conversation_id = ?1
                          AND status = 'context_compaction'
                        ORDER BY id DESC
                        LIMIT 1),
                      ''
                    )
                    AND (
                      content <> ''
                      OR (role = 'assistant' AND tool_calls_json <> '' AND tool_calls_json <> '[]')
                      OR (role = 'assistant' AND thinking <> '')
                    )
                    AND NOT (role = 'assistant' AND status = 'error')
                  ORDER BY id ASC",
            )?;

            let rows = statement.query_map(params![conversation_id], |row| {
                let role: String = row.get(0)?;
                let content: String = row.get(1)?;
                let tool_calls_raw: String = row.get(2)?;
                let raw_json: String = row.get(3)?;
                let thinking_raw: String = row.get(4)?;
                let thinking_blocks_raw: String = row.get(5)?;
                let tool_calls_json = if tool_calls_raw.is_empty() || tool_calls_raw == "[]" {
                    None
                } else {
                    Some(tool_calls_raw)
                };
                // For tool messages, reconstruct tool_results_json from the
                // raw_json column (where store_chat_exchange persists the
                // structured [{name, callId, result}] array). Other message
                // types leave this as None.
                let tool_results_json =
                    if role.trim() == "tool" && !raw_json.is_empty() && raw_json != "{}" {
                        Some(raw_json)
                    } else {
                        None
                    };
                // For assistant messages, restore the thinking text so
                // providers can round-trip it as reasoning_content (Chat) or
                // thought parts (Gemini).
                let thinking = if thinking_raw.is_empty() {
                    None
                } else {
                    Some(thinking_raw)
                };
                // For assistant messages, restore the complete Anthropic
                // thinking blocks (with signatures) so the Anthropic provider
                // can round-trip them verbatim on the next request.
                let thinking_blocks_json = if role.trim() == "assistant"
                    && !thinking_blocks_raw.is_empty()
                    && thinking_blocks_raw != "[]"
                {
                    Some(thinking_blocks_raw)
                } else {
                    None
                };
                Ok(ChatContextMessage {
                    role,
                    content,
                    tool_calls_json,
                    tool_results_json,
                    thinking,
                    thinking_blocks_json,
                })
            })?;

            rows.collect()
        })
        .map_err(|error| database::database_error(database_path, "load chat context", error))
}

pub fn store_chat_exchange(
    database_path: &Path,
    input: &StoreChatExchangeInput<'_>,
) -> Result<Vec<String>> {
    database::open_connection(database_path)
        .and_then(|mut connection| {
            let transaction = connection.transaction()?;
            let mut persisted_user_message_ids = Vec::new();
            let title = create_title(input.request_messages);
            let preview = create_snippet(input.response_content, 180);
            // Context compaction also persists the real token usage so the
            // sidebar / token ring reflects the actual context state after the
            // handoff. Previously this used ChatTokenUsage::default() which
            // wiped the recorded usage to zero and left the UI blind to the
            // post-compaction context size.
            let context_usage = if input.status == "error" {
                None
            } else {
                Some(input.token_usage)
            };

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
                   last_response_id,
                   status,
                   directory_id,
                   forked_from_conversation_id,
                   fork_message_count,
                   created_at,
                   updated_at
                 ) VALUES (
                   ?1, ?2, ?3, ?3, '', 0, ?4, ?5, ?6, 'active', ?7, '', 0, datetime('now', 'localtime'), datetime('now', 'localtime')
                 )
                 ON CONFLICT(conversation_id) DO NOTHING",
                params![
                    database::create_snowflake_id(),
                    input.conversation_id,
                    title,
                    input.model,
                    input.api_profile_name,
                    input.response_id,
                    input.directory_id,
                ],
            )?;

            if input.context_compaction {
                // Persist the checkpoint id on the compaction boundary row so
                // the rollback flow can restore files modified by the
                // post-compaction agent loop. Treat the boundary as a user
                // message: its checkpoint captures the pre-compaction working
                // directory state.
                let message_id = insert_message(
                    &transaction,
                    input.conversation_id,
                    "user",
                    input.response_content,
                    input.response_id,
                    input.checkpoint_id,
                    input.model,
                    "context_compaction",
                    input.raw_response_json,
                    "",
                    "[]",
                    "[]",
                    0,
                )?;
                persisted_user_message_ids.push(message_id);
            } else {
                // Resume-after-compaction requests carry a placeholder
                // `request_messages` whose content is already persisted as the
                // `context_compaction` boundary — skip re-inserting it as a
                // normal user message. The assistant response is still
                // persisted below.
                if !input.resume_after_compaction {
                    for (index, message) in input.request_messages.iter().enumerate() {
                        let checkpoint_id =
                            if index == 0 && normalize_role(&message.role) == "user" {
                                input.checkpoint_id
                            } else {
                                ""
                            };
                        // For tool messages, persist tool_results_json into the
                        // raw_json column so load_context_messages can reconstruct
                        // the structured (name, callId, result) tuples needed to
                        // emit proper tool_call_id on the next request. Other
                        // message types keep raw_json as "{}".
                        let raw_json = if normalize_role(&message.role) == "tool" {
                            message.tool_results_json.as_deref().unwrap_or("{}")
                        } else {
                            "{}"
                        };
                        let message_id = insert_message(
                            &transaction,
                            input.conversation_id,
                            &message.role,
                            &message.content,
                            "",
                            checkpoint_id,
                            input.model,
                            "sent",
                            raw_json,
                            "",
                            "[]",
                            "[]",
                            index,
                        )?;
                        if normalize_role(&message.role) == "user" {
                            persisted_user_message_ids.push(message_id);
                        }
                    }
                }

                insert_message(
                    &transaction,
                    input.conversation_id,
                    "assistant",
                    input.response_content,
                    input.response_id,
                    "",
                    input.model,
                    input.status,
                    input.raw_response_json,
                    input.response_thinking,
                    input.response_thinking_blocks_json,
                    input.tool_calls_json,
                    input.request_messages.len(),
                )?;
            }

            // The conversation row stores the latest context-window snapshot.
            // Per-request usage accounting belongs in a dedicated history table.
            transaction.execute(
                "UPDATE chat_conversations
                    SET title = CASE WHEN title = '' THEN ?2 ELSE title END,
                        summary = CASE WHEN summary = '' THEN ?2 ELSE summary END,
                        last_message_preview = ?3,
                        message_count = (
                          SELECT COUNT(*)
                            FROM chat_messages
                           WHERE conversation_id = ?1
                        ),
                        model = ?4,
                        last_response_id = CASE
                          WHEN ?5 <> '' THEN ?5
                          ELSE last_response_id
                        END,
                        status = 'active',
                        directory_id = CASE WHEN directory_id = '' THEN ?10 ELSE directory_id END,
                        input_tokens = COALESCE(?6, input_tokens),
                        output_tokens = COALESCE(?7, output_tokens),
                        cache_creation_input_tokens = COALESCE(?8, cache_creation_input_tokens),
                        cache_read_input_tokens = COALESCE(?9, cache_read_input_tokens),
                        total_duration_ms = total_duration_ms + ?11,
                        updated_at = datetime('now', 'localtime')
                  WHERE conversation_id = ?1",
                params![
                    input.conversation_id,
                    title,
                    preview,
                    input.model,
                    input.response_id,
                    context_usage.as_ref().map(|usage| usage.input_tokens),
                    context_usage.as_ref().map(|usage| usage.output_tokens),
                    context_usage
                        .as_ref()
                        .map(|usage| usage.cache_creation_input_tokens),
                    context_usage
                        .as_ref()
                        .map(|usage| usage.cache_read_input_tokens),
                    input.directory_id,
                    input.total_duration_ms,
                ],
            )?;

            transaction.commit()?;
            Ok(persisted_user_message_ids)
        })
        .map_err(|error| database::database_error(database_path, "store chat exchange", error))
}

pub fn store_failed_chat_exchange(
    database_path: &Path,
    conversation_id: Option<&str>,
    previous_response_id: Option<&str>,
    request_messages: &[ChatContextMessage],
    checkpoint_id: &str,
    model: &str,
    api_profile_name: &str,
    directory_id: &str,
    resume_after_compaction: bool,
    error_message: &str,
) -> Result<String> {
    let request_messages = request_messages
        .iter()
        .filter_map(|message| {
            let content = message.content.trim();
            (!content.is_empty()).then(|| ChatContextMessage {
                role: message.role.trim().to_string(),
                content: content.to_string(),
                tool_calls_json: message.tool_calls_json.clone(),
                tool_results_json: message.tool_results_json.clone(),
                thinking: message.thinking.clone(),
                thinking_blocks_json: message.thinking_blocks_json.clone(),
            })
        })
        .collect::<Vec<_>>();
    // Resume-after-compaction requests carry a placeholder message that is
    // already persisted as the `context_compaction` boundary — it must not be
    // re-inserted as a normal user message, so allow it through empty.
    if request_messages.is_empty() && !resume_after_compaction {
        return Err(Error::from_reason("Chat message content is required"));
    }

    let conversation_id =
        resolve_conversation_id(database_path, conversation_id, previous_response_id)?;
    let error_message = error_message.trim();
    let response_content = if error_message.is_empty() {
        "AI response failed, please try again later."
    } else {
        error_message
    };

    store_chat_exchange(
        database_path,
        &StoreChatExchangeInput {
            conversation_id: &conversation_id,
            request_messages: &request_messages,
            response_content,
            response_id: "",
            checkpoint_id,
            model,
            api_profile_name,
            status: "error",
            raw_response_json: "{}",
            token_usage: ChatTokenUsage::default(),
            response_thinking: "",
            response_thinking_blocks_json: "[]",
            tool_calls_json: "[]",
            directory_id,
            context_compaction: false,
            resume_after_compaction,
            total_duration_ms: 0,
        },
    )?;

    Ok(conversation_id)
}

pub fn append_tool_message(
    database_path: &Path,
    conversation_id: &str,
    content: &str,
) -> Result<()> {
    let trimmed_content = content.trim();
    if trimmed_content.is_empty() {
        return Ok(());
    }

    database::open_connection(database_path)
        .and_then(|mut connection| {
            let transaction = connection.transaction()?;
            insert_message(
                &transaction,
                conversation_id,
                "tool",
                trimmed_content,
                "",
                "",
                "",
                "sent",
                "{}",
                "",
                "[]",
                "[]",
                0,
            )?;
            transaction.execute(
                "UPDATE chat_conversations
                    SET message_count = (
                          SELECT COUNT(*)
                            FROM chat_messages
                           WHERE conversation_id = ?1
                        ),
                        updated_at = datetime('now', 'localtime')
                  WHERE conversation_id = ?1",
                params![conversation_id],
            )?;
            transaction.commit()
        })
        .map_err(|error| database::database_error(database_path, "append tool message", error))
}

pub fn update_conversation_summary(
    database_path: &Path,
    conversation_id: &str,
    summary: &str,
) -> Result<()> {
    let trimmed_summary = summary.trim();
    if trimmed_summary.is_empty() {
        return Ok(());
    }

    database::open_connection(database_path)
        .and_then(|connection| {
            connection.execute(
                "UPDATE chat_conversations
                    SET summary = ?2,
                        updated_at = datetime('now', 'localtime')
                  WHERE conversation_id = ?1",
                params![conversation_id, trimmed_summary],
            )
        })
        .map_err(|error| {
            database::database_error(database_path, "update conversation summary", error)
        })
        .map(|_| ())
}

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
                       api_profile_name
                  FROM chat_conversations AS conversation
                 WHERE directory_id = ?1
                   AND status = 'active'
                   AND NOT EXISTS (
                     SELECT 1
                       FROM sub_agent_sessions AS sub_agent
                      WHERE sub_agent.conversation_id = conversation.conversation_id
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
                       api_profile_name
                  FROM chat_conversations AS conversation
                 WHERE directory_id = ?1
                   AND status = 'active'
                   AND NOT EXISTS (
                     SELECT 1
                       FROM sub_agent_sessions AS sub_agent
                      WHERE sub_agent.conversation_id = conversation.conversation_id
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
                       api_profile_name
                  FROM chat_conversations AS conversation
                 WHERE conversation_id IN ({placeholders})
                   AND status = 'active'
                   AND NOT EXISTS (
                     SELECT 1
                       FROM sub_agent_sessions AS sub_agent
                      WHERE sub_agent.conversation_id = conversation.conversation_id
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
                       api_profile_name
                  FROM chat_conversations AS conversation
                 WHERE directory_id = ?1
                   AND status = 'pin'
                   AND NOT EXISTS (
                      SELECT 1
                        FROM sub_agent_sessions AS sub_agent
                       WHERE sub_agent.conversation_id = conversation.conversation_id
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
                            CASE WHEN sub_agent.conversation_id IS NULL THEN 'main' ELSE 'sub_agent' END,
                            COALESCE(sub_agent.parent_conversation_id, ''),
                            COALESCE(sub_agent.agent_id, ''),
                            COALESCE(sub_agent.agent_name, ''),
                            COALESCE(sub_agent.run_status, ''),
                            COALESCE(sub_agent.error_message, ''),
                            COALESCE(conversation.total_duration_ms, 0),
                            COALESCE(conversation.emoji, ''),
                            COALESCE(conversation.api_profile_name, '')
                       FROM chat_conversations AS conversation
                       LEFT JOIN sub_agent_sessions AS sub_agent
                         ON sub_agent.conversation_id = conversation.conversation_id
                      WHERE conversation.conversation_id = ?1
                      LIMIT 1",
                    params![conversation_id],
                    map_chat_conversation_row,
                )
                .optional()
        })
        .map_err(|error| database::database_error(database_path, "get chat conversation", error))
}

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
                        COALESCE(conversation.api_profile_name, '')
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
                        COALESCE(conversation.api_profile_name, '')
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
) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|mut connection| {
            let transaction = connection.transaction()?;
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
                   last_response_id,
                   status,
                   directory_id,
                   forked_from_conversation_id,
                   fork_message_count,
                   created_at,
                   updated_at
                 ) VALUES (
                   ?1, ?2, ?3, ?3, '', 0, ?4, ?5, '', 'active', ?6, '', 0, datetime('now', 'localtime'), datetime('now', 'localtime')
                 )",
                params![
                    database::create_snowflake_id(),
                    conversation_id,
                    title.trim(),
                    model.trim(),
                    api_profile_name.trim(),
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

pub fn update_conversation_status(
    database_path: &Path,
    conversation_id: &str,
    status: &str,
) -> Result<()> {
    let normalized_status = match status.trim() {
        "pin" => "pin",
        "active" => "active",
        _ => "active",
    };

    database::open_connection(database_path)
        .and_then(|connection| {
            connection.execute(
                "UPDATE chat_conversations
                    SET status = ?2,
                        updated_at = datetime('now', 'localtime')
                  WHERE conversation_id = ?1",
                params![conversation_id, normalized_status],
            )
        })
        .map_err(|error| {
            database::database_error(database_path, "update conversation status", error)
        })
        .map(|_| ())
}

pub fn rename_conversation(database_path: &Path, conversation_id: &str, title: &str) -> Result<()> {
    let trimmed_title = title.trim();
    if trimmed_title.is_empty() {
        return Ok(());
    }

    database::open_connection(database_path)
        .and_then(|connection| {
            connection.execute(
                "UPDATE chat_conversations
                    SET title = ?2,
                        summary = ?2,
                        updated_at = datetime('now', 'localtime')
                  WHERE conversation_id = ?1",
                params![conversation_id, trimmed_title],
            )
        })
        .map_err(|error| database::database_error(database_path, "rename conversation", error))
        .map(|_| ())
}

pub fn update_conversation_emoji(
    database_path: &Path,
    conversation_id: &str,
    emoji: &str,
) -> Result<()> {
    let trimmed_emoji = emoji.trim();
    database::open_connection(database_path)
        .and_then(|connection| {
            connection.execute(
                "UPDATE chat_conversations
                    SET emoji = ?2,
                        updated_at = datetime('now', 'localtime')
                  WHERE conversation_id = ?1",
                params![conversation_id, trimmed_emoji],
            )
        })
        .map_err(|error| {
            database::database_error(database_path, "update conversation emoji", error)
        })
        .map(|_| ())
}

pub fn delete_conversation(database_path: &Path, conversation_id: &str) -> Result<()> {
    let mut connection = database::open_connection(database_path)
        .map_err(|error| database::database_error(database_path, "delete conversation", error))?;

    // Acquire the writer reservation before reading child sessions. A deferred
    // transaction would first establish a read snapshot and then try to upgrade
    // on the initial DELETE. If a cancelled response finishes persisting between
    // those steps, WAL reports SQLITE_BUSY_SNAPSHOT as "database is locked"
    // even though that writer has already committed. BEGIN IMMEDIATE waits at
    // transaction start and guarantees that all following reads and deletes use
    // one writable snapshot.
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| database::database_error(database_path, "delete conversation", error))?;
    let mut conversation_ids = vec![conversation_id.to_string()];
    let child_ids = {
        let mut statement = transaction
            .prepare(
                "SELECT conversation_id
                   FROM sub_agent_sessions
                  WHERE parent_conversation_id = ?1",
            )
            .map_err(|error| {
                database::database_error(database_path, "list sub-agent sessions", error)
            })?;
        let rows = statement
            .query_map(params![conversation_id], |row| row.get::<_, String>(0))
            .map_err(|error| {
                database::database_error(database_path, "list sub-agent sessions", error)
            })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| {
                database::database_error(database_path, "list sub-agent sessions", error)
            })?
    };
    conversation_ids.extend(child_ids);

    for target_id in &conversation_ids {
        transaction
            .execute(
                "DELETE FROM chat_messages WHERE conversation_id = ?1",
                params![target_id],
            )
            .map_err(|error| {
                database::database_error(database_path, "delete chat messages", error)
            })?;
        transaction
            .execute(
                "DELETE FROM todo_items WHERE session_id = ?1",
                params![target_id],
            )
            .map_err(|error| database::database_error(database_path, "delete todo items", error))?;
    }

    transaction
        .execute(
            "DELETE FROM sub_agent_sessions
              WHERE parent_conversation_id = ?1 OR conversation_id = ?1",
            params![conversation_id],
        )
        .map_err(|error| {
            database::database_error(database_path, "delete sub-agent sessions", error)
        })?;

    for target_id in conversation_ids.iter().rev() {
        transaction
            .execute(
                "DELETE FROM chat_conversations WHERE conversation_id = ?1",
                params![target_id],
            )
            .map_err(|error| {
                database::database_error(database_path, "delete conversation", error)
            })?;
    }

    transaction
        .commit()
        .map_err(|error| database::database_error(database_path, "delete conversation", error))?;

    Ok(())
}

/// 生成 `IN (?, ?, ...)` 子句占位符。
fn in_clause_placeholders(count: usize) -> String {
    std::iter::repeat("?")
        .take(count)
        .collect::<Vec<_>>()
        .join(", ")
}

/// 批量删除会话，语义与单条 [delete_conversation] 完全一致：
/// 选中父会话时其直接子代理会话随级联删除，消息与 todo 一并清理。
/// 与逐条删除相比，只打开一次数据库、使用单个事务，避免 N+1 查询。
pub fn delete_conversations(database_path: &Path, conversation_ids: &[String]) -> Result<()> {
    if conversation_ids.is_empty() {
        return Ok(());
    }

    // 去重并保持传入顺序
    let mut seen = HashSet::new();
    let unique_ids: Vec<String> = conversation_ids
        .iter()
        .filter(|id| seen.insert(id.as_str()))
        .cloned()
        .collect();

    if unique_ids.is_empty() {
        return Ok(());
    }

    let mut connection = database::open_connection(database_path)
        .map_err(|error| database::database_error(database_path, "delete conversations", error))?;

    // 与单条删除一致：先取写锁快照，避免 WAL 下读后写升级导致 BUSY_SNAPSHOT
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| database::database_error(database_path, "delete conversations", error))?;

    // 一次查出所有直接子代理会话 id（覆盖全部选中父会话）
    let mut all_target_ids = unique_ids.clone();
    {
        let placeholders = in_clause_placeholders(unique_ids.len());
        let mut statement = transaction
            .prepare(&format!(
                "SELECT conversation_id
                   FROM sub_agent_sessions
                  WHERE parent_conversation_id IN ({placeholders})"
            ))
            .map_err(|error| {
                database::database_error(database_path, "list sub-agent sessions", error)
            })?;
        let rows = statement
            .query_map(params_from_iter(unique_ids.iter()), |row| {
                row.get::<_, String>(0)
            })
            .map_err(|error| {
                database::database_error(database_path, "list sub-agent sessions", error)
            })?;
        for child_id in rows {
            let child_id = child_id.map_err(|error| {
                database::database_error(database_path, "list sub-agent sessions", error)
            })?;
            if !all_target_ids.contains(&child_id) {
                all_target_ids.push(child_id);
            }
        }
    }

    // SQLite 默认变量数上限为 999，分块执行避免超出
    const MAX_VARIABLES: usize = 400;
    for chunk in all_target_ids.chunks(MAX_VARIABLES) {
        let placeholders = in_clause_placeholders(chunk.len());
        transaction
            .execute(
                &format!("DELETE FROM chat_messages WHERE conversation_id IN ({placeholders})"),
                params_from_iter(chunk.iter()),
            )
            .map_err(|error| {
                database::database_error(database_path, "delete chat messages", error)
            })?;
        transaction
            .execute(
                &format!("DELETE FROM todo_items WHERE session_id IN ({placeholders})"),
                params_from_iter(chunk.iter()),
            )
            .map_err(|error| database::database_error(database_path, "delete todo items", error))?;
    }

    // 删除子代理会话关联行：父会话被删时其子代理行一并删除
    for chunk in unique_ids.chunks(MAX_VARIABLES) {
        let placeholders = in_clause_placeholders(chunk.len());
        let mut params: Vec<&dyn ToSql> = Vec::with_capacity(chunk.len() * 2);
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
                database::database_error(database_path, "delete sub-agent sessions", error)
            })?;
    }

    for chunk in all_target_ids.chunks(MAX_VARIABLES) {
        let placeholders = in_clause_placeholders(chunk.len());
        transaction
            .execute(
                &format!(
                    "DELETE FROM chat_conversations WHERE conversation_id IN ({placeholders})"
                ),
                params_from_iter(chunk.iter()),
            )
            .map_err(|error| {
                database::database_error(database_path, "delete conversation", error)
            })?;
    }

    transaction
        .commit()
        .map_err(|error| database::database_error(database_path, "delete conversations", error))?;

    Ok(())
}

pub fn list_chat_messages(
    database_path: &Path,
    conversation_id: &str,
) -> Result<Vec<ChatMessageRecord>> {
    database::open_connection(database_path)
        .and_then(|connection| {
            let mut statement = connection.prepare(
                "SELECT id,
                        role,
                        content,
                        thinking,
                        status,
                        model,
                        response_id,
                        checkpoint_id,
                        tool_calls_json,
                        created_at
                   FROM chat_messages
                  WHERE conversation_id = ?1
                  ORDER BY id ASC",
            )?;

            let rows = statement.query_map(params![conversation_id], |row| {
                Ok(ChatMessageRecord {
                    id: row.get(0)?,
                    role: row.get(1)?,
                    content: row.get(2)?,
                    thinking: row.get(3)?,
                    status: row.get(4)?,
                    model: row.get(5)?,
                    response_id: row.get(6)?,
                    checkpoint_id: row.get(7)?,
                    tool_calls_json: row.get(8)?,
                    created_at: row.get(9)?,
                })
            })?;

            rows.collect()
        })
        .map_err(|error| database::database_error(database_path, "list chat messages", error))
}

/// Fetch only user-role messages (excluding context-compaction markers) for
/// a conversation. Returns just id, content and created_at — enough for the
/// chat UI's user-message rail to preview and navigate. Because it skips the
/// heavy thinking/tool_calls_json columns and filters on role, it stays fast
/// even for conversations with thousands of messages.
pub fn list_user_messages(
    database_path: &Path,
    conversation_id: &str,
) -> Result<Vec<UserMessageSummary>> {
    database::open_connection(database_path)
        .and_then(|connection| {
            let mut statement = connection.prepare(
                "SELECT id,
                        content,
                        created_at
                   FROM chat_messages
                  WHERE conversation_id = ?1
                    AND role = 'user'
                    AND (status = '' OR status IS NULL OR status != 'context_compaction')
                  ORDER BY id ASC",
            )?;

            let rows = statement.query_map(params![conversation_id], |row| {
                Ok(UserMessageSummary {
                    id: row.get(0)?,
                    content: row.get(1)?,
                    created_at: row.get(2)?,
                })
            })?;

            rows.collect()
        })
        .map_err(|error| database::database_error(database_path, "list user messages", error))
}

pub fn list_chat_messages_paginated(
    database_path: &Path,
    conversation_id: &str,
    before_message_id: &str,
    limit: i32,
) -> Result<ChatMessagePage> {
    database::open_connection(database_path)
        .and_then(|connection| {
            let total: i32 = connection.query_row(
                "SELECT COUNT(*)
                   FROM chat_messages
                  WHERE conversation_id = ?1",
                params![conversation_id],
                |row| row.get(0),
            )?;

            let safe_limit = if limit > 0 { limit } else { 10 };
            let query_limit = safe_limit.saturating_add(1);
            let mut statement = connection.prepare(
                "SELECT id,
                        role,
                        content,
                        thinking,
                        status,
                        model,
                        response_id,
                        checkpoint_id,
                        tool_calls_json,
                        created_at
                   FROM chat_messages
                  WHERE conversation_id = ?1
                    AND (?2 = '' OR id < ?2)
                  ORDER BY id DESC
                  LIMIT ?3",
            )?;

            let rows = statement.query_map(
                params![conversation_id, before_message_id, query_limit],
                |row| {
                    Ok(ChatMessageRecord {
                        id: row.get(0)?,
                        role: row.get(1)?,
                        content: row.get(2)?,
                        thinking: row.get(3)?,
                        status: row.get(4)?,
                        model: row.get(5)?,
                        response_id: row.get(6)?,
                        checkpoint_id: row.get(7)?,
                        tool_calls_json: row.get(8)?,
                        created_at: row.get(9)?,
                    })
                },
            )?;

            let mut items: Vec<ChatMessageRecord> = rows.collect::<rusqlite::Result<Vec<_>>>()?;
            let has_more = items.len() > safe_limit as usize;
            if has_more {
                items.truncate(safe_limit as usize);
            }
            items.reverse();

            Ok(ChatMessagePage {
                items,
                total,
                has_more,
            })
        })
        .map_err(|error| {
            database::database_error(database_path, "list chat messages paginated", error)
        })
}

/// Extract the result payload for a given tool name from a tool message's
/// content. Tool message content is formatted as:
///   [Tool: <identifier>]\n<result>\n\n[Tool: <identifier2>]\n<result2>...
/// The identifier may be `tool_name` or `tool_name#callId`.
/// Returns the last matching segment's result, or None if no match is found.
fn extract_tool_result(content: &str, tool_name: &str) -> Option<String> {
    let prefix_marker = "[Tool:";
    let suffix = format!("{}#", tool_name);
    let mut last_match: Option<String> = None;

    for segment in content.split("\n\n") {
        let Some(rest) = segment.strip_prefix(prefix_marker) else {
            continue;
        };
        let rest = rest.trim_start();
        let Some(close_bracket) = rest.find("]\n") else {
            continue;
        };
        let identifier = &rest[..close_bracket];
        let result = &rest[close_bracket + 2..];

        if identifier == tool_name || identifier.starts_with(&suffix) {
            last_match = Some(result.to_string());
        }
    }

    last_match
}

/// Find the latest tool result for a specific tool name within a conversation.
/// This bypasses pagination by directly querying the database for tool messages
/// whose content contains the tool name. Used as a fallback when the tool call
/// is in messages that haven't been loaded by the paginated history loader.
pub fn find_latest_tool_result(
    database_path: &Path,
    conversation_id: &str,
    tool_name: &str,
) -> Result<Option<String>> {
    database::open_connection(database_path)
        .and_then(|connection| {
            let like_pattern = format!("%{}%", tool_name);
            connection
                .query_row(
                    "SELECT content
                       FROM chat_messages
                      WHERE conversation_id = ?1
                        AND role = 'tool'
                        AND content LIKE ?2
                      ORDER BY id DESC
                      LIMIT 1",
                    params![conversation_id, like_pattern],
                    |row| row.get::<_, String>(0),
                )
                .optional()
        })
        .map(|content| content.and_then(|c| extract_tool_result(&c, tool_name)))
        .map_err(|error| database::database_error(database_path, "find latest tool result", error))
}

pub fn fork_conversation(
    database_path: &Path,
    source_conversation_id: &str,
    up_to_response_id: &str,
) -> Result<ChatConversationRecord> {
    let mut connection = database::open_connection(database_path)
        .map_err(|error| database::database_error(database_path, "fork conversation", error))?;

    let transaction = connection
        .transaction()
        .map_err(|error| database::database_error(database_path, "fork conversation", error))?;

    // Load source conversation metadata
    let source = transaction
        .query_row(
            "SELECT conversation_id, title, summary, directory_id, model, last_message_preview, api_profile_name
               FROM chat_conversations
              WHERE conversation_id = ?1
              LIMIT 1",
            params![source_conversation_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                ))
            },
        )
        .map_err(|error| database::database_error(database_path, "fork conversation", error))?;

    let new_conversation_id = create_chat_id("conv");
    let new_id = database::create_snowflake_id();

    // Insert new conversation row, marking it as forked. The forked
    // conversation inherits the source conversation's API profile binding so
    // the continuation keeps routing to the same provider/model.
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
           last_response_id,
           status,
           directory_id,
           forked_from_conversation_id,
           fork_message_count,
           created_at,
           updated_at
         ) VALUES (
           ?1, ?2, ?3, ?4, ?8, 0, ?5, ?9, '', 'active', ?6, ?7, 0, datetime('now', 'localtime'), datetime('now', 'localtime')
         )",
        params![
            new_id,
            new_conversation_id,
            source.1,  // title
            source.2,  // summary
            source.4,  // model
            source.3,  // directory_id
            source_conversation_id,
            source.5,  // last_message_preview
            source.6,  // api_profile_name
        ],
    )
    .map_err(|error| database::database_error(database_path, "fork conversation", error))?;

    // Copy messages from the source conversation. When up_to_response_id is
    // non-empty, only messages up to and including the one with that
    // response_id are copied (supports forking from an intermediate AI
    // message). When empty, all messages are copied (full fork).
    let message_rows: Vec<(
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        String,
    )> = {
        let mut stmt = transaction
            .prepare(
                "SELECT message_id, role, content, model, response_id, status, raw_json, thinking, tool_calls_json
                   FROM chat_messages
                  WHERE conversation_id = ?1
                    AND (?2 = '' OR id <= COALESCE(
                      (SELECT id FROM chat_messages WHERE conversation_id = ?1 AND response_id = ?2 LIMIT 1),
                      (SELECT MAX(id) FROM chat_messages WHERE conversation_id = ?1)
                    ))
                  ORDER BY id ASC",
            )
            .map_err(|error| database::database_error(database_path, "fork conversation", error))?;

        let rows = stmt
            .query_map(params![source_conversation_id, up_to_response_id], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get(8)?,
                ))
            })
            .map_err(|error| database::database_error(database_path, "fork conversation", error))?;

        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| database::database_error(database_path, "fork conversation", error))?
    };

    for (index, msg) in message_rows.iter().enumerate() {
        transaction
            .execute(
                "INSERT INTO chat_messages (
               id,
               message_id,
               conversation_id,
               role,
               content,
               model,
               response_id,
               status,
               raw_json,
               thinking,
               tool_calls_json,
               created_at
             ) VALUES (
               ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, datetime('now', 'localtime')
             )",
                params![
                    database::create_snowflake_id(),
                    create_chat_id(&format!("msg{index}")),
                    new_conversation_id,
                    &msg.1, // role
                    &msg.2, // content
                    &msg.3, // model
                    &msg.4, // response_id
                    &msg.5, // status
                    &msg.6, // raw_json
                    &msg.7, // thinking
                    &msg.8, // tool_calls_json
                ],
            )
            .map_err(|error| database::database_error(database_path, "fork conversation", error))?;
    }

    // Update message count and last_message_preview. The preview reflects
    // the last copied message, which may differ from the source conversation's
    // last message when forking from an intermediate point.
    transaction.execute(
        "UPDATE chat_conversations
            SET message_count = (
                SELECT COUNT(*) FROM chat_messages WHERE conversation_id = ?1
            ),
            fork_message_count = (
                SELECT COUNT(*) FROM chat_messages WHERE conversation_id = ?1
            ),
            last_message_preview = (
                SELECT content FROM chat_messages WHERE conversation_id = ?1 ORDER BY id DESC LIMIT 1
            ),
            updated_at = datetime('now', 'localtime')
          WHERE conversation_id = ?1",
        params![new_conversation_id],
    )
    .map_err(|error| database::database_error(database_path, "fork conversation", error))?;

    transaction
        .commit()
        .map_err(|error| database::database_error(database_path, "fork conversation", error))?;

    // Re-read from DB to get accurate created_at / updated_at
    get_chat_conversation(database_path, &new_conversation_id)?.ok_or_else(|| {
        database::database_error(
            database_path,
            "fork conversation",
            rusqlite::Error::QueryReturnedNoRows,
        )
    })
}

pub fn truncate_conversation_from_response(
    database_path: &Path,
    conversation_id: &str,
    response_id: &str,
) -> Result<()> {
    let mut connection = database::open_connection(database_path)
        .map_err(|error| database::database_error(database_path, "truncate conversation", error))?;
    // Reserve the write transaction before locating the rollback boundary.
    // This prevents a concurrent cancelled-stream commit from invalidating a
    // deferred read snapshot before the first DELETE.
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| database::database_error(database_path, "truncate conversation", error))?;

    // Locate either an assistant response or a persisted context-compaction
    // boundary. Boundaries are user messages and must be deleted from their own row.
    let target: Option<(String, String)> = transaction
        .query_row(
            "SELECT id, status FROM chat_messages
              WHERE conversation_id = ?1 AND response_id = ?2
              LIMIT 1",
            params![conversation_id, response_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| database::database_error(database_path, "truncate conversation", error))?;

    let (target_id, target_status) = match target {
        Some(target) => target,
        None => return Ok(()),
    };

    let delete_from = if target_status == "context_compaction" {
        target_id.clone()
    } else {
        // Each normal exchange inserts request messages immediately before the
        // assistant response. Include that request when truncating the exchange.
        let request_id: Option<String> = transaction
            .query_row(
                "SELECT id FROM chat_messages
                  WHERE conversation_id = ?1 AND id < ?2 AND response_id = ''
                  ORDER BY id DESC
                  LIMIT 1",
                params![conversation_id, target_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| {
                database::database_error(database_path, "truncate conversation", error)
            })?;
        request_id.unwrap_or_else(|| target_id.clone())
    };

    // Delete linked TODO items before deleting their response rows, otherwise the
    // response-id subquery would no longer be able to locate the affected items.
    transaction
        .execute(
            "DELETE FROM todo_items
              WHERE session_id = ?1
                AND response_id IN (
                  SELECT response_id FROM chat_messages
                    WHERE conversation_id = ?1
                      AND response_id <> ''
                      AND id >= ?2
                )",
            params![conversation_id, delete_from],
        )
        .map_err(|error| database::database_error(database_path, "delete todo items", error))?;

    // Delete the selected exchange or boundary and everything after it. Messages
    // before a compaction boundary remain available to full-conversation rollback.
    transaction
        .execute(
            "DELETE FROM chat_messages
              WHERE conversation_id = ?1 AND id >= ?2",
            params![conversation_id, delete_from],
        )
        .map_err(|error| database::database_error(database_path, "truncate conversation", error))?;

    // Refresh conversation metadata so the sidebar stays consistent.
    transaction
        .execute(
            "UPDATE chat_conversations
                SET message_count = (
                      SELECT COUNT(*) FROM chat_messages WHERE conversation_id = ?1
                    ),
                    last_message_preview = COALESCE(
                      (SELECT content FROM chat_messages
                        WHERE conversation_id = ?1 ORDER BY id DESC LIMIT 1),
                      ''
                    ),
                    last_response_id = COALESCE(
                      (SELECT response_id FROM chat_messages
                        WHERE conversation_id = ?1 AND response_id <> ''
                        ORDER BY id DESC LIMIT 1),
                      ''
                    ),
                    input_tokens = 0,
                    output_tokens = 0,
                    cache_creation_input_tokens = 0,
                    cache_read_input_tokens = 0,
                    updated_at = datetime('now', 'localtime')
              WHERE conversation_id = ?1",
            params![conversation_id],
        )
        .map_err(|error| database::database_error(database_path, "truncate conversation", error))?;

    transaction
        .commit()
        .map_err(|error| database::database_error(database_path, "truncate conversation", error))?;

    Ok(())
}

fn find_conversation_id_by_response_id(
    database_path: &Path,
    response_id: &str,
) -> Result<Option<String>> {
    database::open_connection(database_path)
        .and_then(|connection| {
            connection
                .query_row(
                    "SELECT conversation_id
                       FROM chat_messages
                      WHERE response_id = ?1
                        AND response_id <> ''
                      ORDER BY id DESC
                      LIMIT 1",
                    [response_id],
                    |row| row.get(0),
                )
                .optional()
        })
        .map_err(|error| database::database_error(database_path, "find chat conversation", error))
}

fn conversation_exists(database_path: &Path, conversation_id: &str) -> Result<bool> {
    database::open_connection(database_path)
        .and_then(|connection| {
            connection
                .query_row(
                    "SELECT 1 FROM chat_conversations WHERE conversation_id = ?1 LIMIT 1",
                    [conversation_id],
                    |_| Ok(()),
                )
                .optional()
                .map(|value| value.is_some())
        })
        .map_err(|error| database::database_error(database_path, "check chat conversation", error))
}

fn insert_message(
    connection: &Connection,
    conversation_id: &str,
    role: &str,
    content: &str,
    response_id: &str,
    checkpoint_id: &str,
    model: &str,
    status: &str,
    raw_json: &str,
    thinking: &str,
    thinking_blocks_json: &str,
    tool_calls_json: &str,
    index: usize,
) -> rusqlite::Result<String> {
    let id = database::create_snowflake_id();
    connection.execute(
        "INSERT INTO chat_messages (
           id,
           message_id,
           conversation_id,
           role,
           content,
           model,
           response_id,
           checkpoint_id,
           status,
           raw_json,
           thinking,
           thinking_blocks_json,
           tool_calls_json,
           created_at
         ) VALUES (
           ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, datetime('now', 'localtime')
         )",
        params![
            id,
            create_chat_id(&format!("msg{index}")),
            conversation_id,
            normalize_role(role),
            content.trim(),
            model,
            response_id,
            checkpoint_id,
            status,
            raw_json,
            thinking.trim(),
            thinking_blocks_json,
            tool_calls_json,
        ],
    )?;

    Ok(id)
}

fn normalize_role(role: &str) -> &str {
    match role.trim() {
        "assistant" => "assistant",
        "system" => "system",
        "developer" => "developer",
        "tool" => "tool",
        _ => "user",
    }
}

fn map_chat_conversation_row(row: &Row<'_>) -> rusqlite::Result<ChatConversationRecord> {
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
    })
}

/// Re-binds a conversation to a different API config profile at runtime.
/// The new profile takes effect from the next AI request onward. Passing an
/// empty profile name unbinds the conversation so it follows the global
/// active profile again.
pub fn update_conversation_api_profile(
    database_path: &Path,
    conversation_id: &str,
    profile_name: &str,
) -> Result<()> {
    let trimmed_profile_name = profile_name.trim();
    database::open_connection(database_path)
        .and_then(|connection| {
            connection.execute(
                "UPDATE chat_conversations
                    SET api_profile_name = ?2,
                        updated_at = datetime('now', 'localtime')
                  WHERE conversation_id = ?1",
                params![conversation_id, trimmed_profile_name],
            )
        })
        .map_err(|error| {
            database::database_error(database_path, "update conversation API profile", error)
        })
        .map(|_| ())
}

/// Reads the API profile bound to a conversation, if any. Used by the
/// request router to resolve which provider should serve a conversation's
/// next message when the request itself does not carry an explicit profile.
/// Returns `Ok(None)` when the conversation does not exist or was never
/// bound (meaning "follow the global active profile").
pub fn get_conversation_api_profile(
    database_path: &Path,
    conversation_id: &str,
) -> Result<Option<String>> {
    database::open_connection(database_path)
        .and_then(|connection| {
            connection
                .query_row(
                    "SELECT api_profile_name
                       FROM chat_conversations
                      WHERE conversation_id = ?1
                      LIMIT 1",
                    params![conversation_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map(|profile_name| profile_name.filter(|value| !value.trim().is_empty()))
        })
        .map_err(|error| {
            database::database_error(database_path, "get conversation API profile", error)
        })
}

fn create_title(messages: &[ChatContextMessage]) -> String {
    let source = messages
        .iter()
        .find(|message| {
            normalize_role(&message.role) == "user" && !message.content.trim().is_empty()
        })
        .or_else(|| {
            messages
                .iter()
                .find(|message| !message.content.trim().is_empty())
        })
        .map(|message| {
            // 展开 @@review: / @@element: 标签，避免标题显示 base64/JSON 外壳；
            // 其余消息原文不变。
            let mut content = message.content.clone();
            if let Some(expanded) = expand_review_tags_in_content(&content) {
                content = expanded;
            }
            if let Some(expanded) = expand_element_tags_in_content(&content) {
                content = expanded;
            }
            content
        })
        .unwrap_or_else(|| "新对话".to_string());

    create_snippet(&source, 80)
}

fn create_snippet(content: &str, max_chars: usize) -> String {
    let compact = content
        .trim()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let source = if compact.is_empty() {
        content.trim()
    } else {
        compact.as_str()
    };
    let mut chars = source.chars();
    let mut snippet = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        snippet.push('…');
    }
    snippet
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

fn create_chat_id(prefix: &str) -> String {
    let timestamp = Utc::now()
        .timestamp_nanos_opt()
        .unwrap_or_else(|| Utc::now().timestamp_micros() * 1_000);
    format!("{prefix}-{timestamp}-{}", std::process::id())
}

/// Per-conversation Plan/Goal Mode overrides. `None` means the conversation
/// row does not exist and the caller follows the global default. Rows whose
/// stored flags are NULL (legacy data) are read as `Some(false)` — NULL is
/// synonymous with 0 (disabled).
#[derive(Clone, Copy, Debug, Default)]
pub struct ConversationModes {
    pub plan_mode: Option<bool>,
    pub goal_mode: Option<bool>,
    pub goal_mode_token_budget: Option<i64>,
}

/// Read a conversation's Plan/Goal Mode overrides. Returns an all-`None`
/// record when the conversation row does not exist.
///
/// Legacy compatibility: rows created before per-conversation modes existed
/// (or before the mode columns were backfilled) carry NULL flags. NULL is
/// read as disabled — synonymous with 0 — so old conversations open with
/// both modes off instead of inheriting the global defaults. The token
/// budget keeps NULL = "follow the global default budget".
pub fn get_conversation_modes(
    database_path: &Path,
    conversation_id: &str,
) -> Result<ConversationModes> {
    database::open_connection(database_path)
        .and_then(|connection| {
            connection
                .query_row(
                    "SELECT plan_mode, goal_mode, goal_mode_token_budget
                       FROM chat_conversations
                      WHERE conversation_id = ?1
                      LIMIT 1",
                    params![conversation_id],
                    |row| {
                        Ok(ConversationModes {
                            plan_mode: Some(
                                row.get::<_, Option<i64>>(0)?
                                    .map(|v| v != 0)
                                    .unwrap_or(false),
                            ),
                            goal_mode: Some(
                                row.get::<_, Option<i64>>(1)?
                                    .map(|v| v != 0)
                                    .unwrap_or(false),
                            ),
                            goal_mode_token_budget: row.get::<_, Option<i64>>(2)?,
                        })
                    },
                )
                .optional()
        })
        .map(|record| record.unwrap_or_default())
        .map_err(|error| database::database_error(database_path, "get conversation modes", error))
}

/// Upsert a conversation's Plan/Goal Mode overrides. Only the columns whose
/// value is `Some` are updated; `None` leaves the stored override untouched.
/// The row is created on first write (all other columns fall back to their
/// defaults) so a mode can be recorded even before the first exchange.
///
/// The INSERT branch must supply `id`: SQLite evaluates NOT NULL constraints
/// before resolving the upsert's UNIQUE conflict, so an omitted `id` aborts
/// the statement with a NOT NULL violation even when the conversation row
/// already exists.
pub fn set_conversation_modes(
    database_path: &Path,
    conversation_id: &str,
    plan_mode: Option<bool>,
    goal_mode: Option<bool>,
    goal_mode_token_budget: Option<i64>,
) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|connection| {
            connection.execute(
                "INSERT INTO chat_conversations (
                   id, conversation_id, plan_mode, goal_mode, goal_mode_token_budget
                 )
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(conversation_id) DO UPDATE SET
                   plan_mode = COALESCE(excluded.plan_mode, chat_conversations.plan_mode),
                   goal_mode = COALESCE(excluded.goal_mode, chat_conversations.goal_mode),
                   goal_mode_token_budget = COALESCE(excluded.goal_mode_token_budget, chat_conversations.goal_mode_token_budget)",
                params![
                    database::create_snowflake_id(),
                    conversation_id,
                    plan_mode.map(|v| if v { 1 } else { 0 }),
                    goal_mode.map(|v| if v { 1 } else { 0 }),
                    goal_mode_token_budget,
                ],
            )?;
            Ok(())
        })
        .map_err(|error| database::database_error(database_path, "set conversation modes", error))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use rusqlite::Connection;

    use super::create_sub_agent_session;
    use crate::storage::database;

    #[test]
    fn create_sub_agent_session_persists_runtime_profile_and_model_snapshot() {
        let temporary_directory = std::env::temp_dir().join(format!(
            "snow-chat-conversations-test-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&temporary_directory).expect("create temporary directory");
        let database_path = temporary_directory.join("snow.db");
        database::ensure_database(&database_path).expect("initialize database");
        let connection = database::open_connection(&database_path).expect("open database");
        connection
            .execute(
                "INSERT INTO chat_conversations (id, conversation_id)
                 VALUES ('parent-row', 'parent-conversation')",
                [],
            )
            .expect("insert parent conversation");
        drop(connection);

        create_sub_agent_session(
            &database_path,
            "sub-conversation",
            "parent-conversation",
            "reviewer",
            "Code reviewer",
            "directory-id",
            "  fixed-profile  ",
            "  fixed-model  ",
            "Review task",
        )
        .expect("create sub-agent session");

        let connection = Connection::open(&database_path).expect("reopen database");
        let snapshot: (String, String) = connection
            .query_row(
                "SELECT api_profile_name, model
                   FROM chat_conversations
                  WHERE conversation_id = 'sub-conversation'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read persisted runtime snapshot");
        let session: (String, String, String) = connection
            .query_row(
                "SELECT parent_conversation_id, agent_id, run_status
                   FROM sub_agent_sessions
                  WHERE conversation_id = 'sub-conversation'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("read sub-agent session");
        drop(connection);
        fs::remove_dir_all(&temporary_directory).expect("remove temporary directory");

        assert_eq!(snapshot, ("fixed-profile".into(), "fixed-model".into()));
        assert_eq!(
            session,
            (
                "parent-conversation".into(),
                "reviewer".into(),
                "running".into()
            )
        );
    }
}
