import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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
  event: MessageEvent<MarkdownRenderResponse>
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
 * Render streaming markdown with frame-aligned throttling.
 *
 * During the AI loop, `content` mutates on every streamed chunk (potentially
 * dozens of times per second). Re-rendering on every chunk janks the main
 * thread. Instead we coalesce updates to at most one render per animation
 * frame: the latest content is always used, and intermediate chunks are
 * dropped. This keeps the visible output responsive without queueing a
 * backlog of stale renders.
 *
 * The hook also tracks the latest in-flight request id so that out-of-order
 * worker responses (a slow render for chunk N completing after the fast cached
 * render for chunk N+1) never overwrite newer HTML.
 */
const useMarkdownRender = (content: string): string => {
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

    scheduledFrameRef.current = requestAnimationFrame(() => {
      scheduledFrameRef.current = null;
      const currentContent = contentRef.current;
      const requestId = nextRequestId();
      latestRequestIdRef.current = requestId;
      void renderMarkdown(currentContent).then((rendered) => {
        // Drop stale results: if a newer request superseded this one while
        // the worker was busy, keep the newer one authoritative.
        if (latestRequestIdRef.current !== requestId) {
          return;
        }
        setHtml(rendered);
      });
    });

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
    /[\\/]/.test(href) ||
    /(?:^|[\\/])[^\\/]+\.[a-zA-Z0-9]{1,12}$/.test(href)
  );
};

export const MarkdownBlock = memo(
  ({
    className,
    content,
    streaming = false,
    onFileLinkClick,
  }: {
    className: string;
    content: string;
    streaming?: boolean;
    /** 非 http(s) 文件链接点击回调：宿主（如右侧文件阅读器）用它打开新阅读器 tab。 */
    onFileLinkClick?: (href: string) => void;
  }): React.JSX.Element => {
    const html = useMarkdownRender(content);

    const containerRef = useRef<HTMLDivElement | null>(null);

    // Markdown 图片灯箱：点击图片在放大视图中查看（复用生图工具灯箱样式）。
    const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

    // Esc 关闭灯箱
    useEffect(() => {
      if (!lightboxSrc) {
        return;
      }
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
          setLightboxSrc(null);
        }
      };
      window.addEventListener("keydown", onKeyDown);
      return () => window.removeEventListener("keydown", onKeyDown);
    }, [lightboxSrc]);

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

    const handleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;

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
        ".mermaid-block"
      ) as HTMLElement | null;

      // Copy mermaid source
      if (mermaidBlock) {
        const copyBtn = target.closest(
          ".mermaid-btn-copy"
        ) as HTMLElement | null;
        if (copyBtn) {
          const raw = copyBtn.dataset.code;
          if (raw) {
            const code = decodeURIComponent(raw);
            navigator.clipboard.writeText(code).then(() => {
              copyBtn.classList.add("copied");
              window.setTimeout(
                () => copyBtn.classList.remove("copied"),
                2000
              );
            });
          }
          return;
        }

        // Toggle code / diagram view, or open export menu
        const actionBtn = target.closest(
          "[data-mermaid-action]"
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

      // --- Regular code block interactions ---
      // Handle collapse / expand toggle
      const langBtn = target.closest(".code-block-lang") as HTMLElement | null;
      if (langBtn) {
        const wrapper = langBtn.closest(".code-block-wrapper");
        if (wrapper) {
          wrapper.classList.toggle("collapsed");
        }
        return;
      }

      // Handle copy button
      const copyBtn = target.closest(".code-block-copy") as HTMLElement | null;
      if (!copyBtn) return;

      const raw = copyBtn.dataset.code;
      if (!raw) return;

      const code = decodeURIComponent(raw);
      navigator.clipboard.writeText(code).then(() => {
        copyBtn.classList.add("copied");
        window.setTimeout(() => copyBtn.classList.remove("copied"), 2000);
      });
    }, [onFileLinkClick]);

    return (
      <>
        <div
          className={className}
          dangerouslySetInnerHTML={{ __html: html }}
          onClick={handleClick}
          onAuxClick={handleClick}
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
              document.body
            )
          : null}
      </>
    );
  }
);

MarkdownBlock.displayName = "MarkdownBlock";
