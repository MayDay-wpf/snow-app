import { useCallback } from "react";
import { useI18n } from "../../../../i18n";
import type {
  AppNotificationOptions,
  NotificationConversationTarget,
} from "../../../../../shared/notification";
import type {
  ChatConversationMessage,
  ConversationContextValue,
  ConversationNotificationContext,
  ConversationSessionState,
  NotifyAiCompleteOptions,
  NotifySensitiveCommandOptions,
  NotifyUserInteractionOptions,
} from "../utils/conversationTypes";
import {
  getPendingSessionKey,
  isPendingSessionKey,
} from "../utils/conversationTypes";
import {
  isAssistantMessageAppended,
  resolveMessageWindow,
  trimSessionMessageWindow,
} from "../utils/messageWindow";

type ConversationNotificationOptions = Omit<AppNotificationOptions, "target"> &
  ConversationNotificationContext;

const showConversationNotification = ({
  conversationId,
  directoryId,
  ...options
}: ConversationNotificationOptions): void => {
  const normalizedConversationId = conversationId?.trim();
  const normalizedDirectoryId = directoryId?.trim();
  const target: NotificationConversationTarget | undefined =
    normalizedConversationId && normalizedDirectoryId
      ? {
          kind: "conversation",
          conversationId: normalizedConversationId,
          directoryId: normalizedDirectoryId,
        }
      : undefined;
  const notificationOptions: AppNotificationOptions = target
    ? { ...options, target }
    : options;

  void window.snow.showNotification(notificationOptions);
};

/**
 * 会话管理逻辑：创建、迁移、更新会话状态等。
 * 所有回调通过 ctx 访问共享状态，避免重复声明 ref / state。
 */
