/**
 * 生图模型能力统一解析模块。
 *
 * 双层解析：
 * 1. `inferModelCapabilities`：按「渠道协议 + 模型 ID 特征」推断协议级基线
 *    （尺寸体系 / 高级参数支持度 / 质量选项裁剪），未知模型按协议保守默认；
 * 2. `resolveChannelModelCapabilities`：在基线上合并用户配置声明
 *    （模型项 `supportedRatios` 等优先、渠道级字段回退），与 Rust 侧
 *    `effective_capability` / `sanitize_thinking_level` 的三态语义同构：
 *    未声明（空）→ 宽松放行走基线；已声明 → 以声明为准裁剪/替换选项。
 *
 * 另提供 `collectChannelModelEntries`：把启用渠道的模型项配置收集为
 * 「(渠道, 模型项) 对」条目列表（同模型多渠道并存，不跨渠道去重），
 * 供绘图工作台模型下拉直接驱动，不再实时拉取渠道模型 API。
 */

import type { Model } from "../../../preload";
import type {
  ImageGenChannelValue,
  ImageGenModelItem,
} from "../sidebar/imagegenSettings/types";
import {
  GROK_ASPECT_RATIOS as GROK_RATIOS,
  GROK_SIZE_PRESETS,
  OPENAI_SIZE_PRESETS,
  getGeminiAspectRatios,
} from "../sidebar/imagegenSettings/constants";
import { resolveModelCapability } from "../sidebar/imagegenSettings/modelCapabilities";

/** 尺寸体系。 */
export type SizeSystem = "openai-size" | "gemini-tier" | "ratio-resolution";

/** 质量选项（value 空 = 不传，走渠道/服务商默认）。 */
export type QualityOption = { value: string; labelKey: string };

/** 模型能力全集（按需裁剪前端配置项）。 */
export type ModelCapabilities = {
  /** 尺寸体系（决定尺寸控件形态）。 */
  sizeSystem: SizeSystem;
  /** 可选宽高比（空数组 = 不显示比例选择）。 */
  ratios: string[];
  /** ratio-resolution 体系的分辨率选项（如 grok 的 1k/2k；含空 = 默认）。 */
  resolutions: string[];
  /** gemini-tier 体系的档位选项（1K/2K/4K/512px）。 */
  tiers: string[];
  /** openai-size 体系的固定尺寸预设（无档位模型，如 dall-e-3/gpt-image-1）。 */
  fixedSizePresets: { ratio: string; size: string }[];
  /** 是否支持图生图/参考图。 */
  supportsReference: boolean;
  /** 是否支持透明背景（仅 gpt-image-1 + png）。 */
  supportsTransparent: boolean;
  /** 是否支持一次生成多张（dall-e-3 固定 1 张）。 */
  supportsMultiCount: boolean;
  /** 一次生成数量上限（官方契约；grok-imagine 为 10，其余 8）。 */
  maxCount: number;
  /** 是否支持思考级别（gemini-3.1-flash-image 专属）。 */
  supportsThinking: boolean;
  /** 思考强度选项（空数组 = 隐藏思考控件；声明范围时按声明裁剪）。 */
  thinkingOptions: QualityOption[];
  /** 是否支持图片搜索（gemini-3.1-flash-image 专属）。 */
  supportsImageSearch: boolean;
  /** 是否支持 Google 搜索 grounding（gemini-3.1-flash-image / gemini-3-pro-image）。 */
  supportsWebSearch: boolean;
  /** 参考图数量上限（gemini-2.5 为 3，gemini 3 系列为 14；0 = 不支持参考图）。 */
  maxReferenceImages: number;
  /** 是否支持输出格式（output_format / outputFormat）。 */
  supportsOutputFormat: boolean;
  /** 是否支持输出压缩率（output_compression）。 */
  supportsCompression: boolean;
  /** 是否支持背景（background，透明/不透明）。 */
  supportsBackground: boolean;
  /** 是否支持保真度（input_fidelity，图生图）。 */
  supportsFidelity: boolean;
  /** 是否支持种子（seed）。 */
  supportsSeed: boolean;
  /** 是否支持反向提示词（negativePrompt；仅 Gemini Imagen 系）。 */
  supportsNegativePrompt: boolean;
  /** 是否支持流式预览（SSE partial images）。 */
  supportsStream: boolean;
  /** 质量选项（空数组 = 隐藏质量控件）。 */
  qualityOptions: QualityOption[];
};

