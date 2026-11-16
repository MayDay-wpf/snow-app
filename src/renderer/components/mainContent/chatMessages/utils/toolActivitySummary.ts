import type { TranslateOptions } from "../../../../i18n/translate";
import type { ToolCallInfo } from "./conversationTypes";

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

const ACTIVITY_DEFAULTS: Record<ActivityKind, [string, string]> = {
  read: ["Read {{count}} file", "Read {{count}} files"],
  search: ["{{count}} search", "{{count}} searches"],
  edit: ["Edited {{count}} file", "Edited {{count}} files"],
  command: ["Ran {{count}} command", "Ran {{count}} commands"],
  web: ["{{count}} web action", "{{count}} web actions"],
  other: ["{{count}} other tool", "{{count}} other tools"],
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

/** 读/写类工具按目标文件去重；参数未完整到达时退回按调用计数。 */
const extractFilePath = (args: string): string | null => {
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>;
    const path = parsed.filePath ?? parsed.path;
    return typeof path === "string" && path ? path : null;
  } catch {
    return null;
  }
};

/**
 * 把一组工具调用汇总为 Codex 风格的活动描述，
 * 例如「浏览 3 个文件 · 搜索 2 次 · 运行 1 条命令」。
 */
export const summarizeToolActivity = (
  toolCalls: readonly ToolCallInfo[],
  t: Translate,
): string => {
  const counts = new Map<ActivityKind, number>();
  const seenFiles = new Map<ActivityKind, Set<string>>();

  for (const toolCall of toolCalls) {
    const kind = classifyTool(toolCall.name);
    if (kind === "read" || kind === "edit") {
      const path = extractFilePath(toolCall.arguments);
      if (path) {
        let seen = seenFiles.get(kind);
        if (!seen) {
          seen = new Set();
          seenFiles.set(kind, seen);
        }
        if (seen.has(path)) continue;
        seen.add(path);
      }
    }
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }

  const parts: string[] = [];
  for (const kind of ACTIVITY_ORDER) {
    const count = counts.get(kind);
    if (!count) continue;
    const [one, many] = ACTIVITY_DEFAULTS[kind];
    parts.push(
      count === 1
        ? t(`toolCall.activity.${kind}One`, {
            defaultValue: one,
            values: { count },
          })
        : t(`toolCall.activity.${kind}`, {
            defaultValue: many,
            values: { count },
          }),
    );
  }
  return parts.join(" · ");
};

/** 紧凑时长：45s / 2m 13s / 1h 5m。 */
export const formatWorkDuration = (ms: number): string => {
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
};

/** 解析消息时间戳（ISO 或 "YYYY-MM-DD HH:MM:SS"），失败返回 null。 */
export const parseMessageTime = (value: string | undefined): number | null => {
  const text = value?.trim();
  if (!text) return null;
  const ms = Date.parse(text.includes("T") ? text : text.replace(" ", "T"));
  return Number.isNaN(ms) ? null : ms;
};
