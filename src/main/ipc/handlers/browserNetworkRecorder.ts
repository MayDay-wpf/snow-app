import { app, session, webContents } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { redactBrowserText } from "../../../shared/browserRedaction";
import { snowLog } from "../../../utils/snowLogger";
import {
  clearBrowserDialogs,
  handleBrowserDialogMessage,
} from "../../browser/browserDialogs";
import {
  frameCdpDeadline,
  getFrameTargetManager,
} from "../../browser/frameTargetManager";

/**
 * 内置浏览器调试数据收集：
 * - 网络请求记录（仅 webview；CDP 记录为主，webRequest 记录降级兜底；环形缓冲，上限 500 条）
 * - 网络请求详情（请求/响应头 + 请求体 + 响应体，经 CDP Network.getResponseBody）
 * - 网络状态模拟（离线/在线，经 Network.emulateNetworkConditions）
 * - 路由 mock（拦截并伪造响应，经 Fetch 域）
 * - JavaScript 弹窗（alert/confirm/prompt）通过 CDP 捕获与响应
 *
 * CDP 记录依赖 webview debugger 会话（与弹窗监听共用，见 ensureWebContentsDebugger）；
 * 当会话不可用（如用户打开页面 DevTools）时自动降级为 webRequest 记录。
 * 只追加监听，不改动既有代理逻辑（sessionProxy.ts 的 setProxy 不受影响）。
 */

const browserWebContentsIds = new Set<number>();

/** 供 browserTrace 等扩展模块注册 debugger 消息监听（避免与 recorder 的循环依赖）。
 * sessionId 为空串表示根 session；跨域/OOPIF iframe 事件带子 session。 */
const debuggerMessageListeners = new Set<
  (
    webContentsId: number,
    method: string,
    params: unknown,
    sessionId: string,
  ) => void
>();
export const registerDebuggerMessageListener = (
  listener: (
    webContentsId: number,
    method: string,
    params: unknown,
    sessionId: string,
  ) => void,
): void => {
  debuggerMessageListeners.add(listener);
};

const notifyDebuggerMessageListeners = (
  webContentsId: number,
  method: string,
  params: unknown,
  sessionId: string,
): void => {
  for (const listener of debuggerMessageListeners) {
    try {
      listener(webContentsId, method, params, sessionId);
    } catch {
      // 扩展监听器失败不影响核心调试功能。
    }
  }
};

// ===== 网络请求记录 =====

export type BrowserNetworkRecord = {
  id: number;
  webContentsId: number;
  url: string;
  method: string;
  status: number | string;
  resourceType: string;
  durationMs: number;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string[]>;
  recordedAt: string;
  /** 记录来源：cdp（主，含 requestId 可查详情）或 webrequest（降级）。 */
  source: "cdp" | "webrequest";
  /** 详情查询键：根会话为 CDP requestId；跨域/OOPIF 帧为 `${sessionId}:${requestId}`。 */
  requestId?: string;
  /** 跨域/OOPIF 帧的原始 CDP requestId（Network.getRequestPostData / getResponseBody 使用）。 */
  cdpRequestId?: string;
  /** 记录所属 CDP frame（含同进程子 frame 与 OOPIF）；不是 browser-frames 的不透明 frameId。 */
  cdpFrameId?: string;
  /** 记录所属帧 CDP session（仅跨域/OOPIF 帧）；详情命令按此会话发送。 */
  frameSession?: string;
  mimeType?: string;
  fromCache?: boolean;
  error?: string;
};

type BrowserRequestDetails = {
  webContentsId?: number;
  webContents?: Electron.WebContents;
};

const MAX_RECORDS = 500;
const networkRecords: BrowserNetworkRecord[] = [];
let nextRecordId = 1;
let networkRecorderInitialized = false;

// ===== CDP 网络记录（主数据源）=====
// webContentsId -> 当前导航代际的 CDP 记录；键为「帧会话 + requestId」组合
// （根会话沿用裸 requestId）。主帧导航时归档，保留最近 3 代。
type CdpNetworkState = {
  current: Map<string, BrowserNetworkRecord>;
  archived: Map<string, BrowserNetworkRecord>[];
};

const cdpNetworkRecords = new Map<number, CdpNetworkState>();
const mainFrameIds = new Map<number, string>();
const MAX_ARCHIVED_GENERATIONS = 3;
// CDP and webRequest records share nextRecordId, preventing ambiguous detail IDs.

/** CDP 请求只在所属帧会话内唯一；根会话（空 sessionId）沿用裸 requestId。 */
const cdpNetworkKey = (sessionId: string, requestId: string): string =>
  sessionId ? `${sessionId}:${requestId}` : requestId;

const findCdpRecord = (
  webContentsId: number,
  requestId: string,
): BrowserNetworkRecord | undefined => {
  const state = cdpNetworkRecords.get(webContentsId);
  if (!state) {
    return undefined;
  }
  const direct = state.current.get(requestId);
  if (direct) {
    return direct;
  }
  for (const generation of state.archived) {
    const hit = generation.get(requestId);
    if (hit) {
      return hit;
    }
  }
  return undefined;
};

const archiveNetworkGeneration = (webContentsId: number): void => {
  const state = cdpNetworkRecords.get(webContentsId);
  if (!state || state.current.size === 0) {
    return;
  }
  state.archived.unshift(state.current);
  if (state.archived.length > MAX_ARCHIVED_GENERATIONS) {
    state.archived.length = MAX_ARCHIVED_GENERATIONS;
  }
  state.current = new Map();
};