export const useConversationSession = (ctx: ConversationContextValue) => {
  const { t } = useI18n();
  const setActiveId = useCallback(
    (id: string | undefined, opts?: { preserveViewKey?: boolean }): void => {
      ctx.activeConversationIdRef.current = id;
      ctx.setActiveConversationId(id);
      // 视图会话 key 同步：新会话视图（id 为空）映射到当前序号的
      // pending 槽位 key，所有异步闭包读取它定位当前视图的会话。
      const sessionKey =
        id ?? getPendingSessionKey(ctx.pendingSessionSeqRef.current);
      ctx.activeSessionKeyRef.current = sessionKey;
      // 查看即重置会话缓存 TTL 计时。
      ctx.updateSessionField(sessionKey, "lastAccessedAt", Date.now());
      // 视图身份 key 同步；迁移（pending -> 真实 ID）传 preserveViewKey
      // 跳过，避免 chat-area / ChatInput 因 key 变化整体重建。
      if (!opts?.preserveViewKey) {
        ctx.setSessionViewKey(id ?? "new-chat");
      }
    },
    [
      ctx.activeConversationIdRef,
      ctx.setActiveConversationId,
      ctx.activeSessionKeyRef,
      ctx.pendingSessionSeqRef,
      ctx.setSessionViewKey,
      ctx.updateSessionField,
    ],
  );

  const ensureSession = useCallback(
    (key: string, dirId?: string): void => {
      if (!ctx.sessionsRefData.current.has(key)) {
        // New sessions inherit the GLOBAL defaults — not the currently
        // displayed session's mode. This is what keeps conversations fully
        // isolated: creating a chat in session A with a mode on does not
        // leak that mode into a fresh chat.
        const defaults = ctx.globalModeDefaultsRef.current;
        ctx.sessionsRefData.current.set(key, {
          streamId: null,
          streamPromise: null,
          summaryPromise: null,
          isSending: false,
          isAbortRequested: false,
          runId: 0,
          iterationTokenCount: 0,
          iterationElapsedMs: 0,
          directoryId: dirId,
          checkpointIds: [],
          childSubAgentIds: new Set(),
          worktreeMode: defaults.worktreeMode,
          goalMode: defaults.goalMode,
          workflowMode: defaults.workflowMode,
          goalModeTokenBudget: defaults.goalModeTokenBudget,
          runTokenUsage: null,
          lastRunDurationMs: 0,
          runTtftSumMs: 0,
          runRequestCount: 0,
        });
      }
      ctx.setSessions((prev) => {
        if (prev[key]) return prev;
        return {
          ...prev,
          [key]: {
            messages: [],
            messageRecords: [],
            summary: "",
            isStreaming: false,
            isAborting: false,
            isPaused: false,
            isLoadingOlderMessages: false,
            hasMoreMessages: false,
            isInitialHistoryLoaded: true,
            lastAccessedAt: Date.now(),
            tokenUsage: null,
            directoryId: dirId,
            hasNewContent: false,
            streamTokenCount: 0,
            streamElapsedMs: 0,
            streamTtftMs: 0,
            runTtftMs: 0,
            runTtftSumMs: 0,
            runRequestCount: 0,
            streamStartedAt: 0,
            runTokenUsage: null,
            conversationTokenUsage: null,
            lastRunDurationMs: 0,
            conversationTtftSumMs: 0,
            conversationRequestCount: 0,
          },
        };
      });
    },
    [ctx.sessionsRefData, ctx.setSessions, ctx.globalModeDefaultsRef],
  );

  const updateSessionMessages = useCallback(
    (
      key: string,
      updater: (
        messages: ChatConversationMessage[],
      ) => ChatConversationMessage[],
    ): void => {
      ctx.setSessions((prev) => {
        const session = prev[key];
        if (!session) return prev;
        const messages = updater(session.messages);
        if (messages === session.messages) return prev;
        const updated: ConversationSessionState = {
          ...session,
          messages,
          lastAccessedAt: Date.now(),
        };
        // 新 AI 消息追加时裁剪消息窗口；视图阅读历史（未钉底）时跳过。
        const windowSize =
          !isPendingSessionKey(key) &&
          isAssistantMessageAppended(session.messages, messages)
            ? resolveMessageWindow(key)
            : null;
        const trimmed = windowSize
          ? trimSessionMessageWindow(updated, windowSize)
          : null;
        return {
          ...prev,
          [key]: trimmed ?? updated,
        };
      });
    },
    [ctx.setSessions],
  );

  const updateSessionField = useCallback(
    <K extends keyof ConversationSessionState>(
      key: string,
      field: K,
      value: ConversationSessionState[K],
    ): void => {
      ctx.setSessions((prev) => {
        const session = prev[key];
        if (!session) return prev;
        return { ...prev, [key]: { ...session, [field]: value } };
      });
    },
    [ctx.setSessions],
  );

  const migrateSession = useCallback(
    (oldKey: string, newKey: string): void => {
      const oldRef = ctx.sessionsRefData.current.get(oldKey);
      if (oldRef) {
        ctx.sessionsRefData.current.set(newKey, { ...oldRef });
        ctx.sessionsRefData.current.delete(oldKey);
      }

      // 记录 pending 槽位 -> 真实 conversationId 的对应关系，侧边栏据此
      // 把新会话的真实记录替换到它自己的占位项上。
      if (isPendingSessionKey(oldKey)) {
        ctx.pendingToRealConversationIdRef.current.set(oldKey, newKey);
      }

      // 暂停控制器随会话 key 迁移，否则循环检查点与按钮读取的 key 不一致
      const pauseController = ctx.pauseControllerRef.current.get(oldKey);
      if (pauseController) {
        ctx.pauseControllerRef.current.set(newKey, pauseController);
        ctx.pauseControllerRef.current.delete(oldKey);
      }

      const pendingQueue = ctx.pendingQueueRef.current.get(oldKey);
      if (pendingQueue?.length) {
        const existingPendingQueue =
          ctx.pendingQueueRef.current.get(newKey) ?? [];
        ctx.pendingQueueRef.current.set(newKey, [
          ...pendingQueue,
          ...existingPendingQueue,
        ]);
        ctx.pendingQueueRef.current.delete(oldKey);
      }

      ctx.setSessions((prev) => {
        const oldSession = prev[oldKey];
        if (!oldSession) return prev;
        const next = { ...prev };
        next[newKey] = oldSession;
        delete next[oldKey];
        return next;
      });
      // 迁移后新键立即刷新 TTL 计时，避免刚迁完的会话被当作旧缓存回收。
      ctx.updateSessionField(newKey, "lastAccessedAt", Date.now());
      ctx.setStreamingConversationIds((prev) => {
        if (!prev.has(oldKey)) return prev;
        const next = new Set(prev);
        next.delete(oldKey);
        next.add(newKey);
        return next;
      });
    },
    [
      ctx.sessionsRefData,
      ctx.pauseControllerRef,
      ctx.pendingQueueRef,
      ctx.setSessions,
      ctx.setStreamingConversationIds,
      ctx.updateSessionField,
    ],
  );

  const addStreamingId = useCallback(
    (id: string): void => {
      ctx.setStreamingConversationIds((prev) => {
        if (prev.has(id)) return prev;
        const next = new Set(prev);
        next.add(id);
        return next;
      });
    },
    [ctx.setStreamingConversationIds],
  );

  const removeStreamingId = useCallback(
    (id: string): void => {
      ctx.setStreamingConversationIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    },
    [ctx.setStreamingConversationIds],
  );

  /**
   * 通知系统：通过主进程 Electron Notification API 触发跨平台系统通知。
   * 主进程会自动检测窗口是否聚焦 — 用户正在看应用时不弹通知。
   * 通知点击后会聚焦主窗口。
   *
   * 三种触发场景：
   * 1. AI 流程结束 — 用户切走后 AI 完成了任务
   * 2. 敏感命令拦截 — bash 命令匹配敏感规则，需要用户确认
   * 3. 用户交互工具确认 — askUserQuestion 需要用户回答
   */
  const notifyAiComplete = useCallback(
    ({
      conversationId,
      directoryId,
      title: conversationTitle,
    }: NotifyAiCompleteOptions): void => {
      const title = conversationTitle
        ? conversationTitle.length > 30
          ? `${conversationTitle.slice(0, 30)}...`
          : conversationTitle
        : "";
      showConversationNotification({
        title: t("notification.aiComplete.title"),
        body: title
          ? t("notification.aiComplete.bodyWithTitle", {
              values: { title },
            })
          : t("notification.aiComplete.bodyDefault"),
        conversationId,
        directoryId,
      });
    },
    [t],
  );

  const notifySensitiveCommandIntercepted = useCallback(
    ({
      conversationId,
      directoryId,
      toolName,
    }: NotifySensitiveCommandOptions): void => {
      showConversationNotification({
        title: t("notification.sensitiveCommand.title"),
        body: t("notification.sensitiveCommand.body", {
          values: { toolName },
        }),
        conversationId,
        directoryId,
      });
    },
    [t],
  );

  const notifyUserInteractionRequired = useCallback(
    ({
      conversationId,
      directoryId,
      reason,
    }: NotifyUserInteractionOptions): void => {
      const body = reason.length > 60 ? `${reason.slice(0, 60)}...` : reason;
      showConversationNotification({
        title: t("notification.userInteraction.title"),
        body,
        conversationId,
        directoryId,
      });
    },
    [t],
  );

  return {
    setActiveId,
    ensureSession,
    updateSessionMessages,
    updateSessionField,
    migrateSession,
    addStreamingId,
    removeStreamingId,
    notifyAiComplete,
    notifySensitiveCommandIntercepted,
    notifyUserInteractionRequired,
  };
};
