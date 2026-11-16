//! 浏览器脚本 source map 解析与脚本文本搜索。
//!
//! 纯计算模块：调用方负责放进阻塞线程池。行列号一律 0 起，列按 UTF-16 计。

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use base64::alphabet;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use base64::Engine;
use regex::{Regex, RegexBuilder};
use sourcemap::DecodedMap;

const MAX_MAP_BYTES: usize = 96 * 1024 * 1024;
const SHORT_LINE_BYTES: usize = 240;
const SNIPPET_BEFORE_CHARS: usize = 80;
const SNIPPET_AFTER_CHARS: usize = 160;

/// (原始行, 原始列, 生成行, 生成列)，按此顺序排序。
type Mapping = (u32, u32, u32, u32);

struct LoadedMap {
    contents: Vec<Option<String>>,
    mappings: Vec<Vec<Mapping>>,
}

pub struct ResolvedLocation {
    pub source_line: u32,
    pub source_column: u32,
    pub generated_line: u32,
    pub generated_column: u32,
}

pub struct TextMatch {
    pub source_index: Option<u32>,
    pub line: u32,
    pub column: u32,
    pub snippet: String,
}

fn maps() -> &'static Mutex<HashMap<String, Arc<LoadedMap>>> {
    static MAPS: OnceLock<Mutex<HashMap<String, Arc<LoadedMap>>>> = OnceLock::new();
    MAPS.get_or_init(Default::default)
}

fn loaded(key: &str) -> Result<Arc<LoadedMap>, String> {
    maps()
        .lock()
        .map_err(|_| "source map cache is poisoned".to_string())?
        .get(key)
        .cloned()
        .ok_or_else(|| "source map is not loaded".to_string())
}

/// 支持直接的 JSON 文本，也支持 `data:` URL（base64 或百分号编码）。
fn decode_payload(content: String) -> Result<Vec<u8>, String> {
    let trimmed = content.trim_start();
    if !trimmed.starts_with("data:") {
        return Ok(content.into_bytes());
    }
    let (meta, data) = trimmed[5..]
        .split_once(',')
        .ok_or_else(|| "invalid source map data URL".to_string())?;
    let decoded: Vec<u8> = percent_encoding::percent_decode_str(data).collect();
    if !meta.to_ascii_lowercase().ends_with(";base64") {
        return Ok(decoded);
    }
    let compact: Vec<u8> = decoded
        .into_iter()
        .filter(|byte| !byte.is_ascii_whitespace())
        .collect();
    let engine = GeneralPurpose::new(
        &alphabet::STANDARD,
        GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent),
    );
    engine
        .decode(compact)
        .map_err(|error| format!("invalid base64 source map: {error}"))
}

/// 解析并缓存 source map，返回 sources 列表（已应用 sourceRoot）。
pub fn load(key: &str, content: String) -> Result<Vec<String>, String> {
    let bytes = decode_payload(content)?;
    if bytes.len() > MAX_MAP_BYTES {
        return Err("source map is too large".to_string());
    }
    let decoded = sourcemap::decode_slice(&bytes)
        .map_err(|error| format!("invalid source map: {error}"))?;
    let map = match decoded {
        DecodedMap::Regular(map) => map,
        DecodedMap::Index(index) => index
            .flatten()
            .map_err(|error| format!("invalid indexed source map: {error}"))?,
        DecodedMap::Hermes(_) => {
            return Err("Hermes source maps are not supported".to_string());
        }
    };
    let count = map.get_source_count();
    let sources: Vec<String> = (0..count)
        .map(|index| map.get_source(index).unwrap_or_default().to_string())
        .collect();
    let contents: Vec<Option<String>> = (0..count)
        .map(|index| map.get_source_contents(index).map(str::to_string))
        .collect();
    let mut mappings: Vec<Vec<Mapping>> = vec![Vec::new(); count as usize];
    for token in map.tokens() {
        if !token.has_source() {
            continue;
        }
        if let Some(list) = mappings.get_mut(token.get_src_id() as usize) {
            list.push((
                token.get_src_line(),
                token.get_src_col(),
                token.get_dst_line(),
                token.get_dst_col(),
            ));
        }
    }
    for list in &mut mappings {
        list.sort_unstable();
        list.dedup();
    }
    maps()
        .lock()
        .map_err(|_| "source map cache is poisoned".to_string())?
        .insert(key.to_string(), Arc::new(LoadedMap { contents, mappings }));
    Ok(sources)
}

/// 原始位置 -> 生成位置：取该位置或其后的第一个映射（无可执行代码的行顺延）。
pub fn resolve(
    key: &str,
    source_index: u32,
    line: u32,
    column: Option<u32>,
) -> Result<Option<ResolvedLocation>, String> {
    let map = loaded(key)?;
    let list = map
        .mappings
        .get(source_index as usize)
        .ok_or_else(|| "source index is out of range".to_string())?;
    let wanted = (line, column.unwrap_or(0));
    let start = list.partition_point(|mapping| (mapping.0, mapping.1) < wanted);
    Ok(list.get(start).map(|mapping| ResolvedLocation {
        source_line: mapping.0,
        source_column: mapping.1,
        generated_line: mapping.2,
        generated_column: mapping.3,
    }))
}

