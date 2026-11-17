import { memo, useCallback, useEffect, useRef } from "react";
import { VIRTUAL_PLACEHOLDER_DEFAULT_HEIGHT } from "../hooks/useViewportVirtualization";
import { MessageContent, type MessageContentProps } from "./MessageContent";
import { ChatImAvatar } from "./ChatImAvatar";

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
  /** Stable render key, used as the virtualization key. 消息 id 迁移
   *  （临时 id → 数据库 id）时保持不变；DOM 的 data-message-id 取真实
   *  消息 id。 */
  id: string;
  /** 消息在列表中的序号（透传给内容包装节点）。 */
  itemIndex: number;
  /** 内容包装节点的 class（含消息状态）。 */
  itemClassName: string;
  /** 是否渲染真实内容（由列表按可见集算好传入，未变化的消息可被 memo 跳过）。 */
  visible: boolean;
  /** 高度缓存（稳定引用），占位符据此保留高度。 */
  heights: ReadonlyMap<string, number>;
  /** 注册/注销观察节点。 */
  register: (id: string, node: HTMLElement | null) => void;
  /** IM 风格头像路径（undefined 表示未开启 IM 风格，空串为默认头像） */
  imAvatarPath?: string;
};

export const VirtualizedMessage = memo(
  ({
    id,
    itemIndex,
    itemClassName,
    visible,
    heights,
    register,
    imAvatarPath,
    ...contentProps
  }: VirtualizedMessageProps): React.JSX.Element => {
    const isVisible = visible;
    const cachedHeight = heights.get(id);
    const messageId = contentProps.message.id;
    const messageRole = contentProps.message.role;

    // 该消息此前是否已渲染过真实内容：用于区分「首次出现」与「虚拟化回显」。
    // 回显（占位符 → 真实内容的重新挂载）不重播入场动画（见 wrapper 上的
    // .is-replay 类与 styles.css 的覆盖规则），避免滚回视口 / 可见集恢复时
    // 整片消息区看起来在"重刷闪烁"；首次出现仍保留柔和浮现动画。
    // 首次挂载即为占位符的历史消息，揭开时同样按回显处理：入场的 transform
    // 动画会抑制浏览器滚动锚定，向上翻阅时表现为视口跳动。
    const hasRenderedContentRef = useRef(!isVisible);
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
      const content = (
        <div className={itemClassName} data-message-index={itemIndex}>
          <MessageContent {...contentProps} />
        </div>
      );
      const imRole =
        imAvatarPath !== undefined &&
        (messageRole === "user" || messageRole === "assistant")
          ? messageRole
          : null;
      return (
        <div
          className={`virtualized-message is-visible${
            isReplay ? " is-replay" : ""
          }`}
          ref={setRef}
          data-message-id={messageId}
          data-snow-anchor="chat.message"
          data-snow-message-role={messageRole}
        >
          {imRole ? (
            <div className={`chat-im-row is-${imRole}`}>
              <ChatImAvatar role={imRole} path={imAvatarPath ?? ""} />
              {content}
            </div>
          ) : (
            content
          )}
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
        data-message-id={messageId}
        style={{ height: `${placeholderHeight}px` }}
        aria-hidden="true"
      />
    );
  },
);

VirtualizedMessage.displayName = "VirtualizedMessage";
