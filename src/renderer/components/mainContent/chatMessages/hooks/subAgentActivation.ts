import type {
  ChatConversationMessage,
  ConversationContextValue,
  SubAgentSessionEvent,
  ToolAuthorizationDecision,
  ToolCallInfo,
} from "../utils/conversationTypes";
import type { ChatConversationRecord } from "../../../../../preload";
import {
  createMessageId,
  directoryIdToPath,
  formatMessageTime,
  formatMcpToolResultForModel,
  formatToolResultsContent,
  getErrorMessage,
  parseToolCalls,
  updateFirstMatchingToolCall,
} from "../utils/conversationHelpers";
import { resolveResponseDisposition } from "../utils/responseDisposition";
import { appendHookExecutionToMessage, runHook } from "./hookOutcome";
import { extractFileChangeFromTool } from "./fileChangeTracking";
import { injectSessionIdIntoToolArgs } from "../utils/toolSessionMetadata";
import type { SubAgentRuntimeConfig } from "./subAgentRuntimeConfig";
import {
  parseSubAgentTools,
  resolveSubAgentRuntimeConfig,
} from "./subAgentRuntimeConfig";
import {
  getResponsesFastModeFromConfig,
  getThinkingValueFromConfig,
} from "../../chatInput/configThinking";
import {
  PARENT_PLAN_APPROVAL_REQUIRED,
  accumulateConversationRunStats,
  accumulateRunTokenUsage,
  createStreamChunkHandler,
  createStreamIdHandler,
  resetRunStreamMetrics,
} from "./agentLoopHelpers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** 子代理队友通信工具：所有子代理默认携带（Rust collect_allowed_mcp_tools
 *  无条件追加定义；执行在渲染进程完成）。 */
export const SUB_AGENT_COMMS_TOOL_NAMES = new Set([
  "sub-agents-listTeammates",
  "sub-agents-sendMessage",
]);

/** 主会话专用的子代理管理工具：仅主会话工具集可见（Rust collect_allowed_
 *  mcp_tools 对子代理显式过滤），用于查询当前会话子代理并继续其运行。 */
export const SUB_AGENT_MAIN_TOOL_NAMES = new Set([
  "sub-agents-listSubAgents",
  "sub-agents-continue",
]);

/** 子代理恢复器：主会话 sub-agents-continue 重新激活已结束子代理的入口。
 * resume 返回 JSON 字符串（success/queued/summary），与工具结果格式一致。
 * 会话持久化到 DB，应用重启后可由 restoreSubAgentResumer 按需重建。 */
export type SubAgentResumer = {
  parentConversationId: string;
  agentId: string;
  agentName: string;
  resume: (
    messages: { role: "user"; content: string }[],
    checkpointIds?: string[]
  ) => Promise<string>;
};

/** 本次应用运行期间激活（或从 DB 恢复）的子代理恢复器注册表
 * （key = 子代理会话 id）。子代理运行结束后注册保留，主会话可凭它
 * 重新激活；应用重启后注册表清空，continue 时按需从 DB 重建。 */
const subAgentResumers = new Map<string, SubAgentResumer>();

type CheckpointIdsRef = { current: string[] };

export type SubAgentActivationDeps = {
  ctx: ConversationContextValue;
  requestToolAuthorizations: (
    toolCalls: ToolCallInfo[],
    conversationId: string,
    projectId?: string
  ) => Promise<ToolAuthorizationDecision[]>;
  parentApiProfile: string | undefined;
  parentModel: string | undefined;
  parentThinkingStrength: string | undefined;
  /** Effective Fast Mode captured by the parent run; explicit false is valid. */
  parentResponsesFastMode?: boolean | null;
  planApprovedSessionKeysRef: { current: Set<string> };
};

// ---------------------------------------------------------------------------
// 子代理运行工厂（激活与重启后从 DB 恢复共用）
// ---------------------------------------------------------------------------

