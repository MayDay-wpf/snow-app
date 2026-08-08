use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::storage::services::checkpoint::{CheckpointFileChange, CheckpointFileDiff};

/// Create a file-system checkpoint (snapshot) of the working directory.
///
/// Returns the generated checkpoint id. The snapshot is stored under
/// `<app-storage>/checkpoints/<id>/`.
#[napi]
pub async fn create_checkpoint(work_dir: String) -> napi::Result<String> {
    tokio::task::spawn_blocking(move || {
        crate::storage::services::checkpoint::create_checkpoint(work_dir)
    })
    .await
    .map_err(map_spawn_error)?
}

/// Restore the working directory to the state captured by a checkpoint.
///
/// Files created after the checkpoint are deleted; files that existed at
/// checkpoint time are overwritten with their snapshot content.
#[napi]
pub async fn restore_checkpoint(checkpoint_id: String, work_dir: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::services::checkpoint::restore_checkpoint(checkpoint_id, work_dir)
    })
    .await
    .map_err(map_spawn_error)?
}

/// Delete a checkpoint and all its stored files.
#[napi]
pub async fn delete_checkpoint(checkpoint_id: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::services::checkpoint::delete_checkpoint(checkpoint_id)
    })
    .await
    .map_err(map_spawn_error)?
}

/// Compare the working directory against a checkpoint snapshot and return
/// the list of files that differ. Read-only — does not modify any files.
#[napi]
pub async fn list_checkpoint_changes(
    checkpoint_id: String,
    work_dir: String,
) -> napi::Result<Vec<CheckpointFileChange>> {
    tokio::task::spawn_blocking(move || {
        crate::storage::services::checkpoint::list_checkpoint_changes(checkpoint_id, work_dir)
    })
    .await
    .map_err(map_spawn_error)?
}

/// Return unified diffs for all files that would be affected by rollback.
///
/// `includeAll` (optional, default false):
/// - `false`: only files still in the checkpoint's post-change state (rollback
///   preview semantics — matches what `restore_checkpoint` would restore).
/// - `true`: every captured entry whose current state differs from its
///   pre-change state (file-changes panel semantics — later runs drifting the
///   shared working tree never erase an earlier conversation's modifications).
#[napi]
pub async fn list_checkpoint_diffs(
    checkpoint_id: String,
    work_dir: String,
    include_all: Option<bool>,
) -> napi::Result<Vec<CheckpointFileDiff>> {
    let include_all = include_all.unwrap_or(false);
    tokio::task::spawn_blocking(move || {
        crate::storage::services::checkpoint::list_checkpoint_diffs(
            checkpoint_id,
            work_dir,
            include_all,
        )
    })
    .await
    .map_err(map_spawn_error)?
}

/// Convert a tokio JoinError into a napi Error.
fn map_spawn_error(e: tokio::task::JoinError) -> Error {
    Error::new(
        Status::GenericFailure,
        format!("Spawned blocking task failed: {}", e),
    )
}
