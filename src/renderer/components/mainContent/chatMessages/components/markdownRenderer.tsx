import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Download } from "lucide-react";
import "katex/dist/katex.min.css";
import MarkdownWorker from "./markdownWorker?worker";
import type {
  MarkdownRenderRequest,
  MarkdownRenderResponse,
} from "./markdownWorker";
import {
  injectCachedDiagrams,
  openExportMenu,
  openMermaidImageViewer,
  renderMermaidBlocks,
  setMermaidView,
  watchThemeForMermaid,
} from "./mermaidRenderer";
import { rightPanelEvents } from "../../../rightPanel/rightPanelEvents";
import { downloadImageSrc } from "../../../../utils/imageDownload";
import { useEscapeKey } from "../../../../hooks/useEscapeKey";
import { Tooltip } from "../../../common/Tooltip";

/**
 * Singleton Web Worker that performs markdown-it + highlight.js rendering off
 * the main thread. Shared by every MarkdownBlock instance so that cache state
 * (worker-side LRU) is preserved across the whole conversation.
 *
 * The worker is lazily created on first use to avoid paying the spawn cost for
 * conversations that never render markdown (e.g. an empty chat).
 */
let workerSingleton: Worker | null = null;

/**
 * Lazily create the shared markdown worker and attach a single global
 * `onmessage` listener that routes responses back to the pending request map.
 * A single listener is preferable to per-request `{ once: true }` listeners,
 * which would accumulate between dispatch and response when many frames are
 * in flight during a burst of streaming chunks.
 */
const getMarkdownWorker = (): Worker => {
  if (!workerSingleton) {
    const worker = new MarkdownWorker();
    worker.addEventListener("message", handleWorkerMessage as EventListener);
    workerSingleton = worker;
  }
  return workerSingleton;
};

/**
 * Monotonic request id used to correlate worker responses with the latest
 * content dispatched from a hook instance. A single shared counter is fine:
 * ids only need to be unique within the worker round-trip window, and using a
 * shared counter avoids per-instance state in the dispatch loop.
 */
let sharedRequestId = 0;
const nextRequestId = (): number => ++sharedRequestId;

/**
 * Pending request registry. Keyed by request id so the global worker
 * `onmessage` handler can route the response back to the originating hook.
 * Entries are self-removing on resolve to avoid leaks.
 */
type PendingEntry = {
  resolve: (html: string) => void;
};
const pendingRequests = new Map<number, PendingEntry>();

const handleWorkerMessage = (
  event: MessageEvent<MarkdownRenderResponse>,
): void => {
  const { id, html } = event.data;
  const entry = pendingRequests.get(id);
  if (entry) {
    pendingRequests.delete(id);
    entry.resolve(html);
  }
};

const dispatchRender = (content: string): Promise<string> => {
  const worker = getMarkdownWorker();
  const id = nextRequestId();
  return new Promise<string>((resolve) => {
    pendingRequests.set(id, { resolve });
    const request: MarkdownRenderRequest = { id, content };
    worker.postMessage(request);
  });
};

/**
 * Module-level LRU cache for rendered HTML. The worker already keeps its own
 * cache, but this mirror lets the React layer satisfy cache hits without any
 * postMessage round-trip at all — critical for the fast-path where a memoized
 * MarkdownBlock re-renders with identical content (e.g. a finalized message
 * that re-enters the viewport under content-visibility).
 *
 * Capped at the same size as the worker cache for parity.
 */
const CACHE_MAX_ENTRIES = 64;
const htmlCache = new Map<string, string>();

const cacheGet = (key: string): string | undefined => {
  const value = htmlCache.get(key);
  if (value !== undefined) {
    htmlCache.delete(key);
    htmlCache.set(key, value);
  }
  return value;
};

const cacheSet = (key: string, value: string): void => {
  if (htmlCache.size >= CACHE_MAX_ENTRIES) {
    const oldestKey = htmlCache.keys().next().value;
    if (oldestKey !== undefined) {
      htmlCache.delete(oldestKey);
    }
  }
  htmlCache.set(key, value);
};

