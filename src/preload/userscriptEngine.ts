/**
 * 用户脚本注入引擎（运行在 webview preload 隔离世界）。
 *
 * 执行模型：脚本统一注入主世界执行（customElements / unsafeWindow 可用），
 * 代码经 webFrame.executeJavaScript 在全局作用域执行——对齐 Tampermonkey
 * 沙盒语义：顶层 var / 函数声明挂 window，脚本可用 window.xxx 读回自己的
 * 全局变量。禁止用 new Function 包装执行（顶层声明变函数局部变量，
 * window.xxx 读不到，h5player 等脚本会崩）。
 *
 * GM API：执行脚本前先把该脚本的 GM_* API 挂到 window（每脚本重新绑定），
 * 裸标识符 / window.GM_* / GM.xxx 三种写法都指向当前脚本上下文。
 * 多脚本共享 window.GM_* 单例（绑定最后 prepare 的脚本）。
 *
 * 通信：主世界经 window.postMessage 向 preload 发请求（token 防伪造），
 * preload 经 ipcRenderer 调主进程后回传；主进程主动事件（菜单点击、
 * 值变更广播、下载状态）由 preload 监听后同样经 postMessage 转发。
 */

import { ipcRenderer, webFrame, clipboard } from "electron";

/** 主世界 → 隔离世界的消息类型标识。 */
const MSG_SOURCE = "snow-us-gm-req";
/** 隔离世界 → 主世界的消息类型标识。 */
const MSG_RESP_SOURCE = "snow-us-gm-resp";
/** 主进程 → 主世界的主动事件标识（菜单点击 / 值变更 / 下载状态 / 通知）。 */
const MSG_MENU_SOURCE = "snow-us-gm-menu";
const MSG_VALUE_SOURCE = "snow-us-gm-value";
const MSG_DOWNLOAD_SOURCE = "snow-us-gm-download";
const MSG_NOTIFICATION_SOURCE = "snow-us-gm-notify";

/** 会话级随机 token，每次导航重新生成，防止页面伪造。 */
const TOKEN = generateToken();

function generateToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("");
}

// ===== 构建注入主世界的 GM shim 源代码 =====

