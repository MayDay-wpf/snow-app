use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use napi::bindgen_prelude::*;
use napi_derive::napi;

use super::DirectoryEntry;

fn resolve_workspace_entry(root_path: &str, entry_path: &str) -> Result<(PathBuf, PathBuf)> {
    let root = fs::canonicalize(root_path).map_err(|error| {
        Error::from_reason(format!(
            "Failed to resolve workspace root '{}': {}",
            root_path, error
        ))
    })?;
    let entry = fs::canonicalize(entry_path).map_err(|error| {
        Error::from_reason(format!(
            "Failed to resolve workspace entry '{}': {}",
            entry_path, error
        ))
    })?;

    if entry == root || !entry.starts_with(&root) {
        return Err(Error::from_reason(
            "Workspace entry is outside the workspace root",
        ));
    }

    Ok((root, entry))
}

fn validate_entry_name(name: &str) -> Result<&str> {
    let trimmed = name.trim();
    let is_single_normal_component = matches!(
        Path::new(trimmed).components().next(),
        Some(std::path::Component::Normal(_))
    ) && Path::new(trimmed).components().count() == 1;

    if !is_single_normal_component {
        return Err(Error::from_reason(
            "Entry name must be a single file or directory name",
        ));
    }

    Ok(trimmed)
}

pub fn rename_workspace_entry(root_path: &str, entry_path: &str, new_name: &str) -> Result<()> {
    let (_root, entry) = resolve_workspace_entry(root_path, entry_path)?;
    let name = validate_entry_name(new_name)?;
    let parent = entry
        .parent()
        .ok_or_else(|| Error::from_reason("Workspace entry does not have a parent directory"))?;
    let destination = parent.join(name);

    if destination.exists() {
        return Err(Error::from_reason(format!(
            "A workspace entry named '{}' already exists",
            name
        )));
    }

    fs::rename(&entry, &destination).map_err(|error| {
        Error::from_reason(format!(
            "Failed to rename workspace entry '{}': {}",
            entry.display(),
            error
        ))
    })
}

pub fn delete_workspace_entry(root_path: &str, entry_path: &str) -> Result<()> {
    let (_root, entry) = resolve_workspace_entry(root_path, entry_path)?;
    let result = if entry.is_dir() {
        fs::remove_dir_all(&entry)
    } else {
        fs::remove_file(&entry)
    };

    result.map_err(|error| {
        Error::from_reason(format!(
            "Failed to delete workspace entry '{}': {}",
            entry.display(),
            error
        ))
    })
}

#[napi(object)]
pub struct FailedWorkspaceDelete {
    pub path: String,
    pub error: String,
}

#[napi(object)]
pub struct BatchWorkspaceDeleteResult {
    pub deleted: Vec<String>,
    pub failed: Vec<FailedWorkspaceDelete>,
}

/// 批量删除工作区条目（单次调用，内部逐个执行，避免渲染层 N+1 次 IPC）。
///
/// - 去重：重复路径只删除一次；
/// - 父子合并：若同时选中某目录及其后代，仅删除顶层路径（父级删除后
///   后代自动消失，无需再删）；
/// - 部分失败不中断：每个条目独立收集结果，调用方按 `deleted` 更新 UI，
///   按 `failed` 提示错误。
pub fn delete_workspace_entries(
    root_path: &str,
    entry_paths: Vec<String>,
) -> Result<BatchWorkspaceDeleteResult> {
    let root = fs::canonicalize(root_path).map_err(|error| {
        Error::from_reason(format!(
            "Failed to resolve workspace root '{}': {}",
            root_path, error
        ))
    })?;
    if !root.is_dir() {
        return Err(Error::from_reason(
            "Workspace root is not a directory",
        ));
    }

    // 规范化比较用键：统一为 `/` 分隔符，便于 Windows 反斜杠路径比较。
    let normalize = |p: &str| p.replace('\\', "/");

    // 去重，保持输入顺序。
    let mut unique: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for p in entry_paths {
        if p.trim().is_empty() {
            continue;
        }
        if seen.insert(normalize(&p)) {
            unique.push(p);
        }
    }

    // 过滤出「顶层」路径：被另一选中路径包含的后代路径跳过。
    let top_level: Vec<&String> = unique
        .iter()
        .filter(|p| {
            let key = normalize(p);
            !unique
                .iter()
                .any(|other| normalize(other) != key && key.starts_with(&format!("{}/", normalize(other))))
        })
        .collect();

    let mut deleted = Vec::new();
    let mut failed = Vec::new();
    for entry_path in top_level {
        match delete_workspace_entry(&root.to_string_lossy(), entry_path) {
            Ok(()) => deleted.push(entry_path.clone()),
            Err(error) => failed.push(FailedWorkspaceDelete {
                path: entry_path.clone(),
                error: error.to_string(),
            }),
        }
    }

    Ok(BatchWorkspaceDeleteResult { deleted, failed })
}

/// 同名另存时尝试的最大序号（name (1) ... name (N)），防止极端情况下无限循环。
const MAX_COPY_NAME_ATTEMPTS: u32 = 1000;

#[napi(object)]
pub struct FailedWorkspaceCopy {
    pub source: String,
    pub error: String,
}

/// 本地文件复制结果：copied 为落盘后的条目（另存时名称可能变化），failed 为失败的源文件。
#[napi(object)]
pub struct BatchWorkspaceCopyResult {
    pub copied: Vec<DirectoryEntry>,
    pub failed: Vec<FailedWorkspaceCopy>,
}

