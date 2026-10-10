import { useMemo } from "react";
import { Clock, Database, Gauge, Repeat, Sigma, Timer } from "lucide-react";
import { ModelBrandIcon } from "../../../common/ModelBrandIcon";
import { Tooltip } from "../../../common/Tooltip";
import { useI18n } from "../../../../i18n";
import { formatTokens } from "../../../../utils/formatTokens";
import { formatTtft } from "../../../../utils/formatTtft";
import type {
  ChatConversationMessage,
  TokenUsage,
} from "../utils/conversationTypes";

const formatDuration = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m${remainingSeconds}s`;
};

type ChatRunSummaryProps = {
  messages: ChatConversationMessage[];
  isStreaming: boolean;
  isAborting: boolean;
  isRunActive: boolean;
  tokenUsage: TokenUsage | null;
  durationMs: number;
  ttftSumMs: number;
  requestCount: number;
};

// AI 流程完全结束后，在消息列表底部以 fork-divider 同款分隔条展示本次
// 任务的汇总信息：总耗时、总 Token 消耗、缓存命中情况、模型。
export const ChatRunSummary = ({
  messages,
  isStreaming,
  isAborting,
  isRunActive,
  tokenUsage,
  durationMs,
  ttftSumMs,
  requestCount,
}: ChatRunSummaryProps): React.JSX.Element | null => {
  const { t } = useI18n();

  // 最后一条 assistant 消息使用的模型：AI 流程结束后摘要条展示用。
  const lastModel = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant" && messages[i].model) {
        return messages[i].model;
      }
    }
    return undefined;
  }, [messages]);

  if (isStreaming || isAborting || isRunActive) {
    return null;
  }
  const hasActiveGeneration = messages.some(
    (message) =>
      message.status === "sending" ||
      (message.role === "assistant" &&
        message.toolCalls?.some(
          (toolCall) =>
            toolCall.status === "pending" || toolCall.status === "running",
        )),
  );
  if (hasActiveGeneration) {
    return null;
  }
  const hasAssistant = messages.some((m) => m.role === "assistant");
  if (!hasAssistant) {
    return null;
  }
  // 整个会话的累计统计（每次 run 结束累加，历史会话从 DB 回显）。
  // 旧版本会话没有这些数据，不显示，避免展示不完整数据造成误解。
  const usage = tokenUsage;
  const totalTokens = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
  const cacheRead = usage?.cacheReadInputTokens ?? 0;
  const cacheWrite = usage?.cacheCreationInputTokens ?? 0;
  const hasStats =
    durationMs > 0 ||
    totalTokens > 0 ||
    cacheRead > 0 ||
    cacheWrite > 0 ||
    requestCount > 0;
  if (!hasStats) {
    return null;
  }

  const items: React.JSX.Element[] = [];
  if (durationMs > 0) {
    items.push(
      <Tooltip
        key="duration"
        content={t("chat.runSummary.duration", {
          defaultValue: "当前会话累计耗时",
        })}
      >
        <span className="chat-run-summary-item">
          <Timer size={12} strokeWidth={1.8} aria-hidden="true" />
          <span>{formatDuration(durationMs)}</span>
        </span>
      </Tooltip>,
    );
  }
  if (requestCount > 0 && ttftSumMs > 0) {
    const averageTtftMs = ttftSumMs / requestCount;
    items.push(
      <Tooltip
        key="ttft"
        content={t("chat.runSummary.ttft", {
          defaultValue: "当前会话平均 TTFT（首 Token 延迟）",
        })}
      >
        <span className="chat-run-summary-item">
          <Clock size={12} strokeWidth={1.8} aria-hidden="true" />
          <span>{formatTtft(averageTtftMs)}</span>
        </span>
      </Tooltip>,
    );
  }
  if (totalTokens > 0) {
    items.push(
      <Tooltip
        key="tokens"
        content={t("chat.runSummary.tokens", {
          defaultValue: "当前会话总 Token 消耗",
        })}
      >
        <span className="chat-run-summary-item">
          <Sigma size={12} strokeWidth={1.8} aria-hidden="true" />
          <span>{formatTokens(totalTokens)}</span>
        </span>
      </Tooltip>,
    );
  }
  if (durationMs > 0 && (usage?.outputTokens ?? 0) > 0) {
    // 平均输出吞吐 = 累计输出 Token / 累计耗时（秒）。分子只用
    // outputTokens：input 含每次工具调用重发的上下文（占大头），
    // 混入会把数值虚高到几千。耗时含工具执行等待，因此该值是
    // 实际生成速度的保守下界。
    const tokensPerSecond = (usage?.outputTokens ?? 0) / (durationMs / 1000);
    items.push(
      <Tooltip
        key="speed"
        content={t("chat.runSummary.speed", {
          defaultValue: "当前会话平均输出速度",
        })}
      >
        <span className="chat-run-summary-item">
          <Gauge size={12} strokeWidth={1.8} aria-hidden="true" />
          <span>{tokensPerSecond.toFixed(1)} tok/s</span>
        </span>
      </Tooltip>,
    );
  }
  if (cacheWrite > 0) {
    items.push(
      <Tooltip
        key="cacheWrite"
        content={t("chat.runSummary.cacheWrite", {
          defaultValue: "当前会话缓存写入",
        })}
      >
        <span className="chat-run-summary-item">
          <Database size={12} strokeWidth={1.8} aria-hidden="true" />
          <span>{formatTokens(cacheWrite)}</span>
        </span>
      </Tooltip>,
    );
  }
  if (cacheRead > 0) {
    items.push(
      <Tooltip
        key="cacheRead"
        content={t("chat.runSummary.cacheRead", {
          defaultValue: "当前会话缓存命中",
        })}
      >
        <span className="chat-run-summary-item">
          <Repeat size={12} strokeWidth={1.8} aria-hidden="true" />
          <span>{formatTokens(cacheRead)}</span>
        </span>
      </Tooltip>,
    );
  }
  if (lastModel) {
    items.push(
      <Tooltip
        key="model"
        content={t("chat.runSummary.model", {
          defaultValue: "当前会话模型",
        })}
      >
        <span className="chat-run-summary-item chat-run-summary-model">
          <ModelBrandIcon model={lastModel} size={12} />
          <span>{lastModel}</span>
        </span>
      </Tooltip>,
    );
  }
  if (items.length === 0) {
    return null;
  }

  return (
    <div className="chat-run-summary" role="note">
      <span className="chat-fork-divider-line" />
      <span className="chat-run-summary-content">
        {items.flatMap((item, index) =>
          index === 0
            ? [item]
            : [
                <span
                  key={`sep-${item.key}`}
                  className="chat-run-summary-sep"
                  aria-hidden="true"
                >
                  ·
                </span>,
                item,
              ],
        )}
      </span>
      <span className="chat-fork-divider-line" />
    </div>
  );
};
