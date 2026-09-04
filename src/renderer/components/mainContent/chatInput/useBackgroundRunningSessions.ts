import { useMemo } from "react";

import { getActiveWorkflowNodeIds } from "../chatMessages/workflow/workflowRunner";
import type {
  ConversationSessionRef,
  RefValue,
} from "../chatMessages/utils/conversationTypes";

/**
 * 统计当前会话树下正在后台运行的会话数（直接子代理 + WorkFlow 节点
 * 及其子代理），供输入区的"后台会话运行中"提醒条使用。
 *
 * 数据源全部为渲染进程内存态：
 * - streaming / attention 集合：本进程真实在跑或等待输入的会话；
 * - workflowRunner 的活跃节点注册表（getActiveWorkflowNodeIds）：本进程
 *   正在执行的 WorkFlow 节点会话；
 * - 父会话 / 节点会话 ref 上的 childSubAgentIds：激活时登记的子代理。
 *
 * 重启后内存集合为空，DB 残留的 running 记录不会被误报为"后台运行中"。
 * 非响应式注册表（activeNodeSessions / childSubAgentIds）的重算由
 * streaming/attention 集合的引用变化驱动：子代理/节点激活与收尾时必然
 * add/removeStreamingId，计数最终一致（激活登记先于 addStreamingId，
 * 窗口期首帧可能滞后一次渲染）。
 */
export const useBackgroundRunningSessions = (
  activeConversationId: string | undefined,
  streamingConversationIds: Set<string>,
  attentionRequiredConversationIds: Set<string>,
  sessionsRefData: RefValue<Map<string, ConversationSessionRef>>,
): number => {
  return useMemo(() => {
    if (!activeConversationId) {
      return 0;
    }
    // 等待用户输入（提问/工具授权）的会话同样算作后台活动：
    // 用户此时发消息会被排队/路由到等待中的会话，需要提醒
    const isActive = (id: string): boolean =>
      streamingConversationIds.has(id) ||
      attentionRequiredConversationIds.has(id);
    const sessionRefs = sessionsRefData.current;
    const running = new Set<string>();
    // 当前会话直接派生的子代理
    for (
      const id of sessionRefs.get(activeConversationId)?.childSubAgentIds ?? []
    ) {
      if (isActive(id)) {
        running.add(id);
      }
    }
    // 当前会话的 WorkFlow 节点，以及节点下派生的子代理
    for (const nodeId of getActiveWorkflowNodeIds(activeConversationId)) {
      running.add(nodeId);
      for (const id of sessionRefs.get(nodeId)?.childSubAgentIds ?? []) {
        if (isActive(id)) {
          running.add(id);
        }
      }
    }
    return running.size;
  }, [
    activeConversationId,
    streamingConversationIds,
    attentionRequiredConversationIds,
    sessionsRefData,
  ]);
};
