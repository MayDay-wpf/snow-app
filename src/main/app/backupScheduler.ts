/**
 * 自动备份调度器。
 *
 * 调度与系统唤醒注册放在 Electron 主进程：主进程定时器不受窗口失焦 /
 * 最小化 / 托盘隐藏时的渲染进程节流影响，应用被系统调度在后台拉起时也能
 * 立即补跑错过的备份。真正的备份由 Rust 侧在 blocking 线程池中执行。
 */

import { BrowserWindow } from "electron";
import type { NativeBridge } from "../native/types";
import {
  BACKUP_SETTINGS_CODES,
  DEFAULT_BACKUP_SCHEDULE,
  DEFAULT_BACKUP_SCHEDULE_RUNTIME,
  computeNextBackupAt,
  normalizeBackupKeep,
  normalizeBackupSchedule,
  parseBackupSchedule,
  parseBackupScheduleRuntime,
  type BackupScheduleRuntime,
  type BackupScheduleSettings,
  type BackupScheduleState,
} from "../../shared/backupSchedule";
import { buildScheduledWakeLaunchSpec } from "./scheduledWakeLaunch";
import { safeSend } from "../utils/safeSend";
import { snowLog } from "../../utils/snowLogger";

/** 计划检查间隔：备份精确到分钟，30 秒足够且开销很低。 */
const TICK_MS = 30_000;
/** 手动备份 / 恢复占用时，自动备份延后重试的间隔。 */
const BUSY_RETRY_MS = 5 * 60_000;
/** 与定时任务的系统唤醒注册使用不同标识，两者互不覆盖。 */
const WAKE_LABEL = "com.snow.app.backup-wake";
const SCHEDULE_CHANGED_CHANNEL = "storage:backup-schedule-changed";

let nativeRef: NativeBridge | null = null;
let settings: BackupScheduleSettings = { ...DEFAULT_BACKUP_SCHEDULE };
let runtime: BackupScheduleRuntime = { ...DEFAULT_BACKUP_SCHEDULE_RUNTIME };
let running = false;
/** 保存计划期间跳过本轮检查，避免读到写了一半的状态。 */
let applying = false;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let tickInFlight: Promise<void> | null = null;
let lastWakeAt: string | null | undefined = undefined;
let wakeQueue: Promise<void> = Promise.resolve();
let mutationQueue: Promise<unknown> = Promise.resolve();
/** 设置写入版本：启动读取期间若用户已保存新计划，不用旧快照覆盖。 */
let mutationVersion = 0;

const snapshot = (): BackupScheduleState => ({
  settings: { ...settings },
  nextRunAt: runtime.nextRunAt,
  lastError: runtime.lastError,
  running,
});

const readSetting = async (
  native: NativeBridge,
  code: string,
): Promise<string> => {
  const raw = await native.getSystemSettingValue(code);
  return raw?.trim() ?? "";
};

const persistSettings = async (native: NativeBridge): Promise<void> => {
  await native.setSystemSetting(
    BACKUP_SETTINGS_CODES.scheduleName,
    BACKUP_SETTINGS_CODES.schedule,
    JSON.stringify(settings),
  );
};

const persistRuntime = async (native: NativeBridge): Promise<void> => {
  await native.setSystemSetting(
    BACKUP_SETTINGS_CODES.scheduleRuntimeName,
    BACKUP_SETTINGS_CODES.scheduleRuntime,
    JSON.stringify(runtime),
  );
};

const broadcast = (): void => {
  const payload = snapshot();
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      safeSend(window.webContents, SCHEDULE_CHANGED_CHANNEL, payload);
    }
  }
};

/**
 * 同步系统调度注册：target 为空时清除，否则覆盖为新的拉起时间。
 * 相同时间不重复调用系统命令，避免每轮检查都 spawn 一次 schtasks。
 */