/** 详情查询时响应体/请求体的最大字节数（超出截断并标记 truncated）。 */
const MAX_BODY_BYTES = 128 * 1024;

const getBrowserWebContentsId = (
  details: BrowserRequestDetails,
): number | undefined => {
  const id = details.webContentsId ?? details.webContents?.id;
  return id !== undefined && browserWebContentsIds.has(id) ? id : undefined;
};

const pushNetworkRecord = (record: BrowserNetworkRecord): void => {
  networkRecords.push(record);
  if (networkRecords.length > MAX_RECORDS) {
    networkRecords.splice(0, networkRecords.length - MAX_RECORDS);
  }
};

/** 注册 webRequest 监听（幂等）。需在 app ready 之后调用。 */
export const initBrowserNetworkRecorder = (): void => {
  if (networkRecorderInitialized) {
    return;
  }
  networkRecorderInitialized = true;

  const pendingRequests = new Map<
    number,
    {
      webContentsId: number;
      startedAt: number;
      method: string;
      requestHeaders: Record<string, string>;
    }
  >();

  // onBeforeSendHeaders 携带最终请求头；仅记录已识别的 webview 请求，
  // 避免把 Snow App 自身 API、更新检查等请求混进浏览器调试结果。
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const webContentsId = getBrowserWebContentsId(details);
    if (webContentsId !== undefined) {
      pendingRequests.set(details.id, {
        webContentsId,
        startedAt: Date.now(),
        method: details.method,
        requestHeaders: details.requestHeaders,
      });
    }

    // onBeforeSendHeaders 是阻塞型事件；无论是否记录该请求，都必须调用
    // callback 放行，否则 defaultSession 的所有请求（包括主窗口 file://）
    // 都会永久停在 about:blank，表现为全应用白屏。
    callback({ requestHeaders: details.requestHeaders });
  });

  session.defaultSession.webRequest.onCompleted((details) => {
    const pending = pendingRequests.get(details.id);
    pendingRequests.delete(details.id);
    if (!pending) {
      return;
    }
    pushNetworkRecord({
      id: nextRecordId++,
      webContentsId: pending.webContentsId,
      url: details.url,
      method: pending.method,
      status: details.statusCode,
      resourceType: details.resourceType,
      durationMs: Date.now() - pending.startedAt,
      requestHeaders: pending.requestHeaders,
      responseHeaders: details.responseHeaders ?? {},
      recordedAt: new Date().toISOString(),
      source: "webrequest",
    });
  });

  session.defaultSession.webRequest.onErrorOccurred((details) => {
    const pending = pendingRequests.get(details.id);
    pendingRequests.delete(details.id);
    if (!pending) {
      return;
    }
    pushNetworkRecord({
      id: nextRecordId++,
      webContentsId: pending.webContentsId,
      url: details.url,
      method: pending.method,
      status: "error",
      resourceType: details.resourceType,
      durationMs: Date.now() - pending.startedAt,
      requestHeaders: pending.requestHeaders,
      responseHeaders: {},
      recordedAt: new Date().toISOString(),
      source: "webrequest",
      error: details.error,
    });
  });
};

/** 查询网络记录（最新在前）。
 * 优先返回 CDP 记录（含 requestId，可进一步查详情）；该 webContents 无 CDP
 * 记录（debugger 会话不可用）时降级返回 webRequest 记录。
 * includeStatic=false 时过滤掉成功的静态资源（图片/字体/脚本/样式表等），
 * 请求失败（error）/进行中（pending）的记录始终保留。 */
const STATIC_RESOURCE_TYPES = new Set([
  "image",
  "font",
  "script",
  "stylesheet",
]);

export type NetworkQueryOptions = {
  filter?: string;
  resourceTypes?: string[];
  /** 只返回这些 HTTP 方法（大小写不敏感）；用于单独查看 OPTIONS 预检等。 */
  methods?: string[];
  includeStatic?: boolean;
  pageIdx?: number;
  pageSize?: number;
  includePreserved?: boolean;
  /** 仅返回该 CDP frame 发起的请求；webRequest 回退没有帧归属，会显式失败。 */
  cdpFrameId?: string;
};

export type NetworkQueryResult = {
  records: BrowserNetworkRecord[];
  total: number;
  pageIdx: number;
  pageSize: number;
  hasMore: boolean;
  archivedGenerations: number;
  source: "cdp" | "webrequest";
  /** 当前过滤结果中的 OPTIONS 预检请求数（在 methods 过滤之前统计）。 */
  preflightTotal: number;
};

