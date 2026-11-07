/**
 * 图像生成设置面板的纯辅助逻辑（无 React 依赖，便于复用与推理）。
 *
 * 从 `ImageGenSettingsPanel.tsx` 抽出：能力库填充 / 主模型索引解析 /
 * 生图模型筛选与能力标签推断。这些函数全部是纯函数，集中在本模块可让
 * 面板组件专注于交互与渲染。
 */

import type { Model } from "../../../../preload";
import type { ImageGenModelItem, ImageGenProvider } from "./types";
import { resolveModelCapability } from "./modelCapabilities";

/** gpt-image-2 / 2.5 系（含兼容中转）支持任意分辨率判定。 */
export const supportsArbitraryOpenAISize = (modelId: string): boolean => {
  const id = modelId.toLowerCase();
  return (
    id.includes("gpt-image-2") ||
    id.includes("gpt-image-2.5") ||
    id.includes("image-2.5")
  );
};

/** 查询某 OpenAI 模型的标准能力（配置库优先，未收录模型使用宽松全集）。 */
export const openaiStandardCaps = (modelId: string) => {
  const cap = resolveModelCapability(modelId);
  if (cap?.supportedQualities) {
    const rawTokens = cap.supportedQualities
      .split(/[,\s;/]+/)
      .map((token: string) => token.trim().toLowerCase())
      .filter(Boolean);
    return {
      sizes: ["1024x1024", "1536x1024", "1024x1536"],
      quality: ["", ...new Set(rawTokens)],
    };
  }
  // 未在能力库显式声明质量的模型：默认开放标准质量选项（含高画质档位）
  return {
    sizes: ["1024x1024", "1536x1024", "1024x1536"],
    quality: ["", "low", "medium", "high", "xhigh", "max"],
  };
};

/**
 * 解析主模型在列表中的索引：按模型 ID（忽略大小写）精确匹配，
 * 未命中（主模型为空或指向不存在的 ID）时回退首个模型。
 *
 * 单一入口保证「默认主模型」标记唯一——即使历史脏数据里存在两个
 * 同 ID 模型项，也只有第一个会被标记为主模型。
 */
export const resolvePrimaryIndex = (
  list: ImageGenModelItem[],
  primaryModel: string,
): number => {
  const primary = primaryModel.trim().toLowerCase();
  if (primary) {
    const index = list.findIndex(
      (item) => item.model.trim().toLowerCase() === primary,
    );
    if (index >= 0) {
      return index;
    }
  }
  return 0;
};

/**
 * 属于「模型能力」的字段：用于判定模型项是否仍处于「未定制」状态，
 * 从而决定改模型 ID 时是否可以用内置能力库覆盖。
 */
export const CAPABILITY_FIELDS = [
  "defaultSize",
  "defaultQuality",
  "supportedRatios",
  "supportedResolutions",
  "supportedThinking",
  "supportedQualities",
] as const satisfies readonly (keyof ImageGenModelItem)[];

/**
 * 用内置能力库填充模型项的能力字段（默认尺寸/质量/思考强度/支持范围）。
 *
 * 覆盖策略（满足「选择模型 ID 后自动填充，用户手改后不再覆盖」，且必须是
 * 纯函数——组件运行在 React.StrictMode 下，updater 会被双调用）：
 * - 新模型 ID 不在能力库中 → 原样返回；
 * - 任一能力字段既非空、又与「上一个模型的能力值」不同 → 视为用户已定制，
 *   原样返回（不覆盖手改内容）；
 * - 其余情况（全空，或仍等于上一个模型的能力快照）→ 按新模型能力覆盖。
 */
