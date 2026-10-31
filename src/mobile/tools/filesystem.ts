/**
 * filesystem 工具族卡片：filesystem-read / filesystem-replace_edit / filesystem-create /
 * filesystem-copy。
 *
 * 数据契约（字段语义与桌面 Filesystem*ToolCall 的解析逐字段对齐，字段名以 Rust 端为准）：
 * - read：参数 filePath（字符串 / 数组 / JSON 数组字符串 → 多文件）、startLine、endLine
 *   （offset / limit 作为兼容别名兜底）；结果 { content, totalLines, startLine, endLine }
 *   —— content 由 Rust 端预先加好 `     1: ` 行号前缀；目录结果只有 { content }
 *   （每行一个条目，子目录以 "/" 结尾）；图片 { content: "@@image:…@@", mediaType,
 *   isImage }；多文件 { files: [{ filePath, … }] }；
 * - replace_edit：参数 filePath / searchContent / replaceContent / occurrence；成功结果
 *   { success, totalMatches, occurrence, matchType, matchedLineStart, matchedLineEnd }；
 * - create：参数 filePath / content / overwrite / encoding（isDirectory 为兼容字段）；
 *   成功结果 { success, path, bytes, lines }；
 * - copy：参数 filePath（粘贴目的地）/ sourceFilePath / sourceStartLine / sourceEndLine
 *   （缺省 = sourceStartLine）/ targetLine / position / mode / targetEndLine / deleteSource
 *   （true = 剪切：粘贴后源区间从源文件删除，缺省 false）；成功结果
 *   { success, sourceFilePath, sourceLineStart, sourceLineEnd, copiedLines, deleteSource,
 *   sourceTotalLines, targetFilePath, mode, position, matchedLineStart, matchedLineEnd,
 *   totalLines, replacedContent, pastedContent, omittedLines, formatPending?, removedContent?,
 *   sourceReview? }，失败结果是错误文本（可能落在 message 字段）。
 *   剪切时源侧另有回显：源 / 目标不同文件时在目标 diff 之后再渲染源文件的删除 diff，
 *   同文件（文件内移动）只给一行说明。
 *
 * 远控桥全量下发工具参数与结果（不截断），因此参数 / 结果解析一律走正常路径；
 * 仅 read 的 filePath 用宽松取串（partialString）兜底历史会话里被旧版桥截断
 * 成半截 JSON 的参数快照。
 *
 * 契约：卡片骨架走 tools/ui.ts 的 createToolNode（头部徽章/摘要、状态、折叠体），
 * 行级 diff 视图走 tools/diffView.ts 的 renderDiffView（样式在 diff.css，本模块不重复
 * 定义）；本模块类名统一 tc-fs-*（styles/tools/filesystem.css）。所有文本一律
 * createElement + textContent，数据不进 innerHTML（图标为静态 lucide 标记）。
 */
import type { SnowRemoteToolCall } from "../../renderer/types/remoteControl";
import { t } from "../i18n";
import { iconMarkup, type MobileIconName } from "../icons";
import { computeLineDiff, diffStats, type DiffLine } from "./diff";
import { renderDiffView } from "./diffView";
import type { ToolCallRenderer, ToolModule } from "./types";
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
  uploadImageUrl,
} from "./ui";

// ── 通用小件 ──────────────────────────────────────────────────────────────

/** read 内容块的折叠阈值（行数；Rust 端内容已带行号前缀）。 */
const CONTENT_FOLD_LINES = 20;

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

/** 文件名（兼容 Windows / POSIX 分隔符；无分隔符时原样返回）。 */
const fileNameOf = (filePath: string): string =>
  filePath.split(/[\\/]/).filter(Boolean).pop() || filePath;

/** 数字字段读取（非有限数字一律视为缺失）。 */
const numberOf = (
  record: JsonRecord | null,
  key: string,
): number | undefined => {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
};

/** tcPre 结果里的 pre（超阈值时在 .tc-fold 内部，折叠协议见 base.css）。 */
const preOf = (node: HTMLElement): HTMLElement =>
  node.tagName === "PRE" ? node : (node.querySelector("pre") ?? node);

/** 完整路径行（等宽、任意位置可换行）。 */
const pathRow = (filePath: string): HTMLElement =>
  el("div", "tc-fs-path", filePath);

/** 提示行（降级 / 统计说明）。 */
const noteRow = (
  message: string,
  variant: "muted" | "warn" = "muted",
): HTMLElement => el("div", `tc-fs-note tc-fs-note-${variant}`, message);

/** 结论行（匹配位置 / 创建完成）。 */
const successRow = (message: string): HTMLElement =>
  el("div", "tc-fs-success", message);

/** 增删统计（+n；有删除时才补 −m）——summary 的 meta 区。 */
const statsNode = (stats: {
  additions: number;
  deletions: number;
}): HTMLElement => {
  const wrap = el("span", "tc-fs-stats");
  wrap.append(el("span", "tc-fs-stat-add", `+${stats.additions}`));
  if (stats.deletions > 0) {
    wrap.append(el("span", "tc-fs-stat-del", `-${stats.deletions}`));
  }
  return wrap;
};

/** 12px 小图标（目录条目 / 多文件段落标题）。 */
const fileIcon = (name: MobileIconName): HTMLElement => {
  const icon = el("span", "tc-fs-icon");
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = iconMarkup(name);
  return icon;
};

/** 条目清单（目录列表 / 待读取路径）。 */
const entryList = (
  items: { icon: MobileIconName; label: string }[],
): HTMLElement => {
  const list = el("div", "tc-fs-list");
  for (const item of items) {
    const row = el("div", "tc-fs-row");
    row.append(fileIcon(item.icon), el("span", "tc-fs-name", item.label));
    list.append(row);
  }
  return list;
};

