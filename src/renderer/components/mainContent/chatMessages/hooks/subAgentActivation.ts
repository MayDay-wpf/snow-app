import {
  currentAgentTask,
  bindAgentTask,
  recordTaskResponse,
} from "./taskHistory";
import type {
  ChatConversationMessage,
  ConversationContextValue,
  ToolAuthorizationDecision,
  ToolCallInfo,
  PendingQueueItem,
} from "../utils/conversationTypes";
import type { ChatInputSendOptions } from "../../chatInput/types";
import {
  demotePendingSteering,
  hasPendingSteering,
  refreshPendingMessages,
  takeNextQueuedMessage,
  takePendingSteering,
} from "../utils/pendingInputs";
import { rejectionKeepsAiFlow } from "../utils/conversationTypes";
import {
  settledResult,
  awaitSettledSubAgentResult,
  runError,
  toolFailure,
} from "./subAgentRunResults";
import { recordSkippedSubAgentTools } from "./subAgentSkippedTools";
import {
  createMessageId,
  deleteCheckpoints,
  directoryIdToPath,
  formatMessageTime,
  formatMcpToolResultForModel,
  formatToolResultsContent,
  getErrorMessage,
  inheritConversationWorktreeBinding,
  parseToolCalls,
  resolveConversationWorkspacePath,
  updateFirstMatchingToolCall,
} from "../utils/conversationHelpers";
import { resolveResponseDisposition } from "../utils/responseDisposition";
import {
  buildCompactionResumeMessages,
  runAutoCompactionGate,
} from "../utils/autoCompaction";
import { settleResponseHtmlPreviewEligibility } from "../utils/messageSettlement";
import {
  failedModelMessage,
  hasModelRetryToolCalls,
  modelFailureReason,
  modelRetryToolCallsRejectedReason,
  modelRetryToolsBlockedReason,
  settleApiCancellation,
} from "./modelResponseFailure";
import { appendHookExecutionToMessage, runHook } from "./hookOutcome";
import {
  extractFileChangesFromTool,
  extractFileChangeCoverageFromTool,
} from "./fileChangeTracking";
import { injectSessionIdIntoToolArgs } from "../utils/toolSessionMetadata";
import type { SubAgentRuntimeConfig } from "./subAgentRuntimeConfig";
import {
  buildUnavailableToolsPrompt,
  parseSubAgentTools,
  resolveSubAgentRuntimeConfig,
} from "./subAgentRuntimeConfig";
import {
  applySubAgentAcceptanceReport,
  buildSubAgentAcceptancePrompt,
  hasSubAgentAcceptance,
  initializeSubAgentAcceptance,
  mergeSubAgentAcceptanceCriteria,
  noteSubAgentAcceptanceReportMissing,
  parseSubAgentAcceptanceCriteria,
  parseSubAgentAcceptanceReport,
  peekSubAgentAcceptanceSnapshot,
  recordSubAgentEvidence,
  restoreSubAgentAcceptanceSnapshot,
  mergeSubAgentAcceptanceSnapshot,
} from "./subAgentAcceptance";
import type {
  SubAgentAcceptanceEvidenceStatus,
  SubAgentAcceptanceSnapshot,
} from "./subAgentAcceptance";
import {
  awaitSubAgentFailureDecision,
  cancelSubAgentRunWaits,
  registerSubAgentRunControl,
  unregisterSubAgentRunControl,
} from "./subAgentRunControl";
import { loadSubAgentExecutionMode } from "./subAgentExecutionMode";
import {
  activeConversationRun,
  collaborationToolsJson,
  executePeerMessage,
  parseCollaborationGroup,
} from "./subAgentCollaboration";
import {
  createSubAgentBudget,
  loadSubAgentBudgetLimits,
} from "./subAgentBudget";
import { waitForSubAgentCapacity } from "./subAgentCapacity";
import { logSubAgentDiagnostic } from "./subAgentDiagnostics";
import {
  isSubAgentEmptyTextRead,
  withSubAgentTerminalFailureOutput,
} from "./subAgentToolFailure";
import { appendToolCorrectionNote, detectToolFailure } from "./toolCorrection";
import {
  applyToolCorrectionToCall,
  correctFailedToolCall,
  createToolDefinitionLookup,
} from "./toolCorrectionRunner";
import { validateToolCall } from "../utils/conversationHelpers";
import type {
  SubAgentAccepted,
  SubAgentLogicalInput,
  SubAgentMessageQueued,
  SubAgentExecutionMode,
  SubAgentExecutionSnapshot,
  SubAgentHookOutcome,
  SubAgentOutcome,
  SubAgentRunCommand,
  SubAgentRunCommandResult,
  SubAgentRunError,
  SubAgentRunRecord,
  SubAgentRunScope,
} from "../../../../../shared/subAgentRuns";
import { isSubAgentTerminal } from "../../../../../shared/subAgentRuns";
import {
  notifySubAgentRunChanges,
  readSubAgentRunResult,
  retainOwnedSubAgentResourceStop,
  requestOwnedSubAgentRunCancel,
  startOwnedSubAgentRun,
} from "./subAgentRunRegistry";
import type { SubAgentRunPersistence } from "./subAgentRunRegistry";
import {
  accumulateConversationRunStats,
  accumulateRunTokenUsage,
  bindPersistedAssistantRecordId,
  createStreamChunkHandler,
  createStreamIdHandler,
  resetIterationStreamMetrics,
  resetRunStreamMetrics,
  markRunStarted,
} from "./agentLoopHelpers";

/** Communication is explicitly authorized per durable run, never ambient. */
export const SUB_AGENT_COMMS_TOOL_NAMES = new Set(["sub-agents-sendMessage"]);

/** 主会话管理工具；Rust 对子代理过滤。 */
export const SUB_AGENT_MAIN_TOOL_NAMES = new Set([
  "sub-agents-continue",
  "sub-agents-getResult",
  "sub-agents-cancel",
]);

/** continue 恢复器，返回工具结果 JSON；重启后按需重建。 */
export type SubAgentResumer = {
  parentConversationId: string;
  agentId: string;
  agentName: string;
  resume: (
    messages: { role: "user"; content: string }[],
    checkpointIds?: string[],
    options?: RunOptions,
    activationDeps?: SubAgentActivationDeps,
  ) => Promise<string>;
};

/** 按会话保留恢复器至 renderer 退出，终态不移除。 */
const subAgentResumers = new Map<string, SubAgentResumer>();
const subAgentSessionOwners = new Map<string, string>();

type CheckpointIdsRef = { current: string[] };

export type SubAgentActivationDeps = {
  ctx: ConversationContextValue;
  requestToolAuthorizations: (
    toolCalls: ToolCallInfo[],
    conversationId: string,
    projectId?: string,
    waitForConfirmation?: (
      confirm: () => Promise<ToolAuthorizationDecision[]>,
    ) => Promise<ToolAuthorizationDecision[]>,
  ) => Promise<ToolAuthorizationDecision[]>;
  parentApiProfile: string | undefined;
  parentModel: string | undefined;
  /** Effective thinking strength captured by the parent run; inherited by the
   *  sub-agent when its resolved profile's request method supports the tier. */
  parentThinkingStrength?: string | null;
  /** Effective Fast Mode captured by the parent run; an explicit tier is valid. */
  parentResponsesFastMode?: string | null;
  runPersistence?: {
    command(command: SubAgentRunCommand): Promise<SubAgentRunCommandResult>;
    onCommitted(run: SubAgentRunRecord): void;
  };
};

// ---------------------------------------------------------------------------
// 子代理运行工厂（激活与重启后从 DB 恢复共用）
// ---------------------------------------------------------------------------

/**
 * 记录一次工具执行证据并在子代理看到的工具结果前加上证据 id。只有附带
 * 验收清单时才生效：没有清单时原样返回模型结果，不改变子代理行为。
 */
const withSubAgentEvidence = (
  conversationId: string,
  toolName: string,
  callId: string | undefined,
  status: SubAgentAcceptanceEvidenceStatus,
  rawResult: string,
  modelResult: string,
): string => {
  const evidenceId = recordSubAgentEvidence(conversationId, {
    toolName,
    callId: callId ?? "",
    status,
    result: rawResult,
  });
  return evidenceId ? `[evidence ${evidenceId}]\n${modelResult}` : modelResult;
};

export type SubAgentRunLoop = (
  subMessages: {
    role: "user" | "assistant" | "system" | "developer" | "tool";
    content: string;
  }[],
  resumeAfterCompaction?: boolean,
) => Promise<string>;

type SubAgentRunLoopDeps = {
  ctx: ConversationContextValue;
  subConvId: string;
  dirId: string;
  runtimeConfig: SubAgentRuntimeConfig;
  parentConversationId: string;
  parentCheckpointIdsRef: CheckpointIdsRef;
  subCheckpointWorkDir: string | undefined;
  requestToolAuthorizations: SubAgentActivationDeps["requestToolAuthorizations"];
  isSubCancelled: () => boolean;
  slotOwner: string;
  taskHistory: ReturnType<typeof currentAgentTask>;
  worktreeMode: boolean;
  withWaiting: <T>(
    reason: NonNullable<SubAgentRunRecord["waitingReason"]>,
    action: () => Promise<T>,
  ) => Promise<T>;
  retainedPending: ReadonlySet<PendingQueueItem>;
  takeRunMessages: () => Promise<string[]>;
  runPersistence: SubAgentRunPersistence;
  budget: ReturnType<typeof createSubAgentBudget>;
  onExecutionError: (error: SubAgentRunError) => void;
};

/** 子代理回合循环工厂。激活（createSubAgentActivation）与重启后恢复
 * （restoreSubAgentResumer）共用同一实现，保证运行行为完全一致。 */
