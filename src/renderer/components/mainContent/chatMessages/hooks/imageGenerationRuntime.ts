import { useEffect } from "react";
import {
  isImageGenerationTerminal,
  parseImageGenerationTask,
  type ImageGenerationBatchSnapshot,
  type ImageGenerationTaskSnapshot,
} from "../../../../../shared/imageGeneration";
import { tGlobal } from "../../../../i18n";
import { writeRendererLog } from "../../../../utils/rendererLog";
import { isRecord } from "../toolCalls/imagegenUtils";
import { buildConversationMessages } from "../utils/conversationHelpers";
import {
  CHAT_MESSAGE_PAGE_SIZE,
  isPendingSessionKey,
  toMessageRecordRefs,
  type ChatConversationMessage,
  type ConversationContextValue,
  type ToolCallInfo,
} from "../utils/conversationTypes";
import { refreshPendingMessages } from "../utils/pendingInputs";
import {
  canNotifyImageGenerationBatch,
  imageGenerationTaskId,
  mergeImageGenerationBatch,
  reconcileImageGenerationMessages,
  type ImageGenerationLabels,
} from "../utils/imageGenerationState";

export const imageGenerationLabels = (): ImageGenerationLabels => ({
  failed: tGlobal("toolCall.imagegen.taskFailed"),
  cancelled: tGlobal("toolCall.imagegen.taskCancelled"),
  unavailable: tGlobal("toolCall.imagegen.resultUnavailable"),
  untracked: tGlobal("toolCall.imagegen.untracked"),
});

type BatchCounts = {
  completed: number;
  failed: number;
  cancelled: number;
  total: number;
};

const batchCounts = (batch: ImageGenerationBatchSnapshot): BatchCounts => ({
  completed: batch.tasks.filter((task) => task.status === "completed").length,
  failed: batch.tasks.filter((task) => task.status === "failed").length,
  cancelled: batch.tasks.filter((task) => task.status === "cancelled").length,
  total: batch.tasks.length,
});

export const logImageGeneration = (
  stage: string,
  conversationId: string,
  batchId?: string,
  taskId?: string,
  level: "INFO" | "WARN" = "INFO",
  counts?: BatchCounts,
): void => {
  writeRendererLog(level, {
    module: "chat/imageGeneration",
    func: stage,
    message: stage,
    context: JSON.stringify({
      conversation_id: conversationId,
      batchId,
      taskId,
      ...counts,
    }),
  });
};

// These timers query real unfinished tasks only. Reconciliation is bounded;
// focus, conversation selection and history paging provide further replay points.
const RECONCILE_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000, 120_000];

/** One coordinator per chat context, independent of invoke/call callback lifetime. */
class ImageGenerationRuntime {
  private batches = new Map<
    string,
    Map<string, ImageGenerationBatchSnapshot>
  >();
  private loading = new Map<string, Promise<ImageGenerationBatchSnapshot[]>>();
  private preparing = new Map<string, Promise<boolean>>();
  private notifying = new Set<string>();
  private terminalConsumed = new Set<string>();
  private queried = new Set<string>();
  private observed = new Map<string, string>();
  private reconcileTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private reconcileAttempts = new Map<string, number>();
  private deadlineTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private deadlineChecked = new Set<string>();
  private mounted = false;

  constructor(private ctx: ConversationContextValue) {}

  attach(ctx: ConversationContextValue): void {
    this.ctx = ctx;
  }

  mount(): () => void {
    this.mounted = true;
    const unsubscribe = window.snow.onImageGenerationTask((task) => {
      this.consumeTask(task);
    });
    const onFocus = (): void => {
      for (const conversationId of this.observed.keys()) {
        this.reconcileAttempts.delete(conversationId);
        void this.recover(conversationId);
      }
      this.flushNotifications();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      this.mounted = false;
      unsubscribe();
      window.removeEventListener("focus", onFocus);
      for (const timer of this.reconcileTimers.values()) clearTimeout(timer);
      this.reconcileTimers.clear();
      for (const timer of this.deadlineTimers.values()) clearTimeout(timer);
      this.deadlineTimers.clear();
    };
  }

  tasks(conversationId: string): ImageGenerationTaskSnapshot[] {
    return [...(this.batches.get(conversationId)?.values() ?? [])].flatMap(
      (batch) => batch.tasks,
    );
  }

