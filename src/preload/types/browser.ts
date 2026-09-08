/**
 * 独立浏览器窗口「还原为标签页」：把窗口内实例（当前页面）还原回
 * 主窗口右侧面板的浏览器 tab（保持原 instanceId）。
 */

/** 还原请求载荷：实例 id + 当前页面的 URL 与标题。 */
export type BrowserRestorePayload = {
  instanceId: string;
  url: string;
  title: string;
};

/** 独立浏览器窗口内 guest 页面请求打开新标签页 → 主窗口新建浏览器 tab。 */
export type OpenBrowserTabInMainPayload = {
  url: string;
};
