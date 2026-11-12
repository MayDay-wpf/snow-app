//! Durable task supervisor. Caller cancellation drops only the receipt waiter, not the paid request.

use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Instant,
};

use chrono::{SecondsFormat, Utc};
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use tokio::sync::oneshot;

use super::*;
use crate::storage::services::image_generation::{self as tasks, ImageGenerationTaskSnapshot};
use crate::utils::panic_guard::guard_panic;

const FINALIZATION_TIMEOUT_SECS: u64 = 60;

struct TaskCancellation {
    task_id: String,
    token: tokio_util::sync::CancellationToken,
}

impl TaskCancellation {
    fn new(task_id: &str) -> Self {
        Self {
            task_id: task_id.to_string(),
            token: crate::api::cancel::register_tool_execution(task_id),
        }
    }
}

impl Drop for TaskCancellation {
    fn drop(&mut self) {
        crate::api::cancel::unregister_tool_execution(&self.task_id);
    }
}

#[derive(Clone)]
struct Admission {
    task: ImageGenerationTaskSnapshot,
    execute: bool,
    timeout_secs: u64,
    budget_ms: u64,
    deadline_at: String,
}

impl Admission {
    fn pending(&self) -> Value {
        json!({
            "status": "pending", "taskId": self.task.task_id,
            "batchId": self.task.batch_id, "conversationId": self.task.conversation_id,
            "interactionId": self.task.interaction_id, "callId": self.task.call_id,
            "asynchronous": self.task.asynchronous,
            "timeoutSecs": self.timeout_secs, "budgetMs": self.budget_ms,
            "deadlineAt": self.deadline_at, "task": self.task,
            "content": [{ "type": "text", "text": "Image generation accepted. The persisted task, not this receipt, determines completion." }],
            "contentPreview": "Image generation accepted and is pending completion."
        })
    }
}

impl ImageGenService {
    pub async fn execute_generate(
        &self,
        args: &Value,
        on_chunk: BashStreamCallback,
    ) -> napi::Result<Value> {
        let args = args.clone();
        // NAPI 3 TSFs are not Clone. One Arc owns the real callback through previews and terminal enqueue.
        let on_chunk = Arc::new(on_chunk);
        let (admission_tx, admission_rx) = oneshot::channel();
        let (finished_tx, finished_rx) = oneshot::channel();
        // Admission itself is detached so cancellation during SQLite's queued commit cannot orphan a task.
        tokio::spawn(async move {
            let result = supervise(args, on_chunk, admission_tx).await;
            let _ = finished_tx.send(result);
        });
        let admission = admission_rx
            .await
            .map_err(|_| Error::from_reason("Image generation admission worker stopped"))??;
        if tasks::is_terminal(&admission.task.status) {
            return stored_result(&admission.task);
        }
        if admission.task.asynchronous || !admission.execute {
            return Ok(admission.pending());
        }
        finished_rx
            .await
            .map_err(|_| Error::from_reason("Image generation worker stopped"))?
    }
}

/// Called only after a provider image request acquires its real upstream permit.
/// The SQLite transition is idempotent, so legacy fan-out emits its first running snapshot once.
pub(super) async fn request_started(
    args: &Value,
    on_chunk: Option<&BashStreamCallback>,
) -> napi::Result<()> {
    let context = args
        .get("__snowImageGeneration")
        .ok_or_else(|| Error::from_reason("Image generation runtime task context is missing"))?;
    let conversation_id = context
        .get("conversationId")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::from_reason("Image generation runtime conversation is missing"))?
        .to_string();
    let task_id = context
        .get("taskId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| Error::from_reason("Image generation runtime task is missing"))?
        .to_string();
    let (path, running) = tokio::task::spawn_blocking(move || {
        let path = crate::storage::ensure_database_file()?;
        let running = tasks::mark_running(&path, &conversation_id, &task_id)?;
        Ok::<_, napi::Error>((path, running))
    })
    .await
    .map_err(|_| Error::from_reason("Image generation start worker failed"))??;
    if let Some(running) = running {
        log_stage(&path, &running, "generation_started", None);
        if let Some(on_chunk) = on_chunk {
            emit_snapshot(&path, on_chunk, &running);
        }
    }
    Ok(())
}

