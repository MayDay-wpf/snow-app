/**
 * ops 工具族卡片：配置 / 应用控制 / 数据库（外部 MCP）与
 * user-interaction 提问的移动端只读复盘视图。
 *
 * 归口工具：
 * - 精确名 `user-interaction-askUserQuestion` → 提问卡片（问题 + 选项勾选态 + 作答结论）；
 * - 前缀 `config-` / `app-control-` / `dbx-` / `dbx_` → 对应工具族卡片：
 *   config-* 头部为「操作 · scope/key = 值」摘要，正文含参数、变更结果与影响范围；
 *   app-control-* 头部为操作名 + 详情，正文含参数详情、结果 JSON 与错误；
 *   dbx-* / dbx_* 把查询结果表格化（columns + rows，最多 TABLE_ROWS 行，超出给省略
 *   提示），操作名按桌面规则归一（连字符 / 下划线 / 自带 dbx_ 前缀的复合形态）。
 *
 * 归口边界（重要）：待办（todo-todo-manage）与记忆（memory-manage）由 tools/agents.ts
 * 承担（更新更全的实现，且位于模块合并顺序之前）；本模块不再重复注册这两个族，
 * 避免同名覆盖造成其中一份实现不可达。
 *
 * 约定（与 tools/ui.ts 一致）：
 * - 数据一律 createElement + textContent，只有静态图标标记走 innerHTML；
 * - 远控桥全量下发 arguments / result（不截断）；旧版快照可能是半截 JSON，
 *   解析全部走容错路径：JSON 不可解析 → 原文回退，字段缺失 → 该行不渲染；
 * - 提问的提交动作在手机端独立交互区（interactions.ts）完成，本模块只做
 *   时间线内的只读复盘（等待中 / 已回答 / 已取消）；
 * - 参数与结果都解析不出、也没有提问快照时返回 null，交由 generic 兜底卡展示
 *   参数原文与流式输出（避免出现空壳的模块卡）；
 * - 结果表（dbx）优先结构化 rows，其次 Markdown 表格，都没有才回退原文。
 */

import type { SnowRemoteToolCall } from "../../renderer/types/remoteControl";
import { t } from "../i18n";
import { iconMarkup, type MobileIconName } from "../icons";
import { renderGenericTool } from "./generic";
import type { ToolModule } from "./types";
import {
  argsSummary,
  createToolNode,
  decodeEscapedNewlines,
  parseJsonRecord,
  resolveStatus,
  tcBadge,
  tcErrorRow,
  tcKv,
  tcPre,
  tcSection,
} from "./ui";

/** 词条取用：本模块所有键都在 remote.toolCall.ops.* 命名空间下（三语同键）。 */
const tr = (key: string, values?: Record<string, string | number>): string =>
  t(`remote.toolCall.ops.${key}`, values);

/** 动态词条：命中返回译文，否则回退 fallback（操作名 / 状态名等原始值）。 */
const dyn = (key: string, fallback: string): string => {
  const value = tr(key);
  return value === `remote.toolCall.ops.${key}` ? fallback : value;
};

// ── 基础工具 ────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const asRecords = (value: unknown): Json[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

const asStrings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter(
        (item): item is string => typeof item === "string" && item !== "",
      )
    : [];

/** 单行化 + 截断（summary 标题用）。 */
const clip = (text: string, max = 64): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

/** 转义换行解码后的展示文本。 */
const readable = (text: string): string => decodeEscapedNewlines(text);

const iconSpan = (name: MobileIconName, className: string): HTMLSpanElement => {
  const span = document.createElement("span");
  span.className = className;
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = iconMarkup(name);
  return span;
};

const textSpan = (className: string, text: string): HTMLSpanElement => {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = text;
  return span;
};

const host = (className: string): HTMLDivElement => {
  const node = document.createElement("div");
  node.className = className;
  return node;
};

/** 提示 / 空结果 / 进度行：图标 + 文案。 */
const noteRow = (
  kind: "note" | "empty" | "progress" | "warn",
  icon: MobileIconName,
  text: string,
): HTMLDivElement => {
  const row = host(`tc-ops-${kind}`);
  row.append(iconSpan(icon, "tc-ops-ico"), textSpan("tc-ops-note-text", text));
  return row;
};

/** 状态 / 结论行（结论措辞 + 色调）。 */
const statusRow = (
  icon: MobileIconName,
  text: string,
  tone: "ok" | "warn" | "err" | "muted",
): HTMLDivElement => {
  const row = host(`tc-ops-status tc-ops-status-${tone}`);
  row.append(
    iconSpan(icon, "tc-ops-ico"),
    textSpan("tc-ops-status-text", text),
  );
  return row;
};

/** 参数区容器。 */
const paramsHost = (...children: Node[]): HTMLDivElement => {
  const node = host("tc-kv-grid");
  node.append(...children);
  return node;
};

/** 结果无法解析为 JSON 时的原文回退（转义换行解码）。 */
const rawFallback = (raw: string | null | undefined): HTMLElement | null => {
  const text = (raw ?? "").trim();
  if (!text) return null;
  return tcSection(tr("fallback"), tcPre(readable(text)));
};

/** 结果里的错误文案：优先 JSON error，其次失败状态下的原始结果文本。 */
const errorTextOf = (tool: SnowRemoteToolCall, record: Json | null): string => {
  const structured = record ? asString(record.error) : undefined;
  if (structured) return structured;
  return tool.status === "error" ? (tool.result ?? "").trim() : "";
};

/** 运行中 / 等待中的兜底提示（无结果时）。 */
const pendingRow = (tool: SnowRemoteToolCall): HTMLElement | null => {
  if (tool.result) return null;
  if (tool.status === "running")
    return noteRow("progress", "loader-circle", tr("running"));
  if (tool.status === "pending") return noteRow("note", "clock", tr("waiting"));
  return null;
};

/**
 * 参数与结果都无法解析（半截 JSON / 空结果）、也没有提问快照时返回 true：
 * 此时交给 generic 兜底卡（参数原文 + 流式输出），比空壳的模块卡更有信息量。
 */
