use std::path::PathBuf;

use napi::bindgen_prelude::*;

use super::ensure_database_file;
use super::models::*;
use super::services;

pub fn list_workspace_directories() -> Result<Vec<WorkspaceDirectoryRecord>> {
    let database_path = ensure_database_file()?;
    services::workspace_directories::list_workspace_directories(&database_path)
}

pub fn upsert_workspace_directory(item: WorkspaceDirectoryInput) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::workspace_directories::upsert_workspace_directory(&database_path, &item)
}

pub fn activate_workspace_directory(directory_id: String) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::workspace_directories::activate_workspace_directory(&database_path, &directory_id)
}

pub fn reorder_workspace_directories(items: Vec<WorkspaceDirectoryInput>) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::workspace_directories::reorder_workspace_directories(&database_path, &items)
}
pub fn delete_workspace_directory(directory_id: String) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::workspace_directories::delete_workspace_directory(&database_path, &directory_id)
}

pub fn list_project_collections() -> Result<Vec<ProjectCollectionRecord>> {
    let database_path = ensure_database_file()?;
    services::project_collections::list_project_collections(&database_path)
}

pub fn create_project_collection(name: String) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::project_collections::create_project_collection(&database_path, &name)
}

pub fn rename_project_collection(collection_id: String, name: String) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::project_collections::rename_project_collection(&database_path, &collection_id, &name)
}

pub fn delete_project_collection(collection_id: String) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::project_collections::delete_project_collection(&database_path, &collection_id)
}

pub fn reorder_project_collection_members(
    collection_id: String,
    ordered_member_ids: Vec<String>,
) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::project_collections::reorder_project_collection_members(
        &database_path,
        &collection_id,
        &ordered_member_ids,
    )
}

pub fn move_project_to_collection(
    target_collection_id: String,
    directory_id: String,
    ordered_member_ids: Vec<String>,
) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::project_collections::move_project_to_collection(
        &database_path,
        &target_collection_id,
        &directory_id,
        &ordered_member_ids,
    )
}

pub fn remove_project_from_all_collections(directory_id: String) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::project_collections::remove_project_from_all_collections(&database_path, &directory_id)
}

pub fn remove_project_from_collection(collection_id: String, directory_id: String) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::project_collections::remove_project_from_collection(
        &database_path,
        &collection_id,
        &directory_id,
    )
}

pub fn list_remote_drafts(
    workspace_id: String,
    profile_id: Option<String>,
) -> Result<Vec<RemoteDraftRecord>> {
    let database_path = ensure_database_file()?;
    services::remote_drafts::list_remote_drafts(
        &database_path,
        &workspace_id,
        profile_id.as_deref(),
    )
}

pub fn upsert_remote_draft(item: RemoteDraftInput) -> Result<RemoteDraftRecord> {
    let database_path = ensure_database_file()?;
    services::remote_drafts::upsert_remote_draft(&database_path, &item)
}

pub fn delete_remote_draft(
    profile_id: String,
    workspace_id: String,
    remote_path: String,
) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::remote_drafts::delete_remote_draft(
        &database_path,
        &profile_id,
        &workspace_id,
        &remote_path,
    )
}

pub fn create_project_directory(parent_path: String, project_name: String) -> Result<String> {
    services::workspace_directories::create_project_directory(&parent_path, &project_name)
}
pub fn read_directory_entries(
    dir_path: String,
) -> Result<Vec<services::fs_explorer::DirectoryEntry>> {
    services::fs_explorer::read_directory_entries(&dir_path)
}

pub fn rename_workspace_entry(
    root_path: String,
    entry_path: String,
    new_name: String,
) -> Result<()> {
    services::fs_explorer::rename_workspace_entry(&root_path, &entry_path, &new_name)
}

pub fn delete_workspace_entry(root_path: String, entry_path: String) -> Result<()> {
    services::fs_explorer::delete_workspace_entry(&root_path, &entry_path)
}

pub fn delete_workspace_entries(
    root_path: String,
    entry_paths: Vec<String>,
) -> Result<services::fs_explorer::BatchWorkspaceDeleteResult> {
    services::fs_explorer::delete_workspace_entries(&root_path, entry_paths)
}

pub fn search_files(
    root_dir: String,
    query: String,
) -> Result<Vec<services::fs_explorer::FileSearchResult>> {
    services::fs_explorer::search_files(&root_dir, &query)
}

pub fn read_file_content(file_path: String) -> Result<services::fs_explorer::FileContentResult> {
    services::fs_explorer::read_file_content(&file_path)
}

pub fn write_file_content(file_path: String, content: String) -> Result<()> {
    services::fs_explorer::write_file_content(&file_path, &content)
}

pub fn check_project_has_gitignore(project_id: String) -> Result<bool> {
    let database_path = ensure_database_file()?;
    let normalized_project_id = project_id.trim().to_string();
    if normalized_project_id.is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            "Project id is required".to_string(),
        ));
    }

    let Some(project_path) = services::workspace_directories::get_workspace_directory_path(
        &database_path,
        &normalized_project_id,
    )?
    else {
        return Ok(false);
    };

    let gitignore_path = PathBuf::from(&project_path).join(".gitignore");
    Ok(gitignore_path.exists())
}

/// Returns whether the project belongs to a remote (SSH) workspace directory.
/// Remote workspaces have no local filesystem to index, so codebase features
/// are unavailable for them.
pub fn check_project_is_remote(project_id: String) -> Result<bool> {
    let database_path = ensure_database_file()?;
    let normalized_project_id = project_id.trim().to_string();
    if normalized_project_id.is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            "Project id is required".to_string(),
        ));
    }

    let Some(kind) = services::workspace_directories::get_workspace_directory_kind(
        &database_path,
        &normalized_project_id,
    )?
    else {
        return Ok(false);
    };

    Ok(kind == "ssh")
}
