import type {
  ImageGenChannelValue,
  ImageGenSettingsValue,
  ImageGenTemplate,
} from "./types";

/** system_settings 表中生图设置的 code（与 Rust native 侧一致）。 */
export const IMAGE_GEN_SETTING_CODE = "imagegen_settings";

/** system_settings 表中生图设置的展示名。 */
export const IMAGE_GEN_SETTING_NAME = "Image Generation Settings";

/** 单个渠道默认值：全部留空（无内置默认模型），由用户在前端配置。 */
export const DEFAULT_IMAGE_GEN_CHANNEL: ImageGenChannelValue = {
  id: "",
  name: "",
  provider: "openai",
  enabled: false,
  baseUrl: "",
  apiKey: "",
  model: "",
  defaultSize: "",
  defaultQuality: "",
  outputFormat: "",
  webSearch: false,
  defaultStream: false,
  supportedRatios: "",
  supportedResolutions: "",
  supportedThinking: "",
  customPrompt: "",
};

/** 最大并发生成数默认值（旧数据缺失该字段时回退）。 */
export const DEFAULT_IMAGE_GEN_MAX_CONCURRENT = 4;

/** 最大并发生成数允许范围（下限 1 保证串行兜底；上限 8 兼顾服务商
 *  限流与内存占用——每张图的 base64 结果体积很大）。 */
export const IMAGE_GEN_MAX_CONCURRENT_RANGE: { min: number; max: number } = {
  min: 1,
  max: 8,
};

/** 生图请求超时默认值（秒）：图片模型复杂提示词 / 高分辨率生成可能
 *  耗时数分钟，默认 5 分钟；旧数据缺失该字段时回退。 */
export const DEFAULT_IMAGE_GEN_TIMEOUT_SECS = 300;

/** 生图请求超时允许范围（秒）：下限 60 秒避免误配置把请求立刻掐断，
 *  上限 3600 秒（1 小时）避免请求无限挂起。 */
export const IMAGE_GEN_TIMEOUT_RANGE: { min: number; max: number } = {
  min: 60,
  max: 3600,
};

/** 生图执行模式默认值：auto（Agent 根据上下文自主判定）。 */
export const DEFAULT_IMAGE_GEN_EXECUTION_MODE = "auto" as const;

/** 生图设置默认值：无渠道（未配置时不暴露生图工具）。 */
export const DEFAULT_IMAGE_GEN_SETTINGS: ImageGenSettingsValue = {
  channels: [],
  maxConcurrentImages: DEFAULT_IMAGE_GEN_MAX_CONCURRENT,
  timeoutSecs: DEFAULT_IMAGE_GEN_TIMEOUT_SECS,
  executionMode: DEFAULT_IMAGE_GEN_EXECUTION_MODE,
};

/** OpenAI 兼容端点官方默认地址（baseUrl 留空时使用）。 */
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

/** Gemini 官方默认地址（baseUrl 留空时使用）。 */
export const DEFAULT_GEMINI_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta";

/** NovelAI 原生图片 API 默认地址（主机根地址，无 /v1；请求按
 *  `{baseUrl}/ai/generate-image` 拼接，认证用 Bearer Persistent Token）。 */
export const DEFAULT_NOVELAI_BASE_URL = "https://image.novelai.net";

/** 常见生图模型提示（placeholder 用，含别名与预览版）。 */
export const OPENAI_MODEL_EXAMPLES =
  "gpt-image-2.5-flare, qwen-image-2.1, niji-6, flux-1.1-pro, grok-imagine-image-2.0, dall-e-3, ...";
export const GEMINI_MODEL_EXAMPLES =
  "gemini-nano-banana-2.1 (Nano Banana 2.1 最新), gemini-3.1-flash-image, gemini-3-pro-image, gemini-2.5-flash-image, ...";
/** xAI Grok Imagine 模型示例（OpenAI 兼容协议，baseUrl = https://api.x.ai/v1）。 */
export const GROK_MODEL_EXAMPLES =
  "grok-imagine-image-quality, grok-imagine-image-2.0, ...";
/** NovelAI 原生图片模型示例（provider = novelai，baseUrl 默认 image.novelai.net，
 *  认证用持久化令牌）。 */
export const NOVELAI_MODEL_EXAMPLES =
  "nai-diffusion-5-full, nai-diffusion-5-curated, nai-diffusion-4-5-full, nai-diffusion-4-5-curated, nai-diffusion-4-full, nai-diffusion-3, ...";

/**
 * Gemini 思考强度预设选项（支持 gemini-3.1 / 3 系列）。
 * Nano Banana 2.1（gemini-nano-banana-2.1）新增 medium 档并设为官方默认
 * （Google 官方文档 2026-10），因此这里必须收录 medium。
 */