export const queryNetworkRecords = (
  webContentsId: number,
  options: NetworkQueryOptions = {},
): NetworkQueryResult => {
  const state = cdpNetworkRecords.get(webContentsId);
  const hasCdp =
    state !== undefined &&
    (state.current.size > 0 || state.archived.some((gen) => gen.size > 0));
  let rows: BrowserNetworkRecord[];
  let source: "cdp" | "webrequest";
  let archivedGenerations = 0;
  if (hasCdp && state) {
    const merged: BrowserNetworkRecord[] = [];
    if (options.includePreserved) {
      for (let index = state.archived.length - 1; index >= 0; index--) {
        merged.push(...state.archived[index].values());
      }
    }
    merged.push(...state.current.values());
    merged.sort((left, right) => left.id - right.id);
    rows = merged.reverse();
    source = "cdp";
    archivedGenerations = state.archived.length;
  } else {
    rows = networkRecords
      .filter((record) => record.webContentsId === webContentsId)
      .reverse();
    source = "webrequest";
  }
  let filtered = rows;
  if (options.cdpFrameId) {
    if (source === "webrequest") {
      throw new Error(
        "Frame-scoped network records require CDP capture; the webRequest fallback has no frame attribution",
      );
    }
    filtered = filtered.filter(
      (record) => record.cdpFrameId === options.cdpFrameId,
    );
  }
  if (options.includeStatic !== true) {
    filtered = filtered.filter(
      (record) =>
        !(
          typeof record.status === "number" &&
          STATIC_RESOURCE_TYPES.has(record.resourceType)
        ),
    );
  }
  if (options.resourceTypes && options.resourceTypes.length > 0) {
    const wanted = new Set(
      options.resourceTypes.map((type) => type.toLowerCase()),
    );
    filtered = filtered.filter((record) =>
      wanted.has(record.resourceType.toLowerCase()),
    );
  }
  if (options.filter) {
    try {
      const expression = new RegExp(options.filter);
      filtered = filtered.filter((record) => expression.test(record.url));
    } catch {
      filtered = [];
    }
  }
  // 预检请求在 methods 过滤前计数：即使只看 XHR/Fetch，调用方仍能发现
  // 存在 OPTIONS 预检，需要时用 methods=["OPTIONS"] 单独查看。
  const preflightTotal = filtered.reduce(
    (count, record) =>
      record.method.toUpperCase() === "OPTIONS" ? count + 1 : count,
    0,
  );
  if (options.methods && options.methods.length > 0) {
    const wanted = new Set(
      options.methods
        .map((method) => method.trim().toUpperCase())
        .filter((method) => method !== ""),
    );
    if (wanted.size > 0) {
      filtered = filtered.filter((record) =>
        wanted.has(record.method.toUpperCase()),
      );
    }
  }
  const pageIdx = Math.max(0, options.pageIdx ?? 0);
  const pageSize = Math.max(
    1,
    options.pageSize ?? Math.max(filtered.length, 1),
  );
  const start = pageIdx * pageSize;
  const records = filtered.slice(start, start + pageSize);
  return {
    records,
    total: filtered.length,
    pageIdx,
    pageSize,
    hasMore: start + records.length < filtered.length,
    archivedGenerations,
    source,
    preflightTotal,
  };
};

/** 按目标 webContents 的数字 id 查询，绝不跨 tab 扫描。 */
export const getNetworkRecord = (
  webContentsId: number,
  recordId: number,
): BrowserNetworkRecord | undefined => {
  if (
    !Number.isSafeInteger(webContentsId) ||
    webContentsId <= 0 ||
    !Number.isSafeInteger(recordId) ||
    recordId <= 0
  )
    return undefined;
  const state = cdpNetworkRecords.get(webContentsId);
  if (state) {
    for (const generation of [state.current, ...state.archived]) {
      for (const record of generation.values()) {
        if (record.id === recordId && record.webContentsId === webContentsId) {
          return record;
        }
      }
    }
  }
  return networkRecords.find(
    (record) =>
      record.id === recordId && record.webContentsId === webContentsId,
  );
};

/** 统计某个 webContents 的 CDP 记录数（含归档代际）。 */
const countCdpRecords = (state: CdpNetworkState): number =>
  state.current.size +
  state.archived.reduce((sum, generation) => sum + generation.size, 0);

/** 清除指定 webview 的所有网络记录（含归档代际）；webContentsId 为 -1 时清除全部。 */
export const clearNetworkRecords = (webContentsId: number): number => {
  if (webContentsId < 0) {
    let count = networkRecords.length;
    networkRecords.splice(0, networkRecords.length);
    for (const state of cdpNetworkRecords.values()) {
      count += countCdpRecords(state);
    }
    cdpNetworkRecords.clear();
    return count;
  }
  const before = networkRecords.length;
  for (let i = networkRecords.length - 1; i >= 0; i--) {
    if (networkRecords[i].webContentsId === webContentsId) {
      networkRecords.splice(i, 1);
    }
  }
  let count = before - networkRecords.length;
  const state = cdpNetworkRecords.get(webContentsId);
  if (state) {
    count += countCdpRecords(state);
    cdpNetworkRecords.delete(webContentsId);
  }
  return count;
};

// ===== webview 注册表与 CDP 消息路由 =====

let dialogHandlerInitialized = false;

/** 已 attach 且 Page 域已启用的 webContents 集合（弹窗捕获所需）。
 * 每个浏览器 MCP 命令都会调用 ensureWebContentsDebugger，多个 webview
 * 实例时若每次都重复下发 Page.enable 会放大 CDP 往返开销；这里记录
 * 已启用的实例，幂等跳过（attach 重置后自动失效重启用）。 */
const debuggerDomainsEnabled = new Set<number>();

/** 与共享 FrameTargetManager 共用的 Fetch 拦截参数（根会话与 iframe 会话一致）。 */
const FETCH_INTERCEPT_PARAMS = {
  patterns: [{ urlPattern: "*", requestStage: "Request" }],
};

/** 每个 webview 的 iframe 会话状态。
 * FrameTargetManager 持有真实 CDP session；这里只记录哪些域已下发，避免重复 enable。
 * Page/Runtime/Log 供弹窗与控制台使用；Network/Fetch 仍按需启用。 */
type FrameTargetState = {
  manager: ReturnType<typeof getFrameTargetManager>;
  base: Map<string, Promise<void>>;
  network: Map<string, Promise<void>>;
  fetch: Map<string, Promise<void>>;
  recordingNetwork: boolean;
  interceptingFetch: boolean;
  rootNetwork: boolean;
  rootFetch: boolean;
  unsubscribe: () => void;
};