/** 官方质量选项取值 → i18n 标签 */
export const QUALITY_LEVEL_LABEL_KEYS: Record<string, string> = {
  auto: "rightPanel.aiDrawing.qualityAuto",
  low: "rightPanel.aiDrawing.qualityLow",
  medium: "rightPanel.aiDrawing.qualityMedium",
  high: "rightPanel.aiDrawing.qualityHigh",
  xhigh: "rightPanel.aiDrawing.qualityXhigh",
  max: "rightPanel.aiDrawing.qualityMax",
  standard: "rightPanel.aiDrawing.qualityStandard",
  hd: "rightPanel.aiDrawing.qualityHd",
  "": "rightPanel.aiDrawing.qualityDefault",
};

/** 通用质量选项（OpenAI gpt-image 系基础档位）。 */
const QUALITY_OPTIONS: QualityOption[] = [
  { value: "auto", labelKey: "rightPanel.aiDrawing.qualityAuto" },
  { value: "low", labelKey: "rightPanel.aiDrawing.qualityLow" },
  { value: "medium", labelKey: "rightPanel.aiDrawing.qualityMedium" },
  { value: "high", labelKey: "rightPanel.aiDrawing.qualityHigh" },
];

/** OpenAI gpt-image-2.5 质量选项（官方支持 low / medium / high / xhigh / max 与 auto）。 */
export const GPT_IMAGE_25_QUALITY_OPTIONS: QualityOption[] = [
  { value: "auto", labelKey: "rightPanel.aiDrawing.qualityAuto" },
  { value: "low", labelKey: "rightPanel.aiDrawing.qualityLow" },
  { value: "medium", labelKey: "rightPanel.aiDrawing.qualityMedium" },
  { value: "high", labelKey: "rightPanel.aiDrawing.qualityHigh" },
  { value: "xhigh", labelKey: "rightPanel.aiDrawing.qualityXhigh" },
  { value: "max", labelKey: "rightPanel.aiDrawing.qualityMax" },
];

/** 思考强度官方取值（与 native sanitize_thinking_level 归一化后的集合一致）。 */
const THINKING_LEVEL_VALUES = ["minimal", "medium", "high"];

/** 思考强度取值 → i18n 标签（medium 为 Nano Banana 2.1 官方档位）。 */
const THINKING_LEVEL_LABEL_KEYS: Record<string, string> = {
  minimal: "rightPanel.aiDrawing.thinkingMinimal",
  medium: "rightPanel.aiDrawing.thinkingMedium",
  high: "rightPanel.aiDrawing.thinkingHigh",
};

/** 思考强度默认选项（协议推断支持但未声明范围时使用，Gemini 3.1 Flash）。 */
const GEMINI_THINKING_DEFAULT_OPTIONS: QualityOption[] = [
  { value: "", labelKey: "rightPanel.aiDrawing.thinkingDefault" },
  { value: "minimal", labelKey: "rightPanel.aiDrawing.thinkingMinimal" },
  { value: "high", labelKey: "rightPanel.aiDrawing.thinkingHigh" },
];

/** Nano Banana 2.1 思考强度选项（官方档位 minimal/medium/high，默认 medium）。 */
const GEMINI_BANANA21_THINKING_OPTIONS: QualityOption[] = [
  { value: "", labelKey: "rightPanel.aiDrawing.thinkingDefault" },
  { value: "minimal", labelKey: "rightPanel.aiDrawing.thinkingMinimal" },
  { value: "medium", labelKey: "rightPanel.aiDrawing.thinkingMedium" },
  { value: "high", labelKey: "rightPanel.aiDrawing.thinkingHigh" },
];

/** OpenAI gpt-image 固定尺寸预设（无档位模型）。 */
const OPENAI_FIXED_SIZE_PRESETS: Record<
  string,
  { ratio: string; size: string }[]
> = {
  "dall-e-3": [
    { ratio: "1:1", size: "1024x1024" },
    { ratio: "16:9", size: "1792x1024" },
    { ratio: "9:16", size: "1024x1792" },
  ],
  "dall-e-2": [{ ratio: "1:1", size: "1024x1024" }],
  default: [
    { ratio: "1:1", size: "1024x1024" },
    { ratio: "3:2", size: "1536x1024" },
    { ratio: "2:3", size: "1024x1536" },
  ],
};

