/**
 * 生图模型能力统一推断模块。
 *
 * 按「渠道协议 + 模型 ID 特征」推断模型能力，驱动前端配置项渲染：
 * - 尺寸体系（openai-size 固定分辨率 / gemini-tier 比例+档位 /
 *   ratio-resolution 比例+分辨率，如 xAI Grok Imagine）
 * - 高级参数逐项支持度（输出格式/压缩/背景/保真度/种子/流式）
 * - 质量选项裁剪（不同模型 quality 取值不同）
 *
 * 原则：未知模型按协议保守默认（openai 系全开但参数透传由后端兜底，
 * 已知受限模型显式收紧），避免硬编码模型全集。
 */

import type { Model } from "../../../preload";
import type { ImageGenChannelValue } from "../sidebar/imagegenSettings/types";
import {
  GROK_ASPECT_RATIOS as GROK_RATIOS,
  GROK_SIZE_PRESETS,
  getGeminiAspectRatios,
} from "../sidebar/imagegenSettings/constants";

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
  /** 是否支持思考级别（gemini-3.1-flash-image 专属）。 */
  supportsThinking: boolean;
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
  /** 是否支持流式预览（SSE partial images）。 */
  supportsStream: boolean;
  /** 质量选项（空数组 = 隐藏质量控件）。 */
  qualityOptions: QualityOption[];
};

/** 通用质量选项（OpenAI gpt-image 系）。 */
const QUALITY_OPTIONS: QualityOption[] = [
  { value: "auto", labelKey: "rightPanel.aiDrawing.qualityAuto" },
  { value: "low", labelKey: "rightPanel.aiDrawing.qualityLow" },
  { value: "medium", labelKey: "rightPanel.aiDrawing.qualityMedium" },
  { value: "high", labelKey: "rightPanel.aiDrawing.qualityHigh" },
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
  modelId: string
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
  provider: ImageGenChannelValue["provider"]
): Model[] => {
  if (provider === "gemini") {
    return models.filter((model) => {
      const id = model.id.toLowerCase();
      return id.includes("-image") || id.startsWith("imagen");
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
  model: string
): boolean => {
  if (provider === "gemini") {
    return true;
  }
  return model.toLowerCase().includes("gpt-image-2");
};

/**
 * 按渠道协议 + 模型 ID 推断完整能力。
 * 未知模型按协议保守默认（openai 系全开，gemini 系按 gemini 规则），
 * 仅对明确受限的模型收紧。
 */
export const inferModelCapabilities = (
  provider: ImageGenChannelValue["provider"],
  model: string
): ModelCapabilities => {
  const id = model.toLowerCase();

  if (provider === "gemini") {
    // imagen 系列与 gemini-2.5-flash-image：仅文生图（不支持参考图/编辑）
    const textOnly =
      id.startsWith("imagen") || id.includes("gemini-2.5-flash-image");
    // 思考级别/图片搜索：Gemini 3.1 Flash Image 专属能力
    const flash3 =
      id.includes("gemini-3.1-flash-image") &&
      !id.includes("gemini-3.1-flash-lite-image");
    // Google 搜索 grounding：3.1 Flash Image + 3 Pro Image（Lite / 2.5 不支持）
    const webSearchSupported = flash3 || id.includes("gemini-3-pro-image");
    // 输出格式（mime_type png/jpeg）：Gemini 3 系列支持；2.5 / imagen 不支持
    const outputFormatSupported =
      !textOnly && (flash3 || id.includes("gemini-3-pro-image") || id.includes("flash-lite"));
    // 参考图上限：2.5 为 3 张，Gemini 3 系列为 14 张，imagen 不支持
    const maxRef = id.startsWith("imagen")
      ? 0
      : id.includes("gemini-2.5-flash-image")
        ? 3
        : 14;
    return {
      sizeSystem: "gemini-tier",
      ratios: getGeminiAspectRatios(model), // 比例按模型细分（3.1 Flash 含超宽）
      resolutions: [],
      tiers: ["", "512px", "1K", "2K", "4K"],
      fixedSizePresets: [],
      supportsReference: !textOnly,
      supportsTransparent: false,
      supportsMultiCount: true,
      supportsThinking: flash3,
      supportsImageSearch: flash3,
      supportsWebSearch: webSearchSupported,
      maxReferenceImages: maxRef,
      supportsOutputFormat: outputFormatSupported,
      supportsCompression: false,
      supportsBackground: false,
      supportsFidelity: false,
      supportsSeed: true,
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

  // ---- OpenAI 兼容系（含 xAI Grok Imagine） ----
  if (isGrokModel(model)) {
    // xAI Grok Imagine（官方文档 2026-08）：
    // - 尺寸：aspect_ratio + resolution（1k/2k），不用 OpenAI size
    // - quality：仅 grok-imagine-image-2.0 支持（low/medium）
    // - 图生图：POST /images/edits 走 JSON body（image.url = data URI）
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
      supportsThinking: false,
      supportsImageSearch: false,
      supportsWebSearch: false,
      maxReferenceImages: 5,
      supportsOutputFormat: false,
      supportsCompression: false,
      supportsBackground: false,
      supportsFidelity: false,
      supportsSeed: false,
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

  // OpenAI 官方系
  const isDalle3 = id.includes("dall-e-3");
  const isDalle = id.startsWith("dall-e");
  const isGptImage2 = id.includes("gpt-image-2");
  const isGptImage1 = id.includes("gpt-image-1") && !isGptImage2;
  return {
    sizeSystem: "openai-size",
    ratios: [],
    resolutions: [],
    tiers: ["", "1K", "2K", "4K"],
    fixedSizePresets: isGptImage2 ? [] : openaiFixedSizePresets(model),
    supportsReference: !isDalle3,
    supportsTransparent: isGptImage1,
    supportsMultiCount: !isDalle3,
    supportsThinking: false,
    supportsImageSearch: false,
    supportsWebSearch: false,
    maxReferenceImages: 5,
    supportsOutputFormat: !isDalle,
    supportsCompression: !isDalle,
    supportsBackground: !isDalle,
    supportsFidelity: !isDalle && !isGptImage2,
    supportsSeed: !isDalle,
    supportsStream: !isDalle,
    qualityOptions: isDalle3
      ? [
          { value: "", labelKey: "rightPanel.aiDrawing.qualityDefault" },
          { value: "standard", labelKey: "rightPanel.aiDrawing.qualityStandard" },
          { value: "hd", labelKey: "rightPanel.aiDrawing.qualityHd" },
        ]
      : isDalle
        ? []
        : QUALITY_OPTIONS,
  };
};
