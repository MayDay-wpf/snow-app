import { ipcMain, net, safeStorage } from "electron";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { snowLog } from "../../utils/snowLogger";
import { getMainWindow } from "../app/mainWindow";
import type { NativeBridge, PluginRecord } from "../native/types";
import { safeSend } from "../utils/safeSend";

/**
 * 插件常驻后台宿主。
 *
 * 插件在 plugin.json 中声明 `"background": { "entry": "background.mjs" }`，模块运行在
 * 主进程（Node 全权限，仅安装可信插件），随应用常驻：启用时启动，停用 / 卸载 / 清单
 * 变化时停止，应用退出时统一清理。入口模块导出 `start(ctx)`，返回的清理函数在停止时调用。
 *
 * 能力边界：
 * - storage / secrets / 定时器 / 生命周期信号：主进程直接提供；
 * - net.fetch / ws.connect：需要声明 `network` 隐私域，经主进程网络栈与 Rust 长连接执行；
 * - metadata / write：经渲染层执行，与插件面板走同一套隐私声明校验；
 *   渲染层不可用时调用失败。
 */

type NativePluginBackgroundBridge = Pick<
  NativeBridge,
  | "listPlugins"
  | "getPluginValues"
  | "setPluginValue"
  | "deletePluginValue"
  | "setPluginWsHandler"
  | "pluginWsOpen"
  | "pluginWsSend"
  | "pluginWsSendBinary"
  | "pluginWsClose"
>;

type JsonObject = Record<string, unknown>;

type WsConnectOptions = {
  headers?: Record<string, string>;
  onOpen?: () => void;
  onMessage?: (data: string, binary: boolean) => void;
  onError?: (message: string) => void;
  onClose?: (code: number, reason: string) => void;
};

type RunningInstance = {
  pluginId: string;
  /** 清单、入口文件修改时间与安装目录的组合：变化即重启。 */
  key: string;
  controller: AbortController;
  stop: (() => unknown) | null;
  timers: Set<ReturnType<typeof setInterval>>;
  sockets: Set<number>;
};

type SocketOwner = {
  instance: RunningInstance;
  handlers: WsConnectOptions;
};

type PendingRendererCall = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const MODULE_NAME = "pluginBackground";
const RENDERER_CALL_TIMEOUT_MS = 20_000;
const FETCH_DEFAULT_TIMEOUT_MS = 30_000;
const FETCH_MAX_TIMEOUT_MS = 120_000;
const FETCH_MAX_BYTES = 5 * 1024 * 1024;
const EVERY_MIN_INTERVAL_MS = 1_000;
const SECRET_PREFIX = "secret:";
const SECRET_NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const RESPONSE_CHANNEL = "plugin-background:response";
const REQUEST_CHANNEL = "plugin-background:request";

let nativeRef: NativePluginBackgroundBridge | null = null;
const running = new Map<string, RunningInstance>();
const socketOwners = new Map<number, SocketOwner>();
const pendingRendererCalls = new Map<string, PendingRendererCall>();
let syncChain: Promise<void> = Promise.resolve();

const isPlainObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const text = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const formatArgs = (args: unknown[]): string =>
  args
    .map((item) => {
      if (typeof item === "string") return item;
      try {
        return JSON.stringify(item) ?? String(item);
      } catch {
        return String(item);
      }
    })
    .join(" ");

const logError = (pluginId: string, message: string, error: unknown): void => {
  snowLog.error({
    module: MODULE_NAME,
    func: pluginId,
    message,
    error: describeError(error),
  });
};

const native = (): NativePluginBackgroundBridge => {
  if (!nativeRef) {
    throw new Error("Plugin background host is not ready");
  }
  return nativeRef;
};

/** 限制在插件目录内，防止 ../ 越界。 */
const resolveInside = (root: string, relativePath: string): string | null => {
  const target = resolve(root, relativePath);
  const rel = relative(root, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return target;
};

const readBackgroundEntry = (record: PluginRecord): string => {
  try {
    const manifest = JSON.parse(record.manifestJson || "{}") as unknown;
    if (!isPlainObject(manifest) || !isPlainObject(manifest.background)) {
      return "";
    }
    return text(manifest.background.entry);
  } catch {
    return "";
  }
};

const requireScope = (record: PluginRecord, scope: string): void => {
  if (!record.privacy.includes(scope)) {
    throw new Error(
      `Declare '${scope}' in the plugin privacy scopes to use this capability`,
    );
  }
};

const requireKey = (value: unknown, name: string): string => {
  const key = text(value);
  if (!key) {
    throw new Error(`Parameter '${name}' must be a non-empty string`);
  }
  return key;
};

const parseHttpUrl = (value: unknown): URL => {
  const url = new URL(requireKey(value, "url"));
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Only http and https URLs are allowed");
  }
  return url;
};

