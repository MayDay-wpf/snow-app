//! HTML 渲染器内置 MCP 服务：把 AI 生成的 HTML 直接渲染在会话中。
//!
//! 设计要点：
//! - 工具结果不回显 HTML（模型已在参数里给出全文），只返回文档 id / 标题 /
//!   字节数等摘要，避免重复占用上下文 token
//! - 规范化：片段自动包裹为完整 UTF-8 文档；完整文档缺少 charset 声明时
//!   补 `<meta charset="utf-8">`，保证落盘后以 file:// 打开不乱码
//! - 内容寻址落盘：`~/.snowapp/html-preview/<id>.html`（id 取规范化文档
//!   blake3 的前 32 位十六进制），同一文档只写一次；渲染层经 html-preview://
//!   自定义协议加载（独立源，不继承主窗口 CSP），缓存缺失时由渲染层用工具
//!   参数重新物化自愈
//! - 执行体为同步实现：工具由分发层（call.rs 默认分支）在 spawn_blocking
//!   线程池中调用，NAPI 导出同样包在 spawn_blocking 内，不阻塞 Node.js 线程
//!
//! 默认关闭（system_settings DEFAULT_DISABLED_BUILTIN_SERVERS + collect.rs
//! DEFAULT_DISABLED_SERVER_IDS），需在 MCP 面板按项目显式启用。

use std::fs;
use std::path::{Path, PathBuf};

use napi::bindgen_prelude::*;
use serde_json::{json, Value};

use super::super::service::McpService;
use super::super::tools::McpTool;

const SERVER_ID: &str = "html";
/// 单个 HTML 文档（原始参数）的字节上限。
const MAX_HTML_BYTES: usize = 2 * 1024 * 1024;
/// 卡片标题的字符上限。
const MAX_TITLE_CHARS: usize = 120;
/// 预览初始高度的取值范围（CSS 像素）。
const MIN_PREVIEW_HEIGHT: f64 = 160.0;
const MAX_PREVIEW_HEIGHT: f64 = 1600.0;
/// 预览文档缓存目录（位于应用数据目录下）。
const PREVIEW_DIR_NAME: &str = "html-preview";
/// 文档 id 长度：blake3 十六进制摘要的前 32 位（128 bit），同时作为
/// html-preview:// 的 host，需控制在 DNS 标签 63 字符以内。
const DOCUMENT_ID_LEN: usize = 32;
const CHARSET_META: &str = "<meta charset=\"utf-8\">";

pub struct HtmlRenderService;

impl HtmlRenderService {
    pub fn new() -> Self {
        HtmlRenderService
    }
}

impl McpService for HtmlRenderService {
    fn id(&self) -> &str {
        SERVER_ID
    }

    fn tools(&self) -> Vec<McpTool> {
        vec![McpTool {
            server_id: SERVER_ID.to_string(),
            name: "render".to_string(),
            description: "Render HTML inline in the conversation so the user can SEE and interact with it immediately (a sandboxed live preview; the card also offers view source, copy, download and open in the built-in browser). Use it when visual output helps: UI mockups, landing pages, charts and dashboards, interactive demos, styled reports, SVG/Canvas graphics. Pass a COMPLETE self-contained document (inline <style>/<script>; absolute https CDN links are allowed) or a body fragment, which is wrapped into a full UTF-8 document automatically. Relative or local resources (./style.css, files on disk) can NOT be loaded - inline them or use absolute https URLs. To save HTML into the project use the filesystem tools instead. The result does NOT echo the HTML back and the user already sees the rendering, so do not repeat the markup in your reply. Max 2 MB.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "html": {
                        "type": "string",
                        "description": "The HTML to render: a full document (<!DOCTYPE html>...) or a fragment."
                    },
                    "title": {
                        "type": "string",
                        "description": "Optional short title shown on the preview card. Defaults to the document <title>."
                    },
                    "height": {
                        "type": "integer",
                        "minimum": 160,
                        "maximum": 1600,
                        "description": "Optional initial preview height in CSS pixels (160-1600, default 480). The user can resize it."
                    }
                },
                "required": ["html"]
            }),
        }]
    }

    fn execute(&self, tool_name: &str, args: &Value) -> napi::Result<Value> {
        match tool_name {
            "render" => execute_render(args),
            _ => Err(Error::new(
                Status::GenericFailure,
                format!(
                    "Unknown tool: \"{tool_name}\" for MCP server \"{SERVER_ID}\". Available tools: [render]"
                ),
            )),
        }
    }
}