const isOpaqueTool = (
  tool: SnowRemoteToolCall,
  args: Json | null,
  result: Json | null,
): boolean =>
  !tool.userQuestion &&
  args === null &&
  result === null &&
  (tool.result ?? "").trim() === "";

// ── 通用文本小工具 ──────────────────────────────────────────────────────

/** 内容参数：字符串或字符串数组（字符串数组按行拼接）。 */
const joinedText = (value: unknown): string => {
  const single = asString(value);
  if (single) return single;
  return asStrings(value).join("\n");
};

// ── 配置（config-*） ────────────────────────────────────────────────────

const CONFIG_ACTIONS = ["list", "get", "set", "delete", "logs"] as const;
type ConfigAction = (typeof CONFIG_ACTIONS)[number];

const configActionOf = (name: string, argsAction?: string): ConfigAction => {
  const candidate =
    argsAction ??
    (name.startsWith("config-") ? name.slice("config-".length) : name);
  return (CONFIG_ACTIONS as readonly string[]).includes(candidate)
    ? (candidate as ConfigAction)
    : "get";
};

/** 值展示：短单行用内联等宽，长文本 / 对象 / 数组走 tcPre。 */
const configValueNode = (value: unknown): Node => {
  if (typeof value === "string") {
    const text = readable(value);
    return text.length <= 120 && !text.includes("\n")
      ? textSpan("tc-ops-value-inline", text)
      : tcPre(text);
  }
  if (typeof value === "number" || typeof value === "boolean")
    return textSpan("tc-ops-value-inline", String(value));
  if (value === null || value === undefined)
    return textSpan("tc-ops-value-inline", "null");
  return tcPre(JSON.stringify(value, null, 2) ?? "");
};

/** 单行值摘要（header 的 key/value 摘要用）；长文本与结构值返回 undefined。 */
const configValueSummary = (value: unknown): string | undefined => {
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (typeof value === "string") {
    const text = readable(value).replace(/\s+/g, " ").trim();
    return text !== "" && text.length <= 48 ? text : undefined;
  }
  return undefined;
};

/** 结果里的值字段（与桌面 extractConfigValue 一致：value 优先，其次 content）。 */
const configResultValue = (
  record: Json | null,
): { present: boolean; value: unknown } => {
  if (!record) return { present: false, value: undefined };
  if (Object.prototype.hasOwnProperty.call(record, "value"))
    return { present: true, value: record.value };
  if (Object.prototype.hasOwnProperty.call(record, "content"))
    return { present: true, value: record.content };
  return { present: false, value: undefined };
};

/**
 * 配置项列表：条目可能是字符串，或 { key, scope } / { agentId } / { hookType }
 * 等结构（list 用于 mcpServers / skills / hooks 等不同作用域）。
 */
const configEntryText = (entry: unknown): string | undefined => {
  const direct = asString(entry);
  if (direct) return direct;
  if (!isRecord(entry)) return undefined;
  const key =
    asString(entry.key) ??
    asString(entry.name) ??
    asString(entry.agentId) ??
    asString(entry.skillId) ??
    asString(entry.hookType) ??
    asString(entry.fileName) ??
    asString(entry.scope);
  if (!key) return undefined;
  const scope = asString(entry.scope);
  return scope && scope !== key ? `${scope}/${key}` : key;
};

