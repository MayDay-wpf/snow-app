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

/** 运行期间可能需要用户在卡片内操作的工具（提问 / 共享 / 工作流 / 交互式终端）。 */
const INTERACTIVE_TOOL_NAMES = new Set([
  ASK_TOOL_NAME,
  SHARE_TOOL_NAME,
  "workflow-workflow-generate",
  "workflow-workflow-resume",
]);
const INTERACTIVE_BASH_PATTERN = /"isInteractive"\s*:\s*true/;

/**
 * 卡片本身是否必须露出来才能交互（内联提问 / 共享确认 / 工作流 / 交互式终端）。
 * 待授权不在此列：授权弹窗由列表层的授权行单独承载，卡片可以留在折叠集合里。
 */
export const needsVisibleToolCard = (toolCall: ToolCallInfo): boolean => {
  if (hasPendingUserInteraction([toolCall])) {
    return true;
  }
  if (toolCall.status !== "pending" && toolCall.status !== "running") {
    return false;
  }
  if (INTERACTIVE_TOOL_NAMES.has(toolCall.name)) {
    return true;
  }
  return (
    toolCall.name === "bash-terminal-execute" &&
    INTERACTIVE_BASH_PATTERN.test(toolCall.arguments ?? "")
  );
};

/**
 * 工具是否仍在等待用户处理：交互型工具未结算、或处于待授权列表中。
 */
export const isAwaitingUserAction = (
  toolCall: ToolCallInfo,
  pendingAuthorizationIds: ReadonlySet<string>,
): boolean =>
  Boolean(toolCall.authorizationConversationId) ||
  pendingAuthorizationIds.has(toolCall.interactionId) ||
  needsVisibleToolCard(toolCall);
