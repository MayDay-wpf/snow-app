import { APP_CONTROL_OPEN_SETTINGS_EVENT } from "../../../hooks/useAppControl";
import type { ApiSettingsTab } from "./types";

/** 跨页面跳转时携带的目标标签页：面板挂载时读取并消费，避免影响后续手动切换。 */
let pendingTab: ApiSettingsTab | null = null;

export const peekApiSettingsTab = (): ApiSettingsTab | null => pendingTab;

export const consumeApiSettingsTab = (): ApiSettingsTab | null => {
  const tab = pendingTab;
  pendingTab = null;
  return tab;
};

/** 打开 API 设置页并直达指定标签页。 */
export const openApiSettingsTab = (tab: ApiSettingsTab): void => {
  pendingTab = tab;
  window.dispatchEvent(
    new CustomEvent(APP_CONTROL_OPEN_SETTINGS_EVENT, {
      detail: { view: "api-settings" },
    }),
  );
};