/** 查询某 OpenAI 模型的固定尺寸预设（无档位模型用）。 */
export const openaiFixedSizePresets = (
  modelId: string,
): { ratio: string; size: string }[] => {
  const id = modelId.toLowerCase();
  if (id.includes("dall-e-3")) {
    return OPENAI_FIXED_SIZE_PRESETS["dall-e-3"];
  }
  if (id.includes("dall-e-2")) {
    return OPENAI_FIXED_SIZE_PRESETS["dall-e-2"];
  }
  return OPENAI_FIXED_SIZE_PRESETS.default;
};

/** OpenAI 系生图模型特征（含 grok-imagine 等 OpenAI 兼容第三方）。 */
export const isGrokModel = (model: string): boolean => {
  const id = model.toLowerCase();
  return id.includes("grok-imagine") || id.includes("grok-image");
};

/** 从 API 返回的模型列表中筛选生图模型（按模型 ID 特征）。 */
export const filterImageModels = (
  models: Model[],
  provider: ImageGenChannelValue["provider"],
): Model[] => {
  if (provider === "gemini") {
    return models.filter((model) => {
      const id = model.id.toLowerCase();
      return id.includes("-image") || id.startsWith("imagen");
    });
  }
  if (provider === "novelai") {
    return models.filter((model) => {
      const id = model.id.toLowerCase();
      return id.includes("nai-diffusion");
    });
  }
  return models.filter((model) => {
    const id = model.id.toLowerCase();
    return (
      id.includes("gpt-image") ||
      id.includes("dall-e") ||
      id.includes("grok-imagine") ||
      id.includes("grok-image")
    );
  });
};

/** 模型是否支持「档位」（1K/2K/4K 像素档位；OpenAI 仅 gpt-image-2 系）。 */
export const supportsSizeTier = (
  provider: ImageGenChannelValue["provider"],
  model: string,
): boolean => {
  if (provider === "gemini") {
    return true;
  }
  return model.toLowerCase().includes("gpt-image-2");
};

// ------------------------------------------------------------------
// 配置化声明解析（与 Rust capability_tokens / capability_declared 同构）
// ------------------------------------------------------------------

/** 中文别名归一化映射表（支持用户配置中文画质） */
const NORMALIZE_QUALITY_ALIAS: Record<string, string> = {
  低: "low",
  中: "medium",
  高: "high",
  超高: "xhigh",
  极致: "max",
  极高: "max",
  最高: "max",
  标准: "standard",
  高清: "hd",
  自动: "auto",
};

/** 配置化支持范围声明（模型项与渠道级同名字段的最小切片）。 */
export type DeclaredCapabilityFields = {
  supportedRatios?: string;
  supportedResolutions?: string;
  supportedThinking?: string;
  supportedQualities?: string;
  defaultQuality?: string;
  customPrompt?: string;
};

/** 把「支持范围」说明文本切分为小写词元集合（分隔符语义与 Rust 一致）。 */
export const capabilityTokens = (raw: string): string[] =>
  raw
    .split(/[\s,;()[\]|/@]+/)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0);

/** 判断取值是否出现在已声明的支持列表中（大小写不敏感词元匹配）。 */
export const capabilityContains = (raw: string, value: string): boolean => {
  const needle = value.trim().toLowerCase();
  return needle.length > 0 && capabilityTokens(raw).includes(needle);
};

/** 「支持范围」是否已被显式声明（非空白；未声明 = 宽松放行的三态分界）。 */
export const capabilityDeclared = (raw: string | undefined): boolean =>
  Boolean(raw && raw.trim() !== "");

/** 模型项声明优先、渠道级字段回退，取第一个已声明的支持范围原文。 */
export const effectiveDeclared = (
  itemValue: string | undefined,
  channelValue: string | undefined,
): string | undefined => {
  if (capabilityDeclared(itemValue)) {
    return itemValue;
  }
  if (capabilityDeclared(channelValue)) {
    return channelValue;
  }
  return undefined;
};

/** 把已声明的支持范围切为去重选项列表（保持声明顺序）。 */
export const declaredList = (raw: string | undefined): string[] => {
  if (!capabilityDeclared(raw)) {
    return [];
  }
  return [...new Set(capabilityTokens(raw ?? ""))];
};

