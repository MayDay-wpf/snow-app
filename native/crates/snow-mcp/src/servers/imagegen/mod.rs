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

use super::super::servers::bash::{BashStreamCallback, BashStreamChunk};
use super::super::service::McpService;
use super::super::tools::McpTool;

mod gemini_stream;
mod limiter;
mod openai_stream;
mod options;
mod providers;
mod reference_image;
mod result_privacy;
mod runtime;

use reference_image::ReferenceImage;

const SERVER_ID: &str = "imagegen";
pub const TOOL_GENERATE: &str = "generate";
/// 视觉分析工具：读取项目中的图片（如 UI 设计稿）并用视觉模型生成描述，
/// 供主模型理解设计后编码还原（前端页面等）。
const TOOL_DESCRIBE: &str = "image-describe";

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
/// 单次工具调用内并发生成图片的最大数量（1-10，grok-imagine-image-2.0
/// 官方支持一次最多 10 张；其余模型由前端按能力裁剪）。中转/上游不支持
/// 单请求多图（n>1），实现上把一次调用拆成 n 个并发子请求（每个子请求
/// n=1）绕开该限制。
const MAX_PARALLEL_IMAGES: usize = 10;
/// 远程图片（预签名 URL 等）下载上限（50 MB，与主进程 img-proxy 协议一致），
/// 防止上游 URL 指向超大文件耗尽内存。
const MAX_REMOTE_IMAGE_BYTES: usize = 50 * 1024 * 1024;
/// 远程图片下载单次超时（预签名链接通常秒级返回，30s 足够）。
const REMOTE_IMAGE_TIMEOUT_SECS: u64 = 30;
/// GPT Image 2.6 GIF 单帧上限（与静态图共用单边 / 总像素预算）。
const GIF_MAX_SHEET_EDGE: u64 = 3840;
const GIF_MAX_SHEET_PIXELS: u64 = 8_294_400;
const GIF_MIN_FRAMES: u64 = 2;
const GIF_MAX_FRAMES: u64 = 16;
const GIF_MIN_FRAME_DURATION_MS: u64 = 20;
const GIF_MAX_FRAME_DURATION_MS: u64 = 2000;

/// system_settings 表中的设置 code（与设置面板共用）。
const IMAGE_GEN_SETTING_CODE: &str = "imagegen_settings";

const DEFAULT_OPENAI_BASE_URL: &str = "https://api.openai.com/v1";
const DEFAULT_GEMINI_BASE_URL: &str = "https://generativelanguage.googleapis.com/v1beta";
/// NovelAI 原生图片 API 默认端点（主机根地址，无 `/v1` 路径段；
/// 请求按 `{base}/ai/generate-image` 拼接）。
const DEFAULT_NOVELAI_BASE_URL: &str = "https://image.novelai.net";

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
    /// Global real upstream request concurrency, shared by sync/async and legacy fan-out.
    max_concurrent_images: Option<usize>,
    /// 生图执行模式（"auto" | "sync" | "async"，默认 "auto"）。
    #[serde(default)]
    pub execution_mode: Option<String>,
}

impl ImageGenSettings {
    /// 是否有至少一个已启用且凭据齐全的渠道。
    fn has_enabled_channel(&self) -> bool {
        self.channels.iter().any(ImageGenChannel::is_usable)
    }
}

/// 渠道内配置的单个绘图模型的独立参数项。
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ImageGenModelItem {
    pub id: String,
    pub model: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub default_size: String,
    #[serde(default)]
    pub default_quality: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_complexity: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_output_format: Option<String>,
    #[serde(default)]
    pub supported_ratios: String,
    #[serde(default)]
    pub supported_resolutions: String,
    #[serde(default)]
    pub supported_thinking: String,
    #[serde(default)]
    pub custom_prompt: String,
    #[serde(default = "default_model_enabled")]
    pub enabled: bool,
}

fn default_model_enabled() -> bool {
    true
}

/// 渠道内模型列表的容错反序列化：`models` 是新增字段，历史/手工编辑的存储
/// 可能包含类型不符的脏数据。若其中一个模型项解析失败，**不应让整个 imagegen
/// 设置加载失败**（否则工具会整体消失）；此处逐项解析并跳过非法项，保证
/// 其余合法模型与渠道仍可用。
fn deserialize_models_lenient<'de, D>(
    deserializer: D,
) -> std::result::Result<Vec<ImageGenModelItem>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    // 注意：本模块通过 `napi::bindgen_prelude::*` 引入了 napi 版 `Result` /
    // `Deserialize`，此处必须用全限定 std/serde 路径，否则泛型错误类型会被
    // 套成 `napi::Error<D::Error>` 而无法满足 `AsRef<str>` 约束。
    let raw = <Option<Vec<Value>> as serde::Deserialize>::deserialize(deserializer)?;
    Ok(raw
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| serde_json::from_value::<ImageGenModelItem>(item).ok())
        .collect())
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
    /// 默认主绘图模型名（未配置 models 时作为唯一模型；配置 models 时作为默认模型）
    model: String,
    default_size: String,
    default_quality: String,
    output_format: String,
    /// Gemini 联网搜索（Grounding with Google Search），仅 Gemini 生效
    web_search: bool,
    /// 默认流式预览（partial image 实时推送到会话页），工具参数 stream 可覆盖
    default_stream: bool,
    /// 用户配置的模型支持的宽高比（逗号分隔，如 "1:1, 16:9, 9:16, 4:3, 3:4, 21:9"）
    #[serde(default)]
    supported_ratios: String,
    /// 用户配置的模型支持的分辨率档位（如 "1K, 2K, 4K" 或具体像素尺寸）
    #[serde(default)]
    supported_resolutions: String,
    /// 用户配置的模型支持的思考强度选项（如 "low, medium, high"）
    #[serde(default)]
    supported_thinking: String,
    /// 用户自定义的提示词/模型特性说明（注入给工具提示词，告诉模型此渠道的特殊要求或能力）
    #[serde(default)]
    custom_prompt: String,
    /// 渠道专属执行模式（可选覆写：auto / sync / async）
    #[serde(default)]
    pub execution_mode: Option<String>,
    /// 渠道内配置的多个独立生图模型列表（每个模型有独立的尺寸/画质/思考强度/提示词配置）
    #[serde(default, deserialize_with = "deserialize_models_lenient")]
    models: Vec<ImageGenModelItem>,
}

impl ImageGenChannel {
    fn is_usable(&self) -> bool {
        if !self.enabled || self.api_key.trim().is_empty() {
            return false;
        }
        !self.model.trim().is_empty()
            || self
                .models
                .iter()
                .any(|m| m.enabled && !m.model.trim().is_empty())
    }

    /// 取得当前生效的默认主模型 ID。
    fn primary_model(&self) -> String {
        let m = self.model.trim();
        if !m.is_empty() {
            return m.to_string();
        }
        self.models
            .iter()
            .find(|item| item.enabled && !item.model.trim().is_empty())
            .map(|item| item.model.trim().to_string())
            .unwrap_or_default()
    }

    /// 获取当前渠道全部可用模型配置（向后兼容：若 models 为空，则从渠道顶层字段合成默认模型项）。
    fn get_model_items(&self) -> Vec<ImageGenModelItem> {
        let active_models: Vec<ImageGenModelItem> = self
            .models
            .iter()
            .filter(|item| item.enabled && !item.model.trim().is_empty())
            .cloned()
            .collect();
        if !active_models.is_empty() {
            return active_models;
        }
        let m = self.model.trim();
        if !m.is_empty() {
            vec![ImageGenModelItem {
                id: m.to_string(),
                model: m.to_string(),
                name: self.name.clone(),
                default_size: self.default_size.clone(),
                default_quality: self.default_quality.clone(),
                default_complexity: None,
                default_output_format: None,
                supported_ratios: self.supported_ratios.clone(),
                supported_resolutions: self.supported_resolutions.clone(),
                supported_thinking: self.supported_thinking.clone(),
                custom_prompt: self.custom_prompt.clone(),
                enabled: true,
            }]
        } else {
            Vec::new()
        }
    }

