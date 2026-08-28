import { useCallback, useMemo, useRef, useState } from "react";
import { useI18n } from "../../../i18n";
import type { DailyUsageBreakdown } from "../../../../preload";

const VIEW_W = 560;
const VIEW_H = 150;
const PAD_L = 44;
const PAD_R = 10;
const PAD_T = 8;
const PAD_B = 20;
// 数据点过多时降采样，避免折线过密。
const MAX_POINTS = 100;

type TrendKey = "totalInputTokens" | "totalOutputTokens";

const SERIES: {
  key: TrendKey;
  color: string;
  labelKey: string;
  defaultValue: string;
}[] = [
  {
    key: "totalInputTokens",
    color: "var(--accent-blue)",
    labelKey: "settings.usageColInput",
    defaultValue: "Input",
  },
  {
    key: "totalOutputTokens",
    color: "var(--accent-green)",
    labelKey: "settings.usageColOutput",
    defaultValue: "Output",
  },
];

type Props = {
  data: DailyUsageBreakdown[];
  formatTokens: (value: number) => string;
};

export function DailyTrendChart({
  data,
  formatTokens,
}: Props): React.JSX.Element {
  const { t } = useI18n();
  const svgRef = useRef<SVGSVGElement>(null);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [tooltip, setTooltip] = useState<{ left: number; top: number } | null>(
    null,
  );

  const points = useMemo(() => {
    if (data.length === 0) return [];
    if (data.length <= MAX_POINTS) return data;
    const sampled: DailyUsageBreakdown[] = [];
    const step = data.length / MAX_POINTS;
    for (let i = 0; i < MAX_POINTS; i++) {
      sampled.push(data[Math.min(data.length - 1, Math.floor(i * step))]);
    }
    return sampled;
  }, [data]);

  const maxValue = useMemo(() => {
    let max = 0;
    for (const p of points) {
      max = Math.max(max, p.totalInputTokens, p.totalOutputTokens);
    }
    return max;
  }, [points]);

  const plotW = VIEW_W - PAD_L - PAD_R;
  const plotH = VIEW_H - PAD_T - PAD_B;

  const xFor = (i: number): number =>
    PAD_L + (points.length <= 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const yFor = (v: number): number =>
    PAD_T + (1 - v / Math.max(maxValue, 1)) * plotH;

  const buildPath = (key: TrendKey, close: boolean): string => {
    if (points.length === 0) return "";
    let d = "";
    for (let i = 0; i < points.length; i++) {
      d += `${i === 0 ? "M" : "L"}${xFor(i).toFixed(1)},${yFor(points[i][key]).toFixed(1)}`;
    }
    if (close && points.length > 0) {
      d += `L${xFor(points.length - 1).toFixed(1)},${(PAD_T + plotH).toFixed(1)}`;
      d += `L${xFor(0).toFixed(1)},${(PAD_T + plotH).toFixed(1)}Z`;
    }
    return d;
  };

  const yTicks = useMemo(() => {
    if (maxValue <= 0) return [0, 0, 0];
    return [0, 0.5, 1].map((f) => maxValue * f);
  }, [maxValue]);

  const xLabelIndices = useMemo(() => {
    if (points.length <= 1) return [0];
    return [0, Math.floor((points.length - 1) / 2), points.length - 1];
  }, [points.length]);

  const formatDateShort = (dateStr: string): string => {
    const d = new Date(`${dateStr}T00:00:00`);
    if (Number.isNaN(d.getTime())) return dateStr;
    return `${d.getMonth() + 1}/${d.getDate()}`;
  };

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      const svg = svgRef.current;
      if (!svg || points.length === 0) return;
      const rect = svg.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * VIEW_W;
      const idx = Math.round(((x - PAD_L) / plotW) * (points.length - 1));
      const clamped = Math.max(0, Math.min(points.length - 1, idx));
      setActiveIndex(clamped);
      const left = e.clientX - rect.left + 12;
      const top = Math.max(4, e.clientY - rect.top - 8);
      // tooltip 宽约 190px，接近右边界时翻转到左侧。
      setTooltip({
        left: left + 190 > rect.width ? e.clientX - rect.left - 202 : left,
        top,
      });
    },
    [points.length, plotW],
  );

  const handleMouseLeave = useCallback(() => {
    setActiveIndex(null);
    setTooltip(null);
  }, []);

  if (points.length === 0 || maxValue <= 0) {
    return (
      <div className="usage-chart-empty">
        {t("settings.usageTrendEmpty", {
          defaultValue: "No usage data for the selected period.",
        })}
      </div>
    );
  }

  const activePoint = activeIndex !== null ? points[activeIndex] : null;

  return (
    <div className="usage-trend-chart">
      <div className="usage-chart-legend">
        {SERIES.map((s) => (
          <span key={s.key} className="usage-chart-legend-item">
            <span
              className="usage-chart-legend-dot"
              style={{ backgroundColor: s.color }}
            />
            {t(s.labelKey, { defaultValue: s.defaultValue })}
          </span>
        ))}
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        role="img"
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      >
        {yTicks.map((tick, i) => (
          <g key={i}>
            <line
              x1={PAD_L}
              x2={VIEW_W - PAD_R}
              y1={yFor(tick)}
              y2={yFor(tick)}
              stroke="var(--border-subtle)"
              strokeWidth="1"
            />
            <text
              x={PAD_L - 6}
              y={yFor(tick) + 3}
              textAnchor="end"
              className="usage-chart-axis-label"
            >
              {formatTokens(tick)}
            </text>
          </g>
        ))}
        {xLabelIndices.map((i) => (
          <text
            key={i}
            x={xFor(i)}
            y={VIEW_H - 6}
            textAnchor={
              i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"
            }
            className="usage-chart-axis-label"
          >
            {formatDateShort(points[i].date)}
          </text>
        ))}
        {SERIES.map((s) => (
          <g key={s.key}>
            <path
              d={buildPath(s.key, true)}
              fill={s.color}
              opacity="0.12"
            />
            <path
              d={buildPath(s.key, false)}
              fill="none"
              stroke={s.color}
              strokeWidth="1.8"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          </g>
        ))}
        {activePoint && activeIndex !== null && (
          <g>
            <line
              x1={xFor(activeIndex)}
              x2={xFor(activeIndex)}
              y1={PAD_T}
              y2={PAD_T + plotH}
              stroke="var(--text-muted)"
              strokeWidth="1"
              strokeDasharray="3 3"
            />
            {SERIES.map((s) => (
              <circle
                key={s.key}
                cx={xFor(activeIndex)}
                cy={yFor(activePoint[s.key])}
                r="3"
                fill={s.color}
                stroke="var(--bg-primary)"
                strokeWidth="1.2"
              />
            ))}
          </g>
        )}
      </svg>
      {activePoint && tooltip && (
        <div
          className="usage-chart-tooltip"
          style={{ left: tooltip.left, top: tooltip.top }}
        >
          <div className="usage-chart-tooltip-title">{activePoint.date}</div>
          {SERIES.map((s) => (
            <div key={s.key} className="usage-chart-tooltip-row">
              <span className="usage-chart-tooltip-label">
                {t(s.labelKey, { defaultValue: s.defaultValue })}
              </span>
              <span className="usage-chart-tooltip-value">
                {formatTokens(activePoint[s.key])}
              </span>
            </div>
          ))}
          <div className="usage-chart-tooltip-row">
            <span className="usage-chart-tooltip-label">
              {t("settings.usageCacheRead", { defaultValue: "Cache read" })}
            </span>
            <span className="usage-chart-tooltip-value">
              {formatTokens(activePoint.totalCacheReadInputTokens)}
            </span>
          </div>
          <div className="usage-chart-tooltip-row">
            <span className="usage-chart-tooltip-label">
              {t("settings.usageTotalRequests", {
                defaultValue: "Total requests",
              })}
            </span>
            <span className="usage-chart-tooltip-value">
              {activePoint.totalRequests.toLocaleString()}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
