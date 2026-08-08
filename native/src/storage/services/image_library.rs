//! 图像管理系统（Image Library）
//!
//! 生成的图片落盘到 `~/.snowapp/image/` 目录（按日期子目录区分），
//! 元数据写入 `image_library` 表。删除图片时同步重写会话消息
//! （content / raw_json 中的图片引用），保证会话内不再显示已删除的图。

use std::fs;
use std::path::{Path, PathBuf};

use napi::bindgen_prelude::*;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::super::database;
use super::super::paths;
use super::system_settings;
use base64::Engine;

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

fn ext_for_mime(mime_type: &str) -> &'static str {
    let lower = mime_type.to_ascii_lowercase();
    if lower.contains("jpeg") || lower.contains("jpg") {
        "jpg"
    } else if lower.contains("webp") {
        "webp"
    } else if lower.contains("gif") {
        "gif"
    } else {
        "png"
    }
}

/// 从图片二进制头部探测宽高（PNG / JPEG；其余格式返回 None）。
fn probe_dimensions(bytes: &[u8], mime_type: &str) -> (Option<i64>, Option<i64>) {
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
/// 成功块改写为 `{"type":"image","path":"image/YYYY-MM-DD/xxx.png","mimeType":...}`
/// （消息里不再携带大体积 base64）；任何一块失败都保留原 data 字段（容错）。
/// 返回成功落盘的相对路径列表。
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

        // 改写块：去掉 base64，保留 path 引用
        let mut rewritten = serde_json::Map::new();
        rewritten.insert("type".to_string(), Value::String("image".to_string()));
        rewritten.insert("path".to_string(), Value::String(relative_path.clone()));
        rewritten.insert("mimeType".to_string(), Value::String(mime_type));
        *block = Value::Object(rewritten);
        stored.push(relative_path);
    }
    Ok(stored)
}

fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ImageLibraryRecord> {
    Ok(ImageLibraryRecord {
        id: row.get(0)?,
        relative_path: row.get(1)?,
        file_name: row.get(2)?,
        mime_type: row.get(3)?,
        size_bytes: row.get(4)?,
        width: row.get(5)?,
        height: row.get(6)?,
        prompt: row.get(7)?,
        model: row.get(8)?,
        provider: row.get(9)?,
        created_at: row.get(10)?,
        album_id: row.get(11)?,
    })
}

/// 列出全部图片（按创建时间倒序）。
pub fn list_images(database_path: &Path) -> Result<Vec<ImageLibraryRecord>> {
    database::open_connection(database_path)
        .and_then(|connection| {
            let mut statement = connection.prepare(
                "SELECT id, relative_path, file_name, mime_type, size_bytes, width, height,
                        prompt, model, provider, created_at, album_id
                   FROM image_library
                  ORDER BY created_at DESC, id DESC",
            )?;
            let rows = statement.query_map([], map_row)?;
            rows.collect()
        })
        .map_err(|error| database::database_error(database_path, "list image library", error))
}

/// 列出全部相册（按创建时间倒序），含封面路径（最新一张图）与图片数量。
pub fn list_albums(database_path: &Path) -> Result<Vec<ImageAlbumRecord>> {
    database::open_connection(database_path)
        .and_then(|connection| {
            let mut statement = connection.prepare(
                "SELECT a.id, a.name, a.created_at,
                        (SELECT i.relative_path FROM image_library i
                          WHERE i.album_id = a.id
                          ORDER BY i.created_at DESC, i.id DESC LIMIT 1) AS cover_path,
                        (SELECT COUNT(*) FROM image_library i WHERE i.album_id = a.id) AS image_count
                   FROM image_albums a
                  ORDER BY a.created_at DESC, a.id DESC",
            )?;
            let rows = statement.query_map([], map_album_row)?;
            rows.collect()
        })
        .map_err(|error| database::database_error(database_path, "list image albums", error))
}

fn map_album_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ImageAlbumRecord> {
    Ok(ImageAlbumRecord {
        id: row.get(0)?,
        name: row.get(1)?,
        created_at: row.get(2)?,
        cover_path: row.get(3)?,
        image_count: row.get(4)?,
    })
}