/// 释放 key 以 prefix 开头的缓存。
pub fn release(prefix: &str) {
    if let Ok(mut guard) = maps().lock() {
        guard.retain(|key, _| !key.starts_with(prefix));
    }
}

fn build_regex(query: &str, is_regex: bool, case_sensitive: bool) -> Result<Regex, String> {
    if query.is_empty() {
        return Err("query must not be empty".to_string());
    }
    let pattern = if is_regex {
        query.to_string()
    } else {
        regex::escape(query)
    };
    RegexBuilder::new(&pattern)
        .case_insensitive(!case_sensitive)
        .build()
        .map_err(|error| format!("invalid search pattern: {error}"))
}

fn step_back(content: &str, from: usize, min: usize, chars: usize) -> usize {
    let mut index = from;
    let mut moved = 0;
    while index > min && moved < chars {
        index -= 1;
        while index > min && !content.is_char_boundary(index) {
            index -= 1;
        }
        moved += 1;
    }
    index
}

fn step_forward(content: &str, from: usize, max: usize, chars: usize) -> usize {
    let mut index = from;
    let mut moved = 0;
    while index < max && moved < chars {
        index += 1;
        while index < max && !content.is_char_boundary(index) {
            index += 1;
        }
        moved += 1;
    }
    index
}

/// 短行返回整行，长行（压缩代码）只截取命中点附近的窗口。
fn snippet(content: &str, line_start: usize, line_end: usize, at: usize) -> String {
    let line = &content[line_start..line_end];
    if line.len() <= SHORT_LINE_BYTES {
        return line.trim().to_string();
    }
    let start = step_back(content, at, line_start, SNIPPET_BEFORE_CHARS);
    let end = step_forward(content, at, line_end, SNIPPET_AFTER_CHARS);
    let mut text = String::new();
    if start > line_start {
        text.push_str("...");
    }
    text.push_str(&content[start..end]);
    if end < line_end {
        text.push_str("...");
    }
    text
}

fn search_into(
    content: &str,
    regex: &Regex,
    limit: usize,
    source_index: Option<u32>,
    out: &mut Vec<TextMatch>,
) {
    let bytes = content.as_bytes();
    let mut line = 0u32;
    let mut line_start = 0usize;
    let mut scanned = 0usize;
    for found in regex.find_iter(content) {
        if out.len() >= limit {
            break;
        }
        if found.start() == found.end() {
            continue;
        }
        for (offset, byte) in bytes[scanned..found.start()].iter().enumerate() {
            if *byte == b'\n' {
                line += 1;
                line_start = scanned + offset + 1;
            }
        }
        scanned = found.start();
        let mut line_end = bytes[found.start()..]
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(bytes.len(), |position| found.start() + position);
        if line_end > line_start && bytes[line_end - 1] == b'\r' {
            line_end -= 1;
        }
        let line_end = line_end.max(found.start());
        let column = content[line_start..found.start()].encode_utf16().count() as u32;
        out.push(TextMatch {
            source_index,
            line,
            column,
            snippet: snippet(content, line_start, line_end, found.start()),
        });
    }
}

/// 在一段脚本文本里搜索。
pub fn search_text(
    content: &str,
    query: &str,
    is_regex: bool,
    case_sensitive: bool,
    limit: usize,
) -> Result<Vec<TextMatch>, String> {
    let regex = build_regex(query, is_regex, case_sensitive)?;
    let mut out = Vec::new();
    search_into(content, &regex, limit, None, &mut out);
    Ok(out)
}

/// 在已加载 source map 的 sourcesContent 里搜索；source_indexes 为空表示全部。
pub fn search_map(
    key: &str,
    query: &str,
    is_regex: bool,
    case_sensitive: bool,
    limit: usize,
    source_indexes: Option<&[u32]>,
) -> Result<Vec<TextMatch>, String> {
    let map = loaded(key)?;
    let regex = build_regex(query, is_regex, case_sensitive)?;
    let mut out = Vec::new();
    for (index, content) in map.contents.iter().enumerate() {
        if out.len() >= limit {
            break;
        }
        let index = index as u32;
        if source_indexes.is_some_and(|allowed| !allowed.contains(&index)) {
            continue;
        }
        if let Some(content) = content {
            search_into(content, &regex, limit, Some(index), &mut out);
        }
    }
    Ok(out)
}

/// 每个 source 是否带有 sourcesContent。
pub fn content_flags(key: &str) -> Result<Vec<bool>, String> {
    Ok(loaded(key)?
        .contents
        .iter()
        .map(Option::is_some)
        .collect())
}
