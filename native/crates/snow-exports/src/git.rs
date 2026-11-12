use std::path::{Path, PathBuf};
use std::process::Stdio;

use napi::bindgen_prelude::{Status, Unknown};
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use tokio::io::AsyncReadExt;

use crate::api::commit_message::generate_commit_message_stream;
use crate::api::responses::{ResponsesApiResult, ResponsesApiStreamCallback};
use crate::storage::services::git::{
    GitBranch, GitCheckoutResult, GitCommitFile, GitCommitResult, GitDiffResult, GitIdentity,
    GitLogEntry, GitPushPullResult, GitRemoteInfo, GitRepoInfo, GitStageResult, GitStatusResult,
    GitWorktree, GitWorktreeInfo,
};
use crate::storage::services::git_watcher::GitChangeCallback;
use crate::utils::process::{kill_process_tree, poll_child_exit};

#[napi]
pub async fn get_git_status(repo_path: String, status_limit: i32) -> napi::Result<GitStatusResult> {
    tokio::task::spawn_blocking(move || {
        crate::storage::services::git::get_git_status(&repo_path, status_limit)
    })
    .await
    .map_err(|join_error| {
        napi::Error::from_reason(format!("Failed to get git status: {join_error}"))
    })?
}

#[napi]
pub async fn get_git_branches(repo_path: String) -> napi::Result<Vec<GitBranch>> {
    tokio::task::spawn_blocking(move || crate::storage::services::git::get_git_branches(&repo_path))
        .await
        .map_err(|join_error| {
            napi::Error::from_reason(format!("Failed to get git branches: {join_error}"))
        })?
}

#[napi]
pub async fn get_git_identity(repo_path: String) -> napi::Result<GitIdentity> {
    tokio::task::spawn_blocking(move || {
        crate::storage::services::git::get_git_identity(&repo_path)
    })
    .await
    .map_err(|join_error| {
        napi::Error::from_reason(format!("Failed to get git identity: {join_error}"))
    })?
}

#[napi]
pub async fn get_git_worktrees(repo_path: String) -> napi::Result<Vec<GitWorktree>> {
    tokio::task::spawn_blocking(move || crate::storage::services::git::get_git_worktrees(&repo_path))
        .await
        .map_err(|join_error| {
            napi::Error::from_reason(format!("Failed to get git worktrees: {join_error}"))
        })?
}

#[napi]
pub async fn git_stage_files(
    repo_path: String,
    file_paths: Vec<String>,
) -> napi::Result<GitStageResult> {
    tokio::task::spawn_blocking(move || {
        crate::storage::services::git::stage_files(&repo_path, &file_paths)
    })
    .await
    .map_err(|join_error| {
        napi::Error::from_reason(format!("Failed to stage files: {join_error}"))
    })?
}

#[napi]
pub async fn git_unstage_files(
    repo_path: String,
    file_paths: Vec<String>,
) -> napi::Result<GitStageResult> {
    tokio::task::spawn_blocking(move || {
        crate::storage::services::git::unstage_files(&repo_path, &file_paths)
    })
    .await
    .map_err(|join_error| {
        napi::Error::from_reason(format!("Failed to unstage files: {join_error}"))
    })?
}

#[napi]
pub async fn git_stage_all(repo_path: String) -> napi::Result<GitStageResult> {
    tokio::task::spawn_blocking(move || crate::storage::services::git::stage_all(&repo_path))
        .await
        .map_err(|join_error| {
            napi::Error::from_reason(format!("Failed to stage all files: {join_error}"))
        })?
}

#[napi]
pub async fn git_unstage_all(repo_path: String) -> napi::Result<GitStageResult> {
    tokio::task::spawn_blocking(move || crate::storage::services::git::unstage_all(&repo_path))
        .await
        .map_err(|join_error| {
            napi::Error::from_reason(format!("Failed to unstage all files: {join_error}"))
        })?
}

