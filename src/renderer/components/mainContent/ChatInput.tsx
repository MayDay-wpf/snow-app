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
  onOpenConversation,
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
  pendingMessages = [],
  onWithdrawPendingMessage,
  onSendPendingMessageNow,
  onCompactConversation,
  yoloMode = false,
  isUpdatingYoloMode = false,
  onYoloModeChange,
  onRefreshYoloMode,
  planMode = false,
  isUpdatingPlanMode = false,
  onPlanModeChange,
  onRefreshPlanMode,
  goalMode = false,
  isUpdatingGoalMode = false,
  onGoalModeChange,
  onRefreshGoalMode,
  goalModeTokenBudget = 2000000,
  onGoalModeTokenBudgetChange,
  autoScrollEnabled = false,
  onAutoScrollChange,
  isCompacting = false,
}: ChatInputProps): React.JSX.Element => {
  const { t } = useI18n();
  const controller = useChatInputController({
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
  });

  return (
    <ChatInputView
      placeholder={placeholder ?? t("chatInput.placeholder")}
      projectId={projectId}
      projectName={projectName}
      onNavigateToView={onNavigateToView}
      onOpenConversation={onOpenConversation}
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
      planMode={planMode}
      isUpdatingPlanMode={isUpdatingPlanMode}
      onPlanModeChange={onPlanModeChange}
      onRefreshPlanMode={onRefreshPlanMode}
      goalMode={goalMode}
      isUpdatingGoalMode={isUpdatingGoalMode}
      onGoalModeChange={onGoalModeChange}
      onRefreshGoalMode={onRefreshGoalMode}
      goalModeTokenBudget={goalModeTokenBudget}
      onGoalModeTokenBudgetChange={onGoalModeTokenBudgetChange}
      autoScrollEnabled={autoScrollEnabled}
      onAutoScrollChange={onAutoScrollChange}
      isCompacting={isCompacting}
    />
  );
};
