export type AppStorageInfo = {
  directoryPath: string;
  databasePath: string;
  archiveDatabasePath: string;
};

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
  maxContextTokens?: number;
  maxTokens?: number;
  streamIdleTimeoutSec?: number;
  enableAutoCompress: boolean;
  autoCompressThreshold?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  partialRetryMaxChars?: number;
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
  overwrittenCount: number;
  renamedCount: number;
  skippedCount: number;
  /** 导入后按文件中的激活标记切换了启用配置时，返回该配置名。 */
  activatedProfileName?: string | null;
};

/** 导出结果：迁移文档文本 + 实际导出条数。 */
export type ApiConfigExportResult = {
  content: string;
  exportedCount: number;
};

export type CodebaseSettingsInput = {
  profileName: string;
  embeddingType: string;
  embeddingModelName: string;
  embeddingBaseUrl: string;
  embeddingApiKey: string;
  embeddingDimensions: number;
  batchMaxLines: number;
  batchConcurrency: number;
  chunkingMaxLinesPerChunk: number;
  chunkingMinLinesPerChunk: number;
  chunkingMinCharsPerChunk: number;
  chunkingOverlapLines: number;
  modelContextLength: number;
  rerankingModelName: string;
  rerankingBaseUrl: string;
  rerankingApiKey: string;
  rerankingContextLength: number;
  rerankingTopN: number;
  /** 代理审查选用的决策模型 id（空 = 使用基础 LLM 模型）；导入 Snow CLI 配置时原样保留。 */
  agentReviewModelId: string;
  configJson: string;
  source: string;
};

export type CodebaseProjectScopeSettings = {
  projectId: string;
  enabled?: boolean;
  enableAgentReview?: boolean;
  enableReranking?: boolean;
};

export type UsageRecord = {
  id: string;
  conversationId: string;
  responseId: string;
  model: string;
  apiProfileName: string;
  apiConfigId: string;
  requestMethod: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  status: string;
  isSubAgent: boolean;
  directoryId: string;
  createdAt: string;
  totalTokens: number;
  effectiveCacheReadTokens: number;
  nonCachedInputTokens: number;
};

export type UsageRecordPage = {
  items: UsageRecord[];
  total: number;
};

export type UsageSummary = {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationInputTokens: number;
  totalCacheReadInputTokens: number;
  totalRequests: number;
  errorRequests: number;
  totalTokens: number;
  effectiveCacheReadTokens: number;
  nonCachedInputTokens: number;
};

export type DailyUsageBreakdown = {
  date: string;
  totalRequests: number;
  errorRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationInputTokens: number;
  totalCacheReadInputTokens: number;
  totalTokens: number;
};

export type ModelUsageBreakdown = {
  model: string;
  totalRequests: number;
  errorRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationInputTokens: number;
  totalCacheReadInputTokens: number;
  totalTokens: number;
};

export type AppLogInput = {
  level: string;
  module: string;
  func: string;
  line?: number;
  message: string;
  input?: string;
  output?: string;
  duration?: string;
  context?: string;
  error?: string;
  source: string;
};

/** Result of running a scheduled-task pre-script in the Rust backend. */
export type PreScriptResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type AppLogRecord = {
  id: string;
  level: string;
  module: string;
  func: string;
  line?: number;
  message: string;
  input: string;
  output: string;
  duration: string;
  context: string;
  error: string;
  source: string;
  createdAt: string;
};

export type AppLogPage = {
  items: AppLogRecord[];
  total: number;
};

export type PrivacyApiConfig = {
  url: string;
  apiKey: string;
  model: string;
};

export type PrivacyToolResultsConfig = {
  tools: string[];
};

export type PrivacySettings = {
  enabled: boolean;
  mode: string;
  api: PrivacyApiConfig;
  toolResults: PrivacyToolResultsConfig;
};

/** Per-conversation Plan/Goal Mode overrides. `null` means the conversation
 *  has never been configured and follows the global default. */
export type ConversationModesResult = {
  planMode: boolean | null;
  goalMode: boolean | null;
  worktreeMode: boolean | null;
  workflowMode: boolean | null;
  goalModeTokenBudget: number | null;
};

export type ConversationRuntimeConfig = {
  thinkingStrength: string | null;
  responsesFastMode: boolean | null;
};

export type WorkflowNodeSessionRecord = {
  conversationId: string;
  parentConversationId: string;
  flowId: string;
  /** Flow 级文件检查点：flow 首节点执行前拍摄，回滚时恢复以撤销节点文件改动。 */
  flowCheckpointId: string;
  nodeId: string;
  nodeName: string;
  runStatus: string;
  errorMessage: string;
  handoffContent: string;
  createdAt: string;
  updatedAt: string;
};

/** WorkFlow run 级状态（父会话 + flow 隔离一行）。跨重启持久化，
 *  支持从最后一个已执行节点恢复执行而非丢失全部进度。 */
export type WorkflowRunRecord = {
  parentConversationId: string;
  flowId: string;
  runStatus: string;
  currentNodeIndex: number;
  lastHandoff: string;
  totalTokens: number;
  flowCheckpointId: string;
  directoryId: string;
  errorMessage: string;
  createdAt: string;
  updatedAt: string;
};

/** WorkFlow 画布持久化记录（替代 localStorage）。 */
export type WorkflowCanvasRecord = {
  parentConversationId: string;
  interactionId: string;
  canvasJson: string;
  updatedAt: string;
};

/** Rust 端图校验结果（拓扑收敛的唯一实现）。 */
export type WorkflowGraphValidationResult = {
  order: string[];
  errors: string[];
};
export type ThemeMode = "system" | "light" | "dark";

export type ThemePalette = {
  bgPrimary: string;
  bgSecondary: string;
  bgTertiary: string;
  bgHover: string;
  bgActive: string;
  chromeBg: string;
  appBg: string;
  borderColor: string;
  borderLight: string;
  borderSubtle: string;
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  textMuted: string;
  accentGreen: string;
  accentGreenBg: string;
  accentGreenText: string;
  accentRed: string;
  accentRedBg: string;
  accentRedText: string;
  accentBlue: string;
  accentBlueBg: string;
  accentBlueText: string;
  onSolid: string;
  selectionBg: string;
  focusRing: string;
};

export type CustomTheme = {
  light: ThemePalette;
  dark: ThemePalette;
};

export type ThemeBackground = {
  enabled: boolean;
  imagePath: string;
  opacity: number;
  blur: number;
};

export type ThemeSettings = {
  mode: ThemeMode;
  presetId: string;
  custom: CustomTheme;
  background: ThemeBackground;
};

export type KeyboardShortcutConfig = {
  key: string;
  enabled: boolean;
  foregroundOnly: boolean;
};

export type KeyboardShortcutsSettings = {
  cancelSession: KeyboardShortcutConfig;
  openSearch: KeyboardShortcutConfig;
  openMemo: KeyboardShortcutConfig;
  openTodo: KeyboardShortcutConfig;
  cycleProject: KeyboardShortcutConfig;
  openProjectExplorer: KeyboardShortcutConfig;
  openProjectMemory: KeyboardShortcutConfig;
  openScheduledTasks: KeyboardShortcutConfig;
  openPlugins: KeyboardShortcutConfig;
  cycleApiProfile: KeyboardShortcutConfig;
  toggleWindow: KeyboardShortcutConfig;
  togglePet: KeyboardShortcutConfig;
  focusInput: KeyboardShortcutConfig;
  toggleSidebar: KeyboardShortcutConfig;
  toggleRightPanel: KeyboardShortcutConfig;
  newChat: KeyboardShortcutConfig;
  sendMessage: KeyboardShortcutConfig;
  stopGeneration: KeyboardShortcutConfig;
  prevConversation: KeyboardShortcutConfig;
  nextConversation: KeyboardShortcutConfig;
  scrollToTop: KeyboardShortcutConfig;
  scrollToBottom: KeyboardShortcutConfig;
  openSettings: KeyboardShortcutConfig;
  copyLastResponse: KeyboardShortcutConfig;
  toggleRightPanelFullscreen: KeyboardShortcutConfig;
  showShortcutHelp: KeyboardShortcutConfig;
  toggleMessageTime: KeyboardShortcutConfig;
};

export type CodebaseEmbedProgress = {
  phase: string;
  totalFiles: number;
  processedFiles: number;
  totalChunks: number;
  processedChunks: number;
  currentFile: string;
  error: string;
  elapsedMs: number;
};

export type CodebaseIndexStats = {
  totalChunks: number;
  totalFiles: number;
  totalSizeBytes: number;
  isIndexed: boolean;
};

export type CodebaseIndexedFile = {
  relativePath: string;
  filePath: string;
  chunkCount: number;
  startLine: number;
  endLine: number;
  sizeBytes: number;
  updatedAt: string;
};

export type CodebaseIndexedFilePage = {
  items: CodebaseIndexedFile[];
  total: number;
  page: number;
  pageSize: number;
};

export type CodebaseSphereRelatedFile = {
  index: number;
  similarity: number;
};

export type CodebaseSphereNode = {
  index: number;
  relativePath: string;
  chunkCount: number;
  startLine: number;
  endLine: number;
  sizeBytes: number;
  x: number;
  y: number;
  z: number;
  related: CodebaseSphereRelatedFile[];
};

export type CodebaseSphereEdge = {
  a: number;
  b: number;
  similarity: number;
};

export type CodebaseSphereLayout = {
  nodes: CodebaseSphereNode[];
  edges: CodebaseSphereEdge[];
};

export type CodebaseScanPreview = {
  fileCount: number;
  estimatedChunks: number;
  totalSizeBytes: number;
};

export type CodebaseSyncProgress = {
  phase: string;
  filesToEmbed: number;
  processedFiles: number;
  deletedFiles: number;
  skippedFiles: number;
  currentFile: string;
  error: string;
};

export type CodebaseSyncResult = {
  changed: boolean;
  embeddedFiles: number;
  deletedFiles: number;
  skippedFiles: number;
  error: string;
};

export type ResumableCodebaseSession = {
  sessionId: string;
  projectId: string;
  status: string;
  totalFiles: number;
  processedFiles: number;
  totalChunks: number;
  processedChunks: number;
  currentFile: string;
  error: string;
  createdAt: string;
  updatedAt: string;
};

export type SystemPromptItemInput = {
  promptId: string;
  name: string;
  content: string;
  isActive: boolean;
  sortOrder: number;
  scope?: "global" | "project";
  projectId?: string;
};

export type SystemPromptItemRecord = Omit<SystemPromptItemInput, "scope"> & {
  id: string;
  scope: "global" | "project";
  projectId?: string;
  updatedAt: string;
};

export type CustomHeaderSchemeInput = {
  schemeId: string;
  name: string;
  headersJson: string;
  isActive: boolean;
  sortOrder: number;
};

export type CustomHeaderSchemeRecord = CustomHeaderSchemeInput & {
  id: string;
  updatedAt: string;
};

export type CustomCommandScope = "global" | "project";
export type CustomCommandType = "prompt" | "bash";

export type CustomCommandInput = {
  commandId: string;
  scope: CustomCommandScope;
  projectId: string;
  name: string;
  commandType: CustomCommandType;
  content: string;
  description: string;
  enabled: boolean;
  sortOrder: number;
};

export type CustomCommandRecord = CustomCommandInput & {
  /** 全局指令被同名项目指令覆盖时为 true */
  shadowed: boolean;
  updatedAt: string;
};

export type WorkspaceDirectoryKind = "local" | "ssh";