#[napi]
pub async fn git_commit(repo_path: String, message: String) -> napi::Result<GitCommitResult> {
    tokio::task::spawn_blocking(move || {
        crate::storage::services::git::commit_changes(&repo_path, &message)
    })
    .await
    .map_err(|join_error| napi::Error::from_reason(format!("Failed to commit: {join_error}")))?
}

#[napi]
pub async fn git_remotes(repo_path: String) -> napi::Result<Vec<GitRemoteInfo>> {
    tokio::task::spawn_blocking(move || crate::storage::services::git::get_git_remotes(&repo_path))
        .await
        .map_err(|join_error| {
            napi::Error::from_reason(format!("Failed to get remotes: {join_error}"))
        })?
}

/// Push local commits to the remote. Runs on the blocking thread pool
/// because `git push` performs network I/O and may take seconds — it
/// must never block the async runtime.
#[napi]
pub async fn git_push(
    repo_path: String,
    remote: Option<String>,
    branch: Option<String>,
    set_upstream: Option<bool>,
) -> napi::Result<GitPushPullResult> {
    tokio::task::spawn_blocking(move || {
        crate::storage::services::git::push_changes(
            &repo_path,
            remote.as_deref(),
            branch.as_deref(),
            set_upstream.unwrap_or(false),
        )
    })
    .await
    .map_err(|join_error| {
        napi::Error::from_reason(format!("Failed to push to remote: {join_error}"))
    })?
}

/// Pull changes from the remote. Runs on the blocking thread pool
/// because `git pull` performs network I/O and may take seconds — it
/// must never block the async runtime.
#[napi]
pub async fn git_pull(
    repo_path: String,
    remote: Option<String>,
    branch: Option<String>,
) -> napi::Result<GitPushPullResult> {
    tokio::task::spawn_blocking(move || {
        crate::storage::services::git::pull_changes(
            &repo_path,
            remote.as_deref(),
            branch.as_deref(),
        )
    })
    .await
    .map_err(|join_error| {
        napi::Error::from_reason(format!("Failed to pull from remote: {join_error}"))
    })?
}

/// Fetch from the remote without merging. Runs on the blocking thread
/// pool because `git fetch` performs network I/O and may take seconds —
/// it must never block the async runtime.
#[napi]
pub async fn git_fetch(repo_path: String) -> napi::Result<GitPushPullResult> {
    tokio::task::spawn_blocking(move || crate::storage::services::git::fetch_remote(&repo_path))
        .await
        .map_err(|join_error| {
            napi::Error::from_reason(format!("Failed to fetch from remote: {join_error}"))
        })?
}

#[napi]
pub async fn git_checkout(
    repo_path: String,
    branch_name: String,
) -> napi::Result<GitCheckoutResult> {
    tokio::task::spawn_blocking(move || {
        crate::storage::services::git::checkout_branch(&repo_path, &branch_name)
    })
    .await
    .map_err(|join_error| {
        napi::Error::from_reason(format!("Failed to checkout branch: {join_error}"))
    })?
}

#[napi]
pub async fn git_create_branch(
    repo_path: String,
    branch_name: String,
) -> napi::Result<GitCheckoutResult> {
    tokio::task::spawn_blocking(move || {
        crate::storage::services::git::create_branch(&repo_path, &branch_name)
    })
    .await
    .map_err(|join_error| {
        napi::Error::from_reason(format!("Failed to create branch: {join_error}"))
    })?
}

#[napi]
pub async fn git_file_diff(
    repo_path: String,
    file_path: String,
    staged: bool,
) -> napi::Result<GitDiffResult> {
    tokio::task::spawn_blocking(move || {
        crate::storage::services::git::get_file_diff(&repo_path, &file_path, staged)
    })
    .await
    .map_err(|join_error| {
        napi::Error::from_reason(format!("Failed to get file diff: {join_error}"))
    })?
}

