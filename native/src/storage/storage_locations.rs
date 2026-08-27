use std::{fs, path::PathBuf};

use napi::bindgen_prelude::*;

use super::ensure_database_file;
use super::image_library::MigrationProgress;
use super::services;

// ============================================================================
// 存储位置（checkpoint / upload 目录）
// ============================================================================

/// 读取检查点自定义保存目录（空字符串表示使用默认目录）。
pub fn get_checkpoint_dir() -> Result<String> {
    let database_path = ensure_database_file()?;
    services::storage_locations::get_custom_dir(
        &database_path,
        &services::storage_locations::StorageLocationKind::Checkpoint,
    )
}

/// 设置检查点自定义保存目录（传入空字符串重置为默认目录）。
pub fn set_checkpoint_dir(dir: String) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::storage_locations::set_custom_dir(
        &database_path,
        &services::storage_locations::StorageLocationKind::Checkpoint,
        &dir,
    )
}

/// 读取上传图片自定义保存目录（空字符串表示使用默认目录）。
pub fn get_upload_dir() -> Result<String> {
    let database_path = ensure_database_file()?;
    services::storage_locations::get_custom_dir(
        &database_path,
        &services::storage_locations::StorageLocationKind::Upload,
    )
}

/// 设置上传图片自定义保存目录（传入空字符串重置为默认目录）。
pub fn set_upload_dir(dir: String) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::storage_locations::set_custom_dir(
        &database_path,
        &services::storage_locations::StorageLocationKind::Upload,
        &dir,
    )
}

/// 检查点根目录绝对路径（优先用户自定义路径，回退默认）。
pub fn get_checkpoint_root() -> Result<String> {
    services::storage_locations::checkpoint_root()
        .map(|path| path.to_string_lossy().into_owned())
}

/// 上传图片根目录绝对路径（优先用户自定义路径，回退默认）。
pub fn get_upload_root() -> Result<String> {
    services::storage_locations::upload_root()
        .map(|path| path.to_string_lossy().into_owned())
}

/// 计算文件或目录的占用字节数（目录递归统计文件大小，不跟随符号链接）。
/// 用于设置页展示数据库 / 检查点 / 上传图片的存储占用。
pub fn get_path_size(path: String) -> Result<i64> {
    let path_buf = PathBuf::from(&path);
    let metadata = fs::metadata(&path_buf).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to read path size: {error}"),
        )
    })?;
    if metadata.is_file() {
        return Ok(metadata.len() as i64);
    }
    let mut total: i64 = 0;
    let mut pending: Vec<PathBuf> = vec![path_buf];
    while let Some(dir) = pending.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            // 无权限 / 已被删除的目录跳过，不阻断统计
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let entry_type = match entry.file_type() {
                Ok(entry_type) => entry_type,
                Err(_) => continue,
            };
            if entry_type.is_dir() {
                pending.push(entry.path());
            } else if entry_type.is_file() {
                if let Ok(file_metadata) = entry.metadata() {
                    total = total.saturating_add(file_metadata.len() as i64);
                }
            }
        }
    }
    Ok(total)
}

/// 准备存储目录迁移（kind: "checkpoint" | "upload"）：校验目标目录并写入
/// 迁移日志；返回待迁移文件数量（0 表示无需迁移）。
pub fn prepare_storage_migration(kind: String, target_dir: String) -> Result<u32> {
    let location_kind = services::storage_locations::StorageLocationKind::parse(&kind)?;
    let database_path = ensure_database_file()?;
    services::storage_locations::prepare_migration(&database_path, &location_kind, &target_dir)
        .map(|count| count as u32)
}

/// 复制下一批存储目录文件并返回迁移进度（每批最多 16 个，逐文件写入日志保证崩溃可恢复）。
pub fn migrate_storage_chunk(kind: String) -> Result<MigrationProgress> {
    let location_kind = services::storage_locations::StorageLocationKind::parse(&kind)?;
    let (copied, total, done) = services::storage_locations::migrate_chunk(&location_kind, 16)?;
    Ok(MigrationProgress {
        copied: copied as u32,
        total: total as u32,
        done,
    })
}

/// 提交存储目录迁移：写入新目录设置（提交点）并清理旧根目录文件。
pub fn commit_storage_migration(kind: String) -> Result<()> {
    let location_kind = services::storage_locations::StorageLocationKind::parse(&kind)?;
    let database_path = ensure_database_file()?;
    services::storage_locations::commit_migration(&database_path, &location_kind)
}

/// 回滚存储目录迁移：删除已复制到新目录的文件并移除日志（幂等；无进行中的迁移时直接成功）。
pub fn rollback_storage_migration(kind: String) -> Result<()> {
    let location_kind = services::storage_locations::StorageLocationKind::parse(&kind)?;
    services::storage_locations::rollback_migration(&location_kind)
}
