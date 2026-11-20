/**
 * 数据备份计划：设置键、类型与下次执行时间计算。
 *
 * 主进程的备份调度器与设置界面共用这一份定义，保证两边对设置字段、
 * 取值范围和触发时刻的理解完全一致。
 */

/** 自动备份模式：off = 关闭；interval = 每 N 小时；daily = 每天固定时刻。 */
export type BackupScheduleMode = "off" | "interval" | "daily";

/** 用户可配置的自动备份计划。 */
export type BackupScheduleSettings = {
  mode: BackupScheduleMode;
  /** interval 模式的小时数（1..720）。 */
  intervalHours: number;
  /** daily 模式的小时（0..23）。 */
  hour: number;
  /** daily 模式的分钟（0..59）。 */
  minute: number;
  /** 应用退出后仍由系统调度拉起应用执行。 */
  wakeWhenClosed: boolean;
};

/** 调度器持久化的运行状态（与用户设置分开存放，避免互相覆盖）。 */
export type BackupScheduleRuntime = {
  /** 下次自动备份时间（ISO），null 表示未安排。 */
  nextRunAt: string | null;
  /** 最近一次自动备份的错误。 */
  lastError: string | null;
};

/** 设置界面读取的完整状态。 */
export type BackupScheduleState = BackupScheduleRuntime & {
  settings: BackupScheduleSettings;
  /** 是否正在执行自动备份。 */
  running: boolean;
};

/** 备份相关系统设置键（存于应用数据库的 system_settings）。 */
export const BACKUP_SETTINGS_CODES = {
  targetKind: "backup_target_kind",
  targetKindName: "数据备份位置",
  targetDir: "backup_local_target_dir",
  targetDirName: "数据备份目录",
  keep: "backup_local_keep",
  keepName: "数据备份保留份数",
  schedule: "backup_schedule",
  scheduleName: "数据备份计划",
  scheduleRuntime: "backup_schedule_runtime",
  scheduleRuntimeName: "数据备份计划状态",
} as const;

/** 备份位置：local = 本地目录；r2 = Cloudflare R2。 */
export type BackupTargetKind = "local" | "r2";

/** 备份目标（与 Rust 侧 BackupTarget 一致）：本地目录需带 dir。 */
export type BackupTarget = {
  kind: BackupTargetKind;
  dir?: string;
};

/** 用户取消备份时 Rust 侧返回的错误原因（与 progress.rs CANCELLED_REASON 一致）。 */
export const BACKUP_CANCELLED_REASON = "Backup cancelled";

/** 错误是否来自用户取消备份（IPC 会给 message 包一层前缀，按包含判断）。 */
export const isBackupCancelledError = (error: unknown): boolean =>
  (error instanceof Error ? error.message : String(error)).includes(
    BACKUP_CANCELLED_REASON,
  );

/** Cloudflare R2 配置（读取与保存共用同一结构）。 */
export type BackupR2Config = {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** 存储桶内的路径前缀（可为空）。 */
  prefix: string;
};

/** 把任意输入收敛成合法的备份位置，默认本地目录。 */
export const normalizeBackupTargetKind = (value: unknown): BackupTargetKind =>
  value === "r2" ? "r2" : "local";

/** R2 配置是否完整（缺任一项都无法执行备份）。 */
export const isBackupR2Configured = (config: BackupR2Config | null): boolean =>
  config !== null &&
  config.accountId !== "" &&
  config.bucket !== "" &&
  config.accessKeyId !== "" &&
  config.secretAccessKey !== "";

export const DEFAULT_BACKUP_SCHEDULE: BackupScheduleSettings = {
  mode: "off",
  intervalHours: 24,
  hour: 3,
  minute: 0,
  wakeWhenClosed: false,
};

export const DEFAULT_BACKUP_SCHEDULE_RUNTIME: BackupScheduleRuntime = {
  nextRunAt: null,
  lastError: null,
};