const syncWake = (
  native: NativeBridge,
  target: string | null,
): Promise<void> => {
  if (target === lastWakeAt) {
    return wakeQueue;
  }
  lastWakeAt = target;
  wakeQueue = wakeQueue.then(async () => {
    try {
      await native.syncScheduledWake({
        at: target ?? undefined,
        ...buildScheduledWakeLaunchSpec(WAKE_LABEL),
      });
    } catch (error) {
      // 失败后允许下一轮检查重试
      lastWakeAt = undefined;
      snowLog.warn({
        module: "backup/scheduler",
        func: "syncWake",
        message: "Failed to sync system wake schedule",
        context: target ?? "clear",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  return wakeQueue;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** 执行一次自动备份，并把下一次执行时间推进到当前计划之后。 */
const runBackup = async (
  native: NativeBridge,
  targetDir: string,
): Promise<void> => {
  running = true;
  broadcast();
  try {
    const progress = await native.backupTaskProgress();
    if (progress.active) {
      // 手动备份 / 恢复正在执行：让出资源，稍后重试
      runtime.nextRunAt = new Date(Date.now() + BUSY_RETRY_MS).toISOString();
      await persistRuntime(native);
      return;
    }

    const keep = normalizeBackupKeep(
      await readSetting(native, BACKUP_SETTINGS_CODES.keep),
    );
    const result = await native.backupLocalCreate(targetDir, keep);
    runtime.nextRunAt = computeNextBackupAt(settings, result.createdAtMs);
    runtime.lastError = null;
    await persistRuntime(native);
    snowLog.info({
      module: "backup/scheduler",
      func: "runBackup",
      message: "Automatic backup completed",
      context: JSON.stringify({
        uploadedBytes: result.uploadedBytes,
        uploadedChunks: result.uploadedChunks,
        fileCount: result.fileCount,
        nextRunAt: runtime.nextRunAt,
      }),
    });
  } catch (error) {
    runtime.nextRunAt = computeNextBackupAt(settings, Date.now());
    runtime.lastError = errorMessage(error);
    await persistRuntime(native).catch(() => undefined);
    snowLog.warn({
      module: "backup/scheduler",
      func: "runBackup",
      message: "Automatic backup failed",
      error: runtime.lastError,
    });
  } finally {
    running = false;
    broadcast();
    await syncWake(native, runtime.nextRunAt).catch(() => undefined);
  }
};

/** 按当前设置检查一次：清理无效计划、计算下次时间、到点则执行备份。 */
const evaluate = async (native: NativeBridge): Promise<void> => {
  if (running || applying) {
    return;
  }
  const targetDir = await readSetting(native, BACKUP_SETTINGS_CODES.targetDir);
  if (settings.mode === "off" || !targetDir) {
    if (runtime.nextRunAt !== null) {
      runtime.nextRunAt = null;
      await persistRuntime(native);
      broadcast();
    }
    await syncWake(native, null);
    return;
  }

  const now = Date.now();
  if (!runtime.nextRunAt) {
    runtime.nextRunAt = computeNextBackupAt(settings, now);
    await persistRuntime(native);
    broadcast();
  } else {
    const dueAt = Date.parse(runtime.nextRunAt);
    if (Number.isNaN(dueAt)) {
      runtime.nextRunAt = computeNextBackupAt(settings, now);
      await persistRuntime(native);
      broadcast();
    } else if (dueAt <= now) {
      await runBackup(native, targetDir);
      return;
    }
  }
  await syncWake(native, runtime.nextRunAt);
};

const evaluateIfIdle = async (): Promise<void> => {
  if (!nativeRef || tickInFlight) {
    return;
  }
  const task = evaluate(nativeRef);
  tickInFlight = task;
  try {
    await task;
  } catch (error) {
    snowLog.warn({
      module: "backup/scheduler",
      func: "evaluate",
      message: "Failed to evaluate backup schedule",
      error: errorMessage(error),
    });
  } finally {
    tickInFlight = null;
  }
};

const ensureTimer = (): void => {
  if (tickTimer) {
    return;
  }
  tickTimer = setInterval(() => void evaluateIfIdle(), TICK_MS);
  if (typeof tickTimer.unref === "function") {
    tickTimer.unref();
  }
};

const applyBackupSchedule = async (
  native: NativeBridge,
  value: unknown,
): Promise<BackupScheduleState> => {
  nativeRef = native;
  applying = true;
  try {
    mutationVersion += 1;
    const previous = settings;
    const next = normalizeBackupSchedule(value);
    settings = next;
    const targetDir = await readSetting(
      native,
      BACKUP_SETTINGS_CODES.targetDir,
    );
    // 只切换「关闭后仍执行」时保留原定时间，避免顺手把即将到来的备份推后。
    const timingChanged =
      previous.mode !== next.mode ||
      previous.intervalHours !== next.intervalHours ||
      previous.hour !== next.hour ||
      previous.minute !== next.minute;
    runtime.nextRunAt = targetDir
      ? timingChanged || !runtime.nextRunAt
        ? computeNextBackupAt(next, Date.now())
        : runtime.nextRunAt
      : null;
    runtime.lastError = null;
    await persistSettings(native);
    await persistRuntime(native);
    ensureTimer();
    await syncWake(native, runtime.nextRunAt);
    broadcast();
    return snapshot();
  } finally {
    applying = false;
  }
};

/** 启动时读取已保存的计划并立即检查是否有错过的备份。 */
export const initializeBackupScheduler = async (
  native: NativeBridge,
): Promise<void> => {
  nativeRef = native;
  const version = mutationVersion;
  try {
    const [rawSettings, rawRuntime] = await Promise.all([
      native.getSystemSettingValue(BACKUP_SETTINGS_CODES.schedule),
      native.getSystemSettingValue(BACKUP_SETTINGS_CODES.scheduleRuntime),
    ]);
    if (version === mutationVersion) {
      settings = parseBackupSchedule(rawSettings);
      runtime = parseBackupScheduleRuntime(rawRuntime);
    }
  } catch (error) {
    snowLog.warn({
      module: "backup/scheduler",
      func: "initialize",
      message: "Failed to load backup schedule settings",
      error: errorMessage(error),
    });
  }
  ensureTimer();
  // 不等待检查完成：到点补跑的备份可能持续数分钟，启动流程不应被它拖住。
  void evaluateIfIdle();
};

/** 读取当前计划状态（设置界面打开时调用）。 */
export const getBackupScheduleState = (): BackupScheduleState => snapshot();

/** 保存计划并重新安排下一次执行（写操作串行化，避免乱序覆盖）。 */
export const setBackupSchedule = (
  native: NativeBridge,
  value: unknown,
): Promise<BackupScheduleState> => {
  const task = mutationQueue.then(() => applyBackupSchedule(native, value));
  mutationQueue = task.catch(() => undefined);
  return task;
};
