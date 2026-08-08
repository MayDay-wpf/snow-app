use std::path::Path;
use std::process::Command;

use napi::bindgen_prelude::*;
use napi_derive::napi;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

use crate::exports::terminal::{detect_shell_family, load_terminal_shell_path_sync};

/// Git 可执行文件缺失时给用户的明确提示，避免与误导性的
/// "not a git repository" 混淆。
const GIT_NOT_FOUND_MESSAGE: &str = "git executable not found in PATH — install Git for Windows, or configure a WSL shell in the terminal settings";

/// 按 POSIX 单引号规则转义 shell 参数。WSL 模式下 git 命令通过
/// `bash -lc` 执行，参数中的空格/引号/通配符必须正确转义。
fn shell_quote(arg: &str) -> String {
    format!("'{}'", arg.replace('\'', "'\\''"))
}

/// 将 `\\wsl$\<distro>\home\user\proj` 形式的 UNC 路径转换为 WSL 内的
/// Linux 路径（`/home/user/proj`），供 `wsl.exe --cd` 使用。普通 Windows
/// 路径（`C:\...`）原样返回 —— wsl.exe 会自动转换为 `/mnt/c/...`。
fn wsl_cd_path(repo_path: &str) -> String {
    if let Some(rest) = repo_path.strip_prefix(r"\\wsl$\") {
        if let Some(slash) = rest.find('\\') {
            let linux_part = &rest[slash + 1..];
            return format!("/{}", linux_part.replace('\\', "/"));
        }
    }
    repo_path.to_string()
}

/// 构造 git 命令执行器。
///
/// 当系统设置的终端 shell 为 WSL 时，通过 `wsl.exe --cd <dir> -e bash
/// -lc "git ..."` 在 WSL 内执行 git（复用 bash.rs 的终端设置解析），
/// 使未安装 Git for Windows 的机器也能使用 Git 面板；否则直接执行
/// `git`。
fn build_git_command(repo_path: &str, args: &[&str]) -> Command {
    let shell_path = load_terminal_shell_path_sync().unwrap_or_default();
    if detect_shell_family(&shell_path) == "wsl" {
        // 所有参数统一 shell_quote：`safe.directory=*` 中的 `*` 若不
        // 加引号会被 bash 通配符展开，导致 git 收到错误的配置值。
        let git_cmd = [
            "git",
            "-c",
            "core.quotepath=false",
            "-c",
            "safe.directory=*",
        ]
        .iter()
        .chain(args.iter())
        .map(|a| shell_quote(a))
        .collect::<Vec<String>>()
        .join(" ");
        let mut cmd = Command::new(&shell_path);
        cmd.arg("--cd").arg(wsl_cd_path(repo_path));
        cmd.args(["-e", "bash", "-lc", &git_cmd]);
        cmd
    } else {
        let mut cmd = Command::new("git");
        cmd.args(["-c", "core.quotepath=false", "-c", "safe.directory=*"])
            .args(args)
            .current_dir(repo_path);
        cmd
    }
}

// ===== NAPI Types =====

#[napi(object)]
pub struct GitFileStatus {
    pub path: String,
    pub old_path: Option<String>,
    pub index_status: String,
    pub workdir_status: String,
    pub status: String,
}

#[napi(object)]
pub struct GitStatusResult {
    pub is_repo: bool,
    pub current_branch: String,
    pub upstream: Option<String>,
    pub ahead: i32,
    pub behind: i32,
    pub files: Vec<GitFileStatus>,
    pub staged_count: i32,
    pub unstaged_count: i32,
    pub untracked_count: i32,
}

#[napi(object)]
pub struct GitBranch {
    pub name: String,
    pub is_current: bool,
    pub is_remote: bool,
    pub remote_name: Option<String>,
}

#[napi(object)]
pub struct GitDiffResult {
    pub content: String,
    pub is_binary: bool,
}

#[napi(object)]
pub struct GitStageResult {
    pub success: bool,
    pub message: String,
}

#[napi(object)]
pub struct GitCommitResult {
    pub success: bool,
    pub message: String,
    pub hash: Option<String>,
}

#[napi(object)]
pub struct GitPushPullResult {
    pub success: bool,
    pub message: String,
}

