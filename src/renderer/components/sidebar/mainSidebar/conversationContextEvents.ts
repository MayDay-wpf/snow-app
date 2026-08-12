/**
 * 会话上下文附件（拖拽会话到另一会话开头）的事件总线与拖拽契约。
 *
 * - `attachments-changed`：某会话的上下文附件列表发生变化（attach / detach），
 *   顶部引用条与消息流折叠块订阅后自行刷新。
 * - 拖拽 MIME 与 payload：侧边栏会话项拖拽时携带，drop 目标解析后调用
 *   `window.snow.addContextAttachment`。
 *
 * 纯渲染进程内存事件，不经过主进程 IPC。
 */

/** 会话拖拽 payload 的 MIME 类型（HTML5 DataTransfer 自定义类型）。 */
export const CONVERSATION_DRAG_MIME = "application/x-snow-conversation";

export type ConversationDragPayload = {
  /** 被拖拽会话 A 的 conversationId */
  conversationId: string;
  /** 被拖拽会话 A 所属工作区目录（用于同项目校验） */
  directoryId: string;
  /** 被拖拽会话 A 的显示名（用于拖影） */
  title: string;
  /** 被拖拽会话 A 的 emoji（用于拖影） */
  emoji?: string;
};

/** 读取拖拽 payload；非法返回 null。 */
export const readConversationDragPayload = (
  dataTransfer: DataTransfer
): ConversationDragPayload | null => {
  try {
    const raw = dataTransfer.getData(CONVERSATION_DRAG_MIME);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<ConversationDragPayload>;
    if (
      typeof parsed.conversationId === "string" &&
      parsed.conversationId.trim() &&
      typeof parsed.directoryId === "string"
    ) {
      return {
        conversationId: parsed.conversationId,
        directoryId: parsed.directoryId,
        title: typeof parsed.title === "string" ? parsed.title : "",
        emoji: typeof parsed.emoji === "string" ? parsed.emoji : "",
      };
    }
    return null;
  } catch {
    return null;
  }
};

type ListenerMap = {
  "attachments-changed": Set<(conversationId: string) => void>;
};

const listeners: ListenerMap = {
  "attachments-changed": new Set(),
};

export const conversationContextEvents = {
  on(
    action: "attachments-changed",
    listener: (conversationId: string) => void
  ): () => void {
    listeners[action].add(listener);
    return () => {
      listeners[action].delete(listener);
    };
  },

  emit(action: "attachments-changed", conversationId: string): void {
    const set = listeners[action];
    for (const listener of set) {
      listener(conversationId);
    }
  },
};
