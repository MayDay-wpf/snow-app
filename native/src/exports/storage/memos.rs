//! Memos（快速备忘录）的 NAPI 转发。

use super::*;

// ============================================================================
// Memos — 快速备忘录，状态为 pending / done。
// 所有 SQLite I/O 均在 spawn_blocking 中执行，不阻塞 Node.js。
// ============================================================================

#[napi]
pub async fn list_memos(
    directory_id: String,
    limit: i32,
    offset: i32,
    status: Option<String>,
    sort_order: Option<String>,
) -> napi::Result<MemoPage> {
    tokio::task::spawn_blocking(move || {
        crate::storage::list_memos(directory_id, limit, offset, status, sort_order)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn create_memo(directory_id: String, content: String) -> napi::Result<MemoRecord> {
    tokio::task::spawn_blocking(move || crate::storage::create_memo(directory_id, content))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn update_memo_content(memo_id: String, content: String) -> napi::Result<MemoRecord> {
    tokio::task::spawn_blocking(move || crate::storage::update_memo_content(memo_id, content))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn update_memo_status(memo_id: String, status: String) -> napi::Result<MemoRecord> {
    tokio::task::spawn_blocking(move || crate::storage::update_memo_status(memo_id, status))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn delete_memo(memo_id: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::delete_memo(memo_id))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn get_memo_count_summary(directory_id: String) -> napi::Result<MemoCountSummary> {
    tokio::task::spawn_blocking(move || crate::storage::get_memo_count_summary(directory_id))
        .await
        .map_err(map_spawn_error)?
}