#[napi(object)]
pub struct GitCheckoutResult {
    pub success: bool,
    pub message: String,
}

#[napi(object)]
pub struct GitLogEntry {
    pub hash: String,
    pub short_hash: String,
    pub author: String,
    pub email: String,
    pub date: String,
    pub message: String,
    pub refs: String,
    pub parents: Vec<String>,
}

#[napi(object)]
pub struct GitCommitFile {
    pub path: String,
    pub status: String,
}

#[napi(object)]
pub struct GitRepoInfo {
    pub path: String,
    pub name: String,
    pub current_branch: String,
}

// ===== Internal helpers =====

fn run_git(repo_path: &str, args: &[&str]) -> Result<String> {
    let mut cmd = build_git_command(repo_path, args);
    // `safe.directory=*` bypasses Git's dubious-ownership check
    // (CVE-2022-24765). Without it, Windows Git refuses to run inside
    // WSL (`\\wsl$\...`) or other network/UNC paths because the repo files
    // are owned by the Linux user, not the current Windows user.

    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let output = cmd.output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            // git (or the configured WSL shell) is not installed — surface
            // a clear message instead of a generic spawn error.
            Error::from_reason(GIT_NOT_FOUND_MESSAGE)
        } else {
            Error::from_reason(format!("Failed to execute git: {e}"))
        }
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let err_msg = if stderr.is_empty() { stdout } else { stderr };
        return Err(Error::from_reason(err_msg));
    }

    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Like `run_git` but returns stdout regardless of exit code.
///
/// `git diff --no-index` exits with code 1 when the two files differ,
/// which is the normal (expected) case for new/untracked files.
/// Using `run_git` would treat that as an error and discard the stdout.
fn run_git_raw(repo_path: &str, args: &[&str]) -> Result<String> {
    let mut cmd = build_git_command(repo_path, args);
    // Same `safe.directory=*` bypass as `run_git` — see its comment.

    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let output = cmd.output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            Error::from_reason(GIT_NOT_FOUND_MESSAGE)
        } else {
            Error::from_reason(format!("Failed to execute git: {e}"))
        }
    })?;

    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn is_git_repo(repo_path: &str) -> bool {
    Path::new(repo_path).join(".git").exists()
}

fn parse_status_char(c: char) -> String {
    if c == ' ' {
        return String::new();
    }
    c.to_string()
}

fn derive_display_status(index_status: &str, workdir_status: &str) -> String {
    if index_status == "R" {
        return "R".to_string();
    }
    if index_status == "C" {
        return "C".to_string();
    }
    if workdir_status == "?" {
        return "U".to_string();
    }
    if workdir_status == "!" {
        return "I".to_string();
    }
    if index_status == "A" {
        return "A".to_string();
    }
    if index_status == "M" {
        return "M".to_string();
    }
    if index_status == "D" {
        return "D".to_string();
    }
    if workdir_status == "M" {
        return "M".to_string();
    }
    if workdir_status == "D" {
        return "D".to_string();
    }
    if !index_status.is_empty() && !workdir_status.is_empty() {
        return "MM".to_string();
    }
    if !index_status.is_empty() {
        return index_status.to_string();
    }
    if !workdir_status.is_empty() {
        return workdir_status.to_string();
    }
    "?".to_string()
}

// ===== Public API =====

