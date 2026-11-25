import type { ConversationNavigationOutcome } from "../hooks/useConversationNavigation";

export const PLUGIN_INSERT_INPUT_TEXT_EVENT = "snow:plugin-insert-input-text";

export const PLUGIN_SEND_INPUT_MESSAGE_EVENT = "snow:plugin-send-input-message";

export const PLUGIN_ACTIVATE_CONVERSATION_EVENT =
  "snow:plugin-activate-conversation";

export const PLUGIN_OPEN_SETTINGS_EVENT = "app-control:open-settings";

export const PLUGIN_CONVERSATION_LIST_CHANGED_EVENT =
  "snow:plugin-conversation-list-changed";

/** 程序化发送改写了会话内存态输入选择，查看该会话的输入区需重新取值。 */
export const CONVERSATION_INPUT_STATE_CHANGED_EVENT =
  "snow:conversation-input-state-changed";

export const notifyConversationInputStateChanged = (
  conversationId: string,
): void => {
  window.dispatchEvent(
    new CustomEvent(CONVERSATION_INPUT_STATE_CHANGED_EVENT, {
      detail: { conversationId },
    }),
  );
};

export type PluginConversationListChangedDetail = {
  /** 由监听方在同步回调中置为 true，表示宿主会话列表已接管刷新。 */
  handled: boolean;
};

/**
 * 通知宿主会话列表已被写动作修改。宿主刷新侧栏列表后会经
 * conversationListVersion 再推进插件的 conversationListRevision；
 * 返回 false 表示当前窗口没有会话宿主监听。
 */
export const notifyConversationListChanged = (): boolean => {
  const detail: PluginConversationListChangedDetail = { handled: false };
  window.dispatchEvent(
    new CustomEvent(PLUGIN_CONVERSATION_LIST_CHANGED_EVENT, { detail }),
  );
  return detail.handled;
};

export type PluginActivateConversationDetail = {
  conversationId: string;
  directoryId: string;
  /** 由监听方在同步回调中置为 true，表示导航桥已接收请求。 */
  accepted: boolean;
  settle: (outcome: ConversationNavigationOutcome) => void;
};

/**
 * 请求切换到指定会话（跨项目时自动切换项目）。导航桥未挂载时没有监听方，
 * 直接拒绝而不是悬挂等待。
 */
export const requestConversationActivation = (target: {
  conversationId: string;
  directoryId: string;
}): Promise<ConversationNavigationOutcome> =>
  new Promise((resolve, reject) => {
    const detail: PluginActivateConversationDetail = {
      ...target,
      accepted: false,
      settle: resolve,
    };
    window.dispatchEvent(
      new CustomEvent(PLUGIN_ACTIVATE_CONVERSATION_EVENT, { detail }),
    );
    if (!detail.accepted) {
      reject(new Error("Conversation navigation is not ready"));
    }
  });
