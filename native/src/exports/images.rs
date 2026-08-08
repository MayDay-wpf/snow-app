//! 图像管理系统（Image Library）NAPI 导出。
//!
//! 供主进程 IPC 调用：查询图库列表、读取图片 data URL、删除图片
//! （删除时同步重写会话消息中的图片引用）。

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::storage::{ImageAlbumRecord, ImageLibraryRecord, MigrationProgress};

fn map_spawn_error(error: tokio::task::JoinError) -> Error {
    Error::new(
        Status::GenericFailure,
        format!("Spawned blocking task failed: {error}"),
    )
}

/// 图库根目录绝对路径（`~/.snowapp/image`，跨平台一致）。
#[napi]
pub async fn get_image_library_root() -> napi::Result<String> {
    tokio::task::spawn_blocking(crate::storage::get_image_library_root)
        .await
        .map_err(map_spawn_error)?
}

/// 读取图库自定义保存目录（空字符串表示使用默认目录）。
#[napi]
pub async fn get_image_library_dir() -> napi::Result<String> {
    tokio::task::spawn_blocking(crate::storage::get_image_library_dir)
        .await
        .map_err(map_spawn_error)?
}

/// 设置图库自定义保存目录（传入空字符串重置为默认目录）。
#[napi]
pub async fn set_image_library_dir(dir: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::set_image_library_dir(dir))
        .await
        .map_err(map_spawn_error)?
}

/// 列出图库全部图片（按创建时间倒序）。
#[napi]
pub async fn list_image_library() -> napi::Result<Vec<ImageLibraryRecord>> {
    tokio::task::spawn_blocking(crate::storage::list_image_library)
        .await
        .map_err(map_spawn_error)?
}

/// 读取图库图片并返回 data URL；路径非法或文件不存在返回 None。
#[napi]
pub async fn read_image_library_file(relative_path: String) -> napi::Result<Option<String>> {
    tokio::task::spawn_blocking(move || crate::storage::read_image_library_file(&relative_path))
        .await
        .map_err(map_spawn_error)?
}

/// 删除图片：物理文件 + 索引 + 同步重写引用该图的会话消息。
#[napi]
pub async fn delete_image_library_image(id: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::delete_image_library_image(&id))
        .await
        .map_err(map_spawn_error)?
}

/// 统计指定会话中引用的图库图片数量（删除会话确认框展示用）。
#[napi]
pub async fn count_conversation_images(conversation_ids: Vec<String>) -> napi::Result<i64> {
    tokio::task::spawn_blocking(move || crate::storage::count_conversation_images(conversation_ids))
        .await
        .map_err(map_spawn_error)?
}

/// 级联删除指定会话中引用的图库图片（物理文件 + 索引行）。
/// 由删除会话流程调用（选择不保留图片时）。
#[napi]
pub async fn delete_conversation_images(conversation_ids: Vec<String>) -> napi::Result<i64> {
    tokio::task::spawn_blocking(move || {
        crate::storage::delete_conversation_images(conversation_ids)
    })
    .await
    .map_err(map_spawn_error)?
}

/// 准备图库迁移：校验目标目录并写入迁移日志；返回待迁移图片数量（0 表示无需迁移）。
#[napi]
pub async fn prepare_image_library_migration(target_dir: String) -> napi::Result<u32> {
    tokio::task::spawn_blocking(move || crate::storage::prepare_image_library_migration(target_dir))
        .await
        .map_err(map_spawn_error)?
}

/// 复制下一批图库文件并返回迁移进度（copied/total/done）。
#[napi]
pub async fn migrate_image_library_chunk() -> napi::Result<MigrationProgress> {
    tokio::task::spawn_blocking(crate::storage::migrate_image_library_chunk)
        .await
        .map_err(map_spawn_error)?
}

/// 提交迁移：写入新目录设置（提交点）并清理旧根目录文件。
#[napi]
pub async fn commit_image_library_migration() -> napi::Result<()> {
    tokio::task::spawn_blocking(crate::storage::commit_image_library_migration)
        .await
        .map_err(map_spawn_error)?
}

/// 回滚迁移：删除已复制到新目录的文件并移除日志（幂等）。
#[napi]
pub async fn rollback_image_library_migration() -> napi::Result<()> {
    tokio::task::spawn_blocking(crate::storage::rollback_image_library_migration)
        .await
        .map_err(map_spawn_error)?
}

/// 列出全部相册（按创建时间倒序），含封面路径（最新一张图）与图片数量。
#[napi]
pub async fn list_image_albums() -> napi::Result<Vec<ImageAlbumRecord>> {
    tokio::task::spawn_blocking(crate::storage::list_image_albums)
        .await
        .map_err(map_spawn_error)?
}

/// 创建相册（名称去除首尾空白，不允许为空）。
#[napi]
pub async fn create_image_album(name: String) -> napi::Result<ImageAlbumRecord> {
    tokio::task::spawn_blocking(move || crate::storage::create_image_album(name))
        .await
        .map_err(map_spawn_error)?
}

/// 重命名相册（相册不存在时返回错误）。
#[napi]
pub async fn rename_image_album(id: String, name: String) -> napi::Result<ImageAlbumRecord> {
    tokio::task::spawn_blocking(move || crate::storage::rename_image_album(id, name))
        .await
        .map_err(map_spawn_error)?
}

/// 删除相册：相册内图片保留（album_id 置空，图片移入未分类）。
#[napi]
pub async fn delete_image_album(id: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::delete_image_album(id))
        .await
        .map_err(map_spawn_error)?
}

/// 将图片移入 / 移出相册（album_id 传 null 表示移出到未分类）。
#[napi]
pub async fn set_image_album(image_id: String, album_id: Option<String>) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::set_image_album(image_id, album_id))
        .await
        .map_err(map_spawn_error)?
}

/// 手动导入图片文件（复制进图库目录并写入索引），返回成功导入的记录。
#[napi]
pub async fn import_image_files(file_paths: Vec<String>) -> napi::Result<Vec<ImageLibraryRecord>> {
    tokio::task::spawn_blocking(move || crate::storage::import_image_files(file_paths))
        .await
        .map_err(map_spawn_error)?
}
