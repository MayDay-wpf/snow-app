//! 视觉模型的四种协议调用与流式解析。

use super::*;

/// 单个 SSE 事件的解析结果。
#[derive(Debug)]
enum VisionStreamEvent {
    /// 文本增量，直接追加到结果。
    Delta(String),
    /// 流结束标记；`truncated` 表示输出 token 预算耗尽被截断
    /// （chat `finish_reason=length` / responses `status=incomplete` /
    /// anthropic `stop_reason=max_tokens` / gemini `finishReason=MAX_TOKENS`）。
    End { truncated: bool },
    /// 事件与结果无关（元数据、思考增量等），忽略。
    Ignore,
}

/// 单次流式请求的收集结果。
struct VisionStreamOutcome {
    text: String,
    truncated: bool,
    /// 流意外结束（EOF 但未收到 [DONE]/finish 等结束事件）。调用方应将
    /// 有内容的结果标记为 partial（不写缓存），无内容视为错误。
    interrupted: bool,
}

/// 视觉调用的最终可用结果。
struct VisionResult {
    text: String,
    /// true 表示输出被截断、只拿到部分内容（不写入缓存）。
    partial: bool,
}

pub(crate) async fn describe_image(
    client: &reqwest::Client,
    vision_config: &VisionApiConfig,
    image: &ChatImage,
    user_prompt: &str,
    cancel_token: Option<&CancellationToken>,
) -> Result<String> {
    let cache_key = blake3::hash(image.data.as_bytes()).to_hex().to_string();

    if let Some(cached) = global_cache().read().await.get(&cache_key) {
        return Ok(cached.clone());
    }

    let result = match vision_config.request_method.as_str() {
        "chat" => {
            describe_image_via_chat(client, vision_config, image, user_prompt, cancel_token).await?
        }
        "responses" => {
            describe_image_via_responses(client, vision_config, image, user_prompt, cancel_token)
                .await?
        }
        "anthropic" => {
            describe_image_via_anthropic(client, vision_config, image, user_prompt, cancel_token)
                .await?
        }
        "gemini" | "interactions" => {
            describe_image_via_gemini(client, vision_config, image, user_prompt, cancel_token)
                .await?
        }
        method => {
            return Err(Error::from_reason(format!(
                "Unsupported vision request method: {method}. Supported: chat, responses, anthropic, gemini, interactions."
            )));
        }
    };

    let trimmed = result.text.trim().to_string();
    if result.partial {
        // 截断重试后仍只拿到部分内容：返回可用文本，但绝不写入缓存，
        // 避免后续对话复用残缺描述（issue #58 的缓存污染风险）。
        eprintln!(
            "Vision image description is partial (truncated after retry); not cached: hash {}...",
            cache_key.chars().take(16).collect::<String>()
        );
        return Ok(trimmed);
    }
    global_cache()
        .write()
        .await
        .insert(cache_key, trimmed.clone());
    Ok(trimmed)
}

fn build_vision_prompt(user_prompt: &str) -> String {
    let user_prompt = user_prompt.trim();
    if user_prompt.is_empty() {
        return DEFAULT_VISION_PROMPT.to_string();
    }
    format!(
        "{DEFAULT_VISION_PROMPT}\n\nUser context (use as additional guidance for what to focus on):\n{user_prompt}"
    )
}

async fn describe_image_via_chat(
    client: &reqwest::Client,
    vision_config: &VisionApiConfig,
    image: &ChatImage,
    user_prompt: &str,
    cancel_token: Option<&CancellationToken>,
) -> Result<VisionResult> {
    let endpoint = resolve_chat_endpoint(vision_config);
    let prompt = build_vision_prompt(user_prompt);
    let mut payload = json!({
        "model": vision_config.model,
        "messages": [{
            "role": "user",
            "content": [
                { "type": "text", "text": prompt },
                { "type": "image_url", "image_url": { "url": image.data_url } },
            ],
        }],
        "max_tokens": vision_config.max_tokens,
        "stream": true,
    });
    // 思考开关：开启时注入 reasoning_effort（仅当配置了具体强度）
    if vision_config.thinking_enabled && !vision_config.thinking_effort.is_empty() {
        payload["reasoning_effort"] = json!(vision_config.thinking_effort);
    }

    let headers = build_bearer_headers(&vision_config.api_key, &vision_config.custom_headers)?;
    vision_request_with_retry(
        client,
        &endpoint,
        headers,
        &mut payload,
        "chat",
        parse_chat_stream_event,
        cancel_token,
        &vision_config.retry_options,
        |payload| {
            payload["max_tokens"] = json!(vision_config.max_tokens * 2);
        },
    )
    .await
}

