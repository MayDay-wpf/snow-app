//! Built-in MCP service: AI image generation with multi-provider support.
//!
//! Tool:
//! - `imagegen-generate` — generate image(s) from a text prompt.
//!   - OpenAI-compatible endpoints (gpt-image / dall-e / ...):
//!     `POST {baseUrl}/images/generations`
//!   - Google Gemini (Imagen models):
//!     `POST {baseUrl}/models/{model}:generateContent`
//!
//! Configuration model: image generation uses its OWN independent settings
//! (stored in the `system_settings` table under the `imagegen_settings` code,
//! edited from Settings -> Image generation in the UI). It is intentionally
//! decoupled from the conversation/agent API profiles: there is NO hard-coded
//! default model. Precedence per field:
//!   1. explicit tool argument (model / provider / size / quality / ...)
//!   2. front-end settings (model / provider / baseUrl / apiKey / defaults)
//!   3. a clear error telling the agent to configure the settings or pass the
//!      missing argument.

use std::time::Duration;

use base64::Engine;
use napi::bindgen_prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::super::servers::bash::BashStreamCallback;
use super::super::service::McpService;
use super::super::tools::McpTool;

mod gemini_stream;
mod openai_stream;
mod reference_image;

use openai_stream::collect_openai_result;
use reference_image::ReferenceImage;

const SERVER_ID: &str = "imagegen";
pub const TOOL_GENERATE: &str = "generate";
/// 视觉分析工具：读取项目中的图片（如 UI 设计稿）并用视觉模型生成描述，
/// 供主模型理解设计后编码还原（前端页面等）。
const TOOL_DESCRIBE: &str = "image-describe";
const TOOL_DESCRIBE_NAME: &str = "imagegen-image-describe";

/// image-describe 默认分析提示词（UI/UX 设计稿还原场景）。
const DEFAULT_DESCRIBE_PROMPT: &str = "Describe this image as a UI/UX design reference for front-end implementation. Cover: overall layout structure (sections, columns, hierarchy), color palette (exact hex codes where discernible), typography (font styles, sizes, weights), spacing and margins, components (buttons, cards, forms, navigation, modals, lists), visual effects (shadows, gradients, border radius), icons and imagery, and any responsive/adaptive hints. Output a concise but COMPLETE structured description (use sections) that a developer can directly translate into code to recreate the page.";
/// Image models may take several minutes for complex prompts (gpt-image 2K/4K,
/// Gemini Nano Banana with web search). This is the DEFAULT when the settings
/// panel value is missing; users can raise it in Settings -> Image generation.
const REQUEST_TIMEOUT_SECS: u64 = 300;
/// 生图请求超时允许范围（秒）：1 分钟 ~ 1 小时（与设置面板
/// IMAGE_GEN_TIMEOUT_RANGE 一致，防止异常配置值导致请求被立刻掐断或无限挂起）。
const MIN_TIMEOUT_SECS: u64 = 60;
const MAX_TIMEOUT_SECS: u64 = 3600;
const DEFAULT_N: usize = 1;
/// 单次工具调用内并发生成图片的最大数量（1-8，与设置面板
/// maxConcurrentImages 上限一致）。中转/上游不支持单请求多图（n>1），
/// 实现上把一次调用拆成 n 个并发子请求（每个子请求 n=1）绕开该限制。
const MAX_PARALLEL_IMAGES: usize = 8;
/// 远程图片（预签名 URL 等）下载上限（50 MB，与主进程 img-proxy 协议一致），
/// 防止上游 URL 指向超大文件耗尽内存。
const MAX_REMOTE_IMAGE_BYTES: usize = 50 * 1024 * 1024;
/// 远程图片下载单次超时（预签名链接通常秒级返回，30s 足够）。
const REMOTE_IMAGE_TIMEOUT_SECS: u64 = 30;

/// system_settings 表中的设置 code（与设置面板共用）。
const IMAGE_GEN_SETTING_CODE: &str = "imagegen_settings";

const DEFAULT_OPENAI_BASE_URL: &str = "https://api.openai.com/v1";
const DEFAULT_GEMINI_BASE_URL: &str = "https://generativelanguage.googleapis.com/v1beta";

/// 前端「图像生成」设置（Settings -> Image generation）。支持任意多个独立
/// 渠道（每个渠道可配置自己的协议类型、Base URL、密钥、模型与默认参数）
/// 同时配置、同时启用，agent 可任选其一调用；所有渠道都未配置时工具不暴露
/// 给模型。渠道在数组中的顺序即优先级：未指定渠道时默认使用第一个可用渠道。
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct ImageGenSettings {
    /// 渠道列表（顺序即优先级）。
    channels: Vec<ImageGenChannel>,
    /// 生图请求超时（秒），设置面板可配置；缺失时回退默认值
    /// （REQUEST_TIMEOUT_SECS）。对单次生成/编辑请求生效（含流式）。
    timeout_secs: Option<u64>,
}

impl ImageGenSettings {
    /// 是否有至少一个已启用且凭据齐全的渠道。
    fn has_enabled_channel(&self) -> bool {
        self.channels.iter().any(ImageGenChannel::is_usable)
    }
}

/// 单个生图渠道的配置（与对话 API 完全独立；无内置默认模型）。
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct ImageGenChannel {
    /// 渠道唯一 ID（前端生成；旧数据迁移时使用协议名），供 provider 参数引用。
    id: String,
    /// 用户自定义显示名（留空时回退到协议名）。
    name: String,
    /// 协议类型："openai"（OpenAI 兼容 Images API）/ "gemini"（Gemini Imagen）。
    provider: String,
    /// 渠道启用开关（未启用时该渠道不可用）
    enabled: bool,
    /// 留空 = 使用官方默认端点
    base_url: String,
    api_key: String,
    /// 绘图模型名；留空时该渠道不可用（代码中不内置默认模型）
    model: String,
    default_size: String,
    default_quality: String,
    output_format: String,
    /// Gemini 联网搜索（Grounding with Google Search），仅 Gemini 生效
    web_search: bool,
    /// 默认流式预览（partial image 实时推送到会话页），工具参数 stream 可覆盖
    default_stream: bool,
}

impl ImageGenChannel {
    fn is_usable(&self) -> bool {
        self.enabled && !self.api_key.trim().is_empty() && !self.model.trim().is_empty()
    }

    /// 渠道的显示名（name 留空时回退到协议名）。
    fn display_name(&self) -> String {
        let trimmed = self.name.trim();
        if trimmed.is_empty() {
            if self.provider == "gemini" {
                "gemini".to_string()
            } else {
                "openai".to_string()
            }
        } else {
            trimmed.to_string()
        }
    }
}

pub struct ImageGenService;

impl ImageGenService {
    pub fn new() -> Self {
        ImageGenService
    }

    /// `image-describe`：读取磁盘图片（绝对路径或 upload/ 相对路径）并用
    /// 视觉模型生成描述。用于「读取项目中的 UI 设计稿 → 理解设计 →
    /// 编码还原前端页面」的工作流。视觉配置复用主 API 的 vision 通道。
    pub async fn execute_describe(&self, args: &Value) -> napi::Result<Value> {
        let path = required_string(args, "path", TOOL_DESCRIBE)?;
        let user_prompt = args
            .get("prompt")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .unwrap_or(DEFAULT_DESCRIBE_PROMPT);

        let description = crate::api::vision::describe_image_file(path, user_prompt).await?;

        Ok(json!({
            "path": path,
            "description": description,
            "note": "Use this description to understand the design. If the task is to recreate this UI with code, analyze the description carefully (layout, colors, typography, spacing, components) and implement it with the filesystem tools. Do NOT reference the image file in the final code — embed colors/values from the description."
        }))
    }

    pub async fn execute_generate(
        &self,
        args: &Value,
        on_chunk: &BashStreamCallback,
    ) -> napi::Result<Value> {
        let prompt = required_string(args, "prompt", TOOL_GENERATE)?;
        // n 支持 1-8：一次调用生成多张时，内部拆成 n 个并发子请求
        // （每个子请求 n=1——中转/上游不支持单请求多图，实测 n>1 会触发
        // 连接中断）。并发数由本工具内部管理，多调用间的并发仍由应用侧
        // maxConcurrentImages 自动管理。
        let n = args
            .get("n")
            .and_then(Value::as_u64)
            .map(|value| value as usize)
            .unwrap_or(DEFAULT_N)
            .max(1)
            .min(MAX_PARALLEL_IMAGES);

        // --- 1. Load the independent front-end settings (blocking SQLite I/O) ---
        let settings = tokio::task::spawn_blocking(load_imagegen_settings)
            .await
            .map_err(|error| {
                Error::from_reason(format!("Failed to load image generation settings: {error}"))
            })??;
        // 生图请求超时（秒）：设置面板可配置，缺失时回退默认值。
        let timeout_secs = settings.timeout_secs;

        // --- 2. Resolve channel (provider): argument > first usable channel ---
        let channel = resolve_channel(args, &settings)?;
        let provider = channel.0;
        let channel_config = channel.1;
        let channel_label = channel_config.display_name();

        // --- 3. Resolve credentials / endpoint from the channel ---
        let base_url = channel_base_url(channel_config);
        let api_key = channel_config.api_key.trim();

        // --- 4. Resolve the model: argument > channel model; NO hard-coded default ---
        let model = args
            .get("model")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| non_empty(&channel_config.model))
            .ok_or_else(|| {
                Error::from_reason(
                    "No image model configured for the selected channel. Configure the model in Settings -> Image generation, or pass the `model` argument explicitly.",
                )
            })?;

