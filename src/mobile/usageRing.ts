import type { SnowRemoteTokenUsage } from "../renderer/types/remoteControl";
import { escapeHtml } from "./dom";
import { formatTokenAmount } from "./format";
import { t } from "./i18n";

const SIZE = 28;
const STROKE = 2.5;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

type UsageSegments = {
  input: number;
  nonCachedInput: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  total: number;
  max: number;
  ratio: number;
  inputLength: number;
  outputLength: number;
  cacheWriteLength: number;
  cacheLength: number;
};

/** 与桌面端 TokenUsageRing 同口径：input 已含缓存读写，total = input + output。 */
const computeSegments = (
  usage: SnowRemoteTokenUsage | null | undefined,
  limit: number | null | undefined,
): UsageSegments | null => {
  if (!usage) return null;
  if (typeof limit !== "number" || limit <= 0) return null;
  const input = usage.inputTokens || 0;
  const output = usage.outputTokens || 0;
  if (input + output <= 0) return null;
  const cacheRead = Math.min(usage.cacheReadInputTokens || 0, input);
  const cacheCreation = Math.min(
    usage.cacheCreationInputTokens || 0,
    input - cacheRead,
  );
  const nonCachedInput = input - cacheRead - cacheCreation;
  const total = input + output;
  const ratio = Math.min(total / limit, 1);
  const filled = ratio * CIRCUMFERENCE;
  return {
    input,
    nonCachedInput,
    output,
    cacheCreation,
    cacheRead,
    total,
    max: limit,
    ratio,
    inputLength: filled * (nonCachedInput / total),
    outputLength: filled * (output / total),
    cacheWriteLength: filled * (cacheCreation / total),
    cacheLength: filled * (cacheRead / total),
  };
};

const arc = (length: number, offset: number, className: string): string =>
  `<circle cx="${SIZE / 2}" cy="${SIZE / 2}" r="${RADIUS}" fill="none" stroke-width="${STROKE}" ` +
  `stroke-linecap="butt" class="${className}" transform="rotate(-90 ${SIZE / 2} ${SIZE / 2})" ` +
  `stroke-dasharray="${length} ${CIRCUMFERENCE - length}" ` +
  `stroke-dashoffset="${-offset}"/>`;

/** 顶栏上下文环：input / output / 缓存写入 / 缓存命中四段，配色同桌面端。 */
export const usageRingMarkup = (
  usage: SnowRemoteTokenUsage | null | undefined,
  limit: number | null | undefined,
): string | null => {
  const segments = computeSegments(usage, limit);
  if (!segments) return null;
  const percent = Math.round(segments.ratio * 100);
  let offset = 0;
  let arcs = "";
  for (const [length, className] of [
    [segments.inputLength, "usage-ring-input"],
    [segments.outputLength, "usage-ring-output"],
    [segments.cacheWriteLength, "usage-ring-cache-write"],
    [segments.cacheLength, "usage-ring-cache"],
  ] as const) {
    if (length > 0) arcs += arc(length, offset, className);
    offset += length;
  }
  return (
    `<svg viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}" aria-hidden="true">` +
    `<circle cx="${SIZE / 2}" cy="${SIZE / 2}" r="${RADIUS}" fill="none" stroke-width="${STROKE}" class="usage-ring-track"/>` +
    arcs +
    `<text x="${SIZE / 2}" y="${SIZE / 2}" text-anchor="middle" dominant-baseline="central" class="usage-ring-text${percent >= 100 ? " is-compact" : ""}">${percent}%</text>` +
    `</svg>`
  );
};

/** 点击环后的明细浮层：行结构与桌面端 TokenUsageRing tooltip 一致。 */
export const usageDetailMarkup = (
  usage: SnowRemoteTokenUsage | null | undefined,
  limit: number | null | undefined,
): string | null => {
  const segments = computeSegments(usage, limit);
  if (!segments) return null;
  const row = (dot: string, label: string, value: string): string =>
    `<span class="usage-popover-row">` +
    (dot ? `<i class="usage-popover-dot ${dot}"></i>` : "") +
    `<span class="usage-popover-label">${escapeHtml(label)}</span>` +
    `<span class="usage-popover-value">${escapeHtml(value)}</span>` +
    `</span>`;
  const rows = [
    row(
      "is-input",
      t("remote.usage.input"),
      formatTokenAmount(segments.nonCachedInput),
    ),
    row(
      "is-output",
      t("remote.usage.output"),
      formatTokenAmount(segments.output),
    ),
  ];
  if (segments.cacheCreation > 0) {
    rows.push(
      row(
        "is-cache-write",
        t("remote.usage.cacheWrite"),
        formatTokenAmount(segments.cacheCreation),
      ),
    );
  }
  if (segments.cacheRead > 0) {
    rows.push(
      row(
        "is-cache-read",
        t("remote.usage.cacheHit"),
        formatTokenAmount(segments.cacheRead),
      ),
    );
  }
  rows.push(`<span class="usage-popover-divider"></span>`);
  rows.push(
    row("", t("remote.usage.total"), formatTokenAmount(segments.total)),
  );
  if (segments.cacheRead > 0 && segments.input > 0) {
    const hitRate =
      Math.round((segments.cacheRead / segments.input) * 1000) / 10;
    rows.push(row("", t("remote.usage.cacheHitRate"), `${hitRate}%`));
  }
  rows.push(
    row("", t("remote.usage.context"), formatTokenAmount(segments.max)),
  );
  return rows.join("");
};
