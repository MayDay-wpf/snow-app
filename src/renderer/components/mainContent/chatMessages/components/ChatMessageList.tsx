import { useCallback, useMemo } from "react";
import { GitFork, Zap } from "lucide-react";
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

// 初始可见窗口大小:挂载时(切换会话)只渲染「顶部几条 + 底部窗口」的
// 真实内容,避免首帧同步全量渲染大会话阻塞主线程。窗口按可见消息计数
// (跳过 tool 消息),数值取小足够覆盖首屏 + 初始定位到底部后的视口。
const INITIAL_VIRTUAL_HEAD_COUNT = 3;
const INITIAL_VIRTUAL_WINDOW_SIZE = 24;

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
    rollbackPreparingMessageId,
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
    triggeredByTask,
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

  // 挂载时的初始可见窗口(仅当列表大到窗口无法覆盖全部时才起作用):
  // 切换会话后 chat-area 整体重建,新 ChatMessageList 挂载时若以
  // visibleIds === null 起步,首次提交会同步全量渲染整个消息列表
  // (运行中的大会话可达数百毫秒),阻塞渲染进程主线程,期间 loading
  // 旋转与骨架屏脉冲等 CSS 动画全部冻结。这里直接以「顶部几条 + 底部
  // 窗口 + 固定消息」作为起始可见集,其余消息首帧即为占位符;
  // IntersectionObserver 的首次报告会把估算集合替换为真实相交集合。
  const initialVisibleIds = useMemo(() => {
    if (messages.length === 0) {
      return null;
    }
    const ids = new Set<string>();
    let headCount = 0;
    for (
      let i = 0;
      i < messages.length && headCount < INITIAL_VIRTUAL_HEAD_COUNT;
      i++
    ) {
      if (messages[i].role === "tool") continue;
      headCount++;
      ids.add(messages[i].id);
    }
    let tailCount = 0;
    for (
      let i = messages.length - 1;
      i >= 0 && tailCount < INITIAL_VIRTUAL_WINDOW_SIZE;
      i--
    ) {
      if (messages[i].role === "tool") continue;
      tailCount++;
      ids.add(messages[i].id);
    }
    for (const id of pinnedIds) {
      ids.add(id);
    }
    return ids;
  }, [messages, pinnedIds]);

  const virtualization = useViewportVirtualization(
    scrollContainerRef,
    pinnedIds,
    initialVisibleIds
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
                isRollbackPreparing={rollbackPreparingMessageId === message.id}
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
            isRollbackPreparing={rollbackPreparingMessageId === message.id}
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
            incompleteVariant={message.incompleteVariant}
            interruptionReason={message.interruptionReason}
            recoveryOutcome={message.recoveryOutcome}
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

  // Informational banner shown when the active conversation was created by a
  // scheduled task firing: which task triggered it and when. Rendered above
  // the first message so the origin of the conversation is always visible.
  const renderTriggeredByTaskBanner = (): React.JSX.Element | null => {
    if (!triggeredByTask) {
      return null;
    }
    let timeLabel = "";
    const ms = Date.parse(triggeredByTask.triggeredAt);
    if (!Number.isNaN(ms)) {
      timeLabel = new Date(ms).toLocaleTimeString();
    }
    return (
      <div className="chat-task-triggered-banner" role="note">
        <Zap size={12} strokeWidth={1.9} aria-hidden="true" />
        <span className="chat-task-triggered-text">
          {t("chat.triggeredByTask", {
            defaultValue: "Triggered by scheduled task: {{name}}",
            values: { name: triggeredByTask.name },
          })}
        </span>
        {timeLabel && (
          <span className="chat-task-triggered-time">{timeLabel}</span>
        )}
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
        {renderTriggeredByTaskBanner()}
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
      {renderTriggeredByTaskBanner()}
      {beforeFork.map((message, index) => renderItem(message, index))}
      {renderForkDivider()}
      {afterFork.map((message, index) =>
        renderItem(message, forkDividerIndex + index)
      )}
      {renderVisionStatusCard()}
    </div>
  );
};
