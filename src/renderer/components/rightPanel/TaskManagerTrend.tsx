import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Activity,
  AppWindow,
  Boxes,
  Cpu,
  Layers,
  MemoryStick,
  MonitorCog,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { TaskManagerProcessKind } from "../../../preload";
import { useI18n } from "../../i18n";
import {
  appendUsageSample,
  pruneUsageSamples,
  usageSegments,
  TREND_WINDOW_MS,
  CONTINUOUS_SAMPLE_GAP_MS,
  type SampleStamp,
  type UsageSample,
} from "./taskManagerMonitoring";
import type { summarizeProcesses, TaskManagerRow } from "./taskManagerModel";
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

const KIND_COLORS: Record<TaskManagerProcessKind, string> = {
  browser: "var(--accent-blue)",
  renderer: "var(--accent-green)",
  gpu: "#f59e0b",
  utility: "#8b5cf6",
  child: "#ec4899",
};

export type TaskManagerTrendProps = {
  stamp: SampleStamp | null;
  scopeKey: string;
  summary: ReturnType<typeof summarizeProcesses>;
  scopeKnown: boolean;
  continuity: number;
  now: number;
};

/** Scope changes clear the buffer and consume the old stamp without adding another point. */
export function useUsageTrend({
  stamp,
  scopeKey,
  summary,
  scopeKnown,
  continuity,
  now,
}: TaskManagerTrendProps) {
  const [samples, setSamples] = useState<UsageSample[]>([]);
  const scopeRef = useRef(scopeKey);
  const consumedRef = useRef(stamp?.id ?? 0);
  const previousContinuityRef = useRef<number | null>(null);
  const previousAtRef = useRef<number | null>(null);
  useEffect(() => {
    if (scopeRef.current !== scopeKey) {
      scopeRef.current = scopeKey;
      consumedRef.current = stamp?.id ?? 0;
      previousContinuityRef.current = null;
      previousAtRef.current = null;
      setSamples([]);
      return;
    }
    if (!stamp || stamp.id <= consumedRef.current) return;
    consumedRef.current = stamp.id;
    if (stamp.scopeKey !== scopeKey) return;
    const broken =
      previousContinuityRef.current !== stamp.continuity ||
      stamp.continuity !== continuity ||
      previousAtRef.current == null ||
      stamp.atMs - previousAtRef.current > CONTINUOUS_SAMPLE_GAP_MS;
    previousContinuityRef.current = stamp.continuity;
    previousAtRef.current = stamp.atMs;
    const sample: UsageSample = {
      atMs: stamp.atMs,
      cpu:
        scopeKnown &&
        !broken &&
        summary.count > 0 &&
        summary.cpuSamples === summary.count
          ? summary.cpu
          : null,
      memory: scopeKnown ? summary.memory : null,
      breakBefore: broken,
    };
    setSamples((previous) => appendUsageSample(previous, sample));
  }, [stamp, scopeKey, summary, scopeKnown, continuity]);
  useEffect(() => {
    setSamples((previous) => {
      const retained = pruneUsageSamples(previous, now);
      return retained.length === previous.length ? previous : retained;
    });
  }, [now]);
  return scopeRef.current === scopeKey ? samples : [];
}

