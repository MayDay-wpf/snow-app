//! 增量同步：自动检测文件差异并增量嵌入/删除向量。

use super::*;

use std::sync::atomic::{AtomicBool, Ordering};

// ============================================================================
// 同步取消注册表（per-project abort flag）
// ============================================================================

/// 进行中的增量同步取消标记，按项目 id 索引。
///
/// `sync_codebase_changes` 启动时注册一个全新的标记，结束时（done / error /
/// cancelled 任意返回路径，经由 [`SyncRegistration`] 的 Drop）注销。
/// `cancel_codebase_sync` 将标记置为 true，正在运行的同步会在下一个检查点
/// （每个文件 / 每个批处理前）停止发起新的嵌入批处理并提前返回。
///
/// 这与全量嵌入的 `EMBED_SESSIONS` 取消机制相互独立：增量同步通常由文件
/// 监视器自动触发，用户关闭 codebase 开关或切换项目时必须能立即停掉进行
/// 中的同步，而不是让它跑完。
static SYNC_ABORT_FLAGS: Mutex<Option<HashMap<String, Arc<AtomicBool>>>> = Mutex::new(None);

fn with_sync_flags<F, R>(f: F) -> R
where
    F: FnOnce(&mut HashMap<String, Arc<AtomicBool>>) -> R,
{
    let mut guard = SYNC_ABORT_FLAGS
        .lock()
        .expect("Codebase sync abort flags mutex poisoned");
    let flags = guard.get_or_insert_with(HashMap::new);
    f(flags)
}

/// 为一个项目注册全新的同步取消标记。替换任何陈旧标记，确保新同步始终从
/// false 开始（同一项目同一时刻只会有一个同步在跑，替换是安全的）。
fn register_sync(project_id: &str) -> Arc<AtomicBool> {
    with_sync_flags(|flags| {
        let flag = Arc::new(AtomicBool::new(false));
        flags.insert(project_id.to_string(), flag.clone());
        flag
    })
}

/// 注销一个项目的同步取消标记。
fn unregister_sync(project_id: &str) {
    with_sync_flags(|flags| {
        flags.remove(project_id);
    });
}

/// 置位某项目的同步取消标记。返回是否找到了进行中的同步。
fn abort_sync(project_id: &str) -> bool {
    with_sync_flags(|flags| match flags.get(project_id) {
        Some(flag) => {
            flag.store(true, Ordering::SeqCst);
            true
        }
        None => false,
    })
}

/// 查询某项目的同步是否已被取消。
fn is_sync_aborted(project_id: &str) -> bool {
    with_sync_flags(|flags| {
        flags
            .get(project_id)
            .map(|flag| flag.load(Ordering::SeqCst))
            .unwrap_or(false)
    })
}

/// RAII 守卫：在 `sync_codebase_changes` 入口注册，函数任意返回路径析构时
/// 自动注销，避免在每个 return 处重复调用 `unregister_sync`。
struct SyncRegistration {
    project_id: String,
}

impl SyncRegistration {
    fn new(project_id: &str) -> Self {
        register_sync(project_id);
        Self {
            project_id: project_id.to_string(),
        }
    }
}

impl Drop for SyncRegistration {
    fn drop(&mut self) {
        unregister_sync(&self.project_id);
    }
}

