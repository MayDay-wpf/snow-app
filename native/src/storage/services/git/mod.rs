use std::path::Path;
use std::process::Command;

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::exports::terminal::{detect_shell_family, load_terminal_shell_path_sync};

mod branches;
mod commit;
mod diff;
mod discover;
mod staging;
mod status;

pub use self::branches::*;
pub use self::commit::*;
pub use self::diff::*;
pub use self::discover::*;
pub use self::staging::*;
pub use self::status::*;

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
        let mut cmd = crate::utils::process::cmd(&shell_path);
        cmd.arg("--cd").arg(wsl_cd_path(repo_path));
        cmd.args(["-e", "bash", "-lc", &git_cmd]);
        cmd
    } else {
        let mut cmd = crate::utils::process::cmd("git");
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
    /// True when the change list was truncated by the configured status limit.
    pub status_limit_hit: bool,
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
    pub additions: i32,
    pub deletions: i32,
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

pub(crate) fn run_git(repo_path: &str, args: &[&str]) -> Result<String> {
    let mut cmd = build_git_command(repo_path, args);
    // `safe.directory=*` bypasses Git's dubious-ownership check
    // (CVE-2022-24765). Without it, Windows Git refuses to run inside
    // WSL (`\\wsl$\...`) or other network/UNC paths because the repo files
    // are owned by the Linux user, not the current Windows user.

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
pub(crate) fn run_git_raw(repo_path: &str, args: &[&str]) -> Result<String> {
    let mut cmd = build_git_command(repo_path, args);
    // Same `safe.directory=*` bypass as `run_git` — see its comment.

    let output = cmd.output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            Error::from_reason(GIT_NOT_FOUND_MESSAGE)
        } else {
            Error::from_reason(format!("Failed to execute git: {e}"))
        }
    })?;

    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Like `run_git_raw` but returns the raw stdout bytes without lossy
/// UTF-8 conversion. Used to read file contents (e.g. images) from a
/// revision via `git show <rev>:<path>`, where the bytes must survive
/// intact for base64 encoding.
pub(crate) fn run_git_bytes(repo_path: &str, args: &[&str]) -> Result<Vec<u8>> {
    let mut cmd = build_git_command(repo_path, args);
    // Same `safe.directory=*` bypass as `run_git` — see its comment.

    let output = cmd.output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
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

    Ok(output.stdout)
}

/// 单个文件内容的最大字节数（图片预览传输用）。超出时拒绝读取，
/// 避免超大 base64 经过 IPC 传输导致 UI 卡顿。
const MAX_FILE_CONTENT_BYTES: usize = 20 * 1024 * 1024;

/// Read a file's raw content either from the working tree (`revision` is
/// None/empty) or from a git revision (`git show <revision>:<path>`).
///
/// The content is processed through `process_file_content` so images come
/// back as base64 with a MIME type, ready for direct `<img>` rendering.
pub fn get_file_content(
    repo_path: &str,
    file_path: &str,
    revision: Option<&str>,
) -> Result<crate::storage::services::fs_explorer::FileContentResult> {
    let bytes: Vec<u8> = match revision {
        Some(rev) if !rev.trim().is_empty() => {
            let rev_path = format!("{rev}:{file_path}");
            let args = vec!["show", &rev_path];
            run_git_bytes(repo_path, &args)?
        }
        _ => {
            let full_path = Path::new(repo_path).join(file_path);
            std::fs::read(&full_path).map_err(|e| {
                Error::from_reason(format!("Failed to read file {}: {e}", full_path.display()))
            })?
        }
    };

    if bytes.len() > MAX_FILE_CONTENT_BYTES {
        return Err(Error::from_reason(format!(
            "File too large to preview ({:.1} MB)",
            bytes.len() as f64 / (1024.0 * 1024.0)
        )));
    }

    Ok(crate::storage::services::fs_explorer::process_file_content(
        file_path, bytes,
    ))
}

pub(crate) fn is_git_repo(repo_path: &str) -> bool {
    Path::new(repo_path).join(".git").exists()
}
