use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};
use napi::bindgen_prelude::*;
use regex::Regex;
use reqwest::{Client, Url};
use serde::Deserialize;
use serde_json::{json, Value};

use super::super::service::McpService;
use super::super::tools::McpTool;

const SERVER_ID: &str = "websearch";
const PROXY_BROWSER_SETTING_CODE: &str = "proxy_browser_settings";
const DEFAULT_SEARCH_ENGINE: &str = "duckduckgo";
const REQUEST_TIMEOUT_SECS: u64 = 30;
const DEFAULT_MAX_RESULTS: usize = 10;
const MAX_MAX_RESULTS: usize = 20;
const DEFAULT_MAX_CONTENT_LENGTH: usize = 50_000;
const MIN_MAX_CONTENT_LENGTH: usize = 1_000;
const MAX_MAX_CONTENT_LENGTH: usize = 100_000;
const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

pub struct WebSearchService;

/// Web search 引擎选择（代理设置由 `http_client` 统一管理）。
#[derive(Debug, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ProxyBrowserSettings {
    search_engine: String,
}

impl Default for ProxyBrowserSettings {
    fn default() -> Self {
        Self {
            search_engine: DEFAULT_SEARCH_ENGINE.to_string(),
        }
    }
}

impl WebSearchService {
    pub fn new() -> Self {
        WebSearchService
    }

    pub async fn execute_search(&self, args: &Value) -> napi::Result<Value> {
        let query = required_string(args, "query", "websearch-websearch-search")?;
        let max_results = bounded_usize(
            args.get("maxResults").and_then(Value::as_u64),
            DEFAULT_MAX_RESULTS,
            1,
            MAX_MAX_RESULTS,
        );
        let settings = load_search_engine_settings().await?;
        let proxy_config = crate::api::http_client::load_proxy_config().await?;
        let client = build_http_client(&proxy_config)?;
        let results =
            search_with_engine(&client, &settings.search_engine, query, max_results).await?;
        let total_results = results.len();

        Ok(json!({
            "query": query,
            "results": results,
            "totalResults": total_results,
        }))
    }

    pub async fn execute_fetch(&self, args: &Value) -> napi::Result<Value> {
        let url = required_string(args, "url", "websearch-websearch-fetch")?;
        validate_web_url(url)?;
        let max_length = bounded_usize(
            args.get("maxLength").and_then(Value::as_u64),
            DEFAULT_MAX_CONTENT_LENGTH,
            MIN_MAX_CONTENT_LENGTH,
            MAX_MAX_CONTENT_LENGTH,
        );
        let proxy_config = crate::api::http_client::load_proxy_config().await?;
        let client = build_http_client(&proxy_config)?;
        let response = client
            .get(url)
            .send()
            .await
            .map_err(|error| generic_error(format!("Failed to fetch page: {error}")))?;
        let status = response.status();
        if !status.is_success() {
            return Err(generic_error(format!(
                "Failed to fetch page: {} {}",
                status.as_u16(),
                status.canonical_reason().unwrap_or("Unknown status")
            )));
        }

        let final_url = response.url().to_string();
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();

        if is_image_response(url, &content_type) {
            let mime_type = image_mime_type(url, &content_type)
                .ok_or_else(|| generic_error("Unable to determine image MIME type".to_string()))?;
            let bytes = response.bytes().await.map_err(|error| {
                generic_error(format!("Failed to read image response: {error}"))
            })?;
            if bytes.len() > MAX_IMAGE_BYTES {
                return Err(generic_error(format!(
                    "Image is too large to return ({}, maximum {} bytes)",
                    bytes.len(),
                    MAX_IMAGE_BYTES
                )));
            }

            let text = format!("Image URL fetched successfully: {final_url} ({mime_type})");
            return Ok(json!({
                "url": final_url,
                "title": "Image",
                "content": [
                    { "type": "text", "text": text },
                    {
                        "type": "image",
                        "data": BASE64_STANDARD.encode(bytes),
                        "mimeType": mime_type,
                    }
                ],
                "textLength": text.len(),
                "contentPreview": text,
            }));
        }

        let html = response
            .text()
            .await
            .map_err(|error| generic_error(format!("Failed to read page content: {error}")))?;
        let title = extract_title(&html);
        let content = extract_page_text(&html, max_length);
        let content_preview = truncate_text(&content, 500);

        Ok(json!({
            "url": final_url,
            "title": title,
            "content": content,
            "textLength": content.len(),
            "contentPreview": content_preview,
        }))
    }
}

