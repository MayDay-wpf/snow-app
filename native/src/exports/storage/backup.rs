//! 应用数据备份：本地目录后端。
//!
//! 所有入口都走 spawn_blocking：备份要读 GB 级数据库并逐块做哈希，
//! 放在 Node 主线程上会直接卡住窗口。

use super::*;

use crate::storage::services::backup::{
    BackupCreateResult, BackupPlan, BackupSummary, BackupTaskProgress,
};

/// 返回备份 / 恢复任务的当前进度快照。
///
/// 读取的是内存中的状态，调用方按固定间隔轮询即可，不做磁盘 IO。
#[napi]
pub async fn backup_task_progress() -> napi::Result<BackupTaskProgress> {
    Ok(crate::storage::services::backup::task_progress())
}

/// 预估一次备份的数据量，不写入任何文件。
#[napi]
pub async fn backup_local_plan(target_dir: String) -> napi::Result<BackupPlan> {
    tokio::task::spawn_blocking(move || {
        crate::storage::services::backup::plan_local_backup(&target_dir)
    })
    .await
    .map_err(map_spawn_error)?
}

/// 创建一次本地目录备份。`keep` 为保留份数（默认 5，范围 1..=50）。
#[napi]
pub async fn backup_local_create(
    target_dir: String,
    keep: Option<u32>,
) -> napi::Result<BackupCreateResult> {
    tokio::task::spawn_blocking(move || {
        crate::storage::services::backup::create_local_backup(&target_dir, keep)
    })
    .await
    .map_err(map_spawn_error)?
}

/// 列出目标目录中已有的备份，按创建时间倒序。
#[napi]
pub async fn backup_local_list(target_dir: String) -> napi::Result<Vec<BackupSummary>> {
    tokio::task::spawn_blocking(move || {
        crate::storage::services::backup::list_local_backups(&target_dir)
    })
    .await
    .map_err(map_spawn_error)?
}

/// 从指定备份恢复 `.snowapp`。
///
/// 资源文件立即写回；数据库文件写入 `.snowapp/.restore-pending/`，由应用
/// 下次启动、尚未打开任何连接时替换，因此恢复完成后需要重启应用。
#[napi]
pub async fn backup_local_restore(target_dir: String, backup_id: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::services::backup::restore_local_backup(&target_dir, &backup_id)
    })
    .await
    .map_err(map_spawn_error)?
}

/// 删除一份备份，并回收不再被任何备份引用的块。
#[napi]
pub async fn backup_local_delete(target_dir: String, backup_id: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::services::backup::delete_local_backup(&target_dir, &backup_id)
    })
    .await
    .map_err(map_spawn_error)?
}

/// 返回备份根目录的绝对路径，供 UI 展示或打开文件管理器。
#[napi]
pub async fn backup_local_root(target_dir: String) -> napi::Result<String> {
    tokio::task::spawn_blocking(move || {
        crate::storage::services::backup::local_backup_root(&target_dir)
    })
    .await
    .map_err(map_spawn_error)?
}
