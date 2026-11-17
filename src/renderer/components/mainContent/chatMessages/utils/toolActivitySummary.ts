import type { TranslateOptions } from "../../../../i18n/translate";
import type { ToolCallInfo } from "./conversationTypes";
import { resolveToolDisplayName } from "../toolCalls/shared/toolDisplayName";

type Translate = (key: string, options?: TranslateOptions) => string;

type ActivityKind = "read" | "search" | "edit" | "command" | "web" | "other";

const ACTIVITY_ORDER: readonly ActivityKind[] = [
  "read",
  "search",
  "edit",
  "command",
  "web",
  "other",
];

const ACTIVITY_DEFAULTS: Record<ActivityKind, string> = {
  read: "浏览 {{count}} 个文件",
  search: "搜索 {{count}} 次",
  edit: "编辑 {{count}} 个文件",
  command: "运行 {{count}} 条命令",
  web: "网页操作 {{count}} 次",
  other: "其他工具 {{count}} 个",
};

const SEARCH_TOOLS = new Set([
  "grep-search",
  "grep-find",
  "codebase-search",
  "websearch-websearch-search",
  "toolSearch-discover",
]);

const EDIT_TOOLS = new Set([
  "filesystem-replace_edit",
  "filesystem-create",
  "filesystem-copy",
]);

const classifyTool = (name: string): ActivityKind => {
  if (name === "filesystem-read") return "read";
  if (SEARCH_TOOLS.has(name) || name.startsWith("lsp-")) return "search";
  if (EDIT_TOOLS.has(name)) return "edit";
  if (name === "bash-terminal-execute" || name.startsWith("terminal-")) {
    return "command";
  }
  if (name === "websearch-websearch-fetch" || name.startsWith("browser-")) {
    return "web";
  }
  return "other";
};

/** 单行目标描述的最大字符数。 */
const TARGET_MAX_CHARS = 48;

const collapse = (text: string, maxChars: number): string => {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > maxChars ? `${single.slice(0, maxChars)}…` : single;
};

/** 文件路径取末段文件名，保留可读性。 */
const fileLabel = (path: string): string => {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
};

