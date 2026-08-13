import type { HookExecutionRecord, ToolCallInfo } from "./conversationTypes";
import type {
  IncompleteVariant,
  NormalizedInterruptionReason,
  NormalizedRecoveryOutcome,
} from "./responseDisposition";
export type UserMessageProps = {
  content: string;
  isStreaming: boolean;
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
  sections?: AiResponseSection[];
  isStreaming?: boolean;
  isAborting?: boolean;
  incompleteVariant?: IncompleteVariant;
  interruptionReason?: NormalizedInterruptionReason;
  recoveryOutcome?: NormalizedRecoveryOutcome;
  /**
   * Cumulative token count produced by the Rust backend for the current
   * streaming iteration. Forwarded to {@link StreamCursor} so the progress
   * is visible at the tail of the streaming AI response.
   */
  streamTokenCount?: number;
  /** Elapsed milliseconds since the streaming request started. */
  streamElapsedMs?: number;
  /** Time to first token in milliseconds. */
  streamTtftMs?: number;
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
    userProvidedReason?: boolean
  ) => void;
  conversationId?: string;
  responseId?: string;
  onFork?: (conversationId: string, upToResponseId: string) => void;
};
