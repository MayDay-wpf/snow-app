import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  nativeImage,
  screen,
  session,
  shell,
  type WebContents,
} from "electron";
import type { NativeBridge } from "../../native/types";
import { native } from "../../native/nativeBridge";
import {
  APP_FAVICON_32_PATH,
  APP_WINDOW_ICON_PATH,
  isMacOS,
} from "../../app/constants";
import {
  getMainWindow,
  markCloseConfirmed,
  setCloseRequestHandler,
} from "../../app/mainWindow";
import { safeSend } from "../../utils/safeSend";
import { refreshTrayStats } from "../../app/tray";
import { registerGlobalShortcuts } from "../../app/globalShortcuts";
import { clearWindowState } from "../../app/windowState";
import {
  getAutoLaunchEnabled,
  setAutoLaunchEnabled,
} from "../../app/autoLaunch";
import {
  clearBrowserRouteRules,
  clearNetworkRecords,
  ensureNetworkRecording,
  ensureWebContentsDebugger,
  getBrowserWebContents,
  getNetworkRecord,
  queryNetworkDetails,
  queryNetworkRecords,
  setBrowserNetworkState,
  setBrowserRouteRules,
} from "./browserNetworkRecorder";
import {
  clearConsoleRecords,
  getConsoleRecord,
  initBrowserConsoleRecorder,
  queryConsoleRecords,
} from "./browserConsoleRecorder";
import { captureBrowserScreenshot } from "../../browser/browserScreenshot";
import {
  cancelDownload,
  listDownloads,
  openDownload,
  showDownloadInFolder,
} from "../../app/downloadManager";
import { deleteCookieAutoBackup } from "../../app/cookieAutoBackup";
import {
  deleteBrowserCookie,
  listBrowserCookies,
  restoreBrowserStorageState,
  saveBrowserStorageState,
} from "./browserStorageState";
import {
  getTraceInsight,
  runBrowserTrace,
  startBrowserTrace,
  stopBrowserTrace,
} from "./browserTrace";
import {
  registerBrowserFrameHandlers,
  resolveFrameCdpId,
} from "../../browser/browserFrames";
import {
  confirmDetachedPanelClose,
  focusDetachedPanelConversation,
  focusNextDetachedPanelWindow,
  getDetachedConversationIds,
  isDetachedPanelWebContents,
  openDetachedPanelWindow,
  parseDetachedTabPayload,
  publishDetachedRuntimeMirror,
  reportDetachedPanelConversationIds,
  reserveDetachedTabPty,
  subscribeDetachedConversationOwners,
  takeDetachedPanelPayload,
  takeDetachedRuntimeMirror,
} from "../../app/detachedPanelWindow";
import {
  DETACHED_PANEL_CONVERSATION_LIST_BROADCAST_CHANNEL,
  DETACHED_PANEL_CONVERSATION_OWNERS_BROADCAST_CHANNEL,
} from "../../../shared/detachedPanel";
import {
  applyBrowserEmulation,
  resizeBrowserViewport,
} from "../../browser/browserEmulation";
import { getCssStyles } from "../../browser/browserCssInspector";
import {
  runBrowserAudit,
  type AuditCategories,
} from "../../browser/browserAudit";
import {
  compareHeapSnapshots,
  getHeapObjectDetails,
  getHeapSnapshotDuplicateStrings,
  getHeapSnapshotEdges,
  getHeapSnapshotRetainers,
  getHeapSnapshotRetainingPaths,
  getHeapSnapshotSummary,
  queryHeapObjects,
  takeHeapSnapshot,
} from "../../browser/heapProfiler";
import {
  startBrowserScreencast,
  stopBrowserScreencast,
} from "../../browser/browserScreencast";

import {
  listBrowserDialogs,
  respondBrowserDialog,
} from "../../browser/browserDialogs";

const browserDevToolsWindows = new Map<number, BrowserWindow>();

// ===== 面板 MCP 门禁横幅「不再提示」=====
// 应用级内存开关：不落盘，应用重启即恢复提示；主窗口与独立浏览器窗口
// 共享同一份状态（渲染端经 IPC 读取 + 订阅变更）。
let panelMcpHintSuppressed = false;

// ===== Close behavior（「关闭 Snow App 时」行为设置）=====
// 设置代码与渲染端 src/renderer/constants/closeBehavior.ts 保持一致，
// 由 Rust 后端 system_settings 表持久化（native bridge 已做 storageReady 门控）。
const CLOSE_BEHAVIOR_SETTING_CODE = "close_behavior";

/**
 * 隐藏窗口到托盘。Windows/Linux 隐藏到系统托盘；macOS 同时移除 Dock 图标
 * （仅保留菜单栏托盘），从托盘恢复时（tray.ts showMainWindow）会重新显示
 * Dock 图标。隐藏后立即刷新托盘悬停信息，保证用户第一时间看到最新状态。
 */
const hideWindowToTray = (win: BrowserWindow): void => {
  win.hide();
  if (process.platform === "darwin") {
    app.dock?.hide();
  }
  refreshTrayStats();
};

/**
 * 读取「关闭 Snow App 时」行为设置。未设置、值非法或读取失败（如 Rust
 * 后端不可用）时回退为 ask（每次询问），不阻断关闭流程。
 */
const resolveCloseBehavior = async (): Promise<"ask" | "exit" | "minimize"> => {
  try {
    const raw = await native.getSystemSettingValue(CLOSE_BEHAVIOR_SETTING_CODE);
    if (raw === "exit" || raw === "minimize") {
      return raw;
    }
  } catch {
    // 回退默认询问
  }
  return "ask";
};

/**
 * 注入主窗口关闭请求处理器：close 拦截（mainWindow.ts）preventDefault 后
 * 调用，按用户设置自动执行，只有 ask 才回推 window:close-requested 由
 * 渲染进程弹出二次确认。通过 setter 注入而非直接 import，避免
 * mainWindow ↔ windowHandlers 的模块循环依赖。
 */
const bindCloseRequestHandler = (): void => {
  setCloseRequestHandler((win) => {
    void resolveCloseBehavior()
      .then((behavior) => {
        if (win.isDestroyed()) {
          return;
        }
        if (behavior === "exit") {
          markCloseConfirmed();
          app.quit();
          return;
        }
        if (behavior === "minimize") {
          hideWindowToTray(win);
          return;
        }
        safeSend(win.webContents, "window:close-requested");
      })
      .catch(() => {
        // 读取异常回退询问，不阻断关闭
        if (!win.isDestroyed()) {
          safeSend(win.webContents, "window:close-requested");
        }
      });
  });
};

