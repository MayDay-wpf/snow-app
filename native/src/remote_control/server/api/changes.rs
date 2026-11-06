//! 变更面板与回滚：diff 在原生侧计算，回滚动作经桥派发。

use axum::body::Body;
use axum::http::{HeaderMap, Response, StatusCode};
use serde_json::{json, Value};
use url::Url;

use super::super::limits::{
    MAX_CHANGE_PATH_LENGTH, MAX_IDENTIFIER_LENGTH, MAX_ROLLBACK_CHECKPOINTS,
    MAX_ROLLBACK_DIFF_BYTES, MAX_ROLLBACK_DIFF_FILES, MAX_ROLLBACK_DIFF_ROWS,
};
use super::super::request::{
    is_bounded_string, query_param, read_json_body, require_json, truncate_chars,
};
use super::super::response::json_response;
use super::super::{ApiError, ServerContext};
use super::{bridge_call, ensure_current_pairing};

/// 检查点 id 形态校验：`cp-{secs}-{nanos}-{count}`（由检查点服务生成）。
fn is_checkpoint_id(value: &str) -> bool {
    let Some(rest) = value.strip_prefix("cp-") else {
        return false;
    };
    let mut segments = 0;
    for segment in rest.split('-') {
        if segment.is_empty() || !segment.bytes().all(|byte| byte.is_ascii_digit()) {
            return false;
        }
        segments += 1;
    }
    segments == 3
}

/// 回滚方式白名单（必须与 renderer 的 RollbackMode 一致）。
fn is_rollback_mode(value: &str) -> bool {
    matches!(value, "conversation-only" | "conversation-and-files")
}

/// 变更归属匹配用的路径规范化：与桌面 normalizePath 一致
/// （反斜杠转正斜杠、去掉开头 ./、统一小写）。
fn normalize_change_path(path: &str) -> String {
    let slashed = path.replace('\\', "/").to_lowercase();
    match slashed.strip_prefix("./") {
        Some(rest) => rest.trim_start_matches('/').to_string(),
        None => slashed,
    }
}

/// 工具记录归属查找：与桌面 findFallbackChange 同语义（全等或 tool 路径以
/// 「/检查点路径」结尾）。
fn find_change_attribution<'a>(
    normalized: &str,
    fallback: &'a [(String, Value)],
) -> Option<&'a Value> {
    fallback
        .iter()
        .find(|(path, _)| path == normalized || path.ends_with(&format!("/{normalized}")))
        .map(|(_, item)| item)
}

/// 检查点变更类型映射：与桌面 toFileChangeKind 一致。
fn change_kind(change_type: &str) -> &'static str {
    match change_type {
        "added" => "create",
        "deleted" => "delete",
        _ => "edit",
    }
}

/// /changes 面板数据：桥下发的回滚链描述 + 原生检查点 diff。
/// 与桌面 FileChangesPanel 同源（includeAll=false，只列出回滚真正会恢复的
/// 文件），diff 由原生检查点服务直接计算（含 SSH/SFTP 通道），不把渲染进程
/// 拉进这次只读查询；代理归属按桌面规则从桥下发的工具记录匹配，链路不可用
/// 或计算失败时整份退回工具记录（与桌面同一兜底）。
pub(super) async fn list(
    context: &ServerContext,
    url: &Url,
    generation: u64,
) -> Result<Response<Body>, ApiError> {
    ensure_current_pairing(context, generation)?;
    let conversation_id = query_param(url, "conversationId");
    if let Some(value) = &conversation_id {
        if !is_bounded_string(value, false) {
            return Err(ApiError::bad_request("会话标识无效"));
        }
    }
    let argument = conversation_id.map(Value::String).unwrap_or(Value::Null);
    // 桥只回链路描述与工具记录；diff 与 +/- 统计在原生侧算（SSH 下可能
    // 超过桥调用的 12 秒上限）。
    let descriptor = bridge_call("getChanges", json!([argument])).await?;
    let value = build_changes_payload(descriptor).await;
    Ok(json_response(StatusCode::OK, &value, Vec::new()))
}