/// 已物化到缓存目录的预览文档。
pub struct MaterializedDocument {
    pub id: String,
    pub title: String,
    pub file_path: PathBuf,
    pub bytes: usize,
}

fn execute_render(args: &Value) -> napi::Result<Value> {
    let html = args
        .get("html")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if html.trim().is_empty() {
        return Err(invalid_arg(
            "Missing required parameter: html (a non-empty HTML string)",
        ));
    }
    let title = args.get("title").and_then(Value::as_str);
    let height = parse_height(args)?;
    let document = materialize_document(html, title)?;

    let mut result = json!({
        "success": true,
        "documentId": document.id,
        "title": document.title,
        "bytes": document.bytes,
        "message": "The HTML has been rendered inline in the conversation and the user can see it now. Do not repeat the markup in your reply.",
    });
    if let Some(height) = height {
        result["height"] = json!(height);
    }
    Ok(result)
}

/// 解析可选的预览高度：容忍数字字符串，越界值夹取到合法范围。
fn parse_height(args: &Value) -> napi::Result<Option<u32>> {
    let raw = match args.get("height") {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::Number(number)) => number.as_f64(),
        Some(Value::String(text)) => text.trim().parse::<f64>().ok(),
        Some(_) => None,
    };
    let value = raw.filter(|value| value.is_finite()).ok_or_else(|| {
        invalid_arg("Invalid parameter: height (a number of CSS pixels between 160 and 1600)")
    })?;
    Ok(Some(
        value.round().clamp(MIN_PREVIEW_HEIGHT, MAX_PREVIEW_HEIGHT) as u32,
    ))
}

/// 规范化 HTML 并写入内容寻址缓存（已存在则跳过写入），返回文档信息。
pub fn materialize_document(
    html: &str,
    title: Option<&str>,
) -> napi::Result<MaterializedDocument> {
    let (title, document) = prepare_document(html, title)?;
    let id = document_id(&document);
    let directory = preview_dir()?;
    let file_path = directory.join(format!("{id}.html"));

    if !file_path.is_file() {
        fs::create_dir_all(&directory)
            .map_err(|error| io_error("create the HTML preview directory", &error))?;
        // 先写临时文件再改名，避免并发读取到写了一半的文档。
        let temp_path = directory.join(format!("{id}.{}.tmp", uuid::Uuid::new_v4().simple()));
        fs::write(&temp_path, document.as_bytes())
            .map_err(|error| io_error("write the HTML preview file", &error))?;
        if let Err(error) = fs::rename(&temp_path, &file_path) {
            let _ = fs::remove_file(&temp_path);
            // 并发物化同一文档时目标已由另一方写入：内容相同，视为成功。
            if !file_path.is_file() {
                return Err(io_error("save the HTML preview file", &error));
            }
        }
    }

    Ok(MaterializedDocument {
        id,
        title,
        bytes: document.len(),
        file_path,
    })
}

/// 把规范化后的完整文档写到用户选择的位置（下载）。
pub fn export_document(
    html: &str,
    title: Option<&str>,
    target_path: &Path,
) -> napi::Result<()> {
    let (_, document) = prepare_document(html, title)?;
    fs::write(target_path, document.as_bytes())
        .map_err(|error| io_error("write the HTML file", &error))
}

/// 按文档 id 解析缓存文件路径；id 非法或文件不存在时返回 None。
pub fn resolve_preview_file(id: &str) -> napi::Result<Option<PathBuf>> {
    let is_valid_id = id.len() == DOCUMENT_ID_LEN
        && id
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'));
    if !is_valid_id {
        return Ok(None);
    }
    let file_path = preview_dir()?.join(format!("{id}.html"));
    Ok(file_path.is_file().then_some(file_path))
}

/// 本地文件路径转 file:// URL（供内置浏览器打开）。
pub fn file_url(path: &Path) -> napi::Result<String> {
    url::Url::from_file_path(path)
        .map(|url| url.to_string())
        .map_err(|()| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to build a file URL for {}", path.display()),
            )
        })
}

