//! 图像管理系统（Image Library）
//!
//! 生成的图片落盘到 `~/.snowapp/image/` 目录（按日期子目录区分），
//! 元数据写入 `image_library` 表。删除图片时同步重写会话消息
//! （content / raw_json 中的图片引用），保证会话内不再显示已删除的图。

use std::fs;
use std::path::{Path, PathBuf};

use napi::bindgen_prelude::*;
use rusqlite::params;
use serde_json::Value;

use super::super::database;
use super::super::paths;
use super::system_settings;
use base64::Engine;

mod crud;
mod migration;

pub use self::crud::*;
pub use self::migration::*;

/// image_library 记录（服务层结构体，napi 结构体在 storage/mod.rs 门面层）
#[derive(Debug, Clone)]
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
    /// 所属相册 id；None = 未归类
    pub album_id: Option<String>,
}

/// 相册记录（服务层结构体）。
#[derive(Debug, Clone)]
pub struct ImageAlbumRecord {
    pub id: String,
    pub name: String,
    pub created_at: String,
    /// 相册封面：最新一张图的图库相对路径（image/...）；空相册为 None
    pub cover_path: Option<String>,
    /// 相册内图片数量
    pub image_count: i64,
}

/// 建表（B 模式：在 database.rs::create_schema() 末尾调用）
///
/// 兼容旧库迁移：
/// - `image_albums` 表用 CREATE TABLE IF NOT EXISTS（新库直接建，旧库首次升级建）
/// - `image_library.album_id` 列通过 pragma_table_info 检测后补列（幂等），
///   旧数据 album_id 为 NULL = 未归类，删除相册时图片置 NULL 不删图。
pub fn ensure_image_library_table(connection: &rusqlite::Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS image_library (
           id TEXT PRIMARY KEY NOT NULL,
           relative_path TEXT NOT NULL UNIQUE,
           file_name TEXT NOT NULL DEFAULT '',
           mime_type TEXT NOT NULL DEFAULT 'image/png',
           size_bytes INTEGER NOT NULL DEFAULT 0,
           width INTEGER,
           height INTEGER,
           prompt TEXT NOT NULL DEFAULT '',
           model TEXT NOT NULL DEFAULT '',
           provider TEXT NOT NULL DEFAULT '',
           created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
         );
         CREATE INDEX IF NOT EXISTS idx_image_library_created
           ON image_library(created_at DESC, id DESC);
         CREATE TABLE IF NOT EXISTS image_albums (
           id TEXT PRIMARY KEY NOT NULL,
           name TEXT NOT NULL,
           created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
         );",
    )?;

    // 幂等补列：image_library.album_id（旧库升级路径）
    let has_album_id: bool = connection
        .prepare("SELECT COUNT(*) FROM pragma_table_info('image_library') WHERE name = 'album_id'")?
        .query_row([], |row| row.get(0))?;
    if !has_album_id {
        connection.execute_batch("ALTER TABLE image_library ADD COLUMN album_id TEXT;")?;
    }
    connection.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_image_library_album ON image_library(album_id);",
    )?;

    // 幂等补列：image_albums.cover_image_id（手动封面）与 sort_order（拖拽排序）
    let has_cover_col: bool = connection
        .prepare("SELECT COUNT(*) FROM pragma_table_info('image_albums') WHERE name = 'cover_image_id'")?
        .query_row([], |row| row.get(0))?;
    if !has_cover_col {
        connection.execute_batch(
            "ALTER TABLE image_albums ADD COLUMN cover_image_id TEXT;",
        )?;
    }
    let has_sort_col: bool = connection
        .prepare("SELECT COUNT(*) FROM pragma_table_info('image_albums') WHERE name = 'sort_order'")?
        .query_row([], |row| row.get(0))?;
    if !has_sort_col {
        connection.execute_batch(
            "ALTER TABLE image_albums ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;",
        )?;
    }

    Ok(())
}

/// 图片根目录：优先读取用户自定义路径（system_settings `image_library_dir`），
/// 未设置或路径无效时回退到默认 `~/.snowapp/image`。跨平台一致
/// （macOS / Windows / Linux 均解析到用户主目录），
/// persist 时按 `root/YYYY-MM-DD/文件名` 落盘。
pub fn image_library_root() -> Result<PathBuf> {
    let database_path = paths::database_file_path(&paths::app_storage_dir()?);
    let custom_dir = system_settings::get_image_library_dir(&database_path).unwrap_or_default();
    if !custom_dir.is_empty() {
        let candidate = PathBuf::from(&custom_dir);
        if fs::create_dir_all(&candidate).is_ok() {
            return Ok(candidate);
        }
        // 自定义路径不可用，回退默认
    }
    let storage_dir = paths::app_storage_dir()?;
    let image_dir = storage_dir.join("image");
    fs::create_dir_all(&image_dir).map_err(|error| {
        Error::from_reason(format!(
            "Failed to create image library directory at '{}': {error}",
            image_dir.display()
        ))
    })?;
    Ok(image_dir)
}

pub(crate) fn ext_for_mime(mime_type: &str) -> &'static str {
    let lower = mime_type.to_ascii_lowercase();
    if lower.contains("jpeg") || lower.contains("jpg") {
        "jpg"
    } else if lower.contains("webp") {
        "webp"
    } else if lower.contains("gif") {
        "gif"
    } else if lower.contains("svg") {
        "svg"
    } else {
        "png"
    }
}

