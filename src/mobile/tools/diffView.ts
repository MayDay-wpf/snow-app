/**
 * 移动端 unified diff 视图（工具卡片内的紧凑单栏形态）。
 *
 * DOM 契约（styles/tools/diff.css，勿单独改动一侧）：
 *   div.tc-diff
 *     div.tc-diff-head
 *       span.tc-diff-icon                    ← 文件类型图标（mobile/fileIcons）
 *       span.tc-diff-name[title]             ← 文件名
 *       span.tc-badge.tc-diff-stats          ← `+a -d` 统计（tcBadge）
 *     div.tc-diff-note[.tc-diff-warn]        ← 降级 / 截断 / 无差异提示
 *     div.tc-diff-body
 *       div.tc-diff-line.add|del|ctx         ← [旧行号][新行号][符号][文本]
 *         span.tc-diff-no ×2 + span.tc-diff-sign + span.tc-diff-code
 *       button.tc-diff-fold                  ← 折叠条（点击展开）
 *         span.tc-diff-fold-icon + span.tc-diff-fold-label
 *
 * 取舍：
 * - 单栏 unified 而非双栏：手机屏宽放不下两列代码，「旧行号 + 新行号 + 符号 +
 *   文本」已完整表达 unified diff；
 * - 上下文折叠：toHunks(lines, 3) 只保留每处改动前后 3 行，其余折叠为可点击的
 *   「已折叠 n 行」条，点击就地展开（展开后的真实行同样受行数预算约束）；
 * - 展开状态跨重建保留：工具卡片随轮询重建，展开的折叠块记在模块级 Map（键为
 *   文件名 + 两段文本摘要），重建时按桶恢复；桶数超过 MAX_TRACKED_DIFFS 时
 *   按 LRU 淘汰，长时间会话不会无限增长；
 * - 行号：del/ctx 用旧侧行号，add/ctx 用新侧行号；startLine 提供时两侧都从
 *   startLine 起算（与桌面 MiniDiffViewer 的 oldStartLine/newStartLine 同语义）；
 * - 体积保护：isDiffTooLarge → 提示「已降级为整体替换」；渲染行数超过 maxLines
 *   （默认 400，硬上限 2000）→ 截断并提示；
 * - 全部 createElement + textContent：行文本原样输出（不 trim 空格、不转义 HTML
 *   实体），数据绝不进 innerHTML（仅静态图标标记走 iconMarkup）。
 */
import { t } from "../i18n";
import { fileIconEl } from "../fileIcons";
import { iconMarkup, type MobileIconName } from "../icons";
import {
  computeLineDiff,
  diffStats,
  isDiffTooLarge,
  toHunks,
  type DiffLine,
} from "./diff";
import { tcBadge } from "./ui";

/** 上下文折叠半径（与桌面 unified diff 的 context 语义一致）。 */
const CONTEXT_RADIUS = 3;
/** 渲染行数上限的默认值与硬上限（触摸端 DOM 行数保护）。 */
const DEFAULT_MAX_LINES = 400;
const RENDER_LINE_CAP = 2000;
/** 展开状态最多保留多少个 diff 的桶（LRU 淘汰）。 */
const MAX_TRACKED_DIFFS = 24;

export type DiffViewOptions = {
  /** 文件名（头部展示；空串回退为通用「文件」文案）。 */
  fileName: string;
  /** 改动前的文本；空串表示新建 / 写入，整篇按新增渲染。 */
  oldText: string;
  /** 改动后的文本。 */
  newText: string;
  /** 正文首行在真实文件中的行号（1-based，缺省 1）：两侧行号都从这里起算。 */
  startLine?: number;
  /** 渲染行数上限（缺省 400；非正数回退默认值，超过硬上限按硬上限）。 */
  maxLines?: number;
  /** 已算过的 diff 行：调用方复用时避免重复 DP（大文本下唯一的显著开销）。 */
  lines?: DiffLine[];
};

// ── 元素小件 ──────────────────────────────────────────────────────────────

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** 静态 lucide 图标（只承载图标标记，不含数据，可安全走 innerHTML）。 */
const iconSpan = (name: MobileIconName, className: string): HTMLSpanElement => {
  const span = el("span", className);
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = iconMarkup(name);
  return span;
};

// ── 展开状态（跨重建保留） ────────────────────────────────────────────────

/** diffKey → 已展开折叠块的起始下标（下标口径 = diff.ts 的 lines 数组）。 */
const expandedFolds = new Map<string, Set<number>>();

