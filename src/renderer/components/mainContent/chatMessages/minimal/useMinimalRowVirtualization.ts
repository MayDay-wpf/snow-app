import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { MinimalRow } from "./types";

/**
 * 极简模式专用行级虚拟化。
 *
 * 与消息级虚拟化的差异：
 * - 虚拟化单元是一「行」（正文 / 工具集合标题 / 单个工具 / 授权宿主），
 *   不是整条消息，因此不会再出现一个几千像素的集合巨块；
 * - 高度缓存带「内容宽度 + 展开状态 + 流式状态」签名，宽度变化或开合后
 *   不会误用旧高度；
 * - 只有静置一段时间的高度才标记为 settle（可信），流式中的行不写可信
 *   高度，避免把中间态写进缓存；
 * - 行离开视口前同步测量一次真实高度，占位符直接使用该值，滚动条不跳；
 * - 观察器还没给出判定的新行（运行中新到的工具、刚展开的集合）一律先渲染
 *   真实内容，拿到第一次判定后才可能变成占位，不会以空白占位先露面。
 */

const VIEWPORT_BUFFER_PX = 600;
const VIEWPORT_EXIT_BUFFER_PX = 720;
/** 行高度静置多久后视为可信（异步 Markdown / 代码高亮已落地）。 */
const HEIGHT_SETTLE_MS = 350;
/** 同一行两次测量之间的最小间隔，避免流式期间频繁写缓存。 */
const HEIGHT_WRITE_THROTTLE_MS = 120;
/** 缓存条数上限：极简行粒度细，按会话累积后做一次简单裁剪。 */
const HEIGHT_CACHE_LIMIT = 4000;

/** 从未测量过的行按类型给一个保守高度，避免占位符塌成 0。 */
const DEFAULT_ROW_HEIGHTS: Record<MinimalRow["kind"], number> = {
  user: 72,
  response: 120,
  // 尾部行大多为空（非最后一条且带工具时没有操作栏）。
  "response-tail": 0,
  // 集合标题行 = 24px 标题 + 12px 与上一行的间距（非 group-start 时）。
  "tool-run-header": 36,
  "same-run-header": 24,
  // 极简工具行只有 24px 头部，没有经典风格的额外间距。
  tool: 24,
  "tool-group": 72,
  authorization: 0,
  divider: 40,
};

type HeightEntry = {
  height: number;
  width: number;
  signature: string;
  settledAt: number;
};

export type MinimalRowVirtualization = {
  /** 本行是否渲染真实内容。 */
  isVisible: (key: string) => boolean;
  register: (key: string, node: HTMLElement | null) => void;
  getPlaceholderHeight: (row: MinimalRow) => number;
};

/** 行的高度受哪些状态影响：宽度之外还包含开合与流式。 */
const rowSignature = (row: MinimalRow): string => {
  switch (row.kind) {
    case "response":
      return `response:${row.message.status ?? ""}`;
    case "response-tail":
      return `tail:${row.message.status ?? ""}:${row.showActions ? "actions" : ""}:${
        row.message.isRetrying ? "retry" : ""
      }:${row.runTailIsSending ? "tail-stream" : ""}`;
    case "tool-run-header":
    case "same-run-header":
      return `${row.kind}:${row.expanded ? "open" : "closed"}`;
    default:
      return row.kind;
  }
};

const isStreamingRow = (row: MinimalRow): boolean =>
  (row.kind === "response" && row.message.status === "sending") ||
  (row.kind === "response-tail" &&
    (row.message.status === "sending" || Boolean(row.runTailIsSending)));

