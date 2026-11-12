

//! SSH 远程工作区：宿主回调与路径解析（实现见 snow-storage）。

pub use snow_storage::remote_host::*;

use napi::bindgen_prelude::*;

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

