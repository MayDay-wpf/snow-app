//! 附件上传与丢弃。

use axum::body::Body;
use axum::http::{HeaderMap, Response, StatusCode};
use serde_json::json;

use super::super::request::{header_text, is_bounded_string, percent_decode};
use super::super::response::json_response;
use super::super::{send_tracker, ApiError, ServerContext};
use super::{bridge_call, ensure_current_pairing};
use crate::remote_control::attachments::{
    self, AttachError, AttachmentKind, RemoteAttachmentContext,
};

pub(super) fn api_error_from_attach(error: AttachError) -> ApiError {
    match error {
        AttachError::Code(code) => match code {
            attachments::ERR_INVALID_KIND => ApiError::bad_request("附件类型无效"),
            attachments::ERR_INVALID_MIME => {
                ApiError::new(StatusCode::UNSUPPORTED_MEDIA_TYPE, "附件 Content-Type 无效")
            }
            attachments::ERR_UNSUPPORTED_IMAGE_TYPE => ApiError::new(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "仅支持 PNG、JPEG、GIF 和 WebP 图片",
            ),
            attachments::ERR_TOO_MANY_ATTACHMENTS => ApiError::bad_request("每次最多选择 4 个附件"),
            attachments::ERR_ATTACHMENT_TOO_LARGE => {
                ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "附件超过大小或总容量限制")
            }
            attachments::ERR_EMPTY_ATTACHMENT => ApiError::bad_request("附件不能为空"),
            attachments::ERR_IMAGE_SIGNATURE_MISMATCH => {
                ApiError::bad_request("图片内容与格式不匹配")
            }
            attachments::ERR_IMAGE_DIMENSIONS_INVALID => {
                ApiError::bad_request("无法读取图片尺寸")
            }
            attachments::ERR_IMAGE_TOO_LARGE => {
                ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "图片像素尺寸过大")
            }
            attachments::ERR_INVALID_ATTACHMENT_IDS => ApiError::bad_request("附件列表无效"),
            attachments::ERR_ATTACHMENT_NOT_AVAILABLE => {
                ApiError::new(StatusCode::CONFLICT, "附件已失效，请重新选择")
            }
            _ => ApiError::service_unavailable(),
        },
        AttachError::Internal(_) => ApiError::service_unavailable(),
    }
}

pub(super) async fn create(
    context: &ServerContext,
    headers: &HeaderMap,
    body: &mut Option<Body>,
    generation: u64,
) -> Result<Response<Body>, ApiError> {
    send_tracker::acquire();
    let result = async {
        let remote_state = bridge_call("getState", json!([])).await?;
        ensure_current_pairing(context, generation)?;
        let attachment_context = RemoteAttachmentContext::from_state(&remote_state);
        let kind = header_text(headers, "x-snow-attachment-kind")
            .and_then(|value| AttachmentKind::from_header(&value))
            .ok_or_else(|| api_error_from_attach(AttachError::Code(attachments::ERR_INVALID_KIND)))?;
        let mime_type = header_text(headers, "content-type")
            .unwrap_or_default()
            .split(';')
            .next()
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase();
        let file_name =
            header_text(headers, "x-snow-file-name").unwrap_or_else(|| "attachment".to_string());
        let declared_length = match header_text(headers, "content-length") {
            None => None,
            Some(raw) => raw.trim().parse::<u64>().ok(),
        };
        let body = body.take().unwrap_or_else(Body::empty);
        let summary = attachments::save_attachment(
            kind,
            &mime_type,
            &file_name,
            declared_length,
            body,
            attachment_context,
            generation,
        )
        .await
        .map_err(api_error_from_attach)?;
        ensure_current_pairing(context, generation)?;
        Ok::<Response<Body>, ApiError>(json_response(
            StatusCode::CREATED,
            &summary.to_json(),
            Vec::new(),
        ))
    }
    .await;
    send_tracker::release();
    result
}

pub(super) async fn delete(
    context: &ServerContext,
    path: &str,
    generation: u64,
) -> Result<Response<Body>, ApiError> {
    let Some(id) = percent_decode(&path["/api/attachments/".len()..]) else {
        return Err(ApiError::bad_request("附件标识无效"));
    };
    if !is_bounded_string(&id, false) {
        return Err(ApiError::bad_request("附件标识无效"));
    }
    let remote_state = bridge_call("getState", json!([])).await?;
    ensure_current_pairing(context, generation)?;
    let attachment_context = RemoteAttachmentContext::from_state(&remote_state);
    attachments::discard(&id, &attachment_context, generation).await;
    Ok(json_response(
        StatusCode::OK,
        &json!({ "ok": true }),
        Vec::new(),
    ))
}
