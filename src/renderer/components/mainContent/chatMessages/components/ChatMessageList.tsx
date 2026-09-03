import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Bot,
  Database,
  Gauge,
  GitFork,
  Repeat,
  Sigma,
  Timer,
  Zap,
} from "lucide-react";
import { Tooltip } from "../../../common/Tooltip";
import { useI18n } from "../../../../i18n";
import { formatTokens } from "../../../../utils/formatTokens";
import { AiResponse } from "./AiResponse";
import { CompactionMessage } from "./CompactionMessage";
import { UserMessage } from "./UserMessage";
import { VirtualizedMessage } from "./VirtualizedMessage";
import { HookExecutionUI } from "../toolCalls/HookExecutionUI";
import type {
  ChatConversationMessage,
  ToolCallInfo,
} from "../utils/conversationTypes";
import { useViewportVirtualization } from "../hooks/useViewportVirtualization";
import { useChatConversationContext } from "./ChatConversationContext";

const formatDuration = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m${remainingSeconds}s`;
};

type MessageContentProps = {
  message: ChatConversationMessage;
  isStreaming: boolean;
  isAborting: boolean;
  lastAssistantMessageId: string | undefined;
  activeConversationId: string | undefined;
  canRollback: boolean;
  rollbackPreparingMessageId: string | null;
  pendingToolAuthorizations: ToolCallInfo[];
  onRollback: (messageId: string) => void;
  onFork: (conversationId: string, upToResponseId: string) => void;
  onApproveToolAuthorization: (toolCall: ToolCallInfo) => void;
  onApproveToolAuthorizationAlways: (toolCall: ToolCallInfo) => void;
  onRejectToolAuthorization: (
    toolCall: ToolCallInfo,
    reason: string,
    userProvidedReason?: boolean,
  ) => void;
};

/**
 * 单条消息的内容渲染（memo 化），配合 VirtualizedMessage 组成两道闸门。
 *
 * 流式期间会话统计字段（token 数/耗时）高频更新会让 context 值变化，
 * ChatMessageList 与 VirtualizedMessage 随之重新渲染——但历史消息的
 * message 引用保持稳定，memo 浅比较直接拦截，整棵消息子树（AiResponse、
 * 思考块、工具调用卡片）完全不会执行。只有最后一条流式消息的 message
 * 引用逐 token 变化，重渲染是必要的（内容确实在变）。
 *
 * 注意：所有 props 必须是稳定引用（useCallback / 低频 state），否则
 * memo 拦截形同虚设。
 */
const MessageContent = memo(
  ({
    message,
    isStreaming,
    isAborting,
    lastAssistantMessageId,
    activeConversationId,
    canRollback,
    rollbackPreparingMessageId,
    pendingToolAuthorizations,
    onRollback,
    onFork,
    onApproveToolAuthorization,
    onApproveToolAuthorizationAlways,
    onRejectToolAuthorization,
  }: MessageContentProps): React.JSX.Element | null => {
    if (message.role === "user") {
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
          isStreaming={isStreaming}
          canRollback={canRollback}
          isRollbackPreparing={rollbackPreparingMessageId === message.id}
          onRollback={() => onRollback(message.id)}
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
      (message.toolCalls ?? []).map((tc) => tc.interactionId),
    );
    const footerHookExecutions = (message.hookExecutions ?? []).filter(
      (record) =>
        !record.toolCallInteractionId ||
        !boundInteractionIds.has(record.toolCallInteractionId),
    );

    // - All assistant messages without tool calls (1-on-1 conversations)
    // - The last assistant message when it has tool calls (AI Loop ending)
    // - Never on a message that is currently streaming
    // - Never while the conversation-level streaming is active (AI Loop in
    //   progress). Without this guard, a message that finishes streaming
    //   but precedes a tool-call round would briefly show actions that
    //   vanish when the next assistant turn starts — causing a flash.
    const showActions =
      !isStreaming && !isMessageStreaming && (!hasToolCalls || isLastAssistant);

    return (
      <div className="chat-message-hook-container">
        <AiResponse
          isStreaming={message.status === "sending"}
          isAborting={isLastAssistant && isAborting}
          summary={message.content}
          thinking={message.thinking}
          thinkingDurationMs={message.thinkingDurationMs}
          thinkingTokenCount={message.thinkingTokenCount}
          isThinkingActive={message.isThinkingActive}
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
                    activeConversationId,
                )
              : undefined
          }
          onApproveToolAuthorization={onApproveToolAuthorization}
          onApproveToolAuthorizationAlways={onApproveToolAuthorizationAlways}
          onRejectToolAuthorization={onRejectToolAuthorization}
          conversationId={activeConversationId}
          responseId={message.responseId}
          onFork={onFork}
        />
        {footerHookExecutions.length > 0 ? (
          <HookExecutionUI executions={footerHookExecutions} />
        ) : null}
      </div>
    );
  },
);

MessageContent.displayName = "MessageContent";

type ChatMessageListProps = {
  messages: ChatConversationMessage[];
  isStreaming: boolean;
  isAborting: boolean;
  canRollback: boolean;
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
  canRollback,
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
    visionAnalysis,
    triggeredByTask,
    conversationTokenUsage,
    lastRunDurationMs,
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

  // Stable callback: MessageContent is memoized, so every prop must keep a
  // stable reference or the memo bail-out never triggers.
  const handleFork = useCallback(
    (conversationId: string, upToResponseId: string): void => {
      void handleForkConversation(conversationId, upToResponseId);
    },
    [handleForkConversation],
  );

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

  // 最后一条 assistant 消息使用的模型：AI 流程结束后摘要条展示用。
  const lastModel = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant" && messages[i].model) {
        return messages[i].model;
      }
    }
    return undefined;
  }, [messages]);

  // AI 流程完全结束后，在消息列表底部以 fork-divider 同款分隔条展示本次
  // 任务的汇总信息：总耗时、总 Token 消耗、缓存命中情况、模型。
  const renderRunSummary = (): React.JSX.Element | null => {
    if (isStreaming || isAborting) {
      return null;
    }
    const hasAssistant = messages.some((m) => m.role === "assistant");
    if (!hasAssistant) {
      return null;
    }
    // 整个会话的累计统计（每次 run 结束累加，历史会话从 DB 回显）。
    // 旧版本会话没有这些数据，不显示，避免展示不完整数据造成误解。
    const usage = conversationTokenUsage;
    const totalTokens = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
    const cacheRead = usage?.cacheReadInputTokens ?? 0;
    const cacheWrite = usage?.cacheCreationInputTokens ?? 0;
    // 没有任何累计统计（旧版本会话没有这些数据）就不显示整条摘要，
    // 避免展示不完整数据造成误解。
    const hasStats =
      lastRunDurationMs > 0 ||
      totalTokens > 0 ||
      cacheRead > 0 ||
      cacheWrite > 0;
    if (!hasStats) {
      return null;
    }

    const items: React.JSX.Element[] = [];
    if (lastRunDurationMs > 0) {
      items.push(
        <Tooltip
          key="duration"
          content={t("chat.runSummary.duration", {
            defaultValue: "当前会话累计耗时",
          })}
        >
          <span className="chat-run-summary-item">
            <Timer size={12} strokeWidth={1.8} aria-hidden="true" />
            <span>{formatDuration(lastRunDurationMs)}</span>
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
    if (lastRunDurationMs > 0 && (usage?.outputTokens ?? 0) > 0) {
      // 平均输出吞吐 = 累计输出 Token / 累计耗时（秒）。分子只用
      // outputTokens：input 含每次工具调用重发的上下文（占大头），
      // 混入会把数值虚高到几千。耗时含工具执行等待，因此该值是
      // 实际生成速度的保守下界。
      const tokensPerSecond =
        (usage?.outputTokens ?? 0) / (lastRunDurationMs / 1000);
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
            <Bot size={12} strokeWidth={1.8} aria-hidden="true" />
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
          (tc) => tc.authorizationConversationId === activeConversationId,
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

  // 翻页（loadOlder）往顶部插入的新消息前缀：比较本次与上次渲染的首条
  // 消息 id 得出。传给虚拟化 hook，让新页在 IO 首批报告前就以真实内容
  // 挂载（见 useViewportVirtualization 的 forceVisible 机制）——若新页
  // 先以 80px 占位符存在，ChatContent 的翻页滚动恢复按占位符几何校正必
  // 然偏小，新内容涌入后再把视口内容往下挤，观感就是「被挤下去」。
  const [newlyPrependedIds, setNewlyPrependedIds] = useState<
    ReadonlySet<string>
  >(() => new Set<string>());
  const prevFirstMessageIdRef = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const prevFirst = prevFirstMessageIdRef.current;
    prevFirstMessageIdRef.current = messages[0]?.id;
    if (
      prevFirst === undefined ||
      messages.length === 0 ||
      messages[0].id === prevFirst
    ) {
      return;
    }
    const ids = new Set<string>();
    for (const message of messages) {
      if (message.id === prevFirst) break;
      ids.add(message.id);
    }
    if (ids.size > 0) {
      setNewlyPrependedIds(ids);
    }
  }, [messages]);

  const virtualization = useViewportVirtualization(
    scrollContainerRef,
    pinnedIds,
    initialVisibleIds,
    newlyPrependedIds,
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
          <span
            className="chat-vision-status-model"
            title={visionAnalysis.model}
          >
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
    index: number,
  ): React.JSX.Element => {
    // Tool messages return null; render an empty keyed placeholder so React
    // keeps stable keys across renders.
    if (message.role === "tool") {
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
          <MessageContent
            message={message}
            isStreaming={isStreaming}
            isAborting={isAborting}
            lastAssistantMessageId={lastAssistantMessageId}
            activeConversationId={activeConversationId}
            canRollback={canRollback}
            rollbackPreparingMessageId={rollbackPreparingMessageId}
            pendingToolAuthorizations={pendingToolAuthorizations}
            onRollback={handleRollback}
            onFork={handleFork}
            onApproveToolAuthorization={approveToolAuthorization}
            onApproveToolAuthorizationAlways={approveToolAuthorizationAlways}
            onRejectToolAuthorization={rejectToolAuthorization}
          />
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
        {renderRunSummary()}
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
        renderItem(message, forkDividerIndex + index),
      )}
      {renderVisionStatusCard()}
      {renderRunSummary()}
    </div>
  );
};
