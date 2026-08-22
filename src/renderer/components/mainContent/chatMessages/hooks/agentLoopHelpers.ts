import type { ResponsesApiStreamChunk, TokenUsage } from "../../../../../preload/types/api";
import type {
  ConversationContextValue,
  ChatConversationMessage,
  HookExecutionRecord,
  VisionAnalysisState,
} from "../utils/conversationTypes";
import { formatMessageTime } from "../utils/conversationHelpers";
import { appendHookExecutionToMessage } from "./hookOutcome";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PLAN_APPROVAL_TOOL_NAME = "app-control-requestApproval";
export const PARENT_PLAN_APPROVAL_REQUIRED = "PARENT_PLAN_APPROVAL_REQUIRED";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export const isStructuredPlanApproval = (
  toolName: string,
  result: string
): boolean => {
  if (toolName !== PLAN_APPROVAL_TOOL_NAME) {
    return false;
  }

  try {
    const parsed = JSON.parse(result) as Record<string, unknown>;
    return parsed.approved === true;
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// Factory: isRunCancelled
// ---------------------------------------------------------------------------

/**
 * Returns a predicate that detects whether the current run has been
 * superseded -- either by an explicit abort (isAbortRequested), by a newer
 * send/abort that incremented runId, or because the session ref was deleted.
 */
export const createIsRunCancelled = (
  ctx: ConversationContextValue,
  currentRunId: number
) => {
  return (key: string): boolean => {
    const r = ctx.sessionsRefData.current.get(key);
    return !r || r.isAbortRequested || r.runId !== currentRunId;
  };
};

// ---------------------------------------------------------------------------
// Factory: awaitHookDecision
// ---------------------------------------------------------------------------

/**
 * Creates a function that pauses the agent loop until the user resolves a
 * hook decision gate (approve / reject). The decision record is written into
 * the target assistant message and the runtime resolver is registered in
 * ctx.pendingHookDecisionRef so handleAbort can settle it externally.
 */
export const createAwaitHookDecision = (ctx: ConversationContextValue) => {
  return async (
    key: string,
    messageId: string,
    record: HookExecutionRecord
  ): Promise<boolean> => {
    const decisionId = `${messageId}-${
      record.hookType
    }-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const approved = await new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (decision: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        ctx.pendingHookDecisionRef.current.delete(decisionId);
        resolve(decision);
      };

      ctx.pendingHookDecisionRef.current.set(decisionId, {
        sessionKey: key,
        resolve: settle,
      });
      ctx.updateSessionMessages(key, (currentMessages) =>
        appendHookExecutionToMessage(
          currentMessages,
          {
            ...record,
            _decisionId: decisionId,
            _resolveDecision: settle,
          },
          messageId
        )
      );
    });

    ctx.updateSessionMessages(key, (currentMessages) =>
      currentMessages.map((currentMessage) =>
        currentMessage.id === messageId
          ? {
              ...currentMessage,
              hookExecutions: (currentMessage.hookExecutions ?? []).map(
                (execution) =>
                  execution._decisionId === decisionId
                    ? {
                        ...execution,
                        pendingDecision: false,
                        status: approved ? "pass" : "abort",
                        _resolveDecision: undefined,
                      }
                    : execution
              ),
            }
          : currentMessage
      )
    );
    return approved;
  };
};

// ---------------------------------------------------------------------------
// Streaming run metrics
// ---------------------------------------------------------------------------

/** Reset all cumulative metrics when a new user-triggered run starts.
 *  `conversationTokenUsage` / `lastRunDurationMs` are intentionally NOT
 *  reset: they accumulate across every run of the conversation. */
export const resetRunStreamMetrics = (
  ctx: ConversationContextValue,
  sessionKey: string
): void => {
  ctx.updateSessionField(sessionKey, "streamTokenCount", 0);
  ctx.updateSessionField(sessionKey, "streamElapsedMs", 0);
  ctx.updateSessionField(sessionKey, "streamTtftMs", 0);
  ctx.updateSessionField(sessionKey, "runTtftMs", 0);
  ctx.updateSessionField(sessionKey, "runTokenUsage", null);
  const refSession = ctx.sessionsRefData.current.get(sessionKey);
  if (refSession) {
    refSession.iterationTokenCount = 0;
    refSession.iterationElapsedMs = 0;
    refSession.runTokenUsage = null;
  }
};

/** Accumulate a single-request usage into the run-level totals. Each
 *  response.tokenUsage covers one request only, so the run summary needs
 *  the sum across every iteration of the agent loop. */
export const accumulateRunTokenUsage = (
  ctx: ConversationContextValue,
  sessionKey: string,
  usage: TokenUsage | null | undefined
): void => {
  if (!usage) {
    return;
  }
  const current = ctx.sessionsRef.current?.[sessionKey]?.runTokenUsage;
  const next: TokenUsage = {
    inputTokens: (current?.inputTokens ?? 0) + (usage.inputTokens ?? 0),
    outputTokens: (current?.outputTokens ?? 0) + (usage.outputTokens ?? 0),
    cacheCreationInputTokens:
      (current?.cacheCreationInputTokens ?? 0) +
      (usage.cacheCreationInputTokens ?? 0),
    cacheReadInputTokens:
      (current?.cacheReadInputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0),
  };
  ctx.updateSessionField(sessionKey, "runTokenUsage", next);
  // 同步写 ref 镜像：state 的 setState 异步，收尾（finally）同步读取时
  // 可能滞后一个渲染周期，ref 版本保证持久化拿到完整累计值。
  const refSession = ctx.sessionsRefData.current.get(sessionKey);
  if (refSession) {
    refSession.runTokenUsage = next;
  }
};

/** Fold a finished run's usage + wall-clock duration into the conversation's
 *  cumulative totals (in-memory mirror of the persisted run_* columns).
 *  Called once when the agent loop ends; `runUsage` must be the run-level
 *  ref mirror so it is complete even when the state update lags. */
export const accumulateConversationRunStats = (
  ctx: ConversationContextValue,
  sessionKey: string,
  runUsage: TokenUsage | null | undefined,
  runDurationMs: number
): void => {
  const current = ctx.sessionsRef.current?.[sessionKey]?.conversationTokenUsage;
  ctx.updateSessionField(sessionKey, "conversationTokenUsage", {
    inputTokens:
      (current?.inputTokens ?? 0) + (runUsage?.inputTokens ?? 0),
    outputTokens:
      (current?.outputTokens ?? 0) + (runUsage?.outputTokens ?? 0),
    cacheCreationInputTokens:
      (current?.cacheCreationInputTokens ?? 0) +
      (runUsage?.cacheCreationInputTokens ?? 0),
    cacheReadInputTokens:
      (current?.cacheReadInputTokens ?? 0) +
      (runUsage?.cacheReadInputTokens ?? 0),
  });
  const currentDuration =
    ctx.sessionsRef.current?.[sessionKey]?.lastRunDurationMs ?? 0;
  ctx.updateSessionField(
    sessionKey,
    "lastRunDurationMs",
    currentDuration + Math.max(0, runDurationMs)
  );
};

// ---------------------------------------------------------------------------
// Streaming message transition
// ---------------------------------------------------------------------------

/**
 * Applies one backend stream chunk to the current assistant message. A retry
 * chunk is an attempt boundary: discard the failed partial and normalize the
 * message back to ordinary streaming without retaining transport diagnostics.
 */
export const applyStreamChunkToMessage = (
  currentMessage: ChatConversationMessage,
  chunk: ResponsesApiStreamChunk,
  timestamp: string = formatMessageTime()
): ChatConversationMessage => {
  const {
    isRetrying: _isRetrying,
    retryAttempt: _retryAttempt,
    retryError: _retryError,
    ...ordinaryStreamingMessage
  } = currentMessage;

  if (chunk.retrying) {
    return {
      ...ordinaryStreamingMessage,
      content: "",
      thinking: undefined,
      status: "sending",
    };
  }

  const existingContent = ordinaryStreamingMessage.content;
  const nextContent =
    chunk.content || `${existingContent}${chunk.contentDelta}`;
  const nextThinking =
    chunk.thinking ||
    `${ordinaryStreamingMessage.thinking ?? ""}${chunk.thinkingDelta}`;

  return {
    ...ordinaryStreamingMessage,
    content: nextContent,
    thinking: nextThinking || undefined,
    timestamp,
    status: "sending",
  };
};

// ---------------------------------------------------------------------------
// Factory: stream chunk handler
// ---------------------------------------------------------------------------

/**
 * Creates the onChunk callback for createResponseStream. Handles real-time
 * token probe updates, retry resets, and incremental content/thinking deltas.
 * Shared between the main agent loop and the sub-agent loop.
 */
export const createStreamChunkHandler = (
  ctx: ConversationContextValue,
  sessionKey: string,
  assistantMessageId: string,
  isCancelled: () => boolean
) => {
  const refSession = ctx.sessionsRefData.current.get(sessionKey);
  const iterationTokenBase = refSession?.iterationTokenCount ?? 0;
  const iterationElapsedBase = refSession?.iterationElapsedMs ?? 0;

  return (chunk: ResponsesApiStreamChunk): void => {
    // External-vision textify progress event: update the session-level
    // visionAnalysis field only, never touch message content. The backend
    // pushes these chunks while it describes user images with the external
    // vision model (before the first content delta arrives).
    //
    // This is processed BEFORE the isCancelled() early return: when the user
    // aborts mid-textify, the backend pushes a final cancel/done/error event
    // to recycle the "vision model analyzing image" status card — skipping it
    // would leave the card stuck forever. Cancelled runs only apply clearing
    // events (cancel/done/error): a stale describing/cached event from the
    // old run must not resurrect the card nor clobber a newer run's state.
    if (chunk.visionStatus) {
      try {
        const parsed = JSON.parse(chunk.visionStatus) as VisionAnalysisState;
        // describing/cached → show the intermediate status card; done with
        // remaining images → keep the card (the next describing event will
        // advance the index); done on the last image / error / cancel → clear.
        const keep =
          parsed.phase === "describing" ||
          parsed.phase === "cached" ||
          (parsed.phase === "done" && parsed.index < parsed.total);
        if (!isCancelled() || !keep) {
          ctx.updateSessionField(
            sessionKey,
            "visionAnalysis",
            keep ? parsed : undefined
          );
        }
      } catch {
        // Ignore unparseable vision status payloads.
      }
      return;
    }

    if (isCancelled()) {
      return;
    }

    const runTokenCount = iterationTokenBase + chunk.streamTokenCount;
    const runElapsedMs = iterationElapsedBase + chunk.elapsedMs;
    ctx.updateSessionField(sessionKey, "streamTokenCount", runTokenCount);
    ctx.updateSessionField(sessionKey, "streamElapsedMs", runElapsedMs);
    if (refSession) {
      refSession.iterationTokenCount = runTokenCount;
      refSession.iterationElapsedMs = runElapsedMs;
    }
    if (
      chunk.ttftMs > 0 &&
      (ctx.sessionsRef.current[sessionKey]?.streamTtftMs ?? 0) === 0
    ) {
      ctx.updateSessionField(sessionKey, "streamTtftMs", chunk.ttftMs);
    }
    if (
      chunk.ttftMs > 0 &&
      (ctx.sessionsRef.current[sessionKey]?.runTtftMs ?? 0) === 0
    ) {
      ctx.updateSessionField(sessionKey, "runTtftMs", chunk.ttftMs);
    }

    ctx.updateSessionMessages(sessionKey, (currentMessages) =>
      currentMessages.map((currentMessage) => {
        if (currentMessage.id !== assistantMessageId) {
          return currentMessage;
        }

        return applyStreamChunkToMessage(currentMessage, chunk);
      })
    );
  };
};

// ---------------------------------------------------------------------------
// Factory: stream id handler
// ---------------------------------------------------------------------------

/**
 * Creates the onStreamId callback for createResponseStream. Stores the stream
 * id on the session ref and immediately aborts if the run was already
 * cancelled before the stream started.
 */
export const createStreamIdHandler = (
  ctx: ConversationContextValue,
  sessionKey: string,
  isCancelled: () => boolean
) => {
  return (streamId: string): void => {
    const ref = ctx.sessionsRefData.current.get(sessionKey);
    if (ref) {
      ref.streamId = streamId;
      if (isCancelled()) {
        void window.snow.abortResponseStream(streamId);
      }
    }
  };
};