pub fn get_git_status(repo_path: &str) -> Result<GitStatusResult> {
    // Gracefully handle non-repo paths: return is_repo=false instead of
    // propagating git's "fatal: not a git repository" error to the UI.
    // This covers both the case where .git doesn't exist and the edge case
    // where .git exists but git itself rejects the path (e.g. corrupted
    // .git, broken worktree pointer, or .git file pointing to a missing
    // gitdir).
    if !is_git_repo(repo_path) {
        return Ok(GitStatusResult {
            is_repo: false,
            current_branch: String::new(),
            upstream: None,
            ahead: 0,
            behind: 0,
            files: Vec::new(),
            staged_count: 0,
            unstaged_count: 0,
            untracked_count: 0,
        });
    }

    // If is_git_repo returned true but git still fails, distinguish two
    // cases:
    // - git reports "not a git repository" (corrupted repo, broken
    //   worktree, .git file pointing to a missing gitdir, ...): treat as
    //   a non-repo rather than surfacing a raw git error to the user.
    // - any other error (git executable missing from PATH, permission
    //   denied, ...): propagate it so the UI shows a clear message
    //   instead of a misleading "Not a git repository".
    let status_out = match run_git(
        repo_path,
        &["status", "--porcelain=v1", "-b", "--find-renames", "-uall"],
    ) {
        Ok(out) => out,
        Err(e) => {
            if e.to_string().contains("not a git repository") {
                return Ok(GitStatusResult {
                    is_repo: false,
                    current_branch: String::new(),
                    upstream: None,
                    ahead: 0,
                    behind: 0,
                    files: Vec::new(),
                    staged_count: 0,
                    unstaged_count: 0,
                    untracked_count: 0,
                });
            }
            return Err(e);
        }
    };
    let lines: Vec<&str> = status_out.lines().filter(|l| !l.is_empty()).collect();

    let mut current_branch = String::new();
    let mut upstream: Option<String> = None;
    let mut ahead = 0;
    let mut behind = 0;
    let mut files: Vec<GitFileStatus> = Vec::new();

    for line in &lines {
        if line.starts_with("## ") {
            let branch_part = &line[3..];

            // Parse upstream
            if let Some(idx) = branch_part.find("...") {
                let after = &branch_part[idx + 3..];
                let upstream_name = after.split_whitespace().next().unwrap_or("");
                if !upstream_name.is_empty() {
                    upstream = Some(upstream_name.to_string());
                }
            }

            // Parse ahead/behind
            let lower = branch_part.to_lowercase();
            if let Some(ahead_pos) = lower.find("ahead ") {
                let rest = &branch_part[ahead_pos + 6..];
                if let Some(end) = rest.find(|c: char| !c.is_ascii_digit()) {
                    ahead = rest[..end].parse().unwrap_or(0);
                } else {
                    ahead = rest.parse().unwrap_or(0);
                }
            }
            if let Some(behind_pos) = lower.find("behind ") {
                let rest = &branch_part[behind_pos + 7..];
                if let Some(end) = rest.find(|c: char| !c.is_ascii_digit()) {
                    behind = rest[..end].parse().unwrap_or(0);
                } else {
                    behind = rest.parse().unwrap_or(0);
                }
            }

            // Parse branch name
            let branch_name_raw: &str = if let Some(idx) = branch_part.find("...") {
                &branch_part[..idx]
            } else {
                let end = branch_part.find(' ').unwrap_or(branch_part.len());
                &branch_part[..end]
            };

            if branch_name_raw.starts_with("HEAD") {
                current_branch = "HEAD".to_string();
            } else {
                current_branch = branch_name_raw.to_string();
            }
            continue;
        }

        // File status lines: XY <path>
        if line.len() < 3 {
            continue;
        }

        let chars: Vec<char> = line.chars().collect();
        let index_status = parse_status_char(chars[0]);
        let workdir_status = parse_status_char(chars[1]);
        let rest = &line[3..];

        let mut file_path = rest.to_string();
        let mut old_path: Option<String> = None;

        if let Some(arrow_idx) = rest.find(" -> ") {
            old_path = Some(rest[..arrow_idx].to_string());
            file_path = rest[arrow_idx + 4..].to_string();
        }

        // Strip surrounding quotes
        if file_path.starts_with('"') && file_path.ends_with('"') && file_path.len() >= 2 {
            file_path = file_path[1..file_path.len() - 1].to_string();
        }

        files.push(GitFileStatus {
            path: file_path,
            old_path,
            index_status: chars[0].to_string(),
            workdir_status: chars[1].to_string(),
            status: derive_display_status(&index_status, &workdir_status),
        });
    }

    let mut staged_count = 0;
    let mut unstaged_count = 0;
    let mut untracked_count = 0;

    for f in &files {
        if f.workdir_status == "?" || f.workdir_status == "!" {
            untracked_count += 1;
        } else {
            if !f.index_status.is_empty() && f.index_status != " " && f.index_status != "?" {
                staged_count += 1;
            }
            if !f.workdir_status.is_empty() && f.workdir_status != " " && f.workdir_status != "?" {
                unstaged_count += 1;
            }
        }
    }

    Ok(GitStatusResult {
        is_repo: true,
        current_branch,
        upstream,
        ahead,
        behind,
        files,
        staged_count,
        unstaged_count,
        untracked_count,
    })
}

