use super::*;

use std::path::{Path, PathBuf};

use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use serde_json::{json, Value};

use super::super::bash::{BashStreamCallback, BashStreamChunk};

/// 前端传入的参考图（图生图）。
pub(crate) struct ReferenceImage {
    pub(crate) data: String,
    pub(crate) mime_type: String,
}

/// 解析 `images` 参数。每个元素支持两种引用方式：
/// - `{ "data": "<base64>", "mimeType": "image/png" }` —— 内联 base64
///   （兼容 `data:image/png;base64,...` data URL 前缀，自动剥离）；
/// - `{ "path": "C:/Users/xx/photo.png", "mimeType": "image/png" }`
///   —— 绝对磁盘路径（用户本地任意目录的图片），或
///   `upload/2026-07-25/hash.png` 这种相对数据库文件所在目录的路径（来自
///   纯文本主模型消息中的 `[Reference image #N for imagegen-generate: ...]`
///   引用块），由服务端读取文件并转 base64，避免把大段 base64 塞进对话
///   上下文。
/// 最多 14 张（Gemini 3 Pro Image 官方上限），单张 base64 上限约 20MB。
/// 解析参考图数组（`images` 或 `requestImages` 的单个分组）。
fn parse_reference_image_items(
    items: &[Value],
    database_path: &Path,
) -> napi::Result<Vec<ReferenceImage>> {
    const MAX_IMAGES: usize = 14;
    const MAX_BASE64_LEN: usize = 20 * 1024 * 1024; // 20MB base64

    if items.is_empty() {
        return Ok(Vec::new());
    }
    if items.len() > MAX_IMAGES {
        return Err(Error::new(
            Status::InvalidArg,
            format!(
                "Too many reference images: {} (max {MAX_IMAGES})",
                items.len()
            ),
        ));
    }

    let mut images = Vec::with_capacity(items.len());
    for item in items {
        // path 引用：服务端按 upload 相对路径读取文件（参考图引用块形式）
        if let Some(path) = item.get("path").and_then(Value::as_str) {
            let image = load_reference_image_from_path(path, item, database_path)?;
            images.push(image);
            continue;
        }

        let Some(data) = item.get("data").and_then(Value::as_str) else {
            return Err(Error::new(
                Status::InvalidArg,
                "Each reference image must have a base64 `data` string or a `path` string"
                    .to_string(),
            ));
        };
        let data = data.trim().to_string();
        // 兼容 data URL 前缀：data:image/png;base64,<base64>
        let (data, mime_type_from_url) = match data.strip_prefix("data:") {
            Some(rest) => match rest.split_once(',') {
                Some((metadata, payload)) => {
                    let media = metadata.strip_suffix(";base64").unwrap_or("").trim();
                    (
                        payload.trim().to_string(),
                        media.starts_with("image/").then(|| media.to_string()),
                    )
                }
                None => (data, None),
            },
            None => (data, None),
        };
        if data.is_empty() {
            return Err(Error::new(
                Status::InvalidArg,
                "Reference image `data` must not be empty".to_string(),
            ));
        }
        if data.len() > MAX_BASE64_LEN {
            return Err(Error::new(
                Status::InvalidArg,
                format!(
                    "Reference image is too large (max ~{}MB)",
                    MAX_BASE64_LEN / 1024 / 1024
                ),
            ));
        }
        let mime_type = item
            .get("mimeType")
            .and_then(Value::as_str)
            .filter(|value| value.starts_with("image/"))
            .or(mime_type_from_url.as_deref())
            .unwrap_or("image/png")
            .to_string();
        images.push(ReferenceImage { data, mime_type });
    }
    Ok(images)
}

/// 解析顶层 `images` 参数（所有请求共用的参考图）。
pub(crate) fn parse_reference_images(
    args: &Value,
    database_path: &Path,
) -> napi::Result<Vec<ReferenceImage>> {
    let Some(items) = args.get("images").and_then(Value::as_array) else {
        return Ok(Vec::new());
    };
    parse_reference_image_items(items, database_path)
}

/// 解析 `requestImages` 参数（每个请求独立的参考图）：
/// `Array<Array<{data|path, mimeType}>>`，第 i 项是第 i 个请求的参考图组。
/// 组数即请求数（1-10），每组最多 MAX_IMAGES 张。
pub(crate) fn parse_request_images(
    args: &Value,
    database_path: &Path,
) -> napi::Result<Vec<Vec<ReferenceImage>>> {
    const MAX_IMAGES: usize = 14;

    let Some(sets) = args.get("requestImages").and_then(Value::as_array) else {
        return Ok(Vec::new());
    };
    if sets.is_empty() {
        return Ok(Vec::new());
    }
    if sets.len() > MAX_PARALLEL_IMAGES {
        return Err(Error::new(
            Status::InvalidArg,
            format!(
                "Too many request image sets: {} (max {MAX_PARALLEL_IMAGES})",
                sets.len()
            ),
        ));
    }

    let mut result = Vec::with_capacity(sets.len());
    for (index, set) in sets.iter().enumerate() {
        let Some(items) = set.as_array() else {
            return Err(Error::new(
                Status::InvalidArg,
                format!(
                    "Each entry of `requestImages` must be an array of reference images (entry {})",
                    index + 1
                ),
            ));
        };
        if items.len() > MAX_IMAGES {
            return Err(Error::new(
                Status::InvalidArg,
                format!(
                    "Too many reference images in `requestImages[{index}]`: {} (max {MAX_IMAGES})",
                    items.len()
                ),
            ));
        }
        result.push(parse_reference_image_items(items, database_path)?);
    }
    Ok(result)
}

