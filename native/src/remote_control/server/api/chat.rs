//! 会话、消息与发送接口。

use axum::body::Body;
use axum::http::{HeaderMap, Response, StatusCode};
use serde_json::{json, Value};
use url::Url;

use super::super::limits::MAX_SEND_ATTACHMENTS;
use super::super::request::{
    is_bounded_string, query_param, read_json_body, require_json, string_array_field,
};
use super::super::response::json_response;
use super::super::{
    completed_send_result, send_tracker, store_completed_send, ApiError, ServerContext,
};
use super::attachments::api_error_from_attach;
use super::{bridge_call, ensure_current_pairing};
use crate::remote_control::attachments::{self, RemoteAttachmentContext};

pub(super) async fn state(
    context: &ServerContext,
    generation: u64,
) -> Result<Response<Body>, ApiError> {
    ensure_current_pairing(context, generation)?;
    let value = bridge_call("getState", json!([])).await?;
    Ok(json_response(StatusCode::OK, &value, Vec::new()))
}

pub(super) async fn messages(
    context: &ServerContext,
    url: &Url,
    generation: u64,
) -> Result<Response<Body>, ApiError> {
    ensure_current_pairing(context, generation)?;
    let conversation_id = query_param(url, "conversationId").unwrap_or_default();
    let before_message_id = query_param(url, "beforeMessageId").unwrap_or_default();
    let limit = match query_param(url, "limit") {
        None => Some(20i64),
        Some(raw) => raw.parse::<i64>().ok(),
    };
    let Some(limit) = limit else {
        return Err(ApiError::bad_request("消息分页参数无效"));
    };
    if !is_bounded_string(&conversation_id, false)
        || !is_bounded_string(&before_message_id, true)
        || !(1..=50).contains(&limit)
    {
        return Err(ApiError::bad_request("消息分页参数无效"));
    }
    let value = bridge_call(
        "getMessages",
        json!([conversation_id, before_message_id, limit]),
    )
    .await?;
    Ok(json_response(StatusCode::OK, &value, Vec::new()))
}

pub(super) async fn conversations(
    context: &ServerContext,
    url: &Url,
    generation: u64,
) -> Result<Response<Body>, ApiError> {
    ensure_current_pairing(context, generation)?;
    let directory_id = query_param(url, "directoryId").unwrap_or_default();
    let offset = match query_param(url, "offset") {
        None => Some(0i64),
        Some(raw) => raw.parse::<i64>().ok(),
    };
    let limit = match query_param(url, "limit") {
        None => Some(20i64),
        Some(raw) => raw.parse::<i64>().ok(),
    };
    let (Some(offset), Some(limit)) = (offset, limit) else {
        return Err(ApiError::bad_request("会话分页参数无效"));
    };
    if !is_bounded_string(&directory_id, false)
        || !(0..=100_000).contains(&offset)
        || !(1..=100).contains(&limit)
    {
        return Err(ApiError::bad_request("会话分页参数无效"));
    }
    let value = bridge_call("getConversations", json!([directory_id, limit, offset])).await?;
    Ok(json_response(StatusCode::OK, &value, Vec::new()))
}

pub(super) async fn send(
    context: &ServerContext,
    headers: &HeaderMap,
    body: &mut Option<Body>,
    generation: u64,
) -> Result<Response<Body>, ApiError> {
    require_json(headers)?;
    let payload = read_json_body(body.take()).await?;
    let Some(text) = payload.get("text").and_then(Value::as_str) else {
        return Err(ApiError::bad_request("text 必须是字符串"));
    };
    let attachment_ids = match string_array_field(payload.get("attachmentIds")) {
        Some(items) => items,
        None => return Err(ApiError::bad_request("附件或请求标识无效")),
    };
    let request_id = payload.get("requestId").and_then(Value::as_str);
    let ids_valid = attachment_ids
        .iter()
        .all(|id| is_bounded_string(id, false))
        && attachment_ids.len() <= MAX_SEND_ATTACHMENTS;
    let valid = ids_valid
        && request_id
            .map(|value| is_bounded_string(value, false))
            .unwrap_or(false);
    if !valid {
        return Err(ApiError::bad_request("附件或请求标识无效"));
    }
    let request_id = request_id.unwrap_or_default().to_string();
    ensure_current_pairing(context, generation)?;
    if let Some(cached) = completed_send_result(&request_id, generation) {
        return Ok(json_response(StatusCode::OK, &cached, Vec::new()));
    }
    let result = dispatch_remote_send(
        context,
        text.to_string(),
        attachment_ids,
        request_id,
        generation,
    )
    .await?;
    Ok(json_response(StatusCode::OK, &result, Vec::new()))
}

pub(super) async fn abort(
    headers: &HeaderMap,
    body: &mut Option<Body>,
) -> Result<Response<Body>, ApiError> {
    require_json(headers)?;
    let _ = read_json_body(body.take()).await?;
    let value = bridge_call("abort", json!([])).await?;
    Ok(json_response(StatusCode::OK, &value, Vec::new()))
}

