use std::sync::{Arc, Mutex, OnceLock};

use napi::bindgen_prelude::*;
use napi::threadsafe_function::ThreadsafeFunction;
use napi_derive::napi;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

/// A filesystem or command operation that must be handled by Electron's SSH
/// session manager. Rust awaits this Promise and never performs SSH I/O itself.
#[napi(object)]
pub struct RemoteWorkspaceCommand {
    pub operation: String,
    pub args_json: String,
}

pub type RemoteWorkspaceCallback = ThreadsafeFunction<
    RemoteWorkspaceCommand,
    Promise<String>,
    RemoteWorkspaceCommand,
    Status,
    false,
>;

/// 全局注册的 SSH 远程命令回调：不经过工具调用链的后台流程（checkpoint 导出
/// API、仓库 Wiki 任务等）没有 callback 可传，由 Electron 初始化时注册一次。
/// napi ThreadsafeFunction 不支持 Clone，用 Arc 共享。
static GLOBAL_CALLBACK: OnceLock<Mutex<Option<Arc<RemoteWorkspaceCallback>>>> = OnceLock::new();

fn global_callback_slot() -> &'static Mutex<Option<Arc<RemoteWorkspaceCallback>>> {
    GLOBAL_CALLBACK.get_or_init(|| Mutex::new(None))
}

/// 注册（或清除）全局远程命令回调。
pub fn set_global_remote_callback(callback: Option<RemoteWorkspaceCallback>) {
    *global_callback_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = callback.map(Arc::new);
}

/// 取得全局远程命令回调（未注册时返回 None）。
pub fn global_remote_callback() -> Option<Arc<RemoteWorkspaceCallback>> {
    global_callback_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

pub fn is_ssh_path(path: &str) -> bool {
    path.trim_start().starts_with("ssh://")
}

/// Detect Windows drive-letter absolute paths (`C:\...` / `C:/...`, case
/// insensitive) and UNC paths (`\\server\share\...` / `//server/share/...`).
/// These belong to the App Host machine where the Electron app runs and must
/// never be resolved against an SSH workspace.
pub fn is_windows_absolute_path(path: &str) -> bool {
    let trimmed = path.trim_start();
    if trimmed.starts_with("\\\\") || trimmed.starts_with("//") {
        return true;
    }
    matches!(
        trimmed.as_bytes(),
        [drive, b':', b'/' | b'\\', ..] if drive.is_ascii_alphabetic()
    )
}

/// Resolve a filesystem path against an SSH workspace URI without performing
/// I/O. Absolute paths retain the workspace SSH authority; relative paths are
/// resolved beneath the remote workspace root.
pub fn resolve_remote_workspace_path(workspace_path: &str, requested_path: &str) -> String {
    let workspace_path = workspace_path.trim();
    let requested_path = requested_path.trim();

    if is_ssh_path(requested_path) {
        return requested_path.to_string();
    }
    // Windows drive-letter and UNC paths are App Host (local) paths; they
    // must never be joined into an SSH workspace URI.
    if is_windows_absolute_path(requested_path) {
        return requested_path.to_string();
    }
    if requested_path.is_empty() || requested_path == "." {
        return workspace_path.to_string();
    }
    if requested_path.starts_with('/') {
        let authority_end = workspace_path["ssh://".len()..]
            .find('/')
            .map(|index| index + "ssh://".len())
            .unwrap_or(workspace_path.len());
        return format!("{}{}", &workspace_path[..authority_end], requested_path);
    }

    format!(
        "{}/{}",
        workspace_path.trim_end_matches('/'),
        requested_path.trim_start_matches("./")
    )
}

pub async fn execute_remote_workspace_command(
    on_command: &RemoteWorkspaceCallback,
    operation: &str,
    args: &Value,
    cancel_token: Option<&CancellationToken>,
) -> napi::Result<Value> {
    let args_json = serde_json::to_string(args).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to serialize remote workspace command: {error}"),
        )
    })?;
    let command = RemoteWorkspaceCommand {
        operation: operation.to_string(),
        args_json,
    };

    let promise = on_command
        .call_async_catch(command)
        .await
        .map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to dispatch remote workspace command to Electron: {error}"),
            )
        })?;

    let result_json = match cancel_token {
        Some(token) => {
            tokio::select! {
                result = promise => result.map_err(|error| {
                    Error::new(
                        Status::GenericFailure,
                        format!("Remote workspace command failed: {error}"),
                    )
                })?,
                _ = token.cancelled() => {
                    return Err(Error::new(
                        Status::GenericFailure,
                        "Remote workspace command was cancelled".to_string(),
                    ));
                }
            }
        }
        None => promise.await.map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Remote workspace command failed: {error}"),
            )
        })?,
    };

    serde_json::from_str(&result_json).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Remote workspace command returned invalid JSON: {error}"),
        )
    })
}