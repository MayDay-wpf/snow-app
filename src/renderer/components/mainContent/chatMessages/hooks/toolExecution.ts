import {
  directoryIdToPath,
  formatMcpToolResultForModel,
  getErrorMessage,
  isUserQuestionCancellationResult,
  updateFirstMatchingToolCall,
  validateToolCall,
} from "../utils/conversationHelpers";
import {
  PLAN_APPROVAL_TOOL_NAME,
  isStructuredPlanApproval,
} from "./agentLoopHelpers";
import { appendHookExecutionToMessage, runHook } from "./hookOutcome";
import { extractFileChangeFromTool } from "./fileChangeTracking";
import { SUB_AGENT_MAIN_TOOL_NAMES } from "./subAgentActivation";
import { isPendingSessionKey } from "../utils/conversationTypes";
import { injectSessionIdIntoToolArgs } from "../utils/toolSessionMetadata";
import type {
  ConversationContextValue,
  HookExecutionRecord,
  ToolAuthorizationDecision,
  ToolCallInfo,
} from "../utils/conversationTypes";
import type { BashStreamChunk } from "../../../../../preload";
import {
  DEFAULT_IMAGE_GEN_MAX_CONCURRENT,
  IMAGE_GEN_SETTING_CODE,
} from "../../../sidebar/imagegenSettings/constants";
import { readImageGenSettingsJson } from "../../../sidebar/imagegenSettings/utils";

export type ToolExecutionResult = {
  structuredToolResults: { name: string; callId: string; result: string }[];
  hookAborted: boolean;
  hookAbortMessage: string;
  userQuestionCancelled: boolean;
  pendingHookWarnings: string[];
};

