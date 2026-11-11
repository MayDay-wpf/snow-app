/**
 * 通用设置面板的 tab 导航入口。
 *
 * 侧栏「更新日志」需要直达通用设置面板的更新日志 tab：生产者先把目标 tab
 * 暂存在本模块，再派发窗口事件（侧栏据此切到设置内容页）。面板渲染时只读取
 * 暂存值作为初始 tab，挂载提交后才清空；已挂载时由事件监听切换 —— 事件先于
 * 面板挂载（懒加载分包）到达也不会丢失。独立成模块是为了避免侧栏静态引入
 * 设置面板（懒加载分包）。
 *
 * 读取与清空分开：首次进入设置页时渲染可能被 Suspense 挂起丢弃后重来，若在
 * 渲染阶段就清空暂存值，重来的那次渲染会退回默认 tab。
 */
export type GeneralSettingsTab =
  "general" | "storage" | "privacy" | "about" | "changelog";

/** 请求打开通用设置面板某个 tab 的窗口事件。 */
export const OPEN_GENERAL_SETTINGS_TAB_EVENT = "general-settings:open-tab";

/** 面板尚未挂载时暂存的目标 tab，被取走后清空。 */
let pendingTab: GeneralSettingsTab | null = null;

export const requestGeneralSettingsTab = (tab: GeneralSettingsTab): void => {
  pendingTab = tab;
  window.dispatchEvent(
    new CustomEvent<{ tab: GeneralSettingsTab }>(
      OPEN_GENERAL_SETTINGS_TAB_EVENT,
      { detail: { tab } },
    ),
  );
};

/** 读取暂存的目标 tab（不清空），供面板渲染阶段计算初始 tab。 */
export const peekGeneralSettingsTab = (): GeneralSettingsTab | null =>
  pendingTab;

/** 清空暂存的目标 tab，只在提交阶段（effect / 事件回调）调用。 */
export const clearGeneralSettingsTab = (): void => {
  pendingTab = null;
};
