import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Bell,
  Boxes,
  Cpu,
  Layers,
  Loader2,
  MemoryStick,
  RefreshCw,
  Search,
  Terminal,
  X,
} from "lucide-react";
import { useI18n } from "../../i18n";
import { formatDisplayPath } from "../../utils/formatDisplayPath";
import { CustomSelect, type CustomSelectOption } from "../common/CustomSelect";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { OverlayScrollbar } from "../common/OverlayScrollbar";
import { LspResourcePanel } from "../sidebar/lspSettings/LspResourcePanel";
import type { DetachedTaskInfo, TaskManagerProcess } from "../../../preload";
import {
  associateLspProcesses,
  captureSessions,
  filterTaskProcesses,
  LSP_REFRESH_INTERVAL_MS,
  normalizeTaskProject,
  processIdentity,
  reconcileSessionRoots,
  SNAPSHOT_FRESHNESS_MS,
  summarizeProcesses,
  uniqueProcesses,
  type SessionSnapshot,
  type TaskManagerRow,
} from "./taskManagerModel";
import {
  MiniSparkline,
  TaskManagerPerformancePanel,
  useUsageTrend,
} from "./TaskManagerTrend";
import { TaskManagerProcessTable } from "./TaskManagerProcessTable";
import { TaskManagerSessions } from "./TaskManagerSessions";
import {
  TaskManagerBackgroundTasks,
  type BackgroundTaskFocus,
} from "./TaskManagerBackgroundTasks";
import { rightPanelEvents } from "./rightPanelEvents";
import {
  TaskManagerAlerts,
  alertTriggeredText,
  useUsageAlerts,
} from "./TaskManagerAlerts";
import { TaskManagerSamplingLog } from "./TaskManagerSamplingLog";
import {
  CONTINUOUS_SAMPLE_GAP_MS,
  TREND_WINDOW_MS,
  type AlertOptions,
  type SampleStamp,
} from "./taskManagerMonitoring";
import {
  formatTaskBytes,
  formatTaskTotalCpu,
  taskDisplayName,
  taskProjectName,
} from "./taskManagerPresentation";

const REFRESH_INTERVAL_MS = 1000;

/** 后台任务显示名：优先用命令说明，回退到命令首行。 */
const backgroundTaskLabel = (task: DetachedTaskInfo): string =>
  task.description ||
  task.command.trim().split(/\r?\n/, 1)[0] ||
  `PID ${task.pid}`;

type SortField = "name" | "kind" | "pid" | "cpu" | "memory" | "threads";
type SortDirection = "asc" | "desc";
type TaskManagerTab =
  "processes" | "background" | "performance" | "sessions" | "alerts";