const renderConfigTool = (tool: SnowRemoteToolCall): HTMLElement | null => {
  const args = parseJsonRecord(tool.arguments);
  const result = parseJsonRecord(tool.result);
  if (isOpaqueTool(tool, args, result)) return null;
  const action = configActionOf(
    tool.name,
    args ? asString(args.action) : undefined,
  );

  const scope =
    (args ? asString(args.scope) : undefined) ??
    (args ? asString(args.logScope) : undefined);
  const key = args ? asString(args.key) : undefined;
  const projectId = args ? asString(args.projectId) : undefined;
  const operation = args ? asString(args.operation) : undefined;
  const limit = args ? asNumber(args.limit) : undefined;
  const confirmed = args?.confirmed === true;
  const argValue = args
    ? configResultValue(args)
    : { present: false, value: undefined };

  const deleted = result?.deleted === true;
  const entries = result
    ? [
        ...asStrings(result.keys),
        ...asStrings(result.entries),
        ...asStrings(result.scopes),
      ]
    : [];
  const structuredEntries = result ? asRecords(result.items) : [];
  const entryTexts = [
    ...entries,
    ...structuredEntries.map((entry) => configEntryText(entry) ?? ""),
  ].filter((text) => text !== "");
  const resultValue = configResultValue(result);
  /** 展示值：参数里的写入值优先（set 时先看写了什么），其次结果回读值。 */
  const shownValue = argValue.present ? argValue : resultValue;
  /** 未配置判定：显式 exists / deleted = false，或 get 结果无可读值。 */
  const missing = result
    ? result.deleted === false ||
      result.exists === false ||
      (action === "get" && (!resultValue.present || resultValue.value === null))
    : false;

  const actionLabel = dyn(`config.action.${action}`, action);
  const path = [scope, key]
    .filter((part): part is string => Boolean(part))
    .join("/");
  /* header 的 key/value 摘要（list 且无 key 时显示作用域 / 全部作用域）。 */
  const keyText = path || (action === "list" ? tr("config.allScopes") : "");
  const valueSummary = shownValue.present
    ? configValueSummary(shownValue.value)
    : undefined;
  const target =
    keyText && valueSummary ? `${keyText} = ${valueSummary}` : keyText;
  const display = target ? `${actionLabel} · ${target}` : actionLabel;

  const body = document.createDocumentFragment();
  if (path) {
    const row = host("tc-ops-path");
    row.append(textSpan("tc-ops-path-label", tr("config.path")));
    row.append(textSpan("tc-ops-path-value", path));
    body.append(row);
  }
  if (shownValue.present) {
    body.append(
      tcSection(tr("config.value"), configValueNode(shownValue.value)),
    );
  }
  if (entryTexts.length) {
    const list = host("tc-ops-chips");
    for (const text of entryTexts.slice(0, 40))
      list.append(textSpan("tc-ops-chip", text));
    body.append(tcSection(tr("config.fields"), list));
  }
  if (
    typeof shownValue.value === "string" &&
    shownValue.value.includes("[REDACTED]")
  ) {
    body.append(noteRow("warn", "shield-check", tr("config.redacted")));
  }

  /* 影响范围：写 / 删只作用于 scope 指向的配置层（global / project）。 */
  if (scope && (action === "set" || action === "delete")) {
    body.append(
      noteRow(
        "note",
        "target",
        tr("config.affectedScope", {
          scope: dyn(`config.scopeValue.${scope}`, scope),
        }),
      ),
    );
  }

  if (action === "set" && result && !result.error) {
    body.append(statusRow("circle-check", tr("config.saved"), "ok"));
  } else if (action === "delete" && result) {
    body.append(
      deleted
        ? statusRow("circle-check", tr("config.deleted"), "ok")
        : statusRow("shield-alert", tr("config.notFound"), "warn"),
    );
  } else if (action === "get" && missing) {
    body.append(statusRow("shield-alert", tr("config.notConfigured"), "warn"));
  }

  if (args) {
    const rows: Node[] = [];
    if (projectId) rows.push(tcKv(tr("config.projectId"), projectId));
    if (operation) rows.push(tcKv(tr("config.operation"), operation));
    if (limit !== undefined) rows.push(tcKv(tr("config.limit"), String(limit)));
    if (confirmed) rows.push(tcKv(tr("config.confirmed"), tr("yes")));
    if (rows.length) body.append(paramsHost(...rows));
  }

  const error = errorTextOf(tool, result);
  if (error) body.append(tcErrorRow(readable(error)));
  if (!result) {
    const pending = pendingRow(tool);
    if (pending) body.append(pending);
    const fallback = rawFallback(tool.result);
    if (fallback) body.append(fallback);
  }

  const meta: HTMLElement[] = [];
  if (entryTexts.length)
    meta.push(
      tcBadge(tr("config.entryCount", { count: entryTexts.length }), "ok"),
    );
  if (action === "set" && result && !result.error)
    meta.push(tcBadge(tr("config.saved"), "ok"));
  if (action === "delete" && result)
    meta.push(
      deleted
        ? tcBadge(tr("config.deleted"), "ok")
        : tcBadge(tr("config.notFound"), "warn"),
    );
  if (action === "get" && missing)
    meta.push(tcBadge(tr("config.notConfigured"), "warn"));
  if (
    action === "get" &&
    result &&
    !result.error &&
    !missing &&
    resultValue.present
  ) {
    meta.push(tcBadge(typeof resultValue.value, "muted"));
  }

  return createToolNode({
    tool,
    status: resolveStatus(tool),
    badge: tr("config.name"),
    display,
    meta,
    className: "tc-ops-config",
    bodyClass: "tc-ops",
    body,
  });
};

// ── 应用控制（app-control-*） ───────────────────────────────────────────

const appOperationOf = (name: string): string =>
  name.startsWith("app-control-") ? name.slice("app-control-".length) : name;

/** 拦截规则条数：兼容 { count } 与 { patterns: [] } 两种返回。 */
const blockedPatternCount = (result: Json | null): number | undefined => {
  if (!result) return undefined;
  const count = asNumber(result.count);
  if (count !== undefined) return count;
  return Array.isArray(result.patterns) ? result.patterns.length : undefined;
};

/** 备忘条数：兼容 { total } 与 { memos: [] } 两种返回。 */
const memoCount = (result: Json | null): number | undefined => {
  if (!result) return undefined;
  const total = asNumber(result.total);
  if (total !== undefined) return total;
  return Array.isArray(result.memos) ? result.memos.length : undefined;
};

/** 间隔毫秒 → 紧凑文案（与桌面 AppControlToolCall.formatInterval 一致）。 */
const formatInterval = (intervalMs: number): string => {
  if (intervalMs >= 60 * 60 * 1000) return `${intervalMs / (60 * 60 * 1000)}h`;
  if (intervalMs >= 60 * 1000)
    return `${Math.round(intervalMs / (60 * 1000))}min`;
  return `${intervalMs}ms`;
};

/** 定时任务 schedule → 单行摘要（once / daily / interval，与桌面同语义）。 */
const scheduleText = (schedule: Json | null): string | undefined => {
  if (!schedule) return undefined;
  const type = asString(schedule.type) ?? "once";
  if (type === "once") {
    const executeAt = asString(schedule.executeAt);
    return executeAt ? tr("app.scheduleOnce", { time: executeAt }) : type;
  }
  const mode = asString(schedule.mode) ?? "interval";
  if (mode === "daily") {
    const hour = asNumber(schedule.hour) ?? 0;
    const minute = asNumber(schedule.minute) ?? 0;
    return tr("app.scheduleDaily", {
      hour: String(hour).padStart(2, "0"),
      minute: String(minute).padStart(2, "0"),
    });
  }
  const intervalMs = asNumber(schedule.intervalMs) ?? 0;
  return tr("app.scheduleInterval", { interval: formatInterval(intervalMs) });
};