const createSubAgentRunLoop = (deps: SubAgentRunLoopDeps): SubAgentRunLoop => {
  const {
    ctx,
    subConvId,
    dirId,
    runtimeConfig,
    parentConversationId,
    parentCheckpointIdsRef,
    subCheckpointWorkDir,
    requestToolAuthorizations,
    isSubCancelled,
    slotOwner,
    taskHistory,
    worktreeMode,
    withWaiting,
    takeRunMessages,
    retainedPending,
    onExecutionError,
  } = deps;
  const agentName = runtimeConfig.agentName;
  const subAgentToolsJson = runtimeConfig.toolsJson;
  const allowedTools = parseSubAgentTools(runtimeConfig.toolsJson);
  const sendOptions: ChatInputSendOptions = {
    apiProfile: runtimeConfig.apiProfile,
    model: runtimeConfig.model,
    thinkingStrength: runtimeConfig.effectiveThinkingStrength,
    responsesFastMode: runtimeConfig.effectiveResponsesFastMode,
  };
  // Delegated sessions keep their configured tool set/prompt. A request to
  // change that run's configuration stays queued, rather than being discarded
  // or silently executed with a different configuration.
  const supportsQueuedOptions = (options: ChatInputSendOptions): boolean =>
    (!options.apiProfile || options.apiProfile === sendOptions.apiProfile) &&
    (!options.model || options.model === sendOptions.model) &&
    (options.thinkingStrength === undefined ||
      options.thinkingStrength === sendOptions.thinkingStrength) &&
    (options.responsesFastMode == null ||
      options.responsesFastMode === sendOptions.responsesFastMode) &&
    (!options.kind || options.kind === "chat") &&
    (!options.targetSessionKey || options.targetSessionKey === subConvId) &&
    (options.conversationRuntimeConfigOverride?.thinkingStrength == null ||
      options.conversationRuntimeConfigOverride.thinkingStrength ===
        sendOptions.thinkingStrength) &&
    (options.conversationRuntimeConfigOverride?.responsesFastMode == null ||
      options.conversationRuntimeConfigOverride.responsesFastMode ===
        sendOptions.responsesFastMode);
  let stopped = false;
  // 用户「立即发送」软中断当前回合：不是取消，回合收尾后由强行发送循环继续。
  const isForceSendInterrupted = (): boolean => {
    const ref = ctx.sessionsRefData.current.get(subConvId);
    return Boolean(ref?.isAbortRequested && ref.forceSendAbort);
  };
  const getToolDefinition = createToolDefinitionLookup();
  const diagnosticScope = {
    runId: slotOwner,
    conversationId: subConvId,
    parentConversationId,
  };
  let activeCheckpointId: string | undefined;
  let activeCheckpointWorkDir = subCheckpointWorkDir;
  const createPendingCheckpoint = async (): Promise<string | undefined> => {
    const workDir = subCheckpointWorkDir;
    if (!workDir || isSubCancelled()) return undefined;
    activeCheckpointWorkDir = workDir;
    return window.snow.createCheckpoint(workDir).catch(() => undefined);
  };
  const appendPendingUsers = (
    texts: string[],
    checkpointId?: string,
  ): { role: "user"; content: string }[] => {
    const messages = texts.map((content) => ({
      role: "user" as const,
      content,
    }));
    const ref = ctx.sessionsRefData.current.get(subConvId);
    if (ref) {
      ref.activeTaskMessages = [...(ref.activeTaskMessages ?? []), ...messages];
      activeCheckpointId = checkpointId;
      if (checkpointId) {
        ref.checkpointIds.push(checkpointId);
      }
    }
    ctx.updateSessionMessages(subConvId, (currentMessages) => [
      ...currentMessages,
      ...messages.map((message) => ({
        ...message,
        id: createMessageId("user"),
        checkpointId,
        timestamp: formatMessageTime(),
        status: "sent" as const,
      })),
    ]);
    return messages;
  };
  const consumeSteering = async (): Promise<
    { role: "user"; content: string }[]
  > => {
    if (stopped || isSubCancelled()) return [];
    const durableMessages = await takeRunMessages();
    if (durableMessages.length) appendPendingUsers(durableMessages);
    if (!hasPendingSteering(ctx, subConvId)) {
      return durableMessages.map((content) => ({
        role: "user" as const,
        content,
      }));
    }
    // Await the checkpoint BEFORE selecting: a withdrawal during the await
    // must not suppress the ordinary tool-results continuation.
    const checkpointId = await createPendingCheckpoint();
    const items = isSubCancelled() ? [] : takePendingSteering(ctx, subConvId);
    if (!items.length) {
      if (checkpointId) deleteCheckpoints([checkpointId]);
      return durableMessages.map((content) => ({
        role: "user" as const,
        content,
      }));
    }
    return [
      ...durableMessages.map((content) => ({ role: "user" as const, content })),
      ...appendPendingUsers(
        items.map((item) => item.text),
        checkpointId,
      ),
    ];
  };

  // Peer messages use durable run identities and storage-enforced authorization.
  const executeSubAgentCommsTool = async (
    argsJson: string,
    hostRequestId: string,
  ): Promise<string> =>
    executePeerMessage(
      deps.runPersistence,
      { projectId: dirId, parentConversationId },
      slotOwner,
      argsJson,
      runtimeConfig.toolsJson,
      hostRequestId,
    );

  // Pause only at safe request/compaction boundaries; an already running tool is not interrupted.
  const awaitPauseBoundary = async (): Promise<boolean> => {
    if (isSubCancelled()) return false;
    if (isForceSendInterrupted()) {
      stopped = true;
      return false;
    }
    deps.budget.check();
    while (true) {
      const controller = ctx.pauseControllerRef.current.get(subConvId);
      if (!controller?.paused) return !isSubCancelled();
      await withWaiting(
        "pause",
        () =>
          new Promise<void>((resolve) => {
            const resume = (): void => {
              if (controller.resolve === resume) controller.resolve = null;
              resolve();
            };
            controller.resolve = resume;
            // Resume/cancel may have happened while the durable waiting transition awaited I/O.
            if (
              !controller.paused ||
              isSubCancelled() ||
              ctx.pauseControllerRef.current.get(subConvId) !== controller
            )
              resume();
          }),
      );
      if (isSubCancelled()) return false;
      deps.budget.check();
    }
  };

  const subAgentRunLoop = async (
    subMessages: Parameters<SubAgentRunLoop>[0],
    resumeAfterCompaction = false,
    modelRetryOnly = false,
  ): Promise<string> => {
    if (!(await awaitPauseBoundary())) return "Sub-agent interrupted by user";
    if (taskHistory) bindAgentTask(subConvId, taskHistory);
    if (isSubCancelled()) {
      return "Sub-agent interrupted by user";
    }

    // 统一自动压缩闸门：子代理每一次「确认要发起下一次请求」的入口（首次
    // 激活、插话续跑、旧会话恢复、内部排队、强行发送）都汇合到本循环，阈值
    // 检查因此不再依赖各调用方自己的续跑判断。携带工具结果的请求与压缩边界
    // 续跑由闸门内部跳过（前者在响应后的检查点、工具执行前压缩）。
    // Model-only retries must not compact into a tool-enabled round.
    const gateCompaction = modelRetryOnly
      ? null
      : await runAutoCompactionGate(ctx, {
          conversationId: subConvId,
          requestMessages: subMessages,
          model: runtimeConfig.model,
          // 子代理严格绑定自身 Profile，找不到时不回落全局活动档案。
          apiProfile: runtimeConfig.apiProfile,
          strictProfile: true,
          subAgentToolsJson: runtimeConfig.toolsJson,
          subAgentSystemPrompt: runtimeConfig.systemPrompt || undefined,
          thinkingStrength: runtimeConfig.effectiveThinkingStrength,
          responsesFastMode: runtimeConfig.effectiveResponsesFastMode,
          resumeAfterCompaction,
          beforeCompaction: () => deps.budget.request(),
        });
    if (gateCompaction) {
      if (isSubCancelled()) {
        return "Sub-agent interrupted by user";
      }
      return subAgentRunLoop(
        buildCompactionResumeMessages(gateCompaction, subMessages),
        true,
      );
    }

    // 迭代级瞬态指标归零：token / tok/s / 首字每次 sub-agent loop 重新
    // 计算。run 级指标（runTtftMs / runTokenUsage / streamStartedAt）保持
    // 整个 run 累计，不受影响。
    resetIterationStreamMetrics(ctx, subConvId);

    const subAssistantMessageId = createMessageId("assistant");
    const subAssistantMessage: ChatConversationMessage = {
      id: subAssistantMessageId,
      subAgentRunId: slotOwner,
      role: "assistant",
      content: "",
      timestamp: formatMessageTime(),
      status: "sending",
    };

    ctx.updateSessionMessages(subConvId, (currentMessages) => [
      ...currentMessages,
      subAssistantMessage,
    ]);

    const subChunkHandler = createStreamChunkHandler(
      ctx,
      subConvId,
      subAssistantMessageId,
      isSubCancelled,
    );
    // 验收协议随清单动态生成（continue 可能追加验收项），每次请求前重新拼接。
    const acceptancePrompt = buildSubAgentAcceptancePrompt(subConvId);
    const subAgentSystemPrompt = [
      runtimeConfig.systemPrompt,
      buildUnavailableToolsPrompt(runtimeConfig.unavailableTools),
      acceptancePrompt,
    ]
      .map((part) => (part ?? "").trim())
      .filter(Boolean)
      .join("\n\n");

    if (!(await awaitPauseBoundary())) return "Sub-agent interrupted by user";
    deps.budget.request();
    const subStreamPromise = window.snow.createResponseStream(
      {
        messages: subMessages,
        conversationId: subConvId,
        checkpointId: activeCheckpointId,
        directoryId: dirId,
        apiProfile: runtimeConfig.apiProfile,
        model: runtimeConfig.model,
        // Use the resolved per-run snapshot so restore/compaction cannot
        // re-read a changed Profile default mid-run.
        thinkingStrength: runtimeConfig.effectiveThinkingStrength,
        responsesFastMode: runtimeConfig.effectiveResponsesFastMode,
        resumeAfterCompaction,
        disableTools: modelRetryOnly,
        subAgentToolsJson,
        subAgentSystemPrompt: subAgentSystemPrompt || undefined,
        // Sub-agents always use their own normal-mode prompt and tool set;
        // WorkTree Mode only carries the parent's persisted workspace binding.
        goalMode: false,
        worktreeMode,
      },
      subChunkHandler,
      createStreamIdHandler(ctx, subConvId, isSubCancelled),
    );
    const subStreamRefBefore = ctx.sessionsRefData.current.get(subConvId);
    if (subStreamRefBefore) {
      subStreamRefBefore.streamPromise = subStreamPromise;
    }

    let subResponse: Awaited<typeof subStreamPromise>;
    try {
      subResponse = await subStreamPromise;
    } finally {
      subChunkHandler.flush();
      const subRef = ctx.sessionsRefData.current.get(subConvId);
      if (subRef?.streamPromise === subStreamPromise) {
        subRef.streamId = null;
        subRef.streamPromise = null;
      }
      ctx.updateSessionMessages(subConvId, (currentMessages) =>
        currentMessages.map((currentMessage) =>
          currentMessage.id === subAssistantMessageId
            ? { ...currentMessage, isThinkingActive: false }
            : currentMessage,
        ),
      );
    }
    deps.budget.check();
    recordTaskResponse(taskHistory, subConvId, subResponse.id, agentName);
    const subResponseDisposition = resolveResponseDisposition(subResponse);
    const subResponseFailed = subResponseDisposition.kind === "error";
    ctx.updateSessionMessages(subConvId, (currentMessages) =>
      settleResponseHtmlPreviewEligibility(
        currentMessages,
        subAssistantMessageId,
        subResponse,
        isSubCancelled(),
      ).map((message) =>
        message.id === subAssistantMessageId
          ? {
              ...message,
              failureReason: subResponseFailed
                ? subResponse.failureReason || undefined
                : undefined,
            }
          : message,
      ),
    );

    // Replace the frontend-generated temporary user message ids with the real
    // database ids returned by createResponseStream (same as the main agent
    // loop). The backend persists user messages in order and returns their
    // snowflake ids in persistedUserMessageIds. Without this remap the
    // in-memory sub-agent messages keep "user-{ts}-{rand}" ids while the DB
    // (queried by the user-message rail) stores snowflake ids, and the rail
    // cannot locate the DOM message by id.
    // 失败重试时需撤销本次 id 替换（对应 DB 行会被截断）。
    let appliedSubIdRemap: Map<string, string> | null = null;
    if (
      subResponse.persistedUserMessageIds &&
      subResponse.persistedUserMessageIds.length > 0
    ) {
      // Collect all pending (non-persisted) user message ids in order so
      // we can map them 1:1 to the returned DB ids.
      const pendingSubUserIds: string[] = [];
      const currentSubMessages =
        ctx.sessionsRef.current?.[subConvId]?.messages ?? [];
      for (const m of currentSubMessages) {
        if (m.role === "user" && !m.isContextCompaction) {
          // A user message is "pending" (needs id replacement) if its id
          // does not look like a DB snowflake id. Frontend ids use the
          // pattern "user-{timestamp}-{random}"; DB ids are numeric
          // snowflake strings.
          const isFrontendId = isNaN(Number(m.id));
          if (isFrontendId) {
            pendingSubUserIds.push(m.id);
          }
        }
      }

      // Build a mapping from old frontend id -> new DB id. The backend
      // returns ids in the same order as the user messages in the request.
      const subIdRemap = new Map<string, string>();
      const subRemapCount = Math.min(
        pendingSubUserIds.length,
        subResponse.persistedUserMessageIds.length,
      );
      for (let i = 0; i < subRemapCount; i++) {
        subIdRemap.set(
          pendingSubUserIds[i],
          subResponse.persistedUserMessageIds[i],
        );
      }

      if (subIdRemap.size > 0) {
        appliedSubIdRemap = subIdRemap;
        ctx.updateSessionMessages(subConvId, (msgs) =>
          msgs.map((m) => {
            const newId = subIdRemap.get(m.id);
            return newId ? { ...m, id: newId } : m;
          }),
        );
      }
    }
    bindPersistedAssistantRecordId(
      ctx,
      subConvId,
      subAssistantMessageId,
      subResponse.persistedAssistantMessageId,
    );

    const forceSendAbort = isForceSendInterrupted();
    if (forceSendAbort || isSubCancelled()) {
      // 软中断结束本回合，外层随即交给强行发送循环处理暂存消息。
      if (forceSendAbort) stopped = true;
      ctx.updateSessionMessages(subConvId, (currentMessages) =>
        currentMessages.map((currentMessage) =>
          currentMessage.id === subAssistantMessageId
            ? {
                ...currentMessage,
                status: "sent" as const,
                content: forceSendAbort
                  ? currentMessage.content || ""
                  : currentMessage.content || "Sub-agent interrupted by user",
                isRetrying: false,
              }
            : currentMessage,
        ),
      );
      return forceSendAbort ? "" : "Sub-agent interrupted by user";
    }

    if (
      settleApiCancellation(ctx, subConvId, subAssistantMessageId, subResponse)
    )
      return "";
    if (subResponse.tokenUsage && !subResponseFailed) {
      ctx.updateSessionField(subConvId, "tokenUsage", subResponse.tokenUsage);
      accumulateRunTokenUsage(ctx, subConvId, subResponse.tokenUsage);
    }

    // A final incomplete-like result terminates the sub-agent's internal
    // loop. Keep display-safe content and metadata, but never parse,
    // authorize, execute, or return incomplete tool arguments.
    if (subResponseDisposition.kind === "incomplete") {
      stopped = true;
      ctx.updateSessionMessages(subConvId, (messages) =>
        messages.map((message) =>
          message.id === subAssistantMessageId
            ? {
                ...failedModelMessage(message, subResponse),
                status: "incomplete" as const,
                failureReason: undefined,
                incompleteVariant: subResponseDisposition.variant,
                interruptionReason: subResponseDisposition.reason,
                recoveryOutcome: subResponseDisposition.recoveryOutcome,
              }
            : message,
        ),
      );
      throw new Error(
        `Sub-agent response incomplete (${subResponseDisposition.reason})`,
      );
    }

    const subToolCalls =
      subResponseDisposition.kind === "complete"
        ? parseToolCalls(subResponse.toolCallsJson)
        : [];

    if (subResponseFailed) {
      logSubAgentDiagnostic("fatal", {
        ...diagnosticScope,
        reasonCode: "MODEL_REQUEST_FAILED",
      });
      const failureReason = subResponse.failureReason || undefined;
      ctx.updateSessionMessages(subConvId, (messages) =>
        messages.map((message) =>
          message.id === subAssistantMessageId
            ? failedModelMessage(message, subResponse)
            : message,
        ),
      );
      // 挂起等待用户「重试 / 放弃」，主会话的工具调用保持等待；挂起期间让出并发名额。
      if (!isSubCancelled()) {
        ctx.updateSessionField(subConvId, "isStreaming", false);
        ctx.removeStreamingId(subConvId);
        const decision = await withWaiting("failure_decision", () =>
          awaitSubAgentFailureDecision(slotOwner),
        );
        const retryReady = decision === "retry" && !isSubCancelled();
        if (
          retryReady &&
          subMessages.some((message) => message.role === "tool")
        ) {
          stopped = true;
          const reason = modelRetryToolsBlockedReason();
          onExecutionError({
            category: "model",
            code: "MODEL_RETRY_TOOLS_BLOCKED",
            message: reason,
            retryable: false,
          });
          ctx.updateSessionMessages(subConvId, (messages) =>
            messages.map((message) =>
              message.id === subAssistantMessageId
                ? failedModelMessage(message, {
                    ...subResponse,
                    failureReason: reason,
                  })
                : message,
            ),
          );
          return subResponse.content || "";
        }
        if (retryReady) {
          await window.snow.truncateTrailingFailedExchange(subConvId);
          if (isSubCancelled()) {
            stopped = true;
            return "Sub-agent interrupted by user";
          }
          ctx.updateSessionField(subConvId, "isStreaming", true);
          ctx.addStreamingId(subConvId);
          const revertIds = new Map(
            Array.from(appliedSubIdRemap ?? []).map(
              ([oldId, newId]): [string, string] => [newId, oldId],
            ),
          );
          ctx.updateSessionMessages(subConvId, (currentMessages) =>
            currentMessages
              .filter((message) => message.id !== subAssistantMessageId)
              .map((message) => {
                const oldId = revertIds.get(message.id);
                return oldId ? { ...message, id: oldId } : message;
              }),
          );
          return subAgentRunLoop(subMessages, resumeAfterCompaction, true);
        }
      }
      stopped = true;
      if (isSubCancelled() || isForceSendInterrupted()) {
        return "Sub-agent interrupted by user";
      }
      // Only the normalized reason may leave the failure channel, never the body.
      throw new Error(failureReason || "Sub-agent model request failed");
    }

    // A model retry never authorizes tools, compacts, or consumes steering.
    if (modelRetryOnly) {
      stopped = true;
      const reason = hasModelRetryToolCalls(subResponse.toolCallsJson)
        ? modelRetryToolCallsRejectedReason()
        : undefined;
      if (reason)
        onExecutionError({
          category: "model",
          code: "MODEL_RETRY_TOOL_CALLS_REJECTED",
          message: reason,
          retryable: false,
        });
      ctx.updateSessionMessages(subConvId, (messages) =>
        messages.map((message) =>
          message.id === subAssistantMessageId
            ? {
                ...failedModelMessage(message, {
                  ...subResponse,
                  failureReason: reason,
                }),
                status: reason ? "error" : "sent",
              }
            : message,
        ),
      );
      return subResponse.content || "";
    }

    // 工具调用必然带来下一轮请求：这里在工具执行之前压缩，压缩交接因此覆盖
    // 不到本轮工具调用（它们被放弃，Rust 压缩边界 + ensure_tool_pairing 保证
    // 压缩后的上下文没有孤儿工具条目）。其余续跑入口（无工具后的插话续跑、
    // 旧子会话恢复、内部排队、强行发送）不在这里推断，而是在循环入口由统一
    // 闸门检查。子代理自然收尾（无工具调用且无续跑输入）时不得压缩 —— 那会
    // 把已完成的子代理重新唤醒。
    if (subToolCalls.length > 0 && !subResponseFailed) {
      if (!(await awaitPauseBoundary())) return "Sub-agent interrupted by user";
      const subCompaction = await runAutoCompactionGate(ctx, {
        conversationId: subConvId,
        requestMessages: [],
        model: runtimeConfig.model,
        apiProfile: runtimeConfig.apiProfile,
        strictProfile: true,
        subAgentToolsJson: runtimeConfig.toolsJson,
        subAgentSystemPrompt: runtimeConfig.systemPrompt || undefined,
        thinkingStrength: runtimeConfig.effectiveThinkingStrength,
        responsesFastMode: runtimeConfig.effectiveResponsesFastMode,
        tokenUsage: subResponse.tokenUsage,
        beforeCompaction: () => {
          deps.budget.request();
          ctx.updateSessionMessages(subConvId, (currentMessages) =>
            currentMessages.map((currentMessage) =>
              currentMessage.id === subAssistantMessageId
                ? {
                    ...currentMessage,
                    content:
                      subResponse.content || currentMessage.content || "",
                    thinking:
                      subResponse.thinking ||
                      currentMessage.thinking ||
                      undefined,
                    timestamp: formatMessageTime(),
                    status: "sent",
                    responseId: subResponse.id || undefined,
                    model: subResponse.model || undefined,
                    isRetrying: false,
                  }
                : currentMessage,
            ),
          );
        },
      });

      // Continue only after the shared compaction gate succeeds.

      if (subCompaction) {
        if (isSubCancelled()) {
          return "Sub-agent interrupted by user";
        }

        // Continue the sub-agent loop from the compacted context. The Rust
        // backend rebuilds context from the compaction boundary stored in the
        // database for this sub-conversation. The first message is the handoff
        // placeholder (already persisted as the context_compaction boundary);
        // protectedMessages（压缩前最后一条用户任务原文）紧随其后，由 Rust
        // 注入并持久化，防止子代理因摘要丢失任务/TODO 状态而忘记任务。
        return subAgentRunLoop(
          buildCompactionResumeMessages(subCompaction, []),
          true,
        );
      }
    }

    if (subToolCalls.length === 0) {
      ctx.updateSessionMessages(subConvId, (currentMessages) =>
        currentMessages.map((currentMessage) =>
          currentMessage.id === subAssistantMessageId
            ? {
                ...currentMessage,
                content:
                  subResponse.content ||
                  currentMessage.content ||
                  "Sub-agent completed with no output.",
                status: "sent" as const,
                responseId: subResponse.id || undefined,
                model: subResponse.model || undefined,
                isRetrying: false,
              }
            : currentMessage,
        ),
      );

      const steering = await consumeSteering();
      if (steering.length) return subAgentRunLoop(steering);
      return subResponse.content || "Sub-agent completed with no output.";
    }

    ctx.updateSessionMessages(subConvId, (currentMessages) =>
      currentMessages.map((currentMessage) =>
        currentMessage.id === subAssistantMessageId
          ? {
              ...currentMessage,
              content: subResponse.content || "",
              thinking: subResponse.thinking || undefined,
              toolCalls: subToolCalls.map((tc) => ({
                ...tc,
                status: "pending" as const,
              })),
              status: "sent" as const,
              responseId: subResponse.id || undefined,
              model: subResponse.model || undefined,
              isRetrying: false,
            }
          : currentMessage,
      ),
    );

    const dispatchToolCalls = subToolCalls;

    const subAuthorizationDecisions = await requestToolAuthorizations(
      dispatchToolCalls,
      subConvId,
      dirId,
      (confirm) => withWaiting("authorization", confirm),
    );

    const subAllToolsRejected =
      dispatchToolCalls.length > 0 &&
      subAuthorizationDecisions.every(
        (decision) => decision.status === "rejected",
      );
    // 拒绝可续跑时（用户填写了理由 / 敏感命令被拒绝），拒绝理由作为工具
    // 结果回传子代理 AI，子代理 Loop 继续；仅当全部拒绝且不可续跑时才终止。
    const subHasContinuableRejection =
      subAuthorizationDecisions.some(rejectionKeepsAiFlow);

    const subToolResults: string[] = [];
    const subStructuredResults: {
      name: string;
      callId: string;
      result: string;
    }[] = [];
    for (
      let subToolIndex = 0;
      subToolIndex < dispatchToolCalls.length;
      subToolIndex++
    ) {
      deps.budget.check();
      const subToolCall = dispatchToolCalls[subToolIndex];
      const subAuthorizationDecision = subAuthorizationDecisions[subToolIndex];

      if (
        isSubCancelled() ||
        ctx.sessionsRefData.current.get(subConvId)?.isAbortRequested
      ) {
        stopped = true;
        break;
      }

      if (subAuthorizationDecision.status === "rejected") {
        const subRejectResult = JSON.stringify({
          success: false,
          error: "TOOL_EXECUTION_DENIED",
          reason:
            subAuthorizationDecision.reason || "User declined tool execution",
        });
        const coverage = extractFileChangeCoverageFromTool(
          subToolCall.name,
          subRejectResult,
        );
        if (coverage) {
          const record = {
            ...coverage,
            agent: "sub" as const,
            subAgentName: agentName,
            timestamp: Date.now(),
          };
          ctx.recordFileChangeCoverage(subConvId, record);
          ctx.recordFileChangeCoverage(parentConversationId, record);
        }
        const subRejectedModelResult = withSubAgentEvidence(
          subConvId,
          subToolCall.name,
          subToolCall.callId,
          "rejected",
          subRejectResult,
          formatMcpToolResultForModel(subRejectResult),
        );
        subToolResults.push(subRejectedModelResult);
        subStructuredResults.push({
          name: subToolCall.name,
          callId: subToolCall.callId || "",
          result: subRejectedModelResult,
        });

        ctx.updateSessionMessages(subConvId, (currentMessages) =>
          currentMessages.map((currentMessage) => {
            if (currentMessage.id !== subAssistantMessageId) {
              return currentMessage;
            }
            return {
              ...currentMessage,
              toolCalls: updateFirstMatchingToolCall(
                currentMessage.toolCalls,
                subToolCall,
                ["pending"],
                (currentToolCall) => ({
                  ...currentToolCall,
                  status: "completed" as const,
                  result: subRejectResult,
                }),
              ),
            };
          }),
        );
        continue;
      }

      const subToolArgs = injectSessionIdIntoToolArgs(
        subToolCall.name,
        subToolCall.arguments,
        subConvId,
      );
      let subSensitiveAuthorizationToken: string | undefined;
      if (
        subToolCall.name === "bash-terminal-execute" &&
        subAuthorizationDecision.status === "approved" &&
        subAuthorizationDecision.sensitiveCommandConfirmed === true
      ) {
        try {
          const subParsedArgs = JSON.parse(subToolArgs) as Record<
            string,
            unknown
          >;
          if (typeof subParsedArgs.command !== "string") {
            throw new Error("Sensitive command argument is missing");
          }
          subSensitiveAuthorizationToken =
            await window.snow.issueSensitiveCommandAuthorization(
              subParsedArgs.command,
            );
        } catch {
          // If authorization fails, let the tool fail naturally.
        }
      }

      ctx.updateSessionMessages(subConvId, (currentMessages) =>
        currentMessages.map((currentMessage) => {
          if (currentMessage.id !== subAssistantMessageId) {
            return currentMessage;
          }
          return {
            ...currentMessage,
            toolCalls: updateFirstMatchingToolCall(
              currentMessage.toolCalls,
              subToolCall,
              ["pending"],
              (currentToolCall) => ({
                ...currentToolCall,
                status: "running" as const,
                startedAt: Date.now(),
              }),
            ),
          };
        }),
      );

      const toolStartedAt = Date.now();
      const toolDiagnosticScope = {
        ...diagnosticScope,
        toolName: subToolCall.name,
        callId: subToolCall.callId,
        interactionId: subToolCall.interactionId,
      };
      logSubAgentDiagnostic("toolStarted", {
        ...toolDiagnosticScope,
        reasonCode: "TOOL_STARTED",
      });
      // 纠错重试复用同一执行上下文（checkpoint / 白名单 / 流式卡片）。
      const runMcpTool = (argsJson: string) =>
        window.snow.callMcpTool(
          subToolCall.name,
          argsJson,
          dirId,
          [
            ...parentCheckpointIdsRef.current,
            ...(activeCheckpointId ? [activeCheckpointId] : []),
          ],
          activeCheckpointWorkDir,
          subSensitiveAuthorizationToken,
          (chunk) => {
            if (!chunk.data) {
              return;
            }
            if (
              chunk.stream === "interactive_session" ||
              chunk.stream === "tool_execution"
            ) {
              ctx.updateSessionMessages(subConvId, (currentMessages) =>
                currentMessages.map((currentMessage) => {
                  if (currentMessage.id !== subAssistantMessageId) {
                    return currentMessage;
                  }
                  return {
                    ...currentMessage,
                    toolCalls: updateFirstMatchingToolCall(
                      currentMessage.toolCalls,
                      subToolCall,
                      ["pending", "running"],
                      (currentToolCall) => ({
                        ...currentToolCall,
                        interactiveSessionId:
                          chunk.stream === "interactive_session"
                            ? chunk.data
                            : currentToolCall.interactiveSessionId,
                        toolExecutionId:
                          chunk.stream === "tool_execution"
                            ? chunk.data
                            : currentToolCall.toolExecutionId,
                      }),
                    ),
                  };
                }),
              );
              return;
            }
            ctx.updateSessionMessages(subConvId, (currentMessages) =>
              currentMessages.map((currentMessage) => {
                if (currentMessage.id !== subAssistantMessageId) {
                  return currentMessage;
                }
                return {
                  ...currentMessage,
                  toolCalls: updateFirstMatchingToolCall(
                    currentMessage.toolCalls,
                    subToolCall,
                    ["pending", "running"],
                    (currentToolCall) => ({
                      ...currentToolCall,
                      streamingStdout:
                        chunk.stream === "stdout"
                          ? `${currentToolCall.streamingStdout ?? ""}${
                              chunk.data
                            }`
                          : currentToolCall.streamingStdout,
                      streamingStderr:
                        chunk.stream === "stderr"
                          ? `${currentToolCall.streamingStderr ?? ""}${
                              chunk.data
                            }`
                          : currentToolCall.streamingStderr,
                    }),
                  ),
                };
              }),
            );
          },
          subToolCall.interactionId,
          allowedTools,
          // 会话溯源：子代理内 memory-save 溯源到子代理会话（删除主会话
          // 时级联子会话一并清理）。
          subConvId,
        );
      let subResult: string;
      let subToolErrored = false;
      try {
        const validationFailure = validateToolCall(subToolCall);
        if (validationFailure) {
          subResult = validationFailure;
        } else if (SUB_AGENT_COMMS_TOOL_NAMES.has(subToolCall.name)) {
          // Owner and request identity are captured by the host, never model-supplied.
          subResult = await executeSubAgentCommsTool(
            subToolArgs,
            subToolCall.interactionId
              ? `peer:${subToolCall.interactionId}`
              : "",
          );
        } else {
          const executeTool = () => runMcpTool(subToolArgs);
          if (subToolCall.name === "user-interaction-askUserQuestion") {
            ctx.userQuestionTargetRef.current.set(subToolCall.interactionId, {
              sessionKey: subConvId,
              assistantMessageId: subAssistantMessageId,
            });
            try {
              subResult = await withWaiting("question", executeTool);
            } finally {
              ctx.userQuestionTargetRef.current.delete(
                subToolCall.interactionId,
              );
            }
          } else subResult = await executeTool();
        }
      } catch (err) {
        subToolErrored = true;
        const errorMessage = getErrorMessage(err);
        if (isSubCancelled()) {
          stopped = true;
          // Cancellation remains cancellation; do not assign a tool failure.
        } else {
          // Tool errors raised by the host (invalid arguments, missing files,
          // MCP errors) are returned to the model as a failed result, the same
          // as the main loop, so the next round can repair the call itself.
          logSubAgentDiagnostic("recovery", {
            ...toolDiagnosticScope,
            reasonCode: "TOOL_EXECUTION_FAILED",
            decision: "continue",
            elapsedMs: Math.max(0, Date.now() - toolStartedAt),
          });
        }
        subResult = JSON.stringify({ success: false, error: errorMessage });
      }
      // Returned failures and rejected invocations use the same visible/evidence
      // status. The correction agent may repair the arguments first; otherwise
      // the model's next round decides how to recover.
      subToolErrored = subToolErrored || detectToolFailure(subResult) !== null;
      if (subToolErrored && subToolCall.name === "bash-terminal-execute") {
        const liveTool = ctx.sessionsRef.current?.[subConvId]?.messages
          .find((message) => message.id === subAssistantMessageId)
          ?.toolCalls?.find(
            (call) =>
              call.interactionId === subToolCall.interactionId &&
              call.name === subToolCall.name,
          );
        subResult = withSubAgentTerminalFailureOutput(
          subResult,
          liveTool?.streamingStdout ?? "",
          liveTool?.streamingStderr ?? "",
        );
      }
      // 失败调用交给纠错 Agent 修正参数并重新执行（与主会话一致，最多 3 次）。
      let subEffectiveArgs = subToolArgs;
      let subCorrectionReasoning: string | undefined;
      if (
        subToolErrored &&
        !isSubCancelled() &&
        !isForceSendInterrupted() &&
        !SUB_AGENT_COMMS_TOOL_NAMES.has(subToolCall.name)
      ) {
        const failedResult = subResult;
        const corrected = await correctFailedToolCall({
          toolCall: subToolCall,
          failedResult,
          apiProfile: runtimeConfig.apiProfile,
          conversationId: subConvId,
          responseId: subResponse.id || undefined,
          getToolDefinition,
          authorize: async (authorizationCall) => {
            const [decision] = await requestToolAuthorizations(
              [authorizationCall],
              subConvId,
              dirId,
              (confirm) => withWaiting("authorization", confirm),
            );
            return decision?.status === "approved";
          },
          execute: (argumentsJson) =>
            runMcpTool(
              injectSessionIdIntoToolArgs(
                subToolCall.name,
                argumentsJson,
                subConvId,
              ),
            ),
          onUpdate: (correction) =>
            ctx.updateSessionMessages(subConvId, (currentMessages) =>
              currentMessages.map((currentMessage) =>
                currentMessage.id === subAssistantMessageId
                  ? {
                      ...currentMessage,
                      toolCalls: updateFirstMatchingToolCall(
                        currentMessage.toolCalls,
                        subToolCall,
                        ["pending", "running", "completed", "error"],
                        (currentToolCall) =>
                          applyToolCorrectionToCall(
                            currentToolCall,
                            correction,
                            false,
                            failedResult,
                          ),
                      ),
                    }
                  : currentMessage,
              ),
            ),
          isCancelled: () => isSubCancelled() || isForceSendInterrupted(),
        });
        if (corrected) {
          subResult = corrected.result;
          subToolErrored = false;
          subEffectiveArgs = injectSessionIdIntoToolArgs(
            subToolCall.name,
            corrected.arguments,
            subConvId,
          );
          subCorrectionReasoning = corrected.reasoning;
        }
      }
      logSubAgentDiagnostic("toolCompleted", {
        ...toolDiagnosticScope,
        reasonCode: isSubCancelled()
          ? "RUN_CANCELLED"
          : subToolErrored
            ? "TOOL_EXECUTION_FAILED"
            : "TOOL_COMPLETED",
        elapsedMs: Math.max(0, Date.now() - toolStartedAt),
        emptyText:
          !subToolErrored &&
          isSubAgentEmptyTextRead(subToolCall.name, subResult),
      });

      ctx.updateSessionMessages(subConvId, (currentMessages) =>
        currentMessages.map((currentMessage) => {
          if (currentMessage.id !== subAssistantMessageId) {
            return currentMessage;
          }
          return {
            ...currentMessage,
            toolCalls: updateFirstMatchingToolCall(
              currentMessage.toolCalls,
              subToolCall,
              ["pending", "running"],
              (currentToolCall) => ({
                ...currentToolCall,
                status: subToolErrored
                  ? ("error" as const)
                  : ("completed" as const),
                result: subResult,
              }),
            ),
          };
        }),
      );

      // Record successful file modifications made by this sub-agent under
      // its own conversationId AND the parent conversationId. Storing
      // under the parent key lets the file-change stats panel show the
      // full picture (main agent + sub-agents) without extra lookups;
      // the sub-agent's own key keeps its per-session view accurate.
      if (subResult !== undefined) {
        const timestamp = Date.now();
        const coverage = extractFileChangeCoverageFromTool(
          subToolCall.name,
          subResult,
        );
        if (coverage) {
          const record = {
            ...coverage,
            agent: "sub" as const,
            subAgentName: agentName,
            timestamp,
          };
          ctx.recordFileChangeCoverage(subConvId, record);
          ctx.recordFileChangeCoverage(parentConversationId, record);
        }
        const subFileChanges = extractFileChangesFromTool(
          subToolCall.name,
          subEffectiveArgs,
          subResult,
        );
        for (const subFileChange of subFileChanges) {
          const subChangeRecord = {
            ...subFileChange,
            agent: "sub" as const,
            subAgentName: agentName,
            timestamp: Date.now(),
          };
          ctx.recordFileChange(subConvId, subChangeRecord);
          ctx.recordFileChange(parentConversationId, subChangeRecord);
        }
      }

      const subBaseModelResult = formatMcpToolResultForModel(subResult);
      const subModelResult = withSubAgentEvidence(
        subConvId,
        subToolCall.name,
        subToolCall.callId,
        subToolErrored ? "error" : "completed",
        subResult,
        subCorrectionReasoning === undefined
          ? subBaseModelResult
          : appendToolCorrectionNote(
              subBaseModelResult,
              subCorrectionReasoning,
            ),
      );
      subToolResults.push(subModelResult);
      subStructuredResults.push({
        name: subToolCall.name,
        callId: subToolCall.callId || "",
        result: subModelResult,
      });

      if (stopped || isSubCancelled()) {
        break;
      }
    }

    const skipped = recordSkippedSubAgentTools(
      ctx,
      subConvId,
      subAssistantMessageId,
      dispatchToolCalls.slice(subStructuredResults.length),
      (call, result) =>
        withSubAgentEvidence(
          subConvId,
          call.name,
          call.callId,
          "rejected",
          result,
          formatMcpToolResultForModel(result),
        ),
    );
    subStructuredResults.push(...skipped);
    subToolResults.push(...skipped.map((tool) => tool.result));

    const subToolResultMessage: ChatConversationMessage = {
      id: createMessageId("tool"),
      role: "tool",
      content: formatToolResultsContent(subStructuredResults),
      timestamp: formatMessageTime(),
      status: "sent",
      toolName: subToolCalls.map((tc) => tc.name).join(", "),
    };

    ctx.updateSessionMessages(subConvId, (currentMessages) => [
      ...currentMessages,
      subToolResultMessage,
    ]);

    if (isSubCancelled()) {
      stopped = true;
      return "Sub-agent interrupted by user";
    }
    // Permission and fatal gates take precedence over the next model round.
    // A force-send interruption also rejects pending authorizations; that is
    // not a permission failure.
    if (!stopped && subAllToolsRejected && !subHasContinuableRejection) {
      stopped = true;
      onExecutionError({
        category: "permission",
        code: "PERMISSION_DENIED",
        message: "All delegated tool authorizations were rejected",
        retryable: false,
      });
      logSubAgentDiagnostic("fatal", {
        ...diagnosticScope,
        reasonCode: "PERMISSION_DENIED",
        decision: "stop",
      });
      return subToolResults.join("\n\n");
    }

    if (stopped) return subToolResults.join("\n\n");
    const subToolResultsJson = JSON.stringify(subStructuredResults);
    const subNextMessages: {
      role: "user" | "assistant" | "system" | "developer" | "tool";
      content: string;
      toolResultsJson?: string;
    }[] = [
      {
        role: "tool",
        content: formatToolResultsContent(subStructuredResults),
        toolResultsJson: subToolResultsJson,
      },
    ];
    subNextMessages.push(...(await consumeSteering()));

    return subAgentRunLoop(subNextMessages);
  };

  // The recursive loop is one complete task; only this outer owner drains
  // follow-ups, keeping isSending true until the terminal finalizer.
  return async (messages, resumeAfterCompaction = false): Promise<string> => {
    activeCheckpointId = undefined;
    activeCheckpointWorkDir = subCheckpointWorkDir;
    let nextMessages = messages;
    let summary = "";
    let resume = resumeAfterCompaction;
    let prepared =
      ctx.sessionsRefData.current.get(subConvId)?.activeTaskMessages ===
      messages;
    try {
      while (true) {
        const ref = ctx.sessionsRefData.current.get(subConvId);
        if (!ref || isSubCancelled()) return summary;
        if (!prepared) {
          demotePendingSteering(ctx, subConvId);
          ref.runId += 1;
        }
        prepared = false;
        ref.activeSendOptions = { ...sendOptions };
        ref.activeTaskMessages = nextMessages
          .filter((message) => message.role === "user")
          .map((message) => ({ role: "user", content: message.content }));
        stopped = false;
        summary = await subAgentRunLoop(nextMessages, resume);
        resume = false;
        if (stopped || isSubCancelled()) return summary;
        demotePendingSteering(ctx, subConvId);
        while (true) {
          const head = ctx.pendingQueueRef.current.get(subConvId)?.[0];
          if (!head || retainedPending.has(head)) return summary;
          if (!supportsQueuedOptions(head.options)) {
            const note =
              "Queued message retained in this sub-agent: its requested configuration is not supported by this delegated runtime. Withdraw it or resume with compatible options.";
            ctx.updateSessionMessages(subConvId, (currentMessages) => [
              ...currentMessages,
              {
                id: createMessageId("assistant"),
                role: "assistant",
                content: note,
                timestamp: formatMessageTime(),
                status: "sent",
              },
            ]);
            return `${summary}\n\n${note}`;
          }
          const checkpointId = await createPendingCheckpoint();
          const current = ctx.pendingQueueRef.current.get(subConvId)?.[0];
          if (isSubCancelled() || current !== head) {
            if (checkpointId) deleteCheckpoints([checkpointId]);
            if (isSubCancelled()) return summary;
            continue;
          }
          const item = takeNextQueuedMessage(ctx, subConvId);
          if (!item) {
            if (checkpointId) deleteCheckpoints([checkpointId]);
            return summary;
          }
          ref.activeTaskMessages = [];
          nextMessages = appendPendingUsers([item.text], checkpointId);
          break;
        }
      }
    } catch (error) {
      stopped = true;
      const cancelled = isSubCancelled();
      const forceSendAbort =
        !!ctx.sessionsRefData.current.get(subConvId)?.forceSendAbort;
      const errorMessage = cancelled
        ? forceSendAbort
          ? ""
          : "Sub-agent interrupted by user"
        : modelFailureReason();
      ctx.updateSessionMessages(subConvId, (currentMessages) =>
        currentMessages.map((currentMessage) =>
          currentMessage.role === "assistant" &&
          currentMessage.status === "sending"
            ? {
                ...currentMessage,
                content: cancelled
                  ? currentMessage.content || errorMessage
                  : currentMessage.content,
                // Raw rejections are not provider-normalized diagnostic metadata.
                failureReason: undefined,
                htmlPreviewEligible: false,
                timestamp: formatMessageTime(),
                status: cancelled ? "sent" : "error",
                isThinkingActive: false,
                isRetrying: false,
                retryAttempt: undefined,
                retryError: undefined,
                toolCalls: undefined,
              }
            : currentMessage,
        ),
      );
      if (cancelled) return errorMessage;
      throw error;
    } finally {
      demotePendingSteering(ctx, subConvId);
    }
  };
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** 用户强行发送的循环处理工厂（sendPendingMessageNow 已 handleAbort 中断当前
 * 回合并把消息暂存到会话的 forceSendMessages）：复用自动发送路径 —— 暂存
 * 消息作为新回合继续在本子代理会话处理，保持子代理的模型/API 配置/工具集/
 * 系统提示，绝不转交父会话、也绝不走主流程 handleSendMessage（那会把子代理
 * 当成主会话发送，还会被侧边栏 upsert 成"新主会话"）。直到没有新的强行
 * 发送为止。 */
const createRunForceSendLoop = (
  ctx: ConversationContextValue,
  subConvId: string,
  subAgentRunLoop: SubAgentRunLoop,
  canContinue: () => boolean,
): (() => Promise<string>) => {
  return async (): Promise<string> => {
    let lastSummary = "";
    while (true) {
      // A fatal run must settle before any further queued input is consumed.
      if (!canContinue()) return lastSummary;
      const ref = ctx.sessionsRefData.current.get(subConvId);
      const forceSends = ref?.forceSendMessages;
      if (!forceSends || forceSends.length === 0) {
        return lastSummary;
      }
      ref!.forceSendMessages = undefined;
      const forceSendText = forceSends.map((item) => item.text).join("\n\n");
      const forceUserMsg: ChatConversationMessage = {
        id: createMessageId("user"),
        role: "user",
        content: forceSendText,
        timestamp: formatMessageTime(),
        status: "sent",
      };
      ctx.updateSessionMessages(subConvId, (currentMessages) => [
        ...currentMessages,
        forceUserMsg,
      ]);
      // handleAbort 已复位运行状态：新一轮回合必须恢复
      // isSending/isAbortRequested/流式标记（与子代理激活时的
      // 初始化一致），handleAbort 与暂停检查才能正常工作。
      const runRef = ctx.sessionsRefData.current.get(subConvId);
      if (runRef) {
        runRef.isSending = true;
        runRef.isAbortRequested = false;
        runRef.forceSendAbort = false;
      }
      ctx.updateSessionField(subConvId, "isStreaming", true);
      resetRunStreamMetrics(ctx, subConvId);
      markRunStarted(ctx, subConvId);
      ctx.addStreamingId(subConvId);
      lastSummary = await subAgentRunLoop([
        { role: "user", content: forceSendText },
      ]);
    }
  };
};

/** 子代理收尾时保留本会话的 Pending 队列，并将未消费 steer 降级为 queue。 */
const createForwardSubPendingQueue = (
  ctx: ConversationContextValue,
  parentConversationId: string,
): ((finishedSubConvId: string) => void) => {
  // Legacy factory name retained; pending tasks belong to the sub-session,
  // including on abort/error. Never transfer their authority to the parent.
  void parentConversationId;
  return (finishedSubConvId: string): void => {
    demotePendingSteering(ctx, finishedSubConvId);
    refreshPendingMessages(ctx, finishedSubConvId);
  };
};

type RunOptions = {
  executionMode: SubAgentExecutionMode;
  requestId?: string;
  interactionId?: string;
  taskHistory?: ReturnType<typeof currentAgentTask>;
  requestInput?: SubAgentLogicalInput;
};
type PreparedRun = {
  deps: SubAgentActivationDeps;
  scope: SubAgentRunScope;
  conversationId: string;
  operation: "activate" | "continue";
  runtimeConfig: SubAgentRuntimeConfig;
  snapshot: SubAgentExecutionSnapshot;
  summary: string;
  prompt: string;
  checkpointIds: string[];
  taskHistory: ReturnType<typeof currentAgentTask>;
  options: RunOptions;
};

const parseRunOptions = (
  args: Record<string, unknown>,
  operation: "activate" | "continue",
  interactionId?: string,
): RunOptions => {
  const executionMode = args.executionMode;
  if (executionMode !== "sync" && executionMode !== "async")
    throw new Error("VALIDATION_ERROR: executionMode must be sync or async");
  if (
    args.requestId !== undefined &&
    (typeof args.requestId !== "string" ||
      !args.requestId.trim() ||
      args.requestId.length > 160)
  )
    throw new Error(
      "VALIDATION_ERROR: requestId must contain 1..160 characters",
    );
  const requestId =
    typeof args.requestId === "string"
      ? args.requestId
      : interactionId
        ? `${operation}:${interactionId}`
        : undefined;
  if (requestId && requestId.length > 160)
    throw new Error(
      "VALIDATION_ERROR: derived requestId exceeds 160 characters",
    );
  const hostInteractionId =
    interactionId ??
    (requestId?.startsWith(`${operation}:`)
      ? requestId.slice(operation.length + 1)
      : requestId);
  return {
    executionMode,
    requestId,
    interactionId: hostInteractionId,
  };
};
const requirePersistence = (
  persistence: SubAgentRunPersistence | undefined,
): SubAgentRunPersistence => {
  if (!persistence)
    throw new Error(
      "PERSISTENCE_ERROR: durable sub-agent run persistence is not connected",
    );
  return persistence;
};

/** Ordinary conversations may dispatch in either mode; workflow nodes run inside
 *  a blocking workflow and may only dispatch synchronously. */
const requireSubAgentParent = async (
  scope: SubAgentRunScope,
  executionMode?: SubAgentExecutionMode,
): Promise<void> => {
  if (!scope.projectId.trim())
    throw new Error(
      "UNSUPPORTED_EXECUTION_MODE: sub-agent dispatch requires a project-bound parent",
    );
  const parent = await window.snow.getChatConversation(
    scope.parentConversationId,
  );
  if (!parent)
    throw new Error("RUN_NOT_FOUND: parent conversation does not exist");
  if (parent.directoryId !== scope.projectId)
    throw new Error(
      "PERMISSION_DENIED: parent project does not match dispatch scope",
    );
  if (parent.conversationType === "workflow_node") {
    if (executionMode === "async")
      throw new Error(
        'UNSUPPORTED_EXECUTION_MODE: workflow nodes support synchronous sub-agents only; retry with executionMode "sync"',
      );
    return;
  }
  if (parent.conversationType !== "main" || parent.parentConversationId)
    throw new Error(
      "UNSUPPORTED_EXECUTION_MODE: sub-agent dispatch requires an ordinary parent conversation or a workflow node",
    );
};

/** Hold preparation, not a successful-result cache; failures always release the key. */
const subAgentRequestPreparations = new Map<
  string,
  { input: string; promise: Promise<string> }
>();
const replaySubAgentReceipt = async (
  persistence: SubAgentRunPersistence,
  scope: SubAgentRunScope,
  receipt: SubAgentAccepted | SubAgentMessageQueued,
): Promise<string> => {
  const executionMode = receipt.executionMode;
  if (executionMode !== "sync" && executionMode !== "async")
    throw new Error(
      "PERSISTENCE_ERROR: receipt has no captured execution mode",
    );
  if (executionMode === "async")
    return JSON.stringify({ ...receipt, executionMode, created: false });
  if (receipt.kind === "accepted") {
    const result = JSON.parse(
      await awaitSettledSubAgentResult(persistence, scope, receipt.runId),
    );
    return JSON.stringify(result);
  }
  return JSON.stringify({
    ...receipt,
    executionMode,
    created: false,
  });
};
const prepareLogicalSubAgentRequest = async (
  persistence: SubAgentRunPersistence | undefined,
  scope: SubAgentRunScope,
  options: RunOptions,
  requestInput: SubAgentLogicalInput,
  prepare: () => Promise<string>,
): Promise<string> => {
  persistence = requirePersistence(persistence);
  const requestId = options.requestId;
  if (!requestId)
    throw new Error(
      "VALIDATION_ERROR: durable dispatch requires a stable host requestId",
    );
  const key = JSON.stringify([
    scope.projectId,
    scope.parentConversationId,
    requestInput.operation,
    requestId,
  ]);
  const { executionMode: _derivedMode, ...businessInput } = requestInput;
  const input = JSON.stringify(businessInput);
  const existing = subAgentRequestPreparations.get(key);
  if (existing) {
    if (existing.input !== input)
      throw new Error(
        "REQUEST_CONFLICT: requestId is already preparing a different logical input",
      );
    // The original promise has already applied its captured mode; never reinterpret its result.
    return existing.promise;
  }
  const promise = Promise.resolve().then(async () => {
    const result = await persistence.command({
      op: "lookup_request",
      scope,
      requestId,
      requestInput,
    });
    if (result.kind !== "request")
      throw new Error(
        "PERSISTENCE_ERROR: lookup_request returned an unexpected receipt",
      );
    if (result.receipt)
      return replaySubAgentReceipt(persistence, scope, result.receipt);
    return prepare();
  });
  const entry = { input, promise };
  subAgentRequestPreparations.set(key, entry);
  try {
    return await promise;
  } finally {
    if (subAgentRequestPreparations.get(key) === entry)
      subAgentRequestPreparations.delete(key);
  }
};

/** A hook decision has a real card resolver; it is never silently treated as pass. */
const executeSubAgentHook = async (
  ctx: ConversationContextValue,
  prepared: Pick<
    PreparedRun,
    | "scope"
    | "conversationId"
    | "runtimeConfig"
    | "snapshot"
    | "prompt"
    | "options"
  >,
  hookType: "beforeSubAgentStart" | "onSubAgentComplete",
  summary?: string,
  wait?: SubAgentRunLoopDeps["withWaiting"],
): Promise<SubAgentHookOutcome> => {
  const result = await runHook(
    hookType,
    prepared.scope.projectId,
    JSON.stringify({
      agentId: prepared.runtimeConfig.agentId,
      agentName: prepared.runtimeConfig.agentName,
      prompt: prepared.prompt,
      summary,
      parentConversationId: prepared.scope.parentConversationId,
      cwd: prepared.snapshot.workspacePath,
    }),
  );
  if (!result) return { kind: "none" };
  let decide: Promise<boolean> | undefined;
  let decisionId: string | undefined;
  let resolveDecision: ((approved: boolean) => void) | undefined;
  if (result.outcome.kind === "needsDecision") {
    decisionId = crypto.randomUUID();
    const id = decisionId;
    decide = new Promise<boolean>((resolve) => {
      resolveDecision = (approved) => {
        ctx.pendingHookDecisionRef.current.delete(id);
        resolve(approved);
      };
      ctx.pendingHookDecisionRef.current.set(id, {
        sessionKey:
          hookType === "beforeSubAgentStart"
            ? prepared.scope.parentConversationId
            : prepared.conversationId,
        resolve: resolveDecision,
      });
    });
  }
  ctx.updateSessionMessages(prepared.scope.parentConversationId, (messages) =>
    appendHookExecutionToMessage(messages, {
      ...result.record,
      toolCallInteractionId: prepared.options.interactionId,
      _decisionId: decisionId,
      _resolveDecision: resolveDecision,
    }),
  );
  if (decide) {
    try {
      const approved = wait
        ? await wait("hook_decision", () => decide!)
        : await decide;
      return approved
        ? { kind: "success" }
        : { kind: "abort", message: "Sub-agent hook decision was rejected" };
    } finally {
      if (decisionId) ctx.pendingHookDecisionRef.current.delete(decisionId);
    }
  }
  if (result.outcome.kind === "pass")
    return { kind: "success", message: result.outcome.context ?? undefined };
  if (result.outcome.kind === "abort")
    return { kind: "abort", message: result.outcome.message };
  return { kind: "warn", message: result.outcome.message };
};

/** Stops only resources belonging to the captured sub-session, never the selected chat. */
const stopSubAgentResources = async (
  ctx: ConversationContextValue,
  conversationId: string,
  ownerId: string,
  markAborted = true,
): Promise<void> => {
  const ref = ctx.sessionsRefData.current.get(conversationId);
  if (ref && markAborted) ref.isAbortRequested = true;
  cancelSubAgentRunWaits(ownerId);
  for (const [id, pending] of ctx.pendingToolAuthorizationRef.current) {
    if (pending.toolCall.authorizationConversationId !== conversationId)
      continue;
    ctx.pendingToolAuthorizationRef.current.delete(id);
    pending.resolve({ status: "rejected", reason: "Sub-agent run cancelled" });
  }
  for (const [id, pending] of ctx.pendingUserQuestionRef.current) {
    if (pending.sessionKey !== conversationId) continue;
    ctx.pendingUserQuestionRef.current.delete(id);
    pending.reject(new Error("Sub-agent run cancelled"));
  }
  for (const [id, pending] of ctx.pendingHookDecisionRef.current) {
    if (pending.sessionKey !== conversationId) continue;
    ctx.pendingHookDecisionRef.current.delete(id);
    pending.resolve(false);
  }
  const pause = ctx.pauseControllerRef.current.get(conversationId);
  if (pause) {
    pause.paused = false;
    pause.resolve?.();
    ctx.pauseControllerRef.current.delete(conversationId);
  }
  const ids = new Set<string>();
  for (const message of ctx.sessionsRef.current[conversationId]?.messages ??
    []) {
    for (const call of message.toolCalls ?? []) {
      if (
        (call.status === "pending" || call.status === "running") &&
        call.toolExecutionId
      )
        ids.add(call.toolExecutionId);
    }
  }
  const results = await Promise.allSettled([
    ...(ref?.streamId ? [window.snow.abortResponseStream(ref.streamId)] : []),
    ...Array.from(ids, (id) => window.snow.abortToolExecution(id)),
  ]);
  const errors = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason as unknown] : [],
  );
  if (errors.length)
    throw new AggregateError(errors, "Sub-agent resource cancellation failed");
};