/// 解析 `mask` 参数（OpenAI edits 的局部重绘蒙版）：单个 `{data|path, mimeType}`
/// 对象，形状与 `images` 单项一致。未提供时返回 None。
pub(crate) fn parse_mask(
    args: &Value,
    database_path: &Path,
) -> napi::Result<Option<ReferenceImage>> {
    let Some(value) = args.get("mask") else {
        return Ok(None);
    };
    if !value.is_object() {
        return Err(Error::new(
            Status::InvalidArg,
            "`mask` must be an object with a base64 `data` or a `path` string and a `mimeType` (same shape as one `images` entry)"
                .to_string(),
        ));
    }
    let mut items = parse_reference_image_items(std::slice::from_ref(value), database_path)?;
    Ok(items.pop())
}

/// 按磁盘路径读取参考图（`{ "path": ... }` 引用块形式）。
///
/// 支持两种形式：
/// - 绝对磁盘路径（如 `C:/Users/xx/photo.png`、`/home/xx/photo.png`）：
///   直接读取，用于从任意目录引用用户本地图片；
/// - `upload/` 目录内的相对路径（相对数据库文件所在目录）：读取会话上传
///   目录下的文件；拒绝路径穿越（`..`），防止相对路径逃逸出 upload 目录。
fn load_reference_image_from_path(
    path: &str,
    item: &Value,
    database_path: &Path,
) -> napi::Result<ReferenceImage> {
    const MAX_BASE64_LEN: usize = 20 * 1024 * 1024; // 20MB base64

    let normalized = path.trim().replace('\\', "/");
    if normalized.is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            "Reference image `path` must not be empty".to_string(),
        ));
    }
    let file_path = if Path::new(&normalized).is_absolute() {
        // 绝对磁盘路径：用户本地任意目录的图片，直接读取
        PathBuf::from(&normalized)
    } else {
        // 相对路径：仅允许 upload/ 目录内，拒绝路径穿越（..）
        if !normalized.starts_with("upload/") || normalized.contains("..") {
            return Err(Error::new(
                Status::InvalidArg,
                format!(
                    "Invalid reference image path: \"{path}\". Use an absolute file path (e.g. C:/path/to/image.png) or a relative path under the conversation's upload/ directory (e.g. upload/2026-07-25/hash.png)."
                ),
            ));
        }
        database_path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join(&normalized)
    };
    let bytes = std::fs::read(&file_path).map_err(|_| {
        Error::new(
            Status::InvalidArg,
            format!("Failed to read reference image file: \"{path}\""),
        )
    })?;
    if bytes.is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            format!("Reference image file is empty: \"{path}\""),
        ));
    }
    if bytes.len() > MAX_BASE64_LEN {
        return Err(Error::new(
            Status::InvalidArg,
            format!(
                "Reference image is too large (max ~{}MB)",
                MAX_BASE64_LEN / 1024 / 1024
            ),
        ));
    }

    let mime_type = item
        .get("mimeType")
        .and_then(Value::as_str)
        .filter(|value| value.starts_with("image/"))
        .map(str::to_string)
        .unwrap_or_else(|| mime_for_path(&normalized));
    use base64::Engine;
    let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(ReferenceImage { data, mime_type })
}

/// 按文件扩展名推断图片 MIME 类型（与 `images.rs` 的推断保持一致）。
fn mime_for_path(path: &str) -> String {
    match path
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png".to_string(),
        "jpg" | "jpeg" => "image/jpeg".to_string(),
        "gif" => "image/gif".to_string(),
        "webp" => "image/webp".to_string(),
        "bmp" => "image/bmp".to_string(),
        "svg" => "image/svg+xml".to_string(),
        _ => "image/png".to_string(),
    }
}

pub(crate) fn decode_base64(data: &str) -> napi::Result<Vec<u8>> {
    use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};
    BASE64_STANDARD.decode(data).map_err(|error| {
        Error::new(
            Status::InvalidArg,
            format!("Invalid base64 image data: {error}"),
        )
    })
}

pub(crate) fn ext_for_mime(mime_type: &str) -> String {
    match mime_type {
        "image/jpeg" | "image/jpg" => "jpg".to_string(),
        "image/webp" => "webp".to_string(),
        "image/gif" => "gif".to_string(),
        _ => "png".to_string(),
    }
}

/// 通过 on_chunk 向渲染进程推送一张流式预览图。
pub(crate) fn emit_partial(on_chunk: &BashStreamCallback, index: usize, mime_type: &str, b64: &str) {
    let payload = json!({
        "type": "partial_image",
        "index": index,
        "mimeType": mime_type,
        "data": b64,
    })
    .to_string();
    on_chunk.call(
        BashStreamChunk {
            stream: "imagegen".to_string(),
            data: payload,
        },
        ThreadsafeFunctionCallMode::NonBlocking,
    );
}