const frameTargetStates = new Map<number, FrameTargetState>();

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const sessionCommand = (
  contents: Electron.WebContents,
  method: string,
  params: Record<string, unknown>,
  sessionId?: string,
): Promise<any> =>
  frameCdpDeadline(method, () =>
    contents.debugger.sendCommand(method, params, sessionId),
  );

const ensureTask = (
  tasks: Map<string, Promise<void>>,
  sessionId: string,
  run: () => Promise<void>,
): Promise<void> => {
  const existing = tasks.get(sessionId);
  if (existing) return existing;
  const task = run().catch((error) => {
    tasks.delete(sessionId);
    throw error;
  });
  tasks.set(sessionId, task);
  return task;
};

/** 在同一帧会话内启用共享域；已启用的域不重复下发。 */
const configureFrameSession = async (
  contents: Electron.WebContents,
  state: FrameTargetState,
  sessionId: string,
): Promise<void> => {
  await ensureTask(state.base, sessionId, async () => {
    await sessionCommand(contents, "Page.enable", {}, sessionId);
    await sessionCommand(contents, "Runtime.enable", {}, sessionId);
    await sessionCommand(contents, "Log.enable", {}, sessionId);
  });
  if (state.recordingNetwork) {
    await ensureTask(state.network, sessionId, async () => {
      await sessionCommand(contents, "Network.enable", {}, sessionId);
    });
  }
  if (state.interceptingFetch) {
    await ensureTask(state.fetch, sessionId, async () => {
      await sessionCommand(
        contents,
        "Fetch.enable",
        FETCH_INTERCEPT_PARAMS,
        sessionId,
      );
    });
  }
};

/** 取得（必要时创建）共享管理器订阅，并把现有 iframe 会话配置到位。 */
const ensureFrameTargetState = async (
  contents: Electron.WebContents,
): Promise<FrameTargetState | undefined> => {
  if (contents.isDestroyed() || !contents.debugger.isAttached()) {
    return undefined;
  }
  let state = frameTargetStates.get(contents.id);
  if (!state) {
    const manager = getFrameTargetManager(contents);
    const created: FrameTargetState = {
      manager,
      base: new Map(),
      network: new Map(),
      fetch: new Map(),
      recordingNetwork: false,
      interceptingFetch: false,
      rootNetwork: false,
      rootFetch: false,
      unsubscribe: () => {},
    };
    frameTargetStates.set(contents.id, created);
    try {
      created.unsubscribe = manager.subscribe((change) => {
        if (change.type === "detached") {
          created.base.delete(change.sessionId);
          created.network.delete(change.sessionId);
          created.fetch.delete(change.sessionId);
          // 帧 target 已消失，其弹窗无法再响应，避免留下不可处理的 pending。
          clearBrowserDialogs(contents.id, change.sessionId);
          return;
        }
        return configureFrameSession(
          contents,
          created,
          change.session.sessionId,
        );
      });
    } catch (error) {
      frameTargetStates.delete(contents.id);
      throw error;
    }
    state = created;
  }
  try {
    await state.manager.ensure();
  } catch (error) {
    snowLog.warn({
      module: "browser/network-recorder",
      func: "ensureFrameTargetState",
      message: "iframe target auto-attach unavailable",
      context: `webContentsId=${contents.id}, error=${redactBrowserText(describeError(error))}`,
    });
  }
  for (const sessionId of state.manager.sessionIds()) {
    try {
      await configureFrameSession(contents, state, sessionId);
    } catch (error) {
      snowLog.warn({
        module: "browser/network-recorder",
        func: "ensureFrameTargetState",
        message: "iframe session domain setup failed",
        context: `webContentsId=${contents.id}, error=${redactBrowserText(describeError(error))}`,
      });
    }
  }
  return state;
};

const releaseFrameTargetState = (webContentsId: number): void => {
  const state = frameTargetStates.get(webContentsId);
  if (!state) return;
  frameTargetStates.delete(webContentsId);
  state.unsubscribe();
};

/** 确保 webview 的 CDP debugger 会话可用（attach + 启用根域与 iframe 共享域）。
 * CDP 网络记录、路由 mock、登录态注入共用同一会话；
 * DevTools 打开时会话被占用，devtools-closed 后自动重连。
 * Runtime/Log 域为控制台采集（含堆栈）提供事件流；Page 域为弹窗捕获；
 * iframe 会话交给共享 FrameTargetManager，Network.enable 由
 * ensureNetworkRecording 按需启用。 */
export const ensureWebContentsDebugger = async (
  contents: Electron.WebContents,
): Promise<void> => {
  if (contents.isDestroyed() || contents.isDevToolsOpened()) {
    return;
  }
  try {
    if (!contents.debugger.isAttached()) {
      contents.debugger.attach("1.3");
      // 重新 attach 后域配置失效，需要重新启用。
      debuggerDomainsEnabled.delete(contents.id);
      releaseFrameTargetState(contents.id);
    }
    if (!debuggerDomainsEnabled.has(contents.id)) {
      await contents.debugger.sendCommand("Page.enable");
      await contents.debugger.sendCommand("Runtime.enable");
      await contents.debugger.sendCommand("Log.enable");
      debuggerDomainsEnabled.add(contents.id);
    }
    await ensureFrameTargetState(contents);
  } catch (error) {
    // DevTools 或其他调试客户端可能暂时占用 CDP；devtools-closed 后会重试。
    debuggerDomainsEnabled.delete(contents.id);
    snowLog.warn({
      module: "browser/network-recorder",
      func: "ensureWebContentsDebugger",
      message: "CDP debugger attach unavailable",
      context: `webContentsId=${contents.id}, error=${redactBrowserText(describeError(error))}`,
    });
  }
};

