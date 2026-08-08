import { useCallback } from "react";
import type { ChatInputSendOptions } from "../../chatInput/types";
import type {
  ChatConversationMessage,
  ConversationContextValue,
  ToolAuthorizationDecision,
  ToolCallInfo,
} from "../utils/conversationTypes";
import { PENDING_SESSION_KEY } from "../utils/conversationTypes";
import {
  createMessageId,
  directoryIdToPath,
  formatMessageTime,
  formatToolResultsContent,
  getErrorMessage,
  isResponseErrorStatus,
  parseToolCalls,
} from "../utils/conversationHelpers";
import {
  appendHookExecutionToMessage,
  buildHookExecRecord,
  resolveHookOutcome,
  runHook,
  toNonBlockingRecord,
} from "./hookOutcome";
import {
  beginStreamMetricsIteration,
  createAwaitHookDecision,
  createIsRunCancelled,
  createStreamChunkHandler,
  createStreamIdHandler,
  resetRunStreamMetrics,
} from "./agentLoopHelpers";
import { createSubAgentActivation } from "./subAgentActivation";
import { createToolExecutor } from "./toolExecution";

export type UseAgentLoopParams = {
  ctx: ConversationContextValue;
  requestToolAuthorizations: (
    toolCalls: ToolCallInfo[],
    conversationId: string,
    projectId?: string
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

      const sessionKey =
        ctx.activeConversationIdRef.current ?? PENDING_SESSION_KEY;
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
        queue.push({ text: trimmed, options });
        ctx.pendingQueueRef.current.set(sessionKey, queue);
        ctx.setActivePendingMessages(queue.map((item) => item.text));
        return;
      }

      const isFirstMessage = ctx.activeConversationIdRef.current === undefined;
      const sessionDirId = existingRef?.directoryId ?? ctx.directoryId;

      // Reset only this session's approval for the new user task. Other
      // conversations may still be executing their independently approved plan.
      planApprovedSessionKeysRef.current.delete(sessionKey);

      // Sending a new message cancels any prior "new chat" intent — the
      // user is now interacting with this session, so the UI should follow
      // it normally (including auto-switching when the pending session
      // migrates to a real conversation id).
      ctx.setNewChatRequested(false);

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
        model: options.model,
      };

      ctx.updateSessionField(sessionKey, "isStreaming", true);
      // Reset per-run and per-iteration probes before the first model request.
      resetRunStreamMetrics(ctx, sessionKey);
      // Anchor the wall-clock start of the accumulating elapsed timer once
      // per agent loop. StreamMetrics derives its elapsed display from this
      // timestamp instead of the backend's per-iteration streamElapsedMs
      // (which resets on every createResponseStream call), so the timer
      // keeps ticking across iterations and survives conversation switches.
      ctx.updateSessionField(sessionKey, "streamStartedAt", Date.now());
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
            conversationId: PENDING_SESSION_KEY,
            title: trimmed,
            summary: "",
            lastMessagePreview: preview,
            messageCount: 1,
            model: options.model ?? "",
            apiProfileName: options.apiProfile ?? "",
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
      const awaitHookDecision = createAwaitHookDecision(ctx);

      const executeSubAgentActivation = createSubAgentActivation({
        ctx,
        requestToolAuthorizations,
        parentApiProfile: options.apiProfile,
        parentModel: options.model,
        planApprovedSessionKeysRef,
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
        resumeAfterCompaction?: boolean
      ): Promise<void> => {
        const iterSessionKey = currentConversationId ?? PENDING_SESSION_KEY;
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

        // Carry the completed iteration into the run totals, then reset the
        // per-request probes before starting the next model stream.
        beginStreamMetricsIteration(ctx, effectiveKey);

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
            model: options.model,
            apiProfile: options.apiProfile,
            conversationId: currentConversationId,
            directoryId: sessionDirId,
            checkpointId,
            resumeAfterCompaction,
            planMode: iterRef?.planMode ?? ctx.planModeRef.current,
            goalMode: iterRef?.goalMode ?? ctx.goalModeRef.current,
          },
          createStreamChunkHandler(
            ctx,
            effectiveKey,
            currentAssistantMessageId,
            () => isRunCancelled(effectiveKey)
          ),
          createStreamIdHandler(ctx, effectiveKey, () =>
            isRunCancelled(effectiveKey)
          )
        );
        const streamRefBefore = ctx.sessionsRefData.current.get(effectiveKey);
        if (streamRefBefore) {
          streamRefBefore.streamPromise = streamPromise;
        }

        const response = await streamPromise;
        const responseFailed = isResponseErrorStatus(response.status);

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
            response.persistedUserMessageIds.length
          );
          for (let i = 0; i < remapCount; i++) {
            idRemap.set(pendingUserIds[i], response.persistedUserMessageIds[i]);
          }

          if (idRemap.size > 0) {
            ctx.updateSessionMessages(effectiveKey, (msgs) =>
              msgs.map((m) => {
                const newId = idRemap.get(m.id);
                return newId ? { ...m, id: newId } : m;
              })
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
          if (effectiveKey === PENDING_SESSION_KEY) {
            // Plan Mode approval obtained while the session was still pending
            // must follow the session to its real conversation id. Otherwise
            // the approval stays keyed under PENDING_SESSION_KEY and the next
            // agent-loop iteration (effectiveKey = conversationId) hits the
            // Rust hard gate again — the model sees "Plan Mode write blocked"
            // even though the user already approved the plan.
            if (planApprovedSessionKeysRef.current.has(PENDING_SESSION_KEY)) {
              planApprovedSessionKeysRef.current.delete(PENDING_SESSION_KEY);
              planApprovedSessionKeysRef.current.add(response.conversationId);
            }
            ctx.migrateSession(PENDING_SESSION_KEY, response.conversationId);
            effectiveKey = response.conversationId;
            finalSessionKey = response.conversationId;
            // The pending session's Plan/Goal Mode (set before the session
            // had a real id) now has a persisted conversation id: write it
            // through so the modes survive a restart.
            const migratedRef = ctx.sessionsRefData.current.get(
              response.conversationId
            );
            if (migratedRef) {
              void window.snow.setConversationModes(
                response.conversationId,
                migratedRef.planMode,
                migratedRef.goalMode,
                migratedRef.goalModeTokenBudget
              );
            }
            // Only set active conversation on the first iteration when
            // migrating from pending. Subsequent tool iterations must NOT
            // override the active conversation — the user may have switched
            // to a different conversation while tools are running.
            // Additionally, if the user explicitly clicked "New chat" while
            // this session was streaming, do NOT auto-switch back — let the
            // conversation persist in the background and stay on the empty
            // greeting.
            // When activeConversationIdRef is PENDING_SESSION_KEY the user
            // navigated back to the pending conversation (via sidebar) before
            // migration completed. After migrateSession deletes the pending
            // key, the active id must follow to the real conversation id —
            // otherwise the UI resolves an empty session and falls back to
            // the Empty greeting screen.
            if (
              (ctx.activeConversationIdRef.current === undefined ||
                ctx.activeConversationIdRef.current === PENDING_SESSION_KEY) &&
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
            !responseFailed
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
                    generatedSummary
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
            response.tokenUsage
          );
        }

        // Parse tool calls early: the auto-compaction gate below must know
        // whether the agent loop will actually continue before compacting.
        // (Marking the first call as running happens later in the tool
        // executor; parsing itself is side-effect free.)
        const toolCalls = parseToolCalls(response.toolCallsJson);
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
          effectiveKey !== PENDING_SESSION_KEY
        ) {
          // Use the conversation-scoped profile (options.apiProfile) so the
          // auto-compaction decision matches the API config the conversation
          // actually runs on — never the global active profile.
          const apiConfig = await ctx.getActiveApiConfig(options.apiProfile);
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
                          model: response.model || options.model,
                          isRetrying: false,
                        }
                      : currentMessage
                  )
                );

                const compactionSummary =
                  await ctx.performCompactionRef.current(
                    effectiveKey,
                    options.model,
                    true,
                    undefined,
                    options.apiProfile
                  );

                if (compactionSummary) {
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
                  // message.
                  const postCompactionAssistantId =
                    createMessageId("assistant");
                  const postCompactionAssistant: ChatConversationMessage = {
                    id: postCompactionAssistantId,
                    role: "assistant",
                    content: "",
                    timestamp: formatMessageTime(),
                    status: "sending",
                    model: options.model,
                  };
                  ctx.updateSessionMessages(effectiveKey, (currentMessages) => [
                    ...currentMessages,
                    postCompactionAssistant,
                  ]);
                  await runAgentLoop(
                    postCompactionAssistantId,
                    [{ role: "user", content: compactionSummary }],
                    response.conversationId,
                    undefined,
                    true
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
        // locally as an error. "incomplete" responses are partial but usable.
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
              model: response.model || options.model,
              toolCalls:
                visibleToolCalls.length > 0 ? visibleToolCalls : undefined,
              isRetrying: false,
            };
          })
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
            };
            const nextAssistantId = createMessageId("assistant");
            const nextPendingAssistant: ChatConversationMessage = {
              id: nextAssistantId,
              role: "assistant",
              content: "",
              timestamp: formatMessageTime(),
              status: "sending",
              model: options.model,
            };
            ctx.updateSessionMessages(effectiveKey, (currentMessages) => [
              ...currentMessages,
              pendingUserMsg,
              nextPendingAssistant,
            ]);
            await runAgentLoop(
              nextAssistantId,
              [{ role: "user", content: pendingText }],
              response.conversationId
            );
          }
          return;
        }

        // A tool-call response must always be processed into tool results and
        // followed by another model request. The loop naturally finishes only
        // when a later response contains no tool calls, or when the user cancels.
        const authorizationDecisions = await requestToolAuthorizations(
          toolCalls,
          effectiveKey,
          sessionDirId
        );

        // 非 YOLO 模式授权判定：
        // - 全部工具被拒绝且用户未填写任何拒绝理由（直接拒绝/中断/
        //   hook abort）：AI 流程直接结束，不再向模型追加工具结果。
        // - 任一拒绝携带了用户填写的理由：拒绝理由作为工具结果回传
        //   AI，Loop 继续，让 AI 根据理由调整后续行动。
        // - 部分拒绝：已拒绝的工具返回拒绝结果给 AI，已批准的工具
        //   正常执行，Loop 继续。
        const allToolsRejected = authorizationDecisions.every(
          (decision) => decision.status === "rejected"
        );
        const hasUserProvidedRejectionReason = authorizationDecisions.some(
          (decision) =>
            decision.status === "rejected" &&
            decision.userProvidedReason === true
        );

        const toolExecutor = createToolExecutor({
          ctx,
          effectiveKey,
          currentAssistantMessageId,
          sessionDirId,
          directoryPath: ctx.directoryPath,
          responseId: response.id,
          isRunCancelled,
          awaitHookDecision,
          executeSubAgentActivation,
          planApprovedSessionKeysRef,
          planModeRef: ctx.planModeRef,
        });
        const toolExecResult = await toolExecutor(
          toolCalls,
          authorizationDecisions
        );
        if (!toolExecResult) {
          return;
        }
        const {
          structuredToolResults,
          hookAborted,
          hookAbortMessage,
          userQuestionCancelled,
          pendingHookWarnings,
        } = toolExecResult;

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
                : currentMessage
            )
          );
          ctx.pendingQueueRef.current.delete(effectiveKey);
          ctx.setActivePendingMessages([]);
          if (response.conversationId) {
            await window.snow.appendToolMessage(
              response.conversationId,
              abortContent
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
            "\n"
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

        if (userQuestionCancelled) {
          ctx.pendingQueueRef.current.delete(effectiveKey);
          ctx.setActivePendingMessages([]);
          if (response.conversationId) {
            await window.snow.appendToolMessage(
              response.conversationId,
              toolResultContent
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
              toolResultContent
            );
          }
          return;
        }

        const pendingQueueForTools =
          ctx.pendingQueueRef.current.get(effectiveKey) ?? [];
        const toolResultsJson = JSON.stringify(structuredToolResults);
        const nextMessages: {
          role: "user" | "assistant" | "system" | "developer" | "tool";
          content: string;
          toolResultsJson?: string;
        }[] = [{ role: "tool", content: toolResultContent, toolResultsJson }];
        if (pendingQueueForTools.length > 0) {
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
          model: options.model,
        };
        ctx.updateSessionMessages(effectiveKey, (currentMessages) => [
          ...currentMessages,
          newPendingAssistant,
        ]);

        await runAgentLoop(
          newAssistantMessageId,
          nextMessages,
          response.conversationId
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
        if (sessionKey !== PENDING_SESSION_KEY) {
          // Use the conversation-scoped profile (options.apiProfile) so the
          // auto-compaction decision matches the API config the conversation
          // actually runs on — never the global active profile.
          const apiConfig = await ctx.getActiveApiConfig(options.apiProfile);
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
                    options.model,
                    true,
                    undefined,
                    options.apiProfile
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
        const sessionDirPath = directoryIdToPath(sessionDirId) ?? ctx.directoryPath;
        if (sessionDirPath && !sessionDirPath.startsWith("ssh://")) {
          try {
            checkpointId = await window.snow.createCheckpoint(
              sessionDirPath
            );
            const ref = ctx.sessionsRefData.current.get(sessionKey);
            if (ref) {
              ref.checkpointIds = [...ref.checkpointIds, checkpointId];
            }
            if (!ctx.sessionsRef.current[sessionKey]?.baselineCheckpointId) {
              ctx.updateSessionField(
                sessionKey,
                "baselineCheckpointId",
                checkpointId
              );
            }
            ctx.updateSessionMessages(sessionKey, (currentMessages) =>
              currentMessages.map((m) =>
                m.id === userMessage.id ? { ...m, checkpointId } : m
              )
            );
          } catch {
            // Best effort — continue without a checkpoint
          }
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
            sessionId:
              sessionKey === PENDING_SESSION_KEY ? undefined : sessionKey,
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
            outcome
          );
          if (outcome.kind !== "needsDecision") {
            ctx.updateSessionMessages(finalSessionKey, (currentMessages) =>
              appendHookExecutionToMessage(
                currentMessages,
                hookExecRecord,
                userMessage.id
              )
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
                  : currentMessage
              )
            );
            return;
          }

          if (outcome.kind === "needsDecision") {
            const userDecision = await awaitHookDecision(
              finalSessionKey,
              userMessage.id,
              hookExecRecord
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
                    : currentMessage
                )
              );
              return;
            }

            await runAgentLoop(
              assistantMessageId,
              [{ role: "user", content: trimmed }],
              sessionKey === PENDING_SESSION_KEY ? undefined : sessionKey,
              checkpointId
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
            sessionKey === PENDING_SESSION_KEY ? undefined : sessionKey,
            checkpointId
          );
        } catch (hookError) {
          // If hook execution fails, fall back to sending the original message
          await runAgentLoop(
            assistantMessageId,
            [{ role: "user", content: trimmed }],
            sessionKey === PENDING_SESSION_KEY ? undefined : sessionKey,
            checkpointId
          );
        }
      };

      void initCheckpointAndRun()
        .catch((error: unknown) => {
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
                : currentMessage
            )
          );
        })
        .finally(() => {
          const ref = ctx.sessionsRefData.current.get(finalSessionKey);

          // Execute onStop hooks (fire-and-forget). This is the single
          // convergence point for ALL stop scenarios: natural completion,
          // user abort, error, and superseded by a newer run. The hook
          // runs regardless of why the AI loop stopped.
          const stopDirId = ref?.directoryId ?? sessionDirId ?? ctx.directoryId;
          const onStopMessageId = ctx.sessionsRef.current[
            finalSessionKey
          ]?.messages.findLast((message) => message.role !== "tool")?.id;
          const onStopContext = JSON.stringify({
            conversationId:
              finalSessionKey === PENDING_SESSION_KEY
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
                    onStopMessageId
                  )
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

            // AI 流程完全结束后，增量同步侧边栏列表中该会话的最新记录
            // （更新时间/消息数/预览等）。只 upsert 单条，不触发列表全量重拉
            // —— 每次响应迭代的 conversationVersion bump 仅用于消息区。
            if (finalSessionKey !== PENDING_SESSION_KEY) {
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
            ctx.handleSendMessageRef.current(combined, lastOptions);
          }

          // If this is a background conversation (not the active one),
          // mark it as completed so the sidebar shows a dot indicator.
          if (
            finalSessionKey !== PENDING_SESSION_KEY &&
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
            finalSessionKey !== PENDING_SESSION_KEY &&
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
      ctx.notifyAiComplete,
      requestToolAuthorizations,
    ]
  );

  // Keep the ref current so the pending-flush closure always calls the latest version.
  ctx.handleSendMessageRef.current = handleSendMessage;

  return { handleSendMessage };
};
