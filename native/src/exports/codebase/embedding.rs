//! 嵌入会话注册表、设置解析与全量嵌入主流程。

use super::*;

// ============================================================================
// 暂停/继续/取消注册表
// ============================================================================

/// State for a single embedding session, supporting pause/resume/cancel.
struct EmbeddingSession {
    cancel_token: CancellationToken,
    pause_token: Arc<Notify>,
    is_paused: bool,
    project_id: String,
}

impl EmbeddingSession {
    fn new(project_id: String) -> Self {
        Self {
            cancel_token: CancellationToken::new(),
            pause_token: Arc::new(Notify::new()),
            is_paused: false,
            project_id,
        }
    }
}

static EMBED_SESSIONS: Mutex<Option<HashMap<String, EmbeddingSession>>> = Mutex::new(None);

fn with_sessions<F, R>(f: F) -> R
where
    F: FnOnce(&mut HashMap<String, EmbeddingSession>) -> R,
{
    let mut guard = EMBED_SESSIONS
        .lock()
        .expect("Embedding sessions mutex poisoned");
    let sessions = guard.get_or_insert_with(HashMap::new);
    f(sessions)
}

fn register_session(session_id: &str, project_id: &str) {
    with_sessions(|sessions| {
        sessions.insert(
            session_id.to_string(),
            EmbeddingSession::new(project_id.to_string()),
        );
    });
}

fn unregister_session(session_id: &str) {
    with_sessions(|sessions| {
        sessions.remove(session_id);
    });
}

fn cancel_session(session_id: &str) -> bool {
    with_sessions(|sessions| {
        if let Some(session) = sessions.get(session_id) {
            session.cancel_token.cancel();
            // Also unpause to let the loop exit
            session.pause_token.notify_waiters();
            true
        } else {
            false
        }
    })
}

fn pause_session(session_id: &str) -> bool {
    with_sessions(|sessions| {
        if let Some(session) = sessions.get_mut(session_id) {
            session.is_paused = true;
            true
        } else {
            false
        }
    })
}

fn resume_session(session_id: &str) -> bool {
    with_sessions(|sessions| {
        if let Some(session) = sessions.get_mut(session_id) {
            session.is_paused = false;
            session.pause_token.notify_waiters();
            true
        } else {
            false
        }
    })
}

fn is_cancelled(session_id: &str) -> bool {
    with_sessions(|sessions| {
        sessions
            .get(session_id)
            .map(|s| s.cancel_token.is_cancelled())
            .unwrap_or(true)
    })
}

fn is_paused(session_id: &str) -> bool {
    with_sessions(|sessions| {
        sessions
            .get(session_id)
            .map(|s| s.is_paused)
            .unwrap_or(false)
    })
}

/// Check whether any embedding session is currently active (running or
/// paused) for the given project. This queries the in-memory session
/// registry, NOT the database — so it reflects the true live state of
/// background embeddings even after the user switches projects.
fn is_embedding_active_for_project(project_id: &str) -> bool {
    with_sessions(|sessions| sessions.values().any(|s| s.project_id == project_id))
}

/// Check whether the shared abort flag (error-triggered shutdown) is set.
/// Used by concurrent embedding tasks to detect that a sibling has failed
/// and they should stop starting new batches. Handles a poisoned mutex by
/// treating it as "aborted" so a panic in one task doesn't deadlock others.
fn is_abort_set(abort_flag: &Mutex<bool>) -> bool {
    match abort_flag.lock() {
        Ok(guard) => *guard,
        Err(poisoned) => *poisoned.into_inner(),
    }
}

/// Wait while paused. Returns Err if cancelled during the wait.
async fn wait_if_paused(session_id: &str) -> Result<()> {
    loop {
        if is_cancelled(session_id) {
            return Err(Error::from_reason("Embedding cancelled"));
        }
        if !is_paused(session_id) {
            return Ok(());
        }
        // Wait for resume notification
        let notify = with_sessions(|sessions| {
            sessions
                .get(session_id)
                .map(|s| s.pause_token.clone())
                .ok_or_else(|| Error::from_reason("Session not found"))
        })?;
        // Use a short timeout to periodically check cancellation
        tokio::select! {
            _ = notify.notified() => {}
            _ = tokio::time::sleep(std::time::Duration::from_millis(200)) => {}
        }
    }
}

// ============================================================================
// Codebase 设置解析
// ============================================================================

/// Parsed codebase settings from the system_settings JSON.
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct CodebaseSettings {
    pub(crate) embedding_type: String,
    pub(crate) embedding_model_name: String,
    pub(crate) embedding_base_url: String,
    pub(crate) embedding_api_key: String,
    pub(crate) embedding_dimensions: i32,
    pub(crate) batch_max_lines: i32,
    pub(crate) batch_concurrency: i32,
    pub(crate) chunking_max_lines_per_chunk: i32,
    pub(crate) chunking_min_lines_per_chunk: i32,
    pub(crate) chunking_min_chars_per_chunk: i32,
    pub(crate) chunking_overlap_lines: i32,
    pub(crate) model_context_length: i32,
}

