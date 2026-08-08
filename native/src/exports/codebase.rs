use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use futures::stream::{self, StreamExt};

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use crate::api::embedding::{self, EmbeddingConfig};
use crate::storage::services::code_chunker::{chunk_content, ChunkingConfig};
use crate::storage::services::codebase_embed_sessions::{self, EmbedSessionRecord};
use crate::storage::services::codebase_index::{
    self, delete_vectors_for_file, ensure_vector_table, get_index_stats, get_indexed_file_hashes,
    get_indexed_file_paths, insert_vectors, list_indexed_files, VectorInsert,
};
use crate::storage::services::codebase_watcher::{self, CodebaseChangeCallback};
use crate::storage::services::file_scanner::{scan_project, ScannedFile};
use crate::storage::services::system_settings::get_system_setting_value;
use crate::storage::services::workspace_directories::get_workspace_directory_path;

// ============================================================================
// NAPI 类型定义
// ============================================================================

/// Progress event sent to the frontend during embedding.
#[napi(object)]
pub struct CodebaseEmbedProgress {
    /// Current phase: "scanning" | "chunking" | "embedding" | "storing" | "done" | "error" | "paused"
    pub phase: String,
    /// Total number of files to process.
    pub total_files: i32,
    /// Number of files processed so far.
    pub processed_files: i32,
    /// Total number of chunks to embed.
    pub total_chunks: i32,
    /// Number of chunks embedded so far.
    pub processed_chunks: i32,
    /// Current file being processed (relative path).
    pub current_file: String,
    /// Error message if phase is "error".
    pub error: String,
    /// Elapsed time in milliseconds.
    pub elapsed_ms: i64,
}

/// Index statistics returned to the frontend.
#[napi(object)]
pub struct CodebaseIndexStats {
    pub total_chunks: i32,
    pub total_files: i32,
    pub total_size_bytes: i64,
    pub is_indexed: bool,
}

/// A per-file summary row of the codebase index, shown in the table view.
#[napi(object)]
pub struct CodebaseIndexedFile {
    pub relative_path: String,
    pub file_path: String,
    pub chunk_count: i32,
    pub start_line: i32,
    pub end_line: i32,
    pub size_bytes: i64,
    pub updated_at: String,
}

/// A paginated page of indexed file rows.
#[napi(object)]
pub struct CodebaseIndexedFilePage {
    pub items: Vec<CodebaseIndexedFile>,
    pub total: i32,
    pub page: i32,
    pub page_size: i32,
}

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
struct CodebaseSettings {
    embedding_type: String,
    embedding_model_name: String,
    embedding_base_url: String,
    embedding_api_key: String,
    embedding_dimensions: i32,
    batch_max_lines: i32,
    batch_concurrency: i32,
    chunking_max_lines_per_chunk: i32,
    chunking_min_lines_per_chunk: i32,
    chunking_min_chars_per_chunk: i32,
    chunking_overlap_lines: i32,
}