type RunState = {
  run?: SubAgentRunRecord;
  error?: SubAgentRunError;
  cancelled: boolean;
  finalizing: boolean;
};

/** One finalizer per run, with one retained promise, shared by sync and async. */
const createSubAgentFinalizer = (
  prepared: PreparedRun,
  state: RunState,
  withWaiting: SubAgentRunLoopDeps["withWaiting"],
  transition: (
    from: SubAgentRunRecord["status"][],
    to: SubAgentRunRecord["status"],
    reason?: SubAgentRunRecord["waitingReason"],
  ) => Promise<boolean>,
  publish: (run: SubAgentRunRecord) => void,
  ownerId: string,
): ((summary: string) => Promise<string>) => {
  const logSettled = (status: SubAgentRunRecord["status"]): void => {
    const startedAt = prepared.deps.ctx.sessionsRefData.current.get(
      prepared.conversationId,
    )?.runStartedAt;
    logSubAgentDiagnostic("runSettled", {
      runId: ownerId,
      conversationId: prepared.conversationId,
      parentConversationId: prepared.scope.parentConversationId,
      reasonCode:
        status === "cancelled"
          ? "RUN_CANCELLED"
          : status === "completed"
            ? "RUN_COMPLETED"
            : "RUN_FAILED",
      decision:
        status === "cancelled"
          ? "cancelled"
          : status === "completed"
            ? "completed"
            : "failed",
      elapsedMs: startedAt ? Math.max(0, Date.now() - startedAt) : undefined,
      cancellation: state.run?.cancellation,
    });
  };
  let finalizing: Promise<string> | undefined;
  const finalize = async (summary: string): Promise<string> => {
    const {
      deps: { ctx },
      scope,
      conversationId,
      runtimeConfig,
    } = prepared;
    const runPersistence = requirePersistence(prepared.deps.runPersistence);
    if (!state.run)
      throw new Error(
        "PERSISTENCE_ERROR: run hydration failed before settlement",
      );
    let acceptance: SubAgentAcceptanceSnapshot | null = null;
    if (hasSubAgentAcceptance(conversationId)) {
      const report = parseSubAgentAcceptanceReport(summary);
      acceptance = report.report
        ? applySubAgentAcceptanceReport(conversationId, report.report)
        : noteSubAgentAcceptanceReportMissing(conversationId, report.invalid);
      if (report.report || report.invalid) summary = report.stripped;
    }

    if (state.cancelled && !isSubAgentTerminal(state.run.status)) {
      const receipt = await runPersistence.command({
        op: "cancel",
        scope,
        runId: state.run.runId,
        source: "runtime_abort",
      });
      if (receipt.kind !== "cancel")
        throw new Error(
          "PERSISTENCE_ERROR: cancel returned an unexpected receipt",
        );
      state.run = (
        await readSubAgentRunResult(runPersistence, scope, state.run.runId)
      ).run;
      if (receipt.disposition === "too_late") state.cancelled = false;
    }
    if (isSubAgentTerminal(state.run.status)) {
      publish(state.run);
      logSettled(state.run.status);
      return settledResult(state.run);
    }
    if (state.run.status === "cancelling") state.cancelled = true;
    if (!state.cancelled && state.run.status !== "queued") {
      const won = await transition(["running", "waiting_input"], "finalizing");
      if (!won) {
        if (state.run.status === "cancelling") state.cancelled = true;
        else if (isSubAgentTerminal(state.run.status)) {
          logSettled(state.run.status);
          return settledResult(state.run);
        } else
          throw new Error(
            "INVALID_TRANSITION: completion did not acquire finalizing ownership",
          );
      } else state.finalizing = true;
    }

    let hookOutcome: SubAgentHookOutcome = { kind: "none" };
    if (!state.cancelled && !state.error && state.finalizing) {
      try {
        hookOutcome = await executeSubAgentHook(
          ctx,
          prepared,
          "onSubAgentComplete",
          summary,
          withWaiting,
        );
        if (hookOutcome.kind === "abort")
          state.error = runError("hook", "HOOK_ABORTED", hookOutcome.message);
        else if (hookOutcome.message)
          summary += `

[Hook ${hookOutcome.kind === "warn" ? "Warning" : "Context"}]
${hookOutcome.message}`;
      } catch (error) {
        hookOutcome = { kind: "failed", message: getErrorMessage(error) };
        state.error = runError("hook", "HOOK_EXECUTION_FAILED", error);
      }
    }
    const ref = ctx.sessionsRefData.current.get(conversationId);
    const startedAt = ref?.runStartedAt;
    if (startedAt) {
      const duration = Math.max(0, Date.now() - startedAt);
      const usage = ref.runTokenUsage;
      accumulateConversationRunStats(
        ctx,
        conversationId,
        usage,
        duration,
        ref.runTtftSumMs ?? 0,
        ref.runRequestCount ?? 0,
      );
      try {
        await window.snow.setConversationRunStats(
          conversationId,
          usage?.inputTokens ?? 0,
          usage?.outputTokens ?? 0,
          usage?.cacheCreationInputTokens ?? 0,
          usage?.cacheReadInputTokens ?? 0,
          duration,
          ref.runTtftSumMs ?? 0,
          ref.runRequestCount ?? 0,
        );
      } catch (error) {
        state.error = runError("persistence", "PERSISTENCE_ERROR", error);
        logSubAgentDiagnostic("fatal", {
          runId: ownerId,
          conversationId,
          parentConversationId: scope.parentConversationId,
          reasonCode: "PERSISTENCE_ERROR",
          decision: "stop",
        });
      }
    }
    const terminalStatus = state.cancelled
      ? "cancelled"
      : state.error
        ? "failed"
        : "completed";
    let outcome: SubAgentOutcome | undefined;

    const run = state.run;
    if (!run)
      throw new Error(
        "PERSISTENCE_ERROR: run hydration failed before settlement",
      );
    outcome = {
      version: 1,
      runId: run.runId,
      conversationId,
      parentConversationId: scope.parentConversationId,
      parentTaskId: run.parentTaskId,
      terminalStatus,
      summary,
      error: state.error,
      ...(acceptance
        ? { acceptance, acceptanceSatisfied: acceptance.satisfied }
        : {}),
      unavailableTools: runtimeConfig.unavailableTools ?? [],
      hookOutcome,
      acceptedAt: run.acceptedAt,
      startedAt: run.startedAt,
      completedAt: Date.now(),
    };
    const result = await runPersistence.command({
      op: "settle",
      scope,
      runId: run.runId,
      outcome,
    });
    if (result.kind !== "settled")
      throw new Error(
        "PERSISTENCE_ERROR: settle returned an unexpected receipt",
      );
    state.run = result.run;
    if (!isSubAgentTerminal(result.run.status))
      throw new Error(
        "PERSISTENCE_ERROR: settle did not return a terminal run",
      );
    // Only durable facts are published; failed settlement never looks completed.
    if (result.committed) publish(result.run);
    logSettled(result.run.status);
    return settledResult(result.run);
  };
  return (summary) => (finalizing ??= finalize(summary));
};

