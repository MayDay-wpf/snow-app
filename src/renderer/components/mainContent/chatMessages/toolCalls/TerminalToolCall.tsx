import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Check,
  Clock,
  Columns3,
  Keyboard,
  List,
  Maximize2,
  TerminalSquare,
  Timer,
  X,
} from "lucide-react";
import { useI18n } from "../../../../i18n";
import type { ToolCallInfo } from "../utils/conversationTypes";
import { ToolCallNode } from "./shared/ToolCallNode";
import { localizeToolError } from "./shared/toolErrorDisplay";

type TerminalToolCallProps = {
  toolCall: ToolCallInfo;
};

/** Reusable type for the i18n `t` function, matching TranslateOptions. */
type TFunc = ReturnType<typeof useI18n>["t"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 操作名：terminal-manage 取 args.action；历史记录中的旧工具名取后缀。 */
const parseOperation = (toolName: string, args: string): string => {
  if (toolName === "terminal-manage") {
    try {
      const parsed: unknown = JSON.parse(args);
      if (isRecord(parsed) && typeof parsed.action === "string") {
        return parsed.action.trim();
      }
    } catch {
      // 参数流式未完成时回退
    }
    return "manage";
  }
  const match = toolName.match(/^terminal-(\w+)$/);
  return match ? match[1] : toolName;
};

type ParsedArgs = {
  tabId?: string;
  cwd?: string;
  shellPath?: string;
  input?: string;
  keys?: string[];
  waitMs?: number;
  cols?: number;
  rows?: number;
  timeoutMs?: number;
  idleMs?: number;
};

type ParsedResult =
  | { type: "success"; data: Record<string, unknown> }
  | { type: "error"; message: string }
  | { type: "raw"; text: string }
  | { type: "empty" };

const parseArgs = (args: string): ParsedArgs => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    return {};
  }
  if (!isRecord(parsed)) {
    return {};
  }
  return {
    tabId: typeof parsed.tabId === "string" ? parsed.tabId : undefined,
    cwd: typeof parsed.cwd === "string" ? parsed.cwd : undefined,
    shellPath:
      typeof parsed.shellPath === "string" ? parsed.shellPath : undefined,
    input: typeof parsed.input === "string" ? parsed.input : undefined,
    keys: Array.isArray(parsed.keys)
      ? parsed.keys.filter((key): key is string => typeof key === "string")
      : undefined,
    waitMs: typeof parsed.waitMs === "number" ? parsed.waitMs : undefined,
    cols: typeof parsed.cols === "number" ? parsed.cols : undefined,
    rows: typeof parsed.rows === "number" ? parsed.rows : undefined,
    timeoutMs:
      typeof parsed.timeoutMs === "number" ? parsed.timeoutMs : undefined,
    idleMs: typeof parsed.idleMs === "number" ? parsed.idleMs : undefined,
  };
};

const parseResult = (result: string | undefined): ParsedResult => {
  if (!result) {
    return { type: "empty" };
  }
  try {
    const parsed: unknown = JSON.parse(result);
    if (!isRecord(parsed)) {
      return { type: "raw", text: result };
    }
    if (typeof parsed.error === "string") {
      return { type: "error", message: parsed.error };
    }
    return { type: "success", data: parsed };
  } catch {
    return { type: "raw", text: result };
  }
};

/** Truncate a tabId for compact display in the header. */
const shortTabId = (tabId: string): string => {
  if (tabId.length <= 20) {
    return tabId;
  }
  return `${tabId.slice(0, 12)}…${tabId.slice(-6)}`;
};

