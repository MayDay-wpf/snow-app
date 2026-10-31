import type { ApiConfigInput, ApiConfigRecord } from "../../../../preload";
import {
  DEFAULT_API_BASE_URL,
  DEFAULT_REQUEST_METHOD,
} from "./apiSettingsConstants";
import {
  DEFAULT_AUTO_COMPRESS_THRESHOLD_PERCENT,
  calculateAutoCompressThresholdPercent,
  calculateAutoCompressThresholdTokens,
  normalizeAutoCompressThresholdPercent,
} from "./autoCompressThreshold";
import {
  DEFAULT_TOOL_RESULT_LIMIT_PERCENT,
  normalizeToolResultLimitPercent,
} from "./toolResultLimit";
import {
  DEFAULT_THINKING_VALUE,
  THINKING_OPTIONS_BY_METHOD,
} from "../../mainContent/chatInput/constants";
import type { ApiConfigFormData } from "./types";

type RequestMethod =
  "chat" | "responses" | "gemini" | "anthropic" | "interactions";

const normalizeRequestMethod = (value: string): RequestMethod => {
  if (
    value === "responses" ||
    value === "gemini" ||
    value === "anthropic" ||
    value === "interactions"
  ) {
    return value;
  }
  return "chat";
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseConfigJson = (configJson: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(configJson);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const readSnowcfg = (configJson: string): Record<string, unknown> => {
  const parsed = parseConfigJson(configJson);
  return isRecord(parsed.snowcfg) ? parsed.snowcfg : {};
};

export const extractToolResultTokenLimitFromConfigJson = (
  configJson: string,
): string => {
  const value = readSnowcfg(configJson).toolResultTokenLimit;
  return String(
    normalizeToolResultLimitPercent(
      typeof value === "string" || typeof value === "number"
        ? value
        : undefined,
    ),
  );
};

export const extractResponsesVerbosityFromConfigJson = (
  configJson: string,
): string => {
  const value = readSnowcfg(configJson).responsesVerbosity;
  return value === "low" || value === "medium" || value === "high" ? value : "";
};

export const extractResponsesServiceTierFromConfigJson = (
  configJson: string,
): string => {
  const value = readSnowcfg(configJson).responsesFastMode;
  if (value === "fast" || value === "ultrafast") return value;
  return value === true ? "fast" : "";
};

/** 读取 Responses WebSocket 开关（snowcfg.responsesWebSocket，默认关闭） */
export const extractResponsesWebSocketFromConfigJson = (
  configJson: string,
): boolean => readSnowcfg(configJson).responsesWebSocket === true;

/** 读取 gemini 渠道的谷歌搜索联网开关（snowcfg.googleSearch） */
export const extractGoogleSearchFromConfigJson = (
  configJson: string,
): boolean => readSnowcfg(configJson).googleSearch === true;

/** 读取 1M 上下文开关（snowcfg.enable1mContext）。
 *  开启后所有 anthropic 请求都会携带 context-1m beta 头，
 *  与模型名 `[1M]` 标记互为兜底（任一成立即生效）。 */
export const extractOneMContextFromConfigJson = (configJson: string): boolean =>
  readSnowcfg(configJson).enable1mContext === true;

/** 读取 gemini 视觉（图片模型）渠道的谷歌搜索联网开关（snowcfg.visionGoogleSearch） */
export const extractVisionGoogleSearchFromConfigJson = (
  configJson: string,
): boolean => readSnowcfg(configJson).visionGoogleSearch === true;

/** 读取视觉模型的思考开关（snowcfg.visionThinking.enabled，默认关闭） */
export const extractVisionThinkingEnabledFromConfigJson = (
  configJson: string,
): boolean => {
  const thinking = readSnowcfg(configJson).visionThinking;
  return (
    typeof thinking === "object" &&
    thinking !== null &&
    (thinking as { enabled?: unknown }).enabled === true
  );
};

/** 读取视觉模型的思考强度（snowcfg.visionThinking.reasoning_effort） */
export const extractVisionThinkingEffortFromConfigJson = (
  configJson: string,
): string => {
  const thinking = readSnowcfg(configJson).visionThinking;
  if (typeof thinking !== "object" || thinking === null) return "";
  const effort = (thinking as { reasoning_effort?: unknown }).reasoning_effort;
  return typeof effort === "string" && effort.trim() ? effort : "";
};

/** 读取视觉模型的最大输出 tokens（snowcfg.visionMaxTokens，默认 4096） */
export const extractVisionMaxTokensFromConfigJson = (
  configJson: string,
): string => {
  const value = readSnowcfg(configJson).visionMaxTokens;
  return typeof value === "number" && value > 0 ? String(value) : "";
};

/** 读取视觉文本化的最大并发数（snowcfg.visionMaxConcurrency，默认 8） */
export const extractVisionMaxConcurrencyFromConfigJson = (
  configJson: string,
): string => {
  const value = readSnowcfg(configJson).visionMaxConcurrency;
  return typeof value === "number" && value > 0 ? String(value) : "";
};

/**
 * Validates a thinking value against the available options for the given
 * request method. Returns the value itself when it is a known option for
 * the method, otherwise falls back to DEFAULT_THINKING_VALUE.
 */
export const resolveThinkingValue = (
  thinkingValue: string,
  requestMethod: string,
): string => {
  const method = normalizeRequestMethod(requestMethod);
  const options = THINKING_OPTIONS_BY_METHOD[method];
  const isValid = options.some((option) => option.value === thinkingValue);
  return isValid ? thinkingValue : DEFAULT_THINKING_VALUE;
};

/**
 * Builds the configJson string with thinking configuration applied to the
 * correct snowcfg key for the given request method. Each method uses a
 * different key name and value-field name:
 *   chat      -> chatThinking.reasoning_effort
 *   responses -> responsesReasoning.effort
 *   gemini    -> geminiThinking.thinkingLevel
 *   anthropic -> thinking.effort
 */
const buildConfigJsonWithThinking = (
  thinkingValue: string,
  requestMethod: string,
  configJson: string,
  snowcfgOverrides: Record<string, unknown>,
): string => {
  const method = normalizeRequestMethod(requestMethod);
  const isThinkingEnabled = thinkingValue !== "none";
  const parsedConfig = parseConfigJson(configJson);
  const existingSnowcfg = isRecord(parsedConfig.snowcfg)
    ? parsedConfig.snowcfg
    : {};
  const snowcfg: Record<string, unknown> = {
    ...existingSnowcfg,
    ...snowcfgOverrides,
  };
  snowcfg.requestMethod = requestMethod || method;

  if (method === "anthropic") {
    snowcfg.thinking = {
      type: "adaptive",
      enabled: isThinkingEnabled,
      effort: thinkingValue,
    };
  } else if (method === "gemini" || method === "interactions") {
    snowcfg.geminiThinking = {
      enabled: isThinkingEnabled,
      thinkingLevel: thinkingValue,
    };
  } else if (method === "responses") {
    snowcfg.responsesReasoning = {
      enabled: isThinkingEnabled,
      effort: thinkingValue,
    };
  } else {
    snowcfg.chatThinking = {
      enabled: isThinkingEnabled,
      reasoning_effort: thinkingValue,
    };
  }

  return JSON.stringify({
    ...parsedConfig,
    snowcfg,
  });
};

/**
 * Extracts the thinking value from a configJson string, reading the correct
 * snowcfg key based on the request method. Falls back to DEFAULT_THINKING_VALUE
 * when the config is missing or the thinking section is absent.
 */
export const extractThinkingValueFromConfigJson = (
  configJson: string,
  requestMethod: string,
): string => {
  try {
    const parsed = JSON.parse(configJson);
    const snowcfg = parsed?.snowcfg;
    if (typeof snowcfg !== "object" || snowcfg === null) {
      return DEFAULT_THINKING_VALUE;
    }

    const method = normalizeRequestMethod(requestMethod);
    let section: Record<string, unknown> | undefined;

    if (method === "anthropic") {
      section = snowcfg.thinking;
    } else if (method === "gemini" || method === "interactions") {
      section = snowcfg.geminiThinking;
    } else if (method === "responses") {
      section = snowcfg.responsesReasoning;
    } else {
      section = snowcfg.chatThinking;
    }

    if (typeof section !== "object" || section === null) {
      return DEFAULT_THINKING_VALUE;
    }

    if (section.enabled === false) {
      return "none";
    }

    const valueKey =
      method === "anthropic"
        ? "effort"
        : method === "gemini" || method === "interactions"
          ? "thinkingLevel"
          : method === "responses"
            ? "effort"
            : "reasoning_effort";

    const value = section[valueKey];
    return typeof value === "string" && value.trim()
      ? value
      : DEFAULT_THINKING_VALUE;
  } catch {
    return DEFAULT_THINKING_VALUE;
  }
};

export function apiConfigToForm(config: ApiConfigRecord): ApiConfigFormData {
  return {
    profileName: config.profileName,
    displayName: config.displayName,
    baseUrl: config.baseUrl || DEFAULT_API_BASE_URL,
    baseUrlMode: config.baseUrlMode || "auto",
    apiKey: config.apiKey || "",
    requestMethod: config.requestMethod || DEFAULT_REQUEST_METHOD,
    advancedModel: config.advancedModel || "",
    basicModel: config.basicModel || "",
    isActive: config.isActive,
    supportsVision: config.supportsVision,
    visionBaseUrl: config.visionBaseUrl || "",
    visionApiKey: config.visionApiKey || "",
    visionRequestMethod: config.visionRequestMethod || DEFAULT_REQUEST_METHOD,
    visionModel: config.visionModel || "",
    maxContextTokens:
      config.maxContextTokens != null ? String(config.maxContextTokens) : "",
    maxTokens: config.maxTokens != null ? String(config.maxTokens) : "",
    streamIdleTimeoutSec:
      config.streamIdleTimeoutSec != null
        ? String(config.streamIdleTimeoutSec)
        : "",
    enableAutoCompress: config.enableAutoCompress ?? true,
    autoCompressThreshold: calculateAutoCompressThresholdPercent(
      config.maxContextTokens,
      config.autoCompressThreshold,
    ),
    toolResultTokenLimit: extractToolResultTokenLimitFromConfigJson(
      config.configJson,
    ),
    maxRetries: config.maxRetries != null ? String(config.maxRetries) : "",
    retryBaseDelayMs:
      config.retryBaseDelayMs != null ? String(config.retryBaseDelayMs) : "",
    partialRetryMaxChars:
      config.partialRetryMaxChars != null
        ? String(config.partialRetryMaxChars)
        : "",
    systemPromptIdsJson: config.systemPromptIdsJson ?? "",
    customHeaderSchemeId: config.customHeaderSchemeId ?? "",
    thinkingValue: extractThinkingValueFromConfigJson(
      config.configJson,
      config.requestMethod || DEFAULT_REQUEST_METHOD,
    ),
    responsesVerbosity: extractResponsesVerbosityFromConfigJson(
      config.configJson,
    ),
    responsesServiceTier: extractResponsesServiceTierFromConfigJson(
      config.configJson,
    ),
    responsesWebSocket: extractResponsesWebSocketFromConfigJson(
      config.configJson,
    ),
    googleSearch: extractGoogleSearchFromConfigJson(config.configJson),
    oneMContext: extractOneMContextFromConfigJson(config.configJson),
    visionGoogleSearch: extractVisionGoogleSearchFromConfigJson(
      config.configJson,
    ),
    visionThinkingEnabled: extractVisionThinkingEnabledFromConfigJson(
      config.configJson,
    ),
    visionThinkingEffort: extractVisionThinkingEffortFromConfigJson(
      config.configJson,
    ),
    visionMaxTokens: extractVisionMaxTokensFromConfigJson(config.configJson),
    visionMaxConcurrency: extractVisionMaxConcurrencyFromConfigJson(
      config.configJson,
    ),
    configJson: config.configJson,
  };
}

export type RetryCategoryState = {
  enabled: boolean;
  keywords: string;
};

export type RetryConfigState = {
  always: boolean;
  categories: Record<string, RetryCategoryState>;
  customKeywords: string;
};

export const parseRetryPolicy = (raw: string | null): RetryConfigState => {
  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  const policy = isRecord(parsed) ? parsed : {};
  const categories: Record<string, RetryCategoryState> = {};
  const storedCategories = isRecord(policy.categories) ? policy.categories : {};

  for (const [id, value] of Object.entries(storedCategories)) {
    if (!isRecord(value)) continue;
    categories[id] = {
      enabled: value.enabled !== false,
      keywords: typeof value.keywords === "string" ? value.keywords : "",
    };
  }

  return {
    always: policy.always === true,
    categories,
    customKeywords:
      typeof policy.customKeywords === "string" ? policy.customKeywords : "",
  };
};

export const serializeRetryPolicy = (state: RetryConfigState): string =>
  JSON.stringify({
    always: state.always,
    categories: state.categories,
    customKeywords: state.customKeywords,
  });

export const emptyApiConfigForm = (
  index: number,
  active: boolean,
): ApiConfigFormData => ({
  profileName: `manual-${index}`,
  displayName: "",
  baseUrl: DEFAULT_API_BASE_URL,
  baseUrlMode: "auto",
  apiKey: "",
  requestMethod: DEFAULT_REQUEST_METHOD,
  advancedModel: "",
  basicModel: "",
  isActive: active,
  supportsVision: true,
  visionBaseUrl: "",
  visionApiKey: "",
  visionRequestMethod: DEFAULT_REQUEST_METHOD,
  visionModel: "",
  maxContextTokens: "",
  maxTokens: "",
  streamIdleTimeoutSec: "",
  enableAutoCompress: true,
  autoCompressThreshold: String(DEFAULT_AUTO_COMPRESS_THRESHOLD_PERCENT),
  toolResultTokenLimit: String(DEFAULT_TOOL_RESULT_LIMIT_PERCENT),
  maxRetries: "5",
  retryBaseDelayMs: "",
  partialRetryMaxChars: "1000",
  systemPromptIdsJson: "",
  customHeaderSchemeId: "",
  thinkingValue: DEFAULT_THINKING_VALUE,
  oneMContext: false,
  responsesVerbosity: "",
  responsesServiceTier: "",
  responsesWebSocket: false,
  googleSearch: false,
  visionGoogleSearch: false,
  visionThinkingEnabled: false,
  visionThinkingEffort: "",
  visionMaxTokens: "",
  visionMaxConcurrency: "",
  configJson: "{}",
});

export const parseOptionalInteger = (value: string): number | null => {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
};

export function toApiConfigPayload(
  data: ApiConfigFormData,
  isActive: boolean,
  configCount: number,
  /**
   * 档案来源标记（source）：编辑既有档案时必须回传原值，否则 OAuth 档案
   * （source = oauth-<provider id>）会被改写成 manual，依赖该标记的订阅配额
   * 面板将不再渲染；新建档案使用默认值 manual。
   */
  source = "manual",
): ApiConfigInput {
  const profileName = data.profileName.trim();
  const displayName = data.displayName.trim() || profileName;
  const baseUrl = data.baseUrl.trim() || DEFAULT_API_BASE_URL;
  const requestMethod = data.requestMethod.trim() || DEFAULT_REQUEST_METHOD;
  const advancedModel = data.advancedModel.trim();
  const basicModel = data.basicModel.trim();
  const visionRequestMethod = data.visionRequestMethod.trim() || requestMethod;
  // 后端 upsert 对 config_json 深合并，省略的键会保留旧值；
  // 因此 responses 渠道的「默认/关闭」档位必须显式写入，不能省略键。
  const isResponses = normalizeRequestMethod(requestMethod) === "responses";
  const autoCompressThresholdPercent = normalizeAutoCompressThresholdPercent(
    data.autoCompressThreshold,
  );
  const autoCompressThresholdTokens = calculateAutoCompressThresholdTokens(
    data.maxContextTokens,
    autoCompressThresholdPercent,
  );
  const configJson = buildConfigJsonWithThinking(
    data.thinkingValue || DEFAULT_THINKING_VALUE,
    requestMethod,
    data.configJson,
    {
      baseUrl,
      baseUrlMode: data.baseUrlMode,
      requestMethod,
      advancedModel,
      basicModel,
      supportsVision: data.supportsVision,
      maxContextTokens:
        parseOptionalInteger(data.maxContextTokens) ?? undefined,
      maxTokens: parseOptionalInteger(data.maxTokens) ?? undefined,
      streamIdleTimeoutSec:
        parseOptionalInteger(data.streamIdleTimeoutSec) ?? undefined,
      enableAutoCompress: data.enableAutoCompress,
      autoCompressThresholdPercent,
      autoCompressThreshold: autoCompressThresholdTokens ?? undefined,
      toolResultTokenLimit: normalizeToolResultLimitPercent(
        data.toolResultTokenLimit,
      ),
      responsesVerbosity: isResponses
        ? data.responsesVerbosity || ""
        : undefined,
      responsesFastMode: isResponses
        ? data.responsesServiceTier || "off"
        : undefined,
      responsesWebSocket: data.responsesWebSocket,
      googleSearch: data.googleSearch,
      enable1mContext: data.oneMContext,
      visionGoogleSearch: data.visionGoogleSearch,
      visionThinking: data.visionThinkingEnabled
        ? {
            enabled: true,
            reasoning_effort: data.visionThinkingEffort || undefined,
          }
        : { enabled: false },
      visionMaxTokens: parseOptionalInteger(data.visionMaxTokens) ?? undefined,
      visionMaxConcurrency:
        parseOptionalInteger(data.visionMaxConcurrency) ?? undefined,
    },
  );

  return {
    profileName,
    displayName,
    isActive: isActive || configCount === 0,
    baseUrl,
    baseUrlMode: data.baseUrlMode || "auto",
    apiKey: data.apiKey,
    requestMethod,
    advancedModel,
    basicModel,
    supportsVision: data.supportsVision,
    visionBaseUrl: data.visionBaseUrl.trim(),
    visionBaseUrlMode: "auto",
    visionApiKey: data.visionApiKey,
    visionRequestMethod,
    visionModel: data.visionModel.trim(),
    maxContextTokens: parseOptionalInteger(data.maxContextTokens),
    maxTokens: parseOptionalInteger(data.maxTokens),
    streamIdleTimeoutSec: parseOptionalInteger(data.streamIdleTimeoutSec),
    enableAutoCompress: data.enableAutoCompress,
    autoCompressThreshold: autoCompressThresholdTokens,
    maxRetries: parseOptionalInteger(data.maxRetries),
    retryBaseDelayMs: parseOptionalInteger(data.retryBaseDelayMs),
    partialRetryMaxChars: parseOptionalInteger(data.partialRetryMaxChars),
    systemPromptIdsJson: data.systemPromptIdsJson,
    customHeaderSchemeId: data.customHeaderSchemeId,
    configJson,
    source,
  };
}
