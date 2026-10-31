import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  ChatConversationValueProvider,
  useChatConversationContext,
  useChatConversationSessions,
} from "./ChatConversationContext";
import { registerPanelConversation } from "../../../common/conversationPanelOwnership";
import type {
  ChatConversationMessage,
  FileChangeRecord,
  ToolCallInfo,
  UseChatConversationResult,
} from "../utils/conversationTypes";

/** 空常量：避免面板每次渲染新建空引用，击穿下游 memo。 */
const EMPTY_MESSAGES: ChatConversationMessage[] = [];
const EMPTY_TOOL_CALLS: ToolCallInfo[] = [];
const EMPTY_FILE_CHANGES: FileChangeRecord[] = [];
const EMPTY_STRINGS: string[] = [];
/** 冷会话（从未配置过）的中性 Goal 预算默认值，与运行时保持一致。 */
const DEFAULT_GOAL_TOKEN_BUDGET = 2000000;

/**
 * 面板输入草稿的键前缀：面板与主视图可能同时打开同一个会话，草稿按表面各存
 * 各的，避免关闭面板时把主视图正在编辑的草稿写空。
 */
const PANEL_DRAFT_KEY_PREFIX = "__panel__:";

const noop = (): void => {};
const returnFalse = (): boolean => false;

/** 面板本地的模式展示态（Goal / WorkTree / WorkFlow / 预算）。 */
type ScopeModes = {
  goalMode: boolean;
  worktreeMode: boolean;
  workflowMode: boolean;
  goalModeTokenBudget: number;
};

const INITIAL_MODES: ScopeModes = {
  goalMode: false,
  worktreeMode: false,
  workflowMode: false,
  goalModeTokenBudget: DEFAULT_GOAL_TOKEN_BUDGET,
};

/**
 * 会话面板的「会话视图」：把某个会话包装成与主视图同构的 UseChatConversationResult，
 * 供 ChatContent 及其子树（消息列表、工具卡片、输入区）直接消费。
 *
 * - 按会话的动作（发送 / 中止 / 暂停 / 压缩 / 回滚 / 队列 / 草稿 / 授权 / 提问）
 *   全部绑定到该会话；
 * - 与单个会话无关的全局字段（会话列表版本、YOLO / 精简模式、会话树事件等）
 *   继续透传主视图的值；
 * - 主视图仍是「主视图」：面板的动作不会改写主视图的显示态（模式开关等由运行时
 *   按「目标是否为主视图激活会话」自行判断）。
 *
 * 底层运行时是同一个 ChatConversationProvider 实例，因此面板与主视图展示同一份
 * 会话内存态，不存在两份状态互相覆盖的问题。
 */
