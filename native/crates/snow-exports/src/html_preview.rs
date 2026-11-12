//! HTML 渲染器预览文档 NAPI 导出。
//!
//! 供主进程调用：渲染层卡片物化预览缓存（html-preview:// 协议与内置浏览器
//! 打开都依赖它）、协议处理器按文档 id 解析缓存文件、下载时把规范化文档
//! 写到用户选择的位置。所有磁盘 I/O 都在 spawn_blocking 中执行。

use std::path::PathBuf;

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::mcp::servers::html_render;

/// 已物化的预览文档信息。
#[napi(object)]
pub struct HtmlPreviewDocument {
    /// 内容寻址 id（规范化文档 blake3 前 32 位十六进制）。
    pub id: String,
    /// 解析后的标题（显式标题优先，否则取文档 `<title>`）。
    pub title: String,
    /// 缓存文件绝对路径。
    pub file_path: String,
    /// 缓存文件的 file:// URL（供内置浏览器打开）。
    pub file_url: String,
    /// 规范化文档的字节数。
    pub bytes: u32,
}

fn map_spawn_error(error: tokio::task::JoinError) -> Error {
    Error::new(
        Status::GenericFailure,
        format!("Spawned blocking task failed: {error}"),
    )
}

/// 规范化 HTML 并写入预览缓存（已存在则跳过），返回文档信息。
#[napi]
pub async fn materialize_html_preview(
    html: String,
    title: Option<String>,
) -> napi::Result<HtmlPreviewDocument> {
    tokio::task::spawn_blocking(move || -> napi::Result<HtmlPreviewDocument> {
        let document = html_render::materialize_document(&html, title.as_deref())?;
        let file_url = html_render::file_url(&document.file_path)?;
        Ok(HtmlPreviewDocument {
            id: document.id,
            title: document.title,
            file_path: document.file_path.to_string_lossy().into_owned(),
            file_url,
            bytes: u32::try_from(document.bytes).unwrap_or(u32::MAX),
        })
    })
    .await
    .map_err(map_spawn_error)?
}

/// 按文档 id 解析缓存文件路径；id 非法或缓存不存在时返回 None。
#[napi]
pub async fn resolve_html_preview_file(id: String) -> napi::Result<Option<String>> {
    tokio::task::spawn_blocking(move || -> napi::Result<Option<String>> {
        Ok(html_render::resolve_preview_file(id.trim())?
            .map(|path| path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(map_spawn_error)?
}

/// 把规范化后的完整 HTML 文档写到指定路径（下载）。
#[napi]
pub async fn export_html_preview(
    html: String,
    title: Option<String>,
    target_path: String,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || -> napi::Result<()> {
        let target_path = PathBuf::from(target_path.trim());
        if target_path.as_os_str().is_empty() {
            return Err(Error::new(
                Status::InvalidArg,
                "Target path is required".to_string(),
            ));
        }
        html_render::export_document(&html, title.as_deref(), &target_path)
    })
    .await
    .map_err(map_spawn_error)?
}