/**
 * 内容块：Rust 端已给每行加了 `     1: ` 行号前缀，这里按等宽文本原样展示，
 * 超过折叠阈值时由 tcPre 生成 .tc-fold + .tc-more（展开态由 timeline.ts 委托切换）。
 */
const contentBlock = (text: string): HTMLElement => {
  const block = tcPre(text, { maxLines: CONTENT_FOLD_LINES });
  preOf(block).classList.add("tc-fs-code");
  return block;
};

/** diff 容器：与正文同栅格（min-width: 0 防长行撑破；行级样式见 diff.css）。 */
const diffBlock = (node: HTMLElement): HTMLElement => {
  const wrap = el("div", "tc-fs-diff");
  wrap.append(node);
  return wrap;
};

/** 参数回退块：可解析时美化 JSON，否则还原字面转义后的原文（无内容返回 null）。 */
const argsFallbackSection = (
  record: JsonRecord | null,
  raw?: string,
): HTMLElement | null => {
  const text = record
    ? formatJson(record)
    : decodeEscapedNewlines((raw ?? "").trim());
  return text === ""
    ? null
    : tcSection(t("remote.toolCall.common.arguments"), tcPre(text));
};

/** 结果原文块（无法解析为结构化结果时的兜底：提示 + 原文）。 */
const rawResultSection = (raw: string): DocumentFragment => {
  const fragment = document.createDocumentFragment();
  fragment.append(noteRow(t("remote.toolCall.filesystem.rawFallback")));
  fragment.append(
    tcSection(
      t("remote.toolCall.common.result"),
      tcPre(decodeEscapedNewlines(raw)),
    ),
  );
  return fragment;
};

/**
 * 宽松取串：定位 `"key"` 后的字符串字面量起点，按 JSON 转义规则解出
 * 已到达的部分；遇到未转义的收尾引号或文本末尾即停。仅用于兼容历史会话里
 * 参数被旧版远控桥截断成半截 JSON 的快照（新版桥全量下发，正常参数走
 * parseJsonRecord，不经过这里）。
 */
const partialString = (raw: string | undefined, key: string): string | null => {
  if (!raw) return null;
  const marker = `"${key}"`;
  const at = raw.indexOf(marker);
  if (at < 0) return null;
  const colon = raw.indexOf(":", at + marker.length);
  if (colon < 0) return null;
  let index = colon + 1;
  while (index < raw.length && raw[index] !== '"') index += 1;
  if (raw[index] !== '"') return null;

  const escapes: Record<string, string> = {
    '"': '"',
    "\\": "\\",
    "/": "/",
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
  };
  let out = "";
  index += 1;
  while (index < raw.length) {
    const ch = raw[index];
    if (ch === '"') break;
    if (ch !== "\\") {
      out += ch;
      index += 1;
      continue;
    }
    const next = raw[index + 1];
    if (next === undefined) break; // 半截转义序列：丢弃
    const mapped = escapes[next];
    if (mapped !== undefined) {
      out += mapped;
      index += 2;
      continue;
    }
    if (next === "u") {
      const code = Number.parseInt(raw.slice(index + 2, index + 6), 16);
      if (!Number.isInteger(code)) break;
      out += String.fromCharCode(code);
      index += 6;
      continue;
    }
    out += next;
    index += 2;
  }
  return out;
};

/** 从（历史快照里可能残缺的）参数原文里抢救出 filePath 用于降级展示。 */
const recoverPath = (raw?: string): string | undefined =>
  partialString(raw, "filePath") || undefined;

/**
 * 给框架产出的头部徽章（.tool-name）补一枚 lucide 图标：createToolNode 的 badge
 * 只接受字符串文案，这里在节点生成后把文案包进 .tc-fs-badge-text 并在其前面插入
 * 图标（结构/样式见 styles/tools/filesystem.css 的 .tc-fs-badge*）。
 */
const withBadgeIcon = (
  node: HTMLElement,
  icon: MobileIconName,
): HTMLElement => {
  const badge = node.querySelector<HTMLElement>(".tool-name");
  if (!badge) return node;
  const label = el("span", "tc-fs-badge-text", badge.textContent ?? "");
  badge.textContent = "";
  badge.classList.add("tc-fs-badge");
  badge.append(iconSpan(icon, "tc-fs-badge-icon"), label);
  return node;
};

// ── read ─────────────────────────────────────────────────────────────────

type ReadPathItem = { path: string; startLine?: number; endLine?: number };

type ReadArgs = {
  isMulti: boolean;
  filePath?: string;
  startLine?: number;
  endLine?: number;
  paths?: ReadPathItem[];
};

type ReadFileResult =
  | {
      type: "file";
      content: string;
      totalLines: number;
      startLine: number;
      endLine: number;
    }
  | { type: "directory"; entries: string[] }
  | { type: "image"; content: string; mediaType: string }
  | { type: "error"; message: string }
  | { type: "raw"; text: string };

type ReadResult =
  | ReadFileResult
  | { type: "multi"; files: { filePath: string; result: ReadFileResult }[] }
  | { type: "empty" };

/** 解析多文件参数项（字符串或 { path, startLine, endLine } 对象）。 */
const parsePathItems = (
  items: unknown[],
  defaultStartLine?: number,
  defaultEndLine?: number,
): ReadPathItem[] => {
  const paths: ReadPathItem[] = [];
  for (const item of items) {
    if (typeof item === "string") {
      if (item) {
        paths.push({
          path: item,
          startLine: defaultStartLine,
          endLine: defaultEndLine,
        });
      }
      continue;
    }
    if (typeof item !== "object" || item === null) continue;
    const record = item as JsonRecord;
    if (typeof record.path !== "string" || !record.path) continue;
    paths.push({
      path: record.path,
      startLine:
        typeof record.startLine === "number"
          ? record.startLine
          : defaultStartLine,
      endLine:
        typeof record.endLine === "number" ? record.endLine : defaultEndLine,
    });
  }
  return paths;
};

