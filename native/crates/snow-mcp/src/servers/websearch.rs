use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};
use napi::bindgen_prelude::*;
use napi::threadsafe_function::ThreadsafeFunction;
use napi_derive::napi;
use regex::Regex;
use reqwest::{Client, Url};
use serde_json::{json, Value};

use super::super::service::McpService;
use super::super::tools::McpTool;

const SERVER_ID: &str = "websearch";
const PROXY_BROWSER_SETTING_CODE: &str = "proxy_browser_settings";
const REQUEST_TIMEOUT_SECS: u64 = 30;
const DEFAULT_MAX_CONTENT_LENGTH: usize = 50_000;
const MIN_MAX_CONTENT_LENGTH: usize = 1_000;
const MAX_MAX_CONTENT_LENGTH: usize = 100_000;
const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/// 转发给 Electron 主进程执行的 Web 搜索命令。
#[napi(object)]
pub struct WebSearchCommand {
    pub operation: String,
    pub args_json: String,
}

pub type WebSearchCommandCallback =
    ThreadsafeFunction<WebSearchCommand, Promise<String>, WebSearchCommand, Status, false>;

pub struct WebSearchService;

impl WebSearchService {
    pub fn new() -> Self {
        WebSearchService
    }

    /// 通过异步执行器执行搜索工具：把命令转发给 Electron 主进程，
    /// 由主进程的 puppeteer 服务驱动真实浏览器搜索（可绕过 JS 反爬）。
    pub async fn execute_async(
        &self,
        tool_name: &str,
        args: &Value,
        on_command: &WebSearchCommandCallback,
    ) -> napi::Result<Value> {
        let command = WebSearchCommand {
            operation: tool_name.to_string(),
            args_json: serde_json::to_string(args).map_err(|error| {
                Error::new(
                    Status::GenericFailure,
                    format!("Failed to serialize web search command: {error}"),
                )
            })?,
        };

        let promise = on_command
            .call_async_catch(command)
            .await
            .map_err(|error| {
                Error::new(
                    Status::GenericFailure,
                    format!("Failed to dispatch web search command to Electron: {error}"),
                )
            })?;
        let result_json = promise.await.map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Web search command failed: {error}"),
            )
        })?;

        serde_json::from_str(&result_json).map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Web search command returned invalid JSON: {error}"),
            )
        })
    }

    pub async fn execute_fetch(&self, args: &Value) -> napi::Result<Value> {
        let url = required_string(args, "url", "websearch-websearch-fetch")?;
        validate_web_url(url)?;

        // 站点屏蔽规则：命中用户配置的正则时直接拒绝抓取。
        let blocked_patterns = load_blocked_patterns().await;
        if let Some(pattern) = blocked_patterns.iter().find(|pattern| {
            Regex::new(pattern)
                .map(|regex| regex.is_match(url))
                .unwrap_or(false)
        }) {
            return Err(generic_error(format!(
                "URL blocked by user rule (matched regex: {pattern})"
            )));
        }

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
                description: "Search the web with one or more configured engines; the `engines` parameter lists the available ones. The service runs the selected engines in parallel, fetches multiple result pages, de-duplicates the hits and re-ranks them with a local relevance score (query-term coverage, engine agreement, domain authority, original rank), so results come back ordered by estimated usefulness instead of raw engine order. Use it for current information, documentation, news, releases, or anything after your training data.\n\nSEARCH STRATEGY (raises precision):\n- Start broad, then narrow: one query with the key terms, plus a second pass that adds the product/version/year or a site restriction when the first pass is noisy.\n- For technical topics, run the query in both the user's language and English - the two indexes surface different pages.\n- Use timeRange for anything time-sensitive (releases, prices, incidents, \"latest\") instead of hoping the newest page ranks first.\n- Use site when the authoritative source is already known (official docs, a vendor domain, a specific repository).\n- Use language when you need pages in a specific language or region.\n\nCROSS-CHECKING: for a claim that matters, fetch 2-3 independent sources and prefer official or first-party pages when they disagree. Do not settle on a single snippet for a consequential fact.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Search query string (e.g., \"Claude latest model\", \"TypeScript best practices\"). Engine operators such as quoted phrases, site:, filetype: and -excluded terms are passed through."
                        },
                        "maxResults": {
                            "type": "number",
                            "description": "Maximum number of results to return (default: 20, max: 50). Higher values make the engine fetch more result pages, which costs extra time.",
                            "default": 20,
                            "minimum": 1,
                            "maximum": 50
                        },
                        "site": {
                            "type": "string",
                            "description": "Restrict results to a single domain, e.g. \"docs.python.org\" or \"github.com\". Accepts a bare domain or a full URL."
                        },
                        "timeRange": {
                            "type": "string",
                            "enum": ["day", "week", "month", "year"],
                            "description": "Only return pages from this time window. Use it for time-sensitive queries."
                        },
                        "language": {
                            "type": "string",
                            "description": "Language/region hint for the results, e.g. \"zh-CN\", \"en-US\", \"ja-JP\". Defaults to the engine's own locale."
                        },
                        "engines": {
                            "type": "array",
                            "items": {
                                "type": "string",
                                "enum": ["duckduckgo", "bing", "brave", "yahoo", "google", "startpage", "seznam", "yep"]
                            },
                            "description": "Override the engines used for this call, e.g. [\"brave\", \"bing\"]. Multiple engines run in parallel and their results are merged and re-ranked - the more independent indexes agree on a page, the higher it scores. Omit to use the engines selected in Settings."
                        }
                    },
                    "required": ["query"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "websearch-fetch".to_string(),
                description: "Fetch and read the full content of a web page or a direct image URL. For HTML pages, automatically cleans and extracts main text content (scripts, styles, navigation and markup are stripped, HTML entities are decoded). For direct image URLs (detected by image content-type or image file extension), downloads the image and returns a base64 image block for the model to inspect. RENDERING TIP: When the fetched result contains valid image information (a direct image URL or image data), present it to the user using Markdown image syntax, e.g. ![description](https://example.com/image.png), so the image is rendered inline. USAGE: read the 2-3 most credible and independent results for a claim that matters rather than trusting a single page, and prefer official documentation, first-party sources and well-known projects.".to_string(),
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
            "websearch-search" => Err(generic_error(
                "The WebSearch tool must be executed through the asynchronous executor"
                    .to_string(),
            )),
            "websearch-fetch" => Err(generic_error(
                "The WebSearch tool must be executed through the asynchronous executor"
                    .to_string(),
            )),
            _ => Err(generic_error(format!(
                "Unknown tool: \"{tool_name}\" for MCP server \"websearch\". Available tools: [websearch-websearch-search, websearch-websearch-fetch]"
            ))),
        }
    }
}

