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
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { WorkspaceDirectoryRecord } from "../../../preload";
import { useAutoScrollPreference } from "../../hooks/useAutoScrollPreference";
import { useI18n } from "../../i18n";
import { ChatFloatIsland } from "./ChatFloatIsland";
import { ChatFloatHeaderStatus } from "./ChatFloatHeaderStatus";
import { ChatInput } from "./ChatInput";
import { EmptyChatGreeting } from "./EmptyChatGreeting";
import { ChatMessageList, useChatConversationContext } from "./chatMessages";
import { RollbackConfirmDialog } from "./chatMessages/dialogs/RollbackConfirmDialog";
import { CompactionStream } from "./chatMessages/components/CompactionStream";
import { UserMessageRail } from "./chatMessages/components/UserMessageRail";
import type { ChatInputSendOptions } from "./chatInput/types";
import type { MainContentView } from "./types";
import type { RollbackMode } from "./chatMessages/utils/conversationTypes";
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

type PendingScrollRestore = {
  conversationId: string;
  requestId: number;

  anchorElement: Element | null;

  anchorContentOffset: number;

  firstMessageId: string | undefined;
  /** 恢复收敛轮次计数（防御性上限）。 */
  rounds: number;
  /** anchor 缺失/失效时的兜底几何快照：翻页前的 scrollHeight/scrollTop。 */
  scrollHeight: number;
  scrollTop: number;
};

const LOAD_OLDER_SCROLL_THRESHOLD = 96;
const SHOW_SCROLL_TO_BOTTOM_THRESHOLD = 160;
const STICK_TO_BOTTOM_THRESHOLD = 16;

const USER_SCROLL_INTENT_WINDOW_MS = 750;
// Run 结束（isStreaming true→false）后消息集中定稿重渲染：动作按钮出现、
// run summary 摘要条插入、Thinking 折叠、markdown 定稿，高度逐帧变化。
// 在此窗口内保持钉底资格，把最终总结带到可视底部。
const RUN_FINISH_FOLLOW_GRACE_MS = 1200;

const willNestedScrollerConsumeWheel = (
  container: HTMLElement,
  target: EventTarget | null,
  deltaY: number,
): boolean => {
  let node = target instanceof HTMLElement ? target : null;
  while (node && node !== container) {
    if (node.scrollHeight > node.clientHeight + 1) {
      const overflowY = window.getComputedStyle(node).overflowY;
      if (overflowY === "auto" || overflowY === "scroll") {
        const maxScrollTop = node.scrollHeight - node.clientHeight;
        if (
          (deltaY < 0 && node.scrollTop > 0) ||
          (deltaY > 0 && node.scrollTop < maxScrollTop - 1)
        ) {
          return true;
        }
      }
    }
    node = node.parentElement;
  }
  return false;
};

