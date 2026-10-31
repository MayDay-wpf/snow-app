import {
  isDurableSubAgentConversation,
  reportSubAgentParentError,
  stopSubAgentParentTask,
} from "./subAgentParentInbox";
import { useCallback, useRef } from "react";
import type {
  ConversationContextValue,
  ConversationSessionState,
  TokenUsage,
} from "../utils/conversationTypes";
import {
  PENDING_SESSION_KEY,
  CHAT_MESSAGE_PAGE_SIZE,
  isPendingSessionKey,
  olderPageCursorOf,
  toMessageRecordRefs,
} from "../utils/conversationTypes";
import {
  buildConversationMessages,
  deleteCheckpoints,
  directoryIdToPath,
  killRunningToolExecutions,
  tokenUsageFromMessageRecords,
} from "../utils/conversationHelpers";
import { settleInterruptedMessages } from "../utils/messageSettlement";
import {
  extractFileTrackingFromRecords,
  settleFileChangeHydration,
} from "./fileChangeTracking";
import {
  appendHookExecutionToMessage,
  runHook,
  toNonBlockingRecord,
} from "./hookOutcome";
import { prefetchMarkdown } from "../components/markdownRenderer";
import {
  demotePendingSteering,
  refreshPendingMessages,
} from "../utils/pendingInputs";
import { cancelSubAgentRunWaits } from "./subAgentRunControl";
import { imageGenerationRuntime } from "./imageGenerationRuntime";
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

  /**
   * 解析 pending 队列的真实 key：优先直接命中；新会话槽位
   * （__pending__:N）迁移到真实 conversationId 时队列 key 会被搬迁，
   * pendingToRealConversationIdRef 记录该映射；两者都未命中则原样返回
   * （查询不存在的 key 得到空队列，由调用方按“无此条目”处理）。
   */
  const resolvePendingQueueKey = (key: string): string =>
    ctx.pendingQueueRef.current.has(key)
      ? key
      : (ctx.pendingToRealConversationIdRef.current.get(key) ?? key);

  /**
   * 撤回一条待发送消息（从队列移除并返回原文）。targetSessionKey 缺省为
   * 当前激活会话（桌面 Pending 面板只能操作激活会话）；远控等跨会话通道
   * 传入“所见队列”的定位键（真实 id 或槽位 key），经迁移映射解析后从该
   * 队列移除，不受桌面视图切换影响。
   */
  const withdrawPendingMessage = useCallback(
    (index: number, targetSessionKey?: string): string | null => {
      const sessionKey = resolvePendingQueueKey(
        targetSessionKey ??
          ctx.activeSessionKeyRef.current ??
          PENDING_SESSION_KEY,
      );
      const queue = ctx.pendingQueueRef.current.get(sessionKey);
      if (!queue || index < 0 || index >= queue.length) {
        return null;
      }

      const [removed] = queue.splice(index, 1);
      if (queue.length === 0) {
        ctx.pendingQueueRef.current.delete(sessionKey);
      }
      // 显示镜像：主视图只反映当前激活会话的队列；按会话隔离的镜像（会话面板
      // 用）始终同步，否则面板里的队列会残留已撤回的消息。
      refreshPendingMessages(ctx, sessionKey);
      return removed?.text ?? null;
    },
    [],
  );

  const isConversationCacheExpired = (
    session: ConversationSessionState,
  ): boolean => {
    const ttlMs = ctx.conversationCacheTtlMsRef.current;
    return (
      Number.isFinite(ttlMs) &&
      ttlMs > 0 &&
      Date.now() - session.lastAccessedAt > ttlMs
    );
  };

  /** 会话面板发起的按会话加载（不切换主视图）：与选择路径各自的在途表隔离。 */
  const scopeLoadPromisesRef = useRef(new Map<string, Promise<void>>());

  /**
   * 为指定会话加载初始历史，但不切换主视图（右侧面板的会话面板使用）。
   * - 已加载过（内存中标记已完成初始历史，或已有实时消息）直接返回；
   * - 否则拉取首页消息 + 会话记录 + 会话模式，写入该会话的内存态；
   * - 不写主视图的选择态（isLoadingInitialHistory / 模式显示态 / 队列镜像的
   *   激活语义），也不做文件变更统计的历史重建（面板只做只读展示）。
   */
  const loadConversationScope = useCallback(
    async (conversationId: string, directoryId?: string): Promise<void> => {
      const trimmedId = conversationId.trim();
      if (!trimmedId) {
        return;
      }
      const cached = ctx.sessionsRef.current[trimmedId];
      if (cached?.isInitialHistoryLoaded) {
        ctx.updateSessionField(trimmedId, "lastAccessedAt", Date.now());
        return;
      }
      if (cached && cached.messages.length > 0) {
        ctx.updateSessionField(trimmedId, "isInitialHistoryLoaded", true);
        ctx.updateSessionField(trimmedId, "lastAccessedAt", Date.now());
        return;
      }
      const inFlight = scopeLoadPromisesRef.current.get(trimmedId);
      if (inFlight) {
        await inFlight;
        return;
      }

      const loadPromise = (async () => {
        try {
          const [page, record, storedModes] = await Promise.all([
            window.snow.listChatMessagesPaginated(
              trimmedId,
              "",
              CHAT_MESSAGE_PAGE_SIZE,
            ),
            window.snow.getChatConversation(trimmedId),
            window.snow.getConversationModes(trimmedId).catch(() => null),
          ]);
          const defaults = ctx.globalModeDefaultsRef.current;
          const targetDirId =
            directoryId ?? record?.directoryId ?? ctx.directoryId;
          ctx.ensureSession(trimmedId, targetDirId);
          const ref = ctx.sessionsRefData.current.get(trimmedId);
          if (ref && storedModes) {
            ref.goalMode = storedModes.goalMode ?? ref.goalMode;
            ref.worktreeMode = storedModes.worktreeMode ?? ref.worktreeMode;
            ref.workflowMode = storedModes.workflowMode ?? ref.workflowMode;
            ref.goalModeTokenBudget =
              storedModes.goalModeTokenBudget ?? ref.goalModeTokenBudget;
          } else if (ref) {
            ref.goalMode = ref.goalMode ?? defaults.goalMode;
          }
          ctx.setSessions((prev) => {
            const existing = prev[trimmedId];
            // 注意：上面的 ensureSession 会在同一批次里把该会话标记为「初始历史
            // 已加载」的空占位（messages 为空），那不是真的加载过。守卫只能看
            // 「是否已有内容 / 是否正在运行」，否则首次在会话面板打开任何会话
            // （子代理、Workflow 节点等未在主视图加载过的会话）都会永远空白。
            const liveRef = ctx.sessionsRefData.current.get(trimmedId);
            if (
              existing &&
              (existing.messages.length > 0 ||
                existing.isStreaming ||
                liveRef?.isSending)
            ) {
              return prev;
            }
            const isCurrentlyStreaming = Boolean(existing?.isStreaming);
            return {
              ...prev,
              [trimmedId]: {
                messages: buildConversationMessages(page.items),
                messageRecords: toMessageRecordRefs(page.items),
                summary: record?.summary || record?.title || "",
                isStreaming: isCurrentlyStreaming,
                isAborting: existing?.isAborting ?? false,
                isPaused: existing?.isPaused ?? false,
                isLoadingOlderMessages: false,
                hasMoreMessages: page.hasMore,
                isInitialHistoryLoaded: true,
                lastAccessedAt: Date.now(),
                tokenUsage:
                  tokenUsageFromMessageRecords(page.items) ??
                  existing?.tokenUsage ??
                  null,
                directoryId: existing?.directoryId ?? targetDirId,
                hasNewContent: false,
                forkedFromConversationId:
                  record?.forkedFromConversationId || undefined,
                forkMessageCount: record?.forkMessageCount || undefined,
                streamTokenCount: existing?.streamTokenCount ?? 0,
                streamElapsedMs: existing?.streamElapsedMs ?? 0,
                streamTtftMs: existing?.streamTtftMs ?? 0,
                runTtftMs: existing?.runTtftMs ?? 0,
                runTtftSumMs: existing?.runTtftSumMs ?? 0,
                runRequestCount: existing?.runRequestCount ?? 0,
                baselineCheckpointId:
                  page.checkpointIds[0] ?? existing?.baselineCheckpointId,
                streamStartedAt: existing?.streamStartedAt ?? 0,
                runTokenUsage: existing?.runTokenUsage ?? null,
                conversationTokenUsage: existing?.conversationTokenUsage ?? {
                  inputTokens: record?.runInputTokens ?? 0,
                  outputTokens: record?.runOutputTokens ?? 0,
                  cacheCreationInputTokens:
                    record?.runCacheCreationInputTokens ?? 0,
                  cacheReadInputTokens: record?.runCacheReadInputTokens ?? 0,
                },
                lastRunDurationMs: record?.lastRunDurationMs ?? 0,
                conversationTtftSumMs: record?.runTtftSumMs ?? 0,
                conversationRequestCount: record?.runRequestCount ?? 0,
              },
            };
          });
        } catch {
          // 加载失败时静默处理：面板显示空列表，不影响主视图。
        } finally {
          scopeLoadPromisesRef.current.delete(trimmedId);
        }
      })();
      scopeLoadPromisesRef.current.set(trimmedId, loadPromise);
      await loadPromise;
    },
    [],
  );

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
      // 选中会话即视为已读：无论历史是否命中缓存都清除该会话的「已完成」
      // 通知状态（后台完成时由 agent loop 加入）。此前只在命中已加载缓存的
      // 分支里清除，首次打开（缓存未命中）的已完成会话会一直留在跨项目通知
      // 与项目徽标中，直到重载窗口。
      ctx.setCompletedConversationIds((prev) => {
        if (!prev.has(trimmedId)) return prev;
        const next = new Set(prev);
        next.delete(trimmedId);
        return next;
      });
      const cachedSession = ctx.sessionsRef.current[trimmedId];
      const hasLoadedCachedHistory =
        cachedSession !== undefined &&
        !isConversationCacheExpired(cachedSession) &&
        ctx.sessionsRefData.current.has(trimmedId) &&
        cachedSession.isInitialHistoryLoaded === true;

      if (
        trimmedId === ctx.activeConversationIdRef.current &&
        hasLoadedCachedHistory
      ) {
        ctx.updateSessionField(trimmedId, "lastAccessedAt", Date.now());
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
      let targetGoalMode = cachedRef?.goalMode ?? defaults.goalMode;
      let targetWorkflowMode = cachedRef?.workflowMode ?? defaults.workflowMode;
      const targetBudget =
        cachedRef?.goalModeTokenBudget ?? defaults.goalModeTokenBudget;
      if (targetWorkflowMode) {
        targetWorktreeMode = false;
        targetGoalMode = false;
      } else if (targetWorktreeMode) {
        targetGoalMode = false;
      }
      if (cachedRef) {
        cachedRef.worktreeMode = targetWorktreeMode;
        cachedRef.goalMode = targetGoalMode;
        cachedRef.workflowMode = targetWorkflowMode;
      }
      if (ctx.worktreeModeRef.current !== targetWorktreeMode) {
        ctx.worktreeModeRef.current = targetWorktreeMode;
        ctx.setWorktreeModeState(targetWorktreeMode);
      }
      ctx.setPendingWorktreeId(null);
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
            // WorkFlow > WorkTree > Goal. Repair a conflicting database row
            // asynchronously after choosing the effective state.
            let storedWorktreeMode =
              storedModes?.worktreeMode ?? defaults.worktreeMode;
            let storedGoalMode = storedModes?.goalMode ?? defaults.goalMode;
            let storedWorkflowMode =
              storedModes?.workflowMode ?? defaults.workflowMode;
            let storedBudget =
              storedModes?.goalModeTokenBudget ?? defaults.goalModeTokenBudget;
            const hasModeConflict =
              (storedWorkflowMode && (storedWorktreeMode || storedGoalMode)) ||
              (storedWorktreeMode && storedGoalMode);
            if (storedWorkflowMode) {
              storedWorktreeMode = false;
              storedGoalMode = false;
            } else if (storedWorktreeMode) {
              storedGoalMode = false;
            }
            if (hasModeConflict) {
              void window.snow.setConversationModes(
                trimmedId,
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
              const ownTracking = extractFileTrackingFromRecords(fullHistory);
              const ownChanges = ownTracking.changes;
              ctx.mergeFileChangeCoverage(
                trimmedId,
                ownTracking.coverage.map((coverage) => ({
                  ...coverage,
                  agent: isSubAgentConversation
                    ? ("sub" as const)
                    : ("main" as const),
                  subAgentName: isSubAgentConversation
                    ? conversationRecord?.subAgentName || undefined
                    : undefined,
                })),
              );
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
                      const subTracking =
                        extractFileTrackingFromRecords(subRecords);
                      const subChanges = subTracking.changes;
                      const subAgentName =
                        subConversation.subAgentName ||
                        subConversation.title ||
                        undefined;
                      const coverageRecords = subTracking.coverage.map(
                        (coverage) => ({
                          ...coverage,
                          agent: "sub" as const,
                          subAgentName,
                        }),
                      );
                      ctx.mergeFileChangeCoverage(trimmedId, coverageRecords);
                      ctx.mergeFileChangeCoverage(
                        subConversation.conversationId,
                        coverageRecords,
                      );
                      ctx.mergeFileChangeStats(
                        subConversation.conversationId,
                        subChanges.map((change) => ({
                          ...change,
                          agent: "sub" as const,
                          subAgentName,
                        })),
                      );
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
              settleFileChangeHydration(trimmedId);
            }

            // Cache the fetched page even when this request was superseded
            // while in flight (the user switched to another conversation).
            // Guard with the current session so a newer load's snapshot is
            // never clobbered by an older one. Later selections of the same
            // conversation then render instantly from the cache.
            const imageRuntime = imageGenerationRuntime(ctx);
            await imageRuntime.recover(trimmedId);
            const historyMessages = imageRuntime.replay(
              trimmedId,
              buildConversationMessages(page.items),
            );
            const currentSession = ctx.sessionsRef.current[trimmedId];
            if (!currentSession || isConversationCacheExpired(currentSession)) {
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
                  worktreeMode: storedWorktreeMode,
                  goalMode: storedGoalMode,
                  workflowMode: storedWorkflowMode,
                  goalModeTokenBudget: storedBudget,
                  subAgentTerminated: isTerminatedSubAgent || undefined,
                  runTokenUsage: null,
                  lastRunDurationMs: 0,
                  runTtftSumMs: 0,
                  runRequestCount: 0,
                });
              }
              ctx.setSessions((prev) => {
                const existing = prev[trimmedId];
                if (existing && !isConversationCacheExpired(existing)) {
                  return prev;
                }
                const liveRef = ctx.sessionsRefData.current.get(trimmedId);
                const isCurrentlyStreaming = Boolean(
                  existing?.isStreaming ||
                  ctx.streamingConversationIds.has(trimmedId) ||
                  liveRef?.isSending,
                );
                // 运行中冷加载：起点从 runtime ref 恢复，避免计时停在 0s。
                const restoredStartedAt = isCurrentlyStreaming
                  ? existing?.streamStartedAt || liveRef?.runStartedAt || 0
                  : 0;
                return {
                  ...prev,
                  [trimmedId]: {
                    messages: historyMessages,
                    messageRecords: toMessageRecordRefs(page.items),
                    summary: nextTitle,
                    isStreaming: isCurrentlyStreaming,
                    isAborting: false,
                    isPaused: false,
                    isLoadingOlderMessages: false,
                    hasMoreMessages: page.hasMore,
                    isInitialHistoryLoaded: true,
                    lastAccessedAt: Date.now(),
                    tokenUsage:
                      tokenUsageFromMessageRecords(page.items) ??
                      conversationTokenUsage ??
                      null,
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
                    runTtftSumMs: 0,
                    runRequestCount: 0,
                    baselineCheckpointId,
                    streamStartedAt: restoredStartedAt,
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
                    conversationTtftSumMs:
                      conversationRecord?.runTtftSumMs ?? 0,
                    conversationRequestCount:
                      conversationRecord?.runRequestCount ?? 0,
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
      ctx.goalModeRef,
      ctx.setGoalModeState,
      ctx.goalModeTokenBudget,
      ctx.setGoalModeTokenBudgetState,
      ctx.globalModeDefaultsRef,
      ctx.pendingQueueRef,
      ctx.setActivePendingMessages,
    ],
  );

  const loadOlderMessages = useCallback(
    async (pageSize?: number, sessionKey?: string): Promise<void> => {
      // 可能被直接当事件回调调用，非数字参数一律回落默认页长。
      const limit =
        typeof pageSize === "number" && pageSize > 0
          ? Math.floor(pageSize)
          : CHAT_MESSAGE_PAGE_SIZE;
      const conversationId = sessionKey ?? ctx.activeConversationIdRef.current;
      if (!conversationId) {
        return;
      }

      const session = ctx.sessionsRef.current[conversationId];
      // 窗口裁剪过则沿裁剪游标翻页，否则取已加载的最早（非孤立 tool）记录。
      const beforeMessageId =
        session?.olderCursorId ??
        (session ? olderPageCursorOf(session.messageRecords) : undefined);
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
          limit,
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

        // 新页 markdown 先行预热（倒序：贴近视口的最新旧消息优先，worker
        // 按派发顺序处理）。MarkdownBlock 挂载时缓存未命中会先渲染空 html，
        // worker 返回后内容涌入，新消息高度经历「近空白 → 真实高度」的剧变；
        // ChatContent 的翻页滚动恢复若落在该窗口期，按偏小的 scrollHeight
        // 补偿 scrollTop 必然错位，随后涌入的内容再推挤视口——表现为翻页
        // 后滚动位置跳变。预热让新消息挂载首帧即为最终高度。超时由
        // prefetchMarkdown 内部兜底，worker 忙碌时不会卡死翻页。
        if (olderRecords.length > 0) {
          const prefetchTargets: string[] = [];
          for (let i = olderRecords.length - 1; i >= 0; i--) {
            const record = olderRecords[i];
            if (record.role === "user") {
              continue;
            }
            const content = record.content?.trim();
            if (content) {
              prefetchTargets.push(content);
            }
            const thinking = record.thinking?.trim();
            if (thinking) {
              prefetchTargets.push(thinking);
            }
          }
          if (prefetchTargets.length > 0) {
            await prefetchMarkdown(prefetchTargets);
          }
        }

        const imageRuntime = imageGenerationRuntime(ctx);
        await imageRuntime.recover(conversationId);
        const projectImages = imageRuntime.projection(conversationId);
        ctx.setSessions((prev) => {
          const latestSession = prev[conversationId];
          if (!latestSession) {
            return prev;
          }
          // 加载期间窗口被裁剪或重置：本页与当前窗口不再相邻，丢弃。
          const latestCursor =
            latestSession.olderCursorId ??
            olderPageCursorOf(latestSession.messageRecords);
          if (latestCursor !== beforeMessageId) {
            return {
              ...prev,
              [conversationId]: {
                ...latestSession,
                isLoadingOlderMessages: false,
              },
            };
          }
          const persistedIds = new Set(
            latestSession.messageRecords.map((record) => record.id),
          );
          const combinedRecords = [
            ...toMessageRecordRefs(
              page.items.filter((record) => !persistedIds.has(record.id)),
            ),
            ...latestSession.messageRecords,
          ];
          // 本页只构建更早的消息（游标之前的孤立 tool 记录随页取回，用于挂结果），
          // 窗口内已有消息原样保留，无需持有完整记录重建。
          return {
            ...prev,
            [conversationId]: {
              ...latestSession,
              messages: projectImages([
                ...buildConversationMessages(page.items),
                ...latestSession.messages,
              ]),
              messageRecords: combinedRecords,
              isLoadingOlderMessages: false,
              hasMoreMessages: page.hasMore,
              olderCursorId:
                olderPageCursorOf(combinedRecords) ??
                latestSession.olderCursorId,
              lastAccessedAt: Date.now(),
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
    },
    [ctx.updateSessionField],
  );

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

      // Reset WorkTree Mode so a new chat always starts with the GLOBAL
      // default (not the previous conversation's mode — real per-conversation
      // isolation). The global defaults are only mutated by explicit user
      // toggles, so no persisted write is needed here.
      const defaults = ctx.globalModeDefaultsRef.current;
      if (ctx.worktreeModeRef.current !== defaults.worktreeMode) {
        ctx.worktreeModeRef.current = defaults.worktreeMode;
        ctx.setWorktreeModeState(defaults.worktreeMode);
      }
      ctx.setPendingWorktreeId(null);

      // Reset WorkFlow Mode so a new chat starts with the global default.
      if (ctx.workflowModeRef.current !== defaults.workflowMode) {
        ctx.workflowModeRef.current = defaults.workflowMode;
        ctx.setWorkflowModeState(defaults.workflowMode);
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
      // to the currently active project. 空串 / 空白串一律视为未指定，否则会
      // 覆盖成空 projectId，导致后续所有工具调用被 IPC 拒收。
      ctx.pendingDirectoryIdRef.current = directoryId?.trim() || undefined;

      // 新视图对应全新的 pending 槽位，其队列必然为空：Pending 面板
      // 清空，旧视图/旧会话的排队消息不会渗入新视图。
      ctx.setActivePendingMessages([]);
    },
    [
      ctx.setActiveId,
      ctx.setNewChatRequested,
      ctx.setRollbackNewChatState,
      ctx.setNewChatGeneration,
      ctx.worktreeModeRef,
      ctx.setWorktreeModeState,
      ctx.goalModeRef,
      ctx.setGoalModeState,
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
      if (isDurableSubAgentConversation(subKey)) {
        void stopSubAgentParentTask(ctx, subKey).catch((error) =>
          reportSubAgentParentError(ctx, subKey, error),
        );
        return;
      }
      const subRef = ctx.sessionsRefData.current.get(subKey);
      if (!subRef || subRef.isAbortRequested) {
        return;
      }
      subRef.isAbortRequested = true;
      subRef.isSending = false;
      subRef.activeSendOptions = undefined;
      subRef.activeTaskMessages = undefined;
      cancelSubAgentRunWaits(subKey);
      demotePendingSteering(ctx, subKey);
      // Settle the sub-agent's own pending authorizations (scoped to its
      // session key) so its agent loop cannot stay blocked awaiting a
      // decision that will never arrive.
      rejectToolAuthorizations(subKey);
      killRunningToolExecutions(
        ctx.sessionsRef.current?.[subKey]?.messages ?? [],
      );

      ctx.updateSessionMessages(subKey, settleInterruptedMessages);
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

  const handleAbort = useCallback(
    (targetSessionKey?: string): void => {
      // targetSessionKey 缺省为当前激活会话；远控通道的“立即发送”会显式
      // 传入消息所属会话，使后台会话的运行也能被定点中断。
      // 非字符串入参（例如直接把本函数绑到 onClick 时漏进来的 MouseEvent）
      // 一律回退到当前激活会话，避免查找失败而静默不中断。
      const key =
        typeof targetSessionKey === "string" && targetSessionKey.length > 0
          ? targetSessionKey
          : (ctx.activeSessionKeyRef.current ?? PENDING_SESSION_KEY);
      const ref = ctx.sessionsRefData.current.get(key);
      if (!isPendingSessionKey(key)) {
        // 子代理的「立即发送」只软中断当前回合（forceSendAbort 已预置），
        // 不能取消其持久运行：回合收尾后由强行发送循环在本会话继续。
        const durableChild = isDurableSubAgentConversation(key);
        if (!durableChild || !ref?.forceSendAbort) {
          void stopSubAgentParentTask(ctx, key).catch((error) =>
            reportSubAgentParentError(ctx, key, error),
          );
          if (durableChild) return;
        }
      }
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
      ref.activeSendOptions = undefined;
      ref.activeTaskMessages = undefined;
      cancelSubAgentRunWaits(key);
      demotePendingSteering(ctx, key);
      ctx.updateSessionMessages(key, settleInterruptedMessages);
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
    },
    [
      ctx.removeStreamingId,
      rejectToolAuthorizations,
      rejectPendingUserQuestions,
      ctx.updateSessionMessages,
      ctx.updateSessionField,
      ctx.pauseControllerRef,
      abortWorkflowNodes,
      abortSubAgentTree,
    ],
  );

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
   * Immediately send a pending message: abort the target session's in-flight
   * run, remove the message from its pending queue, and dispatch it via
   * handleSendMessage so a fresh agent loop starts right away.
   *
   * This is used when the user does not want to wait for the current AI
   * response to finish — the ongoing stream is cancelled and the selected
   * pending message is sent immediately. targetSessionKey 缺省为当前激活
   * 会话（桌面面板只操作激活会话）；远控通道传入“所见队列”的定位键
   * （真实 id 或槽位 key，经迁移映射解析），操作按该队列执行（含定点中断
   * 其所属会话的运行），不受桌面视图切换影响。返回是否命中队列条目
   * （未命中 = 已被消费或队列已变化）。
   */
  const sendPendingMessageNow = useCallback(
    (index: number, targetSessionKey?: string): boolean => {
      const sessionKey = resolvePendingQueueKey(
        targetSessionKey ??
          ctx.activeSessionKeyRef.current ??
          PENDING_SESSION_KEY,
      );
      // 显示镜像只反映当前激活会话的队列（会话隔离）：目标为后台会话时
      // 不更新镜像，等切回该会话时再从队列重载。激活基准同样经迁移映射
      // 解析（槽位迁移后 activeSessionKey 与队列 key 可能相差一层映射）。
      const isActiveTarget =
        sessionKey ===
        resolvePendingQueueKey(
          ctx.activeSessionKeyRef.current ?? PENDING_SESSION_KEY,
        );
      const queue = ctx.pendingQueueRef.current.get(sessionKey);
      if (!queue || index < 0 || index >= queue.length) {
        return false;
      }

      // A terminated child retains its pending input; it is not parent authorization.
      if (
        ctx.subAgentSessionEventsRef.current[sessionKey]
          ?.parentConversationId &&
        ctx.sessionsRefData.current.get(sessionKey)?.subAgentTerminated
      )
        return false;

      // 中断目标会话的当前回合放到各分支内：子代理 / Workflow 节点必须先
      // 预置 forceSendAbort 再中断，否则会被当成用户停止（子代理会被取消）。

      // Remove the target message (and its original send options) from
      // the pending queue.
      const [taken] = queue.splice(index, 1);
      if (queue.length === 0) {
        ctx.pendingQueueRef.current.delete(sessionKey);
      }
      // 立即发送即视为送达，正文按投递格式拼接来源
      const removed = taken;

      if (!removed) {
        if (isActiveTarget) {
          ctx.setActivePendingMessages(queue.map((item) => item.text));
        }
        return false;
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
          handleAbort(sessionKey);
          if (isActiveTarget) {
            ctx.setActivePendingMessages(queue.map((item) => item.text));
          }
          return true;
        }
        handleAbort(sessionKey);
        const parentId = subAgentEvent.parentConversationId;
        const parentQueue = ctx.pendingQueueRef.current.get(parentId) ?? [];
        parentQueue.push({
          text: removed.text,
          options: removed.options ?? {},
        });
        ctx.pendingQueueRef.current.set(parentId, parentQueue);
        // 即将切换到父会话，镜像由 handleSelectConversation 按目标会话
        // 重载；仅当父会话恰为当前视图时提前同步。
        if (parentId === ctx.activeSessionKeyRef.current) {
          ctx.setActivePendingMessages(parentQueue.map((item) => item.text));
        }
        void handleSelectConversation(parentId);
        return true;
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
          handleAbort(sessionKey);
          if (isActiveTarget) {
            ctx.setActivePendingMessages(queue.map((item) => item.text));
          }
          return true;
        }
      }

      if (isActiveTarget) {
        ctx.setActivePendingMessages(queue.map((item) => item.text));
      }

      // Abort the target session's streaming run so isSending flips to
      // false and handleSendMessage will start a new agent loop instead of
      // re-queuing the message.
      handleAbort(sessionKey);

      // Dispatch the pending message as a fresh send. handleSendMessage
      // will create a new agent loop because handleAbort already reset
      // isSending on the session ref. 非激活目标必须显式指定会话，否则
      // 消息会被发到当前视图会话；激活目标保持原调用形态（新会话首条
      // 逻辑依赖 activeSessionKeyRef）。
      ctx.handleSendMessageRef.current(removed.text, {
        ...(removed.options ?? {}),
        ...(isActiveTarget ? {} : { targetSessionKey: sessionKey }),
      });
      return true;
    },
    [handleAbort, handleSelectConversation, ctx],
  );

  const refreshConversations = useCallback((): void => {
    // 仅触发侧边栏列表全量重拉（置顶/取消置顶/重命名/删除后使用）。
    // 与 conversationVersion（消息持久化信号）解耦，避免 AI 响应刷新列表。
    ctx.setConversationListVersion((version) => version + 1);
  }, [ctx]);

  const refreshConversationTree = useCallback((): void => {
    // 仅触发侧边栏树形数据重查（workflow 节点 / 子代理会话的创建与状态变化）。
    // 与 refreshConversations 解耦：主会话列表本身没有变化，重拉会让整个
    // 会话区域闪一次 loading 并丢失滚动位置。
    ctx.setConversationTreeVersion((version) => version + 1);
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
    loadConversationScope,
    loadOlderMessages,
    handleNewChat,
    handleAbort,
    abortConversation,
    abortWorkflowNodes,
    refreshConversations,
    refreshConversationTree,
    handleForkConversation,
  };
};
