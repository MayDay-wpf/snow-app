import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
 * buffer margin) using a single shared IntersectionObserver. Components can
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

/** 消息进入视口（挂载真实内容）的距离门槛。 */
const VIEWPORT_ENTER_BUFFER_PX = 600;

/** 消息卸载为占位符的距离门槛。必须大于挂载门槛构成迟滞带：消息进入
 *  600px 内挂载、滚出 900px 外才卸载，600~900px 带内集合状态保持不变，
 *  边界往复滚动与视口小幅变化（输入框增高等）都不会触发装卸翻转。
 *  此前进入/离开阈值方向颠倒（900 进 300 出）造成带内反复装卸振荡。 */
const VIEWPORT_LEAVE_BUFFER_PX = 900;

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
 * @returns Virtualization API: `visibleIds`, `heights`, `register`.
 */
export const useViewportVirtualization = (
  scrollContainerRef: React.RefObject<HTMLDivElement | null>,
  pinnedIds: ReadonlySet<string>,
  initialVisibleIds?: ReadonlySet<string> | null,
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
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(
    () => new Map<string, number>(),
  );

  // Shared observers, lazily created once the scroll container is available.
  // 进入/离开使用两个阈值不同的 observer 构成迟滞带（见
  // VIEWPORT_ENTER_BUFFER_PX / VIEWPORT_LEAVE_BUFFER_PX 注释）。
  const intersectionEnterObserverRef = useRef<IntersectionObserver | null>(
    null,
  );
  const intersectionLeaveObserverRef = useRef<IntersectionObserver | null>(
    null,
  );
  const resizeObserverRef = useRef<ResizeObserver | null>(null);

  // Bidirectional maps so we can clean up either by node or by id.
  const nodeToIdRef = useRef<Map<HTMLElement, string>>(new Map());
  const idToNodeRef = useRef<Map<string, HTMLElement>>(new Map());
  // id -> last measured timestamp, for throttling height writes.
  const lastMeasureAtRef = useRef<Map<string, number>>(new Map());
  // id -> 最近一次同步观测高度（RO 回调内逐次更新、不节流），作为视口
  // 锚定补偿的高度变化基准。与节流的 heights state（占位符高度来源）
  // 分开维护：补偿必须逐次拿到精确 delta，不能被节流丢帧。
  const lastSyncedHeightRef = useRef<Map<string, number>>(new Map());
  // rAF id for the eager-measure batch. Non-zero while a batch is pending.
  const measureRafRef = useRef(0);
  // Live set of ids currently intersecting the viewport. Mutated in place in
  // the observer callback; a shallow copy is pushed to state when it changes.
  const intersectingIdsRef = useRef<Set<string>>(new Set());
  // Current pinned ids, kept in a ref so the observer callback (which closes
  // over the ref, not the value) always reads the latest set without being
  // recreated when pinnedIds changes.
  const pinnedIdsRef = useRef<ReadonlySet<string>>(pinnedIds);
  pinnedIdsRef.current = pinnedIds;

  // Recompute the visible set from intersecting + pinned, and push to state
  // only when it actually changes.
  const flushVisibleIds = useCallback(() => {
    const next = new Set<string>(intersectingIdsRef.current);
    const pinned = pinnedIdsRef.current;
    if (pinned.size > 0) {
      for (const id of pinned) {
        next.add(id);
      }
    }
    setVisibleIds((prev) => {
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

  // IntersectionObserver callback factories. Kept stable so both the lazy
  // creation path and the container-change path share one impl each.
  // 进入侧（900px 缓冲）：只负责把消息加入可见集。
  const handleIntersectionEnter = useCallback(
    (entries: IntersectionObserverEntry[]) => {
      const intersecting = intersectingIdsRef.current;
      let changed = false;
      for (const entry of entries) {
        const id = nodeToIdRef.current.get(entry.target as HTMLElement);
        if (!id || !entry.isIntersecting) continue;
        if (!intersecting.has(id)) {
          intersecting.add(id);
          changed = true;
        }
      }
      if (changed) {
        flushVisibleIds();
      }
    },
    [flushVisibleIds],
  );

  // 离开侧（300px 缓冲）：滚出迟滞带才移出可见集并虚拟化；此时元素仍在
  // DOM 中，用交叉快照的最终高度立即写缓存（绕过 200ms 节流）。流式期间
  // 消息高度持续变化，节流缓存往往过期，占位符高度失真会让 scrollHeight
  // 突变，配合吸底滚动造成内容抖动。
  const handleIntersectionLeave = useCallback(
    (entries: IntersectionObserverEntry[]) => {
      const intersecting = intersectingIdsRef.current;
      let changed = false;
      const heightUpdates: Array<[string, number]> = [];
      for (const entry of entries) {
        const id = nodeToIdRef.current.get(entry.target as HTMLElement);
        if (!id || entry.isIntersecting) continue;
        if (intersecting.has(id)) {
          intersecting.delete(id);
          changed = true;
        }
        const finalHeight = Math.round(entry.boundingClientRect.height);
        if (finalHeight > 0) {
          lastMeasureAtRef.current.set(id, Date.now());
          heightUpdates.push([id, finalHeight]);
        }
      }
      if (changed) {
        flushVisibleIds();
      }
      if (heightUpdates.length > 0) {
        setHeights((prev) => {
          const next = new Map(prev);
          for (const [id, height] of heightUpdates) {
            next.set(id, height);
          }
          return next;
        });
      }
    },
    [flushVisibleIds],
  );

  // ResizeObserver callback factory.
  const handleResize = useCallback((entries: ResizeObserverEntry[]) => {
    const now = Date.now();
    const updates: Array<[string, number]> = [];
    const root = scrollContainerRef.current;
    const rootTop = root ? root.getBoundingClientRect().top : 0;
    for (const entry of entries) {
      const node = entry.target as HTMLElement;
      const id = nodeToIdRef.current.get(node);
      if (!id) continue;
      const height = Math.round(entry.contentRect.height);
      if (height <= 0) continue;

      // 视口锚定补偿：元素整体位于滚动容器视口顶上方时，其高度变化
      // （占位符切换、markdown worker 异步渲染就绪后从塌缩高度撑开等）
      // 会把视口内的内容整体推移，表现为滚动位置漂移与大片空白。同步
      // 把变化量写入 scrollTop，保持视口内内容的视觉位置稳定。横跨
      // 视口顶部的元素不补偿——变化可能就发生在可见区域内，无法推断
      // 用户阅读锚点。滚动吸底时 keepAtBottomSync 随后仍会贴底，不冲突。
      const prevHeight = lastSyncedHeightRef.current.get(id);
      lastSyncedHeightRef.current.set(id, height);
      if (
        root &&
        prevHeight != null &&
        prevHeight !== height &&
        entry.contentRect.top + height <= rootTop + 2
      ) {
        root.scrollTop += height - prevHeight;
      }

      // Throttle per-id writes so streaming bursts (which fire ResizeObserver
      // on every chunk) do not flood state updates.
      const lastAt = lastMeasureAtRef.current.get(id) ?? 0;
      if (now - lastAt < HEIGHT_MEASURE_THROTTLE_MS) continue;
      lastMeasureAtRef.current.set(id, now);
      updates.push([id, height]);
    }
    if (updates.length > 0) {
      setHeights((prev) => {
        const next = new Map(prev);
        for (const [id, h] of updates) {
          next.set(id, h);
        }
        return next;
      });
    }
  }, []);

  // (Re)build the observers against the current scroll container and re-observe
  // all currently registered nodes. Called on mount and whenever the container
  // element identity changes.
  const rebuildObservers = useCallback(() => {
    const root = scrollContainerRef.current;
    if (!root) return;

    intersectionEnterObserverRef.current?.disconnect();
    intersectionLeaveObserverRef.current?.disconnect();
    resizeObserverRef.current?.disconnect();
    intersectingIdsRef.current.clear();

    const enter = new IntersectionObserver(handleIntersectionEnter, {
      root,
      rootMargin: `${VIEWPORT_ENTER_BUFFER_PX}px 0px ${VIEWPORT_ENTER_BUFFER_PX}px 0px`,
      threshold: 0,
    });
    const leave = new IntersectionObserver(handleIntersectionLeave, {
      root,
      rootMargin: `${VIEWPORT_LEAVE_BUFFER_PX}px 0px ${VIEWPORT_LEAVE_BUFFER_PX}px 0px`,
      threshold: 0,
    });
    const resize = new ResizeObserver(handleResize);
    intersectionEnterObserverRef.current = enter;
    intersectionLeaveObserverRef.current = leave;
    resizeObserverRef.current = resize;

    for (const node of nodeToIdRef.current.keys()) {
      enter.observe(node);
      leave.observe(node);
      resize.observe(node);
    }
    // Let the observers settle asynchronously; flushVisibleIds will run from
    // the initial intersection callback batches.
  }, [
    flushVisibleIds,
    handleIntersectionEnter,
    handleIntersectionLeave,
    handleResize,
    scrollContainerRef,
  ]);

  // Rebuild when the container element identity changes. The key on
  // `.chat-area` in ChatContent forces a remount per conversation, so this
  // effect also covers switching conversations.
  useEffect(() => {
    rebuildObservers();
    return () => {
      intersectionEnterObserverRef.current?.disconnect();
      intersectionLeaveObserverRef.current?.disconnect();
      resizeObserverRef.current?.disconnect();
      intersectionEnterObserverRef.current = null;
      intersectionLeaveObserverRef.current = null;
      resizeObserverRef.current = null;
    };
  }, [rebuildObservers]);

  // Public register function. Called by each VirtualizedMessage via a ref
  // callback or effect. Maintains the bidirectional maps and keeps the
  // observers in sync.
  const register = useCallback(
    (id: string, node: HTMLElement | null): void => {
      const oldNode = idToNodeRef.current.get(id);
      const enter = intersectionEnterObserverRef.current;
      const leave = intersectionLeaveObserverRef.current;
      const resize = resizeObserverRef.current;

      if (oldNode && oldNode !== node) {
        if (enter) enter.unobserve(oldNode);
        if (leave) leave.unobserve(oldNode);
        if (resize) resize.unobserve(oldNode);
        nodeToIdRef.current.delete(oldNode);
      }

      if (node) {
        idToNodeRef.current.set(id, node);
        nodeToIdRef.current.set(node, id);
        // 重挂载（含占位符切回）清空同步高度基准：残留旧值会被当成
        // delta 误触发视口锚定补偿。首个 RO 报告（observe 后必发一次）
        // 会以当前 DOM 高度重建基准，该次报告不做补偿。
        lastSyncedHeightRef.current.delete(id);
        // Ensure observers exist (container may mount after first register).
        if (!enter || !leave || !resize) {
          rebuildObservers();
        }
        intersectionEnterObserverRef.current?.observe(node);
        intersectionLeaveObserverRef.current?.observe(node);
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
        if (!lastMeasureAtRef.current.has(id)) {
          if (measureRafRef.current === 0) {
            measureRafRef.current = requestAnimationFrame(() => {
              measureRafRef.current = 0;
              const pending: Array<[string, number]> = [];
              for (const [mid, mnode] of idToNodeRef.current) {
                if (lastMeasureAtRef.current.has(mid)) continue;
                const h = Math.round(mnode.getBoundingClientRect().height);
                if (h > 0) {
                  lastMeasureAtRef.current.set(mid, Date.now());
                  lastSyncedHeightRef.current.set(mid, h);
                  pending.push([mid, h]);
                }
              }
              if (pending.length > 0) {
                setHeights((prev) => {
                  const next = new Map(prev);
                  for (const [mid, h] of pending) {
                    next.set(mid, h);
                  }
                  return next;
                });
              }
            });
          }
        }
      } else {
        idToNodeRef.current.delete(id);
        lastSyncedHeightRef.current.delete(id);
      }
    },
    [rebuildObservers],
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
      lastSyncedHeightRef.current.clear();
      intersectingIdsRef.current.clear();
    };
  }, []);

  // Stable object reference. Only changes when visibleIds or heights actually
  // change (state identity). register is already useCallback-stable. This is
  // critical for VirtualizedMessage's React.memo: without it, every render of
  // ChatMessageList would create a new `virtualization` object and defeat the
  // memo, causing all VirtualizedMessage instances to re-render on every
  // streaming chunk even though their visibility did not change.
  const virtualization = useMemo(
    () => ({ visibleIds, heights, register }),
    [visibleIds, heights, register],
  );

  return virtualization;
};
