import {
  directoryIdToPath,
  formatMcpToolResultForModel,
  getErrorMessage,
  isValidToolName,
  isUserQuestionCancellationResult,
  resolveConversationWorkspacePath,
  updateFirstMatchingToolCall,
  validateToolCall,
} from "../utils/conversationHelpers";
import { appendHookExecutionToMessage, runHook } from "./hookOutcome";
import {
  ToolWatchdogTimeoutError,
  resolveToolWatchdogMs,
  withToolWatchdog,
} from "./toolWatchdog";
import {
  extractFileChangesFromTool,
  extractFileChangeCoverageFromTool,
} from "./fileChangeTracking";
import { SUB_AGENT_MAIN_TOOL_NAMES } from "./subAgentActivation";
import { loadSubAgentExecutionMode } from "./subAgentExecutionMode";
import { isPendingSessionKey } from "../utils/conversationTypes";
import { injectSessionIdIntoToolArgs } from "../utils/toolSessionMetadata";
import { appendStreamTail } from "../utils/streamTail";
import type {
  ConversationContextValue,
  HookExecutionRecord,
  ToolAuthorizationDecision,
  ToolCallInfo,
  ToolCorrectionState,
} from "../utils/conversationTypes";
import type { BashStreamChunk } from "../../../../../preload";
import {
  DEFAULT_IMAGE_GEN_MAX_CONCURRENT,
  IMAGE_GEN_SETTING_CODE,
} from "../../../sidebar/imagegenSettings/constants";
import { readImageGenSettingsJson } from "../../../sidebar/imagegenSettings/utils";
import { tGlobal } from "../../../../i18n";
import {
  imageGenerationRuntime,
  logImageGeneration,
} from "./imageGenerationRuntime";
import { settleImageGenerationReceipt } from "../utils/imageGenerationState";
import {
  appendToolCorrectionNote,
  detectToolFailure,
  isNonCorrectableToolFailure,
  isToolCorrectionEligible,
  runToolCorrection,
  serializeToolCorrectionState,
  type ToolCorrectionSuccess,
  type ToolCorrectionToolDefinition,
} from "./toolCorrection";
import { ensureToolCorrectionPreference } from "../utils/toolCorrectionPreference";
import { summarizeContentAsPlainText } from "../../chatInput/fileTagUtils";

export type ToolExecutionResult = {
  structuredToolResults: {
    name: string;
    callId: string;
    result: string;
    /** 结果来自纠错后的重新执行：不得写入只读调用缓存。 */
    corrected?: boolean;
  }[];
  hookAborted: boolean;
  hookAbortMessage: string;
  userQuestionCancelled: boolean;
  pendingHookWarnings: string[];
  forcedSkillError: string;
};

/** 子代理工具（激活 / 重新激活）失败判定：结果 JSON 的 success === false
 *  或结果缺失时，卡片需要展示为错误态。 */
const isFailedSubAgentResult = (result: string | undefined): boolean => {
  if (typeof result !== "string" || !result.trim()) {
    return true;
  }

  try {
    const parsed: unknown = JSON.parse(result);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>).success === false
    );
  } catch {
    return false;
  }
};

/**
 * Apply Snow-owned argument defaults/injections shared by the normal execution
 * path and the correction retry path.
 */
const prepareToolArguments = (
  toolName: string,
  argsJson: string,
  options: { responseId?: string; sessionId?: string },
): string => {
  let toolArgs = argsJson;

  if (toolName === "todo-todo-manage" && options.responseId) {
    try {
      const parsedArgs = JSON.parse(toolArgs) as Record<string, unknown>;
      if (parsedArgs.action === "add") {
        parsedArgs.responseId = options.responseId;
        toolArgs = JSON.stringify(parsedArgs);
      }
    } catch {
      // Invalid JSON is reported by the validation path.
    }
  }

  if (toolName === "memory-save" && options.responseId) {
    try {
      const parsedArgs = JSON.parse(toolArgs) as Record<string, unknown>;
      parsedArgs.responseId = options.responseId;
      toolArgs = JSON.stringify(parsedArgs);
    } catch {
      // Invalid JSON is reported by the validation path.
    }
  }

  if (toolName === "filesystem-create") {
    try {
      const parsedArgs = JSON.parse(toolArgs) as Record<string, unknown>;
      if (typeof parsedArgs.overwrite !== "boolean") {
        parsedArgs.overwrite = false;
        toolArgs = JSON.stringify(parsedArgs);
      }
    } catch {
      // Invalid JSON is reported by the validation path.
    }
  }

  return injectSessionIdIntoToolArgs(toolName, toolArgs, options.sessionId);
};

export type ToolExecutorDeps = {
  ctx: ConversationContextValue;
  effectiveKey: string;
  currentAssistantMessageId: string;
  checkpointIds: string[];
  sessionDirId: string | undefined;
  directoryPath: string | undefined;
  responseId: string | undefined;
  /** 会话绑定的 API 档案（纠错请求使用同一档案的基础模型）。 */
  apiProfile: string | undefined;
  forcedSkillLoad?: boolean;
  isRunCancelled: (key: string) => boolean;
  requestToolAuthorizations: (
    toolCalls: ToolCallInfo[],
    conversationId: string,
    projectId?: string,
  ) => Promise<ToolAuthorizationDecision[]>;
  awaitHookDecision: (
    key: string,
    messageId: string,
    record: HookExecutionRecord,
  ) => Promise<boolean>;
  executeSubAgentActivation: (
    argsJson: string,
    parentConversationId: string,
    dirId: string,
    toolCallInteractionId: string | undefined,
    checkpointIds: string[],
    defaultExecutionMode?: import("../../../../../shared/subAgentRuns").SubAgentExecutionMode,
  ) => Promise<string>;
  executeSubAgentMainTool: (
    toolName: string,
    argsJson: string,
    parentConversationId: string,
    checkpointIds: string[],
    defaultExecutionMode?: import("../../../../../shared/subAgentRuns").SubAgentExecutionMode,
  ) => Promise<string>;
  executeWorkflowGenerate: (
    argsJson: string,
    parentConversationId: string,
    dirId: string,
    toolCallInteractionId: string,
  ) => Promise<string>;
  /** 失败节点续跑（workflow-resume）：渲染进程运行时执行。 */
  executeWorkflowResume: (
    argsJson: string,
    parentConversationId: string,
    toolCallInteractionId: string,
  ) => Promise<string>;
};

