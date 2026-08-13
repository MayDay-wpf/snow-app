/**
 * 会话上下文附件（拖拽附加的历史会话）共享数据 hook。
 *
 * - 按 activeConversationId 加载 `window.snow.listContextAttachments`
 * - 订阅 `attachments-changed` 事件：attach / detach 后自动刷新
 * - 输入框上方附件提示条（ConversationAttachmentBar）与消息流折叠块
 *   （ConversationContextFold）各自独立使用本 hook（list 调用很轻量，
 *   解耦优于共享状态）
 */

import { useCallback, useEffect, useState } from "react";
import type { ContextAttachmentRecord } from "../../../../preload";
import { conversationContextEvents } from "../../sidebar/mainSidebar/conversationContextEvents";

export const useConversationContextAttachments = (
  conversationId: string | null
): {
  attachments: ContextAttachmentRecord[];
  isLoading: boolean;
  refresh: () => void;
} => {
  const [attachments, setAttachments] = useState<ContextAttachmentRecord[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const load = useCallback(async (id: string | null) => {
    if (!id) {
      setAttachments([]);
      return;
    }
    setIsLoading(true);
    try {
      const records = await window.snow.listContextAttachments(id);
      setAttachments(records);
    } catch (error) {
      console.warn("[conversation-context] list attachments failed", error);
      setAttachments([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(conversationId);
  }, [conversationId, load]);

  useEffect(() => {
    return conversationContextEvents.on("attachments-changed", (id) => {
      if (id === conversationId) {
        void load(conversationId);
      }
    });
  }, [conversationId, load]);

  return {
    attachments,
    isLoading,
    refresh: () => void load(conversationId),
  };
};