        // --- 5. Resolve default size / quality / outputFormat from the channel ---
        let size = args
            .get("size")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| non_empty(&channel_config.default_size));
        let quality = args
            .get("quality")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| non_empty(&channel_config.default_quality));
        let output_format = args
            .get("outputFormat")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| non_empty(&channel_config.output_format));

        // --- 6. Streaming mode: argument > channel default ---
        let stream_enabled = args
            .get("stream")
            .and_then(Value::as_bool)
            .unwrap_or(channel_config.default_stream);

        // --- 7. Image-to-image: reference images from the conversation ---
        // images: [{ "data": "<base64>", "mimeType": "image/png" }]
        //         或 [{ "path": "upload/2026-07-25/hash.png", "mimeType": "image/png" }]
        // （path 为相对数据库文件所在目录的磁盘路径，服务端读取文件后转
        //   base64；来自纯文本主模型消息中的 [Reference image #N for
        //   imagegen-generate: ...] 引用块，避免把大段 base64 塞进对话上下文）
        // requestImages: 每个请求独立的参考图组（Array<Array<{data|path,mimeType}>>，
        //   第 i 项对应第 i 个请求；未提供时所有请求共用顶层 images）
        let storage_info = crate::storage::initialize_app_storage()?;
        let database_path = std::path::PathBuf::from(storage_info.database_path);
        let images = reference_image::parse_reference_images(args, &database_path)?;
        let request_images = reference_image::parse_request_images(args, &database_path)?;
        // 图生图（edits / inlineData 参考图）暂不支持流式预览
        let stream_enabled = stream_enabled && images.is_empty() && request_images.is_empty();

        // --- 7.5 Model capability guards (avoid provider 400 errors) ---
        // dall-e-3 仅支持文生图（OpenAI /images/edits 端点不接受 dall-e-3）
        // 且每次只能生成 1 张；imagen 系列纯文生图，不接受参考图输入。
        // 发送请求前先校验，命中率极高的 400（"n must be 1 for dall-e-3"、
        // "image input is not supported" 等）直接在本地拦截并给出修复建议。
        let model_lower = model.to_ascii_lowercase();
        let is_dall_e_3 = model_lower.starts_with("dall-e-3");
        let is_imagen = model_lower.starts_with("imagen");
        if !images.is_empty() && (is_dall_e_3 || is_imagen) {
            let hint = if is_dall_e_3 {
                "dall-e-3 only supports text-to-image. Use gpt-image-1 / gpt-image-2 (OpenAI) or a Gemini Nano Banana model (gemini-3.1-flash-image / gemini-3-pro-image / gemini-3.1-flash-lite-image) for image-to-image editing, or drop the reference images and generate from text only."
            } else {
                "imagen models are text-to-image only. Use a Gemini Nano Banana model (gemini-3.1-flash-image / gemini-3-pro-image / gemini-3.1-flash-lite-image) for image-to-image editing, or drop the reference images and generate from text only."
            };
            return Err(Error::from_reason(format!(
                "Model \"{model}\" does not support image-to-image (reference images). {hint}"
            )));
        }
        // Gemini 参考图数量上限（官方文档）：3 系列 14 张，2.5 Flash Image 3 张。
        if provider == "gemini" && !images.is_empty() {
            let max_ref = if model_lower.contains("gemini-2.5-flash-image") {
                3
            } else {
                14
            };
            if images.len() > max_ref {
                return Err(Error::from_reason(format!(
                    "Model \"{model}\" supports at most {max_ref} reference images, got {}. Reduce the number of reference images.",
                    images.len()
                )));
            }
        }
        // dall-e-3 每次只能生成 1 张：n>1 自动收敛为 1，避免 400。
        let n = if is_dall_e_3 { n.min(1) } else { n };

        // --- 7.2 Per-request prompts: `prompts` array overrides ---
        // prompts: ["第一张的提示词", "第二张的提示词", ...] —— 每张图各自独立的
        // 提示词；提供时请求数 = 数组长度（1-8，覆盖 n 参数）。
        // 未提供时所有请求共用顶层 prompt，请求数 = n。
        let prompts_override: Option<Vec<String>> =
            match args.get("prompts").and_then(Value::as_array) {
                Some(arr) => {
                    let list: Vec<String> = arr
                        .iter()
                        .filter_map(|value| {
                            value
                                .as_str()
                                .map(str::trim)
                                .filter(|text| !text.is_empty())
                                .map(str::to_string)
                        })
                        .collect();
                    if list.is_empty() {
                        return Err(Error::new(
                            Status::InvalidArg,
                            "`prompts` must be a non-empty array of non-empty strings".to_string(),
                        ));
                    }
                    if list.len() > MAX_PARALLEL_IMAGES {
                        return Err(Error::new(
                            Status::InvalidArg,
                            format!("`prompts` supports at most {MAX_PARALLEL_IMAGES} entries"),
                        ));
                    }
                    Some(list)
                }
                None => None,
            };
        // 请求数：prompts 提供时取其长度，否则用 n（已 clamp 1-8）
        let requests = prompts_override
            .as_ref()
            .map(|list| list.len())
            .unwrap_or(n);

        // --- 7.3 Per-request views: prompt 与参考图按请求索引分发 ---
        // 逐请求提示词（dall-e-3 收敛后只取第 1 个）
        let per_request_prompts: Vec<&str> = match &prompts_override {
            Some(list) => list.iter().map(String::as_str).take(requests).collect(),
            None => vec![prompt; requests],
        };
        // 逐请求参考图：requestImages 提供时长度必须等于请求数；否则全部共享
        if !request_images.is_empty() && request_images.len() != requests {
            return Err(Error::new(
                Status::InvalidArg,
                format!(
                    "`requestImages` must contain exactly {requests} group(s) \
                     (one per request), got {}",
                    request_images.len()
                ),
            ));
        }
        let per_request_images: Vec<&[ReferenceImage]> = if request_images.is_empty() {
            vec![images.as_slice(); requests]
        } else {
            request_images.iter().map(Vec::as_slice).collect()
        };

        let seed = args.get("seed").and_then(Value::as_u64);
        let input_fidelity = args
            .get("inputFidelity")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let background = args
            .get("background")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let moderation = args
            .get("moderation")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let thinking_level = args
            .get("thinkingLevel")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        // 反向提示词（negativePrompt）：仅 Gemini Imagen 系生效（写入
        // generationConfig.negativePrompt）；Nano Banana / OpenAI 不支持，
        // 在 generate_gemini 内按模型判断丢弃。
        let negative_prompt = args
            .get("negativePrompt")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let image_search = args
            .get("imageSearch")
            .and_then(Value::as_bool)
            .unwrap_or(false);

        match provider {
            "gemini" => {
                self.generate_gemini(
                    args,
                    channel_config,
                    per_request_prompts.as_slice(),
                    &model,
                    &size,
                    &quality,
                    &base_url,
                    api_key,
                    requests,
                    stream_enabled,
                    on_chunk,
                    per_request_images.as_slice(),
                    seed,
                    thinking_level.as_deref(),
                    negative_prompt.as_deref(),
                    image_search,
                    &channel_label,
                    timeout_secs,
                )
                .await
            }
            _ => {
                self.generate_openai(
                    args,
                    per_request_prompts.as_slice(),
                    &model,
                    &size,
                    &quality,
                    &output_format,
                    &base_url,
                    api_key,
                    requests,
                    stream_enabled,
                    on_chunk,
                    per_request_images.as_slice(),
                    seed,
                    input_fidelity.as_deref(),
                    background.as_deref(),
                    moderation.as_deref(),
                    &channel_label,
                    timeout_secs,
                )
                .await
            }
        }
    }

    /// OpenAI Images API branch:
    /// - text-to-image:   POST {base}/images/generations (JSON, optional SSE stream)
    /// - image-to-image:  POST {base}/images/edits (multipart form, reference images)
    async fn generate_openai(
        &self,
        args: &Value,
        prompts: &[&str],
        model: &str,
        size: &Option<String>,
        quality: &Option<String>,
        output_format: &Option<String>,
        base_url: &str,
        api_key: &str,
        n: usize,
        stream_enabled: bool,
        on_chunk: &BashStreamCallback,
        images: &[&[ReferenceImage]],
        seed: Option<u64>,
        input_fidelity: Option<&str>,
        background: Option<&str>,
        moderation: Option<&str>,
        channel_label: &str,
        timeout_secs: Option<u64>,
    ) -> napi::Result<Value> {
        let mime_type = mime_for_format(output_format.as_deref().unwrap_or("png"));
        let is_dall_e = model.to_ascii_lowercase().starts_with("dall-e");
        let is_gpt_image_2 = model.to_ascii_lowercase().contains("gpt-image-2");
        // xAI Grok Imagine：OpenAI 兼容端点，但尺寸用 aspect_ratio + resolution
        // （不走 size），图生图走 JSON body（非 multipart），不支持 SSE 流式。
        let is_grok = model.to_ascii_lowercase().contains("grok-imagine")
            || model.to_ascii_lowercase().contains("grok-image");

        // 单次调用内并发 n 个子请求（每个子请求 n=1）：中转/上游不支持
        // 单请求多图，拆成并发请求绕开限制。n>1 时禁用流式——多路
        // partial_image 事件无法区分归属，预览会互相覆盖。
        let requests = n.max(1);
        let allow_stream = stream_enabled
            && requests == 1
            && !is_dall_e
            && !is_grok
            && images.iter().all(|set| set.is_empty());
        let client = build_client(timeout_secs).await?;

        let tasks: Vec<_> = (0..requests)
            .map(|request_index| {
                let client = client.clone();
                let mime_type = mime_type.clone();
                let edits_endpoint = format!("{base_url}/images/edits");
                let generations_endpoint = format!("{base_url}/images/generations");
                async move {
                    // 当前请求的提示词与参考图（prompts/requestImages 逐请求分发）
                    let prompt = prompts[request_index];
                    let request_images: &[ReferenceImage] = images[request_index];
                    // 用户显式指定 seed 且并发多张时逐张递增，避免生成完全相同的图
                    let request_seed = seed.map(|value| value.wrapping_add(request_index as u64));

                    // --- Image-to-image: POST /images/edits ---
                    if !request_images.is_empty() {
                        // xAI Grok Imagine：edits 走 application/json（非 multipart），
                        // 参考图以 data URI 形式放入 image.url；暂取第一张。
                        if is_grok {
                            let body = json!({
                                "model": model,
                                "prompt": prompt,
                                "image": {
                                    "url": format!(
                                        "data:{};base64,{}",
                                        request_images[0].mime_type, request_images[0].data
                                    )
                                }
                            });
                            let response = client
                                .post(&edits_endpoint)
                                .bearer_auth(api_key)
                                .json(&body)
                                .send()
                                .await
                                .map_err(|error| {
                                    generic_error(format!("Grok image edit request failed: {error}"))
                                })?;
                            let status = response.status();
                            let response_body: Value = response.json().await.unwrap_or_else(|_| json!({}));
                            if !status.is_success() {
                                return Err(api_error(
                                    "Grok image edit failed",
                                    status.as_u16(),
                                    &response_body,
                                ));
                            }
                            let Some(data) = response_body.get("data").and_then(Value::as_array) else {
                                return Err(generic_error(
                                    "Grok image edit response is missing the data array".to_string(),
                                ));
                            };
                            return collect_openai_result(
                                prompt,
                                model,
                                channel_label,
                                data.iter().cloned().collect(),
                                mime_type,
                            )
                            .await;
                        }
                        let build_form =
                            |background: Option<&str>| -> napi::Result<reqwest::multipart::Form> {
                                let mut form = reqwest::multipart::Form::new()
                                    .text("model", model.to_string())
                                    .text("prompt", prompt.to_string())
                                    .text("n", "1");
                                for (index, image) in request_images.iter().enumerate() {
                                    let bytes = reference_image::decode_base64(&image.data)?;
                                    let file_name = format!(
                                        "image-{}.{}",
                                        index + 1,
                                        reference_image::ext_for_mime(&image.mime_type)
                                    );
                                    let part = reqwest::multipart::Part::bytes(bytes)
                                        .file_name(file_name)
                                        .mime_str(&image.mime_type)
                                        .map_err(|error| {
                                            generic_error(format!(
                                                "Failed to build multipart part: {error}"
                                            ))
                                        })?;
                                    form = form.part("image[]", part);
                                }
                                if let Some(value) = size {
                                    form = form.text("size", value.clone());
                                }
                                if let Some(value) = quality {
                                    form = form.text("quality", value.clone());
                                }
                                if let Some(value) = output_format {
                                    form = form.text("output_format", value.clone());
                                }
                                if let Some(value) =
                                    args.get("outputCompression").and_then(Value::as_u64)
                                {
                                    form = form.text(
                                        "output_compression",
                                        value.clamp(0, 100).to_string(),
                                    );
                                }
                                if let Some(value) = input_fidelity {
                                    // gpt-image-2 不允许设置 input_fidelity（自动高保真）
                                    if !is_gpt_image_2 && matches!(value, "low" | "high" | "auto") {
                                        form = form.text("input_fidelity", value.to_string());
                                    }
                                }
                                if let Some(value) = sanitize_background(model, background) {
                                    form = form.text("background", value.to_string());
                                }
                                if let Some(value) = moderation {
                                    if matches!(value, "auto" | "low") {
                                        form = form.text("moderation", value.to_string());
                                    }
                                }
                                Ok(form)
                            };

                        // 部分模型/代理不支持透明背景（400 "Transparent background is not
                        // supported"）：去掉 background 参数后重试一次
                        let mut attempt = 0;
                        let mut current_background = background;
                        let response = loop {
                            let form = build_form(current_background)?;
                            let response = client
                                .post(&edits_endpoint)
                                .bearer_auth(api_key)
                                .multipart(form)
                                .send()
                                .await
                                .map_err(|error| {
                                    generic_error(format!("Image edit request failed: {error}"))
                                })?;
                            let status = response.status();
                            if status.is_success() {
                                break response;
                            }
                            let response_body: Value =
                                response.json().await.unwrap_or_else(|_| json!({}));
                            if attempt == 0
                                && current_background.is_some()
                                && is_transparent_unsupported_error(&response_body)
                            {
                                current_background = None;
                                attempt += 1;
                                continue;
                            }
                            return Err(api_error(
                                "Image edit failed",
                                status.as_u16(),
                                &response_body,
                            ));
                        };

                        let response_body: Value = response.json().await.map_err(|error| {
                            generic_error(format!("Failed to parse image edit response: {error}"))
                        })?;
                        let Some(data) = response_body.get("data").and_then(Value::as_array) else {
                            return Err(generic_error(
                                "Image edit response is missing the data array".to_string(),
                            ));
                        };
                        return openai_stream::collect_openai_result(
                            prompt,
                            model,
                            channel_label,
                            data.iter().cloned().collect(),
                            mime_type,
                        )
                        .await;
                    }

                    // --- Text-to-image: POST /images/generations (JSON) ---
                    // size / quality / outputFormat are only sent when explicitly provided
                    // so that OpenAI-compatible third-party endpoints (which may reject
                    // unknown fields) keep working with a plain {model, prompt, n} body.
                    let mut body = json!({
                        "model": model,
                        "prompt": prompt,
                        "n": 1,
                    });
                    if is_grok {
                        // xAI Grok Imagine：尺寸 = aspect_ratio + resolution（1k/2k），
                        // 不走 OpenAI 的 size；quality 仅 low/medium（2.0 支持）；
                        // 不支持 output_format / output_compression / seed /
                        // background / moderation，一律不发送。
                        if let Some(value) = args.get("aspectRatio").and_then(Value::as_str) {
                            if !value.is_empty() {
                                body["aspect_ratio"] = json!(value);
                            }
                        }
                        if let Some(value) = args.get("resolution").and_then(Value::as_str) {
                            if !value.is_empty() {
                                body["resolution"] = json!(value);
                            }
                        }
                        if let Some(value) = quality {
                            if matches!(value.as_str(), "low" | "medium") {
                                body["quality"] = json!(value);
                            }
                        }
                        body["response_format"] = json!("b64_json");
                    } else {
                    if let Some(value) = size {
                        body["size"] = json!(value);
                    }
                    if let Some(value) = quality {
                        body["quality"] = json!(value);
                    }
                    if let Some(value) = output_format {
                        body["output_format"] = json!(value);
                    }
                    if let Some(value) = args.get("outputCompression").and_then(Value::as_u64) {
                        // jpeg/webp 专属压缩率 0-100（gpt-image 系列）
                        body["output_compression"] = json!(value.clamp(0, 100));
                    }
                    if let Some(value) = request_seed {
                        body["seed"] = json!(value);
                    }
                    if let Some(value) = sanitize_background(model, background) {
                        body["background"] = json!(value);
                    }
                    if let Some(value) = moderation {
                        if matches!(value, "auto" | "low") {
                            body["moderation"] = json!(value);
                        }
                    }
                    if allow_stream {
                        // gpt-image 系列流式：生成过程中推送 0-3 张中间预览
                        body["stream"] = json!(true);
                        body["partial_images"] = json!(2);
                    }
                    if is_dall_e {
                        // dall-e-3 uses `response_format` (b64_json) and does not accept
                        // `output_format` / `stream` / `background`; its `quality` values
                        // (standard/hd) differ from gpt-image (low/medium/high), so drop
                        // them to avoid a 400.
                        body["response_format"] = json!("b64_json");
                        if let Some(map) = body.as_object_mut() {
                            map.remove("output_format");
                            map.remove("output_compression");
                            map.remove("quality");
                            map.remove("stream");
                            map.remove("partial_images");
                            map.remove("background");
                            map.remove("moderation");
                        }
                    }
                    }

                    // 部分模型/代理不支持透明背景（400 "Transparent background is not
                    // supported"）：去掉 background 参数后重试一次
                    let mut attempt = 0;
                    let response = loop {
                        let response = client
                            .post(&generations_endpoint)
                            .bearer_auth(api_key)
                            .json(&body)
                            .send()
                            .await
                            .map_err(|error| {
                                generic_error(format!("Image generation request failed: {error}"))
                            })?;
                        let status = response.status();
                        if status.is_success() {
                            break response;
                        }
                        let response_body: Value =
                            response.json().await.unwrap_or_else(|_| json!({}));
                        if attempt == 0
                            && body.get("background").is_some()
                            && is_transparent_unsupported_error(&response_body)
                        {
                            if let Some(map) = body.as_object_mut() {
                                map.remove("background");
                            }
                            attempt += 1;
                            continue;
                        }
                        return Err(api_error(
                            "Image generation failed",
                            status.as_u16(),
                            &response_body,
                        ));
                    };

                    // --- Streaming path: consume the SSE stream and forward partials ---
                    if allow_stream {
                        let mut partials: Vec<(usize, String)> = Vec::new();
                        let mut completed: Vec<Value> = Vec::new();
                        openai_stream::read_openai_sse(
                            response,
                            &mut partials,
                            &mut completed,
                            on_chunk,
                            &mime_type,
                        )
                        .await?;

                        let final_images = if !completed.is_empty() {
                            completed
                        } else if !partials.is_empty() {
                            partials
                                .into_iter()
                                .max_by_key(|(index, _)| *index)
                                .into_iter()
                                .map(|(_, data)| json!({ "b64_json": data }))
                                .collect()
                        } else {
                            return Err(generic_error(
                                "Image generation stream ended without any image data".to_string(),
                            ));
                        };
                        return openai_stream::collect_openai_result(
                            prompt,
                            model,
                            channel_label,
                            final_images,
                            mime_type,
                        )
                        .await;
                    }

                    // --- Non-streaming path ---
                    let response_body: Value = response.json().await.map_err(|error| {
                        generic_error(format!(
                            "Failed to parse image generation response: {error}"
                        ))
                    })?;

                    let Some(data) = response_body.get("data").and_then(Value::as_array) else {
                        return Err(generic_error(
                            "Image generation response is missing the data array".to_string(),
                        ));
                    };

                    openai_stream::collect_openai_result(
                        prompt,
                        model,
                        channel_label,
                        data.iter().cloned().collect(),
                        mime_type,
                    )
                    .await
                }
            })
            .collect();

        let results = futures::future::join_all(tasks).await;
        merge_parallel_results(prompts[0], model, channel_label, requests, results)
    }

    /// Google Gemini branch.
    /// - Nano Banana 2 / Pro / Lite (`gemini-3.1-flash-image`,
    ///   `gemini-3-pro-image`, `gemini-3.1-flash-lite-image`) use the
    ///   official **Interactions API** (`POST /v1beta/interactions`, model in
    ///   body, `response_format` for image config).
    /// - Older models (`gemini-2.5-flash-image`, Imagen) keep using
    ///   `POST /v1beta/models/{model}:generateContent`.
    async fn generate_gemini(
        &self,
        args: &Value,
        channel: &ImageGenChannel,
        prompts: &[&str],
        model: &str,
        size: &Option<String>,
        quality: &Option<String>,
        base_url: &str,
        api_key: &str,
        n: usize,
        stream_enabled: bool,
        on_chunk: &BashStreamCallback,
        images: &[&[ReferenceImage]],
        seed: Option<u64>,
        thinking_level: Option<&str>,
        negative_prompt: Option<&str>,
        image_search: bool,
        channel_label: &str,
        timeout_secs: Option<u64>,
    ) -> napi::Result<Value> {
        let is_nano_banana_2 = matches!(
            model,
            "gemini-3.1-flash-image" | "gemini-3-pro-image" | "gemini-3.1-flash-lite-image"
        );

        // --- Shared: web search grounding (tools) ---
        let web_search = args
            .get("webSearch")
            .and_then(Value::as_bool)
            .unwrap_or(channel.web_search);
        let mut tools: Vec<Value> = Vec::new();
        if web_search || image_search {
            let mut search_tool = json!({ "type": "google_search" });
            if image_search {
                // 图片搜索（3.1 Flash Image 专属）：web + image 双通道
                search_tool["search_types"] = json!(["web_search", "image_search"]);
            }
            tools.push(search_tool);
        }

        // 单次调用内并发 n 个子请求（与 OpenAI 分支同策略）；n>1 禁用流式
        // （多路流式事件无法区分归属，预览会互相覆盖）。
        let requests = n.max(1);
        let allow_stream = stream_enabled && requests == 1;
        let client = build_client(timeout_secs).await?;

        // --- Nano Banana 2+: Interactions API 共享配置 ---
        let interactions_endpoint = format!("{base_url}/interactions");
        let mut interactions_response_format = json!({
            "type": "image",
        });
        if let Some(size) = size {
            let trimmed = size.trim();
            // 组合格式 "16:9@2K"：同时设置 aspect_ratio + image_size
            if let Some((ratio_part, size_part)) = trimmed.split_once('@') {
                let ratio = ratio_part.trim();
                let image_size = size_part.trim();
                if matches!(image_size, "1K" | "2K" | "4K" | "0.5K" | "512") {
                    interactions_response_format["image_size"] = json!(image_size);
                }
                if ratio.contains(':')
                    && ratio.split(':').count() == 2
                    && ratio.split(':').all(|part| part.parse::<u32>().is_ok())
                {
                    interactions_response_format["aspect_ratio"] = json!(ratio);
                }
            } else if matches!(trimmed, "1K" | "2K" | "4K" | "0.5K" | "512") {
                interactions_response_format["image_size"] = json!(trimmed);
            } else if trimmed.contains(':')
                && trimmed.split(':').count() == 2
                && trimmed.split(':').all(|part| part.parse::<u32>().is_ok())
            {
                interactions_response_format["aspect_ratio"] = json!(trimmed);
            }
        }
        if let Some(quality) = quality {
            if matches!(quality.as_str(), "low" | "medium" | "high") {
                interactions_response_format["image_quality"] = json!(quality);
            }
        }
        // 输出格式（Gemini 3 系列 response_format mime_type：png / jpeg）
        if let Some(output_format) = args.get("outputFormat").and_then(Value::as_str) {
            match output_format.trim().to_ascii_lowercase().as_str() {
                "png" => {
                    interactions_response_format["mime_type"] = json!("image/png");
                }
                "jpeg" | "jpg" => {
                    interactions_response_format["mime_type"] = json!("image/jpeg");
                }
                _ => {}
            }
        }
        let mut interactions_generation_config = json!({});
        if let Some(level) = thinking_level {
            if matches!(level, "minimal" | "high") {
                interactions_generation_config["thinking_level"] = json!(level);
            }
        }
        if let Some(person_generation) = args
            .get("personGeneration")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            if matches!(
                person_generation,
                "dont_allow" | "allow_all" | "allow_adult"
            ) {
                interactions_generation_config["personGeneration"] = json!(person_generation);
            }
        }

        // --- Legacy: generateContent API 共享配置 ---
        let legacy_endpoint = format!("{base_url}/models/{model}:generateContent");
        let legacy_stream_endpoint = format!("{base_url}/models/{model}:streamGenerateContent");
        let mut legacy_generation_config = json!({ "responseModalities": ["IMAGE"] });
        // size: "1K"/"2K"/"4K" -> imageSize; "N:N" (e.g. "16:9") -> aspectRatio;
        // "16:9@2K" -> 两者同时设置。
        if let Some(size) = size {
            let trimmed = size.trim();
            if let Some((ratio_part, size_part)) = trimmed.split_once('@') {
                let ratio = ratio_part.trim();
                let image_size = size_part.trim();
                if matches!(image_size, "1K" | "2K" | "4K") {
                    legacy_generation_config["imageSize"] = json!(image_size);
                }
                if ratio.contains(':')
                    && ratio.split(':').count() == 2
                    && ratio.split(':').all(|part| part.parse::<u32>().is_ok())
                {
                    legacy_generation_config["aspectRatio"] = json!(ratio);
                }
            } else if matches!(trimmed, "1K" | "2K" | "4K") {
                legacy_generation_config["imageSize"] = json!(trimmed);
            } else if trimmed.contains(':')
                && trimmed.split(':').count() == 2
                && trimmed.split(':').all(|part| part.parse::<u32>().is_ok())
            {
                legacy_generation_config["aspectRatio"] = json!(trimmed);
            }
        }
        if let Some(quality) = quality {
            if matches!(quality.as_str(), "low" | "medium" | "high") {
                legacy_generation_config["imageQuality"] = json!(quality);
            }
        }
        if let Some(person_generation) = args
            .get("personGeneration")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            if matches!(
                person_generation,
                "dont_allow" | "allow_all" | "allow_adult"
            ) {
                legacy_generation_config["personGeneration"] = json!(person_generation);
            }
        }
        // 反向提示词：仅 Imagen 系（generateContent 官方支持
        // generationConfig.negativePrompt）；Nano Banana 2.5 / 3 系列忽略
        // （官方建议用语义化正向描述，无独立 negative prompt 概念）。
        if let Some(value) = negative_prompt {
            if model.to_ascii_lowercase().starts_with("imagen") {
                legacy_generation_config["negativePrompt"] = json!(value);
            }
        }

        let tasks: Vec<_> = (0..requests)
            .map(|request_index| {
                let client = client.clone();
                let tools = tools.clone();
                let interactions_response_format = interactions_response_format.clone();
                let interactions_generation_config = interactions_generation_config.clone();
                let interactions_endpoint = interactions_endpoint.clone();
                let legacy_endpoint = legacy_endpoint.clone();
                let legacy_stream_endpoint = legacy_stream_endpoint.clone();
                let legacy_generation_config = legacy_generation_config.clone();
                async move {
                    // 当前请求的提示词与参考图（prompts/requestImages 逐请求分发）
                    let prompt = prompts[request_index];
                    let request_images: &[ReferenceImage] = images[request_index];
                    // 用户显式指定 seed 且并发多张时逐张递增，避免生成完全相同的图
                    let request_seed = seed.map(|value| value.wrapping_add(request_index as u64));

                    // --- Nano Banana 2+: Interactions API ---
                    if is_nano_banana_2 {
                        // input parts：参考图（图生图）在前，文本指令在后
                        let mut input_parts: Vec<Value> = Vec::new();
                        for image in request_images {
                            input_parts.push(json!({
                                "type": "image",
                                "mime_type": image.mime_type,
                                "data": image.data,
                            }));
                        }
                        input_parts.push(json!({ "type": "text", "text": prompt }));

                        let mut generation_config = interactions_generation_config.clone();
                        if let Some(value) = request_seed {
                            generation_config["seed"] = json!(value);
                        }

                        let mut body = json!({
                            "model": model,
                            "input": input_parts,
                            "response_format": interactions_response_format,
                        });
                        if !tools.is_empty() {
                            body["tools"] = json!(tools);
                        }
                        if generation_config.as_object().is_some_and(|m| !m.is_empty()) {
                            body["generation_config"] = generation_config;
                        }

                        let response = client
                            .post(&interactions_endpoint)
                            .header("x-goog-api-key", api_key)
                            .json(&body)
                            .send()
                            .await
                            .map_err(|error| {
                                generic_error(format!("Image generation request failed: {error}"))
                            })?;
                        let status = response.status();
                        if !status.is_success() {
                            let response_body: Value =
                                response.json().await.unwrap_or_else(|_| json!({}));
                            return Err(api_error(
                                "Image generation failed",
                                status.as_u16(),
                                &response_body,
                            ));
                        }

                        let response_body: Value = response.json().await.map_err(|error| {
                            generic_error(format!(
                                "Failed to parse image generation response: {error}"
                            ))
                        })?;

                        // Parse steps[].content blocks where type == "image"
                        // (only model_output steps; thought steps are hidden drafts).
                        let images = gemini_stream::parse_interactions_images(&response_body);
                        return gemini_stream::collect_gemini_result(prompt, model, channel_label, images);
                    }

                    // --- Legacy: generateContent API ---
                    let mut generation_config = legacy_generation_config.clone();
                    if let Some(value) = request_seed {
                        generation_config["seed"] = json!(value);
                    }

                    // contents.parts: 参考图（图生图）在前，文本指令在后
                    let mut parts: Vec<Value> = Vec::new();
                    for image in request_images {
                        parts.push(json!({
                            "inlineData": {
                                "mimeType": image.mime_type,
                                "data": image.data,
                            }
                        }));
                    }
                    parts.push(json!({ "text": prompt }));

                    let mut body = json!({
                        "contents": [ { "parts": parts } ],
                        "generationConfig": generation_config,
                    });
                    if !tools.is_empty() {
                        body["tools"] = json!(tools);
                    }

                    let endpoint = if allow_stream {
                        &legacy_stream_endpoint
                    } else {
                        &legacy_endpoint
                    };
                    let response = client
                        .post(endpoint)
                        .header("x-goog-api-key", api_key)
                        .json(&body)
                        .send()
                        .await
                        .map_err(|error| {
                            generic_error(format!("Image generation request failed: {error}"))
                        })?;
                    let status = response.status();
                    if !status.is_success() {
                        let response_body: Value =
                            response.json().await.unwrap_or_else(|_| json!({}));
                        return Err(api_error(
                            "Image generation failed",
                            status.as_u16(),
                            &response_body,
                        ));
                    }

                    // --- Streaming path: parse the SSE/JSON stream, forward inlineData ---
                    if allow_stream {
                        let images = gemini_stream::read_gemini_stream(response, on_chunk).await?;
                        return gemini_stream::collect_gemini_result(prompt, model, channel_label, images);
                    }

                    // --- Non-streaming path ---
                    let response_body: Value = response.json().await.map_err(|error| {
                        generic_error(format!(
                            "Failed to parse image generation response: {error}"
                        ))
                    })?;

                    let images = gemini_stream::parse_gemini_candidates(&response_body);
                    gemini_stream::collect_gemini_result(prompt, model, channel_label, images)
                }
            })
            .collect();

        let results = futures::future::join_all(tasks).await;
        merge_parallel_results(prompts[0], model, channel_label, requests, results)
    }
}

