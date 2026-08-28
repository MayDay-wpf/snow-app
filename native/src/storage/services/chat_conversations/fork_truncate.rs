use std::path::Path;

use napi::bindgen_prelude::*;
use rusqlite::{params, OptionalExtension, TransactionBehavior};

use super::super::super::database;
use super::super::super::ChatConversationRecord;
use super::{create_chat_id, get_chat_conversation};

pub fn fork_conversation(
    database_path: &Path,
    source_conversation_id: &str,
    up_to_response_id: &str,
) -> Result<ChatConversationRecord> {
    let mut connection = database::open_connection(database_path)
    .map_err(|error| database::database_error(database_path, "fork conversation", error))?;

    // Reserve the write transaction before reading the source conversation.
    // A deferred transaction would first establish a read snapshot and then
    // upgrade on the first INSERT. If a concurrent writer commits between
    // those steps (e.g. a cancelled stream finishing its persist), WAL reports
    // SQLITE_BUSY_SNAPSHOT as "database is locked" even though that writer has
    // already committed. BEGIN IMMEDIATE waits at transaction start and
    // guarantees all following reads and inserts share one writable snapshot.
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| database::database_error(database_path, "fork conversation", error))?;

    // Load source conversation metadata
    let source = transaction
        .query_row(
            "SELECT conversation_id, title, summary, directory_id, model, last_message_preview, api_profile_name,
                    thinking_strength, responses_fast_mode
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
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, Option<i64>>(8)?.map(|value| value != 0),
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
           ?1, ?2, ?3, ?4, ?5, 0, ?6, ?7, ?8, ?9, '', 'active', ?10, ?11, 0, datetime('now', 'localtime'), datetime('now', 'localtime')
         )",
        params![
            new_id,
            new_conversation_id,
            source.1,  // title
            source.2,  // summary
            source.5,  // last_message_preview
            source.4,  // model
            source.6,  // api_profile_name
            source.7,  // thinking_strength
            source.8,  // responses_fast_mode
            source.3,  // directory_id
            source_conversation_id,
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
        Option<String>,
        Option<String>,
    )> = {
        let mut stmt = transaction
            .prepare(
                "SELECT message_id, role, content, model, response_id, status, raw_json, thinking, tool_calls_json,
                        interruption_reason, recovery_outcome
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
                    row.get(9)?,
                    row.get(10)?,
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
               interruption_reason,
               recovery_outcome,
               created_at
             ) VALUES (
               ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, datetime('now', 'localtime')
             )",
                params![
                    database::create_snowflake_id(),
                    create_chat_id(&format!("msg{index}")),
                    new_conversation_id,
                    &msg.1,  // role
                    &msg.2,  // content
                    &msg.3,  // model
                    &msg.4,  // response_id
                    &msg.5,  // status
                    &msg.6,  // raw_json
                    &msg.7,  // thinking
                    &msg.8,  // tool_calls_json
                    &msg.9,  // interruption_reason
                    &msg.10, // recovery_outcome
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
        preceding_request_id(database_path, &transaction, conversation_id, &target_id)?
            .unwrap_or_else(|| target_id.clone())
    };

    truncate_conversation_from_id(database_path, &transaction, conversation_id, &delete_from)?;

    transaction
        .commit()
        .map_err(|error| database::database_error(database_path, "truncate conversation", error))?;

    Ok(())
}