async fn describe_image_via_responses(
    client: &reqwest::Client,
    vision_config: &VisionApiConfig,
    image: &ChatImage,
    user_prompt: &str,
    cancel_token: Option<&CancellationToken>,
) -> Result<VisionResult> {
    let endpoint = resolve_responses_endpoint(vision_config);
    let prompt = build_vision_prompt(user_prompt);
    let mut payload = json!({
        "model": vision_config.model,
        "input": [{
            "type": "message",
            "role": "user",
            "content": [
                { "type": "input_text", "text": prompt },
                { "type": "input_image", "image_url": image.data_url },
            ],
        }],
        "max_output_tokens": vision_config.max_tokens,
        "stream": true,
        "store": false,
    });
    // 思考开关：开启时注入 reasoning.effort（仅当配置了具体强度）
    if vision_config.thinking_enabled && !vision_config.thinking_effort.is_empty() {
        payload["reasoning"] = json!({ "effort": vision_config.thinking_effort });
    }

    let headers = build_bearer_headers(&vision_config.api_key, &vision_config.custom_headers)?;
    vision_request_with_retry(
        client,
        &endpoint,
        headers,
        &mut payload,
        "responses",
        parse_responses_stream_event,
        cancel_token,
        &vision_config.retry_options,
        |payload| {
            payload["max_output_tokens"] = json!(vision_config.max_tokens * 2);
        },
    )
    .await
}

async fn describe_image_via_anthropic(
    client: &reqwest::Client,
    vision_config: &VisionApiConfig,
    image: &ChatImage,
    user_prompt: &str,
    cancel_token: Option<&CancellationToken>,
) -> Result<VisionResult> {
    let endpoint = resolve_anthropic_endpoint(vision_config);
    let prompt = build_vision_prompt(user_prompt);
    let mut payload = json!({
        "model": vision_config.model,
        "max_tokens": vision_config.max_tokens,
        "stream": true,
        "messages": [{
            "role": "user",
            "content": [
                { "type": "text", "text": prompt },
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": image.media_type,
                        "data": image.data,
                    },
                },
            ],
        }],
    });

    let headers = build_anthropic_headers(&vision_config.api_key, &vision_config.custom_headers)?;
    vision_request_with_retry(
        client,
        &endpoint,
        headers,
        &mut payload,
        "anthropic",
        parse_anthropic_stream_event,
        cancel_token,
        &vision_config.retry_options,
        |payload| {
            payload["max_tokens"] = json!(vision_config.max_tokens * 2);
        },
    )
    .await
}

async fn describe_image_via_gemini(
    client: &reqwest::Client,
    vision_config: &VisionApiConfig,
    image: &ChatImage,
    user_prompt: &str,
    cancel_token: Option<&CancellationToken>,
) -> Result<VisionResult> {
    let endpoint = resolve_gemini_endpoint(vision_config, &vision_config.api_key);
    let prompt = build_vision_prompt(user_prompt);
    let mut payload = json!({
        "contents": [{
            "role": "user",
            "parts": [
                { "text": prompt },
                {
                    "inlineData": {
                        "mimeType": image.media_type,
                        "data": image.data,
                    },
                },
            ],
        }],
        "generationConfig": {
            "maxOutputTokens": vision_config.max_tokens,
        },
    });

    if vision_config.thinking_enabled {
        payload["generationConfig"]["thinkingConfig"] = json!({
            "thinkingBudget": 1024
        });
    }

    // 谷歌搜索联网（Gemini 原生 grounding）：配置开启时注入 google_search 工具
    if vision_config.google_search {
        payload["tools"] = json!([{ "google_search": {} }]);
    }

    let headers = build_gemini_headers(&vision_config.custom_headers)?;
    vision_request_with_retry(
        client,
        &endpoint,
        headers,
        &mut payload,
        "gemini",
        parse_gemini_stream_event,
        cancel_token,
        &vision_config.retry_options,
        |payload| {
            payload["generationConfig"]["maxOutputTokens"] = json!(vision_config.max_tokens * 2);
        },
    )
    .await
}

