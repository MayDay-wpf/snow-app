import { GripHorizontal, Minimize2, Plug, Settings } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useI18n } from "../../../i18n";
import type {
  ChatInputViewProps,
  RollbackWorkflowComposerState,
} from "./types";
import { InputOverlayLayer } from "./InputOverlayLayer";
import { TerminalMonitorBar } from "./TerminalMonitorBar";
import { ChatInputPanels } from "./ChatInputPanels";
import { OPEN_PROJECT_CODEBASE_PANEL_EVENT } from "./ProjectCodebasePanel";
import {
  OPEN_PROJECT_MCP_PANEL_EVENT,
  consumeProjectMcpPanelRequest,
} from "./projectMcpNavigation";
import { ChatInputToolbar } from "./ChatInputToolbar";
import { FileMentionPopup } from "./FileMentionPopup";
import { RollbackTargetPopup } from "./RollbackTargetPopup";
import { useRollbackPicker } from "./useRollbackPicker";
import { useReplyPrediction } from "./useReplyPrediction";
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
import { shortcutEvents } from "../../shortcutEvents";
import { CommandPanel } from "./commands/CommandPanel";
import { createChatCommands } from "./commands/commandRegistry";
import {
  isHelpSkillDisabled,
  markHelpGuideUsed,
} from "../../../constants/helpGuide";
import { HelpSkillDisabledDialog } from "../../common/HelpSkillDisabledDialog";
import { WorkflowComposerDialog } from "./workflowComposer/WorkflowComposerDialog";
import { buildWorkflowComposerContent } from "./workflowComposer/workflowComposerPayload";
import {
  applyCustomCommandArguments,
  type EffectiveCustomCommand,
} from "./commands/customCommands";
import { useCustomCommands } from "./commands/useCustomCommands";
import {
  clearRemoteControlChatInput,
  publishRemoteControlChatInput,
  type SnowRemoteChatInputPublication,
} from "./remoteControlChatInputRegistry";
import { useChipInteractions } from "./useChipInteractions";
import { useComposerResize } from "./useComposerResize";
import { useContentEditableInteractions } from "./useContentEditableInteractions";
import { useInputFileOperations } from "./useInputFileOperations";
import { registerPluginDraftHost } from "../../../plugins/pluginDraft";
import { registerChatInputDraftSink } from "./chatInputDraftBridge";
import { runtimeSnapshot } from "../../../plugins/runtimeSnapshot";

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
  effectiveThinkingValue,
  thinkingLabel,
  ActiveThinkingIcon,
  isLoadingApiConfig,
  thinkingError,
  responsesFastMode,
  responsesFastModeOverride,
  fastModeError,
  labels,
  isStreaming,
  isAborting,
  sendKeyMode,
  setSendKeyMode,
  tokenUsage,
  loadOlderMessages,
  rollbackWorkflowComposer,
  onRollbackWorkflowRestored,
  pendingMessages,
  pendingMessageModes,

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
  goalMode,
  isUpdatingGoalMode,
  onGoalModeChange,
  onRefreshGoalMode,
  worktreeMode,
  isUpdatingWorktreeMode,
  onWorktreeModeChange,
  onRefreshWorktreeMode,
  workflowMode,
  isUpdatingWorkflowMode,
  onWorkflowModeChange,
  onRefreshWorkflowMode,
  goalModeTokenBudget,
  onGoalModeTokenBudgetChange,
  autoScrollEnabled,
  onAutoScrollChange,
  autoFormatEnabled,
  onAutoFormatChange,
  onRefreshAutoFormat,
  toolCorrectionEnabled,
  onToolCorrectionChange,
  onRefreshToolCorrection,
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
  handleApiConfigSaved,
  handleToggleModelMenu,
  handleSelectApiProfile,
  handleSelectThinking,
  handleSelectResponsesFastMode,
  restoreContent,
}: ChatInputViewProps): React.JSX.Element => {
  const { t } = useI18n();
  // 输入区高度：拖动把手调整高度，越过上限继续上拖撑满聊天区
  const {
    inputAreaRef,
    composerExpanded,
    isResizing,
    collapseComposer,
    handleResizePointerDown,
    handleResizePointerMove,
    handleResizePointerUp,
    handleResizeKeyDown,
  } = useComposerResize({ textareaRef });
  const {
    handleNewChat,
    handleSendMessage,
    messages,
    activeConversationId,
    sessionViewKey,
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
    pendingWorktreeId,
  } = useChatConversationContext();
  // 双击 ESC 打开的回滚目标列表（子代理会话不支持回滚）。
  const rollbackPicker = useRollbackPicker({
    enabled: !isSubAgentConversation,
    loadOlderMessages,
  });
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
    worktreeMode,
    worktreeId: pendingWorktreeId,
    directoryId: conversationDirectoryId,
  });
  const [isProjectMcpOpen, setIsProjectMcpOpen] = useState(false);
  /** 项目 MCP 弹窗的聚焦服务器 id：非空时面板只展示该项（横幅「去开启」入口）。 */
  const [projectMcpFocusServerId, setProjectMcpFocusServerId] = useState<
    string | null
  >(null);
  const [isProjectSensitiveCommandsOpen, setIsProjectSensitiveCommandsOpen] =
    useState(false);
  const [isProjectPermissionsOpen, setIsProjectPermissionsOpen] =
    useState(false);
  const [isProjectSkillsOpen, setIsProjectSkillsOpen] = useState(false);
  const [isProjectCodebaseOpen, setIsProjectCodebaseOpen] = useState(false);
  const [isRoleEditorOpen, setIsRoleEditorOpen] = useState(false);
  const [isFileChangesOpen, setIsFileChangesOpen] = useState(false);
  const [isMemoryOpen, setIsMemoryOpen] = useState(false);
  const [isCustomCommandsOpen, setIsCustomCommandsOpen] = useState(false);
  const [isWorkflowComposerOpen, setIsWorkflowComposerOpen] = useState(false);
  // 回滚编排提交：把还原图暂存在视图内，打开弹窗后再清掉 ctx 的一次性状态。
  const [composerRestore, setComposerRestore] =
    useState<RollbackWorkflowComposerState | null>(null);
  const closeWorkflowComposer = useCallback(() => {
    setIsWorkflowComposerOpen(false);
    setComposerRestore(null);
  }, []);
  // 回滚后回填编排器：编排图不能写进输入框，改为打开编排器并还原画布。
  useEffect(() => {
    if (!rollbackWorkflowComposer) return;
    setComposerRestore(rollbackWorkflowComposer);
    setIsWorkflowComposerOpen(true);
    onRollbackWorkflowRestored?.();
  }, [rollbackWorkflowComposer, onRollbackWorkflowRestored]);
  // 稳定引用：供 StreamMetricsWorkSummary memo 使用，避免父组件重渲染时
  // 传入新的 inline lambda 导致文件统计区域失效重绘（P0-1 性能优化）。
  const handleOpenFileChanges = useCallback(() => {
    setIsFileChangesOpen(true);
  }, []);
  /** 打开项目 MCP 弹窗（互斥关闭其他面板）；斜杠命令与右侧面板横幅共用。
   *  serverId 为右侧面板横幅指定的服务器：面板只展示该项（未传则展示全部）。 */
  const handleOpenMcpPanel = useCallback((serverId?: string): void => {
    setIsProjectSensitiveCommandsOpen(false);
    setIsProjectPermissionsOpen(false);
    setIsProjectSkillsOpen(false);
    setIsProjectCodebaseOpen(false);
    setIsRoleEditorOpen(false);
    setIsFileChangesOpen(false);
    setIsMemoryOpen(false);
    setIsReviewOpen(false);
    setIsCustomCommandsOpen(false);
    setProjectMcpFocusServerId(serverId ?? null);
    setIsProjectMcpOpen(true);
  }, []);

  const handleCloseMcpPanel = useCallback((): void => {
    setIsProjectMcpOpen(false);
    setProjectMcpFocusServerId(null);
  }, []);

  /** 打开代码库管理弹窗（互斥关闭其他面板）；命令面板与 TopBar 事件共用。 */
  const handleOpenCodebasePanel = useCallback((): void => {
    setIsProjectMcpOpen(false);
    setIsProjectSensitiveCommandsOpen(false);
    setIsProjectPermissionsOpen(false);
    setIsProjectSkillsOpen(false);
    setIsRoleEditorOpen(false);
    setIsFileChangesOpen(false);
    setIsMemoryOpen(false);
    setIsReviewOpen(false);
    setIsCustomCommandsOpen(false);
    setIsProjectCodebaseOpen(true);
  }, []);
  const [isReviewOpen, setIsReviewOpen] = useState(false);

  // TopBar 代码库同步指示器点击：经窗口事件打开代码库管理弹窗。
  useEffect(() => {
    window.addEventListener(
      OPEN_PROJECT_CODEBASE_PANEL_EVENT,
      handleOpenCodebasePanel,
    );
    return () => {
      window.removeEventListener(
        OPEN_PROJECT_CODEBASE_PANEL_EVENT,
        handleOpenCodebasePanel,
      );
    };
  }, [handleOpenCodebasePanel]);

  // 右侧面板（浏览器 / 终端）未开启对应 MCP 时，横幅「去开启」请求打开
  // 项目 MCP 弹窗（只展示该服务器）；挂载时补一次消费，覆盖 App 先切回
  // 聊天视图、本组件迟到挂载的场景（事件已派发完毕）。
  useEffect(() => {
    const handleOpenRequest = (): void => {
      const serverId = consumeProjectMcpPanelRequest();
      if (serverId !== null) {
        handleOpenMcpPanel(serverId || undefined);
      }
    };
    window.addEventListener(OPEN_PROJECT_MCP_PANEL_EVENT, handleOpenRequest);
    handleOpenRequest();
    return () => {
      window.removeEventListener(
        OPEN_PROJECT_MCP_PANEL_EVENT,
        handleOpenRequest,
      );
    };
  }, [handleOpenMcpPanel]);

  // review 指令只在新建会话（尚未绑定历史会话）时开放，审查对象是
  // 当前项目目录的 Git 状态，而不是某个历史会话绑定的目录。
  const isNewChat = !activeConversationId;
  const reviewWorkDir = directoryIdToPath(projectId);

  const customCommands = useCustomCommands(projectId);
  const customCommandWorkingDir = conversationWorkDir ?? reviewWorkDir ?? "";

  const handleRunCustomCommand = useCallback(
    (command: EffectiveCustomCommand, args?: string): void => {
      const finalCommand = applyCustomCommandArguments(command.content, args);
      if (command.commandType === "prompt") {
        handleSendMessage(finalCommand, {
          model: selectedModel || undefined,
          apiProfile: selectedApiProfile || undefined,
        });
        return;
      }

      // Bash 类型：交给系统终端执行——右侧面板新建终端 tab，
      // 命令写入该 tab 的真实 shell，输出与交互都留在终端里。
      rightPanelEvents.emit("open-terminal-command", {
        cwd: customCommandWorkingDir,
        command: finalCommand,
        title: `/${command.name}`,
      });
    },
    [
      customCommandWorkingDir,
      handleSendMessage,
      selectedApiProfile,
      selectedModel,
    ],
  );

  const [isHelpSkillDialogOpen, setIsHelpSkillDialogOpen] = useState(false);
  // /help 选中前检查 snow-app-docs 技能：明确关闭时弹窗拦截，不插入指令。
  const checkHelpAvailable = useCallback(async (): Promise<boolean> => {
    const disabled = await isHelpSkillDisabled(projectId);
    if (disabled) {
      setIsHelpSkillDialogOpen(true);
    }
    return !disabled;
  }, [projectId]);

  const commands = useMemo(
    () =>
      createChatCommands({
        onNewChat: handleNewChat,
        onHelpUsed: markHelpGuideUsed,
        checkHelpAvailable,
        onCompactConversation,
        onOpenFileChangesPanel: () => {
          setIsProjectMcpOpen(false);
          setIsProjectSensitiveCommandsOpen(false);
          setIsProjectPermissionsOpen(false);
          setIsProjectSkillsOpen(false);
          setIsProjectCodebaseOpen(false);
          setIsRoleEditorOpen(false);
          setIsMemoryOpen(false);
          setIsCustomCommandsOpen(false);
          setIsFileChangesOpen(true);
        },
        onOpenMemoryPanel: () => {
          setIsProjectMcpOpen(false);
          setIsProjectSensitiveCommandsOpen(false);
          setIsProjectPermissionsOpen(false);
          setIsProjectSkillsOpen(false);
          setIsProjectCodebaseOpen(false);
          setIsRoleEditorOpen(false);
          setIsFileChangesOpen(false);
          setIsReviewOpen(false);
          setIsCustomCommandsOpen(false);
          setIsMemoryOpen(true);
        },
        onOpenMcpPanel: () => handleOpenMcpPanel(),
        onOpenRolePanel: () => {
          setIsProjectMcpOpen(false);
          setIsProjectSensitiveCommandsOpen(false);
          setIsProjectPermissionsOpen(false);
          setIsProjectSkillsOpen(false);
          setIsProjectCodebaseOpen(false);
          setIsFileChangesOpen(false);
          setIsMemoryOpen(false);
          setIsCustomCommandsOpen(false);
          setIsRoleEditorOpen(true);
        },
        onOpenPermissionsPanel: () => {
          setIsProjectMcpOpen(false);
          setIsProjectSensitiveCommandsOpen(false);
          setIsProjectSkillsOpen(false);
          setIsProjectCodebaseOpen(false);
          setIsRoleEditorOpen(false);
          setIsFileChangesOpen(false);
          setIsMemoryOpen(false);
          setIsCustomCommandsOpen(false);
          setIsProjectPermissionsOpen(true);
        },
        onOpenSensitiveCommandsPanel: () => {
          setIsProjectMcpOpen(false);
          setIsProjectPermissionsOpen(false);
          setIsProjectSkillsOpen(false);
          setIsProjectCodebaseOpen(false);
          setIsRoleEditorOpen(false);
          setIsFileChangesOpen(false);
          setIsMemoryOpen(false);
          setIsCustomCommandsOpen(false);
          setIsProjectSensitiveCommandsOpen(true);
        },
        onOpenSkillsPanel: () => {
          setIsProjectMcpOpen(false);
          setIsProjectSensitiveCommandsOpen(false);
          setIsProjectPermissionsOpen(false);
          setIsProjectCodebaseOpen(false);
          setIsRoleEditorOpen(false);
          setIsFileChangesOpen(false);
          setIsMemoryOpen(false);
          setIsCustomCommandsOpen(false);
          setIsProjectSkillsOpen(true);
        },
        onOpenCodebasePanel: handleOpenCodebasePanel,
        onOpenReviewPanel: () => {
          setIsProjectMcpOpen(false);
          setIsProjectSensitiveCommandsOpen(false);
          setIsProjectPermissionsOpen(false);
          setIsProjectSkillsOpen(false);
          setIsProjectCodebaseOpen(false);
          setIsRoleEditorOpen(false);
          setIsFileChangesOpen(false);
          setIsMemoryOpen(false);
          setIsCustomCommandsOpen(false);
          setIsReviewOpen(true);
        },
        onOpenCustomCommandsPanel: () => {
          setIsProjectMcpOpen(false);
          setIsProjectSensitiveCommandsOpen(false);
          setIsProjectPermissionsOpen(false);
          setIsProjectSkillsOpen(false);
          setIsProjectCodebaseOpen(false);
          setIsRoleEditorOpen(false);
          setIsFileChangesOpen(false);
          setIsMemoryOpen(false);
          setIsReviewOpen(false);
          setIsCustomCommandsOpen(true);
        },
        onRunCustomCommand: handleRunCustomCommand,
        customCommands,
        model: selectedModel || undefined,
        apiProfile: selectedApiProfile || undefined,
        compactDisabled: messages.length === 0 || isCompacting,
        fileChangesDisabled: !activeConversationId,
        // 记忆清单按会话溯源，没有活动会话时无可展示内容。
        memoryDisabled: !activeConversationId,
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
          helpDescription: t("chatCommand.helpDescription"),
          helpPromptGeneral: t("chatCommand.helpPromptGeneral"),
          helpPromptQuestion: t("chatCommand.helpPromptQuestion"),
          memoryDescription: activeConversationId
            ? t("chatCommand.memoryDescription")
            : t("chatCommand.memoryNoProject"),
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
          customCommandsDescription: t("chatCommand.customCommandsDescription"),
          customCommandsPromptType: t("chatCommand.customPromptType"),
          customCommandsBashType: t("chatCommand.customBashType"),
        },
      }),
    [
      activeConversationId,
      checkHelpAvailable,
      customCommands,
      handleNewChat,
      handleOpenCodebasePanel,
      handleOpenMcpPanel,
      handleRunCustomCommand,
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

  // 向手机远控桥发布输入区的真实能力，不暴露 API 密钥或地址等配置内容。
  useEffect(() => {
    const snapshot: SnowRemoteChatInputPublication = {
      conversationId: activeConversationId ?? null,
      isSubAgentConversation,
      isLoadingApiConfig,
      selectedModel,
      displayModel,
      modelIds: models.map((model) => model.id),
      selectedApiProfile,
      apiProfileNames: apiConfigs.map((config) => config.profileName),
      requestMethod,
      effectiveThinkingValue,
      thinkingOverride: thinkingValue,
      thinkingOptions: thinkingOptions.map(({ value, label }) => ({
        value,
        label,
      })),
      responsesFastMode,
      responsesFastModeOverride,
      maxContextTokens: runtimeApiConfig?.maxContextTokens ?? null,
      commands,
      actions: {
        handleSelectModel,
        handleSelectApiProfile,
        handleSelectThinking,
        handleSelectResponsesFastMode,
      },
    };
    publishRemoteControlChatInput(snapshot);
    return () => clearRemoteControlChatInput(snapshot);
  });

  // 向插件运行时快照发布输入区实测数据：Token 用量环（TokenUsageRing）的另外
  // 两个输入（生效上下文窗口上限、API 配置加载态）只存在于输入区控制器，按
  // 「谁持有谁发布」的口径在这里写入（与 RightPanel 发布 panels 同模式）。
  // 只在依赖变化时写入，避免每次渲染都通知 live 元数据域重新采集。
  useEffect(() => {
    runtimeSnapshot.patch({
      chatInput: {
        conversationId: activeConversationId ?? null,
        inputText: value,
        maxContextTokens: runtimeApiConfig?.maxContextTokens ?? null,
        isLoadingApiConfig,
      },
    });
  }, [activeConversationId, value, runtimeApiConfig, isLoadingApiConfig]);

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
  const { prediction: replyPrediction, consumePrediction } = useReplyPrediction(
    {
      conversationId: activeConversationId ?? null,
      isStreaming,
      disabled: isSubAgentConversation,
      value,
      apiProfile: selectedApiProfile || undefined,
      messages,
    },
  );
  // 回滚目标列表优先接管按键：列表打开时 ↑/↓/Enter/Esc 不再触达输入区逻辑
  // （历史回溯、发送、@ 提及面板等）；列表关闭时它只累计连续 ESC。
  const handleInputKeyDownWithRollback = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      if (rollbackPicker.handleKeyDown(event)) {
        return;
      }
      // Tab 采用回复预测
      if (
        replyPrediction &&
        event.key === "Tab" &&
        !event.shiftKey &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.nativeEvent.isComposing &&
        !isMentionOpen &&
        !isCommandOpen
      ) {
        event.preventDefault();
        const text = consumePrediction();
        if (text) {
          restoreContent(text);
        }
        return;
      }
      handleInputKeyDown(event);
    },
    [
      handleInputKeyDown,
      rollbackPicker.handleKeyDown,
      replyPrediction,
      isMentionOpen,
      isCommandOpen,
      consumePrediction,
      restoreContent,
    ],
  );
  const {
    imagePreview,
    imageLightbox,
    setImageLightbox,
    textSnippetOverlay,
    webChipMenu,
    setWebChipMenu,
    chipDetails,
    conversationPreview,
    showImagePreview,
    scheduleHideImagePreview,
    handleImageChipClick,
    showChipDetails,
    scheduleHideChipDetails,
    cancelHideChipDetails,
    showConversationPreview,
    scheduleHideConversationPreview,
    cancelHideConversationPreview,
    handleChipRemove,
    handleWebChipClick,
    handleWebChipContextMenu,
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

  // Alt/Option + Enter「立即发送」：输入框有内容就立即发出（正在生成时先中断当前
  // 回合），输入为空时改为立即发送待发送队列里的第一条。
  // 生成中的输入内容按队列语义入队后立刻取出，与列表里的「立即发送」按钮走同一条
  // 通道（子代理 / WorkFlow 节点会话的强行发送特例都在该通道内处理）。
  const handleSendNow = useCallback((): void => {
    if (!value.trim()) {
      if (pendingMessages.length > 0) {
        onSendPendingMessageNow?.(0);
      }
      return;
    }

    if (!isStreaming && !isAborting) {
      handleSend();
      return;
    }

    const queuedIndex = pendingMessages.length;
    handleSend("queue");
    onSendPendingMessageNow?.(queuedIndex);
  }, [
    value,
    isStreaming,
    isAborting,
    pendingMessages.length,
    handleSend,
    onSendPendingMessageNow,
  ]);

  useEffect(() => {
    return shortcutEvents.on("send-message-now", handleSendNow);
  }, [handleSendNow]);

  // 用户消息「写回输入框」入口：注册真实的 restoreContent 供消息侧调用。
  useEffect(() => registerChatInputDraftSink(restoreContent), [restoreContent]);

  useLayoutEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    return registerPluginDraftHost({
      element,
      projectId: projectId ?? conversationDirectoryId ?? "",
      sessionKey: sessionViewKey ?? "",
      conversationId: activeConversationId ?? null,
      worktreeId: pendingWorktreeId ?? undefined,
      worktreeMode,
      restoreContent,
    });
  }, [
    textareaRef,
    projectId,
    conversationDirectoryId,
    sessionViewKey,
    activeConversationId,
    pendingWorktreeId,
    worktreeMode,
    restoreContent,
  ]);

  return (
    <div
      ref={inputAreaRef}
      className={`input-area${composerExpanded ? " is-composer-expanded" : ""}${
        isResizing ? " is-resizing" : ""
      }`}
    >
      <ChatInputPanels
        projectId={projectId}
        projectName={projectName}
        isProjectMcpOpen={isProjectMcpOpen}
        projectMcpFocusServerId={projectMcpFocusServerId}
        onClearProjectMcpFocus={() => setProjectMcpFocusServerId(null)}
        isProjectSensitiveCommandsOpen={isProjectSensitiveCommandsOpen}
        isProjectPermissionsOpen={isProjectPermissionsOpen}
        isProjectSkillsOpen={isProjectSkillsOpen}
        isProjectCodebaseOpen={isProjectCodebaseOpen}
        isRoleEditorOpen={isRoleEditorOpen}
        isFileChangesOpen={isFileChangesOpen}
        isMemoryOpen={isMemoryOpen}
        isReviewOpen={isReviewOpen}
        isCustomCommandsOpen={isCustomCommandsOpen}
        workflowMode={workflowMode}
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
        onCloseProjectMcp={handleCloseMcpPanel}
        onCloseSensitiveCommands={() =>
          setIsProjectSensitiveCommandsOpen(false)
        }
        onClosePermissions={() => setIsProjectPermissionsOpen(false)}
        onCloseSkills={() => setIsProjectSkillsOpen(false)}
        onCloseCodebase={() => setIsProjectCodebaseOpen(false)}
        onCloseRoleEditor={() => setIsRoleEditorOpen(false)}
        onCloseFileChanges={() => setIsFileChangesOpen(false)}
        onCloseMemory={() => setIsMemoryOpen(false)}
        onCloseReview={() => setIsReviewOpen(false)}
        onCloseCustomCommands={() => setIsCustomCommandsOpen(false)}
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
          projectId={projectId}
        />
        <CommandPanel
          ref={commandPanelRef}
          commands={commands}
          query={commandQuery}
          visible={isCommandOpen}
          onClose={handleCloseCommand}
          onSelect={handleCommandSelect}
        />
        <RollbackTargetPopup
          visible={rollbackPicker.isOpen}
          targets={rollbackPicker.targets}
          selectedIndex={rollbackPicker.selectedIndex}
          isLoadingTargets={rollbackPicker.isLoadingTargets}
          preparingMessageId={rollbackPicker.preparingMessageId}
          loadError={rollbackPicker.loadError}
          containerRef={rollbackPicker.containerRef}
          onSelect={rollbackPicker.select}
        />
        {isStreaming && (
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
        )}
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
        <PendingMessages
          messages={pendingMessages}
          modes={pendingMessageModes}

          onWithdraw={handleWithdrawPending}
          onSendNow={handleSendPendingNow}
        />
        {/* 插件按钮层：压在输入框上沿、位于 Pending 之下 */}
        <div
          className="snow-client-slot chat-input-slot"
          data-snow-slot="chat.input.actions"
        />
        <div className="input-box">
          <div
            className="input-resize-handle"
            role="separator"
            aria-orientation="horizontal"
            aria-label={t("chatInput.resizeHandle", {
              defaultValue: "拖动调整高度，继续上拖展开大屏",
            })}
            title={t("chatInput.resizeHandle", {
              defaultValue: "拖动调整高度，继续上拖展开大屏",
            })}
            tabIndex={0}
            onPointerDown={handleResizePointerDown}
            onPointerMove={handleResizePointerMove}
            onPointerUp={handleResizePointerUp}
            onPointerCancel={handleResizePointerUp}
            onLostPointerCapture={handleResizePointerUp}
            onKeyDown={handleResizeKeyDown}
          >
            <GripHorizontal size={14} strokeWidth={2} aria-hidden="true" />
          </div>
          <div className="input-resize-hint" aria-hidden="true">
            {t("chatInput.composerExpandHint", {
              defaultValue: "继续上拖，展开大屏输入",
            })}
          </div>
          <div className="input-composer-header">
            <span className="input-composer-title">
              {t("chatInput.composerExpandedTitle", {
                defaultValue: "大屏输入",
              })}
            </span>
            <span className="input-composer-hint">
              {t("chatInput.composerExpandedHint", {
                defaultValue: "向下拖拽顶部把手或按 Esc 收起",
              })}
            </span>
            <button
              type="button"
              className="input-composer-collapse"
              onClick={collapseComposer}
              title={t("chatInput.composerCollapse", { defaultValue: "收起" })}
              aria-label={t("chatInput.composerCollapse", {
                defaultValue: "收起",
              })}
            >
              <Minimize2 size={14} strokeWidth={1.9} aria-hidden="true" />
            </button>
          </div>
          <div
            ref={textareaRef}
            className="input-field input-field-editable"
            contentEditable
            suppressContentEditableWarning
            data-placeholder={replyPrediction ? "" : placeholder}
            data-empty="true"
            onInput={handleInput}
            onKeyDown={handleInputKeyDownWithRollback}
            onCopy={handleCopy}
            onCut={handleCut}
            onPaste={handlePaste}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onMouseMove={(event) => {
              showImagePreview(event);
              textSnippetOverlay.showPreview(event);
              showChipDetails(event);
              showConversationPreview(event);
            }}
            onMouseLeave={() => {
              scheduleHideImagePreview();
              textSnippetOverlay.scheduleHidePreview();
              scheduleHideChipDetails();
              scheduleHideConversationPreview();
            }}
            onContextMenu={(event) => {
              // 网页引用 chip 的菜单优先接管；其余位置交给全局编辑菜单
              // （GlobalEditContextMenu，本组件不再自建）。
              handleWebChipContextMenu(event);
            }}
            onClick={(event) => {
              handleChipRemove(event);
              handleImageChipClick(event);
              textSnippetOverlay.handleChipClick(event);
              handleWebChipClick(event);
            }}
          />
          {replyPrediction ? (
            <div
              className="reply-prediction-ghost"
              aria-hidden="true"
              style={
                textareaRef.current
                  ? {
                      top: textareaRef.current.offsetTop,
                      left: textareaRef.current.offsetLeft,
                      width: textareaRef.current.clientWidth,
                    }
                  : undefined
              }
            >
              <span className="reply-prediction-text">{replyPrediction}</span>
              <kbd className="reply-prediction-hint">
                {t("chatInput.replyPredictionHint")}
              </kbd>
            </div>
          ) : null}
          <InputOverlayLayer
            imagePreview={imagePreview}
            imageLightbox={imageLightbox}
            setImageLightbox={setImageLightbox}
            textSnippetOverlay={textSnippetOverlay}
            webChipMenu={webChipMenu}
            setWebChipMenu={setWebChipMenu}
            chipDetails={chipDetails}
            conversationPreview={conversationPreview}
            cancelHideChipDetails={cancelHideChipDetails}
            scheduleHideChipDetails={scheduleHideChipDetails}
            cancelHideConversationPreview={cancelHideConversationPreview}
            scheduleHideConversationPreview={scheduleHideConversationPreview}
            syncContent={syncContent}
            onOpenWebChip={(url) => {
              rightPanelEvents.emit("open-browser-tab", { url });
            }}
          />
          <ChatInputToolbar
            sessionKey={sessionViewKey ?? ""}
            conversationId={activeConversationId ?? null}
            projectId={projectId}
            plusMenuSections={plusMenuSections}
            commandTriggerRef={commandTriggerRef}
            isCommandOpen={isCommandOpen}
            handleToggleCommand={handleToggleCommand}
            onOpenWorkflowComposer={() => {
              setComposerRestore(null);
              setIsWorkflowComposerOpen(true);
            }}
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
            autoScrollEnabled={autoScrollEnabled}
            onAutoScrollChange={onAutoScrollChange}
            autoFormatEnabled={autoFormatEnabled}
            onAutoFormatChange={onAutoFormatChange}
            onRefreshAutoFormat={onRefreshAutoFormat}
            toolCorrectionEnabled={toolCorrectionEnabled}
            onToolCorrectionChange={onToolCorrectionChange}
            onRefreshToolCorrection={onRefreshToolCorrection}
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
            thinkingError={thinkingError}
            responsesFastMode={responsesFastMode}
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
            handleApiConfigSaved={handleApiConfigSaved}
            handleToggleModelMenu={handleToggleModelMenu}
            handleSelectApiProfile={handleSelectApiProfile}
            handleSelectThinking={handleSelectThinking}
            handleSelectResponsesFastMode={handleSelectResponsesFastMode}
          />
        </div>
      </div>
      <HelpSkillDisabledDialog
        open={isHelpSkillDialogOpen}
        onClose={() => setIsHelpSkillDialogOpen(false)}
      />
      <WorkflowComposerDialog
        apiConfigs={apiConfigs}
        initial={composerRestore}
        onClose={closeWorkflowComposer}
        onSend={(graph, note) => {
          closeWorkflowComposer();
          // 用户消息 = 折叠的 WorkFlow 标签 + 备注；图随 options 直接生成工具调用
          handleSendMessage(buildWorkflowComposerContent(graph, note), {
            kind: "workflow",
            workflowGraph: graph,
            model: selectedModel || undefined,
            apiProfile: selectedApiProfile || undefined,
          });
        }}
        open={isWorkflowComposerOpen}
      />
    </div>
  );
};
