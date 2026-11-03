/**
 * 决策模型（Decision model）：TypeSafe System One / OpenAI Decisions 一类的
 * 「判定型」模型，不生成文本，只对给定状态逐条给出选择。
 *
 * 真源是 Rust 侧的 decision_models 表（model_registry），通过
 * window.snow.listDecisionModels / upsertDecisionModel 读写。代码库、decision-evaluate
 * 工具与敏感命令辅助只保存选中的模型 id；删除模型时 Rust 同步清空这些引用。
 */
import type { DecisionModelEntry } from "../../preload";

/** decision-evaluate 工具的默认决策模型（值为模型 id，空串表示未设置）。 */
export const DECISION_TOOL_MODEL_SETTING_NAME = "Decision tool model";
export const DECISION_TOOL_MODEL_SETTING_CODE = "decision_tool_model";

export type DecisionModelProvider = "typesafe" | "openai";

export const DECISION_MODEL_PROVIDER_TYPESAFE: DecisionModelProvider =
  "typesafe";
export const DECISION_MODEL_PROVIDER_OPENAI: DecisionModelProvider = "openai";
export const DEFAULT_DECISION_MODEL_PROVIDER: DecisionModelProvider =
  DECISION_MODEL_PROVIDER_TYPESAFE;

/** 官方 TypeSafe System One 端点（Base URL 留空时 Rust 也回落到该地址）。 */
export const DEFAULT_DECISION_MODEL_BASE_URL = "https://api.typesafe.ai/v1";
/** 官方默认模型名。 */
export const DEFAULT_DECISION_MODEL_MODEL = "jev-latest";
/** 新建 TypeSafe 决策模型时的默认名称。 */
export const DEFAULT_DECISION_MODEL_NAME = "Jev (TypeSafe)";

/** 官方 OpenAI Decisions 端点（Base URL 留空时 Rust 也回落到该地址）。 */
export const DEFAULT_OPENAI_DECISION_MODEL_BASE_URL =
  "https://api.openai.com/v1";
/** OpenAI Decisions 默认模型名（仍可自由填写，不设白名单）。 */
export const DEFAULT_OPENAI_DECISION_MODEL_MODEL = "gpt-6-luna";
/** 新建 OpenAI Decisions 决策模型时的默认名称。 */
export const DEFAULT_OPENAI_DECISION_MODEL_NAME = "OpenAI Decisions";

export type DecisionModelBaseUrlMode = "auto" | "custom";

export const DECISION_MODEL_BASE_URL_MODE_AUTO: DecisionModelBaseUrlMode =
  "auto";
export const DECISION_MODEL_BASE_URL_MODE_CUSTOM: DecisionModelBaseUrlMode =
  "custom";
export const DECISION_MODEL_CUSTOM_BASE_URL_EXAMPLE =
  "https://openrouter.ai/api/alpha/decisions";

/** 单个决策模型配置。 */
export type DecisionModelConfig = {
  id: string;
  name: string;
  provider: DecisionModelProvider;
  baseUrl: string;
  baseUrlMode: DecisionModelBaseUrlMode;
  model: string;
  apiKey: string;
  enabled: boolean;
};

const toText = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

