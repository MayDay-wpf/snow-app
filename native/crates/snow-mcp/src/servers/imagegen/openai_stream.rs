use super::*;

use std::time::Duration;

use futures::StreamExt;
use serde_json::{json, Value};

use super::reference_image::emit_partial;
use super::super::bash::BashStreamCallback;

/// 逐行消费 SSE 响应体。OpenAI Images API 流式事件：
/// - `image_generation.partial_image`: { b64_json, partial_image_index }
/// - `image_generation.completed`: { data: [{b64_json|url}] }（部分实现）
pub(crate) async fn read_openai_sse(
    response: reqwest::Response,
    partials: &mut Vec<(usize, String)>,
    completed: &mut Vec<Value>,
    on_chunk: &BashStreamCallback,
    mime_type: &str,
) -> napi::Result<()> {
    let mut stream = response.bytes_stream();
    let mut buffer: Vec<u8> = Vec::new();
    let mut line_count = 0usize;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| generic_error(format!("Stream read failed: {error}")))?;
        buffer.extend_from_slice(&chunk);

        loop {
            let Some(position) = buffer.iter().position(|&byte| byte == b'\n') else {
                break;
            };
            let line: Vec<u8> = buffer.drain(..=position).collect();
            let line_str = String::from_utf8_lossy(&line);
            line_count += 1;
            process_openai_sse_line(&line_str, partials, completed, on_chunk, mime_type);
        }
    }
    // 处理末尾无换行的残留数据
    if !buffer.is_empty() {
        let line_str = String::from_utf8_lossy(&buffer);
        line_count += 1;
        process_openai_sse_line(&line_str, partials, completed, on_chunk, mime_type);
    }
    let _ = line_count;
    Ok(())
}

fn process_openai_sse_line(
    line: &str,
    partials: &mut Vec<(usize, String)>,
    completed: &mut Vec<Value>,
    on_chunk: &BashStreamCallback,
    mime_type: &str,
) {
    let trimmed = line.trim();
    if !trimmed.starts_with("data:") {
        return;
    }
    let data = trimmed[5..].trim();
    if data.is_empty() || data == "[DONE]" {
        return;
    }
    let Ok(event) = serde_json::from_str::<Value>(data) else {
        return;
    };
    match event.get("type").and_then(Value::as_str) {
        Some("image_generation.partial_image") => {
            let Some(b64) = event.get("b64_json").and_then(Value::as_str) else {
                return;
            };
            if b64.trim().is_empty() {
                return;
            }
            let index = event
                .get("partial_image_index")
                .and_then(Value::as_u64)
                .unwrap_or(0) as usize;
            partials.push((index, b64.to_string()));
            emit_partial(on_chunk, index, mime_type, b64);
        }
        Some("image_generation.completed") => {
            if let Some(items) = event.get("data").and_then(Value::as_array) {
                completed.extend(items.iter().cloned());
            }
        }
        _ => {}
    }
}

/// 将 OpenAI data 数组（b64_json / url）汇总为统一结果。
/// url 项会下载为图片二进制并转 base64 进 content（随后由
/// persist_generated_images 落盘到图库 + 索引，前端画廊直接展示、
/// 图库可查，不依赖预签名链接的存活期）；下载失败（超时/非图片/过大）
/// 时回退到 remote_urls 文本链接兜底，不阻断生成结果返回。
pub(crate) async fn collect_openai_result(
    prompt: &str,
    model: &str,
    channel_label: &str,
    items: Vec<Value>,
    mime_type: String,
) -> napi::Result<Value> {
    let client = build_client(None).await?;
    let mut content = Vec::new();
    let mut remote_urls = Vec::new();
    let mut generated = 0usize;
    for item in &items {
        // b64_json 可选：为空字符串或缺失时回退 url
        let b64 = item.get("b64_json").and_then(Value::as_str).unwrap_or("").trim();
        if !b64.is_empty() {
            generated += 1;
            content.push(json!({
                "type": "image",
                "data": b64,
                "mimeType": mime_type,
            }));
            continue;
        }
        let url = item.get("url").and_then(Value::as_str).unwrap_or("").trim();
        if url.is_empty() {
            continue;
        }
        generated += 1;
        match download_remote_image(&client, url).await {
            Some((bytes, detected_mime)) => {
                let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
                content.push(json!({
                    "type": "image",
                    "data": data,
                    "mimeType": detected_mime,
                }));
            }
            None => {
                // 下载失败：保留 URL，前端以文本链接兜底展示
                remote_urls.push(url.to_string());
            }
        }
    }

    if generated == 0 {
        let receipt: String = serde_json::to_string(&items)
            .unwrap_or_default()
            .chars()
            .take(300)
            .collect();
        return Err(generic_error(format!(
            "Image generation returned no image data: response has neither b64_json nor url (receipt: {receipt})"
        )));
    }

    Ok(build_result(
        prompt,
        model,
        channel_label,
        generated,
        content,
        remote_urls,
    ))
}

/// 下载远程图片（预签名 URL 等）为二进制。仅允许 http(s)，校验响应
/// Content-Type 必须为 image/*（缺失时按 URL 后缀推断），限制大小与超时；
/// 任何失败返回 None（由调用方回退为文本链接展示，不阻断生成结果返回）。
async fn download_remote_image(client: &reqwest::Client, url: &str) -> Option<(Vec<u8>, String)> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return None;
    }
    let response = client
        .get(url)
        .timeout(Duration::from_secs(REMOTE_IMAGE_TIMEOUT_SECS))
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let mime = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.split(';').next().unwrap_or("").trim().to_string())
        .filter(|value| value.starts_with("image/"))
        .unwrap_or_else(|| guess_mime_from_url(url));
    let bytes = response.bytes().await.ok()?;
    if bytes.is_empty() || bytes.len() > MAX_REMOTE_IMAGE_BYTES {
        return None;
    }
    Some((bytes.to_vec(), mime))
}

/// 按 URL 路径后缀推断图片 MIME（上游未返回 image/* Content-Type 时兜底）。
fn guess_mime_from_url(url: &str) -> String {
    let path = url.split('?').next().unwrap_or(url).to_ascii_lowercase();
    if path.ends_with(".png") {
        "image/png".to_string()
    } else if path.ends_with(".jpg") || path.ends_with(".jpeg") {
        "image/jpeg".to_string()
    } else if path.ends_with(".webp") {
        "image/webp".to_string()
    } else if path.ends_with(".gif") {
        "image/gif".to_string()
    } else if path.ends_with(".avif") {
        "image/avif".to_string()
    } else {
        "image/png".to_string()
    }
}
