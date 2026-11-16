//! 浏览器脚本 source map 与脚本文本搜索的 NAPI 导出。
//!
//! 供主进程的日志断点使用：解析 source map、把原始源码位置换算成生成位置、
//! 在脚本与原始源码里搜索。全部计算在 spawn_blocking 中执行。

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::mcp::servers::browser::source_map;

/// 行列号均为 0 起，列按 UTF-16 计。
#[napi(object)]
pub struct BrowserSourceMapLocation {
    pub source_line: u32,
    pub source_column: u32,
    pub generated_line: u32,
    pub generated_column: u32,
}

#[napi(object)]
pub struct BrowserScriptTextMatch {
    /// source map 搜索时为 sources 下标；脚本文本搜索时为空。
    pub source_index: Option<u32>,
    pub line: u32,
    pub column: u32,
    pub snippet: String,
}

fn map_spawn_error(error: tokio::task::JoinError) -> Error {
    Error::new(
        Status::GenericFailure,
        format!("Spawned blocking task failed: {error}"),
    )
}

fn invalid(message: String) -> Error {
    Error::new(Status::InvalidArg, message)
}

fn to_matches(found: Vec<source_map::TextMatch>) -> Vec<BrowserScriptTextMatch> {
    found
        .into_iter()
        .map(|item| BrowserScriptTextMatch {
            source_index: item.source_index,
            line: item.line,
            column: item.column,
            snippet: item.snippet,
        })
        .collect()
}

/// 解析并缓存 source map（content 可为 JSON 文本或 data: URL），返回 sources 列表。
#[napi]
pub async fn browser_source_map_load(key: String, content: String) -> napi::Result<Vec<String>> {
    tokio::task::spawn_blocking(move || source_map::load(&key, content).map_err(invalid))
        .await
        .map_err(map_spawn_error)?
}

/// 每个 source 是否带 sourcesContent（可被搜索）。
#[napi]
pub async fn browser_source_map_content_flags(key: String) -> napi::Result<Vec<bool>> {
    tokio::task::spawn_blocking(move || source_map::content_flags(&key).map_err(invalid))
        .await
        .map_err(map_spawn_error)?
}

/// 原始源码位置换算为生成脚本位置；该位置之后没有映射时返回 None。
#[napi]
pub async fn browser_source_map_resolve(
    key: String,
    source_index: u32,
    line: u32,
    column: Option<u32>,
) -> napi::Result<Option<BrowserSourceMapLocation>> {
    tokio::task::spawn_blocking(move || {
        source_map::resolve(&key, source_index, line, column)
            .map(|found| {
                found.map(|location| BrowserSourceMapLocation {
                    source_line: location.source_line,
                    source_column: location.source_column,
                    generated_line: location.generated_line,
                    generated_column: location.generated_column,
                })
            })
            .map_err(invalid)
    })
    .await
    .map_err(map_spawn_error)?
}

/// 在已加载 source map 的原始源码内容里搜索。
#[napi]
pub async fn browser_source_map_search(
    key: String,
    query: String,
    is_regex: bool,
    case_sensitive: bool,
    limit: u32,
    source_indexes: Option<Vec<u32>>,
) -> napi::Result<Vec<BrowserScriptTextMatch>> {
    tokio::task::spawn_blocking(move || {
        source_map::search_map(
            &key,
            &query,
            is_regex,
            case_sensitive,
            limit as usize,
            source_indexes.as_deref(),
        )
        .map(to_matches)
        .map_err(invalid)
    })
    .await
    .map_err(map_spawn_error)?
}

/// 在一段脚本文本里搜索，返回行列与片段。
#[napi]
pub async fn browser_script_text_search(
    content: String,
    query: String,
    is_regex: bool,
    case_sensitive: bool,
    limit: u32,
) -> napi::Result<Vec<BrowserScriptTextMatch>> {
    tokio::task::spawn_blocking(move || {
        source_map::search_text(&content, &query, is_regex, case_sensitive, limit as usize)
            .map(to_matches)
            .map_err(invalid)
    })
    .await
    .map_err(map_spawn_error)?
}

/// 释放 key 以 prefix 开头的 source map 缓存。
#[napi]
pub async fn browser_source_map_release(prefix: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || source_map::release(&prefix))
        .await
        .map_err(map_spawn_error)
}