/** 应用控制动作摘要（参数优先，结果兜底）。 */
const appDisplayOf = (
  operation: string,
  args: Json | null,
  result: Json | null,
): string => {
  const mode =
    (args ? asString(args.mode) : undefined) ??
    (result ? asString(result.mode) : undefined);
  const enabled =
    result && typeof result.enabled === "boolean"
      ? result.enabled
      : args?.enabled === true;
  switch (operation) {
    case "setMode":
      if (!mode) return dyn(`app.op.${operation}`, operation);
      return enabled
        ? tr("app.modeEnabled", { mode })
        : tr("app.modeDisabled", { mode });
    case "createMemo": {
      const content = args ? joinedText(args.content) : "";
      return content
        ? `${dyn("app.op.createMemo", operation)} · ${clip(content)}`
        : dyn("app.op.createMemo", operation);
    }
    case "createProject": {
      const name = args ? asString(args.name) : undefined;
      return name
        ? `${dyn("app.op.createProject", operation)} · ${clip(name)}`
        : dyn("app.op.createProject", operation);
    }
    case "createScheduledTask": {
      const name = args ? asString(args.name) : undefined;
      return name
        ? `${dyn("app.op.createScheduledTask", operation)} · ${clip(name)}`
        : dyn("app.op.createScheduledTask", operation);
    }
    case "openSettings": {
      const page = args ? asString(args.page) : undefined;
      return page
        ? `${dyn("app.op.openSettings", operation)} · ${page}`
        : dyn("app.op.openSettings", operation);
    }
    case "conversation": {
      const base = dyn("app.op.conversation", operation);
      const action = args ? asString(args.action) : undefined;
      const subject = args
        ? (asString(args.title) ??
          asString(args.text) ??
          asString(args.conversationId))
        : undefined;
      const head = action ? `${base} · ${action}` : base;
      return subject ? `${head} · ${clip(subject)}` : head;
    }
    case "listMemos": {
      const total = memoCount(result);
      if (total !== undefined) return tr("app.memoListed", { count: total });
      const status = args ? asString(args.status) : undefined;
      return status
        ? `${dyn("app.op.listMemos", operation)} · ${status}`
        : dyn("app.op.listMemos", operation);
    }
    case "getBlockedPatterns": {
      const count = blockedPatternCount(result);
      return count !== undefined
        ? tr("app.blockedPatternsCount", { count })
        : dyn("app.op.getBlockedPatterns", operation);
    }
    case "getMemo":
    case "updateMemoStatus": {
      const memoId = args ? asString(args.memoId) : undefined;
      const base = dyn(`app.op.${operation}`, operation);
      return memoId ? `${base} · ${clip(memoId)}` : base;
    }
    case "updateBlockedPatterns": {
      const op = args ? asString(args.operation) : undefined;
      return op
        ? dyn(`app.blockedPatternsOperation.${op}`, operation)
        : dyn("app.op.updateBlockedPatterns", operation);
    }
    default:
      return dyn(`app.op.${operation}`, operation);
  }
};

const renderAppTool = (tool: SnowRemoteToolCall): HTMLElement | null => {
  const operation = appOperationOf(tool.name);
  const args = parseJsonRecord(tool.arguments);
  const result = parseJsonRecord(tool.result);
  if (isOpaqueTool(tool, args, result)) return null;
  const mode = result ? asString(result.mode) : undefined;

  const body = document.createDocumentFragment();
  if (args) {
    const rows: Node[] = [];
    const name = asString(args.name);
    const content = joinedText(args.content);
    const memoId = asString(args.memoId);
    const status = asString(args.status);
    const page = asString(args.page);
    const schedule = isRecord(args.schedule)
      ? JSON.stringify(args.schedule, null, 2)
      : undefined;
    const preScript = asString(args.preScript);
    const parentPath = asString(args.parentPath);
    const patterns = asStrings(args.patterns);
    const projectId = asString(args.projectId);
    const planSummary = asString(args.planSummary);
    const operation2 = asString(args.operation);

    if (name) rows.push(tcKv(tr("app.field.name"), name));
    if (mode) rows.push(tcKv(tr("app.field.mode"), mode));
    if (typeof args.enabled === "boolean")
      rows.push(
        tcKv(tr("app.field.enabled"), args.enabled ? tr("yes") : tr("no")),
      );
    if (operation2)
      rows.push(
        tcKv(
          tr("app.field.operation"),
          dyn(`app.blockedPatternsOperation.${operation2}`, operation2),
        ),
      );
    if (patterns.length)
      rows.push(tcKv(tr("app.field.patterns"), patterns.join("、")));
    if (memoId) rows.push(tcKv(tr("app.field.memoId"), memoId));
    if (status) rows.push(tcKv(tr("app.field.status"), status));
    if (page) rows.push(tcKv(tr("app.field.page"), page));
    if (projectId) rows.push(tcKv(tr("app.field.projectId"), projectId));
    if (parentPath) rows.push(tcKv(tr("app.field.parentPath"), parentPath));
    if (rows.length) body.append(paramsHost(...rows));
    if (content)
      body.append(tcSection(tr("app.field.content"), tcPre(readable(content))));
    if (schedule)
      body.append(tcSection(tr("app.field.schedule"), tcPre(schedule)));
    if (preScript)
      body.append(
        tcSection(tr("app.field.preScript"), tcPre(readable(preScript))),
      );
    if (planSummary)
      body.append(
        tcSection(tr("app.field.planSummary"), tcPre(readable(planSummary))),
      );
  }

  /* 拦截规则清单：结果回读的 patterns 以标签列出，不再重复进 JSON。 */
  const resultPatterns = result ? asStrings(result.patterns) : [];
  if (resultPatterns.length) {
    const list = host("tc-ops-chips");
    for (const text of resultPatterns.slice(0, 40))
      list.append(textSpan("tc-ops-chip", text));
    body.append(tcSection(tr("app.field.patterns"), list));
  }

  if (result) {
    const payload: Json = {};
    for (const [field, value] of Object.entries(result)) {
      if (field === "error" || (field === "patterns" && resultPatterns.length))
        continue;
      payload[field] = value;
    }
    if (Object.keys(payload).length) {
      body.append(
        tcSection(tr("result"), tcPre(JSON.stringify(payload, null, 2))),
      );
    }
  }

  const error = errorTextOf(tool, result);
  if (error) body.append(tcErrorRow(readable(error)));
  if (!result) {
    const pending = pendingRow(tool);
    if (pending) body.append(pending);
    const fallback = rawFallback(tool.result);
    if (fallback) body.append(fallback);
  }
  const meta: HTMLElement[] = [];
  if (result && !result.error) {
    if (operation === "setMode") meta.push(tcBadge(tr("app.applied"), "ok"));
    else if (operation.startsWith("create"))
      meta.push(tcBadge(tr("app.created"), "ok"));
    else if (operation === "openSettings")
      meta.push(tcBadge(tr("app.opened"), "ok"));
    else if (
      operation === "updateMemoStatus" ||
      operation === "updateBlockedPatterns"
    )
      meta.push(tcBadge(tr("app.updated"), "ok"));
    else if (operation === "getMemo" || operation === "getBlockedPatterns")
      meta.push(tcBadge(tr("app.read"), "muted"));
  }
  const patternTotal =
    operation === "getBlockedPatterns" || operation === "updateBlockedPatterns"
      ? blockedPatternCount(result)
      : undefined;
  if (patternTotal !== undefined)
    meta.push(
      tcBadge(tr("app.blockedPatternsCount", { count: patternTotal }), "ok"),
    );
  const memoTotal = operation === "listMemos" ? memoCount(result) : undefined;
  if (memoTotal !== undefined)
    meta.push(tcBadge(tr("app.memoListed", { count: memoTotal }), "ok"));
  if (operation === "createScheduledTask") {
    const label = args
      ? scheduleText(isRecord(args.schedule) ? args.schedule : null)
      : undefined;
    if (label) meta.push(tcBadge(label, "muted"));
  }

  return createToolNode({
    tool,
    status: resolveStatus(tool),
    badge: tr("app.name"),
    display: appDisplayOf(operation, args, result),
    meta,
    className: "tc-ops-app",
    bodyClass: "tc-ops",
    body,
  });
};