/**
 * 解析 read 参数：多文件时 filePath 为数组，或 Rust 侧上报的 JSON 数组字符串。
 * 行区间优先 startLine / endLine，缺失时接受 offset（起始行）/ limit（行数）别名。
 */
const parseReadArgs = (record: JsonRecord | null): ReadArgs | null => {
  if (!record) return null;
  const offset = numberOf(record, "offset");
  const limit = numberOf(record, "limit");
  const defaultStartLine = numberOf(record, "startLine") ?? offset;
  const defaultEndLine =
    numberOf(record, "endLine") ??
    (offset !== undefined && limit !== undefined ? offset + limit - 1 : limit);
  const filePath = record.filePath;

  if (Array.isArray(filePath)) {
    const paths = parsePathItems(filePath, defaultStartLine, defaultEndLine);
    return paths.length ? { isMulti: true, paths } : null;
  }
  if (typeof filePath === "string" && filePath) {
    const trimmed = filePath.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const arr: unknown = JSON.parse(trimmed);
        if (Array.isArray(arr)) {
          const paths = parsePathItems(arr, defaultStartLine, defaultEndLine);
          if (paths.length) return { isMulti: true, paths };
        }
      } catch {
        // 不是合法 JSON 数组：按普通单文件路径处理。
      }
    }
    return {
      isMulti: false,
      filePath,
      startLine: defaultStartLine,
      endLine: defaultEndLine,
    };
  }
  return null;
};

/** 单个文件的结果（错误 / 图片 / 带行号的文本 / 目录列表 / 原文）。 */
const parseSingleReadResult = (value: unknown, raw: string): ReadFileResult => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { type: "raw", text: raw };
  }
  const record = value as JsonRecord;
  if (typeof record.error === "string") {
    return { type: "error", message: record.error };
  }
  if (typeof record.content !== "string") {
    return { type: "raw", text: raw };
  }

  if (record.isImage === true) {
    return {
      type: "image",
      content: record.content,
      mediaType:
        typeof record.mediaType === "string" ? record.mediaType : "image",
    };
  }
  if (
    typeof record.totalLines === "number" &&
    typeof record.startLine === "number" &&
    typeof record.endLine === "number"
  ) {
    return {
      type: "file",
      content: record.content,
      totalLines: record.totalLines,
      startLine: record.startLine,
      endLine: record.endLine,
    };
  }
  // 没有行号元数据：目录列表（content 每行一个条目）。
  return {
    type: "directory",
    entries: record.content.split("\n").filter((line) => line.length > 0),
  };
};

/** 解析 read 结果（多文件为 { files: [...] } 包装）。 */
const parseReadResult = (raw?: string): ReadResult => {
  if (!raw) return { type: "empty" };
  const record = parseJsonRecord(raw);
  if (!record) return { type: "raw", text: raw };
  if (Array.isArray(record.files)) {
    const files = (record.files as unknown[]).map((file, index) => {
      const item: JsonRecord =
        typeof file === "object" && file !== null && !Array.isArray(file)
          ? (file as JsonRecord)
          : {};
      return {
        filePath:
          typeof item.filePath === "string" ? item.filePath : `file[${index}]`,
        result: parseSingleReadResult(item, formatJson(item)),
      };
    });
    return { type: "multi", files };
  }
  return parseSingleReadResult(record, raw);
};

/** 行范围标签：覆盖全文件显示总行数，否则显示起止行 + 总行数。 */
const rangeLabel = (
  startLine: number,
  endLine: number,
  totalLines: number,
): string =>
  endLine - startLine + 1 >= totalLines
    ? t("remote.toolCall.filesystem.linesTotal", { count: totalLines })
    : t("remote.toolCall.filesystem.lineWindow", {
        start: startLine,
        end: endLine,
        total: totalLines,
      });

/** 单个结果的 meta 文案（文件行范围 / 目录条目数；其它不显示）。 */
const singleRangeLabel = (result: ReadFileResult): string => {
  if (result.type === "file") {
    return rangeLabel(result.startLine, result.endLine, result.totalLines);
  }
  if (result.type === "directory") {
    return t("remote.toolCall.filesystem.entryCount", {
      count: result.entries.length,
    });
  }
  return "";
};

/** read 的 summary 摘要：单文件用文件名，多文件用文件数。 */
const readTitle = (
  args: ReadArgs | null,
  result: ReadResult,
): string | undefined => {
  if (args && !args.isMulti && args.filePath) {
    return fileNameOf(args.filePath);
  }
  const count =
    args?.isMulti && args.paths
      ? args.paths.length
      : result.type === "multi"
        ? result.files.length
        : undefined;
  return count === undefined
    ? undefined
    : t("remote.toolCall.filesystem.fileCount", { count });
};

/**
 * read 的 meta 文案：多文件 / 目录条目数 / 文件行范围（结果未到时退化为参数区间，
 * 参数里的 offset / limit 别名会在这里体现）。
 */
