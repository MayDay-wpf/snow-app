//! 磁盘图片读取与视觉分析（image-describe 工具入口）。

use super::*;

/// 读取磁盘上的图片并用视觉模型分析（`image-describe` 工具入口）。
///
/// 路径校验：
/// - 绝对路径：直接读取（用户本地任意目录的图片，如项目中的 UI 设计稿）；
/// - 相对路径：必须位于 `upload/` 目录内（相对数据库文件所在目录），拒绝穿越。
///
/// 限制：单张 20MB 上限；仅接受图片扩展名。主模型支持视觉时直接复用主
/// 通道，否则回退到主 API 配置的 vision 通道（chat / responses /
/// anthropic / gemini）；结果走 [`describe_image`] 的 blake3 缓存（图片 + prompt）。
/// API 档案与自定义请求头跟随会话绑定（与主流程一致），无会话时用全局激活档案。
pub async fn describe_image_file(
    path: &str,
    user_prompt: &str,
    conversation_id: Option<&str>,
) -> Result<String> {
    use std::fs;

    let trimmed = path.trim().replace('\\', "/");
    if trimmed.is_empty() {
        return Err(Error::from_reason(
            "Image path must not be empty".to_string(),
        ));
    }

    // 1. 解析磁盘路径
    let file_path = if std::path::Path::new(&trimmed).is_absolute() {
        std::path::PathBuf::from(&trimmed)
    } else {
        if !trimmed.starts_with("upload/") || trimmed.contains("..") {
            return Err(Error::from_reason(format!(
                "Invalid image path: \"{path}\". Use an absolute file path (e.g. C:/path/to/design.png) or a relative path under the conversation's upload/ directory."
            )));
        }
        let database_path = snow_storage_core::bootstrap::ensure_database_file()?;
        database_path
            .parent()
            .unwrap_or_else(|| std::path::Path::new("."))
            .join(&trimmed)
    };

    // 2. 大小与类型校验
    const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
    let metadata = fs::metadata(&file_path).map_err(|error| {
        Error::from_reason(format!("Cannot read image file \"{path}\": {error}"))
    })?;
    if metadata.len() > MAX_IMAGE_BYTES {
        return Err(Error::from_reason(format!(
            "Image file \"{path}\" exceeds the {}MB size limit",
            MAX_IMAGE_BYTES / 1024 / 1024
        )));
    }
    let bytes = fs::read(&file_path).map_err(|error| {
        Error::from_reason(format!("Cannot read image file \"{path}\": {error}"))
    })?;
    let mime_type = guess_image_mime(&file_path);
    if !mime_type.starts_with("image/") {
        return Err(Error::from_reason(format!(
            "File \"{path}\" is not a supported image (detected {mime_type})"
        )));
    }

    // 3. 复用视觉管线（配置 + 客户端 + 缓存）：档案与请求头跟随会话绑定
    let database_path = snow_storage_core::bootstrap::ensure_database_file()?;
    let bound_profile = conversation_id.and_then(|id| {
        crate::storage::services::chat_conversations::get_conversation_api_profile(
            &database_path,
            id,
        )
        .ok()
        .flatten()
    });
    let context =
        crate::api::config::get_api_request_context_with_fallback(bound_profile.as_deref())?;
    // 会话级占位符（`{{session_id}}`）按当前会话展开，与主流程一致；无会话时置空
    let mut custom_headers = context.custom_headers;
    crate::api::common::expand_custom_header_session_id(
        &mut custom_headers,
        conversation_id.unwrap_or(""),
    );
    let mut vision_config = VisionApiConfig::from(&context.api_config, &custom_headers)?;
    // 与主流程一致：按会话绑定解析用户系统提示词（含项目级提示词）
    vision_config.system_prompts =
        crate::api::conversation::context::resolve_configured_system_prompts(
            &context.api_config.system_prompt_ids_json,
            conversation_id,
        )
        .await;
    let client = crate::api::http_client::build_proxied_client()
        .await
        .map_err(|error| {
            Error::from_reason(format!("Failed to create vision HTTP client: {error}"))
        })?;

    // 大图先降采样再送视觉模型（与主请求同一策略），避免 20MB 级原图拖垮
    // 发送阶段；降采样仅处理 PNG / JPEG，其余格式与未超限图片原样发送。
    let image = match crate::api::conversation::image_optimize::optimize_for_request(
        &bytes, &mime_type,
    ) {
        Some(optimized) => ChatImage {
            data_url: format!("data:{};base64,{}", optimized.media_type, optimized.data),
            media_type: optimized.media_type.to_string(),
            data: optimized.data,
            source: None,
        },
        None => {
            let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
            ChatImage {
                data_url: format!("data:{};base64,{}", mime_type, data),
                media_type: mime_type,
                data,
                source: None,
            }
        }
    };
    // 工具入口没有请求级取消令牌（工具执行取消走独立的 tool 注册表），
    // 因此不参与 select! 取消竞争，行为与之前一致。
    describe_image(&client, &vision_config, &image, user_prompt, None).await
}

/// 按扩展名猜测图片 MIME；不支持的类型返回 `application/octet-stream`。
fn guess_image_mime(path: &std::path::Path) -> String {
    let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
        return "application/octet-stream".to_string();
    };
    match ext.to_ascii_lowercase().as_str() {
        "png" => "image/png".to_string(),
        "jpg" | "jpeg" => "image/jpeg".to_string(),
        "webp" => "image/webp".to_string(),
        "gif" => "image/gif".to_string(),
        "bmp" => "image/bmp".to_string(),
        "svg" => "image/svg+xml".to_string(),
        _ => "application/octet-stream".to_string(),
    }
}
