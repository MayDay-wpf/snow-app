import { Plug, Settings } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../../i18n";
import type { ChatInputViewProps } from "./types";
import { InputOverlayLayer } from "./InputOverlayLayer";
import { TerminalMonitorBar } from "./TerminalMonitorBar";
import { ChatInputPanels } from "./ChatInputPanels";
import { ChatInputToolbar } from "./ChatInputToolbar";
import { FileMentionPopup } from "./FileMentionPopup";
import { PendingMessages } from "./PendingMessages";
import { StreamMetrics } from "./StreamMetrics";
import { useChatConversationContext } from "../chatMessages";
import { directoryIdToPath } from "../chatMessages/utils/conversationHelpers";
import { collectConversationFileChanges } from "../chatMessages/hooks/fileChangeTracking";
import { useConversationFileChanges } from "./useConversationFileChanges";
import {
  startTerminalMonitor,
  stopTerminalMonitor,
  type TerminalDragPayload,
} from "../../rightPanel/terminal/terminalMonitor";
import { rightPanelEvents } from "../../rightPanel/rightPanelEvents";
import { CommandPanel } from "./commands/CommandPanel";
import { createChatCommands } from "./commands/commandRegistry";
import { useChipInteractions } from "./useChipInteractions";
import { useContentEditableInteractions } from "./useContentEditableInteractions";
import { useInputFileOperations } from "./useInputFileOperations";

/** 终端监控日志预览保留的最大行数 */
const MAX_MONITORED_LINES = 1000;

