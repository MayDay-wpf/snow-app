import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ChatInputSendOptions } from "../../chatInput/types";
import { useChatConversationContext } from "../components/ChatConversationContext";
import {
  createStreamGrowthSmoother,
  type StreamGrowthSmoother,
} from "../components/streamGrowthSmoother";
import { registerMessageWindowViewGate } from "../utils/messageWindow";

type PendingScrollRestore = {
  conversationId: string;
  requestId: number;

  firstMessageId: string | undefined;
  /** 恢复收敛轮次计数（防御性上限）。 */
  rounds: number;
};

type ScrollAnchorLock = {
  container: HTMLDivElement;
  anchorElement: Element | null;
  anchorContentOffset: number;
  scrollHeight: number;
  scrollTop: number;
  expectedScrollTop: number;
  anchorLost: boolean;
};

const LOAD_OLDER_SCROLL_THRESHOLD = 96;
const SHOW_SCROLL_TO_BOTTOM_THRESHOLD = 160;
const STICK_TO_BOTTOM_THRESHOLD = 16;

const USER_SCROLL_INTENT_WINDOW_MS = 750;
// Run 结束（isStreaming true→false）后消息集中定稿重渲染：动作按钮出现、
// run summary 摘要条插入、Thinking 折叠、markdown 定稿，高度逐帧变化。
// 在此窗口内保持钉底资格，把最终总结带到可视底部。
const RUN_FINISH_FOLLOW_GRACE_MS = 1200;

const SCROLL_ANCHOR_OFF_CLASS = "is-scroll-anchor-off";
const SCROLL_RESTORE_WATCHDOG_STABLE_FRAMES = 12;
const SCROLL_RESTORE_WATCHDOG_MAX_FRAMES = 90;

const measureAnchorContentOffset = (
  container: HTMLDivElement,
  anchor: Element,
): number =>
  anchor.getBoundingClientRect().top -
  container.getBoundingClientRect().top +
  container.scrollTop;

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

export type ChatScrollFollowOptions = {
  /** 视图重建 key（.chat-area 的 React key 派生值）：容器整体重建时滚动状态复位。 */
  chatRenderKey: string;
  /** chat-area 是否实际挂载：灵动岛态下不渲染，展开时 DOM 节点整体重建。 */
  isChatAreaRendered: boolean;
  /** 当前会话是否正在压缩（压缩是显式操作，预览与边界强制保持可见）。 */
  isCompactingActive: boolean;
  /** 自动滚动偏好：关闭时不钉底，但首屏初始定位不受影响。 */
  autoScrollEnabled: boolean;
  /**
   * 是否注册消息窗口裁剪门控（模块级单例）。主聊天表面为 true（缺省）；
   * 会话面板传 false，避免把裁剪依据切到面板的会话上。
   */
  registerViewGate?: boolean;
};

export type ChatScrollFollowResult = {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** 消息区平滑增长视口的回调 ref（交给 ChatMessageList 挂到视口元素上）。 */
  streamViewportRef: (node: HTMLDivElement | null) => void;
  showScrollToBottom: boolean;
  markUserScrollIntent: (direction: number) => void;
  handleChatWheel: (event: React.WheelEvent<HTMLDivElement>) => void;
  handleChatPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  handleChatPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
  handleChatPointerLeave: (event: React.PointerEvent<HTMLDivElement>) => void;
  handleChatKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  handleChatScroll: () => void;
  handleScrollToBottom: (options?: { animate?: boolean }) => void;
  handleLoadOlderWithScroll: (pageSize?: number) => Promise<void>;
  handleSendWithScroll: (
    message: string,
    options: ChatInputSendOptions,
  ) => void;
  shouldStickToBottomRef: React.RefObject<boolean>;
  isInitialBottomPositioningRef: React.RefObject<boolean>;
  isUserScrollIntentRef: React.RefObject<boolean>;
};

/**
 * 聊天区滚动跟随控制器：滚动状态机（钉底资格推导、几何位移辨识）、即时钉底
 * （内容增长同帧内贴底，不留滞后）、消息区平滑增长（streamGrowthSmoother：
 * 内容增长先在裁剪视口内平滑过渡，再由同帧钉底带动视口平滑上移）、翻页
 * 滚动恢复（多轮收敛）、ResizeObserver 钉底、事件 handlers 与滚动到底部
 * 按钮补间。从 ChatContent 抽出，依赖的会话状态直接取自
 * ChatConversationContext；外部仅传入视图层状态（渲染 key、挂载态、
 * 压缩态、自动滚动偏好）。
 */
