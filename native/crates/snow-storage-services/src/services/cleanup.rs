//! 本地数据清理服务（设置 → 存储与资源 → 数据清理）。
//!
//! 与 Snow CLI 的 cleanup 功能对齐：先扫描本地数据分类在磁盘上的占用，
//! 再由用户勾选分类与时间档位后选择性删除。全部扫描与删除都发生在 Rust
//! 侧，Node / 渲染层只负责传参与展示，避免遍历磁盘阻塞 Electron 主进程。
//!
//! 分类根目录由本模块内部解析（调用方只传分类 id 与天数），渲染层无法
//! 指定任意路径，避免误删存储目录之外的文件。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use napi::bindgen_prelude::*;

use super::{image_library, pets, storage_locations};
use crate::storage::paths;
use crate::storage::{
    CleanupAgeBucket, CleanupCategoryStats, CleanupDeleteResult, CleanupScanResult,
};

const DAY_MS: u64 = 24 * 60 * 60 * 1000;
/// 单次删除最多回传的错误条数（避免超长 payload）。
const MAX_REPORTED_ERRORS: usize = 20;
/// 天数档位上限（约 10 年），防止异常参数造成极端时间戳。
const MAX_AGE_DAYS: u32 = 3650;

/// 可清理的数据分类。每个分类对应一个磁盘根目录。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CleanupCategory {
    /// 检查点快照（不含 pending 临时快照）
    Checkpoints,
    /// 对话上传的图片与其他附件
    Upload,
    /// 图片库生成的图片
    ImageLibrary,
    /// 主题自定义背景图
    Backgrounds,
    /// 已安装的宠物资源包
    Pets,
    /// 内置浏览器的登录态与备份
    BrowserState,
    /// 应用日志（~/.snow/log）
    AppLogs,
}

impl CleanupCategory {
    /// 解析渲染层传入的分类 id；未知 id 直接报错，不做静默忽略。
    pub fn parse(value: &str) -> Result<Self> {
        match value.trim() {
            "checkpoints" => Ok(Self::Checkpoints),
            "upload" => Ok(Self::Upload),
            "imageLibrary" => Ok(Self::ImageLibrary),
            "backgrounds" => Ok(Self::Backgrounds),
            "pets" => Ok(Self::Pets),
            "browserState" => Ok(Self::BrowserState),
            "appLogs" => Ok(Self::AppLogs),
            other => Err(Error::from_reason(format!(
                "Unknown cleanup category: {other}"
            ))),
        }
    }

    pub fn id(&self) -> &'static str {
        match self {
            Self::Checkpoints => "checkpoints",
            Self::Upload => "upload",
            Self::ImageLibrary => "imageLibrary",
            Self::Backgrounds => "backgrounds",
            Self::Pets => "pets",
            Self::BrowserState => "browserState",
            Self::AppLogs => "appLogs",
        }
    }

    /// 分类的磁盘根目录（可能尚不存在，此时扫描结果为 0）。
    fn roots(&self) -> Result<Vec<PathBuf>> {
        match self {
            Self::Checkpoints => Ok(vec![storage_locations::checkpoint_root()?]),
            Self::Upload => Ok(vec![storage_locations::upload_root()?]),
            Self::ImageLibrary => Ok(vec![image_library::image_library_root()?]),
            Self::Backgrounds => Ok(vec![storage_sub_dir("backgrounds")?]),
            Self::Pets => Ok(vec![storage_sub_dir("pets")?]),
            Self::BrowserState => Ok(vec![storage_sub_dir("browser-state")?]),
            Self::AppLogs => Ok(app_log_dir().into_iter().collect()),
        }
    }

    /// 扫描与删除时跳过的子目录：checkpoint 的 pending 是工具执行期间的
    /// 临时快照（迁移时同样跳过）；内置宠物目录属于应用自带资源，不可清理。
    fn skip_dir(&self, path: &Path) -> bool {
        match self {
            Self::Checkpoints => path.file_name().is_some_and(|name| {
                name.to_string_lossy() == storage_locations::PENDING_DIR_NAME
            }),
            Self::Pets => pets::is_builtin_pet_dir(path),
            _ => false,
        }
    }
}

/// 全部可清理分类（扫描与展示顺序固定）。
pub fn all_categories() -> Vec<CleanupCategory> {
    vec![
        CleanupCategory::Checkpoints,
        CleanupCategory::Upload,
        CleanupCategory::ImageLibrary,
        CleanupCategory::Backgrounds,
        CleanupCategory::Pets,
        CleanupCategory::BrowserState,
        CleanupCategory::AppLogs,
    ]
}

/// 应用数据目录（~/.snowapp）下的固定子目录。
fn storage_sub_dir(name: &str) -> Result<PathBuf> {
    Ok(paths::app_storage_dir()?.join(name))
}

/// 应用日志目录（~/.snow/log，与 Snow CLI 日志目录一致）。
fn app_log_dir() -> Option<PathBuf> {
    dirs_next::home_dir().map(|home| home.join(".snow").join("log"))
}

/// 「早于 N 天」对应的文件时间阈值。
fn cutoff(days: u32) -> SystemTime {
    let days = days.clamp(1, MAX_AGE_DAYS);
    SystemTime::now() - Duration::from_millis(u64::from(days) * DAY_MS)
}