/** 从配置文本（以逗号/分号/空格等切分）构建质量选项数组（纯配置驱动）。 */
export const buildQualityOptionsFromDeclared = (
  raw: string,
  includeAuto = true,
): QualityOption[] => {
  const tokens = declaredList(raw).map((token) => {
    const lower = token.toLowerCase();
    return NORMALIZE_QUALITY_ALIAS[lower] ?? lower;
  });
  const options: QualityOption[] = [];
  if (includeAuto) {
    options.push({
      value: "auto",
      labelKey: "rightPanel.aiDrawing.qualityAuto",
    });
  }
  for (const q of tokens) {
    if (!options.some((opt) => opt.value === q)) {
      options.push({
        value: q,
        labelKey: QUALITY_LEVEL_LABEL_KEYS[q] ?? q,
      });
    }
  }
  return options;
};

/**
 * 按声明裁剪默认候选：未声明时原样返回（宽松放行）；
 * 已声明时保留声明集合内的候选（保持原顺序），并把声明中
 * 内置预设之外的额外项（如自定义比例 "5:4"）补到尾部。
 */
export const filterDeclared = (
  candidates: string[],
  declared: string[],
): string[] => {
  if (declared.length === 0) {
    return candidates;
  }
  const declaredSet = new Set(declared.map((item) => item.toLowerCase()));
  const kept = candidates.filter((item) => declaredSet.has(item.toLowerCase()));
  const extras = declared.filter(
    (item) =>
      !kept.some((keptItem) => keptItem.toLowerCase() === item.toLowerCase()),
  );
  return [...kept, ...extras];
};

/**
 * 按渠道协议 + 模型 ID 推断完整能力（协议基线层）。
 * 未知模型按协议保守默认（openai 系全开，gemini 系按 gemini 规则），
 * 仅对明确受限的模型收紧。
 */
