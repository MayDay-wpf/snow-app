import {
  BrowserWindow,
  ipcMain,
  nativeTheme,
  shell,
  WebContents,
} from "electron";
import { is } from "@electron-toolkit/utils";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  APP_ICON_PATH,
  APP_WINDOW_ICON_PATH,
  isMacOS,
  isWindows,
  macTrafficLightPosition,
} from "./constants";
import { killAllPtyForWebContents } from "../pty/ptyManager";
import { initAutoUpdater } from "../updater/autoUpdater";
import {
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_WIDTH,
  bindWindowStatePersistence,
  isStatePositionVisible,
  loadWindowState,
} from "./windowState";
import { safeSend } from "../utils/safeSend";
import { snowLog } from "../../utils/snowLogger";
import { closeAllBrowserPopups } from "../browser/browserPopupWindow";
import { closeAllDetachedBrowserWindows } from "../browser/browserWindow";

// 模块级关闭确认标志：渲染进程确认关闭后置为 true，使 close 事件不再被拦截。
// 这样可以统一覆盖所有关闭路径（自定义标题栏按钮、Alt+F4、任务栏关闭等）。
let closeConfirmed = false;

export const markCloseConfirmed = (): void => {
  closeConfirmed = true;
};

export const isCloseConfirmed = (): boolean => closeConfirmed;

// 模块级主窗口引用：供其他模块（如宠物窗口定位）读取主窗口位置/尺寸。
// macOS 上主窗口关闭后重建，因此引用在 closed 时清空、重建时更新。
let mainWindowRef: BrowserWindow | null = null;

// ===== 缩窄方向检测 =====
// 记录上一次窗口 bounds，比较 x 与右边缘（x+width）的变化来判定用户拖的是
// 哪条边：左边缘拖动 → x 变化而右边缘不动；右边缘拖动 → x 不动而右边缘变化。
// 渲染进程据此在窗口缩窄时自动收起对应侧面板，聊天区可缩窄到手机尺寸。
let lastResizeBounds: { x: number; width: number } | null = null;

const bindResizeEdgeDetection = (win: BrowserWindow): void => {
  const resetResizeBaseline = (): void => {
    lastResizeBounds = null;
  };

  win.on("resize", () => {
    // 最大化/全屏切换时 x/width 会整体跳变，无法判定方向，重置基线后忽略。
    if (win.isDestroyed() || win.isMaximized() || win.isFullScreen()) {
      resetResizeBaseline();
      return;
    }
    const bounds = win.getBounds();
    const prev = lastResizeBounds;
    lastResizeBounds = { x: bounds.x, width: bounds.width };
    if (!prev) {
      return;
    }
    const xDelta = bounds.x - prev.x;
    const rightEdgeDelta = bounds.x + bounds.width - (prev.x + prev.width);
    let edge: "left" | "right" | null = null;
    if (xDelta !== 0 && rightEdgeDelta === 0) {
      edge = "left";
    } else if (xDelta === 0 && rightEdgeDelta !== 0) {
      edge = "right";
    } else {
      // 移动窗口（x 变而宽度不变）或程序化调整等无法判定方向的场景，忽略。
      return;
    }
    safeSend(win.webContents, "window:resize-edge-changed", {
      edge,
      contentWidth: win.getContentBounds().width,
    });
  });

  win.on("maximize", resetResizeBaseline);
  win.on("unmaximize", resetResizeBaseline);
  win.on("enter-full-screen", resetResizeBaseline);
  win.on("leave-full-screen", resetResizeBaseline);
};

/** 获取当前主窗口（已销毁时返回 null）。 */
export const getMainWindow = (): BrowserWindow | null =>
  mainWindowRef && !mainWindowRef.isDestroyed() ? mainWindowRef : null;

// 缓存当前主题对应的主背景色，供窗口创建和 nativeTheme 变化时使用。
// 由渲染进程保存主题设置后通过 IPC 同步，避免每次都异步读取 Rust 后端。
let cachedThemeBgPrimary: string | null = null;

const resolveThemeBackgroundColor = (): string => {
  // 优先使用渲染进程同步过来的主题 bgPrimary；否则回退到 nativeTheme 判断。
  if (cachedThemeBgPrimary) {
    return cachedThemeBgPrimary;
  }
  return nativeTheme.shouldUseDarkColors ? "#0a0a0a" : "#ffffff";
};