export const useChatSessionScope = (
  conversationId: string,
  /**
   * 承载本会话视图的面板 tab id：给出时把该会话登记为「由该面板承载」
   * （主内容区随之让出该会话，选中它时聚焦该 tab）。主视图不传。
   */
  ownershipTabId?: string,
  /**
   * 可选：接管「切换到其它会话」的动作（面板内的「返回主会话」等入口）。
   * 给出时替换默认的全局选择，面板据此在同一个 tab 内切换展示的会话。
   */
  onSelectConversation?: UseChatConversationResult["handleSelectConversation"],
): UseChatConversationResult => {
  const main = useChatConversationContext();
  const sessions = useChatConversationSessions();
  const session = sessions[conversationId];
  const isLoaded = session?.isInitialHistoryLoaded === true;
  const hostsActiveConversation = main.activeConversationId === conversationId;

  const [loadFailed, setLoadFailed] = useState(false);
  const [modes, setModes] = useState<ScopeModes>(INITIAL_MODES);

  // 面板挂载即加载该会话的初始历史（不切换主视图）。
  const {
    loadConversationScope,
    pinSessionScope,
    readSessionRuntime,
    setGoalMode,
    setWorktreeMode,
    setWorkflowMode,
    setGoalModeTokenBudget,
    refreshGoalMode,
    refreshWorktreeMode,
    refreshWorkflowMode,
    refreshGoalModeTokenBudget,
    handleSendMessage,
    handlePause,
    handleResume,
    abortConversation,
    handleRollback,
    loadOlderMessages,
    withdrawPendingMessage,
    sendPendingMessageNow,
    compactConversation,
    handleSelectConversation,
  } = main;
  const sessionDirectoryId = session?.directoryId;
  useEffect(() => {
    let disposed = false;
    setLoadFailed(false);
    void loadConversationScope(conversationId, sessionDirectoryId).catch(() => {
      if (!disposed) {
        setLoadFailed(true);
      }
    });
    return () => {
      disposed = true;
    };
  }, [conversationId, sessionDirectoryId, loadConversationScope]);

  // 面板打开期间钉住该会话的内存缓存：关闭面板后才允许 TTL 回收。
  // 归属登记紧随钉住之后（同一 effect 内顺序执行）：归属变化会让主视图让出该
  // 会话并释放其缓存，先钉住可避免刚打开就被释放、白加载一次历史。
  useEffect(() => {
    pinSessionScope(conversationId, true);
    const unregisterOwnership = ownershipTabId
      ? registerPanelConversation(conversationId, ownershipTabId)
      : undefined;
    return () => {
      unregisterOwnership?.();
      pinSessionScope(conversationId, false);
    };
  }, [conversationId, ownershipTabId, pinSessionScope]);

  // 会话加载完成后用运行时 ref 初始化面板的模式展示态（模式只存 ref，没有
  // 全局 state 镜像，面板需要自己的可重渲染副本）。
  useEffect(() => {
    if (!isLoaded || hostsActiveConversation) {
      return;
    }
    const snapshot = readSessionRuntime(conversationId);
    setModes({
      goalMode: snapshot.goalMode,
      worktreeMode: snapshot.worktreeMode,
      workflowMode: snapshot.workflowMode,
      goalModeTokenBudget: snapshot.goalModeTokenBudget,
    });
  }, [conversationId, isLoaded, hostsActiveConversation, readSessionRuntime]);

  const scopedSendMessage = useCallback<
    UseChatConversationResult["handleSendMessage"]
  >(
    (message, options) =>
      handleSendMessage(message, {
        ...options,
        targetSessionKey: conversationId,
      }),
    [handleSendMessage, conversationId],
  );

  const scopedAbort = useCallback((): void => {
    abortConversation(conversationId);
  }, [abortConversation, conversationId]);

  const scopedPause = useCallback((): void => {
    handlePause(conversationId);
  }, [handlePause, conversationId]);

  const scopedResume = useCallback((): void => {
    handleResume(conversationId);
  }, [handleResume, conversationId]);

  const scopedRollback = useCallback(
    (messageId: string): void => handleRollback(messageId, conversationId),
    [handleRollback, conversationId],
  );

  const scopedLoadOlder = useCallback(
    (pageSize?: number): Promise<void> =>
      loadOlderMessages(pageSize, conversationId),
    [loadOlderMessages, conversationId],
  );

  const scopedWithdraw = useCallback(
    (index: number): string | null =>
      withdrawPendingMessage(index, conversationId),
    [withdrawPendingMessage, conversationId],
  );

  const scopedSendPendingNow = useCallback(
    (index: number): boolean => sendPendingMessageNow(index, conversationId),
    [sendPendingMessageNow, conversationId],
  );

  const scopedCompact = useCallback(
    (model?: string, apiProfile?: string): Promise<void> =>
      compactConversation(model, apiProfile, conversationId),
    [compactConversation, conversationId],
  );

  const scopedSetGoalMode = useCallback(
    async (enabled: boolean): Promise<void> => {
      await setGoalMode(enabled, conversationId);
      setModes((prev) =>
        enabled
          ? {
              ...prev,
              goalMode: true,
              worktreeMode: false,
              workflowMode: false,
            }
          : { ...prev, goalMode: false },
      );
    },
    [setGoalMode, conversationId],
  );

  const scopedSetWorktreeMode = useCallback(
    async (enabled: boolean): Promise<void> => {
      await setWorktreeMode(enabled, conversationId);
      setModes((prev) =>
        enabled
          ? {
              ...prev,
              worktreeMode: true,
              goalMode: false,
              workflowMode: false,
            }
          : { ...prev, worktreeMode: false },
      );
    },
    [setWorktreeMode, conversationId],
  );

  const scopedSetWorkflowMode = useCallback(
    async (enabled: boolean): Promise<void> => {
      await setWorkflowMode(enabled, conversationId);
      setModes((prev) =>
        enabled
          ? {
              ...prev,
              workflowMode: true,
              goalMode: false,
              worktreeMode: false,
            }
          : { ...prev, workflowMode: false },
      );
    },
    [setWorkflowMode, conversationId],
  );

  const scopedSetGoalBudget = useCallback(
    async (budget: number): Promise<void> => {
      await setGoalModeTokenBudget(budget, conversationId);
      setModes((prev) => ({ ...prev, goalModeTokenBudget: budget }));
    },
    [setGoalModeTokenBudget, conversationId],
  );

  const scopedRefreshGoalMode = useCallback(async (): Promise<boolean> => {
    const value = await refreshGoalMode(conversationId);
    setModes((prev) => ({ ...prev, goalMode: value }));
    return value;
  }, [refreshGoalMode, conversationId]);

  const scopedRefreshWorktreeMode = useCallback(async (): Promise<boolean> => {
    const value = await refreshWorktreeMode(conversationId);
    setModes((prev) => ({ ...prev, worktreeMode: value }));
    return value;
  }, [refreshWorktreeMode, conversationId]);

  const scopedRefreshWorkflowMode = useCallback(async (): Promise<boolean> => {
    const value = await refreshWorkflowMode(conversationId);
    setModes((prev) => ({ ...prev, workflowMode: value }));
    return value;
  }, [refreshWorkflowMode, conversationId]);

  const scopedRefreshGoalBudget = useCallback(async (): Promise<void> => {
    await refreshGoalModeTokenBudget(conversationId);
    const snapshot = readSessionRuntime(conversationId);
    setModes((prev) => ({
      ...prev,
      goalModeTokenBudget: snapshot.goalModeTokenBudget,
    }));
  }, [refreshGoalModeTokenBudget, conversationId, readSessionRuntime]);

  const scopedSelectConversation = useCallback<
    UseChatConversationResult["handleSelectConversation"]
  >(
    (id, title, tokenUsage, directoryId) =>
      onSelectConversation
        ? onSelectConversation(id, title, tokenUsage, directoryId)
        : handleSelectConversation(id, title, tokenUsage, directoryId),
    [handleSelectConversation, onSelectConversation],
  );

  // 面板的输入草稿用独立键存储，与主视图互不覆盖。
  const panelDraftKey = `${PANEL_DRAFT_KEY_PREFIX}${conversationId}`;
  const scopedSaveDraft = useCallback(
    (_conversationId: string | undefined, content: string): void => {
      main.saveInputDraft(panelDraftKey, content);
    },
    [main.saveInputDraft, panelDraftKey],
  );
  const scopedGetDraft = useCallback(
    (): string | undefined => main.getInputDraft(panelDraftKey),
    [main.getInputDraft, panelDraftKey],
  );
  const scopedClearDraft = useCallback((): void => {
    main.clearInputDraft(panelDraftKey);
  }, [main.clearInputDraft, panelDraftKey]);

  // 面板只展示自己的文件变更统计切片（主视图读的是激活会话的切片之外的整表）。
  const fileChangeStats = useMemo(
    () => ({
      [conversationId]:
        main.fileChangeStats[conversationId] ?? EMPTY_FILE_CHANGES,
    }),
    [main.fileChangeStats, conversationId],
  );

  const runtimeSnapshot = readSessionRuntime(conversationId);
  const pendingMirror = main.pendingQueueMirrors[conversationId];
  const localModes = hostsActiveConversation
    ? {
        goalMode: main.goalMode,
        worktreeMode: main.worktreeMode,
        workflowMode: main.workflowMode,
        goalModeTokenBudget: main.goalModeTokenBudget,
      }
    : modes;
  const rollbackPreview = useMemo(
    () =>
      main.rollbackPreview && main.rollbackPreview.sessionKey === conversationId
        ? main.rollbackPreview
        : null,
    [main.rollbackPreview, conversationId],
  );
  const isCompactingThis = main.compactingConversationId === conversationId;

  return {
    ...main,
    // ===== 按会话的展示字段 =====
    messages: session?.messages ?? EMPTY_MESSAGES,
    summary: session?.summary ?? "",
    activeConversationId: conversationId,
    sessionViewKey: conversationId,
    newChatGeneration: 0,
    newChatRequested: false,
    conversationDirectoryId: session?.directoryId,
    tokenUsage: session?.tokenUsage ?? null,
    isStreaming: session?.isStreaming ?? false,
    isPaused: session?.isPaused ?? false,
    isAborting: session?.isAborting ?? false,
    isLoadingOlderMessages: session?.isLoadingOlderMessages ?? false,
    hasMoreMessages: session?.hasMoreMessages ?? false,
    isInitialHistoryLoaded: isLoaded,
    isLoadingInitialHistory: !isLoaded && !loadFailed,
    streamTokenCount: session?.streamTokenCount ?? 0,
    streamElapsedMs: session?.streamElapsedMs ?? 0,
    streamTtftMs: session?.streamTtftMs ?? 0,
    runTtftMs: session?.runTtftMs ?? 0,
    streamStartedAt: session?.streamStartedAt ?? 0,
    runTokenUsage: session?.runTokenUsage ?? null,
    conversationTokenUsage: session?.conversationTokenUsage ?? null,
    lastRunDurationMs: session?.lastRunDurationMs ?? 0,
    conversationTtftSumMs: session?.conversationTtftSumMs ?? 0,
    conversationRequestCount: session?.conversationRequestCount ?? 0,
    baselineCheckpointId: session?.baselineCheckpointId,
    visionAnalysis: session?.visionAnalysis,
    triggeredByTask: session?.triggeredByTask,
    forkedFromConversationId: session?.forkedFromConversationId,
    forkMessageCount: session?.forkMessageCount,
    checkpointIds: runtimeSnapshot.checkpointIds,
    conversationWorktreeMode: localModes.worktreeMode,
    conversationWorktreeId: runtimeSnapshot.worktreeId,
    fileChangeStats,

    // ===== 按会话的动作绑定 =====
    handleSendMessage: scopedSendMessage,
    handleAbort: scopedAbort,
    handlePause: scopedPause,
    handleResume: scopedResume,
    handleRollback: scopedRollback,
    loadOlderMessages: scopedLoadOlder,
    withdrawPendingMessage: scopedWithdraw,
    sendPendingMessageNow: scopedSendPendingNow,
    compactConversation: scopedCompact,
    handleSelectConversation: scopedSelectConversation,
    saveInputDraft: scopedSaveDraft,
    getInputDraft: scopedGetDraft,
    clearInputDraft: scopedClearDraft,

    // ===== 待发送队列（按会话镜像）=====
    pendingMessages: pendingMirror?.messages ?? EMPTY_STRINGS,
    pendingMessageModes: pendingMirror?.modes,

    // ===== 待授权工具（按会话切片）=====
    pendingToolAuthorizations:
      main.pendingToolAuthorizationsBySession[conversationId] ??
      EMPTY_TOOL_CALLS,

    // ===== 压缩态只反映本会话 =====
    compactionPreview: isCompactingThis ? main.compactionPreview : "",
    compactionError: isCompactingThis ? main.compactionError : null,
    isCompacting: main.isCompacting && isCompactingThis,
    compactingConversationId: main.compactingConversationId,

    // ===== 模式开关（按会话；面板有自己的展示态）=====
    goalMode: localModes.goalMode,
    setGoalMode: scopedSetGoalMode,
    refreshGoalMode: scopedRefreshGoalMode,
    worktreeMode: localModes.worktreeMode,
    setWorktreeMode: scopedSetWorktreeMode,
    refreshWorktreeMode: scopedRefreshWorktreeMode,
    workflowMode: localModes.workflowMode,
    setWorkflowMode: scopedSetWorkflowMode,
    refreshWorkflowMode: scopedRefreshWorkflowMode,
    goalModeTokenBudget: localModes.goalModeTokenBudget,
    setGoalModeTokenBudget: scopedSetGoalBudget,
    refreshGoalModeTokenBudget: scopedRefreshGoalBudget,
    // WorkTree 绑定提示由主视图承载：面板不重复弹窗，但错误仍转交主视图。
    worktreeModeNotice: null,
    // 新会话预选工作树是主视图的一次性状态，面板不参与。
    pendingWorktreeId: null,

    // ===== 仅主视图可用的一次性状态：面板置空，避免误触发 =====
    draftToRestore: null,
    clearDraftToRestore: noop,
    rollbackWorkflowComposer: null,
    clearRollbackWorkflowComposer: noop,
    autoSendRequest: null,
    claimAutoSend: returnFalse,
    completeAutoSend: noop,
    rollbackNewChatState: null,
    rollbackPreview,
    rollbackPreparingMessageId: main.rollbackPreparingMessageId,
  };
};

/**
 * 会话面板的上下文作用域：把会话视图注入子树。聊天视图（ChatContent）及其
 * 所有深层消费者都按面板绑定的会话解析字段与动作。
 */
export const ChatSessionScope = ({
  conversationId,
  ownershipTabId,
  onSelectConversation,
  children,
}: {
  conversationId: string;
  /** 承载本会话视图的面板 tab id（见 useChatSessionScope 的同名参数）。 */
  ownershipTabId?: string;
  /** 可选：接管「切换到其它会话」的动作（见 useChatSessionScope 的同名参数）。 */
  onSelectConversation?: UseChatConversationResult["handleSelectConversation"];
  children: ReactNode;
}): React.JSX.Element => {
  const value = useChatSessionScope(
    conversationId,
    ownershipTabId,
    onSelectConversation,
  );
  return (
    <ChatConversationValueProvider value={value}>
      {children}
    </ChatConversationValueProvider>
  );
};