/** 生成决策模型 id（时间戳 + 随机后缀，不依赖 crypto）。 */
export const createDecisionModelId = (): string =>
  `dm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const normalizeDecisionModelProvider = (
  value: unknown,
): DecisionModelProvider =>
  toText(value) === DECISION_MODEL_PROVIDER_OPENAI
    ? DECISION_MODEL_PROVIDER_OPENAI
    : DECISION_MODEL_PROVIDER_TYPESAFE;

/** provider 对应的默认 Base URL（新建与切换 provider 时使用）。 */
export const decisionModelDefaultBaseUrl = (
  provider: DecisionModelProvider,
): string =>
  provider === DECISION_MODEL_PROVIDER_OPENAI
    ? DEFAULT_OPENAI_DECISION_MODEL_BASE_URL
    : DEFAULT_DECISION_MODEL_BASE_URL;

/** provider 对应的默认模型名。 */
export const decisionModelDefaultModel = (
  provider: DecisionModelProvider,
): string =>
  provider === DECISION_MODEL_PROVIDER_OPENAI
    ? DEFAULT_OPENAI_DECISION_MODEL_MODEL
    : DEFAULT_DECISION_MODEL_MODEL;

/** provider 对应的新建默认名称。 */
export const decisionModelDefaultName = (
  provider: DecisionModelProvider,
): string =>
  provider === DECISION_MODEL_PROVIDER_OPENAI
    ? DEFAULT_OPENAI_DECISION_MODEL_NAME
    : DEFAULT_DECISION_MODEL_NAME;

/** 新建决策模型的默认值（按 provider 预填端点与模型名）。 */
export const createDecisionModel = (
  provider: DecisionModelProvider = DEFAULT_DECISION_MODEL_PROVIDER,
  name = decisionModelDefaultName(provider),
): DecisionModelConfig => ({
  id: createDecisionModelId(),
  name,
  provider,
  baseUrl: decisionModelDefaultBaseUrl(provider),
  baseUrlMode: DECISION_MODEL_BASE_URL_MODE_AUTO,
  model: decisionModelDefaultModel(provider),
  apiKey: "",
  enabled: true,
});

export const normalizeDecisionModelBaseUrlMode = (
  value: unknown,
): DecisionModelBaseUrlMode =>
  toText(value) === DECISION_MODEL_BASE_URL_MODE_CUSTOM
    ? DECISION_MODEL_BASE_URL_MODE_CUSTOM
    : DECISION_MODEL_BASE_URL_MODE_AUTO;

/** 表记录 -> 前端配置（收窄 provider / baseUrlMode）。 */
export const toDecisionModelConfig = (
  entry: DecisionModelEntry,
): DecisionModelConfig => ({
  id: entry.id,
  name: toText(entry.name) || toText(entry.model),
  provider: normalizeDecisionModelProvider(entry.provider),
  baseUrl: toText(entry.baseUrl),
  baseUrlMode: normalizeDecisionModelBaseUrlMode(entry.baseUrlMode),
  model: toText(entry.model),
  apiKey: entry.apiKey,
  enabled: entry.enabled,
});

/** 读取全部决策模型（decision_models 表）。 */
export const loadDecisionModels = async (): Promise<DecisionModelConfig[]> =>
  (await window.snow.listDecisionModels()).map(toDecisionModelConfig);

/** 实际请求端点；规则与 Rust 侧 resolve_endpoint 逐条一致。 */
export const resolveDecisionModelEndpoint = (
  model: Pick<DecisionModelConfig, "provider" | "baseUrl" | "baseUrlMode">,
): string => {
  const baseUrl = model.baseUrl.trim().replace(/\/+$/, "");

  if (
    normalizeDecisionModelProvider(model.provider) ===
    DECISION_MODEL_PROVIDER_OPENAI
  ) {
    if (!baseUrl) {
      return `${DEFAULT_OPENAI_DECISION_MODEL_BASE_URL}/decisions`;
    }
    if (baseUrl.endsWith("/decisions")) {
      return baseUrl;
    }
    if (baseUrl.endsWith("/v1")) {
      return `${baseUrl}/decisions`;
    }
    return `${baseUrl}/v1/decisions`;
  }

  if (model.baseUrlMode === DECISION_MODEL_BASE_URL_MODE_CUSTOM) {
    return baseUrl;
  }

  if (!baseUrl) {
    return `${DEFAULT_DECISION_MODEL_BASE_URL}/systemone`;
  }

  if (baseUrl.endsWith("/systemone")) {
    return baseUrl;
  }

  if (baseUrl.endsWith("/v1")) {
    return `${baseUrl}/systemone`;
  }

  return `${baseUrl}/v1/systemone`;
};

/** 已启用的决策模型（代码库审查等场景只能选用已启用的模型）。 */
export const enabledDecisionModels = (
  models: DecisionModelConfig[],
): DecisionModelConfig[] => models.filter((model) => model.enabled);

/** 按 id 查找决策模型（不校验启用状态，用于展示）。 */
export const findDecisionModel = (
  models: DecisionModelConfig[],
  id: string,
): DecisionModelConfig | null =>
  models.find((model) => model.id === id) ?? null;
