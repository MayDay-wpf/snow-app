//! 桌面能力面板与运行偏好：技能 / MCP / 角色 / 权限、模式与模型切换。

use axum::body::Body;
use axum::http::{HeaderMap, Response, StatusCode};
use serde_json::{json, Value};

use super::super::limits::{MAX_GOAL_TOKEN_BUDGET, MAX_IDENTIFIER_LENGTH, REMOTE_MODES};
use super::super::request::{is_bounded_string, read_json_body, require_json};
use super::super::response::json_response;
use super::super::{ApiError, ServerContext};
use super::{bridge_call, ensure_current_pairing};

fn is_remote_mode(value: &str) -> bool {
    REMOTE_MODES.contains(&value)
}

async fn bridge_json(
    context: &ServerContext,
    generation: u64,
    action: &str,
) -> Result<Response<Body>, ApiError> {
    ensure_current_pairing(context, generation)?;
    let value = bridge_call(action, json!([])).await?;
    Ok(json_response(StatusCode::OK, &value, Vec::new()))
}

pub(super) async fn skills(
    context: &ServerContext,
    generation: u64,
) -> Result<Response<Body>, ApiError> {
    bridge_json(context, generation, "getSkills").await
}

pub(super) async fn mcp(
    context: &ServerContext,
    generation: u64,
) -> Result<Response<Body>, ApiError> {
    bridge_json(context, generation, "getMcpServers").await
}

pub(super) async fn sensitive_commands(
    context: &ServerContext,
    generation: u64,
) -> Result<Response<Body>, ApiError> {
    bridge_json(context, generation, "getSensitiveCommands").await
}

pub(super) async fn review(
    context: &ServerContext,
    generation: u64,
) -> Result<Response<Body>, ApiError> {
    bridge_json(context, generation, "getReview").await
}

pub(super) async fn codebase(
    context: &ServerContext,
    generation: u64,
) -> Result<Response<Body>, ApiError> {
    bridge_json(context, generation, "getCodebase").await
}

pub(super) async fn role(
    context: &ServerContext,
    generation: u64,
) -> Result<Response<Body>, ApiError> {
    bridge_json(context, generation, "getRole").await
}

pub(super) async fn permissions(
    context: &ServerContext,
    generation: u64,
) -> Result<Response<Body>, ApiError> {
    bridge_json(context, generation, "getPermissions").await
}

pub(super) async fn toggle_skill(
    context: &ServerContext,
    headers: &HeaderMap,
    body: &mut Option<Body>,
    generation: u64,
) -> Result<Response<Body>, ApiError> {
    require_json(headers)?;
    let payload = read_json_body(body.take()).await?;
    let skill_id = payload.get("skillId").and_then(Value::as_str);
    let enabled = payload.get("enabled").and_then(Value::as_bool);
    let directory_id = payload.get("directoryId");
    let directory_valid = match directory_id {
        None | Some(Value::Null) => true,
        Some(value) => value
            .as_str()
            .map(|text| is_bounded_string(text, false))
            .unwrap_or(false),
    };
    let valid = skill_id
        .map(|text| is_bounded_string(text, false))
        .unwrap_or(false)
        && enabled.is_some()
        && directory_valid;
    if !valid {
        return Err(ApiError::bad_request("Skill 请求无效"));
    }
    ensure_current_pairing(context, generation)?;
    let directory_arg = match directory_id {
        Some(Value::String(text)) => Value::String(text.clone()),
        _ => Value::Null,
    };
    let value = bridge_call(
        "setSkillEnabled",
        json!([skill_id, enabled, directory_arg]),
    )
    .await?;
    Ok(json_response(StatusCode::OK, &value, Vec::new()))
}

pub(super) async fn toggle_mcp(
    context: &ServerContext,
    headers: &HeaderMap,
    body: &mut Option<Body>,
    generation: u64,
) -> Result<Response<Body>, ApiError> {
    require_json(headers)?;
    let payload = read_json_body(body.take()).await?;
    let target = payload.get("target").and_then(Value::as_str);
    let id = payload.get("id").and_then(Value::as_str);
    let enabled = payload.get("enabled").and_then(Value::as_bool);
    let directory_id = payload.get("directoryId").and_then(Value::as_str);
    let valid = matches!(target, Some("server") | Some("tool"))
        && id
            .map(|text| is_bounded_string(text, false))
            .unwrap_or(false)
        && enabled.is_some()
        && directory_id
            .map(|text| is_bounded_string(text, false))
            .unwrap_or(false);
    if !valid {
        return Err(ApiError::bad_request("MCP 请求无效"));
    }
    ensure_current_pairing(context, generation)?;
    let value = bridge_call("setMcpEnabled", json!([target, id, enabled, directory_id])).await?;
    Ok(json_response(StatusCode::OK, &value, Vec::new()))
}