export const GEMINI_THINKING_LEVEL_OPTIONS = [
  "",
  "minimal",
  "medium",
  "high",
] as const;

/**
 * 开箱即用的生图渠道预置模板，支持在新建/编辑渠道时一键填充。
 */
export const IMAGE_GEN_TEMPLATES: ImageGenTemplate[] = [
  {
    id: "template-gemini-banana21",
    name: "Google - Gemini Nano Banana 2.1 (最新香蕉)",
    provider: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    model: "gemini-nano-banana-2.1",
    defaultSize: "16:9@2K",
    supportedRatios:
      "1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 5:4, 4:5, 21:9, 1:4, 1:8, 4:1, 8:1",
    supportedResolutions: "1K, 2K, 4K (支持 16:9@2K 组合语法；不支持 512px)",
    supportedThinking: "minimal, medium, high",
    customPrompt:
      "Google 最新 Nano Banana 2.1 图像生成与编辑旗舰（API 模型 ID: gemini-nano-banana-2.1）。成本大幅降低，支持 14 种宽高比及 1K/2K/4K 分辨率（不支持 512px；尺寸支持 16:9@2K）；支持 thinkingLevel (minimal/medium/high 思考强度，官方默认 medium)；支持联网搜索与以图搜图（webSearch/imageSearch）；图生图最多支持 14 张参考图。",
    webSearch: true,
    defaultStream: true,
    description:
      "Google 2026 最新 Nano Banana 2.1 官方旗舰（API ID: gemini-nano-banana-2.1），成本减半、支持4K与双通道搜索",
  },
  {
    id: "template-openai-flare",
    name: "OpenAI - GPT Image 2.5 Flare",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-image-2.5-flare",
    defaultSize: "1792x1008",
    defaultQuality: "high",
    // gpt-image-2 系尺寸/比例空间开放（任意 16 倍数、两边 ≤3840px、比例 1:3~3:1）
    // → supported_* 留空 = 未声明 = 放行；声明不完整会被 Rust 精确白名单误拦。
    supportedRatios: "",
    supportedResolutions: "",
    supportedThinking: "",
    supportedQualities: "low, medium, high, xhigh, max",
    customPrompt:
      "OpenAI 高性价比生图模型。支持 1K/2K/4K 比例尺寸（最大 3840px，16倍数，比例 1:3~3:1，可传任意 WIDTHxHEIGHT）；画质支持 low/medium/high/xhigh/max；支持参考图多模态图生图。",
    outputFormat: "png",
    defaultStream: true,
    description: "日常高画质与快速响应推荐，支持 1K/2K/4K 比例",
  },
  {
    id: "template-openai-sunburst",
    name: "OpenAI - GPT Image 2.5 Sunburst",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-image-2.5-sunburst",
    defaultSize: "2560x1440",
    defaultQuality: "xhigh",
    supportedRatios: "",
    supportedResolutions: "",
    supportedThinking: "",
    supportedQualities: "low, medium, high, xhigh, max",
    customPrompt:
      "OpenAI 旗舰画质生图模型。具备复杂指令遵循与高保真编辑能力；画质支持 xhigh 与 max 顶级档位；支持 1K/2K/4K 各比例尺寸（最大 3840px，比例 1:3~3:1）。",
    outputFormat: "png",
    defaultStream: true,
    description: "旗舰级生图，画质极致，支持 xhigh / max",
  },
  {
    id: "template-openai-gpt2",
    name: "OpenAI - GPT Image 2",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-image-2",
    defaultSize: "1792x1008",
    defaultQuality: "high",
    supportedRatios: "",
    supportedResolutions: "",
    supportedThinking: "",
    supportedQualities: "low, medium, high",
    customPrompt:
      "经典 GPT 多模态生图模型。支持 1K/2K/4K 各比例尺寸（最大 3840px，16 倍数，比例 1:3~3:1）；支持参考图多模态图生图；注意 transparent 背景仅 gpt-image-1 支持。",
    outputFormat: "png",
    defaultStream: true,
    description: "经典 GPT 多模态图生图与文生图模型",
  },
  {
    id: "template-openai-dalle3",
    name: "OpenAI - DALL-E 3",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    model: "dall-e-3",
    defaultSize: "1024x1024",
    defaultQuality: "standard",
    supportedRatios: "1:1, 16:9, 9:16",
    supportedResolutions: "1024x1024, 1792x1024, 1024x1792",
    supportedThinking: "",
    supportedQualities: "standard, hd",
    customPrompt:
      "经典文本生图模型（纯文生图，不支持参考图输入）。固定支持 1024x1024 (1:1)、1792x1024 (16:9 横屏)、1024x1792 (9:16 竖屏)；质量仅 standard 与 hd。",
    outputFormat: "png",
    defaultStream: false,
    description: "经典纯文本生图模型（固定 1024x1024 / 1792x1024）",
  },
  {
    id: "template-gemini-flash3",
    name: "Google - Gemini 3.1 Flash Image",
    provider: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    model: "gemini-3.1-flash-image",
    defaultSize: "16:9@2K",
    supportedRatios:
      "1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 5:4, 4:5, 21:9, 1:4, 1:8, 4:1, 8:1",
    supportedResolutions: "512px, 1K, 2K, 4K (支持 16:9@2K 组合语法)",
    supportedThinking: "minimal, high",
    customPrompt:
      "Google 最新 Nano Banana 2 多模态生图旗舰。支持 14 种宽高比及 512px~4K 分辨率（尺寸参数支持 16:9@2K）；支持 thinkingLevel (minimal/high 思考强度)；支持联网搜索与以图搜图（webSearch/imageSearch）；图生图最多支持 14 张参考图。",
    webSearch: true,
    defaultStream: true,
    description: "最新 Nano Banana 2 多模态生图旗舰，支持14种比例、联网与思考",
  },
  {
    id: "template-gemini-pro3",
    name: "Google - Gemini 3 Pro Image",
    provider: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    model: "gemini-3-pro-image",
    defaultSize: "16:9@2K",
    supportedRatios: "1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 5:4, 4:5, 21:9",
    supportedResolutions: "1K, 2K, 4K (支持 16:9@2K 组合语法)",
    supportedThinking: "minimal, high",
    customPrompt:
      "Nano Banana Pro 专业画质生图模型。支持 10 种比例与 1K/2K/4K 档位；支持 thinkingLevel (minimal/high 深度思考)；图生图最多 14 张参考图。",
    webSearch: true,
    defaultStream: true,
    description: "Nano Banana Pro 专业画质生图，支持 14 张参考图与深度思考",
  },
  {
    id: "template-gemini-flash25",
    name: "Google - Gemini 2.5 Flash Image",
    provider: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    model: "gemini-2.5-flash-image",
    defaultSize: "16:9",
    supportedRatios: "1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 5:4, 4:5, 21:9",
    supportedResolutions: "1K",
    supportedThinking: "minimal, high",
    customPrompt:
      "轻量快速生图模型（Nano Banana 1）。支持 10 种比例，标准 1K 分辨率，图生图最多支持 3 张参考图；支持 thinkingLevel 思考强度。",
    webSearch: false,
    defaultStream: true,
    description: "经典轻量级 Nano Banana 生图模型",
  },
  {
    id: "template-xai-grok",
    name: "xAI - Grok Imagine 2.0",
    provider: "openai",
    baseUrl: "https://api.x.ai/v1",
    model: "grok-imagine-image-2.0",
    defaultSize: "16:9@2k",
    defaultQuality: "medium",
    // ⚠️ xAI 官方比例清单无法完全核实（第三方文档口径 13~14 种不一致），
    // 而 supported_* 一经声明即被 Rust 侧当作精确白名单**拦截**越界值 →
    // 声明不完整会误拦合法比例，故留空（未声明 = 放行）。
    // 比例选项在 Grok 专用控件里走 GROK_ASPECT_RATIOS 常量，不依赖此字段。
    supportedRatios: "",
    supportedResolutions: "1k, 2k",
    supportedThinking: "",
    supportedQualities: "low, medium",
    customPrompt:
      "xAI 官方 Grok 生图模型（OpenAI 兼容端点）。尺寸采用 aspect_ratio 宽高比 + resolution 分辨率（1k/2k）；质量支持 low 与 medium。",
    outputFormat: "",
    defaultStream: false,
    description: "xAI 官方 Grok 生图模型（OpenAI 兼容端点）",
  },
  {
    id: "template-qwen-image-21",
    name: "Qwen - Qwen Image 2.1 (通义千问)",
    provider: "openai",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-image-2.1",
    defaultSize: "1024x1024",
    defaultQuality: "",
    supportedRatios: "1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 21:9",
    supportedResolutions:
      "1024x1024 (1:1), 1280x720 / 1920x1080 (16:9), 720x1280 / 1080x1920 (9:16), 1280x960 (4:3), 960x1280 (3:4), 2048x2048 (原生2K)",
    supportedThinking: "",
    customPrompt:
      "阿里云通义千问 7B 视觉生成模型。支持 1:1, 16:9, 9:16, 4:3 等多种构图比例；支持最高 2K 原生分辨率与中英文复杂双语提示词；支持原生透明度与图生图编辑。",
    outputFormat: "png",
    defaultStream: false,
    description:
      "通义千问开源 7B 生图旗舰，原生 2K 与双语文本理解（百炼 OpenAI 兼容端点）",
  },
  {
    id: "template-wanx-21-plus",
    name: "Qwen - Wanx 2.1 Plus (通义万相)",
    provider: "openai",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "wanx2.1-t2i-plus",
    defaultSize: "1024x1024",
    defaultQuality: "",
    supportedRatios: "1:1, 16:9, 9:16, 4:3, 3:4",
    supportedResolutions: "1024x1024, 1280x720, 720x1280, 1280x960, 960x1280",
    supportedThinking: "",
    customPrompt:
      "阿里巴巴通义万相 2.1 Plus 模型。画面艺术感与光影质感全面升级，支持 1:1, 16:9, 9:16 等主流构图，擅长中式国风与写实艺术渲染。",
    outputFormat: "png",
    defaultStream: false,
    description: "通义万相 2.1 顶级艺术与摄影渲染模型，光影与中式国风极强",
  },
  {
    id: "template-anime-niji6",
    name: "Anime - Midjourney Niji 6 (二次元动漫)",
    provider: "openai",
    model: "niji-6",
    defaultSize: "1024x1536",
    defaultQuality: "",
    supportedRatios: "1:1, 2:3, 3:2, 9:16, 16:9, 4:3, 3:4, 21:9",
    supportedResolutions:
      "1024x1024 (1:1), 1024x1536 (2:3 立绘), 1536x1024 (3:2 插画), 1080x1920 (9:16 壁纸), 1920x1080 (16:9 壁纸)",
    supportedThinking: "",
    customPrompt:
      "二次元动漫与日系插画顶尖模型（适用于 Midjourney Niji 6 兼容中转）。构图极具张力，色彩细腻，擅长角色立绘、动漫壁纸与轻小说插图；提示词支持中英双语与自然语言描述。",
    outputFormat: "png",
    defaultStream: false,
    description:
      "二次元动漫与日系插画天花板，卓越的色彩与动态张力（适用于 Midjourney Niji 兼容中转）",
  },
  {
    id: "template-anime-novelai",
    name: "Anime - NovelAI Diffusion (二次元立绘)",
    provider: "openai",
    model: "nai-diffusion-4-full",
    defaultSize: "832x1216",
    defaultQuality: "",
    supportedRatios: "2:3, 3:2, 1:1, 9:16, 16:9",
    supportedResolutions:
      "832x1216 (标准立绘), 1216x832 (横向插画), 1024x1024 (方形头像), 1024x1536 (高清立绘)",
    supportedThinking: "",
    customPrompt:
      "专精二次元动漫 Danbooru Tag 标签的模型（适用于聚合中转）。推荐使用半角逗号分隔英文标签（如 masterpiece, 1girl, anime, looking at viewer...），对角色服装、发色发型、姿势与镜头控制精准。",
    outputFormat: "png",
    defaultStream: false,
    description:
      "专精二次元 Danbooru 标签与日系美少女角色立绘生成（适用于兼容中转）",
  },
  {
    id: "template-novelai-native",
    name: "NovelAI - NAI Diffusion V4.5 Full (原生协议)",
    provider: "novelai",
    baseUrl: "https://image.novelai.net",
    model: "nai-diffusion-4-5-full",
    defaultSize: "832x1216",
    defaultQuality: "",
    supportedRatios: "2:3, 3:2, 1:1, 9:16, 16:9, 4:3, 3:4, 21:9",
    supportedResolutions:
      "832x1216 (标准立绘), 1216x832 (横向插画), 1024x1024 (方形头像), 1024x1536 (高清立绘), 1536x1024 (高清横图)",
    supportedThinking: "",
    customPrompt:
      "NovelAI 原生图片 API（image.novelai.net/ai/generate-image，认证用 NovelAI 持久化令牌）。专精二次元动漫 Danbooru Tag 标签；推荐半角逗号分隔英文标签（如 masterpiece, best quality, 1girl, anime, looking at viewer...），对角色服装、发色、姿势与镜头控制精准。支持 generate 文生图、img2img 图生图（单张底图）与 infill 局部重绘（mask）；输出恒为 PNG；不支持 outputFormat/质量/流式。",
    outputFormat: "png",
    defaultStream: false,
    description:
      "NovelAI 官方原生 API（nai-diffusion-4-5-full），Danbooru 标签二次元立绘",
  },
  {
    id: "template-anime-animagine",
    name: "Anime - Animagine XL 3.1 (SDXL 动漫)",
    provider: "openai",
    model: "animagine-xl-3.1",
    defaultSize: "832x1216",
    defaultQuality: "",
    supportedRatios: "2:3, 3:2, 3:4, 4:3, 1:1, 9:16, 16:9",
    supportedResolutions:
      "832x1216 (9:16/立绘), 1216x832 (16:9/横屏), 896x1152 (3:4), 1152x896 (4:3), 1024x1024 (1:1)",
    supportedThinking: "",
    customPrompt:
      "基于 SDXL 的开源动漫生图旗舰模型（适用于 SiliconFlow 硅基流动 / Fal.ai / Replicate 等兼容端点）。支持质量标签（masterpiece, best quality, very aesthetic）与二次元角色标签。",
    outputFormat: "png",
    defaultStream: false,
    description: "开源 SDXL 二次元标杆模型，支持硅基流动/Fal.ai等兼容端点",
  },
  {
    id: "template-flux-11-pro",
    name: "FLUX - FLUX.1.1 Pro (超写实摄影)",
    provider: "openai",
    model: "flux-1.1-pro",
    defaultSize: "1536x1024",
    defaultQuality: "",
    supportedRatios: "1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 21:9",
    supportedResolutions:
      "1024x1024, 1536x1024 (3:2), 1024x1536 (2:3), 1792x1008 (16:9), 2048x2048 (4MP 超清)",
    supportedThinking: "",
    customPrompt:
      "Black Forest Labs 顶级生图旗舰（适用于 Together.ai / 硅基流动 / Fal.ai 等 OpenAI 兼容端点）。具备顶级自然语言遵循能力与逼真摄影质感，原生渲染复杂文字和排版。",
    outputFormat: "png",
    defaultStream: false,
    description:
      "BFL 顶级生图旗舰，超高自然语言理解与极致摄影真实感（适用于各大兼容中转）",
  },
  {
    id: "template-zhipu-cogview",
    name: "Zhipu - CogView-3-Plus (智谱清言)",
    provider: "openai",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "cogview-3-plus",
    defaultSize: "1024x1024",
    defaultQuality: "",
    supportedRatios: "1:1, 16:9, 9:16, 4:3, 3:4, 21:9",
    supportedResolutions:
      "1024x1024, 768x1344 (9:16), 1344x768 (16:9), 864x1152 (3:4), 1152x864 (4:3), 1440x720 (2:1)",
    supportedThinking: "",
    customPrompt:
      "智谱 AI 文本生图模型（支持官方与兼容端点）。中文自然语言理解极强，支持横竖屏主流比例。",
    outputFormat: "png",
    defaultStream: false,
    description: "智谱 AI 国产高质量图文生成模型，中文语境与成语古诗理解极佳",
  },
];

