import { Bot, CircleAlert, Loader2 } from "lucide-react";

import { useI18n } from "../../../i18n";
import type { ChatConversationRecord } from "../../../../preload";
import { useChatConversationContext } from "../../mainContent/chatMessages";

type SubAgentListPanelProps = {
  conversations: ChatConversationRecord[];
  /** 待用户确认的子代理会话 id 集合（提问或工具授权） */
  attentionRequiredConversationIds?: Set<string>;
  onSelect?: (conversationId: string) => void;
};

/**
 * 子代理图标：静态状态使用 Bot 象形图标（与 Workflow 节点图标区分），
 * 运行中改用 Loader2 旋转指示器；完成绿色 / 失败红色 / 待执行灰色 /
 * 需关注黄色感叹号，与 Workflow 节点保持同一套状态配色。
 */
function renderStatusIcon(
  status: string,
  isAttentionRequired: boolean,
): React.ReactNode {
  if (isAttentionRequired || status === "waiting_input") {
    return <CircleAlert size={11} className="sub-agent-attention" />;
  }
  if (
    status === "running" ||
    status === "finalizing" ||
    status === "cancelling"
  ) {
    return (
      <span className="spin-layer">
        <Loader2 size={11} className="sub-agent-status-running" />
      </span>
    );
  }
  const statusClass =
    status === "completed"
      ? "sub-agent-status-completed"
      : status === "failed" || status === "interrupted"
        ? "sub-agent-status-failed"
        : status === "pending" || status === "queued"
          ? "sub-agent-status-pending"
          : "";
  return <Bot size={11} className={statusClass} />;
}

/**
 * 子代理列表面板：独立的自包含面板，拥有自己的表面背景，
 * 不依赖父级会话项的选中/悬停状态，避免嵌套背景互相冲突。
 *
 * 注意：子代理会话不允许单独删除（随父会话级联删除），
 * 因此不参与多选批量删除，列表项仅支持点击打开会话。
 */
export function SubAgentListPanel({
  conversations,
  attentionRequiredConversationIds,
  onSelect,
}: SubAgentListPanelProps): React.JSX.Element {
  const { t } = useI18n();
  // 活动会话 id 直接从会话上下文读取（而不是由每个会话项透传）：它变化时只让
  // 这些正在渲染的面板重渲染，不会波及整张侧边栏列表的每一行。
  const { activeConversationId } = useChatConversationContext();

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
    <div className="sub-agent-list-panel">
      {conversations.map((subAgent) => {
        const isAttentionRequired =
          subAgent.subAgentStatus === "waiting_input" ||
          (attentionRequiredConversationIds?.has(subAgent.conversationId) ??
            false);
        const summaryLabel = subAgent.summary || subAgent.title;
        const agentLabel = subAgent.subAgentName;
        return (
          <div
            key={subAgent.conversationId}
            className={`sub-agent-list-item${
              subAgent.conversationId === activeConversationId ? " active" : ""
            }`}
            onClick={(event) => handleItemClick(event, subAgent.conversationId)}
            role="button"
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                event.stopPropagation();
                onSelect?.(subAgent.conversationId);
              }
            }}
          >
            <span className="sub-agent-list-icon">
              {renderStatusIcon(subAgent.subAgentStatus, isAttentionRequired)}
            </span>
            <span className="sub-agent-list-name-row">
              <span className="sub-agent-list-name" title={summaryLabel}>
                {summaryLabel ||
                  agentLabel ||
                  t("sidebar.subAgent", { defaultValue: "Sub-agent" })}
              </span>
              {isAttentionRequired && (
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
            </span>
          </div>
        );
      })}
    </div>
  );
}
