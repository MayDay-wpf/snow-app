import { app, type WebContents } from "electron";
import type { NativeBridge } from "../../native/types";
import { redactBrowserText } from "../../../shared/browserRedaction";
import { snowLog } from "../../../utils/snowLogger";
import {
  frameCdpDeadline,
  getFrameTargetManager,
} from "../../browser/frameTargetManager";
import {
  ensureWebContentsDebugger,
  getBrowserWebContents,
  registerDebuggerMessageListener,
} from "./browserNetworkRecorder";

/**
 * 浏览器脚本登记：按需启用 CDP Debugger 域，记录已解析脚本与 source map，
 * 提供脚本列表、源码搜索与「原始源码位置 -> 生成位置」换算。
 * source map 的解析与文本搜索在 Rust 侧完成。
 */

const IDLE_DISABLE_MS = 60_000;
const MAP_FETCH_TIMEOUT_MS = 8_000;
const MAP_SCAN_DEADLINE_MS = 8_000;
const SEARCH_DEADLINE_MS = 12_000;
const MAX_MAP_BYTES = 96 * 1024 * 1024;
const MAX_SCANNED_SCRIPTS = 500;
const MAX_TRACKED_SCRIPT_IDS = 8_000;
const MAP_CONCURRENCY = 8;

export type BrowserScriptInfo = {
  /** 空串 = 根会话，其余为 iframe 会话。 */
  sessionKey: string;
  scriptId: string;
  url: string;
  sourceMapURL?: string;
  hash?: string;
  endLine: number;
};

type LoadedSourceMap = {
  key: string;
  /** 已解析为完整 URL 的 sources。 */
  sources: string[];
  hasContent: boolean[];
};

type MapEntry = {
  promise: Promise<LoadedSourceMap | null>;
  value?: LoadedSourceMap | null;
};

type ScriptTabState = {
  enabled: Set<string>;
  enabling: Map<string, Promise<void>>;
  byUrl: Map<string, BrowserScriptInfo>;
  byId: Map<string, BrowserScriptInfo>;
  maps: Map<string, MapEntry>;
  mapSeq: number;
  holds: Set<string>;
  idleTimer?: ReturnType<typeof setTimeout>;
  subscription?: () => void;
  autoResumed: number;
};

/** 0 起的生成位置，url 为脚本的完整 URL。 */
export type ScriptTarget = {
  url: string;
  lineNumber: number;
  columnNumber: number;
};

export type ScriptLookup =
  | { kind: "generated"; scripts: BrowserScriptInfo[] }
  | {
      kind: "original";
      source: string;
      /** 实际落点（0 起），无可执行代码的行会顺延。 */
      lineNumber: number;
      columnNumber: number;
      targets: ScriptTarget[];
    }
  | { kind: "ambiguous"; sources: string[] }
  | { kind: "none"; candidates: string[]; mapsTimedOut: boolean };

type SessionListener = (
  contents: WebContents,
  sessionKey: string,
) => void | Promise<void>;

let nativeBridge: NativeBridge | undefined;
const states = new Map<number, ScriptTabState>();
const sessionListeners = new Set<SessionListener>();
const parsedListeners = new Set<(webContentsId: number) => void>();
const resetListeners = new Set<(webContentsId: number) => void>();

const native = (): NativeBridge => {
  if (!nativeBridge) throw new Error("Native bridge is not ready");
  return nativeBridge;
};

const tabState = (webContentsId: number): ScriptTabState => {
  let state = states.get(webContentsId);
  if (!state) {
    state = {
      enabled: new Set(),
      enabling: new Map(),
      byUrl: new Map(),
      byId: new Map(),
      maps: new Map(),
      mapSeq: 0,
      holds: new Set(),
      autoResumed: 0,
    };
    states.set(webContentsId, state);
  }
  return state;
};

export const scriptCdp = (
  contents: WebContents,
  method: string,
  params: Record<string, unknown>,
  sessionKey = "",
): Promise<unknown> =>
  frameCdpDeadline(method, () =>
    contents.debugger.sendCommand(method, params, sessionKey || undefined),
  );