const finishSubAgentSession = (
  prepared: PreparedRun,
  ownerId: string,
  run: SubAgentRunRecord,
): void => {
  const {
    deps: { ctx },
    conversationId,
    scope,
    runtimeConfig,
  } = prepared;
  if (subAgentSessionOwners.get(conversationId) !== ownerId) return;
  const ref = ctx.sessionsRefData.current.get(conversationId);
  if (ref) {
    ref.subAgentTerminated = true;
    ref.isSending = false;
    ref.streamId = null;
    ref.streamPromise = null;
    ref.activeSendOptions = undefined;
    ref.activeTaskMessages = undefined;
    ref.runStartedAt = 0;
  }
  ctx.updateSessionField(conversationId, "isStreaming", false);
  ctx.updateSessionField(conversationId, "streamStartedAt", 0);
  ctx.updateSessionField(conversationId, "isAborting", false);
  ctx.removeStreamingId(conversationId);
  ctx.setSubAgentSessionEvent({
    parentConversationId: scope.parentConversationId,
    conversationId,
    agentId: runtimeConfig.agentId,
    agentName: runtimeConfig.agentName,
    summary: prepared.summary,
    status:
      run.status === "completed"
        ? "completed"
        : run.status === "cancelled"
          ? "cancelled"
          : "failed",
    timestamp: Date.now(),
    toolCallInteractionId: prepared.options.interactionId,
  });
};

