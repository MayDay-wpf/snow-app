import { FolderX, LoaderCircle, RefreshCw, Server, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "../../i18n";
import { ApiSettingsHintIcon } from "./apiSettings/ApiSettingsFieldLabel";
import { AutoDismissNotice } from "../AutoDismissNotice";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { scheduledTasksStore } from "../../hooks/scheduledTasksStore";
import type {
  OrphanProjectCategoryId,
  OrphanProjectCategoryStats,
  OrphanProjectDeleteTarget,
  OrphanProjectGroup,
  OrphanProjectScanResult,
} from "../../../preload";

/** 分类展示顺序（与 Rust 侧 orphan_projects 一致） */
const ORPHAN_CATEGORY_IDS: OrphanProjectCategoryId[] = [
  "conversations",
  "archives",
  "snapshots",
  "memories",
  "memos",
  "scheduledTasks",
  "reviews",
  "metadata",
];

const CATEGORY_LABEL_KEYS: Record<
  OrphanProjectCategoryId,
  { key: string; fallback: string }
> = {
  conversations: { key: "settings.orphanCatConversations", fallback: "Chats" },
  archives: { key: "settings.orphanCatArchives", fallback: "Archived" },
  snapshots: { key: "settings.orphanCatSnapshots", fallback: "Snapshots" },
  memories: { key: "settings.orphanCatMemories", fallback: "Memories" },
  memos: { key: "settings.orphanCatMemos", fallback: "Memos" },
  scheduledTasks: {
    key: "settings.orphanCatScheduledTasks",
    fallback: "Scheduled tasks",
  },
  reviews: { key: "settings.orphanCatReviews", fallback: "Review notes" },
  metadata: { key: "settings.orphanCatMetadata", fallback: "Metadata" },
};

type Selection = Record<string, OrphanProjectCategoryId[]>;

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

/** 项目下有数据的分类（按展示顺序） */
const availableCategories = (
  project: OrphanProjectGroup,
): OrphanProjectCategoryStats[] =>
  ORPHAN_CATEGORY_IDS.flatMap((id) => {
    const stats = project.categories.find((item) => item.id === id);
    return stats && stats.count > 0 ? [stats] : [];
  });

type OrphanProjectCleanupSectionProps = {
  /** 嵌入存储卡片内时隐藏自带标题与说明（标题由卡片行提供） */
  embedded?: boolean;
};

/** 设置 → 存储与资源：扫描并清理已移除项目残留的数据。 */
export function OrphanProjectCleanupSection({
  embedded = false,
}: OrphanProjectCleanupSectionProps): React.JSX.Element {
  const { t } = useI18n();
  const [scan, setScan] = useState<OrphanProjectScanResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [selection, setSelection] = useState<Selection>({});
  const [pendingDelete, setPendingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState<{
    message: string;
    tone: "success" | "error";
  } | null>(null);

  const runScan = useCallback(async (): Promise<void> => {
    setScanning(true);
    try {
      const result = await window.snow.scanOrphanProjects();
      setScan(result);
      // 只保留仍有数据的勾选
      setSelection((prev) => {
        const next: Selection = {};
        for (const project of result.projects) {
          const available = availableCategories(project).map((c) => c.id);
          const kept = (prev[project.directoryId] ?? []).filter((id) =>
            available.includes(id),
          );
          if (kept.length > 0) {
            next[project.directoryId] = kept;
          }
        }
        return next;
      });
    } catch (error) {
      setNotice({
        message: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    void runScan();
  }, [runScan]);

  const projects = scan?.projects ?? [];
  const busy = scanning || deleting;

  const toggleCategory = (
    directoryId: string,
    id: OrphanProjectCategoryId,
  ): void => {
    setSelection((prev) => {
      const current = prev[directoryId] ?? [];
      const nextIds = current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id];
      const next = { ...prev };
      if (nextIds.length > 0) {
        next[directoryId] = nextIds;
      } else {
        delete next[directoryId];
      }
      return next;
    });
  };

  const toggleProject = (project: OrphanProjectGroup): void => {
    const available = availableCategories(project).map((c) => c.id);
    setSelection((prev) => {
      const next = { ...prev };
      const current = prev[project.directoryId] ?? [];
      if (current.length === available.length) {
        delete next[project.directoryId];
      } else {
        next[project.directoryId] = available;
      }
      return next;
    });
  };

  const allSelected =
    projects.length > 0 &&
    projects.every(
      (project) =>
        (selection[project.directoryId]?.length ?? 0) ===
        availableCategories(project).length,
    );

  const toggleSelectAll = (): void => {
    if (allSelected) {
      setSelection({});
      return;
    }
    const next: Selection = {};
    for (const project of projects) {
      next[project.directoryId] = availableCategories(project).map((c) => c.id);
    }
    setSelection(next);
  };

  /** 本次勾选汇总：项目数 / 条目数 / 快照占用 */
  const plan = useMemo(() => {
    let projectCount = 0;
    let items = 0;
    let bytes = 0;
    for (const project of projects) {
      const selected = selection[project.directoryId] ?? [];
      if (selected.length === 0) {
        continue;
      }
      projectCount += 1;
      for (const stats of project.categories) {
        if (selected.includes(stats.id)) {
          items += stats.count;
          bytes += stats.bytes;
        }
      }
    }
    return { projectCount, items, bytes };
  }, [projects, selection]);

  const totalBytes = projects.reduce(
    (sum, project) =>
      sum + project.categories.reduce((acc, item) => acc + item.bytes, 0),
    0,
  );

  const confirmDelete = async (): Promise<void> => {
    const targets: OrphanProjectDeleteTarget[] = Object.entries(selection)
      .filter(([, categories]) => categories.length > 0)
      .map(([directoryId, categories]) => ({ directoryId, categories }));
    if (targets.length === 0 || deleting) {
      return;
    }
    setPendingDelete(false);
    setDeleting(true);
    try {
      const result = await window.snow.deleteOrphanProjectData(targets);
      // 定时任务由渲染层调度器常驻内存，删除后同步移除
      for (const target of targets) {
        if (target.categories.includes("scheduledTasks")) {
          scheduledTasksStore.clear(target.directoryId);
        }
      }
      setSelection({});
      setNotice({
        tone: result.errors.length > 0 ? "error" : "success",
        message:
          result.errors.length > 0
            ? t("settings.orphanDoneWithErrors", {
                values: {
                  items: result.deletedItems,
                  size: formatBytes(result.deletedBytes),
                  errors: result.errors.length,
                },
                defaultValue: `Removed ${result.deletedItems} item(s), freed ${formatBytes(result.deletedBytes)}; ${result.errors.length} failed`,
              })
            : t("settings.orphanDone", {
                values: {
                  items: result.deletedItems,
                  size: formatBytes(result.deletedBytes),
                },
                defaultValue: `Removed ${result.deletedItems} item(s), freed ${formatBytes(result.deletedBytes)}`,
              }),
      });
      await runScan();
    } catch (error) {
      setNotice({
        message: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    } finally {
      setDeleting(false);
    }
  };

  const categoryLabel = (id: OrphanProjectCategoryId): string =>
    t(CATEGORY_LABEL_KEYS[id].key, {
      defaultValue: CATEGORY_LABEL_KEYS[id].fallback,
    });

  /** 分类芯片上的数量文案 */
  const categoryCountText = (stats: OrphanProjectCategoryStats): string => {
    if (stats.id === "snapshots") {
      return `${stats.count} · ${formatBytes(stats.bytes)}`;
    }
    if (
      (stats.id === "conversations" || stats.id === "archives") &&
      stats.detailCount > 0
    ) {
      return t("settings.orphanConversationCount", {
        values: { count: stats.count, messages: stats.detailCount },
        defaultValue: `${stats.count} · ${stats.detailCount} msgs`,
      });
    }
    return String(stats.count);
  };

  const renderProject = (project: OrphanProjectGroup): React.JSX.Element => {
    const available = availableCategories(project);
    const selected = selection[project.directoryId] ?? [];
    const full = selected.length > 0 && selected.length === available.length;
    const partial = selected.length > 0 && !full;
    const Icon = project.kind === "ssh" ? Server : FolderX;
    const displayPath = project.path || project.directoryId;
    const meta = [
      project.lastActivityAt
        ? t("settings.orphanLastActive", {
            values: { time: project.lastActivityAt },
            defaultValue: `Last active ${project.lastActivityAt}`,
          })
        : "",
      project.sampleTitles.join(" / "),
    ]
      .filter(Boolean)
      .join(" · ");

    return (
      <div className="orphan-project-group" key={project.directoryId}>
        <div className="orphan-project-head">
          <label
            className={`cleanup-category-check${partial ? " partial" : ""}`}
            title={displayPath}
          >
            <input
              type="checkbox"
              checked={full}
              onChange={() => toggleProject(project)}
              disabled={busy}
            />
            <span className="cleanup-category-box" aria-hidden="true" />
          </label>
          <Icon
            size={14}
            strokeWidth={1.8}
            className="general-storage-icon"
            aria-hidden="true"
          />
          <div className="general-storage-text">
            <span className="orphan-project-path" title={project.directoryId}>
              {displayPath}
            </span>
            {meta && (
              <span className="settings-item-description orphan-project-meta">
                {meta}
              </span>
            )}
          </div>
        </div>
        <div className="orphan-project-categories">
          {available.map((stats) => (
            <label
              key={stats.id}
              className={`orphan-category-chip${
                selected.includes(stats.id) ? " active" : ""
              }`}
            >
              <span className="cleanup-category-check">
                <input
                  type="checkbox"
                  checked={selected.includes(stats.id)}
                  onChange={() => toggleCategory(project.directoryId, stats.id)}
                  disabled={busy}
                />
                <span className="cleanup-category-box" aria-hidden="true" />
              </span>
              <span className="orphan-category-name">
                {categoryLabel(stats.id)}
              </span>
              <span className="orphan-category-count">
                {categoryCountText(stats)}
              </span>
            </label>
          ))}
        </div>
      </div>
    );
  };

  const selectedCategoryCount = Object.values(selection).reduce(
    (sum, ids) => sum + ids.length,
    0,
  );

  return (
    <div
      className={
        embedded ? "storage-embedded-section" : "api-settings-manual-form"
      }
    >
      <AutoDismissNotice
        message={notice?.message ?? ""}
        tone={notice?.tone ?? "success"}
        durationMs={notice?.tone === "error" ? 4000 : 2500}
        onDismiss={() => setNotice(null)}
      />
      {!embedded && (
        <div className="api-settings-manual-header">
          <strong>
            {t("settings.orphanTitle", {
              defaultValue: "Removed project data",
            })}
            <ApiSettingsHintIcon
              hint={t("settings.orphanInfo", {
                defaultValue:
                  "Find chats, archives, snapshots and other data left behind by projects removed from the project list. Re-adding the same folder reconnects its data, so only delete what you no longer need.",
              })}
            />
          </strong>
          {scan !== null && projects.length > 0 ? (
            <span>
              {t("settings.orphanTotal", {
                values: {
                  count: projects.length,
                  size: formatBytes(totalBytes),
                },
                defaultValue: `${projects.length} project(s) · snapshots ${formatBytes(totalBytes)}`,
              })}
            </span>
          ) : null}
        </div>
      )}

      <div className="api-settings-form-body">
        {scan === null && scanning && (
          <div className="general-storage-row">
            <div className="general-storage-info">
              <LoaderCircle
                size={14}
                strokeWidth={1.8}
                className="general-storage-icon tool-call-icon-spinning"
                aria-hidden="true"
              />
              <span className="general-storage-label">
                {t("settings.cleanupScanning", { defaultValue: "Scanning..." })}
              </span>
            </div>
          </div>
        )}

        {scan !== null && projects.length === 0 && (
          <div className="general-storage-row">
            <span className="settings-item-description">
              {t("settings.orphanNone", {
                defaultValue: "No leftover data from removed projects.",
              })}
            </span>
          </div>
        )}

        {projects.map(renderProject)}

        {scan !== null && (
          <div className="general-storage-row">
            <div className="general-storage-info">
              <Trash2
                size={14}
                strokeWidth={1.8}
                className="general-storage-icon"
                aria-hidden="true"
              />
              <div className="general-storage-text">
                <span className="general-storage-label">
                  {t("settings.orphanSelected", {
                    values: {
                      projects: plan.projectCount,
                      categories: selectedCategoryCount,
                    },
                    defaultValue: `${plan.projectCount} project(s), ${selectedCategoryCount} category(ies) selected`,
                  })}
                  <ApiSettingsHintIcon
                    hint={t("settings.orphanSelectHint", {
                      defaultValue:
                        "Select projects or individual data types to delete.",
                    })}
                  />
                </span>
                {plan.items > 0 ? (
                  <span className="settings-item-description">
                    {t("settings.orphanWillDelete", {
                      values: {
                        items: plan.items,
                        size: formatBytes(plan.bytes),
                      },
                      defaultValue: `Will delete ${plan.items} item(s) and free ${formatBytes(plan.bytes)} of snapshots`,
                    })}
                  </span>
                ) : null}
              </div>
            </div>
            <div className="general-storage-actions">
              <button
                type="button"
                className="general-storage-action"
                onClick={toggleSelectAll}
                disabled={busy || projects.length === 0}
              >
                <span>
                  {allSelected
                    ? t("settings.cleanupSelectNone", {
                        defaultValue: "Clear selection",
                      })
                    : t("settings.cleanupSelectAll", {
                        defaultValue: "Select all",
                      })}
                </span>
              </button>
              <button
                type="button"
                className="general-storage-action danger"
                onClick={() => setPendingDelete(true)}
                disabled={busy || plan.items === 0}
              >
                {deleting ? (
                  <LoaderCircle
                    size={11}
                    strokeWidth={1.8}
                    className="tool-call-icon-spinning"
                    aria-hidden="true"
                  />
                ) : (
                  <Trash2 size={11} strokeWidth={1.8} aria-hidden="true" />
                )}
                <span>
                  {deleting
                    ? t("settings.cleanupDeleting", {
                        defaultValue: "Cleaning...",
                      })
                    : t("settings.cleanupDelete", {
                        defaultValue: "Delete selected",
                      })}
                </span>
              </button>
              <button
                type="button"
                className="general-storage-action"
                onClick={() => void runScan()}
                disabled={busy}
              >
                {scanning ? (
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
                  {t("settings.cleanupRescan", { defaultValue: "Rescan" })}
                </span>
              </button>
            </div>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={pendingDelete}
        variant="danger"
        title={t("settings.orphanConfirmTitle", {
          defaultValue: "Delete removed project data",
        })}
        message={t("settings.orphanConfirmMessage", {
          values: {
            projects: plan.projectCount,
            items: plan.items,
            size: formatBytes(plan.bytes),
          },
          defaultValue: `This permanently deletes ${plan.items} item(s) (snapshots ${formatBytes(plan.bytes)}) from ${plan.projectCount} removed project(s). This cannot be undone.`,
        })}
        confirmLabel={t("settings.cleanupConfirmBtn", {
          defaultValue: "Delete",
        })}
        cancelLabel={t("settings.cancel", { defaultValue: "Cancel" })}
        isConfirming={deleting}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(false)}
      />
    </div>
  );
}
