import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertCircle,
  FileText,
  Info,
  Send,
  Square,
  Timer,
} from "lucide-react";
import { useI18n } from "../../../../i18n";
import type { ToolCallInfo } from "../utils/conversationTypes";
import { ToolCallNode } from "./shared/ToolCallNode";

type BashToolCallProps = {
  toolCall: ToolCallInfo;
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
  | { type: "detached"; pid: number; logPath: string }
  | { type: "raw"; text: string }
  | { type: "empty" };

const DEFAULT_TIMEOUT_MS = 30000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseArgs = (args: string): ParsedBashArgs | null => {
  try {
    const parsed: unknown = JSON.parse(args);
    if (
      !isRecord(parsed) ||
      typeof parsed.command !== "string" ||
      typeof parsed.workingDirectory !== "string"
    ) {
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
      workingDirectory: parsed.workingDirectory,
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

  // Auto-focus the input when the interactive session becomes available
  useEffect(() => {
    if (canSendInput && inputRef.current) {
      inputRef.current.focus();
    }
  }, [canSendInput]);

  const handleSendInput = useCallback(async () => {
    if (!interactiveSessionId || !inputValue.trim() || isSending) {
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
  useEffect(() => {
    if (!isRunning) {
      isKillRequestedRef.current = false;
      setIsKilling(false);
    }
  }, [isRunning]);

  const handleKill = useCallback(
    async (reason: "user" | "timeout" = "user") => {
      if (!toolExecutionId || isKillRequestedRef.current) {
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
          // longer a cancellation token to signal.
          isKillRequestedRef.current = false;
          setIsKilling(false);
        }
      } catch {
        // IPC failure is retryable. The agent loop will still surface the actual
        // tool result if the process finished concurrently.
        isKillRequestedRef.current = false;
        setIsKilling(false);
      }
    },
    [toolExecutionId],
  );

  // Renderer-side watchdog: the Rust timeout remains authoritative, but this
  // fail-safe sends a kill request with the explicit "timeout" reason when
  // the countdown reaches zero. The backend records the reason, so a
  // watchdog-triggered abort is reported as a timeout — never as a user
  // cancellation — while covering a delayed/stalled backend timeout path
  // without creating a second termination implementation.
  useEffect(() => {
    if (
      !isRunning ||
      remainingMs !== 0 ||
      isInteractive ||
      parsedArgs?.detach ||
      !toolExecutionId ||
      isKillRequestedRef.current
    ) {
      return;
    }
    void handleKill("timeout");
  }, [
    handleKill,
    isInteractive,
    isRunning,
    parsedArgs?.detach,
    remainingMs,
    toolExecutionId,
  ]);

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
            <span className="tool-call-bash-detached-badge">
              <Activity size={11} aria-hidden="true" />
              {t("toolCall.bash.detached", {
                values: { pid: parsedResult.pid },
              })}
            </span>
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
            <button
              className="tool-call-bash-kill"
              disabled={isKilling}
              onClick={() => void handleKill("user")}
              title={t("toolCall.bash.killTitle")}
              type="button"
            >
              <Square size={11} aria-hidden="true" />
              {isKilling ? t("toolCall.bash.killing") : t("toolCall.bash.kill")}
            </button>
          ) : null}
        </>
      }
      className="tool-call-bash"
    >
      <div className="tool-call-body tool-call-bash-body">
        {parsedResult.type === "timeout" ? (
          <div className="tool-call-error tool-call-bash-timeout-notice">
            <AlertCircle size={12} aria-hidden="true" />
            <span>{parsedResult.message}</span>
          </div>
        ) : null}
        {parsedResult.type === "cancelled" ? (
          <div className="tool-call-error tool-call-bash-timeout-notice">
            <AlertCircle size={12} aria-hidden="true" />
            <span>{parsedResult.message}</span>
          </div>
        ) : null}
        {parsedResult.type === "error" ? (
          <div className="tool-call-error">
            <AlertCircle size={12} aria-hidden="true" />
            <span>{parsedResult.message}</span>
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
            <pre className="tool-call-bash-output-pre">
              {output}
              {isRunning ? (
                <span
                  className="tool-call-bash-stream-cursor"
                  aria-hidden="true"
                />
              ) : null}
            </pre>
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
                  disabled={isSending || !inputValue.trim()}
                  onClick={() => void handleSendInput()}
                  type="button"
                >
                  <Send size={13} />
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </ToolCallNode>
  );
};
