import {
  app,
  BrowserWindow,
  ipcMain,
  nativeTheme,
  type WebContents,
} from "electron";
import { APP_WINDOW_ICON_PATH } from "../app/constants";

/**
 * 内置浏览器（<webview>）弹出窗口与标签页管理。
 *
 * 背景：guest 页面调用 window.open() 或点击 target=_blank 时（典型场景如
 * Google 账号登录弹出的 OAuth 窗口），Electron 37 的 <webview> 标签已不再
 * 触发 new-window 事件（该事件已从 API 中移除）。且 webview guest 默认
 * disablePopups=true（除非标签带 allowpopups 属性），window.open 会被
 * Chromium 直接拦截返回 null，根本不会到达任何 handler —— 因此渲染端
 * <webview> 必须声明 allowpopups（注意 React 18 会丢弃未知 boolean 属性，
 * 须用字符串值/ref callback 写入，见 BrowserPanelContent.tsx），请求才会
 * 进入下面的处理流程。
 *
 * 这里在 guest webContents 上注册 setWindowOpenHandler，按打开方式分流：
 *
 * 1. 窗口级弹出（disposition 为 new-popup，或 features 显式声明
 *    popup=yes / width / height，如 OAuth 弹窗）：
 *    返回 { action: "allow", overrideBrowserWindowOptions }，由 Electron
 *    创建真正的弹出 BrowserWindow：
 *      - 保留 window.opener / postMessage 关系（OAuth 弹出登录依赖它）；
 *      - 与 webview 共享同一 session（cookie 同步，登录态互通）；
 *      - 弹出窗口内的二次 window.open 递归走同一逻辑。
 *
 * 2. 标签页级打开（target=_blank、window.open 无 features 等）：
 *    侧边浏览器已在渲染端实现标签页维度，此类请求不再弹真实窗口，
 *    而是返回 { action: "deny" }，并通过 IPC 通知宿主渲染进程在
 *    BrowserPanelContent 内部新建一个标签页（由 guest 的 webContents id
 *    路由到对应的浏览器实例）。这样 _blank 链接会在侧边栏内以标签页
 *    形式打开，而不是突兀地弹出一个独立窗口。
 *
 * 注意：webview guest 内**用户点击** target=_blank 链接因 Electron bug
 * （electron#30886）不会触发 setWindowOpenHandler —— 该场景由 guest
 * preload（webviewBrowserPreload）在捕获阶段拦截点击后经
 * browser:guest-open-tab IPC 中继到 notifyHostOpenTab（同一路由与去重），
 * 两条上报路径在此汇合，见 OPEN_TAB_NOTIFY_DEDUPE_MS。
 */

const DEFAULT_POPUP_WIDTH = 800;
const DEFAULT_POPUP_HEIGHT = 640;
const MIN_POPUP_WIDTH = 320;
const MIN_POPUP_HEIGHT = 240;
const MAX_POPUP_WIDTH = 1600;
const MAX_POPUP_HEIGHT = 1200;

/** 通知宿主渲染进程：guest 请求在侧边浏览器内新建标签页。 */
export const BROWSER_OPEN_TAB_CHANNEL = "browser:open-tab";

/** guest preload（webviewBrowserPreload）拦截 target=_blank 链接后发送的通道。 */
const GUEST_OPEN_TAB_CHANNEL = "browser:guest-open-tab";

/**
 * 短时间窗口内同 guest 同 URL 的「新建标签页」通知去重。
 *
 * target=_blank 链接的激活有两路上报：guest preload 拦截点击
 * （browser:guest-open-tab，绕过 electron#30886 —— webview 内点击
 * target=_blank 不触发 setWindowOpenHandler），以及主进程
 * setWindowOpenHandler（JS window.open 等场景）。未来 Electron 修复
 * 该 bug 后链接点击会两路同时到达，这里按 guestId+url 去重，
 * 避免在侧边浏览器内重复开两个标签页。
 */
const OPEN_TAB_NOTIFY_DEDUPE_MS = 300;
const recentOpenTabNotifies = new Map<string, number>();

