import { ChevronRight, CircleAlert, Loader2, Workflow } from "lucide-react";

import { useI18n } from "../../../i18n";
import type { ChatConversationRecord } from "../../../../preload";
import { isActiveWorkflowNodeSession } from "../../mainContent/chatMessages/workflow/workflowRunner";
import { SubAgentListPanel } from "./SubAgentListPanel";

type WorkflowNodeListPanelProps = {
  /** Workflow 节点会话列表（按创建顺序排列） */
  conversations: ChatConversationRecord[];
  activeConversationId?: string;
  /** 待用户确认的会话 id 集合（节点自身或其子代理等待输入/授权） */
  attentionRequiredConversationIds?: Set<string>;
  /** 流式输出中的会话 id 集合：节点仅在实际运行时显示 loading */
  streamingConversationIds?: Set<string>;
  /** 节点会话 -> 其子代理会话列表（层级：Workflow → 节点 → 子代理） */
  subAgentMap?: Record<string, ChatConversationRecord[]>;
  /** 已展开子代理列表的节点会话 id 集合 */
  expandedNodeIds?: Set<string>;
  onToggleNode?: (conversationId: string) => void;
  onSelect?: (conversationId: string) => void;
};

/**
 * 节点图标：静态状态使用 Workflow 图标（与子代理的 Bot 图标区分），
 * 运行中改用 Loader2 旋转指示器表达 loading；
 * 完成绿色 / 失败红色 / 待执行灰色 / 需关注黄色感叹号。
 */
function renderNodeIcon(
  runStatus: string,
  isAttentionRequired: boolean,
): React.ReactNode {
  if (isAttentionRequired) {
    return <CircleAlert size={11} className="sub-agent-attention" />;
  }
  if (runStatus === "running") {
    return <Loader2 size={11} className="spin workflow-node-status-running" />;
  }
  const statusClass =
    runStatus === "completed"
      ? "workflow-node-status-completed"
      : runStatus === "failed"
        ? "workflow-node-status-failed"
        : runStatus === "pending"
          ? "workflow-node-status-pending"
          : "";
  return <Workflow size={11} className={statusClass} />;
}

/**
 * WorkFlow 节点列表面板：挂在 Workflow 主会话下，展示该 Workflow 的节点
 * 会话（每个节点是一个真实主会话）。节点运行期间可能派生子代理，此时
 * 节点项可展开，内嵌 SubAgentListPanel 展示其子代理，形成
 * Workflow 主会话 → 节点 → 子代理 的树形层级。
 */
export function WorkflowNodeListPanel({
  conversations,
  activeConversationId,
  attentionRequiredConversationIds,
  streamingConversationIds,
  subAgentMap,
  expandedNodeIds,
  onToggleNode,
  onSelect,
}: WorkflowNodeListPanelProps): React.JSX.Element {
  const { t } = useI18n();

  const handleItemClick = (
    event: React.MouseEvent,
    conversationId: string,
  ): void => {
    // 面板是独立交互区域，阻止点击事件继续冒泡
    event.stopPropagation();
    onSelect?.(conversationId);
  };

  const attentionDescription = t("sidebar.chatStatusWaitingForReviewOrInput", {
    defaultValue: "Waiting for review or input",
  });

  return (
    <div className="workflow-node-list-panel">
      {conversations.map((node) => {
        const subAgents = subAgentMap?.[node.conversationId] ?? [];
        const isExpanded = expandedNodeIds?.has(node.conversationId) ?? false;
        const isAttentionRequired =
          attentionRequiredConversationIds?.has(node.conversationId) ?? false;
        const hasAttentionSubAgent = subAgents.some((sub) =>
          attentionRequiredConversationIds?.has(sub.conversationId),
        );
        const isStreaming =
          streamingConversationIds?.has(node.conversationId) ?? false;
        // 节点活跃判定：streaming 集合为主，workflowRunner 模块级活跃
        // 注册表兜底，覆盖"续跑接管窗口期"（DB 已转 running、注册时序上
        // 先于 addStreamingId 的间隙）。手动中止后注册表与 streaming 集合
        // 均先移除、侧边栏重查落库转 failed 前，两者皆不命中 → 不显示
        // loading；重启后的僵尸 running 同样不命中（与画布降级语义一致）。
        const isNodeActive =
          isStreaming || isActiveWorkflowNodeSession(node.conversationId);
        // 兜底：DB 中 run_status 仍为 running 但节点已不再活跃
        //（用户手动中止后、侧边栏重查落盘前的窗口期），不再显示 loading
        const displayStatus =
          node.subAgentStatus === "running" && !isNodeActive
            ? ""
            : node.subAgentStatus;
        const nodeName =
          node.subAgentName ||
          node.title ||
          t("sidebar.workflowNode", { defaultValue: "Workflow node" });
        return (
          <div key={node.conversationId}>
            <div
              className={`workflow-node-list-item${
                node.conversationId === activeConversationId ? " active" : ""
              }`}
              onClick={(event) => handleItemClick(event, node.conversationId)}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  event.stopPropagation();
                  onSelect?.(node.conversationId);
                }
              }}
            >
              {subAgents.length > 0 && (
                <span
                  className="workflow-node-expand-toggle"
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggleNode?.(node.conversationId);
                  }}
                  role="button"
                  tabIndex={-1}
                  aria-expanded={isExpanded}
                >
                  <ChevronRight
                    size={11}
                    className={isExpanded ? "expanded" : ""}
                  />
                </span>
              )}
              <span className="workflow-node-list-icon">
                {renderNodeIcon(
                  displayStatus,
                  isAttentionRequired || hasAttentionSubAgent,
                )}
              </span>
              <span className="workflow-node-list-name">{nodeName}</span>
              {(isAttentionRequired || hasAttentionSubAgent) && (
                <span
                  className="chat-item-status-label attention-required"
                  title={attentionDescription}
                  aria-label={attentionDescription}
                >
                  {t("sidebar.chatStatusNeedsAction", {
                    defaultValue: "Needs action",
                  })}
                </span>
              )}
            </div>
            {isExpanded && subAgents.length > 0 && (
              <SubAgentListPanel
                conversations={subAgents}
                activeConversationId={activeConversationId}
                attentionRequiredConversationIds={
                  attentionRequiredConversationIds
                }
                onSelect={onSelect}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