export const TerminalToolCall = ({
  toolCall,
}: TerminalToolCallProps): React.JSX.Element => {
  const { t } = useI18n();
  const operation = parseOperation(toolCall.name, toolCall.arguments);
  const parsedArgs = useMemo(
    () => parseArgs(toolCall.arguments),
    [toolCall.arguments],
  );
  const parsedResult = useMemo(
    () => parseResult(toolCall.result),
    [toolCall.result],
  );

  const hasError = parsedResult.type === "error";
  const effectiveStatus = hasError ? "error" : toolCall.status;
  const isRunning = toolCall.status === "running";
  const startedAt = toolCall.startedAt;

  const countdownTimeoutMs =
    operation === "wait"
      ? (parsedArgs.timeoutMs ?? 30000)
      : operation === "read"
        ? (parsedArgs.waitMs ?? 0)
        : 0;

  const [remainingMs, setRemainingMs] = useState<number | null>(null);
  useEffect(() => {
    if (!isRunning || !startedAt || countdownTimeoutMs <= 0) {
      setRemainingMs(null);
      return;
    }
    const update = () => {
      const elapsed = Date.now() - startedAt;
      setRemainingMs(Math.max(0, countdownTimeoutMs - elapsed));
    };
    update();
    const interval = setInterval(update, 200);
    return () => clearInterval(interval);
  }, [isRunning, startedAt, countdownTimeoutMs]);

  const countdownSeconds =
    remainingMs !== null ? Math.ceil(remainingMs / 1000) : null;

  // Build header badge name and display name based on operation
  const badgeName = t(`toolCall.terminal.op.${operation}`);
  const displayName = (() => {
    switch (operation) {
      case "open":
        return (
          parsedArgs.cwd ||
          parsedArgs.shellPath ||
          t("toolCall.terminal.newTab")
        );
      case "send":
        if (parsedArgs.keys?.length) {
          return parsedArgs.keys.join(" ").slice(0, 60);
        }
        return parsedArgs.input
          ? parsedArgs.input.replace(/\n/g, "↵").slice(0, 60)
          : undefined;
      case "read":
      case "wait":
      case "resize":
      case "close":
      case "focus":
        return parsedArgs.tabId ? shortTabId(parsedArgs.tabId) : undefined;
      case "list":
        return undefined;
      default:
        return undefined;
    }
  })();

  // Build meta badges
  const meta = (
    <>
      {operation === "resize" && parsedArgs.cols && parsedArgs.rows ? (
        <span className="tool-call-terminal-meta-badge">
          <Columns3 size={11} aria-hidden="true" />
          {parsedArgs.cols}×{parsedArgs.rows}
        </span>
      ) : null}
      {operation === "wait" ? (
        <span className="tool-call-terminal-meta-badge">
          <Clock size={11} aria-hidden="true" />
          {parsedArgs.timeoutMs
            ? `${Math.round(parsedArgs.timeoutMs / 1000)}s`
            : "30s"}
        </span>
      ) : null}
      {operation === "read" && parsedArgs.waitMs ? (
        <span className="tool-call-terminal-meta-badge">
          <Clock size={11} aria-hidden="true" />
          {parsedArgs.waitMs}ms
        </span>
      ) : null}
      {isRunning && countdownSeconds !== null ? (
        <span
          className={`tool-call-terminal-countdown ${
            countdownSeconds <= 5 ? "tool-call-terminal-countdown-urgent" : ""
          }`}
        >
          <Timer size={12} aria-hidden="true" />
          {t("toolCall.terminal.countdown", {
            values: { seconds: countdownSeconds },
          })}
        </span>
      ) : null}
      {parsedResult.type === "success" && operation === "open" ? (
        <span className="tool-call-terminal-success-badge">
          <Check size={11} aria-hidden="true" />
          {t("toolCall.terminal.opened")}
        </span>
      ) : null}
      {parsedResult.type === "success" && operation === "close" ? (
        <span className="tool-call-terminal-success-badge">
          <Check size={11} aria-hidden="true" />
          {t("toolCall.terminal.closed")}
        </span>
      ) : null}
      {parsedResult.type === "success" && operation === "list" ? (
        <span className="tool-call-terminal-meta-badge">
          <List size={11} aria-hidden="true" />
          {typeof parsedResult.data.totalTabs === "number"
            ? parsedResult.data.totalTabs
            : 0}
        </span>
      ) : null}
    </>
  );

  // Operation-specific icon in header
  const OpIcon = (() => {
    switch (operation) {
      case "open":
        return Maximize2;
      case "close":
        return X;
      case "list":
        return List;
      default:
        return TerminalSquare;
    }
  })();

  return (
    <ToolCallNode
      toolName={toolCall.name}
      badgeName={badgeName}
      category="terminal"
      displayName={
        displayName ? (
          <span className="tool-call-terminal-displayname">
            <OpIcon
              size={10}
              className="tool-call-terminal-displayname-icon"
              aria-hidden="true"
            />
            <code>{displayName}</code>
          </span>
        ) : undefined
      }
      status={effectiveStatus}
      meta={meta}
      className="tool-call-terminal"
    >
      <div className="tool-call-body tool-call-terminal-body">
        {/* Error display */}
        {parsedResult.type === "error" ? (
          <div className="tool-call-error">
            <AlertCircle size={12} aria-hidden="true" />
            <span>{localizeToolError(t, parsedResult.message)}</span>
          </div>
        ) : null}

        {/* Arguments display (operation-specific) */}
        <TerminalArgsDisplay operation={operation} args={parsedArgs} t={t} />

        {/* Result display (operation-specific) */}
        {parsedResult.type === "success" ? (
          <TerminalResultDisplay
            operation={operation}
            data={parsedResult.data}
            t={t}
          />
        ) : null}

        {parsedResult.type === "raw" ? (
          <div className="tool-call-section">
            <span className="tool-call-section-label">
              {t("toolCall.common.result")}
            </span>
            <pre className="tool-call-section-pre">{parsedResult.text}</pre>
          </div>
        ) : null}

        {/* Running / pending empty state */}
        {parsedResult.type === "empty" ? (
          <div
            className={`tool-call-terminal-pending ${
              isRunning ? "tool-call-terminal-pending-running" : ""
            }`}
          >
            {isRunning ? null : <AlertCircle size={12} aria-hidden="true" />}
            <span>
              {isRunning
                ? t("toolCall.terminal.executing")
                : t("toolCall.terminal.waiting")}
            </span>
            {isRunning ? (
              <span
                className="tool-call-terminal-loading-dots"
                aria-hidden="true"
              >
                <i />
                <i />
                <i />
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </ToolCallNode>
  );
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** 终端等待输入徽章：read/wait 结果检测到终端正在等待输入时显示，
 *  提示用户当前需要提供什么输入，避免误以为 Agent 卡住。 */
const AwaitingInputBadge = ({
  hint,
  t,
}: {
  hint: string;
  t: TFunc;
}): React.JSX.Element => (
  <div className="tool-call-terminal-awaiting">
    <Keyboard size={11} aria-hidden="true" />
    <span>{t("toolCall.terminal.awaitingInput")}</span>
    {hint ? (
      <code className="tool-call-terminal-awaiting-hint">{hint}</code>
    ) : null}
  </div>
);

type TerminalArgsDisplayProps = {
  operation: string;
  args: ParsedArgs;
  t: TFunc;
};

const TerminalArgsDisplay = ({
  operation,
  args,
  t,
}: TerminalArgsDisplayProps): React.JSX.Element | null => {
  switch (operation) {
    case "open": {
      return (
        <div className="tool-call-terminal-args">
          {args.cwd ? (
            <div className="tool-call-terminal-arg-row">
              <span className="tool-call-terminal-arg-label">
                {t("toolCall.terminal.cwd")}
              </span>
              <code className="tool-call-terminal-arg-value">{args.cwd}</code>
            </div>
          ) : null}
          {args.shellPath ? (
            <div className="tool-call-terminal-arg-row">
              <span className="tool-call-terminal-arg-label">
                {t("toolCall.terminal.shellPath")}
              </span>
              <code className="tool-call-terminal-arg-value">
                {args.shellPath}
              </code>
            </div>
          ) : null}
        </div>
      );
    }

    case "send": {
      if (!args.input && !args.keys?.length) {
        return null;
      }
      return (
        <div className="tool-call-terminal-args">
          {args.tabId ? (
            <div className="tool-call-terminal-arg-row">
              <span className="tool-call-terminal-arg-label">tabId</span>
              <code className="tool-call-terminal-arg-value">
                {shortTabId(args.tabId)}
              </code>
            </div>
          ) : null}
          {args.keys?.length ? (
            <div className="tool-call-terminal-arg-row">
              <span className="tool-call-terminal-arg-label">keys</span>
              <span className="tool-call-terminal-keys">
                {args.keys.map((key, index) => (
                  <code key={index} className="tool-call-terminal-key-chip">
                    {key}
                  </code>
                ))}
              </span>
            </div>
          ) : (
            <div className="tool-call-terminal-arg-row">
              <span className="tool-call-terminal-arg-label">
                {t("toolCall.terminal.input")}
              </span>
              <pre className="tool-call-terminal-input-pre">
                <span className="tool-call-terminal-prompt" aria-hidden="true">
                  {">"}
                </span>
                <code>{args.input}</code>
              </pre>
            </div>
          )}
        </div>
      );
    }

    case "read": {
      return (
        <div className="tool-call-terminal-args">
          {args.tabId ? (
            <div className="tool-call-terminal-arg-row">
              <span className="tool-call-terminal-arg-label">tabId</span>
              <code className="tool-call-terminal-arg-value">
                {shortTabId(args.tabId)}
              </code>
            </div>
          ) : null}
          {args.waitMs ? (
            <div className="tool-call-terminal-arg-row">
              <span className="tool-call-terminal-arg-label">waitMs</span>
              <code className="tool-call-terminal-arg-value">
                {args.waitMs}ms
              </code>
            </div>
          ) : null}
        </div>
      );
    }

    case "resize": {
      return (
        <div className="tool-call-terminal-args">
          {args.tabId ? (
            <div className="tool-call-terminal-arg-row">
              <span className="tool-call-terminal-arg-label">tabId</span>
              <code className="tool-call-terminal-arg-value">
                {shortTabId(args.tabId)}
              </code>
            </div>
          ) : null}
          <div className="tool-call-terminal-arg-row">
            <span className="tool-call-terminal-arg-label">cols × rows</span>
            <code className="tool-call-terminal-arg-value">
              {args.cols ?? 80} × {args.rows ?? 24}
            </code>
          </div>
        </div>
      );
    }

    case "wait": {
      return (
        <div className="tool-call-terminal-args">
          {args.tabId ? (
            <div className="tool-call-terminal-arg-row">
              <span className="tool-call-terminal-arg-label">tabId</span>
              <code className="tool-call-terminal-arg-value">
                {shortTabId(args.tabId)}
              </code>
            </div>
          ) : null}
          {args.timeoutMs ? (
            <div className="tool-call-terminal-arg-row">
              <span className="tool-call-terminal-arg-label">timeoutMs</span>
              <code className="tool-call-terminal-arg-value">
                {args.timeoutMs}ms
              </code>
            </div>
          ) : null}
          {args.idleMs ? (
            <div className="tool-call-terminal-arg-row">
              <span className="tool-call-terminal-arg-label">idleMs</span>
              <code className="tool-call-terminal-arg-value">
                {args.idleMs}ms
              </code>
            </div>
          ) : null}
        </div>
      );
    }

    case "close":
    case "focus": {
      return args.tabId ? (
        <div className="tool-call-terminal-args">
          <div className="tool-call-terminal-arg-row">
            <span className="tool-call-terminal-arg-label">tabId</span>
            <code className="tool-call-terminal-arg-value">
              {shortTabId(args.tabId)}
            </code>
          </div>
        </div>
      ) : null;
    }

    case "list":
    default:
      return null;
  }
};

type TerminalResultDisplayProps = {
  operation: string;
  data: Record<string, unknown>;
  t: TFunc;
};

const TerminalResultDisplay = ({
  operation,
  data,
  t,
}: TerminalResultDisplayProps): React.JSX.Element | null => {
  switch (operation) {
    case "open": {
      const tabId = typeof data.tabId === "string" ? data.tabId : "";
      return (
        <div className="tool-call-terminal-result">
          <div className="tool-call-terminal-result-row">
            <span className="tool-call-terminal-arg-label">tabId</span>
            <code className="tool-call-terminal-arg-value">{tabId}</code>
          </div>
        </div>
      );
    }

    case "send": {
      const length = typeof data.length === "number" ? data.length : 0;
      return (
        <div className="tool-call-terminal-result">
          <span className="tool-call-terminal-result-ok">
            <Check size={11} aria-hidden="true" />
            {t("toolCall.terminal.sentBytes", { values: { length } })}
          </span>
        </div>
      );
    }

    case "read": {
      const text = typeof data.text === "string" ? data.text : "";
      const awaitingInput = data.awaitingInput === true;
      const inputHint =
        typeof data.inputHint === "string" ? data.inputHint : "";
      return (
        <div className="tool-call-terminal-result">
          {awaitingInput ? <AwaitingInputBadge hint={inputHint} t={t} /> : null}
          <pre className="tool-call-terminal-output-pre">{text}</pre>
        </div>
      );
    }

    case "wait": {
      // 优先使用增量 text 字段；兼容旧返回中的 afterText。
      const text =
        typeof data.text === "string"
          ? data.text
          : typeof data.afterText === "string"
            ? data.afterText
            : "";
      const idle = data.idle === true;
      const elapsedMs = typeof data.elapsedMs === "number" ? data.elapsedMs : 0;
      const awaitingInput = data.awaitingInput === true;
      const inputHint =
        typeof data.inputHint === "string" ? data.inputHint : "";
      return (
        <div className="tool-call-terminal-result">
          <div className="tool-call-terminal-result-row">
            <span
              className={`tool-call-terminal-wait-status ${
                idle
                  ? "tool-call-terminal-wait-idle"
                  : "tool-call-terminal-wait-timeout"
              }`}
            >
              {idle
                ? t("toolCall.terminal.idle")
                : t("toolCall.terminal.timedOut")}
            </span>
            <span className="tool-call-terminal-elapsed">
              {t("toolCall.terminal.elapsed", {
                values: { ms: Math.round(elapsedMs) },
              })}
            </span>
          </div>
          {awaitingInput ? <AwaitingInputBadge hint={inputHint} t={t} /> : null}
          {text ? (
            <pre className="tool-call-terminal-output-pre">{text}</pre>
          ) : null}
        </div>
      );
    }
    case "resize": {
      const cols = typeof data.cols === "number" ? data.cols : 0;
      const rows = typeof data.rows === "number" ? data.rows : 0;
      return (
        <div className="tool-call-terminal-result">
          <span className="tool-call-terminal-result-ok">
            <Check size={11} aria-hidden="true" />
            {cols}×{rows}
          </span>
        </div>
      );
    }

    case "close": {
      return (
        <div className="tool-call-terminal-result">
          <span className="tool-call-terminal-result-ok">
            <Check size={11} aria-hidden="true" />
            {t("toolCall.terminal.closed")}
          </span>
        </div>
      );
    }

    case "focus": {
      return (
        <div className="tool-call-terminal-result">
          <span className="tool-call-terminal-result-ok">
            <Check size={11} aria-hidden="true" />
            {t("toolCall.terminal.focused")}
          </span>
        </div>
      );
    }

    case "list": {
      const tabs = Array.isArray(data.tabs) ? data.tabs : [];
      if (tabs.length === 0) {
        return (
          <div className="tool-call-terminal-result">
            <span className="tool-call-terminal-result-empty">
              {t("toolCall.terminal.noTabs")}
            </span>
          </div>
        );
      }
      return (
        <div className="tool-call-terminal-result">
          <div className="tool-call-terminal-tab-list">
            {tabs.map((tab, index) => {
              if (!isRecord(tab)) {
                return null;
              }
              const tabId =
                typeof tab.tabId === "string" ? tab.tabId : `#${index}`;
              const title = typeof tab.title === "string" ? tab.title : "";
              const cwd = typeof tab.cwd === "string" ? tab.cwd : "";
              const isActive = tab.isActive === true;
              return (
                <div
                  key={tabId}
                  className={`tool-call-terminal-tab-item ${
                    isActive ? "tool-call-terminal-tab-active" : ""
                  }`}
                >
                  <span className="tool-call-terminal-tab-id">
                    {shortTabId(tabId)}
                  </span>
                  <span className="tool-call-terminal-tab-title">{title}</span>
                  {cwd ? (
                    <span className="tool-call-terminal-tab-cwd">{cwd}</span>
                  ) : null}
                  {isActive ? (
                    <span className="tool-call-terminal-tab-active-badge">
                      {t("toolCall.terminal.active")}
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      );
    }

    default:
      return null;
  }
};