impl McpService for WebSearchService {
    fn id(&self) -> &str {
        SERVER_ID
    }

    fn tools(&self) -> Vec<McpTool> {
        vec![
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "websearch-search".to_string(),
                description: "Search the web using the configured search engine (DuckDuckGo or Bing). Returns a list of search results with titles, URLs, and snippets. Best for finding current information, documentation, news, or general web content. IMPORTANT WORKFLOW: After getting search results, analyze them and choose ONLY ONE most credible and relevant page to fetch. Do NOT fetch multiple pages - reading one high-quality source is sufficient and more efficient.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Search query string (e.g., \"Claude latest model\", \"TypeScript best practices\")"
                        },
                        "maxResults": {
                            "type": "number",
                            "description": "Maximum number of results to return (default: 10, max: 20)",
                            "default": 10,
                            "minimum": 1,
                            "maximum": 20
                        }
                    },
                    "required": ["query"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "websearch-fetch".to_string(),
                description: "Fetch and read the full content of a web page or a direct image URL. For HTML pages, automatically cleans and extracts main text content. For direct image URLs (detected by image content-type or image file extension), downloads the image and returns a base64 image block for the model to inspect. RENDERING TIP: When the fetched result contains valid image information (a direct image URL or image data), present it to the user using Markdown image syntax, e.g. ![description](https://example.com/image.png), so the image is rendered inline. USAGE RULE: Only fetch ONE page per search - choose the most credible and relevant result (prefer official documentation, reputable tech sites, or well-known sources).".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "url": {
                            "type": "string",
                            "description": "Full URL of the web page or direct image to fetch (e.g., \"https://example.com/article\" or \"https://example.com/image.png\")"
                        },
                        "maxLength": {
                            "type": "number",
                            "description": "Maximum content length in characters for HTML pages (default: 50000, max: 100000). Ignored for direct image URLs.",
                            "default": 50000,
                            "minimum": 1000,
                            "maximum": 100000
                        },
                        "isUserProvided": {
                            "type": "boolean",
                            "description": "Whether the URL is directly provided by the user. This value is accepted for Snow CLI compatibility.",
                            "default": false
                        },
                        "enableAiSummary": {
                            "type": "boolean",
                            "description": "Reserved for Snow CLI compatibility. The Rust backend returns cleaned source content directly.",
                            "default": false
                        },
                        "userQuery": {
                            "type": "string",
                            "description": "Original user query. Reserved for Snow CLI compatibility."
                        }
                    },
                    "required": ["url"]
                }),
            },
        ]
    }

    fn execute(&self, tool_name: &str, _args: &Value) -> napi::Result<Value> {
        match tool_name {
            "websearch-search" | "websearch-fetch" => Err(generic_error(
                "The WebSearch tool must be executed through the asynchronous executor".to_string(),
            )),
            _ => Err(generic_error(format!(
                "Unknown tool: \"{tool_name}\" for MCP server \"websearch\". Available tools: [websearch-websearch-search, websearch-websearch-fetch]"
            ))),
        }
    }
}

/// 从数据库加载 Web 搜索引擎配置（代理设置由 `http_client` 统一管理）。
///
/// 仅解析 `search_engine` 字段，代理相关字段已交由
/// `crate::api::http_client` 统一处理。
async fn load_search_engine_settings() -> napi::Result<ProxyBrowserSettings> {
    let setting_value = tokio::task::spawn_blocking(|| {
        let storage_info = crate::storage::initialize_app_storage()?;
        let database_path = std::path::PathBuf::from(storage_info.database_path);
        crate::storage::services::system_settings::get_system_setting_value(
            &database_path,
            PROXY_BROWSER_SETTING_CODE,
        )
    })
    .await
    .map_err(|error| generic_error(format!("Failed to load search engine settings: {error}")))??;

    Ok(setting_value
        .and_then(|value| serde_json::from_str(&value).ok())
        .unwrap_or_default())
}

