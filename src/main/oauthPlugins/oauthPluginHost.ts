import { net } from "electron";
import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { snowLog } from "../../utils/snowLogger";
import { getMainLocale } from "../i18n/mainI18n";
import type { NativeBridge, PluginRecord } from "../native/types";

/**
 * OAuth 登录插件宿主。
 *
 * 插件在 plugin.json 中声明 `"oauth": { "entry": "oauth.mjs" }`，模块运行在主进程
 * （Node 全权限，仅安装可信插件）。Rust 负责会话、回调监听、落库与刷新调度，
 * 通过 setOAuthPluginHandler 注册的回调异步调用这里分发的钩子。
 */

type NativeOAuthPluginBridge = Pick<
  NativeBridge,
  | "listPlugins"
  | "setOAuthPluginHandler"
  | "setOAuthPluginProviders"
  | "upsertOAuthPluginHeaderScheme"
  | "bindOAuthPluginHeaderScheme"
  | "deleteOAuthPluginHeaderScheme"
  | "pushOAuthPluginStreamChunk"
  | "endOAuthPluginStream"
>;

type HookName =
  | "authorize"
  | "exchange"
  | "poll"
  | "refresh"
  | "models"
  | "quota"
  | "transformRequest"
  | "transformResponse"
  | "onResponseChunk"
  | "fetch";

type HookFn = (ctx: Record<string, unknown>, chunk?: unknown) => unknown;

type LoadedProvider = {
  pluginId: string;
  pluginDir: string;
  definition: Record<string, unknown>;
  spec: ProviderSpec;
};

type ProviderSpec = {
  id: string;
  pluginId: string;
  displayName: string;
  description: string;
  icon: string;
  flow: "redirect" | "manual" | "device" | "panel";
  callbackPorts: number[];
  callbackPath: string;
  redirectHost: string;
  baseUrl: string;
  requestMethod: string;
  defaultModel: string;
  maxContextTokens: number | null;
  maxTokens: number | null;
  supportsVision: boolean;
  headerSchemeName: string;
  headers: Record<string, string>;
  requestHeaders: Record<string, string>;
  refreshLeadSecs: number;
  /** 渲染层自定义登录面板入口（插件内相对路径）。 */
  panelEntry: string;
  panelTitle: string;
  hooks: {
    authorize: boolean;
    poll: boolean;
    refresh: boolean;
    models: boolean;
    quota: boolean;
    transformRequest: boolean;
    transformResponse: boolean;
    onResponseChunk: boolean;
    fetch: boolean;
  };
};

type HostMessage = {
  method: string;
  provider: string;
  ctx: unknown;
};

const MODULE_NAME = "oauthPlugins";
const BUILTIN_PROVIDER_IDS = new Set([
  "codex",
  "chatgpt",
  "anthropic",
  "antigravity",
  "xai",
]);
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const REQUEST_METHODS = new Set(["chat", "responses", "anthropic", "gemini"]);
const ICON_MIME_TYPES: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
};
const MAX_ICON_BYTES = 512 * 1024;

let nativeRef: NativeOAuthPluginBridge | null = null;
let providerIndex = new Map<string, LoadedProvider>();
let syncInFlight: Promise<void> | null = null;
const moduleCache = new Map<string, Promise<Record<string, unknown>>>();

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const text = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const positiveInt = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;

/** 本地化文本：字符串直接用，对象按当前语言 -> 语言前缀 -> default/en 选择。 */
const localized = (value: unknown): string => {
  if (typeof value === "string") return value.trim();
  if (!isPlainObject(value)) return "";
  const locale = String(getMainLocale());
  const candidates = [
    locale,
    locale.split("-")[0],
    "default",
    "en",
    ...Object.keys(value),
  ];
  for (const key of candidates) {
    const picked = text(value[key]);
    if (picked) return picked;
  }
  return "";
};

const stringMap = (value: unknown): Record<string, string> => {
  const result: Record<string, string> = {};
  if (!isPlainObject(value)) return result;
  for (const [name, item] of Object.entries(value)) {
    if (name.trim() && typeof item === "string") {
      result[name.trim()] = item;
    }
  }
  return result;
};