/** xAI Grok Imagine 支持的全部宽高比（官方文档；auto = 模型自选，作默认）。 */
export const GROK_ASPECT_RATIOS = [
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "3:2",
  "2:3",
  "2:1",
  "1:2",
  "19.5:9",
  "9:19.5",
  "20:9",
  "9:20",
];

/** xAI Grok Imagine 支持的分辨率（官方文档：1k / 2k；空 = 渠道默认）。 */
export const GROK_SIZE_PRESETS = ["", "1k", "2k"] as const;

/**
 * 解析 Grok 的 defaultSize（与 Gemini 同款 "比例@分辨率" 格式）：
 * - "16:9" → { ratio: "16:9", resolution: "" }
 * - "2k" → { ratio: "", resolution: "2k" }
 * - "16:9@2k" → { ratio: "16:9", resolution: "2k" }
 * - 其他（自定义/空）→ 均为 ""
 */
export const matchGrokSizePreset = (
  size: string,
): { ratio: string; resolution: string } => {
  const trimmed = size.trim();
  const [ratioPart, sizePart] = trimmed.includes("@")
    ? trimmed.split("@")
    : [trimmed, ""];
  const ratio = GROK_ASPECT_RATIOS.includes(ratioPart.trim())
    ? ratioPart.trim()
    : "";
  let resolution = (GROK_SIZE_PRESETS as readonly string[]).includes(
    sizePart.trim(),
  )
    ? sizePart.trim()
    : "";
  // 无 @ 的纯分辨率写法（如 "2k"）：整串直接匹配档位（文档注释承诺的行为，
  // 此前实现会把整串误当比例解析，导致 resolution 永远为空）。
  if (
    !ratio &&
    !resolution &&
    trimmed !== "" &&
    (GROK_SIZE_PRESETS as readonly string[]).includes(trimmed)
  ) {
    resolution = trimmed;
  }
  return { ratio, resolution };
};

