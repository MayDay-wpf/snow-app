//! 会话级系统提示词配置快照（role.md 解析结果 + API 档案系统提示词）。
//!
//! 会话内冻结这些用户可编辑的配置，避免中途修改导致提示词前缀变化、整段
//! prompt cache 失效。压缩（上下文重建）成功后删除快照，下一次请求重新载入
//! 最新配置；目录 / API 档案切换也会重建。请求头不进入提示词，始终实时解析。

use std::path::Path;

use napi::bindgen_prelude::*;
use rusqlite::{params, Connection, OptionalExtension};

use snow_storage_core::database;

#[derive(Debug, Clone)]
pub struct SystemPromptConfigSnapshot {
    pub directory_id: String,
    pub api_prompt_ids_json: String,
    pub role_content: Option<String>,
    pub role_overrides_builtin: bool,
    pub user_prompts: Vec<String>,
}

pub fn load_snapshot(
    database_path: &Path,
    conversation_id: &str,
) -> Result<Option<SystemPromptConfigSnapshot>> {
    let conversation_id = conversation_id.trim();
    if conversation_id.is_empty() {
        return Ok(None);
    }
    database::open_connection(database_path)
        .and_then(|connection| {
            connection
                .query_row(
                    "SELECT directory_id, api_prompt_ids_json, role_content,
                            role_overrides_builtin, user_prompts_json
                       FROM system_prompt_snapshots
                      WHERE conversation_id = ?1",
                    params![conversation_id],
                    |row| {
                        let user_prompts_json: String = row.get(4)?;
                        Ok(SystemPromptConfigSnapshot {
                            directory_id: row.get(0)?,
                            api_prompt_ids_json: row.get(1)?,
                            role_content: row.get::<_, Option<String>>(2)?,
                            role_overrides_builtin: row.get::<_, i64>(3)? != 0,
                            user_prompts: serde_json::from_str::<Vec<String>>(&user_prompts_json)
                                .unwrap_or_default(),
                        })
                    },
                )
                .optional()
        })
        .map_err(|error| {
            database::database_error(database_path, "read system prompt snapshot", error)
        })
}

/// 写入当前配置。仅在首次渲染或快照失效（目录 / 档案切换）时调用，
/// 因此直接覆盖旧行；并发请求写的是同一份配置。
pub fn save_snapshot(
    database_path: &Path,
    conversation_id: &str,
    snapshot: &SystemPromptConfigSnapshot,
) -> Result<()> {
    let conversation_id = conversation_id.trim();
    if conversation_id.is_empty() {
        return Ok(());
    }
    let user_prompts_json =
        serde_json::to_string(&snapshot.user_prompts).unwrap_or_else(|_| "[]".to_string());
    database::open_connection(database_path)
        .and_then(|connection| {
            connection
                .execute(
                    "INSERT INTO system_prompt_snapshots (
                       conversation_id, directory_id, api_prompt_ids_json,
                       role_content, role_overrides_builtin, user_prompts_json
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                     ON CONFLICT(conversation_id) DO UPDATE SET
                       directory_id = excluded.directory_id,
                       api_prompt_ids_json = excluded.api_prompt_ids_json,
                       role_content = excluded.role_content,
                       role_overrides_builtin = excluded.role_overrides_builtin,
                       user_prompts_json = excluded.user_prompts_json",
                    params![
                        conversation_id,
                        snapshot.directory_id.as_str(),
                        snapshot.api_prompt_ids_json.as_str(),
                        snapshot.role_content.as_deref(),
                        if snapshot.role_overrides_builtin { 1 } else { 0 },
                        user_prompts_json.as_str(),
                    ],
                )
                .map(|_| ())
        })
        .map_err(|error| {
            database::database_error(database_path, "store system prompt snapshot", error)
        })
}

/// 会话删除 / 回滚联动：在调用方事务内清理这些会话的快照。
pub fn delete_snapshots(connection: &Connection, conversation_ids: &[String]) -> rusqlite::Result<i32> {
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
            "DELETE FROM system_prompt_snapshots WHERE conversation_id IN ({placeholders})"
        ))?;
        deleted += statement.execute(rusqlite::params_from_iter(chunk.iter().cloned()))? as i32;
    }
    Ok(deleted)
}