const readMetaLabel = (args: ReadArgs | null, result: ReadResult): string => {
  if (result.type === "multi") {
    return t("remote.toolCall.filesystem.fileCount", {
      count: result.files.length,
    });
  }
  if (result.type === "directory") {
    return t("remote.toolCall.filesystem.entryCount", {
      count: result.entries.length,
    });
  }
  if (result.type === "file") {
    return rangeLabel(result.startLine, result.endLine, result.totalLines);
  }
  if (
    args &&
    !args.isMulti &&
    (args.startLine !== undefined || args.endLine !== undefined)
  ) {
    const start = args.startLine ?? 1;
    const end = args.endLine ?? start;
    return start >= end
      ? t("remote.toolCall.filesystem.lineSingle", { line: start })
      : t("remote.toolCall.filesystem.linesRange", { start, end });
  }
  return "";
};

/** 图片预览（内容可能是 data URL，也可能是 @@image:<src>@@ 包裹的地址或 upload/ 落盘路径）。 */
const imagePreview = (content: string, mediaType: string): HTMLElement => {
  const img = el("img", "tc-image tc-fs-image");
  const src = content.match(/@@image:([^@]+)@@/)?.[1] ?? content;
  img.src = uploadImageUrl(src) ?? src;
  img.alt = t("remote.toolCall.filesystem.imagePreview", { mediaType });
  img.loading = "lazy";
  return img;
};

/** 单个结果的正文（错误 / 目录 / 内容 / 图片 / 原文；空态由调用方处理）。 */
const resultContent = (result: ReadFileResult): Node | null => {
  switch (result.type) {
    case "error":
      return tcErrorRow(result.message);
    case "directory":
      return result.entries.length
        ? entryList(
            result.entries.map((entry) => ({
              icon: entry.endsWith("/") ? "folder" : "file",
              label: entry.endsWith("/") ? entry.slice(0, -1) : entry,
            })),
          )
        : null;
    case "file":
      return contentBlock(result.content);
    case "image":
      return imagePreview(result.content, result.mediaType);
    case "raw":
      return rawResultSection(result.text);
    default:
      return null;
  }
};

/** 多文件结果中的单文件段落：文件名 + 行范围 + 路径 + 内容。 */
const multiFileSection = (file: {
  filePath: string;
  result: ReadFileResult;
}): HTMLElement => {
  const section = el("div", "tc-section");
  const head = el("div", "tc-fs-row");
  const name = el("span", "tc-fs-name", fileNameOf(file.filePath));
  name.title = file.filePath;
  head.append(fileIcon("file"), name);
  const label = singleRangeLabel(file.result);
  if (label) head.append(el("span", "tc-fs-meta", label));
  section.append(head, pathRow(file.filePath));
  const content = resultContent(file.result);
  if (content) section.append(content);
  return section;
};

export const renderReadCard: ToolCallRenderer = (tool) => {
  const raw = tool.arguments;
  const args = parseReadArgs(parseJsonRecord(raw));
  const result = parseReadResult(tool.result);
  // 历史快照的参数可能是半截 JSON（旧版桥截断）：parseJsonRecord 拿不到时，
  // 用宽松取串抢救 filePath。
  const filePath = args && !args.isMulti ? args.filePath : undefined;
  const shownPath = filePath ?? recoverPath(raw);

  if (!args && !(raw ?? "").trim() && result.type === "empty") {
    return null; // 无参数也无结果：交给兜底卡
  }

  const body = document.createDocumentFragment();
  if (shownPath) body.append(pathRow(shownPath));

  if (result.type === "multi") {
    for (const file of result.files) body.append(multiFileSection(file));
  } else if (result.type === "empty") {
    if (args?.isMulti && args.paths) {
      // 多文件参数、结果未到达：展示待读取的目标列表。
      body.append(
        entryList(
          args.paths.map((item) => ({ icon: "file", label: item.path })),
        ),
      );
    } else {
      const fallback = argsFallbackSection(parseJsonRecord(raw), raw);
      body.append(
        fallback ?? noteRow(t("remote.toolCall.filesystem.noArguments")),
      );
    }
  } else {
    if (result.type === "file") {
      // 正文统计行：与桌面一致地给出读取到的行窗口（区间也在 header meta 里）。
      body.append(
        noteRow(
          t("remote.toolCall.filesystem.lineWindow", {
            start: result.startLine,
            end: result.endLine,
            total: result.totalLines,
          }),
        ),
      );
    }
    const content = resultContent(result);
    if (content) body.append(content);
  }

  const meta: Node[] = [];
  const metaLabel = readMetaLabel(args, result);
  if (metaLabel) meta.push(tcBadge(metaLabel));
  return withBadgeIcon(
    createToolNode({
      tool,
      status: resolveStatus(tool),
      badge: t("remote.toolCall.filesystem.read"),
      display:
        readTitle(args, result) ??
        (shownPath ? fileNameOf(shownPath) : argsSummary(raw)),
      displayTitle: shownPath,
      meta: meta.length ? meta : undefined,
      body: body.childNodes.length > 0 ? body : undefined,
    }),
    "file",
  );
};

// ── replace_edit ─────────────────────────────────────────────────────────

type EditArgs = {
  filePath: string;
  searchContent: string;
  replaceContent: string;
  occurrence?: number;
};

type EditResult =
  | {
      type: "success";
      matchIndex: number;
      totalMatches: number;
      occurrence: number;
      matchedLineStart?: number;
      matchedLineEnd?: number;
    }
  | { type: "error"; message: string }
  | { type: "raw"; text: string }
  | { type: "empty" };

const parseEditArgs = (record: JsonRecord | null): EditArgs | null => {
  if (!record) return null;
  if (typeof record.filePath !== "string" || !record.filePath) return null;
  return {
    filePath: record.filePath,
    searchContent:
      typeof record.searchContent === "string" ? record.searchContent : "",
    replaceContent:
      typeof record.replaceContent === "string" ? record.replaceContent : "",
    occurrence: numberOf(record, "occurrence"),
  };
};

