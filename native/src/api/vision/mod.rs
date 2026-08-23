pub(crate) use base64::Engine;
pub(crate) use std::collections::HashMap;
pub(crate) use std::path::Path;
pub(crate) use std::sync::Arc;

pub(crate) use napi::bindgen_prelude::*;
pub(crate) use napi::threadsafe_function::ThreadsafeFunctionCallMode;
pub(crate) use reqwest::header::{
    HeaderMap, HeaderName, HeaderValue, ACCEPT_ENCODING, AUTHORIZATION, CONTENT_TYPE,
};
pub(crate) use serde_json::{json, Value};
pub(crate) use tokio::sync::RwLock;
pub(crate) use tokio_util::sync::CancellationToken;

pub(crate) use crate::api::config::{normalize_base_url, resolve_sdk_api_base_url};
pub(crate) use crate::api::conversation::images::{parse_chat_message_content, ChatImage};
pub(crate) use crate::api::responses::{ResponsesApiStreamCallback, ResponsesApiStreamChunk};
pub(crate) use crate::api::retry::{should_retry, wait_before_retry, RetryOptions};
pub(crate) use crate::storage::services::chat_conversations::ChatContextMessage;
pub(crate) use crate::storage::ApiConfigRecord;

mod file_read;
mod image_parsing;
mod providers;

pub(crate) use file_read::describe_image_file;
pub(crate) use image_parsing::{global_cache, textify_parsed_content};
pub(crate) use providers::describe_image;

/// 视觉文本化的默认提示词前缀，引导视觉模型输出结构化描述。
pub(crate) const DEFAULT_VISION_PROMPT: &str = "Please describe this image in detail. Focus on text content, layout, visual elements, colors, and any notable features. If the image contains code, diagrams, or technical content, describe them precisely. Output in the same language as the user's prompt.";

/// 视觉流式响应的空闲超时（秒）。超过此时长未收到任何数据则视为上游挂起，
/// 中止流并报错——否则 textify 会无限阻塞整个主对话请求。
pub(crate) const VISION_STREAM_IDLE_TIMEOUT_SEC: u64 = 60;

/// 进程内缓存：避免同一张图片在多轮对话中重复调用视觉模型。
/// Key 为图片 base64 数据的 blake3 哈希，Value 为文本化结果。
pub(crate) type VisionCache = Arc<RwLock<HashMap<String, String>>>;

/// 判断当前 API 配置是否需要视觉文本化。
///
/// 触发条件：主模型不支持视觉 (`supports_vision == false`) 且
/// 配置了有效的视觉 API（`vision_api_key` 非空、`vision_model` 非空、
/// `vision_request_method` 属于四种支持的类型）。
pub fn should_textify_images(api_config: &ApiConfigRecord) -> bool {
    if api_config.supports_vision {
        return false;
    }

    let api_key = api_config.vision_api_key.trim();
    let model = api_config.vision_model.trim();
    let request_method = api_config.vision_request_method.trim();

    if api_key.is_empty() || model.is_empty() {
        return false;
    }

    matches!(
        request_method,
        "chat" | "responses" | "anthropic" | "gemini" | "interactions"
    )
}

