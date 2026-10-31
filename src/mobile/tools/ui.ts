/**
 * 工具卡片公共套件：卡片骨架、分隔区、折叠文本、键值行、徽章、错误行，
 * 以及参数摘要 / JSON 解析 / 长文本抽取等纯函数。
 *
 * DOM 契约（styles/tools/base.css、timeline.ts 的点击委托与各模块卡片都依赖，
 * 改名会波及下游）：
 *
 *   details.tool.<status>.tcn[.<模块根类>]
 *     summary
 *       span.tool-dot
 *       span.tool-name            ← 徽章文案（模块短名；title = 工具全名）
 *       span.tc-display?          ← 参数摘要（title = 全量摘要）
 *       span.tc-meta?             ← 计数 / 结论徽章等附加信息
 *       span.tool-state           ← 状态文案
 *       span.tc-chevron
 *     div.tc-body[.<bodyClass>]
 *       div.tc-section > div.tc-section-title + 内容
 *       div.tc-kv > span.tc-kv-label + span.tc-kv-value
 *       span.tc-badge[.tc-badge-ok|warn|err|muted]
 *       div.tc-error
 *       div.tc-fold > pre.tc-pre + button.tc-more > span.tc-more-label + span.tc-more-icon
 *       img.tc-image
 *
 * 折叠协议：需要折叠的文本块外包一层 .tc-fold，点击 .tc-more 由 timeline.ts
 * 的事件委托在「最近的 .tc-fold（兼容 .tc-pre）祖先」上切换 .tc-expanded，
 * 并更新 .tc-more-label 文案；折叠态样式由 base.css / 模块 CSS 按
 * `.tc-fold:not(.tc-expanded)` 表达。
 *
 * 所有文本一律 createElement + textContent，数据绝不拼进 innerHTML。
 */
import type { SnowRemoteToolCall } from "../../renderer/types/remoteControl";
import { t } from "../i18n";
import { iconMarkup, type MobileIconName } from "../icons";
import type { ToolStatus } from "./types";

export type JsonRecord = Record<string, unknown>;

/** 状态 → 词条键（common 命名空间，三语同键）。 */
const STATUS_KEYS: Record<string, string> = {
  pending: "remote.toolCall.common.status.pending",
  running: "remote.toolCall.common.status.running",
  completed: "remote.toolCall.common.status.completed",
  error: "remote.toolCall.common.status.error",
};

/** 折叠阈值：超过 maxLines 行（或等量字符）才生成 .tc-fold。 */
const FOLD_LINE_CHARS = 96;

/** 头部摘要键优先级（与桌面 ToolCallItem.getArgsSummary 保持一致）。 */
const SUMMARY_KEYS = [
  "filePath",
  "path",
  "url",
  "query",
  "expression",
  "pattern",
  "command",
  "selector",
  "text",
  "name",
  "tool",
  "key",
  "prompt",
  "message",
  "content",
  "host",
  "server",
  "database",
  "db",
  "connection",
  "connectionName",
  "connection_name",
  "channel",
  "agentId",
  "agent_id",
  "skillId",
  "skill_id",
  "scope",
  "fileName",
  "file",
  "domain",
  "endpoint",
  "baseUrl",
  "model",
  "instanceId",
  "instance_id",
  "taskId",
  "task_id",
  "table",
  "action",
] as const;

/** 长文本候选键（与桌面 ToolCallItem 的 LONG_TEXT_KEYS 保持一致）。 */
const LONG_TEXT_KEYS = [
  "content",
  "text",
  "value",
  "markdown",
  "result",
  "output",
  "html",
  "description",
  "summary",
  "message",
  "body",
  "data",
] as const;

/** 摘要截断长度（单行头部展示，与桌面端一致）。 */
const SUMMARY_MAX_CHARS = 56;

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

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 图标占位（只承载 lucide 静态标记，不含任何数据）。 */
const iconSpan = (name: MobileIconName, className: string): HTMLSpanElement => {
  const span = el("span", className);
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = iconMarkup(name);
  return span;
};

// ── 文本工具 ────────────────────────────────────────────────────────────────

/**
 * 字面转义还原：仅当文本里没有真实换行且存在字面 `\n` 时解码，
 * 避免破坏本来就含真实换行的内容（与桌面端实现一致）。
 */
export const decodeEscapedNewlines = (text: string): string => {
  if (text.includes("\n") || !text.includes("\\n")) return text;
  return text
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t");
};

/**
 * 安全 JSON 解析：仅接受对象（数组 / 字面量 / 非法 JSON 一律返回 null，
 * 调用方据此回退原文展示）。
 */
export const parseJsonRecord = (text?: string): JsonRecord | null => {
  if (!text) return null;
  const raw = text.trim();
  if (!raw.startsWith("{")) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
};

/**
 * 工具结果落盘图片（`upload/<日期>/<hash>.<ext>`）→ 远控取图端点；其他值返回 null。
 * 桌面端 Rust 把截图 / 抓取图等 base64 落盘后只下发路径，手机端经此端点按需读取。
 */