pub(super) async fn mode(
    headers: &HeaderMap,
    body: &mut Option<Body>,
) -> Result<Response<Body>, ApiError> {
    require_json(headers)?;
    let payload = read_json_body(body.take()).await?;
    let mode = payload.get("mode").and_then(Value::as_str);
    let Some(mode) = mode.filter(|value| is_remote_mode(value)) else {
        return Err(ApiError::bad_request(format!(
            "mode 必须是 {} 之一",
            REMOTE_MODES.join(" / ")
        )));
    };
    let enabled = match payload.get("enabled") {
        None => true,
        Some(Value::Bool(value)) => *value,
        Some(_) => return Err(ApiError::bad_request("enabled 必须是布尔值")),
    };
    let value = bridge_call("setMode", json!([mode, enabled])).await?;
    Ok(json_response(StatusCode::OK, &value, Vec::new()))
}

/// 目标模式 Token 预算（与桌面 PlusMenu 的预算输入同源）：0 = 无上限。
pub(super) async fn goal_budget(
    headers: &HeaderMap,
    body: &mut Option<Body>,
) -> Result<Response<Body>, ApiError> {
    require_json(headers)?;
    let payload = read_json_body(body.take()).await?;
    let budget = payload.get("budget").and_then(Value::as_i64);
    let Some(budget) = budget.filter(|value| (0..=MAX_GOAL_TOKEN_BUDGET).contains(value)) else {
        return Err(ApiError::bad_request(
            "budget 必须是 0 到 1000000000 之间的整数（0 = 无上限）",
        ));
    };
    let value = bridge_call("setGoalTokenBudget", json!([budget])).await?;
    Ok(json_response(StatusCode::OK, &value, Vec::new()))
}

/// 应用级开关：工具失败自动纠错（与桌面 PlusMenu 同一偏好源）。
pub(super) async fn tool_correction(
    headers: &HeaderMap,
    body: &mut Option<Body>,
) -> Result<Response<Body>, ApiError> {
    require_json(headers)?;
    let payload = read_json_body(body.take()).await?;
    let enabled = match payload.get("enabled") {
        Some(Value::Bool(value)) => *value,
        Some(_) => return Err(ApiError::bad_request("enabled 必须是布尔值")),
        None => return Err(ApiError::bad_request("enabled 必填且必须是布尔值")),
    };
    let value = bridge_call("setToolCorrection", json!([enabled])).await?;
    Ok(json_response(StatusCode::OK, &value, Vec::new()))
}

pub(super) async fn model(
    headers: &HeaderMap,
    body: &mut Option<Body>,
) -> Result<Response<Body>, ApiError> {
    require_json(headers)?;
    let payload = read_json_body(body.take()).await?;
    let provided: Vec<&str> = ["model", "profile", "thinkingStrength", "responsesFastMode"]
        .into_iter()
        .filter(|key| payload.get(*key).is_some())
        .collect();
    if provided.len() != 1 {
        return Err(ApiError::bad_request(
            "每次只能修改 model / profile / thinkingStrength / responsesFastMode 中的一项",
        ));
    }
    let value = match provided[0] {
        "model" => {
            let model = payload.get("model").and_then(Value::as_str);
            if model.map(|value| is_bounded_string(value, false)) != Some(true) {
                return Err(ApiError::bad_request(format!(
                    "model 必须是长度不超过 {MAX_IDENTIFIER_LENGTH} 的非空字符串"
                )));
            }
            bridge_call("setModel", json!([model])).await?
        }
        "profile" => {
            let profile = payload.get("profile").and_then(Value::as_str);
            if profile.map(|value| is_bounded_string(value, false)) != Some(true) {
                return Err(ApiError::bad_request(format!(
                    "profile 必须是长度不超过 {MAX_IDENTIFIER_LENGTH} 的非空字符串"
                )));
            }
            bridge_call("setApiProfile", json!([profile])).await?
        }
        "thinkingStrength" => {
            // 空串是合法值：表示继承 Profile 默认推理强度。
            let thinking = payload.get("thinkingStrength").and_then(Value::as_str);
            if thinking.map(|value| is_bounded_string(value, true)) != Some(true) {
                return Err(ApiError::bad_request(format!(
                    "thinkingStrength 必须是长度不超过 {MAX_IDENTIFIER_LENGTH} 的字符串"
                )));
            }
            bridge_call("setThinking", json!([thinking])).await?
        }
        _ => {
            let fast_mode = match payload.get("responsesFastMode") {
                Some(Value::String(text))
                    if matches!(text.trim(), "off" | "fast" | "ultrafast") =>
                {
                    Value::String(text.trim().to_string())
                }
                _ => {
                    return Err(ApiError::bad_request(
                        "responsesFastMode 必须是 off / fast / ultrafast",
                    ))
                }
            };
            bridge_call("toggleResponsesFastMode", json!([fast_mode])).await?
        }
    };
    Ok(json_response(StatusCode::OK, &value, Vec::new()))
}