/** 把「在侧边浏览器内新建标签页」通知转发给 guest 的宿主窗口渲染进程。 */
const notifyHostOpenTab = (
  guest: WebContents,
  url: string,
  disposition: string,
): void => {
  const host = guest.hostWebContents;
  if (!host || host.isDestroyed()) {
    return;
  }
  const key = `${guest.id}\u0000${url}`;
  const now = Date.now();
  const last = recentOpenTabNotifies.get(key);
  if (last !== undefined && now - last < OPEN_TAB_NOTIFY_DEDUPE_MS) {
    return;
  }
  recentOpenTabNotifies.set(key, now);
  if (recentOpenTabNotifies.size > 128) {
    // 简单防膨胀：超阈值时清理过期项。
    for (const [expiredKey, time] of recentOpenTabNotifies) {
      if (now - time >= OPEN_TAB_NOTIFY_DEDUPE_MS) {
        recentOpenTabNotifies.delete(expiredKey);
      }
    }
  }
  host.send(BROWSER_OPEN_TAB_CHANNEL, {
    guestWebContentsId: guest.id,
    url,
    disposition,
  });
};

const popupWindows = new Set<BrowserWindow>();

const getPopupBackgroundColor = (): string =>
  nativeTheme.shouldUseDarkColors ? "#0a0a0a" : "#ffffff";

/** 解析 window.open() features 字符串中的宽高（如 "popup=yes,width=500,height=600"）。 */
const parseWindowFeatures = (
  features: string,
): { width: number; height: number } => {
  const widthMatch = /(?:^|,)\s*width\s*=\s*(\d+)/i.exec(features);
  const heightMatch = /(?:^|,)\s*height\s*=\s*(\d+)/i.exec(features);
  const clamp = (value: number, min: number, max: number): number =>
    Math.min(Math.max(value, min), max);
  return {
    width: widthMatch
      ? clamp(parseInt(widthMatch[1], 10), MIN_POPUP_WIDTH, MAX_POPUP_WIDTH)
      : DEFAULT_POPUP_WIDTH,
    height: heightMatch
      ? clamp(parseInt(heightMatch[1], 10), MIN_POPUP_HEIGHT, MAX_POPUP_HEIGHT)
      : DEFAULT_POPUP_HEIGHT,
  };
};

/** 相对发起窗口居中计算弹出窗口位置（发起窗口不可见时交给系统默认定位）。 */
const computeCenteredPosition = (
  opener: BrowserWindow | null,
  width: number,
  height: number,
): { x: number; y: number } | undefined => {
  if (!opener || opener.isDestroyed() || opener.isMinimized()) {
    return undefined;
  }
  const bounds = opener.getBounds();
  return {
    x: Math.round(bounds.x + (bounds.width - width) / 2),
    y: Math.round(bounds.y + (bounds.height - height) / 2),
  };
};

/**
 * 判断一次 window.open / target=_blank 是否属于「窗口级弹出」。
 *
 * 窗口级弹出 = 调用方显式要求独立窗口（disposition 为 new-popup，或
 * features 里声明 popup=yes / width / height）。这类请求（典型如 OAuth
 * 登录弹窗）需要保留 window.opener 关系，创建真实 BrowserWindow。
 *
 * 其余（target=_blank 链接、window.open 无 features）语义上都是「新标签
 * 页」，交由渲染端在侧边浏览器内部打开。
 */
const isWindowPopupRequest = (
  disposition: string,
  features: string,
): boolean => {
  if (disposition === "new-popup") {
    return true;
  }
  if (/\bpopup\s*=\s*(?:yes|1|true)/i.test(features)) {
    return true;
  }
  if (/\b(?:width|height)\s*=/.test(features)) {
    return true;
  }
  return false;
};

/**
 * 为指定 webContents（webview guest 或已创建的弹出窗口）注册弹出处理：
 * 窗口级弹出创建真实 BrowserWindow；标签页级打开 deny 并通知渲染端建 tab。
 */