    /// 根据调用的 model ID 查找其专属的参数配置项（尺寸、画质、思考强度等）。
    ///
    /// 匹配优先级（高 → 低）：
    /// 1. 精确匹配（忽略大小写）；
    /// 2. 中转前缀 / 别名包含匹配（如 `[yu]gpt-image-2.5-flare` 匹配
    ///    `gpt-image-2.5-flare`）——**取最长命中**，避免 `gpt-image-2` 抢先
    ///    匹配掉更具体的 `gpt-image-2.5-flare`；
    /// 3. 兜底首个模型项（Agent 传了渠道未登记的模型时，继承渠道默认参数）。
    fn find_model_config(&self, requested_model: &str) -> Option<ImageGenModelItem> {
        let req = requested_model.trim().to_ascii_lowercase();
        let items = self.get_model_items();
        if items.is_empty() {
            return None;
        }
        if req.is_empty() {
            return items.first().cloned();
        }
        // 1. 精确匹配 model ID
        if let Some(matched) = items
            .iter()
            .find(|item| item.model.trim().eq_ignore_ascii_case(&req))
        {
            return Some(matched.clone());
        }
        // 2. 模糊/中转前缀匹配：取最长命中项（最具体的那个）
        let longest = items
            .iter()
            .filter(|item| {
                let m_lower = item.model.trim().to_ascii_lowercase();
                !m_lower.is_empty() && (req.contains(&m_lower) || m_lower.contains(&req))
            })
            .max_by_key(|item| item.model.trim().len());
        if let Some(matched) = longest {
            return Some(matched.clone());
        }
        // 3. 兜底首个模型
        items.first().cloned()
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
    /// 编码还原前端页面」的工作流。主模型支持视觉时直接用主通道，否则
    /// 复用主 API 的 vision 通道。
    pub async fn execute_describe(
        &self,
        args: &Value,
        conversation_id: Option<&str>,
    ) -> napi::Result<Value> {
        let path = required_string(args, "path", TOOL_DESCRIBE)?;
        let user_prompt = args
            .get("prompt")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .unwrap_or(DEFAULT_DESCRIBE_PROMPT);

        let description =
            crate::api::vision::describe_image_file(path, user_prompt, conversation_id).await?;

        Ok(json!({
            "path": path,
            "description": description,
            "note": "Use this description to understand the design. If the task is to recreate this UI with code, analyze the description carefully (layout, colors, typography, spacing, components) and implement it with the filesystem tools. Do NOT reference the image file in the final code — embed colors/values from the description."
        }))
    }

    async fn generate_with_settings(
        &self,
        args: &Value,
        on_chunk: Option<&BashStreamCallback>,
        settings: &ImageGenSettings,
    ) -> napi::Result<Value> {
        let prompt = required_string(args, "prompt", TOOL_GENERATE)?;
        // Legacy multi-image calls acquire the shared real-request limiter per image.
        let n = args
            .get("n")
            .and_then(Value::as_u64)
            .map(|value| value as usize)
            .unwrap_or(DEFAULT_N)
            .max(1)
            .min(MAX_PARALLEL_IMAGES);

        // The supervisor owns a stable settings snapshot for credentials, mode and error redaction.
        let timeout_secs = settings.timeout_secs;

        // --- 2. Resolve channel (provider): argument > first usable channel ---
        let channel = resolve_channel(args, &settings)?;
        let provider = channel.0;
        let channel_config = channel.1;
        let channel_label = channel_config.display_name();

        // --- 3. Resolve credentials / endpoint from the channel ---
        let base_url = channel_base_url(channel_config);
        let api_key = channel_config.api_key.trim();

        // Generation and auto mode share the same model-level default resolution and capability filtering.
        let options::ResolvedImageOptions {
            model,
            size,
            quality,
        } = options::resolve_options(args, channel_config)?;
        let supported_thinking = channel_config
            .find_model_config(&model)
            .map(|item| item.supported_thinking.trim().to_string())
            .unwrap_or_default();
        // 这些默认值只属于精确匹配的模型，不沿用模糊匹配或首项兜底。
        let selected_model = channel_config.models.iter().find(|item| {
            item.enabled && item.model.trim().eq_ignore_ascii_case(&model)
        });
        let output_format = args
            .get("outputFormat")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| {
                selected_model
                    .and_then(|item| item.default_output_format.as_deref())
                    .and_then(non_empty)
            })
            .or_else(|| non_empty(&channel_config.output_format));
        let is_gif_output = provider == "openai"
            && output_format
                .as_deref()
                .is_some_and(|format| format.eq_ignore_ascii_case("gif"));
        let frame_count = optional_bounded_integer(
            args,
            "frameCount",
            GIF_MIN_FRAMES,
            GIF_MAX_FRAMES,
        )?;
        let frame_duration_ms = optional_bounded_integer(
            args,
            "frameDurationMs",
            GIF_MIN_FRAME_DURATION_MS,
            GIF_MAX_FRAME_DURATION_MS,
        )?;
        if !is_gif_output && (frame_count.is_some() || frame_duration_ms.is_some()) {
            return Err(Error::new(
                Status::InvalidArg,
                "`frameCount` / `frameDurationMs` are only supported with OpenAI GPT Image 2.6 GIF output (`outputFormat: \"gif\"`)"
                    .to_string(),
            ));
        }

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
        // Gemini 参考图数量上限（官方文档）：Nano Banana 2/2.1/3系列 14 张，2.5 Flash Image 3 张。
        if provider == "gemini" && !images.is_empty() {
            let max_ref = if model_lower.contains("2.5") { 3 } else { 14 };
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
        // 思考强度：**仅 Gemini 图像模型有该官方请求参数**
        // （`generation_config.thinking_level`，Google 官方文档 Thinking 页）。
        // OpenAI Images API 官方参数表（model/prompt/background/moderation/n/
        // output_compression/output_format/partial_images/quality/response_format/
        // size/stream/style/user）不含任何推理强度字段，故对 OpenAI 渠道一律不解析、
        // 不下发（避免把非官方字段发给上游）。
        let thinking_level = if provider == "gemini" {
            args.get("thinkingLevel")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                // 发送前按模型声明的 supported_thinking 校验：已声明但不在列表内
                // 则不下发（上游会 400）；未声明 = 放行合法取值。
                .and_then(|value| sanitize_thinking_level(Some(&value), &supported_thinking))
        } else {
            None
        };
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

        // --- OpenAI 2.6 增量参数：complexity / safety_identifier / markup / mask ---
        // complexity：仅 OpenAI 渠道，显式参数优先于所选模型的默认值。
        // 仅精确匹配模型，避免其他模型的默认值通过模糊匹配或首项兜底继承。
        let complexity = if provider == "openai" {
            args.get("complexity")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .or_else(|| {
                    selected_model
                        .and_then(|item| item.default_complexity.as_deref())
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                })
                .map(|value| {
                    let lower = value.to_ascii_lowercase();
                    match lower.as_str() {
                        "low" | "medium" | "high" => Ok(lower),
                        _ => Err(Error::new(
                            Status::InvalidArg,
                            format!(
                                "`complexity` must be one of \"low\", \"medium\", \"high\", got \"{value}\""
                            ),
                        )),
                    }
                })
                .transpose()?
        } else {
            None
        };
        // safety_identifier：可选，最长 128 字符；新代码不发送 `user` 字段。
        let safety_identifier = if provider == "openai" {
            args.get("safetyIdentifier")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| {
                    if value.chars().count() > 128 {
                        Err(Error::new(
                            Status::InvalidArg,
                            format!(
                                "`safetyIdentifier` must be at most 128 characters, got {}",
                                value.chars().count()
                            ),
                        ))
                    } else {
                        Ok(value.to_string())
                    }
                })
                .transpose()?
        } else {
            None
        };
        let markup = args.get("markup").and_then(Value::as_bool).unwrap_or(false);
        // mask：OpenAI edits 的局部重绘蒙版（multipart `mask` 部件）。
        let mask = reference_image::parse_mask(args, &database_path)?;

        // --- 新增参数组合校验（发送前本地拦截，避免上游 400 / 静默降级） ---
        let is_edits = !images.is_empty() || !request_images.is_empty();
        // markup 仅 OpenAI（标注编辑）；mask 支持 OpenAI（multipart `mask`）与
        // NovelAI（infill 蒙版），Gemini 两者皆不支持。
        if markup && provider != "openai" {
            return Err(Error::from_reason(
                "`markup` is only supported for OpenAI image edits; it is ignored by other providers".to_string(),
            ));
        }
        if mask.is_some() && provider != "openai" && provider != "novelai" {
            return Err(Error::from_reason(
                "`mask` is only supported for OpenAI / NovelAI image edits; it is ignored by Gemini".to_string(),
            ));
        }
        if (mask.is_some() || markup) && !is_edits {
            return Err(Error::new(
                Status::InvalidArg,
                "`mask` / `markup` require at least one reference image (`images`) for an image edit"
                    .to_string(),
            ));
        }
        if markup && mask.is_some() {
            return Err(Error::new(
                Status::InvalidArg,
                "`markup` (annotation layer as the first `images` entry) and `mask` are mutually exclusive; pass only one of them"
                    .to_string(),
            ));
        }
        // output_format=svg/gif 是 OpenAI 概念（NovelAI 恒为 PNG、Gemini 恒为
        // 模型决定）：仅对 OpenAI 渠道生效——svg/gif 仅文生图（generations），
        // 图生图遇到这两个值必须显式报错，不能静默改回 png。
        if provider == "openai" {
            let format_lower = output_format
                .as_deref()
                .map(|value| value.to_ascii_lowercase());
            if is_edits && matches!(format_lower.as_deref(), Some("svg" | "gif")) {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!(
                        "output_format \"{}\" is only supported for text-to-image generation, not image edits; use png/jpeg/webp for edits",
                        format_lower.as_deref().unwrap_or("")
                    ),
                ));
            }
            // svg 输出必须为单张（n=1）。
            if format_lower.as_deref() == Some("svg") && requests > 1 {
                return Err(Error::new(
                    Status::InvalidArg,
                    "output_format \"svg\" requires a single image (n=1), got multiple requests"
                        .to_string(),
                ));
            }
        }

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
            "novelai" => {
                self.generate_novelai(
                    args,
                    per_request_prompts.as_slice(),
                    &model,
                    &size,
                    &base_url,
                    api_key,
                    requests,
                    per_request_images.as_slice(),
                    seed,
                    negative_prompt.as_deref(),
                    mask.as_ref(),
                    &channel_label,
                    timeout_secs,
                )
                .await
            }
            _ => {
                let size = normalize_openai_size(
                    &model,
                    &size,
                    output_format.as_deref(),
                    frame_count,
                )?;
                self.generate_openai(
                    args,
                    per_request_prompts.as_slice(),
                    &model,
                    &size,
                    &quality,
                    &output_format,
                    frame_count,
                    frame_duration_ms,
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
                    complexity.as_deref(),
                    safety_identifier.as_deref(),
                    mask.as_ref(),
                    &channel_label,
                    timeout_secs,
                )
                .await
            }
        }
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
                    "mode": {
                        "type": "string",
                        "description": "Execution mode: \"auto\" (default: decided by settings and prompt context), \"sync\" (block until complete; use when next step needs the image file), or \"async\" (dispatch to background task and return immediately; use for wallpapers, batch images, or long-running tasks).",
                        "enum": ["auto", "sync", "async"]
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
                        "description": "Image model to override the one configured in Settings -> Image generation. OpenAI: gpt-image-1, gpt-image-2, dall-e-3. Gemini (recommended Nano Banana family): gemini-nano-banana-2.1 (Nano Banana 2.1, latest), gemini-3.1-flash-image (Nano Banana 2), gemini-3.1-flash-lite-image (Nano Banana 2 Lite, fastest/cheapest, 1K only), gemini-3-pro-image (Nano Banana Pro, up to 14 reference images + 4K + interleaved text), gemini-2.5-flash-image (legacy). NovelAI: nai-diffusion-5-full / nai-diffusion-5-curated / nai-diffusion-4-5-full / nai-diffusion-4-5-curated / nai-diffusion-4-full / nai-diffusion-3 (anime / furry), via the native image.novelai.net API. NOTE: Imagen models are deprecated and shut down 2026-08-17. CAPABILITY RULES (sending unsupported requests yields a 400): dall-e-3 is text-to-image ONLY (no reference images) and always generates exactly 1 image (n>1 is clamped to 1); imagen models are text-to-image only too; gpt-image / Nano Banana / gemini-2.5-flash-image accept reference images; NovelAI edits accept a single base image (img2img) plus an optional mask (infill). TRANSPARENT BACKGROUND: only gpt-image-1 can output transparent PNGs; gpt-image-2 and dall-e-3 cannot (transparent falls back to opaque), Gemini is always opaque — pick gpt-image-1 whenever the user asks for a transparent background / cutout / sticker / desktop pet. IMPORTANT: only set this when the user EXPLICITLY asks to override the configured model (see \"Current configuration:\" at the end of the tool description); for normal requests OMIT it so the configured default is inherited. Passing a model that does not match the selected channel's protocol fails locally instead of being sent upstream.",
                    },
                    "provider": {
                        "type": "string",
                        "description": "Image channel override: a channel ID or channel name configured in Settings -> Image generation (config-manage action=list scope=imagegen lists them), or a protocol type \"openai\" (OpenAI-compatible Images API) / \"gemini\" (Google Gemini Imagen) / \"novelai\" (NovelAI native image.novelai.net API) to pick the first usable channel of that type. Omit or \"auto\" to use the current default channel (see \"Current configuration:\" at the end of the tool description). IMPORTANT: only set this when the user EXPLICITLY asks to override the channel; for normal requests OMIT it. If you must override the model, prefer passing `provider` together with it so the model is sent to the right channel.",
                        "default": "auto"
                    },
                    "size": {
                        "type": "string",
                        "description": "Output size. OpenAI: e.g. \"1024x1024\", \"1024x1536\", \"1536x1024\" (omit to use the configured default). For GPT Image 2.6 GIF this is the per-frame size; Snow App automatically reduces it to fit the frame-sheet pixel budget for the selected frameCount. Gemini: \"1K\", \"2K\", \"4K\" (imageSize) or an aspect ratio like \"16:9\", \"1:1\", \"9:16\" (aspectRatio)."
                    },
                    "quality": {
                        "type": "string",
                        "description": "Rendering quality: \"low\", \"medium\", \"high\", \"xhigh\", \"max\" or \"auto\". OpenAI: gpt-image-2 / 2.5 models (2.5 adds xhigh and max). Gemini: low/medium/high (imageQuality).",
                        "enum": ["low", "medium", "high", "xhigh", "max", "auto"]
                    },
                    "complexity": {
                        "type": "string",
                        "description": "OpenAI gpt-image-2.6+ (sunburst / flare) only: generation complexity — \"low\", \"medium\" or \"high\". Overrides the selected model's defaultComplexity; if neither is set, the upstream default applies.",
                        "enum": ["low", "medium", "high"]
                    },
                    "outputFormat": {
                        "type": "string",
                        "description": "Output format for OpenAI: \"png\" (default), \"jpeg\", \"webp\", \"svg\" or \"gif\". svg/gif are text-to-image only (generations) — image edits must use png/jpeg/webp and reject svg/gif; svg requires a single image (n=1); svg/gif never send stream / partial_images / output_compression. GPT Image 2.6 GIF frame size is automatically fitted to the model's frame-sheet pixel budget. Ignored for dall-e and Gemini.",
                        "enum": ["png", "jpeg", "webp", "svg", "gif"]
                    },
                    "frameCount": {
                        "type": "integer",
                        "description": "OpenAI GPT Image 2.6 GIF only: number of frames, 2-16 (upstream default 9). The frame count participates in the frame-sheet pixel budget; Snow App automatically lowers the requested frame size when needed.",
                        "minimum": 2,
                        "maximum": 16
                    },
                    "frameDurationMs": {
                        "type": "integer",
                        "description": "OpenAI GPT Image 2.6 GIF only: delay per frame in milliseconds, 20-2000 (upstream default 200; rounded to 10 ms by the API).",
                        "minimum": 20,
                        "maximum": 2000
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
                        "description": "Gemini only: enable Google Search grounding so the model can incorporate real-time web information into the generated image. Supported by Nano Banana 2.1 / 3.1 Flash Image / 3 Pro Image. Defaults to the setting configured in Settings -> Image generation. Ignored for OpenAI and NovelAI."
                    },
                    "stream": {
                        "type": "boolean",
                        "description": "Stream intermediate preview images to the conversation while generating (OpenAI gpt-image partial images / Gemini Interactions API step.delta events / Gemini streamGenerateContent). Defaults to the setting configured in Settings -> Image generation. Ignored for dall-e models and image edits.",
                        "default": false
                    },
                    "inputFidelity": {
                        "type": "string",
                        "description": "OpenAI image edits only: how strongly the model preserves details from the reference images — \"low\", \"high\", or \"auto\" (default). Not allowed for gpt-image-2 (always high fidelity).",
                        "enum": ["low", "high", "auto"]
                    },
                    "markup": {
                        "type": "boolean",
                        "description": "OpenAI image edits only (gpt-image-2.6+): markup editing — the FIRST `images` entry is the annotation layer drawn over the base image, followed by the base/reference image(s). Mutually exclusive with `mask` (passing both is an explicit error). Requires at least one reference image."
                    },
                    "mask": {
                        "type": "object",
                        "description": "OpenAI image edits only: inpainting mask image {data, mimeType} or {path, mimeType} (same shape as one `images` entry), sent as the multipart `mask` part. Mutually exclusive with `markup` (passing both is an explicit error); requires at least one reference image.",
                        "properties": {
                            "data": { "type": "string", "description": "Base64-encoded image data (without the data: prefix)" },
                            "path": { "type": "string", "description": "Absolute disk path or upload/ relative path" },
                            "mimeType": { "type": "string", "description": "Image MIME type, e.g. image/png" }
                        }
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
                    "safetyIdentifier": {
                        "type": "string",
                        "maxLength": 128,
                        "description": "OpenAI only: optional safety identifier for content provenance (max 128 characters), sent as safety_identifier. New code never sends a `user` field."
                    },
                    "seed": {
                        "type": "number",
                        "description": "Deterministic seed for reproducible results (OpenAI and Gemini both support it)."
                    },
                    "thinkingLevel": {
                        "type": "string",
                        "description": "Gemini image models only: thinking level written to generation_config.thinking_level (Nano Banana 2.1 / 3.1 Flash Image / 3 Pro Image etc.). Supported values differ per model (e.g. Nano Banana 2.1: \"minimal\", \"medium\", \"high\"; Gemini 3 Pro Image: \"high\"). Not supported by OpenAI-compatible image endpoints — their Images API has no reasoning/thinking parameter.",
                        "enum": ["minimal", "low", "medium", "high"]
                    },
                    "imageSearch": {
                        "type": "boolean",
                        "description": "Gemini Nano Banana 2.1 / 3.1 Flash Image only: enable Google Image Search grounding so the model can use real web images as visual context (search_types: [\"web_search\", \"image_search\"]). Requires displaying search suggestions. Other models ignore it."
                    },
                    "negativePrompt": {
                        "type": "string",
                        "description": "Negative prompt — comma-separated visual attributes to avoid (e.g. \"blurry, low quality, distorted hands\"). Gemini Imagen: written into generationConfig.negativePrompt. NovelAI: sent as the `uc` field. Nano Banana (gemini 2.5 / 3 image models) and OpenAI do NOT support negative prompts (their guidance is to describe the desired result positively) — the value is ignored for those models."
                    }
                },
                "required": ["prompt"]
            }),
        }, McpTool {
            server_id: SERVER_ID.to_string(),
            name: TOOL_DESCRIBE.to_string(),
            description: "Analyze an image file on disk with the vision model (uses the main model directly when it supports vision, otherwise the vision channel of the main API config) and return a structured description. USE THIS when the user asks you to read/understand a design image from the project (e.g. UI mockups, design screenshots, Figma exports) and implement or recreate it as code — for example 'look at the design in design/home.png and build this page'. The `path` accepts an absolute disk path (e.g. C:/Users/xx/project/design/home.png or /home/user/project/design/home.png) or a path relative to the conversation's upload/ directory (upload/2026-07-25/hash.png). Max 20MB, image formats only. Combine with filesystem tools: list/search the project for design files first, then describe each relevant image, then write the implementation code. The description focuses on UI/UX details (layout, colors with hex codes, typography, spacing, components, effects) so it can be translated directly into front-end code."
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
                    timeout_secs: parsed.get("timeoutSecs").and_then(Value::as_u64),
                    max_concurrent_images: parsed
                        .get("maxConcurrentImages")
                        .and_then(Value::as_u64)
                        .map(|value| value as usize),
                    execution_mode: parsed
                        .get("executionMode")
                        .and_then(Value::as_str)
                        .map(str::to_string),
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
                timeout_secs: parsed.get("timeoutSecs").and_then(Value::as_u64),
                max_concurrent_images: parsed
                    .get("maxConcurrentImages")
                    .and_then(Value::as_u64)
                    .map(|value| value as usize),
                execution_mode: parsed
                    .get("executionMode")
                    .and_then(Value::as_str)
                    .map(str::to_string),
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

/// 格式化单个渠道内模型项（子模型）的独立能力说明：尺寸/画质/思考强度/提示词。
/// 用于把「一个渠道多个模型、每个模型参数不同」的事实完整暴露给 Agent。
fn format_model_item_capabilities(item: &ImageGenModelItem) -> Vec<String> {
    let mut lines = Vec::new();
    let label = if item.name.trim().is_empty() {
        item.model.trim().to_string()
    } else {
        format!("{} ({})", item.name.trim(), item.model.trim())
    };
    lines.push(format!("Model: {label}"));
    let size = item.default_size.trim();
    if !size.is_empty() {
        lines.push(format!("  default size: {size}"));
    }
    let quality = item.default_quality.trim();
    if !quality.is_empty() {
        lines.push(format!("  default quality: {quality}"));
    }
    let thinking = item.supported_thinking.trim();
    if !thinking.is_empty() {
        lines.push(format!("  thinking: {thinking}"));
    }
    let ratios = item.supported_ratios.trim();
    let resolutions = item.supported_resolutions.trim();
    if !ratios.is_empty() {
        lines.push(format!("  aspect ratios: {ratios}"));
    }
    if !resolutions.is_empty() {
        lines.push(format!("  resolutions: {resolutions}"));
    }
    // 两项都留空 = 用户未声明尺寸范围 → 发送前的 `sanitize_size` 跳过校验、
    // 放行任意合法尺寸。多模型渠道下必须显式告知 Agent：渠道级说明只覆盖主模型，
    // 若此处静默，Agent 会误以为该模型不能自定义尺寸而不敢传 size。
    if ratios.is_empty() && resolutions.is_empty() {
        lines.push(
            "  size limits: not declared (the backend does not restrict size; any valid value is passed through)"
                .to_string(),
        );
    }
    let notes = item.custom_prompt.trim();
    if !notes.is_empty() {
        lines.push(format!("  notes: {notes}"));
    }
    lines
}

/// 渠道内所有子模型的摘要（供工具描述与错误提示列出可调用模型）。
/// 若渠道未配置 models（旧数据），回退为单条顶层模型摘要，保持向后兼容。
fn channel_model_summaries(channel: &ImageGenChannel) -> Vec<String> {
    let items = channel.get_model_items();
    if items.is_empty() {
        return Vec::new();
    }
    items
        .iter()
        .map(|item| {
            let mut line = format!(
                "  - {} (model={})",
                if item.name.trim().is_empty() {
                    "unnamed"
                } else {
                    item.name.trim()
                },
                item.model.trim()
            );
            let mut traits = Vec::new();
            if !item.default_size.trim().is_empty() {
                traits.push(format!("size={}", item.default_size.trim()));
            }
            if !item.default_quality.trim().is_empty() {
                traits.push(format!("quality={}", item.default_quality.trim()));
            }
            if !traits.is_empty() {
                line.push_str(&format!(" [{}]", traits.join(", ")));
            }
            line
        })
        .collect()
}

/// 格式化当前生效模型的能力与参数特性说明。
///
/// 能力**只认模型项（`models[]`）的声明**：渠道顶层字段只是主模型的兼容镜像，
/// 读取它会让非主模型拿到错误的能力（宽高比/思考强度凭空出现或消失）。模型项
/// 未声明某项能力时，按模型名给出内置兜底说明供 Agent 参考。
fn format_channel_capabilities(
    channel: &ImageGenChannel,
    model_item: Option<&ImageGenModelItem>,
) -> Vec<String> {
    let mut lines = Vec::new();

    // 兜底分支按「当前生效模型」判定：模型项存在时用它自己的模型名，
    // 否则退回渠道主模型名。
    let m = model_item
        .map(|item| item.model.trim())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| channel.model.trim())
        .to_ascii_lowercase();

    let ratios = model_item
        .map(|item| item.supported_ratios.trim())
        .unwrap_or("");
    if !ratios.is_empty() {
        lines.push(format!("Supported aspect ratios: {ratios}"));
    } else {
        if channel.provider == "gemini" {
            lines.push("Supported aspect ratios: 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 5:4, 4:5, 21:9 (1:4, 1:8, 4:1, 8:1 for ultra-wide)".to_string());
        } else if channel.provider == "novelai" {
            lines.push(
                "Supported aspect ratios: 2:3, 3:2, 1:1, 9:16, 16:9, 4:3, 3:4, 21:9"
                    .to_string(),
            );
        } else if m.contains("dall-e-3") {
            lines.push(
                "Supported aspect ratios: 1:1 (1024x1024), 16:9 (1792x1024), 9:16 (1024x1792)"
                    .to_string(),
            );
        } else if m.contains("qwen") || m.contains("wanx") {
            lines.push(
                "Supported aspect ratios: 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 21:9".to_string(),
            );
        } else if m.contains("niji") || m.contains("novelai") || m.contains("animagine") {
            lines.push("Supported aspect ratios: 1:1 (avatar), 2:3 / 9:16 (character portrait), 3:2 / 16:9 (landscape wallpaper)".to_string());
        } else if m.contains("gpt-image-1") {
            // gpt-image-1 / 1.5 / 1-mini：仅固定三种尺寸，比例受限。
            lines.push("Supported aspect ratios: 1:1, 3:2, 2:3".to_string());
        } else if m.contains("gpt-image-2") {
            // gpt-image-2 / 2.5：任意比例，仅受 1:3~3:1 与 3840px 上限约束。
            lines.push("Supported aspect ratios: any ratio between 1:3 and 3:1 (multiples of 16px, max edge 3840px)".to_string());
        } else {
            lines.push("Supported aspect ratios: 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 2:1, 1:2, 21:9, 5:4, 4:5".to_string());
        }
    }

    let resolutions = model_item
        .map(|item| item.supported_resolutions.trim())
        .unwrap_or("");
    if !resolutions.is_empty() {
        lines.push(format!("Supported resolutions / size tiers: {resolutions}"));
    } else {
        if channel.provider == "gemini" {
            lines.push(
                "Supported resolutions: 512px, 1K, 2K, 4K (format: \"16:9@2K\" or \"16:9\")"
                    .to_string(),
            );
        } else if channel.provider == "novelai" {
            lines.push(
                "Supported sizes: 832x1216, 1216x832, 1024x1024, 1024x1536, 1536x1024 (format: WIDTHxHEIGHT)"
                    .to_string(),
            );
        } else if m.contains("dall-e-3") {
            lines.push("Supported sizes: 1024x1024, 1792x1024, 1024x1792".to_string());
        } else if m.contains("qwen") || m.contains("wanx") {
            lines.push(
                "Supported resolutions: 1024x1024, 1280x720, 720x1280, 2048x2048 (up to native 2K)"
                    .to_string(),
            );
        } else if m.contains("flux") {
            lines.push(
                "Supported resolutions: 1024x1024, 1536x1024, 1792x1008, 2048x2048 (up to 4MP)"
                    .to_string(),
            );
        } else if m.contains("gpt-image-1") {
            // gpt-image-1 / 1.5 / 1-mini：仅固定三种尺寸。
            lines.push("Supported sizes: 1024x1024, 1536x1024, 1024x1536".to_string());
        } else {
            lines.push(
                "Supported resolution tiers: 1K, 2K, 4K (multiples of 16px, max side <=3840px)"
                    .to_string(),
            );
        }
    }

    // 思考强度：仅 Gemini 图像模型有官方请求参数（generation_config.thinking_level）；
    // OpenAI Images API 的官方参数表（model/prompt/background/moderation/n/
    // output_compression/output_format/partial_images/quality/response_format/
    // size/stream/style/user）不含任何推理强度字段，故不注入、也不下发。
    let thinking = model_item
        .map(|item| item.supported_thinking.trim())
        .unwrap_or("");
    if channel.provider == "gemini" {
        if !thinking.is_empty() {
            lines.push(format!("Supported thinking_level: {thinking}"));
        } else {
            lines.push("Thinking level (parameter: thinking_level in generation_config): minimal (fast), medium (balanced), high (deep thinking)".to_string());
        }
    }

    let prompt_notes = model_item
        .map(|item| item.custom_prompt.trim())
        .unwrap_or("");
    if !prompt_notes.is_empty() {
        lines.push(format!("Model prompt instructions: {prompt_notes}"));
    }

    lines
}

