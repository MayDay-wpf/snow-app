//! 本地数据清理的 NAPI 转发（设置 → 存储与资源 → 数据清理）。
//!
//! 扫描与删除都在 Rust 侧执行；这里只做参数校验 + spawn_blocking 调度，
//! 保证磁盘遍历不会阻塞 Node.js 主线程。

use super::*;

use crate::storage::services::cleanup;
use crate::storage::services::orphan_projects;

/// 扫描本地数据分类的磁盘占用（`days_list` 为需要一并统计的天数档位，
/// 如 [7, 15, 30, 90]；结果中每个分类会返回对应档位可清理的文件数与字节数）。
#[napi]
pub async fn scan_cleanup(days_list: Vec<u32>) -> napi::Result<crate::storage::CleanupScanResult> {
    let days_list: Vec<u32> = days_list.into_iter().filter(|days| *days > 0).collect();
    tokio::task::spawn_blocking(move || cleanup::scan(&cleanup::all_categories(), &days_list))
        .await
        .map_err(map_spawn_error)?
}

/// 删除选中分类的数据（`categories` 为分类 id 列表，`max_age_days` 为 0
/// 表示删除分类目录下的全部内容，否则只删除早于该天数的文件）。
#[napi]
pub async fn delete_cleanup_data(
    categories: Vec<String>,
    max_age_days: u32,
) -> napi::Result<crate::storage::CleanupDeleteResult> {
    let categories: Vec<cleanup::CleanupCategory> = categories
        .iter()
        .map(|id| cleanup::CleanupCategory::parse(id))
        .collect::<napi::Result<Vec<_>>>()?;
    if categories.is_empty() {
        return Err(Error::from_reason("No cleanup category selected"));
    }
    tokio::task::spawn_blocking(move || cleanup::delete(&categories, max_age_days))
        .await
        .map_err(map_spawn_error)?
}

/// 扫描已从项目列表移除、但仍残留会话 / 归档 / 快照等数据的项目。
#[napi]
pub async fn scan_orphan_projects() -> napi::Result<crate::storage::OrphanProjectScanResult> {
    tokio::task::spawn_blocking(|| {
        let database_path = crate::storage::ensure_database_file()?;
        let archive_path = crate::storage::ensure_archive_database_file()?;
        orphan_projects::scan(&database_path, &archive_path)
    })
    .await
    .map_err(map_spawn_error)?
}

/// 删除孤儿项目的选中分类数据（每个目标为 directory_id + 分类 id 列表）。
#[napi]
pub async fn delete_orphan_project_data(
    targets: Vec<crate::storage::OrphanProjectDeleteTarget>,
) -> napi::Result<crate::storage::OrphanProjectDeleteResult> {
    let mut parsed = Vec::with_capacity(targets.len());
    for target in targets {
        let categories = target
            .categories
            .iter()
            .map(|id| orphan_projects::OrphanCategory::parse(id))
            .collect::<napi::Result<Vec<_>>>()?;
        if !categories.is_empty() && !target.directory_id.trim().is_empty() {
            parsed.push((target.directory_id, categories));
        }
    }
    if parsed.is_empty() {
        return Err(Error::from_reason("No orphan project data selected"));
    }
    tokio::task::spawn_blocking(move || {
        let database_path = crate::storage::ensure_database_file()?;
        let archive_path = crate::storage::ensure_archive_database_file()?;
        orphan_projects::delete(&database_path, &archive_path, &parsed)
    })
    .await
    .map_err(map_spawn_error)?
}
