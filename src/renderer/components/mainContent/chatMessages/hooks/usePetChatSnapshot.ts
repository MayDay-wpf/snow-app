/**
 * 宠物聊天上下文同步：把当前打开会话的「实时运行快照」节流推送给主进程。
 *
 * 为什么需要它：宠物窗口的 btw 提问原先只能读数据库里的落库文本 —— 本轮
 * 还没结束那里什么都没有，工具步骤更不落库，于是宠物只能含糊其辞或答非
 * 所问。这里直接取渲染层的活数据：在途助手正文、每一次工具调用的名称 /
 * 参数 / 状态 / 结果摘要、待办进度、运行状态、模型与工作区。
 *
 * 节流：消息在流式期间每帧都在变，重建 + 上报按「首次立即、其余 400ms
 * 合并」的节奏进行，避免每个 token 都做一次全量序列化与 IPC。
 */
import { useEffect, useRef } from "react";
import type {
  PetChatLiveMessage,
  PetChatSnapshot,
  PetChatToolLine,
} from "../../../../../preload/types/pets";
import { summarizeContentAsPlainText } from "../../chatInput/fileTagUtils";
import type { ChatConversationMessage } from "../utils/conversationTypes";
import { useTodoPanel, type TodoItem } from "./useTodoPanel";

/** 上报节流窗口（毫秒）。 */
const THROTTLE_MS = 400;
/** 快照预算：条数 / 单条字符 / 每条消息携带的工具行数。 */
const MAX_SNAPSHOT_MESSAGES = 24;
const MAX_SNAPSHOT_CONTENT_CHARS = 2000;
const MAX_TOOL_LINES_PER_MESSAGE = 6;
const MAX_TOOL_DETAIL_CHARS = 100;
const MAX_TOOL_RESULT_CHARS = 120;

/** 工具参数里优先取用的字段（按“最能说明这一步在干什么”排序）。 */
const TOOL_DETAIL_KEYS = [
  "command",
  "filePath",
  "path",
  "pattern",
  "query",
  "url",
  "to",
  "prompt",
  "text",
  "content",
  "name",
  "scriptPath",
];

export type PetChatSnapshotInputs = {
  conversationId: string | null;
  title: string | null;
  /** 会话所属项目的 directoryId：宠物工具调用的项目锚点。 */
  directoryId: string | null;
  workspacePath: string | null;
  isStreaming: boolean;
  isPaused: boolean;
  messages: ChatConversationMessage[];
};

