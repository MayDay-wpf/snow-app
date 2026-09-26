import { clipboard, contextBridge, ipcRenderer, webFrame } from "electron";

import type {
  ClientScriptContext,
  ClientScriptPayload,
} from "./types/userscripts";

/**
 * 客户端 UI 脚本宿主（主窗口 preload）。
 *
 * 两档执行模型：
 * - 沙箱档（payload.sandbox = true，默认）：每个脚本独占一个隔离世界
 *   （worldId 1000+，Electron 官方建议 isolated world 用 1000 以上），
 *   GM/snow API 经 contextBridge 暴露的白名单桥调用主进程——脚本拿不到
 *   `window.snow`，因此没有文件 / 终端 / MCP 等应用特权。
 * - 完全权限档（payload.sandbox = false，脚本声明 `@grant unsafeWindow`
 *   或 `@snow-sandbox false`）：脚本在主世界执行，GM/snow API 经
 *   postMessage + 会话 token 与 preload 通信（与内置浏览器引擎同一套语义），
 *   能力等同本地代码，启用需用户在面板确认。
 *
 * 注入契约：
 * - DOM 直接操作：隔离世界与页面共享同一棵 DOM，脚本可以直接使用浏览器
 *   原生 DOM API（querySelector / createElement / append / MutationObserver /
 *   addEventListener / style 等）修改界面任意位置；`data-snow-anchor` /
 *   `data-snow-slot` 只是稳定选择器的推荐钩子（等价于给关键元素一个固定 id）。
 * - 事件：`snow.on("context" | "view-enter" | "view-leave" |
 *   "conversation-change" | "stream-start" | "stream-end" | "theme-change")`。
 * - 应用动作：`snow.client.insertInputText / sendMessage / openView /
 *   openSettings`——这类操作要触发渲染层 React 逻辑，必须由宿主在主世界
 *   派发（隔离世界 dispatch 的 CustomEvent 无法可靠携带 detail）。
 *
 * 差量更新：主进程推送 { context, scripts }，宿主对比已注入集合——新增的注入、
 * 不再匹配的执行清理（cleanup 回调 / 样式 / 插槽 DOM / 监听器），仍匹配的仅在
 * 世界内派发上下文字段变化。
 */

const WORLD_ID_BASE = 1000;
const MAX_SCRIPT_WORLDS = 64;
/** contextBridge 暴露给隔离世界的白名单桥名。 */
const HOST_BRIDGE_KEY = "__snowClientHost";
/** 主世界档的 postMessage 请求 / 响应标识。 */
const MSG_REQUEST = "snow-client-gm-req";
const MSG_RESPONSE = "snow-client-gm-resp";
/** 会话级随机 token，阻止主世界其他代码伪造 GM 请求。 */
const TOKEN = generateToken();

/** 脚本动作 → 渲染层主世界事件名（snow.client.* 的落点）。 */
const CLIENT_ACTION_EVENTS: Record<string, string> = {
  "insert-input-text": "snow:plugin-insert-input-text",
  "send-message": "snow:plugin-send-input-message",
  "open-view": "snow:client-open-view",
  "open-settings": "app-control:open-settings",
};

function generateToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(36).padStart(2, "0")).join(
    "",
  );
}

type InjectedScript = {
  payload: ClientScriptPayload;
  /** 0 表示主世界档。 */
  worldId: number;
};

const injected = new Map<string, InjectedScript>();
/** 等待应用首屏完成再注入的脚本。 */
const deferred = new Map<string, ClientScriptPayload>();

let currentContext: ClientScriptContext | null = null;

// 同一个隔离世界只能暴露一次 contextBridge API，因此 worldId 单调递增不复用；
// 到上限后回卷（脚本数量远小于上限，回卷只会在长时间反复重载时发生）。
let nextWorldId = WORLD_ID_BASE;

const allocateWorldId = (): number => {
  if (nextWorldId >= WORLD_ID_BASE + MAX_SCRIPT_WORLDS) {
    nextWorldId = WORLD_ID_BASE;
  }
  const worldId = nextWorldId;
  nextWorldId += 1;
  return worldId;
};

const toErrorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// ===== 主进程能力桥（GM_* / snow 扩展统一入口）=====

const safeJson = (value: unknown): string =>
  JSON.stringify(value ?? null)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

