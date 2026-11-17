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
  read: "正在读取 {{name}}",
  readDone: "已读取 {{name}}",
  search: "正在搜索 {{name}}",
  searchDone: "已搜索 {{name}}",
  edit: "正在编辑 {{name}}",
  editDone: "已编辑 {{name}}",
  command: "正在运行 {{name}}",
  commandDone: "已运行 {{name}}",
  web: "正在访问 {{name}}",
  webDone: "已访问 {{name}}",
  other: "正在执行 {{name}}",
  otherDone: "已完成 {{name}}",
  pending: "等待执行 {{name}}",
  error: "{{name}} 失败",
};

/**
 * 最新一条工具的状态描述：取最后创建的那一条（不按状态回跳），
 * 这样标题只在「新工具开始」和「它自己状态变化」时变字，不会因为并发
 * 工具依次完成而反复改写；文案优先用工具的 description / summary。
 */
const describeLatestActivity = (
  toolCalls: readonly ToolCallInfo[],
  t: Translate,
): string => {
  const latest = toolCalls[toolCalls.length - 1];

  const { kind, summary, target } = digestOf(latest);
  const name = summary ?? target ?? resolveToolDisplayName(t, latest.name);
  const key =
    latest.status === "pending"
      ? "pending"
      : latest.status === "error"
        ? "error"
        : latest.status === "running"
          ? LATEST_KEY[kind]
          : `${LATEST_KEY[kind]}Done`;
  return t(`toolCall.latest.${key}`, {
    defaultValue: LATEST_DEFAULTS[key] ?? "{{name}}",
    values: { name },
  });
};

/**
 * 工具集合标题行：「活动摘要 · 最新一条工具」。
 *
 * 摘要是整组工具的聚合（读了几个文件、搜了几次、跑了几条命令），
 * 末尾跟最新一条工具的状态，随执行推进实时更新。
 */
export const describeToolRunHeader = (
  toolCalls: readonly ToolCallInfo[],
  t: Translate,
): string => {
  if (toolCalls.length === 0) return "";
  const summary = summarizeActivities(toolCalls, t);
  const latest = describeLatestActivity(toolCalls, t);
  return summary ? `${summary} · ${latest}` : latest;
};
