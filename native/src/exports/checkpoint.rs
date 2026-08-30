use std::sync::{Arc, Mutex, OnceLock};

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::mcp::servers::remote_workspace::{is_ssh_path, RemoteWorkspaceCallback};
use crate::storage::services::checkpoint::remote::{
    create_checkpoint_remote, list_checkpoint_changes_batch_remote, list_checkpoint_changes_remote,
    list_checkpoint_diffs_batch_remote, list_checkpoint_diffs_remote, restore_checkpoint_remote,
    restore_checkpoints_remote, RemoteCheckpointClient,
};
use crate::storage::services::checkpoint::{CheckpointFileChange, CheckpointFileDiff};

/// 全局注册的 SSH 远程命令回调：renderer 通过独立的 checkpoint 导出 API
/// （create/restore/list）操作 SSH 工作区时，本进程内没有工具调用链可传
/// callback，因此 Electron 初始化时注册一次，供远程 checkpoint 流程使用。
/// napi ThreadsafeFunction 不支持 Clone，用 Arc 共享。
static CHECKPOINT_REMOTE_CALLBACK: OnceLock<Mutex<Option<Arc<RemoteWorkspaceCallback>>>> =
    OnceLock::new();

/// 注册（或清除）checkpoint 远程命令回调。由 Electron 主进程在初始化
/// native 时调用一次；传入 None 可撤销注册。
#[napi]
pub fn set_checkpoint_remote_callback(callback: Option<RemoteWorkspaceCallback>) {
    let mut guard = CHECKPOINT_REMOTE_CALLBACK
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *guard = callback.map(Arc::new);
}

fn checkpoint_remote_callback() -> napi::Result<Arc<RemoteWorkspaceCallback>> {
    let guard = CHECKPOINT_REMOTE_CALLBACK
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match guard.as_ref() {
        Some(callback) => Ok(Arc::clone(callback)),
        None => Err(Error::new(
            Status::GenericFailure,
            "Checkpoint remote callback is not registered; SSH checkpoint is unavailable".to_string(),
        )),
    }
}

/// Create a file-system checkpoint (snapshot) of the working directory.
///
/// Returns the generated checkpoint id. The snapshot is stored under
/// `<app-storage>/checkpoints/<id>/`.
///
/// For SSH workspaces (`ssh://` URI) the remote directory is validated via
/// the Electron SSH session; file content is captured lazily before tools
/// modify it, exactly like local checkpoints.
#[napi]
pub async fn create_checkpoint(work_dir: String) -> napi::Result<String> {
    if is_ssh_path(&work_dir) {
        let callback = checkpoint_remote_callback()?;
        let client = RemoteCheckpointClient::new(&callback);
        return create_checkpoint_remote(&client, work_dir).await;
    }
    tokio::task::spawn_blocking(move || {
        crate::storage::services::checkpoint::create_checkpoint(work_dir)
    })
    .await
    .map_err(map_spawn_error)?
}