export const inferModelCapabilities = (
  provider: ImageGenChannelValue["provider"],
  model: string,
): ModelCapabilities => {
  const id = model.toLowerCase();

  if (provider === "gemini") {
    // imagen 系列与 gemini-2.5-flash-image：仅文生图（不支持参考图/编辑）
    const textOnly =
      id.startsWith("imagen") || id.includes("gemini-2.5-flash-image");
    // 思考级别/图片搜索：Gemini 3.1 Flash Image 与 Nano Banana 2.1 专属能力
    const banana21 = id.includes("gemini-nano-banana-2.1");
    const flash3 =
      id.includes("gemini-3.1-flash-image") &&
      !id.includes("gemini-3.1-flash-lite-image");
    // Google 搜索 grounding：3.1 Flash Image / Nano Banana 2.1 + 3 Pro Image
    // （Lite / 2.5 不支持）
    const webSearchSupported =
      flash3 || banana21 || id.includes("gemini-3-pro-image");
    // 输出格式（mime_type png/jpeg）：Gemini 3 系列支持；2.5 / imagen 不支持
    const outputFormatSupported =
      !textOnly &&
      (flash3 ||
        banana21 ||
        id.includes("gemini-3-pro-image") ||
        id.includes("flash-lite"));
    // 参考图上限：2.5 为 3 张，Gemini 3 系列为 14 张，imagen 不支持
    const maxRef = id.startsWith("imagen")
      ? 0
      : id.includes("gemini-2.5-flash-image")
        ? 3
        : 14;
    return {
      sizeSystem: "gemini-tier",
      ratios: getGeminiAspectRatios(model), // 比例按模型细分（2.1 / 3.1 Flash 含超宽）
      resolutions: [],
      // Nano Banana 2.1 不支持 512px（仅 3.1 Flash Image 支持）
      tiers: banana21
        ? ["", "1K", "2K", "4K"]
        : ["", "512px", "1K", "2K", "4K"],
      fixedSizePresets: [],
      supportsReference: !textOnly,
      supportsTransparent: false,
      supportsMultiCount: true,
      maxCount: 8,
      supportsThinking: flash3 || banana21,
      thinkingOptions: banana21
        ? GEMINI_BANANA21_THINKING_OPTIONS
        : flash3
          ? GEMINI_THINKING_DEFAULT_OPTIONS
          : [],
      supportsImageSearch: flash3 || banana21,
      supportsWebSearch: webSearchSupported,
      maxReferenceImages: maxRef,
      supportsOutputFormat: outputFormatSupported,
      supportsCompression: false,
      supportsBackground: false,
      supportsFidelity: false,
      supportsSeed: true,
      // 反向提示词：仅 Imagen 系（generateContent 的 generationConfig.negativePrompt
      // 官方支持字段）；Nano Banana（2.5 / 3 系列）官方建议用语义化正向描述，不支持。
      supportsNegativePrompt: id.startsWith("imagen"),
      supportsStream: true,
      // Gemini 仅接受 low/medium/high（auto 会被忽略）；「默认」（空值）=
      // 不发送 quality，由 Rust 侧应用渠道配置的 defaultQuality，
      // 避免此前把质量静默强制成 "high" 发送。
      qualityOptions: [
        { value: "", labelKey: "rightPanel.aiDrawing.qualityDefault" },
        ...QUALITY_OPTIONS.filter((option) => option.value !== "auto"),
      ],
    };
  }

  // ---- NovelAI 原生图片 API（image.novelai.net，非 OpenAI 兼容协议） ----
  if (provider === "novelai") {
    return {
      sizeSystem: "openai-size",
      ratios: ["2:3", "3:2", "1:1", "9:16", "16:9", "4:3", "3:4", "21:9"],
      resolutions: [],
      tiers: [],
      fixedSizePresets: [
        { ratio: "2:3", size: "832x1216" },
        { ratio: "3:2", size: "1216x832" },
        { ratio: "1:1", size: "1024x1024" },
        { ratio: "2:3", size: "1024x1536" },
      ],
      supportsReference: true,
      supportsTransparent: false,
      supportsMultiCount: true,
      maxCount: 8,
      supportsThinking: false,
      thinkingOptions: [],
      supportsImageSearch: false,
      supportsWebSearch: false,
      // img2img / infill 仅接受单张底图（+可选 mask）
      maxReferenceImages: 1,
      supportsOutputFormat: false,
      supportsCompression: false,
      supportsBackground: false,
      supportsFidelity: false,
      supportsSeed: true,
      // NovelAI 反向提示词（parameters.uc）
      supportsNegativePrompt: true,
      supportsStream: false,
      // NovelAI 无质量档位参数：仅「默认」（不发送 quality）
      qualityOptions: [
        { value: "", labelKey: "rightPanel.aiDrawing.qualityDefault" },
      ],
    };
  }

  // ---- OpenAI 兼容系（含 xAI Grok Imagine） ----
  if (isGrokModel(model)) {
    // xAI Grok Imagine（官方文档 2026-08）：
    // - 尺寸：aspect_ratio + resolution（1k/2k），不用 OpenAI size
    // - quality：仅 grok-imagine-image-2.0 支持（low/medium）
    // - 图生图：POST /images/edits 走 JSON body（image.url = data URI）
    // - 编辑参考图上限：3 张（官方 "up to 3 reference images"）
    // - 一次生成数量上限：10 张（官方 "up to 10 images per request"）
    // - 不支持：output_format / output_compression / background /
    //   input_fidelity / seed / moderation / SSE 流式
    const supportsQuality = id.includes("grok-imagine-image-2.0");
    return {
      sizeSystem: "ratio-resolution",
      ratios: GROK_RATIOS,
      resolutions: [...GROK_SIZE_PRESETS],
      tiers: [],
      fixedSizePresets: [],
      supportsReference: true,
      supportsTransparent: false,
      supportsMultiCount: true,
      maxCount: 10,
      supportsThinking: false,
      thinkingOptions: [],
      supportsImageSearch: false,
      supportsWebSearch: false,
      maxReferenceImages: 3,
      supportsOutputFormat: false,
      supportsCompression: false,
      supportsBackground: false,
      supportsFidelity: false,
      supportsSeed: false,
      supportsNegativePrompt: false,
      supportsStream: false,
      qualityOptions: supportsQuality
        ? [
            { value: "", labelKey: "rightPanel.aiDrawing.qualityDefault" },
            { value: "low", labelKey: "rightPanel.aiDrawing.qualityLow" },
            { value: "medium", labelKey: "rightPanel.aiDrawing.qualityMedium" },
          ]
        : [],
    };
  }

  // OpenAI 兼容系（gpt-image / dall-e 等）
  const isDalle3 = id.includes("dall-e-3");
  const isDalle = id.startsWith("dall-e");
  const isGptImage2 = id.includes("gpt-image-2");
  const isGptImage1 = id.includes("gpt-image-1") && !isGptImage2;
  const openaiMaxRef = 14;

  // 从内置能力库获取模型默认能力配置（配置驱动）
  const cap = resolveModelCapability(model);

  const openaiRatios = cap?.supportedRatios
    ? declaredList(cap.supportedRatios)
    : Object.keys(OPENAI_SIZE_PRESETS);
  const openaiResolutions = cap?.supportedResolutions
    ? declaredList(cap.supportedResolutions)
    : ["1K", "2K", "4K"];

  return {
    sizeSystem: "openai-size",
    ratios: openaiRatios,
    resolutions: openaiResolutions,
    tiers: ["", "1K", "2K", "4K"],
    fixedSizePresets: isGptImage2 ? [] : openaiFixedSizePresets(model),
    supportsReference: !isDalle3,
    supportsTransparent: isGptImage1,
    supportsMultiCount: !isDalle3,
    maxCount: isDalle3 ? 1 : 8,
    supportsThinking: false,
    thinkingOptions: [],
    supportsImageSearch: false,
    supportsWebSearch: false,
    maxReferenceImages: openaiMaxRef,
    supportsOutputFormat: !isDalle,
    supportsCompression: !isDalle,
    supportsBackground: !isDalle,
    supportsFidelity: !isDalle && !isGptImage2,
    supportsSeed: !isDalle,
    supportsNegativePrompt: false,
    supportsStream: !isDalle,
    qualityOptions: cap?.supportedQualities
      ? buildQualityOptionsFromDeclared(cap.supportedQualities, true)
      : isDalle3
        ? [
            { value: "", labelKey: "rightPanel.aiDrawing.qualityDefault" },
            {
              value: "standard",
              labelKey: "rightPanel.aiDrawing.qualityStandard",
            },
            { value: "hd", labelKey: "rightPanel.aiDrawing.qualityHd" },
          ]
        : isDalle
          ? []
          : QUALITY_OPTIONS,
  };
};