/** 限制在插件目录内，防止 ../ 越界。 */
const resolveInside = (root: string, relativePath: string): string | null => {
  const target = resolve(root, relativePath);
  const rel = relative(root, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return target;
};

const remoteIconCache = new Map<string, Promise<string>>();

/** 远程图标在主进程转成 data URL，避免渲染层 CSP 拦截。 */
const fetchRemoteIcon = (url: string): Promise<string> => {
  let cached = remoteIconCache.get(url);
  if (!cached) {
    cached = net
      .fetch(url, { signal: AbortSignal.timeout(8000) })
      .then(async (response) => {
        const mime = (response.headers.get("content-type") ?? "")
          .split(";")[0]
          .trim();
        if (!response.ok || !mime.startsWith("image/")) return "";
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.byteLength > MAX_ICON_BYTES) return "";
        return `data:${mime};base64,${bytes.toString("base64")}`;
      })
      .catch(() => "");
    remoteIconCache.set(url, cached);
  }
  return cached;
};

const loadIcon = async (pluginDir: string, icon: unknown): Promise<string> => {
  const value = text(icon);
  if (!value) return "";
  if (/^data:image\//i.test(value)) return value;
  if (/^https:\/\//i.test(value)) return fetchRemoteIcon(value);
  const mime = ICON_MIME_TYPES[extname(value).toLowerCase()];
  const path = resolveInside(pluginDir, value);
  if (!mime || !path) return "";
  try {
    const bytes = await readFile(path);
    if (bytes.byteLength > MAX_ICON_BYTES) return "";
    return `data:${mime};base64,${bytes.toString("base64")}`;
  } catch {
    return "";
  }
};

const readOAuthEntry = (record: PluginRecord): string => {
  try {
    const manifest = JSON.parse(record.manifestJson || "{}") as unknown;
    if (!isPlainObject(manifest) || !isPlainObject(manifest.oauth)) return "";
    return text(manifest.oauth.entry);
  } catch {
    return "";
  }
};

/** 按文件修改时间热重载；同一版本的并发导入共享一次加载。 */
const importModule = async (
  entryPath: string,
): Promise<Record<string, unknown>> => {
  const { mtimeMs } = await stat(entryPath);
  const key = `${entryPath}?v=${mtimeMs}`;
  let loaded = moduleCache.get(key);
  if (!loaded) {
    loaded = import(`${pathToFileURL(entryPath).href}?v=${mtimeMs}`).then(
      (mod) => mod as Record<string, unknown>,
    );
    moduleCache.set(key, loaded);
    loaded.catch(() => moduleCache.delete(key));
  }
  return loaded;
};

/** 支持 default { providers } / named providers / default 为单个或数组。 */
const extractDefinitions = (
  mod: Record<string, unknown>,
): Record<string, unknown>[] => {
  const root = mod.default ?? mod;
  const list = isPlainObject(root)
    ? (root.providers ?? (typeof root.id === "string" ? [root] : mod.providers))
    : root;
  const items = Array.isArray(list) ? list : [list];
  return items.filter(isPlainObject);
};

const hasHook = (
  definition: Record<string, unknown>,
  name: HookName,
): boolean => typeof definition[name] === "function";

const buildSpec = async (
  pluginId: string,
  pluginDir: string,
  definition: Record<string, unknown>,
): Promise<ProviderSpec | null> => {
  const id = text(definition.id).toLowerCase();
  if (!PROVIDER_ID_PATTERN.test(id) || BUILTIN_PROVIDER_IDS.has(id)) {
    snowLog.warn({
      module: MODULE_NAME,
      func: "buildSpec",
      message: "OAuth plugin provider id is invalid or reserved",
      context: JSON.stringify({ pluginId, id }),
    });
    return null;
  }
  const panelRaw = definition.panel;
  const panel = isPlainObject(panelRaw)
    ? panelRaw
    : typeof panelRaw === "string"
      ? { entry: panelRaw }
      : {};
  const panelEntryRaw = text(panel.entry);
  const panelEntry =
    panelEntryRaw && resolveInside(pluginDir, panelEntryRaw)
      ? panelEntryRaw
      : "";
  if (panelEntryRaw && !panelEntry) {
    snowLog.warn({
      module: MODULE_NAME,
      func: "buildSpec",
      message: "OAuth panel entry escapes the plugin directory",
      context: JSON.stringify({ pluginId, id, panelEntry: panelEntryRaw }),
    });
  }
  const panelTitle = localized(panel.title);
  if (!hasHook(definition, "authorize") && !panelEntry) {
    snowLog.warn({
      module: MODULE_NAME,
      func: "buildSpec",
      message:
        "OAuth plugin provider must implement authorize() or declare a panel",
      context: JSON.stringify({ pluginId, id }),
    });
    return null;
  }
  const flowRaw = text(definition.flow);
  const flow: ProviderSpec["flow"] =
    flowRaw === "device" || flowRaw === "manual"
      ? flowRaw
      : flowRaw === "panel" || (!flowRaw && panelEntry)
        ? "panel"
        : "redirect";
  const callback = isPlainObject(definition.callback)
    ? definition.callback
    : {};
  const api = isPlainObject(definition.api) ? definition.api : {};
  const requestMethod = text(api.requestMethod);
  const displayName = localized(definition.name) || id;
  return {
    id,
    pluginId,
    displayName,
    description: localized(definition.description),
    icon: await loadIcon(pluginDir, definition.icon),
    flow,
    callbackPorts: Array.isArray(callback.ports)
      ? callback.ports
          .map((port) => positiveInt(port))
          .filter((port): port is number => port !== null && port < 65536)
      : [],
    callbackPath: text(callback.path),
    redirectHost: text(callback.host),
    baseUrl: text(api.baseUrl),
    requestMethod: REQUEST_METHODS.has(requestMethod) ? requestMethod : "chat",
    defaultModel: text(api.defaultModel),
    maxContextTokens: positiveInt(api.maxContextTokens),
    maxTokens: positiveInt(api.maxTokens),
    supportsVision: api.supportsVision !== false,
    headerSchemeName: text(definition.headerScheme) || displayName,
    headers: stringMap(definition.headers),
    requestHeaders: stringMap(definition.requestHeaders),
    refreshLeadSecs: positiveInt(definition.refreshLeadSeconds) ?? 0,
    panelEntry,
    panelTitle,
    hooks: {
      authorize: hasHook(definition, "authorize"),
      poll: hasHook(definition, "poll"),
      refresh: hasHook(definition, "refresh"),
      models: hasHook(definition, "models"),
      quota: hasHook(definition, "quota"),
      transformRequest: hasHook(definition, "transformRequest"),
      transformResponse: hasHook(definition, "transformResponse"),
      onResponseChunk: hasHook(definition, "onResponseChunk"),
      fetch: hasHook(definition, "fetch"),
    },
  };
};

const loadPluginProviders = async (
  record: PluginRecord,
): Promise<LoadedProvider[]> => {
  const entry = readOAuthEntry(record);
  if (!entry) return [];
  const entryPath = resolveInside(record.installPath, entry);
  if (!entryPath) {
    throw new Error(`OAuth entry '${entry}' escapes the plugin directory`);
  }
  const mod = await importModule(entryPath);
  const loaded: LoadedProvider[] = [];
  for (const definition of extractDefinitions(mod)) {
    const spec = await buildSpec(
      record.pluginId,
      record.installPath,
      definition,
    );
    if (spec) {
      loaded.push({
        pluginId: record.pluginId,
        pluginDir: record.installPath,
        definition,
        spec,
      });
    }
  }
  return loaded;
};

const runSync = async (): Promise<void> => {
  const native = nativeRef;
  if (!native) return;
  const records = await native.listPlugins();
  const next = new Map<string, LoadedProvider>();
  for (const record of records) {
    if (!record.enabled) continue;
    try {
      for (const provider of await loadPluginProviders(record)) {
        if (next.has(provider.spec.id)) {
          snowLog.warn({
            module: MODULE_NAME,
            func: "syncOAuthPlugins",
            message: "Duplicate OAuth plugin provider id ignored",
            context: JSON.stringify({
              pluginId: record.pluginId,
              id: provider.spec.id,
            }),
          });
          continue;
        }
        next.set(provider.spec.id, provider);
      }
    } catch (error) {
      snowLog.error({
        module: MODULE_NAME,
        func: "syncOAuthPlugins",
        message: "Failed to load OAuth plugin",
        error: describeError(error),
        context: JSON.stringify({ pluginId: record.pluginId }),
      });
    }
  }
  providerIndex = next;
  native.setOAuthPluginProviders(
    JSON.stringify([...next.values()].map((provider) => provider.spec)),
  );
};

/** 重新扫描已启用插件并把 provider 声明推送给 Rust；并发调用合并为一次。 */
export const syncOAuthPlugins = (): Promise<void> => {
  if (!syncInFlight) {
    syncInFlight = runSync()
      .catch((error: unknown) => {
        snowLog.error({
          module: MODULE_NAME,
          func: "syncOAuthPlugins",
          message: "OAuth plugin sync failed",
          error: describeError(error),
        });
      })
      .finally(() => {
        syncInFlight = null;
      });
  }
  return syncInFlight;
};

const decodeJwt = (token: unknown): Record<string, unknown> | null => {
  const payload = typeof token === "string" ? token.split(".")[1] : "";
  if (!payload) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as unknown;
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

/** 钩子内的自定义请求头方案管理：写入 Snow App 实际发送的请求头。 */
const headerSchemeHelpers = (
  provider: LoadedProvider,
  ctx: Record<string, unknown>,
) => {
  const account = isPlainObject(ctx.account) ? ctx.account : {};
  const defaultProfile = text(account.profileName);
  const bridge = (): NativeOAuthPluginBridge => {
    if (!nativeRef) throw new Error("OAuth plugin host is not ready");
    return nativeRef;
  };
  return {
    /** 创建或更新方案；账号钩子中默认绑定当前档案。 */
    upsert: async (item: unknown): Promise<Record<string, unknown>> => {
      const payload = isPlainObject(item) ? { ...item } : {};
      if (!text(payload.profileName) && defaultProfile) {
        payload.profileName = defaultProfile;
      }
      payload.providerId = provider.spec.id;
      const raw = await bridge().upsertOAuthPluginHeaderScheme(
        JSON.stringify(payload),
      );
      return JSON.parse(raw) as Record<string, unknown>;
    },
    /** 绑定方案到档案（默认当前账号档案；schemeId 为空表示解绑）。 */
    bind: async (schemeId: unknown, profileName?: unknown) => {
      const payload = {
        schemeId: text(schemeId),
        profileName: text(profileName) || defaultProfile,
        providerId: provider.spec.id,
      };
      await bridge().bindOAuthPluginHeaderScheme(JSON.stringify(payload));
      return payload;
    },
    /** 删除方案并清空仍指向它的档案绑定。 */
    remove: async (schemeId: unknown) => {
      const id = text(schemeId);
      const removed = await bridge().deleteOAuthPluginHeaderScheme(id);
      return { schemeId: id, removed };
    },
  };
};

/** 注入给钩子的工具：fetch 走 Electron net（遵循应用代理）。 */
const withHelpers = (
  provider: LoadedProvider,
  ctx: unknown,
): Record<string, unknown> => ({
  ...(isPlainObject(ctx) ? ctx : {}),
  providerId: provider.spec.id,
  pluginId: provider.pluginId,
  pluginDir: provider.pluginDir,
  fetch: (input: string | Request, init?: RequestInit) =>
    net.fetch(input, init),
  decodeJwt,
  headerSchemes: headerSchemeHelpers(provider, isPlainObject(ctx) ? ctx : {}),
  log: (message: unknown, detail?: unknown) =>
    snowLog.info({
      module: MODULE_NAME,
      func: provider.spec.id,
      message: String(message),
      context: detail === undefined ? undefined : JSON.stringify({ detail }),
    }),
});

const toEpochSeconds = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value > 1e12 ? value / 1000 : value);
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return toEpochSeconds(numeric);
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
  }
  return 0;
};