/// 当前默认（第一个可用）渠道的非敏感摘要，注入到 imagegen-generate 工具
/// 定义中，让 Agent 看到实际配置而不再从静态说明里猜测模型/渠道。
/// 返回 None 表示没有任何可用渠道（此时工具不应暴露）。
/// 绝不包含 API Key、Base URL 等敏感信息。调用方应通过 spawn_blocking
/// 执行（内部有 SQLite 读取）。
pub fn default_channel_context() -> napi::Result<Option<String>> {
    let settings = load_imagegen_settings()?;
    let usable_channels: Vec<&ImageGenChannel> = settings
        .channels
        .iter()
        .filter(|channel| channel.is_usable())
        .collect();
    let Some(channel) = usable_channels.first() else {
        return Ok(None);
    };

    let primary_model = channel.primary_model();
    // 当前默认生效的模型项（渠道主模型对应的那一条）。能力与默认值**只取模型项**：
    // 渠道顶层字段只是主模型的兼容镜像，读取它会让非主模型拿到错误的参数。
    let primary_item = channel.find_model_config(&primary_model);
    let primary_item_ref = primary_item.as_ref();
    let mut parts = vec![
        format!(
            "Current default image channel: \"{}\"",
            channel.display_name()
        ),
        format!("Channel ID: {}", channel.id.trim()),
        format!("Provider: {}", channel.provider),
        format!("Primary model: {primary_model}"),
    ];

    let default_size = primary_item_ref
        .map(|item| item.default_size.trim())
        .unwrap_or("");
    if !default_size.is_empty() {
        parts.push(format!("Default size: {default_size}"));
    }
    let default_quality = primary_item_ref
        .map(|item| item.default_quality.trim())
        .unwrap_or("");
    if !default_quality.is_empty() {
        parts.push(format!("Default quality: {default_quality}"));
    }

    parts.push("Model capabilities & dynamic parameters:".to_string());
    for cap in format_channel_capabilities(channel, primary_item_ref) {
        parts.push(format!("  * {cap}"));
    }

    // 一个渠道可配置多个模型，且每个模型的尺寸/画质/思考强度/提示词各不相同：
    // 逐模型列出其独立参数，Agent 才能按用户要求精准传 `model` 并继承对应默认值。
    // 单模型渠道不再重复罗列——上面能力块已按「模型项优先」注入同一份声明。
    let model_items = channel.get_model_items();
    if model_items.len() > 1 {
        parts.push(format!(
            "\nModels available in this channel ({} total; pass `model` to pick one, otherwise the primary model is used):",
            model_items.len()
        ));
        for item in &model_items {
            for line in format_model_item_capabilities(item) {
                parts.push(format!("  {line}"));
            }
            parts.push(String::new());
        }
        if parts.last().is_some_and(|line| line.is_empty()) {
            parts.pop();
        }
    }

    if usable_channels.len() > 1 {
        parts.push("\nOther available configured channels:".to_string());
        for (idx, ch) in usable_channels.iter().skip(1).enumerate() {
            let mut summary = format!(
                "  {}. \"{}\" (id={}, provider={}, model={})",
                idx + 1,
                ch.display_name(),
                ch.id,
                ch.provider,
                ch.primary_model()
            );
            let ch_primary_model = ch.primary_model();
            let ch_primary_item = ch.find_model_config(&ch_primary_model);
            let ch_primary_item_ref = ch_primary_item.as_ref();
            let mut traits = Vec::new();
            let ch_ratios = ch_primary_item_ref
                .map(|item| item.supported_ratios.trim())
                .unwrap_or("");
            if !ch_ratios.is_empty() {
                traits.push(format!("ratios: {ch_ratios}"));
            }
            // 思考强度仅 Gemini 渠道有该参数。
            if ch.provider == "gemini" {
                let ch_thinking = ch_primary_item_ref
                    .map(|item| item.supported_thinking.trim())
                    .unwrap_or("");
                if !ch_thinking.is_empty() {
                    traits.push(format!("thinking: {ch_thinking}"));
                }
            }
            let ch_notes = ch_primary_item_ref
                .map(|item| item.custom_prompt.trim())
                .unwrap_or("");
            if !ch_notes.is_empty() {
                traits.push(format!("notes: {ch_notes}"));
            }
            if !traits.is_empty() {
                summary.push_str(&format!(" -> [{}]", traits.join("; ")));
            }
            parts.push(summary);
            // 其他渠道内的子模型同样列出，避免 Agent 只看到主模型而误判。
            // 仅多模型渠道需要罗列（单模型的能力已并入上方 traits 摘要）。
            let other_models = channel_model_summaries(ch);
            if other_models.len() > 1 {
                parts.push("     models in this channel:".to_string());
                parts.extend(other_models);
            }
        }
    }

    parts.push(
        "\nFor normal requests OMIT both `model` and `provider` to inherit these configured defaults; only pass them when the user explicitly asks to override the model or channel. When a channel exposes several models, pass `model` with the exact ID from the list above to use that model's own defaults."
            .to_string(),
    );
    Ok(Some(parts.join("\n")))
}

