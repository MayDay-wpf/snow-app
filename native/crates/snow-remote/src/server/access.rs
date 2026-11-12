//! 访问控制：来源校验、令牌鉴权、会话 Cookie 与解锁流程。

use axum::body::Body;
use axum::http::{HeaderMap, Response, StatusCode};
use serde_json::json;
use url::Url;

use super::limits::{
    COOKIE_NAME, MAX_UNLOCK_CODE_LENGTH, MAX_UNLOCK_TOKEN_LENGTH, TOKEN_HEADER, WAN_COOKIE_MAX_AGE,
    WAN_COOKIE_NAME,
};
use super::request::{cookie_value, header_text, read_json_body, require_json};
use super::response::json_response;
use super::{ApiError, ServerContext};
use crate::remote_control::auth::{encode_query_component, secret_matches};
use crate::storage::services::app_lock;

pub(super) fn has_expected_wan_host(headers: &HeaderMap, context: &ServerContext) -> bool {
    let Some(auth) = &context.wan_auth else {
        return false;
    };
    header_text(headers, "host")
        .map(|host| host.eq_ignore_ascii_case(&auth.expected_host()))
        .unwrap_or(false)
}

pub(super) fn has_expected_wan_origin(headers: &HeaderMap, context: &ServerContext) -> bool {
    let Some(auth) = &context.wan_auth else {
        return false;
    };
    header_text(headers, "origin")
        .map(|origin| origin == auth.origin())
        .unwrap_or(false)
}

/// Host 头是否为回环主机（忽略端口）：配合对端地址一起判定本机访问，
/// 避免恶意域名解析到 127.0.0.1 后借同源直接调用接口。
pub(super) fn is_loopback_host(headers: &HeaderMap) -> bool {
    let Some(host) = header_text(headers, "host") else {
        return false;
    };
    let host = host.trim();
    let name = match host.strip_prefix('[') {
        Some(rest) => rest.split(']').next().unwrap_or_default(),
        None => host.split(':').next().unwrap_or_default(),
    };
    name.eq_ignore_ascii_case("localhost")
        || name
            .parse::<std::net::IpAddr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false)
}

pub(super) fn is_authorized(
    context: &ServerContext,
    headers: &HeaderMap,
    url: &Url,
    request_token: &str,
) -> bool {
    match context.policy {
        super::ServerPolicy::Lan => {
            if request_token.is_empty() {
                return false;
            }
            let header_match = header_text(headers, TOKEN_HEADER)
                .map(|value| secret_matches(&value, request_token))
                .unwrap_or(false);
            let cookie_match = cookie_value(headers, COOKIE_NAME)
                .map(|value| secret_matches(&value, request_token))
                .unwrap_or(false);
            let query_match = url
                .query_pairs()
                .find(|(key, _)| key == "token")
                .map(|(_, value)| secret_matches(&value, request_token))
                .unwrap_or(false);
            header_match || cookie_match || query_match
        }
        super::ServerPolicy::Wan => {
            let Some(auth) = context.wan_auth.as_ref() else {
                return false;
            };
            if auth.authorize(cookie_value(headers, WAN_COOKIE_NAME).as_deref()) {
                return true;
            }
            url.query_pairs()
                .find(|(key, _)| key == "token")
                .map(|(_, value)| auth.authorize(Some(value.as_ref())))
                .unwrap_or(false)
        }
    }
}

/// 令牌有效时返回对应的会话 Cookie：局域网与公网都写长期令牌。
pub(super) fn session_cookie(context: &ServerContext, candidate: &str) -> Option<String> {
    if context.is_wan() {
        let auth = context.wan_auth.as_ref()?;
        if !auth.authorize(Some(candidate)) {
            return None;
        }
        return Some(format!(
            "{WAN_COOKIE_NAME}={}; Path=/; Max-Age={WAN_COOKIE_MAX_AGE}; Secure; HttpOnly; SameSite=Strict",
            encode_query_component(candidate)
        ));
    }
    let current = context.current_token();
    if !secret_matches(candidate, &current) {
        return None;
    }
    Some(format!(
        "{COOKIE_NAME}={}; Path=/; HttpOnly; SameSite=Strict",
        encode_query_component(&current)
    ))
}