/// Read a file's content from the working tree (`revision` empty/null) or
/// from a git revision (`git show <revision>:<path>`). Images come back as
/// base64 with a MIME type so the renderer can display them directly.
#[napi]
pub async fn git_file_content(
    repo_path: String,
    file_path: String,
    revision: Option<String>,
) -> napi::Result<crate::storage::services::fs_explorer::FileContentResult> {
    tokio::task::spawn_blocking(move || {
        crate::storage::services::git::get_file_content(&repo_path, &file_path, revision.as_deref())
    })
    .await
    .map_err(|join_error| {
        napi::Error::from_reason(format!("Failed to get file content: {join_error}"))
    })?
}

#[napi]
pub async fn git_discard_changes(
    repo_path: String,
    file_paths: Vec<String>,
) -> napi::Result<GitStageResult> {
    tokio::task::spawn_blocking(move || {
        crate::storage::services::git::discard_changes(&repo_path, &file_paths)
    })
    .await
    .map_err(|join_error| {
        napi::Error::from_reason(format!("Failed to discard changes: {join_error}"))
    })?
}

#[napi]
pub async fn get_git_log(
    repo_path: String,
    skip: i32,
    limit: i32,
) -> napi::Result<Vec<GitLogEntry>> {
    tokio::task::spawn_blocking(move || {
        crate::storage::services::git::get_git_log(&repo_path, skip, limit)
    })
    .await
    .map_err(|join_error| {
        napi::Error::from_reason(format!("Failed to get git log: {join_error}"))
    })?
}

#[napi]
pub async fn get_git_commit_files(
    repo_path: String,
    hash: String,
) -> napi::Result<Vec<GitCommitFile>> {
    tokio::task::spawn_blocking(move || {
        crate::storage::services::git::get_commit_files(&repo_path, &hash)
    })
    .await
    .map_err(|join_error| {
        napi::Error::from_reason(format!("Failed to get commit files: {join_error}"))
    })?
}

/// Get the full diff introduced by a single commit. Runs on the blocking
/// thread pool so `git show` never blocks the async runtime.
#[napi]
pub async fn get_commit_diff(repo_path: String, hash: String) -> napi::Result<GitDiffResult> {
    tokio::task::spawn_blocking(move || {
        crate::storage::services::git::get_commit_diff(&repo_path, &hash)
    })
    .await
    .map_err(|join_error| {
        napi::Error::from_reason(format!("Failed to get commit diff: {join_error}"))
    })?
}

/// Get the diff of a single file within a single commit
/// (`git show <hash> -- <path>`). Runs on the blocking thread pool so
/// `git show` never blocks the async runtime.
#[napi]
pub async fn git_commit_file_diff(
    repo_path: String,
    hash: String,
    file_path: String,
) -> napi::Result<GitDiffResult> {
    tokio::task::spawn_blocking(move || {
        crate::storage::services::git::get_commit_file_diff(&repo_path, &hash, &file_path)
    })
    .await
    .map_err(|join_error| {
        napi::Error::from_reason(format!("Failed to get commit file diff: {join_error}"))
    })?
}

/// Discover all git repositories within a directory tree.
///
/// Walks `root_path` breadth-first up to `max_depth` levels deep (default 1,
/// matching VSCode's `git.repositoryScanMaxDepth`; negative = unlimited).
/// Directories listed in `ignored_folders` (matched against the folder name,
/// case-insensitive) are never traversed.
/// Runs on the blocking thread pool because filesystem traversal and
/// `git rev-parse` calls may be slow on large directory trees.
#[napi]
pub async fn discover_git_repos(
    root_path: String,
    max_depth: i32,
    ignored_folders: Vec<String>,
) -> napi::Result<Vec<GitRepoInfo>> {
    tokio::task::spawn_blocking(move || {
        crate::storage::services::git::discover_git_repos(&root_path, max_depth, &ignored_folders)
    })
    .await
    .map_err(|join_error| {
        napi::Error::from_reason(format!("Failed to discover git repos: {join_error}"))
    })?
}