fn resolve_chat_endpoint(vision_config: &VisionApiConfig) -> String {
    let normalized = normalize_base_url(&vision_config.base_url);
    if vision_config.base_url_mode == "endpoint" {
        return normalized;
    }
    format!(
        "{}/chat/completions",
        resolve_sdk_api_base_url(&normalized, &vision_config.base_url_mode)
    )
}

fn resolve_responses_endpoint(vision_config: &VisionApiConfig) -> String {
    let normalized = normalize_base_url(&vision_config.base_url);
    if vision_config.base_url_mode == "endpoint" {
        return normalized;
    }
    format!(
        "{}/responses",
        resolve_sdk_api_base_url(&normalized, &vision_config.base_url_mode)
    )
}

fn resolve_anthropic_endpoint(vision_config: &VisionApiConfig) -> String {
    let normalized = normalize_base_url(&vision_config.base_url);
    if vision_config.base_url_mode == "endpoint" {
        return normalized;
    }
    format!(
        "{}/messages",
        resolve_sdk_api_base_url(&normalized, &vision_config.base_url_mode)
    )
}

fn resolve_gemini_endpoint(vision_config: &VisionApiConfig, api_key: &str) -> String {
    let normalized = normalize_base_url(&vision_config.base_url);
    let resolved_base = if vision_config.base_url_mode == "endpoint" {
        normalized
    } else {
        resolve_sdk_api_base_url(&normalized, &vision_config.base_url_mode)
    };

    let clean_model = vision_config
        .model
        .strip_prefix("models/")
        .unwrap_or(&vision_config.model);

    // 流式生成：streamGenerateContent + alt=sse（SSE 事件流，与主模型一致）
    let mut url = format!(
        "{}/models/{}:streamGenerateContent?alt=sse",
        resolved_base, clean_model
    );

    if !api_key.is_empty() {
        url.push_str(&format!("&key={}", api_key));
    }
    url
}

fn build_bearer_headers(
    api_key: &str,
    custom_headers: &HashMap<String, String>,
) -> Result<HeaderMap> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(ACCEPT_ENCODING, HeaderValue::from_static("identity"));
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {}", api_key)).map_err(|error| {
            Error::from_reason(format!(
                "Invalid vision authorization header value: {error}"
            ))
        })?,
    );
    merge_custom_headers(
        &mut headers,
        custom_headers,
        &["content-type", "accept-encoding", "authorization"],
    );
    Ok(headers)
}

fn build_anthropic_headers(
    api_key: &str,
    custom_headers: &HashMap<String, String>,
) -> Result<HeaderMap> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(ACCEPT_ENCODING, HeaderValue::from_static("identity"));
    headers.insert(
        HeaderName::from_static("x-api-key"),
        HeaderValue::from_str(api_key).map_err(|error| {
            Error::from_reason(format!("Invalid vision API key header value: {error}"))
        })?,
    );
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {}", api_key)).map_err(|error| {
            Error::from_reason(format!(
                "Invalid vision authorization header value: {error}"
            ))
        })?,
    );
    merge_custom_headers(
        &mut headers,
        custom_headers,
        &[
            "content-type",
            "accept-encoding",
            "authorization",
            "x-api-key",
        ],
    );
    Ok(headers)
}

fn build_gemini_headers(custom_headers: &HashMap<String, String>) -> Result<HeaderMap> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(ACCEPT_ENCODING, HeaderValue::from_static("identity"));
    merge_custom_headers(
        &mut headers,
        custom_headers,
        &["content-type", "accept-encoding"],
    );
    Ok(headers)
}

fn merge_custom_headers(
    headers: &mut HeaderMap,
    custom_headers: &HashMap<String, String>,
    reserved: &[&str],
) {
    for (key, value) in custom_headers {
        let trimmed_key = key.trim();
        let trimmed_value = value.trim();
        if trimmed_key.is_empty() || trimmed_value.is_empty() {
            continue;
        }
        if reserved
            .iter()
            .any(|reserved| trimmed_key.eq_ignore_ascii_case(reserved))
        {
            continue;
        }
        if let (Ok(name), Ok(val)) = (
            trimmed_key.parse::<HeaderName>(),
            HeaderValue::from_str(trimmed_value),
        ) {
            headers.insert(name, val);
        }
    }
}

