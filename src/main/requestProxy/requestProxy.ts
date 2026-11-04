import { watch, type FSWatcher } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { snowLog } from "../../utils/snowLogger";
import type { NativeBridge } from "../native/types";

/**
 * 对话请求代理层（用户可编辑）。
 *
 * 代理脚本 ~/.snowapp/request-proxy/proxy.mjs 运行在 Electron 主进程中：
 * - onRequest({ body, context })：请求体发出前调用，返回对象替换请求体，返回 undefined 保持不变。
 * - onResponseEvent({ event, context })：每条 SSE 事件送达前调用（event 为原始事件文本，
 *   不含结尾空行），返回字符串替换，返回 null 丢弃，返回 undefined 保持不变。
 *
 * Rust 侧 native/src/api/request_proxy.rs 负责派发、超时与取消；脚本抛错时该次数据原样放行。
 */

type ProxyContext = {
  streamId: string;
  conversationId: string | null;
  provider: string;
};

type RequestHook = (input: {
  body: Record<string, unknown>;
  context: ProxyContext;
}) => unknown;

type ResponseEventHook = (input: {
  event: string;
  context: ProxyContext;
}) => unknown;

type LoadedProxy = {
  mtimeMs: number;
  onRequest?: RequestHook;
  onResponseEvent?: ResponseEventHook;
  reported: Set<string>;
};

type RequestStageMessage = {
  stage: "request";
  context: ProxyContext;
  body: unknown;
};

type ResponseStageMessage = {
  stage: "response";
  context: ProxyContext;
  event: string;
};

const MODULE_NAME = "requestProxy";
const PROXY_DIR = join(homedir(), ".snowapp", "request-proxy");
const PROXY_FILE = join(PROXY_DIR, "proxy.mjs");

const PROXY_TEMPLATE = `// Snow App 对话请求代理层（用户可编辑）
//
// 本文件运行在 Electron 主进程中，拥有 Node.js 全部权限，请只放入可信代码。
// 保存即生效：下一次请求或响应事件会自动重新加载；删除本文件即恢复原样。
//
// onRequest({ body, context })
//   请求体发出前调用。返回一个对象即替换请求体；返回 undefined 保持不变。
//   body 为当前协议的请求 JSON（chat / responses / anthropic / gemini / interactions）。
//
// onResponseEvent({ event, context })
//   每条 SSE 事件送达应用前调用，event 为原始事件文本（不含结尾空行）。
//   返回字符串则替换为该文本（可包含多个事件，以空行分隔）；返回 null 则丢弃；
//   返回 undefined 保持不变。
//
// context: { streamId, conversationId, provider }
//   provider 取值为 chat / responses / anthropic / gemini / interactions。
//
// 脚本抛错或超时时，对应的请求或事件会原样放行，错误记录在应用日志中。
// 取消下面的注释即可启用对应钩子。

// export function onRequest({ body, context }) {
//   return { ...body, temperature: 0.2 };
// }

// export function onResponseEvent({ event, context }) {
//   return event;
// }
`;

let cache: { mtimeMs: number; proxy: Promise<LoadedProxy> } | null = null;

/** 代理目录监听器：脚本新增/删除/保存时刷新 Rust 侧的启用开关。 */
let proxyWatcher: FSWatcher | null = null;

const pickHook = <T>(value: unknown): T | undefined =>
  typeof value === "function" ? (value as T) : undefined;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** 同一脚本版本内相同的错误只记录一次，避免逐事件刷屏。 */
const reportOnce = (
  proxy: LoadedProxy,
  phase: string,
  error: unknown,
): void => {
  const detail = describeError(error);
  const key = `${phase}:${detail}`;
  if (proxy.reported.has(key)) return;
  proxy.reported.add(key);
  snowLog.error({
    module: MODULE_NAME,
    func: phase,
    message: "Request proxy script error; the original data is passed through",
    error: detail,
  });
};

const importProxy = async (mtimeMs: number): Promise<LoadedProxy> => {
  const proxy: LoadedProxy = { mtimeMs, reported: new Set() };
  try {
    const url = `${pathToFileURL(PROXY_FILE).href}?v=${mtimeMs}`;
    const mod = (await import(url)) as Record<string, unknown>;
    proxy.onRequest = pickHook<RequestHook>(mod.onRequest);
    proxy.onResponseEvent = pickHook<ResponseEventHook>(mod.onResponseEvent);
  } catch (error) {
    reportOnce(proxy, "load", error);
  }
  return proxy;
};

/** 按脚本修改时间热重载；文件不存在时视为未启用。导入结果以 Promise 缓存，并发事件共享同一次加载。 */
const loadProxy = async (): Promise<LoadedProxy | null> => {
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(PROXY_FILE)).mtimeMs;
  } catch {
    return null;
  }
  if (cache?.mtimeMs !== mtimeMs) {
    cache = { mtimeMs, proxy: importProxy(mtimeMs) };
  }
  return cache.proxy;
};