const parseEditResult = (raw?: string): EditResult => {
  if (!raw) return { type: "empty" };
  const record = parseJsonRecord(raw);
  if (!record) return { type: "raw", text: raw };
  if (typeof record.error === "string") {
    return { type: "error", message: record.error };
  }
  if (record.success === true) {
    return {
      type: "success",
      matchIndex: numberOf(record, "matchIndex") ?? 0,
      totalMatches: numberOf(record, "totalMatches") ?? 1,
      occurrence: numberOf(record, "occurrence") ?? 1,
      matchedLineStart: numberOf(record, "matchedLineStart"),
      matchedLineEnd: numberOf(record, "matchedLineEnd"),
    };
  }
  return { type: "raw", text: raw };
};

/** 匹配位置行：行号区间或序号，多个匹配时附 (occurrence/total)。 */
const matchedRow = (result: {
  matchIndex: number;
  totalMatches: number;
  occurrence: number;
  matchedLineStart?: number;
  matchedLineEnd?: number;
}): HTMLElement => {
  const start = result.matchedLineStart;
  const end = result.matchedLineEnd;
  let text: string;
  if (start !== undefined) {
    const lineLabel =
      end !== undefined && end !== start ? `${start}-${end}` : String(start);
    text = t("remote.toolCall.filesystem.matchedLine", { line: lineLabel });
  } else {
    text = t("remote.toolCall.filesystem.matchedIndex", {
      index: result.matchIndex,
    });
  }
  if (result.totalMatches > 1) {
    text += ` (${result.occurrence}/${result.totalMatches})`;
  }
  return successRow(text);
};

export const renderEditCard: ToolCallRenderer = (tool) => {
  const raw = tool.arguments;
  const record = parseJsonRecord(raw);
  const args = parseEditArgs(record);
  const result = parseEditResult(tool.result);
  const hasError = result.type === "error";
  const shownPath = args?.filePath ?? recoverPath(raw);

  if (!args && !raw && result.type === "empty") return null; // 无参数也无结果：交给兜底卡

  const body = document.createDocumentFragment();
  if (shownPath) body.append(pathRow(shownPath));
  if (hasError) body.append(tcErrorRow(result.message));
  if (args?.occurrence !== undefined) {
    body.append(
      tcKv(t("remote.toolCall.filesystem.occurrence"), String(args.occurrence)),
    );
  }
  if (result.type === "success") body.append(matchedRow(result));

  let meta: Node[] | undefined;
  /*
   * diff 只在参数完整、两侧文本齐备且无错误时渲染。replaceContent 允许为空串
   * （整段删除），searchContent 为空则无从对比。
   */
  if (args && !hasError && args.searchContent !== "") {
    const lines = computeLineDiff(args.searchContent, args.replaceContent);
    meta = [statsNode(diffStats(lines))];
    body.append(
      diffBlock(
        renderDiffView({
          fileName: fileNameOf(args.filePath),
          oldText: args.searchContent,
          newText: args.replaceContent,
          startLine:
            result.type === "success" ? result.matchedLineStart : undefined,
          lines,
        }),
      ),
    );
  } else if (!hasError) {
    // 无 diff 可显示：退回参数 JSON 展示（JSON 不可解析时退化为原文）。
    const fallback = argsFallbackSection(record, raw);
    if (fallback) body.append(fallback);
  }
  if (result.type === "raw") body.append(rawResultSection(result.text));

  return withBadgeIcon(
    createToolNode({
      tool,
      status: resolveStatus(tool),
      badge: t("remote.toolCall.filesystem.edit"),
      display:
        (shownPath ? fileNameOf(shownPath) : undefined) ?? argsSummary(raw),
      displayTitle: shownPath,
      meta,
      body: body.childNodes.length > 0 ? body : undefined,
    }),
    "file-pen",
  );
};

// ── create ───────────────────────────────────────────────────────────────

type CreateArgs = {
  filePath: string;
  content: string;
  isDirectory: boolean;
  overwrite: boolean;
};

type CreateResult =
  | { type: "success"; path: string }
  | { type: "error"; message: string }
  | { type: "raw"; text: string }
  | { type: "empty" };

const parseCreateArgs = (record: JsonRecord | null): CreateArgs | null => {
  if (!record) return null;
  if (typeof record.filePath !== "string" || !record.filePath) return null;
  return {
    filePath: record.filePath,
    content: typeof record.content === "string" ? record.content : "",
    isDirectory: record.isDirectory === true,
    overwrite: record.overwrite === true,
  };
};

const parseCreateResult = (raw?: string): CreateResult => {
  if (!raw) return { type: "empty" };
  const record = parseJsonRecord(raw);
  if (!record) return { type: "raw", text: raw };
  if (typeof record.error === "string") {
    return { type: "error", message: record.error };
  }
  if (record.success === true) {
    return {
      type: "success",
      path: typeof record.path === "string" ? record.path : "",
    };
  }
  return { type: "raw", text: raw };
};