/// 按 id 查询相册（含封面与数量）。
fn find_album(
    connection: &rusqlite::Connection,
    id: &str,
) -> rusqlite::Result<Option<ImageAlbumRecord>> {
    connection
        .query_row(
            "SELECT a.id, a.name, a.created_at,
                    (SELECT i.relative_path FROM image_library i
                      WHERE i.album_id = a.id
                      ORDER BY i.created_at DESC, i.id DESC LIMIT 1) AS cover_path,
                    (SELECT COUNT(*) FROM image_library i WHERE i.album_id = a.id) AS image_count
               FROM image_albums a
              WHERE a.id = ?1",
            params![id],
            map_album_row,
        )
        .optional()
}

/// 创建相册。名称去除首尾空白，不允许为空；名称不强制唯一。
pub fn create_album(database_path: &Path, name: &str) -> Result<ImageAlbumRecord> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(napi::Error::from_reason(
            "Image album name must not be empty".to_string(),
        ));
    }
    let id = database::create_snowflake_id();
    database::open_connection(database_path)
        .and_then(|connection| {
            connection.execute(
                "INSERT INTO image_albums (id, name) VALUES (?1, ?2)",
                params![id, name],
            )?;
            find_album(&connection, &id)
                .and_then(|album| album.ok_or_else(|| rusqlite::Error::InvalidQuery))
        })
        .map_err(|error| database::database_error(database_path, "create image album", error))
}

/// 重命名相册。相册不存在时返回错误。
pub fn rename_album(database_path: &Path, id: &str, name: &str) -> Result<ImageAlbumRecord> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(napi::Error::from_reason(
            "Image album name must not be empty".to_string(),
        ));
    }
    database::open_connection(database_path)
        .and_then(|connection| {
            let affected = connection.execute(
                "UPDATE image_albums SET name = ?1 WHERE id = ?2",
                params![name, id],
            )?;
            if affected == 0 {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }
            find_album(&connection, id)
                .and_then(|album| album.ok_or(rusqlite::Error::QueryReturnedNoRows))
        })
        .map_err(|error| database::database_error(database_path, "rename image album", error))
}

/// 删除相册：相册内图片的 album_id 置 NULL（图片本身保留），相册封面随之失效。
pub fn delete_album(database_path: &Path, id: &str) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|connection| {
            connection.execute(
                "UPDATE image_library SET album_id = NULL WHERE album_id = ?1",
                params![id],
            )?;
            connection.execute("DELETE FROM image_albums WHERE id = ?1", params![id])?;
            Ok(())
        })
        .map_err(|error| database::database_error(database_path, "delete image album", error))
}

/// 将图片移入 / 移出相册（album_id 为 None 时移出）。
/// 相册或图片不存在时返回错误。
pub fn set_image_album(database_path: &Path, image_id: &str, album_id: Option<&str>) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|connection| {
            if let Some(album_id) = album_id {
                let album_exists: bool = connection.query_row(
                    "SELECT EXISTS(SELECT 1 FROM image_albums WHERE id = ?1)",
                    params![album_id],
                    |row| row.get(0),
                )?;
                if !album_exists {
                    return Err(rusqlite::Error::QueryReturnedNoRows);
                }
            }
            let affected = connection.execute(
                "UPDATE image_library SET album_id = ?1 WHERE id = ?2",
                params![album_id, image_id],
            )?;
            if affected == 0 {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }
            Ok(())
        })
        .map_err(|error| database::database_error(database_path, "set image album", error))
}

/// 将图库相对路径（image/...）解析为根目录下的绝对路径。
/// 根目录本身即 image 目录，物理文件直接位于根目录下（persist 时
/// 按 `root/日期/文件名` 落盘），因此 `image/` 仅是逻辑前缀，需先去掉再拼接。
fn library_file_path(root: &Path, relative_path: &str) -> PathBuf {
    let normalized = relative_path.trim().replace('\\', "/");
    let inner = normalized.strip_prefix("image/").unwrap_or(&normalized);
    root.join(inner)
}

/// 读取图库文件并返回 data URL（白名单校验：仅 image/ 前缀 + 防穿越）。
pub fn read_image_file(relative_path: &str) -> Result<Option<String>> {
    let normalized = relative_path.trim().replace('\\', "/");
    if !normalized.starts_with("image/") || normalized.contains("..") {
        return Ok(None);
    }
    let root = image_library_root()?;
    let file_path = library_file_path(&root, &normalized);
    // 二次校验：绝对路径必须落在 image 根目录内
    let Ok(canonical_root) = root.canonicalize() else {
        return Ok(None);
    };
    let Ok(canonical_file) = file_path.canonicalize() else {
        return Ok(None);
    };
    if !canonical_file.starts_with(&canonical_root) {
        return Ok(None);
    }
    let Ok(bytes) = fs::read(&canonical_file) else {
        return Ok(None);
    };
    let mime_type = match file_path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => "image/png",
    };
    Ok(Some(format!(
        "data:{mime_type};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&bytes)
    )))
}

