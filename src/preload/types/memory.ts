export type MemoryKind =
  "fact" | "decision" | "preference" | "pitfall" | "task_state";

export type MemoryStatus = "active" | "pending" | "archived";

export type MemorySource = "agent" | "auto" | "user";

/** 项目级持久记忆条目（按项目隔离的跨会话 AI 知识库）。 */
export type MemoryRecord = {
  id: string;
  memoryId: string;
  directoryId: string;
  kind: MemoryKind;
  title: string;
  content: string;
  source: MemorySource;
  status: MemoryStatus;
  /** 1-5；>= 3 的 active 条目自动注入新会话的系统提示词。 */
  importance: number;
  sessionId: string;
  /** 来源会话 ID（会话删除联动的锚点）。 */
  conversationId: string;
  /** 保存该记忆的 assistant response id（回滚清理锚点；旧数据为空串）。 */
  responseId: string;
  tags: string[];
  lastRecalledAt?: string;
  recallCount: number;
  createdAt: string;
  updatedAt: string;
};

export type MemoryPage = {
  items: MemoryRecord[];
  total: number;
  hasMore: boolean;
};

export type MemoryStats = {
  total: number;
  active: number;
  pending: number;
  archived: number;
};