/// 从图片二进制头部探测宽高（PNG / JPEG；其余格式返回 None）。
pub(crate) fn probe_dimensions(bytes: &[u8], mime_type: &str) -> (Option<i64>, Option<i64>) {
    let lower = mime_type.to_ascii_lowercase();
    if lower.contains("png") && bytes.len() >= 24 && &bytes[0..8] == b"\x89PNG\r\n\x1a\n" {
        let width = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
        let height = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
        return (Some(width as i64), Some(height as i64));
    }
    if lower.contains("jpeg") && bytes.len() >= 4 && bytes[0] == 0xFF && bytes[1] == 0xD8 {
        // 扫描 SOF0-SOF15 标记（0xC0-0xCF 中的 C0-C3/C5-C7/C9-CB/CD-CF）
        let mut offset = 2usize;
        while offset + 9 < bytes.len() {
            if bytes[offset] != 0xFF {
                offset += 1;
                continue;
            }
            let marker = bytes[offset + 1];
            if (0xC0..=0xCF).contains(&marker) && marker != 0xC4 && marker != 0xC8 && marker != 0xCC
            {
                let height = u16::from_be_bytes([bytes[offset + 5], bytes[offset + 6]]);
                let width = u16::from_be_bytes([bytes[offset + 7], bytes[offset + 8]]);
                return (Some(width as i64), Some(height as i64));
            }
            if marker == 0xD8 || (0xD0..=0xD9).contains(&marker) {
                offset += 2;
                continue;
            }
            if offset + 4 <= bytes.len() {
                let seg_len = u16::from_be_bytes([bytes[offset + 2], bytes[offset + 3]]) as usize;
                if seg_len < 2 {
                    break;
                }
                offset += 2 + seg_len;
            } else {
                break;
            }
        }
    }
    (None, None)
}

/// 将结果 content 中的 base64 图片块落盘并写入索引。
/// 成功块改写为
/// `{"type":"image","path":"image/YYYY-MM-DD/xxx.png","absolutePath":"<磁盘绝对路径>","mimeType":...}`
/// （消息里不再携带大体积 base64；`path` 供应用内部解析图库文件，
/// `absolutePath` 供模型后续读图或复用为参考图）；任何一块失败都保留原
/// data 字段（容错）。返回成功落盘的相对路径列表。
pub fn persist_generated_images(
    database_path: &Path,
    prompt: &str,
    model: &str,
    provider: &str,
    blocks: &mut [Value],
) -> Result<Vec<String>> {
    let root = image_library_root()?;
    let date_dir = chrono::Local::now().format("%Y-%m-%d").to_string();
    let target_dir = root.join(&date_dir);
    fs::create_dir_all(&target_dir).map_err(|error| {
        Error::from_reason(format!(
            "Failed to create image library date directory '{}': {error}",
            target_dir.display()
        ))
    })?;

    let mut stored: Vec<String> = Vec::new();
    for block in blocks.iter_mut() {
        if block.get("type").and_then(Value::as_str) != Some("image") {
            continue;
        }
        if block.get("path").and_then(Value::as_str).is_some() {
            continue; // 已是 path 引用
        }
        let Some(data) = block.get("data").and_then(Value::as_str) else {
            continue;
        };
        let data = data.trim();
        if data.is_empty() {
            continue;
        }
        let mime_type = block
            .get("mimeType")
            .and_then(Value::as_str)
            .unwrap_or("image/png")
            .to_string();

        let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data.trim()) else {
            continue;
        };
        if bytes.is_empty() {
            continue;
        }

        let file_name = format!(
            "img-{}-{}.{}",
            chrono::Local::now().format("%Y%m%d%H%M%S"),
            database::create_snowflake_id(),
            ext_for_mime(&mime_type)
        );
        let abs_path = target_dir.join(&file_name);
        if let Err(error) = fs::write(&abs_path, &bytes) {
            // 落盘失败：保留 base64 块，不阻断生成结果返回
            eprintln!(
                "[image-library] failed to persist image '{}': {error}",
                abs_path.display()
            );
            continue;
        }

        let relative_path = format!("image/{date_dir}/{file_name}");
        let (width, height) = probe_dimensions(&bytes, &mime_type);

        let insert_result = database::open_connection(database_path).and_then(|connection| {
            connection.execute(
                "INSERT INTO image_library (
                   id, relative_path, file_name, mime_type, size_bytes, width, height,
                   prompt, model, provider
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    database::create_snowflake_id(),
                    relative_path,
                    file_name,
                    mime_type,
                    bytes.len() as i64,
                    width,
                    height,
                    prompt,
                    model,
                    provider,
                ],
            )
        });
        if let Err(error) = insert_result {
            // 索引失败不影响展示（消息里 path 仍可读），仅记录
            eprintln!("[image-library] failed to index image '{relative_path}': {error}");
        }

        // 改写块：去掉 base64，保留图库相对路径，并附带磁盘绝对路径
        let mut rewritten = serde_json::Map::new();
        rewritten.insert("type".to_string(), Value::String("image".to_string()));
        rewritten.insert("path".to_string(), Value::String(relative_path.clone()));
        rewritten.insert(
            "absolutePath".to_string(),
            Value::String(abs_path.to_string_lossy().replace('\\', "/")),
        );
        rewritten.insert("mimeType".to_string(), Value::String(mime_type));
        *block = Value::Object(rewritten);
        stored.push(relative_path);
    }
    Ok(stored)
}

/// 将图库相对路径（image/...）解析为根目录下的绝对路径。
/// 根目录本身即 image 目录，物理文件直接位于根目录下（persist 时
/// 按 `root/日期/文件名` 落盘），因此 `image/` 仅是逻辑前缀，需先去掉再拼接。
pub(crate) fn library_file_path(root: &Path, relative_path: &str) -> PathBuf {
    let normalized = relative_path.trim().replace('\\', "/");
    let inner = normalized.strip_prefix("image/").unwrap_or(&normalized);
    root.join(inner)
}
