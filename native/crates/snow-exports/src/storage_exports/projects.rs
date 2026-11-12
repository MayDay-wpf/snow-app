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
pub async fn verify_workspace_directory(
    directory_id: String,
) -> napi::Result<WorkspaceDirectoryVerifyReport> {
    tokio::task::spawn_blocking(move || crate::storage::verify_workspace_directory(directory_id))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn verify_all_workspace_directories(
) -> napi::Result<Vec<WorkspaceDirectoryVerifyReport>> {
    tokio::task::spawn_blocking(crate::storage::verify_all_workspace_directories)
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn relink_workspace_directory(
    old_directory_id: String,
    new_path: String,
    dry_run: Option<bool>,
) -> napi::Result<WorkspaceRelinkReport> {
    tokio::task::spawn_blocking(move || {
        crate::storage::relink_workspace_directory(
            old_directory_id,
            new_path,
            dry_run.unwrap_or(false),
        )
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn undo_workspace_directory_relink(
    relink_id: String,
) -> napi::Result<WorkspaceRelinkReport> {
    tokio::task::spawn_blocking(move || crate::storage::undo_workspace_directory_relink(relink_id))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn list_workspace_directory_relinks(
    directory_id: String,
    limit: Option<i32>,
) -> napi::Result<Vec<WorkspaceRelinkRecord>> {
    tokio::task::spawn_blocking(move || {
        crate::storage::list_workspace_directory_relinks(directory_id, limit.unwrap_or(50))
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn list_project_collections() -> napi::Result<Vec<ProjectCollectionRecord>> {
    tokio::task::spawn_blocking(crate::storage::list_project_collections)
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn create_project_collection(
    name: String,
    member_directory_ids: Option<Vec<String>>,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::create_project_collection(name, member_directory_ids.unwrap_or_default())
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn update_project_collection_color(
    collection_id: String,
    color: String,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::update_project_collection_color(collection_id, color)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn set_project_collection_member_linked(
    collection_id: String,
    directory_id: String,
    linked: bool,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::set_project_collection_member_linked(collection_id, directory_id, linked)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn rename_project_collection(collection_id: String, name: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::rename_project_collection(collection_id, name)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn delete_project_collection(collection_id: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::delete_project_collection(collection_id))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn reorder_project_collection_members(
    collection_id: String,
    ordered_member_ids: Vec<String>,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::reorder_project_collection_members(collection_id, ordered_member_ids)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn reorder_project_collections(
    ordered_collection_ids: Vec<String>,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::reorder_project_collections(ordered_collection_ids)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn move_project_to_collection(
    target_collection_id: String,
    directory_id: String,
    ordered_member_ids: Vec<String>,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::move_project_to_collection(
            target_collection_id,
            directory_id,
            ordered_member_ids,
        )
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn remove_project_from_all_collections(directory_id: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::remove_project_from_all_collections(directory_id)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn remove_project_from_collection(
    collection_id: String,
    directory_id: String,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::remove_project_from_collection(collection_id, directory_id)
    })
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

/// 本地上传：把外部普通文件复制进工作区目录（阻塞 IO 放在 spawn_blocking 中执行）。
#[napi]
pub async fn copy_files_into_directory(
    root_path: String,
    target_dir: String,
    source_paths: Vec<String>,
    replace_existing: bool,
) -> napi::Result<crate::storage::services::fs_explorer::BatchWorkspaceCopyResult> {
    tokio::task::spawn_blocking(move || {
        crate::storage::copy_files_into_directory(
            root_path,
            target_dir,
            source_paths,
            replace_existing,
        )
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn search_files(
    root_dir: String,
    query: String,
    linked: Option<bool>,
) -> napi::Result<Vec<FileSearchResult>> {
    let include_linked = linked.unwrap_or(true);
    tokio::task::spawn_blocking(move || {
        crate::storage::search_files(root_dir, query, include_linked)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn search_file_contents(
    root_dir: String,
    query: String,
    linked: Option<bool>,
) -> napi::Result<Vec<FileSearchResult>> {
    let include_linked = linked.unwrap_or(true);
    tokio::task::spawn_blocking(move || {
        crate::storage::search_file_contents(root_dir, query, include_linked)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn read_file_content(file_path: String) -> napi::Result<FileContentResult> {
    tokio::task::spawn_blocking(move || crate::storage::read_file_content(file_path))
        .await
        .map_err(map_spawn_error)?
}

/// 文件查看器结构化预览（表格 / SQLite / 幻灯片大纲 / PDF / DOCX 字节），
/// 失败以判别式结果返回而非抛错；`section` 为工作表名或数据表名。
#[napi]
pub async fn read_file_preview(
    file_path: String,
    section: Option<String>,
) -> napi::Result<FilePreviewResult> {
    tokio::task::spawn_blocking(move || crate::storage::read_file_preview(file_path, section))
        .await
        .map_err(map_spawn_error)
}

#[napi]
pub async fn write_file_content(file_path: String, content: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::write_file_content(file_path, content))
        .await
        .map_err(map_spawn_error)?
}

/// 解析聊天正文中的文件路径引用（存在性校验 + 项目内后缀查找），找不到返回 null。
#[napi]
pub async fn resolve_file_link(
    root_dir: Option<String>,
    raw_path: String,
) -> napi::Result<Option<crate::storage::services::fs_explorer::ResolvedFileLink>> {
    tokio::task::spawn_blocking(move || crate::storage::resolve_file_link(root_dir, raw_path))
        .await
        .map_err(map_spawn_error)
}

/// 监听本地文件变更（父目录非递归监听 + 防抖），用于文件阅读器自动刷新。
#[napi(
    ts_args_type = "filePath: string, debounceMs: number, onChange: (filePath: string) => void",
    ts_return_type = "void"
)]
pub fn start_file_watch(
    file_path: String,
    debounce_ms: f64,
    on_change: crate::storage::services::file_watcher::FileChangeCallback,
) -> napi::Result<()> {
    crate::storage::services::file_watcher::start_file_watch(file_path, debounce_ms, on_change)
}

#[napi]
pub fn stop_file_watch(file_path: String) -> napi::Result<()> {
    crate::storage::services::file_watcher::stop_file_watch(file_path)
}