  projection(
    conversationId: string,
  ): (messages: ChatConversationMessage[]) => ChatConversationMessage[] {
    const tasks = this.tasks(conversationId);
    const labels = imageGenerationLabels();
    const markUntracked = this.queried.has(conversationId);
    return (messages) =>
      reconcileImageGenerationMessages(messages, tasks, labels, markUntracked);
  }

  replay(
    conversationId: string,
    messages: ChatConversationMessage[],
  ): ChatConversationMessage[] {
    return this.projection(conversationId)(messages);
  }

  private project(conversationId: string): void {
    // Capture immutable inputs before entering React. No ref writes, claims,
    // queue mutations or notification dispatches may run in this updater.
    const tasks = this.tasks(conversationId);
    const labels = imageGenerationLabels();
    const markUntracked = this.queried.has(conversationId);
    this.ctx.updateSessionMessages(conversationId, (messages) =>
      reconcileImageGenerationMessages(messages, tasks, labels, markUntracked),
    );
  }

  accept(batch: ImageGenerationBatchSnapshot): void {
    if (
      !batch.conversationId ||
      batch.tasks.some(
        (task) =>
          task.conversationId !== batch.conversationId ||
          task.batchId !== batch.batchId,
      )
    )
      return;
    const batches = this.batches.get(batch.conversationId) ?? new Map();
    batches.set(
      batch.batchId,
      mergeImageGenerationBatch(batches.get(batch.batchId), batch),
    );
    this.batches.set(batch.conversationId, batches);
    for (const task of batches.get(batch.batchId)?.tasks ?? []) {
      if (!isImageGenerationTerminal(task.status)) continue;
      const key = JSON.stringify([task.conversationId, task.taskId]);
      const timer = this.deadlineTimers.get(key);
      if (timer) clearTimeout(timer);
      this.deadlineTimers.delete(key);
    }
    this.project(batch.conversationId);
    this.scheduleReconcile(batch.conversationId);
  }

  consumeTask(value: ImageGenerationTaskSnapshot): void {
    const task = parseImageGenerationTask(value);
    if (
      !task ||
      !task.conversationId ||
      isPendingSessionKey(task.conversationId)
    )
      return;
    const key = JSON.stringify([task.conversationId, task.taskId]);
    const previous = this.batches.get(task.conversationId)?.get(task.batchId);
    const current = previous?.tasks.find((item) => item.taskId === task.taskId);
    // A callback and the independent event may deliver the same terminal.
    // Never downgrade or re-wake a consumed task, even after history eviction.
    if (
      this.terminalConsumed.has(key) ||
      (current && isImageGenerationTerminal(current.status)) ||
      (current &&
        !isImageGenerationTerminal(task.status) &&
        current.updatedAt >= task.updatedAt &&
        current.status === task.status)
    )
      return;
    this.accept({
      batchId: task.batchId,
      conversationId: task.conversationId,
      sealed: previous?.sealed ?? false,
      notified: previous?.notified ?? false,
      tasks: [task],
    });
    if (isImageGenerationTerminal(task.status)) {
      this.terminalConsumed.add(key);
      logImageGeneration(
        "terminal_consumed",
        task.conversationId,
        task.batchId,
        task.taskId,
      );
      // The event contains a task, not the full sealed batch. Query database
      // facts even if the conversation/card is not currently cached.
      void this.recover(task.conversationId);
    }
  }

  consumeTerminal(
    conversationId: string,
    call: ToolCallInfo,
    data: string,
  ): void {
    try {
      const event: unknown = JSON.parse(data);
      if (!isRecord(event)) return;
      const task = parseImageGenerationTask(event.task);
      if (
        task &&
        task.conversationId === conversationId &&
        task.interactionId === call.interactionId
      )
        this.consumeTask(task);
    } catch {
      // Global task events and snapshot recovery do not depend on call chunks.
    }
  }