/// 从数据库异步加载站点屏蔽正则列表。
///
/// 使用 `spawn_blocking` 读取数据库，不会阻塞 Node.js 主线程；
/// 与 `crate::api::http_client::load_proxy_config` 使用相同的存储路径。
async fn load_blocked_patterns() -> Vec<String> {
    tokio::task::spawn_blocking(|| {
        let storage_info = crate::storage::initialize_app_storage().ok()?;
        let database_path = std::path::PathBuf::from(storage_info.database_path);

        let raw = crate::storage::services::system_settings::get_system_setting_value(
            &database_path,
            PROXY_BROWSER_SETTING_CODE,
        )
        .ok()?
        .unwrap_or_default();

        Some(parse_blocked_patterns(&raw))
    })
    .await
    .unwrap_or_default()
    .unwrap_or_default()
}

/// 解析 `proxy_browser_settings` JSON 中的 `blockedPatterns` 字段。
fn parse_blocked_patterns(raw: &str) -> Vec<String> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return Vec::new();
    };

    value
        .get("blockedPatterns")
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|pattern| !pattern.is_empty())
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default()
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

/// 常用命名实体（覆盖排版符号、货币、标点与西欧重音字母）。
///
/// `amp` 与其它实体同表处理是安全的：正则替换是单次遍历，
/// `&amp;lt;` 只会产出 `&lt;`，不会二次解码成 `<`。
const NAMED_ENTITIES: &[(&str, &str)] = &[
    ("amp", "&"),
    ("lt", "<"),
    ("gt", ">"),
    ("quot", "\""),
    ("apos", "'"),
    ("nbsp", " "),
    ("ensp", " "),
    ("emsp", " "),
    ("thinsp", " "),
    ("shy", ""),
    ("mdash", "—"),
    ("ndash", "–"),
    ("minus", "−"),
    ("hellip", "…"),
    ("lsquo", "‘"),
    ("rsquo", "’"),
    ("ldquo", "“"),
    ("rdquo", "”"),
    ("laquo", "«"),
    ("raquo", "»"),
    ("lsaquo", "‹"),
    ("rsaquo", "›"),
    ("middot", "·"),
    ("bull", "•"),
    ("dagger", "†"),
    ("Dagger", "‡"),
    ("para", "¶"),
    ("sect", "§"),
    ("prime", "′"),
    ("Prime", "″"),
    ("trade", "™"),
    ("copy", "©"),
    ("reg", "®"),
    ("deg", "°"),
    ("plusmn", "±"),
    ("times", "×"),
    ("divide", "÷"),
    ("frac12", "½"),
    ("frac14", "¼"),
    ("frac34", "¾"),
    ("sup1", "¹"),
    ("sup2", "²"),
    ("sup3", "³"),
    ("iexcl", "¡"),
    ("iquest", "¿"),
    ("euro", "€"),
    ("pound", "£"),
    ("yen", "¥"),
    ("cent", "¢"),
    ("curren", "¤"),
    ("szlig", "ß"),
    ("agrave", "à"),
    ("aacute", "á"),
    ("acirc", "â"),
    ("atilde", "ã"),
    ("auml", "ä"),
    ("aring", "å"),
    ("ccedil", "ç"),
    ("egrave", "è"),
    ("eacute", "é"),
    ("ecirc", "ê"),
    ("euml", "ë"),
    ("igrave", "ì"),
    ("iacute", "í"),
    ("icirc", "î"),
    ("iuml", "ï"),
    ("ntilde", "ñ"),
    ("ograve", "ò"),
    ("oacute", "ó"),
    ("ocirc", "ô"),
    ("otilde", "õ"),
    ("ouml", "ö"),
    ("oslash", "ø"),
    ("ugrave", "ù"),
    ("uacute", "ú"),
    ("ucirc", "û"),
    ("uuml", "ü"),
    ("yacute", "ý"),
    ("yuml", "ÿ"),
];

fn decode_html_entities(value: &str) -> String {
    let numeric_regex =
        Regex::new(r"&#(x?)([0-9a-fA-F]+);").expect("numeric entity regex must compile");
    let decoded = numeric_regex.replace_all(value, |captures: &regex::Captures| {
        let radix = if captures[1].is_empty() { 10 } else { 16 };
        let digits = captures.get(2).map(|value| value.as_str()).unwrap_or("");
        match u32::from_str_radix(digits, radix) {
            Ok(code) => char::from_u32(code)
                .map(|character| character.to_string())
                .unwrap_or_else(|| captures[0].to_string()),
            Err(_) => captures[0].to_string(),
        }
    });

    let named_regex =
        Regex::new(r"&([a-zA-Z][a-zA-Z0-9]{1,31});").expect("named entity regex must compile");
    named_regex
        .replace_all(&decoded, |captures: &regex::Captures| {
            let name = captures.get(1).map(|value| value.as_str()).unwrap_or("");
            match NAMED_ENTITIES.iter().find(|(key, _)| *key == name) {
                Some((_, replacement)) => (*replacement).to_string(),
                None => captures[0].to_string(),
            }
        })
        .into_owned()
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