impl McpService for ImageGenService {
    fn id(&self) -> &str {
        SERVER_ID
    }

    fn tools(&self) -> Vec<McpTool> {
        vec![McpTool {
            server_id: SERVER_ID.to_string(),
            name: TOOL_GENERATE.to_string(),
            description: "Generate or edit image(s) using the INDEPENDENT image-generation configuration from Settings -> Image generation (separate from the conversation API; no built-in default model). TEXT-TO-IMAGE: pass only `prompt`. IMAGE-TO-IMAGE (edit / reference / restyle): pass `images` (reference images extracted from the user's attached images — either base64 from the @@image:...@@ tags, or the exact [Reference image #N for imagegen-generate: {...}] JSON blocks present in textified user messages when the main model is text-only) plus an edit `prompt`; the server resolves `path` references itself, so you NEVER need to copy huge base64 strings. OpenAI uses POST /v1/images/edits, Gemini embeds inlineData parts. Supported backends: OpenAI-compatible (gpt-image / dall-e) and Google Gemini Imagen (optional Google Search grounding). Provider auto-detected from the configured base URL unless overridden. IMPORTANT: your current default channel, provider, model, size and quality are listed at the end of this description under \"Current configuration:\". For normal requests OMIT both `model` and `provider` so the configured defaults are inherited — only pass them when the user EXPLICITLY asks to override the model or channel (e.g. \"use Gemini\", \"use gpt-image-2\"); guessing models from this static text is what causes 404s. USE THIS when the user asks to create, draw, generate, render, edit, restyle, or vary an image — ESPECIALLY when the user attached reference image(s): edit/vary THOSE images (image-to-image) instead of generating a new image from the text description alone. RENDERING RULE: after the tool returns, the generated image(s) are automatically shown to the user via a dedicated image UI component -- you MUST NOT use Markdown image syntax (![...](path)) to display them, and you MUST NOT echo the returned file paths back to the user; just reply with a natural, brief text response (e.g. what you drew, or asking if they want changes). TRANSPARENT BACKGROUND: when the user needs a transparent-background image (desktop pet, sticker, logo overlay, PNG cutout), pass background=\"transparent\" AND outputFormat=\"png\" AND prefer model gpt-image-1, the only model that can actually output transparency. gpt-image-2 CANNOT produce transparent backgrounds: requesting \"transparent\" there is silently downgraded to \"opaque\", so never expect transparency from gpt-image-2. dall-e-3 and Gemini ignore the background parameter entirely (always opaque). If the configured/available model cannot do transparency, tell the user and either switch to gpt-image-1 or generate with a plain solid background instead. MULTIPLE IMAGES / PARALLEL GENERATION: ONE call generates ONE image. To produce several images (e.g. a set with different styles or themes), call this tool MULTIPLE TIMES in parallel — one call per image, each with its own single `prompt` (and its own `images` group when editing). Parallel generation is ONLY possible through multiple separate calls: do NOT pass several prompts, a batch of styles, or `n` > 1 in a single call. (The legacy `n` / `prompts` / `requestImages` parameters remain accepted for backward compatibility but are NOT the way to generate multiple different images.)"
                .to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "prompt": {
                        "type": "string",
                        "description": "Description of the image to generate, or the edit instruction when reference images are provided (e.g. \"make it photorealistic\", \"put it in a cyberpunk city\"). The more specific (subject, style, lighting, composition, colors), the better the result."
                    },
                    "images": {
                        "type": "array",
                        "description": "Reference images for image-to-image editing: [{ \\\"data\\\": \\\"<base64>\\\", \\\"mimeType\\\": \\\"image/png\\\" }] or [{ \\\"path\\\": \\\"upload/2026-07-25/x.png\\\", \\\"mimeType\\\": \\\"image/png\\\" }]. For `data`, extract base64 from the user's attached images in the conversation (the @@image:data:...@@ tags / multimodal image blocks). For `path`, copy the exact JSON object from a [Reference image #N for imagegen-generate: ...] block in a textified user message (text-only main model), or use the file's absolute disk path (e.g. C:/Users/xx/photo.png): relative paths are resolved against the conversation's upload/ directory; the server reads the file itself, so do NOT paste raw base64 into the context. Max 5 images, ~20MB each. When provided: OpenAI -> /images/edits endpoint; Gemini -> inlineData parts (prompt-based editing). When `requestImages` is provided, this `images` group is IGNORED (each request uses its own group).",
                        "items": {
                            "type": "object",
                            "properties": {
                                "data": { "type": "string", "description": "Base64-encoded image data (without the data: prefix)" },
                                "path": { "type": "string", "description": "Absolute disk path (e.g. C:/path/to/photo.png) or a path relative to the conversation's upload/ directory (e.g. upload/2026-07-25/hash.png, from [Reference image #N for imagegen-generate: ...] blocks)" },
                                "mimeType": { "type": "string", "description": "Image MIME type, e.g. image/png, image/jpeg, image/webp" }
                            },
                            "required": ["data", "mimeType"]
                        }
                    },
                    "prompts": {
                        "type": "array",
                        "description": "LEGACY / NOT RECOMMENDED: an array of 1-8 prompt strings, one per image (mutually exclusive with `n`; when provided, the request count equals the array length). Do NOT use this to generate several different images — generate multiple images by calling this tool multiple times in parallel, one call per image with a single `prompt`. Kept only for backward compatibility; omit it and use the top-level `prompt`.",
                        "items": { "type": "string" },
                        "minItems": 1,
                        "maxItems": 8
                    },
                    "requestImages": {
                        "type": "array",
                        "description": "LEGACY / NOT RECOMMENDED: an array with exactly N groups (N = number of requests = length of `prompts`, or `n`), each group an array of reference images shaped like `images` (see above); group i is used by request i. Do NOT use this to restyle several source images in one call — make one call per source image (each with its own `images` group) instead, in parallel. Kept only for backward compatibility.",
                        "items": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "data": { "type": "string", "description": "Base64-encoded image data (without the data: prefix)" },
                                    "path": { "type": "string", "description": "Absolute disk path (e.g. C:/path/to/photo.png) or a path relative to the conversation's upload/ directory (e.g. upload/2026-07-25/hash.png, from [Reference image #N for imagegen-generate: ...] blocks)" },
                                    "mimeType": { "type": "string", "description": "Image MIME type, e.g. image/png, image/jpeg, image/webp" }
                                },
                                "required": ["data", "mimeType"]
                            }
                        },
                        "minItems": 1,
                        "maxItems": 8
                    },
                    "model": {
                        "type": "string",
                        "description": "Image model to override the one configured in Settings -> Image generation. OpenAI: gpt-image-1, gpt-image-2, dall-e-3. Gemini (recommended Nano Banana family): gemini-3.1-flash-image (Nano Banana 2, default pick), gemini-3.1-flash-lite-image (Nano Banana 2 Lite, fastest/cheapest, 1K only), gemini-3-pro-image (Nano Banana Pro, up to 14 reference images + 4K + interleaved text), gemini-2.5-flash-image (legacy). NOTE: Imagen models are deprecated and shut down 2026-08-17. CAPABILITY RULES (sending unsupported requests yields a 400): dall-e-3 is text-to-image ONLY (no reference images) and always generates exactly 1 image (n>1 is clamped to 1); imagen models are text-to-image only too; gpt-image / Nano Banana / gemini-2.5-flash-image accept reference images. TRANSPARENT BACKGROUND: only gpt-image-1 can output transparent PNGs; gpt-image-2 and dall-e-3 cannot (transparent falls back to opaque), Gemini is always opaque — pick gpt-image-1 whenever the user asks for a transparent background / cutout / sticker / desktop pet. IMPORTANT: only set this when the user EXPLICITLY asks to override the configured model (see \"Current configuration:\" at the end of the tool description); for normal requests OMIT it so the configured default is inherited. Passing a model that does not match the selected channel's protocol fails locally instead of being sent upstream.",
                    },
                    "provider": {
                        "type": "string",
                        "description": "Image channel override: a channel ID or channel name configured in Settings -> Image generation (config-list scope=imagegen lists them), or a protocol type \"openai\" (OpenAI-compatible Images API) / \"gemini\" (Google Gemini Imagen) to pick the first usable channel of that type. Omit or \"auto\" to use the current default channel (see \"Current configuration:\" at the end of the tool description). IMPORTANT: only set this when the user EXPLICITLY asks to override the channel; for normal requests OMIT it. If you must override the model, prefer passing `provider` together with it so the model is sent to the right channel.",
                        "default": "auto"
                    },
                    "size": {
                        "type": "string",
                        "description": "Output size. OpenAI: e.g. \"1024x1024\", \"1024x1536\", \"1536x1024\" (omit to use the configured default). Gemini: \"1K\", \"2K\", \"4K\" (imageSize) or an aspect ratio like \"16:9\", \"1:1\", \"9:16\" (aspectRatio)."
                    },
                    "quality": {
                        "type": "string",
                        "description": "Rendering quality: \"low\", \"medium\", \"high\" or \"auto\". OpenAI: gpt-image models only, ignored for dall-e. Gemini: low/medium/high (imageQuality).",
                        "enum": ["low", "medium", "high", "auto"]
                    },
                    "outputFormat": {
                        "type": "string",
                        "description": "Output format for OpenAI: \"png\", \"jpeg\" or \"webp\" (default png). Ignored for dall-e and Gemini.",
                        "enum": ["png", "jpeg", "webp"]
                    },
                    "outputCompression": {
                        "type": "number",
                        "description": "OpenAI only: JPEG/WebP compression level 0-100 (e.g. 50 = 50%). Ignored for PNG and Gemini.",
                        "minimum": 0,
                        "maximum": 100
                    },
                    "n": {
                        "type": "number",
                        "description": "LEGACY / NOT RECOMMENDED for generating multiple images: 1-8 (default 1). To generate several images, call this tool multiple times in parallel (one call per image) instead of raising `n`. Kept for backward compatibility only: n>1 internally fans out to n concurrent sub-requests of the SAME prompt (one image each — the relay/upstream does not accept n>1 in a single request) and returns them together; streaming preview is disabled when n>1; dall-e-3 always returns exactly 1 image.",
                        "default": 1,
                        "minimum": 1,
                        "maximum": 8
                    },
                    "personGeneration": {
                        "type": "string",
                        "description": "Gemini only: person generation policy — \"dont_allow\" (default), \"allow_all\", or \"allow_adult\".",
                        "enum": ["dont_allow", "allow_all", "allow_adult"]
                    },
                    "webSearch": {
                        "type": "boolean",
                        "description": "Gemini only: enable Google Search grounding so the model can incorporate real-time web information into the generated image. Defaults to the setting configured in Settings -> Image generation. Ignored for OpenAI."
                    },
                    "stream": {
                        "type": "boolean",
                        "description": "Stream intermediate preview images to the conversation while generating (OpenAI gpt-image partial images / Gemini streamGenerateContent). Defaults to the setting configured in Settings -> Image generation. Ignored for dall-e models and image edits.",
                        "default": false
                    },
                    "inputFidelity": {
                        "type": "string",
                        "description": "OpenAI image edits only: how strongly the model preserves details from the reference images — \"low\", \"high\", or \"auto\" (default). Not allowed for gpt-image-2 (always high fidelity).",
                        "enum": ["low", "high", "auto"]
                    },
                    "background": {
                        "type": "string",
                        "description": "OpenAI only: output background — \"opaque\" (default), \"transparent\", or \"auto\". Model support matrix: gpt-image-1 supports all three (transparent requires outputFormat=\"png\"); gpt-image-2 supports opaque/auto ONLY — \"transparent\" is automatically downgraded to \"opaque\" by the tool; dall-e-3 and Gemini ignore this parameter (always opaque). For true transparent PNG output (stickers, desktop pets, cutouts) use gpt-image-1 + background=\"transparent\" + outputFormat=\"png\".",
                        "enum": ["opaque", "transparent", "auto"]
                    },
                    "moderation": {
                        "type": "string",
                        "description": "OpenAI only: moderation strictness — \"auto\" (default) or \"low\" (less restrictive filtering). Ignored for Gemini.",
                        "enum": ["auto", "low"]
                    },
                    "seed": {
                        "type": "number",
                        "description": "Deterministic seed for reproducible results (OpenAI and Gemini both support it)."
                    },
                    "thinkingLevel": {
                        "type": "string",
                        "description": "Gemini 3.1 Flash Image only: reasoning effort before rendering — \"minimal\" (default, faster) or \"high\" (better quality, slower). Other models ignore it.",
                        "enum": ["minimal", "high"]
                    },
                    "imageSearch": {
                        "type": "boolean",
                        "description": "Gemini 3.1 Flash Image only: enable Google Image Search grounding so the model can use real web images as visual context (search_types: [\"web_search\", \"image_search\"]). Requires displaying search suggestions. Other models ignore it."
                    },
                    "negativePrompt": {
                        "type": "string",
                        "description": "Gemini Imagen only: negative prompt — comma-separated visual attributes to avoid (e.g. \"blurry, low quality, distorted hands\"). Written into generationConfig.negativePrompt of the Imagen generateContent request. Nano Banana (gemini 2.5 / 3 image models) and OpenAI do NOT support negative prompts (their guidance is to describe the desired result positively) — the value is ignored for those models."
                    }
                },
                "required": ["prompt"]
            }),
        }, McpTool {
            server_id: SERVER_ID.to_string(),
            name: TOOL_DESCRIBE_NAME.to_string(),
            description: "Analyze an image file on disk with the vision model (uses the vision channel of the main API config) and return a structured description. USE THIS when the user asks you to read/understand a design image from the project (e.g. UI mockups, design screenshots, Figma exports) and implement or recreate it as code — for example 'look at the design in design/home.png and build this page'. The `path` accepts an absolute disk path (e.g. C:/Users/xx/project/design/home.png or /home/user/project/design/home.png) or a path relative to the conversation's upload/ directory (upload/2026-07-25/hash.png). Max 20MB, image formats only. Combine with filesystem tools: list/search the project for design files first, then describe each relevant image, then write the implementation code. The description focuses on UI/UX details (layout, colors with hex codes, typography, spacing, components, effects) so it can be translated directly into front-end code."
                .to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Path of the image to analyze: absolute disk path (e.g. C:/Users/xx/project/design/home.png) or upload/ relative path."
                    },
                    "prompt": {
                        "type": "string",
                        "description": "Optional custom analysis focus (e.g. \\\"focus on the color palette and spacing\\\"). Defaults to a UI/UX design description prompt."
                    }
                },
                "required": ["path"]
            }),
        }]
    }

    fn execute(&self, tool_name: &str, _args: &Value) -> napi::Result<Value> {
        match tool_name {
            TOOL_GENERATE => Err(generic_error(
                "The ImageGen tool must be executed through the asynchronous executor"
                    .to_string(),
            )),
            TOOL_DESCRIBE => Err(generic_error(
                "The image-describe tool must be executed through the asynchronous executor"
                    .to_string(),
            )),
            _ => Err(generic_error(format!(
                "Unknown tool: \"{tool_name}\" for MCP server \"{SERVER_ID}\". Available tools: [imagegen-generate, imagegen-image-describe]"
            ))),
        }
    }
}

