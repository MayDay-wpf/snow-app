import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertCircle,
  Check,
  Copy,
  CornerDownLeft,
  FileText,
  Info,
  Send,
  ShieldAlert,
  ShieldCheck,
  Square,
  Timer,
} from "lucide-react";
import { Tooltip } from "../../../common/Tooltip";
import { useI18n } from "../../../../i18n";
import { updateFirstMatchingToolCall } from "../utils/conversationHelpers";
import type {
  ConversationContextValue,
  ToolCallInfo,
} from "../utils/conversationTypes";
import { ToolCallNode } from "./shared/ToolCallNode";
import { AnsiOutput } from "./shared/AnsiOutput";
import { localizeToolError } from "./shared/toolErrorDisplay";
import { SensitiveCommandSeverityBadge } from "./shared/SensitiveCommandSeverityBadge";
import { SensitiveCommandContextNote } from "./shared/SensitiveCommandContextNote";
import { rightPanelEvents } from "../../../rightPanel/rightPanelEvents";

type BashToolCallProps = {
  toolCall: ToolCallInfo;
  /** 该调用所在会话的 id（看门狗本地收口时回写消息状态用）。 */
  conversationId?: string;
  /** 该调用所在助手消息的 id（同上）。 */
  messageId?: string;
  /** 会话消息更新函数（来自 ChatConversationProvider）。 */
  updateSessionMessages?: ConversationContextValue["updateSessionMessages"];
};

type ParsedBashArgs = {
  command: string;
  description?: string;
  workingDirectory: string;
  timeout?: number;
  isInteractive?: boolean;
  detach?: boolean;
};

type ParsedBashResult =
  | {
      type: "success";
      output: string;
      exitCode: number;
    }
  | { type: "timeout"; message: string; output: string }
  | { type: "cancelled"; message: string; output: string }
  | { type: "error"; message: string; output: string }
  | { type: "detached"; pid: number; logPath: string; taskId: string | null }
  | { type: "raw"; text: string }
  | { type: "empty" };

const DEFAULT_TIMEOUT_MS = 30000;

/** 终止二次确认的自动收起时限：首次点击后若未在此时限内再次点击，确认态
 *  自动失效（命令不受影响），避免按钮长时间停留在「确认终止」状态被误点。 */
const KILL_CONFIRM_TIMEOUT_MS = 4000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseArgs = (args: string): ParsedBashArgs | null => {
  try {
    const parsed: unknown = JSON.parse(args);
    // 只有 command 是必需字段：workingDirectory 允许缺省（Rust 侧
    // default_bash_working_directory 会兜底为当前项目工作区）。若在此强制
    // 要求它，整个解析会失败，头部与命令体一起退回 "terminal-execute"
    // 占位符，模型写好的 description 也随之丢失。
    if (!isRecord(parsed) || typeof parsed.command !== "string") {
      return null;
    }
    const timeout =
      typeof parsed.timeout === "number" && parsed.timeout > 0
        ? parsed.timeout
        : undefined;
    const isInteractive =
      typeof parsed.isInteractive === "boolean"
        ? parsed.isInteractive
        : undefined;
    const detach =
      typeof parsed.detach === "boolean" ? parsed.detach : undefined;
    return {
      command: parsed.command,
      description:
        typeof parsed.description === "string" && parsed.description.trim()
          ? parsed.description
          : undefined,
      workingDirectory:
        typeof parsed.workingDirectory === "string"
          ? parsed.workingDirectory
          : "",
      timeout,
      isInteractive,
      detach,
    };
  } catch {
    return null;
  }
};

const joinOutput = (stdout: string, stderr: string): string => {
  const parts: string[] = [];
  if (stdout) parts.push(stdout);
  if (stderr) parts.push(stderr);
  return parts.join("\n");
};

const isTimeoutMessage = (message: string): boolean =>
  /timed?\s*out/i.test(message);

