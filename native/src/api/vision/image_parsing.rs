//! 消息内图片的文本化：缓存、进度事件与逐图描述替换。

use super::*;

pub(crate) fn global_cache() -> &'static VisionCache {
    static CACHE: std::sync::OnceLock<VisionCache> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| Arc::new(RwLock::new(HashMap::new())))
}

/// 通过主对话流回调推送一条视觉文本化进度事件。
///
/// 事件体为 JSON 字符串，`phase` 取值：
/// - `describing`：即将调用外挂视觉 API 描述第 index/total 张图片；
/// - `cached`：命中进程内 blake3 缓存，直接复用已有描述；
/// - `done`：单张图片文本化完成；
/// - `error`：单张图片文本化失败（随后整个请求将失败）；
/// - `cancel`：请求被用户中断，文本化提前结束（渲染进程据此清除状态卡）。
///
/// 渲染进程据此在消息区显示"视觉模型正在分析图片"的中间状态卡片。
fn emit_vision_status(
    on_chunk: Option<&ResponsesApiStreamCallback>,
    phase: &str,
    index: usize,
    total: usize,
    model: &str,
    error: Option<&str>,
) {
    let Some(on_chunk) = on_chunk else {
        return;
    };
    let mut payload = json!({
        "phase": phase,
        "index": index,
        "total": total,
    });
    if !model.is_empty() {
        payload["model"] = json!(model);
    }
    if let Some(error) = error {
        payload["error"] = json!(error);
    }
    on_chunk.call(
        ResponsesApiStreamChunk {
            content_delta: String::new(),
            thinking_delta: String::new(),
            content: String::new(),
            thinking: String::new(),
            retrying: false,
            retry_attempt: None,
            retry_error: None,
            stream_token_count: 0,
            thinking_token_count: 0,
            thinking_duration_ms: 0,
            elapsed_ms: 0,
            ttft_ms: 0,
            vision_status: Some(payload.to_string()),
        },
        ThreadsafeFunctionCallMode::NonBlocking,
    );
}

