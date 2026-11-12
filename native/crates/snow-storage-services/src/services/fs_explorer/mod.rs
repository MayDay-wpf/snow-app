use std::fs;
use std::path::Path;

use napi::bindgen_prelude::*;
use napi_derive::napi;

use snow_text::office::{
    extract_office_document_text, office_document_kind, OfficeDocKind,
};
use snow_text::text_codec::{
    decode_text_bytes, encode_text_back, DecodedText,
};

const MAX_DOCUMENT_INPUT_BYTES: u64 = 20 * 1024 * 1024;
const MAX_DOCUMENT_TEXT_BYTES: usize = 2 * 1024 * 1024;
const MAX_RAW_TEXT_READ_BYTES: u64 = 64 * 1024 * 1024;

mod browse;
mod link;
mod mutate;
mod preview;
mod search;

pub use self::browse::*;
pub use self::link::*;
pub use self::mutate::*;
pub use self::preview::*;
pub use self::search::*;

#[napi(object)]
pub struct DirectoryEntry {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
    pub size: i64,
}

#[napi(object)]
pub struct FileContentResult {
    pub content: String,
    pub is_binary: bool,
    pub is_image: bool,
    pub is_svg: bool,
    pub mime_type: String,
    pub encoding: String,
    pub size: i64,
}

const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "bmp", "webp", "ico", "svg"];

const MIME_TYPES: &[(&str, &str)] = &[
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("bmp", "image/bmp"),
    ("webp", "image/webp"),
    ("ico", "image/x-icon"),
    ("svg", "image/svg+xml"),
];

fn get_mime_type(ext: &str) -> String {
    for (e, mime) in MIME_TYPES {
        if *e == ext {
            return mime.to_string();
        }
    }
    "application/octet-stream".to_string()
}

pub fn process_file_content(file_path: &str, buffer: Vec<u8>) -> FileContentResult {
    let ext = Path::new(file_path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();

    let is_svg = ext == "svg";
    let is_image = IMAGE_EXTENSIONS.contains(&ext.as_str());
    let size = buffer.len() as i64;

    if is_svg {
        return FileContentResult {
            content: String::from_utf8_lossy(&buffer).into_owned(),
            is_binary: false,
            is_image: true,
            is_svg: true,
            mime_type: "image/svg+xml".to_string(),
            encoding: "utf8".to_string(),
            size,
        };
    }

    if is_image {
        return FileContentResult {
            content: base64_encode(&buffer),
            is_binary: true,
            is_image: true,
            is_svg: false,
            mime_type: get_mime_type(&ext),
            encoding: "base64".to_string(),
            size,
        };
    }

    let check_len = buffer.len().min(8192);
    let is_binary = buffer[..check_len].iter().any(|&b| b == 0);

    if is_binary {
        return FileContentResult {
            content: base64_encode(&buffer),
            is_binary: true,
            is_image: false,
            is_svg: false,
            mime_type: "application/octet-stream".to_string(),
            encoding: "base64".to_string(),
            size,
        };
    }

    FileContentResult {
        content: String::from_utf8_lossy(&buffer).into_owned(),
        is_binary: false,
        is_image: false,
        is_svg: false,
        mime_type: "text/plain".to_string(),
        encoding: "utf8".to_string(),
        size,
    }
}

fn base64_encode(data: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::with_capacity((data.len() + 2) / 3 * 4);

    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };

        let triple = (b0 << 16) | (b1 << 8) | b2;

        result.push(CHARS[((triple >> 18) & 0x3F) as usize] as char);
        result.push(CHARS[((triple >> 12) & 0x3F) as usize] as char);

        if chunk.len() > 1 {
            result.push(CHARS[((triple >> 6) & 0x3F) as usize] as char);
        } else {
            result.push('=');
        }

        if chunk.len() > 2 {
            result.push(CHARS[(triple & 0x3F) as usize] as char);
        } else {
            result.push('=');
        }
    }

    result
}