fn resolve_upload_target(root_path: &str, target_dir: &str) -> Result<PathBuf> {
    let root = fs::canonicalize(root_path).map_err(|error| {
        Error::from_reason(format!(
            "Failed to resolve workspace root '{}': {}",
            root_path, error
        ))
    })?;
    let target = fs::canonicalize(target_dir).map_err(|error| {
        Error::from_reason(format!(
            "Failed to resolve upload target '{}': {}",
            target_dir, error
        ))
    })?;

    if !target.is_dir() {
        return Err(Error::from_reason("Upload target is not a directory"));
    }
    if !target.starts_with(&root) {
        return Err(Error::from_reason(
            "Upload target is outside the workspace root",
        ));
    }

    Ok(target)
}

/// 同名另存名：`name (1).ext`、`name (2).ext` ...
fn numbered_copy_name(file_name: &str, index: u32) -> String {
    let path = Path::new(file_name);
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(file_name);
    match path.extension().and_then(|e| e.to_str()) {
        Some(ext) => format!("{} ({}).{}", stem, index, ext),
        None => format!("{} ({})", stem, index),
    }
}

fn is_same_file(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

/// 在目标目录创建目标文件并返回其句柄。
/// - 覆盖模式：直接截断同名文件（源与目标为同一文件时拒绝，避免截断源文件）；
/// - 另存模式：`create_new` 独占创建，同名时递增序号，避免覆盖已有文件。
fn create_copy_destination(
    target_dir: &Path,
    source: &Path,
    file_name: &str,
    replace_existing: bool,
) -> Result<(String, PathBuf, fs::File)> {
    if replace_existing {
        let destination = target_dir.join(file_name);
        if destination.exists() && is_same_file(source, &destination) {
            return Err(Error::from_reason(
                "Source and destination are the same file",
            ));
        }
        let file = fs::File::create(&destination).map_err(|error| {
            Error::from_reason(format!(
                "Failed to create '{}': {}",
                destination.display(),
                error
            ))
        })?;
        return Ok((file_name.to_string(), destination, file));
    }

    for index in 0..MAX_COPY_NAME_ATTEMPTS {
        let name = if index == 0 {
            file_name.to_string()
        } else {
            numbered_copy_name(file_name, index)
        };
        let destination = target_dir.join(&name);
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&destination)
        {
            Ok(file) => return Ok((name, destination, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(Error::from_reason(format!(
                    "Failed to create '{}': {}",
                    destination.display(),
                    error
                )));
            }
        }
    }

    Err(Error::from_reason(format!(
        "No free file name left for '{}'",
        file_name
    )))
}

fn copy_file_into_directory(
    target_dir: &Path,
    display_dir: &str,
    source_path: &str,
    replace_existing: bool,
) -> Result<DirectoryEntry> {
    let source = Path::new(source_path);
    let metadata = fs::metadata(source).map_err(|error| {
        Error::from_reason(format!("Failed to read '{}': {}", source_path, error))
    })?;
    if !metadata.is_file() {
        return Err(Error::from_reason("Only regular files can be uploaded"));
    }
    let file_name = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| Error::from_reason(format!("Invalid file name '{}'", source_path)))?
        .to_string();

    let mut source_file = fs::File::open(source).map_err(|error| {
        Error::from_reason(format!("Failed to open '{}': {}", source_path, error))
    })?;
    let (name, destination_path, mut destination) =
        create_copy_destination(target_dir, source, &file_name, replace_existing)?;

    let copy_result = std::io::copy(&mut source_file, &mut destination);
    drop(destination);
    let size = match copy_result {
        Ok(bytes) => bytes,
        Err(error) => {
            // 复制中途失败：删除残缺的目标文件，避免留下损坏内容。
            let _ = fs::remove_file(&destination_path);
            return Err(Error::from_reason(format!(
                "Failed to copy '{}': {}",
                source_path, error
            )));
        }
    };

    Ok(DirectoryEntry {
        path: Path::new(display_dir)
            .join(&name)
            .to_string_lossy()
            .to_string(),
        name,
        is_directory: false,
        size: size as i64,
    })
}

/// 把本地普通文件复制进工作区内的目录（单次调用，内部逐个执行，部分失败不中断）。
///
/// - `replace_existing` 为 true 时覆盖同名文件，否则同名自动另存为 `name (n).ext`；
/// - 目录与特殊文件计入 failed，不会被递归复制；
/// - 目标目录必须位于工作区根目录之内；返回的路径沿用调用方传入的目录字符串，
///   保证与渲染层树节点的路径键一致。
pub fn copy_files_into_directory(
    root_path: &str,
    target_dir: &str,
    source_paths: Vec<String>,
    replace_existing: bool,
) -> Result<BatchWorkspaceCopyResult> {
    let target = resolve_upload_target(root_path, target_dir)?;

    let mut copied = Vec::new();
    let mut failed = Vec::new();
    for source_path in source_paths {
        match copy_file_into_directory(&target, target_dir, &source_path, replace_existing) {
            Ok(entry) => copied.push(entry),
            Err(error) => failed.push(FailedWorkspaceCopy {
                source: source_path,
                error: error.to_string(),
            }),
        }
    }

    Ok(BatchWorkspaceCopyResult { copied, failed })
}