const dispatchPreparedSubAgentRun = async (
  prepared: PreparedRun,
): Promise<string> => {
  const {
    deps,
    scope,
    conversationId,
    runtimeConfig,
    snapshot,
    options,
    taskHistory,
  } = prepared;
  const { ctx } = deps;
  const runPersistence = requirePersistence(deps.runPersistence);
  await requireSubAgentParent(scope, options.executionMode);
  let receipt: SubAgentAccepted;

  if (!snapshot.workspacePath)
    throw new Error(
      "CONFIGURATION_ERROR: durable dispatch requires an actual workspace binding",
    );
  if (
    !options.requestId ||
    !options.interactionId ||
    !options.requestInput ||
    !taskHistory
  )
    throw new Error(
      "VALIDATION_ERROR: durable dispatch requires stable requestId, interactionId and parent task",
    );
  const result = await runPersistence.command({
    op: "accept",
    scope,
    requestId: options.requestId,
    requestInput: options.requestInput,
    operation: prepared.operation,
    conversationId,
    parentTaskId: taskHistory.id,
    interactionId: options.interactionId,
    executionMode: options.executionMode,
    summary: prepared.summary,
    prompt: prepared.prompt,
    snapshot: { ...snapshot, workspacePath: snapshot.workspacePath },
    acceptance: peekSubAgentAcceptanceSnapshot(conversationId) ?? undefined,
  });
  if (result.kind === "message_queued" && prepared.operation === "continue") {
    return JSON.stringify(result);
  }
  if (result.kind !== "accepted")
    throw new Error("PERSISTENCE_ERROR: accept returned an unexpected receipt");
  if (!result.created)
    return replaySubAgentReceipt(runPersistence, scope, result);
  receipt = result;

  const ownerId = receipt.runId;
  const actualConversationId = receipt.conversationId;
  const actual = { ...prepared, conversationId: actualConversationId };
  const state: RunState = { cancelled: false, finalizing: false };
  const capacityAbort = new AbortController();
  let budgetResourceStop: Promise<void> | undefined;
  const budget = createSubAgentBudget(
    {
      maxModelRequests: snapshot.maxModelRequests ?? 128,
      maxActiveDurationMs: snapshot.maxActiveDurationMs ?? 30 * 60 * 1000,
    },
    (error) => {
      state.error = runError("model", error.message.split(":", 1)[0], error);
      capacityAbort.abort();
      budgetResourceStop = stopSubAgentResources(
        ctx,
        actualConversationId,
        ownerId,
        false,
      );
      // A failed terminal result does not imply that external resources drained cleanly.
      retainOwnedSubAgentResourceStop(ownerId, budgetResourceStop);
      void budgetResourceStop.catch((stopError: unknown) => {
        state.error = {
          ...state.error!,
          detail: `Resource stop failed: ${getErrorMessage(stopError)}`,
        };
      });
    },
  );
  const retainedPending = new Set(
    ctx.pendingQueueRef.current.get(actualConversationId) ?? [],
  );
  let sessionInitialized = false;
  const cancelled = (): boolean =>
    !state.finalizing &&
    (state.cancelled ||
      (!budget.error &&
        Boolean(
          ctx.sessionsRefData.current.get(actualConversationId)
            ?.isAbortRequested &&
          !ctx.sessionsRefData.current.get(actualConversationId)
            ?.forceSendAbort,
        )));
  const publish = (run: SubAgentRunRecord): void => {
    runPersistence.onCommitted(run);
    notifySubAgentRunChanges();
  };
  const transition = async (
    from: SubAgentRunRecord["status"][],
    to: SubAgentRunRecord["status"],
    waitingReason?: SubAgentRunRecord["waitingReason"],
  ): Promise<boolean> => {
    const attempt = async () => {
      const result = await runPersistence.command({
        op: "transition",
        scope,
        runId: ownerId,
        from,
        to,
        waitingReason,
      });
      if (result.kind !== "transition")
        throw new Error("PERSISTENCE_ERROR: invalid transition receipt");
      if (!state.run || result.run.version >= state.run.version)
        state.run = result.run;
      if (
        result.run.status === "cancelling" ||
        result.run.status === "cancelled"
      )
        state.cancelled = true;
      return result;
    };
    const result =
      to === "running"
        ? await waitForSubAgentCapacity(
            attempt,
            cancelled,
            capacityAbort.signal,
          )
        : await attempt();
    if (result?.changed) publish(result.run);
    return result?.changed ?? false;
  };
  const withWaiting: SubAgentRunLoopDeps["withWaiting"] = async (
    reason,
    action,
  ) => {
    budget.check();
    if (cancelled())
      throw new Error("RUN_CANCELLED: run was cancelled before decision");
    budget.pause();
    if (
      !state.finalizing &&
      !(await transition(["running"], "waiting_input", reason))
    )
      throw new Error("INVALID_TRANSITION: run cannot enter waiting_input");
    try {
      return await action();
    } finally {
      if (!state.finalizing && !cancelled() && !budget.error) {
        if (!cancelled()) {
          const resumed = await transition(["waiting_input"], "running");
          if (!resumed && !cancelled())
            throw new Error(
              "INVALID_TRANSITION: run cannot resume after decision",
            );
          if (resumed) budget.resume();
        }
      }
    }
  };
  const finalize = createSubAgentFinalizer(
    actual,
    state,
    withWaiting,
    transition,
    publish,
    ownerId,
  );
  registerSubAgentRunControl(ownerId, actualConversationId);
  subAgentSessionOwners.set(actualConversationId, ownerId);
  const promise = startOwnedSubAgentRun(
    ownerId,
    async () => {
      try {
        state.run = (
          await readSubAgentRunResult(runPersistence, scope, ownerId)
        ).run;
        if (isSubAgentTerminal(state.run.status)) {
          publish(state.run);
          finishSubAgentSession(actual, ownerId, state.run);
          logSubAgentDiagnostic("runSettled", {
            runId: ownerId,
            conversationId: actualConversationId,
            parentConversationId: scope.parentConversationId,
            reasonCode:
              state.run.status === "cancelled"
                ? "RUN_CANCELLED"
                : state.run.status === "completed"
                  ? "RUN_COMPLETED"
                  : "RUN_FAILED",
            cancellation: state.run.cancellation,
          });
          return settledResult(state.run);
        }

        let summary = "";
        try {
          if (prepared.operation === "activate")
            await inheritConversationWorktreeBinding(
              scope.parentConversationId,
              actualConversationId,
              scope.projectId,
              snapshot.worktreeMode,
            );
          const boundWorkspace = await resolveConversationWorkspacePath(
            actualConversationId,
            scope.projectId,
            snapshot.workspacePath,
            snapshot.worktreeMode,
          );
          if (boundWorkspace !== snapshot.workspacePath)
            throw new Error(
              "CONFIGURATION_ERROR: sub-agent workspace binding changed after dispatch",
            );
          ctx.ensureSession(actualConversationId, scope.projectId);
          const ref = ctx.sessionsRefData.current.get(actualConversationId);
          if (!ref)
            throw new Error(
              "CONFIGURATION_ERROR: sub-agent runtime session is unavailable",
            );
          ref.subAgentTerminated = false;
          ref.isSending = true;
          ref.isAbortRequested = state.cancelled;
          ref.goalMode = false;
          ref.worktreeMode = snapshot.worktreeMode;
          demotePendingSteering(ctx, actualConversationId);
          ref.runId += 1;
          const messages = [
            { role: "user" as const, content: prepared.prompt },
          ];
          ref.activeTaskMessages = messages;
          ref.activeSendOptions = {
            apiProfile: runtimeConfig.apiProfile,
            model: runtimeConfig.model,
            thinkingStrength: runtimeConfig.effectiveThinkingStrength,
            responsesFastMode: runtimeConfig.effectiveResponsesFastMode,
          };
          ctx.sessionsRefData.current
            .get(scope.parentConversationId)
            ?.childSubAgentIds.add(actualConversationId);
          sessionInitialized = true;
          ctx.updateSessionMessages(actualConversationId, (current) => [
            ...current,
            {
              id: createMessageId("user"),
              role: "user",
              content: prepared.prompt,
              status: "sent",
              timestamp: formatMessageTime(),
            },
          ]);
          if (!cancelled()) {
            if (!(await transition(["queued"], "running"))) {
              if (!cancelled())
                throw new Error(
                  "INVALID_TRANSITION: queued run did not acquire execution ownership",
                );
            } else {
              budget.resume();
              ctx.updateSessionField(actualConversationId, "isStreaming", true);
              resetRunStreamMetrics(ctx, actualConversationId);
              markRunStarted(ctx, actualConversationId);
              logSubAgentDiagnostic("runStarted", {
                runId: ownerId,
                conversationId: actualConversationId,
                parentConversationId: scope.parentConversationId,
                interactionId: options.interactionId,
                reasonCode: "RUN_STARTED",
              });
              ctx.addStreamingId(actualConversationId);
              ctx.setSubAgentSessionEvent({
                parentConversationId: scope.parentConversationId,
                conversationId: actualConversationId,
                agentId: runtimeConfig.agentId,
                agentName: runtimeConfig.agentName,
                summary: prepared.summary,
                status: "running",
                timestamp: Date.now(),
                toolCallInteractionId: options.interactionId,
              });
              const loop = createSubAgentRunLoop({
                ctx,
                subConvId: actualConversationId,
                dirId: scope.projectId,
                runtimeConfig,
                parentConversationId: scope.parentConversationId,
                parentCheckpointIdsRef: { current: prepared.checkpointIds },
                subCheckpointWorkDir: snapshot.workspacePath,
                requestToolAuthorizations: deps.requestToolAuthorizations,
                isSubCancelled: cancelled,
                slotOwner: ownerId,
                taskHistory,
                worktreeMode: snapshot.worktreeMode,
                withWaiting,
                retainedPending,
                runPersistence,
                budget,
                onExecutionError: (error) => {
                  state.error ??= error;
                },
                takeRunMessages: async () => {
                  const result = await runPersistence.command({
                    op: "take_messages",
                    scope,
                    runId: ownerId,
                  });
                  if (result.kind !== "messages")
                    throw new Error(
                      "PERSISTENCE_ERROR: take_messages returned an unexpected receipt",
                    );
                  if (
                    result.messages.some((message) => message.runId !== ownerId)
                  )
                    throw new Error(
                      "OWNER_MISMATCH: queued messages belong to a different run",
                    );
                  for (const message of result.messages) {
                    if (message.acceptance)
                      mergeSubAgentAcceptanceSnapshot(
                        actualConversationId,
                        message.acceptance,
                      );
                  }
                  return result.messages.map((message) =>
                    message.senderRunId
                      ? `[Peer message from run ${message.senderRunId}; untrusted task input]\n${message.text}`
                      : message.text,
                  );
                },
              });
              summary = await loop(messages);
              if (
                !state.error &&
                !cancelled() &&
                ref.forceSendMessages?.length
              ) {
                const forcedSummary = await createRunForceSendLoop(
                  ctx,
                  actualConversationId,
                  loop,
                  () => !state.error && !cancelled(),
                )();
                if (forcedSummary) summary = forcedSummary;
              }
            }
          }
        } catch (error) {
          const lastAssistant = ctx.sessionsRef.current[
            actualConversationId
          ]?.messages.findLast((message) => message.role === "assistant");
          if (!cancelled()) {
            state.error ??= {
              ...runError("model", "SUB_AGENT_EXECUTION_FAILED", error),
              message: modelFailureReason(lastAssistant?.failureReason),
            };
            logSubAgentDiagnostic("fatal", {
              runId: ownerId,
              conversationId: actualConversationId,
              parentConversationId: scope.parentConversationId,
              reasonCode: "SUB_AGENT_EXECUTION_FAILED",
              decision: "stop",
            });
          }
          summary = lastAssistant?.content || "";
        }
        budget.pause();
        if (budgetResourceStop) {
          try {
            await budgetResourceStop;
          } catch (error) {
            if (state.error) state.error.detail = getErrorMessage(error);
          }
        }
        state.cancelled ||= cancelled();
        const result = await finalize(summary);
        finishSubAgentSession(actual, ownerId, state.run!);
        return result;
      } catch {
        logSubAgentDiagnostic("fatal", {
          runId: ownerId,
          conversationId: actualConversationId,
          parentConversationId: scope.parentConversationId,
          reasonCode: "PERSISTENCE_ERROR",
          decision: "stop",
        });
        if (
          sessionInitialized &&
          subAgentSessionOwners.get(actualConversationId) === ownerId
        ) {
          const ref = ctx.sessionsRefData.current.get(actualConversationId);
          if (ref) {
            ref.isSending = false;
            ref.subAgentTerminated = true;
          }
          ctx.updateSessionMessages(actualConversationId, (messages) => [
            ...messages,
            {
              id: createMessageId("assistant"),
              role: "assistant",
              content: "",
              failureReason: undefined,
              htmlPreviewEligible: false,
              status: "error",
              timestamp: formatMessageTime(),
            },
          ]);
          ctx.updateSessionField(actualConversationId, "isStreaming", false);
          ctx.removeStreamingId(actualConversationId);
        }
        throw new Error(
          "PERSISTENCE_ERROR: sub-agent run could not be settled",
        );
      } finally {
        if (subAgentSessionOwners.get(actualConversationId) === ownerId) {
          createForwardSubPendingQueue(
            ctx,
            scope.parentConversationId,
          )(actualConversationId);
          subAgentSessionOwners.delete(actualConversationId);
        }
        budget.pause();
        capacityAbort.abort();
        cancelSubAgentRunWaits(ownerId);
        unregisterSubAgentRunControl(ownerId);
      }
    },
    async () => {
      if (state.finalizing) return;
      if (subAgentSessionOwners.get(actualConversationId) !== ownerId)
        throw new Error(
          "OWNER_MISMATCH: sub-agent session now belongs to a different run",
        );
      state.cancelled = true;
      capacityAbort.abort();
      budget.pause();
      await stopSubAgentResources(ctx, actualConversationId, ownerId);
    },
  );
  if (receipt.executionMode === "async") return JSON.stringify(receipt);
  return promise;
};

