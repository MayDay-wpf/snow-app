import { BrowserWindow, dialog, ipcMain } from "electron";
import { writeFile } from "node:fs/promises";
import type { NativeBridge } from "../../native/types";
import { snowLog } from "../../../utils/snowLogger";

const EXPORT_FORMATS = ["markdown", "html", "json", "csv"] as const;
type ExportFormat = (typeof EXPORT_FORMATS)[number];

const EXPORT_LABELS: Record<ExportFormat, string> = {
  markdown: "Markdown",
  html: "HTML",
  json: "JSON",
  csv: "CSV",
};

const EXPORT_EXTENSIONS: Record<ExportFormat, string> = {
  markdown: "md",
  html: "html",
  json: "json",
  csv: "csv",
};

const isExportFormat = (value: string): value is ExportFormat =>
  (EXPORT_FORMATS as readonly string[]).includes(value);

export const registerConversationHandlers = (native: NativeBridge): void => {
  ipcMain.handle("chat-conversations:list", (_event, directoryId: unknown) => {
    if (typeof directoryId !== "string" || !directoryId.trim()) {
      throw new Error("Directory ID is required to list chat conversations");
    }

    return native.listChatConversations(directoryId.trim());
  });
  ipcMain.handle(
    "chat-conversations:list-paginated",
    (_event, directoryId: unknown, limit: unknown, offset: unknown) => {
      if (typeof directoryId !== "string" || !directoryId.trim()) {
        throw new Error("Directory ID is required to list chat conversations");
      }

      const safeLimit =
        typeof limit === "number" && limit > 0 ? Math.floor(limit) : 20;
      const safeOffset =
        typeof offset === "number" && offset > 0 ? Math.floor(offset) : 0;

      return native.listChatConversationsPaginated(
        directoryId.trim(),
        safeLimit,
        safeOffset
      );
    }
  );
  ipcMain.handle(
    "chat-conversations:list-by-ids",
    (_event, conversationIds: unknown) => {
      if (
        !Array.isArray(conversationIds) ||
        conversationIds.some((id) => typeof id !== "string" || !id.trim())
      ) {
        throw new Error("Conversation IDs must be a non-empty string array");
      }

      return native.listChatConversationsByIds(
        (conversationIds as string[]).map((id) => id.trim())
      );
    }
  );
  ipcMain.handle(
    "chat-conversations:list-pinned",
    (_event, directoryId: unknown) => {
      if (typeof directoryId !== "string" || !directoryId.trim()) {
        throw new Error(
          "Directory ID is required to list pinned conversations"
        );
      }

      return native.listPinnedConversations(directoryId.trim());
    }
  );
  ipcMain.handle("chat-conversations:search", (_event, query: unknown) => {
    if (typeof query !== "string" || !query.trim()) {
      return Promise.resolve([]);
    }

    return native.searchChatConversations(query.trim());
  });
  ipcMain.handle(
    "chat-conversations:get",
    (_event, conversationId: unknown) => {
      if (typeof conversationId !== "string" || !conversationId.trim()) {
        throw new Error("Conversation ID is required to get conversation");
      }
      return native.getChatConversation(conversationId.trim());
    }
  );
  ipcMain.handle(
    "chat-conversations:generate-summary",
    async (_event, conversationId: unknown) => {
      if (typeof conversationId !== "string" || !conversationId.trim()) {
        throw new Error("Conversation ID is required to generate summary");
      }
      return native.generateConversationSummary(conversationId.trim());
    }
  );
  ipcMain.handle(
    "chat-conversations:cancel-summary",
    (_event, conversationId: unknown) => {
      if (typeof conversationId !== "string" || !conversationId.trim()) {
        throw new Error("Conversation ID is required to cancel summary");
      }
      return native.cancelConversationSummary(conversationId.trim());
    }
  );
  ipcMain.handle(
    "chat-conversations:append-tool-message",
    async (_event, conversationId: unknown, content: unknown) => {
      if (typeof conversationId !== "string" || !conversationId.trim()) {
        throw new Error("Conversation ID is required to append a tool message");
      }
      if (typeof content !== "string" || !content.trim()) {
        throw new Error("Tool message content is required");
      }

      await native.appendToolMessage(conversationId.trim(), content);
    }
  );
  ipcMain.handle(
    "chat-conversations:list-messages",
    (_event, conversationId: unknown) => {
      if (typeof conversationId !== "string" || !conversationId.trim()) {
        throw new Error("Conversation ID is required to list chat messages");
      }

      return native.listChatMessages(conversationId.trim());
    }
  );
  ipcMain.handle(
    "chat-conversations:list-user-messages",
    (_event, conversationId: unknown) => {
      if (typeof conversationId !== "string" || !conversationId.trim()) {
        throw new Error("Conversation ID is required to list user messages");
      }

      return native.listUserMessages(conversationId.trim());
    }
  );
  ipcMain.handle(
    "chat-conversations:list-messages-paginated",
    (
      _event,
      conversationId: unknown,
      beforeMessageId: unknown,
      limit: unknown
    ) => {
      if (typeof conversationId !== "string" || !conversationId.trim()) {
        throw new Error("Conversation ID is required to list chat messages");
      }

      const safeBeforeMessageId =
        typeof beforeMessageId === "string" ? beforeMessageId.trim() : "";
      const safeLimit =
        typeof limit === "number" && limit > 0 ? Math.floor(limit) : 10;

      return native.listChatMessagesPaginated(
        conversationId.trim(),
        safeBeforeMessageId,
        safeLimit
      );
    }
  );
  ipcMain.handle(
    "chat-conversations:find-latest-tool-result",
    (_event, conversationId: unknown, toolName: unknown) => {
      if (typeof conversationId !== "string" || !conversationId.trim()) {
        throw new Error("Conversation ID is required to find tool result");
      }
      if (typeof toolName !== "string" || !toolName.trim()) {
        throw new Error("Tool name is required to find tool result");
      }

      return native.findLatestToolResult(
        conversationId.trim(),
        toolName.trim()
      );
    }
  );
  ipcMain.handle(
    "chat-conversations:fork",
    async (_event, sourceConversationId: unknown, upToResponseId: unknown) => {
      if (
        typeof sourceConversationId !== "string" ||
        !sourceConversationId.trim()
      ) {
        throw new Error("Source conversation ID is required to fork");
      }

      const responseId =
        typeof upToResponseId === "string" ? upToResponseId.trim() : "";

      snowLog.info({
        module: "ipc/conversation",
        func: "fork",
        message: "Conversation forked",
        context: `source=${sourceConversationId.trim()} response=${
          responseId || "head"
        }`,
      });
      return native.forkConversation(sourceConversationId.trim(), responseId);
    }
  );
  ipcMain.handle(
    "chat-conversations:truncate",
    async (_event, conversationId: unknown, responseId: unknown) => {
      if (typeof conversationId !== "string" || !conversationId.trim()) {
        throw new Error("Conversation ID is required to truncate");
      }
      if (typeof responseId !== "string" || !responseId.trim()) {
        throw new Error("Response ID is required to truncate conversation");
      }

      snowLog.info({
        module: "ipc/conversation",
        func: "truncate",
        message: "Conversation truncated",
        context: `conversation=${conversationId.trim()} response=${responseId.trim()}`,
      });
      await native.truncateConversationFromResponse(
        conversationId.trim(),
        responseId.trim()
      );
    }
  );
  ipcMain.handle(
    "chat-conversations:count-todos",
    async (_event, sessionId: unknown, responseId: unknown) => {
      if (typeof sessionId !== "string" || !sessionId.trim()) {
        throw new Error("Session ID is required to count todos");
      }
      if (typeof responseId !== "string" || !responseId.trim()) {
        throw new Error("Response ID is required to count todos");
      }
      return native.listTodosForRollback(sessionId.trim(), responseId.trim());
    }
  );
  ipcMain.handle(
    "chat-conversations:update-status",
    async (_event, conversationId: unknown, status: unknown) => {
      if (typeof conversationId !== "string" || !conversationId.trim()) {
        throw new Error("Conversation ID is required to update status");
      }
      if (typeof status !== "string" || !status.trim()) {
        throw new Error("Status is required to update conversation status");
      }

      await native.updateConversationStatus(
        conversationId.trim(),
        status.trim()
      );
    }
  );
  ipcMain.handle(
    "chat-conversations:rename",
    async (_event, conversationId: unknown, title: unknown) => {
      if (typeof conversationId !== "string" || !conversationId.trim()) {
        throw new Error("Conversation ID is required to rename");
      }
      if (typeof title !== "string" || !title.trim()) {
        throw new Error("Title is required to rename conversation");
      }

      await native.renameConversation(conversationId.trim(), title.trim());
    }
  );
  ipcMain.handle(
    "chat-conversations:update-emoji",
    async (_event, conversationId: unknown, emoji: unknown) => {
      if (typeof conversationId !== "string" || !conversationId.trim()) {
        throw new Error("Conversation ID is required to update emoji");
      }
      if (typeof emoji !== "string") {
        throw new Error("Emoji is required to update conversation emoji");
      }

      await native.updateConversationEmoji(conversationId.trim(), emoji.trim());
    }
  );
  ipcMain.handle(
    "chat-conversations:update-api-profile",
    async (_event, conversationId: unknown, profileName: unknown) => {
      if (typeof conversationId !== "string" || !conversationId.trim()) {
        throw new Error(
          "Conversation ID is required to update API profile"
        );
      }
      if (typeof profileName !== "string") {
        throw new Error("Profile name is required to update API profile");
      }

      const normalizedProfileName = profileName.trim();
      await native.updateConversationApiProfile(
        conversationId.trim(),
        normalizedProfileName
      );
      // Log only after the native update succeeded, so a failure is not
      // misreported as an applied change.
      snowLog.info({
        module: "ipc/conversation",
        func: "update-api-profile",
        message: "Conversation API profile updated",
        context: `conversation=${conversationId.trim()} profile=${normalizedProfileName || "(unbound)"}`,
      });
    }
  );
  ipcMain.handle(
    "chat-conversations:delete",
    async (_event, conversationId: unknown) => {
      if (typeof conversationId !== "string" || !conversationId.trim()) {
        throw new Error("Conversation ID is required to delete");
      }

      snowLog.warn({
        module: "ipc/conversation",
        func: "delete",
        message: "Conversation deleted",
        context: `conversation=${conversationId.trim()}`,
      });
      await native.deleteConversation(conversationId.trim());
    }
  );
  ipcMain.handle(
    "chat-conversations:batch-delete",
    async (_event, conversationIds: unknown) => {
      if (!Array.isArray(conversationIds)) {
        throw new Error("Conversation IDs are required to batch delete");
      }

      const safeIds = conversationIds.filter(
        (id): id is string => typeof id === "string" && id.trim() !== ""
      );
      if (safeIds.length === 0) {
        return;
      }

      snowLog.warn({
        module: "ipc/conversation",
        func: "batch-delete",
        message: "Conversations deleted",
        context: `count=${safeIds.length}`,
      });
      await native.deleteConversations(safeIds);
    }
  );
  ipcMain.handle(
    "chat-conversations:list-sub-agent",
    (_event, parentConversationId: unknown) => {
      if (
        typeof parentConversationId !== "string" ||
        !parentConversationId.trim()
      ) {
        throw new Error(
          "Parent conversation ID is required to list sub-agent conversations"
        );
      }

      return native.listSubAgentConversations(parentConversationId.trim());
    }
  );
  ipcMain.handle(
    "chat-conversations:list-sub-agents-by-parents",
    (_event, parentConversationIds: unknown) => {
      if (!Array.isArray(parentConversationIds)) {
        throw new Error(
          "Parent conversation IDs are required to list sub-agent conversations"
        );
      }

      const safeIds = parentConversationIds.filter(
        (id): id is string => typeof id === "string" && id.trim() !== ""
      );
      if (safeIds.length === 0) {
        return Promise.resolve({});
      }
      return native.listSubAgentConversationsByParents(safeIds);
    }
  );
  ipcMain.handle(
    "chat-conversations:create-sub-agent-session",
    async (
      _event,
      conversationId: unknown,
      parentConversationId: unknown,
      agentId: unknown,
      agentName: unknown,
      directoryId: unknown,
      apiProfileName: unknown,
      model: unknown,
      title: unknown
    ) => {
      if (typeof conversationId !== "string" || !conversationId.trim()) {
        throw new Error(
          "Conversation ID is required to create sub-agent session"
        );
      }
      if (
        typeof parentConversationId !== "string" ||
        !parentConversationId.trim()
      ) {
        throw new Error(
          "Parent conversation ID is required to create sub-agent session"
        );
      }
      if (typeof agentId !== "string" || !agentId.trim()) {
        throw new Error("Agent ID is required to create sub-agent session");
      }
      if (typeof agentName !== "string" || !agentName.trim()) {
        throw new Error("Agent name is required to create sub-agent session");
      }
      if (typeof directoryId !== "string") {
        throw new Error("Directory ID is required to create sub-agent session");
      }
      if (typeof apiProfileName !== "string" || !apiProfileName.trim()) {
        throw new Error(
          "API profile is required to create sub-agent session"
        );
      }
      if (typeof model !== "string" || !model.trim()) {
        throw new Error("Model is required to create sub-agent session");
      }
      if (typeof title !== "string" || !title.trim()) {
        throw new Error("Title is required to create sub-agent session");
      }

      snowLog.info({
        module: "ipc/conversation",
        func: "create-sub-agent-session",
        message: "Sub-agent session created",
        context: `agent=${agentName.trim()} conversation=${conversationId.trim()} parent=${parentConversationId.trim()}`,
      });
      await native.createSubAgentSession(
        conversationId.trim(),
        parentConversationId.trim(),
        agentId.trim(),
        agentName.trim(),
        directoryId.trim(),
        apiProfileName.trim(),
        model.trim(),
        title.trim()
      );
    }
  );
  ipcMain.handle(
    "chat-conversations:update-sub-agent-status",
    async (
      _event,
      conversationId: unknown,
      runStatus: unknown,
      errorMessage: unknown
    ) => {
      if (typeof conversationId !== "string" || !conversationId.trim()) {
        throw new Error(
          "Conversation ID is required to update sub-agent session status"
        );
      }
      if (typeof runStatus !== "string" || !runStatus.trim()) {
        throw new Error(
          "Run status is required to update sub-agent session status"
        );
      }

      const normalizedStatus = runStatus.trim();
      const normalizedError =
        typeof errorMessage === "string" ? errorMessage : "";
      if (normalizedStatus === "failed" || normalizedError) {
        snowLog.error({
          module: "ipc/conversation",
          func: "update-sub-agent-status",
          message: "Sub-agent session failed",
          context: `conversation=${conversationId.trim()} status=${normalizedStatus}`,
          error: normalizedError,
        });
      } else {
        snowLog.info({
          module: "ipc/conversation",
          func: "update-sub-agent-status",
          message: "Sub-agent session status updated",
          context: `conversation=${conversationId.trim()} status=${normalizedStatus}`,
        });
      }
      await native.updateSubAgentSessionStatus(
        conversationId.trim(),
        normalizedStatus,
        normalizedError
      );
    }
  );
  // ===== Conversation export =====
  // Rust 端负责从 SQLite 读取会话与消息并格式化为目标格式文本，
  // 主进程负责弹出保存对话框并将文本写入用户选择的文件路径。
  ipcMain.handle(
    "chat-conversations:export",
    async (
      event,
      conversationId: unknown,
      format: unknown,
      defaultFileName: unknown
    ) => {
      if (typeof conversationId !== "string" || !conversationId.trim()) {
        throw new Error("Conversation ID is required to export conversation");
      }
      if (typeof format !== "string" || !isExportFormat(format)) {
        throw new Error(
          `Unsupported export format: ${String(
            format
          )}. Supported: ${EXPORT_FORMATS.join(", ")}`
        );
      }

      const normalizedFormat = format as ExportFormat;
      const extension = EXPORT_EXTENSIONS[normalizedFormat];

      // 1) 让 Rust 在 spawn_blocking 中读取数据库并生成导出内容
      const content = await native.exportConversation(
        conversationId.trim(),
        normalizedFormat
      );

      // 2) 弹出保存对话框，让用户选择保存路径
      const baseName =
        typeof defaultFileName === "string" && defaultFileName.trim()
          ? defaultFileName.trim()
          : "conversation";
      const browserWindow = BrowserWindow.fromWebContents(event.sender);
      const options: Electron.SaveDialogOptions = {
        title: "Export conversation",
        defaultPath: `${baseName}.${extension}`,
        filters: [
          { name: EXPORT_LABELS[normalizedFormat], extensions: [extension] },
        ],
      };
      const result = browserWindow
        ? await dialog.showSaveDialog(browserWindow, options)
        : await dialog.showSaveDialog(options);

      if (result.canceled || !result.filePath) {
        return { success: false, canceled: true, filePath: null };
      }

      // 3) 将内容写入用户选择的文件
      await writeFile(result.filePath, content, "utf-8");

      snowLog.info({
        module: "ipc/conversation",
        func: "export",
        message: "Conversation exported",
        context: `conversation=${conversationId.trim()} format=${normalizedFormat} file=${
          result.filePath
        }`,
      });

      return { success: true, canceled: false, filePath: result.filePath };
    }
  );
};
