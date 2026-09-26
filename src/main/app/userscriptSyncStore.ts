import { ipcMain, net, type WebContents } from "electron";
import type {
  NativeBridge,
  UserscriptMatchItem,
  UserscriptRecord,
} from "../native/types";

/**
 * 用户脚本同步匹配缓存。
 *
 * document-start 语义的关键：h5player 这类脚本必须在页面首个脚本执行前
 * 注入（劫持 MediaSource / URL.createObjectURL 收集媒体流），异步 IPC
 * 往返后再注入就永远慢一步、核心功能全部失效。因此 webview preload 用
 * ipcRenderer.sendSync 同步匹配，本模块在主进程维护全量启用脚本的内存
 * 缓存（含 GM 值快照、@require/@resource 内容），sendSync handler 从缓存
 * 纯内存匹配返回（微秒级，无 IO 阻塞）。
 */

type CachedUserscript = {
  scriptId: string;
  name: string;
  version: string;
  description: string;
  runAt: UserscriptRecord["runAt"];
  noframes: boolean;
  grant: string[];
  matches: string[];
  includes: string[];
  excludes: string[];
  requires: string[];
  target: UserscriptRecord["target"];
  views: string[];
  surfaces: string[];
  scope: string;
  sandbox: boolean;
  code: string;
  raw: string;
  values: Record<string, string>;
};

const cache = new Map<string, CachedUserscript>();
let cacheReady = false;

// 并发刷新保护：只允许最新一次 loadCache 的结果写入缓存，
// 防止先发起、后完成的旧快照覆盖新快照（如连续快速切换多个开关）。
let loadGeneration = 0;

/** @require / @resource 内容缓存（异步预热，同步命中）。 */
const dependencyCache = new Map<string, string>();
const pendingDependencies = new Map<string, Promise<void>>();

const REQUIRE_TIMEOUT_MS = 15000;