const createSubAgentResume =
  (prepared: PreparedRun): SubAgentResumer["resume"] =>
  async (
    messages,
    checkpointIds,
    options = { executionMode: "sync" },
    activationDeps,
  ) => {
    const deps = activationDeps ?? prepared.deps;
    const taskHistory = options.taskHistory;
    const config =
      (await window.snow.getSubAgentConfig(
        prepared.runtimeConfig.agentId,
        prepared.scope.projectId,
      )) ??
      (await window.snow.getSubAgentConfig(prepared.runtimeConfig.agentId));
    if (!config)
      throw new Error(
        "CONFIGURATION_ERROR: sub-agent configuration is unavailable",
      );
    const configuredTools = parseSubAgentTools(config.toolsJson);
    const group = options.requestInput?.collaborationGroup;
    const authorized =
      group &&
      (configuredTools.includes("sub-agents-sendMessage") ||
        (prepared.runtimeConfig.agentId === "agent_general" &&
          configuredTools.includes("*")));
    const ordinaryTools = parseSubAgentTools(
      prepared.runtimeConfig.toolsJson,
    ).filter((name) => !name.startsWith("sub-agents-"));
    const toolsJson = JSON.stringify(
      authorized ? [...ordinaryTools, "sub-agents-sendMessage"] : ordinaryTools,
    );
    const next: PreparedRun = {
      ...prepared,
      deps,
      runtimeConfig: { ...prepared.runtimeConfig, toolsJson },
      snapshot: {
        ...prepared.snapshot,
        ...(await loadSubAgentBudgetLimits()),
        toolsJson,
        collaborationGroup: group,
      },
      operation: "continue",
      prompt: messages.map((message) => message.content).join("\n\n"),
      checkpointIds: checkpointIds ?? [],
      options,
      taskHistory,
    };
    const hook = await executeSubAgentHook(
      deps.ctx,
      next,
      "beforeSubAgentStart",
    );
    if (hook.kind === "abort")
      throw new Error(`PERMISSION_DENIED: ${hook.message}`);
    return dispatchPreparedSubAgentRun(next);
  };