/// 构建带代理和超时设置的 HTTP 客户端。
///
/// 代理设置由 `ProxyConfig` 提供统一逻辑：启用时走 `http://127.0.0.1:{port}`，
/// 未启用时由 reqwest 默认跟随系统代理环境变量。
fn build_http_client(proxy_config: &crate::api::http_client::ProxyConfig) -> napi::Result<Client> {
    let builder = Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS));

    let builder = proxy_config.clone().apply(builder)?;

    builder
        .build()
        .map_err(|error| generic_error(format!("Failed to create HTTP client: {error}")))
}

async fn search_with_engine(
    client: &Client,
    configured_engine: &str,
    query: &str,
    max_results: usize,
) -> napi::Result<Vec<Value>> {
    let engine = configured_engine.trim().to_ascii_lowercase();
    let (search_url, is_bing) = if engine == "bing" {
        ("https://www.bing.com/search", true)
    } else {
        ("https://html.duckduckgo.com/html/", false)
    };
    let result_count = max_results.to_string();
    let mut query_params = vec![("q", query), ("count", result_count.as_str())];
    if is_bing {
        query_params.push(("format", "rss"));
    }
    let response = client
        .get(search_url)
        .header(
            reqwest::header::ACCEPT,
            "application/rss+xml, application/xml, text/xml, */*",
        )
        .query(&query_params)
        .send()
        .await
        .map_err(|error| generic_error(format!("Web search failed: {error}")))?;
    let status = response.status();
    if !status.is_success() {
        return Err(generic_error(format!(
            "Web search failed: {} {}",
            status.as_u16(),
            status.canonical_reason().unwrap_or("Unknown status")
        )));
    }
    let content = response
        .text()
        .await
        .map_err(|error| generic_error(format!("Web search failed: {error}")))?;

    Ok(if is_bing {
        parse_bing_results(&content, max_results)
    } else {
        parse_duckduckgo_results(&content, max_results)
    })
}