/// 文本化一段消息内容：把每张图片替换为视觉模型的文本描述。
///
/// `include_reference_blocks` 为 true 时（用户消息），还会为每张图片附加
/// 一行 `[Reference image #N for imagegen-generate: ...]` 引用块，让纯文本
/// 主模型在需要图生图/编辑时能把图片引用直接填进 imagegen-generate 的
/// `images` 参数。优先使用磁盘相对路径（`path`，几十字节）；仅对未持久化
/// 的内联 data URL 图片回退到完整 base64（`data`）。
///
/// 取消语义：每张图片开始前检查 `cancel_token`，已取消则推送 `cancel` 事件
/// 并携带当前已累积的文本提前返回（不抛错——调用方随后进入主模型流，流
/// 层会立即以 cancelled 状态结束）；正在进行的视觉 HTTP 请求由
/// `send_vision_stream` 的 `tokio::select!` 中断，同样走此分支。
pub(crate) async fn textify_parsed_content(
    parsed: &crate::api::conversation::images::ParsedChatMessageContent,
    client: &reqwest::Client,
    vision_config: &VisionApiConfig,
    include_reference_blocks: bool,
    on_chunk: Option<&ResponsesApiStreamCallback>,
    cancel_token: Option<&CancellationToken>,
) -> Result<String> {
    let mut result = String::with_capacity(parsed.text.len() + parsed.images.len() * 256);
    result.push_str(&parsed.text);

    if include_reference_blocks && !parsed.images.is_empty() {
        if !result.is_empty() && !result.ends_with('\n') {
            result.push('\n');
        }
        result.push_str(&format!(
            "[The user attached {} reference image(s). When the user asks to generate or edit an image based on them, call the imagegen-generate tool and pass the corresponding JSON object(s) below in its \"images\" parameter (image-to-image) — do NOT generate from the text description alone.]",
            parsed.images.len()
        ));
    }

    let total = parsed.images.len();
    // 并发上限（配置已夹在 1..=8，此处再兜底一次）
    let max_concurrency = vision_config.max_concurrency.max(1);

    // 用户中断：推送 cancel 事件让渲染进程立即回收状态卡，并携带
    // 已累积的文本提前返回。主模型流随后启动时会看到已取消的令牌，
    // 以 cancelled 状态正常收尾，不会把未文本化的图片发给主模型。
    if cancel_token.is_some_and(|token| token.is_cancelled()) {
        emit_vision_status(
            on_chunk,
            "cancel",
            1,
            total,
            &vision_config.model,
            None,
        );
        return Ok(result.trim().to_string());
    }

    // 先为每张图片构造请求 future（普通 Iterator::map 无 HRTB 约束，借用的
    // 生命周期统一为当前借用期），再用 stream::iter + buffer_unordered 以
    // 受限并发并行执行。每张图任务内按自身序号推送 describing / cached
    // 进度事件（完成顺序不定，但事件携带的 index 是图片序号，语义依然
    // 准确），最后按原顺序拼接输出块，保证结果顺序稳定。
    let futures_list: Vec<_> = parsed
        .images
        .iter()
        .enumerate()
        .map(|(index, image)| {
            // 引用块 JSON 在任务外预计算（用户消息才需要），随结果带回
            let reference_json = if include_reference_blocks {
                reference_image_json(image)
            } else {
                String::new()
            };
            async move {
                // 命中 blake3 内容缓存时直接复用已有描述（describe_image 内部仍会
                // 二次确认，此处预查仅为让进度事件准确区分 cached / describing）。
                let cache_key = blake3::hash(image.data.as_bytes()).to_hex().to_string();
                let cached = global_cache().read().await.contains_key(&cache_key);
                emit_vision_status(
                    on_chunk,
                    if cached { "cached" } else { "describing" },
                    index + 1,
                    total,
                    &vision_config.model,
                    None,
                );

                let description = describe_image(client, vision_config, image, &parsed.text, cancel_token).await;
                (index, reference_json, description)
            }
        })
        .collect();

    let outcomes: Vec<(usize, String, Result<String>)> = {
        use futures::StreamExt;
        futures::stream::iter(futures_list)
            .buffer_unordered(max_concurrency)
            .collect::<Vec<_>>()
            .await
    };

    // 按原图片顺序收集结果：任一失败则推送 error 事件并向上传播第一个错误
    // （与串行时"任一失败 → 整个请求失败"的语义保持一致）。
    for (index, reference_json, description) in outcomes {
        let description = match description {
            Ok(description) => description,
            Err(error) => {
                // 取消导致的错误（describe_image 内部 select! 中断）：与上面的
                // 取消分支一致，推送 cancel 事件并提前返回，不向上传播硬错误，
                // 避免整个请求被当作失败处理。
                if cancel_token.is_some_and(|token| token.is_cancelled()) {
                    emit_vision_status(
                        on_chunk,
                        "cancel",
                        index + 1,
                        total,
                        &vision_config.model,
                        None,
                    );
                    return Ok(result.trim().to_string());
                }
                // 真实失败：先推送 error 事件（渲染进程据此清除状态卡），
                // 再向上传播错误 —— 视觉文本化失败会使整个请求失败。
                emit_vision_status(
                    on_chunk,
                    "error",
                    index + 1,
                    total,
                    &vision_config.model,
                    Some(&error.to_string()),
                );
                return Err(error);
            }
        };
        emit_vision_status(
            on_chunk,
            "done",
            index + 1,
            total,
            &vision_config.model,
            None,
        );
        if !result.is_empty() && !result.ends_with('\n') {
            result.push('\n');
        }
        result.push_str("[Image description: ");
        result.push_str(&description);
        result.push(']');

        if !reference_json.is_empty() {
            result.push('\n');
            result.push_str(&format!(
                "[Reference image #{} for imagegen-generate: {}]",
                index + 1,
                reference_json
            ));
        }
    }

    Ok(result.trim().to_string())
}

/// 生成参考图的 JSON 引用对象（可直接作为 imagegen-generate `images` 数组元素）。
///
/// 优先 `path`（磁盘相对路径），上下文占用极小；仅在没有持久化路径时回退
/// 到完整 base64 `data`。
fn reference_image_json(image: &ChatImage) -> String {
    match &image.source {
        Some(source) => {
            let normalized = source.replace('\\', "/");
            format!(
                "{{\"path\":\"{}\",\"mimeType\":\"{}\"}}",
                normalized, image.media_type
            )
        }
        None => format!(
            "{{\"data\":\"{}\",\"mimeType\":\"{}\"}}",
            image.data, image.media_type
        ),
    }
}
