//! 项目级持久记忆（Project Memory）的 NAPI 转发。
//!
//! 供 Electron 主进程 / 渲染器面板手动管理记忆（增删改查、统计、清空）。
//! 所有 SQLite I/O 均在 spawn_blocking 中执行，不阻塞 Node.js。

use super::*;

// ============================================================================
// Project Memories — 按 directory_id 隔离的跨会话 AI 记忆。
// ============================================================================

#[napi]
pub async fn upsert_project_memory(
    directory_id: String,
    kind: String,
    title: String,
    content: String,
    importance: i32,
    tags: Option<Vec<String>>,
    source: Option<String>,
    status: Option<String>,
    conversation_id: Option<String>,
    response_id: Option<String>,
) -> napi::Result<MemoryRecord> {
    tokio::task::spawn_blocking(move || {
        let (record, _created) = crate::storage::upsert_project_memory(
            directory_id,
            kind,
            title,
            content,
            source.unwrap_or_else(|| "user".to_string()),
            status.unwrap_or_else(|| "active".to_string()),
            importance,
            conversation_id.unwrap_or_default(),
            response_id.unwrap_or_default(),
            tags.unwrap_or_default(),
        )?;
        Ok(record)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn list_project_memories(
    directory_id: String,
    limit: i32,
    offset: i32,
    status: Option<String>,
    kind: Option<String>,
) -> napi::Result<MemoryPage> {
    tokio::task::spawn_blocking(move || {
        crate::storage::list_project_memories(directory_id, limit, offset, status, kind)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn update_project_memory(
    memory_id: String,
    kind: Option<String>,
    title: Option<String>,
    content: Option<String>,
    importance: Option<i32>,
    status: Option<String>,
    tags: Option<Vec<String>>,
) -> napi::Result<MemoryRecord> {
    tokio::task::spawn_blocking(move || {
        let patch = crate::storage::services::project_memories::MemoryUpdatePatch {
            kind,
            title,
            content,
            importance,
            status,
            tags,
        };
        crate::storage::update_project_memory(memory_id, patch)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn delete_project_memory(memory_id: String) -> napi::Result<bool> {
    tokio::task::spawn_blocking(move || crate::storage::delete_project_memory(memory_id))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn clear_project_memories(directory_id: String) -> napi::Result<i32> {
    tokio::task::spawn_blocking(move || crate::storage::clear_project_memories(directory_id))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn get_project_memory_stats(directory_id: String) -> napi::Result<MemoryStats> {
    tokio::task::spawn_blocking(move || crate::storage::get_project_memory_stats(directory_id))
        .await
        .map_err(map_spawn_error)?
}

// ---------------------------------------------------------------------------
// 会话级维护：删除确认弹窗查询 + 手动清理某个会话保存的记忆
// ---------------------------------------------------------------------------

/// 统计一组会话（含级联子会话）关联的记忆条数。删除确认弹窗据此决定
/// 是否展示「同时删除记忆」选项；为 0 时不打扰用户。
#[napi]
pub async fn count_project_memories_by_conversations(
    conversation_ids: Vec<String>,
) -> napi::Result<i32> {
    tokio::task::spawn_blocking(move || {
        let database_path = crate::storage::ensure_database_file()?;
        crate::storage::services::project_memories::count_memories_by_conversation_ids(
            &database_path,
            &conversation_ids,
        )
    })
    .await
    .map_err(map_spawn_error)?
}

/// 列出某个会话保存的记忆（面板溯源 / 删除会话前的确认清单）。
#[napi]
pub async fn list_project_memories_by_conversation(
    conversation_id: String,
    limit: Option<i32>,
) -> napi::Result<Vec<MemoryRecord>> {
    tokio::task::spawn_blocking(move || {
        let database_path = crate::storage::ensure_database_file()?;
        crate::storage::services::project_memories::list_memories_by_conversation(
            &database_path,
            &conversation_id,
            limit.unwrap_or(50),
        )
    })
    .await
    .map_err(map_spawn_error)?
}

/// 删除某个会话保存的全部记忆（手动维护入口），返回删除条数。
#[napi]
pub async fn delete_project_memories_by_conversation(
    conversation_id: String,
) -> napi::Result<i32> {
    tokio::task::spawn_blocking(move || {
        let database_path = crate::storage::ensure_database_file()?;
        crate::storage::services::project_memories::delete_memories_by_conversation(
            &database_path,
            &conversation_id,
        )
    })
    .await
    .map_err(map_spawn_error)?
}

// ---------------------------------------------------------------------------
// 回滚联动：按截断边界圈定被回滚轮次保存的记忆 + 确认后按 id 批量清理
// ---------------------------------------------------------------------------

/// 列出回滚将被清理的项目记忆（回滚确认弹窗展示清单）。
///
/// 边界定位与 truncate 语义一致：`boundary_message_id`（持久化用户消息行
/// id，失败/中断轮次）优先，其次 `boundary_response_id`；两者皆空（回滚
/// 首条消息）时返回该会话全部记忆。`cascade_conversation_ids`（随回滚
/// 整体级联删除的 WorkFlow 节点会话等）的全部记忆一并返回。
#[napi]
pub async fn list_project_memories_for_rollback(
    conversation_id: String,
    boundary_message_id: Option<String>,
    boundary_response_id: Option<String>,
    cascade_conversation_ids: Option<Vec<String>>,
) -> napi::Result<Vec<MemoryRecord>> {
    tokio::task::spawn_blocking(move || {
        let database_path = crate::storage::ensure_database_file()?;
        crate::storage::services::project_memories::list_memories_for_rollback(
            &database_path,
            &conversation_id,
            boundary_message_id.as_deref(),
            boundary_response_id.as_deref(),
            &cascade_conversation_ids.unwrap_or_default(),
        )
    })
    .await
    .map_err(map_spawn_error)?
}

/// 按 memory_id 批量删除记忆（回滚确认后勾选清理）。单事务原子执行，
/// 返回删除条数。
#[napi]
pub async fn delete_project_memories_by_ids(
    memory_ids: Vec<String>,
) -> napi::Result<i32> {
    tokio::task::spawn_blocking(move || {
        let database_path = crate::storage::ensure_database_file()?;
        crate::storage::services::project_memories::delete_memories_by_memory_ids(
            &database_path,
            &memory_ids,
        )
    })
    .await
    .map_err(map_spawn_error)?
}
