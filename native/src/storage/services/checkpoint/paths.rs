use std::fs;
use std::path::{Component, Path, PathBuf};

use napi::bindgen_prelude::*;

use super::{
    checkpoint_root, from_forward_slashes, should_skip_relative, to_forward_slashes,
    ABSOLUTE_PATH_MARKER,
};

pub(crate) fn canonical_work_dir(work_dir: &str) -> Result<PathBuf> {
    let root = Path::new(work_dir);
    if !root.exists() {
        return Err(Error::from_reason(format!(
            "Working directory does not exist: {work_dir}"
        )));
    }
    if !root.is_dir() {
        return Err(Error::from_reason(format!(
            "Path is not a directory: {work_dir}"
        )));
    }
    fs::canonicalize(root).map_err(|error| {
        Error::from_reason(format!(
            "Failed to resolve working directory '{}': {error}",
            root.display()
        ))
    })
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

/// Strip Windows extended-length path prefixes so absolute and canonical paths
/// can be compared consistently.
///
/// `fs::canonicalize` on Windows returns paths like `\\?\D:\repo` or
/// `\\?\UNC\server\share`. Logical absolute paths from the AI / UI usually do
/// not include this prefix, so `starts_with` would otherwise reject in-workspace
/// absolute paths (especially for files that do not exist yet).
pub(crate) fn strip_windows_extended_prefix(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        if let Some(unc) = rest.strip_prefix(r"UNC\") {
            return PathBuf::from(format!(r"\\{unc}"));
        }
        return PathBuf::from(rest);
    }
    path.to_path_buf()
}

/// 归一化路径键：正斜杠 + 去尾部斜杠，Windows 下整体转小写。
/// 仅用于"同一文件"的等价判断（锁表 / 前缀剥离定位），**绝不能**把
/// 返回值当作 manifest 存储路径——小写形式会让变更列表显示磁盘上
/// 不存在的文件名（历史 bug：ThinkingBlock.tsx 被记成 thinkingblock.tsx）。
/// `replace` 与 `to_ascii_lowercase` 都不改变字节长度，因此键与原始
/// forward-slash 字符串的字符位置一一对应，可用于切片还原真实大小写。
pub(crate) fn path_key(path: &Path) -> String {
    let stripped = strip_windows_extended_prefix(path);
    let mut key = stripped.to_string_lossy().replace('\\', "/");
    while key.ends_with('/') && key.len() > 1 {
        key.pop();
    }
    #[cfg(windows)]
    {
        key = key.to_ascii_lowercase();
    }
    key
}

