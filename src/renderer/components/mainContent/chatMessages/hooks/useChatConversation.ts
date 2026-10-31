import {
  revokeSubAgentParentOwnership,
  useSubAgentParentInbox,
} from "./subAgentParentInbox";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  BackgroundRunResult,
  ChatInputSendOptions,
} from "../../chatInput/types";
import type {
  AutoSendRequest,
  ConversationInputRuntimeState,
  RollbackWorkflowComposerState,
} from "../../chatInput/types";
import type {
  ApiConfigRecord,
  ScheduledTaskRunOptions,
} from "../../../../../preload";

import type {
  ChatConversationMessage,
  ChatConversationSessions,
  ConversationContextValue,
  CompactionResult,
  GlobalModeDefaults,
  FileChangeRecord,
  PauseController,
  PendingQueueItem,
  SessionRuntimeSnapshot,
  UseChatConversationResult,
} from "../utils/conversationTypes";
import {
  PENDING_SESSION_KEY,
  getBackgroundPendingSessionKey,
  getPendingSessionKey,
  isPendingSessionKey,
} from "../utils/conversationTypes";
import { resolveAutoSendOptions } from "../../chatInput/autoSendOptions";
import {
  CONVERSATION_CACHE_TTL_CHANGED_EVENT,
  CONVERSATION_CACHE_TTL_DEFAULT_MINUTES,
  CONVERSATION_CACHE_TTL_SETTING,
  normalizeConversationCacheTtlMinutes,
} from "../../../../constants/conversationCache";
import { useConversationSession } from "./useConversationSession";
import { useToolAuthorization } from "./useToolAuthorization";
import { useUserQuestion } from "./useUserQuestion";
import { useCompaction } from "./useCompaction";
import { useRollback } from "./useRollback";
import { useAgentLoop } from "./useAgentLoop";
import { useConversationManagement } from "./useConversationManagement";
import { useImageGenerationRuntime } from "./imageGenerationRuntime";
import {
  useConversationAbortBridge,
  useConversationMessageBridge,
  useConversationRemovalBridge,
} from "./conversationMessageBridge";
import {
  PLUGIN_CONVERSATION_LIST_CHANGED_EVENT,
  type PluginConversationListChangedDetail,
} from "../../../../plugins/pluginEvents";
import { archiveSubAgentRunActivity } from "../utils/subAgentRunActivity";
import {
  isFileChangeHydrationReleased,
  releaseFileChangeHydration,
} from "./fileChangeTracking";
import {
  focusPanelConversation,
  isConversationOwnedByPanel,
  subscribePanelConversationChange,
} from "../../../common/conversationPanelOwnership";

/** 已结束的子代理会话在内存中的保留时长上限：仍可随时从数据库重新载入。 */
const ENDED_SUB_AGENT_SESSION_TTL_MS = 3 * 60_000;

/** 去掉指定会话的条目；没有命中时返回原对象，避免无意义的状态更新。 */
const omitKeys = <T>(
  record: Record<string, T>,
  keys: string[],
): Record<string, T> => {
  if (!keys.some((key) => key in record)) {
    return record;
  }
  const next = { ...record };
  for (const key of keys) {
    delete next[key];
  }
  return next;
};

/** 空数组常量：避免"无当前会话 / 无队列"时每次渲染都产生新引用，击穿下游 memo。 */
const EMPTY_MESSAGES: ChatConversationMessage[] = [];
const EMPTY_CHECKPOINT_IDS: string[] = [];
const EMPTY_PENDING_QUEUE: PendingQueueItem[] = [];

/**
 * 内容不变时复用上一次的数组引用。用于把"每帧新建的派生数组"变成可作为
 * useMemo 依赖的稳定值：内容相同则引用不变，下游 memo 不会被击穿。
 */
const useStableArray = <T>(next: T[]): T[] => {
  const ref = useRef<T[]>(next);
  const previous = ref.current;
  if (previous.length === next.length) {
    let same = true;
    for (let index = 0; index < next.length; index += 1) {
      if (previous[index] !== next[index]) {
        same = false;
        break;
      }
    }
    if (same) {
      return previous;
    }
  }
  ref.current = next;
  return next;
};

