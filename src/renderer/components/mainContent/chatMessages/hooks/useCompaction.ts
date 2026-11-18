import { useCallback } from "react";
import { tGlobal } from "../../../../i18n";
import type {
  BackgroundCompactionOptions,
  ConversationContextValue,
  ChatConversationMessage,
  CompactionResult,
} from "../utils/conversationTypes";
import { toMessageRecordRefs } from "../utils/conversationTypes";
import {
  createMessageId,
  deleteCheckpoints,
  directoryIdToPath,
  formatMessageTime,
  resolveConversationWorkspacePath,
  tokenUsageFromMessageRecords,
} from "../utils/conversationHelpers";
import { appendHookExecutionToMessage, runHook } from "./hookOutcome";
import { isBackgroundCompactionRunning } from "../utils/autoCompaction";
import {
  demotePendingSteering,
  takeNextQueuedMessage,
} from "../utils/pendingInputs";

/**
 * 后台压缩的卡片插入点：跳过末尾仍在进行中的消息（发送中的助手占位、本轮
 * 待发送的用户消息），它们落库后排在压缩边界之后。null 表示插在最前。
 */
const findBackgroundAnchorId = (
  messages: ChatConversationMessage[],
  requestMessages: BackgroundCompactionOptions["requestMessages"],
): string | null => {
  const pendingUserContents = new Set(
    requestMessages
      .filter((message) => message.role === "user")
      .map((message) => message.content),
  );
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const inFlight =
      (message.role === "assistant" && message.status === "sending") ||
      (message.role === "user" && pendingUserContents.has(message.content));
    if (!inFlight) return message.id;
  }
  return null;
};

/**
 * 上下文压缩逻辑：手动 /compact 和自动阈值触发的压缩。
 * 压缩流独立于正式消息：contextCompaction=true 时 Rust 使用全量有效上下文
 * 生成交接文档，成功后仅持久化一条 status=context_compaction 的用户消息。
 * 开启分层增量压缩（contextFold）时，Rust 只把较早的消息区间折叠成摘要，
 * 最近的消息原样留在上下文里，同样只持久化一条折叠摘要行。
 */