/**
 * 在页面主世界派发自定义事件。
 *
 * 脚本（沙箱档）与 preload 都运行在隔离世界：跨世界 dispatch 的
 * CustomEvent 无法可靠携带 detail，因此 `snow.client.*` 动作统一由
 * preload 经 webFrame.executeJavaScript 在主世界再派发（detail 为纯 JSON）。
 */
const dispatchMainWorldEvent = (eventName: string, detail: unknown): void => {
  const code = `window.dispatchEvent(new CustomEvent(${JSON.stringify(eventName)}, { detail: ${safeJson(detail)} }))`;
  void webFrame.executeJavaScript(code).catch(() => {});
};

const invokeHostMethod = async (
  scriptId: string,
  method: string,
  argsJson: string,
): Promise<string> => {
  let args: unknown[] = [];
  try {
    const parsed = argsJson ? (JSON.parse(argsJson) as unknown) : [];
    args = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    args = [];
  }
  switch (method) {
    case "gm-set-value":
      await ipcRenderer.invoke(
        "userscripts:gm-set-value",
        scriptId,
        args[0],
        args[1],
        args[2],
      );
      return "";
    case "gm-delete-value":
      await ipcRenderer.invoke(
        "userscripts:gm-delete-value",
        scriptId,
        args[0],
        args[1],
      );
      return "";
    case "gm-notification":
      return JSON.stringify(
        await ipcRenderer.invoke("userscripts:gm-notification", args[0] ?? {}),
      );
    case "gm-xhr":
      return JSON.stringify(
        await ipcRenderer.invoke("userscripts:gm-xhr", args[0] ?? {}),
      );
    case "gm-register-menu":
      return JSON.stringify(
        await ipcRenderer.invoke("userscripts:gm-register-menu", {
          scriptId,
          ...((args[0] ?? {}) as Record<string, unknown>),
        }),
      );
    case "gm-unregister-menu":
      return JSON.stringify(
        await ipcRenderer.invoke(
          "userscripts:gm-unregister-menu",
          args[0] ?? 0,
        ),
      );
    case "gm-download":
      await ipcRenderer.invoke("userscripts:gm-download", args[0] ?? {});
      return "";
    case "gm-add-value-listener":
      return JSON.stringify(
        await ipcRenderer.invoke("userscripts:gm-add-value-listener", {
          scriptId,
          ...((args[0] ?? {}) as Record<string, unknown>),
        }),
      );
    case "gm-remove-value-listener":
      return JSON.stringify(
        await ipcRenderer.invoke(
          "userscripts:gm-remove-value-listener",
          args[0] ?? 0,
        ),
      );
    case "gm-get-tab":
      return JSON.stringify(await ipcRenderer.invoke("userscripts:gm-get-tab"));
    case "gm-save-tab":
      return JSON.stringify(
        await ipcRenderer.invoke("userscripts:gm-save-tab", args[0]),
      );
    case "gm-get-tabs":
      return JSON.stringify(
        await ipcRenderer.invoke("userscripts:gm-get-tabs"),
      );
    case "set-clipboard":
      clipboard.writeText(typeof args[0] === "string" ? args[0] : "");
      return "";
    case "report-error":
      await ipcRenderer.invoke(
        "userscripts:client-report-error",
        scriptId,
        typeof args[0] === "string" ? args[0] : "",
      );
      return "";
    case "client-action": {
      const request = (args[0] ?? {}) as {
        action?: unknown;
        payload?: unknown;
      };
      const action = typeof request.action === "string" ? request.action : "";
      const eventName = CLIENT_ACTION_EVENTS[action];
      if (!eventName) {
        throw new Error(`Unknown client action: ${action}`);
      }
      const rawPayload = (request.payload ?? {}) as Record<string, unknown>;
      const payload =
        action === "insert-input-text" || action === "send-message"
          ? {
              text: typeof rawPayload.text === "string" ? rawPayload.text : "",
            }
          : {
              view: typeof rawPayload.view === "string" ? rawPayload.view : "",
            };
      dispatchMainWorldEvent(eventName, payload);
      return "";
    }
    default:
      throw new Error(`Unknown client script host method: ${method}`);
  }
};

// ===== 注入源构建 =====

type ShimTransport =
  { mode: "bridge" } | { mode: "postmessage"; token: string };

