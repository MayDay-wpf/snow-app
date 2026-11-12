use std::path::Path;

use chrono::Utc;
use napi::bindgen_prelude::*;
use rusqlite::{params, Connection, OptionalExtension, Row, TransactionBehavior};

use snow_storage_core::database;
use snow_storage_core::models::ChatConversationRecord;
use crate::tags::expand_display_tags_in_content;

mod context_folds;
mod fork_truncate;
mod manual_exchange;
mod messages;
mod task_history;
pub use self::task_history::*;
mod query;
mod sub_agent;
mod sub_agent_runs;
mod tombstones;
mod workflow;

pub use self::context_folds::*;
pub use self::fork_truncate::*;
pub use self::manual_exchange::*;
pub use self::messages::*;
pub use self::query::*;
pub use self::sub_agent::*;
pub use self::sub_agent_runs::sub_agent_run_command;
pub use self::sub_agent_runs::{
    backfill_dispatch_identity as backfill_sub_agent_dispatch_identity,
    check_gate as check_sub_agent_conversation_gate, ensure_sub_agent_run_data_tables,
    ensure_sub_agent_run_tables, guard_sub_agent_archive, guard_sub_agent_physical_delete,
};
pub use self::tombstones::{
    clear_conversation_tombstones, is_conversation_tombstoned, record_conversation_tombstones,
};
pub use self::workflow::*;

pub const ORIGIN_USER: &str = "user";
pub const ORIGIN_INTERNAL: &str = "internal";
pub const ORIGIN_UNKNOWN: &str = "unknown";

pub fn parse_message_origin(origin: Option<&str>) -> Result<&'static str> {
    match origin {
        Some(ORIGIN_USER) => Ok(ORIGIN_USER),
        Some(ORIGIN_INTERNAL) => Ok(ORIGIN_INTERNAL),
        None | Some(ORIGIN_UNKNOWN) => Ok(ORIGIN_UNKNOWN),
        Some(value) => Err(Error::new(
            Status::InvalidArg,
            format!("Invalid chat message origin: {value}"),
        )),
    }
}

#[derive(Clone, Debug)]
pub struct ChatContextMessage {
    pub role: String,
    pub origin: String,
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
    /// Number of automatic retries attempted for this exchange's request
    /// (0 when none). Persisted so the retry-exhausted notice still explains
    /// the failure after a reload.
    pub retry_attempts: i64,
    /// Upstream error text of the last automatic retry (empty when none).
    pub retry_error: &'a str,
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
    /// 分层增量压缩：成功时把摘要落成折叠行（携带折叠区间），不再是交接边界。
    pub context_fold: Option<&'a ContextFoldRecord>,
    pub total_duration_ms: i64,
    /// 重试失败回合（子代理「重试」）：该回合的请求消息已随失败回合落库，本次不再
    /// 重复写入；末尾的失败助手行由本次响应替换，已完成工具结果的证据行原样保留。
    pub retry_failed_response: bool,
}

/// 一次交换落库产生的消息 id（助手 id 为空表示未写助手行）。
#[derive(Debug, Default)]
pub struct StoredChatExchange {
    pub user_message_ids: Vec<String>,
    pub assistant_message_id: String,
}