pub(crate) fn load_codebase_settings(database_path: &Path) -> Result<CodebaseSettings> {
    // 选中的嵌入模型在这里展开成内联字段。
    let resolved =
        crate::storage::services::system_settings::load_resolved_codebase_settings(database_path)?;
    let settings: CodebaseSettings = serde_json::from_value(resolved).map_err(|error| {
        Error::from_reason(format!("Failed to parse codebase settings: {error}"))
    })?;
    Ok(settings)
}

// ============================================================================
// NAPI 导出函数
// ============================================================================

type EmbedProgressCallback = ThreadsafeFunction<
    CodebaseEmbedProgress,
    Unknown<'static>,
    CodebaseEmbedProgress,
    Status,
    false,
>;

/// A file's scanned metadata, its chunked content, and the raw source text.
/// Used as the unit of work for concurrent embedding — each `FileChunks` is
/// embedded independently by `embed_single_file`, with up to
/// `batch_concurrency` files processed in parallel.
pub(crate) struct FileChunks {
    pub(crate) file: ScannedFile,
    pub(crate) chunks: Vec<crate::storage::services::code_chunker::CodeChunk>,
    pub(crate) content: String,
}

/// Start embedding a project's codebase.
///
/// This function runs entirely on the tokio runtime and never blocks the
/// Node.js main thread. Progress is reported via the `onProgress` callback.
///
/// The `sessionId` is used to identify this embedding session for
/// pause/resume/cancel operations.
#[napi(
    ts_args_type = "projectId: string, sessionId: string, onProgress: (progress: CodebaseEmbedProgress) => void"
)]
pub async fn start_codebase_embedding(
    project_id: String,
    session_id: String,
    on_progress: EmbedProgressCallback,
) -> Result<()> {
    register_session(&session_id, &project_id);

    let start_time = std::time::Instant::now();

    // Check for early cancellation
    if is_cancelled(&session_id) {
        // We have no database path yet — just send a progress event and exit.
        let progress = CodebaseEmbedProgress {
            phase: "cancelled".to_string(),
            total_files: 0,
            processed_files: 0,
            total_chunks: 0,
            processed_chunks: 0,
            current_file: String::new(),
            error: String::new(),
            elapsed_ms: start_time.elapsed().as_millis() as i64,
        };
        let _ = on_progress.call(progress, ThreadsafeFunctionCallMode::NonBlocking);
        unregister_session(&session_id);
        return Ok(());
    }

    let storage_info = crate::storage::initialize_app_storage()?;
    let database_path = PathBuf::from(&storage_info.database_path);

    // Persist the session as "running" so that pause state survives app
    // restarts and unexpected crashes. Any previous record for this session
    // id is replaced.
    {
        let db_path = database_path.clone();
        let sid = session_id.clone();
        let pid = project_id.clone();
        let now = chrono::Utc::now()
            .naive_utc()
            .format("%Y-%m-%d %H:%M:%S")
            .to_string();
        let record = EmbedSessionRecord {
            session_id: sid,
            project_id: pid,
            status: codebase_embed_sessions::STATUS_RUNNING.to_string(),
            total_files: 0,
            processed_files: 0,
            total_chunks: 0,
            processed_chunks: 0,
            current_file: String::new(),
            error: String::new(),
            created_at: now.clone(),
            updated_at: now,
        };
        tokio::task::spawn_blocking(move || {
            // A new run supersedes the failure kept from an earlier run.
            codebase_embed_sessions::delete_error_sessions_except(
                &db_path,
                &record.project_id,
                &record.session_id,
            )?;
            codebase_embed_sessions::upsert_session(&db_path, &record)
        })
        .await
        .map_err(|e| Error::from_reason(format!("Failed to persist session: {e}")))??;
    }

    // Send a progress event to the frontend AND persist the current state to
    // the database. The persistence is fire-and-forget (spawn_blocking without
    // await) so it never blocks the embedding loop. Terminal phases
    // (done/error/cancelled) also update the session status or delete the
    // record so that `list_resumable_sessions` returns accurate results. A
    // failed run is kept (latest one per project) so the error can be reviewed
    // after the panel is closed or the app restarts, and is written to the
    // system log.
    let send_progress = {
        let db_path = database_path.clone();
        let sid = session_id.clone();
        let pid = project_id.clone();
        move |phase: &str,
              total_files: i32,
              processed_files: i32,
              total_chunks: i32,
              processed_chunks: i32,
              current_file: &str,
              error: &str| {
            let progress = CodebaseEmbedProgress {
                phase: phase.to_string(),
                total_files,
                processed_files,
                total_chunks,
                processed_chunks,
                current_file: current_file.to_string(),
                error: error.to_string(),
                elapsed_ms: start_time.elapsed().as_millis() as i64,
            };
            let _ = on_progress.call(progress, ThreadsafeFunctionCallMode::NonBlocking);

            // Persist progress / status. Fire-and-forget.
            let db_path = db_path.clone();
            let sid = sid.clone();
            let pid = pid.clone();
            let phase_owned = phase.to_string();
            let current_file_owned = current_file.to_string();
            let error_owned = error.to_string();
            tokio::task::spawn_blocking(move || {
                match phase_owned.as_str() {
                    "done" => {
                        let _ = codebase_embed_sessions::update_session_status(
                            &db_path,
                            &sid,
                            codebase_embed_sessions::STATUS_DONE,
                            None,
                        );
                        // Keep the record briefly so the frontend can read the
                        // final state, then delete it. We delete immediately
                        // since the frontend gets the terminal progress event
                        // directly.
                        let _ = codebase_embed_sessions::delete_session(&db_path, &sid);
                    }
                    "error" => {
                        // 先落进度，使 current_file 指向实际失败的文件
                        let _ = codebase_embed_sessions::update_session_progress(
                            &db_path,
                            &sid,
                            total_files,
                            processed_files,
                            total_chunks,
                            processed_chunks,
                            &current_file_owned,
                        );
                        // Keep the failed run (only the latest per project) so
                        // the panel can show it again later.
                        let _ = codebase_embed_sessions::update_session_status(
                            &db_path,
                            &sid,
                            codebase_embed_sessions::STATUS_ERROR,
                            Some(&error_owned),
                        );
                        let _ = codebase_embed_sessions::delete_error_sessions_except(
                            &db_path, &pid, &sid,
                        );
                        let _ = crate::storage::services::app_logs::insert_app_log(
                            &db_path,
                            &crate::storage::services::app_logs::AppLogInput {
                                level: "ERROR".to_string(),
                                module: "embedding".to_string(),
                                func: "codebase_index".to_string(),
                                line: None,
                                message: "Codebase indexing failed".to_string(),
                                input: None,
                                output: None,
                                duration: None,
                                context: Some(
                                    serde_json::json!({
                                        "projectId": pid,
                                        "sessionId": sid,
                                        "processedFiles": processed_files,
                                        "totalFiles": total_files,
                                        "processedChunks": processed_chunks,
                                        "totalChunks": total_chunks,
                                        "currentFile": current_file_owned,
                                    })
                                    .to_string(),
                                ),
                                error: Some(error_owned.clone()),
                                source: "main".to_string(),
                            },
                        );
                    }
                    "cancelled" => {
                        let _ = codebase_embed_sessions::delete_session(&db_path, &sid);
                    }
                    _ => {
                        // Non-terminal phase — just update progress fields.
                        let _ = codebase_embed_sessions::update_session_progress(
                            &db_path,
                            &sid,
                            total_files,
                            processed_files,
                            total_chunks,
                            processed_chunks,
                            &current_file_owned,
                        );
                    }
                }
            });
        }
    };

    // Load codebase settings
    let settings = {
        let db_path = database_path.clone();
        tokio::task::spawn_blocking(move || load_codebase_settings(&db_path))
            .await
            .map_err(|e| Error::from_reason(format!("Failed to load settings: {e}")))?
            .map_err(|e| e)?
    };

    // Validate embedding config
    if settings.embedding_model_name.is_empty() && settings.embedding_base_url.is_empty() {
        let msg = "Embedding model name and base URL are required";
        send_progress("error", 0, 0, 0, 0, "", msg);
        unregister_session(&session_id);
        return Ok(());
    }

    // Get project path
    let project_path = {
        let db_path = database_path.clone();
        let pid = project_id.clone();
        tokio::task::spawn_blocking(move || get_workspace_directory_path(&db_path, &pid))
            .await
            .map_err(|e| Error::from_reason(format!("Failed to get project path: {e}")))?
            .map_err(|e| e)?
            .ok_or_else(|| Error::from_reason("Project path not found"))?
    };

    let project_root = PathBuf::from(&project_path);

    // Phase 1: Scan files
    send_progress("scanning", 0, 0, 0, 0, "", "");

    let scanned_files = {
        let root = project_root.clone();
        tokio::task::spawn_blocking(move || scan_project(&root))
            .await
            .map_err(|e| Error::from_reason(format!("File scan failed: {e}")))?
    };

    let total_files = scanned_files.len() as i32;
    if total_files == 0 {
        send_progress("done", 0, 0, 0, 0, "", "");
        unregister_session(&session_id);
        return Ok(());
    }

    // Ensure vector table exists
    {
        let db_path = database_path.clone();
        let pid = project_id.clone();
        tokio::task::spawn_blocking(move || ensure_vector_table(&db_path, &pid))
            .await
            .map_err(|e| Error::from_reason(format!("Failed to create vector table: {e}")))?
            .map_err(|e| e)?;
    };

    // Phase 2: Chunk all files
    send_progress("chunking", total_files, 0, 0, 0, "", "");

    let chunking_config = ChunkingConfig::from_settings(
        settings.chunking_max_lines_per_chunk,
        settings.chunking_min_lines_per_chunk,
        settings.chunking_min_chars_per_chunk,
        settings.chunking_overlap_lines,
        settings.model_context_length,
    );

    let embedding_config = EmbeddingConfig::from_settings(
        &settings.embedding_type,
        &settings.embedding_model_name,
        &settings.embedding_base_url,
        &settings.embedding_api_key,
        settings.embedding_dimensions,
    );

    // Build all chunks（读文件 + tiktoken 计数是 CPU 密集操作，放到阻塞线程池）
    let chunked = {
        let sid = session_id.clone();
        let config = chunking_config.clone();
        tokio::task::spawn_blocking(move || {
            let mut all_file_chunks: Vec<FileChunks> = Vec::new();
            let mut total_chunks = 0i32;
            for file in scanned_files {
                if is_cancelled(&sid) {
                    return None;
                }
                let content = match std::fs::read_to_string(&file.path) {
                    Ok(c) => c,
                    Err(_) => continue, // Skip files that can't be read as UTF-8
                };
                let chunks = chunk_content(&content, &config);
                if chunks.is_empty() {
                    continue;
                }
                total_chunks += chunks.len() as i32;
                all_file_chunks.push(FileChunks {
                    file,
                    chunks,
                    content,
                });
            }
            Some((all_file_chunks, total_chunks))
        })
        .await
        .map_err(|e| Error::from_reason(format!("Chunking failed: {e}")))?
    };
    let Some((all_file_chunks, total_chunks)) = chunked else {
        send_progress("cancelled", total_files, 0, 0, 0, "", "");
        unregister_session(&session_id);
        return Ok(());
    };

    // Phase 3: Embed chunks with concurrency control
    //
    // Before starting, load the set of file hashes that are already stored
    // in the vector table. Files whose content hasn't changed (same hash)
    // are skipped — this makes resume-after-interrupt and incremental
    // re-indexing fast instead of re-embedding everything from scratch.
    let indexed_file_hashes: HashMap<String, String> = {
        let db_path = database_path.clone();
        let pid = project_id.clone();
        tokio::task::spawn_blocking(move || get_indexed_file_hashes(&db_path, &pid))
            .await
            .map_err(|e| Error::from_reason(format!("Failed to load indexed hashes: {e}")))?
            .map_err(|e| e)?
    };

    // Count how many files are already embedded and unchanged (will be
    // skipped). The initial processed_files/processed_chunks start from
    // these counts so the progress bar reflects the resume position.
    let skipped_files: i32 = all_file_chunks
        .iter()
        .filter(|fc| {
            let hash = blake3::hash(fc.content.as_bytes()).to_hex().to_string();
            indexed_file_hashes
                .get(&fc.file.path)
                .map_or(false, |h| *h == hash)
        })
        .count() as i32;

    let skipped_chunks: i32 = all_file_chunks
        .iter()
        .filter(|fc| {
            let hash = blake3::hash(fc.content.as_bytes()).to_hex().to_string();
            indexed_file_hashes
                .get(&fc.file.path)
                .map_or(false, |h| *h == hash)
        })
        .map(|fc| fc.chunks.len() as i32)
        .sum();

    send_progress(
        "embedding",
        total_files,
        skipped_files,
        total_chunks,
        skipped_chunks,
        "",
        "",
    );

    let batch_max_lines = if settings.batch_max_lines > 0 {
        settings.batch_max_lines as usize
    } else {
        10
    };

    let batch_concurrency = if settings.batch_concurrency > 0 {
        settings.batch_concurrency as usize
    } else {
        3
    };

    // Start from the skipped counts so progress reflects the resume point.
    let processed_files = Arc::new(Mutex::new(skipped_files));
    let processed_chunks = Arc::new(Mutex::new(skipped_chunks));

    // Shared error flag: when any concurrent task fails, it sets this so
    // sibling tasks stop starting new API calls and exit early. The first
    // error message is stored (with the failing file) so the main loop can report it.
    let shared_error: Arc<Mutex<Option<(String, String)>>> = Arc::new(Mutex::new(None));

    // Shared cancellation flag for error-triggered shutdown. Distinct from
    // the user-initiated cancel_token — this is set internally when a task
    // fails so concurrent siblings stop promptly.
    let abort_flag = Arc::new(Mutex::new(false));

    // Wrap the progress sender in Arc so it can be shared across concurrent
    // tasks. The closure is Fn (no mutable captures) and ThreadsafeFunction
    // is safe to call from multiple tasks.
    let send_progress = Arc::new(send_progress);

    // Process files concurrently. Each file is embedded as an independent
    // unit: chunks within a file are still processed sequentially (to keep
    // incremental storage and batch ordering per file), but multiple files
    // run in parallel up to `batch_concurrency`.
    //
    // Vectors are stored incrementally per file so that if embedding is
    // cancelled or fails mid-way, already-embedded chunks are preserved.
    let embedding_config = Arc::new(embedding_config);
    let embedding_model_name = Arc::new(settings.embedding_model_name.clone());
    let indexed_file_hashes = Arc::new(indexed_file_hashes);
    let database_path = Arc::new(database_path);
    let project_id = Arc::new(project_id);
    let session_id = Arc::new(session_id);

    let results: Vec<FileEmbedResult> = stream::iter(all_file_chunks.into_iter())
        .map(|file_chunks| {
            let embedding_config = Arc::clone(&embedding_config);
            let embedding_model_name = Arc::clone(&embedding_model_name);
            let indexed_file_hashes = Arc::clone(&indexed_file_hashes);
            let database_path = Arc::clone(&database_path);
            let project_id = Arc::clone(&project_id);
            let session_id = Arc::clone(&session_id);
            let processed_files = Arc::clone(&processed_files);
            let processed_chunks = Arc::clone(&processed_chunks);
            let shared_error = Arc::clone(&shared_error);
            let abort_flag = Arc::clone(&abort_flag);
            let send_progress = Arc::clone(&send_progress);

            async move {
                embed_single_file(
                    file_chunks,
                    batch_max_lines,
                    &embedding_config,
                    &embedding_model_name,
                    &indexed_file_hashes,
                    &database_path,
                    &project_id,
                    &session_id,
                    &processed_files,
                    &processed_chunks,
                    &shared_error,
                    &abort_flag,
                    send_progress.as_ref(),
                    total_files,
                    total_chunks,
                )
                .await
            }
        })
        .buffered(batch_concurrency)
        .collect()
        .await;

    // After all tasks complete, check for errors / cancellation.
    let is_cancelled_flag = is_cancelled(&session_id);
    let final_error = shared_error.lock().ok().and_then(|guard| guard.clone());

    if let Some((err_msg, failed_file)) = final_error {
        let (pf, pc) = {
            let pf = processed_files.lock().map(|g| *g).unwrap_or(0);
            let pc = processed_chunks.lock().map(|g| *g).unwrap_or(0);
            (pf, pc)
        };
        send_progress(
            "error",
            total_files,
            pf,
            total_chunks,
            pc,
            &failed_file,
            &err_msg,
        );
        unregister_session(&session_id);
        // Return Ok — the error is communicated via progress phase.
        let _ = results;
        return Ok(());
    }

    if is_cancelled_flag {
        let (pf, pc) = {
            let pf = processed_files.lock().map(|g| *g).unwrap_or(0);
            let pc = processed_chunks.lock().map(|g| *g).unwrap_or(0);
            (pf, pc)
        };
        send_progress("cancelled", total_files, pf, total_chunks, pc, "", "");
        unregister_session(&session_id);
        let _ = results;
        return Ok(());
    }

    // Phase 4: Done
    let (pf, pc) = {
        let pf = processed_files.lock().map(|g| *g).unwrap_or(0);
        let pc = processed_chunks.lock().map(|g| *g).unwrap_or(0);
        (pf, pc)
    };
    send_progress("done", total_files, pf, total_chunks, pc, "", "");

    unregister_session(&session_id);
    Ok(())
}

