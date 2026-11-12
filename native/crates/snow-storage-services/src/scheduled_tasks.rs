use napi::bindgen_prelude::*;

use super::ensure_database_file;
use super::models::*;
use super::services;

// ===== Scheduled tasks =====

pub fn list_scheduled_tasks() -> Result<Vec<ScheduledTaskRecord>> {
    let database_path = ensure_database_file()?;
    services::scheduled_tasks::list_scheduled_tasks(&database_path)
}

pub fn upsert_scheduled_task(input: ScheduledTaskRecordInput) -> Result<ScheduledTaskRecord> {
    let database_path = ensure_database_file()?;
    services::scheduled_tasks::upsert_scheduled_task(&database_path, &input)
}

pub fn delete_scheduled_task(task_id: String) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::scheduled_tasks::delete_scheduled_task(&database_path, &task_id)
}

pub fn clear_scheduled_tasks(directory_id: Option<String>) -> Result<u32> {
    let database_path = ensure_database_file()?;
    services::scheduled_tasks::clear_scheduled_tasks(&database_path, directory_id.as_deref())
}

pub fn append_scheduled_task_run(task_id: String, run_at: String) -> Result<String> {
    let database_path = ensure_database_file()?;
    services::scheduled_tasks::append_scheduled_task_run(&database_path, &task_id, &run_at)
}

pub fn finalize_scheduled_task_run(
    task_id: String,
    run_id: String,
    status: String,
    duration_ms: Option<i64>,
    error: Option<String>,
) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::scheduled_tasks::finalize_scheduled_task_run(
        &database_path,
        &task_id,
        &run_id,
        &status,
        duration_ms,
        error.as_deref(),
    )
}

/// Marks run rows left "running" by a crashed session as errored. See
/// `services::scheduled_tasks::reconcile_interrupted_runs`.
pub fn reconcile_scheduled_task_runs() -> Result<u32> {
    let database_path = ensure_database_file()?;
    services::scheduled_tasks::reconcile_interrupted_runs(&database_path)
}
