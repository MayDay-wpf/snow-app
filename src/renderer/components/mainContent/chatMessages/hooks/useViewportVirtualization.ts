import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

/**
 * Viewport virtualization for the chat message list.
 *
 * During a long AI loop, the message array grows and every streaming chunk
 * triggers `updateSessionMessages`, which causes ChatMessageList to re-render
 * every message even though most of them are scrolled out of view. Markdown
 * rendering (worker + rAF throttle) and the growing DOM tree make each render
 * progressively more expensive — this is the root cause of UI jank after the
 * AI has been running for a while, and of the sluggish panel resize when many
 * heavy Markdown blocks (especially thinking blocks with tens of thousands of
 * tokens) are attached to the document.
 *
 * The native `content-visibility: auto` on `.chat-message-group` helps the
 * browser skip *paint* for off-screen content, but it does NOT skip React
 * reconciliation, Markdown worker dispatches, or layout reflow when the panel
 * width changes (every message group still participates in the reflow pass).
 *
 * This hook tracks which message ids are inside the scroll viewport (plus a
 * buffer margin) using two shared IntersectionObservers: a near box that
 * promotes ids into the visible set, and a wider exit box that keeps them
 * visible until they leave it. Components can
 * then render a cheap placeholder for off-screen messages instead of the full
 * AiResponse / MarkdownBlock subtree, which:
 *   - eliminates React reconciliation work for off-screen messages on every
 *     streaming chunk,
 *   - removes off-screen DOM nodes from the reflow path during panel resize,
 *   - skips Markdown worker dispatches for content the user cannot see.
 *
 * Certain messages are "pinned" and always treated as visible regardless of
 * their geometric position:
 *   - The streaming (last assistant) message, so the live output is always
 *     rendered even when the user scrolls away and auto-scroll is off.
 *   - Messages with pending tool authorizations, so the approval dialog is
 *     never unmounted while waiting for the user.
 *
 * Height stability is critical: when a message virtualizes out, it is
 * replaced by a placeholder that must occupy the same height to avoid
 * scrollbar jumps. The hook exposes a height cache (Map<id, px>) kept in sync
 * via a ResizeObserver on every mounted message element. Placeholders read
 * the cached height and fall back to a reasonable default for messages that
 * were never measured.
 */

/** Extra pixels above/below the viewport that stay rendered, so fast scrolls
 * do not flash empty placeholders before the observer catches up. */
const VIEWPORT_BUFFER_PX = 600;
const VIEWPORT_EXIT_BUFFER_PX = 720;

/** Fallback height for a message that was never measured before being
 *  virtualized out. Matches the CSS contain-intrinsic-size estimate so
 *  scrollbar behavior stays consistent with the content-visibility path. */
const DEFAULT_PLACEHOLDER_HEIGHT = 80;

/** Minimum interval between height-cache writes for a single element, in ms.
 *  ResizeObserver can fire in bursts during streaming; throttling writes
 *  avoids excessive setState churn. */
const HEIGHT_MEASURE_THROTTLE_MS = 200;

export type ViewportVirtualization = {
  /** Set of message ids that should render their full content. Includes
   *  viewport-intersecting ids plus pinned ids. Re-renders only when the
   *  set actually changes.
   *
   *  `null` means "not yet initialized" — the IntersectionObserver has not
   *  fired its first batch yet. While null, VirtualizedMessage renders every
   *  message's real content so the first paint is not a wall of empty
   *  placeholders. As soon as the observer reports the initial intersection
   *  state, this becomes a real set and off-screen messages virtualize out. */
  visibleIds: ReadonlySet<string> | null;
  /** Cached rendered height (px) per message id, for placeholder sizing. */
  heights: ReadonlyMap<string, number>;
  /** Register a message wrapper element for tracking. Pass the same id with
   *  a null node to unregister (e.g. in a ref callback or effect cleanup). */
  register: (id: string, node: HTMLElement | null) => void;
};

export const VIRTUAL_PLACEHOLDER_DEFAULT_HEIGHT = DEFAULT_PLACEHOLDER_HEIGHT;

