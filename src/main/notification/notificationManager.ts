import { app, BrowserWindow, Notification } from "electron";
import type {
  AppNotificationOptions,
  NotificationConversationTarget,
} from "../../shared/notification";
import { APP_ICON_PATH, isMacOS } from "../app/constants";
import { safeSend } from "../utils/safeSend";

/**
 * 跨平台系统通知模块。
 *
 * Electron 的 Notification API 本身已封装平台差异：
 * - macOS: 原生通知中心 (Notification Center)
 * - Windows: Toast 通知
 * - Linux: libnotify / freedesktop.org 通知规范
 *
 * 本模块在此基础上增加：
 * 1. 窗口聚焦检测 — 用户正在看应用时不弹通知，避免打扰
 * 2. 不支持通知时的 fallback — 闪烁任务栏 (Windows) / Dock bounce (macOS)
 * 3. 通知点击后恢复准确来源窗口并发送激活目标
 */

const MAX_RETAINED_NOTIFICATIONS = 100;
const retainedNotifications: Notification[] = [];

const isAnyWindowFocused = (): boolean =>
  BrowserWindow.getAllWindows().some(
    (win) => !win.isDestroyed() && win.isVisible() && win.isFocused()
  );

const flashTaskbar = (window: BrowserWindow): void => {
  if (window.isDestroyed() || window.isFocused()) {
    return;
  }

  window.flashFrame(true);
  // 窗口获得焦点后停止闪烁
  const stopFlash = (): void => {
    if (!window.isDestroyed()) {
      window.flashFrame(false);
    }
    window.removeListener("focus", stopFlash);
  };
  window.once("focus", stopFlash);
};

const bounceDock = (): void => {
  if (process.platform === "darwin" && app.dock) {
    app.dock.bounce("informational");
  }
};

const retainNotification = (notification: Notification): void => {
  retainedNotifications.push(notification);
  if (retainedNotifications.length > MAX_RETAINED_NOTIFICATIONS) {
    retainedNotifications.shift();
  }
};

const releaseNotification = (notification: Notification): void => {
  const index = retainedNotifications.indexOf(notification);
  if (index >= 0) {
    retainedNotifications.splice(index, 1);
  }
};

const activateSourceWindow = async (
  sourceWindow: BrowserWindow,
  target: NotificationConversationTarget | undefined
): Promise<void> => {
  if (isMacOS && app.dock) {
    try {
      await app.dock.show();
    } catch (error) {
      console.warn("[notification] Failed to show macOS Dock", error);
    }
  }

  if (sourceWindow.isDestroyed()) {
    return;
  }
  if (!sourceWindow.isVisible()) {
    sourceWindow.show();
  }
  if (sourceWindow.isMinimized()) {
    sourceWindow.restore();
  }
  sourceWindow.focus();

  if (target) {
    safeSend(sourceWindow.webContents, "notification:activated", target);
  }
};

export const showAppNotification = (
  options: AppNotificationOptions,
  sourceWindow: BrowserWindow
): void => {
  // 窗口已聚焦时用户能直接看到 UI，不需要系统通知
  if (isAnyWindowFocused()) {
    return;
  }

  // 不支持系统通知时的降级方案：仅闪烁任务栏 / bounce dock
  if (!Notification.isSupported()) {
    flashTaskbar(sourceWindow);
    bounceDock();
    return;
  }

  // macOS 通知左上角的发送方图标由系统从进程 bundle 自动读取，
  // 代码无法干预（preview 模式下显示 Electron 图标属正常现象，打包后为 Snow App）。
  // 若再传入 icon 选项，系统会在通知正文里额外渲染一张缩略图，
  // 导致出现"左上角应用图标 + 正文内图标"两个图标叠加，因此 macOS 下不设置 icon。
  // Windows / Linux 的通知则依赖显式 icon 显示应用标识，必须传入。
  const notification = new Notification({
    title: options.title,
    body: options.body,
    ...(isMacOS ? {} : { icon: APP_ICON_PATH }),
    silent: options.silent ?? false,
  });

  notification.on("click", () => {
    void activateSourceWindow(sourceWindow, options.target)
      .catch((error: unknown) => {
        console.error("[notification] Failed to activate source window", error);
      })
      .finally(() => {
        releaseNotification(notification);
      });
  });

  retainNotification(notification);
  notification.show();

  // 额外的注意力信号
  flashTaskbar(sourceWindow);
  bounceDock();
};