fn context_usage_snapshot(
    status: &str,
    context_compaction: bool,
    response_content: &str,
    token_usage: ChatTokenUsage,
) -> Option<ChatTokenUsage> {
    let successful_context_compaction =
        context_compaction && status == "completed" && !response_content.trim().is_empty();
    if status == "error" || (context_compaction && !successful_context_compaction) {
        None
    } else if successful_context_compaction {
        Some(ChatTokenUsage {
            input_tokens: token_usage.output_tokens,
            ..ChatTokenUsage::default()
        })
    } else {
        Some(token_usage)
    }
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

/// 创建主会话（无模型绑定，沿用全局激活档案）。`initial_text` 非空时在同一事务内
/// 写入一条 user 消息，仅入库、不触发回合；首条消息由 store_chat_exchange 写入时保留此处标题。
pub fn create_chat_conversation(
    database_path: &Path,
    directory_id: &str,
    title: &str,
    initial_text: Option<&str>,
) -> Result<String> {
    let conversation_id = create_chat_id("conv");
    let initial_text = initial_text
        .map(str::trim)
        .filter(|value| !value.is_empty());
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
                   ?1, ?2, ?3, ?3, '', 0, '', '', '', 'active', ?4, '', 0,
                   datetime('now', 'localtime'), datetime('now', 'localtime')
                 )",
                params![
                    database::create_snowflake_id(),
                    conversation_id,
                    title.trim(),
                    directory_id.trim(),
                ],
            )?;
            if let Some(text) = initial_text {
                insert_message(
                    &transaction,
                    &conversation_id,
                    "user",
                    text,
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
                    None,
                    0,
                    0,
                    "",
                    ORIGIN_UNKNOWN,
                )?;
                transaction.execute(
                    "UPDATE chat_conversations
                        SET message_count = 1,
                            last_message_preview = ?2,
                            updated_at = datetime('now', 'localtime')
                      WHERE conversation_id = ?1",
                    params![conversation_id, create_snippet(text, 180)],
                )?;
            }
            transaction.commit()
        })
        .map_err(|error| database::database_error(database_path, "create chat conversation", error))
        .map(|_| conversation_id)
}

pub fn load_context_messages(
    database_path: &Path,
    conversation_id: &str,
) -> Result<Vec<ChatContextMessage>> {
    Ok(load_context_view(database_path, conversation_id)?
        .iter()
        .map(ContextViewItem::to_message)
        .collect())
}

