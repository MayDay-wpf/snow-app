use super::*;

use futures::StreamExt;
use serde_json::{json, Value};

use super::reference_image::emit_partial;
use super::super::bash::BashStreamCallback;

/// 解析 Gemini Interactions API 响应：`steps[]` 中 `model_output` 步骤的
/// `content[]` 块（`{type:"image", data, mime_type}`）。thought 步骤中的
/// 临时想法图被忽略。
pub(crate) fn parse_interactions_images(response_body: &Value) -> Vec<Value> {
    let mut content = Vec::new();
    let Some(steps) = response_body.get("steps").and_then(Value::as_array) else {
        return content;
    };
    for step in steps {
        if step.get("type").and_then(Value::as_str) != Some("model_output") {
            continue;
        }
        let Some(blocks) = step.get("content").and_then(Value::as_array) else {
            continue;
        };
        for block in blocks {
            if block.get("type").and_then(Value::as_str) != Some("image") {
                continue;
            }
            let Some(data) = block.get("data").and_then(Value::as_str) else {
                continue;
            };
            if data.trim().is_empty() {
                continue;
            }
            let mime_type = block
                .get("mime_type")
                .and_then(Value::as_str)
                .filter(|value| value.starts_with("image/"))
                .unwrap_or("image/png");
            content.push(json!({
                "type": "image",
                "data": data,
                "mimeType": mime_type,
            }));
        }
    }
    content
}

/// 消费 Gemini Interactions API 流式响应（SSE 事件流），边到达边推送预览。
///
/// 官方事件流（`stream: true`，Google「Streaming interactions」文档）：
/// `interaction.created` → 若干 step 周期（`step.start` → `step.delta`(s) →
/// `step.stop`）→ `interaction.completed` → 终止 `done`。
///
/// 生图只关心 `model_output` 步骤里 `delta.type == "image"` 的 base64 数据；
/// `thought` 步骤（思考草稿）与 `function_call` 步骤一律跳过，避免把中间想法
/// 当成成品图。未知事件类型按官方建议「log and skip」静默忽略。
pub(crate) async fn read_interactions_stream(
    response: reqwest::Response,
    on_chunk: &BashStreamCallback,
) -> napi::Result<Vec<Value>> {
    let mut stream = response.bytes_stream();
    let mut buffer: Vec<u8> = Vec::new();
    let mut all_images: Vec<Value> = Vec::new();
    let mut partial_index = 0usize;
    // 当前 step 的类型（step.start 设定，step.stop 清空）：用于判断 image delta
    // 是否来自 model_output（thought 步骤里的图片是中间草稿，必须丢弃）。
    let mut current_step_type: Option<String> = None;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| generic_error(format!("Stream read failed: {error}")))?;
        buffer.extend_from_slice(&chunk);

        loop {
            let Some(position) = buffer.iter().position(|&byte| byte == b'\n') else {
                break;
            };
            let line: Vec<u8> = buffer.drain(..=position).collect();
            let line_str = String::from_utf8_lossy(&line);
            process_interactions_stream_line(
                &line_str,
                &mut all_images,
                &mut partial_index,
                &mut current_step_type,
                on_chunk,
            );
        }
    }
    if !buffer.is_empty() {
        let line_str = String::from_utf8_lossy(&buffer);
        process_interactions_stream_line(
            &line_str,
            &mut all_images,
            &mut partial_index,
            &mut current_step_type,
            on_chunk,
        );
    }

    if all_images.is_empty() {
        return Err(generic_error(
            "Image generation stream ended without any image data".to_string(),
        ));
    }
    Ok(all_images)
}

/// 处理一行 Interactions SSE 数据。
///
/// 兼容两种载荷：带 `event_type` 字段的事件对象（REST 直接返回）与
/// 仅含数据的裸 JSON 行（部分中转实现）。两种形态都从 JSON 里读 `event_type`。
fn process_interactions_stream_line(
    line: &str,
    all_images: &mut Vec<Value>,
    partial_index: &mut usize,
    current_step_type: &mut Option<String>,
    on_chunk: &BashStreamCallback,
) {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed == "data: [DONE]" || trimmed == "[DONE]" {
        return;
    }
    let json_text = trimmed
        .strip_prefix("data:")
        .map(str::trim)
        .unwrap_or(trimmed);
    let Ok(event) = serde_json::from_str::<Value>(json_text) else {
        return;
    };

    match event.get("event_type").and_then(Value::as_str) {
        Some("step.start") => {
            // 记录当前步骤类型：只有 model_output 里的图片才是成品。
            *current_step_type = event
                .get("step")
                .and_then(|step| step.get("type"))
                .and_then(Value::as_str)
                .map(str::to_string);
        }
        Some("step.delta") => {
            let Some(delta) = event.get("delta") else {
                return;
            };
            if delta.get("type").and_then(Value::as_str) != Some("image") {
                return;
            }
            // thought 步骤的图片是模型中间草稿，不能作为生成结果推送。
            if current_step_type.as_deref() != Some("model_output") {
                return;
            }
            let Some(data) = delta.get("data").and_then(Value::as_str) else {
                return;
            };
            if data.trim().is_empty() {
                return;
            }
            let mime_type = delta
                .get("mime_type")
                .and_then(Value::as_str)
                .filter(|value| value.starts_with("image/"))
                .unwrap_or("image/png");
            emit_partial(on_chunk, *partial_index, mime_type, data);
            *partial_index += 1;
            all_images.push(json!({
                "type": "image",
                "data": data,
                "mimeType": mime_type,
            }));
        }
        Some("step.stop") => {
            *current_step_type = None;
        }
        Some("interaction.completed") => {
            // 协议内兜底：官方在 completed 里回传最终 interaction（含完整 steps）。
            // 若整条流没有出现过任何 image delta（个别实现只给汇总），用它的
            // model_output 步骤补全结果；已有增量时不重复取，避免同一张图推两次。
            if all_images.is_empty() {
                if let Some(interaction) = event.get("interaction") {
                    all_images.extend(parse_interactions_images(interaction));
                }
            }
        }
        // interaction.created / interaction.status_update / error 以及未来新增的
        // 事件类型：静默跳过（官方建议 log and skip，保持前向兼容）。
        _ => {}
    }
}