/// Truncate a conversation starting from a persisted message id. This is the
/// rollback boundary for exchanges whose assistant row carries no usable
/// `response_id` — most importantly failed turns, where the persisted user
/// message id is the only reliable anchor for the exchange (the failed
/// assistant row stores an empty response_id).
///
/// When the referenced row is a normal assistant message, its preceding
/// request row is included in the truncation (mirroring
/// `truncate_conversation_from_response`); otherwise (user message, failed
/// exchange user row, or context-compaction boundary) the row itself and
/// everything after it is deleted. No-op when the id does not exist in the
/// conversation (idempotent).
pub fn truncate_conversation_from_message(
    database_path: &Path,
    conversation_id: &str,
    message_id: &str,
) -> Result<()> {
    let mut connection = database::open_connection(database_path)
        .map_err(|error| database::database_error(database_path, "truncate conversation", error))?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| database::database_error(database_path, "truncate conversation", error))?;

    let target: Option<(String, String, String)> = transaction
        .query_row(
            "SELECT id, role, status FROM chat_messages
              WHERE conversation_id = ?1 AND id = ?2
              LIMIT 1",
            params![conversation_id, message_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|error| database::database_error(database_path, "truncate conversation", error))?;

    let (target_id, target_role, target_status) = match target {
        Some(target) => target,
        None => return Ok(()),
    };

    let delete_from = if target_role == "assistant" && target_status != "context_compaction" {
        // An assistant row (only reachable when the caller passed an assistant
        // id) must include its preceding request row.
        preceding_request_id(database_path, &transaction, conversation_id, &target_id)?
            .unwrap_or_else(|| target_id.clone())
    } else {
        // User rows — including failed-exchange user messages — and
        // context-compaction boundaries are deleted from their own id.
        target_id.clone()
    };

    truncate_conversation_from_id(database_path, &transaction, conversation_id, &delete_from)?;

    transaction
        .commit()
        .map_err(|error| database::database_error(database_path, "truncate conversation", error))?;

    Ok(())
}

