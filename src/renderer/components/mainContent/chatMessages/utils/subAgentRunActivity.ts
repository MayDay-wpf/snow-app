import type { ChatConversationMessage } from "./conversationTypes";

/**
 * 子代理运行的工具调用活动摘要（父会话子代理卡片的进度列表与计数）。
 *
 * 卡片原本直接从子代理会话的内存消息里提取；子会话消息被窗口裁剪或随 TTL
 * 回收后，被卸载部分的工具调用先归档为轻量摘要（只有 id / 名称 / 状态 /
 * 一行摘要），卡片合并「归档 + 内存中消息」展示，列表不随内存回收而丢失。
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 归档的运行条数上限（每条仅为若干短字符串，超限淘汰最早写入的运行）。 */
const ARCHIVED_RUN_LIMIT = 200;

export type SubAgentToolCallEntry = {
  id: string;
  name: string;
  status: "pending" | "running" | "completed" | "error";
  summary: string;
};

const getToolSummary = (name: string, args: string): string => {
  try {
    const parsed: unknown = JSON.parse(args);
    if (!isRecord(parsed)) {
      return "";
    }
    const shortName = name.replace(/^.*?-/, "");
    switch (shortName) {
      case "read":
      case "replace_edit":
      case "create":
        return typeof parsed.filePath === "string" ? parsed.filePath : "";
      case "terminal-execute":
        if (typeof parsed.command === "string") {
          const firstLine = parsed.command.split("\n")[0];
          return firstLine.length > 80
            ? `${firstLine.slice(0, 80)}...`
            : firstLine;
        }
        return "";
      case "search":
        return typeof parsed.pattern === "string" ? parsed.pattern : "";
      case "todo-manage":
        return typeof parsed.action === "string" ? parsed.action : "";
      case "askUserQuestion":
        return typeof parsed.question === "string" ? parsed.question : "";
      case "agents-sendMessage": {
        const message =
          typeof parsed.message === "string" ? parsed.message.trim() : "";
        if (!message) {
          return "";
        }
        const firstLine = message.split("\n")[0];
        return firstLine.length > 80
          ? `${firstLine.slice(0, 80)}...`
          : firstLine;
      }
      default:
        return "";
    }
  } catch {
    return "";
  }
};

const extractSubAgentToolCalls = (
  messages: ChatConversationMessage[] | undefined,
): SubAgentToolCallEntry[] => {
  const entries: SubAgentToolCallEntry[] = [];

  if (!messages) {
    return entries;
  }

  for (const message of messages) {
    if (message.role !== "assistant" || !message.toolCalls) {
      continue;
    }
    for (const tc of message.toolCalls) {
      entries.push({
        id: tc.callId ?? `${tc.name}-${entries.length}`,
        name: tc.name,
        status: tc.status,
        summary: getToolSummary(tc.name, tc.arguments),
      });
    }
  }

  return entries;
};

/** runId → 已从内存卸载的工具调用摘要（按 id 去重，插入序即调用序）。 */
const archivedRunActivity = new Map<
  string,
  Map<string, SubAgentToolCallEntry>
>();

/**
 * 归档即将卸载的子代理消息中的工具调用摘要（消息窗口裁剪 / 会话回收前调用）。
 * 按 id 覆盖写入，重复归档同一批消息是幂等的。
 */
export const archiveSubAgentRunActivity = (
  messages: ChatConversationMessage[],
): void => {
  for (const message of messages) {
    const runId = message.subAgentRunId;
    if (!runId || message.role !== "assistant" || !message.toolCalls?.length) {
      continue;
    }
    const archived = archivedRunActivity.get(runId) ?? new Map();
    for (const entry of extractSubAgentToolCalls([message])) {
      archived.set(entry.id, entry);
    }
    archivedRunActivity.delete(runId);
    archivedRunActivity.set(runId, archived);
  }
  while (archivedRunActivity.size > ARCHIVED_RUN_LIMIT) {
    const oldest = archivedRunActivity.keys().next();
    if (oldest.done) break;
    archivedRunActivity.delete(oldest.value);
  }
};

/** 指定运行的工具调用活动：已归档部分在前，内存中仍在的消息覆盖同 id 条目。 */
export const subAgentRunActivity = (
  runId: string,
  messages: ChatConversationMessage[] | undefined,
): SubAgentToolCallEntry[] => {
  const live = extractSubAgentToolCalls(
    messages?.filter((message) => message.subAgentRunId === runId),
  );
  const archived = archivedRunActivity.get(runId);
  if (!archived?.size) {
    return live;
  }
  const liveIds = new Set(live.map((entry) => entry.id));
  return [
    ...Array.from(archived.values()).filter((entry) => !liveIds.has(entry.id)),
    ...live,
  ];
};
