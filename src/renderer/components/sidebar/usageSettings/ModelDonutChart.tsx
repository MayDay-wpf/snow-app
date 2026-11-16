import { useMemo, useRef, useState } from "react";
import { useI18n } from "../../../i18n";
import type { ModelUsageBreakdown } from "../../../../preload";
import { ModelBrandIcon } from "../../common/ModelBrandIcon";
import { isChatRequestMethod, translateRequestMethod } from "./requestMethod";

const TOP_N = 5;
const VIEW = 132;
const RADIUS = 46;
const STROKE = 16;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

// 环形图配色：主题 accent 四色 + 固定高区分度紫/青，避免 color-mix
// 产生与主色视觉相近的中间色；超过色板数量的分段（"其他"）固定使用
// 中性灰，保证图例颜色不重复。
const COLORS = [
  "var(--accent-green)",
  "var(--accent-blue)",
  "var(--accent-orange, #d97757)",
  "var(--accent-red)",
  "#a855f7",
  "#14b8a6",
];
const OTHER_COLOR = "var(--text-muted)";

type Segment = {
  /** 唯一标识：同名模型会合并，重名会破坏 React 复用。 */
  key: string;
  label: string;
  model: string;
  value: number;
  requests: number;
  isOther: boolean;
  count: number;
  fraction: number;
  arcLen: number;
  dashOffset: number;
  color: string;
};

type Props = {
  data: ModelUsageBreakdown[];
  formatTokens: (value: number) => string;
};

