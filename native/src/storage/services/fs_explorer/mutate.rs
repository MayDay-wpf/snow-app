use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use napi::bindgen_prelude::*;
use napi_derive::napi;

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
