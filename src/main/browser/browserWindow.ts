import { BrowserWindow, nativeTheme } from "electron";
import { is } from "@electron-toolkit/utils";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { APP_ICON_PATH } from "../app/constants";
import { snowLog } from "../../utils/snowLogger";

/**
 * 独立浏览器窗口（右侧面板浏览器 tab「在新窗口中打开」）。
 *
 * 与嵌入面板共享同一套渲染端浏览器 UI（browserWindow.html 入口复用
 * BrowserPanelContent，单 webview），关键差异：
 * - 实例 id 从主窗口迁移过来（继承），MCP 浏览器工具（browser.rs）按
 *   instanceId 路由命令时由主进程转发到持有该实例的渲染进程，因此
 *   弹出到独立窗口后工具仍可继续操作该实例。
 * - 当前页面 URL 经 query 传入，独立窗口据此重建浏览器。
 * - 窗口使用系统边框（frame 默认 true），不参与主窗口的自定义标题栏。
 */

const DEFAULT_WINDOW_WIDTH = 1100;
const DEFAULT_WINDOW_HEIGHT = 760;
const MIN_WINDOW_WIDTH = 480;
const MIN_WINDOW_HEIGHT = 320;

/** instanceId -> 独立浏览器窗口（同一实例只允许一个独立窗口）。 */
const detachedWindows = new Map<string, BrowserWindow>();

const getWindowBackgroundColor = (): string =>
  nativeTheme.shouldUseDarkColors ? "#0a0a0a" : "#ffffff";

const buildPageUrl = (instanceId: string, url: string): string => {
  const query = new URLSearchParams({ instanceId, url });
  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    return `${process.env.ELECTRON_RENDERER_URL}/browserWindow.html?${query.toString()}`;
  }
  const pageUrl = pathToFileURL(
    join(import.meta.dirname, "../renderer/browserWindow.html"),
  ).toString();
  return `${pageUrl}?${query.toString()}`;
};

/**
 * 打开（或聚焦）承载指定浏览器实例的独立窗口。
 *
 * 同实例已有窗口时仅聚焦并返回；否则创建新窗口并加载渲染端入口，
 * instanceId / 当前页面 URL 经 query 传递，渲染端据此恢复浏览器状态。
 */
export const createDetachedBrowserWindow = (
  instanceId: string,
  url: string,
): void => {
  const existing = detachedWindows.get(instanceId);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return;
  }

  const win = new BrowserWindow({
    width: DEFAULT_WINDOW_WIDTH,
    height: DEFAULT_WINDOW_HEIGHT,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    title: "Snow Browser",
    icon: APP_ICON_PATH,
    autoHideMenuBar: true,
    backgroundColor: getWindowBackgroundColor(),
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      spellcheck: false,
    },
  });
  detachedWindows.set(instanceId, win);

  win.setMenu(null);
  win.setMenuBarVisibility(false);
  win.setAutoHideMenuBar(true);

  // 等待首帧渲染后再显示，避免白屏闪烁。
  win.once("ready-to-show", () => {
    if (!win.isDestroyed()) {
      win.show();
    }
  });

  win.on("closed", () => {
    detachedWindows.delete(instanceId);
  });

  // 渲染进程异常退出时自动重新加载，避免窗口黑屏卡死。
  win.webContents.on("render-process-gone", (_event, details) => {
    snowLog.error({
      module: "main/browser/browserWindow",
      func: "render-process-gone",
      message: "Detached browser renderer process gone, reloading window",
      context: JSON.stringify(details),
    });
    if (!win.isDestroyed()) {
      win.webContents.reload();
    }
  });

  // 防御性兜底：渲染进程主框架导航到应用页面之外的 URL 一律阻止。
  win.webContents.on("will-navigate", (event, targetUrl) => {
    const devServerUrl = process.env.ELECTRON_RENDERER_URL;
    if (devServerUrl && targetUrl.startsWith(devServerUrl)) {
      return; // 开发模式放行 Vite dev server 同源导航（HMR 全量刷新场景）
    }
    event.preventDefault();
  });

  void win.loadURL(buildPageUrl(instanceId, url)).catch((error) => {
    console.error("Failed to load detached browser window:", error);
  });
};

/** 关闭所有独立浏览器窗口（应用退出时调用，避免残留孤儿窗口）。 */
export const closeAllDetachedBrowserWindows = (): void => {
  for (const win of detachedWindows.values()) {
    if (!win.isDestroyed()) {
      win.close();
    }
  }
  detachedWindows.clear();
};
