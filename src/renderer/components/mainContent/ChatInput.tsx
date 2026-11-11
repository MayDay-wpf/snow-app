import { ChatInputView } from "./chatInput/ChatInputView";
import { useChatInputController } from "./chatInput/useChatInputController";
import type { ChatInputProps } from "./chatInput/types";
import { useI18n } from "../../i18n";

export const ChatInput = ({
  placeholder,
  projectId,
  projectName,
  surface = "main",
  conversationId,
  onSend,
  onNavigateToView,
  isStreaming = false,
  isAborting = false,
  onAbort,
  tokenUsage = null,
  draftToRestore = null,
  onDraftRestored,
  rollbackWorkflowComposer = null,
  onRollbackWorkflowRestored,
  autoSendRequest = null,
  claimAutoSend,
  completeAutoSend,
  saveInputDraft,
  getInputDraft,
  clearInputDraft,
  rollbackInputState,
  onRuntimeInputStateChange,
  getRuntimeInputState,
  loadOlderMessages,
  pendingMessages = [],
  pendingMessageModes,

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
  goalMode = false,
  isUpdatingGoalMode = false,
  onGoalModeChange,
  onRefreshGoalMode,
  worktreeMode = false,
  isUpdatingWorktreeMode = false,
  onWorktreeModeChange,
  onRefreshWorktreeMode,
  workflowMode = false,
  isUpdatingWorkflowMode = false,
  onWorkflowModeChange,
  onRefreshWorkflowMode,
  goalModeTokenBudget = 2000000,
  onGoalModeTokenBudgetChange,
  autoFormatEnabled = false,
  onAutoFormatChange,
  onRefreshAutoFormat,
  toolCorrectionEnabled = true,
  onToolCorrectionChange,
  onRefreshToolCorrection,
  contextFoldEnabled = false,
  onContextFoldChange,
  onRefreshContextFold,
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
    onDraftRestored,
    autoSendRequest,
    claimAutoSend,
    completeAutoSend,
    saveInputDraft,
    getInputDraft,
    clearInputDraft,
    rollbackInputState,
    onRuntimeInputStateChange,
    getRuntimeInputState,
  });

  return (
    <ChatInputView
      placeholder={placeholder ?? t("chatInput.placeholder")}
      projectId={projectId}
      projectName={projectName}
      surface={surface}
      onNavigateToView={onNavigateToView}
      {...controller}
      rollbackWorkflowComposer={rollbackWorkflowComposer}
      onRollbackWorkflowRestored={onRollbackWorkflowRestored}
      tokenUsage={tokenUsage}
      loadOlderMessages={loadOlderMessages}
      pendingMessages={pendingMessages}
      pendingMessageModes={pendingMessageModes}

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
      goalMode={goalMode}
      isUpdatingGoalMode={isUpdatingGoalMode}
      onGoalModeChange={onGoalModeChange}
      onRefreshGoalMode={onRefreshGoalMode}
      worktreeMode={worktreeMode}
      isUpdatingWorktreeMode={isUpdatingWorktreeMode}
      onWorktreeModeChange={onWorktreeModeChange}
      onRefreshWorktreeMode={onRefreshWorktreeMode}
      workflowMode={workflowMode}
      isUpdatingWorkflowMode={isUpdatingWorkflowMode}
      onWorkflowModeChange={onWorkflowModeChange}
      onRefreshWorkflowMode={onRefreshWorkflowMode}
      goalModeTokenBudget={goalModeTokenBudget}
      onGoalModeTokenBudgetChange={onGoalModeTokenBudgetChange}
      autoFormatEnabled={autoFormatEnabled}
      onAutoFormatChange={onAutoFormatChange}
      onRefreshAutoFormat={onRefreshAutoFormat}
      toolCorrectionEnabled={toolCorrectionEnabled}
      onToolCorrectionChange={onToolCorrectionChange}
      onRefreshToolCorrection={onRefreshToolCorrection}
      contextFoldEnabled={contextFoldEnabled}
      onContextFoldChange={onContextFoldChange}
      onRefreshContextFold={onRefreshContextFold}
      isCompacting={isCompacting}
    />
  );
};
