import { useCallback, useMemo } from "react";
import { GitFork } from "lucide-react";
import { useI18n } from "../../../../i18n";
import { AiResponse } from "./AiResponse";
import { CompactionMessage } from "./CompactionMessage";
import { UserMessage } from "./UserMessage";
import { VirtualizedMessage } from "./VirtualizedMessage";
import { HookExecutionUI } from "../toolCalls/HookExecutionUI";
import type { ChatConversationMessage } from "../utils/conversationTypes";
import { useViewportVirtualization } from "../hooks/useViewportVirtualization";
import { useChatConversationContext } from "./ChatConversationContext";

type ChatMessageListProps = {
  messages: ChatConversationMessage[];
  isStreaming: boolean;
  isAborting: boolean;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
};

export const ChatMessageList = ({
  messages,
  isStreaming,
  isAborting,
  scrollContainerRef,
}: ChatMessageListProps): React.JSX.Element => {
  const { t } = useI18n();
  const {
    activeConversationId,
    handleForkConversation,
    handleSelectConversation,
    handleRollback,
    forkedFromConversationId,
    forkMessageCount,
    pendingToolAuthorizations,
    approveToolAuthorization,
    approveToolAuthorizationAlways,
    rejectToolAuthorization,
    streamTokenCount,
    streamElapsedMs,
    streamTtftMs,
    visionAnalysis,
  } = useChatConversationContext();

  const lastAssistantMessageId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") {
        return messages[i].id;
      }
    }
    return undefined;
  }, [messages]);

  // The fork divider should appear after the fork point (the messages
  // copied from the source conversation), not after all messages.
  // forkMessageCount records how many messages were copied at fork time.
  // Rendered messages exclude tool-role messages, so we need to count
  // visible messages up to that point.
  const forkDividerIndex = useMemo(() => {
    if (
      !forkedFromConversationId ||
      forkMessageCount === undefined ||
      forkMessageCount <= 0
    ) {
      return -1;
    }
    // Count visible (non-tool) messages. forkMessageCount counts all
    // DB messages including tool messages, but tool messages are filtered
    // out during rendering. We iterate the messages array and find the
    // index after the Nth visible message.
    let visibleCount = 0;
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === "tool") continue;
      visibleCount++;
      if (visibleCount === forkMessageCount) {
        return i + 1; // divider goes after this message
      }
    }
    // If there are fewer visible messages than forkMessageCount (e.g.
    // tool messages reduced the count), place divider at the end.
    return messages.length;
  }, [forkedFromConversationId, forkMessageCount, messages]);

  const showForkDivider =
    forkDividerIndex >= 0 && forkDividerIndex < messages.length;

  const handleFork = (conversationId: string, upToResponseId: string): void => {
    void handleForkConversation(conversationId, upToResponseId);
  };

  const handleForkLinkClick = (): void => {
    if (forkedFromConversationId) {
      void handleSelectConversation(forkedFromConversationId);
    }
  };

  const renderForkDivider = (): React.JSX.Element => (
    <div className="chat-fork-divider">
      <span className="chat-fork-divider-line" />
      <button
        type="button"
        className="chat-fork-divider-link"
        onClick={handleForkLinkClick}
      >
        <GitFork size={13} strokeWidth={1.8} />
        <span>
          {t("chat.forkedFromConversation", {
            defaultValue: "Forked from conversation",
          })}
        </span>
      </button>
      <span className="chat-fork-divider-line" />
    </div>
  );

  // Pinned message ids: the streaming (last assistant) message must always be
  // rendered so the live output is never unmounted, and any message carrying a
  // pending tool authorization must stay mounted so the approval dialog is not
  // unmounted while waiting for the user.
  const pinnedIds = useMemo(() => {
    const pinned = new Set<string>();
    if (lastAssistantMessageId) {
      pinned.add(lastAssistantMessageId);
    }
    for (const msg of messages) {
      const hasPendingAuth =
        msg.role === "assistant" &&
        msg.toolCalls?.some(
          (tc) => tc.authorizationConversationId === activeConversationId
        );
      if (hasPendingAuth) {
        pinned.add(msg.id);
      }
    }
    return pinned;
  }, [activeConversationId, lastAssistantMessageId, messages]);

  const virtualization = useViewportVirtualization(
    scrollContainerRef,
    pinnedIds
  );

  const renderMessageContent = useCallback(
    (message: ChatConversationMessage): React.JSX.Element | null => {
      if (message.role === "user") {
        if (message.isContextCompaction) {
          return (
            <div className="chat-message-hook-container">
              <CompactionMessage
                content={message.content}
                isStreaming={isStreaming}
                onRollback={() => handleRollback(message.id)}
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
            isStreaming={isStreaming}
            onRollback={() => handleRollback(message.id)}
            hookExecutions={message.hookExecutions}
          />
        );
      }

      // Skip standalone tool messages — their results are already
      // rendered inside the preceding assistant message's ToolCallItem.
      if (message.role === "tool") {
        return null;
      }

      const isLastAssistant = message.id === lastAssistantMessageId;
      const hasToolCalls = (message.toolCalls?.length ?? 0) > 0;
      const isMessageStreaming = message.status === "sending";

      // Hook records bound to a tool call of this message (via
      // toolCallInteractionId) are rendered inside the tool card itself.
      // Only unbound records — or bound records whose card is not in this
      // message (should not happen) — stay in the message footer.
      const boundInteractionIds = new Set(
        (message.toolCalls ?? []).map((tc) => tc.interactionId)
      );
      const footerHookExecutions = (message.hookExecutions ?? []).filter(
        (record) =>
          !record.toolCallInteractionId ||
          !boundInteractionIds.has(record.toolCallInteractionId)
      );

      // - All assistant messages without tool calls (1-on-1 conversations)
      // - The last assistant message when it has tool calls (AI Loop ending)
      // - Never on a message that is currently streaming
      // - Never while the conversation-level streaming is active (AI Loop in
      //   progress). Without this guard, a message that finishes streaming
      //   but precedes a tool-call round would briefly show actions that
      //   vanish when the next assistant turn starts — causing a flash.
      const showActions =
        !isStreaming &&
        !isMessageStreaming &&
        (!hasToolCalls || isLastAssistant);

      return (
        <div className="chat-message-hook-container">
          <AiResponse
            isStreaming={message.status === "sending"}
            isAborting={isLastAssistant && isAborting}
            isRetrying={isLastAssistant && message.isRetrying}
            retryAttempt={message.retryAttempt}
            retryError={message.retryError}
            streamTokenCount={
              isLastAssistant && isStreaming ? streamTokenCount : undefined
            }
            streamElapsedMs={
              isLastAssistant && isStreaming ? streamElapsedMs : undefined
            }
            streamTtftMs={
              isLastAssistant && isStreaming ? streamTtftMs : undefined
            }
            summary={message.content}
            thinking={message.thinking}
            showActions={showActions}
            toolCalls={message.toolCalls}
            hookExecutions={message.hookExecutions}
            pendingToolAuthorizations={
              isLastAssistant
                ? pendingToolAuthorizations.filter(
                    (toolCall) =>
                      toolCall.authorizationConversationId ===
                      activeConversationId
                  )
                : undefined
            }
            onApproveToolAuthorization={approveToolAuthorization}
            onApproveToolAuthorizationAlways={approveToolAuthorizationAlways}
            onRejectToolAuthorization={rejectToolAuthorization}
            conversationId={activeConversationId}
            responseId={message.responseId}
            onFork={handleFork}
          />
          {footerHookExecutions.length > 0 ? (
            <HookExecutionUI executions={footerHookExecutions} />
          ) : null}
        </div>
      );
    },
    [
      activeConversationId,
      approveToolAuthorization,
      approveToolAuthorizationAlways,
      isAborting,
      isStreaming,
      lastAssistantMessageId,
      pendingToolAuthorizations,
      rejectToolAuthorization,
      streamElapsedMs,
      streamTokenCount,
      streamTtftMs,
    ]
  );

  // Intermediate status card shown while the backend describes user images
  // with the external vision model (textify pass). Lives at the end of the
  // message list, above the input area; disappears on the final done/error
  // event. Fixed min-height keeps the virtualization scrollbar stable.
  const renderVisionStatusCard = (): React.JSX.Element | null => {
    if (
      !visionAnalysis ||
      (visionAnalysis.phase !== "describing" &&
        visionAnalysis.phase !== "cached")
    ) {
      return null;
    }
    return (
      <div className="chat-vision-status" role="status">
        <span className="chat-vision-status-spinner" aria-hidden="true" />
        <span className="chat-vision-status-text">
          {t("chat.visionAnalyzing", {
            defaultValue: "Analyzing images with vision model…",
          })}
        </span>
        <span className="chat-vision-status-progress">
          {visionAnalysis.index}/{visionAnalysis.total}
        </span>
        {visionAnalysis.model ? (
          <span className="chat-vision-status-model" title={visionAnalysis.model}>
            {visionAnalysis.model}
          </span>
        ) : null}
      </div>
    );
  };

  // Keep the fork divider outside virtualization so it is always present when
  // visible (it is a single small node and never needs height preservation).
  const renderItem = (
    message: ChatConversationMessage,
    index: number
  ): React.JSX.Element => {
    const content = renderMessageContent(message);

    // Tool messages return null; render an empty keyed placeholder so React
    // keeps stable keys across renders.
    if (content === null) {
      return <div className="chat-message-hidden" key={message.id} />;
    }

    const className = `chat-message-group ${
      message.status ? `is-${message.status}` : ""
    }`.trim();

    return (
      <VirtualizedMessage
        id={message.id}
        key={message.id}
        virtualization={virtualization}
      >
        <div className={className} data-message-index={index}>
          {content}
        </div>
      </VirtualizedMessage>
    );
  };

  // If no fork divider needed, render messages directly
  if (!showForkDivider) {
    return (
      <div className="chat-message-list">
        {messages.map((message, index) => renderItem(message, index))}
        {forkDividerIndex === messages.length && forkedFromConversationId
          ? renderForkDivider()
          : null}
        {renderVisionStatusCard()}
      </div>
    );
  }

  // Split messages at the fork divider index
  const beforeFork = messages.slice(0, forkDividerIndex);
  const afterFork = messages.slice(forkDividerIndex);

  return (
    <div className="chat-message-list">
      {beforeFork.map((message, index) => renderItem(message, index))}
      {renderForkDivider()}
      {afterFork.map((message, index) =>
        renderItem(message, forkDividerIndex + index)
      )}
      {renderVisionStatusCard()}
    </div>
  );
};
