import type { HookExecutionRecord, ToolCallInfo } from "./conversationTypes";
import type {
  IncompleteVariant,
  NormalizedInterruptionReason,
  NormalizedRecoveryOutcome,
} from "./responseDisposition";
export type UserMessageProps = {
  content: string;
  isStreaming: boolean;
  canRollback?: boolean;
  isRollbackPreparing?: boolean;
  onRollback: () => void;
  hookExecutions?: HookExecutionRecord[];
};

export type AiResponseSection = {
  title: string;
  body: string;
};

export type AiResponseProps = {
  title?: string;
  summary: string;
  thinking?: string;
  /** Thinking-phase duration (ms) measured by the backend for this message. */
  thinkingDurationMs?: number;
  /** Thinking-only token count counted by the backend for this message. */
  thinkingTokenCount?: number;
  /** True while this message is still receiving thinking deltas (the model
   *  is actively thinking). When false the thinking block shows its finished
   *  state and auto-collapses unless the user interacted with it. */
  isThinkingActive?: boolean;
  sections?: AiResponseSection[];
  isStreaming?: boolean;
  isAborting?: boolean;
  incompleteVariant?: IncompleteVariant;
  interruptionReason?: NormalizedInterruptionReason;
  recoveryOutcome?: NormalizedRecoveryOutcome;
  showActions?: boolean;
  toolCalls?: ToolCallInfo[];
  /** Hook execution records bound to tool calls in this message (via
   *  toolCallInteractionId).  Rendered attached to the matching tool card
   *  instead of the message footer. */
  hookExecutions?: HookExecutionRecord[];
  pendingToolAuthorizations?: ToolCallInfo[];
  onApproveToolAuthorization?: (toolCall: ToolCallInfo) => void;
  onApproveToolAuthorizationAlways?: (toolCall: ToolCallInfo) => void;
  onRejectToolAuthorization?: (
    toolCall: ToolCallInfo,
    reason: string,
    userProvidedReason?: boolean,
  ) => void;
  conversationId?: string;
  responseId?: string;
  onFork?: (conversationId: string, upToResponseId: string) => void;
};
