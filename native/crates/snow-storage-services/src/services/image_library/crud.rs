use std::fs;
use std::path::{Path, PathBuf};

use napi::bindgen_prelude::*;
use rusqlite::{params, OptionalExtension};
use serde_json::Value;

use super::super::super::database;
use super::{
    ext_for_mime, image_library_root, library_file_path, probe_dimensions, ImageAlbumRecord,
    ImageLibraryRecord,
};
use base64::Engine;

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

/// 列出全部相册（按拖拽排序 sort_order，其次创建时间倒序），
/// 封面 = 手动设置的封面（cover_image_id），未设置时回退最新一张图。
pub fn list_albums(database_path: &Path) -> Result<Vec<ImageAlbumRecord>> {
    database::open_connection(database_path)
        .and_then(|connection| {
            let mut statement = connection.prepare(
                "SELECT a.id, a.name, a.created_at,
                        COALESCE(
                          (SELECT i.relative_path FROM image_library i
                            WHERE i.id = a.cover_image_id LIMIT 1),
                          (SELECT i.relative_path FROM image_library i
                            WHERE i.album_id = a.id
                            ORDER BY i.created_at DESC, i.id DESC LIMIT 1)
                        ) AS cover_path,
                        (SELECT COUNT(*) FROM image_library i WHERE i.album_id = a.id) AS image_count
                   FROM image_albums a
                  ORDER BY a.sort_order ASC, a.created_at DESC, a.id DESC",
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
                    COALESCE(
                      (SELECT i.relative_path FROM image_library i
                        WHERE i.id = a.cover_image_id LIMIT 1),
                      (SELECT i.relative_path FROM image_library i
                        WHERE i.album_id = a.id
                        ORDER BY i.created_at DESC, i.id DESC LIMIT 1)
                    ) AS cover_path,
                    (SELECT COUNT(*) FROM image_library i WHERE i.album_id = a.id) AS image_count
               FROM image_albums a
              WHERE a.id = ?1",
            params![id],
            map_album_row,
        )
        .optional()
}

/// 设置相册手动封面：image_id 传 None 时清除手动封面（回退最新一张图）。
/// 校验图片必须属于该相册（或不存在），防止跨相册引用。
pub fn set_album_cover(
    database_path: &Path,
    album_id: &str,
    image_id: Option<&str>,
) -> Result<ImageAlbumRecord> {
    let mut connection = database::open_connection(database_path)
        .map_err(|error| database::database_error(database_path, "open for album cover", error))?;
    let tx = connection
        .transaction()
        .map_err(|error| database::database_error(database_path, "begin album cover tx", error))?;

    let album_exists: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM image_albums WHERE id = ?1)",
            params![album_id],
            |row| row.get(0),
        )
        .map_err(|error| database::database_error(database_path, "check album exists", error))?;
    if !album_exists {
        return Err(database::database_error(
            database_path,
            "album not found for cover",
            rusqlite::Error::QueryReturnedNoRows,
        ));
    }
    if let Some(image_id) = image_id {
        // 图片必须存在且属于该相册
        let belongs: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM image_library WHERE id = ?1 AND album_id = ?2)",
                params![image_id, album_id],
                |row| row.get(0),
            )
            .map_err(|error| database::database_error(database_path, "check image belongs", error))?;
        if !belongs {
            return Err(database::database_error(
                database_path,
                "image does not belong to album",
                rusqlite::Error::QueryReturnedNoRows,
            ));
        }
        tx.execute(
            "UPDATE image_albums SET cover_image_id = ?1 WHERE id = ?2",
            params![image_id, album_id],
        )
        .map_err(|error| database::database_error(database_path, "set album cover", error))?;
    } else {
        tx.execute(
            "UPDATE image_albums SET cover_image_id = NULL WHERE id = ?1",
            params![album_id],
        )
        .map_err(|error| database::database_error(database_path, "clear album cover", error))?;
    }

    let record = find_album(&tx, album_id)
        .map_err(|error| database::database_error(database_path, "query album after cover", error))?
        .ok_or_else(|| {
            database::database_error(
                database_path,
                "album missing after cover update",
                rusqlite::Error::QueryReturnedNoRows,
            )
        })?;
    tx.commit()
        .map_err(|error| database::database_error(database_path, "commit album cover", error))?;
    Ok(record)
}

/// 拖拽排序：按给定相册 id 顺序写入 sort_order（0,1,2,...）；
/// 未出现在列表中的相册保持原 sort_order（排在末尾）。
pub fn reorder_albums(database_path: &Path, ordered_ids: &[String]) -> Result<()> {
    let mut connection = database::open_connection(database_path)
        .map_err(|error| database::database_error(database_path, "open for album reorder", error))?;
    let tx = connection
        .transaction()
        .map_err(|error| database::database_error(database_path, "begin album reorder tx", error))?;
    for (index, album_id) in ordered_ids.iter().enumerate() {
        tx.execute(
            "UPDATE image_albums SET sort_order = ?1 WHERE id = ?2",
            params![index as i64, album_id],
        )
        .map_err(|error| database::database_error(database_path, "update album order", error))?;
    }
    tx.commit()
        .map_err(|error| database::database_error(database_path, "commit album reorder", error))
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