export const renderCreateCard: ToolCallRenderer = (tool) => {
  const raw = tool.arguments;
  const record = parseJsonRecord(raw);
  const args = parseCreateArgs(record);
  const result = parseCreateResult(tool.result);
  const hasError = result.type === "error";
  const shownPath = args?.filePath ?? recoverPath(raw);

  if (!args && !raw && result.type === "empty") return null; // 无参数也无结果：交给兜底卡

  const body = document.createDocumentFragment();
  if (result.type === "success") {
    body.append(
      successRow(
        t("remote.toolCall.filesystem.created", {
          path: result.path || shownPath || "",
        }),
      ),
    );
  } else if (shownPath) {
    body.append(pathRow(shownPath));
  }
  if (hasError) body.append(tcErrorRow(result.message));
  if (args?.overwrite) {
    body.append(tcKv(t("remote.toolCall.filesystem.overwrite"), "true"));
  }

  const meta: Node[] = [];
  if (args?.isDirectory) {
    meta.push(tcBadge(t("remote.toolCall.filesystem.directory")));
  }

  if (args && !hasError && !args.isDirectory && args.content !== "") {
    // 全新增：oldText 为空串，整篇按新增渲染。
    const lines = computeLineDiff("", args.content);
    meta.unshift(statsNode(diffStats(lines)));
    body.append(
      diffBlock(
        renderDiffView({
          fileName: fileNameOf(args.filePath),
          oldText: "",
          newText: args.content,
          lines,
        }),
      ),
    );
  } else if (!hasError) {
    const fallback = argsFallbackSection(record, raw);
    if (fallback) body.append(fallback);
  }
  if (result.type === "raw") body.append(rawResultSection(result.text));

  return withBadgeIcon(
    createToolNode({
      tool,
      status: resolveStatus(tool),
      badge: t("remote.toolCall.filesystem.create"),
      display:
        (shownPath ? fileNameOf(shownPath) : undefined) ?? argsSummary(raw),
      displayTitle: shownPath,
      meta: meta.length ? meta : undefined,
      body: body.childNodes.length > 0 ? body : undefined,
    }),
    "file-plus",
  );
};

// ── copy ─────────────────────────────────────────────────────────────────

type CopyMode = "insert" | "replace";
type CopyPosition = "before" | "after";

type CopyArgs = {
  filePath: string;
  sourceFilePath: string;
  sourceStartLine?: number;
  sourceEndLine?: number;
  targetLine?: number;
  targetEndLine?: number;
  mode: CopyMode;
  position: CopyPosition;
  /** true = 剪切：粘贴后源区间从源文件删除。 */
  deleteSource: boolean;
};

/**
 * 源文件删除点的复核窗口（仅剪切时出现）。与 review 一样，窗口 content 不在卡片里
 * 渲染——源侧信息由 removedContent 与源文件的删除 diff 承担，这里只留定位字段。
 */
type CopySourceReview = {
  startLine?: number;
  totalLines?: number;
};

type CopyResult =
  | {
      type: "success";
      sourceFilePath: string;
      sourceLineStart?: number;
      sourceLineEnd?: number;
      copiedLines?: number;
      deleteSource: boolean;
      sourceTotalLines?: number;
      targetFilePath: string;
      mode: CopyMode;
      position?: CopyPosition;
      matchedLineStart?: number;
      matchedLineEnd?: number;
      totalLines?: number;
      replacedContent: string;
      pastedContent: string;
      omittedLines: number;
      formatPending: boolean;
      /** 剪切时才有：从源文件删掉的行内容（区域过大时中间省略）。 */
      removedContent?: string;
      sourceReview?: CopySourceReview;
    }
  | { type: "error"; message: string }
  | { type: "raw"; text: string }
  | { type: "empty" };

/** 枚举字段读取（非法值一律视为缺失，由调用方回退默认值）。 */
const copyModeOf = (value: unknown): CopyMode | undefined =>
  value === "insert" || value === "replace" ? value : undefined;

const copyPositionOf = (value: unknown): CopyPosition | undefined =>
  value === "before" || value === "after" ? value : undefined;

/** 解析 copy 参数：filePath（粘贴目的地）与 sourceFilePath 必填，其余逐字段类型防御。 */
const parseCopyArgs = (record: JsonRecord | null): CopyArgs | null => {
  if (!record) return null;
  if (typeof record.filePath !== "string" || !record.filePath) return null;
  if (typeof record.sourceFilePath !== "string" || !record.sourceFilePath) {
    return null;
  }
  const sourceStartLine = numberOf(record, "sourceStartLine");
  return {
    filePath: record.filePath,
    sourceFilePath: record.sourceFilePath,
    sourceStartLine,
    // sourceEndLine 缺省 = sourceStartLine（只复制一行）。
    sourceEndLine: numberOf(record, "sourceEndLine") ?? sourceStartLine,
    targetLine: numberOf(record, "targetLine"),
    targetEndLine: numberOf(record, "targetEndLine"),
    mode: copyModeOf(record.mode) ?? "insert",
    position: copyPositionOf(record.position) ?? "before",
    // 非布尔一律视为纯复制。
    deleteSource: record.deleteSource === true,
  };
};

/** 解析 sourceReview（仅剪切时出现；非对象一律视为缺失）。 */
const parseCopySourceReview = (record: JsonRecord): CopySourceReview | null => {
  const value = record.sourceReview;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const review = value as JsonRecord;
  return {
    startLine: numberOf(review, "startLine"),
    totalLines: numberOf(review, "totalLines"),
  };
};

