import { useEffect, useState } from "react";

import type { ChatConversationRecord } from "../../../preload";
import { useChatConversationContext } from "../mainContent/chatMessages";

/** 节点层类型：根会话 / 子代理 / Workflow 节点。 */
export type ConversationTabNodeKind = "root" | "sub-agent" | "workflow-node";

/** 会话 tab 下拉里的一个会话节点（Workflow 节点可带下一层子代理）。 */
export type ConversationTabTreeNode = {
  conversationId: string;
  /** 显示名：摘要 > 标题 > 子代理名 / 节点名（可能为空串，由调用方兜底） */
  label: string;
  /** 运行状态：子代理与 Workflow 节点共用 subAgentStatus 字段；根会话为空串 */
  status: string;
  kind: ConversationTabNodeKind;
  /** 下一层：Workflow 节点派生的子代理 */
  children: ConversationTabTreeNode[];
};

/** 一棵会话 tab 下拉树：根会话 + 直接子代理 + Workflow 节点（含节点下的子代理）。 */
export type ConversationTabTree = {
  root: ConversationTabTreeNode;
  subAgents: ConversationTabTreeNode[];
  workflowNodes: ConversationTabTreeNode[];
};

const toNode = (
  record: ChatConversationRecord,
  kind: ConversationTabNodeKind,
  children: ConversationTabTreeNode[] = [],
): ConversationTabTreeNode => ({
  conversationId: record.conversationId,
  // Workflow 节点的显示名与侧边栏节点列表一致：节点名（subAgentName）优先，
  // 其次才是会话标题；子代理则优先 AI 摘要。
  label:
    kind === "workflow-node"
      ? record.subAgentName || record.title
      : record.summary || record.title || record.subAgentName,
  status: record.subAgentStatus,
  kind,
  children,
});

/**
 * 查询一棵会话树：根会话 + 其直接子代理 + 其 Workflow 节点 + 节点派生的子代理。
 * 层级与侧边栏会话树一致（Workflow 主会话 → 节点 → 子代理）。
 */
export const loadConversationTabTree = async (
  rootConversationId: string,
): Promise<ConversationTabTree> => {
  const [rootRecord, subAgentMap, workflowNodeMap] = await Promise.all([
    window.snow.getChatConversation(rootConversationId).catch(() => null),
    window.snow.listSubAgentConversationsByParents([rootConversationId]),
    window.snow.listWorkflowNodeSessionsByParents([rootConversationId]),
  ]);
  const nodeRecords = workflowNodeMap[rootConversationId] ?? [];
  // 节点下是否派生了子代理：单次批量查询，避免逐个节点查询。
  const nodeSubAgentMap =
    nodeRecords.length > 0
      ? await window.snow.listSubAgentConversationsByParents(
          nodeRecords.map((node) => node.conversationId),
        )
      : {};

  return {
    root: {
      conversationId: rootConversationId,
      label: rootRecord?.summary || rootRecord?.title || "",
      status: "",
      kind: "root",
      children: [],
    },
    subAgents: (subAgentMap[rootConversationId] ?? []).map((record) =>
      toNode(record, "sub-agent"),
    ),
    workflowNodes: nodeRecords.map((node) =>
      toNode(
        node,
        "workflow-node",
        (nodeSubAgentMap[node.conversationId] ?? []).map((record) =>
          toNode(record, "sub-agent"),
        ),
      ),
    ),
  };
};

/** 下拉里是否有根会话以外的会话可选（没有则 tab 标题保持原样，不显示下拉）。 */
export const hasConversationTabChildren = (
  tree: ConversationTabTree | null,
): boolean =>
  tree !== null && (tree.subAgents.length > 0 || tree.workflowNodes.length > 0);

/**
 * 目标会话是否属于以 rootConversationId 为根的会话树（根自身，或其直接子层：
 * 子代理 / Workflow 节点）。是则返回其会话记录（标题回写用），否则返回 null。
 *
 * 面板内的「返回主会话」等入口据此判断：属于本 tab 会话树就在同一个 tab 内
 * 切换展示目标，否则交回全局选择（主内容区）。
 */
export const loadTabTreeConversation = async (
  conversationId: string,
  rootConversationId: string,
): Promise<ChatConversationRecord | null> => {
  const trimmedId = conversationId.trim();
  if (!trimmedId) {
    return null;
  }
  const record = await window.snow
    .getChatConversation(trimmedId)
    .catch(() => null);
  if (!record) {
    return null;
  }
  return record.conversationId === rootConversationId ||
    record.parentConversationId === rootConversationId
    ? record
    : null;
};

/**
 * 会话 tab 下拉的树形数据：根会话及其子代理 / Workflow 节点 / 节点下的子代理。
 * 刷新信号与侧边栏会话树保持一致：列表版本、树版本（节点创建与状态变化）、
 * 会话 upsert（标题与摘要变化）以及子代理运行变化。
 */
export const useConversationTabTree = (
  rootConversationId: string,
): ConversationTabTree | null => {
  const {
    conversationListVersion,
    conversationTreeVersion,
    upsertedConversation,
  } = useChatConversationContext();
  const [tree, setTree] = useState<ConversationTabTree | null>(null);
  const [runTreeVersion, setRunTreeVersion] = useState(0);

  useEffect(() => {
    const unsubscribe = window.snow.onSubAgentRunsChanged(() => {
      setRunTreeVersion((version) => version + 1);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!rootConversationId) {
      setTree(null);
      return;
    }
    let cancelled = false;
    void loadConversationTabTree(rootConversationId)
      .then((next) => {
        if (!cancelled) {
          setTree(next);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setTree(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    rootConversationId,
    conversationListVersion,
    conversationTreeVersion,
    runTreeVersion,
    upsertedConversation,
  ]);

  return tree;
};