export const useChatConversation = (
  directoryId?: string,
  directoryPath?: string,
  isDetachedWindow = false,
): {
  conversation: UseChatConversationResult;
  sessions: ChatConversationSessions;
} => {
  // --- State ---
  const [sessions, setSessions] = useState<
    Record<string, ConversationContextValue["sessions"][string]>
  >({});
  const [activeConversationId, setActiveConversationId] = useState<
    string | undefined
  >(undefined);
  const [conversationVersion, setConversationVersion] = useState(0);
  // 侧边栏列表刷新信号：与 conversationVersion 分离，AI 响应迭代只 bump
  // conversationVersion（UserMessageRail 用），列表仅靠增量 upsert 同步。
  const [conversationListVersion, setConversationListVersion] = useState(0);
  // 侧边栏树形数据刷新信号：workflow 节点 / 子代理会话的创建与状态变化只
  // bump 它，避免重拉主会话列表导致整个会话区域闪一次 loading。
  const [conversationTreeVersion, setConversationTreeVersion] = useState(0);
  const [upsertedConversation, setUpsertedConversation] =
    useState<ConversationContextValue["upsertedConversation"]>(null);
  const [subAgentSessionEvents, setSubAgentSessionEvents] = useState<
    ConversationContextValue["subAgentSessionEvents"]
  >({});
  // Live ref mirror of subAgentSessionEvents so long-lived async closures
  // (sub-agent loops, teammate communication tools) always read the freshest
  // sub-agent status instead of a stale React state snapshot. Updated both
  // during render and synchronously inside setSubAgentSessionEvent.
  const subAgentSessionEventsRef = useRef<
    ConversationContextValue["subAgentSessionEventsRef"]["current"]
  >({});
  subAgentSessionEventsRef.current = subAgentSessionEvents;
  // Upsert a single sub-agent event keyed by its conversationId so multiple
  // parallel sub-agents each keep their own live entry.
  const setSubAgentSessionEvent = useCallback(
    (event: ConversationContextValue["subAgentSessionEvents"][string]) => {
      subAgentSessionEventsRef.current[event.conversationId] = event;
      setSubAgentSessionEvents((prev) => ({
        ...prev,
        [event.conversationId]: event,
      }));
    },
    [],
  );
  // File-change stats collected at tool-execution time, keyed by
  // conversationId. Sub-agent changes are stored under the sub-agent's own
  // conversationId; the parent merges them via childSubAgentIds for display.
  // When a conversation is opened (or re-opened after a restart), the stats
  // are re-hydrated from persisted history — see mergeFileChangeStats and
  // fileChangeStatsHydratedRef.
  const [fileChangeStats, setFileChangeStats] = useState<
    ConversationContextValue["fileChangeStats"]
  >({});
  // Conversation ids whose file-change stats are already fully accounted for:
  // either re-hydrated from persisted history, or recorded live by the tool
  // pipeline (recordFileChange marks the id, so live sessions never get
  // double-counted by a later history re-hydration).
  const fileChangeStatsHydratedRef = useRef<Set<string>>(new Set());
  // 被 TTL 释放过统计的会话在重新打开重建前，实时记录只是增量。
  const markFileChangesLive = useCallback((conversationId: string): void => {
    if (!isFileChangeHydrationReleased(conversationId)) {
      fileChangeStatsHydratedRef.current.add(conversationId);
    }
  }, []);
  const recordFileChange = useCallback(
    (
      conversationId: string,
      record: ConversationContextValue["fileChangeStats"][string][number],
    ) => {
      markFileChangesLive(conversationId);
      setFileChangeStats((prev) => ({
        ...prev,
        [conversationId]: [...(prev[conversationId] ?? []), record],
      }));
    },
    [markFileChangesLive],
  );
  const mergeFileChangeStats = useCallback(
    (conversationId: string, records: FileChangeRecord[]): void => {
      if (records.length === 0) {
        return;
      }
      setFileChangeStats((prev) => {
        const existing = prev[conversationId] ?? [];
        const existingKeys = new Set(
          existing.map((record) =>
            JSON.stringify([
              record.fileKey ?? record.filePath,
              record.kind,
              record.timestamp,
              record.agent,
              record.subAgentName,
              record.source,
            ]),
          ),
        );
        const fresh = records.filter(
          (record) =>
            !existingKeys.has(
              JSON.stringify([
                record.fileKey ?? record.filePath,
                record.kind,
                record.timestamp,
                record.agent,
                record.subAgentName,
                record.source,
              ]),
            ),
        );
        if (fresh.length === 0) {
          return prev;
        }
        return {
          ...prev,
          [conversationId]: [...existing, ...fresh],
        };
      });
    },
    [],
  );
  const [fileChangeCoverage, setFileChangeCoverage] = useState<
    ConversationContextValue["fileChangeCoverage"]
  >({});
  const recordFileChangeCoverage = useCallback(
    (
      conversationId: string,
      record: ConversationContextValue["fileChangeCoverage"][string][number],
    ) => {
      markFileChangesLive(conversationId);
      setFileChangeCoverage((prev) => ({
        ...prev,
        [conversationId]: [...(prev[conversationId] ?? []), record],
      }));
    },
    [markFileChangesLive],
  );
  const mergeFileChangeCoverage = useCallback(
    (
      conversationId: string,
      records: ConversationContextValue["fileChangeCoverage"][string],
    ) => {
      setFileChangeCoverage((prev) => {
        const existing = prev[conversationId] ?? [];
        const key = (
          record: ConversationContextValue["fileChangeCoverage"][string][number],
        ) => JSON.stringify(record);
        const keys = new Set(existing.map(key));
        const fresh = records.filter((record) => {
          const value = key(record);
          if (keys.has(value)) return false;
          keys.add(value);
          return true;
        });
        return fresh.length
          ? { ...prev, [conversationId]: [...existing, ...fresh] }
          : prev;
      });
    },
    [],
  );
  const [streamingConversationIds, setStreamingConversationIds] = useState<
    Set<string>
  >(new Set());
  const streamingConversationIdsRef = useRef(streamingConversationIds);
  streamingConversationIdsRef.current = streamingConversationIds;
  const [completedConversationIds, setCompletedConversationIds] = useState<
    Set<string>
  >(new Set());
  const [
    pendingUserQuestionConversationIds,
    setPendingUserQuestionConversationIds,
  ] = useState<Set<string>>(new Set());
  const [isLoadingInitialHistory, setIsLoadingInitialHistory] = useState(false);
  const [draftToRestore, setDraftToRestore] = useState<string | null>(null);
  // 回滚编排提交消息：编排图无法写进输入框，改为回填编排器弹窗。
  const [rollbackWorkflowComposer, setRollbackWorkflowComposer] =
    useState<RollbackWorkflowComposerState | null>(null);
  // buildFromContent 的前台自动发送队列：队首（activeAutoSend）被输入区发送后
  // 才激活下一条，多次请求不会互相覆盖。
  const [activeAutoSend, setActiveAutoSend] = useState<AutoSendRequest | null>(
    null,
  );
  const activeAutoSendRef = useRef<AutoSendRequest | null>(null);
  const autoSendClaimedRef = useRef(false);
  const autoSendQueueRef = useRef<AutoSendRequest[]>([]);
  const autoSendSeqRef = useRef(0);
  // 后台会话（定时任务）的槽位序号，与新会话视图的 pendingSessionSeqRef 独立。
  const backgroundSessionSeqRef = useRef(0);
  const [rollbackPreview, setRollbackPreview] =
    useState<ConversationContextValue["rollbackPreview"]>(null);
  const [rollbackNewChatState, setRollbackNewChatState] =
    useState<ConversationContextValue["rollbackNewChatState"]>(null);
  const [newChatRequested, setNewChatRequested] = useState(false);
  // Renderer-only lifecycle marker. It must never be reset when the active
  // conversation changes: every new-chat request gets a fresh generation even
  // when the pending session key is reused.
  const [newChatGeneration, setNewChatGeneration] = useState(0);
  // 聊天视图身份 key：真实 conversationId 或 "new-chat"。pending 会话迁移为
  // 真实 ID 时由 setActiveId(preserveViewKey) 保持不变，chat-area / ChatInput
  // 的 key 因此不重建（避免迁移瞬间页面闪烁与输入框失焦）。
  const [sessionViewKey, setSessionViewKey] = useState("new-chat");
  const [yoloMode, setYoloModeState] = useState(false);
  const [isUpdatingYoloMode, setIsUpdatingYoloMode] = useState(false);
  const [liteMode, setLiteModeState] = useState(false);
  const [isUpdatingLiteMode, setIsUpdatingLiteMode] = useState(false);
  const [goalMode, setGoalModeState] = useState(false);
  const [isUpdatingGoalMode, setIsUpdatingGoalMode] = useState(false);
  const [worktreeMode, setWorktreeModeState] = useState(false);
  const [isUpdatingWorktreeMode, setIsUpdatingWorktreeMode] = useState(false);
  const [workflowMode, setWorkflowModeState] = useState(false);
  const [isUpdatingWorkflowMode, setIsUpdatingWorkflowMode] = useState(false);
  const [goalModeTokenBudget, setGoalModeTokenBudgetState] = useState(2000000);
  const [pendingWorktreeId, setPendingWorktreeIdState] = useState<
    string | null
  >(null);
  const pendingWorktreeIdRef = useRef<string | null>(null);
  const setPendingWorktreeId = useCallback((worktreeId: string | null) => {
    pendingWorktreeIdRef.current = worktreeId;
    setPendingWorktreeIdState(worktreeId);
  }, []);
  // WorkTree 模式已开启但未绑定工作树时的内置提示：发送被拦截时置为文案，
  // 由 ChatContent 用内置弹窗渲染，确认后清空。
  const [worktreeModeNotice, setWorktreeModeNotice] = useState<string | null>(
    null,
  );
  const [pendingToolAuthorizations, setPendingToolAuthorizations] = useState<
    ConversationContextValue["pendingToolAuthorizations"]
  >([]);
  // 按会话隔离的待授权镜像：会话面板据此渲染自己会话的授权卡片。
  const [
    pendingToolAuthorizationsBySession,
    setPendingToolAuthorizationsBySession,
  ] = useState<ConversationContextValue["pendingToolAuthorizationsBySession"]>(
    {},
  );
  // 按会话隔离的待发送队列显示镜像：会话面板据此渲染自己会话的队列。
  const [pendingQueueMirrors, setPendingQueueMirrors] = useState<
    ConversationContextValue["pendingQueueMirrors"]
  >({});
  // 被会话面板打开并钉住的会话：缓存 TTL 回收与释放跳过它们（面板仍在使用
  // 这些会话的内存态，释放后需要重新从数据库加载）。
  const pinnedSessionKeysRef = useRef<Set<string>>(new Set());
  const attentionRequiredConversationIds = useMemo(() => {
    const conversationIds = new Set(pendingUserQuestionConversationIds);
    for (const toolCall of pendingToolAuthorizations) {
      const conversationId = toolCall.authorizationConversationId?.trim();
      if (conversationId) {
        conversationIds.add(conversationId);
      }
    }
    return conversationIds;
  }, [pendingToolAuthorizations, pendingUserQuestionConversationIds]);
  const [activePendingMessages, setActivePendingMessages] = useState<string[]>(
    [],
  );
  const [compactionPreview, setCompactionPreview] = useState("");
  const [compactionError, setCompactionError] = useState<string | null>(null);
  const [isCompacting, setIsCompacting] = useState(false);
  const [compactingConversationId, setCompactingConversationId] = useState<
    string | null
  >(null);
  // 点 × 必须把 compactingConversationId 一起复位：压缩失败时该标记被故意
  // 保留在会话上让错误条持续可见（见 useCompaction 的 finally），用户主动
  // 关闭提示后残留标记会让回滚、远控快照继续引用一条已关闭的提示。
  // 错误条只在压缩结束（isCompacting 已复位）后才出现，因此这里不存在
  // 清掉进行中压缩标记的竞态。
  const dismissCompactionError = useCallback(() => {
    setCompactionError(null);
    setCompactingConversationId(null);
  }, []);

  // --- Refs ---
  const sessionsRefData = useRef<
    ConversationContextValue["sessionsRefData"]["current"]
  >(new Map());
  const activeConversationIdRef = useRef<string | undefined>(undefined);
  // 新会话槽位序号与当前视图会话 key（真实 id 或 pending 槽位 key）。
  // 详见 conversationTypes 中 PENDING_SESSION_KEY_PREFIX 的说明。
  const pendingSessionSeqRef = useRef(0);
  const activeSessionKeyRef = useRef<string | undefined>(
    getPendingSessionKey(0),
  );
  // pending 槽位 -> 迁移后的真实 conversationId（侧边栏占位替换用）。
  const pendingToRealConversationIdRef = useRef<Map<string, string>>(new Map());
  const pendingDirectoryIdRef = useRef<string | undefined>(undefined);
  const selectionRequestIdRef = useRef(0);
  const historyLoadPromisesRef = useRef(new Map<string, Promise<void>>());
  const loadingOlderConversationIdsRef = useRef(new Set<string>());
  const sessionsRef = useRef<
    ConversationContextValue["sessionsRef"]["current"]
  >({});
  sessionsRef.current = sessions;
  const newChatRequestedRef = useRef(false);
  newChatRequestedRef.current = newChatRequested;

  const pendingQueueRef = useRef<
    ConversationContextValue["pendingQueueRef"]["current"]
  >(new Map());
  // Per-conversation input drafts. Stored in a ref (no re-render on every
  // keystroke). ChatInput saves on change and unmount, restores on mount,
  // and clears after a successful send. New-chat drafts (conversationId
  // undefined) live under PENDING_SESSION_KEY and are cleared on send.
  const inputDraftsRef = useRef<Record<string, string>>({});
  const runtimeInputStateRef = useRef<
    Record<string, ConversationInputRuntimeState>
  >({});
  const updateRuntimeInputState = useCallback(
    (
      conversationId: string | undefined,
      state: ConversationContextValue["runtimeInputStateRef"]["current"][string],
    ): void => {
      runtimeInputStateRef.current[
        conversationId ?? ctx.activeSessionKeyRef.current ?? PENDING_SESSION_KEY
      ] = state;
    },
    [],
  );
  /**
   * 读取会话的内存态输入选择（渠道/模型/思考强度/Fast Mode）。
   * 内存态是本次运行的权威值：切换后尚未发送的选择必须在会话切换后保留，
   * 因此输入区 hydration 时优先使用它，而不是数据库里的旧快照。
   */
  const getRuntimeInputState = useCallback(
    (conversationId: string): ConversationInputRuntimeState | undefined =>
      runtimeInputStateRef.current[conversationId],
    [],
  );
  const inputDraftKeyFor = useCallback(
    (conversationId: string | undefined): string =>
      conversationId ?? PENDING_SESSION_KEY,
    [],
  );
  const saveInputDraft = useCallback(
    (conversationId: string | undefined, content: string): void => {
      inputDraftsRef.current[inputDraftKeyFor(conversationId)] = content;
    },
    [inputDraftKeyFor],
  );
  const getInputDraft = useCallback(
    (conversationId: string | undefined): string | undefined =>
      inputDraftsRef.current[inputDraftKeyFor(conversationId)],
    [inputDraftKeyFor],
  );
  const clearInputDraft = useCallback(
    (conversationId: string | undefined): void => {
      delete inputDraftsRef.current[inputDraftKeyFor(conversationId)];
    },
    [inputDraftKeyFor],
  );
  const handleSendMessageRef = useRef<
    (message: string, options: ChatInputSendOptions) => void
  >(() => {});
  const performCompactionRef = useRef<
    (
      conversationId: string,
      model?: string,
      isAuto?: boolean,
      subAgentConfigProfile?: string,
      apiProfile?: string,
      subAgentToolsJson?: string,
      subAgentSystemPrompt?: string,
      thinkingStrength?: string,
      responsesFastMode?: string | null,
    ) => Promise<CompactionResult | null>
  >(async () => null);
  const yoloModeRef = useRef(yoloMode);
  const goalModeRef = useRef(goalMode);
  const worktreeModeRef = useRef(worktreeMode);
  const workflowModeRef = useRef(workflowMode);
  // Neutral Goal/WorkTree/WorkFlow Mode defaults for cold (never-toggled)
  // conversations. These modes are strictly per-conversation: toggles write
  // only the active session's ref and its per-conversation DB record, never
  // this value — so cold conversations always start disabled and never
  // inherit another conversation's (or another project's) mode.
  const globalModeDefaultsRef = useRef<GlobalModeDefaults>({
    goalMode: false,
    worktreeMode: false,
    workflowMode: false,
    goalModeTokenBudget: 2000000,
  });

  // --- 项目切换：清理跨项目残留的会话状态 ---
  // ChatConversationProvider 跨项目常驻挂载（只有 directoryId prop 变化），
  // 而 PENDING_SESSION_KEY 是全局共享的"新对话"槽位：A 项目新对话里开过
  // Goal 模式的 pending 会话若不清除，切到 B 项目后仍会以 Goal 模式运行。
  // 此处丢弃旧项目的 pending 会话（未在后台流式运行时）并把显示的
  // Goal 等模式重置为中性默认值，保证新项目的新对话从干净状态开始。真实
  // 会话（有独立 conversationId）的模式由各自的 session ref 恢复，不受影响。
  const lastDirectoryIdRef = useRef(directoryId);
  useEffect(() => {
    if (lastDirectoryIdRef.current === directoryId) return;
    lastDirectoryIdRef.current = directoryId;

    // 清理旧项目遗留的全部 pending 槽位会话（未在后台流式运行时的）。
    for (const key of Array.from(sessionsRefData.current.keys())) {
      if (!isPendingSessionKey(key)) continue;
      const pendingRef = sessionsRefData.current.get(key);
      if (pendingRef && pendingRef.isSending !== true) {
        sessionsRefData.current.delete(key);
        pendingToRealConversationIdRef.current.delete(key);
        setSessions((prev) => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
      }
    }

    // 仅当显示的槽位是 pending 新对话（无任何残留槽位）时才重置显示模式；
    // 若当前显示的是某个真实会话（属于旧项目，用户切换项目后仍停留在该
    // 会话视图），保留其会话级模式，待用户选择新项目的会话时再按新会话恢复。
    if (
      activeConversationIdRef.current === undefined &&
      !Array.from(sessionsRefData.current.keys()).some(isPendingSessionKey)
    ) {
      goalModeRef.current = false;
      setGoalModeState(false);
      worktreeModeRef.current = false;
      setWorktreeModeState(false);
      pendingWorktreeIdRef.current = null;
      setPendingWorktreeIdState(null);
      workflowModeRef.current = false;
      setWorkflowModeState(false);
      setGoalModeTokenBudgetState(2000000);
    }
  }, [
    directoryId,
    sessionsRefData,
    pendingToRealConversationIdRef,
    setSessions,
    activeConversationIdRef,
    goalModeRef,
    setGoalModeState,
    worktreeModeRef,
    setWorktreeModeState,
    setGoalModeTokenBudgetState,
  ]);

  // --- 会话消息缓存 TTL ---
  // sessions state 没有其他自动回收机制：过期条目由「按到期时刻调度」的清扫
  // 释放——无缓存或无到期条目时零定时器、不扫描；正在查看（active / 活动槽位）
  // 或运行中的会话永不回收，其解除跳过时经 sessions 变化触发重排。
  const conversationCacheTtlMsRef = useRef(
    CONVERSATION_CACHE_TTL_DEFAULT_MINUTES * 60_000,
  );
  const sweepScheduleRef = useRef<() => void>(() => {});
  useEffect(() => {
    const loadConversationCacheTtl = (): void => {
      window.snow
        .getSystemSettingValue(CONVERSATION_CACHE_TTL_SETTING)
        .then((value) => {
          conversationCacheTtlMsRef.current =
            normalizeConversationCacheTtlMinutes(value) * 60_000;
          sweepScheduleRef.current();
        })
        .catch(() => undefined);
    };
    loadConversationCacheTtl();
    window.addEventListener(
      CONVERSATION_CACHE_TTL_CHANGED_EVENT,
      loadConversationCacheTtl,
    );
    return () => {
      window.removeEventListener(
        CONVERSATION_CACHE_TTL_CHANGED_EVENT,
        loadConversationCacheTtl,
      );
    };
  }, []);

  useEffect(() => {
    let scanTimer: number | null = null;
    let debounceTimer: number | null = null;
    let disposed = false;

    const clearScanTimer = (): void => {
      if (scanTimer !== null) {
        window.clearTimeout(scanTimer);
        scanTimer = null;
      }
    };

    const scheduleScanAt = (dueAt: number): void => {
      clearScanTimer();
      if (disposed) {
        return;
      }
      scanTimer = window.setTimeout(
        () => {
          scanTimer = null;
          runSweep();
        },
        Math.max(dueAt - Date.now(), 1000),
      );
    };

    const runSweep = (): void => {
      if (disposed) {
        return;
      }
      const ttlMs = conversationCacheTtlMsRef.current;
      if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
        return;
      }
      const now = Date.now();
      const activeKey = activeConversationIdRef.current;
      const activeSlotKey = activeSessionKeyRef.current;
      const expiredKeys: string[] = [];
      let nextDueAt = Number.POSITIVE_INFINITY;
      for (const [key, session] of Object.entries(sessionsRef.current)) {
        // 主视图激活的会话与「被会话面板钉住」的会话永不回收：它们的内存态
        // 正在被某个聊天表面使用。
        if (
          key === activeKey ||
          key === activeSlotKey ||
          pinnedSessionKeysRef.current.has(key)
        ) {
          continue;
        }
        if (
          session.isStreaming ||
          streamingConversationIdsRef.current.has(key)
        ) {
          continue;
        }
        const sessionRefData = sessionsRefData.current.get(key);
        if (
          sessionRefData?.isSending ||
          sessionRefData?.streamPromise ||
          sessionRefData?.summaryPromise ||
          pauseControllerRef.current.get(key)?.paused
        ) {
          continue;
        }
        const subAgentStatus = subAgentSessionEventsRef.current[key]?.status;
        const sessionTtlMs =
          subAgentStatus && subAgentStatus !== "running"
            ? Math.min(ttlMs, ENDED_SUB_AGENT_SESSION_TTL_MS)
            : ttlMs;
        const dueAt = session.lastAccessedAt + sessionTtlMs;
        if (dueAt <= now) {
          expiredKeys.push(key);
        } else if (dueAt < nextDueAt) {
          nextDueAt = dueAt;
        }
      }
      if (expiredKeys.length > 0) {
        // 文件变更统计（含 diff 补丁）随会话一并释放，重新打开时从数据库重建。
        for (const key of expiredKeys) {
          fileChangeStatsHydratedRef.current.delete(key);
          releaseFileChangeHydration(key);
        }
        setFileChangeStats((prev) => omitKeys(prev, expiredKeys));
        setFileChangeCoverage((prev) => omitKeys(prev, expiredKeys));
        setSessions((prev) => {
          let changed = false;
          const next = { ...prev };
          for (const key of expiredKeys) {
            const expired = next[key];
            if (expired) {
              // 父会话子代理卡片的进度列表来自子会话消息：回收前先归档摘要。
              archiveSubAgentRunActivity(expired.messages);
              delete next[key];
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      }
      if (Number.isFinite(nextDueAt)) {
        scheduleScanAt(nextDueAt);
      } else {
        clearScanTimer();
      }
    };

    const scheduleSweep = (): void => {
      if (disposed) {
        return;
      }
      if (debounceTimer !== null) {
        window.clearTimeout(debounceTimer);
      }
      debounceTimer = window.setTimeout(() => {
        debounceTimer = null;
        runSweep();
      }, 2000);
    };
    sweepScheduleRef.current = scheduleSweep;
    scheduleSweep();
    return () => {
      disposed = true;
      if (debounceTimer !== null) {
        window.clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      clearScanTimer();
      sweepScheduleRef.current = () => {};
    };
  }, []);

  useEffect(() => {
    sweepScheduleRef.current();
  }, [sessions]);

  const alwaysApprovedToolsRef = useRef(new Set<string>());
  const pendingToolAuthorizationRef = useRef(
    new Map<
      string,
      ConversationContextValue["pendingToolAuthorizationRef"]["current"] extends Map<
        string,
        infer V
      >
        ? V
        : never
    >(),
  );
  const pendingUserQuestionRef = useRef(
    new Map<
      string,
      ConversationContextValue["pendingUserQuestionRef"]["current"] extends Map<
        string,
        infer V
      >
        ? V
        : never
    >(),
  );
  const pendingHookDecisionRef = useRef(
    new Map<
      string,
      ConversationContextValue["pendingHookDecisionRef"]["current"] extends Map<
        string,
        infer V
      >
        ? V
        : never
    >(),
  );
  const userQuestionTargetRef = useRef(
    new Map<
      string,
      ConversationContextValue["userQuestionTargetRef"]["current"] extends Map<
        string,
        infer V
      >
        ? V
        : never
    >(),
  );
  yoloModeRef.current = yoloMode;
  goalModeRef.current = goalMode;
  worktreeModeRef.current = worktreeMode;
  workflowModeRef.current = workflowMode;

  // --- Pause controller ---
  // Per-session pause flags. When paused, the agent loop awaits the
  // `resolve` callback before proceeding to the next iteration.
  const pauseControllerRef = useRef<Map<string, PauseController>>(new Map());

  // --- Active API config accessor ---
  // Fetches the active config fresh from storage on every call so that user
  // edits (e.g. the auto-compress threshold) take effect immediately at the
  // next auto-compaction decision point, without requiring an app restart.
  const getActiveApiConfig = useCallback(
    async (profileName?: string): Promise<ApiConfigRecord | null> => {
      try {
        const configs = await window.snow.listApiConfigs();
        const activeConfig =
          configs.find((c) => c.isActive) ?? configs[0] ?? null;
        if (profileName) {
          // Mirror Rust's get_api_request_context_for_profile: a named profile
          // wins, falling back to the active config when it is unavailable.
          return (
            configs.find((c) => c.profileName === profileName) ?? activeConfig
          );
        }
        return activeConfig;
      } catch {
        // Best effort -- auto-compaction simply won't trigger if config is unavailable.
        return null;
      }
    },
    [],
  );

  // --- Build context object ---
  // ctx 是跨渲染稳定的同一个对象，每次渲染原地刷新字段。agent loop、子代理
  // 恢复器、运行注册表、工作流执行器等长生命周期闭包持有的始终是它：读到的
  // 是最新值，也不会把某次渲染时的 sessions 快照钉在内存里（否则 TTL 清理与
  // 消息窗口裁剪释放的消息仍被旧快照引用，内存无法回收）。
  // API 函数占位只在首次创建时写入，随后由下方各子 hook 每次渲染回填。
  const ctxObjectRef = useRef<ConversationContextValue | null>(null);
  const ctx = (ctxObjectRef.current ??= {
    setActiveId: () => {},
    ensureSession: () => {},
    updateSessionMessages: () => {},
    updateSessionField: () => {},
    migrateSession: () => {},
    addStreamingId: () => {},
    removeStreamingId: () => {},
    saveInputDraft: () => {},
    getInputDraft: () => undefined,
    clearInputDraft: () => {},
    updateRuntimeInputState: () => {},
    notifyAiComplete: (_options) => {},
    notifySensitiveCommandIntercepted: (_options) => {},
    notifyUserInteractionRequired: (_options) => {},
  } as Partial<ConversationContextValue> as ConversationContextValue);
  Object.assign(ctx, {
    directoryId,
    directoryPath,
    sessions,
    activeConversationId,
    conversationVersion,
    conversationListVersion,
    conversationTreeVersion,
    upsertedConversation,
    subAgentSessionEvents,
    subAgentSessionEventsRef,
    fileChangeStats,
    fileChangeCoverage,
    recordFileChangeCoverage,
    mergeFileChangeCoverage,
    recordFileChange,
    mergeFileChangeStats,
    fileChangeStatsHydratedRef,
    streamingConversationIds,
    completedConversationIds,
    pendingUserQuestionConversationIds,
    attentionRequiredConversationIds,
    isLoadingInitialHistory,
    draftToRestore,
    rollbackWorkflowComposer,
    rollbackPreview,
    rollbackNewChatState,
    newChatRequested,
    newChatGeneration,
    sessionViewKey,
    yoloMode,
    isUpdatingYoloMode,
    liteMode,
    isUpdatingLiteMode,
    goalMode,
    isUpdatingGoalMode,
    worktreeMode,
    isUpdatingWorktreeMode,
    workflowMode,
    isUpdatingWorkflowMode,
    goalModeTokenBudget,
    pendingWorktreeId,
    setPendingWorktreeId,
    worktreeModeNotice,
    setWorktreeModeNotice,
    pendingToolAuthorizations,
    pendingToolAuthorizationsBySession,
    setPendingToolAuthorizationsBySession,
    pendingQueueMirrors,
    setPendingQueueMirrors,
    activePendingMessages,
    compactionPreview,
    compactionError,
    isCompacting,
    compactingConversationId,

    sessionsRefData,
    activeConversationIdRef,
    pinnedSessionKeysRef,
    pendingSessionSeqRef,
    activeSessionKeyRef,
    pendingDirectoryIdRef,
    selectionRequestIdRef,
    historyLoadPromisesRef,
    loadingOlderConversationIdsRef,
    conversationCacheTtlMsRef,
    sessionsRef,
    newChatRequestedRef,
    pendingQueueRef,
    pendingToRealConversationIdRef,
    inputDraftsRef,
    runtimeInputStateRef,
    handleSendMessageRef,
    performCompactionRef,
    yoloModeRef,
    goalModeRef,
    worktreeModeRef,
    pendingWorktreeIdRef,
    workflowModeRef,
    globalModeDefaultsRef,
    alwaysApprovedToolsRef,
    pendingToolAuthorizationRef,
    pendingUserQuestionRef,
    pendingHookDecisionRef,
    userQuestionTargetRef,
    getActiveApiConfig,
    pauseControllerRef,

    setSessions,
    setActiveConversationId,
    setConversationVersion,
    setConversationListVersion,
    setConversationTreeVersion,
    setUpsertedConversation,
    setSubAgentSessionEvent,
    setStreamingConversationIds,
    setCompletedConversationIds,
    setPendingUserQuestionConversationIds,
    setIsLoadingInitialHistory,
    setDraftToRestore,
    setRollbackWorkflowComposer,
    setRollbackPreview,
    setRollbackNewChatState,
    setNewChatRequested,
    setNewChatGeneration,
    setSessionViewKey,
    setYoloModeState,
    setIsUpdatingYoloMode,
    setLiteModeState,
    setIsUpdatingLiteMode,
    setGoalModeState,
    setIsUpdatingGoalMode,
    setWorktreeModeState,
    setIsUpdatingWorktreeMode,
    setWorkflowModeState,
    setIsUpdatingWorkflowMode,
    setGoalModeTokenBudgetState,
    setPendingToolAuthorizations,
    setActivePendingMessages,
    setCompactionPreview,
    setCompactionError,
    setIsCompacting,
    setCompactingConversationId,
  } satisfies Partial<ConversationContextValue>);

  // --- 1. Conversation session management ---
  const sessionApi = useConversationSession(ctx);
  ctx.setActiveId = sessionApi.setActiveId;
  ctx.ensureSession = sessionApi.ensureSession;
  ctx.updateSessionMessages = sessionApi.updateSessionMessages;
  ctx.updateSessionField = sessionApi.updateSessionField;
  ctx.migrateSession = sessionApi.migrateSession;
  ctx.addStreamingId = sessionApi.addStreamingId;
  ctx.removeStreamingId = sessionApi.removeStreamingId;
  ctx.saveInputDraft = saveInputDraft;
  ctx.getInputDraft = getInputDraft;
  ctx.clearInputDraft = clearInputDraft;
  ctx.updateRuntimeInputState = updateRuntimeInputState;
  ctx.notifyAiComplete = sessionApi.notifyAiComplete;
  ctx.notifySensitiveCommandIntercepted =
    sessionApi.notifySensitiveCommandIntercepted;
  ctx.notifyUserInteractionRequired = sessionApi.notifyUserInteractionRequired;

  // --- 2. Tool authorization ---
  const toolAuthApi = useToolAuthorization(ctx);

  // --- 3. User question ---
  const userQuestionApi = useUserQuestion(ctx);

  // --- 4. Compaction ---
  const compactionApi = useCompaction(ctx);
  performCompactionRef.current = compactionApi.performCompaction;

  // --- 5. Agent loop (handleSendMessage) ---
  const agentLoopApi = useAgentLoop({
    ctx,
    requestToolAuthorizations: toolAuthApi.requestToolAuthorizations,
    rejectToolAuthorizations: toolAuthApi.rejectToolAuthorizations,
    rejectPendingUserQuestions: userQuestionApi.rejectPendingUserQuestions,
  });

  // Subscribe only after the sender ref is installed; idle notifications must
  // never be claimed while handleSendMessageRef still contains its initial noop.
  useImageGenerationRuntime(ctx);
  useSubAgentParentInbox(
    ctx,
    {
      requestToolAuthorizations: toolAuthApi.requestToolAuthorizations,
    },
    true,
    isDetachedWindow,
  );
  // 插件会话编排的投递通道：向任意主会话投递用户消息（见 conversationMessageBridge）。
  useConversationMessageBridge(ctx);

  // --- 6. Conversation management (select, new, abort, fork, etc.) ---
  const conversationManagementApi = useConversationManagement({
    ctx,
    rejectToolAuthorizations: toolAuthApi.rejectToolAuthorizations,
    rejectPendingUserQuestions: userQuestionApi.rejectPendingUserQuestions,
  });
  // ctx 组装早于 management hooks：WorkFlow 级联中止能力在此回填，
  // 供 useRollback 等后续 hook 使用。
  ctx.abortWorkflowNodes = conversationManagementApi.abortWorkflowNodes;
  // 插件会话编排的中止通道：复用 handleAbort（见 conversationMessageBridge）。
  useConversationAbortBridge(ctx, conversationManagementApi.handleAbort);
  // 插件会话编排的删除 / 归档通道：复用侧栏删除的收尾流程（中止整棵会话树、
  // 清理草稿、移除当前会话时切到新会话）。
  useConversationRemovalBridge(
    ctx,
    conversationManagementApi.abortConversation,
    conversationManagementApi.handleNewChat,
    conversationManagementApi.handleAbort,
  );

  // --- 独立窗口归属 ---
  // 归属于某个独立窗口的会话（窗口内的会话 tab 与运行中的会话）只能在该窗口运行。
  // 主窗口据此拦截对它们的选中（改为聚焦所在窗口），并释放本地缓存，避免主窗口加载到过期数据。
  // 独立窗口自身的运行时不拦截，也不订阅归属变化。
  const detachedOwnedIdsRef = useRef<Set<string>>(new Set());
  // 同窗口右侧面板里「会话面板」接管的会话（见 common/conversationPanelOwnership）。
  const panelOwnedIdsRef = useRef<Set<string>>(new Set());
  const handleNewChatRef = useRef(conversationManagementApi.handleNewChat);
  handleNewChatRef.current = conversationManagementApi.handleNewChat;

  /**
   * 释放会话的本地缓存（下次选中时从数据库重新加载）。运行中的会话不释放；
   * keepActive=false 时当前激活会话也不释放（用于主窗口切走后释放）。
   */
  const dropSessionCaches = useCallback(
    (conversationIds: string[], keepActive: boolean): void => {
      const activeId = activeConversationIdRef.current;
      const releasableIds = conversationIds.filter((id) => {
        if (keepActive && id === activeId) {
          return false;
        }
        // 被会话面板钉住的会话仍在被使用：释放后需要重新加载，直接跳过。
        if (pinnedSessionKeysRef.current.has(id)) {
          return false;
        }
        if (streamingConversationIdsRef.current.has(id)) {
          return false;
        }
        const refData = sessionsRefData.current.get(id);
        return !(
          refData?.isSending ||
          refData?.streamPromise ||
          refData?.summaryPromise ||
          pauseControllerRef.current.get(id)?.paused
        );
      });
      if (releasableIds.length === 0) {
        return;
      }
      for (const id of releasableIds) {
        sessionsRefData.current.delete(id);
      }
      setSessions((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const id of releasableIds) {
          if (next[id]) {
            delete next[id];
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    },
    [],
  );

  const releaseConversationSessions = useCallback(
    (conversationIds: string[]): void => {
      dropSessionCaches(conversationIds, true);
    },
    [dropSessionCaches],
  );

  /**
   * 会话归属变化：被接管的会话（跨窗口的独立面板窗口 / 同窗口的会话面板）只能由
   * 归属方运行。这里统一处理主视图侧的两个后果：
   * - 当前视图刚被接管 → 切到新会话，不再展示该会话（避免同一会话两个聊天视图）；
   * - 释放被接管会话的本地缓存，避免主视图加载到过期数据。
   */
  const applyOwnedConversations = (
    ownedIdsRef: { current: Set<string> },
    conversationIds: string[],
  ): void => {
    const next = new Set(conversationIds);
    const previous = ownedIdsRef.current;
    ownedIdsRef.current = next;
    // Cancel this renderer's in-flight parent wakes before any view/cache work.
    // Persisted input and child execution owners remain untouched.
    for (const id of next) revokeSubAgentParentOwnership(id);
    const changedIds = [
      ...conversationIds.filter((id) => !previous.has(id)),
      ...[...previous].filter((id) => !next.has(id)),
    ];
    if (changedIds.length === 0) {
      return;
    }
    const activeId = activeConversationIdRef.current;
    if (activeId && next.has(activeId)) {
      handleNewChatRef.current();
    }
    dropSessionCaches(changedIds, false);
  };

  useEffect(() => {
    if (isDetachedWindow) {
      return;
    }
    let disposed = false;
    const unsubscribe = window.snow.onDetachedConversationOwnersChanged(
      (conversationIds) => {
        applyOwnedConversations(detachedOwnedIdsRef, conversationIds);
      },
    );
    void window.snow
      .takeDetachedConversationOwners()
      .then((conversationIds) => {
        if (!disposed) {
          applyOwnedConversations(detachedOwnedIdsRef, conversationIds);
        }
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [isDetachedWindow, dropSessionCaches]);

  // 会话面板归属（同一窗口内）：面板接管的会话由面板承载，主内容区让出
  // （激活会话被拖进面板时切到新会话），与独立窗口归属同一套处理。
  useEffect(() => {
    if (isDetachedWindow) {
      return;
    }
    return subscribePanelConversationChange((conversationIds) =>
      applyOwnedConversations(panelOwnedIdsRef, [...conversationIds]),
    );
  }, [isDetachedWindow, dropSessionCaches]);

  const handleSelectConversationGuarded = useCallback<
    UseChatConversationResult["handleSelectConversation"]
  >(
    async (conversationId, title, tokenUsage, directoryId) => {
      const trimmedId = conversationId.trim();
      if (!isDetachedWindow && trimmedId) {
        // 会话面板承载的会话：聚焦承载它的面板 tab，不把主内容区也切过去
        // （否则同一会话会出现两个聊天视图）。
        if (isConversationOwnedByPanel(trimmedId)) {
          focusPanelConversation(trimmedId);
          return;
        }
        if (detachedOwnedIdsRef.current.has(trimmedId)) {
          const focused =
            await window.snow.focusDetachedConversation(trimmedId);
          if (focused) {
            return;
          }
        }
      }
      await conversationManagementApi.handleSelectConversation(
        conversationId,
        title,
        tokenUsage,
        directoryId,
      );
    },
    [isDetachedWindow, conversationManagementApi.handleSelectConversation],
  );

  // 独立窗口内的会话列表 / 树形数据变化（如在独立窗口新建并发送了会话）：
  // 主窗口侧边栏不会自动感知，这里重新拉取。
  const refreshSidebarDataRef = useRef<() => void>(() => undefined);
  refreshSidebarDataRef.current = (): void => {
    conversationManagementApi.refreshConversations();
    conversationManagementApi.refreshConversationTree();
  };
  useEffect(() => {
    if (isDetachedWindow) {
      return;
    }
    return window.snow.onDetachedConversationListChanged(() => {
      refreshSidebarDataRef.current();
    });
  }, [isDetachedWindow]);

  // 插件 / 客户端脚本的会话类写动作（归档、删除、重命名等）：与宿主 UI 操作一致，
  // 立即重拉侧栏列表。独立窗口内的刷新会经 DetachedConversationSync 转告主窗口。
  const refreshConversationsRef = useRef(
    conversationManagementApi.refreshConversations,
  );
  refreshConversationsRef.current =
    conversationManagementApi.refreshConversations;
  useEffect(() => {
    const handleChanged = (event: Event): void => {
      const detail = (event as CustomEvent<PluginConversationListChangedDetail>)
        .detail;
      if (detail) {
        detail.handled = true;
      }
      refreshConversationsRef.current();
    };
    window.addEventListener(
      PLUGIN_CONVERSATION_LIST_CHANGED_EVENT,
      handleChanged,
    );
    return () => {
      window.removeEventListener(
        PLUGIN_CONVERSATION_LIST_CHANGED_EVENT,
        handleChanged,
      );
    };
  }, []);

  // --- 7. Rollback ---
  const rollbackApi = useRollback(ctx);

  // --- Compute active session ---
  // When the user explicitly requested a new chat (clicked "New chat" while
  // a session was still streaming), do NOT fall back to the pending session.
  // This keeps the empty greeting visible while the background AI loop
  // continues running and eventually migrates to a real conversation id.
  // 新会话视图使用当前序号的 pending 槽位 key（每次显式新建会话都会
  // 递增序号），与仍在后台流式的旧 pending 槽位互不干扰。
  const activeKey =
    newChatRequested || activeConversationId
      ? activeConversationId
      : getPendingSessionKey(pendingSessionSeqRef.current);
  const activeSession = activeKey ? sessions[activeKey] : undefined;

  // --- Approve/reject tool authorization wrappers ---
  // 依赖必须取到具体的稳定回调：依赖整个 toolAuthApi 对象（每次渲染新建）
  // 会让这两个包装每次渲染都换身份，击穿 MessageContent / AiResponse 的 memo，
  // 使每个流式 chunk 都重渲染当前会话的全部可见消息子树。
  const approveToolAuthorization = useCallback(
    (toolCall: ConversationContextValue["pendingToolAuthorizations"][number]) =>
      toolAuthApi.settleToolAuthorization(toolCall, {
        status: "approved",
        sensitiveCommandConfirmed:
          (toolCall.sensitiveCommandMatches?.length ?? 0) > 0,
      }),
    [toolAuthApi.settleToolAuthorization],
  );

  const rejectToolAuthorization = useCallback(
    (
      toolCall: ConversationContextValue["pendingToolAuthorizations"][number],
      reason: string,
      userProvidedReason?: boolean,
    ) => {
      // 敏感命令的拒绝（用户点「拒绝」，或决策模型托管判定）只否决这一条
      // 命令：理由随工具结果回传 AI，AI 流程继续，任何时候都不因敏感命令被
      // 拒绝而中断。普通工具授权仍只在用户填了拒绝理由时才续跑。
      const isSensitiveCommand =
        (toolCall.sensitiveCommandMatches?.length ?? 0) > 0;

      return toolAuthApi.settleToolAuthorization(toolCall, {
        status: "rejected",
        reason: reason.trim() || "User declined tool execution",
        ...(userProvidedReason || isSensitiveCommand
          ? { reasonForModel: true }
          : {}),
      });
    },
    [toolAuthApi.settleToolAuthorization],
  );

  // --- Pause / Resume ---
  // handlePause marks the active session as paused. The agent loop checks
  // the pause controller at the start of each iteration and blocks on a
  // promise until handleResume is called or the loop is cancelled.
  const handlePause = useCallback(
    (sessionKey?: string): void => {
      const key =
        sessionKey ?? ctx.activeSessionKeyRef.current ?? PENDING_SESSION_KEY;
      const ref = ctx.sessionsRefData.current.get(key);
      if (!ref?.isSending) {
        return;
      }
      let controller = ctx.pauseControllerRef.current.get(key);
      if (!controller) {
        controller = { paused: false, resolve: null };
        ctx.pauseControllerRef.current.set(key, controller);
      }
      if (controller.paused) {
        return;
      }
      controller.paused = true;
      ctx.updateSessionField(key, "isPaused", true);
      // 依赖只取 ctx 上的稳定引用（ref 对象 / useCallback 回调），避免 ctx
      // 每次渲染重建导致 onPause 引用变化，击穿 StreamMetrics 的 memo 保护。
    },
    [
      ctx.activeConversationIdRef,
      ctx.sessionsRefData,
      ctx.pauseControllerRef,
      ctx.updateSessionField,
    ],
  );

  const handleResume = useCallback(
    (sessionKey?: string): void => {
      const key =
        sessionKey ?? ctx.activeSessionKeyRef.current ?? PENDING_SESSION_KEY;
      const controller = ctx.pauseControllerRef.current.get(key);
      // 控制器缺失时（循环未在检查点阻塞）也要清除展示态，避免按钮卡在暂停
      ctx.updateSessionField(key, "isPaused", false);
      if (!controller) {
        return;
      }
      controller.paused = false;
      const resolve = controller.resolve;
      controller.resolve = null;
      if (resolve) {
        resolve();
      }
    },
    [
      ctx.activeConversationIdRef,
      ctx.pauseControllerRef,
      ctx.updateSessionField,
    ],
  );

  /** 钉住 / 解除钉住会话缓存：会话面板打开期间据此跳过 TTL 回收。 */
  const pinSessionScope = useCallback(
    (conversationId: string, pinned: boolean): void => {
      const key = conversationId.trim();
      if (!key) {
        return;
      }
      const pinnedKeys = pinnedSessionKeysRef.current;
      if (pinned) {
        if (pinnedKeys.has(key)) {
          return;
        }
        pinnedKeys.add(key);
        return;
      }
      pinnedKeys.delete(key);
      // 解除钉住后立刻触发一次回收调度：面板关闭的会话按 TTL 正常过期。
      sweepScheduleRef.current();
    },
    [],
  );

  /** 读取指定会话的运行时快照（ref 镜像，供会话面板展示与展示态兜底）。 */
  const readSessionRuntime = useCallback(
    (conversationId: string): SessionRuntimeSnapshot => {
      const ref = ctx.sessionsRefData.current.get(conversationId);
      return {
        worktreeMode: ref?.worktreeMode ?? false,
        worktreeId: ref?.worktreeId ?? null,
        goalMode: ref?.goalMode ?? false,
        workflowMode: ref?.workflowMode ?? false,
        goalModeTokenBudget:
          ref?.goalModeTokenBudget ??
          ctx.globalModeDefaultsRef.current.goalModeTokenBudget,
        checkpointIds: ref?.checkpointIds ?? EMPTY_CHECKPOINT_IDS,
        isSending: ref?.isSending ?? false,
      };
    },
    [ctx.sessionsRefData, ctx.globalModeDefaultsRef],
  );

  // 重命名会话后同步更新内存 session 的 summary，使 TopBar 标题即时刷新。
  // 会话尚未加载过（session 不存在）时 updateSessionField 安全地不执行任何操作。
  const updateConversationSummary = useCallback(
    (conversationId: string, summary: string): void => {
      ctx.updateSessionField(conversationId, "summary", summary);
    },
    [ctx.updateSessionField],
  );

  // --- Auto-send queue (buildFromContent) ---
  // 激活下一条请求时才新建会话视图：上一条已在 handleSendMessage 中同步标记
  // isSending，handleNewChat 会保留其槽位并分配新槽位，互不串台。
  // handleNewChatRef 始终指向最新的 handleNewChat（上方独立窗口归属处维护）。
  const activateNextAutoSend = useCallback((): void => {
    const next = autoSendQueueRef.current.shift() ?? null;
    activeAutoSendRef.current = next;
    autoSendClaimedRef.current = false;
    if (next) {
      handleNewChatRef.current();
    }
    setActiveAutoSend(next);
  }, []);

  const buildFromContent = useCallback(
    (content: string): void => {
      autoSendSeqRef.current += 1;
      autoSendQueueRef.current.push({ id: autoSendSeqRef.current, content });
      if (!activeAutoSendRef.current) {
        activateNextAutoSend();
      }
    },
    [activateNextAutoSend],
  );

  // --- Background conversations (scheduled tasks) ---
  // 每次分配独立的后台 pending 槽位，直接走 handleSendMessage 的程序化发送：
  // 不新建会话视图、不借用输入区，也不读写任何视图级一次性状态，多条任务
  // 同时触发时各自落在各自的槽位与项目里。渠道/模型按新会话视图的默认规则
  // 解析（任务指定的渠道优先，否则取当前激活渠道及其高级模型）。
  const startBackgroundConversation = useCallback(
    async (
      content: string,
      directoryId?: string,
      options?: ScheduledTaskRunOptions,
      taskName?: string,
    ): Promise<void> => {
      const message = content.trim();
      if (!message) {
        return;
      }
      const configs = await window.snow.listApiConfigs();
      const activeConfig =
        configs.find((config) => config.isActive) ?? configs[0];
      backgroundSessionSeqRef.current += 1;
      handleSendMessageRef.current(message, {
        ...resolveAutoSendOptions({
          autoSendOverride: options ?? null,
          apiConfigs: configs,
          selectedModel: activeConfig?.advancedModel,
          selectedApiProfile: activeConfig?.profileName,
        }),
        targetSessionKey: getBackgroundPendingSessionKey(
          backgroundSessionSeqRef.current,
        ),
        targetDirectoryId: directoryId?.trim() || undefined,
        triggeredByTaskName: taskName,
      });
    },
    [],
  );

  // 后台 run 并等待结束（定时任务工作流节点）：conversationId 给定时续写该会话，
  // 否则新建后台会话。总会 resolve（失败以 success=false 返回）。
  const runBackgroundConversation = useCallback(
    async (
      content: string,
      directoryId?: string,
      options?: ScheduledTaskRunOptions,
      taskName?: string,
      conversationId?: string,
    ): Promise<BackgroundRunResult> => {
      const message = content.trim();
      if (!message) {
        return {
          conversationId: conversationId ?? "",
          output: "",
          success: false,
          error: "Prompt is empty",
        };
      }
      const configs = await window.snow.listApiConfigs();
      const activeConfig =
        configs.find((config) => config.isActive) ?? configs[0];
      let targetSessionKey = conversationId?.trim() ?? "";
      if (!targetSessionKey) {
        backgroundSessionSeqRef.current += 1;
        targetSessionKey = getBackgroundPendingSessionKey(
          backgroundSessionSeqRef.current,
        );
      }
      return new Promise<BackgroundRunResult>((resolve) => {
        handleSendMessageRef.current(message, {
          ...resolveAutoSendOptions({
            autoSendOverride: options ?? null,
            apiConfigs: configs,
            selectedModel: activeConfig?.advancedModel,
            selectedApiProfile: activeConfig?.profileName,
          }),
          targetSessionKey,
          targetDirectoryId: directoryId?.trim() || undefined,
          triggeredByTaskName: conversationId ? undefined : taskName,
          onRunSettled: resolve,
        });
      });
    },
    [],
  );

  // 同一请求只允许一个输入区实例认领一次（输入区重建、多实例挂载时防重复发送）。
  const claimAutoSend = useCallback((id: number): boolean => {
    if (activeAutoSendRef.current?.id !== id || autoSendClaimedRef.current) {
      return false;
    }
    autoSendClaimedRef.current = true;
    return true;
  }, []);

  const completeAutoSend = useCallback(
    (id: number): void => {
      if (activeAutoSendRef.current?.id !== id) {
        return;
      }
      activateNextAutoSend();
    },
    [activateNextAutoSend],
  );

  // --- 对外 context 值 ---
  // 运行时 ref 快照：这些值在渲染期读出（与原先"每次渲染直接读 ref"一致），
  // 并作为下方 memo 的依赖——ref 内容变化本身不触发渲染，但一旦有渲染发生
  // 就会读到新值并让值引用随之更换，因此与旧实现等价。
  const activeRuntimeRef = activeKey
    ? sessionsRefData.current.get(activeKey)
    : undefined;
  const conversationWorktreeModeForActive = activeRuntimeRef?.worktreeMode;
  const conversationWorktreeIdForActive = activeRuntimeRef?.worktreeId;
  const checkpointIdsForActive =
    activeRuntimeRef?.checkpointIds ?? EMPTY_CHECKPOINT_IDS;
  const isSendingForActive = activeRuntimeRef?.isSending === true;
  // 待发送队列快照：派生数组按内容稳定化，避免每帧新建引用击穿 memo。
  const activePendingQueue =
    pendingQueueRef.current.get(activeKey ?? PENDING_SESSION_KEY) ??
    EMPTY_PENDING_QUEUE;
  const pendingMessageModesForActive = useStableArray(
    activePendingQueue.map((item) => item.options.deliveryMode ?? "queue"),
  );
  const prefillComposer = useCallback(
    (
      content: string,
      options?: { newChat?: boolean; directoryId?: string },
    ) => {
      if (options?.newChat) {
        conversationManagementApi.handleNewChat(options.directoryId);
      }
      setDraftToRestore(content);
    },
    [conversationManagementApi.handleNewChat],
  );

  // 侧边栏消费的会话内存态投影。签名是"内容指纹"：只覆盖侧边栏实际读取的
  // 字段（暂停/运行态、所属项目，以及 pending 会话用于重建占位记录的首条
  // 用户消息、消息数与模型）。会话消息正文在每个流式帧都会更换引用，但侧边栏
  // 不读它们，因此签名不变时投影沿用上一份快照，侧边栏列表不会逐帧重渲染。
  const sessionsListSignature = useMemo(() => {
    const parts: string[] = [];
    for (const [key, session] of Object.entries(sessions)) {
      parts.push(
        `${key}\u0001${session.isPaused ? 1 : 0}\u0001${
          session.isStreaming ? 1 : 0
        }\u0001${session.directoryId ?? ""}`,
      );
      if (!isPendingSessionKey(key)) {
        continue;
      }
      const firstUserMessage = session.messages.find(
        (message) => message.role === "user",
      );
      const firstAssistantMessage = session.messages.find(
        (message) => message.role === "assistant",
      );
      parts.push(
        `${session.summary}\u0001${session.messages.length}\u0001${
          firstUserMessage?.content ?? ""
        }\u0001${firstAssistantMessage?.model ?? ""}`,
      );
    }
    return parts.join("\u0002");
  }, [sessions]);
  // 依赖只取签名：签名不变即"侧边栏可见字段没变"，复用上一份快照即可（侧边栏
  // 读到的这些字段在快照里始终是最新的），这正是"不逐帧重渲染"的关键。
  // 快照会跨越整个 run 存活：非 pending 会话剥掉消息体，避免旧消息被它钉住无法回收。
  const sessionsForList = useMemo(() => {
    const projected: ChatConversationSessions = {};
    for (const [key, session] of Object.entries(sessions)) {
      projected[key] = isPendingSessionKey(key)
        ? session
        : { ...session, messages: EMPTY_MESSAGES, messageRecords: [] };
    }
    return projected;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionsListSignature]);

  // 主 context 值：只在"真正影响它的状态"变化时更换引用。会话内存态表
  // （sessions）不在其中——它在每个流式帧都会更换引用，若放进这里，所有
  // 消费者（聊天区整棵树、侧边栏、远控桥等）都会跟着每帧重渲染；它改由
  // 单独的 sessions context 提供（见返回值）。
  const conversation = useMemo<UseChatConversationResult>(
    () => ({
      messages: activeSession?.messages ?? EMPTY_MESSAGES,
      summary: activeSession?.summary ?? "",
      conversationVersion,
      conversationListVersion,
      conversationTreeVersion,
      upsertedConversation,
      // pending 槽位 -> 真实 conversationId 映射（侧边栏占位替换用）。
      pendingToRealConversationIdRef,
      // 当前视图会话 key（真实 id 或新会话槽位 key）：远控通道用它定位
      // “所见 pending 队列”的真实归属（含槽位→真实会话迁移的解析）。
      activeSessionKeyRef,
      // 待发送队列存储（会话 key -> 队列）：远控通道在操作失败时据此输出
      // 现场摘要（诊断用）。
      pendingQueueRef,
      subAgentSessionEvents,
      fileChangeStats,
      fileChangeCoverage,
      recordFileChangeCoverage,
      mergeFileChangeCoverage,
      recordFileChange,
      sessionsForList,
      activeConversationId,
      sessionViewKey,
      newChatGeneration,
      newChatRequested,
      conversationDirectoryId: activeSession?.directoryId,
      // The execution snapshot belongs to activeKey, unlike the toolbar's live mode state.
      conversationWorktreeMode: conversationWorktreeModeForActive,
      conversationWorktreeId: conversationWorktreeIdForActive,
      tokenUsage: activeSession?.tokenUsage ?? null,
      runTokenUsage: activeSession?.runTokenUsage ?? null,
      conversationTokenUsage: activeSession?.conversationTokenUsage ?? null,
      lastRunDurationMs: activeSession?.lastRunDurationMs ?? 0,
      conversationTtftSumMs: activeSession?.conversationTtftSumMs ?? 0,
      conversationRequestCount: activeSession?.conversationRequestCount ?? 0,
      streamTokenCount: activeSession?.streamTokenCount ?? 0,
      streamElapsedMs: activeSession?.streamElapsedMs ?? 0,
      streamTtftMs: activeSession?.streamTtftMs ?? 0,
      runTtftMs: activeSession?.runTtftMs ?? 0,
      baselineCheckpointId: activeSession?.baselineCheckpointId,
      checkpointIds: checkpointIdsForActive,
      streamStartedAt: activeSession?.streamStartedAt ?? 0,
      visionAnalysis: activeSession?.visionAnalysis,
      triggeredByTask: activeSession?.triggeredByTask,
      forkedFromConversationId: activeSession?.forkedFromConversationId,
      forkMessageCount: activeSession?.forkMessageCount,
      streamingConversationIds,
      completedConversationIds,
      attentionRequiredConversationIds,
      isLoadingOlderMessages: activeSession?.isLoadingOlderMessages ?? false,
      hasMoreMessages: activeSession?.hasMoreMessages ?? false,
      isInitialHistoryLoaded: activeSession?.isInitialHistoryLoaded ?? false,
      isLoadingInitialHistory,
      loadOlderMessages: conversationManagementApi.loadOlderMessages,
      handleSendMessage: agentLoopApi.handleSendMessage,
      pendingMessages: activePendingMessages,
      pendingMessageModes: pendingMessageModesForActive,
      withdrawPendingMessage: conversationManagementApi.withdrawPendingMessage,
      sendPendingMessageNow: conversationManagementApi.sendPendingMessageNow,
      compactConversation: compactionApi.compactConversation,
      compactionPreview,
      compactionError,
      dismissCompactionError,
      isCompacting,
      compactingConversationId,
      handleSelectConversation: handleSelectConversationGuarded,
      handleNewChat: conversationManagementApi.handleNewChat,
      refreshConversations: conversationManagementApi.refreshConversations,
      refreshConversationTree:
        conversationManagementApi.refreshConversationTree,
      releaseConversationSessions,
      updateConversationSummary,
      updateSessionMessages: sessionApi.updateSessionMessages,
      isStreaming: Boolean(
        activeSession?.isStreaming ||
        (activeKey && streamingConversationIds.has(activeKey)) ||
        (activeKey && isSendingForActive),
      ),
      isAborting: activeSession?.isAborting ?? false,
      isPaused: activeSession?.isPaused ?? false,
      handleAbort: conversationManagementApi.handleAbort,
      handlePause,
      handleResume,
      abortConversation: conversationManagementApi.abortConversation,
      abortWorkflowNodes: conversationManagementApi.abortWorkflowNodes,
      handleForkConversation: conversationManagementApi.handleForkConversation,
      draftToRestore,
      clearDraftToRestore: rollbackApi.clearDraftToRestore,
      rollbackWorkflowComposer,
      clearRollbackWorkflowComposer: rollbackApi.clearRollbackWorkflowComposer,
      saveInputDraft,
      getInputDraft,
      clearInputDraft,
      updateRuntimeInputState,
      getRuntimeInputState,
      buildFromContent,
      startBackgroundConversation,
      runBackgroundConversation,
      autoSendRequest: activeAutoSend,
      claimAutoSend,
      completeAutoSend,
      // 回填输入框但不发送（不走自动发送队列）；newChat 时先新建会话。
      prefillComposer,
      handleRollback: rollbackApi.handleRollback,
      rollbackPreparingMessageId: rollbackApi.preparingMessageId,
      rollbackPreview,
      rollbackNewChatState,
      confirmRollback: rollbackApi.confirmRollback,
      cancelRollback: rollbackApi.cancelRollback,
      yoloMode,
      isUpdatingYoloMode,
      setYoloMode: toolAuthApi.setYoloMode,
      refreshYoloMode: toolAuthApi.refreshYoloMode,
      liteMode,
      isUpdatingLiteMode,
      setLiteMode: toolAuthApi.setLiteMode,
      refreshLiteMode: toolAuthApi.refreshLiteMode,
      goalMode,
      isUpdatingGoalMode,
      setGoalMode: toolAuthApi.setGoalMode,
      refreshGoalMode: toolAuthApi.refreshGoalMode,
      worktreeMode,
      isUpdatingWorktreeMode,
      pendingWorktreeId,
      setPendingWorktreeId,
      worktreeModeNotice,
      setWorktreeModeNotice,
      setWorktreeMode: toolAuthApi.setWorktreeMode,
      refreshWorktreeMode: toolAuthApi.refreshWorktreeMode,
      workflowMode,
      isUpdatingWorkflowMode,
      setWorkflowMode: toolAuthApi.setWorkflowMode,
      refreshWorkflowMode: toolAuthApi.refreshWorkflowMode,
      goalModeTokenBudget,
      setGoalModeTokenBudget: toolAuthApi.setGoalModeTokenBudget,
      refreshGoalModeTokenBudget: toolAuthApi.refreshGoalModeTokenBudget,
      pendingToolAuthorizations,
      approveToolAuthorization,
      approveToolAuthorizationAlways:
        toolAuthApi.approveToolAuthorizationAlways,
      rejectToolAuthorization,
      answerUserQuestion: userQuestionApi.answerUserQuestion,
      cancelUserQuestion: userQuestionApi.cancelUserQuestion,
      revertUserQuestion: userQuestionApi.revertUserQuestion,
      getUserQuestionDraft: userQuestionApi.getUserQuestionDraft,
      saveUserQuestionDraft: userQuestionApi.saveUserQuestionDraft,
      clearUserQuestionDraft: userQuestionApi.clearUserQuestionDraft,
      // ===== 会话面板（主视图之外的第二个聊天表面）=====
      loadConversationScope: conversationManagementApi.loadConversationScope,
      pinSessionScope,
      pendingToolAuthorizationsBySession,
      pendingQueueMirrors,
      readSessionRuntime,
      isDetachedWindow,
    }),
    [
      activeSession,
      activeKey,
      conversationVersion,
      conversationListVersion,
      conversationTreeVersion,
      upsertedConversation,
      pendingToRealConversationIdRef,
      activeSessionKeyRef,
      pendingQueueRef,
      subAgentSessionEvents,
      fileChangeStats,
      fileChangeCoverage,
      recordFileChangeCoverage,
      mergeFileChangeCoverage,
      recordFileChange,
      sessionsForList,
      activeConversationId,
      sessionViewKey,
      newChatGeneration,
      newChatRequested,
      conversationWorktreeModeForActive,
      conversationWorktreeIdForActive,
      checkpointIdsForActive,
      isSendingForActive,
      streamingConversationIds,
      completedConversationIds,
      attentionRequiredConversationIds,
      isLoadingInitialHistory,
      activePendingMessages,
      pendingMessageModesForActive,
      compactionPreview,
      compactionError,
      dismissCompactionError,
      isCompacting,
      compactingConversationId,
      draftToRestore,
      rollbackWorkflowComposer,
      activeAutoSend,
      rollbackApi.preparingMessageId,
      rollbackPreview,
      rollbackNewChatState,
      yoloMode,
      isUpdatingYoloMode,
      liteMode,
      isUpdatingLiteMode,
      goalMode,
      isUpdatingGoalMode,
      worktreeMode,
      isUpdatingWorktreeMode,
      workflowMode,
      isUpdatingWorkflowMode,
      goalModeTokenBudget,
      pendingWorktreeId,
      worktreeModeNotice,
      pendingToolAuthorizations,
      pendingToolAuthorizationsBySession,
      pendingQueueMirrors,
      readSessionRuntime,
      pinSessionScope,
      isDetachedWindow,
      prefillComposer,
      conversationManagementApi.loadOlderMessages,
      conversationManagementApi.loadConversationScope,
      agentLoopApi.handleSendMessage,
      conversationManagementApi.withdrawPendingMessage,
      conversationManagementApi.sendPendingMessageNow,
      compactionApi.compactConversation,
      handleSelectConversationGuarded,
      conversationManagementApi.handleNewChat,
      conversationManagementApi.refreshConversations,
      conversationManagementApi.refreshConversationTree,
      releaseConversationSessions,
      updateConversationSummary,
      sessionApi.updateSessionMessages,
      conversationManagementApi.handleAbort,
      handlePause,
      handleResume,
      conversationManagementApi.abortConversation,
      conversationManagementApi.abortWorkflowNodes,
      conversationManagementApi.handleForkConversation,
      rollbackApi.clearDraftToRestore,
      saveInputDraft,
      getInputDraft,
      clearInputDraft,
      updateRuntimeInputState,
      getRuntimeInputState,
      buildFromContent,
      startBackgroundConversation,
      runBackgroundConversation,
      claimAutoSend,
      completeAutoSend,
      rollbackApi.handleRollback,
      rollbackApi.confirmRollback,
      rollbackApi.cancelRollback,
      toolAuthApi.setYoloMode,
      toolAuthApi.refreshYoloMode,
      toolAuthApi.setLiteMode,
      toolAuthApi.refreshLiteMode,
      toolAuthApi.setGoalMode,
      toolAuthApi.refreshGoalMode,
      setPendingWorktreeId,
      setWorktreeModeNotice,
      toolAuthApi.setWorktreeMode,
      toolAuthApi.refreshWorktreeMode,
      toolAuthApi.setWorkflowMode,
      toolAuthApi.refreshWorkflowMode,
      toolAuthApi.setGoalModeTokenBudget,
      toolAuthApi.refreshGoalModeTokenBudget,
      approveToolAuthorization,
      toolAuthApi.approveToolAuthorizationAlways,
      rejectToolAuthorization,
      userQuestionApi.answerUserQuestion,
      userQuestionApi.cancelUserQuestion,
      userQuestionApi.revertUserQuestion,
      userQuestionApi.getUserQuestionDraft,
      userQuestionApi.saveUserQuestionDraft,
      userQuestionApi.clearUserQuestionDraft,
    ],
  );

  return { conversation, sessions };
};
