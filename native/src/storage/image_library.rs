use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde_json::Value;

use super::ensure_database_file;
use super::services;

// ============================================================================
// 图像管理系统（Image Library）
// ============================================================================

#[napi(object)]
pub struct ImageLibraryRecord {
    pub id: String,
    pub relative_path: String,
    pub file_name: String,
    pub mime_type: String,
    pub size_bytes: i64,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub prompt: String,
    pub model: String,
    pub provider: String,
    pub created_at: String,
    /// 所属相册 id；null = 未归类
    pub album_id: Option<String>,
}

impl From<services::image_library::ImageLibraryRecord> for ImageLibraryRecord {
    fn from(record: services::image_library::ImageLibraryRecord) -> Self {
        ImageLibraryRecord {
            id: record.id,
            relative_path: record.relative_path,
            file_name: record.file_name,
            mime_type: record.mime_type,
            size_bytes: record.size_bytes,
            width: record.width,
            height: record.height,
            prompt: record.prompt,
            model: record.model,
            provider: record.provider,
            created_at: record.created_at,
            album_id: record.album_id,
        }
    }
}

/// 相册记录（napi 结构体）。
#[napi(object)]
pub struct ImageAlbumRecord {
    pub id: String,
    pub name: String,
    pub created_at: String,
    /// 相册封面：最新一张图的图库相对路径（image/...）；空相册为 null
    pub cover_path: Option<String>,
    /// 相册内图片数量
    pub image_count: i64,
}

impl From<services::image_library::ImageAlbumRecord> for ImageAlbumRecord {
    fn from(record: services::image_library::ImageAlbumRecord) -> Self {
        ImageAlbumRecord {
            id: record.id,
            name: record.name,
            created_at: record.created_at,
            cover_path: record.cover_path,
            image_count: record.image_count,
        }
    }
}

/// 图库根目录绝对路径（优先用户自定义路径，回退 `~/.snowapp/image`）。
pub fn get_image_library_root() -> Result<String> {
    services::image_library::image_library_root().map(|path| path.to_string_lossy().into_owned())
}

/// 列出图库全部图片（按创建时间倒序）。
pub fn list_image_library() -> Result<Vec<ImageLibraryRecord>> {
    let database_path = ensure_database_file()?;
    services::image_library::list_images(&database_path)
        .map(|records| records.into_iter().map(ImageLibraryRecord::from).collect())
}

/// 列出全部相册（按创建时间倒序），含封面路径与图片数量。
pub fn list_image_albums() -> Result<Vec<ImageAlbumRecord>> {
    let database_path = ensure_database_file()?;
    services::image_library::list_albums(&database_path)
        .map(|records| records.into_iter().map(ImageAlbumRecord::from).collect())
}

/// 创建相册（名称去除首尾空白，不允许为空）。
pub fn create_image_album(name: String) -> Result<ImageAlbumRecord> {
    let database_path = ensure_database_file()?;
    services::image_library::create_album(&database_path, &name).map(ImageAlbumRecord::from)
}

/// 重命名相册。
pub fn rename_image_album(id: String, name: String) -> Result<ImageAlbumRecord> {
    let database_path = ensure_database_file()?;
    services::image_library::rename_album(&database_path, &id, &name).map(ImageAlbumRecord::from)
}

/// 删除相册：相册内图片保留（album_id 置空）。
pub fn delete_image_album(id: String) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::image_library::delete_album(&database_path, &id)
}

/// 将图片移入 / 移出相册（album_id 传 null 表示移出到未分类）。
pub fn set_image_album(image_id: String, album_id: Option<String>) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::image_library::set_image_album(&database_path, &image_id, album_id.as_deref())
}

/// 设置相册手动封面（image_id 传 null 清除，回退最新一张图）。
pub fn set_image_album_cover(
    album_id: String,
    image_id: Option<String>,
) -> Result<ImageAlbumRecord> {
    let database_path = ensure_database_file()?;
    services::image_library::set_album_cover(&database_path, &album_id, image_id.as_deref())
        .map(ImageAlbumRecord::from)
}

/// 相册拖拽排序：按给定顺序写入 sort_order。
pub fn reorder_image_albums(ordered_ids: Vec<String>) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::image_library::reorder_albums(&database_path, &ordered_ids)
}

/// 手动导入图片文件（复制进图库目录并写入索引），返回成功导入的记录。
pub fn import_image_files(file_paths: Vec<String>) -> Result<Vec<ImageLibraryRecord>> {
    let database_path = ensure_database_file()?;
    services::image_library::import_image_files(&database_path, &file_paths)
        .map(|records| records.into_iter().map(ImageLibraryRecord::from).collect())
}

/// 读取图库图片并返回 data URL；路径非法或文件不存在返回 None。
pub fn read_image_library_file(relative_path: &str) -> Result<Option<String>> {
    services::image_library::read_image_file(relative_path)
}

/// 删除图片：物理文件 + 索引 + 同步重写引用该图的会话消息。
pub fn delete_image_library_image(id: &str) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::image_library::delete_image(&database_path, id)
}

/// 生成结果落盘 + 索引（由 imagegen 工具调用；失败不阻断，保留 base64）。
pub fn persist_generated_images(
    prompt: &str,
    model: &str,
    provider: &str,
    blocks: &mut Vec<Value>,
) -> Result<Vec<String>> {
    let database_path = ensure_database_file()?;
    services::image_library::persist_generated_images(
        &database_path,
        prompt,
        model,
        provider,
        blocks,
    )
}

/// 统计指定会话中引用的图库图片数量（删除会话确认框展示用）。
pub fn count_conversation_images(conversation_ids: Vec<String>) -> Result<i64> {
    let database_path = ensure_database_file()?;
    services::image_library::count_conversation_images(&database_path, &conversation_ids)
}

/// 级联删除指定会话中引用的图库图片（物理文件 + 索引行）。
/// 由删除会话流程调用；会话本身随后被删除，无需重写消息。
pub fn delete_conversation_images(conversation_ids: Vec<String>) -> Result<i64> {
    let database_path = ensure_database_file()?;
    services::image_library::delete_conversation_images(&database_path, &conversation_ids)
}

/// 图库目录迁移进度。
#[napi(object)]
pub struct MigrationProgress {
    pub copied: u32,
    pub total: u32,
    pub done: bool,
}

/// 准备图库迁移：校验目标目录并写入迁移日志；返回待迁移图片数量（0 表示无需迁移）。
pub fn prepare_image_library_migration(target_dir: String) -> Result<u32> {
    let database_path = ensure_database_file()?;
    services::image_library::prepare_migration(&database_path, &target_dir)
        .map(|count| count as u32)
}

/// 复制下一批图库文件并返回迁移进度（每批最多 16 个，逐文件写入日志保证崩溃可恢复）。
pub fn migrate_image_library_chunk() -> Result<MigrationProgress> {
    let (copied, total, done) = services::image_library::migrate_chunk(16)?;
    Ok(MigrationProgress {
        copied: copied as u32,
        total: total as u32,
        done,
    })
}

/// 提交迁移：写入新目录设置（提交点）并清理旧根目录文件。
pub fn commit_image_library_migration() -> Result<()> {
    let database_path = ensure_database_file()?;
    services::image_library::commit_migration(&database_path)
}

/// 回滚迁移：删除已复制到新目录的文件并移除日志（幂等；无进行中的迁移时直接成功）。
pub fn rollback_image_library_migration() -> Result<()> {
    services::image_library::rollback_migration()
}