function buildGmShimSource(): string {
  return `(() => {
  if (window.__SNOW_US_LOADED__) return;
  window.__SNOW_US_LOADED__ = true;

  // 锁定常用原生方法为 bind(window) 版本（从 Window.prototype 捕获，
  // 免疫页面覆写与注入时序）。alert/confirm/prompt 裸调用或以任意对象
  // 为 receiver 调用时 Chromium 抛 Illegal invocation（Tampermonkey 沙盒
  // 中这些方法为包装函数不受影响），脚本常在顶层保存引用后以
  // original.confirm(...) 形式调用，必须绑定 receiver。
  const NATIVE_PROTECTED_KEYS = ['matchMedia', 'getComputedStyle', 'alert', 'confirm'];
  for (let i = 0; i < NATIVE_PROTECTED_KEYS.length; i++) {
    const key = NATIVE_PROTECTED_KEYS[i];
    try {
      let fn = null;
      try {
        const pd = Object.getOwnPropertyDescriptor(Window.prototype, key);
        if (pd && typeof pd.value === 'function') fn = pd.value;
      } catch (e) { /* 无 Window 构造器的环境降级 */ }
      if (!fn) {
        const candidate = window[key];
        if (typeof candidate === 'function' && /\\[native code\\]/.test(String(candidate))) fn = candidate;
      }
      if (!fn) continue;
      const bound = fn.bind(window);
      Object.defineProperty(window, key, {
        configurable: false,
        enumerable: true,
        get: function () { return bound; },
        set: function () {},
      });
    } catch (e) { /* 锁定失败不影响注入 */ }
  }

  // Electron 移除了原生 window.prompt（调用即抛 "prompt() is not
  // supported."），同步阻塞等用户输入在引擎层无法实现。对齐
  // Tampermonkey 沙盒中"用户直接点确定"的行为：同步返回默认值，
  // 脚本流程继续（如 h5player 下载使用默认文件名）。
  try {
    // Electron 的 window.prompt 是不可写的 accessor，先删除再锁定。
    try { delete window.prompt; } catch (e) { /* 部分环境不可 delete */ }
    const promptFallback = function (message, defaultText) {
      window.console.warn('[Snow Userscript] prompt() is not supported in Electron, returning default value:', message);
      return defaultText === undefined || defaultText === null ? null : String(defaultText);
    };
    Object.defineProperty(window, 'prompt', {
      configurable: false,
      enumerable: true,
      get: function () { return promptFallback; },
      set: function () {},
    });
  } catch (e) { /* 锁定失败不影响注入 */ }

  // 主世界执行时页面 window 即 unsafeWindow。
  try {
    Object.defineProperty(window, 'unsafeWindow', {
      configurable: false,
      enumerable: true,
      get: function () { return window; },
      set: function () {},
    });
  } catch (e) { /* 锁定失败不影响注入 */ }

  const TOKEN = ${JSON.stringify(TOKEN)};
  let _reqId = 0;
  const _pending = new Map();

  function _call(method, args) {
    return new Promise((resolve, reject) => {
      const id = ++_reqId;
      _pending.set(id, { resolve, reject });
      window.postMessage({ source: ${JSON.stringify(MSG_SOURCE)}, token: TOKEN, id, method, args }, "*");
    });
  }
  window.addEventListener("message", (e) => {
    const d = e.data || {};
    if (d.source !== ${JSON.stringify(MSG_RESP_SOURCE)} || d.token !== TOKEN) return;
    const p = _pending.get(d.id);
    if (!p) return;
    _pending.delete(d.id);
    d.ok ? p.resolve(d.result) : p.reject(new Error(d.error));
  });

  // 主进程主动事件回调表（菜单 / 值变更 / 下载 / 通知）。
  const _menuCallbacks = new Map();
  const _valueListeners = new Map();
  const _downloadCallbacks = new Map();
  const _notificationCallbacks = new Map();
  let _downloadReqId = 0;
  let _valueListenerId = 0;

  window.addEventListener("message", (e) => {
    const d = e.data || {};
    if (d.token !== TOKEN) return;
    if (d.source === ${JSON.stringify(MSG_MENU_SOURCE)}) {
      const fn = _menuCallbacks.get(d.id);
      if (typeof fn === "function") { try { fn(); } catch (err) { console.error("[Snow Userscript] menu command error:", err); } }
    } else if (d.source === ${JSON.stringify(MSG_VALUE_SOURCE)}) {
      const l = _valueListeners.get(d.listenerId);
      if (l && typeof l.fn === "function") {
        try { l.fn(d.key, d.oldValue, d.newValue, true); } catch (err) { console.error("[Snow Userscript] value listener error:", err); }
      }
    } else if (d.source === ${JSON.stringify(MSG_DOWNLOAD_SOURCE)}) {
      const cbs = _downloadCallbacks.get(d.requestId);
      if (!cbs) return;
      if (d.state === "completed") {
        _downloadCallbacks.delete(d.requestId);
        if (typeof cbs.onload === "function") cbs.onload({ receivedBytes: d.receivedBytes, totalBytes: d.totalBytes });
      } else if (d.state === "interrupted") {
        _downloadCallbacks.delete(d.requestId);
        if (typeof cbs.onerror === "function") cbs.onerror({ error: "download interrupted" });
      } else if (typeof cbs.onprogress === "function") {
        cbs.onprogress({ receivedBytes: d.receivedBytes, totalBytes: d.totalBytes });
      }
    } else if (d.source === ${JSON.stringify(MSG_NOTIFICATION_SOURCE)}) {
      const cbs = _notificationCallbacks.get(d.notificationId);
      if (!cbs) return;
      if (d.kind === "clicked") {
        if (typeof cbs.onclick === "function") cbs.onclick();
      } else if (d.kind === "done") {
        _notificationCallbacks.delete(d.notificationId);
        if (typeof cbs.ondone === "function") cbs.ondone(d.failed ? { error: "notification failed" } : {});
      }
    }
  });

  let _activeCtx = null;

  // 每个脚本独立闭包上下文：同步 GM 存储 + 异步持久化。
  function makeCtx(item) {
    const ctx = {
      scriptId: item.scriptId,
      values: Object.assign({}, item.gmValues || {}),
    };
    const GM_info = {
      script: { name: item.name, version: item.version, description: item.description, namespace: "" },
      scriptMetaStr: item.raw || "",
      scriptHandler: "Snow Userscript",
      version: "1.0",
    };
    const api = {
      GM_info,
      GM_getValue: function(key, def) {
        return Object.prototype.hasOwnProperty.call(ctx.values, key) ? ctx.values[key] : def;
      },
      GM_setValue: function(key, value) {
        const str = String(value);
        const oldValue = Object.prototype.hasOwnProperty.call(ctx.values, key) ? ctx.values[key] : undefined;
        ctx.values[key] = str;
        _call("gm-set-value", { scriptId: ctx.scriptId, key, value: str, oldValue }).catch(() => {});
      },
      GM_deleteValue: function(key) {
        const oldValue = Object.prototype.hasOwnProperty.call(ctx.values, key) ? ctx.values[key] : undefined;
        delete ctx.values[key];
        _call("gm-delete-value", { scriptId: ctx.scriptId, key, oldValue }).catch(() => {});
      },
      GM_listValues: function() {
        return Object.keys(ctx.values);
      },
      GM_addStyle: function(css) {
        const style = document.createElement("style");
        style.textContent = css;
        if (document.head) {
          document.head.appendChild(style);
        } else if (document.documentElement) {
          document.documentElement.appendChild(style);
        } else {
          document.addEventListener("DOMContentLoaded", () => document.head.appendChild(style), { once: true });
        }
        return style;
      },
      GM_log: function(...args) {
        console.log(...args);
      },
      GM_setClipboard: function(text) {
        _call("gm-set-clipboard", { text: String(text) }).catch(() => {});
      },
      GM_notification: function(details, done) {
        const opts = typeof details === "string"
          ? { title: details, body: "" }
          : { title: details && details.title ? details.title : "", body: details && details.text ? details.text : "", ...details };
        const cbs = {
          onclick: opts.onclick,
          ondone: typeof done === "function" ? done : opts.ondone,
        };
        _call("gm-notification", { title: opts.title, body: opts.body }).then((notificationId) => {
          if (typeof notificationId === "number") _notificationCallbacks.set(notificationId, cbs);
        }).catch(() => {});
      },
      GM_xmlhttpRequest: function(details) {
        const { url, method, headers, data, onload, onerror, ontimeout, timeout, responseType } = details || {};
        if (!url) return;
        const timer = timeout > 0 ? setTimeout(() => {
          if (ontimeout) ontimeout({});
        }, timeout) : null;
        _call("gm-xhr", { url, method, headers, data, responseType }).then((resp) => {
          if (timer) clearTimeout(timer);
          if (!onload) return;
          const result = Object.assign({}, resp);
          if (resp && resp.responseBodyBase64) {
            const bin = atob(resp.responseBodyBase64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            if (responseType === "blob") {
              result.response = new Blob([bytes]);
            } else {
              result.response = bytes.buffer;
            }
          } else if (resp && responseType === "json" && typeof resp.responseText === "string" && resp.responseText) {
            try { result.response = JSON.parse(resp.responseText); } catch (e) { result.response = null; }
          } else if (resp && (responseType === "text" || !responseType)) {
            result.response = resp.responseText;
          }
          onload(result);
        }).catch((err) => {
          if (timer) clearTimeout(timer);
          if (onerror) onerror({ error: err.message });
        });
      },
      GM_registerMenuCommand: function(title, fn, accessKeyOrOptions) {
        if (typeof fn !== "function") return 0;
        const accessKey = typeof accessKeyOrOptions === "string"
          ? accessKeyOrOptions
          : (accessKeyOrOptions && typeof accessKeyOrOptions === "object" && typeof accessKeyOrOptions.accessKey === "string" ? accessKeyOrOptions.accessKey : "");
        _call("gm-register-menu", { scriptId: ctx.scriptId, title: String(title), accessKey }).then((cmdId) => {
          if (typeof cmdId === "number") _menuCallbacks.set(cmdId, fn);
        }).catch(() => {});
        return -1;
      },
      GM_unregisterMenuCommand: function(menuId) {
        _menuCallbacks.delete(menuId);
        _call("gm-unregister-menu", { menuId }).catch(() => {});
      },
      GM_openInTab: function(url, opts) {
        if (typeof url !== "string" || !url) return { closed: false, close: function() {} };
        const active = !(opts && typeof opts === "object" && opts.active === false) &&
          !(typeof opts === "boolean" && opts === false);
        _call("gm-open-in-tab", { url, active }).catch(() => {});
        return { closed: false, close: function() {} };
      },
      GM_download: function(options, name) {
        let url = "", filename = "", onload = null, onerror = null, onprogress = null;
        if (typeof options === "string") {
          url = options;
          filename = typeof name === "string" ? name : "";
        } else if (options && typeof options === "object") {
          url = options.url;
          filename = typeof options.name === "string" ? options.name : "";
          onload = options.onload;
          onerror = options.onerror;
          onprogress = options.onprogress;
        }
        if (!url || !/^(https?|blob|data):/i.test(url)) {
          if (onerror) onerror({ error: "invalid url" });
          return;
        }
        const requestId = ++_downloadReqId;
        _downloadCallbacks.set(requestId, { onload, onerror, onprogress });
        _call("gm-download", { requestId, url, filename }).catch(() => {
          _downloadCallbacks.delete(requestId);
          if (onerror) onerror({ error: "download failed" });
        });
      },
      GM_addValueChangeListener: function(key, fn) {
        if (typeof key !== "string" || typeof fn !== "function") return 0;
        const listenerId = ++_valueListenerId;
        _valueListeners.set(listenerId, { key, fn });
        _call("gm-add-value-listener", { scriptId: ctx.scriptId, listenerId, key }).catch(() => {});
        return listenerId;
      },
      GM_removeValueChangeListener: function(listenerId) {
        _valueListeners.delete(listenerId);
        _call("gm-remove-value-listener", { listenerId }).catch(() => {});
      },
      GM_getTab: function(cb) {
        _call("gm-get-tab", {}).then((obj) => { if (typeof cb === "function") cb(obj); }).catch(() => {});
      },
      GM_saveTab: function(obj) {
        _call("gm-save-tab", { obj: obj === undefined ? null : obj }).catch(() => {});
      },
      GM_getTabs: function(cb) {
        _call("gm-get-tabs", {}).then((objs) => { if (typeof cb === "function") cb(objs); }).catch(() => {});
      },
      GM_getResourceText: function(name) {
        const resources = item.resources || {};
        if (Object.prototype.hasOwnProperty.call(resources, name)) return resources[name];
        throw new Error("Resource not provided by metadata: " + name);
      },
      GM_getResourceURL: function(name) {
        const resources = item.resources || {};
        if (!Object.prototype.hasOwnProperty.call(resources, name)) {
          throw new Error("Resource not provided by metadata: " + name);
        }
        const content = resources[name];
        return "data:text/plain;base64," + btoa(unescape(encodeURIComponent(content)));
      },
      GM_addElement: function(parentArg, detailsArg) {
        const parent = parentArg instanceof Element ? parentArg : document.head || document.documentElement;
        const details = parentArg instanceof Element ? detailsArg : parentArg;
        if (!details || typeof details !== "object") return null;
        const tag = typeof details.tag === "string" ? details.tag : "script";
        const el = document.createElement(tag);
        for (const key of Object.keys(details)) {
          if (key === "tag" || key === "textContent" || key === "html") continue;
          try { el.setAttribute(key, String(details[key])); } catch (e) { /* 属性无效时跳过 */ }
        }
        if (typeof details.textContent === "string") {
          el.textContent = details.textContent;
        } else if (typeof details.html === "string") {
          el.innerHTML = details.html;
        }
        parent.appendChild(el);
        return el;
      },
      GM_cookie: {
        list: function(details, cb) {
          _call("gm-cookie-list", details || {}).then((cookies) => {
            if (typeof cb === "function") cb(cookies);
          }).catch(() => { if (typeof cb === "function") cb(null); });
        },
        set: function(details, cb) {
          _call("gm-cookie-set", details || {}).then(() => {
            if (typeof cb === "function") cb(null);
          }).catch((err) => { if (typeof cb === "function") cb(err); });
        },
        delete: function(details, cb) {
          _call("gm-cookie-delete", details || {}).then(() => {
            if (typeof cb === "function") cb(null);
          }).catch((err) => { if (typeof cb === "function") cb(err); });
        },
      },
    };
    api.GM = {
      info: GM_info,
      getValue: api.GM_getValue,
      setValue: api.GM_setValue,
      deleteValue: api.GM_deleteValue,
      listValues: api.GM_listValues,
      addStyle: api.GM_addStyle,
      log: api.GM_log,
      setClipboard: api.GM_setClipboard,
      notification: api.GM_notification,
      xmlHttpRequest: api.GM_xmlhttpRequest,
      registerMenuCommand: api.GM_registerMenuCommand,
      unregisterMenuCommand: api.GM_unregisterMenuCommand,
      openInTab: api.GM_openInTab,
      download: api.GM_download,
      addValueChangeListener: api.GM_addValueChangeListener,
      removeValueChangeListener: api.GM_removeValueChangeListener,
      getTab: api.GM_getTab,
      saveTab: api.GM_saveTab,
      getTabs: api.GM_getTabs,
      getResourceText: api.GM_getResourceText,
      getResourceUrl: api.GM_getResourceURL,
      addElement: api.GM_addElement,
      cookie: api.GM_cookie,
    };
    return { ctx, api };
  }

  // 挂载指定脚本的 GM API 到 window（脚本代码执行前调用）。
  function prepare(item) {
    const { ctx, api } = makeCtx(item);
    _activeCtx = ctx;
    for (const key of Object.keys(api)) {
      try {
        Object.defineProperty(window, key, {
          configurable: true,
          writable: true,
          enumerable: true,
          value: api[key],
        });
      } catch (e) {
        window[key] = api[key];
      }
    }
  }
  window.__SNOW_US_PREPARE__ = prepare;
})();`;
}

