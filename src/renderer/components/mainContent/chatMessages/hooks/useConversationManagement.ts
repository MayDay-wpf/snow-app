import { useCallback } from "react";
import type {
  ConversationContextValue,
  TokenUsage,
} from "../utils/conversationTypes";
import {
  PENDING_SESSION_KEY,
  CHAT_MESSAGE_PAGE_SIZE,
  isPendingSessionKey,
} from "../utils/conversationTypes";
import {
  buildConversationMessages,
  deleteCheckpoints,
  directoryIdToPath,
  killRunningToolExecutions,
} from "../utils/conversationHelpers";
import { extractFileChangesFromRecords } from "./fileChangeTracking";
import {
  appendHookExecutionToMessage,
  runHook,
  toNonBlockingRecord,
} from "./hookOutcome";
import {
  abandonWorkflowsForConversation,
  getActiveWorkflowNodeIds,
  isActiveWorkflowNodeSession,
} from "../workflow/workflowRunner";

/** 会话被选中（切换会话）时派发的全局事件：主视图应回到聊天界面。 */
export const CONVERSATION_SELECTED_EVENT = "app:conversation-selected";

export type UseConversationManagementParams = {
  ctx: ConversationContextValue;
  rejectToolAuthorizations: (sessionKey?: string) => void;
  rejectPendingUserQuestions: (sessionKey?: string) => void;
};

/**
 * 会话管理逻辑：选择/新建/中止会话、分页加载历史消息、分叉会话等。
 */