/** 组合 Grok 的宽高比与分辨率为存储值（"16:9@2k"）。 */
export const buildGrokSize = (ratio: string, resolution: string): string => {
  const ratioPart = ratio.trim();
  const sizePart = resolution.trim();
  if (ratioPart && sizePart) {
    return `${ratioPart}@${sizePart}`;
  }
  return ratioPart || sizePart;
};

/**
 * OpenAI gpt-image 推荐分辨率（12API 文档）：
 * 比例 → 档位(1K/2K/4K) → 具体分辨率。所有值均为 16px 倍数且满足
 * 最大边长 ≤ 3840px、长短边比 ≤ 3:1、总像素 655,360 ~ 8,294,400。
 */
export const OPENAI_SIZE_PRESETS: Record<
  string,
  Record<"1K" | "2K" | "4K", string>
> = {
  "1:1": { "1K": "1248x1248", "2K": "2048x2048", "4K": "2880x2880" },
  "5:4": { "1K": "1440x1152", "2K": "2240x1792", "4K": "3200x2560" },
  "4:3": { "1K": "1472x1104", "2K": "2304x1728", "4K": "3264x2448" },
  "3:2": { "1K": "1536x1024", "2K": "2496x1664", "4K": "3504x2336" },
  "16:9": { "1K": "1792x1008", "2K": "2560x1440", "4K": "3840x2160" },
  "2:1": { "1K": "1792x896", "2K": "2880x1440", "4K": "3840x1920" },
  "21:9": { "1K": "1904x816", "2K": "3024x1296", "4K": "3696x1584" },
  "4:5": { "1K": "1152x1440", "2K": "1792x2240", "4K": "2560x3200" },
  "3:4": { "1K": "1104x1472", "2K": "1728x2304", "4K": "2448x3264" },
  "2:3": { "1K": "1024x1536", "2K": "1664x2496", "4K": "2336x3504" },
  "1:2": { "1K": "896x1792", "2K": "1440x2880", "4K": "1920x3840" },
  "9:16": { "1K": "1008x1792", "2K": "1440x2560", "4K": "2160x3840" },
};

