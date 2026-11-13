import { useCallback, useMemo, useRef, useState } from "react";
import { useI18n } from "../../../i18n";
import type { DailyUsageBreakdown } from "../../../../preload";

const VIEW_W = 560;
const VIEW_H = 150;
const PAD_L = 44;
const PAD_R = 10;
const PAD_T = 8;
const PAD_B = 20;
// 天数过多时按桶合并，避免柱子过细
const MAX_BARS = 120;

type StackKey = "nonCached" | "cacheRead" | "output";

// 堆叠顺序自下而上
const SERIES: {
  key: StackKey;
  color: string;
  labelKey: string;
  defaultValue: string;
}[] = [
  {
    key: "nonCached",
    color: "var(--accent-blue)",
    labelKey: "settings.usageNonCachedInput",
    defaultValue: "Input (uncached)",
  },
  {
    key: "cacheRead",
    color: "#14b8a6",
    labelKey: "settings.usageCacheRead",
    defaultValue: "Cache read",
  },
  {
    key: "output",
    color: "var(--accent-orange, #d97757)",
    labelKey: "settings.usageColOutput",
    defaultValue: "Output",
  },
];

type Bucket = {
  from: string;
  to: string;
  nonCached: number;
  cacheRead: number;
  output: number;
  cacheWrite: number;
  requests: number;
};

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
  // 缓存读取常占绝大部分，默认排除以免压扁其它类型
  const [excludeCacheRead, setExcludeCacheRead] = useState(true);

  const buckets = useMemo<Bucket[]>(() => {
    if (data.length === 0) return [];
    const size = Math.max(1, Math.ceil(data.length / MAX_BARS));
    const result: Bucket[] = [];
    for (let i = 0; i < data.length; i += size) {
      const slice = data.slice(i, i + size);
      const bucket: Bucket = {
        from: slice[0].date,
        to: slice[slice.length - 1].date,
        nonCached: 0,
        cacheRead: 0,
        output: 0,
        cacheWrite: 0,
        requests: 0,
      };
      for (const d of slice) {
        // 输入已含缓存读取，拆成未缓存 + 缓存读取两段
        const cacheRead = Math.min(
          d.totalCacheReadInputTokens,
          d.totalInputTokens,
        );
        bucket.nonCached += d.totalInputTokens - cacheRead;
        bucket.cacheRead += cacheRead;
        bucket.output += d.totalOutputTokens;
        bucket.cacheWrite += d.totalCacheCreationInputTokens;
        bucket.requests += d.totalRequests;
      }
      result.push(bucket);
    }
    return result;
  }, [data]);

  const visibleSeries = useMemo(
    () =>
      excludeCacheRead ? SERIES.filter((s) => s.key !== "cacheRead") : SERIES,
    [excludeCacheRead],
  );

  const stackTotal = useCallback(
    (b: Bucket) => visibleSeries.reduce((sum, s) => sum + b[s.key], 0),
    [visibleSeries],
  );

  const maxValue = useMemo(() => {
    let max = 0;
    for (const b of buckets) max = Math.max(max, stackTotal(b));
    return max;
  }, [buckets, stackTotal]);

  const hasAnyData = useMemo(
    () => buckets.some((b) => b.nonCached + b.cacheRead + b.output > 0),
    [buckets],
  );

  const plotW = VIEW_W - PAD_L - PAD_R;
  const plotH = VIEW_H - PAD_T - PAD_B;
  const slot = buckets.length > 0 ? plotW / buckets.length : plotW;
  const barW = Math.max(1, slot * 0.72);

  const xFor = (i: number): number => PAD_L + i * slot + (slot - barW) / 2;
  const hFor = (v: number): number => (v / Math.max(maxValue, 1)) * plotH;

  const yTicks = useMemo(
    () => (maxValue <= 0 ? [0] : [0, 0.5, 1].map((f) => maxValue * f)),
    [maxValue],
  );

  const xLabelIndices = useMemo(() => {
    if (buckets.length <= 1) return [0];
    return [0, Math.floor((buckets.length - 1) / 2), buckets.length - 1];
  }, [buckets.length]);

  const formatDateShort = (dateStr: string): string => {
    const d = new Date(`${dateStr}T00:00:00`);
    if (Number.isNaN(d.getTime())) return dateStr;
    return `${d.getMonth() + 1}/${d.getDate()}`;
  };

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      const svg = svgRef.current;
      if (!svg || buckets.length === 0) return;
      // 用 SVG 坐标变换换算 viewBox 坐标，避免等比缩放留白造成偏差
      const ctm = svg.getScreenCTM();
      if (!ctm) return;
      const x = new DOMPoint(e.clientX, e.clientY).matrixTransform(
        ctm.inverse(),
      ).x;
      const idx = Math.floor((x - PAD_L) / slot);
      setActiveIndex(Math.max(0, Math.min(buckets.length - 1, idx)));
      const rect = svg.getBoundingClientRect();
      const left = e.clientX - rect.left + 12;
      const top = Math.max(4, e.clientY - rect.top - 8);
      setTooltip({
        left: left + 200 > rect.width ? e.clientX - rect.left - 212 : left,
        top,
      });
    },
    [buckets.length, slot],
  );

  const handleMouseLeave = useCallback(() => {
    setActiveIndex(null);
    setTooltip(null);
  }, []);

  if (buckets.length === 0 || !hasAnyData) {
    return (
      <div className="usage-chart-empty">
        {t("settings.usageTrendEmpty", {
          defaultValue: "No usage data for the selected period.",
        })}
      </div>
    );
  }

  const active = activeIndex !== null ? buckets[activeIndex] : null;
  const activeTitle = active
    ? active.from === active.to
      ? active.from
      : `${active.from} ~ ${active.to}`
    : "";

  return (
    <div className="usage-trend-chart">
      <div className="usage-chart-legend">
        {visibleSeries.map((s) => (
          <span key={s.key} className="usage-chart-legend-item">
            <span
              className="usage-chart-legend-dot"
              style={{ backgroundColor: s.color }}
            />
            {t(s.labelKey, { defaultValue: s.defaultValue })}
          </span>
        ))}
        <button
          type="button"
          className={`usage-chart-toggle${excludeCacheRead ? " active" : ""}`}
          aria-pressed={excludeCacheRead}
          onClick={() => setExcludeCacheRead((v) => !v)}
        >
          {t("settings.usageExcludeCacheRead", {
            defaultValue: "Excl. cache reads",
          })}
        </button>
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        role="img"
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      >
        {yTicks.map((tick, i) => {
          const y = PAD_T + plotH - hFor(tick);
          return (
            <g key={i}>
              <line
                x1={PAD_L}
                x2={VIEW_W - PAD_R}
                y1={y}
                y2={y}
                stroke="var(--border-subtle)"
                strokeWidth="1"
              />
              <text
                x={PAD_L - 6}
                y={y + 3}
                textAnchor="end"
                className="usage-chart-axis-label"
              >
                {formatTokens(tick)}
              </text>
            </g>
          );
        })}
        {xLabelIndices.map((i) => (
          <text
            key={i}
            x={xFor(i) + barW / 2}
            y={VIEW_H - 6}
            textAnchor={
              i === 0 ? "start" : i === buckets.length - 1 ? "end" : "middle"
            }
            className="usage-chart-axis-label"
          >
            {formatDateShort(buckets[i].from)}
          </text>
        ))}
        {buckets.map((b, i) => {
          let base = PAD_T + plotH;
          return (
            <g
              key={b.from}
              className={`usage-trend-bar${
                activeIndex !== null && activeIndex !== i ? " dim" : ""
              }`}
            >
              {visibleSeries.map((s) => {
                const h = hFor(b[s.key]);
                if (h <= 0) return null;
                base -= h;
                return (
                  <rect
                    key={s.key}
                    x={xFor(i)}
                    y={base}
                    width={barW}
                    height={h}
                    fill={s.color}
                  />
                );
              })}
            </g>
          );
        })}
      </svg>
      {active && tooltip && (
        <div
          className="usage-chart-tooltip"
          style={{ left: tooltip.left, top: tooltip.top }}
        >
          <div className="usage-chart-tooltip-title">{activeTitle}</div>
          {SERIES.map((s) => (
            <div key={s.key} className="usage-chart-tooltip-row">
              <span className="usage-chart-tooltip-label">
                <span
                  className="usage-chart-legend-dot"
                  style={{ backgroundColor: s.color }}
                />
                {t(s.labelKey, { defaultValue: s.defaultValue })}
              </span>
              <span className="usage-chart-tooltip-value">
                {formatTokens(active[s.key])}
              </span>
            </div>
          ))}
          <div className="usage-chart-tooltip-row">
            <span className="usage-chart-tooltip-label">
              {t("settings.usageCacheCreation", {
                defaultValue: "Cache write",
              })}
            </span>
            <span className="usage-chart-tooltip-value">
              {formatTokens(active.cacheWrite)}
            </span>
          </div>
          <div className="usage-chart-tooltip-row">
            <span className="usage-chart-tooltip-label">
              {t("settings.usageTotalRequests", {
                defaultValue: "Total requests",
              })}
            </span>
            <span className="usage-chart-tooltip-value">
              {active.requests.toLocaleString()}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