/// Restore the working directory to the state captured by a checkpoint.
///
/// Files created after the checkpoint are deleted; files that existed at
/// checkpoint time are overwritten with their snapshot content. SSH
/// workspaces are restored through the remote SFTP channel.
#[napi]
pub async fn restore_checkpoint(checkpoint_id: String, work_dir: String) -> napi::Result<()> {
    // 与 checkpoint 捕获使用同一把执行级目录锁：等待同项目所有并行文件工具
    // 的 after 阶段结束，并阻止新工具在恢复过程中写入。
    let operation_lock =
        crate::storage::services::checkpoint::checkpoint_operation_lock(&work_dir)?;
    let _operation_guard = operation_lock.write_owned().await;
    if is_ssh_path(&work_dir) {
        let callback = checkpoint_remote_callback()?;
        let client = RemoteCheckpointClient::new(&callback);
        return restore_checkpoint_remote(&client, checkpoint_id, work_dir).await;
    }
    tokio::task::spawn_blocking(move || {
        crate::storage::services::checkpoint::restore_checkpoint(checkpoint_id, work_dir)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn restore_checkpoints(
    checkpoint_ids: Vec<String>,
    work_dir: String,
) -> napi::Result<()> {
    let operation_lock =
        crate::storage::services::checkpoint::checkpoint_operation_lock(&work_dir)?;
    let _operation_guard = operation_lock.write_owned().await;
    if is_ssh_path(&work_dir) {
        let callback = checkpoint_remote_callback()?;
        let client = RemoteCheckpointClient::new(&callback);
        return restore_checkpoints_remote(&client, checkpoint_ids, work_dir).await;
    }
    tokio::task::spawn_blocking(move || {
        crate::storage::services::checkpoint::restore_checkpoints(checkpoint_ids, work_dir)
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
    // 预览必须在完整文件工具 before→执行→after 周期完成后再读取，避免观察到
    // 工具执行中的中间状态；文件工具仍可在等待期间继续使用更细粒度的同文件锁。
    let operation_lock =
        crate::storage::services::checkpoint::checkpoint_operation_lock(&work_dir)?;
    let _operation_guard = operation_lock.write_owned().await;
    if is_ssh_path(&work_dir) {
        let callback = checkpoint_remote_callback()?;
        let client = RemoteCheckpointClient::new(&callback);
        return list_checkpoint_changes_remote(&client, checkpoint_id, work_dir).await;
    }
    tokio::task::spawn_blocking(move || {
        crate::storage::services::checkpoint::list_checkpoint_changes(checkpoint_id, work_dir)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn list_checkpoint_changes_batch(
    checkpoint_ids: Vec<String>,
    work_dir: String,
    include_all: Option<bool>,
) -> napi::Result<Vec<CheckpointFileChange>> {
    let include_all = include_all.unwrap_or(false);
    let operation_lock =
        crate::storage::services::checkpoint::checkpoint_operation_lock(&work_dir)?;
    let _operation_guard = operation_lock.write_owned().await;
    if is_ssh_path(&work_dir) {
        let callback = checkpoint_remote_callback()?;
        let client = RemoteCheckpointClient::new(&callback);
        return list_checkpoint_changes_batch_remote(
            &client,
            checkpoint_ids,
            work_dir,
            include_all,
        )
        .await;
    }
    tokio::task::spawn_blocking(move || {
        crate::storage::services::checkpoint::list_checkpoint_changes_batch(
            checkpoint_ids,
            work_dir,
            include_all,
        )
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
    // diff 必须在完整文件工具 before→执行→after 周期完成后再读取，避免观察到
    // 工具执行中的中间状态；实际 restore 同样由独占锁保护。
    let operation_lock =
        crate::storage::services::checkpoint::checkpoint_operation_lock(&work_dir)?;
    let _operation_guard = operation_lock.write_owned().await;
    if is_ssh_path(&work_dir) {
        let callback = checkpoint_remote_callback()?;
        let client = RemoteCheckpointClient::new(&callback);
        return list_checkpoint_diffs_remote(&client, checkpoint_id, work_dir, include_all).await;
    }
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

#[napi]
pub async fn list_checkpoint_diffs_batch(
    checkpoint_ids: Vec<String>,
    work_dir: String,
    include_all: Option<bool>,
) -> napi::Result<Vec<CheckpointFileDiff>> {
    let include_all = include_all.unwrap_or(false);
    let operation_lock =
        crate::storage::services::checkpoint::checkpoint_operation_lock(&work_dir)?;
    let _operation_guard = operation_lock.write_owned().await;
    if is_ssh_path(&work_dir) {
        let callback = checkpoint_remote_callback()?;
        let client = RemoteCheckpointClient::new(&callback);
        return list_checkpoint_diffs_batch_remote(
            &client,
            checkpoint_ids,
            work_dir,
            include_all,
        )
        .await;
    }
    tokio::task::spawn_blocking(move || {
        crate::storage::services::checkpoint::list_checkpoint_diffs_batch(
            checkpoint_ids,
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
        format!("Spawned blocking task failed: {e}"),
    )
}