const toEpochMs = (value: unknown): number | null => {
  const seconds = toEpochSeconds(value);
  return seconds > 0 ? seconds * 1000 : null;
};

/** 兼容 camelCase 与 OAuth 原始字段名（access_token / expires_in）。 */
const normalizeTokens = (value: unknown): Record<string, unknown> => {
  if (!isPlainObject(value)) {
    throw new Error("OAuth plugin must return a token object");
  }
  const accessToken = text(value.accessToken) || text(value.access_token);
  if (!accessToken) {
    throw new Error("OAuth plugin token object is missing accessToken");
  }
  const expiresIn = positiveInt(value.expiresIn ?? value.expires_in);
  const expiresAt = expiresIn
    ? Math.floor(Date.now() / 1000) + expiresIn
    : toEpochSeconds(value.expiresAt ?? value.expires_at);
  return {
    accessToken,
    refreshToken: text(value.refreshToken) || text(value.refresh_token),
    expiresAt,
    email: text(value.email),
    accountId: text(value.accountId),
    planType: text(value.planType),
    data: isPlainObject(value.data) ? value.data : undefined,
  };
};

const normalizeAuthorize = (value: unknown): Record<string, unknown> => {
  if (typeof value === "string") return { url: value };
  if (!isPlainObject(value)) {
    throw new Error("authorize() must return { url } or a url string");
  }
  return {
    url: text(value.url),
    redirectUri: text(value.redirectUri) || undefined,
    userCode: text(value.userCode),
    instructions: localized(value.instructions),
    interval: positiveInt(value.interval) ?? 0,
    expiresIn: positiveInt(value.expiresIn) ?? 0,
    session: value.session ?? null,
  };
};

