//! 手机端输入框 `@` 引用搜索：直接在本机工作区完成目录列举与文件名搜索，
//! 不经过 Node / 渲染进程桥。SSH 工作区由调用方过滤（本模块只处理本地路径）。

use std::path::Path;

use serde::Serialize;

use crate::storage;
use crate::storage::services::fs_explorer;

/// 单次返回条目上限：手机弹层一屏可消费的数量，避免大仓库回传过重。
pub const MAX_RESULTS: usize = 30;

/// 手机端可直接消费的引用条目。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MentionItem {
    /// 绝对路径（编码进 `@@file:` / `@@dir:` 标签）。
    pub path: String,
    /// 相对工作区的展示路径。
    pub relative_path: String,
    pub name: String,
    pub is_directory: bool,
}

/// 工作区内搜索引用条目：
/// - 空查询：列出工作区根目录；
/// - 单字符且无 `/`：根目录浅层过滤（全局搜索要求至少两个字符）；
/// - 其余交给 Rust 的路径 / 文件名搜索（`dir/` 会按路径浏览）。
pub fn search(workspace_path: &str, query: &str) -> Vec<MentionItem> {
    if workspace_path.trim().is_empty() || !Path::new(workspace_path).is_dir() {
        return Vec::new();
    }

    let trimmed = query.trim();
    if trimmed.is_empty() {
        return list_root(workspace_path, None);
    }

    let lowered = trimmed.to_lowercase();
    if !lowered.contains('/') && lowered.chars().count() < 2 {
        return list_root(workspace_path, Some(&lowered));
    }

    match storage::search_files(workspace_path.to_string(), trimmed.to_string(), true) {
        Ok(items) => items
            .into_iter()
            .take(MAX_RESULTS)
            .map(|entry| MentionItem {
                path: entry.path,
                relative_path: normalize(&entry.relative_path, &entry.name),
                name: entry.name,
                is_directory: entry.is_directory,
            })
            .collect(),
        Err(_) => Vec::new(),
    }
}

/// 根目录浅层列举：与桌面弹窗一致地过滤隐藏项与构建 / 依赖目录。
fn list_root(workspace_path: &str, filter: Option<&str>) -> Vec<MentionItem> {
    let Ok(entries) = fs_explorer::read_directory_entries(workspace_path) else {
        return Vec::new();
    };

    entries
        .into_iter()
        .filter(|entry| !entry.name.starts_with('.'))
        .filter(|entry| !entry.is_directory || !fs_explorer::should_skip_dir(&entry.name))
        .filter(|entry| match filter {
            Some(needle) => entry.name.to_lowercase().contains(needle),
            None => true,
        })
        .take(MAX_RESULTS)
        .map(|entry| MentionItem {
            path: entry.path,
            relative_path: entry.name.clone(),
            name: entry.name,
            is_directory: entry.is_directory,
        })
        .collect()
}

/// 展示路径统一为 `/` 分隔；搜索结果缺失相对路径时退回文件名。
fn normalize(relative_path: &str, name: &str) -> String {
    let trimmed = relative_path.trim();
    if trimmed.is_empty() {
        return name.to_string();
    }
    trimmed.replace('\\', "/")
}