/// 解析 Gemini candidates[].content.parts[].inlineData。
pub(crate) fn parse_gemini_candidates(response_body: &Value) -> Vec<Value> {
    let mut content = Vec::new();
    if let Some(candidates) = response_body.get("candidates").and_then(Value::as_array) {
        for candidate in candidates {
            let Some(parts) = candidate
                .get("content")
                .and_then(|content| content.get("parts"))
                .and_then(Value::as_array)
            else {
                continue;
            };
            for part in parts {
                let Some(inline_data) = part.get("inlineData") else {
                    continue;
                };
                let Some(data) = inline_data.get("data").and_then(Value::as_str) else {
                    continue;
                };
                if data.trim().is_empty() {
                    continue;
                }
                let mime_type = inline_data
                    .get("mimeType")
                    .and_then(Value::as_str)
                    .filter(|value| value.starts_with("image/"))
                    .unwrap_or("image/png");
                content.push(json!({
                    "type": "image",
                    "data": data,
                    "mimeType": mime_type,
                }));
            }
        }
    }
    content
}

/// 消费 Gemini 流式响应（SSE / 逐行 JSON），边到达边推送预览。
pub(crate) async fn read_gemini_stream(
    response: reqwest::Response,
    on_chunk: &BashStreamCallback,
) -> napi::Result<Vec<Value>> {
    let mut stream = response.bytes_stream();
    let mut buffer: Vec<u8> = Vec::new();
    let mut all_images: Vec<Value> = Vec::new();
    let mut partial_index = 0usize;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| generic_error(format!("Stream read failed: {error}")))?;
        buffer.extend_from_slice(&chunk);

        loop {
            let Some(position) = buffer.iter().position(|&byte| byte == b'\n') else {
                break;
            };
            let line: Vec<u8> = buffer.drain(..=position).collect();
            let line_str = String::from_utf8_lossy(&line);
            process_gemini_stream_line(&line_str, &mut all_images, &mut partial_index, on_chunk);
        }
    }
    if !buffer.is_empty() {
        let line_str = String::from_utf8_lossy(&buffer);
        process_gemini_stream_line(&line_str, &mut all_images, &mut partial_index, on_chunk);
    }

    if all_images.is_empty() {
        return Err(generic_error(
            "Image generation stream ended without any image data".to_string(),
        ));
    }
    Ok(all_images)
}

fn process_gemini_stream_line(
    line: &str,
    all_images: &mut Vec<Value>,
    partial_index: &mut usize,
    on_chunk: &BashStreamCallback,
) {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed == "[DONE]" {
        return;
    }
    // SSE 包装（"data: {...}"）或裸 JSON 行都接受
    let json_text = trimmed
        .strip_prefix("data:")
        .map(str::trim)
        .unwrap_or(trimmed);
    let Ok(event) = serde_json::from_str::<Value>(json_text) else {
        return;
    };

    let images = parse_gemini_candidates(&event);
    for image in images {
        if let Some(data) = image.get("data").and_then(Value::as_str) {
            let mime_type = image
                .get("mimeType")
                .and_then(Value::as_str)
                .unwrap_or("image/png");
            emit_partial(on_chunk, *partial_index, mime_type, data);
            *partial_index += 1;
        }
        all_images.push(image);
    }
}

/// 将 Gemini 图片内容块汇总为统一结果。
pub(crate) fn collect_gemini_result(
    prompt: &str,
    model: &str,
    channel_label: &str,
    content: Vec<Value>,
) -> napi::Result<Value> {
    let generated = content.len();
    if generated == 0 {
        return Err(generic_error(
            "Image generation returned no image data".to_string(),
        ));
    }
    Ok(build_result(
        prompt,
        model,
        channel_label,
        generated,
        content,
        Vec::new(),
    ))
}
