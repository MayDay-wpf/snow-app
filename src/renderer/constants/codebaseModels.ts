/**
 * 嵌入 / 重排模型：全局多模型配置，代码库设置只保存选中的模型 id。
 *
 * 真源是 Rust 侧的 embedding_models / reranking_models 表（model_registry），
 * 通过 window.snow.list*Models / upsert*Models 读写；索引 / 检索时 Rust 把选中的
 * 模型展开为运行时配置。
 */
import type { EmbeddingModelConfig, RerankingModelConfig } from "../../preload";

export type { EmbeddingModelConfig, RerankingModelConfig };

export const DEFAULT_EMBEDDING_TYPE = "jina";
export const DEFAULT_EMBEDDING_CONTEXT_LENGTH = 8192;
export const DEFAULT_RERANKING_CONTEXT_LENGTH = 4096;

export const EMBEDDING_TYPE_OPTIONS = [
  { value: "jina", label: "Jina & OpenAI" },
  { value: "ollama", label: "Ollama" },
  { value: "gemini", label: "Gemini" },
  { value: "mistral", label: "Mistral" },
];

export const embeddingTypeLabel = (value: string): string =>
  EMBEDDING_TYPE_OPTIONS.find((option) => option.value === value)?.label ??
  value;

const createModelId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const createEmbeddingModel = (): EmbeddingModelConfig => ({
  id: createModelId("em"),
  name: "",
  embeddingType: DEFAULT_EMBEDDING_TYPE,
  modelName: "",
  baseUrl: "",
  apiKey: "",
  dimensions: 0,
  contextLength: DEFAULT_EMBEDDING_CONTEXT_LENGTH,
  enabled: true,
});

export const createRerankingModel = (): RerankingModelConfig => ({
  id: createModelId("rm"),
  name: "",
  modelName: "",
  baseUrl: "",
  apiKey: "",
  contextLength: DEFAULT_RERANKING_CONTEXT_LENGTH,
  enabled: true,
});

type ModelWithState = { id: string; enabled: boolean };

/** 已启用的模型（代码库设置只能选用已启用的模型）。 */
export const enabledModels = <T extends ModelWithState>(models: T[]): T[] =>
  models.filter((model) => model.enabled);

/** 按 id 查找模型（不校验启用状态，用于展示）。 */
export const findModelById = <T extends ModelWithState>(
  models: T[],
  id: string,
): T | null => models.find((model) => model.id === id) ?? null;