/** OpenAI size 档位（与 OPENAI_SIZE_PRESETS 的键一致）。 */
export const OPENAI_SIZE_TIERS = ["1K", "2K", "4K"] as const;

/** Gemini 常用宽高比快捷选项（3 Pro / 3.1 Flash Lite / 2.5 Flash Image 官方支持集）。 */
export const GEMINI_ASPECT_RATIOS = [
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
];

/** Gemini 3.1 Flash Image 独有超宽比例（官方文档）。 */
export const GEMINI_ASPECT_RATIOS_FLASH3_EXTRA = ["1:4", "1:8", "4:1", "8:1"];

/**
 * 按模型返回 Gemini 支持的宽高比列表（官方文档 2026-10）：
 * - gemini-nano-banana-2.1 / gemini-3.1-flash-image：14 种（含 1:4 / 1:8 / 4:1 / 8:1 超宽）
 * - 其他（3 Pro / 3.1 Flash Lite / 2.5 Flash Image）：10 种
 */
export const getGeminiAspectRatios = (model: string): string[] => {
  const id = model.toLowerCase();
  const ultraWide =
    id.includes("gemini-nano-banana-2.1") ||
    (id.includes("gemini-3.1-flash-image") && !id.includes("flash-lite"));
  if (ultraWide) {
    return [...GEMINI_ASPECT_RATIOS, ...GEMINI_ASPECT_RATIOS_FLASH3_EXTRA];
  }
  return [...GEMINI_ASPECT_RATIOS];
};