const normalizePoll = (value: unknown): Record<string, unknown> => {
  if (value === null || value === undefined) return { pending: true };
  if (
    isPlainObject(value) &&
    (value.pending === true || value.slowDown === true)
  ) {
    return { pending: true, slowDown: value.slowDown === true };
  }
  return { tokens: normalizeTokens(value) };
};

const normalizeModels = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) =>
      typeof item === "string"
        ? item.trim()
        : isPlainObject(item)
          ? text(item.id)
          : "",
    )
    .filter(Boolean);
};

const normalizeQuota = (value: unknown): Record<string, unknown> => {
  if (!isPlainObject(value)) return { groups: [] };
  const groups = Array.isArray(value.groups) ? value.groups : [];
  return {
    plan: text(value.plan) || undefined,
    groups: groups.filter(isPlainObject).map((group, groupIndex) => ({
      id: text(group.id) || `group-${groupIndex}`,
      label: localized(group.label),
      buckets: (Array.isArray(group.buckets) ? group.buckets : [])
        .filter(isPlainObject)
        .map((bucket, index) => {
          const remaining =
            typeof bucket.remainingPercent === "number"
              ? bucket.remainingPercent
              : typeof bucket.usedPercent === "number"
                ? 100 - bucket.usedPercent
                : null;
          return {
            key: text(bucket.key) || `bucket-${index}`,
            label: localized(bucket.label),
            remainingPercent: remaining,
            resetAtMs: toEpochMs(bucket.resetAtMs ?? bucket.resetAt),
          };
        }),
    })),
  };
};