/**
 * Fetch rendered HTML for `content`, using the main-thread cache first and
 * falling back to the worker. Resolved values are written back into the cache
 * so subsequent identical content is free.
 */
const renderMarkdown = async (content: string): Promise<string> => {
  const cached = cacheGet(content);
  if (cached !== undefined) {
    return cached;
  }
  const html = await dispatchRender(content);
  cacheSet(content, html);
  return html;
};

/**
 * 预热一批 markdown 渲染结果（翻页加载旧消息时使用）。
 *
 * MarkdownBlock 挂载时若缓存未命中，首帧以空 html 渲染，worker 返回后
 * 内容才涌入——新插入消息的高度因此经历「近空白 → 真实高度」的剧变。
 * 分页加载的滚动恢复若在这个窗口期按偏小的 scrollHeight 补偿 scrollTop，
 * 视口位置必然错位，随后涌入的内容再推挤视口，表现为滚动位置跳变。
 * 翻页前先把渲染结果写进缓存，新消息挂载首帧即为最终高度。
 *
 * 带整体超时保护：worker 单例在流式输出期间被持续占用，预热请求可能
 * 排队很久；超时后放弃等待（已在途的渲染仍会写缓存），调用方照常
 * 渲染消息，不要让翻页卡死在预热上。
 */
export const prefetchMarkdown = async (
  contents: string[],
  timeoutMs = 1500,
): Promise<void> => {
  const pending = contents.filter(
    (content) => content && !htmlCache.has(content),
  );
  if (pending.length === 0) {
    return;
  }
  await Promise.race([
    Promise.allSettled(pending.map((content) => renderMarkdown(content))),
    new Promise<void>((resolve) => {
      setTimeout(resolve, timeoutMs);
    }),
  ]);
};

/**
 * 流式柔和渐显使用的 CSS 类：每帧新增的文本被包进带该类名的 span，
 * 通过 opacity 动画从透明柔和浮现，替代打字机式的整块跳变。
 */
const MD_STREAM_FADE_CLASS = "md-stream-fade-in";

/** 深度优先找到 DOM 树中最后一个非空文本节点（流式新增内容的锚点）。 */
const findLastNonEmptyTextNode = (root: Node): Text | null => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let last: Text | null = null;
  let current: Node | null;
  while ((current = walker.nextNode())) {
    const text = current as Text;
    if (text.nodeValue && text.nodeValue.trim().length > 0) {
      last = text;
    }
  }
  return last;
};

/**
 * 流式渲染最小间隔（ms）。
 *
 * 流式期间 content 每 chunk 都在变，长文本的 markdown 全量解析 + DOM 整块
 * 替换是流式高 CPU 的主因：若每帧（60fps）渲染一次，几万字内容每秒解析
 * 60 次，worker 与合成器双双打满。降到 10fps 后视觉无感（流式文本本身
 * 就在滚动），解析/布局/合成开销降低约 6 倍。
 */
const MIN_RENDER_INTERVAL_MS = 100;
/** 超长文本（>= 100KB）的流式渲染间隔：一次 markdown-it 全量解析可达
 *  200ms+，10fps 时 worker 依然吃满；3fps 对滚动中的流式文本无感。 */
const LONG_TEXT_THRESHOLD = 100_000;
const LONG_TEXT_INTERVAL_MS = 300;

/**
 * Render streaming markdown with frame-aligned throttling.
 *
 * During the AI loop, `content` mutates on every streamed chunk (potentially
 * dozens of times per second). Re-rendering on every chunk janks the main
 * thread. Instead we coalesce updates to at most one render per animation
 * frame: the latest content is always used, and intermediate chunks are
 * dropped. This keeps the visible output responsive without queueing a
 * backlog of stale renders.
 *
 * 在帧合并之上叠加最小间隔节流：距上次实际渲染不足
 * MIN_RENDER_INTERVAL_MS 时继续推迟到下一帧检查（内容持续变化时自然合并
 * 到 10fps），内容稳定后最多多等一个间隔即输出最终结果。
 *
 * The hook also tracks the latest in-flight request id so that out-of-order
 * worker responses (a slow render for chunk N completing after the fast cached
 * render for chunk N+1) never overwrite newer HTML.
 */
