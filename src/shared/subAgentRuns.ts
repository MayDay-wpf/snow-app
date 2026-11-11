/** Frozen async sub-agent wire contract v1. Host scope is never model supplied. */
export type SubAgentExecutionMode = "sync" | "async";
export type SubAgentRunStatus =
  | "queued"
  | "running"
  | "waiting_input"
  | "finalizing"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";
export type SubAgentTerminalStatus = Extract<
  SubAgentRunStatus,
  "completed" | "failed" | "cancelled" | "interrupted"
>;
export type SubAgentErrorCategory =
  | "validation"
  | "configuration"
  | "permission"
  | "model"
  | "tool"
  | "hook"
  | "persistence"
  | "interrupted";
/** Synthetic automatic-delivery call id prefix persisted in parent history. */
export const SUB_AGENT_EVENT_CALL_PREFIX = "sub-agent-event:";

export const SUB_AGENT_CANCELLATION_SOURCES = [
  "cancel_tool",
  "parent_stop",
  "conversation_stop",
  "ui_cancel",
  "deletion",
  "runtime_abort",
  "unspecified",
] as const;
export type SubAgentCancellationSource =
  (typeof SUB_AGENT_CANCELLATION_SOURCES)[number];
export type SubAgentCancellation = {
  source: SubAgentCancellationSource;
  /** UTC epoch milliseconds captured by storage on first accepted cancellation. */
  requestedAt: number;
};
export type SubAgentRunError = {
  category: SubAgentErrorCategory;
  code: string;
  message: string;
  detail?: string;
  retryable: boolean;
};
export type SubAgentRunScope = {
  projectId: string;
  parentConversationId: string;
};
const SUB_AGENT_ACCEPTANCE_STATUSES = [
  "completed",
  "incomplete",
  "blocked",
  "unverified",
] as const;

export type SubAgentAcceptanceStatus =
  (typeof SUB_AGENT_ACCEPTANCE_STATUSES)[number];

export type SubAgentAcceptanceCriterion = {
  id: string;
  description: string;
  /** 默认 true；非必需项不满足时不影响整体验收结论。 */
  required: boolean;
};

/** 宿主生成的降级原因：UI 可按 code 本地化，模型侧按 reason 阅读。 */
export type SubAgentAcceptanceReasonCode = "not_reported" | "no_valid_evidence";

export type SubAgentAcceptanceEvidenceStatus =
  "completed" | "error" | "rejected";

export type SubAgentAcceptanceEvidenceRef = {
  id: string;
  toolName: string;
  callId: string;
  status: SubAgentAcceptanceEvidenceStatus;
  /** 截断后的结果预览；不向主控复制完整工具结果。 */
  preview: string;
};

export type SubAgentAcceptanceItemReceipt = {
  id: string;
  description: string;
  required: boolean;
  status: SubAgentAcceptanceStatus;
  observation: string;
  reason: string;
  reasonCode: SubAgentAcceptanceReasonCode | null;
  evidence: SubAgentAcceptanceEvidenceRef[];
  /** 回执里引用了但宿主执行记录中不存在的证据 id（不会被采信）。 */
  invalidEvidenceIds: string[];
  /** 最近一轮回执是否覆盖该项；false 表示沿用之前记录的状态。 */
  confirmedInLatestReport: boolean;
  updatedAt: number;
};

export type SubAgentAcceptanceReportState = "none" | "invalid" | "received";