const getWindowBackgroundColor = (): string => resolveThemeBackgroundColor();

// 渲染进程保存主题后调用此 IPC，同步当前生效的 bgPrimary 到主进程，
// 使窗口背景色与渲染层主题保持一致，消除启动/切换时的白闪。
const registerThemeBackgroundSync = (): void => {
  ipcMain.handle("theme:set-background-color", (_event, color: unknown) => {
    if (typeof color === "string" && color.trim()) {
      cachedThemeBgPrimary = color.trim();
    } else {
      cachedThemeBgPrimary = null;
    }
    return Promise.resolve();
  });
};

// 在模块加载时注册一次主题背景色同步 IPC。
registerThemeBackgroundSync();

// DevTools 独立窗口由 Chromium 内部管理，默认显示 DevTools 默认图标而非应用图标。
// Electron 的 DevTools 窗口同样关联了 owner BrowserWindow（NativeWindowViews），
// 因此在 devtools-opened 时通过 fromWebContents 取到 DevTools 窗口并设置 Snow 图标，
// 使 DevTools 窗口的标题栏 / 任务栏图标与应用保持一致（仅 Windows/Linux 生效）。
const applyDevToolsSnowIcon = (contents: WebContents): void => {
  contents.on("devtools-opened", () => {
    if (isMacOS) {
      return;
    }
    const devToolsContents = contents.devToolsWebContents;
    if (!devToolsContents || devToolsContents.isDestroyed()) {
      return;
    }
    const devToolsWindow = BrowserWindow.fromWebContents(devToolsContents);
    if (devToolsWindow && !devToolsWindow.isDestroyed()) {
      try {
        devToolsWindow.setIcon(APP_WINDOW_ICON_PATH);
      } catch {
        // 窗口已关闭等竞态场景下忽略，下次打开 DevTools 时会重新设置。
      }
    }
  });
};

