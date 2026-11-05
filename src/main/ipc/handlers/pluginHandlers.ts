import { BrowserWindow, dialog, ipcMain, net } from "electron";
import { extname } from "node:path";
import { refreshUserscriptSyncStore } from "../../app/userscriptSyncStore";
import { syncOAuthPlugins } from "../../oauthPlugins/oauthPluginHost";
import { syncPluginBackgrounds } from "../../pluginBackground/pluginBackgroundHost";
import type {
  NativeBridge,
  PluginRecord,
  PluginToolServerInfo,
  UserscriptRecord,
} from "../../native/types";
import { safeSend } from "../../utils/safeSend";

const PLUGIN_HTTP_DEFAULT_TIMEOUT_MS = 30000;
const PLUGIN_HTTP_MAX_TIMEOUT_MS = 120000;
const PLUGIN_HTTP_MAX_BYTES = 5 * 1024 * 1024;
const PLUGIN_HTTP_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

/** 读取社区安装结果类型（仅用于决定广播哪个变更事件，解析失败按无副作用处理）。 */
const readCommunityOutcome = (text: string): string => {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object") {
      const outcome = (parsed as { outcome?: unknown }).outcome;
      if (typeof outcome === "string") {
        return outcome;
      }
    }
  } catch {
    return "";
  }
  return "";
};

const mimeTypeFor = (relativePath: string): string =>
  MIME_TYPES[extname(relativePath).toLowerCase()] ?? "application/octet-stream";

/**
 * 应用插件 IPC 通道。
 *
 * - 安装 / 启停 / 卸载 / 文件读取全部转发到 Rust 存储层（异步，不阻塞
 *   主进程）；渲染层拿到插件目录内的源码后自行完成插件运行时装配。
 * - 目录选择与资源编码（图标等二进制转 data URL）留在主进程，渲染层
 *   无法直接访问文件系统。
 */
