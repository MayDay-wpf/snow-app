use std::path::Path;

use napi::bindgen_prelude::*;
use rusqlite::{params, Connection, Row};

use super::super::database;
use super::super::{ScheduledTaskRecord, ScheduledTaskRecordInput, ScheduledTaskRunRecord};

/// Maximum run-history entries kept per task (matches the renderer's existing
/// ring-buffer behavior; older entries are pruned on append).
const MAX_RUN_HISTORY: i64 = 20;

/// Loads every scheduled task (definition + state + the latest run history
/// entries per task). The renderer store is the runtime authority; this is
/// used to rehydrate it at startup.
pub fn list_scheduled_tasks(database_path: &Path) -> Result<Vec<ScheduledTaskRecord>> {
    database::open_connection(database_path)
        .and_then(|connection| list_with_connection(&connection))
        .map_err(|error| database::database_error(database_path, "list scheduled tasks", error))
}

/// Inserts a new task or updates an existing one (identified by `id`).
/// Timestamps are supplied by the caller (renderer) so scheduling semantics
/// stay in one place. Returns the stored record including its run history.
pub fn upsert_scheduled_task(
    database_path: &Path,
    input: &ScheduledTaskRecordInput,
) -> Result<ScheduledTaskRecord> {
    database::open_connection(database_path)
        .and_then(|connection| upsert_with_connection(&connection, input))
        .map_err(|error| database::database_error(database_path, "upsert scheduled task", error))
}

/// Deletes a task permanently. Its run history is removed via
/// `ON DELETE CASCADE`.
pub fn delete_scheduled_task(database_path: &Path, task_id: &str) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|connection| {
            connection.execute(
                "DELETE FROM scheduled_tasks WHERE id = ?1",
                params![task_id],
            )?;
            Ok(())
        })
        .map_err(|error| database::database_error(database_path, "delete scheduled task", error))
}

/// Clears tasks. `None` clears everything; `Some("")` clears only global
/// tasks; `Some(directory_id)` clears only that project's tasks. Returns the
/// number of deleted tasks.
pub fn clear_scheduled_tasks(
    database_path: &Path,
    directory_id: Option<&str>,
) -> Result<u32> {
    database::open_connection(database_path)
        .and_then(|connection| clear_with_connection(&connection, directory_id))
        .map_err(|error| database::database_error(database_path, "clear scheduled tasks", error))
}

/// Appends a "running" run-history entry for a task and prunes history beyond
/// `MAX_RUN_HISTORY`. Returns the generated run id so the caller can finalize
/// this exact entry later.
pub fn append_scheduled_task_run(
    database_path: &Path,
    task_id: &str,
    run_at: &str,
) -> Result<String> {
    database::open_connection(database_path)
        .and_then(|connection| append_run_with_connection(&connection, task_id, run_at))
        .map_err(|error| {
            database::database_error(database_path, "append scheduled task run", error)
        })
}

/// Finalizes a previously appended run entry (running → completed/error).
/// Only the row matching both `task_id` and `run_id` is updated.
pub fn finalize_scheduled_task_run(
    database_path: &Path,
    task_id: &str,
    run_id: &str,
    status: &str,
    duration_ms: Option<i64>,
    error: Option<&str>,
) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|connection| {
            connection.execute(
                "UPDATE scheduled_task_runs
                    SET status = ?1, duration_ms = ?2, error = ?3
                  WHERE id = ?4 AND task_id = ?5",
                params![status, duration_ms, error, run_id, task_id],
            )?;
            Ok(())
        })
        .map_err(|error| {
            database::database_error(database_path, "finalize scheduled task run", error)
        })
}

/// Marks every run row still in "running" state as errored. Called once at
/// startup (hydration) — before any run of the current session can have been
/// appended — so every "running" row necessarily belongs to a crashed
/// previous session whose finalize write was lost. This keeps the runs table
/// consistent with the renderer's restart reconciliation instead of leaving
/// zombie "running" rows forever. Returns the number of rows corrected.
pub fn reconcile_interrupted_runs(database_path: &Path) -> Result<u32> {
    database::open_connection(database_path)
        .and_then(|connection| {
            let updated = connection.execute(
                "UPDATE scheduled_task_runs
                    SET status = 'error', error = 'Interrupted by app shutdown'
                  WHERE status = 'running'",
                [],
            )?;
            Ok(updated as u32)
        })
        .map_err(|error| {
            database::database_error(database_path, "reconcile scheduled task runs", error)
        })
}