export const ChatInputView = ({
  placeholder,
  projectId,
  projectName,
  onNavigateToView,
  value,
  textareaRef,
  apiConfigs,
  selectedApiProfile,
  modelMenuView,
  isSubAgentConversation,
  models,
  selectedModel,
  displayModel,
  isLoadingModels,
  modelError,
  isModelMenuOpen,
  isManualMode,
  manualValue,
  dropdownRef,
  runtimeApiConfig,
  requestMethod,
  thinkingOptions,
  thinkingValue,
  thinkingLabel,
  ActiveThinkingIcon,
  isLoadingApiConfig,
  isSavingThinking,
  thinkingError,
  responsesFastModeEnabled,
  isSavingFastMode,
  fastModeError,
  labels,
  isStreaming,
  isAborting,
  sendKeyMode,
  setSendKeyMode,
  tokenUsage,
  pendingMessages,
  onWithdrawPendingMessage,
  onSendPendingMessageNow,
  onCompactConversation,
  yoloMode,
  isUpdatingYoloMode,
  onYoloModeChange,
  onRefreshYoloMode,
  liteMode,
  isUpdatingLiteMode,
  onLiteModeChange,
  onRefreshLiteMode,
  planMode,
  isUpdatingPlanMode,
  onPlanModeChange,
  onRefreshPlanMode,
  goalMode,
  isUpdatingGoalMode,
  onGoalModeChange,
  onRefreshGoalMode,
  worktreeMode,
  isUpdatingWorktreeMode,
  onWorktreeModeChange,
  onRefreshWorktreeMode,
  goalModeTokenBudget,
  onGoalModeTokenBudgetChange,
  autoScrollEnabled,
  onAutoScrollChange,
  autoFormatEnabled,
  onAutoFormatChange,
  onRefreshAutoFormat,
  isCompacting,
  setManualValue,
  setIsManualMode,
  setModelMenuView,
  handleChange,
  handleSend,
  handleAbort,
  handleKeyDown,
  handleSelectModel,
  handleOpenManualMode,
  handleConfirmManualModel,
  handleManualKeyDown,
  handleRetryFetchModels,
  handleToggleModelMenu,
  handleSelectApiProfile,
  handleSelectThinking,
  handleToggleResponsesFastMode,
  restoreContent,
}: ChatInputViewProps): React.JSX.Element => {
  const { t } = useI18n();
  const {
    handleNewChat,
    handleSendMessage,
    messages,
    activeConversationId,
    conversationDirectoryId,
    conversationVersion,
    fileChangeStats,
    streamTokenCount,
    streamElapsedMs,
    streamTtftMs,
    baselineCheckpointId,
    checkpointIds,
    streamStartedAt,
    isPaused,
    handlePause,
    handleResume,
  } = useChatConversationContext();
  // 用户发送过的历史消息（终端式 ↑/↓ 回溯用）：按时间正序保留。
  // 过滤压缩摘要（isContextCompaction）等非用户真实输入的系统消息。
  const userHistoryMessages = useMemo(
    () =>
      messages.filter(
        (message) =>
          message.role === "user" &&
          !message.isContextCompaction &&
          message.content.trim().length > 0,
      ),
    [messages],
  );
  const fallbackFileChanges = useMemo(() => {
    if (!activeConversationId) {
      return [];
    }
    return collectConversationFileChanges(
      fileChangeStats,
      activeConversationId,
    );
  }, [activeConversationId, fileChangeStats]);
  const conversationWorkDir = directoryIdToPath(conversationDirectoryId);
  const conversationFileChanges = useConversationFileChanges({
    conversationId: activeConversationId,
    checkpointIds,
    baselineCheckpointId,
    workDir: conversationWorkDir,
    messages,
    conversationVersion,
    fallbackChanges: fallbackFileChanges,
  });
  const [isProjectMcpOpen, setIsProjectMcpOpen] = useState(false);
  const [isProjectSensitiveCommandsOpen, setIsProjectSensitiveCommandsOpen] =
    useState(false);
  const [isProjectPermissionsOpen, setIsProjectPermissionsOpen] =
    useState(false);
  const [isProjectSkillsOpen, setIsProjectSkillsOpen] = useState(false);
  const [isProjectCodebaseOpen, setIsProjectCodebaseOpen] = useState(false);
  const [isRoleEditorOpen, setIsRoleEditorOpen] = useState(false);
  const [isFileChangesOpen, setIsFileChangesOpen] = useState(false);
  // 稳定引用：供 StreamMetricsWorkSummary memo 使用，避免父组件重渲染时
  // 传入新的 inline lambda 导致文件统计区域失效重绘（P0-1 性能优化）。
  const handleOpenFileChanges = useCallback(() => {
    setIsFileChangesOpen(true);
  }, []);
  const [isReviewOpen, setIsReviewOpen] = useState(false);

  // review 指令只在新建会话（尚未绑定历史会话）时开放，审查对象是
  // 当前项目目录的 Git 状态，而不是某个历史会话绑定的目录。
  const isNewChat = !activeConversationId;
  const reviewWorkDir = directoryIdToPath(projectId);

  const commands = useMemo(
    () =>
      createChatCommands({
        onNewChat: handleNewChat,
        onCompactConversation,
        onOpenFileChangesPanel: () => {
          setIsProjectMcpOpen(false);
          setIsProjectSensitiveCommandsOpen(false);
          setIsProjectPermissionsOpen(false);
          setIsProjectSkillsOpen(false);
          setIsProjectCodebaseOpen(false);
          setIsRoleEditorOpen(false);
          setIsFileChangesOpen(true);
        },
        onOpenMcpPanel: () => {
          setIsProjectSensitiveCommandsOpen(false);
          setIsProjectPermissionsOpen(false);
          setIsProjectSkillsOpen(false);
          setIsProjectCodebaseOpen(false);
          setIsRoleEditorOpen(false);
          setIsFileChangesOpen(false);
          setIsProjectMcpOpen(true);
        },
        onOpenRolePanel: () => {
          setIsProjectMcpOpen(false);
          setIsProjectSensitiveCommandsOpen(false);
          setIsProjectPermissionsOpen(false);
          setIsProjectSkillsOpen(false);
          setIsProjectCodebaseOpen(false);
          setIsFileChangesOpen(false);
          setIsRoleEditorOpen(true);
        },
        onOpenPermissionsPanel: () => {
          setIsProjectMcpOpen(false);
          setIsProjectSensitiveCommandsOpen(false);
          setIsProjectSkillsOpen(false);
          setIsProjectCodebaseOpen(false);
          setIsRoleEditorOpen(false);
          setIsFileChangesOpen(false);
          setIsProjectPermissionsOpen(true);
        },
        onOpenSensitiveCommandsPanel: () => {
          setIsProjectMcpOpen(false);
          setIsProjectPermissionsOpen(false);
          setIsProjectSkillsOpen(false);
          setIsProjectCodebaseOpen(false);
          setIsRoleEditorOpen(false);
          setIsFileChangesOpen(false);
          setIsProjectSensitiveCommandsOpen(true);
        },
        onOpenSkillsPanel: () => {
          setIsProjectMcpOpen(false);
          setIsProjectSensitiveCommandsOpen(false);
          setIsProjectPermissionsOpen(false);
          setIsProjectCodebaseOpen(false);
          setIsRoleEditorOpen(false);
          setIsFileChangesOpen(false);
          setIsProjectSkillsOpen(true);
        },
        onOpenCodebasePanel: () => {
          setIsProjectMcpOpen(false);
          setIsProjectSensitiveCommandsOpen(false);
          setIsProjectPermissionsOpen(false);
          setIsProjectSkillsOpen(false);
          setIsRoleEditorOpen(false);
          setIsFileChangesOpen(false);
          setIsProjectCodebaseOpen(true);
        },
        onOpenReviewPanel: () => {
          setIsProjectMcpOpen(false);
          setIsProjectSensitiveCommandsOpen(false);
          setIsProjectPermissionsOpen(false);
          setIsProjectSkillsOpen(false);
          setIsProjectCodebaseOpen(false);
          setIsRoleEditorOpen(false);
          setIsFileChangesOpen(false);
          setIsReviewOpen(true);
        },
        model: selectedModel || undefined,
        apiProfile: selectedApiProfile || undefined,
        compactDisabled: messages.length === 0 || isCompacting,
        fileChangesDisabled: !activeConversationId,
        mcpDisabled: !projectId,
        // YOLO 模式下工具自动授权，无需（也不允许）管理授权列表。
        permissionsDisabled: !projectId || yoloMode,
        reviewDisabled: !isNewChat || !reviewWorkDir,
        roleDisabled: !projectId,
        sensitiveCommandsDisabled: !projectId,
        skillsDisabled: !projectId,
        codebaseDisabled: !projectId,
        isRunning: isStreaming,
        labels: {
          clearDescription: t("chatCommand.clearDescription"),
          compactDescription: t("chatCommand.compactDescription"),
          fileChangesDescription: t("chatCommand.fileChangesDescription"),
          mcpDescription: projectId
            ? t("chatCommand.mcpDescription")
            : t("chatCommand.mcpNoProject"),
          roleDescription: t("chatCommand.roleDescription"),
          roleNoProject: t("chatCommand.roleNoProject"),
          // permissions 的禁用描述按原因区分：无项目 / YOLO 模式。
          permissionsDescription: !projectId
            ? t("chatCommand.permissionsNoProject")
            : yoloMode
              ? t("chatCommand.permissionsYoloDisabled")
              : t("chatCommand.permissionsDescription"),
          sensitiveCommandsDescription: projectId
            ? t("chatCommand.sensitiveCommandsDescription")
            : t("chatCommand.sensitiveCommandsNoProject"),
          skillsDescription: projectId
            ? t("chatCommand.skillsDescription")
            : t("chatCommand.skillsNoProject"),
          codebaseDescription: t("chatCommand.codebaseDescription"),
          codebaseNoProject: t("chatCommand.codebaseNoProject"),
          reviewDescription: !isNewChat
            ? t("chatCommand.reviewNewChatOnly")
            : reviewWorkDir
              ? t("chatCommand.reviewDescription")
              : t("chatCommand.reviewNoProject"),
          reviewNoProject: t("chatCommand.reviewNoProject"),
        },
      }),
    [
      activeConversationId,
      handleNewChat,
      isCompacting,
      isNewChat,
      isStreaming,
      messages.length,
      onCompactConversation,
      projectId,
      reviewWorkDir,
      selectedApiProfile,
      selectedModel,
      t,
      yoloMode,
    ],
  );

  // ------------------------------------------------------------------
  // 终端监控模式：拖拽终端到输入框后，实时订阅该终端的日志流
  // ------------------------------------------------------------------

  /** 当前监控的终端（null = 未监控） */
  const [monitoredTerminal, setMonitoredTerminal] = useState<{
    tabId: string;
    cwd: string;
  } | null>(null);
  /** 监控到的日志行（环形保留最近 MAX_MONITORED_LINES 行） */
  const [monitoredLines, setMonitoredLines] = useState<string[]>([]);
  /** 监控条日志预览是否展开 */
  const [monitorExpanded, setMonitorExpanded] = useState(false);
  /** 监控日志预览滚动容器（新行到达时自动滚到底部） */
  const monitorScrollRef = useRef<HTMLDivElement | null>(null);

  /** 停止监控当前终端 */
  const handleStopMonitor = useCallback((): void => {
    setMonitoredTerminal((prev) => {
      if (prev) {
        stopTerminalMonitor(prev.tabId);
      }
      return null;
    });
    setMonitoredLines([]);
    setMonitorExpanded(false);
  }, []);

  /** 监控日志预览展开时自动滚动到底部 */
  useEffect(() => {
    if (!monitorExpanded) {
      return;
    }
    const el = monitorScrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [monitoredLines.length, monitorExpanded]);

  const handleStartTerminalMonitor = useCallback(
    (payload: TerminalDragPayload) => {
      startTerminalMonitor(payload.tabId, (lines) => {
        setMonitoredLines((prev) =>
          [...prev, ...lines].slice(-MAX_MONITORED_LINES),
        );
      });
      setMonitoredTerminal({
        tabId: payload.tabId,
        cwd: payload.cwd || "",
      });
      setMonitoredLines([]);
      setMonitorExpanded(true);
    },
    [],
  );

  const inputFileOperations = useInputFileOperations({
    textareaRef,
    handleChange,
  });
  const chipInteractions = useChipInteractions({
    textareaRef,
    syncContent: inputFileOperations.syncContent,
  });
  const contentEditableInteractions = useContentEditableInteractions({
    textareaRef,
    value,
    restoreContent,
    handleKeyDown,
    sendKeyMode,
    userHistoryMessages,
    activeConversationId,
    conversationDirectoryId,
    projectId,
    isSubAgentConversation,
    commands,
    onStartTerminalMonitor: handleStartTerminalMonitor,
    fileOperations: inputFileOperations,
  });
  const { syncContent, plusMenuSections } = inputFileOperations;
  const {
    mentionAnchorRef,
    mentionPopupRef,
    isMentionOpen,
    mentionQuery,
    handleCloseMention,
    handleMentionSelect,
    handleMentionSelectBatch,
    handleMentionDragStart,
    handleMentionNavigateTo,
    commandPanelRef,
    commandTriggerRef,
    isCommandOpen,
    commandQuery,
    handleCloseCommand,
    handleToggleCommand,
    handleCommandSelect,
    handleInput,
    handleInputKeyDown,
    handleCopy,
    handleCut,
    handlePaste,
    handleDrop,
    handleDragOver,
    handleDragLeave,
  } = contentEditableInteractions;
  const {
    imagePreview,
    setImagePreview,
    imageLightbox,
    setImageLightbox,
    textSnippetPreview,
    textSnippetEditor,
    setTextSnippetEditor,
    webChipMenu,
    setWebChipMenu,
    chipDetails,
    conversationPreview,
    showImagePreview,
    scheduleHideImagePreview,
    cancelHideImagePreview,
    showTextSnippetPreview,
    scheduleHideTextSnippetPreview,
    cancelHideTextSnippetPreview,
    showChipDetails,
    scheduleHideChipDetails,
    cancelHideChipDetails,
    showConversationPreview,
    scheduleHideConversationPreview,
    cancelHideConversationPreview,
    handleChipRemove,
    handleTextSnippetClick,
    handleWebChipClick,
    handleWebChipContextMenu,
    handleTextSnippetEditorDelete,
    handleTextSnippetEditorSave,
  } = chipInteractions;

  const handleWithdrawPending = useCallback(
    (index: number): string | null => {
      const restored = onWithdrawPendingMessage?.(index);
      if (restored) {
        restoreContent(restored);
      }
      return restored ?? null;
    },
    [onWithdrawPendingMessage, restoreContent],
  );

  const handleSendPendingNow = useCallback(
    (index: number): void => {
      onSendPendingMessageNow?.(index);
    },
    [onSendPendingMessageNow],
  );

  return (
    <div className="input-area">
      <ChatInputPanels
        projectId={projectId}
        projectName={projectName}
        isProjectMcpOpen={isProjectMcpOpen}
        isProjectSensitiveCommandsOpen={isProjectSensitiveCommandsOpen}
        isProjectPermissionsOpen={isProjectPermissionsOpen}
        isProjectSkillsOpen={isProjectSkillsOpen}
        isProjectCodebaseOpen={isProjectCodebaseOpen}
        isRoleEditorOpen={isRoleEditorOpen}
        isFileChangesOpen={isFileChangesOpen}
        isReviewOpen={isReviewOpen}
        conversationFileChanges={conversationFileChanges}
        reviewWorkDir={reviewWorkDir ?? ""}
        onStartReview={(prompt) => {
          handleSendMessage(prompt, {
            model: selectedModel || undefined,
            apiProfile: selectedApiProfile || undefined,
            // review 回合：桌面宠物据此播放 review 专属动画。
            kind: "review",
          });
        }}
        onCloseProjectMcp={() => setIsProjectMcpOpen(false)}
        onCloseSensitiveCommands={() =>
          setIsProjectSensitiveCommandsOpen(false)
        }
        onClosePermissions={() => setIsProjectPermissionsOpen(false)}
        onCloseSkills={() => setIsProjectSkillsOpen(false)}
        onCloseCodebase={() => setIsProjectCodebaseOpen(false)}
        onCloseRoleEditor={() => setIsRoleEditorOpen(false)}
        onCloseFileChanges={() => setIsFileChangesOpen(false)}
        onCloseReview={() => setIsReviewOpen(false)}
      />
      <div className="input-content" ref={mentionAnchorRef}>
        <FileMentionPopup
          ref={mentionPopupRef}
          visible={isMentionOpen}
          query={mentionQuery}
          onClose={handleCloseMention}
          onSelect={handleMentionSelect}
          onSelectBatch={handleMentionSelectBatch}
          textareaRef={textareaRef}
          onDragStart={handleMentionDragStart}
          onNavigateTo={handleMentionNavigateTo}
        />
        <CommandPanel
          ref={commandPanelRef}
          commands={commands}
          query={commandQuery}
          visible={isCommandOpen}
          onClose={handleCloseCommand}
          onSelect={handleCommandSelect}
        />
        <PendingMessages
          messages={pendingMessages}
          onWithdraw={handleWithdrawPending}
          onSendNow={handleSendPendingNow}
        />
        {isStreaming ? (
          <div className="stream-metrics-bar">
            <StreamMetrics
              tokenCount={streamTokenCount}
              elapsedMs={streamElapsedMs}
              ttftMs={streamTtftMs}
              startedAt={streamStartedAt}
              isPaused={isPaused}
              onPause={handlePause}
              onResume={handleResume}
            />
          </div>
        ) : null}
        <TerminalMonitorBar
          monitoredTerminal={monitoredTerminal}
          monitoredLines={monitoredLines}
          monitorExpanded={monitorExpanded}
          monitorScrollRef={monitorScrollRef}
          handleStopMonitor={handleStopMonitor}
          setMonitorExpanded={setMonitorExpanded}
        />
        {apiConfigs.length === 0 &&
        !isSubAgentConversation &&
        !isLoadingApiConfig ? (
          <div className="api-config-empty-banner" role="status">
            <Plug
              size={14}
              className="api-config-empty-icon"
              aria-hidden="true"
            />
            <span className="api-config-empty-text">
              {t("chat.noApiConfigBanner", {
                defaultValue: "尚未配置 AI API，请先添加 API 配置后再开始对话",
              })}
            </span>
            {onNavigateToView ? (
              <button
                type="button"
                className="api-config-empty-btn"
                onClick={() => onNavigateToView("api-settings")}
              >
                <Settings size={13} aria-hidden="true" />
                {t("chat.configureApi", { defaultValue: "前往设置" })}
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="input-box">
          <div
            ref={textareaRef}
            className={`input-field input-field-editable${
              isCompacting ? " is-disabled" : ""
            }`}
            contentEditable={!isCompacting}
            suppressContentEditableWarning
            data-placeholder={placeholder}
            data-empty="true"
            onInput={handleInput}
            onKeyDown={handleInputKeyDown}
            onCopy={handleCopy}
            onCut={handleCut}
            onPaste={handlePaste}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onMouseMove={(event) => {
              showImagePreview(event);
              showTextSnippetPreview(event);
              showChipDetails(event);
              showConversationPreview(event);
            }}
            onMouseLeave={() => {
              scheduleHideImagePreview();
              scheduleHideTextSnippetPreview();
              scheduleHideChipDetails();
              scheduleHideConversationPreview();
            }}
            onContextMenu={handleWebChipContextMenu}
            onClick={(event) => {
              handleChipRemove(event);
              handleTextSnippetClick(event);
              handleWebChipClick(event);
            }}
          />
          <InputOverlayLayer
            imagePreview={imagePreview}
            setImagePreview={setImagePreview}
            imageLightbox={imageLightbox}
            setImageLightbox={setImageLightbox}
            textSnippetPreview={textSnippetPreview}
            textSnippetEditor={textSnippetEditor}
            setTextSnippetEditor={setTextSnippetEditor}
            webChipMenu={webChipMenu}
            setWebChipMenu={setWebChipMenu}
            chipDetails={chipDetails}
            conversationPreview={conversationPreview}
            cancelHideImagePreview={cancelHideImagePreview}
            scheduleHideImagePreview={scheduleHideImagePreview}
            cancelHideTextSnippetPreview={cancelHideTextSnippetPreview}
            scheduleHideTextSnippetPreview={scheduleHideTextSnippetPreview}
            cancelHideChipDetails={cancelHideChipDetails}
            scheduleHideChipDetails={scheduleHideChipDetails}
            cancelHideConversationPreview={cancelHideConversationPreview}
            scheduleHideConversationPreview={scheduleHideConversationPreview}
            handleTextSnippetEditorDelete={handleTextSnippetEditorDelete}
            handleTextSnippetEditorSave={handleTextSnippetEditorSave}
            syncContent={syncContent}
            onOpenWebChip={(url) => {
              rightPanelEvents.emit("open-browser-tab", { url });
            }}
          />
          <ChatInputToolbar
            plusMenuSections={plusMenuSections}
            commandTriggerRef={commandTriggerRef}
            isCommandOpen={isCommandOpen}
            handleToggleCommand={handleToggleCommand}
            onNavigateToView={onNavigateToView}
            value={value}
            tokenUsage={tokenUsage}
            isAborting={isAborting}
            isCompacting={isCompacting}
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
            handleAbort={handleAbort}
            handleSend={handleSend}
            apiConfigs={apiConfigs}
            selectedApiProfile={selectedApiProfile}
            modelMenuView={modelMenuView}
            isSubAgentConversation={isSubAgentConversation}
            models={models}
            selectedModel={selectedModel}
            displayModel={displayModel}
            isLoadingModels={isLoadingModels}
            modelError={modelError}
            isModelMenuOpen={isModelMenuOpen}
            isManualMode={isManualMode}
            manualValue={manualValue}
            dropdownRef={dropdownRef}
            runtimeApiConfig={runtimeApiConfig}
            requestMethod={requestMethod}
            thinkingOptions={thinkingOptions}
            thinkingValue={thinkingValue}
            thinkingLabel={thinkingLabel}
            ActiveThinkingIcon={ActiveThinkingIcon}
            isLoadingApiConfig={isLoadingApiConfig}
            isSavingThinking={isSavingThinking}
            thinkingError={thinkingError}
            responsesFastModeEnabled={responsesFastModeEnabled}
            isSavingFastMode={isSavingFastMode}
            fastModeError={fastModeError}
            labels={labels}
            isStreaming={isStreaming}
            sendKeyMode={sendKeyMode}
            setSendKeyMode={setSendKeyMode}
            setManualValue={setManualValue}
            setIsManualMode={setIsManualMode}
            setModelMenuView={setModelMenuView}
            handleSelectModel={handleSelectModel}
            handleOpenManualMode={handleOpenManualMode}
            handleConfirmManualModel={handleConfirmManualModel}
            handleManualKeyDown={handleManualKeyDown}
            handleRetryFetchModels={handleRetryFetchModels}
            handleToggleModelMenu={handleToggleModelMenu}
            handleSelectApiProfile={handleSelectApiProfile}
            handleSelectThinking={handleSelectThinking}
            handleToggleResponsesFastMode={handleToggleResponsesFastMode}
          />
        </div>
      </div>
    </div>
  );
};