/** 32 位 FNV-1a 摘要：只用于区分同一卡片的不同文本版本，不承载安全语义。 */
const digest = (text: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  }
  return (hash >>> 0).toString(36);
};

/** 状态键：文件名 + 两侧文本的长度与摘要（文本一变即换桶，旧状态自然失效）。 */
const diffKeyOf = (
  fileName: string,
  oldText: string,
  newText: string,
): string =>
  `${fileName}\u0000${oldText.length}:${digest(oldText)}:${newText.length}:${digest(newText)}`;

/** 取（或新建）某个 diff 的展开状态桶，命中即刷新 LRU 位置。 */
const foldStateOf = (key: string): Set<number> => {
  const existing = expandedFolds.get(key);
  if (existing) {
    expandedFolds.delete(key);
    expandedFolds.set(key, existing);
    return existing;
  }
  const created = new Set<number>();
  expandedFolds.set(key, created);
  if (expandedFolds.size > MAX_TRACKED_DIFFS) {
    const oldest = expandedFolds.keys().next().value;
    if (oldest !== undefined) expandedFolds.delete(oldest);
  }
  return created;
};

// ── 渲染小件 ──────────────────────────────────────────────────────────────

/** 渲染行数上限：非法值回退默认值，再夹到硬上限。 */
const clampMaxLines = (value?: number): number => {
  const raw = Math.floor(value ?? DEFAULT_MAX_LINES);
  const safe = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_LINES;
  return Math.min(RENDER_LINE_CAP, safe);
};

/** 某一侧最大行号的位数（写进 CSS 变量，行号列宽度自适应且右对齐）。 */
const lineDigits = (
  lines: DiffLine[],
  side: "old" | "new",
  offset: number,
): number => {
  let max = 0;
  for (const line of lines) {
    const value = side === "old" ? line.oldLine : line.newLine;
    if (value !== null && value > max) max = value;
  }
  return String(max + offset).length;
};

/** 头部统计徽章配色：无改动弱化、纯新增绿、纯删除红、混合中性。 */
const statsVariant = (stats: {
  additions: number;
  deletions: number;
}): "ok" | "err" | "muted" | undefined => {
  if (stats.additions === 0 && stats.deletions === 0) return "muted";
  if (stats.deletions === 0) return "ok";
  if (stats.additions === 0) return "err";
  return undefined;
};

/** 头部：文件名 + `+additions -deletions` 统计。 */
const createHead = (
  fileName: string,
  stats: { additions: number; deletions: number },
): HTMLElement => {
  const head = el("div", "tc-diff-head");
  head.append(
    fileIconEl(fileName || t("remote.toolCall.diff.file"), {
      className: "tc-diff-icon",
    }),
  );
  const label = fileName || t("remote.toolCall.diff.file");
  const name = el("span", "tc-diff-name", label);
  name.title = label;
  head.append(name);
  const badge = tcBadge(
    t("remote.toolCall.diff.stats", {
      additions: stats.additions,
      deletions: stats.deletions,
    }),
    statsVariant(stats),
  );
  badge.classList.add("tc-diff-stats");
  head.append(badge);
  return head;
};

const SIGNS: Record<DiffLine["kind"], string> = {
  add: "+",
  del: "-",
  ctx: " ",
};

/** 行号文本：该侧无行号时为空串（保持两列宽度稳定）。 */
const numberText = (value: number | null, offset: number): string =>
  value === null ? "" : String(value + offset);

/** 单行节点：[旧行号][新行号][符号][文本]（文本走 textContent，原样保留空格）。 */
const lineNode = (line: DiffLine, offset: number): HTMLElement => {
  const row = el("div", `tc-diff-line ${line.kind}`);
  row.append(
    el("span", "tc-diff-no", numberText(line.oldLine, offset)),
    el("span", "tc-diff-no", numberText(line.newLine, offset)),
    el("span", "tc-diff-sign", SIGNS[line.kind]),
    el("span", "tc-diff-code", line.text),
  );
  return row;
};

/** 折叠条：点击就地展开（状态写进模块级 Map，卡片重建后仍保持展开）。 */
const foldNode = (count: number, onExpand: () => void): HTMLButtonElement => {
  const label = t("remote.toolCall.diff.foldedLines", { count });
  const hint = t("remote.toolCall.diff.expand");
  const button = el("button", "tc-diff-fold");
  button.type = "button";
  button.title = hint;
  button.setAttribute("aria-label", `${label} · ${hint}`);
  button.append(
    iconSpan("chevrons-up", "tc-diff-fold-icon"),
    el("span", "tc-diff-fold-label", label),
  );
  button.addEventListener("click", onExpand);
  return button;
};