#[napi(
    ts_args_type = "repoPath: string, debounceMs: number, onChange: (repoPath: string) => void",
    ts_return_type = "void"
)]
pub fn start_git_watch(
    repo_path: String,
    debounce_ms: f64,
    on_change: GitChangeCallback,
) -> napi::Result<()> {
    crate::storage::services::git_watcher::start_git_watch(repo_path, debounce_ms, on_change)
}
#[napi]
pub fn stop_git_watch(repo_path: String) -> napi::Result<()> {
    crate::storage::services::git_watcher::stop_git_watch(repo_path)
}

/// Generate a commit message from the staged diff using the active API
/// config's **basic model**. Dispatches to whichever provider (chat /
/// responses / anthropic / gemini) the active config specifies.
///
/// - `repoPath`: git repository path (used to run `git diff --cached`)
/// - `onChunk`: streaming callback receiving `ResponsesApiStreamChunk`
/// - `streamId`: unique stream id for cancellation support
/// - `hint`: text the user left in the commit message box (generation
///   preference such as language, or a draft to refine); may be empty
///
/// Returns the full `ResponsesApiResult` (`.content` holds the message).
#[napi(
    ts_args_type = "repoPath: string, onChunk: (chunk: ResponsesApiStreamChunk) => void, streamId: string, hint: string",
    ts_return_type = "Promise<ResponsesApiResult>"
)]
pub async fn generate_commit_message(
    repo_path: String,
    on_chunk: ResponsesApiStreamCallback,
    stream_id: String,
    hint: String,
) -> napi::Result<ResponsesApiResult> {
    // 1. Get staged diff (blocking git command in spawn_blocking)
    let staged_diff = tokio::task::spawn_blocking(move || {
        crate::storage::services::git::get_staged_diff(&repo_path)
    })
    .await
    .map_err(|join_error| {
        napi::Error::from_reason(format!("Failed to get staged diff: {join_error}"))
    })??;

    if staged_diff.trim().is_empty() {
        return Err(napi::Error::from_reason(
            "No staged changes found. Please stage your changes first.",
        ));
    }

    // 2. Register cancellation token
    let cancel_token = crate::api::cancel::create_and_register(&stream_id);

    // 3. Stream commit message generation
    let result = generate_commit_message_stream(staged_diff, hint, on_chunk, cancel_token).await;

    // 4. Unregister stream
    crate::api::cancel::unregister_stream(&stream_id);

    result
}

/// Generate a commit message from a raw staged-diff string.
///
/// Identical to `generate_commit_message` but skips the local `git diff
/// --cached` step. Used by remote (SSH) repositories, where the diff is
/// produced on the remote host and streamed back to this process before
/// the AI generation runs here.
#[napi(
    ts_args_type = "diff: string, onChunk: (chunk: ResponsesApiStreamChunk) => void, streamId: string, hint: string",
    ts_return_type = "Promise<ResponsesApiResult>"
)]
pub async fn generate_commit_message_from_diff(
    diff: String,
    on_chunk: ResponsesApiStreamCallback,
    stream_id: String,
    hint: String,
) -> napi::Result<ResponsesApiResult> {
    if diff.trim().is_empty() {
        return Err(napi::Error::from_reason(
            "No staged changes found. Please stage your changes first.",
        ));
    }

    let cancel_token = crate::api::cancel::create_and_register(&stream_id);
    let result = generate_commit_message_stream(diff, hint, on_chunk, cancel_token).await;
    crate::api::cancel::unregister_stream(&stream_id);

    result
}

// ===== Clone repository =====

/// 克隆取消令牌的注册键前缀：对话流用原始 stream id、工具执行用
/// "tool:" 前缀，克隆单独占一个命名空间，避免互相误取消。
const CLONE_CANCEL_PREFIX: &str = "git-clone:";

/// 用户中止克隆的标记：作为错误信息前缀返回，主进程与渲染层据此把
/// 「用户中止」与「克隆失败」区分开（中止不需要弹错误提示）。
const CLONE_CANCELLED_MARKER: &str = "GIT_CLONE_CANCELLED";