/// Result of embedding a single file within a concurrent embedding run.
/// Used to carry the terminal state (ok / cancelled / error) back to the
/// orchestrating stream so the main loop can react accordingly.
enum FileEmbedResult {
    /// File was embedded (or skipped because unchanged) successfully.
    Ok,
    /// Embedding was cancelled (by user or via abort_flag).
    Cancelled,
    /// Embedding failed. The error message is stored in the shared
    /// `shared_error` mutex (set by the failing task itself), so this
    /// variant carries no payload — it only signals the terminal state.
    Error,
}

/// Embed a single file's chunks. This is the unit of concurrency: multiple
/// files run in parallel via `stream::buffered`, each calling this function.
///
/// Shared state (`processed_files`, `processed_chunks`, `shared_error`,
/// `abort_flag`) is protected by `Arc<Mutex<>>`. Progress is reported via
/// the shared `send_progress` closure.
///
/// Cancellation/pause is checked at the start of the file and before each
/// batch within the file. If the shared `abort_flag` is set (because a
/// sibling task failed), this task stops starting new batches and stores
/// whatever vectors it has collected so far.
#[allow(clippy::too_many_arguments)]
async fn embed_single_file(
    file_chunks: FileChunks,
    batch_max_lines: usize,
    embedding_config: &EmbeddingConfig,
    embedding_model_name: &str,
    indexed_file_hashes: &HashMap<String, String>,
    database_path: &Path,
    project_id: &str,
    session_id: &str,
    processed_files: &Mutex<i32>,
    processed_chunks: &Mutex<i32>,
    shared_error: &Mutex<Option<(String, String)>>,
    abort_flag: &Mutex<bool>,
    send_progress: &impl Fn(&str, i32, i32, i32, i32, &str, &str),
    total_files: i32,
    total_chunks: i32,
) -> FileEmbedResult {
    let file_hash = blake3::hash(file_chunks.content.as_bytes())
        .to_hex()
        .to_string();

    // Skip files whose content hasn't changed since the last embedding.
    if let Some(existing_hash) = indexed_file_hashes.get(&file_chunks.file.path) {
        if *existing_hash == file_hash {
            // Already embedded and unchanged — skip. The skipped counts
            // were pre-computed and added to processed_files/chunks before
            // the concurrent loop started, so we must NOT increment here.
            return FileEmbedResult::Ok;
        }
    }

    // Check pause / cancel / abort before starting this file.
    if let Err(_) = wait_if_paused(session_id).await {
        return FileEmbedResult::Cancelled;
    }
    if is_cancelled(session_id) {
        return FileEmbedResult::Cancelled;
    }
    if is_abort_set(abort_flag) {
        return FileEmbedResult::Cancelled;
    }

    let (pf, pc) = {
        let pf = processed_files.lock().map(|g| *g).unwrap_or(0);
        let pc = processed_chunks.lock().map(|g| *g).unwrap_or(0);
        (pf, pc)
    };
    send_progress(
        "embedding",
        total_files,
        pf,
        total_chunks,
        pc,
        &file_chunks.file.relative_path,
        "",
    );

    // Batch chunks: group up to batch_max_lines chunks per API call.
    let chunks = &file_chunks.chunks;
    let mut chunk_start = 0usize;
    let mut file_vectors: Vec<VectorInsert> = Vec::new();

    while chunk_start < chunks.len() {
        // Check pause / cancel / abort before each batch.
        if let Err(_) = wait_if_paused(session_id).await {
            // Cancelled during pause — store what we have so far.
            if !file_vectors.is_empty() {
                let db_path = database_path.to_path_buf();
                let pid = project_id.to_string();
                let vectors = std::mem::take(&mut file_vectors);
                let _ =
                    tokio::task::spawn_blocking(move || insert_vectors(&db_path, &pid, &vectors))
                        .await;
            }
            return FileEmbedResult::Cancelled;
        }
        if is_cancelled(session_id) {
            if !file_vectors.is_empty() {
                let db_path = database_path.to_path_buf();
                let pid = project_id.to_string();
                let vectors = std::mem::take(&mut file_vectors);
                let _ =
                    tokio::task::spawn_blocking(move || insert_vectors(&db_path, &pid, &vectors))
                        .await;
            }
            return FileEmbedResult::Cancelled;
        }
        if is_abort_set(abort_flag) {
            // A sibling task failed — stop starting new batches. Store
            // whatever we have collected so far for this file.
            if !file_vectors.is_empty() {
                let db_path = database_path.to_path_buf();
                let pid = project_id.to_string();
                let vectors = std::mem::take(&mut file_vectors);
                let _ =
                    tokio::task::spawn_blocking(move || insert_vectors(&db_path, &pid, &vectors))
                        .await;
            }
            return FileEmbedResult::Cancelled;
        }

        let chunk_end = (chunk_start + batch_max_lines).min(chunks.len());
        let batch = &chunks[chunk_start..chunk_end];

        // Embed this batch with retry；输入超长时自动拆分，仍超长的块跳过。
        let output = match embed_chunks_adaptive(batch, move |inputs| async move {
            embed_with_retry(embedding_config, &inputs, session_id).await
        })
        .await
        {
            Ok(output) => output,
            Err(embed_err) => {
                // On embed failure: store whatever vectors we have collected
                // so far for this file, then set the shared error so sibling
                // tasks stop, and return the error.
                if !file_vectors.is_empty() {
                    let db_path = database_path.to_path_buf();
                    let pid = project_id.to_string();
                    let vectors = std::mem::take(&mut file_vectors);
                    let _ = tokio::task::spawn_blocking(move || {
                        insert_vectors(&db_path, &pid, &vectors)
                    })
                    .await;
                }
                let max_chars = batch
                    .iter()
                    .map(|c| c.content.chars().count())
                    .max()
                    .unwrap_or(0);
                let err_msg = format!(
                    "{} (file: {}, batch: {} chunks, largest: {} chars)",
                    embed_err.reason,
                    file_chunks.file.relative_path,
                    batch.len(),
                    max_chars
                );
                set_shared_error(
                    shared_error,
                    abort_flag,
                    err_msg,
                    &file_chunks.file.relative_path,
                );
                return FileEmbedResult::Error;
            }
        };

        if !output.skipped.is_empty() {
            log_skipped_chunks(
                database_path,
                project_id,
                &file_chunks.file.relative_path,
                &output.skipped,
            );
        }

        // Build vector inserts.
        for (chunk, embedding) in &output.embedded {
            file_vectors.push(VectorInsert {
                id: crate::storage::database::create_snowflake_id(),
                file_path: file_chunks.file.path.clone(),
                relative_path: file_chunks.file.relative_path.clone(),
                chunk_index: chunk.chunk_index as i32,
                start_line: chunk.start_line as i32,
                end_line: chunk.end_line as i32,
                content: chunk.content.clone(),
                embedding: embedding.clone(),
                embedding_model: embedding_model_name.to_string(),
                file_hash: file_hash.clone(),
            });
        }

        {
            let mut pc_guard = processed_chunks.lock().unwrap_or_else(|e| e.into_inner());
            *pc_guard += batch.len() as i32;
        }
        chunk_start = chunk_end;

        let (pf, pc) = {
            let pf = processed_files.lock().map(|g| *g).unwrap_or(0);
            let pc = processed_chunks.lock().map(|g| *g).unwrap_or(0);
            (pf, pc)
        };
        send_progress(
            "embedding",
            total_files,
            pf,
            total_chunks,
            pc,
            &file_chunks.file.relative_path,
            "",
        );
    }

    // Store this file's vectors immediately (incremental storage).
    if !file_vectors.is_empty() {
        let db_path = database_path.to_path_buf();
        let pid = project_id.to_string();
        match tokio::task::spawn_blocking(move || insert_vectors(&db_path, &pid, &file_vectors))
            .await
        {
            Ok(Ok(())) => {}
            Ok(Err(_store_err)) => {
                // Storage failure — treat as an error for this file.
                set_shared_error(
                    shared_error,
                    abort_flag,
                    "Failed to store vectors".to_string(),
                    &file_chunks.file.relative_path,
                );
                return FileEmbedResult::Error;
            }
            Err(join_err) => {
                set_shared_error(
                    shared_error,
                    abort_flag,
                    format!("Storage task panicked: {join_err}"),
                    &file_chunks.file.relative_path,
                );
                return FileEmbedResult::Error;
            }
        }
    }

    {
        let mut pf_guard = processed_files.lock().unwrap_or_else(|e| e.into_inner());
        *pf_guard += 1;
    }

    FileEmbedResult::Ok
}

