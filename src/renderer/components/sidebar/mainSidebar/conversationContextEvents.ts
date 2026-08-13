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

let activeConversationDragPayload: ConversationDragPayload | null = null;

const parseConversationDragPayload = (
  raw: string
): ConversationDragPayload | null => {
  try {
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

/** 开始应用内会话拖拽，并缓存 payload 供 dragover 阶段校验。 */
export const beginConversationDrag = (
  dataTransfer: DataTransfer,
  payload: ConversationDragPayload
): void => {
  activeConversationDragPayload = payload;
  dataTransfer.setData(CONVERSATION_DRAG_MIME, JSON.stringify(payload));
  dataTransfer.effectAllowed = "copy";
};

/** 结束应用内会话拖拽，避免下一次拖拽误用旧 payload。 */
export const endConversationDrag = (): void => {
  activeConversationDragPayload = null;
};

/**
 * 读取拖拽 payload；非法返回 null。
 *
 * Chromium 在 dragover 阶段会将 DataTransfer 置于保护模式：types 仍可见，
 * 但 getData() 返回空字符串。此时回退到 dragstart 缓存的应用内 payload，
 * 否则输入框无法完成前置校验、preventDefault()，浏览器也不会派发 drop。
 */
export const readConversationDragPayload = (
  dataTransfer: DataTransfer
): ConversationDragPayload | null => {
  const raw = dataTransfer.getData(CONVERSATION_DRAG_MIME);
  if (raw) {
    return parseConversationDragPayload(raw);
  }
  return dataTransfer.types.includes(CONVERSATION_DRAG_MIME)
    ? activeConversationDragPayload
    : null;
};

// ---------------------------------------------------------------------------
// 新会话（尚未创建 conversationId）拖入的「待挂载」附件暂存（支持多个）。
// 新会话没有数据库记录，无法立即 addContextAttachment；先把意图暂存在这里，
// 输入框上方显示可见提示条；首条消息发送、PENDING 会话迁移到真实 id 时，
// useAgentLoop 调用 consumePendingContextAttachments() 消费并真正挂载。
// ---------------------------------------------------------------------------

let pendingContextAttachments: ConversationDragPayload[] = [];

const broadcastPendingChange = (): void => {
  for (const listener of pendingContextAttachmentListeners) {
    listener(pendingContextAttachments);
  }
};

/** 暂存一个待挂载会话附件（同会话幂等去重）；写入时广播供 UI 刷新。 */
export const addPendingContextAttachment = (
  payload: ConversationDragPayload
): void => {
  if (
    pendingContextAttachments.some(
      (item) => item.conversationId === payload.conversationId
    )
  ) {
    return;
  }
  pendingContextAttachments = [...pendingContextAttachments, payload];
  broadcastPendingChange();
};

/** 移除一个待挂载会话附件（拖入多个后逐个取消）。 */
export const removePendingContextAttachment = (
  conversationId: string
): void => {
  const next = pendingContextAttachments.filter(
    (item) => item.conversationId !== conversationId
  );
  if (next.length !== pendingContextAttachments.length) {
    pendingContextAttachments = next;
    broadcastPendingChange();
  }
};

/** 清空全部待挂载附件（切换会话 / 取消时）。 */
export const clearPendingContextAttachments = (): void => {
  if (pendingContextAttachments.length > 0) {
    pendingContextAttachments = [];
    broadcastPendingChange();
  }
};

/** 读取当前待挂载附件列表（不消费）。 */
export const getPendingContextAttachments = (): ConversationDragPayload[] =>
  pendingContextAttachments;

/** 读取并消费全部待挂载附件（置空并广播），供会话迁移完成后真正挂载。 */
export const consumePendingContextAttachments = (): ConversationDragPayload[] => {
  const list = pendingContextAttachments;
  pendingContextAttachments = [];
  broadcastPendingChange();
  return list;
};

const pendingContextAttachmentListeners = new Set<
  (payloads: ConversationDragPayload[]) => void
>();

/** 订阅「待挂载附件」变化（新增 / 取消 / 消费），返回取消订阅函数。 */
export const onPendingContextAttachmentChange = (
  listener: (payloads: ConversationDragPayload[]) => void
): (() => void) => {
  pendingContextAttachmentListeners.add(listener);
  return () => {
    pendingContextAttachmentListeners.delete(listener);
  };
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