export const useMinimalRowVirtualization = (
  scrollContainerRef: React.RefObject<HTMLDivElement | null>,
  rows: readonly MinimalRow[],
  pinnedKeys: ReadonlySet<string>,
  initialVisibleKeys?: ReadonlySet<string> | null,
): MinimalRowVirtualization => {
  const [visibleKeys, setVisibleKeys] = useState<ReadonlySet<string> | null>(
    () => initialVisibleKeys ?? null,
  );

  const heightsRef = useRef<Map<string, HeightEntry>>(new Map());
  const rowsByKeyRef = useRef<Map<string, MinimalRow>>(new Map());
  const pinnedKeysRef = useRef<ReadonlySet<string>>(pinnedKeys);
  pinnedKeysRef.current = pinnedKeys;

  const rowsByKey = useMemo(
    () => new Map(rows.map((row) => [row.key, row])),
    [rows],
  );
  rowsByKeyRef.current = rowsByKey;

  const nearObserverRef = useRef<IntersectionObserver | null>(null);
  const farObserverRef = useRef<IntersectionObserver | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);

  const nodeToKeyRef = useRef<Map<HTMLElement, string>>(new Map());
  const keyToNodeRef = useRef<Map<string, HTMLElement>>(new Map());
  const nearKeysRef = useRef<Set<string>>(new Set());
  const farKeysRef = useRef<Set<string>>(new Set());
  const lastMeasureAtRef = useRef<Map<string, number>>(new Map());
  const settleTimersRef = useRef<Map<string, number>>(new Map());
  const measureRafRef = useRef(0);
  // 已拿到观察器判定的行。不在其中的行视为「新行」，先渲染真实内容。
  const seenKeysRef = useRef<Set<string>>(new Set());
  // 初始窗口生效时，窗口外的既有行按「已判定」处理，保持首帧不全量渲染。
  const seededRef = useRef(false);
  if (!seededRef.current && initialVisibleKeys && initialVisibleKeys.size > 0) {
    seededRef.current = true;
    for (const row of rows) {
      seenKeysRef.current.add(row.key);
    }
  }

  const visibleKeysRef = useRef<ReadonlySet<string> | null>(visibleKeys);
  visibleKeysRef.current = visibleKeys;

  const currentWidth = useCallback(
    (): number => Math.round(scrollContainerRef.current?.clientWidth ?? 0),
    [scrollContainerRef],
  );

  const writeHeight = useCallback(
    (key: string, height: number, settled: boolean): void => {
      if (height <= 0) return;
      const row = rowsByKeyRef.current.get(key);
      if (!row) return;
      const cache = heightsRef.current;
      cache.set(key, {
        height,
        width: currentWidth(),
        signature: rowSignature(row),
        settledAt: settled ? Date.now() : 0,
      });
      if (cache.size > HEIGHT_CACHE_LIMIT) {
        const overflow = cache.size - HEIGHT_CACHE_LIMIT;
        let removed = 0;
        for (const cacheKey of cache.keys()) {
          cache.delete(cacheKey);
          removed += 1;
          if (removed >= overflow) break;
        }
      }
    },
    [currentWidth],
  );

  /**
   * 重算可见集。force：本批有行第一次拿到判定——即使集合内容不变也要换新
   * 引用触发重渲染，让这些行按判定结果切到真实内容或占位。
   */
  const flushVisibleKeys = useCallback((force = false): void => {
    setVisibleKeys((prev) => {
      const next = new Set<string>(nearKeysRef.current);
      if (prev !== null) {
        for (const key of prev) {
          if (farKeysRef.current.has(key)) {
            next.add(key);
          }
        }
      }
      for (const key of pinnedKeysRef.current) {
        next.add(key);
      }
      if (prev === null || force) return next;
      if (prev.size === next.size) {
        let same = true;
        for (const key of prev) {
          if (!next.has(key)) {
            same = false;
            break;
          }
        }
        if (same) return prev;
      }
      return next;
    });
  }, []);

  useLayoutEffect(() => {
    const current = visibleKeysRef.current;
    if (current === null) {
      // 首次挂载时行列表可能还是空的（历史尚未落地）：等初始窗口真正
      // 可用后，在 paint 前补上，避免第一帧把整段真实内容全部铺开。
      if (initialVisibleKeys && initialVisibleKeys.size > 0) {
        setVisibleKeys(new Set(initialVisibleKeys));
      }
      return;
    }
    let missing = false;
    for (const key of pinnedKeys) {
      if (!current.has(key)) {
        missing = true;
        break;
      }
    }
    if (missing) {
      flushVisibleKeys();
    }
  }, [pinnedKeys, initialVisibleKeys, flushVisibleKeys]);

  const applyEntries = useCallback(
    (
      targets: Set<string>,
      entries: IntersectionObserverEntry[],
      measureOnExit: boolean,
    ): void => {
      const container = scrollContainerRef.current;
      if (!container) return;
      let changed = false;
      let firstVerdict = false;
      for (const entry of entries) {
        const node = entry.target as HTMLElement;
        const key = nodeToKeyRef.current.get(node);
        if (!key || !container.contains(node)) continue;
        if (!seenKeysRef.current.has(key)) {
          seenKeysRef.current.add(key);
          firstVerdict = true;
        }
        if (entry.isIntersecting) {
          if (!targets.has(key)) {
            targets.add(key);
            changed = true;
          }
          continue;
        }
        if (targets.delete(key)) {
          changed = true;
        }
        if (measureOnExit && !node.classList.contains("is-placeholder")) {
          const height = node.getBoundingClientRect().height;
          if (height > 0) {
            lastMeasureAtRef.current.set(key, Date.now());
            writeHeight(key, height, false);
          }
        }
      }
      if (changed || firstVerdict) {
        flushVisibleKeys(firstVerdict);
      }
    },
    [flushVisibleKeys, scrollContainerRef, writeHeight],
  );

  const scheduleSettleWrite = useCallback(
    (key: string, height: number): void => {
      const timers = settleTimersRef.current;
      const existing = timers.get(key);
      if (existing !== undefined) {
        window.clearTimeout(existing);
      }
      const timer = window.setTimeout(() => {
        timers.delete(key);
        const row = rowsByKeyRef.current.get(key);
        // 流式行的高度在结束前都不可信；只写临时高度，不标记 settle。
        writeHeight(key, height, row ? !isStreamingRow(row) : false);
      }, HEIGHT_SETTLE_MS);
      timers.set(key, timer);
    },
    [writeHeight],
  );

  const handleResize = useCallback(
    (entries: ResizeObserverEntry[]): void => {
      const now = Date.now();
      for (const entry of entries) {
        const node = entry.target as HTMLElement;
        if (node.classList.contains("is-placeholder")) continue;
        const key = nodeToKeyRef.current.get(node);
        if (!key) continue;
        const lastAt = lastMeasureAtRef.current.get(key) ?? 0;
        if (now - lastAt < HEIGHT_WRITE_THROTTLE_MS) continue;
        const height =
          entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height;
        if (height <= 0) continue;
        lastMeasureAtRef.current.set(key, now);
        writeHeight(key, height, false);
        scheduleSettleWrite(key, height);
      }
    },
    [scheduleSettleWrite, writeHeight],
  );

  const rebuildObservers = useCallback((): void => {
    const root = scrollContainerRef.current;
    if (!root) return;

    nearObserverRef.current?.disconnect();
    farObserverRef.current?.disconnect();
    resizeObserverRef.current?.disconnect();
    nearKeysRef.current.clear();
    farKeysRef.current.clear();

    const near = new IntersectionObserver(
      (entries) => applyEntries(nearKeysRef.current, entries, false),
      {
        root,
        rootMargin: `${VIEWPORT_BUFFER_PX}px 0px ${VIEWPORT_BUFFER_PX}px 0px`,
        threshold: 0,
      },
    );
    const far = new IntersectionObserver(
      (entries) => applyEntries(farKeysRef.current, entries, true),
      {
        root,
        rootMargin: `${VIEWPORT_EXIT_BUFFER_PX}px 0px ${VIEWPORT_EXIT_BUFFER_PX}px 0px`,
        threshold: 0,
      },
    );
    const resize = new ResizeObserver(handleResize);
    nearObserverRef.current = near;
    farObserverRef.current = far;
    resizeObserverRef.current = resize;

    for (const node of nodeToKeyRef.current.keys()) {
      near.observe(node);
      far.observe(node);
      resize.observe(node);
    }
  }, [applyEntries, handleResize, scrollContainerRef]);

  useEffect(() => {
    rebuildObservers();
    return () => {
      nearObserverRef.current?.disconnect();
      farObserverRef.current?.disconnect();
      resizeObserverRef.current?.disconnect();
      nearObserverRef.current = null;
      farObserverRef.current = null;
      resizeObserverRef.current = null;
    };
  }, [rebuildObservers]);

  const register = useCallback(
    (key: string, node: HTMLElement | null): void => {
      const oldNode = keyToNodeRef.current.get(key);
      const near = nearObserverRef.current;
      const far = farObserverRef.current;
      const resize = resizeObserverRef.current;

      if (oldNode && oldNode !== node) {
        near?.unobserve(oldNode);
        far?.unobserve(oldNode);
        resize?.unobserve(oldNode);
        nodeToKeyRef.current.delete(oldNode);
      }

      if (node) {
        keyToNodeRef.current.set(key, node);
        nodeToKeyRef.current.set(node, key);
        if (!near || !far || !resize) {
          rebuildObservers();
        }
        nearObserverRef.current?.observe(node);
        farObserverRef.current?.observe(node);
        resizeObserverRef.current?.observe(node);

        // 首次挂载批量测量：一帧内只做一次布局读取，占位符从一开始就带
        // 真实高度，避免第一次虚拟化时整列塌缩再撑开。
        if (!lastMeasureAtRef.current.has(key)) {
          if (measureRafRef.current === 0) {
            measureRafRef.current = requestAnimationFrame(() => {
              measureRafRef.current = 0;
              const now = Date.now();
              for (const [measuredKey, measuredNode] of keyToNodeRef.current) {
                if (measuredNode.classList.contains("is-placeholder")) continue;
                if (lastMeasureAtRef.current.has(measuredKey)) continue;
                const height = measuredNode.getBoundingClientRect().height;
                if (height <= 0) continue;
                lastMeasureAtRef.current.set(measuredKey, now);
                writeHeight(measuredKey, height, false);
              }
            });
          }
        }
      } else {
        // 行从列表移除（集合收起、消息删除）：再次出现时按新行对待，
        // 先渲染真实内容，避免重新展开时先闪一帧空白占位。
        keyToNodeRef.current.delete(key);
        seenKeysRef.current.delete(key);
        nearKeysRef.current.delete(key);
        farKeysRef.current.delete(key);
      }
    },
    [rebuildObservers, writeHeight],
  );

  const isVisible = useCallback(
    (key: string): boolean =>
      visibleKeys === null ||
      visibleKeys.has(key) ||
      !seenKeysRef.current.has(key),
    [visibleKeys],
  );

  const getPlaceholderHeight = useCallback(
    (row: MinimalRow): number => {
      const entry = heightsRef.current.get(row.key);
      if (
        entry &&
        entry.width === currentWidth() &&
        entry.signature === rowSignature(row)
      ) {
        return entry.height;
      }
      return DEFAULT_ROW_HEIGHTS[row.kind];
    },
    [currentWidth],
  );

  useEffect(() => {
    return () => {
      if (measureRafRef.current !== 0) {
        cancelAnimationFrame(measureRafRef.current);
        measureRafRef.current = 0;
      }
      for (const timer of settleTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      settleTimersRef.current.clear();
      nodeToKeyRef.current.clear();
      keyToNodeRef.current.clear();
      lastMeasureAtRef.current.clear();
      nearKeysRef.current.clear();
      farKeysRef.current.clear();
      seenKeysRef.current.clear();
    };
  }, []);

  return { isVisible, register, getPlaceholderHeight };
};
