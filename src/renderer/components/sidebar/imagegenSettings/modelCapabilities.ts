import {
  GEMINI_THINKING_LEVEL_OPTIONS,
  IMAGE_GEN_TEMPLATES,
} from "./constants";
import type { ImageGenProvider } from "./types";

/**
 * 单个生图模型的能力描述（默认参数 + 支持范围），用于在用户选择/输入
 * 模型 ID 后自动带出「默认尺寸 / 默认质量 / 默认思考强度 / 支持宽高比 /
 * 支持分辨率 / 支持思考强度」等字段。
 *
 * 数据来源：
 * 1. 由 IMAGE_GEN_TEMPLATES 派生（模板本身就是权威的官方能力快照，避免
 *    能力库与模板两份数据不同步）；
 * 2. EXTRA_MODEL_CAPABILITIES 补充模板未覆盖的主流模型。
 */
export type ImageGenModelCapability = {
  /** 匹配片段（小写）：模型 ID 包含该片段即命中，取最长命中项。 */
  match: string;
  /** 能力来源展示名（用于提示「已套用 xx 能力」）。 */
  label: string;
  /** 协议归属（决定联网搜索等协议级能力）。 */
  provider: ImageGenProvider;
  defaultSize: string;
  defaultQuality: string;
  supportedRatios: string;
  supportedResolutions: string;
  supportedThinking: string;
  supportedQualities?: string;
  /** 是否支持联网搜索（仅 Gemini 原生协议的 google_search grounding 生效）。 */
  webSearch: boolean;
};

/** 由预设模板派生的能力表（模板即官方能力快照）。 */
const TEMPLATE_CAPABILITIES: ImageGenModelCapability[] =
  IMAGE_GEN_TEMPLATES.map((template) => ({
    match: template.model.toLowerCase(),
    label: template.name,
    provider: template.provider,
    defaultSize: template.defaultSize ?? "",
    defaultQuality: template.defaultQuality ?? "",
    supportedRatios: template.supportedRatios ?? "",
    supportedResolutions: template.supportedResolutions ?? "",
    supportedThinking: template.supportedThinking ?? "",
    supportedQualities: template.supportedQualities ?? "",
    webSearch: template.webSearch ?? false,
  }));

/**
 * 模板未覆盖的主流模型能力补充表。
 * 只登记公开且稳定的能力，未收录的模型返回 null（面板不自动填充）。
 */
