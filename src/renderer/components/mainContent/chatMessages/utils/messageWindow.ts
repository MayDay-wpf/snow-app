import type {
  ChatConversationMessage,
  ConversationSessionState,
  MessageRecordRef,
} from "./conversationTypes";
import { archiveSubAgentRunActivity } from "./subAgentRunActivity";

/**
 * 会话消息窗口：长会话（含运行中）只在渲染进程保留尾部窗口，更早的消息
 * 卸载回数据库，由 loadOlderMessages 按游标翻页取回。
 * 裁剪时机：新 AI 消息追加时；视图正在查看该会话且未钉底（阅读历史）时跳过。
 * 后台会话（含子代理会话）不在视图中，使用更小的窗口：切回时首屏仍是尾部
 * 消息，向上滚动按游标取回，观看体验不变。
 */

/** 超过 limit 条才裁剪；裁剪后保留尾部约 keep 条（滞回，避免逐条裁剪）。 */
export type MessageWindowSize = { limit: number; keep: number };

const VIEWED_MESSAGE_WINDOW: MessageWindowSize = { limit: 80, keep: 40 };
const BACKGROUND_MESSAGE_WINDOW: MessageWindowSize = { limit: 30, keep: 16 };
/** 单次至少卸载的条数，收益太小不裁。 */
const MESSAGE_WINDOW_MIN_TRIM = 10;

const SNOWFLAKE_ID = /^\d+$/;

type MessageWindowViewGate = {
  /** 视图当前展示的会话 key。 */
  sessionKey: () => string | undefined;
  /** 视图是否处于自动滚动钉底状态。 */
  isFollowingBottom: () => boolean;
};

let viewGate: MessageWindowViewGate | null = null;

/** 聊天视图注册钉底门控，返回注销函数。 */
export const registerMessageWindowViewGate = (
  gate: MessageWindowViewGate,
): (() => void) => {
  viewGate = gate;
  return () => {
    if (viewGate === gate) {
      viewGate = null;
    }
  };
};

/**
 * 本次可用的裁剪窗口：视图正在查看且未钉底（阅读历史）时返回 null 不裁；
 * 视图展示的会话（或聊天区未挂载）用常规窗口，其余后台会话用小窗口。
 */
export const resolveMessageWindow = (
  sessionKey: string,
): MessageWindowSize | null => {
  const gate = viewGate;
  if (!gate) {
    return VIEWED_MESSAGE_WINDOW;
  }
  if (gate.sessionKey() !== sessionKey) {
    return BACKGROUND_MESSAGE_WINDOW;
  }
  return gate.isFollowingBottom() ? VIEWED_MESSAGE_WINDOW : null;
};

/** 本次更新是否在尾部追加了一条新的 AI 消息。 */
export const isAssistantMessageAppended = (
  previous: ChatConversationMessage[],
  next: ChatConversationMessage[],
): boolean => {
  if (next.length <= previous.length) {
    return false;
  }
  const last = next[next.length - 1];
  return (
    last?.role === "assistant" && last.id !== previous[previous.length - 1]?.id
  );
};

const recordIdOf = (message: ChatConversationMessage): string | undefined => {
  if (message.role === "tool") {
    return undefined;
  }
  if (message.recordId) {
    return message.recordId;
  }
  return SNOWFLAKE_ID.test(message.id) ? message.id : undefined;
};

/** snowflake 字符串按数值比较。 */
const compareRecordIds = (left: string, right: string): number => {
  if (left.length !== right.length) {
    return left.length - right.length;
  }
  return left < right ? -1 : left > right ? 1 : 0;
};

/** 仍在接收运行时更新的消息不可卸载（流式、执行中的工具、待答提问等）。 */
const isMessageSettled = (message: ChatConversationMessage): boolean =>
  message.status !== "sending" &&
  !message.isRetrying &&
  !message.isThinkingActive &&
  !(message.toolCalls ?? []).some(
    (toolCall) =>
      toolCall.status === "pending" ||
      toolCall.status === "running" ||
      toolCall.userQuestion?.status === "waiting" ||
      toolCall.correction?.status === "running",
  ) &&
  !(message.hookExecutions ?? []).some((record) => record.pendingDecision);

/**
 * 裁掉窗口头部，返回新会话状态；无需或无法裁剪时返回 null。
 * 切点必须是带库 id 的消息：它就是向前翻页的游标，库中 id 小于它的记录
 * 恰好对应被卸载的部分。
 */
export const trimSessionMessageWindow = (
  session: ConversationSessionState,
  size: MessageWindowSize,
): ConversationSessionState | null => {
  const { messages } = session;
  if (messages.length <= size.limit || session.isLoadingOlderMessages) {
    return null;
  }

  const firstUnsettled = messages.findIndex(
    (message) => !isMessageSettled(message),
  );
  const protectFrom = firstUnsettled < 0 ? messages.length - 1 : firstUnsettled;
  const target = Math.min(messages.length - size.keep, protectFrom);

  let cut = -1;
  let cursor: string | undefined;
  for (let index = target; index >= MESSAGE_WINDOW_MIN_TRIM; index--) {
    cursor = recordIdOf(messages[index]);
    if (cursor) {
      cut = index;
      break;
    }
  }
  if (cut < 0 || !cursor) {
    return null;
  }

  // 卸载的子代理消息先归档工具调用摘要，父会话卡片的进度列表不随裁剪丢失。
  archiveSubAgentRunActivity(messages.slice(0, cut));
  const retained = messages.slice(cut);
  const retainedIds = new Set(retained.map((message) => message.id));
  // 只保留与窗口内消息对应的记录；tool 记录跟随其前一条助手记录。
  const records: MessageRecordRef[] = [];
  let keepFollowingTools = false;
  for (const record of session.messageRecords) {
    if (compareRecordIds(record.id, cursor) < 0) {
      continue;
    }
    if (record.role === "tool") {
      if (keepFollowingTools) {
        records.push(record);
      }
      continue;
    }
    keepFollowingTools = retainedIds.has(record.id);
    if (keepFollowingTools) {
      records.push(record);
    }
  }

  return {
    ...session,
    messages: retained,
    messageRecords: records,
    hasMoreMessages: true,
    olderCursorId: cursor,
  };
};