/// 删除图片：事务内先重写引用该图片的会话消息，再删除索引行；
/// 最后物理删除文件。任一步失败则回滚（不留下半删状态）。
pub fn delete_image(database_path: &Path, id: &str) -> Result<()> {
    let mut connection = database::open_connection(database_path)
        .map_err(|error| database::database_error(database_path, "open for image delete", error))?;

    let tx = connection
        .transaction()
        .map_err(|error| database::database_error(database_path, "begin image delete tx", error))?;

    let record: Option<(String, String)> = tx
        .query_row(
            "SELECT relative_path, file_name FROM image_library WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| database::database_error(database_path, "query image record", error))?;

    let Some((relative_path, _file_name)) = record else {
        return Ok(()); // 不存在视为已删除
    };

    // 1) 重写引用该图的会话消息（content + raw_json）
    let rewritten = rewrite_messages_referencing(&tx, &relative_path).map_err(|error| {
        database::database_error(database_path, "rewrite messages for image", error)
    })?;

    // 2) 删除索引行
    tx.execute("DELETE FROM image_library WHERE id = ?1", params![id])
        .map_err(|error| database::database_error(database_path, "delete image index", error))?;

    tx.commit()
        .map_err(|error| database::database_error(database_path, "commit image delete", error))?;

    // 3) 物理删除文件（索引已删，失败仅产生孤儿文件，不阻断）
    let root = image_library_root()?;
    let file_path = library_file_path(&root, &relative_path);
    if let Ok(canonical_root) = root.canonicalize() {
        if let Ok(canonical_file) = file_path.canonicalize() {
            if canonical_file.starts_with(&canonical_root) {
                let _ = fs::remove_file(&canonical_file);
            }
        }
    }

    if rewritten > 0 {
        eprintln!("[image-library] deleted '{relative_path}', rewrote {rewritten} message(s)");
    }
    Ok(())
}

/// 按文件头魔数探测图片 MIME 类型（PNG/JPEG/GIF/WebP），未知时按扩展名推断。
fn detect_mime(bytes: &[u8], fallback_ext: &str) -> String {
    if bytes.len() >= 8 && &bytes[0..8] == b"\x89PNG\r\n\x1a\n" {
        return "image/png".to_string();
    }
    if bytes.len() >= 3 && &bytes[0..3] == b"GIF8" {
        return "image/gif".to_string();
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return "image/webp".to_string();
    }
    if bytes.len() >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 {
        return "image/jpeg".to_string();
    }
    match fallback_ext {
        "jpg" | "jpeg" => "image/jpeg".to_string(),
        "webp" => "image/webp".to_string(),
        "gif" => "image/gif".to_string(),
        _ => "image/png".to_string(),
    }
}

/// 按 id 查询图片记录。
fn find_image(
    connection: &rusqlite::Connection,
    id: &str,
) -> rusqlite::Result<Option<ImageLibraryRecord>> {
    connection
        .query_row(
            "SELECT id, relative_path, file_name, mime_type, size_bytes, width, height,
                    prompt, model, provider, created_at, album_id
               FROM image_library
              WHERE id = ?1",
            params![id],
            map_row,
        )
        .optional()
}

/// 手动导入图片：将外部文件复制进图库目录（按当天日期子目录）并写入索引。
/// 跳过不可读 / 空文件 / 复制失败的文件；返回成功导入的记录列表。
/// 手动导入的图片无 prompt/model/provider（索引留空，前端展示文件名）。
pub fn import_image_files(
    database_path: &Path,
    file_paths: &[String],
) -> Result<Vec<ImageLibraryRecord>> {
    let root = image_library_root()?;
    let date_dir = chrono::Local::now().format("%Y-%m-%d").to_string();
    let target_dir = root.join(&date_dir);
    fs::create_dir_all(&target_dir).map_err(|error| {
        Error::from_reason(format!(
            "Failed to create image library date directory '{}': {error}",
            target_dir.display()
        ))
    })?;

    let connection = database::open_connection(database_path)
        .map_err(|error| database::database_error(database_path, "open for image import", error))?;

    let mut imported: Vec<ImageLibraryRecord> = Vec::new();
    for path_str in file_paths {
        let source = PathBuf::from(path_str);
        if !source.is_file() {
            continue;
        }
        let Ok(bytes) = fs::read(&source) else {
            continue;
        };
        if bytes.is_empty() {
            continue;
        }
        let fallback_ext = source
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let mime_type = detect_mime(&bytes, &fallback_ext);
        let file_name = format!(
            "img-{}-{}.{}",
            chrono::Local::now().format("%Y%m%d%H%M%S"),
            database::create_snowflake_id(),
            ext_for_mime(&mime_type)
        );
        let abs_path = target_dir.join(&file_name);
        if let Err(error) = fs::copy(&source, &abs_path) {
            eprintln!(
                "[image-library] failed to import '{}': {error}",
                source.display()
            );
            continue;
        }

        let relative_path = format!("image/{date_dir}/{file_name}");
        let (width, height) = probe_dimensions(&bytes, &mime_type);
        let id = database::create_snowflake_id();
        let insert_result = connection.execute(
            "INSERT INTO image_library (
               id, relative_path, file_name, mime_type, size_bytes, width, height
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, relative_path, file_name, mime_type, bytes.len() as i64, width, height],
        );
        match insert_result {
            Ok(_) => {
                if let Some(record) = find_image(&connection, &id).unwrap_or(None) {
                    imported.push(record);
                }
            }
            Err(error) => {
                // 索引失败：清理已复制文件，避免孤儿文件
                eprintln!(
                    "[image-library] failed to index imported image '{relative_path}': {error}"
                );
                let _ = fs::remove_file(&abs_path);
            }
        }
    }
    Ok(imported)
}

