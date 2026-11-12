//! 聊天正文中的文件路径引用解析：把模型输出里的路径（绝对路径、相对项目根的
//! 路径、仅文件名或路径后缀）解析为磁盘上真实存在的条目，供渲染层决定在
//! 文件阅读器中打开还是交给系统默认应用。

use std::collections::VecDeque;
use std::fs;
use std::path::{Component, Path, PathBuf};

use napi_derive::napi;

use super::browse::should_skip_dir;

/// 原始路径长度上限：超长文本不可能是有效的路径引用。
const MAX_RAW_PATH_LEN: usize = 1024;
/// 后缀匹配回退最多遍历的目录数，避免超大仓库中一次点击长时间扫描。
const MAX_SCAN_DIRS: usize = 20_000;
/// 后缀匹配回退的最大目录深度。
const MAX_SCAN_DEPTH: usize = 32;

#[napi(object)]
pub struct ResolvedFileLink {
    pub path: String,
    pub is_directory: bool,
}

/// 存在则返回条目；路径按组件重建，统一为平台分隔符（`D:\a/b` → `D:\a\b`），
/// 与资源管理器树节点（`read_dir` 产出）的路径形式一致，便于前端定位。
fn existing_entry(path: &Path) -> Option<ResolvedFileLink> {
    let metadata = fs::metadata(path).ok()?;
    let normalized: PathBuf = path.components().collect();
    Some(ResolvedFileLink {
        path: normalized.to_string_lossy().into_owned(),
        is_directory: metadata.is_dir(),
    })
}

/// Windows 文件系统大小写不敏感，其余平台按字面比较。
fn names_equal(left: &str, right: &str) -> bool {
    if cfg!(windows) {
        left.eq_ignore_ascii_case(right)
    } else {
        left == right
    }
}

/// 相对路径的规范分段：忽略 `.`；含 `..`、根或盘符时无法做后缀匹配，返回 None。
fn relative_segments(relative: &str) -> Option<Vec<String>> {
    let mut segments = Vec::new();
    for component in Path::new(relative).components() {
        match component {
            Component::Normal(part) => segments.push(part.to_string_lossy().into_owned()),
            Component::CurDir => {}
            _ => return None,
        }
    }
    if segments.is_empty() {
        None
    } else {
        Some(segments)
    }
}

/// `dir` 相对 `root` 的末尾若干级目录名是否与 `parents` 一致。
fn parents_match(dir: &Path, root: &Path, parents: &[String]) -> bool {
    if parents.is_empty() {
        return true;
    }
    let Ok(relative) = dir.strip_prefix(root) else {
        return false;
    };
    let dir_segments: Vec<String> = relative
        .components()
        .filter_map(|component| match component {
            Component::Normal(part) => Some(part.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect();
    if dir_segments.len() < parents.len() {
        return false;
    }
    dir_segments[dir_segments.len() - parents.len()..]
        .iter()
        .zip(parents)
        .all(|(left, right)| names_equal(left, right))
}

/// 广度优先在项目内查找以 `segments` 结尾的文件或目录（模型常只写名称或路径
/// 后缀），返回层级最浅的命中。跳过依赖/构建产物目录，且不跟随目录符号链接以免成环。
fn find_by_suffix(root: &Path, segments: &[String]) -> Option<ResolvedFileLink> {
    let (name, parents) = segments.split_last()?;
    let mut queue: VecDeque<(PathBuf, usize)> = VecDeque::new();
    queue.push_back((root.to_path_buf(), 0));
    let mut scanned = 0usize;

    while let Some((dir, depth)) = queue.pop_front() {
        scanned += 1;
        if scanned > MAX_SCAN_DIRS {
            break;
        }
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let entry_name = entry.file_name().to_string_lossy().into_owned();
            let skipped_dir = file_type.is_dir() && should_skip_dir(&entry_name);
            if !skipped_dir && names_equal(&entry_name, name) && parents_match(&dir, root, parents)
            {
                if let Some(found) = existing_entry(&entry.path()) {
                    return Some(found);
                }
            }
            if file_type.is_dir() && !skipped_dir && depth < MAX_SCAN_DEPTH {
                queue.push_back((entry.path(), depth + 1));
            }
        }
    }
    None
}

/// 解析路径引用：绝对路径直接校验存在性；否则先按「项目根 + 相对路径」拼接，
/// 不存在时再在项目内按路径后缀查找。找不到返回 None。
pub fn resolve_file_link(root_dir: Option<&str>, raw_path: &str) -> Option<ResolvedFileLink> {
    let raw = raw_path.trim();
    if raw.is_empty() || raw.len() > MAX_RAW_PATH_LEN {
        return None;
    }
    // Match filesystem tools before deciding whether a reference is relative.
    let expanded = crate::utils::paths::expand_home_dir(raw);
    let raw = expanded.as_str();

    if Path::new(raw).is_absolute() {
        if let Some(found) = existing_entry(Path::new(raw)) {
            return Some(found);
        }
        // 仅以分隔符开头（无盘符）的路径多半是「相对项目根」的写法，
        // 继续按相对路径处理；带盘符的绝对路径不存在即视为无效。
        if !raw.starts_with(['/', '\\']) {
            return None;
        }
    }

    let root = Path::new(root_dir.map(str::trim).filter(|value| !value.is_empty())?);
    let relative = raw.trim_start_matches(['/', '\\']).replace('\\', "/");
    if relative.is_empty() {
        return None;
    }
    if let Some(found) = existing_entry(&root.join(&relative)) {
        return Some(found);
    }
    let segments = relative_segments(&relative)?;
    find_by_suffix(root, &segments)
}