const EXTRA_MODEL_CAPABILITIES: ImageGenModelCapability[] = [
  {
    match: "gpt-image-2.6",
    label: "GPT Image 2.6",
    provider: "openai",
    defaultSize: "auto",
    defaultQuality: "",
    supportedRatios: "",
    supportedResolutions: "",
    supportedThinking: "",
    supportedQualities: "low, medium, high, xhigh, max",
    webSearch: false,
  },
  // --- OpenAI gpt-image 2.5 通用（sunburst / flare 之外的 2.5 命名） ---
  // ⚠️ 尺寸与比例空间**开放**（官方：两边 ≥256px 且 ≤3840px、总像素
  // 655,360~8,294,400、16 的倍数、比例 1:3~3:1，支持任意 WIDTHxHEIGHT）→
  // supported_* 一旦声明即被 Rust `sanitize_size` 当精确白名单拦截，
  // 声明不完整会误拦合法尺寸（如 1:1@4K 的 2880x2880）→ 留空 = 未声明 = 放行。
  {
    match: "gpt-image-2.5",
    label: "GPT Image 2.5",
    provider: "openai",
    defaultSize: "1792x1008",
    defaultQuality: "high",
    supportedRatios: "",
    supportedResolutions: "",
    supportedThinking: "",
    supportedQualities: "low, medium, high, xhigh, max",
    webSearch: false,
  },
  // --- OpenAI gpt-image 1.x / 经典系列 ---
  {
    match: "gpt-image-1.5",
    label: "GPT Image 1.5",
    provider: "openai",
    defaultSize: "1024x1024",
    defaultQuality: "high",
    supportedRatios: "1:1, 3:2, 2:3",
    supportedResolutions: "1024x1024, 1536x1024, 1024x1536",
    supportedThinking: "",
    webSearch: false,
  },
  {
    match: "gpt-image-1-mini",
    label: "GPT Image 1 Mini",
    provider: "openai",
    defaultSize: "1024x1024",
    defaultQuality: "medium",
    supportedRatios: "1:1, 3:2, 2:3",
    supportedResolutions: "1024x1024, 1536x1024, 1024x1536",
    supportedThinking: "",
    webSearch: false,
  },
  {
    match: "gpt-image-1",
    label: "GPT Image 1",
    provider: "openai",
    defaultSize: "1024x1024",
    defaultQuality: "high",
    supportedRatios: "1:1, 3:2, 2:3",
    supportedResolutions: "1024x1024, 1536x1024, 1024x1536",
    supportedThinking: "",
    webSearch: false,
  },
  {
    match: "chatgpt-image-latest",
    label: "ChatGPT Image (latest)",
    provider: "openai",
    defaultSize: "1792x1008",
    defaultQuality: "high",
    // 同 gpt-image-2 系：尺寸/比例空间开放，留空 = 放行（见上条注释）。
    supportedRatios: "",
    supportedResolutions: "",
    supportedThinking: "",
    webSearch: false,
  },
  {
    match: "dall-e-2",
    label: "DALL·E 2",
    provider: "openai",
    defaultSize: "1024x1024",
    defaultQuality: "standard",
    supportedRatios: "1:1",
    supportedResolutions: "256x256, 512x512, 1024x1024",
    supportedThinking: "",
    webSearch: false,
  },
  // --- 国产 / 开源主流 ---
  {
    match: "qwen-image-2.1-turbo",
    label: "Qwen Image 2.1 Turbo",
    provider: "openai",
    defaultSize: "1024x1024",
    defaultQuality: "",
    supportedRatios: "1:1, 16:9, 9:16, 4:3, 3:4",
    supportedResolutions: "1024x1024, 1280x720, 720x1280",
    supportedThinking: "",
    webSearch: false,
  },
  {
    match: "wanx2.1-t2i-turbo",
    label: "Wanx 2.1 Turbo",
    provider: "openai",
    defaultSize: "1024x1024",
    defaultQuality: "",
    supportedRatios: "1:1, 16:9, 9:16, 4:3, 3:4",
    supportedResolutions: "1024x1024, 1280x720, 720x1280",
    supportedThinking: "",
    webSearch: false,
  },
  {
    match: "flux-1.1-ultra",
    label: "FLUX 1.1 Ultra",
    provider: "openai",
    defaultSize: "1536x1024",
    defaultQuality: "",
    supportedRatios: "1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 21:9",
    supportedResolutions: "1024x1024, 1536x1024, 1024x1536, 2048x2048",
    supportedThinking: "",
    webSearch: false,
  },
  {
    match: "cogview-4",
    label: "CogView-4 (智谱最新)",
    provider: "openai",
    defaultSize: "1024x1024",
    defaultQuality: "",
    supportedRatios: "1:1, 16:9, 9:16, 4:3, 3:4, 21:9",
    supportedResolutions:
      "1024x1024, 768x1344 (9:16), 1344x768 (16:9), 864x1152 (3:4), 1152x864 (4:3), 1440x720 (2:1)",
    supportedThinking: "",
    webSearch: false,
  },
  // --- 字节 Seedream（即梦 / 火山方舟 Doubao Seedream，官方文档 2026-09） ---
  // ⚠️ 尺寸空间**开放**（官方支持「档位 1K/2K/3K」或「自定义宽高像素值」二选一，
  // Pro 总像素 921600~4624220、宽高比 1:16~16:1），无法穷举成白名单。
  // supported_* 一旦声明即被 Rust `sanitize_size` 当作**精确词元白名单**拦截，
  // 声明不完整会误拦合法尺寸（比留空更危险）→ 故留空 = 未声明 = 放行，
  // 本条目只提供 defaultSize / label 供「按模型 ID 填充能力」带出。
  {
    match: "seedream-5.0-lite",
    label: "Seedream 5.0 Lite (即梦)",
    provider: "openai",
    defaultSize: "2048x2048",
    defaultQuality: "",
    supportedRatios: "",
    supportedResolutions: "",
    supportedThinking: "",
    webSearch: false,
  },
  {
    match: "seedream-5.0-flash",
    label: "Seedream 5.0 Flash (即梦)",
    provider: "openai",
    defaultSize: "2048x2048",
    defaultQuality: "",
    supportedRatios: "",
    supportedResolutions: "",
    supportedThinking: "",
    webSearch: false,
  },
  {
    match: "seedream-5.0-pro",
    label: "Seedream 5.0 Pro (即梦)",
    provider: "openai",
    defaultSize: "2048x2048",
    defaultQuality: "",
    supportedRatios: "",
    supportedResolutions: "",
    supportedThinking: "",
    webSearch: false,
  },
  {
    match: "seedream-4.5",
    label: "Seedream 4.5 (即梦)",
    provider: "openai",
    defaultSize: "2048x2048",
    defaultQuality: "",
    supportedRatios: "",
    supportedResolutions: "",
    supportedThinking: "",
    webSearch: false,
  },
  {
    match: "seedream-4.0",
    label: "Seedream 4.0 (即梦)",
    provider: "openai",
    defaultSize: "2048x2048",
    defaultQuality: "",
    supportedRatios: "",
    supportedResolutions: "",
    supportedThinking: "",
    webSearch: false,
  },
  {
    // 兜底：带渠道前缀 / 连字符变体（如 doubao-seedream-5-0-pro）也能命中。
    match: "seedream",
    label: "Seedream (即梦)",
    provider: "openai",
    defaultSize: "2048x2048",
    defaultQuality: "",
    supportedRatios: "",
    supportedResolutions: "",
    supportedThinking: "",
    webSearch: false,
  },
  // --- Black Forest Labs FLUX.2（官方文档：任意比例、任意尺寸，16 倍数、≤4MP） ---
  // ⚠️ 同 Seedream：比例与尺寸均为开放空间（官方示例 2048x2048 为 4MP 上限，
  // 3840x2160 属非法），留空 = 放行，避免白名单误拦。
  {
    match: "flux-2-max",
    label: "FLUX.2 Max",
    provider: "openai",
    defaultSize: "1024x1024",
    defaultQuality: "",
    supportedRatios: "",
    supportedResolutions: "",
    supportedThinking: "",
    webSearch: false,
  },
  {
    match: "flux-2-pro",
    label: "FLUX.2 Pro",
    provider: "openai",
    defaultSize: "1024x1024",
    defaultQuality: "",
    supportedRatios: "",
    supportedResolutions: "",
    supportedThinking: "",
    webSearch: false,
  },
  {
    match: "flux-2-klein",
    label: "FLUX.2 Klein",
    provider: "openai",
    defaultSize: "1024x1024",
    defaultQuality: "",
    supportedRatios: "",
    supportedResolutions: "",
    supportedThinking: "",
    webSearch: false,
  },
  {
    match: "flux-2-flex",
    label: "FLUX.2 Flex",
    provider: "openai",
    defaultSize: "1024x1024",
    defaultQuality: "",
    supportedRatios: "",
    supportedResolutions: "",
    supportedThinking: "",
    webSearch: false,
  },
  {
    match: "flux-2",
    label: "FLUX.2",
    provider: "openai",
    defaultSize: "1024x1024",
    defaultQuality: "",
    supportedRatios: "",
    supportedResolutions: "",
    supportedThinking: "",
    webSearch: false,
  },
  // --- 快手可灵 Kling Image（官方定价页：3.0 与 3.0 Omni 均为 1K/2K） ---
  // ⚠️ 官方 API 文档为 JS 渲染，无法核实完整参数集；且「1K/2K」与具体像素值
  // 的对应关系未公开 → 留空（未声明 = 放行），不做未经验证的白名单声明。
  {
    match: "kling-image-3.0-omni",
    label: "Kling Image 3.0 Omni",
    provider: "openai",
    defaultSize: "2048x2048",
    defaultQuality: "",
    supportedRatios: "",
    supportedResolutions: "",
    supportedThinking: "",
    webSearch: false,
  },
  {
    match: "kling-image-3.0",
    label: "Kling Image 3.0",
    provider: "openai",
    defaultSize: "2048x2048",
    defaultQuality: "",
    supportedRatios: "",
    supportedResolutions: "",
    supportedThinking: "",
    webSearch: false,
  },
  {
    match: "kling-image-o1",
    label: "Kling Image O1",
    provider: "openai",
    defaultSize: "1024x1024",
    defaultQuality: "",
    supportedRatios: "",
    supportedResolutions: "",
    supportedThinking: "",
    webSearch: false,
  },
  // --- 阿里 Qwen-Image 2.0（阿里云百炼：支持自由设置宽高，总像素 512²~2048²） ---
  // ⚠️ 宽高自由设置（仅总像素区间约束），无法穷举 → 留空 = 放行。
  {
    match: "qwen-image-2.0",
    label: "Qwen Image 2.0 (通义千问)",
    provider: "openai",
    defaultSize: "2048x2048",
    defaultQuality: "",
    supportedRatios: "",
    supportedResolutions: "",
    supportedThinking: "",
    webSearch: false,
  },
  // --- Gemini 预览版 / 旧版（复用对应正式版能力） ---
  {
    match: "gemini-3.1-flash-image-preview",
    label: "Nano Banana 2 (Preview)",
    provider: "gemini",
    defaultSize: "16:9@2K",
    defaultQuality: "",
    supportedRatios:
      "1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 5:4, 4:5, 21:9, 1:4, 1:8, 4:1, 8:1",
    supportedResolutions: "512px, 1K, 2K, 4K (支持 16:9@2K 组合语法)",
    // Nano Banana 2（Gemini 3.1 Flash Image）官方只有 minimal / high 两档；
    // medium 是 2.1 新增，切勿在此声明，否则上游会 400。
    supportedThinking: "minimal, high",
    webSearch: true,
  },
  {
    match: "gemini-3-pro-image-preview",
    label: "Nano Banana Pro (Preview)",
    provider: "gemini",
    defaultSize: "16:9@2K",
    defaultQuality: "",
    supportedRatios: "1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 5:4, 4:5, 21:9",
    supportedResolutions: "1K, 2K, 4K (支持 16:9@2K 组合语法)",
    supportedThinking: "minimal, high",
    webSearch: true,
  },
  {
    match: "gemini-3.1-flash-lite-image",
    label: "Nano Banana 2 Lite",
    provider: "gemini",
    defaultSize: "16:9@1K",
    defaultQuality: "",
    supportedRatios: "1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 5:4, 4:5, 21:9",
    supportedResolutions: "1K",
    supportedThinking: "minimal, high",
    webSearch: true,
  },
  {
    match: "imagen",
    label: "Imagen (Google)",
    provider: "gemini",
    defaultSize: "1024x1024",
    defaultQuality: "",
    supportedRatios: "1:1, 16:9, 9:16, 4:3, 3:4",
    supportedResolutions: "1024x1024, 1408x768, 768x1408",
    supportedThinking: "",
    webSearch: false,
  },
];

