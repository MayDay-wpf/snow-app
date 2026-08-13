import type { RefObject } from "react";
import type { LucideIcon } from "lucide-react";
import type { ApiConfigRecord, Model, TokenUsage } from "../../../../preload";
import type { MainContentView } from "../types";
import type { ScheduledTaskRunOptions } from "../../../../preload";
export type ChatInputSendOptions = {
  model?: string;
  apiProfile?: string;
  /** 回合类型：review 表示代码审查任务（桌面宠物播放 review 专属动画）。 */
  kind?: "chat" | "review";
  /** Optional one-shot basic-model snapshot used only for the first title
   *  generation. It is never forwarded to the main Provider request. */
  basicModel?: string;
  /** Per-request thinking strength override ("none" | "low" | "medium" |
   *  "high" | custom). Applied in-memory; never mutates the profile config. */
  thinkingStrength?: string;
};
export type ChatInputProps = {
  placeholder?: string;
  projectId?: string;
  projectName?: string;
  conversationId?: string;
  onSend?: (message: string, options: ChatInputSendOptions) => void;
  /** 未配置 API 时引导跳转到 API 设置页。 */
  onNavigateToView?: (view: MainContentView) => void;
  /** 跳转到被附加的历史会话(输入框上方附件提示条点击)。 */
  onOpenConversation?: (conversationId: string) => void;
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
  /** 按会话持久化输入草稿（文本+图片 chip），切换会话/新建会话时
   *  ChatInput 会卸载，草稿由调用方（ConversationContext）保存，
   *  重新挂载后通过 getInputDraft 恢复、发送后 clearInputDraft。 */
  saveInputDraft?: (conversationId: string | undefined, content: string) => void;
  getInputDraft?: (conversationId: string | undefined) => string | undefined;
  clearInputDraft?: (conversationId: string | undefined) => void;
  pendingMessages?: string[];
  onWithdrawPendingMessage?: (index: number) => string | null;
  onSendPendingMessageNow?: (index: number) => void;
  onCompactConversation?: (
    model?: string,
    apiProfile?: string
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
  goalModeTokenBudget?: number;
  onGoalModeTokenBudgetChange?: (budget: number) => void;
  autoScrollEnabled?: boolean;
  onAutoScrollChange?: (enabled: boolean) => void;
  isCompacting?: boolean;
};

export type RequestMethod = "chat" | "responses" | "gemini" | "anthropic";

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
  ActiveThinkingIcon: LucideIcon;
  isLoadingApiConfig: boolean;
  isSavingThinking: boolean;
  thinkingError: string | null;
  responsesFastModeEnabled: boolean;
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
  restoreContent: (content: string) => void;
};

export type ChatInputViewProps = ChatInputState &
  ChatInputActions & {
    placeholder: string;
    projectId?: string;
    projectName?: string;
    /** 未配置 API 时引导跳转到 API 设置页。 */
    onNavigateToView?: (view: MainContentView) => void;
    /** 跳转到被附加的历史会话(输入框上方附件提示条点击)。 */
    onOpenConversation?: (conversationId: string) => void;
    tokenUsage: TokenUsage | null;
    pendingMessages: string[];
    onWithdrawPendingMessage?: (index: number) => string | null;
    onSendPendingMessageNow?: (index: number) => void;
    onCompactConversation?: (
      model?: string,
      apiProfile?: string
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
    goalModeTokenBudget: number;
    onGoalModeTokenBudgetChange?: (budget: number) => void;
    autoScrollEnabled: boolean;
    onAutoScrollChange?: (enabled: boolean) => void;
    isCompacting: boolean;
  };