const parseCopyResult = (raw?: string): CopyResult => {
  if (!raw) return { type: "empty" };
  const record = parseJsonRecord(raw);
  if (!record) return { type: "raw", text: raw };
  if (typeof record.error === "string") {
    return { type: "error", message: record.error };
  }
  if (record.success !== true) {
    // 失败结果是错误文本：无 success 标记时取 message 字段，取不到再回退原文。
    const message =
      typeof record.message === "string" ? record.message.trim() : "";
    return message ? { type: "error", message } : { type: "raw", text: raw };
  }
  const sourceLineStart = numberOf(record, "sourceLineStart");
  const sourceReview = parseCopySourceReview(record);
  return {
    type: "success",
    sourceFilePath:
      typeof record.sourceFilePath === "string" ? record.sourceFilePath : "",
    sourceLineStart,
    sourceLineEnd: numberOf(record, "sourceLineEnd") ?? sourceLineStart,
    copiedLines: numberOf(record, "copiedLines"),
    deleteSource: record.deleteSource === true,
    // 源文件本次操作后的总行数（缺字段时回退 sourceReview.totalLines，两者同值）。
    sourceTotalLines:
      numberOf(record, "sourceTotalLines") ?? sourceReview?.totalLines,
    targetFilePath:
      typeof record.targetFilePath === "string" ? record.targetFilePath : "",
    mode: copyModeOf(record.mode) ?? "insert",
    position: copyPositionOf(record.position),
    matchedLineStart: numberOf(record, "matchedLineStart"),
    matchedLineEnd: numberOf(record, "matchedLineEnd"),
    totalLines: numberOf(record, "totalLines"),
    replacedContent:
      typeof record.replacedContent === "string" ? record.replacedContent : "",
    pastedContent:
      typeof record.pastedContent === "string" ? record.pastedContent : "",
    omittedLines: numberOf(record, "omittedLines") ?? 0,
    formatPending: record.formatPending === true,
    // removedContent 缺失即 undefined：区分「没有回显」与「被删内容是空串」。
    removedContent:
      typeof record.removedContent === "string"
        ? record.removedContent
        : undefined,
    sourceReview: sourceReview ?? undefined,
  };
};

/** 路径归一化（去首尾空白 + 统一分隔符 + 大小写不敏感），用于判断源与目标是否同一文件。 */
const normalizePathForCompare = (filePath: string): string =>
  filePath.trim().replace(/\\/g, "/").toLowerCase();

/** 源区间边界：闭区间语义（逆序的两个行号等价于其区间）；起始行缺失返回 null。 */
const copyRegionBounds = (
  start?: number,
  end?: number,
): { from: number; to: number } | null =>
  start === undefined
    ? null
    : {
        from: Math.min(start, end ?? start),
        to: Math.max(start, end ?? start),
      };

/** 源区间标签：单行 / 区间两种文案（起始行缺失返回空串）。 */
const copySourceLabel = (start?: number, end?: number): string => {
  const bounds = copyRegionBounds(start, end);
  if (!bounds) return "";
  return bounds.from < bounds.to
    ? t("remote.toolCall.filesystem.copySourceRange", {
        start: bounds.from,
        end: bounds.to,
      })
    : t("remote.toolCall.filesystem.copySourceLine", { line: bounds.from });
};

/** 目标位置标签：replace 为目标区间，insert 为锚点行前后；无锚点的 insert 即追加。 */
const copyTargetLabel = (options: {
  mode: CopyMode;
  position?: CopyPosition;
  targetLine?: number;
  targetEndLine?: number;
}): string => {
  const { mode, position, targetLine, targetEndLine } = options;
  if (mode === "replace") {
    if (targetLine === undefined) return "";
    const last = targetEndLine ?? targetLine;
    return t("remote.toolCall.filesystem.copyTargetReplace", {
      start: Math.min(targetLine, last),
      end: Math.max(targetLine, last),
    });
  }
  if (targetLine === undefined) {
    return t("remote.toolCall.filesystem.copyTargetAppend");
  }
  return position === "after"
    ? t("remote.toolCall.filesystem.copyTargetAfter", { line: targetLine })
    : t("remote.toolCall.filesystem.copyTargetBefore", { line: targetLine });
};

/** 「源区间 → 目标位置」行：缺一侧时只显示存在的一侧，都缺返回 null。 */
const copyRouteRow = (source: string, target: string): HTMLElement | null => {
  if (source === "") return target === "" ? null : noteRow(target);
  if (target === "") return noteRow(source);
  return noteRow(t("remote.toolCall.filesystem.copyRoute", { source, target }));
};

/** 源侧统计行：被删行数 + 源文件剩余总行数（总行数缺失时只报行数）。 */
const copyRemovedNote = (count: number, sourceTotalLines?: number): string =>
  sourceTotalLines === undefined
    ? t("remote.toolCall.filesystem.copyRemovedSourceOnly", { count })
    : t("remote.toolCall.filesystem.copyRemovedSource", {
        count,
        total: sourceTotalLines,
      });

/** 结论行文案：优先「粘贴区域 + 文件总行数」，区域缺失时退化为「已复制 / 已剪切 N 行」。 */
const copyPastedLabel = (
  result: {
    matchedLineStart?: number;
    matchedLineEnd?: number;
    totalLines?: number;
    copiedLines?: number;
  },
  cut: boolean,
): string => {
  const start = result.matchedLineStart;
  if (start === undefined) {
    const count = result.copiedLines;
    if (count === undefined) return "";
    return cut
      ? t("remote.toolCall.filesystem.copyCutCount", { count })
      : t("remote.toolCall.filesystem.copiedCount", { count });
  }
  const end = result.matchedLineEnd ?? start;
  const values = {
    start,
    end,
    total: result.totalLines ?? result.copiedLines ?? end - start + 1,
  };
  return cut
    ? t("remote.toolCall.filesystem.copyCutPasted", values)
    : t("remote.toolCall.filesystem.copyPasted", values);
};

