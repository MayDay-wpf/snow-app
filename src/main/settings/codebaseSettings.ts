import type { CodebaseSettingsInput, NativeBridge } from "../native/types";
import {
  SNOW_CLI_GLOBAL_SETTINGS_FILE,
  SNOW_CLI_PROJECT_SETTINGS_FILE,
} from "../snowCli/paths";
import { readJsonFile } from "../utils/jsonFile";
import { isRecord, toPositiveInteger, toText } from "../utils/value";

const CODEBASE_SETTING_NAME = "Codebase settings";
const CODEBASE_SETTING_CODE = "codebase_settings";

const DEFAULT_CODEBASE_SETTINGS: CodebaseSettingsInput = {
  profileName: "default",
  embeddingType: "jina",
  embeddingModelName: "text-embedding-3-small",
  embeddingBaseUrl: "https://api.openai.com/v1",
  embeddingApiKey: "",
  embeddingDimensions: 1536,
  batchMaxLines: 10,
  batchConcurrency: 3,
  chunkingMaxLinesPerChunk: 200,
  chunkingMinLinesPerChunk: 10,
  chunkingMinCharsPerChunk: 20,
  chunkingOverlapLines: 20,
  modelContextLength: 8192,
  rerankingModelName: "",
  rerankingBaseUrl: "",
  rerankingApiKey: "",
  rerankingContextLength: 4096,
  rerankingTopN: 5,
  agentReviewModelId: "",
  agentReviewRelevanceThreshold: null,
  configJson: "{}",
  source: "manual",
};

const getCodebaseObject = (
  settings: Record<string, unknown> | null,
): Record<string, unknown> => {
  const codebase = settings?.codebase;
  return isRecord(codebase) ? codebase : {};
};

/** 嵌入维度：空字符串存为 0，表示不传递 dimensions 参数。 */
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
      DEFAULT_CODEBASE_SETTINGS.embeddingDimensions ?? 1536,
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
    chunkingOverlapLines: toPositiveInteger(
      source.chunkingOverlapLines,
      DEFAULT_CODEBASE_SETTINGS.chunkingOverlapLines,
    ),
    modelContextLength: toPositiveInteger(
      source.modelContextLength,
      DEFAULT_CODEBASE_SETTINGS.modelContextLength ?? 8192,
    ),
    rerankingModelName: toText(source.rerankingModelName).trim(),
    rerankingBaseUrl: toText(source.rerankingBaseUrl).trim(),
    rerankingApiKey: toText(source.rerankingApiKey),
    rerankingContextLength: toPositiveInteger(
      source.rerankingContextLength,
      DEFAULT_CODEBASE_SETTINGS.rerankingContextLength ?? 4096,
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

/** 读取已保存的 codebase 设置：用于导入时保留 Snow CLI 未覆盖的字段。 */
const readStoredAgentReviewModelId = (raw: string | null): string => {
  if (!raw) {
    return "";
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? toText(parsed.agentReviewModelId).trim() : "";
  } catch {
    return "";
  }
};

const readStoredRelevanceThreshold = (raw: string | null): number | null => {
  if (!raw) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed)
      ? toRelevanceThreshold(parsed.agentReviewRelevanceThreshold)
      : null;
  } catch {
    return null;
  }
};

export const persistCodebaseSettings = async (
  native: NativeBridge,
  settings: CodebaseSettingsInput,
): Promise<CodebaseSettingsInput> => {
  const normalized = normalizeCodebaseSettings(settings);
  await native.setSystemSetting(
    CODEBASE_SETTING_NAME,
    CODEBASE_SETTING_CODE,
    JSON.stringify(normalized),
  );
  return normalized;
};

export const readSnowCliCodebaseSettings = async (
  native: NativeBridge,
): Promise<CodebaseSettingsInput> => {
  const globalSettings = readJsonFile(SNOW_CLI_GLOBAL_SETTINGS_FILE);
  const projectSettings = readJsonFile(SNOW_CLI_PROJECT_SETTINGS_FILE);
  const globalCodebase = getCodebaseObject(globalSettings);
  const projectCodebase = getCodebaseObject(projectSettings);
  const embedding = isRecord(globalCodebase.embedding)
    ? globalCodebase.embedding
    : {};
  const reranking = isRecord(globalCodebase.reranking)
    ? globalCodebase.reranking
    : {};
  const batch = isRecord(projectCodebase.batch) ? projectCodebase.batch : {};
  const chunking = isRecord(projectCodebase.chunking)
    ? projectCodebase.chunking
    : {};
  const storedRaw = await native.getSystemSettingValue(CODEBASE_SETTING_CODE);
  const config = normalizeCodebaseSettings({
    profileName: "default",
    embeddingType: embedding.type,
    embeddingModelName: embedding.modelName,
    embeddingBaseUrl: embedding.baseUrl,
    embeddingApiKey: embedding.apiKey,
    embeddingDimensions: embedding.dimensions,
    batchMaxLines: batch.maxLines,
    batchConcurrency: batch.concurrency,
    chunkingMaxLinesPerChunk: chunking.maxLinesPerChunk,
    chunkingMinLinesPerChunk: chunking.minLinesPerChunk,
    chunkingMinCharsPerChunk: chunking.minCharsPerChunk,
    chunkingOverlapLines: chunking.overlapLines,
    modelContextLength: chunking.modelContextLength,
    rerankingModelName: reranking.modelName,
    rerankingBaseUrl: reranking.baseUrl,
    rerankingApiKey: reranking.apiKey,
    rerankingContextLength: reranking.contextLength,
    rerankingTopN: reranking.topN,
    // Snow CLI 没有决策模型与阈值的概念：保留当前配置，避免同步后审查策略被重置。
    agentReviewModelId: readStoredAgentReviewModelId(storedRaw),
    agentReviewRelevanceThreshold: readStoredRelevanceThreshold(storedRaw),
    configJson: JSON.stringify({
      global: globalSettings ?? {},
      project: projectSettings ?? {},
    }),
    source: "snow-cli",
  });
  await persistCodebaseSettings(native, config);
  // Rust 写入时已把内联模型字段迁入嵌入/重排模型列表并改存 id，这里回读迁移结果。
  const migrated = await native.getSystemSettingValue(CODEBASE_SETTING_CODE);
  try {
    const parsed: unknown = migrated ? JSON.parse(migrated) : null;
    return isRecord(parsed) ? (parsed as CodebaseSettingsInput) : config;
  } catch {
    return config;
  }
};