// ===== 处理来自主世界的 GM API 请求 =====

window.addEventListener("message", async (event) => {
  const data = event.data;
  if (!data || data.source !== MSG_SOURCE || data.token !== TOKEN) return;

  try {
    const result = await handleGmMethod(data.method, data.args);
    window.postMessage(
      {
        source: MSG_RESP_SOURCE,
        token: TOKEN,
        id: data.id,
        ok: true,
        result,
      },
      "*",
    );
  } catch (error) {
    window.postMessage(
      {
        source: MSG_RESP_SOURCE,
        token: TOKEN,
        id: data.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      "*",
    );
  }
});

async function handleGmMethod(
  method: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const scriptId = typeof args?.scriptId === "string" ? args.scriptId : "";
  switch (method) {
    case "gm-set-value": {
      if (!scriptId || typeof args.key !== "string") return true;
      await ipcRenderer.invoke(
        "userscripts:gm-set-value",
        scriptId,
        args.key,
        args.value === undefined ? "" : String(args.value),
        args.oldValue === undefined ? undefined : String(args.oldValue),
      );
      return true;
    }
    case "gm-delete-value": {
      if (!scriptId || typeof args.key !== "string") return true;
      await ipcRenderer.invoke(
        "userscripts:gm-delete-value",
        scriptId,
        args.key,
        args.oldValue === undefined ? undefined : String(args.oldValue),
      );
      return true;
    }
    case "gm-set-clipboard": {
      clipboard.writeText(typeof args.text === "string" ? args.text : "");
      return true;
    }
    case "gm-notification": {
      return ipcRenderer.invoke("userscripts:gm-notification", {
        title: typeof args.title === "string" ? args.title : "",
        body: typeof args.body === "string" ? args.body : "",
      });
    }
    case "gm-cookie-list": {
      return ipcRenderer.invoke("userscripts:gm-cookie-list", args || {});
    }
    case "gm-cookie-set": {
      return ipcRenderer.invoke("userscripts:gm-cookie-set", args || {});
    }
    case "gm-cookie-delete": {
      return ipcRenderer.invoke("userscripts:gm-cookie-delete", args || {});
    }
    case "gm-xhr": {
      return ipcRenderer.invoke("userscripts:gm-xhr", {
        url: args.url,
        method: args.method,
        headers: args.headers,
        data: args.data,
        responseType: args.responseType,
      });
    }
    case "gm-register-menu": {
      return ipcRenderer.invoke("userscripts:gm-register-menu", {
        scriptId,
        title: typeof args.title === "string" ? args.title : "",
        accessKey: typeof args.accessKey === "string" ? args.accessKey : "",
      });
    }
    case "gm-unregister-menu": {
      if (typeof args.menuId !== "number") return true;
      return ipcRenderer.invoke("userscripts:gm-unregister-menu", args.menuId);
    }
    case "gm-open-in-tab": {
      ipcRenderer.send("browser:guest-open-tab", {
        url: typeof args.url === "string" ? args.url : "",
        disposition:
          args.active === false ? "background-tab" : "foreground-tab",
      });
      return true;
    }
    case "gm-download": {
      if (typeof args.requestId !== "number" || typeof args.url !== "string") {
        return true;
      }
      return ipcRenderer.invoke("userscripts:gm-download", {
        requestId: args.requestId,
        url: args.url,
        filename: typeof args.filename === "string" ? args.filename : "",
      });
    }
    case "gm-add-value-listener": {
      if (
        typeof args.listenerId !== "number" ||
        !scriptId ||
        typeof args.key !== "string"
      ) {
        return true;
      }
      return ipcRenderer.invoke("userscripts:gm-add-value-listener", {
        scriptId,
        listenerId: args.listenerId,
        key: args.key,
      });
    }
    case "gm-remove-value-listener": {
      if (typeof args.listenerId !== "number") return true;
      return ipcRenderer.invoke(
        "userscripts:gm-remove-value-listener",
        args.listenerId,
      );
    }
    case "gm-get-tab": {
      return ipcRenderer.invoke("userscripts:gm-get-tab");
    }
    case "gm-save-tab": {
      return ipcRenderer.invoke("userscripts:gm-save-tab", args.obj);
    }
    case "gm-get-tabs": {
      return ipcRenderer.invoke("userscripts:gm-get-tabs");
    }
    default:
      throw new Error(`Unknown GM method: ${method}`);
  }
}

// ===== 主进程主动事件 → 主世界转发 =====

ipcRenderer.on("userscripts:menu-command", (_event, cmdId: unknown) => {
  window.postMessage({ source: MSG_MENU_SOURCE, token: TOKEN, id: cmdId }, "*");
});

ipcRenderer.on(
  "userscripts:value-changed",
  (
    _event,
    payload: {
      listenerId: number;
      key: string;
      oldValue?: string;
      newValue: string;
    },
  ) => {
    window.postMessage(
      { source: MSG_VALUE_SOURCE, token: TOKEN, ...payload },
      "*",
    );
  },
);

ipcRenderer.on(
  "userscripts:download-state",
  (
    _event,
    payload: {
      requestId: number;
      state: "progressing" | "completed" | "interrupted";
      receivedBytes: number;
      totalBytes: number;
    },
  ) => {
    window.postMessage(
      { source: MSG_DOWNLOAD_SOURCE, token: TOKEN, ...payload },
      "*",
    );
  },
);

ipcRenderer.on(
  "userscripts:notification-clicked",
  (_event, notificationId: number) => {
    window.postMessage(
      {
        source: MSG_NOTIFICATION_SOURCE,
        token: TOKEN,
        notificationId,
        kind: "clicked",
      },
      "*",
    );
  },
);

ipcRenderer.on(
  "userscripts:notification-failed",
  (_event, notificationId: number) => {
    window.postMessage(
      {
        source: MSG_NOTIFICATION_SOURCE,
        token: TOKEN,
        notificationId,
        kind: "done",
        failed: true,
      },
      "*",
    );
  },
);

// ===== 用户脚本注入入口 =====

export type UserscriptInjectionItem = {
  scriptId: string;
  name: string;
  version: string;
  description: string;
  runAt: string;
  noframes: boolean;
  grant: string[];
  code: string;
  raw: string;
  gmValues?: Record<string, string>;
  resources?: Record<string, string>;
};

function buildScriptPrepareCode(script: UserscriptInjectionItem): string {
  return `(() => {
    const prepare = window.__SNOW_US_PREPARE__;
    if (typeof prepare !== "function") return;
    prepare(${JSON.stringify(script)});
  })();`;
}

/** 按 @run-at 语义在正确时机执行回调。 */
const runAtReady = (runAt: string, exec: () => void): void => {
  if (runAt === "document-end") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", exec, { once: true });
      return;
    }
    exec();
  } else if (runAt === "document-idle") {
    if (document.readyState === "loading") {
      document.addEventListener(
        "DOMContentLoaded",
        () => requestAnimationFrame(exec),
        { once: true },
      );
      return;
    }
    requestAnimationFrame(exec);
  } else {
    exec(); // document-start
  }
};