/// 从 system_settings 表加载独立的前端「图像生成」设置。
/// 兼容三种存储格式：
/// - 新版：{ "channels": [ {...}, ... ] }（多渠道）
/// - 旧双渠道：{ openai: {...}, gemini: {...} } → 迁移为 channels 数组
/// - 更旧单渠道：顶层 provider/baseUrl/apiKey/model/... → 迁移为单个渠道
fn load_imagegen_settings() -> napi::Result<ImageGenSettings> {
    let storage_info = crate::storage::initialize_app_storage()?;
    let database_path = std::path::PathBuf::from(storage_info.database_path);
    let value = crate::storage::services::system_settings::get_system_setting_value(
        &database_path,
        IMAGE_GEN_SETTING_CODE,
    )?;
    match value {
        Some(raw) => {
            let parsed: Value = serde_json::from_str(&raw).map_err(|error| {
                Error::from_reason(format!(
                    "Failed to parse image generation settings: {error}"
                ))
            })?;

            // 新版多渠道格式
            if let Some(channels) = parsed.get("channels") {
                if channels.is_array() {
                    return serde_json::from_value(parsed).map_err(|error| {
                        Error::from_reason(format!(
                            "Failed to parse image generation settings: {error}"
                        ))
                    });
                }
            }

            // 旧双渠道格式：{openai, gemini} → channels
            if parsed.get("openai").is_some() || parsed.get("gemini").is_some() {
                let mut channels = Vec::new();
                for (key, provider) in [("openai", "openai"), ("gemini", "gemini")] {
                    if let Some(channel_value) = parsed.get(key) {
                        if !channel_value.is_object() {
                            continue;
                        }
                        let mut channel: ImageGenChannel =
                            serde_json::from_value(channel_value.clone()).map_err(|error| {
                                Error::from_reason(format!(
                                    "Failed to parse image generation settings: {error}"
                                ))
                            })?;
                        channel.id = key.to_string();
                        channel.provider = provider.to_string();
                        channels.push(channel);
                    }
                }
                return Ok(ImageGenSettings {
                    channels,
                    timeout_secs: None,
                });
            }

            // 更旧单渠道格式（顶层字段）→ 迁移为一个渠道
            let old_provider = parsed.get("provider").and_then(Value::as_str).unwrap_or("");
            let old_base_url = parsed.get("baseUrl").and_then(Value::as_str).unwrap_or("");
            let is_gemini = old_provider == "gemini"
                || old_base_url.contains("generativelanguage")
                || old_base_url.contains("googleapis.com");
            let mut channel = ImageGenChannel {
                enabled: true,
                base_url: old_base_url.to_string(),
                api_key: parsed
                    .get("apiKey")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                model: parsed
                    .get("model")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                default_size: parsed
                    .get("defaultSize")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                default_quality: parsed
                    .get("defaultQuality")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                output_format: parsed
                    .get("outputFormat")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                web_search: parsed
                    .get("webSearch")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                default_stream: parsed
                    .get("defaultStream")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                ..ImageGenChannel::default()
            };
            if is_gemini {
                channel.id = "gemini".to_string();
                channel.provider = "gemini".to_string();
            } else {
                channel.id = "openai".to_string();
                channel.provider = "openai".to_string();
            }
            Ok(ImageGenSettings {
                channels: vec![channel],
                timeout_secs: None,
            })
        }
        None => Ok(ImageGenSettings::default()),
    }
}

