import { Activity, Eye, FileCode, GitFork } from "lucide-react";
import { useI18n } from "../../../../i18n";
import { ModelBrandIcon } from "../../../common/ModelBrandIcon";
import { Tooltip } from "../../../common/Tooltip";
import { formatDuration } from "../../../../utils/formatDuration";
import { formatTokens } from "../../../../utils/formatTokens";
import { formatTtft } from "../../../../utils/formatTtft";
import { MessageCopyButton } from "./MessageCopyButton";
import type { ChatRunStats } from "../utils/types";

export type AiResponseActionsProps = {
  content: string;
  conversationId: string;
  responseId?: string;
  showRawMarkdown: boolean;
  onToggleRawMarkdown: () => void;
  onFork: (conversationId: string, upToResponseId: string) => void;
  /** 会话累计运行统计：仅最后一条 AI 响应传入，作为操作栏图标的悬浮明细。 */
  runStats?: ChatRunStats | null;
};

// 统计明细行：左侧标签、右侧数值（数值可含图标）。
const RunStatsRow = ({
  label,
  children,
  model = false,
}: {
  label: string;
  children: React.ReactNode;
  model?: boolean;
}): React.JSX.Element => (
  <div className="ai-run-stats-row">
    <span className="ai-run-stats-label">{label}</span>
    <span className={`ai-run-stats-value${model ? " is-model" : ""}`}>
      {children}
    </span>
  </div>
);

export const AiResponseActions = ({
  content,
  conversationId,
  responseId,
  showRawMarkdown,
  onToggleRawMarkdown,
  onFork,
  runStats,
}: AiResponseActionsProps): React.JSX.Element => {
  const { t } = useI18n();

  const handleFork = (): void => {
    onFork(conversationId, responseId ?? "");
  };

  const usage = runStats?.tokenUsage ?? null;
  const totalTokens = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
  const outputTokens = usage?.outputTokens ?? 0;
  const cacheRead = usage?.cacheReadInputTokens ?? 0;
  const cacheWrite = usage?.cacheCreationInputTokens ?? 0;
  const statsRows: React.JSX.Element[] = [];
  if (runStats) {
    if (runStats.durationMs > 0) {
      statsRows.push(
        <RunStatsRow
          key="duration"
          label={t("chat.runSummary.duration", { defaultValue: "Duration" })}
        >
          {formatDuration(runStats.durationMs)}
        </RunStatsRow>,
      );
    }
    if (runStats.requestCount > 0 && runStats.ttftSumMs > 0) {
      statsRows.push(
        <RunStatsRow
          key="ttft"
          label={t("chat.runSummary.ttft", { defaultValue: "TTFT" })}
        >
          {formatTtft(runStats.ttftSumMs / runStats.requestCount)}
        </RunStatsRow>,
      );
    }
    if (totalTokens > 0) {
      statsRows.push(
        <RunStatsRow
          key="tokens"
          label={t("chat.runSummary.tokens", { defaultValue: "Tokens" })}
        >
          {formatTokens(totalTokens)}
        </RunStatsRow>,
      );
    }
    // 平均输出吞吐只用 outputTokens：input 含每次工具调用重发的上下文。
    if (runStats.durationMs > 0 && outputTokens > 0) {
      statsRows.push(
        <RunStatsRow
          key="speed"
          label={t("chat.runSummary.speed", { defaultValue: "Speed" })}
        >
          {(outputTokens / (runStats.durationMs / 1000)).toFixed(1)} tok/s
        </RunStatsRow>,
      );
    }
    if (cacheWrite > 0) {
      statsRows.push(
        <RunStatsRow
          key="cacheWrite"
          label={t("chat.runSummary.cacheWrite", {
            defaultValue: "Cache write",
          })}
        >
          {formatTokens(cacheWrite)}
        </RunStatsRow>,
      );
    }
    if (cacheRead > 0) {
      statsRows.push(
        <RunStatsRow
          key="cacheRead"
          label={t("chat.runSummary.cacheRead", { defaultValue: "Cache hit" })}
        >
          {formatTokens(cacheRead)}
        </RunStatsRow>,
      );
    }
    if (runStats.model) {
      statsRows.push(
        <RunStatsRow
          key="model"
          model
          label={t("chat.runSummary.model", { defaultValue: "Model" })}
        >
          <ModelBrandIcon model={runStats.model} size={12} />
          <span>{runStats.model}</span>
        </RunStatsRow>,
      );
    }
  }

  return (
    <div className="ai-response-actions" aria-label="AI response actions">
      <Tooltip
        content={
          showRawMarkdown
            ? t("chat.showRenderedView", { defaultValue: "Show rendered view" })
            : t("chat.showRawMarkdown", { defaultValue: "Show raw Markdown" })
        }
      >
        <button
          className={`ai-response-action-btn${showRawMarkdown ? " is-open" : ""}`}
          type="button"
          aria-label={
            showRawMarkdown
              ? t("chat.showRenderedView", {
                  defaultValue: "Show rendered view",
                })
              : t("chat.showRawMarkdown", { defaultValue: "Show raw Markdown" })
          }
          aria-pressed={showRawMarkdown}
          onClick={onToggleRawMarkdown}
        >
          {showRawMarkdown ? (
            <Eye size={15} strokeWidth={1.8} />
          ) : (
            <FileCode size={15} strokeWidth={1.8} />
          )}
        </button>
      </Tooltip>
      <Tooltip content={t("chat.copyResponse", { defaultValue: "Copy" })}>
        <MessageCopyButton
          content={content}
          className="ai-response-action-btn"
        />
      </Tooltip>
      <Tooltip content={t("chat.forkConversation", { defaultValue: "Fork" })}>
        <button
          className="ai-response-action-btn"
          type="button"
          aria-label={t("chat.forkConversation", { defaultValue: "Fork" })}
          onClick={handleFork}
        >
          <GitFork size={15} strokeWidth={1.8} />
        </button>
      </Tooltip>
      {statsRows.length > 0 ? (
        <Tooltip content={<div className="ai-run-stats">{statsRows}</div>}>
          <span
            className="ai-response-stats"
            role="note"
            aria-label={t("chat.runSummary.title", {
              defaultValue: "Run summary",
            })}
          >
            <Activity size={15} strokeWidth={1.8} aria-hidden="true" />
          </span>
        </Tooltip>
      ) : null}
      <div className="snow-client-slot" data-snow-slot="chat.message.actions" />
    </div>
  );
};
