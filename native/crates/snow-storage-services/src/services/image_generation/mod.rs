//! Durable image-generation lifecycle. SQLite is the authority; callbacks are delivery hints.

use std::{collections::HashSet, path::Path, sync::OnceLock};

use chrono::{SecondsFormat, Utc};
use napi::{Error, Result, Status};
use rusqlite::{params, Connection, OptionalExtension, Row, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::storage::database;

mod schema;
pub use schema::ensure_image_generation_tables;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageGenerationTaskSnapshot {
    pub task_id: String,
    pub conversation_id: String,
    pub batch_id: String,
    pub interaction_id: String,
    pub call_id: String,
    pub status: String,
    pub asynchronous: bool,
    pub result_json: String,
    pub created_at: String,
    pub updated_at: String,
    pub duration_ms: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageGenerationBatchSnapshot {
    pub batch_id: String,
    pub conversation_id: String,
    pub sealed: bool,
    pub notified: bool,
    pub tasks: Vec<ImageGenerationTaskSnapshot>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageGenerationBatchRegistration {
    pub conversation_id: String,
    pub batch_id: String,
    pub members: Vec<ImageGenerationMember>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageGenerationMember {
    pub interaction_id: String,
    pub call_id: String,
}

pub struct PreparedImageGenerationTask {
    pub task: ImageGenerationTaskSnapshot,
    /// False means a duplicate submission must reuse the stored task, never pay again.
    pub execute: bool,
}

const TASK_COLUMNS: &str = "task_id, conversation_id, batch_id, interaction_id, call_id,
    status, asynchronous, result_json, created_at, updated_at, duration_ms";
static INSTANCE: OnceLock<String> = OnceLock::new();

fn instance() -> &'static str {
    INSTANCE.get_or_init(|| Uuid::new_v4().to_string())
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// Transition clocks are row-local and advance even within one millisecond or after wall-clock rollback.
fn transition_timestamp(previous: &str) -> rusqlite::Result<String> {
    let previous = chrono::DateTime::parse_from_rfc3339(previous)
        .map_err(|_| rusqlite::Error::InvalidQuery)?
        .with_timezone(&Utc);
    let next = previous
        .checked_add_signed(chrono::Duration::milliseconds(1))
        .ok_or(rusqlite::Error::InvalidQuery)?;
    Ok(Utc::now()
        .max(next)
        .to_rfc3339_opts(SecondsFormat::Millis, true))
}

fn next_task_timestamp(
    connection: &Connection,
    conversation_id: &str,
    task_id: &str,
) -> rusqlite::Result<String> {
    let previous: String = connection.query_row(
        "SELECT updated_at FROM image_generation_tasks WHERE conversation_id = ?1 AND task_id = ?2",
        params![conversation_id, task_id],
        |row| row.get(0),
    )?;
    transition_timestamp(&previous)
}

fn with_connection<T>(
    database_path: &Path,
    operation: impl FnOnce(&mut Connection) -> rusqlite::Result<T>,
) -> Result<T> {
    database::with_write_lock(|| {
        database::open_connection(database_path)
            .and_then(|mut connection| operation(&mut connection))
    })
    // Never expose SQL parameters (which can include generated content) in errors.
    .map_err(|_| Error::from_reason("Image generation storage operation failed"))
}

fn map_task(row: &Row<'_>) -> rusqlite::Result<ImageGenerationTaskSnapshot> {
    Ok(ImageGenerationTaskSnapshot {
        task_id: row.get(0)?,
        conversation_id: row.get(1)?,
        batch_id: row.get(2)?,
        interaction_id: row.get(3)?,
        call_id: row.get(4)?,
        status: row.get(5)?,
        asynchronous: row.get(6)?,
        result_json: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
        duration_ms: row.get::<_, i64>(10)?.max(0) as u64,
    })
}

fn task_with_connection(
    connection: &Connection,
    conversation_id: &str,
    task_id: &str,
) -> rusqlite::Result<Option<ImageGenerationTaskSnapshot>> {
    connection
        .query_row(
            &format!("SELECT {TASK_COLUMNS} FROM image_generation_tasks WHERE conversation_id = ?1 AND task_id = ?2"),
            params![conversation_id, task_id],
            map_task,
        )
        .optional()
}

fn batch_with_connection(
    connection: &Connection,
    conversation_id: &str,
    batch_id: &str,
) -> rusqlite::Result<ImageGenerationBatchSnapshot> {
    let (sealed, notified) = connection.query_row(
        "SELECT sealed, notified FROM image_generation_batches WHERE conversation_id = ?1 AND batch_id = ?2",
        params![conversation_id, batch_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let mut statement = connection.prepare(&format!(
        "SELECT {TASK_COLUMNS} FROM image_generation_tasks WHERE conversation_id = ?1 AND batch_id = ?2 ORDER BY created_at, rowid"
    ))?;
    let tasks = statement
        .query_map(params![conversation_id, batch_id], map_task)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(ImageGenerationBatchSnapshot {
        batch_id: batch_id.to_string(),
        conversation_id: conversation_id.to_string(),
        sealed,
        notified,
        tasks,
    })
}

fn insert_task(
    connection: &Connection,
    conversation_id: &str,
    batch_id: &str,
    interaction_id: &str,
    call_id: &str,
    timestamp: &str,
) -> rusqlite::Result<String> {
    let task_id = Uuid::new_v4().to_string();
    connection.execute(
        "INSERT INTO image_generation_tasks
            (task_id, conversation_id, batch_id, interaction_id, call_id, created_at, updated_at, owner_instance)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7)",
        params![task_id, conversation_id, batch_id, interaction_id, call_id, timestamp, instance()],
    )?;
    Ok(task_id)
}

pub fn register_batch(
    database_path: &Path,
    registration: ImageGenerationBatchRegistration,
) -> Result<ImageGenerationBatchSnapshot> {
    let mut interactions = HashSet::new();
    let mut calls = HashSet::new();
    if registration.batch_id.trim().is_empty()
        || registration.members.iter().any(|member| {
            member.interaction_id.trim().is_empty()
                || member.call_id.trim().is_empty()
                || !interactions.insert(member.interaction_id.as_str())
                || !calls.insert(member.call_id.as_str())
        })
    {
        return Err(Error::new(
            Status::InvalidArg,
            "Invalid image generation batch registration",
        ));
    }
    with_connection(database_path, |connection| {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing = transaction.query_row(
            "SELECT 1 FROM image_generation_batches WHERE conversation_id = ?1 AND batch_id = ?2",
            params![registration.conversation_id, registration.batch_id],
            |_| Ok(()),
        ).optional()?.is_some();
        if existing {
            let batch = batch_with_connection(
                &transaction,
                &registration.conversation_id,
                &registration.batch_id,
            )?;
            if batch.tasks.len() != registration.members.len()
                || registration.members.iter().any(|member| {
                    !batch.tasks.iter().any(|task| {
                        task.interaction_id == member.interaction_id
                            && task.call_id == member.call_id
                    })
                })
            {
                return Err(rusqlite::Error::InvalidQuery);
            }
            transaction.commit()?;
            return Ok(batch);
        }
        let timestamp = now();
        transaction.execute(
            "INSERT INTO image_generation_batches (conversation_id, batch_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
            params![registration.conversation_id, registration.batch_id, timestamp],
        )?;
        for member in &registration.members {
            insert_task(
                &transaction,
                &registration.conversation_id,
                &registration.batch_id,
                &member.interaction_id,
                &member.call_id,
                &timestamp,
            )?;
        }
        let batch = batch_with_connection(
            &transaction,
            &registration.conversation_id,
            &registration.batch_id,
        )?;
        transaction.commit()?;
        Ok(batch)
    })
}

/// Resolve only runtime conversation + interaction anchors; model batch/task metadata is never read.
pub fn prepare_task(
    database_path: &Path,
    conversation_id: &str,
    interaction_id: &str,
    asynchronous: bool,
) -> Result<PreparedImageGenerationTask> {
    with_connection(database_path, |connection| {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing = if interaction_id.is_empty() {
            None
        } else {
            transaction.query_row(
                &format!("SELECT {TASK_COLUMNS} FROM image_generation_tasks WHERE conversation_id = ?1 AND interaction_id = ?2"),
                params![conversation_id, interaction_id], map_task,
            ).optional()?
        };
        let task_id = if let Some(task) = existing {
            if task.status != "registered" {
                transaction.commit()?;
                return Ok(PreparedImageGenerationTask {
                    task,
                    execute: false,
                });
            }
            task.task_id
        } else {
            let batch_id = Uuid::new_v4().to_string();
            let timestamp = now();
            transaction.execute(
                "INSERT INTO image_generation_batches (conversation_id, batch_id, sealed, created_at, updated_at) VALUES (?1, ?2, 1, ?3, ?3)",
                params![conversation_id, batch_id, timestamp],
            )?;
            insert_task(
                &transaction,
                conversation_id,
                &batch_id,
                interaction_id,
                "",
                &timestamp,
            )?
        };
        transaction.execute(
            "UPDATE image_generation_tasks SET status = 'queued', asynchronous = ?1, updated_at = ?2, owner_instance = ?3
             WHERE conversation_id = ?4 AND task_id = ?5 AND status = 'registered'",
            params![asynchronous, next_task_timestamp(&transaction, conversation_id, &task_id)?, instance(), conversation_id, task_id],
        )?;
        let task = task_with_connection(&transaction, conversation_id, &task_id)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
        transaction.commit()?;
        Ok(PreparedImageGenerationTask {
            task,
            execute: true,
        })
    })
}

pub fn mark_running(
    database_path: &Path,
    conversation_id: &str,
    task_id: &str,
) -> Result<Option<ImageGenerationTaskSnapshot>> {
    with_connection(database_path, |connection| {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let task = task_with_connection(&transaction, conversation_id, task_id)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
        let owned: bool = transaction.query_row(
            "SELECT owner_instance = ?1 FROM image_generation_tasks WHERE conversation_id = ?2 AND task_id = ?3",
            params![instance(), conversation_id, task_id], |row| row.get(0),
        )?;
        if !owned || !matches!(task.status.as_str(), "queued" | "running") {
            return Err(rusqlite::Error::InvalidQuery);
        }
        if task.status == "running" {
            transaction.commit()?;
            return Ok(None);
        }
        let changed = transaction.execute(
            "UPDATE image_generation_tasks SET status = 'running', updated_at = ?1
             WHERE conversation_id = ?2 AND task_id = ?3 AND status = 'queued' AND owner_instance = ?4",
            params![transition_timestamp(&task.updated_at)?, conversation_id, task_id, instance()],
        )?;
        if changed != 1 {
            return Err(rusqlite::Error::InvalidQuery);
        }
        let running = task_with_connection(&transaction, conversation_id, task_id)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
        transaction.commit()?;
        Ok(Some(running))
    })
}

pub fn complete_task(
    database_path: &Path,
    conversation_id: &str,
    task_id: &str,
    status: &str,
    result_json: &str,
    duration_ms: u64,
) -> Result<ImageGenerationTaskSnapshot> {
    if !matches!(status, "completed" | "failed" | "cancelled")
        || serde_json::from_str::<Value>(result_json).is_err()
    {
        return Err(Error::new(
            Status::InvalidArg,
            "Invalid image generation terminal result",
        ));
    }
    with_connection(database_path, |connection| {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            "UPDATE image_generation_tasks SET status = ?1, result_json = ?2, duration_ms = ?3, updated_at = ?4
             WHERE conversation_id = ?5 AND task_id = ?6 AND status IN ('queued', 'running') AND owner_instance = ?7",
            params![status, result_json, duration_ms.min(i64::MAX as u64) as i64, next_task_timestamp(&transaction, conversation_id, task_id)?, conversation_id, task_id, instance()],
        )?;
        let task = task_with_connection(&transaction, conversation_id, task_id)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
        if !is_terminal(&task.status) {
            return Err(rusqlite::Error::InvalidQuery);
        }
        transaction.commit()?;
        Ok(task)
    })
}

pub fn is_terminal(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "cancelled")
}

pub fn failure_result(
    task: &ImageGenerationTaskSnapshot,
    code: &str,
    message: &str,
    status: &str,
) -> Value {
    json!({
        "status": status, "isError": true, "error": message, "errorCode": code,
        "taskId": task.task_id, "batchId": task.batch_id, "conversationId": task.conversation_id,
        "interactionId": task.interaction_id, "callId": task.call_id,
        "asynchronous": task.asynchronous, "durationMs": task.duration_ms,
        "imageCount": 0, "content": [{ "type": "text", "text": message }], "contentPreview": message,
    })
}

pub fn seal_batch(
    database_path: &Path,
    conversation_id: &str,
    batch_id: &str,
) -> Result<ImageGenerationBatchSnapshot> {
    with_connection(database_path, |connection| {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let batch = batch_with_connection(&transaction, conversation_id, batch_id)?;
        let timestamp = now();
        for task in batch
            .tasks
            .iter()
            .filter(|task| task.status == "registered")
        {
            let result = failure_result(
                task,
                "submission_cancelled",
                "Image generation was cancelled before submission.",
                "cancelled",
            );
            transaction.execute(
                "UPDATE image_generation_tasks SET status = 'cancelled', result_json = ?1, updated_at = ?2
                 WHERE conversation_id = ?3 AND task_id = ?4 AND status = 'registered'",
                params![result.to_string(), transition_timestamp(&task.updated_at)?, conversation_id, task.task_id],
            )?;
        }
        transaction.execute(
            "UPDATE image_generation_batches SET sealed = 1, updated_at = ?1 WHERE conversation_id = ?2 AND batch_id = ?3",
            params![timestamp, conversation_id, batch_id],
        )?;
        let batch = batch_with_connection(&transaction, conversation_id, batch_id)?;
        transaction.commit()?;
        Ok(batch)
    })
}

pub fn list_batches(
    database_path: &Path,
    conversation_id: &str,
) -> Result<Vec<ImageGenerationBatchSnapshot>> {
    with_connection(database_path, |connection| {
        // Read transaction keeps the batch flags and task snapshots coherent without recovery writes.
        let transaction = connection.transaction()?;
        let batch_ids = {
            let mut statement = transaction.prepare("SELECT batch_id FROM image_generation_batches WHERE conversation_id = ?1 ORDER BY created_at, rowid")?;
            let ids = statement
                .query_map([conversation_id], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            ids
        };
        let batches = batch_ids
            .iter()
            .map(|id| batch_with_connection(&transaction, conversation_id, id))
            .collect::<rusqlite::Result<Vec<_>>>()?;
        transaction.commit()?;
        Ok(batches)
    })
}

pub fn get_task(
    database_path: &Path,
    conversation_id: &str,
    task_id: &str,
) -> Result<Option<ImageGenerationTaskSnapshot>> {
    with_connection(database_path, |connection| {
        task_with_connection(connection, conversation_id, task_id)
    })
}

pub fn claim_notification(
    database_path: &Path,
    conversation_id: &str,
    batch_id: &str,
) -> Result<bool> {
    if conversation_id.is_empty() {
        return Ok(false);
    }
    with_connection(database_path, |connection| {
        let updated = connection.execute(
            "UPDATE image_generation_batches SET notified = 1, updated_at = ?1
             WHERE conversation_id = ?2 AND batch_id = ?3 AND sealed = 1 AND notified = 0
               AND EXISTS (SELECT 1 FROM image_generation_tasks t WHERE t.conversation_id = ?2 AND t.batch_id = ?3 AND t.asynchronous = 1)
               AND NOT EXISTS (SELECT 1 FROM image_generation_tasks t WHERE t.conversation_id = ?2 AND t.batch_id = ?3 AND t.status NOT IN ('completed', 'failed', 'cancelled'))",
            params![now(), conversation_id, batch_id],
        )?;
        Ok(updated == 1)
    })
}

pub fn release_notification(
    database_path: &Path,
    conversation_id: &str,
    batch_id: &str,
) -> Result<()> {
    with_connection(database_path, |connection| {
        connection.execute(
            "UPDATE image_generation_batches SET notified = 0, updated_at = ?1 WHERE conversation_id = ?2 AND batch_id = ?3",
            params![now(), conversation_id, batch_id],
        )?;
        Ok(())
    })
}

/// Explicit startup-only reconciliation. Never called by read APIs or initialize_app_storage.
pub fn recover_interrupted_tasks(database_path: &Path) -> Result<u32> {
    with_connection(database_path, |connection| {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let tasks = {
            let mut statement = transaction.prepare(&format!(
                "SELECT {TASK_COLUMNS} FROM image_generation_tasks WHERE status IN ('registered', 'queued', 'running') AND owner_instance <> ?1"
            ))?;
            let tasks = statement
                .query_map([instance()], map_task)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            tasks
        };
        let timestamp = now();
        for task in &tasks {
            let result = failure_result(
                task,
                "interrupted",
                "Image generation was interrupted by app shutdown. It was not retried.",
                "failed",
            );
            transaction.execute(
                "UPDATE image_generation_tasks SET status = 'failed', result_json = ?1, updated_at = ?2 WHERE conversation_id = ?3 AND task_id = ?4",
                params![result.to_string(), transition_timestamp(&task.updated_at)?, task.conversation_id, task.task_id],
            )?;
            transaction.execute(
                "UPDATE image_generation_batches SET sealed = 1, updated_at = ?1 WHERE conversation_id = ?2 AND batch_id = ?3",
                params![timestamp, task.conversation_id, task.batch_id],
            )?;
        }
        // A crash can occur after the final task commits but before the executor's finally seals.
        transaction.execute(
            "UPDATE image_generation_batches SET sealed = 1, updated_at = ?1
             WHERE sealed = 0 AND NOT EXISTS (SELECT 1 FROM image_generation_tasks t
                WHERE t.conversation_id = image_generation_batches.conversation_id
                  AND t.batch_id = image_generation_batches.batch_id AND t.owner_instance = ?2)",
            params![timestamp, instance()],
        )?;
        transaction.commit()?;
        Ok(tasks.len().min(u32::MAX as usize) as u32)
    })
}
