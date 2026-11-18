import { memo } from "react";
import { AiResponse } from "./AiResponse";
import { PluginMessageFooters } from "./PluginMessageFooters";
import { CompactionMessage } from "./CompactionMessage";
import { UserMessage } from "./UserMessage";
import { HookExecutionUI } from "../toolCalls/HookExecutionUI";
import type {
  ChatConversationMessage,
  ConversationContextValue,
  ToolCallInfo,
} from "../utils/conversationTypes";
import type { ChatRunStats, ToolCallRun } from "../utils/types";

export type MessageContentProps = {
  message: ChatConversationMessage;
  /** 极简模式合并后的工具集合：取代本条消息自己的工具调用。 */
  toolRun?: ToolCallRun;
  /** 会话工作目录：正文里的 HTML 文件链接据此解析后在内置浏览器打开。 */
  artifactWorkspace?: string;
  /** 会话累计运行统计：只有最后一条 AI 响应会展示到操作栏。 */
  runStats?: ChatRunStats | null;
  isStreaming: boolean;
  lastAssistantMessageId: string | undefined;
  activeConversationId: string | undefined;
  /** 会话消息更新函数（来自 ChatConversationProvider）：透传给工具卡片做本地
   *  收口（看门狗中止未被接受时结算自己所在的 tool call）。 */
  updateSessionMessages: ConversationContextValue["updateSessionMessages"];
  canRollback: boolean;
  rollbackPreparingMessageId: string | null;
  pendingToolAuthorizations: ToolCallInfo[];
  /** 是否承载授权弹窗：通常是最后一条 AI 响应，极简模式下它被隐藏时由集合锚点代管。 */
  hostsPendingAuthorizations: boolean;
  /** 极简模式：本条代管的、被隐藏的最后一条响应的 id（无则 undefined）。
   *  只传派生标量而非消息对象：流式期间引用不变，memo 才能继续拦截。 */
  runTailId?: string;
  /** 代管响应的 responseId：分支截止点以整轮末尾的响应为准。 */
  runTailResponseId?: string;
  /** 代管响应是否仍在流式输出。 */
  runTailIsSending?: boolean;
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
export const MessageContent = memo(
  ({
    message,
    toolRun,
    artifactWorkspace,
    runStats,
    isStreaming,
    lastAssistantMessageId,
    activeConversationId,
    updateSessionMessages,
    canRollback,
    rollbackPreparingMessageId,
    pendingToolAuthorizations,
    hostsPendingAuthorizations,
    runTailId,
    runTailResponseId,
    runTailIsSending,
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
          timestamp={message.timestamp}
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

    // 代管被隐藏的最后一条响应时，本条按「最后一条」承载操作栏与统计。
    const hostsRunTail = runTailId !== undefined;
    const isLastAssistant =
      message.id === lastAssistantMessageId || hostsRunTail;
    // 极简模式：合并后的工具集合（可含后续无正文响应的工具）取代本条消息的。
    const effectiveToolCalls = toolRun ? toolRun.toolCalls : message.toolCalls;
    const effectiveHookExecutions = toolRun
      ? toolRun.hookExecutions
      : message.hookExecutions;
    const hasToolCalls = (effectiveToolCalls?.length ?? 0) > 0;
    const isMessageStreaming =
      message.status === "sending" || Boolean(runTailIsSending);
    // 分支截止点以整轮末尾的响应为准。
    const responseId = hostsRunTail ? runTailResponseId : message.responseId;

    // Hook records bound to a tool call of this message (via
    // toolCallInteractionId) are rendered inside the tool card itself.
    // Only unbound records — or bound records whose card is not in this
    // message (should not happen) — stay in the message footer.
    const boundInteractionIds = new Set(
      (effectiveToolCalls ?? []).map((tc) => tc.interactionId),
    );
    const footerHookExecutions = (effectiveHookExecutions ?? []).filter(
      (record) =>
        !record.toolCallInteractionId ||
        !boundInteractionIds.has(record.toolCallInteractionId),
    );

    // - All assistant messages without tool calls (1-on-1 conversations)
    // - The last assistant message when it has tool calls (AI Loop ending)
    // - Never on a message that is currently streaming
    // - 会话级流式进行中时只屏蔽「当前 run 的最后一条 assistant 消息」：
    //   已经定稿的历史回答（例如上一轮的结果）在发送新提示词后保持操作
    //   按钮可见。若按会话级 isStreaming 屏蔽整段历史，用户一发新消息，
    //   历史回答的复制 / 派生分支按钮就会集体消失。
    //   这条屏蔽本身仍然必要：一条刚流完、后面还要接工具轮的 assistant
    //   消息此刻也是 last，不屏蔽会在下一轮开始前闪现按钮再消失。
    const isActiveRunTail = isLastAssistant && isStreaming;
    const showActions =
      !isMessageStreaming &&
      !isActiveRunTail &&
      (!hasToolCalls || isLastAssistant);

    return (
      <div className="chat-message-hook-container">
        <AiResponse
          artifactWorkspace={artifactWorkspace}
          isStreaming={message.status === "sending"}
          isRetrying={isLastAssistant && message.isRetrying}
          retryAttempt={message.retryAttempt}
          retryError={message.retryError}
          retryBackoffMs={message.retryBackoffMs}
          retryBackoffStartedAt={message.retryBackoffStartedAt}
          isError={message.status === "error"}
          failureReason={message.failureReason}
          htmlPreviewEligible={message.htmlPreviewEligible}
          summary={message.content}
          timestamp={message.timestamp}
          thinking={message.thinking}
          thinkingDurationMs={message.thinkingDurationMs}
          thinkingTokenCount={message.thinkingTokenCount}
          isThinkingActive={message.isThinkingActive}
          incompleteVariant={message.incompleteVariant}
          interruptionReason={message.interruptionReason}
          recoveryOutcome={message.recoveryOutcome}
          showActions={showActions}
          footerContent={
            activeConversationId ? (
              <>
                <PluginMessageFooters
                  key={`${activeConversationId}:${message.id}`}
                  conversationId={activeConversationId}
                  messageId={message.id}
                />
                {runTailId ? (
                  <PluginMessageFooters
                    key={`${activeConversationId}:${runTailId}`}
                    conversationId={activeConversationId}
                    messageId={runTailId}
                  />
                ) : null}
              </>
            ) : undefined
          }
          toolCalls={effectiveToolCalls}
          hookExecutions={effectiveHookExecutions}
          pendingToolAuthorizations={
            hostsPendingAuthorizations
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
          messageId={message.id}
          toolCallMessageIds={toolRun?.messageIds}
          responseId={responseId}
          updateSessionMessages={updateSessionMessages}
          onFork={onFork}
          runStats={isLastAssistant ? runStats : null}
        />
        {footerHookExecutions.length > 0 ? (
          <HookExecutionUI executions={footerHookExecutions} />
        ) : null}
      </div>
    );
  },
);

MessageContent.displayName = "MessageContent";
