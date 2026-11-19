import { useSyncExternalStore } from "react";
import type {
  BackupCreateResult,
  BackupPendingTask,
  BackupTaskProgress,
} from "../../../preload";

/**
 * 手动备份 / 恢复 / 删除任务的模块级状态。
 *
 * 任务由设置页发起，但状态放在模块里而不是组件里：用户可以把进度弹窗切到
 * 后台、离开设置页继续使用应用，任务的 Promise 与进度轮询不会随设置页卸载
 * 而丢失；常驻的 BackupTaskHost 负责展示进度弹窗与完成提示。
 *
 * 备份与删除在 Rust 侧写有任务日志：应用中途退出后 pending 记录未完成的
 * 任务，用户可以继续或放弃。
 */

export type BackupTaskKind = "create" | "restore" | "delete";

/** 最近一次结束的任务结果（error 为 null 表示成功）。 */
export type BackupTaskOutcome = {
  kind: BackupTaskKind;
  result: BackupCreateResult | null;
  error: string | null;
};

export type BackupTaskState = {
  /** 正在执行的任务类型；null 表示空闲 */
  running: BackupTaskKind | null;
  /** Rust 侧进度快照（任务执行期间轮询） */
  progress: BackupTaskProgress | null;
  /** 进度弹窗是否展开；false 表示任务在后台执行 */
  dialogOpen: boolean;
  /** 待提示的任务结果，提示消失后清空 */
  outcome: BackupTaskOutcome | null;
  /** 已结束的任务计数，设置页据此刷新备份列表 */
  finished: number;
  /** 上次中断（应用退出或失败）、可继续的备份 / 删除任务 */
  pending: BackupPendingTask | null;
};

const POLL_INTERVAL_MS = 300;

let state: BackupTaskState = {
  running: null,
  progress: null,
  dialogOpen: false,
  outcome: null,
  finished: 0,
  pending: null,
};
const listeners = new Set<() => void>();
let pollTimer: number | null = null;

const setState = (patch: Partial<BackupTaskState>): void => {
  state = { ...state, ...patch };
  for (const listener of listeners) {
    listener();
  }
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const getSnapshot = (): BackupTaskState => state;

export const useBackupTask = (): BackupTaskState =>
  useSyncExternalStore(subscribe, getSnapshot);

const readProgress = async (): Promise<void> => {
  try {
    const snapshot = await window.snow.backupTaskProgress();
    if (state.running) {
      setState({ progress: snapshot });
    }
  } catch {
    // 进度读取失败不影响任务本身，下一次轮询继续
  }
};

const stopPolling = (): void => {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
};

const startPolling = (): void => {
  stopPolling();
  void readProgress();
  pollTimer = window.setInterval(() => void readProgress(), POLL_INTERVAL_MS);
};

const finish = (outcome: BackupTaskOutcome): void => {
  stopPolling();
  setState({
    running: null,
    progress: null,
    dialogOpen: false,
    outcome,
    finished: state.finished + 1,
  });
  // 任务失败时日志保留，成功时被清除：重新读取以显示或收起「继续」入口。
  void refreshBackupPendingTask();
};

/**
 * 重新读取上次中断的备份 / 删除任务并返回它（任务执行中的日志不算中断，
 * Rust 侧返回 null）。
 */
export const refreshBackupPendingTask =
  async (): Promise<BackupPendingTask | null> => {
    try {
      const pending = await window.snow.backupPendingTask();
      setState({ pending: state.running ? null : pending });
    } catch {
      // 读取失败时保持现状，下次刷新再试
    }
    return state.pending;
  };

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * 启动备份 / 恢复 / 删除任务并展开进度弹窗；已有任务在执行时不重复启动。
 * 任务真正的执行在 Rust blocking 线程池，这里只持有 Promise 与轮询进度。
 */
export const runBackupTask = (
  kind: BackupTaskKind,
  run: () => Promise<BackupCreateResult | void>,
): void => {
  if (state.running) {
    return;
  }
  setState({
    running: kind,
    progress: null,
    dialogOpen: true,
    outcome: null,
    pending: null,
  });
  startPolling();
  run()
    .then((result) => finish({ kind, result: result ?? null, error: null }))
    .catch((error: unknown) =>
      finish({ kind, result: null, error: errorText(error) }),
    );
};

/** 继续上次中断的任务（使用任务开始时的备份位置）。 */
export const resumeBackupPendingTask = (): void => {
  const pending = state.pending;
  if (!pending) {
    return;
  }
  runBackupTask(pending.kind === "delete" ? "delete" : "create", async () => {
    const resumed = await window.snow.backupResumeTask();
    return resumed.created ?? undefined;
  });
};

/** 放弃上次中断的任务：只清掉任务日志与本地临时文件。 */
export const discardBackupPendingTask = async (): Promise<void> => {
  if (state.running || !state.pending) {
    return;
  }
  const kind: BackupTaskKind =
    state.pending.kind === "delete" ? "delete" : "create";
  try {
    await window.snow.backupDiscardTask();
  } catch (error) {
    setState({ outcome: { kind, result: null, error: errorText(error) } });
  }
  await refreshBackupPendingTask();
};

/** 切换进度弹窗：收起即转入后台执行，任务空闲时无法展开。 */
export const setBackupTaskDialogOpen = (open: boolean): void => {
  if (open && !state.running) {
    return;
  }
  setState({ dialogOpen: open });
};

export const dismissBackupTaskOutcome = (): void => {
  setState({ outcome: null });
};

/**
 * 进度百分比；优先按字节计算，只按数量计量的任务（删除时回收数据块）按数量
 * 计算；尚未统计出总量（快照阶段等）时返回 null，按不确定进度显示。
 */
export const backupTaskPercent = (
  progress: BackupTaskProgress | null,
): number | null => {
  if (!progress || !progress.active) {
    return null;
  }
  const [done, total] =
    progress.totalBytes > 0
      ? [progress.processedBytes, progress.totalBytes]
      : [progress.processedFiles, progress.totalFiles];
  if (total <= 0) {
    return null;
  }
  return Math.min(100, Math.round((done / total) * 100));
};

/** 将字节数格式化为可读大小（B / KB / MB / GB / TB）。 */
export const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
};

/**
 * 传输速度文案；只在写入 / 读取备份目标的阶段返回（快照、扫描等阶段
 * 不产生传输，显示速度没有意义）。
 */
export const backupTaskSpeed = (
  progress: BackupTaskProgress | null,
): string | null => {
  if (
    !progress ||
    !progress.active ||
    (progress.phase !== "write" && progress.phase !== "apply")
  ) {
    return null;
  }
  return `${formatBytes(progress.bytesPerSecond)}/s`;
};
