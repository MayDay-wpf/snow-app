import type { RefObject } from "react";
import type { LucideIcon } from "lucide-react";
import type { ApiConfigRecord, Model, TokenUsage } from "../../../../preload";
import type { MainContentView } from "../types";

export type ConversationInputRuntimeState = {
  model: string;
  apiProfile: string;
  thinkingStrength: string | null;
  responsesFastMode: string | null;
};

export type ConversationRuntimeConfigOverride = {
  thinkingStrength: string | null;
  responsesFastMode: string | null;
};

/** 输入区 WorkFlow 手动编排器画布上的一个节点（用户自己绘制，非 AI 生成）。 */
export type WorkflowComposerNode = {
  id: string;
  label: string;
  prompt: string;
  description?: string;
  apiProfile?: string;
  model?: string;
  /** 画布坐标（回滚还原时保持原布局）。 */
  position?: { x: number; y: number };
};

/** 输入区 WorkFlow 手动编排器画布：一张由用户绘制、随消息提交的编排图。 */
export type WorkflowComposerGraph = {
  title: string;
  nodes: WorkflowComposerNode[];
  edges: { source: string; target: string }[];
};

/** 回滚编排提交消息时回填编排器的一次性状态（不写回输入框）。 */
export type RollbackWorkflowComposerState = {
  graph: WorkflowComposerGraph;
  note: string;
};

export type ChatInputSendOptions = {
  /** Source of the submitted message; omitted means unverified. */
  origin?: "user" | "internal" | "unknown";
  /** Manual busy-send intent. Omitted programmatic sends always queue. */
  deliveryMode?: "queue" | "steer";
  model?: string;
  apiProfile?: string;
  /** 回合类型：review = 代码审查；workflow = 用户手动编排的 WorkFlow 提交。 */
  kind?: "chat" | "review" | "workflow";
  /** 内部字段：手动编排的工作流图（仅输入区编排器弹窗设置）。存在时本次发送
   *  不请求模型，直接生成 workflow-workflow-generate 调用，本轮强制 WorkFlow 模式。 */
  workflowGraph?: WorkflowComposerGraph;
  /** Optional one-shot basic-model snapshot used only for the first title
   *  generation. It is never forwarded to the main Provider request. */
  basicModel?: string;
  /** Effective thinking strength for this request ("none" | "low" | "medium" |
   *  "high" | custom). Applied in-memory; never mutates the profile config. */
  thinkingStrength?: string;
  /** Per-request Responses Fast Mode tier ("off" | "fast" | "ultrafast").
   *  `null` means use the profile default and is ignored by non-Responses
   *  request methods. */
  responsesFastMode?: string | null;
  /** Snapshot of the conversation-level overrides to persist after a pending
   *  session receives its first real conversation id. `null` means inherit the
   *  selected profile default for that field. */
  conversationRuntimeConfigOverride?: ConversationRuntimeConfigOverride;
  /** 内部字段：程序化发送（pending 队列自动冲刷）显式指定目标会话 key，
   *  覆盖当前视图会话。仅渲染进程内部使用，用户发送路径不设置。 */
  targetSessionKey?: string;
  /** Renderer-owned batch delivery trace, never supplied by the model. */
  imageGenerationBatchId?: string;
  /** 内部字段：后台新建会话（startBackgroundConversation）的目标项目，仅决定
   *  新会话落在哪个项目；随本次发送传递，不经任何全局一次性状态。 */
  targetDirectoryId?: string;
  /** 内部字段：触发本次后台会话的定时任务名，用于消息列表的
   *  "由定时任务触发"横幅；仅对新会话首条消息生效。 */
  triggeredByTaskName?: string;
  /** 内部字段：本次 run 结束（含失败/中止/未能发送）时回调一次。 */
  onRunSettled?: (result: BackgroundRunResult) => void;
};

/** 后台 run 的结束结果（定时任务工作流节点用）。 */
export type BackgroundRunResult = {
  /** 真实会话 id；未能落库时为空。 */
  conversationId: string;
  /** 最后一条助手回复。 */
  output: string;
  success: boolean;
  error?: string;
};

/** buildFromContent 排队的一次前台自动发送请求，消费后整体出队。 */
export type AutoSendRequest = {
  id: number;
  content: string;
};

