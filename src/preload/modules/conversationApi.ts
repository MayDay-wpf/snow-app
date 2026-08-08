import { ipcRenderer } from "electron";
import type {
  ChatConversationPage,
  ChatConversationRecord,
  ChatMessagePage,
  ChatMessageRecord,
  ConversationSearchResult,
  UserMessageSummary,
} from "../types";

export const conversationApi = {
  listChatConversations: (
    directoryId: string
  ): Promise<ChatConversationRecord[]> =>
    ipcRenderer.invoke("chat-conversations:list", directoryId),
  listChatConversationsPaginated: (
    directoryId: string,
    limit: number,
    offset: number
  ): Promise<ChatConversationPage> =>
    ipcRenderer.invoke(
      "chat-conversations:list-paginated",
      directoryId,
      limit,
      offset
    ),
  listChatConversationsByIds: (
    conversationIds: string[]
  ): Promise<ChatConversationRecord[]> =>
    ipcRenderer.invoke("chat-conversations:list-by-ids", conversationIds),
  listPinnedConversations: (
    directoryId: string
  ): Promise<ChatConversationRecord[]> =>
    ipcRenderer.invoke("chat-conversations:list-pinned", directoryId),
  searchChatConversations: (
    query: string
  ): Promise<ConversationSearchResult[]> =>
    ipcRenderer.invoke("chat-conversations:search", query),
  getChatConversation: (
    conversationId: string
  ): Promise<ChatConversationRecord | null> =>
    ipcRenderer.invoke("chat-conversations:get", conversationId),
  updateConversationStatus: (
    conversationId: string,
    status: string
  ): Promise<void> =>
    ipcRenderer.invoke(
      "chat-conversations:update-status",
      conversationId,
      status
    ),
  renameConversation: (conversationId: string, title: string): Promise<void> =>
    ipcRenderer.invoke("chat-conversations:rename", conversationId, title),
  updateConversationEmoji: (
    conversationId: string,
    emoji: string
  ): Promise<void> =>
    ipcRenderer.invoke(
      "chat-conversations:update-emoji",
      conversationId,
      emoji
    ),
  updateConversationApiProfile: (
    conversationId: string,
    profileName: string
  ): Promise<void> =>
    ipcRenderer.invoke(
      "chat-conversations:update-api-profile",
      conversationId,
      profileName
    ),
  deleteConversation: (conversationId: string): Promise<void> =>
    ipcRenderer.invoke("chat-conversations:delete", conversationId),
  deleteConversations: (conversationIds: string[]): Promise<void> =>
    ipcRenderer.invoke("chat-conversations:batch-delete", conversationIds),
  listSubAgentConversationsByParents: (
    parentConversationIds: string[]
  ): Promise<Record<string, ChatConversationRecord[]>> =>
    ipcRenderer.invoke(
      "chat-conversations:list-sub-agents-by-parents",
      parentConversationIds
    ),
  appendToolMessage: (conversationId: string, content: string): Promise<void> =>
    ipcRenderer.invoke(
      "chat-conversations:append-tool-message",
      conversationId,
      content
    ),
  listChatMessages: (conversationId: string): Promise<ChatMessageRecord[]> =>
    ipcRenderer.invoke("chat-conversations:list-messages", conversationId),
  listUserMessages: (
    conversationId: string
  ): Promise<UserMessageSummary[]> =>
    ipcRenderer.invoke(
      "chat-conversations:list-user-messages",
      conversationId
    ),
  listChatMessagesPaginated: (
    conversationId: string,
    beforeMessageId: string,
    limit: number
  ): Promise<ChatMessagePage> =>
    ipcRenderer.invoke(
      "chat-conversations:list-messages-paginated",
      conversationId,
      beforeMessageId,
      limit
    ),
  findLatestToolResult: (
    conversationId: string,
    toolName: string
  ): Promise<string | null> =>
    ipcRenderer.invoke(
      "chat-conversations:find-latest-tool-result",
      conversationId,
      toolName
    ),
  forkConversation: (
    sourceConversationId: string,
    upToResponseId: string
  ): Promise<ChatConversationRecord> =>
    ipcRenderer.invoke(
      "chat-conversations:fork",
      sourceConversationId,
      upToResponseId
    ),
  truncateConversation: (
    conversationId: string,
    responseId: string
  ): Promise<void> =>
    ipcRenderer.invoke(
      "chat-conversations:truncate",
      conversationId,
      responseId
    ),
  generateConversationSummary: (conversationId: string): Promise<string> =>
    ipcRenderer.invoke("chat-conversations:generate-summary", conversationId),
  cancelConversationSummary: (conversationId: string): Promise<boolean> =>
    ipcRenderer.invoke("chat-conversations:cancel-summary", conversationId),
  listSubAgentConversations: (
    parentConversationId: string
  ): Promise<ChatConversationRecord[]> =>
    ipcRenderer.invoke(
      "chat-conversations:list-sub-agent",
      parentConversationId
    ),
  createSubAgentSession: (
    conversationId: string,
    parentConversationId: string,
    agentId: string,
    agentName: string,
    directoryId: string,
    apiProfileName: string,
    model: string,
    title: string
  ): Promise<void> =>
    ipcRenderer.invoke(
      "chat-conversations:create-sub-agent-session",
      conversationId,
      parentConversationId,
      agentId,
      agentName,
      directoryId,
      apiProfileName,
      model,
      title
    ),
  updateSubAgentSessionStatus: (
    conversationId: string,
    runStatus: string,
    errorMessage: string
  ): Promise<void> =>
    ipcRenderer.invoke(
      "chat-conversations:update-sub-agent-status",
      conversationId,
      runStatus,
      errorMessage
    ),
  listTodosForRollback: (
    sessionId: string,
    responseId: string
  ): Promise<string> =>
    ipcRenderer.invoke("chat-conversations:count-todos", sessionId, responseId),
  exportConversation: (
    conversationId: string,
    format: string,
    defaultFileName?: string
  ): Promise<{
    success: boolean;
    canceled: boolean;
    filePath: string | null;
  }> =>
    ipcRenderer.invoke(
      "chat-conversations:export",
      conversationId,
      format,
      defaultFileName
    ),
};
