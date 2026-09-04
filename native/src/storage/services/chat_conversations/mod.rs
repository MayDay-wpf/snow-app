use std::path::Path;

use chrono::Utc;
use napi::bindgen_prelude::*;
use rusqlite::{params, Connection, OptionalExtension, Row};

use super::super::database;
use super::super::ChatConversationRecord;
use crate::api::conversation::images::{
    expand_conversation_tags_in_content, expand_element_tags_in_content,
    expand_review_tags_in_content,
};

mod fork_truncate;
mod messages;
mod query;
mod sub_agent;
mod workflow;

pub use self::fork_truncate::*;
pub use self::messages::*;
pub use self::query::*;
pub use self::sub_agent::*;
pub use self::workflow::*;

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
    pub interruption_reason: Option<&'a str>,
    pub recovery_outcome: Option<&'a str>,
    pub raw_response_json: &'a str,
    pub token_usage: ChatTokenUsage,
    pub response_thinking: &'a str,
    pub response_thinking_blocks_json: &'a str,
    /// Wall-clock duration (ms) between the first and last thinking delta of
    /// this response's stream. Persisted for the thinking block summary UI.
    pub response_thinking_duration_ms: i64,
    /// Thinking-only token count of this response's stream (counted by the
    /// backend with the same tokenizer as the stream probe).
    pub response_thinking_token_count: i64,
    pub tool_calls_json: &'a str,
    pub directory_id: &'a str,
    pub context_compaction: bool,
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
                    AND NOT (
                      role = 'user'
                      AND EXISTS (
                        SELECT 1 FROM chat_messages nxt
                         WHERE nxt.conversation_id = chat_messages.conversation_id
                           AND nxt.id > chat_messages.id
                           AND nxt.id = (
                             SELECT MIN(id) FROM chat_messages
                              WHERE conversation_id = chat_messages.conversation_id
                                AND id > chat_messages.id
                           )
                           AND nxt.role = 'assistant'
                           AND nxt.status = 'error'
                      )
                    )
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
            let successful_context_compaction = input.context_compaction
                && input.status == "completed"
                && !input.response_content.trim().is_empty();
            // The provider usage describes the API call itself and is recorded
            // separately in usage history. This row stores the latest context
            // snapshot: after successful compaction, only the generated handoff
            // remains. Failed, cancelled, or empty compactions keep the previous
            // snapshot intact.
            let context_usage = if input.status == "error"
                || (input.context_compaction && !successful_context_compaction)
            {
                None
            } else if successful_context_compaction {
                Some(ChatTokenUsage {
                    input_tokens: input.token_usage.output_tokens,
                    ..ChatTokenUsage::default()
                })
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

            if successful_context_compaction {
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
                    None,
                    None,
                    input.raw_response_json,
                    "",
                    "[]",
                    0,
                    0,
                    "[]",
                    0,
                )?;
                persisted_user_message_ids.push(message_id);
            } else if !input.context_compaction {
                // Unsuccessful compactions must not create a boundary or a
                // replacement assistant message; the previous context remains
                // authoritative.
                // Successful-path callers pass `prepared_request.current_messages`,
                // which already exclude the resume handoff placeholder (it is
                // persisted as the `context_compaction` boundary). The failed
                // path filters the placeholder in `store_failed_chat_exchange`
                // before forwarding. Everything received here is persisted as a
                // normal message — the assistant response is always persisted
                // below.
                for (index, message) in input.request_messages.iter().enumerate() {
                        // 所有 user 消息都绑定本次请求的 checkpoint。工具迭代
                        // 中途刷新的待发消息以 [tool, user] 结构进入请求，
                        // 若只绑定首条 user，该消息的 checkpoint 无法落库，
                        // 重启后回滚到它会丢失文件变更（与 Pending 消息回滚
                        // 错乱同源）。
                        let checkpoint_id =
                            if normalize_role(&message.role) == "user" {
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
                            None,
                            None,
                            raw_json,
                            "",
                            "[]",
                            0,
                            0,
                            "[]",
                            index,
                        )?;
                        if normalize_role(&message.role) == "user" {
                            persisted_user_message_ids.push(message_id);
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
                    input.interruption_reason,
                    input.recovery_outcome,
                    input.raw_response_json,
                    input.response_thinking,
                    input.response_thinking_blocks_json,
                    input.response_thinking_duration_ms,
                    input.response_thinking_token_count,
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

/// Persist a failed exchange (user messages + error assistant message) and
/// return the resolved conversation id together with the persisted user
/// message ids. The ids are the rollback boundary for failed turns: the
/// failed assistant row carries an empty `response_id`, so the renderer
/// cannot locate the exchange via `truncate_conversation_from_response` and
/// must truncate from the persisted user message id instead.
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
) -> Result<(String, Vec<String>)> {
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
    // Resume-after-compaction requests carry the handoff placeholder as their
    // FIRST message — it is already persisted as the `context_compaction`
    // boundary and must not be re-inserted as a normal user message. Entries
    // after the placeholder are protected messages (the last user task message
    // captured before compaction) and ARE persisted so the task survives later
    // compactions too.
    let request_messages = if resume_after_compaction {
        request_messages.into_iter().skip(1).collect::<Vec<_>>()
    } else {
        request_messages
    };
    // Resume-after-compaction requests may be left with only the skipped
    // placeholder (no protected messages), which is fine — allow it through
    // empty. All other empty requests are rejected.
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

    let persisted_user_message_ids = store_chat_exchange(
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
            interruption_reason: None,
            recovery_outcome: None,
            raw_response_json: "{}",
            token_usage: ChatTokenUsage::default(),
            response_thinking: "",
            response_thinking_blocks_json: "[]",
            response_thinking_duration_ms: 0,
            response_thinking_token_count: 0,
            tool_calls_json: "[]",
            directory_id,
            context_compaction: false,
            total_duration_ms: 0,
        },
    )?;

    Ok((conversation_id, persisted_user_message_ids))
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
                None,
                None,
                "{}",
                "",
                "[]",
                0,
                0,
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

fn insert_message(
    connection: &Connection,
    conversation_id: &str,
    role: &str,
    content: &str,
    response_id: &str,
    checkpoint_id: &str,
    model: &str,
    status: &str,
    interruption_reason: Option<&str>,
    recovery_outcome: Option<&str>,
    raw_json: &str,
    thinking: &str,
    thinking_blocks_json: &str,
    thinking_duration_ms: i64,
    thinking_token_count: i64,
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
           interruption_reason,
           recovery_outcome,
           raw_json,
           thinking,
           thinking_duration_ms,
           thinking_token_count,
           thinking_blocks_json,
           tool_calls_json,
           created_at
         ) VALUES (
           ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, datetime('now', 'localtime')
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
            interruption_reason,
            recovery_outcome,
            raw_json,
            thinking.trim(),
            thinking_duration_ms,
            thinking_token_count,
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

pub(crate) fn map_chat_conversation_row(row: &Row<'_>) -> rusqlite::Result<ChatConversationRecord> {
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
            // 展开 @@review: / @@element: / @@conversation: 标签，避免标题显示
            // base64/JSON 外壳；其余消息原文不变。
            let mut content = message.content.clone();
            if let Some(expanded) = expand_review_tags_in_content(&content) {
                content = expanded;
            }
            if let Some(expanded) = expand_element_tags_in_content(&content) {
                content = expanded;
            }
            if let Some(expanded) = expand_conversation_tags_in_content(&content) {
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

pub(crate) fn create_chat_id(prefix: &str) -> String {
    let timestamp = Utc::now()
        .timestamp_nanos_opt()
        .unwrap_or_else(|| Utc::now().timestamp_micros() * 1_000);
    format!("{prefix}-{timestamp}-{}", std::process::id())
}

/// Nullable per-conversation runtime configuration overrides. A `None` value
/// means the conversation follows its bound API profile default; it must not be
/// collapsed into an empty string or `false` at the storage boundary.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ConversationRuntimeConfig {
    pub thinking_strength: Option<String>,
    pub responses_fast_mode: Option<bool>,
}

/// Replace both nullable runtime override columns as one complete snapshot.
/// `None` is intentionally bound as SQL NULL, so callers can explicitly clear
/// either override without inheriting the COALESCE semantics of ConversationModes.
pub fn set_conversation_runtime_config(
    database_path: &Path,
    conversation_id: &str,
    thinking_strength: Option<String>,
    responses_fast_mode: Option<bool>,
) -> Result<()> {
    let normalized_thinking_strength = thinking_strength.and_then(|value| {
        let trimmed = value.trim().to_string();
        (!trimmed.is_empty()).then_some(trimmed)
    });

    database::open_connection(database_path)
        .and_then(|connection| {
            connection.execute(
                "INSERT INTO chat_conversations (
                   id, conversation_id, thinking_strength, responses_fast_mode
                 )
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(conversation_id) DO UPDATE SET
                   thinking_strength = excluded.thinking_strength,
                   responses_fast_mode = excluded.responses_fast_mode",
                params![
                    database::create_snowflake_id(),
                    conversation_id,
                    normalized_thinking_strength,
                    responses_fast_mode.map(|value| if value { 1_i64 } else { 0_i64 }),
                ],
            )?;
            Ok(())
        })
        .map_err(|error| {
            database::database_error(database_path, "set conversation runtime config", error)
        })
}

/// Per-conversation Plan/Goal Mode overrides. `None` means the conversation
/// row does not exist and the caller follows the global default. Rows whose
/// stored flags are NULL (legacy data) are read as `Some(false)` — NULL is
/// synonymous with 0 (disabled).
#[derive(Clone, Copy, Debug, Default)]
pub struct ConversationModes {
    pub plan_mode: Option<bool>,
    pub goal_mode: Option<bool>,
    pub worktree_mode: Option<bool>,
    pub workflow_mode: Option<bool>,
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
                    "SELECT plan_mode, goal_mode, worktree_mode, workflow_mode, goal_mode_token_budget
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
                            worktree_mode: Some(
                                row.get::<_, Option<i64>>(2)?
                                    .map(|v| v != 0)
                                    .unwrap_or(false),
                            ),
                            workflow_mode: Some(
                                row.get::<_, Option<i64>>(3)?
                                    .map(|v| v != 0)
                                    .unwrap_or(false),
                            ),
                            goal_mode_token_budget: row.get::<_, Option<i64>>(4)?,
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
    worktree_mode: Option<bool>,
    workflow_mode: Option<bool>,
    goal_mode_token_budget: Option<i64>,
) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|connection| {
            connection.execute(
                "INSERT INTO chat_conversations (
                   id, conversation_id, plan_mode, goal_mode, worktree_mode, workflow_mode, goal_mode_token_budget
                 )
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(conversation_id) DO UPDATE SET
                   plan_mode = COALESCE(excluded.plan_mode, chat_conversations.plan_mode),
                   goal_mode = COALESCE(excluded.goal_mode, chat_conversations.goal_mode),
                   worktree_mode = COALESCE(excluded.worktree_mode, chat_conversations.worktree_mode),
                   workflow_mode = COALESCE(excluded.workflow_mode, chat_conversations.workflow_mode),
                   goal_mode_token_budget = COALESCE(excluded.goal_mode_token_budget, chat_conversations.goal_mode_token_budget)",
                params![
                    database::create_snowflake_id(),
                    conversation_id,
                    plan_mode.map(|v| if v { 1 } else { 0 }),
                    goal_mode.map(|v| if v { 1 } else { 0 }),
                    worktree_mode.map(|v| if v { 1 } else { 0 }),
                    workflow_mode.map(|v| if v { 1 } else { 0 }),
                    goal_mode_token_budget,
                ],
            )?;
            Ok(())
        })
        .map_err(|error| database::database_error(database_path, "set conversation modes", error))
}

