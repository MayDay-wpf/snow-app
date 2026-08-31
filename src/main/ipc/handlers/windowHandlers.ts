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
import {
  APP_FAVICON_32_PATH,
  APP_WINDOW_ICON_PATH,
  isMacOS,
} from "../../app/constants";
import { markCloseConfirmed, getMainWindow } from "../../app/mainWindow";
import { refreshTrayStats } from "../../app/tray";
import { registerToggleWindowShortcut } from "../../app/globalShortcuts";
import { clearWindowState } from "../../app/windowState";
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
  cancelDownload,
  listDownloads,
  openDownload,
  showDownloadInFolder,
} from "../../app/downloadManager";
import {
  deleteBrowserCookie,
  listBrowserCookies,
  restoreBrowserStorageState,
  saveBrowserStorageState,
} from "./browserStorageState";
import { runBrowserTrace } from "./browserTrace";
import { createDetachedBrowserWindow } from "../../browser/browserWindow";

const browserDevToolsWindows = new Map<number, BrowserWindow>();

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
  // ===== Window Controls (Windows custom titlebar) =====
  ipcMain.handle("window:minimize", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });

  // 关闭提醒中的"最小化"选项：隐藏窗口而非退出。
  // Windows/Linux 隐藏到系统托盘；macOS 同时移除 Dock 图标（仅保留菜单栏托盘），
  // 从托盘恢复时（tray.ts showMainWindow）会重新显示 Dock 图标。
  ipcMain.handle("window:hide-to-tray", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) {
      return;
    }
    win.hide();
    if (process.platform === "darwin") {
      app.dock?.hide();
    }
    // 隐藏后立即刷新托盘悬停信息，保证用户第一时间看到最新状态。
    refreshTrayStats();
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

  // 渲染进程保存快捷键设置后调用：重新读取数据库并注册/注销
  // 显示/隐藏窗口的全局快捷键（toggleWindow）。
  ipcMain.handle("shortcuts:reload-global", () =>
    registerToggleWindowShortcut(_native),
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

  // ===== Shell (file manager reveal) =====
  // 在系统文件管理器中显示文件（Windows 资源管理器 / macOS Finder / Linux
  // 文件管理器），文件会高亮选中；传入目录时直接打开该目录。
  ipcMain.handle("shell:show-item-in-folder", (_event, path: unknown) => {
    if (typeof path !== "string" || !path.trim()) {
      throw new Error("A valid path is required");
    }
    shell.showItemInFolder(path);
  });

  // ===== Browser (embedded webview) =====
  ipcMain.handle("browser:clear-cache", async () => {
    await session.defaultSession.clearCache();
  });

  ipcMain.handle("browser:clear-cookies", async () => {
    await session.defaultSession.clearStorageData({ storages: ["cookies"] });
  });

  // 右侧面板浏览器 tab「在新窗口中打开」：创建独立 BrowserWindow 承载
  // 同一实例（继承 instanceId），tabs（实例内部全部标签页快照，激活页置首）
  // 经 query 传给独立窗口入口重建完整标签页。原 tab 由渲染端在成功后关闭。
  ipcMain.handle(
    "browser:open-detached-window",
    (_event, instanceId: unknown, url: unknown, tabs: unknown) => {
      if (typeof instanceId !== "string" || !instanceId.trim()) {
        throw new Error("A valid browser instanceId is required");
      }
      if (typeof url !== "string") {
        throw new Error("A valid browser URL is required");
      }
      const tabSnapshot = Array.isArray(tabs)
        ? tabs.filter(
            (tab): tab is { url: string; title: string } =>
              !!tab &&
              typeof tab === "object" &&
              typeof (tab as Record<string, unknown>).url === "string" &&
              typeof (tab as Record<string, unknown>).title === "string",
          )
        : undefined;
      createDetachedBrowserWindow(instanceId.trim(), url.trim(), tabSnapshot);
    },
  );

  // 独立浏览器窗口「还原为标签页」：把实例（含全部内部标签页）转发给
  // 主窗口恢复为右侧面板浏览器 tab，随后关闭发起请求的独立窗口。
  // 实例保持原 instanceId，浏览器命令经 browserCommandBroker 按实例
  // 归属路由，主窗口新 tab 挂载上报后自动接管。
  ipcMain.on("browser:restore-to-main", (event, payload: unknown) => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return;
    }
    const record = payload as Record<string, unknown>;
    const instanceId = record.instanceId;
    if (typeof instanceId !== "string" || !instanceId.trim()) {
      return;
    }
    const rawTabs = record.tabs;
    if (
      !Array.isArray(rawTabs) ||
      !rawTabs.every(
        (tab) =>
          !!tab &&
          typeof tab === "object" &&
          typeof (tab as Record<string, unknown>).url === "string",
      )
    ) {
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
    mainWindow.webContents.send("browser:restore-to-main-broadcast", payload);
    // 关闭发起请求的独立浏览器窗口（还原即迁移，原窗口使命结束）。
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    if (
      senderWindow &&
      !senderWindow.isDestroyed() &&
      senderWindow !== mainWindow
    ) {
      senderWindow.close();
    }
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
      typeof (tag as Record<string, unknown>).note !== "string"
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
    async (
      _event,
      webContentsId: number,
      filter?: string,
      limit?: number,
      includeStatic?: boolean,
    ) => {
      const id = typeof webContentsId === "number" ? webContentsId : -1;
      if (id >= 0) {
        await ensureNetworkRecording(getBrowserWebContents(id));
      }
      return queryNetworkRecords(
        id,
        typeof filter === "string" ? filter : undefined,
        typeof limit === "number" ? limit : 50,
        includeStatic === true,
      );
    },
  );
  // 网络请求详情：请求/响应头 + 请求体 + 响应体（基于 CDP 记录中的 requestId）。
  ipcMain.handle(
    "browser:network-details",
    (_event, webContentsId: number, requestId: string, maxBodyBytes?: number) =>
      queryNetworkDetails(
        typeof webContentsId === "number" ? webContentsId : -1,
        typeof requestId === "string" ? requestId : "",
        typeof maxBodyBytes === "number" ? maxBodyBytes : undefined,
      ),
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
  // 登录态保存：cookie + localStorage → safeStorage 加密落盘（~/.snow/browser-state/）。
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
  ipcMain.handle("browser:network-request", (_event, recordId: number) => {
    const record = getNetworkRecord(
      typeof recordId === "number" ? recordId : -1,
    );
    return record ?? null;
  });
  ipcMain.handle("browser:network-clear", (_event, webContentsId: number) => {
    const cleared = clearNetworkRecords(
      typeof webContentsId === "number" ? webContentsId : -1,
    );
    return { cleared };
  });

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
};
