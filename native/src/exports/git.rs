use napi_derive::napi;

use crate::api::commit_message::generate_commit_message_stream;
use crate::api::responses::{ResponsesApiResult, ResponsesApiStreamCallback};
use crate::storage::services::git::{
    GitBranch, GitCheckoutResult, GitCommitFile, GitCommitResult, GitDiffResult, GitLogEntry,
    GitPushPullResult, GitRepoInfo, GitStageResult, GitStatusResult,
};
use crate::storage::services::git_watcher::GitChangeCallback;

#[napi]
pub async fn get_git_status(repo_path: String) -> napi::Result<GitStatusResult> {
    tokio::task::spawn_blocking(move || crate::storage::services::git::get_git_status(&repo_path))
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

/// Push local commits to the remote. Runs on the blocking thread pool
/// because `git push` performs network I/O and may take seconds — it
/// must never block the async runtime.
#[napi]
pub async fn git_push(repo_path: String) -> napi::Result<GitPushPullResult> {
    tokio::task::spawn_blocking(move || crate::storage::services::git::push_changes(&repo_path))
        .await
        .map_err(|join_error| {
            napi::Error::from_reason(format!("Failed to push to remote: {join_error}"))
        })?
}

/// Pull changes from the remote. Runs on the blocking thread pool
/// because `git pull` performs network I/O and may take seconds — it
/// must never block the async runtime.
#[napi]
pub async fn git_pull(repo_path: String) -> napi::Result<GitPushPullResult> {
    tokio::task::spawn_blocking(move || crate::storage::services::git::pull_changes(&repo_path))
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
/// Recursively scans `root_path` for subdirectories containing a `.git`
/// entry. When a repo is found, its contents are not recursed into.
/// Runs on the blocking thread pool because filesystem traversal and
/// `git rev-parse` calls may be slow on large directory trees.
#[napi]
pub async fn discover_git_repos(root_path: String) -> napi::Result<Vec<GitRepoInfo>> {
    tokio::task::spawn_blocking(move || {
        crate::storage::services::git::discover_git_repos(&root_path)
    })
    .await
    .map_err(|join_error| {
        napi::Error::from_reason(format!("Failed to discover git repos: {join_error}"))
    })?
}

#[napi(
    ts_args_type = "repoPath: string, onChange: (repoPath: string) => void",
    ts_return_type = "void"
)]
pub fn start_git_watch(repo_path: String, on_change: GitChangeCallback) -> napi::Result<()> {
    crate::storage::services::git_watcher::start_git_watch(repo_path, on_change)
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
///
/// Returns the full `ResponsesApiResult` (`.content` holds the message).
#[napi(
    ts_args_type = "repoPath: string, onChunk: (chunk: ResponsesApiStreamChunk) => void, streamId: string",
    ts_return_type = "Promise<ResponsesApiResult>"
)]
pub async fn generate_commit_message(
    repo_path: String,
    on_chunk: ResponsesApiStreamCallback,
    stream_id: String,
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
    let result = generate_commit_message_stream(staged_diff, on_chunk, cancel_token).await;

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
    ts_args_type = "diff: string, onChunk: (chunk: ResponsesApiStreamChunk) => void, streamId: string",
    ts_return_type = "Promise<ResponsesApiResult>"
)]
pub async fn generate_commit_message_from_diff(
    diff: String,
    on_chunk: ResponsesApiStreamCallback,
    stream_id: String,
) -> napi::Result<ResponsesApiResult> {
    if diff.trim().is_empty() {
        return Err(napi::Error::from_reason(
            "No staged changes found. Please stage your changes first.",
        ));
    }

    let cancel_token = crate::api::cancel::create_and_register(&stream_id);
    let result = generate_commit_message_stream(diff, on_chunk, cancel_token).await;
    crate::api::cancel::unregister_stream(&stream_id);

    result
}
