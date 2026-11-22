import { TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";

import { useI18n } from "../../../../i18n";
import { AiErrorNotice } from "../components/AiErrorNotice";
import { AiResponseActions } from "../components/AiResponseActions";
import { CompactionMessage } from "../components/CompactionMessage";
import { useHtmlArtifactOpen } from "../components/HtmlArtifactOpenContext";
import { MarkdownBlock } from "../components/markdownRenderer";
import { MessageTimestamp } from "../components/MessageTimestamp";
import { PluginMessageFooters } from "../components/PluginMessageFooters";
import { StreamRetryNotice } from "../components/StreamRetryNotice";
import { ToolCallItem } from "../components/ToolCallItem";
import { UserMessage } from "../components/UserMessage";
import { resolveArtifactHref } from "../components/chatFileArtifacts";
import { ToolAuthorizationDialog } from "../dialogs/ToolAuthorizationDialog";
import { AskUserQuestionGroup } from "../toolCalls/AskUserQuestionGroup";
import { ImageGenGallery } from "../toolCalls/ImageGenGallery";
import { HookExecutionUI } from "../toolCalls/HookExecutionUI";
import { SensitiveCommandConfirmDialog } from "../toolCalls/SensitiveCommandConfirmDialog";
import type {
  ConversationContextValue,
  ToolCallInfo,
} from "../utils/conversationTypes";
import { useMessageTimeVisible } from "../utils/messageTimeVisibility";
import type { ChatRunStats } from "../utils/types";
import { MinimalSameRunHeader } from "./MinimalSameRunHeader";
import { MinimalToolRunHeader } from "./MinimalToolRunHeader";
import type { MinimalRow } from "./types";

export type MinimalRowContentProps = {
  row: MinimalRow;
  isStreaming: boolean;
  canRollback: boolean;
  rollbackPreparingMessageId: string | null;
  activeConversationId?: string;
  artifactWorkspace?: string;
  pendingToolAuthorizations: readonly ToolCallInfo[];
  updateSessionMessages: ConversationContextValue["updateSessionMessages"];
  runStats: ChatRunStats | null;
  onRollback: (messageId: string) => void;
  onFork: (conversationId: string, upToResponseId: string) => void;
  onApproveToolAuthorization: (toolCall: ToolCallInfo) => void;
  onApproveToolAuthorizationAlways: (toolCall: ToolCallInfo) => void;
  onRejectToolAuthorization: (
    toolCall: ToolCallInfo,
    reason: string,
    userProvidedReason?: boolean,
  ) => void;
  onToggleRow: (key: string, fallback: boolean) => void;
  renderForkDivider: () => React.JSX.Element;
};

/**
 * 极简模式单行内容。
 *
 * 只负责「这一行画什么」，虚拟化、占位、展开状态都在列表层；与经典 /
 * 简洁路径使用的 AiResponse / MessageContent 完全分开。
 */
export const MinimalRowContent = ({
  row,
  isStreaming,
  canRollback,
  rollbackPreparingMessageId,
  activeConversationId,
  artifactWorkspace,
  pendingToolAuthorizations,
  updateSessionMessages,
  runStats,
  onRollback,
  onFork,
  onApproveToolAuthorization,
  onApproveToolAuthorizationAlways,
  onRejectToolAuthorization,
  onToggleRow,
  renderForkDivider,
}: MinimalRowContentProps): React.JSX.Element | null => {
  const { t } = useI18n();
  const openHtmlArtifact = useHtmlArtifactOpen();
  const showMessageTime = useMessageTimeVisible();
  const [showRawMarkdown, setShowRawMarkdown] = useState(false);

  const visibleAuthorizations = useMemo(
    () =>
      pendingToolAuthorizations.filter(
        (toolCall) =>
          toolCall.authorizationConversationId === activeConversationId,
      ),
    [pendingToolAuthorizations, activeConversationId],
  );
  const sensitiveCommandAuthorizations = useMemo(
    () =>
      visibleAuthorizations.filter(
        (toolCall) =>
          toolCall.sensitiveCommandMatches &&
          toolCall.sensitiveCommandMatches.length > 0,
      ),
    [visibleAuthorizations],
  );
  const normalAuthorizations = useMemo(
    () =>
      visibleAuthorizations.filter(
        (toolCall) =>
          !toolCall.sensitiveCommandMatches ||
          toolCall.sensitiveCommandMatches.length === 0,
      ),
    [visibleAuthorizations],
  );

  if (row.kind === "user") {
    const message = row.message;
    if (message.isContextCompaction) {
      return (
        <div className="chat-message-hook-container">
          <CompactionMessage
            content={message.content}
            isStreaming={isStreaming}
            canRollback={canRollback}
            isRollbackPreparing={rollbackPreparingMessageId === message.id}
            onRollback={() => onRollback(message.id)}
          />
          {message.hookExecutions && message.hookExecutions.length > 0 ? (
            <HookExecutionUI executions={message.hookExecutions} />
          ) : null}
        </div>
      );
    }
    return (
      <UserMessage
        content={message.content}
        timestamp={message.timestamp}
        isStreaming={isStreaming}
        canRollback={canRollback}
        isRollbackPreparing={rollbackPreparingMessageId === message.id}
        onRollback={() => onRollback(message.id)}
        hookExecutions={message.hookExecutions}
      />
    );
  }

  if (row.kind === "response") {
    const message = row.message;
    const normalizedSummary = message.content.trim();
    const isMessageStreaming = message.status === "sending";
    const isError = message.status === "error";
    const isRetrying = Boolean(message.isRetrying);
    const showFooterTime =
      !isMessageStreaming &&
      !row.hasToolCalls &&
      showMessageTime &&
      Boolean(message.timestamp);
    const incompleteVariantMessage =
      message.incompleteVariant === "partial_content"
        ? t("chat.incomplete.variant.partialContent")
        : message.incompleteVariant === "thinking_only"
          ? t("chat.incomplete.variant.thinkingOnly")
          : message.incompleteVariant === "tool_call"
            ? t("chat.incomplete.variant.toolCall")
            : message.incompleteVariant === "empty"
              ? t("chat.incomplete.variant.empty")
              : null;
    const isRetryExhaustedTerminal =
      message.interruptionReason === "empty_response";
    const incompleteReasonMessage = isRetryExhaustedTerminal
      ? null
      : message.interruptionReason === "unexpected_eof"
        ? t("chat.incomplete.reason.unexpectedEof")
        : message.interruptionReason === "read_error"
          ? t("chat.incomplete.reason.readError")
          : message.interruptionReason === "idle_timeout"
            ? t("chat.incomplete.reason.idleTimeout")
            : message.interruptionReason === "explicit_incomplete"
              ? t("chat.incomplete.reason.explicitIncomplete")
              : message.interruptionReason === "output_limit"
                ? t("chat.incomplete.reason.outputLimit")
                : null;
    const recoveryOutcomeMessage =
      isRetryExhaustedTerminal && message.recoveryOutcome === "retry_exhausted"
        ? null
        : message.recoveryOutcome === "partial_threshold"
          ? t("chat.incomplete.outcome.partialThreshold")
          : message.recoveryOutcome === "retry_exhausted"
            ? t("chat.incomplete.outcome.retryExhausted")
            : message.recoveryOutcome === "non_retriable"
              ? t("chat.incomplete.outcome.nonRetriable")
              : null;
    const responseId = row.runTailResponseId ?? message.responseId;

    return (
      <article
        className="ai-message"
        aria-label={t("chat.aiResponse", { defaultValue: "AI response" })}
        onClickCapture={(event) => {
          const target = event.target;
          if (!(target instanceof Element)) return;
          if (
            event.ctrlKey ||
            event.metaKey ||
            event.altKey ||
            event.shiftKey
          ) {
            return;
          }
          const anchor = target.closest<HTMLAnchorElement>("a[href]");
          const href = anchor?.getAttribute("href");
          if (!href) return;
          // 正文里的 HTML 文件链接：直接在内置浏览器打开
          const path = resolveArtifactHref(href, artifactWorkspace);
          if (!path || !openHtmlArtifact?.(path)) return;
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <div className="ai-message-content" data-quote-source="true">
          {isError ? (
            <AiErrorNotice
              message={
                message.failureReason?.trim() || t("chat.error.missingReason")
              }
            />
          ) : null}
          {normalizedSummary ? (
            showRawMarkdown ? (
              <pre className="ai-message-raw">{normalizedSummary}</pre>
            ) : (
              <MarkdownBlock
                className="ai-message-summary"
                content={normalizedSummary}
                streaming={isMessageStreaming}
              />
            )
          ) : null}
          {isRetrying ? (
            <StreamRetryNotice
              attempt={message.retryAttempt}
              error={message.retryError}
              backoffMs={message.retryBackoffMs}
              backoffStartedAt={message.retryBackoffStartedAt}
            />
          ) : null}
          {!isRetrying && isRetryExhaustedTerminal ? (
            <StreamRetryNotice
              attempt={message.retryAttempt}
              error={
                message.retryError ??
                t("chat.incomplete.reason.emptyResponse")
              }
              status="exhausted"
            />
          ) : null}
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

        {activeConversationId ? (
          <>
            <PluginMessageFooters
              key={`${activeConversationId}:${message.id}`}
              conversationId={activeConversationId}
              messageId={message.id}
            />
            {row.runTailId ? (
              <PluginMessageFooters
                key={`${activeConversationId}:${row.runTailId}`}
                conversationId={activeConversationId}
                messageId={row.runTailId}
              />
            ) : null}
          </>
        ) : null}

        {showFooterTime ||
        (row.showActions && activeConversationId && onFork) ? (
          <div className="ai-message-footer">
            {showFooterTime ? (
              <MessageTimestamp
                timestamp={message.timestamp}
                className="ai-message-time"
              />
            ) : null}
            {row.showActions && activeConversationId && onFork ? (
              <AiResponseActions
                content={normalizedSummary}
                conversationId={activeConversationId}
                responseId={responseId}
                showRawMarkdown={showRawMarkdown}
                onToggleRawMarkdown={() =>
                  setShowRawMarkdown((prev) => !prev)
                }
                onFork={onFork}
                runStats={row.isLastAssistant ? runStats : null}
              />
            ) : null}
          </div>
        ) : null}

        {row.footerHookExecutions.length > 0 ? (
          <HookExecutionUI executions={row.footerHookExecutions} />
        ) : null}
      </article>
    );
  }

  if (row.kind === "tool-run-header") {
    return (
      <MinimalToolRunHeader
        toolCalls={row.toolCalls}
        expanded={row.expanded}
        onToggle={() => onToggleRow(row.key, true)}
      />
    );
  }

  if (row.kind === "same-run-header") {
    return (
      <MinimalSameRunHeader
        toolCalls={row.toolCalls}
        expanded={row.expanded}
        onToggle={() => onToggleRow(row.key, false)}
      />
    );
  }

  if (row.kind === "tool") {
    return (
      <ToolCallItem
        toolCall={row.toolCall}
        conversationId={activeConversationId}
        messageId={row.ownerMessageId}
        updateSessionMessages={updateSessionMessages}
        hookExecutions={row.hookExecutions}
      />
    );
  }

  if (row.kind === "tool-group") {
    return row.groupKind === "gallery" ? (
      <ImageGenGallery toolCalls={row.toolCalls} />
    ) : (
      <AskUserQuestionGroup toolCalls={row.toolCalls} />
    );
  }

  if (row.kind === "authorization") {
    return (
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
    );
  }

  if (row.kind === "divider") {
    return renderForkDivider();
  }

  return null;
};
