import {
  prepareSubAgentArchive,
  prepareSubAgentDeletion,
} from "./subAgentParentInbox";
import { useEffect, useRef } from "react";
import type { ChatInputSendOptions } from "../../chatInput/types";
import {
  buildConversationMessages,
  tokenUsageFromMessageRecords,
} from "../utils/conversationHelpers";
import {
  CHAT_MESSAGE_PAGE_SIZE,
  toMessageRecordRefs,
  type ConversationContextValue,
} from "../utils/conversationTypes";

export type ConversationMessageReceipt = {
  conversationId: string;
  /** started: the target turn begins now; queued: it joins the target's queue. */
  status: "started" | "queued";
};

type ConversationMessageSender = (
  conversationId: string,
  text: string,
) => Promise<ConversationMessageReceipt>;

let activeSender: ConversationMessageSender | null = null;

type ConversationAborter = (conversationId: string) => boolean;

let activeAborter: ConversationAborter | null = null;

/**
 * 向任意主会话投递用户消息（插件会话编排）。目标不必是当前视图会话：
 * 会话未在内存中时先后台加载历史与模式，再走与普通发送一致的代理循环；
 * 目标正在运行时消息进入其待发队列，由循环在回合结束后自动发出。
 */
export const sendMessageToConversation = (
  conversationId: string,
  text: string,
): Promise<ConversationMessageReceipt> => {
  if (!activeSender) {
    return Promise.reject(new Error("Chat runtime is not ready"));
  }
  return activeSender(conversationId, text);
};

const prepareBackgroundSession = async (
  ctx: ConversationContextValue,
  conversationId: string,
): Promise<void> => {
  const record = await window.snow.getChatConversation(conversationId);
  if (!record) {
    throw new Error(`Conversation not found: ${conversationId}`);
  }
  if (
    record.parentConversationId ||
    record.conversationType === "sub_agent" ||
    record.conversationType === "workflow_node"
  ) {
    throw new Error(
      "Only top-level conversations can receive messages from plugins",
    );
  }
  // 与进行中的视图加载共享同一请求，避免重复拉取并覆盖其结果。
  await ctx.historyLoadPromisesRef.current.get(conversationId);
  if (ctx.sessionsRef.current[conversationId]) {
    return;
  }

  const [page, modes] = await Promise.all([
    window.snow.listChatMessagesPaginated(
      conversationId,
      "",
      CHAT_MESSAGE_PAGE_SIZE,
    ),
    window.snow.getConversationModes(conversationId),
  ]);
  ctx.ensureSession(conversationId, record.directoryId || undefined);
  // 模式必须从库中恢复：发送时 persistConversationSelection 会按会话内存
  // 模式回写，若仍是全局默认值就会覆盖用户在该会话里设置的模式。
  const ref = ctx.sessionsRefData.current.get(conversationId);
  if (ref && modes) {
    ref.goalMode = modes.goalMode ?? ref.goalMode;
    ref.worktreeMode = modes.worktreeMode ?? ref.worktreeMode;
    ref.workflowMode = modes.workflowMode ?? ref.workflowMode;
    ref.goalModeTokenBudget =
      modes.goalModeTokenBudget ?? ref.goalModeTokenBudget;
  }
  ctx.setSessions((sessions) => {
    const session = sessions[conversationId];
    if (!session || session.messages.length > 0) return sessions;
    return {
      ...sessions,
      [conversationId]: {
        ...session,
        messages: buildConversationMessages(page.items),
        messageRecords: toMessageRecordRefs(page.items),
        summary: record.title || record.summary,
        hasMoreMessages: page.hasMore,
        tokenUsage: tokenUsageFromMessageRecords(page.items),
      },
    };
  });
};

const deliverMessage = async (
  ctx: ConversationContextValue,
  conversationId: string,
  text: string,
): Promise<ConversationMessageReceipt> => {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Message text must not be blank");
  }
  await prepareBackgroundSession(ctx, conversationId);
  const wasBusy =
    ctx.sessionsRefData.current.get(conversationId)?.isSending === true;
  // 程序化发送省略 deliveryMode 时始终排队；会话空闲则直接开始新回合。
  const options: ChatInputSendOptions = { targetSessionKey: conversationId };
  ctx.handleSendMessageRef.current(trimmed, options);
  return { conversationId, status: wasBusy ? "queued" : "started" };
};

/**
 * 注册会话消息投递通道。挂在聊天上下文 Provider 上（应用常驻挂载），
 * 插件写动作经 sendMessageToConversation 进入这里。
 */
export const useConversationMessageBridge = (
  ctx: ConversationContextValue,
): void => {
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  useEffect(() => {
    const sender: ConversationMessageSender = (conversationId, text) =>
      deliverMessage(ctxRef.current, conversationId, text);
    activeSender = sender;
    return () => {
      if (activeSender === sender) {
        activeSender = null;
      }
    };
  }, []);
};

/**
 * 中止指定主会话的运行（插件会话编排）。与界面停止按钮同一收尾路径，
 * 级联中止其子代理与 WorkFlow 节点。返回是否确有运行中的回合被中止。
 */
export const abortConversationRun = (conversationId: string): boolean => {
  if (!activeAborter) {
    throw new Error("Chat runtime is not ready");
  }
  return activeAborter(conversationId);
};