const buildShimSource = (
  payload: ClientScriptPayload,
  transport: ShimTransport,
): string => {
  const info = {
    scriptId: payload.scriptId,
    name: payload.name,
    version: payload.version,
    description: payload.description,
    sandbox: payload.sandbox,
    scope: payload.scope,
    raw: payload.raw,
  };

  return `(function () {
  "use strict";
  var INFO = ${safeJson(info)};
  var values = ${safeJson(payload.gmValues ?? {})};
  var context = ${safeJson(currentContext ?? {})};
  var listeners = { context: [], viewEnter: [], viewLeave: [], conversationChange: [], streamStart: [], streamEnd: [], themeChange: [] };
  var cleanups = [];
  var usedSlots = [];
  var menuCallbacks = new Map();
  var valueListeners = new Map();
  var notificationCallbacks = new Map();
  var downloadCallbacks = new Map();
  var requestId = 0;
  var pending = new Map();
  var nextListenerId = 0;

  var bridge = ${transport.mode === "bridge" ? `window[${JSON.stringify(HOST_BRIDGE_KEY)}]` : "null"};
  var token = ${transport.mode === "postmessage" ? JSON.stringify(transport.token) : '""'};
  var REQUEST = ${JSON.stringify(MSG_REQUEST)};
  var RESPONSE = ${JSON.stringify(MSG_RESPONSE)};

  function call(method, args) {
    var argsJson = JSON.stringify(args || []);
    if (bridge) {
      return bridge.call(method, argsJson).then(function (raw) {
        return raw ? JSON.parse(raw) : null;
      });
    }
    return new Promise(function (resolve, reject) {
      var id = ++requestId;
      pending.set(id, { resolve: resolve, reject: reject });
      window.postMessage(
        { source: REQUEST, token: token, scriptId: INFO.scriptId, id: id, method: method, argsJson: argsJson },
        "*"
      );
    });
  }

  function reportError(error) {
    var message = error && error.stack ? String(error.stack) : String(error);
    try {
      console.error("[Snow Client Script] " + INFO.name + ": " + message);
    } catch (e) { /* 忽略控制台异常 */ }
    if (bridge) {
      bridge.report(message);
      return;
    }
    call("report-error", [message]);
  }

  if (!bridge) {
    window.addEventListener("message", function (event) {
      var data = event.data || {};
      if (data.source !== RESPONSE || data.token !== token) return;
      if (data.scriptId !== INFO.scriptId) return;
      var entry = pending.get(data.id);
      if (!entry) return;
      pending.delete(data.id);
      if (data.ok) { entry.resolve(data.result); } else { entry.reject(new Error(String(data.error))); }
    });
  }

  // ===== GM_* API（沙箱档与主世界档同一套实现）=====

  function GM_getValue(key, fallback) {
    return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : fallback;
  }

  function GM_setValue(key, value) {
    var text = String(value);
    var oldValue = Object.prototype.hasOwnProperty.call(values, key) ? values[key] : undefined;
    values[key] = text;
    call("gm-set-value", [key, text, oldValue]).catch(function () {});
  }

  function GM_deleteValue(key) {
    var oldValue = Object.prototype.hasOwnProperty.call(values, key) ? values[key] : undefined;
    delete values[key];
    call("gm-delete-value", [key, oldValue]).catch(function () {});
  }

  function GM_listValues() {
    return Object.keys(values);
  }

  function GM_addStyle(css) {
    var style = document.createElement("style");
    style.setAttribute("data-snow-client-script", INFO.scriptId);
    style.textContent = String(css);
    (document.head || document.documentElement).appendChild(style);
    return style;
  }

  function GM_log() {
    try {
      console.log.apply(console, ["[" + INFO.name + "]"].concat(Array.prototype.slice.call(arguments)));
    } catch (e) { /* 忽略控制台异常 */ }
  }

  function GM_setClipboard(text) {
    call("set-clipboard", [String(text)]).catch(function () {});
  }

  function GM_notification(details, done) {
    var payload = details || {};
    var onClick = typeof payload.onclick === "function" ? payload.onclick : null;
    var onDone = typeof done === "function" ? done : (typeof payload.ondone === "function" ? payload.ondone : null);
    call("gm-notification", [{ title: payload.title, body: payload.text || payload.body || "" }])
      .then(function (notificationId) {
        if (notificationId && (onClick || onDone)) {
          notificationCallbacks.set(notificationId, { onclick: onClick, ondone: onDone });
        }
      })
      .catch(function () {});
  }

  function GM_xmlhttpRequest(details) {
    var options = details || {};
    var handlers = {
      onload: options.onload, onerror: options.onerror,
      onprogress: options.onprogress, ontimeout: options.ontimeout,
    };
    call("gm-xhr", [{
      url: options.url, method: options.method || "GET",
      headers: options.headers, data: options.data,
      responseType: options.responseType,
    }])
      .then(function (response) {
        if (!response) {
          if (typeof handlers.onerror === "function") handlers.onerror({ error: "empty response" });
          return;
        }
        var finalText = response.responseText || "";
        if (response.responseBodyBase64) {
          var binary = atob(response.responseBodyBase64);
          var bytes = new Uint8Array(binary.length);
          for (var index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
          finalText = options.responseType === "arraybuffer" ? bytes.buffer : new Blob([bytes]);
        }
        if (typeof handlers.onload === "function") {
          handlers.onload({
            status: response.status, statusText: response.statusText,
            responseHeaders: response.responseHeaders, responseText: typeof finalText === "string" ? finalText : "",
            response: finalText, finalUrl: response.finalUrl,
          });
        }
      })
      .catch(function (error) {
        if (typeof handlers.onerror === "function") handlers.onerror({ error: String(error) });
        else reportError(error);
      });
  }

  function GM_download(options, name) {
    var settings = typeof options === "string"
      ? { url: options, name: name }
      : (options || {});
    var url = settings.url;
    if (!url || !/^(https?|blob|data):/i.test(String(url))) {
      if (typeof settings.onerror === "function") settings.onerror({ error: "invalid url" });
      return { abort: function () {} };
    }
    var requestId = ++nextListenerId;
    downloadCallbacks.set(requestId, {
      onload: settings.onload, onerror: settings.onerror, onprogress: settings.onprogress,
    });
    call("gm-download", [{ requestId: requestId, url: url, filename: settings.name || settings.filename || "" }])
      .catch(function (error) {
        downloadCallbacks.delete(requestId);
        if (typeof settings.onerror === "function") settings.onerror({ error: String(error) });
      });
    return { abort: function () { downloadCallbacks.delete(requestId); } };
  }

  function GM_registerMenuCommand(title, callback, accessKey) {
    if (typeof callback !== "function") return -1;
    call("gm-register-menu", [{ title: String(title), accessKey: accessKey || "" }])
      .then(function (id) {
        if (typeof id === "number") menuCallbacks.set(id, callback);
      })
      .catch(function () {});
    return -1;
  }

  function GM_unregisterMenuCommand(commandId) {
    menuCallbacks.delete(commandId);
    call("gm-unregister-menu", [commandId]).catch(function () {});
  }

  function GM_addValueChangeListener(key, callback) {
    var listenerId = ++nextListenerId;
    valueListeners.set(listenerId, { key: key, fn: callback });
    call("gm-add-value-listener", [{ listenerId: listenerId, key: key }]).catch(function () {});
    return listenerId;
  }

  function GM_removeValueChangeListener(listenerId) {
    valueListeners.delete(listenerId);
    call("gm-remove-value-listener", [listenerId]).catch(function () {});
  }

  function GM_getTab(callback) {
    call("gm-get-tab", []).then(function (tab) {
      if (typeof callback === "function") callback(tab);
    }).catch(function () {});
  }

  function GM_saveTab(data) {
    call("gm-save-tab", [data]).catch(function () {});
  }

  function GM_getTabs(callback) {
    call("gm-get-tabs", []).then(function (tabs) {
      if (typeof callback === "function") callback(tabs || {});
    }).catch(function () {});
  }

  function GM_addElement(parent, tag, attributes) {
    var target = parent;
    var tagName = tag;
    var attrs = attributes;
    if (typeof parent === "string") {
      target = document.querySelector(parent) || document.body || document.documentElement;
      tagName = tag;
      attrs = attributes;
    }
    var element = document.createElement(String(tagName || "div"));
    if (attrs && typeof attrs === "object") {
      Object.keys(attrs).forEach(function (name) {
        if (name === "textContent") element.textContent = attrs[name];
        else element.setAttribute(name, String(attrs[name]));
      });
    }
    if (target && target.appendChild) target.appendChild(element);
    return element;
  }

  var GM_info = {
    script: { name: INFO.name, version: INFO.version, description: INFO.description, namespace: "" },
    scriptMetaStr: INFO.raw,
    scriptHandler: "Snow Client Script",
    version: "1.0",
    sandboxMode: INFO.sandbox,
  };

  // ===== snow 扩展 API（宿主契约：DOM 钩子 / 事件 / 应用动作 / 清理）=====
  //
  // DOM 操作走浏览器原生 API：脚本与页面共享同一棵 DOM，querySelector /
  // createElement / append / MutationObserver / addEventListener 等全部可用；
  // data-snow-anchor 与 data-snow-slot 只是稳定选择器（清单见文档）。

  var snow = {
    version: "1.1",
    get isSandbox() { return INFO.sandbox; },
    get context() { return context; },
    GM_info: GM_info,
    log: GM_log,
    style: GM_addStyle,
    onCleanup: function (callback) {
      if (typeof callback === "function") cleanups.push(callback);
    },
    on: function (event, callback) {
      if (typeof callback !== "function") return;
      if (event === "context") listeners.context.push(callback);
      else if (event === "view-enter") listeners.viewEnter.push(callback);
      else if (event === "view-leave") listeners.viewLeave.push(callback);
      else if (event === "conversation-change") listeners.conversationChange.push(callback);
      else if (event === "stream-start") listeners.streamStart.push(callback);
      else if (event === "stream-end") listeners.streamEnd.push(callback);
      else if (event === "theme-change") listeners.themeChange.push(callback);
    },
    anchor: function (name) {
      return document.querySelector('[data-snow-anchor="' + String(name) + '"]');
    },
    slot: function (name) {
      var element = document.querySelector('[data-snow-slot="' + String(name) + '"]');
      if (element && usedSlots.indexOf(element) < 0) usedSlots.push(element);
      return element;
    },
    client: {
      insertInputText: function (text) {
        call("client-action", [{ action: "insert-input-text", payload: { text: String(text) } }]).catch(function () {});
      },
      sendMessage: function (text) {
        call("client-action", [{ action: "send-message", payload: { text: String(text) } }]).catch(function () {});
      },
      openView: function (view) {
        call("client-action", [{ action: "open-view", payload: { view: String(view) } }]).catch(function () {});
      },
      openSettings: function (view) {
        call("client-action", [{ action: "open-settings", payload: { view: view == null ? "" : String(view) } }]).catch(function () {});
      },
    },
  };

  function runCleanups() {
    fire("viewLeave");
    for (var index = 0; index < cleanups.length; index += 1) {
      try { cleanups[index](); } catch (error) { reportError(error); }
    }
    cleanups = [];
    for (var slotIndex = 0; slotIndex < usedSlots.length; slotIndex += 1) {
      try { usedSlots[slotIndex].replaceChildren(); } catch (e) { /* 插槽已卸载 */ }
    }
    usedSlots = [];
    var styles = document.querySelectorAll('style[data-snow-client-script="' + INFO.scriptId + '"]');
    for (var styleIndex = 0; styleIndex < styles.length; styleIndex += 1) styles[styleIndex].remove();
    menuCallbacks.clear();
    valueListeners.clear();
    notificationCallbacks.clear();
    downloadCallbacks.clear();
    listeners.context = [];
    listeners.viewEnter = [];
    listeners.viewLeave = [];
    listeners.conversationChange = [];
    listeners.streamStart = [];
    listeners.streamEnd = [];
    listeners.themeChange = [];
  }

  function fire(event, argument) {
    var group = event === "context" ? listeners.context
      : event === "view-enter" ? listeners.viewEnter
      : event === "view-leave" ? listeners.viewLeave
      : event === "conversation-change" ? listeners.conversationChange
      : event === "stream-start" ? listeners.streamStart
      : event === "stream-end" ? listeners.streamEnd
      : listeners.themeChange;
    for (var index = 0; index < group.length; index += 1) {
      try {
        if (event === "context") group[index](context);
        else if (event === "view-enter" || event === "view-leave") group[index]();
        else group[index](argument);
      } catch (error) { reportError(error); }
    }
  }

  function applyContext(next) {
    var previous = context || {};
    context = next || {};
    if (String(previous.conversationId || "") !== String(context.conversationId || "")) {
      fire("conversation-change", context.conversationId || "");
    }
    if (!!previous.isStreaming !== !!context.isStreaming) {
      fire(context.isStreaming ? "stream-start" : "stream-end", context);
    }
    if (String(previous.theme || "") !== String(context.theme || "")) {
      fire("theme-change", context.theme || "");
    }
    fire("context");
  }

  function dispatch(channel, data) {
    if (channel === "context") {
      applyContext(data);
      return;
    }
    if (channel === "cleanup") { runCleanups(); return; }
    if (channel === "menu") {
      var menuCallback = menuCallbacks.get(data && data.id);
      if (typeof menuCallback === "function") {
        try { menuCallback(); } catch (error) { reportError(error); }
      }
      return;
    }
    if (channel === "value") {
      var entry = valueListeners.get(data && data.listenerId);
      if (entry && typeof entry.fn === "function") {
        try { entry.fn(data.key, data.oldValue, data.newValue, true); } catch (error) { reportError(error); }
      }
      return;
    }
    if (channel === "notification") {
      var callbacks = notificationCallbacks.get(data && data.notificationId);
      if (!callbacks) return;
      if (data.kind === "clicked") {
        if (typeof callbacks.onclick === "function") { try { callbacks.onclick(); } catch (error) { reportError(error); } }
      } else if (data.kind === "done") {
        notificationCallbacks.delete(data.notificationId);
        if (typeof callbacks.ondone === "function") { try { callbacks.ondone(data.failed ? { error: "notification failed" } : {}); } catch (error) { reportError(error); } }
      }
      return;
    }
    if (channel === "download") {
      var download = downloadCallbacks.get(data && data.requestId);
      if (!download) return;
      if (data.state === "completed") {
        downloadCallbacks.delete(data.requestId);
        if (typeof download.onload === "function") { try { download.onload({ receivedBytes: data.receivedBytes, totalBytes: data.totalBytes }); } catch (error) { reportError(error); } }
      } else if (data.state === "interrupted") {
        downloadCallbacks.delete(data.requestId);
        if (typeof download.onerror === "function") { try { download.onerror({ error: "download interrupted" }); } catch (error) { reportError(error); } }
      } else if (typeof download.onprogress === "function") {
        try { download.onprogress({ receivedBytes: data.receivedBytes, totalBytes: data.totalBytes }); } catch (error) { reportError(error); }
      }
      return;
    }
  }

  // 主世界档可能同时存在多个脚本：按 scriptId 路由派发。
  window.__snowClientScripts = window.__snowClientScripts || {};
  window.__snowClientScripts[INFO.scriptId] = { dispatch: dispatch };
  if (typeof window.__snowClientDispatch !== "function") {
    window.__snowClientDispatch = function (channel, data, scriptId) {
      var entry = window.__snowClientScripts[scriptId];
      if (entry && typeof entry.dispatch === "function") entry.dispatch(channel, data);
    };
  }

  // ===== 暴露 API =====

  var gm = {
    GM_info: GM_info,
    info: GM_info,
    getValue: GM_getValue,
    setValue: GM_setValue,
    deleteValue: GM_deleteValue,
    listValues: GM_listValues,
    addStyle: GM_addStyle,
    log: GM_log,
    setClipboard: GM_setClipboard,
    notification: GM_notification,
    xmlHttpRequest: GM_xmlhttpRequest,
    registerMenuCommand: GM_registerMenuCommand,
    unregisterMenuCommand: GM_unregisterMenuCommand,
    addValueChangeListener: GM_addValueChangeListener,
    removeValueChangeListener: GM_removeValueChangeListener,
    getTab: GM_getTab,
    saveTab: GM_saveTab,
    getTabs: GM_getTabs,
    addElement: GM_addElement,
    download: GM_download,
  };

  window.GM_info = GM_info;
  window.GM_getValue = GM_getValue;
  window.GM_setValue = GM_setValue;
  window.GM_deleteValue = GM_deleteValue;
  window.GM_listValues = GM_listValues;
  window.GM_addStyle = GM_addStyle;
  window.GM_log = GM_log;
  window.GM_setClipboard = GM_setClipboard;
  window.GM_notification = GM_notification;
  window.GM_xmlhttpRequest = GM_xmlhttpRequest;
  window.GM_registerMenuCommand = GM_registerMenuCommand;
  window.GM_unregisterMenuCommand = GM_unregisterMenuCommand;
  window.GM_addValueChangeListener = GM_addValueChangeListener;
  window.GM_removeValueChangeListener = GM_removeValueChangeListener;
  window.GM_getTab = GM_getTab;
  window.GM_saveTab = GM_saveTab;
  window.GM_getTabs = GM_getTabs;
  window.GM_addElement = GM_addElement;
  window.GM_download = GM_download;
  window.GM = gm;
  window.snow = snow;
  window.__snowClientInfo = INFO;

  if (!INFO.sandbox) {
    // 主世界档：window 即页面 window，等价 Tampermonkey 的 unsafeWindow。
    try {
      Object.defineProperty(window, "unsafeWindow", {
        configurable: false,
        enumerable: true,
        get: function () { return window; },
        set: function () {},
      });
    } catch (e) { /* 忽略已存在定义 */ }
  }

  // 非常驻脚本在被注入时即进入视图（退出视图由 cleanup 兜底触发 view-leave）。
  if (INFO.scope !== "global") {
    setTimeout(function () { fire("view-enter"); }, 0);
  }
})();`;
};

