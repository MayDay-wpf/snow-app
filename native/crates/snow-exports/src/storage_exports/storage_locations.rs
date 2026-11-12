//! 存储位置（checkpoint / upload 目录）与迁移的 NAPI 转发。

use super::*;

// ============================================================================
// 存储位置（checkpoint / upload 目录）
// ============================================================================

#[napi]
pub async fn get_checkpoint_dir() -> napi::Result<String> {
    tokio::task::spawn_blocking(crate::storage::get_checkpoint_dir)
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn set_checkpoint_dir(dir: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::set_checkpoint_dir(dir))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn get_upload_dir() -> napi::Result<String> {
    tokio::task::spawn_blocking(crate::storage::get_upload_dir)
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn set_upload_dir(dir: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::set_upload_dir(dir))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn get_checkpoint_root() -> napi::Result<String> {
    tokio::task::spawn_blocking(crate::storage::get_checkpoint_root)
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn get_upload_root() -> napi::Result<String> {
    tokio::task::spawn_blocking(crate::storage::get_upload_root)
        .await
        .map_err(map_spawn_error)?
}

/// 准备存储目录迁移（kind: "checkpoint" | "upload"）；返回待迁移文件数量（0 表示无需迁移）。
#[napi]
pub async fn prepare_storage_migration(kind: String, target_dir: String) -> napi::Result<u32> {
    tokio::task::spawn_blocking(move || {
        crate::storage::prepare_storage_migration(kind, target_dir)
    })
    .await
    .map_err(map_spawn_error)?
}

/// 复制下一批存储目录文件并返回迁移进度（copied/total/done）。
#[napi]
pub async fn migrate_storage_chunk(kind: String) -> napi::Result<crate::storage::MigrationProgress> {
    tokio::task::spawn_blocking(move || crate::storage::migrate_storage_chunk(kind))
        .await
        .map_err(map_spawn_error)?
}

/// 提交存储目录迁移：写入新目录设置并清理旧根目录文件。
#[napi]
pub async fn commit_storage_migration(kind: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::commit_storage_migration(kind))
        .await
        .map_err(map_spawn_error)?
}

/// 回滚存储目录迁移：删除已复制到新目录的文件并移除日志（幂等）。
#[napi]
pub async fn rollback_storage_migration(kind: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::rollback_storage_migration(kind))
        .await
        .map_err(map_spawn_error)?
}

/// 计算文件或目录的占用字节数（目录递归统计；用于设置页展示存储占用）。
#[napi]
pub async fn get_path_size(path: String) -> napi::Result<i64> {
    tokio::task::spawn_blocking(move || crate::storage::get_path_size(path))
        .await
        .map_err(map_spawn_error)?
}
