import { webContents, type WebContents } from "electron";
import type { NativeBridge } from "../native/types";
import { safeSend } from "./safeSend";

/** 文件变更通知通道。 */
export const FILE_CHANGED_CHANNEL = "workspace-directories:file-changed";

/** 传给 Rust 监听的防抖窗口（毫秒）。 */
const DEBOUNCE_MS = 200;

/** 每个文件一个 Rust watcher；值记录各 webContents 的订阅数（同一窗口可多处订阅）。 */
const watches = new Map<string, Map<number, number>>();
/** 每个 webContents 订阅的文件及次数，用于销毁时清理。 */
const contentsPaths = new Map<number, Map<string, number>>();
const hookedContents = new Set<number>();

const release = (
  native: NativeBridge,
  contentsId: number,
  filePath: string,
): void => {
  const subscribers = watches.get(filePath);
  if (subscribers) {
    const count = (subscribers.get(contentsId) ?? 0) - 1;
    if (count > 0) {
      subscribers.set(contentsId, count);
    } else {
      subscribers.delete(contentsId);
      if (subscribers.size === 0) {
        watches.delete(filePath);
        try {
          native.stopFileWatch(filePath);
        } catch (error) {
          console.warn("Failed to stop file watch:", error);
        }
      }
    }
  }

  const paths = contentsPaths.get(contentsId);
  if (paths) {
    const count = (paths.get(filePath) ?? 0) - 1;
    if (count > 0) {
      paths.set(filePath, count);
    } else {
      paths.delete(filePath);
      if (paths.size === 0) {
        contentsPaths.delete(contentsId);
      }
    }
  }
};

const releaseAll = (native: NativeBridge, contentsId: number): void => {
  const paths = contentsPaths.get(contentsId);
  if (!paths) {
    return;
  }
  for (const [filePath, count] of [...paths]) {
    for (let i = 0; i < count; i += 1) {
      release(native, contentsId, filePath);
    }
  }
};

/** 订阅文件变更：同一文件多处订阅共享一个 Rust 监听，变更后广播给订阅者。 */
export const startFileWatch = (
  native: NativeBridge,
  contents: WebContents,
  filePath: string,
): void => {
  const contentsId = contents.id;
  const existing = watches.get(filePath);
  if (existing) {
    existing.set(contentsId, (existing.get(contentsId) ?? 0) + 1);
  } else {
    watches.set(filePath, new Map([[contentsId, 1]]));
    try {
      native.startFileWatch(filePath, DEBOUNCE_MS, (changedPath) => {
        const subscribers = watches.get(changedPath);
        if (!subscribers) {
          return;
        }
        for (const id of subscribers.keys()) {
          const target = webContents.fromId(id);
          if (target) {
            safeSend(target, FILE_CHANGED_CHANNEL, changedPath);
          }
        }
      });
    } catch (error) {
      watches.delete(filePath);
      console.warn("Failed to start file watch:", error);
      return;
    }
  }

  let paths = contentsPaths.get(contentsId);
  if (!paths) {
    paths = new Map<string, number>();
    contentsPaths.set(contentsId, paths);
  }
  paths.set(filePath, (paths.get(filePath) ?? 0) + 1);

  if (!hookedContents.has(contentsId)) {
    hookedContents.add(contentsId);
    contents.once("destroyed", () => {
      hookedContents.delete(contentsId);
      releaseAll(native, contentsId);
    });
  }
};

/** 取消一次订阅；最后一个订阅者退出时停止 Rust 监听。 */
export const stopFileWatch = (
  native: NativeBridge,
  contents: WebContents,
  filePath: string,
): void => {
  release(native, contents.id, filePath);
};
