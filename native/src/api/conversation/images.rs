use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use base64::Engine;
use chrono;
use napi::bindgen_prelude::*;

#[derive(Clone, Debug)]
pub struct ChatImage {
    pub media_type: String,
    pub data: String,
    pub data_url: String,
    /// 磁盘相对路径（相对数据库文件所在目录），例如 `upload/2026-07-25/hash.png`。
    /// 消息持久化时内联 base64 会被写入 upload 目录、标签改为相对路径；
    /// 仍以内联 data URL 形式存在（未持久化）的图片此字段为 None。
    pub source: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct ParsedChatMessageContent {
    pub text: String,
    pub images: Vec<ChatImage>,
}

pub fn parse_chat_message_content(
    content: &str,
    database_path: &Path,
) -> Result<ParsedChatMessageContent> {
    const IMAGE_TAG_PREFIX: &str = "@@image:";
    const REVIEW_TAG_PREFIX: &str = "@@review:";
    const ELEMENT_TAG_PREFIX: &str = "@@element:";

    let mut parsed = ParsedChatMessageContent::default();
    let mut remaining = content;

    // 同时识别 image / review / element 三种标签，取最先出现的那个处理。
    while let Some(tag_start) = find_earliest_tag(
        remaining,
        IMAGE_TAG_PREFIX,
        REVIEW_TAG_PREFIX,
        ELEMENT_TAG_PREFIX,
    ) {
        parsed.text.push_str(&remaining[..tag_start]);

        let is_review = remaining[tag_start..].starts_with(REVIEW_TAG_PREFIX);
        let is_element = remaining[tag_start..].starts_with(ELEMENT_TAG_PREFIX);
        let prefix = if is_review {
            REVIEW_TAG_PREFIX
        } else if is_element {
            ELEMENT_TAG_PREFIX
        } else {
            IMAGE_TAG_PREFIX
        };
        let tag_value_start = tag_start + prefix.len();
        let tag_value_and_rest = &remaining[tag_value_start..];
        let Some(tag_end) = tag_value_and_rest.find("@@") else {
            parsed.text.push_str(&remaining[tag_start..]);
            return Ok(parsed);
        };

        let value = &tag_value_and_rest[..tag_end];
        let full_tag_end = tag_value_start + tag_end + 2;

        if is_review {
            // review 标签：将 base64 编码的完整审查提示词展开为纯文本，
            // 使 AI 收到干净的指令 + diff 内容，而非 JSON 外壳。
            if let Some(prompt) = try_expand_review_tag(value) {
                parsed.text.push_str(&prompt);
            } else {
                parsed.text.push_str(&remaining[tag_start..full_tag_end]);
            }
        } else if is_element {
            // element 标签：将浏览器元素选择器选取的元素展开为人类可读的
            // 描述文本（标签/选择器/备注/文本/URL），使 AI 直接理解用户
            // 选取了页面上哪个元素，而非收到 base64 JSON 外壳。
            if let Some(description) = try_expand_element_tag(value) {
                parsed.text.push_str(&description);
            } else {
                parsed.text.push_str(&remaining[tag_start..full_tag_end]);
            }
        } else if let Some(svg_text) = try_extract_svg_source(value, database_path) {
            // SVG is XML text — most AI models cannot interpret it as a raster
            // image from base64. Inline the raw SVG source code instead.
            parsed.text.push_str(&svg_text);
        } else if let Some(image) = parse_image_tag_value(value, database_path)? {
            // Insert an inline placeholder so the model can see the image's
            // position and order within the message text. The 1-based index
            // matches the order images appear in the `parsed.images` vector,
            // which is also the order they are emitted as multimodal parts.
            let index = parsed.images.len() + 1;
            parsed.text.push_str(&format!("[Image #{index}]"));
            parsed.images.push(image);
        } else {
            parsed.text.push_str(&remaining[tag_start..full_tag_end]);
        }

        remaining = &remaining[full_tag_end..];
    }

    parsed.text.push_str(remaining);
    parsed.text = parsed.text.trim().to_string();
    Ok(parsed)
}

/// 返回 remaining 中最先出现的任一标签前缀的位置。
fn find_earliest_tag(
    remaining: &str,
    image_prefix: &str,
    review_prefix: &str,
    element_prefix: &str,
) -> Option<usize> {
    let image_start = remaining.find(image_prefix);
    let review_start = remaining.find(review_prefix);
    let element_start = remaining.find(element_prefix);
    [image_start, review_start, element_start]
        .into_iter()
        .flatten()
        .min()
}

/// 尝试将 `@@review:{"prompt":"<base64>",...}@@` 标签展开为完整审查提示词。
///
/// prompt 在前端编码时以 base64 承载（git diff 的 hunk 头 `@@` 会破坏
/// 标签终止符，base64 字符集不含 `@@` 可安全内嵌）。非法 JSON 或
/// base64 解码失败时返回 None，调用方保留原始标签、不破坏消息内容。
fn try_expand_review_tag(value: &str) -> Option<String> {
    let parsed: serde_json::Value = serde_json::from_str(value).ok()?;
    let prompt_b64 = parsed.get("prompt")?.as_str()?;
    if prompt_b64.is_empty() {
        return Some(String::new());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(prompt_b64)
        .ok()?;
    String::from_utf8(bytes).ok()
}

/// 尝试将 `@@element:{"url":"...","tag":"button","label":"button#search",
/// "text":"<base64>","note":"<base64>"}@@` 标签展开为人类可读的元素描述。
///
/// text / note 在前端编码时以 base64 承载（自由文本可能含 `@@` 破坏标签
/// 终止符）；url / tag / label 为结构化字段直接 JSON 内嵌。非法 JSON 或
/// base64 解码失败时返回 None，调用方保留原始标签、不破坏消息内容。
fn try_expand_element_tag(value: &str) -> Option<String> {
    let parsed: serde_json::Value = serde_json::from_str(value).ok()?;
    let tag = parsed.get("tag").and_then(|v| v.as_str()).unwrap_or("");
    let label = parsed.get("label").and_then(|v| v.as_str()).unwrap_or("");
    let url = parsed.get("url").and_then(|v| v.as_str()).unwrap_or("");
    let decode_field = |key: &str| -> String {
        parsed
            .get(key)
            .and_then(|v| v.as_str())
            .and_then(|b64| base64::engine::general_purpose::STANDARD.decode(b64).ok())
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .unwrap_or_default()
    };
    let text = decode_field("text");
    let note = decode_field("note");

    let display = if !label.is_empty() { label } else { tag };
    let mut parts: Vec<String> = Vec::new();
    if display.is_empty() {
        parts.push("[页面元素]".to_string());
    } else {
        parts.push(format!("[页面元素 {display}]"));
    }
    if !note.is_empty() {
        parts.push(format!("备注：{note}"));
    }
    if !text.is_empty() {
        parts.push(format!("内容：{text}"));
    }
    if !url.is_empty() {
        parts.push(format!("页面：{url}"));
    }
    Some(parts.join(" "))
}

/// 展开消息内容中所有 `@@element:...@@` 标签为人类可读的元素描述文本。
///
/// 用于会话标题等展示场景：避免 base64 JSON 外壳污染侧边栏文字。
/// 内容不含 element 标签时返回 None，调用方沿用原文。
pub(crate) fn expand_element_tags_in_content(content: &str) -> Option<String> {
    const ELEMENT_TAG_PREFIX: &str = "@@element:";
    if !content.contains(ELEMENT_TAG_PREFIX) {
        return None;
    }
    let mut result = String::with_capacity(content.len());
    let mut remaining = content;
    while let Some(tag_start) = remaining.find(ELEMENT_TAG_PREFIX) {
        result.push_str(&remaining[..tag_start]);
        let value_start = tag_start + ELEMENT_TAG_PREFIX.len();
        let value_and_rest = &remaining[value_start..];
        let Some(tag_end) = value_and_rest.find("@@") else {
            result.push_str(&remaining[tag_start..]);
            return Some(result);
        };
        let value = &value_and_rest[..tag_end];
        let full_tag_end = value_start + tag_end + 2;
        match try_expand_element_tag(value) {
            Some(description) => result.push_str(&description),
            None => result.push_str(&remaining[tag_start..full_tag_end]),
        }
        remaining = &remaining[full_tag_end..];
    }
    result.push_str(remaining);
    Some(result)
}

/// 展开消息内容中所有 `@@review:...@@` 标签为完整审查提示词文本。
///
/// 用于会话标题等展示场景：避免 base64 外壳污染侧边栏文字。
/// 内容不含 review 标签时返回 None，调用方沿用原文。
pub(crate) fn expand_review_tags_in_content(content: &str) -> Option<String> {
    const REVIEW_TAG_PREFIX: &str = "@@review:";
    if !content.contains(REVIEW_TAG_PREFIX) {
        return None;
    }
    let mut result = String::with_capacity(content.len());
    let mut remaining = content;
    while let Some(tag_start) = remaining.find(REVIEW_TAG_PREFIX) {
        result.push_str(&remaining[..tag_start]);
        let value_start = tag_start + REVIEW_TAG_PREFIX.len();
        let value_and_rest = &remaining[value_start..];
        let Some(tag_end) = value_and_rest.find("@@") else {
            result.push_str(&remaining[tag_start..]);
            return Some(result);
        };
        let value = &value_and_rest[..tag_end];
        let full_tag_end = value_start + tag_end + 2;
        match try_expand_review_tag(value) {
            Some(prompt) => result.push_str(&prompt),
            None => result.push_str(&remaining[tag_start..full_tag_end]),
        }
        remaining = &remaining[full_tag_end..];
    }
    result.push_str(remaining);
    Some(result)
}

fn parse_image_tag_value(value: &str, database_path: &Path) -> Result<Option<ChatImage>> {
    let value = value.trim();
    if value.starts_with("data:") {
        return Ok(parse_base64_image_data_url(value));
    }

    // Reject obviously invalid paths that are not real file references.
    // AI may output literal template strings like "{}" or placeholders
    // after reading source code containing @@image:{}@@ format strings.
    if value.is_empty() || value.contains('{') || !value.contains('/') {
        return Ok(None);
    }

    let relative_path = value;
    let file_path = database_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(relative_path);

    // Silently skip unreadable files instead of failing the entire request.
    // A stale or invalid image reference should not block the conversation.
    let bytes = match fs::read(&file_path) {
        Ok(bytes) => bytes,
        Err(_) => return Ok(None),
    };
    if bytes.is_empty() {
        return Ok(None);
    }

    let media_type = extension_to_media_type(&file_path);
    let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let data_url = format!("data:{};base64,{}", media_type, data);

    Ok(Some(ChatImage {
        media_type,
        data,
        data_url,
        source: Some(relative_path.to_string()),
    }))
}

fn parse_base64_image_data_url(data_url: &str) -> Option<ChatImage> {
    let value = data_url.trim();
    let (metadata, data) = value.strip_prefix("data:")?.split_once(',')?;
    let media_type = metadata.strip_suffix(";base64")?.trim();
    let data = data.trim();

    if media_type.len() <= "image/".len() || !media_type.starts_with("image/") || data.is_empty() {
        return None;
    }

    // 校验 base64 内容合法性。非法的 base64 会导致上游 API 直接拒绝请求
    // （例如 "Invalid 'input[0].content[1].image_url' ... invalid base64-encoded value"）。
    // 这里与上游使用相同的标准解码器提前拦截，避免把脏数据发到视觉模型。
    if base64::engine::general_purpose::STANDARD
        .decode(data)
        .is_err()
    {
        return None;
    }

    Some(ChatImage {
        media_type: media_type.to_string(),
        data: data.to_string(),
        data_url: value.to_string(),
        source: None,
    })
}

/// If the image tag value refers to an SVG (either inline data URL or file path),
/// decode/read it and return the raw SVG source text. Returns None for non-SVG.
fn try_extract_svg_source(value: &str, database_path: &Path) -> Option<String> {
    let value = value.trim();

    // Case 1: inline data URL — data:image/svg+xml;base64,...
    if value.starts_with("data:") {
        let (metadata, data) = value.strip_prefix("data:")?.split_once(',')?;
        let media_type = metadata.strip_suffix(";base64")?.trim();
        if media_type != "image/svg+xml" {
            return None;
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data.trim())
            .ok()?;
        return String::from_utf8(bytes).ok();
    }

    // Case 2: relative file path ending in .svg
    if value.is_empty() || value.contains('{') || !value.contains('/') {
        return None;
    }
    let file_path = database_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(value);
    if file_path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_lowercase)
        .as_deref()
        != Some("svg")
    {
        return None;
    }
    fs::read_to_string(&file_path).ok()
}

pub fn persist_inline_images_to_disk(content: &str, database_path: &Path) -> Result<String> {
    const IMAGE_TAG_PREFIX: &str = "@@image:";

    let upload_root = resolve_upload_root(database_path)?;
    let date = chrono::Local::now().format("%Y-%m-%d").to_string();
    let date_dir = upload_root.join(&date);

    let mut result = String::with_capacity(content.len());
    let mut remaining = content;

    while let Some(tag_start) = remaining.find(IMAGE_TAG_PREFIX) {
        result.push_str(&remaining[..tag_start]);

        let tag_value_start = tag_start + IMAGE_TAG_PREFIX.len();
        let tag_value_and_rest = &remaining[tag_value_start..];
        let Some(tag_end) = tag_value_and_rest.find("@@") else {
            result.push_str(&remaining[tag_start..]);
            return Ok(result);
        };

        let data_url = &tag_value_and_rest[..tag_end];
        let full_tag_end = tag_value_start + tag_end + 2;
        if let Some(image_path) = persist_base64_image(data_url, &date_dir)? {
            result.push_str(&format!("@@image:{}@@", image_path));
        } else {
            result.push_str(&remaining[tag_start..full_tag_end]);
        }

        remaining = &remaining[full_tag_end..];
    }

    result.push_str(remaining);
    Ok(result)
}

fn resolve_upload_root(database_path: &Path) -> Result<PathBuf> {
    let parent = database_path.parent().unwrap_or_else(|| Path::new("."));
    Ok(parent.join("upload"))
}

fn persist_base64_image(data_url: &str, date_dir: &Path) -> Result<Option<String>> {
    let value = data_url.trim();
    let (metadata, data) = match value.strip_prefix("data:").and_then(|v| v.split_once(',')) {
        Some(parts) => parts,
        None => return Ok(None),
    };
    let media_type = match metadata.strip_suffix(";base64") {
        Some(media_type) => media_type.trim(),
        None => return Ok(None),
    };
    if media_type.len() <= "image/".len()
        || !media_type.starts_with("image/")
        || data.trim().is_empty()
    {
        return Ok(None);
    }

    let decoded = match base64::engine::general_purpose::STANDARD.decode(data.trim()) {
        Ok(bytes) => bytes,
        Err(_) => return Ok(None),
    };
    if decoded.is_empty() {
        return Ok(None);
    }

    fs::create_dir_all(date_dir).map_err(|error| {
        Error::from_reason(format!(
            "Failed to create upload directory '{}': {}",
            date_dir.display(),
            error
        ))
    })?;

    let hash = blake3::hash(&decoded).to_hex().to_string();
    let ext = media_type_to_extension(media_type);
    let filename = format!("{}.{}", hash, ext);
    let file_path = date_dir.join(&filename);

    if !file_path.exists() {
        let mut file = fs::File::create(&file_path).map_err(|error| {
            Error::from_reason(format!(
                "Failed to create image file '{}': {}",
                file_path.display(),
                error
            ))
        })?;
        file.write_all(&decoded).map_err(|error| {
            Error::from_reason(format!(
                "Failed to write image file '{}': {}",
                file_path.display(),
                error
            ))
        })?;
    }

    let relative = Path::new("upload")
        .join(date_dir.file_name().unwrap_or_default())
        .join(&filename);
    Ok(Some(relative.to_string_lossy().replace('\\', "/")))
}

/// 将消息内容中以相对路径（如 `upload/2026-07-25/hash.png`）引用的
/// 内联图片重新读取为 data URL。
///
/// 发送消息时 base64 图片会被持久化到磁盘，内容里只保留相对路径以节省
/// 数据库体积。但渲染进程无法直接访问该相对路径（浏览器会按页面 base URL
/// 解析，导致 ERR_FILE_NOT_FOUND），因此加载历史消息时需把相对路径还原为
/// data URL，前端才能正常显示与预览。
///
/// 已是 data URL 的标签原样保留；无法读取的相对路径也原样保留，避免破坏内容。
pub fn resolve_inline_images_from_disk(content: &str, database_path: &Path) -> String {
    const IMAGE_TAG_PREFIX: &str = "@@image:";

    let mut result = String::with_capacity(content.len());
    let mut remaining = content;

    while let Some(tag_start) = remaining.find(IMAGE_TAG_PREFIX) {
        result.push_str(&remaining[..tag_start]);

        let tag_value_start = tag_start + IMAGE_TAG_PREFIX.len();
        let tag_value_and_rest = &remaining[tag_value_start..];
        let Some(tag_end) = tag_value_and_rest.find("@@") else {
            result.push_str(&remaining[tag_start..]);
            return result;
        };

        let value = &tag_value_and_rest[..tag_end];
        let full_tag_end = tag_value_start + tag_end + 2;

        if value.trim().starts_with("data:") {
            result.push_str(&remaining[tag_start..full_tag_end]);
        } else if let Some(image) = parse_image_tag_value(value, database_path).unwrap_or(None) {
            result.push_str(&format!("@@image:{}@@", image.data_url));
        } else {
            result.push_str(&remaining[tag_start..full_tag_end]);
        }

        remaining = &remaining[full_tag_end..];
    }

    result.push_str(remaining);
    result
}

fn media_type_to_extension(media_type: &str) -> &str {
    match media_type {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        "image/svg+xml" => "svg",
        _ => "bin",
    }
}

fn extension_to_media_type(path: &Path) -> String {
    match path.extension().and_then(|ext| ext.to_str()) {
        Some("png") => "image/png".to_string(),
        Some("jpg") | Some("jpeg") => "image/jpeg".to_string(),
        Some("gif") => "image/gif".to_string(),
        Some("webp") => "image/webp".to_string(),
        Some("bmp") => "image/bmp".to_string(),
        Some("svg") => "image/svg+xml".to_string(),
        _ => "application/octet-stream".to_string(),
    }
}
