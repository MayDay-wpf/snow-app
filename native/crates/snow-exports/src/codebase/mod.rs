pub(crate) use std::collections::HashMap;
pub(crate) use std::path::{Path, PathBuf};
pub(crate) use std::sync::{Arc, Mutex};

pub(crate) use futures::stream::{self, StreamExt};

pub(crate) use napi::bindgen_prelude::*;
pub(crate) use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
pub(crate) use napi_derive::napi;
pub(crate) use tokio::sync::Notify;
pub(crate) use tokio_util::sync::CancellationToken;

pub(crate) use crate::api::embedding::{self as api_embedding, EmbeddingConfig};
pub(crate) use crate::api::retry::{is_retriable_error, RetryOptions};
pub(crate) use crate::storage::services::code_chunker::{
    chunk_content, split_chunk_in_half, ChunkingConfig, CodeChunk,
};
pub(crate) use crate::storage::services::codebase_embed_sessions::{self, EmbedSessionRecord};
pub(crate) use crate::storage::services::codebase_index::{
    self, delete_vectors_for_file, ensure_vector_table, get_index_stats, get_indexed_file_hashes,
    get_indexed_file_paths, insert_vectors, list_indexed_files, VectorInsert,
};
pub(crate) use crate::storage::services::codebase_watcher::{self, CodebaseChangeCallback};
pub(crate) use crate::storage::services::file_scanner::{scan_project, ScannedFile};
pub(crate) use crate::storage::services::workspace_directories::get_workspace_directory_path;

mod embedding;
mod index;
mod preview;
mod sync;
mod watch;

// 保留 crate::exports::codebase::* 原有公共路径的重导出
#[allow(unused_imports)]
pub use {
    embedding::{cancel_codebase_embedding, is_codebase_embedding_active, pause_codebase_embedding, resume_codebase_embedding, start_codebase_embedding},
    index::{clear_codebase_index, discard_resumable_codebase_session, get_codebase_index_stats, get_resumable_codebase_sessions, list_codebase_indexed_files, ResumableCodebaseSession},
    preview::{preview_codebase_scan, CodebaseScanPreview},
    sync::{cancel_codebase_sync, sync_codebase_changes, CodebaseSyncProgress, CodebaseSyncResult},
    watch::{start_codebase_watch, stop_codebase_watch},
};
pub(crate) use embedding::{
    embed_chunks_adaptive, load_codebase_settings, log_skipped_chunks, FileChunks,
};

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

pub(crate) use sync::is_prompt_context_sync_active;

/// 把 codebase 运行状态注入 api 层，避免 api 反向依赖导出层。
#[ctor::ctor(unsafe)]
fn register_codebase_state_port() {
    crate::codebase_state_port::register(
        |id: &str| is_codebase_embedding_active(id.to_string()),
        is_prompt_context_sync_active,
    );
}