/// 解析生图渠道：显式 `provider` 参数优先；`auto`/缺省时选择第一个可用
/// 渠道（按设置中的渠道顺序）。`provider` 参数支持三种匹配方式：
/// - 协议类型："openai" / "gemini"（匹配该协议的第一个可用渠道）
/// - 渠道 ID（设置面板自动生成，config-manage 的 action=list 可查）
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
            let channel = if matches!(key_lower.as_str(), "openai" | "gemini" | "novelai") {
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
            // auto / 缺省 + 显式 model：先尝试路由到配置模型匹配的渠道（支持多模型渠道内的子模型检索）
            if let Some(model) = explicit_model.as_deref() {
                if let Some(channel) = settings.channels.iter().find(|channel| {
                    channel.is_usable()
                        && (channel.model.trim().eq_ignore_ascii_case(model)
                            || channel
                                .models
                                .iter()
                                .any(|m| m.enabled && m.model.trim().eq_ignore_ascii_case(model)))
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
    if provider == "gemini"
        && (model_lower.starts_with("gpt-image") || model_lower.starts_with("dall-e"))
    {
        return Some(format!(
            "\"{model}\" is an OpenAI model name, which is incompatible with the Gemini Imagen API."
        ));
    }
    if provider == "novelai"
        && (model_lower.starts_with("gemini")
            || model_lower.contains("imagen")
            || model_lower.starts_with("gpt-image")
            || model_lower.starts_with("dall-e"))
    {
        return Some(format!(
            "\"{model}\" is not a NovelAI model name. NovelAI channels call the native image.novelai.net API and accept nai-diffusion-* models only."
        ));
    }
    None
}

/// 可用渠道摘要（列出 id / 名称 / 协议 / 主模型 / 渠道内全部模型 / 默认思考强度，
/// 帮助 agent 通过 provider + model 参数精确指定渠道与模型）。
fn available_channels_summary(settings: &ImageGenSettings) -> String {
    let usable: Vec<String> = settings
        .channels
        .iter()
        .filter(|channel| channel.is_usable())
        .map(|channel| {
            let mut summary = format!(
                "\"{}\" (id={}, provider={}, model={})",
                channel.display_name(),
                channel.id,
                channel.provider,
                channel.primary_model()
            );
            // 多模型渠道：把子模型 ID 一并列出，Agent 才能用 model 参数指定它们。
            let items = channel.get_model_items();
            if items.len() > 1 {
                let ids: Vec<String> = items
                    .iter()
                    .map(|item| item.model.trim().to_string())
                    .collect();
                summary.push_str(&format!(" [models: {}]", ids.join(" | ")));
            }
            summary
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
    non_empty(&channel.base_url).unwrap_or_else(|| match channel.provider.as_str() {
        "gemini" => DEFAULT_GEMINI_BASE_URL.to_string(),
        "novelai" => DEFAULT_NOVELAI_BASE_URL.to_string(),
        _ => DEFAULT_OPENAI_BASE_URL.to_string(),
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
         The image(s) are already displayed to the user via the built-in image UI component — do NOT render them again with Markdown image syntax (![...](...)) or repeat the file paths; just reply naturally. \
         To look at a generated image again (filesystem-read / imagegen-image-describe) or reuse it as a reference image for imagegen-generate, use the \"absolutePath\" field of each content block — the \"path\" field is a library-relative path that file tools cannot resolve."
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
        "svg" => "image/svg+xml".to_string(),
        "gif" => "image/gif".to_string(),
        _ => "image/png".to_string(),
    }
}

/// 将「支持范围」说明文本切分为小写词元集合。
///
/// `supported_ratios` / `supported_resolutions` / `supported_thinking` 是用户在
/// 设置面板自由填写的说明文本（如 `"1K (1792x1008), 2K (2560x1440)"`、
/// `"512px, 1K, 2K, 4K (支持 16:9@2K 组合语法)"`、`"low, medium, high"`），
/// 因此不能用精确相等判定，需按词元匹配。按空白与常见分隔符（逗号/分号/
/// 括号/竖线/斜杠/@）切分，`@` 也切分以便 `"16:9@2K"` 拆成比例与档位。
fn capability_tokens(raw: &str) -> Vec<String> {
    raw.split(|c: char| {
        c.is_whitespace() || matches!(c, ',' | ';' | '(' | ')' | '[' | ']' | '|' | '/' | '@')
    })
    .map(|token| token.trim().to_ascii_lowercase())
    .filter(|token| !token.is_empty())
    .collect()
}

/// 判断某个取值是否出现在支持列表中（大小写不敏感的词元匹配）。
fn capability_contains(raw: &str, value: &str) -> bool {
    let needle = value.trim().to_ascii_lowercase();
    if needle.is_empty() {
        return false;
    }
    capability_tokens(raw).iter().any(|token| token == &needle)
}

/// 「支持范围」是否已被用户显式声明（非空白）。
///
/// 三态语义：**未声明**（空）与**已声明**（有值）必须区分——
/// - 未声明：用户没配过（旧数据/未收录模型），宽松放行，保持原有行为；
/// - 已声明：用户明确写了范围，越界即拦截，避免上游 400。
fn capability_declared(raw: &str) -> bool {
    !raw.trim().is_empty()
}

/// 规整 Gemini 思考强度：只有模型项**已声明**支持范围且取值在其中时才下发，
/// 否则返回 None（不发送该参数），避免模型收到不支持的 `thinking_level` 而 400。
///
/// - `supported` 为空 = 未声明能力 → 宽松放行（保留归一化后的合法取值）；
/// - 取值先归一化（low/minimal → minimal），再与支持列表做词元匹配，
///   与下游 Gemini 分支的映射保持一致。
fn sanitize_thinking_level(requested: Option<&str>, supported: &str) -> Option<String> {
    let value = requested?.trim().to_ascii_lowercase();
    if value.is_empty() {
        return None;
    }
    // Nano Banana 2.1（gemini-nano-banana-2.1）官方新增 medium 档并设为默认
    // （Google 官方文档 Thinking 页），必须保留，否则用户在下拉里选的 medium
    // 会被静默丢弃。
    let effective = match value.as_str() {
        "minimal" | "low" => "minimal",
        "medium" => "medium",
        "high" => "high",
        _ => return None,
    };
    // 未声明支持范围 → 宽松放行；已声明 → 必须在范围内。
    if !capability_declared(supported) || capability_contains(supported, effective) {
        Some(effective.to_string())
    } else {
        None
    }
}

/// 按模型能力规整尺寸：拆解 `"16:9@2K"` / `"1K"` / `"16:9"` / `"1024x1024"` 等写法，
/// 与 `supported_ratios` / `supported_resolutions` 比对；已声明范围但取值越界时
/// 返回 None（不发送 size，交由上游默认），避免 400。
///
/// - `"auto"` 是 OpenAI 的合法取值，直接放行（不受比例/分辨率列表约束）；
/// - 两字段均未声明 = 未配置能力 → 宽松放行，保持原有行为不回退。
fn sanitize_size(
    requested: Option<&str>,
    supported_ratios: &str,
    supported_resolutions: &str,
) -> Option<String> {
    let raw = requested?.trim();
    if raw.is_empty() {
        return None;
    }
    if raw.eq_ignore_ascii_case("auto") {
        return Some(raw.to_string());
    }
    let ratios_declared = capability_declared(supported_ratios);
    let resolutions_declared = capability_declared(supported_resolutions);
    // 两段都未声明 → 无从校验，放行。
    if !ratios_declared && !resolutions_declared {
        return Some(raw.to_string());
    }
    // 组合写法「比例@档位」：已声明的那一段必须命中。
    if let Some((ratio_part, tier_part)) = raw.split_once('@') {
        let ratio = ratio_part.trim();
        let tier = tier_part.trim();
        let ratio_ok = !ratios_declared || capability_contains(supported_ratios, ratio);
        let tier_ok = !resolutions_declared || capability_contains(supported_resolutions, tier);
        return (ratio_ok && tier_ok).then(|| format!("{ratio}@{tier}"));
    }
    // 纯比例（含 ':'）→ 查 supported_ratios（未声明则放行）。
    if raw.contains(':') {
        if !ratios_declared || capability_contains(supported_ratios, raw) {
            return Some(raw.to_string());
        }
        return None;
    }
    // 纯档位（1K/2K/512px）或具体像素尺寸（1024x1024）→ 查 supported_resolutions。
    if !resolutions_declared || capability_contains(supported_resolutions, raw) {
        return Some(raw.to_string());
    }
    None
}

/// 解析可选的整数参数；显式传入非法类型或越界值时快速失败。
fn optional_bounded_integer(
    args: &Value,
    key: &str,
    min: u64,
    max: u64,
) -> napi::Result<Option<u64>> {
    let Some(value) = args.get(key) else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let Some(value) = value.as_u64() else {
        return Err(Error::new(
            Status::InvalidArg,
            format!("`{key}` must be an integer between {min} and {max}"),
        ));
    };
    if !(min..=max).contains(&value) {
        return Err(Error::new(
            Status::InvalidArg,
            format!("`{key}` must be between {min} and {max}, got {value}"),
        ));
    }
    Ok(Some(value))
}

/// GPT Image 2.6 将 GIF 帧排列在 frame sheet 上；不同帧数使用不同的网格，
/// 未使用的格子同样占用总像素预算。
fn gif_sheet_layouts(frame_count: u64) -> Vec<(u64, u64)> {
    match frame_count {
        2 => vec![(2, 1), (1, 2)],
        3..=4 => vec![(2, 2)],
        5..=8 => vec![(4, 2), (2, 4)],
        9 => vec![(3, 3)],
        10..=12 => vec![(4, 3), (3, 4)],
        13..=16 => vec![(4, 4)],
        _ => Vec::new(),
    }
}

/// 在保持画幅比例的前提下，把单帧尺寸缩到 frame sheet 能容纳的最大
/// 16 像素对齐尺寸。返回 None 表示画幅比例本身超出模型限制。
fn fit_gif_frame_size(width: u64, height: u64, frame_count: u64) -> Option<(u64, u64)> {
    let mut best: Option<(u64, u64)> = None;
    for (columns, rows) in gif_sheet_layouts(frame_count) {
        let cells = (columns * rows) as f64;
        let scale = 1.0_f64
            .min(GIF_MAX_SHEET_EDGE as f64 / (width as f64 * columns as f64))
            .min(GIF_MAX_SHEET_EDGE as f64 / (height as f64 * rows as f64))
            .min((GIF_MAX_SHEET_PIXELS as f64 / (width as f64 * height as f64 * cells)).sqrt());
        let fitted_width = ((width as f64 * scale) / 16.0).floor() as u64 * 16;
        let fitted_height = ((height as f64 * scale) / 16.0).floor() as u64 * 16;
        if fitted_width < 16 || fitted_height < 16 {
            continue;
        }

        let sheet_width = fitted_width * columns;
        let sheet_height = fitted_height * rows;
        if sheet_width > GIF_MAX_SHEET_EDGE
            || sheet_height > GIF_MAX_SHEET_EDGE
            || sheet_width * sheet_height > GIF_MAX_SHEET_PIXELS
        {
            continue;
        }
        // 单帧与 frame sheet 都必须落在 1:3 ~ 3:1 的画幅范围内。
        if fitted_width > fitted_height * 3
            || fitted_height > fitted_width * 3
            || sheet_width > sheet_height * 3
            || sheet_height > sheet_width * 3
        {
            continue;
        }

        let area = fitted_width * fitted_height;
        if best.is_none_or(|(best_width, best_height)| area > best_width * best_height) {
            best = Some((fitted_width, fitted_height));
        }
    }
    best
}

/// 校验 gpt-image-2 系列（含 2.5 / 2.6 sunburst / flare）的 OpenAI 尺寸：
/// 允许预设值（如 1024x1024）或自定义 `WIDTHxHEIGHT`，必须满足
/// - 两边为 16 的倍数
/// - 宽高比在 1:3 ~ 3:1 之间
/// - 单边不超过 3840
/// - 总像素在 655360 ~ 8294400 之间（0.625MP ~ 8.29MP）
/// 2.6 的 GIF 以单帧尺寸传入，但帧数会放大实际 frame sheet；此处自动把
/// 单帧缩到总像素预算内，`auto` 则交由上游选择。
/// 其他格式沿用既有规则，`auto` 或非 `WIDTHxHEIGHT` 写法放行。
fn normalize_openai_size(
    model: &str,
    size: &Option<String>,
    output_format: Option<&str>,
    frame_count: Option<u64>,
) -> napi::Result<Option<String>> {
    let model_lower = model.to_ascii_lowercase();
    if !model_lower.contains("gpt-image-2") {
        return Ok(size.clone());
    }
    let is_gif_2_6 = model_lower.contains("gpt-image-2.6")
        && output_format.is_some_and(|format| format.eq_ignore_ascii_case("gif"));
    let Some(raw) = size.as_deref().map(str::trim).filter(|raw| !raw.is_empty()) else {
        return Ok(size.clone());
    };
    if raw.eq_ignore_ascii_case("auto") {
        return Ok(Some(raw.to_string()));
    }
    let lower = raw.to_ascii_lowercase();
    let Some((width, height)) = lower.split_once('x') else {
        if is_gif_2_6 {
            return Err(Error::new(
                Status::InvalidArg,
                format!("Invalid size \"{raw}\": expected auto or WIDTHxHEIGHT with integer pixel values"),
            ));
        }
        // 非 WIDTHxHEIGHT 写法放行，保持既有行为。
        return Ok(size.clone());
    };
    let (Ok(width), Ok(height)) =
        (width.trim().parse::<u64>(), height.trim().parse::<u64>())
    else {
        return Err(Error::new(
            Status::InvalidArg,
            format!(
                "Invalid size \"{raw}\": expected WIDTHxHEIGHT with integer pixel values (e.g. 1024x1024)"
            ),
        ));
    };
    if width == 0 || height == 0 {
        return Err(Error::new(
            Status::InvalidArg,
            format!("Invalid size \"{raw}\": dimensions must be positive"),
        ));
    }
    if width % 16 != 0 || height % 16 != 0 {
        return Err(Error::new(
            Status::InvalidArg,
            format!(
                "Size \"{raw}\" is not supported by {model}: both sides must be multiples of 16 (e.g. 1024x1024, 1536x1024)."
            ),
        ));
    }
    if is_gif_2_6 {
        let (max_side, min_side) = (width.max(height), width.min(height));
        if max_side > min_side * 3 {
            return Err(Error::new(
                Status::InvalidArg,
                format!(
                    "Size \"{raw}\" is not supported by {model}: aspect ratio must be between 1:3 and 3:1 (got {width}x{height})."
                ),
            ));
        }
        let frames = frame_count.unwrap_or(9);
        let Some((fitted_width, fitted_height)) = fit_gif_frame_size(width, height, frames)
        else {
            return Err(Error::new(
                Status::InvalidArg,
                format!(
                    "GIF frame size \"{raw}\" cannot fit the GPT Image 2.6 frame-sheet limits with {frames} frames. Lower `frameCount`, use a simpler aspect ratio, or pass size \"auto\"."
                ),
            ));
        };
        if (fitted_width, fitted_height) != (width, height) {
            return Ok(Some(format!("{fitted_width}x{fitted_height}")));
        }
        return Ok(Some(raw.to_string()));
    }
    if width > 3840 || height > 3840 {
        return Err(Error::new(
            Status::InvalidArg,
            format!(
                "Size \"{raw}\" is not supported by {model}: each side must not exceed 3840px (got {width}x{height})."
            ),
        ));
    }
    let (max_side, min_side) = (width.max(height), width.min(height));
    if max_side > min_side * 3 {
        return Err(Error::new(
            Status::InvalidArg,
            format!(
                "Size \"{raw}\" is not supported by {model}: aspect ratio must be between 1:3 and 3:1 (got {width}x{height})."
            ),
        ));
    }
    let total = width * height;
    if total < 655360 || total > 8294400 {
        return Err(Error::new(
            Status::InvalidArg,
            format!(
                "Size \"{raw}\" is not supported by {model}: total pixels must be between 655360 and 8294400 (got {total})."
            ),
        ));
    }
    Ok(Some(raw.to_string()))
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

/// 检查 imagegen 域整体是否被用户允许（与 collect 阶段 imagegen-* 工具暴露
/// 的 scope 条件一致）：全局黑名单把核心 imagegen 工具全部禁用，或项目 scope
/// 禁用了 builtin:imagegen 服务器时返回 false——用户禁用了生图就不应在系统
/// 提示词中注入使用指引（否则提示词与工具可见性不一致）。
async fn imagegen_domain_scope_allowed(project_id: Option<&str>) -> napi::Result<bool> {
    use crate::mcp::tools::{builtin_scope_server_id, load_global_scope, load_project_scope};
    // 核心代表工具：任一未被全局禁用即认为域可用（collect 阶段按工具粒度
    // 过滤，工具级个别禁用不影响域级注入）。
    const CORE_IMAGEGEN_TOOLS: [&str; 2] = ["imagegen-generate", "imagegen-image-describe"];
    if let Some(global) = load_global_scope().await? {
        if CORE_IMAGEGEN_TOOLS
            .iter()
            .all(|tool| global.is_tool_disabled(tool))
        {
            return Ok(false);
        }
    }
    let Some(scope) = load_project_scope(project_id).await? else {
        return Ok(true);
    };
    Ok(scope.is_server_enabled(&builtin_scope_server_id("imagegen")))
}

/// 构建系统提示词注入的「Image Generation」章节（2026-08-16，仿 LSP 的
/// `build_system_prompt_section` 方案：注入条件与工具可见性一致 + 追加在
/// 提示词末尾最小化 prompt cache 前缀失效 + 失败静默降级）。
///
/// 配置了至少一个可用生图渠道（与 collect 阶段 `is_imagegen_configured`
/// 判定一致）时，返回一段 Markdown 指引：
/// - 列出可用渠道（id / 名称 / 协议，非敏感摘要，复用
///   `available_channels_summary`）；
/// - 多图规则：一次调用生成一张图，多图 MUST 并行多次调用（一次一图），
///   legacy 的 `prompts` / `n>1` 不是多图路径；
/// - 渲染事实：连续 ≥2 个并行调用由 UI 自动合并为 `ImageGenGallery` 统一
///   网格（并行调用是唯一多图路径），生成后图片自动展示，不得用 Markdown
///   图片语法或回显文件路径。
///
/// 无可用渠道、域 scope 禁用或任何查询失败时返回空字符串（静默降级——
/// 提示词构建不能因 imagegen 状态查询失败而打挂整个请求）。
pub async fn build_system_prompt_section(project_id: Option<&str>) -> String {
    // 与 collect 阶段 imagegen-* 工具暴露的 scope 条件一致：域被禁用时不
    // 注入——提示词指引必须与工具可见性保持一致，避免诱导调用不可见工具。
    match imagegen_domain_scope_allowed(project_id).await {
        Ok(true) => {}
        Ok(false) => return String::new(),
        Err(_) => return String::new(),
    }
    // 与 collect 阶段一致：无可用渠道时工具不暴露，指引也不注入。
    // load_imagegen_settings 是同步 DB 读取，放 spawn_blocking 避免阻塞
    // 异步运行时线程。
    let settings = match tokio::task::spawn_blocking(load_imagegen_settings).await {
        Ok(Ok(settings)) => settings,
        _ => return String::new(),
    };
    if !settings.has_enabled_channel() {
        return String::new();
    }

    let mut lines: Vec<String> = Vec::new();
    lines.push("## Image Generation".to_string());
    lines.push(String::new());
    lines.push(format!(
        "Image generation is configured ({}).",
        available_channels_summary(&settings)
    ));
    lines.push(String::new());
    lines.push("Rules (MUST follow):".to_string());
    lines.push(
        "- ONE `imagegen-generate` call produces ONE image. To generate several images, call the tool MULTIPLE TIMES in parallel — one call per image with its own single `prompt` (and its own `images` group when editing). Do NOT pass multiple prompts, a batch of styles, or `n` > 1 in a single call: those legacy parameters are NOT the multi-image path."
            .to_string(),
    );
    lines.push(
        "- Consecutive parallel `imagegen-generate` calls (≥2) are automatically merged by the chat UI into a single `ImageGenGallery` grid — parallel calls are the only multi-image path, so prefer them over sequential single-image calls."
            .to_string(),
    );
    lines.push(
        "- After the tool returns, generated images are shown automatically in the dedicated image UI: do NOT use Markdown image syntax (`![...](path)`) and do NOT echo file paths back to the user; reply with a short natural text instead."
            .to_string(),
    );
    lines.push(
        "- Execution mode: you may pass `mode=\"sync\"` | `\"async\"` | `\"auto\"` (default: auto). Pass `mode=\"sync\"` when the image file is an immediate dependency for your next step (e.g. image-describe or writing code referencing it). For wallpapers, illustrations, batch generations (>=2 images), or when the user asks for background generation, pass `mode=\"async\"` and conclude your turn informing the user that generation is underway; the system will awaken and notify you upon completion."
            .to_string(),
    );
    lines.join("\n")
}