export const renderCopyCard: ToolCallRenderer = (tool) => {
  const raw = tool.arguments;
  const record = parseJsonRecord(raw);
  const args = parseCopyArgs(record);
  const result = parseCopyResult(tool.result);
  const hasError = result.type === "error";
  const success = result.type === "success" ? result : null;
  const shownPath =
    args?.filePath ??
    (success?.targetFilePath || undefined) ??
    recoverPath(raw);

  if (!args && !raw && result.type === "empty") return null; // 无参数也无结果：交给兜底卡

  const body = document.createDocumentFragment();
  if (shownPath) body.append(pathRow(shownPath));

  /*
   * 源区间 / 目标位置：锚点行只存在于参数里，因此参数优先；参数缺失时用结果里的
   * 源区间与 replace 的目标区域兜底（insert 的粘贴区域已由结论行给出）。
   */
  const sourceStart = args?.sourceStartLine ?? success?.sourceLineStart;
  const sourceEnd = args?.sourceEndLine ?? success?.sourceLineEnd;
  const bounds = copyRegionBounds(sourceStart, sourceEnd);
  const sourceName = fileNameOf(
    args?.sourceFilePath ?? success?.sourceFilePath ?? "",
  );
  const route = copyRouteRow(
    [sourceName, copySourceLabel(sourceStart, sourceEnd)]
      .filter(Boolean)
      .join(" "),
    args
      ? copyTargetLabel(args)
      : success && success.mode === "replace"
        ? copyTargetLabel({
            mode: "replace",
            targetLine: success.matchedLineStart,
            targetEndLine: success.matchedLineEnd,
          })
        : "",
  );
  if (route) body.append(route);
  if (hasError) body.append(tcErrorRow(result.message));

  // 剪切（deleteSource=true）：结果回显优先，结果里缺该字段时退回参数。
  const cut = success?.deleteSource ?? args?.deleteSource ?? false;
  const sourcePath = success?.sourceFilePath || args?.sourceFilePath || "";
  const targetPath = success?.targetFilePath || args?.filePath || "";
  // 源 / 目标同一文件 = 文件内移动：源侧没有独立的删除 diff，只给一行说明。
  const sameFile =
    sourcePath !== "" &&
    targetPath !== "" &&
    normalizePathForCompare(sourcePath) === normalizePathForCompare(targetPath);

  let meta: Node[] | undefined;
  if (success) {
    const pastedLabel = copyPastedLabel(success, cut);
    if (pastedLabel) body.append(successRow(pastedLabel));
    // 目标侧 diff：replace 用被替换的原目标行作旧侧，insert 旧侧为空串（整段按新增渲染）。
    const replaced = success.mode === "replace" ? success.replacedContent : "";
    if (success.pastedContent !== "") {
      const lines = computeLineDiff(replaced, success.pastedContent);
      meta = [statsNode(diffStats(lines))];
      body.append(
        diffBlock(
          renderDiffView({
            fileName: fileNameOf(success.targetFilePath || shownPath || ""),
            oldText: replaced,
            newText: success.pastedContent,
            startLine: success.matchedLineStart,
            lines,
          }),
        ),
      );
    }
    if (cut) {
      const removedCount = bounds ? bounds.to - bounds.from + 1 : undefined;
      if (sameFile) {
        // 文件内移动：源区间已就地移除，位置说明即可，不再渲染第二个 diff。
        if (bounds) {
          body.append(
            noteRow(
              t("remote.toolCall.filesystem.copyMoveSameFile", {
                start: bounds.from,
                end: bounds.to,
              }),
            ),
          );
        }
      } else {
        // 跨文件剪切：源文件侧的删除 diff（旧侧为被删内容，新侧为空串）。
        if (removedCount !== undefined) {
          body.append(
            noteRow(copyRemovedNote(removedCount, success.sourceTotalLines)),
          );
        }
        const removed = success.removedContent ?? "";
        // 被删内容是空串（剪掉一行空行）时无从对比，只留上面的统计行。
        if (removed !== "") {
          const lines = computeLineDiff(removed, "");
          if (meta === undefined) meta = [statsNode(diffStats(lines))];
          body.append(
            diffBlock(
              renderDiffView({
                fileName: fileNameOf(sourcePath),
                oldText: removed,
                newText: "",
                // 行号锚点取源区间起点，sourceReview 只在缺字段时兜底。
                startLine: sourceStart ?? success.sourceReview?.startLine,
                lines,
              }),
            ),
          );
        }
      }
    }
    // 目标 / 源都没有 diff 可显示：用行数徽章补足头部信息。
    if (meta === undefined && success.copiedLines !== undefined) {
      meta = [
        tcBadge(
          t("remote.toolCall.filesystem.linesTotal", {
            count: success.copiedLines,
          }),
        ),
      ];
    }
    if (success.omittedLines > 0) {
      body.append(
        noteRow(
          t("remote.toolCall.filesystem.copyOmitted", {
            count: success.omittedLines,
          }),
        ),
      );
    }
    if (success.formatPending) {
      body.append(noteRow(t("remote.toolCall.filesystem.copyFormatPending")));
    }
  } else if (!hasError) {
    const fallback = argsFallbackSection(record, raw);
    if (fallback) body.append(fallback);
  }
  if (result.type === "raw") body.append(rawResultSection(result.text));

  return withBadgeIcon(
    createToolNode({
      tool,
      status: resolveStatus(tool),
      badge: t(
        cut
          ? "remote.toolCall.filesystem.copyCut"
          : "remote.toolCall.filesystem.copy",
      ),
      display:
        (shownPath ? fileNameOf(shownPath) : undefined) ?? argsSummary(raw),
      displayTitle: shownPath,
      meta,
      body: body.childNodes.length > 0 ? body : undefined,
    }),
    "copy",
  );
};

// ── 注册表 ───────────────────────────────────────────────────────────────

export const filesystemModule: ToolModule = {
  renderers: {
    "filesystem-read": renderReadCard,
    "filesystem-replace_edit": renderEditCard,
    "filesystem-create": renderCreateCard,
    "filesystem-copy": renderCopyCard,
  },
  prefixes: [],
};