export type WorkspaceDirectoryInput = {
  directoryId: string;
  name: string;
  path: string;
  kind: WorkspaceDirectoryKind;
  isActive: boolean;
  sortOrder: number;
  source: string;
};

export type WorkspaceDirectoryRecord = WorkspaceDirectoryInput & {
  id: string;
  updatedAt: string;
  /** 最近一次校验得到的路径状态；unknown 表示尚未校验过。 */
  pathState: string;
  /** 最近一次确认存在时的绝对路径（路径失效后用于提示与重新定位）。 */
  lastKnownPath: string;
};

export type WorkspaceDirectoryPathState =
  | "unknown"
  | "ok"
  | "missing"
  | "mismatch"
  | "offline"
  | "permission_error"
  | "remote";

export type WorkspaceDirectoryVerifyReport = {
  directoryId: string;
  path: string;
  kind: string;
  state: WorkspaceDirectoryPathState | string;
  lastKnownPath: string;
};

export type WorkspaceRelinkRecord = {
  relinkId: string;
  oldDirectoryId: string;
  newDirectoryId: string;
  oldPath: string;
  newPath: string;
  movedBy: string;
  createdAt: string;
  undoneAt?: string | null;
};

export type WorkspaceRelinkReport = {
  relinkId: string;
  oldDirectoryId: string;
  newDirectoryId: string;
  oldPath: string;
  newPath: string;
  dryRun: boolean;
  merged: boolean;
  conversations: number;
  archivedConversations: number;
  memories: number;
  memos: number;
  scheduledTasks: number;
  collectionsTouched: number;
  settingsKeysMoved: number;
  pathsRewritten: number;
  checkpointsRewritten: number;
  codebaseReindexRequired: boolean;
  archiveUpdated: boolean;
  notes: string[];
};

/** 项目合集：收纳项目的纯元数据容器（不对应磁盘目录）。 */
export type ProjectCollectionRecord = {
  id: string;
  collectionId: string;
  name: string;
  sortOrder: number;
  /** 收纳的项目 directory_id 列表（按加入顺序） */
  memberDirectoryIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type RemoteDraftStatus = "pending" | "conflict";

export type RemoteDraftInput = {
  profileId: string;
  workspaceId: string;
  remotePath: string;
  baseVersionJson: string;
  content: string;
  status: RemoteDraftStatus;
};

export type RemoteDraftRecord = RemoteDraftInput & {
  id: string;
  updatedAt: string;
};

export type IdeInfo = {
  id: string;
  name: string;
  executable: string;
};

export type FileSearchResult = {
  path: string;
  relativePath: string;
  name: string;
  isDirectory: boolean;
  matchedName: boolean;
  lineMatches: Array<{ line: number; text: string }>;
};

export type DirectoryEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
};

export type FileContentResult = {
  content: string;
  isBinary: boolean;
  isImage: boolean;
  isSvg: boolean;
  mimeType: string;
  encoding: string;
  size: number;
};

export type FailedWorkspaceDelete = {
  path: string;
  error: string;
};

export type BatchWorkspaceDeleteResult = {
  deleted: string[];
  failed: FailedWorkspaceDelete[];
};

export type McpServerConfigInput = {
  serverId: string;
  name: string;
  transportType: string;
  url: string;
  command: string;
  argsJson: string;
  envJson: string;
  headersJson: string;
  enabled: boolean;
  timeoutMs?: number;
  sortOrder: number;
  source: string;
};

export type LspServerConfigInput = {
  /** 语言标识（唯一键，如 rust / python / go） */
  lang: string;
  /** 启动命令，如 rust-analyzer */
  command: string;
  /** 命令参数 JSON 数组字符串，如 ["--stdio"] */
  argsJson: string;
  /** 关联文件扩展名 JSON 数组字符串，如 [".rs"] */
  fileExtensionsJson: string;
  /** 安装提示命令；空值省略（napi Option<String> 不接受 null） */
  installCommand?: string | null;
  /** 初始化选项 JSON 对象字符串；空值省略（napi Option<String> 不接受 null） */
  initializationOptionsJson?: string | null;
  enabled: boolean;
  sortOrder: number;
  /** 来源：seed / legacy / manual / config-set 等 */
  source: string;
};

export type LspServerConfigRecord = LspServerConfigInput & {
  id: string;
  updatedAt: string;
};

/** LSP 命令安装探测结果（PATH 扫描，无副作用）。 */
export type LspCommandProbeResult = {
  command: string;
  installed: boolean;
  path: string | null;
};

/** 项目技术栈检测结果（native 扫描项目根目录，纯文件系统、无副作用）。 */
export type ProjectStackDetection = {
  /** 相对项目根的目录（"" = 根目录，如 "frontend"、"packages/web"） */
  path: string;
  /** 语言标识：typescript / rust / go / python / java / csharp / php / ruby / lua / kotlin */
  lang: string;
  /** 命中的标志文件名（package.json / Cargo.toml / go.mod 等） */
  marker: string;
};

/** 语言服务器会话运行时状态（native ServerManager 内存态快照，实时轮询用）。 */
export type LspSessionStatus = {
  /** 语言标识（rust / typescript / python ...） */
  lang: string;
  /** 会话项目根目录（绝对路径） */
  projectRoot: string;
  /** running | dead | exited（进程已退出但会话未标记） */
  status: "running" | "dead" | "exited";
  /** 会话重启次数 */
  restartCount: number;
  /** 最近使用时间（unix 毫秒） */
  lastUsedMs: number;
  /** 异常状态说明（running 时为 null） */
  error: string | null;
};

export type HookScope = "global" | "project";

export type HookConfigInput = {
  hookType: string;
  scope: HookScope;
  projectId?: string;
  rulesJson: string;
};

export type HookConfigRecord = {
  hookType: string;
  scope: HookScope;
  projectId: string;
  rulesJson: string;
  updatedAt: string;
};

export type HookExecuteInput = {
  hookType: string;
  projectId?: string;
  contextJson: string;
};

export type HookActionResultRecord = {
  actionType: string;
  success: boolean;
  command?: string | null;
  exitCode?: number | null;
  output?: string | null;
  error?: string | null;
  additionalContext?: string | null;
};

export type HookExecuteResult = {
  success: boolean;
  results: HookActionResultRecord[];
  executedActions: number;
  skippedActions: number;
  softSignal?: boolean | null;
  blocked?: boolean | null;
  blockMessage?: string | null;
};

export type McpServerConfigRecord = Omit<McpServerConfigInput, "timeoutMs"> & {
  id: string;
  timeoutMs: number | null;
  updatedAt: string;
};

export type ProjectMcpServerConfigRecord = Omit<
  McpServerConfigInput,
  "timeoutMs"
> & {
  timeoutMs: number | null;
  updatedAt: string;
};

export type SubAgentConfigInput = {
  agentId: string;
  name: string;
  description: string;
  systemPrompt: string;
  toolsJson: string;
  configProfile: string;
  model: string;
  builtin: boolean;
  sortOrder: number;
  source: string;
  /** 项目 ID；缺省/空表示全局子代理，指定后为项目级子代理。 */
  projectId?: string;
};

export type SubAgentConfigRecord = SubAgentConfigInput & {
  id: string;
  updatedAt: string;
  /** 项目 ID，空字符串表示全局子代理。 */
  projectId: string;
};

export type SensitiveCommandConfigInput = {
  commandId: string;
  pattern: string;
  description: string;
  enabled: boolean;
  isPreset: boolean;
  sortOrder: number;
  source: string;
};

export type SensitiveCommandConfigRecord = SensitiveCommandConfigInput & {
  id: string;
  updatedAt: string;
};

export type ProjectSensitiveCommandConfigInput = {
  commandId: string;
  pattern: string;
  description: string;
  enabled: boolean;
  sortOrder: number;
};

export type ProjectSensitiveCommandConfigRecord =
  ProjectSensitiveCommandConfigInput & {
    inherited: boolean;
    globalEnabled: boolean;
    isPreset: boolean;
    source: string;
  };

