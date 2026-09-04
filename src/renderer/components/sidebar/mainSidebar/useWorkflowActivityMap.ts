import { useMemo } from "react";

import type { ChatConversationRecord } from "../../../../preload";
import { isActiveWorkflowNodeSession } from "../../mainContent/chatMessages/workflow/workflowRunner";

export type WorkflowActivity = {
  running: number;
  attention: number;
};

type ParentMap = Record<string, ChatConversationRecord[]>;

/**
 * 汇总每个 Workflow 主会话的后台活动计数（运行中节点 + 节点下的子代理），
 * 供主会话 ChatItem 徽标、图标亮点与"运行中置顶"排序（surfaced）使用。
 *
 * 运行判定口径：
 * - 节点：DB run_status=running 且（streaming 集合命中或 workflowRunner
 *   活跃注册表命中）。注册表兜底覆盖"续跑接管窗口期"（DB 已落 running、
 *   addStreamingId 尚未执行的间隙）；重启后的僵尸 running（DB running 但
 *   进程已死）两处都不命中，不会误报。
 * - 子代理：DB running 且非 attention，与 ChatItem 直接子代理计数同语义
 *   （子代理由 subAgentActivation 收尾落库，无注册表可查）。
 */
export const useWorkflowActivityMap = (
  workflowNodeMap: ParentMap,
  subAgentMap: ParentMap,
  streamingConversationIds: Set<string>,
  attentionRequiredConversationIds: Set<string>,
): Record<string, WorkflowActivity> => {
  return useMemo(() => {
    const map: Record<string, WorkflowActivity> = {};
    for (const [parentId, nodes] of Object.entries(workflowNodeMap)) {
      let running = 0;
      let attention = 0;
      for (const node of nodes) {
        if (attentionRequiredConversationIds.has(node.conversationId)) {
          attention += 1;
        } else if (
          node.subAgentStatus === "running" &&
          (streamingConversationIds.has(node.conversationId) ||
            isActiveWorkflowNodeSession(node.conversationId))
        ) {
          running += 1;
        }
        // 节点下派生的子代理同样计入主会话的后台活动
        for (const sub of subAgentMap[node.conversationId] ?? []) {
          if (attentionRequiredConversationIds.has(sub.conversationId)) {
            attention += 1;
          } else if (sub.subAgentStatus === "running") {
            running += 1;
          }
        }
      }
      if (running > 0 || attention > 0) {
        map[parentId] = { running, attention };
      }
    }
    return map;
  }, [
    workflowNodeMap,
    subAgentMap,
    streamingConversationIds,
    attentionRequiredConversationIds,
  ]);
};
