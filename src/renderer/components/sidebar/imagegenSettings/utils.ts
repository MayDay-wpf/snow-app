import {
  DEFAULT_IMAGE_GEN_CHANNEL,
  DEFAULT_IMAGE_GEN_MAX_CONCURRENT,
  DEFAULT_IMAGE_GEN_TIMEOUT_SECS,
  DEFAULT_IMAGE_GEN_EXECUTION_MODE,
  IMAGE_GEN_MAX_CONCURRENT_RANGE,
  IMAGE_GEN_TIMEOUT_RANGE,
} from "./constants";
import type {
  ImageGenChannelValue,
  ImageGenExecutionMode,
  ImageGenModelItem,
  ImageGenProvider,
  ImageGenSettingsForm,
  ImageGenSettingsValue,
} from "./types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const toBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

const toText = (value: unknown, fallback: string): string =>
  typeof value === "string" ? value : fallback;

/** 解析最大并发生成数：非法/缺失回退默认值，超出范围时收敛到边界。 */
const toConcurrentCount = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_IMAGE_GEN_MAX_CONCURRENT;
  }
  const { min, max } = IMAGE_GEN_MAX_CONCURRENT_RANGE;
  return Math.min(max, Math.max(min, Math.round(value)));
};

/** 解析生图请求超时（秒）：非法/缺失回退默认值，超出范围时收敛到边界。 */
const toTimeoutSecs = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_IMAGE_GEN_TIMEOUT_SECS;
  }
  const { min, max } = IMAGE_GEN_TIMEOUT_RANGE;
  return Math.min(max, Math.max(min, Math.round(value)));
};

const readProvider = (
  value: unknown,
  fallback: ImageGenProvider,
): ImageGenProvider =>
  value === "gemini" ? "gemini" : value === "novelai" ? "novelai" : fallback;

/** 解析生图执行模式：合法值 auto/sync/async，非法回退默认 auto。 */
export const readExecutionMode = (
  value: unknown,
  fallback: ImageGenExecutionMode = DEFAULT_IMAGE_GEN_EXECUTION_MODE,
): ImageGenExecutionMode => {
  if (value === "sync" || value === "async" || value === "auto") {
    return value;
  }
  return fallback;
};

/** 解析单个模型的配置。 */
export const readModelItem = (source: unknown): ImageGenModelItem => {
  if (!isRecord(source)) {
    return { id: "", model: "" };
  }
  return {
    id: toText(source.id, ""),
    model: toText(source.model, ""),
    name: toText(source.name, ""),
    defaultSize: toText(source.defaultSize, ""),
    defaultQuality: toText(source.defaultQuality, ""),
    defaultComplexity: toText(source.defaultComplexity, ""),
    defaultOutputFormat: toText(source.defaultOutputFormat, ""),
    supportedRatios: toText(source.supportedRatios, ""),
    supportedResolutions: toText(source.supportedResolutions, ""),
    supportedThinking: toText(source.supportedThinking, ""),
    supportedQualities: toText(source.supportedQualities, ""),
    customPrompt: toText(source.customPrompt, ""),
    enabled: source.enabled !== false,
  };
};

/** 解析多模型列表。 */
export const readModels = (source: unknown): ImageGenModelItem[] => {
  if (!Array.isArray(source)) {
    return [];
  }
  return source.map(readModelItem).filter((m) => m.model.trim().length > 0);
};

