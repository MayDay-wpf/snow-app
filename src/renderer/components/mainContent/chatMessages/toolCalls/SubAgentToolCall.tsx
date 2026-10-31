import { useMemo, useRef, useState } from "react";
import type {
  SubAgentAccepted,
  SubAgentMessageQueued,
  SubAgentCancelReceipt,
  SubAgentRunRecord,
} from "../../../../../shared/subAgentRuns";
import { isSubAgentTerminal } from "../../../../../shared/subAgentRuns";
import {
  requestSubAgentRunCancel,
  useSubAgentRuns,
} from "../hooks/subAgentRuntimeClient";
import { SubAgentAcceptanceDetails } from "../components/SubAgentRunDetails";
import {
  AlertCircle,
  ArrowRight,
  Bot,
  CheckCircle2,
  CircleDot,
  Hourglass,
  RotateCcw,
  XCircle,
} from "lucide-react";
import { useI18n } from "../../../../i18n";
import {
  useChatConversationContext,
  useChatConversationSessions,
} from "../components/ChatConversationContext";
import {
  resolveSubAgentFailureDecision,
  useSubAgentFailurePending,
} from "../hooks/subAgentRunControl";
import type { ToolCallInfo } from "../utils/conversationTypes";
import {
  subAgentRunActivity,
  type SubAgentToolCallEntry,
} from "../utils/subAgentRunActivity";
import type { HookExecutionRecord } from "../utils/conversationTypes";
import type { SubAgentAcceptanceSnapshot } from "../hooks/subAgentAcceptance";
import {
  parseSubAgentObservationResult,
  subAgentRunTone,
} from "./subAgentRunObservation";
import { ToolCallNode } from "./shared/ToolCallNode";
import { ToolResultView } from "./shared/ToolResultView";

import { resolveToolDisplayName } from "./shared/toolDisplayName";
import { localizeToolError } from "./shared/toolErrorDisplay";
import { HookExecutionUI } from "./HookExecutionUI";
import { PromptPreview } from "../components/PromptPreview";
import { MarkdownBlock } from "../components/markdownRenderer";
import { SubAgentMessageDelivery } from "./SubAgentMessageDelivery";

const parseUnknownResult = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};
type SubAgentToolCallProps = {
  toolCall: ToolCallInfo;
  parentConversationId?: string;
  /** Hook execution records bound to this tool call (matched by
   *  toolCallInteractionId). beforeSubAgentStart renders as a "pre" step,
   *  onSubAgentComplete as a "post" step inside the card. */
  hookExecutions?: HookExecutionRecord[];
  /** "activate" = 新建子代理（sub-agents-activate）；
   *  "continue" = 继续已结束/运行中的子代理（sub-agents-continue）。
   *  重新激活与激活没有本质区别——都是收集子代理的运行结果，因此
   *  continue 复用同一套展示（参数解析与事件匹配按模式切换）。 */
  mode?: "activate" | "continue";
};

type ParsedSubAgentArgs =
  | { mode: "activate"; agentId: string; summary: string; prompt: string }
  | { mode: "continue"; conversationId: string; message: string };