export type SubAgentRunLoop = (
  subMessages: {
    role: "user" | "assistant" | "system" | "developer" | "tool";
    content: string;
  }[],
  resumeAfterCompaction?: boolean
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
  planApprovedSessionKeysRef: { current: Set<string> };
  isSubCancelled: () => boolean;
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
    planApprovedSessionKeysRef,
    isSubCancelled,
  } = deps;
  const agentName = runtimeConfig.agentName;
  const subAgentToolsJson = runtimeConfig.toolsJson;
  const allowedTools = parseSubAgentTools(runtimeConfig.toolsJson);

  // ---------------------------------------------------------------------
  // 子代理队友通信（sub-agents-listTeammates / sub-agents-sendMessage）
  // 在渲染进程直接执行：在线队友状态（subAgentSessionEventsRef）与
  // Pending 消息队列（pendingQueueRef）都只存在于渲染进程，Rust 无法
  // 感知。会话隔离：只允许同一 parentConversationId 下的子代理互相
  // 可见、互相通信，跨会话查询/发送一律拒绝。
  // ---------------------------------------------------------------------
  const executeSubAgentCommsTool = async (
    toolName: string,
    argsJson: string,
    senderConvId: string,
    senderAgentName: string
  ): Promise<string> => {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(argsJson) as Record<string, unknown>;
    } catch {
      return JSON.stringify({
        success: false,
        error: "Invalid JSON arguments",
      });
    }

    const eventMap = ctx.subAgentSessionEventsRef.current;

    if (toolName === "sub-agents-listTeammates") {
      const teammates = Object.values(eventMap)
        .filter(
          (event) =>
            event.parentConversationId === parentConversationId &&
            event.conversationId !== senderConvId &&
            event.status === "running" &&
            !ctx.sessionsRefData.current.get(event.conversationId)
              ?.subAgentTerminated
        )
        .map((event) => ({
          conversationId: event.conversationId,
          agentId: event.agentId,
          agentName: event.agentName,
        }));
      return JSON.stringify({ success: true, teammates });
    }

    if (toolName === "sub-agents-sendMessage") {
      const targetConvId =
        typeof args.conversationId === "string"
          ? args.conversationId.trim()
          : "";
      const message =
        typeof args.message === "string" ? args.message.trim() : "";
      if (!targetConvId || !message) {
        return JSON.stringify({
          success: false,
          error: "conversationId and message are required",
        });
      }
      if (targetConvId === senderConvId) {
        return JSON.stringify({
          success: false,
          error: "Cannot send a message to yourself",
        });
      }

      // 会话隔离：目标必须是同一父会话下的子代理。
      const targetEvent = eventMap[targetConvId];
      if (
        !targetEvent ||
        targetEvent.parentConversationId !== parentConversationId
      ) {
        return JSON.stringify({
          success: false,
          error:
            "Target sub-agent does not exist or belongs to another conversation (session isolation: teammates must be in the same session)",
        });
      }
      // 只允许发给仍在运行的子代理：消息以 Pending 形式进入目标会话的
      // 队列，由目标循环在下一回合边界自动切入。
      if (
        targetEvent.status !== "running" ||
        ctx.sessionsRefData.current.get(targetConvId)?.subAgentTerminated
      ) {
        return JSON.stringify({
          success: false,
          error:
            "Target sub-agent is no longer running; messages can only be sent to teammates that are still active",
        });
      }

      // 消息自带发送方标识，目标子代理收到后可知来源。
      const queuedText = `[来自子代理 ${senderAgentName} (${senderConvId})]\n${message}`;
      const queue = ctx.pendingQueueRef.current.get(targetConvId) ?? [];
      queue.push({ text: queuedText, options: {} });
      ctx.pendingQueueRef.current.set(targetConvId, queue);
      // 目标会话若正处于激活状态，让 Pending 消息气泡实时可见。
      if (ctx.activeConversationIdRef.current === targetConvId) {
        ctx.setActivePendingMessages(queue.map((item) => item.text));
      }

      return JSON.stringify({
        success: true,
        queued: true,
        recipient: {
          conversationId: targetConvId,
          agentName: targetEvent.agentName,
        },
        note: "The message was queued as a Pending message and will be delivered to the target at the end of its current round.",
      });
    }

    return JSON.stringify({
      success: false,
      error: `Unknown sub-agent communication tool: ${toolName}`,
    });
  };

  const subAgentRunLoop: SubAgentRunLoop = async (
    subMessages,
    resumeAfterCompaction = false
  ): Promise<string> => {
    if (ctx.sessionsRefData.current.get(subConvId)?.isAbortRequested) {
      return "Sub-agent interrupted by user";
    }

    const subAssistantMessageId = createMessageId("assistant");
    const subAssistantMessage: ChatConversationMessage = {
      id: subAssistantMessageId,
      role: "assistant",
      content: "",
      timestamp: formatMessageTime(),
      status: "sending",
    };

    ctx.updateSessionMessages(subConvId, (currentMessages) => [
      ...currentMessages,
      subAssistantMessage,
    ]);

    const subStreamPromise = window.snow.createResponseStream(
      {
        messages: subMessages,
        conversationId: subConvId,
        directoryId: dirId,
        apiProfile: runtimeConfig.apiProfile,
        model: runtimeConfig.model,
        // Use the resolved per-run snapshot so restore/compaction cannot
        // re-read a changed Profile default mid-run.
        thinkingStrength: runtimeConfig.effectiveThinkingStrength,
        responsesFastMode: runtimeConfig.responsesFastMode,
        resumeAfterCompaction,
        subAgentToolsJson,
        subAgentSystemPrompt: runtimeConfig.systemPrompt || undefined,
        // Sub-agents always use their own normal-mode prompt and tool set.
        planMode: false,
        goalMode: false,
        worktreeMode: false,
      },
      createStreamChunkHandler(
        ctx,
        subConvId,
        subAssistantMessageId,
        isSubCancelled
      ),
      createStreamIdHandler(ctx, subConvId, isSubCancelled)
    );
    const subStreamRefBefore = ctx.sessionsRefData.current.get(subConvId);
    if (subStreamRefBefore) {
      subStreamRefBefore.streamPromise = subStreamPromise;
    }

    const subResponse = await subStreamPromise;
    const subResponseDisposition = resolveResponseDisposition(subResponse);
    const subResponseFailed = subResponseDisposition.kind === "error";

    const subRef = ctx.sessionsRefData.current.get(subConvId);
    if (subRef) {
      subRef.streamId = null;
      subRef.streamPromise = null;
    }

    // Replace the frontend-generated temporary user message ids with the real
    // database ids returned by createResponseStream (same as the main agent
    // loop). The backend persists user messages in order and returns their
    // snowflake ids in persistedUserMessageIds. Without this remap the
    // in-memory sub-agent messages keep "user-{ts}-{rand}" ids while the DB
    // (queried by the user-message rail) stores snowflake ids, and the rail
    // cannot locate the DOM message by id.
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
        subResponse.persistedUserMessageIds.length
      );
      for (let i = 0; i < subRemapCount; i++) {
        subIdRemap.set(
          pendingSubUserIds[i],
          subResponse.persistedUserMessageIds[i]
        );
      }

      if (subIdRemap.size > 0) {
        ctx.updateSessionMessages(subConvId, (msgs) =>
          msgs.map((m) => {
            const newId = subIdRemap.get(m.id);
            return newId ? { ...m, id: newId } : m;
          })
        );
      }
    }

    if (ctx.sessionsRefData.current.get(subConvId)?.isAbortRequested) {
      const forceSendAbort =
        !!ctx.sessionsRefData.current.get(subConvId)?.forceSendAbort;
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
            : currentMessage
        )
      );
      return forceSendAbort ? "" : "Sub-agent interrupted by user";
    }

    if (subResponse.tokenUsage && !subResponseFailed) {
      ctx.updateSessionField(subConvId, "tokenUsage", subResponse.tokenUsage);
      accumulateRunTokenUsage(ctx, subConvId, subResponse.tokenUsage);
    }

    // A final incomplete-like result terminates the sub-agent's internal
    // loop. Keep display-safe content and metadata, but never parse,
    // authorize, execute, or return incomplete tool arguments.
    if (subResponseDisposition.kind === "incomplete") {
      const currentSubAssistant = ctx.sessionsRef.current?.[
        subConvId
      ]?.messages.find((message) => message.id === subAssistantMessageId);
      const incompleteContent =
        subResponse.content || currentSubAssistant?.content || "";
      const safeIncompleteResult = incompleteContent.trim()
        ? incompleteContent
        : "Sub-agent response ended before completion. Any incomplete tool call was discarded and was not executed.";

      ctx.updateSessionMessages(subConvId, (currentMessages) =>
        currentMessages.map((currentMessage) =>
          currentMessage.id === subAssistantMessageId
            ? {
                ...currentMessage,
                content: subResponse.content || currentMessage.content || "",
                thinking:
                  subResponse.thinking || currentMessage.thinking || undefined,
                timestamp: formatMessageTime(),
                status: "incomplete" as const,
                incompleteVariant: subResponseDisposition.variant,
                interruptionReason: subResponseDisposition.reason,
                recoveryOutcome: subResponseDisposition.recoveryOutcome,
                responseId: subResponse.id || undefined,
                model: subResponse.model || undefined,
                toolCalls: undefined,
                isRetrying: false,
                retryAttempt: undefined,
                retryError: undefined,
              }
            : currentMessage
        )
      );
      return safeIncompleteResult;
    }

    const subToolCalls =
      subResponseDisposition.kind === "complete"
        ? parseToolCalls(subResponse.toolCallsJson)
        : [];

    if (subResponseFailed) {
      const failureContent =
        subResponse.content || "Sub-agent request failed. Please retry.";
      ctx.updateSessionMessages(subConvId, (currentMessages) =>
        currentMessages.map((currentMessage) =>
          currentMessage.id === subAssistantMessageId
            ? {
                ...currentMessage,
                content: failureContent,
                thinking: subResponse.thinking || undefined,
                timestamp: formatMessageTime(),
                status: "error" as const,
                responseId: subResponse.id || undefined,
                model: subResponse.model || undefined,
                isRetrying: false,
              }
            : currentMessage
        )
      );
      return failureContent;
    }

    // Auto-compaction for sub-agents: mirrors the main agent loop. When the
    // resolved API profile has enableAutoCompress=true and the total token
    // usage crosses its configured threshold, finalize the assistant
    // message, compact the sub-conversation, and continue the sub-agent loop
    // from the compacted context. The fixed profile name is reused for every
    // check, while its latest non-secret settings are read so threshold edits
    // apply without a restart.
    //
    // Only runs while the sub-agent loop is still alive (tool calls to
    // process). When the sub-agent is finishing naturally (no tool calls),
    // compaction must NOT fire even over the threshold — it would force
    // another subAgentRunLoop iteration and wake the sub-agent back up
    // after it completed.
    if (
      subToolCalls.length > 0 &&
      subResponse.tokenUsage &&
      !subResponseFailed
    ) {
      const subApiConfig = (await window.snow.listApiConfigs()).find(
        (item) => item.profileName.trim() === runtimeConfig.apiProfile
      );
      if (subApiConfig?.enableAutoCompress) {
        // autoCompressThreshold is stored in TOKENS — compare directly (see
        // the main loop check for why calculateAutoCompressThresholdTokens
        // is intentionally not used here).
        const subThresholdTokens = subApiConfig.autoCompressThreshold;
        if (subThresholdTokens != null && subThresholdTokens > 0) {
          const subTotalTokens =
            subResponse.tokenUsage.inputTokens +
            subResponse.tokenUsage.outputTokens;
          if (subTotalTokens >= subThresholdTokens) {
            // Finalize the assistant message that crossed the threshold so
            // it does not linger in "sending" state. Any tool calls it
            // emitted are abandoned by the handoff; the Rust compaction
            // boundary plus ensure_tool_pairing keep the post-compaction
            // context free of orphan tool entries.
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
                  : currentMessage
              )
            );

            const subCompactionResult = await ctx.performCompactionRef.current(
              subConvId,
              runtimeConfig.model,
              true,
              undefined,
              runtimeConfig.apiProfile,
              runtimeConfig.toolsJson,
              runtimeConfig.systemPrompt || undefined,
              runtimeConfig.effectiveThinkingStrength,
              runtimeConfig.responsesFastMode
            );

            if (subCompactionResult) {
              if (isSubCancelled()) {
                return "Sub-agent interrupted by user";
              }

              // performCompaction's finally resets isSending=false, but the
              // sub-agent loop is still mid-send. Restore it so abort keeps
              // working and the session stays locked until the loop ends.
              const subRefAfterCompaction =
                ctx.sessionsRefData.current.get(subConvId);
              if (subRefAfterCompaction) {
                subRefAfterCompaction.isSending = true;
                subRefAfterCompaction.isAbortRequested = false;
              }

              // Continue the sub-agent loop from the compacted context. The
              // Rust backend rebuilds context from the compaction boundary
              // stored in the database for this sub-conversation. The first
              // message is the handoff placeholder (already persisted as the
              // context_compaction boundary); protectedMessages（压缩前最后
              // 一条用户任务原文）紧随其后，由 Rust 注入并持久化，防止子
              // 代理因摘要丢失任务/TODO 状态而忘记任务。
              return subAgentRunLoop(
                [
                  { role: "user", content: subCompactionResult.content },
                  ...(subCompactionResult.protectedMessages ?? []),
                ],
                true
              );
            }
          }
        }
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
            : currentMessage
        )
      );

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
          : currentMessage
      )
    );

    const subAuthorizationDecisions = await requestToolAuthorizations(
      subToolCalls,
      subConvId,
      dirId
    );

    const subAllToolsRejected = subAuthorizationDecisions.every(
      (decision) => decision.status === "rejected"
    );
    // 用户填写了拒绝理由时，拒绝理由作为工具结果回传子代理 AI，
    // 子代理 Loop 继续；仅当全部拒绝且没有用户理由时才终止。
    const subHasUserProvidedRejectionReason = subAuthorizationDecisions.some(
      (decision) =>
        decision.status === "rejected" && decision.userProvidedReason === true
    );

    const subToolResults: string[] = [];
    const subStructuredResults: {
      name: string;
      callId: string;
      result: string;
    }[] = [];
    let parentPlanApprovalRequired = false;

    for (
      let subToolIndex = 0;
      subToolIndex < subToolCalls.length;
      subToolIndex++
    ) {
      const subToolCall = subToolCalls[subToolIndex];
      const subAuthorizationDecision = subAuthorizationDecisions[subToolIndex];

      if (ctx.sessionsRefData.current.get(subConvId)?.isAbortRequested) {
        return "Sub-agent interrupted by user";
      }

      if (subAuthorizationDecision.status === "rejected") {
        const subRejectResult = JSON.stringify({
          success: false,
          error: "TOOL_EXECUTION_DENIED_BY_USER",
          reason:
            subAuthorizationDecision.reason || "User declined tool execution",
        });
        subToolResults.push(formatMcpToolResultForModel(subRejectResult));
        subStructuredResults.push({
          name: subToolCall.name,
          callId: subToolCall.callId || "",
          result: formatMcpToolResultForModel(subRejectResult),
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
                })
              ),
            };
          })
        );
        continue;
      }

      const subToolArgs = injectSessionIdIntoToolArgs(
        subToolCall.name,
        subToolCall.arguments,
        subConvId
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
              subParsedArgs.command
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
              })
            ),
          };
        })
      );

      let subResult: string;
      let subToolErrored = false;
      try {
        if (SUB_AGENT_COMMS_TOOL_NAMES.has(subToolCall.name)) {
          // 队友通信工具由渲染进程直接执行（会话隔离与 Pending 队列
          // 都在渲染进程），不走 Rust callMcpTool。
          subResult = await executeSubAgentCommsTool(
            subToolCall.name,
            subToolArgs,
            subConvId,
            agentName
          );
        } else {
          subResult = await window.snow.callMcpTool(
            subToolCall.name,
            subToolArgs,
            dirId,
            parentCheckpointIdsRef.current,
            subCheckpointWorkDir,
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
                        })
                      ),
                    };
                  })
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
                      })
                    ),
                  };
                })
              );
            },
            subToolCall.interactionId,
            allowedTools,
            // These booleans carry only the parent conversation's Rust
            // write-gate state; they do not enable Plan Mode for the sub-agent.
            // Read from the parent session's own ref so a background parent
            // keeps its gate even after the user switches conversations.
            ctx.sessionsRefData.current.get(parentConversationId)?.planMode ??
              ctx.planModeRef.current,
            planApprovedSessionKeysRef.current.has(parentConversationId)
          );
        }
      } catch (err) {
        subToolErrored = true;
        const errorMessage = getErrorMessage(err);

        if (errorMessage.includes(PARENT_PLAN_APPROVAL_REQUIRED)) {
          parentPlanApprovalRequired = true;
        }
        // Recover partial streaming output for terminal-execute
        // so the sub-agent (and ultimately the parent AI loop)
        // receives the partial output together with the error.
        if (subToolCall.name === "bash-terminal-execute") {
          const subSessionMessages =
            ctx.sessionsRef.current?.[subConvId]?.messages ?? [];
          const subAssistantMsg = subSessionMessages.find(
            (m) => m.id === subAssistantMessageId
          );
          const liveSubToolCall = subAssistantMsg?.toolCalls?.find(
            (tc) =>
              tc.interactionId === subToolCall.interactionId &&
              tc.name === subToolCall.name
          );
          const partialStdout = liveSubToolCall?.streamingStdout ?? "";
          const partialStderr = liveSubToolCall?.streamingStderr ?? "";
          const partialOutput = [partialStdout, partialStderr]
            .filter(Boolean)
            .join("\n");
          subResult = JSON.stringify({
            error: errorMessage,
            stdout: partialStdout,
            stderr: partialStderr,
            partialOutput: partialOutput.length > 0 ? partialOutput : undefined,
          });
        } else {
          subResult = JSON.stringify({ error: errorMessage });
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
              ["pending", "running"],
              (currentToolCall) => ({
                ...currentToolCall,
                status: subToolErrored
                  ? ("error" as const)
                  : ("completed" as const),
                result: subResult,
              })
            ),
          };
        })
      );

      // Record successful file modifications made by this sub-agent under
      // its own conversationId AND the parent conversationId. Storing
      // under the parent key lets the file-change stats panel show the
      // full picture (main agent + sub-agents) without extra lookups;
      // the sub-agent's own key keeps its per-session view accurate.
      if (!subToolErrored && subResult !== undefined) {
        const subFileChange = extractFileChangeFromTool(
          subToolCall.name,
          subToolArgs,
          subResult
        );
        if (subFileChange) {
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

      const subModelResult = formatMcpToolResultForModel(subResult);
      subToolResults.push(subModelResult);
      subStructuredResults.push({
        name: subToolCall.name,
        callId: subToolCall.callId || "",
        result: subModelResult,
      });

      if (parentPlanApprovalRequired) {
        break;
      }
    }

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

    // A sub-agent cannot obtain Plan approval. Stop immediately and return
    // control to the main loop instead of feeding the denial back into a
    // recursive sub-agent iteration that could repeatedly retry the write.
    // Queued user insertions are left in place: the post-loop flush below
    // carries them over to the parent conversation.
    if (parentPlanApprovalRequired) {
      return "Sub-agent stopped because the main conversation must approve the Plan Mode plan before delegated writes can run.";
    }

    if (subAllToolsRejected && !subHasUserProvidedRejectionReason) {
      return subToolResults.join("\n\n");
    }

    const subPendingForTools = ctx.pendingQueueRef.current.get(subConvId) ?? [];
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
    if (subPendingForTools.length > 0) {
      ctx.pendingQueueRef.current.delete(subConvId);
      const subPendingText = subPendingForTools
        .map((item) => item.text)
        .join("\n\n");
      ctx.setActivePendingMessages([]);
      const subPendingUserMsg: ChatConversationMessage = {
        id: createMessageId("user"),
        role: "user",
        content: subPendingText,
        timestamp: formatMessageTime(),
        status: "sent",
      };
      ctx.updateSessionMessages(subConvId, (currentMessages) => [
        ...currentMessages,
        subPendingUserMsg,
      ]);
      subNextMessages.push({ role: "user", content: subPendingText });
    }

    return subAgentRunLoop(subNextMessages);
  };

  return subAgentRunLoop;
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
  subAgentRunLoop: SubAgentRunLoop
): (() => Promise<string>) => {
  return async (): Promise<string> => {
    let lastSummary = "";
    while (true) {
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
      ctx.updateSessionField(subConvId, "streamStartedAt", Date.now());
      ctx.addStreamingId(subConvId);
      lastSummary = await subAgentRunLoop([
        { role: "user", content: forceSendText },
      ]);
    }
  };
};