/** 决策模型对一条命中敏感规则的命令的判定结果。 */
export type SensitiveCommandDecisionRecord = {
  /** true = 判定可以直接放行。 */
  allow: boolean;
  /** 判定理由的分类 key，由渲染层本地化展示。 */
  reason: string;
  /** 模型对判定的置信度（0-1）。 */
  confidence: number;
  /** 决策模型托管：判定直接生效，不再弹拦截提示。 */
  delegate: boolean;
  /** 参与判定的决策模型名称。 */
  modelName: string;
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

export type StreamInterruptionReason =
  | "unexpected_eof"
  | "read_error"
  | "idle_timeout"
  | "explicit_incomplete"
  | "output_limit";

export type StreamRecoveryOutcome =
  "partial_threshold" | "retry_exhausted" | "non_retriable";

export type ChatMessageRecord = {
  id: string;
  role: string;
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
  interruptionReason?: StreamInterruptionReason | null;
  recoveryOutcome?: StreamRecoveryOutcome | null;
  /** Token usage of the API request that produced this assistant message
   *  (zero for user/tool rows and rows persisted before schema v46). */
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  createdAt: string;
};

export type ChatMessagePage = {
  items: ChatMessageRecord[];
  total: number;
  hasMore: boolean;
  checkpointIds: string[];
};

/** 图像管理系统（生成图片图库）记录 */
export type ImageLibraryRecord = {
  id: string;
  relativePath: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  prompt: string;
  model: string;
  provider: string;
  createdAt: string;
  /** 所属相册 id；null = 未分类 */
  albumId: string | null;
};

/** 图库相册记录 */
export type ImageAlbumRecord = {
  id: string;
  name: string;
  createdAt: string;
  /** 相册封面：最新一张图的图库相对路径（image/...）；空相册为 null */
  coverPath: string | null;
  /** 相册内图片数量 */
  imageCount: number;
};

/** 图库目录迁移进度 */
export type ImageLibraryMigrationProgress = {
  copied: number;
  total: number;
  done: boolean;
};

/** 可迁移的存储位置种类：checkpoint（检查点）| upload（上传图片） */
export type StorageLocationKind = "checkpoint" | "upload";

/** 存储位置迁移进度（与图库迁移结构一致） */
export type StorageMigrationProgress = {
  copied: number;
  total: number;
  done: boolean;
};

/** 可修复的数据库种类：runtime（运行库）| archive（归档库） */
export type DatabaseKind = "runtime" | "archive";

/** 数据库修复结果 */
export type DatabaseRepairResult = {
  /** 是否实际执行了数据恢复（true=检测到损坏并已恢复；false=数据库完好，仅完成压缩） */
  repaired: boolean;
  /** 修复过程描述（英文，供日志与诊断） */
  message: string;
};

/** 数据库空间优化结果 */
export type DatabaseOptimizeResult = {
  /** 本次 VACUUM + WAL 截断释放的磁盘字节数（无可回收空间时为 0） */
  bytesFreed: number;
};

/** 进程内存整理结果 */
export type MemoryOptimizeResult = {
  /** 本次优化前的常驻内存（字节；含 GC 前的测量值） */
  bytesBefore: number;
  /** 本次优化后的常驻内存（字节） */
  bytesAfter: number;
};

/** 数据清理：可清理的分类 id（与 Rust 侧 cleanup 服务一一对应） */
export type CleanupCategoryId =
  | "checkpoints"
  | "upload"
  | "imageLibrary"
  | "backgrounds"
  | "pets"
  | "browserState"
  | "appLogs";

/** 数据清理：单个时间档位（早于 N 天）可清理的数据量 */
export type CleanupAgeBucket = {
  days: number;
  files: number;
  bytes: number;
};

/** 数据清理：单个分类的扫描结果 */
export type CleanupCategoryStats = {
  id: CleanupCategoryId;
  files: number;
  bytes: number;
  /** 与请求的 daysList 顺序一致：早于各天数档位可清理的数据量 */
  ageBuckets: CleanupAgeBucket[];
};

/** 数据清理：一次扫描的完整结果 */
export type CleanupScanResult = {
  categories: CleanupCategoryStats[];
  totalFiles: number;
  totalBytes: number;
};

/** 数据清理：删除结果 */
export type CleanupDeleteResult = {
  deletedFiles: number;
  deletedBytes: number;
  /** 被整体移除的顶层条目数（文件或目录） */
  removedTargets: number;
  /** 删除失败的信息（最多 20 条） */
  errors: string[];
};

export type UserMessageSummary = {
  id: string;
  content: string;
  createdAt: string;
  isContextCompaction: boolean;
};

export type MemoStatus = "pending" | "done";

export type MemoRecord = {
  id: string;
  memoId: string;
  content: string;
  status: MemoStatus;
  createdAt: string;
  updatedAt: string;
};

export type MemoPage = {
  items: MemoRecord[];
  total: number;
  hasMore: boolean;
};

export type MemoCountSummary = {
  total: number;
  pending: number;
  done: number;
};

// ---------------------------------------------------------------------------
// Project Memory（项目级持久记忆）
// ---------------------------------------------------------------------------

export type MemoryKind =
  "fact" | "decision" | "preference" | "pitfall" | "task_state";

export type MemoryStatus = "active" | "pending" | "archived";

export type MemorySource = "agent" | "auto" | "user";

export type MemoryRecord = {
  id: string;
  memoryId: string;
  directoryId: string;
  kind: MemoryKind | string;
  title: string;
  content: string;
  source: MemorySource | string;
  status: MemoryStatus | string;
  importance: number;
  sessionId: string;
  conversationId: string;
  /** 保存该记忆的 assistant response id（回滚清理锚点；旧数据为空串）。 */
  responseId: string;
  tags: string[];
  lastRecalledAt?: string;
  recallCount: number;
  createdAt: string;
  updatedAt: string;
};

export type MemoryPage = {
  items: MemoryRecord[];
  total: number;
  hasMore: boolean;
};

export type MemoryStats = {
  total: number;
  active: number;
  pending: number;
  archived: number;
};

export type ScheduledTaskRunRecord = {
  /** ISO timestamp (UTC) when this run started. */
  runAt: string;
  /** "running" | "completed" | "error". */
  status: string;
  /** Elapsed milliseconds of the finished run. */
  durationMs?: number;
  /** Error message when status === "error". */
  error?: string;
};

/** Full task record persisted in SQLite (camelCase view of the napi struct). */
export type ScheduledTaskRecord = {
  id: string;
  directoryId: string;
  name: string;
  prompt: string;
  /** Serialized ScheduledTaskSchedule JSON. */
  scheduleJson: string;
  apiProfile?: string;
  basicModel?: string;
  model?: string;
  thinkingStrength?: string;
  status: string;
  paused: boolean;
  nextRunAt?: string;
  lastRunAt?: string;
  runCount: number;
  lastError?: string;
  /** Optional pre-script shell command executed before the AI Loop. */
  preScript?: string;
  /** Pre-script timeout in ms (default 60000, range 1000-300000). */
  preScriptTimeoutMs?: number;
  /** When true, a pre-script failure still proceeds to the AI Loop. */
  runOnScriptError?: boolean;
  /** How many times the pre-script skipped the AI Loop. */
  skipCount: number;
  /** ISO timestamp of the last skip, if any. */
  lastSkippedAt?: string;
  /** Reason from the last skip. */
  lastSkipReason?: string;
  createdAt: string;
  updatedAt: string;
  history: ScheduledTaskRunRecord[];
};

/** Write-side shape (same as ScheduledTaskRecord minus history). */
export type ScheduledTaskRecordInput = Omit<ScheduledTaskRecord, "history">;

export type ResponsesApiMessage = {
  role: "user" | "assistant" | "system" | "developer" | "tool";
  content: string;
  toolResultsJson?: string;
};

export type ResponsesApiRequest = {
  messages: ResponsesApiMessage[];
  model?: string;
  apiProfile?: string;
  conversationId?: string;
  previousResponseId?: string;
  directoryId?: string;
  /** Request-local analysis root, independent of directoryId's authorization scope. */
  analysisWorkspaceRoot?: string;
  checkpointId?: string;
  contextCompaction?: boolean;
  /**
   * Internal auto-compaction resume mode: the compaction handoff is already
   * persisted as the latest `context_compaction` boundary, so `messages` is a
   * placeholder that must not be re-injected into the payload nor persisted
   * as normal user messages.
   */
  resumeAfterCompaction?: boolean;
  subAgentToolsJson?: string;
  subAgentSystemPrompt?: string;
  subAgentConfigProfile?: string;
  skipContext?: boolean;
  /** Preserve normal conversation context but omit MCP tools for this request. */
  disableTools?: boolean;
  /** Request-local recovery instruction. Never persisted as a chat message. */
  internalRecoveryPrompt?: string;
  planMode?: boolean;
  goalMode?: boolean;
  worktreeMode?: boolean;
  workflowMode?: boolean;
  /** Per-request thinking strength override ("none" | "low" | "medium" |
   *  "high" | custom). Applied in-memory over the resolved profile's
   *  config_json; never mutates the stored profile. */
  thinkingStrength?: string;
  /** Per-request Responses Fast Mode override; omitted follows the profile
   *  default. Must never be `null`: napi-rs object fields only treat
   *  `undefined` as absent — an explicit `null` throws BooleanExpected. */
  responsesFastMode?: boolean;
  /**
   * Project ROLE.md content of an SSH (`ssh://`) workspace, resolved by the
   * main process via SSH (mirrors RoleEditorPanel's access path). Absent for
   * local workspaces — Rust reads the file itself.
   */
  remoteRoleContent?: string;
  remoteIncludeGlobalRules?: boolean;
};

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
  /** Cumulative thinking-only token count for the current iteration
   *  (subset of streamTokenCount). 0 while no thinking has streamed. */
  thinkingTokenCount: number;
  /** Milliseconds between the first and the most recent thinking delta of
   *  the current iteration. 0 while no thinking has streamed. */
  thinkingDurationMs: number;
  elapsedMs: number;
  ttftMs: number;
  /** External-vision textify progress event (JSON string). See preload types. */
  visionStatus?: string;
};

export type McpToolDefinition = {
  name: string;
  description: string;
  inputSchemaJson: string;
};

export type McpToolStatus = McpToolDefinition & {
  enabled: boolean;
};

export type SkillDefinition = {
  id: string;
  name: string;
  description: string;
  location: "project" | "global";
  source: "snow" | "agents";
  path: string;
  allowedTools?: string[];
  enabled: boolean;
};

export type ProjectSkillDefinition = Omit<SkillDefinition, "enabled"> & {
  defaultEnabled: boolean;
  enabled: boolean;
};

export type SkillInstallResult = {
  success: boolean;
  skillId: string;
  path: string;
  installedAt: string;
  commitSha?: string;
  error?: string;
};

export type SkillBatchInstallResult = {
  success: boolean;
  results: SkillInstallResult[];
  installedCount: number;
  totalCount: number;
  commitSha?: string;
  error?: string;
};

export type GithubSkillRecord = {
  id: string;
  name: string;
  description: string;
  location: string;
  sourceUrl: string;
  installedAt: string;
  commitSha?: string;
};

export type SkillUninstallResult = {
  success: boolean;
  skillId: string;
  message: string;
  error?: string;
};

export type McpProjectToolStatus = McpToolDefinition & {
  enabled: boolean;
};

export type McpProjectServerStatus = {
  id: string;
  name: string;
  source: "system" | "external" | "project";
  globalEnabled: boolean;
  enabled: boolean;
  tools: McpProjectToolStatus[];
  /** 工具尚未从缓存获得（需要后台发现）；仅快速列表会返回 true。 */
  toolsPending: boolean;
  error?: string;
};

export type BashStreamChunk = {
  stream: "stdout" | "stderr" | "interactive_session" | "tool_execution";
  data: string;
};

export type FileSearchAgentProgress = {
  round: number;
  tool: string;
  argsJson: string;
  resultPreview: string;
};

/** `git clone` 的实时进度：一条 stderr 进度行 + 解析出的百分比。 */
export type GitCloneProgress = {
  line: string;
  percent: number | null;
};

export type BrowserCommand = {
  operation: string;
  argsJson: string;
};

export type WebSearchCommand = {
  operation: string;
  argsJson: string;
};

export type RemoteWorkspaceCommand = {
  operation: string;
  argsJson: string;
};

export type BrowserCommandRequest = BrowserCommand & {
  commandId: string;
};

export type BrowserCommandResponse = {
  commandId: string;
  resultJson?: string;
  error?: string;
};

export type TerminalCommand = {
  operation: string;
  argsJson: string;
};

export type TerminalCommandRequest = TerminalCommand & {
  commandId: string;
};

export type TerminalCommandResponse = {
  commandId: string;
  resultJson?: string;
  error?: string;
};

export type UserQuestionCommand = {
  question: string;
  options: string[];
};

export type UserQuestionRequest = UserQuestionCommand & {
  questionId: string;
  interactionId: string;
};

export type UserQuestionResponse = {
  questionId: string;
  resultJson?: string;
  error?: string;
};

export type AppControlCommand = {
  action: string;
  payloadJson: string;
};

export type GitFileStatus = {
  path: string;
  oldPath: string | null;
  indexStatus: string;
  workdirStatus: string;
  status: string;
};

export type GitStatusResult = {
  isRepo: boolean;
  currentBranch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFileStatus[];
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  /** True when the change list was truncated by the configured status limit. */
  statusLimitHit: boolean;
};

export type GitBranch = {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  remoteName: string | null;
};

export type GitDiffResult = {
  content: string;
  isBinary: boolean;
  /** git 命令失败时的错误消息（成功时为空字符串）。 */
  error: string;
};

export type GitStageResult = {
  success: boolean;
  message: string;
};

export type GitCommitResult = {
  success: boolean;
  message: string;
  hash: string | null;
};

export type GitPushPullResult = {
  success: boolean;
  message: string;
};

export type GitCheckoutResult = {
  success: boolean;
  message: string;
};

export type GitLogEntry = {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  date: string;
  message: string;
  refs: string;
  parents: string[];
  /** 本次提交新增的行数（来自 git log --shortstat）。 */
  additions: number;
  /** 本次提交删除的行数（来自 git log --shortstat）。 */
  deletions: number;
};
export type GitCommitFile = {
  path: string;
  status: string;
};

export type GitRepoInfo = {
  path: string;
  name: string;
  currentBranch: string;
};

// ===== 团队协作（基于 Git 的共享数据平面） =====

export type TeamIdentity = {
  isRepo: boolean;
  /** 解析出的真实仓库根路径（团队操作都应使用它）。 */
  repoPath: string;
  name: string;
  email: string;
  remoteUrl: string;
  hasIdentity: boolean;
  error: string | null;
};

export type TeamSyncResult = {
  ok: boolean;
  initialized: boolean;
  pulled: boolean;
  pushed: boolean;
  localAhead: number;
  localBehind: number;
  error: string | null;
};

export type DetectedTerminal = {
  name: string;
  path: string;
  family: string;
};

export type CheckpointChangeType = "added" | "modified" | "deleted";

export type CheckpointFileChange = {
  path: string;
  changeType: CheckpointChangeType;
};