  watchReceipt(
    conversationId: string,
    call: ToolCallInfo,
    result: string,
  ): void {
    try {
      const receipt: unknown = JSON.parse(result);
      if (!isRecord(receipt)) return;
      const task = parseImageGenerationTask(receipt.task);
      if (
        task &&
        task.conversationId === conversationId &&
        task.interactionId === call.interactionId
      )
        this.consumeTask(task);
      if (
        receipt.status !== "pending" ||
        typeof receipt.taskId !== "string" ||
        typeof receipt.deadlineAt !== "string"
      )
        return;
      const taskId = receipt.taskId;
      const key = JSON.stringify([conversationId, taskId]);
      const current = this.tasks(conversationId).find(
        (item) => item.taskId === taskId,
      );
      if (
        (current && isImageGenerationTerminal(current.status)) ||
        this.deadlineTimers.has(key) ||
        this.deadlineChecked.has(key) ||
        !this.mounted
      )
        return;
      const deadline = Date.parse(receipt.deadlineAt);
      if (!Number.isFinite(deadline)) return;
      // One query at the backend's real budget deadline, not a fake completion
      // or an everlasting polling loop. It also covers lost late callbacks.
      const delay = Math.max(0, deadline - Date.now()) + 1_500;
      this.deadlineTimers.set(
        key,
        setTimeout(
          () => {
            this.deadlineTimers.delete(key);
            this.deadlineChecked.add(key);
            void window.snow
              .getImageGenerationTask(conversationId, taskId)
              .then((snapshot) => {
                if (snapshot) this.consumeTask(snapshot);
                void this.recover(conversationId);
              })
              .catch(() =>
                logImageGeneration(
                  "deadline_reconcile_failed",
                  conversationId,
                  current?.batchId,
                  taskId,
                  "WARN",
                ),
              );
          },
          Math.min(delay, 2_147_483_647),
        ),
      );
    } catch {
      // Invalid/non-image receipts have no task to reconcile.
    }
  }

  recover(conversationId: string): Promise<ImageGenerationBatchSnapshot[]> {
    if (!conversationId || isPendingSessionKey(conversationId))
      return Promise.resolve([]);
    const existing = this.loading.get(conversationId);
    if (existing) return existing;
    // Install the in-flight promise BEFORE invoking the bridge: a query may
    // synchronously publish a recovered task event back to this coordinator.
    const request = Promise.resolve().then(async () => {
      try {
        const snapshots =
          await window.snow.listImageGenerationBatches(conversationId);
        for (const batch of snapshots) {
          if (batch.conversationId === conversationId) this.accept(batch);
        }
        const known = new Set(
          this.tasks(conversationId).map((task) => task.taskId),
        );
        const receiptIds = new Set(
          (this.ctx.sessionsRef.current[conversationId]?.messages ?? [])
            .flatMap((message) => message.toolCalls ?? [])
            .filter((call) => call.name === "imagegen-generate")
            .map(imageGenerationTaskId)
            .filter((id): id is string => Boolean(id) && !known.has(id!)),
        );
        const receipts = await Promise.all(
          [...receiptIds].map((taskId) =>
            window.snow.getImageGenerationTask(conversationId, taskId),
          ),
        );
        for (const task of receipts) if (task) this.consumeTask(task);
        // 非终态投影保留回执字段（taskId / deadlineAt），内存消息即可恢复截止监听。
        const replayMessages =
          this.ctx.sessionsRef.current[conversationId]?.messages ?? [];
        for (const message of replayMessages) {
          for (const call of message.toolCalls ?? []) {
            if (call.name === "imagegen-generate" && call.result)
              this.watchReceipt(conversationId, call, call.result);
          }
        }
        this.queried.add(conversationId);
        this.project(conversationId);
        this.scheduleReconcile(conversationId);
        this.flushNotifications();
        return [...(this.batches.get(conversationId)?.values() ?? [])];
      } catch {
        logImageGeneration(
          "recovery_failed",
          conversationId,
          undefined,
          undefined,
          "WARN",
        );
        return [...(this.batches.get(conversationId)?.values() ?? [])];
      } finally {
        if (this.loading.get(conversationId) === request)
          this.loading.delete(conversationId);
      }
    });
    this.loading.set(conversationId, request);
    return request;
  }

  private scheduleReconcile(conversationId: string): void {
    const unfinished = this.tasks(conversationId).some(
      (task) => !isImageGenerationTerminal(task.status),
    );
    if (!unfinished) {
      const timer = this.reconcileTimers.get(conversationId);
      if (timer) clearTimeout(timer);
      this.reconcileTimers.delete(conversationId);
      this.reconcileAttempts.delete(conversationId);
      return;
    }
    const attempt = this.reconcileAttempts.get(conversationId) ?? 0;
    if (
      !this.mounted ||
      this.reconcileTimers.has(conversationId) ||
      attempt >= RECONCILE_DELAYS_MS.length
    )
      return;
    this.reconcileTimers.set(
      conversationId,
      setTimeout(() => {
        this.reconcileTimers.delete(conversationId);
        this.reconcileAttempts.set(conversationId, attempt + 1);
        void (async () => {
          try {
            const tasks = this.tasks(conversationId).filter(
              (task) => !isImageGenerationTerminal(task.status),
            );
            await Promise.all(
              tasks.map(async (task) => {
                const snapshot = await window.snow.getImageGenerationTask(
                  conversationId,
                  task.taskId,
                );
                if (snapshot) this.consumeTask(snapshot);
              }),
            );
            // Registered siblings can be cancelled by sealing without a live call.
            await this.recover(conversationId);
          } catch {
            logImageGeneration(
              "reconcile_failed",
              conversationId,
              undefined,
              undefined,
              "WARN",
            );
          } finally {
            this.scheduleReconcile(conversationId);
          }
        })();
      }, RECONCILE_DELAYS_MS[attempt]),
    );
  }