/**
 * 按「(渠道, 模型项)」解析完整能力：配置声明优先，协议推断兜底。
 *
 * 1. 以 `inferModelCapabilities(provider, model)` 产出协议级基线；
 * 2. 模型项声明优先、渠道级字段回退（与 native `effective_capability` 同构）：
 *    - 声明比例 → 裁剪/替换比例候选（仅对消费比例列表的体系生效，
 *      并补充内置预设之外的自定义比例）；
 *    - 声明分辨率 → 作为 ratio-resolution 体系候选（grok 等）；
 *    - 声明思考强度 → 开启思考控件并按声明构建选项（仅接受官方取值；
 *      「low」声明与 native 归一化（low→minimal）后的词元匹配不一致，忽略）；
 *    - 质量选项 → 根据模型项 defaultQuality、渠道 defaultQuality 以及模型特征动态完善。
 */
export const resolveChannelModelCapabilities = (
  provider: ImageGenChannelValue["provider"],
  model: string,
  item: DeclaredCapabilityFields | undefined,
  channel: DeclaredCapabilityFields | undefined,
): ModelCapabilities => {
  const base = inferModelCapabilities(provider, model);
  const ratiosRaw = effectiveDeclared(
    item?.supportedRatios,
    channel?.supportedRatios,
  );
  const resolutionsRaw = effectiveDeclared(
    item?.supportedResolutions,
    channel?.supportedResolutions,
  );
  const thinkingRaw = effectiveDeclared(
    item?.supportedThinking,
    channel?.supportedThinking,
  );

  // 比例与分辨率声明按配置解析：声明优先裁剪，未声明则继承基线
  const ratios = capabilityDeclared(ratiosRaw)
    ? filterDeclared(base.ratios, declaredList(ratiosRaw))
    : base.ratios;
  const resolutions = capabilityDeclared(resolutionsRaw)
    ? declaredList(resolutionsRaw)
    : base.resolutions;

  const thinkingTokens = declaredList(thinkingRaw).filter((token) =>
    THINKING_LEVEL_VALUES.includes(token),
  );
  const thinkingOptions =
    thinkingTokens.length > 0
      ? [
          { value: "", labelKey: "rightPanel.aiDrawing.thinkingDefault" },
          ...thinkingTokens.map((token) => ({
            value: token,
            labelKey: THINKING_LEVEL_LABEL_KEYS[token] ?? token,
          })),
        ]
      : base.thinkingOptions;

  // 质量选项按配置声明解析：
  // 1. 用户配置声明优先（模型项 supportedQualities > 渠道 supportedQualities）；
  // 2. 未声明时从模型能力库读取（base.qualityOptions 已由 resolveModelCapability 解析）；
  // 3. 用户配置的 defaultQuality 必须能够在工作台中选中（若不在列表中则动态补全）。
  const declaredQualitiesRaw = effectiveDeclared(
    item?.supportedQualities,
    channel?.supportedQualities,
  );

  const rawConfiguredQuality = (
    item?.defaultQuality?.trim() ||
    channel?.defaultQuality?.trim() ||
    ""
  ).toLowerCase();

  const resolvedQualityOptions: QualityOption[] = capabilityDeclared(
    declaredQualitiesRaw,
  )
    ? buildQualityOptionsFromDeclared(declaredQualitiesRaw!, true)
    : [...base.qualityOptions];

  // 若配置指明了不在预设选项中的有效自定义质量（非 auto），动态追加
  if (
    rawConfiguredQuality &&
    rawConfiguredQuality !== "auto" &&
    resolvedQualityOptions.length > 0 &&
    !resolvedQualityOptions.some(
      (opt) => opt.value.toLowerCase() === rawConfiguredQuality,
    )
  ) {
    resolvedQualityOptions.push({
      value: rawConfiguredQuality,
      labelKey:
        QUALITY_LEVEL_LABEL_KEYS[rawConfiguredQuality] ?? rawConfiguredQuality,
    });
  }

  return {
    ...base,
    ratios,
    resolutions,
    supportsThinking: thinkingTokens.length > 0 || base.supportsThinking,
    thinkingOptions,
    qualityOptions: resolvedQualityOptions,
  };
};

