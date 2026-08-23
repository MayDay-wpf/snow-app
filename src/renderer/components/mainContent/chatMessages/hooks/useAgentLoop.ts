import { useCallback } from "react";
import type { ChatInputSendOptions } from "../../chatInput/types";
import type {
  ChatConversationMessage,
  ConversationContextValue,
  ToolAuthorizationDecision,
  ToolCallInfo,
} from "../utils/conversationTypes";
import {
  PENDING_SESSION_KEY,
  isPendingSessionKey,
} from "../utils/conversationTypes";
import {
  createMessageId,
  deleteCheckpoints,
  directoryIdToPath,
  formatMessageTime,
  formatToolResultsContent,
  getErrorMessage,
  parseToolCalls,
  updateFirstMatchingToolCall,
} from "../utils/conversationHelpers";
import { resolveResponseDisposition } from "../utils/responseDisposition";
import {
  appendHookExecutionToMessage,
  buildHookExecRecord,
  resolveHookOutcome,
  runHook,
  toNonBlockingRecord,
} from "./hookOutcome";
import {
  accumulateConversationRunStats,
  accumulateRunTokenUsage,
  createAwaitHookDecision,
  createIsRunCancelled,
  createStreamChunkHandler,
  createStreamIdHandler,
  resetRunStreamMetrics,
} from "./agentLoopHelpers";
import {
  createSubAgentActivation,
  createSubAgentMainToolExecutor,
} from "./subAgentActivation";
import { createToolExecutor } from "./toolExecution";

type CapturedChatInputSendOptions = ChatInputSendOptions;

// A completed read can only become stale when a tool may have changed the
// workspace. Session bookkeeping (for example todo updates) must not make a
// previously completed filesystem read executable again.
const WORKSPACE_MUTATING_TOOL_NAMES = new Set([
  "filesystem-create",
  "filesystem-replace_edit",
  "bash-terminal-execute",
]);

const mayMutateWorkspace = (toolCall: ToolCallInfo): boolean =>
  WORKSPACE_MUTATING_TOOL_NAMES.has(toolCall.name);

const captureChatInputSendOptions = (
  options: ChatInputSendOptions,
): CapturedChatInputSendOptions => {
  const source = options as CapturedChatInputSendOptions;
  const runtimeOverride = source.conversationRuntimeConfigOverride;
  return {
    ...source,
    ...(runtimeOverride
      ? {
          conversationRuntimeConfigOverride: {
            thinkingStrength: runtimeOverride.thinkingStrength ?? null,
            responsesFastMode: runtimeOverride.responsesFastMode ?? null,
          },
        }
      : {}),
  };
};

const persistPendingConversationRuntimeConfig = (
  conversationId: string,
  options: CapturedChatInputSendOptions,
): void => {
  const runtimeOverride = options.conversationRuntimeConfigOverride;
  if (!runtimeOverride) {
    return;
  }

  const recordFailure = (error: unknown): void => {
    // The active run already has its request snapshot. Keep the setter failure
    // non-blocking so a later hydration can reconcile the UI with the persisted
    // value rather than treating the snapshot as saved.
    void window.snow.writeLog("WARN", {
      module: "conversation-runtime",
      func: "setConversationRuntimeConfig",
      message: "Failed to persist pending conversation runtime config",
      context: JSON.stringify({ conversationId }),
      error: getErrorMessage(error),
    });
  };

  try {
    void window.snow
      .setConversationRuntimeConfig(
        conversationId,
        runtimeOverride.thinkingStrength,
        runtimeOverride.responsesFastMode,
      )
      .catch(recordFailure);
  } catch (error) {
    recordFailure(error);
  }
};

const normalizeWorkspacePath = (
  filePath: string,
  workspacePath?: string,
): string => {
  const normalizedPath = filePath.replace(/\\/g, "/").replace(/\/+$/, "") || ".";
  const normalizedWorkspace = workspacePath
    ?.replace(/\\/g, "/")
    .replace(/\/+$/, "");
  if (!normalizedWorkspace) {
    return normalizedPath;
  }

  const isWindowsPath = /^[a-z]:\//i.test(normalizedWorkspace);
  const comparablePath = isWindowsPath
    ? normalizedPath.toLowerCase()
    : normalizedPath;
  const comparableWorkspace = isWindowsPath
    ? normalizedWorkspace.toLowerCase()
    : normalizedWorkspace;
  if (normalizedPath === ".") {
    return "<workspace>";
  }
  if (normalizedPath.startsWith("./")) {
    return `<workspace>/${normalizedPath.slice(2)}`;
  }
  if (comparablePath === comparableWorkspace) {
    return "<workspace>";
  }
  if (comparablePath.startsWith(`${comparableWorkspace}/`)) {
    return `<workspace>/${normalizedPath.slice(normalizedWorkspace.length + 1)}`;
  }
  return normalizedPath;
};

const canonicalizeToolArguments = (
  argumentsJson: string,
  toolName?: string,
  workspacePath?: string,
): string | null => {
  try {
    const sortJson = (value: unknown): unknown => {
      if (Array.isArray(value)) {
        return value.map(sortJson);
      }
      if (value && typeof value === "object") {
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, child]) => [key, sortJson(child)]),
        );
      }
      return value;
    };
    const parsed = JSON.parse(argumentsJson || "{}") as Record<string, unknown>;
    if (
      toolName === "filesystem-read" &&
      typeof parsed.filePath === "string"
    ) {
      parsed.filePath = normalizeWorkspacePath(parsed.filePath, workspacePath);
    }
    return JSON.stringify(sortJson(parsed));
  } catch {
    return null;
  }
};

const isFailedToolResult = (result: string): boolean => {
  try {
    const parsed = JSON.parse(result) as Record<string, unknown>;
    return parsed.success === false || typeof parsed.error === "string";
  } catch {
    return false;
  }
};

export type UseAgentLoopParams = {
  ctx: ConversationContextValue;
  requestToolAuthorizations: (
    toolCalls: ToolCallInfo[],
    conversationId: string,
    projectId?: string,
  ) => Promise<ToolAuthorizationDecision[]>;
  rejectToolAuthorizations: (sessionKey?: string) => void;
  rejectPendingUserQuestions: (sessionKey?: string) => void;
};

/**
 * Agent 循环逻辑：处理用户消息发送、子代理激活、主 agent 循环和检查点初始化。
 * 这些函数深度嵌套，共享闭包变量，必须放在同一个文件中。
 */