/// 对消息列表中的图片进行视觉文本化。
///
/// 当 `should_textify_images` 返回 false 或 `skip_context` 为 true 时直接返回原消息。
/// 否则遍历每条消息，解析其中的 `@@image:...@@` 标签，对每张图片调用视觉模型
/// 获取文本描述，然后将图片标签替换为文本描述。
///
/// 该函数是异步的，不会阻塞 Node.js 主线程。子代理和主对话共用此入口。
///
/// `custom_headers` 复用主 API 上下文已解析的自定义请求头，避免重复查询数据库。
///
/// `on_chunk` 为主对话的流回调（`None` 时静默跳过事件推送）：文本化每张
/// 图片期间会通过它推送 `vision_status` 进度事件（describing / cached /
/// done / error / cancel），让渲染进程在消息区显示"视觉模型正在分析图片"
/// 的中间状态，并在全部完成、出错或用户取消时清除该状态卡。
///
/// `cancel_token` 为请求级取消令牌（流尚未注册时由 `create_and_register`
/// 生成的已取消令牌）：用户在中途中断时，文本化会在下一张图片前或正在
/// 进行的视觉 HTTP 请求中（`send_vision_stream` 的 `tokio::select!`）立即
/// 停止，并推送一条 `cancel` 事件让渲染进程回收状态卡，而不是继续消耗
/// 视觉 API 调用。`None` 表示不参与取消（如无请求上下文的工具入口）。
pub async fn textify_images_in_messages(
    messages: &mut [ChatContextMessage],
    database_path: &Path,
    api_config: &ApiConfigRecord,
    custom_headers: &HashMap<String, String>,
    skip_context: bool,
    on_chunk: Option<&ResponsesApiStreamCallback>,
    cancel_token: Option<&CancellationToken>,
) -> Result<()> {
    if skip_context || !should_textify_images(api_config) {
        return Ok(());
    }

    let vision_config = VisionApiConfig::from(api_config, custom_headers)?;
    let client = crate::api::http_client::build_proxied_client()
        .await
        .map_err(|error| {
            Error::from_reason(format!("Failed to create vision HTTP client: {error}"))
        })?;

    for message in messages.iter_mut() {
        // 工具结果消息：视觉文本化必须同时作用到 `tool_results_json` 的每个
        // 结构化 result 块。各 provider 构造请求时（chat/payload.rs、
        // responses/payload.rs、anthropic/payload.rs、gemini/payload.rs 的
        // tool 分支）读取的是这里的 result 字符串，而不是 message.content；
        // 若只替换 content，截图 Base64 标签仍会原样进入主模型请求。
        if message.role.trim() == "tool" {
            if let Some(raw) = message.tool_results_json.clone() {
                let results =
                    crate::api::conversation::tool_messages::parse_tool_results_json(&raw);
                let mut updated = Vec::with_capacity(results.len());
                let mut changed = false;
                for (name, call_id, result) in results {
                    if result.contains("@@image:") {
                        let parsed = parse_chat_message_content(&result, database_path)?;
                        if !parsed.images.is_empty() {
                            // 工具结果（如截图）不是用户上传的参考图，不附加引用块。
                            let textified = textify_parsed_content(
                                &parsed,
                                &client,
                                &vision_config,
                                false,
                                on_chunk,
                                cancel_token,
                            )
                            .await?;
                            updated.push((name, call_id, textified));
                            changed = true;
                            continue;
                        }
                    }
                    updated.push((name, call_id, result));
                }
                if changed {
                    // 与 tool_messages::ensure_tool_pairing 的写回格式保持一致：
                    // [{"name": ..., "callId": ..., "result": ...}]
                    let serialized: Vec<Value> = updated
                        .iter()
                        .map(|(name, call_id, result)| {
                            json!({
                                "name": name,
                                "callId": call_id,
                                "result": result,
                            })
                        })
                        .collect();
                    message.tool_results_json = serde_json::to_string(&serialized).ok();
                }
            }
        }

        let content = message.content.clone();
        if !content.contains("@@image:") {
            continue;
        }

        let parsed = parse_chat_message_content(&content, database_path)?;
        if parsed.images.is_empty() {
            continue;
        }

        // 用户消息附带参考图引用块：纯文本主模型无法直接接收图片，但
        // imagegen-generate 支持按 `path`（upload 相对路径）引用图片，
        // 因此文本化时把每张图的引用信息一并给出，模型调用图生图工具时
        // 可直接复制。工具结果消息（截图等）不附加，避免上下文膨胀。
        let textified = textify_parsed_content(
            &parsed,
            &client,
            &vision_config,
            message.role.trim() == "user",
            on_chunk,
            cancel_token,
        )
        .await?;
        message.content = textified;
    }

    Ok(())
}

