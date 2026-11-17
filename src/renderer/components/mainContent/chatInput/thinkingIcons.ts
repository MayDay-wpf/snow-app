import { createLucideIcon, type IconNode } from "lucide-react";

// 灯泡光芒系列：缩小的灯泡 + 逐级增加光芒，xhigh/max 用填充加强
const HEAD =
  "M14.1 13.7c.14-.7.49-1.19 1.05-1.75.7-.63 1.05-1.54 1.05-2.45A4.2 4.2 0 0 0 7.8 9.5c0 .7.14 1.54 1.05 2.45.49.49.91 1.05 1.05 1.75";
const BASE: IconNode = [
  ["path", { d: "M9.9 17h4.2", key: "base-1" }],
  ["path", { d: "M10.6 20h2.8", key: "base-2" }],
];
const RAY_TOP: IconNode = [["path", { d: "M12 1.2v1.6", key: "ray-t" }]];
const RAY_DIAG: IconNode = [
  ["path", { d: "M5.6 3.1l1.4 1.4", key: "ray-dl" }],
  ["path", { d: "M18.4 3.1L17 4.5", key: "ray-dr" }],
];
const RAY_SIDE: IconNode = [
  ["path", { d: "M2.5 9.5h2", key: "ray-sl" }],
  ["path", { d: "M19.5 9.5h2", key: "ray-sr" }],
];

function bulb(headAttrs: Record<string, string> = {}): IconNode {
  return [["path", { d: HEAD, key: "head", ...headAttrs }], ...BASE];
}

function dimmed(nodes: IconNode): IconNode {
  return nodes.map(([tag, attrs]) => [tag, { ...attrs, opacity: "0.4" }]);
}

export const ThinkingNoneIcon = createLucideIcon(
  "thinking-none",
  dimmed(bulb()),
);
export const ThinkingMinimalIcon = createLucideIcon("thinking-minimal", bulb());
export const ThinkingLowIcon = createLucideIcon("thinking-low", [
  ...bulb(),
  ...RAY_TOP,
]);
export const ThinkingMediumIcon = createLucideIcon("thinking-medium", [
  ...bulb(),
  ...RAY_TOP,
  ...RAY_DIAG,
]);
export const ThinkingHighIcon = createLucideIcon("thinking-high", [
  ...bulb(),
  ...RAY_TOP,
  ...RAY_DIAG,
  ...RAY_SIDE,
]);
export const ThinkingXHighIcon = createLucideIcon("thinking-xhigh", [
  ...bulb({ fill: "currentColor", fillOpacity: "0.3" }),
  ...RAY_TOP,
  ...RAY_DIAG,
  ...RAY_SIDE,
]);
export const ThinkingMaxIcon = createLucideIcon("thinking-max", [
  ...bulb({ fill: "currentColor" }),
  ...RAY_TOP,
  ...RAY_DIAG,
  ...RAY_SIDE,
]);

// 与 CSS --thinking-grad 的色标一致
const TINT_STOPS: Array<[number, [number, number, number]]> = [
  [0, [56, 189, 248]],
  [0.42, [99, 102, 241]],
  [0.74, [168, 85, 247]],
  [1, [236, 72, 153]],
];

function tintAt(p: number): string {
  const clamped = Math.min(1, Math.max(0, p));
  for (let i = 1; i < TINT_STOPS.length; i++) {
    const [end, to] = TINT_STOPS[i];
    if (clamped <= end) {
      const [start, from] = TINT_STOPS[i - 1];
      const k = (clamped - start) / (end - start);
      const [r, g, b] = from.map((c, j) => Math.round(c + (to[j] - c) * k));
      return `rgb(${r}, ${g}, ${b})`;
    }
  }
  const [r, g, b] = TINT_STOPS[TINT_STOPS.length - 1][1];
  return `rgb(${r}, ${g}, ${b})`;
}

function thinkingProgress(
  options: ReadonlyArray<{ value: string }>,
  value: string,
): number | null {
  const index = options.findIndex((option) => option.value === value);
  if (index <= 0 || options.length < 2) {
    return null;
  }
  return index / (options.length - 1);
}

/** 按档位在进度条渐变上取色；最低档（none）与非预设值返回 null */
export function getThinkingTint(
  options: ReadonlyArray<{ value: string }>,
  value: string,
): string | null {
  const p = thinkingProgress(options, value);
  return p === null ? null : tintAt(p);
}

/** 文字渐变：截取进度条上到当前档位为止的一段；loop 首尾同色供流光平铺 */
export function getThinkingGradient(
  options: ReadonlyArray<{ value: string }>,
  value: string,
  loop = false,
): string | null {
  const p = thinkingProgress(options, value);
  if (p === null) {
    return null;
  }
  const from = tintAt(p - 0.4);
  const to = tintAt(p);
  return loop
    ? `linear-gradient(90deg, ${from}, ${to}, ${from})`
    : `linear-gradient(90deg, ${from}, ${to})`;
}