/**
 * 在 webview preload 中调用，必须在顶层同步调用（早于页面任何脚本）。
 *
 * 匹配走 ipcRenderer.sendSync：主进程从内存缓存纯内存匹配（微秒级），
 * 保证脚本代码与页面首个脚本竞速必胜——h5player 这类脚本依赖在页面
 * 脚本前劫持 MediaSource，异步 IPC 往返会永远慢一步。
 */
export function injectUserscripts(): void {
  const shimCode = buildGmShimSource();
  webFrame.executeJavaScript(shimCode).catch(() => {
    // shim 注入失败不影响页面正常浏览
  });

  let scripts: UserscriptInjectionItem[] = [];
  try {
    const matched = ipcRenderer.sendSync(
      "userscripts:match-sync",
      window.location.href,
    );
    if (Array.isArray(matched)) {
      scripts = matched as UserscriptInjectionItem[];
    }
  } catch {
    return;
  }

  if (scripts.length === 0) {
    return;
  }

  for (const script of scripts) {
    if (script.noframes && window.self !== window.top) {
      continue;
    }
    try {
      // executeJavaScript 按调用顺序 FIFO 执行：shim → prepare → code，
      // 均排在页面首个脚本之前。不 await（await 会让出任务队列，竞速失败）。
      webFrame.executeJavaScript(buildScriptPrepareCode(script)).catch(() => {
        // prepare 执行期失败不影响其他脚本
      });
      const code = script.code;
      runAtReady(script.runAt, () => {
        webFrame.executeJavaScript(code).catch(() => {
          // 单个脚本执行失败不影响其他脚本
        });
      });
    } catch {
      // 同步异常（frame 未就绪等）跳过该脚本
    }
  }
}