const normalizeTransform = (value: unknown): Record<string, unknown> => {
  if (!isPlainObject(value)) return {};
  const headers: Record<string, string | null> = {};
  if (isPlainObject(value.headers)) {
    for (const [name, item] of Object.entries(value.headers)) {
      if (item === null || typeof item === "string") headers[name] = item;
    }
  }
  return {
    url: text(value.url) || undefined,
    body: isPlainObject(value.body) ? value.body : undefined,
    headers,
  };
};

/** `transformResponse(ctx)` 返回 `{ body?, headers? }`；未返回的字段表示不修改。 */
const normalizeResponseBody = (value: unknown): Record<string, unknown> => {
  if (!isPlainObject(value)) return {};
  const result: Record<string, unknown> = {};
  const body = value.body;
  if (typeof body === "string") result.body = body;
  else if (isPlainObject(body) || Array.isArray(body)) result.body = body;
  const headers: Record<string, string | null> = {};
  if (isPlainObject(value.headers)) {
    for (const [name, item] of Object.entries(value.headers)) {
      if (item === null || typeof item === "string") headers[name] = item;
    }
  }
  if (Object.keys(headers).length > 0) result.headers = headers;
  return result;
};

/** 事件块：字符串原样使用，对象按 SSE 的 `data:` 行补齐。 */
const chunkBlock = (item: unknown): string =>
  typeof item === "string" ? item : `data: ${JSON.stringify(item ?? {})}`;