/** 子代理会话收尾时的 Pending 队列转交工厂：子代理会话只读后，运行期间
 * 用户插入的消息不能丢失 —— 转交到父会话的 pending 队列，由父循环在下一
 * 个迭代边界（或用户下次发送）消费。 */
const createForwardSubPendingQueue = (
  ctx: ConversationContextValue,
  parentConversationId: string
): ((finishedSubConvId: string) => void) => {
  return (finishedSubConvId: string): void => {
    const subQueue = ctx.pendingQueueRef.current.get(finishedSubConvId) ?? [];
    if (subQueue.length === 0) {
      return;
    }
    ctx.pendingQueueRef.current.delete(finishedSubConvId);
    const parentQueue =
      ctx.pendingQueueRef.current.get(parentConversationId) ?? [];
    parentQueue.push(...subQueue);
    ctx.pendingQueueRef.current.set(parentConversationId, parentQueue);
    ctx.setActivePendingMessages(
      ctx.activeConversationIdRef.current === parentConversationId
        ? parentQueue.map((item) => item.text)
        : []
    );
  };
};

type SubAgentFinalizerDeps = {
  ctx: ConversationContextValue;
  parentConversationId: string;
  agentId: string;
  getAgentName: () => string;
  dirId: string;
  prompt: string;
  toolCallInteractionId?: string;
  runForceSendLoop: () => Promise<string>;
  forwardSubPendingQueue: (convId: string) => void;
};

