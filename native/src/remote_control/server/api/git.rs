//! 移动端 Git 面板：只读查询与分支 / 工作树 / 暂存提交 / 同步动作。

use std::time::Duration;

use axum::body::Body;
use axum::http::{HeaderMap, Response, StatusCode};
use serde_json::{json, Value};
use url::Url;

use super::super::limits::{
    MAX_GIT_COMMIT_MESSAGE, MAX_GIT_PATH_LENGTH, MAX_GIT_PATHS, MAX_GIT_PATHS_TOTAL_CHARS,
    MAX_IDENTIFIER_LENGTH,
};
use super::super::request::{
    is_bounded_string, query_param, read_json_body, require_json, string_array_field,
};
use super::super::response::json_response;
use super::super::{ApiError, ServerContext};
use super::{bridge_call, bridge_call_with_timeout, ensure_current_pairing};

/// AI 生成提交信息要等桌面模型返回，等待上限与 Node / 移动端保持一致。
const GENERATE_COMMIT_MESSAGE_TIMEOUT: Duration = Duration::from_secs(120);

/// git ref（分支 / 起始基线）输入校验：与桌面 BranchSelector 的分支名规则一致。
fn is_git_ref_input(value: &str) -> bool {
    if value.is_empty() || value.trim() != value || value.chars().count() > MAX_IDENTIFIER_LENGTH {
        return false;
    }
    if value == "@"
        || value.starts_with('-')
        || value.starts_with('/')
        || value.ends_with('/')
        || value.ends_with('.')
    {
        return false;
    }
    if value.contains("..") || value.contains("//") || value.contains("@{") {
        return false;
    }
    if value
        .chars()
        .any(|ch| ch.is_control() || matches!(ch, ' ' | '~' | '^' | ':' | '?' | '*' | '[' | '\\'))
    {
        return false;
    }
    value
        .split('/')
        .all(|part| !part.is_empty() && !part.starts_with('.') && !part.ends_with(".lock"))
}

/// 仓库相对文件路径校验：拒绝控制字符、绝对路径与 `..` 段。
fn is_git_file_path(value: &str) -> bool {
    !value.is_empty()
        && value.chars().count() <= MAX_GIT_PATH_LENGTH
        && !value.chars().any(char::is_control)
        && !value.starts_with('/')
        && !value.starts_with('\\')
        && !value.split(['/', '\\']).any(|part| part == "..")
}

/// 暂存 / 取消暂存的文件列表：非空、数量与总长受限、逐项为仓库相对路径。
fn git_paths_field(value: Option<&Value>) -> Option<Vec<String>> {
    let paths = string_array_field(value)?;
    if paths.is_empty() || paths.len() > MAX_GIT_PATHS {
        return None;
    }
    let total: usize = paths.iter().map(|path| path.chars().count()).sum();
    if total > MAX_GIT_PATHS_TOTAL_CHARS || !paths.iter().all(|path| is_git_file_path(path)) {
        return None;
    }
    Some(paths)
}

/// Git 面板只读查询：仓库路径由渲染进程按当前工作区解析，手机端只传查询参数。
pub(super) async fn summary(
    context: &ServerContext,
    url: &Url,
    generation: u64,
) -> Result<Response<Body>, ApiError> {
    ensure_current_pairing(context, generation)?;
    let section = query_param(url, "section").unwrap_or_default();
    let value = match section.as_str() {
        "summary" => bridge_call("getGitSummary", json!([])).await?,
        "branches" => bridge_call("getGitBranches", json!([])).await?,
        "status" => bridge_call("getGitStatus", json!([])).await?,
        "diff" => {
            let file_path = query_param(url, "path").unwrap_or_default();
            if !is_git_file_path(&file_path) {
                return Err(ApiError::bad_request("文件路径无效"));
            }
            let staged = match query_param(url, "staged").as_deref() {
                None | Some("0") => false,
                Some("1") => true,
                Some(_) => return Err(ApiError::bad_request("staged 必须是 0 或 1")),
            };
            bridge_call("getGitDiff", json!([file_path, staged])).await?
        }
        _ => {
            return Err(ApiError::bad_request(
                "section 必须是 summary / branches / status / diff",
            ))
        }
    };
    Ok(json_response(StatusCode::OK, &value, Vec::new()))
}