type ParsedSubAgentResult = { runId?: string } & (
  | ({ type: "receipt"; messageId?: string; queuedAt?: number } & Pick<
      SubAgentAccepted | SubAgentMessageQueued,
      "kind" | "conversationId" | "requestId" | "runId"
    >)
  | {
      type: "success";
      conversationId: string;
      agentName: string;
      summary: string;
      acceptance: SubAgentAcceptanceSnapshot | null;
    }
  | {
      type: "error";
      message: string;
      acceptance: SubAgentAcceptanceSnapshot | null;
    }
  | { type: "raw"; text: string }
  | { type: "empty" }
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseArgs = (
  args: string,
  mode: "activate" | "continue",
): ParsedSubAgentArgs | null => {
  try {
    const parsed: unknown = JSON.parse(args);
    if (!isRecord(parsed)) {
      return null;
    }
    if (mode === "continue") {
      const conversationId =
        typeof parsed.conversationId === "string" ? parsed.conversationId : "";
      const message = typeof parsed.message === "string" ? parsed.message : "";
      if (!conversationId || !message) {
        return null;
      }
      return { mode: "continue", conversationId, message };
    }
    const agentId = typeof parsed.agentId === "string" ? parsed.agentId : "";
    const prompt = typeof parsed.prompt === "string" ? parsed.prompt : "";
    if (!agentId || !prompt) {
      return null;
    }
    const summary =
      typeof parsed.summary === "string" ? parsed.summary.trim() : "";
    return summary ? { mode: "activate", agentId, summary, prompt } : null;
  } catch {
    return null;
  }
};

const parseResult = (result: string | undefined): ParsedSubAgentResult => {
  if (!result) {
    return { type: "empty" };
  }

  try {
    const parsed: unknown = JSON.parse(result);
    if (!isRecord(parsed)) {
      return { type: "raw", text: result };
    }

    const acceptance = null;
    const runId =
      typeof parsed.runId === "string" && parsed.runId
        ? parsed.runId
        : undefined;
    if (
      parsed.success === true &&
      runId &&
      typeof parsed.conversationId === "string" &&
      typeof parsed.requestId === "string" &&
      parsed.requestId.length > 0 &&
      (parsed.kind === "accepted" || parsed.kind === "message_queued")
    ) {
      return {
        type: "receipt",
        kind: parsed.kind,
        requestId: parsed.requestId,
        runId,
        conversationId: parsed.conversationId,
        messageId:
          typeof parsed.messageId === "string" ? parsed.messageId : undefined,
        queuedAt:
          typeof parsed.queuedAt === "number" ? parsed.queuedAt : undefined,
      };
    }

    if (typeof parsed.error === "string") {
      return { type: "error", message: parsed.error, acceptance, runId };
    }

    if (
      parsed.success === true &&
      parsed.kind === "result" &&
      isRecord(parsed.run)
    ) {
      const observed = parseSubAgentObservationResult(result);
      if (observed.kind === "runs" && observed.runs.length === 1) {
        const run = observed.runs[0];
        const acceptance = run.acceptance ?? null;
        if (run.status !== "completed")
          return {
            type: "error",
            message: run.error ?? run.status,
            acceptance,
            runId: run.runId,
          };
        if (run.conversationId)
          return {
            type: "success",
            runId: run.runId,
            conversationId: run.conversationId,
            agentName: run.agentName ?? "",
            summary: run.summary ?? "",
            acceptance,
          };
      }
    }

    return { type: "raw", text: result };
  } catch {
    return { type: "raw", text: result };
  }
};

const SUMMARY_PREVIEW_MAX = 80;

const getSummaryPreview = (summary: string): string =>
  summary.length > SUMMARY_PREVIEW_MAX
    ? `${summary.slice(0, SUMMARY_PREVIEW_MAX)}...`
    : summary;

export const SubAgentToolCall = ({
  toolCall,
  parentConversationId,
  hookExecutions,
  mode = "activate",
}: SubAgentToolCallProps): React.JSX.Element => {
  const { t } = useI18n();
  const {
    handleSelectConversation,
    activeConversationId,
    subAgentSessionEvents,
  } = useChatConversationContext();
  // 会话内存态表每个流式帧都会更换引用：单独订阅（读取子代理会话状态）。
  const sessions = useChatConversationSessions();
  const parentId = parentConversationId ?? activeConversationId;
  const {
    runs,
    loading: runsLoading,
    error: runsError,
    refresh,
  } = useSubAgentRuns(parentId);

  const parsedArgs = useMemo(
    () => parseArgs(toolCall.arguments, mode),
    [toolCall.arguments, mode],
  );
  const parsedResult = useMemo(
    () => parseResult(toolCall.result),
    [toolCall.result],
  );

  // Bind this card to its exact run, never the latest run of the same agent.
  const run = parsedResult.runId
    ? runs.find(
        (item) =>
          item.runId === parsedResult.runId &&
          item.parentConversationId === parentId,
      )
    : toolCall.interactionId
      ? runs.find(
          (item) =>
            item.interactionId === toolCall.interactionId &&
            item.parentConversationId === parentId,
        )
      : undefined;
  const runTone = run ? subAgentRunTone(run.status) : undefined;
  const acceptance =
    run?.outcome?.acceptance ??
    (parsedResult.type === "success" || parsedResult.type === "error"
      ? parsedResult.acceptance
      : null);
  const summary =
    run?.outcome?.summary ??
    (parsedResult.type === "success" ? parsedResult.summary : "");
  const unmetAcceptanceCount = useMemo(
    () =>
      acceptance?.items.filter(
        (item) =>
          item.required &&
          (item.status !== "completed" || item.evidence.length === 0),
      ).length ?? 0,
    [acceptance],
  );
  const matchedEvent = useMemo(() => {
    if (parsedResult.type !== "empty" || run || !toolCall.interactionId)
      return null;
    return (
      Object.values(subAgentSessionEvents).find(
        (event) =>
          event.toolCallInteractionId === toolCall.interactionId &&
          event.parentConversationId === parentId,
      ) ?? null
    );
  }, [
    subAgentSessionEvents,
    parsedResult.type,
    run,
    parentId,
    toolCall.interactionId,
  ]);
  const subConversationId =
    run?.conversationId ??
    (parsedResult.type === "success" || parsedResult.type === "receipt"
      ? parsedResult.conversationId
      : matchedEvent?.conversationId);
  const subSession = subConversationId
    ? sessions[subConversationId]
    : undefined;
  // A continued conversation contains multiple runs. Do not show later activity
  // as progress of an earlier, already completed dispatch. Activity unloaded
  // from memory (window trim / cache sweep) is merged back from the archive.
  const subSessionMessages = subSession?.messages;
  const toolCallEntries = useMemo(
    () => (run ? subAgentRunActivity(run.runId, subSessionMessages) : []),
    [run, subSessionMessages],
  );
  const isEmptyResultError =
    parsedResult.type === "empty" && toolCall.status === "error";
  // Run controls must not attribute a later continuation's state to this card.
  const activeRunConversationId =
    run && !isSubAgentTerminal(run.status) ? run.conversationId : undefined;
  const isQueued = run?.status === "queued";
  const isFailurePending = useSubAgentFailurePending(activeRunConversationId);
  const queryStatus = parsedResult.runId
    ? runsError
      ? "subAgentRun.queryFailed"
      : !run
        ? runsLoading
          ? "subAgentRun.loading"
          : "subAgentRun.unavailable"
        : null
    : null;

  const completedCount = toolCallEntries.filter(
    (e) => e.status === "completed",
  ).length;
  const totalCount = toolCallEntries.length;

  // Hooks bound to this tool call (recorded with toolCallInteractionId).
  // beforeSubAgentStart runs before the sub-agent session is created →
  // rendered at the top of the card; onSubAgentComplete runs when the
  // sub-agent finishes → rendered at the bottom.  The executedActions /
  // pendingDecision filter mirrors HookExecutionUI's own visibility rule.
  const preHooks = useMemo(
    () =>
      (hookExecutions ?? []).filter(
        (record) =>
          record.hookType === "beforeSubAgentStart" &&
          (record.executedActions > 0 || record.pendingDecision),
      ),
    [hookExecutions],
  );
  const postHooks = useMemo(
    () =>
      (hookExecutions ?? []).filter(
        (record) =>
          record.hookType === "onSubAgentComplete" &&
          (record.executedActions > 0 || record.pendingDecision),
      ),
    [hookExecutions],
  );

  // continue 模式没有 agentId（参数是 conversationId + message），
  // 身份名只能来自结果或会话事件。
  const argIdentityId =
    parsedArgs?.mode === "activate" ? parsedArgs.agentId : "";
  const agentName =
    parsedResult.type === "success"
      ? parsedResult.agentName
      : (run?.agentName ?? matchedEvent?.agentName ?? argIdentityId);

  // 头部摘要：激活调用取 summary 参数；continue 取目标子代理事件里记录的
  // 激活摘要（应用重启后事件缺失则回退为代理名）。
  const headSummary =
    parsedArgs?.mode === "activate"
      ? parsedArgs.summary
      : (run?.summary ?? matchedEvent?.summary ?? "");
  const headSummaryPreview = getSummaryPreview(headSummary);

  const promptText = parsedArgs
    ? parsedArgs.mode === "continue"
      ? parsedArgs.message
      : parsedArgs.prompt
    : "";

  const displayAgentName =
    agentName ||
    t("toolCall.subAgent.unknownAgent", { defaultValue: "Sub-agent" });

  // Determine whether the sub-agent conversation is currently active so we
  // can highlight the jump button.
  const isSubAgentActive =
    subConversationId !== undefined &&
    activeConversationId === subConversationId;

  const handleJumpToSubAgent = (): void => {
    if (subConversationId) {
      void handleSelectConversation(subConversationId);
    }
  };

  const renderActivityIcon = (
    status: SubAgentToolCallEntry["status"],
  ): React.ReactNode => {
    if (status === "completed") {
      return <CheckCircle2 size={11} aria-hidden="true" />;
    }
    if (status === "error") {
      return <AlertCircle size={11} aria-hidden="true" />;
    }
    return <CircleDot size={11} aria-hidden="true" />;
  };

  return (
    <ToolCallNode
      toolName={toolCall.name}
      badgeName={
        parsedArgs?.mode === "continue"
          ? t("toolCall.subAgentContinue.name")
          : t("toolCall.subAgent.name")
      }
      category="agent"
      displayName={
        headSummary ? (
          <>
            {headSummaryPreview}
            {agentName ? (
              <span className="tool-call-sub-agent-head-agent">
                {displayAgentName}
              </span>
            ) : null}
          </>
        ) : (
          displayAgentName
        )
      }
      displayNameTitle={headSummary || undefined}
      status={toolCall.status}
      meta={
        run || queryStatus || totalCount > 0 || unmetAcceptanceCount > 0 ? (
          <>
            {run ? (
              <>
                <span className="tool-call-run-mode">
                  {t(`subAgentRun.mode.${run.executionMode}`)}
                </span>
                <span
                  className="tool-call-run-status"
                  title={t("subAgentRun.receiptNotCompletion")}
                >
                  {run.status === "waiting_input" ? (
                    <AlertCircle size={12} aria-hidden="true" />
                  ) : null}
                  {t(`subAgentRun.status.${run.status}`)}
                </span>
              </>
            ) : null}
            {queryStatus ? (
              <span className="tool-call-sub-agent-count" role="status">
                {t(queryStatus)}
              </span>
            ) : null}
            {totalCount > 0 ? (
              <span className="tool-call-sub-agent-count">
                {t("toolCall.subAgent.toolProgress", {
                  values: { completed: completedCount, total: totalCount },
                })}
              </span>
            ) : null}
            {unmetAcceptanceCount > 0 ? (
              <span className="tool-call-sub-agent-acceptance-meta">
                {t("toolCall.subAgent.acceptance.unmetCount", {
                  values: { count: unmetAcceptanceCount },
                })}
              </span>
            ) : null}
          </>
        ) : null
      }
      className={`tool-call-sub-agent${
        runTone ? ` tool-call-run-tone--${runTone}` : ""
      }`}
    >
      <div className="tool-call-body tool-call-sub-agent-body">
        {queryStatus && !runsLoading ? (
          <button
            type="button"
            className="tool-call-sub-agent-jump"
            onClick={() => void refresh()}
          >
            {t("subAgentRun.refresh")}
          </button>
        ) : null}
        {/* Pre-step: beforeSubAgentStart hook ran before the sub-agent session
            was created — show it at the top of the card. */}
        {preHooks.length > 0 ? (
          <div className="tool-call-sub-agent-hooks tool-call-sub-agent-hooks--pre">
            <HookExecutionUI executions={preHooks} />
          </div>
        ) : null}

        {/* Agent identity row */}
        <div className="tool-call-sub-agent-identity">
          <span className="tool-call-sub-agent-identity-badge">
            <Bot size={12} aria-hidden="true" />
            {displayAgentName}
          </span>
          {parsedArgs ? (
            <span className="tool-call-sub-agent-agent-id">
              {parsedArgs.mode === "continue"
                ? parsedArgs.conversationId
                : parsedArgs.agentId}
            </span>
          ) : null}
        </div>

        {/* Prompt / message preview */}
        {promptText ? (
          <PromptPreview
            text={promptText}
            label={
              parsedArgs?.mode === "continue"
                ? t("toolCall.subAgentContinue.message")
                : t("toolCall.subAgent.prompt")
            }
          />
        ) : null}

        {/* Live tool activity list */}
        {toolCallEntries.length > 0 ? (
          <div className="tool-call-sub-agent-activity">
            <span className="tool-call-sub-agent-activity-label">
              {t("toolCall.subAgent.activity")}
            </span>
            <div className="tool-call-sub-agent-activity-list">
              {toolCallEntries.map((entry) => (
                <div
                  key={entry.id}
                  className="tool-call-sub-agent-activity-item"
                >
                  {renderActivityIcon(entry.status)}
                  <span className="tool-call-sub-agent-activity-name">
                    {resolveToolDisplayName(t, entry.name)}
                  </span>
                  {entry.summary ? (
                    <span
                      className="tool-call-sub-agent-activity-summary"
                      title={entry.summary}
                    >
                      {entry.summary}
                    </span>
                  ) : null}
                  <span
                    className={`tool-call-sub-agent-activity-status tool-call-sub-agent-activity-status-${entry.status}`}
                  >
                    {t(`toolCall.subAgent.status.${entry.status}`)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {/* Queue state is static; the dispatch header owns the only request animation. */}
        {isQueued ? (
          <div className="tool-call-sub-agent-pending">
            <Hourglass size={14} aria-hidden="true" />
            <span>{t("toolCall.subAgent.waitingSlot")}</span>
          </div>
        ) : null}

        {/* 请求失败挂起：等待用户重试或放弃 */}
        {isFailurePending && subConversationId ? (
          <div className="tool-call-sub-agent-retry">
            <span className="tool-call-sub-agent-retry-text">
              <AlertCircle size={12} aria-hidden="true" />
              {t("toolCall.subAgent.failurePending")}
            </span>
            <span className="tool-call-sub-agent-retry-actions">
              <button
                type="button"
                className="tool-call-sub-agent-jump"
                onClick={() =>
                  resolveSubAgentFailureDecision(subConversationId, "abandon")
                }
              >
                <XCircle size={12} aria-hidden="true" />
                {t("toolCall.subAgent.abandon")}
              </button>
              <button
                type="button"
                className="tool-call-sub-agent-jump is-primary"
                onClick={() =>
                  resolveSubAgentFailureDecision(subConversationId, "retry")
                }
              >
                <RotateCcw size={12} aria-hidden="true" />
                {t("toolCall.subAgent.retry")}
              </button>
            </span>
          </div>
        ) : null}

        {/* Queued notice (continue 目标仍在运行：消息已进入 Pending 队列） */}
        {parsedResult.type === "receipt" &&
        parsedResult.kind === "message_queued" ? (
          <SubAgentMessageDelivery
            messageId={parsedResult.messageId}
            queuedAt={parsedResult.queuedAt}
          />
        ) : null}

        {/* Summary on success */}
        {summary ? (
          <div className="tool-call-sub-agent-summary">
            <span className="tool-call-sub-agent-summary-label">
              {t("toolCall.subAgent.summary")}
            </span>
            <MarkdownBlock
              className="ai-message tool-call-sub-agent-summary-value"
              content={summary}
            />
          </div>
        ) : null}

        {/* Acceptance receipt: per-item status verified against the real tool
            execution log. Missing evidence is never treated as passed. */}
        {acceptance ? (
          <SubAgentAcceptanceDetails acceptance={acceptance} />
        ) : null}

        {/* Error */}
        {parsedResult.type === "error" ||
        isEmptyResultError ||
        run?.outcome?.error ? (
          <div className="tool-call-error">
            <AlertCircle size={12} aria-hidden="true" />
            <span>
              {run?.outcome?.error
                ? localizeToolError(t, run.outcome.error.message)
                : isEmptyResultError
                  ? t("toolCall.subAgent.activationFailed")
                  : parsedResult.type === "error"
                    ? localizeToolError(t, parsedResult.message)
                    : t("toolCall.subAgent.activationFailed")}
            </span>
          </div>
        ) : null}

        {/* Raw result fallback */}
        {parsedResult.type === "raw" ? (
          <section className="tool-call-section">
            <span className="tool-call-section-label">
              {t("toolCall.subAgent.result")}
            </span>
            <ToolResultView value={parseUnknownResult(parsedResult.text)} />
          </section>
        ) : null}

        {/* Post-step: onSubAgentComplete hook ran when the sub-agent finished
            — show it at the bottom of the card, before the jump button. */}
        {postHooks.length > 0 ? (
          <div className="tool-call-sub-agent-hooks tool-call-sub-agent-hooks--post">
            <HookExecutionUI executions={postHooks} />
          </div>
        ) : null}

        {/* Jump to sub-agent conversation - available even while running */}
        {run ? (
          <SubAgentRunActions key={run.runId} run={run} />
        ) : subConversationId ? (
          <button
            type="button"
            className={`tool-call-sub-agent-jump ${
              isSubAgentActive ? "active" : ""
            }`}
            onClick={handleJumpToSubAgent}
          >
            <ArrowRight size={12} aria-hidden="true" />
            {t("toolCall.subAgent.jumpToConversation")}
          </button>
        ) : null}
      </div>
    </ToolCallNode>
  );
};

/** Compact actions in the existing sub-agent card; messaging stays in its conversation. */
export const SubAgentRunActions = ({
  run,
}: {
  run: SubAgentRunRecord;
}): React.JSX.Element => {
  const { t } = useI18n();
  const { handleSelectConversation, activeConversationId } =
    useChatConversationContext();
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<SubAgentCancelReceipt | null>(null);
  const canCancel =
    run.status === "queued" ||
    run.status === "running" ||
    run.status === "waiting_input";
  const cancel = async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      setReceipt(
        await requestSubAgentRunCancel(run.parentConversationId, run.runId),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const open = async (): Promise<void> => {
    setError(null);
    try {
      await handleSelectConversation(run.conversationId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <>
      <div className="tool-call-sub-agent-retry-actions">
        <button
          type="button"
          className={`tool-call-sub-agent-jump ${activeConversationId === run.conversationId ? "active" : ""}`}
          onClick={() => void open()}
        >
          <ArrowRight size={12} aria-hidden="true" />
          {t(
            run.status === "waiting_input"
              ? "subAgentRun.handleInput"
              : "toolCall.subAgent.jumpToConversation",
          )}
        </button>
        {canCancel ? (
          <button
            type="button"
            className="tool-call-sub-agent-jump"
            disabled={busy || receipt !== null}
            onClick={() => void cancel()}
          >
            <XCircle size={12} aria-hidden="true" />
            {t("subAgentRun.cancel")}
          </button>
        ) : null}
        {receipt ? (
          <span role="status">
            {t(`subAgentRun.cancel.${receipt.disposition}`)}
          </span>
        ) : null}
      </div>
      {error ? (
        <div className="tool-call-error" role="alert">
          <AlertCircle size={12} aria-hidden="true" />
          <span>{localizeToolError(t, error)}</span>
        </div>
      ) : null}
    </>
  );
};