/** 按需启用 Network 网络记录（网络查询/详情/状态模拟前调用）。
 * 根会话与当前 iframe 会话都开启 Network 事件流；后续新 attach 的
 * iframe target 由 FrameTargetManager 订阅在恢复运行前配置。
 * 未使用网络调试的 webview 保持零网络 CDP 开销。 */
export const ensureNetworkRecording = async (
  contents: Electron.WebContents,
): Promise<void> => {
  await ensureWebContentsDebugger(contents);
  if (contents.isDestroyed() || !contents.debugger.isAttached()) {
    return;
  }
  const state =
    frameTargetStates.get(contents.id) ??
    (await ensureFrameTargetState(contents));
  if (!state) {
    return;
  }
  state.recordingNetwork = true;
  try {
    if (!state.rootNetwork) {
      await sessionCommand(contents, "Network.enable", {});
      state.rootNetwork = true;
    }
  } catch (error) {
    snowLog.warn({
      module: "browser/network-recorder",
      func: "ensureNetworkRecording",
      message: "Network.enable unavailable",
      context: `webContentsId=${contents.id}, error=${redactBrowserText(describeError(error))}`,
    });
  }
  for (const sessionId of state.manager.sessionIds()) {
    try {
      await ensureTask(state.network, sessionId, async () => {
        await sessionCommand(contents, "Network.enable", {}, sessionId);
      });
    } catch (error) {
      snowLog.warn({
        module: "browser/network-recorder",
        func: "ensureNetworkRecording",
        message: "iframe Network.enable unavailable",
        context: `webContentsId=${contents.id}, error=${redactBrowserText(describeError(error))}`,
      });
    }
  }
};

/**
 * 注册 webview guest 的 CDP 会话与事件路由。
 *
 * 仅做注册与消息路由，不主动 attach（普通浏览不 attach CDP，
 * 页面的 alert/confirm/prompt 走 Electron 原生对话框）；调试功能
 * （网络记录 / MCP / 登录态 / 路由 mock）按需调用 ensureWebContentsDebugger。
 * 调试期间的弹窗由共享 CDP 监听记录，允许拥有者经 IPC 查询/响应；
 * 60 秒无人响应自动拒绝，避免页面永久挂起。
 */
export const initBrowserWebviewRegistry = (): void => {
  if (dialogHandlerInitialized) {
    return;
  }
  dialogHandlerInitialized = true;

  app.on("web-contents-created", (_event, contents) => {
    if (contents.getType() !== "webview") {
      return;
    }

    browserWebContentsIds.add(contents.id);

    contents.debugger.on("message", (_event, method, params, sessionId) => {
      const session = sessionId ?? "";
      switch (method) {
        case "Page.javascriptDialogOpening":
        case "Page.javascriptDialogClosed":
          handleBrowserDialogMessage(contents, method, params, session);
          break;
        case "Network.requestWillBeSent":
          handleNetworkRequestWillBeSent(contents.id, params, session);
          break;
        case "Network.responseReceived":
          handleNetworkResponseReceived(contents.id, params, session);
          break;
        case "Network.loadingFailed":
          handleNetworkLoadingFailed(contents.id, params, session);
          break;
        case "Fetch.requestPaused":
          handleFetchRequestPaused(contents, params, session);
          break;
        case "Page.frameNavigated": {
          const frame = (
            params as { frame?: { id?: unknown; parentId?: unknown } } | null
          )?.frame;
          // 只有根会话的主 frame 导航才更新主 frame 归属；iframe 会话的
          // frameNavigated 不代表整页导航。
          if (
            !session &&
            frame &&
            frame.parentId == null &&
            typeof frame.id === "string"
          ) {
            mainFrameIds.set(contents.id, frame.id);
          }
          notifyDebuggerMessageListeners(contents.id, method, params, session);
          break;
        }
        default:
          notifyDebuggerMessageListeners(contents.id, method, params, session);
          break;
      }
    });

    // 打开 DevTools 会让 Electron debugger 会话断开；关闭后恢复监听，
    // 并按需恢复 Fetch 拦截（路由 mock 规则仍保留在内存中）。
    contents.on("devtools-closed", () => {
      void ensureWebContentsDebugger(contents);
      const rules = routeRules.get(contents.id);
      if (rules && rules.length > 0) {
        void enableFetchInterception(contents).catch(() => {});
      }
    });
    contents.debugger.on("detach", () => {
      clearBrowserDialogs(contents.id);
      debuggerDomainsEnabled.delete(contents.id);
      releaseFrameTargetState(contents.id);
    });
    contents.once("destroyed", () => {
      clearBrowserDialogs(contents.id);
      browserWebContentsIds.delete(contents.id);
      debuggerDomainsEnabled.delete(contents.id);
      releaseFrameTargetState(contents.id);
      cdpNetworkRecords.delete(contents.id);
      mainFrameIds.delete(contents.id);
      routeRules.delete(contents.id);
    });
  });
};

// ===== CDP 网络事件处理 =====

type CdpRequestWillBeSent = {
  requestId?: unknown;
  type?: unknown;
  frameId?: unknown;
  request?: { url?: unknown; method?: unknown; headers?: unknown };
  redirectResponse?: {
    status?: unknown;
    headers?: unknown;
    mimeType?: unknown;
    fromDiskCache?: unknown;
  };
};

