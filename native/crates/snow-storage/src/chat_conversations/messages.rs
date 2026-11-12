use std::collections::HashSet;
use std::fs;
use std::path::Path;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use rusqlite::{
    params, params_from_iter, OptionalExtension, ToSql, TransactionBehavior,
};
use serde_json::Value;

use snow_storage_core::database;
use snow_storage_core::models::{ChatMessagePage, ChatMessageRecord};
use super::in_clause_placeholders;

/// 单条用户消息的精简摘要（会话左侧导航栏使用）。
#[derive(Clone, Debug)]
#[napi(object)]
pub struct UserMessageSummary {
    pub id: String,
    pub content: String,
    pub created_at: String,
    pub is_context_compaction: bool,
}

/// SQLite 默认变量数上限为 999，分块执行避免超出。
const MAX_VARIABLES: usize = 400;

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

pub fn delete_conversation(database_path: &Path, conversation_id: &str, delete_memories: bool) -> Result<()> {
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
    let mut conversation_ids = super::guard_sub_agent_physical_delete(
        &transaction, &[conversation_id.to_string()],
    )?;
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
    conversation_ids.extend(workflow_child_ids.clone());

    // WorkFlow 节点会话运行期间派生的子代理：随节点会话一并级联删除
    if !workflow_child_ids.is_empty() {
        let placeholders = in_clause_placeholders(workflow_child_ids.len());
        let node_sub_agent_ids = {
            let mut statement = transaction
                .prepare(&format!(
                    "SELECT conversation_id
                       FROM sub_agent_sessions
                      WHERE parent_conversation_id IN ({placeholders})"
                ))
                .map_err(|error| {
                    database::database_error(database_path, "list workflow node sub-agents", error)
                })?;
            let rows = statement
                .query_map(params_from_iter(workflow_child_ids.iter()), |row| {
                    row.get::<_, String>(0)
                })
                .map_err(|error| {
                    database::database_error(database_path, "list workflow node sub-agents", error)
                })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .map_err(|error| {
                    database::database_error(database_path, "list workflow node sub-agents", error)
                })?
        };
        conversation_ids.extend(node_sub_agent_ids);
    }

    let mut seen_targets = HashSet::new();
    conversation_ids.retain(|id| seen_targets.insert(id.clone()));

    // 删除前收集消息中内联图片标签路径（`@@image:upload/...@@`），
    // 供提交后清理不再被任何消息引用的孤儿文件
    let upload_paths = collect_inline_upload_paths(&transaction, &conversation_ids).map_err(
        |error| database::database_error(database_path, "scan inline upload images", error),
    )?;

    // 删除前收集全部 checkpoint id（消息级 + flow 级），供提交后清理快照文件；
    // 收集失败不阻断删除（最多残留孤儿目录）
    let checkpoint_ids =
        collect_conversation_checkpoint_ids(&transaction, &conversation_ids).unwrap_or_default();

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

    // 会话删除联动（Project Memory）：用户在删除确认弹窗勾选「同时删除
    // 记忆」时，把该会话（含级联子代理 / workflow 节点会话）保存的项目
    // 记忆一并删除；默认保留——记忆是项目级知识资产，不随来源会话消失。
    if delete_memories {
        crate::project_memories::delete_memories_by_conversation_ids(
            &transaction,
            &conversation_ids,
        )
        .map_err(|error| {
            database::database_error(database_path, "delete project memories", error)
        })?;
    }

    // 记忆注入快照属于会话自身（与「同时删除记忆」选项无关）：无条件随
    // 会话一并清理，避免残留行。
    crate::project_memories::delete_prompt_snapshots(&transaction, &conversation_ids)
        .map_err(|error| {
            database::database_error(database_path, "delete memory prompt snapshots", error)
        })?;

    // 系统提示词冻结快照（ROLE.md / API 档案系统提示词）同样属于会话自身：
    // 无条件随会话一并清理。
    crate::system_prompt_snapshots::delete_snapshots(&transaction, &conversation_ids)
        .map_err(|error| {
            database::database_error(database_path, "delete system prompt snapshots", error)
        })?;

    // 清理子代理与 workflow 节点 bookkeeping 行：覆盖全部级联目标
    // （父会话、直接子代理、workflow 节点、节点派生的子代理）。
    if !conversation_ids.is_empty() {
        let placeholders = in_clause_placeholders(conversation_ids.len());
        let params: Vec<&dyn ToSql> =
            conversation_ids.iter().map(|id| id as &dyn ToSql).collect();
        transaction
            .execute(
                &format!(
                    "DELETE FROM sub_agent_sessions WHERE conversation_id IN ({placeholders})"
                ),
                params_from_iter(params.iter().copied()),
            )
            .map_err(|error| {
                database::database_error(database_path, "delete sub-agent sessions", error)
            })?;
        transaction
            .execute(
                &format!(
                    "DELETE FROM workflow_node_sessions WHERE conversation_id IN ({placeholders})"
                ),
                params_from_iter(params.iter().copied()),
            )
            .map_err(|error| {
                database::database_error(database_path, "delete workflow node sessions", error)
            })?;
        // WorkFlow run 级状态与画布按父会话归属：父会话（含节点会话）删除时
        // 一并清理，避免残留 run 记录让卡片恢复出"幽灵 running"。
        transaction
            .execute(
                &format!(
                    "DELETE FROM workflow_runs WHERE parent_conversation_id IN ({placeholders})"
                ),
                params_from_iter(params.iter().copied()),
            )
            .map_err(|error| {
                database::database_error(database_path, "delete workflow runs", error)
            })?;
        transaction
            .execute(
                &format!(
                    "DELETE FROM workflow_canvases WHERE parent_conversation_id IN ({placeholders})"
                ),
                params_from_iter(params.iter().copied()),
            )
            .map_err(|error| {
                database::database_error(database_path, "delete workflow canvases", error)
            })?;
    }

    for target_id in conversation_ids.iter().rev() {
        transaction
            .execute(
                "DELETE FROM conversation_worktree_bindings WHERE conversation_id = ?1",
                params![target_id],
            )
            .ok();
        transaction
            .execute(
                "DELETE FROM chat_conversations WHERE conversation_id = ?1",
                params![target_id],
            )
            .map_err(|error| {
                database::database_error(database_path, "delete conversation", error)
            })?;
    }

    // 登记墓碑：仍在收尾的回合（含子代理 / WorkFlow 节点）迟到的持久化
    // 据此丢弃，避免把刚删除的会话行重建出来。
    super::record_conversation_tombstones(&transaction, &conversation_ids)
        .map_err(|error| database::database_error(database_path, "delete conversation", error))?;

    transaction
        .commit()
        .map_err(|error| database::database_error(database_path, "delete conversation", error))?;

    // 清理不再被任何消息引用的内联图片文件（失败仅产生孤儿文件，不阻断删除）
    cleanup_orphan_upload_files(&connection, database_path, &upload_paths);

    // 清理不再被任何会话引用的 checkpoint 快照目录（失败仅产生孤儿目录，不阻断删除）
    cleanup_orphan_checkpoint_files(&checkpoint_ids);

    Ok(())
}

