import type { RefObject } from "react";
import type { LucideIcon } from "lucide-react";
import type { ApiConfigRecord, Model, TokenUsage } from "../../../../preload";
import type { MainContentView } from "../types";
import type { ScheduledTaskRunOptions } from "../../../../preload";

export type ConversationInputRuntimeState = {
  model: string;
  apiProfile: string;
  thinkingStrength: string | null;
  responsesFastMode: boolean | null;
};

export type ConversationRuntimeConfigOverride = {
  thinkingStrength: string | null;
  responsesFastMode: boolean | null;
};

export type ChatInputSendOptions = {
  model?: string;
  apiProfile?: string;
  /** 回合类型：review 表示代码审查任务（桌面宠物播放 review 专属动画）。 */
  kind?: "chat" | "review";
  /** Optional one-shot basic-model snapshot used only for the first title
   *  generation. It is never forwarded to the main Provider request. */
  basicModel?: string;
  /** Effective thinking strength for this request ("none" | "low" | "medium" |
   *  "high" | custom). Applied in-memory; never mutates the profile config. */
  thinkingStrength?: string;
  /** Per-request Responses Fast Mode value. `null` means use the profile
   *  default and is ignored by non-Responses request methods. */
  responsesFastMode?: boolean | null;
  /** Snapshot of the conversation-level overrides to persist after a pending
   *  session receives its first real conversation id. `null` means inherit the
   *  selected profile default for that field. */
  conversationRuntimeConfigOverride?: ConversationRuntimeConfigOverride;
  /** 内部字段：程序化发送（pending 队列自动冲刷）显式指定目标会话 key，
   *  覆盖当前视图会话。仅渲染进程内部使用，用户发送路径不设置。 */
  targetSessionKey?: string;
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
  autoSendToken?: number;
  onDraftRestored?: () => void;
  /** One-shot per-send overrides queued by buildFromContent (scheduled task
   *  runs). The auto-send effect merges them into the send options, then calls
   *  onAutoSendOverrideConsumed so they never leak into later manual sends. */
  autoSendOverride?: ScheduledTaskRunOptions | null;
  onAutoSendOverrideConsumed?: () => void;
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
  pendingMessages?: string[];
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
  planMode?: boolean;
  isUpdatingPlanMode?: boolean;
  onPlanModeChange?: (enabled: boolean) => void;
  onRefreshPlanMode?: () => Promise<boolean | void>;
  goalMode?: boolean;
  isUpdatingGoalMode?: boolean;
  onGoalModeChange?: (enabled: boolean) => void;
  onRefreshGoalMode?: () => Promise<boolean | void>;
  worktreeMode?: boolean;
  isUpdatingWorktreeMode?: boolean;
  onWorktreeModeChange?: (enabled: boolean) => void;
  onRefreshWorktreeMode?: () => Promise<boolean | void>;
  goalModeTokenBudget?: number;
  onGoalModeTokenBudgetChange?: (budget: number) => void;
  autoScrollEnabled?: boolean;
  onAutoScrollChange?: (enabled: boolean) => void;
  autoFormatEnabled?: boolean;
  onAutoFormatChange?: (enabled: boolean) => void;
  onRefreshAutoFormat?: () => void | Promise<boolean | void>;
  isCompacting?: boolean;
};

export type RequestMethod = "chat" | "responses" | "gemini" | "anthropic" | "interactions";

/** 模型选择菜单的二级视图。 */
export type ModelMenuView = "root" | "model" | "thinking" | "apiProfile";

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
  thinkingLabel: string;
  thinkingDefaultLabel: string;
  ActiveThinkingIcon: LucideIcon;
  isLoadingApiConfig: boolean;
  isSavingThinking: boolean;
  thinkingError: string | null;
  responsesFastModeEnabled: boolean;
  responsesFastModeOverride: boolean | null;
  isSavingFastMode: boolean;
  fastModeError: string | null;
  labels: ChatInputLabels;
  isStreaming: boolean;
  isAborting: boolean;
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
  handleSend: () => void;
  handleAbort: () => void;
  handleKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  handleSelectModel: (modelId: string) => Promise<void>;
  handleOpenManualMode: () => void;
  handleConfirmManualModel: () => Promise<void>;
  handleManualKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  handleRetryFetchModels: () => Promise<void>;
  handleToggleModelMenu: () => void;
  setModelMenuView: (view: ModelMenuView) => void;
  handleOpenApiProfileMenu: () => void;
  handleSelectApiProfile: (profileName: string) => Promise<void>;
  handleSelectThinking: (nextValue: string) => Promise<void>;
  handleToggleResponsesFastMode: () => Promise<void>;
  handleResetResponsesFastMode: () => Promise<void>;
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
    pendingMessages: string[];
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
    planMode: boolean;
    isUpdatingPlanMode: boolean;
    onPlanModeChange?: (enabled: boolean) => void;
    onRefreshPlanMode?: () => Promise<boolean | void>;
    goalMode: boolean;
    isUpdatingGoalMode: boolean;
    onGoalModeChange?: (enabled: boolean) => void;
    onRefreshGoalMode?: () => Promise<boolean | void>;
    worktreeMode: boolean;
    isUpdatingWorktreeMode: boolean;
    onWorktreeModeChange?: (enabled: boolean) => void;
    onRefreshWorktreeMode?: () => Promise<boolean | void>;
    goalModeTokenBudget: number;
    onGoalModeTokenBudgetChange?: (budget: number) => void;
    autoScrollEnabled: boolean;
    onAutoScrollChange?: (enabled: boolean) => void;
    autoFormatEnabled: boolean;
    onAutoFormatChange?: (enabled: boolean) => void;
    onRefreshAutoFormat?: () => void | Promise<boolean | void>;
    isCompacting: boolean;
  };
