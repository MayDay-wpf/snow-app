import {
  ipcMain,
  net,
  Notification,
  session,
  webContents as electronWebContents,
  type WebContents,
} from "electron";
import type { NativeBridge, UserscriptRecord } from "../../native/types";
import { startGmDownload } from "../../app/downloadManager";
import {
  refreshUserscriptSyncStore,
  updateCachedValue,
} from "../../app/userscriptSyncStore";

/**
 * 用户脚本（油猴兼容）IPC 通道。
 *
 * - 脚本管理 CRUD 转发到 Rust 存储（异步 spawn_blocking，不阻塞主进程）。
 * - Greasy Fork 搜索/安装用 `net.fetch`（Chromium 网络栈，异步非阻塞，
 *   自动跟随会话代理配置）。
 * - GM_* API 桥：webview preload 里的引擎运行时通过 IPC 调用主进程能力
 *   （存储 / 网络 / 通知 / 剪贴板），见 webviewBrowserPreload.ts。
 */

/** Greasy Fork 搜索 API 的单条结果（与 scripts.json 返回结构对齐）。 */
export type GreasyForkSearchItem = {
  name: string;
  description: string;
  totalInstalls: number;
  dailyInstalls: number;
  url: string;
  codeUrl: string;
  namespace: string;
  updatedAt: string;
  ratingScore: number;
};

/** Greasy Fork 搜索响应（归一化后）。 */
export type GreasyForkSearchResult = {
  total: number;
  results: GreasyForkSearchItem[];
};

const GREASY_FORK_SEARCH_URL = "https://api.greasyfork.org/zh-CN/scripts.json";
const SEARCH_TIMEOUT_MS = 15000;
const INSTALL_TIMEOUT_MS = 20000;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

/** 归一化 Greasy Fork 原始 JSON 结果（新版 Sphinx 搜索 API：query 数组，无 total 字段）。 */
const normalizeSearchItem = (raw: unknown): GreasyForkSearchItem | null => {
  if (raw === null || typeof raw !== "object") {
    return null;
  }
  const item = raw as Record<string, unknown>;
  const name = item.name;
  const codeUrl = item.code_url;
  if (!isNonEmptyString(name) || !isNonEmptyString(codeUrl)) {
    return null;
  }
  return {
    name,
    description: isNonEmptyString(item.description) ? item.description : "",
    totalInstalls:
      typeof item.total_installs === "number" ? item.total_installs : 0,
    dailyInstalls:
      typeof item.daily_installs === "number" ? item.daily_installs : 0,
    url: isNonEmptyString(item.url) ? item.url : "",
    codeUrl,
    namespace: isNonEmptyString(item.namespace) ? item.namespace : "",
    updatedAt: isNonEmptyString(item.code_updated_at)
      ? item.code_updated_at
      : "",
    ratingScore: (() => {
      const raw = item.fan_score;
      const score =
        typeof raw === "string"
          ? parseFloat(raw)
          : typeof raw === "number"
            ? raw
            : NaN;
      return isFinite(score) ? score : 0;
    })(),
  };
};

// ===== GM 运行时状态（菜单命令 / 值监听 / Tab 存储，按 webContents 维度）=====

/** GM_registerMenuCommand 注册的菜单命令。 */
type UserscriptMenuCommand = {
  scriptId: string;
  title: string;
  accessKey: string;
};

type UserscriptRuntimeState = {
  commands: Map<number, UserscriptMenuCommand>;
  listeners: Map<number, { scriptId: string; key: string }>;
  tabData: unknown;
  nextCommandId: number;
};

const runtimeByContents = new Map<number, UserscriptRuntimeState>();

const getRuntime = (contentsId: number): UserscriptRuntimeState => {
  let state = runtimeByContents.get(contentsId);
  if (!state) {
    state = {
      commands: new Map(),
      listeners: new Map(),
      tabData: undefined,
      nextCommandId: 1,
    };
    runtimeByContents.set(contentsId, state);
  }
  return state;
};

const contentsCleanupBound = new WeakSet<WebContents>();

/** GM_notification 自增 id（点击/失败事件回传关联）。 */
let nextNotificationId = 1;

