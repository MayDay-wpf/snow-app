import type { CodebaseSettingsInput } from "../../../../preload";

export type CodebaseSettingsForm = {
  profileName: string;
  /** 选中的嵌入模型 id（空 = 未选择）。 */
  embeddingModelId: string;
  batchMaxLines: string;
  batchConcurrency: string;
  chunkingMaxLinesPerChunk: string;
  chunkingMinLinesPerChunk: string;
  chunkingMinCharsPerChunk: string;
  chunkingOverlapLines: string;
  /** 选中的重排模型 id（空 = 不使用重排）。 */
  rerankingModelId: string;
  rerankingTopN: string;
  /** 代理审查选用的决策模型 id（空 = 使用基础 LLM 模型）。 */
  agentReviewModelId: string;
  /** 相关性阈值（0-1 的字符串；空 = 二分类判定）。 */
  agentReviewRelevanceThreshold: string;
};

export type CodebaseSettings = CodebaseSettingsInput;