async fn supervise(
    args: Value,
    on_chunk: Arc<BashStreamCallback>,
    admission_tx: oneshot::Sender<napi::Result<Admission>>,
) -> napi::Result<Value> {
    let setup = guard_panic(async {
        let (database_path, settings) = tokio::task::spawn_blocking(|| {
            let path = crate::storage::ensure_database_file()?;
            Ok::<_, napi::Error>((path, load_imagegen_settings()))
        })
        .await
        .map_err(|_| Error::from_reason("Image generation setup worker failed"))??;
        let context = args.get("__snowImageGeneration");
        let conversation_id = context
            .and_then(|value| value.get("conversationId"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let interaction_id = context
            .and_then(|value| value.get("interactionId"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let asynchronous = settings
            .as_ref()
            .ok()
            .is_some_and(|settings| options::asynchronous(&args, settings));
        let timeout_secs = settings
            .as_ref()
            .ok()
            .and_then(|value| value.timeout_secs)
            .unwrap_or(REQUEST_TIMEOUT_SECS)
            .clamp(MIN_TIMEOUT_SECS, MAX_TIMEOUT_SECS);
        let concurrency = limiter::configure(
            settings
                .as_ref()
                .ok()
                .and_then(|value| value.max_concurrent_images),
        );
        let count = args
            .get("prompts")
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or_else(|| {
                args.get("n")
                    .and_then(Value::as_u64)
                    .unwrap_or(DEFAULT_N as u64) as usize
            })
            .clamp(1, MAX_PARALLEL_IMAGES);
        let waves = count.div_ceil(concurrency) as u64;
        // Includes a bounded queue allowance, a single compatibility retry per image,
        // downloads, privacy and SQLite finalization. It never repeats a timed-out paid request.
        let budget_secs = (timeout_secs * (waves * 2 + 1)
            + REMOTE_IMAGE_TIMEOUT_SECS * count as u64
            + FINALIZATION_TIMEOUT_SECS)
            .min(MAX_TIMEOUT_SECS * 4);
        let path = database_path.clone();
        let prepared = tokio::task::spawn_blocking(move || {
            tasks::prepare_task(&path, &conversation_id, &interaction_id, asynchronous)
        })
        .await
        .map_err(|_| Error::from_reason("Image generation task registration worker failed"))??;
        let deadline_at = (Utc::now() + chrono::Duration::seconds(budget_secs as i64))
            .to_rfc3339_opts(SecondsFormat::Millis, true);
        Ok((
            database_path,
            settings,
            Admission {
                task: prepared.task,
                execute: prepared.execute,
                timeout_secs,
                budget_ms: budget_secs * 1000,
                deadline_at,
            },
        ))
    })
    .await;
    let (database_path, settings, admission) = match setup {
        Ok(value) => value,
        Err(_) => {
            let _ = admission_tx.send(Err(Error::from_reason(
                "Image generation could not be registered",
            )));
            return Err(Error::from_reason(
                "Image generation could not be registered",
            ));
        }
    };
    let _ = admission_tx.send(Ok(admission.clone()));
    if !admission.execute {
        return if tasks::is_terminal(&admission.task.status) {
            stored_result(&admission.task)
        } else {
            Ok(admission.pending())
        };
    }
    let started = Instant::now();
    // The generation worker is spawned only after prepare_task committed queued.
    // The outer admission supervisor merely prevents invoke cancellation from orphaning that commit.
    let worker_path = database_path.clone();
    let worker_admission = admission.clone();
    let worker_callback = Arc::clone(&on_chunk);
    let result = tokio::spawn(async move {
        guard_panic(execute_admitted(
            &worker_path,
            &args,
            &settings,
            &worker_admission,
            &worker_callback,
            started,
        ))
        .await
    })
    .await
    .unwrap_or_else(|_| Err(Error::from_reason("Image generation worker stopped")));
    match result {
        Ok(value) => Ok(value),
        Err(_) => {
            // Includes panic or failed success persistence. Never emit an uncommitted success.
            let failure = tasks::failure_result(&admission.task, "terminal_persistence_failed",
                "Image generation could not commit its final result. The paid request was not retried.", "failed");
            match commit_result(
                &database_path,
                &admission.task,
                failure,
                started.elapsed().as_millis() as u64,
            )
            .await
            {
                Ok(task) => {
                    log_stage(&database_path, &task, "terminal_committed", None);
                    emit_snapshot(&database_path, &on_chunk, &task);
                    stored_result(&task)
                }
                Err(_) => {
                    log_stage(
                        &database_path,
                        &admission.task,
                        "terminal_persistence_failed",
                        Some("unavailable"),
                    );
                    // No invented terminal task snapshot. Startup recovery handles a restored database.
                    Err(Error::from_reason("Image generation final status could not be persisted; no success was acknowledged"))
                }
            }
        }
    }
}

async fn execute_admitted(
    database_path: &Path,
    args: &Value,
    settings: &napi::Result<ImageGenSettings>,
    admission: &Admission,
    on_chunk: &BashStreamCallback,
    started: Instant,
) -> napi::Result<Value> {
    log_stage(database_path, &admission.task, "submission_committed", None);
    emit_snapshot(database_path, on_chunk, &admission.task);
    let cancellation = TaskCancellation::new(&admission.task.task_id);
    let enqueue_status = on_chunk.call(
        BashStreamChunk {
            stream: "tool_execution".to_string(),
            data: admission.task.task_id.clone(),
        },
        ThreadsafeFunctionCallMode::NonBlocking,
    );
    log_stage(
        database_path,
        &admission.task,
        "cancellation_handle_enqueue",
        Some(&format!("{enqueue_status:?}")),
    );
    let mut request_args = args.clone();
    // Only the accepted, persisted runtime task can supply the provider's lifecycle anchor.
    request_args["__snowImageGeneration"] = json!({
        "conversationId": admission.task.conversation_id,
        "interactionId": admission.task.interaction_id,
        "taskId": admission.task.task_id,
        "batchId": admission.task.batch_id,
    });
    let generated = guard_panic(async {
        let settings = settings.as_ref().map_err(|_| Error::from_reason("Image generation settings could not be loaded"))?;
        let service = ImageGenService::new();
        tokio::select! {
            biased;
            _ = cancellation.token.cancelled() => Ok(tasks::failure_result(&admission.task,
                "cancelled", "Image generation was cancelled. The request was not retried.", "cancelled")),
            outcome = tokio::time::timeout(
                Duration::from_millis(admission.budget_ms.saturating_sub(FINALIZATION_TIMEOUT_SECS * 1000)),
                service.generate_with_settings(&request_args, Some(on_chunk), settings),
            ) => outcome.map_err(|_| Error::from_reason("Image generation exceeded its overall task budget; it was not retried"))?,
        }
    }).await;
    let settings = settings.as_ref().ok();
    let result = match generated {
        Ok(value) => value,
        Err(error) => tasks::failure_result(
            &admission.task,
            "generation_failed",
            &result_privacy::safe_error(&error, settings),
            "failed",
        ),
    };
    let result = match tokio::time::timeout(
        Duration::from_secs(FINALIZATION_TIMEOUT_SECS),
        guard_panic(result_privacy::mask_result(result, settings)),
    )
    .await
    {
        Ok(Ok(value)) => value,
        _ => tasks::failure_result(
            &admission.task,
            "privacy_filter_failed",
            "Image generation result privacy filtering failed. The request was not retried.",
            "failed",
        ),
    };
    let task = commit_result(
        database_path,
        &admission.task,
        result,
        started.elapsed().as_millis() as u64,
    )
    .await?;
    log_stage(database_path, &task, "terminal_committed", None);
    emit_snapshot(database_path, on_chunk, &task);
    stored_result(&task)
}

async fn commit_result(
    database_path: &Path,
    task: &ImageGenerationTaskSnapshot,
    mut result: Value,
    duration_ms: u64,
) -> napi::Result<ImageGenerationTaskSnapshot> {
    let status = if result.get("status").and_then(Value::as_str) == Some("cancelled") {
        "cancelled"
    } else if result
        .get("isError")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        "failed"
    } else {
        "completed"
    };
    result["status"] = json!(status);
    result["taskId"] = json!(task.task_id);
    result["batchId"] = json!(task.batch_id);
    result["conversationId"] = json!(task.conversation_id);
    result["interactionId"] = json!(task.interaction_id);
    result["callId"] = json!(task.call_id);
    result["asynchronous"] = json!(task.asynchronous);
    result["durationMs"] = json!(duration_ms);
    let path = database_path.to_path_buf();
    let task = task.clone();
    tokio::task::spawn_blocking(move || {
        // Finite retries cover transient locks without repeating the upstream request.
        let mut last_error = None;
        for _ in 0..2 {
            match tasks::complete_task(
                &path,
                &task.conversation_id,
                &task.task_id,
                status,
                &result.to_string(),
                duration_ms,
            ) {
                Ok(task) => return Ok(task),
                Err(error) => last_error = Some(error),
            }
        }
        Err(last_error
            .unwrap_or_else(|| Error::from_reason("Image generation terminal persistence failed")))
    })
    .await
    .map_err(|_| Error::from_reason("Image generation persistence worker failed"))?
}

fn stored_result(task: &ImageGenerationTaskSnapshot) -> napi::Result<Value> {
    serde_json::from_str(&task.result_json)
        .map_err(|_| Error::from_reason("Image generation stored result is unavailable"))
}

fn emit_snapshot(
    database_path: &Path,
    on_chunk: &BashStreamCallback,
    task: &ImageGenerationTaskSnapshot,
) {
    let result: Value = serde_json::from_str(&task.result_json).unwrap_or(Value::Null);
    let paths: Vec<&str> = result
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("image"))
        .filter_map(|block| {
            block
                .get("absolutePath")
                .or_else(|| block.get("path"))
                .and_then(Value::as_str)
        })
        .collect();
    let event = json!({
        "type": if task.status == "cancelled" { "failed" } else { task.status.as_str() },
        "taskId": task.task_id, "batchId": task.batch_id,
        "conversationId": task.conversation_id, "interactionId": task.interaction_id, "callId": task.call_id,
        "paths": paths, "result": task.result_json, "durationMs": task.duration_ms,
        "isError": task.status == "failed" || task.status == "cancelled", "task": task,
    });
    let status = on_chunk.call(
        BashStreamChunk {
            stream: "imagegen".to_string(),
            data: event.to_string(),
        },
        ThreadsafeFunctionCallMode::NonBlocking,
    );
    log_stage(
        database_path,
        task,
        "tsf_enqueue",
        Some(&format!("{status:?}")),
    );
}

fn log_stage(
    database_path: &Path,
    task: &ImageGenerationTaskSnapshot,
    stage: &str,
    enqueue_status: Option<&str>,
) {
    let path: PathBuf = database_path.to_path_buf();
    let context = json!({
        "conversation_id": task.conversation_id, "taskId": task.task_id, "batchId": task.batch_id,
        "interactionId": task.interaction_id, "callId": task.call_id, "status": task.status,
        "asynchronous": task.asynchronous, "stage": stage, "enqueueStatus": enqueue_status,
    })
    .to_string();
    let level = if stage == "terminal_persistence_failed" {
        "ERROR"
    } else if enqueue_status.is_some_and(|status| status != "Ok") || task.status == "cancelled" {
        "WARN"
    } else if task.status == "failed" {
        "ERROR"
    } else {
        "INFO"
    };
    let stage = stage.to_string();
    let duration = task.duration_ms.to_string();
    tokio::task::spawn_blocking(move || {
        use crate::storage::services::app_logs::{insert_app_log, AppLogInput};
        let _ = insert_app_log(
            &path,
            &AppLogInput {
                level: level.to_string(),
                module: "mcp/imagegen".to_string(),
                func: stage.clone(),
                line: None,
                message: stage,
                input: None,
                output: None,
                duration: Some(duration),
                context: Some(context),
                error: None,
                source: "main".to_string(),
            },
        );
    });
}
