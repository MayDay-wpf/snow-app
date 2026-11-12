use napi::bindgen_prelude::*;

use snow_storage_core::bootstrap::ensure_database_file;
use snow_storage_core::models::*;

use crate::project_memories::{MemoryUpdatePatch, MemoryUpsertInput};

mod services {
    pub use crate::project_memories;
}

// ===== Project Memories（项目级持久记忆）=====
//
// 包装层只做「取数据库路径 + 借用参数组装」，真正的 SQL 逻辑都在
// services::project_memories；所有导出最终经 NAPI 层放入 spawn_blocking。

pub fn upsert_project_memory(
    directory_id: String,
    kind: String,
    title: String,
    content: String,
    source: String,
    status: String,
    importance: i32,
    conversation_id: String,
    response_id: String,
    tags: Vec<String>,
) -> Result<(MemoryRecord, bool)> {
    let database_path = ensure_database_file()?;
    services::project_memories::upsert_memory(
        &database_path,
        &MemoryUpsertInput {
            directory_id: &directory_id,
            kind: &kind,
            title: &title,
            content: &content,
            source: &source,
            status: &status,
            importance,
            conversation_id: &conversation_id,
            response_id: &response_id,
            tags,
        },
    )
}

pub fn list_project_memories(
    directory_id: String,
    limit: i32,
    offset: i32,
    status: Option<String>,
    kind: Option<String>,
) -> Result<MemoryPage> {
    let database_path = ensure_database_file()?;
    services::project_memories::list_memories(
        &database_path,
        &directory_id,
        status.as_deref(),
        kind.as_deref(),
        limit,
        offset,
    )
}

pub fn update_project_memory(memory_id: String, patch: MemoryUpdatePatch) -> Result<MemoryRecord> {
    let database_path = ensure_database_file()?;
    services::project_memories::update_memory(&database_path, &memory_id, &patch)
}

/// 面板关键词检索（分页 + 命中总数），排序与 MCP memory-manage 的 search 一致。
pub fn search_project_memories(
    directory_id: String,
    query: String,
    limit: i32,
    offset: i32,
    status: Option<String>,
    kind: Option<String>,
) -> Result<MemoryPage> {
    let database_path = ensure_database_file()?;
    services::project_memories::search_memories_page(
        &database_path,
        &directory_id,
        &query,
        kind.as_deref(),
        status.as_deref(),
        limit,
        offset,
    )
}

/// 列出多个会话（主会话 + 子代理 / WorkFlow 节点会话）保存的记忆。
pub fn list_project_memories_by_conversations(
    conversation_ids: Vec<String>,
    limit: i32,
) -> Result<Vec<MemoryRecord>> {
    let database_path = ensure_database_file()?;
    services::project_memories::list_memories_by_conversation_ids(
        &database_path,
        &conversation_ids,
        limit,
    )
}

pub fn delete_project_memory(memory_id: String) -> Result<bool> {
    let database_path = ensure_database_file()?;
    services::project_memories::delete_memory(&database_path, &memory_id)
}

pub fn clear_project_memories(directory_id: String) -> Result<i32> {
    let database_path = ensure_database_file()?;
    services::project_memories::clear_project_memories(&database_path, &directory_id)
}

pub fn get_project_memory_stats(directory_id: String) -> Result<MemoryStats> {
    let database_path = ensure_database_file()?;
    services::project_memories::get_memory_stats(&database_path, &directory_id)
}