/** 解析单个渠道的原始字段。 */
const readChannel = (source: unknown): ImageGenChannelValue => {
  if (!isRecord(source)) {
    return { ...DEFAULT_IMAGE_GEN_CHANNEL };
  }
  const models = readModels(source.models);
  return {
    id: toText(source.id, DEFAULT_IMAGE_GEN_CHANNEL.id),
    name: toText(source.name, DEFAULT_IMAGE_GEN_CHANNEL.name),
    provider: readProvider(source.provider, DEFAULT_IMAGE_GEN_CHANNEL.provider),
    enabled: toBoolean(source.enabled, DEFAULT_IMAGE_GEN_CHANNEL.enabled),
    baseUrl: toText(source.baseUrl, DEFAULT_IMAGE_GEN_CHANNEL.baseUrl),
    apiKey: toText(source.apiKey, DEFAULT_IMAGE_GEN_CHANNEL.apiKey),
    model: toText(source.model, DEFAULT_IMAGE_GEN_CHANNEL.model),
    defaultSize: toText(
      source.defaultSize,
      DEFAULT_IMAGE_GEN_CHANNEL.defaultSize,
    ),
    defaultQuality: toText(
      source.defaultQuality,
      DEFAULT_IMAGE_GEN_CHANNEL.defaultQuality,
    ),
    outputFormat: toText(
      source.outputFormat,
      DEFAULT_IMAGE_GEN_CHANNEL.outputFormat,
    ),
    webSearch: toBoolean(source.webSearch, DEFAULT_IMAGE_GEN_CHANNEL.webSearch),
    defaultStream: toBoolean(
      source.defaultStream,
      DEFAULT_IMAGE_GEN_CHANNEL.defaultStream,
    ),
    supportedRatios: toText(
      source.supportedRatios,
      DEFAULT_IMAGE_GEN_CHANNEL.supportedRatios ?? "",
    ),
    supportedResolutions: toText(
      source.supportedResolutions,
      DEFAULT_IMAGE_GEN_CHANNEL.supportedResolutions ?? "",
    ),
    supportedThinking: toText(
      source.supportedThinking,
      DEFAULT_IMAGE_GEN_CHANNEL.supportedThinking ?? "",
    ),
    supportedQualities: toText(
      source.supportedQualities,
      DEFAULT_IMAGE_GEN_CHANNEL.supportedQualities ?? "",
    ),
    customPrompt: toText(
      source.customPrompt,
      DEFAULT_IMAGE_GEN_CHANNEL.customPrompt ?? "",
    ),
    executionMode:
      source.executionMode === "sync" ||
      source.executionMode === "async" ||
      source.executionMode === "auto"
        ? source.executionMode
        : undefined,
    models: models.length > 0 ? models : undefined,
  };
};

/** 生成新的渠道 ID（前端使用；旧数据无 id 或新建渠道时调用）。 */
export const generateChannelId = (
  provider: ImageGenProvider,
  index = 0,
): string => {
  const random = Math.random().toString(36).slice(2, 8);
  return `${provider}-${random}${index > 0 ? `-${index}` : ""}`;
};

/** 迁移旧格式渠道（旧双渠道键 "openai"/"gemini" 即协议类型）。 */
const migrateLegacyChannel = (
  provider: ImageGenProvider,
  source: unknown,
): ImageGenChannelValue => {
  const channel = readChannel(source);
  if (!channel.id) {
    channel.id = provider;
  }
  channel.provider = provider;
  return channel;
};

/** 将 system_settings 原始 JSON 字符串解析为规范化设置（含旧格式迁移）。 */
export const readImageGenSettingsJson = (
  raw: string | null,
): ImageGenSettingsValue => {
  if (!raw) {
    return {
      channels: [],
      maxConcurrentImages: DEFAULT_IMAGE_GEN_MAX_CONCURRENT,
      timeoutSecs: DEFAULT_IMAGE_GEN_TIMEOUT_SECS,
      executionMode: DEFAULT_IMAGE_GEN_EXECUTION_MODE,
    };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return {
        channels: [],
        maxConcurrentImages: DEFAULT_IMAGE_GEN_MAX_CONCURRENT,
        timeoutSecs: DEFAULT_IMAGE_GEN_TIMEOUT_SECS,
        executionMode: DEFAULT_IMAGE_GEN_EXECUTION_MODE,
      };
    }

    // 新版多渠道格式：{ channels: [...] }
    if (Array.isArray(parsed.channels)) {
      const channels = parsed.channels.map((item, index) => {
        const channel = readChannel(item);
        if (!channel.id) {
          channel.id = generateChannelId(channel.provider, index);
        }
        return channel;
      });
      return {
        channels,
        maxConcurrentImages: toConcurrentCount(parsed.maxConcurrentImages),
        timeoutSecs: toTimeoutSecs(parsed.timeoutSecs),
        executionMode: readExecutionMode(parsed.executionMode),
      };
    }

    // 旧版双渠道格式：{ openai: {...}, gemini: {...} }
    if (parsed.openai || parsed.gemini) {
      const channels: ImageGenChannelValue[] = [];
      if (parsed.openai) {
        channels.push(migrateLegacyChannel("openai", parsed.openai));
      }
      if (parsed.gemini) {
        channels.push(migrateLegacyChannel("gemini", parsed.gemini));
      }
      return {
        channels,
        maxConcurrentImages: DEFAULT_IMAGE_GEN_MAX_CONCURRENT,
        timeoutSecs: DEFAULT_IMAGE_GEN_TIMEOUT_SECS,
        executionMode: readExecutionMode(parsed.executionMode),
      };
    }

    // 旧版单渠道格式迁移：顶层 provider/baseUrl/apiKey/model/...
    const oldProvider = toText(parsed.provider, "");
    const oldBaseUrl = toText(parsed.baseUrl, "");
    const isGemini =
      oldProvider === "gemini" ||
      oldBaseUrl.includes("generativelanguage") ||
      oldBaseUrl.includes("googleapis.com");
    const legacy = migrateLegacyChannel(isGemini ? "gemini" : "openai", {
      ...parsed,
      enabled: true,
    });
    return {
      channels: [legacy],
      maxConcurrentImages: DEFAULT_IMAGE_GEN_MAX_CONCURRENT,
      timeoutSecs: DEFAULT_IMAGE_GEN_TIMEOUT_SECS,
      executionMode: readExecutionMode(parsed.executionMode),
    };
  } catch {
    return {
      channels: [],
      maxConcurrentImages: DEFAULT_IMAGE_GEN_MAX_CONCURRENT,
      timeoutSecs: DEFAULT_IMAGE_GEN_TIMEOUT_SECS,
      executionMode: DEFAULT_IMAGE_GEN_EXECUTION_MODE,
    };
  }
};