type CdpResponseReceived = {
  requestId?: unknown;
  type?: unknown;
  response?: {
    status?: unknown;
    headers?: unknown;
    mimeType?: unknown;
    fromDiskCache?: unknown;
  };
};

type CdpLoadingFailed = {
  requestId?: unknown;
  errorText?: unknown;
  canceled?: unknown;
};

const toHeaderRecord = (value: unknown): Record<string, string> => {
  if (value === null || typeof value !== "object") {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(value)) {
    if (typeof val === "string") {
      out[key] = val;
    }
  }
  return out;
};

const toHeaderArrayRecord = (value: unknown): Record<string, string[]> => {
  if (value === null || typeof value !== "object") {
    return {};
  }
  const out: Record<string, string[]> = {};
  for (const [key, val] of Object.entries(value)) {
    out[key] =
      typeof val === "string"
        ? [val]
        : Array.isArray(val)
          ? val.map(String)
          : [];
  }
  return out;
};

const pushCdpRecord = (
  webContentsId: number,
  record: BrowserNetworkRecord,
): void => {
  let state = cdpNetworkRecords.get(webContentsId);
  if (!state) {
    state = { current: new Map(), archived: [] };
    cdpNetworkRecords.set(webContentsId, state);
  }
  if (record.requestId) {
    state.current.set(record.requestId, record);
  }
  if (state.current.size > MAX_RECORDS) {
    const oldest = state.current.keys().next().value;
    if (oldest !== undefined) {
      state.current.delete(oldest);
    }
  }
};

const handleNetworkRequestWillBeSent = (
  webContentsId: number,
  params: unknown,
  sessionId: string,
): void => {
  const p = params as CdpRequestWillBeSent;
  const requestId = p?.requestId;
  if (typeof requestId !== "string") {
    return;
  }
  const key = cdpNetworkKey(sessionId, requestId);
  const frameId = typeof p?.frameId === "string" ? p.frameId : undefined;
  // 主帧文档请求 = 新一次导航：当前代际归档（includePreserved 可见）。
  // 仅限根会话，iframe/OOPIF 的文档导航不归档整页记录。
  if (
    !sessionId &&
    p?.type === "Document" &&
    frameId !== undefined &&
    frameId === mainFrameIds.get(webContentsId)
  ) {
    archiveNetworkGeneration(webContentsId);
  }
  const url = typeof p?.request?.url === "string" ? p.request.url : "";
  const method = typeof p?.request?.method === "string" ? p.request.method : "";
  const requestHeaders = toHeaderRecord(p?.request?.headers);
  const resourceType = typeof p?.type === "string" ? p.type : "";
  const existing = cdpNetworkRecords.get(webContentsId)?.current.get(key);
  if (existing && p?.redirectResponse) {
    // 重定向链：更新为目标请求与响应信息，不新建记录。
    existing.url = url;
    existing.method = method;
    existing.requestHeaders = requestHeaders;
    const status = p.redirectResponse.status;
    if (typeof status === "number") {
      existing.status = status;
    }
    existing.responseHeaders = toHeaderArrayRecord(p.redirectResponse.headers);
    existing.mimeType =
      typeof p.redirectResponse.mimeType === "string"
        ? p.redirectResponse.mimeType
        : undefined;
    existing.fromCache = p.redirectResponse.fromDiskCache === true;
    if (resourceType) {
      existing.resourceType = resourceType;
    }
    return;
  }
  pushCdpRecord(webContentsId, {
    id: nextRecordId++,
    webContentsId,
    requestId: key,
    ...(sessionId ? { cdpRequestId: requestId, frameSession: sessionId } : {}),
    ...(frameId ? { cdpFrameId: frameId } : {}),
    url,
    method,
    status: "pending",
    resourceType,
    durationMs: 0,
    requestHeaders,
    responseHeaders: {},
    recordedAt: new Date().toISOString(),
    source: "cdp",
  });
};

const handleNetworkResponseReceived = (
  webContentsId: number,
  params: unknown,
  sessionId: string,
): void => {
  const p = params as CdpResponseReceived;
  const requestId = p?.requestId;
  if (typeof requestId !== "string") {
    return;
  }
  const record = cdpNetworkRecords
    .get(webContentsId)
    ?.current.get(cdpNetworkKey(sessionId, requestId));
  if (!record) {
    return;
  }
  const status = p?.response?.status;
  if (typeof status === "number") {
    record.status = status;
  }
  record.responseHeaders = toHeaderArrayRecord(p?.response?.headers);
  record.mimeType =
    typeof p?.response?.mimeType === "string" ? p.response.mimeType : undefined;
  record.fromCache = p?.response?.fromDiskCache === true;
  if (typeof p?.type === "string" && p.type) {
    record.resourceType = p.type;
  }
};

const handleNetworkLoadingFailed = (
  webContentsId: number,
  params: unknown,
  sessionId: string,
): void => {
  const p = params as CdpLoadingFailed;
  const requestId = p?.requestId;
  if (typeof requestId !== "string") {
    return;
  }
  const record = cdpNetworkRecords
    .get(webContentsId)
    ?.current.get(cdpNetworkKey(sessionId, requestId));
  if (!record) {
    return;
  }
  record.status = "error";
  const text =
    typeof p?.errorText === "string" ? p.errorText : "Request failed";
  record.error = p?.canceled === true ? `${text} (canceled)` : text;
};

// ===== 网络请求详情（请求/响应体）=====