/// `git clone` 的实时进度：一条 stderr 进度行 + 解析出的百分比。
#[napi(object)]
pub struct GitCloneProgress {
    /// git 输出的一条原始进度行（已去除行尾控制符）。
    pub line: String,
    /// 从进度行解析出的百分比（0-100），无法解析时为 None。
    pub percent: Option<f64>,
}

type GitCloneProgressCallback = ThreadsafeFunction<
    GitCloneProgress,
    Unknown<'static>,
    GitCloneProgress,
    Status,
    false,
>;

/// 克隆任务的取消注册键。
fn clone_cancel_key(stream_id: &str) -> String {
    format!("{CLONE_CANCEL_PREFIX}{stream_id}")
}

/// 中止克隆时返回的错误：错误信息带可识别标记，渲染层据此静默处理
/// （弹窗回到可编辑态，不显示失败提示）。
fn clone_cancelled_error(target: &str) -> napi::Error {
    napi::Error::from_reason(format!("{CLONE_CANCELLED_MARKER}: {target}"))
}

/// 任务结束时（正常、失败或提前返回）自动注销取消令牌，避免注册表残留。
struct CloneCancelGuard(String);

impl Drop for CloneCancelGuard {
    fn drop(&mut self) {
        crate::api::cancel::unregister_stream(&clone_cancel_key(&self.0));
    }
}

/// 回收半成品目录：克隆前不存在的目录（由 git 新建）整体删除；克隆前
/// 就存在的空目录只清空内容，保留用户自己的目录本身。删除大仓库可能
/// 耗时，放到阻塞线程池执行，避免占用 async worker。
async fn cleanup_partial_clone(target: PathBuf, existed_before: bool) {
    let _ = tokio::task::spawn_blocking(move || {
        if !existed_before {
            let _ = std::fs::remove_dir_all(&target);
            return;
        }

        let Ok(entries) = std::fs::read_dir(&target) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let is_dir = entry
                .file_type()
                .map(|file_type| file_type.is_dir())
                .unwrap_or(false);
            let _ = if is_dir {
                std::fs::remove_dir_all(&path)
            } else {
                std::fs::remove_file(&path)
            };
        }
    })
    .await;
}

