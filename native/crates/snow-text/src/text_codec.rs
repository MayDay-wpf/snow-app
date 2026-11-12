//! 文本编码检测与转码。
//!
//! 读取方向（decode_text_bytes）：优先按 BOM 判定编码（UTF-8/16/32），
//! 无 BOM 时用 chardetng 统计推断（覆盖 GBK/GB18030/Big5/Shift_JIS/EUC-KR
//! 等常见编码），统一解码为 UTF-8 字符串；解码后通过控制字符/替换字符占比
//! 识别二进制文件并报错，保持对二进制内容的一贯拒绝行为。
//!
//! 写入方向（encode_text_back）：按检测到的原始编码将 UTF-8 文本编码回字节，
//! 并还原文件原有的 BOM；当文本含有该编码无法表示的字符（如 GBK 写 emoji）
//! 时报错，避免静默数据损坏。
//!
//! 注意：本模块的函数都是同步的 CPU/IO 密集型操作，调用方必须保证其运行在
//! tokio 的阻塞线程池中（内置 MCP 工具统一经 tokio::task::spawn_blocking 调度）。

use encoding_rs::{Encoding, UTF_16BE, UTF_16LE, UTF_8};

/// encoding_rs 未提供 UTF-32 的静态编码常量，经 WHATWG label 解析（必然成功）。
fn encoding_utf_32_le() -> &'static Encoding {
    Encoding::for_label(b"utf-32le").expect("utf-32le is a valid WHATWG label")
}

/// 同 encoding_utf_32_le，UTF-32BE 版本。
fn encoding_utf_32_be() -> &'static Encoding {
    Encoding::for_label(b"utf-32be").expect("utf-32be is a valid WHATWG label")
}

/// 解码后字符数达到该值才做二进制判定，小文件（如几个字节的短文本）
/// 不做占比统计，避免误判。
const BINARY_CHECK_MIN_CHARS: usize = 64;

/// 解码后控制字符（除 \n \r \t）占比超过该比例视为二进制文件。
const MAX_CONTROL_CHAR_RATIO: f64 = 0.05;

/// 解码后 U+FFFD 替换字符占比超过该比例视为二进制文件（编码误判的典型症状）。
const MAX_REPLACEMENT_CHAR_RATIO: f64 = 0.02;

/// 解码结果：UTF-8 文本 + 原始编码 + 是否带 BOM。
pub struct DecodedText {
    pub text: String,
    pub encoding: &'static Encoding,
    pub had_bom: bool,
}

/// 检测文件编码并解码为 UTF-8 文本。
///
/// 返回 Err 表示内容不是受支持编码的文本（二进制文件）。
pub fn decode_text_bytes(bytes: &[u8]) -> Result<DecodedText, String> {
    let (encoding, had_bom) = detect_encoding(bytes);
    let (text, _, _) = encoding.decode(bytes);

    if looks_like_binary(&text) {
        return Err(
            "not a text file in a supported encoding (binary content detected)".to_string(),
        );
    }

    Ok(DecodedText {
        text: text.into_owned(),
        encoding,
        had_bom,
    })
}

/// 将 UTF-8 文本按指定编码编码为字节（新建文件使用，不还原 BOM）。
///
/// 存在无法用该编码表示的字符时返回 Err。
pub fn encode_text(text: &str, encoding: &'static Encoding) -> Result<Vec<u8>, String> {
    let (bytes, _, had_errors) = encoding.encode(text);
    if had_errors {
        return Err(format!(
            "some characters cannot be represented in encoding \"{}\"",
            encoding.name()
        ));
    }
    Ok(bytes.into_owned())
}

/// 将 UTF-8 文本按文件原始编码编码回字节，并还原文件原有的 BOM。
///
/// 存在无法用该编码表示的字符时返回 Err。
pub fn encode_text_back(
    text: &str,
    encoding: &'static Encoding,
    had_bom: bool,
) -> Result<Vec<u8>, String> {
    let mut bytes = encode_text(text, encoding)?;

    if had_bom {
        if let Some(bom) = bom_bytes(encoding) {
            let mut with_bom = Vec::with_capacity(bytes.len() + bom.len());
            with_bom.extend_from_slice(bom);
            with_bom.append(&mut bytes);
            bytes = with_bom;
        }
    }

    Ok(bytes)
}

/// 解析用户提供的编码 label（如 "utf-8"、"gbk"、"gb18030"、"big5"、
/// "shift_jis"、"euc-kr"、"utf-16le"、"windows-1252"），无效时返回 None。
pub fn encoding_for_label(label: &str) -> Option<&'static Encoding> {
    Encoding::for_label(label.trim().to_ascii_lowercase().as_bytes())
}

/// 检测编码：BOM 优先，其次 chardetng 统计推断。
/// 返回 (编码, 是否带 BOM)。
fn detect_encoding(bytes: &[u8]) -> (&'static Encoding, bool) {
    if let Some(encoding) = encoding_from_bom(bytes) {
        return (encoding, true);
    }

    let mut detector = chardetng::EncodingDetector::new();
    detector.feed(bytes, true);
    // allow_utf8=true：数据本身是合法 UTF-8 时直接返回 UTF-8，
    // 避免 ASCII/UTF-8 文件被统计推断误判为其他编码。
    let encoding = detector.guess(None, true);
    (encoding, false)
}

/// 依据 BOM 前缀判定编码。注意 UTF-32LE 的 BOM（FF FE 00 00）
/// 必须以 FF FE 开头，需在 UTF-16LE 之前判断。
fn encoding_from_bom(bytes: &[u8]) -> Option<&'static Encoding> {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        Some(UTF_8)
    } else if bytes.starts_with(&[0xFF, 0xFE, 0x00, 0x00]) {
        Some(encoding_utf_32_le())
    } else if bytes.starts_with(&[0x00, 0x00, 0xFE, 0xFF]) {
        Some(encoding_utf_32_be())
    } else if bytes.starts_with(&[0xFF, 0xFE]) {
        Some(UTF_16LE)
    } else if bytes.starts_with(&[0xFE, 0xFF]) {
        Some(UTF_16BE)
    } else {
        None
    }
}

/// 解码后文本中控制字符（除 \n \r \t）或 U+FFFD 替换字符占比过高时视为二进制。
fn looks_like_binary(text: &str) -> bool {
    let total = text.chars().count();
    if total < BINARY_CHECK_MIN_CHARS {
        return false;
    }

    let mut control_count = 0usize;
    let mut replacement_count = 0usize;
    for ch in text.chars() {
        match ch {
            '\u{FFFD}' => replacement_count += 1,
            c if c.is_control() && c != '\n' && c != '\r' && c != '\t' => control_count += 1,
            _ => {}
        }
    }

    control_count as f64 / total as f64 > MAX_CONTROL_CHAR_RATIO
        || replacement_count as f64 / total as f64 > MAX_REPLACEMENT_CHAR_RATIO
}

/// 各编码的 BOM 字节（无 BOM 概念的编码返回 None）。
fn bom_bytes(encoding: &'static Encoding) -> Option<&'static [u8]> {
    if encoding == UTF_8 {
        Some(&[0xEF, 0xBB, 0xBF])
    } else if encoding == UTF_16LE {
        Some(&[0xFF, 0xFE])
    } else if encoding == UTF_16BE {
        Some(&[0xFE, 0xFF])
    } else if encoding == encoding_utf_32_le() {
        Some(&[0xFF, 0xFE, 0x00, 0x00])
    } else if encoding == encoding_utf_32_be() {
        Some(&[0x00, 0x00, 0xFE, 0xFF])
    } else {
        None
    }
}