// ===== 注入 / 清理 =====

const dispatchToWorld = (
  entry: InjectedScript,
  channel: string,
  data: unknown,
): void => {
  const code = `window.__snowClientDispatch && window.__snowClientDispatch(${JSON.stringify(channel)}, ${safeJson(data)}, ${JSON.stringify(entry.payload.scriptId)})`;
  try {
    if (entry.worldId >= WORLD_ID_BASE) {
      void webFrame
        .executeJavaScriptInIsolatedWorld(entry.worldId, [{ code }])
        .catch(() => {});
    } else {
      void webFrame.executeJavaScript(code).catch(() => {});
    }
  } catch {
    // 世界已被销毁（窗口关闭中）：忽略。
  }
};

const dispatchAll = (channel: string, data: unknown): void => {
  for (const entry of injected.values()) {
    dispatchToWorld(entry, channel, data);
  }
};

const reportScriptError = (scriptId: string, message: string): void => {
  void ipcRenderer
    .invoke("userscripts:client-report-error", scriptId, message)
    .catch(() => {});
};

const removeScript = (scriptId: string, entry: InjectedScript): void => {
  dispatchToWorld(entry, "cleanup", null);
  injected.delete(scriptId);
};

const injectScript = (
  payload: ClientScriptPayload,
  context: ClientScriptContext,
): void => {
  const mainWorld = !payload.sandbox;
  const worldId = mainWorld ? 0 : allocateWorldId();
  const transport: ShimTransport = mainWorld
    ? { mode: "postmessage", token: TOKEN }
    : { mode: "bridge" };

  if (!mainWorld) {
    contextBridge.exposeInIsolatedWorld(worldId, HOST_BRIDGE_KEY, {
      call: (method: string, argsJson: string) => {
        // 脚本被停用 / 卸载后，其残留世界里的桥调用一律拒绝。
        if (!injected.has(payload.scriptId)) {
          return Promise.reject(new Error("Client script is no longer active"));
        }
        return invokeHostMethod(payload.scriptId, method, argsJson);
      },
      report: (message: string) => reportScriptError(payload.scriptId, message),
    });
  }

  const source = `${buildShimSource(payload, transport)}\n//# sourceURL=snow-client-script://${payload.scriptId}\n${payload.code}`;
  const entry: InjectedScript = { payload, worldId };
  injected.set(payload.scriptId, entry);

  const execution = mainWorld
    ? webFrame.executeJavaScript(source)
    : webFrame.executeJavaScriptInIsolatedWorld(worldId, [{ code: source }]);

  void execution
    .then(() => {
      // 注入完成后同步一次上下文（脚本可能依赖 appReady 之外的字段）。
      dispatchToWorld(entry, "context", context);
    })
    .catch((error: unknown) => {
      injected.delete(payload.scriptId);
      reportScriptError(payload.scriptId, toErrorText(error));
    });
};

