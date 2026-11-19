//! 应用数据备份：本地目录与 Cloudflare R2 后端。
//!
//! 所有入口都走 spawn_blocking：备份要读 GB 级数据库、逐块做哈希并上传，
//! 放在 Node 主线程上会直接卡住窗口。

use super::*;

use crate::storage::services::backup::{
    BackupCreateResult, BackupPendingTask, BackupPlan, BackupR2Config, BackupResumeResult,
    BackupSummary, BackupTarget, BackupTaskProgress,
};

/// 返回备份 / 恢复任务的当前进度快照。
///
/// 读取的是内存中的状态，调用方按固定间隔轮询即可，不做磁盘 IO。
#[napi]
pub async fn backup_task_progress() -> napi::Result<BackupTaskProgress> {
    Ok(crate::storage::services::backup::task_progress())
}

/// 预估一次备份的数据量，不写入任何数据。
#[napi]
pub async fn backup_plan(target: BackupTarget) -> napi::Result<BackupPlan> {
    tokio::task::spawn_blocking(move || crate::storage::services::backup::plan_backup(&target))
        .await
        .map_err(map_spawn_error)?
}

/// 创建一次备份。`keep` 为保留份数（默认 5，范围 1..=50）。
#[napi]
pub async fn backup_create(
    target: BackupTarget,
    keep: Option<u32>,
) -> napi::Result<BackupCreateResult> {
    tokio::task::spawn_blocking(move || {
        crate::storage::services::backup::create_backup(&target, keep)
    })
    .await
    .map_err(map_spawn_error)?
}

/// 列出备份目标中已有的备份，按创建时间倒序。
#[napi]
pub async fn backup_list(target: BackupTarget) -> napi::Result<Vec<BackupSummary>> {
    tokio::task::spawn_blocking(move || crate::storage::services::backup::list_backups(&target))
        .await
        .map_err(map_spawn_error)?
}

/// 从指定备份恢复 `.snowapp`。
///
/// 资源文件立即写回；数据库文件写入 `.snowapp/.restore-pending/`，由应用
/// 下次启动、尚未打开任何连接时替换，因此恢复完成后需要重启应用。
#[napi]
pub async fn backup_restore(target: BackupTarget, backup_id: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::services::backup::restore_backup(&target, &backup_id)
    })
    .await
    .map_err(map_spawn_error)?
}

/// 删除一份备份，并回收不再被任何备份引用的块。
///
/// 进度通过 [backup_task_progress] 读取；应用中途退出时任务日志保留，
/// 下次可通过 [backup_resume_task] 继续。
#[napi]
pub async fn backup_delete(target: BackupTarget, backup_id: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::services::backup::delete_backup(&target, &backup_id)
    })
    .await
    .map_err(map_spawn_error)?
}

/// 读取上次中断（应用退出或失败）的备份 / 删除任务；没有时返回 null。
#[napi]
pub async fn backup_pending_task() -> napi::Result<Option<BackupPendingTask>> {
    tokio::task::spawn_blocking(crate::storage::services::backup::pending_task)
        .await
        .map_err(map_spawn_error)?
}

/// 继续上次中断的备份 / 删除任务；已写入的块不会重复上传。
#[napi]
pub async fn backup_resume_task() -> napi::Result<BackupResumeResult> {
    tokio::task::spawn_blocking(crate::storage::services::backup::resume_task)
        .await
        .map_err(map_spawn_error)?
}

/// 放弃上次中断的备份 / 删除任务。
#[napi]
pub async fn backup_discard_task() -> napi::Result<()> {
    tokio::task::spawn_blocking(crate::storage::services::backup::discard_task)
        .await
        .map_err(map_spawn_error)?
}

/// 返回本地备份根目录的绝对路径，供 UI 展示或打开文件管理器。
#[napi]
pub async fn backup_local_root(target_dir: String) -> napi::Result<String> {
    tokio::task::spawn_blocking(move || {
        crate::storage::services::backup::local_backup_root(&target_dir)
    })
    .await
    .map_err(map_spawn_error)?
}

/// 读取已保存的 Cloudflare R2 配置。
#[napi]
pub async fn backup_get_r2_config() -> napi::Result<BackupR2Config> {
    tokio::task::spawn_blocking(crate::storage::services::backup::get_r2_config)
        .await
        .map_err(map_spawn_error)?
}

/// 保存 Cloudflare R2 配置。
#[napi]
pub async fn backup_set_r2_config(config: BackupR2Config) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::services::backup::set_r2_config(config))
        .await
        .map_err(map_spawn_error)?
}

/// 用表单中的 R2 配置发起一次列举请求，验证凭据与存储桶可用。
#[napi]
pub async fn backup_test_r2_config(config: BackupR2Config) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::services::backup::test_r2_config(config))
        .await
        .map_err(map_spawn_error)?
}