/** 全部能力项（模板派生 + 补充表）。 */
export const MODEL_CAPABILITIES: ImageGenModelCapability[] = [
  ...TEMPLATE_CAPABILITIES,
  ...EXTRA_MODEL_CAPABILITIES,
];

/**
 * 按模型 ID 解析能力：子串匹配 + **最长命中**（与 Rust 侧
 * `find_model_config` 的匹配策略一致），保证 `gpt-image-2.5-sunburst`
 * 不会被更短的 `gpt-image-2.5` / `gpt-image-2` 抢先命中。
 *
 * 未收录的模型返回 null（面板不自动填充，保留用户手填内容）。
 */
export const resolveModelCapability = (
  modelId: string,
): ImageGenModelCapability | null => {
  const id = modelId.trim().toLowerCase();
  if (!id) {
    return null;
  }
  let best: ImageGenModelCapability | null = null;
  for (const capability of MODEL_CAPABILITIES) {
    if (!capability.match || !id.includes(capability.match)) {
      continue;
    }
    if (!best || capability.match.length > best.match.length) {
      best = capability;
    }
  }
  return best;
};

/**
 * 判断模型 ID 是否属于 Gemini 生图家族（Nano Banana / Imagen）。
 * 用于「联网搜索」等仅 Gemini 原生协议支持的能力提示。
 */