const applyScripts = (raw: unknown): void => {
  if (raw === null || typeof raw !== "object") {
    return;
  }
  const message = raw as {
    context?: ClientScriptContext;
    scripts?: ClientScriptPayload[];
  };
  const context = message.context;
  const scripts = Array.isArray(message.scripts) ? message.scripts : [];
  if (!context) {
    return;
  }
  currentContext = context;

  const matched = new Set<string>();
  for (const payload of scripts) {
    matched.add(payload.scriptId);
    deferred.delete(payload.scriptId);

    // 应用首屏未就绪时，非 document-start 脚本延后到 app-ready 再注入，
    // 否则脚本会在 DOM 尚未挂载时抓不到锚点与插槽。
    if (!context.appReady && payload.runAt !== "document-start") {
      deferred.set(payload.scriptId, payload);
      continue;
    }

    const existing = injected.get(payload.scriptId);
    if (
      existing &&
      existing.payload.code === payload.code &&
      existing.payload.sandbox === payload.sandbox &&
      existing.payload.scope === payload.scope
    ) {
      existing.payload = payload;
      dispatchToWorld(existing, "context", context);
      continue;
    }
    if (existing) {
      removeScript(payload.scriptId, existing);
    }
    injectScript(payload, context);
  }

  // 上下文变化后不再匹配的待注入脚本直接丢弃。
  for (const scriptId of Array.from(deferred.keys())) {
    if (!matched.has(scriptId)) {
      deferred.delete(scriptId);
    }
  }

  for (const [scriptId, entry] of Array.from(injected.entries())) {
    if (!matched.has(scriptId)) {
      removeScript(scriptId, entry);
    }
  }
};

