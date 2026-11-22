import { useCallback } from "react";

import { ChatImAvatar } from "../components/ChatImAvatar";
import type { MinimalRow as MinimalRowModel } from "./types";

type MinimalRowProps = {
  row: MinimalRowModel;
  visible: boolean;
  placeholderHeight: number;
  /** IM 风格下本行是否显示头像；集合内的后续行只保留缩进。 */
  imRole: "user" | "assistant" | null;
  imAvatarPath?: string;
  /** 同一条 AI 消息的后续行：IM 风格下与正文列对齐。 */
  continuation: boolean;
  register: (key: string, node: HTMLElement | null) => void;
  onInteract: (key: string) => void;
  children: React.ReactNode;
};

/**
 * 极简模式的单行包装。
 *
 * 外层节点始终挂载（稳定 IntersectionObserver / ResizeObserver 目标），
 * 内部在真实内容与等高占位符之间切换。data-message-id 在两种状态下都
 * 保留，滚动锚点不会因为虚拟化而丢失。
 */
export const MinimalRow = ({
  row,
  visible,
  placeholderHeight,
  imRole,
  imAvatarPath,
  continuation,
  register,
  onInteract,
  children,
}: MinimalRowProps): React.JSX.Element => {
  const setRef = useCallback(
    (node: HTMLDivElement | null): void => {
      register(row.key, node);
    },
    [register, row.key],
  );

  const messageIdAttr = row.messageId || undefined;
  const kindClass = `minimal-row minimal-row--${row.kind}`;

  if (!visible) {
    return (
      <div
        className={`${kindClass} minimal-row--placeholder is-placeholder`}
        data-message-id={messageIdAttr}
        data-minimal-row-key={row.key}
        ref={setRef}
        style={{ height: `${placeholderHeight}px` }}
        aria-hidden="true"
      />
    );
  }

  const body = <div className="minimal-row-body">{children}</div>;

  return (
    <div
      className={`${kindClass}${continuation ? " minimal-row--continuation" : ""}`}
      data-message-id={messageIdAttr}
      data-minimal-row-key={row.key}
      ref={setRef}
      onClickCapture={() => onInteract(row.key)}
    >
      {imRole ? (
        <div className={`chat-im-row is-${imRole}`}>
          <ChatImAvatar role={imRole} path={imAvatarPath ?? ""} />
          {body}
        </div>
      ) : (
        body
      )}
    </div>
  );
};