const truncateText = (
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } => {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return { text, truncated: false };
  }
  let used = 0;
  for (let i = 0; i < text.length; i++) {
    used += Buffer.byteLength(text[i], "utf8");
    if (used > maxBytes) {
      return {
        text: `${text.slice(0, i)}\n…[truncated at ${maxBytes} bytes]…`,
        truncated: true,
      };
    }
  }
  return { text, truncated: false };
};

/** 校验 webContentsId 属于内置浏览器 webview，返回其 WebContents（供 CDP 命令桥等复用）。 */
export const getBrowserWebContents = (
  webContentsId: number,
): Electron.WebContents => {
  if (!browserWebContentsIds.has(webContentsId)) {
    throw new Error("Invalid browser webContents id");
  }
  const contents = webContents.fromId(webContentsId);
  if (!contents || contents.isDestroyed()) {
    throw new Error("Browser web contents no longer exists");
  }
  return contents;
};

export type NetworkDetailsOptions = {
  maxBodyBytes?: number;
  requestFilePath?: string;
  responseFilePath?: string;
};

export type BrowserNetworkDetails = {
  found: boolean;
  error?: string;
  record?: BrowserNetworkRecord;
  requestBody?: { text: string; truncated: boolean };
  requestBodyFile?: { path: string; bytes: number; truncated: boolean };
  responseBody?: { text: string; base64Encoded: boolean; truncated: boolean };
  responseBodyFile?: { path: string; bytes: number; truncated: boolean };
  responseBodyError?: string;
};

const saveBodyToFile = async (
  filePath: string,
  text: string,
  base64Encoded: boolean,
  maxBytes: number,
): Promise<{ bytes: number; truncated: boolean }> => {
  const buffer = base64Encoded
    ? Buffer.from(text, "base64")
    : Buffer.from(text, "utf8");
  const truncated = buffer.byteLength > maxBytes;
  const chunk = truncated ? buffer.subarray(0, maxBytes) : buffer;
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, chunk);
  return { bytes: chunk.byteLength, truncated };
};

/** 查询单条请求的完整详情（请求头/请求体/响应头/响应体）。
 * 提供 requestFilePath / responseFilePath 时把 body 写入文件（受 maxBodyBytes 上限截断）。 */
export const queryNetworkDetails = async (
  webContentsId: number,
  requestId: string,
  options: NetworkDetailsOptions = {},
): Promise<BrowserNetworkDetails> => {
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
  const record = findCdpRecord(webContentsId, requestId);
  if (!record) {
    return {
      found: false,
      error: `Network request not found: ${requestId}. Use action=network to list requests first (details require CDP records).`,
    };
  }
  const contents = getBrowserWebContents(webContentsId);
  await ensureNetworkRecording(contents);
  if (!contents.debugger.isAttached()) {
    return {
      found: true,
      record,
      error:
        "Browser debugger is unavailable; close the page DevTools and retry",
    };
  }
  // requestId 是记录里的详情键；跨域/OOPIF 帧的原始 CDP ID 与所属会话单独保存。
  const cdpRequestId = record.cdpRequestId ?? record.requestId;
  if (!cdpRequestId) {
    return {
      found: true,
      record,
      error: "CDP request id is unavailable for this record",
    };
  }
  const sessionId = record.frameSession;

  const details: BrowserNetworkDetails = { found: true, record };
  try {
    const result = (await contents.debugger.sendCommand(
      "Network.getRequestPostData",
      { requestId: cdpRequestId },
      sessionId,
    )) as { postData?: unknown };
    if (typeof result.postData === "string") {
      if (options.requestFilePath) {
        const saved = await saveBodyToFile(
          options.requestFilePath,
          result.postData,
          false,
          maxBodyBytes,
        );
        details.requestBodyFile = { path: options.requestFilePath, ...saved };
      } else {
        details.requestBody = truncateText(result.postData, maxBodyBytes);
      }
    }
  } catch {
    // 无请求体或请求已过期。
  }
  try {
    const result = (await contents.debugger.sendCommand(
      "Network.getResponseBody",
      { requestId: cdpRequestId },
      sessionId,
    )) as { body?: unknown; base64Encoded?: unknown };
    if (typeof result.body === "string") {
      const base64Encoded = result.base64Encoded === true;
      if (options.responseFilePath) {
        const saved = await saveBodyToFile(
          options.responseFilePath,
          result.body,
          base64Encoded,
          maxBodyBytes,
        );
        details.responseBodyFile = {
          path: options.responseFilePath,
          ...saved,
        };
      } else {
        const truncated = truncateText(result.body, maxBodyBytes);
        details.responseBody = {
          text: truncated.text,
          base64Encoded,
          truncated: truncated.truncated,
        };
      }
    }
  } catch (error) {
    details.responseBodyError = `Response body unavailable (request too old, not yet finished, or its frame target is gone): ${redactBrowserText(
      describeError(error),
    )}`;
  }
  return details;
};

// ===== 网络状态模拟（离线/在线）=====

export const setBrowserNetworkState = async (
  webContentsId: number,
  offline: boolean,
): Promise<{ state: "online" | "offline" }> => {
  const contents = getBrowserWebContents(webContentsId);
  await ensureNetworkRecording(contents);
  if (!contents.debugger.isAttached()) {
    throw new Error(
      "Browser debugger is unavailable; close the page DevTools and retry",
    );
  }
  await contents.debugger.sendCommand("Network.emulateNetworkConditions", {
    offline,
    latency: 0,
    downloadThroughput: offline ? 0 : -1,
    uploadThroughput: offline ? 0 : -1,
  });
  return { state: offline ? "offline" : "online" };
};

// ===== 路由 mock（Fetch 拦截）=====