export const useAgentLoop = (params: UseAgentLoopParams) => {
  const { ctx, requestToolAuthorizations } = params;

  // Plan approval is isolated per main-conversation session so parallel chats
  // cannot borrow each other's approval. The key set lives on ctx
  // (planApprovedSessionKeysRef) so it is cleared only when Plan Mode is
  // genuinely turned off (user toggle / Goal Mode mutual exclusion / new
  // chat). Switching conversations restores the target session's mode via
  // setPlanModeState directly and must NOT clear it — otherwise an approved
  // plan is lost when the user navigates away and back.
  const planApprovedSessionKeysRef = ctx.planApprovedSessionKeysRef;

  const handleSendMessage = useCallback(
    (message: string, options: ChatInputSendOptions) => {
      const trimmed = message.trim();
      if (!trimmed) {
        return;
      }

      let capturedOptions = captureChatInputSendOptions(options);
      // 程序化发送（pending 队列自动冲刷）携带目标会话 key：消息必须发到
      // 队列所属的会话，而不是用户当前停留的视图会话。
      const sessionKey =
        options.targetSessionKey ??
        ctx.activeSessionKeyRef.current ??
        PENDING_SESSION_KEY;
      const existingRef = ctx.sessionsRefData.current.get(sessionKey);
      // A sub-agent conversation becomes read-only as soon as its run ends.
      // The input box is hidden in the UI; this guard closes the remaining
      // programmatic paths (a last-moment send racing the status event, or a
      // finishing parent loop flushing its pending queue while the user is
      // viewing the terminated sub-agent conversation).
      if (existingRef?.subAgentTerminated) {
        return;
      }
      if (existingRef?.isSending) {
        const queue = ctx.pendingQueueRef.current.get(sessionKey) ?? [];
        queue.push({ text: trimmed, options: capturedOptions });
        ctx.pendingQueueRef.current.set(sessionKey, queue);
        ctx.setActivePendingMessages(queue.map((item) => item.text));
        return;
      }

      // 程序化发送（targetSessionKey）是既有会话的后续消息，永远不是
      // 首条消息：不参与占位记录/首条 summary/回滚状态合并等首条逻辑。
      const isFirstMessage =
        ctx.activeConversationIdRef.current === undefined &&
        !options.targetSessionKey;
      const rollbackState = isFirstMessage ? ctx.rollbackNewChatState : null;
      if (rollbackState) {
        capturedOptions = {
          ...capturedOptions,
          model: capturedOptions.model || rollbackState.model || undefined,
          apiProfile:
            capturedOptions.apiProfile || rollbackState.apiProfile || undefined,
          thinkingStrength:
            capturedOptions.thinkingStrength ??
            rollbackState.thinkingStrength ??
            undefined,
          responsesFastMode:
            capturedOptions.responsesFastMode ??
            rollbackState.responsesFastMode,
          conversationRuntimeConfigOverride:
            capturedOptions.conversationRuntimeConfigOverride ?? {
              thinkingStrength: rollbackState.thinkingStrength,
              responsesFastMode: rollbackState.responsesFastMode,
            },
        };
      }
      // Consume the one-shot target project set by handleNewChat(directoryId)
      // (e.g. a scheduled task firing for its bound project) so the new
      // PENDING session lands in the task's project instead of the currently
      // active one. Cleared immediately — it applies to this send only.
      const pendingDirId = ctx.pendingDirectoryIdRef.current;
      ctx.pendingDirectoryIdRef.current = undefined;
      const sessionDirId =
        existingRef?.directoryId ?? pendingDirId ?? ctx.directoryId;
      // One-shot scheduled-task name (set by buildFromContent) consumed here so
      // the new session can show a "triggered by scheduled task" banner in the
      // message list. Cleared immediately — it applies to this send only.
      const pendingTaskName = ctx.pendingTaskNameRef.current;
      ctx.pendingTaskNameRef.current = undefined;

      // Reset only this session's approval for the new user task. Other
      // conversations may still be executing their independently approved plan.
      planApprovedSessionKeysRef.current.delete(sessionKey);

      // Sending a new message cancels any prior "new chat" intent — the
      // user is now interacting with this session, so the UI should follow
      // it normally (including auto-switching when the pending session
      // migrates to a real conversation id). 程序化发送（targetSessionKey）
      // 不是用户在目标会话交互：不得重置 newChatRequested，否则会把用户
      // 从当前停留的新建会话视图推进一个没有 session 的空槽位（空问候）。
      if (!options.targetSessionKey) {
        ctx.setNewChatRequested(false);
      }

      ctx.ensureSession(sessionKey, sessionDirId);
      const sessionRef = ctx.sessionsRefData.current.get(sessionKey);
      // Capture the current runId so runAgentLoop can detect when a newer
      // send or abort has superseded this invocation.
      const currentRunId = (sessionRef?.runId ?? 0) + 1;
      if (sessionRef) {
        sessionRef.isSending = true;
        sessionRef.isAbortRequested = false;
        sessionRef.runId = currentRunId;
      }

      // 宠物联动：本次 run 的唯一回合 id —— start/end 按 id 一一核销。
      // 多会话并行、中止、被新发送顶替的 run 各自核销自己的回合，
      // 不会互相污染计数（旧实现的匿名计数在这些路径上会永久漂移）。
      const petTurnId = `turn-${Date.now().toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 10)}`;
      window.snow.notifyPetTurnStarted(
        petTurnId,
        capturedOptions.kind === "review" ? "review" : "chat",
      );

      // Reset pause state for a fresh send — the previous run may have
      // been paused and aborted without cleaning up the controller.
      ctx.updateSessionField(sessionKey, "isPaused", false);
      ctx.pauseControllerRef.current.delete(sessionKey);

      const userMessage: ChatConversationMessage = {
        id: createMessageId("user"),
        role: "user",
        content: trimmed,
        timestamp: formatMessageTime(),
        status: "sent",
      };
      const assistantMessageId = createMessageId("assistant");
      const pendingAssistantMessage: ChatConversationMessage = {
        id: assistantMessageId,
        role: "assistant",
        content: "",
        timestamp: formatMessageTime(),
        status: "sending",
        model: capturedOptions.model,
      };

      ctx.updateSessionField(sessionKey, "isStreaming", true);
      // Stamp the session with the scheduled-task trigger info (if any) so the
      // message list can render a "triggered by task" banner. Only on the
      // first message — a task firing always starts a brand-new conversation.
      if (isFirstMessage && pendingTaskName) {
        ctx.updateSessionField(sessionKey, "triggeredByTask", {
          name: pendingTaskName,
          triggeredAt: new Date().toISOString(),
        });
      }
      // Reset per-run and per-iteration probes before the first model request.
      resetRunStreamMetrics(ctx, sessionKey);
      // Anchor the wall-clock start of the accumulating elapsed timer once
      // per agent loop. StreamMetrics derives its elapsed display from this
      // timestamp instead of the backend's per-iteration streamElapsedMs
      // (which resets on every createResponseStream call), so the timer
      // keeps ticking across iterations and survives conversation switches.
      // runStartedAt mirrors it locally so the finally block can compute the
      // finished run's duration even after the field is reset to 0.
      const runStartedAt = Date.now();
      ctx.updateSessionField(sessionKey, "streamStartedAt", runStartedAt);
      ctx.addStreamingId(sessionKey);
      ctx.updateSessionMessages(sessionKey, (currentMessages) => [
        ...currentMessages,
        userMessage,
        pendingAssistantMessage,
      ]);

      // First message: immediately show a placeholder in the sidebar list
      // so the user sees the new conversation without waiting for AI response.
      if (isFirstMessage) {
        const nowIso = new Date().toISOString();
        const preview =
          trimmed.length > 50 ? `${trimmed.slice(0, 50)}...` : trimmed;
        ctx.setUpsertedConversation({
          record: {
            // 占位记录使用本会话自己的 pending 槽位 key：点击侧边栏占位
            // 项可回到该会话视图（迁移时自动切换到真实 conversationId）。
            conversationId: sessionKey,
            title: trimmed,
            summary: "",
            lastMessagePreview: preview,
            messageCount: 1,
            model: capturedOptions.model ?? "",
            apiProfileName: capturedOptions.apiProfile ?? "",
            status: "active",
            directoryId: sessionDirId ?? "",
            forkedFromConversationId: "",
            forkMessageCount: 0,
            conversationType: "main",
            parentConversationId: "",
            subAgentId: "",
            subAgentName: "",
            subAgentStatus: "",
            subAgentError: "",
            createdAt: nowIso,
            updatedAt: nowIso,
            inputTokens: 0,
            outputTokens: 0,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            totalDurationMs: 0,
            runInputTokens: 0,
            runOutputTokens: 0,
            runCacheCreationInputTokens: 0,
            runCacheReadInputTokens: 0,
            lastRunDurationMs: 0,
            emoji: "",
          },
          timestamp: Date.now(),
        });
      } else {
        // Follow-up message: immediately bump the conversation to the top
        // of the sidebar list without waiting for AI response.
        const followUpId = sessionKey;
        void window.snow
          .getChatConversation(followUpId)
          .then((conv) => {
            if (conv) {
              ctx.setUpsertedConversation({
                record: { ...conv, updatedAt: new Date().toISOString() },
                timestamp: Date.now(),
              });
            }
          })
          .catch(() => {
            // Sidebar refresh failure should not block the conversation
          });
      }

      let finalSessionKey = sessionKey;
      let summaryTriggered = false;

      const isRunCancelled = createIsRunCancelled(ctx, currentRunId);

      // 为 run 中途刷新的待发消息创建专属 checkpoint 并登记到会话
      // checkpointIds，保证"回滚到该消息"能恢复到它处理前的文件状态。
      // createCheckpoint 是异步的：await 期间本 run 可能已被取消或被更新
      // 的 run 取代（停止按钮、PendingMessages 强制发送会先 handleAbort
      // 再立即启动新 run），已被取代的 checkpoint 直接删除、不登记。
      // SSH 目录同样创建（后端经 SFTP 捕获）；创建失败时返回 undefined
      // （调用方退回无 checkpoint 的旧行为，消息照常刷新）。
      const createFlushCheckpoint = async (
        flushKey: string,
        flushDirPath: string | undefined,
      ): Promise<string | undefined> => {
        if (!flushDirPath) {
          return undefined;
        }
        try {
          const flushCheckpointId =
            await window.snow.createCheckpoint(flushDirPath);
          if (isRunCancelled(flushKey)) {
            if (flushCheckpointId) {
              deleteCheckpoints([flushCheckpointId]);
            }
            return undefined;
          }
          const flushRef = ctx.sessionsRefData.current.get(flushKey);
          if (flushRef) {
            // 仅用于临时清理，不代表消息顺序。
            flushRef.checkpointIds = [
              ...flushRef.checkpointIds,
              flushCheckpointId,
            ];
          }
          if (!ctx.sessionsRef.current[flushKey]?.baselineCheckpointId) {
            ctx.updateSessionField(
              flushKey,
              "baselineCheckpointId",
              flushCheckpointId,
            );
          }
          return flushCheckpointId;
        } catch {
          // Best effort — continue without a checkpoint
          return undefined;
        }
      };

      const awaitHookDecision = createAwaitHookDecision(ctx);

      // A provider can resend a successful read with a fresh call ID. Keep
      // this state scoped to one agent run, so a later user message starts
      // clean while a write within this run deliberately permits a re-read.
      const completedReadonlyCalls = new Set<string>();
      let duplicateRecoveryAttempted = false;
      const workspacePath =
        directoryIdToPath(sessionDirId) ?? ctx.directoryPath;
      let readonlyToolNamesPromise: Promise<Set<string>> | undefined;
      const getReadonlyToolNames = (): Promise<Set<string>> => {
        readonlyToolNamesPromise ??= window.snow
          .listReadonlyTools()
          .then((names) => new Set(names))
          .catch(() => new Set<string>());
        return readonlyToolNamesPromise;
      };
      const isReadonlyCall = (
        toolCall: ToolCallInfo,
        readonlyToolNames: Set<string>,
      ): boolean => {
        if (!readonlyToolNames.has(toolCall.name)) {
          return false;
        }
        if (toolCall.name !== "todo-todo-manage") {
          return true;
        }
        try {
          return (
            (JSON.parse(toolCall.arguments || "{}") as { action?: unknown })
              .action === "get"
          );
        } catch {
          return false;
        }
      };
      const readonlyCallKey = (toolCall: ToolCallInfo): string | null => {
        const argumentsJson = canonicalizeToolArguments(
          toolCall.arguments,
          toolCall.name,
          workspacePath,
        );
        return argumentsJson === null
          ? null
          : `${toolCall.name}:${argumentsJson}`;
      };

      const executeSubAgentActivation = createSubAgentActivation({
        ctx,
        requestToolAuthorizations,
        parentApiProfile: capturedOptions.apiProfile,
        parentModel: capturedOptions.model,
        parentThinkingStrength: capturedOptions.thinkingStrength,
        parentResponsesFastMode: capturedOptions.responsesFastMode,
        planApprovedSessionKeysRef,
      });
      // 主会话子代理管理工具（listSubAgents / continue）执行器：会话隔离
      // 在内部强制，只允许操作当前会话自己的子代理；continue 在内存无
      // 恢复器时（应用重启后）自动从 DB 重建。
      const executeSubAgentMainTool = createSubAgentMainToolExecutor(ctx, {
        requestToolAuthorizations,
        planApprovedSessionKeysRef,
        parentThinkingStrength: capturedOptions.thinkingStrength,
        parentResponsesFastMode: capturedOptions.responsesFastMode,
      });

      const runAgentLoop = async (
        currentAssistantMessageId: string,
        requestMessages: {
          role: "user" | "assistant" | "system" | "developer" | "tool";
          content: string;
          toolResultsJson?: string;
        }[],
        currentConversationId: string | undefined,
        checkpointId?: string,
        // Internal auto-compaction resume: the compaction handoff is already
        // persisted as the latest context_compaction boundary, so the Rust
        // backend builds the request context from the database and treats
        // requestMessages as a placeholder (never sent nor persisted).
        resumeAfterCompaction?: boolean,
        // A one-shot recovery continuation preserves history and tool results,
        // but asks every provider to omit its outbound tools array.
        disableTools = false,
        // Request-local system-level recovery instruction. This deliberately
        // does not become a conversation message or persisted user content.
        internalRecoveryPrompt?: string,
      ): Promise<void> => {
        const iterSessionKey = currentConversationId ?? sessionKey;
        let effectiveKey = iterSessionKey;

        if (isRunCancelled(effectiveKey)) {
          return;
        }

        // Pause checkpoint: before sending the next AI request, check whether
        // the user paused this session. If paused, block here until resumed
        // or cancelled. This is the natural boundary — the previous response
        // has already been fully rendered, and no new streaming has started.
        const pauseController =
          ctx.pauseControllerRef.current.get(effectiveKey);
        if (pauseController?.paused) {
          await new Promise<void>((resolve) => {
            pauseController.resolve = resolve;
          });
          if (isRunCancelled(effectiveKey)) {
            return;
          }
        }

        // Capture the stream promise so rollback can await it before issuing
        // delete/truncate. Without this, the Rust store_chat_exchange write
        // transaction races with the delete/truncate write transaction and
        // can exceed the busy_timeout, producing "database is locked".
        // Per-conversation mode snapshot: read the modes from THIS session's
        // ref (falling back to the global defaults for safety), never from
        // the live global refs — another conversation toggling its modes
        // must not alter the behaviour of a background-running loop.
        const iterRef = ctx.sessionsRefData.current.get(effectiveKey);
        const streamPromise = window.snow.createResponseStream(
          {
            messages: requestMessages,
            model: capturedOptions.model,
            apiProfile: capturedOptions.apiProfile,
            thinkingStrength: capturedOptions.thinkingStrength,
            responsesFastMode: capturedOptions.responsesFastMode,
            conversationId: currentConversationId,
            directoryId: sessionDirId,
            checkpointId,
            resumeAfterCompaction,
            disableTools,
            internalRecoveryPrompt,
            planMode: iterRef?.planMode ?? ctx.planModeRef.current,
            goalMode: iterRef?.goalMode ?? ctx.goalModeRef.current,
            worktreeMode: iterRef?.worktreeMode ?? ctx.worktreeModeRef.current,
          },
          createStreamChunkHandler(
            ctx,
            effectiveKey,
            currentAssistantMessageId,
            () => isRunCancelled(effectiveKey),
          ),
          createStreamIdHandler(ctx, effectiveKey, () =>
            isRunCancelled(effectiveKey),
          ),
        );
        const streamRefBefore = ctx.sessionsRefData.current.get(effectiveKey);
        if (streamRefBefore) {
          streamRefBefore.streamPromise = streamPromise;
        }

        const response = await streamPromise;
        const responseDisposition = resolveResponseDisposition(response);
        const responseFailed = responseDisposition.kind === "error";

        const ref = ctx.sessionsRefData.current.get(effectiveKey);
        if (ref) {
          ref.streamId = null;
          ref.streamPromise = null;
        }

        // Replace the frontend-generated temporary user message id with the
        // real database id returned by store_chat_exchange. The backend
        // persists user messages in order and returns their snowflake ids in
        // persistedUserMessageIds. This keeps the in-memory message id in sync
        // with the DB so features like the user-message rail (which queries
        // the DB for message ids) can locate the DOM element by id without
        // restarting the app.
        if (
          response.persistedUserMessageIds &&
          response.persistedUserMessageIds.length > 0
        ) {
          // Collect all pending (non-persisted) user message ids in order so
          // we can map them 1:1 to the returned DB ids.
          const pendingUserIds: string[] = [];
          const currentMessages =
            ctx.sessionsRef.current[effectiveKey]?.messages ?? [];
          for (const m of currentMessages) {
            if (m.role === "user" && !m.isContextCompaction) {
              // A user message is "pending" (needs id replacement) if its id
              // does not look like a DB snowflake id. Frontend ids use the
              // pattern "user-{timestamp}-{random}"; DB ids are numeric
              // snowflake strings.
              const isFrontendId = isNaN(Number(m.id));
              if (isFrontendId) {
                pendingUserIds.push(m.id);
              }
            }
          }

          // Build a mapping from old frontend id -> new DB id. The backend
          // returns ids in the same order as the user messages in the request.
          const idRemap = new Map<string, string>();
          const remapCount = Math.min(
            pendingUserIds.length,
            response.persistedUserMessageIds.length,
          );
          for (let i = 0; i < remapCount; i++) {
            idRemap.set(pendingUserIds[i], response.persistedUserMessageIds[i]);
          }

          if (idRemap.size > 0) {
            ctx.updateSessionMessages(effectiveKey, (msgs) =>
              msgs.map((m) => {
                const newId = idRemap.get(m.id);
                return newId ? { ...m, id: newId } : m;
              }),
            );
            // Update the outer-scope userMessage reference so downstream code
            // (checkpoint association, error retry) uses the real DB id.
            const remappedUser = idRemap.get(userMessage.id);
            if (remappedUser) {
              userMessage.id = remappedUser;
            }
          }
        }

        if (response.conversationId) {
          if (isPendingSessionKey(effectiveKey)) {
            // 迁移前的 pending 槽位 key：自动切换判断必须用它（effectiveKey
            // 在 migrateSession 之后会被赋值为真实 conversationId）。
            const migratingPendingKey = effectiveKey;
            // Plan Mode approval obtained while the session was still pending
            // must follow the session to its real conversation id. Otherwise
            // the approval stays keyed under the pending slot key and the next
            // agent-loop iteration (effectiveKey = conversationId) hits the
            // Rust hard gate again — the model sees "Plan Mode write blocked"
            // even though the user already approved the plan.
            if (planApprovedSessionKeysRef.current.has(effectiveKey)) {
              planApprovedSessionKeysRef.current.delete(effectiveKey);
              planApprovedSessionKeysRef.current.add(response.conversationId);
            }
            ctx.migrateSession(effectiveKey, response.conversationId);
            ctx.setRollbackNewChatState(null);
            // Persist only the explicit pending-session snapshot. Request-level
            // thinking/Fast Mode values (including scheduled one-shot values)
            // intentionally stay separate from this durable conversation state.
            persistPendingConversationRuntimeConfig(
              response.conversationId,
              capturedOptions,
            );
            effectiveKey = response.conversationId;
            finalSessionKey = response.conversationId;
            // The pending session's Plan/Goal Mode (set before the session
            // had a real id) now has a persisted conversation id: write it
            // through so the modes survive a restart.
            const migratedRef = ctx.sessionsRefData.current.get(
              response.conversationId,
            );
            if (migratedRef) {
              void window.snow.setConversationModes(
                response.conversationId,
                migratedRef.planMode,
                migratedRef.goalMode,
                migratedRef.worktreeMode,
                migratedRef.goalModeTokenBudget,
              );
            }
            // Only set active conversation on the first iteration when
            // migrating from pending. Subsequent tool iterations must NOT
            // override the active conversation — the user may have switched
            // to a different conversation while tools are running.
            // 只当用户仍停留在这个 run 自己的会话视图时才自动切换：用户
            // 显式新建的会话拥有独立的 pending 槽位 key（activeSessionKeyRef
            // 指向新槽位），旧会话迁移绝不能把视图拉走；若用户从侧边栏
            // 点回本 pending 会话（activeSessionKeyRef === migratingPendingKey），
            // 迁移后视图跟随到真实 conversationId。
            if (
              ctx.activeSessionKeyRef.current === migratingPendingKey &&
              !ctx.newChatRequestedRef.current
            ) {
              ctx.setActiveId(response.conversationId);
            }

            // First message: replace the pending placeholder with the real
            // conversation record. This runs only once on session migration;
            // subsequent AI iterations must NOT refresh the list to avoid
            // excessive re-sorting. Follow-up messages already refreshed the
            // list at send time (handleSendMessage).
            if (!responseFailed) {
              const refreshId = response.conversationId;
              void window.snow
                .getChatConversation(refreshId)
                .then((conv) => {
                  if (conv) {
                    ctx.setUpsertedConversation({
                      record: conv,
                      timestamp: Date.now(),
                    });
                  }
                })
                .catch(() => {
                  // Upsert failure should not block the conversation
                });
            }
          }

          // Trigger summary generation as soon as the conversation is
          // created and the first user message is persisted. No need to
          // wait for the entire agent loop (tool calls, multi-turn AI
          // responses) to finish.
          if (
            isFirstMessage &&
            !summaryTriggered &&
            responseDisposition.kind === "complete"
          ) {
            summaryTriggered = true;
            const summaryConvId = response.conversationId;
            // Track the summary promise so rollback can await it before
            // issuing delete/truncate. The Rust backend writes
            // update_conversation_summary at the end of this promise — if it
            // races with deleteConversation, the database locks.
            const summaryPromise = window.snow
              .generateConversationSummary(summaryConvId)
              .then((generatedSummary) => {
                if (generatedSummary) {
                  ctx.updateSessionField(
                    summaryConvId,
                    "summary",
                    generatedSummary,
                  );
                  return window.snow.getChatConversation(summaryConvId);
                }
                return null;
              })
              .then((updated) => {
                if (updated) {
                  ctx.setUpsertedConversation({
                    record: updated,
                    timestamp: Date.now(),
                  });
                }
              })
              .catch(() => {
                // Summary generation failure should not block the conversation
              })
              .finally(() => {
                const summaryRef =
                  ctx.sessionsRefData.current.get(summaryConvId);
                if (
                  summaryRef &&
                  summaryRef.summaryPromise === summaryPromise
                ) {
                  summaryRef.summaryPromise = null;
                }
              });
            const summaryRefForPromise =
              ctx.sessionsRefData.current.get(summaryConvId);
            if (summaryRefForPromise) {
              summaryRefForPromise.summaryPromise = summaryPromise;
            }
          }
        }

        // Bump the conversation version so dependent components (e.g. the
        // user-message rail) know the DB message list changed (the user
        // message is now persisted via store_chat_exchange) and re-fetch.
        ctx.setConversationVersion((version) => version + 1);

        if (response.tokenUsage && !responseFailed) {
          ctx.updateSessionField(
            effectiveKey,
            "tokenUsage",
            response.tokenUsage,
          );
          // response.tokenUsage covers this request only; keep a run-level
          // sum so the summary bar can show the whole loop's consumption.
          accumulateRunTokenUsage(ctx, effectiveKey, response.tokenUsage);
        }

        // A final incomplete-like response is terminal for this model
        // iteration. Rust owns transport retries, so the renderer only keeps
        // safe display data and must not parse tools, compact, or recurse.
        if (responseDisposition.kind === "incomplete") {
          ctx.updateSessionMessages(effectiveKey, (currentMessages) =>
            currentMessages.map((currentMessage) =>
              currentMessage.id === currentAssistantMessageId
                ? {
                    ...currentMessage,
                    content: response.content || currentMessage.content || "",
                    thinking:
                      response.thinking || currentMessage.thinking || undefined,
                    timestamp: formatMessageTime(),
                    status: "incomplete" as const,
                    incompleteVariant: responseDisposition.variant,
                    interruptionReason: responseDisposition.reason,
                    recoveryOutcome: responseDisposition.recoveryOutcome,
                    responseId: response.id || undefined,
                    model: response.model || capturedOptions.model,
                    toolCalls: undefined,
                    isRetrying: false,
                    retryAttempt: undefined,
                    retryError: undefined,
                  }
                : currentMessage,
            ),
          );
          return;
        }

        // Only complete responses may expose executable tool calls. Error
        // responses keep their existing terminal path with an empty tool list.
        const toolCalls =
          responseDisposition.kind === "complete"
            ? parseToolCalls(response.toolCallsJson)
            : [];
        const visibleToolCalls = toolCalls;

        // Auto-compaction check: when the active API config has
        // enableAutoCompress=true and the total token usage exceeds the
        // configured threshold, compact the context so the AI loop can
        // continue without hitting the context window limit.
        //
        // The check ONLY runs while the loop is still alive — i.e. the
        // response carries tool calls to process, or user messages are queued
        // and about to be injected. When the loop is finishing naturally (no
        // tool calls, no pending user messages), compaction must NOT fire even
        // if the threshold is crossed: it would spawn a fresh runAgentLoop
        // iteration and wake the AI back up right after it completed. The
        // over-threshold context is handled instead the next time the user
        // sends a message, by the pre-send compaction in initCheckpointAndRun.
        //
        // The compaction summary is appended as a new user message in the
        // database (handled by performCompaction). We then start a fresh
        // runAgentLoop iteration with the compacted context so the AI
        // picks up from the summary and continues working.
        const loopWillContinue =
          toolCalls.length > 0 ||
          (ctx.pendingQueueRef.current.get(effectiveKey)?.length ?? 0) > 0;
        if (
          loopWillContinue &&
          response.tokenUsage &&
          !responseFailed &&
          !isPendingSessionKey(effectiveKey)
        ) {
          // Use the conversation-scoped profile (capturedOptions.apiProfile) so the
          // auto-compaction decision matches the API config the conversation
          // actually runs on — never the global active profile.
          const apiConfig = await ctx.getActiveApiConfig(
            capturedOptions.apiProfile,
          );
          if (apiConfig?.enableAutoCompress) {
            // autoCompressThreshold is stored in TOKENS (resolved from the
            // configured percent against maxContextTokens when the config is
            // saved). Compare the live token total against it directly — do NOT
            // run it through calculateAutoCompressThresholdTokens, which expects
            // a percent and would clamp a token value to 100% of the context.
            const thresholdTokens = apiConfig.autoCompressThreshold;
            if (thresholdTokens != null && thresholdTokens > 0) {
              const totalTokens =
                response.tokenUsage.inputTokens +
                response.tokenUsage.outputTokens;
              if (totalTokens >= thresholdTokens) {
                // Finalize the assistant message that crossed the threshold so
                // it does not linger in "sending" state (the normal finalize
                // step below is skipped when we divert into compaction). Any
                // tool calls it emitted are abandoned by the handoff; the Rust
                // compaction boundary plus ensure_tool_pairing keep the
                // post-compaction context free of orphan tool entries, so the
                // next request cannot fail with an orphan-tool 400 error.
                ctx.updateSessionMessages(effectiveKey, (currentMessages) =>
                  currentMessages.map((currentMessage) =>
                    currentMessage.id === currentAssistantMessageId
                      ? {
                          ...currentMessage,
                          content:
                            response.content || currentMessage.content || "",
                          thinking:
                            response.thinking ||
                            currentMessage.thinking ||
                            undefined,
                          timestamp: formatMessageTime(),
                          status: "sent",
                          responseId: response.id || undefined,
                          model: response.model || capturedOptions.model,
                          isRetrying: false,
                        }
                      : currentMessage,
                  ),
                );

                const compactionResult = await ctx.performCompactionRef.current(
                  effectiveKey,
                  capturedOptions.model,
                  true,
                  undefined,
                  capturedOptions.apiProfile,
                  undefined,
                  undefined,
                  capturedOptions.thinkingStrength,
                  capturedOptions.responsesFastMode,
                );

                if (compactionResult) {
                  if (isRunCancelled(effectiveKey)) {
                    return;
                  }

                  // performCompaction's finally resets isSending=false, but the
                  // agent loop is still mid-send. Restore it so handleAbort keeps
                  // working (it bails out when isSending is false) and the session
                  // stays locked until the loop finishes — mirroring the pre-send
                  // compaction path.
                  const sessionRefAfterCompaction =
                    ctx.sessionsRefData.current.get(effectiveKey);
                  if (sessionRefAfterCompaction) {
                    sessionRefAfterCompaction.isSending = true;
                    sessionRefAfterCompaction.isAbortRequested = false;
                  }

                  // Start a new agent loop iteration with the compacted
                  // context. The Rust backend uses conversationId to
                  // reconstruct context from the database, so the
                  // compaction summary message is automatically included.
                  // resumeAfterCompaction tells Rust to treat the summary
                  // passed below as a placeholder: the handoff is already
                  // persisted as the context_compaction boundary, so it is
                  // neither sent twice nor re-persisted as a normal user
                  // message. protectedMessages（压缩前最后一条用户任务原文）
                  // 紧随占位之后传入，Rust 会注入请求并持久化，确保 AI
                  // 压缩后仍记得任务与 TODO 状态。
                  const postCompactionAssistantId =
                    createMessageId("assistant");
                  const postCompactionAssistant: ChatConversationMessage = {
                    id: postCompactionAssistantId,
                    role: "assistant",
                    content: "",
                    timestamp: formatMessageTime(),
                    status: "sending",
                    model: capturedOptions.model,
                  };
                  ctx.updateSessionMessages(effectiveKey, (currentMessages) => [
                    ...currentMessages,
                    postCompactionAssistant,
                  ]);
                  await runAgentLoop(
                    postCompactionAssistantId,
                    [
                      { role: "user", content: compactionResult.content },
                      ...(compactionResult.protectedMessages ?? []),
                    ],
                    response.conversationId,
                    compactionResult.checkpointId,
                    true,
                  );
                  return;
                }
              }
            }
          }
        }

        if (isRunCancelled(effectiveKey)) {
          return;
        }

        // Failed responses still migrate the session, but remain visible
        // locally as an error. Complete responses are finalized as sent.
        ctx.updateSessionMessages(effectiveKey, (currentMessages) =>
          currentMessages.map((currentMessage) => {
            if (currentMessage.id !== currentAssistantMessageId) {
              return currentMessage;
            }

            return {
              ...currentMessage,
              content: response.content || currentMessage.content || "",
              thinking:
                response.thinking || currentMessage.thinking || undefined,
              timestamp: formatMessageTime(),
              status: responseFailed ? "error" : "sent",
              responseId: response.id || undefined,
              model: response.model || capturedOptions.model,
              toolCalls:
                visibleToolCalls.length > 0 ? visibleToolCalls : undefined,
              isRetrying: false,
            };
          }),
        );

        if (responseFailed) {
          return;
        }

        // If no tool calls, check for pending user messages before finishing.
        // This injects messages queued during AI streaming without waiting for
        // the entire outer handleSendMessage to complete.
        if (toolCalls.length === 0) {
          const pendingQueueNoTools =
            ctx.pendingQueueRef.current.get(effectiveKey) ?? [];
          if (pendingQueueNoTools.length > 0) {
            // 为待发消息创建专属 checkpoint：回滚到这条消息时能恢复到它
            // 处理前的文件状态（此前刷新路径不建 checkpoint，回滚这类
            // 消息永远显示"无文件变更"，且后续消息的变更还会错记到更早
            // 的 checkpoint 上）。创建期间 run 被中止/顶替时 checkpoint
            // 已由 createFlushCheckpoint 删除，此处直接放弃刷新，队列
            // 保持原样交给后续 run 处理，避免消息悬空。
            const flushDirPath =
              directoryIdToPath(sessionDirId) ?? ctx.directoryPath;
            const flushCheckpointId = await createFlushCheckpoint(
              effectiveKey,
              flushDirPath,
            );
            if (isRunCancelled(effectiveKey)) {
              return;
            }
            if (pendingQueueNoTools.length === 0) {
              // 创建期间用户撤回了全部待发消息：不刷新，丢弃 checkpoint。
              if (flushCheckpointId) {
                deleteCheckpoints([flushCheckpointId]);
              }
              return;
            }
            ctx.pendingQueueRef.current.delete(effectiveKey);
            const pendingText = pendingQueueNoTools
              .map((item) => item.text)
              .join("\n\n");
            ctx.setActivePendingMessages([]);

            const pendingUserMsg: ChatConversationMessage = {
              id: createMessageId("user"),
              role: "user",
              content: pendingText,
              timestamp: formatMessageTime(),
              status: "sent",
              checkpointId: flushCheckpointId,
            };
            const nextAssistantId = createMessageId("assistant");
            const nextPendingAssistant: ChatConversationMessage = {
              id: nextAssistantId,
              role: "assistant",
              content: "",
              timestamp: formatMessageTime(),
              status: "sending",
              model: capturedOptions.model,
            };
            ctx.updateSessionMessages(effectiveKey, (currentMessages) => [
              ...currentMessages,
              pendingUserMsg,
              nextPendingAssistant,
            ]);
            await runAgentLoop(
              nextAssistantId,
              [{ role: "user", content: pendingText }],
              response.conversationId,
              flushCheckpointId,
            );
          }
          return;
        }

        // A provider that returns calls after tools were deliberately omitted
        // has violated the request contract. Record the calls for auditability
        // but do not authorize, execute, or recurse into another loop.
        if (disableTools) {
          const ignoredResult = JSON.stringify({
            success: false,
            error: "TOOLS_DISABLED_FOR_DUPLICATE_RECOVERY",
            message:
              "Tools were disabled for this recovery request because equivalent read-only calls already completed. No tool was executed.",
          });
          ctx.updateSessionMessages(effectiveKey, (currentMessages) =>
            currentMessages.map((currentMessage) =>
              currentMessage.id === currentAssistantMessageId
                ? {
                    ...currentMessage,
                    toolCalls: toolCalls.map((toolCall) => ({
                      ...toolCall,
                      status: "completed" as const,
                      result: ignoredResult,
                    })),
                  }
                : currentMessage,
            ),
          );
          if (response.conversationId) {
            await window.snow.appendToolMessage(
              response.conversationId,
              formatToolResultsContent(
                toolCalls.map((toolCall) => ({
                  name: toolCall.name,
                  callId: toolCall.callId || "",
                  result: ignoredResult,
                })),
              ),
            );
          }
          ctx.pendingQueueRef.current.delete(effectiveKey);
          ctx.setActivePendingMessages([]);
          return;
        }

        // Tool calls are normally processed into results and followed by
        // another model request. A batch made entirely of repeated successful
        // readonly calls is terminal: its duplicate results are persisted, but
        // sending them back to a provider that already ignored the prior result
        // would only create an unbounded request loop.
        const readonlyToolNames = await getReadonlyToolNames();
        const duplicateReadonlyResults = new Map<ToolCallInfo, string>();
        const executableToolCalls = toolCalls.filter((toolCall) => {
          const key = readonlyCallKey(toolCall);
          if (
            key === null ||
            !isReadonlyCall(toolCall, readonlyToolNames) ||
            !completedReadonlyCalls.has(key)
          ) {
            return true;
          }

          const result = JSON.stringify({
            success: false,
            error: "DUPLICATE_READONLY_TOOL_CALL",
            message:
              "This read-only tool call already completed with identical arguments during this agent run, and no mutating tool has executed since. Use the prior tool result and finish the task without repeating the call.",
            toolName: toolCall.name,
          });
          duplicateReadonlyResults.set(toolCall, result);
          return false;
        });

        // Keep the duplicate visible as a completed tool card while ensuring
        // it never reaches the MCP bridge.
        if (duplicateReadonlyResults.size > 0) {
          ctx.updateSessionMessages(effectiveKey, (currentMessages) =>
            currentMessages.map((currentMessage) =>
              currentMessage.id === currentAssistantMessageId
                ? {
                    ...currentMessage,
                    toolCalls: [...duplicateReadonlyResults.entries()].reduce(
                      (currentToolCalls, [toolCall, result]) =>
                        updateFirstMatchingToolCall(
                          currentToolCalls,
                          toolCall,
                          ["pending", "running"],
                          (currentToolCall) => ({
                            ...currentToolCall,
                            status: "completed" as const,
                            result,
                          }),
                        ),
                      currentMessage.toolCalls,
                    ),
                  }
                : currentMessage,
            ),
          );
        }

        const authorizationDecisions = await requestToolAuthorizations(
          executableToolCalls,
          effectiveKey,
          sessionDirId,
        );

        // 非 YOLO 模式授权判定：
        // - 全部工具被拒绝且用户未填写任何拒绝理由（直接拒绝/中断/
        //   hook abort）：AI 流程直接结束，不再向模型追加工具结果。
        // - 任一拒绝携带了用户填写的理由：拒绝理由作为工具结果回传
        //   AI，Loop 继续，让 AI 根据理由调整后续行动。
        // - 部分拒绝：已拒绝的工具返回拒绝结果给 AI，已批准的工具
        //   正常执行，Loop 继续。
        const allToolsRejected =
          executableToolCalls.length > 0 &&
          authorizationDecisions.every(
            (decision) => decision.status === "rejected",
          );
        const hasUserProvidedRejectionReason = authorizationDecisions.some(
          (decision) =>
            decision.status === "rejected" &&
            decision.userProvidedReason === true,
        );

        const toolExecutor = createToolExecutor({
          ctx,
          effectiveKey,
          currentAssistantMessageId,
          checkpointIds: checkpointId ? [checkpointId] : [],
          sessionDirId,
          directoryPath: ctx.directoryPath,
          responseId: response.id,
          isRunCancelled,
          awaitHookDecision,
          executeSubAgentActivation,
          executeSubAgentMainTool,
          planApprovedSessionKeysRef,
          planModeRef: ctx.planModeRef,
        });
        const toolExecResult = await toolExecutor(
          executableToolCalls,
          authorizationDecisions,
        );
        if (!toolExecResult) {
          return;
        }
        const {
          structuredToolResults: executedToolResults,
          hookAborted,
          hookAbortMessage,
          userQuestionCancelled,
          pendingHookWarnings,
        } = toolExecResult;

        const structuredToolResults: {
          name: string;
          callId: string;
          result: string;
        }[] = [];
        let executedResultIndex = 0;
        for (const toolCall of toolCalls) {
          const duplicateResult = duplicateReadonlyResults.get(toolCall);
          if (duplicateResult !== undefined) {
            structuredToolResults.push({
              name: toolCall.name,
              callId: toolCall.callId || "",
              result: duplicateResult,
            });
            continue;
          }

          const executedResult = executedToolResults[executedResultIndex++];
          if (executedResult) {
            structuredToolResults.push(executedResult);
          }
        }

        // Only successful read results are cacheable. Any approved non-read
        // tool is conservatively treated as a potential state change, which
        // permits the model to read the same path again after that boundary.
        for (let index = 0; index < executableToolCalls.length; index++) {
          const toolCall = executableToolCalls[index];
          const decision = authorizationDecisions[index];
          const result = executedToolResults[index]?.result;
          if (decision?.status !== "approved") {
            continue;
          }
          if (mayMutateWorkspace(toolCall)) {
            completedReadonlyCalls.clear();
            continue;
          }
          const key = readonlyCallKey(toolCall);
          if (key && result && !isFailedToolResult(result)) {
            completedReadonlyCalls.add(key);
          }
        }

        // Hook abort (exit code 2+): fully interrupt the AI loop and surface
        // the hook's error message. No tool results are sent to the model.
        if (hookAborted) {
          const abortContent = `[Hook Abort] ${hookAbortMessage}`;
          ctx.updateSessionMessages(effectiveKey, (currentMessages) =>
            currentMessages.map((currentMessage) =>
              currentMessage.id === currentAssistantMessageId
                ? {
                    ...currentMessage,
                    content: abortContent,
                    timestamp: formatMessageTime(),
                    status: "error",
                    isRetrying: false,
                  }
                : currentMessage,
            ),
          );
          ctx.pendingQueueRef.current.delete(effectiveKey);
          ctx.setActivePendingMessages([]);
          if (response.conversationId) {
            await window.snow.appendToolMessage(
              response.conversationId,
              abortContent,
            );
          }
          return;
        }

        // Add tool results as a tool message for the next iteration
        const toolResultMessageId = createMessageId("tool");
        let toolResultContent = formatToolResultsContent(structuredToolResults);
        // Inject collected hook warnings (exit code 1) so the model sees them
        // alongside the tool results.
        if (pendingHookWarnings.length > 0) {
          toolResultContent += `\n\n[Hook Warnings]\n${pendingHookWarnings.join(
            "\n",
          )}`;
        }
        const toolResultMessage: ChatConversationMessage = {
          id: toolResultMessageId,
          role: "tool",
          content: toolResultContent,
          timestamp: formatMessageTime(),
          status: "sent",
          toolName: toolCalls.map((tc) => tc.name).join(", "),
        };

        ctx.updateSessionMessages(effectiveKey, (currentMessages) => [
          ...currentMessages,
          toolResultMessage,
        ]);
        const toolResultsJson = JSON.stringify(structuredToolResults);

        // A duplicate-only batch has no new work to execute. Preserve its
        // structured results and request one tool-free continuation so the
        // provider can summarize the already available evidence. The recovery
        // instruction is request-local and never enters chat history.
        if (
          duplicateReadonlyResults.size > 0 &&
          executableToolCalls.length === 0
        ) {
          if (duplicateRecoveryAttempted) {
            ctx.pendingQueueRef.current.delete(effectiveKey);
            ctx.setActivePendingMessages([]);
            if (response.conversationId) {
              await window.snow.appendToolMessage(
                response.conversationId,
                toolResultContent,
              );
            }
            return;
          }
          duplicateRecoveryAttempted = true;
          const recoveryInstruction =
            "The requested read-only calls have already completed and their results are in the conversation. Do not call tools in this turn. Use the existing results to provide the best final answer.";
          const recoveryAssistantMessageId = createMessageId("assistant");
          ctx.updateSessionMessages(effectiveKey, (currentMessages) => [
            ...currentMessages,
            {
              id: recoveryAssistantMessageId,
              role: "assistant",
              content: "",
              timestamp: formatMessageTime(),
              status: "sending",
              model: capturedOptions.model,
            },
          ]);
          await runAgentLoop(
            recoveryAssistantMessageId,
            [
              { role: "tool", content: toolResultContent, toolResultsJson },
            ],
            response.conversationId,
            checkpointId,
            undefined,
            true,
            recoveryInstruction,
          );
          return;
        }

        if (userQuestionCancelled) {
          ctx.pendingQueueRef.current.delete(effectiveKey);
          ctx.setActivePendingMessages([]);
          if (response.conversationId) {
            await window.snow.appendToolMessage(
              response.conversationId,
              toolResultContent,
            );
          }
          return;
        }

        // 全部工具被拒绝且没有任何用户填写的拒绝理由时，AI 流程直接
        // 结束，不再发起新一轮请求。若用户填写了拒绝理由，则拒绝结果
        // 已在上方写入 toolResults，走正常续跑分支让 AI 继续处理。
        if (allToolsRejected && !hasUserProvidedRejectionReason) {
          ctx.pendingQueueRef.current.delete(effectiveKey);
          ctx.setActivePendingMessages([]);
          if (response.conversationId) {
            await window.snow.appendToolMessage(
              response.conversationId,
              toolResultContent,
            );
          }
          return;
        }

        const pendingQueueForTools =
          ctx.pendingQueueRef.current.get(effectiveKey) ?? [];
        const nextMessages: {
          role: "user" | "assistant" | "system" | "developer" | "tool";
          content: string;
          toolResultsJson?: string;
        }[] = [{ role: "tool", content: toolResultContent, toolResultsJson }];
        let pendingFlushCheckpointId: string | undefined;
        if (pendingQueueForTools.length > 0) {
          // 与无工具刷新分支一致：先为待发消息建立专属 checkpoint，再
          // 消费队列。否则回滚到这条消息永远没有文件变更，且后续消息
          // 的变更会错记到更早的 checkpoint 上。
          const flushDirPath =
            directoryIdToPath(sessionDirId) ?? ctx.directoryPath;
          pendingFlushCheckpointId = await createFlushCheckpoint(
            effectiveKey,
            flushDirPath,
          );
          if (isRunCancelled(effectiveKey)) {
            return;
          }
          if (pendingQueueForTools.length === 0) {
            // 创建期间用户撤回了全部待发消息：不刷新，丢弃 checkpoint。
            if (pendingFlushCheckpointId) {
              deleteCheckpoints([pendingFlushCheckpointId]);
            }
            return;
          }
          ctx.pendingQueueRef.current.delete(effectiveKey);
          const pendingText = pendingQueueForTools
            .map((item) => item.text)
            .join("\n\n");
          ctx.setActivePendingMessages([]);
          const pendingUserMsgForTools: ChatConversationMessage = {
            id: createMessageId("user"),
            role: "user",
            content: pendingText,
            timestamp: formatMessageTime(),
            status: "sent",
            checkpointId: pendingFlushCheckpointId,
          };
          ctx.updateSessionMessages(effectiveKey, (currentMessages) => [
            ...currentMessages,
            pendingUserMsgForTools,
          ]);
          nextMessages.push({ role: "user", content: pendingText });
        }

        const newAssistantMessageId = createMessageId("assistant");
        const newPendingAssistant: ChatConversationMessage = {
          id: newAssistantMessageId,
          role: "assistant",
          content: "",
          timestamp: formatMessageTime(),
          status: "sending",
          model: capturedOptions.model,
        };
        ctx.updateSessionMessages(effectiveKey, (currentMessages) => [
          ...currentMessages,
          newPendingAssistant,
        ]);

        await runAgentLoop(
          newAssistantMessageId,
          nextMessages,
          response.conversationId,
          pendingFlushCheckpointId ?? checkpointId,
        );
      };

      // Create a file-system checkpoint before the AI loop starts so that
      // rollback can restore the working directory to this pre-AI state.
      // The checkpoint is awaited before runAgentLoop to guarantee the AI
      // cannot modify files before the snapshot is captured.
      const initCheckpointAndRun = async (): Promise<void> => {
        // Pre-send auto-compaction: if the existing context already exceeds
        // the configured threshold, compact first so the new user message is
        // sent against a fresh, summarized context. This applies both to
        // direct user sends and to pending-message flushes (which re-enter
        // handleSendMessage via handleSendMessageRef).
        if (!isPendingSessionKey(sessionKey)) {
          // Use the conversation-scoped profile (capturedOptions.apiProfile) so the
          // auto-compaction decision matches the API config the conversation
          // actually runs on — never the global active profile.
          const apiConfig = await ctx.getActiveApiConfig(
            capturedOptions.apiProfile,
          );
          if (apiConfig?.enableAutoCompress) {
            // autoCompressThreshold is stored in TOKENS — compare directly (see
            // the in-loop check for why calculateAutoCompressThresholdTokens is
            // intentionally not used here).
            const thresholdTokens = apiConfig.autoCompressThreshold;
            if (thresholdTokens != null && thresholdTokens > 0) {
              const currentTokenUsage =
                ctx.sessionsRef.current?.[sessionKey]?.tokenUsage ?? null;
              if (currentTokenUsage) {
                const totalTokens =
                  currentTokenUsage.inputTokens +
                  currentTokenUsage.outputTokens;
                if (totalTokens >= thresholdTokens) {
                  await ctx.performCompactionRef.current(
                    sessionKey,
                    capturedOptions.model,
                    true,
                    undefined,
                    capturedOptions.apiProfile,
                    undefined,
                    undefined,
                    capturedOptions.thinkingStrength,
                    capturedOptions.responsesFastMode,
                  );

                  // performCompaction resets sessionRef.isSending to false in
                  // its finally block, but we are still mid-send — restore it
                  // so the outer handleSendMessage flow keeps the session
                  // locked until it finishes.
                  const sessionRefAfterCompaction =
                    ctx.sessionsRefData.current.get(sessionKey);
                  if (sessionRefAfterCompaction) {
                    sessionRefAfterCompaction.isSending = true;
                    sessionRefAfterCompaction.isAbortRequested = false;
                  }

                  // If the user aborted during compaction, stop here
                  // regardless of whether compaction succeeded.
                  if (isRunCancelled(sessionKey)) {
                    return;
                  }
                }
              }
            }
          }
        }

        let checkpointId: string | undefined;
        // checkpoint 绑定会话自己的目录(而非运行时全局目录),保证
        // manifest.work_dir 与工具执行的 cwd 始终一致。
        const sessionDirPath =
          directoryIdToPath(sessionDirId) ?? ctx.directoryPath;
        // createCheckpoint 是异步的：await 期间本 run 可能已被取消或被
        // 更新的 run 取代（停止按钮、PendingMessages 强制发送会先
        // handleAbort 再立即启动新 run）。两个 run 的 checkpoint 若按
        // 完成顺序 push 进 checkpointIds，顺序会与消息顺序错位，导致
        // 回滚时按 checkpointId 定位的删除/恢复范围错误。因此创建完成
        // 后必须校验 runId：已被取代的 checkpoint 直接删除、不绑定。
        // 被取代的 run 从未开始执行工具（checkpoint 是工具执行的前置
        // 步骤），其文件状态已由后一个 run 的 checkpoint 覆盖捕获，
        // 删除是安全的。
        checkpointId = await createFlushCheckpoint(sessionKey, sessionDirPath);
        if (isRunCancelled(sessionKey)) {
          return;
        }
        if (checkpointId) {
          ctx.updateSessionMessages(sessionKey, (currentMessages) =>
            currentMessages.map((m) =>
              m.id === userMessage.id ? { ...m, checkpointId } : m,
            ),
          );
        }

        // Execute onUserMessage hooks before sending the message to the AI.
        // Unified exit-code semantics:
        //   0 = pass (stdout injected as [Hook Context])
        //   1 = warn (warning text injected as [Hook Warning])
        //   2+ = abort (AI loop interrupted, error shown to user)
        try {
          const hookContext = JSON.stringify({
            message: trimmed,
            cwd: sessionDirPath ?? "",
            sessionId: isPendingSessionKey(sessionKey) ? undefined : sessionKey,
          });
          const hookResult = await window.snow.executeHooks({
            hookType: "onUserMessage",
            projectId: sessionDirId ?? undefined,
            contextJson: hookContext,
          });
          const outcome = resolveHookOutcome(hookResult);

          // Store non-decision outcomes immediately.
          // appended by awaitHookDecision together with their runtime resolver.
          const hookExecRecord = buildHookExecRecord(
            "onUserMessage",
            hookResult,
            outcome,
          );
          if (outcome.kind !== "needsDecision") {
            ctx.updateSessionMessages(finalSessionKey, (currentMessages) =>
              appendHookExecutionToMessage(
                currentMessages,
                hookExecRecord,
                userMessage.id,
              ),
            );
          }

          if (outcome.kind === "abort") {
            ctx.updateSessionMessages(finalSessionKey, (currentMessages) =>
              currentMessages.map((currentMessage) =>
                currentMessage.id === assistantMessageId
                  ? {
                      ...currentMessage,
                      content: outcome.message,
                      timestamp: formatMessageTime(),
                      status: "error",
                      isRetrying: false,
                    }
                  : currentMessage,
              ),
            );
            return;
          }

          if (outcome.kind === "needsDecision") {
            const userDecision = await awaitHookDecision(
              finalSessionKey,
              userMessage.id,
              hookExecRecord,
            );
            if (isRunCancelled(finalSessionKey)) {
              return;
            }

            if (!userDecision) {
              ctx.updateSessionMessages(finalSessionKey, (currentMessages) =>
                currentMessages.map((currentMessage) =>
                  currentMessage.id === assistantMessageId
                    ? {
                        ...currentMessage,
                        content: outcome.message,
                        timestamp: formatMessageTime(),
                        status: "error",
                        isRetrying: false,
                      }
                    : currentMessage,
                ),
              );
              return;
            }

            await runAgentLoop(
              assistantMessageId,
              [{ role: "user", content: trimmed }],
              isPendingSessionKey(sessionKey) ? undefined : sessionKey,
              checkpointId,
            );
            return;
          }

          let effectiveMessage = trimmed;
          if (outcome.kind === "warn") {
            effectiveMessage = `${trimmed}\n\n[Hook Warning]\n${outcome.message}`;
          } else if (outcome.kind === "pass" && outcome.context) {
            effectiveMessage = `${trimmed}\n\n[Hook Context]\n${outcome.context}`;
          }

          await runAgentLoop(
            assistantMessageId,
            [{ role: "user", content: effectiveMessage }],
            isPendingSessionKey(sessionKey) ? undefined : sessionKey,
            checkpointId,
          );
        } catch (hookError) {
          // If hook execution fails, fall back to sending the original message
          await runAgentLoop(
            assistantMessageId,
            [{ role: "user", content: trimmed }],
            isPendingSessionKey(sessionKey) ? undefined : sessionKey,
            checkpointId,
          );
        }
      };

      let runFailed = false;
      void initCheckpointAndRun()
        .catch((error: unknown) => {
          runFailed = true;
          ctx.updateSessionField(finalSessionKey, "isStreaming", false);
          ctx.updateSessionField(finalSessionKey, "streamStartedAt", 0);
          const ref = ctx.sessionsRefData.current.get(finalSessionKey);
          if (ref) {
            ref.streamId = null;
          }
          ctx.updateSessionMessages(finalSessionKey, (currentMessages) =>
            currentMessages.map((currentMessage) =>
              currentMessage.status === "sending"
                ? {
                    ...currentMessage,
                    content: getErrorMessage(error),
                    timestamp: formatMessageTime(),
                    status: "error",
                    isRetrying: false,
                  }
                : currentMessage,
            ),
          );
        })
        .finally(() => {
          const ref = ctx.sessionsRefData.current.get(finalSessionKey);

          // AI 流程完全结束：把本次 run 的耗时与累计 token 累加进会话
          // 统计（内存 + DB 双向，展示的是整个会话的累计值）。耗时用
          // 本地 runStartedAt 计算，不受 catch 分支提前清零的影响。
          const runDurationMs = Math.max(0, Date.now() - runStartedAt);
          const runUsage =
            ctx.sessionsRefData.current.get(finalSessionKey)?.runTokenUsage;
          accumulateConversationRunStats(
            ctx,
            finalSessionKey,
            runUsage,
            runDurationMs,
          );
          // 持久化（Rust 端累加）：重启后打开会话仍可完整回显。
          // 读取 ref 镜像的累计值（setState 异步可能滞后一拍）。
          // PENDING 会话尚未迁移出真实 id，跳过持久化。
          if (!isPendingSessionKey(finalSessionKey)) {
            void window.snow
              .setConversationRunStats(
                finalSessionKey,
                runUsage?.inputTokens ?? 0,
                runUsage?.outputTokens ?? 0,
                runUsage?.cacheCreationInputTokens ?? 0,
                runUsage?.cacheReadInputTokens ?? 0,
                runDurationMs,
              )
              .catch(() => {
                // 持久化失败不阻塞收尾
              });
          }

          // Execute onStop hooks (fire-and-forget). This is the single
          // convergence point for ALL stop scenarios: natural completion,
          // user abort, error, and superseded by a newer run. The hook
          // runs regardless of why the AI loop stopped.
          const stopDirId = ref?.directoryId ?? sessionDirId ?? ctx.directoryId;
          const onStopMessageId = ctx.sessionsRef.current[
            finalSessionKey
          ]?.messages.findLast((message) => message.role !== "tool")?.id;
          const onStopContext = JSON.stringify({
            conversationId: isPendingSessionKey(finalSessionKey)
              ? undefined
              : finalSessionKey,
            cwd: directoryIdToPath(stopDirId) ?? ctx.directoryPath ?? "",
            reason: isRunCancelled(finalSessionKey) ? "aborted" : "completed",
          });
          void runHook("onStop", stopDirId ?? undefined, onStopContext)
            .then((hookResult) => {
              if (hookResult) {
                ctx.updateSessionMessages(finalSessionKey, (currentMessages) =>
                  appendHookExecutionToMessage(
                    currentMessages,
                    toNonBlockingRecord(hookResult.record),
                    onStopMessageId,
                  ),
                );
              }
            })
            .catch(() => {
              // onStop hook failures must not block cleanup
            });

          // Only the run that still owns the session may reset its runtime
          // state. If a newer send or abort has incremented runId (e.g. a
          // pending message forced via "send now" starts a fresh agent loop
          // right after handleAbort), the newer run owns isSending,
          // isStreaming and the streaming id — cleaning them up here would
          // strip the running state from the UI (the stop button disappears)
          // even though the agent loop is still active.
          //
          // 宠物联动放在 ownsSession 守卫之外：本次 run 的回合必须与开始时
          // 生成的 turnId 一一核销。被中止/顶替的 run 同样要回收自己的回合，
          // 否则主进程计数泄漏，宠物会永久卡在 busy（多会话并行时尤其明显）。
          window.snow.notifyPetTurnEnded(
            petTurnId,
            runFailed || isRunCancelled(finalSessionKey),
          );

          const ownsSession = !!ref && ref.runId === currentRunId;
          if (ownsSession) {
            ref.isSending = false;
            ctx.updateSessionField(finalSessionKey, "isStreaming", false);
            ctx.updateSessionField(finalSessionKey, "streamStartedAt", 0);
            ctx.updateSessionField(finalSessionKey, "isAborting", false);
            ctx.updateSessionField(finalSessionKey, "isPaused", false);
            // Clear the pause controller so a stale resolve callback from a
            // previous run cannot accidentally unblock a future iteration.
            ctx.pauseControllerRef.current.delete(finalSessionKey);
            ctx.removeStreamingId(finalSessionKey);
          }

          // AI 流程完全结束后，增量同步侧边栏列表中该会话的最新记录
          // （更新时间/消息数/预览等）。只 upsert 单条，不触发列表全量重拉
          // —— 每次响应迭代的 conversationVersion bump 仅用于消息区。
          // 与下方"已完成"徽标保持一致：不依赖 ownsSession 守卫——即使本次
          // run 已被更新的 run 顶替（守卫内的运行态清理被跳过），侧边栏
          // 记录也必须刷新，否则长跑会话会带着过期的 updatedAt 留在列表
          // 里，把同一个时间分组切成多个重复组头（两个"昨天"）。
          if (!isPendingSessionKey(finalSessionKey)) {
            void window.snow
              .getChatConversation(finalSessionKey)
              .then((conv) => {
                if (conv) {
                  ctx.setUpsertedConversation({
                    record: conv,
                    timestamp: Date.now(),
                  });
                }
              })
              .catch(() => {
                // Upsert failure should not block cleanup
              });
          }

          // Flush pending messages queued while this session was busy.
          const pendingQueue =
            ctx.pendingQueueRef.current.get(finalSessionKey) ?? [];
          if (!isRunCancelled(finalSessionKey) && pendingQueue.length > 0) {
            ctx.pendingQueueRef.current.delete(finalSessionKey);
            const combined = pendingQueue.map((item) => item.text).join("\n\n");
            const lastOptions =
              pendingQueue[pendingQueue.length - 1]?.options ?? {};
            ctx.setActivePendingMessages([]);
            // 显式指定目标会话：即使期间用户已切到其他会话/新建会话视图，
            // 排队消息也必须发回队列所属的会话，且不重置用户的新建意图。
            ctx.handleSendMessageRef.current(combined, {
              ...lastOptions,
              targetSessionKey: finalSessionKey,
            });
          }

          // If this is a background conversation (not the active one),
          // mark it as completed so the sidebar shows a dot indicator.
          if (
            !isPendingSessionKey(finalSessionKey) &&
            finalSessionKey !== ctx.activeConversationIdRef.current
          ) {
            ctx.updateSessionField(finalSessionKey, "hasNewContent", true);
            ctx.setCompletedConversationIds((prev: Set<string>) => {
              if (prev.has(finalSessionKey)) return prev;
              const next = new Set(prev);
              next.add(finalSessionKey);
              return next;
            });
          }

          // 通知系统：AI 流程正常结束时触发系统通知。
          // 窗口是否聚焦的判断由主进程 notificationManager 负责 —
          // 如果用户正在看应用，主进程会自动跳过通知，不会打扰。
          if (
            !isPendingSessionKey(finalSessionKey) &&
            !isRunCancelled(finalSessionKey)
          ) {
            const sessionState = ctx.sessionsRef.current?.[finalSessionKey];
            ctx.notifyAiComplete({
              conversationId: finalSessionKey,
              directoryId: sessionState?.directoryId ?? ctx.directoryId,
              title: sessionState?.summary || undefined,
            });
          }
        });
    },
    [
      ctx.directoryId,
      ctx.directoryPath,
      ctx.ensureSession,
      ctx.updateSessionMessages,
      ctx.updateSessionField,
      ctx.migrateSession,
      ctx.addStreamingId,
      ctx.removeStreamingId,
      ctx.setActiveId,
      ctx.setNewChatRequested,
      ctx.rollbackNewChatState,
      ctx.setRollbackNewChatState,
      ctx.notifyAiComplete,
      requestToolAuthorizations,
    ],
  );

  // Keep the ref current so the pending-flush closure always calls the latest version.
  ctx.handleSendMessageRef.current = handleSendMessage;

  return { handleSendMessage };
};
