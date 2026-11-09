/**
 * agents 工具族卡片：代理协作类工具的移动端只读复盘视图。
 *
 * 归口工具：
 * - 精确名 `sub-agents-activate` / `sub-agents-continue` → 子代理卡片（身份 + 任务
 *   + 运行态 + 结果 / 排队提示；与桌面 SubAgentToolCall 同源解析）；
 * - 精确名 `skills-skill-execute` → 技能卡片（技能名 + 位置 + 允许工具 + 技能内容）；
 * - 精确名 `todo-todo-manage` → 待办卡片（动作 + 受影响条目 + 列表与统计）；
 * - 前缀 `memory-` → 记忆卡片（检索命中 / 列表 / 保存更新删除结论）。
 *
 * 数据来源与容错（与 tools/ui.ts 的约定一致）：
 * - 快照的 arguments 与 result 由远控桥全量下发（不截断）；旧版快照可能是
 *   半截 JSON，解析全部走容错路径：解析失败 → 该行不渲染 + 原文回退；
 * - 桌面的 hookExecutions（HookExecutionUI）不在远控快照里
 *   （SnowRemoteToolCall 无该字段），本模块不实现 hook 步骤；
 * - 子代理会话 ID、待办会话 ID 只作为文本信息展示，移动端跳转由其它机制负责；
 * - 解析不出任何结构化内容（无参数、无结构化结果、无原文）时返回 null，交回框架
 *   的通用卡片（./generic.ts）；
 * - 所有数据一律 createElement + textContent，只有静态图标标记走 innerHTML。
 */
import type { SnowRemoteToolCall } from "../../renderer/types/remoteControl";
import { t } from "../i18n";
import { iconMarkup, type MobileIconName } from "../icons";
import type { ToolCallRenderer, ToolModule } from "./types";
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
  type JsonRecord,
} from "./ui";

/** 词条取用：本模块所有键都在 remote.toolCall.agents.* 命名空间下（三语同键）。 */
const tr = (key: string, values?: Record<string, string | number>): string =>
  t(`remote.toolCall.agents.${key}`, values);

/** 动态词条：命中返回译文，否则回退 fallback（动作名 / 状态名等原始值）。 */
const dyn = (key: string, fallback: string): string => {
  const value = tr(key);
  return value === `remote.toolCall.agents.${key}` ? fallback : value;
};

// ── 解析小工具（类型不符即视为缺失，保证半截 JSON 也能渲染） ──────────────

type Json = JsonRecord;

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const asStrings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter(
        (item): item is string => typeof item === "string" && item !== "",
      )
    : [];

