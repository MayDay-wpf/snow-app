import type { ResponsesApiStreamChunk } from "../../../../../preload/types/api";
import type {
  ChatConversationMessage,
  ConversationSessionRef,
} from "./conversationTypes";

/**
 * 一次 run（一次用户发送/自动续跑触发的整轮 agent loop）的结束原因。
 *
 * 引入之前，结束状态只有「是否取消」与「是否失败」两个布尔值：用户点停止、
 * 被新消息取代、请求超时、上游报错、工具被拒绝在日志里长得一样，排障只能靠猜。
 * 现在每条结束路径都必须显式给出原因，收尾时写入结构化日志并透传给 onStop。
 *
 * `unknown` 是兜底值：出现即代表有一条结束路径没有显式给出原因，属于缺陷，
 * 不得作为默认值使用。
 */
export type RunEndReason =
  | "completed"
  | "user_abort"
  | "superseded"
  | "timeout"
  | "provider_error"
  | "tool_denied"
  | "budget_exhausted"
  | "hook_aborted"
  | "internal_error"
  | "unknown";

/** 定时任务 / 工作流节点等后台调用方看到的一句失败说明。 */
const RUN_END_REASON_ERRORS: Partial<Record<RunEndReason, string>> = {
  user_abort: "Run was stopped by the user",
  superseded: "Run was superseded by a newer request",
  timeout: "The provider did not respond within the stream idle timeout",
  provider_error: "The provider returned an error",
  tool_denied: "The requested tool calls were not authorized",
  budget_exhausted: "The Goal Mode token budget was exhausted",
  hook_aborted: "A hook aborted the run",
  internal_error: "The run failed inside the app before the provider replied",
};

export const runEndReasonErrorText = (
  reason: RunEndReason,
): string | undefined => RUN_END_REASON_ERRORS[reason];

/**
 * 结束原因登记表：一次取消（用户停止 / 强行发送取代 / 回滚 / 删除会话）只对
 * 「当时正在跑的那一轮」有效，因此按 runId 精确登记，绝不靠读 isAbortRequested
 * 反推——强行发送会先 handleAbort 再立刻启动新 run，新 run 会把
 * isAbortRequested 清成 false，旧 run 醒来时已经看不出「谁停了我」。
 *
 * 键是会话 ref 对象而不是会话 key：pending 槽位迁移到真实会话 id 时会话 key
 * 会变，但 ref 对象不变，用对象作键才能跨迁移命中同一轮。
 */
const cancelReasons = new WeakMap<
  ConversationSessionRef,
  { runId: number; reason: RunEndReason }
>();

/**
 * 登记「谁结束了这一轮」：取消方先推进 ref.runId，再把新 runId 记进来，收尾的
 * 旧 run 读到的 ref.runId 正是这个值，因此能精确命中「停我的那一次取消」。
 */
export const registerRunCancelReason = (
  ref: ConversationSessionRef | undefined,
  runId: number,
  reason: RunEndReason,
): void => {
  if (!ref) return;
  cancelReasons.set(ref, { runId, reason });
};

/**
 * 判定一轮为什么被取消：优先用登记的原因；没有登记时按会话状态区分
 * 「用户主动停止」（ref 已释放/已标记中止）与「被新 run 取代」。
 */
export const classifyRunCancellation = (
  ref: ConversationSessionRef | undefined,
): RunEndReason => {
  if (!ref) return "user_abort";
  const registered = cancelReasons.get(ref);
  if (registered && registered.runId === ref.runId) return registered.reason;
  return ref.isAbortRequested ? "user_abort" : "superseded";
};

/** 该轮结束后清掉登记项，避免取消原因跨轮残留。 */
export const clearRunCancelReason = (
  ref: ConversationSessionRef | undefined,
): void => {
  if (!ref) return;
  cancelReasons.delete(ref);
};

/**
 * 上游重试计数：同一轮里重试成功不记失败，只记一次重试次数。
 *
 * 后端把每次尝试边界作为 `retrying` 分片推下来（尝试序号或退避时长变化即新
 * 一轮尝试），这里据此计数；计数只进结束日志，不影响任何展示。
 */
export const createRetryCounter = (): {
  observe: (chunk: ResponsesApiStreamChunk) => void;
  count: () => number;
} => {
  let count = 0;
  let attempt: number | undefined;
  let backoffMs: number | undefined;
  return {
    observe: (chunk) => {
      if (!chunk.retrying) return;
      const nextAttempt = chunk.retryAttempt ?? undefined;
      const nextBackoff = chunk.retryBackoffMs ?? undefined;
      if (count > 0 && nextAttempt === attempt && nextBackoff === backoffMs) {
        return;
      }
      count += 1;
      attempt = nextAttempt;
      backoffMs = nextBackoff;
    },
    count: () => count,
  };
};

/** run 结束日志的上下文（与后端日志的 JSON context 同构）。 */
export type RunEndLogContext = {
  conversationId: string;
  runId: number;
  endReason: RunEndReason;
  durationMs: number;
  requestCount: number;
  retried: number;
  /** 最后一条助手消息的终态，便于区分「空响应」这类结构问题。 */
  lastMessageStatus: ChatConversationMessage["status"] | "none";
};

export type RunEndLog = RunEndLogContext & { message: string };

export const buildRunEndLog = (input: RunEndLogContext): RunEndLog => ({
  ...input,
  message:
    input.endReason === "completed"
      ? "Agent run completed"
      : input.endReason === "user_abort" || input.endReason === "superseded"
        ? "Agent run stopped"
        : "Agent run failed",
});