/// 令牌解锁：移动端令牌填写页提交令牌，校验通过后写入会话 Cookie。
pub(super) async fn handle_unlock(
    context: &ServerContext,
    headers: &HeaderMap,
    body: Option<Body>,
) -> Result<Response<Body>, ApiError> {
    if context.is_wan() && !has_expected_wan_origin(headers, context) {
        return Ok(json_response(
            StatusCode::FORBIDDEN,
            &json!({ "error": "请求来源无效" }),
            Vec::new(),
        ));
    }
    require_json(headers)?;
    let payload = read_json_body(body).await?;
    let code = payload
        .get("code")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if !code.is_empty() {
        return unlock_with_code(context, &code).await;
    }
    if context.unlock_tokens.blocked() {
        return Ok(json_response(
            StatusCode::TOO_MANY_REQUESTS,
            &json!({ "error": "令牌错误次数过多，请稍后再试" }),
            Vec::new(),
        ));
    }
    let token = payload
        .get("token")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if token.is_empty() || token.chars().count() > MAX_UNLOCK_TOKEN_LENGTH {
        context.unlock_tokens.record();
        return Ok(json_response(
            StatusCode::BAD_REQUEST,
            &json!({ "error": "请输入有效的令牌" }),
            Vec::new(),
        ));
    }
    match session_cookie(context, &token) {
        Some(cookie) => {
            context.unlock_tokens.clear();
            Ok(json_response(
                StatusCode::OK,
                &json!({ "ok": true }),
                vec![("Set-Cookie", cookie)],
            ))
        }
        None => {
            context.unlock_tokens.record();
            let message = if context.is_wan() {
                "令牌无效或已过期"
            } else {
                "令牌无效"
            };
            Ok(json_response(
                StatusCode::UNAUTHORIZED,
                &json!({ "error": message }),
                Vec::new(),
            ))
        }
    }
}

/// 身份验证器动态码解锁：桌面端已绑定谷歌身份验证器并允许远控解锁时，
/// 6 位动态码等价于持有配对令牌，校验通过即写入同一套会话 Cookie。
async fn unlock_with_code(context: &ServerContext, code: &str) -> Result<Response<Body>, ApiError> {
    if context.unlock_codes.blocked() {
        return Ok(json_response(
            StatusCode::TOO_MANY_REQUESTS,
            &json!({ "error": "动态码错误次数过多，请稍后再试" }),
            Vec::new(),
        ));
    }
    if code.chars().count() > MAX_UNLOCK_CODE_LENGTH {
        context.unlock_codes.record();
        return Ok(json_response(
            StatusCode::BAD_REQUEST,
            &json!({ "error": "请输入 6 位动态码" }),
            Vec::new(),
        ));
    }
    let candidate = code.to_string();
    let verified = tokio::task::spawn_blocking(move || -> napi::Result<bool> {
        let database_path = crate::storage::ensure_database_file()?;
        if !app_lock::remote_unlock_enabled(&database_path)? {
            return Ok(false);
        }
        app_lock::verify_remote_unlock_code(&database_path, &candidate)
    })
    .await
    .map(|result| result.unwrap_or(false))
    .unwrap_or(false);
    let cookie = if verified {
        current_session_cookie(context)
    } else {
        None
    };
    let Some(cookie) = cookie else {
        context.unlock_codes.record();
        return Ok(json_response(
            StatusCode::UNAUTHORIZED,
            &json!({ "error": "动态码无效，或未启用验证器解锁" }),
            Vec::new(),
        ));
    };
    context.unlock_codes.clear();
    Ok(json_response(
        StatusCode::OK,
        &json!({ "ok": true }),
        vec![("Set-Cookie", cookie)],
    ))
}

/// 当前监听器生效令牌对应的会话 Cookie。
fn current_session_cookie(context: &ServerContext) -> Option<String> {
    let candidate = if context.is_wan() {
        context.wan_auth.as_ref()?.token()
    } else {
        context.current_token()
    };
    session_cookie(context, &candidate)
}

/// 手机端是否可用身份验证器动态码解锁（桌面端已绑定且未关闭开关）。
pub(super) async fn totp_unlock_available() -> bool {
    tokio::task::spawn_blocking(|| -> napi::Result<bool> {
        let database_path = crate::storage::ensure_database_file()?;
        app_lock::remote_unlock_enabled(&database_path)
    })
    .await
    .map(|result| result.unwrap_or(false))
    .unwrap_or(false)
}
