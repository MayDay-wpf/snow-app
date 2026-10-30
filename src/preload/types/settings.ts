export type ProxyBrowserSettings = {
  enabled: boolean;
  host: string;
  port: number;
  browserPath: string;
  browserDebugPort: number;
  /** 参与联网搜索的搜索引擎 id 列表（多引擎混合检索，至少一个）。 */
  searchEngines: string[];
  /** 正则表达式列表，匹配的站点从联网搜索结果中过滤且禁止抓取。 */
  blockedPatterns: string[];
};

export type TerminalSettings = {
  shellPath: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: string;
  lineHeight: number;
  /** 是否启用 GPU（WebGL2）渲染器加速终端绘制；不可用时自动回退 DOM 渲染。 */
  gpuRendering: boolean;
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
  /** 关闭的本地脱敏规则 id；省略时后端保留已存储值。 */
  disabledRules?: string[];
  /** 自定义脱敏规则；省略时后端保留已存储值。 */
  customRules?: PrivacyCustomRule[];
};

export type PrivacyCustomRule = {
  id: string;
  name: string;
  pattern: string;
  /** 遮罩的捕获组，0 为整段匹配。 */
  group: number;
  /** 替换文本；为空时按字符替换为 *。 */
  replacement: string;
  enabled: boolean;
};

export type PrivacyRuleInfo = {
  id: string;
  group: string;
  label: string;
  example: string;
};

/** Per-conversation Goal/WorkTree/WorkFlow Mode overrides. `null` means the
 *  conversation has never been configured and follows the global default. */