const asRecords = (value: unknown): Json[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

/** 多写法字段读取：工具结果 JSON 用下划线，napi 导出用驼峰，两者都接受。 */
const pickString = (record: Json, ...keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = asString(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
};

const pickNumber = (record: Json, ...keys: string[]): number | undefined => {
  for (const key of keys) {
    const value = asNumber(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
};

/** 字符串或字符串数组 → 多行文本（待办 content / 记忆 content）。 */
const listText = (value: unknown): string => {
  const single = asString(value);
  if (single) return single;
  return asStrings(value).join("\n");
};

/** 字符串或字符串数组 → 逗号分隔的 ID 串（todoId 支持单个与批量）。 */
const idText = (value: unknown): string => {
  const single = asString(value);
  if (single) return single;
  return asStrings(value).join(", ");
};

/** 单行化 + 截断（头部摘要 / 受影响条目提示用）。 */
const clip = (text: string, max = 64): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

/** 多行文本 → 去空行的条目数组（新增待办的逐条内容）。 */
const contentLines = (text: string): string[] =>
  decodeEscapedNewlines(text)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

/** 逗号分隔的 ID 串 → ID 数组。 */
const idList = (text: string): string[] =>
  text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");

/** 展示文本：字面转义换行还原。 */
const readable = (text: string): string => decodeEscapedNewlines(text);

// ── DOM 小件 ────────────────────────────────────────────────────────────

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

const host = (className: string): HTMLDivElement => el("div", className);

const textSpan = (className: string, text: string): HTMLSpanElement =>
  el("span", className, text);

const iconSpan = (name: MobileIconName, className: string): HTMLSpanElement => {
  const span = el("span", className);
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = iconMarkup(name);
  return span;
};

/** 提示 / 空态 / 警告行：图标 + 文案。 */
const noteRow = (
  variant: "note" | "empty" | "warn",
  icon: MobileIconName,
  text: string,
): HTMLDivElement => {
  const row = host(`tc-ag-note tc-ag-note-${variant}`);
  row.append(iconSpan(icon, "tc-ag-ico"), textSpan("tc-ag-note-text", text));
  return row;
};

/** 结论行（已完成 / 警告 / 中性，色调区分）。 */
const statusRow = (
  icon: MobileIconName,
  text: string,
  tone: "ok" | "warn" | "muted",
): HTMLDivElement => {
  const row = host(`tc-ag-status tc-ag-status-${tone}`);
  row.append(iconSpan(icon, "tc-ag-ico"), textSpan("tc-ag-status-text", text));
  return row;
};

/** 动作行：动作图标 + 动作名。 */
const actionRow = (icon: MobileIconName, label: string): HTMLDivElement => {
  const row = host("tc-ag-action");
  row.append(
    iconSpan(icon, "tc-ag-ico"),
    textSpan("tc-ag-action-label", label),
  );
  return row;
};

/** 键值参数网格。 */
const kvGrid = (...children: Node[]): HTMLDivElement => {
  const node = host("tc-ag-kv");
  node.append(...children);
  return node;
};

/** 头部任务摘要 chip（单行省略，title 保留全文）。 */
const taskChip = (text: string): HTMLSpanElement => {
  const chip = textSpan("tc-ag-task", clip(text, 80));
  chip.title = text;
  return chip;
};

/** 结果原文（非结构化）：解码转义后按等宽文本展示。 */
const rawResultSection = (tool: SnowRemoteToolCall): HTMLElement | null => {
  const text = (tool.result ?? "").trim();
  if (!text) return null;
  return tcSection(tr("result"), tcPre(readable(text)));
};

/** 结果里的错误文案：JSON error 优先，其次失败状态下的原始结果文本。 */
const errorTextOf = (tool: SnowRemoteToolCall, record: Json | null): string => {
  const structured = record ? asString(record.error) : undefined;
  if (structured) return structured;
  return tool.status === "error" ? (tool.result ?? "").trim() : "";
};

/** 无结果时的运行态提示：running → 脉冲点 + 动作文案；pending → 等待。 */
const liveRow = (
  tool: SnowRemoteToolCall,
  runningText: string,
): HTMLElement | null => {
  if ((tool.result ?? "").trim() !== "") return null;
  if (tool.status === "running") {
    const row = host("tc-ag-wait");
    row.append(
      textSpan("tc-ag-wait-dot", ""),
      textSpan("tc-ag-wait-text", runningText),
    );
    return row;
  }
  if (tool.status === "pending") return noteRow("note", "clock", tr("waiting"));
  return null;
};

// ── 子代理（sub-agents-activate / sub-agents-continue） ────────────────

type SubAgentMode = "activate" | "continue";

type SubAgentResult =
  | {
      type: "success";
      conversationId: string;
      agentName: string;
      text: string;
    }
  | { type: "queued"; conversationId: string; agentName: string; note: string }
  | { type: "error"; message: string }
  | { type: "raw"; text: string }
  | { type: "empty" };

/**
 * 结果解析（与桌面 SubAgentToolCall.parseResult 同源）：
 * accepted/message_queued 回执与 result.run.outcome 是唯一结构化协议；
 * error → 失败；非 JSON 或未知结构 → 原文回退；无结果 → empty。
 */
const parseSubAgentResult = (raw?: string): SubAgentResult => {
  if (!raw) return { type: "empty" };
  const record = parseJsonRecord(raw);
  if (!record) return { type: "raw", text: raw };

  const error = asString(record.error);
  if (error) return { type: "error", message: error };

  if (
    record.success === true &&
    (record.kind === "accepted" || record.kind === "message_queued") &&
    asString(record.runId) &&
    asString(record.conversationId)
  ) {
    return {
      type: "queued",
      conversationId: asString(record.conversationId)!,
      agentName: "",
      note:
        record.kind === "message_queued"
          ? tr("subAgent.queued")
          : (asString(record.runStatus) ?? ""),
    };
  }
  if (
    record.success === true &&
    record.kind === "result" &&
    isRecord(record.run)
  ) {
    const run = record.run;
    if (
      asString(run.runId) &&
      asString(run.conversationId) &&
      isRecord(run.outcome) &&
      run.outcome.runId === run.runId
    ) {
      const outcome = run.outcome;
      if (isRecord(outcome.error) && asString(outcome.error.message))
        return { type: "error", message: asString(outcome.error.message)! };
      return {
        type: "success",
        conversationId: asString(run.conversationId)!,
        agentName: asString(run.agentName) ?? "",
        text: isRecord(record.summaryPage)
          ? (asString(record.summaryPage.text) ?? "")
          : (asString(outcome.summary) ?? ""),
      };
    }
  }

  return { type: "raw", text: raw };
};

type SubAgentArgs = {
  /** activate: agentId；continue: conversationId。 */
  target: string;
  /** activate: prompt；continue: message。 */
  task: string;
  /** 其余参数（模型 / 配置 / 工具集等），渲染为补充信息。 */
  extras: { label: string; value: string }[];
};

/** 参数值 → 单行文本（对象 / 数组走紧凑 JSON，避免撑爆卡片）。 */
const configValueText = (value: unknown): string => {
  const single = asString(value);
  if (single) return clip(single, 120);
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (Array.isArray(value)) {
    const items = asStrings(value);
    if (items.length) return clip(items.join(", "), 120);
  }
  if (isRecord(value)) return clip(JSON.stringify(value) ?? "", 120);
  return "";
};

const parseSubAgentArgs = (
  record: Json | null,
  mode: SubAgentMode,
): SubAgentArgs => {
  if (!record) return { target: "", task: "", extras: [] };
  const targetKey = mode === "continue" ? "conversationId" : "agentId";
  const taskKey = mode === "continue" ? "message" : "prompt";
  const extras: { label: string; value: string }[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (key === targetKey || key === taskKey) continue;
    const text = configValueText(value);
    if (text) extras.push({ label: key, value: text });
  }
  return {
    target: asString(record[targetKey]) ?? "",
    task: asString(record[taskKey]) ?? "",
    extras,
  };
};

const renderSubAgent = (
  tool: SnowRemoteToolCall,
  mode: SubAgentMode,
): HTMLElement | null => {
  const parsedArgs = parseSubAgentArgs(parseJsonRecord(tool.arguments), mode);
  const result = parseSubAgentResult(tool.result);
  const isContinue = mode === "continue";

  // 解析失败且没有任何结果原文 → 交回通用卡片。
  if (
    !parsedArgs.target &&
    !parsedArgs.task &&
    parsedArgs.extras.length === 0 &&
    result.type === "empty"
  ) {
    return null;
  }

  const resultName =
    result.type === "success" || result.type === "queued"
      ? result.agentName
      : "";
  const identity = resultName || parsedArgs.target;
  const status = resolveStatus(tool);
  const badge = isContinue ? tr("subAgent.continueName") : tr("subAgent.name");

  const body = document.createDocumentFragment();

  // 身份行：名称 / ID
  if (identity) {
    const head = host("tc-ag-head");
    head.append(
      iconSpan(isContinue ? "send" : "rocket", "tc-ag-ico"),
      textSpan("tc-ag-name", identity),
    );
    if (resultName && parsedArgs.target && resultName !== parsedArgs.target) {
      const id = textSpan("tc-ag-id", parsedArgs.target);
      id.title = parsedArgs.target;
      head.append(id);
    }
    body.append(head);
  }

  // 任务全文（activate: prompt / continue: message）
  if (parsedArgs.task) {
    body.append(
      tcSection(
        isContinue ? tr("subAgent.message") : tr("subAgent.task"),
        tcPre(readable(parsedArgs.task)),
      ),
    );
  }

  // 其它参数（模型 / 配置等，有则展示）
  if (parsedArgs.extras.length) {
    body.append(
      tcSection(
        tr("subAgent.config"),
        kvGrid(
          ...parsedArgs.extras.map((item) => tcKv(item.label, item.value)),
        ),
      ),
    );
  }

  switch (result.type) {
    case "success": {
      if (result.text)
        body.append(
          tcSection(tr("subAgent.summary"), tcPre(readable(result.text))),
        );
      if (result.conversationId)
        body.append(tcKv(tr("subAgent.conversationId"), result.conversationId));
      break;
    }
    case "queued":
      body.append(
        statusRow("clock", result.note || tr("subAgent.queued"), "muted"),
      );
      if (result.conversationId)
        body.append(tcKv(tr("subAgent.conversationId"), result.conversationId));
      break;
    case "error":
      body.append(
        tcErrorRow(readable(result.message || tr("subAgent.failed"))),
      );
      break;
    case "raw":
      body.append(tcSection(tr("result"), tcPre(readable(result.text))));
      break;
    default: {
      const live = liveRow(
        tool,
        isContinue ? tr("subAgent.resuming") : tr("subAgent.activating"),
      );
      if (live) body.append(live);
      else if (status === "error")
        body.append(tcErrorRow(tr("subAgent.failed")));
      break;
    }
  }

  const meta: Node[] = [];
  if (identity && parsedArgs.task) meta.push(taskChip(parsedArgs.task));

  return createToolNode({
    tool,
    status,
    badge,
    display: identity || (parsedArgs.task ? clip(parsedArgs.task) : undefined),
    displayTitle: identity || parsedArgs.task || undefined,
    meta,
    className: isContinue ? "tc-ag-continue" : "tc-ag-activate",
    bodyClass: "tc-ag",
    body,
  });
};

const renderSubAgentActivate: ToolCallRenderer = (tool) =>
  renderSubAgent(tool, "activate");

const renderSubAgentContinue: ToolCallRenderer = (tool) =>
  renderSubAgent(tool, "continue");

// ── 技能（skills-skill-execute） ───────────────────────────────────────

/** 技能根目录来源标记（与 Rust 侧 load_available_skills 的四个根目录对应）。 */
const SKILL_ROOTS = [".snow/skills", ".agents/skills"] as const;

type SkillInfo = {
  /** 结果里的 "Skill Name:"（缺省时用 <command-message> 里的名字）。 */
  name: string;
  /** 技能根目录来源：.snow/skills | .agents/skills（无法判定时为空）。 */
  root: string;
  /** 结果里的 "Absolute Path:"。 */
  path: string;
  /** <tool-restrictions> 里列出的允许工具。 */
  allowedTools: string[];
};

const SKILL_COMMAND_RE =
  /<command-message>The "(.+?)" skill is loading<\/command-message>/;
const SKILL_NAME_RE = /Skill Name:\s*(.+)/;
const SKILL_PATH_RE = /Absolute Path:\s*(.+)/;
const SKILL_RESTRICTIONS_RE =
  /<tool-restrictions>([\s\S]*?)<\/tool-restrictions>/;

/**
 * 技能执行结果是纯文本（Rust 侧 returns_plain_text，见 tools/call.rs）：
 *   <command-message>The "x" skill is loading</command-message>
 *   <技能正文><tool-restrictions>允许工具</tool-restrictions>
 *   <skill-info>Skill Name / Absolute Path / 目录结构</skill-info>
 * 描述（frontmatter description）不在结果里，因此不展示描述行。
 */
const parseSkillText = (raw: string): SkillInfo => {
  const text = readable(raw);
  const name =
    SKILL_NAME_RE.exec(text)?.[1]?.trim() ??
    SKILL_COMMAND_RE.exec(text)?.[1]?.trim() ??
    "";
  const path = SKILL_PATH_RE.exec(text)?.[1]?.trim() ?? "";
  // 分隔符归一后匹配技能根目录（Windows 反斜杠与 POSIX 斜杠同形）。
  const normalized = path.replace(/\\/g, "/");
  const root =
    SKILL_ROOTS.find(
      (candidate) =>
        normalized.includes(`/${candidate}/`) ||
        normalized.endsWith(`/${candidate}`),
    ) ?? "";
  const restrictions = SKILL_RESTRICTIONS_RE.exec(text)?.[1] ?? "";
  const allowedTools = restrictions
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter((line) => line !== "");
  return { name, root, path, allowedTools };
};

const renderSkill: ToolCallRenderer = (tool) => {
  const args = parseJsonRecord(tool.arguments);
  const record = parseJsonRecord(tool.result);
  const error = record ? asString(record.error) : undefined;
  const skillId = args
    ? (asString(args.skill) ?? asString(args.skillId) ?? "")
    : "";
  const rawText = (tool.result ?? "").trim();
  const info = rawText && !error && !record ? parseSkillText(rawText) : null;

  if (!args && !rawText) return null;

  const body = document.createDocumentFragment();
  const meta: Node[] = [];

  if (skillId) body.append(tcKv(tr("skill.skillId"), skillId));
  if (info?.name && info.name !== skillId)
    body.append(tcKv(tr("skill.skillName"), info.name));
  if (info?.root) {
    meta.push(tcBadge(info.root, "muted"));
    body.append(tcKv(tr("skill.location"), info.root));
  }
  if (info?.path) body.append(tcKv(tr("skill.path"), info.path));

  if (info?.allowedTools.length) {
    const chips = host("tc-ag-chips");
    for (const name of info.allowedTools.slice(0, 40))
      chips.append(textSpan("tc-ag-chip", name));
    body.append(tcSection(tr("skill.allowedTools"), chips));
  }

  if (error) {
    body.append(tcErrorRow(readable(error)));
  } else if (info) {
    // 技能内容 = 工具结果原文（<command-message> 提示 + 技能正文 + 目录结构）。
    body.append(tcSection(tr("skill.content"), tcPre(readable(rawText))));
  } else {
    const live = liveRow(tool, tr("skill.loading"));
    if (live) body.append(live);
    const raw = rawResultSection(tool);
    if (raw) body.append(raw);
  }

  return createToolNode({
    tool,
    status: resolveStatus(tool),
    badge: tr("skill.name"),
    display: skillId || argsSummary(tool.arguments),
    displayTitle: skillId || undefined,
    meta,
    className: "tc-ag-skill",
    bodyClass: "tc-ag",
    body,
  });
};

// ── 待办（todo-todo-manage） ───────────────────────────────────────────

const TODO_ACTIONS = ["get", "add", "update", "delete"] as const;
type TodoAction = (typeof TODO_ACTIONS)[number];

type TodoStatus = "pending" | "inProgress" | "completed";

type TodoEntry = {
  id: string;
  content: string;
  status: TodoStatus;
  parentId: string;
};

const TODO_ACTION_ICONS: Record<TodoAction, MobileIconName> = {
  get: "clipboard-list",
  add: "plus",
  update: "file-pen",
  delete: "trash-2",
};

const TODO_STATUS_ICONS: Record<TodoStatus, MobileIconName> = {
  pending: "circle",
  inProgress: "circle-dot",
  completed: "circle-check",
};

const TODO_STATUS_CLASS: Record<TodoStatus, string> = {
  pending: "is-pending",
  inProgress: "is-in-progress",
  completed: "is-completed",
};

const todoActionOf = (args: Json | null): TodoAction => {
  const raw = args ? asString(args.action) : undefined;
  return raw && (TODO_ACTIONS as readonly string[]).includes(raw)
    ? (raw as TodoAction)
    : "get";
};

const todoStatusOf = (value: unknown): TodoStatus | undefined => {
  const status = asString(value);
  return status === "pending" ||
    status === "inProgress" ||
    status === "completed"
    ? status
    : undefined;
};

type TodoListResult = {
  todos: TodoEntry[];
  deletedCount?: number;
  message: string;
};

/**
 * 结果解析：与桌面 useTodoPanel.parseTodoResult 同源（sessionId + todos[] 才算
 * 结构化列表，error 直接判失败），额外保留 deletedCount / message 供卡片展示。
 */
const parseTodoList = (record: Json | null): TodoListResult | null => {
  if (!record || typeof record.sessionId !== "string") return null;
  if (!Array.isArray(record.todos)) return null;
  const todos = asRecords(record.todos)
    .map((item): TodoEntry => ({
      id: asString(item.id) ?? "",
      content: asString(item.content) ?? "",
      status: todoStatusOf(item.status) ?? "pending",
      parentId: pickString(item, "parentId", "parent_id") ?? "",
    }))
    .filter((item) => item.id);
  return {
    todos,
    deletedCount: asNumber(record.deletedCount),
    message: asString(record.message) ?? "",
  };
};

/** 受影响条目行（新增内容 / 更新目标 / 删除目标）。 */
const todoAffectedRow = (icon: MobileIconName, text: string): HTMLElement => {
  const row = host("tc-ag-affected-item");
  const label = textSpan("tc-ag-affected-text", text);
  label.title = text;
  row.append(iconSpan(icon, "tc-ag-ico"), label);
  return row;
};

const renderTodo: ToolCallRenderer = (tool) => {
  const args = parseJsonRecord(tool.arguments);
  const record = parseJsonRecord(tool.result);
  const parsed = parseTodoList(record);
  const error = errorTextOf(tool, record);
  const hasRawResult = (tool.result ?? "").trim() !== "";

  if (!args && !hasRawResult) return null;

  const action = todoActionOf(args);
  const actionLabel = dyn(`todo.action.${action}`, action);
  const contentText = args ? listText(args.content) : "";
  const ids = args ? idText(args.todoId) : "";
  const parentId = args ? asString(args.parentId) : undefined;
  const statusArg = args ? todoStatusOf(args.status) : undefined;
  const completed =
    parsed?.todos.filter((item) => item.status === "completed").length ?? 0;

  const body = document.createDocumentFragment();
  const meta: Node[] = [];

  body.append(actionRow(TODO_ACTION_ICONS[action], actionLabel));

  // 参数（变更目标 / 父级 / 目标状态）
  const params: Node[] = [];
  if (action !== "get" && ids) params.push(tcKv(tr("todo.todoId"), ids));
  if (parentId) params.push(tcKv(tr("todo.parentId"), parentId));
  if (statusArg)
    params.push(
      tcKv(
        tr("todo.statusLabel"),
        dyn(`todo.statusValue.${statusArg}`, statusArg),
      ),
    );
  if (params.length) body.append(kvGrid(...params));

  // 变更类动作：受影响条目（新增 = 内容逐条；更新 / 删除 = 待办 ID）
  const affected: Node[] = [];
  if (action === "add") {
    for (const line of contentLines(contentText).slice(0, 20))
      affected.push(todoAffectedRow("plus", line));
  } else if (action === "update" || action === "delete") {
    const icon: MobileIconName = action === "update" ? "file-pen" : "trash-2";
    for (const id of idList(ids).slice(0, 20))
      affected.push(todoAffectedRow(icon, id));
  }
  if (affected.length) {
    const list = host("tc-ag-affected");
    list.append(...affected);
    body.append(tcSection(tr("todo.affected"), list));
  }

  // 内容（新增已在受影响条目里逐条展示，这里只覆盖 update / get）
  if (contentText && action !== "add") {
    body.append(tcSection(tr("todo.content"), tcPre(readable(contentText))));
  }

  // 列表 + 统计
  if (parsed && parsed.todos.length) {
    const list = host("tc-ag-todo");
    for (const item of parsed.todos) {
      const row = host(`tc-ag-todo-row ${TODO_STATUS_CLASS[item.status]}`);
      if (item.parentId) row.classList.add("is-child");
      row.title = item.content;
      row.append(
        iconSpan(TODO_STATUS_ICONS[item.status], "tc-ag-todo-mark"),
        textSpan("tc-ag-todo-text", readable(item.content)),
      );
      list.append(row);
    }
    const countText = tr("todo.count", {
      completed,
      total: parsed.todos.length,
    });
    meta.push(
      tcBadge(countText, completed === parsed.todos.length ? "ok" : "muted"),
    );
    body.append(tcSection(tr("todo.list"), list));
  } else if (parsed && action === "get" && !parsed.message) {
    body.append(noteRow("empty", "list-checks", tr("todo.empty")));
  }

  // 变更结论
  if (parsed?.deletedCount !== undefined && parsed.deletedCount > 0) {
    body.append(
      statusRow(
        "circle-check",
        tr("todo.deleted", { count: parsed.deletedCount }),
        "ok",
      ),
    );
  } else if (parsed && parsed.todos.length && action === "add") {
    body.append(
      statusRow(
        "circle-check",
        tr("todo.added", { count: parsed.todos.length }),
        "ok",
      ),
    );
  } else if (parsed && parsed.todos.length && action === "update") {
    body.append(
      statusRow(
        "circle-check",
        tr("todo.updated", { count: parsed.todos.length }),
        "ok",
      ),
    );
  }

  if (parsed?.message)
    body.append(noteRow("note", "clipboard-list", readable(parsed.message)));
  if (error) body.append(tcErrorRow(readable(error)));

  if (!parsed && !error) {
    const live = liveRow(tool, tr("running"));
    if (live) body.append(live);
    const raw = rawResultSection(tool);
    if (raw) body.append(raw);
  }

  const target = contentText ? clip(contentText) : ids ? clip(ids) : "";

  return createToolNode({
    tool,
    status: resolveStatus(tool),
    badge: tr("todo.name"),
    display: target ? `${actionLabel} · ${target}` : actionLabel,
    displayTitle: target || actionLabel,
    meta,
    className: "tc-ag-todo-card",
    bodyClass: "tc-ag",
    body,
  });
};

// ── 记忆（memory-manage） ──────────────────────────────────────────────

const MEMORY_ACTIONS = ["save", "search", "list", "update", "delete"] as const;
type MemoryAction = (typeof MEMORY_ACTIONS)[number];

const MEMORY_ACTION_ICONS: Record<MemoryAction, MobileIconName> = {
  save: "file-plus",
  search: "search",
  list: "clipboard-list",
  update: "file-pen",
  delete: "trash-2",
};

/** 动作优先取参数；旧快照的工具名后缀（memory-save → save）作为兼容回落。 */
const memoryActionOf = (name: string, args: Json | null): MemoryAction => {
  const fromArgs = args ? asString(args.action) : undefined;
  if (fromArgs && (MEMORY_ACTIONS as readonly string[]).includes(fromArgs))
    return fromArgs as MemoryAction;
  const suffix = name.startsWith("memory-")
    ? name.slice("memory-".length)
    : name;
  return (MEMORY_ACTIONS as readonly string[]).includes(suffix)
    ? (suffix as MemoryAction)
    : "list";
};

type MemoryEntry = {
  memoryId: string;
  kind: string;
  title: string;
  content: string;
  status: string;
  importance?: number;
  tags: string[];
};

/** 单条记忆记录（工具结果 JSON 为下划线字段，napi 导出为驼峰，两者都接受）。 */
const parseMemoryEntry = (record: Json): MemoryEntry | null => {
  const title = pickString(record, "title") ?? "";
  const content = pickString(record, "content") ?? "";
  if (!title && !content) return null;
  return {
    memoryId: pickString(record, "memoryId", "memory_id") ?? "",
    kind: pickString(record, "kind") ?? "",
    title,
    content,
    status: pickString(record, "status") ?? "",
    importance: pickNumber(record, "importance"),
    tags: asStrings(record.tags),
  };
};

/** 记忆条目：标题 + 类别 / 重要性 / 状态徽标 + 内容 + 标签。 */
const memoryNode = (entry: MemoryEntry): HTMLElement => {
  const row = host("tc-ag-mem");
  const head = host("tc-ag-mem-head");
  const title = textSpan(
    "tc-ag-mem-title",
    entry.title || clip(entry.content, 40),
  );
  if (entry.title) title.title = entry.title;
  head.append(title);
  if (entry.kind)
    head.append(
      tcBadge(dyn(`memory.kindValue.${entry.kind}`, entry.kind), "muted"),
    );
  if (entry.importance !== undefined)
    head.append(
      tcBadge(
        `${tr("memory.importance")} ${entry.importance}`,
        entry.importance >= 3 ? "warn" : "muted",
      ),
    );
  if (entry.status && entry.status !== "active")
    head.append(
      tcBadge(dyn(`memory.statusValue.${entry.status}`, entry.status), "muted"),
    );
  row.append(head);

  const content = textSpan(
    "tc-ag-mem-text",
    clip(readable(entry.content), 220),
  );
  content.title = entry.content;
  row.append(content);

  if (entry.tags.length) {
    const tags = host("tc-ag-mem-tags");
    for (const tag of entry.tags.slice(0, 12))
      tags.append(textSpan("tc-ag-chip", `#${tag}`));
    row.append(tags);
  }
  return row;
};

const renderMemory: ToolCallRenderer = (tool) => {
  const args = parseJsonRecord(tool.arguments);
  const record = parseJsonRecord(tool.result);
  const hasRawResult = (tool.result ?? "").trim() !== "";

  if (!args && !record && !hasRawResult) return null;

  const action = memoryActionOf(tool.name, args);
  const actionLabel = dyn(`memory.action.${action}`, action);
  const icon = MEMORY_ACTION_ICONS[action];

  const title = args ? asString(args.title) : undefined;
  const query = args ? asString(args.query) : undefined;
  const contentText = args ? listText(args.content) : "";
  const memoryId = args ? asString(args.memoryId) : undefined;
  const kindArg = args ? asString(args.kind) : undefined;
  const importanceArg = args ? asNumber(args.importance) : undefined;
  const tagsArg = args ? asStrings(args.tags) : [];
  const statusArg = args ? asString(args.status) : undefined;
  const limitArg = args ? asNumber(args.limit) : undefined;

  const single =
    record && isRecord(record.memory) ? parseMemoryEntry(record.memory) : null;
  const entries = record
    ? [
        ...asRecords(record.items),
        ...asRecords(record.results),
        ...asRecords(record.memories),
      ]
        .map(parseMemoryEntry)
        .filter((entry): entry is MemoryEntry => entry !== null)
    : [];
  const created = record?.created === true;
  const deleted = record?.deleted === true;
  const missing = record?.deleted === false;
  const message = record ? asString(record.message) : undefined;
  const error = errorTextOf(tool, record);
  const count = record ? (asNumber(record.count) ?? entries.length) : 0;

  const body = document.createDocumentFragment();
  const meta: Node[] = [];

  body.append(actionRow(icon, actionLabel));

  // 参数
  const params: Node[] = [];
  if (title) params.push(tcKv(tr("memory.title"), clip(title, 120)));
  if (query) params.push(tcKv(tr("memory.query"), clip(query, 120)));
  if (memoryId) params.push(tcKv(tr("memory.memoryId"), memoryId));
  if (kindArg)
    params.push(
      tcKv(tr("memory.kind"), dyn(`memory.kindValue.${kindArg}`, kindArg)),
    );
  if (importanceArg !== undefined)
    params.push(tcKv(tr("memory.importance"), String(importanceArg)));
  if (statusArg) params.push(tcKv(tr("memory.statusLabel"), statusArg));
  if (limitArg !== undefined)
    params.push(tcKv(tr("memory.limit"), String(limitArg)));
  if (params.length) body.append(kvGrid(...params));

  if (tagsArg.length) {
    const chips = host("tc-ag-chips");
    for (const tag of tagsArg.slice(0, 12))
      chips.append(textSpan("tc-ag-chip", `#${tag}`));
    body.append(tcSection(tr("memory.tags"), chips));
  }

  if (contentText)
    body.append(tcSection(tr("memory.content"), tcPre(readable(contentText))));

  // 结果条目（save / update / search 的命中条目；list 的浏览结果）
  if (single) {
    body.append(tcSection(tr("memory.result"), memoryNode(single)));
  } else if (entries.length) {
    const list = host("tc-ag-mems");
    for (const entry of entries) list.append(memoryNode(entry));
    body.append(tcSection(tr("memory.results"), list));
  } else if (
    record &&
    !error &&
    !deleted &&
    (action === "search" || action === "list")
  ) {
    body.append(noteRow("empty", "brain-circuit", tr("memory.empty")));
  }
  if (count > 0) meta.push(tcBadge(tr("memory.entryCount", { count }), "ok"));

  // 结论
  if (deleted) {
    body.append(statusRow("circle-check", tr("memory.deleted"), "ok"));
    meta.push(tcBadge(tr("memory.deleted"), "ok"));
  } else if (missing) {
    body.append(statusRow("x", tr("memory.missing"), "warn"));
    meta.push(tcBadge(tr("memory.missing"), "warn"));
  } else if (single && action === "save") {
    body.append(
      statusRow(
        "circle-check",
        created ? tr("memory.created") : tr("memory.merged"),
        "ok",
      ),
    );
  } else if (single && action === "update") {
    body.append(statusRow("circle-check", tr("memory.updated"), "ok"));
  }

  if (message) body.append(noteRow("note", "brain-circuit", readable(message)));
  if (error) body.append(tcErrorRow(readable(error)));

  if (!record && !error) {
    const live = liveRow(tool, tr("running"));
    if (live) body.append(live);
    const raw = rawResultSection(tool);
    if (raw) body.append(raw);
  }

  const target = title ?? query ?? memoryId ?? "";

  return createToolNode({
    tool,
    status: resolveStatus(tool),
    badge: tr("memory.name"),
    display: target ? `${actionLabel} · ${clip(target)}` : actionLabel,
    displayTitle: target || actionLabel,
    meta,
    className: "tc-ag-memory",
    bodyClass: "tc-ag",
    body,
  });
};

// ── 模块装配 ────────────────────────────────────────────────────────────

export const agentsModule: ToolModule = {
  renderers: {
    "sub-agents-activate": renderSubAgentActivate,
    "sub-agents-continue": renderSubAgentContinue,
    "skills-skill-execute": renderSkill,
    "todo-todo-manage": renderTodo,
  },
  prefixes: [{ prefix: "memory-", render: renderMemory }],
};
