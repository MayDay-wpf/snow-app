use std::collections::HashSet;
use std::fs;
use std::path::Path;

use napi::bindgen_prelude::*;
use rusqlite::{
    params, params_from_iter, OptionalExtension, ToSql, TransactionBehavior,
};

use super::super::super::database;
use super::super::super::{ChatMessagePage, ChatMessageRecord, UserMessageSummary};
use super::in_clause_placeholders;

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

    // WorkFlow 节点会话与子代理会话同级：是绑定到父会话的真实主会话，
    // 删除父会话时必须级联删除，否则侧边栏残留孤儿 wf- 会话。
    let workflow_child_ids = {
        let mut statement = transaction
            .prepare(
                "SELECT conversation_id
                   FROM workflow_node_sessions
                  WHERE parent_conversation_id = ?1",
            )
            .map_err(|error| {
                database::database_error(database_path, "list workflow node sessions", error)
            })?;
        let rows = statement
            .query_map(params![conversation_id], |row| row.get::<_, String>(0))
            .map_err(|error| {
                database::database_error(database_path, "list workflow node sessions", error)
            })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| {
                database::database_error(database_path, "list workflow node sessions", error)
            })?
    };
    conversation_ids.extend(workflow_child_ids);

    // 删除前收集消息中内联图片标签路径（`@@image:upload/...@@`），
    // 供提交后清理不再被任何消息引用的孤儿文件
    let upload_paths = collect_inline_upload_paths(&transaction, &conversation_ids).map_err(
        |error| database::database_error(database_path, "scan inline upload images", error),
    )?;

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

    // 删除 workflow 节点 bookkeeping 行：父会话自身被删时按 parent 匹配，
    // 被删目标本身是节点会话时按 conversation_id 匹配。
    transaction
        .execute(
            "DELETE FROM workflow_node_sessions
              WHERE parent_conversation_id = ?1 OR conversation_id = ?1",
            params![conversation_id],
        )
        .map_err(|error| {
            database::database_error(database_path, "delete workflow node sessions", error)
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

    // 清理不再被任何消息引用的内联图片文件（失败仅产生孤儿文件，不阻断删除）
    cleanup_orphan_upload_files(&connection, database_path, &upload_paths);

    Ok(())
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

    // WorkFlow 节点会话与子代理会话同级，随父会话级联删除。
    {
        let placeholders = in_clause_placeholders(unique_ids.len());
        let mut statement = transaction
            .prepare(&format!(
                "SELECT conversation_id
                   FROM workflow_node_sessions
                  WHERE parent_conversation_id IN ({placeholders})"
            ))
            .map_err(|error| {
                database::database_error(database_path, "list workflow node sessions", error)
            })?;
        let rows = statement
            .query_map(params_from_iter(unique_ids.iter()), |row| {
                row.get::<_, String>(0)
            })
            .map_err(|error| {
                database::database_error(database_path, "list workflow node sessions", error)
            })?;
        for child_id in rows {
            let child_id = child_id.map_err(|error| {
                database::database_error(database_path, "list workflow node sessions", error)
            })?;
            if !all_target_ids.contains(&child_id) {
                all_target_ids.push(child_id);
            }
        }
    }

    // 删除前收集消息中内联图片标签路径，供提交后清理孤儿文件
    let upload_paths = collect_inline_upload_paths(&transaction, &all_target_ids).map_err(
        |error| database::database_error(database_path, "scan inline upload images", error),
    )?;

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

    // 删除 workflow 节点 bookkeeping 行：父会话按 parent 匹配，
    // 被删目标本身是节点会话时按 conversation_id 匹配。
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
                    "DELETE FROM workflow_node_sessions
                      WHERE parent_conversation_id IN ({placeholders})
                         OR conversation_id IN ({placeholders})"
                ),
                params_from_iter(params),
            )
            .map_err(|error| {
                database::database_error(database_path, "delete workflow node sessions", error)
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

    // 清理不再被任何消息引用的内联图片文件（失败仅产生孤儿文件，不阻断删除）
    cleanup_orphan_upload_files(&connection, database_path, &upload_paths);

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
                        interruption_reason,
                        recovery_outcome,
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
                    interruption_reason: row.get(9)?,
                    recovery_outcome: row.get(10)?,
                    created_at: row.get(11)?,
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
                        interruption_reason,
                        recovery_outcome,
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
                        interruption_reason: row.get(9)?,
                        recovery_outcome: row.get(10)?,
                        created_at: row.get(11)?,
                    })
                },
            )?;

            let mut items: Vec<ChatMessageRecord> = rows.collect::<rusqlite::Result<Vec<_>>>()?;
            let has_more = items.len() > safe_limit as usize;
            if has_more {
                items.truncate(safe_limit as usize);
            }
            items.reverse();

            let checkpoint_ids = {
                let mut checkpoint_statement = connection.prepare(
                    "SELECT checkpoint_id
                       FROM chat_messages
                      WHERE conversation_id = ?1
                        AND role = 'user'
                        AND checkpoint_id != ''
                      ORDER BY id ASC",
                )?;
                let rows = checkpoint_statement.query_map(params![conversation_id], |row| {
                    row.get::<_, String>(0)
                })?;
                let mut seen = HashSet::new();
                rows.collect::<rusqlite::Result<Vec<_>>>()?
                    .into_iter()
                    .filter(|checkpoint_id| seen.insert(checkpoint_id.clone()))
                    .collect()
            };

            Ok(ChatMessagePage {
                items,
                total,
                has_more,
                checkpoint_ids,
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

/// 收集消息中的内联图片标签路径（`@@image:upload/...@@`），去重。
/// 仅匹配 `upload/` 前缀标签；图库图片标签（`@@image:image/...@@`）由
/// image_library 的级联删除单独处理。
fn collect_inline_upload_paths(
    connection: &rusqlite::Connection,
    conversation_ids: &[String],
) -> rusqlite::Result<Vec<String>> {
    const TAG_PREFIX: &str = "@@image:upload/";
    let mut paths: Vec<String> = Vec::new();
    for conversation_id in conversation_ids {
        let mut statement = connection.prepare(
            "SELECT content
               FROM chat_messages
              WHERE conversation_id = ?1
                AND content LIKE '%@@image:upload/%@@%'",
        )?;
        let rows = statement.query_map(params![conversation_id], |row| {
            row.get::<_, String>(0)
        })?;
        for row in rows {
            let content = row?;
            let mut rest = content.as_str();
            while let Some(tag_start) = rest.find(TAG_PREFIX) {
                let value_start = tag_start + TAG_PREFIX.len();
                let value_and_rest = &rest[value_start..];
                let Some(tag_end) = value_and_rest.find("@@") else {
                    break;
                };
                let relative = format!("upload/{}", &value_and_rest[..tag_end]);
                if !paths.contains(&relative) {
                    paths.push(relative);
                }
                rest = &value_and_rest[tag_end + 2..];
            }
        }
    }
    Ok(paths)
}

/// 删除不再被任何消息引用的内联图片文件（孤儿清理）。
/// 引用检查与物理删除失败仅记录日志，不阻断会话删除。
fn cleanup_orphan_upload_files(
    connection: &rusqlite::Connection,
    database_path: &Path,
    relative_paths: &[String],
) {
    if relative_paths.is_empty() {
        return;
    }
    let Some(parent) = database_path.parent() else {
        return;
    };
    let upload_root = parent.join("upload");
    let Ok(canonical_root) = upload_root.canonicalize() else {
        return;
    };
    for relative in relative_paths {
        // 仍被其他会话消息引用则保留
        let like_pattern = format!("%@@image:{}@@%", relative);
        let referenced: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM chat_messages WHERE content LIKE ?1)",
                params![like_pattern],
                |row| row.get(0),
            )
            .unwrap_or(false);
        if referenced {
            continue;
        }
        // 防路径穿越：解析后必须仍位于 upload 根目录内
        let file_path = parent.join(relative);
        let Ok(canonical_file) = file_path.canonicalize() else {
            continue;
        };
        if canonical_file.starts_with(&canonical_root) {
            let _ = fs::remove_file(&canonical_file);
        }
    }
}
