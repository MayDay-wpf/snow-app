import { app } from "electron";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { NativeBridge } from "./types";
import { storageReady } from "../app/storageReady";

const nativeRequire = createRequire(import.meta.url);

/**
 * 不依赖 SQLite 的原生方法：纯 git / 文件系统 / 进程操作。
 *
 * 这些方法直接调用，不等待 `storageReady`。否则启动阶段所有请求（含 git
 * 状态、文件读写等与数据库无关的调用）都被同一道门拦住，在存储就绪的
 * 瞬间一起返回，看上去像是同步批量加载。
 */
const STORAGE_INDEPENDENT_METHODS = new Set<string>([
  // Request-local optimization cancellation does not touch SQLite.
  "preparePromptOptimization",
  "abortPromptOptimization",
  // 对话请求代理回调是进程级注册状态，不依赖 SQLite。
  "setRequestProxyHandler",
  // 仓库 Wiki：事件回调注册与内存态查询
  "setRepoWikiEventHandler",
  "repoWikiStop",
  "repoWikiFilePath",
  // OAuth 插件宿主回调与 provider 声明是进程内状态，不依赖 SQLite。
  "setOAuthPluginHandler",
  "setOAuthPluginProviders",
  // fetch 钩子的流式通道同样是进程内状态，必须保持同步返回布尔值。
  "pushOAuthPluginStreamChunk",
  "endOAuthPluginStream",
  // Git（本地仓库子进程操作）
  "getGitStatus",
  "getGitBranches",
  "getGitIdentity",
  "gitStageFiles",
  "gitUnstageFiles",
  "gitStageAll",
  "gitUnstageAll",
  "gitDiscardChanges",
  "gitCommit",
  "gitPush",
  "gitPull",
  "gitFetch",
  "gitCheckout",
  "gitCreateBranch",
  "gitFileDiff",
  "gitFileContent",
  "getGitLog",
  "getGitCommitFiles",
  "getCommitDiff",
  "gitCommitFileDiff",
  "discoverGitRepos",
  "startGitWatch",
  "stopGitWatch",
  // 工作区文件系统
  "readDirectoryEntries",
  "renameWorkspaceEntry",
  "deleteWorkspaceEntry",
  "deleteWorkspaceEntries",
  "copyFilesIntoDirectory",
  "readFileContent",
  "readFilePreview",
  "writeFileContent",
  "searchFiles",
  "searchFileContents",
  "sha256File",
  "getPathSize",
  "startFileWatch",
  "stopFileWatch",
  // 终端 / IDE / 进程
  "detectTerminals",
  "resolveLoginPathForTerminal",
  "listInstalledIdes",
  "openInIde",
  "writeInteractiveStdin",
  "listProcessTree",
  "killProcessTree",
  // 本机浏览器版本探测（内置浏览器 UA 对齐，只读浏览器目录文件）
  "detectLocalBrowserVersion",
  // 窗口外边框颜色（Win32 API 调用，不触碰数据库）
  "setWindowBorderColor",
  // 团队协作（仓库内 git 身份与文件，不落数据库）
  "teamGetIdentity",
  "teamResolveRepo",
  "teamConfigureIdentity",
  "teamSetAvatarColor",
  "teamSync",
  "teamList",
  "teamUpsert",
  "teamDelete",
  "teamMediaSave",
  "teamMediaRead",
  "teamFileSave",
  "teamMediaDelete",
]);

/**
 * Wraps a native binding in a Proxy that awaits `storageReady` before
 * invoking database-backed methods. This lets the window appear instantly
 * while the Rust SQLite database initialises in the background — IPC handlers
 * that call native database methods will simply pause until storage is ready,
 * without each handler needing its own guard. 与数据库无关的方法不受门控。
 */
const wrapWithStorageGate = <T extends object>(binding: T): T => {
  return new Proxy(binding, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") {
        return value;
      }
      // 存储无关的方法：直接绑定原函数，保持原有同步 / 异步返回语义。
      if (typeof prop === "string" && STORAGE_INDEPENDENT_METHODS.has(prop)) {
        return value.bind(target);
      }
      return (...args: unknown[]) =>
        storageReady.then(() => value.apply(target, args));
    },
  }) as T;
};

