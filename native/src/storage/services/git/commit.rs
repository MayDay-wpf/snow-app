use std::process::Stdio;

use napi::bindgen_prelude::*;

use super::{
    build_git_command, is_git_repo, run_git, GitCheckoutResult, GitCommitResult,
    GitPushPullResult, GIT_NOT_FOUND_MESSAGE,
};

pub fn commit_changes(repo_path: &str, message: &str) -> Result<GitCommitResult> {
    if message.trim().is_empty() {
        return Ok(GitCommitResult {
            success: false,
            message: "Commit message is required".to_string(),
            hash: None,
        });
    }

    match run_git(repo_path, &["commit", "-m", message]) {
        Ok(_) => {
            let hash = run_git(repo_path, &["rev-parse", "HEAD"])
                .ok()
                .and_then(|s| {
                    let trimmed = s.trim();
                    if trimmed.len() >= 8 {
                        Some(trimmed[..8].to_string())
                    } else {
                        Some(trimmed.to_string())
                    }
                });

            Ok(GitCommitResult {
                success: true,
                message: "Commit successful".to_string(),
                hash,
            })
        }
        Err(e) => Ok(GitCommitResult {
            success: false,
            message: format!("{e}"),
            hash: None,
        }),
    }
}

/// 执行 push/pull 并带回 git 的完整输出（log）。
/// git 的输出分布在两条流上（push 统计在 stderr、pull 冲突详情在
/// stdout），必须全部捕获；同时禁止终端凭据提示，避免无凭据时挂起。
fn run_git_network(repo_path: &str, args: &[&str]) -> Result<(bool, String)> {
    let mut cmd = build_git_command(repo_path, args);
    cmd.env("GIT_TERMINAL_PROMPT", "0").stdin(Stdio::null());
    let output = cmd.output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            Error::from_reason(GIT_NOT_FOUND_MESSAGE)
        } else {
            Error::from_reason(format!("Failed to execute git: {e}"))
        }
    })?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let success = output.status.success();
    // 失败时 stderr 优先（fatal 原因在前），成功时 stdout 优先（pull 摘要）
    let combined = if success {
        join_log(&stdout, &stderr)
    } else {
        let detail = join_log(&stderr, &stdout);
        if detail.is_empty() {
            format!("git exited with code {}", output.status.code().unwrap_or(-1))
        } else {
            detail
        }
    };
    Ok((success, combined))
}

fn join_log(first: &str, second: &str) -> String {
    if first.is_empty() {
        second.to_string()
    } else if second.is_empty() {
        first.to_string()
    } else {
        format!("{first}\n{second}")
    }
}

/// push/pull 共用：失败时 message 保证非空；成功且 git 无输出时用 fallback。
fn push_pull_result(
    repo_path: &str,
    args: &[&str],
    fallback: &str,
) -> Result<GitPushPullResult> {
    let (success, log) = run_git_network(repo_path, args)?;
    Ok(GitPushPullResult {
        success,
        message: if success && log.is_empty() {
            fallback.to_string()
        } else {
            log
        },
    })
}

pub fn push_changes(repo_path: &str) -> Result<GitPushPullResult> {
    push_pull_result(repo_path, &["push"], "Push successful")
}

pub fn pull_changes(repo_path: &str) -> Result<GitPushPullResult> {
    push_pull_result(repo_path, &["pull"], "Pull successful")
}

/// Fetch from the remote without merging. Used by the UI to keep the
/// ahead/behind counts (and thus the "remote has updates" indicator)
/// fresh. Never throws: failures (offline, no remote, auth) are reported
/// via `success: false` so background polling can ignore them silently.
pub fn fetch_remote(repo_path: &str) -> Result<GitPushPullResult> {
    if !is_git_repo(repo_path) {
        return Ok(GitPushPullResult {
            success: false,
            message: "Not a git repository".to_string(),
        });
    }

    // Skip repos without any remote configured — `git fetch` would fail.
    let has_remote = !run_git(repo_path, &["remote"])?.trim().is_empty();
    if !has_remote {
        return Ok(GitPushPullResult {
            success: true,
            message: "No remote configured".to_string(),
        });
    }

    match run_git(repo_path, &["fetch", "--quiet", "--prune"]) {
        Ok(_) => Ok(GitPushPullResult {
            success: true,
            message: "Fetch successful".to_string(),
        }),
        Err(e) => Ok(GitPushPullResult {
            success: false,
            message: format!("{e}"),
        }),
    }
}

pub fn checkout_branch(repo_path: &str, branch_name: &str) -> Result<GitCheckoutResult> {
    // If the branch name contains '/', it's a remote tracking branch (e.g. "origin/main").
    // Running `git checkout origin/main` would enter detached HEAD state.
    // Instead, extract the local branch name and create a tracking branch.
    if let Some(slash_idx) = branch_name.find('/') {
        let local_name = &branch_name[slash_idx + 1..];

        if !local_name.is_empty() {
            // First, try to checkout the local branch (it may already exist).
            if let Ok(_) = run_git(repo_path, &["checkout", local_name]) {
                return Ok(GitCheckoutResult {
                    success: true,
                    message: format!("Switched to {local_name}"),
                });
            }

            // Local branch doesn't exist; create a new tracking branch.
            match run_git(repo_path, &["checkout", "-b", local_name, branch_name]) {
                Ok(_) => {
                    return Ok(GitCheckoutResult {
                        success: true,
                        message: format!("Switched to {local_name} (tracking {branch_name})"),
                    })
                }
                Err(e) => {
                    return Ok(GitCheckoutResult {
                        success: false,
                        message: format!("{e}"),
                    })
                }
            }
        }
    }

    // Local branch: checkout directly.
    match run_git(repo_path, &["checkout", branch_name]) {
        Ok(_) => Ok(GitCheckoutResult {
            success: true,
            message: format!("Switched to {branch_name}"),
        }),
        Err(e) => Ok(GitCheckoutResult {
            success: false,
            message: format!("{e}"),
        }),
    }
}

/// Creates a new branch from the current HEAD and checks it out immediately.
///
/// Uses `git checkout -b <branch_name>` which fails if the branch already
/// exists, preventing accidental overwrites. The caller is responsible for
/// validating the branch name format before calling this function.
pub fn create_branch(repo_path: &str, branch_name: &str) -> Result<GitCheckoutResult> {
    match run_git(repo_path, &["checkout", "-b", branch_name]) {
        Ok(_) => Ok(GitCheckoutResult {
            success: true,
            message: format!("Created and switched to {branch_name}"),
        }),
        Err(e) => Ok(GitCheckoutResult {
            success: false,
            message: format!("{e}"),
        }),
    }
}