/// 批量删除会话，语义与单条 [delete_conversation] 完全一致：
/// 选中父会话时其直接子代理会话随级联删除，消息与 todo 一并清理。
/// 与逐条删除相比，只打开一次数据库、使用单个事务，避免 N+1 查询。
pub fn delete_conversations(
    database_path: &Path,
    conversation_ids: &[String],
    delete_memories: bool,
) -> Result<()> {
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
    let mut all_target_ids = super::guard_sub_agent_physical_delete(&transaction, &unique_ids)?;
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

    // WorkFlow 节点会话运行期间派生的子代理：随节点会话一并级联删除
    {
        let workflow_node_ids: Vec<String> = all_target_ids
            .iter()
            .filter(|id| !unique_ids.contains(id))
            .cloned()
            .collect();
        if !workflow_node_ids.is_empty() {
            let placeholders = in_clause_placeholders(workflow_node_ids.len());
            let mut statement = transaction
                .prepare(&format!(
                    "SELECT conversation_id
                       FROM sub_agent_sessions
                      WHERE parent_conversation_id IN ({placeholders})"
                ))
                .map_err(|error| {
                    database::database_error(database_path, "list workflow node sub-agents", error)
                })?;
            let rows = statement
                .query_map(params_from_iter(workflow_node_ids.iter()), |row| {
                    row.get::<_, String>(0)
                })
                .map_err(|error| {
                    database::database_error(database_path, "list workflow node sub-agents", error)
                })?;
            for child_id in rows {
                let child_id = child_id.map_err(|error| {
                    database::database_error(database_path, "list workflow node sub-agents", error)
                })?;
                if !all_target_ids.contains(&child_id) {
                    all_target_ids.push(child_id);
                }
            }
        }
    }

    // 删除前收集消息中内联图片标签路径，供提交后清理孤儿文件
    let upload_paths = collect_inline_upload_paths(&transaction, &all_target_ids).map_err(
        |error| database::database_error(database_path, "scan inline upload images", error),
    )?;

    // 删除前收集全部 checkpoint id（消息级 + flow 级），供提交后清理快照文件；
    // 收集失败不阻断删除（最多残留孤儿目录）
    let checkpoint_ids =
        collect_conversation_checkpoint_ids(&transaction, &all_target_ids).unwrap_or_default();

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

    // 会话删除联动（Project Memory）：与单条删除一致，仅在用户勾选
    // 「同时删除记忆」时把全部级联目标保存的项目记忆一并删除。
    if delete_memories {
        crate::project_memories::delete_memories_by_conversation_ids(
            &transaction,
            &all_target_ids,
        )
        .map_err(|error| {
            database::database_error(database_path, "delete project memories", error)
        })?;
    }

    // 记忆注入快照属于会话自身（与「同时删除记忆」选项无关）：无条件随
    // 会话一并清理，避免残留行。
    crate::project_memories::delete_prompt_snapshots(&transaction, &all_target_ids)
        .map_err(|error| {
            database::database_error(database_path, "delete memory prompt snapshots", error)
        })?;

    // 系统提示词冻结快照（ROLE.md / API 档案系统提示词）同样属于会话自身：
    // 无条件随会话一并清理。
    crate::system_prompt_snapshots::delete_snapshots(&transaction, &all_target_ids)
        .map_err(|error| {
            database::database_error(database_path, "delete system prompt snapshots", error)
        })?;

    // 删除子代理会话关联行：覆盖全部级联目标（父会话、子代理、
    // workflow 节点、节点派生的子代理）。
    for chunk in all_target_ids.chunks(MAX_VARIABLES) {
        let placeholders = in_clause_placeholders(chunk.len());
        transaction
            .execute(
                &format!(
                    "DELETE FROM sub_agent_sessions WHERE conversation_id IN ({placeholders})"
                ),
                params_from_iter(chunk.iter()),
            )
            .map_err(|error| {
                database::database_error(database_path, "delete sub-agent sessions", error)
            })?;
    }

    // 删除 workflow 节点 bookkeeping 行：覆盖全部级联目标
    for chunk in all_target_ids.chunks(MAX_VARIABLES) {
        let placeholders = in_clause_placeholders(chunk.len());
        transaction
            .execute(
                &format!(
                    "DELETE FROM workflow_node_sessions WHERE conversation_id IN ({placeholders})"
                ),
                params_from_iter(chunk.iter()),
            )
            .map_err(|error| {
                database::database_error(database_path, "delete workflow node sessions", error)
            })?;
        // WorkFlow run 级状态与画布按父会话归属：随父会话（含节点会话）
        // 批量删除一并清理，避免残留记录让卡片恢复出"幽灵 running"。
        transaction
            .execute(
                &format!(
                    "DELETE FROM workflow_runs WHERE parent_conversation_id IN ({placeholders})"
                ),
                params_from_iter(chunk.iter()),
            )
            .map_err(|error| {
                database::database_error(database_path, "delete workflow runs", error)
            })?;
        transaction
            .execute(
                &format!(
                    "DELETE FROM workflow_canvases WHERE parent_conversation_id IN ({placeholders})"
                ),
                params_from_iter(chunk.iter()),
            )
            .map_err(|error| {
                database::database_error(database_path, "delete workflow canvases", error)
            })?;
    }

    for chunk in all_target_ids.chunks(MAX_VARIABLES) {
        let placeholders = in_clause_placeholders(chunk.len());
        transaction
            .execute(
                &format!(
                    "DELETE FROM conversation_worktree_bindings WHERE conversation_id IN ({placeholders})"
                ),
                params_from_iter(chunk.iter()),
            )
            .ok();
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

    // 登记墓碑：覆盖全部级联目标，与单条删除一致。
    super::record_conversation_tombstones(&transaction, &all_target_ids)
        .map_err(|error| database::database_error(database_path, "delete conversations", error))?;

    transaction
        .commit()
        .map_err(|error| database::database_error(database_path, "delete conversations", error))?;

    // 清理不再被任何消息引用的内联图片文件（失败仅产生孤儿文件，不阻断删除）
    cleanup_orphan_upload_files(&connection, database_path, &upload_paths);

    // 清理不再被任何会话引用的 checkpoint 快照目录（失败仅产生孤儿目录，不阻断删除）
    cleanup_orphan_checkpoint_files(&checkpoint_ids);

    Ok(())
}

/// Replace the arguments of one tool call inside the persisted assistant
/// `tool_calls_json` of a response.
///
/// The stored JSON keeps whichever provider-native shape produced it, so only
/// the arguments field of the matching call is rewritten. The call id and the
/// rest of the payload stay byte-identical, which keeps later provider
/// round-trips valid.
pub fn update_tool_call_arguments(
    database_path: &Path,
    conversation_id: &str,
    response_id: &str,
    call_id: &str,
    arguments_json: &str,
) -> Result<bool> {
    let normalized_call_id = call_id.trim();
    if normalized_call_id.is_empty() {
        return Ok(false);
    }

    let arguments: Value = serde_json::from_str(arguments_json).map_err(|error| {
        Error::new(
            Status::InvalidArg,
            format!("Corrected tool arguments are not valid JSON: {}", error),
        )
    })?;
    if !arguments.is_object() {
        return Err(Error::new(
            Status::InvalidArg,
            "Corrected tool arguments must be a JSON object.",
        ));
    }

    let mut connection = database::open_connection(database_path).map_err(|error| {
        database::database_error(database_path, "update tool call arguments", error)
    })?;
    // IMMEDIATE serializes concurrent corrections of parallel tool calls:
    // each read-modify-write must observe the previous correction.
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| {
            database::database_error(database_path, "update tool call arguments", error)
        })?;

    let row = transaction
        .query_row(
            "SELECT id, tool_calls_json
               FROM chat_messages
              WHERE conversation_id = ?1
                AND response_id = ?2
                AND role = 'assistant'
                AND tool_calls_json NOT IN ('', '[]')
              ORDER BY id DESC
              LIMIT 1",
            params![conversation_id, response_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|error| {
            database::database_error(database_path, "update tool call arguments", error)
        })?;
    let Some((message_id, raw)) = row else {
        return Ok(false);
    };

    let Ok(mut tool_calls) = serde_json::from_str::<Vec<Value>>(&raw) else {
        return Ok(false);
    };
    let Some(tool_call) = tool_calls
        .iter_mut()
        .find(|tool_call| tool_call_id(tool_call) == Some(normalized_call_id))
    else {
        return Ok(false);
    };
    if !replace_tool_call_arguments(tool_call, arguments) {
        return Ok(false);
    }

    let serialized = serde_json::to_string(&tool_calls).map_err(|error| {
        Error::from_reason(format!(
            "Failed to serialize corrected tool calls: {}",
            error
        ))
    })?;
    transaction
        .execute(
            "UPDATE chat_messages SET tool_calls_json = ?2 WHERE id = ?1",
            params![message_id, serialized],
        )
        .map_err(|error| {
            database::database_error(database_path, "update tool call arguments", error)
        })?;
    transaction.commit().map_err(|error| {
        database::database_error(database_path, "update tool call arguments", error)
    })?;
    Ok(true)
}

/// Persist (or clear) the correction-agent state of one tool call inside the
/// persisted assistant message of a response.
///
/// The column holds a JSON object keyed by tool call id, so several parallel
/// tool calls of the same response keep separate correction trees. An empty
/// `correction_json` removes the entry. The data is only used by the history
/// replay of the correction tree and never sent to the provider.
pub fn update_tool_call_correction(
    database_path: &Path,
    conversation_id: &str,
    response_id: &str,
    call_id: &str,
    correction_json: &str,
) -> Result<bool> {
    let normalized_call_id = call_id.trim();
    if normalized_call_id.is_empty() {
        return Ok(false);
    }

    let correction = if correction_json.trim().is_empty() {
        None
    } else {
        let parsed: Value = serde_json::from_str(correction_json).map_err(|error| {
            Error::new(
                Status::InvalidArg,
                format!("Tool correction state is not valid JSON: {}", error),
            )
        })?;
        if !parsed.is_object() {
            return Err(Error::new(
                Status::InvalidArg,
                "Tool correction state must be a JSON object.",
            ));
        }
        Some(parsed)
    };

    let mut connection = database::open_connection(database_path).map_err(|error| {
        database::database_error(database_path, "update tool call correction", error)
    })?;
    // IMMEDIATE serializes concurrent corrections of parallel tool calls: each
    // read-modify-write must observe the previous entry of the same response.
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| {
            database::database_error(database_path, "update tool call correction", error)
        })?;

    let row = transaction
        .query_row(
            "SELECT id, tool_corrections_json
               FROM chat_messages
              WHERE conversation_id = ?1
                AND response_id = ?2
                AND role = 'assistant'
                AND tool_calls_json NOT IN ('', '[]')
              ORDER BY id DESC
              LIMIT 1",
            params![conversation_id, response_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|error| {
            database::database_error(database_path, "update tool call correction", error)
        })?;
    let Some((message_id, raw)) = row else {
        return Ok(false);
    };

    let mut corrections = serde_json::from_str::<serde_json::Map<String, Value>>(&raw)
        .unwrap_or_default();
    match correction {
        Some(value) => {
            corrections.insert(normalized_call_id.to_string(), value);
        }
        None => {
            corrections.remove(normalized_call_id);
        }
    }

    let serialized = serde_json::to_string(&Value::Object(corrections)).map_err(|error| {
        Error::from_reason(format!(
            "Failed to serialize tool correction state: {}",
            error
        ))
    })?;
    transaction
        .execute(
            "UPDATE chat_messages SET tool_corrections_json = ?2 WHERE id = ?1",
            params![message_id, serialized],
        )
        .map_err(|error| {
            database::database_error(database_path, "update tool call correction", error)
        })?;
    transaction.commit().map_err(|error| {
        database::database_error(database_path, "update tool call correction", error)
    })?;
    Ok(true)
}

fn tool_call_id(tool_call: &Value) -> Option<&str> {
    tool_call
        .get("call_id")
        .and_then(Value::as_str)
        .or_else(|| tool_call.get("id").and_then(Value::as_str))
        .or_else(|| {
            tool_call
                .get("functionCall")
                .and_then(|value| value.get("id"))
                .and_then(Value::as_str)
        })
        .or_else(|| {
            tool_call
                .get("function_call")
                .and_then(|value| value.get("id"))
                .and_then(Value::as_str)
        })
}

/// Rewrite only the arguments field of a provider-native tool call entry.
/// Returns false when the entry uses an unknown shape (leave it untouched).
fn replace_tool_call_arguments(tool_call: &mut Value, arguments: Value) -> bool {
    let Some(object) = tool_call.as_object_mut() else {
        return false;
    };

    if let Some(function_call) = object
        .get_mut("functionCall")
        .and_then(Value::as_object_mut)
    {
        function_call.insert("args".to_string(), arguments);
        return true;
    }

    if let Some(function_call) = object
        .get_mut("function_call")
        .and_then(Value::as_object_mut)
    {
        function_call.insert("arguments".to_string(), serialize_arguments(&arguments));
        return true;
    }

    if let Some(function) = object.get_mut("function").and_then(Value::as_object_mut) {
        function.insert("arguments".to_string(), serialize_arguments(&arguments));
        return true;
    }

    if object.contains_key("input") {
        object.insert("input".to_string(), arguments);
        return true;
    }

    if object.contains_key("arguments") {
        object.insert("arguments".to_string(), serialize_arguments(&arguments));
        return true;
    }

    if object.contains_key("args") {
        object.insert("args".to_string(), arguments);
        return true;
    }

    false
}

fn serialize_arguments(arguments: &Value) -> Value {
    Value::String(serde_json::to_string(arguments).unwrap_or_else(|_| "{}".to_string()))
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
                        thinking_duration_ms,
                        thinking_token_count,
                        status,
                        model,
                        response_id,
                        checkpoint_id,
                        tool_calls_json,
                        interruption_reason,
                        recovery_outcome,
                        input_tokens,
                        output_tokens,
                        cache_creation_input_tokens,
                        cache_read_input_tokens,
                        retry_attempts,
                        retry_error,
                        created_at,
                        tool_corrections_json,
                        CASE WHEN role = 'assistant' AND status IN ('failed', 'error')
                             THEN raw_json ELSE '{}' END,
                        origin
                   FROM chat_messages
                  WHERE conversation_id = ?1
                  ORDER BY id ASC",
            )?;

            let rows = statement.query_map(params![conversation_id], |row| {
                Ok(ChatMessageRecord {
                    id: row.get(0)?,
                    role: row.get(1)?,
                    origin: row.get(22)?,
                    content: row.get(2)?,
                    thinking: row.get(3)?,
                    thinking_duration_ms: row.get(4)?,
                    thinking_token_count: row.get(5)?,
                    status: row.get(6)?,
                    model: row.get(7)?,
                    response_id: row.get(8)?,
                    checkpoint_id: row.get(9)?,
                    tool_calls_json: row.get(10)?,
                    interruption_reason: row.get(11)?,
                    recovery_outcome: row.get(12)?,
                    input_tokens: row.get(13)?,
                    output_tokens: row.get(14)?,
                    cache_creation_input_tokens: row.get(15)?,
                    cache_read_input_tokens: row.get(16)?,
                    retry_attempts: row.get(17)?,
                    retry_error: row.get(18)?,
                    created_at: row.get(19)?,
                    tool_corrections_json: row.get(20)?,
                    failure_reason: crate::failure::failure_reason_from_raw(
                        &row.get::<_, String>(21)?,
                    ),
                })
            })?;

            rows.collect()
        })
        .map_err(|error| database::database_error(database_path, "list chat messages", error))
}