/** 预热外部依赖内容（失败静默，下次导航重试）。 */
export const warmUserscriptDependency = (url: string): void => {
  if (dependencyCache.has(url) || pendingDependencies.has(url)) {
    return;
  }
  if (!/^https?:\/\//i.test(url)) {
    return;
  }
  const task = (async (): Promise<void> => {
    const response = await net.fetch(url, {
      signal: AbortSignal.timeout(REQUIRE_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(String(response.status));
    }
    dependencyCache.set(url, await response.text());
  })()
    .catch(() => {})
    .finally(() => {
      pendingDependencies.delete(url);
    });
  pendingDependencies.set(url, task);
};

const loadCache = async (native: NativeBridge): Promise<void> => {
  const generation = ++loadGeneration;
  try {
    const records = await native.listUserscripts();
    const next = new Map<string, CachedUserscript>();
    for (const record of records) {
      if (!record.enabled) {
        continue;
      }
      // 脚本原文以文件形式存放在磁盘（~/.snowapp/browser-script/），
      // 数据库只保存元数据与文件路径，故此处从文件读取完整内容。
      const raw = await native
        .readUserscriptSource(record.scriptId)
        .catch((error: unknown) => {
          console.error(
            `Failed to read userscript file for ${record.scriptId}:`,
            error,
          );
          return null;
        });
      if (raw === null) {
        continue;
      }
      const valueEntries = await native.getUserscriptValues(record.scriptId);
      const values: Record<string, string> = {};
      for (const entry of valueEntries) {
        values[entry.key] = entry.value;
      }
      next.set(record.scriptId, {
        scriptId: record.scriptId,
        name: record.name,
        version: record.version,
        description: record.description,
        runAt: record.runAt,
        noframes: record.noframes,
        grant: record.grant,
        matches: record.matches,
        includes: record.includes,
        excludes: record.excludes,
        requires: record.requires,
        target: record.target,
        views: record.views,
        surfaces: record.surfaces,
        scope: record.scope,
        sandbox: record.sandbox,
        code: extractCode(raw),
        raw,
        values,
      });
    }
    if (generation !== loadGeneration) {
      // 已有更新的刷新任务完成或发起，本快照过期，丢弃。
      return;
    }
    cache.clear();
    for (const [id, item] of next) {
      cache.set(id, item);
    }
    for (const item of cache.values()) {
      for (const url of item.requires) {
        warmUserscriptDependency(url);
      }
    }
    cacheReady = true;
    // 脚本集合变化后重算客户端匹配结果（主窗口尚未发布上下文时为空操作）。
    applyClientScripts();
  } catch {
    // 存储未就绪时保持旧缓存，等待下次刷新。
  }
};

/** 初始化缓存并注册同步匹配 IPC（幂等）。 */
export const initUserscriptSyncStore = (native: NativeBridge): void => {
  void loadCache(native);

  ipcMain.on("userscripts:match-sync", (event, url: unknown) => {
    try {
      event.returnValue = matchFromCache(typeof url === "string" ? url : "");
    } catch {
      // sendSync 无返回值会导致渲染进程永久挂起，必须兜底。
      event.returnValue = [];
    }
  });
};

/** CRUD / 启用开关变化后全量刷新缓存（fire-and-forget）。 */
export const refreshUserscriptSyncStore = (native: NativeBridge): void => {
  void loadCache(native);
};

/** GM 值变化时同步更新缓存（保持下次导航快照一致）。 */
export const updateCachedValue = (
  scriptId: string,
  key: string,
  value: string | undefined,
): void => {
  const item = cache.get(scriptId);
  if (!item) {
    return;
  }
  if (value === undefined) {
    delete item.values[key];
  } else {
    item.values[key] = value;
  }
};

// ===== URL 匹配（与 native/src/storage/userscripts.rs 语义一致）=====

/** 从原始内容中提取纯代码（去除 `// ==/UserScript==` 元数据头）。 */
const extractCode = (raw: string): string => {
  const marker = "// ==/UserScript==";
  const end = raw.indexOf(marker);
  if (end < 0) {
    return raw;
  }
  return raw.slice(end + marker.length).replace(/^\s+/, "");
};

const escapeRegex = (text: string): string =>
  text.replace(/[.+^${}()|[\]\\?]/g, "\\$&");

const patternToRegex = (pattern: string): RegExp | null => {
  const schemeEnd = pattern.indexOf("://");
  let regex = "^";
  let rest: string;
  if (schemeEnd >= 0) {
    const scheme = pattern.slice(0, schemeEnd);
    rest = pattern.slice(schemeEnd + 3);
    regex += scheme === "*" ? "[a-z][a-z0-9+.-]*" : escapeRegex(scheme);
    regex += "://";
  } else {
    return new RegExp(`^${escapeRegex(pattern)}$`);
  }

  const slashPos = rest.indexOf("/");
  const host = slashPos >= 0 ? rest.slice(0, slashPos) : rest;
  let path = slashPos >= 0 ? rest.slice(slashPos) : "/";
  if (host === "*") {
    regex += "[^/]+";
  } else if (host.startsWith("*.")) {
    regex += `(?:.*\\.)?${escapeRegex(host.slice(2))}`;
  } else if (host.startsWith("*")) {
    regex += `.*${escapeRegex(host.slice(1))}`;
  } else {
    regex += escapeRegex(host);
  }

  if (path === "") {
    path = "/";
  }
  if (path === "/*") {
    regex += "/.*";
  } else {
    regex += escapeRegex(path).replace(/\*/g, ".*");
  }
  regex += "$";
  return new RegExp(regex);
};

const matchesAnyPattern = (url: string, patterns: string[]): boolean => {
  for (const pattern of patterns) {
    const re = patternToRegex(pattern);
    if (re?.test(url)) {
      return true;
    }
  }
  return false;
};

const scriptMatchesUrl = (
  url: string,
  metaMatches: string[],
  metaIncludes: string[],
  metaExcludes: string[],
): boolean => {
  if (matchesAnyPattern(url, metaExcludes)) {
    return false;
  }
  if (metaMatches.length === 0 && metaIncludes.length === 0) {
    return true;
  }
  return (
    matchesAnyPattern(url, metaMatches) || matchesAnyPattern(url, metaIncludes)
  );
};

/** 从缓存同步匹配（sendSync handler 调用，无 IO）。 */
const matchFromCache = (url: string): UserscriptMatchItem[] => {
  if (!url || !cacheReady) {
    return [];
  }
  const results: UserscriptMatchItem[] = [];
  for (const item of cache.values()) {
    // 客户端 UI 脚本只注入桌面窗口，不参与内置浏览器的 URL 匹配。
    if (item.target === "client") {
      continue;
    }
    if (!scriptMatchesUrl(url, item.matches, item.includes, item.excludes)) {
      continue;
    }
    // @require 内容命中缓存则内联；未命中异步预热（下次导航生效）。
    let code = item.code;
    const inlineParts: string[] = [];
    for (const requireUrl of item.requires) {
      const cached = dependencyCache.get(requireUrl);
      if (cached !== undefined) {
        inlineParts.push(cached);
      } else {
        warmUserscriptDependency(requireUrl);
        inlineParts.push(
          `/* Snow Userscript: @require not cached yet ${requireUrl} */`,
        );
      }
    }
    if (inlineParts.length > 0) {
      code = `${inlineParts.join("\n;\n")}\n;\n${code}`;
    }
    const resources: Record<string, string> = {};
    for (const match of item.raw.matchAll(
      /\/\/\s*@resource\s+(\S+)\s+(\S+)/g,
    )) {
      const cached = dependencyCache.get(match[2]);
      if (cached !== undefined) {
        resources[match[1]] = cached;
      } else {
        warmUserscriptDependency(match[2]);
      }
    }
    results.push({
      scriptId: item.scriptId,
      name: item.name,
      version: item.version,
      description: item.description,
      runAt: item.runAt,
      noframes: item.noframes,
      grant: item.grant,
      requires: item.requires,
      gmValues: { ...item.values },
      resources,
      code,
      raw: item.raw,
    });
  }
  return results;
};

// ===== 客户端 UI 脚本（主窗口注入）=====

/** 渲染层发布的客户端上下文（视图 / 区域 / 主题 / 项目 / 会话）。 */
export type ClientScriptContext = {
  view: string;
  surfaces: string[];
  tabs: string[];
  theme: string;
  locale: string;
  projectId: string | null;
  appReady: boolean;
  /** 当前会话 id（null = 新会话 / 无活动会话）。 */
  conversationId: string | null;
  /** 当前会话是否正在流式输出。 */
  isStreaming: boolean;
};

/** 主窗口 preload 注入脚本所需的载荷。 */
export type ClientScriptPayload = {
  scriptId: string;
  name: string;
  version: string;
  description: string;
  runAt: string;
  /** true = 隔离世界沙箱档；false = 主世界完全权限档。 */
  sandbox: boolean;
  /** `global` = 常驻脚本（应用启动执行，不随视图卸载）。 */
  scope: string;
  views: string[];
  surfaces: string[];
  code: string;
  raw: string;
  gmValues: Record<string, string>;
};

/** 承载客户端脚本的桌面窗口（渲染层发布上下文时登记）。 */
let clientContents: WebContents | null = null;
let clientContext: ClientScriptContext | null = null;

/** 上下文匹配：global 常驻；否则视图与区域白名单需命中（空 = 不限）。 */
const matchesClientContext = (
  item: CachedUserscript,
  context: ClientScriptContext,
): boolean => {
  if (item.target !== "client" && item.target !== "all") {
    return false;
  }
  if (item.scope === "global") {
    return true;
  }
  const views = item.views.filter((view) => view.length > 0);
  if (views.length > 0 && !views.includes(context.view)) {
    return false;
  }
  const surfaces = item.surfaces.filter((surface) => surface.length > 0);
  if (
    surfaces.length > 0 &&
    !surfaces.some((surface) => context.surfaces.includes(surface))
  ) {
    return false;
  }
  return true;
};

/** 当前上下文命中的客户端脚本载荷（含 GM 值快照）。 */
export const collectClientScripts = (): ClientScriptPayload[] => {
  if (!clientContext) {
    return [];
  }
  const payloads: ClientScriptPayload[] = [];
  for (const item of cache.values()) {
    if (!matchesClientContext(item, clientContext)) {
      continue;
    }
    payloads.push({
      scriptId: item.scriptId,
      name: item.name,
      version: item.version,
      description: item.description,
      runAt: item.runAt,
      sandbox: item.sandbox,
      scope: item.scope,
      views: item.views,
      surfaces: item.surfaces,
      code: item.code,
      raw: item.raw,
      gmValues: { ...item.values },
    });
  }
  return payloads;
};

/** 把匹配结果推给主窗口 preload（preload 自行做注入/清理差量）。 */
export const applyClientScripts = (): void => {
  const contents = clientContents;
  if (!contents || contents.isDestroyed() || !clientContext) {
    return;
  }
  contents.send("client-scripts:apply", {
    context: clientContext,
    scripts: collectClientScripts(),
  });
};

/** 渲染层发布上下文：登记承载窗口并立即应用一次匹配结果。 */
export const setClientScriptContext = (
  contents: WebContents,
  context: ClientScriptContext,
): void => {
  clientContents = contents;
  clientContext = context;
  applyClientScripts();
};