/// Embed a batch of texts with retry logic. Respects cancellation.
async fn embed_with_retry(
    config: &EmbeddingConfig,
    inputs: &[String],
    session_id: &str,
) -> Result<Vec<Vec<f64>>> {
    // 统一重试策略：判定与退避与 LLM 请求一致（is_retriable_error + 指数退避）
    let options = RetryOptions::default();
    let mut attempt = 0u32;
    loop {
        if is_cancelled(session_id) {
            return Err(Error::from_reason("Embedding cancelled"));
        }

        match api_embedding::embed_batch(config, inputs).await {
            Ok(result) => return Ok(result),
            Err(error) => {
                if attempt >= options.max_retries || !is_retriable_error(&error, &options) {
                    return Err(error);
                }

                let delay = std::time::Duration::from_millis(
                    crate::api::retry::retry_backoff_ms(&options, attempt).max(0) as u64,
                );
                tokio::select! {
                    _ = tokio::time::sleep(delay) => {}
                    _ = wait_if_paused(session_id) => {}
                }
                attempt += 1;
            }
        }
    }
}

/// 记录首个错误（含失败文件）并置位 abort，让并发的兄弟任务尽快停止。
fn set_shared_error(
    shared_error: &Mutex<Option<(String, String)>>,
    abort_flag: &Mutex<bool>,
    message: String,
    relative_path: &str,
) {
    if let Ok(mut guard) = shared_error.lock() {
        if guard.is_none() {
            *guard = Some((message, relative_path.to_string()));
        }
    }
    if let Ok(mut guard) = abort_flag.lock() {
        *guard = true;
    }
}

