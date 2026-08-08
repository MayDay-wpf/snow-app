import {
  AlertCircle,
  ArrowDown,
  ArrowLeft,
  Bot,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
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
import { directoryIdToPath } from "./chatMessages/utils/conversationHelpers";

type ChatContentProps = {
  activeDirectory?: WorkspaceDirectoryRecord | null;
  onNavigateToView?: (view: MainContentView) => void;
};

type PendingScrollRestore = {
  conversationId: string;
  requestId: number;
  scrollHeight: number;
  scrollTop: number;
};

const LOAD_OLDER_SCROLL_THRESHOLD = 96;
const SHOW_SCROLL_TO_BOTTOM_THRESHOLD = 160;
// 视口距底部小于该值视为“在底部”：scroll 事件把跟随状态重新吸附为 true，
// 之后的内容增长会继续钉底。给用户回到底部留出少量容错，避免必须像素级触底。
const STICK_TO_BOTTOM_THRESHOLD = 48;

/**
 * 判断一次滚轮手势是否会被聊天区内部的嵌套滚动容器（Thinking 块、子代理
 * 活动列表等）消费。只有滚动聊天区本身的滚轮才允许改变跟随状态，否则在
 * 嵌套容器里翻阅内容会误停整个对话的自动滚动。嵌套容器滚到边界后手势会
 * 冒泡给外层，此时视为容器滚动。
 */
const willNestedScrollerConsumeWheel = (
  container: HTMLElement,
  target: EventTarget | null,
  deltaY: number
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
    clearDraftToRestore,
    saveInputDraft,
    getInputDraft,
    clearInputDraft,
    rollbackPreview,
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
    planMode,
    isUpdatingPlanMode,
    setPlanMode,
    refreshPlanMode,
    goalMode,
    isUpdatingGoalMode,
    setGoalMode,
    refreshGoalMode,
    goalModeTokenBudget,
    setGoalModeTokenBudget,
    pendingToolAuthorizations,
    conversationVersion,
    subAgentSessionEvents,
    handleSelectConversation,
  } = useChatConversationContext();
  const { t } = useI18n();
  const { autoScrollEnabled, setAutoScrollEnabled } = useAutoScrollPreference();
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const hasMessages = messages.length > 0;
  const hasHistoryContent = hasMessages || isLoadingInitialHistory;
  // Compaction state is global, but the preview/error UI must only appear in
  // the conversation that is actually compacting — otherwise it bleeds into
  // other conversations after a switch.
  const isCompactionForActiveConversation =
    activeConversationId != null &&
    activeConversationId === compactingConversationId;
  const isCompactingActive = isCompacting && isCompactionForActiveConversation;
  const activeCompactionError = isCompactionForActiveConversation
    ? compactionError
    : null;

  // Sub-agent run state of the active conversation. The persisted record
  // (fetched on switch) covers conversations opened after their run ended
  // (e.g. after an app restart); the live session event takes precedence
  // while a run is in flight or has just finished in this app session.
  const [activeConversationMeta, setActiveConversationMeta] = useState<{
    conversationType: string;
    subAgentStatus: string;
    parentConversationId: string;
    title: string;
    subAgentName: string;
    subAgentId: string;
  } | null>(null);

  useEffect(() => {
    if (!activeConversationId) {
      setActiveConversationMeta(null);
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
    liveSubAgentEvent?.status ??
    activeConversationMeta?.subAgentStatus ??
    "";
  // Once its run ends the sub-agent conversation becomes read-only: the
  // input box disappears and only a status notice remains. While the run is
  // live the input stays visible so the user can insert pending messages.
  // Only the three terminal statuses count — any other value (including
  // unknown statuses) keeps the input visible instead of locking the
  // conversation aggressively.
  const isSubAgentFinished =
    isSubAgentConversation &&
    ["completed", "failed", "cancelled"].includes(subAgentRunStatus);
  const subAgentParentConversationId =
    activeConversationMeta?.parentConversationId ||
    liveSubAgentEvent?.parentConversationId ||
    "";

  // 子代理关联的主会话信息（标题/摘要），用于信息头的“由主会话启动”展示。
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

  // Sub-agent header display data. The live session event wins while the run
  // is in flight; the persisted record covers reopened conversations. The
  // session title is the prompt truncated to 80 chars (set at activation), so
  // it reads as the "stage" the sub-agent was spawned for; the full prompt is
  // the first user message of this conversation.
  const subAgentName =
    liveSubAgentEvent?.agentName ?? activeConversationMeta?.subAgentName ?? "";
  const subAgentSessionTitle = activeConversationMeta?.title ?? "";
  const subAgentPrompt =
    messages.find((message) => message.role === "user")?.content ?? "";

  const scrollRef = useRef<HTMLDivElement>(null);
  // 覆盖整个中间输出区：文件变更统计、消息正文、Thinking、工具调用和压缩输出。
  const pathClickOpenProps = usePathClickOpen(
    directoryIdToPath(conversationDirectoryId) ?? activeDirectory?.path
  );
  const activeConversationIdRef = useRef(activeConversationId);
  const previousActiveConversationIdRef = useRef(activeConversationId);
  const positionedConversationIdsRef = useRef(new Set<string>());
  const pendingScrollRestoreRef = useRef<PendingScrollRestore | null>(null);
  const scrollRestoreRequestIdRef = useRef(0);
  const isLoadingOlderWithScrollRef = useRef(false);
  const scrolledAuthorizationSignatureRef = useRef("");
  const shouldStickToBottomRef = useRef(true);
  const isInitialBottomPositioningRef = useRef(false);
  const isUserScrollIntentRef = useRef(false);
  // True while the scroll-to-bottom button's smooth animation is running:
  // the scroll handler must not re-derive the follow state from the still-far
  // distance during the animation, or a streaming conversation stops tracking
  // new content right after the animation lands on its stale target.
  const isSmoothScrollingToBottomRef = useRef(false);
  // Animation-frame id of the custom scroll-to-bottom tween. Unlike the native
  // smooth scroll, this re-derives the target every frame so streaming content
  // that grows mid-animation is always reached, and the ResizeObserver's
  // synchronous pin is suppressed while the tween is active to avoid the
  // instant jump that used to interrupt the animation.
  const scrollToBottomAnimRef = useRef(0);
  const previousIsCompactingRef = useRef(isCompactingActive);
  const scrollRafIdRef = useRef(0);
  const hasMessagesRef = useRef(hasMessages);
  const autoScrollEnabledRef = useRef(autoScrollEnabled);
  const isStreamingRef = useRef(isStreaming);
  activeConversationIdRef.current = activeConversationId;
  hasMessagesRef.current = hasMessages;
  autoScrollEnabledRef.current = autoScrollEnabled;
  isStreamingRef.current = isStreaming;

  // 纯几何同步“回到底部”按钮显隐，绝不触碰跟随状态。内容增长、窗口缩放等
  // 非用户滚动场景只允许走这里——跟随状态只能被用户输入或显式动作改变。
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
          distanceFromBottom > SHOW_SCROLL_TO_BOTTOM_THRESHOLD
      );
    },
    []
  );

  // scroll 事件路径（用户滚动与程序化钉底都会触发）：从视口位置推导跟随
  // 状态。钉底落点距底部为 0，只会把跟随重新确认为 true，不会误停。
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

      shouldStickToBottomRef.current =
        distanceFromBottom < STICK_TO_BOTTOM_THRESHOLD;
      setShowScrollToBottom(
        hasMessagesRef.current &&
          distanceFromBottom > SHOW_SCROLL_TO_BOTTOM_THRESHOLD
      );
    },
    []
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

    // content-visibility: auto on .chat-message-group causes scrollHeight to
    // be based on contain-intrinsic-size estimates (80px per message) until
    // the browser lazily renders off-screen messages. These immediate passes
    // handle the first paints; the ResizeObserver below keeps following later
    // height changes from Markdown workers, tool views, and image decoding.
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

    // Keep the viewport pinned to the latest content synchronously, within
    // the same frame and before paint. The ResizeObserver notification step
    // runs before requestAnimationFrame and before paint, so adjusting
    // scrollTop here ensures grown streaming content is never painted at a
    // stale scroll position — which was the source of the jitter when this
    // work was deferred to requestAnimationFrame.
    //
    // 关键不变量：内容几何变化绝不修改跟随状态。跟随状态只会被用户输入
    // （滚轮/滚动条/键盘/触摸）或显式动作（发送、回到底部按钮、压缩）改变。
    // 否则一次突发增长（图片解码、Markdown 重排、虚拟化展开）把距离推过
    // 阈值，就会在用户毫无操作的情况下悄悄停掉自动滚动。
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

      // Skip while older messages are being prepended — the pending scroll
      // restore will re-position the viewport and the follow-up scroll event
      // re-evaluates the state. Also skip while the scroll-to-bottom tween is
      // running: it re-derives its own target each frame, so a synchronous jump
      // here would fight the animation and cause the half-scroll / jitter.
      if (
        isLoadingOlderWithScrollRef.current ||
        pendingScrollRestoreRef.current !== null ||
        isSmoothScrollingToBottomRef.current
      ) {
        return;
      }

      // 窗口变高或内容收缩后视口可能物理上贴在底部：会话进行中时重新吸附，
      // 让后续增长继续跟随（"回到底部后继续自动滚动"的几何等价形态）。会话
      // 结束后不再重新吸附——用户阅读历史时视口恰好贴底，不应被记为"要跟随"。
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

      // 钉底在两种情况下生效：流式输出期间内容增长持续把视口钉在底部；
      // 以及切换会话后的初始定位阶段（isInitialBottomPositioningRef）。
      // 历史消息是异步渲染的（Markdown worker、代码高亮、图片解码、
      // content-visibility 估算高度修正等），初始定位只在同步 + 几帧 rAF
      // 里滚动过，几何高度在此之后仍会继续增长，若此时不继续钉底，
      // 非流式会话的视口就会停在中间。用户一旦滚动（markUserScrollIntent
      // 会清掉该标志）就不再拉回视口，用户停在哪儿就是哪儿。初始定位
      // 不受自动滚动偏好约束——与初始滚动本身不看偏好保持一致；偏好只
      // 约束流式期间的持续跟随。发送消息等显式动作（handleSendWithScroll）
      // 不受影响，仍会主动滚到底部。
      if (
        shouldStickToBottomRef.current &&
        (isInitialBottomPositioningRef.current ||
          (autoScrollEnabledRef.current && isStreamingRef.current))
      ) {
        container.scrollTop = nextScrollHeight;
      }
    };

    // Coalesce bulk DOM mutations (child list changes, image loads) into a
    // single check per animation frame. These events can fire in bursts and a
    // one-frame delay is acceptable here, unlike the per-frame streaming
    // growth handled synchronously by the ResizeObserver above.
    const scheduleResizeCheck = (): void => {
      if (resizeRafId === 0) {
        resizeRafId = requestAnimationFrame(() => {
          resizeRafId = 0;
          keepAtBottomSync();
        });
      }
    };

    const resizeObserver = new ResizeObserver(keepAtBottomSync);
    // 观察容器自身：窗口/面板缩放只改变 clientHeight，不改变子元素高度，
    // 不观察容器就收不到这类几何变化，钉底与按钮显隐会在缩放后失真。
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

  // When tool authorization prompts appear, force-scroll the chat area to
  // the bottom so users do not miss the confirmation while reading earlier
  // messages and leave the agent loop blocked without noticing.
  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container || !activeConversationId) {
      return;
    }

    const visibleAuthorizations = pendingToolAuthorizations.filter(
      (toolCall) =>
        toolCall.authorizationConversationId === activeConversationId
    );
    if (visibleAuthorizations.length === 0) {
      scrolledAuthorizationSignatureRef.current = "";
      return;
    }

    const signature = visibleAuthorizations
      .map(
        (toolCall) =>
          toolCall.authorizationId ??
          `${toolCall.name}-${toolCall.callId ?? toolCall.arguments}`
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
    pendingScrollRestoreRef.current = {
      conversationId,
      requestId,
      scrollHeight: container.scrollHeight,
      scrollTop: container.scrollTop,
    };

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
            scrollRef.current === container
          ) {
            const addedHeight =
              container.scrollHeight - pendingRestore.scrollHeight;
            container.scrollTop =
              pendingRestore.scrollTop + Math.max(0, addedHeight);
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
    isInitialBottomPositioningRef.current = false;
    // A user-initiated scroll cancels the button's smooth animation outright:
    // leaving the tween running would keep dragging the viewport down against
    // the user's gesture for the frames until its deviation check trips.
    if (scrollToBottomAnimRef.current !== 0) {
      cancelAnimationFrame(scrollToBottomAnimRef.current);
      scrollToBottomAnimRef.current = 0;
    }
    isSmoothScrollingToBottomRef.current = false;
  }, []);

  // 滚轮是唯一带方向信息的滚动输入，在这里同步决定跟随状态，而不是等 scroll
  // 事件：渲染帧里 ResizeObserver 的钉底先于 scroll 事件执行，若等事件再
  // 推导，流式增长会先一步把视口钉回底部，用户向上的滚动会被“吃掉”。
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

      if (deltaY < 0) {
        // 向上滚 = 阅读历史：立即脱离跟随。容器已在顶部时手势不产生滚动，
        // 不应停掉自动滚动。
        if (container.scrollTop > 0) {
          shouldStickToBottomRef.current = false;
          syncScrollButtonVisibility(container);
        }
        return;
      }

      // 向下滚：若已在吸附阈值内（手势可能不产生 scroll 事件），立即恢复
      // 跟随；其余情况由随后的 scroll 事件在接近底部时恢复。
      const distanceFromBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight;
      if (distanceFromBottom < STICK_TO_BOTTOM_THRESHOLD) {
        shouldStickToBottomRef.current = true;
        setShowScrollToBottom(false);
      }
    },
    [markUserScrollIntent, syncScrollButtonVisibility]
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
      // 垂直滚动条位于 clientWidth 与外边缘之间（clientWidth 不含滚动条），
      // 该检测与滚动条实际宽度无关。按住滚动条 = 接管滚动：立即脱离跟随，
      // 避免拖拽经过吸附阈值时与流式钉底打架；拖回底部由 scroll 事件恢复。
      const scrollbarStartX =
        container.getBoundingClientRect().left + container.clientWidth;
      if (event.clientX < scrollbarStartX) {
        return;
      }
      markUserScrollIntent();
      shouldStickToBottomRef.current = false;
    },
    [markUserScrollIntent]
  );

  const handleChatKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      // 只有容器自身聚焦时按键才会滚动它；子元素（按钮等）冒泡上来的按键
      // 不算滚动意图。
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
      if (scrollsUp && event.currentTarget.scrollTop > 0) {
        shouldStickToBottomRef.current = false;
      }
    },
    [markUserScrollIntent]
  );

  const handleChatScroll = useCallback((): void => {
    const container = scrollRef.current;
    if (!container) {
      return;
    }

    // 跟随状态同步推导（几次几何读取，开销极小）：必须赶在渲染帧的
    // ResizeObserver 钉底之前反映用户的滚动位置，否则节流间隙里流式钉底
    // 会把视口拽回底部。
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
    // Protect the follow state while the tween runs: during the animation the
    // distance is still large, so without this the scroll handler would flip
    // the stick flag back to false and a streaming conversation would stop
    // tracking new content right after the animation lands on a stale target.
    isSmoothScrollingToBottomRef.current = true;
    setShowScrollToBottom(false);

    // Capture the starting scrollTop once so the easing curve is stable. The
    // *target* (maxScrollTop) is re-read every frame so content that streams
    // in mid-animation is always reached — the native smooth scroll computed
    // its target once at call time and would stop short when the target moved.
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

      const maxScrollTop =
        container.scrollHeight - container.clientHeight;

      // The user took over the wheel / keyboard and moved away from the
      // tween's last position: stop the animation and let the live geometry
      // drive the follow state, respecting the user's intent. (Safety net:
      // the input handlers cancel this tween synchronously, but the message
      // rail jump sets the intent ref directly and is caught by this check.)
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
      const currentTarget =
        startTop + (maxScrollTop - startTop) * eased;
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
      setShowScrollToBottom(false);
      requestAnimationFrame(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
      });
    },
    [handleSendMessage]
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
    [setAutoScrollEnabled, handleScrollToBottom]
  );

  const handleConfirmRollback = useCallback(
    (mode: RollbackMode): void => {
      void confirmRollback(mode);
    },
    [confirmRollback]
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
    };
  }, []);

  return (
    <div
      className={`chat-content ${
        hasHistoryContent ? "has-messages" : "is-empty"
      }`}
    >
      <div
        key={activeConversationId ?? "new-chat"}
        className={`chat-area ${
          isLoadingInitialHistory ? "is-loading-history" : ""
        }`}
        ref={scrollRef}
        onClick={pathClickOpenProps.onClick}
        onAuxClick={pathClickOpenProps.onAuxClick}
        onWheel={handleChatWheel}
        onTouchStart={markUserScrollIntent}
        onPointerDown={handleChatPointerDown}
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
                  subAgentParentMeta?.title || subAgentParentMeta?.summary || ""
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
        {isLoadingInitialHistory ? null : isSubAgentFinished ? (
          <SubAgentFinishedNotice
            status={subAgentRunStatus}
            parentConversationId={subAgentParentConversationId}
            onBackToParent={handleSelectConversation}
          />
        ) : (
          <ChatInput
            projectId={activeDirectory?.directoryId}
            projectName={activeDirectory?.name}
            conversationId={activeConversationId}
            onSend={handleSendWithScroll}
            isStreaming={isStreaming}
            isAborting={isAborting}
            onAbort={handleAbort}
            tokenUsage={tokenUsage}
            draftToRestore={draftToRestore}
            autoSendToken={autoSendToken}
            onDraftRestored={clearDraftToRestore}
            saveInputDraft={saveInputDraft}
            getInputDraft={getInputDraft}
            clearInputDraft={clearInputDraft}
            pendingMessages={pendingMessages}
            onWithdrawPendingMessage={withdrawPendingMessage}
            onSendPendingMessageNow={sendPendingMessageNow}
            onCompactConversation={compactConversation}
            yoloMode={yoloMode}
            isUpdatingYoloMode={isUpdatingYoloMode}
            onYoloModeChange={setYoloMode}
            onRefreshYoloMode={refreshYoloMode}
            planMode={planMode}
            isUpdatingPlanMode={isUpdatingPlanMode}
            onPlanModeChange={setPlanMode}
            onRefreshPlanMode={refreshPlanMode}
            goalMode={goalMode}
            isUpdatingGoalMode={isUpdatingGoalMode}
            onGoalModeChange={setGoalMode}
            onRefreshGoalMode={refreshGoalMode}
            goalModeTokenBudget={goalModeTokenBudget}
            onGoalModeTokenBudgetChange={setGoalModeTokenBudget}
            autoScrollEnabled={autoScrollEnabled}
            onAutoScrollChange={handleAutoScrollChange}
            isCompacting={isCompactingActive}
          />
        )}
      </div>

      {rollbackPreview ? (
        <RollbackConfirmDialog
          changes={rollbackPreview.changes}
          checkpointId={rollbackPreview.checkpointId}
          workDir={rollbackPreview.workDir}
          isFirstMessage={rollbackPreview.isFirstMessage}
          todoItems={rollbackPreview.todoItems}
          onConfirm={handleConfirmRollback}
          onCancel={cancelRollback}
        />
      ) : null}
    </div>
  );
};

/**
 * Info header shown at the top of a sub-agent conversation's message list.
 * It surfaces what the read-only run was about: the sub-agent's display name
 * (agent id), the session title (the prompt truncated at activation, i.e. the
 * "stage" it was spawned for), the parent conversation that launched it (with
 * a shortcut back), and the full prompt that was delegated.
 */
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

  // The session title is the prompt truncated to 80 chars at activation; if
  // it is missing (e.g. the record has not loaded yet), fall back to a fresh
  // truncation of the prompt, then to the agent name.
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

/**
 * Read-only footer shown in place of the input box once a sub-agent
 * conversation's run has ended (completed, failed or cancelled). Offers a
 * shortcut back to the parent conversation where the dialogue continues.
 */
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