export const uploadImageUrl = (value?: string): string | null => {
  const match =
    /^upload\/(\d{4}-\d{2}-\d{2})\/([0-9a-f]{64}\.[a-z0-9]+)$/i.exec(
      value?.trim() ?? "",
    );
  return match ? `/api/upload-images/${match[1]}/${match[2]}` : null;
};

/** 美化 JSON（2 空格缩进；循环引用等异常回退为字符串）。 */
export const formatJson = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
};

/** 从结果记录里抽取首个长文本字段作为展示主体（无则返回 null）。 */
export const extractLongText = (record: JsonRecord): string | null => {
  for (const key of LONG_TEXT_KEYS) {
    const value = record[key];
    if (
      typeof value === "string" &&
      value.trim() !== "" &&
      (value.includes("\\n") || value.includes("\n") || value.length > 160)
    ) {
      return decodeEscapedNewlines(value);
    }
  }
  return null;
};

const truncate = (value: string, max = SUMMARY_MAX_CHARS): string =>
  value.length > max ? `${value.slice(0, max)}...` : value;

/**
 * 参数摘要：按 SUMMARY_KEYS 优先级取首个可读字段（路径 / 查询 / 命令…），
 * 依次尝试「字符串 → host:port 组合 → 数组首项」，与桌面端 getArgsSummary
 * 的优先级和截断规则对齐；参数缺失 / JSON 不可解析返回 undefined。
 */
export const argsSummary = (args?: string): string | undefined => {
  const record = parseJsonRecord(args);
  if (!record) return undefined;

  for (const key of SUMMARY_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") {
      return truncate(value.trim());
    }
  }

  const host = record.host ?? record.server;
  const port = record.port;
  if (typeof host === "string" && host.trim() !== "") {
    return truncate(
      typeof port === "number" && Number.isFinite(port)
        ? `${host.trim()}:${port}`
        : host.trim(),
    );
  }

  for (const key of SUMMARY_KEYS) {
    const value = record[key];
    if (!Array.isArray(value)) continue;
    const first = value.find(
      (item): item is string => typeof item === "string",
    );
    if (first && first.trim() !== "") return truncate(first.trim());
  }
  return undefined;
};

/** 工具名 → 短标签（去首段前缀：filesystem-edit → edit、lsp-diagnostics → diagnostics）。 */
export const toolShortName = (name: string): string => {
  const bare = name.replace(/^mcp__[^_]+__/i, "");
  const separator = bare.includes("-") ? "-" : bare.includes("_") ? "_" : "";
  if (!separator) return bare;
  const parts = bare.split(separator);
  return parts.length > 1 ? parts.slice(1).join(separator) : bare;
};

// ── 状态 ────────────────────────────────────────────────────────────────────

const isToolStatus = (status: string): status is ToolStatus =>
  status in STATUS_KEYS;

/** 状态文案（未知状态原样显示，不回退成误导性的「失败」）。 */
export const statusLabel = (status: string): string => {
  const key = STATUS_KEYS[status];
  return key ? t(key) : status || "-";
};

/**
 * 由工具快照推导状态：结果 JSON 带 error 字段视为失败；未知状态按 error
 * 处理（与桌面 ToolCallItem.hasResultError 的判定一致）。
 */
export const resolveStatus = (tool: SnowRemoteToolCall): ToolStatus => {
  const record = parseJsonRecord(tool.result);
  if (
    record &&
    typeof record.error === "string" &&
    record.error.trim() !== ""
  ) {
    return "error";
  }
  return isToolStatus(tool.status) ? tool.status : "error";
};

// ── 基础节点 ────────────────────────────────────────────────────────────────

/** 徽章（meta 区 / 段落标题旁的短标签）。 */
export const tcBadge = (
  text: string,
  variant?: "ok" | "warn" | "err" | "muted",
): HTMLElement => {
  const badge = el("span", "tc-badge", text);
  if (variant) badge.classList.add(`tc-badge-${variant}`);
  return badge;
};

/** 键值行（label 左、value 右；窄屏单行省略，title 保留全文）。 */
export const tcKv = (label: string, value: string): HTMLElement => {
  const row = el("div", "tc-kv");
  const valueEl = el("span", "tc-kv-value", value);
  valueEl.title = value;
  row.append(el("span", "tc-kv-label", label), valueEl);
  return row;
};

export type TcSectionOptions = {
  /** 标题行图标（lucide 名，见 ../icons.ts）。 */
  icon?: MobileIconName;
  /** 标题行右侧附加内容（计数徽章等）。 */
  meta?: (Node | string)[];
};

/** 分隔区：标题行 + 内容（标题行结构固定为 .tc-section-title）。 */
export const tcSection = (
  label: string,
  content: Node,
  opts?: TcSectionOptions,
): HTMLElement => {
  const section = el("div", "tc-section");
  const title = el("div", "tc-section-title");
  if (opts?.icon) title.append(iconSpan(opts.icon, "tc-section-icon"));
  title.append(el("span", "tc-section-label", label));
  for (const item of opts?.meta ?? []) title.append(item);
  section.append(title, content);
  return section;
};