export const useConversationManagement = (
  params: UseConversationManagementParams,
) => {
  const { ctx, rejectToolAuthorizations, rejectPendingUserQuestions } = params;

  const withdrawPendingMessage = useCallback((index: number): string | null => {
    const sessionKey = ctx.activeSessionKeyRef.current ?? PENDING_SESSION_KEY;
    const queue = ctx.pendingQueueRef.current.get(sessionKey);
    if (!queue || index < 0 || index >= queue.length) {
      return null;
    }

    const [removed] = queue.splice(index, 1);
    if (queue.length === 0) {
      ctx.pendingQueueRef.current.delete(sessionKey);
    }
    ctx.setActivePendingMessages(queue.map((item) => item.text));
    return removed?.text ?? null;
  }, []);

  const handleSelectConversation = useCallback(
    async (
      conversationId: string,
      title?: string,
      conversationTokenUsage?: TokenUsage | null,
      conversationDirId?: string,
    ): Promise<void> => {
      const trimmedId = conversationId.trim();
      if (!trimmedId) {
        return;
      }
      window.dispatchEvent(new CustomEvent(CONVERSATION_SELECTED_EVENT));
      const selectionRequestId = ++ctx.selectionRequestIdRef.current;
      const cachedSession = ctx.sessionsRef.current[trimmedId];
      const hasLoadedCachedHistory =
        ctx.sessionsRefData.current.has(trimmedId) &&
        cachedSession?.isInitialHistoryLoaded === true;

      if (
        trimmedId === ctx.activeConversationIdRef.current &&
        hasLoadedCachedHistory
      ) {
        ctx.setIsLoadingInitialHistory(false);
        return;
      }

      ctx.setIsLoadingInitialHistory(true);
      ctx.setActiveId(trimmedId);
      // Selecting an existing conversation cancels any prior "new chat"
      // intent so the UI follows the active conversation normally.
      ctx.setNewChatRequested(false);
      ctx.setRollbackNewChatState(null);

      // The pending-messages panel mirrors the *active* conversation's
      // pending queue. When switching sessions the displayed queue must be
      // reloaded from the target conversation's pendingQueue entry so the
      // previously active conversation's pending messages do not leak into
      // the newly selected one (each conversation keeps its own queue in
      // pendingQueueRef, but activePendingMessages is a single shared state).
      const targetPendingQueue = ctx.pendingQueueRef.current.get(trimmedId);
      ctx.setActivePendingMessages(
        targetPendingQueue ? targetPendingQueue.map((item) => item.text) : [],
      );

      // Restore per-conversation mode state from the target session.
      const cachedRef = ctx.sessionsRefData.current.get(trimmedId);
      const defaults = ctx.globalModeDefaultsRef.current;
      let targetWorktreeMode = cachedRef?.worktreeMode ?? defaults.worktreeMode;
      let targetPlanMode = cachedRef?.planMode ?? defaults.planMode;
      let targetGoalMode = cachedRef?.goalMode ?? defaults.goalMode;
      let targetWorkflowMode = cachedRef?.workflowMode ?? defaults.workflowMode;
      const targetBudget =
        cachedRef?.goalModeTokenBudget ?? defaults.goalModeTokenBudget;
      if (targetWorkflowMode) {
        targetWorktreeMode = false;
        targetPlanMode = false;
        targetGoalMode = false;
      } else if (targetWorktreeMode) {
        targetPlanMode = false;
        targetGoalMode = false;
      } else if (targetPlanMode) {
        targetGoalMode = false;
      }
      if (cachedRef) {
        cachedRef.worktreeMode = targetWorktreeMode;
        cachedRef.planMode = targetPlanMode;
        cachedRef.goalMode = targetGoalMode;
        cachedRef.workflowMode = targetWorkflowMode;
      }
      if (ctx.worktreeModeRef.current !== targetWorktreeMode) {
        ctx.worktreeModeRef.current = targetWorktreeMode;
        ctx.setWorktreeModeState(targetWorktreeMode);
      }
      if (ctx.planModeRef.current !== targetPlanMode) {
        ctx.planModeRef.current = targetPlanMode;
        ctx.setPlanModeState(targetPlanMode);
      }
      if (ctx.goalModeRef.current !== targetGoalMode) {
        ctx.goalModeRef.current = targetGoalMode;
        ctx.setGoalModeState(targetGoalMode);
      }
      if (ctx.workflowModeRef.current !== targetWorkflowMode) {
        ctx.workflowModeRef.current = targetWorkflowMode;
        ctx.setWorkflowModeState(targetWorkflowMode);
      }
      if (ctx.goalModeTokenBudget !== targetBudget) {
        ctx.setGoalModeTokenBudgetState(targetBudget);
      }

      if (hasLoadedCachedHistory) {
        ctx.updateSessionField(trimmedId, "hasNewContent", false);
        ctx.setCompletedConversationIds((prev) => {
          if (!prev.has(trimmedId)) return prev;
          const next = new Set(prev);
          next.delete(trimmedId);
          return next;
        });

        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => resolve());
          });
        });
        if (selectionRequestId === ctx.selectionRequestIdRef.current) {
          ctx.setIsLoadingInitialHistory(false);
        }
        return;
      }

      const nextTitle = title?.trim() ?? "";

      // Load the initial history. Selections of the same conversation share
      // a single in-flight load: switching away mid-load no longer discards
      // the fetched page (it is still cached so a later switch back hits the
      // cache instantly), and switching back while the load is still pending
      // reuses the same request instead of issuing a duplicate full re-fetch.
      let loadPromise = ctx.historyLoadPromisesRef.current.get(trimmedId);
      if (!loadPromise) {
        loadPromise = (async () => {
          try {
            const [page, conversationRecord, storedModes] = await Promise.all([
              window.snow.listChatMessagesPaginated(
                trimmedId,
                "",
                CHAT_MESSAGE_PAGE_SIZE,
              ),
              window.snow.getChatConversation(trimmedId),
              window.snow.getConversationModes(trimmedId).catch(() => null),
            ]);

            const checkpointIds = page.checkpointIds;
            let baselineCheckpointId = checkpointIds[0];

            // Resolve effective modes with stable conflict priority:
            // WorkFlow > WorkTree > Plan > Goal. Repair a conflicting database row
            // asynchronously after choosing the effective state.
            let storedWorktreeMode =
              storedModes?.worktreeMode ?? defaults.worktreeMode;
            let storedPlanMode = storedModes?.planMode ?? defaults.planMode;
            let storedGoalMode = storedModes?.goalMode ?? defaults.goalMode;
            let storedWorkflowMode =
              storedModes?.workflowMode ?? defaults.workflowMode;
            let storedBudget =
              storedModes?.goalModeTokenBudget ?? defaults.goalModeTokenBudget;
            const hasModeConflict =
              (storedWorkflowMode &&
                (storedWorktreeMode || storedPlanMode || storedGoalMode)) ||
              (storedWorktreeMode && (storedPlanMode || storedGoalMode)) ||
              (storedPlanMode && storedGoalMode);
            if (storedWorkflowMode) {
              storedWorktreeMode = false;
              storedPlanMode = false;
              storedGoalMode = false;
            } else if (storedWorktreeMode) {
              storedPlanMode = false;
              storedGoalMode = false;
            } else if (storedPlanMode) {
              storedGoalMode = false;
            }
            if (hasModeConflict) {
              void window.snow.setConversationModes(
                trimmedId,
                storedPlanMode,
                storedGoalMode,
                storedWorktreeMode,
                storedWorkflowMode,
                storedBudget,
              );
            }

            // Re-hydrate the file-change stats from persisted history so the
            // stats panel still shows what this conversation did after an app
            // restart or on first open. Live sessions are skipped: once the
            // tool pipeline has recorded a change for a conversation,
            // recordFileChange marks it hydrated and no history scan runs
            // (avoiding duplicate entries with different timestamps).
            //
            // The scan uses the FULL message list (listChatMessages), not the
            // paginated first page: pagination only covers the latest N
            // messages, so a page-based scan would miss edits made earlier in
            // the conversation and report a partial picture.
            if (!ctx.fileChangeStatsHydratedRef.current.has(trimmedId)) {
              const isSubAgentConversation = Boolean(
                conversationRecord?.parentConversationId,
              );
              const fullHistory = await window.snow.listChatMessages(trimmedId);
              const firstCheckpointRecord = fullHistory
                .filter(
                  (record) => record.role === "user" && record.checkpointId,
                )
                .sort((left, right) =>
                  left.createdAt.localeCompare(right.createdAt),
                )[0];
              baselineCheckpointId =
                firstCheckpointRecord?.checkpointId ?? baselineCheckpointId;
              const ownChanges = extractFileChangesFromRecords(fullHistory);
              if (ownChanges.length > 0) {
                ctx.mergeFileChangeStats(
                  trimmedId,
                  ownChanges.map((change) => ({
                    ...change,
                    agent: isSubAgentConversation
                      ? ("sub" as const)
                      : ("main" as const),
                    subAgentName: isSubAgentConversation
                      ? conversationRecord?.subAgentName || undefined
                      : undefined,
                  })),
                );
              }
              // A main conversation's stats panel also merges its sub-agents'
              // changes; scan each sub-agent conversation's full history.
              if (!isSubAgentConversation) {
                try {
                  const subConversations =
                    await window.snow.listSubAgentConversations(trimmedId);
                  await Promise.all(
                    subConversations.map(async (subConversation) => {
                      const subRecords = await window.snow.listChatMessages(
                        subConversation.conversationId,
                      );
                      const subChanges =
                        extractFileChangesFromRecords(subRecords);
                      if (subChanges.length > 0) {
                        ctx.mergeFileChangeStats(
                          trimmedId,
                          subChanges.map((change) => ({
                            ...change,
                            agent: "sub" as const,
                            subAgentName:
                              subConversation.subAgentName ||
                              subConversation.title ||
                              undefined,
                          })),
                        );
                      }
                    }),
                  );
                } catch {
                  // Sub-agent scans must not block the session switch
                }
              }
              ctx.fileChangeStatsHydratedRef.current.add(trimmedId);
            }

            // Cache the fetched page even when this request was superseded
            // while in flight (the user switched to another conversation).
            // Guard with the current session so a newer load's snapshot is
            // never clobbered by an older one. Later selections of the same
            // conversation then render instantly from the cache.
            if (!ctx.sessionsRef.current[trimmedId]) {
              // Never overwrite an existing session ref (e.g. one created by
              // ensureSession while the history was still loading) — the live
              // ref is authoritative.
              if (!ctx.sessionsRefData.current.has(trimmedId)) {
                // A sub-agent conversation whose persisted run status is
                // terminal is read-only from the moment it is opened: the
                // input box stays hidden and sends are rejected.
                const isTerminatedSubAgent =
                  conversationRecord?.conversationType === "sub_agent" &&
                  (conversationRecord.subAgentStatus ?? "") !== "" &&
                  conversationRecord.subAgentStatus !== "running";
                ctx.sessionsRefData.current.set(trimmedId, {
                  streamId: null,
                  streamPromise: null,
                  summaryPromise: null,
                  isSending: false,
                  isAbortRequested: false,
                  runId: 0,
                  iterationTokenCount: 0,
                  iterationElapsedMs: 0,
                  directoryId: conversationDirId,
                  checkpointIds,
                  childSubAgentIds: new Set(),
                  planMode: storedPlanMode,
                  worktreeMode: storedWorktreeMode,
                  goalMode: storedGoalMode,
                  workflowMode: storedWorkflowMode,
                  goalModeTokenBudget: storedBudget,
                  subAgentTerminated: isTerminatedSubAgent || undefined,
                  runTokenUsage: null,
                  lastRunDurationMs: 0,
                });
              }
              ctx.setSessions((prev) => {
                if (prev[trimmedId]) return prev;
                return {
                  ...prev,
                  [trimmedId]: {
                    messages: buildConversationMessages(page.items),
                    messageRecords: page.items,
                    summary: nextTitle,
                    isStreaming: false,
                    isAborting: false,
                    isPaused: false,
                    isLoadingOlderMessages: false,
                    hasMoreMessages: page.hasMore,
                    isInitialHistoryLoaded: true,
                    tokenUsage: conversationTokenUsage ?? null,
                    directoryId: conversationDirId,
                    hasNewContent: false,
                    forkedFromConversationId:
                      conversationRecord?.forkedFromConversationId || undefined,
                    forkMessageCount:
                      conversationRecord?.forkMessageCount || undefined,
                    streamTokenCount: 0,
                    streamElapsedMs: 0,
                    streamTtftMs: 0,
                    runTtftMs: 0,
                    baselineCheckpointId,
                    streamStartedAt: 0,
                    // 历史会话回显 DB 持久化的会话累计（token + 耗时）。
                    runTokenUsage: null,
                    conversationTokenUsage: {
                      inputTokens: conversationRecord?.runInputTokens ?? 0,
                      outputTokens: conversationRecord?.runOutputTokens ?? 0,
                      cacheCreationInputTokens:
                        conversationRecord?.runCacheCreationInputTokens ?? 0,
                      cacheReadInputTokens:
                        conversationRecord?.runCacheReadInputTokens ?? 0,
                    },
                    lastRunDurationMs:
                      conversationRecord?.lastRunDurationMs ?? 0,
                  },
                };
              });
            }
          } catch {
            // 加载历史消息失败时静默处理，不阻断交互
          }
        })();
        ctx.historyLoadPromisesRef.current.set(trimmedId, loadPromise);
        void loadPromise.finally(() => {
          if (
            ctx.historyLoadPromisesRef.current.get(trimmedId) === loadPromise
          ) {
            ctx.historyLoadPromisesRef.current.delete(trimmedId);
          }
        });
      }

      await loadPromise;

      // Only the latest selection owns the loading flag; superseded
      // selections must not clear it while a newer one is still loading.
      if (selectionRequestId === ctx.selectionRequestIdRef.current) {
        ctx.setIsLoadingInitialHistory(false);
      }

      // Sync the UI state to the session's resolved modes once the load
      // settles. For a cold conversation with DB overrides this is where the
      // displayed mode transitions from the global default to its own value.
      if (selectionRequestId === ctx.selectionRequestIdRef.current) {
        const settledRef = ctx.sessionsRefData.current.get(trimmedId);
        if (settledRef) {
          if (ctx.worktreeModeRef.current !== settledRef.worktreeMode) {
            ctx.worktreeModeRef.current = settledRef.worktreeMode;
            ctx.setWorktreeModeState(settledRef.worktreeMode);
          }
          if (ctx.planModeRef.current !== settledRef.planMode) {
            ctx.planModeRef.current = settledRef.planMode;
            ctx.setPlanModeState(settledRef.planMode);
          }
          if (ctx.goalModeRef.current !== settledRef.goalMode) {
            ctx.goalModeRef.current = settledRef.goalMode;
            ctx.setGoalModeState(settledRef.goalMode);
          }
          if (ctx.workflowModeRef.current !== settledRef.workflowMode) {
            ctx.workflowModeRef.current = settledRef.workflowMode;
            ctx.setWorkflowModeState(settledRef.workflowMode);
          }
          if (ctx.goalModeTokenBudget !== settledRef.goalModeTokenBudget) {
            ctx.setGoalModeTokenBudgetState(settledRef.goalModeTokenBudget);
          }
        }
      }

      // Execute onSessionStart hooks (fire-and-forget) when the user opens
      // an existing conversation. These are diagnostic/audit hooks that run
      // after the history is loaded — they cannot block the session switch.
      const onSessionStartMessageId = ctx.sessionsRef.current[
        trimmedId
      ]?.messages.findLast((message) => message.role !== "tool")?.id;
      const onSessionStartContext = JSON.stringify({
        conversationId: trimmedId,
        cwd: directoryIdToPath(conversationDirId) ?? ctx.directoryPath ?? "",
        directoryId: conversationDirId ?? "",
      });
      void runHook(
        "onSessionStart",
        conversationDirId ?? undefined,
        onSessionStartContext,
      )
        .then((hookResult) => {
          if (hookResult) {
            ctx.updateSessionMessages(trimmedId, (currentMessages) =>
              appendHookExecutionToMessage(
                currentMessages,
                toNonBlockingRecord(hookResult.record),
                onSessionStartMessageId,
              ),
            );
          }
        })
        .catch(() => {
          // onSessionStart hook failures must not block the session switch
        });
    },
    [
      ctx.setActiveId,
      ctx.updateSessionField,
      ctx.setNewChatRequested,
      ctx.setRollbackNewChatState,
      ctx.sessionsRefData,
      ctx.worktreeModeRef,
      ctx.setWorktreeModeState,
      ctx.planModeRef,
      ctx.setPlanModeState,
      ctx.goalModeRef,
      ctx.setGoalModeState,
      ctx.goalModeTokenBudget,
      ctx.setGoalModeTokenBudgetState,
      ctx.globalModeDefaultsRef,
      ctx.pendingQueueRef,
      ctx.setActivePendingMessages,
    ],
  );

  const loadOlderMessages = useCallback(async (): Promise<void> => {
    const conversationId = ctx.activeConversationIdRef.current;
    if (!conversationId) {
      return;
    }

    const session = ctx.sessionsRef.current[conversationId];
    const beforeMessageId = session?.messageRecords[0]?.id;
    if (
      !session ||
      !beforeMessageId ||
      !session.hasMoreMessages ||
      ctx.loadingOlderConversationIdsRef.current.has(conversationId)
    ) {
      return;
    }

    ctx.loadingOlderConversationIdsRef.current.add(conversationId);
    ctx.updateSessionField(conversationId, "isLoadingOlderMessages", true);

    try {
      const page = await window.snow.listChatMessagesPaginated(
        conversationId,
        beforeMessageId,
        CHAT_MESSAGE_PAGE_SIZE,
      );
      const currentSession = ctx.sessionsRef.current[conversationId];
      if (!currentSession) {
        return;
      }

      const existingIds = new Set(
        currentSession.messageRecords.map((record) => record.id),
      );
      const olderRecords = page.items.filter(
        (record) => !existingIds.has(record.id),
      );
      const combinedRecords = [
        ...olderRecords,
        ...currentSession.messageRecords,
      ];
      const persistedIds = new Set(
        currentSession.messageRecords.map((record) => record.id),
      );
      const transientMessages = currentSession.messages.filter(
        (message) => !persistedIds.has(message.id),
      );

      ctx.setSessions((prev) => {
        const latestSession = prev[conversationId];
        if (!latestSession) {
          return prev;
        }

        return {
          ...prev,
          [conversationId]: {
            ...latestSession,
            messages: [
              ...buildConversationMessages(combinedRecords),
              ...transientMessages,
            ],
            messageRecords: combinedRecords,
            isLoadingOlderMessages: false,
            hasMoreMessages: page.hasMore,
          },
        };
      });

      const refData = ctx.sessionsRefData.current.get(conversationId);
      if (refData) {
        refData.checkpointIds = page.checkpointIds;
      }
    } catch {
      ctx.updateSessionField(conversationId, "isLoadingOlderMessages", false);
    } finally {
      ctx.loadingOlderConversationIdsRef.current.delete(conversationId);
    }
  }, [ctx.updateSessionField]);

  const handleNewChat = useCallback(
    (directoryId?: string): void => {
      ctx.selectionRequestIdRef.current += 1;
      ctx.setIsLoadingInitialHistory(false);

      // Mark that the user explicitly requested a new chat. This prevents the
      // UI from falling back to the pending session (which may still be
      // streaming in the background) and prevents the agent loop from
      // auto-switching back to the migrated conversation once it finishes.
      ctx.setNewChatRequested(true);
      ctx.setRollbackNewChatState(null);
      // Increment independently from the legacy boolean: the same pending key can
      // be reused for consecutive new chats, including across project switches.
      ctx.setNewChatGeneration((generation) => generation + 1);

      // Reset Plan Mode so a new chat always starts with the GLOBAL default
      // (not the previous conversation's mode — real per-conversation
      // isolation). The global defaults are only mutated by explicit user
      // toggles, so no persisted write is needed here.
      const defaults = ctx.globalModeDefaultsRef.current;
      if (ctx.planModeRef.current !== defaults.planMode) {
        ctx.planModeRef.current = defaults.planMode;
        ctx.setPlanModeState(defaults.planMode);
      }

      // Reset WorkTree Mode so a new chat starts with the global default.
      if (ctx.worktreeModeRef.current !== defaults.worktreeMode) {
        ctx.worktreeModeRef.current = defaults.worktreeMode;
        ctx.setWorktreeModeState(defaults.worktreeMode);
      }

      // Reset WorkFlow Mode so a new chat starts with the global default.
      if (ctx.workflowModeRef.current !== defaults.workflowMode) {
        ctx.workflowModeRef.current = defaults.workflowMode;
        ctx.setWorkflowModeState(defaults.workflowMode);
      }

      // A new chat starts a brand-new task. Each pending slot's approval is
      // cleared ONLY when that slot's session is not running in the
      // background — a streaming pending conversation keeps its approved plan
      // (it will be migrated to its real id). handleSendMessage resets the
      // new task's own approval on first send, so no other cleanup is needed.
      for (const pendingKey of Array.from(ctx.sessionsRefData.current.keys())) {
        if (!isPendingSessionKey(pendingKey)) continue;
        const pendingSlotRef = ctx.sessionsRefData.current.get(pendingKey);
        if (!pendingSlotRef?.isSending) {
          ctx.planApprovedSessionKeysRef.current.delete(pendingKey);
        }
      }

      // Reset Goal Mode so a new chat always starts with the global default.
      if (ctx.goalModeRef.current !== defaults.goalMode) {
        ctx.goalModeRef.current = defaults.goalMode;
        ctx.setGoalModeState(defaults.goalMode);
      }
      if (ctx.workflowModeRef.current !== defaults.workflowMode) {
        ctx.workflowModeRef.current = defaults.workflowMode;
        ctx.setWorkflowModeState(defaults.workflowMode);
      }
      if (ctx.goalModeTokenBudget !== defaults.goalModeTokenBudget) {
        ctx.setGoalModeTokenBudgetState(defaults.goalModeTokenBudget);
      }

      // 清理全部非流式的 pending 槽位会话（上个新会话视图的残留）。
      // 流式中的槽位保留：AI 循环继续在后台运行并最终迁移到真实会话，
      // 用户看到的是空问候视图。每个槽位独立，互不影响。
      for (const pendingKey of Array.from(ctx.sessionsRefData.current.keys())) {
        if (!isPendingSessionKey(pendingKey)) continue;
        const pendingSlotRef = ctx.sessionsRefData.current.get(pendingKey);
        if (pendingSlotRef && !pendingSlotRef.isSending) {
          deleteCheckpoints(pendingSlotRef.checkpointIds);
          ctx.sessionsRefData.current.delete(pendingKey);
          ctx.pendingQueueRef.current.delete(pendingKey);
          ctx.pendingToRealConversationIdRef.current.delete(pendingKey);
          ctx.setSessions((prev) => {
            const next = { ...prev };
            delete next[pendingKey];
            return next;
          });
        }
      }

      // 新会话视图分配独立的新 pending 槽位 key：即使上一个新会话的
      // 流式 run 仍占用旧槽位，本视图的发送也会立即获得空闲槽位并行
      // 运行，绝不排队等待旧会话的第一轮 loop。
      ctx.pendingSessionSeqRef.current += 1;
      ctx.setActiveId(undefined);

      // One-shot target project for the next new-chat send (e.g. a scheduled
      // task firing for its bound project). Consumed by handleSendMessage so
      // the new PENDING session lands in the target project; undefined resets
      // to the currently active project.
      ctx.pendingDirectoryIdRef.current = directoryId;

      // 新视图对应全新的 pending 槽位，其队列必然为空：Pending 面板
      // 清空，旧视图/旧会话的排队消息不会渗入新视图。
      ctx.setActivePendingMessages([]);
    },
    [
      ctx.setActiveId,
      ctx.setNewChatRequested,
      ctx.setRollbackNewChatState,
      ctx.setNewChatGeneration,
      ctx.planModeRef,
      ctx.setPlanModeState,
      ctx.worktreeModeRef,
      ctx.setWorktreeModeState,
      ctx.goalModeRef,
      ctx.setGoalModeState,
      ctx.planApprovedSessionKeysRef,
      ctx.globalModeDefaultsRef,
      ctx.goalModeTokenBudget,
      ctx.setGoalModeTokenBudgetState,
      ctx.pendingQueueRef,
      ctx.setActivePendingMessages,
      ctx.sessionsRefData,
      ctx.pendingSessionSeqRef,
      ctx.pendingToRealConversationIdRef,
    ],
  );

  /**
   * 级联中止子代理树：从指定会话开始，连同其递归派生的所有子代理一并
   * 停止（拒绝挂起授权、清理流状态与内存会话标记）。供主会话中止与
   * WorkFlow 节点中止共用：节点运行期间派生的子代理挂在节点会话下，
   * 中止节点时必须一并停止，否则子代理会在后台继续流式请求。
   */
  const abortSubAgentTree = useCallback(
    (subKey: string): void => {
      const subRef = ctx.sessionsRefData.current.get(subKey);
      if (!subRef || subRef.isAbortRequested) {
        return;
      }
      subRef.isAbortRequested = true;
      subRef.isSending = false;
      // Settle the sub-agent's own pending authorizations (scoped to its
      // session key) so its agent loop cannot stay blocked awaiting a
      // decision that will never arrive.
      rejectToolAuthorizations(subKey);
      killRunningToolExecutions(
        ctx.sessionsRef.current?.[subKey]?.messages ?? [],
      );

      ctx.updateSessionMessages(subKey, (currentMessages) =>
        currentMessages.map((message) => ({
          ...message,
          status: message.status === "sending" ? "sent" : message.status,
          isRetrying: message.status === "sending" ? false : message.isRetrying,
          toolCalls: message.toolCalls?.map((toolCall) =>
            toolCall.status === "running" || toolCall.status === "pending"
              ? {
                  ...toolCall,
                  status: "error",
                  result: toolCall.result ?? "Interrupted by user",
                }
              : toolCall,
          ),
        })),
      );
      ctx.updateSessionField(subKey, "isStreaming", false);
      ctx.updateSessionField(subKey, "streamStartedAt", 0);
      ctx.updateSessionField(subKey, "isAborting", false);
      ctx.updateSessionField(subKey, "isPaused", false);
      // Same vision textify status card cleanup as the parent abort.
      ctx.updateSessionField(subKey, "visionAnalysis", undefined);
      ctx.pauseControllerRef.current.delete(subKey);
      ctx.removeStreamingId(subKey);

      if (subRef.streamId) {
        void window.snow.abortResponseStream(subRef.streamId);
      }

      for (const grandChildId of subRef.childSubAgentIds) {
        abortSubAgentTree(grandChildId);
      }
    },
    [
      ctx.removeStreamingId,
      rejectToolAuthorizations,
      ctx.updateSessionMessages,
      ctx.updateSessionField,
      ctx.pauseControllerRef,
      ctx.sessionsRef,
      ctx.sessionsRefData,
    ],
  );

  /**
   * 级联中止该会话正在执行的 WorkFlow 节点：节点是真实主会话（内存注册、
   * 独立流与工具进程），父会话中断/删除时必须一并停止，否则节点会继续
   * 流式请求并运行子进程。同时结算挂起的 workflow-generate，避免主
   * agent loop 的阻塞 promise 变成僵尸。
   */
  const abortWorkflowNodes = useCallback(
    (parentConversationId: string): void => {
      abandonWorkflowsForConversation(parentConversationId);
      for (const nodeId of getActiveWorkflowNodeIds(parentConversationId)) {
        // 节点及其在节点会话下递归派生的子代理一并中止：
        // abortSubAgentTree 统一处理会话标记、授权、流与子进程清理。
        abortSubAgentTree(nodeId);
      }
    },
    [abortSubAgentTree],
  );

  const handleAbort = useCallback((): void => {
    const key = ctx.activeSessionKeyRef.current ?? PENDING_SESSION_KEY;
    const ref = ctx.sessionsRefData.current.get(key);
    if (!ref?.isSending || ref.isAbortRequested) {
      return;
    }

    // Reject only this session's pending tool authorizations. The pending
    // map is shared across all conversations, so a session-scoped reject is
    // required — a global reject here would silently decline authorization
    // prompts waiting in other sessions.
    rejectToolAuthorizations(key);
    rejectPendingUserQuestions(key);
    for (const [decisionId, pendingDecision] of ctx.pendingHookDecisionRef
      .current) {
      if (pendingDecision.sessionKey === key) {
        ctx.pendingHookDecisionRef.current.delete(decisionId);
        pendingDecision.resolve(false);
      }
    }

    // Wake up the pause checkpoint so the blocked agent loop can observe
    // the cancellation and exit. Without this, a paused loop would hang
    // forever because it is awaiting the pause promise.
    const pauseController = ctx.pauseControllerRef.current.get(key);
    if (pauseController) {
      pauseController.paused = false;
      const resolve = pauseController.resolve;
      pauseController.resolve = null;
      if (resolve) {
        resolve();
      }
    }

    ref.isAbortRequested = true;
    ref.isSending = false;
    ref.runId += 1;
    ctx.updateSessionMessages(key, (currentMessages) =>
      currentMessages.map((message) => {
        return {
          ...message,
          status: message.status === "sending" ? "sent" : message.status,
          isRetrying: message.status === "sending" ? false : message.isRetrying,
          toolCalls: message.toolCalls?.map((toolCall) =>
            toolCall.status === "running" || toolCall.status === "pending"
              ? {
                  ...toolCall,
                  status: "error",
                  result: toolCall.result ?? "Interrupted by user",
                }
              : toolCall,
          ),
        };
      }),
    );
    // Kill every in-flight bash subprocess of this session so the OS
    // process does not keep running until its timeout.
    killRunningToolExecutions(ctx.sessionsRef.current?.[key]?.messages ?? []);
    ctx.updateSessionField(key, "isStreaming", false);
    ctx.updateSessionField(key, "streamStartedAt", 0);
    ctx.updateSessionField(key, "isAborting", false);
    ctx.updateSessionField(key, "isPaused", false);
    // Clear the vision textify status card: an abort while the backend is
    // describing user images with the external vision model must recycle the
    // "vision model analyzing image" intermediate state immediately (the
    // backend also pushes a cancel event, but it races the abort and may be
    // dropped).
    ctx.updateSessionField(key, "visionAnalysis", undefined);
    ctx.pauseControllerRef.current.delete(key);
    ctx.removeStreamingId(key);

    if (ref.streamId) {
      void window.snow.abortResponseStream(ref.streamId);
    }

    // Cancel any in-flight summary generation so its
    // update_conversation_summary write transaction is skipped. Without this,
    // a cancel-then-rollback flow would wait on the summary promise (which may
    // be stuck in an HTTP retry loop) and the database would remain locked
    // when the rollback's delete/truncate runs.
    if (!isPendingSessionKey(key)) {
      void window.snow.cancelConversationSummary(key);
    }

    // Cascade the abort to every sub-agent spawned by this conversation (and
    // recursively to their own sub-agents). Without this, stopping the main
    // flow would leave sub-agents streaming in the background.
    for (const subAgentId of ref.childSubAgentIds) {
      abortSubAgentTree(subAgentId);
    }

    // 级联中止运行中的 WorkFlow 节点（节点是独立主会话，不在
    // childSubAgentIds 内；节点及其子代理由 abortSubAgentTree 统一中止），
    // 并结算挂起的 workflow-generate。
    abortWorkflowNodes(key);
  }, [
    ctx.removeStreamingId,
    rejectToolAuthorizations,
    rejectPendingUserQuestions,
    ctx.updateSessionMessages,
    ctx.updateSessionField,
    ctx.pauseControllerRef,
    abortWorkflowNodes,
    abortSubAgentTree,
  ]);

  const abortConversation = useCallback(
    (conversationId: string): void => {
      const ref = ctx.sessionsRefData.current.get(conversationId);

      rejectToolAuthorizations(conversationId);
      rejectPendingUserQuestions(conversationId);
      killRunningToolExecutions(
        ctx.sessionsRef.current?.[conversationId]?.messages ?? [],
      );
      // 删除会话前先停止其运行中的 WorkFlow 节点（节点是独立主会话，
      // 不随父会话删除，只停止执行并保留消息记录）。
      abortWorkflowNodes(conversationId);
      if (ref?.streamId) {
        void window.snow.abortResponseStream(ref.streamId);
        ref.streamId = null;
      }
      if (ref) {
        ref.isSending = false;
      }
      ctx.updateSessionField(conversationId, "isStreaming", false);
      ctx.updateSessionField(conversationId, "streamStartedAt", 0);
      ctx.updateSessionField(conversationId, "isAborting", false);
      // Clear the vision textify status card (the conversation is being
      // deleted; a stuck intermediate card must not outlive it).
      ctx.updateSessionField(conversationId, "visionAnalysis", undefined);
      ctx.removeStreamingId(conversationId);
      // Clean up session state and incremental checkpoint storage.
      if (ref) {
        deleteCheckpoints(ref.checkpointIds);
      }
      // When the deleted conversation is the active one, reset the displayed
      // mode to the global defaults so a stale mode does not linger in the
      // UI (the DB row is gone with the conversation, so nothing to restore).
      if (ctx.activeConversationIdRef.current === conversationId) {
        const defaults = ctx.globalModeDefaultsRef.current;
        if (ctx.worktreeModeRef.current !== defaults.worktreeMode) {
          ctx.worktreeModeRef.current = defaults.worktreeMode;
          ctx.setWorktreeModeState(defaults.worktreeMode);
        }
        if (ctx.planModeRef.current !== defaults.planMode) {
          ctx.planModeRef.current = defaults.planMode;
          ctx.setPlanModeState(defaults.planMode);
        }
        if (ctx.goalModeRef.current !== defaults.goalMode) {
          ctx.goalModeRef.current = defaults.goalMode;
          ctx.setGoalModeState(defaults.goalMode);
        }
        if (ctx.workflowModeRef.current !== defaults.workflowMode) {
          ctx.workflowModeRef.current = defaults.workflowMode;
          ctx.setWorkflowModeState(defaults.workflowMode);
        }
        if (ctx.goalModeTokenBudget !== defaults.goalModeTokenBudget) {
          ctx.setGoalModeTokenBudgetState(defaults.goalModeTokenBudget);
        }
      }
      ctx.sessionsRefData.current.delete(conversationId);
      ctx.setSessions((prev) => {
        const next = { ...prev };
        delete next[conversationId];
        return next;
      });
    },
    [
      ctx.removeStreamingId,
      rejectToolAuthorizations,
      rejectPendingUserQuestions,
      ctx.updateSessionField,
      ctx.globalModeDefaultsRef,
      ctx.worktreeModeRef,
      ctx.setWorktreeModeState,
      ctx.goalModeTokenBudget,
      ctx.setGoalModeTokenBudgetState,
      abortWorkflowNodes,
    ],
  );

  /**
   * Immediately send a pending message: abort the current in-flight session,
   * remove the message from the pending queue, and dispatch it via
   * handleSendMessage so a fresh agent loop starts right away.
   *
   * This is used when the user does not want to wait for the current AI
   * response to finish — the ongoing stream is cancelled and the selected
   * pending message is sent immediately.
   */
  const sendPendingMessageNow = useCallback(
    (index: number): void => {
      const sessionKey = ctx.activeSessionKeyRef.current ?? PENDING_SESSION_KEY;
      const queue = ctx.pendingQueueRef.current.get(sessionKey);
      if (!queue || index < 0 || index >= queue.length) {
        return;
      }

      // Abort the current streaming session so isSending flips to false
      // and handleSendMessage will start a new agent loop instead of
      // re-queuing the message.
      handleAbort();

      // Remove the target message (and its original send options) from
      // the pending queue.
      const [removed] = queue.splice(index, 1);
      if (queue.length === 0) {
        ctx.pendingQueueRef.current.delete(sessionKey);
      }

      if (!removed) {
        ctx.setActivePendingMessages(queue.map((item) => item.text));
        return;
      }

      // 子代理会话的"立即发送"必须发给子代理本身（强行发送给谁就是
      // 谁）：abort 当前回合，消息暂存到会话 ref，子代理循环退出收尾
      // 时会复用自动发送路径、直接在本会话启动新回合处理它（见
      // subAgentActivation 的 forceSendMessages 处理），而不是停掉
      // 子代理后把消息转交父会话。绝不能走 handleSendMessage —— 那是
      // 主流程路径，会把子代理会话当成主会话发送（工具集/系统提示
      // 不对，还会被侧边栏 upsert 成"新主会话"）。仅当子代理已终止
      // （只读、无法再启动回合）时才把消息转交父会话队列。
      const subAgentEvent = ctx.subAgentSessionEvents[sessionKey];
      if (subAgentEvent?.parentConversationId) {
        const subRef = ctx.sessionsRefData.current.get(sessionKey);
        if (subRef && !subRef.subAgentTerminated) {
          subRef.forceSendMessages = [
            ...(subRef.forceSendMessages ?? []),
            { text: removed.text, options: removed.options ?? {} },
          ];
          subRef.forceSendAbort = true;
          handleAbort();
          ctx.setActivePendingMessages(queue.map((item) => item.text));
          return;
        }
        const parentId = subAgentEvent.parentConversationId;
        const parentQueue = ctx.pendingQueueRef.current.get(parentId) ?? [];
        parentQueue.push({
          text: removed.text,
          options: removed.options ?? {},
        });
        ctx.pendingQueueRef.current.set(parentId, parentQueue);
        ctx.setActivePendingMessages(parentQueue.map((item) => item.text));
        void handleSelectConversation(parentId);
        return;
      }

      // WorkFlow 节点会话的"立即发送"（与上方子代理分支同语义）：把消息暂存
      // 到节点会话的 forceSendMessages 并中断当前回合，workflowRunner 的节点
      // 执行循环会在本节点会话内以新回合继续处理它（见 executeNode 的
      // force-send 循环），而不是停掉节点或把消息转交主流程。绝不能走
      // handleSendMessage —— 那是主流程路径：会把节点会话当成主会话发送
      // （工具集/系统提示不对，还会被侧边栏 upsert 成"独立主会话"），且节点
      // 会因 handleAbort 直接以"被中断"失败收场（状态变结束）。节点已结束
      // （不在活跃节点表）时不进此分支，走下方正常主会话发送——节点会话
      // 本就支持结束后手动继续对话。
      if (isActiveWorkflowNodeSession(sessionKey)) {
        const nodeRef = ctx.sessionsRefData.current.get(sessionKey);
        if (nodeRef) {
          nodeRef.forceSendMessages = [
            ...(nodeRef.forceSendMessages ?? []),
            { text: removed.text, options: removed.options ?? {} },
          ];
          nodeRef.forceSendAbort = true;
          handleAbort();
          ctx.setActivePendingMessages(queue.map((item) => item.text));
          return;
        }
      }

      ctx.setActivePendingMessages(queue.map((item) => item.text));

      // Dispatch the pending message as a fresh send. handleSendMessage
      // will create a new agent loop because handleAbort already reset
      // isSending on the session ref.
      ctx.handleSendMessageRef.current(removed.text, removed.options ?? {});
    },
    [handleAbort, handleSelectConversation, ctx],
  );

  const refreshConversations = useCallback((): void => {
    // 仅触发侧边栏列表全量重拉（置顶/取消置顶/重命名/删除后使用）。
    // 与 conversationVersion（消息持久化信号）解耦，避免 AI 响应刷新列表。
    ctx.setConversationListVersion((version) => version + 1);
  }, [ctx]);

  const handleForkConversation = useCallback(
    async (conversationId: string, upToResponseId: string): Promise<void> => {
      const trimmedId = conversationId.trim();
      if (!trimmedId) return;

      try {
        const forkedRecord = await window.snow.forkConversation(
          trimmedId,
          upToResponseId.trim(),
        );

        // Refresh sidebar list so the new forked conversation appears
        ctx.setUpsertedConversation({
          record: forkedRecord,
          timestamp: Date.now(),
        });

        // Switch to the new forked conversation
        await handleSelectConversation(
          forkedRecord.conversationId,
          forkedRecord.summary || forkedRecord.title,
          {
            inputTokens: forkedRecord.inputTokens,
            outputTokens: forkedRecord.outputTokens,
            cacheCreationInputTokens: forkedRecord.cacheCreationInputTokens,
            cacheReadInputTokens: forkedRecord.cacheReadInputTokens,
          },
          forkedRecord.directoryId,
        );
      } catch {
        // Fork failure should not block the UI
      }
    },
    [handleSelectConversation],
  );

  return {
    withdrawPendingMessage,
    sendPendingMessageNow,
    handleSelectConversation,
    loadOlderMessages,
    handleNewChat,
    handleAbort,
    abortConversation,
    abortWorkflowNodes,
    refreshConversations,
    handleForkConversation,
  };
};
