//! 系统提示词的「Linked Project Group」章节。
//!
//! 当当前项目属于一个关联项目组（合集收纳了 ≥ 2 个本地项目）时，这些根目录
//! 被搜索工具当成同一个统一项目。章节把组名与全部根目录（含绝对路径）注入
//! 系统提示词，并说明 grep / 文件搜索自动覆盖全部根，让模型不必逐个目录试探。
//!
//! 仿 imagegen / Project Memory 章节的「方案 B」：追加在系统提示词末尾，
//! 查询失败或无关联时返回空字符串（静默降级，不打断请求）。

use std::path::{Path, PathBuf};

use crate::storage::services::project_collections::resolve_linked_project_roots;

/// 构建关联项目组章节；未关联（或查询失败）时返回空字符串。
pub async fn build_linked_projects_section(
    database_path: &Path,
    directory_id: Option<&str>,
) -> String {
    let Some(directory_id) = directory_id
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
    else {
        return String::new();
    };
    let database_path = PathBuf::from(database_path);

    let group = {
        let directory_id = directory_id.clone();
        tokio::task::spawn_blocking(move || {
            resolve_linked_project_roots(&database_path, &directory_id)
        })
        .await
        .ok()
        .and_then(Result::ok)
        .flatten()
    };
    let Some(group) = group else {
        return String::new();
    };

    let name = group.name.trim();
    let mut lines = vec![
        format!("## Linked Project Group: {name}"),
        String::new(),
        format!(
            "The current project is linked with sibling project roots in the group \"{name}\"; search tools treat them as ONE unified project:"
        ),
        String::new(),
    ];
    for root in group.roots.iter() {
        let marker = if root.directory_id == directory_id {
            " (current project)"
        } else {
            ""
        };
        lines.push(format!(
            "- {} — {}{}",
            root.name.trim(),
            root.path.trim(),
            marker
        ));
    }
    lines.push(String::new());
    lines.push(
        "Rules:\n\
         - `grep-search` / `grep-find` on the current project root (or without `path`) automatically search ALL roots above and merge the results; every match carries an absolute `file` path you can pass straight to `filesystem-read`.\n\
         - File search (file names, @-mentions and their results) covers every root above as well.\n\
         - Relative paths still resolve against the current project root; use the absolute paths above to reach files inside sibling roots."
            .to_string(),
    );

    lines.join("\n")
}