pub fn get_git_branches(repo_path: &str) -> Result<Vec<GitBranch>> {
    if !is_git_repo(repo_path) {
        return Ok(Vec::new());
    }

    let output = run_git(
        repo_path,
        &[
            "branch",
            "--list",
            "--all",
            "--format=%(HEAD)%(refname:short) %(objectname:short) %(upstream:short)",
        ],
    )?;

    let mut branches: Vec<GitBranch> = Vec::new();

    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let is_current = trimmed.starts_with('*');
        let rest = if is_current {
            trimmed[1..].trim_start()
        } else {
            trimmed
        };

        let parts: Vec<&str> = rest.split_whitespace().collect();
        let name = match parts.first() {
            Some(n) => *n,
            None => continue,
        };

        if name == "HEAD" {
            continue;
        }

        let is_remote = name.contains('/');
        let remote_name = if is_remote {
            let slash_idx = name.find('/').unwrap();
            Some(name[..slash_idx].to_string())
        } else {
            None
        };

        branches.push(GitBranch {
            name: name.to_string(),
            is_current,
            is_remote,
            remote_name,
        });
    }

    Ok(branches)
}

pub fn stage_files(repo_path: &str, file_paths: &[String]) -> Result<GitStageResult> {
    if file_paths.is_empty() {
        return Ok(GitStageResult {
            success: true,
            message: "No files to stage".to_string(),
        });
    }

    let args: Vec<&str> = file_paths.iter().map(|s| s.as_str()).collect();
    let mut full_args = vec!["add", "--"];
    full_args.extend(args);

    match run_git(repo_path, &full_args) {
        Ok(_) => Ok(GitStageResult {
            success: true,
            message: "Files staged successfully".to_string(),
        }),
        Err(e) => Ok(GitStageResult {
            success: false,
            message: format!("{e}"),
        }),
    }
}

pub fn unstage_files(repo_path: &str, file_paths: &[String]) -> Result<GitStageResult> {
    if file_paths.is_empty() {
        return Ok(GitStageResult {
            success: true,
            message: "No files to unstage".to_string(),
        });
    }

    let args: Vec<&str> = file_paths.iter().map(|s| s.as_str()).collect();
    let mut full_args = vec!["reset", "HEAD", "--"];
    full_args.extend(args);

    match run_git(repo_path, &full_args) {
        Ok(_) => Ok(GitStageResult {
            success: true,
            message: "Files unstaged successfully".to_string(),
        }),
        Err(e) => Ok(GitStageResult {
            success: false,
            message: format!("{e}"),
        }),
    }
}

pub fn stage_all(repo_path: &str) -> Result<GitStageResult> {
    match run_git(repo_path, &["add", "--all"]) {
        Ok(_) => Ok(GitStageResult {
            success: true,
            message: "All changes staged".to_string(),
        }),
        Err(e) => Ok(GitStageResult {
            success: false,
            message: format!("{e}"),
        }),
    }
}

pub fn unstage_all(repo_path: &str) -> Result<GitStageResult> {
    match run_git(repo_path, &["reset", "HEAD"]) {
        Ok(_) => Ok(GitStageResult {
            success: true,
            message: "All changes unstaged".to_string(),
        }),
        Err(e) => Ok(GitStageResult {
            success: false,
            message: format!("{e}"),
        }),
    }
}

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

pub fn push_changes(repo_path: &str) -> Result<GitPushPullResult> {
    match run_git(repo_path, &["push"]) {
        Ok(stdout) => {
            let msg = if stdout.trim().is_empty() {
                "Push successful".to_string()
            } else {
                stdout.trim().to_string()
            };
            Ok(GitPushPullResult {
                success: true,
                message: msg,
            })
        }
        Err(e) => Ok(GitPushPullResult {
            success: false,
            message: format!("{e}"),
        }),
    }
}