/// 同步被取消时构建的部分结果，反映取消前已完成的删除 / 嵌入数量。
fn build_cancelled_result(deleted_files: i32, embedded_files: i32, skipped_files: i32) -> CodebaseSyncResult {
    CodebaseSyncResult {
        changed: deleted_files > 0 || embedded_files > 0,
        embedded_files,
        deleted_files,
        skipped_files,
        error: String::new(),
    }
}

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

    // 注册 per-project 取消标记，使 `cancel_codebase_sync`（用户在同步进行
    // 中关闭 codebase 开关 / 切换项目时调用）能停掉本次运行。RAII 守卫在
    // 任意返回路径（done / error / cancelled）自动注销。
    let _sync_registration = SyncRegistration::new(project_id.as_str());

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
            // 取消检查点：用户关闭 codebase 开关 / 切换项目时立即停止。
            if is_sync_aborted(project_id.as_str()) {
                send_progress("done", 0, 0, deleted_files, 0, "", "");
                return Ok(build_cancelled_result(deleted_files, 0, 0));
            }
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
    let chunking_config = ChunkingConfig::from_settings(
        settings.chunking_max_lines_per_chunk,
        settings.chunking_min_lines_per_chunk,
        settings.chunking_min_chars_per_chunk,
        settings.chunking_overlap_lines,
        settings.model_context_length,
    );

    // 读文件 + 分块（tiktoken 计数）放到阻塞线程池
    let (files_to_embed, skipped_files) = {
        tokio::task::spawn_blocking(move || {
            let mut files_to_embed: Vec<FileChunks> = Vec::new();
            let mut skipped_files = 0i32;
            for file in scanned_files {
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
                    file,
                    chunks,
                    content,
                });
            }
            (files_to_embed, skipped_files)
        })
        .await
        .map_err(|e| Error::from_reason(format!("Chunking failed: {e}")))?
    };

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
        // 取消检查点：每个文件嵌入前检查一次。
        if is_sync_aborted(project_id.as_str()) {
            let pf = *processed_files.lock().unwrap_or_else(|e| e.into_inner());
            send_progress(
                "done",
                files_to_embed_count,
                pf,
                deleted_files,
                skipped_files,
                "",
                "",
            );
            return Ok(build_cancelled_result(deleted_files, pf, skipped_files));
        }
        let file_hash = blake3::hash(file_chunks.content.as_bytes())
            .to_hex()
            .to_string();

        // Batch chunks for embedding API calls.
        let chunks = &file_chunks.chunks;
        let mut chunk_start = 0usize;
        let mut file_vectors: Vec<VectorInsert> = Vec::new();

        while chunk_start < chunks.len() {
            // 取消检查点：每个批处理前检查一次，尽早停止发起新的嵌入 API 调用。
            if is_sync_aborted(project_id.as_str()) {
                let pf = *processed_files.lock().unwrap_or_else(|e| e.into_inner());
                send_progress(
                    "done",
                    files_to_embed_count,
                    pf,
                    deleted_files,
                    skipped_files,
                    &file_chunks.file.relative_path,
                    "",
                );
                return Ok(build_cancelled_result(deleted_files, pf, skipped_files));
            }
            let chunk_end = (chunk_start + batch_max_lines).min(chunks.len());
            let batch = &chunks[chunk_start..chunk_end];
            let config: &EmbeddingConfig = &embedding_config;

            // 输入超长时自动拆分，仍超长的块跳过并记录日志
            let output = match embed_chunks_adaptive(batch, move |inputs| async move {
                api_embedding::embed_batch(config, &inputs).await
            })
            .await
            {
                Ok(output) => output,
                Err(embed_err) => {
                    let err_msg = format!(
                        "{} (file: {})",
                        embed_err.reason, file_chunks.file.relative_path
                    );
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

            if !output.skipped.is_empty() {
                log_skipped_chunks(
                    &database_path,
                    &project_id,
                    &file_chunks.file.relative_path,
                    &output.skipped,
                );
            }

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

/// Cancel an in-progress incremental sync for a project. Returns true if a
/// running sync was found and signalled to stop. The running sync stops
/// starting new embedding batches at its next check point (before each file /
/// before each batch) and returns its partial result. This is called when the
/// user disables codebase indexing for the project or switches to another
/// project while a sync is in flight, so the "update embedding" stops
/// immediately instead of running to completion.
#[napi]
pub fn cancel_codebase_sync(project_id: String) -> bool {
    abort_sync(project_id.trim())
}

pub(crate) fn is_prompt_context_sync_active(project_id: &str) -> bool { SYNC_ABORT_FLAGS.lock().map(|flags| flags.as_ref().is_some_and(|f| f.contains_key(project_id))).unwrap_or(true) }
