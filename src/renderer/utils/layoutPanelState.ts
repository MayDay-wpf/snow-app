/**
 * 左右面板展开/收起状态的全局记忆。
 *
 * 属于全局 UI 偏好（不区分项目与会话），持久化在 localStorage，
 * 应用下次启动时直接恢复。
 */
const STORAGE_KEY = "snow.layout.panel-collapsed";

export type PanelCollapsedState = {
  sidebar: boolean;
  rightPanel: boolean;
};

/** 读取全局记忆；没有持久化记录时返回 null，由调用方决定初次默认值。 */
export const readPanelCollapsedState = (): PanelCollapsedState | null => {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<PanelCollapsedState> | null;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return {
      sidebar: parsed.sidebar === true,
      rightPanel: parsed.rightPanel === true,
    };
  } catch {
    return null;
  }
};

export const writePanelCollapsedState = (state: PanelCollapsedState): void => {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 持久化失败时仅本次会话生效。
  }
};
