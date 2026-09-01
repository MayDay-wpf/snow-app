import { ipcMain } from "electron";
import type { NativeBridge } from "../../native/types";

const MEMORY_KINDS = [
  "fact",
  "decision",
  "preference",
  "pitfall",
  "task_state",
] as const;

const MEMORY_STATUSES = ["active", "pending", "archived"] as const;

const requireDirectoryId = (value: unknown): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Directory ID is required for project memories");
  }
  return value.trim();
};

const requireMemoryId = (value: unknown): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Memory ID is required");
  }
  return value.trim();
};

const optionalKind = (value: unknown): string | undefined =>
  typeof value === "string" &&
  (MEMORY_KINDS as readonly string[]).includes(value.trim().toLowerCase())
    ? value.trim().toLowerCase()
    : undefined;

const optionalStatus = (value: unknown): string | undefined =>
  typeof value === "string" &&
  (MEMORY_STATUSES as readonly string[]).includes(value.trim().toLowerCase())
    ? value.trim().toLowerCase()
    : undefined;

const optionalTags = (value: unknown): string[] | undefined =>
  Array.isArray(value)
    ? value
        .filter((tag): tag is string => typeof tag === "string")
        .map((tag) => tag.trim().toLowerCase())
        .filter((tag) => tag !== "")
    : undefined;

const optionalImportance = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.min(5, Math.max(1, Math.round(value)));
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) {
      return Math.min(5, Math.max(1, parsed));
    }
  }
  return undefined;
};

export const registerMemoryHandlers = (native: NativeBridge): void => {
  ipcMain.handle(
    "memories:list",
    (
      _event,
      directoryId: unknown,
      limit: unknown,
      offset: unknown,
      status: unknown,
      kind: unknown,
    ) => {
      const safeLimit =
        typeof limit === "number" && limit > 0 ? Math.floor(limit) : 50;
      const safeOffset =
        typeof offset === "number" && offset > 0 ? Math.floor(offset) : 0;
      return native.listProjectMemories(
        requireDirectoryId(directoryId),
        safeLimit,
        safeOffset,
        optionalStatus(status),
        optionalKind(kind),
      );
    },
  );

  ipcMain.handle(
    "memories:create",
    (
      _event,
      directoryId: unknown,
      kind: unknown,
      title: unknown,
      content: unknown,
      importance: unknown,
      tags: unknown,
    ) => {
      if (typeof title !== "string" || !title.trim()) {
        throw new Error("Memory title is required");
      }
      if (typeof content !== "string" || !content.trim()) {
        throw new Error("Memory content is required");
      }
      return native.upsertProjectMemory(
        requireDirectoryId(directoryId),
        optionalKind(kind) ?? "fact",
        title,
        content,
        optionalImportance(importance) ?? 2,
        optionalTags(tags),
        // 手动面板创建：source=user，status=active
        "user",
        "active",
      );
    },
  );

  ipcMain.handle(
    "memories:update",
    (
      _event,
      memoryId: unknown,
      kind: unknown,
      title: unknown,
      content: unknown,
      importance: unknown,
      status: unknown,
      tags: unknown,
    ) => {
      return native.updateProjectMemory(
        requireMemoryId(memoryId),
        optionalKind(kind),
        typeof title === "string" && title.trim() ? title : undefined,
        typeof content === "string" && content.trim() ? content : undefined,
        optionalImportance(importance),
        optionalStatus(status),
        optionalTags(tags),
      );
    },
  );

  ipcMain.handle("memories:delete", (_event, memoryId: unknown) => {
    return native.deleteProjectMemory(requireMemoryId(memoryId));
  });

  ipcMain.handle("memories:clear", (_event, directoryId: unknown) => {
    return native.clearProjectMemories(requireDirectoryId(directoryId));
  });

  ipcMain.handle("memories:stats", (_event, directoryId: unknown) => {
    return native.getProjectMemoryStats(requireDirectoryId(directoryId));
  });

  ipcMain.handle(
    "memories:count-by-conversations",
    (_event, conversationIds: unknown) => {
      const safeIds = Array.isArray(conversationIds)
        ? conversationIds.filter(
            (id): id is string => typeof id === "string" && id.trim() !== "",
          )
        : [];
      return native.countProjectMemoriesByConversations(safeIds);
    },
  );

  ipcMain.handle(
    "memories:list-by-conversation",
    (_event, conversationId: unknown, limit: unknown) => {
      if (typeof conversationId !== "string" || !conversationId.trim()) {
        throw new Error("Conversation ID is required");
      }
      const safeLimit =
        typeof limit === "number" && limit > 0 ? Math.floor(limit) : 50;
      return native.listProjectMemoriesByConversation(
        conversationId.trim(),
        safeLimit,
      );
    },
  );

  ipcMain.handle(
    "memories:delete-by-conversation",
    (_event, conversationId: unknown) => {
      if (typeof conversationId !== "string" || !conversationId.trim()) {
        throw new Error("Conversation ID is required");
      }
      return native.deleteProjectMemoriesByConversation(conversationId.trim());
    },
  );
};
