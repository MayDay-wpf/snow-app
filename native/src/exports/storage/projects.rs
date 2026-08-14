//! 项目/工作区/文件操作与工具审批的 NAPI 转发。

use super::*;

#[napi]
pub async fn get_codebase_project_scope_settings(
    project_id: String,
) -> napi::Result<CodebaseProjectScopeSettings> {
    tokio::task::spawn_blocking(move || {
        crate::storage::get_codebase_project_scope_settings(project_id)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn set_codebase_project_enabled(project_id: String, enabled: bool) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::set_codebase_project_enabled(project_id, enabled)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn set_codebase_project_agent_review(
    project_id: String,
    enabled: bool,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::set_codebase_project_agent_review(project_id, enabled)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn set_codebase_project_reranking(project_id: String, enabled: bool) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::set_codebase_project_reranking(project_id, enabled)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn check_project_has_gitignore(project_id: String) -> napi::Result<bool> {
    tokio::task::spawn_blocking(move || crate::storage::check_project_has_gitignore(project_id))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn check_project_is_remote(project_id: String) -> napi::Result<bool> {
    tokio::task::spawn_blocking(move || crate::storage::check_project_is_remote(project_id))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn list_tool_approval_project_approved_tools(
    project_id: String,
) -> napi::Result<Vec<String>> {
    tokio::task::spawn_blocking(move || {
        crate::storage::list_tool_approval_project_approved_tools(project_id)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn set_tool_approval_project_tool_approved(
    project_id: String,
    tool_name: String,
    approved: bool,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::set_tool_approval_project_tool_approved(project_id, tool_name, approved)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn list_workspace_directories() -> napi::Result<Vec<WorkspaceDirectoryRecord>> {
    tokio::task::spawn_blocking(crate::storage::list_workspace_directories)
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn upsert_workspace_directory(item: WorkspaceDirectoryInput) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::upsert_workspace_directory(item))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn activate_workspace_directory(directory_id: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::activate_workspace_directory(directory_id))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn reorder_workspace_directories(
    items: Vec<WorkspaceDirectoryInput>,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::reorder_workspace_directories(items))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn delete_workspace_directory(directory_id: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::delete_workspace_directory(directory_id))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn list_remote_drafts(
    workspace_id: String,
    profile_id: Option<String>,
) -> napi::Result<Vec<RemoteDraftRecord>> {
    tokio::task::spawn_blocking(move || {
        crate::storage::list_remote_drafts(workspace_id, profile_id)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn upsert_remote_draft(item: RemoteDraftInput) -> napi::Result<RemoteDraftRecord> {
    tokio::task::spawn_blocking(move || crate::storage::upsert_remote_draft(item))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn delete_remote_draft(
    profile_id: String,
    workspace_id: String,
    remote_path: String,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::delete_remote_draft(profile_id, workspace_id, remote_path)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn create_project_directory(
    parent_path: String,
    project_name: String,
) -> napi::Result<String> {
    tokio::task::spawn_blocking(move || {
        crate::storage::create_project_directory(parent_path, project_name)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn read_directory_entries(dir_path: String) -> napi::Result<Vec<DirectoryEntry>> {
    tokio::task::spawn_blocking(move || crate::storage::read_directory_entries(dir_path))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn rename_workspace_entry(
    root_path: String,
    entry_path: String,
    new_name: String,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::rename_workspace_entry(root_path, entry_path, new_name)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn delete_workspace_entry(root_path: String, entry_path: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::delete_workspace_entry(root_path, entry_path)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn delete_workspace_entries(
    root_path: String,
    entry_paths: Vec<String>,
) -> napi::Result<crate::storage::services::fs_explorer::BatchWorkspaceDeleteResult> {
    tokio::task::spawn_blocking(move || {
        crate::storage::delete_workspace_entries(root_path, entry_paths)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn search_files(root_dir: String, query: String) -> napi::Result<Vec<FileSearchResult>> {
    tokio::task::spawn_blocking(move || crate::storage::search_files(root_dir, query))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn read_file_content(file_path: String) -> napi::Result<FileContentResult> {
    tokio::task::spawn_blocking(move || crate::storage::read_file_content(file_path))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn write_file_content(file_path: String, content: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::write_file_content(file_path, content))
        .await
        .map_err(map_spawn_error)?
}
