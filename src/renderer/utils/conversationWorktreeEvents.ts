/** 会话工作树绑定变化事件：会话列表与 Git 面板据此重新读取绑定。 */
export const CONVERSATION_WORKTREE_CHANGED_EVENT =
  "snow:conversation-worktree-changed";

export const notifyConversationWorktreeChanged = (): void => {
  window.dispatchEvent(new Event(CONVERSATION_WORKTREE_CHANGED_EVENT));
};