/// 是否有至少一个可用的生图渠道（用于工具暴露过滤：两个渠道都未配置时
/// 不把 imagegen-generate 注册给模型）。
pub fn is_imagegen_configured() -> napi::Result<bool> {
    Ok(load_imagegen_settings()?.has_enabled_channel())
}

/// 当前默认（第一个可用）渠道的非敏感摘要，注入到 imagegen-generate 工具
/// 定义中，让 Agent 看到实际配置而不再从静态说明里猜测模型/渠道。
/// 返回 None 表示没有任何可用渠道（此时工具不应暴露）。
/// 绝不包含 API Key、Base URL 等敏感信息。调用方应通过 spawn_blocking
/// 执行（内部有 SQLite 读取）。
pub fn default_channel_context() -> napi::Result<Option<String>> {
    let settings = load_imagegen_settings()?;
    let Some(channel) = settings.channels.iter().find(|channel| channel.is_usable()) else {
        return Ok(None);
    };
    let mut parts = vec![format!(
        "Current default image channel: {}",
        channel.display_name()
    )];
    let channel_id = channel.id.trim();
    if !channel_id.is_empty() {
        parts.push(format!("Channel ID: {channel_id}"));
    }
    parts.push(format!("Provider: {}", channel.provider));
    parts.push(format!("Configured model: {}", channel.model.trim()));
    let default_size = channel.default_size.trim();
    if !default_size.is_empty() {
        parts.push(format!("Default size: {default_size}"));
    }
    let default_quality = channel.default_quality.trim();
    if !default_quality.is_empty() {
        parts.push(format!("Default quality: {default_quality}"));
    }
    parts.push(
        "For normal requests OMIT both `model` and `provider` to inherit these configured defaults; only pass them when the user explicitly asks to override the model or channel."
            .to_string(),
    );
    Ok(Some(parts.join("\n")))
}