/**
 * Track which message ids intersect the scroll viewport.
 *
 * @param scrollContainerRef Ref to the scrollable container (the `.chat-area`
 *   element). The IntersectionObserver uses it as its `root`.
 * @param pinnedIds Message ids that must always be treated as visible
 *   regardless of intersection (streaming message, pending authorizations).
 * @param initialVisibleIds Optional starting visible set used instead of the
 *   "not yet initialized" null state. Lets the caller skip the synchronous
 *   full-list first render for large conversations: the initial commit only
 *   renders this window, and the first IntersectionObserver report replaces
 *   it with the real intersection set.
 * @param eagerVisibleIds Ids that must render their real content immediately
 *   on mount, before the observer's first report takes over: freshly
 *   prepended pages (loadOlder paging — an 80px placeholder phase would make
 *   the scroll-restore correction under-shift and then visibly shove the
 *   viewport as the real content expands).
 * @returns Virtualization API: `visibleIds`, `heights`, `register`.
 */
export const useViewportVirtualization = (
  scrollContainerRef: React.RefObject<HTMLDivElement | null>,
  pinnedIds: ReadonlySet<string>,
  initialVisibleIds?: ReadonlySet<string> | null,
  eagerVisibleIds?: ReadonlySet<string>,
): ViewportVirtualization => {
  // null = "not yet initialized". While null, every message renders its real
  // content so the first paint is not a wall of empty placeholders. As soon
  // as the IntersectionObserver reports the initial intersection state, this
  // becomes a real set and off-screen messages virtualize out.
  //
  // When the caller supplies `initialVisibleIds` (a rough estimate of the
  // messages visible at mount time), it becomes the starting set instead of
  // null: the first commit then renders only that window (plus pinned ids),
  // avoiding the synchronous full-list render of huge conversations — which
  // blocks the renderer's main thread for hundreds of ms and freezes CSS
  // animations (loading spinners, skeleton pulses) during conversation
  // switches. The observer's first report replaces the estimate with the
  // real intersection set.
  const [visibleIds, setVisibleIds] = useState<ReadonlySet<string> | null>(
    () => initialVisibleIds ?? null,
  );
  // 高度缓存只在「真实 → 占位符」切换的那次渲染被读取（切换由 visibleIds 变化
  // 驱动，写入发生在 flush 之前），无需作为 state：否则每次测量都让整列消息重渲染。
  const heightsRef = useRef<Map<string, number>>(new Map());

  // Shared observers, lazily created once the scroll container is available.
  const intersectionObserverRef = useRef<IntersectionObserver | null>(null);
  const exitObserverRef = useRef<IntersectionObserver | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);

  // Bidirectional maps so we can clean up either by node or by id.
  const nodeToIdRef = useRef<Map<HTMLElement, string>>(new Map());
  const idToNodeRef = useRef<Map<string, HTMLElement>>(new Map());
  // id -> last measured timestamp, for throttling height writes.
  const lastMeasureAtRef = useRef<Map<string, number>>(new Map());
  // rAF id for the eager-measure batch. Non-zero while a batch is pending.
  const measureRafRef = useRef(0);
  // 两个观察器各自的权威状态集：近场（视口 ±600，决定进入可见）与远场
  // （±720，决定退出可见）。只由对应观察器 entry 的 isIntersecting 驱动，
  // 绝不在回调里按当时的 rect 重算判定——重算会与观察器自身状态脱钩：entry
  // 翻转后若 rect 因反向滚动退回边界外，id 被判为不可见，而观察器不再产生
  // 新 entry 纠正，视口内的消息会长期停在占位符上（滚出再滚回才恢复）。
  const nearIdsRef = useRef<Set<string>>(new Set());
  const farIdsRef = useRef<Set<string>>(new Set());
  // Ids that render real content unconditionally until the observer reports
  // their first intersection state (top-prepended pages). Keeps a newly
  // prepended page from spending frames as 80px placeholders — the paging
  // scroll-restore correction measures geometry while those frames exist and
  // under-shifts, then the real content expansion visibly shoves the viewport.
  const forceVisibleIdsRef = useRef<Set<string>>(new Set());
  // Current pinned ids, kept in a ref so the observer callback (which closes
  // over the ref, not the value) always reads the latest set without being
  // recreated when pinnedIds changes.
  const pinnedIdsRef = useRef<ReadonlySet<string>>(pinnedIds);
  pinnedIdsRef.current = pinnedIds;

  // Recompute the visible set from near + hysteresis + pinned, and push to
  // state only when it actually changes.
  const flushVisibleIds = useCallback(() => {
    setVisibleIds((prev) => {
      const next = new Set<string>(nearIdsRef.current);
      // 迟滞：上一轮已可见且仍在远场内的 id 保持可见——边界附近来回滚动
      // 不会反复卸载/重挂内容，离开远场（>720）才真正虚拟化出去。
      if (prev !== null) {
        for (const id of prev) {
          if (farIdsRef.current.has(id)) {
            next.add(id);
          }
        }
      }
      for (const id of forceVisibleIdsRef.current) {
        next.add(id);
      }
      const pinned = pinnedIdsRef.current;
      if (pinned.size > 0) {
        for (const id of pinned) {
          next.add(id);
        }
      }
      // prev === null means "not initialized yet". Any real `next` set
      // (including empty) supersedes it and starts the virtualization.
      if (prev === null) {
        return next;
      }
      if (prev.size === next.size) {
        let same = true;
        for (const id of prev) {
          if (!next.has(id)) {
            same = false;
            break;
          }
        }
        if (same) return prev;
      }
      return next;
    });
  }, []);

  // visibleIds 的实时镜像：pinned 补齐 effect 需要在本 commit 内读取最新
  // 可见集（state 更新尚未提交时不能依赖渲染期的值）。
  const visibleIdsRef = useRef<ReadonlySet<string> | null>(visibleIds);
  visibleIdsRef.current = visibleIds;

  // pinnedIds（最新流式消息、待授权消息）语义上"必须始终渲染真实内容"，
  // 但此前并入可见集的时机只跟随 IntersectionObserver 报告：主线程繁忙
  // （工具执行刚结束、大量内容更新）时 IO 回调会晚到数帧，pinned 消息先以
  // 80px 占位符渲染、随后才切换为真实内容，导致高度跳变与入场动画重播
  // （表现为消息区闪一下）。这里在 pinned 集合变化后立即补齐（paint 前的
  // layout effect），保证 pinned 消息首帧即真实内容。
  useLayoutEffect(() => {
    const current = visibleIdsRef.current;
    if (current === null) {
      // 尚未初始化：所有消息都渲染真实内容，无需补齐。
      return;
    }
    let missing = false;
    for (const id of pinnedIds) {
      if (!current.has(id)) {
        missing = true;
        break;
      }
    }
    if (missing) {
      flushVisibleIds();
    }
  }, [pinnedIds, flushVisibleIds]);

  // Fold eager ids (top-prepended pages) into the force-visible set and flush
  // before paint: they must mount with their real content (layout effect →
  // synchronous re-render, still pre-paint), not as 80px placeholders — the
  // paging scroll-restore correction measures geometry across these commits
  // and a placeholder frame makes it under-shift, after which the real content
  // expansion visibly shoves the viewport. The observer's first report for
  // each id removes it from the set, handing visibility back to the normal
  // intersection logic.
  useLayoutEffect(() => {
    if (!eagerVisibleIds || eagerVisibleIds.size === 0) {
      return;
    }
    for (const id of eagerVisibleIds) {
      forceVisibleIdsRef.current.add(id);
    }
    flushVisibleIds();
  }, [eagerVisibleIds, flushVisibleIds]);

  const updateHeights = useCallback((updates: Array<[string, number]>) => {
    const heights = heightsRef.current;
    for (const [id, height] of updates) {
      heights.set(id, height);
    }
  }, []);

  // IntersectionObserver callback factory. Kept as a stable function so both
  // the lazy creation path and the container-change path share one impl.
  // 每个 id 的判定只听对应观察器自己的 entry.isIntersecting；退出远场
  // （isIntersecting 变 false，下一步即变占位符）时量取真实高度写缓存。
  const applyObserverEntries = useCallback(
    (
      targets: Set<string>,
      entries: IntersectionObserverEntry[],
      measureOnExit: boolean,
    ) => {
      const container = scrollContainerRef.current;
      if (!container) return;
      const updates: Array<[string, number]> = [];
      let changed = false;
      for (const entry of entries) {
        const node = entry.target as HTMLElement;
        const id = nodeToIdRef.current.get(node);
        if (!id || !container.contains(node)) continue;
        // The observer has produced its authoritative verdict for this id —
        // the force-visible escape hatch (prepended pages) is no longer needed.
        if (forceVisibleIdsRef.current.delete(id)) {
          changed = true;
        }
        if (entry.isIntersecting) {
          if (!targets.has(id)) {
            targets.add(id);
            changed = true;
          }
          continue;
        }
        if (targets.delete(id)) {
          changed = true;
        }
        if (measureOnExit && !node.classList.contains("is-placeholder")) {
          // 占位符高度来自 inline style，不是真实内容高度，写回会污染缓存。
          const height = node.getBoundingClientRect().height;
          if (height > 0) {
            lastMeasureAtRef.current.set(id, Date.now());
            updates.push([id, height]);
          }
        }
      }
      updateHeights(updates);
      if (changed) {
        flushVisibleIds();
      }
    },
    [flushVisibleIds, scrollContainerRef, updateHeights],
  );

  // ResizeObserver callback factory.
  const handleResize = useCallback(
    (entries: ResizeObserverEntry[]) => {
      const now = Date.now();
      const updates: Array<[string, number]> = [];
      for (const entry of entries) {
        const node = entry.target as HTMLElement;
        // 占位符的高度来自 inline style（缓存值或 80px 默认值），不是内容的
        // 真实高度。「真实 → 占位符」切换触发的 resize 若写回缓存，会把已
        // 测得的真实高度覆盖成占位符高度，此后该消息每次进出 buffer 都令
        // 文档高度剧烈伸缩——向上慢滚时表现为滚动位置反复跳变。
        if (node.classList.contains("is-placeholder")) continue;
        const id = nodeToIdRef.current.get(node);
        if (!id) continue;
        // Throttle per-id writes so streaming bursts (which fire ResizeObserver
        // on every chunk) do not flood state updates.
        const lastAt = lastMeasureAtRef.current.get(id) ?? 0;
        if (now - lastAt < HEIGHT_MEASURE_THROTTLE_MS) continue;
        const height =
          entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height;
        if (height <= 0) continue;
        lastMeasureAtRef.current.set(id, now);
        updates.push([id, height]);
      }
      updateHeights(updates);
    },
    [updateHeights],
  );

  // (Re)build the observers against the current scroll container and re-observe
  // all currently registered nodes. Called on mount and whenever the container
  // element identity changes.
  const rebuildObservers = useCallback(() => {
    const root = scrollContainerRef.current;
    if (!root) return;

    intersectionObserverRef.current?.disconnect();
    exitObserverRef.current?.disconnect();
    resizeObserverRef.current?.disconnect();
    nearIdsRef.current.clear();
    farIdsRef.current.clear();

    const intersection = new IntersectionObserver(
      (entries) => applyObserverEntries(nearIdsRef.current, entries, false),
      {
        root,
        rootMargin: `${VIEWPORT_BUFFER_PX}px 0px ${VIEWPORT_BUFFER_PX}px 0px`,
        threshold: 0,
      },
    );
    const exit = new IntersectionObserver(
      (entries) => applyObserverEntries(farIdsRef.current, entries, true),
      {
        root,
        rootMargin: `${VIEWPORT_EXIT_BUFFER_PX}px 0px ${VIEWPORT_EXIT_BUFFER_PX}px 0px`,
        threshold: 0,
      },
    );
    const resize = new ResizeObserver(handleResize);
    intersectionObserverRef.current = intersection;
    exitObserverRef.current = exit;
    resizeObserverRef.current = resize;

    for (const node of nodeToIdRef.current.keys()) {
      intersection.observe(node);
      exit.observe(node);
      resize.observe(node);
    }
    // Let the observer settle asynchronously; flushVisibleIds will run from
    // the initial intersection callback batch.
  }, [applyObserverEntries, handleResize, scrollContainerRef]);

  // Rebuild when the container element identity changes. The key on
  // `.chat-area` in ChatContent forces a remount per conversation, so this
  // effect also covers switching conversations.
  useEffect(() => {
    rebuildObservers();
    return () => {
      intersectionObserverRef.current?.disconnect();
      exitObserverRef.current?.disconnect();
      resizeObserverRef.current?.disconnect();
      intersectionObserverRef.current = null;
      exitObserverRef.current = null;
      resizeObserverRef.current = null;
    };
  }, [rebuildObservers]);

  // Public register function. Called by each VirtualizedMessage via a ref
  // callback or effect. Maintains the bidirectional maps and keeps the
  // observers in sync.
  const register = useCallback(
    (id: string, node: HTMLElement | null): void => {
      const oldNode = idToNodeRef.current.get(id);
      const intersection = intersectionObserverRef.current;
      const exit = exitObserverRef.current;
      const resize = resizeObserverRef.current;

      if (oldNode && oldNode !== node) {
        if (intersection) intersection.unobserve(oldNode);
        if (exit) exit.unobserve(oldNode);
        if (resize) resize.unobserve(oldNode);
        nodeToIdRef.current.delete(oldNode);
      }

      if (node) {
        idToNodeRef.current.set(id, node);
        nodeToIdRef.current.set(node, id);
        // Ensure observers exist (container may mount after first register).
        if (!intersection || !exit || !resize) {
          rebuildObservers();
        }
        intersectionObserverRef.current?.observe(node);
        exitObserverRef.current?.observe(node);
        resizeObserverRef.current?.observe(node);

        // Eagerly measure and cache the height so that when the
        // IntersectionObserver's first batch virtualizes off-screen messages,
        // their placeholders already carry the real height instead of the 80px
        // default. This prevents a one-time scrollHeight collapse (and the
        // associated view jump) the first time virtualization kicks in.
        //
        // Measurements are batched into a single requestAnimationFrame so that
        // mounting N messages does not trigger N synchronous layout reads
        // (layout thrashing). The rAF runs after all ref callbacks in the
        // current commit batch have fired, so the browser only performs one
        // layout pass for the whole batch.
        //
        // 占位符没有真实内容高度可测（inline height 即缓存/默认值）：把
        // 80px 写进缓存还会占用 200ms 节流窗口，随后反虚拟化的 resize 事件
        // 被整条丢弃，缓存永久停在 80px，该消息每次进出 buffer 都造成文档
        // 高度剧变（慢滚跳变的根源）。真实高度交由反虚拟化后的
        // ResizeObserver 首次写入，不经过节流。
        if (!lastMeasureAtRef.current.has(id)) {
          if (measureRafRef.current === 0) {
            measureRafRef.current = requestAnimationFrame(() => {
              measureRafRef.current = 0;
              const pending: Array<[string, number]> = [];
              for (const [mid, mnode] of idToNodeRef.current) {
                if (mnode.classList.contains("is-placeholder")) continue;
                if (lastMeasureAtRef.current.has(mid)) continue;
                const height = mnode.getBoundingClientRect().height;
                if (height > 0) {
                  lastMeasureAtRef.current.set(mid, Date.now());
                  pending.push([mid, height]);
                }
              }
              updateHeights(pending);
            });
          }
        }
      } else {
        idToNodeRef.current.delete(id);
        forceVisibleIdsRef.current.delete(id);
      }
    },
    [rebuildObservers, updateHeights],
  );

  // Final teardown on unmount.
  useEffect(() => {
    return () => {
      if (measureRafRef.current !== 0) {
        cancelAnimationFrame(measureRafRef.current);
        measureRafRef.current = 0;
      }
      nodeToIdRef.current.clear();
      idToNodeRef.current.clear();
      lastMeasureAtRef.current.clear();
      nearIdsRef.current.clear();
      farIdsRef.current.clear();
      forceVisibleIdsRef.current.clear();
    };
  }, []);

  // Stable object reference. Only changes when visibleIds or heights actually
  // change (state identity). register is already useCallback-stable. This is
  // critical for VirtualizedMessage's React.memo: without it, every render of
  // ChatMessageList would create a new `virtualization` object and defeat the
  // memo, causing all VirtualizedMessage instances to re-render on every
  // streaming chunk even though their visibility did not change.
  const virtualization = useMemo(
    () => ({ visibleIds, heights: heightsRef.current, register }),
    [visibleIds, register],
  );

  return virtualization;
};
