import { useMemo, useState, type ReactNode } from "react";
import {
  AppWindow,
  Boxes,
  ChevronDown,
  ChevronRight,
  ChevronsDown,
  ChevronsUp,
  Cpu,
  List,
  MonitorCog,
  Network,
  Wrench,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import type { TaskManagerProcessKind } from "../../../preload";
import { useI18n } from "../../i18n";
import { formatDisplayPath } from "../../utils/formatDisplayPath";
import { DisplayPath } from "../common/DisplayPath";
import {
  buildProcessForest,
  flattenProcessForest,
  processIdentity,
  type TaskManagerRow,
} from "./taskManagerModel";
import {
  formatTaskBytes,
  formatTaskCpu,
  taskDisplayName,
} from "./taskManagerPresentation";

const KIND_LABEL_KEYS: Record<TaskManagerProcessKind, string> = {
  browser: "taskManager.kindBrowser",
  renderer: "taskManager.kindRenderer",
  gpu: "taskManager.kindGpu",
  utility: "taskManager.kindUtility",
  child: "taskManager.kindChild",
};
const KIND_ICONS: Record<TaskManagerProcessKind, LucideIcon> = {
  browser: Cpu,
  renderer: AppWindow,
  gpu: MonitorCog,
  utility: Wrench,
  child: Boxes,
};

type Props = {
  sortedRows: TaskManagerRow[];
  headers: ReactNode;
  stale: boolean;
  actionsDisabled: boolean;
  onKill: (process: TaskManagerRow) => void;
  onProject: (root: string) => void;
};

export function TaskManagerProcessTable({
  sortedRows,
  headers,
  stale,
  actionsDisabled,
  onKill,
  onProject,
}: Props): React.JSX.Element {
  const { t } = useI18n();
  const [view, setView] = useState<"list" | "tree">("list");
  // Identity, not PID alone: a reused PID does not inherit an old collapsed state.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const forest = useMemo(() => buildProcessForest(sortedRows), [sortedRows]);
  const collapsedPids = new Set(
    sortedRows
      .filter((row) => collapsed.has(processIdentity(row)))
      .map((row) => row.pid),
  );
  const visible =
    view === "tree"
      ? flattenProcessForest(forest, collapsedPids)
      : sortedRows.map((process) => ({
          process,
          depth: 0,
          hasChildren: false,
        }));
  const toggle = (process: TaskManagerRow): void => {
    const key = processIdentity(process);
    setCollapsed((previous) => {
      const next = new Set(
        [...previous].filter((identity) =>
          sortedRows.some((row) => processIdentity(row) === identity),
        ),
      );
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  return (
    <>
      <div className="task-manager-tree-toolbar">
        <div
          className="task-manager-filters"
          role="group"
          aria-label={t("taskManager.viewMode")}
        >
          <button
            type="button"
            aria-pressed={view === "list"}
            onClick={() => setView("list")}
            className="task-manager-view-btn"
          >
            <List size={12} aria-hidden="true" />
            <span>{t("taskManager.listView")}</span>
          </button>
          <button
            type="button"
            aria-pressed={view === "tree"}
            onClick={() => setView("tree")}
            className="task-manager-view-btn"
          >
            <Network size={12} aria-hidden="true" />
            <span>{t("taskManager.treeView")}</span>
          </button>
        </div>
        {view === "tree" && (
          <div className="task-manager-tree-actions">
            <button
              type="button"
              className="task-manager-btn-sm"
              onClick={() => setCollapsed(new Set())}
            >
              <ChevronsDown size={11} aria-hidden="true" />
              <span>{t("taskManager.expandAll")}</span>
            </button>
            <button
              type="button"
              className="task-manager-btn-sm"
              onClick={() =>
                setCollapsed(
                  new Set(
                    sortedRows
                      .filter((row) => forest.children.has(row.pid))
                      .map(processIdentity),
                  ),
                )
              }
            >
              <ChevronsUp size={11} aria-hidden="true" />
              <span>{t("taskManager.collapseAll")}</span>
            </button>
          </div>
        )}
      </div>
      {view === "tree" && (
        <p className="task-manager-hint task-manager-accounting">
          {t("taskManager.treeHint")}
        </p>
      )}
      <div className={`task-manager-table-wrap${stale ? " is-stale" : ""}`}>
        <table
          className="task-manager-table"
          aria-label={t("taskManager.processTable")}
        >
          <thead>
            <tr>{headers}</tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr>
                <td colSpan={7} className="task-manager-empty-cell">
                  {t("taskManager.empty")}
                </td>
              </tr>
            )}
            {visible.map(({ process, depth, hasChildren }) => {
              const Icon = KIND_ICONS[process.kind];
              const expanded = !collapsedPids.has(process.pid);
              return (
                <tr key={process.pid} data-pid={process.pid} data-depth={depth}>
                  <td
                    className="task-manager-cell-name"
                    title={
                      process.exePath || process.url || taskDisplayName(process)
                    }
                  >
                    <div
                      className="task-manager-process-details"
                      style={{
                        paddingInlineStart:
                          view === "tree" ? Math.min(depth, 18) * 14 : 0,
                      }}
                    >
                      <span className="task-manager-name-main">
                        {view === "tree" &&
                          (hasChildren ? (
                            <button
                              type="button"
                              className="task-manager-tree-toggle"
                              aria-expanded={expanded}
                              aria-label={t(
                                expanded
                                  ? "taskManager.collapseProcess"
                                  : "taskManager.expandProcess",
                                {
                                  values: {
                                    name: taskDisplayName(process),
                                    pid: process.pid,
                                  },
                                },
                              )}
                              onClick={() => toggle(process)}
                            >
                              {expanded ? (
                                <ChevronDown size={12} aria-hidden="true" />
                              ) : (
                                <ChevronRight size={12} aria-hidden="true" />
                              )}
                            </button>
                          ) : (
                            <span
                              className="task-manager-tree-spacer"
                              aria-hidden="true"
                            />
                          ))}
                        {process.iconDataUrl ? (
                          <img
                            className="task-manager-process-icon"
                            src={process.iconDataUrl}
                            alt=""
                            aria-hidden="true"
                          />
                        ) : (
                          <Icon
                            size={14}
                            strokeWidth={1.7}
                            className="task-manager-process-icon"
                            aria-hidden="true"
                          />
                        )}
                        <span className="task-manager-name-text">
                          {taskDisplayName(process)}
                        </span>
                        {process.lspSession && (
                          <span className="task-manager-badge">
                            LSP · {process.lspSession.lang}
                          </span>
                        )}
                      </span>
                      {process.title && process.name && (
                        <span className="task-manager-name-sub">
                          {process.name}
                        </span>
                      )}
                      {process.lspSession && (
                        <button
                          type="button"
                          className="task-manager-project task-manager-project-link"
                          title={formatDisplayPath(
                            process.lspSession.projectRoot,
                          )}
                          aria-label={t("taskManager.filterProject", {
                            values: {
                              project: formatDisplayPath(
                                process.lspSession.projectRoot,
                              ),
                            },
                          })}
                          onClick={() =>
                            onProject(process.lspSession!.projectRoot)
                          }
                        >
                          <DisplayPath path={process.lspSession.projectRoot} />
                        </button>
                      )}
                      <span className="task-manager-name-sub">
                        {t("taskManager.parentPid", {
                          values: { pid: process.parentPid },
                        })}
                        {process.lspRootPid != null &&
                          ` · ${t(process.pid === process.lspRootPid ? "taskManager.sessionRoot" : "taskManager.sessionChild", { values: { pid: process.lspRootPid } })}`}
                      </span>
                    </div>
                  </td>
                  <td className="task-manager-cell-kind">
                    <span
                      className={`task-manager-kind-tag is-${process.kind}`}
                    >
                      {t(KIND_LABEL_KEYS[process.kind])}
                    </span>
                  </td>
                  <td className="task-manager-cell-num">{process.pid}</td>
                  <td className="task-manager-cell-num task-manager-cell-cpu">
                    <span className="task-manager-num-val">
                      {formatTaskCpu(process.cpuPercent)}
                    </span>
                    {process.cpuPercent > 0 && (
                      <span
                        className="task-manager-mini-bar is-cpu"
                        style={{
                          width: `${Math.min(100, Math.max(6, process.cpuPercent))}%`,
                        }}
                      />
                    )}
                  </td>
                  <td className="task-manager-cell-num task-manager-cell-mem">
                    <span className="task-manager-num-val">
                      {formatTaskBytes(process.memoryBytes)}
                    </span>
                  </td>
                  <td className="task-manager-cell-num">
                    {process.threadCount}
                  </td>
                  <td className="task-manager-cell-actions">
                    {process.killable && (
                      <button
                        type="button"
                        className="task-manager-kill-btn"
                        disabled={stale || actionsDisabled}
                        onClick={() => onKill(process)}
                        title={t("taskManager.endProcess")}
                        aria-label={t("taskManager.endNamedProcess", {
                          values: {
                            name: taskDisplayName(process),
                            pid: process.pid,
                          },
                        })}
                      >
                        <XCircle
                          size={13}
                          strokeWidth={1.8}
                          aria-hidden="true"
                        />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