const ChatContentBody = ({
  activeDirectory,
  isFloating = false,
  onNavigateToView,
}: ChatContentProps): React.JSX.Element => {
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
    loadOlderMessages,
    handleSendMessage,
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
    pendingToolAuthorizations,
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
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
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

  const scrollRef = useRef<HTMLDivElement>(null);
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
  const activeConversationIdRef = useRef(activeConversationId);
  const previousActiveConversationIdRef = useRef(activeConversationId);
  const positionedConversationIdsRef = useRef(new Set<string>());
  const pendingScrollRestoreRef = useRef<PendingScrollRestore | null>(null);
  const scrollRestoreRequestIdRef = useRef(0);
  const isLoadingOlderWithScrollRef = useRef(false);
  const scrolledAuthorizationSignatureRef = useRef("");
  const shouldStickToBottomRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  // 上次 scroll 事件时的几何快照：用于区分「用户滚动」与「滚动锚定/clamp 位移」。
  const lastScrollHeightRef = useRef(0);
  const lastClientHeightRef = useRef(0);
  const isInitialBottomPositioningRef = useRef(false);
  const isUserScrollIntentRef = useRef(false);
  // 最近一次真实滚动输入（wheel/滚动条/按键/触摸）的时间戳：stick=false
  // 只允许在该输入的延续窗口内生效，见 USER_SCROLL_INTENT_WINDOW_MS。
  const lastUserScrollInputAtRef = useRef(-Infinity);
  // 最近一次真实输入的方向：-1 上行 / 1 下行 / 0 未知（触摸、滚动条拖拽）。
  const lastUserScrollInputDirectionRef = useRef(0);

  const isSmoothScrollingToBottomRef = useRef(false);

  const scrollToBottomAnimRef = useRef(0);
  const previousIsCompactingRef = useRef(isCompactingActive);
  const scrollRafIdRef = useRef(0);
  const wheelScrollbarTimerRef = useRef(0);
  const hasMessagesRef = useRef(hasMessages);
  const messagesRef = useRef(messages);
  const autoScrollEnabledRef = useRef(autoScrollEnabled);
  const isStreamingRef = useRef(isStreaming);
  // Run 收尾宽限窗口：时间戳，期间 RO 钉底视同流式输出。
  const followGraceUntilRef = useRef(0);
  // 窗口失焦/遮挡（渲染帧停摆）时处于跟随中的标记：恢复后据此追赶钉底。
  const refocusFollowArmedRef = useRef(false);
  const previousIsStreamingRef = useRef(isStreaming);
  activeConversationIdRef.current = activeConversationId;
  hasMessagesRef.current = hasMessages;
  messagesRef.current = messages;
  autoScrollEnabledRef.current = autoScrollEnabled;
  isStreamingRef.current = isStreaming;

  const syncScrollButtonVisibility = useCallback(
    (container: HTMLDivElement): void => {
      if (isSmoothScrollingToBottomRef.current) {
        setShowScrollToBottom(false);
        return;
      }
      const distanceFromBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight;
      setShowScrollToBottom(
        hasMessagesRef.current &&
          distanceFromBottom > SHOW_SCROLL_TO_BOTTOM_THRESHOLD,
      );
    },
    [],
  );

  const deriveFollowStateFromScroll = useCallback(
    (container: HTMLDivElement): void => {
      if (isSmoothScrollingToBottomRef.current) {
        shouldStickToBottomRef.current = true;
        lastScrollTopRef.current = container.scrollTop;
        lastScrollHeightRef.current = container.scrollHeight;
        lastClientHeightRef.current = container.clientHeight;
        setShowScrollToBottom(false);
        return;
      }

      const distanceFromBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight;

      if (
        isInitialBottomPositioningRef.current &&
        !isUserScrollIntentRef.current
      ) {
        shouldStickToBottomRef.current = true;
        lastScrollTopRef.current = container.scrollTop;
        lastScrollHeightRef.current = container.scrollHeight;
        lastClientHeightRef.current = container.clientHeight;
        setShowScrollToBottom(false);
        return;
      }

      const deltaScrollTop = container.scrollTop - lastScrollTopRef.current;
      const deltaScrollHeight =
        container.scrollHeight - lastScrollHeightRef.current;
      const deltaClientHeight =
        container.clientHeight - lastClientHeightRef.current;
      lastScrollTopRef.current = container.scrollTop;
      lastScrollHeightRef.current = container.scrollHeight;
      lastClientHeightRef.current = container.clientHeight;

      // 视口上方的占位/折叠/图片加载会触发浏览器滚动锚定：scrollTop 随
      // scrollHeight 同向等量回移；窗口缩放引发 clamp 时 clientHeight 变化。
      // 这些位移没有用户输入，若按「向上滚」处理会静默停掉流式自动吸底。
      const isGeometryShift =
        deltaClientHeight !== 0 ||
        (deltaScrollTop !== 0 &&
          Math.sign(deltaScrollTop) === Math.sign(deltaScrollHeight) &&
          Math.abs(deltaScrollTop - deltaScrollHeight) <= 1);

      if (!isGeometryShift) {
        if (deltaScrollTop > 0) {
          // 正位移只允许找回跟随、禁止关闭：流式期间的正 delta 几乎全部
          // 来自钉底写入，钉底与滚动事件之间的增量增长令 distance 短暂超
          // 阈值，据此重导出 false 会静默杀死跟随（总结尾部停滚的偶发
          // 根因）。用户下滚未触底时 stick 本就为 false，不受影响。
          if (distanceFromBottom < STICK_TO_BOTTOM_THRESHOLD) {
            shouldStickToBottomRef.current = true;
          }
        } else if (deltaScrollTop < 0) {
          // 负位移脱离跟随需双重背书：真实输入的延续窗口内，且最近输入
          // 为上行或方向未知（触摸/滚动条拖拽）。下行输入后的负净位移只能
          // 来自上方塌缩与下方增长的同帧交错（躲过 isGeometryShift 判定），
          // 不得误判为用户上滚而关掉跟随。
          if (
            performance.now() - lastUserScrollInputAtRef.current <=
              USER_SCROLL_INTENT_WINDOW_MS &&
            lastUserScrollInputDirectionRef.current <= 0
          ) {
            shouldStickToBottomRef.current = false;
          }
        }
      }
      setShowScrollToBottom(
        hasMessagesRef.current &&
          distanceFromBottom > SHOW_SCROLL_TO_BOTTOM_THRESHOLD,
      );
    },
    [],
  );

  useLayoutEffect(() => {
    if (previousActiveConversationIdRef.current === activeConversationId) {
      return;
    }

    previousActiveConversationIdRef.current = activeConversationId;
    scrollRestoreRequestIdRef.current += 1;
    pendingScrollRestoreRef.current = null;
    isLoadingOlderWithScrollRef.current = false;
    scrolledAuthorizationSignatureRef.current = "";
    shouldStickToBottomRef.current = true;
    isInitialBottomPositioningRef.current = false;
    isUserScrollIntentRef.current = false;
    lastUserScrollInputAtRef.current = -Infinity;
    lastUserScrollInputDirectionRef.current = 0;
    refocusFollowArmedRef.current = false;
    if (scrollToBottomAnimRef.current !== 0) {
      cancelAnimationFrame(scrollToBottomAnimRef.current);
      scrollToBottomAnimRef.current = 0;
    }
    isSmoothScrollingToBottomRef.current = false;
    setShowScrollToBottom(false);
    if (activeConversationId) {
      positionedConversationIdsRef.current.delete(activeConversationId);
    }

    const container = scrollRef.current;
    if (container) {
      // 清零几何快照：切换会话的 scrollTop 归零不得算作跨会话的滚动位移。
      lastScrollTopRef.current = 0;
      lastScrollHeightRef.current = 0;
      lastClientHeightRef.current = 0;
      container.scrollTop = 0;
    }
  }, [activeConversationId]);

  // chat-area 重挂载（灵动岛重开/紧凑展开）时容器 DOM 被整体替换：
  // 清除已定位标记，让初始定位 effect 在同轮 commit 重新滚到底部。
  useLayoutEffect(() => {
    if (!isChatAreaRendered) {
      return;
    }
    const conversationId = activeConversationIdRef.current;
    if (conversationId) {
      positionedConversationIdsRef.current.delete(conversationId);
    }
  }, [isChatAreaRendered]);

  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (
      !container ||
      !activeConversationId ||
      !isInitialHistoryLoaded ||
      isLoadingInitialHistory ||
      messages.length === 0 ||
      positionedConversationIdsRef.current.has(activeConversationId)
    ) {
      return;
    }

    let rafId1 = 0;
    let rafId2 = 0;
    let rafId3 = 0;

    const scrollToBottom = (): void => {
      container.scrollTop = container.scrollHeight;
    };

    isInitialBottomPositioningRef.current = true;
    isUserScrollIntentRef.current = false;
    shouldStickToBottomRef.current = true;
    setShowScrollToBottom(false);
    scrollToBottom();
    rafId1 = requestAnimationFrame(() => {
      scrollToBottom();
      rafId2 = requestAnimationFrame(() => {
        scrollToBottom();
        rafId3 = requestAnimationFrame(scrollToBottom);
      });
    });

    positionedConversationIdsRef.current.add(activeConversationId);

    return (): void => {
      cancelAnimationFrame(rafId1);
      cancelAnimationFrame(rafId2);
      cancelAnimationFrame(rafId3);
    };
  }, [
    activeConversationId,
    isChatAreaRendered,
    isInitialHistoryLoaded,
    isLoadingInitialHistory,
    messages.length,
  ]);

  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container || !activeConversationId) {
      return;
    }

    let resizeRafId = 0;
    let lastScrollHeight = container.scrollHeight;
    let lastClientHeight = container.clientHeight;
    const observedChildren = new Set<Element>();

    const keepAtBottomSync = (): void => {
      if (
        scrollRef.current !== container ||
        activeConversationIdRef.current !== activeConversationId
      ) {
        return;
      }

      const nextScrollHeight = container.scrollHeight;
      const nextClientHeight = container.clientHeight;
      const didGeometryChange =
        nextScrollHeight !== lastScrollHeight ||
        nextClientHeight !== lastClientHeight;
      lastScrollHeight = nextScrollHeight;
      lastClientHeight = nextClientHeight;

      if (!didGeometryChange) {
        return;
      }

      if (
        isLoadingOlderWithScrollRef.current ||
        pendingScrollRestoreRef.current !== null ||
        isSmoothScrollingToBottomRef.current
      ) {
        return;
      }

      const distanceFromBottom =
        nextScrollHeight - container.scrollTop - nextClientHeight;
      const isFollowActive =
        isStreamingRef.current ||
        performance.now() < followGraceUntilRef.current;
      // 流式或收尾宽限内贴底（≤ 阈值）时自动找回跟随：兜住任何漏判掉出
      // stick 的路径，避免「距底部一点却永不跟随、须手动触底」的死锁。
      if (
        !shouldStickToBottomRef.current &&
        distanceFromBottom <= STICK_TO_BOTTOM_THRESHOLD &&
        isFollowActive
      ) {
        shouldStickToBottomRef.current = true;
      }

      syncScrollButtonVisibility(container);

      // 钉底仅在初始定位、流式输出及 run 收尾宽限期生效；几何变化一律不改跟随状态
      if (
        shouldStickToBottomRef.current &&
        (isInitialBottomPositioningRef.current ||
          (autoScrollEnabledRef.current && isFollowActive))
      ) {
        container.scrollTop = nextScrollHeight;
        // 钉底即续期收尾宽限：定稿渲染逐帧晚到也持续被带到底部，
        // 几何静默或用户上滚（stick=false）后窗口自然失效。
        if (autoScrollEnabledRef.current && isFollowActive) {
          followGraceUntilRef.current =
            performance.now() + RUN_FINISH_FOLLOW_GRACE_MS;
        }
      }
    };

    const scheduleResizeCheck = (): void => {
      if (resizeRafId === 0) {
        resizeRafId = requestAnimationFrame(() => {
          resizeRafId = 0;
          keepAtBottomSync();
        });
      }
    };

    const resizeObserver = new ResizeObserver(keepAtBottomSync);

    resizeObserver.observe(container);
    const observeCurrentChildren = (): void => {
      for (const child of observedChildren) {
        if (!container.contains(child)) {
          resizeObserver.unobserve(child);
          observedChildren.delete(child);
        }
      }

      for (const child of Array.from(container.children)) {
        if (!observedChildren.has(child)) {
          observedChildren.add(child);
          resizeObserver.observe(child);
        }
      }
    };

    observeCurrentChildren();

    const mutationObserver = new MutationObserver(() => {
      observeCurrentChildren();
      scheduleResizeCheck();
    });
    mutationObserver.observe(container, { childList: true });
    container.addEventListener("load", scheduleResizeCheck, true);

    return (): void => {
      if (resizeRafId !== 0) {
        cancelAnimationFrame(resizeRafId);
      }
      container.removeEventListener("load", scheduleResizeCheck, true);
      mutationObserver.disconnect();
      resizeObserver.disconnect();
    };
  }, [activeConversationId, isChatAreaRendered, syncScrollButtonVisibility]);

  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container || !activeConversationId) {
      return;
    }

    const visibleAuthorizations = pendingToolAuthorizations.filter(
      (toolCall) =>
        toolCall.authorizationConversationId === activeConversationId,
    );
    if (visibleAuthorizations.length === 0) {
      scrolledAuthorizationSignatureRef.current = "";
      return;
    }

    const signature = visibleAuthorizations
      .map(
        (toolCall) =>
          toolCall.authorizationId ??
          `${toolCall.name}-${toolCall.callId ?? toolCall.arguments}`,
      )
      .join("|");
    if (signature === scrolledAuthorizationSignatureRef.current) {
      return;
    }

    scrolledAuthorizationSignatureRef.current = signature;
    requestAnimationFrame(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    });
  }, [activeConversationId, pendingToolAuthorizations]);

  // Keep the chat pinned to the latest AI output while streaming, unless the
  // user scrolls away or has disabled the preference entirely.
  useLayoutEffect(() => {
    if (
      !autoScrollEnabled ||
      !isStreaming ||
      !shouldStickToBottomRef.current ||
      !scrollRef.current
    ) {
      return;
    }

    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [autoScrollEnabled, isStreaming, messages]);

  // Run 结束瞬间（isStreaming true→false）消息集中定稿：showActions 按钮、
  // run summary 摘要条、Thinking 折叠、markdown 定稿，高度逐帧变化，而流式
  // 钉底条件此刻已失效。仍在跟随时立即钉底并开启收尾宽限窗口，由 RO 把晚到
  // 的定稿渲染继续带到底部；用户已上滚（stick=false）则不强制拉底。
  useLayoutEffect(() => {
    const wasStreaming = previousIsStreamingRef.current;
    previousIsStreamingRef.current = isStreaming;
    if (isStreaming || !wasStreaming) {
      return;
    }
    if (!shouldStickToBottomRef.current) {
      return;
    }
    followGraceUntilRef.current =
      performance.now() + RUN_FINISH_FOLLOW_GRACE_MS;
    const container = scrollRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }, [isStreaming]);

  // 失焦/被遮挡时渲染帧停摆：rAF 与 ResizeObserver 挂起，markdown 渲染
  // （rAF 门控）被推迟；run 在后台结束后，恢复可见时 deferred 渲染集中
  // 落地而收尾宽限早已过期——总结尾部就此停在视口外。恢复可见/聚焦时
  // 重新打开宽限并钉底，后续落地增长由 RO 钉底+续期持续带到可视底部。
  useEffect(() => {
    let rafId1 = 0;
    let rafId2 = 0;
    const pinToBottom = (): void => {
      const container = scrollRef.current;
      if (container) {
        container.scrollTop = container.scrollHeight;
      }
    };
    const armFollowCatchUp = (): void => {
      refocusFollowArmedRef.current =
        shouldStickToBottomRef.current &&
        (isStreamingRef.current ||
          performance.now() < followGraceUntilRef.current);
    };
    const runFollowCatchUp = (): void => {
      if (!shouldStickToBottomRef.current || !autoScrollEnabledRef.current) {
        return;
      }
      if (
        !refocusFollowArmedRef.current &&
        !isStreamingRef.current &&
        performance.now() >= followGraceUntilRef.current
      ) {
        return;
      }
      refocusFollowArmedRef.current = false;
      if (rafId1 !== 0) {
        cancelAnimationFrame(rafId1);
        rafId1 = 0;
      }
      if (rafId2 !== 0) {
        cancelAnimationFrame(rafId2);
        rafId2 = 0;
      }
      followGraceUntilRef.current =
        performance.now() + RUN_FINISH_FOLLOW_GRACE_MS;
      pinToBottom();
      rafId1 = requestAnimationFrame(() => {
        pinToBottom();
        rafId2 = requestAnimationFrame(pinToBottom);
      });
    };
    const handleVisibilityChange = (): void => {
      if (document.visibilityState === "hidden") {
        armFollowCatchUp();
      } else {
        runFollowCatchUp();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("blur", armFollowCatchUp);
    // capture：点击输入框等元素激活窗口时 focus 不冒泡到 window。
    window.addEventListener("focus", runFollowCatchUp, true);
    return (): void => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("blur", armFollowCatchUp);
      window.removeEventListener("focus", runFollowCatchUp, true);
      if (rafId1 !== 0) {
        cancelAnimationFrame(rafId1);
      }
      if (rafId2 !== 0) {
        cancelAnimationFrame(rafId2);
      }
    };
  }, []);

  // Compaction is an explicit operation, so its preview and persisted boundary
  // must remain visible regardless of the user's normal auto-scroll preference.
  useLayoutEffect(() => {
    const wasCompacting = previousIsCompactingRef.current;
    previousIsCompactingRef.current = isCompactingActive;
    if (wasCompacting === isCompactingActive) {
      return;
    }

    shouldStickToBottomRef.current = true;
    const scrollToBottom = (): void => {
      const container = scrollRef.current;
      if (container) {
        container.scrollTop = container.scrollHeight;
      }
    };

    scrollToBottom();
    requestAnimationFrame(scrollToBottom);
  }, [isCompactingActive]);

  const handleLoadOlderWithScroll = useCallback(async (): Promise<void> => {
    const container = scrollRef.current;
    const conversationId = activeConversationIdRef.current;
    if (!container || !conversationId || isLoadingOlderWithScrollRef.current) {
      return;
    }

    const requestId = ++scrollRestoreRequestIdRef.current;
    isLoadingOlderWithScrollRef.current = true;

    // 以视口内首个消息节点为翻页恢复锚点：新页插在它上方，恢复时按它
    // 在内容坐标系中的位移做增量校正。内容坐标 = anchorRect.top -
    // containerTop + scrollTop：用户滚动时 anchorRect 与 scrollTop 同步
    // 反向移动，内容坐标恒定；只有 DOM 推挤才会改变它——校正量天然剥离
    // 等待期间用户继续慢滚的位移，只补偿推挤，不回拨用户。
    let anchorElement: Element | null = null;
    let anchorContentOffset = 0;
    const containerTop = container.getBoundingClientRect().top;
    for (const el of container.querySelectorAll<HTMLElement>(
      "[data-message-id]",
    )) {
      if (el.getBoundingClientRect().bottom > containerTop) {
        anchorElement = el;
        anchorContentOffset =
          el.getBoundingClientRect().top - containerTop + container.scrollTop;
        break;
      }
    }

    pendingScrollRestoreRef.current = {
      conversationId,
      requestId,
      anchorElement,
      anchorContentOffset,
      firstMessageId: messagesRef.current[0]?.id,
      rounds: 0,
      scrollHeight: container.scrollHeight,
      scrollTop: container.scrollTop,
    };

    try {
      await loadOlderMessages();
    } finally {
      // 正常路径由下方的恢复 layout effect 在「新页 commit」的渲染周期内
      // 消费 pending（paint 前校正，视觉零扰动）。此超时仅作兜底：新页为
      // 空/加载异常导致 firstMessageId 始终未变时，清理状态防止
      // isLoadingOlderWithScrollRef 卡死翻页。requestId 不匹配说明期间
      // 发起了新一轮翻页，交由新轮回收。
      window.setTimeout(() => {
        if (scrollRestoreRequestIdRef.current === requestId) {
          pendingScrollRestoreRef.current = null;
          isLoadingOlderWithScrollRef.current = false;
        }
      }, 2000);
    }
  }, [loadOlderMessages]);

  // 翻页滚动恢复（多轮收敛）：新页 commit 后、paint 前按 anchor 的内容
  // 坐标差分校正推挤。新页消息由虚拟化 hook 的 forceVisible 机制挂载即
  // 真实渲染，但 flush 发生在新页 commit 之后的同步渲染轮次里——占位符
  // 阶段的几何令校正偏小，必须逐轮重测。每轮校正后更新基准（anchor 的
  // 内容坐标），下一轮只补「新发生的推挤」，累计精确；新页全部以真实
  // 内容渲染后几何定型，本轮校正即最终值。所有轮次都由 layout 阶段的
  // setState 同步 flush，发生在 paint 前——视口不出现任何中间帧。
  const [restoreTick, setRestoreTick] = useState(0);
  useLayoutEffect(() => {
    const pendingRestore = pendingScrollRestoreRef.current;
    const container = scrollRef.current;
    if (
      !pendingRestore ||
      !container ||
      !activeConversationId ||
      pendingRestore.conversationId !== activeConversationId ||
      messages[0]?.id === pendingRestore.firstMessageId
    ) {
      return;
    }

    const anchorEl = pendingRestore.anchorElement;
    if (anchorEl && container.contains(anchorEl)) {
      const anchorContentNow =
        anchorEl.getBoundingClientRect().top -
        container.getBoundingClientRect().top +
        container.scrollTop;
      const pushSinceLastRound =
        anchorContentNow - pendingRestore.anchorContentOffset;
      if (pushSinceLastRound !== 0) {
        container.scrollTop += pushSinceLastRound;
        pendingRestore.anchorContentOffset = anchorContentNow;
      }
    } else {
      // 兜底：锚点缺失/失效时按几何增量恢复。
      const addedHeight = container.scrollHeight - pendingRestore.scrollHeight;
      container.scrollTop = pendingRestore.scrollTop + Math.max(0, addedHeight);
    }

    // 收敛检查：新页里只要还有占位符形态的消息，说明 forceVisible 的
    // 反虚拟化渲染尚未落地，几何还会变化——bump restoreTick 排队下一轮
    // 校正；全部真实渲染后清理收尾。轮次上限防御异常时的无限循环。
    let newPageFullyRendered = true;
    for (const message of messages) {
      if (message.id === pendingRestore.firstMessageId) break;
      if (message.role === "tool") continue;
      const node = container.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(message.id)}"]`,
      );
      if (node && node.classList.contains("is-placeholder")) {
        newPageFullyRendered = false;
        break;
      }
    }
    if (!newPageFullyRendered && pendingRestore.rounds < 8) {
      pendingRestore.rounds += 1;
      setRestoreTick((tick) => tick + 1);
      return;
    }

    pendingScrollRestoreRef.current = null;
    isLoadingOlderWithScrollRef.current = false;
  }, [messages, activeConversationId, restoreTick]);

  const markUserScrollIntent = useCallback((direction: number): void => {
    isUserScrollIntentRef.current = true;
    isInitialBottomPositioningRef.current = false;
    lastUserScrollInputAtRef.current = performance.now();
    lastUserScrollInputDirectionRef.current = direction;

    if (scrollToBottomAnimRef.current !== 0) {
      cancelAnimationFrame(scrollToBottomAnimRef.current);
      scrollToBottomAnimRef.current = 0;
    }
    isSmoothScrollingToBottomRef.current = false;
  }, []);

  const handleChatPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      const container = event.currentTarget;
      if (container.scrollHeight <= container.clientHeight) {
        container.classList.remove("is-hovering-scrollbar");
        return;
      }
      const scrollbarStartX =
        container.getBoundingClientRect().left + container.clientWidth;
      container.classList.toggle(
        "is-hovering-scrollbar",
        event.clientX >= scrollbarStartX,
      );
    },
    [],
  );

  const handleChatPointerLeave = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      event.currentTarget.classList.remove("is-hovering-scrollbar");
    },
    [],
  );

  const flashChatScrollbar = useCallback((): void => {
    const container = scrollRef.current;
    if (!container) {
      return;
    }
    container.classList.add("is-wheelscrolling");
    if (wheelScrollbarTimerRef.current !== 0) {
      window.clearTimeout(wheelScrollbarTimerRef.current);
    }
    wheelScrollbarTimerRef.current = window.setTimeout(() => {
      wheelScrollbarTimerRef.current = 0;
      container.classList.remove("is-wheelscrolling");
    }, 1000);
  }, []);

  const handleChatWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>): void => {
      const container = event.currentTarget;
      const deltaY = event.deltaY;
      if (deltaY === 0) {
        return;
      }
      // 嵌套滚动容器（Thinking 块等）消费的手势不改变对话跟随状态。
      if (willNestedScrollerConsumeWheel(container, event.target, deltaY)) {
        return;
      }

      markUserScrollIntent(deltaY < 0 ? -1 : 1);
      flashChatScrollbar();

      if (deltaY < 0) {
        // 向上滚 = 阅读历史：立即脱离跟随。容器已在顶部时手势不产生滚动，
        // 不应停掉自动滚动。
        if (container.scrollTop > 0) {
          shouldStickToBottomRef.current = false;
          syncScrollButtonVisibility(container);
        }
        return;
      }

      const distanceFromBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight;
      if (distanceFromBottom <= 0) {
        shouldStickToBottomRef.current = true;
        setShowScrollToBottom(false);
      }
    },
    [flashChatScrollbar, markUserScrollIntent, syncScrollButtonVisibility],
  );

  const handleChatPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      if (event.button !== 0) {
        return;
      }
      const container = event.currentTarget;
      // 内容未溢出时滚动条区域只是一条空 gutter，点击不产生滚动，不算意图。
      if (container.scrollHeight <= container.clientHeight) {
        return;
      }

      const scrollbarStartX =
        container.getBoundingClientRect().left + container.clientWidth;
      if (event.clientX < scrollbarStartX) {
        return;
      }
      markUserScrollIntent(0);
      shouldStickToBottomRef.current = false;
    },
    [markUserScrollIntent],
  );

  const handleChatKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      if (event.target !== event.currentTarget) {
        return;
      }
      const scrollsUp =
        event.key === "ArrowUp" ||
        event.key === "PageUp" ||
        event.key === "Home" ||
        (event.key === " " && event.shiftKey);
      const scrollsDown =
        event.key === "ArrowDown" ||
        event.key === "PageDown" ||
        event.key === "End" ||
        (event.key === " " && !event.shiftKey);
      if (!scrollsUp && !scrollsDown) {
        return;
      }
      markUserScrollIntent(scrollsUp ? -1 : 1);
      if (scrollsUp && event.currentTarget.scrollTop > 0) {
        shouldStickToBottomRef.current = false;
      }
    },
    [markUserScrollIntent],
  );

  const handleChatScroll = useCallback((): void => {
    const container = scrollRef.current;
    if (!container) {
      return;
    }

    deriveFollowStateFromScroll(container);

    // 只有“加载更早消息”检查走 rAF 节流，避免快速滚动时频繁触发分页逻辑。
    if (scrollRafIdRef.current !== 0) {
      return;
    }

    scrollRafIdRef.current = requestAnimationFrame(() => {
      scrollRafIdRef.current = 0;
      const throttledContainer = scrollRef.current;
      if (!throttledContainer) {
        return;
      }

      const isFollowingInitialContent =
        isInitialBottomPositioningRef.current && !isUserScrollIntentRef.current;
      if (isFollowingInitialContent) {
        return;
      }

      if (
        throttledContainer.scrollTop > LOAD_OLDER_SCROLL_THRESHOLD ||
        !hasMoreMessages ||
        isLoadingOlderMessages ||
        isLoadingOlderWithScrollRef.current
      ) {
        return;
      }

      void handleLoadOlderWithScroll();
    });
  }, [
    deriveFollowStateFromScroll,
    handleLoadOlderWithScroll,
    hasMoreMessages,
    isLoadingOlderMessages,
  ]);

  const handleScrollToBottom = useCallback((): void => {
    const container = scrollRef.current;
    if (!container) {
      return;
    }

    // Cancel any tween already in flight before starting a new one.
    if (scrollToBottomAnimRef.current !== 0) {
      cancelAnimationFrame(scrollToBottomAnimRef.current);
      scrollToBottomAnimRef.current = 0;
    }

    shouldStickToBottomRef.current = true;
    isInitialBottomPositioningRef.current = false;
    isUserScrollIntentRef.current = false;
    lastUserScrollInputAtRef.current = -Infinity;
    lastUserScrollInputDirectionRef.current = 0;
    isSmoothScrollingToBottomRef.current = true;
    setShowScrollToBottom(false);

    const startTop = container.scrollTop;
    const startTimeMs = performance.now();
    const durationMs = 350;
    let lastTop = startTop;

    const tick = (nowMs: number): void => {
      if (scrollRef.current !== container) {
        scrollToBottomAnimRef.current = 0;
        isSmoothScrollingToBottomRef.current = false;
        return;
      }

      const maxScrollTop = container.scrollHeight - container.clientHeight;

      if (
        isUserScrollIntentRef.current &&
        Math.abs(container.scrollTop - lastTop) > 2
      ) {
        scrollToBottomAnimRef.current = 0;
        isSmoothScrollingToBottomRef.current = false;
        deriveFollowStateFromScroll(container);
        return;
      }

      const elapsed = nowMs - startTimeMs;
      const progress = Math.min(1, elapsed / durationMs);
      // easeOutCubic — decelerates to the target, feels native.
      const eased = 1 - Math.pow(1 - progress, 3);
      const currentTarget = startTop + (maxScrollTop - startTop) * eased;
      const nextTop = Math.min(currentTarget, maxScrollTop);
      container.scrollTop = nextTop;
      lastTop = nextTop;

      if (progress >= 1 || nextTop >= maxScrollTop - 1) {
        container.scrollTop = maxScrollTop;
        scrollToBottomAnimRef.current = 0;
        isSmoothScrollingToBottomRef.current = false;
        deriveFollowStateFromScroll(container);
        return;
      }

      scrollToBottomAnimRef.current = requestAnimationFrame(tick);
    };

    scrollToBottomAnimRef.current = requestAnimationFrame(tick);
  }, [deriveFollowStateFromScroll]);

  const handleSendWithScroll = useCallback(
    (message: string, options: ChatInputSendOptions) => {
      handleSendMessage(message, options);
      shouldStickToBottomRef.current = true;
      isInitialBottomPositioningRef.current = false;
      isUserScrollIntentRef.current = false;
      lastUserScrollInputAtRef.current = -Infinity;
      lastUserScrollInputDirectionRef.current = 0;
      setShowScrollToBottom(false);
      requestAnimationFrame(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
      });
    },
    [handleSendMessage],
  );

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

  // Cancel any pending scroll-throttle and scroll-to-bottom animation frames
  // on unmount.
  useEffect(() => {
    return () => {
      if (scrollRafIdRef.current !== 0) {
        cancelAnimationFrame(scrollRafIdRef.current);
        scrollRafIdRef.current = 0;
      }
      if (scrollToBottomAnimRef.current !== 0) {
        cancelAnimationFrame(scrollToBottomAnimRef.current);
        scrollToBottomAnimRef.current = 0;
      }
      if (wheelScrollbarTimerRef.current !== 0) {
        window.clearTimeout(wheelScrollbarTimerRef.current);
        wheelScrollbarTimerRef.current = 0;
      }
    };
  }, []);

  // 视图重建 key 用 sessionViewKey（而非 activeConversationId）：pending 会话
  // 首轮结束迁移为真实 ID 时它保持不变，chat-area / ChatInput 不重建——
  // 否则首次工具组挂载的同一瞬间整页闪烁、输入框失焦。
  const chatRenderKey = `${activeDirectory?.directoryId ?? "no-project"}:${sessionViewKey}:${newChatGeneration}`;

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
              <div className="chat-initial-history-skeleton" aria-hidden="true">
                {Array.from({ length: 3 }, (_, index) => (
                  <div
                    className={`chat-message-skeleton ${
                      index === 1 ? "is-user" : "is-assistant"
                    }`}
                    key={index}
                  >
                    <div className="chat-message-skeleton-line is-primary" />
                    <div className="chat-message-skeleton-line is-secondary" />
                    {index === 0 ? (
                      <div className="chat-message-skeleton-line is-tertiary" />
                    ) : null}
                  </div>
                ))}
              </div>
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
              loadOlderMessages={loadOlderMessages}
              isLoadingOlderMessages={isLoadingOlderMessages}
              hasMoreMessages={hasMoreMessages}
              conversationVersion={conversationVersion}
              shouldStickToBottomRef={shouldStickToBottomRef}
              isInitialBottomPositioningRef={isInitialBottomPositioningRef}
              isUserScrollIntentRef={isUserScrollIntentRef}
            />
          ) : null}

          <div className="chat-input-region">
            {showScrollToBottom && hasMessages ? (
              <button
                className={`chat-scroll-to-bottom${
                  isStreaming ? " is-streaming" : ""
                }`}
                type="button"
                onClick={handleScrollToBottom}
                aria-label={t("chat.scrollToBottom")}
                title={t("chat.scrollToBottom")}
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
