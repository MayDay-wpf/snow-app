/**
 * exec 工具族卡片：一次命令（bash-terminal-execute）、持久终端（terminal-*）、
 * 桌面操作（computer-use-*）。
 *
 * 字段与状态语义以桌面组件为准（BashToolCall / TerminalToolCall /
 * ComputerUseToolCall），移动端只做只读展示：
 * - bash：头部摘要 = 描述或命令行首行（displayTitle 全量命令），正文按
 *   「参数 → 命令 → 运行中 → stdout → stderr → 结果 → 错误」分区；流式
 *   stdout/stderr 优先，最终结果只补差集，避免同段输出重复两遍；
 * - terminal-*：按 open / send / read / resize / wait / close / focus / list
 *   分操作给出摘要与正文（工具名清单来自 native/src/mcp/servers/terminal.rs）；
 * - computer-use-*：动作名 + 坐标 / 文本 / 按键摘要 + 结果 JSON；截图类结果
 *   的图像数据现在随 result 全量下发，但手机端暂无图像渲染能力，仍只展示
 *   占位与元数据，不伪装成可看图。
 *
 * 通用约定（tools/ui.ts 顶部注释）：
 * - 卡片走 createToolNode，长文本走 tcPre 折叠（.tc-fold 由 timeline 的点击
 *   委托切换），折叠容器统一用 base.css 的 .tc-fold / .tc-more 协议；
 * - arguments / result / streaming* 都是远控桥透传的原始字符串，解析失败或
 *   缺关键字段时渲染器返回 null，交给 generic 兜底卡；
 * - 手机端没有终端仿真器：输出里的 ANSI 转义序列与控制字符统一剥离（桌面
 *   TerminalToolCall 依赖 xterm 序列化后的纯文本，无同等规则可复用）；
 * - 所有数据文本一律 textContent 写入，只有静态图标标记走 iconMarkup。
 */
import { t } from "../i18n";
import { iconMarkup } from "../icons";
import type { ToolCallRenderer, ToolModule, ToolStatus } from "./types";
import {
  createToolNode,
  decodeEscapedNewlines,
  formatJson,
  parseJsonRecord,
  tcBadge,
  tcErrorRow,
  tcFoldBlock,
  tcKv,
  tcPre,
  tcSection,
  type JsonRecord,
} from "./ui";

// ── 通用小件 ──────────────────────────────────────────────────────────────

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

/** 头部摘要长度上限（单行省略；与桌面端 56-60 字符的摘要量级一致）。 */
const DISPLAY_MAX = 72;

/**
 * 控制字符清理：换行统一为 \n、制表符保留，剥离 ANSI 转义序列（CSI / OSC /
 * 双字符 ESC）与其余 C0 控制字符 —— 这些序列在手机端只会显示成乱码。
 */
