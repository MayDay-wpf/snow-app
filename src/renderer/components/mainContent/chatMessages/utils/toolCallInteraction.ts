import type { ToolCallInfo } from "./conversationTypes";

const ASK_TOOL_NAME = "user-interaction-askUserQuestion";
const SHARE_TOOL_NAME = "browser-request_share";

/**
 * 工具集合里是否有需要用户当场处理的内容（提问 / 待授权 / 共享确认）。
 *
 * 极简模式下集合默认收起，但这类卡片必须露出来：集合在等待期间强制展开，
 * 用户处理完（回答 / 授权 / 拒绝）后状态离开等待态，集合自动收回。
 */
export const hasPendingUserInteraction = (
  toolCalls: readonly ToolCallInfo[],
): boolean =>
  toolCalls.some((toolCall) => {
    if (toolCall.authorizationConversationId) {
      return true;
    }
    if (toolCall.name === ASK_TOOL_NAME) {
      return toolCall.userQuestion
        ? toolCall.userQuestion.status === "waiting"
        : toolCall.status === "pending" || toolCall.status === "running";
    }
    if (toolCall.name === SHARE_TOOL_NAME) {
      return toolCall.status === "pending" || toolCall.status === "running";
    }
    return false;
  });