const ensureSecretName = (value: unknown): string => {
  const name = requireKey(value, "name");
  if (!SECRET_NAME_PATTERN.test(name)) {
    throw new Error("Secret name must match [A-Za-z0-9._-]{1,64}");
  }
  return name;
};

const invokeCleanup = (pluginId: string, cleanup: () => unknown): void => {
  try {
    const result = cleanup();
    if (result instanceof Promise) {
      result.catch((error: unknown) =>
        logError(pluginId, "Background cleanup failed", error),
      );
    }
  } catch (error) {
    logError(pluginId, "Background cleanup failed", error);
  }
};

const disposeInstance = (instance: RunningInstance): void => {
  instance.controller.abort();
  for (const timer of instance.timers) {
    clearInterval(timer);
  }
  instance.timers.clear();
  for (const id of instance.sockets) {
    socketOwners.delete(id);
    native().pluginWsClose(id, 1001, "Plugin background stopped");
  }
  instance.sockets.clear();
  if (instance.stop) {
    invokeCleanup(instance.pluginId, instance.stop);
    instance.stop = null;
  }
};

/** 渲染层 RPC：元数据与写动作在渲染进程中按插件声明执行。 */
const callRenderer = (
  pluginId: string,
  method: string,
  args: JsonObject,
): Promise<unknown> => {
  const mainWindow = getMainWindow();
  if (!mainWindow || mainWindow.isDestroyed()) {
    return Promise.reject(new Error("Snow main window is not available"));
  }
  const id = randomUUID();
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      pendingRendererCalls.delete(id);
      rejectPromise(new Error(`Renderer call '${method}' timed out`));
    }, RENDERER_CALL_TIMEOUT_MS);
    pendingRendererCalls.set(id, {
      resolve: resolvePromise,
      reject: rejectPromise,
      timer,
    });
    safeSend(mainWindow.webContents, REQUEST_CHANNEL, {
      id,
      pluginId,
      method,
      args,
    });
  });
};

const handlePluginWsEvent = (raw: string): void => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return;
  }
  if (!isPlainObject(parsed) || typeof parsed.id !== "number") return;
  const event = parsed;
  const id = event.id as number;
  const owner = socketOwners.get(id);
  if (!owner) return;
  const { handlers } = owner;
  const pluginId = owner.instance.pluginId;
  const guard = (callback: () => void): void => {
    try {
      callback();
    } catch (error) {
      logError(pluginId, "WebSocket handler failed", error);
    }
  };
  switch (event.kind) {
    case "open":
      guard(() => handlers.onOpen?.());
      break;
    case "message":
      guard(() =>
        handlers.onMessage?.(
          typeof event.data === "string" ? event.data : "",
          event.binary === true,
        ),
      );
      break;
    case "error":
      guard(() =>
        handlers.onError?.(
          typeof event.message === "string" ? event.message : "",
        ),
      );
      break;
    case "close":
      socketOwners.delete(id);
      owner.instance.sockets.delete(id);
      guard(() =>
        handlers.onClose?.(
          typeof event.code === "number" ? event.code : 1006,
          typeof event.reason === "string" ? event.reason : "",
        ),
      );
      break;
    default:
      break;
  }
};

const createStorage = (pluginId: string) => {
  const readAll = async (): Promise<Record<string, string>> =>
    Object.fromEntries(
      (await native().getPluginValues(pluginId)).map((entry) => [
        entry.key,
        entry.value,
      ]),
    );
  const get = async (key: string): Promise<string | null> =>
    (await readAll())[key] ?? null;
  const set = async (key: string, value: string): Promise<void> => {
    await native().setPluginValue(pluginId, key, value);
  };
  const remove = async (key: string): Promise<void> => {
    await native().deletePluginValue(pluginId, key);
  };
  return {
    get: (key: unknown) => get(requireKey(key, "key")),
    set: (key: unknown, value: unknown) =>
      set(requireKey(key, "key"), typeof value === "string" ? value : ""),
    remove: (key: unknown) => remove(requireKey(key, "key")),
    all: readAll,
    getJson: async <T>(key: unknown, fallback: T): Promise<T> => {
      const raw = await get(requireKey(key, "key"));
      if (!raw) return fallback;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return fallback;
      }
    },
    setJson: (key: unknown, value: unknown) =>
      set(requireKey(key, "key"), JSON.stringify(value ?? null)),
  };
};