/** 新会话启用 Debugger 域后回调（iframe 目标此时仍处于暂停等待）。 */
export const onScriptSessionEnabled = (listener: SessionListener): void => {
  sessionListeners.add(listener);
};

/** 有新脚本被解析时回调（调用方自行防抖）。 */
export const onScriptParsed = (
  listener: (webContentsId: number) => void,
): void => {
  parsedListeners.add(listener);
};

/** Debugger 域被关闭或调试器断开时回调：已下发的断点全部失效。 */
export const onScriptDebuggerReset = (
  listener: (webContentsId: number) => void,
): void => {
  resetListeners.add(listener);
};

export const enabledScriptSessions = (webContentsId: number): string[] => [
  ...(states.get(webContentsId)?.enabled ?? []),
];

export const scriptAutoResumed = (webContentsId: number): number =>
  states.get(webContentsId)?.autoResumed ?? 0;

export const findScriptById = (
  webContentsId: number,
  sessionKey: string,
  scriptId: string,
): BrowserScriptInfo | undefined =>
  states.get(webContentsId)?.byId.get(`${sessionKey}\n${scriptId}`);

const warn = (func: string, message: string, id: number, error: unknown) => {
  snowLog.warn({
    module: "browser/scripts",
    func,
    message,
    context: `webContentsId=${id}, error=${redactBrowserText(String(error))}`,
  });
};

const notifyReset = (webContentsId: number): void => {
  for (const listener of resetListeners) {
    try {
      listener(webContentsId);
    } catch {
      // 监听器失败不影响清理。
    }
  }
};

const releaseMaps = (webContentsId: number, state: ScriptTabState): void => {
  if (state.maps.size === 0) return;
  state.maps.clear();
  void nativeBridge
    ?.browserSourceMapRelease(`${webContentsId}:`)
    .catch(() => undefined);
};

const resetSessions = (webContentsId: number, state: ScriptTabState): void => {
  state.enabled.clear();
  state.enabling.clear();
  state.byUrl.clear();
  state.byId.clear();
  state.subscription = undefined;
  notifyReset(webContentsId);
};

const disableDebugger = async (
  contents: WebContents,
  state: ScriptTabState,
): Promise<void> => {
  const sessions = [...state.enabled];
  state.subscription?.();
  resetSessions(contents.id, state);
  releaseMaps(contents.id, state);
  if (contents.isDestroyed() || !contents.debugger.isAttached()) return;
  for (const sessionKey of sessions) {
    try {
      await scriptCdp(contents, "Debugger.disable", {}, sessionKey);
    } catch {
      // 会话已失效。
    }
  }
};

/** 没有使用方持有时，空闲一段时间后关闭 Debugger 域。 */
const scheduleIdleDisable = (
  webContentsId: number,
  state: ScriptTabState,
): void => {
  if (state.idleTimer) clearTimeout(state.idleTimer);
  state.idleTimer = undefined;
  if (state.holds.size > 0 || state.enabled.size === 0) return;
  state.idleTimer = setTimeout(() => {
    state.idleTimer = undefined;
    if (state.holds.size > 0) return;
    try {
      void disableDebugger(getBrowserWebContents(webContentsId), state);
    } catch {
      // 标签页已关闭。
    }
  }, IDLE_DISABLE_MS);
};

/** 使用方声明是否需要 Debugger 域常驻（如存在日志断点）。 */
export const setScriptDebuggerHold = (
  webContentsId: number,
  name: string,
  hold: boolean,
): void => {
  const state = hold ? tabState(webContentsId) : states.get(webContentsId);
  if (!state) return;
  if (hold) state.holds.add(name);
  else state.holds.delete(name);
  scheduleIdleDisable(webContentsId, state);
};

