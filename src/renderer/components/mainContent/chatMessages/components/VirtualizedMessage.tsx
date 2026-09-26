import { memo, useCallback, useEffect, useRef } from "react";
import type { ViewportVirtualization } from "../hooks/useViewportVirtualization";
import { VIRTUAL_PLACEHOLDER_DEFAULT_HEIGHT } from "../hooks/useViewportVirtualization";
import { MessageContent, type MessageContentProps } from "./MessageContent";

/**
 * Viewport-virtualized wrapper for a single chat message.
 *
 * Renders the real MessageContent subtree when the message is considered
 * visible by the virtualization hook, otherwise renders a cheap placeholder
 * div that reserves the same height.
 *
 * This is the central piece that breaks the "re-render everything on every
 * streaming chunk" cycle: off-screen messages skip their entire React subtree,
 * so MarkdownBlock reconciliation and worker dispatches only run for the few
 * messages actually in the viewport.
 *
 * Height preservation: when a message virtualizes out, it is replaced by a
 * placeholder that must occupy the same height to avoid scrollbar jumps. The
 * hook exposes a height cache (Map<id, px>) kept in sync via a ResizeObserver
 * on every mounted message element. Placeholders read the cached height and
 * fall back to a reasonable default for messages that were never measured.
 *
 * The wrapper element is always mounted (only its inner content switches), so
 * the IntersectionObserver target is stable and the register call in the ref
 * callback fires exactly once per mount.
 */
type VirtualizedMessageProps = MessageContentProps & {
  /** Stable message id, used as the virtualization key. */
  id: string;
  /** 消息在列表中的序号（透传给内容包装节点）。 */
  itemIndex: number;
  /** 内容包装节点的 class（含消息状态）。 */
  itemClassName: string;
  /** Virtualization API from useViewportVirtualization. */
  virtualization: ViewportVirtualization;
  /** 该消息此前是否已渲染过真实内容（父级判定的既知事实，例如 id 迁移
   *  后的新元素继承旧元素的渲染状态）。为 true 时本实例即使首次渲染也
   *  不播放入场动画（见 is-replay）。 */
  previouslyRendered?: boolean;
};

export const VirtualizedMessage = memo(
  ({
    id,
    itemIndex,
    itemClassName,
    virtualization,
    previouslyRendered = false,
    ...contentProps
  }: VirtualizedMessageProps): React.JSX.Element => {
    const { visibleIds, heights, register } = virtualization;
    // visibleIds === null means the IntersectionObserver has not reported yet.
    // Render real content for everyone so the first paint is not a wall of
    // empty placeholders. This is also the correct behaviour when JS disables
    // virtualization (e.g. older browsers without IntersectionObserver).
    const isVisible = visibleIds === null || visibleIds.has(id);
    const cachedHeight = heights.get(id);
    const messageRole = contentProps.message.role;

    // 该消息此前是否已渲染过真实内容：用于区分「首次出现」与「虚拟化回显」。
    // 回显（占位符 → 真实内容的重新挂载）不重播入场动画（见 wrapper 上的
    // .is-replay 类与 styles.css 的覆盖规则），避免滚回视口 / 可见集恢复时
    // 整片消息区看起来在"重刷闪烁"；首次出现仍保留柔和浮现动画。
    // previouslyRendered 作为初始值：id 迁移（remap）重建的新实例据此
    // 继承"已渲染过"状态，同样不重播动画。
    const hasRenderedContentRef = useRef(previouslyRendered);
    const isReplay = isVisible && hasRenderedContentRef.current;

    useEffect(() => {
      if (isVisible) {
        hasRenderedContentRef.current = true;
      }
    }, [isVisible]);

    const setRef = useCallback(
      (node: HTMLDivElement | null): void => {
        register(id, node);
      },
      [id, register],
    );

    if (isVisible) {
      // Render the real content. The ref is attached to a stable wrapper div so
      // the IntersectionObserver target survives the visible/hidden toggle
      // without re-registering. We intentionally do NOT apply an inline height
      // here: when visible the element must size to its content so the
      // ResizeObserver can measure the true height for future placeholder use.
      return (
        <div
          className={`virtualized-message is-visible${
            isReplay ? " is-replay" : ""
          }`}
          ref={setRef}
          data-message-id={id}
          data-snow-anchor="chat.message"
          data-snow-message-role={messageRole}
        >
          <div className={itemClassName} data-message-index={itemIndex}>
            <MessageContent {...contentProps} />
          </div>
        </div>
      );
    }

    // Render a placeholder that reserves the previously measured height so the
    // scrollbar does not jump when content is unmounted. Using a non-content
    // height here is fine: the real element will remount on scroll-back and
    // immediately measure its true height via the ResizeObserver.
    const placeholderHeight =
      cachedHeight ?? VIRTUAL_PLACEHOLDER_DEFAULT_HEIGHT;
    return (
      <div
        className="virtualized-message is-placeholder"
        ref={setRef}
        data-message-id={id}
        style={{ height: `${placeholderHeight}px` }}
        aria-hidden="true"
      />
    );
  },
);

VirtualizedMessage.displayName = "VirtualizedMessage";