// ------------------------------------------------------------------
// 模型条目收集：(渠道, 模型项) 对——工作台模型下拉的数据源
// ------------------------------------------------------------------

/** 工作台模型条目：同模型多渠道并存（不跨渠道去重），选择即锁定渠道。 */
export type ChannelModelEntry = {
  /** 条目复合键（渠道|模型）：下拉值与持久化恢复的唯一定位。 */
  key: string;
  /** 模型 ID（生成参数 model）。 */
  id: string;
  /** 所属渠道 ID（生成参数 provider；路由即选择）。 */
  channelId: string;
  /** 下拉展示文案：模型别名/ID，跨条目重名时追加渠道名消歧。 */
  label: string;
  /** 命中的模型项配置（顶层主模型兜底条目为 undefined）。 */
  item: ImageGenModelItem | undefined;
};

/**
 * 从启用渠道收集模型条目：
 * - 渠道配置了 `models[]` → 每个启用的模型项各成一个条目（别名优先展示）；
 * - 未配置模型项 → 顶层主模型作为唯一条目（能力走协议推断 + 渠道级声明）。
 * 展示名跨条目重复时统一追加渠道名消歧。
 */
export const collectChannelModelEntries = (
  channels: ImageGenChannelValue[],
): ChannelModelEntry[] => {
  const entries: ChannelModelEntry[] = [];
  for (const channel of channels) {
    const items = (channel.models ?? []).filter(
      (modelItem) =>
        modelItem.enabled !== false && modelItem.model.trim() !== "",
    );
    if (items.length > 0) {
      for (const modelItem of items) {
        const id = modelItem.model.trim();
        entries.push({
          key: `${channel.id}|${id}`,
          id,
          channelId: channel.id,
          label: modelItem.name?.trim() || id,
          item: modelItem,
        });
      }
    } else if (channel.model.trim() !== "") {
      const id = channel.model.trim();
      entries.push({
        key: `${channel.id}|${id}`,
        id,
        channelId: channel.id,
        label: id,
        item: undefined,
      });
    }
  }
  const labelCount = new Map<string, number>();
  for (const entry of entries) {
    labelCount.set(entry.label, (labelCount.get(entry.label) ?? 0) + 1);
  }
  if (labelCount.size === entries.length) {
    return entries;
  }
  return entries.map((entry) => {
    const channel = channels.find((item) => item.id === entry.channelId);
    const channelName = channel?.name.trim() || channel?.provider || "";
    return {
      ...entry,
      label: channelName ? `${entry.label} · ${channelName}` : entry.label,
    };
  });
};
