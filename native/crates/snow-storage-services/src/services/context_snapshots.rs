//! 会话级「上一次实际发送的上下文」快照。
//!
//! 压缩请求直接复用该快照并在尾部追加 handoff 指令，不再走「DB 重建 +
//! 工具配对 + 历史裁剪」的路径：任何重建期改写都会改变消息前缀，使上游
//! prompt cache 从第一条消息起全部失效。快照持久化，进程重启后仍可复用。

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};

use super::super::database;
use super::chat_conversations::ChatContextMessage;

pub struct ConversationContextSnapshot {
    pub directory_id: String,
    pub messages: Vec<ChatContextMessage>,
    pub user_system_prompts: Vec<String>,
}

pub async fn load_snapshot(
    database_path: &Path,
    conversation_id: &str,
) -> Option<ConversationContextSnapshot> {
    let database_path = database_path.to_path_buf();
    let conversation_id = conversation_id.trim().to_string();
    if conversation_id.is_empty() {
        return None;
    }
    tokio::task::spawn_blocking(move || load_snapshot_sync(&database_path, &conversation_id))
        .await
        .ok()
        .flatten()
}

fn load_snapshot_sync(
    database_path: &Path,
    conversation_id: &str,
) -> Option<ConversationContextSnapshot> {
    let connection = database::open_connection(database_path).ok()?;
    let row = connection
        .query_row(
            "SELECT directory_id, messages_json, user_system_prompts_json
               FROM conversation_context_snapshots
              WHERE conversation_id = ?1",
            params![conversation_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()
        .ok()??;
    let messages = serde_json::from_str::<Vec<ChatContextMessage>>(&row.1).ok()?;
    if messages.is_empty() {
        return None;
    }
    let user_system_prompts = serde_json::from_str::<Vec<String>>(&row.2).unwrap_or_default();
    Some(ConversationContextSnapshot {
        directory_id: row.0,
        messages,
        user_system_prompts,
    })
}

/// 覆盖写入本次实际发送的上下文。失败静默：快照只是缓存优化，不能影响请求。
pub async fn save_snapshot(
    database_path: &Path,
    conversation_id: &str,
    directory_id: &str,
    messages: &[ChatContextMessage],
    user_system_prompts: &[String],
) {
    let messages_json = match serde_json::to_string(messages) {
        Ok(value) => value,
        Err(_) => return,
    };
    let user_prompts_json = serde_json::to_string(user_system_prompts)
        .unwrap_or_else(|_| "[]".to_string());
    let database_path = database_path.to_path_buf();
    let conversation_id = conversation_id.trim().to_string();
    let directory_id = directory_id.trim().to_string();
    if conversation_id.is_empty() {
        return;
    }
    let _ = tokio::task::spawn_blocking(move || {
        let Ok(connection) = database::open_connection(&database_path) else {
            return;
        };
        let _ = connection.execute(
            "INSERT INTO conversation_context_snapshots (
               conversation_id, directory_id, messages_json, user_system_prompts_json
             ) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(conversation_id) DO UPDATE SET
               directory_id = excluded.directory_id,
               messages_json = excluded.messages_json,
               user_system_prompts_json = excluded.user_system_prompts_json,
               updated_at = datetime('now', 'localtime')",
            params![
                conversation_id,
                directory_id,
                messages_json,
                user_prompts_json
            ],
        );
    })
    .await;
}

pub fn delete_snapshots(
    connection: &Connection,
    conversation_ids: &[String],
) -> rusqlite::Result<i32> {
    let ids: Vec<String> = conversation_ids
        .iter()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect();
    if ids.is_empty() {
        return Ok(0);
    }

    let mut deleted = 0i32;
    for chunk in ids.chunks(500) {
        let placeholders = chunk
            .iter()
            .enumerate()
            .map(|(index, _)| format!("?{}", index + 1))
            .collect::<Vec<_>>()
            .join(", ");
        let mut statement = connection.prepare(&format!(
            "DELETE FROM conversation_context_snapshots WHERE conversation_id IN ({placeholders})"
        ))?;
        deleted += statement.execute(rusqlite::params_from_iter(chunk.iter().cloned()))? as i32;
    }
    Ok(deleted)
}