/// 对半拆分的最大层数（约 1/256 原始大小）。
const MAX_SPLIT_DEPTH: u32 = 8;

/// 因输入仍超长而被跳过的块。
pub(crate) struct SkippedChunk {
    pub(crate) start_line: usize,
    pub(crate) end_line: usize,
    pub(crate) chars: usize,
    pub(crate) error: String,
}

/// 自适应嵌入结果：成功的块（可能是拆分后的子块）与被跳过的块。
pub(crate) struct AdaptiveEmbedOutput {
    pub(crate) embedded: Vec<(CodeChunk, Vec<f64>)>,
    pub(crate) skipped: Vec<SkippedChunk>,
}

/// 判断嵌入接口错误是否为「输入超出模型长度」。
fn is_input_too_long_error(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    if ["status 401", "status 403", "status 404", "status 429"]
        .iter()
        .any(|status| lower.contains(status))
    {
        return false;
    }
    [
        "status 413",
        "too long",
        "too large",
        "too many tokens",
        "maximum context",
        "context length",
        "context_length",
        "context window",
        "max_model_len",
        "model length",
        "maximum length",
        "max length",
        "token limit",
        "tokens limit",
        "longer than",
        "input length",
        "exceeds the max",
        "exceeds max",
        "exceeds the limit",
        "exceeded the max",
    ]
    .iter()
    .any(|keyword| lower.contains(keyword))
}