fn list_with_connection(connection: &Connection) -> rusqlite::Result<Vec<ScheduledTaskRecord>> {
    let mut statement = connection.prepare(
        "SELECT id, directory_id, name, prompt, schedule_json,
                api_profile, basic_model, model, thinking_strength,
                status, paused, next_run_at, last_run_at, run_count, last_error,
                pre_script, pre_script_timeout_ms, run_on_script_error,
                skip_count, last_skipped_at, last_skip_reason,
                created_at, updated_at
           FROM scheduled_tasks
          ORDER BY created_at ASC, id ASC",
    )?;
    let mut tasks: Vec<ScheduledTaskRecord> = statement
        .query_map([], |row| map_task_row(row))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);

    if tasks.is_empty() {
        return Ok(tasks);
    }

    // Load all run history in one pass (ascending per task) and attach the
    // newest MAX_RUN_HISTORY entries to each task.
    let mut run_statement = connection.prepare(
        "SELECT task_id, run_at, status, duration_ms, error
           FROM scheduled_task_runs
          ORDER BY task_id ASC, run_at ASC, id ASC",
    )?;
    let runs: Vec<(String, ScheduledTaskRunRecord)> = run_statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, map_run_row(row)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let by_task = tasks.iter_mut().collect::<Vec<_>>();
    let mut index = 0usize;
    for task in by_task {
        let mut history = Vec::new();
        while index < runs.len() && runs[index].0 == task.id {
            history.push(runs[index].1.clone());
            index += 1;
        }
        let keep_from = history.len().saturating_sub(MAX_RUN_HISTORY as usize);
        task.history = history.split_off(keep_from);
    }

    Ok(tasks)
}

fn upsert_with_connection(
    connection: &Connection,
    input: &ScheduledTaskRecordInput,
) -> rusqlite::Result<ScheduledTaskRecord> {
    connection.execute(
        "INSERT INTO scheduled_tasks (
             id, directory_id, name, prompt, schedule_json,
             api_profile, basic_model, model, thinking_strength,
             status, paused, next_run_at, last_run_at, run_count, last_error,
             pre_script, pre_script_timeout_ms, run_on_script_error,
             skip_count, last_skipped_at, last_skip_reason,
             created_at, updated_at
         ) VALUES (
             ?1, ?2, ?3, ?4, ?5,
             ?6, ?7, ?8, ?9,
             ?10, ?11, ?12, ?13, ?14, ?15,
             ?16, ?17, ?18, ?19, ?20, ?21,
             ?22, ?23
         )
         ON CONFLICT(id) DO UPDATE SET
             directory_id = excluded.directory_id,
             name = excluded.name,
             prompt = excluded.prompt,
             schedule_json = excluded.schedule_json,
             api_profile = excluded.api_profile,
             basic_model = excluded.basic_model,
             model = excluded.model,
             thinking_strength = excluded.thinking_strength,
             status = excluded.status,
             paused = excluded.paused,
             next_run_at = excluded.next_run_at,
             last_run_at = excluded.last_run_at,
             run_count = excluded.run_count,
             last_error = excluded.last_error,
             pre_script = excluded.pre_script,
             pre_script_timeout_ms = excluded.pre_script_timeout_ms,
             run_on_script_error = excluded.run_on_script_error,
             skip_count = excluded.skip_count,
             last_skipped_at = excluded.last_skipped_at,
             last_skip_reason = excluded.last_skip_reason,
             updated_at = excluded.updated_at",
        params![
            input.id,
            input.directory_id,
            input.name,
            input.prompt,
            input.schedule_json,
            input.api_profile,
            input.basic_model,
            input.model,
            input.thinking_strength,
            input.status,
            input.paused,
            input.next_run_at,
            input.last_run_at,
            input.run_count,
            input.last_error,
            input.pre_script,
            input.pre_script_timeout_ms,
            // The DB column is NOT NULL DEFAULT 0; an explicit NULL would fail
            // the whole upsert (SQLite only applies DEFAULT when the column is
            // omitted). Coalesce here so a renderer that passes `undefined`
            // (e.g. updating a task without a pre-script) still persists.
            input.run_on_script_error.unwrap_or(false),
            input.skip_count,
            input.last_skipped_at,
            input.last_skip_reason,
            input.created_at,
            input.updated_at,
        ],
    )?;
    fetch_task_by_id(connection, &input.id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
}