const useMarkdownRender = (content: string, minIntervalMs?: number): string => {
  // 未显式指定时按内容长度自适应：超长文本自动降频，避免 worker 打满。
  const effectiveIntervalMs =
    minIntervalMs ??
    (content.length >= LONG_TEXT_THRESHOLD
      ? LONG_TEXT_INTERVAL_MS
      : MIN_RENDER_INTERVAL_MS);
  const [html, setHtml] = useState<string>(() => {
    // Warm the state synchronously from the cache when possible so that the
    // first paint after mount is not blank while the worker warms up.
    return htmlCache.get(content) ?? "";
  });

  // Holds the latest content so the rAF callback always reads the newest
  // value without re-subscribing on every change.
  const contentRef = useRef(content);
  contentRef.current = content;

  // Tracks the request id of the most recent dispatch so that a late worker
  // response for a previous chunk cannot clobber a fresher one.
  const latestRequestIdRef = useRef(0);
  // Non-null while a frame is scheduled; used to dedupe rAF requests.
  const scheduledFrameRef = useRef<number | null>(null);
  // Timestamp of the last time a render result was committed to state.
  const lastRenderAtRef = useRef(0);

  useEffect(() => {
    // Fast path: synchronous cache hit — no frame scheduling needed.
    const cached = htmlCache.get(content);
    if (cached !== undefined) {
      latestRequestIdRef.current = 0;
      setHtml(cached);
      return;
    }

    if (scheduledFrameRef.current !== null) {
      return;
    }

    const runRender = (): void => {
      // Throttle: if the minimum interval has not elapsed since the last
      // commit, defer to the next frame and re-check. While content keeps
      // changing (streaming), this naturally coalesces to ~10fps; once it
      // stabilizes, the final render fires within one interval.
      if (performance.now() - lastRenderAtRef.current < effectiveIntervalMs) {
        scheduledFrameRef.current = requestAnimationFrame(runRender);
        return;
      }
      const currentContent = contentRef.current;
      const requestId = nextRequestId();
      latestRequestIdRef.current = requestId;
      void renderMarkdown(currentContent).then((rendered) => {
        // Drop stale results: if a newer request superseded this one while
        // the worker was busy, keep the newer one authoritative.
        if (latestRequestIdRef.current !== requestId) {
          return;
        }
        lastRenderAtRef.current = performance.now();
        setHtml(rendered);
      });
    };

    scheduledFrameRef.current = requestAnimationFrame(runRender);

    return () => {
      if (scheduledFrameRef.current !== null) {
        cancelAnimationFrame(scheduledFrameRef.current);
        scheduledFrameRef.current = null;
      }
    };
  }, [content]);

  // Cancel any pending rAF on unmount. The shared worker itself is left
  // alive (singleton) so other MarkdownBlock instances keep their warm cache;
  // it is cheap to keep around and avoids re-spawn churn when switching chats.
  useEffect(() => {
    return () => {
      if (scheduledFrameRef.current !== null) {
        cancelAnimationFrame(scheduledFrameRef.current);
        scheduledFrameRef.current = null;
      }
    };
  }, []);

  return html;
};

/** 来源徽章悬停信息（fixed 坐标系 + 摘要数据）。 */
type BadgeHoverInfo = {
  x: number;
  top: number;
  width: number;
  height: number;
  title: string;
  url: string;
  summary: string;
  host: string;
};

/** favicon 加载结果缓存（按 img-proxy URL），会话内不重复探测。 */
const faviconStatusCache = new Map<string, "ok" | "fail">();

/**
 * 已注册 load/error 监听的 img。流式期间 bindFaviconFallback 随每次渲染
 * 重入，同一 img 只允许绑定一次监听，避免 once 监听器随渲染次数累积。
 */
