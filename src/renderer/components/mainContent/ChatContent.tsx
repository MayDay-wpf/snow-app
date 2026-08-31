import {
  AlertCircle,
  ArrowDown,
  ArrowLeft,
  Bot,
  CheckCircle2,
  MessageSquareQuote,
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
  onNavigateToView?: (view: MainContentView) => void;
};

type PendingScrollRestore = {
  conversationId: string;
  requestId: number;
  /** 加载前视口顶部的消息包装元素（虚拟化 wrapper 常驻挂载，key 稳定）。
   *  恢复按元素视口位置对齐，不依赖 scrollHeight 差值——新加载消息在
   *  测量前以估算占位符参与布局，差值会严重低估导致恢复错位与空白。 */
  anchor: HTMLElement;
  anchorViewportTop: number;
};

const LOAD_OLDER_SCROLL_THRESHOLD = 96;
const SHOW_SCROLL_TO_BOTTOM_THRESHOLD = 160;
const STICK_TO_BOTTOM_THRESHOLD = 48;

const USER_SCROLL_DIRECTION_WINDOW_MS = 300;

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
  onNavigateToView,
}: ChatContentProps): React.JSX.Element => {
  const {
    messages,
    activeConversationId,
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

  const hasHistoryContent = hasMessages;

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
  const lastUserScrollDirectionRef = useRef(0);
  const lastUserScrollAtRef = useRef(0);
  const lastScrollTopRef = useRef(0);
  const isInitialBottomPositioningRef = useRef(false);
  const isUserScrollIntentRef = useRef(false);

  const isSmoothScrollingToBottomRef = useRef(false);

  const scrollToBottomAnimRef = useRef(0);
  const previousIsCompactingRef = useRef(isCompactingActive);
  const scrollRafIdRef = useRef(0);
  const wheelScrollbarTimerRef = useRef(0);
  const hasMessagesRef = useRef(hasMessages);
  const autoScrollEnabledRef = useRef(autoScrollEnabled);
  const isStreamingRef = useRef(isStreaming);
  activeConversationIdRef.current = activeConversationId;
  hasMessagesRef.current = hasMessages;
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
        setShowScrollToBottom(false);
        return;
      }

      const userInputRecent =
        performance.now() - lastUserScrollAtRef.current <
        USER_SCROLL_DIRECTION_WINDOW_MS;

      if (userInputRecent && lastUserScrollDirectionRef.current === 0) {
        const deltaScrollTop = container.scrollTop - lastScrollTopRef.current;
        if (deltaScrollTop < 0) {
          lastUserScrollDirectionRef.current = -1;
        } else if (deltaScrollTop > 0) {
          lastUserScrollDirectionRef.current = 1;
        }
      }
      lastScrollTopRef.current = container.scrollTop;

      if (userInputRecent && lastUserScrollDirectionRef.current === -1) {
        shouldStickToBottomRef.current = false;
      } else if (distanceFromBottom < STICK_TO_BOTTOM_THRESHOLD) {
        shouldStickToBottomRef.current = true;
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
    lastUserScrollDirectionRef.current = 0;
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
      container.scrollTop = 0;
    }
  }, [activeConversationId]);

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
    lastUserScrollDirectionRef.current = 0;
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
      if (
        !shouldStickToBottomRef.current &&
        distanceFromBottom <= 0 &&
        isStreamingRef.current
      ) {
        shouldStickToBottomRef.current = true;
      }

      syncScrollButtonVisibility(container);

      if (
        shouldStickToBottomRef.current &&
        (isInitialBottomPositioningRef.current || autoScrollEnabledRef.current)
      ) {
        container.scrollTop = nextScrollHeight;
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
  }, [activeConversationId, syncScrollButtonVisibility]);

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
    // 锚定视口顶部的消息包装元素（虚拟化 wrapper 常驻挂载，恢复时必然
    // 仍可定位），恢复时按元素视口位置对齐。
    const containerRect = container.getBoundingClientRect();
    let anchor: HTMLElement | null = null;
    let anchorViewportTop = 0;
    for (const wrapper of container.querySelectorAll<HTMLElement>(
      "[data-message-id]",
    )) {
      const rect = wrapper.getBoundingClientRect();
      if (rect.bottom > containerRect.top) {
        anchor = wrapper;
        anchorViewportTop = rect.top - containerRect.top;
        break;
      }
    }
    if (!anchor) {
      anchor = container.firstElementChild as HTMLElement | null;
    }
    if (anchor) {
      pendingScrollRestoreRef.current = {
        conversationId,
        requestId,
        anchor,
        anchorViewportTop,
      };
    }

    try {
      await loadOlderMessages();
    } finally {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const pendingRestore = pendingScrollRestoreRef.current;
          if (
            pendingRestore &&
            pendingRestore.requestId === requestId &&
            pendingRestore.conversationId === activeConversationIdRef.current &&
            scrollRef.current === container &&
            pendingRestore.anchor.isConnected
          ) {
            const newTop =
              pendingRestore.anchor.getBoundingClientRect().top -
              container.getBoundingClientRect().top;
            container.scrollTop += newTop - pendingRestore.anchorViewportTop;
          }

          if (scrollRestoreRequestIdRef.current === requestId) {
            pendingScrollRestoreRef.current = null;
            isLoadingOlderWithScrollRef.current = false;
          }
        });
      });
    }
  }, [loadOlderMessages]);

  const markUserScrollIntent = useCallback((): void => {
    isUserScrollIntentRef.current = true;
    lastUserScrollDirectionRef.current = 0;
    lastUserScrollAtRef.current = performance.now();
    isInitialBottomPositioningRef.current = false;

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

      markUserScrollIntent();
      flashChatScrollbar();

      if (deltaY < 0) {
        lastUserScrollDirectionRef.current = -1;
        // 向上滚 = 阅读历史：立即脱离跟随。容器已在顶部时手势不产生滚动，
        // 不应停掉自动滚动。
        if (container.scrollTop > 0) {
          shouldStickToBottomRef.current = false;
          syncScrollButtonVisibility(container);
        }
        return;
      }

      lastUserScrollDirectionRef.current = 1;
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
      markUserScrollIntent();
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
      markUserScrollIntent();
      if (scrollsUp) {
        lastUserScrollDirectionRef.current = -1;
        if (event.currentTarget.scrollTop > 0) {
          shouldStickToBottomRef.current = false;
        }
      } else {
        lastUserScrollDirectionRef.current = 1;
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
    lastUserScrollDirectionRef.current = 0;

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
      lastUserScrollDirectionRef.current = 0;
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
    async (mode: RollbackMode): Promise<void> => {
      // 返回真实 Promise：RollbackConfirmDialog 的确认按钮据此在整个
      // 回滚期间（含 SSH 文件恢复）保持 loading，完成后再关闭弹窗。
      await confirmRollback(mode);
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

  const chatRenderKey = `${activeDirectory?.directoryId ?? "no-project"}:${
    activeConversationId ?? "new-chat"
  }:${newChatGeneration}`;

  return (
    <div
      className={`chat-content ${
        hasHistoryContent ? "has-messages" : "is-empty"
      }`}
    >
      <div
        key={chatRenderKey}
        className={`chat-area ${
          isLoadingInitialHistory ? "is-loading-history" : ""
        }`}
        ref={scrollRef}
        onClick={pathClickOpenProps.onClick}
        onAuxClick={pathClickOpenProps.onAuxClick}
        onWheel={handleChatWheel}
        onTouchStart={markUserScrollIntent}
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
                  subAgentParentMeta?.summary || subAgentParentMeta?.title || ""
                }
                parentConversationId={subAgentParentConversationId}
                onBackToParent={handleSelectConversation}
              />
            ) : null}
            {isLoadingOlderMessages ? (
              <div className="chat-history-skeleton" aria-hidden="true">
                <div className="chat-history-skeleton-line" />
                <div className="chat-history-skeleton-line" />
                <div className="chat-history-skeleton-line" />
              </div>
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
            onAutoSendOverrideConsumed={() => setPendingAutoSendOverride(null)}
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
}: {
  status: string;
  parentConversationId: string;
  onBackToParent: (conversationId: string) => Promise<void> | void;
}): React.JSX.Element => {
  const { t } = useI18n();

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
          "chat.subAgentFinished.failed",
          "This sub-agent failed. The conversation is read-only.",
        ]
      : status === "cancelled"
        ? [
            "chat.subAgentFinished.cancelled",
            "This sub-agent was cancelled. The conversation is read-only.",
          ]
        : [
            "chat.subAgentFinished.completed",
            "This sub-agent has finished. The conversation is read-only.",
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
          {t("chat.subAgentFinished.backToParent", {
            defaultValue: "Back to parent conversation",
          })}
        </button>
      ) : null}
    </div>
  );
};

export const ChatContent = ({
  activeDirectory,
  onNavigateToView,
}: ChatContentProps): React.JSX.Element => {
  return (
    <ChatContentBody
      activeDirectory={activeDirectory}
      onNavigateToView={onNavigateToView}
    />
  );
};