pub(crate) struct VisionApiConfig {
    request_method: String,
    base_url: String,
    base_url_mode: String,
    api_key: String,
    model: String,
    custom_headers: HashMap<String, String>,
    /// gemini 视觉请求是否注入 google_search 工具（snowcfg.visionGoogleSearch）
    google_search: bool,
    /// 视觉请求是否开启思考（snowcfg.visionThinking.enabled，默认关闭）。
    /// chat / responses 注入 reasoning 字段，gemini 注入 thinkingConfig。
    thinking_enabled: bool,
    /// 思考强度（snowcfg.visionThinking.reasoning_effort，chat / responses 用）。
    thinking_effort: String,
    /// 最大输出 tokens（snowcfg.visionMaxTokens，默认 4096）。
    max_tokens: i64,
    /// 并行描述图片的最大并发数（snowcfg.visionMaxConcurrency，默认 8，夹在 1..=8）。
    max_concurrency: usize,
    /// 视觉请求失败重试配置：复用主 API 档案的 max_retries /
    /// retry_base_delay_ms / partial_retry_max_chars（retry::RetryOptions），
    /// 与主请求共用同一套重试分类与指数退避策略。
    retry_options: RetryOptions,
}

impl VisionApiConfig {
    pub(crate) fn from(
        api_config: &ApiConfigRecord,
        custom_headers: &HashMap<String, String>,
    ) -> Result<Self> {
        let request_method = api_config.vision_request_method.trim().to_string();
        let base_url = api_config.vision_base_url.trim().to_string();
        let base_url_mode = api_config.vision_base_url_mode.trim().to_string();
        let api_key = api_config.vision_api_key.trim().to_string();
        let model = api_config.vision_model.trim().to_string();

        if base_url.is_empty() {
            return Err(Error::from_reason(
                "Vision base URL is not configured. Please configure the vision API settings first.",
            ));
        }

        let snowcfg = serde_json::from_str::<Value>(&api_config.config_json)
            .ok()
            .and_then(|parsed| parsed.get("snowcfg").cloned())
            .unwrap_or_else(|| json!({}));

        // 读取 snowcfg.visionGoogleSearch：gemini 视觉（图片模型）联网搜索开关
        let google_search = snowcfg
            .get("visionGoogleSearch")
            .and_then(Value::as_bool)
            .unwrap_or(false);

        // 读取 snowcfg.visionThinking：思考开关 + 思考强度（默认关闭）
        let (thinking_enabled, thinking_effort) = snowcfg
            .get("visionThinking")
            .map(|thinking| {
                let enabled = thinking
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let effort = thinking
                    .get("reasoning_effort")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_string();
                (enabled, effort)
            })
            .unwrap_or((false, String::new()));

        // 读取 snowcfg.visionMaxTokens：最大输出 tokens（默认 4096，夹在 256..=32768）
        let max_tokens = snowcfg
            .get("visionMaxTokens")
            .and_then(Value::as_i64)
            .unwrap_or(4096)
            .clamp(256, 32768);

        // 读取 snowcfg.visionMaxConcurrency：并行描述图片的最大并发数
        // （默认 8，夹在 1..=8，避免过多并发请求触发上游限流）
        let max_concurrency = snowcfg
            .get("visionMaxConcurrency")
            .and_then(Value::as_i64)
            .unwrap_or(8)
            .clamp(1, 8) as usize;

        // 复用主 API 档案的重试配置：视觉请求失败与主请求共用同一套
        // retry::RetryOptions（max_retries / 退避基数 / partial 阈值）。
        let retry_options = RetryOptions::from_config(
            api_config.max_retries,
            api_config.retry_base_delay_ms,
            api_config.partial_retry_max_chars,
        );

        Ok(Self {
            request_method,
            base_url,
            base_url_mode,
            api_key,
            model,
            custom_headers: custom_headers.clone(),
            google_search,
            thinking_enabled,
            thinking_effort,
            max_tokens,
            max_concurrency,
            retry_options,
        })
    }
}