export type BrowserRouteRule = {
  pattern: string;
  status?: number;
  body?: string;
  contentType?: string;
  headers?: Record<string, string>;
};

const routeRules = new Map<number, BrowserRouteRule[]>();

/** pattern 匹配：/regex/ 形式按正则，否则按子串匹配。 */
const matchesPattern = (url: string, pattern: string): boolean => {
  if (!url) {
    return false;
  }
  if (pattern.startsWith("/") && pattern.lastIndexOf("/") > 0) {
    try {
      return new RegExp(pattern.slice(1, pattern.lastIndexOf("/"))).test(url);
    } catch {
      return url.includes(pattern);
    }
  }
  return url.includes(pattern);
};

/** 在根会话与所有 iframe 会话启用 Fetch 拦截；后续新 target 由
 * FrameTargetManager 订阅在恢复运行前配置。 */
const enableFetchInterception = async (
  contents: Electron.WebContents,
): Promise<void> => {
  if (!contents.debugger.isAttached()) {
    return;
  }
  const state =
    frameTargetStates.get(contents.id) ??
    (await ensureFrameTargetState(contents));
  if (!state) {
    return;
  }
  state.interceptingFetch = true;
  if (!state.rootFetch) {
    await sessionCommand(contents, "Fetch.enable", FETCH_INTERCEPT_PARAMS);
    state.rootFetch = true;
  }
  for (const sessionId of state.manager.sessionIds()) {
    await ensureTask(state.fetch, sessionId, async () => {
      await sessionCommand(
        contents,
        "Fetch.enable",
        FETCH_INTERCEPT_PARAMS,
        sessionId,
      );
    });
  }
};

/** 关闭根会话与 iframe 会话的 Fetch 拦截；会话已断开时只记录告警。 */
const disableFetchInterception = async (
  contents: Electron.WebContents,
): Promise<void> => {
  const state = frameTargetStates.get(contents.id);
  if (!state) {
    return;
  }
  state.interceptingFetch = false;
  state.fetch.clear();
  const sessions = state.manager.sessionIds();
  if (state.rootFetch) {
    state.rootFetch = false;
    try {
      await sessionCommand(contents, "Fetch.disable", {});
    } catch (error) {
      snowLog.warn({
        module: "browser/network-recorder",
        func: "disableFetchInterception",
        message: "Fetch.disable unavailable",
        context: `webContentsId=${contents.id}, error=${redactBrowserText(describeError(error))}`,
      });
    }
  }
  for (const sessionId of sessions) {
    try {
      await sessionCommand(contents, "Fetch.disable", {}, sessionId);
    } catch (error) {
      snowLog.warn({
        module: "browser/network-recorder",
        func: "disableFetchInterception",
        message: "iframe Fetch.disable unavailable",
        context: `webContentsId=${contents.id}, error=${redactBrowserText(describeError(error))}`,
      });
    }
  }
};

/** 设置路由 mock 规则（全量替换；空数组 = 清除并恢复真实网络）。 */
export const setBrowserRouteRules = async (
  webContentsId: number,
  rules: BrowserRouteRule[],
): Promise<{ active: number }> => {
  const contents = getBrowserWebContents(webContentsId);
  await ensureWebContentsDebugger(contents);
  if (!contents.debugger.isAttached()) {
    throw new Error(
      "Browser debugger is unavailable; close the page DevTools and retry",
    );
  }
  routeRules.set(webContentsId, rules);
  if (rules.length > 0) {
    await enableFetchInterception(contents);
  } else {
    await disableFetchInterception(contents);
  }
  return { active: rules.length };
};

export const clearBrowserRouteRules = async (
  webContentsId: number,
): Promise<{ active: number }> => setBrowserRouteRules(webContentsId, []);

const logFetchFailure = (
  contents: Electron.WebContents,
  func: string,
  error: unknown,
): void => {
  snowLog.warn({
    module: "browser/network-recorder",
    func,
    message: "Fetch interception command failed",
    context: `webContentsId=${contents.id}, error=${redactBrowserText(describeError(error))}`,
  });
};

const handleFetchRequestPaused = (
  contents: Electron.WebContents,
  params: unknown,
  sessionId: string,
): void => {
  const requestId = (params as { requestId?: unknown } | null)?.requestId;
  if (typeof requestId !== "string") {
    return;
  }
  const url = (params as { request?: { url?: unknown } } | null)?.request?.url;
  const urlText = typeof url === "string" ? url : "";
  const rules = routeRules.get(contents.id);
  const rule = rules?.find((r) => matchesPattern(urlText, r.pattern));
  const targetSession = sessionId || undefined;
  if (!rule) {
    void sessionCommand(
      contents,
      "Fetch.continueRequest",
      { requestId },
      targetSession,
    ).catch((error) =>
      logFetchFailure(contents, "handleFetchRequestPaused", error),
    );
    return;
  }
  const headers: { name: string; value: string }[] = Object.entries(
    rule.headers ?? {},
  ).map(([name, value]) => ({ name, value }));
  if (rule.contentType) {
    headers.push({ name: "Content-Type", value: rule.contentType });
  }
  void sessionCommand(
    contents,
    "Fetch.fulfillRequest",
    {
      requestId,
      responseCode: rule.status ?? 200,
      responseHeaders: headers,
      body:
        rule.body !== undefined
          ? Buffer.from(rule.body, "utf8").toString("base64")
          : undefined,
    },
    targetSession,
  ).catch((error) =>
    logFetchFailure(contents, "handleFetchRequestPaused", error),
  );
};
