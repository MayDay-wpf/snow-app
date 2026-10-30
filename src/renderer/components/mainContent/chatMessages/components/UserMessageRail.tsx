import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { MessageSquare, Search, X } from "lucide-react";
import { useI18n } from "../../../../i18n";
import type { UserMessageSummary } from "../../../../../preload";
import { ContentChips } from "../../chatInput/ContentChips";
import {
  parseContentSegments,
  summarizeContentAsPlainText,
  type ContentSegment,
} from "../../chatInput/fileTagUtils";
import { ChatHistorySkeleton } from "./ChatHistorySkeleton";

type RefValue<T> = { current: T };

type UserMessageRailProps = {
  conversationId: string | undefined;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  /** 滚动容器身份 key（.chat-area 的 React key）：容器整体重建后必须重绑监听。 */
  containerKey: string;
  /** Triggers paginated loading of older messages. Called repeatedly until the
   *  target message enters the DOM. The loader preserves the viewport anchor
   *  (content must not shift while pages are prepended) and resolves only after
   *  that restore has converged, so the next round never races the correction. */
  loadOlderMessages: (pageSize?: number) => Promise<void>;
  /** Whether older messages are currently being fetched. */
  isLoadingOlderMessages: boolean;
  /** Whether more historical messages remain unloaded. */
  hasMoreMessages: boolean;
  /** Monotonically increasing version counter that bumps on every message
   *  operation (send, receive, rollback, compaction, page-load). Used as the
   *  sole dependency for re-fetching the user-message list so the rail always
   *  reflects the true DB state. */
  conversationVersion: number;
  /** Ref to the chat-area's shouldStickToBottom flag. The rail sets this to
   *  false before loading older messages so the ResizeObserver / scroll-pin
   *  logic does not yank the viewport back to the bottom while we are trying
   *  to navigate to an earlier message. */
  shouldStickToBottomRef: RefValue<boolean>;
  /** Ref mirroring ChatContent's isInitialBottomPositioningRef. The rail
   *  resets this to false so deriveFollowStateFromScroll stops forcing
   *  shouldStickToBottom=true during the initial-bottom-positioning phase. */
  isInitialBottomPositioningRef: RefValue<boolean>;
  /** Ref mirroring ChatContent's isUserScrollIntentRef. The rail sets this to
   *  true to mark a user-initiated navigation, so the scroll-follow logic
   *  respects our programmatic scroll instead of pinning to the bottom. */
  isUserScrollIntentRef: RefValue<boolean>;
};

/** Find the DOM element for a given message id. The VirtualizedMessage
 *  wrapper carries data-message-id on a permanently-mounted node, so this
 *  works even when the message is virtualized out to a placeholder. */
const findMessageElement = (
  container: HTMLElement,
  messageId: string,
): HTMLElement | null => {
  return container.querySelector<HTMLElement>(
    `[data-message-id="${CSS.escape(messageId)}"]`,
  );
};

/** Wait for the next animation frame. */
const nextFrame = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()));

/** 可视高亮计算的最小间隔：滚动期间每帧构建 DOM 索引并读取几何没有必要，
 *  尾部定时器保证滚动停止后的最后一次计算仍会执行。 */
const VISIBILITY_COMPUTE_INTERVAL_MS = 120;

/** 同会话内版本号成串变化时合并重拉（长会话单次拉取可达上百毫秒）。 */
const USER_MESSAGES_REFETCH_DELAY_MS = 200;

/** 定位翻页页长：逐轮翻倍，目标越远轮次越少；上限防一次挂载过多消息。 */
const LOCATE_PAGE_SIZE_MIN = 20;
const LOCATE_PAGE_SIZE_MAX = 160;
const LOCATE_MAX_LOAD_ROUNDS = 400;
/** 落位判定：连续若干帧位置与 scrollHeight 不变即视为稳定。 */
const LOCATE_STABLE_FRAMES = 5;
const LOCATE_SETTLE_MAX_FRAMES = 90;

const CHIP_TAG_MARKERS = [
  "@@file-selection:",
  "@@file:",
  "@@dir:",
  "@@image:",
  "@@commit:",
  "@@change:",
  "@@text-snippet:",
  "@@review:",
  "@@element:",
  "@@web:",
  "@@conversation:",
  "@@command:",
  "@@annotation:",
  "@@skill:",
  "@@workflow:",
];

type RailItemData = {
  id: string;
  isContextCompaction: boolean;
  summary: string;
  /** 含 chip 标签时的解析结果，否则为 null（走纯文本摘要）。 */
  segments: ContentSegment[] | null;
  /** 搜索归一化文本：摘要 + chip 标签的可读字段，已转小写。 */
  searchText: string;
};

