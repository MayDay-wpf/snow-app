import {
  CalendarClock,
  Clock,
  DatabaseBackup,
  FolderCog,
  LoaderCircle,
  Power,
  RefreshCw,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  BackupScheduleSettings,
  BackupScheduleState,
  BackupSummary,
  BackupTaskProgress,
} from "../../../preload";
import {
  BACKUP_SETTINGS_CODES,
  DEFAULT_BACKUP_KEEP,
  DEFAULT_BACKUP_SCHEDULE,
  normalizeBackupKeep,
  normalizeBackupSchedule,
} from "../../../shared/backupSchedule";
import { useI18n } from "../../i18n";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { CustomSelect } from "../common/CustomSelect";

const KEEP_OPTIONS = [3, 5, 10, 20];
const HOUR_OPTIONS = Array.from({ length: 24 }, (_, hour) => ({
  value: String(hour),
  label: String(hour).padStart(2, "0"),
}));
const MINUTE_OPTIONS = Array.from({ length: 60 }, (_, minute) => ({
  value: String(minute),
  label: String(minute).padStart(2, "0"),
}));

type BusyKind = "plan" | "create" | "restore" | "delete" | null;

/** 将字节数格式化为可读大小（B / KB / MB / GB / TB）。 */
const formatBytes = (bytes: number): string => {
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

const formatTime = (timestampMs: number): string =>
  new Date(timestampMs).toLocaleString();

const readErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * 数据备份设置区块（通用设置 → 存储与资源）。
 *
 * 目标目录、保留份数与自动备份计划保存在系统设置里；备份本身由 Rust 侧
 * 执行：SQLite 走 Online Backup API，资源文件按 8MB 内容寻址分块去重。
 * 自动备份的计时与系统唤醒注册在主进程，关闭应用后也能按计划执行。
 */
export function BackupSettingsSection(): React.JSX.Element {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [targetDir, setTargetDir] = useState("");
  const [keep, setKeep] = useState(DEFAULT_BACKUP_KEEP);
  const [scheduleState, setScheduleState] =
    useState<BackupScheduleState | null>(null);
  const [scheduleSaving, setScheduleSaving] = useState(false);
  const [backups, setBackups] = useState<BackupSummary[]>([]);
  const [busy, setBusy] = useState<BusyKind>(null);
  /** 备份 / 恢复任务的实时进度（busy 为 create / restore 时轮询） */
  const [progress, setProgress] = useState<BackupTaskProgress | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [pendingRestore, setPendingRestore] = useState<BackupSummary | null>(
    null,
  );
  const [pendingDelete, setPendingDelete] = useState<BackupSummary | null>(
    null,
  );
  /** 事件回调里读取最新目录，避免订阅随目录变化重建。 */
  const targetDirRef = useRef("");

  useEffect(() => {
    targetDirRef.current = targetDir;
  }, [targetDir]);

  const schedule = scheduleState?.settings ?? DEFAULT_BACKUP_SCHEDULE;

  const refreshList = useCallback(async (directory: string) => {
    if (!directory) {
      setBackups([]);
      return;
    }
    try {
      const list = await window.snow.backupLocalList(directory);
      setBackups(list);
    } catch (listError) {
      setBackups([]);
      setError(readErrorMessage(listError));
    }
  }, []);

  // 读取已保存的目录、保留份数与自动备份计划。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [savedDir, savedKeep, savedSchedule] = await Promise.all([
          window.snow.getSystemSettingValue(BACKUP_SETTINGS_CODES.targetDir),
          window.snow.getSystemSettingValue(BACKUP_SETTINGS_CODES.keep),
          window.snow.getBackupSchedule().catch(() => null),
        ]);
        if (cancelled) {
          return;
        }
        const directory = savedDir?.trim() ?? "";
        const parsedKeep = savedKeep ? Number.parseInt(savedKeep, 10) : NaN;
        setTargetDir(directory);
        setKeep(normalizeBackupKeep(parsedKeep));
        if (savedSchedule) {
          setScheduleState(savedSchedule);
        }
      } finally {
        if (!cancelled) {
          setLoaded(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 主进程执行自动备份后会推送状态；结束时顺带刷新已有备份列表。
  useEffect(() => {
    const unsubscribe = window.snow.onBackupScheduleChanged((next) => {
      setScheduleState(next);
      if (!next.running && targetDirRef.current) {
        void refreshList(targetDirRef.current);
      }
    });
    return unsubscribe;
  }, [refreshList]);

  useEffect(() => {
    if (!loaded || !targetDir) {
      return;
    }
    void refreshList(targetDir);
  }, [loaded, targetDir, refreshList]);

  // 备份 / 恢复期间按固定间隔读取 Rust 侧进度快照，用于绘制进度条。
  useEffect(() => {
    if (busy !== "create" && busy !== "restore") {
      setProgress(null);
      return;
    }
    let cancelled = false;
    const readProgress = async (): Promise<void> => {
      try {
        const snapshot = await window.snow.backupTaskProgress();
        if (!cancelled) {
          setProgress(snapshot);
        }
      } catch {
        // 进度读取失败不影响任务本身，下一次轮询继续
      }
    };
    void readProgress();
    const timer = window.setInterval(() => void readProgress(), 300);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [busy]);

  const handleSelectDirectory = async (): Promise<void> => {
    const selected = await window.snow.selectStorageDirectory(
      t("settings.backupSelectDir", { defaultValue: "Choose folder" }),
    );
    if (!selected) {
      return;
    }
    setTargetDir(selected);
    setError("");
    setNotice("");
    await window.snow.setSystemSetting(
      BACKUP_SETTINGS_CODES.targetDirName,
      BACKUP_SETTINGS_CODES.targetDir,
      selected,
    );
    // 计划已开启时立即按新目录安排下一次备份，无需等待下一轮检查。
    if (schedule.mode !== "off") {
      const next = await window.snow.setBackupSchedule(schedule);
      setScheduleState(next);
    }
  };

  const handleOpenDirectory = async (): Promise<void> => {
    if (!targetDir) {
      return;
    }
    try {
      const root = await window.snow.backupLocalRoot(targetDir);
      const openError = await window.snow.openStorageDirectory(root);
      if (openError) {
        setError(openError);
      }
    } catch (openFailure) {
      setError(
        t("settings.backupFailed", {
          values: { error: readErrorMessage(openFailure) },
          defaultValue: "Operation failed: {{error}}",
        }),
      );
    }
  };

  const handleKeepChange = async (value: string): Promise<void> => {
    const nextKeep = normalizeBackupKeep(Number.parseInt(value, 10));
    setKeep(nextKeep);
    await window.snow.setSystemSetting(
      BACKUP_SETTINGS_CODES.keepName,
      BACKUP_SETTINGS_CODES.keep,
      String(nextKeep),
    );
  };

  const applySchedule = async (next: BackupScheduleSettings): Promise<void> => {
    if (scheduleSaving) {
      return;
    }
    setScheduleSaving(true);
    setError("");
    try {
      const state = await window.snow.setBackupSchedule(
        normalizeBackupSchedule(next),
      );
      setScheduleState(state);
    } catch (scheduleError) {
      setError(
        t("settings.backupFailed", {
          values: { error: readErrorMessage(scheduleError) },
          defaultValue: "Operation failed: {{error}}",
        }),
      );
    } finally {
      setScheduleSaving(false);
    }
  };

  const handleScheduleModeChange = (value: string): void => {
    if (value === "off" || value === "daily") {
      void applySchedule({ ...schedule, mode: value });
      return;
    }
    const hours = Number.parseInt(value, 10);
    if (Number.isFinite(hours)) {
      void applySchedule({
        ...schedule,
        mode: "interval",
        intervalHours: hours,
      });
    }
  };

  const scheduleModeValue =
    schedule.mode === "daily"
      ? "daily"
      : schedule.mode === "interval"
        ? String(schedule.intervalHours)
        : "off";
  const scheduleEnabled = schedule.mode !== "off" && targetDir !== "";
  const scheduleStatus = ((): string => {
    if (!targetDir) {
      return t("settings.backupScheduleNeedDir", {
        defaultValue: "Choose a backup folder to enable automatic backups.",
      });
    }
    if (schedule.mode === "off") {
      return t("settings.backupScheduleOffInfo", {
        defaultValue:
          "Automatic backups are off; use Back up now for manual backups.",
      });
    }
    if (scheduleState?.running) {
      return t("settings.backupScheduleRunning", {
        defaultValue: "Automatic backup in progress...",
      });
    }
    if (scheduleState?.lastError) {
      return t("settings.backupScheduleLastError", {
        values: { error: scheduleState.lastError },
        defaultValue: "Last automatic backup failed: {{error}}",
      });
    }
    if (scheduleState?.nextRunAt) {
      return t("settings.backupScheduleNext", {
        values: { time: formatTime(Date.parse(scheduleState.nextRunAt)) },
        defaultValue: "Next automatic backup: {{time}}",
      });
    }
    return t("settings.backupScheduleOffInfo", {
      defaultValue:
        "Automatic backups are off; use Back up now for manual backups.",
    });
  })();

  const handlePlan = async (): Promise<void> => {
    if (!targetDir || busy) {
      return;
    }
    setBusy("plan");
    setError("");
    setNotice("");
    try {
      const plan = await window.snow.backupLocalPlan(targetDir);
      setNotice(
        t("settings.backupPlanResult", {
          values: {
            size: formatBytes(plan.pendingBytes),
            chunks: plan.pendingChunks,
            reused: plan.reusedChunks,
          },
          defaultValue:
            "About {{size}} to upload ({{chunks}} new chunks, {{reused}} reused).",
        }),
      );
    } catch (planError) {
      setError(
        t("settings.backupFailed", {
          values: { error: readErrorMessage(planError) },
          defaultValue: "Operation failed: {{error}}",
        }),
      );
    } finally {
      setBusy(null);
    }
  };

  const handleCreate = async (): Promise<void> => {
    if (!targetDir || busy) {
      return;
    }
    setBusy("create");
    setError("");
    setNotice("");
    try {
      const result = await window.snow.backupLocalCreate(targetDir, keep);
      setNotice(
        t("settings.backupCreated", {
          values: {
            size: formatBytes(result.uploadedBytes),
            files: result.fileCount,
          },
          defaultValue: "Backup finished: {{size}} written, {{files}} files.",
        }),
      );
      await refreshList(targetDir);
    } catch (createError) {
      setError(
        t("settings.backupFailed", {
          values: { error: readErrorMessage(createError) },
          defaultValue: "Operation failed: {{error}}",
        }),
      );
    } finally {
      setBusy(null);
    }
  };

  const handleRestore = async (): Promise<void> => {
    const target = pendingRestore;
    if (!targetDir || !target || busy) {
      return;
    }
    setPendingRestore(null);
    setBusy("restore");
    setError("");
    setNotice("");
    try {
      await window.snow.backupLocalRestore(targetDir, target.id);
      setNotice(
        t("settings.backupRestored", {
          defaultValue: "Restore is ready. Restart Snow App to apply it.",
        }),
      );
      await refreshList(targetDir);
    } catch (restoreError) {
      setError(
        t("settings.backupFailed", {
          values: { error: readErrorMessage(restoreError) },
          defaultValue: "Operation failed: {{error}}",
        }),
      );
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async (): Promise<void> => {
    const target = pendingDelete;
    if (!targetDir || !target || busy) {
      return;
    }
    setBusy("delete");
    setError("");
    setNotice("");
    try {
      await window.snow.backupLocalDelete(targetDir, target.id);
      setPendingDelete(null);
      await refreshList(targetDir);
    } catch (deleteError) {
      setError(
        t("settings.backupFailed", {
          values: { error: readErrorMessage(deleteError) },
          defaultValue: "Operation failed: {{error}}",
        }),
      );
    } finally {
      setBusy(null);
    }
  };

  // 自动备份执行期间同样禁用手动备份 / 恢复 / 删除，避免两个任务争用备份数据。
  const isBusy = busy !== null || scheduleState?.running === true;
  const progressActive = busy === "create" || busy === "restore";
  const progressTotalBytes = progress?.totalBytes ?? 0;
  const progressPercent =
    progress && progressTotalBytes > 0
      ? Math.min(
          100,
          Math.round((progress.processedBytes / progressTotalBytes) * 100),
        )
      : 0;
  // 快照阶段（以及刚发起任务时）还没有总量，进度条按不确定状态显示
  const progressIndeterminate =
    !progress || !progress.active || progressTotalBytes === 0;

  /** 进度阶段文案（阶段名与 Rust 侧 progress.rs 保持一致）。 */
  const progressPhaseLabel = (phase: string | undefined): string => {
    switch (phase) {
      case "snapshot":
        return t("settings.backupPhaseSnapshot", {
          defaultValue: "Creating database snapshot...",
        });
      case "collect":
        return t("settings.backupPhaseCollect", {
          defaultValue: "Scanning files...",
        });
      case "write":
        return t("settings.backupPhaseWrite", {
          defaultValue: "Writing backup data...",
        });
      case "apply":
        return t("settings.backupPhaseApply", {
          defaultValue: "Writing restored data...",
        });
      case "finalize":
        return t("settings.backupPhaseFinalize", {
          defaultValue: "Finalizing...",
        });
      default:
        return t("settings.backupPhasePreparing", {
          defaultValue: "Preparing...",
        });
    }
  };

  return (
    <div className="storage-card">
      <div className="storage-card-row">
        <div className="storage-card-text">
          <span className="storage-card-title">
            {t("settings.backupTitle", { defaultValue: "Data backup" })}
          </span>
          <span className="storage-card-desc">
            {t("settings.backupInfo", {
              defaultValue:
                "Back up app data to a local folder. Blocks are content-addressed, so later backups only write what changed.",
            })}
          </span>
        </div>
        <button
          type="button"
          className="general-storage-action"
          onClick={() => setExpanded((previous) => !previous)}
        >
          {expanded
            ? t("settings.storageCollapse", { defaultValue: "Collapse" })
            : t("settings.storageManage", { defaultValue: "Manage" })}
        </button>
      </div>

      {expanded && (
        <div className="storage-card-detail">
          <div className="api-settings-form-body">
            <div className="general-storage-row">
              <div className="general-storage-info">
                <FolderCog
                  size={14}
                  strokeWidth={1.8}
                  className="general-storage-icon"
                  aria-hidden="true"
                />
                <div className="general-storage-text">
                  <span className="general-storage-label">
                    {t("settings.backupTargetDir", {
                      defaultValue: "Backup folder",
                    })}
                  </span>
                  <span className="settings-item-description">
                    {targetDir ||
                      t("settings.backupTargetDirEmpty", {
                        defaultValue: "No backup folder selected yet.",
                      })}
                  </span>
                </div>
              </div>
              <div className="general-storage-actions">
                <button
                  type="button"
                  className="general-storage-action"
                  onClick={() => void handleSelectDirectory()}
                >
                  {t("settings.backupSelectDir", {
                    defaultValue: "Choose folder",
                  })}
                </button>
                {targetDir && (
                  <button
                    type="button"
                    className="general-storage-action"
                    onClick={() => void handleOpenDirectory()}
                  >
                    {t("settings.storageOpenDir", {
                      defaultValue: "Open folder",
                    })}
                  </button>
                )}
              </div>
            </div>

            <div className="general-storage-row">
              <div className="general-storage-info">
                <DatabaseBackup
                  size={14}
                  strokeWidth={1.8}
                  className="general-storage-icon"
                  aria-hidden="true"
                />
                <div className="general-storage-text">
                  <span className="general-storage-label">
                    {t("settings.backupKeep", {
                      defaultValue: "Backups to keep",
                    })}
                  </span>
                  <span className="settings-item-description">
                    {t("settings.backupKeepInfo", {
                      defaultValue:
                        "Older backups beyond this count are removed automatically.",
                    })}
                  </span>
                </div>
              </div>
              <div className="general-storage-actions">
                <div className="settings-close-behavior-select">
                  <CustomSelect
                    value={String(keep)}
                    options={KEEP_OPTIONS.map((option) => ({
                      value: String(option),
                      label: String(option),
                    }))}
                    onChange={(value) => void handleKeepChange(value)}
                  />
                </div>
              </div>
            </div>

            <div className="general-storage-row">
              <div className="general-storage-info">
                <CalendarClock
                  size={14}
                  strokeWidth={1.8}
                  className="general-storage-icon"
                  aria-hidden="true"
                />
                <div className="general-storage-text">
                  <span className="general-storage-label">
                    {t("settings.backupSchedule", {
                      defaultValue: "Automatic backup",
                    })}
                  </span>
                  <span className="settings-item-description">
                    {scheduleStatus}
                  </span>
                </div>
              </div>
              <div className="general-storage-actions">
                <div className="settings-close-behavior-select">
                  <CustomSelect
                    value={scheduleModeValue}
                    options={[
                      {
                        value: "off",
                        label: t("settings.backupScheduleModeOff", {
                          defaultValue: "Off",
                        }),
                      },
                      ...[6, 12, 24, 48].map((hours) => ({
                        value: String(hours),
                        label: t("settings.backupScheduleEveryHours", {
                          values: { hours },
                          defaultValue: `Every ${hours} hours`,
                        }),
                      })),
                      {
                        value: "daily",
                        label: t("settings.backupScheduleModeDaily", {
                          defaultValue: "Daily at a fixed time",
                        }),
                      },
                    ]}
                    onChange={handleScheduleModeChange}
                    disabled={!targetDir || scheduleSaving}
                    ariaLabel={t("settings.backupSchedule", {
                      defaultValue: "Automatic backup",
                    })}
                  />
                </div>
              </div>
            </div>

            {schedule.mode === "daily" && (
              <div className="general-storage-row">
                <div className="general-storage-info">
                  <Clock
                    size={14}
                    strokeWidth={1.8}
                    className="general-storage-icon"
                    aria-hidden="true"
                  />
                  <div className="general-storage-text">
                    <span className="general-storage-label">
                      {t("settings.backupScheduleTime", {
                        defaultValue: "Backup time",
                      })}
                    </span>
                    <span className="settings-item-description">
                      {t("settings.backupScheduleTimeInfo", {
                        defaultValue:
                          "Runs the automatic backup at this time every day.",
                      })}
                    </span>
                  </div>
                </div>
                <div className="general-storage-actions">
                  <div className="backup-schedule-time">
                    <CustomSelect
                      value={String(schedule.hour)}
                      options={HOUR_OPTIONS}
                      onChange={(value) =>
                        void applySchedule({
                          ...schedule,
                          hour: Number.parseInt(value, 10),
                        })
                      }
                      disabled={scheduleSaving}
                      ariaLabel={t("settings.backupScheduleHour", {
                        defaultValue: "Hour",
                      })}
                    />
                    <CustomSelect
                      value={String(schedule.minute)}
                      options={MINUTE_OPTIONS}
                      onChange={(value) =>
                        void applySchedule({
                          ...schedule,
                          minute: Number.parseInt(value, 10),
                        })
                      }
                      disabled={scheduleSaving}
                      ariaLabel={t("settings.backupScheduleMinute", {
                        defaultValue: "Minute",
                      })}
                    />
                  </div>
                </div>
              </div>
            )}

            <div className="general-storage-row">
              <div className="general-storage-info">
                <Power
                  size={14}
                  strokeWidth={1.8}
                  className="general-storage-icon"
                  aria-hidden="true"
                />
                <div className="general-storage-text">
                  <span className="general-storage-label">
                    {t("settings.backupWakeWhenClosed", {
                      defaultValue: "Run even when the app is closed",
                    })}
                  </span>
                  <span className="settings-item-description">
                    {t("settings.backupWakeWhenClosedHint", {
                      defaultValue:
                        "The system scheduler launches Snow App in the background shortly before the backup time. A missed backup runs once on the next launch.",
                    })}
                  </span>
                </div>
              </div>
              <div className="general-storage-actions">
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={schedule.wakeWhenClosed}
                    onChange={(event) =>
                      void applySchedule({
                        ...schedule,
                        wakeWhenClosed: event.target.checked,
                      })
                    }
                    disabled={!scheduleEnabled || scheduleSaving}
                  />
                  <span className="toggle-slider" aria-hidden="true" />
                </label>
              </div>
            </div>

            <div className="general-storage-row">
              <div className="general-storage-info">
                <DatabaseBackup
                  size={14}
                  strokeWidth={1.8}
                  className="general-storage-icon"
                  aria-hidden="true"
                />
                <div className="general-storage-text">
                  <span className="general-storage-label">
                    {t("settings.backupRun", { defaultValue: "Create backup" })}
                  </span>
                  <span className="settings-item-description">
                    {t("settings.backupStartHint", {
                      defaultValue:
                        "The first backup writes the full dataset; later ones only upload changes.",
                    })}
                  </span>
                </div>
              </div>
              <div className="general-storage-actions">
                <button
                  type="button"
                  className="general-storage-action"
                  onClick={() => void handlePlan()}
                  disabled={!targetDir || isBusy}
                >
                  {busy === "plan" ? (
                    <LoaderCircle
                      size={11}
                      strokeWidth={1.8}
                      className="tool-call-icon-spinning"
                      aria-hidden="true"
                    />
                  ) : (
                    <RefreshCw size={11} strokeWidth={1.8} aria-hidden="true" />
                  )}
                  <span>
                    {t("settings.backupPlan", { defaultValue: "Estimate" })}
                  </span>
                </button>
                <button
                  type="button"
                  className="general-storage-action"
                  onClick={() => void handleCreate()}
                  disabled={!targetDir || isBusy}
                >
                  {busy === "create" ? (
                    <LoaderCircle
                      size={11}
                      strokeWidth={1.8}
                      className="tool-call-icon-spinning"
                      aria-hidden="true"
                    />
                  ) : (
                    <DatabaseBackup
                      size={11}
                      strokeWidth={1.8}
                      aria-hidden="true"
                    />
                  )}
                  <span>
                    {busy === "create"
                      ? t("settings.backupCreating", {
                          defaultValue: "Backing up...",
                        })
                      : t("settings.backupCreate", {
                          defaultValue: "Back up now",
                        })}
                  </span>
                </button>
              </div>
            </div>

            {error && (
              <div role="alert" className="api-settings-error">
                {error}
              </div>
            )}
            {notice && (
              <div className="settings-item-description">{notice}</div>
            )}

            <div className="backup-list-panel">
              <div className="backup-list-head">
                <span className="backup-list-title">
                  {t("settings.backupListTitle", {
                    defaultValue: "Existing backups",
                  })}
                </span>
                <span className="backup-list-count">
                  {t("settings.backupListCount", {
                    values: { count: backups.length },
                    defaultValue: "{{count}} backups",
                  })}
                </span>
              </div>
              {backups.length === 0 ? (
                <div className="backup-list-empty">
                  {t("settings.backupEmpty", {
                    defaultValue: "No backups yet.",
                  })}
                </div>
              ) : (
                backups.map((backup) => (
                  <div className="backup-list-row" key={backup.id}>
                    <div className="general-storage-info">
                      <DatabaseBackup
                        size={14}
                        strokeWidth={1.8}
                        className="general-storage-icon"
                        aria-hidden="true"
                      />
                      <div className="general-storage-text">
                        <span className="general-storage-label">
                          {formatTime(backup.createdAtMs)}
                        </span>
                        <span className="settings-item-description">
                          {formatBytes(backup.totalBytes)} ·{" "}
                          {t("settings.backupFileCount", {
                            values: { count: backup.fileCount },
                            defaultValue: "{{count}} files",
                          })}
                        </span>
                      </div>
                    </div>
                    <div className="general-storage-actions">
                      <button
                        type="button"
                        className="general-storage-action"
                        onClick={() => setPendingRestore(backup)}
                        disabled={isBusy}
                      >
                        <RotateCcw
                          size={11}
                          strokeWidth={1.8}
                          aria-hidden="true"
                        />
                        <span>
                          {t("settings.backupRestore", {
                            defaultValue: "Restore",
                          })}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="general-storage-action"
                        onClick={() => setPendingDelete(backup)}
                        disabled={isBusy}
                      >
                        <Trash2
                          size={11}
                          strokeWidth={1.8}
                          aria-hidden="true"
                        />
                        <span>
                          {t("settings.backupDelete", {
                            defaultValue: "Delete",
                          })}
                        </span>
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* 备份 / 恢复进度：沿用存储迁移的进度弹窗样式（任务不可中断） */}
      {progressActive &&
        createPortal(
          <div className="storage-migration-overlay">
            <div
              className="storage-migration-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="backup-progress-title"
            >
              <div className="storage-migration-head">
                <span className="storage-migration-spinner" aria-hidden="true">
                  <LoaderCircle
                    size={18}
                    strokeWidth={1.8}
                    className="tool-call-icon-spinning"
                  />
                </span>
                <div className="storage-migration-heading">
                  <span
                    className="storage-migration-title"
                    id="backup-progress-title"
                  >
                    {busy === "create"
                      ? t("settings.backupProgressCreateTitle", {
                          defaultValue: "Backing up data",
                        })
                      : t("settings.backupProgressRestoreTitle", {
                          defaultValue: "Preparing restore",
                        })}
                  </span>
                  <span className="storage-migration-phase">
                    {progressPhaseLabel(progress?.phase)}
                  </span>
                </div>
                {!progressIndeterminate && (
                  <span className="storage-migration-percent">
                    {progressPercent}%
                  </span>
                )}
              </div>
              <div
                className="storage-migration-progress"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={
                  progressIndeterminate ? undefined : progressPercent
                }
              >
                <div
                  className={`storage-migration-progress-fill${
                    progressIndeterminate ? " indeterminate" : ""
                  }`}
                  style={
                    progressIndeterminate
                      ? undefined
                      : { width: `${progressPercent}%` }
                  }
                />
              </div>
              <div className="storage-migration-footer">
                <span className="storage-migration-count">
                  {progress && progress.totalFiles > 0
                    ? t("settings.backupProgressCount", {
                        values: {
                          files: progress.processedFiles,
                          total: progress.totalFiles,
                          size: formatBytes(progress.processedBytes),
                        },
                        defaultValue: `${progress.processedFiles}/${progress.totalFiles} files · ${formatBytes(progress.processedBytes)}`,
                      })
                    : ""}
                </span>
              </div>
              <p className="storage-migration-note">
                {busy === "create"
                  ? t("settings.backupProgressCreateNote", {
                      defaultValue: "Do not close the app while this runs.",
                    })
                  : t("settings.backupProgressRestoreNote", {
                      defaultValue:
                        "Resource files are written now; databases are swapped the next time Snow App starts.",
                    })}
              </p>
            </div>
          </div>,
          document.body,
        )}

      <ConfirmDialog
        open={pendingRestore !== null}
        title={t("settings.backupRestoreTitle", {
          defaultValue: "Restore this backup?",
        })}
        message={t("settings.backupRestoreMessage", {
          defaultValue:
            "Resource files are written right away; databases are replaced the next time Snow App starts. Current databases are kept as .pre-restore backups.",
        })}
        confirmLabel={t("settings.backupRestore", { defaultValue: "Restore" })}
        cancelLabel={t("settings.cancel", { defaultValue: "Cancel" })}
        variant="warning"
        onConfirm={() => void handleRestore()}
        onCancel={() => setPendingRestore(null)}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        title={t("settings.backupDeleteTitle", {
          defaultValue: "Delete this backup?",
        })}
        message={t("settings.backupDeleteMessage", {
          defaultValue:
            "Only this backup is removed; chunks no longer referenced by other backups are reclaimed.",
        })}
        confirmLabel={t("settings.backupDelete", { defaultValue: "Delete" })}
        cancelLabel={t("settings.cancel", { defaultValue: "Cancel" })}
        isConfirming={busy === "delete"}
        variant="danger"
        onConfirm={() => void handleDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