/// 校验大小并生成 (标题, 规范化文档)。
fn prepare_document(html: &str, title: Option<&str>) -> napi::Result<(String, String)> {
    if html.trim().is_empty() {
        return Err(invalid_arg("HTML content is empty"));
    }
    if html.len() > MAX_HTML_BYTES {
        return Err(invalid_arg(format!(
            "HTML is too large: {} bytes (limit {MAX_HTML_BYTES} bytes). Move large assets to external URLs or split the content.",
            html.len()
        )));
    }
    let title = resolve_title(html, title);
    let document = normalize_document(html, &title);
    Ok((title, document))
}

fn preview_dir() -> napi::Result<PathBuf> {
    Ok(crate::storage::paths::app_storage_dir()?.join(PREVIEW_DIR_NAME))
}

fn document_id(document: &str) -> String {
    blake3::hash(document.as_bytes()).to_hex().as_str()[..DOCUMENT_ID_LEN].to_string()
}

/// 显式标题优先，否则取文档 `<title>`；折叠空白并截断。
fn resolve_title(html: &str, explicit: Option<&str>) -> String {
    let source = explicit
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .map(str::to_string)
        .or_else(|| extract_document_title(html))
        .unwrap_or_default();
    source
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(MAX_TITLE_CHARS)
        .collect()
}

fn extract_document_title(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let start = find_tag_end(&lower, "<title")?;
    let end = start + lower[start..].find("</title")?;
    let text = html[start..end].trim();
    (!text.is_empty()).then(|| decode_basic_entities(text))
}

/// 片段包裹为完整文档；完整文档缺少 charset 声明时补齐。
///
/// `lower` 为 ASCII 小写副本，字节偏移与原文一致；插入点均位于 ASCII
/// 字符 `>` 之后，切片必然落在字符边界上。
fn normalize_document(html: &str, title: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let has_doctype = lower.trim_start().starts_with("<!doctype");
    let html_tag_end = find_tag_end(&lower, "<html");

    if !has_doctype && html_tag_end.is_none() {
        return format!(
            "<!DOCTYPE html>\n<html>\n<head>\n{CHARSET_META}\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>{}</title>\n</head>\n<body>\n{html}\n</body>\n</html>\n",
            escape_html_text(title)
        );
    }
    if has_charset_declaration(&lower) {
        return html.to_string();
    }
    if let Some(position) = find_tag_end(&lower, "<head") {
        return format!("{}\n{CHARSET_META}{}", &html[..position], &html[position..]);
    }
    if let Some(position) = html_tag_end {
        return format!(
            "{}\n<head>{CHARSET_META}</head>{}",
            &html[..position],
            &html[position..]
        );
    }
    // 只有 doctype 声明而没有 <html> 标签：紧跟在 doctype 之后插入。
    match lower.find('>') {
        Some(position) => format!(
            "{}\n{CHARSET_META}{}",
            &html[..=position],
            &html[position + 1..]
        ),
        None => html.to_string(),
    }
}

/// 查找开始标签（如 `<head`）并返回其 `>` 之后的字节偏移。标签名后必须是
/// `>`、`/` 或空白，避免 `<head` 误匹配 `<header`。
fn find_tag_end(lower: &str, tag: &str) -> Option<usize> {
    let bytes = lower.as_bytes();
    let mut cursor = 0;
    while let Some(offset) = lower[cursor..].find(tag) {
        let after = cursor + offset + tag.len();
        match bytes.get(after) {
            Some(b'>') => return Some(after + 1),
            Some(byte) if byte.is_ascii_whitespace() || *byte == b'/' => {
                return lower[after..].find('>').map(|close| after + close + 1);
            }
            Some(_) => cursor = after,
            None => return None,
        }
    }
    None
}

fn has_charset_declaration(lower: &str) -> bool {
    let mut cursor = 0;
    while let Some(offset) = lower[cursor..].find("<meta") {
        let start = cursor + offset;
        let end = lower[start..]
            .find('>')
            .map_or(lower.len(), |close| start + close);
        if lower[start..end].contains("charset") {
            return true;
        }
        cursor = start + "<meta".len();
    }
    false
}

fn escape_html_text(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn decode_basic_entities(text: &str) -> String {
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}

fn invalid_arg(message: impl Into<String>) -> Error {
    Error::new(Status::InvalidArg, message.into())
}

fn io_error(action: &str, error: &std::io::Error) -> Error {
    Error::new(Status::GenericFailure, format!("Failed to {action}: {error}"))
}