const enableSession = (
  contents: WebContents,
  state: ScriptTabState,
  sessionKey: string,
): Promise<void> => {
  if (state.enabled.has(sessionKey)) return Promise.resolve();
  let pending = state.enabling.get(sessionKey);
  if (!pending) {
    pending = (async () => {
      await scriptCdp(contents, "Debugger.enable", {}, sessionKey);
      try {
        // 页面自带的 debugger 语句不再暂停；断点条件仍会求值。
        await scriptCdp(
          contents,
          "Debugger.setSkipAllPauses",
          { skip: true },
          sessionKey,
        );
      } catch {
        // 旧内核不支持时由 Debugger.paused 兜底恢复。
      }
      state.enabled.add(sessionKey);
      for (const listener of sessionListeners) {
        try {
          await listener(contents, sessionKey);
        } catch (error) {
          warn("enableSession", "session listener failed", contents.id, error);
        }
      }
    })().finally(() => {
      state.enabling.delete(sessionKey);
    });
    state.enabling.set(sessionKey, pending);
  }
  return pending;
};

/** 启用 Debugger 域（根会话 + iframe 会话），并对之后出现的 iframe 保持生效。 */
export const ensureScriptDebugger = async (
  contents: WebContents,
): Promise<void> => {
  await ensureWebContentsDebugger(contents);
  if (contents.isDestroyed() || !contents.debugger.isAttached()) {
    throw new Error(
      contents.isDevToolsOpened()
        ? "DevTools is open for this page and owns the debugger; close DevTools and retry"
        : "Browser debugger is unavailable for this page; retry after the page finishes loading",
    );
  }
  const state = tabState(contents.id);
  await enableSession(contents, state, "");
  const manager = getFrameTargetManager(contents);
  try {
    await manager.ensure();
  } catch (error) {
    warn(
      "ensureScriptDebugger",
      "iframe target auto-attach unavailable",
      contents.id,
      error,
    );
  }
  for (const sessionId of manager.sessionIds()) {
    try {
      await enableSession(contents, state, sessionId);
    } catch (error) {
      warn(
        "ensureScriptDebugger",
        "iframe Debugger.enable failed",
        contents.id,
        error,
      );
    }
  }
  if (!state.subscription) {
    try {
      state.subscription = manager.subscribe(async (change) => {
        if (change.type === "detached") {
          dropSession(state, change.sessionId);
          return;
        }
        try {
          await enableSession(contents, state, change.session.sessionId);
        } catch {
          // 新 target 已消失。
        }
      });
    } catch (error) {
      warn(
        "ensureScriptDebugger",
        "frame subscription failed",
        contents.id,
        error,
      );
    }
  }
  scheduleIdleDisable(contents.id, state);
};

const dropSession = (state: ScriptTabState, sessionKey: string): void => {
  state.enabled.delete(sessionKey);
  const prefix = `${sessionKey}\n`;
  for (const key of [...state.byUrl.keys()]) {
    if (key.startsWith(prefix)) state.byUrl.delete(key);
  }
  for (const key of [...state.byId.keys()]) {
    if (key.startsWith(prefix)) state.byId.delete(key);
  }
};