/// 嵌入一批块：接口报输入超长时先拆成单条，再逐级对半拆分重试，
/// 到达下限仍失败则跳过该块；其他错误原样返回。
pub(crate) async fn embed_chunks_adaptive<F, Fut>(
    batch: &[CodeChunk],
    embed: F,
) -> Result<AdaptiveEmbedOutput>
where
    F: Fn(Vec<String>) -> Fut,
    Fut: std::future::Future<Output = Result<Vec<Vec<f64>>>>,
{
    let mut output = AdaptiveEmbedOutput {
        embedded: Vec::new(),
        skipped: Vec::new(),
    };
    let mut pending: std::collections::VecDeque<(Vec<CodeChunk>, u32)> =
        std::collections::VecDeque::new();
    pending.push_back((batch.to_vec(), 0));

    while let Some((group, depth)) = pending.pop_front() {
        let inputs: Vec<String> = group.iter().map(|c| c.content.clone()).collect();
        match embed(inputs).await {
            Ok(vectors) => output.embedded.extend(group.into_iter().zip(vectors)),
            Err(error) if is_input_too_long_error(&error.reason) => {
                if group.len() > 1 {
                    for chunk in group.into_iter().rev() {
                        pending.push_front((vec![chunk], depth));
                    }
                    continue;
                }
                let Some(chunk) = group.into_iter().next() else {
                    continue;
                };
                let halves = if depth < MAX_SPLIT_DEPTH {
                    split_chunk_in_half(&chunk)
                } else {
                    None
                };
                match halves {
                    Some((first, second)) => {
                        pending.push_front((vec![second], depth + 1));
                        pending.push_front((vec![first], depth + 1));
                    }
                    None => output.skipped.push(SkippedChunk {
                        start_line: chunk.start_line,
                        end_line: chunk.end_line,
                        chars: chunk.content.chars().count(),
                        error: error.reason.clone(),
                    }),
                }
            }
            Err(error) => return Err(error),
        }
    }
    Ok(output)
}