type SubAgentFinalizeFn = (
  convId: string,
  summary: string,
  status: "completed" | "failed"
) => Promise<string>;

/** 子代理回合统一收尾工厂：标记只读、清理运行状态、广播终止事件、持久化
 * 状态、转交 Pending 队列，最后执行 onSubAgentComplete hooks。激活与
 * 重新激活（sub-agents-continue，含重启后恢复）共用，保证收尾行为一致。 */
const createSubAgentFinalizer = (
  deps: SubAgentFinalizerDeps
): SubAgentFinalizeFn => {
  const {
    ctx,
    parentConversationId,
    agentId,
    getAgentName,
    dirId,
    prompt,
    toolCallInteractionId,
    runForceSendLoop,
    forwardSubPendingQueue,
  } = deps;

  return async (convId, summary, status): Promise<string> => {
    const finalRef = ctx.sessionsRefData.current.get(convId);
    // 用户在子代理运行中点击"立即发送"：先消费暂存消息继续回合，
    // 再统一走终止收尾（terminated + 状态广播 + 队列转交父会话）。
    if (finalRef?.forceSendMessages?.length) {
      try {
        const forceSendSummary = await runForceSendLoop();
        if (forceSendSummary) {
          summary = forceSendSummary;
        }
      } catch {
        // 强行发送回合异常：继续统一收尾（失败路径）
      }
    }
    if (finalRef) {
      // Mark the sub-agent conversation read-only before clearing isSending:
      // once the run ends no new agent loop may start in it, and this
      // synchronous flag closes the race window before the UI hides the
      // input box.
      finalRef.subAgentTerminated = true;
      finalRef.isSending = false;
    }
    ctx.updateSessionField(convId, "isStreaming", false);
    // 固化本次 run 总耗时（置 0 前读取），累加进会话统计（内存 + DB）。
    const finalizeStartedAt =
      ctx.sessionsRef.current?.[convId]?.streamStartedAt ?? 0;
    if (finalizeStartedAt > 0) {
      const finalizeDurationMs = Math.max(0, Date.now() - finalizeStartedAt);
      const runUsage = ctx.sessionsRefData.current.get(convId)?.runTokenUsage;
      accumulateConversationRunStats(ctx, convId, runUsage, finalizeDurationMs);
      // 持久化（Rust 端累加），重启后打开子代理会话仍可完整回显。
      void window.snow
        .setConversationRunStats(
          convId,
          runUsage?.inputTokens ?? 0,
          runUsage?.outputTokens ?? 0,
          runUsage?.cacheCreationInputTokens ?? 0,
          runUsage?.cacheReadInputTokens ?? 0,
          finalizeDurationMs
        )
        .catch(() => {
          // 持久化失败不阻塞收尾
        });
    }
    ctx.updateSessionField(convId, "streamStartedAt", 0);
    ctx.updateSessionField(convId, "isAborting", false);
    ctx.removeStreamingId(convId);

    // Broadcast the terminal status FIRST — immediately after the flag, so
    // the UI hides the input box as soon as possible. Persisting to the DB
    // and running the (possibly slow) completion hook happen afterwards.
    ctx.setSubAgentSessionEvent({
      parentConversationId,
      conversationId: convId,
      agentId,
      agentName: getAgentName(),
      status,
      timestamp: Date.now(),
      toolCallInteractionId,
    });

    // Persist the terminal status so it survives an app restart.
    await window.snow
      .updateSubAgentSessionStatus(
        convId,
        status,
        status === "failed" ? summary : ""
      )
      .catch(() => {});

    // Flush user messages queued while the sub-agent was busy (inserting
    // messages mid-run is allowed). A finished sub-agent conversation no
    // longer accepts messages, so carry them to the parent conversation.
    // This also covers aborted runs: with the sub-conversation input
    // hidden, the queue would otherwise be orphaned and silently lost.
    forwardSubPendingQueue(convId);

    if (status === "failed") {
      return JSON.stringify({ success: false, error: summary });
    }

    // Execute onSubAgentComplete hooks. The hook context includes the
    // sub-agent's summary so prompt-type hooks can inspect the result.
    // If blocked, the error message replaces the summary returned to
    // the parent AI loop.
    let effectiveSummary = summary;
    try {
      const onCompleteContext = JSON.stringify({
        agentId,
        agentName: getAgentName(),
        prompt,
        summary,
        parentConversationId,
        cwd: directoryIdToPath(dirId) ?? ctx.directoryPath ?? "",
      });
      const onCompleteResult = await runHook(
        "onSubAgentComplete",
        dirId || undefined,
        onCompleteContext
      );
      if (onCompleteResult) {
        ctx.updateSessionMessages(parentConversationId, (currentMessages) =>
          appendHookExecutionToMessage(currentMessages, {
            ...onCompleteResult.record,
            // Bind to the sub-agent tool call so the hook renders attached
            // to the sub-agent card ("完成" step), not the message footer.
            toolCallInteractionId,
          })
        );
        if (onCompleteResult.outcome.kind === "abort") {
          effectiveSummary = onCompleteResult.outcome.message;
        } else if (
          onCompleteResult.outcome.kind === "pass" &&
          onCompleteResult.outcome.context
        ) {
          effectiveSummary = `${summary}\n\n[Hook Context]\n${onCompleteResult.outcome.context}`;
        } else if (onCompleteResult.outcome.kind === "warn") {
          effectiveSummary = `${summary}\n\n[Hook Warning]\n${onCompleteResult.outcome.message}`;
        }
      }
    } catch {
      // Hook execution failed -- use original summary
    }

    return JSON.stringify({
      success: true,
      conversationId: convId,
      agentName: getAgentName(),
      summary: effectiveSummary,
    });
  };
};