const faviconBoundImgs = new WeakSet<HTMLImageElement>();

/** 默认显示地球占位图标，真实 favicon 加载成功才加 favicon-ok 切换显示；
 *  失败/缺失稳定回退默认图标。须在 useLayoutEffect 中调用（paint 前判定，
 *  缓存命中时 complete=true 同步确定，避免首帧闪烁）。 */
const bindFaviconFallback = (root: HTMLElement): void => {
  root
    .querySelectorAll<HTMLImageElement>("img.md-source-badge-favicon")
    .forEach((img) => {
      const badge = img.closest(".md-source-badge");
      if (!badge) {
        return;
      }
      const cached = faviconStatusCache.get(img.src);
      if (cached === "ok") {
        badge.classList.add("favicon-ok");
        return;
      }
      if (cached === "fail") {
        return;
      }
      const markLoaded = (): void => {
        faviconStatusCache.set(img.src, "ok");
        badge.classList.add("favicon-ok");
      };
      if (img.complete) {
        if (img.naturalWidth > 0) {
          markLoaded();
        } else {
          faviconStatusCache.set(img.src, "fail");
        }
        return;
      }
      // 流式重入防抖：已在等待加载结果的 img 不重复绑定监听。
      if (faviconBoundImgs.has(img)) {
        return;
      }
      faviconBoundImgs.add(img);
      img.addEventListener("load", markLoaded, { once: true });
      img.addEventListener(
        "error",
        () => {
          faviconStatusCache.set(img.src, "fail");
          // 防御：favicon-ok 已加上后本次加载仍失败（DOM 重建后重新请求），
          // 摘掉标记回退占位图标，避免出现空白图标。
          badge.classList.remove("favicon-ok");
        },
        { once: true },
      );
    });
};

/** 判断非 http(s) href 是否像本地文件链接（相对路径/绝对路径/带扩展名文件名）。 */
const isFileLinkHref = (href: string): boolean => {
  if (!href || href.length > 512 || /\s/.test(href)) {
    return false;
  }
  // 页内锚点与协议链接（mailto:/tel:/data: 等）不是文件链接；Windows 盘符（C:\）除外。
  if (href.startsWith("#")) {
    return false;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^[a-zA-Z]:[\\/]/.test(href)) {
    return false;
  }
  return (
    /[\\/]/.test(href) || /(?:^|[\\/])[^\\/]+\.[a-zA-Z0-9]{1,12}$/.test(href)
  );
};