const handleMessage = (
  webContentsId: number,
  method: string,
  params: unknown,
  sessionId: string,
): void => {
  const state = states.get(webContentsId);
  if (!state) return;
  const sessionKey = sessionId || "";
  if (method === "Debugger.scriptParsed") {
    if (!state.enabled.has(sessionKey) && !state.enabling.has(sessionKey))
      return;
    const p = (params ?? {}) as Record<string, unknown>;
    if (typeof p.scriptId !== "string" || typeof p.url !== "string") return;
    // 过滤 Node 内部模块与隔离世界（preload）脚本，它们不是页面代码。
    if (!p.url || p.url.startsWith("node:")) return;
    const aux = p.executionContextAuxData as
      { isDefault?: unknown } | undefined;
    if (aux && aux.isDefault === false) return;
    const info: BrowserScriptInfo = {
      sessionKey,
      scriptId: p.scriptId,
      url: p.url,
      ...(typeof p.sourceMapURL === "string" && p.sourceMapURL
        ? { sourceMapURL: p.sourceMapURL }
        : {}),
      ...(typeof p.hash === "string" ? { hash: p.hash } : {}),
      endLine: typeof p.endLine === "number" ? p.endLine : 0,
    };
    state.byUrl.set(`${sessionKey}\n${info.url}`, info);
    state.byId.set(`${sessionKey}\n${info.scriptId}`, info);
    if (state.byId.size > MAX_TRACKED_SCRIPT_IDS) {
      let drop = state.byId.size - MAX_TRACKED_SCRIPT_IDS + 1_000;
      for (const key of state.byId.keys()) {
        if (drop-- <= 0) break;
        state.byId.delete(key);
      }
    }
    for (const listener of parsedListeners) {
      try {
        listener(webContentsId);
      } catch {
        // 监听器失败不影响登记。
      }
    }
    return;
  }
  if (method === "Runtime.executionContextsCleared") {
    // 导航后旧脚本全部失效；source map 缓存按内容标识保留，重载时可复用。
    const enabled = state.enabled.has(sessionKey);
    dropSession(state, sessionKey);
    if (enabled) state.enabled.add(sessionKey);
    return;
  }
  if (method === "Debugger.paused") {
    if (!state.enabled.has(sessionKey)) return;
    state.autoResumed += 1;
    try {
      void getBrowserWebContents(webContentsId)
        .debugger.sendCommand("Debugger.resume", {}, sessionId || undefined)
        .catch(() => undefined);
    } catch {
      // 标签页已关闭。
    }
  }
};

export const initBrowserScripts = (bridge: NativeBridge): void => {
  nativeBridge = bridge;
  registerDebuggerMessageListener(handleMessage);
  app.on("web-contents-created", (_event, contents) => {
    if (contents.getType() !== "webview") return;
    const id = contents.id;
    contents.debugger.on("detach", () => {
      const state = states.get(id);
      if (state) resetSessions(id, state);
    });
    contents.once("destroyed", () => {
      const state = states.get(id);
      if (!state) return;
      if (state.idleTimer) clearTimeout(state.idleTimer);
      state.subscription?.();
      releaseMaps(id, state);
      states.delete(id);
    });
  });
};

// ===== source map =====

