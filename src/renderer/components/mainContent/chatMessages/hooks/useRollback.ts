import { useCallback, useRef, useState } from "react";
import { useI18n } from "../../../../i18n";
import {
  markSubAgentRollbackRestoring,
  releasePreparedSubAgentRollback,
  type SubAgentRollbackIdentity,
} from "./subAgentRollbackIdentity";
import type {
  ConversationContextValue,
  CheckpointFileChange,
  RollbackMode,
  RollbackConversationState,
  RollbackMemoryItem,
  RollbackTodoItem,
} from "../utils/conversationTypes";
import {
  PENDING_SESSION_KEY,
  isPendingSessionKey,
} from "../utils/conversationTypes";
import {
  deleteCheckpoints,
  directoryIdToPath,
  getErrorMessage,
  isWorktreeBindingError,
  killRunningToolExecutions,
  resolveConversationWorkspacePath,
  tokenUsageFromMessageRecords,
} from "../utils/conversationHelpers";
import {
  collectWorkflowFlowIdsFromMessages,
  collectWorkflowFlowIdsFromRecords,
  resolveWorkflowFlowImpact,
} from "../utils/rollbackChain";
import { getActiveWorkflowNodeIds } from "../workflow/workflowRunner";
import { parseWorkflowComposerContent } from "../../chatInput/workflowComposer/workflowComposerPayload";
import { abortConversationRun } from "./conversationMessageBridge";
import {
  prepareSubAgentDeletion,
  prepareSubAgentRollback,
  revokeSubAgentParentOwnership,
} from "./subAgentParentInbox";

/**
 * 回滚逻辑：中止流、预览文件变更、确认/取消回滚。
 * context_compaction 回滚必须调用 truncateConversation，以其自身 responseId
 * 为起点删除边界及后续消息；不得调用 deleteConversation。
 */
