import type { CodebaseSyncStatus } from "../../hooks/useCodebaseWatcher";

/** TopBar 持有的 codebase 同步状态快照（悬浮聊天头部复用展示）。 */
export type CodebaseSyncSnapshot = {
  syncStatus: CodebaseSyncStatus;
  watchedProjectId: string | undefined;
  activeProjectId: string | undefined;
  isIndexed: boolean;
  embedError: string | null;
};

let snapshot: CodebaseSyncSnapshot | null = null;
const listeners = new Set<(next: CodebaseSyncSnapshot) => void>();

const isSame = (a: CodebaseSyncSnapshot, b: CodebaseSyncSnapshot): boolean =>
  a.syncStatus === b.syncStatus &&
  a.watchedProjectId === b.watchedProjectId &&
  a.activeProjectId === b.activeProjectId &&
  a.isIndexed === b.isIndexed &&
  a.embedError === b.embedError;

/**
 * TopBar 是唯一生产者：watcher 生命周期仍由 TopBar 独占（Rust 端
 * stop_codebase_watch 为全局停止，双 watcher 会互相干扰），悬浮头部
 * 只作为消费者订阅快照渲染指示器。
 */
export const codebaseSyncStore = {
  get(): CodebaseSyncSnapshot | null {
    return snapshot;
  },
  set(next: CodebaseSyncSnapshot): void {
    if (snapshot && isSame(snapshot, next)) {
      return;
    }
    snapshot = next;
    for (const listener of listeners) {
      listener(next);
    }
  },
  subscribe(listener: (next: CodebaseSyncSnapshot) => void): () => void {
    listeners.add(listener);
    if (snapshot) {
      listener(snapshot);
    }
    return () => {
      listeners.delete(listener);
    };
  },
};
