import { TriangleAlert } from "lucide-react";
import { memo, useMemo, useState } from "react";
import { useI18n } from "../../../../i18n";
import { AiErrorNotice } from "./AiErrorNotice";
import { AiResponseActions } from "./AiResponseActions";
import { StreamRetryNotice } from "./StreamRetryNotice";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCallItem } from "./ToolCallItem";
import { ToolCallGroup } from "./ToolCallGroup";
import { MessageTimestamp } from "./MessageTimestamp";
import { ImageGenGallery } from "../toolCalls/ImageGenGallery";
import { AskUserQuestionGroup } from "../toolCalls/AskUserQuestionGroup";
import { ToolAuthorizationDialog } from "../dialogs/ToolAuthorizationDialog";
import { SensitiveCommandConfirmDialog } from "../toolCalls/SensitiveCommandConfirmDialog";
import { MarkdownBlock } from "./markdownRenderer";
import { ChatFileArtifactCard } from "./ChatFileArtifactCard";
import {
  artifactFileKey,
  resolveArtifactHref,
  resolveArtifactPath,
} from "./chatFileArtifacts";
import { HTML_FILE_PREVIEW_ATTR } from "../toolCalls/shared/HtmlFilePreviewButton";
import type { AiResponseProps } from "../utils/types";
import type { ToolCallInfo } from "../utils/conversationTypes";
import type { HookExecutionRecord } from "../utils/conversationTypes";
import { useMessageTimeVisible } from "../utils/messageTimeVisibility";

/** 工具调用渲染单元：连续的 imagegen-generate 合并为画廊、连续的多个提问合并
 *  为 Tab 组，其余逐个渲染。 */
type ToolCallRenderItem =
  | { type: "gallery"; key: string; toolCalls: ToolCallInfo[] }
  | { type: "questionGroup"; key: string; toolCalls: ToolCallInfo[] }
  | { type: "single"; key: string; toolCall: ToolCallInfo };

/** 需要合并渲染的工具名（相邻 ≥2 个才合并）。 */
const ASK_TOOL_NAME = "user-interaction-askUserQuestion";
const IMAGE_TOOL_NAME = "imagegen-generate";

/** 把 toolCalls 分组：相邻的 imagegen-generate（≥2 个）合并为一组画廊、
 *  相邻的提问（≥2 个）合并为一个 Tab 容器，避免并行生图结果 / 多轮提问
 *  纵向堆叠为多个单卡片；其余调用保持单卡渲染。 */
