import {
  AlertCircle,
  ArrowDown,
  ArrowLeft,
  Bot,
  CheckCircle2,
  MessageSquareQuote,
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
import { RollbackConfirmDialog } from "./chatMessages/dialogs/RollbackConfirmDialog";
import { CompactionStream } from "./chatMessages/components/CompactionStream";
import { ChatHistorySkeleton } from "./chatMessages/components/ChatHistorySkeleton";
import { UserMessageRail } from "./chatMessages/components/UserMessageRail";
import type { MainContentView } from "./types";
import type { RollbackMode } from "./chatMessages/utils/conversationTypes";
import { useChatScrollFollow } from "./chatMessages/hooks/useChatScrollFollow";
import { usePathClickOpen } from "./chatMessages/hooks/usePathClickOpen";
import {
  buildTextSnippetSummary,
  INSERT_QUOTE_TAG_EVENT,
  type QuoteTag,
} from "./chatInput/fileTagUtils";
import { useTextSelectionQuote } from "./chatMessages/hooks/useTextSelectionQuote";
import { directoryIdToPath } from "./chatMessages/utils/conversationHelpers";

type ChatContentProps = {
  activeDirectory?: WorkspaceDirectoryRecord | null;
  /** 右侧面板全屏时以悬浮卡片呈现 */
  isFloating?: boolean;
  onNavigateToView?: (view: MainContentView) => void;
};

const ChatContentBody = ({
  activeDirectory,
  isFloating = false,
  onNavigateToView,
}: ChatContentProps): React.JSX.Element => {
  const scrollToBottomShortcut = useShortcutLabel("scrollToBottom");
  const {
    messages,
    activeConversationId,
    sessionViewKey,
    newChatGeneration,
    conversationDirectoryId,
    isLoadingOlderMessages,
    hasMoreMessages,
    isInitialHistoryLoaded,
    isLoadingInitialHistory,
    isStreaming,
    isAborting,
    handleAbort,
    tokenUsage,
    draftToRestore,
    autoSendToken,
    pendingAutoSendOverride,
    setPendingAutoSendOverride,
    clearDraftToRestore,
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
    withdrawPendingMessage,
    sendPendingMessageNow,
    compactConversation,
    compactionPreview,
    compactionError,
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
    planMode,
    isUpdatingPlanMode,
    setPlanMode,
    refreshPlanMode,
    goalMode,
    isUpdatingGoalMode,
    setGoalMode,
    refreshGoalMode,
    worktreeMode,
    isUpdatingWorktreeMode,
    setWorktreeMode,
    refreshWorktreeMode,
    workflowMode,
    isUpdatingWorkflowMode,
    setWorkflowMode,
    refreshWorkflowMode,
    goalModeTokenBudget,
    setGoalModeTokenBudget,
    conversationVersion,
    conversationListVersion,
    subAgentSessionEvents,
    handleSelectConversation,
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
  const hasMessages = messages.length > 0;

  // 悬浮只有两种形态：灵动岛胶囊（收起）/ 完整会话面板（展开）。
  // 默认收起为胶囊，流式状态一目了然；点击胶囊或切换会话即展开完整面板
  const [isFloatDismissed, setIsFloatDismissed] = useState(true);
  useEffect(() => {
    if (!isFloating) {
      setIsFloatDismissed(true);
    }
  }, [isFloating]);

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

  // 节点状态落盘（updateWorkflowNodeSession）不触发会话 upsert，runner 每次状态
  // 变化都会 bump conversationListVersion：观看中的节点会话据此重查元数据，
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
  });

  // 覆盖整个中间输出区：文件变更统计、消息正文、Thinking、工具调用和压缩输出。
  const pathClickOpenProps = usePathClickOpen(
    directoryIdToPath(conversationDirectoryId) ?? activeDirectory?.path,
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
  useEffect(() => {
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
                  canRollback={!isSubAgentConversation}
                  scrollContainerRef={scrollRef}
                />
                <CompactionStream
                  isCompacting={isCompactingActive}
                  compactionPreview={compactionPreview}
                  compactionError={activeCompactionError}
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
            <div
              className="snow-client-slot"
              data-snow-slot="chat.input.actions"
            />
            {showScrollToBottom && hasMessages ? (
              <button
                className={`chat-scroll-to-bottom${
                  isStreaming ? " is-streaming" : ""
                }`}
                type="button"
                onClick={handleScrollToBottom}
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
            {isSubAgentFinished ? (
              <SubAgentFinishedNotice
                status={subAgentRunStatus}
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
                autoSendToken={autoSendToken}
                onDraftRestored={clearDraftToRestore}
                autoSendOverride={pendingAutoSendOverride}
                onAutoSendOverrideConsumed={() =>
                  setPendingAutoSendOverride(null)
                }
                saveInputDraft={saveInputDraft}
                getInputDraft={getInputDraft}
                clearInputDraft={clearInputDraft}
                rollbackInputState={rollbackNewChatState}
                onRuntimeInputStateChange={handleRuntimeInputStateChange}
                getRuntimeInputState={getRuntimeInputState}
                loadOlderMessages={handleLoadOlderWithScroll}
                pendingMessages={pendingMessages}
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
                planMode={planMode}
                isUpdatingPlanMode={isUpdatingPlanMode}
                onPlanModeChange={setPlanMode}
                onRefreshPlanMode={refreshPlanMode}
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
                isCompacting={isCompactingActive}
              />
            )}
          </div>
        </>
      )}

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
        <div className="sub-agent-info-prompt" title={prompt}>
          <span className="sub-agent-info-prompt-label">
            {t("chat.subAgentInfo.prompt", { defaultValue: "Prompt" })}
          </span>
          <span className="sub-agent-info-prompt-text">{prompt}</span>
        </div>
      ) : null}
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
