import { app, session, webContents } from "electron";
import { snowLog } from "../../../utils/snowLogger";

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

/** 供 browserTrace 等扩展模块注册 debugger 消息监听（避免与 recorder 的循环依赖）。 */
const debuggerMessageListeners = new Set<
  (webContentsId: number, method: string, params: unknown) => void
>();
export const registerDebuggerMessageListener = (
  listener: (webContentsId: number, method: string, params: unknown) => void,
): void => {
  debuggerMessageListeners.add(listener);
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
  /** CDP 请求 ID，用于查询请求/响应体（仅 cdp 记录）。 */
  requestId?: string;
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
// webContentsId -> requestId -> 进行中的 CDP 记录；请求完成后保留在 map 内供详情查询。
const cdpNetworkRecords = new Map<number, Map<string, BrowserNetworkRecord>>();
let nextCdpRecordId = 1;

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

/** 查询网络记录：最新在前；filter 为 URL 正则（Rust 入口已校验）。
 * 优先返回 CDP 记录（含 requestId，可进一步查详情）；该 webContents 无 CDP
 * 记录（debugger 会话不可用）时降级返回 webRequest 记录。
 * includeStatic=false 时，过滤掉成功的静态资源（图片/字体/脚本/样式表等），
 * 与 Playwright browser_network_requests 的 static 参数对齐。 */
const STATIC_RESOURCE_TYPES = new Set([
  "image",
  "font",
  "script",
  "stylesheet",
]);

export const queryNetworkRecords = (
  webContentsId: number,
  filter?: string,
  limit = 50,
  includeStatic = false,
): BrowserNetworkRecord[] => {
  const cdp = cdpNetworkRecords.get(webContentsId);
  let result =
    cdp && cdp.size > 0
      ? [...cdp.values()]
      : networkRecords.filter(
          (record) => record.webContentsId === webContentsId,
        );
  if (!includeStatic) {
    result = result.filter(
      (record) =>
        typeof record.status === "number" &&
        !STATIC_RESOURCE_TYPES.has(record.resourceType),
    );
  }
  if (filter) {
    try {
      const expression = new RegExp(filter);
      result = result.filter((record) => expression.test(record.url));
    } catch {
      return [];
    }
  }
  return result.slice(-limit).reverse();
};

/** 按 id 获取单条网络记录详情。 */
export const getNetworkRecord = (
  recordId: number,
): BrowserNetworkRecord | undefined =>
  networkRecords.find((record) => record.id === recordId);

/** 清除指定 webview 的所有网络记录；webContentsId 为 -1 时清除全部。 */
export const clearNetworkRecords = (webContentsId: number): number => {
  if (webContentsId < 0) {
    const count = networkRecords.length;
    networkRecords.splice(0, networkRecords.length);
    return count;
  }
  const before = networkRecords.length;
  for (let i = networkRecords.length - 1; i >= 0; i--) {
    if (networkRecords[i].webContentsId === webContentsId) {
      networkRecords.splice(i, 1);
    }
  }
  return before - networkRecords.length;
};

// ===== webview 注册表与 CDP 消息路由 =====

let dialogHandlerInitialized = false;

/** 已 attach 且 Page 域已启用的 webContents 集合（弹窗捕获所需）。
 * 每个浏览器 MCP 命令都会调用 ensureWebContentsDebugger，多个 webview
 * 实例时若每次都重复下发 Page.enable 会放大 CDP 往返开销；这里记录
 * 已启用的实例，幂等跳过（attach 重置后自动失效重启用）。 */
const debuggerDomainsEnabled = new Set<number>();

/** 已启用 Network 记录（Network.enable）的 webContents 集合。
 * 网络记录按需启用：只有真正查询网络调试数据的实例才开启 Network
 * 事件流，其余 webview（含用户手动新建、从未调试的 tab）保持零网络
 * CDP 开销。 */
const networkRecordingEnabled = new Set<number>();

/** 确保 webview 的 CDP debugger 会话可用（attach + 启用 Page 域）。
 * CDP 网络记录、路由 mock、登录态注入共用同一会话；
 * DevTools 打开时会话被占用，devtools-closed 后自动重连。
 * Network.enable 由 ensureNetworkRecording 按需启用。 */
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
      networkRecordingEnabled.delete(contents.id);
    }
    if (!debuggerDomainsEnabled.has(contents.id)) {
      await contents.debugger.sendCommand("Page.enable");
      debuggerDomainsEnabled.add(contents.id);
    }
  } catch {
    // DevTools 或其他调试客户端可能暂时占用 CDP；devtools-closed 后会重试。
    debuggerDomainsEnabled.delete(contents.id);
    snowLog.warn({
      module: "browser/network-recorder",
      func: "ensureWebContentsDebugger",
      message: "CDP debugger attach unavailable",
      context: `webContentsId=${contents.id}`,
    });
  }
};