const isFailedSubAgentActivationResult = (
  result: string | undefined
): boolean => {
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

export type ToolExecutorDeps = {
  ctx: ConversationContextValue;
  effectiveKey: string;
  currentAssistantMessageId: string;
  checkpointIds: string[];
  sessionDirId: string | undefined;
  directoryPath: string | undefined;
  responseId: string | undefined;
  isRunCancelled: (key: string) => boolean;
  awaitHookDecision: (
    key: string,
    messageId: string,
    record: HookExecutionRecord
  ) => Promise<boolean>;
  executeSubAgentActivation: (
    argsJson: string,
    parentConversationId: string,
    dirId: string,
    toolCallInteractionId: string | undefined,
    checkpointIds: string[]
  ) => Promise<string>;
  executeSubAgentMainTool: (
    toolName: string,
    argsJson: string,
    parentConversationId: string,
    checkpointIds: string[]
  ) => Promise<string>;
  planApprovedSessionKeysRef: { current: Set<string> };
  planModeRef: { current: boolean };
};

export function createToolExecutor(
  deps: ToolExecutorDeps
): (
  toolCalls: ToolCallInfo[],
  authorizationDecisions: ToolAuthorizationDecision[]
) => Promise<ToolExecutionResult | null> {
  const {
    ctx,
    effectiveKey,
    currentAssistantMessageId,
    checkpointIds,
    sessionDirId,
    directoryPath,
    responseId,
    isRunCancelled,
    awaitHookDecision,
    executeSubAgentActivation,
    executeSubAgentMainTool,
    planApprovedSessionKeysRef,
    planModeRef,
  } = deps;

  // 工具 cwd / checkpoint 目录跟随会话自己的目录,而非运行时全局
  // activeDirectory:切换项目后旧会话仍在自己的目录执行,checkpoint
  // 与 cwd 天然一致,不会被后端以目录不匹配拦截。
  const sessionDirPath = directoryIdToPath(sessionDirId) ?? directoryPath;

  return async (
    toolCalls: ToolCallInfo[],
    authorizationDecisions: ToolAuthorizationDecision[]
  ): Promise<ToolExecutionResult | null> => {
    // Per-conversation mode snapshot: the Rust write gate must see THIS
    // session's Plan Mode, never the live global ref (another conversation
    // toggling its modes must not weaken or strengthen this session's gate).
    const sessionPlanMode = (key: string): boolean =>
      ctx.sessionsRefData.current.get(key)?.planMode ?? planModeRef.current;
    const structuredToolResults: {
      name: string;
      callId: string;
      result: string;
    }[] = [];
    let userQuestionCancelled = false;
    let hookAborted = false;
    let hookAbortMessage = "";
    const pendingHookWarnings: string[] = [];

    // Shared streaming-chunk handler factory used by both the sequential
    // path and the parallel pre-start path, so concurrent tool calls
    // stream into their own card independently: interactive-session /
    // tool-execution ids, terminal stdout/stderr and imagegen
    // partial-image previews are routed by matching the tool call.
    const buildToolChunkHandler =
      (toolCall: ToolCallInfo) =>
      (chunk: BashStreamChunk): void => {
        if (!chunk.data) {
          return;
        }
        if (
          chunk.stream === "interactive_session" ||
          chunk.stream === "tool_execution"
        ) {
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
                    interactiveSessionId:
                      chunk.stream === "interactive_session"
                        ? chunk.data
                        : currentToolCall.interactiveSessionId,
                    toolExecutionId:
                      chunk.stream === "tool_execution"
                        ? chunk.data
                        : currentToolCall.toolExecutionId,
                  })
                ),
              };
            })
          );
          return;
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
                (currentToolCall) => {
                  if (chunk.stream === "stdout" || chunk.stream === "stderr") {
                    return {
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
                    };
                  }

                  // 生图工具的流式预览：chunk.data 为
                  // {"type":"partial_image","index":N,"mimeType":"...","data":"<base64>"}
                  if (chunk.stream === "imagegen") {
                    try {
                      const parsed: unknown = JSON.parse(chunk.data);
                      if (
                        typeof parsed === "object" &&
                        parsed !== null &&
                        !Array.isArray(parsed) &&
                        (parsed as Record<string, unknown>).type ===
                          "partial_image" &&
                        typeof (parsed as Record<string, unknown>).data ===
                          "string" &&
                        typeof (parsed as Record<string, unknown>).mimeType ===
                          "string" &&
                        typeof (parsed as Record<string, unknown>).index ===
                          "number"
                      ) {
                        const record = parsed as Record<string, unknown>;
                        const incoming = {
                          index: record.index as number,
                          mimeType: record.mimeType as string,
                          data: record.data as string,
                        };
                        const existing = currentToolCall.streamingImages ?? [];
                        const next = [
                          ...existing.filter(
                            (image) => image.index !== incoming.index
                          ),
                          incoming,
                        ].sort((a, b) => a.index - b.index);
                        return {
                          ...currentToolCall,
                          streamingImages: next,
                        };
                      }
                    } catch {
                      // 忽略无法解析的流式数据
                    }
                  }

                  return currentToolCall;
                }
              ),
            };
          })
        );
      };

    // When the model requests multiple parallelizable tool calls in a single
    // tool batch (sub-agent activations, image generations) they must run
    // concurrently, not queued one after another. Pre-start every approved
    // call up front and store the pending promises keyed by tool index; the
    // main loop below simply awaits the already-running promise when it
    // reaches each pre-started tool call.
    //
    // beforeToolCall hooks are intentionally skipped for parallel sub-agents
    // — the activation runs its own beforeSubAgentStart / onSubAgentComplete
    // lifecycle hooks. Image generation keeps the normal hook semantics: its
    // beforeToolCall hook runs during pre-start (before the request is
    // fired) and its afterToolCall hook runs in the main loop when the
    // result is collected. runHook is a cheap no-op when no rules are
    // configured.
    const preStartedParallelTools = new Map<
      number,
      { promise: Promise<string>; afterHookEligible: boolean }
    >();

    // 同一批次中生图请求的最大并发数（滑动窗口）：预启动时最多同时
    // 发起 maxConcurrentImageGen 个请求，其余进入等待队列；每完成一个，
    // 队列头部的下一个立即启动，任何时刻在飞的生图请求不超过该值。
    // 生图服务商（OpenAI gpt-image / Gemini Imagen）都有速率限制，且
    // 每张图的 base64 结果体积很大，无上限并发容易触发限流或造成内存
    // 压力。子代理激活不受此限制（保持原有行为）。
    const pendingImageGenQueue: number[] = [];
    let activeImageGenCount = 0;
    // 启动一个并行工具：置为 running、执行生图 beforeToolCall hook、
    // 立即发起请求（不 await）。返回是否成功启动（hook 中止返回 false，
    // 调用方应停止继续启动）。
    // 同一回合内的所有文件工具（包括子代理工具）只绑定到当前用户消息
    // 的 checkpoint，不能把后续工具结果写回更早消息的 expected 状态。
    const startParallelTool = async (idx: number): Promise<boolean> => {
      const parallelToolCall = toolCalls[idx];
      const isSubAgent = parallelToolCall.name === "sub-agents-activate";
      const isImageGen = parallelToolCall.name === "imagegen-generate";

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
              })
            ),
          };
        })
      );

      let afterHookEligible = false;
      if (!isSubAgent) {
        // Run the beforeToolCall hook for image generation before the
        // request is fired; a decision gate or abort prevents the start.
        try {
          const beforeHookContext = JSON.stringify({
            toolName: parallelToolCall.name,
            args: JSON.parse(parallelToolCall.arguments),
            cwd: sessionDirPath ?? "",
          });
          const beforeHookResult = await runHook(
            "beforeToolCall",
            sessionDirId ?? undefined,
            beforeHookContext
          );
          if (beforeHookResult) {
            const { outcome } = beforeHookResult;
            if (outcome.kind === "needsDecision") {
              const approved = await awaitHookDecision(
                effectiveKey,
                currentAssistantMessageId,
                beforeHookResult.record
              );
              if (isRunCancelled(effectiveKey)) {
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
                  currentAssistantMessageId
                )
              );
            }

            if (outcome.kind === "abort") {
              hookAborted = true;
              hookAbortMessage = outcome.message;
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
                      })
                    ),
                  }
                : currentMessage
            )
          );
          // Store the settled error so the main loop can collect it in
          // index order; tools after this index are never started and the
          // sequential path marks them as aborted when it sees the flag.
          preStartedParallelTools.set(idx, {
            promise: Promise.resolve(decisionAbortResult),
            afterHookEligible: false,
          });
          return false;
        }
        afterHookEligible = true;
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
            if (isSubAgent) {
              parallelResult = await executeSubAgentActivation(
                parallelToolCall.arguments,
                effectiveKey,
                sessionDirId ?? ctx.directoryId ?? "",
                parallelToolCall.interactionId,
                checkpointIds
              );
            } else {
              parallelResult = await window.snow.callMcpTool(
                parallelToolCall.name,
                parallelToolCall.arguments,
                sessionDirId,
                checkpointIds,
                checkpointIds.length > 0 ? sessionDirPath : undefined,
                undefined,
                buildToolChunkHandler(parallelToolCall),
                parallelToolCall.interactionId,
                undefined,
                sessionPlanMode(effectiveKey),
                planApprovedSessionKeysRef.current.has(effectiveKey)
              );
            }
          } catch (err) {
            parallelResult = JSON.stringify({
              error: getErrorMessage(err),
            });
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
                  (currentToolCall) => ({
                    ...currentToolCall,
                    status:
                      isSubAgent &&
                      isFailedSubAgentActivationResult(parallelResult)
                        ? ("error" as const)
                        : ("completed" as const),
                    result: parallelResult,
                  })
                ),
              };
            })
          );

          if (isImageGen) {
            activeImageGenCount--;
            // 腾出的并发槽位立即补位：启动等待队列中的下一个生图请求。
            while (pendingImageGenQueue.length > 0) {
              const nextIdx = pendingImageGenQueue.shift()!;
              if (!(await startParallelTool(nextIdx))) {
                // Hook 中止：不再启动剩余队列。
                break;
              }
              activeImageGenCount++;
            }
          }

          return parallelResult;
        })(),
      });

      return true;
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
      const isParallelizable =
        name === "sub-agents-activate" || name === "imagegen-generate";
      const isReadonlyTool =
        readonlyToolNames.has(name) &&
        (name !== "todo-todo-manage" || isTodoReadAction(toolCalls[i]));
      const skipPendingSubAgent =
        name === "sub-agents-activate" && isPendingSessionKey(effectiveKey);
      if (
        (isParallelizable || isReadonlyTool) &&
        !skipPendingSubAgent &&
        authorizationDecisions[i].status !== "rejected" &&
        !validateToolCall(toolCalls[i])
      ) {
        parallelIndices.push(i);
      }
    }

    if (parallelIndices.length > 1) {
      // 从生图设置读取用户配置的最大并发生成数（1-8，设置面板可调）；
      // 读取失败或旧数据缺失时回退默认值。
      let maxConcurrentImageGen = DEFAULT_IMAGE_GEN_MAX_CONCURRENT;
      try {
        const raw = await window.snow.getSystemSettingValue(
          IMAGE_GEN_SETTING_CODE
        );
        maxConcurrentImageGen =
          readImageGenSettingsJson(raw).maxConcurrentImages;
      } catch {
        // 设置读取失败时保持默认值，不阻塞生图流程。
      }

      // 预启动：子代理全部立即启动（保持原有行为）；生图最多同时
      // 启动 maxConcurrentImageGen 个，其余排队，完成一个补一个。
      for (const idx of parallelIndices) {
        const isSubAgent = toolCalls[idx].name === "sub-agents-activate";
        if (
          isSubAgent ||
          toolCalls[idx].name !== "imagegen-generate" ||
          activeImageGenCount < maxConcurrentImageGen
        ) {
          if (!(await startParallelTool(idx))) {
            break;
          }
          if (toolCalls[idx].name === "imagegen-generate") {
            activeImageGenCount++;
          }
        } else {
          pendingImageGenQueue.push(idx);
        }
      }
    }

    for (let toolIndex = 0; toolIndex < toolCalls.length; toolIndex++) {
      const toolCall = toolCalls[toolIndex];
      if (isRunCancelled(effectiveKey)) {
        return null;
      }

      if (userQuestionCancelled) {
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
                })
              ),
            };
          })
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
      if (preStartedParallelTools.has(toolIndex)) {
        const { promise, afterHookEligible } =
          preStartedParallelTools.get(toolIndex)!;
        let parallelResult = await promise;

        if (afterHookEligible && parallelResult !== undefined) {
          try {
            const afterHookContext = JSON.stringify({
              toolName: toolCall.name,
              args: JSON.parse(toolCall.arguments),
              result: JSON.parse(parallelResult),
              cwd: sessionDirPath ?? "",
            });
            const afterHookResult = await runHook(
              "afterToolCall",
              sessionDirId ?? undefined,
              afterHookContext
            );
            if (afterHookResult) {
              const { outcome } = afterHookResult;

              if (outcome.kind === "needsDecision") {
                const approved = await awaitHookDecision(
                  effectiveKey,
                  currentAssistantMessageId,
                  afterHookResult.record
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
                    currentAssistantMessageId
                  )
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

        structuredToolResults.push({
          name: toolCall.name,
          callId: toolCall.callId || "",
          result: formatMcpToolResultForModel(parallelResult),
        });

        if (isRunCancelled(effectiveKey)) {
          return null;
        }
        continue;
      }

      let result: string | undefined;
      const authorizationDecision = authorizationDecisions[toolIndex];

      if (authorizationDecision.status === "rejected") {
        const rejectionReason =
          authorizationDecision.reason || "User declined tool execution";
        result = JSON.stringify({
          success: false,
          error: "TOOL_EXECUTION_DENIED_BY_USER",
          message: `Tool execution rejected by user. Reason: ${rejectionReason}`,
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
                })
              ),
            };
          })
        );
      } else {
        const validationError = validateToolCall(toolCall);
        const isValidationError = !!validationError;
        if (validationError) {
          result = validationError;
        } else {
          try {
            // Force-override sessionId for todo-manage. Only add actions
            // receive responseId, because rollback tracking applies solely
            // to TODO items created by that action.
            let toolArgs = toolCall.arguments;
            if (
              toolCall.name === "todo-todo-manage" &&
              !isPendingSessionKey(effectiveKey)
            ) {
              try {
                const parsedArgs = JSON.parse(toolArgs) as Record<
                  string,
                  unknown
                >;
                parsedArgs.sessionId = effectiveKey;
                if (parsedArgs.action === "add" && responseId) {
                  parsedArgs.responseId = responseId;
                }
                toolArgs = JSON.stringify(parsedArgs);
              } catch {
                // If args are not valid JSON, let the tool fail naturally.
              }
            }

            // Attach Snow-owned session metadata to command and persistent
            // terminal tools. Pending conversations do not yet have a stable ID.
            toolArgs = injectSessionIdIntoToolArgs(
              toolCall.name,
              toolArgs,
              isPendingSessionKey(effectiveKey) ? undefined : effectiveKey
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
                  parsedArgs.command
                );
            }

            const isInteractiveQuestionTool =
              toolCall.name === "user-interaction-askUserQuestion" ||
              toolCall.name === PLAN_APPROVAL_TOOL_NAME;
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
                  beforeHookContext
                );
                if (beforeHookResult) {
                  const { outcome } = beforeHookResult;
                  if (outcome.kind === "needsDecision") {
                    const approved = await awaitHookDecision(
                      effectiveKey,
                      currentAssistantMessageId,
                      beforeHookResult.record
                    );
                    if (isRunCancelled(effectiveKey)) {
                      return null;
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
                        currentAssistantMessageId
                      )
                    );
                  }

                  if (outcome.kind === "abort") {
                    hookAborted = true;
                    hookAbortMessage = outcome.message;
                  }

                  // Interactive tools (askUserQuestion / plan approval) can be
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
                            })
                          ),
                        }
                      : currentMessage
                  )
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
                      })
                    ),
                  };
                })
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
                  checkpointIds
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
                  toolArgs,
                  effectiveKey,
                  checkpointIds
                );
              } else if (result === undefined) {
                result = await window.snow.callMcpTool(
                  toolCall.name,
                  toolArgs,
                  sessionDirId,
                  checkpointIds,
                  checkpointIds.length > 0 ? sessionDirPath : undefined,
                  sensitiveAuthorizationToken,
                  buildToolChunkHandler(toolCall),
                  toolCall.interactionId,
                  undefined,
                  sessionPlanMode(effectiveKey),
                  planApprovedSessionKeysRef.current.has(effectiveKey)
                );

                // Record successful file modifications (filesystem-create /
                // filesystem-replace_edit) into the conversation's file-change
                // stats. Done right after the tool returns — before
                // afterToolCall hooks may append context to the result — so
                // the success JSON is always parseable. The pending session
                // has no persisted conversation, so its changes are skipped;
                // they land in the real session once it is created.
                if (
                  !isPendingSessionKey(effectiveKey) &&
                  result !== undefined
                ) {
                  const fileChange = extractFileChangeFromTool(
                    toolCall.name,
                    toolCall.arguments,
                    result
                  );
                  if (fileChange) {
                    ctx.recordFileChange(effectiveKey, {
                      ...fileChange,
                      agent: "main",
                      timestamp: Date.now(),
                    });
                  }
                }
              }

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
                    result: JSON.parse(result),
                    cwd: sessionDirPath ?? "",
                  });
                  const afterHookResult = await runHook(
                    "afterToolCall",
                    sessionDirId ?? undefined,
                    afterHookContext
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
                      afterHookResult.record
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
                        currentAssistantMessageId
                      )
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
                  toolCall.interactionId
                );
              }
            }
          } catch (err) {
            const errorMessage = getErrorMessage(err);
            // For streaming tools (e.g. terminal-execute) the process
            // may have produced partial output before failing/timing
            // out. Recover that output from the session state so the
            // AI receives it together with the error and can reason
            // about the situation instead of the loop stalling.
            if (toolCall.name === "bash-terminal-execute") {
              const sessionMessages =
                ctx.sessionsRef.current?.[effectiveKey]?.messages ?? [];
              const assistantMessage = sessionMessages.find(
                (m) => m.id === currentAssistantMessageId
              );
              const liveToolCall = assistantMessage?.toolCalls?.find(
                (tc) =>
                  tc.interactionId === toolCall.interactionId &&
                  tc.name === toolCall.name
              );
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
                  status: isValidationError
                    ? ("error" as const)
                    : toolCall.name === "sub-agents-activate" &&
                      isFailedSubAgentActivationResult(result)
                    ? ("error" as const)
                    : ("completed" as const),
                  result,
                })
              ),
            };
          })
        );
      }

      if (
        toolCall.name === "user-interaction-askUserQuestion" &&
        isUserQuestionCancellationResult(result!)
      ) {
        userQuestionCancelled = true;
      }

      // Only the dedicated Plan Mode tool's structured approved=true result
      // can unlock Rust filesystem writes for this conversation's task.
      if (
        sessionPlanMode(effectiveKey) &&
        !planApprovedSessionKeysRef.current.has(effectiveKey) &&
        isStructuredPlanApproval(toolCall.name, result!)
      ) {
        planApprovedSessionKeysRef.current.add(effectiveKey);
      }

      const modelToolResult = formatMcpToolResultForModel(result!);
      structuredToolResults.push({
        name: toolCall.name,
        callId: toolCall.callId || "",
        result: modelToolResult,
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
    };
  };
}