export function UsageChart({
  samples,
  metric,
  now,
  standalone = false,
}: {
  samples: UsageSample[];
  metric: "cpu" | "memory";
  now: number;
  standalone?: boolean;
}) {
  const { t, locale } = useI18n();
  const rawId = useId();
  const gradId = `task-mgr-grad-${metric}-${rawId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const values = samples.flatMap((sample) =>
    sample[metric] == null ? [] : [sample[metric]!],
  );
  const scaleMax =
    metric === "cpu" ? Math.max(100, ...values) : Math.max(1048576, ...values);
  const latest = samples.at(-1)?.[metric];
  const peak = values.length ? Math.max(...values) : null;
  const avg =
    values.length > 0
      ? values.reduce((sum, item) => sum + item, 0) / values.length
      : null;

  const label =
    metric === "cpu" ? t("taskManager.ownCpu") : t("taskManager.ownMemory");
  const format = (value: number | null | undefined): string =>
    value == null
      ? t("taskManager.trendUnknown")
      : metric === "cpu"
        ? `${value.toFixed(1)}%`
        : formatTaskBytes(value);

  const x = (atMs: number): number =>
    8 +
    Math.max(
      0,
      Math.min(1, (atMs - (now - TREND_WINDOW_MS)) / TREND_WINDOW_MS),
    ) *
      304;
  const y = (value: number): number => 66 - (value / scaleMax) * 54;
  const segments = usageSegments(samples, metric);

  const isCpu = metric === "cpu";
  const themeColor = "var(--accent-color)";

  return (
    <figure
      className={`task-manager-chart task-manager-chart-${metric}${standalone ? " is-standalone" : ""}`}
    >
      <figcaption className="task-manager-chart-header">
        <div className="task-manager-chart-title">
          {isCpu ? (
            <Activity size={13} className="task-manager-chart-icon" />
          ) : (
            <MemoryStick size={13} className="task-manager-chart-icon" />
          )}
          <span>{label}</span>
          <strong className="task-manager-chart-current">
            {format(latest)}
          </strong>
        </div>
        <div className="task-manager-chart-stats">
          {peak != null && (
            <span
              className="task-manager-stat-pill"
              title={t("taskManager.peakValue")}
            >
              <span className="stat-pill-label">
                {t("taskManager.peakValue")}
              </span>
              <span className="stat-pill-val">{format(peak)}</span>
            </span>
          )}
          {avg != null && (
            <span
              className="task-manager-stat-pill"
              title={t("taskManager.avgValue")}
            >
              <span className="stat-pill-label">
                {t("taskManager.avgValue")}
              </span>
              <span className="stat-pill-val">{format(avg)}</span>
            </span>
          )}
        </div>
      </figcaption>
      <div className="task-manager-chart-canvas-wrap">
        <svg
          viewBox="0 0 320 86"
          role="img"
          className="task-manager-chart-svg"
          aria-label={t("taskManager.trendChartLabel", {
            values: { metric: label, value: format(latest) },
          })}
        >
          <title>
            {t("taskManager.trendChartLabel", {
              values: { metric: label, value: format(latest) },
            })}
          </title>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={themeColor} stopOpacity="0.28" />
              <stop offset="80%" stopColor={themeColor} stopOpacity="0.05" />
              <stop offset="100%" stopColor={themeColor} stopOpacity="0.0" />
            </linearGradient>
          </defs>

          {/* Reference Grid lines */}
          <path
            className="task-manager-chart-grid"
            d="M8 12H312 M8 26H312 M8 40H312 M8 53H312"
          />
          <path className="task-manager-chart-axis" d="M8 66H312" />

          {/* Filled Areas and Trend Lines */}
          {segments.map((segment, index) => {
            if (!segment.length) return null;
            const linePath = segment
              .map(
                (point, i) =>
                  `${i ? "L" : "M"}${x(point.atMs).toFixed(2)} ${y(point[metric]!).toFixed(2)}`,
              )
              .join(" ");
            const firstX = x(segment[0].atMs).toFixed(2);
            const lastX = x(segment[segment.length - 1].atMs).toFixed(2);
            const areaPath = `${linePath} L${lastX} 66 L${firstX} 66 Z`;

            return (
              <g key={index}>
                {segment.length > 1 && (
                  <path
                    className="task-manager-chart-area"
                    d={areaPath}
                    fill={`url(#${gradId})`}
                  />
                )}
                {segment.length > 1 && (
                  <path className="task-manager-chart-line" d={linePath} />
                )}
                {segment.map((point) => (
                  <circle
                    key={point.atMs}
                    className="task-manager-chart-point"
                    cx={x(point.atMs)}
                    cy={y(point[metric]!)}
                    r={2}
                  >
                    <title>
                      {new Date(point.atMs).toLocaleTimeString(locale)} ·{" "}
                      {format(point[metric])}
                    </title>
                  </circle>
                ))}
              </g>
            );
          })}

          {/* Time axis labels */}
          <text x="8" y="80" className="task-manager-chart-tick">
            −60 s
          </text>
          <text
            x="160"
            y="80"
            textAnchor="middle"
            className="task-manager-chart-tick"
          >
            −30 s
          </text>
          <text
            x="312"
            y="80"
            textAnchor="end"
            className="task-manager-chart-tick"
          >
            {new Date(now).toLocaleTimeString(locale)}
          </text>
        </svg>
      </div>
      <div className="task-manager-chart-footer">
        <span className="task-manager-chart-scale">
          {t("taskManager.trendScale", { values: { value: format(scaleMax) } })}
        </span>
      </div>
    </figure>
  );
}