const createSecrets = (storage: ReturnType<typeof createStorage>) => {
  const ensureEncryption = (): void => {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("System secure storage is unavailable");
    }
  };
  return {
    set: async (name: unknown, value: unknown): Promise<void> => {
      ensureEncryption();
      if (typeof value !== "string") {
        throw new Error("Secret value must be a string");
      }
      const cipher = safeStorage.encryptString(value).toString("base64");
      await storage.set(`${SECRET_PREFIX}${ensureSecretName(name)}`, cipher);
    },
    get: async (name: unknown): Promise<string | null> => {
      ensureEncryption();
      const raw = await storage.get(
        `${SECRET_PREFIX}${ensureSecretName(name)}`,
      );
      if (!raw) return null;
      return safeStorage.decryptString(Buffer.from(raw, "base64"));
    },
    remove: (name: unknown): Promise<void> =>
      storage.remove(`${SECRET_PREFIX}${ensureSecretName(name)}`),
  };
};

const buildContext = (
  record: PluginRecord,
  instance: RunningInstance,
): JsonObject => {
  const pluginId = record.pluginId;
  const signal = instance.controller.signal;
  const storage = createStorage(pluginId);

  const fetchOverNetwork = async (
    url: unknown,
    options: JsonObject = {},
  ): Promise<JsonObject> => {
    requireScope(record, "network");
    const target = parseHttpUrl(url);
    const requested =
      typeof options.timeoutMs === "number" && options.timeoutMs > 0
        ? Math.min(Math.floor(options.timeoutMs), FETCH_MAX_TIMEOUT_MS)
        : FETCH_DEFAULT_TIMEOUT_MS;
    const headers = isPlainObject(options.headers)
      ? (options.headers as Record<string, string>)
      : {};
    try {
      const response = await net.fetch(target.href, {
        method: typeof options.method === "string" ? options.method : "GET",
        headers,
        body: typeof options.body === "string" ? options.body : undefined,
        signal: AbortSignal.any([signal, AbortSignal.timeout(requested)]),
      });
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.byteLength > FETCH_MAX_BYTES) {
        throw new Error("Response body exceeds 5 MB");
      }
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        responseHeaders[name] = value;
      });
      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        body: bytes.toString("utf8"),
        url: target.href,
        error: null,
      };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        statusText: "",
        headers: {},
        body: "",
        url: target.href,
        error: describeError(error),
      };
    }
  };

  const connect = (url: unknown, options: WsConnectOptions = {}) => {
    requireScope(record, "network");
    if (signal.aborted) {
      throw new Error("Plugin background is stopped");
    }
    const target = new URL(requireKey(url, "url"));
    if (target.protocol === "https:") {
      target.protocol = "wss:";
    } else if (target.protocol === "http:") {
      target.protocol = "ws:";
    } else if (target.protocol !== "ws:" && target.protocol !== "wss:") {
      throw new Error("WebSocket URLs must use ws, wss, http or https");
    }
    const id = native().pluginWsOpen(
      JSON.stringify({ url: target.href, headers: options.headers ?? {} }),
    );
    instance.sockets.add(id);
    socketOwners.set(id, { instance, handlers: options });
    return {
      id,
      send: (message: unknown): boolean =>
        native().pluginWsSend(id, typeof message === "string" ? message : ""),
      /** 发送二进制帧：入参为 base64 文本（非字符串或解码失败时返回 false）。 */
      sendBinary: (base64: unknown): boolean =>
        native().pluginWsSendBinary(
          id,
          typeof base64 === "string" ? base64 : "",
        ),
      close: (code?: unknown, reason?: unknown): boolean =>
        native().pluginWsClose(
          id,
          typeof code === "number" ? code : 1000,
          typeof reason === "string" ? reason : "",
        ),
    };
  };

  return {
    id: pluginId,
    version: record.version,
    installPath: record.installPath,
    signal,
    log: (...args: unknown[]) => {
      snowLog.info({
        module: MODULE_NAME,
        func: pluginId,
        message: formatArgs(args),
      });
    },
    storage,
    secrets: createSecrets(storage),
    net: { fetch: fetchOverNetwork },
    ws: { connect },
    /** 每隔 ms 执行一次回调，停止时自动清除。返回取消函数。 */
    every: (ms: unknown, callback: unknown) => {
      if (typeof callback !== "function") {
        throw new Error("every() requires a callback");
      }
      const interval =
        typeof ms === "number" && Number.isFinite(ms)
          ? Math.max(EVERY_MIN_INTERVAL_MS, Math.floor(ms))
          : EVERY_MIN_INTERVAL_MS;
      const timer = setInterval(() => {
        try {
          (callback as () => void)();
        } catch (error) {
          logError(pluginId, "Scheduled callback failed", error);
        }
      }, interval);
      instance.timers.add(timer);
      return () => {
        clearInterval(timer);
        instance.timers.delete(timer);
      };
    },
    metadata: {
      get: (domains: unknown, options: unknown = {}) =>
        callRenderer(pluginId, "metadata.get", {
          domains: Array.isArray(domains) ? domains : [domains],
          params: isPlainObject(options) ? (options.params ?? {}) : {},
        }),
      domains: () => callRenderer(pluginId, "metadata.domains", {}),
    },
    write: {
      run: (actionId: unknown, params: unknown = {}) =>
        callRenderer(pluginId, "write.run", {
          actionId: requireKey(actionId, "actionId"),
          params: isPlainObject(params) ? params : {},
        }),
      domains: () => callRenderer(pluginId, "write.domains", {}),
    },
  };
};

