import type { ConversationSessionState } from "../../mainContent/chatMessages/utils/conversationTypes";
import type { ChatConversationRecord } from "../../../../preload";

/**
 * 由内存会话状态重建 pending 槽位（首条 AI 响应未返回、会话行尚未落库的
 * 新会话）的占位记录。
 *
 * pending 会话只存在于渲染进程内存，侧边栏会话列表与跨项目通知都依赖该
 * 占位记录展示运行中的新会话；真实记录落库后由迁移 upsert / 抓取结果自然
 * 接管，不会产生重复项。
 *
 * @param fallbackDirectoryId 会话未记录目录时的回退项目 id
 */
export const buildPendingConversationRecord = (
  conversationId: string,
  session: ConversationSessionState,
  fallbackDirectoryId: string,
): ChatConversationRecord => {
  const firstUserMessage = session.messages.find(
    (message) => message.role === "user",
  );
  const content = firstUserMessage?.content ?? session.summary;
  const nowIso = new Date().toISOString();
  return {
    conversationId,
    title: content,
    summary: "",
    lastMessagePreview:
      content.length > 50 ? `${content.slice(0, 50)}...` : content,
    messageCount: session.messages.length,
    model:
      session.messages.find((message) => message.role === "assistant")?.model ??
      "",
    apiProfileName: "",
    status: "active",
    directoryId: session.directoryId ?? fallbackDirectoryId,
    forkedFromConversationId: "",
    forkMessageCount: 0,
    conversationType: "main",
    parentConversationId: "",
    subAgentId: "",
    subAgentName: "",
    subAgentStatus: "",
    subAgentError: "",
    createdAt: nowIso,
    updatedAt: nowIso,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    totalDurationMs: 0,
    runInputTokens: 0,
    runOutputTokens: 0,
    runCacheCreationInputTokens: 0,
    runCacheReadInputTokens: 0,
    lastRunDurationMs: 0,
    emoji: "",
  };
};