export const useRollback = (ctx: ConversationContextValue) => {
  const { t } = useI18n();
  const rollbackIdentityRef = useRef<SubAgentRollbackIdentity | null>(null);
  const rollbackConfirmingRef = useRef(false);
  const rollbackCancelRequestedRef = useRef(false);
  const clearDraftToRestore = useCallback((): void => {
    ctx.setDraftToRestore(null);
  }, [ctx.setDraftToRestore]);
  const clearRollbackWorkflowComposer = useCallback((): void => {
    ctx.setRollbackWorkflowComposer(null);
  }, [ctx.setRollbackWorkflowComposer]);

  /** 正在计算变更（弹窗弹出前）的消息 id：SSH 下 listCheckpointChanges
   *  经 SFTP 遍历可能较慢，入口按钮在此期间显示 loading。 */
  const [preparingMessageId, setPreparingMessageId] = useState<string | null>(
    null,
  );
  /** 每次打开/取消回滚都会推进序号，异步变更/TODO 查询只能提交自己的结果。 */
  const rollbackRequestIdRef = useRef(0);

  /** 目标会话是否就是主视图当前激活会话（只有它是时才同步主视图显示态）。 */
  const isActiveSessionKey = useCallback(
    (key: string): boolean =>
      key === (ctx.activeSessionKeyRef.current ?? PENDING_SESSION_KEY),
    [ctx.activeSessionKeyRef],
  );

  const handleRollback = useCallback(
    (messageId: string, targetSessionKey?: string): void => {
      // Never replace the only releasable identity or hide a partial restoration.
      if (rollbackConfirmingRef.current || rollbackIdentityRef.current) return;
      // 显式目标会话优先（会话面板指定会话回滚）；省略时沿用主视图当前
      // 激活会话，保持原有行为。
      const key =
        targetSessionKey ??
        ctx.activeSessionKeyRef.current ??
        PENDING_SESSION_KEY;
      const requestId = ++rollbackRequestIdRef.current;

      // Revoke wake admission synchronously; rollback must never revive the
      // original delegation while the preview or owner preparation awaits I/O.
      revokeSubAgentParentOwnership(key);
      if (!isPendingSessionKey(key)) abortConversationRun(key);

      // Abort any in-flight stream before rolling back.
      const ref = ctx.sessionsRefData.current.get(key);
      if (ref?.streamId) {
        void window.snow.abortResponseStream(ref.streamId);
        ref.streamId = null;
      }
      if (ref) {
        ref.isSending = false;
        ref.runId += 1;
      }
      // Rollback and checkpoint diff paths must match the original checkpoint root.
      // The immutable WorkTree binding is resolved inside computeAndPreview below.
      const projectSessionWorkDir =
        directoryIdToPath(ref?.directoryId) ?? ctx.directoryPath;
      let sessionWorkDir = projectSessionWorkDir;
      ctx.updateSessionField(key, "isStreaming", false);
      ctx.updateSessionField(key, "streamStartedAt", 0);
      ctx.updateSessionField(key, "isAborting", false);
      // Clear the vision textify status card: the abort above may interrupt
      // the backend while it describes user images, and a stuck intermediate
      // card must not survive the rollback.
      ctx.updateSessionField(key, "visionAnalysis", undefined);
      ctx.removeStreamingId(key);

      // Cancel any in-flight summary generation so the
      // update_conversation_summary write transaction is skipped before the
      // rollback's delete/truncate runs. Without this, the summary promise may
      // still hold a database write lock and cause "database is locked".
      if (!isPendingSessionKey(key)) {
        void window.snow.cancelConversationSummary(key);
      }

      const session = ctx.sessionsRef.current[key];
      if (!session) {
        return;
      }

      // Kill every in-flight bash subprocess before truncating the
      // conversation, so no orphaned OS process keeps running afterwards.
      killRunningToolExecutions(session.messages);

      const messages = session.messages;
      const targetIndex = messages.findIndex((m) => m.id === messageId);
      if (targetIndex === -1) {
        return;
      }
      // 变更计算（SSH 下经 SFTP）期间入口按钮显示 loading，弹窗弹出或
      // 失败后清除。
      setPreparingMessageId(messageId);

      const targetMessage = messages[targetIndex];
      const messageContent = targetMessage.content;
      // 回滚链 = 目标消息及之后所有用户消息的检查点；Rust 侧负责按路径
      // 合并整条链，这里只按消息顺序收集，无需自行排序。
      const initialCheckpointIds = messages
        .slice(targetIndex)
        .filter((message) => message.role === "user" && message.checkpointId)
        .map((message) => message.checkpointId as string);
      const convId = isPendingSessionKey(key) ? undefined : key;
      const capturedInputState = ctx.runtimeInputStateRef.current[key]
        ? { ...ctx.runtimeInputStateRef.current[key] }
        : undefined;
      const capturedSessionRef = ctx.sessionsRefData.current.get(key);
      const defaults = ctx.globalModeDefaultsRef.current;
      let capturedWorktreeMode =
        capturedSessionRef?.worktreeMode ?? defaults.worktreeMode;
      let capturedGoalMode = capturedSessionRef?.goalMode ?? defaults.goalMode;
      const capturedWorkflowMode =
        capturedSessionRef?.workflowMode ?? defaults.workflowMode;
      const capturedGoalModeTokenBudget =
        capturedSessionRef?.goalModeTokenBudget ?? defaults.goalModeTokenBudget;
      if (capturedWorkflowMode) {
        capturedWorktreeMode = false;
        capturedGoalMode = false;
      } else if (capturedWorktreeMode) {
        capturedGoalMode = false;
      }

      // Delete the entire conversation only when this is the true first user
      // message in the complete history. A compaction boundary and the first item
      // in a paginated window must always use range truncation instead.
      const hasUserMessageBefore = messages
        .slice(0, targetIndex)
        .some((m) => m.role === "user");
      const isFirstMessage =
        !targetMessage.isContextCompaction &&
        !session.hasMoreMessages &&
        !hasUserMessageBefore;

      // Normal user messages roll back from their following assistant response.
      // A compaction boundary is persisted as a user message with its own response id,
      // so rolling back that boundary must target the boundary row itself.
      //
      // 失败/中断轮次的 assistant 消息没有 provider responseId（持久化时
      // response_id 为空），无法用 responseId 定位截断边界。因此优先使用
      // 用户消息自身的持久化 DB ID（snowflake 数字 id，消息持久化后前端
      // id 会被替换为数据库 id）作为边界：truncateConversationFromMessage
      // 从该行开始删除该轮及之后的所有消息。找不到持久化 id（消息尚未
      // 落库）时才回退到向后寻找非空 responseId 的旧逻辑。
      let responseId = targetMessage.isContextCompaction
        ? targetMessage.responseId
        : undefined;
      let persistedMessageId: string | undefined;
      if (!targetMessage.isContextCompaction && targetMessage.id) {
        // snowflake id 是 64 位大整数（可能超过 Number.MAX_SAFE_INTEGER），
        // 这里只区分"数字 id"与前端临时 id（"user-{ts}-{rand}"），不参与
        // 数值运算，用 isInteger 即可。
        if (Number.isInteger(Number(targetMessage.id))) {
          persistedMessageId = targetMessage.id;
        }
      }
      if (!responseId && !persistedMessageId) {
        // 目标未落库：取其后第一个已持久化边界（用户消息 DB id 或助手 responseId）；
        // 均无则整段尾部只存在于内存，按本地回滚处理。
        for (let i = targetIndex + 1; i < messages.length; i++) {
          const candidate = messages[i];
          if (
            candidate.role === "user" &&
            !candidate.isContextCompaction &&
            Number.isInteger(Number(candidate.id))
          ) {
            persistedMessageId = candidate.id;
            break;
          }
          if (
            (candidate.role === "assistant" || candidate.isContextCompaction) &&
            candidate.responseId
          ) {
            responseId = candidate.responseId;
            break;
          }
        }
      }

      // Compute file changes for the confirmation dialog. This is async but
      // we set the preview state once the diff is ready.
      const computeAndPreview = async (): Promise<void> => {
        try {
          // 绑定失效时暂存错误：无任何检查点（无文件可恢复）仍允许仅回滚会话
          let workspaceError: unknown;
          try {
            sessionWorkDir =
              (await resolveConversationWorkspacePath(
                convId ?? "",
                capturedSessionRef?.directoryId ?? ctx.directoryId,
                projectSessionWorkDir,
                capturedWorktreeMode,
              )) ?? "";
          } catch (error) {
            workspaceError = error;
            sessionWorkDir = "";
          }
          if (workspaceError && initialCheckpointIds.length > 0) {
            throw workspaceError;
          }
          // WorkFlow 级联终止：中止运行中的节点（流/工具授权/子进程）并结算
          // 挂起的 workflow-generate，随后等待节点 runLoop 退出。回滚的数据
          // 删除与文件恢复绝不能与仍在写入工作区/数据库的节点并发执行。
          if (convId) {
            ctx.abortWorkflowNodes?.(convId);
            const exitDeadline = Date.now() + 10_000;
            while (
              getActiveWorkflowNodeIds(convId).length > 0 &&
              Date.now() < exitDeadline
            ) {
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
          }
          // Best effort 读取：失败按 null 处理，回滚流程继续。
          const loadOrNull = async <T>(
            loader: () => Promise<T>,
          ): Promise<T | null> => {
            try {
              return await loader();
            } catch {
              return null;
            }
          };
          // 会话记录、运行时配置与整条历史互不依赖：并行读取，避免长会话上
          // 串行 IPC 往返叠加。
          const [conversationRecord, runtimeConfig, fullHistory] =
            await Promise.all([
              convId
                ? loadOrNull(() => window.snow.getChatConversation(convId))
                : Promise.resolve(null),
              convId
                ? loadOrNull(() =>
                    window.snow.getConversationRuntimeConfig(convId),
                  )
                : Promise.resolve(null),
              convId
                ? loadOrNull(() => window.snow.listChatMessages(convId))
                : Promise.resolve(null),
            ]);
          const rollbackConversationState: RollbackConversationState = {
            model:
              capturedInputState?.model ||
              conversationRecord?.model?.trim() ||
              "",
            apiProfile:
              capturedInputState?.apiProfile ||
              conversationRecord?.apiProfileName?.trim() ||
              "",
            thinkingStrength: capturedInputState
              ? capturedInputState.thinkingStrength
              : (runtimeConfig?.thinkingStrength ?? null),
            responsesFastMode: capturedInputState
              ? capturedInputState.responsesFastMode
              : (runtimeConfig?.responsesFastMode ?? null),
            goalMode: capturedGoalMode,
            worktreeMode: capturedWorktreeMode,
            workflowMode: capturedWorkflowMode,
            goalModeTokenBudget: capturedGoalModeTokenBudget,
          };
          let checkpointIds = initialCheckpointIds;
          // 全量历史记录（分页窗口外也要覆盖）：目标消息未落库时保持 null，
          // flow 收集回退到内存消息；历史读取失败同样回退。
          const fullTargetIndex = fullHistory
            ? fullHistory.findIndex((record) => record.id === messageId)
            : -1;
          const truncatedHistoryRecords =
            fullHistory && fullTargetIndex >= 0
              ? fullHistory.slice(fullTargetIndex)
              : null;
          if (fullHistory && fullTargetIndex >= 0) {
            checkpointIds = fullHistory
              .slice(fullTargetIndex)
              .filter((record) => record.role === "user" && record.checkpointId)
              .map((record) => record.checkpointId as string);
          }
          checkpointIds = [...new Set(checkpointIds)];

          // 被回滚轮次中的 workflow-generate 工具调用 → 对应 flow 的节点会话
          // 与 flow 级 checkpoint。优先用截断边界后的持久化历史（分页窗口外
          // 的 flow 卡片也要覆盖），目标消息未落库时回退到内存消息。
          const flowIds = truncatedHistoryRecords
            ? collectWorkflowFlowIdsFromRecords(truncatedHistoryRecords)
            : collectWorkflowFlowIdsFromMessages(messages.slice(targetIndex));

          // TODO 检测需要边界后的第一条 assistant responseId：todo_items 按
          // response_id 关联创建它的响应。截断边界优先使用持久化消息 id
          // （失败轮次没有 responseId），此时 responseId 为空，这里为 TODO
          // 检测单独向前寻找 —— 与截断删除的 id 范围语义一致。
          let todoBoundaryResponseId = responseId;
          if (!todoBoundaryResponseId) {
            for (let i = targetIndex + 1; i < messages.length; i++) {
              if (messages[i].role === "assistant" && messages[i].responseId) {
                todoBoundaryResponseId = messages[i].responseId;
                break;
              }
            }
          }
          const todoBoundary = todoBoundaryResponseId;

          // flow 级联影响与 TODO 查询互不依赖：并行执行。
          const [impact, todoJson] = await Promise.all([
            convId && flowIds.length > 0
              ? loadOrNull(() => resolveWorkflowFlowImpact(convId, flowIds))
              : Promise.resolve(null),
            convId && todoBoundary
              ? loadOrNull(() =>
                  window.snow.listTodosForRollback(convId, todoBoundary),
                )
              : Promise.resolve(null),
          ]);
          const workflowNodeIds = impact?.nodeConversationIds ?? [];
          const flowCheckpointIds = impact?.flowCheckpointIds ?? [];
          const workflowFlowCount = impact?.flowCount ?? 0;

          // 变更预览必须包含 flow checkpoint：节点（尤其 bash）对工作区的
          // 改动只记录在 flow_checkpoint 里，父会话 checkpoint 看不到它们。
          const previewCheckpointIds = [
            ...new Set([...checkpointIds, ...flowCheckpointIds]),
          ];
          // 存在需恢复的检查点时绝不降级到项目根目录
          if (workspaceError && previewCheckpointIds.length > 0) {
            throw workspaceError;
          }
          const loadChanges = async (): Promise<CheckpointFileChange[]> => {
            if (previewCheckpointIds.length === 0 || !sessionWorkDir) {
              return [];
            }
            try {
              // includeAll=false（rollback preview 语义）：Rust 侧按路径合并
              // 整条链（最早 original → 最新 expected）后，只列出当前状态仍
              // 处于链尾后状态的文件——与 restoreCheckpoints 的实际恢复范围
              // 完全一致。
              return await window.snow.listCheckpointChangesBatch(
                previewCheckpointIds,
                sessionWorkDir,
                false,
              );
            } catch {
              // Best effort — show dialog without changes on error
              return [];
            }
          };
          // 记忆清理清单：被回滚轮次（边界与截断一致：优先持久化消息
          // id，失败轮次无 responseId）保存的项目记忆，加上将随回滚级联
          // 删除的 WorkFlow 节点会话的全部记忆。用户确认时可勾选一并删除。
          const loadMemoryItems = async (): Promise<RollbackMemoryItem[]> => {
            if (!convId) {
              return [];
            }
            try {
              const memories = await window.snow.listProjectMemoriesForRollback(
                convId,
                persistedMessageId,
                todoBoundary,
                workflowNodeIds,
              );
              return memories
                .filter((record) => record.memoryId)
                .map((record) => ({
                  memoryId: record.memoryId,
                  title: record.title,
                  kind: record.kind,
                }));
            } catch {
              // Best effort — show empty on error
              return [];
            }
          };

          // 变更预览与记忆查询互不依赖：并行执行。
          const [changes, memoryItems] = await Promise.all([
            loadChanges(),
            loadMemoryItems(),
          ]);

          // TODO 清单解析（Rust 侧返回 JSON 字符串）。
          let todoItems: RollbackTodoItem[] = [];
          if (todoJson) {
            try {
              const parsed = JSON.parse(todoJson) as unknown;
              if (Array.isArray(parsed)) {
                todoItems = parsed
                  .filter(
                    (item): item is Record<string, unknown> =>
                      typeof item === "object" && item !== null,
                  )
                  .map((item) => ({
                    id: typeof item.id === "string" ? item.id : "",
                    content:
                      typeof item.content === "string" ? item.content : "",
                    status:
                      typeof item.status === "string" ? item.status : "pending",
                  }))
                  .filter((item) => item.id);
              }
            } catch {
              // Best effort — show empty on error
            }
          }

          // 异步查询完成时用户可能已切换到同项目的另一个会话，或又发起了
          // 一次回滚。只允许最新请求打开弹窗：
          // - 主视图路径要求目标会话仍是当前活动会话；
          // - 显式目标（会话面板）不受主视图切换影响，但要求该会话仍在内存中，
          //   避免为已释放（面板已关闭）的会话弹出回滚确认。
          const isTargetStillValid =
            targetSessionKey === undefined
              ? isActiveSessionKey(key)
              : Boolean(
                  ctx.sessionsRef.current[key] ??
                  ctx.sessionsRefData.current.get(key),
                );
          if (
            rollbackRequestIdRef.current !== requestId ||
            !isTargetStillValid
          ) {
            return;
          }

          ctx.setRollbackPreview({
            requestId,
            sessionKey: key,
            messageId,
            messageContent,
            changes,
            checkpointIds,
            workDir: sessionWorkDir,
            directoryId: capturedSessionRef?.directoryId,
            convId,
            responseId,
            persistedMessageId,
            rollbackConversationState,
            isFirstMessage,
            isContextCompaction: targetMessage.isContextCompaction === true,
            todoItems,
            memoryItems,
            workflowFlowCount,
            flowCheckpointIds,
            workflowNodeIds,
            streamPromise:
              ctx.sessionsRefData.current.get(key)?.streamPromise ?? null,
            summaryPromise:
              ctx.sessionsRefData.current.get(key)?.summaryPromise ?? null,
          });
        } catch (error) {
          // A missing/invalid WorkTree binding must never preview or restore against
          // the project root. Keep rollback closed and leave diagnostics in app logs.
          if (rollbackRequestIdRef.current === requestId) {
            ctx.setRollbackPreview(null);
            if (isWorktreeBindingError(error) && isActiveSessionKey(key)) {
              ctx.setWorktreeModeNotice(
                t("chat.rollbackWorktreeBindingMissing"),
              );
            }
            void window.snow.writeLog("WARN", {
              module: "checkpoint",
              func: "handleRollback",
              message:
                "Rollback workspace resolution failed; refusing project-root fallback",
              context: JSON.stringify({ conversationId: convId ?? "" }),
              error: getErrorMessage(error),
            });
          }
        } finally {
          if (rollbackRequestIdRef.current === requestId) {
            setPreparingMessageId(null);
          }
        }
      };

      void computeAndPreview().catch(() => {
        // Any unexpected preview error is fail-closed: do not offer a fallback path.
      });
    },
    [
      ctx.directoryId,
      ctx.directoryPath,
      ctx.updateSessionField,
      ctx.removeStreamingId,
      ctx.activeConversationIdRef,
      ctx.sessionsRefData,
      ctx.sessionsRef,
      ctx.runtimeInputStateRef,
      ctx.globalModeDefaultsRef,
      ctx.setRollbackPreview,
      ctx.abortWorkflowNodes,
      ctx.setWorktreeModeNotice,
      isActiveSessionKey,
      t,
    ],
  );

  const confirmRollback = useCallback(
    async (mode: RollbackMode, deleteMemories?: boolean): Promise<void> => {
      const preview = ctx.rollbackPreview;
      if (
        !preview ||
        rollbackRequestIdRef.current !== preview.requestId ||
        rollbackConfirmingRef.current
      ) {
        return;
      }
      rollbackConfirmingRef.current = true;
      rollbackCancelRequestedRef.current = false;
      try {
        // 确认必须使用打开弹窗时冻结的会话键，不能重新读取当前活动会话；
        // 同项目会话共享 workDir，仅靠目录无法发现串线。
        const key = preview.sessionKey;
        const {
          messageId,
          messageContent,
          checkpointIds,
          convId,
          responseId,
          persistedMessageId,
          rollbackConversationState,
          directoryId,
          isFirstMessage,
          isContextCompaction,
          flowCheckpointIds,
          workflowNodeIds,
          memoryItems,
        } = preview;

        // Wait for any in-flight stream AND summary generation to fully settle
        // (including the Rust store_chat_exchange / update_conversation_summary
        // write transactions) before issuing delete/truncate. Without this, the
        // write transactions race and can exceed the busy_timeout, producing a
        // "database is locked" error. The promises are captured at
        // handleRollback time (before the agent loop clears them from the ref).
        const pending: Promise<unknown>[] = [];
        if (preview.streamPromise) {
          pending.push(preview.streamPromise);
        }
        if (preview.summaryPromise) {
          pending.push(preview.summaryPromise);
        }
        if (pending.length > 0) {
          await Promise.allSettled(pending);
        }
        if (rollbackRequestIdRef.current !== preview.requestId) {
          return;
        }
        // 本地回滚前确认目标仍未落库：在途流可能刚完成保存并替换了消息 id
        const localOnly =
          !persistedMessageId &&
          !responseId &&
          !(isFirstMessage && !isContextCompaction);
        if (
          localOnly &&
          convId &&
          !ctx.sessionsRef.current[key]?.messages.some(
            (message) => message.id === messageId,
          )
        ) {
          ctx.setRollbackPreview({
            ...preview,
            error: t("chat.rollbackBoundaryChanged"),
          });
          return;
        }

        // Close durable admission and drain every local delegated owner BEFORE
        // either filesystem restore or SQLite truncation. A remote live owner or
        // unresolved historical boundary is a hard stop, not a best-effort restore.
        try {
          if (convId) {
            const stopParent = (): void => {
              abortConversationRun(convId);
            };
            if (isFirstMessage && !isContextCompaction) {
              await prepareSubAgentDeletion(ctx, convId, stopParent);
            } else if (persistedMessageId || responseId) {
              await prepareSubAgentRollback(
                convId,
                persistedMessageId
                  ? { fromMessageId: persistedMessageId }
                  : { fromResponseId: responseId },
                stopParent,
                (identity) => {
                  rollbackIdentityRef.current = identity;
                },
              );
            } else {
              // 尾部从未落库：无 DB 边界可截断，仅停止运行并本地移除
              stopParent();
            }
          }
        } catch (error) {
          if (
            rollbackCancelRequestedRef.current &&
            rollbackIdentityRef.current?.phase === "prepared"
          ) {
            try {
              await releasePreparedSubAgentRollback(
                rollbackIdentityRef.current,
              );
              rollbackIdentityRef.current = null;
              rollbackRequestIdRef.current += 1;
              ctx.setRollbackPreview(null);
            } catch (releaseError) {
              ctx.setRollbackPreview({
                ...preview,
                error: getErrorMessage(releaseError),
              });
            }
          } else
            ctx.setRollbackPreview({
              ...preview,
              error: getErrorMessage(error),
            });
          return;
        }
        if (rollbackCancelRequestedRef.current) {
          const identity = rollbackIdentityRef.current;
          if (identity?.phase === "prepared") {
            try {
              await releasePreparedSubAgentRollback(identity);
              rollbackIdentityRef.current = null;
              ctx.setRollbackPreview(null);
              rollbackRequestIdRef.current += 1;
            } catch (error) {
              ctx.setRollbackPreview({
                ...preview,
                error: getErrorMessage(error),
              });
            }
          } else
            ctx.setRollbackPreview({
              ...preview,
              error: t("chat.rollbackRetryRequired"),
            });
          return;
        }
        if (rollbackRequestIdRef.current !== preview.requestId) return;

        // Both conversation-only truncation and file restoration commit the irreversible phase.
        try {
          const identity = rollbackIdentityRef.current;
          if (identity) await markSubAgentRollbackRestoring(identity);
        } catch (error) {
          ctx.setRollbackPreview({
            ...preview,
            error: `${getErrorMessage(error)} ${t("chat.rollbackRetryRequired")}`,
          });
          return;
        }
        if (rollbackCancelRequestedRef.current) {
          ctx.setRollbackPreview({
            ...preview,
            error: t("chat.rollbackRetryRequired"),
          });
          return;
        }

        // 文件恢复必须前置于 DB 删除/截断：Rust delete_conversation（提交
        // 34be2bff 引入的孤儿快照清理）删除会话时会级联物理删除消息级
        // （chat_messages.checkpoint_id）与 flow 级（workflow_node_sessions.
        // flow_checkpoint_id）的 checkpoint 快照目录；放在删除之后会让
        // restore_checkpoints 因 manifest 缺失而静默跳过，文件完全不恢复。
        // 恢复只依赖磁盘 manifest 与对象文件、不依赖任何 DB 行，且幂等：
        // DB 失败重试时已恢复文件不再匹配 manifest 的 expected 状态，
        // states_match 门控自动跳过，重试安全。checkpointIds 为预览阶段
        // 按消息持久化顺序收集的检查点，flowCheckpointIds 为被回滚
        // WorkFlow 的 flow 级检查点（flow 首节点执行前拍摄）。Rust 侧按路径
        // 合并整条链（original 取最早、expected 取最新）后逐条恢复，与传入
        // 顺序无关，最终工作区 = 回滚目标处理前状态。
        if (
          mode === "conversation-and-files" &&
          preview.workDir &&
          checkpointIds.length + flowCheckpointIds.length > 0
        ) {
          // Persist the irreversible phase before touching files; failures retain the gate and preview.
          try {
            if (rollbackCancelRequestedRef.current) {
              ctx.setRollbackPreview({
                ...preview,
                error: t("chat.rollbackRetryRequired"),
              });
              return;
            }
            await window.snow.restoreCheckpoints(
              [...checkpointIds, ...flowCheckpointIds],
              preview.workDir,
            );
          } catch (error) {
            ctx.setRollbackPreview({
              ...preview,
              error: `${getErrorMessage(error)} ${t("chat.rollbackRetryRequired")}`,
            });
            return;
          } finally {
            ctx.setConversationVersion((version) => version + 1);
          }
        }

        // 删除/截断持久化会话；失败时界面消息保持原样，预览重新打开并
        // 显示错误后 return——checkpoint 尚未清理，用户重试时上面的前置
        // 恢复是幂等 no-op，重试可行，不会出现"界面已撤销但重启后消息
        // 复活"的不一致。
        try {
          if (isFirstMessage && !isContextCompaction && convId) {
            // 首条消息回滚 = 整会话删除：deleteMemories 直接走既有级联
            //（含子代理/WorkFlow 子会话）删除事务。
            await window.snow.deleteConversation(
              convId,
              deleteMemories === true,
            );
          } else if (convId && persistedMessageId) {
            // 失败/中断轮次没有 responseId，用持久化用户消息 ID 作为边界，
            // 从该行开始删除该轮及之后的所有消息。
            await window.snow.truncateConversationFromMessage(
              convId,
              persistedMessageId,
            );
            // 上下文 token 快照从截断后剩余的最后一条 assistant 消息恢复
            //（schema v46+ 每条 assistant 行都持久化了产生它的那次请求用量）；
            // 查不到（如旧数据全为 0）才退回 null。run 级累计统计仍清零——
            // 被截断轮次的贡献无法重算。
            const restoredUsage = await window.snow
              .listChatMessages(convId)
              .then((records) => tokenUsageFromMessageRecords(records))
              .catch(() => null);
            ctx.updateSessionField(key, "tokenUsage", restoredUsage);
            ctx.updateSessionField(key, "runTokenUsage", null);
            ctx.updateSessionField(key, "conversationTokenUsage", null);
            ctx.updateSessionField(key, "lastRunDurationMs", 0);
            ctx.updateSessionField(key, "conversationTtftSumMs", 0);
            ctx.updateSessionField(key, "conversationRequestCount", 0);
            // 回滚后累计统计已无对应消息：清零 DB（覆盖而非累加），
            // 避免重启后摘要条回显与截断后的消息列表不一致。
            void window.snow.resetConversationRunStats(convId).catch(() => {
              // 清零失败不阻塞回滚
            });
          } else if (convId && responseId) {
            await window.snow.truncateConversation(convId, responseId);
            const restoredUsage = await window.snow
              .listChatMessages(convId)
              .then((records) => tokenUsageFromMessageRecords(records))
              .catch(() => null);
            ctx.updateSessionField(key, "tokenUsage", restoredUsage);
            ctx.updateSessionField(key, "runTokenUsage", null);
            ctx.updateSessionField(key, "conversationTokenUsage", null);
            ctx.updateSessionField(key, "lastRunDurationMs", 0);
            ctx.updateSessionField(key, "conversationTtftSumMs", 0);
            ctx.updateSessionField(key, "conversationRequestCount", 0);
            // 回滚后累计统计已无对应消息：清零 DB（覆盖而非累加）。
            void window.snow.resetConversationRunStats(convId).catch(() => {
              // 清零失败不阻塞回滚
            });
          }
        } catch (error) {
          ctx.setRollbackPreview({
            ...preview,
            error: `${getErrorMessage(error)} ${t("chat.rollbackRetryRequired")}`,
          });
          return;
        }

        // 截断/删除成功后按预览清单清理记忆（best effort，不阻塞回滚）。
        // 首条消息路径已由 deleteConversation 的级联事务覆盖，不重复删除。
        if (
          deleteMemories === true &&
          convId &&
          memoryItems.length > 0 &&
          !(isFirstMessage && !isContextCompaction)
        ) {
          void window.snow
            .deleteProjectMemoriesByIds(
              memoryItems.map((item) => item.memoryId),
            )
            .catch(() => {
              // 清理失败不阻塞回滚
            });
        }

        // DB 删除/截断成功。文件恢复已前移到 DB 之前完成（见上），此处
        // 仅清理 checkpoint：过滤内存集合并删除快照；conversation-only
        // 模式从不恢复文件，同样只清理。deleteCheckpoints 只在 DB 成功
        // 后到达——失败分支已提前 return，快照未删，重试不受影响。
        if (checkpointIds.length > 0 || flowCheckpointIds.length > 0) {
          const sessionRef = ctx.sessionsRefData.current.get(key);
          if (sessionRef) {
            const discarded = new Set([...checkpointIds, ...flowCheckpointIds]);
            sessionRef.checkpointIds = sessionRef.checkpointIds.filter(
              (id) => !discarded.has(id),
            );
          }
          deleteCheckpoints([...checkpointIds, ...flowCheckpointIds]);
        }

        // 文件恢复与 DB 删除/截断均已完成，此时再更新消息列表：弹窗此刻
        // 仍打开，列表变化与弹窗关闭同步发生，避免"消息已回滚但弹窗还
        // 停着"的割裂，也不会出现界面与磁盘/DB 不一致。
        ctx.updateSessionMessages(key, (currentMessages) => {
          const targetIndex = currentMessages.findIndex(
            (message) => message.id === messageId,
          );
          return targetIndex === -1
            ? currentMessages
            : currentMessages.slice(0, targetIndex);
        });

        // WorkFlow 节点会话已随 truncate/delete 在 DB 级联删除：同步清掉
        // 内存槽位，避免侧边栏点击残留会话出现空视图。
        for (const nodeId of workflowNodeIds) {
          ctx.sessionsRefData.current.delete(nodeId);
          ctx.setSessions((prev) => {
            const next = { ...prev };
            delete next[nodeId];
            return next;
          });
        }

        // 回滚截断/删除了该会话的消息：残留的压缩失败提示一并复位。错误条
        // 粘在 compactingConversationId 上（见 useCompaction 的 finally），
        // 不清会让消息已回滚的会话永远挂着一条与现状无关的提示。
        if (
          ctx.compactingConversationId != null &&
          (ctx.compactingConversationId === key ||
            ctx.compactingConversationId === convId)
        ) {
          ctx.setCompactionError(null);
          ctx.setCompactingConversationId(null);
        }

        const targetWasActive = isActiveSessionKey(key);
        if (isFirstMessage && !isContextCompaction && convId) {
          // 会话已被删除：刷新侧边栏列表，移除该会话。只有目标仍是活动会话
          // 时才清空 activeId，不能影响用户已切换到的另一个并行会话。
          ctx.setConversationListVersion((version) => version + 1);
          ctx.sessionsRefData.current.delete(key);
          ctx.setSessions((prev) => {
            const next = { ...prev };
            delete next[key];
            return next;
          });
          if (targetWasActive) {
            const rollbackState = rollbackConversationState;
            // 回滚首条消息后视图回到"新建会话"：分配独立的新 pending 槽位
            // （可能与仍在后台流式的其他 pending 会话并行），并把回滚前的
            // 会话配置（模型/API/模式）迁移到该槽位。
            ctx.pendingSessionSeqRef.current += 1;
            ctx.setActiveId(undefined);
            // 仅当被回滚会话就是主视图激活会话（targetWasActive）才走到这里：
            // 会话面板回滚其他会话时不改写主视图的新会话槽位。
            const pendingKey = ctx.activeSessionKeyRef.current!;
            ctx.ensureSession(pendingKey, directoryId ?? ctx.directoryId);
            const pendingRef = ctx.sessionsRefData.current.get(pendingKey);
            if (pendingRef) {
              pendingRef.goalMode = rollbackState.goalMode;
              pendingRef.worktreeMode = rollbackState.worktreeMode;
              pendingRef.workflowMode = rollbackState.workflowMode;
              pendingRef.goalModeTokenBudget =
                rollbackState.goalModeTokenBudget;
            }
            ctx.runtimeInputStateRef.current[pendingKey] = {
              model: rollbackState.model,
              apiProfile: rollbackState.apiProfile,
              thinkingStrength: rollbackState.thinkingStrength,
              responsesFastMode: rollbackState.responsesFastMode,
            };
            ctx.goalModeRef.current = rollbackState.goalMode;
            ctx.worktreeModeRef.current = rollbackState.worktreeMode;
            ctx.workflowModeRef.current = rollbackState.workflowMode;
            ctx.setGoalModeState(rollbackState.goalMode);
            ctx.setWorktreeModeState(rollbackState.worktreeMode);
            ctx.setWorkflowModeState(rollbackState.workflowMode);
            ctx.setGoalModeTokenBudgetState(rollbackState.goalModeTokenBudget);
            ctx.setRollbackNewChatState(rollbackState);
          }
        } else {
          // Bump version so dependent components (user-message rail) re-fetch
          // the updated message list after truncation.
          ctx.setConversationVersion((version) => version + 1);
          // 截断会改变会话记录（消息数/预览/更新时间）：同步侧边栏列表
          ctx.setConversationListVersion((version) => version + 1);
        }

        if (!isContextCompaction && targetWasActive) {
          // 编排提交的消息内容是折叠标签 + 备注：图无法写进输入框，改回填编排器；
          // 旧消息没有图快照时只回填备注，绝不把不可读的标签原文塞进输入框。
          const workflowRestore = parseWorkflowComposerContent(messageContent);
          if (workflowRestore?.graph) {
            ctx.setRollbackWorkflowComposer({
              graph: workflowRestore.graph,
              note: workflowRestore.note,
            });
          } else {
            ctx.setDraftToRestore(
              workflowRestore ? workflowRestore.note : messageContent,
            );
          }
        }
        rollbackIdentityRef.current = null;
        ctx.setRollbackPreview((current) =>
          current?.requestId === preview.requestId ? null : current,
        );
      } finally {
        rollbackConfirmingRef.current = false;
      }
    },
    [
      ctx.rollbackPreview,
      ctx.directoryPath,
      ctx.updateSessionField,
      ctx.updateSessionMessages,
      ctx.setConversationVersion,
      ctx.setConversationListVersion,
      ctx.setActiveId,
      ctx.setDraftToRestore,
      ctx.setRollbackWorkflowComposer,
      ctx.setRollbackPreview,
      ctx.setRollbackNewChatState,
      ctx.ensureSession,
      ctx.setGoalModeState,
      ctx.setWorktreeModeState,
      ctx.setGoalModeTokenBudgetState,
      ctx.runtimeInputStateRef,
      ctx.goalModeRef,
      ctx.worktreeModeRef,
      ctx.sessionsRefData,
      ctx.sessionsRef,
      ctx.setSessions,
      ctx.activeSessionKeyRef,
      ctx.pendingSessionSeqRef,
      isActiveSessionKey,
      ctx.compactingConversationId,
      ctx.setCompactionError,
      ctx.setCompactingConversationId,
      t,
    ],
  );

  const cancelRollback = useCallback((): void => {
    const preview = ctx.rollbackPreview;
    const identity = rollbackIdentityRef.current;
    if (identity?.phase === "restoring") {
      // 恢复阶段不可取消：提示必须幂等，连点取消不能反复堆叠同一句话。
      const notice = t("chat.rollbackRetryRequired");
      if (preview && !(preview.error ?? "").includes(notice))
        ctx.setRollbackPreview({
          ...preview,
          error: preview.error ? `${preview.error} ${notice}` : notice,
        });
      return;
    }
    if (rollbackConfirmingRef.current) {
      rollbackCancelRequestedRef.current = true;
      return;
    }
    const close = (): void => {
      rollbackIdentityRef.current = null;
      rollbackRequestIdRef.current += 1;
      setPreparingMessageId(null);
      ctx.setRollbackPreview(null);
    };
    if (!identity) {
      close();
      return;
    }
    rollbackConfirmingRef.current = true;
    void releasePreparedSubAgentRollback(identity)
      .then(close)
      .catch((error: unknown) => {
        if (preview)
          ctx.setRollbackPreview({ ...preview, error: getErrorMessage(error) });
      })
      .finally(() => {
        rollbackConfirmingRef.current = false;
      });
  }, [ctx.rollbackPreview, ctx.setRollbackPreview, t]);

  return {
    clearDraftToRestore,
    clearRollbackWorkflowComposer,
    handleRollback,
    confirmRollback,
    cancelRollback,
    preparingMessageId,
  };
};