export const isGeminiFamilyModel = (modelId: string): boolean => {
  const id = modelId.trim().toLowerCase();
  if (!id) {
    return false;
  }
  return (
    id.includes("gemini") ||
    id.includes("banana") ||
    id.includes("imagen") ||
    id.includes("flash-image") ||
    id.includes("pro-image") ||
    id.includes("lite-image")
  );
};

/**
 * Gemini 家族思考强度候选全集（不含空值 "Auto"）。
 * 单一来源 = constants.ts 的 GEMINI_THINKING_LEVEL_OPTIONS（含空值 Auto），此处剔除空值。
 */
export const THINKING_LEVEL_VALUES: readonly string[] =
  GEMINI_THINKING_LEVEL_OPTIONS.filter((value) => value !== "");

/**
 * 按模型声明裁剪 Gemini 思考强度候选（不含空值 "Auto"，由调用方自行前置）。
 *
 * 与 Rust 侧 `sanitize_thinking_level` 的三态语义保持一致：
 * - 能力库未收录 / 未声明 `supportedThinking` → 返回全集（未声明 = 宽松放行）；
 * - 已声明 → 只保留声明内的档位，避免 UI 给出上游不支持的选项
 *   （例如 Nano Banana 2 只有 minimal / high，选 medium 会被静默丢弃）。
 */
export const resolveThinkingLevels = (modelId: string): string[] => {
  const declared = (
    resolveModelCapability(modelId)?.supportedThinking ?? ""
  ).trim();
  if (!declared) {
    return [...THINKING_LEVEL_VALUES];
  }
  const tokens = declared
    .split(/[,;/|\s()[\]@]+/)
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  const filtered = THINKING_LEVEL_VALUES.filter((value) =>
    tokens.includes(value),
  );
  return filtered.length > 0 ? filtered : [...THINKING_LEVEL_VALUES];
};