async fn build_changes_payload(descriptor: Value) -> Value {
    let conversation_id = descriptor
        .get("conversationId")
        .cloned()
        .unwrap_or(Value::Null);
    let fallback = descriptor
        .get("changes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let checkpoint_ids: Vec<String> = descriptor
        .get("checkpointIds")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let work_dir = descriptor
        .get("workDir")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let chain_usable = !work_dir.is_empty()
        && !checkpoint_ids.is_empty()
        && checkpoint_ids.len() <= MAX_ROLLBACK_CHECKPOINTS
        && checkpoint_ids.iter().all(|id| is_checkpoint_id(id));

    if chain_usable {
        if let Ok(summaries) = crate::exports::checkpoint::list_checkpoint_summaries_batch(
            checkpoint_ids,
            work_dir,
            Some(false),
        )
        .await
        {
            let attributed: Vec<(String, Value)> = fallback
                .iter()
                .map(|item| {
                    (
                        normalize_change_path(
                            item.get("path").and_then(Value::as_str).unwrap_or_default(),
                        ),
                        item.clone(),
                    )
                })
                .collect();
            let changes: Vec<Value> = summaries
                .into_iter()
                .map(|summary| {
                    let normalized = normalize_change_path(&summary.path);
                    let matched = find_change_attribution(&normalized, &attributed);
                    json!({
                        "path": truncate_chars(&summary.path, MAX_CHANGE_PATH_LENGTH),
                        "kind": change_kind(&summary.change_type),
                        "agent": matched
                            .and_then(|item| item.get("agent").and_then(Value::as_str))
                            .unwrap_or("main"),
                        "subAgentName": matched
                            .and_then(|item| item.get("subAgentName").and_then(Value::as_str)),
                        "additions": summary.additions,
                        "deletions": summary.deletions,
                    })
                })
                .collect();
            return json!({ "conversationId": conversation_id, "changes": changes });
        }
    }

    json!({ "conversationId": conversation_id, "changes": fallback })
}

pub(super) async fn state(
    context: &ServerContext,
    generation: u64,
) -> Result<Response<Body>, ApiError> {
    ensure_current_pairing(context, generation)?;
    let value = bridge_call("getRollbackState", json!([])).await?;
    Ok(json_response(StatusCode::OK, &value, Vec::new()))
}

pub(super) async fn rollback(
    context: &ServerContext,
    headers: &HeaderMap,
    body: &mut Option<Body>,
    generation: u64,
) -> Result<Response<Body>, ApiError> {
    require_json(headers)?;
    let payload = read_json_body(body.take()).await?;
    let action = payload.get("action").and_then(Value::as_str);

    if action == Some("diff") || action == Some("diff-page") {
        // 文件变更直接在原生侧计算：与桌面共用同一套检查点服务（含
        // SSH/SFTP 通道与执行级目录锁），无需把渲染进程拉进这次只读查询。
        // diff 返回文件摘要列表；diff-page 按文件读取明细的首页。
        let Some(work_dir) = payload
            .get("workDir")
            .and_then(Value::as_str)
            .filter(|value| is_bounded_string(value, false))
        else {
            return Err(ApiError::bad_request("回滚工作目录无效"));
        };
        let checkpoint_ids = payload
            .get("checkpointIds")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect::<Vec<String>>()
            })
            .filter(|ids| {
                !ids.is_empty()
                    && ids.len() <= MAX_ROLLBACK_CHECKPOINTS
                    && ids.iter().all(|id| is_checkpoint_id(id))
            });
        let Some(checkpoint_ids) = checkpoint_ids else {
            return Err(ApiError::bad_request("回滚检查点无效"));
        };
        let to_conflict = |error: napi::Error| {
            ApiError::conflict(truncate_chars(&error.to_string(), MAX_IDENTIFIER_LENGTH))
        };

        if action == Some("diff-page") {
            let Some(file_path) = payload
                .get("path")
                .and_then(Value::as_str)
                .filter(|value| is_bounded_string(value, false))
            else {
                return Err(ApiError::bad_request("回滚文件路径无效"));
            };
            ensure_current_pairing(context, generation)?;
            let page = crate::exports::checkpoint::read_checkpoint_diff_page(
                checkpoint_ids,
                work_dir.to_string(),
                file_path.to_string(),
                0,
                MAX_ROLLBACK_DIFF_ROWS,
                MAX_ROLLBACK_DIFF_BYTES,
            )
            .await
            .map_err(to_conflict)?;
            return Ok(json_response(
                StatusCode::OK,
                &json!({
                    "content": page.content,
                    "isBinary": page.is_binary,
                    "tooLarge": page.too_large,
                    "truncated": page.next_row < page.total_rows,
                }),
                Vec::new(),
            ));
        }

        ensure_current_pairing(context, generation)?;
        // include_all=false：与确认回滚时实际会恢复的文件范围一致。
        let summaries = crate::exports::checkpoint::list_checkpoint_summaries_batch(
            checkpoint_ids,
            work_dir.to_string(),
            Some(false),
        )
        .await
        .map_err(to_conflict)?;
        let items: Vec<Value> = summaries
            .into_iter()
            .take(MAX_ROLLBACK_DIFF_FILES)
            .map(|summary| {
                json!({
                    "path": summary.path,
                    "changeType": summary.change_type,
                    "isBinary": summary.is_binary,
                    "tooLarge": summary.too_large,
                    "additions": summary.additions,
                    "deletions": summary.deletions,
                })
            })
            .collect();
        return Ok(json_response(
            StatusCode::OK,
            &json!({ "files": items }),
            Vec::new(),
        ));
    }

    let Some(message_id) = payload
        .get("messageId")
        .and_then(Value::as_str)
        .filter(|value| is_bounded_string(value, false))
    else {
        return Err(ApiError::bad_request("回滚目标无效"));
    };
    if !matches!(action, Some("preview") | Some("confirm") | Some("cancel")) {
        return Err(ApiError::bad_request(
            "action 必须是 preview / confirm / cancel / diff / diff-page",
        ));
    }
    ensure_current_pairing(context, generation)?;
    let value = match action {
        Some("preview") => bridge_call("startRollback", json!([message_id])).await?,
        Some("cancel") => bridge_call("cancelRollback", json!([message_id])).await?,
        _ => {
            let mode = payload.get("mode").and_then(Value::as_str);
            let Some(mode) = mode.filter(|value| is_rollback_mode(value)) else {
                return Err(ApiError::bad_request("回滚方式无效"));
            };
            let delete_memories = payload
                .get("deleteMemories")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            bridge_call("confirmRollback", json!([message_id, mode, delete_memories])).await?
        }
    };
    Ok(json_response(StatusCode::OK, &value, Vec::new()))
}
