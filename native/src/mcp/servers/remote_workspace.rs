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

pub fn is_ssh_path(path: &str) -> bool {
    path.trim_start().starts_with("ssh://")
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

/// Resolve the active project workspace only when it is an SSH URI.
/// access runs on Tokio's blocking pool so the N-API async runtime stays free.
pub async fn resolve_remote_project_workspace(
    project_id: Option<&str>,
) -> napi::Result<Option<String>> {
    let Some(project_id) = project_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let project_id = project_id.to_string();

    let workspace_path = tokio::task::spawn_blocking(move || {
        let storage_info = crate::storage::initialize_app_storage()?;
        let database_path = std::path::PathBuf::from(storage_info.database_path);
        crate::storage::services::workspace_directories::get_workspace_directory_path(
            &database_path,
            &project_id,
        )
    })
    .await
    .map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to resolve remote project workspace: {error}"),
        )
    })??;

    Ok(workspace_path.filter(|path| is_ssh_path(path)))
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

    // When a cancellation token is supplied (conversation stop / per-tool
    // stop button), race the Electron-side promise against it so the tool
    // execution settles into a cancelled terminal state immediately instead
    // of waiting for the SSH exec channel. The Electron side independently
    // aborts the channel via the AbortController registry, so both halves
    // of the command converge.
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
