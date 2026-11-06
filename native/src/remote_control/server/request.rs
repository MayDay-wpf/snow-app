//! HTTP 请求解析工具：URL、Cookie、请求头与 JSON 请求体。

use axum::body::Body;
use axum::http::{HeaderMap, Method, StatusCode};
use serde_json::{json, Value};
use url::Url;

use super::limits::{MAX_BODY_BYTES, MAX_IDENTIFIER_LENGTH};
use super::ApiError;

pub(super) fn parse_url(uri: &str) -> Option<Url> {
    Url::parse(&format!("http://localhost{}", uri)).ok()
}

pub(super) fn header_text(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
}

/// 解析 Cookie 头（decodeURIComponent 语义，失败时忽略该项）。
fn parse_cookies(header: Option<&str>) -> Vec<(String, String)> {
    let mut cookies = Vec::new();
    for part in header.unwrap_or_default().split(';') {
        let Some(separator) = part.find('=') else {
            continue;
        };
        if separator == 0 {
            continue;
        }
        let name = part[..separator].trim().to_string();
        let raw = part[separator + 1..].trim();
        let value = percent_encoding::percent_decode_str(raw)
            .decode_utf8()
            .map(|decoded| decoded.into_owned())
            .unwrap_or_else(|_| raw.to_string());
        cookies.push((name, value));
    }
    cookies
}

pub(super) fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    let raw = header_text(headers, "cookie");
    parse_cookies(raw.as_deref())
        .into_iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value)
}

pub(super) fn is_json_request(headers: &HeaderMap) -> bool {
    header_text(headers, "content-type")
        .map(|value| value.to_ascii_lowercase().starts_with("application/json"))
        .unwrap_or(false)
}

/// JSON 接口统一的 Content-Type 校验。
pub(super) fn require_json(headers: &HeaderMap) -> Result<(), ApiError> {
    if is_json_request(headers) {
        return Ok(());
    }
    Err(ApiError::new(
        StatusCode::UNSUPPORTED_MEDIA_TYPE,
        "Content-Type 必须是 application/json",
    ))
}

/// GET/HEAD 且声明接受 HTML：典型的浏览器导航（区别于页面内 fetch 与 API 客户端）。
pub(super) fn is_browser_navigation(method: &Method, headers: &HeaderMap) -> bool {
    (*method == Method::GET || *method == Method::HEAD)
        && header_text(headers, "accept")
            .map(|value| value.contains("text/html"))
            .unwrap_or(false)
}

pub(super) fn is_bounded_string(value: &str, allow_empty: bool) -> bool {
    value.chars().count() <= MAX_IDENTIFIER_LENGTH && (allow_empty || !value.trim().is_empty())
}

pub(super) fn truncate_chars(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

pub(super) fn percent_decode(value: &str) -> Option<String> {
    percent_encoding::percent_decode_str(value)
        .decode_utf8()
        .ok()
        .map(|decoded| decoded.into_owned())
}

/// 读取查询参数（URLSearchParams 语义：缺失返回 None，空串返回 Some("")）。
pub(super) fn query_param(url: &Url, name: &str) -> Option<String> {
    url.query_pairs()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
}

/// 校验字符串数组字段：缺失 / null 视为空数组，非字符串元素视为非法。
pub(super) fn string_array_field(value: Option<&Value>) -> Option<Vec<String>> {
    match value {
        None | Some(Value::Null) => Some(Vec::new()),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| item.as_str().map(str::to_string))
            .collect(),
        Some(_) => None,
    }
}

pub(super) async fn read_json_body(body: Option<Body>) -> Result<Value, ApiError> {
    let body = body.unwrap_or_else(Body::empty);
    let bytes = axum::body::to_bytes(body, MAX_BODY_BYTES)
        .await
        .map_err(|_| ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "请求体超过 64 KiB"))?;
    if bytes.is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| ApiError::new(StatusCode::BAD_REQUEST, "JSON 格式无效"))
}