/// 克隆 Git 仓库到本地目录。
///
/// `parent_path` 为保存位置：按 git 的默认命名规则从仓库地址推导
/// 项目名，并在其下新建 `<项目名>` 子目录进行克隆（与 `git clone`
/// 不带目标目录时的行为一致）。全程使用 tokio 异步子进程执行
/// `git clone --progress`，不经过 spawn_blocking、不阻塞 Node.js
/// 主线程。stderr 按字节流读取并按 `\r` / `\n` 分行（git 的进度
/// 更新以 `\r` 结尾），每条进度行通过 `onProgress` 回调实时推送
/// 给渲染层。
///
/// `stream_id` 是本任务的取消句柄：运行期间以它注册取消令牌，
/// `cancel_git_clone(stream_id)` 会杀掉整棵 git 进程树并清理半成品
/// 目录（中止/失败的克隆不会登记为工作区目录）。克隆成功返回实际
/// 克隆目录的完整路径；被中止时返回带 `GIT_CLONE_CANCELLED` 标记的错误。
#[napi(
    ts_args_type = "repoUrl: string, parentPath: string, onProgress: ((chunk: GitCloneProgress) => void) | undefined, streamId: string",
    ts_return_type = "Promise<string>"
)]
pub async fn clone_git_repository(
    repo_url: String,
    parent_path: String,
    on_progress: Option<GitCloneProgressCallback>,
    stream_id: String,
) -> napi::Result<String> {
    let cancel_id = crate::api::cancel::validate_stream_id(&stream_id)?;

    let url = repo_url.trim().to_string();
    if url.is_empty() {
        return Err(napi::Error::from_reason(
            "Repository URL is required and must be non-empty",
        ));
    }

    let parent = parent_path.trim().to_string();
    if parent.is_empty() {
        return Err(napi::Error::from_reason(
            "Parent directory is required and must be non-empty",
        ));
    }

    let parent_obj = Path::new(&parent);
    if !parent_obj.is_dir() {
        return Err(napi::Error::from_reason(format!(
            "Parent directory does not exist or is not a directory: '{parent}'"
        )));
    }

    // 注册取消令牌：任务运行期间 cancel_git_clone(stream_id) 命中它即中止。
    let cancel_token = crate::api::cancel::create_and_register(&clone_cancel_key(&cancel_id));
    let _cancel_guard = CloneCancelGuard(cancel_id);

    // 与 git 默认命名一致：去掉 .git 后缀后取最后一段作为项目名，
    // 在所选目录下新建同名子目录，避免直接占用所选目录本身。
    let repo_name = derive_repo_name(&url).ok_or_else(|| {
        napi::Error::from_reason(format!(
            "Unable to derive repository name from URL: '{url}'"
        ))
    })?;
    let target_obj = parent_obj.join(&repo_name);
    let target = target_obj.to_string_lossy().to_string();

    // 子目录已存在时仅允许空目录（可直接克隆进入）；非空则报错，
    // 通常是上一次克隆残留的目录。记录目录是否预先存在：中止/失败后
    // 的清理据此决定删掉整个目录，还是只清空用户自己建的空目录。
    let target_existed = target_obj.exists();
    if target_existed {
        if !target_obj.is_dir() {
            return Err(napi::Error::from_reason(format!(
                "Target path is not a directory: '{target}'"
            )));
        }
        let has_entries = std::fs::read_dir(&target_obj)
            .map_err(|error| {
                napi::Error::from_reason(format!(
                    "Failed to inspect target directory '{target}': {error}"
                ))
            })?
            .next()
            .is_some();
        if has_entries {
            return Err(napi::Error::from_reason(format!(
                "Target directory is not empty: '{target}'"
            )));
        }
    }

    // 取消请求早于本任务注册（pre-cancelled）时立即返回，不启动 git。
    if cancel_token.is_cancelled() {
        cleanup_partial_clone(target_obj, target_existed).await;
        return Err(clone_cancelled_error(&target));
    }

    // GIT_TERMINAL_PROMPT=0 避免无凭证助手时 git 在终端上挂起等待输入，
    // 认证失败快速报错；Windows 下 Git Credential Manager 仍可弹窗交互。
    // kill_on_drop(true)：任务提前结束（读取报错、应用退出等）时回收子进程。
    let mut command = crate::utils::process::cmd_async("git");
    command
        .args(["clone", "--progress", &url, &target])
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // Unix 下让 git 自成进程组，kill_process_tree 才能一次杀掉整棵进程树。
    #[cfg(not(target_os = "windows"))]
    {
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            napi::Error::from_reason(
                "git executable not found in PATH — install Git before cloning repositories",
            )
        } else {
            napi::Error::from_reason(format!("Failed to start git clone: {error}"))
        }
    })?;

    let mut stderr = child.stderr.take().ok_or_else(|| {
        napi::Error::from_reason("Failed to capture git clone progress output")
    })?;
    let mut last_line = String::new();
    let mut read_buffer = [0u8; 4096];
    let mut line_buffer: Vec<u8> = Vec::new();
    let mut is_cancelled = false;

    loop {
        // 取消优先：cancel_git_clone 触发后立刻停止读取，进入杀进程 + 清理
        // 半成品目录的流程；否则继续按字节流读 git stderr。
        tokio::select! {
            biased;
            _ = cancel_token.cancelled() => {
                is_cancelled = true;
                break;
            }
            chunk = stderr.read(&mut read_buffer) => {
                let bytes_read = chunk.map_err(|error| {
                    napi::Error::from_reason(format!("Failed to read git clone progress: {error}"))
                })?;
                if bytes_read == 0 {
                    break;
                }
                for &byte in &read_buffer[..bytes_read] {
                    // git 的进度更新以 \r 结尾（不换行覆盖刷新），普通信息行
                    // 以 \n 结尾，两者都视为一行边界。
                    if byte == b'\n' || byte == b'\r' {
                        if !line_buffer.is_empty() {
                            last_line = emit_clone_progress(&on_progress, &line_buffer);
                            line_buffer.clear();
                        }
                    } else {
                        line_buffer.push(byte);
                    }
                }
            }
        }
    }

    // 用户中止：先杀掉整棵 git 进程树，再回收半成品目录，保证渲染层收到
    // 「已中止」时磁盘上不残留无人清理的目录。
    if is_cancelled {
        kill_process_tree(&mut child).await;
        cleanup_partial_clone(target_obj, target_existed).await;
        return Err(clone_cancelled_error(&target));
    }

    if !line_buffer.is_empty() {
        last_line = emit_clone_progress(&on_progress, &line_buffer);
    }

    // 轮询等待退出（不用 Child::wait()：Windows 的 wait 线程池回调可能
    // 被延迟，使这个「长任务 + 取消」路径卡住）。
    let status = poll_child_exit(&mut child).await.map_err(|error| {
        napi::Error::from_reason(format!("Failed to wait for git clone: {error}"))
    })?;
    if !status.success() {
        // 失败同样回收半成品目录：否则残留目录会让下一次重试直接报
        // "Target directory is not empty"，用户必须手动清理。
        cleanup_partial_clone(target_obj, target_existed).await;
        let detail = last_line.trim();
        let message = if detail.is_empty() {
            format!(
                "git clone exited with code {}",
                status.code().unwrap_or(-1)
            )
        } else {
            detail.to_string()
        };
        return Err(napi::Error::from_reason(format!(
            "Failed to clone repository: {message}"
        )));
    }

    Ok(target)
}