const runRequestStage = async (
  proxy: LoadedProxy,
  message: RequestStageMessage,
): Promise<{ body?: Record<string, unknown> }> => {
  if (!proxy.onRequest || !isPlainObject(message.body)) return {};
  try {
    const result = await proxy.onRequest({
      body: message.body,
      context: message.context,
    });
    if (result === undefined) return {};
    if (isPlainObject(result)) return { body: result };
    reportOnce(
      proxy,
      "onRequest",
      "onRequest must return an object or undefined",
    );
    return {};
  } catch (error) {
    reportOnce(proxy, "onRequest", error);
    return {};
  }
};

const runResponseStage = async (
  proxy: LoadedProxy,
  message: ResponseStageMessage,
): Promise<{ event?: string | null }> => {
  if (!proxy.onResponseEvent) return {};
  try {
    const result = await proxy.onResponseEvent({
      event: message.event,
      context: message.context,
    });
    if (result === undefined) return {};
    if (result === null || typeof result === "string") return { event: result };
    reportOnce(
      proxy,
      "onResponseEvent",
      "onResponseEvent must return a string, null or undefined",
    );
    return {};
  } catch (error) {
    reportOnce(proxy, "onResponseEvent", error);
    return {};
  }
};

/**
 * Rust 侧的回调入口：请求体发出前、每条响应事件送达前各调用一次。
 * 返回 JSON 字符串；无脚本或出错时返回空对象，Rust 端据此原样放行。
 */
const handleRequestProxyMessage = async (raw: string): Promise<string> => {
  try {
    const message = JSON.parse(raw) as
      RequestStageMessage | ResponseStageMessage;
    const proxy = await loadProxy();
    if (!proxy) return "{}";
    if (message.stage === "request") {
      const reply = await runRequestStage(proxy, message);
      return JSON.stringify({
        ...reply,
        responseEvents: Boolean(proxy.onResponseEvent),
      });
    }
    return JSON.stringify(await runResponseStage(proxy, message));
  } catch (error) {
    snowLog.error({
      module: MODULE_NAME,
      func: "handleRequestProxyMessage",
      message:
        "Request proxy dispatch failed; the original data is passed through",
      error: describeError(error),
    });
    return "{}";
  }
};

const ensureProxyTemplate = async (): Promise<void> => {
  await mkdir(PROXY_DIR, { recursive: true });
  try {
    await writeFile(PROXY_FILE, PROXY_TEMPLATE, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
};

/**
 * 把「是否存在代理脚本」同步给 Rust。脚本不存在时请求阶段直接放行，
 * 不再把整个请求体序列化、跨线程传输、再在主进程解析一遍。
 */
const syncProxyState = async (
  nativeBridge: Pick<NativeBridge, "setRequestProxyEnabled">,
): Promise<void> => {
  let enabled = true;
  try {
    await stat(PROXY_FILE);
  } catch {
    enabled = false;
  }
  nativeBridge.setRequestProxyEnabled(enabled);
};

/** 监听代理目录（非递归，开销极小）：脚本变更后立即刷新启用开关。 */
const watchProxyDirectory = (
  nativeBridge: Pick<NativeBridge, "setRequestProxyEnabled">,
): void => {
  if (proxyWatcher) {
    return;
  }
  try {
    proxyWatcher = watch(PROXY_DIR, () => {
      void syncProxyState(nativeBridge);
    });
    proxyWatcher.on("error", () => {
      proxyWatcher?.close();
      proxyWatcher = null;
    });
  } catch {
    // 目录尚未创建时忽略；ensureProxyTemplate 完成后会再试一次。
  }
};

/** 退出时释放代理目录监听。 */
export const disposeRequestProxy = (): void => {
  proxyWatcher?.close();
  proxyWatcher = null;
};

/**
 * 启动时注册代理回调，并在脚本缺失时生成可编辑的模板。
 * 模板中的钩子均为注释状态，不改变任何请求与响应。
 */
export const registerRequestProxy = (
  nativeBridge: Pick<
    NativeBridge,
    "setRequestProxyHandler" | "setRequestProxyEnabled"
  >,
): void => {
  nativeBridge.setRequestProxyHandler(handleRequestProxyMessage);
  ensureProxyTemplate()
    .then(() => {
      watchProxyDirectory(nativeBridge);
      return syncProxyState(nativeBridge);
    })
    .catch((error: unknown) => {
      snowLog.error({
        module: MODULE_NAME,
        func: "registerRequestProxy",
        message: "Failed to create the request proxy template",
        error: describeError(error),
      });
    });
};