const parseResult = (result: string | undefined): ParsedBashResult => {
  if (!result) {
    return { type: "empty" };
  }

  try {
    const parsed: unknown = JSON.parse(result);
    if (!isRecord(parsed)) {
      return { type: "raw", text: result };
    }

    // Detached (background) execution: the call returned immediately with
    // { detached: true, pid, logPath } and the process keeps running.
    if (parsed.detached === true) {
      return {
        type: "detached",
        pid: typeof parsed.pid === "number" ? parsed.pid : 0,
        logPath: typeof parsed.logPath === "string" ? parsed.logPath : "",
        taskId:
          typeof parsed.taskId === "string" && parsed.taskId.trim()
            ? parsed.taskId
            : null,
      };
    }

    const stdout =
      typeof parsed.stdout === "string" ? (parsed.stdout as string) : "";
    const stderr =
      typeof parsed.stderr === "string" ? (parsed.stderr as string) : "";
    const partialOutput = joinOutput(stdout, stderr);
    const errorMessage =
      typeof parsed.error === "string" ? parsed.error : undefined;

    // Structured terminal statuses from the backend: completed / timed_out /
    // cancelled / failed / spawn_failed. timed_out covers both the backend
    // deadline (reason "timeout") and the renderer countdown watchdog
    // (reason "watchdog_timeout") — neither is a user cancellation.
    if (typeof parsed.status === "string") {
      switch (parsed.status) {
        case "completed":
          if (typeof parsed.exitCode === "number") {
            return {
              type: "success",
              output: partialOutput,
              exitCode: parsed.exitCode,
            };
          }
          break;
        case "timed_out":
          return {
            type: "timeout",
            message: errorMessage ?? "Command timed out",
            output: partialOutput,
          };
        case "cancelled":
          return {
            type: "cancelled",
            message: errorMessage ?? "Command was stopped",
            output: partialOutput,
          };
        case "failed":
        case "spawn_failed":
          return {
            type: "error",
            message: errorMessage ?? "Command failed",
            output: partialOutput,
          };
        default:
          break;
      }
    }

    // Legacy results persisted before structured statuses existed.
    if (errorMessage !== undefined) {
      if (isTimeoutMessage(errorMessage)) {
        return {
          type: "timeout",
          message: errorMessage,
          output: partialOutput,
        };
      }
      return { type: "error", message: errorMessage, output: partialOutput };
    }

    if (
      typeof parsed.stdout === "string" &&
      typeof parsed.stderr === "string" &&
      typeof parsed.exitCode === "number" &&
      Number.isInteger(parsed.exitCode)
    ) {
      return {
        type: "success",
        output: joinOutput(parsed.stdout, parsed.stderr),
        exitCode: parsed.exitCode,
      };
    }

    return { type: "raw", text: result };
  } catch {
    return { type: "raw", text: result };
  }
};
const getCommandSummary = (command: string): string =>
  command.trim().split(/\r?\n/, 1)[0] ?? "";