export function createToolExecutor(
  deps: ToolExecutorDeps,
): (
  toolCalls: ToolCallInfo[],
  authorizationDecisions: ToolAuthorizationDecision[],
) => Promise<ToolExecutionResult | null> {
  const {
    ctx,
    effectiveKey,
    currentAssistantMessageId,
    checkpointIds,
    sessionDirId,
    directoryPath,
    responseId,
    apiProfile,
    forcedSkillLoad,
    isRunCancelled,
    requestToolAuthorizations,
    awaitHookDecision,
    executeSubAgentActivation: dispatchSubAgentActivation,
    executeSubAgentMainTool: dispatchSubAgentMainTool,
    executeWorkflowGenerate,
    executeWorkflowResume,
  } = deps;

  const subAgentArgs = (call: ToolCallInfo, argsJson: string): string => {
    if (call.name !== "sub-agents-continue") return argsJson;
    const parsed: unknown = JSON.parse(argsJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("VALIDATION_ERROR: invalid sub-agent arguments");
    const args = parsed as Record<string, unknown>;
    if (args.requestId === undefined) {
      const identity =
        call.interactionId ||
        (responseId && call.callId
          ? `${responseId}:${call.callId}`
          : undefined);
      if (!identity)
        throw new Error(
          "VALIDATION_ERROR: stable tool interaction identity is required",
        );
      args.requestId = `continue:${identity}`;
    }
    return JSON.stringify(args);
  };

  // 工具 cwd / checkpoint 目录跟随会话自己的目录,而非运行时全局
  // activeDirectory。实际 WorkTree 模式在每轮执行开始时由持久绑定解析。
  const projectSessionDirPath =
    directoryIdToPath(sessionDirId) ?? directoryPath;

  return async (
    toolCalls: ToolCallInfo[],
    authorizationDecisions: ToolAuthorizationDecision[],
  ): Promise<ToolExecutionResult | null> => {
    // Capture the user's default mode once for this batch; each call's own
    // executionMode argument still takes precedence over it.
    const defaultExecutionMode = toolCalls.some(
      (call) =>
        call.name === "sub-agents-activate" ||
        call.name === "sub-agents-continue",
    )
      ? await loadSubAgentExecutionMode()
      : undefined;
    const executeSubAgentActivation = (
      ...args: Parameters<ToolExecutorDeps["executeSubAgentActivation"]>
    ) => {
      args[5] = defaultExecutionMode;
      return dispatchSubAgentActivation(...args);
    };
    const executeSubAgentMainTool = (
      ...args: Parameters<ToolExecutorDeps["executeSubAgentMainTool"]>
    ) => {
      args[4] = defaultExecutionMode;
      return dispatchSubAgentMainTool(...args);
    };
    const targetSession = ctx.sessionsRefData.current.get(effectiveKey);
    const sessionDirPath = await resolveConversationWorkspacePath(
      isPendingSessionKey(effectiveKey) ? "" : effectiveKey,
      sessionDirId,
      projectSessionDirPath,
      targetSession?.worktreeMode ?? false,
      targetSession?.worktreeId,
    );
    const runtime = imageGenerationRuntime(ctx);
    const imageMembers = toolCalls.filter(
      (call, index) =>
        call.name === "imagegen-generate" &&
        authorizationDecisions[index]?.status !== "rejected" &&
        !validateToolCall(call),
    );
    let imageBatchId: string | undefined;
    let imageRegistrationError: string | null = null;
    let executorClosed = false;
    const pendingImageGenQueue: number[] = [];
    const imageStartWaiters = new Map<number, Promise<void>>();
    const imageStartResolvers = new Map<number, () => void>();
    const resolveImageStart = (index: number): void => {
      imageStartResolvers.get(index)?.();
      imageStartResolvers.delete(index);
    };
    let activeImageGenCount = 0;
    let maxConcurrentImageGen = DEFAULT_IMAGE_GEN_MAX_CONCURRENT;
    let drainingImages = false;
    try {
      if (imageMembers.length > 0 && !isRunCancelled(effectiveKey)) {
        if (isPendingSessionKey(effectiveKey)) {
          imageRegistrationError = JSON.stringify({
            error: tGlobal("toolCall.imagegen.conversationRequired"),
          });
        } else {
          // Only the runtime chooses batch IDs, never model arguments.
          imageBatchId = crypto.randomUUID();
          try {
            runtime.accept(
              await window.snow.registerImageGenerationBatch({
                conversationId: effectiveKey,
                batchId: imageBatchId,
                members: imageMembers.map((call) => ({
                  interactionId: call.interactionId,
                  callId: call.callId || "",
                })),
              }),
            );
            logImageGeneration("batch_registered", effectiveKey, imageBatchId);
          } catch {
            imageRegistrationError = JSON.stringify({
              error: tGlobal("toolCall.imagegen.registrationFailed"),
            });
            logImageGeneration(
              "batch_registration_failed",
              effectiveKey,
              imageBatchId,
              undefined,
              "WARN",
            );
          }
        }
      }
      const structuredToolResults: {
        name: string;
        callId: string;
        result: string;
      }[] = [];
      let userQuestionCancelled = false;
      let forcedSkillError = "";
      let hookAborted = false;
      let hookAbortMessage = "";
      const pendingHookWarnings: string[] = [];
      const userQuestionIndices = toolCalls
        .map((toolCall, index) =>
          toolCall.name === "user-interaction-askUserQuestion" ? index : -1,
        )
        .filter((index) => index >= 0);
      const userQuestionSettlements = new Map<
        number,
        { settled: boolean; cancelled: boolean }
      >();
      const allUserQuestionsRefused = (): boolean =>
        userQuestionIndices.length > 0 &&
        userQuestionIndices.every((index) => {
          const settlement = userQuestionSettlements.get(index);
          return settlement?.settled === true && settlement.cancelled === true;
        });
      const registerUserQuestionSettlement = (
        index: number,
        result: string,
      ): void => {
        userQuestionSettlements.set(index, {
          settled: true,
          cancelled: isUserQuestionCancellationResult(result),
        });
        if (allUserQuestionsRefused()) {
          userQuestionCancelled = true;
        }
      };

      // 看门狗超时后中止后端仍在运行的执行（bash 进程 / SSH 通道），主循环不再等待。
      const findLiveToolCall = (toolCall: ToolCallInfo) =>
        ctx.sessionsRef.current?.[effectiveKey]?.messages
          ?.find((m) => m.id === currentAssistantMessageId)
          ?.toolCalls?.find(
            (tc) =>
              tc.interactionId === toolCall.interactionId &&
              tc.name === toolCall.name,
          );
      const abortTimedOutExecution = (toolCall: ToolCallInfo, err: unknown) => {
        if (!(err instanceof ToolWatchdogTimeoutError)) {
          return;
        }
        const executionId = findLiveToolCall(toolCall)?.toolExecutionId;
        if (executionId) {
          void window.snow
            .abortToolExecution(executionId, "timeout")
            .catch(() => undefined);
        }
      };

      // Terminals are coordinated outside React and independent of message IDs.
      const buildToolChunkHandler =
        (toolCall: ToolCallInfo) =>
        (chunk: BashStreamChunk): void => {
          if (!chunk.data) return;
          if (chunk.stream === "imagegen")
            runtime.consumeTerminal(effectiveKey, toolCall, chunk.data);
          ctx.updateSessionMessages(effectiveKey, (messages) =>
            messages.map((message) => {
              if (message.id !== currentAssistantMessageId) return message;
              return {
                ...message,
                toolCalls: updateFirstMatchingToolCall(
                  message.toolCalls,
                  toolCall,
                  ["pending", "running"],
                  (call) => {
                    if (chunk.stream === "interactive_session")
                      return { ...call, interactiveSessionId: chunk.data };
                    if (chunk.stream === "tool_execution")
                      return { ...call, toolExecutionId: chunk.data };
                    if (chunk.stream === "stdout")
                      return {
                        ...call,
                        streamingStdout: appendStreamTail(
                          call.streamingStdout,
                          chunk.data,
                        ),
                      };
                    if (chunk.stream === "stderr")
                      return {
                        ...call,
                        streamingStderr: appendStreamTail(
                          call.streamingStderr,
                          chunk.data,
                        ),
                      };
                    if (chunk.stream === "imagegen") {
                      try {
                        const preview = JSON.parse(chunk.data) as Record<
                          string,
                          unknown
                        >;
                        if (
                          preview.type === "partial_image" &&
                          typeof preview.index === "number" &&
                          typeof preview.data === "string" &&
                          typeof preview.mimeType === "string"
                        ) {
                          const incoming = {
                            index: preview.index,
                            data: preview.data,
                            mimeType: preview.mimeType,
                          };
                          return {
                            ...call,
                            streamingImages: [
                              ...(call.streamingImages ?? []).filter(
                                (image) => image.index !== incoming.index,
                              ),
                              incoming,
                            ].sort((a, b) => a.index - b.index),
                          };
                        }
                      } catch {
                        /* Ignore malformed previews. */
                      }
                    }
                    return call;
                  },
                ),
              };
            }),
          );
        };

      // Tool definitions are fetched lazily once per executor: only failed
      // calls need the schema, and most turns never fail.
      let toolDefinitionsPromise: Promise<
        Map<string, ToolCorrectionToolDefinition>
      > | null = null;
      const getToolDefinition = async (
        toolName: string,
      ): Promise<ToolCorrectionToolDefinition | null> => {
        if (!toolDefinitionsPromise) {
          toolDefinitionsPromise = window.snow
            .listMcpTools()
            .then(
              (tools) =>
                new Map(
                  tools.map(
                    (tool) =>
                      [
                        tool.name,
                        {
                          description: tool.description,
                          inputSchemaJson: tool.inputSchemaJson,
                        },
                      ] as const,
                  ),
                ),
            )
            .catch(() => new Map<string, ToolCorrectionToolDefinition>());
        }
        const definitions = await toolDefinitionsPromise;
        return definitions.get(toolName) ?? null;
      };

      /** 用纠错后的参数重新执行同一条工具调用。 */
      const executeCorrectedTool = async (
        correctedCall: ToolCallInfo,
        argsJson: string,
        workDir: string | undefined,
      ): Promise<string> => {
        const preparedArgs = prepareToolArguments(
          correctedCall.name,
          argsJson,
          {
            responseId,
            sessionId: isPendingSessionKey(effectiveKey)
              ? undefined
              : effectiveKey,
          },
        );
        if (
          correctedCall.name === "sub-agents-activate" &&
          !isPendingSessionKey(effectiveKey)
        ) {
          return executeSubAgentActivation(
            preparedArgs,
            effectiveKey,
            sessionDirId ?? ctx.directoryId ?? "",
            correctedCall.interactionId,
            checkpointIds,
          );
        }
        if (
          SUB_AGENT_MAIN_TOOL_NAMES.has(correctedCall.name) &&
          !isPendingSessionKey(effectiveKey)
        ) {
          return executeSubAgentMainTool(
            correctedCall.name,
            subAgentArgs(correctedCall, preparedArgs),
            effectiveKey,
            checkpointIds,
          );
        }
        return withToolWatchdog(
          window.snow.callMcpTool(
            correctedCall.name,
            preparedArgs,
            sessionDirId,
            checkpointIds,
            checkpointIds.length > 0 ? workDir : undefined,
            undefined,
            buildToolChunkHandler(correctedCall),
            correctedCall.interactionId,
            undefined,
            isPendingSessionKey(effectiveKey) ? undefined : effectiveKey,
          ),
          resolveToolWatchdogMs(correctedCall.name, preparedArgs),
        );
      };

      /** 把纠错进度同步到工具卡片。 */
      const publishToolCorrection = (
        correctedCall: ToolCallInfo,
        correction: ToolCorrectionState,
        settle: boolean,
        originalResult: string,
      ): void => {
        const succeeded = correction.attempts.find(
          (attempt) => attempt.status === "succeeded",
        );
        ctx.updateSessionMessages(effectiveKey, (currentMessages) =>
          currentMessages.map((message) => {
            if (message.id !== currentAssistantMessageId) return message;
            return {
              ...message,
              toolCalls: updateFirstMatchingToolCall(
                message.toolCalls,
                correctedCall,
                ["pending", "running", "completed", "error"],
                (currentToolCall) => {
                  if (succeeded?.result !== undefined) {
                    return {
                      ...currentToolCall,
                      arguments: succeeded.arguments,
                      result: succeeded.result,
                      status: "completed" as const,
                      correction,
                      streamingStdout: undefined,
                      streamingStderr: undefined,
                    };
                  }
                  if (settle) {
                    return {
                      ...currentToolCall,
                      result: originalResult,
                      status: "completed" as const,
                      correction,
                      streamingStdout: undefined,
                      streamingStderr: undefined,
                    };
                  }
                  return {
                    ...currentToolCall,
                    status: "running" as const,
                    result: undefined,
                    correction,
                    streamingStdout: undefined,
                    streamingStderr: undefined,
                  };
                },
              ),
            };
          }),
        );
      };

      /**
       * 落库纠错状态：应用重启后历史消息重建时仍能展开纠错树（审计）。
       * 与修正参数一样，仅在助手消息已持久化的会话中写入。
       */
      const persistToolCorrection = (
        correctedCall: ToolCallInfo,
        correction: ToolCorrectionState,
      ): void => {
        if (
          !responseId ||
          !correctedCall.callId ||
          isPendingSessionKey(effectiveKey)
        ) {
          return;
        }
        void window.snow
          .updateToolCallCorrection(
            effectiveKey,
            responseId,
            correctedCall.callId,
            serializeToolCorrectionState(correction),
          )
          .catch(() => undefined);
      };

      /** 让下一轮请求看到修正后的工具调用参数。 */
      const persistCorrectedArguments = async (
        correctedCall: ToolCallInfo,
        argsJson: string,
      ): Promise<void> => {
        if (
          !responseId ||
          !correctedCall.callId ||
          isPendingSessionKey(effectiveKey)
        ) {
          return;
        }
        await window.snow
          .updateToolCallArguments(
            effectiveKey,
            responseId,
            correctedCall.callId,
            argsJson,
          )
          .catch(() => undefined);
      };

      /**
       * 失败工具纠错入口：仅对可纠错的普通工具触发，最多 3 次。
       * `settle` 为 true 时，纠错失败会把卡片恢复为原始结果
       * （并行预启动路径不会再经过顺序路径的最终结算）。
       */
      const runCorrectionForTool = async (
        correctedCall: ToolCallInfo,
        failedResult: string,
        workDir: string | undefined,
        settle: boolean,
      ): Promise<ToolCorrectionSuccess | null> => {
        if (
          forcedSkillLoad ||
          !isToolCorrectionEligible(correctedCall.name) ||
          !isValidToolName(correctedCall.name) ||
          !(await ensureToolCorrectionPreference())
        ) {
          return null;
        }
        const failure = detectToolFailure(failedResult);
        if (!failure || isNonCorrectableToolFailure(failure)) {
          return null;
        }

        const outcome = await runToolCorrection({
          toolName: correctedCall.name,
          originalArguments: correctedCall.arguments,
          failedResult,
          apiProfile,
          conversationId: isPendingSessionKey(effectiveKey)
            ? undefined
            : effectiveKey,
          getToolDefinition: () => getToolDefinition(correctedCall.name),
          requestCorrection: (request) => window.snow.correctToolCall(request),
          authorize: async (argumentsJson, attempt) => {
            const authorizationCall: ToolCallInfo = {
              ...correctedCall,
              arguments: argumentsJson,
              interactionId: `${correctedCall.interactionId}-correction-${attempt}`,
              status: "pending",
              result: undefined,
              correction: undefined,
            };
            const decisions = await requestToolAuthorizations(
              [authorizationCall],
              effectiveKey,
              sessionDirId,
            );
            return decisions[0]?.status === "approved";
          },
          execute: async (argumentsJson) => {
            try {
              return await executeCorrectedTool(
                correctedCall,
                argumentsJson,
                workDir,
              );
            } catch (error) {
              abortTimedOutExecution(correctedCall, error);
              throw error;
            }
          },
          onUpdate: (correction) => {
            publishToolCorrection(
              correctedCall,
              correction,
              settle,
              failedResult,
            );
            persistToolCorrection(correctedCall, correction);
          },
          isCancelled: () => isRunCancelled(effectiveKey),
        });

        if (outcome) {
          await persistCorrectedArguments(correctedCall, outcome.arguments);
        }
        return outcome;
      };

      // Pre-start every approved call up front and store the pending promises
      // keyed by tool index; the main loop below simply awaits the already-
      // running promise when it reaches each pre-started tool call.
      //
      // beforeToolCall hooks are intentionally skipped for parallel
      // sub-agents-activate calls — the activation runs its own
      // beforeSubAgentStart / onSubAgentComplete lifecycle hooks. Image
      // generation and sub-agents-continue keep the normal hook semantics:
      // their beforeToolCall hook runs during pre-start (before the request is
      // fired / before the sub-agent is resumed) and their afterToolCall hook
      // runs in the main loop when the result is collected. runHook is a cheap
      // no-op when no rules are configured.
      const preStartedParallelTools = new Map<
        number,
        { promise: Promise<string>; afterHookEligible: boolean }
      >();

      // Limit in-flight renderer submissions, not real image generation. Async
      // pending releases this slot immediately; Rust owns upstream concurrency.
      // Sub-agent activations/continuations keep their independent scheduling.
      // 启动一个并行工具：置为 running、执行生图 beforeToolCall hook、
      // 立即发起请求（不 await）。返回是否成功启动（hook 中止返回 false，
      // 调用方应停止继续启动）。
      // 同一回合内的所有文件工具（包括子代理工具）只绑定到当前用户消息
      // 的 checkpoint，不能把后续工具结果写回更早消息的 expected 状态。
      const startParallelTool = async (idx: number): Promise<boolean> => {
        const parallelToolCall = toolCalls[idx];
        const isSubAgentActivation =
          parallelToolCall.name === "sub-agents-activate";
        const isSubAgentContinue =
          parallelToolCall.name === "sub-agents-continue";
        const isImageGen = parallelToolCall.name === "imagegen-generate";
        if (executorClosed || isRunCancelled(effectiveKey)) {
          resolveImageStart(idx);
          return false;
        }
        // Reserve before awaiting hooks so simultaneous completions cannot share a slot.
        if (isImageGen) activeImageGenCount++;
        let imageSlotHeld = isImageGen;
        const releaseImageSlot = (): void => {
          if (imageSlotHeld) {
            imageSlotHeld = false;
            activeImageGenCount--;
          }
        };
        const isInteractiveQuestionTool =
          parallelToolCall.name === "user-interaction-askUserQuestion";
        if (isInteractiveQuestionTool) {
          ctx.userQuestionTargetRef.current.set(
            parallelToolCall.interactionId,
            {
              sessionKey: effectiveKey,
              assistantMessageId: currentAssistantMessageId,
            },
          );
        }
        const detachInteractiveTarget = (): void => {
          if (isInteractiveQuestionTool) {
            ctx.userQuestionTargetRef.current.delete(
              parallelToolCall.interactionId,
            );
          }
        };

        // Mark running immediately so each card shows live progress while
        // the others are still working.
        ctx.updateSessionMessages(effectiveKey, (currentMessages) =>
          currentMessages.map((currentMessage) => {
            if (currentMessage.id !== currentAssistantMessageId) {
              return currentMessage;
            }
            return {
              ...currentMessage,
              toolCalls: updateFirstMatchingToolCall(
                currentMessage.toolCalls,
                parallelToolCall,
                "pending",
                (currentToolCall) => ({
                  ...currentToolCall,
                  status: "running" as const,
                  startedAt: Date.now(),
                }),
              ),
            };
          }),
        );

        let afterHookEligible = false;
        let interactiveHookAnswer: string | undefined;
        if (!isSubAgentActivation) {
          // Run the beforeToolCall hook for image generation before the
          // request is fired; a decision gate or abort prevents the start.
          // sub-agents-continue goes through the same gate (it resumes a real
          // sub-agent run and must obey the user's hook policy); only parallel
          // sub-agent activations skip it.
          try {
            const beforeHookContext = JSON.stringify({
              toolName: parallelToolCall.name,
              args: JSON.parse(parallelToolCall.arguments),
              cwd: sessionDirPath ?? "",
            });
            const beforeHookResult = await runHook(
              "beforeToolCall",
              sessionDirId ?? undefined,
              beforeHookContext,
            );
            if (beforeHookResult) {
              const { outcome } = beforeHookResult;
              if (outcome.kind === "needsDecision") {
                const approved = await awaitHookDecision(
                  effectiveKey,
                  currentAssistantMessageId,
                  beforeHookResult.record,
                );
                if (isRunCancelled(effectiveKey)) {
                  detachInteractiveTarget();
                  releaseImageSlot();
                  resolveImageStart(idx);
                  return false;
                }
                if (!approved) {
                  hookAborted = true;
                  hookAbortMessage = outcome.message;
                }
              } else {
                ctx.updateSessionMessages(effectiveKey, (currentMessages) =>
                  appendHookExecutionToMessage(
                    currentMessages,
                    beforeHookResult.record,
                    currentAssistantMessageId,
                  ),
                );
              }

              if (outcome.kind === "abort") {
                hookAborted = true;
                hookAbortMessage = outcome.message;
              }

              if (
                outcome.kind === "pass" &&
                outcome.output &&
                isInteractiveQuestionTool
              ) {
                interactiveHookAnswer = outcome.output;
              }

              if (outcome.kind === "warn") {
                pendingHookWarnings.push(outcome.message);
              }
            }
          } catch {
            // Hook execution failed — continue with the parallel start.
          }

          if (hookAborted) {
            const decisionAbortResult = JSON.stringify({
              success: false,
              error: "HOOK_DECISION_REJECTED",
              message: hookAbortMessage,
            });
            ctx.updateSessionMessages(effectiveKey, (currentMessages) =>
              currentMessages.map((currentMessage) =>
                currentMessage.id === currentAssistantMessageId
                  ? {
                      ...currentMessage,
                      toolCalls: updateFirstMatchingToolCall(
                        currentMessage.toolCalls,
                        parallelToolCall,
                        ["pending", "running"],
                        (currentToolCall) => ({
                          ...currentToolCall,
                          status: "error" as const,
                          result: decisionAbortResult,
                        }),
                      ),
                    }
                  : currentMessage,
              ),
            );
            // Store the settled error so the main loop can collect it in
            // index order; tools after this index are never started and the
            // sequential path marks them as aborted when it sees the flag.
            preStartedParallelTools.set(idx, {
              promise: Promise.resolve(decisionAbortResult),
              afterHookEligible: false,
            });
            detachInteractiveTarget();
            releaseImageSlot();
            resolveImageStart(idx);
            return false;
          }

          if (interactiveHookAnswer !== undefined) {
            const hookAnswer = interactiveHookAnswer;
            ctx.updateSessionMessages(effectiveKey, (currentMessages) =>
              currentMessages.map((currentMessage) =>
                currentMessage.id === currentAssistantMessageId
                  ? {
                      ...currentMessage,
                      toolCalls: updateFirstMatchingToolCall(
                        currentMessage.toolCalls,
                        parallelToolCall,
                        ["pending", "running"],
                        (currentToolCall) => ({
                          ...currentToolCall,
                          status: "completed" as const,
                          result: hookAnswer,
                        }),
                      ),
                    }
                  : currentMessage,
              ),
            );
            if (parallelToolCall.name === "user-interaction-askUserQuestion") {
              registerUserQuestionSettlement(idx, hookAnswer);
            }
            preStartedParallelTools.set(idx, {
              promise: Promise.resolve(hookAnswer),
              afterHookEligible: true,
            });
            detachInteractiveTarget();
            return true;
          }
          afterHookEligible = true;
        }

        if (executorClosed || isRunCancelled(effectiveKey)) {
          detachInteractiveTarget();
          releaseImageSlot();
          resolveImageStart(idx);
          return false;
        }

        // Fire without awaiting. The wrapper flips the tool call to
        // "completed" the instant it settles, so a fast call stops showing
        // a spinner in its header even while the sequential loop below is
        // still awaiting an earlier, slower one. When an image generation
        // settles, its freed concurrency slot immediately starts the next
        // queued image generation (sliding window).
        preStartedParallelTools.set(idx, {
          afterHookEligible,
          promise: (async () => {
            let parallelResult: string;
            try {
              if (isSubAgentActivation) {
                parallelResult = await executeSubAgentActivation(
                  parallelToolCall.arguments,
                  effectiveKey,
                  sessionDirId ?? ctx.directoryId ?? "",
                  parallelToolCall.interactionId,
                  checkpointIds,
                );
              } else if (SUB_AGENT_MAIN_TOOL_NAMES.has(parallelToolCall.name)) {
                // Every parent management tool uses the renderer executor, including
                // readonly getResult/wait. Native callMcpTool intentionally rejects them.
                // Keep the enclosing batch barrier and existing Hook/authorization flow.
                parallelResult = await executeSubAgentMainTool(
                  parallelToolCall.name,
                  subAgentArgs(parallelToolCall, parallelToolCall.arguments),
                  effectiveKey,
                  checkpointIds,
                );
              } else {
                parallelResult = await withToolWatchdog(
                  window.snow.callMcpTool(
                    parallelToolCall.name,
                    parallelToolCall.arguments,
                    sessionDirId,
                    checkpointIds,
                    checkpointIds.length > 0 ? sessionDirPath : undefined,
                    undefined,
                    buildToolChunkHandler(parallelToolCall),
                    parallelToolCall.interactionId,
                    undefined,
                    // 会话溯源（memory-save 由 Rust 分发层注入会话 ID）：
                    // PENDING 会话没有真实会话 id，传 undefined。
                    isPendingSessionKey(effectiveKey)
                      ? undefined
                      : effectiveKey,
                  ),
                  resolveToolWatchdogMs(
                    parallelToolCall.name,
                    parallelToolCall.arguments,
                  ),
                );
              }
            } catch (err) {
              abortTimedOutExecution(parallelToolCall, err);
              parallelResult = JSON.stringify({
                error: getErrorMessage(err),
              });
            }

            if (isImageGen) {
              runtime.watchReceipt(
                effectiveKey,
                parallelToolCall,
                parallelResult,
              );
            }
            detachInteractiveTarget();
            if (parallelToolCall.name === "user-interaction-askUserQuestion") {
              registerUserQuestionSettlement(idx, parallelResult);
            }

            ctx.updateSessionMessages(effectiveKey, (currentMessages) =>
              currentMessages.map((currentMessage) => {
                if (currentMessage.id !== currentAssistantMessageId) {
                  return currentMessage;
                }
                return {
                  ...currentMessage,
                  toolCalls: updateFirstMatchingToolCall(
                    currentMessage.toolCalls,
                    parallelToolCall,
                    ["pending", "running"],
                    (currentToolCall) =>
                      isImageGen
                        ? settleImageGenerationReceipt(
                            currentToolCall,
                            parallelResult,
                          )
                        : {
                            ...currentToolCall,
                            status:
                              (isSubAgentActivation || isSubAgentContinue) &&
                              isFailedSubAgentResult(parallelResult)
                                ? ("error" as const)
                                : ("completed" as const),
                            result: parallelResult,
                          },
                  ),
                };
              }),
            );

            if (isImageGen) {
              releaseImageSlot();
              // Async receipts release only a UI submission slot, never Rust's upstream permit.
              void drainImageGenQueue();
            }

            return parallelResult;
          })(),
        });

        resolveImageStart(idx);
        return true;
      };

      const drainImageGenQueue = async (): Promise<void> => {
        if (drainingImages) return;
        drainingImages = true;
        try {
          while (
            pendingImageGenQueue.length > 0 &&
            activeImageGenCount < maxConcurrentImageGen &&
            !executorClosed &&
            !hookAborted &&
            !isRunCancelled(effectiveKey)
          ) {
            const index = pendingImageGenQueue.shift()!;
            if (!(await startParallelTool(index))) break;
          }
        } finally {
          drainingImages = false;
          if (hookAborted || executorClosed || isRunCancelled(effectiveKey)) {
            for (const index of pendingImageGenQueue.splice(0))
              resolveImageStart(index);
          }
        }
      };

      // The native registry is the source of truth for side-effect-free tools.
      // Keep todo/config mutations out even if a future registry entry is too
      // broad: only todo "get" and config get/list are safe to overlap.
      let readonlyToolNames = new Set<string>();
      try {
        readonlyToolNames = new Set(await window.snow.listReadonlyTools());
      } catch {
        // Preserve the existing specialized parallel paths if the registry is
        // unavailable during startup or native bridge recovery.
      }
      const isTodoReadAction = (toolCall: ToolCallInfo): boolean => {
        try {
          return (
            (JSON.parse(toolCall.arguments || "{}") as { action?: unknown })
              .action === "get"
          );
        } catch {
          return false;
        }
      };

      const parallelIndices: number[] = [];
      for (let i = 0; i < toolCalls.length; i++) {
        const name = toolCalls[i].name;
        // 子代理激活与重新激活（continue）都必须在同一批次中并发运行：
        // 模型一次派发多个 continue 时要同时唤醒多个子代理，而不是串行等待。
        const isParallelizable =
          name === "sub-agents-activate" ||
          name === "sub-agents-continue" ||
          name === "imagegen-generate";
        const isReadonlyTool =
          readonlyToolNames.has(name) &&
          (name !== "todo-todo-manage" || isTodoReadAction(toolCalls[i]));
        // PENDING 会话还没有真实会话 id，无法关联子代理（执行器内部也会
        // 拒绝），因此不进入并行预启动，交由顺序路径返回结构化错误。
        const skipPendingSubAgent =
          (name === "sub-agents-activate" ||
            SUB_AGENT_MAIN_TOOL_NAMES.has(name)) &&
          isPendingSessionKey(effectiveKey);
        if (
          (isParallelizable || isReadonlyTool) &&
          !forcedSkillLoad &&
          !skipPendingSubAgent &&
          !(name === "imagegen-generate" && imageRegistrationError) &&
          authorizationDecisions[i].status !== "rejected" &&
          !validateToolCall(toolCalls[i])
        ) {
          parallelIndices.push(i);
        }
      }

      if (parallelIndices.length > 1 || imageMembers.length > 0) {
        // 从生图设置读取用户配置的最大并发生成数（1-8，设置面板可调）；
        // 读取失败或旧数据缺失时回退默认值。
        try {
          const raw = await window.snow.getSystemSettingValue(
            IMAGE_GEN_SETTING_CODE,
          );
          maxConcurrentImageGen =
            readImageGenSettingsJson(raw).maxConcurrentImages;
        } catch {
          // 设置读取失败时保持默认值，不阻塞生图流程。
        }

        // 预启动：子代理（激活 / 重新激活）全部立即启动（保持原有行为）；
        // 生图最多同时启动 maxConcurrentImageGen 个，其余排队，完成一个补一个。
        for (const idx of parallelIndices) {
          const parallelName = toolCalls[idx].name;
          const isSubAgent =
            parallelName === "sub-agents-activate" ||
            parallelName === "sub-agents-continue";
          if (
            isSubAgent ||
            parallelName !== "imagegen-generate" ||
            activeImageGenCount < maxConcurrentImageGen
          ) {
            if (!(await startParallelTool(idx))) {
              break;
            }
          } else {
            imageStartWaiters.set(
              idx,
              new Promise<void>((resolve) =>
                imageStartResolvers.set(idx, resolve),
              ),
            );
            pendingImageGenQueue.push(idx);
          }
        }
      }

      const executableUserQuestionIndices: number[] = [];
      for (let i = 0; i < toolCalls.length; i++) {
        if (
          toolCalls[i].name === "user-interaction-askUserQuestion" &&
          authorizationDecisions[i]?.status !== "rejected" &&
          !validateToolCall(toolCalls[i])
        ) {
          executableUserQuestionIndices.push(i);
        }
      }
      if (executableUserQuestionIndices.length > 1) {
        for (const idx of executableUserQuestionIndices) {
          if (!(await startParallelTool(idx))) {
            break;
          }
        }
      }

      for (let toolIndex = 0; toolIndex < toolCalls.length; toolIndex++) {
        const toolCall = toolCalls[toolIndex];
        if (isRunCancelled(effectiveKey)) {
          return null;
        }

        if (
          userQuestionCancelled &&
          toolCall.name !== "user-interaction-askUserQuestion"
        ) {
          const skippedResult = JSON.stringify({
            cancelled: true,
            skipped: true,
            reason: "Skipped because the user cancelled the question",
          });
          ctx.updateSessionMessages(effectiveKey, (currentMessages) =>
            currentMessages.map((currentMessage) => {
              if (currentMessage.id !== currentAssistantMessageId) {
                return currentMessage;
              }

              return {
                ...currentMessage,
                toolCalls: updateFirstMatchingToolCall(
                  currentMessage.toolCalls,
                  toolCall,
                  ["pending", "running"],
                  (currentToolCall) => ({
                    ...currentToolCall,
                    status: "completed" as const,
                    result: skippedResult,
                  }),
                ),
              };
            }),
          );
          structuredToolResults.push({
            name: toolCall.name,
            callId: toolCall.callId || "",
            result: skippedResult,
          });
          continue;
        }

        // A tool call that was pre-started for parallel execution (sub-agent
        // activation / image generation). Its wrapper already flipped the
        // tool-call status to "completed" the moment it settled (so the header
        // does not keep spinning while the loop waits on a slower sibling);
        // here we only collect its result for the model. The normal sequential
        // path (validation, callMcpTool) is bypassed, except that image
        // generation keeps its afterToolCall hook.
        // A queued image must not fall through and bypass the submission limit.
        if (!hookAborted) await imageStartWaiters.get(toolIndex);
        if (isRunCancelled(effectiveKey)) return null;
        if (preStartedParallelTools.has(toolIndex)) {
          const { promise, afterHookEligible } =
            preStartedParallelTools.get(toolIndex)!;
          let parallelResult = await promise;
          let parallelArguments = toolCall.arguments;
          let parallelCorrected = false;
          let parallelCorrectionReasoning: string | undefined;

          // Read-only tools are pre-started in parallel; their failures still
          // go through the correction agent before the afterToolCall hook.
          const correctionOutcome = await runCorrectionForTool(
            toolCall,
            parallelResult,
            sessionDirPath,
            true,
          );
          if (correctionOutcome) {
            parallelResult = correctionOutcome.result;
            parallelArguments = correctionOutcome.arguments;
            parallelCorrected = true;
            parallelCorrectionReasoning = correctionOutcome.reasoning;
          }

          if (afterHookEligible && parallelResult !== undefined) {
            try {
              const afterHookContext = JSON.stringify({
                toolName: toolCall.name,
                args: JSON.parse(parallelArguments),
                result: JSON.parse(parallelResult),
                cwd: sessionDirPath ?? "",
              });
              const afterHookResult = await runHook(
                "afterToolCall",
                sessionDirId ?? undefined,
                afterHookContext,
              );
              if (afterHookResult) {
                const { outcome } = afterHookResult;

                if (outcome.kind === "needsDecision") {
                  const approved = await awaitHookDecision(
                    effectiveKey,
                    currentAssistantMessageId,
                    afterHookResult.record,
                  );
                  if (isRunCancelled(effectiveKey)) {
                    return null;
                  }
                  if (!approved) {
                    hookAborted = true;
                    hookAbortMessage = outcome.message;
                    break;
                  }
                } else {
                  ctx.updateSessionMessages(effectiveKey, (currentMessages) =>
                    appendHookExecutionToMessage(
                      currentMessages,
                      afterHookResult.record,
                      currentAssistantMessageId,
                    ),
                  );
                }

                if (outcome.kind === "abort") {
                  hookAborted = true;
                  hookAbortMessage = outcome.message;
                  break;
                }

                if (outcome.kind === "warn") {
                  pendingHookWarnings.push(outcome.message);
                } else if (outcome.kind === "pass" && outcome.context) {
                  parallelResult = `${parallelResult}\n\n[Hook Context]\n${outcome.context}`;
                }
              }
            } catch {
              // Hook execution failed — keep original result
            }
          }

          const baseModelResult = formatMcpToolResultForModel(parallelResult);
          structuredToolResults.push({
            name: toolCall.name,
            callId: toolCall.callId || "",
            result: parallelCorrected
              ? appendToolCorrectionNote(
                  baseModelResult,
                  parallelCorrectionReasoning ?? "",
                )
              : baseModelResult,
            ...(parallelCorrected ? { corrected: true } : {}),
          });

          if (isRunCancelled(effectiveKey)) {
            return null;
          }
          continue;
        }

        let result: string | undefined;
        let skillLoadFailure: string | null = null;
        let fileTrackingRecorded = false;
        let correctedExecution = false;
        let correctedReasoning: string | undefined;
        const recordFileTracking = (
          argsJson: string = toolCall.arguments,
          force = false,
        ): void => {
          if (
            (!force && fileTrackingRecorded) ||
            isPendingSessionKey(effectiveKey) ||
            result === undefined
          )
            return;
          fileTrackingRecorded = true;
          const timestamp = Date.now();
          const coverage = extractFileChangeCoverageFromTool(
            toolCall.name,
            result,
          );
          if (coverage)
            ctx.recordFileChangeCoverage(effectiveKey, {
              ...coverage,
              agent: "main",
              timestamp,
            });
          for (const change of extractFileChangesFromTool(
            toolCall.name,
            argsJson,
            result,
          )) {
            ctx.recordFileChange(effectiveKey, {
              ...change,
              agent: "main",
              timestamp,
            });
          }
        };
        const authorizationDecision = authorizationDecisions[toolIndex];

        if (authorizationDecision.status === "rejected") {
          const rejectionReason =
            authorizationDecision.reason || "User declined tool execution";
          // 理由可能是富文本：用户粘贴的图片 / 长文本以 chip 承载，完整负载只放在
          // reason 字段（图片由 Rust 解析为多模态块、长文本片段随 JSON 交给模型）。
          // message 是同一段理由的副本，用可读摘要，避免同一张图片与同一段长文本
          // 在工具结果里重复出现（重复计费 + 上下文膨胀）。
          result = JSON.stringify({
            success: false,
            error: "TOOL_EXECUTION_DENIED",
            message: `Tool execution rejected. Reason: ${summarizeContentAsPlainText(
              rejectionReason,
            )}`,
            reason: rejectionReason,
            toolName: toolCall.name,
          });

          ctx.updateSessionMessages(effectiveKey, (currentMessages) =>
            currentMessages.map((currentMessage) => {
              if (currentMessage.id !== currentAssistantMessageId) {
                return currentMessage;
              }

              return {
                ...currentMessage,
                toolCalls: updateFirstMatchingToolCall(
                  currentMessage.toolCalls,
                  toolCall,
                  ["pending", "running"],
                  (currentToolCall) => ({
                    ...currentToolCall,
                    status: "error" as const,
                    result,
                  }),
                ),
              };
            }),
          );
        } else {
          const validationError =
            (toolCall.name === "imagegen-generate"
              ? imageRegistrationError
              : null) ?? validateToolCall(toolCall);
          let validationFailed = !!validationError;
          if (validationError) {
            result = validationError;
          } else {
            try {
              // Shared Snow-owned argument defaults/injections. The model's
              // sessionId is ignored: the dispatch layer owns the real one.
              let toolArgs = prepareToolArguments(
                toolCall.name,
                toolCall.arguments,
                {
                  responseId,
                  sessionId: isPendingSessionKey(effectiveKey)
                    ? undefined
                    : effectiveKey,
                },
              );

              // Persist conversation and tool-call binding so bash commands can
              // recover context after a restart.
              if (
                toolCall.name === "bash-terminal-execute" &&
                !isPendingSessionKey(effectiveKey)
              ) {
                try {
                  const parsedArgs = JSON.parse(toolArgs) as Record<
                    string,
                    unknown
                  >;
                  parsedArgs.sessionId = effectiveKey;
                  parsedArgs.conversationId = effectiveKey;
                  parsedArgs.toolCallId = toolCall.callId || undefined;
                  toolArgs = JSON.stringify(parsedArgs);
                } catch {
                  // If args are not valid JSON, let the tool fail naturally.
                }
              }

              let sensitiveAuthorizationToken: string | undefined;
              if (
                toolCall.name === "bash-terminal-execute" &&
                authorizationDecision.status === "approved" &&
                authorizationDecision.sensitiveCommandConfirmed === true
              ) {
                const parsedArgs = JSON.parse(toolArgs) as Record<
                  string,
                  unknown
                >;
                if (typeof parsedArgs.command !== "string") {
                  throw new Error("Sensitive command argument is missing");
                }
                sensitiveAuthorizationToken =
                  await window.snow.issueSensitiveCommandAuthorization(
                    parsedArgs.command,
                  );
              }

              const isInteractiveQuestionTool =
                toolCall.name === "user-interaction-askUserQuestion";
              if (isInteractiveQuestionTool) {
                ctx.userQuestionTargetRef.current.set(toolCall.interactionId, {
                  sessionKey: effectiveKey,
                  assistantMessageId: currentAssistantMessageId,
                });
              }

              try {
                // Execute beforeToolCall hooks (with matcher) before calling the tool.
                // This gate runs after authorization but before every actual tool call,
                // including YOLO auto-approved tools and sub-agent activation.
                // Unified exit-code semantics:
                //   0 = pass (stdout may auto-respond to interactive tools)
                //   1 = warn or decision gate
                //   2+ = abort (AI loop fully interrupted)
                try {
                  const beforeHookContext = JSON.stringify({
                    toolName: toolCall.name,
                    args: JSON.parse(toolArgs),
                    cwd: sessionDirPath ?? "",
                  });
                  const beforeHookResult = await runHook(
                    "beforeToolCall",
                    sessionDirId ?? undefined,
                    beforeHookContext,
                  );
                  if (beforeHookResult) {
                    const { outcome } = beforeHookResult;
                    if (outcome.kind === "needsDecision") {
                      const approved = await awaitHookDecision(
                        effectiveKey,
                        currentAssistantMessageId,
                        beforeHookResult.record,
                      );
                      if (isRunCancelled(effectiveKey)) {
                        return null;
                      }
                      if (!approved) {
                        hookAborted = true;
                        hookAbortMessage = outcome.message;
                      }
                    } else {
                      ctx.updateSessionMessages(
                        effectiveKey,
                        (currentMessages) =>
                          appendHookExecutionToMessage(
                            currentMessages,
                            beforeHookResult.record,
                            currentAssistantMessageId,
                          ),
                      );
                    }

                    if (outcome.kind === "abort") {
                      hookAborted = true;
                      hookAbortMessage = outcome.message;
                    }

                    // Interactive tools (askUserQuestion) can be
                    // auto-answered by the hook's stdout when the hook passes,
                    // bypassing the blocking user-interaction round-trip.
                    if (
                      outcome.kind === "pass" &&
                      outcome.output &&
                      isInteractiveQuestionTool
                    ) {
                      result = outcome.output;
                    }

                    if (outcome.kind === "warn") {
                      pendingHookWarnings.push(outcome.message);
                    }
                  }
                } catch {
                  // Hook execution failed — continue with tool call
                }

                if (hookAborted) {
                  const decisionAbortResult = JSON.stringify({
                    success: false,
                    error: "HOOK_DECISION_REJECTED",
                    message: hookAbortMessage,
                  });
                  ctx.updateSessionMessages(effectiveKey, (currentMessages) =>
                    currentMessages.map((currentMessage) =>
                      currentMessage.id === currentAssistantMessageId
                        ? {
                            ...currentMessage,
                            toolCalls: updateFirstMatchingToolCall(
                              currentMessage.toolCalls,
                              toolCall,
                              ["pending", "running"],
                              (currentToolCall) => ({
                                ...currentToolCall,
                                status: "error" as const,
                                result: decisionAbortResult,
                              }),
                            ),
                          }
                        : currentMessage,
                    ),
                  );
                  break;
                }

                ctx.updateSessionMessages(effectiveKey, (currentMessages) =>
                  currentMessages.map((currentMessage) => {
                    if (currentMessage.id !== currentAssistantMessageId) {
                      return currentMessage;
                    }

                    return {
                      ...currentMessage,
                      toolCalls: updateFirstMatchingToolCall(
                        currentMessage.toolCalls,
                        toolCall,
                        "pending",
                        (currentToolCall) => ({
                          ...currentToolCall,
                          status: "running" as const,
                          startedAt: Date.now(),
                        }),
                      ),
                    };
                  }),
                );

                if (
                  toolCall.name === "sub-agents-activate" &&
                  !isPendingSessionKey(effectiveKey)
                ) {
                  result = await executeSubAgentActivation(
                    toolArgs,
                    effectiveKey,
                    sessionDirId ?? ctx.directoryId ?? "",
                    toolCall.interactionId,
                    checkpointIds,
                  );
                } else if (
                  toolCall.name === "workflow-workflow-generate" &&
                  !isPendingSessionKey(effectiveKey)
                ) {
                  // 阻塞式工作流工具（与 sub-agents-activate 同语义）：注册挂起
                  // 句柄并等待用户在 UI 上确认执行或输入修改意见后再结算。
                  result = await executeWorkflowGenerate(
                    toolArgs,
                    effectiveKey,
                    sessionDirId ?? ctx.directoryId ?? "",
                    toolCall.interactionId,
                  );
                } else if (
                  toolCall.name === "workflow-workflow-resume" &&
                  !isPendingSessionKey(effectiveKey)
                ) {
                  // 失败节点续跑：主流程获用户同意后调用，直接在渲染进程
                  // 执行（阻塞至续跑完成，结果同执行汇总格式回传模型）。
                  // 第三参传工具调用 id：续跑事件据此标记来源，供卡片切换
                  // 画布宿主（generate 卡片收起、resume 卡片展开）。
                  result = await executeWorkflowResume(
                    toolArgs,
                    effectiveKey,
                    toolCall.interactionId ?? "",
                  );
                } else if (
                  SUB_AGENT_MAIN_TOOL_NAMES.has(toolCall.name) &&
                  !isPendingSessionKey(effectiveKey)
                ) {
                  // 主会话子代理管理工具（listSubAgents/continue）由渲染进程
                  // 直接执行：子代理运行时状态与会话隔离都在渲染进程，
                  // 不走 Rust callMcpTool。PENDING 会话没有真实会话 id，
                  // 无法关联子代理，直接拒绝。
                  result = await executeSubAgentMainTool(
                    toolCall.name,
                    subAgentArgs(toolCall, toolArgs),
                    effectiveKey,
                    checkpointIds,
                  );
                } else if (result === undefined) {
                  result = await withToolWatchdog(
                    window.snow.callMcpTool(
                      toolCall.name,
                      toolArgs,
                      sessionDirId,
                      checkpointIds,
                      checkpointIds.length > 0 ? sessionDirPath : undefined,
                      sensitiveAuthorizationToken,
                      buildToolChunkHandler(toolCall),
                      toolCall.interactionId,
                      undefined,
                      // 会话溯源（memory-save 由 Rust 分发层注入会话 ID）：
                      // PENDING 会话没有真实会话 id，传 undefined。
                      isPendingSessionKey(effectiveKey)
                        ? undefined
                        : effectiveKey,
                    ),
                    resolveToolWatchdogMs(toolCall.name, toolArgs),
                  );
                }

                if (
                  toolCall.name === "imagegen-generate" &&
                  result !== undefined
                )
                  runtime.watchReceipt(effectiveKey, toolCall, result);
                // Capture the raw failure before hooks append context to the result.
                if (forcedSkillLoad)
                  skillLoadFailure = detectToolFailure(result);
                // Capture actual execution before hooks can append/replace output
                // or abort the loop. The final settlement covers thrown errors.
                recordFileTracking();
                // Execute afterToolCall hooks (with matcher) after the tool call completes.
                // Unified exit-code semantics:
                //   0 = pass (stdout context appended to the tool result)
                //   1 = warn or decision gate
                //   2+ = abort (AI loop fully interrupted)
                if (result !== undefined) {
                  try {
                    const afterHookContext = JSON.stringify({
                      toolName: toolCall.name,
                      args: JSON.parse(toolArgs),
                      result:
                        forcedSkillLoad && !skillLoadFailure
                          ? result
                          : JSON.parse(result),
                      cwd: sessionDirPath ?? "",
                    });
                    const afterHookResult = await runHook(
                      "afterToolCall",
                      sessionDirId ?? undefined,
                      afterHookContext,
                    );
                    if (!afterHookResult) {
                      throw new Error("HOOK_NOT_CONFIGURED");
                    }
                    const { outcome } = afterHookResult;

                    // needsDecision pauses the AI loop until the user acts.
                    // awaitHookDecision appends the record together with its
                    // runtime resolver; non-decision outcomes are appended
                    // directly below.
                    if (outcome.kind === "needsDecision") {
                      const approved = await awaitHookDecision(
                        effectiveKey,
                        currentAssistantMessageId,
                        afterHookResult.record,
                      );
                      if (isRunCancelled(effectiveKey)) {
                        return null;
                      }
                      if (!approved) {
                        hookAborted = true;
                        hookAbortMessage = outcome.message;
                        break;
                      }
                    } else {
                      ctx.updateSessionMessages(
                        effectiveKey,
                        (currentMessages) =>
                          appendHookExecutionToMessage(
                            currentMessages,
                            afterHookResult.record,
                            currentAssistantMessageId,
                          ),
                      );
                    }

                    if (outcome.kind === "abort") {
                      hookAborted = true;
                      hookAbortMessage = outcome.message;
                      break;
                    }

                    if (outcome.kind === "warn") {
                      pendingHookWarnings.push(outcome.message);
                    } else if (outcome.kind === "pass" && outcome.context) {
                      result = `${result}\n\n[Hook Context]\n${outcome.context}`;
                    }
                  } catch {
                    // Hook execution failed — keep original result
                  }
                }
              } finally {
                if (isInteractiveQuestionTool) {
                  ctx.userQuestionTargetRef.current.delete(
                    toolCall.interactionId,
                  );
                }
              }
            } catch (err) {
              const errorMessage = getErrorMessage(err);
              abortTimedOutExecution(toolCall, err);
              // For streaming tools (e.g. terminal-execute) the process
              // may have produced partial output before failing/timing
              // out. Recover that output from the session state so the
              // AI receives it together with the error and can reason
              // about the situation instead of the loop stalling.
              if (toolCall.name === "bash-terminal-execute") {
                const liveToolCall = findLiveToolCall(toolCall);
                const partialStdout = liveToolCall?.streamingStdout ?? "";
                const partialStderr = liveToolCall?.streamingStderr ?? "";
                const partialOutput = [partialStdout, partialStderr]
                  .filter(Boolean)
                  .join("\n");
                result = JSON.stringify({
                  error: errorMessage,
                  stdout: partialStdout,
                  stderr: partialStderr,
                  partialOutput:
                    partialOutput.length > 0 ? partialOutput : undefined,
                });
              } else {
                result = JSON.stringify({ error: errorMessage });
              }
            }
          }

          // Tool failed (including validation errors): let the correction
          // agent repair the arguments and re-execute, up to 3 times. A
          // successful repair replaces both the call arguments and the result
          // before the card settles and the next model request is built.
          if (!hookAborted && result !== undefined) {
            const correctionOutcome = await runCorrectionForTool(
              toolCall,
              result,
              sessionDirPath,
              false,
            );
            if (correctionOutcome) {
              result = correctionOutcome.result;
              correctedExecution = true;
              correctedReasoning = correctionOutcome.reasoning;
              validationFailed = false;
              recordFileTracking(correctionOutcome.arguments, true);
            }
          }

          if (forcedSkillLoad) {
            skillLoadFailure ??= detectToolFailure(result);
          }
          ctx.updateSessionMessages(effectiveKey, (currentMessages) =>
            currentMessages.map((currentMessage) => {
              if (currentMessage.id !== currentAssistantMessageId) {
                return currentMessage;
              }

              return {
                ...currentMessage,
                toolCalls: updateFirstMatchingToolCall(
                  currentMessage.toolCalls,
                  toolCall,
                  ["pending", "running"],
                  (currentToolCall) =>
                    toolCall.name === "imagegen-generate" &&
                    result !== undefined
                      ? settleImageGenerationReceipt(currentToolCall, result)
                      : {
                          ...currentToolCall,
                          status:
                            validationFailed || !!skillLoadFailure
                              ? ("error" as const)
                              : (toolCall.name === "sub-agents-activate" ||
                                    toolCall.name === "sub-agents-continue") &&
                                  isFailedSubAgentResult(result)
                                ? ("error" as const)
                                : ("completed" as const),
                          result,
                        },
                ),
              };
            }),
          );
        }

        if (forcedSkillLoad && !forcedSkillError) {
          const failure = skillLoadFailure ?? detectToolFailure(result);
          if (failure) forcedSkillError = result || failure;
        }
        if (toolCall.name === "user-interaction-askUserQuestion") {
          registerUserQuestionSettlement(toolIndex, result!);
        }

        // Cover rejections and thrown errors, without double-recording execution.
        recordFileTracking();
        const baseModelToolResult = formatMcpToolResultForModel(result!);
        const modelToolResult = correctedExecution
          ? appendToolCorrectionNote(
              baseModelToolResult,
              correctedReasoning ?? "",
            )
          : baseModelToolResult;
        structuredToolResults.push({
          name: toolCall.name,
          callId: toolCall.callId || "",
          result: modelToolResult,
          ...(correctedExecution ? { corrected: true } : {}),
        });

        if (isRunCancelled(effectiveKey)) {
          return null;
        }
      }

      return {
        structuredToolResults,
        hookAborted,
        hookAbortMessage,
        userQuestionCancelled,
        pendingHookWarnings,
        forcedSkillError,
      };
    } finally {
      executorClosed = true;
      pendingImageGenQueue.length = 0;
      for (const resolve of imageStartResolvers.values()) resolve();
      imageStartResolvers.clear();
      // Seal cancels registered/unsubmitted members only. Accepted queued/running
      // tasks outlive hooks and this agent invocation.
      if (imageBatchId) await runtime.seal(effectiveKey, imageBatchId);
    }
  };
}
