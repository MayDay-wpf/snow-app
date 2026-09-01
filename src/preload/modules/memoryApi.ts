import { ipcRenderer } from "electron";
import type {
  MemoryKind,
  MemoryPage,
  MemoryRecord,
  MemoryStats,
  MemoryStatus,
} from "../types";

export const memoryApi = {
  listProjectMemories: (
    directoryId: string,
    limit: number,
    offset: number,
    status?: MemoryStatus,
    kind?: MemoryKind,
  ): Promise<MemoryPage> =>
    ipcRenderer.invoke(
      "memories:list",
      directoryId,
      limit,
      offset,
      status,
      kind,
    ),

  createProjectMemory: (
    directoryId: string,
    kind: MemoryKind,
    title: string,
    content: string,
    importance?: number,
    tags?: string[],
  ): Promise<MemoryRecord> =>
    ipcRenderer.invoke(
      "memories:create",
      directoryId,
      kind,
      title,
      content,
      importance,
      tags,
    ),

  updateProjectMemory: (
    memoryId: string,
    updates: {
      kind?: MemoryKind;
      title?: string;
      content?: string;
      importance?: number;
      status?: MemoryStatus;
      tags?: string[];
    },
  ): Promise<MemoryRecord> =>
    ipcRenderer.invoke(
      "memories:update",
      memoryId,
      updates.kind,
      updates.title,
      updates.content,
      updates.importance,
      updates.status,
      updates.tags,
    ),

  deleteProjectMemory: (memoryId: string): Promise<boolean> =>
    ipcRenderer.invoke("memories:delete", memoryId),

  clearProjectMemories: (directoryId: string): Promise<number> =>
    ipcRenderer.invoke("memories:clear", directoryId),

  getProjectMemoryStats: (directoryId: string): Promise<MemoryStats> =>
    ipcRenderer.invoke("memories:stats", directoryId),

  /** 删除确认弹窗用：统计一组会话（含级联子会话）关联的记忆条数。 */
  countProjectMemoriesByConversations: (
    conversationIds: string[],
  ): Promise<number> =>
    ipcRenderer.invoke("memories:count-by-conversations", conversationIds),

  listProjectMemoriesByConversation: (
    conversationId: string,
    limit?: number,
  ): Promise<MemoryRecord[]> =>
    ipcRenderer.invoke(
      "memories:list-by-conversation",
      conversationId,
      limit,
    ),

  deleteProjectMemoriesByConversation: (
    conversationId: string,
  ): Promise<number> =>
    ipcRenderer.invoke("memories:delete-by-conversation", conversationId),
};
