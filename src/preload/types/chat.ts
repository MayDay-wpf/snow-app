import type {
  MessageOrigin,
  StreamInterruptionReason,
  StreamRecoveryOutcome,
} from "./api";

export type ChatConversationRecord = {
  conversationId: string;
  title: string;
  summary: string;
  lastMessagePreview: string;
  messageCount: number;
  model: string;
  apiProfileName: string;
  status: string;
  directoryId: string;
  forkedFromConversationId: string;
  forkMessageCount: number;
  conversationType: string;
  parentConversationId: string;
  subAgentId: string;
  subAgentName: string;
  subAgentStatus: string;
  subAgentError: string;
  createdAt: string;
  updatedAt: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  totalDurationMs: number;
  /** 最近一次 AI run 的累计用量与墙钟总耗时（run 摘要条回显用）。 */
  runInputTokens: number;
  runOutputTokens: number;
  runCacheCreationInputTokens: number;
  runCacheReadInputTokens: number;
  lastRunDurationMs: number;
  /** 会话累计 TTFT 总和（ms）与产生 TTFT 的请求数。 */
  runTtftSumMs: number;
  runRequestCount: number;
};

export type ChatConversationPage = {
  items: ChatConversationRecord[];
  total: number;
};

export type ConversationSearchResult = {
  conversationId: string;
  title: string;
  summary: string;
  lastMessagePreview: string;
  messageCount: number;
  model: string;
  status: string;
  directoryId: string;
  forkedFromConversationId: string;
  forkMessageCount: number;
  createdAt: string;
  updatedAt: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  matchedContent: string;
};

export type ChatMessageRecord = {
  id: string;
  role: string;
  origin: MessageOrigin;
  content: string;
  thinking: string;
  /** Thinking-phase duration (ms) recorded for this assistant message. */
  thinkingDurationMs: number;
  /** Thinking-only token count recorded for this assistant message. */
  thinkingTokenCount: number;
  status: string;
  model: string;
  responseId: string;
  checkpointId: string;
  toolCallsJson: string;
  /** 按工具调用 id 索引的纠错状态 JSON（`{}` 表示没有纠错记录），用于
   *  重启后重建纠错树。 */
  toolCorrectionsJson: string;
  interruptionReason?: StreamInterruptionReason | null;
  recoveryOutcome?: StreamRecoveryOutcome | null;
  /** Redacted provider diagnostic, separate from generated content. */
  failureReason?: string | null;
  /** Token usage of the API request that produced this assistant message
   *  (zero for user/tool rows and rows persisted before schema v46). */
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  /** 自动重试次数（0 表示未重试）。空响应重试耗尽时据此在重载后仍显示
   *  「重试已耗尽 (N)」。 */
  retryAttempts: number;
  /** 最后一次自动重试的上游错误文本（未重试为空串）。 */
  retryError: string;
  createdAt: string;
};

export type ChatMessagePage = {
  items: ChatMessageRecord[];
  total: number;
  hasMore: boolean;
  checkpointIds: string[];
};

export type UserMessageSummary = {
  id: string;
  content: string;
  createdAt: string;
  isContextCompaction: boolean;
};

/** 单个导入文件的处理进度。 */
export type ConversationImportProgress = {
  processed: number;
  total: number;
  fileName: string;
  success: boolean;
  error: string | null;
};

export type ImportedConversationSummary = {
  conversationId: string;
  title: string;
  messageCount: number;
};

export type ConversationImportFileResult = {
  filePath: string;
  success: boolean;
  error: string | null;
  conversations: ImportedConversationSummary[];
};

export type ConversationImportSummary = {
  total: number;
  importedCount: number;
  failedCount: number;
  results: ConversationImportFileResult[];
};

/** 工具执行失败后交给基础模型纠错的请求。 */
export type ToolCorrectionRequest = {
  toolName: string;
  toolDescription: string;
  inputSchemaJson: string;
  originalArgumentsJson: string;
  failure: string;
  /** JSON 数组：[{ argumentsJson, error }] */
  attemptsJson: string;
  /** 1 起的本次纠错序号。 */
  attempt: number;
  /** 会话绑定的 API 档案；省略时使用全局激活档案。 */
  apiProfile?: string;
  /** 所属会话 ID，用于展开 {{session_id}} 自定义请求头。 */
  conversationId?: string;
};

/** 基础模型返回的纠正参数（不直接执行）。 */
export type ToolCorrectionResponse = {
  retry: boolean;
  argumentsJson: string;
  reasoning: string;
};

/** 回复预测请求：requestId 用于取消。 */
export type ReplyPredictionRequest = {
  requestId: string;
  conversationId: string;
  apiProfile?: string;
};

/** content 为空表示无可用预测。 */
export type ReplyPredictionResult = {
  content: string;
};