fn parse_duckduckgo_results(html: &str, max_results: usize) -> Vec<Value> {
    let link_regex = Regex::new(r#"(?is)<a[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>(.*?)</a>"#)
        .expect("DuckDuckGo result link regex must compile");
    let snippet_regex =
        Regex::new(r#"(?is)<[^>]*class=["'][^"']*result__snippet[^"']*["'][^>]*>(.*?)</[^>]+>"#)
            .expect("DuckDuckGo snippet regex must compile");
    let snippets: Vec<String> = snippet_regex
        .captures_iter(html)
        .map(|capture| clean_html_text(capture.get(1).map_or("", |value| value.as_str())))
        .collect();

    link_regex
        .captures_iter(html)
        .take(max_results)
        .enumerate()
        .filter_map(|(index, capture)| {
            let url = decode_duckduckgo_url(capture.get(1)?.as_str());
            let title = clean_html_text(capture.get(2)?.as_str());
            if url.is_empty() || title.is_empty() {
                return None;
            }
            Some(search_result_json(
                title,
                url,
                snippets.get(index).cloned().unwrap_or_default(),
            ))
        })
        .collect()
}

fn parse_bing_results(xml: &str, max_results: usize) -> Vec<Value> {
    let item_regex = Regex::new(
        r"(?is)<item>\s*<title>(.*?)</title>\s*<link>(.*?)</link>\s*<description>(.*?)</description>.*?</item>",
    )
    .expect("Bing RSS item regex must compile");

    item_regex
        .captures_iter(xml)
        .take(max_results)
        .filter_map(|capture| {
            let title = clean_html_text(capture.get(1)?.as_str());
            let url = decode_html_entities(capture.get(2)?.as_str().trim());
            let snippet = clean_html_text(capture.get(3)?.as_str());
            if !is_http_url(&url) || title.is_empty() {
                return None;
            }
            Some(search_result_json(title, url, snippet))
        })
        .collect()
}

fn search_result_json(title: String, url: String, snippet: String) -> Value {
    let display_url = Url::parse(&url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(str::to_string))
        .unwrap_or_default();
    json!({
        "title": title,
        "url": url,
        "snippet": snippet,
        "displayUrl": display_url,
    })
}

fn decode_duckduckgo_url(raw_url: &str) -> String {
    let decoded = decode_html_entities(raw_url);
    Url::parse(&decoded)
        .ok()
        .and_then(|url| {
            url.query_pairs()
                .find(|(key, _)| key == "uddg")
                .map(|(_, value)| value.into_owned())
        })
        .unwrap_or(decoded)
}

fn extract_title(html: &str) -> String {
    let title_regex =
        Regex::new(r"(?is)<title[^>]*>(.*?)</title>").expect("title regex must compile");
    title_regex
        .captures(html)
        .and_then(|capture| capture.get(1))
        .map(|value| clean_html_text(value.as_str()))
        .unwrap_or_default()
}

fn extract_page_text(html: &str, max_length: usize) -> String {
    let mut document = html.to_string();
    for pattern in [
        r"(?is)<script[^>]*>.*?</script>",
        r"(?is)<style[^>]*>.*?</style>",
        r"(?is)<noscript[^>]*>.*?</noscript>",
        r"(?is)<svg[^>]*>.*?</svg>",
        r"(?is)<nav[^>]*>.*?</nav>",
        r"(?is)<footer[^>]*>.*?</footer>",
        r"(?is)<iframe[^>]*>.*?</iframe>",
    ] {
        let regex = Regex::new(pattern).expect("HTML cleanup regex must compile");

        document = regex.replace_all(&document, " ").into_owned();
    }

    let text = clean_html_text(&document);
    if text.chars().count() <= max_length {
        return text;
    }

    format!(
        "{}\n\n[Content truncated...]",
        truncate_text(&text, max_length)
    )
}

fn clean_html_text(value: &str) -> String {
    let tag_regex = Regex::new(r"(?is)<[^>]+>").expect("HTML tag regex must compile");
    let without_tags = tag_regex.replace_all(value, " ");
    normalize_whitespace(&decode_html_entities(&without_tags))
}

fn decode_html_entities(value: &str) -> String {
    value
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ")
}

fn normalize_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate_text(value: &str, max_length: usize) -> String {
    let mut truncated = value.chars().take(max_length).collect::<String>();
    if value.chars().count() > max_length {
        truncated.push_str("...");
    }
    truncated
}

fn image_mime_type(url: &str, content_type: &str) -> Option<String> {
    let normalized_content_type = content_type.split(';').next().unwrap_or("").trim();
    if normalized_content_type.starts_with("image/") {
        return Some(normalized_content_type.to_string());
    }

    let path = Url::parse(url).ok()?.path().to_ascii_lowercase();
    let mime_type = if path.ends_with(".png") {
        "image/png"
    } else if path.ends_with(".jpg") || path.ends_with(".jpeg") {
        "image/jpeg"
    } else if path.ends_with(".gif") {
        "image/gif"
    } else if path.ends_with(".webp") {
        "image/webp"
    } else if path.ends_with(".bmp") {
        "image/bmp"
    } else if path.ends_with(".svg") {
        "image/svg+xml"
    } else {
        return None;
    };
    Some(mime_type.to_string())
}

fn is_image_response(url: &str, content_type: &str) -> bool {
    content_type.starts_with("image/") || image_mime_type(url, "").is_some()
}

fn required_string<'a>(args: &'a Value, key: &str, tool_name: &str) -> napi::Result<&'a str> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                format!("{key} is required for tool \"{tool_name}\""),
            )
        })
}

fn bounded_usize(value: Option<u64>, default: usize, min: usize, max: usize) -> usize {
    value
        .map(|value| value as usize)
        .unwrap_or(default)
        .clamp(min, max)
}

fn validate_web_url(url: &str) -> napi::Result<()> {
    if !is_http_url(url) {
        return Err(Error::new(
            Status::InvalidArg,
            "url must be a valid HTTP or HTTPS URL".to_string(),
        ));
    }
    Ok(())
}

fn is_http_url(url: &str) -> bool {
    Url::parse(url)
        .map(|parsed| matches!(parsed.scheme(), "http" | "https"))
        .unwrap_or(false)
}

fn generic_error(message: String) -> Error {
    Error::new(Status::GenericFailure, message)
}