/// Git 面板动作：分支切换 / 新建、工作树增删与绑定、暂存与提交、
/// 拉取与推送、AI 生成提交信息。
pub(super) async fn action(
    context: &ServerContext,
    headers: &HeaderMap,
    body: &mut Option<Body>,
    generation: u64,
) -> Result<Response<Body>, ApiError> {
    require_json(headers)?;
    let payload = read_json_body(body.take()).await?;
    ensure_current_pairing(context, generation)?;
    let action = payload
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let value = match action {
        "checkout" | "create-branch" => {
            let branch = payload
                .get("branch")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !is_git_ref_input(branch) {
                return Err(ApiError::bad_request("分支名称无效"));
            }
            if action == "checkout" {
                let remote = matches!(payload.get("remote"), Some(Value::Bool(true)));
                bridge_call("gitCheckout", json!([branch, remote])).await?
            } else {
                bridge_call("gitCreateBranch", json!([branch])).await?
            }
        }
        "stage" | "unstage" | "discard" => {
            let Some(paths) = git_paths_field(payload.get("paths")) else {
                return Err(ApiError::bad_request("文件列表无效"));
            };
            let bridge_action = match action {
                "stage" => "gitStage",
                "unstage" => "gitUnstage",
                _ => "gitDiscard",
            };
            bridge_call(bridge_action, json!([paths])).await?
        }
        "stage-all" => bridge_call("gitStageAll", json!([])).await?,
        "unstage-all" => bridge_call("gitUnstageAll", json!([])).await?,
        "commit" => {
            let message = payload
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if message.trim().is_empty() || message.chars().count() > MAX_GIT_COMMIT_MESSAGE {
                return Err(ApiError::bad_request(
                    "提交信息不能为空且不能超过 4000 个字符",
                ));
            }
            bridge_call("gitCommit", json!([message])).await?
        }
        "pull" => bridge_call("gitPull", json!([])).await?,
        "push" => bridge_call("gitPush", json!([])).await?,
        "generate-commit-message" => {
            // 手机端提交框内容同样作为生成偏好（语种/风格/草稿）透传。
            let hint = payload
                .get("hint")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if hint.chars().count() > MAX_GIT_COMMIT_MESSAGE {
                return Err(ApiError::bad_request("提交信息偏好不能超过 4000 个字符"));
            }
            bridge_call_with_timeout(
                "gitGenerateCommitMessage",
                json!([hint]),
                GENERATE_COMMIT_MESSAGE_TIMEOUT,
            )
            .await?
        }
        "create-worktree" => {
            let branch = payload
                .get("branch")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let base_ref = payload
                .get("baseRef")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !is_git_ref_input(branch) || !is_git_ref_input(base_ref) {
                return Err(ApiError::bad_request("分支名称或起始基线无效"));
            }
            bridge_call("gitCreateWorktree", json!([branch, base_ref])).await?
        }
        "remove-worktree" => {
            let worktree_id = payload
                .get("worktreeId")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !is_bounded_string(worktree_id, false) {
                return Err(ApiError::bad_request("工作树标识无效"));
            }
            bridge_call("gitRemoveWorktree", json!([worktree_id])).await?
        }
        "bind-worktree" => match payload.get("worktreeId") {
            None | Some(Value::Null) => bridge_call("gitBindWorktree", json!([Value::Null])).await?,
            Some(Value::String(worktree_id)) if is_bounded_string(worktree_id, false) => {
                bridge_call("gitBindWorktree", json!([worktree_id])).await?
            }
            _ => return Err(ApiError::bad_request("工作树标识无效")),
        },
        _ => {
            return Err(ApiError::bad_request(
                "action 必须是 checkout / create-branch / stage / unstage / stage-all / unstage-all / commit / pull / push / generate-commit-message / create-worktree / remove-worktree / bind-worktree",
            ))
        }
    };
    Ok(json_response(StatusCode::OK, &value, Vec::new()))
}