// ── 用户提问（user-interaction-askUserQuestion） ────────────────────────

/** 提问终态（与桌面 shared/userQuestionView 的枚举一致）。 */
type AskStatus = "waiting" | "answered" | "cancelled" | "interrupted" | "error";

type AskView = {
  questionId?: string;
  question: string;
  options: string[];
  selected: string[];
  custom: string[];
  status: AskStatus;
  /** userQuestion 快照是否已下发（区分「准备中」与「等待作答」）。 */
  hasSnapshot: boolean;
  error: string;
};

/** 提问展示态解析：卡片与 Tab 组共用一份判定，避免两处状态漂移。 */
const resolveAskView = (tool: SnowRemoteToolCall): AskView => {
  const args = parseJsonRecord(tool.arguments);
  const result = parseJsonRecord(tool.result);
  const snapshot = tool.userQuestion;

  const question =
    (snapshot?.question?.trim() ? snapshot.question : undefined) ??
    (args ? asString(args.question) : undefined) ??
    "";
  const options = snapshot?.options?.length
    ? snapshot.options
    : asStrings(args?.options);
  const selected = snapshot?.selectedOptions?.length
    ? snapshot.selectedOptions
    : asStrings(result?.selectedOptions);
  const custom = snapshot?.customAnswers?.length
    ? snapshot.customAnswers
    : asStrings(result?.customAnswers);
  const cancelled =
    snapshot?.status === "cancelled" || result?.cancelled === true;
  const answered =
    !cancelled &&
    (snapshot?.status === "answered" ||
      result?.answered === true ||
      (result !== null &&
        result.cancelled !== true &&
        result.error === undefined));
  // 工具已结束但没走 answered/cancelled 协议结算（用户未作答即被中断）：按
  // 「已中断」收口，避免卡片停在「等待作答」却无处可答（提问卡片泄漏）。
  const interrupted =
    !cancelled &&
    !answered &&
    (snapshot?.interrupted === true || tool.status === "completed");
  const error = errorTextOf(tool, result);
  const status: AskStatus = interrupted
    ? "interrupted"
    : cancelled
      ? "cancelled"
      : answered
        ? "answered"
        : error
          ? "error"
          : "waiting";

  return {
    questionId: snapshot?.questionId,
    question,
    options,
    selected,
    custom,
    status,
    hasSnapshot: Boolean(snapshot),
    error,
  };
};

/** 提问状态文案（Tab 提示与卡片结论共用）。 */
const askStatusText = (status: AskStatus): string =>
  status === "answered"
    ? tr("ask.answered")
    : status === "cancelled"
      ? tr("ask.cancelled")
      : status === "interrupted"
        ? tr("ask.interrupted")
        : status === "error"
          ? tr("ask.failed")
          : tr("ask.waiting");

/** Tab 状态标记：等待回答用脉冲点（无图标），其余终态用 lucide 图标。 */
const askStatusIcon = (status: AskStatus): MobileIconName | null =>
  status === "answered"
    ? "circle-check"
    : status === "cancelled"
      ? "x"
      : status === "interrupted"
        ? "circle-alert"
        : status === "error"
          ? "circle-x"
          : null;

