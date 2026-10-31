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
  /** 列表展示顺序号（越小越靠前），由拖拽 / 上移下移维护。 */
  sortOrder: number;
};

/** OAuth 登录服务商（内置 provider + 插件 provider，后端 listOAuthProviders 返回）。 */
export type OAuthProviderInfo = {
  id: string;
  displayName: string;
  defaultModel: string;
  defaultMaxContextTokens: number;
  /** redirect | manual | device */
  flow: string;
  /** 插件提供的说明与图标（data: / https: URL）。 */
  description?: string;
  icon?: string;
  /** 来源插件 id；内置 provider 为空。 */
  pluginId?: string;
  /** 插件通过 fetch 接管传输层：原生流式、重试与工具归一化不再生效。 */
  takesOverTransport: boolean;
  /** 插件渲染层自定义登录面板入口；为空时使用宿主默认面板。 */
  panelEntry?: string;
  /** 自定义登录面板标题。 */
  panelTitle?: string;
};

/** OAuth 登录会话（回调端口仅登录期间监听本机）。 */
export type OAuthLoginStart = {
  sessionId: string;
  provider: string;
  authUrl: string;
  port: number;
  /** 本机回调端口不可用时为 true，需要用户手动粘贴回调 URL。 */
  manualMode: boolean;
  defaultModel: string;
  flow: string;
  /** 设备码流程的用户码与插件说明。 */
  userCode?: string;
  instructions?: string;
  /** 自定义面板上下文：state / PKCE / 插件会话（JSON 字符串）。 */
  state: string;
  nonce: string;
  redirectUri: string;
  codeChallenge: string;
  codeVerifier: string;
  pluginSession?: string;
};

export type OAuthLoginStatus = {
  provider: string;
  /** pending | success | error | cancelled */
  status: string;
  error?: string;
  profileName?: string;
  displayName?: string;
  email?: string;
  planType?: string;
  availableModels: string[];
  authUrl: string;
  manualMode: boolean;
  flow: string;
  userCode?: string;
  instructions?: string;
};

/** 订阅配额单项；remainingPercent 为 0-100 的剩余百分比。 */
export type OAuthQuotaBucket = {
  key: string;
  label: string;
  remainingPercent?: number | null;
  resetAtMs?: number | null;
};

export type OAuthQuotaGroup = {
  id: string;
  label: string;
  buckets: OAuthQuotaBucket[];
};

export type OAuthQuotaSnapshot = {
  provider: string;
  plan?: string | null;
  groups: OAuthQuotaGroup[];
  fetchedAtMs: number;
};

export type ImportSnowCliApiConfigsResult = {
  importedCount: number;
  configs: ApiConfigRecord[];
};

/** 导入文件预览中的单条配置（不含密钥，仅用于同名冲突确认）。 */
export type ApiConfigImportPreviewItem = {
  profileName: string;
  displayName: string;
  baseUrl: string;
  requestMethod: string;
  advancedModel: string;
};

export type ApiConfigImportPreview = {
  profiles: ApiConfigImportPreviewItem[];
  /** 文件中无法识别而被忽略的条目数。 */
  skippedCount: number;
};

export type ApiConfigImportOutcome = {
  importedCount: number;
  /** 覆盖了同名既有配置的数量。 */
  overwrittenCount: number;
  /** 因同名而另存为新副本的数量。 */
  renamedCount: number;
  skippedCount: number;
  /** 导入后按文件中的激活标记切换了启用配置时，返回该配置名。 */
  activatedProfileName?: string | null;
};

export type ApiConfigExportFileResult = {
  canceled: boolean;
  filePath: string;
  exportedCount: number;
};

export type ApiConfigImportPickResult = {
  canceled: boolean;
  filePath: string;
  preview: ApiConfigImportPreview | null;
};

export type ApiConfigImportApplyResult = {
  outcome: ApiConfigImportOutcome;
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
  /** 渠道的原始 configJson：OAuth 渠道（codex 等）据此走订阅账号的模型列表接口。 */
  configJson?: string;
  /** 已保存档案的名称：OAuth 档案据此由主进程读取库内最新 token（不信任渲染层快照）。 */
  profileName?: string;
};
export type ResponsesApiMessage = {
  role: "user" | "assistant" | "system" | "developer" | "tool";
  content: string;
  toolResultsJson?: string;
  /** Serialized assistant tool calls, replayed by stateless tool loops. */
  toolCallsJson?: string;
};