/**
 * Gemini imageSize 可选值（12API 文档）：
 * 注意区分大小写，必须写 1K/2K/4K；512px 仅部分模型支持。
 */
export const GEMINI_SIZE_PRESETS = ["512px", "1K", "2K", "4K"] as const;

/**
 * Gemini 官方分辨率表（Google 官方文档 2026-07：Nano Banana 系列
 * aspect_ratio × image_size → 实际输出分辨率，仅展示用）。
 * 键顺序与 GEMINI_ASPECT_RATIOS 一致。
 */
export const GEMINI_SIZE_TABLE: Record<
  string,
  Record<"512px" | "1K" | "2K" | "4K", string>
> = {
  "1:1": {
    "512px": "512x512",
    "1K": "1024x1024",
    "2K": "2048x2048",
    "4K": "4096x4096",
  },
  "1:4": {
    "512px": "256x1024",
    "1K": "512x2048",
    "2K": "1024x4096",
    "4K": "2048x8192",
  },
  "1:8": {
    "512px": "192x1536",
    "1K": "384x3072",
    "2K": "768x6144",
    "4K": "1536x12288",
  },
  "2:3": {
    "512px": "424x632",
    "1K": "848x1264",
    "2K": "1696x2528",
    "4K": "3392x5056",
  },
  "3:2": {
    "512px": "632x424",
    "1K": "1264x848",
    "2K": "2528x1696",
    "4K": "5056x3392",
  },
  "3:4": {
    "512px": "448x600",
    "1K": "896x1200",
    "2K": "1792x2400",
    "4K": "3584x4800",
  },
  "4:1": {
    "512px": "1024x256",
    "1K": "2048x512",
    "2K": "4096x1024",
    "4K": "8192x2048",
  },
  "4:3": {
    "512px": "600x448",
    "1K": "1200x896",
    "2K": "2400x1792",
    "4K": "4800x3584",
  },
  "4:5": {
    "512px": "464x576",
    "1K": "928x1152",
    "2K": "1856x2304",
    "4K": "3712x4608",
  },
  "5:4": {
    "512px": "576x464",
    "1K": "1152x928",
    "2K": "2304x1856",
    "4K": "4608x3712",
  },
  "8:1": {
    "512px": "1536x192",
    "1K": "3072x384",
    "2K": "6144x768",
    "4K": "12288x1536",
  },
  "9:16": {
    "512px": "384x688",
    "1K": "768x1376",
    "2K": "1536x2752",
    "4K": "3072x5504",
  },
  "16:9": {
    "512px": "688x384",
    "1K": "1376x768",
    "2K": "2752x1536",
    "4K": "5504x3072",
  },
  "21:9": {
    "512px": "792x168",
    "1K": "1584x672",
    "2K": "3168x1344",
    "4K": "6336x2688",
  },
};

