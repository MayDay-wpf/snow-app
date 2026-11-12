use super::*;

use std::fs;
use std::path::Path;

use serde_json::{json, Value};

use super::office::{extract_office_document_text, office_document_kind};
use super::text_codec::decode_text_bytes;

use crate::utils::paths::expand_home_dir;

pub(crate) fn normalize_path(path: &str) -> String {
    let mut normalized = path.trim().to_string();
    normalized = normalized.replace('\0', "");
    if normalized.starts_with('\u{FEFF}') {
        normalized = normalized.trim_start_matches('\u{FEFF}').to_string();
    }
    expand_home_dir(&normalized)
}

pub(crate) fn read_path(
    file_path: &str,
    start_line: Option<u64>,
    end_line: Option<u64>,
) -> napi::Result<Value> {
    let file_path = normalize_path(file_path);

    if file_path.is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            "filePath must be a non-empty string for tool \"filesystem-read\".".to_string(),
        ));
    }

    let path = Path::new(&file_path);

    if path.is_dir() {
        let entries = fs::read_dir(path).map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to read directory: {} (path: {})", error, file_path),
            )
        })?;

        let mut items: Vec<String> = Vec::new();
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let prefix = if entry.path().is_dir() { "/" } else { "" };
            items.push(format!("{}{}", name, prefix));
        }
        items.sort();

        return Ok(json!({
            "content": items.join("\n")
        }));
    }

    if is_image_file(path) {
        let data_url = read_image_as_data_url(path)?;
        return Ok(json!({
            "content": format!("@@image:{}@@", data_url),
            "mediaType": image_media_type(path),
            "isImage": true
        }));
    }

    let content = if let Some(kind) = office_document_kind(path) {
        extract_office_document_text(path, kind)?
    } else {
        // 字节读取 + 自动编码检测（BOM/chardetng），统一解码为 UTF-8。
        let bytes = fs::read(path).map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to read file: {} (path: {})", error, file_path),
            )
        })?;
        decode_text_bytes(&bytes)
            .map_err(|error| {
                Error::new(
                    Status::GenericFailure,
                    format!(
                        "Failed to decode file as text: {} (path: {})",
                        error, file_path
                    ),
                )
            })?
            .text
    };

    Ok(format_numbered_lines(&content, start_line, end_line))
}

fn is_image_file(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|ext| ext.to_str())
            .map(str::to_lowercase)
            .as_deref(),
        Some("png") | Some("jpg") | Some("jpeg") | Some("gif") | Some("webp") | Some("bmp")
    )
}

fn image_media_type(path: &Path) -> String {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_lowercase)
        .as_deref()
    {
        Some("png") => "image/png".to_string(),
        Some("jpg") | Some("jpeg") => "image/jpeg".to_string(),
        Some("gif") => "image/gif".to_string(),
        Some("webp") => "image/webp".to_string(),
        Some("bmp") => "image/bmp".to_string(),
        _ => "application/octet-stream".to_string(),
    }
}

fn read_image_as_data_url(path: &Path) -> napi::Result<String> {
    let bytes = fs::read(path).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to read image file: {}", e),
        )
    })?;

    if bytes.is_empty() {
        return Err(Error::new(
            Status::GenericFailure,
            "Image file is empty".to_string(),
        ));
    }

    let media_type = image_media_type(path);
    let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", media_type, data))
}

/// 将文本内容按行号范围分页，返回带行号前缀的内容。
/// 文本文件与 Office 文档提取出的文本共用该逻辑。
fn format_numbered_lines(content: &str, start_line: Option<u64>, end_line: Option<u64>) -> Value {
    let lines: Vec<&str> = content.lines().collect();
    let total_lines = lines.len();

    // 当 startLine 与 endLine 同时存在且 startLine > endLine 时自动交换两者，
    // 纠正 AI 误传的逆序行号区间，避免后续切片 [start..end] 因 start > end 而 panic。
    let (start_line, end_line) = match (start_line, end_line) {
        (Some(s), Some(e)) if s > e => (Some(e), Some(s)),
        other => other,
    };

    let start = start_line
        .map(|line| line as usize)
        .unwrap_or(1)
        .saturating_sub(1);
    let end = end_line
        .map(|line| line as usize)
        .unwrap_or(total_lines)
        .min(total_lines);

    if start >= total_lines {
        return json!({
            "content": "",
            "totalLines": total_lines
        });
    }

    let selected: Vec<String> = lines[start..end]
        .iter()
        .enumerate()
        .map(|(index, line)| format!("{:>6}: {}", start + index + 1, line))
        .collect();

    json!({
        "content": selected.join("\n"),
        "totalLines": total_lines,
        "startLine": start + 1,
        "endLine": end
    })
}