const stripControl = (text: string): string =>
  text
    .replace(/\r\n?/g, "\n")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u009b[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b[@-Z\\-_]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");

/** 摘要单行化：合并空白并截断（超出补省略号）。 */
const oneLine = (text: string, max = DISPLAY_MAX): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

/** 命令首行（多行命令的摘要，与桌面 getCommandSummary 一致）。 */
const firstLine = (text: string): string =>
  (text.trim().split(/\r?\n/, 1)[0] ?? "").trim();

/** 时长文案：整秒用「30s」，毫秒级用「500ms」。 */
const durationText = (ms: number): string => {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
};

/** tcPre 结果里的 pre（超阈值时在 .tc-fold 内部，折叠协议见 base.css）。 */
const preOf = (node: HTMLElement): HTMLElement =>
  node.tagName === "PRE" ? node : (node.querySelector("pre") ?? node);

/** 等宽文本块 + 追加类名（命令行 / 错误色输出）。 */
const styledPre = (text: string, className: string): HTMLElement => {
  const block = tcPre(text);
  preOf(block).classList.add(className);
  return block;
};

type OutputAnnotation = "error" | "warning" | "hint" | "context";

/** 某条流的行级诊断标注（行号相对该流自身，0 基）。 */
const annotationsFor = (
  diagnostics: BashDiagnostics | undefined,
  stream: "stdout" | "stderr",
): Map<number, OutputAnnotation> => {
  const result = new Map<number, OutputAnnotation>();
  for (const item of diagnostics?.items ?? []) {
    if (item.stream !== stream) {
      continue;
    }
    const severity: OutputAnnotation =
      item.severity === "warning"
        ? "warning"
        : item.confidence === "high"
          ? "error"
          : "hint";
    if (!result.has(item.line)) {
      result.set(item.line, severity);
    }
    for (let line = item.line + 1; line <= item.endLine; line += 1) {
      if (!result.has(line)) {
        result.set(line, "context");
      }
    }
  }
  return result;
};

/** 逐行渲染的输出块：诊断行着色，其余行保持普通文本。 */
const annotatedOutput = (
  text: string,
  annotations: Map<number, OutputAnnotation>,
  live: boolean,
): HTMLElement => {
  const lines = text.split("\n");
  const pre = el("pre", "tc-pre tc-pre-lines");
  lines.forEach((line, index) => {
    const severity = annotations.get(index);
    pre.append(
      el(
        "div",
        `tc-out-line${severity ? ` tc-out-line-${severity}` : ""}`,
        line,
      ),
    );
  });
  if (live) {
    const caret = el("span", "tc-exec-caret");
    caret.setAttribute("aria-hidden", "true");
    pre.append(caret);
  }
  return tcFoldBlock(pre, lines.length);
};

/** 输出块（等宽、超长自动折叠）；live 时末尾追加流式光标。 */
const outputBlock = (
  text: string,
  opts: {
    live?: boolean;
    stream?: "stdout" | "stderr";
    annotations?: Map<number, OutputAnnotation>;
  } = {},
): HTMLElement => {
  if (opts.annotations && opts.annotations.size > 0) {
    return annotatedOutput(text, opts.annotations, opts.live === true);
  }
  const block = tcPre(text);
  const pre = preOf(block);
  if (opts.stream === "stderr") pre.classList.add("tc-pre-stderr");
  if (opts.live) {
    const caret = el("span", "tc-exec-caret");
    caret.setAttribute("aria-hidden", "true");
    pre.append(caret);
  }
  return block;
};

/** 提示行（降级 / 空态 / 占位说明）。 */
const noteRow = (message: string, variant: "warn" | "muted"): HTMLElement =>
  el("div", `tc-exec-note tc-exec-note-${variant}`, message);

/** 标签 + 任意内容行（键值 / 芯片 / 命令行等复合值）。 */
const fieldRow = (label: string, content: Node): HTMLElement => {
  const row = el("div", "tc-exec-field");
  row.append(el("span", "tc-exec-field-label", label), content);
  return row;
};

/** 长值行（路径 / 终端 ID：等宽、任意位置可换行，不省略）。 */
const pathRow = (label: string, value: string): HTMLElement =>
  fieldRow(label, el("code", "tc-exec-value", value));

/** 结论行（成功 / 告警），带 lucide 图标。 */
const statusRow = (
  text: string,
  variant: "ok" | "warn",
  icon: "check" | "clock",
): HTMLElement => {
  const row = el("div", `tc-exec-status tc-exec-status-${variant}`);
  const mark = el("span", "tc-exec-status-icon");
  mark.setAttribute("aria-hidden", "true");
  mark.innerHTML = iconMarkup(icon);
  row.append(mark, el("span", "tc-exec-status-text", text));
  return row;
};

/** 运行中指示：脉冲圆点（或旋转图标）+ 文案。 */
const liveRow = (label: string, spin = false): HTMLElement => {
  const row = el("div", "tc-exec-live");
  const mark = el("span", spin ? "tc-exec-spin" : "tc-exec-live-dot");
  mark.setAttribute("aria-hidden", "true");
  if (spin) mark.innerHTML = iconMarkup("loader-circle");
  row.append(mark, el("span", "tc-exec-live-text", label));
  return row;
};

/** 参数原文回退块（半截 JSON / 参数缺失时）。 */
const rawArgsSection = (raw?: string): HTMLElement => {
  const trimmed = (raw ?? "").trim();
  return tcSection(
    t("remote.toolCall.exec.args"),
    tcPre(
      trimmed
        ? decodeEscapedNewlines(trimmed)
        : t("remote.toolCall.common.noArgs"),
    ),
  );
};

/** 两端文本是否等价（去首尾空白，避免流式与最终结果重复展示同一段输出）。 */
const sameText = (a: string, b: string): boolean => a.trim() === b.trim();

// ── bash-terminal-execute ────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000;

type BashArgs = {
  command: string;
  workingDirectory?: string;
  description?: string;
  timeout?: number;
  isInteractive: boolean;
  detach: boolean;
};

/** 参数解析：command 为关键字段，缺失即回退 generic（其余字段可选）。 */
const parseBashArgs = (record: JsonRecord | null): BashArgs | null => {
  if (!record || typeof record.command !== "string" || !record.command.trim()) {
    return null;
  }
  const workingDirectory =
    typeof record.workingDirectory === "string"
      ? record.workingDirectory.trim()
      : "";
  const description =
    typeof record.description === "string" ? record.description.trim() : "";
  return {
    command: record.command,
    workingDirectory: workingDirectory || undefined,
    description: description || undefined,
    timeout:
      typeof record.timeout === "number" && record.timeout > 0
        ? record.timeout
        : undefined,
    isInteractive: record.isInteractive === true,
    detach: record.detach === true,
  };
};

type ExitOutcome = {
  kind: string;
  failed: boolean;
  signal: string | null;
};

type BashDiagnosticItem = {
  severity: "error" | "warning";
  stream: "stdout" | "stderr";
  line: number;
  endLine: number;
  confidence: "high" | "medium";
  rule: string;
  message: string;
};

type BashDiagnostics = {
  complete: boolean;
  commandKind: string;
  counts: { error: number; warning: number };
  items: BashDiagnosticItem[];
};

type BashStructuredExtra = {
  outcome?: ExitOutcome;
  diagnostics?: BashDiagnostics;
};

type BashResult =
  | ({
      type: "success";
      stdout: string;
      stderr: string;
      exitCode: number;
    } & BashStructuredExtra)
  | ({
      type: "failed";
      kind: "timeout" | "cancelled" | "error";
      message: string;
      stdout: string;
      stderr: string;
    } & BashStructuredExtra)
  | { type: "detached"; pid: number; logPath: string }
  | { type: "raw"; text: string }
  | { type: "empty" };

const parseBashOutcome = (record: JsonRecord): ExitOutcome | undefined => {
  const raw = record.outcome;
  if (
    !isRecord(raw) ||
    typeof raw.kind !== "string" ||
    typeof raw.failed !== "boolean"
  ) {
    return undefined;
  }
  return {
    kind: raw.kind,
    failed: raw.failed,
    signal: typeof raw.signal === "string" && raw.signal ? raw.signal : null,
  };
};

const parseBashDiagnostics = (
  record: JsonRecord,
): BashDiagnostics | undefined => {
  const raw = record.diagnostics;
  if (!isRecord(raw) || !Array.isArray(raw.items)) {
    return undefined;
  }
  const items: BashDiagnosticItem[] = [];
  for (const entry of raw.items) {
    if (!isRecord(entry)) {
      continue;
    }
    const { severity, stream, line, endLine, confidence, rule, message } =
      entry;
    if (
      (severity !== "error" && severity !== "warning") ||
      (stream !== "stdout" && stream !== "stderr") ||
      typeof line !== "number" ||
      !Number.isInteger(line) ||
      line < 0 ||
      typeof endLine !== "number" ||
      !Number.isInteger(endLine) ||
      endLine < line ||
      (confidence !== "high" && confidence !== "medium") ||
      typeof rule !== "string" ||
      typeof message !== "string"
    ) {
      continue;
    }
    items.push({
      severity,
      stream,
      line,
      endLine,
      confidence,
      rule,
      message,
    });
  }
  const counts = isRecord(raw.counts) ? raw.counts : {};
  return {
    complete: raw.complete !== false,
    commandKind:
      typeof raw.commandKind === "string" ? raw.commandKind : "unknown",
    counts: {
      error:
        typeof counts.error === "number"
          ? counts.error
          : items.filter((item) => item.severity === "error").length,
      warning:
        typeof counts.warning === "number"
          ? counts.warning
          : items.filter((item) => item.severity === "warning").length,
    },
    items,
  };
};

const isTimeoutMessage = (message: string): boolean =>
  /timed?\s*out/i.test(message);

/**
 * 结果解析：结构化 status（completed / timed_out / cancelled / failed /
 * spawn_failed）→ 旧版 error 文案 → stdout+stderr+exitCode 兜底 → 原文，
 * 分支与桌面 BashToolCall.parseResult 逐条对齐。
 */
const parseBashResult = (raw?: string): BashResult => {
  if (!raw) return { type: "empty" };
  const record = parseJsonRecord(raw);
  if (!record) return { type: "raw", text: raw };

  if (record.detached === true) {
    return {
      type: "detached",
      pid: typeof record.pid === "number" ? record.pid : 0,
      logPath: typeof record.logPath === "string" ? record.logPath : "",
    };
  }

  const stdout =
    typeof record.stdout === "string" ? stripControl(record.stdout) : "";
  const stderr =
    typeof record.stderr === "string" ? stripControl(record.stderr) : "";
  const errorMessage =
    typeof record.error === "string" ? stripControl(record.error).trim() : "";
  const extra: BashStructuredExtra = {
    outcome: parseBashOutcome(record),
    diagnostics: parseBashDiagnostics(record),
  };

  if (typeof record.status === "string") {
    switch (record.status) {
      case "completed":
        if (typeof record.exitCode === "number") {
          return {
            type: "success",
            stdout,
            stderr,
            exitCode: record.exitCode,
            ...extra,
          };
        }
        break;
      case "timed_out":
        return {
          type: "failed",
          kind: "timeout",
          message: errorMessage || t("remote.toolCall.exec.bash.timedOut"),
          stdout,
          stderr,
          ...extra,
        };
      case "cancelled":
        return {
          type: "failed",
          kind: "cancelled",
          message: errorMessage || t("remote.toolCall.exec.bash.cancelled"),
          stdout,
          stderr,
          ...extra,
        };
      case "failed":
      case "spawn_failed":
        return {
          type: "failed",
          kind: "error",
          message: errorMessage || t("remote.toolCall.exec.bash.failed"),
          stdout,
          stderr,
          ...extra,
        };
      default:
        break;
    }
  }

  if (errorMessage) {
    return {
      type: "failed",
      kind: isTimeoutMessage(errorMessage) ? "timeout" : "error",
      message: errorMessage,
      stdout,
      stderr,
      ...extra,
    };
  }

  if (
    typeof record.stdout === "string" &&
    typeof record.stderr === "string" &&
    typeof record.exitCode === "number" &&
    Number.isInteger(record.exitCode)
  ) {
    return {
      type: "success",
      stdout,
      stderr,
      exitCode: record.exitCode,
      ...extra,
    };
  }
  return { type: "raw", text: raw };
};

export const renderBashCard: ToolCallRenderer = (tool) => {
  const args = parseBashArgs(parseJsonRecord(tool.arguments));
  if (!args) return null;

  const result = parseBashResult(tool.result);
  const isRunning = tool.status === "running";
  const outcome =
    result.type === "success" || result.type === "failed"
      ? result.outcome
      : undefined;
  const failed =
    result.type === "failed" ||
    (result.type === "success" &&
      (outcome ? outcome.failed : result.exitCode !== 0));
  const status: ToolStatus = failed ? "error" : tool.status;
  const diagnostics =
    result.type === "success" || result.type === "failed"
      ? result.diagnostics
      : undefined;
  const stdoutAnnotations = annotationsFor(diagnostics, "stdout");
  const stderrAnnotations = annotationsFor(diagnostics, "stderr");

  // 流式输出（远控桥 ≤8000 字符、增量增长）优先，最终结果只补差集。
  const streamStdout = stripControl(tool.streamingStdout ?? "");
  const streamStderr = stripControl(tool.streamingStderr ?? "");
  const finalStdout =
    result.type === "success" || result.type === "failed" ? result.stdout : "";
  const finalStderr =
    result.type === "success" || result.type === "failed" ? result.stderr : "";
  const restStdout =
    finalStdout && !sameText(finalStdout, streamStdout) ? finalStdout : "";
  const restStderr =
    finalStderr && !sameText(finalStderr, streamStderr) ? finalStderr : "";

  const meta: Node[] = [];
  if (args.isInteractive) {
    meta.push(tcBadge(t("remote.toolCall.exec.bash.interactive"), "muted"));
  }
  if (result.type === "success") {
    const exitFailed = outcome?.failed ?? result.exitCode !== 0;
    meta.push(
      tcBadge(
        outcome?.signal
          ? t("remote.toolCall.exec.bash.crash", { signal: outcome.signal })
          : t("remote.toolCall.exec.bash.exitCode", { code: result.exitCode }),
        exitFailed
          ? "err"
          : outcome && outcome.kind !== "success"
            ? "muted"
            : "ok",
      ),
    );
  } else if (result.type === "failed" && result.kind !== "error") {
    meta.push(
      tcBadge(
        t(
          result.kind === "timeout"
            ? "remote.toolCall.exec.bash.timedOut"
            : "remote.toolCall.exec.bash.cancelled",
        ),
        "warn",
      ),
    );
  } else if (result.type === "detached") {
    meta.push(
      tcBadge(t("remote.toolCall.exec.bash.detached", { pid: result.pid })),
    );
  }

  const body = document.createDocumentFragment();

  // 参数：工作目录 / 超时 / 描述
  const params = el("div", "tc-exec-params");
  if (args.workingDirectory) {
    params.append(
      pathRow(t("remote.toolCall.exec.bash.workdir"), args.workingDirectory),
    );
  }
  params.append(
    tcKv(
      t("remote.toolCall.exec.bash.timeout"),
      durationText(args.timeout ?? DEFAULT_TIMEOUT_MS),
    ),
  );
  if (args.description) {
    params.append(
      tcKv(t("remote.toolCall.exec.bash.description"), args.description),
    );
  }
  body.append(params);

  // 命令（`$ ` 前缀由 .tc-cmd::before 提供，长命令走折叠）
  body.append(
    tcSection(
      t("remote.toolCall.exec.bash.command"),
      styledPre(args.command, "tc-cmd"),
    ),
  );

  if (isRunning) body.append(liveRow(t("remote.toolCall.exec.bash.running")));
  if (outcome?.signal) {
    body.append(
      noteRow(
        t("remote.toolCall.exec.bash.crashed", { signal: outcome.signal }),
        "warn",
      ),
    );
  }

  if (streamStdout) {
    body.append(
      tcSection(
        t("remote.toolCall.common.stdout"),
        outputBlock(streamStdout, {
          live: isRunning,
          annotations:
            !isRunning && !restStdout && !restStderr
              ? stdoutAnnotations
              : undefined,
        }),
        {
          meta: isRunning
            ? [tcBadge(t("remote.toolCall.exec.streaming"), "muted")]
            : undefined,
        },
      ),
    );
  }
  if (streamStderr) {
    body.append(
      tcSection(
        t("remote.toolCall.common.stderr"),
        outputBlock(streamStderr, {
          live: isRunning,
          stream: "stderr",
          annotations:
            !isRunning && !restStdout && !restStderr
              ? stderrAnnotations
              : undefined,
        }),
      ),
    );
  }
  if (restStdout) {
    body.append(
      tcSection(
        t("remote.toolCall.common.stdout"),
        outputBlock(restStdout, { annotations: stdoutAnnotations }),
      ),
    );
  }
  if (restStderr) {
    body.append(
      tcSection(
        t("remote.toolCall.common.stderr"),
        outputBlock(restStderr, {
          stream: "stderr",
          annotations: stderrAnnotations,
        }),
      ),
    );
  }

  if (result.type === "detached") {
    const rows = el("div", "tc-exec-params");
    rows.append(tcKv("PID", String(result.pid)));
    if (result.logPath) {
      rows.append(
        pathRow(t("remote.toolCall.exec.bash.logPath"), result.logPath),
      );
    }
    body.append(rows);
  }
  if (result.type === "raw") {
    body.append(
      tcSection(
        t("remote.toolCall.exec.result"),
        outputBlock(stripControl(result.text)),
      ),
    );
  }
  if (result.type === "failed") body.append(tcErrorRow(result.message));

  // 空态：运行中由运行指示承担，其余按「失败 / 等待」给一行说明。
  if (result.type === "empty" && !streamStdout && !streamStderr && !isRunning) {
    body.append(
      noteRow(
        status === "error"
          ? t("remote.toolCall.exec.bash.failed")
          : t("remote.toolCall.exec.bash.waiting"),
        "muted",
      ),
    );
  }

  return createToolNode({
    tool,
    status,
    badge: t("remote.toolCall.exec.bash.name"),
    display: args.description ?? oneLine(firstLine(args.command)),
    displayTitle: args.command,
    meta,
    bodyClass: "tc-exec",
    body,
  });
};

// ── terminal-* ───────────────────────────────────────────────────────────

/** 桌面临端 MCP 的全部工具名（native/src/mcp/servers/terminal.rs）。 */
const TERMINAL_OPERATIONS = [
  "open",
  "send",
  "read",
  "resize",
  "wait",
  "close",
  "focus",
  "list",
] as const;
type TerminalOperation = (typeof TERMINAL_OPERATIONS)[number];

/** 未知后缀（如未来新增的 terminal-xxx）返回 null，交给 generic 兜底。 */
const parseTerminalOperation = (name: string): TerminalOperation | null => {
  const operation = name.slice("terminal-".length);
  return (TERMINAL_OPERATIONS as readonly string[]).includes(operation)
    ? (operation as TerminalOperation)
    : null;
};

type TerminalArgs = {
  tabId?: string;
  cwd?: string;
  shellPath?: string;
  sessionId?: string;
  input?: string;
  keys?: string[];
  waitMs?: number;
  cols?: number;
  rows?: number;
  timeoutMs?: number;
  idleMs?: number;
};

const parseTerminalArgs = (record: JsonRecord | null): TerminalArgs => {
  if (!record) return {};
  const str = (key: string): string | undefined => {
    const value = record[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  const num = (key: string): number | undefined =>
    typeof record[key] === "number" ? (record[key] as number) : undefined;
  return {
    tabId: str("tabId"),
    cwd: str("cwd"),
    shellPath: str("shellPath"),
    sessionId: str("sessionId"),
    input: typeof record.input === "string" ? record.input : undefined,
    keys: Array.isArray(record.keys)
      ? record.keys.filter((key): key is string => typeof key === "string")
      : undefined,
    waitMs: num("waitMs"),
    cols: num("cols"),
    rows: num("rows"),
    timeoutMs: num("timeoutMs"),
    idleMs: num("idleMs"),
  };
};

type TerminalResult =
  | { type: "success"; data: JsonRecord }
  | { type: "error"; message: string }
  | { type: "raw"; text: string }
  | { type: "empty" };

const parseTerminalResult = (raw?: string): TerminalResult => {
  if (!raw) return { type: "empty" };
  const record = parseJsonRecord(raw);
  if (!record) return { type: "raw", text: raw };
  const message =
    typeof record.error === "string" ? stripControl(record.error).trim() : "";
  return message
    ? { type: "error", message }
    : { type: "success", data: record };
};

const dataString = (data: JsonRecord, key: string): string =>
  typeof data[key] === "string" ? (data[key] as string) : "";

const dataNumber = (data: JsonRecord, key: string): number | undefined =>
  typeof data[key] === "number" ? (data[key] as number) : undefined;

/** 终端 ID 压缩显示（与桌面 shortTabId 一致）。 */
const shortTabId = (tabId: string): string =>
  tabId.length <= 20 ? tabId : `${tabId.slice(0, 12)}…${tabId.slice(-6)}`;

/** 头部摘要（按操作取最有信息量的参数，与桌面 TerminalToolCall 一致）。 */
const terminalDisplay = (
  operation: TerminalOperation,
  args: TerminalArgs,
): string | undefined => {
  switch (operation) {
    case "open":
      return oneLine(
        args.cwd ?? args.shellPath ?? t("remote.toolCall.exec.terminal.newTab"),
      );
    case "send": {
      if (args.keys?.length) return oneLine(args.keys.join(" "));
      return args.input ? oneLine(args.input.replace(/\n/g, "↵")) : undefined;
    }
    case "read":
    case "wait":
    case "resize":
    case "close":
    case "focus":
      return args.tabId ? shortTabId(args.tabId) : undefined;
    default:
      return undefined;
  }
};

/** 头部徽章（尺寸 / 等待时长 / 结论）。 */
const terminalMeta = (
  operation: TerminalOperation,
  args: TerminalArgs,
  result: TerminalResult,
): HTMLElement[] => {
  const meta: HTMLElement[] = [];
  if (operation === "resize" && args.cols && args.rows) {
    meta.push(tcBadge(`${args.cols} × ${args.rows}`));
  }
  if (operation === "wait") {
    meta.push(tcBadge(durationText(args.timeoutMs ?? 30_000), "muted"));
  }
  if (operation === "read" && args.waitMs) {
    meta.push(tcBadge(`${args.waitMs}ms`, "muted"));
  }
  if (result.type === "success") {
    if (operation === "open") {
      meta.push(tcBadge(t("remote.toolCall.exec.terminal.opened"), "ok"));
    }
    if (operation === "close") {
      meta.push(tcBadge(t("remote.toolCall.exec.terminal.closed"), "ok"));
    }
    if (operation === "focus") {
      meta.push(tcBadge(t("remote.toolCall.exec.terminal.focused"), "ok"));
    }
    if (operation === "list") {
      meta.push(
        tcBadge(String(dataNumber(result.data, "totalTabs") ?? 0), "muted"),
      );
    }
  }
  return meta;
};

/** 终端等待输入提示（read / wait 结果带 awaitingInput 时）。 */
const awaitingRow = (data: JsonRecord): HTMLElement | null => {
  if (data.awaitingInput !== true) return null;
  const row = el("div", "tc-exec-awaiting");
  const mark = el("span", "tc-exec-awaiting-icon");
  mark.setAttribute("aria-hidden", "true");
  mark.innerHTML = iconMarkup("command");
  row.append(
    mark,
    el(
      "span",
      "tc-exec-awaiting-text",
      t("remote.toolCall.exec.terminal.awaitingInput"),
    ),
  );
  const hint = dataString(data, "inputHint");
  if (hint) row.append(el("code", "tc-exec-awaiting-hint", hint));
  return row;
};

/** 按键序列芯片（terminal-send 的 keys 模式）。 */
const keyChips = (keys: string[]): HTMLElement => {
  const list = el("div", "tc-exec-keys");
  for (const key of keys) list.append(el("code", "tc-exec-key", key));
  return list;
};

/** 输入行（terminal-send 的 input 模式，`>` 提示符）。 */
const inputBlock = (input: string): HTMLElement => {
  const pre = el("pre", "tc-exec-input");
  const prompt = el("span", "tc-exec-input-prompt", ">");
  prompt.setAttribute("aria-hidden", "true");
  pre.append(prompt, el("code", "tc-exec-input-text", stripControl(input)));
  return pre;
};

/** 参数分区（按操作给出对应字段）。 */
const terminalArgsBody = (
  operation: TerminalOperation,
  args: TerminalArgs,
): HTMLElement | null => {
  const wrap = el("div", "tc-exec-params");
  switch (operation) {
    case "open":
      if (args.cwd) {
        wrap.append(pathRow(t("remote.toolCall.exec.terminal.cwd"), args.cwd));
      }
      if (args.shellPath) {
        wrap.append(
          pathRow(t("remote.toolCall.exec.terminal.shellPath"), args.shellPath),
        );
      }
      // SSH 项目由会话绑定终端：参数里会带 sessionId（桌面端不展示，移动端保留线索）。
      if (args.sessionId) wrap.append(pathRow("sessionId", args.sessionId));
      break;
    case "send":
      if (args.tabId) {
        wrap.append(
          pathRow(t("remote.toolCall.exec.terminal.tabId"), args.tabId),
        );
      }
      if (args.keys?.length) {
        wrap.append(fieldRow("keys", keyChips(args.keys)));
      } else if (args.input !== undefined) {
        wrap.append(
          fieldRow(
            t("remote.toolCall.exec.terminal.input"),
            inputBlock(args.input),
          ),
        );
      }
      break;
    case "read":
      if (args.tabId) {
        wrap.append(
          pathRow(t("remote.toolCall.exec.terminal.tabId"), args.tabId),
        );
      }
      if (args.waitMs) wrap.append(tcKv("waitMs", `${args.waitMs}ms`));
      break;
    case "resize":
      if (args.tabId) {
        wrap.append(
          pathRow(t("remote.toolCall.exec.terminal.tabId"), args.tabId),
        );
      }
      wrap.append(
        tcKv("cols × rows", `${args.cols ?? 80} × ${args.rows ?? 24}`),
      );
      break;
    case "wait":
      if (args.tabId) {
        wrap.append(
          pathRow(t("remote.toolCall.exec.terminal.tabId"), args.tabId),
        );
      }
      if (args.timeoutMs) {
        wrap.append(tcKv("timeoutMs", `${args.timeoutMs}ms`));
      }
      if (args.idleMs) wrap.append(tcKv("idleMs", `${args.idleMs}ms`));
      break;
    case "close":
    case "focus":
      if (args.tabId) {
        wrap.append(
          pathRow(t("remote.toolCall.exec.terminal.tabId"), args.tabId),
        );
      }
      break;
    default:
      break;
  }
  return wrap.childNodes.length > 0 ? wrap : null;
};

/** 结果分区（按操作解读返回结构，字段见 terminal MCP 桥实现）。 */
const terminalResultBody = (
  operation: TerminalOperation,
  result: TerminalResult,
): DocumentFragment => {
  const fragment = document.createDocumentFragment();
  if (result.type === "error") {
    fragment.append(tcErrorRow(result.message));
    return fragment;
  }
  if (result.type === "raw") {
    fragment.append(
      tcSection(
        t("remote.toolCall.exec.result"),
        outputBlock(stripControl(result.text)),
      ),
    );
    return fragment;
  }
  if (result.type === "empty") return fragment;

  const data = result.data;
  switch (operation) {
    case "open": {
      const rows = el("div", "tc-exec-params");
      const tabId = dataString(data, "tabId");
      if (tabId) {
        rows.append(pathRow(t("remote.toolCall.exec.terminal.tabId"), tabId));
      }
      const cwd = dataString(data, "cwd");
      if (cwd) {
        rows.append(pathRow(t("remote.toolCall.exec.terminal.cwd"), cwd));
      }
      const shellPath = dataString(data, "shellPath");
      if (shellPath) {
        rows.append(
          pathRow(t("remote.toolCall.exec.terminal.shellPath"), shellPath),
        );
      }
      if (rows.childNodes.length > 0) fragment.append(rows);
      break;
    }
    case "send":
      fragment.append(
        statusRow(
          t("remote.toolCall.exec.terminal.sent", {
            length: dataNumber(data, "length") ?? 0,
          }),
          "ok",
          "check",
        ),
      );
      break;
    case "read": {
      const awaiting = awaitingRow(data);
      if (awaiting) fragment.append(awaiting);
      const text = stripControl(dataString(data, "text"));
      if (text) {
        fragment.append(
          tcSection(t("remote.toolCall.common.stdout"), outputBlock(text)),
        );
      }
      break;
    }
    case "wait": {
      const idle = data.idle === true;
      fragment.append(
        statusRow(
          t(
            idle
              ? "remote.toolCall.exec.terminal.idle"
              : "remote.toolCall.exec.terminal.timedOut",
          ),
          idle ? "ok" : "warn",
          idle ? "check" : "clock",
        ),
      );
      fragment.append(
        tcKv(
          t("remote.toolCall.exec.terminal.elapsed"),
          `${Math.round(dataNumber(data, "elapsedMs") ?? 0)}ms`,
        ),
      );
      const awaiting = awaitingRow(data);
      if (awaiting) fragment.append(awaiting);
      // 增量文本：优先 text，兼容旧字段 afterText。
      const text = stripControl(
        dataString(data, "text") || dataString(data, "afterText"),
      );
      if (text) {
        fragment.append(
          tcSection(t("remote.toolCall.common.stdout"), outputBlock(text)),
        );
      }
      break;
    }
    case "resize":
      fragment.append(
        statusRow(
          `${dataNumber(data, "cols") ?? 0} × ${dataNumber(data, "rows") ?? 0}`,
          "ok",
          "check",
        ),
      );
      break;
    case "close":
      fragment.append(
        statusRow(t("remote.toolCall.exec.terminal.closed"), "ok", "check"),
      );
      break;
    case "focus":
      fragment.append(
        statusRow(t("remote.toolCall.exec.terminal.focused"), "ok", "check"),
      );
      break;
    case "list": {
      const tabs = Array.isArray(data.tabs) ? data.tabs : [];
      const items = tabs.filter(isRecord);
      if (items.length === 0) {
        fragment.append(
          noteRow(t("remote.toolCall.exec.terminal.noTabs"), "muted"),
        );
        break;
      }
      const list = el("div", "tc-exec-tabs");
      for (const tab of items) {
        const row = el("div", "tc-exec-tab");
        row.append(
          el("code", "tc-exec-tab-id", shortTabId(dataString(tab, "tabId"))),
        );
        const title = dataString(tab, "title");
        if (title) row.append(el("span", "tc-exec-tab-title", title));
        const cwd = dataString(tab, "cwd");
        if (cwd) row.append(el("code", "tc-exec-tab-cwd", cwd));
        if (tab.isActive === true) {
          row.append(tcBadge(t("remote.toolCall.exec.terminal.active"), "ok"));
        }
        list.append(row);
      }
      fragment.append(list);
      break;
    }
    default:
      break;
  }
  return fragment;
};

export const renderTerminalCard: ToolCallRenderer = (tool) => {
  const operation = parseTerminalOperation(tool.name);
  if (!operation) return null;

  const args = parseTerminalArgs(parseJsonRecord(tool.arguments));
  const result = parseTerminalResult(tool.result);
  const isRunning = tool.status === "running";
  const status: ToolStatus = result.type === "error" ? "error" : tool.status;

  const body = document.createDocumentFragment();
  const argRows = terminalArgsBody(operation, args);
  if (argRows) body.append(argRows);
  if (isRunning)
    body.append(liveRow(t("remote.toolCall.exec.terminal.executing")));
  body.append(terminalResultBody(operation, result));
  if (result.type === "empty" && !isRunning) {
    body.append(noteRow(t("remote.toolCall.exec.terminal.waiting"), "muted"));
  }

  return createToolNode({
    tool,
    status,
    badge: t(`remote.toolCall.exec.terminal.op.${operation}`),
    display: terminalDisplay(operation, args),
    meta: terminalMeta(operation, args, result),
    bodyClass: "tc-exec",
    body,
  });
};

// ── computer-use-* ───────────────────────────────────────────────────────

/** 工具名后缀 → 词条键后缀（native/src/mcp/servers/computer_use/mod.rs 全量）。 */
const CU_ACTIONS: Record<string, string> = {
  "screen-info": "screenInfo",
  screenshot: "screenshot",
  "mouse-move": "mouseMove",
  "mouse-click": "mouseClick",
  "mouse-drag": "mouseDrag",
  "mouse-scroll": "mouseScroll",
  "mouse-button": "mouseButton",
  "key-tap": "keyTap",
  "key-button": "keyButton",
  "type-text": "typeText",
  "perform-actions": "performActions",
};

/**
 * 结果里追加的内联图片标签（真实 base64 只存在此处）：`{JSON}\n@@image:data:…@@`。
 * 结尾用 `(?:@@|$)` 容忍历史快照里被旧版远控桥截断的半截标签（新版桥全量下发，
 * 正常结果标签完整），否则 JSON 会被残片污染成「解析失败」，退化成原始文本。
 */
const INLINE_IMAGE_TAG_RE = /@@image:[^@]*(?:@@|$)/g;

const cuNumber = (record: JsonRecord, key: string): number | undefined =>
  typeof record[key] === "number" ? (record[key] as number) : undefined;

const cuString = (record: JsonRecord, key: string): string =>
  typeof record[key] === "string" ? (record[key] as string) : "";

/** 「(x, y)」坐标文案（任一值缺失用 ? 占位）。 */
const cuPoint = (
  record: JsonRecord,
  xKey: string,
  yKey: string,
): string | null => {
  const x = cuNumber(record, xKey);
  const y = cuNumber(record, yKey);
  return x !== undefined || y !== undefined
    ? `(${x ?? "?"}, ${y ?? "?"})`
    : null;
};

/** 头部摘要：动作名之外的坐标 / 文本 / 按键（与桌面 buildArgsSummary 一致）。 */
const cuSummary = (
  action: string,
  record: JsonRecord | null,
): string | undefined => {
  if (!record) return undefined;
  switch (action) {
    case "screenshot": {
      const display = cuNumber(record, "display");
      const parts = [
        display !== undefined
          ? `${t("remote.toolCall.exec.cu.display")} ${display}`
          : "",
        isRecord(record.region) ? t("remote.toolCall.exec.cu.region") : "",
      ].filter(Boolean);
      return parts.length > 0 ? oneLine(parts.join(" · ")) : undefined;
    }
    case "mouse-move":
      return cuPoint(record, "x", "y") ?? undefined;
    case "mouse-click": {
      const button = cuString(record, "button");
      const clicks = cuNumber(record, "clicks");
      const holdMs = cuNumber(record, "holdMs");
      const suffix =
        holdMs && holdMs > 0
          ? ` · ${t("remote.toolCall.exec.cu.hold", { ms: holdMs })}`
          : clicks && clicks > 1
            ? ` ×${clicks}`
            : "";
      const prefix = button && button !== "left" ? `${button} ` : "";
      return `${prefix}${
        cuPoint(record, "x", "y") ?? t("remote.toolCall.exec.cu.currentPoint")
      }${suffix}`;
    }
    case "mouse-drag": {
      const from = cuPoint(record, "x", "y");
      const to = cuPoint(record, "toX", "toY");
      const text = `${from ? `${from} → ` : ""}${to ?? ""}`;
      return text || undefined;
    }
    case "mouse-scroll":
      return `${cuNumber(record, "amount") ?? "?"} (${cuString(record, "axis") || "vertical"})`;
    case "mouse-button": {
      const at = cuPoint(record, "x", "y");
      const text = `${cuString(record, "action")} ${cuString(record, "button") || "left"}${
        at ? ` @ ${at}` : ""
      }`;
      return text.trim() || undefined;
    }
    case "key-tap": {
      const keys = Array.isArray(record.keys)
        ? record.keys.filter((key): key is string => typeof key === "string")
        : [];
      return keys.length > 0 ? oneLine(keys.join(" + ")) : undefined;
    }
    case "key-button": {
      const mode = cuString(record, "action");
      const holdMs = cuNumber(record, "holdMs");
      const suffix = mode === "hold" && holdMs ? ` (${holdMs}ms)` : "";
      return `${mode} ${cuString(record, "key")}${suffix}`.trim() || undefined;
    }
    case "type-text": {
      const text = cuString(record, "text");
      const preview = text.length > 40 ? `${text.slice(0, 40)}...` : text;
      const at = cuPoint(record, "x", "y");
      return oneLine(`${preview}${at ? ` @ ${at}` : ""}`) || undefined;
    }
    case "perform-actions": {
      const actions = Array.isArray(record.actions) ? record.actions : [];
      if (actions.length === 0) return undefined;
      const types = actions
        .map((item) =>
          isRecord(item) && typeof item.type === "string" ? item.type : "?",
        )
        .join(" · ");
      return `${t("remote.toolCall.exec.cu.steps", { count: actions.length })}: ${oneLine(types)}`;
    }
    default:
      return undefined;
  }
};

/** 截图结果（剥离内联图片标签后解析；图像已全量下发，手机端暂不渲染）。 */
type CuShot = {
  /** 结果中存在图像（随 result 全量下发，手机端暂只展示占位）。 */
  hasImage: boolean;
  /** 模型收到的坐标映射说明。 */
  mapping: string;
  error: string;
  display?: number;
  imageSize?: string;
  scale?: number;
  cursorX?: number;
  cursorY?: number;
  region?: string;
};

const cuRegionText = (region: JsonRecord): string => {
  const x = cuNumber(region, "x");
  const y = cuNumber(region, "y");
  const width = cuNumber(region, "width");
  const height = cuNumber(region, "height");
  if (
    x === undefined &&
    y === undefined &&
    width === undefined &&
    height === undefined
  ) {
    return "";
  }
  return `${x ?? "?"}, ${y ?? "?"} · ${width ?? "?"} × ${height ?? "?"}`;
};

const cuScreenshot = (raw: string): CuShot | null => {
  const hasImageTag = raw.includes("@@image:");
  const record = parseJsonRecord(raw.replace(INLINE_IMAGE_TAG_RE, "").trim());
  if (!record) return null;

  const blocks = Array.isArray(record.content)
    ? record.content.filter(isRecord)
    : [];
  const imageBlock = blocks.find((block) => block.type === "image");
  const textBlock = blocks.find((block) => block.type === "text");
  const size = isRecord(record.imageSize) ? record.imageSize : null;
  const cursor = isRecord(record.cursor) ? record.cursor : null;
  const region = isRecord(record.region) ? record.region : null;
  const width = size ? cuNumber(size, "width") : undefined;
  const height = size ? cuNumber(size, "height") : undefined;
  const mappingText =
    textBlock && typeof textBlock.text === "string"
      ? stripControl(textBlock.text)
      : "";

  return {
    hasImage: hasImageTag || Boolean(imageBlock),
    mapping: mappingText,
    error: cuString(record, "error").trim(),
    display: cuNumber(record, "display"),
    imageSize:
      width !== undefined && height !== undefined
        ? `${width} × ${height}`
        : undefined,
    scale: cuNumber(record, "pixelToScreenScale"),
    cursorX: cursor ? cuNumber(cursor, "x") : undefined,
    cursorY: cursor ? cuNumber(cursor, "y") : undefined,
    region: region ? cuRegionText(region) : undefined,
  };
};

export const renderComputerUseCard: ToolCallRenderer = (tool) => {
  const action = CU_ACTIONS[tool.name.slice("computer-use-".length)];
  if (!action) return null;

  const argsRecord = parseJsonRecord(tool.arguments);
  const argsText = (tool.arguments ?? "").trim();
  if (!argsRecord && !argsText && !tool.result) return null;

  const isScreenshot = action === "screenshot";
  const isRunning = tool.status === "running";
  const shot = isScreenshot && tool.result ? cuScreenshot(tool.result) : null;
  const resultRecord =
    isScreenshot || !tool.result
      ? null
      : parseJsonRecord(tool.result.replace(INLINE_IMAGE_TAG_RE, "").trim());
  const errorMessage = isScreenshot
    ? (shot?.error ?? "")
    : resultRecord
      ? cuString(resultRecord, "error").trim()
      : "";

  const meta: Node[] = [];
  if (shot?.imageSize) meta.push(tcBadge(shot.imageSize));
  if (shot?.scale !== undefined) {
    meta.push(
      tcBadge(
        `${t("remote.toolCall.exec.cu.scale")} ${shot.scale.toFixed(4)}`,
        "muted",
      ),
    );
  }
  const steps =
    argsRecord && Array.isArray(argsRecord.actions)
      ? argsRecord.actions.length
      : 0;
  if (steps > 0) {
    meta.push(tcBadge(t("remote.toolCall.exec.cu.steps", { count: steps })));
  }

  const body = document.createDocumentFragment();
  body.append(
    argsRecord
      ? tcSection(t("remote.toolCall.exec.args"), tcPre(formatJson(argsRecord)))
      : rawArgsSection(tool.arguments),
  );

  if (isScreenshot) {
    if (shot) {
      // 图像数据随结果全量下发，手机端暂不渲染：只给占位与元数据。
      const section = el("div", "tc-exec-shot");
      if (shot.hasImage) {
        section.append(
          noteRow(t("remote.toolCall.exec.cu.imageUnavailable"), "muted"),
        );
      } else if (!shot.error && tool.status === "completed") {
        section.append(noteRow(t("remote.toolCall.exec.cu.noImage"), "muted"));
      }
      const rows = el("div", "tc-exec-params");
      if (shot.display !== undefined) {
        rows.append(
          tcKv(t("remote.toolCall.exec.cu.display"), String(shot.display)),
        );
      }
      if (shot.region) {
        rows.append(tcKv(t("remote.toolCall.exec.cu.region"), shot.region));
      }
      if (shot.cursorX !== undefined && shot.cursorY !== undefined) {
        rows.append(
          tcKv(
            t("remote.toolCall.exec.cu.cursor"),
            `(${shot.cursorX}, ${shot.cursorY})`,
          ),
        );
      }
      if (rows.childNodes.length > 0) section.append(rows);
      if (section.childNodes.length > 0) {
        body.append(
          tcSection(t("remote.toolCall.exec.cu.screenshot"), section, {
            icon: "image",
          }),
        );
      }
      if (shot.mapping) {
        body.append(
          tcSection(
            t("remote.toolCall.exec.cu.mapping"),
            outputBlock(shot.mapping),
          ),
        );
      }
      if (shot.error) body.append(tcErrorRow(shot.error));
    } else if (tool.result) {
      body.append(noteRow(t("remote.toolCall.exec.cu.noImage"), "muted"));
      body.append(
        tcSection(
          t("remote.toolCall.exec.result"),
          outputBlock(stripControl(tool.result)),
        ),
      );
    }
  } else if (errorMessage) {
    body.append(tcErrorRow(errorMessage));
  } else if (resultRecord) {
    body.append(
      tcSection(
        t("remote.toolCall.exec.result"),
        tcPre(formatJson(resultRecord)),
      ),
    );
  } else if (tool.result) {
    body.append(
      tcSection(
        t("remote.toolCall.exec.result"),
        outputBlock(stripControl(tool.result)),
      ),
    );
  }

  if (isRunning)
    body.append(liveRow(t("remote.toolCall.exec.cu.running"), true));
  if (tool.status === "pending" && !tool.result) {
    body.append(noteRow(t("remote.toolCall.exec.cu.waiting"), "muted"));
  }

  return createToolNode({
    tool,
    status: errorMessage ? "error" : tool.status,
    badge: t(`remote.toolCall.exec.cu.action.${action}`),
    display: cuSummary(tool.name.slice("computer-use-".length), argsRecord),
    meta,
    bodyClass: "tc-exec",
    body,
  });
};

// ── 注册表 ───────────────────────────────────────────────────────────────

export const execModule: ToolModule = {
  renderers: {
    "bash-terminal-execute": renderBashCard,
  },
  prefixes: [
    { prefix: "terminal-", render: renderTerminalCard },
    { prefix: "computer-use-", render: renderComputerUseCard },
  ],
};
