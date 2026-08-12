import type { ImageGenChannelValue, ImageGenSettingsValue } from "./types";

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

/** 生图设置默认值：无渠道（未配置时不暴露生图工具）。 */
export const DEFAULT_IMAGE_GEN_SETTINGS: ImageGenSettingsValue = {
  channels: [],
  maxConcurrentImages: DEFAULT_IMAGE_GEN_MAX_CONCURRENT,
  timeoutSecs: DEFAULT_IMAGE_GEN_TIMEOUT_SECS,
};

/** OpenAI 兼容端点官方默认地址（baseUrl 留空时使用）。 */
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

/** Gemini 官方默认地址（baseUrl 留空时使用）。 */
export const DEFAULT_GEMINI_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta";

/** 常见生图模型提示（placeholder 用，含别名与预览版）。 */
export const OPENAI_MODEL_EXAMPLES =
  "gpt-image-2, dall-e-3, chatgpt-image-latest (preview), grok-imagine-image-2.0 (xAI), ...";
export const GEMINI_MODEL_EXAMPLES =
  "gemini-3.1-flash-image (Nano Banana 2), gemini-3-pro-image (Nano Banana Pro), gemini-3.1-flash-lite-image (Nano Banana 2 Lite), gemini-2.5-flash-image (legacy), ...";
/** xAI Grok Imagine 模型示例（OpenAI 兼容协议，baseUrl = https://api.x.ai/v1）。 */
export const GROK_MODEL_EXAMPLES =
  "grok-imagine-image-quality, grok-imagine-image-2.0, ...";

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
  size: string
): { ratio: string; resolution: string } => {
  const trimmed = size.trim();
  const [ratioPart, sizePart] = trimmed.includes("@")
    ? trimmed.split("@")
    : [trimmed, ""];
  const ratio = GROK_ASPECT_RATIOS.includes(ratioPart.trim())
    ? ratioPart.trim()
    : "";
  let resolution = (GROK_SIZE_PRESETS as readonly string[]).includes(
    sizePart.trim()
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
export const GEMINI_ASPECT_RATIOS_FLASH3_EXTRA = [
  "1:4",
  "1:8",
  "4:1",
  "8:1",
];

/**
 * 按模型返回 Gemini 支持的宽高比列表（官方文档 2026-07）：
 * - gemini-3.1-flash-image：14 种（含 1:4 / 1:8 / 4:1 / 8:1 超宽）
 * - 其他（3 Pro / 3.1 Flash Lite / 2.5 Flash Image）：10 种
 */
export const getGeminiAspectRatios = (model: string): string[] => {
  const id = model.toLowerCase();
  if (id.includes("gemini-3.1-flash-image") && !id.includes("flash-lite")) {
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
 * 解析 Gemini 的 defaultSize：
 * - "16:9" → { ratio: "16:9", imageSize: "" }
 * - "2K" → { ratio: "", imageSize: "2K" }
 * - "16:9@2K" → { ratio: "16:9", imageSize: "2K" }
 * - 其他（自定义/空）→ 均为 ""
 */
export const matchGeminiSizePreset = (
  size: string
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
    sizePart.trim()
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
  size: string
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