/// 解析生图渠道：显式 `provider` 参数优先；`auto`/缺省时选择第一个可用
/// 渠道（按设置中的渠道顺序）。`provider` 参数支持三种匹配方式：
/// - 协议类型："openai" / "gemini"（匹配该协议的第一个可用渠道）
/// - 渠道 ID（设置面板自动生成，config-list 可查）
/// - 渠道名称（用户自定义显示名）
/// 渠道未启用或凭据不全时报错并列出可用渠道，方便 agent 修正参数。
///
/// 显式 `model` 与渠道的一致性保护（issue #63）：
/// - `auto`/缺省 + 显式 model：优先路由到「配置模型与显式模型相同」的可用
///   渠道；找不到时对「明显跨协议」组合（Gemini 模型名发给 OpenAI 渠道等）
///   本地报错，而不是发到上游后得到 404。
/// - 显式 `provider` + 显式 model：尊重显式选择，不做跨协议拦截（OpenAI
///   兼容中转站可能使用 gemini-* 等自定义模型名）。
fn resolve_channel<'a>(
    args: &Value,
    settings: &'a ImageGenSettings,
) -> napi::Result<(&'a str, &'a ImageGenChannel)> {
    let requested = args
        .get("provider")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "auto")
        .map(str::to_string);

    // 显式 model（Agent 猜测或用户明确要求覆盖时才会出现）
    let explicit_model = args
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    match requested.as_deref() {
        Some(key) => {
            let key_lower = key.to_lowercase();
            let channel = if key_lower == "openai" || key_lower == "gemini" {
                // 协议类型：匹配该协议的第一个可用渠道
                settings.channels.iter().find(|channel| {
                    channel.is_usable() && channel.provider.eq_ignore_ascii_case(&key_lower)
                })
            } else {
                // 渠道 ID 或显示名
                settings.channels.iter().find(|channel| {
                    channel.is_usable()
                        && (channel.id.eq_ignore_ascii_case(key)
                            || channel.name.trim().eq_ignore_ascii_case(key))
                })
            };
            match channel {
                Some(channel) => Ok((channel.provider.as_str(), channel)),
                None => Err(Error::from_reason(format!(
                    "Channel \"{key}\" is not configured or not usable (needs enabled + API key + model). {}",
                    available_channels_summary(settings)
                ))),
            }
        }
        None => {
            // auto / 缺省 + 显式 model：先尝试路由到配置模型匹配的渠道
            if let Some(model) = explicit_model.as_deref() {
                if let Some(channel) = settings.channels.iter().find(|channel| {
                    channel.is_usable() && channel.model.trim().eq_ignore_ascii_case(model)
                }) {
                    return Ok((channel.provider.as_str(), channel));
                }
            }
            let Some(channel) = settings.channels.iter().find(|channel| channel.is_usable()) else {
                return Err(Error::from_reason(format!(
                    "No image generation channel configured. Configure at least one channel in Settings -> Image generation (API key + model), then the imagegen-generate tool becomes available. {}",
                    available_channels_summary(settings)
                )));
            };
            // 明显跨协议错配：本地拦截，避免把 Gemini 模型名发给
            // OpenAI-compatible 渠道后得到上游 404。
            if let Some(model) = explicit_model.as_deref() {
                if let Some(reason) = cross_protocol_mismatch(model, &channel.provider) {
                    return Err(Error::from_reason(format!(
                        "Model \"{model}\" does not match the default image channel \"{}\" (provider: {}, configured model: {}). {reason} Omit `model` to inherit the configured default, or pass `provider` with a channel that supports this model. {}",
                        channel.display_name(),
                        channel.provider,
                        channel.model.trim(),
                        available_channels_summary(settings)
                    )));
                }
            }
            Ok((channel.provider.as_str(), channel))
        }
    }
}