/** One process sampler serves rows, scoped trends and optional inline alerts. */
export const TaskManagerContent = ({
  isActive,
  focusRequest,
}: {
  isActive: boolean;
  /** 从 bash 卡片徽章跳转过来的后台任务定位请求（nonce 变化即重新定位） */
  focusRequest?: BackgroundTaskFocus | null;
}): React.JSX.Element => {
  const { t, locale } = useI18n();
  const [processes, setProcesses] = useState<TaskManagerProcess[]>([]);
  const [sessionSnapshot, setSessionSnapshot] =
    useState<SessionSnapshot | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [lspError, setLspError] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [hidden, setHidden] = useState(document.hidden);
  const [sampledAtMs, setSampledAtMs] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [stamp, setStamp] = useState<SampleStamp | null>(null);
  const [continuity, setContinuity] = useState(0);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "lsp">("all");
  const [project, setProject] = useState("");
  const [activeTab, setActiveTab] = useState<TaskManagerTab>("processes");
  const [sortField, setSortField] = useState<SortField>("memory");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [pendingKill, setPendingKill] = useState<TaskManagerProcess | null>(
    null,
  );
  const [isKilling, setIsKilling] = useState(false);
  const [sessionBusy, setSessionBusy] = useState(false);
  const [killError, setKillError] = useState<string | null>(null);
  // detach 后台任务：列表 + 结束确认（与进程「结束进程」互不影响）
  const [backgroundTasks, setBackgroundTasks] = useState<DetachedTaskInfo[]>(
    [],
  );
  const [backgroundSampledAtMs, setBackgroundSampledAtMs] = useState(0);
  const [backgroundError, setBackgroundError] = useState(false);
  const [pendingTaskKill, setPendingTaskKill] =
    useState<DetachedTaskInfo | null>(null);
  const [isTaskKilling, setIsTaskKilling] = useState(false);
  const [taskKillError, setTaskKillError] = useState<string | null>(null);
  // 移除记录会连日志一起删除，必须二次确认
  const [pendingTaskForget, setPendingTaskForget] =
    useState<DetachedTaskInfo | null>(null);
  const [isTaskForgetting, setIsTaskForgetting] = useState(false);
  const [taskForgetError, setTaskForgetError] = useState<string | null>(null);
  const inFlightRef = useRef(false);
  const forceQueuedRef = useRef(false);
  const refreshWaitersRef = useRef<Array<() => void>>([]);
  const refreshRef = useRef<((force?: boolean) => Promise<void>) | null>(null);
  const lastLspAttemptRef = useRef(0);
  const mountedRef = useRef(false);
  const activeRef = useRef(isActive);
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const sampledRef = useRef(0);
  const sequenceRef = useRef(0);
  const continuityRef = useRef(0);
  const scopeKey = JSON.stringify([
    query.trim().toLocaleLowerCase(),
    filter,
    project,
  ]);
  const scopeRef = useRef(scopeKey);
  scopeRef.current = scopeKey;
  activeRef.current = isActive;
  const breakSampling = useCallback((): void => {
    continuityRef.current += 1;
    setContinuity(continuityRef.current);
  }, []);

  const refresh = useCallback(
    async (forceLsp = false): Promise<void> => {
      if (!activeRef.current || document.hidden) return;
      if (inFlightRef.current) {
        if (!forceLsp) return;
        forceQueuedRef.current = true;
        return new Promise<void>((resolve) =>
          refreshWaitersRef.current.push(resolve),
        );
      }
      inFlightRef.current = true;
      const requestScope = scopeRef.current;
      const requestContinuity = continuityRef.current;
      const fetchLsp =
        forceLsp ||
        Date.now() - lastLspAttemptRef.current >= LSP_REFRESH_INTERVAL_MS;
      if (fetchLsp) lastLspAttemptRef.current = Date.now();
      try {
        const [processResult, sessionResult, taskResult] =
          await Promise.allSettled([
            window.snow
              .getProcessSnapshot()
              .then((value) => ({ value, receivedAtMs: Date.now() })),
            fetchLsp
              ? window.snow
                  .listLspSessionStatuses()
                  .then((value) => ({ value, receivedAtMs: Date.now() }))
              : Promise.resolve(null),
            window.snow
              .listDetachedTasks()
              .then((value) => ({ value, receivedAtMs: Date.now() })),
          ]);
        if (!mountedRef.current) return;
        const snapshot =
          processResult.status === "fulfilled"
            ? uniqueProcesses(processResult.value.value)
            : null;
        if (snapshot && processResult.status === "fulfilled") {
          setProcesses(snapshot);
          sampledRef.current = processResult.value.receivedAtMs;
          setSampledAtMs(processResult.value.receivedAtMs);
          setHasError(false);
          sequenceRef.current += 1;
          setStamp({
            id: sequenceRef.current,
            atMs: processResult.value.receivedAtMs,
            scopeKey: requestScope,
            continuity: requestContinuity,
          });
        } else {
          setHasError(true);
          breakSampling();
        }
        if (fetchLsp) {
          if (
            sessionResult.status === "fulfilled" &&
            sessionResult.value !== null
          ) {
            setSessionSnapshot(
              captureSessions(
                sessionResult.value.value,
                snapshot ?? [],
                sessionResult.value.receivedAtMs,
              ),
            );
            setLspError(false);
          } else {
            setLspError(true);
            if (snapshot)
              setSessionSnapshot((previous) =>
                previous ? reconcileSessionRoots(previous, snapshot) : null,
              );
          }
        } else if (snapshot) {
          setSessionSnapshot((previous) =>
            previous ? reconcileSessionRoots(previous, snapshot) : null,
          );
        }
        if (taskResult.status === "fulfilled") {
          setBackgroundTasks(taskResult.value.value);
          setBackgroundSampledAtMs(taskResult.value.receivedAtMs);
          setBackgroundError(false);
        } else {
          setBackgroundError(true);
        }
        setNow(Date.now());
      } finally {
        inFlightRef.current = false;
        if (mountedRef.current) setIsLoading(false);
        const queued = forceQueuedRef.current;
        forceQueuedRef.current = false;
        const waiters = refreshWaitersRef.current.splice(0);
        if (
          queued &&
          mountedRef.current &&
          activeRef.current &&
          !document.hidden
        ) {
          void refreshRef
            .current?.(true)
            .finally(() => waiters.forEach((resolve) => resolve()));
        } else waiters.forEach((resolve) => resolve());
      }
    },
    [breakSampling],
  );
  refreshRef.current = refresh;
  const forceRefresh = useCallback(() => refresh(true), [refresh]);

  useEffect(() => {
    mountedRef.current = true;
    const onVisibility = (): void => {
      setHidden(document.hidden);
      setNow(Date.now());
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      mountedRef.current = false;
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
  useEffect(() => {
    breakSampling();
  }, [scopeKey, breakSampling]);
  // 窄面板下标签栏横向滚动，切换标签后保证当前项处于可见范围
  useEffect(() => {
    const active = tabsRef.current?.querySelector<HTMLElement>(
      ".task-manager-tab-btn.is-active",
    );
    active?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTab]);
  // bash 卡片徽章跳转：切到「后台任务」页，具体定位由列表组件按 focus 处理。
  useEffect(() => {
    if (focusRequest) {
      setActiveTab("background");
    }
  }, [focusRequest]);
  useEffect(() => {
    breakSampling();
    if (!isActive || hidden) return;
    setNow(Date.now());
    if (!autoRefresh) {
      if (!sampledRef.current) void refresh(true);
      return;
    }
    void refresh(true);
    const timer = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [isActive, hidden, autoRefresh, refresh, breakSampling]);
  // Finite expiry events only: age retained data during pauses/slow requests without fetching.
  useEffect(() => {
    if (!isActive || hidden) return;
    const currentTime = Date.now();
    const samples = [
      sampledAtMs,
      sessionSnapshot?.receivedAtMs ?? 0,
      ...(sessionSnapshot?.sessions.map(
        (session) => session.resources?.sampledAtMs ?? 0,
      ) ?? []),
    ];
    const expiries = samples.flatMap((sample) => [
      sample + SNAPSHOT_FRESHNESS_MS + 1,
      sample + TREND_WINDOW_MS + 1,
    ]);
    expiries.push(sampledAtMs + CONTINUOUS_SAMPLE_GAP_MS + 1);
    const next = expiries.filter((expiry) => expiry > currentTime);
    if (!next.length) return;
    const timer = window.setTimeout(
      () => setNow(Date.now()),
      Math.min(...next) - currentTime,
    );
    return () => window.clearTimeout(timer);
  }, [isActive, hidden, sampledAtMs, sessionSnapshot, now]);

  const processStale =
    hasError || !sampledAtMs || now - sampledAtMs > SNAPSHOT_FRESHNESS_MS;
  const sessionsStale =
    lspError ||
    !sessionSnapshot ||
    now - sessionSnapshot.receivedAtMs > SNAPSHOT_FRESHNESS_MS;
  const rows = useMemo(
    () =>
      associateLspProcesses(
        processes,
        sessionSnapshot,
        now,
        processStale || sessionsStale,
      ),
    [processes, sessionSnapshot, now, processStale, sessionsStale],
  );
  const visibleRows = useMemo(
    () => filterTaskProcesses(rows, { query, kind: filter, project }),
    [rows, query, filter, project],
  );
  const summary = useMemo(() => summarizeProcesses(visibleRows), [visibleRows]);
  const scopeKnown =
    !processStale &&
    (!(filter === "lsp" || project || query.trim()) || !sessionsStale);
  const usageSamples = useUsageTrend({
    stamp,
    scopeKey,
    summary,
    scopeKnown,
    continuity,
    now,
  });
  const alertSamplingActive = isActive && !hidden && autoRefresh;
  const alertValid = scopeKnown && !hasError;
  const notifyAlertTriggered = useCallback(
    (metric: "cpu" | "memory", rule: AlertOptions) => {
      void window.snow.showNotification({
        title: t("taskManager.alertNotifyTitle"),
        body: alertTriggeredText(t, metric, rule),
        ignoreFocus: true,
      });
    },
    [t],
  );
  const {
    options: alertOptions,
    setOptions: setAlertOptions,
    alerts: usageAlerts,
    dismiss: dismissAlert,
  } = useUsageAlerts({
    samples: usageSamples,
    scopeKey,
    continuity,
    samplingActive: alertSamplingActive,
    valid: alertValid,
    onTriggered: notifyAlertTriggered,
  });
  const groups = useMemo(() => {
    const grouped = new Map<
      NonNullable<TaskManagerRow["lspSession"]>,
      TaskManagerRow[]
    >();
    for (const row of visibleRows) {
      if (!row.lspSession) continue;
      const group = grouped.get(row.lspSession) ?? [];
      group.push(row);
      grouped.set(row.lspSession, group);
    }
    return grouped;
  }, [visibleRows]);
  const search = query.trim().toLocaleLowerCase();
  const sessions = (sessionSnapshot?.sessions ?? []).filter(
    (session) =>
      (!project || normalizeTaskProject(session.projectRoot) === project) &&
      (!search ||
        groups.has(session) ||
        [
          session.lang,
          session.projectRoot,
          formatDisplayPath(session.projectRoot),
          session.resources?.pid,
        ]
          .join(" ")
          .toLocaleLowerCase()
          .includes(search)),
  );
  const projects = useMemo(() => {
    const roots = new Map<string, string>();
    for (const session of sessionSnapshot?.sessions ?? [])
      roots.set(normalizeTaskProject(session.projectRoot), session.projectRoot);
    return [...roots.entries()].sort((left, right) =>
      left[1].localeCompare(right[1]),
    );
  }, [sessionSnapshot]);
  const selectProject = useCallback(
    (root: string): void => setProject(normalizeTaskProject(root)),
    [],
  );
  const projectOptions = useMemo<CustomSelectOption[]>(() => {
    const options: CustomSelectOption[] = [
      { value: "", label: t("taskManager.allProjects") },
    ];
    if (project && !projects.some(([key]) => key === project))
      options.push({ value: project, label: project });
    for (const [key, root] of projects)
      options.push({
        value: key,
        label: `${taskProjectName(root)} · ${formatDisplayPath(root)}`,
      });
    return options;
  }, [project, projects, t]);
  const sortedProcesses = useMemo(() => {
    const factor = sortDirection === "asc" ? 1 : -1;
    return [...visibleRows].sort((left, right) => {
      let compared = 0;
      switch (sortField) {
        case "name":
          compared = taskDisplayName(left).localeCompare(
            taskDisplayName(right),
          );
          break;
        case "kind":
          compared = left.kind.localeCompare(right.kind);
          break;
        case "pid":
          compared = left.pid - right.pid;
          break;
        case "cpu":
          compared = left.cpuPercent - right.cpuPercent;
          break;
        case "threads":
          compared = left.threadCount - right.threadCount;
          break;
        default:
          compared = left.memoryBytes - right.memoryBytes;
      }
      return compared * factor || left.pid - right.pid;
    });
  }, [visibleRows, sortField, sortDirection]);
  const handleSort = (field: SortField): void => {
    if (field === sortField)
      setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
    else {
      setSortField(field);
      setSortDirection(field === "name" || field === "kind" ? "asc" : "desc");
    }
  };
  const killLockRef = useRef(false);
  const handleConfirmKill = async (): Promise<void> => {
    if (!pendingKill || killLockRef.current || sessionBusy) return;
    const current = processes.find(
      (process) => process.pid === pendingKill.pid,
    );
    if (
      hasError ||
      Date.now() - sampledRef.current > SNAPSHOT_FRESHNESS_MS ||
      !current?.killable ||
      processIdentity(current) !== processIdentity(pendingKill)
    ) {
      setKillError(t("taskManager.processChanged"));
      return;
    }
    killLockRef.current = true;
    setIsKilling(true);
    setKillError(null);
    try {
      await window.snow.killProcessTree(pendingKill.pid);
      setPendingKill(null);
      breakSampling();
      await refresh(true);
    } catch (error) {
      setKillError(error instanceof Error ? error.message : String(error));
    } finally {
      killLockRef.current = false;
      setIsKilling(false);
    }
  };
  // 后台任务终止：与进程「结束进程」同一只手（Rust 侧杀整棵进程树），
  // 只是入口是任务 id，击杀后记录按真实存活状态刷新。
  const taskKillLockRef = useRef(false);
  const handleConfirmTaskKill = async (): Promise<void> => {
    if (!pendingTaskKill || taskKillLockRef.current) return;
    taskKillLockRef.current = true;
    setIsTaskKilling(true);
    setTaskKillError(null);
    try {
      await window.snow.killDetachedTask(pendingTaskKill.id);
      setPendingTaskKill(null);
      breakSampling();
      await refresh(true);
    } catch (error) {
      setTaskKillError(error instanceof Error ? error.message : String(error));
    } finally {
      taskKillLockRef.current = false;
      setIsTaskKilling(false);
    }
  };
  const taskForgetLockRef = useRef(false);
  const handleConfirmTaskForget = async (): Promise<void> => {
    if (!pendingTaskForget || taskForgetLockRef.current) return;
    taskForgetLockRef.current = true;
    setIsTaskForgetting(true);
    setTaskForgetError(null);
    try {
      await window.snow.forgetDetachedTask(pendingTaskForget.id);
      setPendingTaskForget(null);
      breakSampling();
      await refresh(true);
    } catch (error) {
      setTaskForgetError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      taskForgetLockRef.current = false;
      setIsTaskForgetting(false);
    }
  };
  const handleOpenTaskLog = (task: DetachedTaskInfo): void => {
    const fileName = task.logPath.split("/").pop() || `${task.id}.log`;
    rightPanelEvents.emit("open-file", { filePath: task.logPath, fileName });
  };
  const sortableHeader = (
    field: SortField,
    label: string,
    className: string,
  ): React.ReactNode => (
    <th
      className={className}
      scope="col"
      aria-sort={
        field === sortField
          ? sortDirection === "asc"
            ? "ascending"
            : "descending"
          : "none"
      }
    >
      <button
        type="button"
        className="task-manager-sort-btn"
        onClick={() => handleSort(field)}
        title={t("taskManager.sortBy", { values: { column: label } })}
      >
        <span>{label}</span>
        {field === sortField &&
          (sortDirection === "asc" ? (
            <ArrowUp size={11} aria-hidden="true" />
          ) : (
            <ArrowDown size={11} aria-hidden="true" />
          ))}
      </button>
    </th>
  );
  const time = (value: number): string =>
    new Date(value).toLocaleTimeString(locale);
  return (
    <div className="task-manager">
      {/* 顶部指标概览卡片 */}
      <div
        className="task-manager-summary"
        aria-label={t("taskManager.visibleTotals")}
      >
        <button
          type="button"
          className={`task-manager-stat-card ${activeTab === "processes" ? "is-selected" : ""}`}
          onClick={() => setActiveTab("processes")}
        >
          <div className="task-manager-stat-icon is-boxes">
            <Boxes size={16} aria-hidden="true" />
          </div>
          <div className="task-manager-stat-info">
            <span className="task-manager-stat-label">
              {t("taskManager.visibleProcesses")}
            </span>
            <strong className="task-manager-stat-num">{summary.count}</strong>
            <span className="task-manager-stat-sub">
              {visibleRows.length === processes.length
                ? `${t("taskManager.processCount", { values: { count: processes.length } })}`
                : `${visibleRows.length} / ${processes.length}`}
            </span>
          </div>
        </button>

        <button
          type="button"
          className={`task-manager-stat-card ${activeTab === "performance" ? "is-selected" : ""}`}
          onClick={() => setActiveTab("performance")}
        >
          <div className="task-manager-stat-icon is-mem">
            <MemoryStick size={16} aria-hidden="true" />
          </div>
          <div className="task-manager-stat-info">
            <span className="task-manager-stat-label">
              {t("taskManager.visibleMemory")}
            </span>
            <strong className="task-manager-stat-num">
              {formatTaskBytes(summary.memory)}
            </strong>
            <span className="task-manager-stat-sub">
              {t("taskManager.tabPerformance")}
            </span>
          </div>
          <MiniSparkline
            samples={usageSamples}
            metric="memory"
            color="var(--accent-color)"
          />
        </button>

        <button
          type="button"
          className={`task-manager-stat-card ${activeTab === "performance" ? "is-selected" : ""}`}
          onClick={() => setActiveTab("performance")}
        >
          <div className="task-manager-stat-icon is-cpu">
            <Cpu size={16} aria-hidden="true" />
          </div>
          <div className="task-manager-stat-info">
            <span className="task-manager-stat-label">
              {t("taskManager.visibleCpu")}
            </span>
            <strong className="task-manager-stat-num">
              {formatTaskTotalCpu(summary)}
            </strong>
            <span className="task-manager-stat-sub">
              {t("taskManager.tabPerformance")}
            </span>
          </div>
          <MiniSparkline
            samples={usageSamples}
            metric="cpu"
            color="var(--accent-amber-text)"
          />
        </button>
      </div>

      {/* 顶部 Tab 导航栏与状态控制器 */}
      <div className="task-manager-nav-bar">
        <div className="task-manager-tabs-wrap" role="tablist">
          <OverlayScrollbar
            className="task-manager-tabs"
            orientation="horizontal"
            ref={tabsRef}
          >
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "processes"}
              className={`task-manager-tab-btn ${activeTab === "processes" ? "is-active" : ""}`}
              onClick={() => setActiveTab("processes")}
            >
              <Layers size={13} aria-hidden="true" />
              <span>{t("taskManager.tabProcesses")}</span>
              <span className="task-manager-tab-badge">
                {visibleRows.length}
              </span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "background"}
              className={`task-manager-tab-btn ${activeTab === "background" ? "is-active" : ""}`}
              onClick={() => setActiveTab("background")}
            >
              <Terminal size={13} aria-hidden="true" />
              <span>{t("taskManager.tabBackground")}</span>
              <span className="task-manager-tab-badge">
                {backgroundTasks.filter((task) => task.alive).length}
              </span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "performance"}
              className={`task-manager-tab-btn ${activeTab === "performance" ? "is-active" : ""}`}
              onClick={() => setActiveTab("performance")}
            >
              <Activity size={13} aria-hidden="true" />
              <span>{t("taskManager.tabPerformance")}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "sessions"}
              className={`task-manager-tab-btn ${activeTab === "sessions" ? "is-active" : ""}`}
              onClick={() => setActiveTab("sessions")}
            >
              <Cpu size={13} aria-hidden="true" />
              <span>{t("taskManager.tabSessions")}</span>
              <span className="task-manager-tab-badge">{sessions.length}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "alerts"}
              className={`task-manager-tab-btn ${activeTab === "alerts" ? "is-active" : ""}`}
              onClick={() => setActiveTab("alerts")}
            >
              <Bell size={13} aria-hidden="true" />
              <span>{t("taskManager.tabAlerts")}</span>
            </button>
          </OverlayScrollbar>
        </div>

        <div className="task-manager-nav-controls">
          <div
            className="task-manager-sampling-status"
            title={sampledAtMs ? time(sampledAtMs) : ""}
          >
            <span
              className={`task-manager-pulse-dot ${autoRefresh && !hidden ? "is-active" : "is-paused"}`}
            />
            <span className="task-manager-status-text">
              {autoRefresh && !hidden
                ? t("taskManager.autoSampling")
                : t("taskManager.paused")}
              {sampledAtMs ? ` · ${time(sampledAtMs)}` : ""}
            </span>
          </div>
          <label className="toggle-switch task-manager-auto-refresh">
            <span>{t("taskManager.autoRefresh")}</span>
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(event) => setAutoRefresh(event.target.checked)}
            />
            <span className="toggle-slider" />
          </label>
          <button
            type="button"
            className="task-manager-refresh-btn"
            onClick={() => void refresh(true)}
            title={t("taskManager.refresh")}
            aria-label={t("taskManager.refresh")}
          >
            <RefreshCw size={13} aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* 状态与告警提醒横幅 */}
      {processStale && !isLoading && (
        <div className="task-manager-notice task-manager-warning" role="status">
          {t("taskManager.processStale")}
        </div>
      )}
      {hasError && (
        <p className="task-manager-notice task-manager-error" role="status">
          {t("taskManager.loadError")}
        </p>
      )}

      {/* 实时告警横幅（所有 Tab 可见；告警 Tab 内单独渲染设置面板） */}
      <TaskManagerAlerts
        options={alertOptions}
        onOptionsChange={setAlertOptions}
        alerts={usageAlerts}
        onDismiss={dismissAlert}
        samplingActive={alertSamplingActive}
        valid={alertValid}
        mode="notice-only"
      />

      {/* Tab 1: 进程列表与进程树 */}
      {activeTab === "processes" && (
        <div className="task-manager-tab-content is-processes">
          <div className="task-manager-toolbar">
            <label className="task-manager-search">
              <Search size={13} aria-hidden="true" />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("taskManager.search")}
                aria-label={t("taskManager.search")}
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
            <div
              className="task-manager-filters"
              role="group"
              aria-label={t("taskManager.filter")}
            >
              <button
                type="button"
                aria-pressed={filter === "all"}
                onClick={() => setFilter("all")}
              >
                {t("taskManager.all")}
              </button>
              <button
                type="button"
                aria-pressed={filter === "lsp"}
                onClick={() => setFilter("lsp")}
              >
                LSP
              </button>
            </div>
            <div className="task-manager-project-filter">
              <CustomSelect
                value={project}
                options={projectOptions}
                onChange={setProject}
                dropdownMinWidth={280}
                ariaLabel={t("taskManager.projectScope")}
                title={formatDisplayPath(
                  projects.find(([key]) => key === project)?.[1] ||
                    t("taskManager.allProjects"),
                )}
              />
              {project && (
                <button
                  type="button"
                  className="task-manager-clear-project-btn"
                  onClick={() => setProject("")}
                  title={t("taskManager.clearProject")}
                >
                  <X size={11} aria-hidden="true" />
                </button>
              )}
            </div>
          </div>

          {isLoading ? (
            <div
              className="task-manager-state"
              role="status"
              aria-label={t("taskManager.loading")}
            >
              <Loader2 size={18} className="spin" aria-hidden="true" />
            </div>
          ) : (
            <TaskManagerProcessTable
              sortedRows={sortedProcesses}
              stale={processStale}
              actionsDisabled={isKilling || sessionBusy || pendingKill !== null}
              onKill={(process) => {
                setKillError(null);
                setPendingKill(process);
              }}
              onProject={selectProject}
              headers={
                <>
                  {sortableHeader(
                    "name",
                    t("taskManager.colName"),
                    "task-manager-col-name",
                  )}
                  {sortableHeader(
                    "kind",
                    t("taskManager.colType"),
                    "task-manager-col-kind",
                  )}
                  {sortableHeader(
                    "pid",
                    t("taskManager.colPid"),
                    "task-manager-col-pid",
                  )}
                  {sortableHeader(
                    "cpu",
                    t("taskManager.ownCpu"),
                    "task-manager-col-cpu",
                  )}
                  {sortableHeader(
                    "memory",
                    t("taskManager.ownMemory"),
                    "task-manager-col-memory",
                  )}
                  {sortableHeader(
                    "threads",
                    t("taskManager.colThreads"),
                    "task-manager-col-threads",
                  )}
                  <th scope="col" className="task-manager-col-actions">
                    <span className="task-manager-col-actions-label">
                      {t("taskManager.colActions")}
                    </span>
                  </th>
                </>
              }
            />
          )}
        </div>
      )}

      {/* Tab: bash detach 启动的后台任务（可查可停，支持从卡片徽章定位） */}
      {activeTab === "background" && (
        <>
          {backgroundError && (
            <div
              className="task-manager-notice task-manager-error"
              role="status"
            >
              {t("taskManager.backgroundError")}
            </div>
          )}
          <TaskManagerBackgroundTasks
            tasks={backgroundTasks}
            loaded={backgroundSampledAtMs > 0 || backgroundError}
            stale={
              backgroundError ||
              !backgroundSampledAtMs ||
              now - backgroundSampledAtMs > SNAPSHOT_FRESHNESS_MS
            }
            now={now}
            focus={focusRequest ?? null}
            actionsDisabled={
              isTaskKilling ||
              isTaskForgetting ||
              pendingTaskKill !== null ||
              pendingTaskForget !== null
            }
            onKill={(task) => {
              setTaskKillError(null);
              setPendingTaskKill(task);
            }}
            onForget={(task) => {
              setTaskForgetError(null);
              setPendingTaskForget(task);
            }}
            onOpenLog={handleOpenTaskLog}
          />
        </>
      )}

      {/* Tab 2: 性能趋势大屏与图表 */}
      {activeTab === "performance" && (
        <div className="task-manager-tab-content is-scrollable">
          <TaskManagerPerformancePanel
            samples={usageSamples}
            now={now}
            processes={visibleRows}
          />
        </div>
      )}

      {/* Tab 3: LSP 会话与资源预算 */}
      {activeTab === "sessions" && (
        <div className="task-manager-tab-content is-scrollable">
          <TaskManagerSessions
            isActive={isActive && !hidden}
            sessions={sessions}
            rows={rows}
            groups={groups}
            snapshot={sessionSnapshot}
            processStale={processStale}
            sessionsStale={sessionsStale}
            now={now}
            externalBusy={pendingKill !== null || isKilling}
            onBusyChange={setSessionBusy}
            onRefresh={forceRefresh}
            onProject={selectProject}
          />
          <div className="task-manager-card-section">
            <div className="task-manager-section-header">
              <Cpu size={14} />
              <strong>{t("taskManager.budgetTitle")}</strong>
            </div>
            <LspResourcePanel
              isActive={isActive && !hidden && activeTab === "sessions"}
            />
          </div>
        </div>
      )}

      {/* Tab 4: 持续占用告警设置 */}
      {activeTab === "alerts" && (
        <div className="task-manager-tab-content is-scrollable">
          <TaskManagerAlerts
            options={alertOptions}
            onOptionsChange={setAlertOptions}
            alerts={usageAlerts}
            onDismiss={dismissAlert}
            samplingActive={alertSamplingActive}
            valid={alertValid}
            mode="settings"
          />
          <TaskManagerSamplingLog />
        </div>
      )}

      <ConfirmDialog
        open={pendingKill !== null}
        title={t("taskManager.endProcessTitle")}
        message={
          pendingKill
            ? t("taskManager.endProcessConfirm", {
                values: {
                  name: taskDisplayName(pendingKill),
                  pid: pendingKill.pid,
                },
              })
            : ""
        }
        confirmLabel={t("taskManager.endProcess")}
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        onConfirm={() => void handleConfirmKill()}
        onCancel={() => {
          if (!killLockRef.current) {
            setPendingKill(null);
            setKillError(null);
          }
        }}
        isConfirming={isKilling}
        variant="danger"
      >
        {killError && <p className="task-manager-kill-error">{killError}</p>}
      </ConfirmDialog>

      <ConfirmDialog
        open={pendingTaskKill !== null}
        title={t("taskManager.endBackgroundTaskTitle")}
        message={
          pendingTaskKill
            ? t("taskManager.endBackgroundTaskConfirm", {
                values: {
                  name: backgroundTaskLabel(pendingTaskKill),
                  pid: pendingTaskKill.pid,
                },
              })
            : ""
        }
        confirmLabel={t("taskManager.endProcess")}
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        onConfirm={() => void handleConfirmTaskKill()}
        onCancel={() => {
          if (!taskKillLockRef.current) {
            setPendingTaskKill(null);
            setTaskKillError(null);
          }
        }}
        isConfirming={isTaskKilling}
        variant="danger"
      >
        {taskKillError && (
          <p className="task-manager-kill-error">{taskKillError}</p>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={pendingTaskForget !== null}
        title={t("taskManager.backgroundForgetTitle")}
        message={
          pendingTaskForget
            ? t("taskManager.backgroundForgetConfirm", {
                values: {
                  name: backgroundTaskLabel(pendingTaskForget),
                  path: pendingTaskForget.logPath,
                },
              })
            : ""
        }
        confirmLabel={t("taskManager.backgroundForget")}
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        onConfirm={() => void handleConfirmTaskForget()}
        onCancel={() => {
          if (!taskForgetLockRef.current) {
            setPendingTaskForget(null);
            setTaskForgetError(null);
          }
        }}
        isConfirming={isTaskForgetting}
        variant="danger"
      >
        {taskForgetError && (
          <p className="task-manager-kill-error">{taskForgetError}</p>
        )}
      </ConfirmDialog>
    </div>
  );
};