type SubAgentResumeDeps = {
  ctx: ConversationContextValue;
  subConvId: string;
  parentConversationId: string;
  agentId: string;
  getAgentName: () => string;
  subAgentRunLoop: SubAgentRunLoop;
  finalizeSubAgentSession: SubAgentFinalizeFn;
  parentCheckpointIdsRef: CheckpointIdsRef;
};

/** 重新激活入口工厂（sub-agents-continue）：运行中 → Pending 队列排队
 * （目标回合边界自动消费）；已结束 → 恢复运行状态并启动新回合，完成后走
 * 与激活完全相同的统一收尾。会话隔离在调用方（createSubAgentMainToolExecutor
 * / restoreSubAgentResumer）强制校验，此处只负责运行。 */
const createSubAgentResume = (
  deps: SubAgentResumeDeps
): SubAgentResumer["resume"] => {
  const {
    ctx,
    subConvId,
    parentConversationId,
    agentId,
    getAgentName,
    subAgentRunLoop,
    finalizeSubAgentSession,
    parentCheckpointIdsRef,
  } = deps;

  return async (
    messages: { role: "user"; content: string }[],
    checkpointIds?: string[]
  ): Promise<string> => {
    if (checkpointIds) {
      parentCheckpointIdsRef.current = checkpointIds;
    }
    const resumeRef = ctx.sessionsRefData.current.get(subConvId);
    if (!resumeRef) {
      return JSON.stringify({
        success: false,
        error: "Sub-agent session no longer exists",
      });
    }
    // 运行中：消息进入 Pending 队列，目标回合结束时自动切入。
    if (resumeRef.isSending && !resumeRef.subAgentTerminated) {
      const queue = ctx.pendingQueueRef.current.get(subConvId) ?? [];
      queue.push(...messages.map((m) => ({ text: m.content, options: {} })));
      ctx.pendingQueueRef.current.set(subConvId, queue);
      if (ctx.activeConversationIdRef.current === subConvId) {
        ctx.setActivePendingMessages(queue.map((item) => item.text));
      }
      return JSON.stringify({
        success: true,
        queued: true,
        note: "The target sub-agent is still running; the message was queued as a Pending message and will be delivered at the end of its current round.",
      });
    }

    // 已结束：重新激活。恢复运行状态与流式标记（与激活时初始化一致），
    // handleAbort 与暂停检查才能正常工作；广播 running 事件让 UI 立即
    // 恢复实时状态，并持久化 running 状态（重启后恢复的子代理 DB 里
    // 还是终态）。
    resumeRef.subAgentTerminated = false;
    resumeRef.isSending = true;
    resumeRef.isAbortRequested = false;
    ctx.updateSessionField(subConvId, "isStreaming", true);
    resetRunStreamMetrics(ctx, subConvId);
    ctx.updateSessionField(subConvId, "streamStartedAt", Date.now());
    ctx.addStreamingId(subConvId);
    ctx.setSubAgentSessionEvent({
      parentConversationId,
      conversationId: subConvId,
      agentId,
      agentName: getAgentName(),
      status: "running",
      timestamp: Date.now(),
    });
    await window.snow
      .updateSubAgentSessionStatus(subConvId, "running", "")
      .catch(() => {});

    const resumeUserMsg: ChatConversationMessage = {
      id: createMessageId("user"),
      role: "user",
      content: messages.map((m) => m.content).join("\n\n"),
      timestamp: formatMessageTime(),
      status: "sent",
    };
    ctx.updateSessionMessages(subConvId, (currentMessages) => [
      ...currentMessages,
      resumeUserMsg,
    ]);

    const resumeSummary = await subAgentRunLoop(messages);
    return finalizeSubAgentSession(subConvId, resumeSummary, "completed");
  };
};

