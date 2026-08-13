import { Loader2, TriangleAlert } from "lucide-react";
import { memo, useMemo, useState } from "react";
import { useI18n } from "../../../../i18n";
import { AiResponseActions } from "./AiResponseActions";
import { StreamCursor } from "./StreamCursor";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCallItem } from "./ToolCallItem";
import { ToolCallGroup } from "./ToolCallGroup";
import { ImageGenGallery } from "../toolCalls/ImageGenGallery";
import { ToolAuthorizationDialog } from "../dialogs/ToolAuthorizationDialog";
import { SensitiveCommandConfirmDialog } from "../toolCalls/SensitiveCommandConfirmDialog";
import { MarkdownBlock } from "./markdownRenderer";
import type { AiResponseProps } from "../utils/types";
import type { ToolCallInfo } from "../utils/conversationTypes";
import type { HookExecutionRecord } from "../utils/conversationTypes";

/** 工具调用渲染单元：连续的 imagegen-generate 调用合并为画廊，其余逐个渲染。 */
type ToolCallRenderItem =
  | { type: "gallery"; key: string; toolCalls: ToolCallInfo[] }
  | { type: "single"; key: string; toolCall: ToolCallInfo };

/** 把 toolCalls 分组：相邻的 imagegen-generate（≥2 个）合并为一组画廊，
 *  避免并行生图结果纵向堆叠为多个单张卡片；其余调用保持单卡渲染。 */
const groupToolCalls = (toolCalls: ToolCallInfo[]): ToolCallRenderItem[] => {
  const groups: ToolCallRenderItem[] = [];
  for (let i = 0; i < toolCalls.length; ) {
    if (toolCalls[i].name === "imagegen-generate") {
      let j = i;
      while (
        j < toolCalls.length &&
        toolCalls[j].name === "imagegen-generate"
      ) {
        j += 1;
      }
      if (j - i >= 2) {
        groups.push({
          type: "gallery",
          key: `imagegen-gallery-${i}`,
          toolCalls: toolCalls.slice(i, j),
        });
      } else {
        groups.push({
          type: "single",
          key: `${toolCalls[i].name}-${i}`,
          toolCall: toolCalls[i],
        });
      }
      i = j;
    } else {
      groups.push({
        type: "single",
        key: `${toolCalls[i].name}-${i}`,
        toolCall: toolCalls[i],
      });
      i += 1;
    }
  }
  return groups;
};