/// Collect workflow node conversation ids whose flow's workflow-generate tool
/// call lives in the truncated message range. The flow id persisted in
/// `workflow_node_sessions.flow_id` is `tool-{callId}` (renderer derives it
/// from the LLM tool call id), so the callId is extracted from the persisted
/// `tool_calls_json` here — the JSON disappears together with the message,
/// hence this must run before the message DELETE.
fn collect_truncated_workflow_node_ids(
    transaction: &rusqlite::Transaction<'_>,
    conversation_id: &str,
    delete_from: &str,
) -> rusqlite::Result<Vec<String>> {
    let mut statement = transaction.prepare(
        "SELECT tool_calls_json FROM chat_messages
          WHERE conversation_id = ?1 AND id >= ?2
            AND tool_calls_json LIKE '%workflow-generate%'",
    )?;
    let tool_calls_rows = statement
        .query_map(params![conversation_id, delete_from], |row| {
            row.get::<_, String>(0)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut flow_ids: Vec<String> = Vec::new();
    for tool_calls_json in tool_calls_rows {
        let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&tool_calls_json) else {
            continue;
        };
        let Some(entries) = parsed.as_array() else {
            continue;
        };
        for entry in entries {
            let Some(entry_object) = entry.as_object() else {
                continue;
            };
            // tool_calls_json 条目存在两种形态：顶层 {name, call_id|id} 与
            // provider 包装 {function: {name, arguments}, id}（OpenAI Responses
            // 持久化形态）。name 与 callId 都要同时兼容两种嵌套，否则提取
            // 不到 flow id，节点会话将随截断残留为孤儿。
            let name = ["name"]
                .iter()
                .find_map(|key| entry_object.get(*key).and_then(|value| value.as_str()))
                .or_else(|| {
                    ["function", "function_call", "functionCall"]
                        .iter()
                        .find_map(|wrapper| {
                            entry_object
                                .get(*wrapper)
                                .and_then(|value| value.get("name"))
                                .and_then(|value| value.as_str())
                        })
                })
                .unwrap_or("");
            if !name.ends_with("workflow-generate") {
                continue;
            }
            let call_id = ["call_id", "callId", "id"]
                .iter()
                .find_map(|key| entry_object.get(*key).and_then(|value| value.as_str()))
                .or_else(|| {
                    ["function", "function_call", "functionCall"]
                        .iter()
                        .find_map(|wrapper| {
                            entry_object
                                .get(*wrapper)
                                .and_then(|value| value.as_object())
                                .and_then(|function| {
                                    ["call_id", "callId", "id"]
                                        .iter()
                                        .find_map(|key| {
                                            function.get(*key).and_then(|value| value.as_str())
                                        })
                                })
                        })
                })
                .unwrap_or("");
            if call_id.is_empty() {
                continue;
            }
            let flow_id = format!("tool-{call_id}");
            if !flow_ids.contains(&flow_id) {
                flow_ids.push(flow_id);
            }
        }
    }
    if flow_ids.is_empty() {
        return Ok(Vec::new());
    }

    let mut node_ids: Vec<String> = Vec::new();
    for flow_id in &flow_ids {
        let mut statement = transaction.prepare(
            "SELECT conversation_id FROM workflow_node_sessions
              WHERE parent_conversation_id = ?1 AND flow_id = ?2",
        )?;
        let rows = statement
            .query_map(params![conversation_id, flow_id], |row| {
                row.get::<_, String>(0)
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for node_id in rows {
            if !node_ids.contains(&node_id) {
                node_ids.push(node_id);
            }
        }
    }
    Ok(node_ids)
}

/// Locate the request row (response_id = '') immediately before the given
/// message id. Returns `None` when no such row exists.
fn preceding_request_id(
    database_path: &Path,
    transaction: &rusqlite::Transaction<'_>,
    conversation_id: &str,
    target_id: &str,
) -> Result<Option<String>> {
    transaction
        .query_row(
            "SELECT id FROM chat_messages
              WHERE conversation_id = ?1 AND id < ?2 AND response_id = ''
              ORDER BY id DESC
              LIMIT 1",
            params![conversation_id, target_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| database::database_error(database_path, "truncate conversation", error))
}

/// Delete the exchange starting at `delete_from` (todo items, messages, and
/// conversation metadata refresh). Runs inside the caller's write transaction.
fn truncate_conversation_from_id(
    database_path: &Path,
    transaction: &rusqlite::Transaction<'_>,
    conversation_id: &str,
    delete_from: &str,
) -> Result<()> {
    // 被截断范围内的 workflow-generate 工具调用对应的 flow 节点会话随截断
    // 级联删除：flow 卡片是节点会话的唯一入口，卡片删除后重新执行 flow 会
    // 生成新的 flowId，旧节点会话将永远成为孤儿。必须在删除消息之前收集
    // （tool_calls_json 随消息一起消失）。
    let truncated_node_ids = collect_truncated_workflow_node_ids(
        transaction,
        conversation_id,
        delete_from,
    )
    .map_err(|error| {
        database::database_error(database_path, "collect truncated workflow nodes", error)
    })?;

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
        .map_err(|error| database::database_error(database_path, "delete chat messages", error))?;

    // 级联删除 flow 节点会话：真实主会话，消息/todo/bookkeeping/会话行一并清理。
    for node_conversation_id in &truncated_node_ids {
        transaction
            .execute(
                "DELETE FROM todo_items WHERE session_id = ?1",
                params![node_conversation_id],
            )
            .map_err(|error| {
                database::database_error(database_path, "delete workflow node todo items", error)
            })?;
        transaction
            .execute(
                "DELETE FROM workflow_node_sessions WHERE conversation_id = ?1",
                params![node_conversation_id],
            )
            .map_err(|error| {
                database::database_error(database_path, "delete workflow node sessions", error)
            })?;
        transaction
            .execute(
                "DELETE FROM chat_messages WHERE conversation_id = ?1",
                params![node_conversation_id],
            )
            .map_err(|error| {
                database::database_error(database_path, "delete workflow node messages", error)
            })?;
        transaction
            .execute(
                "DELETE FROM chat_conversations WHERE conversation_id = ?1",
                params![node_conversation_id],
            )
            .map_err(|error| {
                database::database_error(database_path, "delete workflow node conversation", error)
            })?;
    }

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

    Ok(())
}

pub(crate) fn find_conversation_id_by_response_id(
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

pub(crate) fn conversation_exists(database_path: &Path, conversation_id: &str) -> Result<bool> {
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
