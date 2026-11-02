import { useEffect, useMemo, useRef, useState } from "react";
import { FileText, Search, Square, Terminal, Trash2, X } from "lucide-react";
import { useI18n } from "../../i18n";
import { formatDisplayPath } from "../../utils/formatDisplayPath";
import type { DetachedTaskInfo } from "../../../preload";

/** 徽章定位请求：nonce 区分同一任务的重复点击 */
export type BackgroundTaskFocus = {
  taskId: string;
  pid: number;
  nonce: number;
};

type Props = {
  tasks: DetachedTaskInfo[];
  /** 至少完成过一次采样，用于区分「还没有数据」与「任务不存在」 */
  loaded: boolean;
  stale: boolean;
  now: number;
  /**
   * 一次性定位请求：仅由 bash 卡片徽章触发，父层短暂保留后清空。
   * 切 Tab / 重开面板时拿到的就是 null，不会再高亮。
   */
  focus: BackgroundTaskFocus | null;
  actionsDisabled: boolean;
  onKill: (task: DetachedTaskInfo) => void;
  onForget: (task: DetachedTaskInfo) => void;
  onOpenLog: (task: DetachedTaskInfo) => void;
};

const formatUptime = (task: DetachedTaskInfo, now: number): string => {
  const started = Date.parse(task.startedAt);
  if (!Number.isFinite(started)) {
    return "—";
  }
  // 已退出的任务按退出时刻定格，避免时长继续累加
  const ended = task.alive ? now : Date.parse(task.endedAt ?? "");
  if (!Number.isFinite(ended)) {
    return "—";
  }
  const total = Math.max(0, Math.floor((ended - started) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }
  return `${seconds}s`;
};

const commandSummary = (command: string): string =>
  command.trim().split(/\r?\n/, 1)[0] ?? "";

const matchesFocus = (
  task: DetachedTaskInfo,
  focus: BackgroundTaskFocus,
): boolean =>
  focus.taskId
    ? task.id === focus.taskId
    : task.pid > 0 && task.pid === focus.pid;

export function TaskManagerBackgroundTasks({
  tasks,
  loaded,
  stale,
  now,
  focus,
  actionsDisabled,
  onKill,
  onForget,
  onOpenLog,
}: Props): React.JSX.Element {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const locatedRowRef = useRef<HTMLLIElement | null>(null);
  // 定位请求会清空搜索，避免目标行被上一次的筛选条件挡住。
  useEffect(() => {
    if (focus) {
      setQuery("");
    }
  }, [focus]);
  const rows = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return [...tasks]
      .filter(
        (task) =>
          !search ||
          [
            task.command,
            task.description,
            task.workingDirectory,
            formatDisplayPath(task.workingDirectory),
            task.pid,
            task.logPath,
          ]
            .join(" ")
            .toLocaleLowerCase()
            .includes(search),
      )
      .sort(
        (left, right) =>
          Number(right.alive) - Number(left.alive) ||
          right.startedAt.localeCompare(left.startedAt),
      );
  }, [tasks, query]);
  const locatedId = useMemo(
    () =>
      focus
        ? (rows.find((task) => matchesFocus(task, focus))?.id ?? null)
        : null,
    [rows, focus],
  );
  useEffect(() => {
    if (locatedId) {
      locatedRowRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [locatedId]);
  const focusTarget = focus;
  const focusMissing =
    focusTarget !== null &&
    loaded &&
    !tasks.some((task) => matchesFocus(task, focusTarget));
  const aliveCount = tasks.filter((task) => task.alive).length;

  return (
    <div className="task-manager-tab-content">
      <div className="task-manager-toolbar">
        <label className="task-manager-search">
          <Search size={13} aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("taskManager.backgroundSearch")}
            aria-label={t("taskManager.backgroundSearch")}
          />
          {query && (
            <button
              type="button"
              className="task-manager-clear-btn"
              onClick={() => setQuery("")}
            >
              <X size={11} aria-hidden="true" />
            </button>
          )}
        </label>
        <span className="task-manager-background-count">
          {t("taskManager.backgroundSummary", {
            values: { running: aliveCount, total: tasks.length },
          })}
        </span>
      </div>

      {focusMissing && (
        <div className="task-manager-notice task-manager-warning" role="status">
          {t("taskManager.backgroundFocusMissing")}
        </div>
      )}

      {rows.length === 0 ? (
        <div className="task-manager-background-empty">
          <Terminal size={16} aria-hidden="true" />
          <span>{t("taskManager.backgroundEmpty")}</span>
        </div>
      ) : (
        <ul
          className={`task-manager-background-list ${stale ? "is-stale" : ""}`}
        >
          {rows.map((task) => {
            const isLocated = task.id === locatedId;
            return (
              <li
                key={task.id}
                ref={isLocated ? locatedRowRef : undefined}
                className={`task-manager-background-item ${
                  task.alive ? "is-running" : "is-exited"
                } ${isLocated ? "is-located" : ""}`}
              >
                <div className="task-manager-background-head">
                  <span className="task-manager-background-icon">
                    <Terminal size={13} aria-hidden="true" />
                  </span>
                  <div className="task-manager-background-main">
                    <span
                      className="task-manager-background-name"
                      title={task.description || commandSummary(task.command)}
                    >
                      {task.description || commandSummary(task.command)}
                    </span>
                    <code className="task-manager-background-command">
                      {task.command}
                    </code>
                  </div>
                  <span
                    className={`task-manager-background-status ${
                      task.alive ? "is-running" : "is-exited"
                    }`}
                  >
                    {task.alive
                      ? t("taskManager.session.running")
                      : t("taskManager.session.exited")}
                  </span>
                </div>

                <div className="task-manager-background-meta">
                  <span className="task-manager-background-pid">
                    PID {task.pid}
                  </span>
                  <span>
                    {t("taskManager.backgroundUptime")}{" "}
                    {formatUptime(task, now)}
                  </span>
                  <span
                    className="task-manager-background-workdir"
                    title={task.workingDirectory}
                  >
                    {formatDisplayPath(task.workingDirectory)}
                  </span>
                </div>

                <div className="task-manager-background-actions">
                  <button
                    type="button"
                    className="task-manager-background-action"
                    onClick={() => onOpenLog(task)}
                    title={task.logPath}
                  >
                    <FileText size={11} aria-hidden="true" />
                    {t("taskManager.backgroundLog")}
                  </button>
                  {task.alive ? (
                    <button
                      type="button"
                      className="task-manager-background-action is-danger"
                      disabled={actionsDisabled}
                      onClick={() => onKill(task)}
                    >
                      <Square size={11} aria-hidden="true" />
                      {t("taskManager.endProcess")}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="task-manager-background-action"
                      disabled={actionsDisabled}
                      onClick={() => onForget(task)}
                    >
                      <Trash2 size={11} aria-hidden="true" />
                      {t("taskManager.backgroundForget")}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