export const useCompaction = (ctx: ConversationContextValue) => {
  const performCompaction = useCallback(
    async (
      conversationId: string,
      model?: string,
      isAuto = false,
      subAgentConfigProfile?: string,
      apiProfile?: string,
      subAgentToolsJson?: string,
      subAgentSystemPrompt?: string,
      thinkingStrength?: string,
      responsesFastMode?: string | null,
      background?: BackgroundCompactionOptions,
    ): Promise<CompactionResult | null> => {
      const sessionRef = ctx.sessionsRefData.current.get(conversationId);
      const compactionRunId = sessionRef?.runId;
      const wasSending = sessionRef?.isSending ?? false;
      // 后台压缩不占用会话流状态（isSending / streamId 属于仍在运行的 AI 循环）。
      const isBackground = Boolean(background);
      let started = false;
      const markStarted = (): void => {
        if (started) return;
        started = true;
        background?.onStarted();
      };
      const backgroundAnchorId = background
        ? findBackgroundAnchorId(
            ctx.sessionsRef.current?.[conversationId]?.messages ?? [],
            background.requestMessages,
          )
        : null;
      let completed = false;
      let failed = false;
      if (sessionRef && !isBackground) {
        sessionRef.isSending = true;
        if (!isAuto) sessionRef.isAbortRequested = false;
      }
      if (isBackground) {
        ctx.setBackgroundCompactingIds((ids) =>
          ids.includes(conversationId) ? ids : [...ids, conversationId],
        );
      } else {
        ctx.setCompactionPreview("");
        ctx.setCompactionError(null);
        ctx.setIsCompacting(true);
        ctx.setCompactingConversationId(conversationId);
      }
      void window.snow.writeLog("INFO", {
        module: "compaction",
        func: "performCompaction",
        message: isAuto
          ? isBackground
            ? "background auto-compaction started"
            : "auto-compaction started"
          : "manual compaction started",
        context: JSON.stringify({ conversationId, model: model ?? null }),
      });

      // Create a file-system checkpoint before compaction so rolling back to
      // the compaction boundary can restore files modified by the subsequent
      // agent loop. A compaction boundary is semantically a user message — its
      // checkpoint captures the working-directory state at the moment the
      // handoff was generated. SSH directories are supported too (the backend
      // captures through the remote SFTP channel); creation failure falls back
      // to a checkpoint-less compaction.
      let checkpointId: string | undefined;
      // checkpoint 根目录跟随持久 WorkTree 绑定；绑定缺失/失效时 fail-closed。
      const directoryId = sessionRef?.directoryId ?? ctx.directoryId;
      const projectSessionDirPath =
        directoryIdToPath(directoryId) ?? ctx.directoryPath;
      const sessionDirPath = await resolveConversationWorkspacePath(
        conversationId,
        directoryId,
        projectSessionDirPath,
        sessionRef?.worktreeMode ?? false,
      );
      if (sessionDirPath) {
        try {
          checkpointId = await window.snow.createCheckpoint(sessionDirPath);
          if (sessionRef) {
            // 仅用于临时清理，不代表消息顺序。
            sessionRef.checkpointIds = [
              ...sessionRef.checkpointIds,
              checkpointId,
            ];
          }
        } catch {
          // Best effort — continue without a checkpoint. The rollback flow
          // will still truncate the conversation, just without file restore.
        }
      }

      const compactionStartedAt = Date.now();
      // 压缩方式在发起时确定一次，请求与结果处理共用同一份判断。
      const contextFold = await window.snow.getContextFold().catch(() => false);
      // 任务原文与已消费插话：自动交接式压缩后要原样跟在 handoff 之后。
      // 折叠压缩保留了近期消息原文（任务原文在其中或已逐字写进摘要），
      // 再补发会变成一条重复的新请求。
      const collectProtectedMessages =
        (): CompactionResult["protectedMessages"] =>
          isAuto && !contextFold
            ? sessionRef?.activeTaskMessages?.length
              ? sessionRef.activeTaskMessages.map((message) => ({ ...message }))
              : (ctx.sessionsRef.current?.[conversationId]?.messages ?? [])
                  .filter(
                    (message) =>
                      message.role === "user" && !message.isContextCompaction,
                  )
                  .slice(-1)
                  .map((message) => ({
                    role: "user" as const,
                    origin: message.origin,
                    content: message.content,
                  }))
            : undefined;
      // 后台压缩：任务原文随压缩一起落在边界之后（本轮待发送的同文消息除外，
      // 它们会随本轮请求落库）；本轮工具结果交给摘要，避免边界后成为孤儿。
      const backgroundTailMessages = background
        ? (collectProtectedMessages() ?? []).filter(
            (protectedMessage) =>
              !background.requestMessages.some(
                (message) =>
                  message.role === "user" &&
                  message.origin === protectedMessage.origin &&
                  message.content === protectedMessage.content,
              ),
          )
        : [];
      const backgroundExtraMessages =
        background &&
        !contextFold &&
        background.requestMessages.some((message) => message.role === "tool")
          ? background.requestMessages
          : [];
      const compactionRequest = {
        messages: [
          {
            role: "user" as const,
            origin: "internal" as const,
            content: "context handoff",
          },
          ...backgroundExtraMessages,
        ],
        ...(backgroundTailMessages.length > 0
          ? { compactionTailMessages: backgroundTailMessages }
          : {}),
        model,
        conversationId,
        directoryId: sessionRef?.directoryId ?? ctx.directoryId,
        contextCompaction: true,
        contextFold,
        checkpointId,
        // Per-conversation Goal Mode snapshot: the handoff prompt depends on
        // THIS conversation's mode, not the live global ref.
        goalMode:
          ctx.sessionsRefData.current.get(conversationId)?.goalMode ??
          ctx.goalModeRef.current,
        worktreeMode: sessionRef?.worktreeMode ?? false,
        // Conversation-scoped profile isolation: the handoff must resolve the
        // same API config the conversation's messages use. For sub-agent
        // conversations, carry the configured profile so Rust resolves the
        // same API config the sub-agent uses for the handoff.
        apiProfile,
        thinkingStrength,
        responsesFastMode,
        subAgentToolsJson,
        subAgentSystemPrompt,
        subAgentConfigProfile,
      };

      try {
        // Execute beforeCompress hooks. If blocked, abort compaction
        // immediately — the user sees the hook's error message.
        try {
          const compressDirId = sessionRef?.directoryId ?? ctx.directoryId;
          const beforeCompressContext = JSON.stringify({
            conversationId,
            isAuto,
            cwd: directoryIdToPath(compressDirId) ?? ctx.directoryPath ?? "",
          });
          const compressHookResult = await runHook(
            "beforeCompress",
            compressDirId ?? undefined,
            beforeCompressContext,
          );
          if (compressHookResult) {
            ctx.updateSessionMessages(conversationId, (currentMessages) =>
              appendHookExecutionToMessage(
                currentMessages,
                compressHookResult.record,
              ),
            );
            if (compressHookResult.outcome.kind === "abort") {
              throw new Error(compressHookResult.outcome.message);
            }
          }
        } catch (hookError) {
          if (hookError instanceof Error && hookError.message) {
            throw hookError;
          }
          // Hook execution failed (not an abort) — continue with compaction
        }

        // 会话已中断：不再发起后台压缩。
        if (background?.isCancelled()) {
          throw new Error("Context compaction cancelled");
        }
        const compactionStreamPromise = window.snow.createResponseStream(
          compactionRequest,
          (chunk) => {
            // 后台压缩不展示流式预览，主流仍在输出。
            if (isBackground) return;
            if (chunk.retrying) {
              // Reset accumulated preview so the UI reflects the fresh request
              // the backend is about to re-issue after the stream idle timeout.
              ctx.setCompactionPreview("");
              return;
            }
            ctx.setCompactionPreview(
              (current) => chunk.content || `${current}${chunk.contentDelta}`,
            );
          },
          (streamId) => {
            if (background) {
              background.onStreamId(streamId);
            } else if (sessionRef) {
              sessionRef.streamId = streamId;
            }
          },
        );
        markStarted();
        // createResponseStream invokes the stream-id callback SYNCHRONOUSLY
        // (before it returns the promise), so the promise must be attached to
        // the session here rather than inside that callback — referencing
        // compactionStreamPromise from within its own initializer throws a
        // temporal-dead-zone "Cannot access before initialization" error, which
        // silently failed every auto-compaction. This mirrors the main agent
        // loop, which also assigns streamPromise only after the call returns.
        if (sessionRef && !isBackground) {
          sessionRef.streamPromise = compactionStreamPromise;
        }

        const response = await compactionStreamPromise;

        if (sessionRef && !isBackground) {
          sessionRef.streamId = null;
          sessionRef.streamPromise = null;
        }

        if (response.status !== "completed") {
          throw new Error(`Context compaction ${response.status}`);
        }
        const content = response.content.trim();
        if (!content) {
          throw new Error("Context handoff is empty");
        }
        // 压缩期间发生回滚（锚点行已删）时 Rust 不落边界：静默作废。
        if (isBackground && !response.persistedUserMessageIds?.length) {
          void window.snow.writeLog("INFO", {
            module: "compaction",
            func: "performCompaction",
            message: "background compaction discarded",
            context: JSON.stringify({ conversationId }),
          });
          if (checkpointId) {
            if (sessionRef) {
              sessionRef.checkpointIds = sessionRef.checkpointIds.filter(
                (id) => id !== checkpointId,
              );
            }
            deleteCheckpoints([checkpointId]);
          }
          return null;
        }

        // response.tokenUsage is the compaction call usage: its inputTokens
        // describe the old full context, while outputTokens describe the handoff.
        // Keep that response untouched for backend usage history, and store a
        // separate post-compaction context snapshot for the next request/UI.
        // 折叠压缩的快照（保留的近期消息 + 新摘要）由 Rust 落在折叠行上，下面读回。
        // 后台压缩的快照由闸门在下一请求边界写入（进行中的请求会覆盖它）。
        if (response.tokenUsage && !contextFold && !isBackground) {
          ctx.updateSessionField(conversationId, "tokenUsage", {
            inputTokens: response.tokenUsage.outputTokens,
            outputTokens: 0,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
          });
        }

        // 用库行 id：用户消息导航按库 id 定位 DOM，响应 id 对不上。
        const compactionMessage: ChatConversationMessage = {
          id:
            response.persistedUserMessageIds?.[0] ||
            response.id ||
            createMessageId("user"),
          role: "user",
          origin: "internal",
          content,
          timestamp: formatMessageTime(),
          status: "sent",
          responseId: response.id || undefined,
          model: response.model || model,
          isContextCompaction: true,
          checkpointId,
        };
        ctx.updateSessionMessages(conversationId, (currentMessages) => {
          if (!isBackground) return [...currentMessages, compactionMessage];
          // 后台压缩：卡片放在压缩节点处，期间产生的消息保持在其后。
          const anchorIndex =
            backgroundAnchorId === null
              ? -1
              : currentMessages.findIndex(
                  (message) => message.id === backgroundAnchorId,
                );
          if (backgroundAnchorId !== null && anchorIndex < 0) {
            return [...currentMessages, compactionMessage];
          }
          return [
            ...currentMessages.slice(0, anchorIndex + 1),
            compactionMessage,
            ...currentMessages.slice(anchorIndex + 1),
          ];
        });
        const latestRecords =
          await window.snow.listChatMessages(conversationId);
        ctx.updateSessionField(
          conversationId,
          "messageRecords",
          toMessageRecordRefs(latestRecords),
        );
        if (contextFold && !isBackground) {
          const foldedUsage = tokenUsageFromMessageRecords(latestRecords);
          if (foldedUsage) {
            ctx.updateSessionField(conversationId, "tokenUsage", foldedUsage);
          }
        }

        void window.snow.writeLog("INFO", {
          module: "compaction",
          func: "performCompaction",
          message: "compaction succeeded",
          context: JSON.stringify({
            conversationId,
            isAuto,
            isBackground,
            contextFold,
            contentLength: content.length,
            inputTokens: response.tokenUsage?.inputTokens ?? null,
            outputTokens: response.tokenUsage?.outputTokens ?? null,
          }),
        });
        // Preserve the original task AND its consumed steers across compaction.
        // Keeping only the latest user input would turn a correction into a task.
        // 后台压缩的任务原文已随边界落库，不再由续跑请求注入。
        const protectedMessages = isBackground
          ? undefined
          : collectProtectedMessages();
        completed = true;
        return {
          content,
          checkpointId,
          protectedMessages,
          contextTokens:
            isBackground && !contextFold
              ? response.tokenUsage?.outputTokens
              : undefined,
        };
      } catch (error) {
        // 会话中断导致的后台压缩取消：静默作废，只清理快照。
        if (background?.isCancelled()) {
          void window.snow.writeLog("INFO", {
            module: "compaction",
            func: "performCompaction",
            message: "background compaction cancelled by abort",
            context: JSON.stringify({ conversationId }),
          });
          if (checkpointId) {
            if (sessionRef) {
              sessionRef.checkpointIds = sessionRef.checkpointIds.filter(
                (id) => id !== checkpointId,
              );
            }
            deleteCheckpoints([checkpointId]);
          }
          return null;
        }
        // 自动与手动压缩的失败都要落日志 + 给出可见提示（见下方），否则失败
        // 只表现为一闪而过的压缩流，用户无从判断压缩到底有没有执行。
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        const errorStack = error instanceof Error ? error.stack : undefined;
        void window.snow.writeLog("ERROR", {
          module: "compaction",
          func: "performCompaction",
          message: isAuto
            ? "auto-compaction failed"
            : "manual compaction failed",
          context: JSON.stringify({
            conversationId,
            isAuto,
            durationMs: Date.now() - compactionStartedAt,
            request: compactionRequest,
            directoryPath: ctx.directoryPath ?? null,
            checkpointId: checkpointId ?? null,
            errorStack: errorStack ?? null,
          }),
          error: errorMessage,
        });
        // 失败提示对自动与手动压缩都要给出：否则用户无法区分「没触发压缩」
        // 与「触发后失败」。文案在这里拼好（自带前缀），UI 与手机远控直接展示。
        failed = true;
        ctx.setCompactionError(
          isAuto
            ? tGlobal("chat.autoCompactionFailed", {
                values: { error: errorMessage },
              })
            : `${tGlobal("chat.compactionFailed")}: ${errorMessage}`,
        );
        // Compaction failed — discard the checkpoint we created at the start of
        // this attempt so it does not linger as an orphan snapshot. Rollback
        // only needs checkpoints for successfully persisted boundaries.
        if (checkpointId) {
          if (sessionRef) {
            sessionRef.checkpointIds = sessionRef.checkpointIds.filter(
              (id) => id !== checkpointId,
            );
          }
          deleteCheckpoints([checkpointId]);
        }
        return null;
      } finally {
        markStarted();
        if (isBackground) {
          ctx.setBackgroundCompactingIds((ids) =>
            ids.filter((id) => id !== conversationId),
          );
          // 失败提示挂到该会话上（后台压缩不占用 compactingConversationId）。
          if (failed) ctx.setCompactingConversationId(conversationId);
        } else {
          const ownsSession = sessionRef?.runId === compactionRunId;
          if (sessionRef && ownsSession && !sessionRef.isAbortRequested) {
            // Auto-compaction belongs to the active task; never briefly unlock it.
            sessionRef.isSending = isAuto && wasSending;
            sessionRef.streamId = null;
          }
          ctx.setIsCompacting(false);
          ctx.setCompactionPreview("");
          // Only clear the marker if it still points at this conversation, so a
          // newer compaction started in another session is not prematurely hidden.
          // 失败时保留该会话 id：失败提示要留在这个会话里继续可见（isCompacting
          // 已复位，界面不会误认为仍在压缩）。
          ctx.setCompactingConversationId((current) =>
            current === conversationId && !failed ? null : current,
          );

          // Manual compaction has no live task accepting steers. Preserve all
          // messages and start only one FIFO follow-up after successful completion.
          if (!isAuto && ownsSession) {
            demotePendingSteering(ctx, conversationId);
            if (completed && !sessionRef?.isAbortRequested) {
              const next = takeNextQueuedMessage(ctx, conversationId);
              if (next) {
                ctx.handleSendMessageRef.current(next.text, {
                  ...next.options,
                  deliveryMode: "queue",
                  targetSessionKey: conversationId,
                });
              }
            }
          }
        }
      }
    },
    [
      ctx.directoryId,
      ctx.directoryPath,
      ctx.updateSessionField,
      ctx.updateSessionMessages,
      ctx.setCompactionPreview,
      ctx.setCompactionError,
      ctx.setIsCompacting,
      ctx.setCompactingConversationId,
      ctx.setBackgroundCompactingIds,
      ctx.sessionsRefData,
      ctx.pendingQueueRef,
      ctx.setActivePendingMessages,
      ctx.handleSendMessageRef,
    ],
  );

  // Keep the ref current so runAgentLoop (defined inside handleSendMessage)
  // can call the latest performCompaction without stale closures.
  ctx.performCompactionRef.current = performCompaction;

  const compactConversation = useCallback(
    async (
      model?: string,
      apiProfile?: string,
      sessionKey?: string,
    ): Promise<void> => {
      const conversationId = sessionKey ?? ctx.activeConversationIdRef.current;
      if (
        !conversationId ||
        ctx.sessionsRefData.current.get(conversationId)?.isSending ||
        isBackgroundCompactionRunning(conversationId)
      ) {
        return;
      }

      await performCompaction(
        conversationId,
        model,
        false,
        undefined,
        apiProfile,
      );
    },
    [performCompaction, ctx.activeConversationIdRef, ctx.sessionsRefData],
  );

  return {
    performCompaction,
    compactConversation,
  };
};
