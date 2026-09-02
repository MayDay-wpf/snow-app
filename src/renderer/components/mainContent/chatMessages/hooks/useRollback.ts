import { useCallback, useRef, useState } from "react";
import type {
  ConversationContextValue,
  CheckpointFileChange,
  RollbackMode,
  RollbackConversationState,
  RollbackMemoryItem,
  RollbackTodoItem,
  ToolCallInfo,
} from "../utils/conversationTypes";
import {
  PENDING_SESSION_KEY,
  isPendingSessionKey,
} from "../utils/conversationTypes";
import {
  deleteCheckpoints,
  directoryIdToPath,
  getErrorMessage,
  killRunningToolExecutions,
  parseToolCalls,
} from "../utils/conversationHelpers";
import { getActiveWorkflowNodeIds } from "../workflow/workflowRunner";

/** 比较两个 checkpoint id 的快照时间（`cp-{secs}-{nanos}-{count}`）。
 *  各段定宽补零后做字典序比较，等价于时间升序；无法解析时返回 0，
 *  由 sort 的稳定性保持原相对顺序。 */
const compareCheckpointIds = (a: string, b: string): number => {
  const parse = (id: string): [string, string, string] | null => {
    const match = id.match(/^cp-(\d+)-(\d+)-(\d+)$/);
    return match
      ? [
          match[1].padStart(10, "0"),
          match[2].padStart(9, "0"),
          match[3].padStart(6, "0"),
        ]
      : null;
  };
  const parsedA = parse(a);
  const parsedB = parse(b);
  if (!parsedA || !parsedB) {
    return 0;
  }
  for (let index = 0; index < parsedA.length; index++) {
    const order = parsedA[index].localeCompare(parsedB[index]);
    if (order !== 0) {
      return order;
    }
  }
  return 0;
};

/**
 * 回滚逻辑：中止流、预览文件变更、确认/取消回滚。
 * context_compaction 回滚必须调用 truncateConversation，以其自身 responseId
 * 为起点删除边界及后续消息；不得调用 deleteConversation。
 */
