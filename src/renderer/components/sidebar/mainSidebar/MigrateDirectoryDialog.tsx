import {
  ArrowRight,
  FolderSearch,
  History,
  Loader2,
  RotateCcw,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { useI18n } from "../../../i18n";
import type {
  WorkspaceDirectoryRecord,
  WorkspaceRelinkRecord,
  WorkspaceRelinkReport,
} from "../../../../preload";
import { ConfirmDialog } from "../../common/ConfirmDialog";
import { FormDialog } from "../../common/FormDialog";

type MigrateDirectoryDialogProps = {
  /** 查看/迁移的项目；为 null 时对话框关闭。 */
  directory: WorkspaceDirectoryRecord | null;
  onCancel: () => void;
  /** 撤销成功后通知上层刷新项目列表（目录 id 会回退）。 */
  onUndone: () => void;
  /** 迁移成功后通知上层刷新项目列表（目录 id 已切换）。 */
  onMigrated: () => void;
};

const formatCounts = (
  report: WorkspaceRelinkReport,
  template: (values: Record<string, number>) => string,
): string =>
  template({
    conversations: report.conversations,
    memories: report.memories,
    memos: report.memos,
    tasks: report.scheduledTasks,
    collections: report.collectionsTouched,
  });

export function MigrateDirectoryDialog({
  directory,
  onCancel,
  onUndone,
  onMigrated,
}: MigrateDirectoryDialogProps): React.JSX.Element {
  const { t } = useI18n();
  const [records, setRecords] = useState<WorkspaceRelinkRecord[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [undoTarget, setUndoTarget] = useState<WorkspaceRelinkRecord | null>(
    null,
  );
  const [isUndoing, setIsUndoing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 更换目录区：选择新位置 -> 预演迁移 -> 确认执行
  const [selectedPath, setSelectedPath] = useState("");
  const [preview, setPreview] = useState<WorkspaceRelinkReport | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSelectingFolder, setIsSelectingFolder] = useState(false);

  const directoryId = directory?.directoryId ?? "";
  // 只有本地目录支持「更换目录」；SSH 连接编辑走单独的编辑连接流程
  const canMigrate = directory?.kind !== "ssh";

  const loadRecords = useCallback(async (): Promise<void> => {
    if (!directoryId) {
      setRecords([]);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const items = await window.snow.listWorkspaceDirectoryRelinks(
        directoryId,
        50,
      );
      setRecords(items);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : String(loadError),
      );
    } finally {
      setIsLoading(false);
    }
  }, [directoryId]);

  useEffect(() => {
    if (!directory) {
      setRecords([]);
      setUndoTarget(null);
      setError(null);
      setSelectedPath("");
      setPreview(null);
      return;
    }
    void loadRecords();
  }, [directory, loadRecords]);

  // 新位置变化后跑一次 dry-run 预览：告诉用户会迁移多少数据、是否触发合并。
  useEffect(() => {
    const targetPath = selectedPath.trim();
    if (!directoryId || !targetPath || !canMigrate) {
      setPreview(null);
      return;
    }

    let cancelled = false;
    setIsPreviewing(true);

    void window.snow
      .relinkWorkspaceDirectory(directoryId, targetPath, true)
      .then((result) => {
        if (cancelled) return;
        setPreview(result.report);
        setError(null);
      })
      .catch((previewError: unknown) => {
        if (cancelled) return;
        setPreview(null);
        setError(
          previewError instanceof Error
            ? previewError.message
            : String(previewError),
        );
      })
      .finally(() => {
        if (!cancelled) setIsPreviewing(false);
      });

    return () => {
      cancelled = true;
    };
  }, [canMigrate, directoryId, selectedPath]);

  const handleSelectFolder = useCallback(async (): Promise<void> => {
    if (isSelectingFolder || isSubmitting) return;
    setIsSelectingFolder(true);
    setError(null);
    try {
      const selected = await window.snow.selectWorkspaceDirectory(
        t("sidebar.migrateDirectorySelectTitle", {
          defaultValue: "Select the folder to move the project to",
        }),
      );
      if (selected) {
        setSelectedPath(selected);
      }
    } catch (selectionError) {
      setError(
        selectionError instanceof Error
          ? selectionError.message
          : String(selectionError),
      );
    } finally {
      setIsSelectingFolder(false);
    }
  }, [isSelectingFolder, isSubmitting, t]);

  const handleMigrate = useCallback((): void => {
    const targetPath = selectedPath.trim();
    if (!directoryId || !targetPath || isSubmitting || isPreviewing) return;

    setIsSubmitting(true);
    setError(null);

    void (async (): Promise<void> => {
      try {
        await window.snow.relinkWorkspaceDirectory(
          directoryId,
          targetPath,
          false,
        );
        setSelectedPath("");
        setPreview(null);
        // 目录 id 已切换，先关闭对话框再让上层刷新列表
        onMigrated();
      } catch (migrateError) {
        setError(
          migrateError instanceof Error
            ? migrateError.message
            : String(migrateError),
        );
      } finally {
        setIsSubmitting(false);
      }
    })();
  }, [directoryId, isPreviewing, isSubmitting, onMigrated, selectedPath]);

  const handleUndoConfirm = useCallback((): void => {
    const target = undoTarget;
    if (!target || isUndoing) {
      return;
    }

    setIsUndoing(true);
    setError(null);

    void (async (): Promise<void> => {
      try {
        await window.snow.undoWorkspaceDirectoryRelink(target.relinkId);
        setUndoTarget(null);
        await loadRecords();
        onUndone();
      } catch (undoError) {
        setUndoTarget(null);
        setError(
          undoError instanceof Error ? undoError.message : String(undoError),
        );
      } finally {
        setIsUndoing(false);
      }
    })();
  }, [isUndoing, loadRecords, onUndone, undoTarget]);

  return (
    <>
      <FormDialog
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        closeLabel={t("sidebar.close", { defaultValue: "Close" })}
        isSubmitting={isSubmitting || isUndoing}
        onCancel={onCancel}
        open={directory !== null}
        showFooter={false}
        title={t("sidebar.migrateDirectoryTitle", {
          defaultValue: "Migrate",
        })}
      >
        {canMigrate ? (
          <div className="migrate-directory-section">
            <label className="form-dialog-field">
              <span className="form-dialog-label">
                {t("sidebar.migrateDirectoryTargetLabel", {
                  defaultValue: "Move to",
                })}
              </span>
              <div className="form-dialog-input-row">
                <input
                  className="form-dialog-input"
                  placeholder={t("sidebar.localDirectoryPathPlaceholder", {
                    defaultValue: "No folder selected",
                  })}
                  readOnly
                  value={selectedPath}
                />
                <button
                  className="form-dialog-button cancel form-dialog-browse-button"
                  disabled={isSubmitting || isSelectingFolder}
                  onClick={() => void handleSelectFolder()}
                  type="button"
                >
                  <FolderSearch size={13} />
                  {t("sidebar.selectFolder", {
                    defaultValue: "Select folder",
                  })}
                </button>
              </div>
            </label>

            {isPreviewing ? (
              <span className="form-dialog-description relink-directory-status">
                <Loader2 className="spin" size={12} />
                {t("sidebar.migrateDirectoryPreviewLoading", {
                  defaultValue: "Preparing the migration preview…",
                })}
              </span>
            ) : preview ? (
              <span className="form-dialog-description relink-directory-preview">
                {formatCounts(preview, (values) =>
                  t("sidebar.relinkDirectoryPreview", {
                    defaultValue:
                      "Will move {{conversations}} conversation(s), {{memories}} memory entries, {{memos}} memo(s) and {{tasks}} scheduled task(s) to the new location.",
                    values,
                  }),
                )}
                {preview.merged
                  ? ` ${t("sidebar.relinkDirectoryMerged", {
                      defaultValue:
                        "An existing record for this location will be merged.",
                    })}`
                  : ""}
                {preview.codebaseReindexRequired
                  ? ` ${t("sidebar.relinkDirectoryReindex", {
                      defaultValue:
                        "The codebase index will be cleared and can be rebuilt afterwards.",
                    })}`
                  : ""}
              </span>
            ) : null}

            <div className="migrate-directory-actions">
              <button
                className="form-dialog-button confirm"
                disabled={
                  !selectedPath.trim() ||
                  isPreviewing ||
                  !preview ||
                  isSubmitting ||
                  isUndoing
                }
                onClick={handleMigrate}
                type="button"
              >
                {isSubmitting ? (
                  <span className="form-dialog-spinner" />
                ) : null}
                {t("sidebar.migrateDirectoryConfirm", {
                  defaultValue: "Migrate",
                })}
              </button>
            </div>
          </div>
        ) : null}

        <div className="migrate-directory-section">
          <span className="form-dialog-label migrate-directory-history-label">
            {t("sidebar.relinkHistoryTitle", {
              defaultValue: "Relocation history",
            })}
          </span>
          {isLoading ? (
            <span className="form-dialog-description relink-directory-status">
              <Loader2 className="spin" size={12} />
              {t("sidebar.relinkHistoryLoading", {
                defaultValue: "Loading relocation history",
              })}
            </span>
          ) : records.length === 0 ? (
            <span className="form-dialog-description">
              {t("sidebar.relinkHistoryEmpty", {
                defaultValue:
                  "This project has not been relocated. Records appear here after you move a project to a new folder.",
              })}
            </span>
          ) : (
            <div className="relink-history-list">
              {records.map((record) => (
                <div className="relink-history-item" key={record.relinkId}>
                  <span className="relink-history-item-head">
                    <History size={12} />
                    <span className="relink-history-item-time">
                      {record.createdAt}
                    </span>
                    {record.undoneAt ? (
                      <span className="relink-history-item-undone">
                        {t("sidebar.relinkHistoryUndone", {
                          defaultValue: "Undone",
                        })}
                      </span>
                    ) : (
                      <button
                        className="relink-history-item-action"
                        disabled={isUndoing || isSubmitting}
                        onClick={() => setUndoTarget(record)}
                        type="button"
                      >
                        <RotateCcw size={11} />
                        {t("sidebar.relinkHistoryUndo", {
                          defaultValue: "Undo",
                        })}
                      </button>
                    )}
                  </span>
                  <span
                    className="relink-history-item-paths"
                    title={record.newPath}
                  >
                    <span className="relink-history-item-path">
                      {record.oldPath}
                    </span>
                    <ArrowRight size={11} />
                    <span className="relink-history-item-path">
                      {record.newPath}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
        {error ? <span className="form-dialog-error">{error}</span> : null}
      </FormDialog>
      <ConfirmDialog
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        confirmLabel={t("sidebar.relinkHistoryUndo", { defaultValue: "Undo" })}
        message={t("sidebar.relinkHistoryUndoConfirm", {
          defaultValue:
            "Undo this relocation? The project and its history move back to the previous location.",
        })}
        onCancel={() => setUndoTarget(null)}
        onConfirm={handleUndoConfirm}
        open={undoTarget !== null}
        title={t("sidebar.relinkHistoryTitle", {
          defaultValue: "Relocation history",
        })}
      />
    </>
  );
}
