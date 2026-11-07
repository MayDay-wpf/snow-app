import { BrowserWindow, ipcMain } from "electron";
import { showAppNotification } from "../../notification/notificationManager";
import {
  isAppNotificationOptions,
  type AppNotificationResult,
} from "../../../shared/notification";
import { getMainWindow } from "../../app/mainWindow";

const SKIPPED_RESULT: AppNotificationResult = { shown: false, sound: null };

export const registerNotificationHandlers = (): void => {
  ipcMain.handle(
    "notification:show",
    async (event, options: unknown): Promise<AppNotificationResult> => {
      if (!isAppNotificationOptions(options)) {
        return SKIPPED_RESULT;
      }

      // 来源 webContents 无法解析（窗口销毁边缘竞态）时回退到当前主窗口。
      const sourceWindow =
        BrowserWindow.fromWebContents(event.sender) ?? getMainWindow();
      if (!sourceWindow || sourceWindow.isDestroyed()) {
        return SKIPPED_RESULT;
      }

      return showAppNotification(options, sourceWindow);
    },
  );
};