const registerResumer = (prepared: PreparedRun): SubAgentResumer => {
  const resumer = {
    parentConversationId: prepared.scope.parentConversationId,
    agentId: prepared.runtimeConfig.agentId,
    agentName: prepared.runtimeConfig.agentName,
    resume: createSubAgentResume(prepared),
  };
  subAgentResumers.set(prepared.conversationId, resumer);
  return resumer;
};

export const createSubAgentActivation = (deps: SubAgentActivationDeps) => {
  return async (
    argsJson: string,
    parentConversationId: string,
    dirId: string,
    toolCallInteractionId: string | undefined,
    activeCheckpointIds: string[],
    defaultExecutionMode?: SubAgentExecutionMode,
  ): Promise<string> => {
    const taskHistory = currentAgentTask(parentConversationId);
    const parent = deps.ctx.sessionsRefData.current.get(parentConversationId);
    const worktreeMode = parent?.worktreeMode ?? false;
    try {
      const args = parseToolArgs(argsJson);
      // The model chooses per call; the user setting is only the fallback.
      const options = parseRunOptions(
        {
          ...args,
          executionMode:
            args.executionMode ??
            defaultExecutionMode ??
            (await loadSubAgentExecutionMode()),
        },
        "activate",
        toolCallInteractionId,
      );
      await requireSubAgentParent(
        { projectId: dirId, parentConversationId },
        options.executionMode,
      );
      const persistence = requirePersistence(deps.runPersistence);
      const agentId =
        typeof args.agentId === "string" ? args.agentId.trim() : "";
      const prompt = typeof args.prompt === "string" ? args.prompt : "";
      const summary =
        typeof args.summary === "string" ? args.summary.trim() : "";
      if (!agentId || !prompt || !summary)
        throw new Error(
          "VALIDATION_ERROR: agentId, summary and prompt are required",
        );
      const acceptance = parseSubAgentAcceptanceCriteria(args.acceptance);
      if (acceptance.errors.length)
        throw new Error(`VALIDATION_ERROR: ${acceptance.errors.join("; ")}`);
      const scope: SubAgentRunScope = {
        projectId: dirId,
        parentConversationId,
      };
      const requestInput: SubAgentLogicalInput = {
        operation: "activate",
        executionMode: options.executionMode,
        collaborationGroup: parseCollaborationGroup(args.collaborationGroup),
        agentId,
        summary,
        text: prompt,
        acceptance: [...acceptance.criteria].sort((left, right) =>
          left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
        ),
      };
      options.requestInput = requestInput;
      return await prepareLogicalSubAgentRequest(
        deps.runPersistence,
        scope,
        options,
        requestInput,
        async () => {
          const config = dirId
            ? ((await window.snow.getSubAgentConfig(agentId, dirId)) ??
              (await window.snow.getSubAgentConfig(agentId)))
            : await window.snow.getSubAgentConfig(agentId);
          if (!config)
            throw new Error(
              `CONFIGURATION_ERROR: sub-agent configuration not found: ${agentId}`,
            );
          let runtimeConfig: SubAgentRuntimeConfig;
          try {
            runtimeConfig = resolveSubAgentRuntimeConfig({
              config,
              apiConfigs: await window.snow.listApiConfigs(),
              parentApiProfile: deps.parentApiProfile,
              parentModel: deps.parentModel,
              parentThinkingStrength: deps.parentThinkingStrength,
              parentResponsesFastMode: deps.parentResponsesFastMode,
            });
          } catch (error) {
            throw new Error(`CONFIGURATION_ERROR: ${getErrorMessage(error)}`, {
              cause: error,
            });
          }
          runtimeConfig = {
            ...runtimeConfig,
            toolsJson: collaborationToolsJson(
              runtimeConfig.toolsJson,
              requestInput.collaborationGroup,
            ),
          };
          const allowedTools = parseSubAgentTools(runtimeConfig.toolsJson);
          runtimeConfig = {
            ...runtimeConfig,
            unavailableTools: allowedTools.includes("*")
              ? []
              : await window.snow.diagnoseSubAgentTools(
                  dirId,
                  runtimeConfig.toolsJson,
                ),
          };
          const workspacePath = await resolveConversationWorkspacePath(
            parentConversationId,
            dirId,
            directoryIdToPath(dirId) ?? deps.ctx.directoryPath,
            worktreeMode,
          );
          if (!workspacePath)
            throw new Error(
              "CONFIGURATION_ERROR: dispatch workspace is unavailable",
            );
          const conversationId = `sub-${crypto.randomUUID()}`;
          initializeSubAgentAcceptance(conversationId, acceptance.criteria);
          const prepared: PreparedRun = {
            deps: { ...deps, runPersistence: persistence },
            scope,
            conversationId,
            operation: "activate",
            runtimeConfig,
            snapshot: {
              ...(await loadSubAgentBudgetLimits()),
              collaborationGroup: requestInput.collaborationGroup,
              agentId: runtimeConfig.agentId,
              agentName: runtimeConfig.agentName,
              apiProfile: runtimeConfig.apiProfile,
              model: runtimeConfig.model,
              systemPrompt: runtimeConfig.systemPrompt,
              toolsJson: runtimeConfig.toolsJson,
              effectiveThinkingStrength:
                runtimeConfig.effectiveThinkingStrength,
              effectiveResponsesFastMode:
                runtimeConfig.effectiveResponsesFastMode,
              workspacePath,
              worktreeMode,
            },
            summary,
            prompt,
            checkpointIds: [...activeCheckpointIds],
            taskHistory,
            options,
          };
          const hook = await executeSubAgentHook(
            deps.ctx,
            prepared,
            "beforeSubAgentStart",
          );
          if (hook.kind === "abort")
            throw new Error(`PERMISSION_DENIED: ${hook.message}`);
          const result = await dispatchPreparedSubAgentRun(prepared);
          const receipt = JSON.parse(result);
          const committedId =
            receipt.kind === "accepted"
              ? receipt.conversationId
              : receipt.kind === "result"
                ? receipt.run?.conversationId
                : undefined;
          if (committedId === conversationId) registerResumer(prepared);
          return result;
        },
      );
    } catch (error) {
      return toolFailure(error);
    }
  };
};

