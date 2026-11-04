import { BrowserWindow } from "electron";
import { watch, type FSWatcher } from "node:fs";
import { safeSend } from "./safeSend";

/** 目录变更广播载荷：`paths` 为相对 `dirPath` 的变更路径（空数组表示未知）。 */
export type DirectoryChangePayload = {
  dirPath: string;
  paths: string[];
};

type WatchEntry = {
  watcher: FSWatcher;
  timer: ReturnType<typeof setTimeout> | null;
  /** 去抖窗口内累积的变更相对路径；空字符串表示平台未提供文件名。 */
  paths: Set<string>;
};

const watchers = new Map<string, WatchEntry>();

const DEBOUNCE_MS = 300;

/**
 * 单次广播的变更路径上限。超过时退化为「整目录刷新」，避免一次构建产生
 * 数万条路径把 IPC 撑爆。
 */
const MAX_REPORTED_PATHS = 64;

/**
 * 递归监听下无需触发资源管理器刷新的目录。它们通常包含海量文件（构建产物、
 * 依赖、Git 对象），刷新价值极低但事件量极大。
 */
const IGNORED_DIRECTORY_NAMES = new Set([
  "node_modules",
  ".git",
  "dist",
  "out",
  "target",
  ".snow",
  ".snowapp",
  ".next",
  ".turbo",
  ".cache",
]);

const shouldIgnoreRelativePath = (relativePath: string): boolean => {
  const segments = relativePath.split(/[\\/]/);
  return segments.some((segment) => IGNORED_DIRECTORY_NAMES.has(segment));
};

const flushChange = (dirPath: string): void => {
  const entry = watchers.get(dirPath);
  if (!entry) {
    return;
  }

  entry.timer = null;
  const collected = Array.from(entry.paths);
  entry.paths.clear();
  if (collected.length === 0) {
    return;
  }

  const payload: DirectoryChangePayload = {
    dirPath,
    // 超出上限或平台未提供文件名时传空数组，让渲染层回退到整目录刷新。
    paths:
      collected.length > MAX_REPORTED_PATHS ||
      collected.some((path) => path.length === 0)
        ? []
        : collected,
  };

  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && window.webContents) {
      safeSend(window.webContents, "workspace-directories:changed", payload);
    }
  }
};

const scheduleChange = (dirPath: string, filename: string | null): void => {
  const entry = watchers.get(dirPath);
  if (!entry) {
    return;
  }

  entry.paths.add(filename ?? "");
  if (entry.timer) {
    clearTimeout(entry.timer);
  }

  entry.timer = setTimeout(() => flushChange(dirPath), DEBOUNCE_MS);
};

export const startDirectoryWatch = (dirPath: string): void => {
  if (watchers.has(dirPath)) {
    return;
  }

  try {
    const watcher = watch(
      dirPath,
      { recursive: true },
      (_eventType, filename) => {
        const relativePath = filename ? filename.toString() : "";
        if (relativePath && shouldIgnoreRelativePath(relativePath)) {
          return;
        }
        scheduleChange(dirPath, relativePath || null);
      },
    );

    watcher.on("error", () => {
      stopDirectoryWatch(dirPath);
    });

    watchers.set(dirPath, { watcher, timer: null, paths: new Set() });
  } catch {
    // Directory may not exist or watch not supported
  }
};

export const stopDirectoryWatch = (dirPath: string): void => {
  const entry = watchers.get(dirPath);
  if (!entry) {
    return;
  }

  if (entry.timer) {
    clearTimeout(entry.timer);
  }

  entry.watcher.close();
  watchers.delete(dirPath);
};

export const stopAllDirectoryWatches = (): void => {
  for (const dirPath of watchers.keys()) {
    stopDirectoryWatch(dirPath);
  }
};
