import { ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  ChatConversationPage,
  ChatConversationRecord,
  ChatMessagePage,
  ChatMessageRecord,
  ConversationImportProgress,
  ConversationImportSummary,
  ConversationSearchResult,
  ManualToolExchangeRequest,
  ResponsesApiResult,
  UserMessageSummary,
  SubAgentRunCommand,
  SubAgentRunCommandResult,
  WorkflowCanvasRecord,
  WorkflowGraphValidationResult,
  WorkflowNodeSessionRecord,
  WorkflowRunRecord,
} from "../types";

const CONVERSATION_IMPORT_PROGRESS_CHANNEL =
  "chat-conversations:import-progress";

const importProgressCallbacks = new Map<
  string,
  (progress: ConversationImportProgress) => void
>();
let importProgressListenerRegistered = false;

const ensureImportProgressListener = (): void => {
  if (importProgressListenerRegistered) {
    return;
  }
  importProgressListenerRegistered = true;
  ipcRenderer.on(
    CONVERSATION_IMPORT_PROGRESS_CHANNEL,
    (_event: IpcRendererEvent, payload: unknown) => {
      const record = payload as Record<string, unknown> | null;
      const streamId = record?.streamId;
      if (typeof streamId !== "string") {
        return;
      }
      importProgressCallbacks.get(streamId)?.(
        payload as ConversationImportProgress,
      );
    },
  );
};