/// Windows 文件系统大小写不敏感：manifest 条目路径比较必须同样不敏感，
/// 否则单文件记录（旧版产生小写路径）与全树扫描（真实大小写）会为同一
/// 文件写入两条 manifest 条目，回滚列表出现"重复/不存在"的文件。
pub(crate) fn manifest_paths_equal(left: &str, right: &str) -> bool {
    #[cfg(windows)]
    {
        left.eq_ignore_ascii_case(right)
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

/// 从绝对路径剥出相对 `root` 的部分，**保留磁盘上的真实大小写**。
/// 文件不存在或不在 root 内时返回 None（调用方回退用原始 manifest 路径）。
/// 用于把历史 manifest 中已落盘的小写条目在展示时恢复为真实文件名。
pub(crate) fn real_relative_path(root: &Path, absolute: &Path) -> Option<String> {
    let canonical = fs::canonicalize(absolute).ok()?;
    let stripped = strip_windows_extended_prefix(&canonical);
    if !is_path_within_root(&stripped, root) {
        return None;
    }
    let full = stripped.to_string_lossy().replace('\\', "/");
    let full_key = path_key(&stripped);
    let root_key = path_key(root);
    if full_key == root_key {
        return Some(String::new());
    }
    let prefix = format!("{root_key}/");
    if !full_key.starts_with(&prefix) {
        return None;
    }
    // 键与原串字节位置一一对应：按尾部宽度切出原始大小写形式。
    let suffix_len = full_key.len() - prefix.len();
    if suffix_len > full.len() {
        return None;
    }
    Some(full[full.len() - suffix_len..].to_string())
}

fn is_path_within_root(path: &Path, root: &Path) -> bool {
    let candidate_key = path_key(path);
    let base_key = path_key(root);
    candidate_key == base_key || candidate_key.starts_with(&format!("{base_key}/"))
}

/// Resolve a path that may not exist yet while preserving the same Windows
/// extended-path form as `fs::canonicalize` on the parent directory.
fn resolve_path_for_checkpoint(path: &Path) -> Result<PathBuf> {
    if path.exists() {
        return fs::canonicalize(path).map_err(|error| {
            Error::from_reason(format!(
                "Failed to resolve checkpoint path '{}': {error}",
                path.display()
            ))
        });
    }

    let normalized = normalize_path(path);
    if let Some(parent) = normalized.parent() {
        if !parent.as_os_str().is_empty() && parent.exists() {
            let parent_canonical = fs::canonicalize(parent).map_err(|error| {
                Error::from_reason(format!(
                    "Failed to resolve checkpoint path parent '{}': {error}",
                    parent.display()
                ))
            })?;
            if let Some(file_name) = normalized.file_name() {
                return Ok(parent_canonical.join(file_name));
            }
        }
    }

    Ok(strip_windows_extended_prefix(&normalized))
}

pub(crate) fn resolve_checkpoint_path(root: &Path, file_path: &str) -> Result<(PathBuf, String)> {
    let supplied = Path::new(file_path);
    let candidate = if supplied.is_absolute() {
        supplied.to_path_buf()
    } else {
        // Join relative paths against the logical root so Windows extended
        // prefixes do not leak into intermediate path components.
        strip_windows_extended_prefix(root).join(supplied)
    };
    let normalized = resolve_path_for_checkpoint(&candidate)?;

    if !is_path_within_root(&normalized, root) {
        // File is outside the checkpoint's working directory (e.g. editing
        // `~/.snow/settings.json`). Store it as an absolute-path-marked entry
        // so the checkpoint can still record and restore it on rollback.
        let abs_key = to_forward_slashes(&strip_windows_extended_prefix(&normalized));
        let marked = format!("{ABSOLUTE_PATH_MARKER}{abs_key}");
        return Ok((normalized, marked));
    }

    let relative = {
        let path_key_value = path_key(&normalized);
        let root_key_value = path_key(root);
        if path_key_value == root_key_value {
            String::new()
        } else {
            let relative_key = path_key_value
                .strip_prefix(&format!("{root_key_value}/"))
                .ok_or_else(|| Error::from_reason("Failed to create checkpoint-relative path"))?;
            // 键是原字符串逐字符小写化的产物（字节长度不变），因此用尾部
            // 宽度从原始 forward-slash 形式切片，保留磁盘上的真实大小写。
            // 旧版直接存储小写键，导致 manifest 里出现
            // `thinkingblock.tsx` 这类磁盘上不存在的文件名。
            let original_full =
                strip_windows_extended_prefix(&normalized).to_string_lossy().replace('\\', "/");
            let suffix_len = relative_key.len();
            if suffix_len > original_full.len() {
                return Err(Error::from_reason(
                    "Failed to create checkpoint-relative path",
                ));
            }
            original_full[original_full.len() - suffix_len..].to_string()
        }
    };
    Ok((normalized, relative))
}

/// Resolve a manifest entry path back to an absolute filesystem path.
///
/// Paths stored with the `ABSOLUTE_PATH_MARKER` prefix are outside-workspace
/// absolute paths and are returned as-is (after stripping the marker).
/// All other paths are treated as relative to `root` and joined accordingly.
pub(crate) fn resolve_manifest_path(root: &Path, manifest_path: &str) -> PathBuf {
    if let Some(abs_path) = manifest_path.strip_prefix(ABSOLUTE_PATH_MARKER) {
        from_forward_slashes(abs_path)
    } else {
        root.join(from_forward_slashes(manifest_path))
    }
}

/// Check whether a manifest entry path should be skipped (e.g. it falls inside
/// a `node_modules` or `.git` directory). Absolute-path-marked entries are
/// never skipped by this check — they represent files outside the workspace
/// that the user explicitly chose to edit.
pub(crate) fn should_skip_manifest_path(manifest_path: &str) -> bool {
    if manifest_path.starts_with(ABSOLUTE_PATH_MARKER) {
        return false;
    }
    should_skip_relative(Path::new(manifest_path))
}

pub(crate) fn checkpoint_dir(checkpoint_id: &str) -> Result<PathBuf> {
    Ok(checkpoint_root()?.join(checkpoint_id))
}
pub(crate) fn manifest_path(checkpoint_id: &str) -> Result<PathBuf> {
    Ok(checkpoint_dir(checkpoint_id)?.join("manifest.json"))
}

/// Check whether a checkpoint manifest file exists on disk.
pub(crate) fn checkpoint_manifest_exists(checkpoint_id: &str) -> bool {
    match manifest_path(checkpoint_id) {
        Ok(path) => path.is_file(),
        Err(_) => false,
    }
}

/// Filter out checkpoint IDs whose manifest no longer exists on disk.
///
/// When a conversation is resumed from history, the frontend reconstructs the
/// `checkpoint_ids` list from persisted message records. Some of those
/// checkpoints may have been deleted (by rollback, compaction cleanup, or
/// new-chat pruning), leaving dangling IDs that would cause `read_manifest`
/// to fail. This helper silently drops them so tool execution can proceed
/// against the still-valid checkpoints.
pub(crate) fn filter_existing_checkpoints(checkpoint_ids: Vec<String>) -> Vec<String> {
    checkpoint_ids
        .into_iter()
        .filter(|id| checkpoint_manifest_exists(id))
        .collect()
}
