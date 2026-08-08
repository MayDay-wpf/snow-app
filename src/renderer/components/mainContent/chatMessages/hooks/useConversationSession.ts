import { useCallback } from "react";
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
  const setActiveId = useCallback(
    (id: string | undefined): void => {
      ctx.activeConversationIdRef.current = id;
      ctx.setActiveConversationId(id);
    },
    [ctx.activeConversationIdRef, ctx.setActiveConversationId]
  );

  const ensureSession = useCallback(
    (key: string, dirId?: string): void => {
      if (!ctx.sessionsRefData.current.has(key)) {
        // New sessions inherit the GLOBAL defaults — not the currently
        // displayed session's mode. This is what keeps conversations fully
        // isolated: creating a chat in session A with Plan Mode on does not
        // leak Plan Mode into a fresh chat.
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
          planMode: defaults.planMode,
          goalMode: defaults.goalMode,
          goalModeTokenBudget: defaults.goalModeTokenBudget,
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
            tokenUsage: null,
            directoryId: dirId,
            hasNewContent: false,
            streamTokenCount: 0,
            streamElapsedMs: 0,
            streamTtftMs: 0,
            runTtftMs: 0,
            streamStartedAt: 0,
          },
        };
      });
    },
    [ctx.sessionsRefData, ctx.setSessions, ctx.globalModeDefaultsRef]
  );

  const updateSessionMessages = useCallback(
    (
      key: string,
      updater: (
        messages: ChatConversationMessage[]
      ) => ChatConversationMessage[]
    ): void => {
      ctx.setSessions((prev) => {
        const session = prev[key];
        if (!session) return prev;
        return {
          ...prev,
          [key]: { ...session, messages: updater(session.messages) },
        };
      });
    },
    [ctx.setSessions]
  );

  const updateSessionField = useCallback(
    <K extends keyof ConversationSessionState>(
      key: string,
      field: K,
      value: ConversationSessionState[K]
    ): void => {
      ctx.setSessions((prev) => {
        const session = prev[key];
        if (!session) return prev;
        return { ...prev, [key]: { ...session, [field]: value } };
      });
    },
    [ctx.setSessions]
  );

  const migrateSession = useCallback(
    (oldKey: string, newKey: string): void => {
      const oldRef = ctx.sessionsRefData.current.get(oldKey);
      if (oldRef) {
        ctx.sessionsRefData.current.set(newKey, { ...oldRef });
        ctx.sessionsRefData.current.delete(oldKey);
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
      ctx.pendingQueueRef,
      ctx.setSessions,
      ctx.setStreamingConversationIds,
    ]
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
    [ctx.setStreamingConversationIds]
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
    [ctx.setStreamingConversationIds]
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
        title: "AI 任务已完成",
        body: title ? `会话「${title}」已结束` : "当前会话已结束，请返回查看",
        conversationId,
        directoryId,
      });
    },
    []
  );

  const notifySensitiveCommandIntercepted = useCallback(
    ({
      conversationId,
      directoryId,
      toolName,
    }: NotifySensitiveCommandOptions): void => {
      showConversationNotification({
        title: "敏感命令需要确认",
        body: `工具 ${toolName} 触发了敏感命令拦截，请返回确认`,
        conversationId,
        directoryId,
      });
    },
    []
  );

  const notifyUserInteractionRequired = useCallback(
    ({
      conversationId,
      directoryId,
      reason,
    }: NotifyUserInteractionOptions): void => {
      const body = reason.length > 60 ? `${reason.slice(0, 60)}...` : reason;
      showConversationNotification({
        title: "需要您的输入",
        body,
        conversationId,
        directoryId,
      });
    },
    []
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