const renderAskTool = (tool: SnowRemoteToolCall): HTMLElement | null => {
  const args = parseJsonRecord(tool.arguments);
  const result = parseJsonRecord(tool.result);
  if (isOpaqueTool(tool, args, result)) return null;
  const view = resolveAskView(tool);
  const selectedSet = new Set(view.selected);

  const body = document.createDocumentFragment();
  if (view.question)
    body.append(tcSection(tr("ask.question"), tcPre(readable(view.question))));

  if (view.options.length) {
    const list = host("tc-ops-options");
    for (const option of view.options) {
      const isSelected = selectedSet.has(option);
      const row = host(
        isSelected ? "tc-ops-option tc-ops-option-selected" : "tc-ops-option",
      );
      row.title = option;
      row.append(
        iconSpan(isSelected ? "check" : "square", "tc-ops-option-mark"),
      );
      row.append(textSpan("tc-ops-option-text", option));
      list.append(row);
    }
    body.append(tcSection(tr("ask.options"), list));
  } else if (!view.custom.length) {
    body.append(noteRow("empty", "list-checks", tr("ask.noOptions")));
  }

  if (view.custom.length) {
    const list = host("tc-ops-chips");
    for (const answer of view.custom)
      list.append(textSpan("tc-ops-chip", answer));
    body.append(tcSection(tr("ask.custom"), list));
  }

  if (view.status === "cancelled") {
    body.append(statusRow("x", tr("ask.cancelled"), "muted"));
  } else if (view.status === "answered") {
    body.append(statusRow("circle-check", tr("ask.answered"), "ok"));
  } else if (view.status === "interrupted") {
    body.append(statusRow("circle-alert", tr("ask.interrupted"), "warn"));
  } else if (view.status === "error") {
    body.append(statusRow("circle-x", tr("ask.failed"), "err"));
  } else {
    /* 有快照 → 手机端交互区可作答；只有运行中的工具调用 → 题目尚未下发。 */
    body.append(statusRow("clock", tr("ask.waiting"), "muted"));
    body.append(
      noteRow(
        "note",
        "message-square-plus",
        view.hasSnapshot ? tr("ask.waitingHint") : tr("ask.preparing"),
      ),
    );
  }

  if (view.error) body.append(tcErrorRow(readable(view.error)));
  if (!result && !view.error) {
    const fallback = rawFallback(tool.result);
    if (fallback) body.append(fallback);
  }

  const meta: HTMLElement[] = [];
  if (view.status === "cancelled")
    meta.push(tcBadge(tr("ask.cancelled"), "muted"));
  else if (view.status === "answered")
    meta.push(tcBadge(tr("ask.answered"), "ok"));
  else if (view.status === "interrupted")
    meta.push(tcBadge(tr("ask.interrupted"), "warn"));
  else if (view.status === "error") meta.push(tcBadge(tr("ask.failed"), "err"));
  else meta.push(tcBadge(tr("ask.waiting"), "muted"));

  return createToolNode({
    tool,
    status: resolveStatus(tool),
    badge: tr("ask.name"),
    display: view.question ? clip(view.question) : argsSummary(tool.arguments),
    meta,
    className: "tc-ops-ask",
    bodyClass: "tc-ops",
    body,
  });
};

/** 提问 Tab 组实例序号（生成 role=tab / tabpanel 的关联 id）。 */
let askGroupSeq = 0;

/**
 * 同一轮内相邻的多个提问合并为一个 Tab 容器：一次只显示一个问题卡片。
 *
 * activeKey 为重建前停留的问题键（timeline 工具级 diff 传入），用于避免
 * 流式更新把阅读位置弹回：停留的问题仍未作答（或已无未作答的问题）时保留
 * 其位置，否则回到第一个未回答的问题（等同「作答后自动切到下一题」）。
 */
export const createAskGroupEl = (
  tools: SnowRemoteToolCall[],
  activeKey?: string,
): HTMLElement => {
  const entries = tools.map((tool) => ({ tool, view: resolveAskView(tool) }));
  const keys = entries.map(
    (entry) => entry.view.questionId ?? entry.tool.interactionId,
  );
  const firstWaiting = entries.findIndex((e) => e.view.status === "waiting");
  const inherited = activeKey ? keys.indexOf(activeKey) : -1;
  let activeIndex =
    inherited >= 0 &&
    (entries[inherited].view.status === "waiting" || firstWaiting < 0)
      ? inherited
      : Math.max(0, firstWaiting);

  const groupId = `ask-group-${(askGroupSeq += 1)}`;
  const root = host("tc-ops-ask-group");
  const tabs = host("tc-ops-ask-tabs");
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", tr("ask.tabsLabel"));
  const panels = host("tc-ops-ask-panels");
  panels.setAttribute("role", "tabpanel");

  const renderPanel = (): void => {
    root.dataset.activeTab = keys[activeIndex] ?? "";
    panels.setAttribute("aria-labelledby", `${groupId}-tab-${activeIndex}`);
    const entry = entries[activeIndex];
    if (!entry) {
      panels.replaceChildren();
      return;
    }
    const card = renderAskTool(entry.tool) ?? renderGenericTool(entry.tool);
    panels.replaceChildren(card);
  };

  entries.forEach((entry, index) => {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.id = `${groupId}-tab-${index}`;
    tab.className = "tc-ops-ask-tab";
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", "tc-ops-ask-panels");
    const label =
      entry.view.question || tr("ask.questionFallback", { index: index + 1 });
    const statusText = askStatusText(entry.view.status);
    tab.title = `${label} — ${statusText}`;
    tab.setAttribute("aria-label", `${label} — ${statusText}`);
    tab.append(
      textSpan(
        "tc-ops-ask-tab-index",
        tr("ask.tabIndex", { index: index + 1 }),
      ),
      textSpan("tc-ops-ask-tab-label", label),
    );
    const status = host(
      `tc-ops-ask-tab-status tc-ops-ask-tab-status-${entry.view.status}`,
    );
    status.title = statusText;
    const icon = askStatusIcon(entry.view.status);
    status.append(icon ? iconSpan(icon, "icn") : host("tc-ops-ask-tab-dot"));
    tab.append(status);

    tab.addEventListener("click", () => {
      activeIndex = index;
      for (const [i, node] of Array.from(tabs.children).entries()) {
        node.classList.toggle("is-active", i === index);
        node.setAttribute("aria-selected", i === index ? "true" : "false");
      }
      renderPanel();
    });

    tabs.append(tab);
  });

  const activeTab = tabs.children[activeIndex];
  activeTab?.classList.add("is-active");
  activeTab?.setAttribute("aria-selected", "true");
  renderPanel();

  root.append(tabs, panels);
  return root;
};

// ── 数据库（dbx-* / dbx_*） ─────────────────────────────────────────────

/** 结果表渲染行数上限（超出部分渲染为省略提示，不铺满整张卡）。 */
const TABLE_ROWS = 50;

type QueryTable = { columns: string[]; rows: unknown[][] };

