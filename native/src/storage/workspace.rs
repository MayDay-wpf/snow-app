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

pub fn verify_workspace_directory(
    directory_id: String,
) -> Result<WorkspaceDirectoryVerifyReport> {
    let database_path = ensure_database_file()?;
    services::workspace_directory_health::verify_workspace_directory(&database_path, &directory_id)
}

/// 启动体检：批量校验全部本地项目路径（远端目录跳过）。
pub fn verify_all_workspace_directories() -> Result<Vec<WorkspaceDirectoryVerifyReport>> {
    let database_path = ensure_database_file()?;
    services::workspace_directory_health::verify_all_workspace_directories(&database_path)
}

pub fn relink_workspace_directory(
    old_directory_id: String,
    new_path: String,
    dry_run: bool,
) -> Result<WorkspaceRelinkReport> {
    let database_path = ensure_database_file()?;
    services::workspace_relink::relink_workspace_directory(
        &database_path,
        &old_directory_id,
        &new_path,
        dry_run,
    )
}

pub fn undo_workspace_directory_relink(relink_id: String) -> Result<WorkspaceRelinkReport> {
    let database_path = ensure_database_file()?;
    services::workspace_relink::undo_workspace_directory_relink(&database_path, &relink_id)
}

pub fn list_workspace_directory_relinks(
    directory_id: String,
    limit: i32,
) -> Result<Vec<WorkspaceRelinkRecord>> {
    let database_path = ensure_database_file()?;
    services::workspace_relink::list_workspace_directory_relinks(
        &database_path,
        &directory_id,
        limit,
    )
}

pub fn list_project_collections() -> Result<Vec<ProjectCollectionRecord>> {
    let database_path = ensure_database_file()?;
    services::project_collections::list_project_collections(&database_path)
}

pub fn create_project_collection(name: String, member_directory_ids: Vec<String>) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::project_collections::create_project_collection(
        &database_path,
        &name,
        &member_directory_ids,
    )
}

pub fn update_project_collection_color(collection_id: String, color: String) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::project_collections::update_project_collection_color(
        &database_path,
        &collection_id,
        &color,
    )
}

/// 按项目根目录路径解析关联项目组（合集）的成员根目录。
/// 文件搜索 agent 用它把搜索范围扩展到组内全部项目；未关联时为空列表。
pub fn resolve_linked_project_roots_for_path(path: String) -> Result<Vec<LinkedProjectRoot>> {
    let database_path = ensure_database_file()?;
    let group = services::project_collections::resolve_linked_project_roots_by_path(
        &database_path,
        &path,
    )?;
    Ok(group.map(|group| group.roots).unwrap_or_default())
}

/// 切换合集成员的「参与关联」开关（断连后仍留在合集里）。
pub fn set_project_collection_member_linked(
    collection_id: String,
    directory_id: String,
    linked: bool,
) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::project_collections::set_project_collection_member_linked(
        &database_path,
        &collection_id,
        &directory_id,
        linked,
    )
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

/// 按给定顺序重排合集本身（侧边栏合集列表的拖拽排序）。
pub fn reorder_project_collections(ordered_collection_ids: Vec<String>) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::project_collections::reorder_project_collections(
        &database_path,
        &ordered_collection_ids,
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

pub fn copy_files_into_directory(
    root_path: String,
    target_dir: String,
    source_paths: Vec<String>,
    replace_existing: bool,
) -> Result<services::fs_explorer::BatchWorkspaceCopyResult> {
    services::fs_explorer::copy_files_into_directory(
        &root_path,
        &target_dir,
        source_paths,
        replace_existing,
    )
}

/// 文件名 / 内容搜索。项目属于关联项目组时，搜索覆盖组内所有根目录：
/// 兄弟根的相对路径带上「目录名/」前缀，主根结果保持相对路径不变。
/// `linked=false`（如 `@:项目/` 显式限定某个成员）时只搜索给定根目录。
pub fn search_files(
    root_dir: String,
    query: String,
    linked: bool,
) -> Result<Vec<services::fs_explorer::FileSearchResult>> {
    // 关联信息缺失（数据库异常等）时静默退化为单根搜索，不影响搜索结果本身。
    let linked_roots = if linked {
        resolve_linked_project_roots_for_path(root_dir.clone()).unwrap_or_default()
    } else {
        Vec::new()
    };

    if linked_roots.is_empty() {
        return services::fs_explorer::search_files(&root_dir, &query);
    }
    services::fs_explorer::search_files_linked(&root_dir, &query, &linked_roots)
}

pub fn search_file_contents(
    root_dir: String,
    query: String,
    linked: bool,
) -> Result<Vec<services::fs_explorer::FileSearchResult>> {
    let linked_roots = if linked {
        resolve_linked_project_roots_for_path(root_dir.clone()).unwrap_or_default()
    } else {
        Vec::new()
    };

    if linked_roots.is_empty() {
        return services::fs_explorer::search_file_contents(&root_dir, &query);
    }
    services::fs_explorer::search_file_contents_linked(&root_dir, &query, &linked_roots)
}

pub fn read_file_content(file_path: String) -> Result<services::fs_explorer::FileContentResult> {
    services::fs_explorer::read_file_content(&file_path)
}

pub fn read_file_preview(
    file_path: String,
    section: Option<String>,
) -> services::fs_explorer::FilePreviewResult {
    services::fs_explorer::read_file_preview(&file_path, section.as_deref())
}

pub fn write_file_content(file_path: String, content: String) -> Result<()> {
    services::fs_explorer::write_file_content(&file_path, &content)
}

pub fn resolve_file_link(
    root_dir: Option<String>,
    raw_path: String,
) -> Option<services::fs_explorer::ResolvedFileLink> {
    services::fs_explorer::resolve_file_link(root_dir.as_deref(), &raw_path)
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