/// 扫描并重写所有引用 `relative_path` 的消息。
/// 返回受影响的消息条数。
fn rewrite_messages_referencing(
    tx: &rusqlite::Transaction<'_>,
    relative_path: &str,
) -> rusqlite::Result<usize> {
    let pattern = format!("%{relative_path}%");
    let mut statement = tx.prepare(
        "SELECT message_id, content, raw_json FROM chat_messages
          WHERE content LIKE ?1 OR raw_json LIKE ?1",
    )?;
    let rows: Vec<(String, String, Option<String>)> = statement
        .query_map(params![pattern], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut updated = 0usize;
    for (message_id, content, raw_json) in rows {
        let new_content = strip_image_ref_from_content(&content, relative_path);
        let new_raw_json = raw_json
            .as_deref()
            .map(|raw| strip_image_ref_from_raw_json(raw, relative_path));

        let content_changed = new_content != content;
        let raw_changed = match (&raw_json, &new_raw_json) {
            (Some(old), Some(new)) => new != old,
            (Some(_), None) => true,
            (None, None) => false,
            (None, Some(_)) => true,
        };
        if !content_changed && !raw_changed {
            continue;
        }

        match new_raw_json {
            Some(new_raw) => {
                tx.execute(
                    "UPDATE chat_messages SET content = ?1, raw_json = ?2 WHERE message_id = ?3",
                    params![new_content, new_raw, message_id],
                )?;
            }
            None => {
                tx.execute(
                    "UPDATE chat_messages SET content = ?1, raw_json = NULL WHERE message_id = ?2",
                    params![new_content, message_id],
                )?;
            }
        }
        updated += 1;
    }
    Ok(updated)
}

/// 从文本中提取所有图库相对路径引用：
/// - JSON 字段 `"path":"image/..."`（生成结果 content 块）
/// - 历史标签 `@@image:image/...@@`
fn extract_image_paths(text: &str, paths: &mut Vec<String>) {
    let json_path = regex::Regex::new(r#""path"\s*:\s*"(image/[^"]+)""#).unwrap();
    let tag = regex::Regex::new(r"@@image:(image/[^@]+)@@").unwrap();
    for capture in json_path.captures_iter(text) {
        if let Some(value) = capture.get(1) {
            let path = value.as_str().to_string();
            if !paths.contains(&path) {
                paths.push(path);
            }
        }
    }
    for capture in tag.captures_iter(text) {
        if let Some(value) = capture.get(1) {
            let path = value.as_str().to_string();
            if !paths.contains(&path) {
                paths.push(path);
            }
        }
    }
}

/// 收集指定会话中引用的图库图片路径（去重）。
fn collect_paths_for_conversations(
    connection: &rusqlite::Connection,
    conversation_ids: &[String],
) -> rusqlite::Result<Vec<String>> {
    let mut paths: Vec<String> = Vec::new();
    for conversation_id in conversation_ids {
        let mut statement = connection
            .prepare("SELECT content, raw_json FROM chat_messages WHERE conversation_id = ?1")?;
        let rows = statement.query_map(params![conversation_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })?;
        for row in rows {
            let (content, raw_json) = row?;
            extract_image_paths(&content, &mut paths);
            if let Some(raw) = raw_json {
                extract_image_paths(&raw, &mut paths);
            }
        }
    }
    Ok(paths)
}

/// 统计指定会话中引用的图库图片数量（去重后按索引存在性计数）。
pub fn count_conversation_images(database_path: &Path, conversation_ids: &[String]) -> Result<i64> {
    let connection = database::open_connection(database_path)
        .map_err(|error| database::database_error(database_path, "open for image count", error))?;
    let paths =
        collect_paths_for_conversations(&connection, conversation_ids).map_err(|error| {
            database::database_error(database_path, "scan conversation images", error)
        })?;
    let mut count = 0i64;
    for path in &paths {
        let exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM image_library WHERE relative_path = ?1)",
                params![path],
                |row| row.get(0),
            )
            .map_err(|error| database::database_error(database_path, "check image index", error))?;
        if exists {
            count += 1;
        }
    }
    Ok(count)
}