export const registerPluginHandlers = (native: NativeBridge): void => {
  ipcMain.handle("plugins:list", (): Promise<PluginRecord[]> =>
    native.listPlugins(),
  );

  ipcMain.handle(
    "plugins:list-tools",
    (_event, projectId: unknown): Promise<PluginToolServerInfo[]> =>
      native.listPluginTools(
        typeof projectId === "string" && projectId.trim()
          ? projectId.trim()
          : undefined,
      ),
  );

  ipcMain.handle(
    "plugins:project-scope-get",
    (_event, projectId: unknown): Promise<string> => {
      if (!isNonEmptyString(projectId)) {
        throw new Error("Project id is required");
      }
      return native.getPluginsProjectScope(projectId.trim());
    },
  );

  ipcMain.handle(
    "plugins:project-scope-set",
    async (_event, payload: unknown): Promise<void> => {
      const source = (payload ?? {}) as {
        projectId?: unknown;
        pluginId?: unknown;
        enabled?: unknown;
      };
      if (!isNonEmptyString(source.projectId)) {
        throw new Error("Project id is required");
      }
      if (!isNonEmptyString(source.pluginId)) {
        throw new Error("Plugin id is required");
      }
      if (typeof source.enabled !== "boolean") {
        throw new Error("enabled must be a boolean");
      }
      await native.setPluginsProjectPluginEnabled(
        source.projectId.trim(),
        source.pluginId.trim(),
        source.enabled,
      );
    },
  );

  ipcMain.handle("plugins:get-directory", (): Promise<string> =>
    native.getPluginsDirectory(),
  );

  ipcMain.handle(
    "plugins:pick-directory",
    async (event, dialogTitle: unknown): Promise<string | null> => {
      const browserWindow = BrowserWindow.fromWebContents(event.sender);
      const title =
        typeof dialogTitle === "string" && dialogTitle.trim()
          ? dialogTitle.trim()
          : "Select plugin directory";
      const options: Electron.OpenDialogOptions = {
        title,
        properties: ["openDirectory"],
        filters: [],
      };
      const result = browserWindow
        ? await dialog.showOpenDialog(browserWindow, options)
        : await dialog.showOpenDialog(options);
      if (result.canceled || result.filePaths.length === 0) {
        return null;
      }
      return result.filePaths[0];
    },
  );

  ipcMain.handle(
    "plugins:install",
    async (_event, sourceDir: unknown): Promise<PluginRecord> => {
      if (!isNonEmptyString(sourceDir)) {
        throw new Error("Plugin directory is required");
      }
      const record = await native.installPlugin(sourceDir.trim());
      await syncOAuthPlugins();
      void syncPluginBackgrounds();
      return record;
    },
  );

  ipcMain.handle(
    "plugins:market-registry",
    (_event, forceRefresh: unknown): Promise<string> =>
      native.fetchPluginRegistry(forceRefresh === true),
  );

  ipcMain.handle(
    "plugins:market-stats",
    (_event, targets: unknown, forceRefresh: unknown): Promise<string> => {
      if (!isNonEmptyString(targets)) {
        return Promise.resolve("{}");
      }
      return native.fetchPluginMarketStats(
        targets.trim(),
        forceRefresh === true,
      );
    },
  );

  ipcMain.handle(
    "plugins:market-install",
    async (event, payload: unknown): Promise<PluginRecord> => {
      if (payload === null || typeof payload !== "object") {
        throw new Error("Invalid plugin market install payload");
      }
      const { pluginId, downloadUrl, sha256, sourceUrl } = payload as {
        pluginId?: unknown;
        downloadUrl?: unknown;
        sha256?: unknown;
        sourceUrl?: unknown;
      };
      if (!isNonEmptyString(pluginId)) {
        throw new Error("Plugin id is required");
      }
      if (
        !isNonEmptyString(downloadUrl) ||
        !/^https:\/\//i.test(downloadUrl.trim())
      ) {
        throw new Error("Plugin download URL must use https");
      }
      if (!isNonEmptyString(sha256) || !/^[0-9a-f]{64}$/i.test(sha256.trim())) {
        throw new Error("Plugin archive SHA256 is invalid");
      }
      if (
        !isNonEmptyString(sourceUrl) ||
        !/^https:\/\//i.test(sourceUrl.trim())
      ) {
        throw new Error("Plugin source URL must use https");
      }
      const record = await native.installPluginFromMarket(
        pluginId.trim(),
        downloadUrl.trim(),
        sha256.trim().toLowerCase(),
        sourceUrl.trim(),
      );
      await syncOAuthPlugins();
      void syncPluginBackgrounds();
      safeSend(event.sender, "plugins:changed");
      return record;
    },
  );

  ipcMain.handle(
    "plugins:market-install-script",
    async (event, payload: unknown): Promise<UserscriptRecord> => {
      if (payload === null || typeof payload !== "object") {
        throw new Error("Invalid userscript market install payload");
      }
      const { scriptId, downloadUrl, sha256, sourceUrl } = payload as {
        scriptId?: unknown;
        downloadUrl?: unknown;
        sha256?: unknown;
        sourceUrl?: unknown;
      };
      if (!isNonEmptyString(scriptId)) {
        throw new Error("Userscript id is required");
      }
      if (
        !isNonEmptyString(downloadUrl) ||
        !/^https:\/\//i.test(downloadUrl.trim())
      ) {
        throw new Error("Userscript download URL must use https");
      }
      if (!isNonEmptyString(sha256) || !/^[0-9a-f]{64}$/i.test(sha256.trim())) {
        throw new Error("Userscript SHA256 is invalid");
      }
      if (
        !isNonEmptyString(sourceUrl) ||
        !/^https:\/\//i.test(sourceUrl.trim())
      ) {
        throw new Error("Userscript source URL must use https");
      }
      const record = await native.installScriptFromMarket(
        scriptId.trim(),
        downloadUrl.trim(),
        sha256.trim().toLowerCase(),
        sourceUrl.trim(),
      );
      refreshUserscriptSyncStore(native);
      safeSend(event.sender, "userscripts:changed");
      return record;
    },
  );

  ipcMain.handle(
    "plugins:community-list",
    (_event, query: unknown, forceRefresh: unknown): Promise<string> =>
      native.fetchPluginCommunity(
        typeof query === "string" ? query : "",
        forceRefresh === true,
      ),
  );

  ipcMain.handle(
    "plugins:community-resolve",
    async (event, payload: unknown): Promise<string> => {
      if (payload === null || typeof payload !== "object") {
        throw new Error("Invalid community plugin payload");
      }
      const { repo, releaseTag, token, selection } = payload as {
        repo?: unknown;
        releaseTag?: unknown;
        token?: unknown;
        selection?: unknown;
      };
      if (!isNonEmptyString(repo)) {
        throw new Error(
          "Community plugin source must be a GitHub repository URL",
        );
      }
      const normalized = repo
        .trim()
        .replace(/\.git$/i, "")
        .replace(/\/+$/, "");
      if (!/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+$/i.test(normalized)) {
        throw new Error(
          "Community plugin source must be a GitHub repository URL",
        );
      }
      const selectionPaths = Array.isArray(selection)
        ? selection.filter((item): item is string => typeof item === "string")
        : [];
      const text = await native.resolvePluginCommunitySource(
        normalized,
        isNonEmptyString(releaseTag) ? releaseTag.trim() : "",
        isNonEmptyString(token) ? token.trim() : "",
        JSON.stringify(selectionPaths),
      );
      // 按结果类型广播对应的变更事件（面板插件 → 插件列表；用户脚本 → 脚本列表）。
      const outcome = readCommunityOutcome(text);
      if (outcome === "plugin") {
        await syncOAuthPlugins();
        void syncPluginBackgrounds();
        safeSend(event.sender, "plugins:changed");
      } else if (outcome === "scripts") {
        refreshUserscriptSyncStore(native);
        safeSend(event.sender, "userscripts:changed");
      }
      return text;
    },
  );

  ipcMain.handle(
    "plugins:rescan",
    async (_event, pluginId: unknown): Promise<PluginRecord> => {
      if (!isNonEmptyString(pluginId)) {
        throw new Error("Plugin id is required");
      }
      const record = await native.rescanPlugin(pluginId.trim());
      await syncOAuthPlugins();
      void syncPluginBackgrounds();
      return record;
    },
  );

  ipcMain.handle(
    "plugins:set-enabled",
    async (_event, pluginId: unknown, enabled: unknown): Promise<void> => {
      if (!isNonEmptyString(pluginId)) {
        throw new Error("Plugin id is required");
      }
      await native.setPluginEnabled(pluginId.trim(), Boolean(enabled));
      await syncOAuthPlugins();
      void syncPluginBackgrounds();
    },
  );

  ipcMain.handle(
    "plugins:delete",
    async (_event, pluginId: unknown, deleteFiles: unknown): Promise<void> => {
      if (!isNonEmptyString(pluginId)) {
        throw new Error("Plugin id is required");
      }
      await native.deletePlugin(pluginId.trim(), Boolean(deleteFiles));
      await syncOAuthPlugins();
      void syncPluginBackgrounds();
    },
  );

  ipcMain.handle(
    "plugins:read-file",
    (_event, pluginId: unknown, relativePath: unknown): Promise<string> => {
      if (!isNonEmptyString(pluginId) || !isNonEmptyString(relativePath)) {
        throw new Error("Plugin id and file path are required");
      }
      return native.readPluginFile(pluginId.trim(), relativePath.trim());
    },
  );

  ipcMain.handle(
    "plugins:read-asset",
    async (
      _event,
      pluginId: unknown,
      relativePath: unknown,
    ): Promise<string | null> => {
      if (!isNonEmptyString(pluginId) || !isNonEmptyString(relativePath)) {
        return null;
      }
      try {
        const bytes = await native.readPluginAsset(
          pluginId.trim(),
          relativePath.trim(),
        );
        const base64 = Buffer.from(bytes).toString("base64");
        return `data:${mimeTypeFor(relativePath.trim())};base64,${base64}`;
      } catch {
        return null;
      }
    },
  );

  ipcMain.handle("plugins:get-values", (_event, pluginId: unknown) => {
    if (!isNonEmptyString(pluginId)) {
      throw new Error("Plugin id is required");
    }
    return native.getPluginValues(pluginId.trim());
  });

  ipcMain.handle(
    "plugins:set-value",
    (
      _event,
      pluginId: unknown,
      key: unknown,
      value: unknown,
    ): Promise<void> => {
      if (!isNonEmptyString(pluginId) || !isNonEmptyString(key)) {
        throw new Error("Plugin id and key are required");
      }
      return native.setPluginValue(
        pluginId.trim(),
        key.trim(),
        typeof value === "string" ? value : JSON.stringify(value ?? null),
      );
    },
  );

  ipcMain.handle(
    "plugins:delete-value",
    (_event, pluginId: unknown, key: unknown): Promise<void> => {
      if (!isNonEmptyString(pluginId) || !isNonEmptyString(key)) {
        throw new Error("Plugin id and key are required");
      }
      return native.deletePluginValue(pluginId.trim(), key.trim());
    },
  );

  ipcMain.handle(
    "plugins:http-request",
    async (
      _event,
      payload: unknown,
    ): Promise<{
      ok: boolean;
      status: number;
      statusText: string;
      headers: Record<string, string>;
      body: string;
      bodyBase64?: string;
      url: string;
      error: string | null;
    }> => {
      if (payload === null || typeof payload !== "object") {
        throw new Error("Invalid plugin http request payload");
      }
      const { url, method, headers, body, timeoutMs, responseType } =
        payload as {
          url?: unknown;
          method?: unknown;
          headers?: unknown;
          body?: unknown;
          timeoutMs?: unknown;
          responseType?: unknown;
        };
      if (!isNonEmptyString(url) || !/^https?:\/\//i.test(url)) {
        throw new Error("Plugin http request url must be http(s)");
      }
      const requestMethod = (
        isNonEmptyString(method) ? method : "GET"
      ).toUpperCase();
      if (!PLUGIN_HTTP_METHODS.has(requestMethod)) {
        throw new Error(`Unsupported http method '${requestMethod}'`);
      }
      const timeout =
        typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
          ? Math.min(
              Math.max(Math.trunc(timeoutMs), 1000),
              PLUGIN_HTTP_MAX_TIMEOUT_MS,
            )
          : PLUGIN_HTTP_DEFAULT_TIMEOUT_MS;
      try {
        const response = await net.fetch(url, {
          method: requestMethod,
          headers:
            headers !== null && typeof headers === "object"
              ? (headers as Record<string, string>)
              : undefined,
          body:
            isNonEmptyString(body) &&
            requestMethod !== "GET" &&
            requestMethod !== "HEAD"
              ? body
              : undefined,
          redirect: "follow",
          credentials: "omit",
          signal: AbortSignal.timeout(timeout),
        });
        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });
        const declaredLength = Number(
          response.headers.get("content-length") ?? 0,
        );
        if (declaredLength > PLUGIN_HTTP_MAX_BYTES) {
          return {
            ok: false,
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders,
            body: "",
            url: response.url,
            error: "Response body exceeds the 5MB limit",
          };
        }
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > PLUGIN_HTTP_MAX_BYTES) {
          return {
            ok: false,
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders,
            body: "",
            url: response.url,
            error: "Response body exceeds the 5MB limit",
          };
        }
        // responseType 为 arraybuffer 时只回传原始字节（base64），由插件自行解码
        if (responseType === "arraybuffer") {
          return {
            ok: response.ok,
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders,
            body: "",
            bodyBase64: Buffer.from(buffer).toString("base64"),
            url: response.url,
            error: null,
          };
        }
        return {
          ok: response.ok,
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
          body: new TextDecoder().decode(buffer),
          url: response.url,
          error: null,
        };
      } catch (error) {
        const message =
          error instanceof Error
            ? error.name === "TimeoutError"
              ? `Request timed out after ${timeout}ms`
              : error.message
            : String(error);
        return {
          ok: false,
          status: 0,
          statusText: "",
          headers: {},
          body: "",
          url,
          error: message,
        };
      }
    },
  );
};
