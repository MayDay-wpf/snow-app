import {
  CalendarClock,
  Clock,
  Cloud,
  DatabaseBackup,
  Eye,
  EyeOff,
  FolderCog,
  Gauge,
  HardDrive,
  History,
  LoaderCircle,
  Play,
  PlugZap,
  Power,
  RefreshCw,
  RotateCcw,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  BackupR2Config,
  BackupScheduleSettings,
  BackupScheduleState,
  BackupSummary,
  BackupTarget,
  BackupTargetKind,
} from "../../../preload";
import {
  BACKUP_SETTINGS_CODES,
  DEFAULT_BACKUP_KEEP,
  DEFAULT_BACKUP_SCHEDULE,
  isBackupR2Configured,
  normalizeBackupKeep,
  normalizeBackupSchedule,
  normalizeBackupTargetKind,
} from "../../../shared/backupSchedule";
import { useI18n } from "../../i18n";
import { AutoDismissNotice } from "../AutoDismissNotice";
import { ApiSettingsHintIcon } from "./apiSettings/ApiSettingsFieldLabel";
import {
  backupTaskPercent,
  backupTaskSpeed,
  discardBackupPendingTask,
  formatBytes,
  resumeBackupPendingTask,
  runBackupTask,
  setBackupTaskDialogOpen,
  useBackupTask,
  type BackupTaskKind,
} from "./backupTask";
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

/** 卡片内后台进度条的标题文案（按任务类型）。 */
const BACKGROUND_TEXT: Record<
  BackupTaskKind,
  { key: string; fallback: string }
> = {
  create: {
    key: "settings.backupRunningInBackgroundCreate",
    fallback: "Backing up in the background",
  },
  restore: {
    key: "settings.backupRunningInBackgroundRestore",
    fallback: "Restoring in the background",
  },
  delete: {
    key: "settings.backupRunningInBackgroundDelete",
    fallback: "Deleting in the background",
  },
};

type BusyKind = "plan" | null;
type R2BusyKind = "save" | "test" | null;

/** R2 保存 / 测试连接的弹出提示。 */
type R2Notice = { message: string; tone: "success" | "error" };

const EMPTY_R2_CONFIG: BackupR2Config = {
  accountId: "",
  bucket: "",
  accessKeyId: "",
  secretAccessKey: "",
  prefix: "",
};

const formatTime = (timestampMs: number): string =>
  new Date(timestampMs).toLocaleString();

const readErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * 数据备份设置区块（通用设置 → 存储与资源）。
 *
 * 备份位置（本地目录 / Cloudflare R2）、保留份数与自动备份计划保存在系统
 * 设置里；R2 凭据由 Rust 侧读写，可在界面切换明文查看。备份本身由 Rust 侧
 * 执行：SQLite 走 Online Backup API，资源文件按 8MB 内容寻址分块去重。
 * 手动备份 / 恢复 / 删除的任务状态在 backupTask 模块中，进度弹窗可切到后台，
 * 离开设置页也不会中断；备份与删除在应用退出后可继续或放弃。自动备份的计时
 * 与系统唤醒注册在主进程，关闭应用后也能按计划执行。
 */
