import { CircleStop, Gauge, LoaderCircle, Minimize2 } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../i18n";
import { AutoDismissNotice } from "../AutoDismissNotice";
import { ConfirmDialog } from "../common/ConfirmDialog";
import {
  backupTaskPercent,
  backupTaskSpeed,
  cancelBackupTask,
  discardBackupPendingTask,
  dismissBackupTaskOutcome,
  formatBytes,
  isCancellableBackupTask,
  refreshBackupPendingTask,
  resumeBackupPendingTask,
  setBackupTaskDialogOpen,
  useBackupTask,
  type BackupTaskKind,
} from "./backupTask";

/** 进度阶段文案 key（阶段名与 Rust 侧 progress.rs 保持一致）。 */
const PHASE_TEXT: Record<string, { key: string; fallback: string }> = {
  snapshot: {
    key: "settings.backupPhaseSnapshot",
    fallback: "Creating database snapshot...",
  },
  collect: {
    key: "settings.backupPhaseCollect",
    fallback: "Scanning files...",
  },
  write: {
    key: "settings.backupPhaseWrite",
    fallback: "Writing backup data...",
  },
  apply: {
    key: "settings.backupPhaseApply",
    fallback: "Writing restored data...",
  },
  remove: {
    key: "settings.backupPhaseRemove",
    fallback: "Removing backup record...",
  },
  scan: {
    key: "settings.backupPhaseScan",
    fallback: "Checking chunks still in use...",
  },
  reclaim: {
    key: "settings.backupPhaseReclaim",
    fallback: "Reclaiming unused chunks...",
  },
  finalize: { key: "settings.backupPhaseFinalize", fallback: "Finalizing..." },
};

/** 进度弹窗标题与说明文案（按任务类型）。 */
const TASK_TEXT: Record<
  BackupTaskKind,
  { title: string; titleFallback: string; note: string; noteFallback: string }
> = {
  create: {
    title: "settings.backupProgressCreateTitle",
    titleFallback: "Backing up data",
    note: "settings.backupProgressCreateNote",
    noteFallback:
      "You can keep using the app in the background. If you quit midway, the unfinished part can be resumed next time.",
  },
  restore: {
    title: "settings.backupProgressRestoreTitle",
    titleFallback: "Preparing restore",
    note: "settings.backupProgressRestoreNote",
    noteFallback:
      "Resource files are written now; databases are swapped the next time Snow App starts.",
  },
  delete: {
    title: "settings.backupProgressDeleteTitle",
    titleFallback: "Deleting backup",
    note: "settings.backupProgressDeleteNote",
    noteFallback:
      "You can keep using the app in the background. If you quit midway, the deletion can be resumed next time.",
  },
};

/**
 * 手动备份 / 恢复 / 删除任务的常驻宿主：进度弹窗、完成提示与中断任务提醒。
 *
 * 挂在常驻的主侧边栏里而不是设置页，用户把弹窗切到后台并离开设置页后，
 * 任务结束时仍能收到结果提示，也能回到设置页重新展开进度。启动时若发现
 * 上次退出前未完成的备份 / 删除，会提示用户继续或放弃。
 */
