import type { CodebaseSettingsInput } from "../../../../preload";
import { DEFAULT_CODEBASE_SETTINGS } from "./codebaseSettingsConstants";
import type { CodebaseSettingsForm } from "./types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const toText = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

const toPositiveInteger = (value: unknown, fallback: number): number => {
  const parsed =
    typeof value === "number"
      ? value
      : Number.parseInt(String(value ?? ""), 10);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
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
  const sourceLabel = toText(
    source.source,
    DEFAULT_CODEBASE_SETTINGS.source,
  ).trim();

  return {
    profileName: profileName || DEFAULT_CODEBASE_SETTINGS.profileName,
    embeddingModelId: toText(source.embeddingModelId).trim(),
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
    rerankingModelId: toText(source.rerankingModelId).trim(),
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
  embeddingModelId: settings.embeddingModelId,
  batchMaxLines: String(settings.batchMaxLines),
  batchConcurrency: String(settings.batchConcurrency),
  chunkingMaxLinesPerChunk: String(settings.chunkingMaxLinesPerChunk),
  chunkingMinLinesPerChunk: String(settings.chunkingMinLinesPerChunk),
  chunkingMinCharsPerChunk: String(settings.chunkingMinCharsPerChunk),
  chunkingOverlapLines: String(settings.chunkingOverlapLines),
  rerankingModelId: settings.rerankingModelId,
  rerankingTopN: String(settings.rerankingTopN),
  agentReviewModelId: settings.agentReviewModelId,
  agentReviewRelevanceThreshold:
    settings.agentReviewRelevanceThreshold === null
      ? ""
      : String(settings.agentReviewRelevanceThreshold),
});

/** Snow CLI 结构的非模型参数快照（模型配置已迁到全局模型列表）。 */
const toSnowCliCodebaseConfigJson = (settings: CodebaseSettingsInput): string =>
  JSON.stringify({
    codebase: {
      batch: {
        maxLines: settings.batchMaxLines,
        concurrency: settings.batchConcurrency,
      },
      chunking: {
        maxLinesPerChunk: settings.chunkingMaxLinesPerChunk,
        minLinesPerChunk: settings.chunkingMinLinesPerChunk,
        minCharsPerChunk: settings.chunkingMinCharsPerChunk,
        overlapLines: settings.chunkingOverlapLines,
      },
      reranking: {
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
