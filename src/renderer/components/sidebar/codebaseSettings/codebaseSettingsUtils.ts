import type { CodebaseSettingsInput } from "../../../../preload";
import { DEFAULT_CODEBASE_SETTINGS } from "./codebaseSettingsConstants";
import type { CodebaseSettingsForm } from "./types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const toText = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

const toBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

const toPositiveInteger = (value: unknown, fallback: number): number => {
  const parsed =
    typeof value === "number"
      ? value
      : Number.parseInt(String(value ?? ""), 10);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

/** 嵌入维度：空输入存为 0，表示不传递 dimensions 参数。 */
const toEmbeddingDimensions = (value: unknown, fallback: number): number => {
  if (value === "") {
    return 0;
  }

  const parsed =
    typeof value === "number"
      ? value
      : Number.parseInt(String(value ?? ""), 10);

  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
};

const toNonNegativeInteger = (value: unknown, fallback: number): number => {
  const parsed =
    typeof value === "number"
      ? value
      : Number.parseInt(String(value ?? ""), 10);

  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
};

/** 相关性阈值：接受数字或数字字符串，越界/空值按「未设置」处理。 */
const toRelevanceThreshold = (value: unknown): number | null => {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;

  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : null;
};

/**
 * 旧版 codebase 设置把 TypeSafe 的 baseUrl / apiKey / model 内联保存；现在这些配置统一放在
 * 决策模型里（见 constants/decisionModels.ts），这里读出旧值供一次性迁移使用。
 * 返回 null 表示没有可迁移的旧配置（未填写密钥或已迁移完成）。
 */
export const readLegacyDecisionModel = (
  value: string | null,
): { baseUrl: string; apiKey: string; model: string } | null => {
  if (!value) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) {
      return null;
    }

    const apiKey = toText(parsed.jevApiKey).trim();
    if (!apiKey) {
      return null;
    }

    return {
      baseUrl: toText(parsed.jevBaseUrl).trim(),
      apiKey,
      model: toText(parsed.jevModel).trim(),
    };
  } catch {
    return null;
  }
};

export const readCodebaseSettingsJson = (
  value: string | null,
): CodebaseSettingsInput => {
  if (!value) {
    return normalizeCodebaseSettings(null);
  }

  try {
    return normalizeCodebaseSettings(JSON.parse(value));
  } catch {
    return normalizeCodebaseSettings(null);
  }
};

export const normalizeCodebaseSettings = (
  value: unknown,
): CodebaseSettingsInput => {
  const source = isRecord(value) ? value : {};
  const profileName = toText(
    source.profileName,
    DEFAULT_CODEBASE_SETTINGS.profileName,
  ).trim();
  const embeddingType = toText(
    source.embeddingType,
    DEFAULT_CODEBASE_SETTINGS.embeddingType,
  ).trim();
  const sourceLabel = toText(
    source.source,
    DEFAULT_CODEBASE_SETTINGS.source,
  ).trim();

  return {
    profileName: profileName || DEFAULT_CODEBASE_SETTINGS.profileName,
    embeddingType: embeddingType || DEFAULT_CODEBASE_SETTINGS.embeddingType,
    embeddingModelName: toText(
      source.embeddingModelName,
      DEFAULT_CODEBASE_SETTINGS.embeddingModelName,
    ).trim(),
    embeddingBaseUrl: toText(
      source.embeddingBaseUrl,
      DEFAULT_CODEBASE_SETTINGS.embeddingBaseUrl,
    ).trim(),
    embeddingApiKey: toText(
      source.embeddingApiKey,
      DEFAULT_CODEBASE_SETTINGS.embeddingApiKey,
    ),
    embeddingDimensions: toEmbeddingDimensions(
      source.embeddingDimensions,
      DEFAULT_CODEBASE_SETTINGS.embeddingDimensions,
    ),
    batchMaxLines: toPositiveInteger(
      source.batchMaxLines,
      DEFAULT_CODEBASE_SETTINGS.batchMaxLines,
    ),
    batchConcurrency: toPositiveInteger(
      source.batchConcurrency,
      DEFAULT_CODEBASE_SETTINGS.batchConcurrency,
    ),
    chunkingMaxLinesPerChunk: toPositiveInteger(
      source.chunkingMaxLinesPerChunk,
      DEFAULT_CODEBASE_SETTINGS.chunkingMaxLinesPerChunk,
    ),
    chunkingMinLinesPerChunk: toPositiveInteger(
      source.chunkingMinLinesPerChunk,
      DEFAULT_CODEBASE_SETTINGS.chunkingMinLinesPerChunk,
    ),
    chunkingMinCharsPerChunk: toPositiveInteger(
      source.chunkingMinCharsPerChunk,
      DEFAULT_CODEBASE_SETTINGS.chunkingMinCharsPerChunk,
    ),
    chunkingOverlapLines: toNonNegativeInteger(
      source.chunkingOverlapLines,
      DEFAULT_CODEBASE_SETTINGS.chunkingOverlapLines,
    ),
    modelContextLength: toPositiveInteger(
      source.modelContextLength,
      DEFAULT_CODEBASE_SETTINGS.modelContextLength,
    ),
    rerankingModelName: toText(source.rerankingModelName).trim(),
    rerankingBaseUrl: toText(source.rerankingBaseUrl).trim(),
    rerankingApiKey: toText(source.rerankingApiKey),
    rerankingContextLength: toPositiveInteger(
      source.rerankingContextLength,
      DEFAULT_CODEBASE_SETTINGS.rerankingContextLength,
    ),
    rerankingTopN: toPositiveInteger(
      source.rerankingTopN,
      DEFAULT_CODEBASE_SETTINGS.rerankingTopN,
    ),
    agentReviewModelId: toText(source.agentReviewModelId).trim(),
    agentReviewRelevanceThreshold: toRelevanceThreshold(
      source.agentReviewRelevanceThreshold,
    ),
    configJson: toText(source.configJson, DEFAULT_CODEBASE_SETTINGS.configJson),
    source: sourceLabel || DEFAULT_CODEBASE_SETTINGS.source,
  };
};