export type CheckpointFileDiff = CheckpointFileChange & {
  content: string;
  isBinary: boolean;
};

/** 远控渲染进程桥的调用请求（Rust → Node，argsJson 为 JSON.stringify 后的参数数组）。 */
export type RemoteControlBridgeRequest = {
  action: string;
  argsJson: string;
};

/** 远控服务公网入口状态。 */
export type RemoteControlWanState = {
  enabled: boolean;
  localPort: number;
  publicOrigin: string;
  pairingUrl: string;
  /** 当前生效的公网令牌；公网入口未启动时为空串。 */
  token: string;
};

/** 远控服务状态快照（enabled 字段由 Node 侧按总开关补充）。 */
export type RemoteControlServerState = {
  running: boolean;
  host: string;
  port: number;
  token: string;
  generation: number;
  wan: RemoteControlWanState;
};

/** 远控服务启动参数（路径与端口由 Node 侧解析后传入）。 */
export type RemoteControlStartOptions = {
  host: string;
  port: number;
  token?: string;
  mobileDir: string;
  iconPath: string;
  wanPublicOrigin?: string;
  wanPort: number;
  /** 固定的公网令牌；省略时公网只接受一次性配对码。 */
  wanToken?: string;
};

/** 远控附件上下文（与消息发送时的会话 / 工作区绑定，防止跨会话串用）。 */
export type RemoteControlAttachmentContext = {
  /**
   * 未选择工作区 / 会话时省略字段。
   * 注意：napi 的 Option<String> 只接受 undefined，null 会触发类型转换错误。
   */
  directoryId?: string;
  conversationId?: string;
};

/** 解析后的远控附件（图片带 dataUrl，文件带磁盘路径；缺省字段省略）。 */
export type RemoteControlResolvedAttachment = {
  id: string;
  kind: "image" | "file";
  name: string;
  mimeType: string;
  size: number;
  dataUrl?: string;
  path?: string;
};

export type AppLockState = {
  enabled: boolean;
  hasPin: boolean;
  totpBound: boolean;
  delayMs: number;
  locked: boolean;
};

export type AppLockVerifyResult = {
  ok: boolean;
  retryAfterMs: number;
  remainingAttempts: number;
};

export type AppLockTotpBinding = {
  secret: string;
  otpauthUri: string;
};

