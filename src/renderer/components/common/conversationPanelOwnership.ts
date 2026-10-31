/**
 * 「会话面板」的会话归属注册表（渲染进程内，模块级）。
 *
 * 同一个会话在同一窗口里只应由一个聊天表面承载：会话被拖进右侧面板后，主内容区
 * 让出该会话（切到新会话），此后从侧边栏 / 通知 / 子代理入口选中该会话时改为
 * 聚焦承载它的面板 tab，而不是把主内容区也切过去 —— 与独立面板窗口的会话归属
 * 语义一致（见 useChatConversation 的 detachedOwnedIdsRef）。
 *
 * 放在 common 下是因为两侧都要用：右侧面板登记归属并订阅聚焦请求，会话运行时
 * 订阅归属变化并让出被接管的会话。
 */

/** conversationId -> 承载它的面板 tab id。 */
const panelOwners = new Map<string, string>();

type PanelConversationFocusListener = (
  conversationId: string,
  tabId: string,
) => void;
const focusListeners = new Set<PanelConversationFocusListener>();

type PanelConversationChangeListener = (conversationIds: Set<string>) => void;
const changeListeners = new Set<PanelConversationChangeListener>();

const notifyChange = (): void => {
  if (changeListeners.size === 0) {
    return;
  }
  const ownedIds = new Set(panelOwners.keys());
  for (const listener of changeListeners) {
    listener(ownedIds);
  }
};

/** 面板挂载时登记归属；返回注销函数（卸载或换绑时调用）。 */
export const registerPanelConversation = (
  conversationId: string,
  tabId: string,
): (() => void) => {
  panelOwners.set(conversationId, tabId);
  notifyChange();
  return () => {
    if (panelOwners.get(conversationId) === tabId) {
      panelOwners.delete(conversationId);
      notifyChange();
    }
  };
};

/** 该会话当前是否由某个会话面板承载。 */
export const isConversationOwnedByPanel = (conversationId: string): boolean =>
  panelOwners.has(conversationId);

/**
 * 请求聚焦承载某会话的面板 tab。返回 true 表示确实有面板承载（调用方据此
 * 放弃把主内容区切到该会话）；无面板承载时返回 false。
 *
 * 监听者拿到的是「承载它的 tab id」而不是会话 id：会话面板可以在同一个 tab 内
 * 切换展示的会话（子代理 / Workflow 节点），此时 tab id 与会话 id 并不相等。
 */
export const focusPanelConversation = (conversationId: string): boolean => {
  const tabId = panelOwners.get(conversationId);
  if (tabId === undefined) {
    return false;
  }
  for (const listener of focusListeners) {
    listener(conversationId, tabId);
  }
  return true;
};

/** 订阅聚焦请求（RightPanel 据此激活对应 tab 并展开面板）。 */
export const subscribePanelConversationFocus = (
  listener: PanelConversationFocusListener,
): (() => void) => {
  focusListeners.add(listener);
  return () => {
    focusListeners.delete(listener);
  };
};

/**
 * 订阅归属变化（会话运行时据此把主内容区让给面板：激活会话被面板接管时切到
 * 新会话，并释放本地缓存）。订阅时立即回调一次当前归属。
 */
export const subscribePanelConversationChange = (
  listener: PanelConversationChangeListener,
): (() => void) => {
  changeListeners.add(listener);
  listener(new Set(panelOwners.keys()));
  return () => {
    changeListeners.delete(listener);
  };
};