// ── 行序列 ────────────────────────────────────────────────────────────────

/** 展示序列：真实行 + 被折叠的连续区间（区间下标口径 = diff.ts 的 lines）。 */
type DiffRow =
  | { kind: "line"; line: DiffLine }
  | { kind: "fold"; start: number; end: number };

/**
 * 由 diff 行序列生成展示序列：toHunks 未覆盖的区间即折叠块。
 * 无任何改动时返回空数组（调用方渲染「无差异」）。
 */
const diffRows = (lines: DiffLine[]): DiffRow[] => {
  const hunks = toHunks(lines, CONTEXT_RADIUS);
  if (hunks.length === 0) return [];
  const rows: DiffRow[] = [];
  let cursor = 0;
  for (const hunk of hunks) {
    if (hunk.start > cursor) {
      rows.push({ kind: "fold", start: cursor, end: hunk.start });
    }
    for (const line of hunk.lines) rows.push({ kind: "line", line });
    cursor = hunk.start + hunk.lines.length;
  }
  if (cursor < lines.length) {
    rows.push({ kind: "fold", start: cursor, end: lines.length });
  }
  return rows;
};

// ── 入口 ──────────────────────────────────────────────────────────────────

/**
 * 创建 unified diff 视图。
 *
 * 调用方只需给出文件名与旧 / 新文本；行号、上下文折叠、展开状态保持、降级与
 * 截断提示全部内部处理。oldText 为空串表示新建 / 写入（整篇按新增渲染）。
 */
export const renderDiffView = (options: DiffViewOptions): HTMLElement => {
  const { fileName, oldText, newText } = options;
  const start =
    typeof options.startLine === "number" && Number.isFinite(options.startLine)
      ? Math.floor(options.startLine)
      : 1;
  const offset = Math.max(0, start - 1);
  const limit = clampMaxLines(options.maxLines);
  const lines = options.lines ?? computeLineDiff(oldText, newText);
  const expanded = foldStateOf(diffKeyOf(fileName, oldText, newText));

  const root = el("div", "tc-diff");
  // 行号列宽按两侧最大行号的位数取，超宽不会挤掉符号列。
  root.style.setProperty(
    "--tc-diff-old-digits",
    String(lineDigits(lines, "old", offset)),
  );
  root.style.setProperty(
    "--tc-diff-new-digits",
    String(lineDigits(lines, "new", offset)),
  );
  root.append(createHead(fileName, diffStats(lines)));

  if (isDiffTooLarge(oldText, newText)) {
    root.append(
      el(
        "div",
        "tc-diff-note tc-diff-warn",
        t("remote.toolCall.diff.tooLarge"),
      ),
    );
  }

  const rows = diffRows(lines);
  if (rows.length === 0) {
    root.append(el("div", "tc-diff-note", t("remote.toolCall.diff.noDiff")));
    return root;
  }

  const body = el("div", "tc-diff-body");

  /** 按当前展开状态重建行区（折叠状态变化后就地重绘，逻辑与首次渲染一致）。 */
  const renderBody = (): void => {
    body.replaceChildren();
    let used = 0;
    let cut = false;
    // 行数预算：超预算即停止渲染并标记截断（已展开的折叠块同样计入）。
    const push = (node: HTMLElement): boolean => {
      if (used >= limit) {
        cut = true;
        return false;
      }
      used += 1;
      body.append(node);
      return true;
    };

    for (const row of rows) {
      if (row.kind === "line") {
        if (!push(lineNode(row.line, offset))) break;
        continue;
      }
      if (expanded.has(row.start)) {
        let room = true;
        for (let i = row.start; i < row.end && room; i += 1) {
          room = push(lineNode(lines[i], offset));
        }
        if (!room) break;
        continue;
      }
      if (used >= limit) {
        cut = true;
        break;
      }
      body.append(
        foldNode(row.end - row.start, () => {
          expanded.add(row.start);
          renderBody();
        }),
      );
    }

    if (cut) {
      body.append(
        el(
          "div",
          "tc-diff-note",
          t("remote.toolCall.diff.truncated", { count: limit }),
        ),
      );
    }
  };

  renderBody();
  root.append(body);
  return root;
};
