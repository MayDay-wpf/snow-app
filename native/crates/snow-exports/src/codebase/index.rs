//! 索引统计、文件列表与清理，以及可恢复会话查询。

use super::*;

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

/// The last failed embedding run of a project, kept until the next run starts
/// (or the index is cleared) so the codebase panel can show it again.
#[napi(object)]
pub struct CodebaseEmbedFailure {
    pub session_id: String,
    pub error: String,
    pub processed_files: i32,
    pub total_files: i32,
    /// When the run failed (SQLite datetime format).
    pub updated_at: String,
}

/// Read the project's last failed embedding run, if one is kept.
#[napi]
pub async fn get_last_codebase_embed_failure(
    project_id: String,
) -> Result<Option<CodebaseEmbedFailure>> {
    let storage_info = crate::storage::initialize_app_storage()?;
    let database_path = PathBuf::from(&storage_info.database_path);

    let record = tokio::task::spawn_blocking(move || {
        codebase_embed_sessions::get_latest_error_session(&database_path, &project_id)
    })
    .await
    .map_err(|e| Error::from_reason(format!("Failed to read failed session: {e}")))??;

    Ok(record.map(|r| CodebaseEmbedFailure {
        session_id: r.session_id,
        error: r.error,
        processed_files: r.processed_files,
        total_files: r.total_files,
        updated_at: r.updated_at,
    }))
}