/// 被跳过的超长块写一条 WARN 系统日志（fire-and-forget）。
pub(crate) fn log_skipped_chunks(
    database_path: &Path,
    project_id: &str,
    relative_path: &str,
    skipped: &[SkippedChunk],
) {
    let db_path = database_path.to_path_buf();
    let context = serde_json::json!({
        "projectId": project_id,
        "file": relative_path,
        "skippedChunks": skipped.len(),
        "chunks": skipped
            .iter()
            .take(20)
            .map(|s| serde_json::json!({
                "startLine": s.start_line,
                "endLine": s.end_line,
                "chars": s.chars,
            }))
            .collect::<Vec<_>>(),
    })
    .to_string();
    let error = skipped.first().map(|s| s.error.clone());
    tokio::task::spawn_blocking(move || {
        let _ = crate::storage::services::app_logs::insert_app_log(
            &db_path,
            &crate::storage::services::app_logs::AppLogInput {
                level: "WARN".to_string(),
                module: "embedding".to_string(),
                func: "codebase_index".to_string(),
                line: None,
                message: "Skipped chunks that exceed the embedding model input limit".to_string(),
                input: None,
                output: None,
                duration: None,
                context: Some(context),
                error,
                source: "main".to_string(),
            },
        );
    });
}

/// Pause an ongoing embedding session.
#[napi]
pub async fn pause_codebase_embedding(session_id: String) -> Result<bool> {
    let success = pause_session(&session_id);
    if success {
        // Persist the paused status so it survives app restarts.
        let storage_info = crate::storage::initialize_app_storage()?;
        let database_path = PathBuf::from(&storage_info.database_path);
        let sid = session_id.clone();
        tokio::task::spawn_blocking(move || {
            codebase_embed_sessions::update_session_status(
                &database_path,
                &sid,
                codebase_embed_sessions::STATUS_PAUSED,
                None,
            )
        })
        .await
        .map_err(|e| Error::from_reason(format!("Failed to persist pause: {e}")))??;
    }
    Ok(success)
}