pub(super) async fn pending(
    context: &ServerContext,
    headers: &HeaderMap,
    body: &mut Option<Body>,
    generation: u64,
) -> Result<Response<Body>, ApiError> {
    require_json(headers)?;
    let payload = read_json_body(body.take()).await?;
    let action = payload.get("action").and_then(Value::as_str);
    let index = payload.get("index").and_then(Value::as_i64);
    let queue_key = payload.get("queueKey");
    let valid_action = matches!(action, Some("send-now") | Some("withdraw"));
    if !valid_action {
        return Err(ApiError::bad_request("action 必须是 send-now 或 withdraw"));
    }
    let Some(index) = index.filter(|value| *value >= 0) else {
        return Err(ApiError::bad_request("index 必须是非负整数"));
    };
    let queue_key = match queue_key {
        None | Some(Value::Null) => Value::Null,
        Some(Value::String(text)) if is_bounded_string(text, false) => Value::String(text.clone()),
        _ => return Err(ApiError::bad_request("queueKey 必须是字符串或 null")),
    };
    ensure_current_pairing(context, generation)?;
    let bridge_action = if action == Some("send-now") {
        "sendPendingNow"
    } else {
        "withdrawPending"
    };
    let value = bridge_call(bridge_action, json!([index, queue_key])).await?;
    Ok(json_response(StatusCode::OK, &value, Vec::new()))
}

pub(super) async fn new_chat(
    headers: &HeaderMap,
    body: &mut Option<Body>,
) -> Result<Response<Body>, ApiError> {
    require_json(headers)?;
    let _ = read_json_body(body.take()).await?;
    let value = bridge_call("newChat", json!([])).await?;
    Ok(json_response(StatusCode::OK, &value, Vec::new()))
}

pub(super) async fn fork(
    context: &ServerContext,
    headers: &HeaderMap,
    body: &mut Option<Body>,
    generation: u64,
) -> Result<Response<Body>, ApiError> {
    require_json(headers)?;
    let payload = read_json_body(body.take()).await?;
    let conversation_id = payload
        .get("conversationId")
        .and_then(Value::as_str)
        .filter(|value| is_bounded_string(value, false));
    let Some(conversation_id) = conversation_id else {
        return Err(ApiError::bad_request("会话标识无效"));
    };
    // responseId 可缺省：空串表示派生整段会话（与桌面分支按钮一致）。
    let response_id = payload
        .get("responseId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if !is_bounded_string(response_id, true) {
        return Err(ApiError::bad_request("分支目标无效"));
    }
    ensure_current_pairing(context, generation)?;
    let value = bridge_call("forkConversation", json!([conversation_id, response_id])).await?;
    Ok(json_response(StatusCode::OK, &value, Vec::new()))
}

pub(super) async fn select(
    headers: &HeaderMap,
    body: &mut Option<Body>,
) -> Result<Response<Body>, ApiError> {
    require_json(headers)?;
    let payload = read_json_body(body.take()).await?;
    let conversation_id = payload.get("conversationId").and_then(Value::as_str);
    let directory_arg = match payload.get("directoryId") {
        None => Value::Null,
        Some(Value::String(text)) => Value::String(text.clone()),
        Some(_) => Value::Null,
    };
    let directory_valid = match payload.get("directoryId") {
        None => true,
        Some(Value::String(_)) => true,
        Some(_) => false,
    };
    if conversation_id.is_none() || !directory_valid {
        return Err(ApiError::bad_request("会话参数无效"));
    }
    let value = bridge_call("select", json!([conversation_id, directory_arg])).await?;
    Ok(json_response(StatusCode::OK, &value, Vec::new()))
}

/// 派发一次远程发送：绑定当前上下文、消费附件并缓存幂等结果。
async fn dispatch_remote_send(
    context: &ServerContext,
    text: String,
    attachment_ids: Vec<String>,
    request_id: String,
    generation: u64,
) -> Result<Value, ApiError> {
    send_tracker::acquire();
    let result = async {
        ensure_current_pairing(context, generation)?;
        let remote_state = bridge_call("getState", json!([])).await?;
        ensure_current_pairing(context, generation)?;
        let attachment_context = RemoteAttachmentContext::from_state(&remote_state);
        let value = bridge_call(
            "send",
            json!([
                text,
                attachment_ids,
                request_id,
                attachment_context.to_json(),
                generation
            ]),
        )
        .await?;
        attachments::mark_consumed(&attachment_ids, &attachment_context, generation)
            .await
            .map_err(api_error_from_attach)?;
        store_completed_send(request_id, generation, value.clone());
        Ok::<Value, ApiError>(value)
    }
    .await;
    send_tracker::release();
    result
}