fn load_codebase_settings(database_path: &Path) -> Result<CodebaseSettings> {
    let raw = get_system_setting_value(database_path, "codebase_settings")?.unwrap_or_default();
    let settings: CodebaseSettings = serde_json::from_str(&raw).map_err(|error| {
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
struct FileChunks {
    file: ScannedFile,
    chunks: Vec<crate::storage::services::code_chunker::CodeChunk>,
    content: String,
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
            codebase_embed_sessions::upsert_session(&db_path, &record)
        })
        .await
        .map_err(|e| Error::from_reason(format!("Failed to persist session: {e}")))??;
    }

    // Send a progress event to the frontend AND persist the current state to
    // the database. The persistence is fire-and-forget (spawn_blocking without
    // await) so it never blocks the embedding loop. Terminal phases
    // (done/error/cancelled) also update the session status or delete the
    // record so that `list_resumable_sessions` returns accurate results.
    let send_progress = {
        let db_path = database_path.clone();
        let sid = session_id.clone();
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
                        let _ = codebase_embed_sessions::update_session_status(
                            &db_path,
                            &sid,
                            codebase_embed_sessions::STATUS_ERROR,
                            Some(&error_owned),
                        );
                        let _ = codebase_embed_sessions::delete_session(&db_path, &sid);
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
    );

    let embedding_config = EmbeddingConfig::from_settings(
        &settings.embedding_type,
        &settings.embedding_model_name,
        &settings.embedding_base_url,
        &settings.embedding_api_key,
        settings.embedding_dimensions,
    );

    // Build all chunks
    let mut all_file_chunks: Vec<FileChunks> = Vec::new();
    let mut total_chunks = 0i32;

    for file in &scanned_files {
        if is_cancelled(&session_id) {
            send_progress("cancelled", total_files, 0, total_chunks, 0, "", "");
            unregister_session(&session_id);
            return Ok(());
        }

        let content = match std::fs::read_to_string(&file.path) {
            Ok(c) => c,
            Err(_) => continue, // Skip files that can't be read as UTF-8
        };

        let chunks = chunk_content(&content, &chunking_config);
        if chunks.is_empty() {
            continue;
        }

        total_chunks += chunks.len() as i32;
        all_file_chunks.push(FileChunks {
            file: file.clone(),
            chunks,
            content,
        });
    }

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
    // error message is stored so the main loop can report it.
    let shared_error: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

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

    if let Some(err_msg) = final_error {
        let (pf, pc) = {
            let pf = processed_files.lock().map(|g| *g).unwrap_or(0);
            let pc = processed_chunks.lock().map(|g| *g).unwrap_or(0);
            (pf, pc)
        };
        send_progress("error", total_files, pf, total_chunks, pc, "", &err_msg);
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
    shared_error: &Mutex<Option<String>>,
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

        let inputs: Vec<String> = batch.iter().map(|c| c.content.clone()).collect();

        // Embed this batch with retry.
        let embeddings = match embed_with_retry(embedding_config, &inputs, session_id, 3).await {
            Ok(emb) => emb,
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
                let err_msg = embed_err.reason.clone();
                // Set the shared error (only the first error is kept) and
                // flip the abort flag so concurrent siblings stop promptly.
                if let Ok(mut guard) = shared_error.lock() {
                    if guard.is_none() {
                        *guard = Some(err_msg.clone());
                    }
                }
                if let Ok(mut guard) = abort_flag.lock() {
                    *guard = true;
                }
                return FileEmbedResult::Error;
            }
        };

        // Build vector inserts.
        for (i, embedding) in embeddings.iter().enumerate() {
            let chunk = &batch[i];
            file_vectors.push(VectorInsert {
                id: crate::storage::database::create_snowflake_id(),
                file_path: file_chunks.file.path.clone(),
                relative_path: file_chunks.file.relative_path.clone(),
                chunk_index: chunk.chunk_index as i32,
                start_line: chunk.start_line as i32,
                end_line: chunk.end_line as i32,
                content: chunk.content.clone(),
                embedding_json: embedding::vector_to_json(embedding),
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
                let err_msg = "Failed to store vectors".to_string();
                if let Ok(mut guard) = shared_error.lock() {
                    if guard.is_none() {
                        *guard = Some(err_msg.clone());
                    }
                }
                if let Ok(mut guard) = abort_flag.lock() {
                    *guard = true;
                }
                return FileEmbedResult::Error;
            }
            Err(join_err) => {
                let err_msg = format!("Storage task panicked: {join_err}");
                if let Ok(mut guard) = shared_error.lock() {
                    if guard.is_none() {
                        *guard = Some(err_msg.clone());
                    }
                }
                if let Ok(mut guard) = abort_flag.lock() {
                    *guard = true;
                }
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
    max_retries: u32,
) -> Result<Vec<Vec<f64>>> {
    let mut attempt = 0u32;
    loop {
        if is_cancelled(session_id) {
            return Err(Error::from_reason("Embedding cancelled"));
        }

        match embedding::embed_batch(config, inputs).await {
            Ok(result) => return Ok(result),
            Err(error) => {
                if attempt >= max_retries {
                    return Err(error);
                }

                // Only retry on retriable errors
                let reason = error.reason.to_lowercase();
                let retriable = reason.contains("timeout")
                    || reason.contains("network")
                    || reason.contains("529")
                    || reason.contains("429")
                    || reason.contains("rate limit")
                    || reason.contains("500")
                    || reason.contains("502")
                    || reason.contains("503")
                    || reason.contains("504")
                    || reason.contains("overloaded");

                if !retriable {
                    return Err(error);
                }

                let delay = std::time::Duration::from_millis(2000u64 * (attempt as u64 + 1));
                tokio::select! {
                    _ = tokio::time::sleep(delay) => {}
                    _ = wait_if_paused(session_id) => {}
                }
                attempt += 1;
            }
        }
    }
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

/// Get the index statistics for a project.
#[napi]
pub async fn get_codebase_index_stats(project_id: String) -> Result<CodebaseIndexStats> {
    let storage_info = crate::storage::initialize_app_storage()?;
    let database_path = PathBuf::from(&storage_info.database_path);
    let pid = project_id.clone();

    let stats = tokio::task::spawn_blocking(move || {
        // Try to get stats; if table doesn't exist, return empty
        match get_index_stats(&database_path, &pid) {
            Ok(s) => s,
            Err(_) => codebase_index::IndexStats::default(),
        }
    })
    .await
    .map_err(|e| Error::from_reason(format!("Failed to get index stats: {e}")))?;

    Ok(CodebaseIndexStats {
        total_chunks: stats.total_chunks as i32,
        total_files: stats.total_files as i32,
        total_size_bytes: stats.total_size_bytes,
        is_indexed: stats.total_chunks > 0,
    })
}

/// List indexed files for a project (paginated, sorted by relative path).
#[napi]
pub async fn list_codebase_indexed_files(
    project_id: String,
    page: i32,
    page_size: i32,
) -> Result<CodebaseIndexedFilePage> {
    let storage_info = crate::storage::initialize_app_storage()?;
    let database_path = PathBuf::from(&storage_info.database_path);
    let pid = project_id.clone();
    let page = page.max(1) as i64;
    let page_size = page_size.clamp(1, 100) as i64;

    let (records, total) = tokio::task::spawn_blocking(move || {
        // If the table doesn't exist yet, return an empty page.
        match list_indexed_files(&database_path, &pid, page, page_size) {
            Ok(result) => result,
            Err(_) => (Vec::new(), 0i64),
        }
    })
    .await
    .map_err(|e| Error::from_reason(format!("Failed to list indexed files: {e}")))?;

    Ok(CodebaseIndexedFilePage {
        items: records
            .into_iter()
            .map(|record| CodebaseIndexedFile {
                relative_path: record.relative_path,
                file_path: record.file_path,
                chunk_count: record.chunk_count as i32,
                start_line: record.start_line as i32,
                end_line: record.end_line as i32,
                size_bytes: record.size_bytes,
                updated_at: record.updated_at,
            })
            .collect(),
        total: total as i32,
        page: page as i32,
        page_size: page_size as i32,
    })
}

/// Clear all indexed vectors for a project (drop the vector table).
#[napi]
pub async fn clear_codebase_index(project_id: String) -> Result<()> {
    let storage_info = crate::storage::initialize_app_storage()?;
    let database_path = PathBuf::from(&storage_info.database_path);
    let pid = project_id.clone();

    tokio::task::spawn_blocking(move || {
        // Drop the vector table first, then delete any persisted session
        // records for this project so stale "resumable" sessions don't
        // linger after the index is cleared.
        codebase_index::drop_vector_table(&database_path, &pid)?;
        codebase_embed_sessions::delete_sessions_for_project(&database_path, &pid)
    })
    .await
    .map_err(|e| Error::from_reason(format!("Failed to clear index: {e}")))?
    .map_err(|e| e)
}

/// A persisted embedding session that can be resumed after an app restart
/// or unexpected shutdown.
#[napi(object)]
pub struct ResumableCodebaseSession {
    /// The session id used to identify this embedding run.
    pub session_id: String,
    /// The project id this session belongs to.
    pub project_id: String,
    /// Current status: "paused" or "interrupted".
    pub status: String,
    /// Total number of files to process (0 if unknown).
    pub total_files: i32,
    /// Number of files processed so far.
    pub processed_files: i32,
    /// Total number of chunks to embed (0 if unknown).
    pub total_chunks: i32,
    /// Number of chunks embedded so far.
    pub processed_chunks: i32,
    /// The file that was being processed when the session was interrupted.
    pub current_file: String,
    /// Error message if the session ended in error (empty otherwise).
    pub error: String,
    /// When the session was created (UTC, SQLite datetime format).
    pub created_at: String,
    /// When the session was last updated (UTC, SQLite datetime format).
    pub updated_at: String,
}

/// List all embedding sessions for a project that can be resumed (i.e. are
/// in the `paused` or `interrupted` state). Called by the frontend when the
/// codebase panel is opened to check if there's an interrupted embedding
/// that the user can continue.
#[napi]
pub async fn get_resumable_codebase_sessions(
    project_id: String,
) -> Result<Vec<ResumableCodebaseSession>> {
    let storage_info = crate::storage::initialize_app_storage()?;
    let database_path = PathBuf::from(&storage_info.database_path);
    let pid = project_id.clone();

    let records = tokio::task::spawn_blocking(move || {
        codebase_embed_sessions::list_resumable_sessions(&database_path, &pid)
    })
    .await
    .map_err(|e| Error::from_reason(format!("Failed to list sessions: {e}")))??;

    Ok(records
        .into_iter()
        .map(|r| ResumableCodebaseSession {
            session_id: r.session_id,
            project_id: r.project_id,
            status: r.status,
            total_files: r.total_files,
            processed_files: r.processed_files,
            total_chunks: r.total_chunks,
            processed_chunks: r.processed_chunks,
            current_file: r.current_file,
            error: r.error,
            created_at: r.created_at,
            updated_at: r.updated_at,
        })
        .collect())
}

/// Discard a resumable session without resuming it. Removes the persisted
/// session record from the database. Called by the frontend when the user
/// dismisses the "resume" prompt.
#[napi]
pub async fn discard_resumable_codebase_session(session_id: String) -> Result<()> {
    let storage_info = crate::storage::initialize_app_storage()?;
    let database_path = PathBuf::from(&storage_info.database_path);
    let sid = session_id.clone();

    tokio::task::spawn_blocking(move || {
        codebase_embed_sessions::delete_session(&database_path, &sid)
    })
    .await
    .map_err(|e| Error::from_reason(format!("Failed to discard session: {e}")))??;
    Ok(())
}

/// Start watching a project directory for codebase-relevant file changes.
///
/// This delegates to `codebase_watcher::start_codebase_watch`. Events are
/// filtered (gitignore + extension whitelist + binary detection) and
/// debounced for 3 seconds before the JS callback is invoked with the
/// project_id string.
///
/// The watcher runs on a background thread and never blocks the Node.js
/// main thread.
#[napi(
    ts_args_type = "projectId: string, projectPath: string, onChange: (projectId: string) => void",
    ts_return_type = "void"
)]
pub fn start_codebase_watch(
    project_id: String,
    project_path: String,
    on_change: CodebaseChangeCallback,
) -> Result<()> {
    codebase_watcher::start_codebase_watch(project_id, project_path, on_change)
        .map_err(|e| Error::from_reason(e.to_string()))
}

/// Stop watching a project directory for codebase file changes.
#[napi]
pub fn stop_codebase_watch(project_id: String) -> Result<()> {
    codebase_watcher::stop_codebase_watch(project_id).map_err(|e| Error::from_reason(e.to_string()))
}

// ============================================================================
// 增量同步: 自动检测文件差异并增量嵌入/删除向量
// ============================================================================

/// Progress event sent to the frontend during incremental sync.
#[napi(object)]
pub struct CodebaseSyncProgress {
    /// Current phase: "scanning" | "deleting" | "embedding" | "done" | "error" | "no_changes"
    pub phase: String,
    /// Number of files that need to be (re-)embedded.
    pub files_to_embed: i32,
    /// Number of files processed so far (embedded or skipped).
    pub processed_files: i32,
    /// Number of files whose vectors were deleted (file removed from disk
    /// or no longer eligible for embedding).
    pub deleted_files: i32,
    /// Number of files that were skipped because their content hasn't
    /// changed (same file hash).
    pub skipped_files: i32,
    /// Current file being processed (relative path).
    pub current_file: String,
    /// Error message if phase is "error".
    pub error: String,
}

/// Result of an incremental sync operation.
#[napi(object)]
pub struct CodebaseSyncResult {
    /// Whether the sync made any changes (embedded or deleted vectors).
    pub changed: bool,
    /// Number of files that were (re-)embedded.
    pub embedded_files: i32,
    /// Number of files whose vectors were deleted.
    pub deleted_files: i32,
    /// Number of files that were skipped (unchanged).
    pub skipped_files: i32,
    /// Error message if the sync failed (empty on success).
    pub error: String,
}

type SyncProgressCallback =
    ThreadsafeFunction<CodebaseSyncProgress, Unknown<'static>, CodebaseSyncProgress, Status, false>;

/// Incrementally sync the codebase index with the current state of the
/// project directory.
///
/// This function compares the files currently on disk (filtered by
/// gitignore + extension rules) with the files that have vectors stored in
/// the database. It then:
/// 1. **Deletes** vectors for files that no longer exist on disk or are no
///    longer eligible for embedding.
/// 2. **Embeds** files that are new or whose content has changed (different
///    blake3 hash).
/// 3. **Skips** files whose content hasn't changed (same hash).
///
/// This is called automatically by the frontend when:
/// - The file watcher detects changes (after the 3s debounce).
/// - The watcher is first started (to catch changes that happened while the
///   app was closed).
///
/// Like `start_codebase_embedding`, this runs entirely on the tokio runtime
/// and never blocks the Node.js main thread. Progress is reported via the
/// `onProgress` callback.
#[napi(
    ts_args_type = "projectId: string, onProgress: (progress: CodebaseSyncProgress) => void",
    ts_return_type = "Promise<CodebaseSyncResult>"
)]
pub async fn sync_codebase_changes(
    project_id: String,
    on_progress: SyncProgressCallback,
) -> Result<CodebaseSyncResult> {
    let storage_info = crate::storage::initialize_app_storage()?;
    let database_path = Arc::new(PathBuf::from(&storage_info.database_path));
    let project_id = Arc::new(project_id);

    // Helper to send progress events.
    let send_progress = {
        let on_progress = on_progress;
        move |phase: &str,
              files_to_embed: i32,
              processed_files: i32,
              deleted_files: i32,
              skipped_files: i32,
              current_file: &str,
              error: &str| {
            let progress = CodebaseSyncProgress {
                phase: phase.to_string(),
                files_to_embed,
                processed_files,
                deleted_files,
                skipped_files,
                current_file: current_file.to_string(),
                error: error.to_string(),
            };
            let _ = on_progress.call(progress, ThreadsafeFunctionCallMode::NonBlocking);
        }
    };

    // Load codebase settings
    let settings = {
        let db_path = Arc::clone(&database_path);
        tokio::task::spawn_blocking(move || load_codebase_settings(&db_path))
            .await
            .map_err(|e| Error::from_reason(format!("Failed to load settings: {e}")))?
            .map_err(|e| e)?
    };

    // Validate embedding config
    if settings.embedding_model_name.is_empty() && settings.embedding_base_url.is_empty() {
        let msg = "Embedding model name and base URL are required";
        send_progress("error", 0, 0, 0, 0, "", msg);
        return Ok(CodebaseSyncResult {
            changed: false,
            embedded_files: 0,
            deleted_files: 0,
            skipped_files: 0,
            error: msg.to_string(),
        });
    }

    // Get project path
    let project_path = {
        let db_path = Arc::clone(&database_path);
        let pid = (*project_id).clone();
        tokio::task::spawn_blocking(move || get_workspace_directory_path(&db_path, &pid))
            .await
            .map_err(|e| Error::from_reason(format!("Failed to get project path: {e}")))?
            .map_err(|e| e)?
            .ok_or_else(|| Error::from_reason("Project path not found"))?
    };

    let project_root = PathBuf::from(&project_path);

    // Load indexed file hashes and paths BEFORE scanning. This lets us
    // short-circuit: if the project has never been indexed (empty hashes
    // and paths), there is nothing to sync — the frontend should show a
    // scan preview / build-index flow instead of a "syncing" indicator.
    let indexed_file_hashes: HashMap<String, String> = {
        let db_path = Arc::clone(&database_path);
        let pid = (*project_id).clone();
        tokio::task::spawn_blocking(move || get_indexed_file_hashes(&db_path, &pid))
            .await
            .map_err(|e| Error::from_reason(format!("Failed to load indexed hashes: {e}")))?
            .map_err(|e| e)?
    };

    let indexed_file_paths: std::collections::HashSet<String> = {
        let db_path = Arc::clone(&database_path);
        let pid = (*project_id).clone();
        tokio::task::spawn_blocking(move || get_indexed_file_paths(&db_path, &pid))
            .await
            .map_err(|e| Error::from_reason(format!("Failed to load indexed paths: {e}")))?
            .map_err(|e| e)?
    };

    // Short-circuit: no existing index means there is nothing to sync.
    // The frontend will detect the missing index and show the scan preview
    // / build-index UI instead of a "syncing" spinner.
    if indexed_file_hashes.is_empty() && indexed_file_paths.is_empty() {
        send_progress("no_changes", 0, 0, 0, 0, "", "");
        return Ok(CodebaseSyncResult {
            changed: false,
            embedded_files: 0,
            deleted_files: 0,
            skipped_files: 0,
            error: String::new(),
        });
    }

    // Phase 1: Scan files on disk
    send_progress("scanning", 0, 0, 0, 0, "", "");

    let scanned_files = {
        let root = project_root.clone();
        tokio::task::spawn_blocking(move || scan_project(&root))
            .await
            .map_err(|e| Error::from_reason(format!("File scan failed: {e}")))?
    };

    // Build the set of current file paths on disk
    let current_file_paths: std::collections::HashSet<String> =
        scanned_files.iter().map(|f| f.path.clone()).collect();

    // Phase 2: Delete vectors for files that no longer exist or are no
    // longer eligible for embedding.
    let mut deleted_files = 0i32;
    let files_to_delete: Vec<String> = indexed_file_paths
        .difference(&current_file_paths)
        .cloned()
        .collect();

    if !files_to_delete.is_empty() {
        send_progress(
            "deleting",
            0,
            0,
            0,
            0,
            &format!("{} files to delete", files_to_delete.len()),
            "",
        );

        for file_path in &files_to_delete {
            let db_path = Arc::clone(&database_path);
            let pid = (*project_id).clone();
            let fp = file_path.clone();
            let _ =
                tokio::task::spawn_blocking(move || delete_vectors_for_file(&db_path, &pid, &fp))
                    .await;
            deleted_files += 1;
            send_progress("deleting", 0, 0, deleted_files, 0, file_path, "");
        }
    }

    // Phase 3: Determine which files need embedding (new or changed)
    let mut files_to_embed: Vec<FileChunks> = Vec::new();
    let mut skipped_files = 0i32;

    let chunking_config = ChunkingConfig::from_settings(
        settings.chunking_max_lines_per_chunk,
        settings.chunking_min_lines_per_chunk,
        settings.chunking_min_chars_per_chunk,
        settings.chunking_overlap_lines,
    );

    for file in &scanned_files {
        let content = match std::fs::read_to_string(&file.path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        let file_hash = blake3::hash(content.as_bytes()).to_hex().to_string();

        // Skip files whose content hasn't changed
        if let Some(existing_hash) = indexed_file_hashes.get(&file.path) {
            if *existing_hash == file_hash {
                skipped_files += 1;
                continue;
            }
        }

        let chunks = chunk_content(&content, &chunking_config);
        if chunks.is_empty() {
            continue;
        }

        files_to_embed.push(FileChunks {
            file: file.clone(),
            chunks,
            content,
        });
    }

    let files_to_embed_count = files_to_embed.len() as i32;

    // If nothing to embed and nothing deleted, we're done.
    if files_to_embed.is_empty() && deleted_files == 0 {
        send_progress("no_changes", 0, 0, 0, skipped_files, "", "");
        return Ok(CodebaseSyncResult {
            changed: false,
            embedded_files: 0,
            deleted_files: 0,
            skipped_files,
            error: String::new(),
        });
    }

    // Phase 4: Embed changed/new files with concurrency
    if files_to_embed.is_empty() {
        // Only deletions — we're done.
        send_progress("done", 0, 0, deleted_files, skipped_files, "", "");
        return Ok(CodebaseSyncResult {
            changed: true,
            embedded_files: 0,
            deleted_files,
            skipped_files,
            error: String::new(),
        });
    }

    // Ensure vector table exists
    {
        let db_path = Arc::clone(&database_path);
        let pid = (*project_id).clone();
        tokio::task::spawn_blocking(move || ensure_vector_table(&db_path, &pid))
            .await
            .map_err(|e| Error::from_reason(format!("Failed to create vector table: {e}")))?
            .map_err(|e| e)?;
    };

    let embedding_config = EmbeddingConfig::from_settings(
        &settings.embedding_type,
        &settings.embedding_model_name,
        &settings.embedding_base_url,
        &settings.embedding_api_key,
        settings.embedding_dimensions,
    );

    let batch_max_lines = if settings.batch_max_lines > 0 {
        settings.batch_max_lines as usize
    } else {
        10
    };

    let embedding_config = Arc::new(embedding_config);
    let embedding_model_name = Arc::new(settings.embedding_model_name.clone());
    let database_path_for_embed = Arc::clone(&database_path);
    let project_id_for_embed = Arc::clone(&project_id);
    let processed_files = Arc::new(Mutex::new(0i32));
    let send_progress = Arc::new(send_progress);

    // Embed files sequentially. Unlike the full embedding flow, sync usually
    // handles a small number of changed files, so sequential processing is
    // sufficient and avoids the complexity of the concurrent embed_single_file
    // (which has many parameters and lifetime constraints).
    for file_chunks in files_to_embed {
        let file_hash = blake3::hash(file_chunks.content.as_bytes())
            .to_hex()
            .to_string();

        // Batch chunks for embedding API calls.
        let chunks = &file_chunks.chunks;
        let mut chunk_start = 0usize;
        let mut file_vectors: Vec<VectorInsert> = Vec::new();

        while chunk_start < chunks.len() {
            let chunk_end = (chunk_start + batch_max_lines).min(chunks.len());
            let batch = &chunks[chunk_start..chunk_end];
            let inputs: Vec<String> = batch.iter().map(|c| c.content.clone()).collect();

            let embeddings = match embedding::embed_batch(&embedding_config, &inputs).await {
                Ok(emb) => emb,
                Err(embed_err) => {
                    let err_msg = embed_err.reason.clone();
                    send_progress(
                        "error",
                        files_to_embed_count,
                        *processed_files.lock().unwrap_or_else(|e| e.into_inner()),
                        deleted_files,
                        skipped_files,
                        &file_chunks.file.relative_path,
                        &err_msg,
                    );
                    return Ok(CodebaseSyncResult {
                        changed: deleted_files > 0,
                        embedded_files: *processed_files.lock().unwrap_or_else(|e| e.into_inner()),
                        deleted_files,
                        skipped_files,
                        error: err_msg,
                    });
                }
            };

            for (i, embedding) in embeddings.iter().enumerate() {
                let chunk = &batch[i];
                file_vectors.push(VectorInsert {
                    id: crate::storage::database::create_snowflake_id(),
                    file_path: file_chunks.file.path.clone(),
                    relative_path: file_chunks.file.relative_path.clone(),
                    chunk_index: chunk.chunk_index as i32,
                    start_line: chunk.start_line as i32,
                    end_line: chunk.end_line as i32,
                    content: chunk.content.clone(),
                    embedding_json: embedding::vector_to_json(embedding),
                    embedding_model: embedding_model_name.to_string(),
                    file_hash: file_hash.clone(),
                });
            }

            chunk_start = chunk_end;
        }

        // Store vectors for this file.
        if !file_vectors.is_empty() {
            let db_path = Arc::clone(&database_path_for_embed);
            let pid = (*project_id_for_embed).clone();
            let vectors = file_vectors;
            match tokio::task::spawn_blocking(move || insert_vectors(&db_path, &pid, &vectors))
                .await
            {
                Ok(Ok(())) => {}
                Ok(Err(_store_err)) => {
                    let err_msg = "Failed to store vectors".to_string();
                    send_progress(
                        "error",
                        files_to_embed_count,
                        *processed_files.lock().unwrap_or_else(|e| e.into_inner()),
                        deleted_files,
                        skipped_files,
                        &file_chunks.file.relative_path,
                        &err_msg,
                    );
                    return Ok(CodebaseSyncResult {
                        changed: deleted_files > 0,
                        embedded_files: *processed_files.lock().unwrap_or_else(|e| e.into_inner()),
                        deleted_files,
                        skipped_files,
                        error: err_msg,
                    });
                }
                Err(join_err) => {
                    let err_msg = format!("Storage task panicked: {join_err}");
                    send_progress(
                        "error",
                        files_to_embed_count,
                        *processed_files.lock().unwrap_or_else(|e| e.into_inner()),
                        deleted_files,
                        skipped_files,
                        &file_chunks.file.relative_path,
                        &err_msg,
                    );
                    return Ok(CodebaseSyncResult {
                        changed: deleted_files > 0,
                        embedded_files: *processed_files.lock().unwrap_or_else(|e| e.into_inner()),
                        deleted_files,
                        skipped_files,
                        error: err_msg,
                    });
                }
            }
        }

        {
            let mut pf_guard = processed_files.lock().unwrap_or_else(|e| e.into_inner());
            *pf_guard += 1;
        }

        let pf = *processed_files.lock().unwrap_or_else(|e| e.into_inner());
        send_progress(
            "embedding",
            files_to_embed_count,
            pf,
            deleted_files,
            skipped_files,
            &file_chunks.file.relative_path,
            "",
        );
    }

    let embedded_files = *processed_files.lock().unwrap_or_else(|e| e.into_inner());

    send_progress(
        "done",
        files_to_embed_count,
        embedded_files,
        deleted_files,
        skipped_files,
        "",
        "",
    );

    Ok(CodebaseSyncResult {
        changed: true,
        embedded_files,
        deleted_files,
        skipped_files,
        error: String::new(),
    })
}

/// Preview result for codebase embedding — tells the user how many files
/// would be embedded and the estimated chunk count, without making any API
/// calls or writing to the database.
#[napi(object)]
pub struct CodebaseScanPreview {
    /// Number of files that would be embedded.
    pub file_count: i32,
    /// Estimated total number of chunks across all files.
    pub estimated_chunks: i32,
    /// Total size in bytes of all eligible files.
    pub total_size_bytes: i64,
}

/// Scan a project and return a preview of what would be embedded.
///
/// This runs the same file scanner and chunker as `start_codebase_embedding`,
/// but does NOT call the embedding API or write to the database. It lets the
/// user see the scope and cost before committing.
#[napi]
pub async fn preview_codebase_scan(project_id: String) -> Result<CodebaseScanPreview> {
    let storage_info = crate::storage::initialize_app_storage()?;
    let database_path = PathBuf::from(&storage_info.database_path);

    // Load codebase settings for chunking config
    let settings = {
        let db_path = database_path.clone();
        tokio::task::spawn_blocking(move || load_codebase_settings(&db_path))
            .await
            .map_err(|e| Error::from_reason(format!("Failed to load settings: {e}")))?
            .map_err(|e| e)?
    };

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

    // Scan files (spawn_blocking — synchronous filesystem I/O)
    let scanned_files = {
        let root = project_root.clone();
        tokio::task::spawn_blocking(move || scan_project(&root))
            .await
            .map_err(|e| Error::from_reason(format!("File scan failed: {e}")))?
    };

    let file_count = scanned_files.len() as i32;
    if file_count == 0 {
        return Ok(CodebaseScanPreview {
            file_count: 0,
            estimated_chunks: 0,
            total_size_bytes: 0,
        });
    }

    // Estimate chunks using the chunking config
    let chunking_config = ChunkingConfig::from_settings(
        settings.chunking_max_lines_per_chunk,
        settings.chunking_min_lines_per_chunk,
        settings.chunking_min_chars_per_chunk,
        settings.chunking_overlap_lines,
    );

    let (estimated_chunks, total_size_bytes) = {
        let config = chunking_config.clone();
        let files = scanned_files.clone();
        tokio::task::spawn_blocking(move || {
            let mut chunks = 0i32;
            let mut size = 0i64;
            for file in &files {
                // Read file content to count chunks
                let content = match std::fs::read_to_string(&file.path) {
                    Ok(c) => c,
                    Err(_) => continue,
                };
                size += content.len() as i64;
                let file_chunks = chunk_content(&content, &config);
                chunks += file_chunks.len() as i32;
            }
            (chunks, size)
        })
        .await
        .map_err(|e| Error::from_reason(format!("Chunk estimation failed: {e}")))?
    };

    Ok(CodebaseScanPreview {
        file_count,
        estimated_chunks,
        total_size_bytes,
    })
}