export const AiResponse = memo(
  ({
    title,
    summary,
    thinking,
    sections = [],
    isStreaming = false,
    isAborting = false,
    incompleteVariant,
    interruptionReason,
    recoveryOutcome,
    showActions = true,
    toolCalls = [],
    hookExecutions = [],
    pendingToolAuthorizations = [],
    onApproveToolAuthorization,
    onApproveToolAuthorizationAlways,
    onRejectToolAuthorization,
    conversationId,
    responseId,
    onFork,
  }: AiResponseProps): React.JSX.Element => {
    const { t } = useI18n();
    const [showRawMarkdown, setShowRawMarkdown] = useState(false);
    const normalizedThinking = thinking?.trim();
    const normalizedSummary = summary.trim();
    const summaryClassName = "ai-message-summary";
    const hasToolCalls = toolCalls.length > 0;
    const incompleteVariantMessage =
      incompleteVariant === "partial_content"
        ? t("chat.incomplete.variant.partialContent")
        : incompleteVariant === "thinking_only"
          ? t("chat.incomplete.variant.thinkingOnly")
          : incompleteVariant === "tool_call"
            ? t("chat.incomplete.variant.toolCall")
            : incompleteVariant === "empty"
              ? t("chat.incomplete.variant.empty")
              : null;
    const incompleteReasonMessage =
      interruptionReason === "unexpected_eof"
        ? t("chat.incomplete.reason.unexpectedEof")
        : interruptionReason === "read_error"
          ? t("chat.incomplete.reason.readError")
          : interruptionReason === "idle_timeout"
            ? t("chat.incomplete.reason.idleTimeout")
            : interruptionReason === "explicit_incomplete"
              ? t("chat.incomplete.reason.explicitIncomplete")
              : interruptionReason === "output_limit"
                ? t("chat.incomplete.reason.outputLimit")
                : null;
    const recoveryOutcomeMessage =
      recoveryOutcome === "partial_threshold"
        ? t("chat.incomplete.outcome.partialThreshold")
        : recoveryOutcome === "retry_exhausted"
          ? t("chat.incomplete.outcome.retryExhausted")
          : recoveryOutcome === "non_retriable"
            ? t("chat.incomplete.outcome.nonRetriable")
            : null;

    const sensitiveCommandAuthorizations = useMemo(
      () =>
        pendingToolAuthorizations.filter(
          (tc) =>
            tc.sensitiveCommandMatches && tc.sensitiveCommandMatches.length > 0
        ),
      [pendingToolAuthorizations]
    );
    const normalAuthorizations = useMemo(
      () =>
        pendingToolAuthorizations.filter(
          (tc) =>
            !tc.sensitiveCommandMatches ||
            tc.sensitiveCommandMatches.length === 0
        ),
      [pendingToolAuthorizations]
    );

    // 相邻的并行 imagegen 调用合并为统一画廊（生成中占位 → 逐个填充）
    const groupedToolCalls = useMemo(
      () => groupToolCalls(toolCalls),
      [toolCalls]
    );

    // Records bound to a specific tool call (toolCallInteractionId) are
    // rendered attached to that tool card (e.g. beforeSubAgentStart above
    // the sub-agent card).  Unbound records stay in the message footer.
    const hooksByInteractionId = useMemo(() => {
      const map = new Map<string, HookExecutionRecord[]>();
      for (const record of hookExecutions) {
        if (!record.toolCallInteractionId) {
          continue;
        }
        const list = map.get(record.toolCallInteractionId);
        if (list) {
          list.push(record);
        } else {
          map.set(record.toolCallInteractionId, [record]);
        }
      }
      return map;
    }, [hookExecutions]);

    return (
      <article className="ai-message" aria-label="AI response">
        <div className="ai-message-content">
          {title ? <h2>{title}</h2> : null}

          {/* 1. Thinking */}
          {normalizedThinking ? (
            <ThinkingBlock
              content={normalizedThinking}
              isStreaming={isStreaming}
            />
          ) : null}

          {/* 2. Body / Summary */}
          {normalizedSummary ? (
            showRawMarkdown ? (
              <pre className="ai-message-raw">{normalizedSummary}</pre>
            ) : (
              <MarkdownBlock
                className={summaryClassName}
                content={normalizedSummary}
                streaming={isStreaming}
              />
            )
          ) : null}

          {/* 3. Sections */}
          {sections.map((section) => (
            <section className="ai-message-section" key={section.title}>
              <h3>{section.title}</h3>
              {showRawMarkdown ? (
                <pre className="ai-message-raw">{section.body}</pre>
              ) : (
                <MarkdownBlock
                  className="ai-message-section-body"
                  content={section.body}
                  streaming={isStreaming}
                />
              )}
            </section>
          ))}

          {/* 4. Tool calls */}
          {hasToolCalls ? (
            <ToolCallGroup
              count={toolCalls.length}
              isRunning={toolCalls.some((tc) => tc.status === "running")}
            >
              {groupedToolCalls.map((item) =>
                item.type === "gallery" ? (
                  <ImageGenGallery
                    key={item.key}
                    toolCalls={item.toolCalls}
                  />
                ) : (
                  <ToolCallItem
                    key={item.key}
                    toolCall={item.toolCall}
                    hookExecutions={hooksByInteractionId.get(
                      item.toolCall.interactionId
                    )}
                  />
                )
              )}
            </ToolCallGroup>
          ) : null}

          {onApproveToolAuthorization &&
          onApproveToolAuthorizationAlways &&
          onRejectToolAuthorization ? (
            <>
              <SensitiveCommandConfirmDialog
                toolCalls={sensitiveCommandAuthorizations}
                onApprove={onApproveToolAuthorization}
                onReject={onRejectToolAuthorization}
              />
              <ToolAuthorizationDialog
                toolCalls={normalAuthorizations}
                onApprove={onApproveToolAuthorization}
                onApproveAlways={onApproveToolAuthorizationAlways}
                onReject={onRejectToolAuthorization}
              />
            </>
          ) : null}

          {/* 5. Loading indicator — persists throughout the entire AI loop */}
          {isAborting ? (
            <span className="stream-stopping">
              <Loader2 size={12} className="spin" />
              <span>{t("chat.stopping", { defaultValue: "Stopping..." })}</span>
            </span>
          ) : isStreaming ? (
            <StreamCursor />
          ) : null}

          {/* 6. Persisted incomplete notice */}
          {incompleteVariantMessage ? (
            <div className="response-incomplete-notice" role="status">
              <TriangleAlert
                aria-hidden="true"
                className="response-incomplete-notice-icon"
                size={16}
                strokeWidth={1.8}
              />
              <div className="response-incomplete-notice-content">
                <strong className="response-incomplete-notice-title">
                  {t("chat.incomplete.title")}
                </strong>
                <span>{incompleteVariantMessage}</span>
                {incompleteReasonMessage ? (
                  <span className="response-incomplete-notice-detail">
                    {incompleteReasonMessage}
                  </span>
                ) : null}
                {recoveryOutcomeMessage ? (
                  <span className="response-incomplete-notice-detail">
                    {recoveryOutcomeMessage}
                  </span>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>

        {/* 7. Actions */}
        {showActions && conversationId && onFork ? (
          <AiResponseActions
            content={normalizedSummary}
            conversationId={conversationId}
            responseId={responseId}
            showRawMarkdown={showRawMarkdown}
            onToggleRawMarkdown={() => setShowRawMarkdown((prev) => !prev)}
            onFork={onFork}
          />
        ) : null}
      </article>
    );
  }
);

AiResponse.displayName = "AiResponse";