export type ResponsesApiRequest = {
  messages: ResponsesApiMessage[];
  model?: string | null;
  apiProfile?: string | null;
  conversationId?: string | null;
  previousResponseId?: string | null;
  directoryId?: string | null;
  /** Request-local analysis root; never changes configuration/authorization scope. */
  analysisWorkspaceRoot?: string | null;
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
  goalMode?: boolean | null;
  worktreeMode?: boolean | null;
  workflowMode?: boolean | null;
  /** Explicit effective workspace execution root (e.g. worktree directory path). */
  executionWorkspaceRoot?: string | null;
  /** Selected or preselected worktree ID for the conversation. */
  worktreeId?: string | null;
  /** Per-request thinking strength override ("none" | "low" | "medium" |
   *  "high" | custom). Applied in-memory over the resolved profile's
   *  config_json; never mutates the stored profile. */
  thinkingStrength?: string | null;
  /** Per-request Responses Fast Mode tier ("off" | "fast" | "ultrafast");
   *  null/omitted follows the profile default. */
  responsesFastMode?: string | null;
  /** Request-scoped MCP tool whitelist (JSON array of full tool names). */
  allowedToolsJson?: string | null;
};

/**
 * 后端 `ResponsesApiResult.status` 的已知取值（各 provider 共用同一套字符串
 * 约定：chat / anthropic / gemini / interactions / responses）。
 *
 * 判定入口见 renderer 的 `responseDisposition.ts`：`completed` 才可能是「正常
 * 收尾但零载荷」（empty_response）；`cancelled` 是用户主动停止，静默收尾；
 * `failed` / `error` 走错误分支；`incomplete` / `length` / `max_tokens` 是未
 * 完成；未列出的取值不再被静默当作「正常完成」——零载荷时按未完成兜底提示。
 */
export type ResponseStatus =
  | "completed"
  | "failed"
  | "cancelled"
  | "canceled"
  | "incomplete"
  | "length"
  | "max_tokens"
  | "in_progress";

export type StreamInterruptionReason =
  | "unexpected_eof"
  | "read_error"
  | "idle_timeout"
  | "explicit_incomplete"
  | "output_limit"
  | "empty_response";

export type StreamRecoveryOutcome =
  "partial_threshold" | "retry_exhausted" | "non_retriable";

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
  /** 已知取值见 `ResponseStatus`；`(string & {})` 保留对未知取值的容错，
   *  由前端判定层兜底而不是静默当成成功。 */
  status: ResponseStatus | (string & {});
  toolCallsJson: string;
  tokenUsage: TokenUsage;
  persistedUserMessageIds: string[];
  /** 本次落库的助手消息 id（未落库为空串）。 */
  persistedAssistantMessageId?: string;
  interruptionReason?: StreamInterruptionReason | null;
  recoveryOutcome?: StreamRecoveryOutcome | null;
  /** 失败终态时上游给出的（已脱敏）原因 */
  failureReason?: string | null;
};

/** 业务逻辑直接生成的一次工具调用交换（不请求模型），返回值与模型响应同构。 */
export type ManualToolExchangeRequest = {
  /** 为空时新建会话 */
  conversationId?: string;
  directoryId?: string;
  model?: string;
  apiProfile?: string;
  checkpointId?: string;
  messages: {
    role: "user" | "tool";
    content: string;
    toolResultsJson?: string;
  }[];
  toolCalls: { name: string; argumentsJson: string }[];
};

export type ResponsesApiStreamChunk = {
  contentDelta: string;
  thinkingDelta: string;
  content: string;
  thinking: string;
  retrying: boolean;
  retryAttempt?: number | null;
  retryError?: string | null;
  /** 本次重试前的退避时长（毫秒）。仅重试分片携带，供前端渲染倒计时。 */
  retryBackoffMs?: number | null;
  streamTokenCount: number;
  /** Cumulative thinking-only token count for the current iteration
   *  (subset of streamTokenCount). 0 while no thinking has streamed. */
  thinkingTokenCount: number;
  /** Milliseconds between the first and the most recent thinking delta of
   *  the current iteration. 0 while no thinking has streamed. */
  thinkingDurationMs: number;
  elapsedMs: number;
  ttftMs: number;
  /** External-vision textify progress event. Present only while the backend
   *  describes user images with the external vision model; payload is a JSON
   *  string like {"phase":"describing","index":1,"total":2,"model":"..."}.
   *  The renderer shows an intermediate status card for it. */
  visionStatus?: string;
};