/// 当前有效上下文：从最近一条交接式压缩边界开始（折叠行不是边界），并把活跃
/// 折叠覆盖的原始消息替换为折叠摘要。
pub fn load_context_view(
    database_path: &Path,
    conversation_id: &str,
) -> Result<Vec<ContextViewItem>> {
    database::open_connection(database_path)
        .and_then(|connection| {
            let mut statement = connection.prepare(
                "SELECT role, content, tool_calls_json, raw_json, thinking, thinking_blocks_json, origin, id, status
                   FROM chat_messages
                  WHERE conversation_id = ?1
                    AND id >= COALESCE(
                      (SELECT id
                         FROM chat_messages
                        WHERE conversation_id = ?1
                          AND status = 'context_compaction'
                          AND instr(raw_json, '\"contextFold\"') = 0
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
                      AND NOT (status = 'context_compaction' AND instr(raw_json, '\"contextFold\"') > 0)
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
                let status: String = row.get(8)?;
                let fold = (status == "context_compaction")
                    .then(|| ContextFoldMeta::parse(&raw_json))
                    .flatten();
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
                Ok(ContextRow {
                    id: row.get(7)?,
                    fold,
                    message: ChatContextMessage {
                        role,
                        origin: row.get(6)?,
                        content,
                        tool_calls_json,
                        tool_results_json,
                        thinking,
                        thinking_blocks_json,
                    },
                })
            })?;

            rows.collect::<rusqlite::Result<Vec<_>>>()
        })
        .map(build_view)
        .map_err(|error| database::database_error(database_path, "load chat context", error))
}

/// 删除会话末尾的失败助手行（role=assistant 且 status 为 error/failed），供重试
/// 失败回合时用本次响应替换它。已完成工具结果的证据行不在删除之列，绝不触碰；
/// 末尾不是失败助手行时为 no-op。必须在调用方的事务内执行。
fn drop_trailing_failed_assistant(
    transaction: &rusqlite::Transaction<'_>,
    conversation_id: &str,
) -> rusqlite::Result<()> {
    let last: Option<(String, String, String)> = transaction
        .query_row(
            "SELECT id, role, status FROM chat_messages
              WHERE conversation_id = ?1
              ORDER BY id DESC
              LIMIT 1",
            params![conversation_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let Some((id, role, status)) = last else {
        return Ok(());
    };
    if !role.eq_ignore_ascii_case("assistant")
        || !(status.eq_ignore_ascii_case("failed") || status.eq_ignore_ascii_case("error"))
    {
        return Ok(());
    }
    transaction.execute("DELETE FROM chat_messages WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn store_chat_exchange(
    database_path: &Path,
    input: &StoreChatExchangeInput<'_>,
) -> Result<StoredChatExchange> {
    database::open_connection(database_path)
        .and_then(|mut connection| {
            // 先读墓碑再写入：IMMEDIATE 在事务开始即取得写锁，保证与删除 /
            // 归档事务串行，读到的墓碑状态在本事务提交前不会变化。
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            // 会话已被删除 / 归档（含级联的子代理、WorkFlow 节点会话）：
            // 收尾中的回合迟到落库时整体丢弃，不得重建会话行与消息。
            if is_conversation_tombstoned(&transaction, input.conversation_id)? {
                return Ok(StoredChatExchange::default());
            }
            // 重试失败回合：末尾的失败助手行由本次响应替换（先移除，下面重新插入）。
            if input.retry_failed_response {
                drop_trailing_failed_assistant(&transaction, input.conversation_id)?;
            }
            let mut persisted_user_message_ids = Vec::new();
            let mut persisted_assistant_message_id = String::new();
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
            let context_usage = context_usage_snapshot(
                input.status,
                input.context_compaction,
                input.response_content,
                input.token_usage,
            );
            // 折叠压缩只替换被折叠的区间：快照 = 调用输入 - 折叠部分 + 保留的近期消息 + 摘要。
            let context_usage = match (successful_context_compaction, input.context_fold) {
                (true, Some(fold)) => Some(ChatTokenUsage {
                    input_tokens: fold.context_input_tokens(
                        input.token_usage.input_tokens,
                        input.token_usage.output_tokens,
                    ),
                    ..ChatTokenUsage::default()
                }),
                _ => context_usage,
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
                // 交接式压缩即上下文重建：删除会话级提示词冻结快照，下一轮请求按最新
                // 配置重新解析（ROLE.md / API 档案系统提示词 / Project Memory 章节）。
                // 折叠压缩只替换被折叠的区间，保留快照，系统提示词前缀继续命中缓存。
                if input.context_fold.is_none() {
                    crate::system_prompt_snapshots::delete_snapshots(
                        &transaction,
                        &[input.conversation_id.to_string()],
                    )?;
                    crate::project_memories::delete_prompt_snapshots(
                        &transaction,
                        &[input.conversation_id.to_string()],
                    )?;
                }
                let raw_json = input
                    .context_fold
                    .map(|fold| fold.meta.to_raw_json())
                    .unwrap_or_else(|| input.raw_response_json.to_string());
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
                    &raw_json,
                    "",
                    "[]",
                    0,
                    0,
                    "[]",
                    context_usage,
                    0,
                    0,
                    "",
                    ORIGIN_INTERNAL,
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
                // 正常消息在这里逐条落库；重试失败回合的请求消息已随失败回合写入，
                // 这里只把它们当上下文使用，不再重复入库。
                let request_messages: &[ChatContextMessage] = if input.retry_failed_response {
                    &[]
                } else {
                    input.request_messages
                };
                for (index, message) in request_messages.iter().enumerate() {
                        // 系统/开发者文本是请求级指令（内置提示词、宿主事实、
                        // 内部续跑指令），从不进入会话历史：落库会让后续请求
                        // 误判历史已自带系统提示词，并破坏可缓存的前缀。
                        if matches!(normalize_role(&message.role), "system" | "developer") {
                            continue;
                        }
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
                        //
                        // Tool results may embed image base64 (filesystem-read
                        // returning `@@image:data:...@@` for an image file):
                        // persist those inline images to disk first so the
                        // database and every subsequent request carry short
                        // upload tags instead of megabytes of base64.
                        let raw_json = if normalize_role(&message.role) == "tool" {
                            match message.tool_results_json.as_deref() {
                                Some(raw) if raw != "{}" && !raw.is_empty() => {
                                    crate::media::persist_inline_images_to_disk(
                                        raw,
                                        database_path,
                                    )
                                    .unwrap_or_else(|_| raw.to_string())
                                }
                                _ => "{}".to_string(),
                            }
                        } else {
                            "{}".to_string()
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
                            &raw_json,
                            "",
                            "[]",
                            0,
                            0,
                            "[]",
                            None,
                            index,
                            0,
                            "",
                            &message.origin,
                        )?;
                        if normalize_role(&message.role) == "user" {
                            persisted_user_message_ids.push(message_id);
                        }
                    }

                persisted_assistant_message_id = insert_message(
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
                    context_usage,
                    request_messages.len(),
                    input.retry_attempts,
                    input.retry_error,
                    ORIGIN_INTERNAL,
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
            Ok(StoredChatExchange {
                user_message_ids: persisted_user_message_ids,
                assistant_message_id: persisted_assistant_message_id,
            })
        })
        .map_err(|error| database::database_error(database_path, "store chat exchange", error))
}

/// Ceilings for persisted failed-exchange contents. A failed request usually
/// carries exactly the attachments that blew the context window; persisting
/// them verbatim makes every subsequent request exceed the limit again (the
/// failed exchange is loaded as history), trapping the conversation in a
/// 400-loop. Inline base64 image payloads beyond
/// [`FAILED_EXCHANGE_IMAGE_TAG_MAX_CHARS`] are replaced by a placeholder and
/// contents beyond [`FAILED_EXCHANGE_CONTENT_MAX_CHARS`] are truncated.
const FAILED_EXCHANGE_IMAGE_TAG_MAX_CHARS: usize = 8_192;
const FAILED_EXCHANGE_CONTENT_MAX_CHARS: usize = 200_000;

/// Slim down a failed exchange message before persistence:
/// 1. Replace oversized inline base64 image tags (`@@image:data:...@@`) with
///    a short placeholder — the payload is unreadable to the model anyway
///    and dominates the content size. Small data URLs and disk-backed
///    references (`upload/...` paths) are kept as-is.
/// 2. Truncate contents that still exceed the length ceiling, on a char
///    boundary, with an explicit marker.
fn sanitize_failed_exchange_content(content: &str) -> String {
    const IMAGE_TAG_PREFIX: &str = "@@image:";

    let mut result = String::with_capacity(content.len().min(FAILED_EXCHANGE_CONTENT_MAX_CHARS));
    let mut remaining = content;
    while let Some(tag_start) = remaining.find(IMAGE_TAG_PREFIX) {
        result.push_str(&remaining[..tag_start]);
        let value_start = tag_start + IMAGE_TAG_PREFIX.len();
        let value_and_rest = &remaining[value_start..];
        let Some(tag_end) = value_and_rest.find("@@") else {
            result.push_str(&remaining[tag_start..]);
            remaining = "";
            break;
        };
        let value = value_and_rest[..tag_end].trim();
        let full_tag_end = value_start + tag_end + 2;
        if value.starts_with("data:") && tag_end > FAILED_EXCHANGE_IMAGE_TAG_MAX_CHARS {
            result.push_str(&format!(
                "[image attachment omitted (~{} KB) after failed request]",
                tag_end / 1024
            ));
        } else {
            result.push_str(&remaining[tag_start..full_tag_end]);
        }
        remaining = &remaining[full_tag_end..];
    }
    result.push_str(remaining);

    if result.len() > FAILED_EXCHANGE_CONTENT_MAX_CHARS {
        let original_kb = result.len() / 1024;
        let mut end = FAILED_EXCHANGE_CONTENT_MAX_CHARS;
        while end > 0 && !result.is_char_boundary(end) {
            end -= 1;
        }
        result.truncate(end);
        result.push_str(&format!(
            "\n[...failed exchange content truncated, original ~{original_kb} KB...]"
        ));
    }
    result
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
    // 重试失败回合（子代理「重试」）：请求消息已随失败回合落库，本次不再重复写入，
    // 末尾的失败助手行由本次错误信息替换。允许请求消息为空。
    retry_failed_response: bool,
    error_message: &str,
) -> Result<(String, Vec<String>)> {
    let request_messages = request_messages
        .iter()
        .filter_map(|message| {
            let content = sanitize_failed_exchange_content(message.content.trim());
            (!content.is_empty()).then(|| ChatContextMessage {
                role: message.role.trim().to_string(),
                origin: message.origin.clone(),
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
    // empty. 重试失败回合同样允许空请求消息（上下文已在库内）。All other empty
    // requests are rejected.
    if request_messages.is_empty() && !resume_after_compaction && !retry_failed_response {
        return Err(Error::from_reason("Chat message content is required"));
    }

    let conversation_id =
        resolve_conversation_id(database_path, conversation_id, previous_response_id)?;
    // Request failures have no generated body. Store diagnostics separately so
    // both live rendering and history never confuse errors with assistant text.
    let raw_response_json = crate::failure::failure_raw_json(error_message);
    let response_content = "";

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
            retry_attempts: 0,
            retry_error: "",
            raw_response_json: &raw_response_json,
            token_usage: ChatTokenUsage::default(),
            response_thinking: "",
            response_thinking_blocks_json: "[]",
            response_thinking_duration_ms: 0,
            response_thinking_token_count: 0,
            tool_calls_json: "[]",
            directory_id,
            context_compaction: false,
            context_fold: None,
            total_duration_ms: 0,
            retry_failed_response,
        },
    )?
    .user_message_ids;

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

    // 工具结果可能内嵌图片 base64（如 filesystem-read 读取图片文件时返回
    // `@@image:data:...@@`，一张几 MB 的生成图就是上百万 token 的文本膨胀）。
    // 入库前落盘为 `@@image:upload/...@@` 短标签：数据库与后续请求的上下文
    // 不再被 base64 撑爆，视觉负载由 payload 层构建请求时从磁盘读回。
    let persisted_content = crate::media::persist_inline_images_to_disk(
        trimmed_content,
        database_path,
    )?;
    let trimmed_content = persisted_content.trim();

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
                None,
                0,
                0,
                "",
                ORIGIN_INTERNAL,
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
    token_usage: Option<ChatTokenUsage>,
    index: usize,
    // 自动重试次数（0 = 未重试）与最后一次重试的上游错误文本（空 = 无）。
    retry_attempts: i64,
    retry_error: &str,
    origin: &str,
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
           input_tokens,
           output_tokens,
           cache_creation_input_tokens,
           cache_read_input_tokens,
           retry_attempts,
           retry_error,
           origin,
           created_at
         ) VALUES (
           ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, datetime('now', 'localtime')
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
            token_usage.map(|usage| usage.input_tokens).unwrap_or(0),
            token_usage.map(|usage| usage.output_tokens).unwrap_or(0),
            token_usage
                .map(|usage| usage.cache_creation_input_tokens)
                .unwrap_or(0),
            token_usage
                .map(|usage| usage.cache_read_input_tokens)
                .unwrap_or(0),
            retry_attempts,
            retry_error,
            origin,
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
        api_profile_name: row.get(23)?,
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
        run_input_tokens: row.get(24)?,
        run_output_tokens: row.get(25)?,
        run_cache_creation_input_tokens: row.get(26)?,
        run_cache_read_input_tokens: row.get(27)?,
        last_run_duration_ms: row.get(28)?,
        run_ttft_sum_ms: row.get(29)?,
        run_request_count: row.get(30)?,
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
            // chip 标签折叠为人类可读文本（与侧边栏 pending 占位记录同一套
            // 展示语义），避免路径 / base64 / JSON 外壳污染标题。
            expand_display_tags_in_content(&message.content)
                .unwrap_or_else(|| message.content.clone())
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

pub fn create_chat_id(prefix: &str) -> String {
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
    pub responses_fast_mode: Option<String>,
}

/// Fast Mode tier codes stored in `chat_conversations.responses_fast_mode`:
/// NULL follows the API profile, 0 = off, 1 = fast (priority), 2 = ultrafast.
pub(crate) fn encode_responses_fast_mode(value: Option<&str>) -> Option<i64> {
    match value.map(str::trim) {
        Some("off") => Some(0),
        Some("fast") => Some(1),
        Some("ultrafast") => Some(2),
        _ => None,
    }
}

pub(crate) fn decode_responses_fast_mode(value: Option<i64>) -> Option<String> {
    match value {
        Some(0) => Some("off".to_string()),
        Some(1) => Some("fast".to_string()),
        Some(2) => Some("ultrafast".to_string()),
        _ => None,
    }
}

/// Replace both nullable runtime override columns as one complete snapshot.
/// `None` is intentionally bound as SQL NULL, so callers can explicitly clear
/// either override without inheriting the COALESCE semantics of ConversationModes.
pub fn set_conversation_runtime_config(
    database_path: &Path,
    conversation_id: &str,
    thinking_strength: Option<String>,
    responses_fast_mode: Option<String>,
) -> Result<()> {
    let normalized_thinking_strength = thinking_strength.and_then(|value| {
        let trimmed = value.trim().to_string();
        (!trimmed.is_empty()).then_some(trimmed)
    });
    let encoded_responses_fast_mode = encode_responses_fast_mode(responses_fast_mode.as_deref());

    database::open_connection(database_path)
        .and_then(|connection| {
            // 已删除 / 归档的会话（存在墓碑）不再按 upsert 重建会话行。
            connection.execute(
                "INSERT INTO chat_conversations (
                   id, conversation_id, thinking_strength, responses_fast_mode
                 )
                 SELECT ?1, ?2, ?3, ?4
                  WHERE NOT EXISTS (
                    SELECT 1 FROM deleted_conversations WHERE conversation_id = ?2
                  )
                 ON CONFLICT(conversation_id) DO UPDATE SET
                   thinking_strength = excluded.thinking_strength,
                   responses_fast_mode = excluded.responses_fast_mode",
                params![
                    database::create_snowflake_id(),
                    conversation_id,
                    normalized_thinking_strength,
                    encoded_responses_fast_mode,
                ],
            )?;
            Ok(())
        })
        .map_err(|error| {
            database::database_error(database_path, "set conversation runtime config", error)
        })
}

/// Per-conversation Goal/WorkTree/WorkFlow Mode overrides. `None` means the
/// conversation row does not exist and the caller follows the global default.
/// Rows whose stored flags are NULL (legacy data) are read as `Some(false)` —
/// NULL is synonymous with 0 (disabled).
#[derive(Clone, Copy, Debug, Default)]
pub struct ConversationModes {
    pub goal_mode: Option<bool>,
    pub worktree_mode: Option<bool>,
    pub workflow_mode: Option<bool>,
    pub goal_mode_token_budget: Option<i64>,
}

/// Read a conversation's Goal/WorkTree/WorkFlow Mode overrides. Returns an
/// all-`None` record when the conversation row does not exist.
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
                    "SELECT goal_mode, worktree_mode, workflow_mode, goal_mode_token_budget
                       FROM chat_conversations
                      WHERE conversation_id = ?1
                      LIMIT 1",
                    params![conversation_id],
                    |row| {
                        Ok(ConversationModes {
                            goal_mode: Some(
                                row.get::<_, Option<i64>>(0)?
                                    .map(|v| v != 0)
                                    .unwrap_or(false),
                            ),
                            worktree_mode: Some(
                                row.get::<_, Option<i64>>(1)?
                                    .map(|v| v != 0)
                                    .unwrap_or(false),
                            ),
                            workflow_mode: Some(
                                row.get::<_, Option<i64>>(2)?
                                    .map(|v| v != 0)
                                    .unwrap_or(false),
                            ),
                            goal_mode_token_budget: row.get::<_, Option<i64>>(3)?,
                        })
                    },
                )
                .optional()
        })
        .map(|record| record.unwrap_or_default())
        .map_err(|error| database::database_error(database_path, "get conversation modes", error))
}

/// Upsert a conversation's Goal/WorkTree/WorkFlow Mode overrides. Only the
/// columns whose value is `Some` are updated; `None` leaves the stored
/// override untouched.
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
    goal_mode: Option<bool>,
    worktree_mode: Option<bool>,
    workflow_mode: Option<bool>,
    goal_mode_token_budget: Option<i64>,
) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|connection| {
            // 已删除 / 归档的会话（存在墓碑）不再按 upsert 重建会话行。
            connection.execute(
                "INSERT INTO chat_conversations (
                   id, conversation_id, goal_mode, worktree_mode, workflow_mode, goal_mode_token_budget
                 )
                 SELECT ?1, ?2, ?3, ?4, ?5, ?6
                  WHERE NOT EXISTS (
                    SELECT 1 FROM deleted_conversations WHERE conversation_id = ?2
                  )
                 ON CONFLICT(conversation_id) DO UPDATE SET
                   goal_mode = COALESCE(excluded.goal_mode, chat_conversations.goal_mode),
                   worktree_mode = COALESCE(excluded.worktree_mode, chat_conversations.worktree_mode),
                   workflow_mode = COALESCE(excluded.workflow_mode, chat_conversations.workflow_mode),
                   goal_mode_token_budget = COALESCE(excluded.goal_mode_token_budget, chat_conversations.goal_mode_token_budget)",
                params![
                    database::create_snowflake_id(),
                    conversation_id,
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
    run_ttft_sum_ms: i64,
    run_request_count: i64,
) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|connection| {
            // run 结束时才写入：会话若已在运行期间被删除 / 归档（存在墓碑），
            // 丢弃这次统计而不是把会话行重建出来。
            connection.execute(
                "INSERT INTO chat_conversations (
                   id, conversation_id,
                   run_input_tokens, run_output_tokens,
                   run_cache_creation_input_tokens, run_cache_read_input_tokens,
                   last_run_duration_ms, run_ttft_sum_ms, run_request_count
                 )
                 SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
                  WHERE NOT EXISTS (
                    SELECT 1 FROM deleted_conversations WHERE conversation_id = ?2
                  )
                 ON CONFLICT(conversation_id) DO UPDATE SET
                   run_input_tokens = chat_conversations.run_input_tokens + excluded.run_input_tokens,
                   run_output_tokens = chat_conversations.run_output_tokens + excluded.run_output_tokens,
                   run_cache_creation_input_tokens = chat_conversations.run_cache_creation_input_tokens + excluded.run_cache_creation_input_tokens,
                   run_cache_read_input_tokens = chat_conversations.run_cache_read_input_tokens + excluded.run_cache_read_input_tokens,
                   last_run_duration_ms = chat_conversations.last_run_duration_ms + excluded.last_run_duration_ms,
                   run_ttft_sum_ms = chat_conversations.run_ttft_sum_ms + excluded.run_ttft_sum_ms,
                   run_request_count = chat_conversations.run_request_count + excluded.run_request_count,
                   updated_at = datetime('now', 'localtime')",
                params![
                    database::create_snowflake_id(),
                    conversation_id,
                    run_input_tokens,
                    run_output_tokens,
                    run_cache_creation_input_tokens,
                    run_cache_read_input_tokens,
                    last_run_duration_ms,
                    run_ttft_sum_ms,
                    run_request_count,
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
pub fn reset_conversation_run_stats(database_path: &Path, conversation_id: &str) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|connection| {
            connection.execute(
                "UPDATE chat_conversations
                    SET run_input_tokens = 0,
                        run_output_tokens = 0,
                        run_cache_creation_input_tokens = 0,
                        run_cache_read_input_tokens = 0,
                        last_run_duration_ms = 0,
                        run_ttft_sum_ms = 0,
                        run_request_count = 0,
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
