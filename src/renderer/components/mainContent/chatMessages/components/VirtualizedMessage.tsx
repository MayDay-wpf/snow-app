import { memo, useCallback } from "react";
import type { ViewportVirtualization } from "../hooks/useViewportVirtualization";
import { VIRTUAL_PLACEHOLDER_DEFAULT_HEIGHT } from "../hooks/useViewportVirtualization";

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

    const setRef = useCallback(
      (node: HTMLDivElement | null): void => {
        register(id, node);
      },
      [id, register]
    );

    if (isVisible) {
      // Render the real content. The ref is attached to a stable wrapper div so
      // the IntersectionObserver target survives the visible/hidden toggle
      // without re-registering. We intentionally do NOT apply an inline height
      // here: when visible the element must size to its content so the
      // ResizeObserver can measure the true height for future placeholder use.
      return (
        <div
          className="virtualized-message is-visible"
          ref={setRef}
          data-message-id={id}
        >
          {children}
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