const buildDevToolsTitle = (contents: WebContents): string => {
  const url = contents.getURL();
  return url ? `Developer Tools - ${url}` : "Developer Tools";
};

/**
 * 使用应用自有 BrowserWindow 承载内置浏览器的 DevTools。
 * Electron 默认 DevTools 使用内部 native view，无法可靠修改标题栏图标；显式提供
 * devToolsWebContents 后即可通过 BrowserWindow 的 icon 使用 Snow App 图标。
 */
export const openBrowserDevTools = (contents: WebContents): void => {
  if (contents.isDestroyed()) {
    throw new Error("Browser webContents is destroyed");
  }

  if (isMacOS) {
    contents.openDevTools({ mode: "detach", activate: true });
    return;
  }

  const contentsId = contents.id;
  const existingWindow = browserDevToolsWindows.get(contentsId);
  if (existingWindow && !existingWindow.isDestroyed()) {
    if (!existingWindow.isVisible()) {
      existingWindow.show();
    }
    existingWindow.focus();
    return;
  }
  browserDevToolsWindows.delete(contentsId);

  // 若此前通过其他入口打开了 Electron 默认 DevTools，先关闭后改用可设置图标的窗口。
  if (contents.isDevToolsOpened()) {
    contents.closeDevTools();
  }

  const devToolsWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 600,
    minHeight: 400,
    title: buildDevToolsTitle(contents),
    icon: APP_WINDOW_ICON_PATH,
    autoHideMenuBar: true,
    show: false,
  });
  devToolsWindow.setMenu(null);
  devToolsWindow.setMenuBarVisibility(false);
  browserDevToolsWindows.set(contentsId, devToolsWindow);

  // Windows 标题栏同时受原生窗口 HICON 和 DevTools 页面 favicon 影响。
  // 仅调用 BrowserWindow.setIcon 只能改变 WM_GETICON；Chromium 仍会绘制 Electron
  // favicon。因此两层都覆盖为 Snow 图标。
  const snowFaviconDataUrl = nativeImage
    .createFromPath(APP_FAVICON_32_PATH)
    .toDataURL();
  const applyDevToolsBranding = (): void => {
    if (devToolsWindow.isDestroyed()) {
      return;
    }
    const icon = nativeImage.createFromPath(APP_WINDOW_ICON_PATH);
    if (!icon.isEmpty()) {
      devToolsWindow.setIcon(icon);
    }
    if (!snowFaviconDataUrl || devToolsWindow.webContents.isDestroyed()) {
      return;
    }
    void devToolsWindow.webContents
      .executeJavaScript(
        `
        (() => {
          const marker = "data-snow-devtools-favicon";
          let link = document.head?.querySelector(
            'link[' + marker + '="true"]'
          );
          if (!link) {
            link = document.createElement("link");
            link.setAttribute(marker, "true");
            link.setAttribute("rel", "icon");
            link.setAttribute("type", "image/png");
            document.head?.appendChild(link);
          }
          for (const existing of document.querySelectorAll('link[rel~="icon"]')) {
            if (existing !== link) {
              existing.remove();
            }
          }
          link.setAttribute("href", ${JSON.stringify(snowFaviconDataUrl)});
        })();
      `,
      )
      .catch(() => {
        // DevTools 正在关闭时执行脚本可能失败，无需影响窗口生命周期。
      });
  };
  devToolsWindow.webContents.on("did-finish-load", applyDevToolsBranding);
  devToolsWindow.webContents.on("page-favicon-updated", (_event, favicons) => {
    if (!favicons.includes(snowFaviconDataUrl)) {
      setTimeout(applyDevToolsBranding, 0);
    }
  });

  const closeDevToolsWindow = (): void => {
    if (!devToolsWindow.isDestroyed()) {
      devToolsWindow.close();
    }
  };
  contents.once("destroyed", closeDevToolsWindow);
  devToolsWindow.once("closed", () => {
    contents.removeListener("destroyed", closeDevToolsWindow);
    if (browserDevToolsWindows.get(contentsId) === devToolsWindow) {
      browserDevToolsWindows.delete(contentsId);
    }
  });
  devToolsWindow.once("ready-to-show", () => {
    if (!devToolsWindow.isDestroyed()) {
      applyDevToolsBranding();
      devToolsWindow.show();
    }
  });

  contents.setDevToolsWebContents(devToolsWindow.webContents);
  contents.openDevTools({ mode: "detach", activate: true });
  applyDevToolsBranding();
};