export const createSubAgentActivation = (deps: SubAgentActivationDeps) => {
  const {
    ctx,
    requestToolAuthorizations,
    parentApiProfile,
    parentModel,
    parentThinkingStrength,
    parentResponsesFastMode,
    planApprovedSessionKeysRef,
  } = deps;

  return async (
    argsJson: string,
    parentConversationId: string,
    dirId: string,
    toolCallInteractionId: string | undefined,
    activeCheckpointIds: string[]
  ): Promise<string> => {
    // 当前主会话回合的所有子代理文件工具共享同一个 active checkpoint，
    // 但不会触碰更早消息的 checkpoint expected 状态。
    const parentCheckpointIdsRef: CheckpointIdsRef = {
      current: activeCheckpointIds,
    };
    const subCheckpointWorkDir =
      activeCheckpointIds.length > 0
        ? directoryIdToPath(dirId) ?? ctx.directoryPath
        : undefined;

    const parsedArgs = JSON.parse(argsJson) as Record<string, unknown>;
    const agentId =
      typeof parsedArgs.agentId === "string" ? parsedArgs.agentId : "";
    const prompt =
      typeof parsedArgs.prompt === "string" ? parsedArgs.prompt : "";

    if (!agentId || !prompt) {
      return JSON.stringify({
        success: false,
        error: "agentId and prompt are required",
      });
    }
    let subConversationId: string | undefined;
    let subAgentName: string | undefined;
    let config: Awaited<ReturnType<typeof window.snow.getSubAgentConfig>> =
      null;

    // 子代理运行时依赖（try 块内依据运行时解析的配置赋值）。以 let 占位
    // 声明：catch 路径（第一轮失败/被中断）也需要 finalize 来完成失败收尾
    // （finalize 内部会消费用户强行发送的消息）。
    let subAgentRunLoop: SubAgentRunLoop = async () => "";
    let runForceSendLoop: () => Promise<string> = async () => "";
    let forwardSubPendingQueue: (finishedSubConvId: string) => void = () => {};
    let finalizeSubAgentSession: SubAgentFinalizeFn | null = null;
    let subAgentSessionCreated = false;

    try {
      // 项目级子代理优先：先查当前项目（dirId）下的配置，未命中再回退全局。
      config = dirId
        ? (await window.snow.getSubAgentConfig(agentId, dirId)) ??
          (await window.snow.getSubAgentConfig(agentId))
        : await window.snow.getSubAgentConfig(agentId);
      if (!config) {
        return JSON.stringify({
          success: false,
          error: `Sub-agent configuration not found: ${agentId}`,
        });
      }

      const runtimeConfig = resolveSubAgentRuntimeConfig({
        config,
        apiConfigs: await window.snow.listApiConfigs(),
        parentApiProfile,
        parentModel,
        parentThinkingStrength,
        parentResponsesFastMode,
      });
      const allowedTools = parseSubAgentTools(runtimeConfig.toolsJson);

      subConversationId = `sub-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 10)}`;
      const title = prompt.length > 80 ? `${prompt.slice(0, 80)}...` : prompt;

      // Execute beforeSubAgentStart hooks. If blocked, abort the
      // sub-agent activation immediately with the hook's message.
      try {
        const beforeSubAgentContext = JSON.stringify({
          agentId,
          agentName: runtimeConfig.agentName,
          prompt,
          parentConversationId,
          cwd: directoryIdToPath(dirId) ?? ctx.directoryPath ?? "",
        });
        const subHookResult = await runHook(
          "beforeSubAgentStart",
          dirId || undefined,
          beforeSubAgentContext
        );
        if (subHookResult) {
          ctx.updateSessionMessages(parentConversationId, (currentMessages) =>
            appendHookExecutionToMessage(currentMessages, {
              ...subHookResult.record,
              // Bind to the sub-agent tool call so the hook renders attached
              // to the sub-agent card ("启动前" step), not the message footer.
              toolCallInteractionId,
            })
          );
          if (subHookResult.outcome.kind === "abort") {
            return JSON.stringify({
              success: false,
              error: subHookResult.outcome.message,
            });
          }
        }
      } catch {
        // Hook execution failed -- continue with sub-agent activation
      }

      await window.snow.createSubAgentSession(
        subConversationId,
        parentConversationId,
        runtimeConfig.agentId,
        runtimeConfig.agentName,
        dirId,
        runtimeConfig.apiProfile,
        runtimeConfig.model,
        title,
        runtimeConfig.effectiveThinkingStrength || null,
        runtimeConfig.effectiveResponsesFastMode
      );
      subAgentSessionCreated = true;

      await window.snow.updateSubAgentSessionStatus(
        subConversationId,
        "running",
        ""
      );

      ctx.setSubAgentSessionEvent({
        parentConversationId,
        conversationId: subConversationId,
        agentId,
        agentName: runtimeConfig.agentName,
        status: "running",
        timestamp: Date.now(),
        toolCallInteractionId,
      });

      const subAgentToolsJson = runtimeConfig.toolsJson;
      subAgentName = runtimeConfig.agentName;

      // 构建子代理运行环境：回合循环、强行发送循环、队列转交、统一收尾、
      // 恢复入口（sub-agents-continue）并注册到恢复器注册表。与重启后从
      // DB 恢复（restoreSubAgentResumer）共用同一批工厂，行为完全一致。
      const subConvId = subConversationId!;
      subAgentRunLoop = createSubAgentRunLoop({
        ctx,
        subConvId,
        dirId,
        runtimeConfig,
        parentConversationId,
        parentCheckpointIdsRef,
        subCheckpointWorkDir,
        requestToolAuthorizations,
        planApprovedSessionKeysRef,
        isSubCancelled: () =>
          !!ctx.sessionsRefData.current.get(subConvId)?.isAbortRequested,
      });
      runForceSendLoop = createRunForceSendLoop(
        ctx,
        subConvId,
        subAgentRunLoop
      );
      forwardSubPendingQueue = createForwardSubPendingQueue(
        ctx,
        parentConversationId
      );
      const subAgentFinalizer = createSubAgentFinalizer({
        ctx,
        parentConversationId,
        agentId,
        getAgentName: () => subAgentName ?? agentId,
        dirId,
        prompt,
        toolCallInteractionId,
        runForceSendLoop,
        forwardSubPendingQueue,
      });
      finalizeSubAgentSession = subAgentFinalizer;
      subAgentResumers.set(subConversationId, {
        parentConversationId,
        agentId,
        agentName: subAgentName ?? agentId,
        resume: createSubAgentResume({
          ctx,
          subConvId,
          parentConversationId,
          agentId,
          getAgentName: () => subAgentName ?? agentId,
          subAgentRunLoop,
          finalizeSubAgentSession: subAgentFinalizer,
          parentCheckpointIdsRef,
        }),
      });

      ctx.ensureSession(subConvId, dirId);
      const subSessionRef = ctx.sessionsRefData.current.get(subConvId);
      if (subSessionRef) {
        subSessionRef.isSending = true;
        subSessionRef.isAbortRequested = false;
        // Sub-agents never run Plan/Goal Mode (Rust forces both off on the
        // sub-agent request path). Zero the inherited defaults so the ref
        // stays truthful for any future reader.
        subSessionRef.planMode = false;
        subSessionRef.goalMode = false;
        subSessionRef.worktreeMode = false;
      }
      // Register this sub-agent on the parent session so aborting the main
      // flow can cascade the cancellation down to it (and its children).
      const parentSessionRef =
        ctx.sessionsRefData.current.get(parentConversationId);
      if (parentSessionRef) {
        parentSessionRef.childSubAgentIds.add(subConvId);
      }
      ctx.updateSessionField(subConvId, "isStreaming", true);
      resetRunStreamMetrics(ctx, subConvId);
      // Anchor the accumulating timer start for the sub-agent session so
      // its StreamMetrics timer is independent of the parent session.
      ctx.updateSessionField(subConvId, "streamStartedAt", Date.now());
      ctx.addStreamingId(subConvId);

      const subUserMessage: ChatConversationMessage = {
        id: createMessageId("user"),
        role: "user",
        content: prompt,
        timestamp: formatMessageTime(),
        status: "sent",
      };

      ctx.updateSessionMessages(subConvId, (currentMessages) => [
        ...currentMessages,
        subUserMessage,
      ]);

      const summary = await subAgentRunLoop([
        { role: "user", content: prompt },
      ]);

      const activationFinalizer = finalizeSubAgentSession;
      if (!activationFinalizer) {
        throw new Error("Sub-agent finalizer was not initialized");
      }
      return activationFinalizer(subConversationId, summary, "completed");
    } catch (err) {
      const errorMessage = getErrorMessage(err);
      if (subConversationId && subAgentSessionCreated) {
        // 真实 Finalizer 尚未初始化时，至少将已创建的 Native 会话标记为失败；
        // 不再调用会吞掉异常的空 Finalizer。
        const finalizer = finalizeSubAgentSession;
        if (finalizer) {
          try {
            return await finalizer(subConversationId, errorMessage, "failed");
          } catch (finalizeError) {
            return JSON.stringify({
              success: false,
              error: `${errorMessage}; failed to finalize sub-agent session: ${getErrorMessage(
                finalizeError
              )}`,
            });
          }
        }
        try {
          await window.snow.updateSubAgentSessionStatus(
            subConversationId,
            "failed",
            errorMessage
          );
        } catch (persistError) {
          return JSON.stringify({
            success: false,
            error: `${errorMessage}; failed to persist sub-agent failure: ${getErrorMessage(
              persistError
            )}`,
          });
        }
      }

      return JSON.stringify({
        success: false,
        error: errorMessage,
      });
    }
  };
};