export type NativeBridge = {
  initializeAppStorage: () => Promise<AppStorageInfo>;

  getSystemSettingValue: (settingCode: string) => Promise<string | null>;
  setSystemSetting: (
    settingName: string,
    settingCode: string,
    settingValue: string,
  ) => Promise<void>;
  deleteSystemSetting: (settingCode: string) => Promise<void>;
  getAppLockState: () => Promise<AppLockState>;
  setAppLockDelay: (delayMs: number) => Promise<void>;
  beginAppLockTotpBinding: () => Promise<AppLockTotpBinding>;
  confirmAppLockTotpBinding: (
    secret: string,
    code: string,
    verification: string,
  ) => Promise<boolean>;
  clearAppLockTotp: (code: string) => Promise<AppLockVerifyResult>;
  enableAppLock: (pin: string) => Promise<void>;
  changeAppLockPin: (
    verification: string,
    newPin: string,
  ) => Promise<AppLockVerifyResult>;
  disableAppLock: (verification: string) => Promise<AppLockVerifyResult>;
  verifyAppLockPin: (pin: string) => Promise<AppLockVerifyResult>;
  verifyAppLockTotp: (code: string) => Promise<AppLockVerifyResult>;
  setAppLockLocked: (locked: boolean) => Promise<void>;
  getYoloMode: () => Promise<boolean>;
  setYoloMode: (enabled: boolean) => Promise<void>;
  getLiteMode: () => Promise<boolean>;
  setLiteMode: (enabled: boolean) => Promise<void>;
  getAutoFormat: () => Promise<boolean>;
  setAutoFormat: (enabled: boolean) => Promise<void>;
  /** 退出前落盘尚未执行的延迟自动格式化。 */
  flushPendingFileFormats: () => Promise<void>;
  getConversationModes: (
    conversationId: string,
  ) => Promise<ConversationModesResult>;
  setConversationModes: (
    conversationId: string,
    planMode: boolean | null,
    goalMode: boolean | null,
    worktreeMode: boolean | null,
    workflowMode: boolean | null,
    goalModeTokenBudget: number | null,
  ) => Promise<void>;
  createWorkflowNodeSession: (
    conversationId: string,
    parentConversationId: string,
    flowId: string,
    flowCheckpointId: string,
    nodeId: string,
    nodeName: string,
    directoryId: string,
    apiProfileName: string,
    model: string,
  ) => Promise<void>;
  updateWorkflowNodeSession: (
    conversationId: string,
    runStatus: string,
    errorMessage: string,
    handoffContent: string,
  ) => Promise<void>;
  updateWorkflowNodeHandoff: (
    conversationId: string,
    handoffContent: string,
  ) => Promise<void>;
  listWorkflowNodeSessions: (
    parentConversationId: string,
  ) => Promise<WorkflowNodeSessionRecord[]>;
  listWorkflowNodeSessionsByParents: (
    parentConversationIds: string[],
  ) => Promise<Record<string, ChatConversationRecord[]>>;
  getWorkflowNodeSession: (
    conversationId: string,
  ) => Promise<WorkflowNodeSessionRecord | null>;
  upsertWorkflowRun: (
    parentConversationId: string,
    flowId: string,
    runStatus: string,
    currentNodeIndex: number,
    lastHandoff: string,
    totalTokens: number,
    flowCheckpointId: string,
    directoryId: string,
    errorMessage: string,
  ) => Promise<void>;
  getWorkflowRun: (
    parentConversationId: string,
    flowId: string,
  ) => Promise<WorkflowRunRecord | null>;
  upsertWorkflowCanvas: (
    parentConversationId: string,
    interactionId: string,
    canvasJson: string,
  ) => Promise<void>;
  getWorkflowCanvas: (
    parentConversationId: string,
    interactionId: string,
  ) => Promise<WorkflowCanvasRecord | null>;
  validateWorkflowGraph: (
    nodesJson: string,
    edgesJson: string,
  ) => Promise<WorkflowGraphValidationResult>;
  getConversationRuntimeConfig: (
    conversationId: string,
  ) => Promise<ConversationRuntimeConfig>;
  setConversationRuntimeConfig: (
    conversationId: string,
    thinkingStrength: string | null,
    responsesFastMode: boolean | null,
  ) => Promise<void>;
  setConversationRunStats: (
    conversationId: string,
    runInputTokens: number,
    runOutputTokens: number,
    runCacheCreationInputTokens: number,
    runCacheReadInputTokens: number,
    lastRunDurationMs: number,
    runTtftSumMs: number,
    runRequestCount: number,
  ) => Promise<void>;
  resetConversationRunStats: (conversationId: string) => Promise<void>;
  getRequestLogging: () => Promise<boolean>;
  setRequestLogging: (enabled: boolean) => Promise<void>;
  getRequestLoggingExpiry: () => Promise<number>;
  setRequestLoggingExpiry: (expiresAtMs: number) => Promise<void>;
  getPrivacySettings: () => Promise<PrivacySettings>;
  setPrivacySettings: (settings: PrivacySettings) => Promise<void>;
  getThemeSettings: () => Promise<ThemeSettings>;
  setThemeSettings: (settings: ThemeSettings) => Promise<void>;
  getKeyboardShortcutsSettings: () => Promise<KeyboardShortcutsSettings>;
  setKeyboardShortcutsSettings: (
    settings: KeyboardShortcutsSettings,
  ) => Promise<void>;
  saveThemeBackgroundImage: (sourcePath: string) => Promise<string>;
  deleteThemeBackgroundImage: (imagePath: string) => Promise<void>;
  saveThemeStreamCursorSvg: (sourcePath: string) => Promise<string>;
  deleteThemeStreamCursorSvg: (svgPath: string) => Promise<void>;
  getCodebaseProjectScopeSettings: (
    projectId: string,
  ) => Promise<CodebaseProjectScopeSettings>;
  setCodebaseProjectEnabled: (
    projectId: string,
    enabled: boolean,
  ) => Promise<void>;
  setCodebaseProjectAgentReview: (
    projectId: string,
    enabled: boolean,
  ) => Promise<void>;
  setCodebaseProjectReranking: (
    projectId: string,
    enabled: boolean,
  ) => Promise<void>;
  checkProjectHasGitignore: (projectId: string) => Promise<boolean>;
  checkProjectIsRemote: (projectId: string) => Promise<boolean>;
  startCodebaseEmbedding: (
    projectId: string,
    sessionId: string,
    onProgress: (progress: CodebaseEmbedProgress) => void,
  ) => Promise<void>;
  pauseCodebaseEmbedding: (sessionId: string) => Promise<boolean>;
  resumeCodebaseEmbedding: (sessionId: string) => Promise<boolean>;
  cancelCodebaseEmbedding: (sessionId: string) => Promise<boolean>;
  isCodebaseEmbeddingActive: (projectId: string) => Promise<boolean>;
  getCodebaseIndexStats: (projectId: string) => Promise<CodebaseIndexStats>;
  listCodebaseIndexedFiles: (
    projectId: string,
    page: number,
    pageSize: number,
  ) => Promise<CodebaseIndexedFilePage>;
  getCodebaseSphereLayout: (
    projectId: string,
    limit: number,
  ) => Promise<CodebaseSphereLayout>;
  clearCodebaseIndex: (projectId: string) => Promise<void>;
  startCodebaseWatch: (
    projectId: string,
    projectPath: string,
    onChange: (projectId: string) => void,
  ) => void;
  stopCodebaseWatch: (projectId: string) => void;
  cancelCodebaseSync: (projectId: string) => Promise<boolean>;
  syncCodebaseChanges: (
    projectId: string,
    onProgress: (progress: CodebaseSyncProgress) => void,
  ) => Promise<CodebaseSyncResult>;
  previewCodebaseScan: (projectId: string) => Promise<CodebaseScanPreview>;
  getResumableCodebaseSessions: (
    projectId: string,
  ) => Promise<ResumableCodebaseSession[]>;
  discardResumableCodebaseSession: (sessionId: string) => Promise<void>;
  listToolApprovalProjectApprovedTools: (
    projectId: string,
  ) => Promise<string[]>;
  setToolApprovalProjectToolApproved: (
    projectId: string,
    toolName: string,
    approved: boolean,
  ) => Promise<void>;
  setToolApprovalProjectToolsApproved: (
    projectId: string,
    toolNames: string[],
    approved: boolean,
  ) => Promise<void>;
  getAlwaysApprovedTools: () => Promise<string[]>;
  setAlwaysApprovedTools: (tools: string[]) => Promise<void>;
  listReadonlyTools: () => Promise<string[]>;
  listApiConfigs: () => Promise<ApiConfigRecord[]>;
  /** 重试错误分类默认关键词（JSON 字符串，单一来源在 Rust api::retry）。 */
  getRetryDefaults: () => Promise<string>;
  upsertApiConfig: (config: ApiConfigInput) => Promise<void>;
  deleteApiConfig: (profileName: string) => Promise<void>;
  /** 按给定档案名顺序重写展示排序（拖拽 / 上移下移）。 */
  reorderApiConfigs: (orderedProfileNames: string[]) => Promise<void>;
  exportApiConfigs: (profileNames: string[]) => Promise<ApiConfigExportResult>;
  inspectApiConfigImport: (
    payloadJson: string,
  ) => Promise<ApiConfigImportPreview>;
  importApiConfigs: (
    payloadJson: string,
    conflictStrategy: string,
  ) => Promise<ApiConfigImportOutcome>;
  listSystemPrompts: () => Promise<SystemPromptItemRecord[]>;
  upsertSystemPrompt: (item: SystemPromptItemInput) => Promise<void>;
  deleteSystemPrompt: (promptId: string) => Promise<void>;
  listCustomHeaderSchemes: () => Promise<CustomHeaderSchemeRecord[]>;
  upsertCustomHeaderScheme: (item: CustomHeaderSchemeInput) => Promise<void>;
  deleteCustomHeaderScheme: (schemeId: string) => Promise<void>;
  listCustomCommands: (projectId?: string) => Promise<CustomCommandRecord[]>;
  upsertCustomCommand: (item: CustomCommandInput) => Promise<void>;
  deleteCustomCommand: (commandId: string) => Promise<void>;
  listWorkspaceDirectories: () => Promise<WorkspaceDirectoryRecord[]>;
  upsertWorkspaceDirectory: (item: WorkspaceDirectoryInput) => Promise<void>;
  activateWorkspaceDirectory: (directoryId: string) => Promise<void>;
  listInstalledIdes: () => Promise<IdeInfo[]>;
  openInIde: (ideId: string, projectPath: string) => Promise<void>;
  reorderWorkspaceDirectories: (
    items: WorkspaceDirectoryInput[],
  ) => Promise<void>;
  deleteWorkspaceDirectory: (directoryId: string) => Promise<void>;
  verifyWorkspaceDirectory: (
    directoryId: string,
  ) => Promise<WorkspaceDirectoryVerifyReport>;
  relinkWorkspaceDirectory: (
    oldDirectoryId: string,
    newPath: string,
    dryRun?: boolean,
  ) => Promise<WorkspaceRelinkReport>;
  undoWorkspaceDirectoryRelink: (
    relinkId: string,
  ) => Promise<WorkspaceRelinkReport>;
  listWorkspaceDirectoryRelinks: (
    directoryId: string,
    limit?: number,
  ) => Promise<WorkspaceRelinkRecord[]>;
  listProjectCollections: () => Promise<ProjectCollectionRecord[]>;
  createProjectCollection: (name: string) => Promise<void>;
  renameProjectCollection: (
    collectionId: string,
    name: string,
  ) => Promise<void>;
  deleteProjectCollection: (collectionId: string) => Promise<void>;
  reorderProjectCollectionMembers: (
    collectionId: string,
    orderedMemberIds: string[],
  ) => Promise<void>;
  moveProjectToCollection: (
    targetCollectionId: string,
    directoryId: string,
    orderedMemberIds: string[],
  ) => Promise<void>;
  removeProjectFromAllCollections: (directoryId: string) => Promise<void>;
  removeProjectFromCollection: (
    collectionId: string,
    directoryId: string,
  ) => Promise<void>;
  listRemoteDrafts: (
    workspaceId: string,
    profileId?: string,
  ) => Promise<RemoteDraftRecord[]>;
  upsertRemoteDraft: (item: RemoteDraftInput) => Promise<RemoteDraftRecord>;
  deleteRemoteDraft: (
    profileId: string,
    workspaceId: string,
    remotePath: string,
  ) => Promise<void>;
  createProjectDirectory: (
    parentPath: string,
    projectName: string,
  ) => Promise<string>;
  cloneGitRepository: (
    repoUrl: string,
    parentPath: string,
    onProgress: ((chunk: GitCloneProgress) => void) | undefined,
    streamId: string,
  ) => Promise<string>;
  /** 中止正在进行的克隆：命中的任务会被杀掉进程树并清理半成品目录。 */
  cancelGitClone: (streamId: string) => Promise<boolean>;
  readDirectoryEntries: (dirPath: string) => Promise<DirectoryEntry[]>;
  renameWorkspaceEntry: (
    rootPath: string,
    entryPath: string,
    newName: string,
  ) => Promise<void>;
  deleteWorkspaceEntry: (rootPath: string, entryPath: string) => Promise<void>;
  /** 批量删除工作区条目：单次调用，返回每个条目的删除结果（部分失败不中断）。 */
  deleteWorkspaceEntries: (
    rootPath: string,
    entryPaths: string[],
  ) => Promise<BatchWorkspaceDeleteResult>;
  readFileContent: (filePath: string) => Promise<FileContentResult>;
  writeFileContent: (filePath: string, content: string) => Promise<void>;
  searchFiles: (rootDir: string, query: string) => Promise<FileSearchResult[]>;
  searchFilesByAgent: (
    query: string,
    workspacePath: string,
    onProgress: ((chunk: FileSearchAgentProgress) => void) | undefined,
  ) => Promise<FileSearchResult[]>;
  listMcpServerConfigs: () => Promise<McpServerConfigRecord[]>;
  upsertMcpServerConfig: (item: McpServerConfigInput) => Promise<void>;
  deleteMcpServerConfig: (serverId: string) => Promise<void>;
  listProjectMcpServerConfigs: (
    projectId: string,
  ) => Promise<ProjectMcpServerConfigRecord[]>;
  upsertProjectMcpServerConfig: (
    projectId: string,
    item: McpServerConfigInput,
  ) => Promise<void>;
  deleteProjectMcpServerConfig: (
    projectId: string,
    serverId: string,
  ) => Promise<void>;
  listLspServerConfigs: () => Promise<LspServerConfigRecord[]>;
  upsertLspServerConfig: (item: LspServerConfigInput) => Promise<void>;
  deleteLspServerConfig: (lang: string) => Promise<void>;
  listProjectLspServerConfigs: (
    projectId: string,
  ) => Promise<LspServerConfigRecord[]>;
  upsertProjectLspServerConfig: (
    projectId: string,
    item: LspServerConfigInput,
  ) => Promise<void>;
  deleteProjectLspServerConfig: (
    projectId: string,
    lang: string,
  ) => Promise<void>;
  /** 项目生效配置合并视图：全局记录 + 项目覆盖（同 lang 覆盖替换全局）。 */
  listEffectiveLspServerConfigs: (
    projectId?: string,
  ) => Promise<LspServerConfigRecord[]>;
  probeLspServerCommands: (
    projectId?: string,
  ) => Promise<LspCommandProbeResult[]>;
  detectProjectStack: (projectRoot: string) => Promise<ProjectStackDetection[]>;
  /** 语言服务器会话运行时状态快照（不触发任何会话创建/回收）。 */
  listLspSessionStatuses: (projectId?: string) => Promise<LspSessionStatus[]>;
  /** 手动启动（预热）指定项目和语言的 LSP 会话。 */
  startLspSession: (
    projectId: string,
    lang: string,
  ) => Promise<LspSessionStatus>;
  /** 手动停止指定项目和语言的 LSP 会话（释放进程与内存）。 */
  stopLspSession: (projectId: string, lang: string) => Promise<boolean>;
  /** 手动重启指定项目和语言的 LSP 会话，可选清理持久化诊断缓存。 */
  restartLspSession: (
    projectId: string,
    lang: string,
    clearCache?: boolean,
  ) => Promise<LspSessionStatus>;
  listHookConfigs: (
    scope: HookScope,
    projectId?: string,
  ) => Promise<HookConfigRecord[]>;
  upsertHookConfig: (item: HookConfigInput) => Promise<void>;
  deleteHookConfig: (
    hookType: string,
    scope: HookScope,
    projectId?: string,
  ) => Promise<void>;
  executeHooks: (input: HookExecuteInput) => Promise<HookExecuteResult>;
  listSubAgentConfigs: (projectId?: string) => Promise<SubAgentConfigRecord[]>;
  getSubAgentConfig: (
    agentId: string,
    projectId?: string,
  ) => Promise<SubAgentConfigRecord | null>;
  upsertSubAgentConfig: (item: SubAgentConfigInput) => Promise<void>;
  deleteSubAgentConfig: (agentId: string, projectId?: string) => Promise<void>;
  listSensitiveCommandConfigs: () => Promise<SensitiveCommandConfigRecord[]>;
  upsertSensitiveCommandConfig: (
    item: SensitiveCommandConfigInput,
  ) => Promise<void>;
  deleteSensitiveCommandConfig: (commandId: string) => Promise<void>;
  resetSensitiveCommandConfigs: () => Promise<void>;
  listProjectSensitiveCommandConfigs: (
    projectId: string,
  ) => Promise<ProjectSensitiveCommandConfigRecord[]>;
  setProjectSensitiveCommandEnabled: (
    projectId: string,
    commandId: string,
    enabled: boolean,
  ) => Promise<void>;
  upsertProjectSensitiveCommandConfig: (
    projectId: string,
    item: ProjectSensitiveCommandConfigInput,
  ) => Promise<void>;
  deleteProjectSensitiveCommandConfig: (
    projectId: string,
    commandId: string,
  ) => Promise<void>;
  checkSensitiveCommandMatch: (
    command: string,
    projectId?: string,
  ) => Promise<
    Array<{
      commandId: string;
      pattern: string;
      description: string;
    }>
  >;
  /** 用决策模型判定一条命中敏感规则的命令是否可直接放行（辅助 / 托管）。
   *  workingDirectory / description 是风险判定的上下文（执行目录、模型意图说明）。 */
  evaluateSensitiveCommandDecision: (
    command: string,
    projectId?: string,
    workingDirectory?: string,
    description?: string,
  ) => Promise<SensitiveCommandDecisionRecord | null>;
  listChatConversations: (
    directoryId: string,
  ) => Promise<ChatConversationRecord[]>;
  listChatConversationsPaginated: (
    directoryId: string,
    limit: number,
    offset: number,
  ) => Promise<ChatConversationPage>;
  /** 跨项目按会话 ID 查询会话记录（供「跨项目通知」使用）。 */
  listChatConversationsByIds: (
    conversationIds: string[],
  ) => Promise<ChatConversationRecord[]>;
  /** 记忆来源解析：按会话 ID 批量查询会话记录（含子代理 / WorkFlow 节点会话）。 */
  listMemorySourceConversations: (
    conversationIds: string[],
  ) => Promise<ChatConversationRecord[]>;
  listPinnedConversations: (
    directoryId: string,
  ) => Promise<ChatConversationRecord[]>;
  searchChatConversations: (
    query: string,
  ) => Promise<ConversationSearchResult[]>;
  getChatConversation: (
    conversationId: string,
  ) => Promise<ChatConversationRecord | null>;
  /** 预览历史会话引用 chip 发送时实际注入的上下文内容（与请求组装共用渲染与预算）。 */
  previewConversationAttachment: (conversationId: string) => Promise<string>;
  listSubAgentConversations: (
    parentConversationId: string,
  ) => Promise<ChatConversationRecord[]>;
  listSubAgentConversationsByParents: (
    parentConversationIds: string[],
  ) => Promise<Record<string, ChatConversationRecord[]>>;
  createSubAgentSession: (
    conversationId: string,
    parentConversationId: string,
    agentId: string,
    agentName: string,
    directoryId: string,
    apiProfileName: string,
    model: string,
    title: string,
    thinkingStrength?: string | null,
    responsesFastMode?: boolean | null,
  ) => Promise<void>;
  updateSubAgentSessionStatus: (
    conversationId: string,
    runStatus: string,
    errorMessage: string,
  ) => Promise<void>;
  cancelRunningSubAgentSessions: () => Promise<number>;
  updateConversationStatus: (
    conversationId: string,
    status: string,
  ) => Promise<void>;
  renameConversation: (conversationId: string, title: string) => Promise<void>;
  updateConversationEmoji: (
    conversationId: string,
    emoji: string,
  ) => Promise<void>;
  updateConversationApiProfile: (
    conversationId: string,
    profileName: string,
  ) => Promise<void>;
  /** deleteMemories=true 时把该会话（含级联子会话）保存的项目记忆一并删除；默认保留。 */
  deleteConversation: (
    conversationId: string,
    deleteMemories?: boolean,
  ) => Promise<void>;
  /** deleteMemories=true 时把这些会话（含级联子会话）保存的项目记忆一并删除；默认保留。 */
  deleteConversations: (
    conversationIds: string[],
    deleteMemories?: boolean,
  ) => Promise<void>;
  /** 归档会话：从运行库搬移到独立的归档冷数据库（含子代理级联），置顶会话不参与归档。 */
  archiveConversations: (conversationIds: string[]) => Promise<void>;
  /** 分页列出归档会话（按归档时间倒序）。 */
  listArchivedConversationsPaginated: (
    directoryId: string,
    limit: number,
    offset: number,
  ) => Promise<ChatConversationPage>;
  /** 还原归档会话：从归档冷数据库搬移回运行库（含子代理级联）。 */
  restoreArchivedConversations: (conversationIds: string[]) => Promise<void>;
  /** 永久删除归档会话（含子代理级联）。 */
  deleteArchivedConversations: (conversationIds: string[]) => Promise<void>;
  appendToolMessage: (conversationId: string, content: string) => Promise<void>;
  listChatMessages: (conversationId: string) => Promise<ChatMessageRecord[]>;
  listUserMessages: (conversationId: string) => Promise<UserMessageSummary[]>;
  listChatMessagesPaginated: (
    conversationId: string,
    beforeMessageId: string,
    limit: number,
  ) => Promise<ChatMessagePage>;
  /**
   * 按消息 id 解析用户消息中的第 imageIndex 张图片（0 基）。供远控图片
   * 接口兜底：渲染进程只持有当前会话已加载的内存消息窗口，翻页历史
   * 消息需从数据库 + upload 磁盘解析。
   */
  getChatMessageImage: (
    messageId: string,
    imageIndex: number,
  ) => Promise<{ mimeType: string; base64: string } | null>;

  // ─── 手机远控（HTTP 服务 / 鉴权 / 附件均在原生侧完成）───────────────
  /**
   * 注册渲染进程桥：原生服务需要桌面 UI 实时状态时回调该函数，
   * 回调返回 JSON 字符串（`{ ok: true, value }` 或 `{ ok: false, error }`）。
   */
  setRemoteControlRendererBridge: (
    callback: (request: RemoteControlBridgeRequest) => Promise<string>,
  ) => void;
  /** 启动局域网远控服务（按需一并启动公网回环监听器）。 */
  startRemoteControlServer: (
    options: RemoteControlStartOptions,
  ) => Promise<RemoteControlServerState>;
  /** 停止局域网远控服务与公网回环监听器。 */
  stopRemoteControlServer: () => Promise<void>;
  /** 同步读取远控服务状态（内存快照，无 I/O）。 */
  getRemoteControlServerState: () => RemoteControlServerState;
  /** 应用面板固定的局域网令牌（省略表示回到随机令牌）。 */
  setRemoteControlLanToken: (
    token?: string,
  ) => Promise<RemoteControlServerState>;
  /** 应用面板固定的公网令牌（省略表示回到本次随机令牌）。 */
  setRemoteControlWanToken: (
    token?: string,
  ) => Promise<RemoteControlServerState>;
  /** 启动 / 替换公网回环监听器（frpc 隧道入口）。 */
  startRemoteWanListener: (
    publicOrigin: string,
    preferredPort: number,
    token?: string,
  ) => Promise<RemoteControlServerState>;
  /** 停止公网回环监听器。 */
  stopRemoteWanListener: () => Promise<void>;
  /** 解析远控附件（渲染进程组装消息时使用）。 */
  resolveRemoteAttachments: (
    ids: string[],
    context: RemoteControlAttachmentContext,
    generation: number,
  ) => Promise<RemoteControlResolvedAttachment[]>;

  findLatestToolResult: (
    conversationId: string,
    toolName: string,
  ) => Promise<string | null>;
  forkConversation: (
    sourceConversationId: string,
    upToResponseId: string,
  ) => Promise<ChatConversationRecord>;
  generateConversationSummary: (
    conversationId: string,
    basicModel?: string,
  ) => Promise<string>;
  cancelConversationSummary: (conversationId: string) => boolean;
  fetchAvailableModels: () => Promise<Model[]>;
  fetchAvailableModelsForConfig: (config: ApiModelsConfig) => Promise<Model[]>;
  createResponseStream: (
    request: ResponsesApiRequest,
    onChunk: (chunk: ResponsesApiStreamChunk) => void,
    streamId: string,
  ) => Promise<ResponsesApiResult>;
  abortResponseStream: (streamId: string) => boolean;
  abortToolExecution: (toolExecutionId: string, reason?: string) => boolean;
  listMcpTools: () => Promise<McpToolDefinition[]>;
  listAvailableSkills: (projectId?: string) => Promise<SkillDefinition[]>;
  setSkillEnabled: (
    projectId: string | undefined,
    skillId: string,
    enabled: boolean,
  ) => Promise<void>;
  listProjectSkills: (projectId: string) => Promise<ProjectSkillDefinition[]>;
  setProjectSkillEnabled: (
    projectId: string,
    skillId: string,
    enabled: boolean,
  ) => Promise<void>;
  installSkillFromGithub: (
    url: string,
    location: "global" | "project",
    projectId?: string,
  ) => Promise<SkillBatchInstallResult>;
  uninstallGithubSkill: (
    skillId: string,
    projectId?: string,
  ) => Promise<SkillUninstallResult>;
  listGithubSkills: () => Promise<GithubSkillRecord[]>;
  listMcpServerTools: (configServerId: string) => Promise<McpToolStatus[]>;
  listMcpProjectServers: (
    projectId: string,
  ) => Promise<McpProjectServerStatus[]>;
  /**
   * 项目 MCP 服务器快速列表：外部服务器工具只读 Rust 进程内缓存，不连接
   * 服务器；未命中的服务器以 `toolsPending` 标记，需调用方后台补发现。
   * 保存 / 启停 / 删除配置后的列表刷新用它，避免被慢服务器阻塞。
   */
  listMcpProjectServersCached: (
    projectId: string,
  ) => Promise<McpProjectServerStatus[]>;
  listMcpProjectServerTools: (
    projectId: string,
    serverId: string,
  ) => Promise<McpProjectToolStatus[]>;
  setMcpProjectServerEnabled: (
    projectId: string,
    serverId: string,
    enabled: boolean,
  ) => Promise<void>;
  setMcpProjectToolEnabled: (
    projectId: string,
    toolName: string,
    enabled: boolean,
  ) => Promise<void>;
  setMcpToolEnabled: (toolName: string, enabled: boolean) => Promise<void>;
  setMcpToolsEnabled: (toolNames: string[], enabled: boolean) => Promise<void>;
  setMcpProjectToolsEnabled: (
    projectId: string,
    toolNames: string[],
    enabled: boolean,
  ) => Promise<void>;
  authorizeSensitiveCommand: (command: string, token: string) => Promise<void>;
  writeInteractiveStdin: (sessionId: string, input: string) => Promise<void>;
  /** Registers the SSH remote-command dispatcher used by checkpoint APIs. */
  setCheckpointRemoteCallback: (
    callback: ((command: RemoteWorkspaceCommand) => Promise<string>) | null,
  ) => void;
  callMcpTool: (
    toolFullName: string,
    argsJson: string,
    projectId: string | undefined,
    checkpointIds: string[] | undefined,
    checkpointWorkDir: string | undefined,
    sensitiveAuthorizationToken: string | undefined,
    onChunk: (chunk: BashStreamChunk) => void,
    onBrowserCommand: (command: BrowserCommand) => Promise<string>,
    onWebSearchCommand: (command: WebSearchCommand) => Promise<string>,
    onUserQuestion: (question: UserQuestionCommand) => Promise<string>,
    onAppControl: (command: AppControlCommand) => Promise<string>,
    onRemoteWorkspaceCommand: (
      command: RemoteWorkspaceCommand,
    ) => Promise<string>,
    onTerminalCommand: (command: TerminalCommand) => Promise<string>,
    subAgentAllowedTools: string[] | undefined,
    planMode: boolean | undefined,
    planApproved: boolean | undefined,
    conversationId: string | undefined,
  ) => Promise<string>;
  engineInfo: () => string;
  sum: (a: number, b: number) => number;
  detectTerminals: () => Promise<DetectedTerminal[]>;
  /** 解析登录 PATH（注册表 + 继承的合并值），PTY 创建时刷新用 */
  resolveLoginPathForTerminal: () => Promise<string | null>;
  getGitStatus: (
    repoPath: string,
    statusLimit: number,
  ) => Promise<GitStatusResult>;
  getGitBranches: (repoPath: string) => Promise<GitBranch[]>;
  gitStageFiles: (
    repoPath: string,
    filePaths: string[],
  ) => Promise<GitStageResult>;
  gitUnstageFiles: (
    repoPath: string,
    filePaths: string[],
  ) => Promise<GitStageResult>;
  gitStageAll: (repoPath: string) => Promise<GitStageResult>;
  gitUnstageAll: (repoPath: string) => Promise<GitStageResult>;
  gitCommit: (repoPath: string, message: string) => Promise<GitCommitResult>;
  gitPush: (repoPath: string) => Promise<GitPushPullResult>;
  gitPull: (repoPath: string) => Promise<GitPushPullResult>;
  gitFetch: (repoPath: string) => Promise<GitPushPullResult>;
  gitCheckout: (
    repoPath: string,
    branchName: string,
  ) => Promise<GitCheckoutResult>;
  gitCreateBranch: (
    repoPath: string,
    branchName: string,
  ) => Promise<GitCheckoutResult>;
  gitFileDiff: (
    repoPath: string,
    filePath: string,
    staged: boolean,
  ) => Promise<GitDiffResult>;
  gitFileContent: (
    repoPath: string,
    filePath: string,
    revision: string | null,
  ) => Promise<FileContentResult>;
  gitDiscardChanges: (
    repoPath: string,
    filePaths: string[],
  ) => Promise<GitStageResult>;
  getGitLog: (
    repoPath: string,
    skip: number,
    limit: number,
  ) => Promise<GitLogEntry[]>;
  getGitCommitFiles: (
    repoPath: string,
    hash: string,
  ) => Promise<GitCommitFile[]>;
  getCommitDiff: (repoPath: string, hash: string) => Promise<GitDiffResult>;
  gitCommitFileDiff: (
    repoPath: string,
    hash: string,
    filePath: string,
  ) => Promise<GitDiffResult>;
  discoverGitRepos: (
    rootPath: string,
    maxDepth: number,
    ignoredFolders: string[],
  ) => Promise<GitRepoInfo[]>;
  startGitWatch: (
    repoPath: string,
    debounceMs: number,
    onChange: (repoPath: string) => void,
  ) => void;
  stopGitWatch: (repoPath: string) => void;
  /** 监听单个本地文件变更（父目录非递归监听 + 防抖），用于文件阅读器自动刷新。 */
  startFileWatch: (
    filePath: string,
    debounceMs: number,
    onChange: (filePath: string) => void,
  ) => void;
  stopFileWatch: (filePath: string) => void;
  teamGetIdentity: (repoPath: string) => Promise<TeamIdentity>;
  /** 定位真实仓库路径：向上找 .git，找不到再扫子目录；空串表示非仓库。 */
  teamResolveRepo: (path: string) => Promise<string>;
  teamConfigureIdentity: (
    repoPath: string,
    name: string,
    email: string,
  ) => Promise<TeamIdentity>;
  /** 设置当前用户的头像颜色（`#rrggbb`，空串恢复默认色）。 */
  teamSetAvatarColor: (
    repoPath: string,
    color: string,
  ) => Promise<TeamIdentity>;
  teamSync: (repoPath: string) => Promise<TeamSyncResult>;
  /** 列出某类团队记录，返回原始 JSON 字符串数组。 */
  teamList: (repoPath: string, kind: string) => Promise<string[]>;
  teamUpsert: (
    repoPath: string,
    kind: string,
    id: string,
    json: string,
  ) => Promise<string>;
  teamDelete: (repoPath: string, kind: string, id: string) => Promise<boolean>;
  /** 保存团队笔记媒体文件（图片），返回 `snow-team/media/...` 相对路径。 */
  teamMediaSave: (
    repoPath: string,
    noteId: string,
    fileName: string,
    base64Data: string,
  ) => Promise<string>;
  /** 读取团队媒体文件，返回 data URL。 */
  teamMediaRead: (repoPath: string, rel: string) => Promise<string>;
  /** 保存团队消息附件（图片或普通文件），返回 `snow-team/media/...` 相对路径。 */
  teamFileSave: (
    repoPath: string,
    messageId: string,
    fileName: string,
    base64Data: string,
  ) => Promise<string>;
  /** 删除某条记录（消息/笔记）的整个媒体目录。 */
  teamMediaDelete: (repoPath: string, ownerId: string) => Promise<boolean>;
  generateCommitMessage: (
    repoPath: string,
    onChunk: (chunk: ResponsesApiStreamChunk) => void,
    streamId: string,
  ) => Promise<ResponsesApiResult>;
  generateCommitMessageFromDiff: (
    diff: string,
    onChunk: (chunk: ResponsesApiStreamChunk) => void,
    streamId: string,
  ) => Promise<ResponsesApiResult>;
  generateThemePalette: (
    imagePath: string,
    profileName: string,
    onChunk: (chunk: ResponsesApiStreamChunk) => void,
    streamId: string,
  ) => Promise<ResponsesApiResult>;
  createCheckpoint: (workDir: string) => Promise<string>;
  restoreCheckpoint: (checkpointId: string, workDir: string) => Promise<void>;
  restoreCheckpoints: (
    checkpointIds: string[],
    workDir: string,
  ) => Promise<void>;
  deleteCheckpoint: (checkpointId: string) => Promise<void>;
  /** 整理旧版检查点布局（扁平目录/对象 → 日期分片/哈希分桶）；返回搬移条目数。 */
  migrateCheckpointLayout: () => Promise<number>;
  listCheckpointChanges: (
    checkpointId: string,
    workDir: string,
  ) => Promise<CheckpointFileChange[]>;
  listCheckpointChangesBatch: (
    checkpointIds: string[],
    workDir: string,
    includeAll?: boolean,
  ) => Promise<CheckpointFileChange[]>;
  listCheckpointDiffs: (
    checkpointId: string,
    workDir: string,
    includeAll?: boolean,
  ) => Promise<CheckpointFileDiff[]>;
  listCheckpointDiffsBatch: (
    checkpointIds: string[],
    workDir: string,
    includeAll?: boolean,
  ) => Promise<CheckpointFileDiff[]>;
  truncateConversationFromResponse: (
    conversationId: string,
    responseId: string,
  ) => Promise<void>;
  truncateConversationFromMessage: (
    conversationId: string,
    messageId: string,
  ) => Promise<void>;
  listTodosForRollback: (
    sessionId: string,
    responseId: string,
  ) => Promise<string>;
  listUsageRecords: (
    conversationId: string,
    directoryId: string,
    profileName: string,
    limit: number,
    offset: number,
  ) => Promise<UsageRecordPage>;
  getUsageSummary: (
    since: string,
    until: string,
    profileName: string,
  ) => Promise<UsageSummary>;
  getUsageDailyBreakdown: (
    since: string,
    until: string,
    profileName: string,
  ) => Promise<DailyUsageBreakdown[]>;
  getUsageModelBreakdown: (
    since: string,
    until: string,
    profileName: string,
  ) => Promise<ModelUsageBreakdown[]>;
  listUsageProfileNames: () => Promise<string[]>;
  deleteUsageRecords: (since: string, until: string) => Promise<number>;
  writeAppLog: (input: AppLogInput) => Promise<void>;
  /** Executes a scheduled-task pre-script (shell command) in the project cwd. */
  runPreScript: (
    command: string,
    cwd: string,
    timeoutMs: number,
    envJson: string,
  ) => Promise<PreScriptResult>;
  listAppLogs: (
    level: string,
    module: string,
    since: string,
    until: string,
    limit: number,
    offset: number,
  ) => Promise<AppLogPage>;
  clearAppLogs: () => Promise<number>;
  exportConversation: (
    conversationId: string,
    format: string,
  ) => Promise<string>;
  /** 会话 JSON 导入：Rust 读取文件、解析并写入新的会话与消息，返回结果 JSON。 */
  importConversation: (
    directoryId: string,
    filePath: string,
  ) => Promise<string>;
  /** Markdown 表格导出：Rust 生成 CSV / XLSX 文件字节（rowsJson 为二维字符串数组）。 */
  exportMarkdownTable: (format: string, rowsJson: string) => Promise<Buffer>;
  listMemos: (
    directoryId: string,
    limit: number,
    offset: number,
    status?: string,
    sortField?: string,
    sortOrder?: string,
    keyword?: string,
  ) => Promise<MemoPage>;
  createMemo: (directoryId: string, content: string) => Promise<MemoRecord>;
  updateMemoContent: (memoId: string, content: string) => Promise<MemoRecord>;
  updateMemoStatus: (memoId: string, status: string) => Promise<MemoRecord>;
  deleteMemo: (memoId: string) => Promise<void>;
  getMemoCountSummary: (directoryId: string) => Promise<MemoCountSummary>;
  upsertProjectMemory: (
    directoryId: string,
    kind: string,
    title: string,
    content: string,
    importance: number,
    tags?: string[],
    source?: string,
    status?: string,
    sessionId?: string,
    conversationId?: string,
    responseId?: string,
  ) => Promise<MemoryRecord>;
  listProjectMemories: (
    directoryId: string,
    limit: number,
    offset: number,
    status?: string,
    kind?: string,
  ) => Promise<MemoryPage>;
  /** 面板关键词检索：与列表同形分页（条目 + 命中总数 + 是否有更多）。 */
  searchProjectMemories: (
    directoryId: string,
    query: string,
    limit: number,
    offset: number,
    status?: string,
    kind?: string,
  ) => Promise<MemoryPage>;
  /** 列出多个会话（主会话 + 其子代理 / WorkFlow 节点会话）保存的记忆。 */
  listProjectMemoriesByConversations: (
    conversationIds: string[],
    limit?: number,
  ) => Promise<MemoryRecord[]>;
  updateProjectMemory: (
    memoryId: string,
    kind?: string,
    title?: string,
    content?: string,
    importance?: number,
    status?: string,
    tags?: string[],
  ) => Promise<MemoryRecord>;
  deleteProjectMemory: (memoryId: string) => Promise<boolean>;
  clearProjectMemories: (directoryId: string) => Promise<number>;
  getProjectMemoryStats: (directoryId: string) => Promise<MemoryStats>;
  countProjectMemoriesByConversations: (
    conversationIds: string[],
  ) => Promise<number>;
  listProjectMemoriesByConversation: (
    conversationId: string,
    limit?: number,
  ) => Promise<MemoryRecord[]>;
  deleteProjectMemoriesByConversation: (
    conversationId: string,
  ) => Promise<number>;
  /** 回滚预览：列出被回滚轮次（及级联会话）保存的项目记忆清单。 */
  listProjectMemoriesForRollback: (
    conversationId: string,
    boundaryMessageId?: string,
    boundaryResponseId?: string,
    cascadeConversationIds?: string[],
  ) => Promise<MemoryRecord[]>;
  /** 回滚确认后：按 memory_id 批量删除记忆，返回删除条数。 */
  deleteProjectMemoriesByIds: (memoryIds: string[]) => Promise<number>;
  listScheduledTasks: () => Promise<ScheduledTaskRecord[]>;
  upsertScheduledTask: (
    input: ScheduledTaskRecordInput,
  ) => Promise<ScheduledTaskRecord>;
  deleteScheduledTask: (taskId: string) => Promise<void>;
  clearScheduledTasks: (directoryId: string | null) => Promise<number>;
  appendScheduledTaskRun: (taskId: string, runAt: string) => Promise<string>;
  finalizeScheduledTaskRun: (
    taskId: string,
    runId: string,
    status: string,
    durationMs?: number,
    error?: string,
  ) => Promise<void>;
  /** Marks run rows left "running" by a crashed session as errored. */
  reconcileScheduledTaskRuns: () => Promise<number>;
  sha256File: (filePath: string) => Promise<string>;
  getImageLibraryRoot: () => Promise<string>;
  getImageLibraryDir: () => Promise<string>;
  setImageLibraryDir: (dir: string) => Promise<void>;
  listImageLibrary: () => Promise<ImageLibraryRecord[]>;
  listImageAlbums: () => Promise<ImageAlbumRecord[]>;
  createImageAlbum: (name: string) => Promise<ImageAlbumRecord>;
  renameImageAlbum: (id: string, name: string) => Promise<ImageAlbumRecord>;
  deleteImageAlbum: (id: string) => Promise<void>;
  setImageAlbum: (imageId: string, albumId: string | null) => Promise<void>;
  /** 设置相册手动封面（imageId 传 null 清除，回退最新一张图） */
  setImageAlbumCover: (
    albumId: string,
    imageId: string | null,
  ) => Promise<ImageAlbumRecord>;
  /** 相册拖拽排序：按给定顺序持久化 sort_order */
  reorderImageAlbums: (orderedIds: string[]) => Promise<void>;
  /** 手动导入图片文件（复制进图库目录并写入索引），返回成功导入的记录 */
  importImageFiles: (filePaths: string[]) => Promise<ImageLibraryRecord[]>;
  readImageLibraryFile: (relativePath: string) => Promise<string | null>;
  deleteImageLibraryImage: (id: string) => Promise<void>;
  countConversationImages: (conversationIds: string[]) => Promise<number>;
  deleteConversationImages: (conversationIds: string[]) => Promise<number>;
  /** 准备图库迁移：校验目标目录并写入迁移日志；返回待迁移图片数量（0 表示无需迁移） */
  prepareImageLibraryMigration: (targetDir: string) => Promise<number>;
  /** 复制下一批图库文件并返回迁移进度 */
  migrateImageLibraryChunk: () => Promise<ImageLibraryMigrationProgress>;
  /** 提交迁移：写入新目录设置并清理旧根目录文件 */
  commitImageLibraryMigration: () => Promise<void>;
  /** 回滚迁移：删除已复制到新目录的文件并移除日志（幂等） */
  rollbackImageLibraryMigration: () => Promise<void>;
  /** 读取检查点自定义保存目录（空字符串表示使用默认目录） */
  getCheckpointDir: () => Promise<string>;
  /** 设置检查点自定义保存目录（传入空字符串重置为默认目录） */
  setCheckpointDir: (dir: string) => Promise<void>;
  /** 读取上传图片自定义保存目录（空字符串表示使用默认目录） */
  getUploadDir: () => Promise<string>;
  /** 设置上传图片自定义保存目录（传入空字符串重置为默认目录） */
  setUploadDir: (dir: string) => Promise<void>;
  /** 检查点根目录绝对路径（优先用户自定义路径，回退默认） */
  getCheckpointRoot: () => Promise<string>;
  /** 上传图片根目录绝对路径（优先用户自定义路径，回退默认） */
  getUploadRoot: () => Promise<string>;
  /** 准备存储目录迁移：校验目标目录并写入迁移日志；返回待迁移文件数量（0 表示无需迁移） */
  prepareStorageMigration: (
    kind: StorageLocationKind,
    targetDir: string,
  ) => Promise<number>;
  /** 复制下一批存储目录文件并返回迁移进度 */
  migrateStorageChunk: (
    kind: StorageLocationKind,
  ) => Promise<StorageMigrationProgress>;
  /** 提交迁移：写入新目录设置并清理旧根目录文件 */
  commitStorageMigration: (kind: StorageLocationKind) => Promise<void>;
  /** 回滚迁移：删除已复制到新目录的文件并移除日志（幂等） */
  rollbackStorageMigration: (kind: StorageLocationKind) => Promise<void>;
  /** 计算文件或目录的占用字节数（目录递归统计，用于展示存储占用） */
  getPathSize: (path: string) => Promise<number>;
  /** 当前进程常驻内存占用（字节；用于设置页展示资源占用） */
  getProcessMemoryBytes: () => Promise<number>;
  /** 整理本进程内存（仅 Windows 支持）：配合主进程 V8 GC 收缩 OS 工作集 */
  optimizeMemory: () => Promise<MemoryOptimizeResult>;
  /** 修复数据库（runtime=运行库 / archive=归档库）：完整性检查、损坏恢复与压缩 */
  repairDatabase: (kind: DatabaseKind) => Promise<DatabaseRepairResult>;
  /** 优化数据库磁盘占用（runtime=运行库 / archive=归档库）：VACUUM 回收空闲页并截断 WAL */
  optimizeDatabase: (kind: DatabaseKind) => Promise<DatabaseOptimizeResult>;
  /** 扫描本地数据分类的占用（daysList 为需要一并统计的天数档位，如 [7,15,30,90]） */
  scanCleanup: (daysList: number[]) => Promise<CleanupScanResult>;
  /** 删除选中的清理分类数据（maxAgeDays=0 表示删除分类目录下的全部内容） */
  deleteCleanupData: (
    categories: CleanupCategoryId[],
    maxAgeDays: number,
  ) => Promise<CleanupDeleteResult>;
  /** 探测本机浏览器（Chrome/Edge/Chromium/Firefox）及其配置文件与数据量 */
  browserImportListSources: () => Promise<BrowserImportSource[]>;
  /** 解密并导出指定浏览器配置文件的已保存密码（明文，仅供主进程加密落盘） */
  browserImportPasswords: (
    sourceId: string,
    profile: string,
  ) => Promise<ImportedBrowserPassword[]>;
  /** 解析指定浏览器配置文件的 Cookie（Chrome 系已解密） */
  browserImportCookies: (
    sourceId: string,
    profile: string,
  ) => Promise<ImportedBrowserCookie[]>;
  /** 解析指定浏览器配置文件的书签（明文收藏夹，无需解密） */
  browserImportBookmarks: (
    sourceId: string,
    profile: string,
  ) => Promise<ImportedBrowserBookmark[]>;
  // ── Codex 宠物系统 ────────────────────────────────────────────────
  /** 安装 Codex 宠物包（zip），返回安装后的宠物清单 */
  installPetFromZip: (zipPath: string) => Promise<PetManifestRecord>;
  /** 列出所有可用宠物（Snow App 安装 + Codex App / Petdex 生态） */
  listInstalledPets: () => Promise<PetManifestRecord[]>;
  /** 卸载 Snow App 安装的宠物 */
  uninstallPet: (petId: string) => Promise<void>;
  // ── 用户脚本（油猴兼容）────────────────────────────────────────────
  /** 列出全部用户脚本 */
  listUserscripts: () => Promise<UserscriptRecord[]>;
  /** 创建用户脚本（raw 含元数据头），返回完整记录 */
  createUserscript: (raw: string) => Promise<UserscriptRecord>;
  /** 更新用户脚本（按 scriptId 覆盖 raw），返回完整记录 */
  updateUserscript: (
    scriptId: string,
    raw: string,
  ) => Promise<UserscriptRecord>;
  /** 删除用户脚本（级联删除其 GM 值） */
  deleteUserscript: (scriptId: string) => Promise<void>;
  /** 启用/禁用用户脚本 */
  setUserscriptEnabled: (scriptId: string, enabled: boolean) => Promise<void>;
  /** 读取脚本文件完整内容（含元数据头） */
  readUserscriptSource: (scriptId: string) => Promise<string>;
  /** 读取脚本的 GM 值 */
  getUserscriptValues: (scriptId: string) => Promise<UserscriptValue[]>;
  /** 写入/更新脚本的 GM 值 */
  setUserscriptValue: (
    scriptId: string,
    key: string,
    value: string,
  ) => Promise<void>;
  /** 删除脚本的 GM 值 */
  deleteUserscriptValue: (scriptId: string, key: string) => Promise<void>;
  // ── 应用插件 ────────────────────────────────────────────────────────
  /** 列出全部已安装插件 */
  listPlugins: () => Promise<PluginRecord[]>;
  /** 从本地目录安装（或更新）插件，返回插件记录 */
  installPlugin: (sourceDir: string) => Promise<PluginRecord>;
  /** 重新读取插件目录中的 plugin.json 并刷新元数据 */
  rescanPlugin: (pluginId: string) => Promise<PluginRecord>;
  /** 启用/禁用插件 */
  setPluginEnabled: (pluginId: string, enabled: boolean) => Promise<void>;
  /** 卸载插件；deleteFiles 为 true 时同时删除插件目录 */
  deletePlugin: (pluginId: string, deleteFiles: boolean) => Promise<void>;
  /** 读取插件目录内的文本文件（入口代码 / 样式 / 语言包） */
  readPluginFile: (pluginId: string, relativePath: string) => Promise<string>;
  /** 读取插件目录内的二进制资源（图标等），返回原始字节 */
  readPluginAsset: (pluginId: string, relativePath: string) => Promise<Buffer>;
  /** 读取插件的持久化 KV 数据 */
  getPluginValues: (pluginId: string) => Promise<PluginStorageValue[]>;
  /** 写入插件的持久化 KV 数据 */
  setPluginValue: (
    pluginId: string,
    key: string,
    value: string,
  ) => Promise<void>;
  /** 删除插件的持久化 KV 数据 */
  deletePluginValue: (pluginId: string, key: string) => Promise<void>;
  /** 插件根目录绝对路径（~/.snowapp/plugins） */
  getPluginsDirectory: () => Promise<string>;
};