export const attachBrowserPopupWindowHandler = (
  contents: WebContents,
  options?: { openTabsInSidebar?: boolean },
): void => {
  contents.setWindowOpenHandler(({ url, disposition, features }) => {
    // 侧边浏览器 webview：非窗口级弹出一律在侧边栏内新建标签页，
    // 由渲染端 BrowserPanelContent 根据 guest webContents id 路由。
    if (
      options?.openTabsInSidebar &&
      !isWindowPopupRequest(disposition, features)
    ) {
      notifyHostOpenTab(contents, url, disposition);
      return { action: "deny" };
    }

    const { width, height } = parseWindowFeatures(features);
    const opener = BrowserWindow.fromWebContents(contents);
    return {
      action: "allow",
      overrideBrowserWindowOptions: {
        ...computeCenteredPosition(opener, width, height),
        width,
        height,
        minWidth: MIN_POPUP_WIDTH,
        minHeight: MIN_POPUP_HEIGHT,
        icon: APP_WINDOW_ICON_PATH,
        autoHideMenuBar: true,
        backgroundColor: getPopupBackgroundColor(),
        show: false,
        webPreferences: {
          // 弹出窗口是纯网页，无需 Node 能力，保持沙箱开启。
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      },
    };
  });

  // did-create-window 仅在 setWindowOpenHandler 返回 allow 且窗口创建成功时触发。
  contents.on("did-create-window", (win) => {
    popupWindows.add(win);
    win.setMenu(null);
    win.setMenuBarVisibility(false);
    // 等待首帧渲染后再显示，避免白屏闪烁。
    win.once("ready-to-show", () => {
      if (!win.isDestroyed()) {
        win.show();
      }
    });
    win.once("closed", () => {
      popupWindows.delete(win);
    });
    // 弹出窗口内的 window.open 递归走同一处理逻辑。
    // 注意：不传 openTabsInSidebar —— 弹出窗口内的 target=_blank / window.open
    // 继续创建新的弹出窗口（保持 window.opener 链，OAuth 流程中二次弹窗常见），
    // 不会错误地路由到侧边浏览器的标签页（该 guest 的 webContents id 不在
    // 渲染端任何浏览器实例的注册表里）。
    attachBrowserPopupWindowHandler(win.webContents);
  });
};

/** 初始化：为所有 webview guest 注册弹出处理（幂等）。 */
export const initBrowserPopupHandler = (): void => {
  // guest preload 拦截 target=_blank / 中键链接激活后的中继：
  // 校验 sender 必须是 webview guest（guest 页面受 contextIsolation 保护
  // 无法直接触达 ipcRenderer，伪造消息也在此被拒），转发给宿主窗口由
  // 渲染端在侧边浏览器内新建标签页。绕过 electron#30886。
  ipcMain.on(GUEST_OPEN_TAB_CHANNEL, (event, payload) => {
    const guest = event.sender;
    if (
      guest.getType() !== "webview" ||
      !payload ||
      typeof payload !== "object"
    ) {
      return;
    }
    const record = payload as { url?: unknown; disposition?: unknown };
    if (typeof record.url !== "string" || !record.url) {
      return;
    }
    notifyHostOpenTab(
      guest,
      record.url,
      typeof record.disposition === "string"
        ? record.disposition
        : "foreground-tab",
    );
  });

  app.on("web-contents-created", (_event, contents) => {
    if (contents.getType() !== "webview") {
      return;
    }
    // webview guest 启用标签页分流：窗口级弹出建真实窗口，
    // 其余打开方式由渲染端在侧边浏览器内部新建标签页。
    attachBrowserPopupWindowHandler(contents, { openTabsInSidebar: true });
  });
};

/** 关闭所有浏览器弹出窗口（主窗口关闭时调用，避免 macOS 残留孤儿窗口）。 */
export const closeAllBrowserPopups = (): void => {
  for (const win of popupWindows) {
    if (!win.isDestroyed()) {
      win.close();
    }
  }
  popupWindows.clear();
};