export type ChatInputProps = {
  placeholder?: string;
  projectId?: string;
  projectName?: string;
  conversationId?: string;
  onSend?: (message: string, options: ChatInputSendOptions) => void;
  /** 未配置 API 时引导跳转到 API 设置页。 */
  onNavigateToView?: (view: MainContentView) => void;
  isStreaming?: boolean;
  isAborting?: boolean;
  onAbort?: () => void;
  tokenUsage?: TokenUsage | null;
  draftToRestore?: string | null;
  onDraftRestored?: () => void;
  /** 回滚编排提交消息：回填并打编排器（编排图无法写进输入框）。 */
  rollbackWorkflowComposer?: RollbackWorkflowComposerState | null;
  onRollbackWorkflowRestored?: () => void;
  /** 当前待投递的自动发送请求（buildFromContent 队首）。输入区先 claim
   *  （同一请求只会被一个输入区实例认领一次），发送后 complete 推进队列。 */
  autoSendRequest?: AutoSendRequest | null;
  claimAutoSend?: (id: number) => boolean;
  completeAutoSend?: (id: number) => void;
  /** 按会话持久化输入草稿（文本+图片 chip）。 */
  saveInputDraft?: (
    conversationId: string | undefined,
    content: string,
  ) => void;
  getInputDraft?: (conversationId: string | undefined) => string | undefined;
  clearInputDraft?: (conversationId: string | undefined) => void;
  /** 回滚首条消息后新会话暂存的输入区配置。 */
  rollbackInputState?: ConversationInputRuntimeState | null;
  /** 记录当前输入区配置，覆盖未发送前尚未写入会话记录的模型选择。 */
  onRuntimeInputStateChange?: (state: ConversationInputRuntimeState) => void;
  /**
   * 读取会话的内存态输入选择（渠道/模型/思考强度/Fast Mode）。
   * 内存态是本次运行的权威值，hydration 时优先于数据库里的持久化快照。
   */
  getRuntimeInputState?: (
    conversationId: string,
  ) => ConversationInputRuntimeState | undefined;
  /**
   * 加载更早一页历史消息（ChatContent 实现，保留聊天视口锚点）。回滚目标
   * 超出已加载的分页窗口时，用于把它加载进内存消息窗口。
   */
  loadOlderMessages: () => Promise<void>;
  /** 输入区所在表面：main = 主内容区（承担全局 ESC 语义），panel = 右侧会话面板。 */
  surface?: "main" | "panel";
  pendingMessages?: string[];
  pendingMessageModes?: ("queue" | "steer")[];

  onWithdrawPendingMessage?: (index: number) => string | null;
  onSendPendingMessageNow?: (index: number) => void;
  onCompactConversation?: (
    model?: string,
    apiProfile?: string,
  ) => void | Promise<void>;
  yoloMode?: boolean;
  isUpdatingYoloMode?: boolean;
  onYoloModeChange?: (enabled: boolean) => void;
  onRefreshYoloMode?: () => Promise<boolean | void>;
  liteMode?: boolean;
  isUpdatingLiteMode?: boolean;
  onLiteModeChange?: (enabled: boolean) => void;
  onRefreshLiteMode?: () => Promise<boolean | void>;
  goalMode?: boolean;
  isUpdatingGoalMode?: boolean;
  onGoalModeChange?: (enabled: boolean) => void;
  onRefreshGoalMode?: () => Promise<boolean | void>;
  worktreeMode?: boolean;
  isUpdatingWorktreeMode?: boolean;
  onWorktreeModeChange?: (enabled: boolean) => void;
  onRefreshWorktreeMode?: () => Promise<boolean | void>;
  workflowMode?: boolean;
  isUpdatingWorkflowMode?: boolean;
  onWorkflowModeChange?: (enabled: boolean) => void;
  onRefreshWorkflowMode?: () => Promise<boolean | void>;
  goalModeTokenBudget?: number;
  onGoalModeTokenBudgetChange?: (budget: number) => void;
  autoFormatEnabled?: boolean;
  onAutoFormatChange?: (enabled: boolean) => void;
  onRefreshAutoFormat?: () => void | Promise<boolean | void>;
  toolCorrectionEnabled?: boolean;
  onToolCorrectionChange?: (enabled: boolean) => void;
  onRefreshToolCorrection?: () => void | Promise<boolean | void>;
  contextFoldEnabled?: boolean;
  onContextFoldChange?: (enabled: boolean) => void;
  onRefreshContextFold?: () => void | Promise<boolean | void>;
  isCompacting?: boolean;
};

export type RequestMethod =
  "chat" | "responses" | "gemini" | "anthropic" | "interactions";

/** 发送消息的快捷键模式："enter" = Enter 发送；"ctrlEnter" = Ctrl+Enter 发送。 */
export type SendKeyMode = "enter" | "ctrlEnter";

/** 模型选择菜单的二级视图。 */
export type ModelMenuView =
  "root" | "model" | "thinking" | "fastMode" | "apiProfile";

export type ThinkingOption = {
  value: string;
  label: string;
  icon: LucideIcon;
};

export type ChatInputState = {
  value: string;
  textareaRef: RefObject<HTMLDivElement | null>;
  apiConfigs: ApiConfigRecord[];
  selectedApiProfile: string;
  modelMenuView: ModelMenuView;
  isSubAgentConversation: boolean;
  models: Model[];
  selectedModel: string;
  displayModel: string;
  isLoadingModels: boolean;
  modelError: string | null;
  isModelMenuOpen: boolean;
  isManualMode: boolean;
  manualValue: string;
  dropdownRef: RefObject<HTMLDivElement | null>;
  runtimeApiConfig: ApiConfigRecord | null;
  requestMethod: RequestMethod;
  thinkingOptions: ThinkingOption[];
  thinkingValue: string;
  /** 会话生效的思考强度值（会话覆盖已解析，回退 Profile 默认）。 */
  effectiveThinkingValue: string;
  thinkingLabel: string;
  thinkingDefaultLabel: string;
  ActiveThinkingIcon: LucideIcon;
  isLoadingApiConfig: boolean;
  thinkingError: string | null;
  /** 会话生效的 Fast Mode 档位（"off" | "fast" | "ultrafast"）。 */
  responsesFastMode: string;
  responsesFastModeOverride: string | null;
  fastModeError: string | null;
  labels: ChatInputLabels;
  isStreaming: boolean;
  isAborting: boolean;
  sendKeyMode: SendKeyMode;
};