/// 级联删除指定会话中引用的图库图片（物理文件 + 索引行）。
/// 会话本身即将被删除，无需重写消息。返回删除的图片数量。
pub fn delete_conversation_images(
    database_path: &Path,
    conversation_ids: &[String],
) -> Result<i64> {
    let mut connection = database::open_connection(database_path).map_err(|error| {
        database::database_error(database_path, "open for image cascade", error)
    })?;
    let paths =
        collect_paths_for_conversations(&connection, conversation_ids).map_err(|error| {
            database::database_error(database_path, "scan conversation images", error)
        })?;

    let tx = connection.transaction().map_err(|error| {
        database::database_error(database_path, "begin image cascade tx", error)
    })?;

    let mut removed_files: Vec<String> = Vec::new();
    for path in &paths {
        let file_name: Option<String> = tx
            .query_row(
                "SELECT file_name FROM image_library WHERE relative_path = ?1",
                params![path],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| {
                database::database_error(database_path, "query image record", error)
            })?;
        if file_name.is_none() {
            continue;
        }
        tx.execute(
            "DELETE FROM image_library WHERE relative_path = ?1",
            params![path],
        )
        .map_err(|error| database::database_error(database_path, "delete image index", error))?;
        removed_files.push(path.clone());
    }

    tx.commit()
        .map_err(|error| database::database_error(database_path, "commit image cascade", error))?;

    // 物理删除文件（失败仅产生孤儿文件，不阻断会话删除）
    let root = image_library_root()?;
    for path in &removed_files {
        let file_path = library_file_path(&root, path);
        if let Ok(canonical_root) = root.canonicalize() {
            if let Ok(canonical_file) = file_path.canonicalize() {
                if canonical_file.starts_with(&canonical_root) {
                    let _ = fs::remove_file(&canonical_file);
                }
            }
        }
    }

    if !removed_files.is_empty() {
        eprintln!(
            "[image-library] cascade deleted {} image(s) for {} conversation(s)",
            removed_files.len(),
            conversation_ids.len()
        );
    }
    Ok(removed_files.len() as i64)
}