  observeLoadedSessions(): void {
    for (const [conversationId, session] of Object.entries(this.ctx.sessions)) {
      if (isPendingSessionKey(conversationId)) continue;
      const records = session.messageRecords;
      const signature = JSON.stringify([
        records.length,
        records[0]?.id,
        records.at(-1)?.id,
      ]);
      if (this.observed.get(conversationId) !== signature) {
        this.observed.set(conversationId, signature);
        this.project(conversationId);
        void this.recover(conversationId);
      }
    }
    for (const conversationId of this.observed.keys()) {
      if (!this.ctx.sessions[conversationId])
        this.observed.delete(conversationId);
    }
    this.flushNotifications();
  }

  flushNotifications(): void {
    if (!this.mounted) return;
    for (const conversationId of this.batches.keys())
      void this.notifyReady(conversationId);
  }

  async seal(conversationId: string, batchId: string): Promise<void> {
    try {
      this.accept(
        await window.snow.sealImageGenerationBatch(conversationId, batchId),
      );
      logImageGeneration("batch_sealed", conversationId, batchId);
      this.flushNotifications();
    } catch {
      logImageGeneration(
        "batch_seal_failed",
        conversationId,
        batchId,
        undefined,
        "WARN",
      );
    }
  }

  private prepareNotificationSession(conversationId: string): Promise<boolean> {
    const existing = this.preparing.get(conversationId);
    if (existing) return existing;
    const request = (async () => {
      const record = await window.snow.getChatConversation(conversationId);
      if (
        !record ||
        record.parentConversationId ||
        record.conversationType === "sub_agent" ||
        record.conversationType === "workflow_node"
      )
        return false;
      await this.ctx.historyLoadPromisesRef.current.get(conversationId);
      if (!this.ctx.sessionsRef.current[conversationId]) {
        const [page, modes] = await Promise.all([
          window.snow.listChatMessagesPaginated(
            conversationId,
            "",
            CHAT_MESSAGE_PAGE_SIZE,
          ),
          window.snow.getConversationModes(conversationId),
        ]);
        this.ctx.ensureSession(conversationId, record.directoryId || undefined);
        const ref = this.ctx.sessionsRefData.current.get(conversationId);
        if (ref && modes && !ref.isSending) {
          ref.goalMode = modes.goalMode ?? ref.goalMode;
          ref.worktreeMode = modes.worktreeMode ?? ref.worktreeMode;
          ref.workflowMode = modes.workflowMode ?? ref.workflowMode;
          ref.goalModeTokenBudget =
            modes.goalModeTokenBudget ?? ref.goalModeTokenBudget;
        }
        // Replay the latest terminal cache after all awaits. ensureSession only
        // creates missing state and must never erase a previously updated card.
        const messages = this.replay(
          conversationId,
          buildConversationMessages(page.items),
        );
        this.ctx.setSessions((sessions) => {
          const session = sessions[conversationId];
          if (!session || session.messages.length > 0) return sessions;
          return {
            ...sessions,
            [conversationId]: {
              ...session,
              messages,
              messageRecords: toMessageRecordRefs(page.items),
              summary: record.title || record.summary,
              hasMoreMessages: page.hasMore,
            },
          };
        });
      }
      return !this.ctx.sessionsRefData.current.get(conversationId)
        ?.subAgentTerminated;
    })().finally(() => this.preparing.delete(conversationId));
    this.preparing.set(conversationId, request);
    return request;
  }