/** 本机浏览器源（探测结果）。 */
export type BrowserImportSource = {
  /** "chrome" | "edge" | "chromium" | "firefox" */
  id: string;
  name: string;
  profile: string;
  /** 浏览器登录账号（Chrome: account_info email / Firefox: sync username） */
  accountName: string;
  passwordDb: string;
  cookieDb: string;
  passwordCount: number;
  cookieCount: number;
  bookmarkCount: number;
  note: string;
};

/** 导入的密码（明文仅存在于主进程内存，随即加密落盘）。 */
export type ImportedBrowserPassword = {
  origin: string;
  username: string;
  password: string;
};

/** 导入的 Cookie。 */
export type ImportedBrowserCookie = {
  domain: string;
  path: string;
  name: string;
  value: string;
  expires: number | null;
  httpOnly: boolean;
  secure: boolean;
  sameSite: string;
};

/** 导入的书签（明文收藏夹）。 */
export type ImportedBrowserBookmark = {
  title: string;
  url: string;
  folder: string;
};

/** Codex 宠物清单（pet.json 解析结果 + 安装位置信息）。 */
export type PetManifestRecord = {
  /** 宠物唯一标识 */
  id: string;
  /** 展示名称 */
  displayName: string;
  /** 宠物描述 */
  description: string;
  /** 精灵图文件名（相对宠物目录） */
  spritesheetFile: string;
  /** 宠物目录绝对路径 */
  dirPath: string;
  /** 精灵图绝对路径 */
  spritesheetPath: string;
  /** 来源："snow"（Snow App 安装）| "codex"（Codex App）| "petdex"（Petdex） */
  source: string;
  /** 精灵图版本：1 = 9 行标准网格，2 = 11 行（Hatch Pet v2） */
  version: number;
  /** 精灵图列数（标准为 8） */
  columns: number;
  /** 精灵图行数 */
  rows: number;
};