/** 存储值 -> 表单（深拷贝渠道数组）。 */
export const toImageGenForm = (
  settings: ImageGenSettingsValue,
): ImageGenSettingsForm => ({
  channels: settings.channels.map((channel) => ({ ...channel })),
  maxConcurrentImages: settings.maxConcurrentImages,
  timeoutSecs: settings.timeoutSecs,
  executionMode: settings.executionMode,
});

/** 表单 -> 存储 JSON 字符串（channels 数组 + 最大并发生成数 + 执行模式）。 */
export const toImageGenSettingsJson = (form: ImageGenSettingsForm): string =>
  JSON.stringify({
    channels: form.channels.map((channel) => ({
      id: channel.id.trim(),
      name: channel.name.trim(),
      provider: channel.provider,
      enabled: channel.enabled,
      baseUrl: channel.baseUrl.trim(),
      apiKey: channel.apiKey.trim(),
      model: channel.model.trim(),
      defaultSize: channel.defaultSize.trim(),
      defaultQuality: channel.defaultQuality.trim(),
      outputFormat: channel.outputFormat.trim(),
      webSearch: channel.webSearch,
      defaultStream: channel.defaultStream,
      supportedRatios: (channel.supportedRatios ?? "").trim(),
      supportedResolutions: (channel.supportedResolutions ?? "").trim(),
      supportedThinking: (channel.supportedThinking ?? "").trim(),
      supportedQualities: (channel.supportedQualities ?? "").trim(),
      customPrompt: (channel.customPrompt ?? "").trim(),
      executionMode: channel.executionMode,
      models:
        channel.models && channel.models.length > 0
          ? channel.models
              .filter((m) => m.model.trim().length > 0)
              .map((m) => ({
                id: m.id || m.model.trim(),
                model: m.model.trim(),
                name: (m.name ?? "").trim(),
                defaultSize: (m.defaultSize ?? "").trim(),
                defaultQuality: (m.defaultQuality ?? "").trim(),
                defaultComplexity: (m.defaultComplexity ?? "").trim(),
                defaultOutputFormat: (m.defaultOutputFormat ?? "").trim(),
                supportedRatios: (m.supportedRatios ?? "").trim(),
                supportedResolutions: (m.supportedResolutions ?? "").trim(),
                supportedThinking: (m.supportedThinking ?? "").trim(),
                supportedQualities: (m.supportedQualities ?? "").trim(),
                customPrompt: (m.customPrompt ?? "").trim(),
                enabled: m.enabled !== false,
              }))
          : undefined,
    })),
    maxConcurrentImages: toConcurrentCount(form.maxConcurrentImages),
    timeoutSecs: toTimeoutSecs(form.timeoutSecs),
    executionMode: readExecutionMode(form.executionMode),
  });
