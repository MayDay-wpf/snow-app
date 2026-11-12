//! 请求管线：静态页面 / 资源、鉴权闸门、解锁入口与 API 分发。

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Method, Response, StatusCode};
use hyper::upgrade::OnUpgrade;
use serde_json::json;

use super::access::{
    handle_unlock, has_expected_wan_host, has_expected_wan_origin, is_authorized, is_loopback_host,
    session_cookie, totp_unlock_available,
};
use super::api::handle_api;
use super::limits::WAN_COOKIE_NAME;
use super::request::{cookie_value, header_text, is_browser_navigation, parse_url, query_param};
use super::response::{
    build_response, html_response, json_response, mobile_page_csp, UNAUTHORIZED_PAGE_CSP,
};
use super::socket::accept_live;
use super::ServerContext;
use crate::remote_control::assets::{self, MOBILE_ASSET_PATH_PREFIX};
use crate::remote_control::bridge;
use crate::remote_control::unauthorized;

pub(super) async fn process(
    context: &Arc<ServerContext>,
    request: axum::http::Request<Body>,
    peer_loopback: bool,
) -> Result<Response<Body>, super::ApiError> {
    let (mut parts, body) = request.into_parts();
    let on_upgrade = parts.extensions.remove::<OnUpgrade>();
    let method = parts.method.clone();
    let headers = parts.headers.clone();
    let mut body = Some(body);

    let uri = parts
        .uri
        .path_and_query()
        .map(|value| value.as_str().to_string())
        .unwrap_or_else(|| "/".to_string());
    let url = parse_url(&uri).ok_or_else(|| super::ApiError::bad_request("请求无效"))?;
    let path = url.path().to_string();

    let request_generation = context.generation();
    let request_token = context.current_token();

    if context.is_wan() && !has_expected_wan_host(&headers, context) {
        return Ok(json_response(
            StatusCode::MISDIRECTED_REQUEST,
            &json!({ "error": "公网入口域名不匹配" }),
            Vec::new(),
        ));
    }

    if method == Method::GET && path == "/api/unlock-methods" {
        return Ok(json_response(
            StatusCode::OK,
            &json!({ "totp": totp_unlock_available().await }),
            Vec::new(),
        ));
    }

    if method == Method::POST && path == "/api/unlock" {
        return handle_unlock(context, &headers, body.take()).await;
    }

    // 本机回环访问免令牌：对端地址与 Host 都必须是回环（防 DNS rebinding）。
    // 公网监听器虽然也监听在回环地址上，但请求经隧道转发而来，仍需鉴权。
    let local_request = !context.is_wan() && peer_loopback && is_loopback_host(&headers);
    let authorized = local_request || is_authorized(context, &headers, &url, &request_token);
    // 未授权的浏览器也可以读取移动端外壳（HTML / 静态资源 / 品牌 logo）：
    // 页面拿不到 /api/state 时会展示令牌填写页，接口本身仍由鉴权把守。
    let is_public_page = method == Method::GET
        && (path == "/" || path == "/icon.png" || path.starts_with(MOBILE_ASSET_PATH_PREFIX));
    if !authorized && !is_public_page {
        if is_browser_navigation(&method, &headers) {
            let desktop_locale = assets::read_desktop_locale().await;
            let locale = unauthorized::resolve_locale(
                desktop_locale,
                header_text(&headers, "accept-language").as_deref(),
            );
            let html = unauthorized::render_unauthorized_page(
                locale,
                context.icon_bytes.as_ref().map(|bytes| bytes.as_slice()),
                &assets::read_desktop_ui_font().await,
            );
            return Ok(html_response(
                StatusCode::UNAUTHORIZED,
                html,
                vec![("Content-Security-Policy", UNAUTHORIZED_PAGE_CSP.to_string())],
                method == Method::HEAD,
            ));
        }
        return Ok(json_response(
            StatusCode::UNAUTHORIZED,
            &json!({ "error": "未授权：请使用 Snow 设置中显示的配对链接" }),
            Vec::new(),
        ));
    }

    if context.is_wan()
        && method != Method::GET
        && method != Method::HEAD
        && !has_expected_wan_origin(&headers, context)
    {
        return Ok(json_response(
            StatusCode::FORBIDDEN,
            &json!({ "error": "请求来源无效" }),
            Vec::new(),
        ));
    }

    if method == Method::GET && path == "/api/live" {
        let wan_credential = if context.is_wan() {
            cookie_value(&headers, WAN_COOKIE_NAME).or_else(|| query_param(&url, "token"))
        } else {
            None
        };
        return Ok(accept_live(
            context,
            &headers,
            on_upgrade,
            request_generation,
            wan_credential,
        ));
    }

    if method == Method::GET && path == "/" {
        let Some(html) = assets::read_mobile_index_html(&context.mobile_dir).await else {
            return Ok(json_response(
                StatusCode::SERVICE_UNAVAILABLE,
                &json!({ "error": "移动端页面资源尚未构建，请先运行 npm run build / npm run dev" }),
                Vec::new(),
            ));
        };
        let mut extra = vec![("Content-Security-Policy", mobile_page_csp(&headers))];
        let token_from_query = url
            .query_pairs()
            .find(|(key, _)| key == "token")
            .map(|(_, value)| value.into_owned());
        if let Some(candidate) = token_from_query {
            if let Some(cookie) = session_cookie(context, &candidate) {
                extra.push(("Set-Cookie", cookie));
            }
        }
        return Ok(html_response(StatusCode::OK, html, extra, false));
    }

    if method == Method::GET && path == "/icon.png" {
        let Some(icon) = context.icon_bytes.clone() else {
            return Ok(json_response(
                StatusCode::NOT_FOUND,
                &json!({ "error": "图标资源不可用" }),
                Vec::new(),
            ));
        };
        return Ok(build_response(
            StatusCode::OK,
            "image/png",
            (*icon).clone(),
            vec![
                ("Cache-Control", "public, max-age=86400".to_string()),
                ("X-Content-Type-Options", "nosniff".to_string()),
            ],
        ));
    }

    if method == Method::GET && path.starts_with(MOBILE_ASSET_PATH_PREFIX) {
        let Some((bytes, content_type)) =
            assets::read_mobile_asset(&context.mobile_dir, &path).await
        else {
            return Ok(json_response(
                StatusCode::NOT_FOUND,
                &json!({ "error": "资源不存在" }),
                Vec::new(),
            ));
        };
        return Ok(build_response(
            StatusCode::OK,
            content_type,
            bytes,
            vec![
                // 文件名带内容哈希：URL 变化即自动失效，可放心交给浏览器长缓存。
                (
                    "Cache-Control",
                    "public, max-age=31536000, immutable".to_string(),
                ),
                ("X-Content-Type-Options", "nosniff".to_string()),
            ],
        ));
    }

    if method == Method::GET && path == "/health" {
        return Ok(json_response(
            StatusCode::OK,
            &json!({ "ok": true, "rendererReady": bridge::is_registered() }),
            Vec::new(),
        ));
    }

    handle_api(
        context,
        &method,
        &path,
        &url,
        &headers,
        &mut body,
        request_generation,
    )
    .await
}