// ── 用户脚本（油猴兼容）────────────────────────────────────────────

/** 用户脚本完整记录（管理 UI 使用）。 */
export type UserscriptRecord = {
  scriptId: string;
  name: string;
  version: string;
  description: string;
  namespace: string;
  author: string;
  enabled: boolean;
  runAt: "document-start" | "document-end" | "document-idle";
  noframes: boolean;
  grant: string[];
  matches: string[];
  includes: string[];
  excludes: string[];
  requires: string[];
  /** 作用域：`browser`（内置浏览器）/ `client`（桌面客户端 UI）/ `all`。 */
  target: "browser" | "client" | "all";
  /** 客户端脚本生效的主内容视图（空 = 全部视图）。 */
  views: string[];
  /** 客户端脚本生效的界面区域。 */
  surfaces: string[];
  /** 生命周期作用域：`global` = 应用启动即常驻。 */
  scope: string;
  /** 是否隔离世界执行（沙箱档）；false = 主世界完全权限档。 */
  sandbox: boolean;
  /** 脚本文件在磁盘上的绝对路径。 */
  filePath: string;
  createdAt: string;
  updatedAt: string;
};

/** webview preload 匹配查询返回项（主进程 userscriptSyncStore 从缓存构造）。 */
export type UserscriptMatchItem = {
  scriptId: string;
  name: string;
  version: string;
  description: string;
  runAt: "document-start" | "document-end" | "document-idle";
  noframes: boolean;
  grant: string[];
  /** @require 声明的外部脚本 URL（主进程负责下载并拼接）。 */
  requires: string[];
  /** GM 值快照：主进程 match 时内嵌，preload 注入后同步读取。 */
  gmValues?: Record<string, string>;
  /** @resource 资源快照（name -> content），主进程 match 时下载内嵌。 */
  resources?: Record<string, string>;
  /** 去除元数据头后的可执行代码。 */
  code: string;
  /** 原始完整内容（含元数据头）。 */
  raw: string;
};

/** GM_* API 的持久化值条目。 */
export type UserscriptValue = {
  key: string;
  value: string;
};

// ── 应用插件 ──────────────────────────────────────────────────────────

/** 插件完整记录（名称与描述为 JSON 字符串，形如 {"default":"...","zh-CN":"..."}）。 */
export type PluginRecord = {
  pluginId: string;
  name: string;
  description: string;
  version: string;
  author: string;
  homepage: string;
  license: string;
  icon: string;
  renderMode: string;
  entry: string;
  enabled: boolean;
  installPath: string;
  sourcePath: string;
  manifestJson: string;
  panels: string;
  locales: string;
  styles: string;
  privacy: string[];
  privacyNote: string;
  minAppVersion: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

/** 插件持久化 KV 条目。 */
export type PluginStorageValue = {
  key: string;
  value: string;
};
