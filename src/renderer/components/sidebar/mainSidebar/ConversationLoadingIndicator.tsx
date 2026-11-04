import { Snowflake } from "lucide-react";

/** 运行中的会话状态（子代理与 Workflow 节点共用 subAgentStatus 字段）。 */
export const isRunningConversationStatus = (status: string): boolean =>
  status === "running" || status === "finalizing" || status === "cancelling";

type ConversationLoadingIndicatorProps = {
  /** 悬浮/无障碍文案（与主会话一致：运行中） */
  label?: string;
  /** 额外类名，供不同容器微调位置 */
  className?: string;
};

/** 会话 loading：与主会话统一用雪花图标旋转，显示在标题之后 */
export function ConversationLoadingIndicator({
  label,
  className,
}: ConversationLoadingIndicatorProps): React.JSX.Element {
  return (
    <span
      className={`conversation-loading-indicator${className ? ` ${className}` : ""}`}
      title={label}
      aria-label={label}
    >
      <span className="snowflake-spin">
        <Snowflake size={11} aria-hidden="true" />
      </span>
    </span>
  );
}
