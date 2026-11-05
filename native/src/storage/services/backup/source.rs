use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use napi::bindgen_prelude::*;

use super::manifest::ReuseIndex;
use super::restore::STAGING_DIR_NAME;

/// 应用自行维护、可重新生成的目录，不纳入备份。
const EXCLUDED_TOP_DIRS: &[&str] = &[
    "docs",              // 内置文档，随应用更新重新下发
    "html-preview",      // HTML 预览的临时产物
    "logs",              // 应用运行日志
    "plugin-market",     // 插件市场缓存与临时解压目录
    "browser-state",     // 由 OS safeStorage 绑定，换机后不可用
    "browser-passwords", // 同上，OS 绑定的浏览器密码库
];

/// 数据库文件由一致性快照替代；WAL/SHM 的内容已包含在快照里。
const EXCLUDED_ROOT_FILES: &[&str] = &[
    "snowapp.db",
    "snowapp.db-wal",
    "snowapp.db-shm",
    "archive.db",
    "archive.db-wal",
    "archive.db-shm",
];

/// 与内容无关的系统垃圾文件。
const EXCLUDED_FILE_NAMES: &[&str] = &[".DS_Store", "Thumbs.db", "desktop.ini"];

/// 一个待备份的源文件。
pub(crate) struct SourceFile {
    /// 实际读取的文件路径（数据库条目指向临时快照）。
    pub(crate) source_path: PathBuf,
    /// 相对 `.snowapp` 的正斜杠路径，也是恢复时的落地路径。
    pub(crate) relative_path: String,
    pub(crate) size: i64,
    /// 源文件修改时间（Unix 毫秒）。
    pub(crate) modified_ms: i64,
    /// Some 表示自上次备份以来未变化，可直接复用这些块而不读取文件。
    pub(crate) reuse_chunks: Option<Vec<String>>,
}

impl SourceFile {
    pub(crate) fn from_path(path: &Path, relative_path: String) -> Result<Self> {
        let metadata = fs::metadata(path).map_err(|error| {
            Error::from_reason(format!(
                "Failed to inspect backup source '{}': {error}",
                path.display()
            ))
        })?;
        Ok(Self {
            source_path: path.to_path_buf(),
            relative_path,
            size: metadata.len() as i64,
            modified_ms: modified_ms(&metadata),
            reuse_chunks: None,
        })
    }
}

/// 遍历 `.snowapp` 收集资源文件，并合入调用方提供的数据库条目。
///
/// `extras` 优先于目录扫描：数据库由一致性快照提供，扫描时必须跳过原文件。
pub(crate) fn collect(
    app_dir: &Path,
    extras: Vec<SourceFile>,
    reuse: &ReuseIndex,
) -> Result<Vec<SourceFile>> {
    let mut files = Vec::new();
    let mut pending = vec![app_dir.to_path_buf()];

    while let Some(directory) = pending.pop() {
        let entries = fs::read_dir(&directory).map_err(|error| {
            Error::from_reason(format!(
                "Failed to scan backup source '{}': {error}",
                directory.display()
            ))
        })?;

        for entry in entries {
            let entry = entry.map_err(|error| {
                Error::from_reason(format!(
                    "Failed to read backup source entry in '{}': {error}",
                    directory.display()
                ))
            })?;
            let file_type = entry.file_type().map_err(|error| {
                Error::from_reason(format!(
                    "Failed to inspect backup source entry '{}': {error}",
                    entry.path().display()
                ))
            })?;
            // 符号链接与 Windows 目录联接一律跳过，避免递归越出应用目录。
            if file_type.is_symlink() {
                continue;
            }

            let path = entry.path();
            let Some(relative) = relative_path(app_dir, &path) else {
                continue;
            };

            if file_type.is_dir() {
                if !is_excluded_directory(&relative) {
                    pending.push(path);
                }
            } else if file_type.is_file() && !is_excluded_file(&relative) {
                let mut source = SourceFile::from_path(&path, relative)?;
                source.reuse_chunks =
                    reuse.lookup(&source.relative_path, source.size, source.modified_ms);
                files.push(source);
            }
        }
    }

    files.extend(extras);
    Ok(files)
}

/// 相对 `.snowapp` 的正斜杠路径；非 UTF-8 路径直接跳过，避免生成无法恢复的条目。
fn relative_path(app_dir: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(app_dir).ok()?.to_str()?;
    Some(relative.replace('\\', "/"))
}

fn is_excluded_directory(relative: &str) -> bool {
    // 只排除顶层目录：子目录中同名的内容仍属于用户数据。
    if relative.contains('/') {
        return false;
    }
    // 待应用的恢复暂存目录装着数据库副本，不能进入下一次备份。
    relative == STAGING_DIR_NAME || EXCLUDED_TOP_DIRS.contains(&relative)
}

fn is_excluded_file(relative: &str) -> bool {
    let name = relative.rsplit('/').next().unwrap_or(relative);
    if EXCLUDED_FILE_NAMES.contains(&name) {
        return true;
    }
    !relative.contains('/') && EXCLUDED_ROOT_FILES.contains(&relative)
}

pub(crate) fn modified_ms(metadata: &fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}