  private async notifyReady(conversationId: string): Promise<void> {
    for (const batch of this.batches.get(conversationId)?.values() ?? []) {
      if (!canNotifyImageGenerationBatch(batch)) continue;
      const key = JSON.stringify([conversationId, batch.batchId]);
      if (this.notifying.has(key)) continue;
      this.notifying.add(key);
      let claimed = false;
      try {
        if (
          !(await this.prepareNotificationSession(conversationId)) ||
          !this.mounted
        )
          continue;
        claimed = await window.snow.claimImageGenerationBatchNotification(
          conversationId,
          batch.batchId,
        );
        if (!claimed) continue;
        if (!this.mounted)
          throw new Error("IMAGE_GENERATION_RUNTIME_UNMOUNTED");
        const counts = batchCounts(batch);
        const text = `${tGlobal("toolCall.imagegen.batchReference", { values: { batchId: batch.batchId } })}\n${tGlobal(
          "toolCall.imagegen.batchSummary",
          { values: counts },
        )}`;
        const options = {
          targetSessionKey: conversationId,
          deliveryMode: "queue" as const,
          imageGenerationBatchId: batch.batchId,
        };
        const active = this.ctx.sessionsRefData.current.get(conversationId);
        if (active?.isSending) {
          // A follow-up, never steering: do not interrupt the current agent run.
          const queue =
            this.ctx.pendingQueueRef.current.get(conversationId) ?? [];
          if (
            !queue.some(
              (item) => item.options.imageGenerationBatchId === batch.batchId,
            )
          ) {
            this.ctx.pendingQueueRef.current.set(conversationId, [
              ...queue,
              { text, options },
            ]);
            refreshPendingMessages(this.ctx, conversationId);
          }
          logImageGeneration(
            "notification_queued",
            conversationId,
            batch.batchId,
            undefined,
            "INFO",
            counts,
          );
        } else {
          this.ctx.handleSendMessageRef.current(text, options);
          const accepted = this.ctx.sessionsRefData.current.get(conversationId);
          const queued = this.ctx.pendingQueueRef.current
            .get(conversationId)
            ?.some(
              (item) => item.options.imageGenerationBatchId === batch.batchId,
            );
          if (
            !queued &&
            (!accepted?.isSending ||
              accepted.activeSendOptions?.imageGenerationBatchId !==
                batch.batchId)
          ) {
            throw new Error("IMAGE_GENERATION_NOTIFICATION_REJECTED");
          }
        }
        const latest = this.batches.get(conversationId)?.get(batch.batchId);
        if (latest) latest.notified = true;
      } catch {
        if (claimed)
          await this.releaseNotification(conversationId, batch.batchId);
        logImageGeneration(
          "notification_dispatch_failed",
          conversationId,
          batch.batchId,
          undefined,
          "WARN",
        );
      } finally {
        this.notifying.delete(key);
      }
    }
  }

  notificationSent(conversationId: string, batchId: string): void {
    const batch = this.batches.get(conversationId)?.get(batchId);
    logImageGeneration(
      "notification_sent",
      conversationId,
      batchId,
      undefined,
      "INFO",
      batch ? batchCounts(batch) : undefined,
    );
  }

  async releaseNotification(
    conversationId: string,
    batchId: string,
  ): Promise<void> {
    try {
      await window.snow.releaseImageGenerationBatchNotification(
        conversationId,
        batchId,
      );
      const batch = this.batches.get(conversationId)?.get(batchId);
      if (batch) batch.notified = false;
      logImageGeneration("notification_released", conversationId, batchId);
    } catch {
      logImageGeneration(
        "notification_release_failed",
        conversationId,
        batchId,
        undefined,
        "WARN",
      );
    }
  }
}

const runtimes = new WeakMap<object, ImageGenerationRuntime>();

export const imageGenerationRuntime = (
  ctx: ConversationContextValue,
): ImageGenerationRuntime => {
  let runtime = runtimes.get(ctx.sessionsRef);
  if (!runtime) {
    runtime = new ImageGenerationRuntime(ctx);
    runtimes.set(ctx.sessionsRef, runtime);
  }
  runtime.attach(ctx);
  return runtime;
};

export const useImageGenerationRuntime = (
  ctx: ConversationContextValue,
): void => {
  const runtime = imageGenerationRuntime(ctx);
  useEffect(() => runtime.mount(), [runtime]);
  useEffect(() => runtime.observeLoadedSessions(), [runtime, ctx.sessions]);
  useEffect(() => {
    if (ctx.activeConversationId)
      void runtime.recover(ctx.activeConversationId);
  }, [runtime, ctx.activeConversationId]);
};