/** webContents 销毁时清理其运行时状态（菜单 / 监听器 / Tab 数据）。 */
const bindContentsCleanup = (contents: WebContents): void => {
  if (contentsCleanupBound.has(contents)) {
    return;
  }
  contentsCleanupBound.add(contents);
  contents.once("destroyed", () => {
    runtimeByContents.delete(contents.id);
  });
};

/** 右键菜单获取当前 guest 的脚本命令列表（按注册顺序）。 */
export const getUserscriptMenuCommands = (
  contentsId: number,
): { id: number; title: string }[] => {
  const state = runtimeByContents.get(contentsId);
  if (!state) {
    return [];
  }
  return Array.from(state.commands.entries()).map(([id, command]) => ({
    id,
    title: command.title,
  }));
};

/** 右键菜单点击脚本命令：转发到 guest 的 preload → 主世界回调。 */
export const invokeUserscriptMenuCommand = (
  contents: WebContents,
  commandId: number,
): void => {
  if (contents.isDestroyed()) {
    return;
  }
  contents.send("userscripts:menu-command", commandId);
};

/** 广播 GM 值变更给其他标签页上注册了该 (scriptId, key) 的监听器。 */
const broadcastValueChange = (
  senderId: number,
  scriptId: string,
  key: string,
  oldValue: string | undefined,
  newValue: string | undefined,
): void => {
  for (const [contentsId, state] of runtimeByContents) {
    if (contentsId === senderId) {
      // Tampermonkey 语义：本标签页写入不触发本标签页的监听器。
      continue;
    }
    for (const [listenerId, listener] of state.listeners) {
      if (listener.scriptId !== scriptId || listener.key !== key) {
        continue;
      }
      const contents = getAllWebContents().find((c) => c.id === contentsId);
      if (contents && !contents.isDestroyed()) {
        contents.send("userscripts:value-changed", {
          listenerId,
          key,
          oldValue,
          newValue,
        });
      }
    }
  }
};

/** 收集当前所有存活的 webContents（含 webview guest）。 */
const getAllWebContents = (): WebContents[] =>
  electronWebContents.getAllWebContents();