const parseArguments = (args: string): Record<string, unknown> | null => {
  if (!args) return null;
  try {
    const value = JSON.parse(args) as unknown;
    return value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const pickString = (
  record: Record<string, unknown> | null,
  ...keys: string[]
): string | null => {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
};

/** 工具摘要（description / summary）优先，其次才是目标本身。 */
const extractSummary = (
  args: Record<string, unknown> | null,
): string | null => {
  const summary = pickString(args, "description", "summary");
  return summary ? collapse(summary, TARGET_MAX_CHARS) : null;
};

/** 从工具参数里取一个简短目标（文件名 / 模式 / 命令首行等）。 */
const extractTarget = (
  kind: ActivityKind,
  args: Record<string, unknown> | null,
): string | null => {
  if (kind === "other") return null;
  switch (kind) {
    case "read":
    case "edit": {
      const path = pickString(args, "filePath", "path");
      return path ? fileLabel(path) : null;
    }
    case "search": {
      const target = pickString(args, "pattern", "query", "glob");
      return target ? collapse(target, TARGET_MAX_CHARS) : null;
    }
    case "command": {
      const command = pickString(args, "command");
      return command ? collapse(command, TARGET_MAX_CHARS) : null;
    }
    case "web": {
      const target = pickString(args, "query", "url");
      return target ? collapse(target, TARGET_MAX_CHARS) : null;
    }
    default:
      return null;
  }
};

type ToolCallDigest = {
  kind: ActivityKind;
  /** 读/写类目标路径（用于按文件去重）。 */
  path: string | null;
  /** 工具的 description / summary 摘要。 */
  summary: string | null;
  /** 兜底目标（文件名 / 模式 / 命令首行）。 */
  target: string | null;
};

/** 工具调用对象是不可变快照：解析结果按对象缓存，滚动/流式时不必反复 JSON.parse。 */
const digestCache = new WeakMap<ToolCallInfo, ToolCallDigest>();

const digestOf = (toolCall: ToolCallInfo): ToolCallDigest => {
  const cached = digestCache.get(toolCall);
  if (cached) return cached;
  const kind = classifyTool(toolCall.name);
  const args = parseArguments(toolCall.arguments);
  const digest: ToolCallDigest = {
    kind,
    path: pickString(args, "filePath", "path"),
    summary: extractSummary(args),
    target: extractTarget(kind, args),
  };
  digestCache.set(toolCall, digest);
  return digest;
};

/**
 * 把一组工具调用汇总为活动摘要，
 * 例如「浏览 3 个文件 · 搜索 2 次 · 运行 1 条命令」。
 */
const summarizeActivities = (
  toolCalls: readonly ToolCallInfo[],
  t: Translate,
): string => {
  const counts = new Map<ActivityKind, number>();
  const seenFiles = new Map<ActivityKind, Set<string>>();

  for (const toolCall of toolCalls) {
    const { kind, path } = digestOf(toolCall);
    if ((kind === "read" || kind === "edit") && path) {
      let seen = seenFiles.get(kind);
      if (!seen) {
        seen = new Set<string>();
        seenFiles.set(kind, seen);
      }
      if (seen.has(path)) continue;
      seen.add(path);
    }
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }

  const parts: string[] = [];
  for (const kind of ACTIVITY_ORDER) {
    const count = counts.get(kind);
    if (!count) continue;
    parts.push(
      t(`toolCall.activity.${count === 1 ? `${kind}One` : kind}`, {
        defaultValue: ACTIVITY_DEFAULTS[kind],
        values: { count },
      }),
    );
  }
  return parts.join(" · ");
};

const LATEST_KEY: Record<ActivityKind, string> = {
  read: "read",
  search: "search",
  edit: "edit",
  command: "command",
  web: "web",
  other: "other",
};

const LATEST_DEFAULTS: Record<string, string> = {
  readDone: "已读取 {{name}}",
  searchDone: "已搜索 {{name}}",
  editDone: "已编辑 {{name}}",
  commandDone: "已运行 {{name}}",
  webDone: "已访问 {{name}}",
  otherDone: "已完成 {{name}}",
  error: "{{name}} 失败",
};

/** 仍未结束的工具数（排队 + 运行中）。 */
const countActive = (toolCalls: readonly ToolCallInfo[]): number => {
  let active = 0;
  for (const toolCall of toolCalls) {
    if (toolCall.status === "running" || toolCall.status === "pending") {
      active += 1;
    }
  }
  return active;
};

/**
 * 最近一条已结束工具的结果描述：只展示结果，不展示等待/执行中状态。
 * 读取类工具瞬间就完成，先显示「正在读取」再改「已读取」只会让标题连闪。
 */
const describeSettledActivity = (
  toolCalls: readonly ToolCallInfo[],
  t: Translate,
): string => {
  for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
    const toolCall = toolCalls[index];
    if (toolCall.status !== "completed" && toolCall.status !== "error") {
      continue;
    }
    const { kind, summary, target } = digestOf(toolCall);
    const name = summary ?? target ?? resolveToolDisplayName(t, toolCall.name);
    const key =
      toolCall.status === "error" ? "error" : `${LATEST_KEY[kind]}Done`;
    return t(`toolCall.latest.${key}`, {
      defaultValue: LATEST_DEFAULTS[key] ?? "{{name}}",
      values: { name },
    });
  }
  return "";
};

/**
 * 工具集合标题行：执行中只显示最近一条工具的结果，整组结束后显示
 * 「活动摘要 · 结果」。摘要计数会随每个工具启动/完成改写，放在执行中
 * 会导致标题行持续变字，所以只在结束后出现。
 */
export const describeToolRunHeader = (
  toolCalls: readonly ToolCallInfo[],
  t: Translate,
): string => {
  if (toolCalls.length === 0) return "";
  const settled = describeSettledActivity(toolCalls, t);
  const summary = summarizeActivities(toolCalls, t);
  // 还没有结果时先给聚合计数，避免标题行空白。
  if (countActive(toolCalls) > 0) return settled || summary;
  return summary ? `${summary} · ${settled}` : settled;
};