fn clear_with_connection(
    connection: &Connection,
    directory_id: Option<&str>,
) -> rusqlite::Result<u32> {
    let deleted = match directory_id {
        None => connection.execute("DELETE FROM scheduled_tasks", [])?,
        Some(directory_id) => connection.execute(
            "DELETE FROM scheduled_tasks WHERE directory_id = ?1",
            params![directory_id],
        )?,
    };
    Ok(deleted as u32)
}

fn append_run_with_connection(
    connection: &Connection,
    task_id: &str,
    run_at: &str,
) -> rusqlite::Result<String> {
    let run_id = database::create_snowflake_id();
    connection.execute(
        "INSERT INTO scheduled_task_runs (id, task_id, run_at, status)
         VALUES (?1, ?2, ?3, 'running')",
        params![run_id, task_id, run_at],
    )?;

    // Prune history beyond MAX_RUN_HISTORY (keep the newest entries).
    connection.execute(
        "DELETE FROM scheduled_task_runs
          WHERE task_id = ?1 AND id NOT IN (
            SELECT id FROM scheduled_task_runs
             WHERE task_id = ?1
             ORDER BY run_at DESC, id DESC
             LIMIT ?2
          )",
        params![task_id, MAX_RUN_HISTORY],
    )?;

    Ok(run_id)
}

fn fetch_task_by_id(
    connection: &Connection,
    task_id: &str,
) -> rusqlite::Result<Option<ScheduledTaskRecord>> {
    let mut statement = connection.prepare(
        "SELECT id, directory_id, name, prompt, schedule_json,
                api_profile, basic_model, model, thinking_strength,
                status, paused, next_run_at, last_run_at, run_count, last_error,
                pre_script, pre_script_timeout_ms, run_on_script_error,
                skip_count, last_skipped_at, last_skip_reason,
                created_at, updated_at
           FROM scheduled_tasks
          WHERE id = ?1",
    )?;
    let mut rows = statement.query_map(params![task_id], |row| map_task_row(row))?;
    match rows.next() {
        Some(value) => {
            let mut task = value?;
            drop(rows);
            drop(statement);
            task.history = fetch_run_history(connection, task_id)?;
            Ok(Some(task))
        }
        None => Ok(None),
    }
}

fn fetch_run_history(
    connection: &Connection,
    task_id: &str,
) -> rusqlite::Result<Vec<ScheduledTaskRunRecord>> {
    let mut statement = connection.prepare(
        "SELECT run_at, status, duration_ms, error
           FROM scheduled_task_runs
          WHERE task_id = ?1
          ORDER BY run_at ASC, id ASC
          LIMIT ?2",
    )?;
    let rows = statement
        .query_map(params![task_id, MAX_RUN_HISTORY], |row| map_run_row(row))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn map_task_row(row: &Row) -> rusqlite::Result<ScheduledTaskRecord> {
    Ok(ScheduledTaskRecord {
        id: row.get(0)?,
        directory_id: row.get(1)?,
        name: row.get(2)?,
        prompt: row.get(3)?,
        schedule_json: row.get(4)?,
        api_profile: row.get(5)?,
        basic_model: row.get(6)?,
        model: row.get(7)?,
        thinking_strength: row.get(8)?,
        status: row.get(9)?,
        paused: row.get(10)?,
        next_run_at: row.get(11)?,
        last_run_at: row.get(12)?,
        run_count: row.get(13)?,
        last_error: row.get(14)?,
        pre_script: row.get(15)?,
        pre_script_timeout_ms: row.get(16)?,
        run_on_script_error: row.get(17)?,
        skip_count: row.get(18)?,
        last_skipped_at: row.get(19)?,
        last_skip_reason: row.get(20)?,
        created_at: row.get(21)?,
        updated_at: row.get(22)?,
        history: Vec::new(),
    })
}

fn map_run_row(row: &Row) -> rusqlite::Result<ScheduledTaskRunRecord> {
    Ok(ScheduledTaskRunRecord {
        run_at: row.get(0)?,
        status: row.get(1)?,
        duration_ms: row.get(2)?,
        error: row.get(3)?,
    })
}