// ---------------------------------------------------------------------------
// 主会话子代理管理工具（sub-agents-listSubAgents / sub-agents-continue）
// ---------------------------------------------------------------------------

/** 从 DB 重建子代理恢复器（应用重启后的恢复路径）。子代理会话记录已持久化
 * （agentId/agentName/directoryId/apiProfileName/model），运行时配置从子代理
 * 配置重新解析（toolsJson/systemPrompt 等不入库），并优先保持会话持久化的
 * apiProfile/model。会话隔离在此强制：只接受当前父会话自己的子代理记录。
 * 重建成功后注册到 subAgentResumers，后续 continue 直接走内存。 */
const restoreSubAgentResumer = async (
  ctx: ConversationContextValue,
  requestToolAuthorizations: SubAgentActivationDeps["requestToolAuthorizations"],
  planApprovedSessionKeysRef: { current: Set<string> },
  parentThinkingStrength: string | undefined,
  parentResponsesFastMode: boolean | null | undefined,
  parentConversationId: string,
  targetConvId: string,
  activeCheckpointIds: string[]
): Promise<SubAgentResumer | null> => {
  // 1. DB 查询：仅当前父会话下的子代理可见（会话隔离）。
  let grouped: Record<string, ChatConversationRecord[]>;
  try {
    grouped = await window.snow.listSubAgentConversationsByParents([
      parentConversationId,
    ]);
  } catch {
    return null;
  }
  const record = grouped[parentConversationId]?.find(
    (item) => item.conversationId === targetConvId
  );
  if (!record) {
    return null;
  }

  const agentId = record.subAgentId.trim();
  const agentName = record.subAgentName.trim();
  const dirId = record.directoryId.trim();
  if (!agentId) {
    return null;
  }

  // 2. 子代理配置：项目级优先，未命中回退全局；配置已删除则无法恢复。
  let config: Awaited<ReturnType<typeof window.snow.getSubAgentConfig>> = null;
  try {
    config = dirId
      ? (await window.snow.getSubAgentConfig(agentId, dirId)) ??
        (await window.snow.getSubAgentConfig(agentId))
      : await window.snow.getSubAgentConfig(agentId);
  } catch {
    config = null;
  }
  if (!config) {
    return null;
  }

  // 3. 父会话参数（用于继承 profile/model，父会话是当前会话）。
  let parentRecord: ChatConversationRecord | null = null;
  try {
    parentRecord = await window.snow.getChatConversation(parentConversationId);
  } catch {
    // 父会话查询失败不影响恢复（继承参数走 undefined）
  }

  // 4. 运行时配置解析 + 校准：优先保持会话持久化的 apiProfile/model
  //（父会话参数漂移不影响已运行过的子代理）；profile 已删除时保留解析结果。
  let runtimeConfig: SubAgentRuntimeConfig;
  try {
    const apiConfigs = await window.snow.listApiConfigs();
    const persistedRuntimeConfig = await window.snow
      .getConversationRuntimeConfig(targetConvId)
      .catch(() => null);
    // The parent run wins, then the child row's persisted effective snapshot,
    // and only then the Profile config used by that persisted conversation.
    const fallbackProfileName =
      record.apiProfileName.trim() || parentRecord?.apiProfileName.trim();
    const fallbackApiConfig = fallbackProfileName
      ? apiConfigs.find(
          (item) => item.profileName.trim() === fallbackProfileName
        )
      : undefined;
    const restoredThinkingStrength =
      parentThinkingStrength?.trim() ||
      persistedRuntimeConfig?.thinkingStrength?.trim() ||
      (fallbackApiConfig
        ? getThinkingValueFromConfig(fallbackApiConfig)
        : undefined);
    const restoredFastMode =
      parentResponsesFastMode ??
      persistedRuntimeConfig?.responsesFastMode ??
      (fallbackApiConfig
        ? getResponsesFastModeFromConfig(fallbackApiConfig)
        : undefined);
    runtimeConfig = resolveSubAgentRuntimeConfig({
      config,
      apiConfigs,
      parentApiProfile: parentRecord?.apiProfileName || undefined,
      parentModel: parentRecord?.model || undefined,
      parentThinkingStrength: restoredThinkingStrength,
      parentResponsesFastMode: restoredFastMode,
    });
    if (
      record.apiProfileName &&
      runtimeConfig.apiProfile !== record.apiProfileName
    ) {
      const apiConfigs = await window.snow.listApiConfigs();
      if (
        apiConfigs.some(
          (item) => item.profileName.trim() === record.apiProfileName
        )
      ) {
        runtimeConfig = { ...runtimeConfig, apiProfile: record.apiProfileName };
        if (record.model) {
          runtimeConfig = { ...runtimeConfig, model: record.model };
        }
      }
    }
  } catch {
    return null;
  }

  // 5. 内存会话状态：已结束的子代理标记为 terminated（未激活）、
  //    关闭 Plan/Goal Mode，并登记到父会话的级联取消集合。
  const existingRef = ctx.sessionsRefData.current.get(targetConvId);
  if (existingRef?.isSending && !existingRef.subAgentTerminated) {
    return null; // 运行中但无 resumer：不应发生，防御性拒绝
  }
  ctx.ensureSession(targetConvId, dirId || undefined);
  const restoredRef = ctx.sessionsRefData.current.get(targetConvId);
  if (restoredRef) {
    restoredRef.subAgentTerminated = true;
    restoredRef.isSending = false;
    restoredRef.planMode = false;
    restoredRef.goalMode = false;
    restoredRef.worktreeMode = false;
  }
  const parentSessionRef =
    ctx.sessionsRefData.current.get(parentConversationId);
  if (parentSessionRef) {
    parentSessionRef.childSubAgentIds.add(targetConvId);
  }

  // 6. 构建运行环境（与激活路径共用同一批工厂）。
  const parentCheckpointIdsRef: CheckpointIdsRef = {
    current: activeCheckpointIds,
  };
  const subCheckpointWorkDir =
    activeCheckpointIds.length > 0
      ? directoryIdToPath(dirId) ?? ctx.directoryPath
      : undefined;
  const subAgentRunLoop = createSubAgentRunLoop({
    ctx,
    subConvId: targetConvId,
    dirId,
    runtimeConfig,
    parentConversationId,
    parentCheckpointIdsRef,
    subCheckpointWorkDir,
    requestToolAuthorizations,
    planApprovedSessionKeysRef,
    isSubCancelled: () =>
      !!ctx.sessionsRefData.current.get(targetConvId)?.isAbortRequested,
  });
  const runForceSendLoop = createRunForceSendLoop(
    ctx,
    targetConvId,
    subAgentRunLoop
  );
  const forwardSubPendingQueue = createForwardSubPendingQueue(
    ctx,
    parentConversationId
  );
  const finalizeSubAgentSession = createSubAgentFinalizer({
    ctx,
    parentConversationId,
    agentId,
    getAgentName: () => agentName || agentId,
    dirId,
    // 恢复路径没有激活时的原始 prompt，用会话标题近似（仅 hooks 上下文用）。
    prompt: record.title || agentName || agentId,
    runForceSendLoop,
    forwardSubPendingQueue,
  });
  const resumer: SubAgentResumer = {
    parentConversationId,
    agentId,
    agentName: agentName || agentId,
    resume: createSubAgentResume({
      ctx,
      subConvId: targetConvId,
      parentConversationId,
      agentId,
      getAgentName: () => agentName || agentId,
      subAgentRunLoop,
      finalizeSubAgentSession,
      parentCheckpointIdsRef,
    }),
  };
  subAgentResumers.set(targetConvId, resumer);
  return resumer;
};

