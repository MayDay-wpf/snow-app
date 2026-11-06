//! 实时通道：WebSocket 握手校验与连接移交。

use std::sync::Arc;

use axum::body::Body;
use axum::http::{header, HeaderMap, Response, StatusCode};
use hyper::upgrade::OnUpgrade;
use hyper_util::rt::TokioIo;
use serde_json::json;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::{Role, WebSocketConfig};
use tokio_tungstenite::WebSocketStream;

use super::access::has_expected_wan_origin;
use super::limits::LIVE_MAX_MESSAGE_BYTES;
use super::request::header_text;
use super::response::json_response;
use super::ServerContext;
use crate::remote_control::live;

fn header_has_token(headers: &HeaderMap, name: &str, token: &str) -> bool {
    header_text(headers, name)
        .map(|value| value.split(',').any(|part| part.trim().eq_ignore_ascii_case(token)))
        .unwrap_or(false)
}

/// WebSocket 握手必须同源（Cookie 鉴权下防跨站劫持）。
fn is_same_origin_upgrade(context: &ServerContext, headers: &HeaderMap) -> bool {
    if context.is_wan() {
        return has_expected_wan_origin(headers, context);
    }
    let (Some(origin), Some(host)) = (header_text(headers, "origin"), header_text(headers, "host")) else {
        return false;
    };
    origin
        .strip_prefix("http://")
        .or_else(|| origin.strip_prefix("https://"))
        .map(|rest| rest.eq_ignore_ascii_case(&host))
        .unwrap_or(false)
}

/// 会话存续期间的凭据复查：令牌轮换 / 服务重启后代数变化，公网令牌更换后失效。
fn live_still_authorized(context: &ServerContext, generation: u64, wan_credential: Option<&str>) -> bool {
    if context.generation() != generation {
        return false;
    }
    match context.wan_auth.as_ref() {
        Some(auth) if context.is_wan() => auth.authorize(wan_credential),
        _ => true,
    }
}

/// /api/live：校验握手后把连接交给实时通道。
pub(super) fn accept_live(
    context: &Arc<ServerContext>,
    headers: &HeaderMap,
    on_upgrade: Option<OnUpgrade>,
    request_generation: u64,
    wan_credential: Option<String>,
) -> Response<Body> {
    let key = header_text(headers, "sec-websocket-key");
    let handshake_valid = header_has_token(headers, "upgrade", "websocket")
        && header_has_token(headers, "connection", "upgrade")
        && header_text(headers, "sec-websocket-version").as_deref() == Some("13");
    let (Some(key), Some(on_upgrade), true) = (key, on_upgrade, handshake_valid) else {
        return json_response(
            StatusCode::BAD_REQUEST,
            &json!({ "error": "需要 WebSocket 握手" }),
            Vec::new(),
        );
    };
    if !is_same_origin_upgrade(context, headers) {
        return json_response(
            StatusCode::FORBIDDEN,
            &json!({ "error": "请求来源无效" }),
            Vec::new(),
        );
    }
    let accept = derive_accept_key(key.trim().as_bytes());
    let session_context = context.clone();
    tokio::spawn(async move {
        let Ok(upgraded) = on_upgrade.await else {
            return;
        };
        let mut config = WebSocketConfig::default();
        config.max_message_size = Some(LIVE_MAX_MESSAGE_BYTES);
        config.max_frame_size = Some(LIVE_MAX_MESSAGE_BYTES);
        let socket =
            WebSocketStream::from_raw_socket(TokioIo::new(upgraded), Role::Server, Some(config)).await;
        let closed = session_context.closed.clone();
        live::run_session(socket, closed, move || {
            live_still_authorized(&session_context, request_generation, wan_credential.as_deref())
        })
        .await;
    });
    Response::builder()
        .status(StatusCode::SWITCHING_PROTOCOLS)
        .header(header::UPGRADE, "websocket")
        .header(header::CONNECTION, "Upgrade")
        .header(header::SEC_WEBSOCKET_ACCEPT, accept)
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::empty())
        .unwrap_or_else(|_| Response::new(Body::empty()))
}