/// 遍历分类根目录下的全部文件，逐个回调 (大小, 修改时间)。
fn walk_files<F>(root: &Path, category: CleanupCategory, mut visit: F)
where
    F: FnMut(u64, SystemTime),
{
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                if category.skip_dir(&entry.path()) {
                    continue;
                }
                pending.push(entry.path());
            } else if file_type.is_file() {
                if let Ok(metadata) = entry.metadata() {
                    let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
                    visit(metadata.len(), modified);
                }
            }
        }
    }
}

/// 递归统计目录下的文件数与字节数（不跟随符号链接）。
fn directory_stats(root: &Path) -> (i64, i64) {
    let mut files = 0i64;
    let mut bytes = 0i64;
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                pending.push(entry.path());
            } else if file_type.is_file() {
                files += 1;
                if let Ok(metadata) = entry.metadata() {
                    bytes = bytes.saturating_add(metadata.len() as i64);
                }
            }
        }
    }
    (files, bytes)
}

/// 扫描各分类的占用，并单次遍历统计每个分类下各天数档位可清理的数据量
/// （避免每个档位各做一次全盘扫描）。
pub fn scan(categories: &[CleanupCategory], days_list: &[u32]) -> Result<CleanupScanResult> {
    let cutoffs: Vec<SystemTime> = days_list.iter().map(|days| cutoff(*days)).collect();
    let mut category_stats = Vec::with_capacity(categories.len());
    let mut total_files = 0i64;
    let mut total_bytes = 0i64;

    for category in categories {
        let mut files = 0i64;
        let mut bytes = 0i64;
        let mut buckets: Vec<CleanupAgeBucket> = days_list
            .iter()
            .map(|days| CleanupAgeBucket {
                days: *days,
                files: 0,
                bytes: 0,
            })
            .collect();

        for root in category.roots()? {
            walk_files(&root, *category, |size, modified| {
                files += 1;
                bytes = bytes.saturating_add(size as i64);
                for (index, cutoff_time) in cutoffs.iter().enumerate() {
                    if modified < *cutoff_time {
                        buckets[index].files += 1;
                        buckets[index].bytes =
                            buckets[index].bytes.saturating_add(size as i64);
                    }
                }
            });
        }

        total_files += files;
        total_bytes = total_bytes.saturating_add(bytes);
        category_stats.push(CleanupCategoryStats {
            id: category.id().to_string(),
            files,
            bytes,
            age_buckets: buckets,
        });
    }

    Ok(CleanupScanResult {
        categories: category_stats,
        total_files,
        total_bytes,
    })
}

fn push_error(result: &mut CleanupDeleteResult, path: &Path, error: &std::io::Error) {
    if result.errors.len() < MAX_REPORTED_ERRORS {
        result.errors.push(format!("{}: {error}", path.display()));
    }
}

/// 删除一个条目（文件 / 目录 / 符号链接），并累计删除数量与字节数。
fn remove_entry(path: &Path, result: &mut CleanupDeleteResult) {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return; // 已被删除
    };
    let is_dir = metadata.is_dir();
    let (files, bytes) = if is_dir {
        directory_stats(path)
    } else {
        (1, metadata.len() as i64)
    };

    let outcome = if is_dir {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    };

    match outcome {
        Ok(()) => {
            result.deleted_files += files;
            result.deleted_bytes = result.deleted_bytes.saturating_add(bytes);
            result.removed_targets += 1;
        }
        Err(error) => push_error(result, path, &error),
    }
}

/// 清空分类根目录下的全部内容（保留根目录本身，应用会继续复用该目录）。
fn clear_root_children(root: &Path, category: CleanupCategory, result: &mut CleanupDeleteResult) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let is_dir = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
        if is_dir && category.skip_dir(&entry.path()) {
            continue;
        }
        remove_entry(&entry.path(), result);
    }
}

/// 删除分类根目录下修改时间早于阈值的文件，并回收空目录。
fn delete_older_than(
    root: &Path,
    category: CleanupCategory,
    cutoff_time: SystemTime,
    result: &mut CleanupDeleteResult,
) {
    let mut directories: Vec<PathBuf> = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        directories.push(directory.clone());
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                if category.skip_dir(&entry.path()) {
                    continue;
                }
                pending.push(entry.path());
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            if modified >= cutoff_time {
                continue;
            }
            let path = entry.path();
            match fs::remove_file(&path) {
                Ok(()) => {
                    result.deleted_files += 1;
                    result.deleted_bytes =
                        result.deleted_bytes.saturating_add(metadata.len() as i64);
                }
                Err(error) => push_error(result, &path, &error),
            }
        }
    }

    // 文件过期后自底向上回收空目录（分类根目录自身保留）
    directories.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
    for directory in directories {
        if directory == root {
            continue;
        }
        let is_empty = fs::read_dir(&directory)
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(false);
        if is_empty {
            let _ = fs::remove_dir(&directory);
        }
    }
}

/// 删除选中分类的数据：
/// - `max_age_days` 为 0 时删除分类目录下的全部内容；
/// - 否则只删除修改时间早于该天数的文件。
pub fn delete(categories: &[CleanupCategory], max_age_days: u32) -> Result<CleanupDeleteResult> {
    let mut result = CleanupDeleteResult {
        deleted_files: 0,
        deleted_bytes: 0,
        removed_targets: 0,
        errors: Vec::new(),
    };
    let cutoff_time = if max_age_days == 0 {
        None
    } else {
        Some(cutoff(max_age_days))
    };

    for category in categories {
        for root in category.roots()? {
            match cutoff_time {
                Some(value) => delete_older_than(&root, *category, value, &mut result),
                None => clear_root_children(&root, *category, &mut result),
            }
        }
    }

    Ok(result)
}