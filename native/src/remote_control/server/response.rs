//! 响应构造：JSON / HTML 与安全头。

use axum::body::Body;
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, Response, StatusCode};
use serde_json::Value;

use super::request::header_text;

/// 引导页 HTML：无脚本、无外部资源。
pub(super) const UNAUTHORIZED_PAGE_CSP: &str =
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

pub(super) fn build_response(
    status: StatusCode,
    content_type: &str,
    body: Vec<u8>,
    extra: Vec<(&'static str, String)>,
) -> Response<Body> {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(content_type)
            .unwrap_or_else(|_| HeaderValue::from_static("text/plain; charset=utf-8")),
    );
    headers.insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&body.len().to_string()).unwrap_or_else(|_| HeaderValue::from_static("0")),
    );
    for (name, value) in extra {
        if let (Ok(name), Ok(value)) = (
            HeaderName::from_bytes(name.as_bytes()),
            HeaderValue::from_str(&value),
        ) {
            headers.insert(name, value);
        }
    }
    Response::builder()
        .status(status)
        .body(Body::from(body))
        .map(|mut response| {
            *response.headers_mut() = headers;
            response
        })
        .unwrap_or_else(|_| Response::new(Body::empty()))
}

pub(super) fn json_response(
    status: StatusCode,
    value: &Value,
    extra: Vec<(&'static str, String)>,
) -> Response<Body> {
    let body = serde_json::to_vec(value).unwrap_or_else(|_| b"{}".to_vec());
    let mut headers = vec![
        ("Cache-Control", "no-store".to_string()),
        ("X-Content-Type-Options", "nosniff".to_string()),
        ("Referrer-Policy", "no-referrer".to_string()),
    ];
    headers.extend(extra);
    build_response(status, "application/json; charset=utf-8", body, headers)
}

/// 移动页 HTML 的 CSP：无内联脚本权限（脚本 / 样式均为同源独立资源），
/// connect-src 显式放行同主机 ws/wss（部分 WebView 的 'self' 不覆盖 ws 协议）。
pub(super) fn mobile_page_csp(headers: &HeaderMap) -> String {
    let host = header_text(headers, "host").filter(|host| {
        !host.is_empty()
            && host
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b':' | b'[' | b']'))
    });
    let connect = match host {
        Some(host) => format!("'self' ws://{host} wss://{host}"),
        None => "'self'".to_string(),
    };
    format!("default-src 'self'; script-src 'self'; worker-src 'self' blob:; style-src 'self'; connect-src {connect}; img-src 'self' data: blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
}

pub(super) fn html_response(
    status: StatusCode,
    html: String,
    extra: Vec<(&'static str, String)>,
    bodyless: bool,
) -> Response<Body> {
    let body = html.into_bytes();
    let content_length = body.len();
    let mut headers = vec![
        ("Cache-Control", "no-store".to_string()),
        ("X-Content-Type-Options", "nosniff".to_string()),
        ("X-Frame-Options", "DENY".to_string()),
        ("Referrer-Policy", "no-referrer".to_string()),
    ];
    headers.extend(extra);
    let mut response = build_response(
        status,
        "text/html; charset=utf-8",
        if bodyless { Vec::new() } else { body },
        headers,
    );
    if bodyless {
        // HEAD 只回响应头：Content-Length 保留完整 HTML 长度，但不带正文。
        if let Ok(value) = HeaderValue::from_str(&content_length.to_string()) {
            response.headers_mut().insert(header::CONTENT_LENGTH, value);
        }
    }
    response
}
