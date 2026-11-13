import { useMemo } from "react";
import type { HourlyUsageCell } from "../../../../preload";

/** 热力图通用配色：0 为中性灰，其余按占比映射到绿色四档。 */
export const heatColor = (value: number, max: number): string => {
  if (value === 0 || max === 0) return "var(--bg-tertiary)";
  const ratio = value / max;
  if (ratio >= 0.75) return "var(--accent-green)";
  if (ratio >= 0.5)
    return "color-mix(in srgb, var(--accent-green) 65%, var(--bg-tertiary))";
  if (ratio >= 0.25)
    return "color-mix(in srgb, var(--accent-green) 40%, var(--bg-tertiary))";
  return "color-mix(in srgb, var(--accent-green) 20%, var(--bg-tertiary))";
};

const HOURS = Array.from({ length: 24 }, (_, i) => i);

type Props = {
  cells: HourlyUsageCell[];
  weekdayLabels: string[];
  onHover: (cell: HourlyUsageCell, x: number, y: number) => void;
  onMove: (x: number, y: number) => void;
  onLeave: () => void;
};

/** 星期 x 24 小时的用量网格。 */
export function UsageHourGrid({
  cells,
  weekdayLabels,
  onHover,
  onMove,
  onLeave,
}: Props): React.JSX.Element {
  const { grid, max } = useMemo(() => {
    const rows: HourlyUsageCell[][] = Array.from({ length: 7 }, (_, weekday) =>
      HOURS.map((hour) => ({
        weekday,
        hour,
        totalRequests: 0,
        totalTokens: 0,
      })),
    );
    let peak = 0;
    for (const cell of cells) {
      if (cell.weekday < 0 || cell.weekday > 6) continue;
      if (cell.hour < 0 || cell.hour > 23) continue;
      rows[cell.weekday][cell.hour] = cell;
      peak = Math.max(peak, cell.totalTokens);
    }
    return { grid: rows, max: peak };
  }, [cells]);

  return (
    <div className="usage-hour-grid">
      <div className="usage-hour-grid-hours">
        <span />
        {HOURS.map((hour) => (
          <span key={hour}>{hour % 3 === 0 ? hour : ""}</span>
        ))}
      </div>
      {grid.map((row, weekday) => (
        <div key={weekday} className="usage-hour-grid-row">
          <span className="usage-hour-grid-weekday">
            {weekdayLabels[weekday]}
          </span>
          {row.map((cell) => (
            <div
              key={cell.hour}
              className="usage-heatmap-cell"
              style={{ backgroundColor: heatColor(cell.totalTokens, max) }}
              onMouseEnter={(e) => onHover(cell, e.clientX, e.clientY)}
              onMouseMove={(e) => onMove(e.clientX, e.clientY)}
              onMouseLeave={onLeave}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