export function BackupSettingsSection(): React.JSX.Element {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [targetKind, setTargetKind] = useState<BackupTargetKind>("local");
  const [targetDir, setTargetDir] = useState("");
  /** 已保存的 R2 配置（null 表示尚未读取） */
  const [r2Config, setR2Config] = useState<BackupR2Config | null>(null);
  const [r2Form, setR2Form] = useState<BackupR2Config>(EMPTY_R2_CONFIG);
  const [r2Busy, setR2Busy] = useState<R2BusyKind>(null);
  const [r2Notice, setR2Notice] = useState<R2Notice | null>(null);
  const [showR2Secret, setShowR2Secret] = useState(false);
  const [keep, setKeep] = useState(DEFAULT_BACKUP_KEEP);
  const [scheduleState, setScheduleState] =
    useState<BackupScheduleState | null>(null);
  const [scheduleSaving, setScheduleSaving] = useState(false);
  const [backups, setBackups] = useState<BackupSummary[]>([]);
  const [busy, setBusy] = useState<BusyKind>(null);
  /** 手动备份 / 恢复任务（模块级状态，设置页卸载后继续执行） */
  const backupTask = useBackupTask();
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [pendingRestore, setPendingRestore] = useState<BackupSummary | null>(
    null,
  );
  const [pendingDelete, setPendingDelete] = useState<BackupSummary | null>(
    null,
  );

  /** 当前可用的备份目标；位置尚未配置完整时为 null。 */
  const target = useMemo<BackupTarget | null>(() => {
    if (targetKind === "r2") {
      return isBackupR2Configured(r2Config) ? { kind: "r2" } : null;
    }
    return targetDir ? { kind: "local", dir: targetDir } : null;
  }, [targetKind, targetDir, r2Config]);

  /** 事件回调里读取最新目标，避免订阅随目标变化重建。 */
  const targetRef = useRef<BackupTarget | null>(null);

  useEffect(() => {
    targetRef.current = target;
  }, [target]);

  const schedule = scheduleState?.settings ?? DEFAULT_BACKUP_SCHEDULE;

  const refreshList = useCallback(async (current: BackupTarget | null) => {
    if (!current) {
      setBackups([]);
      return;
    }
    try {
      const list = await window.snow.backupList(current);
      setBackups(list);
    } catch (listError) {
      setBackups([]);
      setError(readErrorMessage(listError));
    }
  }, []);

  // 读取已保存的备份位置、R2 配置、保留份数与自动备份计划。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [savedKind, savedDir, savedKeep, savedR2, savedSchedule] =
          await Promise.all([
            window.snow.getSystemSettingValue(BACKUP_SETTINGS_CODES.targetKind),
            window.snow.getSystemSettingValue(BACKUP_SETTINGS_CODES.targetDir),
            window.snow.getSystemSettingValue(BACKUP_SETTINGS_CODES.keep),
            window.snow.backupGetR2Config().catch(() => null),
            window.snow.getBackupSchedule().catch(() => null),
          ]);
        if (cancelled) {
          return;
        }
        const parsedKeep = savedKeep ? Number.parseInt(savedKeep, 10) : NaN;
        setTargetKind(normalizeBackupTargetKind(savedKind?.trim()));
        setTargetDir(savedDir?.trim() ?? "");
        setKeep(normalizeBackupKeep(parsedKeep));
        if (savedR2) {
          setR2Config(savedR2);
          setR2Form(savedR2);
        }
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
      if (!next.running && targetRef.current) {
        void refreshList(targetRef.current);
      }
    });
    return unsubscribe;
  }, [refreshList]);

  useEffect(() => {
    if (!loaded) {
      return;
    }
    void refreshList(target);
  }, [loaded, target, refreshList]);

  // 手动备份 / 恢复结束后刷新列表（任务可能在设置页挂载期间于后台完成）。
  const finishedRef = useRef(backupTask.finished);

  useEffect(() => {
    if (backupTask.finished === finishedRef.current) {
      return;
    }
    finishedRef.current = backupTask.finished;
    if (loaded) {
      void refreshList(targetRef.current);
    }
  }, [backupTask.finished, loaded, refreshList]);

  /** 备份位置变化后，计划已开启时立即按新位置重新安排下一次备份。 */
  const rescheduleIfEnabled = async (): Promise<void> => {
    if (schedule.mode !== "off") {
      const next = await window.snow.setBackupSchedule(schedule);
      setScheduleState(next);
    }
  };

  const handleTargetKindChange = async (value: string): Promise<void> => {
    const nextKind = normalizeBackupTargetKind(value);
    if (nextKind === targetKind) {
      return;
    }
    setTargetKind(nextKind);
    setBackups([]);
    setError("");
    setNotice("");
    await window.snow.setSystemSetting(
      BACKUP_SETTINGS_CODES.targetKindName,
      BACKUP_SETTINGS_CODES.targetKind,
      nextKind,
    );
    await rescheduleIfEnabled();
  };

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
    await rescheduleIfEnabled();
  };

  const updateR2Field =
    (field: keyof BackupR2Config) =>
    (event: React.ChangeEvent<HTMLInputElement>): void => {
      const { value } = event.target;
      setR2Form((current) => ({ ...current, [field]: value }));
    };

  const handleR2Save = async (): Promise<void> => {
    if (r2Busy) {
      return;
    }
    setR2Busy("save");
    setR2Notice(null);
    try {
      await window.snow.backupSetR2Config(r2Form);
      const saved = await window.snow.backupGetR2Config();
      setR2Config(saved);
      setR2Form(saved);
      setR2Notice({
        tone: "success",
        message: t("settings.backupR2Saved", {
          defaultValue: "Cloudflare R2 settings saved.",
        }),
      });
      await rescheduleIfEnabled();
    } catch (saveError) {
      setR2Notice({
        tone: "error",
        message: t("settings.backupFailed", {
          values: { error: readErrorMessage(saveError) },
          defaultValue: "Operation failed: {{error}}",
        }),
      });
    } finally {
      setR2Busy(null);
    }
  };

  const handleR2Test = async (): Promise<void> => {
    if (r2Busy) {
      return;
    }
    setR2Busy("test");
    setR2Notice(null);
    try {
      await window.snow.backupTestR2Config(r2Form);
      setR2Notice({
        tone: "success",
        message: t("settings.backupR2TestOk", {
          defaultValue: "Connected to Cloudflare R2.",
        }),
      });
    } catch (testError) {
      setR2Notice({
        tone: "error",
        message: t("settings.backupR2TestFailed", {
          values: { error: readErrorMessage(testError) },
          defaultValue: "Cloudflare R2 connection failed: {{error}}",
        }),
      });
    } finally {
      setR2Busy(null);
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
  const scheduleEnabled = schedule.mode !== "off" && target !== null;
  const scheduleStatus = ((): string => {
    if (!target) {
      return targetKind === "r2"
        ? t("settings.backupScheduleNeedR2", {
            defaultValue:
              "Save the Cloudflare R2 settings to enable automatic backups.",
          })
        : t("settings.backupScheduleNeedDir", {
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
    if (!target || busy) {
      return;
    }
    setBusy("plan");
    setError("");
    setNotice("");
    try {
      const plan = await window.snow.backupPlan(target);
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

  const handleCreate = (): void => {
    if (!target || isBlockedByPending) {
      return;
    }
    setError("");
    setNotice("");
    runBackupTask("create", () => window.snow.backupCreate(target, keep));
  };

  const handleRestore = (): void => {
    const backup = pendingRestore;
    if (!target || !backup || isBusy) {
      return;
    }
    setPendingRestore(null);
    setError("");
    setNotice("");
    runBackupTask("restore", () =>
      window.snow.backupRestore(target, backup.id),
    );
  };

  const handleDelete = (): void => {
    const backup = pendingDelete;
    if (!target || !backup || isBlockedByPending) {
      return;
    }
    setPendingDelete(null);
    setError("");
    setNotice("");
    runBackupTask("delete", () => window.snow.backupDelete(target, backup.id));
  };

  // 手动任务与自动备份执行期间禁用备份 / 恢复 / 删除，避免两个任务争用备份数据。
  const isBusy =
    busy !== null ||
    backupTask.running !== null ||
    scheduleState?.running === true;
  /** 有中断的备份 / 删除待处理时，必须先继续或放弃才能开始新的备份或删除。 */
  const isBlockedByPending = isBusy || backupTask.pending !== null;
  const backupTaskPercentValue = backupTaskPercent(backupTask.progress);
  const backupTaskSpeedValue = backupTaskSpeed(backupTask.progress);

  /** 上次退出前未完成的备份 / 删除：提示继续或放弃。 */
  const renderPendingTask = (
    placement: "header" | "body",
  ): React.JSX.Element | null => {
    const pending = backupTask.pending;
    if (!pending || backupTask.running) {
      return null;
    }
    const time = formatTime(pending.startedAtMs);
    return (
      <div className={`backup-task-inline ${placement}`}>
        <div className="backup-task-inline-head">
          <span className="backup-task-inline-title">
            <History size={12} strokeWidth={1.8} aria-hidden="true" />
            {pending.kind === "delete"
              ? t("settings.backupPendingDeleteInline", {
                  values: { time },
                  defaultValue: "Deletion started at {{time}} was interrupted",
                })
              : t("settings.backupPendingCreateInline", {
                  values: { time },
                  defaultValue: "Backup started at {{time}} was interrupted",
                })}
          </span>
          <div className="general-storage-actions">
            <button
              type="button"
              className="general-storage-action"
              onClick={() => void discardBackupPendingTask()}
              disabled={isBusy}
            >
              <X size={11} strokeWidth={1.8} aria-hidden="true" />
              <span>
                {t("settings.backupPendingDiscard", {
                  defaultValue: "Discard",
                })}
              </span>
            </button>
            <button
              type="button"
              className="general-storage-action"
              onClick={resumeBackupPendingTask}
              disabled={isBusy}
            >
              <Play size={11} strokeWidth={1.8} aria-hidden="true" />
              <span>
                {t("settings.backupPendingResume", {
                  defaultValue: "Continue",
                })}
              </span>
            </button>
          </div>
        </div>
      </div>
    );
  };

  /** 后台执行中的手动备份 / 恢复 / 删除：显示进度条，可重新展开进度弹窗。 */
  const renderBackupTaskInline = (
    placement: "header" | "body",
  ): React.JSX.Element | null => {
    if (!backupTask.running || backupTask.dialogOpen) {
      return null;
    }
    const title = BACKGROUND_TEXT[backupTask.running];
    return (
      <div className={`backup-task-inline ${placement}`}>
        <div className="backup-task-inline-head">
          <span className="backup-task-inline-title">
            <LoaderCircle
              size={12}
              strokeWidth={1.8}
              className="tool-call-icon-spinning"
              aria-hidden="true"
            />
            {t(title.key, { defaultValue: title.fallback })}
            {backupTaskPercentValue !== null && (
              <span className="backup-task-inline-percent">
                {backupTaskPercentValue}%
              </span>
            )}
            {backupTaskSpeedValue && (
              <span className="backup-task-speed">
                <Gauge size={11} strokeWidth={1.8} aria-hidden="true" />
                {backupTaskSpeedValue}
              </span>
            )}
          </span>
          <button
            type="button"
            className="general-storage-action"
            onClick={() => setBackupTaskDialogOpen(true)}
          >
            {t("settings.backupShowProgress", {
              defaultValue: "Show progress",
            })}
          </button>
        </div>
        <div
          className="storage-migration-progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={backupTaskPercentValue ?? undefined}
        >
          <div
            className={`storage-migration-progress-fill${
              backupTaskPercentValue === null ? " indeterminate" : ""
            }`}
            style={
              backupTaskPercentValue === null
                ? undefined
                : { width: `${backupTaskPercentValue}%` }
            }
          />
        </div>
      </div>
    );
  };

  return (
    <div className="storage-card">
      <AutoDismissNotice
        message={r2Notice?.message ?? ""}
        tone={r2Notice?.tone ?? "success"}
        durationMs={r2Notice?.tone === "error" ? 5000 : undefined}
        onDismiss={() => setR2Notice(null)}
      />
      <div className="storage-card-row">
        <div className="storage-card-text">
          <span className="storage-card-title">
            {t("settings.backupTitle", { defaultValue: "Data backup" })}
            <ApiSettingsHintIcon
              hint={t("settings.backupInfo", {
                defaultValue:
                  "Back up app data to a local folder or Cloudflare R2. Blocks are content-addressed, so later backups only upload what changed.",
              })}
            />
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

      {/* 卡片收起时后台进度放在头部下方，展开后显示在「创建备份」下方 */}
      {!expanded && renderBackupTaskInline("header")}
      {!expanded && renderPendingTask("header")}

      {expanded && (
        <div className="storage-card-detail">
          <div className="api-settings-form-body">
            <div className="general-storage-row">
              <div className="general-storage-info">
                {targetKind === "r2" ? (
                  <Cloud
                    size={14}
                    strokeWidth={1.8}
                    className="general-storage-icon"
                    aria-hidden="true"
                  />
                ) : (
                  <HardDrive
                    size={14}
                    strokeWidth={1.8}
                    className="general-storage-icon"
                    aria-hidden="true"
                  />
                )}
                <div className="general-storage-text">
                  <span className="general-storage-label">
                    {t("settings.backupTargetKind", {
                      defaultValue: "Backup location",
                    })}
                    <ApiSettingsHintIcon
                      hint={t("settings.backupTargetKindInfo", {
                        defaultValue:
                          "Back up to a local folder or a Cloudflare R2 bucket. Each location keeps its own backup list.",
                      })}
                    />
                  </span>
                </div>
              </div>
              <div className="general-storage-actions">
                <div className="settings-close-behavior-select">
                  <CustomSelect
                    value={targetKind}
                    options={[
                      {
                        value: "local",
                        label: t("settings.backupTargetLocal", {
                          defaultValue: "Local folder",
                        }),
                      },
                      {
                        value: "r2",
                        label: t("settings.backupTargetR2", {
                          defaultValue: "Cloudflare R2",
                        }),
                      },
                    ]}
                    onChange={(value) => void handleTargetKindChange(value)}
                    disabled={isBusy}
                    ariaLabel={t("settings.backupTargetKind", {
                      defaultValue: "Backup location",
                    })}
                  />
                </div>
              </div>
            </div>

            {targetKind === "local" ? (
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
                    disabled={isBusy}
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
            ) : (
              <div className="api-settings-form-section">
                <div className="api-settings-form-section-header">
                  <span className="api-settings-form-section-title">
                    {t("settings.backupR2Title", {
                      defaultValue: "Cloudflare R2",
                    })}
                    <ApiSettingsHintIcon
                      hint={t("settings.backupR2Info", {
                        defaultValue:
                          "Create an R2 API token with Object Read & Write permission for the bucket in the Cloudflare dashboard. Credentials are stored only in the local database.",
                      })}
                    />
                  </span>
                </div>
                <div className="api-settings-form-grid">
                  <label className="api-settings-field">
                    <span>
                      {t("settings.backupR2AccountId", {
                        defaultValue: "Account ID",
                      })}
                    </span>
                    <input
                      value={r2Form.accountId}
                      onChange={updateR2Field("accountId")}
                      placeholder={t("settings.backupR2AccountIdPlaceholder", {
                        defaultValue: "32-character account ID",
                      })}
                      autoComplete="off"
                      spellCheck={false}
                      disabled={r2Busy !== null || isBusy}
                    />
                  </label>
                  <label className="api-settings-field">
                    <span>
                      {t("settings.backupR2Bucket", {
                        defaultValue: "Bucket",
                      })}
                    </span>
                    <input
                      value={r2Form.bucket}
                      onChange={updateR2Field("bucket")}
                      placeholder="snow-app-backup"
                      autoComplete="off"
                      spellCheck={false}
                      disabled={r2Busy !== null || isBusy}
                    />
                  </label>
                  <label className="api-settings-field">
                    <span>
                      {t("settings.backupR2AccessKeyId", {
                        defaultValue: "Access Key ID",
                      })}
                    </span>
                    <input
                      value={r2Form.accessKeyId}
                      onChange={updateR2Field("accessKeyId")}
                      autoComplete="off"
                      spellCheck={false}
                      disabled={r2Busy !== null || isBusy}
                    />
                  </label>
                  <label className="api-settings-field">
                    <span>
                      {t("settings.backupR2SecretAccessKey", {
                        defaultValue: "Secret Access Key",
                      })}
                    </span>
                    <div className="api-settings-password-wrap">
                      <input
                        type={showR2Secret ? "text" : "password"}
                        value={r2Form.secretAccessKey}
                        onChange={updateR2Field("secretAccessKey")}
                        autoComplete="new-password"
                        spellCheck={false}
                        disabled={r2Busy !== null || isBusy}
                      />
                      <button
                        type="button"
                        className="api-settings-password-toggle"
                        onClick={() => setShowR2Secret((value) => !value)}
                        tabIndex={-1}
                      >
                        {showR2Secret ? (
                          <EyeOff size={14} />
                        ) : (
                          <Eye size={14} />
                        )}
                      </button>
                    </div>
                  </label>
                  <label className="api-settings-field wide">
                    <span>
                      {t("settings.backupR2Prefix", {
                        defaultValue: "Path prefix (optional)",
                      })}
                    </span>
                    <input
                      value={r2Form.prefix}
                      onChange={updateR2Field("prefix")}
                      placeholder={t("settings.backupR2PrefixPlaceholder", {
                        defaultValue:
                          "e.g. laptop; backups go under <prefix>/snow-app-backup/",
                      })}
                      autoComplete="off"
                      spellCheck={false}
                      disabled={r2Busy !== null || isBusy}
                    />
                  </label>
                </div>
                <div className="api-settings-form-actions">
                  <button
                    type="button"
                    className="general-storage-action"
                    onClick={() => void handleR2Test()}
                    disabled={r2Busy !== null || isBusy}
                  >
                    {r2Busy === "test" ? (
                      <LoaderCircle
                        size={11}
                        strokeWidth={1.8}
                        className="tool-call-icon-spinning"
                        aria-hidden="true"
                      />
                    ) : (
                      <PlugZap size={11} strokeWidth={1.8} aria-hidden="true" />
                    )}
                    <span>
                      {t("settings.backupR2Test", {
                        defaultValue: "Test connection",
                      })}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="general-storage-action"
                    onClick={() => void handleR2Save()}
                    disabled={r2Busy !== null || isBusy}
                  >
                    {r2Busy === "save" ? (
                      <LoaderCircle
                        size={11}
                        strokeWidth={1.8}
                        className="tool-call-icon-spinning"
                        aria-hidden="true"
                      />
                    ) : (
                      <Save size={11} strokeWidth={1.8} aria-hidden="true" />
                    )}
                    <span>
                      {t("settings.backupR2Save", {
                        defaultValue: "Save",
                      })}
                    </span>
                  </button>
                </div>
              </div>
            )}

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
                    <ApiSettingsHintIcon
                      hint={t("settings.backupKeepInfo", {
                        defaultValue:
                          "Older backups beyond this count are removed automatically.",
                      })}
                    />
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
                    disabled={!target || scheduleSaving}
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
                      <ApiSettingsHintIcon
                        hint={t("settings.backupScheduleTimeInfo", {
                          defaultValue:
                            "Runs the automatic backup at this time every day.",
                        })}
                      />
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
                    <ApiSettingsHintIcon
                      hint={t("settings.backupWakeWhenClosedHint", {
                        defaultValue:
                          "The system scheduler launches Snow App in the background shortly before the backup time. A missed backup runs once on the next launch.",
                      })}
                    />
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
                    <ApiSettingsHintIcon
                      hint={t("settings.backupStartHint", {
                        defaultValue:
                          "The first backup writes the full dataset; later ones only upload changes.",
                      })}
                    />
                  </span>
                </div>
              </div>
              <div className="general-storage-actions">
                <button
                  type="button"
                  className="general-storage-action"
                  onClick={() => void handlePlan()}
                  disabled={!target || isBusy}
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
                  onClick={handleCreate}
                  disabled={!target || isBlockedByPending}
                >
                  {backupTask.running === "create" ? (
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
                    {backupTask.running === "create"
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

            {renderBackupTaskInline("body")}
            {renderPendingTask("body")}

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
                        disabled={isBlockedByPending}
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
        onConfirm={handleRestore}
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
        variant="danger"
        onConfirm={handleDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