/// 显式 model 与渠道协议「明显」跨协议错配的检测。仅拦截关键词级别的
/// 冲突（Gemini/Imagen 模型名发给 OpenAI 渠道、OpenAI 模型名发给 Gemini
/// 渠道），避免误伤自定义模型名；显式指定 provider 时不调用（用户明确
/// 选择渠道，即使模型名奇怪也应尊重，例如 OpenAI 兼容中转站）。
fn cross_protocol_mismatch(model: &str, provider: &str) -> Option<String> {
    let model_lower = model.to_lowercase();
    if provider == "openai" && (model_lower.starts_with("gemini") || model_lower.contains("imagen"))
    {
        return Some(format!(
            "\"{model}\" is a Google Gemini/Imagen model name, which is incompatible with the OpenAI-compatible Images API."
        ));
    }
    if provider == "gemini" && (model_lower.starts_with("gpt-image") || model_lower.starts_with("dall-e"))
    {
        return Some(format!(
            "\"{model}\" is an OpenAI model name, which is incompatible with the Gemini Imagen API."
        ));
    }
    None
}

/// 可用渠道摘要（列出 id / 名称 / 协议，帮助 agent 通过 provider 参数指定渠道）。
fn available_channels_summary(settings: &ImageGenSettings) -> String {
    let usable: Vec<String> = settings
        .channels
        .iter()
        .filter(|channel| channel.is_usable())
        .map(|channel| {
            format!(
                "\"{}\" (id={}, provider={})",
                channel.display_name(),
                channel.id,
                channel.provider
            )
        })
        .collect();
    if usable.is_empty() {
        "No usable channels.".to_string()
    } else {
        format!("Usable channels: {}", usable.join(", "))
    }
}