/**
 * 归一化 DBX 操作名，与桌面 DbxToolCall 一致：外部 MCP 工具名可能是连字符
 * （dbx-execute-query）、下划线（dbx_execute_query），也可能是 DBX MCP 自带
 * dbx_ 前缀的复合形态（dbx-dbx_execute_query）——先剥 server 前缀，再剥工具名
 * 自带前缀，统一把下划线归一为连字符；DBX 自身拼写缺失的 execute_redis_comman
 * 映射到标准名 execute-redis-command。
 */
const dbxOperationOf = (name: string): string => {
  let bare = name.replace(/^dbx[-_]/, "");
  if (bare.startsWith("dbx_")) bare = bare.slice("dbx_".length);
  return bare
    .replace(/_/g, "-")
    .replace(/^execute-redis-comman$/, "execute-redis-command");
};

const cellText = (value: unknown): string => {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "object") {
    try {
      return clip(JSON.stringify(value) ?? "", 40);
    } catch {
      return String(value);
    }
  }
  return clip(String(value), 60);
};

/** 结构化的 { rows, columns } 抽取（兼容 rows / result / values / queryResult / data.rows）。 */
const extractTable = (candidate: unknown): QueryTable | null => {
  if (!isRecord(candidate)) return null;
  const rows = Array.isArray(candidate.rows)
    ? candidate.rows
    : Array.isArray(candidate.values)
      ? candidate.values
      : Array.isArray(candidate.result)
        ? candidate.result
        : null;
  if (!rows) return null;
  const columns = asStrings(candidate.columns);
  if (!columns.length) {
    const first = rows.find(isRecord);
    if (first)
      return { columns: Object.keys(first), rows: rows as unknown[][] };
    return {
      columns: [],
      rows: rows.map((row) => (Array.isArray(row) ? row : [row])),
    };
  }
  return {
    columns,
    rows: rows.map((row) =>
      isRecord(row)
        ? columns.map((column) => row[column])
        : Array.isArray(row)
          ? row
          : [row],
    ),
  };
};

/** 结果对象 → 表格（含 data.rows / result.rows 容错）。 */
const structuredTable = (result: Json): QueryTable | null => {
  const direct =
    extractTable(result) ??
    extractTable(result.result) ??
    extractTable(result.data);
  if (!direct) return null;
  return { ...direct, columns: direct.columns };
};

/** Markdown 表格 → { columns, rows }（外部 MCP 常见返回形态）。 */
const markdownTable = (text: string): QueryTable | null => {
  const lines = decodeEscapedNewlines(text)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|"));
  const header = lines.find((line) => line.startsWith("|"));
  if (!header) return null;
  const splitRow = (line: string): string[] =>
    line
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((cell) => cell.trim());
  const headerCells = splitRow(header);
  if (headerCells.length < 2) return null;
  const dataLines = lines.filter((line) => !/^\|[\s:|-]+\|$/.test(line));
  const rows = dataLines.slice(1).map(splitRow);
  if (!rows.length) return null;
  return { columns: headerCells, rows };
};

/** MCP content 数组 → 文本（result.content[].text）。 */
const contentTextOf = (result: Json): string | undefined => {
  const content = Array.isArray(result.content) ? result.content : null;
  if (!content) return undefined;
  const parts = content
    .map((item) =>
      isRecord(item) && typeof item.text === "string" ? item.text : undefined,
    )
    .filter((text): text is string => Boolean(text));
  return parts.length ? parts.join("\n\n") : undefined;
};

const tableHost = (table: QueryTable): HTMLElement => {
  const wrap = host("tc-ops-table-wrap");
  const scroll = host("tc-ops-table-scroll");
  const node = document.createElement("table");
  node.className = "tc-ops-table";
  if (table.columns.length) {
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const column of table.columns) {
      const th = document.createElement("th");
      th.textContent = column;
      th.title = column;
      headRow.append(th);
    }
    thead.append(headRow);
    node.append(thead);
  }
  const tbody = document.createElement("tbody");
  for (const row of table.rows.slice(0, TABLE_ROWS)) {
    const tr = document.createElement("tr");
    for (const cell of row) {
      const td = document.createElement("td");
      const text = cellText(cell);
      td.textContent = text;
      td.title = text;
      if (cell === null || cell === undefined) td.classList.add("tc-ops-null");
      tr.append(td);
    }
    tbody.append(tr);
  }
  node.append(tbody);
  scroll.append(node);
  wrap.append(scroll);
  if (table.rows.length > TABLE_ROWS) {
    wrap.append(
      noteRow(
        "note",
        "list-checks",
        tr("dbx.moreRows", { shown: TABLE_ROWS, total: table.rows.length }),
      ),
    );
  }
  return wrap;
};

/** 结果文本按行计数（list-tables / schema 上下文的条目数）。 */
const countLines = (text: string | undefined, prefix: string): number =>
  text
    ? decodeEscapedNewlines(text)
        .split("\n")
        .filter((line) => line.startsWith(prefix)).length
    : 0;