/// 把最近一次 AI run 的累计用量与墙钟总耗时**累加**进会话的累计统计
/// （run 摘要条回显用）。每个 run 结束时调用一次：token 与耗时随每次
/// loop 增长，展示的是「整个会话」的累计值而非单次 run。
///
/// 与 `store_chat_exchange` 覆盖式写入的「最后一次请求快照」列
/// （input_tokens 等）语义不同：run_* 列由渲染进程在 agent loop 完全
/// 结束时增量写入，重启后打开会话仍可完整回显。
pub fn set_conversation_run_stats(
    database_path: &Path,
    conversation_id: &str,
    run_input_tokens: i64,
    run_output_tokens: i64,
    run_cache_creation_input_tokens: i64,
    run_cache_read_input_tokens: i64,
    last_run_duration_ms: i64,
) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|connection| {
            connection.execute(
                "INSERT INTO chat_conversations (
                   id, conversation_id,
                   run_input_tokens, run_output_tokens,
                   run_cache_creation_input_tokens, run_cache_read_input_tokens,
                   last_run_duration_ms
                 )
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(conversation_id) DO UPDATE SET
                   run_input_tokens = chat_conversations.run_input_tokens + excluded.run_input_tokens,
                   run_output_tokens = chat_conversations.run_output_tokens + excluded.run_output_tokens,
                   run_cache_creation_input_tokens = chat_conversations.run_cache_creation_input_tokens + excluded.run_cache_creation_input_tokens,
                   run_cache_read_input_tokens = chat_conversations.run_cache_read_input_tokens + excluded.run_cache_read_input_tokens,
                   last_run_duration_ms = chat_conversations.last_run_duration_ms + excluded.last_run_duration_ms,
                   updated_at = datetime('now', 'localtime')",
                params![
                    database::create_snowflake_id(),
                    conversation_id,
                    run_input_tokens,
                    run_output_tokens,
                    run_cache_creation_input_tokens,
                    run_cache_read_input_tokens,
                    last_run_duration_ms,
                ],
            )?;
            Ok(())
        })
        .map_err(|error| {
            database::database_error(database_path, "set conversation run stats", error)
        })
}

/// 清零会话的累计 run 统计（回滚截断消息后调用，避免摘要回显与
/// 截断后的消息列表不一致）。
pub fn reset_conversation_run_stats(
    database_path: &Path,
    conversation_id: &str,
) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|connection| {
            connection.execute(
                "UPDATE chat_conversations
                    SET run_input_tokens = 0,
                        run_output_tokens = 0,
                        run_cache_creation_input_tokens = 0,
                        run_cache_read_input_tokens = 0,
                        last_run_duration_ms = 0,
                        updated_at = datetime('now', 'localtime')
                  WHERE conversation_id = ?1",
                params![conversation_id],
            )?;
            Ok(())
        })
        .map_err(|error| {
            database::database_error(database_path, "reset conversation run stats", error)
        })
}