/** 按需启用 Network 网络记录（网络查询/详情/状态模拟前调用）。
 * 多个浏览器实例时，只有真正使用网络调试的实例才开启事件流，
 * 其余 webview 保持零网络 CDP 开销。 */
export const ensureNetworkRecording = async (
  contents: Electron.WebContents,
): Promise<void> => {
  await ensureWebContentsDebugger(contents);
  if (contents.isDestroyed() || !contents.debugger.isAttached()) {
    return;
  }
  if (networkRecordingEnabled.has(contents.id)) {
    return;
  }
  try {
    await contents.debugger.sendCommand("Network.enable");
    networkRecordingEnabled.add(contents.id);
  } catch {
    // DevTools 占用等场景；下次调用时重试。
  }
};

/**
 * 注册 webview guest 的 CDP 会话与事件路由。
 *
 * 仅做注册与消息路由，不主动 attach（普通浏览不 attach CDP，
 * 页面的 alert/confirm/prompt 走 Electron 原生对话框）；调试功能
 * （网络记录 / MCP / 登录态 / 路由 mock）按需调用 ensureWebContentsDebugger。
 * 调试会话激活期间 Chromium 会接管 JS 弹窗并挂起页面，而引擎无自绘
 * 弹窗 UI，此时对 Page.javascriptDialogOpening 直接拒绝应答（脚本拿到
 * false），保证页面不卡死。
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

    contents.debugger.on("message", (_event, method, params) => {
      switch (method) {
        case "Page.javascriptDialogOpening":
          // 调试会话期间弹窗被 Chromium 接管且无 UI 可展示，
          // 自动拒绝避免页面脚本永久挂起。
          contents.debugger
            .sendCommand("Page.handleJavaScriptDialog", { accept: false })
            .catch(() => {});
          break;
        case "Network.requestWillBeSent":
          handleNetworkRequestWillBeSent(contents.id, params);
          break;
        case "Network.responseReceived":
          handleNetworkResponseReceived(contents.id, params);
          break;
        case "Network.loadingFailed":
          handleNetworkLoadingFailed(contents.id, params);
          break;
        case "Fetch.requestPaused":
          handleFetchRequestPaused(contents, params);
          break;
        default:
          for (const listener of debuggerMessageListeners) {
            try {
              listener(contents.id, method, params);
            } catch {
              // 扩展监听器失败不影响核心调试功能。
            }
          }
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
    contents.once("destroyed", () => {
      browserWebContentsIds.delete(contents.id);
      debuggerDomainsEnabled.delete(contents.id);
      networkRecordingEnabled.delete(contents.id);
      cdpNetworkRecords.delete(contents.id);
      routeRules.delete(contents.id);
    });
  });
};

// ===== CDP 网络事件处理 =====

type CdpRequestWillBeSent = {
  requestId?: unknown;
  type?: unknown;
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
  let map = cdpNetworkRecords.get(webContentsId);
  if (!map) {
    map = new Map();
    cdpNetworkRecords.set(webContentsId, map);
  }
  if (record.requestId) {
    map.set(record.requestId, record);
  }
  if (map.size > MAX_RECORDS) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) {
      map.delete(oldest);
    }
  }
};

const handleNetworkRequestWillBeSent = (
  webContentsId: number,
  params: unknown,
): void => {
  const p = params as CdpRequestWillBeSent;
  const requestId = p?.requestId;
  if (typeof requestId !== "string") {
    return;
  }
  const url = typeof p?.request?.url === "string" ? p.request.url : "";
  const method = typeof p?.request?.method === "string" ? p.request.method : "";
  const requestHeaders = toHeaderRecord(p?.request?.headers);
  const resourceType = typeof p?.type === "string" ? p.type : "";
  const existing = cdpNetworkRecords.get(webContentsId)?.get(requestId);
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
    id: nextCdpRecordId++,
    webContentsId,
    requestId,
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
): void => {
  const p = params as CdpResponseReceived;
  const requestId = p?.requestId;
  if (typeof requestId !== "string") {
    return;
  }
  const record = cdpNetworkRecords.get(webContentsId)?.get(requestId);
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
): void => {
  const p = params as CdpLoadingFailed;
  const requestId = p?.requestId;
  if (typeof requestId !== "string") {
    return;
  }
  const record = cdpNetworkRecords.get(webContentsId)?.get(requestId);
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

export type BrowserNetworkDetails = {
  found: boolean;
  error?: string;
  record?: BrowserNetworkRecord;
  requestBody?: { text: string; truncated: boolean };
  responseBody?: { text: string; base64Encoded: boolean; truncated: boolean };
  responseBodyError?: string;
};

/** 查询单条请求的完整详情（请求头/请求体/响应头/响应体）。 */
export const queryNetworkDetails = async (
  webContentsId: number,
  requestId: string,
  maxBodyBytes = MAX_BODY_BYTES,
): Promise<BrowserNetworkDetails> => {
  const record = cdpNetworkRecords.get(webContentsId)?.get(requestId);
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

  const details: BrowserNetworkDetails = { found: true, record };
  try {
    const result = (await contents.debugger.sendCommand(
      "Network.getRequestPostData",
      { requestId },
    )) as { postData?: unknown };
    if (typeof result.postData === "string") {
      details.requestBody = truncateText(result.postData, maxBodyBytes);
    }
  } catch {
    // 无请求体或请求已过期。
  }
  try {
    const result = (await contents.debugger.sendCommand(
      "Network.getResponseBody",
      { requestId },
    )) as { body?: unknown; base64Encoded?: unknown };
    if (typeof result.body === "string") {
      const truncated = truncateText(result.body, maxBodyBytes);
      details.responseBody = {
        text: truncated.text,
        base64Encoded: result.base64Encoded === true,
        truncated: truncated.truncated,
      };
    }
  } catch {
    details.responseBodyError =
      "Response body unavailable (request too old or not yet finished)";
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

const enableFetchInterception = async (
  contents: Electron.WebContents,
): Promise<void> => {
  if (!contents.debugger.isAttached()) {
    return;
  }
  await contents.debugger.sendCommand("Fetch.enable", {
    patterns: [{ urlPattern: "*", requestStage: "Request" }],
  });
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
    try {
      await contents.debugger.sendCommand("Fetch.disable");
    } catch {
      // 会话可能已断开，忽略。
    }
  }
  return { active: rules.length };
};

export const clearBrowserRouteRules = async (
  webContentsId: number,
): Promise<{ active: number }> => setBrowserRouteRules(webContentsId, []);

const handleFetchRequestPaused = (
  contents: Electron.WebContents,
  params: unknown,
): void => {
  const requestId = (params as { requestId?: unknown } | null)?.requestId;
  if (typeof requestId !== "string") {
    return;
  }
  const url = (params as { request?: { url?: unknown } } | null)?.request?.url;
  const urlText = typeof url === "string" ? url : "";
  const rules = routeRules.get(contents.id);
  const rule = rules?.find((r) => matchesPattern(urlText, r.pattern));
  if (!rule) {
    void contents.debugger
      .sendCommand("Fetch.continueRequest", { requestId })
      .catch(() => {});
    return;
  }
  const headers: { name: string; value: string }[] = Object.entries(
    rule.headers ?? {},
  ).map(([name, value]) => ({ name, value }));
  if (rule.contentType) {
    headers.push({ name: "Content-Type", value: rule.contentType });
  }
  void contents.debugger
    .sendCommand("Fetch.fulfillRequest", {
      requestId,
      responseCode: rule.status ?? 200,
      responseHeaders: headers,
      body:
        rule.body !== undefined
          ? Buffer.from(rule.body, "utf8").toString("base64")
          : undefined,
    })
    .catch(() => {});
};