const renderDbxTool = (tool: SnowRemoteToolCall): HTMLElement | null => {
  const operation = dbxOperationOf(tool.name);
  const args = parseJsonRecord(tool.arguments);
  const result = parseJsonRecord(tool.result);
  if (isOpaqueTool(tool, args, result)) return null;
  const contentText = result ? contentTextOf(result) : undefined;
  const table =
    (result ? structuredTable(result) : null) ??
    markdownTable(contentText ?? "") ??
    markdownTable(tool.result ?? "");

  const database = args ? asString(args.database) : undefined;
  const sql = args ? asString(args.sql) : undefined;
  const command = args ? asString(args.command) : undefined;
  const tableName =
    (args ? asString(args.table) : undefined) ??
    (args ? asString(args.table_name) : undefined);
  const connectionName = args
    ? (asString(args.connection_name) ?? asString(args.name))
    : undefined;
  const sessionId = args ? asString(args.session_id) : undefined;

  const rowCount =
    (result ? asNumber(result.rowCount) : undefined) ??
    (result && Array.isArray(result.rows) ? result.rows.length : undefined) ??
    (table ? table.rows.length : undefined);
  /** 写语句的影响行数（不同 DBX 版本字段名不一）。 */
  const affectedRows =
    (result ? asNumber(result.affectedRows) : undefined) ??
    (result ? asNumber(result.rowsAffected) : undefined);

  let display: string;
  const meta: HTMLElement[] = [];
  switch (operation) {
    case "execute-query":
    case "execute-and-show": {
      display = sql ? clip(sql) : dyn(`dbx.op.${operation}`, operation);
      if (rowCount !== undefined)
        meta.push(
          tcBadge(
            tr("dbx.rowCount", { count: rowCount }),
            rowCount > 0 ? "ok" : "muted",
          ),
        );
      break;
    }
    case "execute-redis-command": {
      display = command
        ? clip(command)
        : dyn("dbx.op.execute-redis-command", operation);
      if (result && !result.error) meta.push(tcBadge(tr("dbx.done"), "ok"));
      break;
    }
    case "describe-table": {
      display = tableName
        ? clip(tableName)
        : dyn("dbx.op.describe-table", operation);
      const columns =
        countLines(contentText, "- ") || (table ? table.rows.length : 0);
      if (columns)
        meta.push(tcBadge(tr("dbx.columnCount", { count: columns }), "ok"));
      break;
    }
    case "list-tables": {
      display = database ?? dyn("dbx.allTables", "all");
      const count = countLines(contentText, "- ");
      if (count) meta.push(tcBadge(tr("dbx.tableCount", { count }), "ok"));
      break;
    }
    case "list-connections": {
      display = dyn("dbx.connections", operation);
      const count = table ? table.rows.length : countLines(contentText, "- ");
      if (count) meta.push(tcBadge(tr("dbx.connectionCount", { count }), "ok"));
      break;
    }
    case "get-schema-context": {
      const tables = countLines(contentText, "## ");
      display = tables
        ? tr("dbx.tableCount", { count: tables })
        : dyn("dbx.op.get-schema-context", operation);
      if (tables)
        meta.push(tcBadge(tr("dbx.tableCount", { count: tables }), "ok"));
      break;
    }
    case "open-session": {
      display = database
        ? clip(database)
        : dyn("dbx.op.open-session", operation);
      const opened = contentText
        ? /session[_-]?id["'\s:]*([\w-]+)/i.exec(contentText)?.[1]
        : undefined;
      if (opened) meta.push(tcBadge(opened, "muted"));
      break;
    }
    case "close-session": {
      display = sessionId
        ? clip(sessionId)
        : dyn("dbx.op.close-session", operation);
      if (result && !result.error) meta.push(tcBadge(tr("dbx.closed"), "ok"));
      break;
    }
    case "add-connection": {
      display = connectionName
        ? clip(connectionName)
        : dyn("dbx.op.add-connection", operation);
      if (result && !result.error) meta.push(tcBadge(tr("dbx.added"), "ok"));
      break;
    }
    case "remove-connection": {
      display = connectionName
        ? clip(connectionName)
        : dyn("dbx.op.remove-connection", operation);
      if (result && !result.error) meta.push(tcBadge(tr("dbx.removed"), "ok"));
      break;
    }
    case "open-table": {
      display = tableName
        ? clip(tableName)
        : dyn("dbx.op.open-table", operation);
      if (result && !result.error) meta.push(tcBadge(tr("dbx.opened"), "ok"));
      break;
    }
    default:
      display = dyn(`dbx.op.${operation}`, operation);
      break;
  }

  const body = document.createDocumentFragment();
  const commandText =
    operation === "execute-query" || operation === "execute-and-show"
      ? sql
      : operation === "execute-redis-command"
        ? command
        : undefined;
  if (commandText)
    body.append(tcSection(tr("dbx.command"), tcPre(readable(commandText))));

  if (table) {
    body.append(tcSection(tr("dbx.resultTable"), tableHost(table)));
  } else if (rowCount === 0) {
    body.append(noteRow("empty", "database", tr("dbx.emptyResult")));
  }
  if (affectedRows !== undefined) {
    body.append(
      statusRow(
        "circle-check",
        tr("dbx.affectedRows", { count: affectedRows }),
        "ok",
      ),
    );
  }

  if (args) {
    const rows: Node[] = [];
    if (database && operation !== "open-session")
      rows.push(tcKv(tr("dbx.database"), database));
    if (tableName) rows.push(tcKv(tr("dbx.table"), tableName));
    if (connectionName) rows.push(tcKv(tr("dbx.connection"), connectionName));
    if (sessionId) rows.push(tcKv(tr("dbx.sessionId"), sessionId));
    if (rows.length) body.append(paramsHost(...rows));
  }

  const error = errorTextOf(tool, result);
  if (error) body.append(tcErrorRow(readable(error)));
  const fallbackText =
    contentText ?? (result ? JSON.stringify(result, null, 2) : tool.result);
  if (!table && !error && fallbackText) {
    body.append(tcSection(tr("result"), tcPre(readable(fallbackText))));
  }
  if (!result && !tool.result) {
    const pending = pendingRow(tool);
    if (pending) body.append(pending);
  }

  return createToolNode({
    tool,
    status: resolveStatus(tool),
    badge: tr("dbx.name"),
    display,
    meta,
    className: "tc-ops-dbx",
    bodyClass: "tc-ops",
    body,
  });
};

// ── 模块装配 ────────────────────────────────────────────────────────────

/**
 * ops 族注册：精确名（用户提问）+ 前缀（config / app-control / dbx）。
 * 精确名优先于前缀，由 tools/index.ts 派发时保证。
 * 待办与记忆族由 tools/agents.ts 承担（本模块不再注册，避免同名覆盖）。
 */
export const opsModule: ToolModule = {
  renderers: {
    "user-interaction-askUserQuestion": renderAskTool,
  },
  prefixes: [
    { prefix: "config-", render: renderConfigTool },
    { prefix: "app-control-", render: renderAppTool },
    { prefix: "dbx-", render: renderDbxTool },
    { prefix: "dbx_", render: renderDbxTool },
  ],
};
