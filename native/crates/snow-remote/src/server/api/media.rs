//! 输入框引用搜索与图片 / 主题资源分发。

use axum::body::Body;
use axum::http::{Response, StatusCode};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use serde_json::{json, Value};
use url::Url;

use super::super::limits::{MAX_MENTION_QUERY_CHARS, MAX_MESSAGE_IMAGE_BYTES, MESSAGE_IMAGE_TYPES};
use super::super::request::{is_bounded_string, percent_decode, query_param};
use super::super::response::{build_response, json_response};
use super::super::{ApiError, ServerContext};
use super::ensure_current_pairing;
use crate::remote_control::bridge;
use crate::remote_control::theme_asset::{self, THEME_ASSET_PATH_PREFIX};

/// 输入框 `@` 引用搜索：按 directoryId 解析工作区路径（手机端快照里的
/// 标识，不接受客户端直传路径），只在本机工作区遍历；SSH 工作区的文件
/// 通道在桌面端，这里只回 remote 标记。
pub(super) async fn mention(
    context: &ServerContext,
    url: &Url,
    generation: u64,
) -> Result<Response<Body>, ApiError> {
    ensure_current_pairing(context, generation)?;
    let query = query_param(url, "query").unwrap_or_default();
    let directory_id = query_param(url, "directoryId").unwrap_or_default();
    if query.chars().count() > MAX_MENTION_QUERY_CHARS
        || (!directory_id.is_empty() && !is_bounded_string(&directory_id, false))
    {
        return Err(ApiError::bad_request("引用搜索参数无效"));
    }
    let workspace_path = if directory_id.is_empty() {
        String::new()
    } else {
        tokio::task::spawn_blocking(move || -> Option<String> {
            let database_path = crate::storage::ensure_database_file().ok()?;
            let directories =
                crate::storage::services::workspace_directories::list_workspace_directories(
                    &database_path,
                )
                .ok()?;
            directories
                .into_iter()
                .find(|item| item.directory_id == directory_id)
                .map(|item| item.path)
        })
        .await
        .ok()
        .flatten()
        .unwrap_or_default()
    };
    let remote = workspace_path.starts_with("ssh://");
    let items = if workspace_path.is_empty() || remote {
        Vec::new()
    } else {
        tokio::task::spawn_blocking(move || {
            crate::remote_control::mention::search(&workspace_path, &query)
        })
        .await
        .unwrap_or_default()
    };
    Ok(json_response(
        StatusCode::OK,
        &json!({ "items": items, "remote": remote }),
        Vec::new(),
    ))
}

pub(super) async fn message_image(
    context: &ServerContext,
    path: &str,
    generation: u64,
) -> Result<Response<Body>, ApiError> {
    let parts: Vec<&str> = path["/api/message-images/".len()..].split('/').collect();
    let message_id = if parts.len() == 2 {
        percent_decode(parts[0])
    } else {
        None
    };
    let image_index = if parts.len() == 2 {
        parts[1].parse::<i64>().ok()
    } else {
        None
    };
    let (Some(message_id), Some(image_index)) = (message_id, image_index) else {
        return Err(ApiError::bad_request("图片标识无效"));
    };
    if !is_bounded_string(&message_id, false) || !(0..=20).contains(&image_index) {
        return Err(ApiError::bad_request("图片标识无效"));
    }
    ensure_current_pairing(context, generation)?;
    let image = resolve_message_image(&message_id, image_index).await;
    ensure_current_pairing(context, generation)?;
    let Some((mime_type, bytes)) = image else {
        return Ok(json_response(
            StatusCode::NOT_FOUND,
            &json!({ "error": "图片不可用" }),
            Vec::new(),
        ));
    };
    if bytes.is_empty() || bytes.len() > MAX_MESSAGE_IMAGE_BYTES {
        return Ok(json_response(
            StatusCode::NOT_FOUND,
            &json!({ "error": "图片不可用" }),
            Vec::new(),
        ));
    }
    Ok(build_response(
        StatusCode::OK,
        &mime_type,
        bytes,
        vec![
            ("Cache-Control", "private, no-store".to_string()),
            ("X-Content-Type-Options", "nosniff".to_string()),
            ("Referrer-Policy", "no-referrer".to_string()),
        ],
    ))
}