/// Fetch user-role messages for a conversation, including context-compaction
/// boundaries, so the chat UI's user-message rail can preview and navigate to
/// them. Returns just id, content, created_at and the compaction flag —
/// because it skips the heavy thinking/tool_calls_json columns and filters on
/// role, it stays fast even for conversations with thousands of messages.
pub fn list_user_messages(
    database_path: &Path,
    conversation_id: &str,
) -> Result<Vec<UserMessageSummary>> {
    database::open_connection(database_path)
        .and_then(|connection| {
            let mut statement = connection.prepare(
                "SELECT id,
                        content,
                        created_at,
                        status
                   FROM chat_messages
                  WHERE conversation_id = ?1
                    AND role = 'user'
                    -- 机器注入的宿主事实消息不进入用户消息导航。
                    AND content NOT LIKE '## Host Facts%'
                    -- 折叠压缩续跑提示（内部消息）同样不进入导航。
                    AND NOT (origin = 'internal' AND content LIKE '[Context compressed]%')
                  ORDER BY id ASC",
            )?;

            let rows = statement.query_map(params![conversation_id], |row| {
                let status: String = row.get(3)?;
                Ok(UserMessageSummary {
                    id: row.get(0)?,
                    content: row.get(1)?,
                    created_at: row.get(2)?,
                    is_context_compaction: status == "context_compaction",
                })
            })?;

            rows.collect()
        })
        .map_err(|error| database::database_error(database_path, "list user messages", error))
}