/// 发送一次流式视觉请求并收集结果（单次尝试，不含重试）。
///
/// 请求体必须已带 `stream: true`（gemini 用 `streamGenerateContent?alt=sse`
/// 端点）。按 SSE 分隔符切块，逐 `data:` 行交给 `parse` 处理：
/// - `Delta` → 累积文本增量；
/// - `End { truncated }` → 记录截断标记并结束流。
///
/// `cancel_token` 为 `Some` 时，请求发送与响应流读取都通过
/// `tokio::select!`（biased，取消优先）与取消令牌竞争；用户中断后立即
/// 丢弃在途 HTTP 请求并返回取消错误，避免继续等待视觉 API 响应。
async fn send_vision_stream(
    client: &reqwest::Client,
    endpoint: &str,
    headers: HeaderMap,
    payload: &Value,
    protocol: &str,
    parse: &impl Fn(&Value) -> VisionStreamEvent,
    cancel_token: Option<&CancellationToken>,
) -> Result<VisionStreamOutcome> {
    use futures::StreamExt;

    let response = {
        let send_future = client.post(endpoint).headers(headers).json(payload).send();
        match cancel_token {
            Some(token) => tokio::select! {
                biased;
                _ = token.cancelled() => {
                    return Err(Error::from_reason("Vision analysis cancelled"));
                }
                result = send_future => result,
            },
            None => send_future.await,
        }
    }
    .map_err(|error| Error::from_reason(format!("Failed to call vision API: {error}")))?;

    let status = response.status();
    if !status.is_success() {
        // 失败时把请求体一并带出，便于定位问题（例如上游报
        // "Invalid 'image_url' ... invalid base64-encoded value" 时，
        // 可以直接看到实际发出的 data URL 内容）。
        let body = response.text().await.unwrap_or_default();
        return Err(Error::from_reason(format!(
            "Vision API request failed: {} {}\n--- Request body ---\n{}",
            status,
            body.chars().take(500).collect::<String>(),
            summarize_vision_payload(payload)
        )));
    }

    let mut byte_buffer: Vec<u8> = Vec::new();
    let mut text = String::new();
    let mut truncated = false;
    let mut finished = false;

    let mut stream = response.bytes_stream();
    loop {
        // Idle timeout：超过 VISION_STREAM_IDLE_TIMEOUT_SEC 未收到任何数据即视为
        // 上游挂起，中止流并报错——否则 textify 会无限阻塞整个主对话请求。
        // 取消令牌通过 biased select! 优先响应，保证中断时快速返回。
        let next_chunk = match tokio::time::timeout(
            std::time::Duration::from_secs(VISION_STREAM_IDLE_TIMEOUT_SEC),
            async {
                match cancel_token {
                    Some(token) => {
                        let next = stream.next();
                        tokio::select! {
                            biased;
                            _ = token.cancelled() => {
                                Err(Error::from_reason("Vision textify aborted"))
                            }
                            chunk = next => match chunk {
                                Some(Ok(bytes)) => Ok(Some(bytes)),
                                Some(Err(error)) => Err(Error::from_reason(format!(
                                    "Failed to read vision API stream: {error}"
                                ))),
                                None => Ok(None), // EOF：无结束事件时由 interrupted 标记
                            },
                        }
                    }
                    None => match stream.next().await {
                        Some(Ok(bytes)) => Ok(Some(bytes)),
                        Some(Err(error)) => Err(Error::from_reason(format!(
                            "Failed to read vision API stream: {error}"
                        ))),
                        None => Ok(None),
                    },
                }
            },
        )
        .await
        {
            Ok(Ok(Some(chunk))) => chunk,
            Ok(Ok(None)) => break, // EOF：无结束事件时由 interrupted 标记
            Ok(Err(error)) => return Err(error),
            Err(_) => {
                return Err(Error::from_reason(format!(
                    "Vision {protocol} stream idle timeout (no data for {VISION_STREAM_IDLE_TIMEOUT_SEC}s)"
                )));
            }
        };
        byte_buffer.extend_from_slice(&next_chunk);

        // 逐块切出完整 SSE 事件（与主模型流共用 find_sse_separator，
        // 兼容 LF / CRLF 与多字节 UTF-8 跨 chunk 边界）。
        while let Some((separator_index, separator_len)) =
            crate::api::sse::find_sse_separator(&byte_buffer)
        {
            let block = String::from_utf8_lossy(&byte_buffer[..separator_index]).to_string();
            byte_buffer = byte_buffer[separator_index + separator_len..].to_vec();

            for line in block.lines() {
                let trimmed = line.trim_start();
                let Some(data) = trimmed.strip_prefix("data:") else {
                    continue;
                };
                let data = data.trim_start();
                if data.is_empty() {
                    continue;
                }
                if data == "[DONE]" {
                    finished = true;
                    continue;
                }
                let event = match serde_json::from_str::<Value>(data) {
                    Ok(event) => event,
                    Err(error) => {
                        eprintln!(
                            "Vision {protocol} stream event parse error (skipping line): {error}"
                        );
                        continue;
                    }
                };
                match parse(&event) {
                    VisionStreamEvent::Delta(delta) => text.push_str(&delta),
                    VisionStreamEvent::End {
                        truncated: is_truncated,
                    } => {
                        truncated = is_truncated;
                        finished = true;
                    }
                    VisionStreamEvent::Ignore => {}
                }
            }
            if finished {
                break;
            }
        }
        if finished {
            break;
        }
    }

    Ok(VisionStreamOutcome {
        text,
        truncated,
        interrupted: !finished,
    })
}