export const useRollback = (ctx: ConversationContextValue) => {
  const clearDraftToRestore = useCallback((): void => {
    ctx.setDraftToRestore(null);
  }, [ctx.setDraftToRestore]);

  /** 正在计算变更（弹窗弹出前）的消息 id：SSH 下 listCheckpointChanges
   *  经 SFTP 遍历可能较慢，入口按钮在此期间显示 loading。 */
  const [preparingMessageId, setPreparingMessageId] = useState<string | null>(
    null,
  );
  /** 每次打开/取消回滚都会推进序号，异步变更/TODO 查询只能提交自己的结果。 */
  const rollbackRequestIdRef = useRef(0);

  const handleRollback = useCallback(
    (messageId: string): void => {
      const key = ctx.activeSessionKeyRef.current ?? PENDING_SESSION_KEY;
      const requestId = ++rollbackRequestIdRef.current;

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
      // 回滚作用于会话自己的目录(而非运行时全局目录),确保 checkpoint
      // manifest.work_dir 与恢复目录一致,切换项目后仍可回滚旧会话。
      const sessionWorkDir =
        directoryIdToPath(ref?.directoryId) ?? ctx.directoryPath;
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
      const checkpointId = targetMessage.checkpointId;
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
      let capturedPlanMode = capturedSessionRef?.planMode ?? defaults.planMode;
      let capturedGoalMode = capturedSessionRef?.goalMode ?? defaults.goalMode;
      let capturedWorkflowMode =
        capturedSessionRef?.workflowMode ?? defaults.workflowMode;
      const capturedGoalModeTokenBudget =
        capturedSessionRef?.goalModeTokenBudget ?? defaults.goalModeTokenBudget;
      if (capturedWorkflowMode) {
        capturedWorktreeMode = false;
        capturedPlanMode = false;
        capturedGoalMode = false;
      } else if (capturedWorktreeMode) {
        capturedPlanMode = false;
        capturedGoalMode = false;
      } else if (capturedPlanMode) {
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
        for (let i = targetIndex + 1; i < messages.length; i++) {
          if (messages[i].role === "assistant" && messages[i].responseId) {
            responseId = messages[i].responseId;
            break;
          }
        }
      }

      // Compute file changes for the confirmation dialog. This is async but
      // we set the preview state once the diff is ready.
      const computeAndPreview = async (): Promise<void> => {
        try {
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
          let conversationRecord: Awaited<
            ReturnType<typeof window.snow.getChatConversation>
          > = null;
          let runtimeConfig: Awaited<
            ReturnType<typeof window.snow.getConversationRuntimeConfig>
          > | null = null;
          if (convId) {
            const [recordResult, runtimeResult] = await Promise.allSettled([
              window.snow.getChatConversation(convId),
              window.snow.getConversationRuntimeConfig(convId),
            ]);
            if (recordResult.status === "fulfilled") {
              conversationRecord = recordResult.value;
            }
            if (runtimeResult.status === "fulfilled") {
              runtimeConfig = runtimeResult.value;
            }
          }
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
            planMode: capturedPlanMode,
            goalMode: capturedGoalMode,
            worktreeMode: capturedWorktreeMode,
            workflowMode: capturedWorkflowMode,
            goalModeTokenBudget: capturedGoalModeTokenBudget,
          };
          let checkpointIds = initialCheckpointIds;
          // 全量历史记录（分页窗口外也要覆盖）：目标消息未落库时保持 null，
          // flow 收集回退到内存消息。
          let truncatedHistoryRecords: Awaited<
            ReturnType<typeof window.snow.listChatMessages>
          > | null = null;
          if (convId) {
            try {
              const fullHistory = await window.snow.listChatMessages(convId);
              const fullTargetIndex = fullHistory.findIndex(
                (record) => record.id === messageId,
              );
              if (fullTargetIndex >= 0) {
                checkpointIds = fullHistory
                  .slice(fullTargetIndex)
                  .filter(
                    (record) => record.role === "user" && record.checkpointId,
                  )
                  .map((record) => record.checkpointId as string);
                // 只看截断边界之后的消息：目标之前的 flow 与本次回滚无关，
                // 不能误删其节点会话。
                truncatedHistoryRecords = fullHistory.slice(fullTargetIndex);
              }
            } catch {
              // 使用当前已加载消息作为回退，仍保持消息数组顺序。
            }
          }
          checkpointIds = [...new Set(checkpointIds)];

          // 被回滚轮次中的 workflow-generate 工具调用 → 对应 flow 的节点会话
          // 与 flow 级 checkpoint。优先用截断边界后的持久化历史（分页窗口外
          // 的 flow 卡片也要覆盖），目标消息未落库时回退到内存消息。
          // 解析复用 parseToolCalls：tool_calls_json 的 name 可能嵌套在
          // function/function_call 包装内，且 interactionId 的构造格式必须
          // 与 createWorkflowNodeSession 写入的 flow_id 完全一致。
          const collectWorkflowFlowIds = (): string[] => {
            const flowIds: string[] = [];
            const collectFromToolCalls = (toolCalls: ToolCallInfo[]): void => {
              for (const toolCall of toolCalls) {
                if (
                  toolCall.name.endsWith("workflow-generate") &&
                  toolCall.interactionId &&
                  !flowIds.includes(toolCall.interactionId)
                ) {
                  flowIds.push(toolCall.interactionId);
                }
              }
            };
            if (truncatedHistoryRecords) {
              for (const record of truncatedHistoryRecords) {
                if (record.role !== "assistant") {
                  continue;
                }
                collectFromToolCalls(parseToolCalls(record.toolCallsJson));
              }
            } else {
              for (const message of messages.slice(targetIndex)) {
                if (message.role !== "assistant") {
                  continue;
                }
                collectFromToolCalls(message.toolCalls ?? []);
              }
            }
            return flowIds;
          };
          let workflowFlowCount = 0;
          let flowCheckpointIds: string[] = [];
          let workflowNodeIds: string[] = [];
          if (convId && collectWorkflowFlowIds().length > 0) {
            try {
              const flowIds = collectWorkflowFlowIds();
              const nodeRecords =
                await window.snow.listWorkflowNodeSessions(convId);
              const affected = nodeRecords.filter((record) =>
                flowIds.includes(record.flowId),
              );
              workflowNodeIds = [
                ...new Set(affected.map((record) => record.conversationId)),
              ];
              flowCheckpointIds = [
                ...new Set(
                  affected
                    .map((record) => record.flowCheckpointId)
                    .filter(Boolean),
                ),
              ];
              workflowFlowCount = new Set(
                affected.map((record) => record.flowId),
              ).size;
            } catch {
              // Best effort — 回滚在无 flow 元数据时仍照常进行
            }
          }

          // 变更预览必须包含 flow checkpoint：节点（尤其 bash）对工作区的
          // 改动只记录在 flow_checkpoint 里，父会话 checkpoint 看不到它们。
          const previewCheckpointIds = [
            ...new Set([...checkpointIds, ...flowCheckpointIds]),
          ];
          let changes: CheckpointFileChange[] = [];
          if (previewCheckpointIds.length > 0 && sessionWorkDir) {
            try {
              // includeAll=false（rollback preview 语义）：只列出当前状态
              // 仍处于 checkpoint 后状态的文件——与 restoreCheckpoints 的
              // 实际恢复范围完全一致。true 的"文件面板"语义会把后来被
              // 覆盖/漂移的痕迹也列出来，造成"回滚列表混入无关文件"。
              changes = await window.snow.listCheckpointChangesBatch(
                previewCheckpointIds,
                sessionWorkDir,
                false,
              );
            } catch {
              // Best effort — show dialog without changes on error
            }
          }

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

          // Fetch TODO items that will be deleted alongside the rollback.
          let todoItems: RollbackTodoItem[] = [];
          if (convId && todoBoundaryResponseId) {
            try {
              const todoJson = await window.snow.listTodosForRollback(
                convId,
                todoBoundaryResponseId,
              );
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

          // 记忆清理清单：被回滚轮次（边界与截断一致：优先持久化消息
          // id，失败轮次无 responseId）保存的项目记忆，加上将随回滚级联
          // 删除的 WorkFlow 节点会话的全部记忆。用户确认时可勾选一并删除。
          let memoryItems: RollbackMemoryItem[] = [];
          if (convId) {
            try {
              const memories = await window.snow.listProjectMemoriesForRollback(
                convId,
                persistedMessageId,
                todoBoundaryResponseId,
                workflowNodeIds,
              );
              memoryItems = memories
                .filter((record) => record.memoryId)
                .map((record) => ({
                  memoryId: record.memoryId,
                  title: record.title,
                  kind: record.kind,
                }));
            } catch {
              // Best effort — show empty on error
            }
          }

          // 异步查询完成时用户可能已切换到同项目的另一个会话，或又发起了
          // 一次回滚。只允许仍属于当前活动会话的最新请求打开弹窗。
          if (
            rollbackRequestIdRef.current !== requestId ||
            ctx.activeSessionKeyRef.current !== key
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
            checkpointId: checkpointIds[0],
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
        } finally {
          if (rollbackRequestIdRef.current === requestId) {
            setPreparingMessageId(null);
          }
        }
      };

      void computeAndPreview();
    },
    [
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
    ],
  );

  const confirmRollback = useCallback(
    async (mode: RollbackMode, deleteMemories?: boolean): Promise<void> => {
      const preview = ctx.rollbackPreview;
      if (!preview || rollbackRequestIdRef.current !== preview.requestId) {
        return;
      }

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

      // 回退是事务性的：必须先成功删除/截断持久化会话，再更新界面。
      // 持久化失败时界面消息保持原样，预览重新打开并显示错误，用户可
      // 以重试或取消，不会出现"界面已撤销但重启后消息复活"的不一致。
      try {
        if (isFirstMessage && !isContextCompaction && convId) {
          // 首条消息回滚 = 整会话删除：deleteMemories 直接走既有级联
          //（含子代理/WorkFlow 子会话）删除事务。
          await window.snow.deleteConversation(convId, deleteMemories === true);
        } else if (convId && persistedMessageId) {
          // 失败/中断轮次没有 responseId，用持久化用户消息 ID 作为边界，
          // 从该行开始删除该轮及之后的所有消息。
          ctx.updateSessionField(key, "tokenUsage", null);
          ctx.updateSessionField(key, "runTokenUsage", null);
          ctx.updateSessionField(key, "conversationTokenUsage", null);
          ctx.updateSessionField(key, "lastRunDurationMs", 0);
          await window.snow.truncateConversationFromMessage(
            convId,
            persistedMessageId,
          );
          // 回滚后累计统计已无对应消息：清零 DB（覆盖而非累加），
          // 避免重启后摘要条回显与截断后的消息列表不一致。
          void window.snow.resetConversationRunStats(convId).catch(() => {
            // 清零失败不阻塞回滚
          });
        } else if (convId && responseId) {
          ctx.updateSessionField(key, "tokenUsage", null);
          ctx.updateSessionField(key, "runTokenUsage", null);
          ctx.updateSessionField(key, "conversationTokenUsage", null);
          ctx.updateSessionField(key, "lastRunDurationMs", 0);
          await window.snow.truncateConversation(convId, responseId);
          // 回滚后累计统计已无对应消息：清零 DB（覆盖而非累加）。
          void window.snow.resetConversationRunStats(convId).catch(() => {
            // 清零失败不阻塞回滚
          });
        }
      } catch (error) {
        ctx.setRollbackPreview({
          ...preview,
          error: getErrorMessage(error),
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
          .deleteProjectMemoriesByIds(memoryItems.map((item) => item.memoryId))
          .catch(() => {
            // 清理失败不阻塞回滚
          });
      }

      // Persistence succeeded — now update the UI. The message list update is
      // intentionally deferred until AFTER the file restore: SSH rollback
      // restores files over SFTP and can take a while, and the confirm dialog
      // stays open with a loading button during that time. Updating the list
      // here would show the rolled-back conversation while the dialog is still
      // waiting, which feels broken. DB persistence already happened above, so
      // the UI state below cannot diverge from disk.
      // 文件检查点只作为临时清理集合使用，回滚顺序以预览阶段按消息
      // 持久化顺序收集的 checkpointIds 为准。flowCheckpointIds 是被回滚
      // WorkFlow 的 flow 级检查点（flow 首节点执行前拍摄），与父会话
      // checkpoint 按快照时间升序合并后交给 restore（restore 内部逆序
      // 逐个恢复，最终工作区状态 = 最早的快照 = 回滚目标处理前状态）。
      if (checkpointIds.length > 0 || flowCheckpointIds.length > 0) {
        const sessionRef = ctx.sessionsRefData.current.get(key);
        if (sessionRef) {
          const discarded = new Set([...checkpointIds, ...flowCheckpointIds]);
          sessionRef.checkpointIds = sessionRef.checkpointIds.filter(
            (id) => !discarded.has(id),
          );
        }

        const shouldRestoreFiles =
          mode === "conversation-and-files" && Boolean(preview.workDir);
        if (shouldRestoreFiles && preview.workDir) {
          // 等待文件恢复完成再关闭对话框：SSH 回滚经 SFTP 逐文件写回，
          // 可能较慢，对话框确认按钮在此期间显示 loading。恢复失败不
          // 阻塞消息清理（best effort，与旧行为一致）。
          try {
            await window.snow.restoreCheckpoints(
              [...checkpointIds, ...flowCheckpointIds].sort(
                compareCheckpointIds,
              ),
              preview.workDir,
            );
          } catch {
            // Best effort — file restore failure must not block rollback cleanup.
          } finally {
            ctx.setConversationVersion((version) => version + 1);
            deleteCheckpoints([...checkpointIds, ...flowCheckpointIds]);
          }
        } else {
          deleteCheckpoints([...checkpointIds, ...flowCheckpointIds]);
        }
      }

      // 文件恢复完成后再更新消息列表：弹窗此时仍打开（确认按钮 loading），
      // 列表变化与弹窗关闭同步发生，避免"消息已回滚但弹窗还停着"的割裂。
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

      const targetWasActive = ctx.activeSessionKeyRef.current === key;
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
          const pendingKey = ctx.activeSessionKeyRef.current!;
          ctx.ensureSession(pendingKey, directoryId ?? ctx.directoryId);
          const pendingRef = ctx.sessionsRefData.current.get(pendingKey);
          if (pendingRef) {
            pendingRef.planMode = rollbackState.planMode;
            pendingRef.goalMode = rollbackState.goalMode;
            pendingRef.worktreeMode = rollbackState.worktreeMode;
            pendingRef.workflowMode = rollbackState.workflowMode;
            pendingRef.goalModeTokenBudget = rollbackState.goalModeTokenBudget;
          }
          ctx.runtimeInputStateRef.current[pendingKey] = {
            model: rollbackState.model,
            apiProfile: rollbackState.apiProfile,
            thinkingStrength: rollbackState.thinkingStrength,
            responsesFastMode: rollbackState.responsesFastMode,
          };
          ctx.planModeRef.current = rollbackState.planMode;
          ctx.goalModeRef.current = rollbackState.goalMode;
          ctx.worktreeModeRef.current = rollbackState.worktreeMode;
          ctx.workflowModeRef.current = rollbackState.workflowMode;
          ctx.setPlanModeState(rollbackState.planMode);
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
        ctx.setDraftToRestore(messageContent);
      }
      ctx.setRollbackPreview((current) =>
        current?.requestId === preview.requestId ? null : current,
      );
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
      ctx.setRollbackPreview,
      ctx.setRollbackNewChatState,
      ctx.ensureSession,
      ctx.setPlanModeState,
      ctx.setGoalModeState,
      ctx.setWorktreeModeState,
      ctx.setGoalModeTokenBudgetState,
      ctx.runtimeInputStateRef,
      ctx.planModeRef,
      ctx.goalModeRef,
      ctx.worktreeModeRef,
      ctx.sessionsRefData,
      ctx.setSessions,
      ctx.activeSessionKeyRef,
      ctx.pendingSessionSeqRef,
    ],
  );

  const cancelRollback = useCallback((): void => {
    rollbackRequestIdRef.current += 1;
    setPreparingMessageId(null);
    ctx.setRollbackPreview(null);
  }, [ctx.setRollbackPreview]);

  return {
    clearDraftToRestore,
    handleRollback,
    confirmRollback,
    cancelRollback,
    preparingMessageId,
  };
};