export const createWindow = (): BrowserWindow => {
  // macOS 关闭窗口后进程不退出，用户点击 dock 图标会重新 createWindow。
  // 此时需重置 closeConfirmed，使新窗口关闭时仍弹出二次确认。
  closeConfirmed = false;

  // 启动时同步读取上次保存的窗口尺寸/位置（~100B JSON，无阻塞风险）；
  // 读取失败时回退到默认尺寸。
  const savedState = loadWindowState();
  const restoredPosition =
    savedState && isStatePositionVisible(savedState)
      ? { x: savedState.x, y: savedState.y }
      : {};

  const mainWindow = new BrowserWindow({
    width: savedState?.width ?? DEFAULT_WINDOW_WIDTH,
    height: savedState?.height ?? DEFAULT_WINDOW_HEIGHT,
    ...restoredPosition,
    minWidth: 360,
    minHeight: 600,
    title: "Snow App",
    icon: APP_ICON_PATH,
    titleBarStyle: isMacOS ? "hidden" : "default",
    frame: isMacOS || isWindows ? false : true,
    ...(isMacOS ? { trafficLightPosition: macTrafficLightPosition } : {}),
    autoHideMenuBar: true,
    backgroundColor: getWindowBackgroundColor(),
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.mjs"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      spellcheck: false,
      // The scheduler lives in this renderer. Keep its timers and IPC event
      // loop active when the main window is minimized or unfocused.
      backgroundThrottling: false,
    },
  });
  mainWindowRef = mainWindow;

  mainWindow.setMenu(null);
  mainWindow.setMenuBarVisibility(false);
  mainWindow.setAutoHideMenuBar(true);

  // 恢复上次退出时的最大化状态。
  if (savedState?.isMaximized) {
    mainWindow.maximize();
  }

  // 主窗口自身的 DevTools（如 F12）也应用 Snow 图标。
  applyDevToolsSnowIcon(mainWindow.webContents);

  // 监听尺寸/位置/最大化状态变化，防抖后持久化到 userData。
  bindWindowStatePersistence(mainWindow);

  // 监听缩窄方向（左/右边缘），推送 window:resize-edge-changed 供渲染层
  // 自动收起对应侧面板；聊天区可缩窄到手机尺寸。
  bindResizeEdgeDetection(mainWindow);

  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (is.dev && input.key === "F12") {
      event.preventDefault();
      mainWindow.webContents.toggleDevTools();
      return;
    }

    if (
      input.key === "Alt" ||
      input.code === "AltLeft" ||
      input.code === "AltRight"
    ) {
      event.preventDefault();
    }
  });

  nativeTheme.on("updated", () => {
    mainWindow.setBackgroundColor(getWindowBackgroundColor());
  });

  // Windows: 通知渲染进程窗口最大化状态变化（自定义标题栏需要同步图标）
  if (isWindows) {
    const notifyMaximizeState = (): void => {
      safeSend(
        mainWindow.webContents,
        "window:maximize-state-changed",
        mainWindow.isMaximized(),
      );
    };
    mainWindow.on("maximize", notifyMaximizeState);
    mainWindow.on("unmaximize", notifyMaximizeState);
  }

  // Clean up PTY sessions before window is fully destroyed.
  // 所有平台关闭窗口时均需二次确认：Windows/Linux 关闭即退出进程，
  // macOS 关闭虽不退出进程但会卸载活动页面，效果与关闭无异。
  mainWindow.on("close", (event) => {
    if (!isCloseConfirmed()) {
      event.preventDefault();
      safeSend(mainWindow.webContents, "window:close-requested");
      return;
    }
    killAllPtyForWebContents(mainWindow.webContents);
  });

  // 主窗口真正关闭后清理浏览器弹出窗口：Windows/Linux 上进程即将退出，
  // macOS 上则避免关闭主窗口后残留孤儿弹出窗口。
  mainWindow.on("closed", () => {
    mainWindowRef = null;
    closeAllBrowserPopups();
    closeAllDetachedBrowserWindows();
  });

  // 渲染进程异常退出（崩溃/被系统回收）时自动重新加载，避免前端黑屏卡死。
  // 崩溃细节记录到应用日志便于排查；reload 后 preload/React 会重新初始化。
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    snowLog.error({
      module: "app/mainWindow",
      func: "render-process-gone",
      message: "Renderer process gone, reloading window",
      context: JSON.stringify(details),
    });
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.reload();
    }
  });

  // 渲染进程每次主框架导航（含开发模式 Ctrl+R 刷新）后，旧页面的 PTY
  // 监听器已随页面销毁，残留会话会持续占用 shell 进程。这里统一清理，
  // 避免 PTY 泄漏。首次 loadURL 时会话表为空，kill 空集无副作用。
  mainWindow.webContents.on("did-navigate", () => {
    killAllPtyForWebContents(mainWindow.webContents);
  });

  // webview（如浏览器面板）打开的 DevTools 独立窗口同样应用 Snow 图标。
  mainWindow.webContents.on("did-attach-webview", (_event, webContents) => {
    applyDevToolsSnowIcon(webContents);
  });

  // 防御性兜底：渲染进程主框架导航到应用页面之外的 URL 一律阻止。
  // 链接/路径点击已在渲染进程用 auxclick/click 拦截并转交系统浏览器或
  // 右侧面板；若仍有漏网（如第三方注入的 <a>、Ctrl/Cmd+点击未覆盖场景），
  // 在 Electron 中会降级为当前窗口导航，直接刷新整个前端，导致进行中的
  // 会话与生成全部中断。location.reload()（错误边界自愈）不触发本事件。
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const devServerUrl = process.env.ELECTRON_RENDERER_URL;
    if (devServerUrl && url.startsWith(devServerUrl)) {
      return; // 开发模式放行 Vite dev server 同源导航（HMR 全量刷新场景）
    }
    event.preventDefault();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch((error) => {
      console.error("Failed to open external URL:", error);
    });

    return { action: "deny" };
  });

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL).catch((error) => {
      console.error("Failed to load development renderer URL:", error);
    });
  } else {
    mainWindow
      .loadURL(
        pathToFileURL(
          join(import.meta.dirname, "../renderer/index.html"),
        ).toString(),
      )
      .catch((error) => {
        console.error("Failed to load packaged renderer:", error);
      });
  }

  // 初始化自动更新模块（注册 IPC + 启动后自动检查更新）
  initAutoUpdater(mainWindow);

  return mainWindow;
};