/// 生成请求体的精简预览，用于失败时定位问题。
///
/// 覆盖四种协议格式：
/// - chat:      `messages[].content[].image_url.url`
/// - responses: `input[].content[].image_url`（字符串形式）
/// - anthropic: `messages[].content[].source.data`
/// - gemini:    `contents[].parts[].inlineData.data`
///
/// 只输出每张图片 URL 的前 300 字符，避免把整张 base64 图片塞进错误信息。
/// 同时避免在错误路径上持有完整 base64 字符串：仅保存 (完整长度, 预览)。
fn summarize_vision_payload(payload: &Value) -> String {
    let mut images: Vec<(usize, String)> = Vec::new();

    // chat / anthropic 共用 messages[].content[]
    if let Some(messages) = payload.get("messages").and_then(|m| m.as_array()) {
        for msg in messages {
            let Some(content) = msg.get("content").and_then(|c| c.as_array()) else {
                continue;
            };
            for block in content {
                if let Some(url) = block.get("image_url") {
                    // chat: { "image_url": { "url": ... } }
                    if let Some(url_str) = url.get("url").and_then(|u| u.as_str()) {
                        let preview: String = url_str.chars().take(300).collect();
                        images.push((url_str.len(), preview));
                    } else if let Some(url_str) = url.as_str() {
                        let preview: String = url_str.chars().take(300).collect();
                        images.push((url_str.len(), preview));
                    }
                }
                // anthropic: { "source": { "media_type": ..., "data": ... } }
                if let Some(source) = block.get("source") {
                    if let Some(data) = source.get("data").and_then(|d| d.as_str()) {
                        let media_type = source
                            .get("media_type")
                            .and_then(|m| m.as_str())
                            .unwrap_or("unknown");
                        let preview: String = data.chars().take(300).collect();
                        images.push((data.len(), format!("data:{media_type};base64,{preview}")));
                    }
                }
            }
        }
    }

    // responses: input[].content[].image_url（字符串）
    if let Some(input) = payload.get("input").and_then(|i| i.as_array()) {
        for item in input {
            let Some(content) = item.get("content").and_then(|c| c.as_array()) else {
                continue;
            };
            for block in content {
                if let Some(url) = block.get("image_url").and_then(|u| u.as_str()) {
                    let preview: String = url.chars().take(300).collect();
                    images.push((url.len(), preview));
                }
            }
        }
    }

    // gemini: contents[].parts[].inlineData
    if let Some(contents) = payload.get("contents").and_then(|c| c.as_array()) {
        for item in contents {
            let Some(parts) = item.get("parts").and_then(|p| p.as_array()) else {
                continue;
            };
            for part in parts {
                if let Some(inline) = part.get("inlineData") {
                    if let Some(data) = inline.get("data").and_then(|d| d.as_str()) {
                        let mime_type = inline
                            .get("mimeType")
                            .and_then(|m| m.as_str())
                            .unwrap_or("unknown");
                        let preview: String = data.chars().take(300).collect();
                        images.push((data.len(), format!("data:{mime_type};base64,{preview}")));
                    }
                }
            }
        }
    }

    if images.is_empty() {
        return format!(
            "payload_size={} bytes, image_url fields not found in payload",
            payload.to_string().len()
        );
    }

    let mut summary = format!(
        "payload_size={} bytes, {} image(s)",
        payload.to_string().len(),
        images.len()
    );
    for (i, (full_len, preview)) in images.iter().enumerate() {
        summary.push_str(&format!(
            "\nimage[{i}] url_len={full_len} preview={preview:?}"
        ));
    }
    summary
}