export type SubAgentAcceptanceSnapshot = {
  items: SubAgentAcceptanceItemReceipt[];
  counts: {
    total: number;
    completed: number;
    incomplete: number;
    blocked: number;
    unverified: number;
  };
  /** 所有 required 项均为 completed 且至少引用一条有效证据。 */
  satisfied: boolean;
  reportState: SubAgentAcceptanceReportState;
  /** 回执里出现、但不在清单中的验收项 id（已忽略）。 */
  ignoredReportIds: string[];
  updatedAt: number | null;
};
/** Same shape as the existing validated acceptance receipt, without a UI dependency. */
export type SubAgentRunAcceptance = SubAgentAcceptanceSnapshot;
export type SubAgentHookOutcome = {
  kind: "none" | "success" | "warn" | "abort" | "failed";
  message?: string;
};
export type SubAgentOutcome = {
  version: 1;
  runId: string;
  conversationId: string;
  parentConversationId: string;
  parentTaskId: string;
  terminalStatus: SubAgentTerminalStatus;
  cancellation?: SubAgentCancellation;
  summary: string;
  undeliveredMessageIds?: string[];
  error?: SubAgentRunError;
  acceptance?: SubAgentRunAcceptance;
  acceptanceSatisfied?: boolean;
  unavailableTools: { name: string; reason: string }[];
  hookOutcome: SubAgentHookOutcome;
  acceptedAt: number;
  startedAt?: number;
  completedAt: number;
};
export type SubAgentExecutionSnapshot = {
  agentId: string;
  agentName: string;
  apiProfile: string;
  model: string;
  systemPrompt: string;
  toolsJson: string;
  effectiveThinkingStrength?: string | null;
  effectiveResponsesFastMode?: string | null;
  workspacePath: string;
  worktreeMode: boolean;
  /** Explicit per-delegation collaboration, further restricted by configured tools. */
  collaborationGroup?: string;
};
export type SubAgentRunRecord = SubAgentRunScope & {
  runId: string;
  conversationId: string;
  parentTaskId: string;
  interactionId: string;
  requestId: string;
  previousRunId?: string;
  ownerInstanceId: string;
  version: number;
  executionMode: SubAgentExecutionMode;
  status: SubAgentRunStatus;
  cancellation?: SubAgentCancellation;
  summary: string;
  agentId: string;
  agentName: string;
  acceptedAt: number;
  startedAt?: number;
  completedAt?: number;
  waitingReason?:
    | "authorization"
    | "question"
    | "failure_decision"
    | "hook_decision"
    | "pause";
  outcome?: SubAgentOutcome;
  snapshot: SubAgentExecutionSnapshot;
  eventId?: string;
  deliveryStatus?: "pending" | "received" | "revoked";
};
export type SubAgentAccepted = {
  success: true;
  kind: "accepted";
  runId: string;
  conversationId: string;
  runStatus: SubAgentRunStatus;
  requestId: string;
  /** Captured effective host policy for this exact admission. */
  executionMode: SubAgentExecutionMode;
  /** false for an idempotent replay: do not start another execution. */
  created: boolean;
};
export type SubAgentMessageQueued = {
  success: true;
  kind: "message_queued";
  runId: string;
  conversationId: string;
  messageId: string;
  requestId: string;
  queuedAt: number;
  created: boolean;
  /** Mode of the exact recipient run, not the current global setting. */
  executionMode: SubAgentExecutionMode;
  deliveryStatus: "queued";
};
export type SubAgentEvent = SubAgentRunScope & {
  eventId: string;
  runId: string;
  parentTaskId: string;
  status: "pending" | "received" | "revoked";
  createdAt: number;
  outcome: SubAgentOutcome;
};
export type SubAgentResultPage = {
  success: true;
  kind: "result";
  run: SubAgentRunRecord;
  /** A UTF-8-safe character slice of outcome.summary. Metadata is never truncated. */
  summaryPage?: {
    text: string;
    offset: number;
    total: number;
    nextOffset: number | null;
  };
};
export type SubAgentCancelReceipt = {
  success: true;
  kind: "cancel";
  runId: string;
  disposition: "requested" | "confirmed" | "already_terminal" | "too_late";
  runStatus: SubAgentRunStatus;
  cancellation?: SubAgentCancellation;
};
export type SubAgentParentTaskState = "open" | "stopped" | "closed";
/** v1.1: only normalized logical caller inputs participate in request identity. */
export type SubAgentLogicalInput = {
  operation: "activate" | "continue";
  executionMode: SubAgentExecutionMode;
  agentId?: string;
  conversationId?: string;
  summary?: string;
  text: string;
  acceptance: SubAgentAcceptanceCriterion[];
  collaborationGroup?: string;
};
export type SubAgentRunCommand =
  | {
      op: "lookup_request";
      scope: SubAgentRunScope;
      requestId: string;
      requestInput: SubAgentLogicalInput;
    }
  | {
      op: "accept";
      scope: SubAgentRunScope;
      requestId: string;
      requestInput: SubAgentLogicalInput;
      operation: "activate" | "continue";
      conversationId: string;
      parentTaskId: string;
      interactionId: string;
      executionMode: SubAgentExecutionMode;
      summary: string;
      prompt: string;
      snapshot: SubAgentExecutionSnapshot;
      acceptance?: SubAgentRunAcceptance;
      ownerInstanceId?: string;
    }
  | {
      op: "queue_message";
      scope: SubAgentRunScope;
      requestId: string;
      requestInput: SubAgentLogicalInput;
      conversationId: string;
      expectedRunId?: string;
      message: string;
      acceptance?: SubAgentRunAcceptance;
    }
  | {
      op: "take_messages";
      scope: SubAgentRunScope;
      runId: string;
      ownerInstanceId?: string;
    }
  | {
      op: "transition";
      scope: SubAgentRunScope;
      runId: string;
      ownerInstanceId?: string;
      from: SubAgentRunStatus[];
      to: SubAgentRunStatus;
      waitingReason?: SubAgentRunRecord["waitingReason"];
    }
  | {
      op: "settle";
      scope: SubAgentRunScope;
      runId: string;
      ownerInstanceId?: string;
      outcome: SubAgentOutcome;
    }
  | {
      op: "get";
      scope: SubAgentRunScope;
      runId: string;
      terminalOnly?: boolean;
      offset?: number;
      limit?: number;
    }
  | {
      op: "list";
      scope: SubAgentRunScope;
      conversationId?: string;
      limit?: number;
      offset?: number;
    }
  | {
      op: "cancel";
      scope: SubAgentRunScope;
      runId: string;
      source?: SubAgentCancellationSource;
    }
  | {
      op: "events";
      scope: SubAgentRunScope;
      parentTaskId?: string;
      /** Include already persisted inputs awaiting an admitted parent continuation. */
      includeReceived?: boolean;
      limit?: number;
    }
  | {
      op: "receive";
      scope: SubAgentRunScope;
      parentTaskId: string;
      eventIds: string[];
      /** Existing persisted tool result containing these runIds; otherwise commit an internal pair. */
      toolMessageId?: string;
    }
  | {
      op: "parent_task";
      scope: SubAgentRunScope;
      parentTaskId: string;
      state: SubAgentParentTaskState;
    }
  | {
      op: "acknowledge_wake";
      scope: SubAgentRunScope;
      parentTaskId: string;
      eventIds: string[];
    }
  | {
      op: "prepare_rollback";
      scope: SubAgentRunScope;
      conversationId: string;
      fromMessageId?: string;
      fromResponseId?: string;
    }
  | {
      op: "rollback_status";
      scope: SubAgentRunScope;
      conversationId: string;
      rollbackId: string;
    }
  | {
      op: "peer_message";
      scope: SubAgentRunScope;
      senderRunId: string;
      recipientRunId: string;
      message: string;
      requestId: string;
      ownerInstanceId?: string;
    }
  | {
      op: "close_if_idle";
      scope: SubAgentRunScope;
      parentTaskId: string;
    }
  | {
      op: "release_rollback" | "mark_rollback_restoring";
      scope: SubAgentRunScope;
      conversationId: string;
      rollbackId: string;
    }
  | { op: "prepare_delete"; scope: SubAgentRunScope; conversationId: string }
  | { op: "deletion_status"; scope: SubAgentRunScope; conversationId: string }
  | { op: "recover"; ownerInstanceId?: string };