export type ConversationModesResult = {
  goalMode: boolean | null;
  worktreeMode: boolean | null;
  workflowMode: boolean | null;
  goalModeTokenBudget: number | null;
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

export type ConversationRuntimeConfig = {
  thinkingStrength: string | null;
  responsesFastMode: string | null;
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
  accentColor: string;
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
  /** 背景来源：image（自定义图片）| pet（桌面宠物 idle 动画） */
  source: string;
  /** 背景图片列表（source 为 image 时生效，首张为初始显示图） */
  imagePaths: string[];
  /** 宠物背景使用的已安装宠物 id */
  petId: string;
  /** 宠物背景大小：相对视口高度的比例 */
  petScale: number;
  opacity: number;
  blur: number;
  /** 是否开启自动轮播（图片数量 >= 2 时生效） */
  carouselEnabled: boolean;
  /** 轮播切换间隔（秒） */
  carouselIntervalSecs: number;
  /** 轮播播放顺序：sequential | random */
  carouselOrder: string;
  /** 当前显示 / 固定的背景图路径（空表示取列表首张） */
  currentImagePath: string;
};

/** 受管背景图目录中的历史图片条目（用于「历史图片」选择与清理）。 */
export type ThemeBackgroundHistoryEntry = {
  /** 受管目录下的完整文件路径 */
  path: string;
  /** 文件名（bg-<时间戳>-<随机串>.<扩展名>） */
  fileName: string;
  /** 文件修改时间（毫秒时间戳） */
  modifiedAt: number;
  /** 文件大小（字节） */
  size: number;
};

export type ThemeStreamCursor = {
  iconType: string;
  lucideName: string;
  svgPath: string;
  iconSize: number;
};

/** 排版设置：界面字号（驱动整页缩放）+ 正文字重 + 聊天正文字号 / 行高 + 代码字号。 */
export type ThemeTypography = {
  fontSize: number;
  fontWeight: number;
  chatFontSize: number;
  chatLineHeight: number;
  codeFontSize: number;
};

/** 聊天窗口风格：IM 模式 + 头像（空路径为默认头像）。 */
export type ThemeChatStyle = {
  imMode: boolean;
  aiAvatarPath: string;
  userAvatarPath: string;
};

export type ThemeSettings = {
  mode: ThemeMode;
  presetId: string;
  layoutStyle: "island" | "layered" | "flush";
  custom: CustomTheme;
  background: ThemeBackground;
  fontFamily: string;
  streamCursor: ThemeStreamCursor;
  typography: ThemeTypography;
  chatStyle: ThemeChatStyle;
};

export type DetectedTerminal = {
  name: string;
  path: string;
  family: "powershell" | "cmd" | "wsl" | "posix";
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
  /** 代理审查选用的决策模型 id（空 = 使用基础 LLM 模型）。决策模型配置在 API 配置页维护。 */
  agentReviewModelId: string;
  /** 决策模型审查的相关性阈值（0-1）；null = 二分类 choice 判定。 */
  agentReviewRelevanceThreshold: number | null;
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
  requestMethod: string;
  totalRequests: number;
  errorRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationInputTokens: number;
  totalCacheReadInputTokens: number;
  totalTokens: number;
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

/** 系统日志导出结果：canceled 为用户取消对话框，files 为写入的文件路径。 */
export type AppLogExportResult = {
  canceled: boolean;
  files: string[];
  count: number;
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

/** 项目最近一次失败的索引运行（保留到下次索引开始，供代码库面板回看）。 */
export type CodebaseEmbedFailure = {
  sessionId: string;
  error: string;
  processedFiles: number;
  totalFiles: number;
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
  /** 风险等级 key（low / medium / high）；provider 未给出时为空，不参与放行判定。 */
  severity?: string | null;
  /** 风险 score 原值（档位概率加权平均），仅展示与日志。 */
  severityScore?: number | null;
  /** 决策模型托管：判定直接生效，不再弹拦截提示。 */
  delegate: boolean;
  /** 托管下判定拒绝时转人工确认（已与 delegate 合并：托管关闭时恒为 false）。 */
  askOnDeny: boolean;
  /** 参与判定的决策模型名称。 */
  modelName: string;
  /** 本次判定是否开启了会话上下文开关。 */
  contextEnabled?: boolean;
  /** 实际发送给决策模型的会话消息条数。 */
  contextMessages?: number;
  /** 会话上下文超出预算被截断（判定依据不完整）。 */
  contextTruncated?: boolean;
  /** 开关打开但没有可用上下文，按无上下文判定。 */
  contextEmpty?: boolean;
  /** 决策模型不可用（未选择 / 已停用 / 配置不完整 / 请求失败）的原因；此时回退人工确认。 */
  error?: string | null;
};

/** 待检测的决策模型（字段与决策模型配置一致，可以是尚未保存的草稿）。 */
export type DecisionModelTestInput = {
  id: string;
  baseUrl: string;
  baseUrlMode: string;
  provider: string;
  apiKey: string;
  model: string;
};

/** 待检测的嵌入模型配置（dimensions 为 0 表示不指定维度）。 */
export type EmbeddingTestInput = {
  embeddingType: string;
  modelName: string;
  baseUrl: string;
  apiKey: string;
  dimensions: number;
};

/** 待检测的重排模型配置。 */
export type RerankingTestInput = {
  modelName: string;
  baseUrl: string;
  apiKey: string;
};

/** 一次模型连接自检的结果（持久化，重启后仍可查看）。 */
export type ModelConnectionTestResult = {
  /** 决策模型为其 id，嵌入 / 重排为空。 */
  targetId: string;
  ok: boolean;
  httpStatus?: number | null;
  latencyMs: number;
  endpoint: string;
  model: string;
  /** 嵌入：实际返回的向量维度。 */
  dimension?: number | null;
  /** 嵌入：配置的向量维度。 */
  expectedDimension?: number | null;
  error?: string | null;
  /** 检测时间（Unix 毫秒）。 */
  testedAt: number;
};

/** 三类模型最近一次连接自检的结果。 */
export type ModelHealthSnapshot = {
  decision: ModelConnectionTestResult[];
  embedding?: ModelConnectionTestResult | null;
  reranking?: ModelConnectionTestResult | null;
};

// ===== Keyboard shortcuts =====

export type KeyboardShortcutAction =
  | "cancelSession"
  | "openSearch"
  | "openMemo"
  | "openTodo"
  | "cycleProject"
  | "openProjectExplorer"
  | "openProjectMemory"
  | "openScheduledTasks"
  | "openPlugins"
  | "cycleApiProfile"
  | "toggleWindow"
  | "togglePet"
  | "focusInput"
  | "toggleSidebar"
  | "toggleRightPanel"
  | "newChat"
  | "sendMessage"
  | "sendMessageNow"
  | "stopGeneration"
  | "prevConversation"
  | "nextConversation"
  | "scrollToTop"
  | "scrollToBottom"
  | "openSettings"
  | "copyLastResponse"
  | "toggleRightPanelFullscreen"
  | "showShortcutHelp"
  | "toggleMessageTime"
  | "uiZoomIn"
  | "uiZoomOut"
  | "uiZoomReset"
  | "newChatInNewWindow"
  | "cycleDetachedWindow"
  | "browserToggleShareWithAgent"
  | "browserPickElement";

export type KeyboardShortcutConfig = {
  /**
   * 平台无关的规范化按键绑定。
   * `mod` 代表平台主修饰键（macOS=Cmd，其他=Ctrl），主键用小写。
   * 例如 `mod+f`、`escape`、`mod+backtick`。
   */
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
  /** 立即发送：输入框有内容就立即发出，输入为空则发第一条待发送消息。 */
  sendMessageNow: KeyboardShortcutConfig;
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
  uiZoomIn: KeyboardShortcutConfig;
  uiZoomOut: KeyboardShortcutConfig;
  uiZoomReset: KeyboardShortcutConfig;
  newChatInNewWindow: KeyboardShortcutConfig;
  cycleDetachedWindow: KeyboardShortcutConfig;
  /** 共享当前浏览器标签页给 Agent（仅浏览器面板激活时生效） */
  browserToggleShareWithAgent: KeyboardShortcutConfig;
  /** 选择浏览器页面元素（仅浏览器面板激活且有页面时生效） */
  browserPickElement: KeyboardShortcutConfig;
};

// ===== App lock =====

/** 应用锁状态：PIN 与谷歌身份验证器（TOTP）绑定情况、锁定延时与当前锁定态。 */
export type AppLockState = {
  enabled: boolean;
  hasPin: boolean;
  totpBound: boolean;
  remoteUnlock: boolean;
  delayMs: number;
  locked: boolean;
};

/** 校验结果：失败时给出剩余尝试次数或等待冷却时间。 */
export type AppLockVerifyResult = {
  ok: boolean;
  retryAfterMs: number;
  remainingAttempts: number;
};

/** 身份验证器绑定信息：Base32 密钥与 otpauth 二维码地址。 */
export type AppLockTotpBinding = {
  secret: string;
  otpauthUri: string;
};