export const registerWindowHandlers = (_native: NativeBridge): void => {
  registerBrowserFrameHandlers();
  initBrowserConsoleRecorder();
  // 注入主窗口关闭请求处理器（close 拦截后按设置自动执行：询问/退出/最小化）。
  bindCloseRequestHandler();

  // ===== Window Controls (Windows custom titlebar) =====
  ipcMain.handle("window:minimize", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });

  // 关闭提醒中的"最小化"选项：隐藏窗口而非退出。
  ipcMain.handle("window:hide-to-tray", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) {
      return;
    }
    hideWindowToTray(win);
  });

  ipcMain.handle("window:maximize-toggle", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) {
      return;
    }
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
  });

  // 渲染进程触发关闭：与原生关闭路径一致，走 close 事件拦截流程。
  // mainWindow.ts 的 close 监听会 preventDefault 并回推 window:close-requested。
  ipcMain.handle("window:close", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });

  // 渲染进程用户确认关闭后调用：标记已确认，直接退出整个应用进程。
  // 所有平台统一使用 app.quit() 彻底退出，macOS 不再驻留 dock。
  ipcMain.handle("window:confirm-close", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) {
      return;
    }
    markCloseConfirmed();
    app.quit();
  });

  ipcMain.handle("window:is-maximized", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win ? win.isMaximized() : false;
  });

  // 窗口置顶（图钉）：level 使用 screen-saver 保证不被其他应用遮挡。
  ipcMain.handle("window:set-always-on-top", (event, alwaysOnTop: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) {
      return false;
    }
    win.setAlwaysOnTop(alwaysOnTop === true, "screen-saver");
    return win.isAlwaysOnTop();
  });

  ipcMain.handle("window:is-always-on-top", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win ? win.isAlwaysOnTop() : false;
  });

  // 原生全屏（macOS 绿灯全屏）状态查询：渲染进程挂载时同步一次初始值。
  ipcMain.handle("window:is-full-screen", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win ? win.isFullScreen() : false;
  });

  // 清除持久化的窗口尺寸/位置缓存（主题重置时一并调用），
  // 下次启动回退到默认窗口尺寸。
  ipcMain.handle("window:clear-state", async () => {
    await clearWindowState();
  });

  // 错误边界"重新加载"按钮：主进程强制刷新（绕开缓存）。
  ipcMain.handle("window:reload", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) {
      win.webContents.reloadIgnoringCache();
    }
  });

  // 右侧面板 Plus 菜单的「开发者工具」入口：发行版同样可用。
  // 使用 detach 模式，避免 DevTools 停靠挤压窗口导致侧面板被自动收起。
  ipcMain.handle("window:toggle-devtools", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) {
      return;
    }
    const contents = win.webContents;
    if (contents.isDevToolsOpened()) {
      contents.closeDevTools();
    } else {
      contents.openDevTools({ mode: "detach", activate: true });
    }
  });

  // 通用设置「清空应用缓存」：只清当前 session 的 HTTP 缓存后强制重新加载
  // 当前页面（最快路径，不触碰 code cache / DNS / 登录态与本地数据）。
  ipcMain.handle("app:clear-cache-and-reload", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    try {
      await event.sender.session.clearCache();
    } catch {
      // 清理失败不阻断重载
    }
    if (win && !win.isDestroyed()) {
      win.webContents.reloadIgnoringCache();
    }
  });

  // 通用设置「开机自启动」：状态以系统登录项为准
  ipcMain.handle("app:get-auto-launch", () => getAutoLaunchEnabled());
  ipcMain.handle("app:set-auto-launch", (_event, enabled: unknown) =>
    setAutoLaunchEnabled(enabled === true),
  );

  // 渲染进程保存快捷键设置后调用：重新读取数据库并注册/注销
  // 全局生效的快捷键（foregroundOnly=false 的动作）。
  ipcMain.handle("shortcuts:reload-global", () =>
    registerGlobalShortcuts(_native),
  );

  // ===== Window Drag (macOS JS drag region) =====
  let dragInterval: NodeJS.Timeout | null = null;
  let dragOffsetX = 0;
  let dragOffsetY = 0;

  ipcMain.handle("window:start-drag", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) {
      return;
    }
    if (dragInterval) {
      clearInterval(dragInterval);
    }
    const winBounds = win.getBounds();
    const cursor = screen.getCursorScreenPoint();
    dragOffsetX = cursor.x - winBounds.x;
    dragOffsetY = cursor.y - winBounds.y;
    dragInterval = setInterval(() => {
      if (!win || win.isDestroyed()) {
        if (dragInterval) {
          clearInterval(dragInterval);
          dragInterval = null;
        }
        return;
      }
      const cur = screen.getCursorScreenPoint();
      win.setBounds({
        x: cur.x - dragOffsetX,
        y: cur.y - dragOffsetY,
        width: winBounds.width,
        height: winBounds.height,
      });
    }, 16);
  });

  ipcMain.handle("window:stop-drag", () => {
    if (dragInterval) {
      clearInterval(dragInterval);
      dragInterval = null;
    }
  });

  // ===== Clipboard (write image) =====
  ipcMain.handle("clipboard:write-image", (_event, dataUrl: unknown) => {
    if (typeof dataUrl !== "string" || !dataUrl.trim()) {
      throw new Error("Image data URL is required");
    }

    const image = nativeImage.createFromDataURL(dataUrl);
    if (image.isEmpty()) {
      throw new Error("Failed to create image from data URL");
    }

    clipboard.writeImage(image);
  });

  // ===== Clipboard (text) =====
  // 走主进程 clipboard 模块：渲染进程的 navigator.clipboard.readText()
  // 需要 clipboard-read 权限（默认未授予），通过 IPC 则始终可用。
  ipcMain.handle("clipboard:read-text", () => clipboard.readText());

  ipcMain.handle("clipboard:write-text", (_event, text: unknown) => {
    if (typeof text !== "string") {
      throw new Error("Clipboard text must be a string");
    }
    clipboard.writeText(text);
  });

  // 剪贴板是否还有可粘贴的内容：编辑区右键菜单据此自动禁用「粘贴」。
  // 只查文本不够——剪贴板里可能只有图片/文件（readText 为空但可粘贴）。
  ipcMain.handle("clipboard:has-content", () => {
    if (clipboard.availableFormats().length > 0) {
      return true;
    }
    return !clipboard.readImage().isEmpty();
  });

  // ===== Editing commands (custom context menu) =====
  // 应用已 Menu.setApplicationMenu(null)，Electron 不再提供原生编辑菜单；
  // 渲染进程的 document.execCommand("paste") 受剪贴板读取权限限制不可用，
  // 因此自建菜单统一走主进程的真实编辑命令（会正常派发 copy/cut/paste 事件，
  // 编辑区既有的事件处理逻辑照常生效）。
  ipcMain.handle("edit:command", (event, command: unknown) => {
    if (
      command !== "cut" &&
      command !== "copy" &&
      command !== "paste" &&
      command !== "selectAll"
    ) {
      throw new Error("Unsupported edit command");
    }
    const contents = event.sender;
    if (command === "cut") {
      contents.cut();
      return;
    }
    if (command === "copy") {
      contents.copy();
      return;
    }
    if (command === "paste") {
      contents.paste();
      return;
    }
    contents.selectAll();
  });

  // ===== Shell (file manager reveal) =====
  // 在系统文件管理器中显示文件（Windows 资源管理器 / macOS Finder / Linux
  // 文件管理器），文件会高亮选中；传入目录时直接打开该目录。
  ipcMain.handle("shell:show-item-in-folder", (_event, path: unknown) => {
    if (typeof path !== "string" || !path.trim()) {
      throw new Error("A valid path is required");
    }
    shell.showItemInFolder(path);
  });

  // 使用系统默认应用打开文件（Word / PPT / PDF 等）；失败返回错误信息，成功返回 null。
  ipcMain.handle(
    "shell:open-path",
    async (_event, path: unknown): Promise<string | null> => {
      if (typeof path !== "string" || !path.trim()) {
        throw new Error("A valid path is required");
      }
      const errorMessage = await shell.openPath(path);
      return errorMessage || null;
    },
  );

  // ===== Browser (embedded webview) =====
  ipcMain.handle("browser:clear-cache", async () => {
    await session.defaultSession.clearCache();
  });

  ipcMain.handle("browser:clear-cookies", async () => {
    await session.defaultSession.clearStorageData({ storages: ["cookies"] });
    // 用户显式清除登录态：删除自动备份，避免下次启动误恢复。
    deleteCookieAutoBackup();
  });

  // 渲染端请求在主窗口右侧面板新建浏览器 tab（如设置页历史记录）：转发给主窗口，由 RightPanel 新建。
  ipcMain.on("browser:open-tab-in-main", (_event, payload: unknown) => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return;
    }
    const record = payload as Record<string, unknown>;
    const url = record.url;
    if (typeof url !== "string" || !url.trim()) {
      return;
    }
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    if (!mainWindow.isVisible()) {
      mainWindow.show();
    }
    mainWindow.focus();
    mainWindow.webContents.send("browser:open-tab-in-main-broadcast", {
      url: url.trim(),
    });
  });

  // 独立浏览器窗口「发送给 Agent」：把文本片段（页面正文 / 控制台日志 /
  // 网络请求）转发给主窗口聊天输入框（渲染进程内事件无法跨窗口）。
  ipcMain.on("chat-text:forward", (_event, payload: unknown) => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return;
    }
    const record = payload as Record<string, unknown>;
    if (typeof record.text !== "string" || !record.text.trim()) {
      return;
    }
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    mainWindow.webContents.send("chat-text:insert", {
      text: record.text,
      source: typeof record.source === "string" ? record.source : "",
    });
  });

  // 独立浏览器窗口确认元素选择后，把结果转发给主窗口聊天输入框
  // （INSERT_ELEMENT_TAG_EVENT 是渲染进程内事件，跨窗口必须经主进程中转）。
  ipcMain.on("element-tag:forward", (event, tag: unknown) => {
    if (
      !tag ||
      typeof tag !== "object" ||
      Array.isArray(tag) ||
      typeof (tag as Record<string, unknown>).url !== "string" ||
      typeof (tag as Record<string, unknown>).tag !== "string" ||
      typeof (tag as Record<string, unknown>).label !== "string" ||
      typeof (tag as Record<string, unknown>).text !== "string" ||
      typeof (tag as Record<string, unknown>).note !== "string" ||
      typeof (tag as Record<string, unknown>).domTree !== "string"
    ) {
      return;
    }
    // 仅转发到主窗口（ChatInputView 所在）；主窗口自身的元素选择走本地事件。
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("element-tag:insert", tag);
    }
  });

  // 独立浏览器窗口点击「浏览器设置」：聚焦并显示主窗口，再把请求转发给
  // 主窗口（Sidebar 监听 APP_CONTROL_OPEN_SETTINGS_EVENT 打开设置面板；
  // 该事件是渲染进程内事件，跨窗口必须经主进程中转）。
  ipcMain.on("app-control:open-settings-forward", (event, view: unknown) => {
    if (typeof view !== "string" || !view.trim()) {
      return;
    }
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    if (!mainWindow.isVisible()) {
      mainWindow.show();
    }
    mainWindow.focus();
    mainWindow.webContents.send("app-control:open-settings-broadcast", view);
  });

  // 独立浏览器窗口点击 MCP 门禁横幅「去开启」：聚焦并显示主窗口，再把请求
  // 转发给主窗口打开项目 MCP 弹窗（渲染进程内事件无法跨窗口，必须经主进程
  // 中转）；serverId 为弹窗中需要单独展示的服务器。
  ipcMain.on("project-mcp:open-panel-forward", (_event, serverId: unknown) => {
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    if (!mainWindow.isVisible()) {
      mainWindow.show();
    }
    mainWindow.focus();
    mainWindow.webContents.send(
      "project-mcp:open-panel-broadcast",
      typeof serverId === "string" ? serverId : "",
    );
  });

  // 面板 MCP 门禁横幅「不再提示」：应用级内存状态，重启后恢复提示；
  // 变更广播到所有窗口（主窗口与独立浏览器窗口共享同一状态）。
  ipcMain.handle(
    "panel-mcp:get-hint-suppressed",
    (): boolean => panelMcpHintSuppressed,
  );
  ipcMain.on("panel-mcp:set-hint-suppressed", (_event, suppressed: unknown) => {
    const next = suppressed === true;
    if (next === panelMcpHintSuppressed) {
      return;
    }
    panelMcpHintSuppressed = next;
    for (const window of BrowserWindow.getAllWindows()) {
      safeSend(window.webContents, "panel-mcp:hint-suppressed-changed", next);
    }
  });

  ipcMain.handle("browser:open-devtools", (_event, webContentsId: unknown) => {
    if (typeof webContentsId !== "number") {
      throw new Error("webContentsId must be a number");
    }
    openBrowserDevTools(getBrowserWebContents(webContentsId));
  });

  // CDP 命令桥（白名单）：供渲染进程执行无障碍快照（getFullAXTree）与
  // 元素回指（resolveNode + callFunctionOn）。只放行最小必要命令集。
  const CDP_METHOD_WHITELIST = new Set([
    "Accessibility.getFullAXTree",
    "DOM.resolveNode",
    "Runtime.callFunctionOn",
    "DOM.getDocument",
    "DOM.querySelector",
    "DOM.setFileInputFiles",
    "Page.addScriptToEvaluateOnNewDocument",
    "Page.removeScriptToEvaluateOnNewDocument",
  ]);
  ipcMain.handle(
    "browser:cdp-command",
    async (
      _event,
      webContentsId: unknown,
      method: unknown,
      params: unknown,
    ) => {
      if (typeof webContentsId !== "number") {
        throw new Error("webContentsId must be a number");
      }
      if (typeof method !== "string" || !CDP_METHOD_WHITELIST.has(method)) {
        throw new Error(`CDP method not allowed: ${String(method)}`);
      }
      const contents = getBrowserWebContents(webContentsId);
      await ensureWebContentsDebugger(contents);
      if (!contents.debugger.isAttached()) {
        throw new Error(
          "Browser debugger is unavailable; close the page DevTools and retry",
        );
      }
      return contents.debugger.sendCommand(
        method,
        params !== null && typeof params === "object" ? params : {},
      );
    },
  );
  // 性能 trace：录制 durationMs 毫秒并返回精简统计（Tracing 域，主进程处理）。
  ipcMain.handle(
    "browser:trace",
    (_event, webContentsId: number, durationMs: number) =>
      runBrowserTrace(
        typeof webContentsId === "number" ? webContentsId : -1,
        typeof durationMs === "number" ? durationMs : 3000,
      ),
  );

  // 浏览器调试数据：网络请求记录与 JavaScript 弹窗（供 browser-devtools 查询/响应）
  // 网络记录按需启用：查询前才开启该实例的 Network.enable，未调试过的
  // webview（含手动新建的 tab）不产生网络 CDP 事件流。
  ipcMain.handle(
    "browser:network-requests",
    async (_event, webContentsId: number, options?: unknown) => {
      const id = typeof webContentsId === "number" ? webContentsId : -1;
      const contents = id >= 0 ? getBrowserWebContents(id) : undefined;
      if (contents) {
        await ensureNetworkRecording(contents);
      }
      const raw =
        options !== null && typeof options === "object"
          ? (options as Record<string, unknown>)
          : {};
      const frameId =
        typeof raw.frameId === "string" && raw.frameId
          ? raw.frameId
          : undefined;
      const cdpFrameId =
        frameId && contents
          ? await resolveFrameCdpId(contents, frameId)
          : undefined;
      return queryNetworkRecords(id, {
        filter: typeof raw.filter === "string" ? raw.filter : undefined,
        resourceTypes: Array.isArray(raw.resourceTypes)
          ? raw.resourceTypes.filter(
              (item): item is string => typeof item === "string",
            )
          : undefined,
        methods: Array.isArray(raw.methods)
          ? raw.methods.filter(
              (item): item is string => typeof item === "string",
            )
          : undefined,
        includeStatic: raw.includeStatic === true,
        pageIdx: typeof raw.pageIdx === "number" ? raw.pageIdx : undefined,
        pageSize: typeof raw.pageSize === "number" ? raw.pageSize : undefined,
        includePreserved: raw.includePreserved === true,
        ...(cdpFrameId ? { cdpFrameId } : {}),
      });
    },
  );
  // 网络请求详情：请求/响应头 + 请求体 + 响应体（基于 CDP 记录中的 requestId）；
  // requestFilePath / responseFilePath 提供时把 body 落盘（不回传内容）。
  ipcMain.handle(
    "browser:network-details",
    (_event, webContentsId: number, requestId: string, options?: unknown) => {
      const raw =
        options !== null && typeof options === "object"
          ? (options as Record<string, unknown>)
          : {};
      return queryNetworkDetails(
        typeof webContentsId === "number" ? webContentsId : -1,
        typeof requestId === "string" ? requestId : "",
        {
          maxBodyBytes:
            typeof raw.maxBodyBytes === "number" ? raw.maxBodyBytes : undefined,
          requestFilePath:
            typeof raw.requestFilePath === "string"
              ? raw.requestFilePath
              : undefined,
          responseFilePath:
            typeof raw.responseFilePath === "string"
              ? raw.responseFilePath
              : undefined,
        },
      );
    },
  );
  // 截图：CDP Page.captureScreenshot（格式/质量/元素 clip/整页/落盘）。
  ipcMain.handle(
    "browser:capture-screenshot",
    (_event, webContentsId: number, request: unknown) => {
      const raw =
        request !== null && typeof request === "object"
          ? (request as Record<string, unknown>)
          : {};
      const format =
        raw.format === "jpeg" || raw.format === "webp" ? raw.format : "png";
      const clip =
        raw.clip !== null && typeof raw.clip === "object"
          ? (raw.clip as Record<string, unknown>)
          : null;
      return captureBrowserScreenshot(
        typeof webContentsId === "number" ? webContentsId : -1,
        {
          format,
          quality: typeof raw.quality === "number" ? raw.quality : undefined,
          fullPage: raw.fullPage === true,
          clip:
            clip &&
            typeof clip.x === "number" &&
            typeof clip.y === "number" &&
            typeof clip.width === "number" &&
            typeof clip.height === "number"
              ? {
                  x: clip.x,
                  y: clip.y,
                  width: clip.width,
                  height: clip.height,
                  scale:
                    typeof clip.scale === "number" ? clip.scale : undefined,
                }
              : undefined,
          filePath: typeof raw.filePath === "string" ? raw.filePath : undefined,
        },
      );
    },
  );
  // 控制台记录（CDP Runtime/Log）：查询（分页/过滤/preserved）与单条、清空。
  ipcMain.handle(
    "browser:console-records",
    async (_event, webContentsId: number, options?: unknown) => {
      const id = typeof webContentsId === "number" ? webContentsId : -1;
      const contents = id >= 0 ? getBrowserWebContents(id) : undefined;
      let cdpAvailable = false;
      if (contents) {
        await ensureWebContentsDebugger(contents);
        cdpAvailable = contents.debugger.isAttached();
      }
      const raw =
        options !== null && typeof options === "object"
          ? (options as Record<string, unknown>)
          : {};
      const frameId =
        typeof raw.frameId === "string" && raw.frameId
          ? raw.frameId
          : undefined;
      const cdpFrameId =
        frameId && contents
          ? await resolveFrameCdpId(contents, frameId)
          : undefined;
      const result = queryConsoleRecords(id, {
        level: typeof raw.level === "number" ? raw.level : undefined,
        types: Array.isArray(raw.types)
          ? raw.types.filter((item): item is string => typeof item === "string")
          : undefined,
        pageIdx: typeof raw.pageIdx === "number" ? raw.pageIdx : undefined,
        pageSize: typeof raw.pageSize === "number" ? raw.pageSize : undefined,
        includePreserved: raw.includePreserved === true,
        ...(cdpFrameId ? { cdpFrameId } : {}),
      });
      return { ...result, cdpAvailable };
    },
  );
  ipcMain.handle(
    "browser:console-record",
    (_event, webContentsId: number, messageId: number) =>
      getConsoleRecord(
        typeof webContentsId === "number" ? webContentsId : -1,
        typeof messageId === "number" ? messageId : -1,
      ),
  );
  ipcMain.handle(
    "browser:console-clear",
    async (_event, webContentsId: number) => {
      const id = typeof webContentsId === "number" ? webContentsId : -1;
      if (id >= 0) {
        await ensureWebContentsDebugger(getBrowserWebContents(id));
      }
      return { cleared: clearConsoleRecords(id) };
    },
  );
  // 性能 trace：start / stop / insight（performance_* 工具）。
  ipcMain.handle(
    "browser:trace-start",
    (_event, webContentsId: number, categories?: unknown) =>
      startBrowserTrace(
        typeof webContentsId === "number" ? webContentsId : -1,
        Array.isArray(categories)
          ? categories.filter(
              (item): item is string => typeof item === "string",
            )
          : undefined,
      ),
  );
  ipcMain.handle(
    "browser:trace-stop",
    (_event, webContentsId: number, options?: unknown) => {
      const raw =
        options !== null && typeof options === "object"
          ? (options as Record<string, unknown>)
          : {};
      return stopBrowserTrace(
        typeof webContentsId === "number" ? webContentsId : -1,
        {
          filePath: typeof raw.filePath === "string" ? raw.filePath : undefined,
        },
      );
    },
  );
  ipcMain.handle(
    "browser:trace-insight",
    (_event, webContentsId: number, insightId: string) =>
      getTraceInsight(
        typeof webContentsId === "number" ? webContentsId : -1,
        typeof insightId === "string" ? insightId : "",
      ),
  );
  // 页面仿真：emulate（配色/CPU/地理位置/请求头/网络档位/UA/视口）。
  ipcMain.handle(
    "browser:emulate",
    (_event, webContentsId: number, params: unknown) => {
      const raw =
        params !== null && typeof params === "object"
          ? (params as Record<string, unknown>)
          : {};
      const emulation: Parameters<typeof applyBrowserEmulation>[1] = {};
      if (
        raw.colorScheme === "dark" ||
        raw.colorScheme === "light" ||
        raw.colorScheme === "auto"
      ) {
        emulation.colorScheme = raw.colorScheme;
      }
      if (typeof raw.cpuThrottlingRate === "number") {
        emulation.cpuThrottlingRate = raw.cpuThrottlingRate;
      }
      if (raw.extraHttpHeaders !== undefined) {
        if (raw.extraHttpHeaders === null) {
          emulation.extraHttpHeaders = null;
        } else if (typeof raw.extraHttpHeaders === "object") {
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(
            raw.extraHttpHeaders as Record<string, unknown>,
          )) {
            if (typeof value === "string") {
              headers[key] = value;
            }
          }
          emulation.extraHttpHeaders = headers;
        }
      }
      if (raw.geolocation !== undefined) {
        if (raw.geolocation === null) {
          emulation.geolocation = null;
        } else if (typeof raw.geolocation === "object") {
          const geo = raw.geolocation as Record<string, unknown>;
          if (
            typeof geo.latitude === "number" &&
            typeof geo.longitude === "number"
          ) {
            emulation.geolocation = {
              latitude: geo.latitude,
              longitude: geo.longitude,
              accuracy:
                typeof geo.accuracy === "number" ? geo.accuracy : undefined,
            };
          }
        }
      }
      if (typeof raw.networkConditions === "string") {
        emulation.networkConditions = raw.networkConditions;
      } else if (raw.networkConditions === null) {
        emulation.networkConditions = null;
      }
      if (typeof raw.userAgent === "string") {
        emulation.userAgent = raw.userAgent;
      } else if (raw.userAgent === null) {
        emulation.userAgent = null;
      }
      if (typeof raw.viewport === "string") {
        emulation.viewport = raw.viewport;
      } else if (raw.viewport === null) {
        emulation.viewport = null;
      }
      return applyBrowserEmulation(
        typeof webContentsId === "number" ? webContentsId : -1,
        emulation,
      );
    },
  );
  ipcMain.handle(
    "browser:resize-page",
    (_event, webContentsId: number, width: number, height: number) =>
      resizeBrowserViewport(
        typeof webContentsId === "number" ? webContentsId : -1,
        typeof width === "number" ? width : 800,
        typeof height === "number" ? height : 600,
      ),
  );
  // CSS 级联检查：匹配规则 / 内联 / 继承 / computed（get_css_styles 工具）。
  ipcMain.handle(
    "browser:css-styles",
    (_event, webContentsId: number, query: unknown) => {
      const raw =
        query !== null && typeof query === "object"
          ? (query as Record<string, unknown>)
          : {};
      return getCssStyles(
        typeof webContentsId === "number" ? webContentsId : -1,
        {
          selector:
            typeof raw.selector === "string" && raw.selector
              ? raw.selector
              : undefined,
          backendNodeId:
            typeof raw.backendNodeId === "number"
              ? raw.backendNodeId
              : undefined,
          pageIdx: typeof raw.pageIdx === "number" ? raw.pageIdx : undefined,
          pageSize: typeof raw.pageSize === "number" ? raw.pageSize : undefined,
        },
      );
    },
  );
  // 页面审计：axe-core 无障碍 + 轻量 SEO / 最佳实践（audit 工具）。
  ipcMain.handle(
    "browser:audit",
    (_event, webContentsId: number, categories?: unknown) => {
      const list = Array.isArray(categories)
        ? categories.filter(
            (item): item is AuditCategories =>
              item === "accessibility" ||
              item === "seo" ||
              item === "best-practices",
          )
        : [];
      return runBrowserAudit(
        typeof webContentsId === "number" ? webContentsId : -1,
        list.length > 0 ? list : ["accessibility", "seo", "best-practices"],
      );
    },
  );
  // 堆快照：采集与文件分析（take/summary/query/details/edges/retainers/paths/strings/compare）。
  ipcMain.handle("browser:heap", (_event, action: unknown, params: unknown) => {
    const raw =
      params !== null && typeof params === "object"
        ? (params as Record<string, unknown>)
        : {};
    const file = typeof raw.filePath === "string" ? raw.filePath : "";
    const num = (key: string, fallback: number): number =>
      typeof raw[key] === "number" ? (raw[key] as number) : fallback;
    switch (action) {
      case "take":
        return takeHeapSnapshot(
          typeof raw.webContentsId === "number" ? raw.webContentsId : -1,
          file,
        );
      case "summary":
        return getHeapSnapshotSummary(file, num("topN", 30));
      case "query":
        return queryHeapObjects(file, {
          className:
            typeof raw.className === "string" ? raw.className : undefined,
          nodeType: typeof raw.nodeType === "string" ? raw.nodeType : undefined,
          minSelfSize:
            typeof raw.minSelfSize === "number" ? raw.minSelfSize : undefined,
          isDetached: raw.isDetached === true ? true : undefined,
          sortBy:
            raw.sortBy === "id"
              ? "id"
              : raw.sortBy === "selfSize"
                ? "selfSize"
                : undefined,
          pageIdx: typeof raw.pageIdx === "number" ? raw.pageIdx : undefined,
          pageSize: typeof raw.pageSize === "number" ? raw.pageSize : undefined,
        });
      case "details":
        return getHeapObjectDetails(file, num("nodeIndex", -1));
      case "edges":
        return getHeapSnapshotEdges(
          file,
          num("nodeIndex", -1),
          num("limit", 50),
        );
      case "retainers":
        return getHeapSnapshotRetainers(
          file,
          num("nodeIndex", -1),
          num("limit", 50),
        );
      case "paths":
        return getHeapSnapshotRetainingPaths(
          file,
          num("nodeIndex", -1),
          num("maxDepth", 6),
          num("maxPaths", 5),
        );
      case "strings":
        return getHeapSnapshotDuplicateStrings(file, num("topN", 20));
      case "compare":
        return compareHeapSnapshots(
          typeof raw.baseFilePath === "string" ? raw.baseFilePath : "",
          typeof raw.currentFilePath === "string" ? raw.currentFilePath : "",
          num("topN", 30),
        );
      default:
        throw new Error(`Unknown heap action: ${String(action)}`);
    }
  });
  // 录屏：CDP 帧采集 + MJPEG AVI 合成（screencast_start / screencast_stop）。
  ipcMain.handle(
    "browser:screencast-start",
    (event, webContentsId: number, options?: unknown) => {
      // IPC event 的 sender getter 不应在 guest 销毁后才读取。
      const sender = event.sender;
      const contents = getBrowserWebContents(webContentsId);
      if (
        contents.hostWebContents?.id !== sender.id ||
        event.senderFrame !== sender.mainFrame
      )
        throw new Error("Browser operation is not owned by this renderer");
      const raw =
        options !== null && typeof options === "object"
          ? (options as Record<string, unknown>)
          : {};
      if (raw.recordingId !== undefined && typeof raw.recordingId !== "string")
        throw new Error("Invalid screencast recordingId");
      return startBrowserScreencast(
        webContentsId,
        {
          filePath: typeof raw.filePath === "string" ? raw.filePath : undefined,
          quality: typeof raw.quality === "number" ? raw.quality : undefined,
          maxWidth: typeof raw.maxWidth === "number" ? raw.maxWidth : undefined,
          maxFrames:
            typeof raw.maxFrames === "number" ? raw.maxFrames : undefined,
          maxDurationMs:
            typeof raw.maxDurationMs === "number"
              ? raw.maxDurationMs
              : undefined,
          recordingId: raw.recordingId as string | undefined,
        },
        (recordingId) => {
          if (!sender.isDestroyed())
            sender.send("browser:screencast-stopped", {
              webContentsId,
              recordingId,
            });
        },
      );
    },
  );
  ipcMain.handle(
    "browser:screencast-stop",
    (event, webContentsId: number, recordingId?: unknown) => {
      const contents = getBrowserWebContents(webContentsId);
      if (
        contents.hostWebContents?.id !== event.sender.id ||
        event.senderFrame !== event.sender.mainFrame
      )
        throw new Error("Browser operation is not owned by this renderer");
      if (
        recordingId !== undefined &&
        (typeof recordingId !== "string" ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(recordingId))
      )
        throw new Error("Invalid screencast recordingId");
      return stopBrowserScreencast(
        webContentsId,
        recordingId as string | undefined,
      );
    },
  );
  // 网络状态模拟：offline=true 离线，false 恢复在线。
  ipcMain.handle(
    "browser:network-state",
    (_event, webContentsId: number, offline: boolean) =>
      setBrowserNetworkState(
        typeof webContentsId === "number" ? webContentsId : -1,
        offline === true,
      ),
  );
  // 路由 mock：设置拦截规则（全量替换；空数组 = 恢复真实网络）。
  ipcMain.handle(
    "browser:route-set",
    (_event, webContentsId: number, rules: unknown) =>
      setBrowserRouteRules(
        typeof webContentsId === "number" ? webContentsId : -1,
        Array.isArray(rules)
          ? (rules as Parameters<typeof setBrowserRouteRules>[1])
          : [],
      ),
  );
  ipcMain.handle("browser:route-clear", (_event, webContentsId: number) =>
    clearBrowserRouteRules(
      typeof webContentsId === "number" ? webContentsId : -1,
    ),
  );
  // 登录态保存：cookie + localStorage → safeStorage 加密落盘（~/.snowapp/browser-state/）。
  ipcMain.handle(
    "browser:storage-save",
    (_event, webContentsId: number, fileName?: string) =>
      saveBrowserStorageState(
        typeof webContentsId === "number" ? webContentsId : -1,
        typeof fileName === "string" ? fileName : undefined,
      ),
  );
  // 登录态恢复：解密 → cookies.set + localStorage 注入（origin 校验）；恢复前自动加密备份。
  ipcMain.handle(
    "browser:storage-restore",
    (_event, webContentsId: number, fileName: string) =>
      restoreBrowserStorageState(
        typeof webContentsId === "number" ? webContentsId : -1,
        typeof fileName === "string" ? fileName : "",
      ),
  );
  // 列出当前会话 cookie（默认脱敏值，showValues=true 返回明文）。
  ipcMain.handle(
    "browser:cookies-list",
    (_event, webContentsId: number, domain?: string, showValues?: boolean) =>
      listBrowserCookies(
        typeof webContentsId === "number" ? webContentsId : -1,
        typeof domain === "string" ? domain : undefined,
        showValues === true,
      ),
  );
  // 删除指定 cookie（name + domain 精确定位）。
  ipcMain.handle(
    "browser:cookie-delete",
    (_event, webContentsId: number, name: string, domain: string) =>
      deleteBrowserCookie(
        typeof webContentsId === "number" ? webContentsId : -1,
        typeof name === "string" ? name : "",
        typeof domain === "string" ? domain : "",
      ),
  );
  ipcMain.handle(
    "browser:network-request",
    (event, webContentsId: number, requestId: number) => {
      const contents = getBrowserWebContents(webContentsId);
      if (
        contents.hostWebContents?.id !== event.sender.id ||
        event.senderFrame !== event.sender.mainFrame
      ) {
        throw new Error("Browser operation is not owned by this renderer");
      }
      if (!Number.isSafeInteger(requestId) || requestId <= 0)
        throw new Error("requestId must be a positive integer");
      return getNetworkRecord(webContentsId, requestId) ?? null;
    },
  );
  ipcMain.handle("browser:network-clear", (_event, webContentsId: number) => {
    const cleared = clearNetworkRecords(
      typeof webContentsId === "number" ? webContentsId : -1,
    );
    return { cleared };
  });

  // Dialogs share the recorder's Page event listener; only the owning host main frame may respond.
  ipcMain.handle(
    "browser:dialogs-list",
    async (event, webContentsId: number) => {
      const contents = getBrowserWebContents(webContentsId);
      if (
        contents.hostWebContents?.id !== event.sender.id ||
        event.senderFrame !== event.sender.mainFrame
      ) {
        throw new Error("Browser operation is not owned by this renderer");
      }
      await ensureWebContentsDebugger(contents);
      if (!contents.debugger.isAttached())
        throw new Error("Browser debugger is unavailable");
      return listBrowserDialogs(webContentsId);
    },
  );
  ipcMain.handle(
    "browser:dialog-respond",
    (
      event,
      webContentsId: number,
      accept: unknown,
      promptText?: unknown,
      dialogId?: unknown,
    ) => {
      const contents = getBrowserWebContents(webContentsId);
      if (
        contents.hostWebContents?.id !== event.sender.id ||
        event.senderFrame !== event.sender.mainFrame
      ) {
        throw new Error("Browser operation is not owned by this renderer");
      }
      if (
        typeof accept !== "boolean" ||
        (promptText !== undefined && typeof promptText !== "string") ||
        (dialogId !== undefined && typeof dialogId !== "string")
      ) {
        throw new Error("Invalid JavaScript dialog response");
      }
      return respondBrowserDialog(
        contents,
        accept,
        promptText,
        dialogId || undefined,
      );
    },
  );

  // ===== 浏览器下载管理 =====
  ipcMain.handle("browser:downloads-list", () => listDownloads());
  ipcMain.handle("browser:download-open", (_event, id: unknown) =>
    openDownload(typeof id === "number" ? id : -1),
  );
  ipcMain.handle("browser:download-show-in-folder", (_event, id: unknown) => {
    showDownloadInFolder(typeof id === "number" ? id : -1);
    return true;
  });
  ipcMain.handle("browser:download-cancel", (_event, id: unknown) =>
    cancelDownload(typeof id === "number" ? id : -1),
  );

  // ===== 独立面板窗口（右侧面板 tab「在新窗口中打开」/「移回主窗口」）=====
  // 打开：主窗口已把 tab 快照交给主进程，这里创建承载窗口（终端会话随之交接保留）。
  ipcMain.handle("detached-panel:open", (_event, payload: unknown): void => {
    const record =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : null;
    const tab = parseDetachedTabPayload(record?.tab);
    if (!tab) {
      throw new Error("A valid detached panel tab is required");
    }
    openDetachedPanelWindow({
      tab,
      activeDirectory: record?.activeDirectory ?? null,
    });
  });

  // 面板窗口渲染后凭 token 取回初始化 payload。
  ipcMain.handle("detached-panel:take", (_event, token: unknown) =>
    typeof token === "string" ? takeDetachedPanelPayload(token) : null,
  );

  // 运行时快照镜像：仅主窗口可以发布（独立窗口只消费），主进程缓存并转发给所有独立窗口。
  ipcMain.handle(
    "detached-panel:runtime-mirror-publish",
    (event, mirror: unknown): void => {
      const mainWindow = getMainWindow();
      if (!mainWindow || event.sender !== mainWindow.webContents) {
        return;
      }
      if (!mirror || typeof mirror !== "object" || Array.isArray(mirror)) {
        return;
      }
      publishDetachedRuntimeMirror(mirror as Record<string, unknown>);
    },
  );

  // 独立窗口挂载时取回最近一份运行时快照镜像。
  ipcMain.handle("detached-panel:runtime-mirror-take", () =>
    takeDetachedRuntimeMirror(),
  );

  // 移回主窗口：转发 tab 快照给主窗口恢复为 tab。返回 false 表示主窗口不可用，
  // 调用方据此保留源窗口中的 tab。
  ipcMain.handle(
    "detached-panel:return",
    (_event, payload: unknown): boolean => {
      const tab = parseDetachedTabPayload(payload);
      if (!tab) {
        return false;
      }
      const mainWindow = getMainWindow();
      if (!mainWindow || mainWindow.isDestroyed()) {
        return false;
      }
      reserveDetachedTabPty(tab);
      if (!mainWindow.isVisible()) {
        mainWindow.show();
      }
      mainWindow.focus();
      safeSend(mainWindow.webContents, "detached-panel:return-broadcast", tab);
      return true;
    },
  );

  // 会话归属（独立窗口的会话 tab 与运行中会话）：主窗口据此拦截点击、释放缓存。
  subscribeDetachedConversationOwners((conversationIds) => {
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      safeSend(
        mainWindow.webContents,
        DETACHED_PANEL_CONVERSATION_OWNERS_BROADCAST_CHANNEL,
        conversationIds,
      );
    }
  });

  // 独立窗口上报其归属会话 id（tab 中的会话与运行中的会话）。
  ipcMain.handle(
    "detached-panel:report-conversations",
    (event, conversationIds: unknown): void => {
      if (!Array.isArray(conversationIds)) {
        return;
      }
      const ids = conversationIds.filter(
        (id): id is string => typeof id === "string" && id.trim() !== "",
      );
      reportDetachedPanelConversationIds(event.sender, ids);
    },
  );

  // 主窗口点击已归属会话：聚焦所在独立窗口。返回 false 表示无归属窗口，调用方按普通会话加载。
  ipcMain.handle(
    "detached-panel:focus-conversation",
    (_event, conversationId: unknown): boolean =>
      typeof conversationId === "string" &&
      focusDetachedPanelConversation(conversationId),
  );

  // 快捷键循环切换独立会话窗口（主窗口与独立窗口的渲染端均可触发）。返回 false 表示当前没有独立窗口。
  ipcMain.handle("detached-panel:focus-next", (): boolean =>
    focusNextDetachedPanelWindow(),
  );

  // 主窗口挂载时取回当前归属会话 id。
  ipcMain.handle("detached-panel:conversation-owners-take", (): string[] =>
    getDetachedConversationIds(),
  );

  // 独立窗口内的会话列表 / 树形数据变化：通知主窗口重新拉取侧边栏数据。
  ipcMain.handle("detached-panel:conversation-list-changed", (event): void => {
    if (!isDetachedPanelWebContents(event.sender)) {
      return;
    }
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      safeSend(
        mainWindow.webContents,
        DETACHED_PANEL_CONVERSATION_LIST_BROADCAST_CHANNEL,
      );
    }
  });

  // 渲染端用户确认关闭独立窗口后调用：标记并真正关闭（窗口无标签页时也由此直接关闭，无需确认）。
  ipcMain.handle("detached-panel:confirm-close", (event): void => {
    confirmDetachedPanelClose(event.sender);
  });
};