/** Top 5 资源排行柱状图 */
export function TopProcessesChart({
  processes,
  metric,
}: {
  processes: TaskManagerRow[];
  metric: "cpu" | "memory";
}) {
  const { t } = useI18n();
  const isCpu = metric === "cpu";
  const sorted = useMemo(() => {
    return [...processes]
      .filter((p) => (isCpu ? p.cpuPercent > 0 : p.memoryBytes > 0))
      .sort((a, b) =>
        isCpu
          ? b.cpuPercent - a.cpuPercent || b.memoryBytes - a.memoryBytes
          : b.memoryBytes - a.memoryBytes || b.cpuPercent - a.cpuPercent,
      )
      .slice(0, 5);
  }, [processes, isCpu]);

  const maxVal = sorted.length
    ? isCpu
      ? Math.max(10, sorted[0].cpuPercent)
      : Math.max(1048576, sorted[0].memoryBytes)
    : 1;

  const title = isCpu
    ? t("taskManager.topProcessesCpu")
    : t("taskManager.topProcessesMem");

  return (
    <div className="task-manager-top-card">
      <div className="task-manager-top-header">
        <div className="task-manager-top-title">
          {isCpu ? <Cpu size={13} /> : <MemoryStick size={13} />}
          <span>{title}</span>
        </div>
      </div>
      <div className="task-manager-top-list">
        {!sorted.length ? (
          <div className="task-manager-top-empty">{t("taskManager.empty")}</div>
        ) : (
          sorted.map((item) => {
            const val = isCpu ? item.cpuPercent : item.memoryBytes;
            const percent = Math.min(100, Math.max(4, (val / maxVal) * 100));
            const Icon = KIND_ICONS[item.kind] ?? Cpu;
            // 与类型分布条同色，便于对照
            const kindColor = KIND_COLORS[item.kind] ?? "var(--text-muted)";
            return (
              <div key={item.pid} className="task-manager-top-row">
                <div className="task-manager-top-meta">
                  <div className="task-manager-top-name-wrap">
                    {item.iconDataUrl ? (
                      <img
                        src={item.iconDataUrl}
                        alt=""
                        className="task-manager-process-icon"
                      />
                    ) : (
                      <Icon
                        size={12}
                        className="task-manager-process-icon"
                        style={{ color: kindColor }}
                      />
                    )}
                    <span
                      className="task-manager-top-name"
                      title={taskDisplayName(item)}
                    >
                      {taskDisplayName(item)}
                    </span>
                    <span className="task-manager-top-pid">PID {item.pid}</span>
                  </div>
                  <strong className="task-manager-top-val">
                    {isCpu
                      ? formatTaskCpu(item.cpuPercent)
                      : formatTaskBytes(item.memoryBytes)}
                  </strong>
                </div>
                <div className="task-manager-top-bar-bg">
                  <div
                    className="task-manager-top-bar-fill"
                    style={{
                      width: `${percent}%`,
                      background: kindColor,
                    }}
                  />
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/** 进程类型资源分布分段占比条 */
export function ProcessDistributionBar({
  processes,
}: {
  processes: TaskManagerRow[];
}) {
  const { t } = useI18n();
  const summaryByType = useMemo(() => {
    const map = new Map<
      TaskManagerProcessKind,
      { count: number; memory: number }
    >();
    let totalMem = 0;
    for (const p of processes) {
      const entry = map.get(p.kind) ?? { count: 0, memory: 0 };
      entry.count += 1;
      entry.memory += p.memoryBytes;
      map.set(p.kind, entry);
      totalMem += p.memoryBytes;
    }
    return {
      totalMem: Math.max(1, totalMem),
      items: (
        [
          "browser",
          "renderer",
          "gpu",
          "utility",
          "child",
        ] as TaskManagerProcessKind[]
      )
        .map((kind) => {
          const data = map.get(kind) ?? { count: 0, memory: 0 };
          return {
            kind,
            count: data.count,
            memory: data.memory,
            pct: (data.memory / Math.max(1, totalMem)) * 100,
          };
        })
        .filter((item) => item.count > 0),
    };
  }, [processes]);

  return (
    <div className="task-manager-dist-card">
      <div className="task-manager-dist-header">
        <div className="task-manager-dist-title">
          <Layers size={13} />
          <span>{t("taskManager.distribution")}</span>
        </div>
      </div>
      <div className="task-manager-dist-bar">
        {summaryByType.items.map((item) => (
          <div
            key={item.kind}
            className="task-manager-dist-segment"
            style={{
              width: `${Math.max(2, item.pct)}%`,
              backgroundColor: KIND_COLORS[item.kind],
            }}
            title={`${t(KIND_LABEL_KEYS[item.kind])}: ${formatTaskBytes(item.memory)} (${item.pct.toFixed(1)}%)`}
          />
        ))}
      </div>
      <div className="task-manager-dist-legend">
        {summaryByType.items.map((item) => (
          <div key={item.kind} className="task-manager-dist-legend-item">
            <span
              className="task-manager-dist-dot"
              style={{ backgroundColor: KIND_COLORS[item.kind] }}
            />
            <span className="task-manager-dist-kind-name">
              {t(KIND_LABEL_KEYS[item.kind])}
            </span>
            <span className="task-manager-dist-kind-pct">
              {item.pct.toFixed(0)}%
            </span>
            <span className="task-manager-dist-kind-count">({item.count})</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 完整的性能大屏可视化面板 */
export function TaskManagerPerformancePanel({
  samples,
  now,
  processes,
}: {
  samples: UsageSample[];
  now: number;
  processes: TaskManagerRow[];
}): React.JSX.Element {
  return (
    <div className="task-manager-perf-panel">
      <div className="task-manager-perf-charts-grid">
        <UsageChart samples={samples} metric="cpu" now={now} standalone />
        <UsageChart samples={samples} metric="memory" now={now} standalone />
      </div>

      <div className="task-manager-perf-details-grid">
        <TopProcessesChart processes={processes} metric="cpu" />
        <TopProcessesChart processes={processes} metric="memory" />
      </div>

      <ProcessDistributionBar processes={processes} />
    </div>
  );
}

/** 顶部概览卡片内的实时迷你波形图 */
export function MiniSparkline({
  samples,
  metric,
  color,
}: {
  samples: UsageSample[];
  metric: "cpu" | "memory";
  color: string;
}) {
  const values = samples.flatMap((s) =>
    s[metric] == null ? [] : [s[metric]!],
  );
  if (values.length < 2) return null;
  const max = Math.max(metric === "cpu" ? 100 : 1048576, ...values);
  const min = 0;
  const range = max - min || 1;
  const width = 46;
  const height = 18;
  const recent = values.slice(-16);
  const points = recent.map((val, idx, arr) => {
    const x = (idx / (arr.length - 1)) * width;
    const y = height - Math.max(1, ((val - min) / range) * (height - 2)) - 1;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg
      width={width}
      height={height}
      className="task-manager-stat-sparkline"
      aria-hidden="true"
    >
      <polyline
        fill="none"
        stroke={color}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={points.join(" ")}
      />
    </svg>
  );
}

export function TaskManagerTrend(props: {
  samples: UsageSample[];
  now: number;
}): React.JSX.Element {
  const { t } = useI18n();
  const samples = props.samples;
  return (
    <details
      className="task-manager-disclosure task-manager-trend"
      data-testid="task-manager-trend"
    >
      <summary>{t("taskManager.trendTitle")}</summary>
      <div className="task-manager-trend-body">
        {!samples.length ? (
          <p className="task-manager-hint">{t("taskManager.trendEmpty")}</p>
        ) : (
          <div className="task-manager-charts">
            <UsageChart samples={samples} metric="cpu" now={props.now} />
            <UsageChart samples={samples} metric="memory" now={props.now} />
          </div>
        )}
      </div>
    </details>
  );
}
