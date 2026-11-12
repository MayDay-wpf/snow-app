//! 定时任务的 NAPI 转发。

use super::*;

// ============================================================================
// Scheduled tasks — 定时任务持久化：任务定义/状态 + 运行历史存 SQLite。
// 所有 SQLite I/O 均在 spawn_blocking 中执行，不阻塞 Node.js。
// ============================================================================

#[napi]
pub async fn list_scheduled_tasks() -> napi::Result<Vec<ScheduledTaskRecord>> {
    tokio::task::spawn_blocking(crate::storage::list_scheduled_tasks)
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn upsert_scheduled_task(
    input: ScheduledTaskRecordInput,
) -> napi::Result<ScheduledTaskRecord> {
    tokio::task::spawn_blocking(move || crate::storage::upsert_scheduled_task(input))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn delete_scheduled_task(task_id: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::delete_scheduled_task(task_id))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn clear_scheduled_tasks(directory_id: Option<String>) -> napi::Result<u32> {
    tokio::task::spawn_blocking(move || crate::storage::clear_scheduled_tasks(directory_id))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn append_scheduled_task_run(task_id: String, run_at: String) -> napi::Result<String> {
    tokio::task::spawn_blocking(move || {
        crate::storage::append_scheduled_task_run(task_id, run_at)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn finalize_scheduled_task_run(
    task_id: String,
    run_id: String,
    status: String,
    duration_ms: Option<i64>,
    error: Option<String>,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::finalize_scheduled_task_run(task_id, run_id, status, duration_ms, error)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn reconcile_scheduled_task_runs() -> napi::Result<u32> {
    tokio::task::spawn_blocking(crate::storage::reconcile_scheduled_task_runs)
        .await
        .map_err(map_spawn_error)?
}
