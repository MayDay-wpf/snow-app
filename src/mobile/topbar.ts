import type { SnowRemoteState } from "../renderer/types/remoteControl";
import { $ } from "./dom";
import { t } from "./i18n";
import { showNotice } from "./notice";
import { createNewChat, findConversation } from "./threads";
import type { AppContext } from "./types";

/** 顶栏：侧边历史按钮、当前会话标题、工作区与运行状态徽标。 */
export const renderTopbar = (next: SnowRemoteState): void => {
  // 递归查找：活动会话可能是 Workflow 节点或子代理（树形子层），
  // 只查主列表会让标题退化为「新对话」。
  const active = findConversation(next, next.activeConversationId);
  // 子会话（Workflow 节点 / 子代理）没有 summary，展示名在 subAgentName 上。
  const title = active
    ? active.summary || active.subAgentName || active.title
    : t("remote.threads.newConversation");
  $("threadTitle").textContent = title || t("remote.threads.untitled");
  $("threadSubtitle").textContent = next.workspace
    ? next.workspace.name
    : t("remote.threads.noWorkspace");
  $("statusDot").className =
    "status-dot" + (next.isStreaming ? " running" : "");
};

export const initTopbar = (ctx: AppContext): void => {
  $("newChatButton").onclick = async () => {
    try {
      await createNewChat(ctx);
    } catch (error) {
      showNotice((error as Error).message, true);
    }
  };
};