export const registerUserscriptHandlers = (native: NativeBridge): void => {
  // ===== 脚本管理 CRUD =====

  ipcMain.handle("userscripts:list", (): Promise<UserscriptRecord[]> =>
    native.listUserscripts(),
  );

  ipcMain.handle("userscripts:read-source", (_event, scriptId: unknown) => {
    if (!isNonEmptyString(scriptId)) {
      throw new Error("Userscript id is required");
    }
    return native.readUserscriptSource(scriptId);
  });

  ipcMain.handle("userscripts:create", (_event, raw: unknown) => {
    if (!isNonEmptyString(raw)) {
      throw new Error("Userscript source is required");
    }
    return native.createUserscript(raw).then((record) => {
      refreshUserscriptSyncStore(native);
      return record;
    });
  });

  ipcMain.handle(
    "userscripts:update",
    (_event, scriptId: unknown, raw: unknown) => {
      if (!isNonEmptyString(scriptId)) {
        throw new Error("Userscript id is required");
      }
      if (!isNonEmptyString(raw)) {
        throw new Error("Userscript source is required");
      }
      return native.updateUserscript(scriptId, raw).then((record) => {
        refreshUserscriptSyncStore(native);
        return record;
      });
    },
  );

  ipcMain.handle("userscripts:delete", (_event, scriptId: unknown) => {
    if (!isNonEmptyString(scriptId)) {
      throw new Error("Userscript id is required");
    }
    return native.deleteUserscript(scriptId).then((result) => {
      refreshUserscriptSyncStore(native);
      return result;
    });
  });

  ipcMain.handle(
    "userscripts:set-enabled",
    (_event, scriptId: unknown, enabled: unknown) => {
      if (!isNonEmptyString(scriptId)) {
        throw new Error("Userscript id is required");
      }
      const result = native.setUserscriptEnabled(scriptId, enabled === true);
      refreshUserscriptSyncStore(native);
      return result;
    },
  );

  // ===== Greasy Fork 搜索 / 安装 =====

  ipcMain.handle(
    "userscripts:search",
    async (
      _event,
      query: unknown,
      perPage: unknown,
    ): Promise<GreasyForkSearchResult> => {
      const keyword = isNonEmptyString(query) ? query.trim() : "";
      if (!keyword) {
        return { total: 0, results: [] };
      }
      const size = Math.min(Math.max(Number(perPage) || 20, 1), 50);
      const params = new URLSearchParams({
        q: keyword,
        per_page: String(size),
        sort: "total_installs",
      });
      const response = await net.fetch(
        `${GREASY_FORK_SEARCH_URL}?${params.toString()}`,
        {
          signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
          headers: { Accept: "application/json" },
        },
      );
      if (!response.ok) {
        throw new Error(`Greasy Fork search failed (${response.status})`);
      }
      const data = (await response.json()) as {
        query?: unknown;
        term?: unknown;
      };
      const results = Array.isArray(data.query)
        ? data.query
            .map(normalizeSearchItem)
            .filter((item): item is GreasyForkSearchItem => item !== null)
        : [];
      return {
        total: results.length,
        results,
      };
    },
  );

  // 下载 .user.js 内容并创建用户脚本。
  ipcMain.handle(
    "userscripts:install",
    async (_event, codeUrl: unknown): Promise<UserscriptRecord> => {
      if (!isNonEmptyString(codeUrl)) {
        throw new Error("Script download url is required");
      }
      if (!/^https:\/\//i.test(codeUrl)) {
        throw new Error("Only https download urls are allowed");
      }
      const response = await net.fetch(codeUrl, {
        signal: AbortSignal.timeout(INSTALL_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`Script download failed (${response.status})`);
      }
      const raw = await response.text();
      if (!raw.includes("==UserScript==")) {
        throw new Error("Downloaded content is not a userscript");
      }
      return native.createUserscript(raw).then((record) => {
        refreshUserscriptSyncStore(native);
        return record;
      });
    },
  );

  // ===== GM_* API 桥（webview preload 调用） =====

  ipcMain.handle("userscripts:gm-get-values", (_event, scriptId: unknown) => {
    if (!isNonEmptyString(scriptId)) {
      throw new Error("Userscript id is required");
    }
    return native.getUserscriptValues(scriptId);
  });

  ipcMain.handle(
    "userscripts:gm-set-value",
    async (
      _event,
      scriptId: unknown,
      key: unknown,
      value: unknown,
      oldValue?: unknown,
    ) => {
      if (!isNonEmptyString(scriptId) || !isNonEmptyString(key)) {
        throw new Error("Userscript id and key are required");
      }
      const newValue = String(value);
      const result = await native.setUserscriptValue(scriptId, key, newValue);
      updateCachedValue(scriptId, key, newValue);
      broadcastValueChange(
        _event.sender.id,
        scriptId,
        key,
        typeof oldValue === "string" ? oldValue : undefined,
        newValue,
      );
      return result;
    },
  );

  ipcMain.handle(
    "userscripts:gm-delete-value",
    (
      _event,
      scriptId: unknown,
      key: unknown,
      oldValue?: unknown,
    ): Promise<void> => {
      if (!isNonEmptyString(scriptId) || !isNonEmptyString(key)) {
        throw new Error("Userscript id and key are required");
      }
      updateCachedValue(scriptId, key, undefined);
      broadcastValueChange(
        _event.sender.id,
        scriptId,
        key,
        typeof oldValue === "string" ? oldValue : undefined,
        undefined,
      );
      return native.deleteUserscriptValue(scriptId, key);
    },
  );

  // GM_notification：主进程创建系统通知（webview preload 无法直接用
  // Electron 的 Notification，统一经 IPC 桥接）。点击事件回传给脚本
  // （details.onclick）。
  ipcMain.handle(
    "userscripts:gm-notification",
    (event, payload: unknown): number => {
      const { title, body } = (payload ?? {}) as {
        title?: unknown;
        body?: unknown;
      };
      const titleText =
        typeof title === "string" && title ? title : "Userscript";
      const bodyText = typeof body === "string" ? body : "";
      const notificationId = ++nextNotificationId;
      const sender = event.sender;
      const notification = new Notification({
        title: titleText,
        body: bodyText,
      });
      notification.on("click", () => {
        if (!sender.isDestroyed()) {
          sender.send("userscripts:notification-clicked", notificationId);
        }
      });
      notification.on("failed", () => {
        if (!sender.isDestroyed()) {
          sender.send("userscripts:notification-failed", notificationId);
        }
      });
      notification.show();
      return notificationId;
    },
  );

  // GM_cookie：session cookies 查询/设置/删除（Tampermonkey beta API）。
  ipcMain.handle(
    "userscripts:gm-cookie-list",
    async (
      event,
      details: {
        url?: unknown;
        domain?: unknown;
        name?: unknown;
        path?: unknown;
      },
    ): Promise<unknown> => {
      void event;
      const query: Electron.CookiesGetFilter = {};
      if (isNonEmptyString(details?.url)) {
        query.url = details.url;
      }
      if (isNonEmptyString(details?.domain)) {
        query.domain = details.domain;
      }
      if (isNonEmptyString(details?.name)) {
        query.name = details.name;
      }
      if (isNonEmptyString(details?.path)) {
        query.path = details.path;
      }
      const cookies = await session.defaultSession.cookies.get(query);
      return cookies.map((cookie) => ({
        domain: cookie.domain,
        expirationDate: cookie.expirationDate,
        hostOnly: cookie.hostOnly,
        httpOnly: cookie.httpOnly,
        name: cookie.name,
        path: cookie.path,
        sameSite: cookie.sameSite,
        secure: cookie.secure,
        session: cookie.session,
        value: cookie.value,
      }));
    },
  );

  ipcMain.handle(
    "userscripts:gm-cookie-set",
    async (_event, details: Record<string, unknown>): Promise<boolean> => {
      if (!isNonEmptyString(details?.url) || !isNonEmptyString(details?.name)) {
        throw new Error("GM_setCookie url and name are required");
      }
      await session.defaultSession.cookies.set({
        url: details.url,
        name: details.name,
        value: isNonEmptyString(details.value) ? details.value : "",
        domain: isNonEmptyString(details.domain) ? details.domain : undefined,
        path: isNonEmptyString(details.path) ? details.path : undefined,
        secure: details.secure === true,
        httpOnly: details.httpOnly === true,
        expirationDate:
          typeof details.expirationDate === "number"
            ? details.expirationDate
            : undefined,
      });
      return true;
    },
  );

  ipcMain.handle(
    "userscripts:gm-cookie-delete",
    async (
      _event,
      details: { url?: unknown; name?: unknown },
    ): Promise<boolean> => {
      if (!isNonEmptyString(details?.url) || !isNonEmptyString(details?.name)) {
        throw new Error("GM_deleteCookie url and name are required");
      }
      const cookies = await session.defaultSession.cookies.get({
        url: details.url,
        name: details.name,
      });
      for (const cookie of cookies) {
        await session.defaultSession.cookies.remove(details.url, cookie.name);
      }
      return true;
    },
  );

  // GM_xmlhttpRequest：经主进程 net.fetch 发起，绕过页面 CORS 限制。
  // responseType: text/json 直接返回文本；arraybuffer/blob 以 base64
  // 返回（responseBodyBase64），shim 侧解码。
  ipcMain.handle(
    "userscripts:gm-xhr",
    async (
      _event,
      payload: unknown,
    ): Promise<{
      status: number;
      statusText: string;
      responseHeaders: Record<string, string>;
      responseText: string;
      responseBodyBase64?: string;
      finalUrl: string;
    }> => {
      if (payload === null || typeof payload !== "object") {
        throw new Error("Invalid GM_xmlhttpRequest payload");
      }
      const { url, method, headers, data, responseType } = payload as {
        url?: unknown;
        method?: unknown;
        headers?: unknown;
        data?: unknown;
        responseType?: unknown;
      };
      if (!isNonEmptyString(url) || !/^https?:\/\//i.test(url)) {
        throw new Error("GM_xmlhttpRequest url must be http(s)");
      }
      const timeout = 30000;
      const response = await net.fetch(url, {
        method: isNonEmptyString(method) ? method.toUpperCase() : "GET",
        headers:
          headers !== null && typeof headers === "object"
            ? (headers as Record<string, string>)
            : undefined,
        body:
          isNonEmptyString(data) && method !== "GET" && method !== "HEAD"
            ? data
            : undefined,
        signal: AbortSignal.timeout(timeout),
      });
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });
      const binary = responseType === "arraybuffer" || responseType === "blob";
      const buffer = binary ? await response.arrayBuffer() : null;
      return {
        status: response.status,
        statusText: response.statusText,
        responseHeaders,
        responseText: buffer
          ? ""
          : await response
              .clone()
              .text()
              .catch(() => ""),
        responseBodyBase64: buffer
          ? Buffer.from(buffer).toString("base64")
          : undefined,
        finalUrl: response.url,
      };
    },
  );

  // GM_registerMenuCommand / GM_unregisterMenuCommand：命令挂在 guest
  // webContents 上，webview 右键菜单渲染并触发。
  ipcMain.handle(
    "userscripts:gm-register-menu",
    (
      event,
      payload: { scriptId?: unknown; title?: unknown; accessKey?: unknown },
    ): number => {
      const scriptId = isNonEmptyString(payload?.scriptId)
        ? payload.scriptId
        : "";
      const title = isNonEmptyString(payload?.title) ? payload.title : "";
      const accessKey = isNonEmptyString(payload?.accessKey)
        ? payload.accessKey
        : "";
      if (!scriptId || !title) {
        throw new Error("Menu command scriptId and title are required");
      }
      bindContentsCleanup(event.sender);
      const state = getRuntime(event.sender.id);
      // 同 (scriptId, title) 幂等：脚本重复注册复用同一命令 id。
      for (const [id, existing] of state.commands) {
        if (existing.scriptId === scriptId && existing.title === title) {
          return id;
        }
      }
      const commandId = state.nextCommandId;
      state.nextCommandId += 1;
      state.commands.set(commandId, { scriptId, title, accessKey });
      return commandId;
    },
  );

  ipcMain.handle(
    "userscripts:gm-unregister-menu",
    (event, menuId: unknown): boolean => {
      if (typeof menuId !== "number") {
        return false;
      }
      return getRuntime(event.sender.id).commands.delete(menuId);
    },
  );

  // GM_download：发起 webContents.downloadURL，由 will-download 统一落盘。
  ipcMain.handle(
    "userscripts:gm-download",
    (
      event,
      payload: { requestId?: unknown; url?: unknown; filename?: unknown },
    ): void => {
      const requestId =
        typeof payload?.requestId === "number" ? payload.requestId : 0;
      const url = isNonEmptyString(payload?.url) ? payload.url : "";
      const filename = isNonEmptyString(payload?.filename)
        ? payload.filename
        : "";
      if (!requestId || !url || !/^(https?|blob|data):/i.test(url)) {
        throw new Error("GM_download url is required");
      }
      startGmDownload(event.sender, requestId, url, filename);
    },
  );

  // GM_addValueChangeListener / GM_removeValueChangeListener。
  ipcMain.handle(
    "userscripts:gm-add-value-listener",
    (
      event,
      payload: { scriptId?: unknown; listenerId?: unknown; key?: unknown },
    ): boolean => {
      const scriptId = isNonEmptyString(payload?.scriptId)
        ? payload.scriptId
        : "";
      const key = isNonEmptyString(payload?.key) ? payload.key : "";
      const listenerId =
        typeof payload?.listenerId === "number" ? payload.listenerId : 0;
      if (!scriptId || !key || !listenerId) {
        return false;
      }
      bindContentsCleanup(event.sender);
      getRuntime(event.sender.id).listeners.set(listenerId, { scriptId, key });
      return true;
    },
  );

  ipcMain.handle(
    "userscripts:gm-remove-value-listener",
    (event, listenerId: unknown): boolean => {
      if (typeof listenerId !== "number") {
        return false;
      }
      return getRuntime(event.sender.id).listeners.delete(listenerId);
    },
  );

  // GM_getTab / GM_saveTab / GM_getTabs：session 级内存存储。
  ipcMain.handle("userscripts:gm-get-tab", (event): unknown => {
    return getRuntime(event.sender.id).tabData;
  });

  ipcMain.handle("userscripts:gm-save-tab", (event, obj: unknown): boolean => {
    bindContentsCleanup(event.sender);
    getRuntime(event.sender.id).tabData = obj;
    return true;
  });

  ipcMain.handle("userscripts:gm-get-tabs", (): Record<number, unknown> => {
    const tabs: Record<number, unknown> = {};
    for (const [contentsId, state] of runtimeByContents) {
      if (state.tabData !== undefined) {
        tabs[contentsId] = state.tabData;
      }
    }
    return tabs;
  });
};
