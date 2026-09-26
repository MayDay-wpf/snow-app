/**
 * search 工具族卡片：检索与代码智能类工具调用（移动端只读视图）。
 *
 * 归口工具：
 * - `grep-search`   → 文本检索卡片（检索条件 + 按文件分组的命中行）；
 * - `codebase-search` → 代码库语义检索卡片（进度行 + 分块结果 + 检索管线）；
 * - `codelens-find_definition` / `codelens-find_references` / `codelens-file_outline`
 *                   → 代码透镜卡片（符号定位 / 引用分组清单 / 文件大纲）；
 * - 前缀 `lsp-`      → 语言服务器卡片（诊断 / 悬停 / 跳转 / 引用 / 符号 / 重命名 /
 *   代码修复 / 执行命令 / 调用链 / 类型层级 / 全局符号 / 工作区诊断 / 漏洞检查）。
 *
 * 字段结构以桌面端同名卡片（renderer/…/toolCalls/{Grep,Codebase,CodeLens,Lsp}ToolCall.tsx）
 * 与 Rust 侧输出（native/src/mcp/servers/lsp/format.rs、servers/{grep,codebase}.rs）为准：
 * 字段缺失只是少渲染一行，绝不抛错；lsp 各操作的字段同名冲突（如 `files` 同时被批量
 * 诊断与重命名使用）时用操作名消歧。
 *
 * 解析约定（与 tools/ui.ts 一致）：
 * - 数据一律 createElement + textContent，只有静态图标标记走 innerHTML；
 * - 远控桥全量下发 arguments / result（不截断）；历史会话的旧版快照可能是
 *   半截 JSON，parseJsonRecord 解析失败时回退原文展示；
 * - 列表条数上限 MAX_ROWS，超出部分只报「已省略 n 条」；行数超 FOLD_ROWS 时挂
 *   .tc-fold，展开态由 timeline.ts 的 .tc-more 事件委托接管；
 * - 参数与结果都无法解析时返回 null，交回框架兜底卡（tools/index.ts 的候选回退）。
 */

import type { SnowRemoteToolCall } from "../../renderer/types/remoteControl";
import { t } from "../i18n";
import { iconMarkup, type MobileIconName } from "../icons";
import type { ToolModule } from "./types";
import {
  argsSummary,
  createToolNode,
  decodeEscapedNewlines,
  formatJson,
  parseJsonRecord,
  resolveStatus,
  tcBadge,
  tcErrorRow,
  tcKv,
  tcPre,
  tcSection,
  type JsonRecord,
} from "./ui";

// ── 常量 ────────────────────────────────────────────────────────────────────

/** 列表条数上限：超出部分不渲染，只显示「已省略 n 条」。 */
const MAX_ROWS = 50;
/** 行列表折叠阈值（行数超过它才挂 .tc-fold）。 */
const FOLD_ROWS = 12;
/** 头部摘要截断长度（与桌面端 60 字符的 displayName 规则一致）。 */
const DISPLAY_MAX_CHARS = 60;
/** 单行补充信息（详情 / 诊断消息）截断长度。 */
const NOTE_MAX_CHARS = 160;

// ── 词条 ────────────────────────────────────────────────────────────────────

const tr = (key: string, values?: Record<string, string | number>): string =>
  t(`remote.toolCall.search.${key}`, values);

// ── 解析小工具 ──────────────────────────────────────────────────────────────

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readString = (record: JsonRecord, key: string): string | undefined =>
  typeof record[key] === "string" ? (record[key] as string) : undefined;

const readNumber = (record: JsonRecord, key: string): number | undefined => {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
};

const readBoolean = (record: JsonRecord, key: string): boolean | undefined =>
  typeof record[key] === "boolean" ? (record[key] as boolean) : undefined;

const readArray = (record: JsonRecord, key: string): unknown[] | undefined =>
  Array.isArray(record[key]) ? (record[key] as unknown[]) : undefined;

/** 数组里的非对象元素直接丢弃。 */
const records = (values?: unknown[]): JsonRecord[] =>
  (values ?? []).filter(isRecord);

/** 空串 / null / 缺省一律视为「无」。 */
const optional = (value?: string | null): string | undefined =>
  value === undefined || value === null || value === "" ? undefined : value;

/** 文件基名：`a/b/c.ts` → `c.ts`（Windows / POSIX 分隔符都接受）。 */
const fileName = (filePath: string): string =>
  filePath.split(/[\\/]/).filter(Boolean).pop() || filePath;