/// 中止正在运行的 `git clone` 任务。
///
/// `stream_id` 与 `clone_git_repository` 调用时传入的保持一致：命中在跑
/// 的克隆任务时触发取消（Rust 侧杀掉进程树、清理半成品目录）并返回
/// `true`；任务不存在（已完成/已中止）时返回 `false`。
#[napi]
pub fn cancel_git_clone(stream_id: String) -> napi::Result<bool> {
    let cancel_id = crate::api::cancel::validate_stream_id(&stream_id)?;
    Ok(crate::api::cancel::cancel_stream(&clone_cancel_key(
        &cancel_id,
    )))
}

/// 推送一条克隆进度，并返回该行文本（用于失败时展示最后一条信息）。
fn emit_clone_progress(
    on_progress: &Option<GitCloneProgressCallback>,
    line_bytes: &[u8],
) -> String {
    let line = String::from_utf8_lossy(line_bytes).trim().to_string();
    if let Some(callback) = on_progress {
        let chunk = GitCloneProgress {
            percent: clone_progress_percent(&line),
            line: line.clone(),
        };
        let _ = callback.call(chunk, ThreadsafeFunctionCallMode::NonBlocking);
    }
    line
}

/// 参与进度条百分比的阶段。
///
/// git 的进度百分比是**分阶段**的：`Enumerating / Counting / Compressing
/// objects` 一开始就报 100%（它们只是本地统计，瞬间完成），真正下载的
/// `Receiving objects` 才从 0% 递增，`Resolving deltas` 又会从 0% 重来。
/// 逐行透传会让进度条先冲到 100% 再跌回 0%，因此只让传输阶段的百分比
/// 驱动进度条（从 0 单调走到 100%），其余阶段仅更新文本行。
const CLONE_PROGRESS_PHASE: &str = "Receiving objects";