/// 发送流式视觉请求；失败与截断分别复用重试机制：
///
/// - **请求失败**（网络中断 / 429 / 5xx / 流空闲超时等可重试错误）：
///   复用 `retry::should_retry` + `retry::wait_before_retry`，按主 API 档案的
///   `RetryOptions`（max_retries / 指数退避）重试；不可重试错误（4xx 参数
///   错误、取消等）立即向上传播；
/// - **截断时有部分内容 → 直接采用**（`partial = true`，不写缓存），**不再
///   翻倍重试**。流式下已实时收到文本，重试一轮只会让等待翻倍（旧实现的
///   双倍等待主因）；
/// - 截断且完全无内容 → 重试一次，`bump_max_tokens` 把 token 上限翻倍
///   （各协议字段路径不同）；
/// - 非截断但无内容 → 报可读错误。
///
/// `cancel_token` 为 `Some` 时，请求发送与流读取都会与取消令牌竞争
/// （`send_vision_stream` 内的 `tokio::select!`），用户中断后立即返回取消
/// 错误，不再发起重试。`None`（如 `describe_image_file` 工具入口）不参与
/// 取消，退避等待用本地永不取消的令牌适配。
async fn vision_request_with_retry(
    client: &reqwest::Client,
    endpoint: &str,
    headers: HeaderMap,
    payload: &mut Value,
    protocol: &str,
    parse: impl Fn(&Value) -> VisionStreamEvent,
    cancel_token: Option<&CancellationToken>,
    retry_options: &RetryOptions,
    bump_max_tokens: impl Fn(&mut Value),
) -> Result<VisionResult> {
    let mut transport_attempt = 0u32;
    let mut max_tokens_bumped = false;
    let fallback_token = CancellationToken::new();
    loop {
        if cancel_token.is_some_and(|token| token.is_cancelled()) {
            return Err(Error::from_reason("Vision analysis cancelled"));
        }
        let outcome = match send_vision_stream(
            client,
            endpoint,
            headers.clone(),
            payload,
            protocol,
            &parse,
            cancel_token,
        )
        .await
        {
            Ok(outcome) => outcome,
            Err(error) => {
                // 复用主请求的重试分类：网络中断 / 429 / 5xx / 流空闲超时等
                // 可重试错误按指数退避重试；不可重试（4xx 参数错误、取消等）
                // 立即向上传播。
                if !should_retry(&error, transport_attempt, retry_options) {
                    return Err(error);
                }
                eprintln!(
                    "Vision {protocol} request failed ({}), retrying (attempt {})",
                    error.reason,
                    transport_attempt + 1
                );
                wait_before_retry(
                    retry_options,
                    cancel_token.unwrap_or(&fallback_token),
                    transport_attempt,
                )
                .await?;
                transport_attempt += 1;
                continue;
            }
        };
        let text = outcome.text.trim().to_string();

        // 意外中断（EOF 无结束事件）：有内容 → 标记 partial（不写缓存），
        // 避免残缺描述污染 blake3 缓存；无内容 → 报错。
        if outcome.interrupted {
            if !text.is_empty() {
                eprintln!(
                    "Vision {protocol} stream interrupted; using partial content ({} chars, not cached)",
                    text.chars().count()
                );
                return Ok(VisionResult {
                    text,
                    partial: true,
                });
            }
            return Err(Error::from_reason(format!(
                "Vision {protocol} API stream ended unexpectedly (no content)"
            )));
        }

        if !outcome.truncated {
            if text.is_empty() {
                return Err(Error::from_reason(format!(
                    "Vision {protocol} API returned empty content (truncated=false)"
                )));
            }
            return Ok(VisionResult {
                text,
                partial: false,
            });
        }

        // 截断：有部分内容 → 及时止损，直接采用（不重试、不缓存）
        if !text.is_empty() {
            eprintln!(
                "Vision {protocol} response truncated; using partial content ({} chars, not cached)",
                text.chars().count()
            );
            return Ok(VisionResult {
                text,
                partial: true,
            });
        }

        // 截断且无内容 → 重试一次（翻倍 max_tokens）
        if !max_tokens_bumped {
            max_tokens_bumped = true;
            eprintln!(
                "Vision {protocol} response truncated (no content), retrying with doubled max_tokens"
            );
            bump_max_tokens(payload);
            continue;
        }
        return Err(Error::from_reason(format!(
            "Vision {protocol} API returned empty content after retry (truncated=true)"
        )));
    }
}