export type SubAgentRunCommandResult =
  | {
      success: true;
      kind: "request";
      receipt: SubAgentAccepted | SubAgentMessageQueued | null;
    }
  | SubAgentAccepted
  | SubAgentMessageQueued
  | SubAgentResultPage
  | SubAgentCancelReceipt
  | { success: true; kind: "runs"; runs: SubAgentRunRecord[]; total: number }
  | { success: true; kind: "events"; events: SubAgentEvent[] }
  | {
      success: true;
      kind: "messages";
      messages: {
        messageId: string;
        runId: string;
        text: string;
        senderRunId?: string;
        acceptance?: SubAgentRunAcceptance;
      }[];
    }
  | {
      success: true;
      kind: "transition";
      changed: boolean;
      waitingForCapacity?: boolean;
      run: SubAgentRunRecord;
    }
  | {
      success: true;
      kind: "settled";
      committed: boolean;
      run: SubAgentRunRecord;
      event?: SubAgentEvent;
    }
  | {
      success: true;
      kind: "received";
      eventIds: string[];
      messageIds: string[];
    }
  | { success: true; kind: "parent_task"; state: SubAgentParentTaskState }
  | {
      success: true;
      kind: "deletion";
      deleting: boolean;
      ready: boolean;
      runs: SubAgentRunRecord[];
      error?: SubAgentRunError;
    }
  | {
      success: true;
      kind: "rollback";
      rollbackId: string;
      boundaryMessageId: string;
      phase?: "prepared" | "restoring";
      ready: boolean;
      runs: SubAgentRunRecord[];
    }
  | { success: true; kind: "wake_acknowledged"; eventIds: string[] }
  | { success: true; kind: "parent_idle"; closed: boolean }
  | { success: true; kind: "rollback_released"; rollbackId: string }
  | { success: true; kind: "recovered"; count: number };
export const isSubAgentTerminal = (
  status: SubAgentRunStatus,
): status is SubAgentTerminalStatus =>
  status === "completed" ||
  status === "failed" ||
  status === "cancelled" ||
  status === "interrupted";