/// 按消息 id 读取单条用户消息的原始内容（远控图片接口的数据库兜底）。
///
/// 桌面渲染进程只持有当前会话已加载的内存消息窗口（首屏仅一页），手机端
/// 可翻页读取完整历史，这些历史消息没有内存副本可查；内容按数据库原始
/// 形态返回（`@@image:` 值可能是 `upload/...` 相对路径或内联 data URL），
/// 由调用方用 `resolve_message_image` 解析。
pub fn get_user_message_content(database_path: &Path, message_id: &str) -> Result<Option<String>> {
    database::open_connection(database_path)
        .and_then(|connection| {
            connection
                .query_row(
                    "SELECT content
                       FROM chat_messages
                      WHERE id = ?1
                        AND role = 'user'",
                    params![message_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
        })
        .map_err(|error| {
            database::database_error(database_path, "read user message content", error)
        })
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
                        thinking_duration_ms,
                        thinking_token_count,
                        status,
                        model,
                        response_id,
                        checkpoint_id,
                        tool_calls_json,
                        interruption_reason,
                        recovery_outcome,
                        input_tokens,
                        output_tokens,
                        cache_creation_input_tokens,
                        cache_read_input_tokens,
                        retry_attempts,
                        retry_error,
                        created_at,
                        tool_corrections_json,
                        CASE WHEN role = 'assistant' AND status IN ('failed', 'error')
                             THEN raw_json ELSE '{}' END,
                        origin
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
                        origin: row.get(22)?,
                        content: row.get(2)?,
                        thinking: row.get(3)?,
                        thinking_duration_ms: row.get(4)?,
                        thinking_token_count: row.get(5)?,
                        status: row.get(6)?,
                        model: row.get(7)?,
                        response_id: row.get(8)?,
                        checkpoint_id: row.get(9)?,
                        tool_calls_json: row.get(10)?,
                        interruption_reason: row.get(11)?,
                        recovery_outcome: row.get(12)?,
                        input_tokens: row.get(13)?,
                        output_tokens: row.get(14)?,
                        cache_creation_input_tokens: row.get(15)?,
                        cache_read_input_tokens: row.get(16)?,
                        retry_attempts: row.get(17)?,
                        retry_error: row.get(18)?,
                        created_at: row.get(19)?,
                        tool_corrections_json: row.get(20)?,
                        failure_reason: crate::failure::failure_reason_from_raw(
                            &row.get::<_, String>(21)?,
                        ),
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

/// Reads the workspace directory a conversation is bound to, if any. Returns
/// `Ok(None)` when the conversation does not exist or has no directory.
pub fn get_conversation_directory_id(
    database_path: &Path,
    conversation_id: &str,
) -> Result<Option<String>> {
    database::open_connection(database_path)
        .and_then(|connection| {
            connection
                .query_row(
                    "SELECT directory_id
                       FROM chat_conversations
                      WHERE conversation_id = ?1
                      LIMIT 1",
                    params![conversation_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()
                .map(|directory_id| {
                    directory_id
                        .flatten()
                        .filter(|value| !value.trim().is_empty())
                })
        })
        .map_err(|error| {
            database::database_error(database_path, "get conversation directory", error)
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

/// 收集仍被任意消息引用的内联图片路径：把逐文件的全表 LIKE 合并为一次
/// （按 SQLite 变量上限分块的）扫描，避免按图片数叠加 N 次全表扫描。
fn collect_referenced_upload_paths(
    connection: &rusqlite::Connection,
    relative_paths: &[String],
) -> HashSet<String> {
    const TAG_PREFIX: &str = "@@image:upload/";
    let mut referenced = HashSet::new();
    for chunk in relative_paths.chunks(MAX_VARIABLES) {
        let conditions = (1..=chunk.len())
            .map(|index| format!("content LIKE ?{index}"))
            .collect::<Vec<_>>()
            .join(" OR ");
        let Ok(mut statement) =
            connection.prepare(&format!("SELECT content FROM chat_messages WHERE {conditions}"))
        else {
            continue;
        };
        let patterns: Vec<String> = chunk
            .iter()
            .map(|path| format!("%@@image:{path}@@%"))
            .collect();
        let Ok(rows) =
            statement.query_map(params_from_iter(patterns.iter()), |row| row.get::<_, String>(0))
        else {
            continue;
        };
        for content in rows.flatten() {
            let mut rest = content.as_str();
            while let Some(tag_start) = rest.find(TAG_PREFIX) {
                let value_start = tag_start + TAG_PREFIX.len();
                let value_and_rest = &rest[value_start..];
                let Some(tag_end) = value_and_rest.find("@@") else {
                    break;
                };
                referenced.insert(format!("upload/{}", &value_and_rest[..tag_end]));
                rest = &value_and_rest[tag_end + 2..];
            }
        }
    }
    referenced
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
    // 一次（分块）扫描给出全部仍被引用的路径，替代按图片逐张全表 LIKE。
    let referenced = collect_referenced_upload_paths(connection, relative_paths);
    for relative in relative_paths {
        if referenced.contains(relative) {
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

/// 收集待删会话关联的全部 checkpoint id：消息级（chat_messages.checkpoint_id）
/// 与 workflow 节点 flow 级（workflow_node_sessions.flow_checkpoint_id）。
/// 供删除事务提交后清理快照目录；去重后按收集顺序返回。
pub fn collect_conversation_checkpoint_ids(
    transaction: &rusqlite::Transaction<'_>,
    conversation_ids: &[String],
) -> rusqlite::Result<Vec<String>> {
    let mut checkpoint_ids = Vec::new();
    let mut seen = HashSet::new();
    for chunk in conversation_ids.chunks(MAX_VARIABLES) {
        let placeholders = in_clause_placeholders(chunk.len());
        // 消息级 checkpoint：随 user 消息创建，回滚到该消息时恢复文件状态
        let mut statement = transaction.prepare(&format!(
            "SELECT checkpoint_id
               FROM chat_messages
              WHERE conversation_id IN ({placeholders})
                AND checkpoint_id != ''"
        ))?;
        let rows = statement.query_map(params_from_iter(chunk.iter()), |row| {
            row.get::<_, String>(0)
        })?;
        for row in rows {
            let checkpoint_id = row?;
            if seen.insert(checkpoint_id.clone()) {
                checkpoint_ids.push(checkpoint_id);
            }
        }
        // flow 级 checkpoint：workflow 节点（尤其 bash）对工作区的改动
        let mut statement = transaction.prepare(&format!(
            "SELECT flow_checkpoint_id
               FROM workflow_node_sessions
              WHERE conversation_id IN ({placeholders})
                AND flow_checkpoint_id != ''"
        ))?;
        let rows = statement.query_map(params_from_iter(chunk.iter()), |row| {
            row.get::<_, String>(0)
        })?;
        for row in rows {
            let checkpoint_id = row?;
            if seen.insert(checkpoint_id.clone()) {
                checkpoint_ids.push(checkpoint_id);
            }
        }
    }
    Ok(checkpoint_ids)
}

/// 删除不再被任何会话引用的 checkpoint 快照目录（孤儿清理）。
/// 物理删除失败仅产生孤儿目录，不阻断会话删除。
pub fn cleanup_orphan_checkpoint_files(checkpoint_ids: &[String]) {
    if checkpoint_ids.is_empty() {
        return;
    }
    for checkpoint_id in checkpoint_ids {
        let _ = crate::checkpoint::delete_checkpoint(checkpoint_id.clone());
    }
}