const groupToolCalls = (toolCalls: ToolCallInfo[]): ToolCallRenderItem[] => {
  const groups: ToolCallRenderItem[] = [];
  for (let i = 0; i < toolCalls.length;) {
    const name = toolCalls[i].name;
    if (name === IMAGE_TOOL_NAME || name === ASK_TOOL_NAME) {
      let j = i;
      while (j < toolCalls.length && toolCalls[j].name === name) {
        j += 1;
      }
      if (j - i >= 2) {
        groups.push(
          name === ASK_TOOL_NAME
            ? {
                type: "questionGroup",
                key: `ask-question-group-${i}`,
                toolCalls: toolCalls.slice(i, j),
              }
            : {
                type: "gallery",
                key: `imagegen-gallery-${i}`,
                toolCalls: toolCalls.slice(i, j),
              },
        );
      } else {
        groups.push({
          type: "single",
          key: `${name}-${i}`,
          toolCall: toolCalls[i],
        });
      }
      i = j;
    } else {
      groups.push({
        type: "single",
        key: `${name}-${i}`,
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
    timestamp,
    thinking,
    thinkingDurationMs,
    thinkingTokenCount,
    isThinkingActive,
    sections = [],
    isStreaming = false,
    isRetrying = false,
    retryAttempt,
    retryError,
    retryBackoffMs,
    retryBackoffStartedAt,
    isError = false,
    failureReason,
    incompleteVariant,
    interruptionReason,
    recoveryOutcome,
    showActions = true,
    footerContent,
    fileArtifacts,
    artifactWorkspace,
    onToggleFileArtifact,
    toolCalls = [],
    hookExecutions = [],
    pendingToolAuthorizations = [],
    onApproveToolAuthorization,
    onApproveToolAuthorizationAlways,
    onRejectToolAuthorization,
    conversationId,
    messageId,
    responseId,
    updateSessionMessages,
    onFork,
  }: AiResponseProps): React.JSX.Element => {
    const { t } = useI18n();
    const showMessageTime = useMessageTimeVisible();
    const [showRawMarkdown, setShowRawMarkdown] = useState(false);
    const normalizedThinking = thinking?.trim();
    const normalizedSummary = summary.trim();
    const summaryClassName = "ai-message-summary";
    const hasToolCalls = toolCalls.length > 0;
    const showFooterTime =
      !isStreaming && !hasToolCalls && showMessageTime && Boolean(timestamp);
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
    // 空响应终态（Rust 标记 empty_response / 前端「completed 且完全无载荷」兜底）
    // 由下方重试提示以终态形态承载，原因与结果文案不再重复一行。
    const isRetryExhaustedTerminal = interruptionReason === "empty_response";
    const incompleteReasonMessage = isRetryExhaustedTerminal
      ? null
      : interruptionReason === "unexpected_eof"
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
      // 「重试已耗尽」已由重试提示标题承载，避免同一件事说两遍。
      isRetryExhaustedTerminal && recoveryOutcome === "retry_exhausted"
        ? null
        : recoveryOutcome === "partial_threshold"
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
            tc.sensitiveCommandMatches && tc.sensitiveCommandMatches.length > 0,
        ),
      [pendingToolAuthorizations],
    );
    const normalAuthorizations = useMemo(
      () =>
        pendingToolAuthorizations.filter(
          (tc) =>
            !tc.sensitiveCommandMatches ||
            tc.sensitiveCommandMatches.length === 0,
        ),
      [pendingToolAuthorizations],
    );

    // 相邻的并行 imagegen 调用合并为统一画廊（生成中占位 → 逐个填充）
    const groupedToolCalls = useMemo(
      () => groupToolCalls(toolCalls),
      [toolCalls],
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
      <article
        className="ai-message"
        aria-label={t("chat.aiResponse", { defaultValue: "AI response" })}
        onClickCapture={(event) => {
          if (!onToggleFileArtifact) return;
          const target = event.target;
          if (!(target instanceof Element)) return;
          // tcn-header 上的 HTML 预览按钮：切换对应文件卡片
          const previewButton = target.closest<HTMLElement>(
            `[${HTML_FILE_PREVIEW_ATTR}]`,
          );
          if (previewButton) {
            event.preventDefault();
            event.stopPropagation();
            const path = resolveArtifactPath(
              previewButton.getAttribute(HTML_FILE_PREVIEW_ATTR) ?? "",
              artifactWorkspace,
            );
            if (path) onToggleFileArtifact(artifactFileKey(path));
            return;
          }
          if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey)
            return;
          const anchor = target.closest<HTMLAnchorElement>("a[href]");
          const href = anchor?.getAttribute("href");
          if (!href) return;
          const path = resolveArtifactHref(href, artifactWorkspace);
          if (!path || !onToggleFileArtifact(artifactFileKey(path), true))
            return;
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        {/* data-quote-source：划词引用的有效区域（AI 正文 / 思考块） */}
        <div className="ai-message-content" data-quote-source="true">
          {title ? <h2>{title}</h2> : null}

          {/* 1. Thinking — the block auto-collapses once the thinking phase
              ends (first content delta / stream end) unless the user has
              expanded or collapsed it manually. */}
          {normalizedThinking ? (
            <ThinkingBlock
              content={normalizedThinking}
              isStreaming={isStreaming}
              isThinkingActive={
                Boolean(isStreaming) && Boolean(isThinkingActive)
              }
              durationMs={thinkingDurationMs}
              tokenCount={thinkingTokenCount}
            />
          ) : null}

          {/* 2. Body / Summary — 正文与失败原因独立，切换原始 Markdown 不隐藏错误。 */}
          {isError ? (
            <AiErrorNotice
              message={failureReason?.trim() || t("chat.error.missingReason")}
            />
          ) : null}
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
              timestamp={timestamp}
              isRunning={toolCalls.some(
                (tc) =>
                  tc.status === "running" ||
                  tc.correction?.status === "running",
              )}
              hasError={toolCalls.some((tc) => tc.status === "error")}
            >
              {groupedToolCalls.map((item) =>
                item.type === "gallery" ? (
                  <ImageGenGallery key={item.key} toolCalls={item.toolCalls} />
                ) : item.type === "questionGroup" ? (
                  <AskUserQuestionGroup
                    key={item.key}
                    toolCalls={item.toolCalls}
                  />
                ) : (
                  <ToolCallItem
                    key={item.key}
                    toolCall={item.toolCall}
                    conversationId={conversationId}
                    messageId={messageId}
                    updateSessionMessages={updateSessionMessages}
                    hookExecutions={hooksByInteractionId.get(
                      item.toolCall.interactionId,
                    )}
                  />
                ),
              )}
            </ToolCallGroup>
          ) : null}

          {fileArtifacts?.map((artifact) => (
            <ChatFileArtifactCard
              key={`${conversationId}:${artifact.key}:${artifact.revision}:${artifact.blocked}`}
              artifact={artifact}
              workspace={artifactWorkspace}
              onClose={onToggleFileArtifact}
            />
          ))}

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

          {/* 5. 流式重试提示（流式指示器与「停止中」由会话级指示槽统一
              承载，见 ChatStreamIndicator，不再挂在单条消息内部）。 */}
          {isRetrying ? (
            <StreamRetryNotice
              attempt={retryAttempt}
              error={retryError}
              backoffMs={retryBackoffMs}
              backoffStartedAt={retryBackoffStartedAt}
            />
          ) : null}

          {/* 5b. 重试预算耗尽的终态：复用同一条重试提示（静态告警图标 +
              「重试已耗尽 (N)」+ 错误详情 + 复制），让「上游连续返回空响应」
              与重试过程共享同一处可观测 UI；重载后按落库的 empty_response
              原因同样渲染（此时仅缺尝试序号与上游原文，回退到通用说明）。 */}
          {!isRetrying && isRetryExhaustedTerminal ? (
            <StreamRetryNotice
              attempt={retryAttempt}
              error={retryError ?? t("chat.incomplete.reason.emptyResponse")}
              status="exhausted"
            />
          ) : null}

          {/* 6. Persisted incomplete notice —— 空响应终态已由上方重试提示
              （status="exhausted"，含「重试已耗尽 (N)」与上游错误原文）完整
              承载，这里不再叠加第二张卡片重复说明同一件事。 */}
          {incompleteVariantMessage && !isRetryExhaustedTerminal ? (
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

        {footerContent}
        {/* 7. Actions */}
        {showFooterTime || (showActions && conversationId && onFork) ? (
          <div className="ai-message-footer">
            {showFooterTime ? (
              <MessageTimestamp
                timestamp={timestamp}
                className="ai-message-time"
              />
            ) : null}
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
          </div>
        ) : null}
      </article>
    );
  },
);

AiResponse.displayName = "AiResponse";