/** 默认保留份数（与 Rust 侧 backup 服务一致）。 */
export const DEFAULT_BACKUP_KEEP = 5;
export const MIN_BACKUP_KEEP = 1;
export const MAX_BACKUP_KEEP = 50;

const MIN_INTERVAL_HOURS = 1;
/** 30 天，足够覆盖常见周期，同时避免配置出无意义的巨大间隔。 */
const MAX_INTERVAL_HOURS = 24 * 30;

const clampInt = (
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number => {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
};

const toNullableIso = (value: unknown): string | null => {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
};

/** 约束保留份数到 Rust 侧接受的区间。 */
export const normalizeBackupKeep = (value: unknown): number =>
  clampInt(value, MIN_BACKUP_KEEP, MAX_BACKUP_KEEP, DEFAULT_BACKUP_KEEP);

/** 把任意输入收敛成合法的自动备份计划。 */
export const normalizeBackupSchedule = (
  value: unknown,
): BackupScheduleSettings => {
  const record =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    mode:
      record.mode === "interval" || record.mode === "daily"
        ? record.mode
        : "off",
    intervalHours: clampInt(
      record.intervalHours,
      MIN_INTERVAL_HOURS,
      MAX_INTERVAL_HOURS,
      DEFAULT_BACKUP_SCHEDULE.intervalHours,
    ),
    hour: clampInt(record.hour, 0, 23, DEFAULT_BACKUP_SCHEDULE.hour),
    minute: clampInt(record.minute, 0, 59, DEFAULT_BACKUP_SCHEDULE.minute),
    wakeWhenClosed: record.wakeWhenClosed === true,
  };
};

/** 从数据库字符串解析计划；损坏或为空时回退默认值。 */
export const parseBackupSchedule = (
  raw: string | null | undefined,
): BackupScheduleSettings => {
  if (!raw) {
    return { ...DEFAULT_BACKUP_SCHEDULE };
  }
  try {
    return normalizeBackupSchedule(JSON.parse(raw) as unknown);
  } catch {
    return { ...DEFAULT_BACKUP_SCHEDULE };
  }
};

/** 把任意输入收敛成合法的运行状态。 */
export const normalizeBackupScheduleRuntime = (
  value: unknown,
): BackupScheduleRuntime => {
  const record =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const lastError =
    typeof record.lastError === "string" && record.lastError.trim() !== ""
      ? record.lastError.trim()
      : null;
  return {
    nextRunAt: toNullableIso(record.nextRunAt),
    lastError,
  };
};

/** 从数据库字符串解析运行状态；损坏或为空时回退默认值。 */
export const parseBackupScheduleRuntime = (
  raw: string | null | undefined,
): BackupScheduleRuntime => {
  if (!raw) {
    return { ...DEFAULT_BACKUP_SCHEDULE_RUNTIME };
  }
  try {
    return normalizeBackupScheduleRuntime(JSON.parse(raw) as unknown);
  } catch {
    return { ...DEFAULT_BACKUP_SCHEDULE_RUNTIME };
  }
};

/**
 * 计算 `fromMs` 之后的下一次自动备份时间。
 *
 * interval：从现在起顺延一个间隔；daily：今天该时刻尚未到来就取今天，
 * 否则取明天（本地时区）。
 */
export const computeNextBackupAt = (
  settings: BackupScheduleSettings,
  fromMs: number,
): string | null => {
  if (settings.mode === "off") {
    return null;
  }
  if (settings.mode === "interval") {
    return new Date(fromMs + settings.intervalHours * 3_600_000).toISOString();
  }
  const base = new Date(fromMs);
  const next = new Date(
    base.getFullYear(),
    base.getMonth(),
    base.getDate(),
    settings.hour,
    settings.minute,
    0,
    0,
  );
  if (next.getTime() <= fromMs) {
    next.setDate(next.getDate() + 1);
  }
  return next.toISOString();
};