/// 从一条 git 进度行中取出「可用于进度条」的百分比。
///
/// 非传输阶段（含 `remote:` 前缀的远程侧统计行）一律返回 `None`，
/// 渲染层据此只显示文本行、不画进度条，避免百分比回退。
fn clone_progress_percent(line: &str) -> Option<f64> {
    let phase_source = line.strip_prefix("remote:").unwrap_or(line).trim_start();
    if !phase_source.starts_with(CLONE_PROGRESS_PHASE) {
        return None;
    }
    parse_progress_percent(line)
}

/// 从 git 进度行中解析百分比，如
/// "Receiving objects:  42% (420/1000)" → `Some(42.0)`。
fn parse_progress_percent(line: &str) -> Option<f64> {
    let percent_index = line.find('%')?;
    let before = &line[..percent_index];
    let start = before
        .char_indices()
        .rev()
        .take_while(|(_, ch)| ch.is_ascii_digit() || *ch == '.')
        .last()
        .map(|(index, _)| index)?;
    let digits: String = before[start..]
        .chars()
        .filter(|ch| ch.is_ascii_digit() || *ch == '.')
        .collect();
    digits
        .parse::<f64>()
        .ok()
        .filter(|value| (0.0..=100.0).contains(value))
}

/// 按 git 的默认命名规则从仓库地址推导项目目录名：去掉末尾 `.git`
/// 后缀与斜杠后，取最后一个路径段。同时支持 https/ssh 形式
/// （`https://github.com/user/repo.git`）与 scp 形式
/// （`git@host:user/repo.git`），两者都得到 `repo`。
fn derive_repo_name(repo_url: &str) -> Option<String> {
    let trimmed = repo_url.trim().trim_end_matches('/');
    let without_suffix = trimmed.strip_suffix(".git").unwrap_or(trimmed);
    without_suffix
        .rsplit(['/', ':', '\\'])
        .next()
        .filter(|segment| !segment.is_empty())
        .map(str::to_string)
}

#[napi]
pub async fn git_list_worktrees(directory_id: String) -> napi::Result<Vec<GitWorktreeInfo>> {
    tokio::task::spawn_blocking(move || {
        let database_path = crate::storage::ensure_database_file()?;
        crate::storage::services::git::list_worktrees(&database_path, &directory_id)
    })
    .await
    .map_err(|error| napi::Error::from_reason(format!("Failed to list Git worktrees: {error}")))?
}

#[napi]
pub async fn git_create_worktree(
    directory_id: String,
    branch_name: String,
    base_ref: String,
) -> napi::Result<GitWorktreeInfo> {
    tokio::task::spawn_blocking(move || {
        let database_path = crate::storage::ensure_database_file()?;
        crate::storage::services::git::create_worktree(
            &database_path,
            &directory_id,
            &branch_name,
            &base_ref,
        )
    })
    .await
    .map_err(|error| napi::Error::from_reason(format!("Failed to create Git worktree: {error}")))?
}

#[napi]
pub async fn git_remove_worktree(directory_id: String, worktree_id: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        let database_path = crate::storage::ensure_database_file()?;
        crate::storage::services::git::remove_worktree(&database_path, &directory_id, &worktree_id)
    })
    .await
    .map_err(|error| napi::Error::from_reason(format!("Failed to remove Git worktree: {error}")))?
}

#[napi]
pub async fn get_conversation_worktree(
    conversation_id: String,
) -> napi::Result<Option<GitWorktreeInfo>> {
    tokio::task::spawn_blocking(move || {
        let database_path = crate::storage::ensure_database_file()?;
        crate::storage::services::git::get_conversation_worktree(&database_path, &conversation_id)
    })
    .await
    .map_err(|error| napi::Error::from_reason(format!("Failed to get conversation worktree: {error}")))?
}

#[napi]
pub async fn set_conversation_worktree(
    conversation_id: String,
    worktree_id: Option<String>,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        let database_path = crate::storage::ensure_database_file()?;
        crate::storage::services::git::set_conversation_worktree(
            &database_path,
            &conversation_id,
            worktree_id.as_deref(),
        )
    })
    .await
    .map_err(|error| napi::Error::from_reason(format!("Failed to set conversation worktree: {error}")))?
}