/** `onResponseChunk`：undefined 放行、null 丢弃、字符串/对象替换事件。 */
const normalizeResponseChunk = (value: unknown): Record<string, unknown> => {
  if (value === undefined) return { kind: "pass" };
  if (value === null) return { kind: "drop" };
  const items = Array.isArray(value) ? value : [value];
  const blocks = items
    .filter((item) => item !== undefined)
    .map(chunkBlock)
    .filter((block) => block.trim().length > 0);
  return blocks.length ? { kind: "events", blocks } : { kind: "drop" };
};

const isFetchResponse = (value: unknown): value is Response =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Response).status === "number" &&
  typeof (value as Response).text === "function" &&
  typeof (value as Response).headers === "object";

/** 事件流响应按流逐块交给 Rust；其余响应仍整段读取。 */
const isEventStream = (headers: Headers): boolean =>
  (headers.get("content-type") ?? "")
    .toLowerCase()
    .includes("text/event-stream");

/** 读一块推一块，正文因此按到达顺序进入原生解析（打字机输出保留）。 */
const pumpFetchStream = (response: Response, streamId: number): void => {
  void (async () => {
    try {
      const reader = response.body?.getReader();
      if (!reader) return;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        // 通道关闭说明对话已取消或本请求已结束：立即停止读取上游。
        if (
          !nativeRef?.pushOAuthPluginStreamChunk(streamId, Buffer.from(value))
        ) {
          await reader.cancel().catch(() => undefined);
          return;
        }
      }
    } catch (error) {
      snowLog.warn({
        module: MODULE_NAME,
        func: "fetch",
        message: "OAuth plugin fetch stream failed",
        error: describeError(error),
      });
    } finally {
      // 无论正常读完还是出错，都要让 Rust 侧流结束，避免请求悬挂。
      nativeRef?.endOAuthPluginStream(streamId);
    }
  })();
};

/** `fetch(ctx)` 可返回 Response、字符串或 `{ status, headers, body }`。 */
const normalizeFetchResult = async (
  value: unknown,
  streamId: number | null,
): Promise<Record<string, unknown>> => {
  if (isFetchResponse(value)) {
    const headers: Record<string, string> = {};
    value.headers.forEach((headerValue, name) => {
      headers[name] = headerValue;
    });
    // SSE 的 2xx 响应交给流式通道，其余（JSON、非 2xx、无正文）仍整段读取。
    if (
      streamId !== null &&
      value.ok &&
      value.body &&
      isEventStream(value.headers)
    ) {
      pumpFetchStream(value, streamId);
      return { status: value.status, headers, streaming: true };
    }
    return { status: value.status, headers, body: await value.text() };
  }
  if (typeof value === "string") {
    return { status: 200, headers: {}, body: value };
  }
  if (isPlainObject(value)) {
    const raw = value.body;
    const body =
      typeof raw === "string"
        ? raw
        : raw === undefined
          ? ""
          : JSON.stringify(raw);
    if (!body) {
      throw new Error(
        "fetch() must return a Response, a string body, or { body }",
      );
    }
    return {
      status: positiveInt(value.status) ?? 200,
      headers: stringMap(value.headers),
      body,
    };
  }
  throw new Error("fetch() must return a Response, a string body, or { body }");
};

