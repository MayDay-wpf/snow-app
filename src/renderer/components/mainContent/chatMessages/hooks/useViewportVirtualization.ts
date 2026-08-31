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

/** Extra pixels above/below the viewport that stay rendered, so fast scrolls
 *  do not flash empty placeholders before the observer catches up. */
const VIEWPORT_BUFFER_PX = 600;

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
  initialVisibleIds?: ReadonlySet<string> | null
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
    () => initialVisibleIds ?? null
  );
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(
    () => new Map<string, number>()
  );

  // Shared observers, lazily created once the scroll container is available.
  const intersectionObserverRef = useRef<IntersectionObserver | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);

  // Bidirectional maps so we can clean up either by node or by id.
  const nodeToIdRef = useRef<Map<HTMLElement, string>>(new Map());
  const idToNodeRef = useRef<Map<string, HTMLElement>>(new Map());
  // id -> last measured timestamp, for throttling height writes.
  const lastMeasureAtRef = useRef<Map<string, number>>(new Map());
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

  // IntersectionObserver callback factory. Kept as a stable function so both
  // the lazy creation path and the container-change path share one impl.
  const handleIntersection = useCallback(
    (entries: IntersectionObserverEntry[]) => {
      const intersecting = intersectingIdsRef.current;
      let changed = false;
      for (const entry of entries) {
        const id = nodeToIdRef.current.get(entry.target as HTMLElement);
        if (!id) continue;
        if (entry.isIntersecting) {
          if (!intersecting.has(id)) {
            intersecting.add(id);
            changed = true;
          }
        } else {
          if (intersecting.has(id)) {
            intersecting.delete(id);
            changed = true;
          }
        }
      }
      if (changed) {
        flushVisibleIds();
      }
    },
    [flushVisibleIds]
  );

  // ResizeObserver callback factory.
  const handleResize = useCallback((entries: ResizeObserverEntry[]) => {
    const now = Date.now();
    const updates: Array<[string, number]> = [];
    for (const entry of entries) {
      const node = entry.target as HTMLElement;
      const id = nodeToIdRef.current.get(node);
      if (!id) continue;
      // Throttle per-id writes so streaming bursts (which fire ResizeObserver
      // on every chunk) do not flood state updates.
      const lastAt = lastMeasureAtRef.current.get(id) ?? 0;
      if (now - lastAt < HEIGHT_MEASURE_THROTTLE_MS) continue;
      lastMeasureAtRef.current.set(id, now);
      const height = Math.round(entry.contentRect.height);
      if (height <= 0) continue;
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

    intersectionObserverRef.current?.disconnect();
    resizeObserverRef.current?.disconnect();
    intersectingIdsRef.current.clear();

    const intersection = new IntersectionObserver(handleIntersection, {
      root,
      rootMargin: `${VIEWPORT_BUFFER_PX}px 0px ${VIEWPORT_BUFFER_PX}px 0px`,
      threshold: 0,
    });
    const resize = new ResizeObserver(handleResize);
    intersectionObserverRef.current = intersection;
    resizeObserverRef.current = resize;

    for (const node of nodeToIdRef.current.keys()) {
      intersection.observe(node);
      resize.observe(node);
    }
    // Let the observer settle asynchronously; flushVisibleIds will run from
    // the initial intersection callback batch.
  }, [flushVisibleIds, handleIntersection, handleResize, scrollContainerRef]);

  // Rebuild when the container element identity changes. The key on
  // `.chat-area` in ChatContent forces a remount per conversation, so this
  // effect also covers switching conversations.
  useEffect(() => {
    rebuildObservers();
    return () => {
      intersectionObserverRef.current?.disconnect();
      resizeObserverRef.current?.disconnect();
      intersectionObserverRef.current = null;
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
      const resize = resizeObserverRef.current;

      if (oldNode && oldNode !== node) {
        if (intersection) intersection.unobserve(oldNode);
        if (resize) resize.unobserve(oldNode);
        nodeToIdRef.current.delete(oldNode);
      }

      if (node) {
        idToNodeRef.current.set(id, node);
        nodeToIdRef.current.set(node, id);
        // Ensure observers exist (container may mount after first register).
        if (!intersection || !resize) {
          rebuildObservers();
        }
        intersectionObserverRef.current?.observe(node);
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
      }
    },
    [rebuildObservers]
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
    [visibleIds, heights, register]
  );

  return virtualization;
};
