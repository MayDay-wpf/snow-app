import { BrowserWindow, ipcMain } from "electron";
import { showAppNotification } from "../../notification/notificationManager";
import { isAppNotificationOptions } from "../../../shared/notification";

export const registerNotificationHandlers = (): void => {
  ipcMain.handle("notification:show", (event, options: unknown) => {
    if (!isAppNotificationOptions(options)) {
      return;
    }

    const sourceWindow = BrowserWindow.fromWebContents(event.sender);
    if (!sourceWindow || sourceWindow.isDestroyed()) {
      return;
    }

    showAppNotification(options, sourceWindow);
  });
};