export type ChatInputLabels = {
  selectModel: string;
  selectApiProfile: string;
  loadModelsError: string;
  loadingModels: string;
  refreshModels: string;
  manualModel: string;
  manualModelPlaceholder: string;
  noModelsFound: string;
  searchModels: string;
  noMatchingModels: string;
  searchApiProfiles: string;
  noMatchingApiProfiles: string;
  cancel: string;
  confirm: string;
  retry: string;
  noApiConfig: string;
};

export type ChatInputActions = {
  setManualValue: (value: string) => void;
  setIsManualMode: (value: boolean) => void;
  handleChange: (value: string) => void;
  handleSend: (deliveryMode?: "queue" | "steer") => void;
  handleAbort: () => void;
  handleKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  handleSelectModel: (modelId: string) => Promise<void>;
  handleOpenManualMode: () => void;
  handleConfirmManualModel: () => Promise<void>;
  handleManualKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  handleRetryFetchModels: () => Promise<void>;
  handleApiConfigSaved: (
    configs: ApiConfigRecord[],
    previousProfileName: string | null,
    savedProfileName: string,
  ) => void;
  handleToggleModelMenu: () => void;
  setModelMenuView: (view: ModelMenuView) => void;
  handleOpenApiProfileMenu: () => void;
  handleSelectApiProfile: (profileName: string) => void;
  handleSelectThinking: (nextValue: string) => void;
  handleSelectResponsesFastMode: (tier: string) => void;
  setSendKeyMode: (mode: SendKeyMode) => void;
  restoreContent: (content: string) => void;
};

export type ChatInputViewProps = ChatInputState &
  ChatInputActions & {
    placeholder: string;
    projectId?: string;
    projectName?: string;
    /** 未配置 API 时引导跳转到 API 设置页。 */
    onNavigateToView?: (view: MainContentView) => void;
    tokenUsage: TokenUsage | null;
    /** 加载更早一页历史消息（保留聊天视口锚点）。 */
    loadOlderMessages: () => Promise<void>;
    /** 回滚编排提交消息：回填并打开编排器（编排图无法写进输入框）。 */
    rollbackWorkflowComposer?: RollbackWorkflowComposerState | null;
    onRollbackWorkflowRestored?: () => void;
    surface?: "main" | "panel";
    pendingMessages: string[];
    pendingMessageModes?: ("queue" | "steer")[];

    onWithdrawPendingMessage?: (index: number) => string | null;
    onSendPendingMessageNow?: (index: number) => void;
    onCompactConversation?: (
      model?: string,
      apiProfile?: string,
    ) => void | Promise<void>;
    yoloMode: boolean;
    isUpdatingYoloMode: boolean;
    onYoloModeChange?: (enabled: boolean) => void;
    onRefreshYoloMode?: () => Promise<boolean | void>;
    liteMode: boolean;
    isUpdatingLiteMode: boolean;
    onLiteModeChange?: (enabled: boolean) => void;
    onRefreshLiteMode?: () => Promise<boolean | void>;
    goalMode: boolean;
    isUpdatingGoalMode: boolean;
    onGoalModeChange?: (enabled: boolean) => void;
    onRefreshGoalMode?: () => Promise<boolean | void>;
    worktreeMode: boolean;
    isUpdatingWorktreeMode: boolean;
    onWorktreeModeChange?: (enabled: boolean) => void;
    onRefreshWorktreeMode?: () => Promise<boolean | void>;
    workflowMode: boolean;
    isUpdatingWorkflowMode: boolean;
    onWorkflowModeChange?: (enabled: boolean) => void;
    onRefreshWorkflowMode?: () => Promise<boolean | void>;
    goalModeTokenBudget: number;
    onGoalModeTokenBudgetChange?: (budget: number) => void;
    autoFormatEnabled: boolean;
    onAutoFormatChange?: (enabled: boolean) => void;
    onRefreshAutoFormat?: () => void | Promise<boolean | void>;
    toolCorrectionEnabled: boolean;
    onToolCorrectionChange?: (enabled: boolean) => void;
    onRefreshToolCorrection?: () => void | Promise<boolean | void>;
    contextFoldEnabled: boolean;
    onContextFoldChange?: (enabled: boolean) => void;
    onRefreshContextFold?: () => void | Promise<boolean | void>;
    isCompacting: boolean;
  };
