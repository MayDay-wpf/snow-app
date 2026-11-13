import { useMemo } from "react";

const VIEW_W = 120;
const VIEW_H = 28;
// 点数过多时分桶取均值，保持线条可读
const MAX_POINTS = 90;

type Props = {
  values: number[];
  color?: string;
};

/** 指标卡底部的迷你趋势线，纯展示，无交互。 */
export function Sparkline({
  values,
  color = "var(--text-muted)",
}: Props): React.JSX.Element | null {
  const paths = useMemo(() => {
    if (values.length < 2) return null;
    let points = values;
    if (values.length > MAX_POINTS) {
      const size = values.length / MAX_POINTS;
      points = [];
      for (let i = 0; i < MAX_POINTS; i++) {
        const from = Math.floor(i * size);
        const to = Math.max(from + 1, Math.floor((i + 1) * size));
        let sum = 0;
        for (let j = from; j < to; j++) sum += values[j];
        points.push(sum / (to - from));
      }
    }
    let max = 0;
    for (const v of points) max = Math.max(max, v);
    if (max <= 0) return null;
    const step = VIEW_W / (points.length - 1);
    let line = "";
    points.forEach((v, i) => {
      const x = (i * step).toFixed(1);
      const y = (VIEW_H - 1 - (v / max) * (VIEW_H - 2)).toFixed(1);
      line += `${i === 0 ? "M" : "L"}${x},${y}`;
    });
    return { line, area: `${line}L${VIEW_W},${VIEW_H}L0,${VIEW_H}Z` };
  }, [values]);

  if (!paths) return <div className="usage-sparkline usage-sparkline-empty" />;

  return (
    <svg
      className="usage-sparkline"
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path d={paths.area} fill={color} opacity="0.12" />
      <path
        d={paths.line}
        fill="none"
        stroke={color}
        strokeWidth="1.2"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