const flushDeferred = (context: ClientScriptContext): void => {
  const queue = Array.from(deferred.values());
  deferred.clear();
  for (const payload of queue) {
    if (!injected.has(payload.scriptId)) {
      injectScript(payload, context);
    }
  }
};

// ===== 事件接线 =====

/** 初始化客户端脚本宿主（监听主进程推送并注入脚本，进程内幂等）。 */
export const initClientScriptHost = (): void => {
  ipcRenderer.on("client-scripts:apply", (_event, payload: unknown) => {
    const context = (payload as { context?: ClientScriptContext } | null)
      ?.context;
    if (context?.appReady) {
      flushDeferred(context);
    }
    applyScripts(payload);
  });

  ipcRenderer.on("userscripts:menu-command", (_event, commandId: unknown) => {
    dispatchAll("menu", { id: commandId });
  });

  ipcRenderer.on(
    "userscripts:value-changed",
    (
      _event,
      payload: {
        listenerId?: number;
        key?: string;
        oldValue?: string;
        newValue?: string;
      },
    ) => {
      dispatchAll("value", payload ?? {});
    },
  );

  ipcRenderer.on("userscripts:notification-clicked", (_event, id: unknown) => {
    dispatchAll("notification", { notificationId: id, kind: "clicked" });
  });

  ipcRenderer.on("userscripts:notification-failed", (_event, id: unknown) => {
    dispatchAll("notification", {
      notificationId: id,
      kind: "done",
      failed: true,
    });
  });

  ipcRenderer.on(
    "userscripts:download-state",
    (
      _event,
      payload: {
        requestId?: number;
        state?: string;
        receivedBytes?: number;
        totalBytes?: number;
      },
    ) => {
      dispatchAll("download", payload ?? {});
    },
  );

  // 主世界档的 GM 请求：postMessage + token 与 preload 通信。
  window.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as {
      source?: string;
      token?: string;
      scriptId?: string;
      id?: number;
      method?: string;
      argsJson?: string;
    } | null;
    if (!data || data.source !== MSG_REQUEST || data.token !== TOKEN) {
      return;
    }
    const scriptId = typeof data.scriptId === "string" ? data.scriptId : "";
    if (!scriptId || !injected.has(scriptId)) {
      return;
    }
    const requestId = typeof data.id === "number" ? data.id : 0;
    const method = typeof data.method === "string" ? data.method : "";
    const argsJson = typeof data.argsJson === "string" ? data.argsJson : "[]";
    void invokeHostMethod(scriptId, method, argsJson)
      .then((result) => {
        window.postMessage(
          {
            source: MSG_RESPONSE,
            token: TOKEN,
            scriptId,
            id: requestId,
            ok: true,
            result,
          },
          "*",
        );
      })
      .catch((error: unknown) => {
        window.postMessage(
          {
            source: MSG_RESPONSE,
            token: TOKEN,
            scriptId,
            id: requestId,
            ok: false,
            error: toErrorText(error),
          },
          "*",
        );
      });
  });
};