const stripQuery = (url: string): string => {
  const index = url.search(/[?#]/);
  return index < 0 ? url : url.slice(0, index);
};

const baseName = (url: string): string => {
  const clean = stripQuery(url);
  return clean.slice(clean.lastIndexOf("/") + 1);
};

/** 完整相等或按路径后缀匹配（忽略候选 URL 的查询串）。 */
const matchesPath = (candidate: string, wanted: string): boolean => {
  if (candidate === wanted) return true;
  const suffix = `/${wanted.replace(/^(\.\/|\/)+/, "")}`;
  return candidate.endsWith(suffix) || stripQuery(candidate).endsWith(suffix);
};

const resolveUrl = (value: string, base: string): string => {
  try {
    return new URL(value, base).toString();
  } catch {
    return value;
  }
};

const fetchMapText = async (
  contents: WebContents,
  url: string,
): Promise<string> => {
  if (!/^(https?|file):/i.test(url)) {
    throw new Error("unsupported source map URL scheme");
  }
  const response = await contents.session.fetch(url, {
    signal: AbortSignal.timeout(MAP_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`source map HTTP ${response.status}`);
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > MAX_MAP_BYTES) throw new Error("source map is too large");
  return response.text();
};

const mapIdentity = (script: BrowserScriptInfo): string => {
  const mapUrl = script.sourceMapURL ?? "";
  return `${script.url}\n${script.hash ?? ""}\n${mapUrl.length}:${mapUrl.slice(0, 96)}`;
};

const loadMap = (
  contents: WebContents,
  state: ScriptTabState,
  script: BrowserScriptInfo,
): Promise<LoadedSourceMap | null> => {
  const mapUrl = script.sourceMapURL;
  if (!mapUrl) return Promise.resolve(null);
  const identity = mapIdentity(script);
  let entry = state.maps.get(identity);
  if (!entry) {
    const created: MapEntry = {
      promise: (async (): Promise<LoadedSourceMap | null> => {
        const key = `${contents.id}:${++state.mapSeq};`;
        let base = script.url;
        let payload = mapUrl;
        if (!mapUrl.startsWith("data:")) {
          base = resolveUrl(mapUrl, script.url);
          payload = await fetchMapText(contents, base);
        }
        const sources = await native().browserSourceMapLoad(key, payload);
        const hasContent = await native().browserSourceMapContentFlags(key);
        return {
          key,
          sources: sources.map((source) => resolveUrl(source, base)),
          hasContent,
        };
      })()
        .catch((error) => {
          snowLog.debug({
            module: "browser/scripts",
            func: "loadMap",
            message: "source map unavailable",
            context: `webContentsId=${contents.id}, error=${redactBrowserText(String(error))}`,
          });
          return null;
        })
        .then((value) => {
          created.value = value;
          return value;
        }),
    };
    entry = created;
    state.maps.set(identity, entry);
  }
  return entry.promise;
};

type MappedScript = { script: BrowserScriptInfo; map: LoadedSourceMap };

/** 并发加载一批脚本的 source map；超过截止时间的部分放弃并标记超时。 */
const loadMaps = async (
  contents: WebContents,
  state: ScriptTabState,
  scripts: BrowserScriptInfo[],
  deadline: number,
): Promise<{ mapped: MappedScript[]; timedOut: boolean }> => {
  const mapped: MappedScript[] = [];
  let timedOut = false;
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < scripts.length) {
      const script = scripts[cursor++];
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        timedOut = true;
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const map = await Promise.race([
        loadMap(contents, state, script),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), remaining);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (map === undefined) timedOut = true;
      else if (map) mapped.push({ script, map });
    }
  };
  await Promise.all(Array.from({ length: MAP_CONCURRENCY }, () => worker()));
  return { mapped, timedOut };
};

/** 同一 URL 在多个会话出现时只保留一份（根会话优先）。 */
const uniqueScripts = (state: ScriptTabState): BrowserScriptInfo[] => {
  const byUrl = new Map<string, BrowserScriptInfo>();
  for (const script of state.byUrl.values()) {
    const existing = byUrl.get(script.url);
    if (!existing || (existing.sessionKey && !script.sessionKey)) {
      byUrl.set(script.url, script);
    }
  }
  return [...byUrl.values()];
};

/**
 * 把 url + 行列定位到脚本：优先匹配 source map 里的原始源码（行号与磁盘文件一致），
 * 否则按子串匹配浏览器实际加载的脚本。行列均为 0 起。
 */
export const lookupScriptLocation = async (
  contents: WebContents,
  wanted: { url: string; lineNumber: number; columnNumber?: number },
  hintScriptUrls: string[] = [],
): Promise<ScriptLookup> => {
  const state = tabState(contents.id);
  const scripts = uniqueScripts(state);
  const hints = new Set(hintScriptUrls);
  const substring = scripts.filter((script) => script.url.includes(wanted.url));
  const deadline = Date.now() + MAP_SCAN_DEADLINE_MS;
  // 第一轮只看路径相符的脚本（Vite 等在源码 URL 上提供转译文件）与上次的落点。
  const first = scripts.filter(
    (script) =>
      script.sourceMapURL &&
      (hints.has(script.url) || matchesPath(script.url, wanted.url)),
  );
  const collect = (mapped: MappedScript[]) =>
    mapped.flatMap(({ script, map }) =>
      map.sources
        .map((source, index) => ({ script, map, source, index }))
        .filter((item) => matchesPath(item.source, wanted.url)),
    );
  let loaded = await loadMaps(contents, state, first, deadline);
  let found = collect(loaded.mapped);
  let mapsTimedOut = loaded.timedOut;
  if (found.length === 0 && substring.length === 0) {
    const rest = scripts
      .filter((script) => script.sourceMapURL && !first.includes(script))
      .slice(0, MAX_SCANNED_SCRIPTS);
    loaded = await loadMaps(contents, state, rest, deadline);
    found = collect(loaded.mapped);
    mapsTimedOut = mapsTimedOut || loaded.timedOut;
  }
  if (found.length > 0) {
    const exact = found.filter((item) => item.source === wanted.url);
    const pool = exact.length > 0 ? exact : found;
    const sources = [...new Set(pool.map((item) => item.source))];
    if (sources.length > 1) return { kind: "ambiguous", sources };
    const targets: ScriptTarget[] = [];
    let lineNumber = wanted.lineNumber;
    let columnNumber = wanted.columnNumber ?? 0;
    for (const item of pool) {
      const location = await native().browserSourceMapResolve(
        item.map.key,
        item.index,
        wanted.lineNumber,
        wanted.columnNumber ?? null,
      );
      if (!location) continue;
      if (targets.length === 0) {
        lineNumber = location.sourceLine;
        columnNumber = location.sourceColumn;
      }
      if (
        !targets.some(
          (target) =>
            target.url === item.script.url &&
            target.lineNumber === location.generatedLine &&
            target.columnNumber === location.generatedColumn,
        )
      ) {
        targets.push({
          url: item.script.url,
          lineNumber: location.generatedLine,
          columnNumber: location.generatedColumn,
        });
      }
    }
    return {
      kind: "original",
      source: sources[0],
      lineNumber,
      columnNumber,
      targets,
    };
  }
  if (substring.length > 0) return { kind: "generated", scripts: substring };
  const name = baseName(wanted.url);
  const candidates = new Set<string>();
  for (const script of scripts) {
    if (baseName(script.url) === name) candidates.add(script.url);
  }
  for (const entry of state.maps.values()) {
    for (const source of entry.value?.sources ?? []) {
      if (baseName(source) === name) candidates.add(source);
    }
  }
  return {
    kind: "none",
    candidates: [...candidates].slice(0, 5),
    mapsTimedOut,
  };
};

// ===== 脚本列表与搜索 =====

export type BrowserScriptListItem = {
  url: string;
  kind: "script" | "source";
  /** kind=script：总行数。 */
  lines?: number;
  sourceMap?: boolean;
  frame?: boolean;
  /** kind=source：所属的生成脚本。 */
  script?: string;
};

const toFilter = (pattern?: string): ((value: string) => boolean) => {
  if (!pattern) return () => true;
  try {
    const regex = new RegExp(pattern, "i");
    return (value) => regex.test(value);
  } catch {
    const lower = pattern.toLowerCase();
    return (value) => value.toLowerCase().includes(lower);
  }
};

export const listBrowserScripts = async (
  webContentsId: number,
  options: { filter?: string; sources?: boolean; limit?: number } = {},
): Promise<{
  scripts: BrowserScriptListItem[];
  total: number;
  truncated: boolean;
  mapsTimedOut?: boolean;
}> => {
  const contents = getBrowserWebContents(webContentsId);
  await ensureScriptDebugger(contents);
  const state = tabState(webContentsId);
  const accept = toFilter(options.filter);
  const limit = Math.max(1, Math.min(200, options.limit ?? 50));
  const scripts = uniqueScripts(state);
  const items: BrowserScriptListItem[] = [];
  let mapsTimedOut = false;
  if (options.sources) {
    const loaded = await loadMaps(
      contents,
      state,
      scripts.filter((script) => script.sourceMapURL),
      Date.now() + MAP_SCAN_DEADLINE_MS,
    );
    mapsTimedOut = loaded.timedOut;
    const seen = new Set<string>();
    for (const { script, map } of loaded.mapped) {
      for (const source of map.sources) {
        if (seen.has(source) || !accept(source)) continue;
        seen.add(source);
        items.push({ url: source, kind: "source", script: script.url });
      }
    }
  }
  for (const script of scripts) {
    if (!accept(script.url)) continue;
    items.push({
      url: script.url,
      kind: "script",
      lines: script.endLine + 1,
      sourceMap: Boolean(script.sourceMapURL),
      ...(script.sessionKey ? { frame: true } : {}),
    });
  }
  return {
    scripts: items.slice(0, limit),
    total: items.length,
    truncated: items.length > limit,
    ...(mapsTimedOut ? { mapsTimedOut: true } : {}),
  };
};

export type BrowserScriptSearchMatch = {
  url: string;
  kind: "script" | "source";
  /** 1 起行列，可直接作为 logpointSet 的 lineNumber / columnNumber。 */
  lineNumber: number;
  columnNumber: number;
  snippet: string;
};

export const searchBrowserScripts = async (
  webContentsId: number,
  options: {
    query: string;
    url?: string;
    isRegex?: boolean;
    caseSensitive?: boolean;
    limit?: number;
  },
): Promise<{
  matches: BrowserScriptSearchMatch[];
  searched: number;
  truncated: boolean;
  timedOut?: boolean;
}> => {
  const query = options.query;
  if (!query) throw new Error("query is required for scriptSearch");
  const contents = getBrowserWebContents(webContentsId);
  await ensureScriptDebugger(contents);
  const state = tabState(webContentsId);
  const limit = Math.max(1, Math.min(100, options.limit ?? 20));
  const isRegex = options.isRegex === true;
  const caseSensitive = options.caseSensitive === true;
  const wantedUrl = options.url?.trim() || undefined;
  const deadline = Date.now() + SEARCH_DEADLINE_MS;
  const matches: BrowserScriptSearchMatch[] = [];
  const seenSources = new Set<string>();
  let searched = 0;
  let timedOut = false;
  // 命中 url 过滤的脚本优先，其余脚本只可能通过原始源码命中。
  const scripts = uniqueScripts(state)
    .filter(
      (script) =>
        !wantedUrl || script.url.includes(wantedUrl) || script.sourceMapURL,
    )
    .sort(
      (a, b) =>
        Number(Boolean(wantedUrl && b.url.includes(wantedUrl))) -
        Number(Boolean(wantedUrl && a.url.includes(wantedUrl))),
    )
    .slice(0, MAX_SCANNED_SCRIPTS);
  for (const script of scripts) {
    if (matches.length >= limit) break;
    if (Date.now() > deadline) {
      timedOut = true;
      break;
    }
    const remaining = limit - matches.length;
    const scriptMatches = !wantedUrl || script.url.includes(wantedUrl);
    const map = await loadMap(contents, state, script);
    if (map && map.hasContent.some(Boolean)) {
      const indexes = map.sources
        .map((source, index) => ({ source, index }))
        .filter(
          ({ source, index }) =>
            map.hasContent[index] &&
            !seenSources.has(source) &&
            (!wantedUrl || source.includes(wantedUrl)),
        );
      if (indexes.length > 0) {
        for (const { source } of indexes) seenSources.add(source);
        searched += 1;
        const found = await native().browserSourceMapSearch(
          map.key,
          query,
          isRegex,
          caseSensitive,
          remaining,
          indexes.map(({ index }) => index),
        );
        for (const item of found) {
          matches.push({
            url: map.sources[item.sourceIndex ?? 0] ?? script.url,
            kind: "source",
            lineNumber: item.line + 1,
            columnNumber: item.column + 1,
            snippet: item.snippet,
          });
        }
        continue;
      }
      // 没有指定 url 时原始源码已覆盖该脚本；指定了脚本 URL 才搜生成代码。
      if (!wantedUrl || !scriptMatches) continue;
    }
    if (!scriptMatches) continue;
    let source = "";
    try {
      const result = (await scriptCdp(
        contents,
        "Debugger.getScriptSource",
        { scriptId: script.scriptId },
        script.sessionKey,
      )) as { scriptSource?: unknown } | undefined;
      source =
        typeof result?.scriptSource === "string" ? result.scriptSource : "";
    } catch {
      continue;
    }
    if (!source) continue;
    searched += 1;
    const found = await native().browserScriptTextSearch(
      source,
      query,
      isRegex,
      caseSensitive,
      remaining,
    );
    for (const item of found) {
      matches.push({
        url: script.url,
        kind: "script",
        lineNumber: item.line + 1,
        columnNumber: item.column + 1,
        snippet: item.snippet,
      });
    }
  }
  scheduleIdleDisable(webContentsId, state);
  return {
    matches: matches.slice(0, limit),
    searched,
    truncated: matches.length >= limit,
    ...(timedOut ? { timedOut: true } : {}),
  };
};