/// 渠道端点：渠道 baseUrl > 官方默认（按渠道自身协议类型）。
fn channel_base_url(channel: &ImageGenChannel) -> String {
    non_empty(&channel.base_url).unwrap_or_else(|| {
        if channel.provider == "gemini" {
            DEFAULT_GEMINI_BASE_URL.to_string()
        } else {
            DEFAULT_OPENAI_BASE_URL.to_string()
        }
    })
}

fn non_empty(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

async fn build_client(timeout_secs: Option<u64>) -> napi::Result<reqwest::Client> {
    // 收敛到允许范围（1 分钟 ~ 1 小时），防止异常配置值导致请求被
    // 立刻掐断（过小）或无限挂起（过大）。
    let timeout = timeout_secs
        .unwrap_or(REQUEST_TIMEOUT_SECS)
        .clamp(MIN_TIMEOUT_SECS, MAX_TIMEOUT_SECS);
    crate::api::http_client::build_proxied_client_with_timeout(Duration::from_secs(timeout))
        .await
        .map_err(|error| Error::from_reason(format!("Failed to create HTTP client: {error}")))
}

fn api_error(prefix: &str, status: u16, response_body: &Value) -> Error {
    let message = response_body
        .get("error")
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .unwrap_or("Unknown error");
    let error_type = response_body
        .get("error")
        .and_then(|error| error.get("type"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let mut detail = format!("{prefix}: {status} {message}");
    if !error_type.is_empty() {
        detail.push_str(&format!(" (type: {error_type})"));
    }
    // 400 错误附加常见修复提示，帮助 agent 一步自愈（而不是反复触发同一错误）。
    if status == 400 {
        if let Some(hint) = hint_for_api_400(message) {
            detail.push_str(&format!(" {hint}"));
        }
    }
    generic_error(detail)
}

/// 常见 400 错误的修复提示（命中关键词时给出具体建议）。
fn hint_for_api_400(message: &str) -> Option<&'static str> {
    let lower = message.to_ascii_lowercase();
    if lower.contains("number of images") || (lower.contains("n must be") && lower.contains("1")) {
        return Some(
            "Possible cause: this model does not support generating multiple images per request (n>1). Retry with n=1.",
        );
    }
    if (lower.contains("image") || lower.contains("multimodal"))
        && (lower.contains("not supported")
            || lower.contains("does not support")
            || lower.contains("input"))
    {
        return Some(
            "Possible cause: this model does not support image inputs (image-to-image). Retry without reference images, or use gpt-image-1/gpt-image-2 / a Gemini Nano Banana model for editing.",
        );
    }
    if lower.contains("size") && (lower.contains("invalid") || lower.contains("not supported")) {
        return Some(
            "Possible cause: the requested size / aspect ratio is not supported by this model. Retry with a supported size (e.g. 1024x1024 for OpenAI, 1K/2K/4K or a 12-ratio preset for Gemini).",
        );
    }
    if lower.contains("quality") && (lower.contains("invalid") || lower.contains("not supported")) {
        return Some(
            "Possible cause: the requested quality value is not supported by this model. Retry with quality=\"auto\" or omit quality.",
        );
    }
    None
}

fn build_result(
    prompt: &str,
    model: &str,
    provider: &str,
    generated: usize,
    mut content: Vec<Value>,
    remote_urls: Vec<String>,
) -> Value {
    // 生成图落盘到图库目录并写入索引（失败不阻断：保留 base64 块继续展示）
    let _ = crate::storage::persist_generated_images(prompt, model, provider, &mut content);

    let mut summary = format!(
        "Success: generated {generated} image(s) with {model} ({provider}). \
         The image(s) are already displayed to the user via the built-in image UI component — do NOT render them again with Markdown image syntax (![...](...)) or repeat the file paths; just reply naturally."
    );
    if !remote_urls.is_empty() {
        summary.push_str(&format!(" Remote URLs: {}", remote_urls.join(", ")));
    }

    let mut result = json!({
        "prompt": prompt,
        "model": model,
        "provider": provider,
        "imageCount": generated,
        "content": content,
        "contentPreview": summary,
    });
    if !remote_urls.is_empty() {
        result["remoteUrls"] = json!(remote_urls);
    }
    result
}

/// 合并单次调用内并发子请求的结果（content / remoteUrls / imageCount 汇总）。
/// 每个子请求返回完整的 build_result 输出（其图片块已落库为 path 引用，
/// 合并后再次调用 build_result 对已是 path 的块幂等跳过）。
/// 至少 1 个子请求成功即整体成功，失败数量与原因追加到 contentPreview；
/// 全部失败才返回错误。
fn merge_parallel_results(
    prompt: &str,
    model: &str,
    provider: &str,
    total: usize,
    results: Vec<napi::Result<Value>>,
) -> napi::Result<Value> {
    let mut content: Vec<Value> = Vec::new();
    let mut remote_urls: Vec<String> = Vec::new();
    let mut generated = 0usize;
    let mut failures: Vec<String> = Vec::new();
    for result in results {
        match result {
            Ok(value) => {
                if let Some(blocks) = value.get("content").and_then(Value::as_array) {
                    content.extend(blocks.iter().cloned());
                }
                if let Some(urls) = value.get("remoteUrls").and_then(Value::as_array) {
                    for url in urls {
                        if let Some(url) = url.as_str() {
                            remote_urls.push(url.to_string());
                        }
                    }
                }
                generated += value.get("imageCount").and_then(Value::as_u64).unwrap_or(0) as usize;
            }
            Err(error) => failures.push(error.to_string()),
        }
    }
    if generated == 0 {
        let message = failures
            .first()
            .cloned()
            .unwrap_or_else(|| "All parallel image requests failed".to_string());
        return Err(generic_error(message));
    }
    let mut result = build_result(prompt, model, provider, generated, content, remote_urls);
    if !failures.is_empty() {
        if let Some(preview) = result.get("contentPreview").and_then(Value::as_str) {
            result["contentPreview"] = json!(format!(
                "{preview} {}/{} parallel requests failed: {}",
                failures.len(),
                total,
                failures.join(" | ")
            ));
        }
    }
    Ok(result)
}

fn required_string<'a>(args: &'a Value, key: &str, tool_name: &str) -> napi::Result<&'a str> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                format!("{key} is required for tool \"{tool_name}\""),
            )
        })
}

fn mime_for_format(format: &str) -> String {
    match format.to_ascii_lowercase().as_str() {
        "jpeg" | "jpg" => "image/jpeg".to_string(),
        "webp" => "image/webp".to_string(),
        _ => "image/png".to_string(),
    }
}

/// 根据模型能力规整 `background` 参数：
/// - 仅接受 opaque / transparent / auto，其余值直接丢弃
/// - gpt-image-2 不支持透明背景，`transparent` 自动降级为 `opaque`（等同默认值）
fn sanitize_background(model: &str, background: Option<&str>) -> Option<String> {
    let value = background?;
    if !matches!(value, "opaque" | "transparent" | "auto") {
        return None;
    }
    if value == "transparent" && model.to_ascii_lowercase().contains("gpt-image-2") {
        return Some("opaque".to_string());
    }
    Some(value.to_string())
}

/// 判断上游错误是否为“该模型不支持透明背景”（部分第三方/代理模型会拒绝
/// `background=transparent` 并返回 400）。命中时由调用方去掉该参数重试一次。
fn is_transparent_unsupported_error(response_body: &Value) -> bool {
    let message = response_body
        .get("error")
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    message.contains("transparent")
        && (message.contains("background") || message.contains("not supported"))
}

fn generic_error(message: String) -> Error {
    Error::new(Status::GenericFailure, message)
}
