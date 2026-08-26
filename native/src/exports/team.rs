//! 团队协作的 NAPI 转发层。所有 git/文件 I/O 均在 spawn_blocking 中执行，
//! 不阻塞 Node.js 事件循环。

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::storage::services::team::{
    configure_team_identity, delete_team_record, get_team_identity, list_team_records,
    read_team_media, resolve_team_repo, save_team_media, sync_team, upsert_team_record,
};

fn map_spawn_error(e: tokio::task::JoinError) -> Error {
    Error::from_reason(format!("team task failed: {e}"))
}

/// 读取仓库 git 身份与远端信息（JSON 字符串）。
#[napi]
pub async fn team_get_identity(repo_path: String) -> napi::Result<String> {
    let identity = tokio::task::spawn_blocking(move || get_team_identity(&repo_path))
        .await
        .map_err(map_spawn_error)??;
    serde_json::to_string(&identity).map_err(|e| Error::from_reason(format!("serialize failed: {e}")))
}

/// 定位团队协作对应的真实仓库路径（向上找 .git，找不到再扫子目录）。
#[napi]
pub async fn team_resolve_repo(path: String) -> napi::Result<String> {
    tokio::task::spawn_blocking(move || resolve_team_repo(&path))
        .await
        .map_err(map_spawn_error)?
}

/// 配置仓库本地 git 身份（user.name / user.email），返回更新后的身份。
#[napi]
pub async fn team_configure_identity(
    repo_path: String,
    name: String,
    email: String,
) -> napi::Result<String> {
    let identity = tokio::task::spawn_blocking(move || {
        configure_team_identity(&repo_path, &name, &email)
    })
    .await
    .map_err(map_spawn_error)??;
    serde_json::to_string(&identity).map_err(|e| Error::from_reason(format!("serialize failed: {e}")))
}

/// 全量同步团队数据平面（fetch / rebase / push），返回同步结果 JSON。
#[napi]
pub async fn team_sync(repo_path: String) -> napi::Result<String> {
    let result = tokio::task::spawn_blocking(move || sync_team(&repo_path))
        .await
        .map_err(map_spawn_error)??;
    serde_json::to_string(&result).map_err(|e| Error::from_reason(format!("serialize failed: {e}")))
}

/// 列出某类团队记录，返回原始 JSON 字符串数组。
#[napi]
pub async fn team_list(repo_path: String, kind: String) -> napi::Result<Vec<String>> {
    tokio::task::spawn_blocking(move || list_team_records(&repo_path, &kind))
        .await
        .map_err(map_spawn_error)?
}

/// 写入/更新一条团队记录，返回落盘后的 JSON。
#[napi]
pub async fn team_upsert(
    repo_path: String,
    kind: String,
    id: String,
    json: String,
) -> napi::Result<String> {
    tokio::task::spawn_blocking(move || upsert_team_record(&repo_path, &kind, &id, &json))
        .await
        .map_err(map_spawn_error)?
}

/// 删除一条团队记录。
#[napi]
pub async fn team_delete(
    repo_path: String,
    kind: String,
    id: String,
) -> napi::Result<bool> {
    tokio::task::spawn_blocking(move || delete_team_record(&repo_path, &kind, &id))
        .await
        .map_err(map_spawn_error)?
}

/// 保存团队笔记媒体文件（图片），返回 `snow-team/media/...` 相对路径。
#[napi]
pub async fn team_media_save(
    repo_path: String,
    note_id: String,
    file_name: String,
    base64_data: String,
) -> napi::Result<String> {
    tokio::task::spawn_blocking(move || {
        save_team_media(&repo_path, &note_id, &file_name, &base64_data)
    })
    .await
    .map_err(map_spawn_error)?
}

/// 读取团队笔记媒体文件，返回 data URL。
#[napi]
pub async fn team_media_read(repo_path: String, rel: String) -> napi::Result<String> {
    tokio::task::spawn_blocking(move || read_team_media(&repo_path, &rel))
        .await
        .map_err(map_spawn_error)?
}
