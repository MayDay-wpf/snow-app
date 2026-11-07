import { app, BrowserWindow, Notification } from "electron";
import type {
  AppNotificationOptions,
  AppNotificationResult,
  AppNotificationSound,
  NotificationConversationTarget,
  NotificationSettings,
} from "../../shared/notification";
import { APP_ICON_PATH, isMacOS, isWindows } from "../app/constants";
import { createWindow, getMainWindow } from "../app/mainWindow";
import { safeSend } from "../utils/safeSend";
import { readNotificationSettings } from "./notificationSettings";

/**
 * 跨平台系统通知模块。
 *
 * Electron 的 Notification API 本身已封装平台差异：
 * - macOS: 原生通知中心 (Notification Center)
 * - Windows: Toast 通知
 * - Linux: libnotify / freedesktop.org 通知规范
 *
 * 本模块在此基础上增加：
 * 1. 窗口聚焦检测 — 默认用户正在看应用时不弹通知（可在设置里改为始终通知）
 * 2. 提示音解析 — 系统默认 / 内置提示音 / 自定义 MP3，交由渲染进程播放
 * 3. 不支持通知时的 fallback — 闪烁任务栏 (Windows) / Dock bounce (macOS)
 * 4. 通知点击后恢复准确来源窗口并发送激活目标
 */

const MAX_RETAINED_NOTIFICATIONS = 100;
const retainedNotifications: Notification[] = [];

const isAnyWindowFocused = (): boolean =>
  BrowserWindow.getAllWindows().some(
    (win) => !win.isDestroyed() && win.isVisible() && win.isFocused(),
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

// 通知点击时暂存的激活目标：原窗口已销毁（macOS 关闭窗口后点击通知中心
// 历史通知）或渲染 frame 正在刷新导致消息无法送达时，待新窗口/页面加载完成
// 后补发，保证「打开窗口 + 跳转到对应会话」仍能完成。
let pendingActivationTarget: NotificationConversationTarget | null = null;

const showAndFocusWindow = (window: BrowserWindow): void => {
  if (window.isDestroyed()) {
    return;
  }
  if (window.isMinimized()) {
    window.restore();
  }
  if (!window.isVisible()) {
    window.show();
  }

  if (isWindows) {
    // 绕过 Windows 前台锁定：临时置顶强制聚焦，再延迟恢复
    window.setAlwaysOnTop(true);
    window.focus();
    setTimeout(() => {
      if (!window.isDestroyed()) {
        window.setAlwaysOnTop(false);
      }
    }, 1000);
  } else {
    window.focus();
  }
};

const deliverPendingActivation = (window: BrowserWindow): void => {
  if (!pendingActivationTarget) {
    return;
  }
  const target = pendingActivationTarget;
  pendingActivationTarget = null;
  if (window.isDestroyed() || window.webContents.isDestroyed()) {
    return;
  }
  safeSend(window.webContents, "notification:activated", target);
};

// 统一发送入口：目标 webContents 尚未加载完成或发送失败（frame 刷新中）
// 时暂存激活目标，待 did-finish-load 后补发，避免激活目标静默丢失。
const sendOrDeferActivation = (
  window: BrowserWindow,
  target: NotificationConversationTarget,
): void => {
  if (window.isDestroyed()) {
    return;
  }
  if (window.webContents.isLoading()) {
    pendingActivationTarget = target;
    window.webContents.once("did-finish-load", () => {
      deliverPendingActivation(window);
    });
    return;
  }
  const sent = safeSend(window.webContents, "notification:activated", target);
  if (!sent) {
    pendingActivationTarget = target;
    window.webContents.once("did-finish-load", () => {
      deliverPendingActivation(window);
    });
  }
};

const activateSourceWindow = async (
  sourceWindow: BrowserWindow,
  target: NotificationConversationTarget | undefined,
): Promise<void> => {
  if (isMacOS && app.dock) {
    try {
      await app.dock.show();
    } catch (error) {
      console.warn("[notification] Failed to show macOS Dock", error);
    }
  }

  // 原窗口已销毁（macOS 关闭窗口后进程仍存活，通知中心历史通知仍可点击）：
  // 优先复用当前主窗口；没有则重建，并在渲染进程加载完成后补发激活目标。
  if (sourceWindow.isDestroyed()) {
    const current = getMainWindow();
    if (current) {
      showAndFocusWindow(current);
      if (target) {
        sendOrDeferActivation(current, target);
      }
      return;
    }

    let rebuilt: BrowserWindow;
    try {
      rebuilt = createWindow();
    } catch (error) {
      console.error("[notification] Failed to recreate the main window", error);
      return;
    }
    if (target) {
      sendOrDeferActivation(rebuilt, target);
      rebuilt.once("closed", () => {
        pendingActivationTarget = null;
      });
    }
    return;
  }

  showAndFocusWindow(sourceWindow);

  if (target) {
    sendOrDeferActivation(sourceWindow, target);
  }
};

/**
 * 解析应用内需要播放的提示音。
 *
 * 系统默认音效由系统通知自带，静音则两者都不播放；
 * 只有内置音效 / 自定义 MP3 才需要渲染进程配合播放。
 */
const resolveAppSound = (
  settings: NotificationSettings,
  options: AppNotificationOptions,
): AppNotificationSound | null => {
  if (options.silent) {
    return null;
  }

  switch (settings.sound) {
    case "custom":
      return settings.customSoundPath
        ? { kind: "custom", path: settings.customSoundPath }
        : null;
    case "system":
    case "none":
      return null;
    default:
      return { kind: "preset", preset: settings.sound };
  }
};

export const showAppNotification = async (
  options: AppNotificationOptions,
  sourceWindow: BrowserWindow,
): Promise<AppNotificationResult> => {
  const settings = await readNotificationSettings();

  // 窗口已聚焦时用户能直接看到 UI，默认不弹通知；设置里可改为始终通知。
  // 显式 ignoreFocus 的通知（例如资源告警）始终保持开启。
  if (
    !options.ignoreFocus &&
    !settings.notifyWhenFocused &&
    isAnyWindowFocused()
  ) {
    return { shown: false, sound: null };
  }

  const sound = resolveAppSound(settings, options);

  // 不支持系统通知时的降级方案：仅闪烁任务栏 / bounce dock
  if (!Notification.isSupported()) {
    flashTaskbar(sourceWindow);
    bounceDock();
    return { shown: true, sound };
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
    // 选了内置/自定义提示音时关闭系统音，避免与渲染进程播放的提示音重复。
    silent: options.silent ?? settings.sound !== "system",
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

  return { shown: true, sound };
};
