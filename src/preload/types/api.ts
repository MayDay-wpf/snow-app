export type ApiConfigInput = {
  profileName: string;
  /** 编辑重命名时传原配置名;新建/未改名时不传。 */
  previousProfileName?: string;
  displayName: string;
  isActive: boolean;
  baseUrl: string;
  baseUrlMode: string;
  apiKey: string;
  requestMethod: string;
  advancedModel: string;
  basicModel: string;
  supportsVision: boolean;
  visionBaseUrl: string;
  visionBaseUrlMode: string;
  visionApiKey: string;
  visionRequestMethod: string;
  visionModel: string;
  maxContextTokens?: number | null;
  maxTokens?: number | null;
  streamIdleTimeoutSec?: number | null;
  enableAutoCompress: boolean;
  autoCompressThreshold?: number | null;
  maxRetries?: number | null;
  retryBaseDelayMs?: number | null;
  partialRetryMaxChars?: number | null;
  systemPromptIdsJson: string;
  customHeaderSchemeId: string;
  configJson: string;
  source: string;
};

export type ApiConfigRecord = ApiConfigInput & {
  id: string;
  updatedAt: string;
};

export type ImportSnowCliApiConfigsResult = {
  importedCount: number;
  configs: ApiConfigRecord[];
};

export type Model = {
  id: string;
  object: string;
  created: number;
  ownedBy: string;
};

export type ApiModelsConfig = {
  baseUrl: string;
  baseUrlMode: string;
  apiKey: string;
  requestMethod: string;
  customHeaderSchemeId: string;
};
export type ResponsesApiMessage = {
  role: "user" | "assistant" | "system" | "developer" | "tool";
  content: string;
  toolResultsJson?: string;
};

export type ResponsesApiRequest = {
  messages: ResponsesApiMessage[];
  model?: string | null;
  apiProfile?: string | null;
  conversationId?: string | null;
  previousResponseId?: string | null;
  directoryId?: string | null;
  checkpointId?: string | null;
  contextCompaction?: boolean | null;
  /**
   * Internal auto-compaction resume mode: the compaction handoff is already
   * persisted as the latest `context_compaction` boundary, so `messages` is a
   * placeholder that must not be re-injected into the payload nor persisted
   * as normal user messages.
   */
  resumeAfterCompaction?: boolean | null;
  subAgentToolsJson?: string | null;
  subAgentSystemPrompt?: string | null;
  subAgentConfigProfile?: string | null;
  skipContext?: boolean | null;
  /** Preserve normal conversation context but omit MCP tools for this request. */
  disableTools?: boolean | null;
  /**
   * Request-local instruction used for internal recovery. It is included with
   * provider system instructions, never persisted as a conversation message.
   */
  internalRecoveryPrompt?: string | null;
  planMode?: boolean | null;
  goalMode?: boolean | null;
  worktreeMode?: boolean | null;
  /** Per-request thinking strength override ("none" | "low" | "medium" |
   *  "high" | custom). Applied in-memory over the resolved profile's
   *  config_json; never mutates the stored profile. */
  thinkingStrength?: string | null;
  /** Per-request Responses Fast Mode override; null/omitted follows the profile default. */
  responsesFastMode?: boolean | null;
};

export type StreamInterruptionReason =
  | "unexpected_eof"
  | "read_error"
  | "idle_timeout"
  | "explicit_incomplete"
  | "output_limit";

export type StreamRecoveryOutcome =
  | "partial_threshold"
  | "retry_exhausted"
  | "non_retriable";

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
};

export type ResponsesApiResult = {
  id: string;
  conversationId: string;
  content: string;
  thinking: string;
  model: string;
  status: string;
  toolCallsJson: string;
  tokenUsage: TokenUsage;
  persistedUserMessageIds: string[];
  interruptionReason?: StreamInterruptionReason | null;
  recoveryOutcome?: StreamRecoveryOutcome | null;
};

export type ResponsesApiStreamChunk = {
  contentDelta: string;
  thinkingDelta: string;
  content: string;
  thinking: string;
  retrying: boolean;
  retryAttempt?: number | null;
  retryError?: string | null;
  streamTokenCount: number;
  elapsedMs: number;
  ttftMs: number;
  /** External-vision textify progress event. Present only while the backend
   *  describes user images with the external vision model; payload is a JSON
   *  string like {"phase":"describing","index":1,"total":2,"model":"..."}.
   *  The renderer shows an intermediate status card for it. */
  visionStatus?: string;
};
