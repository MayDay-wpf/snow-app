//! 远控 HTTP API 路由表：精确路径按业务分发，前缀类资源单独分流。

mod attachments;
mod changes;
mod chat;
mod git;
mod interaction;
mod media;
mod settings;

use std::sync::Arc;

use axum::body::Body;
use axum::http::{HeaderMap, Method, Response, StatusCode};
use serde_json::{json, Value};
use url::Url;

use super::limits::MAX_IDENTIFIER_LENGTH;
use super::request::truncate_chars;
use super::response::json_response;
use super::{ApiError, ServerContext};
use crate::remote_control::bridge::{self, BridgeError};
use crate::remote_control::theme_asset::THEME_ASSET_PATH_PREFIX;

#[allow(clippy::too_many_arguments)]
pub(super) async fn handle_api(
    context: &Arc<ServerContext>,
    method: &Method,
    path: &str,
    url: &Url,
    headers: &HeaderMap,
    body: &mut Option<Body>,
    request_generation: u64,
) -> Result<Response<Body>, ApiError> {
    let is_get = *method == Method::GET;
    let is_post = *method == Method::POST;

    if is_get && path.starts_with("/api/message-images/") {
        return media::message_image(context, path, request_generation).await;
    }
    if is_get && path.starts_with("/api/upload-images/") {
        return media::upload_image(context, path, request_generation).await;
    }
    if is_get && path.starts_with(THEME_ASSET_PATH_PREFIX) {
        return media::theme_asset_file(context, path, request_generation).await;
    }
    if *method == Method::DELETE && path.starts_with("/api/attachments/") {
        return attachments::delete(context, path, request_generation).await;
    }

    match path {
        "/api/state" if is_get => chat::state(context, request_generation).await,
        "/api/mention" if is_get => media::mention(context, url, request_generation).await,
        "/api/skills" if is_get => settings::skills(context, request_generation).await,
        "/api/skills" if is_post => {
            settings::toggle_skill(context, headers, body, request_generation).await
        }
        "/api/mcp" if is_get => settings::mcp(context, request_generation).await,
        "/api/mcp" if is_post => {
            settings::toggle_mcp(context, headers, body, request_generation).await
        }
        "/api/messages" if is_get => chat::messages(context, url, request_generation).await,
        "/api/conversations" if is_get => {
            chat::conversations(context, url, request_generation).await
        }
        "/api/changes" if is_get => changes::list(context, url, request_generation).await,
        "/api/git" if is_get => git::summary(context, url, request_generation).await,
        "/api/git" if is_post => git::action(context, headers, body, request_generation).await,
        "/api/sensitive-commands" if is_get => {
            settings::sensitive_commands(context, request_generation).await
        }
        "/api/review" if is_get => settings::review(context, request_generation).await,
        "/api/codebase" if is_get => settings::codebase(context, request_generation).await,
        "/api/role" if is_get => settings::role(context, request_generation).await,
        "/api/permissions" if is_get => settings::permissions(context, request_generation).await,
        "/api/attachments" if is_post => {
            attachments::create(context, headers, body, request_generation).await
        }
        "/api/send" if is_post => chat::send(context, headers, body, request_generation).await,
        "/api/abort" if is_post => chat::abort(headers, body).await,
        "/api/pending" if is_post => {
            chat::pending(context, headers, body, request_generation).await
        }
        "/api/new-chat" if is_post => chat::new_chat(headers, body).await,
        "/api/todos" if is_post => {
            interaction::todos(context, headers, body, request_generation).await
        }
        "/api/workflow" if is_post => {
            interaction::workflow(context, headers, body, request_generation).await
        }
        "/api/fork" if is_post => chat::fork(context, headers, body, request_generation).await,
        "/api/rollback" if is_get => changes::state(context, request_generation).await,
        "/api/rollback" if is_post => {
            changes::rollback(context, headers, body, request_generation).await
        }
        "/api/mode" if is_post => settings::mode(headers, body).await,
        "/api/goal-budget" if is_post => settings::goal_budget(headers, body).await,
        "/api/tool-correction" if is_post => settings::tool_correction(headers, body).await,
        "/api/command" if is_post => interaction::command(headers, body).await,
        "/api/model" if is_post => settings::model(headers, body).await,
        "/api/select" if is_post => chat::select(headers, body).await,
        "/api/authorization" if is_post => interaction::authorization(headers, body).await,
        "/api/question" if is_post => interaction::question(headers, body).await,
        _ => Ok(not_found()),
    }
}

pub(super) fn ensure_current_pairing(
    context: &ServerContext,
    snapshot: u64,
) -> Result<(), ApiError> {
    if snapshot != context.generation() {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "配对凭据已轮换，请重新配对",
        ));
    }
    Ok(())
}

fn api_error_from_bridge(error: BridgeError) -> ApiError {
    match error {
        BridgeError::NotReady => ApiError::conflict("远程控制桥尚未就绪"),
        BridgeError::Renderer(message) => {
            let reason = truncate_chars(message.trim(), MAX_IDENTIFIER_LENGTH);
            ApiError::conflict(if reason.is_empty() {
                "Snow 暂时无法处理该请求".to_string()
            } else {
                reason
            })
        }
        BridgeError::Dispatch => ApiError::service_unavailable(),
    }
}

pub(super) async fn bridge_call(action: &str, args: Value) -> Result<Value, ApiError> {
    bridge_call_with_timeout(action, args, bridge::DEFAULT_TIMEOUT).await
}

/// 同 `bridge_call`，但允许长耗时动作（如 AI 生成提交信息）放宽等待上限。
pub(super) async fn bridge_call_with_timeout(
    action: &str,
    args: Value,
    timeout: std::time::Duration,
) -> Result<Value, ApiError> {
    bridge::call_with_timeout(action, args, timeout)
        .await
        .map_err(api_error_from_bridge)
}

fn not_found() -> Response<Body> {
    json_response(
        StatusCode::NOT_FOUND,
        &json!({ "error": "接口不存在" }),
        Vec::new(),
    )
}