export const toCodebaseForm = (
  settings: CodebaseSettingsInput,
): CodebaseSettingsForm => ({
  profileName: settings.profileName,
  embeddingType: settings.embeddingType,
  embeddingModelName: settings.embeddingModelName,
  embeddingBaseUrl: settings.embeddingBaseUrl,
  embeddingApiKey: settings.embeddingApiKey,
  embeddingDimensions:
    settings.embeddingDimensions > 0
      ? String(settings.embeddingDimensions)
      : "",
  batchMaxLines: String(settings.batchMaxLines),
  batchConcurrency: String(settings.batchConcurrency),
  chunkingMaxLinesPerChunk: String(settings.chunkingMaxLinesPerChunk),
  chunkingMinLinesPerChunk: String(settings.chunkingMinLinesPerChunk),
  chunkingMinCharsPerChunk: String(settings.chunkingMinCharsPerChunk),
  chunkingOverlapLines: String(settings.chunkingOverlapLines),
  modelContextLength: String(settings.modelContextLength),
  rerankingModelName: settings.rerankingModelName,
  rerankingBaseUrl: settings.rerankingBaseUrl,
  rerankingApiKey: settings.rerankingApiKey,
  rerankingContextLength: String(settings.rerankingContextLength),
  rerankingTopN: String(settings.rerankingTopN),
  agentReviewModelId: settings.agentReviewModelId,
  agentReviewRelevanceThreshold:
    settings.agentReviewRelevanceThreshold === null
      ? ""
      : String(settings.agentReviewRelevanceThreshold),
});

export const toSnowCliCodebaseConfigJson = (
  settings: CodebaseSettingsInput,
): string =>
  JSON.stringify({
    codebase: {
      embedding: {
        type: settings.embeddingType,
        modelName: settings.embeddingModelName,
        baseUrl: settings.embeddingBaseUrl,
        apiKey: settings.embeddingApiKey,
        dimensions:
          settings.embeddingDimensions > 0
            ? settings.embeddingDimensions
            : undefined,
      },
      batch: {
        maxLines: settings.batchMaxLines,
        concurrency: settings.batchConcurrency,
      },
      chunking: {
        maxLinesPerChunk: settings.chunkingMaxLinesPerChunk,
        minLinesPerChunk: settings.chunkingMinLinesPerChunk,
        minCharsPerChunk: settings.chunkingMinCharsPerChunk,
        overlapLines: settings.chunkingOverlapLines,
        modelContextLength: settings.modelContextLength,
      },
      reranking: {
        modelName: settings.rerankingModelName,
        baseUrl: settings.rerankingBaseUrl,
        apiKey: settings.rerankingApiKey,
        contextLength: settings.rerankingContextLength,
        topN: settings.rerankingTopN,
      },
    },
  });

export const toCodebaseSettings = (
  form: CodebaseSettingsForm,
): CodebaseSettingsInput => {
  const settings = normalizeCodebaseSettings({
    ...form,
    source: "manual",
  });

  return {
    ...settings,
    configJson: toSnowCliCodebaseConfigJson(settings),
  };
};