/// chat 流式事件：`choices[0].delta.content` 为增量；
/// `choices[0].finish_reason == "length"` 表示截断。
fn parse_chat_stream_event(event: &Value) -> VisionStreamEvent {
    let Some(choice) = event
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
    else {
        return VisionStreamEvent::Ignore;
    };
    if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
        if !reason.is_empty() {
            return VisionStreamEvent::End {
                truncated: reason == "length",
            };
        }
    }
    let delta = choice
        .get("delta")
        .and_then(|delta| delta.get("content"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if delta.is_empty() {
        VisionStreamEvent::Ignore
    } else {
        VisionStreamEvent::Delta(delta.to_string())
    }
}

/// responses 流式事件：`response.output_text.delta` 为增量；
/// `response.completed` 的 `status == "incomplete"` 表示截断。
fn parse_responses_stream_event(event: &Value) -> VisionStreamEvent {
    match event
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
    {
        "response.output_text.delta" => {
            let delta = event.get("delta").and_then(Value::as_str).unwrap_or("");
            if delta.is_empty() {
                VisionStreamEvent::Ignore
            } else {
                VisionStreamEvent::Delta(delta.to_string())
            }
        }
        "response.completed" => VisionStreamEvent::End {
            truncated: event
                .get("response")
                .and_then(|response| response.get("status"))
                .and_then(Value::as_str)
                .is_some_and(|status| status == "incomplete"),
        },
        _ => VisionStreamEvent::Ignore,
    }
}

/// anthropic 流式事件：`content_block_delta.delta.text` 为增量；
/// `message_delta.stop_reason == "max_tokens"` 表示截断。
fn parse_anthropic_stream_event(event: &Value) -> VisionStreamEvent {
    match event
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
    {
        "content_block_delta" => {
            let delta = event
                .get("delta")
                .and_then(|delta| delta.get("text"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if delta.is_empty() {
                VisionStreamEvent::Ignore
            } else {
                VisionStreamEvent::Delta(delta.to_string())
            }
        }
        "message_delta" => VisionStreamEvent::End {
            truncated: event
                .get("delta")
                .and_then(|delta| delta.get("stop_reason"))
                .and_then(Value::as_str)
                .is_some_and(|reason| reason == "max_tokens"),
        },
        "message_stop" => VisionStreamEvent::End { truncated: false },
        _ => VisionStreamEvent::Ignore,
    }
}

/// gemini 流式事件：`candidates[0].content.parts[].text` 为增量
/// （跳过 `thought: true` 的思考块）；`finishReason == "MAX_TOKENS"` 表示截断。
fn parse_gemini_stream_event(event: &Value) -> VisionStreamEvent {
    let Some(candidate) = event
        .get("candidates")
        .and_then(Value::as_array)
        .and_then(|candidates| candidates.first())
    else {
        return VisionStreamEvent::Ignore;
    };
    if let Some(reason) = candidate.get("finishReason").and_then(Value::as_str) {
        if !reason.is_empty() {
            return VisionStreamEvent::End {
                truncated: reason == "MAX_TOKENS",
            };
        }
    }
    let mut text = String::new();
    if let Some(parts) = candidate
        .get("content")
        .and_then(|content| content.get("parts"))
        .and_then(Value::as_array)
    {
        for part in parts {
            // 思考块（thought=true）与普通文本块都带 text 字段；
            // 视觉描述只需要最终文本，思考增量直接跳过。
            if part
                .get("thought")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                continue;
            }
            if let Some(delta) = part.get("text").and_then(Value::as_str) {
                text.push_str(delta);
            }
        }
    }
    if text.is_empty() {
        VisionStreamEvent::Ignore
    } else {
        VisionStreamEvent::Delta(text)
    }
}