/** 把 chip 分段里的可读字符串拼进搜索文本（文件路径、网页标题、引用摘要等）。 */
const segmentSearchText = (segment: ContentSegment): string => {
  if (segment.type === "text") {
    return segment.content;
  }
  return Object.values(segment.tag as Record<string, unknown>)
    .filter((value): value is string => typeof value === "string")
    .join(" ");
};

type RailItemCacheEntry = {
  content: string;
  isContextCompaction: boolean;
  data: RailItemData;
};

const deriveRailItem = (msg: UserMessageSummary): RailItemData => {
  const isContextCompaction = Boolean(msg.isContextCompaction);
  const hasChips =
    !isContextCompaction &&
    CHIP_TAG_MARKERS.some((marker) => msg.content.includes(marker));
  const summary = summarizeContentAsPlainText(msg.content);
  const segments = hasChips ? parseContentSegments(msg.content) : null;
  const searchText = [
    summary,
    ...(segments?.map(segmentSearchText) ?? []),
  ]
    .join(" ")
    .toLowerCase();
  return {
    id: msg.id,
    isContextCompaction,
    summary,
    segments,
    searchText,
  };
};

/** 视口内（目标附近）是否还有虚拟化占位符：从目标向两侧扫，越出视口即停，
 *  只读取少量节点的几何。 */
const hasPlaceholderInViewport = (
  container: HTMLElement,
  target: HTMLElement,
  viewportTop: number,
  viewportBottom: number,
): boolean => {
  const nodes = Array.from(
    container.querySelectorAll<HTMLElement>("[data-message-id]"),
  );
  const start = nodes.indexOf(target);
  if (start < 0) {
    return false;
  }
  for (let i = start + 1; i < nodes.length; i++) {
    const rect = nodes[i].getBoundingClientRect();
    if (rect.top >= viewportBottom) break;
    if (
      rect.bottom > viewportTop &&
      nodes[i].classList.contains("is-placeholder")
    ) {
      return true;
    }
  }
  for (let i = start - 1; i >= 0; i--) {
    const rect = nodes[i].getBoundingClientRect();
    if (rect.bottom <= viewportTop) break;
    if (
      rect.top < viewportBottom &&
      nodes[i].classList.contains("is-placeholder")
    ) {
      return true;
    }
  }
  return false;
};

type RailItemProps = {
  item: RailItemData;
  index: number;
  isVisible: boolean;
  /** 键盘搜索当前高亮项（与「滚动可见」高亮是两套语义）。 */
  isActive: boolean;
  compactionLabel: string;
  onSelect: (messageId: string) => Promise<void>;
};

const RailItem = memo(
  ({
    item,
    index,
    isVisible,
    isActive,
    compactionLabel,
    onSelect,
  }: RailItemProps): React.JSX.Element => {
    const { summary } = item;
    const itemLabel = item.isContextCompaction
      ? compactionLabel
      : summary.length > 0
        ? summary.length > 64
          ? `${summary.slice(0, 64)}...`
          : summary
        : `#${index + 1}`;
    return (
      <button
        type="button"
        data-rail-index={index}
        className={`user-message-rail-popover-item${
          isVisible ? " is-visible" : ""
        }${isActive ? " is-active" : ""}`}
        onClick={() => void onSelect(item.id)}
        title={item.isContextCompaction ? itemLabel : summary}
      >
        <span className="user-message-rail-popover-item-index">
          {index + 1}
        </span>
        <span className="user-message-rail-popover-item-text">
          {item.segments ? (
            <ContentChips segments={item.segments} />
          ) : (
            itemLabel
          )}
        </span>
      </button>
    );
  },
);

RailItem.displayName = "RailItem";