export const applyCapability = (
  item: ImageGenModelItem,
  previousModel: string,
): ImageGenModelItem => {
  const next = resolveModelCapability(item.model);
  if (!next) {
    return item;
  }
  const previous = resolveModelCapability(previousModel);
  const untouched = CAPABILITY_FIELDS.every((field) => {
    const current = ((item[field] as string | undefined) ?? "").trim();
    if (current === "") {
      return true;
    }
    const previousValue = (
      (previous?.[field] as string | undefined) ?? ""
    ).trim();
    return previousValue !== "" && current === previousValue;
  });
  if (!untouched) {
    return item;
  }
  return {
    ...item,
    defaultSize: next.defaultSize,
    defaultQuality: next.defaultQuality,
    supportedRatios: next.supportedRatios,
    supportedResolutions: next.supportedResolutions,
    supportedThinking: next.supportedThinking,
    supportedQualities: next.supportedQualities ?? "",
  };
};

/**
 * 用内置能力库强制填充模型项的能力字段（显式按钮入口）。
 *
 * 与 `applyCapability` 的区别：**不做「未定制」判定**，用户点击按钮即视为
 * 明确要求套用能力库，无条件覆盖 6 个能力字段（但仍不改 model / name /
 * customPrompt）。未收录的模型返回 null，由调用方提示「未收录」。
 */
export const forceApplyCapability = (
  item: ImageGenModelItem,
): ImageGenModelItem | null => {
  const next = resolveModelCapability(item.model);
  if (!next) {
    return null;
  }
  return {
    ...item,
    defaultSize: next.defaultSize,
    defaultQuality: next.defaultQuality,
    supportedRatios: next.supportedRatios,
    supportedResolutions: next.supportedResolutions,
    supportedThinking: next.supportedThinking,
    supportedQualities: next.supportedQualities ?? "",
  };
};

/** 从 API 返回的模型列表中筛选生图模型。 */
export const filterImageModels = (
  models: Model[],
  provider: string,
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
    return id.includes("gpt-image") || id.includes("dall-e");
  });
};

/** 根据模型 ID 推断能力标签（i18n 键）。 */
export const getModelCapabilities = (modelId: string): string[] => {
  const id = modelId.toLowerCase();
  if (id.includes("gemini-nano-banana-2.1")) {
    return [
      "cap4k",
      "capStream",
      "capImageToImage",
      "capThinking",
      "capImageSearch",
    ];
  }
  if (id.includes("gemini-3.1-flash-lite-image")) {
    return ["cap1kOnly", "capFast"];
  }
  if (id.includes("gemini-3.1-flash-image")) {
    return [
      "cap4k",
      "capStream",
      "capImageToImage",
      "capThinking",
      "capImageSearch",
    ];
  }
  if (id.includes("gemini-3-pro-image")) {
    return ["cap4k", "capImageToImage", "capThinking", "capInterleaved"];
  }
  if (id.includes("gemini-2.5-flash-image")) {
    return ["cap1kOnly", "capUpTo3Images", "capLegacy"];
  }
  if (id.startsWith("imagen")) {
    return ["capDeprecated"];
  }
  if (id.includes("nai-diffusion")) {
    return ["capImageToImage"];
  }
  if (id.includes("gpt-image-2") || id.includes("gpt-image-1.5")) {
    return ["cap4k", "capStream", "capImageToImage"];
  }
  if (id.includes("chatgpt-image")) {
    return ["cap4k", "capStream", "capImageToImage"];
  }
  if (id.includes("gpt-image-1-mini")) {
    return ["capFast", "capStream"];
  }
  if (id.includes("gpt-image-1")) {
    return ["cap2k", "capStream", "capImageToImage", "capFidelity"];
  }
  if (id.includes("grok-imagine")) {
    // xAI Grok Imagine：OpenAI 兼容协议，比例+分辨率（1k/2k），支持图生图
    return ["cap2k", "capImageToImage"];
  }
  if (id.includes("dall-e")) {
    return ["capTextToImageOnly"];
  }
  return [];
};

/** 已知生图模型知识表条目（别名 / 预览 / 弃用）。 */
export type KnownImageModel = {
  id: string;
  provider: ImageGenProvider;
  alias?: string;
  preview?: boolean;
  deprecated?: boolean;
};