/// 从消息 content（`[Tool: name#callId]\n<result JSON>` 分段格式）中移除
/// 指定 path 的图片块，并清理残留的 `@@image:<path>@@` 标签。
fn strip_image_ref_from_content(content: &str, relative_path: &str) -> String {
    let mut result = String::new();
    let mut rest = content;

    while let Some(idx) = rest.find("[Tool: ") {
        result.push_str(&rest[..idx]);
        let after = &rest[idx..];
        let Some(nl) = after.find('\n') else {
            result.push_str(after);
            rest = "";
            break;
        };
        result.push_str(&after[..=nl]);
        let body = &after[nl + 1..];
        let next = body.find("\n[Tool: ");
        let (json_part, tail) = match next {
            Some(i) => (&body[..i], &body[i..]),
            None => (body, ""),
        };

        let trimmed = json_part.trim_end();
        let rewritten = serde_json::from_str::<Value>(trimmed)
            .ok()
            .map(|mut value| {
                if let Some(blocks) = value.get_mut("content").and_then(Value::as_array_mut) {
                    blocks.retain(|block| {
                        !(block.get("type").and_then(Value::as_str) == Some("image")
                            && block.get("path").and_then(Value::as_str) == Some(relative_path))
                    });
                }
                serde_json::to_string(&value).unwrap_or_else(|_| trimmed.to_string())
            })
            .unwrap_or_else(|| trimmed.to_string());

        result.push_str(&rewritten);
        rest = tail;
    }
    result.push_str(rest);

    // 清理历史残留的标签形式引用
    result.replace(&format!("@@image:{relative_path}@@"), "")
}

/// 从消息 raw_json（`[{name, callId, result}]` 格式）中移除指定 path 的图片块。
fn strip_image_ref_from_raw_json(raw_json: &str, relative_path: &str) -> String {
    let Ok(mut array) = serde_json::from_str::<Value>(raw_json) else {
        return raw_json.replace(&format!("@@image:{relative_path}@@"), "");
    };
    if let Some(items) = array.as_array_mut() {
        for item in items.iter_mut() {
            let Some(result_str) = item.get("result").and_then(Value::as_str) else {
                continue;
            };
            let Some(mut result_value) = serde_json::from_str::<Value>(result_str).ok() else {
                continue;
            };
            let mut changed = false;
            if let Some(blocks) = result_value
                .get_mut("content")
                .and_then(Value::as_array_mut)
            {
                let before = blocks.len();
                blocks.retain(|block| {
                    !(block.get("type").and_then(Value::as_str) == Some("image")
                        && block.get("path").and_then(Value::as_str) == Some(relative_path))
                });
                changed = blocks.len() != before;
            }
            if changed {
                if let Ok(new_result) = serde_json::to_string(&result_value) {
                    item["result"] = Value::String(new_result);
                }
            }
        }
    }
    serde_json::to_string(&array).unwrap_or_else(|_| raw_json.to_string())
}

// ============================================================================
// 图库目录迁移（更换保存目录时把现有图片复制到新根目录，支持取消与崩溃恢复）
//
// 流程：prepare 写入迁移日志（存放于应用数据目录，独立于图库根目录，
// 保证任何情况下可发现）→ chunk 逐批复制并更新日志 → commit 写入新目录
// 设置（提交点）并清理旧文件。用户取消或复制出错时调用 rollback 删除新
// 目录中的副本；进程中途被杀时，下次启动由 recover_interrupted_migration
// 自动回滚（未提交）或完成清理（已提交）。
// ============================================================================

/// 迁移日志文件名
const MIGRATION_JOURNAL_FILE: &str = ".snow-image-migration.json";

/// 迁移日志：prepare 时写入，chunk 逐文件更新 copied，commit 成功后删除。
#[derive(Debug, Serialize, Deserialize)]
struct MigrationJournal {
    version: u32,
    old_root: String,
    new_root: String,
    /// commit 时写入 system_settings 的值（"" 表示重置为默认目录）
    setting_value: String,
    /// 计划迁移的图库相对路径（image/...）
    files: Vec<String>,
    /// 已完成复制的相对路径
    copied: Vec<String>,
}

fn migration_journal_path() -> Result<PathBuf> {
    Ok(paths::app_storage_dir()?.join(MIGRATION_JOURNAL_FILE))
}

fn load_migration_journal() -> Result<Option<MigrationJournal>> {
    let path = migration_journal_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(&path).map_err(|error| {
        Error::from_reason(format!("Failed to read migration journal: {error}"))
    })?;
    match serde_json::from_str(&content) {
        Ok(journal) => Ok(Some(journal)),
        Err(error) => {
            // 日志损坏无法安全回滚：移除并记录，避免阻塞后续迁移
            let _ = fs::remove_file(&path);
            eprintln!("[image-library] discarded corrupt migration journal: {error}");
            Ok(None)
        }
    }
}