/// 工具结果图片（截图 / 抓取图）由 Rust 落盘为 upload/<日期>/<hash>.<ext>，
/// 手机端工具卡片按该路径取图；路径形态在存储层严格校验，拒绝越界访问。
pub(super) async fn upload_image(
    context: &ServerContext,
    path: &str,
    generation: u64,
) -> Result<Response<Body>, ApiError> {
    let relative_path =
        percent_decode(&path["/api/upload-images/".len()..]).map(|rest| format!("upload/{rest}"));
    ensure_current_pairing(context, generation)?;
    let image = match relative_path {
        Some(relative_path) => {
            tokio::task::spawn_blocking(move || crate::storage::read_upload_image(relative_path))
                .await
                .ok()
                .and_then(Result::ok)
                .flatten()
        }
        None => None,
    };
    ensure_current_pairing(context, generation)?;
    let Some((mime_type, bytes)) = image.filter(|(mime_type, bytes)| {
        MESSAGE_IMAGE_TYPES.contains(&mime_type.as_str()) && bytes.len() <= MAX_MESSAGE_IMAGE_BYTES
    }) else {
        return Ok(json_response(
            StatusCode::NOT_FOUND,
            &json!({ "error": "图片不可用" }),
            Vec::new(),
        ));
    };
    Ok(build_response(
        StatusCode::OK,
        &mime_type,
        bytes,
        vec![
            ("Cache-Control", "private, no-store".to_string()),
            ("X-Content-Type-Options", "nosniff".to_string()),
            ("Referrer-Policy", "no-referrer".to_string()),
        ],
    ))
}

/// 流式光标资源（自定义 SVG / 图片 / canvas 脚本）：手机端跟随桌面主题，
/// 只按文件名读取 ~/.snowapp/stream-cursors/，与桌面 theme-bg:// 同源。
pub(super) async fn theme_asset_file(
    context: &ServerContext,
    path: &str,
    generation: u64,
) -> Result<Response<Body>, ApiError> {
    ensure_current_pairing(context, generation)?;
    let asset = match percent_decode(&path[THEME_ASSET_PATH_PREFIX.len()..]) {
        Some(file_name) => theme_asset::read_theme_asset(&file_name).await,
        None => None,
    };
    ensure_current_pairing(context, generation)?;
    let Some((bytes, content_type)) = asset else {
        return Ok(json_response(
            StatusCode::NOT_FOUND,
            &json!({ "error": "资源不存在" }),
            Vec::new(),
        ));
    };
    Ok(build_response(
        StatusCode::OK,
        content_type,
        bytes,
        vec![
            ("Cache-Control", "private, no-store".to_string()),
            ("X-Content-Type-Options", "nosniff".to_string()),
            ("Referrer-Policy", "no-referrer".to_string()),
        ],
    ))
}

/// 校验桥返回的图片载荷（MIME 白名单 + 非空 base64）。
fn parse_image_payload(value: &Value) -> Option<(String, Vec<u8>)> {
    let mime_type = value.get("mimeType").and_then(Value::as_str)?;
    if !MESSAGE_IMAGE_TYPES.contains(&mime_type) {
        return None;
    }
    let base64 = value.get("base64").and_then(Value::as_str)?;
    if base64.is_empty() {
        return None;
    }
    let bytes = BASE64_STANDARD.decode(base64).ok()?;
    Some((mime_type.to_string(), bytes))
}

/// 解析消息图片：优先从桌面渲染进程的会话内存取（覆盖尚未落库的即时
/// 消息），失败时回退到 Rust 数据库 + upload 磁盘解析。
async fn resolve_message_image(message_id: &str, image_index: i64) -> Option<(String, Vec<u8>)> {
    if let Ok(value) = bridge::call("getMessageImage", json!([message_id, image_index])).await {
        if let Some(result) = parse_image_payload(&value) {
            return Some(result);
        }
    }
    let owned_id = message_id.to_string();
    let stored = tokio::task::spawn_blocking(move || {
        crate::storage::get_chat_message_image(owned_id, image_index as i32)
    })
    .await
    .ok()?
    .ok()??;
    if !MESSAGE_IMAGE_TYPES.contains(&stored.mime_type.as_str()) || stored.base64.is_empty() {
        return None;
    }
    let bytes = BASE64_STANDARD.decode(stored.base64).ok()?;
    Some((stored.mime_type, bytes))
}
