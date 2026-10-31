import type {
  ConversationContextValue,
  PendingQueueItem,
} from "./conversationTypes";

/**
 * 同步某会话的待发送队列显示镜像：
 * - 该会话是主视图当前激活会话时，同时更新主视图的 activePendingMessages；
 * - 始终更新按会话隔离的镜像（会话面板据此渲染自己会话的队列）。
 */
const writePendingMirror = (
  ctx: ConversationContextValue,
  sessionKey: string,
  queue: PendingQueueItem[],
): void => {
  const messages = queue.map((item) => item.text);
  const modes = queue.map((item) =>
    item.options.deliveryMode === "steer"
      ? ("steer" as const)
      : ("queue" as const),
  );
  ctx.setPendingQueueMirrors((prev) => {
    const previous = prev[sessionKey];
    if (
      previous &&
      previous.messages.length === messages.length &&
      previous.messages.every((text, index) => text === messages[index]) &&
      (previous.modes?.length ?? 0) === modes.length &&
      (previous.modes ?? []).every((mode, index) => mode === modes[index])
    ) {
      return prev;
    }
    if (queue.length === 0) {
      if (!previous) {
        return prev;
      }
      const next = { ...prev };
      delete next[sessionKey];
      return next;
    }
    return { ...prev, [sessionKey]: { messages, modes } };
  });
};

/** Keep the visible queue scoped to its owning conversation. */
export const refreshPendingMessages = (
  ctx: ConversationContextValue,
  sessionKey: string,
): void => {
  const queue = ctx.pendingQueueRef.current.get(sessionKey) ?? [];
  if (ctx.activeSessionKeyRef.current === sessionKey) {
    ctx.setActivePendingMessages(queue.map((item) => item.text));
  }
  writePendingMirror(ctx, sessionKey, queue);
};

export const hasPendingSteering = (
  ctx: ConversationContextValue,
  sessionKey: string,
): boolean => {
  const runId = ctx.sessionsRefData.current.get(sessionKey)?.runId;
  return (ctx.pendingQueueRef.current.get(sessionKey) ?? []).some(
    (item) =>
      item.options.deliveryMode === "steer" &&
      (item.steeringRunId === undefined || item.steeringRunId === runId),
  );
};

/** Call only at a settled tool/model boundary. Never consume follow-up tasks.
 * Selection is synchronous so withdrawals and new arrivals cannot race an await.
 * Steers for a replaced generation become ordinary follow-ups, not new steers. */
export const takePendingSteering = (
  ctx: ConversationContextValue,
  sessionKey: string,
): PendingQueueItem[] => {
  const ref = ctx.sessionsRefData.current.get(sessionKey);
  if (!ref?.isSending || ref.isAbortRequested) return [];
  const queue = ctx.pendingQueueRef.current.get(sessionKey) ?? [];
  const selected: PendingQueueItem[] = [];
  const remaining: PendingQueueItem[] = [];
  for (const item of queue) {
    if (item.options.deliveryMode !== "steer") {
      remaining.push(item);
    } else if (
      item.steeringRunId !== undefined &&
      item.steeringRunId !== ref.runId
    ) {
      remaining.push({
        ...item,
        options: { ...item.options, deliveryMode: "queue" },
        steeringRunId: undefined,
      });
    } else {
      selected.push(item);
    }
  }
  if (remaining.length) ctx.pendingQueueRef.current.set(sessionKey, remaining);
  else ctx.pendingQueueRef.current.delete(sessionKey);
  refreshPendingMessages(ctx, sessionKey);
  return selected;
};

/** A complete run consumes one follow-up, preserving its own options and FIFO. */
export const takeNextQueuedMessage = (
  ctx: ConversationContextValue,
  sessionKey: string,
): PendingQueueItem | undefined => {
  const queue = ctx.pendingQueueRef.current.get(sessionKey);
  const item = queue?.shift();
  if (queue && !queue.length) ctx.pendingQueueRef.current.delete(sessionKey);
  refreshPendingMessages(ctx, sessionKey);
  return item;
};

/** Once a run stops, unconsumed steers remain withdrawable as ordinary tasks. */
export const demotePendingSteering = (
  ctx: ConversationContextValue,
  sessionKey: string,
): void => {
  const queue = ctx.pendingQueueRef.current.get(sessionKey);
  if (!queue) return;
  for (const item of queue) {
    if (item.options.deliveryMode === "steer") {
      item.options = { ...item.options, deliveryMode: "queue" };
      item.steeringRunId = undefined;
    }
  }
  refreshPendingMessages(ctx, sessionKey);
};