const SYNC_UNAVAILABLE_METHODS = new Set<string>([
  "getRemoteControlServerState",
  "getGitStatus",
  "getGitBranches",
  "getGitIdentity",
  "getGitWorktrees",
  "gitStageFiles",
  "gitDiscardChanges",
  "getGitLog",
  "getGitCommitFiles",
  "getCommitDiff",
  "gitCommitFileDiff",
  "discoverGitRepos",
  "gitStageAll",
  "gitUnstageAll",
  "gitCommit",
  "gitRemotes",
  "gitPush",
  "gitPull",
  "gitFetch",
  "gitCheckout",
  "gitCreateBranch",
  "gitFileDiff",
  "gitFileContent",
  "startGitWatch",
  "stopGitWatch",
  "startFileWatch",
  "stopFileWatch",
  "startCodebaseWatch",
  "stopCodebaseWatch",
]);

const createUnavailableBridge = (): NativeBridge => {
  const overrides: Partial<NativeBridge> = {
    engineInfo: () => "Rust native bridge is not built yet",
    sum: (a: number, b: number) => a + b,
    resolveLoginPathForTerminal: () => Promise.resolve(null),
    flushPendingFileFormats: () => Promise.resolve(),
    cancelConversationSummary: () => false,
    abortResponseStream: () => false,
    preparePromptOptimization: () => false,
    abortPromptOptimization: () => false,
    // Keep optional context exports absent so capability checks do not treat
    // synthesized rejection functions as real native support.
    getPromptContextStatus: undefined,
    grantPromptContextAccess: undefined,
    revokePromptContextAccess: undefined,
    getPromptContextSourcePreview: undefined,
    abortToolExecution: () => false,
    migrateCheckpointLayout: () => Promise.resolve(0),
    setRemoteControlRendererBridge: () => {},
    setCheckpointRemoteCallback: () => {},
    setRequestProxyHandler: () => {},
    setRepoWikiEventHandler: () => {},
    setOAuthPluginHandler: () => {},
    setOAuthPluginProviders: () => 0,
    pushOAuthPluginStreamChunk: () => false,
    endOAuthPluginStream: () => false,
  };
  return new Proxy(overrides as NativeBridge, {
    get(target, prop) {
      if (typeof prop !== "string" || prop === "then") {
        return Reflect.get(target, prop);
      }
      const value = (target as Record<string, unknown>)[prop];
      if (Object.hasOwn(target, prop)) {
        return value;
      }
      if (SYNC_UNAVAILABLE_METHODS.has(prop)) {
        return () => {
          throw new Error(`Rust native bridge is required: ${prop}`);
        };
      }
      return () =>
        Promise.reject(new Error(`Rust native bridge is required: ${prop}`));
    },
  });
};

let rawBinding: NativeBridge | null = null;

export const loadNativeBridge = (): NativeBridge => {
  try {
    const nativeEntry = join(app.getAppPath(), "native", "index.cjs");
    const binding: unknown = nativeRequire(nativeEntry);
    rawBinding = binding as NativeBridge;
    return wrapWithStorageGate(binding as NativeBridge);
  } catch (error) {
    console.warn(
      "Native Rust bridge is unavailable, using development fallback.",
      error,
    );

    return createUnavailableBridge();
  }
};

let actualNative: NativeBridge | null = null;

/**
 * Lazily loads the native binding on first access. This defers the
 * expensive require() of the ~12 MB Rust .node file until the first
 * method call, so module loading and window creation are not blocked.
 */
const ensureNativeLoaded = (): NativeBridge => {
  if (!actualNative) {
    actualNative = loadNativeBridge();
  }
  return actualNative;
};

/**
 * Lazy Proxy: defers .node file loading until first property access.
 * The inner Proxy from wrapWithStorageGate still gates on
 * storageReady for individual method calls.
 */
export const native = new Proxy({} as NativeBridge, {
  get(_target, prop) {
    const actual = ensureNativeLoaded();
    const value = (actual as Record<string | symbol, unknown>)[prop];
    return typeof value === "function" ? value.bind(actual) : value;
  },
}) as NativeBridge;

/**
 * Returns the raw (un-proxied) native binding. Used by
 * `initializeApplicationServices` to bootstrap storage without
 * deadlocking on the `storageReady` gate that the Proxy enforces.
 */
export const getRawNative = (): NativeBridge => {
  ensureNativeLoaded();
  return rawBinding ?? native;
};
