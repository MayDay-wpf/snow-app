// 统一 Hook 闸门：主 loop 与 WorkFlow 节点共用同一套执行/解析/记录语义。
// 节点执行在 workflowRunner 内自建 agent loop，必须显式经过这些闸门才能与主
// loop 表现一致：exit 0 注入上下文、exit 1 警告、exit 2+ 中止、needsDecision
// 等用户裁决，且执行记录挂到对应消息上。

import type {
  ConversationContextValue,
  HookExecutionRecord,
} from "../utils/conversationTypes";
import type { createAwaitHookDecision } from "./agentLoopHelpers";
import {
  appendHookExecutionToMessage,
  runHook,
  toNonBlockingRecord,
} from "./hookOutcome";

export type HookGateDeps = {
  ctx: ConversationContextValue;
  /** 执行记录与决策卡片挂载的会话（节点会话 / 主会话）。 */
  sessionKey: string;
  /** hook 的 project 作用域（目录 id）。 */
  projectId?: string;
  /** hook context 中的 cwd。 */
  cwd: string;
  awaitHookDecision: ReturnType<typeof createAwaitHookDecision>;
};

const appendRecord = (
  deps: HookGateDeps,
  record: HookExecutionRecord,
  messageId?: string,
): void => {
  deps.ctx.updateSessionMessages(deps.sessionKey, (messages) =>
    appendHookExecutionToMessage(messages, record, messageId),
  );
};

/** 工具 Hook 闸门结果：pass 携带可注入的上下文（afterToolCall 用）。 */
export type ToolHookGateOutcome =
  | { kind: "none" }
  | { kind: "pass"; context: string | null }
  | { kind: "warn"; message: string }
  | { kind: "abort"; message: string };

/** beforeToolCall / afterToolCall：执行前/后的阻塞式闸门。 */
export const runToolHookGate = async (
  deps: HookGateDeps,
  hookType: "beforeToolCall" | "afterToolCall",
  payload: { toolName: string; args: unknown; result?: unknown },
  messageId: string,
): Promise<ToolHookGateOutcome> => {
  let hookResult: Awaited<ReturnType<typeof runHook>>;
  try {
    hookResult = await runHook(
      hookType,
      deps.projectId,
      JSON.stringify({ ...payload, cwd: deps.cwd }),
    );
  } catch {
    // 与主 loop 一致：hook 自身执行失败时放行，不阻断工具调用。
    return { kind: "none" };
  }
  if (!hookResult) {
    return { kind: "none" };
  }
  const { outcome } = hookResult;
  if (outcome.kind === "needsDecision") {
    const approved = await deps.awaitHookDecision(
      deps.sessionKey,
      messageId,
      hookResult.record,
    );
    return approved
      ? { kind: "pass", context: null }
      : { kind: "abort", message: outcome.message };
  }
  appendRecord(deps, hookResult.record, messageId);
  if (outcome.kind === "abort") {
    return { kind: "abort", message: outcome.message };
  }
  if (outcome.kind === "warn") {
    return { kind: "warn", message: outcome.message };
  }
  return { kind: "pass", context: outcome.context };
};

/** onUserMessage 闸门结果：context / warn 由调用方拼到待发送文本后。 */
export type UserMessageHookGateOutcome =
  | { kind: "pass" }
  | { kind: "context"; context: string }
  | { kind: "warn"; message: string }
  | { kind: "abort"; message: string };

/** onUserMessage：用户消息进入 AI 前的闸门（决策通过后仍按原文发送）。 */
export const runUserMessageHookGate = async (
  deps: HookGateDeps,
  params: { messageId: string; text: string },
): Promise<UserMessageHookGateOutcome> => {
  let hookResult: Awaited<ReturnType<typeof runHook>>;
  try {
    hookResult = await runHook(
      "onUserMessage",
      deps.projectId,
      JSON.stringify({
        message: params.text,
        cwd: deps.cwd,
        sessionId: deps.sessionKey,
      }),
    );
  } catch {
    // 与主 loop 一致：hook 失败时按原文发送。
    return { kind: "pass" };
  }
  if (!hookResult) {
    return { kind: "pass" };
  }
  const { outcome } = hookResult;
  if (outcome.kind === "needsDecision") {
    const approved = await deps.awaitHookDecision(
      deps.sessionKey,
      params.messageId,
      hookResult.record,
    );
    return approved
      ? { kind: "pass" }
      : { kind: "abort", message: outcome.message };
  }
  appendRecord(deps, hookResult.record, params.messageId);
  if (outcome.kind === "abort") {
    return { kind: "abort", message: outcome.message };
  }
  if (outcome.kind === "warn") {
    return { kind: "warn", message: outcome.message };
  }
  return outcome.context
    ? { kind: "context", context: outcome.context }
    : { kind: "pass" };
};

/** 把 onUserMessage 结果应用到待发送文本（与主 loop 的拼接格式一致）。 */
export const applyUserMessageHookOutcome = (
  text: string,
  outcome: UserMessageHookGateOutcome,
): string => {
  if (outcome.kind === "warn") {
    return `${text}\n\n[Hook Warning]\n${outcome.message}`;
  }
  if (outcome.kind === "context") {
    return `${text}\n\n[Hook Context]\n${outcome.context}`;
  }
  return text;
};

/** onSessionStart：会话开始（不可阻断，记录降级为普通警告）。 */
export const runSessionStartHookGate = (
  deps: HookGateDeps,
  params: { messageId?: string; directoryId?: string },
): void => {
  const context = JSON.stringify({
    conversationId: deps.sessionKey,
    cwd: deps.cwd,
    directoryId: params.directoryId ?? deps.projectId ?? "",
  });
  void runHook("onSessionStart", deps.projectId, context)
    .then((hookResult) => {
      if (hookResult) {
        appendRecord(
          deps,
          toNonBlockingRecord(hookResult.record),
          params.messageId,
        );
      }
    })
    .catch(() => {
      // onSessionStart 失败不阻断会话
    });
};

/** onStop：一次 run 结束（不可阻断，记录降级为普通警告）。 */
export const runStopHookGate = async (
  deps: HookGateDeps,
  params: { reason: "completed" | "aborted"; endReason?: string },
): Promise<void> => {
  const anchorId = deps.ctx.sessionsRef.current?.[
    deps.sessionKey
  ]?.messages.findLast((message) => message.role !== "tool")?.id;
  const context = JSON.stringify({
    conversationId: deps.sessionKey,
    cwd: deps.cwd,
    reason: params.reason,
    ...(params.endReason ? { endReason: params.endReason } : {}),
  });
  const hookResult = await runHook("onStop", deps.projectId, context).catch(
    () => null,
  );
  if (hookResult) {
    appendRecord(deps, toNonBlockingRecord(hookResult.record), anchorId);
  }
};