/** Gemini 3 Pro Image 官方分辨率（无 512px 档）。 */
const GEMINI_3_PRO_SIZE_TABLE: Record<
  string,
  Partial<Record<"512px" | "1K" | "2K" | "4K", string>>
> = {
  "1:1": { "1K": "1024x1024", "2K": "2048x2048", "4K": "4096x4096" },
  "2:3": { "1K": "848x1264", "2K": "1696x2528", "4K": "3392x5056" },
  "3:2": { "1K": "1264x848", "2K": "2528x1696", "4K": "5056x3392" },
  "3:4": { "1K": "896x1200", "2K": "1792x2400", "4K": "3584x4800" },
  "4:3": { "1K": "1200x896", "2K": "2400x1792", "4K": "4800x3584" },
  "4:5": { "1K": "928x1152", "2K": "1856x2304", "4K": "3712x4608" },
  "5:4": { "1K": "1152x928", "2K": "2304x1856", "4K": "4608x3712" },
  "9:16": { "1K": "768x1376", "2K": "1536x2752", "4K": "3072x5504" },
  "16:9": { "1K": "1376x768", "2K": "2752x1536", "4K": "5504x3072" },
  "21:9": { "1K": "1584x672", "2K": "3168x1344", "4K": "6336x2688" },
};

/** Gemini 2.5 Flash Image 官方分辨率（固定 1024 级，仅 1K）。 */
const GEMINI_2_5_SIZE_TABLE: Record<string, string> = {
  "1:1": "1024x1024",
  "2:3": "832x1248",
  "3:2": "1248x832",
  "3:4": "864x1184",
  "4:3": "1184x864",
  "4:5": "896x1152",
  "5:4": "1152x896",
  "9:16": "768x1344",
  "16:9": "1344x768",
  "21:9": "1536x672",
};

/**
 * 查询 Gemini 某模型「比例 × 档位」对应的实际分辨率（仅展示用）。
 * - 3.1 Flash Image：完整 14 比例 × 4 档（官方表）
 * - 3 Pro Image：10 比例 × 3 档（无 512px）
 * - 2.5 Flash Image：10 比例固定 1024 级（档位视为 1K）
 * - 3.1 Flash Lite：官方未公布分辨率表（仅 1K）→ 返回 ""（不展示副文本）
 * - 未识别模型：回退官方全量表，查不到返回 ""
 */