/** 注册会话中止通道；handleAbort 需在会话管理 Hook 创建后传入。 */
export const useConversationAbortBridge = (
  ctx: ConversationContextValue,
  handleAbort: (conversationId: string) => void,
): void => {
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const abortRef = useRef(handleAbort);
  abortRef.current = handleAbort;
  useEffect(() => {
    const aborter: ConversationAborter = (conversationId) => {
      const ref = ctxRef.current.sessionsRefData.current.get(conversationId);
      if (!ref?.isSending || ref.isAbortRequested) {
        return false;
      }
      abortRef.current(conversationId);
      return true;
    };
    activeAborter = aborter;
    return () => {
      if (activeAborter === aborter) {
        activeAborter = null;
      }
    };
  }, []);
};

export type ConversationRemovalOptions = {
  /** 归档会跳过置顶会话（Rust 侧不搬移），置顶会话也不应被中止。 */
  skipPinned: boolean;
};

type ConversationRemover = (
  conversationIds: string[],
  remove: () => Promise<unknown>,
  options: ConversationRemovalOptions,
) => Promise<void>;

let activeRemover: ConversationRemover | null = null;

/**
 * 从存储收集会话树全部 id（会话、直接子代理、WorkFlow 节点及节点派生的
 * 子代理），与 Rust 删除 / 归档的级联范围一致。插件可操作任意项目的会话，
 * 不能依赖侧栏只覆盖当前项目的树形缓存。
 */
const collectStoredConversationTreeIds = async (
  rootIds: string[],
): Promise<string[]> => {
  if (rootIds.length === 0) {
    return [];
  }
  const nodeMap = await window.snow.listWorkflowNodeSessionsByParents(rootIds);
  const nodeIds = Object.values(nodeMap)
    .flat()
    .map((node) => node.conversationId);
  const subAgentMap = await window.snow.listSubAgentConversationsByParents([
    ...rootIds,
    ...nodeIds,
  ]);
  const subAgentIds = Object.values(subAgentMap)
    .flat()
    .map((subAgent) => subAgent.conversationId);
  return [...new Set([...rootIds, ...nodeIds, ...subAgentIds])];
};

const excludePinnedConversations = async (
  conversationIds: string[],
): Promise<string[]> => {
  const records = await Promise.all(
    conversationIds.map((id) => window.snow.getChatConversation(id)),
  );
  return conversationIds.filter(
    (_id, index) => records[index]?.status !== "pin",
  );
};

/**
 * 删除 / 归档会话（插件会话编排），与侧栏删除 / 归档同一收尾流程：先中止
 * 整棵会话树的运行，再执行 remove 完成存储操作，随后清理草稿；被移除的
 * 包含当前会话时切到新会话。列表刷新由调用方负责。
 */
export const removeConversationTrees = (
  conversationIds: string[],
  remove: () => Promise<unknown>,
  options: ConversationRemovalOptions,
): Promise<void> => {
  if (!activeRemover) {
    return Promise.reject(new Error("Chat runtime is not ready"));
  }
  return activeRemover(conversationIds, remove, options);
};

/** 注册会话移除通道；abortConversation / handleNewChat 来自会话管理 Hook。 */
export const useConversationRemovalBridge = (
  ctx: ConversationContextValue,
  abortConversation: (conversationId: string) => void,
  handleNewChat: () => void,
  stopConversation: (conversationId: string) => void,
): void => {
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const abortRef = useRef(abortConversation);
  abortRef.current = abortConversation;
  const newChatRef = useRef(handleNewChat);
  newChatRef.current = handleNewChat;
  const stopRef = useRef(stopConversation);
  stopRef.current = stopConversation;
  useEffect(() => {
    const remover: ConversationRemover = async (
      conversationIds,
      remove,
      options,
    ) => {
      const rootIds = options.skipPinned
        ? await excludePinnedConversations(conversationIds)
        : conversationIds;
      // Archive moves settled data; only permanent deletion closes durable admission.
      for (const rootId of rootIds) {
        if (options.skipPinned) {
          await prepareSubAgentArchive(rootId, () => stopRef.current(rootId));
        } else {
          await prepareSubAgentDeletion(ctxRef.current, rootId, () =>
            stopRef.current(rootId),
          );
        }
      }
      const targetIds = await collectStoredConversationTreeIds(rootIds);
      for (const targetId of targetIds) {
        abortRef.current(targetId);
      }

      await remove();

      const current = ctxRef.current;
      // 旧的增量记录可能在列表刷新后被运行状态变化重新插入。
      const removedIds = new Set(targetIds);
      for (const [pendingId, realId] of current.pendingToRealConversationIdRef
        .current) {
        if (removedIds.has(realId)) {
          removedIds.add(pendingId);
        }
      }
      current.setUpsertedConversation((previous) =>
        previous && removedIds.has(previous.record.conversationId)
          ? null
          : previous,
      );
      for (const targetId of targetIds) {
        current.clearInputDraft(targetId);
      }
      // 通知状态随会话一起清理：后台完成的会话 id 在回合结束时被加入
      // completedConversationIds，删除 / 归档后若不在这里移除，项目徽标与
      // 「其他项目」通知区块会一直展示已经不存在的会话（只有重载窗口才清空）。
      // 待授权 / 待回答的残留由上方 abortConversation 按会话逐个结算。
      current.setCompletedConversationIds((prev) => {
        let changed = false;
        const next = new Set(prev);
        for (const targetId of targetIds) {
          if (next.delete(targetId)) {
            changed = true;
          }
        }
        return changed ? next : prev;
      });
      const activeId = current.activeConversationIdRef.current;
      if (activeId && targetIds.includes(activeId)) {
        newChatRef.current();
      }
    };
    activeRemover = remover;
    return () => {
      if (activeRemover === remover) {
        activeRemover = null;
      }
    };
  }, []);
};