export const MarkdownBlock = memo(
  ({
    className,
    content,
    streaming = false,
    onFileLinkClick,
    minRenderIntervalMs,
  }: {
    className: string;
    content: string;
    streaming?: boolean;
    /** 非 http(s) 文件链接点击回调：宿主（如右侧文件阅读器）用它打开新阅读器 tab。 */
    onFileLinkClick?: (href: string) => void;
    /** 流式渲染最小间隔（ms），覆盖默认 100ms。思考过程等幕后内容可传更大值。 */
    minRenderIntervalMs?: number;
  }): React.JSX.Element => {
    const html = useMarkdownRender(content, minRenderIntervalMs);

    const containerRef = useRef<HTMLDivElement | null>(null);

    // Markdown 图片灯箱：点击图片在放大视图中查看（复用生图工具灯箱样式）。
    const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

    // 来源徽章悬停 Tooltip 状态。
    const [hoverBadge, setHoverBadge] = useState<BadgeHoverInfo | null>(null);

    // 徽章悬停：收集位置与数据，渲染 Tooltip。
    const handleBadgeMouseOver = useCallback(
      (e: React.MouseEvent<HTMLDivElement>) => {
        const badge = (e.target as HTMLElement).closest(
          ".md-source-badge",
        ) as HTMLElement | null;
        if (!badge) {
          return;
        }
        const rect = badge.getBoundingClientRect();
        const url = badge.dataset.url ?? "";
        let host = "";
        try {
          host = url ? new URL(url).host : "";
        } catch {
          host = "";
        }
        setHoverBadge({
          x: rect.left + rect.width / 2,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          title: badge.dataset.title ?? "",
          url,
          summary: badge.dataset.summary ?? "",
          host,
        });
      },
      [],
    );

    // 离开徽章（含徽章内部移动）时关闭。
    const handleBadgeMouseOut = useCallback(
      (e: React.MouseEvent<HTMLDivElement>) => {
        const related = e.relatedTarget as HTMLElement | null;
        if (related?.closest?.(".md-source-badge")) {
          return;
        }
        setHoverBadge(null);
      },
      [],
    );

    // Esc 关闭灯箱（useEscapeKey 层级栈统一分派，避免与引擎/其他浮层冲突）
    useEscapeKey({
      onEscape: () => setLightboxSrc(null),
      enabled: lightboxSrc !== null,
    });

    // 流式柔和渐显：接管 innerHTML，把每帧新增的文本包进淡入 span。
    // 与整块替换（打字机式跳变）不同，旧文字保持原 DOM 稳定不动，只有
    // 新增部分做 opacity 动画从透明浮现。
    //
    // 文本层面前缀匹配：流式内容几乎总是"最后一个文本节点持续增长"
    // （段落/代码块内），命中后只增量插入 span；markdown 结构变化
    // （新标题、代码块开始、标记闭合等）时回退整块重建，新最后文本
    // 整体淡入。streaming 结束时内容已完整渲染，不重建 DOM，让最后一
    // 段动画自然完成（停止/结束时文字不会突然跳成正色）。
    const lastStreamTextRef = useRef("");
    const lastHtmlRef = useRef("");
    useLayoutEffect(() => {
      const node = containerRef.current;
      if (!node || !html) {
        return;
      }

      if (!streaming) {
        lastStreamTextRef.current = "";
        if (html !== lastHtmlRef.current) {
          node.innerHTML = html;
          lastHtmlRef.current = html;
        }
        return;
      }

      const doc = new DOMParser().parseFromString(html, "text/html");
      const newLastText = findLastNonEmptyTextNode(doc.body);
      if (!newLastText) {
        node.innerHTML = html;
        lastHtmlRef.current = html;
        return;
      }
      const fullText = newLastText.nodeValue ?? "";
      const prevText = lastStreamTextRef.current;

      // 首帧或结构变化：整块重建，并让新最后文本整体淡入。
      if (!prevText || !fullText.startsWith(prevText)) {
        node.innerHTML = html;
        lastHtmlRef.current = html;
        lastStreamTextRef.current = fullText;
        const domLastText = findLastNonEmptyTextNode(node);
        if (domLastText) {
          const span = document.createElement("span");
          span.className = MD_STREAM_FADE_CLASS;
          span.textContent = domLastText.nodeValue ?? "";
          domLastText.parentNode?.replaceChild(span, domLastText);
        }
        return;
      }

      // 尾部持续增长：在容器当前最后一个文本节点后追加淡入 span。
      const newPart = fullText.slice(prevText.length);
      lastStreamTextRef.current = fullText;
      if (newPart.trim().length === 0) {
        return;
      }
      const domLastText = findLastNonEmptyTextNode(node);
      if (domLastText?.parentNode) {
        const span = document.createElement("span");
        span.className = MD_STREAM_FADE_CLASS;
        span.textContent = newPart;
        domLastText.parentNode.insertBefore(span, domLastText.nextSibling);
      }
    }, [html, streaming]);

    // During streaming, skip all mermaid operations entirely — only the code
    // view is shown. Once streaming ends (`streaming` flips to false), both
    // phases fire in a single pass to render every diagram at once. This
    // avoids any flicker from repeatedly attempting to parse incomplete code.
    //
    // Phase 1 — synchronous cache injection (before browser paint) so that
    // already-rendered diagrams appear instantly after innerHTML replacement.
    useLayoutEffect(() => {
      if (streaming) return;
      const node = containerRef.current;
      if (node && html) {
        injectCachedDiagrams(node);
      }
    }, [html, streaming]);

    // Phase 2 — async rendering of uncached diagrams, debounced via rAF.
    useEffect(() => {
      if (streaming) return;
      const node = containerRef.current;
      if (!node || !html) return;

      const frame = requestAnimationFrame(() => {
        void renderMermaidBlocks(node);
      });
      return () => cancelAnimationFrame(frame);
    }, [html, streaming]);

    // Attach the global theme-change observer once for the whole app so that
    // diagrams re-render when the user switches between light/dark.
    useEffect(() => watchThemeForMermaid(), []);

    // favicon 状态在 paint 前确定，缓存命中同步判定，避免首帧闪烁。
    useLayoutEffect(() => {
      const node = containerRef.current;
      if (node && html) {
        bindFaviconFallback(node);
      }
    }, [html]);

    const handleClick = useCallback(
      (e: React.MouseEvent<HTMLDivElement>) => {
        const target = e.target as HTMLElement;

        // --- 来源徽章点击：在右侧面板的应用内浏览器打开来源页面 ---
        const badge = target.closest(".md-source-badge") as HTMLElement | null;
        if (badge) {
          const url = badge.dataset.url ?? "";
          if (/^https?:\/\//i.test(url)) {
            e.preventDefault();
            rightPanelEvents.emit("open-browser-tab", { url });
          }
          return;
        }

        // --- 普通链接拦截 ---
        // markdown-it 默认渲染出的 <a> 没有 target，点击会走 Electron 默认行为
        // （主进程 setWindowOpenHandler 转交系统浏览器）。这里统一拦截，改为在
        // 右侧面板的应用内浏览器中新建 tab 打开，与 WebSearchToolCall 行为一致。
        // 仅处理 http(s) 链接，非 http(s) 的（如 mailto:）保持默认行为。
        const anchor = target.closest("a") as HTMLAnchorElement | null;
        if (anchor) {
          const href = anchor.getAttribute("href") ?? "";
          if (/^https?:\/\//i.test(href)) {
            e.preventDefault();
            rightPanelEvents.emit("open-browser-tab", { url: href });
            return;
          }
          // 非 http(s) 链接：若像本地文件路径且宿主提供了回调（右侧文件阅读器），
          // 拦截默认导航（渲染进程导航到相对 URL 会直接黑屏），
          // 改为在右侧面板新建文件阅读器 tab。
          if (onFileLinkClick && isFileLinkHref(href)) {
            e.preventDefault();
            onFileLinkClick(href);
            return;
          }
        }

        // --- Markdown 图片点击放大 ---
        // 复用生图工具灯箱体验：点击图片在放大视图中查看（本地/远程图均已是
        // img-proxy:// URL）。在链接处理之后执行，保证 a 内的图片仍优先走链接逻辑。
        const image = target.closest("img") as HTMLImageElement | null;
        if (image) {
          const src = image.currentSrc || image.src;
          if (src) {
            e.preventDefault();
            setLightboxSrc(src);
            return;
          }
        }

        // --- Mermaid block interactions ---
        const mermaidBlock = target.closest(
          ".mermaid-block",
        ) as HTMLElement | null;

        // Copy mermaid source
        if (mermaidBlock) {
          const copyBtn = target.closest(
            ".mermaid-btn-copy",
          ) as HTMLElement | null;
          if (copyBtn) {
            const raw = copyBtn.dataset.code;
            if (raw) {
              const code = decodeURIComponent(raw);
              navigator.clipboard.writeText(code).then(() => {
                copyBtn.classList.add("copied");
                window.setTimeout(
                  () => copyBtn.classList.remove("copied"),
                  2000,
                );
              });
            }
            return;
          }

          // Toggle code / diagram view, or open export menu
          const actionBtn = target.closest(
            "[data-mermaid-action]",
          ) as HTMLElement | null;
          if (actionBtn) {
            const action = actionBtn.dataset.mermaidAction;
            if (action === "code" || action === "diagram") {
              setMermaidView(mermaidBlock, action);
            } else if (action === "download") {
              openExportMenu(actionBtn, mermaidBlock);
            }
            return;
          }

          // Click on the rendered diagram opens the full-size viewer.
          if (target.closest(".mermaid-view-diagram svg")) {
            openMermaidImageViewer(mermaidBlock);
            return;
          }
        }

        // --- Handoff tag（工作流交接文档折叠块）展开/收起 ---
        const handoffToggle = target.closest(
          ".md-handoff-toggle",
        ) as HTMLElement | null;
        if (handoffToggle) {
          const block = handoffToggle.closest(".md-handoff-block");
          if (block) {
            block.classList.toggle("expanded");
            handoffToggle.setAttribute(
              "aria-expanded",
              block.classList.contains("expanded") ? "true" : "false",
            );
          }
          return;
        }

        // --- Regular code block interactions ---
        // Handle collapse / expand toggle
        const langBtn = target.closest(
          ".code-block-lang",
        ) as HTMLElement | null;
        if (langBtn) {
          const wrapper = langBtn.closest(".code-block-wrapper");
          if (wrapper) {
            wrapper.classList.toggle("collapsed");
          }
          return;
        }

        // Handle copy button
        const copyBtn = target.closest(
          ".code-block-copy",
        ) as HTMLElement | null;
        if (!copyBtn) return;

        const raw = copyBtn.dataset.code;
        if (!raw) return;

        const code = decodeURIComponent(raw);
        navigator.clipboard.writeText(code).then(() => {
          copyBtn.classList.add("copied");
          window.setTimeout(() => copyBtn.classList.remove("copied"), 2000);
        });
      },
      [onFileLinkClick],
    );

    return (
      <>
        <div
          className={className}
          onClick={handleClick}
          onAuxClick={handleClick}
          onMouseOver={handleBadgeMouseOver}
          onMouseOut={handleBadgeMouseOut}
          ref={containerRef}
        />
        {lightboxSrc
          ? createPortal(
              <div
                className="tool-call-imagegen-lightbox markdown-image-lightbox"
                onClick={() => setLightboxSrc(null)}
                role="presentation"
              >
                <img
                  src={lightboxSrc}
                  alt=""
                  draggable={false}
                  onClick={(event) => event.stopPropagation()}
                />
                <div
                  className="tool-call-imagegen-lightbox-toolbar"
                  onClick={(event) => event.stopPropagation()}
                >
                  <button
                    type="button"
                    className="tool-call-imagegen-download"
                    onClick={() => {
                      void downloadImageSrc(lightboxSrc).catch((error) => {
                        console.error("[markdown] save image failed:", error);
                      });
                    }}
                    title="下载"
                    aria-label="下载"
                  >
                    <Download size={13} aria-hidden="true" />
                    下载
                  </button>
                  <button
                    type="button"
                    className="tool-call-imagegen-lightbox-close"
                    onClick={() => setLightboxSrc(null)}
                    aria-label="关闭"
                  >
                    ✕
                  </button>
                </div>
              </div>,
              document.body,
            )
          : null}

        {/* 来源徽章悬停 Tooltip（受控 visible，anchor 为 0 尺寸占位）。 */}
        {hoverBadge
          ? createPortal(
              <span
                className="md-source-tooltip-host"
                style={{ left: hoverBadge.x, top: hoverBadge.top }}
              >
                <Tooltip
                  visible
                  content={
                    <span className="md-source-tooltip">
                      <strong className="md-source-tooltip-title">
                        {hoverBadge.title}
                      </strong>
                      {hoverBadge.summary ? (
                        <span className="md-source-tooltip-summary">
                          {hoverBadge.summary}
                        </span>
                      ) : null}
                      <span className="md-source-tooltip-url">
                        {hoverBadge.host}
                      </span>
                    </span>
                  }
                >
                  <span className="md-source-badge-anchor" aria-hidden="true" />
                </Tooltip>
              </span>,
              document.body,
            )
          : null}
      </>
    );
  },
);

MarkdownBlock.displayName = "MarkdownBlock";