export function ModelDonutChart({
  data,
  formatTokens,
}: Props): React.JSX.Element {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [tooltip, setTooltip] = useState<{ left: number; top: number } | null>(
    null,
  );

  const segments = useMemo<Segment[]>(() => {
    // 同名模型可能来自多种协议，先按展示标签合并，避免重复 key 与占比叠加。
    const grouped = new Map<
      string,
      { model: string; value: number; requests: number }
    >();
    for (const row of data) {
      const model = row.model || "-";
      const label = isChatRequestMethod(row.requestMethod)
        ? model
        : `${model} · ${translateRequestMethod(row.requestMethod, t)}`;
      const current = grouped.get(label);
      if (current) {
        current.value += row.totalTokens;
        current.requests += row.totalRequests;
      } else {
        grouped.set(label, {
          model: row.model,
          value: row.totalTokens,
          requests: row.totalRequests,
        });
      }
    }
    const sorted = [...grouped.entries()].sort(
      (a, b) => b[1].value - a[1].value,
    );
    const top = sorted.slice(0, TOP_N);
    const rest = sorted.slice(TOP_N);
    const restTokens = rest.reduce((sum, [, g]) => sum + g.value, 0);
    const restRequests = rest.reduce((sum, [, g]) => sum + g.requests, 0);
    const items = top.map(([label, g]) => ({
      label,
      model: g.model,
      value: g.value,
      requests: g.requests,
      isOther: false,
      count: 1,
    }));
    if (restTokens > 0) {
      items.push({
        label: t("settings.usageOthers", { defaultValue: "Others" }),
        model: "",
        value: restTokens,
        requests: restRequests,
        isOther: true,
        count: rest.length,
      });
    }
    const total = items.reduce((sum, it) => sum + it.value, 0);
    let acc = 0;
    return items.map((it, i) => {
      const fraction = total > 0 ? it.value / total : 0;
      const seg: Segment = {
        key: it.isOther ? "__others" : it.label,
        label: it.label,
        model: it.model,
        value: it.value,
        requests: it.requests,
        isOther: it.isOther,
        count: it.count,
        fraction,
        arcLen: fraction * CIRCUMFERENCE,
        dashOffset: CIRCUMFERENCE * (1 - acc),
        color: it.isOther ? OTHER_COLOR : COLORS[i % COLORS.length],
      };
      acc += fraction;
      return seg;
    });
  }, [data, t]);

  const totalTokens = useMemo(
    () => segments.reduce((sum, s) => sum + s.value, 0),
    [segments],
  );

  // 悬停说明框：跟随鼠标定位在容器内，接近右边界时翻转到左侧。
  const showTooltipAt = (index: number, e: React.MouseEvent) => {
    setActiveIndex(index);
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const left = e.clientX - rect.left + 12;
    const top = Math.max(4, e.clientY - rect.top - 10);
    setTooltip({
      left: left + 180 > rect.width ? e.clientX - rect.left - 192 : left,
      top,
    });
  };

  const hideTooltip = () => {
    setActiveIndex(null);
    setTooltip(null);
  };

  if (segments.length === 0 || totalTokens <= 0) {
    return (
      <div className="usage-chart-empty">
        {t("settings.usageDonutEmpty", {
          defaultValue: "No model usage data.",
        })}
      </div>
    );
  }

  const center = VIEW / 2;
  const activeSegment = activeIndex !== null ? segments[activeIndex] : null;

  return (
    <div className="usage-donut" ref={containerRef}>
      <svg viewBox={`0 0 ${VIEW} ${VIEW}`} role="img">
        <circle
          cx={center}
          cy={center}
          r={RADIUS}
          fill="none"
          stroke="var(--bg-tertiary)"
          strokeWidth={STROKE}
        />
        {segments.map((seg, i) => (
          <circle
            key={seg.key}
            className={`usage-donut-segment${
              activeIndex !== null && activeIndex !== i ? " dim" : ""
            }`}
            cx={center}
            cy={center}
            r={RADIUS}
            fill="none"
            stroke={seg.color}
            strokeWidth={STROKE}
            strokeDasharray={`${seg.arcLen} ${CIRCUMFERENCE - seg.arcLen}`}
            strokeDashoffset={seg.dashOffset}
            transform={`rotate(-90 ${center} ${center})`}
            onMouseEnter={(e) => showTooltipAt(i, e)}
            onMouseLeave={hideTooltip}
          />
        ))}
        <text
          x={center}
          y={center - 2}
          textAnchor="middle"
          className="usage-donut-center-value"
        >
          {formatTokens(totalTokens)}
        </text>
        <text
          x={center}
          y={center + 14}
          textAnchor="middle"
          className="usage-donut-center-label"
        >
          {t("settings.usageTotalTokens", { defaultValue: "Total tokens" })}
        </text>
      </svg>
      <div className="usage-donut-legend">
        {segments.map((seg, i) =>
          seg.isOther ? (
            <div
              key="__others"
              className="usage-donut-legend-tail"
              onMouseEnter={(e) => showTooltipAt(i, e)}
              onMouseLeave={hideTooltip}
            >
              {t("settings.usageOthersTogether", {
                defaultValue: "{{count}} more, {{pct}} together",
                values: {
                  count: String(seg.count),
                  pct: `${(seg.fraction * 100).toFixed(1)}%`,
                },
              })}
            </div>
          ) : (
            <div
              key={seg.key}
              className="usage-donut-legend-item"
              onMouseEnter={(e) => showTooltipAt(i, e)}
              onMouseLeave={hideTooltip}
            >
              <span
                className="usage-donut-legend-dot"
                style={{ backgroundColor: seg.color }}
              />
              <ModelBrandIcon model={seg.model} size={14} />
              <span className="usage-donut-legend-text">
                <span className="usage-donut-legend-label" title={seg.label}>
                  {seg.label}
                </span>
                <span className="usage-donut-legend-sub">
                  {t("settings.usageRequestsCount", {
                    defaultValue: "{{count}} requests",
                    values: { count: seg.requests.toLocaleString() },
                  })}
                </span>
              </span>
              <span className="usage-donut-legend-value">
                {formatTokens(seg.value)}
              </span>
              <span className="usage-donut-legend-pct">
                {(seg.fraction * 100).toFixed(1)}%
              </span>
            </div>
          ),
        )}
      </div>
      {activeSegment && tooltip && (
        <div
          className="usage-chart-tooltip"
          style={{ left: tooltip.left, top: tooltip.top }}
        >
          <div className="usage-chart-tooltip-title">{activeSegment.label}</div>
          <div className="usage-chart-tooltip-row">
            <span className="usage-chart-tooltip-label">
              {t("settings.usageTotalTokens", {
                defaultValue: "Total tokens",
              })}
            </span>
            <span className="usage-chart-tooltip-value">
              {formatTokens(activeSegment.value)}
            </span>
          </div>
          <div className="usage-chart-tooltip-row">
            <span className="usage-chart-tooltip-label">
              {t("settings.usageTotalRequests", {
                defaultValue: "Total requests",
              })}
            </span>
            <span className="usage-chart-tooltip-value">
              {activeSegment.requests.toLocaleString()}
            </span>
          </div>
          <div className="usage-chart-tooltip-row">
            <span className="usage-chart-tooltip-label">
              {t("settings.usageShare", { defaultValue: "Share" })}
            </span>
            <span className="usage-chart-tooltip-value">
              {(activeSegment.fraction * 100).toFixed(1)}%
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