const createImportStreamId = (): string =>
  `conversation-import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const SUB_AGENT_CHANGED_CHANNEL = "sub-agents:changed";
// Separate entries preserve independent cancellation even for the same callback.
const subAgentSubscribers = new Set<{ notify: () => void }>();
const logSubAgentSubscription = (
  event: "attached" | "detached" | "subscriber_failed",
): void => {
  try {
    void ipcRenderer
      .invoke(
        "debug:write-log",
        event === "subscriber_failed" ? "WARN" : "DEBUG",
        {
          module: "preload/sub-agents",
          func: "subscription",
          message: `Sub-agent subscription ${event}`,
          context: JSON.stringify({
            event,
            subscriberCount: subAgentSubscribers.size,
          }),
        },
      )
      .catch(() => undefined);
  } catch {
    // Diagnostics must not interrupt notification delivery or cleanup.
  }
};
const notifySubAgentSubscribers = (): void => {
  for (const subscriber of [...subAgentSubscribers]) {
    // A callback may unsubscribe another entry during this dispatch.
    if (!subAgentSubscribers.has(subscriber)) continue;
    try {
      subscriber.notify();
    } catch {
      logSubAgentSubscription("subscriber_failed");
    }
  }
};

export const conversationApi = {
  subAgentRunCommand: (
    command: SubAgentRunCommand,
  ): Promise<SubAgentRunCommandResult> =>
    ipcRenderer.invoke("sub-agents:command", command),
  onSubAgentRunsChanged: (callback: () => void): (() => void) => {
    const subscriber = { notify: callback };
    if (subAgentSubscribers.size === 0) {
      ipcRenderer.on(SUB_AGENT_CHANGED_CHANNEL, notifySubAgentSubscribers);
    }
    subAgentSubscribers.add(subscriber);
    if (subAgentSubscribers.size === 1) logSubAgentSubscription("attached");
    return () => {
      if (!subAgentSubscribers.delete(subscriber)) return;
      if (subAgentSubscribers.size === 0) {
        ipcRenderer.removeListener(
          SUB_AGENT_CHANGED_CHANNEL,
          notifySubAgentSubscribers,
        );
        logSubAgentSubscription("detached");
      }
    };
  },
  listChatConversations: (
    directoryId: string,
  ): Promise<ChatConversationRecord[]> =>
    ipcRenderer.invoke("chat-conversations:list", directoryId),
  listChatConversationsPaginated: (
    directoryId: string,
    limit: number,
    offset: number,
  ): Promise<ChatConversationPage> =>
    ipcRenderer.invoke(
      "chat-conversations:list-paginated",
      directoryId,
      limit,
      offset,
    ),
  listChatConversationsByIds: (
    conversationIds: string[],
  ): Promise<ChatConversationRecord[]> =>
    ipcRenderer.invoke("chat-conversations:list-by-ids", conversationIds),
  /**
   * 记忆来源解析：按会话 ID 批量查询会话记录（含子代理 / WorkFlow 节点会话）。
   * 未出现在返回结果中的 ID 表示来源会话已被删除。
   */
  listMemorySourceConversations: (
    conversationIds: string[],
  ): Promise<ChatConversationRecord[]> =>
    ipcRenderer.invoke(
      "chat-conversations:list-memory-sources",
      conversationIds,
    ),
  listPinnedConversations: (
    directoryId: string,
  ): Promise<ChatConversationRecord[]> =>
    ipcRenderer.invoke("chat-conversations:list-pinned", directoryId),
  searchChatConversations: (
    query: string,
  ): Promise<ConversationSearchResult[]> =>
    ipcRenderer.invoke("chat-conversations:search", query),
  getChatConversation: (
    conversationId: string,
  ): Promise<ChatConversationRecord | null> =>
    ipcRenderer.invoke("chat-conversations:get", conversationId),
  previewConversationAttachment: (conversationId: string): Promise<string> =>
    ipcRenderer.invoke("chat-conversations:preview-attachment", conversationId),
  updateConversationStatus: (
    conversationId: string,
    status: string,
  ): Promise<void> =>
    ipcRenderer.invoke(
      "chat-conversations:update-status",
      conversationId,
      status,
    ),
  renameConversation: (conversationId: string, title: string): Promise<void> =>
    ipcRenderer.invoke("chat-conversations:rename", conversationId, title),
  updateConversationApiProfile: (
    conversationId: string,
    profileName: string,
  ): Promise<void> =>
    ipcRenderer.invoke(
      "chat-conversations:update-api-profile",
      conversationId,
      profileName,
    ),
  /** 在指定项目下创建主会话，返回新会话 ID；initialText 仅写入一条 user 消息，不触发回合。 */
  createChatConversation: (
    directoryId: string,
    title: string,
    initialText?: string,
  ): Promise<string> =>
    ipcRenderer.invoke(
      "chat-conversations:create",
      directoryId,
      title,
      initialText,
    ),
  /** deleteMemories=true 时把该会话（含级联子会话）保存的项目记忆一并删除；默认保留。 */
  deleteConversation: (
    conversationId: string,
    deleteMemories?: boolean,
  ): Promise<void> =>
    ipcRenderer.invoke(
      "chat-conversations:delete",
      conversationId,
      deleteMemories,
    ),
  /** deleteMemories=true 时把这些会话（含级联子会话）保存的项目记忆一并删除；默认保留。 */
  deleteConversations: (
    conversationIds: string[],
    deleteMemories?: boolean,
  ): Promise<void> =>
    ipcRenderer.invoke(
      "chat-conversations:batch-delete",
      conversationIds,
      deleteMemories,
    ),
  archiveConversations: (conversationIds: string[]): Promise<void> =>
    ipcRenderer.invoke("chat-conversations:archive", conversationIds),
  /** keyword 非空时按标题/摘要/预览模糊过滤。 */
  listArchivedConversationsPaginated: (
    directoryId: string,
    limit: number,
    offset: number,
    keyword?: string,
  ): Promise<ChatConversationPage> =>
    ipcRenderer.invoke(
      "chat-conversations:list-archived-paginated",
      directoryId,
      limit,
      offset,
      keyword,
    ),
  restoreArchivedConversations: (conversationIds: string[]): Promise<void> =>
    ipcRenderer.invoke("chat-conversations:restore-archived", conversationIds),
  deleteArchivedConversations: (conversationIds: string[]): Promise<void> =>
    ipcRenderer.invoke("chat-conversations:delete-archived", conversationIds),
  listSubAgentConversationsByParents: (
    parentConversationIds: string[],
  ): Promise<Record<string, ChatConversationRecord[]>> =>
    ipcRenderer.invoke(
      "chat-conversations:list-sub-agents-by-parents",
      parentConversationIds,
    ),
  saveTaskHistory: (
    conversationId: string,
    responseId: string,
    manifest: string,
  ): Promise<void> =>
    ipcRenderer.invoke(
      "chat-conversations:save-task-history",
      conversationId,
      responseId,
      manifest,
    ),
  listTaskHistory: (conversationId: string): Promise<string[]> =>
    ipcRenderer.invoke("chat-conversations:list-task-history", conversationId),
  appendToolMessage: (conversationId: string, content: string): Promise<void> =>
    ipcRenderer.invoke(
      "chat-conversations:append-tool-message",
      conversationId,
      content,
    ),
  storeManualToolExchange: (
    request: ManualToolExchangeRequest,
  ): Promise<ResponsesApiResult> =>
    ipcRenderer.invoke(
      "chat-conversations:store-manual-tool-exchange",
      request,
    ),
  updateToolCallArguments: (
    conversationId: string,
    responseId: string,
    callId: string,
    argumentsJson: string,
  ): Promise<boolean> =>
    ipcRenderer.invoke(
      "chat-conversations:update-tool-call-arguments",
      conversationId,
      responseId,
      callId,
      argumentsJson,
    ),
  updateToolCallCorrection: (
    conversationId: string,
    responseId: string,
    callId: string,
    correctionJson: string,
  ): Promise<boolean> =>
    ipcRenderer.invoke(
      "chat-conversations:update-tool-call-correction",
      conversationId,
      responseId,
      callId,
      correctionJson,
    ),
  listChatMessages: (conversationId: string): Promise<ChatMessageRecord[]> =>
    ipcRenderer.invoke("chat-conversations:list-messages", conversationId),
  listUserMessages: (conversationId: string): Promise<UserMessageSummary[]> =>
    ipcRenderer.invoke("chat-conversations:list-user-messages", conversationId),
  listChatMessagesPaginated: (
    conversationId: string,
    beforeMessageId: string,
    limit: number,
  ): Promise<ChatMessagePage> =>
    ipcRenderer.invoke(
      "chat-conversations:list-messages-paginated",
      conversationId,
      beforeMessageId,
      limit,
    ),
  findLatestToolResult: (
    conversationId: string,
    toolName: string,
  ): Promise<string | null> =>
    ipcRenderer.invoke(
      "chat-conversations:find-latest-tool-result",
      conversationId,
      toolName,
    ),
  forkConversation: (
    sourceConversationId: string,
    upToResponseId: string,
  ): Promise<ChatConversationRecord> =>
    ipcRenderer.invoke(
      "chat-conversations:fork",
      sourceConversationId,
      upToResponseId,
    ),
  truncateConversation: (
    conversationId: string,
    responseId: string,
  ): Promise<void> =>
    ipcRenderer.invoke(
      "chat-conversations:truncate",
      conversationId,
      responseId,
    ),
  truncateConversationFromMessage: (
    conversationId: string,
    messageId: string,
  ): Promise<void> =>
    ipcRenderer.invoke(
      "chat-conversations:truncate-from-message",
      conversationId,
      messageId,
    ),
  generateConversationSummary: (
    conversationId: string,
    basicModel?: string,
  ): Promise<string> =>
    ipcRenderer.invoke(
      "chat-conversations:generate-summary",
      conversationId,
      basicModel,
    ),
  cancelConversationSummary: (conversationId: string): Promise<boolean> =>
    ipcRenderer.invoke("chat-conversations:cancel-summary", conversationId),
  listSubAgentConversations: (
    parentConversationId: string,
  ): Promise<ChatConversationRecord[]> =>
    ipcRenderer.invoke(
      "chat-conversations:list-sub-agent",
      parentConversationId,
    ),
  createWorkflowNodeSession: (
    conversationId: string,
    parentConversationId: string,
    flowId: string,
    flowCheckpointId: string,
    nodeId: string,
    nodeName: string,
    directoryId: string,
    apiProfileName: string,
    model: string,
  ): Promise<void> =>
    ipcRenderer.invoke(
      "chat-conversations:create-workflow-node-session",
      conversationId,
      parentConversationId,
      flowId,
      flowCheckpointId,
      nodeId,
      nodeName,
      directoryId,
      apiProfileName,
      model,
    ),
  updateWorkflowNodeSession: (
    conversationId: string,
    runStatus: string,
    errorMessage: string,
    handoffContent: string,
  ): Promise<void> =>
    ipcRenderer.invoke(
      "chat-conversations:update-workflow-node-session",
      conversationId,
      runStatus,
      errorMessage,
      handoffContent,
    ),
  updateWorkflowNodeHandoff: (
    conversationId: string,
    handoffContent: string,
  ): Promise<void> =>
    ipcRenderer.invoke(
      "chat-conversations:update-workflow-node-handoff",
      conversationId,
      handoffContent,
    ),
  listWorkflowNodeSessions: (
    parentConversationId: string,
  ): Promise<WorkflowNodeSessionRecord[]> =>
    ipcRenderer.invoke(
      "chat-conversations:list-workflow-node-sessions",
      parentConversationId,
    ),
  listWorkflowNodeSessionsByParents: (
    parentConversationIds: string[],
  ): Promise<Record<string, ChatConversationRecord[]>> =>
    ipcRenderer.invoke(
      "chat-conversations:list-workflow-node-sessions-by-parents",
      parentConversationIds,
    ),
  getWorkflowNodeSession: (
    conversationId: string,
  ): Promise<WorkflowNodeSessionRecord | null> =>
    ipcRenderer.invoke(
      "chat-conversations:get-workflow-node-session",
      conversationId,
    ),
  upsertWorkflowRun: (
    parentConversationId: string,
    flowId: string,
    runStatus: string,
    currentNodeIndex: number,
    lastHandoff: string,
    totalTokens: number,
    flowCheckpointId: string,
    directoryId: string,
    errorMessage: string,
  ): Promise<void> =>
    ipcRenderer.invoke(
      "chat-conversations:upsert-workflow-run",
      parentConversationId,
      flowId,
      runStatus,
      currentNodeIndex,
      lastHandoff,
      totalTokens,
      flowCheckpointId,
      directoryId,
      errorMessage,
    ),
  getWorkflowRun: (
    parentConversationId: string,
    flowId: string,
  ): Promise<WorkflowRunRecord | null> =>
    ipcRenderer.invoke(
      "chat-conversations:get-workflow-run",
      parentConversationId,
      flowId,
    ),
  upsertWorkflowCanvas: (
    parentConversationId: string,
    interactionId: string,
    canvasJson: string,
  ): Promise<void> =>
    ipcRenderer.invoke(
      "chat-conversations:upsert-workflow-canvas",
      parentConversationId,
      interactionId,
      canvasJson,
    ),
  getWorkflowCanvas: (
    parentConversationId: string,
    interactionId: string,
  ): Promise<WorkflowCanvasRecord | null> =>
    ipcRenderer.invoke(
      "chat-conversations:get-workflow-canvas",
      parentConversationId,
      interactionId,
    ),
  validateWorkflowGraph: (
    nodesJson: string,
    edgesJson: string,
  ): Promise<WorkflowGraphValidationResult> =>
    ipcRenderer.invoke("workflow:validate-graph", nodesJson, edgesJson),
  listTodosForRollback: (
    sessionId: string,
    responseId: string,
  ): Promise<string> =>
    ipcRenderer.invoke("chat-conversations:count-todos", sessionId, responseId),
  exportConversation: (
    conversationId: string,
    format: string,
    defaultFileName?: string,
  ): Promise<{
    success: boolean;
    canceled: boolean;
    filePath: string | null;
  }> =>
    ipcRenderer.invoke(
      "chat-conversations:export",
      conversationId,
      format,
      defaultFileName,
    ),
  /** 打开文件对话框选择要导入的会话 JSON（支持多选）。 */
  pickConversationImportFiles: (): Promise<string[]> =>
    ipcRenderer.invoke("chat-conversations:pick-import-files"),
  /**
   * 批量导入会话 JSON 文件，逐个文件推送进度；返回汇总结果。
   */
  importConversations: (
    directoryId: string,
    filePaths: string[],
    onProgress?: (progress: ConversationImportProgress) => void,
  ): Promise<ConversationImportSummary> => {
    const streamId = createImportStreamId();
    ensureImportProgressListener();

    if (onProgress) {
      importProgressCallbacks.set(streamId, onProgress);
    }

    return ipcRenderer
      .invoke("chat-conversations:import", directoryId, filePaths, streamId)
      .finally(() => {
        importProgressCallbacks.delete(streamId);
      });
  },
  /** 导出 Markdown 表格为 CSV / XLSX 文件（rowsJson 为二维字符串数组）。 */
  exportMarkdownTable: (
    format: string,
    rowsJson: string,
    defaultFileName?: string,
  ): Promise<{
    success: boolean;
    canceled: boolean;
    filePath: string | null;
  }> =>
    ipcRenderer.invoke(
      "chat-conversations:export-table",
      format,
      rowsJson,
      defaultFileName,
    ),
};