export const getGeminiResolution = (
  model: string,
  ratio: string,
  imageSize: string,
): string => {
  const id = model.toLowerCase();
  if (id.includes("gemini-2.5-flash-image") || id.startsWith("imagen")) {
    return GEMINI_2_5_SIZE_TABLE[ratio] ?? "";
  }
  if (id.includes("gemini-3.1-flash-lite-image")) {
    return ""; // 官方未公布 Lite 分辨率表，不臆造
  }
  if (id.includes("gemini-3-pro-image")) {
    return (
      GEMINI_3_PRO_SIZE_TABLE[ratio]?.[imageSize as "1K" | "2K" | "4K"] ?? ""
    );
  }
  return (
    GEMINI_SIZE_TABLE[ratio]?.[imageSize as "512px" | "1K" | "2K" | "4K"] ?? ""
  );
};

/**
 * 解析 Gemini 的 defaultSize：
 * - "16:9" → { ratio: "16:9", imageSize: "" }
 * - "2K" → { ratio: "", imageSize: "2K" }
 * - "16:9@2K" → { ratio: "16:9", imageSize: "2K" }
 * - 其他（自定义/空）→ 均为 ""
 */
export const matchGeminiSizePreset = (
  size: string,
): { ratio: string; imageSize: string } => {
  const trimmed = size.trim();
  const [ratioPart, sizePart] = trimmed.includes("@")
    ? trimmed.split("@")
    : [trimmed, ""];
  // 比例匹配使用全量候选（常规 10 种 + gemini-3.1-flash-image 超宽 4 种），
  // 否则渠道默认尺寸配 "4:1@2K" 等超宽比例时解析失败、面板无法回填。
  const ratio = [
    ...GEMINI_ASPECT_RATIOS,
    ...GEMINI_ASPECT_RATIOS_FLASH3_EXTRA,
  ].includes(ratioPart.trim())
    ? ratioPart.trim()
    : "";
  let imageSize = (GEMINI_SIZE_PRESETS as readonly string[]).includes(
    sizePart.trim(),
  )
    ? sizePart.trim()
    : "";
  // 无 @ 的纯档位写法（如 "2K"）：整串直接匹配档位（文档注释承诺的行为，
  // 此前实现会把整串误当比例解析，导致 imageSize 永远为空）。
  if (
    !ratio &&
    !imageSize &&
    trimmed !== "" &&
    (GEMINI_SIZE_PRESETS as readonly string[]).includes(trimmed)
  ) {
    imageSize = trimmed;
  }
  return { ratio, imageSize };
};

/** 组合 Gemini 的宽高比与图片尺寸为存储值（"16:9@2K"）。 */
export const buildGeminiSize = (ratio: string, imageSize: string): string => {
  const ratioPart = ratio.trim();
  const sizePart = imageSize.trim();
  if (ratioPart && sizePart) {
    return `${ratioPart}@${sizePart}`;
  }
  return ratioPart || sizePart;
};

/**
 * 按模型返回 Gemini 支持的 imageSize 列表（12API 文档「尺寸与参考图限制」）：
 * - gemini-3.1-flash-image（Nano Banana 2）：512px、1K、2K、4K，最多 14 张参考图
 * - gemini-3-pro-image（Nano Banana Pro）：1K、2K、4K，最多 14 张参考图
 * - gemini-3.1-flash-lite-image（Lite）：仅 1K
 * - gemini-2.5-flash-image（旧版）：约 1K，最多 3 张参考图
 * - 未识别模型：默认返回全部选项
 */
export const getGeminiSizePresets = (model: string): string[] => {
  const id = model.toLowerCase();
  if (id.includes("gemini-2.5-flash-image") || id.startsWith("imagen")) {
    return ["1K"];
  }
  if (id.includes("gemini-3.1-flash-lite-image")) {
    return ["1K"];
  }
  if (id.includes("gemini-3-pro-image")) {
    return ["1K", "2K", "4K"];
  }
  if (id.includes("gemini-3.1-flash-image")) {
    return ["512px", "1K", "2K", "4K"];
  }
  return [...GEMINI_SIZE_PRESETS];
};

/**
 * 在预设表中查找某个尺寸字符串对应的（比例, 档位）。
 * 匹配不到（自定义值）返回 null；"auto" 也返回 null。
 */
export const matchOpenAISizePreset = (
  size: string,
): { ratio: string; tier: "1K" | "2K" | "4K" } | null => {
  const trimmed = size.trim().toLowerCase();
  if (trimmed === "auto" || trimmed === "") {
    return null;
  }
  for (const [ratio, tiers] of Object.entries(OPENAI_SIZE_PRESETS)) {
    for (const tier of OPENAI_SIZE_TIERS) {
      if (tiers[tier].toLowerCase() === trimmed) {
        return { ratio, tier };
      }
    }
  }
  return null;
};
