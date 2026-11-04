import type { ReactNode } from "react";
import type {
  ConversationContextValue,
  HookExecutionRecord,
  TokenUsage,
  ToolCallInfo,
} from "./conversationTypes";
import type {
  IncompleteVariant,
  NormalizedInterruptionReason,
  NormalizedRecoveryOutcome,
} from "./responseDisposition";
export type UserMessageProps = {
  content: string;
  timestamp?: string;
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

/** 会话累计运行统计（结束态）：悬浮明细挂在最后一条 AI 响应的操作栏上。 */
export type ChatRunStats = {
  durationMs: number;
  ttftSumMs: number;
  requestCount: number;
  tokenUsage: TokenUsage | null;
  model?: string;
};

export type AiResponseProps = {
  title?: string;
  summary: string;
  timestamp?: string;
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
  /** True while the backend is re-issuing a failed stream request; the retry
   *  status card is rendered inside the message (the session-level stream
   *  indicator stays empty meanwhile). */
  isRetrying?: boolean;
  /** 1-based ordinal of the in-flight retry attempt. */
  retryAttempt?: number;
  /** Transport error that triggered the current retry attempt. */
  retryError?: string;
  /** 最近一次重试的退避时长（毫秒），驱动重试提示的倒计时。 */
  retryBackoffMs?: number;
  /** 本轮退避的起始时刻（epoch ms）：重试提示重新挂载后据此续算剩余时间。 */
  retryBackoffStartedAt?: number;
  /** A terminal failure keeps generated content and displays a separate notice. */
  isError?: boolean;
  /** Redacted provider diagnostic, never inferred from the response body. */
  failureReason?: string;
  /** Only an explicitly eligible successful response may execute HTML automatically. */
  htmlPreviewEligible?: boolean;
  incompleteVariant?: IncompleteVariant;
  interruptionReason?: NormalizedInterruptionReason;
  recoveryOutcome?: NormalizedRecoveryOutcome;
  showActions?: boolean;
  /** Optional production UI between response content and message actions. */
  footerContent?: ReactNode;
  /** 会话工作目录：正文里的 HTML 文件链接据此解析后在内置浏览器打开。 */
  artifactWorkspace?: string;
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
  /** 本条响应消息的 id：工具卡片在看门狗中止未被后端接受时据此把这次调用
   *  本地结算为超时，避免卡片永久停在「执行中」。 */
  messageId?: string;
  responseId?: string;
  /** 会话消息更新函数（来自 ChatConversationProvider）：透传给工具卡片做本地
   *  收口（超时/缺执行 id 时结算自己所在的 tool call）。 */
  updateSessionMessages?: ConversationContextValue["updateSessionMessages"];
  onFork?: (conversationId: string, upToResponseId: string) => void;
  /** 运行统计（仅最后一条 AI 响应传入）：操作栏图标悬浮展示明细。 */
  runStats?: ChatRunStats | null;
};