fn save_migration_journal(journal: &MigrationJournal) -> Result<()> {
    let path = migration_journal_path()?;
    let content = serde_json::to_string_pretty(journal).map_err(|error| {
        Error::from_reason(format!("Failed to serialize migration journal: {error}"))
    })?;
    fs::write(&path, content)
        .map_err(|error| Error::from_reason(format!("Failed to write migration journal: {error}")))
}

/// 规范化路径用于比较（目录存在时优先 canonicalize，处理大小写与分隔符差异）。
fn normalized_for_compare(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

/// 校验并规范化图库相对路径（白名单：image/ 前缀 + 防穿越）。
fn validated_rel_path(relative_path: &str) -> Option<String> {
    let normalized = relative_path.trim().replace('\\', "/");
    if !normalized.starts_with("image/") || normalized.contains("..") {
        return None;
    }
    Some(normalized)
}

/// 从旧根复制一个图库文件到新根；源文件缺失视为已处理（跳过）。
fn copy_library_file(old_root: &Path, new_root: &Path, relative_path: &str) -> std::io::Result<()> {
    let source = library_file_path(old_root, relative_path);
    if !source.exists() {
        return Ok(());
    }
    let target = library_file_path(new_root, relative_path);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::copy(&source, &target)?;
    Ok(())
}

/// 删除指定根目录下的图库文件（白名单校验防越界），失败不阻断。
fn remove_library_file(root: &Path, relative_path: &str) {
    let file_path = library_file_path(root, relative_path);
    if let Ok(canonical_root) = root.canonicalize() {
        if let Ok(canonical_file) = file_path.canonicalize() {
            if canonical_file.starts_with(&canonical_root) {
                let _ = fs::remove_file(&canonical_file);
            }
        }
    }
}

/// 列出图库索引中的全部相对路径。
fn list_relative_paths(database_path: &Path) -> Result<Vec<String>> {
    database::open_connection(database_path)
        .and_then(|connection| {
            let mut statement = connection.prepare("SELECT relative_path FROM image_library")?;
            let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
            rows.collect()
        })
        .map_err(|error| database::database_error(database_path, "list image library paths", error))
}

/// 准备图库迁移：解析目标根目录、校验路径关系、按索引列出现有图片并写入迁移日志。
/// 返回待迁移图片数量；0 表示无需迁移（目标与当前相同或图库为空）。
pub fn prepare_migration(database_path: &Path, target_dir: &str) -> Result<usize> {
    let old_root = image_library_root()?;
    let setting_value = target_dir.trim().to_string();
    let new_root = if setting_value.is_empty() {
        paths::app_storage_dir()?.join("image")
    } else {
        PathBuf::from(&setting_value)
    };

    fs::create_dir_all(&new_root).map_err(|error| {
        Error::from_reason(format!(
            "目标图片目录不可用 '{}': {error}",
            new_root.display()
        ))
    })?;

    let old_norm = normalized_for_compare(&old_root);
    let new_norm = normalized_for_compare(&new_root);
    if old_norm == new_norm {
        return Ok(0); // 目标与当前相同，无需迁移
    }
    if new_norm.starts_with(&old_norm) {
        return Err(Error::from_reason(
            "目标目录不能位于当前图库目录内部".to_string(),
        ));
    }

    let files: Vec<String> = list_relative_paths(database_path)?
        .into_iter()
        .filter_map(|path| validated_rel_path(&path))
        .collect();
    if files.is_empty() {
        return Ok(0);
    }

    save_migration_journal(&MigrationJournal {
        version: 1,
        old_root: old_root.to_string_lossy().into_owned(),
        new_root: new_root.to_string_lossy().into_owned(),
        setting_value,
        copied: Vec::new(),
        files: files.clone(),
    })?;
    eprintln!(
        "[image-library] migration prepared: {} -> {} ({} file(s))",
        old_root.display(),
        new_root.display(),
        files.len()
    );
    Ok(files.len())
}

/// 复制下一批图库文件（最多 chunk_size 个），逐文件更新迁移日志。
/// 返回 (已完成数, 总数, 是否完成)。
pub fn migrate_chunk(chunk_size: usize) -> Result<(usize, usize, bool)> {
    let Some(mut journal) = load_migration_journal()? else {
        return Err(Error::from_reason("没有进行中的图片迁移".to_string()));
    };
    let old_root = PathBuf::from(&journal.old_root);
    let new_root = PathBuf::from(&journal.new_root);

    let mut batch = 0usize;
    for relative_path in &journal.files {
        if batch >= chunk_size {
            break;
        }
        if journal.copied.contains(relative_path) {
            continue;
        }
        copy_library_file(&old_root, &new_root, relative_path).map_err(|error| {
            Error::from_reason(format!("迁移图片失败 '{relative_path}': {error}"))
        })?;
        journal.copied.push(relative_path.clone());
        save_migration_journal(&journal)?;
        batch += 1;
    }

    let total = journal.files.len();
    let copied = journal.copied.len();
    Ok((copied, total, copied >= total))
}

/// 提交迁移：写入新目录设置（提交点）→ 删除日志 → 清理旧根目录文件。
/// 迁移期间新生成的图片在此兜底补迁，避免索引指向新根却缺文件。
pub fn commit_migration(database_path: &Path) -> Result<()> {
    let Some(mut journal) = load_migration_journal()? else {
        return Err(Error::from_reason("没有进行中的图片迁移".to_string()));
    };
    let old_root = PathBuf::from(&journal.old_root);
    let new_root = PathBuf::from(&journal.new_root);

    // 兜底：迁移期间新增的图片一并复制（失败不阻断提交）
    let current_paths = list_relative_paths(database_path).unwrap_or_default();
    for relative_path in current_paths {
        if let Some(rel) = validated_rel_path(&relative_path) {
            if !journal.files.contains(&rel) {
                if let Err(error) = copy_library_file(&old_root, &new_root, &rel) {
                    eprintln!("[image-library] catch-up copy failed '{rel}': {error}");
                }
                journal.files.push(rel);
            }
        }
    }

    // 提交点：写入目录设置（此刻起图库根切换为新目录）
    system_settings::set_image_library_dir(database_path, &journal.setting_value).map_err(
        |error| Error::from_reason(format!("Failed to save image library directory: {error}")),
    )?;

    let journal_path = migration_journal_path()?;
    let _ = fs::remove_file(&journal_path);

    // 清理旧根目录文件（失败仅残留孤儿文件，不阻断提交）
    for relative_path in &journal.files {
        remove_library_file(&old_root, relative_path);
    }

    eprintln!(
        "[image-library] migration committed: {} -> {} ({} file(s))",
        old_root.display(),
        new_root.display(),
        journal.files.len()
    );
    Ok(())
}

/// 回滚迁移：删除新根目录下已复制的文件并移除日志（幂等）。
/// 用户取消或迁移出错时调用；目录设置尚未写入，图库仍指向旧根目录。
pub fn rollback_migration() -> Result<()> {
    let Some(journal) = load_migration_journal()? else {
        return Ok(()); // 无进行中的迁移
    };
    let new_root = PathBuf::from(&journal.new_root);
    for relative_path in &journal.copied {
        remove_library_file(&new_root, relative_path);
    }
    let journal_path = migration_journal_path()?;
    let _ = fs::remove_file(&journal_path);
    eprintln!(
        "[image-library] migration rolled back, removed {} copied file(s) from {}",
        journal.copied.len(),
        new_root.display()
    );
    Ok(())
}

/// 启动时恢复中断的迁移（在 initialize_app_storage 中调用一次）：
/// - 日志的 new_root 已是当前根目录 → 设置已提交，仅清理日志与旧根文件；
/// - 否则 → 迁移未提交，回滚删除新根目录中的副本。
pub fn recover_interrupted_migration() -> Result<()> {
    let Some(journal) = load_migration_journal()? else {
        return Ok(());
    };
    let journal_root = PathBuf::from(&journal.new_root);
    let current_root = image_library_root()?;
    let committed = normalized_for_compare(&current_root) == normalized_for_compare(&journal_root);

    if committed {
        let old_root = PathBuf::from(&journal.old_root);
        for relative_path in &journal.files {
            remove_library_file(&old_root, relative_path);
        }
        eprintln!(
            "[image-library] recovered committed migration, cleaned up {}",
            old_root.display()
        );
    } else {
        for relative_path in &journal.copied {
            remove_library_file(&journal_root, relative_path);
        }
        eprintln!(
            "[image-library] recovered interrupted migration, rolled back {} copied file(s) from {}",
            journal.copied.len(),
            journal_root.display()
        );
    }

    let journal_path = migration_journal_path()?;
    let _ = fs::remove_file(&journal_path);
    Ok(())
}
