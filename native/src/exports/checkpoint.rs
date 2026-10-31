use std::sync::Arc;

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::mcp::servers::remote_workspace::{
    global_remote_callback, is_ssh_path, set_global_remote_callback, RemoteWorkspaceCallback,
};
use crate::storage::services::checkpoint::remote::{
    create_checkpoint_remote, list_checkpoint_changes_batch_remote, list_checkpoint_changes_remote,
    list_checkpoint_summaries_batch_remote, read_checkpoint_diff_page_remote,
    restore_checkpoint_remote, restore_checkpoints_remote, RemoteCheckpointClient,
};
use crate::storage::services::checkpoint::{
    CheckpointDiffPage, CheckpointFileChange, CheckpointFileSummary,
};

/// 注册（或清除）全局 SSH 远程命令回调。renderer 通过独立的 checkpoint 导出
/// API（create/restore/list）操作 SSH 工作区、以及仓库 Wiki 后台任务读取 SSH
/// 工作区时，本进程内没有工具调用链可传 callback，因此由 Electron 主进程在
/// 初始化 native 时调用一次；传入 None 可撤销注册。
#[napi]
pub fn set_checkpoint_remote_callback(callback: Option<RemoteWorkspaceCallback>) {
    set_global_remote_callback(callback);
}

fn checkpoint_remote_callback() -> napi::Result<Arc<RemoteWorkspaceCallback>> {
    match global_remote_callback() {
        Some(callback) => Ok(callback),
        None => Err(Error::new(
            Status::GenericFailure,
            "Checkpoint remote callback is not registered; SSH checkpoint is unavailable".to_string(),
        )),
    }
}

/// Create a file-system checkpoint (snapshot) of the working directory.
///
/// Returns the generated checkpoint id. The snapshot is stored under
/// `<app-storage>/checkpoints/<YYYY-MM-DD>/<id>/` (历史检查点仍在
/// `<app-storage>/checkpoints/<id>/`，两种布局都能读取)。
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
    // 只读查询持共享读锁：可与文件工具、bash 扫描并行，不再等整个编辑周期；
    // 与恢复（独占写锁）互斥，并发漂移由链尾 states_match 门控过滤。
    let operation_lock =
        crate::storage::services::checkpoint::checkpoint_operation_lock(&work_dir)?;
    let _operation_guard = operation_lock.read_owned().await;
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
    // 只读查询持共享读锁：回滚预览不再等待同项目的编辑、bash 扫描与外部 MCP。
    let operation_lock =
        crate::storage::services::checkpoint::checkpoint_operation_lock(&work_dir)?;
    let _operation_guard = operation_lock.read_owned().await;
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

/// 回滚链上每个文件的变更摘要（变更类型 + 增删行数），不含 diff 正文。
///
/// `includeAll` (optional, default false):
/// - `false`: only files still in the chain's post-change state (rollback
///   preview and `/changes` panel semantics — matches what
///   `restore_checkpoints` would restore).
/// - `true`: every captured entry whose current state differs from its
///   pre-change state (include-all listing — later runs drifting the shared
///   working tree never erase an earlier conversation's modifications).
#[napi]
pub async fn list_checkpoint_summaries_batch(
    checkpoint_ids: Vec<String>,
    work_dir: String,
    include_all: Option<bool>,
) -> napi::Result<Vec<CheckpointFileSummary>> {
    let include_all = include_all.unwrap_or(false);
    // 只读查询持共享读锁（与恢复的独占写锁互斥）。
    let operation_lock =
        crate::storage::services::checkpoint::checkpoint_operation_lock(&work_dir)?;
    let _operation_guard = operation_lock.read_owned().await;
    if is_ssh_path(&work_dir) {
        let callback = checkpoint_remote_callback()?;
        let client = RemoteCheckpointClient::new(&callback);
        return list_checkpoint_summaries_batch_remote(
            &client,
            checkpoint_ids,
            work_dir,
            include_all,
        )
        .await;
    }
    tokio::task::spawn_blocking(move || {
        crate::storage::services::checkpoint::list_checkpoint_summaries_batch(
            checkpoint_ids,
            work_dir,
            include_all,
        )
    })
    .await
    .map_err(map_spawn_error)?
}

/// 回滚链上单个文件 diff 的一页：从 `startRow` 展示行开始，最多 `maxRows`
/// 行、约 `maxBytes` 字节。按顺序拼接各页即完整 unified diff。
#[napi]
pub async fn read_checkpoint_diff_page(
    checkpoint_ids: Vec<String>,
    work_dir: String,
    path: String,
    start_row: u32,
    max_rows: u32,
    max_bytes: u32,
) -> napi::Result<CheckpointDiffPage> {
    let operation_lock =
        crate::storage::services::checkpoint::checkpoint_operation_lock(&work_dir)?;
    let _operation_guard = operation_lock.read_owned().await;
    if is_ssh_path(&work_dir) {
        let callback = checkpoint_remote_callback()?;
        let client = RemoteCheckpointClient::new(&callback);
        return read_checkpoint_diff_page_remote(
            &client,
            checkpoint_ids,
            work_dir,
            path,
            start_row,
            max_rows,
            max_bytes,
        )
        .await;
    }
    tokio::task::spawn_blocking(move || {
        crate::storage::services::checkpoint::read_checkpoint_diff_page(
            checkpoint_ids,
            work_dir,
            path,
            start_row,
            max_rows,
            max_bytes,
        )
    })
    .await
    .map_err(map_spawn_error)?
}

/// 整理旧版检查点布局：扁平检查点目录 → 按创建日期分片
/// （`<root>/<YYYY-MM-DD>/<id>/`），扁平对象库 → 按内容 id 前两位分桶
/// （`objects/ab/<id>`）。只做同盘 rename，幂等，应用启动时调用一次。
/// 返回搬移的条目数。
#[napi]
pub async fn migrate_checkpoint_layout() -> napi::Result<u32> {
    let moved = tokio::task::spawn_blocking(
        crate::storage::services::checkpoint::migrate_checkpoint_layout,
    )
    .await
    .map_err(map_spawn_error)?;
    // 布局整理后调度一次未引用对象清理（后台线程，不阻塞启动）
    crate::storage::services::checkpoint::schedule_orphan_object_sweep();
    Ok(moved? as u32)
}

/// Convert a tokio JoinError into a napi Error.
fn map_spawn_error(e: tokio::task::JoinError) -> Error {
    Error::new(
        Status::GenericFailure,
        format!("Spawned blocking task failed: {e}"),
    )
}
