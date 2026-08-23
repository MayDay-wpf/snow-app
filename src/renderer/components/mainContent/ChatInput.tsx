import { ChatInputView } from "./chatInput/ChatInputView";
import { useChatInputController } from "./chatInput/useChatInputController";
import type { ChatInputProps } from "./chatInput/types";
import { useI18n } from "../../i18n";

export const ChatInput = ({
  placeholder,
  projectId,
  projectName,
  conversationId,
  onSend,
  onNavigateToView,
  isStreaming = false,
  isAborting = false,
  onAbort,
  tokenUsage = null,
  draftToRestore = null,
  autoSendToken = 0,
  onDraftRestored,
  autoSendOverride = null,
  onAutoSendOverrideConsumed,
  saveInputDraft,
  getInputDraft,
  clearInputDraft,
  rollbackInputState,
  onRuntimeInputStateChange,
  pendingMessages = [],
  onWithdrawPendingMessage,
  onSendPendingMessageNow,
  onCompactConversation,
  yoloMode = false,
  isUpdatingYoloMode = false,
  onYoloModeChange,
  onRefreshYoloMode,
  liteMode = false,
  isUpdatingLiteMode = false,
  onLiteModeChange,
  onRefreshLiteMode,
  planMode = false,
  isUpdatingPlanMode = false,
  onPlanModeChange,
  onRefreshPlanMode,
  goalMode = false,
  isUpdatingGoalMode = false,
  onGoalModeChange,
  onRefreshGoalMode,
  worktreeMode = false,
  isUpdatingWorktreeMode = false,
  onWorktreeModeChange,
  onRefreshWorktreeMode,
  goalModeTokenBudget = 2000000,
  onGoalModeTokenBudgetChange,
  autoScrollEnabled = false,
  onAutoScrollChange,
  autoFormatEnabled = false,
  onAutoFormatChange,
  onRefreshAutoFormat,
  isCompacting = false,
}: ChatInputProps): React.JSX.Element => {
  const { t } = useI18n();
  const controller = useChatInputController({
    projectId,
    conversationId,
    onSend,
    isStreaming,
    isAborting,
    onAbort,
    draftToRestore,
    autoSendToken,
    onDraftRestored,
    autoSendOverride,
    onAutoSendOverrideConsumed,
    saveInputDraft,
    getInputDraft,
    clearInputDraft,
    rollbackInputState,
    onRuntimeInputStateChange,
  });

  return (
    <ChatInputView
      placeholder={placeholder ?? t("chatInput.placeholder")}
      projectId={projectId}
      projectName={projectName}
      onNavigateToView={onNavigateToView}
      {...controller}
      tokenUsage={tokenUsage}
      pendingMessages={pendingMessages}
      onWithdrawPendingMessage={onWithdrawPendingMessage}
      onSendPendingMessageNow={onSendPendingMessageNow}
      onCompactConversation={onCompactConversation}
      yoloMode={yoloMode}
      isUpdatingYoloMode={isUpdatingYoloMode}
      onYoloModeChange={onYoloModeChange}
      onRefreshYoloMode={onRefreshYoloMode}
      liteMode={liteMode}
      isUpdatingLiteMode={isUpdatingLiteMode}
      onLiteModeChange={onLiteModeChange}
      onRefreshLiteMode={onRefreshLiteMode}
      planMode={planMode}
      isUpdatingPlanMode={isUpdatingPlanMode}
      onPlanModeChange={onPlanModeChange}
      onRefreshPlanMode={onRefreshPlanMode}
      goalMode={goalMode}
      isUpdatingGoalMode={isUpdatingGoalMode}
      onGoalModeChange={onGoalModeChange}
      onRefreshGoalMode={onRefreshGoalMode}
      worktreeMode={worktreeMode}
      isUpdatingWorktreeMode={isUpdatingWorktreeMode}
      onWorktreeModeChange={onWorktreeModeChange}
      onRefreshWorktreeMode={onRefreshWorktreeMode}
      goalModeTokenBudget={goalModeTokenBudget}
      onGoalModeTokenBudgetChange={onGoalModeTokenBudgetChange}
      autoScrollEnabled={autoScrollEnabled}
      onAutoScrollChange={onAutoScrollChange}
      autoFormatEnabled={autoFormatEnabled}
      onAutoFormatChange={onAutoFormatChange}
      onRefreshAutoFormat={onRefreshAutoFormat}
      isCompacting={isCompacting}
    />
  );
};