/// Resume a paused embedding session.
#[napi]
pub async fn resume_codebase_embedding(session_id: String) -> Result<bool> {
    let success = resume_session(&session_id);
    if success {
        // Persist the running status.
        let storage_info = crate::storage::initialize_app_storage()?;
        let database_path = PathBuf::from(&storage_info.database_path);
        let sid = session_id.clone();
        tokio::task::spawn_blocking(move || {
            codebase_embed_sessions::update_session_status(
                &database_path,
                &sid,
                codebase_embed_sessions::STATUS_RUNNING,
                None,
            )
        })
        .await
        .map_err(|e| Error::from_reason(format!("Failed to persist resume: {e}")))??;
    }
    Ok(success)
}

/// Cancel an ongoing embedding session.
#[napi]
pub async fn cancel_codebase_embedding(session_id: String) -> Result<bool> {
    let success = cancel_session(&session_id);
    if success {
        // Delete the persisted session record — cancellation is terminal.
        let storage_info = crate::storage::initialize_app_storage()?;
        let database_path = PathBuf::from(&storage_info.database_path);
        let sid = session_id.clone();
        tokio::task::spawn_blocking(move || {
            codebase_embed_sessions::delete_session(&database_path, &sid)
        })
        .await
        .map_err(|e| Error::from_reason(format!("Failed to delete session: {e}")))??;
    }
    Ok(success)
}

/// Check whether an embedding session is currently active (running or
/// paused) for the given project. This queries the in-memory session
/// registry — NOT the database — so it reflects the true live state of
/// background embeddings even after the user switches projects.
///
/// The frontend uses this to decide whether to show "running" state when
/// the user switches back to a project whose embedding is still in
/// progress in the background.
#[napi]
pub fn is_codebase_embedding_active(project_id: String) -> bool {
    is_embedding_active_for_project(&project_id)
}
