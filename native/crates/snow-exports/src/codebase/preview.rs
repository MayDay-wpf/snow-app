//! 嵌入前扫描预览（不调用 API、不写库）。

use super::*;

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
        settings.model_context_length,
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
