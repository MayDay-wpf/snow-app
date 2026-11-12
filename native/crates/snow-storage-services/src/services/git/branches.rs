use std::collections::HashMap;

use napi::bindgen_prelude::*;

use super::{is_git_repo, prune_worktree_registry, run_git, run_git_raw, GitBranch, GitWorktree};

fn normalize_repo_path(path: &str) -> String {
    path.replace('\\', "/")
        .trim_end_matches('/')
        .to_lowercase()
}

fn is_same_repo_path(p1: &str, p2: &str) -> bool {
    normalize_repo_path(p1) == normalize_repo_path(p2)
}

pub fn get_git_worktrees(repo_path: &str) -> Result<Vec<GitWorktree>> {
    if !is_git_repo(repo_path) {
        return Ok(Vec::new());
    }

    let _ = prune_worktree_registry(repo_path);

    let output = match run_git(repo_path, &["worktree", "list", "--porcelain"]) {
        Ok(out) => out,
        Err(_) => return Ok(Vec::new()),
    };

    let mut worktrees: Vec<GitWorktree> = Vec::new();
    let mut current_path: Option<String> = None;
    let mut current_head: Option<String> = None;
    let mut current_branch: Option<String> = None;
    let mut is_locked = false;
    let mut lock_reason: Option<String> = None;
    let mut is_prunable = false;

    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            if let (Some(path), Some(head)) = (current_path.take(), current_head.take()) {
                let is_current = is_same_repo_path(&path, repo_path);
                worktrees.push(GitWorktree {
                    path,
                    head,
                    branch: current_branch.take(),
                    is_current,
                    is_locked,
                    lock_reason: lock_reason.take(),
                    is_prunable,
                });
                is_locked = false;
                is_prunable = false;
            }
            continue;
        }

        if let Some(path) = trimmed.strip_prefix("worktree ") {
            current_path = Some(path.trim().to_string());
        } else if let Some(head) = trimmed.strip_prefix("HEAD ") {
            current_head = Some(head.trim().to_string());
        } else if let Some(branch_ref) = trimmed.strip_prefix("branch ") {
            let branch_name = branch_ref
                .trim()
                .strip_prefix("refs/heads/")
                .unwrap_or(branch_ref.trim());
            current_branch = Some(branch_name.to_string());
        } else if trimmed.starts_with("locked") {
            is_locked = true;
            if let Some(reason) = trimmed.strip_prefix("locked ") {
                lock_reason = Some(reason.trim().to_string());
            }
        } else if trimmed.starts_with("prunable") {
            is_prunable = true;
        }
    }

    if let (Some(path), Some(head)) = (current_path.take(), current_head.take()) {
        let is_current = is_same_repo_path(&path, repo_path);
        worktrees.push(GitWorktree {
            path,
            head,
            branch: current_branch.take(),
            is_current,
            is_locked,
            lock_reason: lock_reason.take(),
            is_prunable,
        });
    }

    Ok(worktrees)
}

fn parse_track_info(track: &str) -> (i32, i32, bool) {
    let mut ahead = 0;
    let mut behind = 0;
    let mut is_gone = false;

    for part in track.split(',') {
        let trimmed = part.trim();
        if trimmed == "gone" {
            is_gone = true;
        } else if let Some(rest) = trimmed.strip_prefix("ahead ") {
            if let Ok(n) = rest.trim().parse::<i32>() {
                ahead = n;
            }
        } else if let Some(rest) = trimmed.strip_prefix("behind ") {
            if let Ok(n) = rest.trim().parse::<i32>() {
                behind = n;
            }
        }
    }

    (ahead, behind, is_gone)
}

pub fn get_git_branches(repo_path: &str) -> Result<Vec<GitBranch>> {
    if !is_git_repo(repo_path) {
        return Ok(Vec::new());
    }

    let worktrees = get_git_worktrees(repo_path).unwrap_or_default();
    let mut branch_to_worktree: HashMap<String, String> = HashMap::new();
    for wt in worktrees {
        if let Some(branch) = wt.branch {
            branch_to_worktree.insert(branch, wt.path);
        }
    }

    // 用 for-each-ref 而不是 `git branch --list --all`：后者要为每个分支核对
    // 各 worktree 的检出状态，在 worktree 多的仓库上慢一个数量级（实测本地
    // 12 个 worktree 的仓库：1129ms → 112ms，带上 upstream:track 也只要 243ms）。
    // 两者共用同一套 ref-filter 引擎，输出格式、排序与 %(HEAD) 语义一致。
    let output = run_git(
        repo_path,
        &[
            "for-each-ref",
            "--format=%(HEAD)\t%(refname)\t%(refname:short)\t%(upstream:short)\t%(upstream:track,nobracket)",
            "refs/heads",
            "refs/remotes",
        ],
    )?;

    let mut branches: Vec<GitBranch> = Vec::new();

    for line in output.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            continue;
        }

        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() < 2 {
            continue;
        }

        let is_current = parts[0].contains('*');
        let refname = parts[1].trim();
        let upstream_raw = if parts.len() > 3 { parts[3].trim() } else { "" };
        let track_raw = if parts.len() > 4 { parts[4].trim() } else { "" };

        // 排除空引用、本地 HEAD 符号引用以及远程 HEAD 符号引用（如 refs/remotes/origin/HEAD）
        if refname.is_empty() || refname == "HEAD" || refname.ends_with("/HEAD") {
            continue;
        }

        if let Some(branch_name) = refname.strip_prefix("refs/heads/") {
            if branch_name.is_empty() {
                continue;
            }
            let (ahead, behind, is_gone) = parse_track_info(track_raw);
            let upstream = if upstream_raw.is_empty() {
                None
            } else {
                Some(upstream_raw.to_string())
            };
            let worktree_path = branch_to_worktree.get(branch_name).cloned();

            branches.push(GitBranch {
                name: branch_name.to_string(),
                is_current,
                is_remote: false,
                remote_name: None,
                upstream,
                ahead,
                behind,
                is_gone,
                worktree_path,
            });
        } else if let Some(remotes_part) = refname.strip_prefix("refs/remotes/") {
            if remotes_part.is_empty() {
                continue;
            }
            let Some((remote_name, branch_name)) = remotes_part.split_once('/') else {
                continue;
            };
            if branch_name == "HEAD" {
                continue;
            }
            branches.push(GitBranch {
                name: remotes_part.to_string(),
                is_current,
                is_remote: true,
                remote_name: Some(remote_name.to_string()),
                upstream: None,
                ahead: 0,
                behind: 0,
                is_gone: false,
                worktree_path: None,
            });
        }
    }

    Ok(branches)
}

/// Get the current branch name via `git rev-parse --abbrev-ref HEAD`.
/// Returns an empty string for detached HEAD or on error.
pub(crate) fn get_current_branch_name(repo_path: &str) -> Result<String> {
    let output = run_git_raw(repo_path, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    let branch = output.trim();
    if branch.is_empty() || branch == "HEAD" {
        Ok(String::new())
    } else {
        Ok(branch.to_string())
    }
}