/** 主会话专用的子代理管理工具执行器。会话隔离在此强制：查询与继续都只
 *  允许当前父会话（parentConversationId）自己的子代理，跨会话一律拒绝。
 *  continue 优先走内存恢复器；内存没有时（应用重启后）从 DB 重建。 */
export const createSubAgentMainToolExecutor = (
  ctx: ConversationContextValue,
  deps: Pick<
    SubAgentActivationDeps,
    "requestToolAuthorizations" | "planApprovedSessionKeysRef"
  > & {
    parentThinkingStrength?: string;
    parentResponsesFastMode?: boolean | null;
  }
) => {
  const {
    requestToolAuthorizations,
    planApprovedSessionKeysRef,
    parentThinkingStrength,
    parentResponsesFastMode,
  } = deps;

  return async (
    toolName: string,
    argsJson: string,
    parentConversationId: string,
    checkpointIds: string[]
  ): Promise<string> => {
    if (toolName === "sub-agents-listSubAgents") {
      const eventMap = ctx.subAgentSessionEventsRef.current;
      // 内存事件：本次运行期激活的子代理（实时状态优先）。
      const memoryAgents = Object.values(eventMap)
        .filter((event) => event.parentConversationId === parentConversationId)
        .map((event) => ({
          conversationId: event.conversationId,
          agentId: event.agentId,
          agentName: event.agentName,
          status: event.status,
          resumable: subAgentResumers.has(event.conversationId),
        }));
      // DB 持久化记录：应用重启后也能列出；status 取持久化的终态。
      let dbAgents: typeof memoryAgents = [];
      try {
        const grouped = await window.snow.listSubAgentConversationsByParents([
          parentConversationId,
        ]);
        dbAgents = (grouped[parentConversationId] ?? []).map((record) => ({
          conversationId: record.conversationId,
          agentId: record.subAgentId,
          agentName: record.subAgentName,
          status: (["running", "completed", "failed", "cancelled"].includes(
            record.subAgentStatus
          )
            ? record.subAgentStatus
            : "completed") as SubAgentSessionEvent["status"],
          // 持久化记录均可尝试恢复（continue 时按需重建，失败会返回错误）。
          resumable: subAgentResumers.has(record.conversationId),
        }));
      } catch {
        // DB 查询失败不阻塞内存结果
      }
      // 合并去重（内存优先：同一会话在内存与 DB 中可能同时存在）。
      const seen = new Set<string>();
      const subAgents = [...memoryAgents, ...dbAgents].filter((agent) => {
        if (seen.has(agent.conversationId)) {
          return false;
        }
        seen.add(agent.conversationId);
        return true;
      });
      return JSON.stringify({ success: true, subAgents });
    }

    if (toolName === "sub-agents-continue") {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(argsJson) as Record<string, unknown>;
      } catch {
        return JSON.stringify({
          success: false,
          error: "Invalid JSON arguments",
        });
      }
      const targetConvId =
        typeof args.conversationId === "string"
          ? args.conversationId.trim()
          : "";
      const message =
        typeof args.message === "string" ? args.message.trim() : "";
      if (!targetConvId || !message) {
        return JSON.stringify({
          success: false,
          error: "conversationId and message are required",
        });
      }

      // 消息自带发送方标识，子代理收到后可知来源。
      const queuedText = `[来自主会话]\n${message}`;

      // 会话隔离 + 恢复器解析：内存优先；运行期事件缺失时（应用重启后）
      // 从 DB 重建（restoreSubAgentResumer 内部再次校验父会话归属）。
      const eventMap = ctx.subAgentSessionEventsRef.current;
      const targetEvent = eventMap[targetConvId];
      let resumer: SubAgentResumer | null =
        subAgentResumers.get(targetConvId) ?? null;
      if (
        !resumer &&
        (!targetEvent ||
          targetEvent.parentConversationId === parentConversationId)
      ) {
        resumer = await restoreSubAgentResumer(
          ctx,
          requestToolAuthorizations,
          planApprovedSessionKeysRef,
          parentThinkingStrength,
          parentResponsesFastMode,
          parentConversationId,
          targetConvId,
          checkpointIds
        );
      }
      if (!resumer || resumer.parentConversationId !== parentConversationId) {
        return JSON.stringify({
          success: false,
          error:
            "Target sub-agent does not exist, belongs to another conversation (session isolation: only sub-agents of the current conversation can be resumed), or its configuration is no longer available",
        });
      }

      return resumer.resume(
        [{ role: "user", content: queuedText }],
        checkpointIds
      );
    }

    return JSON.stringify({
      success: false,
      error: `Unknown sub-agents tool: ${toolName}`,
    });
  };
};
