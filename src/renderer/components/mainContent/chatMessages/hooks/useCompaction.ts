import { useCallback } from "react";
import type {
  ConversationContextValue,
  CompactionResult,
} from "../utils/conversationTypes";
import {
  buildConversationMessages,
  deleteCheckpoints,
  directoryIdToPath,
} from "../utils/conversationHelpers";
import { appendHookExecutionToMessage, runHook } from "./hookOutcome";

/**
 * 上下文压缩逻辑：手动 /compact 和自动阈值触发的压缩。
 * 压缩流独立于正式消息：contextCompaction=true 时 Rust 使用全量有效上下文
 * 生成交接文档，成功后仅持久化一条 status=context_compaction 的用户消息。
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
      responsesFastMode?: boolean | null,
    ): Promise<CompactionResult | null> => {
      const sessionRef = ctx.sessionsRefData.current.get(conversationId);
      if (sessionRef) {
        sessionRef.isSending = true;
        sessionRef.isAbortRequested = false;
      }
      ctx.setCompactionPreview("");
      ctx.setCompactionError(null);
      ctx.setIsCompacting(true);
      ctx.setCompactingConversationId(conversationId);
      void window.snow.writeLog("INFO", {
        module: "compaction",
        func: "performCompaction",
        message: isAuto
          ? "auto-compaction started"
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
      // checkpoint 绑定会话自己的目录,与工具执行的 cwd 保持一致。
      const sessionDirPath =
        directoryIdToPath(sessionRef?.directoryId ?? ctx.directoryId) ??
        ctx.directoryPath;
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
      const compactionRequest = {
        messages: [{ role: "user" as const, content: "context handoff" }],
        model,
        conversationId,
        directoryId: sessionRef?.directoryId ?? ctx.directoryId,
        contextCompaction: true,
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

        const compactionStreamPromise = window.snow.createResponseStream(
          compactionRequest,
          (chunk) => {
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
            if (sessionRef) {
              sessionRef.streamId = streamId;
            }
          },
        );
        // createResponseStream invokes the stream-id callback SYNCHRONOUSLY
        // (before it returns the promise), so the promise must be attached to
        // the session here rather than inside that callback — referencing
        // compactionStreamPromise from within its own initializer throws a
        // temporal-dead-zone "Cannot access before initialization" error, which
        // silently failed every auto-compaction. This mirrors the main agent
        // loop, which also assigns streamPromise only after the call returns.
        if (sessionRef) {
          sessionRef.streamPromise = compactionStreamPromise;
        }

        const response = await compactionStreamPromise;

        if (sessionRef) {
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

        // response.tokenUsage is the compaction call usage: its inputTokens
        // describe the old full context, while outputTokens describe the handoff.
        // Keep that response untouched for backend usage history, and store a
        // separate post-compaction context snapshot for the next request/UI.
        if (response.tokenUsage) {
          ctx.updateSessionField(conversationId, "tokenUsage", {
            inputTokens: response.tokenUsage.outputTokens,
            outputTokens: 0,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
          });
        }

        // The boundary message is already persisted by the backend, so reload
        // it instead of pushing a local copy: an optimistic copy can never be
        // deduped against the stored row, because the only id available here is
        // the upstream response id, never the row's own id. That duplicate then
        // survived every reload as a second summary card.
        const latestRecords =
          await window.snow.listChatMessages(conversationId);
        ctx.updateSessionField(conversationId, "messageRecords", latestRecords);
        // Rebuild the rendered list from persisted records, keeping only local
        // messages that no record covers (in-flight placeholders) so an active
        // stream is not dropped.
        const persistedIds = new Set(latestRecords.map((record) => record.id));
        ctx.updateSessionMessages(conversationId, (currentMessages) => [
          ...buildConversationMessages(latestRecords),
          ...currentMessages.filter(
            (message) =>
              !persistedIds.has(message.id) && !message.isContextCompaction,
          ),
        ]);

        void window.snow.writeLog("INFO", {
          module: "compaction",
          func: "performCompaction",
          message: "compaction succeeded",
          context: JSON.stringify({
            conversationId,
            isAuto,
            contentLength: content.length,
            inputTokens: response.tokenUsage?.inputTokens ?? null,
            outputTokens: response.tokenUsage?.outputTokens ?? null,
          }),
        });
        // 保护消息：压缩边界会吞掉边界之前的全部历史（含最新任务指令），
        // handoff 摘要由 AI 自由生成、可能丢失任务原文。提取压缩前最后一
        // 条非压缩用户消息，随恢复请求重新注入，保证 AI 压缩后不忘记任务
        // 与 TODO 状态。仅自动压缩注入（手动压缩后用户自己决定下一条消息）。
        const protectedMessages = isAuto
          ? (ctx.sessionsRef.current?.[conversationId]?.messages ?? [])
              .filter(
                (message) =>
                  message.role === "user" && !message.isContextCompaction,
              )
              .slice(-1)
              .map((message) => ({
                role: "user" as const,
                content: message.content,
              }))
          : undefined;
        return { content, checkpointId, protectedMessages };
      } catch (error) {
        // Log failures for BOTH auto and manual compaction. Auto-compaction
        // errors are otherwise suppressed in the UI (isAuto), which made a
        // failed auto-compaction look like a brief "flash" with no explanation.
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
        if (!isAuto) {
          ctx.setCompactionError(
            error instanceof Error
              ? error.message
              : "Failed to compact context",
          );
        }
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
        if (sessionRef) {
          sessionRef.isSending = false;
          sessionRef.streamId = null;
        }
        ctx.setIsCompacting(false);
        ctx.setCompactionPreview("");
        // Only clear the marker if it still points at this conversation, so a
        // newer compaction started in another session is not prematurely hidden.
        ctx.setCompactingConversationId((current) =>
          current === conversationId ? null : current,
        );

        // For manual compaction, flush pending messages after completion.
        // Auto-compaction runs inside runAgentLoop so the loop itself
        // continues — no pending flush needed.
        if (!isAuto) {
          const pendingQueue =
            ctx.pendingQueueRef.current.get(conversationId) ?? [];
          if (!sessionRef?.isAbortRequested && pendingQueue.length > 0) {
            ctx.pendingQueueRef.current.delete(conversationId);
            const combined = pendingQueue.map((item) => item.text).join("\n\n");
            const lastOptions =
              pendingQueue[pendingQueue.length - 1]?.options ?? {};
            // 显示镜像只反映当前激活会话的队列（会话隔离）。
            if (ctx.activeSessionKeyRef.current === conversationId) {
              ctx.setActivePendingMessages([]);
            }
            // 显式指定目标会话：压缩期间用户可能已切到其他会话/新建会话
            // 视图，排队消息必须发回压缩的会话，且不重置用户的新建意图。
            ctx.handleSendMessageRef.current(combined, {
              ...lastOptions,
              targetSessionKey: conversationId,
            });
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
    async (model?: string, apiProfile?: string): Promise<void> => {
      const conversationId = ctx.activeConversationIdRef.current;
      if (
        !conversationId ||
        ctx.sessionsRefData.current.get(conversationId)?.isSending
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