pub fn pull_changes(repo_path: &str) -> Result<GitPushPullResult> {
    match run_git(repo_path, &["pull"]) {
        Ok(stdout) => {
            let msg = if stdout.trim().is_empty() {
                "Pull successful".to_string()
            } else {
                stdout.trim().to_string()
            };
            Ok(GitPushPullResult {
                success: true,
                message: msg,
            })
        }
        Err(e) => Ok(GitPushPullResult {
            success: false,
            message: format!("{e}"),
        }),
    }
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

pub fn discard_changes(repo_path: &str, file_paths: &[String]) -> Result<GitStageResult> {
    if file_paths.is_empty() {
        return Ok(GitStageResult {
            success: true,
            message: "No files to discard".to_string(),
        });
    }

    // Partition into untracked files ("?" workdir status) and tracked files.
    // Untracked files: `git clean -f -- <path>` removes them.
    // Tracked files: `git checkout -- <path>` restores them to HEAD state.
    let mut untracked: Vec<&str> = Vec::new();
    let mut tracked: Vec<&str> = Vec::new();

    // Query the current status to classify each file path.
    let status_output = match run_git(repo_path, &["status", "--porcelain", "-z", "-uall"]) {
        Ok(s) => s,
        Err(e) => {
            return Ok(GitStageResult {
                success: false,
                message: format!("{e}"),
            })
        }
    };

    let path_set: std::collections::HashSet<&str> = file_paths.iter().map(|s| s.as_str()).collect();

    for entry in status_output.split('\0') {
        if entry.is_empty() {
            continue;
        }
        // porcelain format: "XY <path>" (first 3 chars: X=index, Y=workdir, space, then path)
        let xy = &entry[..2];
        let path = entry[3..].trim_start_matches('"');
        if path_set.contains(path) {
            if xy.starts_with('?') {
                untracked.push(path);
            } else {
                tracked.push(path);
            }
        }
    }

    // If a requested path wasn't found in status output, treat it as tracked
    // (checkout -- will handle it or produce an error).
    for p in &path_set {
        if !untracked.contains(p) && !tracked.contains(p) {
            tracked.push(p);
        }
    }

    if !tracked.is_empty() {
        let mut args = vec!["checkout", "--"];
        args.extend(tracked.iter().copied());
        match run_git(repo_path, &args) {
            Ok(_) => {}
            Err(e) => {
                return Ok(GitStageResult {
                    success: false,
                    message: format!("{e}"),
                })
            }
        }
    }

    if !untracked.is_empty() {
        let mut args = vec!["clean", "-f", "--"];
        args.extend(untracked.iter().copied());
        match run_git(repo_path, &args) {
            Ok(_) => {}
            Err(e) => {
                return Ok(GitStageResult {
                    success: false,
                    message: format!("{e}"),
                })
            }
        }
    }

    Ok(GitStageResult {
        success: true,
        message: "Changes discarded successfully".to_string(),
    })
}

/// Returns the full staged diff (`git diff --cached`).
///
/// This is used by the AI commit-message generator to analyse what has been
/// staged and produce a concise commit message.
pub fn get_staged_diff(repo_path: &str) -> Result<String> {
    run_git(repo_path, &["diff", "--cached"])
}

pub fn get_file_diff(repo_path: &str, file_path: &str, staged: bool) -> Result<GitDiffResult> {
    let args: Vec<&str> = if staged {
        vec!["diff", "--cached", "--", file_path]
    } else {
        vec!["diff", "--", file_path]
    };

    match run_git(repo_path, &args) {
        Ok(stdout) => {
            if stdout.contains("Binary files") {
                // Git's heuristic may falsely flag text files as binary
                // (e.g. files containing NUL bytes). Retry with --text
                // to force a text-mode diff.
                let text_args: Vec<&str> = if staged {
                    vec!["diff", "--cached", "--text", "--", file_path]
                } else {
                    vec!["diff", "--text", "--", file_path]
                };
                match run_git(repo_path, &text_args) {
                    Ok(text_diff) if !text_diff.is_empty() => {
                        return Ok(GitDiffResult {
                            content: text_diff,
                            is_binary: false,
                        });
                    }
                    _ => {
                        return Ok(GitDiffResult {
                            content: "Binary file - diff not available".to_string(),
                            is_binary: true,
                        });
                    }
                }
            }

            // If no diff and not staged, the file may be untracked (new).
            // `git diff --no-index /dev/null <file>` generates a diff showing
            // the entire file as additions.  It exits with code 1 when the
            // files differ (the normal case), so we must use `run_git_raw`
            // which ignores the exit code and returns stdout.
            if !staged && stdout.is_empty() {
                let no_index_args = vec!["diff", "--no-index", "--text", "/dev/null", file_path];
                let full_diff = run_git_raw(repo_path, &no_index_args).unwrap_or_default();
                if !full_diff.is_empty() {
                    return Ok(GitDiffResult {
                        content: full_diff,
                        is_binary: false,
                    });
                }
            }

            Ok(GitDiffResult {
                content: stdout,
                is_binary: false,
            })
        }
        Err(e) => Ok(GitDiffResult {
            content: format!("{e}"),
            is_binary: false,
        }),
    }
}

pub fn get_git_log(repo_path: &str, skip: i32, limit: i32) -> Result<Vec<GitLogEntry>> {
    if !is_git_repo(repo_path) {
        return Ok(Vec::new());
    }

    let skip_count = if skip > 0 { skip } else { 0 };
    let max_count = if limit <= 0 { 50 } else { limit };
    let skip_str = skip_count.to_string();
    let max_count_str = max_count.to_string();
    let format_arg = "--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%D%x1f%P";

    // Use run_git_raw because `git log` on an empty repo exits with code 128
    // ("fatal: your current branch does not have any commits yet").
    // run_git_raw returns stdout regardless of exit code, so we get an empty
    // string for repos with no commits.
    // `--decorate=full` emits unambiguous ref names (refs/heads/…,
    // refs/remotes/…, refs/tags/…) so the renderer can tell local branches,
    // remote-tracking branches and tags apart.
    let output = run_git_raw(
        repo_path,
        &[
            "log",
            "--all",
            "--decorate=full",
            format_arg,
            "--date=iso",
            "--skip",
            &skip_str,
            "--max-count",
            &max_count_str,
        ],
    )?;

    let mut entries: Vec<GitLogEntry> = Vec::new();

    for line in output.lines() {
        if line.is_empty() {
            continue;
        }

        let parts: Vec<&str> = line.split('\x1f').collect();
        if parts.len() < 8 {
            continue;
        }

        let parents: Vec<String> = parts[7].split_whitespace().map(|s| s.to_string()).collect();

        entries.push(GitLogEntry {
            hash: parts[0].to_string(),
            short_hash: parts[1].to_string(),
            author: parts[2].to_string(),
            email: parts[3].to_string(),
            date: parts[4].to_string(),
            message: parts[5].to_string(),
            refs: parts[6].to_string(),
            parents,
        });
    }

    Ok(entries)
}

pub fn get_commit_files(repo_path: &str, hash: &str) -> Result<Vec<GitCommitFile>> {
    if !is_git_repo(repo_path) {
        return Ok(Vec::new());
    }

    let output = run_git_raw(
        repo_path,
        &["diff-tree", "--no-commit-id", "--name-status", "-r", hash],
    )?;

    let mut files: Vec<GitCommitFile> = Vec::new();

    for line in output.lines() {
        if line.is_empty() {
            continue;
        }

        let parts: Vec<&str> = line.splitn(2, '\t').collect();
        if parts.len() < 2 {
            continue;
        }

        files.push(GitCommitFile {
            status: parts[0].to_string(),
            path: parts[1].to_string(),
        });
    }

    Ok(files)
}

/// Get the full diff introduced by a single commit (`git show <hash>`).
///
/// Suppresses the commit-header/message output (`--format=`) so only the
/// patch remains. Binary files are detected the same way as `get_file_diff`.
pub fn get_commit_diff(repo_path: &str, hash: &str) -> Result<GitDiffResult> {
    if !is_git_repo(repo_path) {
        return Ok(GitDiffResult {
            content: String::new(),
            is_binary: false,
        });
    }

    let args = vec!["show", "--format=", "--find-renames", "--no-ext-diff", hash];

    match run_git(repo_path, &args) {
        Ok(stdout) => {
            if stdout.contains("Binary files") {
                let text_args = vec!["show", "--format=", "--text", "--no-ext-diff", hash];
                match run_git(repo_path, &text_args) {
                    Ok(text_diff) if !text_diff.is_empty() => {
                        return Ok(GitDiffResult {
                            content: text_diff,
                            is_binary: false,
                        });
                    }
                    _ => {
                        return Ok(GitDiffResult {
                            content: "Binary file - diff not available".to_string(),
                            is_binary: true,
                        });
                    }
                }
            }

            Ok(GitDiffResult {
                content: stdout,
                is_binary: false,
            })
        }
        Err(e) => Ok(GitDiffResult {
            content: format!("{e}"),
            is_binary: false,
        }),
    }
}

/// Get the diff of a single file within a single commit
/// (`git show <hash> -- <path>`).
///
/// `git show` is used instead of `git diff <hash>^ <hash>` because it also
/// works for the root commit (compares against the empty tree) and for
/// merge commits it shows the combined diff against the first parent.
/// Binary files are detected the same way as `get_file_diff` / `get_commit_diff`.
pub fn get_commit_file_diff(repo_path: &str, hash: &str, file_path: &str) -> Result<GitDiffResult> {
    if !is_git_repo(repo_path) {
        return Ok(GitDiffResult {
            content: String::new(),
            is_binary: false,
        });
    }

    let args = vec![
        "show",
        "--format=",
        "--find-renames",
        "--no-ext-diff",
        hash,
        "--",
        file_path,
    ];

    match run_git(repo_path, &args) {
        Ok(stdout) => {
            if stdout.contains("Binary files") {
                let text_args = vec![
                    "show",
                    "--format=",
                    "--text",
                    "--no-ext-diff",
                    hash,
                    "--",
                    file_path,
                ];
                match run_git(repo_path, &text_args) {
                    Ok(text_diff) if !text_diff.is_empty() => {
                        return Ok(GitDiffResult {
                            content: text_diff,
                            is_binary: false,
                        });
                    }
                    _ => {
                        return Ok(GitDiffResult {
                            content: "Binary file - diff not available".to_string(),
                            is_binary: true,
                        });
                    }
                }
            }

            Ok(GitDiffResult {
                content: stdout,
                is_binary: false,
            })
        }
        Err(e) => Ok(GitDiffResult {
            content: format!("{e}"),
            is_binary: false,
        }),
    }
}

/// Scan a directory for git repositories.
///
/// Recursively walks `root_path` looking for subdirectories containing a
/// `.git` entry (either a directory or a `.git` file for worktrees/submodules).
/// When a git repo is found, its subdirectories are NOT recursed into —
/// nested repos inside an already-discovered repo are skipped (matching
/// VSCode's behaviour where each workspace folder is treated independently).
///
/// Common directories that should never be traversed (node_modules, .git,
/// dist, build, target, etc.) are skipped to keep the scan fast.
///
/// Returns a list of `GitRepoInfo` with the repo path, display name (the
/// folder name), and current branch name.
pub fn discover_git_repos(root_path: &str) -> Result<Vec<GitRepoInfo>> {
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
        scan_dir_for_repos(root, &mut repos);
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

fn scan_dir_for_repos(dir: &Path, repos: &mut Vec<GitRepoInfo>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
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

        // Otherwise, if it's a directory, recurse into it (unless it's
        // a known heavy/skip directory).
        if path.is_dir() {
            if let Some(dir_name) = path.file_name() {
                if is_skip_dir(&dir_name.to_string_lossy()) {
                    continue;
                }
            }
            scan_dir_for_repos(&path, repos);
        }
    }
}

/// Get the current branch name via `git rev-parse --abbrev-ref HEAD`.
/// Returns an empty string for detached HEAD or on error.
fn get_current_branch_name(repo_path: &str) -> Result<String> {
    let output = run_git_raw(repo_path, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    let branch = output.trim();
    if branch.is_empty() || branch == "HEAD" {
        Ok(String::new())
    } else {
        Ok(branch.to_string())
    }
}