const NORMALIZERS: Record<
  HookName,
  (value: unknown, streamId: number | null) => unknown | Promise<unknown>
> = {
  authorize: normalizeAuthorize,
  exchange: normalizeTokens,
  poll: normalizePoll,
  refresh: normalizeTokens,
  models: normalizeModels,
  quota: normalizeQuota,
  transformRequest: normalizeTransform,
  transformResponse: normalizeResponseBody,
  onResponseChunk: normalizeResponseChunk,
  fetch: normalizeFetchResult,
};

const findProvider = async (id: string): Promise<LoadedProvider | null> => {
  const existing = providerIndex.get(id);
  if (existing) return existing;
  await syncOAuthPlugins();
  return providerIndex.get(id) ?? null;
};

/**
 * 取走 Rust 为 `fetch` 钩子分配的流式通道 id（宿主内部字段，不交给插件）。
 */
const takeStreamId = (ctx: unknown): number | null => {
  if (!isPlainObject(ctx)) return null;
  const value = ctx.streamId;
  delete ctx.streamId;
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
};

const dispatch = async (message: HostMessage): Promise<unknown> => {
  const providerId = text(message.provider).toLowerCase();
  if (message.method === "describe") {
    await syncOAuthPlugins();
    return providerIndex.get(providerId)?.spec ?? null;
  }
  const method = message.method as HookName;
  const normalize = NORMALIZERS[method];
  if (!normalize) {
    throw new Error(`Unknown OAuth plugin method: ${message.method}`);
  }
  // fetch 钩子的流式通道 id 只在本函数内使用，插件看到的 ctx 与文档一致。
  const streamId = method === "fetch" ? takeStreamId(message.ctx) : null;
  const provider = await findProvider(providerId);
  if (!provider) {
    throw new Error(
      `OAuth plugin provider '${providerId}' is not installed or is disabled`,
    );
  }
  const hook = provider.definition[method];
  if (typeof hook !== "function") {
    throw new Error(
      `OAuth plugin provider '${providerId}' does not implement ${method}()`,
    );
  }
  const ctx = withHelpers(provider, message.ctx);
  const fn = hook as HookFn;
  // onResponseChunk 同时把事件块作为第二个参数传入，兼容 (ctx, chunk) 写法。
  const result =
    method === "onResponseChunk"
      ? await fn.call(
          provider.definition,
          ctx,
          isPlainObject(message.ctx) ? message.ctx.chunk : undefined,
        )
      : await fn.call(provider.definition, ctx);
  return await normalize(result, streamId);
};

/** Rust 回调入口：返回 `{ ok, result }` 或 `{ ok: false, error }` 的 JSON 字符串。 */
const handleOAuthPluginMessage = async (raw: string): Promise<string> => {
  let message: HostMessage;
  try {
    message = JSON.parse(raw) as HostMessage;
  } catch (error) {
    return JSON.stringify({ ok: false, error: describeError(error) });
  }
  try {
    const result = await dispatch(message);
    return JSON.stringify({ ok: true, result: result ?? null });
  } catch (error) {
    snowLog.warn({
      module: MODULE_NAME,
      func: message.method,
      message: "OAuth plugin hook failed",
      error: describeError(error),
      context: JSON.stringify({ provider: message.provider }),
    });
    return JSON.stringify({ ok: false, error: describeError(error) });
  }
};

/** 启动时注册 Rust 回调并做首次同步。 */
export const registerOAuthPlugins = (native: NativeOAuthPluginBridge): void => {
  nativeRef = native;
  native.setOAuthPluginHandler(handleOAuthPluginMessage);
  void syncOAuthPlugins();
};