export const BashToolCall = ({
  toolCall,
  conversationId,
  messageId,
  updateSessionMessages,
}: BashToolCallProps): React.JSX.Element => {
  const { t } = useI18n();
  const parsedArgs = useMemo(
    () => parseArgs(toolCall.arguments),
    [toolCall.arguments],
  );
  const parsedResult = useMemo(
    () => parseResult(toolCall.result),
    [toolCall.result],
  );

  const command = parsedArgs?.command ?? "terminal-execute";
  const commandSummary = getCommandSummary(command) || "terminal-execute";
  const hasFailed =
    parsedResult.type === "error" ||
    parsedResult.type === "timeout" ||
    parsedResult.type === "cancelled" ||
    (parsedResult.type === "success" && parsedResult.exitCode !== 0);
  const effectiveStatus = hasFailed ? "error" : toolCall.status;

  const isRunning = toolCall.status === "running";
  const [cmdCopied, setCmdCopied] = useState(false);
  const timeoutMs = parsedArgs?.timeout ?? DEFAULT_TIMEOUT_MS;
  const startedAt = toolCall.startedAt;
  const isInteractive = parsedArgs?.isInteractive === true;
  const interactiveSessionId = toolCall.interactiveSessionId;
  const toolExecutionId = toolCall.toolExecutionId;
  const canSendInput =
    isInteractive && isRunning && Boolean(interactiveSessionId);

  // Live countdown: ticks every 200ms while running so the user can
  // see how much time is left before the command is killed.
  // Interactive commands have no meaningful countdown, so we skip it.
  // Detached commands ignore the timeout entirely (the call returns
  // immediately), so a countdown would be misleading — skip it too.
  const [remainingMs, setRemainingMs] = useState<number | null>(null);
  useEffect(() => {
    if (!isRunning || !startedAt || isInteractive || parsedArgs?.detach) {
      setRemainingMs(null);
      return;
    }
    const update = () => {
      const elapsed = Date.now() - startedAt;
      setRemainingMs(Math.max(0, timeoutMs - elapsed));
    };
    update();
    const interval = setInterval(update, 200);
    return () => clearInterval(interval);
  }, [isRunning, startedAt, timeoutMs, isInteractive, parsedArgs?.detach]);

  const countdownSeconds =
    remainingMs !== null ? Math.ceil(remainingMs / 1000) : null;

  // Interactive input state
  const [inputValue, setInputValue] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 空输入（含纯空白）发送的是纯回车键，等价于在真实终端里敲回车，
  // 用于 input()/pause 这类只等回车的交互式命令；按钮图标随之切换。
  const isInputBlank = inputValue.trim().length === 0;

  // Auto-focus the input when the interactive session becomes available
  useEffect(() => {
    if (canSendInput && inputRef.current) {
      inputRef.current.focus();
    }
  }, [canSendInput]);

  const handleSendInput = useCallback(async () => {
    if (!interactiveSessionId || isSending) {
      return;
    }
    setIsSending(true);
    setSendError(null);
    try {
      await window.snow.writeInteractiveStdin(
        interactiveSessionId,
        `${inputValue}\n`,
      );
      setInputValue("");
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSending(false);
    }
  }, [interactiveSessionId, inputValue, isSending]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      // When the user is composing text with an IME (e.g. Chinese Pinyin
      // candidate selection), Enter confirms the candidate — it must NOT
      // submit the input.  isComposing is true during composition.
      if (e.nativeEvent.isComposing || e.keyCode === 229) {
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void handleSendInput();
      }
    },
    [handleSendInput],
  );

  // Manual and automatic termination share one guarded path. The backend
  // performs the actual process-tree kill; this state only prevents duplicate
  // IPC requests and keeps the button in its stopping state until the tool
  // execution has reached a terminal status.
  const [isKilling, setIsKilling] = useState(false);
  const isKillRequestedRef = useRef(false);
  // 终止二次确认：首次点击只进入确认态并展开确认 tooltip（不结束命令），
  // 确认态下再次点击同一按钮才真正终止。命令结束、超时未确认或点击别处
  // 都会收起确认态，避免用户误以为已终止而命令仍在运行。
  const [isKillConfirmArmed, setIsKillConfirmArmed] = useState(false);
  useEffect(() => {
    if (!isRunning) {
      isKillRequestedRef.current = false;
      setIsKilling(false);
      setIsKillConfirmArmed(false);
    }
  }, [isRunning]);

  // 确认态超时自动收起：只撤销确认，不影响正在运行的命令。
  useEffect(() => {
    if (!isKillConfirmArmed) {
      return;
    }
    const timer = window.setTimeout(
      () => setIsKillConfirmArmed(false),
      KILL_CONFIRM_TIMEOUT_MS,
    );
    return () => window.clearTimeout(timer);
  }, [isKillConfirmArmed]);

  // 点击按钮以外的任意位置时收起确认态（捕获阶段监听；确认 tooltip 自身
  // pointer-events: none，不会成为点击目标）。
  useEffect(() => {
    if (!isKillConfirmArmed) {
      return;
    }
    const handlePointerDown = (event: MouseEvent): void => {
      const target = event.target as Element | null;
      if (target && !target.closest(".tool-call-bash-kill")) {
        setIsKillConfirmArmed(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown, true);
    return () =>
      document.removeEventListener("mousedown", handlePointerDown, true);
  }, [isKillConfirmArmed]);

  // 本地收口：abort 未被后端接受（这次执行已结束或从未注册）或后端始终没下发
  // toolExecutionId 时，真实结果可能永远不会回填这条调用（结果丢失、会话截断后
  // 消息重建等），卡片会永久停在「命令执行中」。这里按已缓冲的流式输出就地把它
  // 结算成 timed_out / cancelled，结构与后端结构化结果对齐；真实结果若已在回填
  // 路上会先落地（状态已终止，这里的更新自然不命中）。
  const settleToolExecutionLocally = useCallback(
    (reason: "user" | "timeout"): void => {
      if (!conversationId || !messageId || !updateSessionMessages) {
        return;
      }
      updateSessionMessages(conversationId, (currentMessages) =>
        currentMessages.map((message) =>
          message.id !== messageId
            ? message
            : {
                ...message,
                toolCalls: updateFirstMatchingToolCall(
                  message.toolCalls,
                  toolCall,
                  ["pending", "running"],
                  (currentToolCall) => ({
                    ...currentToolCall,
                    status: "completed" as const,
                    result: JSON.stringify({
                      status: reason === "timeout" ? "timed_out" : "cancelled",
                      reason:
                        reason === "timeout" ? "watchdog_timeout" : "user",
                      error:
                        reason === "timeout"
                          ? `Command timed out after ${timeoutMs}ms: ${command}`
                          : `Command was stopped by the user: ${command}`,
                      stdout: currentToolCall.streamingStdout ?? "",
                      stderr: currentToolCall.streamingStderr ?? "",
                      exitCode: null,
                      command,
                      interactive: isInteractive,
                      elapsedMs: startedAt ? Date.now() - startedAt : undefined,
                      timeoutMs,
                      outputComplete: false,
                    }),
                  }),
                ),
              },
        ),
      );
    },
    [
      command,
      conversationId,
      isInteractive,
      messageId,
      startedAt,
      timeoutMs,
      toolCall,
      updateSessionMessages,
    ],
  );

  const handleKill = useCallback(
    async (reason: "user" | "timeout" = "user") => {
      if (!toolExecutionId) {
        // 后端从未下发执行 id：没有可中止的目标，直接本地收口。
        settleToolExecutionLocally(reason);
        return;
      }
      if (isKillRequestedRef.current) {
        return;
      }
      isKillRequestedRef.current = true;
      setIsKilling(true);
      try {
        const accepted = await window.snow.abortToolExecution(
          toolExecutionId,
          reason,
        );
        if (!accepted) {
          // The execution may have completed between render and the click. Do
          // not leave the UI permanently stuck in "Stopping…" when there is no
          // longer a cancellation token to signal — settle the call locally
          // instead so the card never stays "running" forever.
          isKillRequestedRef.current = false;
          setIsKilling(false);
          settleToolExecutionLocally(reason);
        }
      } catch {
        // IPC failure is retryable. The agent loop will still surface the actual
        // tool result if the process finished concurrently.
        isKillRequestedRef.current = false;
        setIsKilling(false);
      }
    },
    [settleToolExecutionLocally, toolExecutionId],
  );

  // 按钮点击：未进入确认态时只展开确认 tooltip（命令继续运行），已进入确认
  // 态时才是用户真正的终止意图。watchdog 的自动超时终止不走这条路径。
  const handleKillClick = useCallback((): void => {
    if (!isKillConfirmArmed) {
      setIsKillConfirmArmed(true);
      return;
    }
    setIsKillConfirmArmed(false);
    void handleKill("user");
  }, [handleKill, isKillConfirmArmed]);

  // Renderer-side watchdog: the Rust timeout remains authoritative, but this
  // fail-safe sends a kill request with the explicit "timeout" reason when
  // the countdown reaches zero. The backend records the reason, so a
  // watchdog-triggered abort is reported as a timeout — never as a user
  // cancellation — while covering a delayed/stalled backend timeout path
  // without creating a second termination implementation. When the abort
  // cannot be delivered (no execution id was ever streamed, or the backend no
  // longer holds this execution), the call is settled locally so the card can
  // never stay "running" forever.
  useEffect(() => {
    if (
      !isRunning ||
      remainingMs !== 0 ||
      isInteractive ||
      parsedArgs?.detach ||
      isKillRequestedRef.current
    ) {
      return;
    }
    void handleKill("timeout");
  }, [handleKill, isInteractive, isRunning, parsedArgs?.detach, remainingMs]);

  const output = useMemo(() => {
    if (parsedResult.type === "success") {
      return parsedResult.output;
    }
    if (
      parsedResult.type === "timeout" ||
      parsedResult.type === "cancelled" ||
      parsedResult.type === "error"
    ) {
      return parsedResult.output;
    }
    if (parsedResult.type === "raw") {
      return parsedResult.text;
    }
    return joinOutput(
      toolCall.streamingStdout ?? "",
      toolCall.streamingStderr ?? "",
    );
  }, [parsedResult, toolCall.streamingStdout, toolCall.streamingStderr]);

  const hasOutput = Boolean(output);
  const isEmpty =
    parsedResult.type === "empty" &&
    !toolCall.streamingStdout &&
    !toolCall.streamingStderr;

  const emptyStateLabel = t(
    isRunning
      ? "toolCall.bash.running"
      : toolCall.status === "error"
        ? "toolCall.bash.errorWithoutDetails"
        : "toolCall.bash.waiting",
  );

  // 决策模型判定（托管自动放行/拒绝的命令）：卡片头部给结论与置信度，
  // 卡片内部给完整判定（理由与判定模型）。决策模型不可用（error）时没有
  // 有效判定——回退原因已在拦截提示里展示，卡片不显示放行/拒绝结论。
  const decision = toolCall.sensitiveCommandDecision?.error
    ? undefined
    : toolCall.sensitiveCommandDecision;
  const decisionConfidencePercent = decision
    ? Math.round(decision.confidence * 100)
    : 0;
  const decisionReason = decision
    ? t(`sensitiveCommand.decision.reason.${decision.reason}`, {
        defaultValue: decision.reason,
      })
    : "";
  // 风险等级只在 provider 给出且为已知档位时展示。
  const decisionSeverityLabel =
    decision?.severity && ["low", "medium", "high"].includes(decision.severity)
      ? t("sensitiveCommand.severityBadge", {
          values: {
            level: t(`sensitiveCommand.severity.${decision.severity}`),
          },
        })
      : "";
  // 三种判定结论：模型放行 / 模型拒绝 / 模型拒绝但用户复核后已确认执行。
  const isDenyOverridden = Boolean(
    decision && !decision.allow && toolCall.sensitiveCommandDenyOverridden,
  );
  const decisionVerdictLabel = !decision
    ? ""
    : decision.allow
      ? t("toolCall.bash.decisionAllow", { defaultValue: "决策模型放行" })
      : isDenyOverridden
        ? t("toolCall.bash.decisionDenyOverridden", {
            defaultValue: "模型拒绝，用户已确认",
          })
        : t("toolCall.bash.decisionDeny", { defaultValue: "决策模型拒绝" });

  return (
    <ToolCallNode
      toolName={toolCall.name}
      badgeName={t("toolCall.bash.name")}
      category="terminal"
      displayName={parsedArgs?.description ?? commandSummary}
      displayNameTitle={parsedArgs?.description ? command : undefined}
      status={effectiveStatus}
      defaultOpen={isInteractive && isRunning}
      meta={
        <>
          {isInteractive && (isRunning || canSendInput) ? (
            <span className="tool-call-bash-interactive-badge">
              {t("toolCall.bash.interactive")}
            </span>
          ) : null}
          {decision ? (
            <Tooltip
              placement="top"
              content={
                <>
                  <span className="tool-call-bash-decision-tip-title">
                    {t("toolCall.bash.decisionTitle", {
                      defaultValue: "决策模型判定",
                    })}
                  </span>
                  <span className="tool-call-bash-decision-tip-reason">
                    {decisionReason}
                  </span>
                  {decisionSeverityLabel ? (
                    <span className="tool-call-bash-decision-tip-reason">
                      {decisionSeverityLabel}
                    </span>
                  ) : null}
                  {decision.modelName ? (
                    <span className="tool-call-bash-decision-tip-model">
                      {t("sensitiveCommand.decisionModel", {
                        values: { name: decision.modelName },
                      })}
                    </span>
                  ) : null}
                </>
              }
            >
              <span
                className={`tool-call-bash-decision-badge ${
                  decision.allow
                    ? "tool-call-bash-decision-allow"
                    : isDenyOverridden
                      ? "tool-call-bash-decision-overridden"
                      : "tool-call-bash-decision-deny"
                }`}
              >
                {decision.allow ? (
                  <ShieldCheck size={11} aria-hidden="true" />
                ) : (
                  <ShieldAlert size={11} aria-hidden="true" />
                )}
                {decisionVerdictLabel}
                {decision.confidence > 0 ? (
                  <em>
                    {t("sensitiveCommand.decisionConfidence", {
                      values: { value: decisionConfidencePercent },
                    })}
                  </em>
                ) : null}
              </span>
            </Tooltip>
          ) : null}
          {parsedResult.type === "success" ? (
            <span
              className={`tool-call-bash-exit-code ${
                parsedResult.exitCode === 0
                  ? "tool-call-bash-exit-success"
                  : "tool-call-bash-exit-error"
              }`}
            >
              {t("toolCall.bash.exitCode", {
                values: { code: parsedResult.exitCode },
              })}
            </span>
          ) : null}
          {parsedResult.type === "detached" ? (
            <button
              type="button"
              className="tool-call-bash-detached-badge is-action"
              title={t("toolCall.bash.openInTaskManager", {
                defaultValue: "Open in task manager",
              })}
              onClick={(event) => {
                // 徽章是独立操作入口：不参与卡片开合
                event.stopPropagation();
                rightPanelEvents.emit("focus-background-task", {
                  taskId: parsedResult.taskId,
                  pid: parsedResult.pid,
                });
              }}
            >
              <Activity size={11} aria-hidden="true" />
              {t("toolCall.bash.detached", {
                values: { pid: parsedResult.pid },
              })}
            </button>
          ) : null}
          {parsedResult.type === "timeout" ? (
            <span className="tool-call-bash-timeout-badge">
              {t("toolCall.bash.timeout")}
            </span>
          ) : null}
          {parsedResult.type === "cancelled" ? (
            <span className="tool-call-bash-timeout-badge">
              {t("toolCall.bash.cancelled")}
            </span>
          ) : null}
          {isRunning && countdownSeconds !== null ? (
            <span
              className={`tool-call-bash-countdown ${
                countdownSeconds <= 5 ? "tool-call-bash-countdown-urgent" : ""
              }`}
            >
              <Timer size={12} aria-hidden="true" />
              {t("toolCall.bash.countdown", {
                values: { seconds: countdownSeconds },
              })}
            </span>
          ) : null}
          {isRunning && toolExecutionId ? (
            <Tooltip
              placement="top"
              // 确认态由点击驱动（受控显示）；未进入确认态时回退到组件内部
              // 的 hover 行为，继续展示原有的「终止」说明。
              visible={isKillConfirmArmed ? true : undefined}
              content={
                isKillConfirmArmed ? (
                  <span className="tool-call-bash-kill-confirm">
                    <span className="tool-call-bash-kill-confirm-title">
                      {t("toolCall.bash.killConfirmTitle")}
                    </span>
                    <span className="tool-call-bash-kill-confirm-hint">
                      {t("toolCall.bash.killConfirmHint")}
                    </span>
                  </span>
                ) : (
                  t("toolCall.bash.killTitle")
                )
              }
            >
              <button
                className={`tool-call-bash-kill${
                  isKillConfirmArmed ? " tool-call-bash-kill-armed" : ""
                }`}
                disabled={isKilling}
                // 不冒泡到 summary：点击终止按钮不参与卡片开合，避免二次确认
                // 过程中卡片意外折叠。
                onClick={(event) => {
                  event.stopPropagation();
                  handleKillClick();
                }}
                type="button"
              >
                <Square size={11} aria-hidden="true" />
                {isKilling
                  ? t("toolCall.bash.killing")
                  : isKillConfirmArmed
                    ? t("toolCall.bash.killConfirmAction")
                    : t("toolCall.bash.kill")}
              </button>
            </Tooltip>
          ) : null}
        </>
      }
      className="tool-call-bash"
    >
      <div className="tool-call-body tool-call-bash-body">
        {parsedResult.type === "timeout" ? (
          <div className="tool-call-error tool-call-bash-timeout-notice">
            <AlertCircle size={12} aria-hidden="true" />
            <span>{localizeToolError(t, parsedResult.message)}</span>
          </div>
        ) : null}
        {parsedResult.type === "cancelled" ? (
          <div className="tool-call-error tool-call-bash-timeout-notice">
            <AlertCircle size={12} aria-hidden="true" />
            <span>{localizeToolError(t, parsedResult.message)}</span>
          </div>
        ) : null}
        {parsedResult.type === "error" ? (
          <div className="tool-call-error">
            <AlertCircle size={12} aria-hidden="true" />
            <span>{localizeToolError(t, parsedResult.message)}</span>
          </div>
        ) : null}

        {decision ? (
          <div
            className={`tool-call-bash-decision ${
              decision.allow
                ? "tool-call-bash-decision-is-allow"
                : isDenyOverridden
                  ? "tool-call-bash-decision-is-overridden"
                  : "tool-call-bash-decision-is-deny"
            }`}
          >
            <div className="tool-call-bash-decision-head">
              <span className="tool-call-bash-decision-verdict">
                {decision.allow ? (
                  <ShieldCheck size={13} strokeWidth={2} aria-hidden="true" />
                ) : (
                  <ShieldAlert size={13} strokeWidth={2} aria-hidden="true" />
                )}
                <strong>{decisionVerdictLabel}</strong>
                <SensitiveCommandSeverityBadge
                  severity={decision.severity}
                  severityScore={decision.severityScore}
                />
              </span>
              <span className="tool-call-bash-decision-tag">
                {toolCall.sensitiveCommandDelegated
                  ? t("toolCall.bash.decisionDelegated", {
                      defaultValue: "托管判定",
                    })
                  : t("toolCall.bash.decisionHumanConfirmed", {
                      defaultValue: "人工确认",
                    })}
              </span>
            </div>
            <div className="tool-call-bash-decision-meta">
              {decision.confidence > 0 ? (
                <span>
                  {t("sensitiveCommand.decisionConfidence", {
                    values: { value: decisionConfidencePercent },
                  })}
                </span>
              ) : null}
              {decision.modelName ? (
                <span>
                  {t("sensitiveCommand.decisionModel", {
                    values: { name: decision.modelName },
                  })}
                </span>
              ) : null}
              <SensitiveCommandContextNote decision={decision} />
            </div>
            {decisionReason ? (
              <div className="tool-call-bash-decision-reason">
                {decisionReason}
              </div>
            ) : null}
          </div>
        ) : null}

        <div
          className={`tool-call-bash-terminal ${
            isRunning ? "tool-call-bash-terminal-live" : ""
          } ${isInteractive ? "tool-call-bash-terminal-interactive" : ""}`}
        >
          {parsedArgs?.workingDirectory ? (
            <div className="tool-call-bash-workdir">
              {parsedArgs.workingDirectory}
            </div>
          ) : null}

          {parsedArgs?.description ? (
            <div className="tool-call-bash-description">
              <Info size={12} aria-hidden="true" />
              <span>{parsedArgs.description}</span>
            </div>
          ) : null}

          <pre className="tool-call-bash-command">
            <span className="tool-call-bash-prompt" aria-hidden="true">
              $
            </span>
            <code>{command}</code>
            <button
              type="button"
              className="tool-call-bash-cmd-copy"
              onClick={(e) => {
                e.stopPropagation();
                navigator.clipboard.writeText(command);
                setCmdCopied(true);
                setTimeout(() => setCmdCopied(false), 1500);
              }}
              title={t("common.copy", { defaultValue: "复制命令" })}
            >
              {cmdCopied ? (
                <Check size={11} aria-hidden="true" />
              ) : (
                <Copy size={11} aria-hidden="true" />
              )}
            </button>
          </pre>

          {parsedResult.type === "detached" && parsedResult.logPath ? (
            <div className="tool-call-bash-logpath">
              <FileText size={12} aria-hidden="true" />
              <span>
                {t("toolCall.bash.logPath", {
                  values: { path: parsedResult.logPath },
                })}
              </span>
            </div>
          ) : null}

          {hasOutput ? (
            isRunning ? (
              <pre className="tool-call-bash-output-pre">
                {output}
                <span
                  className="tool-call-bash-stream-cursor"
                  aria-hidden="true"
                />
              </pre>
            ) : (
              <AnsiOutput
                text={output}
                defaultFilterErrors={parsedResult.type === "error"}
              />
            )
          ) : isEmpty ? (
            <div
              className={`tool-call-bash-pending ${
                isRunning ? "tool-call-bash-pending-running" : ""
              }`}
            >
              {isRunning ? null : <AlertCircle size={12} aria-hidden="true" />}
              <span>{emptyStateLabel}</span>
              {isRunning ? (
                <span
                  className="tool-call-bash-loading-dots"
                  aria-hidden="true"
                >
                  <i />
                  <i />
                  <i />
                </span>
              ) : null}
            </div>
          ) : null}

          {canSendInput ? (
            <div className="tool-call-bash-interactive-input-area">
              {sendError ? (
                <div className="tool-call-bash-interactive-error">
                  <AlertCircle size={12} aria-hidden="true" />
                  <span>{sendError}</span>
                </div>
              ) : null}
              <div className="tool-call-bash-interactive-input-row">
                <span className="tool-call-bash-prompt" aria-hidden="true">
                  {">"}
                </span>
                <input
                  ref={inputRef}
                  className="tool-call-bash-interactive-input"
                  disabled={isSending}
                  onChange={(e) => setInputValue(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={t("toolCall.bash.interactivePlaceholder")}
                  type="text"
                  value={inputValue}
                  autoComplete="off"
                  spellCheck={false}
                />
                <button
                  className="tool-call-bash-interactive-send"
                  disabled={isSending}
                  onClick={() => void handleSendInput()}
                  title={
                    isInputBlank
                      ? t("toolCall.bash.interactiveSendEnter", {
                          defaultValue: "Send Return key",
                        })
                      : t("toolCall.bash.interactiveSendInput", {
                          defaultValue: "Send input",
                        })
                  }
                  type="button"
                >
                  {isInputBlank ? (
                    <CornerDownLeft size={13} aria-hidden="true" />
                  ) : (
                    <Send size={13} aria-hidden="true" />
                  )}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </ToolCallNode>
  );
};
