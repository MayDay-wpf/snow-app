import type {
  ImportResourceInput,
  ImportResourceRecord,
  ImportResourceRelease,
  ImportResourceReleaseInput,
} from "../../shared/importResources";
import type {
  PluginInput,
  PluginMarketplaceInput,
  PluginMarketplaceRecord,
  PluginRecord,
} from "../../shared/plugins";

export type {
  ImportResourceInput,
  ImportResourceRecord,
  ImportResourceRelease,
  ImportResourceReleaseInput,
};
export type {
  PluginInput,
  PluginMarketplaceInput,
  PluginMarketplaceRecord,
  PluginRecord,
};

export type AppStorageInfo = {
  directoryPath: string;
  databasePath: string;
};

export type ApiConfigInput = {
  profileName: string;
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
  systemPromptIdsJson: string;
  customHeaderSchemeId: string;
  configJson: string;
  source: string;
};

export type ApiConfigRecord = ApiConfigInput & {
  id: string;
  updatedAt: string;
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
  rerankingModelName: string;
  rerankingBaseUrl: string;
  rerankingApiKey: string;
  rerankingContextLength: number;
  rerankingTopN: number;
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
  goalModeTokenBudget: number | null;
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

export type ProjectMcpServerImportInput = {
  projectId: string;
  input: McpServerConfigInput;
};

export type ImportDatabaseTransactionInput = {
  mcpServers: McpServerConfigInput[];
  projectMcpServers: ProjectMcpServerImportInput[];
  systemPrompts: SystemPromptItemInput[];
  plugins: PluginInput[];
  importResources: ImportResourceInput[];
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
  content: string;
  thinking: string;
  status: string;
  model: string;
  responseId: string;
  checkpointId: string;
  toolCallsJson: string;
  createdAt: string;
};

export type ChatMessagePage = {
  items: ChatMessageRecord[];
  total: number;
  hasMore: boolean;
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

export type UserMessageSummary = {
  id: string;
  content: string;
  createdAt: string;
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
  planMode?: boolean;
  goalMode?: boolean;
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
  /** External-vision textify progress event (JSON string). See preload types. */
  visionStatus?: string;
};

export type McpToolDefinition = {
  name: string;
  description: string;
  inputSchemaJson: string;
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

export type BrowserCommand = {
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

export type DetectedTerminal = {
  name: string;
  path: string;
  family: string;
};

export type CheckpointFileChange = {
  path: string;
  changeType: string;
};

export type CheckpointFileDiff = CheckpointFileChange & {
  content: string;
  isBinary: boolean;
};

export type NativeBridge = {
  initializeAppStorage: () => Promise<AppStorageInfo>;

  getSystemSettingValue: (settingCode: string) => Promise<string | null>;
  setSystemSetting: (
    settingName: string,
    settingCode: string,
    settingValue: string
  ) => Promise<void>;
  getYoloMode: () => Promise<boolean>;
  setYoloMode: (enabled: boolean) => Promise<void>;
  getConversationModes: (
    conversationId: string
  ) => Promise<ConversationModesResult>;
  setConversationModes: (
    conversationId: string,
    planMode: boolean | null,
    goalMode: boolean | null,
    goalModeTokenBudget: number | null
  ) => Promise<void>;
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
    settings: KeyboardShortcutsSettings
  ) => Promise<void>;
  saveThemeBackgroundImage: (sourcePath: string) => Promise<string>;
  deleteThemeBackgroundImage: (imagePath: string) => Promise<void>;
  saveThemeStreamCursorSvg: (sourcePath: string) => Promise<string>;
  deleteThemeStreamCursorSvg: (svgPath: string) => Promise<void>;
  getCodebaseProjectScopeSettings: (
    projectId: string
  ) => Promise<CodebaseProjectScopeSettings>;
  setCodebaseProjectEnabled: (
    projectId: string,
    enabled: boolean
  ) => Promise<void>;
  setCodebaseProjectAgentReview: (
    projectId: string,
    enabled: boolean
  ) => Promise<void>;
  setCodebaseProjectReranking: (
    projectId: string,
    enabled: boolean
  ) => Promise<void>;
  checkProjectHasGitignore: (projectId: string) => Promise<boolean>;
  checkProjectIsRemote: (projectId: string) => Promise<boolean>;
  startCodebaseEmbedding: (
    projectId: string,
    sessionId: string,
    onProgress: (progress: CodebaseEmbedProgress) => void
  ) => Promise<void>;
  pauseCodebaseEmbedding: (sessionId: string) => Promise<boolean>;
  resumeCodebaseEmbedding: (sessionId: string) => Promise<boolean>;
  cancelCodebaseEmbedding: (sessionId: string) => Promise<boolean>;
  isCodebaseEmbeddingActive: (projectId: string) => Promise<boolean>;
  getCodebaseIndexStats: (projectId: string) => Promise<CodebaseIndexStats>;
  listCodebaseIndexedFiles: (
    projectId: string,
    page: number,
    pageSize: number
  ) => Promise<CodebaseIndexedFilePage>;
  getCodebaseSphereLayout: (
    projectId: string,
    limit: number
  ) => Promise<CodebaseSphereLayout>;
  clearCodebaseIndex: (projectId: string) => Promise<void>;
  startCodebaseWatch: (
    projectId: string,
    projectPath: string,
    onChange: (projectId: string) => void
  ) => void;
  stopCodebaseWatch: (projectId: string) => void;
  syncCodebaseChanges: (
    projectId: string,
    onProgress: (progress: CodebaseSyncProgress) => void
  ) => Promise<CodebaseSyncResult>;
  previewCodebaseScan: (projectId: string) => Promise<CodebaseScanPreview>;
  getResumableCodebaseSessions: (
    projectId: string
  ) => Promise<ResumableCodebaseSession[]>;
  discardResumableCodebaseSession: (sessionId: string) => Promise<void>;
  listToolApprovalProjectApprovedTools: (
    projectId: string
  ) => Promise<string[]>;
  setToolApprovalProjectToolApproved: (
    projectId: string,
    toolName: string,
    approved: boolean
  ) => Promise<void>;
  listApiConfigs: () => Promise<ApiConfigRecord[]>;
  upsertApiConfig: (config: ApiConfigInput) => Promise<void>;
  deleteApiConfig: (profileName: string) => Promise<void>;
  listSystemPrompts: () => Promise<SystemPromptItemRecord[]>;
  upsertSystemPrompt: (item: SystemPromptItemInput) => Promise<void>;
  deleteSystemPrompt: (promptId: string) => Promise<void>;
  listCustomHeaderSchemes: () => Promise<CustomHeaderSchemeRecord[]>;
  upsertCustomHeaderScheme: (item: CustomHeaderSchemeInput) => Promise<void>;
  deleteCustomHeaderScheme: (schemeId: string) => Promise<void>;
  listWorkspaceDirectories: () => Promise<WorkspaceDirectoryRecord[]>;
  upsertWorkspaceDirectory: (item: WorkspaceDirectoryInput) => Promise<void>;
  activateWorkspaceDirectory: (directoryId: string) => Promise<void>;
  listInstalledIdes: () => Promise<IdeInfo[]>;
  openInIde: (ideId: string, projectPath: string) => Promise<void>;
  reorderWorkspaceDirectories: (
    items: WorkspaceDirectoryInput[]
  ) => Promise<void>;
  deleteWorkspaceDirectory: (directoryId: string) => Promise<void>;
  createProjectDirectory: (
    parentPath: string,
    projectName: string
  ) => Promise<string>;
  readDirectoryEntries: (dirPath: string) => Promise<DirectoryEntry[]>;
  renameWorkspaceEntry: (
    rootPath: string,
    entryPath: string,
    newName: string
  ) => Promise<void>;
  deleteWorkspaceEntry: (rootPath: string, entryPath: string) => Promise<void>;
  readFileContent: (filePath: string) => Promise<FileContentResult>;
  writeFileContent: (filePath: string, content: string) => Promise<void>;
  searchFiles: (rootDir: string, query: string) => Promise<FileSearchResult[]>;
  searchFilesByAgent: (
    query: string,
    workspacePath: string,
    onProgress: ((chunk: FileSearchAgentProgress) => void) | undefined
  ) => Promise<FileSearchResult[]>;
  listMcpServerConfigs: () => Promise<McpServerConfigRecord[]>;
  upsertMcpServerConfig: (item: McpServerConfigInput) => Promise<void>;
  deleteMcpServerConfig: (serverId: string) => Promise<void>;
  listProjectMcpServerConfigs: (
    projectId: string
  ) => Promise<ProjectMcpServerConfigRecord[]>;
  upsertProjectMcpServerConfig: (
    projectId: string,
    item: McpServerConfigInput
  ) => Promise<void>;
  deleteProjectMcpServerConfig: (
    projectId: string,
    serverId: string
  ) => Promise<void>;
  listImportResources: () => Promise<ImportResourceRecord[]>;
  upsertImportResources: (items: ImportResourceInput[]) => Promise<void>;
  commitImportTransaction: (
    input: ImportDatabaseTransactionInput
  ) => Promise<void>;
  releaseImportResource: (
    input: ImportResourceReleaseInput
  ) => Promise<ImportResourceRelease>;
  listPlugins: () => Promise<PluginRecord[]>;
  upsertPlugins: (items: PluginInput[]) => Promise<void>;
  setPluginState: (
    pluginId: string,
    state: PluginInput["state"]
  ) => Promise<void>;
  deletePlugin: (pluginId: string) => Promise<void>;
  listPluginMarketplaces: () => Promise<PluginMarketplaceRecord[]>;
  upsertPluginMarketplace: (item: PluginMarketplaceInput) => Promise<void>;
  deletePluginMarketplace: (marketplaceId: string) => Promise<void>;
  listHookConfigs: (
    scope: HookScope,
    projectId?: string
  ) => Promise<HookConfigRecord[]>;
  upsertHookConfig: (item: HookConfigInput) => Promise<void>;
  deleteHookConfig: (
    hookType: string,
    scope: HookScope,
    projectId?: string
  ) => Promise<void>;
  executeHooks: (input: HookExecuteInput) => Promise<HookExecuteResult>;
  listSubAgentConfigs: (projectId?: string) => Promise<SubAgentConfigRecord[]>;
  getSubAgentConfig: (
    agentId: string,
    projectId?: string
  ) => Promise<SubAgentConfigRecord | null>;
  upsertSubAgentConfig: (item: SubAgentConfigInput) => Promise<void>;
  deleteSubAgentConfig: (agentId: string, projectId?: string) => Promise<void>;
  listSensitiveCommandConfigs: () => Promise<SensitiveCommandConfigRecord[]>;
  upsertSensitiveCommandConfig: (
    item: SensitiveCommandConfigInput
  ) => Promise<void>;
  deleteSensitiveCommandConfig: (commandId: string) => Promise<void>;
  listProjectSensitiveCommandConfigs: (
    projectId: string
  ) => Promise<ProjectSensitiveCommandConfigRecord[]>;
  setProjectSensitiveCommandEnabled: (
    projectId: string,
    commandId: string,
    enabled: boolean
  ) => Promise<void>;
  upsertProjectSensitiveCommandConfig: (
    projectId: string,
    item: ProjectSensitiveCommandConfigInput
  ) => Promise<void>;
  deleteProjectSensitiveCommandConfig: (
    projectId: string,
    commandId: string
  ) => Promise<void>;
  checkSensitiveCommandMatch: (
    command: string,
    projectId?: string
  ) => Promise<
    Array<{
      commandId: string;
      pattern: string;
      description: string;
    }>
  >;
  listChatConversations: (
    directoryId: string
  ) => Promise<ChatConversationRecord[]>;
  listChatConversationsPaginated: (
    directoryId: string,
    limit: number,
    offset: number
  ) => Promise<ChatConversationPage>;
  /** 跨项目按会话 ID 查询会话记录（供「跨项目通知」使用）。 */
  listChatConversationsByIds: (
    conversationIds: string[]
  ) => Promise<ChatConversationRecord[]>;
  listPinnedConversations: (
    directoryId: string
  ) => Promise<ChatConversationRecord[]>;
  searchChatConversations: (
    query: string
  ) => Promise<ConversationSearchResult[]>;
  getChatConversation: (
    conversationId: string
  ) => Promise<ChatConversationRecord | null>;
  listSubAgentConversations: (
    parentConversationId: string
  ) => Promise<ChatConversationRecord[]>;
  listSubAgentConversationsByParents: (
    parentConversationIds: string[]
  ) => Promise<Record<string, ChatConversationRecord[]>>;
  createSubAgentSession: (
    conversationId: string,
    parentConversationId: string,
    agentId: string,
    agentName: string,
    directoryId: string,
    apiProfileName: string,
    model: string,
    title: string
  ) => Promise<void>;
  updateSubAgentSessionStatus: (
    conversationId: string,
    runStatus: string,
    errorMessage: string
  ) => Promise<void>;
  cancelRunningSubAgentSessions: () => Promise<number>;
  updateConversationStatus: (
    conversationId: string,
    status: string
  ) => Promise<void>;
  renameConversation: (conversationId: string, title: string) => Promise<void>;
  updateConversationEmoji: (
    conversationId: string,
    emoji: string
  ) => Promise<void>;
  updateConversationApiProfile: (
    conversationId: string,
    profileName: string
  ) => Promise<void>;
  deleteConversation: (conversationId: string) => Promise<void>;
  deleteConversations: (conversationIds: string[]) => Promise<void>;
  appendToolMessage: (conversationId: string, content: string) => Promise<void>;
  listChatMessages: (conversationId: string) => Promise<ChatMessageRecord[]>;
  listUserMessages: (conversationId: string) => Promise<UserMessageSummary[]>;
  listChatMessagesPaginated: (
    conversationId: string,
    beforeMessageId: string,
    limit: number
  ) => Promise<ChatMessagePage>;
  findLatestToolResult: (
    conversationId: string,
    toolName: string
  ) => Promise<string | null>;
  forkConversation: (
    sourceConversationId: string,
    upToResponseId: string
  ) => Promise<ChatConversationRecord>;
  generateConversationSummary: (conversationId: string) => Promise<string>;
  cancelConversationSummary: (conversationId: string) => boolean;
  fetchAvailableModels: () => Promise<Model[]>;
  fetchAvailableModelsForConfig: (config: ApiModelsConfig) => Promise<Model[]>;
  createResponseStream: (
    request: ResponsesApiRequest,
    onChunk: (chunk: ResponsesApiStreamChunk) => void,
    streamId: string
  ) => Promise<ResponsesApiResult>;
  abortResponseStream: (streamId: string) => boolean;
  abortToolExecution: (toolExecutionId: string) => boolean;
  listMcpTools: () => Promise<McpToolDefinition[]>;
  listAvailableSkills: (projectId?: string) => Promise<SkillDefinition[]>;
  setSkillEnabled: (
    projectId: string | undefined,
    skillId: string,
    enabled: boolean
  ) => Promise<void>;
  listProjectSkills: (projectId: string) => Promise<ProjectSkillDefinition[]>;
  setProjectSkillEnabled: (
    projectId: string,
    skillId: string,
    enabled: boolean
  ) => Promise<void>;
  installSkillFromGithub: (
    url: string,
    location: "global" | "project",
    projectId?: string
  ) => Promise<SkillBatchInstallResult>;
  uninstallGithubSkill: (
    skillId: string,
    projectId?: string
  ) => Promise<SkillUninstallResult>;
  listGithubSkills: () => Promise<GithubSkillRecord[]>;
  listMcpServerTools: (configServerId: string) => Promise<McpToolDefinition[]>;
  listMcpProjectServers: (
    projectId: string
  ) => Promise<McpProjectServerStatus[]>;
  listMcpProjectServerTools: (
    projectId: string,
    serverId: string
  ) => Promise<McpProjectToolStatus[]>;
  setMcpProjectServerEnabled: (
    projectId: string,
    serverId: string,
    enabled: boolean
  ) => Promise<void>;
  setMcpProjectToolEnabled: (
    projectId: string,
    toolName: string,
    enabled: boolean
  ) => Promise<void>;
  authorizeSensitiveCommand: (command: string, token: string) => Promise<void>;
  writeInteractiveStdin: (sessionId: string, input: string) => Promise<void>;
  callMcpTool: (
    toolFullName: string,
    argsJson: string,
    projectId: string | undefined,
    checkpointIds: string[] | undefined,
    checkpointWorkDir: string | undefined,
    sensitiveAuthorizationToken: string | undefined,
    onChunk: (chunk: BashStreamChunk) => void,
    onBrowserCommand: (command: BrowserCommand) => Promise<string>,
    onUserQuestion: (question: UserQuestionCommand) => Promise<string>,
    onAppControl: (command: AppControlCommand) => Promise<string>,
    onRemoteWorkspaceCommand: (
      command: RemoteWorkspaceCommand
    ) => Promise<string>,
    onTerminalCommand: (command: TerminalCommand) => Promise<string>,
    subAgentAllowedTools: string[] | undefined,
    planMode: boolean | undefined,
    planApproved: boolean | undefined
  ) => Promise<string>;
  engineInfo: () => string;
  sum: (a: number, b: number) => number;
  detectTerminals: () => Promise<DetectedTerminal[]>;
  getGitStatus: (repoPath: string) => Promise<GitStatusResult>;
  getGitBranches: (repoPath: string) => Promise<GitBranch[]>;
  gitStageFiles: (
    repoPath: string,
    filePaths: string[]
  ) => Promise<GitStageResult>;
  gitUnstageFiles: (
    repoPath: string,
    filePaths: string[]
  ) => Promise<GitStageResult>;
  gitStageAll: (repoPath: string) => Promise<GitStageResult>;
  gitUnstageAll: (repoPath: string) => Promise<GitStageResult>;
  gitCommit: (repoPath: string, message: string) => Promise<GitCommitResult>;
  gitPush: (repoPath: string) => Promise<GitPushPullResult>;
  gitPull: (repoPath: string) => Promise<GitPushPullResult>;
  gitFetch: (repoPath: string) => Promise<GitPushPullResult>;
  gitCheckout: (
    repoPath: string,
    branchName: string
  ) => Promise<GitCheckoutResult>;
  gitCreateBranch: (
    repoPath: string,
    branchName: string
  ) => Promise<GitCheckoutResult>;
  gitFileDiff: (
    repoPath: string,
    filePath: string,
    staged: boolean
  ) => Promise<GitDiffResult>;
  gitDiscardChanges: (
    repoPath: string,
    filePaths: string[]
  ) => Promise<GitStageResult>;
  getGitLog: (
    repoPath: string,
    skip: number,
    limit: number
  ) => Promise<GitLogEntry[]>;
  getGitCommitFiles: (
    repoPath: string,
    hash: string
  ) => Promise<GitCommitFile[]>;
  getCommitDiff: (
    repoPath: string,
    hash: string
  ) => Promise<GitDiffResult>;
  gitCommitFileDiff: (
    repoPath: string,
    hash: string,
    filePath: string
  ) => Promise<GitDiffResult>;
  discoverGitRepos: (rootPath: string) => Promise<GitRepoInfo[]>;
  startGitWatch: (
    repoPath: string,
    onChange: (repoPath: string) => void
  ) => void;
  stopGitWatch: (repoPath: string) => void;
  generateCommitMessage: (
    repoPath: string,
    onChunk: (chunk: ResponsesApiStreamChunk) => void,
    streamId: string
  ) => Promise<ResponsesApiResult>;
  generateCommitMessageFromDiff: (
    diff: string,
    onChunk: (chunk: ResponsesApiStreamChunk) => void,
    streamId: string
  ) => Promise<ResponsesApiResult>;
  generateThemePalette: (
    imagePath: string,
    profileName: string,
    onChunk: (chunk: ResponsesApiStreamChunk) => void,
    streamId: string
  ) => Promise<ResponsesApiResult>;
  createCheckpoint: (workDir: string) => Promise<string>;
  restoreCheckpoint: (checkpointId: string, workDir: string) => Promise<void>;
  deleteCheckpoint: (checkpointId: string) => Promise<void>;
  listCheckpointChanges: (
    checkpointId: string,
    workDir: string
  ) => Promise<CheckpointFileChange[]>;
  listCheckpointDiffs: (
    checkpointId: string,
    workDir: string,
    includeAll?: boolean
  ) => Promise<CheckpointFileDiff[]>;
  truncateConversationFromResponse: (
    conversationId: string,
    responseId: string
  ) => Promise<void>;
  listTodosForRollback: (
    sessionId: string,
    responseId: string
  ) => Promise<string>;
  listUsageRecords: (
    conversationId: string,
    directoryId: string,
    limit: number,
    offset: number
  ) => Promise<UsageRecordPage>;
  getUsageSummary: (since: string, until: string) => Promise<UsageSummary>;
  getUsageDailyBreakdown: (
    since: string,
    until: string
  ) => Promise<DailyUsageBreakdown[]>;
  writeAppLog: (input: AppLogInput) => Promise<void>;
  listAppLogs: (
    level: string,
    module: string,
    since: string,
    until: string,
    limit: number,
    offset: number
  ) => Promise<AppLogPage>;
  clearAppLogs: () => Promise<number>;
  exportConversation: (
    conversationId: string,
    format: string
  ) => Promise<string>;
  listMemos: (
    directoryId: string,
    limit: number,
    offset: number,
    status?: string
  ) => Promise<MemoPage>;
  createMemo: (directoryId: string, content: string) => Promise<MemoRecord>;
  updateMemoContent: (memoId: string, content: string) => Promise<MemoRecord>;
  updateMemoStatus: (memoId: string, status: string) => Promise<MemoRecord>;
  deleteMemo: (memoId: string) => Promise<void>;
  getMemoCountSummary: (directoryId: string) => Promise<MemoCountSummary>;
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
  /** 探测本机浏览器（Chrome/Edge/Chromium/Firefox）及其配置文件与数据量 */
  browserImportListSources: () => Promise<BrowserImportSource[]>;
  /** 解密并导出指定浏览器配置文件的已保存密码（明文，仅供主进程加密落盘） */
  browserImportPasswords: (
    sourceId: string,
    profile: string
  ) => Promise<ImportedBrowserPassword[]>;
  /** 解析指定浏览器配置文件的 Cookie（Chrome 系已解密） */
  browserImportCookies: (
    sourceId: string,
    profile: string
  ) => Promise<ImportedBrowserCookie[]>;
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