const startInstance = async (
  instance: RunningInstance,
  record: PluginRecord,
  entryPath: string,
): Promise<void> => {
  try {
    // 查询串带随机值：每次启动都重新加载模块，热更新不受模块缓存影响。
    const mod = (await import(
      `${pathToFileURL(entryPath).href}?v=${randomUUID()}`
    )) as Record<string, unknown>;
    const definition = isPlainObject(mod.default) ? mod.default : mod;
    if (typeof definition.start !== "function") {
      throw new Error("Background module must export start(ctx)");
    }
    const cleanup: unknown = await definition.start(
      buildContext(record, instance),
    );
    if (typeof cleanup === "function") {
      if (instance.controller.signal.aborted) {
        invokeCleanup(record.pluginId, cleanup as () => unknown);
      } else {
        instance.stop = cleanup as () => unknown;
      }
    }
    snowLog.info({
      module: MODULE_NAME,
      func: record.pluginId,
      message: "Plugin background started",
    });
  } catch (error) {
    logError(record.pluginId, "Plugin background failed to start", error);
    if (running.get(record.pluginId) === instance) {
      running.delete(record.pluginId);
    }
    disposeInstance(instance);
  }
};

const syncOnce = async (): Promise<void> => {
  if (!nativeRef) return;
  const records = await native().listPlugins();
  const desired = new Map<
    string,
    { record: PluginRecord; entryPath: string; key: string }
  >();
  for (const record of records) {
    if (!record.enabled) continue;
    const entry = readBackgroundEntry(record);
    if (!entry) continue;
    const entryPath = resolveInside(record.installPath, entry);
    if (!entryPath) {
      snowLog.warn({
        module: MODULE_NAME,
        func: record.pluginId,
        message: "Background entry escapes the plugin directory",
        context: JSON.stringify({ entry }),
      });
      continue;
    }
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(entryPath)).mtimeMs;
    } catch (error) {
      logError(record.pluginId, "Background entry is missing", error);
      continue;
    }
    desired.set(record.pluginId, {
      record,
      entryPath,
      key: `${record.manifestJson}|${mtimeMs}|${entryPath}`,
    });
  }

  for (const [pluginId, instance] of running) {
    const next = desired.get(pluginId);
    if (!next || next.key !== instance.key) {
      running.delete(pluginId);
      disposeInstance(instance);
    }
  }

  for (const [pluginId, next] of desired) {
    if (running.has(pluginId)) continue;
    const instance: RunningInstance = {
      pluginId,
      key: next.key,
      controller: new AbortController(),
      stop: null,
      timers: new Set(),
      sockets: new Set(),
    };
    running.set(pluginId, instance);
    void startInstance(instance, next.record, next.entryPath);
  }
};

/** 按插件清单与入口文件同步后台模块：启动新增的、重启变化的、停止不再启用的。 */
export const syncPluginBackgrounds = (): Promise<void> => {
  syncChain = syncChain
    .then(() => syncOnce())
    .catch((error: unknown) => {
      snowLog.error({
        module: MODULE_NAME,
        func: "syncPluginBackgrounds",
        message: "Plugin background sync failed",
        error: describeError(error),
      });
    });
  return syncChain;
};

/** 应用退出前停止全部后台模块并关闭其长连接。 */
export const stopPluginBackgrounds = (): void => {
  for (const instance of running.values()) {
    disposeInstance(instance);
  }
  running.clear();
};

/** 启动时注册 Rust 事件回调与渲染层回复通道，并做首次同步。 */
export const registerPluginBackgrounds = (
  bridge: NativePluginBackgroundBridge,
): void => {
  nativeRef = bridge;
  bridge.setPluginWsHandler(handlePluginWsEvent);
  ipcMain.on(RESPONSE_CHANNEL, (_event, response: unknown) => {
    if (!isPlainObject(response) || typeof response.id !== "string") return;
    const pending = pendingRendererCalls.get(response.id);
    if (!pending) return;
    pendingRendererCalls.delete(response.id);
    clearTimeout(pending.timer);
    if (response.ok === true) {
      pending.resolve(response.result ?? null);
    } else {
      pending.reject(
        new Error(
          typeof response.error === "string"
            ? response.error
            : "Renderer call failed",
        ),
      );
    }
  });
  void syncPluginBackgrounds();
};
