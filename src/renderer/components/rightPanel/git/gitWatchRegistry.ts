/**
 * Git 仓库文件监视的引用计数：Rust 端每个仓库只保留一个 watcher，
 * 多个组件（右面板 GitControl、顶栏分支选择器）可能同时监视同一仓库，
 * 如果各自 start/stop，先卸载的一方会误停仍在使用的 watcher。
 */

const watchRefCounts = new Map<string, number>();

export const acquireGitWatch = (repoPath: string): void => {
  const count = watchRefCounts.get(repoPath) ?? 0;
  watchRefCounts.set(repoPath, count + 1);
  if (count === 0) {
    void window.snow.startGitWatch(repoPath).catch(() => {
      // 监视启动失败时静默降级：状态仍可通过显式刷新获取。
    });
  }
};

export const releaseGitWatch = (repoPath: string): void => {
  const count = watchRefCounts.get(repoPath) ?? 0;
  if (count > 1) {
    watchRefCounts.set(repoPath, count - 1);
    return;
  }
  watchRefCounts.delete(repoPath);
  if (count === 1) {
    void window.snow.stopGitWatch(repoPath).catch(() => {
      // 停止失败时静默忽略。
    });
  }
};
