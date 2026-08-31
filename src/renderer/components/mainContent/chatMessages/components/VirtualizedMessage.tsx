import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { ViewportVirtualization } from "../hooks/useViewportVirtualization";
import { VIRTUAL_PLACEHOLDER_DEFAULT_HEIGHT } from "../hooks/useViewportVirtualization";

/** 占位符切回真实内容时的高度锁定超时（ms）。正常路径内容（markdown
 *  worker 异步渲染）追上缓存高度立即释放；超时兜底内容永久矮于缓存
 *  高度的场景（如展开状态随卸载重置），避免假空白卡死。 */
const SETTLE_TIMEOUT_MS = 300;

/**
 * Viewport-virtualized wrapper for a single chat message.
 *
 * Renders children (the real AiResponse / UserMessage / CompactionMessage
 * subtree) when the message is considered visible by the virtualization hook,
 * otherwise renders a cheap placeholder div that reserves the same height.
 *
 * This is the central piece that breaks the "re-render everything on every
 * streaming chunk" cycle: off-screen messages skip their entire React subtree,
 * so MarkdownBlock reconciliation and worker dispatches only run for the few
 * messages actually in the viewport.
 *
 * Height preservation: when a message virtualizes out, its last measured
 * height is applied to the placeholder so the document height does not
 * collapse and cause scrollbar jumps. If the message was never measured
 * (e.g. it was off-screen from the very first render), a small default is
 * used, which is acceptable because content-visibility: auto already provides
 * the same fallback for the browser's own lazy layout.
 *
 * 挂载塌缩防护：占位符切回真实内容时，markdown HTML 需经 worker 异步
 * 重渲染才就绪，挂载瞬间内容高度塌缩会让 scrollHeight 突减、视口错位
 * 出现大片空白（快速滚动浏览历史时尤其明显）。切换瞬间 wrapper 锁定为
 * 缓存高度，内容真实高度追上后释放为自适应，超时兜底。
 *
 * The wrapper element is always mounted (only its inner content switches), so
 * the IntersectionObserver target is stable and the register call in the ref
 * callback fires exactly once per mount.
 */
type VirtualizedMessageProps = {
  /** Stable message id, used as the virtualization key. */
  id: string;
  /** Virtualization API from useViewportVirtualization. */
  virtualization: ViewportVirtualization;
  /** The real message content. Only rendered when visible. */
  children: React.ReactNode;
};

export const VirtualizedMessage = memo(
  ({ id, virtualization, children }: VirtualizedMessageProps): React.JSX.Element => {
    const { visibleIds, heights, register } = virtualization;
    // visibleIds === null means the IntersectionObserver has not reported yet.
    // Render real content for everyone so the first paint is not a wall of
    // empty placeholders. This is also the correct behaviour when JS disables
    // virtualization (e.g. older browsers without IntersectionObserver).
    const isVisible = visibleIds === null || visibleIds.has(id);
    const cachedHeight = heights.get(id);
    const hasRenderedContentRef = useRef(false);
    const wasVisibleRef = useRef(isVisible);
    // 非空表示正在高度锁定：wrapper 保持卸载前的缓存高度直到内容就绪。
    const [settlingHeight, setSettlingHeight] = useState<number | null>(null);
    const innerRef = useRef<HTMLDivElement | null>(null);

    // 高度锁定期间观察内容真实高度：追上缓存高度立即释放为自适应布局，
    // 超时（SETTLE_TIMEOUT_MS）无条件释放兜底。
    useEffect(() => {
      if (settlingHeight === null) {
        return;
      }
      const inner = innerRef.current;
      if (!inner) {
        setSettlingHeight(null);
        return;
      }
      const target = settlingHeight;
      const observer = new ResizeObserver(() => {
        if (inner.getBoundingClientRect().height >= target - 1) {
          setSettlingHeight(null);
        }
      });
      observer.observe(inner);
      const timer = window.setTimeout(() => {
        setSettlingHeight(null);
      }, SETTLE_TIMEOUT_MS);
      return () => {
        observer.disconnect();
        window.clearTimeout(timer);
      };
    }, [settlingHeight]);

    // 占位符 → 真实切换的边沿：启动高度锁定。首次挂载（初始即可见）不
    // 锁定——没有"卸载前高度"可依，且骨架屏阶段本就允许内容渐进渲染。
    useEffect(() => {
      const wasVisible = wasVisibleRef.current;
      wasVisibleRef.current = isVisible;
      if (!isVisible || wasVisible) {
        return;
      }
      if (!hasRenderedContentRef.current || cachedHeight == null) {
        return;
      }
      setSettlingHeight(cachedHeight);
    }, [isVisible, cachedHeight, id]);

    const setRef = useCallback(
      (node: HTMLDivElement | null): void => {
        register(id, node);
      },
      [id, register],
    );

    if (isVisible) {
      const skipEnter = hasRenderedContentRef.current;
      hasRenderedContentRef.current = true;
      // Render the real content. The ref is attached to a stable wrapper div so
      // the IntersectionObserver target survives the visible/hidden toggle
      // without re-registering. We intentionally do NOT apply an inline height
      // here (except while settling): when visible the element must size to its
      // content so the ResizeObserver can measure the true height for future
      // placeholder use.
      return (
        <div
          className={`virtualized-message is-visible${
            skipEnter ? " no-enter" : ""
          }${settlingHeight != null ? " is-settling" : ""}`}
          ref={setRef}
          data-message-id={id}
          style={
            settlingHeight != null
              ? { height: `${settlingHeight}px` }
              : undefined
          }
        >
          <div ref={innerRef}>{children}</div>
        </div>
      );
    }

    // Render a placeholder that reserves the previously measured height so the
    // scrollbar does not jump when content is unmounted. Using a non-content
    // height here is fine: the real element will remount on scroll-back and
    // immediately measure its true height via the ResizeObserver.
    const placeholderHeight = cachedHeight ?? VIRTUAL_PLACEHOLDER_DEFAULT_HEIGHT;
    return (
      <div
        className="virtualized-message is-placeholder"
        ref={setRef}
        data-message-id={id}
        style={{ height: `${placeholderHeight}px` }}
        aria-hidden="true"
      />
    );
  }
);

VirtualizedMessage.displayName = "VirtualizedMessage";
