use std::path::Path;

use napi::bindgen_prelude::*;

use super::branches::get_current_branch_name;
use super::GitRepoInfo;

/// Scan a directory for git repositories.
///
/// Walks `root_path` (breadth-first, at most `max_depth` levels deep) looking
/// for subdirectories containing a `.git` entry (either a directory or a
/// `.git` file for worktrees/submodules). When a git repo is found, its
/// subdirectories are NOT traversed — nested repos inside an already-
/// discovered repo are skipped (matching VSCode's behaviour where each
/// workspace folder is treated independently).
///
/// `max_depth` mirrors VSCode's `git.repositoryScanMaxDepth`: the default is
/// 1 (only direct children of the root are checked), a negative value means
/// unlimited depth. `ignored_folders` are directory names (case-insensitive)
/// that are never traversed, in addition to the built-in skip list.
///
/// Returns a list of `GitRepoInfo` with the repo path, display name (the
/// folder name), and current branch name.
pub fn discover_git_repos(
    root_path: &str,
    max_depth: i32,
    ignored_folders: &[String],
) -> Result<Vec<GitRepoInfo>> {
    let root = Path::new(root_path);
    if !root.is_dir() {
        return Ok(Vec::new());
    }

    let mut repos: Vec<GitRepoInfo> = Vec::new();

    // If the root directory itself is a git repo, add it and don't recurse
    // into it. This handles the common case where the workspace directory
    // IS the git repository (e.g. a single-project workspace), which
    // scan_dir_for_repos would miss because it only checks children.
    if root.join(".git").exists() {
        let path_str = root.to_string_lossy().to_string();
        let name = root
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| path_str.clone());
        let current_branch = get_current_branch_name(&path_str).unwrap_or_default();
        repos.push(GitRepoInfo {
            path: path_str,
            name,
            current_branch,
        });
    } else {
        scan_dir_for_repos(root, max_depth, ignored_folders, &mut repos);
    }

    // Sort by path for deterministic ordering
    repos.sort_by(|a, b| a.path.cmp(&b.path));

    Ok(repos)
}

/// Directories that should never be traversed during repo discovery.
fn is_skip_dir(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | "node_modules"
            | "dist"
            | "build"
            | "out"
            | "target"
            | ".next"
            | ".nuxt"
            | ".cache"
            | ".gradle"
            | "__pycache__"
            | ".venv"
            | "venv"
            | ".idea"
            | ".vscode"
            | "Pods"
            | ".swiftpm"
            | ".build"
    )
}

/// Breadth-first scan of a directory tree for git repositories, honoring the
/// depth limit (`max_depth < 0` = unlimited). Directories in `ignored_folders`
/// (matched case-insensitively against the folder name) are never traversed.
fn scan_dir_for_repos(
    root: &Path,
    max_depth: i32,
    ignored_folders: &[String],
    repos: &mut Vec<GitRepoInfo>,
) {
    let mut queue: std::collections::VecDeque<(std::path::PathBuf, i32)> =
        std::collections::VecDeque::new();
    queue.push_back((root.to_path_buf(), 0));

    while let Some((dir, depth)) = queue.pop_front() {
        if max_depth >= 0 && depth >= max_depth {
            continue;
        }

        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };

        for entry in entries.flatten() {
            let path = entry.path();

            // If this directory itself is a git repo, add it and don't recurse.
            if path.join(".git").exists() {
                let path_str = path.to_string_lossy().to_string();
                let name = path
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| path_str.clone());

                // Attempt to get the current branch; if it fails (corrupted
                // repo, detached HEAD, etc.) default to an empty string.
                let current_branch = get_current_branch_name(&path_str).unwrap_or_default();

                repos.push(GitRepoInfo {
                    path: path_str,
                    name,
                    current_branch,
                });
                continue;
            }

            // Otherwise, if it's a directory, queue it for traversal (unless
            // it's a known heavy/skip directory or user-ignored).
            if path.is_dir() {
                if let Some(dir_name) = path.file_name() {
                    let dir_name = dir_name.to_string_lossy();
                    if is_skip_dir(&dir_name) {
                        continue;
                    }
                    if ignored_folders
                        .iter()
                        .any(|f| f.eq_ignore_ascii_case(&dir_name))
                    {
                        continue;
                    }
                }
                queue.push_back((path, depth + 1));
            }
        }
    }
}