export function BackupTaskHost(): React.JSX.Element {
  const { t } = useI18n();
  const { running, progress, dialogOpen, outcome, pending, cancelling } =
    useBackupTask();
  const percent = backupTaskPercent(progress);
  const speed = backupTaskSpeed(progress);
  const phase = PHASE_TEXT[progress?.phase ?? ""];
  /**
   * 启动时发现的中断任务：只对它弹一次继续提示。本次会话里失败留下的任务
   * 不弹窗，由设置页卡片提供继续 / 放弃入口。
   */
  const [promptKey, setPromptKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void refreshBackupPendingTask().then((found) => {
      if (!cancelled && found) {
        setPromptKey(`${found.kind}:${found.backupId}`);
      }
    });
    // 自动备份会先续跑中断的任务：结束后重新读取，让设置页的入口与实际状态一致。
    const unsubscribe = window.snow.onBackupScheduleChanged((next) => {
      if (!next.running) {
        void refreshBackupPendingTask();
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const pendingKey = pending ? `${pending.kind}:${pending.backupId}` : null;
  const pendingTime = pending
    ? new Date(pending.startedAtMs).toLocaleString()
    : "";
  const showResumePrompt =
    pendingKey !== null && running === null && pendingKey === promptKey;

  const outcomeMessage = ((): string => {
    if (!outcome) {
      return "";
    }
    if (outcome.cancelled) {
      return outcome.kind === "delete"
        ? t("settings.backupDeleteCancelled", {
            defaultValue:
              "Deletion stopped. Leftover data will be cleaned up on the next backup or deletion.",
          })
        : t("settings.backupCancelled", {
            defaultValue: "Backup cancelled.",
          });
    }
    if (outcome.error !== null) {
      return t("settings.backupFailed", {
        values: { error: outcome.error },
        defaultValue: "Operation failed: {{error}}",
      });
    }
    if (outcome.kind === "restore") {
      return t("settings.backupRestored", {
        defaultValue: "Restore is ready. Restart Snow App to apply it.",
      });
    }
    if (outcome.kind === "delete") {
      return t("settings.backupDeleted", {
        defaultValue: "Backup deleted.",
      });
    }
    return t("settings.backupCreated", {
      values: {
        size: formatBytes(outcome.result?.uploadedBytes ?? 0),
        files: outcome.result?.fileCount ?? 0,
      },
      defaultValue: "Backup finished: {{size}} written, {{files}} files.",
    });
  })();

  const failed = outcome !== null && outcome.error !== null;
  const taskText = running ? TASK_TEXT[running] : null;

  /** 进度弹窗底部的数量统计：按字节计量的任务显示大小，删除显示回收的块数。 */
  const progressCount = ((): string => {
    if (!progress) {
      return "";
    }
    if (progress.totalBytes > 0) {
      return t("settings.backupProgressBytes", {
        values: {
          done: formatBytes(progress.processedBytes),
          total: formatBytes(progress.totalBytes),
          files: progress.processedFiles,
          totalFiles: progress.totalFiles,
        },
        defaultValue: "{{done}} / {{total}} · {{files}}/{{totalFiles}} files",
      });
    }
    if (progress.totalFiles > 0) {
      return t("settings.backupProgressChunks", {
        values: { done: progress.processedFiles, total: progress.totalFiles },
        defaultValue: "{{done}} / {{total}} chunks",
      });
    }
    return "";
  })();

  const closeResumePrompt = (): void => setPromptKey(null);

  return (
    <>
      <AutoDismissNotice
        message={outcomeMessage}
        tone={failed ? "error" : outcome?.cancelled ? "info" : "success"}
        durationMs={failed ? 5000 : 3500}
        onDismiss={dismissBackupTaskOutcome}
      />
      <ConfirmDialog
        open={showResumePrompt}
        confirmTone="primary"
        title={
          pending?.kind === "delete"
            ? t("settings.backupPendingDeleteTitle", {
                defaultValue: "Deleting a backup was interrupted",
              })
            : t("settings.backupPendingCreateTitle", {
                defaultValue: "A backup was interrupted",
              })
        }
        message={
          pending?.kind === "delete"
            ? t("settings.backupPendingDeleteMessage", {
                values: { time: pendingTime },
                defaultValue:
                  "The deletion started at {{time}} did not finish before Snow App quit. Continue it now?",
              })
            : t("settings.backupPendingCreateMessage", {
                values: { time: pendingTime },
                defaultValue:
                  "The backup started at {{time}} did not finish before Snow App quit. Continue it now? Data already written will not be uploaded again.",
              })
        }
        confirmLabel={t("settings.backupPendingResume", {
          defaultValue: "Continue",
        })}
        cancelLabel={t("settings.backupPendingLater", {
          defaultValue: "Later",
        })}
        extraLabel={t("settings.backupPendingDiscard", {
          defaultValue: "Discard",
        })}
        onConfirm={() => {
          closeResumePrompt();
          resumeBackupPendingTask();
        }}
        onExtra={() => {
          closeResumePrompt();
          void discardBackupPendingTask();
        }}
        onCancel={closeResumePrompt}
      />
      {running &&
        taskText &&
        dialogOpen &&
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
                    {t(taskText.title, {
                      defaultValue: taskText.titleFallback,
                    })}
                  </span>
                  <span className="storage-migration-phase">
                    {phase
                      ? t(phase.key, { defaultValue: phase.fallback })
                      : t("settings.backupPhasePreparing", {
                          defaultValue: "Preparing...",
                        })}
                  </span>
                </div>
                {(percent !== null || speed) && (
                  <span className="backup-task-rate">
                    {percent !== null && (
                      <span className="storage-migration-percent">
                        {percent}%
                      </span>
                    )}
                    {speed && (
                      <span className="backup-task-speed">
                        <Gauge size={11} strokeWidth={1.8} aria-hidden="true" />
                        {speed}
                      </span>
                    )}
                  </span>
                )}
              </div>
              <div
                className="storage-migration-progress"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent ?? undefined}
              >
                <div
                  className={`storage-migration-progress-fill${
                    percent === null ? " indeterminate" : ""
                  }`}
                  style={
                    percent === null ? undefined : { width: `${percent}%` }
                  }
                />
              </div>
              <div className="storage-migration-footer">
                <span className="storage-migration-count">{progressCount}</span>
                <div className="general-storage-actions">
                  {isCancellableBackupTask(running) && (
                    <button
                      type="button"
                      className="general-storage-action"
                      onClick={() => void cancelBackupTask()}
                      disabled={cancelling}
                    >
                      {cancelling ? (
                        <LoaderCircle
                          size={11}
                          strokeWidth={1.8}
                          className="tool-call-icon-spinning"
                          aria-hidden="true"
                        />
                      ) : (
                        <CircleStop
                          size={11}
                          strokeWidth={1.8}
                          aria-hidden="true"
                        />
                      )}
                      <span>
                        {cancelling
                          ? t("settings.backupCancelling", {
                              defaultValue: "Cancelling...",
                            })
                          : running === "delete"
                            ? t("settings.backupCancelDelete", {
                                defaultValue: "Stop deleting",
                              })
                            : t("settings.backupCancel", {
                                defaultValue: "Cancel backup",
                              })}
                      </span>
                    </button>
                  )}
                  <button
                    type="button"
                    className="general-storage-action"
                    onClick={() => setBackupTaskDialogOpen(false)}
                  >
                    <Minimize2 size={11} strokeWidth={1.8} aria-hidden="true" />
                    <span>
                      {t("settings.backupRunInBackground", {
                        defaultValue: "Run in background",
                      })}
                    </span>
                  </button>
                </div>
              </div>
              <p className="storage-migration-note">
                {t(taskText.note, { defaultValue: taskText.noteFallback })}
              </p>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