export const useChatScrollFollow = ({
  chatRenderKey,
  isChatAreaRendered,
  isCompactingActive,
  autoScrollEnabled,
  registerViewGate = true,
}: ChatScrollFollowOptions): ChatScrollFollowResult => {
  const {
    messages,
    activeConversationId,
    isStreaming,
    hasMoreMessages,
    isLoadingOlderMessages,
    isInitialHistoryLoaded,
    isLoadingInitialHistory,
    loadOlderMessages,
    pendingToolAuthorizations,
    handleSendMessage,
  } = useChatConversationContext();

  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const hasMessages = messages.length > 0;

  const scrollRef = useRef<HTMLDivElement>(null);
  const activeConversationIdRef = useRef(activeConversationId);
  const previousActiveConversationIdRef = useRef(activeConversationId);
  const previousChatRenderKeyRef = useRef(chatRenderKey);
  const positionedConversationIdsRef = useRef(new Set<string>());
  const pendingScrollRestoreRef = useRef<PendingScrollRestore | null>(null);
  const scrollAnchorLockRef = useRef<ScrollAnchorLock | null>(null);
  const scrollRestoreRequestIdRef = useRef(0);
  const isLoadingOlderWithScrollRef = useRef(false);
  // 一轮翻页滚动恢复的在途信号：等不到新页/被新一轮接管时也必须唤醒等待方。
  const scrollRestoreInflightRef = useRef<Promise<void> | null>(null);
  const scrollRestoreSettleRef = useRef<(() => void) | null>(null);
  const scrollRestoreWatchdogRafRef = useRef(0);
  const scrollRestoreWatchdogFramesRef = useRef(0);
  const scrollRestoreStableFramesRef = useRef(0);
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
  // 自动续页：上一轮基线高度 + 连续未长高轮次。
  const autoFillStartHeightRef = useRef(0);
  const autoFillStallRef = useRef(0);
  const hasMessagesRef = useRef(hasMessages);
  const hasMoreMessagesRef = useRef(hasMoreMessages);
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
  hasMoreMessagesRef.current = hasMoreMessages;
  messagesRef.current = messages;
  autoScrollEnabledRef.current = autoScrollEnabled;
  isStreamingRef.current = isStreaming;
  const isChatAreaRenderedRef = useRef(isChatAreaRendered);
  isChatAreaRenderedRef.current = isChatAreaRendered;

  // 消息窗口裁剪门控：仅在自动滚动钉底时允许卸载当前会话的头部历史，
  // 用户上翻阅读、翻页恢复或首屏定位期间一律暂停。
  useEffect(() => {
    // 消息窗口裁剪门控是模块级单例：只有主聊天表面注册它。会话面板（同一窗口
    // 内的第二个聊天表面）不注册，避免把裁剪依据切到面板的会话上。
    if (!registerViewGate) {
      return;
    }
    return registerMessageWindowViewGate({
      sessionKey: () =>
        isChatAreaRenderedRef.current
          ? activeConversationIdRef.current
          : undefined,
      isFollowingBottom: () =>
        autoScrollEnabledRef.current &&
        shouldStickToBottomRef.current &&
        !isLoadingOlderWithScrollRef.current &&
        pendingScrollRestoreRef.current === null &&
        !isInitialBottomPositioningRef.current,
    });
  }, [registerViewGate]);

  // 跟随路径统一入口：即时把滚动位置贴到容器底部。写入发生在内容生长的
  // 同一帧内（ResizeObserver 回调在 paint 前触发），视口不会滞后于内容。
  const pinToBottom = useCallback((): void => {
    if (isSmoothScrollingToBottomRef.current) {
      return;
    }
    if (
      isLoadingOlderWithScrollRef.current ||
      pendingScrollRestoreRef.current !== null
    ) {
      return;
    }
    const container = scrollRef.current;
    if (!container) {
      return;
    }
    const distanceFromBottom =
      container.scrollHeight - container.clientHeight - container.scrollTop;
    if (Math.abs(distanceFromBottom) > 1) {
      container.scrollTop = container.scrollHeight;
    }
    lastScrollTopRef.current = container.scrollTop;
    lastScrollHeightRef.current = container.scrollHeight;
    lastClientHeightRef.current = container.clientHeight;
  }, []);

  // 消息区平滑增长的放行条件：只在「正在跟随最新输出」时平滑——用户已
  // 离开底部、自动滚动关闭、翻页恢复 / 底部补间 / 首屏定位进行中，都要求
  // 内容高度即时生效（这些路径按真实几何计算 scrollTop）。
  const canSmoothGrowth = useCallback(
    (): boolean =>
      autoScrollEnabledRef.current &&
      shouldStickToBottomRef.current &&
      !isSmoothScrollingToBottomRef.current &&
      !isInitialBottomPositioningRef.current &&
      !isLoadingOlderWithScrollRef.current &&
      pendingScrollRestoreRef.current === null &&
      (isStreamingRef.current ||
        performance.now() < followGraceUntilRef.current),
    [],
  );

  const [streamViewport, setStreamViewport] = useState<HTMLDivElement | null>(
    null,
  );
  const streamViewportRef = useCallback((node: HTMLDivElement | null): void => {
    setStreamViewport(node);
  }, []);
  const growthSmootherRef = useRef<StreamGrowthSmoother | null>(null);

  useLayoutEffect(() => {
    const track = streamViewport?.firstElementChild;
    if (!streamViewport || !(track instanceof HTMLElement)) {
      return;
    }
    const smoother = createStreamGrowthSmoother(
      streamViewport,
      track,
      canSmoothGrowth,
    );
    growthSmootherRef.current = smoother;
    return (): void => {
      smoother.dispose();
      if (growthSmootherRef.current === smoother) {
        growthSmootherRef.current = null;
      }
    };
  }, [streamViewport, canSmoothGrowth]);

  // 消息窗口头部被卸载：平滑视口仍持有旧的显式高度，内容整体上移后才
  // 逐帧收缩，表现为跳一下。绘制前释放显式高度并同帧钉底。
  const previousWindowRef = useRef({
    conversationId: activeConversationId,
    messages,
  });
  useLayoutEffect(() => {
    const previous = previousWindowRef.current;
    previousWindowRef.current = {
      conversationId: activeConversationId,
      messages,
    };
    if (
      previous.conversationId !== activeConversationId ||
      previous.messages.length === 0 ||
      messages.length === 0 ||
      previous.messages[0].id === messages[0].id
    ) {
      return;
    }
    const headId = messages[0].id;
    // 新首条落在旧列表中部才是头部裁剪（翻页前插、id 迁移都不满足）。
    if (previous.messages.findIndex((message) => message.id === headId) <= 0) {
      return;
    }
    if (!shouldStickToBottomRef.current) {
      return;
    }
    growthSmootherRef.current?.release();
    pinToBottom();
  }, [activeConversationId, messages, pinToBottom]);

  // 结束一轮翻页滚动恢复：释放在途标记并唤醒等待该轮收敛的调用方（用户消息
  // 定位需要按页推进），避免等待一个永不抵达的信号。
  const finishScrollRestore = useCallback((): void => {
    isLoadingOlderWithScrollRef.current = false;
    const settle = scrollRestoreSettleRef.current;
    scrollRestoreSettleRef.current = null;
    scrollRestoreInflightRef.current = null;
    if (settle) {
      settle();
    }
  }, []);

  const applyAnchorCorrection = useCallback((): boolean => {
    const lock = scrollAnchorLockRef.current;
    if (!lock) {
      return false;
    }
    const { container } = lock;
    if (scrollRef.current !== container) {
      scrollAnchorLockRef.current = null;
      return false;
    }

    const anchorEl = lock.anchorElement;
    if (!anchorEl || !container.contains(anchorEl)) {
      if (lock.anchorLost) {
        return false;
      }
      lock.anchorLost = true;
      const addedHeight = container.scrollHeight - lock.scrollHeight;
      container.scrollTop = lock.scrollTop + Math.max(0, addedHeight);
      lock.expectedScrollTop = container.scrollTop;
      return true;
    }

    const anchorContentNow = measureAnchorContentOffset(container, anchorEl);
    const pushSinceLastRound = anchorContentNow - lock.anchorContentOffset;
    if (pushSinceLastRound === 0) {
      return false;
    }

    const externalShift = container.scrollTop - lock.expectedScrollTop;
    const isAlreadyCompensated =
      externalShift !== 0 &&
      Math.sign(externalShift) === Math.sign(pushSinceLastRound) &&
      Math.abs(externalShift - pushSinceLastRound) <= 1;
    const correction = isAlreadyCompensated ? 0 : pushSinceLastRound;

    lock.anchorContentOffset = anchorContentNow;
    if (correction !== 0) {
      container.scrollTop += correction;
    }
    lock.expectedScrollTop = container.scrollTop;
    return true;
  }, []);

  const stopScrollRestoreWatchdog = useCallback((): void => {
    if (scrollRestoreWatchdogRafRef.current !== 0) {
      cancelAnimationFrame(scrollRestoreWatchdogRafRef.current);
      scrollRestoreWatchdogRafRef.current = 0;
    }
    scrollRestoreWatchdogFramesRef.current = 0;
    scrollRestoreStableFramesRef.current = 0;
    scrollAnchorLockRef.current?.container.classList.remove(
      SCROLL_ANCHOR_OFF_CLASS,
    );
    scrollAnchorLockRef.current = null;
  }, []);

  const startScrollRestoreWatchdog = useCallback((): void => {
    const container =
      scrollAnchorLockRef.current?.container ?? scrollRef.current;
    if (!container) {
      return;
    }
    container.classList.add(SCROLL_ANCHOR_OFF_CLASS);
    scrollRestoreWatchdogFramesRef.current = 0;
    scrollRestoreStableFramesRef.current = 0;
    if (scrollRestoreWatchdogRafRef.current !== 0) {
      return;
    }

    const tick = (): void => {
      scrollRestoreWatchdogRafRef.current = 0;
      scrollRestoreWatchdogFramesRef.current += 1;
      const didCorrect = applyAnchorCorrection();
      if (scrollAnchorLockRef.current === null) {
        stopScrollRestoreWatchdog();
        return;
      }

      const isRestoreInflight =
        pendingScrollRestoreRef.current !== null ||
        isLoadingOlderWithScrollRef.current;
      scrollRestoreStableFramesRef.current =
        didCorrect || isRestoreInflight
          ? 0
          : scrollRestoreStableFramesRef.current + 1;

      const isSettled =
        !isRestoreInflight &&
        scrollRestoreStableFramesRef.current >=
          SCROLL_RESTORE_WATCHDOG_STABLE_FRAMES;
      if (
        isSettled ||
        scrollRestoreWatchdogFramesRef.current >=
          SCROLL_RESTORE_WATCHDOG_MAX_FRAMES
      ) {
        stopScrollRestoreWatchdog();
        return;
      }

      scrollRestoreWatchdogRafRef.current = requestAnimationFrame(tick);
    };

    scrollRestoreWatchdogRafRef.current = requestAnimationFrame(tick);
  }, [applyAnchorCorrection, stopScrollRestoreWatchdog]);

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
        // 程序化滚动（底部补间）产生的 scroll 事件不是用户位移：只刷新几何
        // 快照，不改 stick——补间每帧自查它，外部改写（如消息定位跳转置
        // false）能立即生效，不会被打回 true。
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
    // 会话切换与容器重建（切换项目）都算视图更换：后者 activeConversationId
    // 不变，但 chat-area 的 DOM 被整体替换，滚动状态必须一并复位。
    const isConversationChange =
      previousActiveConversationIdRef.current !== activeConversationId;
    const isContainerRebuild =
      previousChatRenderKeyRef.current !== chatRenderKey;
    if (!isConversationChange && !isContainerRebuild) {
      return;
    }

    previousActiveConversationIdRef.current = activeConversationId;
    previousChatRenderKeyRef.current = chatRenderKey;
    scrollRestoreRequestIdRef.current += 1;
    pendingScrollRestoreRef.current = null;
    finishScrollRestore();
    stopScrollRestoreWatchdog();
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
    growthSmootherRef.current?.release();
    setShowScrollToBottom(false);
    if (activeConversationId) {
      positionedConversationIdsRef.current.delete(activeConversationId);
    }

    autoFillStartHeightRef.current = 0;
    autoFillStallRef.current = 0;

    const container = scrollRef.current;
    if (container) {
      // 清零几何快照：切换会话的 scrollTop 归零不得算作跨会话的滚动位移。
      lastScrollTopRef.current = 0;
      lastScrollHeightRef.current = 0;
      lastClientHeightRef.current = 0;
      container.scrollTop = 0;
    }
  }, [
    activeConversationId,
    chatRenderKey,
    finishScrollRestore,
    stopScrollRestoreWatchdog,
  ]);

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
      // 首屏的延后校正仅用于内容初次落地；用户开始阅读后不能再抢视口。
      if (
        scrollRef.current !== container ||
        !isInitialBottomPositioningRef.current ||
        isUserScrollIntentRef.current
      ) {
        return;
      }
      container.scrollTop = container.scrollHeight;
    };

    isInitialBottomPositioningRef.current = true;
    isUserScrollIntentRef.current = false;
    shouldStickToBottomRef.current = true;
    setShowScrollToBottom(false);
    if (autoScrollEnabledRef.current) {
      followGraceUntilRef.current =
        performance.now() + RUN_FINISH_FOLLOW_GRACE_MS;
    }
    scrollToBottom();
    rafId1 = requestAnimationFrame(() => {
      scrollToBottom();
      rafId2 = requestAnimationFrame(() => {
        scrollToBottom();
        rafId3 = requestAnimationFrame(() => {
          scrollToBottom();
          isInitialBottomPositioningRef.current = false;
        });
      });
    });

    positionedConversationIdsRef.current.add(activeConversationId);

    return (): void => {
      cancelAnimationFrame(rafId1);
      cancelAnimationFrame(rafId2);
      cancelAnimationFrame(rafId3);
      if (scrollRef.current === container) {
        isInitialBottomPositioningRef.current = false;
      }
    };
  }, [
    activeConversationId,
    chatRenderKey,
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
        !isUserScrollIntentRef.current &&
        distanceFromBottom <= STICK_TO_BOTTOM_THRESHOLD &&
        isFollowActive
      ) {
        shouldStickToBottomRef.current = true;
      }

      // Follow first, then derive visibility from the final geometry: otherwise
      // each streamed height change briefly mounts the button before pinToBottom
      // hides it again, restarting its entrance animation every frame.
      if (
        shouldStickToBottomRef.current &&
        (isInitialBottomPositioningRef.current ||
          (autoScrollEnabledRef.current && isFollowActive))
      ) {
        if (autoScrollEnabledRef.current && isFollowActive) {
          followGraceUntilRef.current =
            performance.now() + RUN_FINISH_FOLLOW_GRACE_MS;
        }
        pinToBottom();
      }
      syncScrollButtonVisibility(container);
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
    // 只处理本批 DOM 变动涉及的节点：旧实现每次变动都遍历容器的全部子元素
    // （会话切换/翻页时可达数百个），在切换帧与流式帧上都是纯粹的额外开销。
    const observeChildNodes = (nodes: NodeList): void => {
      for (const node of Array.from(nodes)) {
        if (!(node instanceof Element) || observedChildren.has(node)) {
          continue;
        }
        if (!container.contains(node)) {
          continue;
        }
        observedChildren.add(node);
        resizeObserver.observe(node);
      }
    };
    const unobserveChildNodes = (nodes: NodeList): void => {
      for (const node of Array.from(nodes)) {
        if (!(node instanceof Element) || !observedChildren.has(node)) {
          continue;
        }
        observedChildren.delete(node);
        resizeObserver.unobserve(node);
      }
    };

    observeChildNodes(container.childNodes);

    const mutationObserver = new MutationObserver((records) => {
      for (const record of records) {
        if (record.removedNodes.length > 0) {
          unobserveChildNodes(record.removedNodes);
        }
        if (record.addedNodes.length > 0) {
          observeChildNodes(record.addedNodes);
        }
      }
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
  }, [
    activeConversationId,
    chatRenderKey,
    isChatAreaRendered,
    pinToBottom,
    syncScrollButtonVisibility,
  ]);

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
      pinToBottom();
    });
  }, [activeConversationId, pendingToolAuthorizations, pinToBottom]);

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

    pinToBottom();
  }, [autoScrollEnabled, isStreaming, messages, chatRenderKey, pinToBottom]);

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
    pinToBottom();
  }, [isStreaming, pinToBottom]);

  // 失焦/被遮挡时渲染帧停摆：rAF 与 ResizeObserver 挂起，markdown 渲染
  // （rAF 门控）被推迟；run 在后台结束后，恢复可见时 deferred 渲染集中
  // 落地而收尾宽限早已过期——总结尾部就此停在视口外。恢复可见/聚焦时
  // 重新打开宽限并钉底，后续落地增长由 RO 钉底+续期持续带到可视底部。
  useEffect(() => {
    let rafId1 = 0;
    let rafId2 = 0;
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
  }, [pinToBottom]);

  // Compaction is an explicit operation, so its preview and persisted boundary
  // must remain visible regardless of the user's normal auto-scroll preference.
  useLayoutEffect(() => {
    const wasCompacting = previousIsCompactingRef.current;
    previousIsCompactingRef.current = isCompactingActive;
    if (wasCompacting === isCompactingActive) {
      return;
    }

    shouldStickToBottomRef.current = true;
    stopScrollRestoreWatchdog();
    const scrollToBottom = (): void => {
      const container = scrollRef.current;
      if (container) {
        container.scrollTop = container.scrollHeight;
      }
    };

    scrollToBottom();
    requestAnimationFrame(scrollToBottom);
  }, [isCompactingActive, stopScrollRestoreWatchdog]);

  const handleLoadOlderWithScroll = useCallback(
    async (pageSize?: number): Promise<void> => {
      const container = scrollRef.current;
      const conversationId = activeConversationIdRef.current;
      if (!container || !conversationId) {
        return;
      }

      // 已有翻页在途：等待它收敛后返回。定位用户消息需要按页推进，直接返回
      // 会让调用方误以为这一页已经到位。
      const inflightRestore = scrollRestoreInflightRef.current;
      if (inflightRestore) {
        await inflightRestore;
        return;
      }

      // 没有更早的记录时 loadOlderMessages 直接返回，建立恢复等待只会让调用
      // 方白等一轮兜底超时。
      if (!hasMoreMessagesRef.current) {
        return;
      }

      const requestId = ++scrollRestoreRequestIdRef.current;
      isLoadingOlderWithScrollRef.current = true;
      // 翻页恢复按真实几何校正 scrollTop：平滑视口的显式高度会让新页插入
      // 后的 scrollHeight 偏小、校正被钳制，必须先即时释放。
      growthSmootherRef.current?.release();

      let anchorElement: Element | null = null;
      let anchorContentOffset = 0;
      const containerTop = container.getBoundingClientRect().top;
      for (const el of container.querySelectorAll<HTMLElement>(
        "[data-message-id]",
      )) {
        if (el.getBoundingClientRect().bottom > containerTop) {
          anchorElement = el;
          anchorContentOffset = measureAnchorContentOffset(container, el);
          break;
        }
      }

      let resolveRestore: () => void = () => {};
      const restoreFinished = new Promise<void>((resolve) => {
        resolveRestore = resolve;
      });
      scrollRestoreSettleRef.current = resolveRestore;
      scrollRestoreInflightRef.current = restoreFinished;

      scrollAnchorLockRef.current = {
        container,
        anchorElement,
        anchorContentOffset,
        scrollHeight: container.scrollHeight,
        scrollTop: container.scrollTop,
        expectedScrollTop: container.scrollTop,
        anchorLost: false,
      };

      pendingScrollRestoreRef.current = {
        conversationId,
        requestId,
        firstMessageId: messagesRef.current[0]?.id,
        rounds: 0,
      };

      startScrollRestoreWatchdog();

      try {
        await loadOlderMessages(
          typeof pageSize === "number" ? pageSize : undefined,
        );
      } finally {
        // 正常路径由下方的恢复 layout effect 在「新页 commit」的渲染周期内
        // 消费 pending（paint 前校正，视觉零扰动）。此超时仅作兜底：新页为
        // 空/加载异常导致 firstMessageId 始终未变时，清理状态防止
        // isLoadingOlderWithScrollRef 卡死翻页。requestId 不匹配说明期间
        // 发起了新一轮翻页，交由新轮回收，本轮只唤醒等待方。
        window.setTimeout(() => {
          if (scrollRestoreRequestIdRef.current === requestId) {
            pendingScrollRestoreRef.current = null;
            finishScrollRestore();
            return;
          }
          resolveRestore();
        }, 2000);
      }

      // 收敛后才返回：等待方（用户消息定位）据此保证「视口内容零跳动地翻完
      // 这一页」再决定下一步。
      await restoreFinished;
    },
    [finishScrollRestore, loadOlderMessages, startScrollRestoreWatchdog],
  );

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

    applyAnchorCorrection();

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
    finishScrollRestore();
  }, [
    messages,
    activeConversationId,
    restoreTick,
    finishScrollRestore,
    applyAnchorCorrection,
  ]);

  // 内容不足一屏时容器不可滚动，scroll 事件永不触发，唯一的分页入口
  // （handleChatScroll 的顶部阈值）就此死锁：首屏只取 CHAT_MESSAGE_PAGE_SIZE
  // 条 DB 记录，其中 role=tool 记录会被折叠进上一条 assistant，渲染高度可能
  // 远不满一屏。这里在每页落地后复检，仍不足一屏且还有更早记录就继续续页，
  // 直到出现滚动条或没有更多；连续两轮没让内容长高则停止，避免把整段历史
  // 全部拉进内存。
  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (
      !container ||
      !activeConversationId ||
      !isChatAreaRendered ||
      !isInitialHistoryLoaded ||
      isLoadingInitialHistory ||
      isLoadingOlderMessages ||
      isStreaming ||
      !hasMoreMessages ||
      messages.length === 0 ||
      pendingScrollRestoreRef.current !== null ||
      isLoadingOlderWithScrollRef.current
    ) {
      return;
    }
    if (container.scrollHeight > container.clientHeight + 1) {
      return;
    }

    const baselineHeight = autoFillStartHeightRef.current;
    autoFillStartHeightRef.current = container.scrollHeight;
    if (baselineHeight > 0 && container.scrollHeight <= baselineHeight + 1) {
      autoFillStallRef.current += 1;
      if (autoFillStallRef.current > 1) {
        return;
      }
    } else {
      autoFillStallRef.current = 0;
    }

    void handleLoadOlderWithScroll();
  }, [
    activeConversationId,
    chatRenderKey,
    hasMoreMessages,
    isChatAreaRendered,
    isInitialHistoryLoaded,
    isLoadingInitialHistory,
    isLoadingOlderMessages,
    isStreaming,
    messages.length,
    restoreTick,
    handleLoadOlderWithScroll,
  ]);

  const markUserScrollIntent = useCallback((direction: number): void => {
    isUserScrollIntentRef.current = true;
    isInitialBottomPositioningRef.current = false;
    lastUserScrollInputAtRef.current = performance.now();
    lastUserScrollInputDirectionRef.current = direction;
    // A touch drag or scroll-to-top shortcut has no wheel delta. Relinquish
    // follow immediately instead of letting the next streamed resize reclaim it.
    if (direction <= 0 && (scrollRef.current?.scrollTop ?? 0) > 0) {
      shouldStickToBottomRef.current = false;
      // 脱离跟随：平滑视口立即交还自然高度，滞后段在视口下方展开。
      growthSmootherRef.current?.release();
    }

    // 用户真实输入立即接管视口：停止在途的底部补间，
    // 避免下一帧写入把视口从用户正在查看的位置拽走。
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
        } else if (
          hasMoreMessages &&
          !isLoadingOlderMessages &&
          container.scrollHeight <= container.clientHeight + 1
        ) {
          // 内容不足一屏：容器没有可滚动区间，滚轮不产生 scroll 事件，
          // 常规的「滚到顶部加载更早记录」通道失效，这里按手势显式续页。
          void handleLoadOlderWithScroll();
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
    [
      flashChatScrollbar,
      handleLoadOlderWithScroll,
      hasMoreMessages,
      isLoadingOlderMessages,
      markUserScrollIntent,
      syncScrollButtonVisibility,
    ],
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

  const handleScrollToBottom = useCallback(
    (options?: { animate?: boolean }): void => {
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
      setShowScrollToBottom(false);
      // 手动吸底后的虚拟节点仍可能在下一帧展开；短暂保留跟随资格，
      // 但不改变关闭自动滚动时的偏好。
      if (autoScrollEnabledRef.current) {
        followGraceUntilRef.current =
          performance.now() + RUN_FINISH_FOLLOW_GRACE_MS;
      }

      // 补间按真实几何追赶底部：先交还平滑视口的自然高度。
      growthSmootherRef.current?.release();

      const initialMaxScrollTop =
        container.scrollHeight - container.clientHeight;
      const initialDistance = initialMaxScrollTop - container.scrollTop;
      const tweenMaxDistance = Math.min(container.clientHeight * 0.75, 480);
      // Reduced motion always jumps. Non-click callers keep the rule that only
      // a short, settled distance tweens, so long/virtualized timelines never
      // animate through placeholder expansion.
      if (
        window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
        (!options?.animate && initialDistance > tweenMaxDistance)
      ) {
        container.scrollTop = container.scrollHeight;
        deriveFollowStateFromScroll(container);
        return;
      }

      isSmoothScrollingToBottomRef.current = true;
      // Click on a long timeline: jump to the last tween window first, so the
      // animated part only covers rendered content near the bottom.
      if (initialDistance > tweenMaxDistance) {
        container.scrollTop = initialMaxScrollTop - tweenMaxDistance;
      }
      const startTop = container.scrollTop;
      const startTimeMs = performance.now();
      const durationMs = 200;
      let lastTop = startTop;

      const finishTween = (): void => {
        scrollToBottomAnimRef.current = 0;
        isSmoothScrollingToBottomRef.current = false;
        pinToBottom();
        deriveFollowStateFromScroll(container);
      };

      // 目标是「实时底部」：流式输出期间内容仍在增长，每帧按最新的
      // maxScrollTop 计算插值终点，补间结束时恰好贴底，随后交给常规跟随。
      const tick = (nowMs: number): void => {
        if (scrollRef.current !== container) {
          scrollToBottomAnimRef.current = 0;
          isSmoothScrollingToBottomRef.current = false;
          return;
        }

        if (
          isUserScrollIntentRef.current &&
          Math.abs(container.scrollTop - lastTop) > 2
        ) {
          scrollToBottomAnimRef.current = 0;
          isSmoothScrollingToBottomRef.current = false;
          deriveFollowStateFromScroll(container);
          return;
        }

        const maxScrollTop = container.scrollHeight - container.clientHeight;
        const progress = Math.min(1, (nowMs - startTimeMs) / durationMs);
        const eased = 1 - Math.pow(1 - progress, 3);
        const nextTop = Math.min(
          Math.max(lastTop, startTop + (maxScrollTop - startTop) * eased),
          maxScrollTop,
        );
        container.scrollTop = nextTop;
        lastTop = container.scrollTop;

        if (progress >= 1) {
          finishTween();
          return;
        }

        scrollToBottomAnimRef.current = requestAnimationFrame(tick);
      };

      scrollToBottomAnimRef.current = requestAnimationFrame(tick);
    },
    [deriveFollowStateFromScroll, pinToBottom],
  );

  const handleSendWithScroll = useCallback(
    (message: string, options: ChatInputSendOptions) => {
      handleSendMessage(message, options);
      shouldStickToBottomRef.current = true;
      isInitialBottomPositioningRef.current = false;
      isUserScrollIntentRef.current = false;
      lastUserScrollInputAtRef.current = -Infinity;
      lastUserScrollInputDirectionRef.current = 0;
      setShowScrollToBottom(false);
      // 发送即进入跟随：提前开启跟随窗口并武装平滑视口，新消息的出现
      // 本身就走平滑增长，而不是先瞬移一截再开始平滑。
      if (autoScrollEnabledRef.current) {
        followGraceUntilRef.current =
          performance.now() + RUN_FINISH_FOLLOW_GRACE_MS;
        growthSmootherRef.current?.arm();
      }
      requestAnimationFrame(() => {
        pinToBottom();
      });
    },
    [handleSendMessage, pinToBottom],
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
      stopScrollRestoreWatchdog();
    };
  }, [stopScrollRestoreWatchdog]);

  return {
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
  };
};