const restoreSubAgentResumer = async (
  deps: SubAgentActivationDeps,
  scope: SubAgentRunScope,
  targetConvId: string,
  checkpointIds: string[],
): Promise<SubAgentResumer> => {
  const grouped = await window.snow.listSubAgentConversationsByParents([
    scope.parentConversationId,
  ]);
  const record = grouped[scope.parentConversationId]?.find(
    (item) => item.conversationId === targetConvId,
  );
  if (!record || record.directoryId !== scope.projectId)
    throw new Error(
      "PERMISSION_DENIED: target sub-agent does not belong to this parent/project",
    );
  const agentId = record.subAgentId.trim();
  const config = scope.projectId
    ? ((await window.snow.getSubAgentConfig(agentId, scope.projectId)) ??
      (await window.snow.getSubAgentConfig(agentId)))
    : await window.snow.getSubAgentConfig(agentId);
  if (!config)
    throw new Error(
      `CONFIGURATION_ERROR: sub-agent configuration is unavailable: ${agentId}`,
    );
  const apiConfigs = await window.snow.listApiConfigs();
  const result = await requirePersistence(deps.runPersistence).command({
    op: "list",
    scope,
    conversationId: targetConvId,
    limit: 1,
  });
  if (result.kind !== "runs")
    throw new Error("PERSISTENCE_ERROR: invalid persisted run list");
  const snapshot = result.runs[0]?.snapshot;
  if (!snapshot)
    throw new Error(
      "RUN_NOT_FOUND: sub-agent has no persisted execution snapshot",
    );
  if (
    snapshot.agentId !== agentId ||
    !apiConfigs.some((item) => item.profileName.trim() === snapshot.apiProfile)
  )
    throw new Error(
      "CONFIGURATION_ERROR: captured agent or API profile is unavailable",
    );
  const runtimeConfig = resolveSubAgentRuntimeConfig({
    config: {
      ...config,
      configProfile: snapshot.apiProfile,
      model: snapshot.model,
      systemPrompt: snapshot.systemPrompt,
      toolsJson: snapshot.toolsJson,
    },
    apiConfigs,
    parentThinkingStrength: snapshot.effectiveThinkingStrength,
    parentResponsesFastMode: snapshot.effectiveResponsesFastMode,
  });
  return registerResumer({
    deps,
    scope,
    conversationId: targetConvId,
    operation: "continue",
    runtimeConfig,
    snapshot,
    summary: record.summary || record.title,
    prompt: "",
    checkpointIds: [...checkpointIds],
    taskHistory: undefined,
    options: { executionMode: "sync" },
  });
};

/** Never send an execution snapshot/prompt or an unpaged duplicate summary to a model. */
const modelResultPage = (
  page: Awaited<ReturnType<typeof readSubAgentRunResult>>,
) => {
  const { snapshot: _snapshot, ...run } = page.run;
  return {
    ...page,
    run: {
      ...run,
      ...(run.outcome
        ? { outcome: { ...run.outcome, summary: page.summaryPage?.text ?? "" } }
        : {}),
    },
  };
};
const parseToolArgs = (argsJson: string): Record<string, unknown> => {
  const args: unknown = JSON.parse(argsJson);
  if (!args || typeof args !== "object" || Array.isArray(args))
    throw new Error("VALIDATION_ERROR: tool arguments must be an object");
  return args as Record<string, unknown>;
};
const stringArg = (args: Record<string, unknown>, key: string): string => {
  const value = args[key];
  if (typeof value !== "string" || !value.trim())
    throw new Error(`VALIDATION_ERROR: ${key} is required`);
  return value.trim();
};

export const createSubAgentMainToolExecutor = (
  ctx: ConversationContextValue,
  deps: Pick<
    SubAgentActivationDeps,
    "requestToolAuthorizations" | "runPersistence"
  > & {
    parentThinkingStrength?: string | null;
    parentResponsesFastMode?: string | null;
  },
) => {
  return async (
    toolName: string,
    argsJson: string,
    parentConversationId: string,
    checkpointIds: string[],
    defaultExecutionMode?: SubAgentExecutionMode,
  ): Promise<string> => {
    const taskHistory = currentAgentTask(parentConversationId);
    try {
      // Retired/unknown public names must not fall through to continue.
      if (!SUB_AGENT_MAIN_TOOL_NAMES.has(toolName))
        throw new Error(
          "VALIDATION_ERROR: unavailable sub-agent management tool",
        );
      const args = parseToolArgs(argsJson);
      const parentRecord =
        await window.snow.getChatConversation(parentConversationId);
      if (!parentRecord)
        throw new Error("RUN_NOT_FOUND: parent conversation does not exist");
      const scope: SubAgentRunScope = {
        projectId: parentRecord.directoryId,
        parentConversationId,
      };
      await requireSubAgentParent(scope);
      const persistence = requirePersistence(deps.runPersistence);
      const fullDeps: SubAgentActivationDeps = {
        ...deps,
        runPersistence: persistence,
        ctx,
        parentApiProfile: parentRecord.apiProfileName,
        parentModel: parentRecord.model,
      };
      if (toolName === "sub-agents-getResult") {
        const runId = stringArg(args, "runId");
        if (
          args.offset !== undefined &&
          (typeof args.offset !== "number" ||
            !Number.isInteger(args.offset) ||
            args.offset < 0)
        )
          throw new Error("VALIDATION_ERROR: offset must be an integer >= 0");
        if (
          args.limit !== undefined &&
          (typeof args.limit !== "number" ||
            !Number.isInteger(args.limit) ||
            args.limit < 1 ||
            args.limit > 64000)
        )
          throw new Error(
            "VALIDATION_ERROR: limit must be an integer in 1..64000",
          );
        const page = await requirePersistence(persistence).command({
          op: "get",
          scope,
          runId,
          terminalOnly: true,
          offset: args.offset as number | undefined,
          limit: args.limit as number | undefined,
        });
        if (page.kind !== "result")
          throw new Error("PERSISTENCE_ERROR: invalid terminal result receipt");
        if (!isSubAgentTerminal(page.run.status))
          throw new Error(
            "RESULT_NOT_READY: getResult only reads immutable terminal content; do not poll",
          );
        return JSON.stringify(modelResultPage(page));
      }
      if (toolName === "sub-agents-cancel") {
        return JSON.stringify(
          await requestOwnedSubAgentRunCancel(
            requirePersistence(persistence),
            scope,
            stringArg(args, "runId"),
            "cancel_tool",
          ),
        );
      }
      if (toolName === "sub-agents-continue") {
        const targetConvId = stringArg(args, "conversationId");
        const text = typeof args.message === "string" ? args.message : "";
        if (!text.trim())
          throw new Error("VALIDATION_ERROR: message is required");
        const message = `[来自主会话]
${text}`;
        const options: RunOptions = {
          ...parseRunOptions(
            {
              ...args,
              executionMode:
                args.executionMode ??
                defaultExecutionMode ??
                (await loadSubAgentExecutionMode()),
            },
            "continue",
          ),
          taskHistory,
        };
        // Queued messages bypass dispatch: enforce the parent's mode limit here.
        await requireSubAgentParent(scope, options.executionMode);

        const acceptance = parseSubAgentAcceptanceCriteria(args.acceptance);
        if (acceptance.errors.length)
          throw new Error(`VALIDATION_ERROR: ${acceptance.errors.join("; ")}`);
        const requestInput: SubAgentLogicalInput = {
          operation: "continue",
          executionMode: options.executionMode,
          collaborationGroup: parseCollaborationGroup(args.collaborationGroup),
          conversationId: targetConvId,
          text,
          acceptance: [...acceptance.criteria].sort((left, right) =>
            left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
          ),
        };
        options.requestInput = requestInput;
        return await prepareLogicalSubAgentRequest(
          persistence,
          scope,
          options,
          requestInput,
          async () => {
            const grouped =
              await window.snow.listSubAgentConversationsByParents([
                parentConversationId,
              ]);
            if (
              !(grouped[parentConversationId] ?? []).some(
                (record) =>
                  record.conversationId === targetConvId &&
                  record.directoryId === scope.projectId,
              )
            )
              throw new Error(
                "PERMISSION_DENIED: target sub-agent is outside this parent/project",
              );
            if (!hasSubAgentAcceptance(targetConvId)) {
              const result = await persistence.command({
                op: "list",
                scope,
                conversationId: targetConvId,
                limit: 1,
              });
              if (result.kind !== "runs")
                throw new Error(
                  "PERSISTENCE_ERROR: list returned an unexpected receipt",
                );
              const persistedAcceptance = result.runs[0]?.outcome?.acceptance;
              if (persistedAcceptance)
                restoreSubAgentAcceptanceSnapshot(
                  targetConvId,
                  persistedAcceptance,
                );
            }
            if (acceptance.criteria.length) {
              const errors = mergeSubAgentAcceptanceCriteria(
                targetConvId,
                acceptance.criteria,
              );
              if (errors.length)
                throw new Error(`VALIDATION_ERROR: ${errors.join("; ")}`);
            }

            if (!options.requestId)
              throw new Error(
                "VALIDATION_ERROR: continue requires a stable host requestId",
              );
            const active = await activeConversationRun(
              persistence,
              scope,
              targetConvId,
            );
            // Capture the exact generation. A finishing target is not permission to create its successor.
            const result = active
              ? await persistence.command({
                  op: "queue_message",
                  scope,
                  requestId: options.requestId,
                  requestInput,
                  conversationId: targetConvId,
                  expectedRunId: active.runId,
                  message,
                  acceptance:
                    peekSubAgentAcceptanceSnapshot(targetConvId) ?? undefined,
                })
              : undefined;
            if (result) {
              if (result.kind === "message_queued")
                return JSON.stringify({
                  ...result,

                  acceptance: peekSubAgentAcceptanceSnapshot(targetConvId),
                });
              if (result.kind === "accepted")
                return replaySubAgentReceipt(persistence, scope, result);
              throw new Error(
                "PERSISTENCE_ERROR: queue_message returned an unexpected receipt",
              );
            }

            let resumer = subAgentResumers.get(targetConvId);
            if (
              resumer &&
              resumer.parentConversationId !== parentConversationId
            )
              throw new Error(
                "PERMISSION_DENIED: sub-agent belongs to another parent",
              );
            resumer ??= await restoreSubAgentResumer(
              fullDeps,
              scope,
              targetConvId,
              checkpointIds,
            );
            return await resumer.resume(
              [{ role: "user", content: message }],
              checkpointIds,
              options,
              fullDeps,
            );
          },
        );
      }
      throw new Error(
        `VALIDATION_ERROR: unknown sub-agent management tool: ${toolName}`,
      );
    } catch (error) {
      return toolFailure(error);
    }
  };
};