export const UserMessageRail = memo(
  ({
    conversationId,
    scrollContainerRef,
    containerKey,
    loadOlderMessages,
    isLoadingOlderMessages,
    hasMoreMessages,
    conversationVersion,
    shouldStickToBottomRef,
    isInitialBottomPositioningRef,
    isUserScrollIntentRef,
  }: UserMessageRailProps): React.JSX.Element | null => {
    const { t } = useI18n();
    const [userMessages, setUserMessages] = useState<UserMessageSummary[]>([]);
    const [hovered, setHovered] = useState(false);
    const [loading, setLoading] = useState(false);
    // 本地搜索：列表数据本身就是全量用户消息摘要（listUserMessages），
    // 过滤在渲染层完成，不额外请求后端；点击结果复用现有翻页定位。
    const [query, setQuery] = useState("");
    const [activeIndex, setActiveIndex] = useState(0);
    const searchInputRef = useRef<HTMLInputElement | null>(null);
    /** 点击图标打开面板时置位：等面板提交后再聚焦，避免 hover 打开也抢焦点。 */
    const focusSearchOnOpenRef = useRef(false);
    const [popoverPos, setPopoverPos] = useState<{
      top: number;
      left: number;
    } | null>(null);
    const [popoverHeight, setPopoverHeight] = useState<number>(0);
    const [visibleUserIndices, setVisibleUserIndices] = useState<Set<number>>(
      new Set(),
    );
    // 定位遮罩：目标消息还在未加载的分页里时置位。翻页过程中消息区被隐藏、
    // 由骨架屏接管视觉，避免「翻页期间轻微抖动 + 最后一帧瞬间跳走」的观感。
    const [locating, setLocating] = useState(false);
    const [locateRect, setLocateRect] = useState<{
      top: number;
      left: number;
      width: number;
      height: number;
    } | null>(null);
    // 定位在途标志：期间忽略新的点击，防止两轮定位互相踩踏、遮罩被先结束
    // 的一轮提前撤下（回调闭包里读 state 会拿到快照，必须走 ref）。
    const locatingRef = useRef(false);
    // 遮罩类挂在滚动容器的真实 DOM 上（与 is-wheelscrolling 等同类做法），
    // 卸载清理时 ref 可能已被 React 置空，因此单独存一份元素引用。
    const locateContainerRef = useRef<HTMLElement | null>(null);
    const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const railRef = useRef<HTMLDivElement | null>(null);
    const popoverRef = useRef<HTMLDivElement | null>(null);
    const userMessagesRef = useRef<UserMessageSummary[]>([]);
    // 定位循环要连续翻多页：props 在回调闭包里是快照，翻页期间
    // hasMoreMessages 变为 false 后必须立刻停止续页，否则会白等兜底超时。
    const hasMoreMessagesRef = useRef(hasMoreMessages);
    const isLoadingOlderMessagesRef = useRef(isLoadingOlderMessages);
    hasMoreMessagesRef.current = hasMoreMessages;
    isLoadingOlderMessagesRef.current = isLoadingOlderMessages;

    // Fetch all user messages from the Rust backend on version bumps and
    // conversation switches. 会话切换立即拉取；同会话的版本号成串变化合并
    // 为一次；定位翻页期间每页都会 bump，暂停拉取，结束后补一次。
    const fetchedConversationIdRef = useRef<string | undefined>(undefined);
    const fetchedVersionRef = useRef<number>(-1);
    useEffect(() => {
      if (!conversationId) {
        fetchedConversationIdRef.current = undefined;
        fetchedVersionRef.current = -1;
        setUserMessages([]);
        userMessagesRef.current = [];
        return;
      }
      if (locating) {
        return;
      }
      const isSameConversation =
        fetchedConversationIdRef.current === conversationId;
      if (
        isSameConversation &&
        fetchedVersionRef.current === conversationVersion
      ) {
        return;
      }

      let cancelled = false;
      const fetchList = (): void => {
        setLoading(true);
        window.snow
          .listUserMessages(conversationId)
          .then((fetchedMessages) => {
            if (cancelled) return;
            fetchedConversationIdRef.current = conversationId;
            fetchedVersionRef.current = conversationVersion;
            setUserMessages(fetchedMessages);
            userMessagesRef.current = fetchedMessages;
          })
          .catch(() => {
            if (cancelled) return;
            setUserMessages([]);
            userMessagesRef.current = [];
          })
          .finally(() => {
            if (!cancelled) setLoading(false);
          });
      };

      if (!isSameConversation) {
        fetchList();
        return () => {
          cancelled = true;
        };
      }
      const timer = window.setTimeout(
        fetchList,
        USER_MESSAGES_REFETCH_DELAY_MS,
      );
      return () => {
        cancelled = true;
        window.clearTimeout(timer);
      };
    }, [conversationId, conversationVersion, locating]);

    // 定位结束后补一次可见高亮计算（定位期间计算被跳过）。
    const scheduleVisibleComputeRef = useRef<(() => void) | null>(null);

    // Track which user messages are currently visible in the scroll viewport.
    // On every scroll/resize, iterate the DB user messages, find their DOM
    // elements by id, and check whether they intersect the viewport. The
    // resulting Set of indices (into userMessages) is used to
    // highlight the corresponding rail popover items so the user knows where
    // they are in the conversation.
    useEffect(() => {
      const container = scrollContainerRef.current;
      if (!container) return;

      const computeVisible = (): void => {
        // 定位遮罩期间消息区不可见，高亮无意义，且会与定位循环争抢布局。
        if (locatingRef.current) {
          return;
        }
        const dbUserMsgs = userMessagesRef.current;
        if (dbUserMsgs.length === 0) {
          setVisibleUserIndices(new Set());
          return;
        }

        // 单次遍历建立 id → 矩形索引：此前逐条 querySelector 会让每条用户
        // 消息都重扫一遍容器子树（O(消息数²)），长会话滚动时开销显著。
        const rectById = new Map<string, DOMRect>();
        const elements =
          container.querySelectorAll<HTMLElement>("[data-message-id]");
        for (const element of elements) {
          const messageId = element.dataset.messageId;
          if (messageId) {
            rectById.set(messageId, element.getBoundingClientRect());
          }
        }

        const containerRect = container.getBoundingClientRect();
        const visible = new Set<number>();

        for (let i = 0; i < dbUserMsgs.length; i++) {
          // The frontend replaces temporary ids with DB ids after persistence,
          // so data-message-id always matches the DB snowflake id.
          const rect = rectById.get(dbUserMsgs[i].id);
          if (!rect) continue;

          // Consider the message visible if it overlaps the viewport band
          // of the scroll container (with a small threshold so partially
          // visible messages count).
          const THRESHOLD = 40;
          const isVisible =
            rect.bottom > containerRect.top + THRESHOLD &&
            rect.top < containerRect.bottom - THRESHOLD;

          if (isVisible) {
            visible.add(i);
          }
        }

        setVisibleUserIndices((prev) => {
          if (prev.size === visible.size) {
            let same = true;
            for (const idx of visible) {
              if (!prev.has(idx)) {
                same = false;
                break;
              }
            }
            if (same) return prev;
          }
          return visible;
        });
      };

      // Initial compute after a frame so layout is ready.
      const raf = requestAnimationFrame(computeVisible);
      // 流式滚动时 scroll 事件高频触发（每秒几十次），每次都要建 DOM 索引
      // 并读取几何；rAF 合并到每帧最多一次后再加最小间隔，滚动停止后的最后
      // 一次计算由尾部定时器补上，避免高亮停在中间状态。
      let pendingRaf = 0;
      let trailingTimer = 0;
      let lastComputeAt = 0;
      const scheduleCompute = (): void => {
        if (pendingRaf !== 0 || trailingTimer !== 0) return;
        pendingRaf = requestAnimationFrame(() => {
          pendingRaf = 0;
          const elapsed = performance.now() - lastComputeAt;
          if (elapsed >= VISIBILITY_COMPUTE_INTERVAL_MS) {
            lastComputeAt = performance.now();
            computeVisible();
            return;
          }
          trailingTimer = window.setTimeout(() => {
            trailingTimer = 0;
            lastComputeAt = performance.now();
            computeVisible();
          }, VISIBILITY_COMPUTE_INTERVAL_MS - elapsed);
        });
      };
      container.addEventListener("scroll", scheduleCompute, { passive: true });
      window.addEventListener("resize", scheduleCompute);
      scheduleVisibleComputeRef.current = scheduleCompute;

      return () => {
        if (scheduleVisibleComputeRef.current === scheduleCompute) {
          scheduleVisibleComputeRef.current = null;
        }
        cancelAnimationFrame(raf);
        if (pendingRaf !== 0) {
          cancelAnimationFrame(pendingRaf);
        }
        if (trailingTimer !== 0) {
          window.clearTimeout(trailingTimer);
        }
        container.removeEventListener("scroll", scheduleCompute);
        window.removeEventListener("resize", scheduleCompute);
      };
    }, [scrollContainerRef, containerKey, conversationId, conversationVersion]);

    // Compute popover position relative to the rail element so it opens to
    // the left, hugging the rail's left edge. The popover top is clamped to
    // keep the entire popover within the viewport so it never overflows or
    // grows infinitely off-screen when there are many messages.
    const computePopoverPosition = useCallback((): {
      top: number;
      left: number;
    } | null => {
      const rail = railRef.current;
      if (!rail) return null;
      const railRect = rail.getBoundingClientRect();
      const POPOVER_WIDTH = 260;
      const POPOVER_GAP = 8;
      const VIEWPORT_MARGIN = 8;

      // Prefer to center the popover vertically on the rail, but clamp it
      // so the popover never extends beyond the viewport. We need the
      // popover's actual height for this; if not yet measured, fall back
      // to a reasonable estimate.
      const measuredH = popoverRef.current?.offsetHeight ?? 0;
      const approxH = measuredH > 0 ? measuredH : popoverHeight;
      const effectiveH = approxH > 0 ? approxH : 400;

      const desiredTop = railRect.top + railRect.height / 2 - effectiveH / 2;
      const minTop = VIEWPORT_MARGIN;
      const maxTop = window.innerHeight - effectiveH - VIEWPORT_MARGIN;
      const top = Math.max(minTop, Math.min(desiredTop, maxTop));

      const left = railRect.left - POPOVER_WIDTH - POPOVER_GAP;
      return { top, left };
    }, [popoverHeight]);

    const handleMouseEnter = useCallback((): void => {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
      setPopoverPos(computePopoverPosition());
      setHovered(true);
    }, [computePopoverPosition]);

    const handleMouseLeave = useCallback((): void => {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
      }
      hideTimerRef.current = setTimeout(() => {
        setHovered(false);
        setPopoverPos(null);
        setPopoverHeight(0);
      }, 200);
    }, []);

    // 点击图标 = 明确要搜索：打开面板并把焦点交给搜索框。
    // hover 打开不走这里，避免鼠标扫过图标就抢走别处的输入焦点。
    const handleRailClick = useCallback((): void => {
      if (hovered) {
        searchInputRef.current?.focus();
        return;
      }
      focusSearchOnOpenRef.current = true;
      handleMouseEnter();
    }, [handleMouseEnter, hovered]);

    useEffect(() => {
      if (!hovered || !focusSearchOnOpenRef.current) {
        return;
      }
      focusSearchOnOpenRef.current = false;
      searchInputRef.current?.focus();
    }, [hovered]);

    useEffect(() => {
      return () => {
        if (hideTimerRef.current) {
          clearTimeout(hideTimerRef.current);
        }
      };
    }, []);

    // 撤下定位遮罩：恢复消息列表绘制并卸掉骨架屏。翻页失败（目标迟迟没
    // 出现，循环退出）时同样走这里，不会把消息区永久留在隐藏状态。
    const finishLocating = useCallback((): void => {
      locatingRef.current = false;
      locateContainerRef.current?.classList.remove("is-locating-message");
      locateContainerRef.current = null;
      setLocating(false);
      setLocateRect(null);
      scheduleVisibleComputeRef.current?.();
    }, []);

    // 骨架屏遮罩跟随滚动容器的位置与尺寸（窗口缩放、面板开合都会改变它）。
    // layout effect：与点击同一次提交内量好坐标，遮罩首帧就带着骨架屏，
    // 不会先闪一帧只剩隐藏消息区的空屏。
    useLayoutEffect(() => {
      if (!locating) {
        return;
      }
      const syncRect = (): void => {
        const container = scrollContainerRef.current;
        if (!container) {
          return;
        }
        const rect = container.getBoundingClientRect();
        setLocateRect({
          top: rect.top,
          left: rect.left,
          width: rect.width,
          height: rect.height,
        });
      };
      syncRect();
      window.addEventListener("resize", syncRect);
      return () => {
        window.removeEventListener("resize", syncRect);
      };
    }, [locating, scrollContainerRef]);

    // 定位途中卸载（会话切换、消息清空）：遮罩类必须摘干净，否则重建后的
    // 消息区会一直停在隐藏状态。此处刻意不走 setState，卸载后不再需要。
    useEffect(() => {
      return () => {
        locatingRef.current = false;
        locateContainerRef.current?.classList.remove("is-locating-message");
        locateContainerRef.current = null;
      };
    }, []);

    // After the popover mounts (hovered becomes true), measure its real
    // height on the next frame and compute the final clamped position. This
    // runs once per open — it reads offsetHeight synchronously after layout
    // so the initial estimate is corrected to exact centering + viewport
    // clamping.
    useEffect(() => {
      if (!hovered) return;
      const rail = railRef.current;
      if (!rail) return;
      let cancelled = false;

      const measureAndPosition = (): void => {
        if (cancelled) return;
        const el = popoverRef.current;
        const railRect = rail.getBoundingClientRect();
        const POPOVER_WIDTH = 260;
        const POPOVER_GAP = 8;
        const VIEWPORT_MARGIN = 8;

        const effectiveH =
          el?.offsetHeight && el.offsetHeight > 0 ? el.offsetHeight : 400;

        const desiredTop = railRect.top + railRect.height / 2 - effectiveH / 2;
        const minTop = VIEWPORT_MARGIN;
        const maxTop = window.innerHeight - effectiveH - VIEWPORT_MARGIN;
        const top = Math.max(minTop, Math.min(desiredTop, maxTop));
        const left = railRect.left - POPOVER_WIDTH - POPOVER_GAP;

        setPopoverPos({ top, left });
        if (el && el.offsetHeight > 0) {
          setPopoverHeight(el.offsetHeight);
        }
      };

      // Defer one frame so the portaled popover has been laid out.
      const raf = requestAnimationFrame(measureAndPosition);
      return () => {
        cancelled = true;
        cancelAnimationFrame(raf);
      };
    }, [hovered, userMessages]);

    // Recompute on viewport resize so the clamp stays correct.
    useEffect(() => {
      if (!hovered) return;
      const onResize = (): void => {
        const rail = railRef.current;
        if (!rail) return;
        const railRect = rail.getBoundingClientRect();
        const POPOVER_WIDTH = 260;
        const POPOVER_GAP = 8;
        const VIEWPORT_MARGIN = 8;
        const effectiveH =
          popoverRef.current?.offsetHeight &&
          popoverRef.current.offsetHeight > 0
            ? popoverRef.current.offsetHeight
            : popoverHeight > 0
              ? popoverHeight
              : 400;
        const desiredTop = railRect.top + railRect.height / 2 - effectiveH / 2;
        const minTop = VIEWPORT_MARGIN;
        const maxTop = window.innerHeight - effectiveH - VIEWPORT_MARGIN;
        const top = Math.max(minTop, Math.min(desiredTop, maxTop));
        const left = railRect.left - POPOVER_WIDTH - POPOVER_GAP;
        setPopoverPos({ top, left });
      };
      window.addEventListener("resize", onResize);
      return () => window.removeEventListener("resize", onResize);
    }, [hovered, popoverHeight]);

    // Scroll to a target user message. The frontend replaces temporary ids
    // with real DB ids after persistence, so the DOM's data-message-id always
    // matches the DB snowflake id from listUserMessages. If the message is not
    // yet in the DOM (paginated loading hasn't reached it), repeatedly call
    // loadOlderMessages until it appears or there are no more pages. The loader
    // is the chat area's anchor-preserving paging entry: every prepended page is
    // corrected back to the current viewport anchor before it resolves, so the
    // visible content never jumps while we page up to the target. Then use
    // scrollIntoView and iterate: virtualized placeholders above the target
    // expand to real content (height changes), pushing the target down. We
    // keep re-scrolling until the position stabilizes.
    //
    // 目标还压在未加载的分页里时（needsPaging），消息列表在定位全程只隐藏
    // 绘制、保留布局：翻页锚点校正与 scrollIntoView 读的都是真实 rect，照常
    // 工作，视觉则交给盖在滚动容器位置上的骨架屏——翻页期间的轻微抖动与最后
    // 那一下瞬间跳走都不会被看到，落地后再揭开遮罩。
    const handleItemClick = useCallback(
      async (messageId: string): Promise<void> => {
        const container = scrollContainerRef.current;
        if (!container) {
          return;
        }
        // 上一轮定位还没结束：忽略这次点击。两轮定位的翻页会互相等待
        // （loader 有 in-flight 守卫），而遮罩会被先结束的一轮提前撤下。
        if (locatingRef.current) {
          return;
        }

        // Mark this as a user-initiated scroll, exactly like
        // markUserScrollIntent does. This resets isInitialBottomPositioning
        // (so deriveFollowStateFromScroll stops forcing shouldStickToBottom=true)
        // and sets isUserScrollIntent (so the follow state is derived from
        // the live geometry instead of pinning to the bottom). Without this,
        // the ResizeObserver's keepAtBottomSync yanks the viewport back to
        // the bottom the instant loadOlderMessages finishes prepending pages.
        isUserScrollIntentRef.current = true;
        isInitialBottomPositioningRef.current = false;
        shouldStickToBottomRef.current = false;

        let el = findMessageElement(container, messageId);

        const needsPaging = !el;
        if (needsPaging) {
          locatingRef.current = true;
          locateContainerRef.current = container;
          container.classList.add("is-locating-message");
          // 选中即离场：定位期间浮层让位给遮罩（骨架屏才是进度反馈）。
          setHovered(false);
          setPopoverPos(null);
          setLocating(true);
        }

        try {
          // If not found, load older messages in a loop until it appears. Guard on
          // the refs, not the captured props: after the last page lands
          // hasMoreMessages flips to false and the loop must stop instead of
          // burning rounds (each of which would wait out the loader's fallback).
          let pageSize = LOCATE_PAGE_SIZE_MIN;
          let round = 0;
          // container.isConnected：定位途中切换会话会整体重建 .chat-area，旧
          // 容器脱离文档后目标永远不会出现，继续翻页只会把新会话的历史白拉
          // 进内存（遮罩类挂在旧容器上，不影响新容器）。
          while (
            !el &&
            hasMoreMessagesRef.current &&
            container.isConnected &&
            round < LOCATE_MAX_LOAD_ROUNDS
          ) {
            round++;
            if (isLoadingOlderMessagesRef.current) {
              await new Promise((resolve) => setTimeout(resolve, 50));
              continue;
            }
            await loadOlderMessages(pageSize);
            pageSize = Math.min(pageSize * 2, LOCATE_PAGE_SIZE_MAX);
            await nextFrame();
            el = findMessageElement(container, messageId);
          }

          if (!el) {
            return;
          }

          // 落位：每帧先集中读几何、再单次写 scrollTop（不再 scrollIntoView +
          // 反复测量）。目标上方占位符反虚拟化会把目标往下推，逐帧补偿，直到
          // 目标与视口内都无占位符、位置与 scrollHeight 连续若干帧不变。
          let prevOffsetTop = Number.NaN;
          let prevScrollHeight = -1;
          let stableFrames = 0;
          for (let frame = 0; frame < LOCATE_SETTLE_MAX_FRAMES; frame++) {
            if (
              scrollContainerRef.current !== container ||
              !container.isConnected
            ) {
              break;
            }
            const target = findMessageElement(container, messageId);
            if (!target) break;

            const containerRect = container.getBoundingClientRect();
            const viewportTop = containerRect.top + container.clientTop;
            const viewportBottom = viewportTop + container.clientHeight;
            const targetTop = target.getBoundingClientRect().top;
            const scrollTop = container.scrollTop;
            const scrollHeight = container.scrollHeight;
            const offsetTop = targetTop - viewportTop + scrollTop;
            const maxScrollTop = Math.max(
              0,
              scrollHeight - container.clientHeight,
            );
            const desiredScrollTop = Math.min(
              Math.max(scrollTop + (targetTop - viewportTop), 0),
              maxScrollTop,
            );
            const aligned = Math.abs(desiredScrollTop - scrollTop) <= 1;
            const isStable =
              aligned &&
              Math.abs(offsetTop - prevOffsetTop) <= 0.5 &&
              scrollHeight === prevScrollHeight &&
              !target.classList.contains("is-placeholder") &&
              !hasPlaceholderInViewport(
                container,
                target,
                viewportTop,
                viewportBottom,
              );
            stableFrames = isStable ? stableFrames + 1 : 0;
            if (stableFrames >= LOCATE_STABLE_FRAMES) {
              break;
            }
            prevOffsetTop = offsetTop;
            prevScrollHeight = scrollHeight;
            if (!aligned) {
              container.scrollTop = desiredScrollTop;
            }
            await nextFrame();
          }
        } finally {
          if (needsPaging) {
            finishLocating();
          }
          setHovered(false);
          setPopoverPos(null);
        }
      },
      [
        scrollContainerRef,
        loadOlderMessages,
        shouldStickToBottomRef,
        isInitialBottomPositioningRef,
        isUserScrollIntentRef,
        finishLocating,
      ],
    );

    // 浮层列表项派生数据：仅浮层打开时计算，按 id + 内容缓存，避免高亮
    // 变化或重拉列表时对全部消息重复做摘要与 chip 解析。
    const railItemCacheRef = useRef<Map<string, RailItemCacheEntry>>(new Map());
    const railItems = useMemo((): RailItemData[] => {
      if (!hovered) {
        return [];
      }
      const prevCache = railItemCacheRef.current;
      const nextCache = new Map<string, RailItemCacheEntry>();
      const items = userMessages.map((msg) => {
        const isContextCompaction = Boolean(msg.isContextCompaction);
        const cached = prevCache.get(msg.id);
        if (
          cached &&
          cached.content === msg.content &&
          cached.isContextCompaction === isContextCompaction
        ) {
          nextCache.set(msg.id, cached);
          return cached.data;
        }
        const data = deriveRailItem(msg);
        nextCache.set(msg.id, {
          content: msg.content,
          isContextCompaction,
          data,
        });
        return data;
      });
      railItemCacheRef.current = nextCache;
      return items;
    }, [hovered, userMessages]);

    // 搜索词按空白切分做 AND 匹配：多个词分别命中即可，适合「路径 + 关键词」这种组合。
    const searchTerms = useMemo(
      () => query.trim().toLowerCase().split(/\s+/).filter(Boolean),
      [query],
    );

    /** 过滤结果保留原始索引：编号、滚动可见高亮、定位都以它为准。 */
    const filteredRailItems = useMemo(() => {
      const indexed = railItems.map((item, index) => ({ item, index }));
      if (searchTerms.length === 0) {
        return indexed;
      }
      return indexed.filter(({ item }) =>
        searchTerms.every((term) => item.searchText.includes(term)),
      );
    }, [railItems, searchTerms]);

    // 搜索词变化时回到第一条结果。
    useEffect(() => {
      setActiveIndex(0);
    }, [query]);

    // 结果集缩短后把高亮索引夹回有效范围。
    useEffect(() => {
      setActiveIndex((prev) =>
        prev < filteredRailItems.length
          ? prev
          : Math.max(0, filteredRailItems.length - 1),
      );
    }, [filteredRailItems.length]);

    // 键盘移动高亮时把该项滚进可视区（不做整列滚动，保持贴近当前结果）。
    useEffect(() => {
      if (!hovered || searchTerms.length === 0) return;
      const target = filteredRailItems[activeIndex];
      if (!target) return;
      popoverRef.current
        ?.querySelector<HTMLElement>(`[data-rail-index="${target.index}"]`)
        ?.scrollIntoView({ block: "nearest" });
    }, [activeIndex, filteredRailItems, hovered, searchTerms.length]);

    const handleSearchKeyDown = (
      event: React.KeyboardEvent<HTMLInputElement>,
    ): void => {
      // 中文/日文输入法确认候选词的 Enter 不应被当成「跳转」。
      if (event.nativeEvent.isComposing) {
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (filteredRailItems.length === 0) return;
        const delta = event.key === "ArrowDown" ? 1 : -1;
        setActiveIndex((prev) =>
          Math.min(Math.max(prev + delta, 0), filteredRailItems.length - 1),
        );
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const target = filteredRailItems[activeIndex];
        if (target) {
          void handleItemClick(target.item.id);
        }
        return;
      }
      if (event.key === "Escape") {
        event.stopPropagation();
        if (query.length > 0) {
          setQuery("");
        } else {
          setHovered(false);
          setPopoverPos(null);
        }
      }
    };

    if (userMessages.length === 0 && !loading) {
      return null;
    }

    const compactionLabel = t("chat.compactionSummary", {
      defaultValue: "Context summary",
    });

    const popover =
      hovered && userMessages.length > 0 && popoverPos
        ? createPortal(
            <div
              ref={popoverRef}
              className="user-message-rail-popover"
              style={{
                top: `${popoverPos.top}px`,
                left: `${popoverPos.left}px`,
              }}
              onMouseEnter={handleMouseEnter}
              onMouseLeave={handleMouseLeave}
            >
              <div className="user-message-rail-popover-header">
                <span>
                  {t("chat.userMessageRail.title", {
                    defaultValue: "User messages",
                  })}
                </span>
                <span className="user-message-rail-popover-count">
                  {searchTerms.length > 0
                    ? `${filteredRailItems.length}/${userMessages.length}`
                    : userMessages.length}
                </span>
              </div>
              <div className="user-message-rail-popover-search">
                <Search size={12} strokeWidth={2} aria-hidden="true" />
                <input
                  ref={searchInputRef}
                  type="text"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={handleSearchKeyDown}
                  placeholder={t("chat.userMessageRail.searchPlaceholder", {
                    defaultValue: "Search user messages",
                  })}
                  aria-label={t("chat.userMessageRail.searchPlaceholder", {
                    defaultValue: "Search user messages",
                  })}
                  spellCheck={false}
                />
                {query.length > 0 ? (
                  <button
                    type="button"
                    className="user-message-rail-popover-search-clear"
                    onClick={() => {
                      setQuery("");
                      searchInputRef.current?.focus();
                    }}
                    aria-label={t("chat.userMessageRail.searchClear", {
                      defaultValue: "Clear search",
                    })}
                  >
                    <X size={12} strokeWidth={2} aria-hidden="true" />
                  </button>
                ) : null}
              </div>
              <div className="user-message-rail-popover-list">
                {filteredRailItems.length === 0 ? (
                  <div className="user-message-rail-popover-empty">
                    {t("chat.userMessageRail.searchEmpty", {
                      defaultValue: "No matching user messages",
                    })}
                  </div>
                ) : (
                  filteredRailItems.map(({ item, index }, position) => (
                    <RailItem
                      key={item.id}
                      item={item}
                      index={index}
                      isVisible={visibleUserIndices.has(index)}
                      isActive={
                        searchTerms.length > 0 && position === activeIndex
                      }
                      compactionLabel={compactionLabel}
                      onSelect={handleItemClick}
                    />
                  ))
                )}
              </div>
            </div>,
            document.body,
          )
        : null;

    // 定位遮罩：坐标取自滚动容器的视口矩形（与浮层同一套 portal + 定坐标
    // 做法），骨架屏在其中垂直居中。消息列表此时被 .is-locating-message
    // 隐藏绘制，这一层就是定位期间唯一的视觉反馈。
    const locateOverlay =
      locating && locateRect
        ? createPortal(
            <div
              className="user-message-locate-overlay"
              style={{
                top: `${locateRect.top}px`,
                left: `${locateRect.left}px`,
                width: `${locateRect.width}px`,
                height: `${locateRect.height}px`,
              }}
            >
              <ChatHistorySkeleton />
            </div>,
            document.body,
          )
        : null;

    return (
      <>
        <div
          ref={railRef}
          className="user-message-rail"
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          onClick={handleRailClick}
          aria-label={t("chat.userMessageRail.title", {
            defaultValue: "User messages",
          })}
          title={t("chat.userMessageRail.title", {
            defaultValue: "User messages",
          })}
        >
          <MessageSquare size={14} strokeWidth={2} aria-hidden="true" />
          {userMessages.length > 0 ? (
            <span className="user-message-rail-count">
              {userMessages.length}
            </span>
          ) : null}
        </div>
        {locateOverlay}
        {popover}
      </>
    );
  },
);

UserMessageRail.displayName = "UserMessageRail";