/** 错误行（红色文本块，长错误原样换行）。 */
export const tcErrorRow = (message: string): HTMLElement =>
  el("div", "tc-error", message);

/** 折叠按钮：文案节点 .tc-more-label 由 timeline.ts 的委托按状态更新。 */
const tcMoreButton = (): HTMLButtonElement => {
  const button = el("button", "tc-more");
  button.type = "button";
  button.setAttribute("aria-expanded", "false");
  button.append(
    el("span", "tc-more-label", t("remote.toolCall.common.expand")),
    iconSpan("chevron-down", "tc-more-icon"),
  );
  return button;
};

/** 是否需要折叠（行数或等量字符超阈值）。 */
const shouldFold = (text: string, maxLines: number): boolean =>
  text.split("\n").length > maxLines ||
  text.length > maxLines * FOLD_LINE_CHARS;

export type TcPreOptions = {
  /** 折叠前展示的行数上限（默认 12 行）。 */
  maxLines?: number;
};

/**
 * 等宽文本块：未超阈值时返回单个 pre.tc-pre；超阈值时外包 .tc-fold
 * 并附 .tc-more 按钮（展开态 .tc-expanded 由 timeline.ts 的委托切换）。
 */
export const tcPre = (text: string, opts?: TcPreOptions): HTMLElement => {
  const maxLines = opts?.maxLines ?? 12;
  const pre = el("pre", "tc-pre", text);
  if (!shouldFold(text, maxLines)) return pre;
  const fold = el("div", "tc-fold");
  // CSS 用 --tc-fold-lines 计算折叠高度，保持与 maxLines 一致。
  fold.style.setProperty("--tc-fold-lines", String(maxLines));
  fold.append(pre, tcMoreButton());
  return fold;
};

// ── 卡片骨架 ────────────────────────────────────────────────────────────────

export type ToolNodeOptions = {
  tool: SnowRemoteToolCall;
  /** 头部徽章文案（模块短名；缺省用 toolShortName(tool.name)）。 */
  badge?: string;
  /** 头部摘要（参数摘要 / 路径 / 命令等）。 */
  display?: string;
  /** 摘要的 title（缺省与 display 相同，如完整的参数原文）。 */
  displayTitle?: string;
  /** 覆盖状态（默认由 resolveStatus 推导）。 */
  status?: ToolStatus;
  /** 头部 meta 区节点（徽章 / 计数等）。 */
  meta?: (Node | string)[];
  /** 折叠体内容，可为单个节点、节点数组或 DocumentFragment；为空则不渲染 body。 */
  body?: Node | Node[];
  /** 折叠体附加类名（如模块命名空间类）。 */
  bodyClass?: string;
  /**
   * 初始展开。框架自身从不传（默认折叠，只有用户点击才展开）；仅当模块卡
   * 片有明确理由时才显式开启。
   */
  defaultOpen?: boolean;
  /** 根节点附加类名（模块自有定位类）。 */
  className?: string;
};

/**
 * 工具卡骨架：details.tool.<status>.tcn > summary + div.tc-body。
 * dataset.toolId / dataset.sig 由 timeline.ts 的 syncToolList 设置。
 */
export const createToolNode = (opts: ToolNodeOptions): HTMLDetailsElement => {
  const status = opts.status ?? resolveStatus(opts.tool);
  const details = el("details", "tool tcn");
  details.classList.add(status);
  if (opts.className) details.classList.add(...opts.className.split(/\s+/));

  const summary = el("summary", "tc-summary");
  const name = el(
    "span",
    "tool-name",
    opts.badge ?? toolShortName(opts.tool.name),
  );
  name.title = opts.tool.name;
  summary.append(el("span", "tool-dot"), name);

  if (opts.display) {
    const display = el("span", "tc-display", opts.display);
    display.title = opts.displayTitle ?? opts.display;
    summary.append(display);
  }
  const metaParts = opts.meta ?? [];
  if (metaParts.length > 0) {
    const meta = el("span", "tc-meta");
    for (const item of metaParts) meta.append(item);
    summary.append(meta);
  }
  summary.append(el("span", "tool-state", statusLabel(status)));
  summary.append(el("span", "tc-chevron"));
  details.append(summary);

  const bodyParts =
    opts.body === undefined
      ? []
      : Array.isArray(opts.body)
        ? opts.body
        : [opts.body];
  if (bodyParts.length > 0) {
    const body = el("div", "tc-body");
    if (opts.bodyClass) body.classList.add(...opts.bodyClass.split(/\s+/));
    for (const part of bodyParts) {
      if (part) body.append(part);
    }
    details.append(body);
  }

  if (opts.defaultOpen) details.open = true;
  return details;
};