/** 单行截断。 */
const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}…` : text;

/** 相似度百分比（与桌面 CodebaseToolCall.formatScore 同规则）。 */
const formatScore = (score: number): string =>
  `${score >= 0.8 ? (score * 100).toFixed(0) : (score * 100).toFixed(1)}%`;

/** file:// URI → 本地路径（Windows: file:///E:/…；解码失败时退回去掉协议头的原文）。 */
const uriToPath = (uri: string): string => {
  try {
    return decodeURIComponent(uri.replace(/^file:\/\//i, ""));
  } catch {
    return uri.replace(/^file:\/\//i, "");
  }
};

/** 按 key 分组：组内保持原顺序，组间按 key 排序。 */
const groupBy = <T>(
  items: T[],
  keyOf: (item: T) => string,
): [string, T[]][] => {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const bucket = groups.get(key);
    if (bucket) bucket.push(item);
    else groups.set(key, [item]);
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
};

/** 条目截断：超出 MAX_ROWS 的部分不渲染，只回传条数供「已省略」提示使用。 */
const capEntries = <T>(items: T[]): { shown: T[]; omitted: number } => ({
  shown: items.slice(0, MAX_ROWS),
  omitted: Math.max(0, items.length - MAX_ROWS),
});

/**
 * 参数与结果都无法解析（半截 JSON / JSON 数组 / 纯文本）时，本模块给不出比兜底卡
 * 更好的展示，返回 null 交回框架继续尝试（见 tools/types.ts 的候选回退约定）。
 */
const unparsable = (tool: SnowRemoteToolCall): boolean =>
  Boolean(tool.arguments) &&
  Boolean(tool.result) &&
  parseJsonRecord(tool.arguments) === null &&
  parseJsonRecord(tool.result) === null;

// ── DOM 小工具 ──────────────────────────────────────────────────────────────

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

/** 图标占位（只承载 lucide 静态标记，不含任何数据）。 */
const iconSpan = (name: MobileIconName, className: string): HTMLSpanElement => {
  const span = el("span", className);
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = iconMarkup(name);
  return span;
};

const textSpan = (className: string, text: string): HTMLSpanElement => {
  const span = el("span", className);
  span.textContent = text;
  return span;
};

/** 内联等宽值（模式 / 路径 / 符号名 / 命令）。 */
const mono = (text: string): HTMLElement => el("code", "tc-search-mono", text);

/** 代码片段（保留缩进与换行）。 */
const snippet = (text: string): HTMLElement =>
  el("code", "tc-search-code", decodeEscapedNewlines(text));

/** 参数行（isMono → 值等宽）。 */
const kv = (label: string, value: string, isMono = false): HTMLElement => {
  const node = tcKv(label, value);
  if (isMono)
    node.querySelector(".tc-kv-value")?.classList.add("tc-search-mono");
  return node;
};

const paramsHost = (...children: Node[]): HTMLElement => {
  const host = el("div", "tc-search-params");
  host.append(...children);
  return host;
};

const flagsHost = (...children: Node[]): HTMLElement => {
  const host = el("div", "tc-search-flags");
  host.append(...children);
  return host;
};

/** 徽章（可带图标与色调修饰）。 */
const badge = (
  text: string,
  options?: {
    icon?: MobileIconName;
    variant?: "ok" | "warn" | "info" | "muted";
  },
): HTMLElement => {
  const node = tcBadge(text);
  if (options?.variant)
    node.classList.add(`tc-search-badge-${options.variant}`);
  if (options?.icon) node.prepend(iconSpan(options.icon, "tc-search-ico"));
  return node;
};

/** 提示 / 空结果 / 进度行：图标 + 文案。 */
const noteRow = (
  kind: "note" | "empty" | "progress",
  icon: MobileIconName,
  text: string,
): HTMLElement => {
  const node = el("div", `tc-search-${kind}`);
  node.append(
    iconSpan(icon, "tc-search-ico"),
    textSpan("tc-search-note-text", text),
  );
  return node;
};

/** 通用行：位置 / 徽章 / 片段等按顺序排布，窄屏自动换行。 */
const row = (...parts: (Node | string)[]): HTMLElement => {
  const node = el("div", "tc-search-row");
  node.append(...parts);
  return node;
};

/** 结果区块：小标题（可带图标）+ 内容。 */
const section = (
  label: string,
  content: Node,
  icon?: MobileIconName,
): HTMLElement => tcSection(label, content, icon ? { icon } : undefined);

/** 折叠按钮（双文案由 base.css 按 .tc-expanded 切换，timeline 委托负责折叠态）。 */
const moreButton = (hidden: number): HTMLButtonElement => {
  const button = el("button", "tc-more");
  button.type = "button";
  button.setAttribute("aria-expanded", "false");
  button.append(
    textSpan("tc-more-show", tr("more", { count: hidden })),
    textSpan("tc-more-hide", tr("collapse")),
    iconSpan("chevron-down", "tc-more-icon"),
  );
  return button;
};

/** 行列表：折叠（FOLD_ROWS）+ 省略提示（omitted 条未渲染）。 */
const listBlock = (rows: Node[], omitted = 0): HTMLElement => {
  const host = el("div", "tc-search-list");
  const body = el("div", "tc-fold-body");
  body.append(...rows);
  host.append(body);
  if (rows.length > FOLD_ROWS) {
    host.classList.add("tc-fold");
    host.style.setProperty("--tc-fold-lines", String(FOLD_ROWS));
    host.append(moreButton(rows.length - FOLD_ROWS));
  }
  if (omitted > 0) {
    host.append(
      el("div", "tc-search-omitted", tr("omitted", { count: omitted })),
    );
  }
  return host;
};

/** 文件分组头：图标 + 文件名 + 完整路径 + 计数。 */
const fileHead = (filePath: string, count: number): HTMLElement => {
  const head = el("div", "tc-search-file-head");
  head.title = filePath;
  head.append(
    iconSpan("file", "tc-search-ico"),
    textSpan("tc-search-file-name", fileName(filePath)),
    textSpan("tc-search-file-path", filePath),
    textSpan("tc-search-file-count", String(count)),
  );
  return head;
};

/** 文件分组：分组头 + 内容。 */
const fileGroup = (
  filePath: string,
  count: number,
  content: Node,
): HTMLElement => {
  const group = el("div", "tc-search-file");
  group.append(fileHead(filePath, count), content);
  return group;
};

const groupsHost = (...children: Node[]): HTMLElement => {
  const host = el("div", "tc-search-groups");
  host.append(...children);
  return host;
};

const stepsHost = (...children: Node[]): HTMLElement => {
  const host = el("div", "tc-search-steps");
  host.append(...children);
  return host;
};

/** 进度步骤行（done → 勾选；active → 转圈，均带文案）。 */
const stepRow = (state: "done" | "active", text: string): HTMLElement => {
  const step = el("div", `tc-search-step tc-search-step-${state}`);
  step.append(
    iconSpan(
      state === "done" ? "circle-check" : "loader-circle",
      "tc-search-ico",
    ),
    textSpan("tc-search-step-text", text),
  );
  return step;
};

// ── 位置 / 符号 / 诊断 ──────────────────────────────────────────────────────

type Location = {
  filePath: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
};

/** 位置对象（filePath + line + column 齐全才算有效）。 */
const parseLocation = (value: unknown): Location | null => {
  if (!isRecord(value)) return null;
  const filePath = readString(value, "filePath");
  const line = readNumber(value, "line");
  const column = readNumber(value, "column");
  if (filePath === undefined || line === undefined || column === undefined) {
    return null;
  }
  return {
    filePath,
    line,
    column,
    endLine: readNumber(value, "endLine"),
    endColumn: readNumber(value, "endColumn"),
  };
};

const locations = (values?: unknown[]): Location[] =>
  (values ?? [])
    .map(parseLocation)
    .filter((location): location is Location => location !== null);

const locationText = (location: Location): string =>
  `${location.filePath}:${location.line}:${location.column}`;

/** `行:列[ → 结束行:列]`。 */
const positionText = (location: Location): string =>
  location.endLine === undefined || location.endColumn === undefined
    ? `${location.line}:${location.column}`
    : `${location.line}:${location.column} → ${location.endLine}:${location.endColumn}`;

/** 位置行：图标 + 文件名 + `行:列`（title 保留完整路径）。 */
const locationLine = (
  location: Location,
  options?: { icon?: MobileIconName; suffix?: Node },
): HTMLElement => {
  const node = el("div", "tc-search-loc-row");
  node.title = locationText(location);
  node.append(
    iconSpan(options?.icon ?? "target", "tc-search-ico"),
    textSpan("tc-search-loc-name", fileName(location.filePath)),
    textSpan("tc-search-loc", positionText(location)),
  );
  if (options?.suffix) node.append(options.suffix);
  return node;
};

type SymbolLine = {
  name: string;
  kind?: string;
  detail?: string;
  location?: Location;
  /** 没有 filePath 时的裸行号（如工作区符号缺位置）。 */
  line?: number;
  column?: number;
  /** 缩进层级（0 起；树形结构逐层 +1）。 */
  level?: number;
  exported?: boolean;
  /** 行尾补充信息（调用点数量等）。 */
  extra?: Node;
};

/** 符号行：缩进 + 类型徽章 + 名称 + 详情 + 位置（+ 导出标记 / 附加徽章）。 */
const symbolRow = (line: SymbolLine): HTMLElement => {
  const level = line.level ?? 0;
  const node = el(
    "div",
    level > 0
      ? `tc-search-row tc-search-lv${Math.min(level, 2)}`
      : "tc-search-row",
  );
  if (line.kind) node.append(badge(line.kind));
  node.append(mono(line.name));
  if (line.exported === true) {
    node.append(badge(tr("codelens.exported"), { variant: "ok" }));
  }
  if (line.location) {
    const text = `${fileName(line.location.filePath)}:${line.location.line}:${line.location.column}`;
    const loc = textSpan("tc-search-loc", text);
    loc.title = locationText(line.location);
    node.append(loc);
  } else if (line.line !== undefined && line.line > 0) {
    node.append(
      textSpan(
        "tc-search-loc",
        line.column === undefined
          ? String(line.line)
          : `${line.line}:${line.column}`,
      ),
    );
  }
  if (line.detail) {
    const detail = textSpan(
      "tc-search-sub",
      clip(decodeEscapedNewlines(line.detail), NOTE_MAX_CHARS),
    );
    detail.title = line.detail;
    node.append(detail);
  }
  if (line.extra) node.append(line.extra);
  return node;
};

/**
 * LSP documentSymbol 树 → 扁平符号行（先父后子，children 逐层缩进）。
 * `range.start` 优先，缺失时回退 `selection.start`（与 format.rs 输出形状一致）。
 */
const flattenSymbols = (values: unknown[], level = 0): SymbolLine[] => {
  const lines: SymbolLine[] = [];
  for (const value of records(values)) {
    const name = readString(value, "name");
    if (name === undefined) continue;
    const rangeStart =
      isRecord(value.range) && isRecord(value.range.start)
        ? value.range.start
        : null;
    const selectionStart =
      isRecord(value.selection) && isRecord(value.selection.start)
        ? value.selection.start
        : null;
    const start = rangeStart ?? selectionStart;
    const filePath = readString(value, "filePath");
    const line = start ? readNumber(start, "line") : readNumber(value, "line");
    const column = start
      ? readNumber(start, "column")
      : readNumber(value, "column");
    lines.push({
      name,
      kind: optional(readString(value, "kind")),
      detail: optional(readString(value, "detail")),
      line,
      column,
      location:
        filePath !== undefined && line !== undefined && column !== undefined
          ? { filePath, line, column }
          : undefined,
      level,
    });
    lines.push(
      ...flattenSymbols(readArray(value, "children") ?? [], level + 1),
    );
  }
  return lines;
};

/** 诊断等级 → CSS 修饰类（未知等级归 unknown，与桌面 severity-<x> 命名对齐）。 */
const SEVERITY_CLASSES: Record<string, string> = {
  error: "error",
  warning: "warning",
  warn: "warning",
  information: "information",
  info: "information",
  hint: "hint",
};

type Diagnostic = {
  severity?: string;
  message: string;
  line?: number;
  column?: number;
  source?: string;
  code?: string;
};

const parseDiagnostics = (values: unknown[]): Diagnostic[] =>
  records(values)
    .map((item): Diagnostic | null => {
      const message = readString(item, "message");
      if (message === undefined) return null;
      const code = item.code;
      return {
        severity: optional(readString(item, "severity")),
        message,
        line: readNumber(item, "line"),
        column: readNumber(item, "column"),
        source: optional(readString(item, "source")),
        code:
          readString(item, "code") ??
          (typeof code === "number" ? String(code) : undefined),
      };
    })
    .filter((item): item is Diagnostic => item !== null);

/** 诊断行：等级徽章 + 位置 + 消息 + 来源。 */
const diagnosticRow = (diagnostic: Diagnostic): HTMLElement => {
  const severity = (diagnostic.severity ?? "").toLowerCase();
  const node = el("div", "tc-search-row tc-search-diag");
  node.append(
    textSpan(
      `tc-search-sev tc-search-sev-${SEVERITY_CLASSES[severity] ?? "unknown"}`,
      diagnostic.severity ?? tr("severity.unknown"),
    ),
  );
  if (diagnostic.line !== undefined) {
    node.append(
      textSpan(
        "tc-search-loc",
        diagnostic.column === undefined
          ? String(diagnostic.line)
          : `${diagnostic.line}:${diagnostic.column}`,
      ),
    );
  }
  const message = textSpan("tc-search-diag-msg", clip(diagnostic.message, 200));
  message.title = diagnostic.message;
  node.append(message);
  const source = [diagnostic.source, diagnostic.code].filter(Boolean).join(" ");
  if (source) node.append(textSpan("tc-search-diag-src", source));
  return node;
};

/** 诊断行列表 + 条目上限（供单文件 / 批量 / 工作区诊断共用）。 */
const diagnosticRows = (values: unknown[]): HTMLElement => {
  const items = parseDiagnostics(values);
  const { shown, omitted } = capEntries(items);
  return listBlock(shown.map(diagnosticRow), omitted);
};

// ── grep-search ─────────────────────────────────────────────────────────────

type GrepArgs = {
  pattern?: string;
  path?: string;
  fileGlob?: string;
  isRegex?: boolean;
  caseSensitive?: boolean;
  maxResults?: number;
};

type GrepMatch = { file: string; line: number; content: string };

/** grep 参数（缺失字段一律 undefined，半截 JSON 返回 null）。 */
const parseGrepArgs = (raw?: string): GrepArgs | null => {
  const record = parseJsonRecord(raw);
  if (!record) return null;
  return {
    pattern: optional(readString(record, "pattern")),
    path: optional(readString(record, "path")),
    fileGlob:
      optional(readString(record, "fileGlob")) ??
      optional(readString(record, "glob")),
    isRegex: readBoolean(record, "isRegex"),
    caseSensitive: readBoolean(record, "caseSensitive"),
    maxResults: readNumber(record, "maxResults"),
  };
};

/** 命中条目：file / line / content 三要素齐全才保留（与桌面端过滤规则一致）。 */
const parseGrepMatches = (values: unknown[]): GrepMatch[] =>
  records(values)
    .map((item): GrepMatch | null => {
      const file = readString(item, "file");
      const line = readNumber(item, "line");
      const content = readString(item, "content");
      if (file === undefined || line === undefined || content === undefined) {
        return null;
      }
      return { file, line, content };
    })
    .filter((match): match is GrepMatch => match !== null);

const renderGrep = (tool: SnowRemoteToolCall): HTMLElement | null => {
  if (unparsable(tool)) return null;

  const args = parseGrepArgs(tool.arguments);
  const record = parseJsonRecord(tool.result);
  const error = optional(record ? readString(record, "error") : undefined);
  const matches =
    record && Array.isArray(record.matches)
      ? parseGrepMatches(record.matches)
      : null;
  // 结果里回显了检索条件（grep.rs 输出 pattern/path/fileGlob），旧版快照参数为半截 JSON 时用它兜底。
  const pattern =
    optional(args?.pattern) ??
    optional(record ? readString(record, "pattern") : undefined) ??
    "";
  const searchPath =
    optional(args?.path) ??
    optional(record ? readString(record, "path") : undefined);
  const fileGlob =
    optional(args?.fileGlob) ??
    optional(record ? readString(record, "fileGlob") : undefined);
  const backend = optional(record ? readString(record, "backend") : undefined);
  const truncated = record ? readBoolean(record, "truncated") === true : false;
  const totalMatches = matches
    ? ((record ? readNumber(record, "totalMatches") : undefined) ??
      matches.length)
    : 0;

  const body = document.createDocumentFragment();

  // 检索条件
  const params: Node[] = [];
  if (pattern) params.push(kv(tr("label.pattern"), pattern, true));
  if (searchPath) params.push(kv(tr("label.path"), searchPath, true));
  if (fileGlob) params.push(kv(tr("label.glob"), fileGlob, true));
  if (args?.maxResults !== undefined) {
    params.push(kv(tr("label.maxResults"), String(args.maxResults)));
  }
  if (params.length) body.append(paramsHost(...params));

  // 检索开关 + 后端
  const flags: Node[] = [];
  if (args?.isRegex !== undefined) {
    flags.push(
      args.isRegex
        ? badge(tr("grep.regex"), { icon: "regex" })
        : badge(tr("grep.literal")),
    );
  }
  if (args?.caseSensitive !== undefined) {
    flags.push(
      badge(
        tr(args.caseSensitive ? "grep.caseSensitive" : "grep.caseInsensitive"),
      ),
    );
  }
  if (backend) {
    flags.push(
      badge(`${tr("label.backend")}: ${backend}`, { icon: "circle-check" }),
    );
  }
  if (truncated) flags.push(badge(tr("truncated"), { variant: "warn" }));
  if (flags.length) body.append(flagsHost(...flags));

  // 结果
  if (error) {
    body.append(tcErrorRow(error));
  } else if (matches) {
    if (!matches.length) {
      body.append(noteRow("empty", "search", tr("grep.noMatches")));
    } else {
      const { shown, omitted } = capEntries(matches);
      const rows: Node[] = [];
      for (const [file, items] of groupBy(shown, (match) => match.file)) {
        rows.push(fileHead(file, items.length));
        for (const item of items) {
          rows.push(
            row(
              textSpan("tc-search-line", String(item.line)),
              snippet(item.content),
            ),
          );
        }
      }
      body.append(
        section(tr("label.matches"), listBlock(rows, omitted), "search"),
      );
    }
  } else if (record) {
    body.append(
      section(tr("result"), tcPre(decodeEscapedNewlines(tool.result ?? ""))),
    );
  } else {
    body.append(
      noteRow(
        "note",
        "search",
        tool.status === "running" ? tr("running") : tr("waiting"),
      ),
    );
  }

  const meta: Node[] = [];
  if (matches) {
    meta.push(
      badge(tr("grep.matchCount", { count: totalMatches }), {
        variant: totalMatches > 0 ? "ok" : "muted",
      }),
    );
    const fileCount = new Set(matches.map((match) => match.file)).size;
    if (fileCount > 0) meta.push(badge(tr("fileCount", { count: fileCount })));
  }

  return createToolNode({
    tool,
    status: resolveStatus(tool),
    badge: tr("grep.name"),
    display: pattern
      ? clip(pattern, DISPLAY_MAX_CHARS)
      : argsSummary(tool.arguments),
    displayTitle:
      [pattern, fileGlob, searchPath].filter(Boolean).join(" · ") || undefined,
    meta,
    className: "tc-search-grep",
    bodyClass: "tc-search",
    body,
  });
};

// ── codebase-search ─────────────────────────────────────────────────────────

type CodebaseArgs = { query?: string; topN?: number };

type CodebaseChunk = {
  relativePath: string;
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  score: number;
};

type CodebasePipeline = {
  type: string;
  attempts: number;
  refinedQuery?: string;
};

type CodebaseProgress = {
  phase: string;
  attempt: number;
  totalCount: number;
  relevantCount?: number;
  refinedQuery?: string;
};

/** pipeline.type → 词条键 / 图标（与桌面 pipelineBadge 一一对应）。 */
const PIPELINE_META: Record<string, { key: string; icon: MobileIconName }> = {
  cosine: { key: "codebase.pipeline.cosine", icon: "search" },
  reranking: { key: "codebase.pipeline.reranking", icon: "sparkles" },
  agent_review: { key: "codebase.pipeline.agentReview", icon: "brain-circuit" },
};

const parseCodebaseArgs = (raw?: string): CodebaseArgs | null => {
  const record = parseJsonRecord(raw);
  if (!record) return null;
  return {
    query: optional(readString(record, "query")),
    topN: readNumber(record, "topN"),
  };
};

/** 分块结果（相对路径为分组键；缺失时回退绝对路径，避免整表并成一组）。 */
const parseCodebaseChunks = (values: unknown[]): CodebaseChunk[] =>
  records(values)
    .map((item): CodebaseChunk | null => {
      const content = readString(item, "content");
      const filePath = readString(item, "filePath");
      const group = optional(readString(item, "relativePath")) ?? filePath;
      if (content === undefined || group === undefined) return null;
      return {
        relativePath: group,
        filePath: filePath ?? group,
        startLine: readNumber(item, "startLine") ?? 0,
        endLine: readNumber(item, "endLine") ?? 0,
        score: readNumber(item, "score") ?? 0,
        content,
      };
    })
    .filter((chunk): chunk is CodebaseChunk => chunk !== null);

const parseCodebasePipeline = (value: unknown): CodebasePipeline | null => {
  if (!isRecord(value)) return null;
  const type = optional(readString(value, "type")) ?? "cosine";
  return {
    type,
    attempts: readNumber(value, "attempts") ?? 1,
    refinedQuery: optional(readString(value, "refinedQuery")),
  };
};

/** streamingStdout 里最后一条 codebase_review_progress 事件（半截行直接跳过）。 */
const lastProgress = (stdout?: string): CodebaseProgress | null => {
  if (!stdout) return null;
  const lines = stdout.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line.startsWith("{")) continue;
    const record = parseJsonRecord(line);
    if (!record || record.type !== "codebase_review_progress") continue;
    const phase = readString(record, "phase");
    const attempt = readNumber(record, "attempt");
    const totalCount = readNumber(record, "totalCount");
    if (
      phase === undefined ||
      attempt === undefined ||
      totalCount === undefined
    ) {
      continue;
    }
    return {
      phase,
      attempt,
      totalCount,
      relevantCount: readNumber(record, "relevantCount"),
      refinedQuery: optional(readString(record, "refinedQuery")),
    };
  }
  return null;
};

/** 进度文案（phase → 文案，未知 phase 按「处理结果」处理）。 */
const progressText = (progress: CodebaseProgress): string => {
  if (progress.phase === "reviewing") {
    return tr("codebase.progress.reviewing", {
      attempt: progress.attempt,
      total: progress.totalCount,
    });
  }
  if (progress.phase === "re_searching") {
    return tr("codebase.progress.reSearching", { attempt: progress.attempt });
  }
  return tr("codebase.progress.processing");
};

const renderCodebase = (tool: SnowRemoteToolCall): HTMLElement | null => {
  if (unparsable(tool)) return null;

  const args = parseCodebaseArgs(tool.arguments);
  const record = parseJsonRecord(tool.result);
  const error = optional(record ? readString(record, "error") : undefined);
  const chunks =
    record && Array.isArray(record.results)
      ? parseCodebaseChunks(record.results)
      : null;
  const query =
    optional(args?.query) ??
    optional(record ? readString(record, "query") : undefined) ??
    "";
  const pipeline = record ? parseCodebasePipeline(record.pipeline) : null;
  const totalResults = chunks
    ? ((record ? readNumber(record, "totalResults") : undefined) ??
      chunks.length)
    : 0;
  const body = document.createDocumentFragment();

  // 执行中的管线进度（embedding / searching 固定已完成，第三条跟随最新事件）
  if (tool.status === "running") {
    const progress = lastProgress(tool.streamingStdout);
    const active = el("div", "tc-search-step tc-search-step-active");
    active.append(iconSpan("loader-circle", "tc-search-ico"));
    active.append(
      textSpan(
        "tc-search-step-text",
        progress ? progressText(progress) : tr("codebase.progress.processing"),
      ),
    );
    if (progress?.relevantCount !== undefined) {
      active.append(
        textSpan(
          "tc-search-step-counts",
          tr("codebase.progress.relevant", {
            relevant: progress.relevantCount,
            total: progress.totalCount,
          }),
        ),
      );
    }
    if (progress?.refinedQuery) {
      active.append(mono(clip(progress.refinedQuery, DISPLAY_MAX_CHARS)));
    }
    body.append(
      stepsHost(
        stepRow("done", tr("codebase.progress.embedding")),
        stepRow("done", tr("codebase.progress.searching")),
        active,
      ),
    );
  }

  // 检索条件
  const params: Node[] = [];
  if (query) params.push(kv(tr("label.query"), query, true));
  if (args?.topN !== undefined) {
    params.push(kv(tr("label.topN"), String(args.topN)));
  }
  if (params.length) body.append(paramsHost(...params));

  // 检索管线
  const flags: Node[] = [];
  if (pipeline) {
    const meta = PIPELINE_META[pipeline.type] ?? PIPELINE_META.cosine;
    flags.push(badge(tr(meta.key), { icon: meta.icon }));
    if (pipeline.attempts > 1) {
      flags.push(
        badge(tr("codebase.pipeline.attempts", { count: pipeline.attempts }), {
          variant: "info",
        }),
      );
    }
  }
  if (flags.length) body.append(flagsHost(...flags));
  if (pipeline?.refinedQuery) {
    body.append(
      paramsHost(
        kv(tr("codebase.pipeline.refinedQuery"), pipeline.refinedQuery, true),
      ),
    );
  }

  // 结果
  if (error) {
    body.append(tcErrorRow(error));
  } else if (chunks) {
    if (!chunks.length) {
      body.append(noteRow("empty", "folder-search", tr("codebase.noResults")));
    } else {
      const { shown, omitted } = capEntries(chunks);
      const rows: Node[] = [];
      for (const [file, items] of groupBy(
        shown,
        (chunk) => chunk.relativePath,
      )) {
        const blocks = items.map((chunk) => {
          const range =
            chunk.startLine > 0 && chunk.endLine > 0
              ? `${chunk.startLine}-${chunk.endLine}`
              : "";
          const head = el("div", "tc-search-chunk-head");
          head.title = chunk.filePath;
          head.append(
            iconSpan("file", "tc-search-ico"),
            textSpan("tc-search-loc", range || fileName(chunk.relativePath)),
            badge(formatScore(chunk.score), { variant: "info" }),
          );
          const block = el("div", "tc-search-chunk");
          block.append(head, tcPre(chunk.content, { maxLines: 20 }));
          return block;
        });
        rows.push(fileHead(file, items.length), ...blocks);
      }
      body.append(
        section(tr("label.results"), listBlock(rows, omitted), "database"),
      );
    }
  } else if (record) {
    body.append(
      section(tr("result"), tcPre(decodeEscapedNewlines(tool.result ?? ""))),
    );
  } else if (tool.status !== "running") {
    body.append(noteRow("note", "database", tr("waiting")));
  }

  const meta: Node[] = [];
  if (chunks) {
    meta.push(
      badge(tr("codebase.resultCount", { count: totalResults }), {
        variant: totalResults > 0 ? "ok" : "muted",
      }),
    );
    const fileCount = new Set(chunks.map((chunk) => chunk.relativePath)).size;
    if (fileCount > 0) meta.push(badge(tr("fileCount", { count: fileCount })));
  }

  return createToolNode({
    tool,
    status: resolveStatus(tool),
    badge: tr("codebase.name"),
    display: query
      ? clip(query, DISPLAY_MAX_CHARS)
      : argsSummary(tool.arguments),
    displayTitle: query || undefined,
    meta,
    className: "tc-search-codebase",
    bodyClass: "tc-search",
    body,
  });
};

// ── codelens-* ──────────────────────────────────────────────────────────────

type CodelensRender = (tool: SnowRemoteToolCall) => HTMLElement | null;

/** 位置类参数行（`文件:行:列`，仅 filePath 时退化为路径）。 */
const fileParamRows = (
  filePath?: string,
  line?: number,
  column?: number,
): Node[] =>
  filePath
    ? [
        kv(
          tr("label.file"),
          line !== undefined && column !== undefined
            ? `${filePath}:${line}:${column}`
            : filePath,
          true,
        ),
      ]
    : [];

/** 结果为空（无 result）时的等待行 / 原文兜底。 */
const resultFallback = (tool: SnowRemoteToolCall): Node =>
  parseJsonRecord(tool.result)
    ? section(tr("result"), tcPre(decodeEscapedNewlines(tool.result ?? "")))
    : noteRow(
        "note",
        "scan-search",
        tool.status === "running" ? tr("running") : tr("waiting"),
      );

/**
 * codelens-find_definition：符号卡片（名称 / 类型 / 导出 / 范围 + 位置），
 * LSP 路径会附带完整 definitions 列表（首个为 location）。
 */
const renderFindDefinition: CodelensRender = (tool) => {
  if (unparsable(tool)) return null;

  const args = parseJsonRecord(tool.arguments);
  const record = parseJsonRecord(tool.result);
  const filePath = optional(args ? readString(args, "filePath") : undefined);
  const line = args ? readNumber(args, "line") : undefined;
  const column = args ? readNumber(args, "column") : undefined;
  const error = optional(record ? readString(record, "error") : undefined);
  const message = optional(record ? readString(record, "message") : undefined);

  const body = document.createDocumentFragment();
  const meta: Node[] = [];
  let display: string | undefined;

  const params = fileParamRows(filePath, line, column);
  if (params.length) body.append(paramsHost(...params));

  if (error) {
    body.append(tcErrorRow(error));
  } else if (record && typeof record.found === "boolean") {
    const found = record.found === true;
    const name = optional(readString(record, "name"));
    const kind = optional(readString(record, "kind"));
    const containerName = optional(readString(record, "containerName"));
    const isExported = readBoolean(record, "isExported");
    const scope = optional(readString(record, "searchScope"));
    const location = parseLocation(record.location);
    const definitions = locations(readArray(record, "definitions"));
    const count = readNumber(record, "count") ?? definitions.length;
    display = name ?? (location ? fileName(location.filePath) : undefined);

    meta.push(
      badge(tr(found ? "codelens.found" : "codelens.notFound"), {
        variant: found ? "ok" : "muted",
      }),
    );

    if (!found) {
      body.append(
        noteRow("empty", "circle-x", message ?? tr("codelens.noSymbol")),
      );
    } else {
      const card = el("div", "tc-search-symbol");
      const head = el("div", "tc-search-sym-head");
      head.append(iconSpan("target", "tc-search-ico"));
      if (name) head.append(mono(name));
      if (kind) head.append(badge(kind));
      if (isExported !== undefined) {
        head.append(
          badge(tr(isExported ? "codelens.exported" : "codelens.local"), {
            variant: isExported ? "ok" : "muted",
          }),
        );
      }
      if (scope) {
        head.append(
          badge(
            tr(
              scope === "file" ? "codelens.scopeFile" : "codelens.scopeProject",
            ),
          ),
        );
      }
      card.append(head);
      if (location) card.append(locationLine(location));
      if (containerName) {
        card.append(kv(tr("label.container"), containerName, true));
      }
      body.append(card);

      if (definitions.length > 1) {
        meta.push(
          badge(tr("lsp.definitionsCount", { count }), { variant: "ok" }),
        );
        const { shown, omitted } = capEntries(definitions);
        body.append(
          section(
            tr("label.definition"),
            listBlock(
              shown.map((item) => locationLine(item)),
              omitted,
            ),
          ),
        );
      }
    }
  } else if (message) {
    body.append(tcErrorRow(message));
  } else {
    body.append(resultFallback(tool));
  }

  return createToolNode({
    tool,
    status: resolveStatus(tool),
    badge: tr("codelens.op.find_definition"),
    display: display ?? argsSummary(tool.arguments),
    displayTitle: filePath,
    meta,
    className: "tc-search-codelens",
    bodyClass: "tc-search",
    body,
  });
};

/**
 * codelens-find_references：definition 位置 + 按文件分组的引用清单
 * （每行「行:列 + 读/写标识 + 代码上下文」）。
 */
const renderFindReferences: CodelensRender = (tool) => {
  if (unparsable(tool)) return null;

  const args = parseJsonRecord(tool.arguments);
  const record = parseJsonRecord(tool.result);
  const filePath = optional(args ? readString(args, "filePath") : undefined);
  const line = args ? readNumber(args, "line") : undefined;
  const column = args ? readNumber(args, "column") : undefined;
  const error = optional(record ? readString(record, "error") : undefined);
  const message = optional(record ? readString(record, "message") : undefined);

  const body = document.createDocumentFragment();
  const meta: Node[] = [];
  let display: string | undefined;

  const params = fileParamRows(filePath, line, column);
  if (params.length) body.append(paramsHost(...params));

  if (error) {
    body.append(tcErrorRow(error));
  } else if (record && typeof record.found === "boolean") {
    const found = record.found === true;
    const name = optional(readString(record, "name"));
    const symbol = optional(readString(record, "symbol"));
    const scope = optional(readString(record, "searchScope"));
    const definition = parseLocation(record.definition);
    const items = records(readArray(record, "references"))
      .map((item) => ({
        location: parseLocation(item),
        access: optional(readString(item, "access")),
        context: optional(readString(item, "context")),
      }))
      .filter((item) => item.location !== null);
    const total = readNumber(record, "totalReferences") ?? items.length;
    display = name ?? symbol ?? (filePath ? fileName(filePath) : undefined);

    meta.push(
      badge(tr("codelens.referenceCount", { count: found ? total : 0 }), {
        variant: found && total > 0 ? "ok" : "muted",
      }),
    );
    if (!found) {
      body.append(
        noteRow("empty", "circle-x", message ?? tr("codelens.noSymbol")),
      );
    } else {
      const head = el("div", "tc-search-sym-head");
      head.append(iconSpan("link", "tc-search-ico"));
      if (display) head.append(mono(display));
      if (scope) {
        head.append(
          badge(
            tr(
              scope === "file" ? "codelens.scopeFile" : "codelens.scopeProject",
            ),
          ),
        );
      }
      body.append(head);

      if (definition) {
        body.append(
          section(tr("label.definition"), locationLine(definition), "target"),
        );
      }

      if (!items.length) {
        body.append(noteRow("empty", "circle-x", tr("codelens.noReferences")));
      } else {
        const { shown, omitted } = capEntries(items);
        const rows: Node[] = [];
        for (const [file, entries] of groupBy(
          shown,
          (item) => item.location?.filePath ?? "",
        )) {
          const list = entries.map((item) =>
            row(
              textSpan(
                "tc-search-loc",
                item.location
                  ? `${item.location.line}:${item.location.column}`
                  : tr("label.position"),
              ),
              item.access
                ? badge(
                    tr(
                      item.access === "write" ? "access.write" : "access.read",
                    ),
                  )
                : "",
              item.context ? snippet(clip(item.context, 200)) : "",
            ),
          );
          rows.push(fileGroup(file, entries.length, listBlock(list)));
        }
        body.append(
          section(tr("label.references"), groupsHost(...rows), "link"),
        );
      }
    }
  } else if (message) {
    body.append(tcErrorRow(message));
  } else {
    body.append(resultFallback(tool));
  }

  return createToolNode({
    tool,
    status: resolveStatus(tool),
    badge: tr("codelens.op.find_references"),
    display: display ?? argsSummary(tool.arguments),
    displayTitle: filePath,
    meta,
    className: "tc-search-codelens",
    bodyClass: "tc-search",
    body,
  });
};

/**
 * codelens-file_outline：层级缩进符号列表（类型徽章 + 名称 + 容器 + 行号）。
 */
const renderFileOutline: CodelensRender = (tool) => {
  if (unparsable(tool)) return null;

  const args = parseJsonRecord(tool.arguments);
  const record = parseJsonRecord(tool.result);
  const filePath =
    optional(args ? readString(args, "filePath") : undefined) ??
    optional(record ? readString(record, "filePath") : undefined);
  const error = optional(record ? readString(record, "error") : undefined);
  const message = optional(record ? readString(record, "message") : undefined);

  const body = document.createDocumentFragment();
  const meta: Node[] = [];

  if (filePath) body.append(paramsHost(...fileParamRows(filePath)));

  if (error) {
    body.append(tcErrorRow(error));
  } else if (record && Array.isArray(record.outline)) {
    const outline = records(record.outline).map((entry): SymbolLine => {
      const containerName = optional(readString(entry, "containerName"));
      const entryLine = readNumber(entry, "line");
      const entryColumn = readNumber(entry, "column");
      return {
        name: optional(readString(entry, "name")) ?? "?",
        kind: optional(readString(entry, "kind")),
        detail: containerName,
        line: entryLine,
        column: entryColumn,
        // 有容器的符号缩进一级，构成「层级缩进列表」。
        level: containerName ? 1 : 0,
        exported: readBoolean(entry, "isExported"),
      };
    });
    const total = readNumber(record, "totalSymbols") ?? outline.length;
    meta.push(
      badge(tr("codelens.symbolCount", { count: total }), {
        variant: total > 0 ? "ok" : "muted",
      }),
    );
    if (!outline.length) {
      body.append(noteRow("empty", "list-checks", tr("codelens.noSymbols")));
    } else {
      const { shown, omitted } = capEntries(outline);
      body.append(
        section(
          tr("label.symbols"),
          listBlock(shown.map(symbolRow), omitted),
          "list-checks",
        ),
      );
    }
  } else if (message) {
    body.append(tcErrorRow(message));
  } else {
    body.append(resultFallback(tool));
  }

  return createToolNode({
    tool,
    status: resolveStatus(tool),
    badge: tr("codelens.op.file_outline"),
    display: filePath ? fileName(filePath) : argsSummary(tool.arguments),
    displayTitle: filePath,
    meta,
    className: "tc-search-codelens",
    bodyClass: "tc-search",
    body,
  });
};

// ── lsp-* ───────────────────────────────────────────────────────────────────

/** 已登记词条的操作名（未登记的后缀直接用原文，保证新工具不出现空白徽章）。 */
const LSP_OPERATIONS = [
  "diagnostics",
  "hover",
  "goto",
  "references",
  "symbols",
  "rename",
  "call-hierarchy",
  "type-hierarchy",
  "workspace-symbols",
  "workspace-diagnostics",
  "vulncheck",
] as const;

const lspBadge = (operation: string): string => {
  const known = (LSP_OPERATIONS as readonly string[]).includes(operation);
  return `lsp.${known ? tr(`lsp.op.${operation}`) : operation}`;
};

type WorkspaceFileEdit = {
  filePath: string;
  count: number;
  applied?: boolean;
  edits: {
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
    newText: string;
  }[];
};

/** 重命名 / 执行命令共用的 WorkspaceEdit 文件列表（uri → 本地路径）。 */
const parseWorkspaceFiles = (values: unknown[]): WorkspaceFileEdit[] =>
  records(values).map((file) => {
    const uri = readString(file, "uri") ?? readString(file, "filePath") ?? "";
    const edits = records(readArray(file, "edits")).map((edit) => ({
      startLine: readNumber(edit, "startLine") ?? 0,
      startColumn: readNumber(edit, "startColumn") ?? 0,
      endLine: readNumber(edit, "endLine") ?? 0,
      endColumn: readNumber(edit, "endColumn") ?? 0,
      newText: readString(edit, "newText") ?? "",
    }));
    return {
      filePath: uri.startsWith("file:") ? uriToPath(uri) : uri,
      count: readNumber(file, "editCount") ?? edits.length,
      applied: readBoolean(file, "applied"),
      edits,
    };
  });

/**
 * WorkspaceEdit 文件分组：文件头（含应用状态）+ 每条编辑的 `起止位置 → 新文本`。
 * 应用路径的输出只有 uri/editCount/applied（native session.rs 的 apply_workspace_edit），
 * 没有 edits 时不渲染编辑行，只用头部状态徽章表达结果。
 */
const workspaceEditGroups = (files: WorkspaceFileEdit[]): HTMLElement => {
  const { shown, omitted } = capEntries(files);
  const rows: Node[] = [];
  for (const file of shown) {
    const head = fileHead(file.filePath, file.count);
    if (file.applied !== undefined) {
      head.append(
        badge(tr(file.applied ? "lsp.renameApplied" : "lsp.noChanges"), {
          variant: file.applied ? "ok" : "warn",
        }),
      );
    }
    const group = el("div", "tc-search-file");
    group.append(head);
    if (file.edits.length) {
      group.append(
        listBlock(
          file.edits.map((edit) =>
            row(
              textSpan(
                "tc-search-loc",
                `${edit.startLine}:${edit.startColumn} → ${edit.endLine}:${edit.endColumn}`,
              ),
              snippet(clip(edit.newText, NOTE_MAX_CHARS)),
            ),
          ),
        ),
      );
    }
    rows.push(group);
  }
  if (omitted > 0) {
    rows.push(
      el("div", "tc-search-omitted", tr("omitted", { count: omitted })),
    );
  }
  return groupsHost(...rows);
};

/** 调用链 / 类型层级条目：名称 + 类型 + 位置（+ 调用点数量）。 */
const hierarchyRows = (
  values: unknown[],
): { rows: Node[]; omitted: number } => {
  const { shown, omitted } = capEntries(values);
  const rows = records(shown).map((entry) => {
    const item = isRecord(entry.caller)
      ? entry.caller
      : isRecord(entry.callee)
        ? entry.callee
        : entry;
    const callSites = readArray(entry, "callSites") ?? [];
    return symbolRow({
      name: readString(item, "name") ?? "?",
      kind: optional(readString(item, "kind")),
      detail: optional(readString(item, "detail")),
      location: parseLocation(item) ?? undefined,
      line: readNumber(item, "line"),
      column: readNumber(item, "column"),
      extra: callSites.length
        ? badge(tr("lsp.callSites", { count: callSites.length }))
        : undefined,
    });
  });
  return { rows, omitted };
};

const renderLsp = (tool: SnowRemoteToolCall): HTMLElement | null => {
  if (unparsable(tool)) return null;

  const operation = tool.name.slice("lsp-".length).trim() || "unknown";
  const args = parseJsonRecord(tool.arguments);
  const record = parseJsonRecord(tool.result);
  const filePath = optional(args ? readString(args, "filePath") : undefined);
  const line = args ? readNumber(args, "line") : undefined;
  const column = args ? readNumber(args, "column") : undefined;
  const error = optional(record ? readString(record, "error") : undefined);
  const message = optional(record ? readString(record, "message") : undefined);

  const body = document.createDocumentFragment();
  const meta: Node[] = [];
  const flags: Node[] = [];
  const params: Node[] = [];
  let display: string | undefined;
  let handled = false;

  // ── 调用参数 ──
  const query = optional(args ? readString(args, "query") : undefined);
  const newName = optional(args ? readString(args, "newName") : undefined);
  const command = optional(args ? readString(args, "command") : undefined);
  const dir = optional(args ? readString(args, "dir") : undefined);
  const pattern = optional(args ? readString(args, "pattern") : undefined);
  const only = args ? readArray(args, "only") : undefined;
  const filePaths = args ? readArray(args, "filePaths") : undefined;
  const position =
    filePath && line !== undefined && column !== undefined
      ? `${filePath}:${line}:${column}`
      : filePath;
  if (operation === "workspace-symbols" && query) {
    params.push(kv(tr("label.query"), query, true));
    display = query;
  } else if (operation === "vulncheck") {
    if (dir) params.push(kv(tr("label.dir"), dir, true));
    if (pattern) params.push(kv(tr("label.pattern"), pattern, true));
  } else if (filePaths?.length) {
    const paths = filePaths.filter(
      (item): item is string => typeof item === "string",
    );
    params.push(kv(tr("label.files"), clip(paths.join(", "), 200), true));
    display = paths.length === 1 ? fileName(paths[0]) : undefined;
  } else if (position) {
    params.push(kv(tr("label.file"), position, true));
    display = fileName(filePath ?? "");
  }
  if (operation === "rename" && newName) {
    params.push(kv(tr("label.newName"), newName, true));
    display = newName;
  }
  if (params.length) body.append(paramsHost(...params));

  // ── 参数开关（预览 / 应用） ──
  const dryRun = args ? readBoolean(args, "dryRun") : undefined;
  if (operation === "rename" && dryRun === true) {
    flags.push(badge(tr("label.dryRun"), { variant: "warn" }));
  }
  if (operation === "goto" && args) {
    const kind = optional(readString(args, "kind"));
    if (kind && kind !== "definition") flags.push(badge(kind));
  }
  if (flags.length) body.append(flagsHost(...flags));

  // ── 结果 ──
  const language = optional(
    record ? readString(record, "language") : undefined,
  );
  if (language) meta.push(badge(language, { icon: "code" }));

  if (error) {
    body.append(tcErrorRow(error));
    handled = true;
  } else if (record) {
    const diagnostics = readArray(record, "diagnostics");
    const files = readArray(record, "files");
    const definitions = readArray(record, "definitions");
    const symbols = readArray(record, "symbols");
    const references = readArray(record, "references");
    const incoming = readArray(record, "incoming");
    const outgoing = readArray(record, "outgoing");
    const supertypes = readArray(record, "supertypes");
    const subtypes = readArray(record, "subtypes");
    const findings = readArray(record, "findings");
    const contents =
      typeof record.contents === "string"
        ? (record.contents as string)
        : undefined;

    if (contents !== undefined) {
      // 悬停信息（Markdown 文本 + 目标范围）
      const range = isRecord(record.range) ? record.range : null;
      const start = range && isRecord(range.start) ? range.start : null;
      const startLine = start ? readNumber(start, "line") : undefined;
      const startColumn = start ? readNumber(start, "column") : undefined;
      if (filePath && startLine !== undefined && startColumn !== undefined) {
        body.append(
          locationLine({ filePath, line: startLine, column: startColumn }),
        );
      }
      body.append(tcPre(decodeEscapedNewlines(contents)));
      handled = true;
    } else if (diagnostics) {
      // 单文件诊断
      const items = parseDiagnostics(diagnostics);
      const total = readNumber(record, "count") ?? items.length;
      const summary = optional(readString(record, "summary"));
      meta.push(
        badge(tr("lsp.diagnosticsCount", { count: total }), {
          variant: total > 0 ? "warn" : "ok",
        }),
      );
      if (summary) body.append(noteRow("note", "activity", summary));
      body.append(
        items.length
          ? diagnosticRows(diagnostics)
          : noteRow("empty", "circle-check", tr("lsp.noDiagnostics")),
      );
      handled = true;
    } else if (files) {
      // 批量诊断 / 工作区诊断 / 重命名与执行命令的文件列表
      const entries = records(files);
      const batch = readBoolean(record, "batch") === true;
      const editMode = operation === "rename";
      if (editMode) {
        const applied = readBoolean(record, "applied") === true;
        const changeCount =
          readNumber(record, "changeCount") ??
          entries.reduce(
            (sum, file) => sum + (readNumber(file, "editCount") ?? 0),
            0,
          );
        meta.push(
          badge(tr(applied ? "lsp.renameApplied" : "label.dryRun"), {
            variant: applied ? "ok" : "warn",
          }),
        );
        meta.push(badge(tr("fileCount", { count: entries.length })));
        meta.push(badge(tr("lsp.editCount", { count: changeCount })));
        if (!applied)
          body.append(noteRow("note", "file-pen", tr("lsp.renamePreview")));
        // 编辑含 documentChanges.operations（新建/重命名/删除文件）时无文件列表可展示。
        if (readBoolean(record, "unsupportedOperations") === true) {
          body.append(
            noteRow("note", "shield-alert", tr("lsp.unsupportedOperations")),
          );
        }
        body.append(
          section(
            tr(applied ? "label.applied" : "label.planned"),
            workspaceEditGroups(parseWorkspaceFiles(files)),
            "file-pen",
          ),
        );
      } else {
        const totalFiles =
          readNumber(record, "fileCount") ??
          readNumber(record, "count") ??
          entries.length;
        meta.push(badge(tr("fileCount", { count: totalFiles })));
        const rows = entries.map((file) => {
          const target = readString(file, "filePath") ?? "?";
          const fileError = optional(readString(file, "error"));
          const summary = optional(readString(file, "summary"));
          const items = readArray(file, "diagnostics") ?? [];
          const content = fileError
            ? tcErrorRow(fileError)
            : items.length
              ? diagnosticRows(items)
              : noteRow("empty", "circle-check", tr("lsp.noDiagnostics"));
          const head = fileHead(target, items.length);
          if (summary) head.append(textSpan("tc-search-file-summary", summary));
          const group = el("div", "tc-search-file");
          group.append(head, content);
          return group;
        });
        if (!entries.length) {
          body.append(
            noteRow("empty", "circle-check", tr("lsp.noDiagnostics")),
          );
        } else {
          body.append(
            section(
              tr(batch ? "label.results" : "lsp.op.workspace-diagnostics"),
              groupsHost(...rows),
              "shield-alert",
            ),
          );
        }
      }
      const warnings = readArray(record, "warnings");
      if (warnings?.length) {
        const rows = records(warnings).map((warning) =>
          row(
            textSpan(
              "tc-search-sub",
              `${readString(warning, "language") ?? "?"}`,
            ),
            textSpan(
              "tc-search-sub",
              clip(readString(warning, "error") ?? "", 200),
            ),
          ),
        );
        body.append(
          section(tr("label.warnings"), listBlock(rows), "shield-alert"),
        );
      }
      handled = true;
    } else if (definitions) {
      // 跳转（goto：definition / type-definition / implementation）
      const items = locations(definitions);
      const name = optional(readString(record, "name"));
      const total = readNumber(record, "count") ?? items.length;
      meta.push(
        badge(tr("lsp.definitionsCount", { count: total }), {
          variant: total > 0 ? "ok" : "muted",
        }),
      );
      if (name) display = name;
      if (!items.length) {
        body.append(noteRow("empty", "target", tr("lsp.noDefinitions")));
      } else {
        const { shown, omitted } = capEntries(items);
        body.append(
          section(
            name
              ? `${tr("label.definition")} · ${name}`
              : tr("label.definition"),
            listBlock(
              shown.map((item) => locationLine(item)),
              omitted,
            ),
            "target",
          ),
        );
      }
      handled = true;
    } else if (symbols) {
      // 文档符号树（symbols：range/children）与工作区符号（扁平 + count/total）
      const lines = flattenSymbols(symbols);
      const isWorkspace = operation === "workspace-symbols";
      const total = isWorkspace
        ? (readNumber(record, "total") ?? lines.length)
        : (readNumber(record, "count") ?? lines.length);
      meta.push(
        badge(tr("lsp.symbolsCount", { count: total }), {
          variant: total > 0 ? "ok" : "muted",
        }),
      );
      // 工作区符号在 50 条处截断：count 为展示数，total 为命中总数。
      if (isWorkspace && total > lines.length) {
        meta.push(
          badge(tr("lsp.truncated", { count: lines.length }), {
            variant: "warn",
          }),
        );
      }
      if (!lines.length) {
        body.append(noteRow("empty", "list-checks", tr("lsp.noSymbols")));
      } else {
        const { shown, omitted } = capEntries(lines);
        body.append(
          section(
            tr("label.symbols"),
            listBlock(shown.map(symbolRow), omitted),
            "list-checks",
          ),
        );
      }
      handled = true;
    } else if (references) {
      // 引用列表（symbol + count + references[{filePath,line,column,context}]）
      const symbol = optional(readString(record, "symbol"));
      const items = records(references)
        .map((item) => ({
          location: parseLocation(item) ?? undefined,
          context: optional(readString(item, "context")),
        }))
        .filter((item) => item.location !== undefined);
      const total = readNumber(record, "count") ?? items.length;
      if (symbol) {
        meta.push(badge(symbol));
        display = symbol;
      }
      meta.push(
        badge(tr("codelens.referenceCount", { count: total }), {
          variant: total > 0 ? "ok" : "muted",
        }),
      );
      if (!items.length) {
        body.append(noteRow("empty", "circle-x", tr("codelens.noReferences")));
      } else {
        const { shown, omitted } = capEntries(items);
        const rows: Node[] = [];
        for (const [file, entries] of groupBy(
          shown,
          (item) => item.location?.filePath ?? "",
        )) {
          rows.push(
            fileGroup(
              file,
              entries.length,
              listBlock(
                entries.map((item) =>
                  row(
                    textSpan(
                      "tc-search-loc",
                      item.location
                        ? `${item.location.line}:${item.location.column}`
                        : tr("label.position"),
                    ),
                    item.context ? snippet(clip(item.context, 200)) : "",
                  ),
                ),
              ),
            ),
          );
        }
        body.append(
          section(tr("label.references"), groupsHost(...rows), "link"),
        );
      }
      handled = true;
    } else if (incoming || outgoing) {
      // 调用链（caller / callee + callSites）
      const symbol = optional(readString(record, "symbol"));
      const callers = hierarchyRows(incoming ?? []);
      const callees = hierarchyRows(outgoing ?? []);
      const incomingCount =
        readNumber(record, "incomingCount") ?? callers.rows.length;
      const outgoingCount =
        readNumber(record, "outgoingCount") ?? callees.rows.length;
      if (symbol) {
        meta.push(badge(symbol));
        display = symbol;
      }
      meta.push(
        badge(
          tr("lsp.callHierarchyCount", {
            incoming: incomingCount,
            outgoing: outgoingCount,
          }),
          { variant: incomingCount + outgoingCount > 0 ? "ok" : "muted" },
        ),
      );
      if (!callers.rows.length && !callees.rows.length) {
        body.append(noteRow("empty", "git-branch", tr("lsp.noHierarchy")));
      } else {
        if (callers.rows.length) {
          body.append(
            section(
              tr("label.callers"),
              listBlock(callers.rows, callers.omitted),
              "arrow-up",
            ),
          );
        }
        if (callees.rows.length) {
          body.append(
            section(
              tr("label.callees"),
              listBlock(callees.rows, callees.omitted),
              "arrow-down",
            ),
          );
        }
      }
      handled = true;
    } else if (supertypes || subtypes) {
      // 类型层级（supertypes / subtypes）
      const symbol = optional(readString(record, "symbol"));
      const parents = records(supertypes);
      const children = records(subtypes);
      const supertypesCount =
        readNumber(record, "supertypesCount") ?? parents.length;
      const subtypesCount =
        readNumber(record, "subtypesCount") ?? children.length;
      if (symbol) {
        meta.push(badge(symbol));
        display = symbol;
      }
      meta.push(
        badge(
          tr("lsp.typeHierarchyCount", {
            supertypes: supertypesCount,
            subtypes: subtypesCount,
          }),
          { variant: supertypesCount + subtypesCount > 0 ? "ok" : "muted" },
        ),
      );
      if (!parents.length && !children.length) {
        body.append(noteRow("empty", "git-branch", tr("lsp.noHierarchy")));
      } else {
        for (const [labelKey, entries, icon] of [
          ["label.supertypes", parents, "arrow-up"],
          ["label.subtypes", children, "arrow-down"],
        ] as const) {
          if (!entries.length) continue;
          const { shown, omitted } = capEntries(entries);
          body.append(
            section(
              tr(labelKey),
              listBlock(
                shown.map((entry) =>
                  symbolRow({
                    name: readString(entry, "name") ?? "?",
                    kind: optional(readString(entry, "kind")),
                    detail: optional(readString(entry, "detail")),
                    location: parseLocation(entry) ?? undefined,
                    line: readNumber(entry, "line"),
                    column: readNumber(entry, "column"),
                  }),
                ),
                omitted,
              ),
              icon,
            ),
          );
        }
      }
      handled = true;
    } else if (findings) {
      // 依赖漏洞扫描（findings：id + details + affectedPackages）
      const total = readNumber(record, "count") ?? findings.length;
      const summary = optional(readString(record, "summary"));
      meta.push(
        badge(tr("lsp.vulnerabilitiesCount", { count: total }), {
          variant: total > 0 ? "warn" : "ok",
        }),
      );
      if (summary) body.append(noteRow("note", "shield-check", summary));
      if (!findings.length) {
        body.append(
          noteRow("empty", "shield-check", tr("lsp.noVulnerabilities")),
        );
      } else {
        const { shown, omitted } = capEntries(findings);
        const rows: Node[] = records(shown).map((finding) => {
          const card = el("div", "tc-search-symbol");
          const head = el("div", "tc-search-sym-head");
          head.append(iconSpan("shield-alert", "tc-search-ico"));
          head.append(mono(readString(finding, "id") ?? "?"));
          const packages = (
            readArray(finding, "affectedPackages") ?? []
          ).filter((item): item is string => typeof item === "string");
          if (packages.length) {
            head.append(
              badge(tr("lsp.affectedPackages", { count: packages.length })),
            );
          }
          card.append(head);
          const details = optional(readString(finding, "details"));
          if (details) card.append(tcPre(details, { maxLines: 6 }));
          if (packages.length) {
            const chips = el("div", "tc-search-packages");
            for (const name of packages) chips.append(mono(name));
            card.append(chips);
          }
          return card;
        });
        body.append(
          section(
            tr("label.results"),
            listBlock(rows, omitted),
            "shield-alert",
          ),
        );
      }
      handled = true;
    }
  }

  if (!handled) {
    if (message) {
      body.append(tcErrorRow(message));
    } else if (record) {
      body.append(
        section(tr("result"), tcPre(decodeEscapedNewlines(tool.result ?? ""))),
      );
    } else if (tool.status !== "running") {
      body.append(noteRow("note", "scan-search", tr("waiting")));
    } else {
      body.append(noteRow("note", "scan-search", tr("running")));
    }
  }

  return createToolNode({
    tool,
    status: resolveStatus(tool),
    badge: lspBadge(operation),
    display: display ?? argsSummary(tool.arguments),
    displayTitle: filePath,
    meta,
    className: "tc-search-lsp",
    bodyClass: "tc-search",
    body,
  });
};

// ── 模块装配 ────────────────────────────────────────────────────────────────

/**
 * 模块注册表（契约见 tools/types.ts 的 ToolModule）：
 * grep / codebase / 三个 codelens 操作按精确名接管，其余代码智能工具按 `lsp-` 前缀
 * 整族接管（派发顺序：精确名 → 最长前缀）。
 */
export const searchModule: ToolModule = {
  renderers: {
    "grep-search": renderGrep,
    "codebase-search": renderCodebase,
    "codelens-find_definition": renderFindDefinition,
    "codelens-find_references": renderFindReferences,
    "codelens-file_outline": renderFileOutline,
  },
  prefixes: [{ prefix: "lsp-", render: renderLsp }],
};