/** 折叠空白为单空格并截断，保证工具摘要始终是单行。 */
const collapse = (text: string, max: number): string => {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max)}…`;
};

/** 从工具参数 JSON 里提取一句“在做什么”的摘要。 */
const summarizeToolArguments = (raw: string | undefined): string => {
  if (!raw) {
    return "";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return collapse(raw, MAX_TOOL_DETAIL_CHARS);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return typeof parsed === "string"
      ? collapse(parsed, MAX_TOOL_DETAIL_CHARS)
      : "";
  }
  const record = parsed as Record<string, unknown>;
  for (const key of TOOL_DETAIL_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return collapse(value, MAX_TOOL_DETAIL_CHARS);
    }
  }
  for (const value of Object.values(record)) {
    if (typeof value === "string" && value.trim()) {
      return collapse(value, MAX_TOOL_DETAIL_CHARS);
    }
  }
  return "";
};

const buildToolLines = (message: ChatConversationMessage): PetChatToolLine[] =>
  (message.toolCalls ?? []).slice(0, MAX_TOOL_LINES_PER_MESSAGE).map((call) => {
    const result = call.result
      ? collapse(call.result, MAX_TOOL_RESULT_CHARS)
      : undefined;
    return {
      name: call.name,
      detail: summarizeToolArguments(call.arguments),
      status: call.status,
      ...(result ? { result } : {}),
    };
  });

const buildLiveMessages = (
  messages: ChatConversationMessage[],
): PetChatLiveMessage[] => {
  const live: PetChatLiveMessage[] = [];
  for (const message of messages) {
    // 工具结果行由对应工具调用的 result 字段承载，不再重复注入原始输出。
    if (message.role === "tool" || message.isContextCompaction) {
      continue;
    }
    const tools = buildToolLines(message);
    const rawContent =
      message.role === "user"
        ? summarizeContentAsPlainText(message.content)
        : message.content;
    const content = collapse(rawContent, MAX_SNAPSHOT_CONTENT_CHARS);
    if (!content && tools.length === 0) {
      continue;
    }
    live.push({
      role: message.role === "assistant" ? "assistant" : "user",
      content,
      ...(tools.length > 0 ? { tools } : {}),
    });
  }
  return live.slice(-MAX_SNAPSHOT_MESSAGES);
};

const buildTodoSummary = (
  todos: TodoItem[],
  completedCount: number,
  totalCount: number,
): string | null => {
  if (totalCount === 0) {
    return null;
  }
  const parts = [`${completedCount}/${totalCount} done`];
  const inProgress = todos
    .filter((todo) => todo.status === "inProgress")
    .slice(0, 3)
    .map((todo) => collapse(todo.content, 80));
  if (inProgress.length > 0) {
    parts.push(`in progress: ${inProgress.join("; ")}`);
  }
  const pending = todos
    .filter((todo) => todo.status === "pending")
    .slice(0, 3)
    .map((todo) => collapse(todo.content, 80));
  if (pending.length > 0) {
    parts.push(`next: ${pending.join("; ")}`);
  }
  return parts.join(" · ");
};

const resolveModel = (messages: ChatConversationMessage[]): string | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const model = messages[index].model?.trim();
    if (model) {
      return model;
    }
  }
  return null;
};

/** 签名用于跳过无变化的重复上报（含末条长度，流式期间会持续变化）。 */
const buildSignature = (snapshot: PetChatSnapshot): string => {
  const toolCount = snapshot.messages.reduce(
    (total, message) => total + (message.tools?.length ?? 0),
    0,
  );
  const lastMessage = snapshot.messages[snapshot.messages.length - 1];
  return [
    snapshot.conversationId ?? "",
    snapshot.title ?? "",
    snapshot.directoryId ?? "",
    snapshot.workspacePath ?? "",
    snapshot.model ?? "",
    snapshot.status,
    snapshot.todoSummary ?? "",
    snapshot.messages.length,
    toolCount,
    lastMessage ? `${lastMessage.role}:${lastMessage.content.length}` : "",
  ].join("|");
};

export const usePetChatSnapshot = (
  inputs: PetChatSnapshotInputs,
  /** false = 该聊天表面不上报宠物快照（同一窗口只允许主聊天表面上报）。 */
  enabled = true,
): void => {
  const { todos, completedCount, totalCount } = useTodoPanel(inputs.messages);
  const latestRef = useRef<{
    inputs: PetChatSnapshotInputs;
    todoSummary: string | null;
  }>({ inputs, todoSummary: null });
  const timerRef = useRef<number | null>(null);
  const lastFlushAtRef = useRef(0);
  const lastSignatureRef = useRef("");
  const lastConversationIdRef = useRef<string | null | undefined>(undefined);

  const flush = (): void => {
    lastFlushAtRef.current = Date.now();
    const { inputs: current, todoSummary } = latestRef.current;
    const snapshot: PetChatSnapshot = {
      conversationId: current.conversationId,
      title: current.title,
      directoryId: current.directoryId,
      workspacePath: current.workspacePath,
      model: resolveModel(current.messages),
      status: current.isPaused
        ? "paused"
        : current.isStreaming
          ? "streaming"
          : "idle",
      messages: buildLiveMessages(current.messages),
      todoSummary,
      updatedAt: Date.now(),
    };
    // 会话标识变化（切换 / 关闭会话）必须送达，其余按签名去重。
    const identityChanged =
      lastConversationIdRef.current !== snapshot.conversationId;
    const signature = buildSignature(snapshot);
    if (!identityChanged && signature === lastSignatureRef.current) {
      return;
    }
    lastConversationIdRef.current = snapshot.conversationId;
    lastSignatureRef.current = signature;
    window.snow.setPetChatContext(snapshot);
  };

  const requestFlush = (): void => {
    const elapsed = Date.now() - lastFlushAtRef.current;
    if (elapsed >= THROTTLE_MS) {
      flush();
      return;
    }
    if (timerRef.current === null) {
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        flush();
      }, THROTTLE_MS - elapsed);
    }
  };

  // 每次渲染后记录最新输入并按节流节奏上报（无依赖数组：流式期间
  // 消息每帧都在变，需要在最新一帧上重建）。
  useEffect(() => {
    if (!enabled) {
      return;
    }
    latestRef.current = {
      inputs,
      todoSummary: buildTodoSummary(todos, completedCount, totalCount),
    };
    requestFlush();
  });

  useEffect(
    () => () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    },
    [],
  );
};
