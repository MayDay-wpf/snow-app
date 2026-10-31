import {
  AlertCircle,
  ArrowDown,
  ArrowLeft,
  Bot,
  CheckCircle2,
  MessageSquareQuote,
  RotateCcw,
  X,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { WorkspaceDirectoryRecord } from "../../../preload";
import { useAutoScrollPreference } from "../../hooks/useAutoScrollPreference";
import { useI18n } from "../../i18n";
import { useShortcutLabel } from "../../hooks/useShortcutLabel";
import { shortcutEvents } from "../shortcutEvents";
import { ChatFloatIsland } from "./ChatFloatIsland";
import { ChatFloatHeaderStatus } from "./ChatFloatHeaderStatus";
import { ChatInput } from "./ChatInput";
import { EmptyChatGreeting } from "./EmptyChatGreeting";
import { ChatMessageList, useChatConversationContext } from "./chatMessages";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { RollbackConfirmDialog } from "./chatMessages/dialogs/RollbackConfirmDialog";
import { CompactionStream } from "./chatMessages/components/CompactionStream";
import { ChatHistorySkeleton } from "./chatMessages/components/ChatHistorySkeleton";
import { FilePathOpenMenu } from "./chatMessages/components/FilePathOpenMenu";
import { UserMessageRail } from "./chatMessages/components/UserMessageRail";
import { PromptPreview } from "./chatMessages/components/PromptPreview";
import type { MainContentView } from "./types";
import type { RollbackMode } from "./chatMessages/utils/conversationTypes";
import { useChatScrollFollow } from "./chatMessages/hooks/useChatScrollFollow";
import { usePetChatSnapshot } from "./chatMessages/hooks/usePetChatSnapshot";
import { usePathClickOpen } from "./chatMessages/hooks/usePathClickOpen";
import { useProjectSwitchAutoSelect } from "./chatMessages/hooks/useProjectSwitchAutoSelect";
import {
  buildTextSnippetSummary,
  INSERT_QUOTE_TAG_EVENT,
  type QuoteTag,
} from "./chatInput/fileTagUtils";
import { useTextSelectionQuote } from "./chatMessages/hooks/useTextSelectionQuote";
import { directoryIdToPath } from "./chatMessages/utils/conversationHelpers";
import {
  refreshToolCorrectionPreference,
  setToolCorrectionPreference,
} from "./chatMessages/utils/toolCorrectionPreference";
import { registerSessionDraftSaver } from "./chatInput/chatInputDraftBridge";
import {
  resolveSubAgentFailureDecision,
  useSubAgentFailureAbandoned,
  useSubAgentFailurePending,
} from "./chatMessages/hooks/subAgentRunControl";

type ChatContentProps = {
  activeDirectory?: WorkspaceDirectoryRecord | null;
  /** 右侧面板全屏时以悬浮卡片呈现 */
  isFloating?: boolean;
  onNavigateToView?: (view: MainContentView) => void;
  /**
   * 聊天表面身份：main = 主内容区的聊天视图（缺省）；panel = 右侧面板里的
   * 会话面板。会话面板的会话由外层 ChatSessionScope 注入，这里只负责关闭
   * 「每窗口唯一」的行为（宠物快照上报、全局快捷键订阅、项目切换自动选中、
   * 消息窗口裁剪门控）。
   */
  surface?: "main" | "panel";
};

const ChatContentBody = ({
  activeDirectory,
  isFloating = false,
  onNavigateToView,
  surface = "main",
}: ChatContentProps): React.JSX.Element => {
  const isMainSurface = surface === "main";
  const scrollToBottomShortcut = useShortcutLabel("scrollToBottom");
  const {
    messages,
    activeConversationId,
    sessionViewKey,
    newChatGeneration,
    conversationDirectoryId,
    isLoadingOlderMessages,
    hasMoreMessages,
    isLoadingInitialHistory,
    isStreaming,
    isPaused,
    isAborting,
    handleAbort,
    tokenUsage,
    draftToRestore,
    clearDraftToRestore,
    rollbackWorkflowComposer,
    clearRollbackWorkflowComposer,
    autoSendRequest,
    claimAutoSend,
    completeAutoSend,
    saveInputDraft,
    getInputDraft,
    clearInputDraft,
    rollbackPreview,
    rollbackNewChatState,
    updateRuntimeInputState,
    getRuntimeInputState,
    confirmRollback,
    cancelRollback,
    pendingMessages,
    pendingMessageModes,

    withdrawPendingMessage,
    sendPendingMessageNow,
    compactConversation,
    compactionPreview,
    compactionError,
    dismissCompactionError,
    isCompacting,
    compactingConversationId,
    yoloMode,
    isUpdatingYoloMode,
    setYoloMode,
    refreshYoloMode,
    liteMode,
    isUpdatingLiteMode,
    setLiteMode,
    refreshLiteMode,
    goalMode,
    isUpdatingGoalMode,
    setGoalMode,
    refreshGoalMode,
    worktreeMode,
    isUpdatingWorktreeMode,
    setWorktreeMode,
    refreshWorktreeMode,
    worktreeModeNotice,
    setWorktreeModeNotice,
    workflowMode,
    isUpdatingWorkflowMode,
    setWorkflowMode,
    refreshWorkflowMode,
    goalModeTokenBudget,
    setGoalModeTokenBudget,
    conversationVersion,
    conversationListVersion,
    conversationTreeVersion,
    subAgentSessionEvents,
    // 项目切换自动选中读取的会话投影：内容指纹不变时引用稳定，不会随后台
    // 会话的每个流式帧重渲染。
    sessionsForList: sessions,
    newChatRequested,
    streamingConversationIds,
    attentionRequiredConversationIds,
    handleSelectConversation,
    handleNewChat,
    upsertedConversation,
  } = useChatConversationContext();
  const { t } = useI18n();
  const handleRuntimeInputStateChange = useCallback(
    (
      state: import("./chatInput/types").ConversationInputRuntimeState,
    ): void => {
      updateRuntimeInputState(activeConversationId, state);
    },
    [activeConversationId, updateRuntimeInputState],
  );
  const { autoScrollEnabled, setAutoScrollEnabled } = useAutoScrollPreference();

  const [autoFormatEnabled, setAutoFormatEnabled] = useState(false);
  const refreshAutoFormat = useCallback(async (): Promise<boolean> => {
    try {
      const enabled = await window.snow.getAutoFormat();
      setAutoFormatEnabled(enabled);
      return enabled;
    } catch {
      return false;
    }
  }, []);
  const [toolCorrectionEnabled, setToolCorrectionEnabled] = useState(true);
  const refreshToolCorrection = useCallback(async (): Promise<boolean> => {
    const enabled = await refreshToolCorrectionPreference();
    setToolCorrectionEnabled(enabled);
    return enabled;
  }, []);
  const hasMessages = messages.length > 0;

  useProjectSwitchAutoSelect({
    directoryId: activeDirectory?.directoryId ?? "",
    activeConversationId,
    newChatRequested,
    sessions,
    streamingConversationIds,
    attentionRequiredConversationIds,
    handleSelectConversation,
    handleNewChat,
    // 项目切换自动选中只属于主视图：会话面板绑定的会话不随主视图项目切换。
    enabled: isMainSurface,
  });

  // 悬浮只有两种形态：灵动岛胶囊（收起）/ 完整会话面板（展开）。
  // 默认收起为胶囊，流式状态一目了然；点击胶囊或切换会话即展开完整面板
  const [isFloatDismissed, setIsFloatDismissed] = useState(true);
  useEffect(() => {
    if (!isFloating) {
      setIsFloatDismissed(true);
    }
  }, [isFloating]);

  useEffect(() => {
    return registerSessionDraftSaver((_sessionKey, conversationId, content) => {
      saveInputDraft(conversationId ?? undefined, content);
    });
  }, [saveInputDraft]);

  const hasHistoryContent = hasMessages;

  // 悬浮模式下活动会话变化（侧边栏切换/新建/彻底回滚）必须重开面板，
  // 否则灵动岛态下切换毫无可见反馈，表现为「切换会话无效」
  const prevFloatConversationIdRef = useRef<string | undefined>(
    activeConversationId,
  );
  useEffect(() => {
    if (!isFloating) {
      prevFloatConversationIdRef.current = activeConversationId;
      return;
    }
    if (prevFloatConversationIdRef.current === activeConversationId) {
      return;
    }
    prevFloatConversationIdRef.current = activeConversationId;
    setIsFloatDismissed(false);
  }, [isFloating, activeConversationId]);

  // chat-area 的实际挂载条件：灵动岛态下不渲染，展开时 DOM 节点整体
  // 重建，滚动相关 effect 据此重跑
  const isChatAreaRendered = !isFloating || !isFloatDismissed;

  // 压缩状态（含失败提示）按会话归属过滤：压缩失败时 compactingConversationId
  // 会保留在该会话上，让失败横线提示继续可见（isCompacting 已复位）。
  const isCompactionForActiveConversation =
    activeConversationId != null &&
    activeConversationId === compactingConversationId;
  const isCompactingActive = isCompacting && isCompactionForActiveConversation;
  const activeCompactionError = isCompactionForActiveConversation
    ? compactionError
    : null;

  const [activeConversationMeta, setActiveConversationMeta] = useState<{
    conversationType: string;
    subAgentStatus: string;
    parentConversationId: string;
    title: string;
    summary: string;
    subAgentName: string;
    subAgentId: string;
  } | null>(null);

  useEffect(() => {
    // 切换会话时立即清空元数据：上一会话的子代理状态不得在目标会话
    // 的历史加载期间泄漏（否则输入框区会短暂显示错误的 Notice/状态）。
    setActiveConversationMeta(null);
    if (!activeConversationId) {
      return;
    }

    let cancelled = false;
    void window.snow
      .getChatConversation(activeConversationId)
      .then((record) => {
        if (cancelled || !record) {
          return;
        }
        setActiveConversationMeta({
          conversationType: record.conversationType,
          subAgentStatus: record.subAgentStatus,
          parentConversationId: record.parentConversationId,
          title: record.title,
          summary: record.summary,
          subAgentName: record.subAgentName,
          subAgentId: record.subAgentId,
        });
      })
      .catch(() => {
        // Best effort — live session events still cover in-flight runs.
      });

    return () => {
      cancelled = true;
    };
  }, [activeConversationId]);

  // 宠物聊天上下文：把当前打开会话的「实时运行快照」节流同步给主进程 ——
  // 在途正文、每一次工具调用的参数/状态/结果、待办进度、运行状态。宠物窗口
  // 据此回答「进行到哪一步」这类问题（btw 式旁路会话）。没有打开的会话时
  // 上报空快照，宠物聊天转为纯闲聊。
  const conversationWorkspacePath =
    directoryIdToPath(conversationDirectoryId) ?? activeDirectory?.path;
  usePetChatSnapshot(
    {
      conversationId: activeConversationId ?? null,
      title: activeConversationMeta?.title?.trim() || null,
      directoryId:
        conversationDirectoryId ?? activeDirectory?.directoryId ?? null,
      workspacePath: conversationWorkspacePath ?? null,
      isStreaming,
      isPaused,
      messages,
    },
    // 宠物快照每窗口只上报一份：会话面板不参与，避免两份上下文互相覆盖。
    isMainSurface,
  );

  const liveSubAgentEvent = activeConversationId
    ? subAgentSessionEvents[activeConversationId]
    : undefined;
  const isSubAgentConversation =
    Boolean(liveSubAgentEvent) ||
    activeConversationMeta?.conversationType === "sub_agent";
  const subAgentRunStatus =
    liveSubAgentEvent?.status ?? activeConversationMeta?.subAgentStatus ?? "";

  const isSubAgentFinished =
    isSubAgentConversation &&
    ["completed", "failed", "cancelled"].includes(subAgentRunStatus);
  const subAgentParentConversationId =
    activeConversationMeta?.parentConversationId ||
    liveSubAgentEvent?.parentConversationId ||
    "";

  // workflow 节点会话（conversationType = workflow_node）与子代理同构：
  // run_status 映射进 subAgentStatus 字段；节点结束（completed/failed）后
  // 会话转只读，输入框替换为收尾栏（resume 续跑会重新落 running）。
  const isWorkflowNodeConversation =
    activeConversationMeta?.conversationType === "workflow_node";
  const workflowNodeRunStatus = activeConversationMeta?.subAgentStatus ?? "";
  const isWorkflowNodeFinished =
    isWorkflowNodeConversation &&
    ["completed", "failed"].includes(workflowNodeRunStatus);
  const workflowNodeParentConversationId =
    activeConversationMeta?.parentConversationId ?? "";
  const isRunActive =
    (isSubAgentConversation && !isSubAgentFinished) ||
    (isWorkflowNodeConversation && !isWorkflowNodeFinished);
  const isSubAgentFailurePending =
    useSubAgentFailurePending(activeConversationId ?? undefined) &&
    isSubAgentConversation &&
    !isSubAgentFinished;
  // 放弃后运行仍要收尾才落终态：期间直接展示失败收尾栏，输入框不再闪现。
  const isSubAgentAbandoning =
    useSubAgentFailureAbandoned(activeConversationId ?? undefined) &&
    isSubAgentConversation &&
    !isSubAgentFinished;

  // 节点状态落盘（updateWorkflowNodeSession）不触发会话 upsert，runner 每次状态
  // 变化都会 bump conversationTreeVersion：观看中的节点会话据此重查元数据，
  // 节点结束即时切只读，续跑恢复输入框；非节点会话不产生额外查询。
  useEffect(() => {
    if (!activeConversationId || !isWorkflowNodeConversation) {
      return;
    }
    let cancelled = false;
    void window.snow
      .getChatConversation(activeConversationId)
      .then((record) => {
        if (cancelled || !record) {
          return;
        }
        setActiveConversationMeta({
          conversationType: record.conversationType,
          subAgentStatus: record.subAgentStatus,
          parentConversationId: record.parentConversationId,
          title: record.title,
          summary: record.summary,
          subAgentName: record.subAgentName,
          subAgentId: record.subAgentId,
        });
      })
      .catch(() => {
        // Best effort — 保留当前元数据，仅缺少即时刷新
      });
    return () => {
      cancelled = true;
    };
  }, [
    activeConversationId,
    conversationListVersion,
    conversationTreeVersion,
    isWorkflowNodeConversation,
  ]);

  // 子代理关联的主会话信息（标题/摘要），用于信息头的“由主会话启动”展示。
  // 展示时优先取 AI 生成的摘要——标题只是首条用户消息原文（常带文件标签）。
  const [subAgentParentMeta, setSubAgentParentMeta] = useState<{
    title: string;
    summary: string;
  } | null>(null);

  useEffect(() => {
    if (!subAgentParentConversationId) {
      setSubAgentParentMeta(null);
      return;
    }

    let cancelled = false;
    void window.snow
      .getChatConversation(subAgentParentConversationId)
      .then((record) => {
        if (cancelled || !record) {
          return;
        }
        setSubAgentParentMeta({
          title: record.title,
          summary: record.summary,
        });
      })
      .catch(() => {
        // Best effort — the header simply omits the parent label.
      });

    return () => {
      cancelled = true;
    };
  }, [subAgentParentConversationId]);

  useEffect(() => {
    const record = upsertedConversation?.record;
    if (
      !record ||
      !subAgentParentConversationId ||
      record.conversationId !== subAgentParentConversationId ||
      !record.summary
    ) {
      return;
    }
    setSubAgentParentMeta({ title: record.title, summary: record.summary });
  }, [upsertedConversation, subAgentParentConversationId]);

  // 当前会话被 upsert 时跟随刷新摘要：悬浮头部运行中显示 AI 摘要，
  // 而非首条用户消息（title）。
  useEffect(() => {
    const record = upsertedConversation?.record;
    if (
      !record ||
      record.conversationId !== activeConversationId ||
      !record.summary
    ) {
      return;
    }
    setActiveConversationMeta((meta) =>
      meta ? { ...meta, summary: record.summary } : meta,
    );
  }, [upsertedConversation, activeConversationId]);

  const subAgentName =
    liveSubAgentEvent?.agentName ?? activeConversationMeta?.subAgentName ?? "";
  const subAgentSessionTitle = activeConversationMeta?.title ?? "";
  const subAgentPrompt =
    messages.find((message) => message.role === "user")?.content ?? "";

  // 视图重建 key 用 sessionViewKey（而非 activeConversationId）：pending 会话
  // 首轮结束迁移为真实 ID 时它保持不变，chat-area / ChatInput 不重建——
  // 否则首次工具组挂载的同一瞬间整页闪烁、输入框失焦。
  // 它同时是滚动容器的身份：项目切换（directoryId 变化）会让 chat-area
  // 整体重挂载、新容器 scrollTop 归零，但 activeConversationId 不变——
  // 滚动状态的复位与初始定位必须据此判断，否则新容器停在顶部。
  const chatRenderKey = `${activeDirectory?.directoryId ?? "no-project"}:${sessionViewKey}:${newChatGeneration}`;

  // 滚动跟随控制器（钉底资格推导、即时钉底、翻页恢复、滚动事件 handlers）。
  const {
    scrollRef,
    streamViewportRef,
    showScrollToBottom,
    markUserScrollIntent,
    handleChatWheel,
    handleChatPointerDown,
    handleChatPointerMove,
    handleChatPointerLeave,
    handleChatKeyDown,
    handleChatScroll,
    handleScrollToBottom,
    handleLoadOlderWithScroll,
    handleSendWithScroll,
    shouldStickToBottomRef,
    isInitialBottomPositioningRef,
    isUserScrollIntentRef,
  } = useChatScrollFollow({
    chatRenderKey,
    isChatAreaRendered,
    isCompactingActive,
    autoScrollEnabled,
    // 消息窗口裁剪门控是模块级单例：只由主聊天表面注册。
    registerViewGate: isMainSurface,
  });

  // 覆盖整个中间输出区：文件变更统计、消息正文、Thinking、工具调用和压缩输出。
  const pathClickOpenProps = usePathClickOpen(
    conversationWorkspacePath,
    conversationDirectoryId ?? activeDirectory?.directoryId,
  );
  // 划词引用：AI 正文 / 思考块内选中文本后浮现「添加到输入框」按钮。
  const { quoteState, dismissQuote } = useTextSelectionQuote(scrollRef);
  const handleAddQuoteToInput = useCallback((): void => {
    if (!quoteState) {
      return;
    }
    const tag: QuoteTag = {
      content: quoteState.text,
      summary: buildTextSnippetSummary(quoteState.text),
      charCount: quoteState.text.length,
    };
    window.dispatchEvent(
      new CustomEvent<QuoteTag>(INSERT_QUOTE_TAG_EVENT, { detail: tag }),
    );
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) {
      selection.removeAllRanges();
    }
    dismissQuote();
  }, [quoteState, dismissQuote]);
  // 开启自动滚动偏好是显式的“我要跟随”动作：立即平滑吸底并恢复跟随，
  // 让开关有即时的视觉反馈；关闭则保持当前位置不动。
  const handleAutoScrollChange = useCallback(
    (enabled: boolean): void => {
      setAutoScrollEnabled(enabled);
      if (enabled) {
        handleScrollToBottom();
      }
    },
    [setAutoScrollEnabled, handleScrollToBottom],
  );

  // 快捷键：滚动到顶部 / 底部；复制最后一条 AI 回复。
  // 这些动作作用于「当前聊天表面」，同一窗口只应由主聊天视图响应，
  // 否则会话面板也会跟着滚动 / 复制。
  useEffect(() => {
    if (!isMainSurface) {
      return;
    }
    const unsubTop = shortcutEvents.on("scroll-to-top", () => {
      const el = scrollRef.current;
      if (el) {
        el.scrollTo({ top: 0, behavior: "smooth" });
        markUserScrollIntent(0);
      }
    });
    const unsubBottom = shortcutEvents.on("scroll-to-bottom", () => {
      handleScrollToBottom();
    });
    const unsubCopy = shortcutEvents.on("copy-last-response", () => {
      const lastAssistant = [...messages]
        .reverse()
        .find((message) => message.role === "assistant");
      if (!lastAssistant?.content) {
        return;
      }
      void navigator.clipboard.writeText(lastAssistant.content);
    });
    return () => {
      unsubTop();
      unsubBottom();
      unsubCopy();
    };
  }, [scrollRef, markUserScrollIntent, handleScrollToBottom, messages]);

  // 切换自动格式化：乐观更新 UI，写入失败时回读真实状态。
  const handleAutoFormatChange = useCallback(
    (enabled: boolean): void => {
      setAutoFormatEnabled(enabled);
      void window.snow.setAutoFormat(enabled).catch(() => {
        void refreshAutoFormat();
      });
    },
    [refreshAutoFormat],
  );

  // 切换自动纠错：乐观更新 UI，写入失败时回读真实状态。
  const handleToolCorrectionChange = useCallback((enabled: boolean): void => {
    setToolCorrectionEnabled(enabled);
    void setToolCorrectionPreference(enabled).then((actual) => {
      setToolCorrectionEnabled(actual);
    });
  }, []);

  const handleConfirmRollback = useCallback(
    async (mode: RollbackMode, deleteMemories?: boolean): Promise<void> => {
      // 返回真实 Promise：RollbackConfirmDialog 的确认按钮据此在整个
      // 回滚期间（含 SSH 文件恢复）保持 loading，完成后再关闭弹窗。
      await confirmRollback(mode, deleteMemories);
    },
    [confirmRollback],
  );

  // 悬浮头部标题：AI 摘要 > 会话标题 > 项目名 > 兜底（运行中优先摘要）
  const floatTitle =
    activeConversationMeta?.summary ||
    activeConversationMeta?.title ||
    activeDirectory?.name ||
    t("chat.float.untitled");

  const chatContentClasses = [
    "chat-content",
    hasHistoryContent ? "has-messages" : "is-empty",
    isFloating ? "is-floating" : "",
    isFloating && !isFloatDismissed ? "is-float-expanded" : "",
    isFloating && isFloatDismissed ? "is-float-dismissed" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={chatContentClasses}>
      {isFloating && isFloatDismissed ? (
        <ChatFloatIsland onReopen={() => setIsFloatDismissed(false)} />
      ) : (
        <>
          {isFloating ? (
            <div className="chat-float-header">
              <span
                className={`chat-float-dot${isStreaming ? " is-streaming" : ""}`}
                aria-hidden="true"
              />
              <span className="chat-float-title" title={floatTitle}>
                {floatTitle}
              </span>
              <ChatFloatHeaderStatus activeDirectory={activeDirectory} />
              <div className="chat-float-actions">
                <button
                  type="button"
                  className="chat-float-action-btn"
                  onClick={() => setIsFloatDismissed(true)}
                  aria-label={t("chat.float.close")}
                  title={t("chat.float.close")}
                >
                  <X size={14} strokeWidth={1.8} aria-hidden="true" />
                </button>
              </div>
            </div>
          ) : null}
          <div
            key={chatRenderKey}
            className={`chat-area ${isLoadingInitialHistory ? "is-loading-history" : ""}`}
            data-snow-anchor="chat.messages"
            ref={scrollRef}
            onClick={pathClickOpenProps.onClick}
            onAuxClick={pathClickOpenProps.onAuxClick}
            onContextMenu={pathClickOpenProps.onContextMenu}
            onWheel={handleChatWheel}
            onTouchStart={() => markUserScrollIntent(0)}
            onPointerDown={handleChatPointerDown}
            onPointerMove={handleChatPointerMove}
            onPointerLeave={handleChatPointerLeave}
            onKeyDown={handleChatKeyDown}
            onScroll={handleChatScroll}
            tabIndex={0}
            aria-busy={isLoadingInitialHistory || isLoadingOlderMessages}
          >
            {isLoadingInitialHistory ? (
              <ChatHistorySkeleton />
            ) : hasMessages ? (
              <>
                {isSubAgentConversation ? (
                  <SubAgentInfoHeader
                    agentName={subAgentName}
                    sessionTitle={subAgentSessionTitle}
                    prompt={subAgentPrompt}
                    parentTitle={
                      subAgentParentMeta?.summary ||
                      subAgentParentMeta?.title ||
                      ""
                    }
                    parentConversationId={subAgentParentConversationId}
                    onBackToParent={handleSelectConversation}
                  />
                ) : null}
                <ChatMessageList
                  messages={messages}
                  isStreaming={isStreaming}
                  isAborting={isAborting}
                  isRunActive={isRunActive}
                  canRollback={!isSubAgentConversation}
                  scrollContainerRef={scrollRef}
                  streamViewportRef={streamViewportRef}
                />
                <CompactionStream
                  isCompacting={isCompactingActive}
                  compactionPreview={compactionPreview}
                  compactionError={activeCompactionError}
                  onDismissError={dismissCompactionError}
                />
              </>
            ) : (
              <EmptyChatGreeting
                activeDirectory={activeDirectory}
                onNavigateToView={onNavigateToView}
              />
            )}
          </div>

          {hasMessages ? (
            <UserMessageRail
              conversationId={activeConversationId}
              scrollContainerRef={scrollRef}
              containerKey={chatRenderKey}
              loadOlderMessages={handleLoadOlderWithScroll}
              isLoadingOlderMessages={isLoadingOlderMessages}
              hasMoreMessages={hasMoreMessages}
              conversationVersion={conversationVersion}
              shouldStickToBottomRef={shouldStickToBottomRef}
              isInitialBottomPositioningRef={isInitialBottomPositioningRef}
              isUserScrollIntentRef={isUserScrollIntentRef}
            />
          ) : null}

          <div className="chat-input-region" data-snow-anchor="chat.input">
            {showScrollToBottom && hasMessages ? (
              <button
                className={`chat-scroll-to-bottom${
                  isStreaming ? " is-streaming" : ""
                }`}
                type="button"
                onClick={() => handleScrollToBottom({ animate: true })}
                aria-label={t("chat.scrollToBottom")}
                title={
                  scrollToBottomShortcut
                    ? `${t("chat.scrollToBottom")} (${scrollToBottomShortcut})`
                    : t("chat.scrollToBottom")
                }
              >
                <ArrowDown size={20} strokeWidth={2} aria-hidden="true" />
              </button>
            ) : null}
            {isSubAgentFailurePending && activeConversationId ? (
              <SubAgentRetryBar conversationId={activeConversationId} />
            ) : isSubAgentFinished || isSubAgentAbandoning ? (
              <SubAgentFinishedNotice
                status={isSubAgentFinished ? subAgentRunStatus : "failed"}
                parentConversationId={subAgentParentConversationId}
                onBackToParent={handleSelectConversation}
              />
            ) : isWorkflowNodeFinished ? (
              <SubAgentFinishedNotice
                status={workflowNodeRunStatus}
                parentConversationId={workflowNodeParentConversationId}
                onBackToParent={handleSelectConversation}
                kind="workflow_node"
              />
            ) : (
              <ChatInput
                key={chatRenderKey}
                projectId={activeDirectory?.directoryId}
                projectName={activeDirectory?.name}
                conversationId={activeConversationId}
                onSend={handleSendWithScroll}
                onNavigateToView={onNavigateToView}
                isStreaming={isStreaming}
                isAborting={isAborting}
                onAbort={handleAbort}
                tokenUsage={tokenUsage}
                draftToRestore={draftToRestore}
                onDraftRestored={clearDraftToRestore}
                rollbackWorkflowComposer={rollbackWorkflowComposer}
                onRollbackWorkflowRestored={clearRollbackWorkflowComposer}
                autoSendRequest={autoSendRequest}
                claimAutoSend={claimAutoSend}
                completeAutoSend={completeAutoSend}
                saveInputDraft={saveInputDraft}
                getInputDraft={getInputDraft}
                clearInputDraft={clearInputDraft}
                rollbackInputState={rollbackNewChatState}
                onRuntimeInputStateChange={handleRuntimeInputStateChange}
                getRuntimeInputState={getRuntimeInputState}
                loadOlderMessages={handleLoadOlderWithScroll}
                pendingMessages={pendingMessages}
                pendingMessageModes={pendingMessageModes}

                onWithdrawPendingMessage={withdrawPendingMessage}
                onSendPendingMessageNow={sendPendingMessageNow}
                onCompactConversation={compactConversation}
                yoloMode={yoloMode}
                isUpdatingYoloMode={isUpdatingYoloMode}
                onYoloModeChange={setYoloMode}
                onRefreshYoloMode={refreshYoloMode}
                liteMode={liteMode}
                isUpdatingLiteMode={isUpdatingLiteMode}
                onLiteModeChange={setLiteMode}
                onRefreshLiteMode={refreshLiteMode}
                goalMode={goalMode}
                isUpdatingGoalMode={isUpdatingGoalMode}
                onGoalModeChange={setGoalMode}
                onRefreshGoalMode={refreshGoalMode}
                worktreeMode={worktreeMode}
                isUpdatingWorktreeMode={isUpdatingWorktreeMode}
                onWorktreeModeChange={setWorktreeMode}
                onRefreshWorktreeMode={refreshWorktreeMode}
                workflowMode={workflowMode}
                isUpdatingWorkflowMode={isUpdatingWorkflowMode}
                onWorkflowModeChange={setWorkflowMode}
                onRefreshWorkflowMode={refreshWorkflowMode}
                goalModeTokenBudget={goalModeTokenBudget}
                onGoalModeTokenBudgetChange={setGoalModeTokenBudget}
                autoScrollEnabled={autoScrollEnabled}
                onAutoScrollChange={handleAutoScrollChange}
                autoFormatEnabled={autoFormatEnabled}
                onAutoFormatChange={handleAutoFormatChange}
                onRefreshAutoFormat={refreshAutoFormat}
                toolCorrectionEnabled={toolCorrectionEnabled}
                onToolCorrectionChange={handleToolCorrectionChange}
                onRefreshToolCorrection={refreshToolCorrection}
                isCompacting={isCompactingActive}
              />
            )}
          </div>
        </>
      )}

      {/* 正文文件路径（md-file-path）右键菜单：文件管理器 / 系统默认应用 / IDE。 */}
      {pathClickOpenProps.pathMenu ? (
        <FilePathOpenMenu
          target={pathClickOpenProps.pathMenu}
          onClose={pathClickOpenProps.closePathMenu}
        />
      ) : null}

      {rollbackPreview ? (
        <RollbackConfirmDialog
          key={rollbackPreview.requestId}
          changes={rollbackPreview.changes}
          checkpointIds={[
            ...rollbackPreview.checkpointIds,
            ...rollbackPreview.flowCheckpointIds,
          ]}
          workDir={rollbackPreview.workDir}
          isFirstMessage={rollbackPreview.isFirstMessage}
          todoItems={rollbackPreview.todoItems}
          memoryItems={rollbackPreview.memoryItems}
          workflowFlowCount={rollbackPreview.workflowFlowCount}
          error={rollbackPreview.error}
          onConfirm={handleConfirmRollback}
          onCancel={cancelRollback}
        />
      ) : null}

      {/* WorkTree 模式已开启但未绑定工作树：发送被拦截时的内置提示（替代系统 alert）。 */}
      <ConfirmDialog
        open={worktreeModeNotice !== null}
        title={t("git.worktreesTitle")}
        message={worktreeModeNotice ?? ""}
        confirmLabel={t("git.errorDismiss")}
        variant="warning"
        onConfirm={() => setWorktreeModeNotice(null)}
        onCancel={() => setWorktreeModeNotice(null)}
      />

      {quoteState
        ? createPortal(
            <div
              className="text-selection-quote-popup"
              data-quote-popup="true"
              style={{ left: quoteState.x, top: quoteState.y }}
            >
              <button
                type="button"
                className="text-selection-quote-btn"
                onMouseDown={(event) => event.preventDefault()}
                onClick={handleAddQuoteToInput}
                title={t("chat.quote.addToInput")}
              >
                <MessageSquareQuote
                  size={14}
                  strokeWidth={2}
                  aria-hidden="true"
                />
                <span>{t("chat.quote.addToInput")}</span>
              </button>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
};

const SubAgentInfoHeader = ({
  agentName,
  sessionTitle,
  prompt,
  parentTitle,
  parentConversationId,
  onBackToParent,
}: {
  agentName: string;
  sessionTitle: string;
  prompt: string;
  parentTitle: string;
  parentConversationId: string;
  onBackToParent: (conversationId: string) => Promise<void> | void;
}): React.JSX.Element => {
  const { t } = useI18n();

  const displayTitle =
    sessionTitle ||
    (prompt.length > 80 ? `${prompt.slice(0, 80)}...` : prompt) ||
    agentName;

  return (
    <div className="sub-agent-info-header">
      <div className="sub-agent-info-header-top">
        {agentName ? (
          <span className="sub-agent-info-agent" title={agentName}>
            <Bot size={13} strokeWidth={1.8} aria-hidden="true" />
            <span>{agentName}</span>
          </span>
        ) : null}
        {parentConversationId ? (
          <button
            type="button"
            className="sub-agent-info-parent"
            onClick={() => void onBackToParent(parentConversationId)}
            title={parentTitle || undefined}
          >
            <ArrowLeft size={12} strokeWidth={2} aria-hidden="true" />
            <span>
              {t("chat.subAgentInfo.launchedBy", {
                defaultValue: 'Launched by parent "{{title}}"',
                values: { title: parentTitle || "…" },
              })}
            </span>
          </button>
        ) : null}
      </div>
      <div className="sub-agent-info-title" title={displayTitle}>
        {displayTitle}
      </div>
      {prompt ? (
        <div className="sub-agent-info-prompt">
          <PromptPreview
            text={prompt}
            label={t("chat.subAgentInfo.prompt", { defaultValue: "Prompt" })}
          />
        </div>
      ) : null}
    </div>
  );
};

/** 子代理请求失败挂起时替换输入框：主会话等待用户选择重试或放弃。 */
const SubAgentRetryBar = ({
  conversationId,
}: {
  conversationId: string;
}): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <div className="sub-agent-finished-bar is-error">
      <span className="sub-agent-finished-bar-status">
        <AlertCircle size={15} aria-hidden="true" />
        <span>
          {t("chat.subAgentRetry.pending", {
            defaultValue:
              "The sub-agent request failed. The parent conversation is waiting for your decision.",
          })}
        </span>
      </span>
      <span className="sub-agent-retry-actions">
        <button
          type="button"
          className="sub-agent-finished-bar-back"
          onClick={() =>
            resolveSubAgentFailureDecision(conversationId, "abandon")
          }
        >
          <XCircle size={13} aria-hidden="true" />
          {t("chat.subAgentRetry.abandon", { defaultValue: "Give up" })}
        </button>
        <button
          type="button"
          className="sub-agent-finished-bar-back is-primary"
          onClick={() =>
            resolveSubAgentFailureDecision(conversationId, "retry")
          }
        >
          <RotateCcw size={13} aria-hidden="true" />
          {t("chat.subAgentRetry.retry", { defaultValue: "Retry" })}
        </button>
      </span>
    </div>
  );
};

const SubAgentFinishedNotice = ({
  status,
  parentConversationId,
  onBackToParent,
  kind = "sub_agent",
}: {
  status: string;
  parentConversationId: string;
  onBackToParent: (conversationId: string) => Promise<void> | void;
  /** 文案组：workflow 节点会话结束复用同一条只读收尾栏。 */
  kind?: "sub_agent" | "workflow_node";
}): React.JSX.Element => {
  const { t } = useI18n();

  const keyPrefix =
    kind === "workflow_node"
      ? "chat.workflowNodeFinished"
      : "chat.subAgentFinished";
  const icon =
    status === "failed" ? (
      <AlertCircle size={15} aria-hidden="true" />
    ) : status === "cancelled" ? (
      <XCircle size={15} aria-hidden="true" />
    ) : (
      <CheckCircle2 size={15} aria-hidden="true" />
    );
  const [messageKey, messageDefault] =
    status === "failed"
      ? [
          `${keyPrefix}.failed`,
          kind === "workflow_node"
            ? "This workflow node failed. The conversation is read-only."
            : "This sub-agent failed. The conversation is read-only.",
        ]
      : status === "cancelled"
        ? [
            "chat.subAgentFinished.cancelled",
            "This sub-agent was cancelled. The conversation is read-only.",
          ]
        : [
            `${keyPrefix}.completed`,
            kind === "workflow_node"
              ? "This workflow node has finished. The conversation is read-only."
              : "This sub-agent has finished. The conversation is read-only.",
          ];

  return (
    <div
      className={`sub-agent-finished-bar${
        status === "failed" || status === "cancelled" ? " is-error" : ""
      }`}
    >
      <span className="sub-agent-finished-bar-status">
        {icon}
        <span>{t(messageKey, { defaultValue: messageDefault })}</span>
      </span>
      {parentConversationId ? (
        <button
          type="button"
          className="sub-agent-finished-bar-back"
          onClick={() => void onBackToParent(parentConversationId)}
        >
          <ArrowLeft size={13} aria-hidden="true" />
          {t(`${keyPrefix}.backToParent`, {
            defaultValue: "Back to parent conversation",
          })}
        </button>
      ) : null}
    </div>
  );
};

export const ChatContent = ({
  activeDirectory,
  isFloating,
  onNavigateToView,
}: ChatContentProps): React.JSX.Element => {
  return (
    <ChatContentBody
      activeDirectory={activeDirectory}
      isFloating={isFloating}
      onNavigateToView={onNavigateToView}
    />
  );
};
