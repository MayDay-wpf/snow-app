//! 对话内交互：待办、工作流、授权、提问与自定义指令。

use axum::body::Body;
use axum::http::{HeaderMap, Response, StatusCode};
use serde_json::{json, Value};

use super::super::limits::{
    MAX_IDENTIFIER_LENGTH, MAX_TODO_CONTENT_LENGTH, MAX_WORKFLOW_REPLY_LENGTH,
};
use super::super::request::{is_bounded_string, read_json_body, require_json, string_array_field};
use super::super::response::json_response;
use super::super::{ApiError, ServerContext};
use super::{bridge_call, ensure_current_pairing};

fn is_todo_content(value: &str) -> bool {
    !value.trim().is_empty() && value.chars().count() <= MAX_TODO_CONTENT_LENGTH
}

fn is_todo_status(value: &str) -> bool {
    matches!(value, "pending" | "inProgress" | "completed")
}

fn is_workflow_reply(value: &str) -> bool {
    !value.trim().is_empty() && value.chars().count() <= MAX_WORKFLOW_REPLY_LENGTH
}

pub(super) async fn todos(
    context: &ServerContext,
    headers: &HeaderMap,
    body: &mut Option<Body>,
    generation: u64,
) -> Result<Response<Body>, ApiError> {
    require_json(headers)?;
    let payload = read_json_body(body.take()).await?;
    let action = payload.get("action").and_then(Value::as_str);
    let content = payload.get("content").and_then(Value::as_str);
    let todo_id = payload.get("todoId").and_then(Value::as_str);
    let status = payload.get("status").and_then(Value::as_str);
    let is_add = action == Some("add");
    let is_update = action == Some("update");
    let is_delete = action == Some("delete");
    let valid = (is_add || is_update || is_delete)
        && (!is_add || content.map(is_todo_content).unwrap_or(false))
        && (is_add || todo_id.map(|value| is_bounded_string(value, false)).unwrap_or(false))
        && (!is_update || status.map(is_todo_status).unwrap_or(false));
    if !valid {
        return Err(ApiError::bad_request("待办请求无效"));
    }
    ensure_current_pairing(context, generation)?;
    // 未提供的字段直接省略（与旧实现 undefined 字段被 JSON 丢弃一致）。
    let mut payload_object = serde_json::Map::new();
    if is_add {
        if let Some(value) = content {
            payload_object.insert("content".to_string(), Value::String(value.to_string()));
        }
    } else {
        if let Some(value) = todo_id {
            payload_object.insert("todoId".to_string(), Value::String(value.to_string()));
        }
        if is_update {
            if let Some(value) = status {
                payload_object.insert("status".to_string(), Value::String(value.to_string()));
            }
        }
    }
    let value = bridge_call(
        "mutateTodos",
        json!([action, Value::Object(payload_object)]),
    )
    .await?;
    Ok(json_response(StatusCode::OK, &value, Vec::new()))
}

pub(super) async fn workflow(
    context: &ServerContext,
    headers: &HeaderMap,
    body: &mut Option<Body>,
    generation: u64,
) -> Result<Response<Body>, ApiError> {
    require_json(headers)?;
    let payload = read_json_body(body.take()).await?;
    let action = payload.get("action").and_then(Value::as_str);
    let flow_id = payload.get("flowId").and_then(Value::as_str);
    let message = payload.get("message").and_then(Value::as_str);
    let is_run = action == Some("run");
    let is_reply = action == Some("reply");
    let valid = (is_run || is_reply)
        && flow_id
            .map(|value| is_bounded_string(value, false))
            .unwrap_or(false)
        && (!is_reply || message.map(is_workflow_reply).unwrap_or(false));
    if !valid {
        return Err(ApiError::bad_request("工作流请求无效"));
    }
    ensure_current_pairing(context, generation)?;
    // 执行在渲染进程后台运行（立即返回，进度由 /api/state 轮询），
    // 反馈直接结算挂起的工具调用；两者都与桌面卡片按钮同语义。
    let value = if is_run {
        bridge_call("runWorkflow", json!([flow_id])).await?
    } else {
        bridge_call("replyWorkflow", json!([flow_id, message])).await?
    };
    Ok(json_response(StatusCode::OK, &value, Vec::new()))
}

pub(super) async fn authorization(
    headers: &HeaderMap,
    body: &mut Option<Body>,
) -> Result<Response<Body>, ApiError> {
    require_json(headers)?;
    let payload = read_json_body(body.take()).await?;
    let authorization_id = payload.get("authorizationId").and_then(Value::as_str);
    let decision = payload.get("decision").and_then(Value::as_str);
    let reason = match payload.get("reason") {
        None => None,
        Some(Value::String(text)) => Some(text.clone()),
        Some(_) => return Err(ApiError::bad_request("授权参数无效")),
    };
    let valid = authorization_id.is_some() && matches!(decision, Some("approve") | Some("reject"));
    if !valid {
        return Err(ApiError::bad_request("授权参数无效"));
    }
    let value = if decision == Some("approve") {
        bridge_call("approve", json!([authorization_id])).await?
    } else {
        bridge_call("reject", json!([authorization_id, reason])).await?
    };
    Ok(json_response(StatusCode::OK, &value, Vec::new()))
}

pub(super) async fn question(
    headers: &HeaderMap,
    body: &mut Option<Body>,
) -> Result<Response<Body>, ApiError> {
    require_json(headers)?;
    let payload = read_json_body(body.take()).await?;
    let question_id = payload.get("questionId").and_then(Value::as_str);
    let action = payload.get("action").and_then(Value::as_str);
    let selected_options = string_array_field(payload.get("selectedOptions"));
    let custom_answers = string_array_field(payload.get("customAnswers"));
    let valid = question_id.is_some()
        && matches!(action, Some("answer") | Some("cancel"))
        && selected_options
            .as_ref()
            .map(|items| items.len() <= 20)
            .unwrap_or(false)
        && custom_answers
            .as_ref()
            .map(|items| items.len() <= 20)
            .unwrap_or(false);
    if !valid {
        return Err(ApiError::bad_request("回答参数无效"));
    }
    let value = if action == Some("cancel") {
        bridge_call("cancelQuestion", json!([question_id])).await?
    } else {
        bridge_call(
            "answer",
            json!([question_id, selected_options, custom_answers]),
        )
        .await?
    };
    Ok(json_response(StatusCode::OK, &value, Vec::new()))
}

pub(super) async fn command(
    headers: &HeaderMap,
    body: &mut Option<Body>,
) -> Result<Response<Body>, ApiError> {
    require_json(headers)?;
    let payload = read_json_body(body.take()).await?;
    let command_id = payload.get("commandId").and_then(Value::as_str);
    if command_id.map(|value| is_bounded_string(value, false)) != Some(true) {
        return Err(ApiError::bad_request(format!(
            "commandId 必须是长度不超过 {MAX_IDENTIFIER_LENGTH} 的非空字符串"
        )));
    }
    let value = bridge_call("runCommand", json!([command_id])).await?;
    Ok(json_response(StatusCode::OK, &value, Vec::new()))
}