pub fn read_file_content(file_path: &str) -> Result<FileContentResult> {
    let path = Path::new(file_path);

    if !path.exists() {
        return Err(Error::from_reason(format!(
            "File does not exist: {}",
            file_path
        )));
    }

    if !path.is_file() {
        return Err(Error::from_reason(format!(
            "Path is not a file: {}",
            file_path
        )));
    }

    if let Some(kind) = preview_document_kind(path) {
        let size = fs::metadata(path)
            .map_err(|e| {
                Error::from_reason(format!("Failed to inspect file '{}': {}", file_path, e))
            })?
            .len();
        if size > MAX_DOCUMENT_INPUT_BYTES {
            return Err(Error::from_reason(format!(
                "Document exceeds the 20 MiB preview input limit: {} bytes",
                size
            )));
        }
        let content = extract_office_document_text(path, kind)?;
        if content.len() > MAX_DOCUMENT_TEXT_BYTES {
            return Err(Error::from_reason(format!(
                "Extracted document text exceeds the 2 MiB preview limit: {} bytes",
                content.len()
            )));
        }
        return Ok(FileContentResult {
            content,
            is_binary: false,
            is_image: false,
            is_svg: false,
            mime_type: "application/x-snow-document-text".to_string(),
            encoding: "utf8".to_string(),
            size: size as i64,
        });
    }

    let metadata = fs::metadata(path)
        .map_err(|e| Error::from_reason(format!("Failed to inspect file '{}': {}", file_path, e)))?;
    if metadata.len() > MAX_RAW_TEXT_READ_BYTES {
        return Err(Error::from_reason(format!(
            "File exceeds the 64 MiB text preview limit: {} bytes",
            metadata.len()
        )));
    }

    let buffer = fs::read(path)
        .map_err(|e| Error::from_reason(format!("Failed to read file '{}': {}", file_path, e)))?;
    let ext = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_lowercase();
    if IMAGE_EXTENSIONS.contains(&ext.as_str()) && ext != "svg" {
        return Ok(process_file_content(file_path, buffer));
    }
    let size = buffer.len() as i64;
    match decode_local_text(&buffer) {
        Ok(decoded) => {
            // 对占 99% 的 UTF-8 文本直接进行切片比对，避免大文件全量重新编码与内存放大
            let can_write_losslessly = if decoded.encoding == encoding_rs::UTF_8 {
                if decoded.had_bom {
                    buffer.starts_with(&[0xEF, 0xBB, 0xBF])
                        && decoded.text.as_bytes() == &buffer[3..]
                } else {
                    decoded.text.as_bytes() == buffer.as_slice()
                }
            } else {
                encode_text_back(&decoded.text, decoded.encoding, decoded.had_bom)
                    .is_ok_and(|bytes| bytes == buffer)
            };
            Ok(FileContentResult {
                content: decoded.text,
                is_binary: false,
                is_image: ext == "svg",
                is_svg: ext == "svg",
                mime_type: if ext == "svg" {
                    "image/svg+xml"
                } else if can_write_losslessly {
                    "text/plain"
                } else {
                    "application/x-snow-text-preview"
                }
                .to_string(),
                encoding: "utf8".to_string(),
                size,
            })
        }
        Err(_) => Ok(FileContentResult {
            content: base64_encode(&buffer),
            is_binary: true,
            is_image: false,
            is_svg: false,
            mime_type: "application/octet-stream".to_string(),
            encoding: "base64".to_string(),
            size,
        }),
    }
}

// CSV is editable text, not an extracted document in the local preview.
fn preview_document_kind(path: &Path) -> Option<OfficeDocKind> {
    office_document_kind(path).filter(|kind| !matches!(kind, OfficeDocKind::Csv))
}

fn decode_local_text(buffer: &[u8]) -> std::result::Result<DecodedText, String> {
    // The shared codec's UTF-32 label lookup is unsupported by encoding_rs.
    // Avoid its panic and preserve these files as binary/read-only.
    if buffer.starts_with(&[0xFF, 0xFE, 0x00, 0x00])
        || buffer.starts_with(&[0x00, 0x00, 0xFE, 0xFF])
    {
        return Err("UTF-32 is not supported by the text codec".to_string());
    }
    let decoded = decode_text_bytes(buffer)?;
    // The shared codec skips binary statistics for short files. NUL is never
    // valid preview text, including short binary payloads; UTF-16 is decoded first.
    if decoded.text.contains('\0') {
        return Err("Binary content detected".to_string());
    }
    Ok(decoded)
}

/// Write text content to a file, creating it (and parent directories) if missing.
pub fn write_file_content(file_path: &str, content: &str) -> Result<()> {
    let path = Path::new(file_path);
    let bytes = if path.exists() {
        if preview_document_kind(path).is_some() {
            return Err(Error::from_reason("Document previews are read-only"));
        }
        let original = fs::read(path).map_err(|e| {
            Error::from_reason(format!(
                "Failed to read existing file '{}': {}",
                file_path, e
            ))
        })?;
        let ext = path
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or_default()
            .to_lowercase();
        if IMAGE_EXTENSIONS.contains(&ext.as_str()) && ext != "svg" {
            return Err(Error::from_reason("Binary image files are read-only"));
        }
        let decoded = decode_local_text(&original).map_err(|e| {
            Error::from_reason(format!(
                "Cannot overwrite non-text file '{}': {}",
                file_path, e
            ))
        })?;
        // Require a lossless round trip before overwriting. In particular,
        // encoding_rs cannot encode UTF-16 back, so those files remain read-only.
        let round_trip = encode_text_back(&decoded.text, decoded.encoding, decoded.had_bom)
            .map_err(Error::from_reason)?;
        if round_trip != original {
            return Err(Error::from_reason(format!(
                "File is read-only because its original {} encoding cannot be preserved losslessly",
                decoded.encoding.name()
            )));
        }
        encode_text_back(content, decoded.encoding, decoded.had_bom).map_err(Error::from_reason)?
    } else {
        content.as_bytes().to_vec()
    };

    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| {
                Error::from_reason(format!(
                    "Failed to create parent directories for '{}': {}",
                    file_path, e
                ))
            })?;
        }
    }

    fs::write(path, bytes)
        .map_err(|e| Error::from_reason(format!("Failed to write file '{}': {}", file_path, e)))
}
