import type { ChatInputSendOptions } from "../../chatInput/types";
import type {
  ApiConfigRecord,
  ChatConversationRecord,
  ChatMessageRecord,
  CheckpointFileChange,
  TokenUsage,
  UserQuestionRequest,
} from "../../../../../preload";
import type { NotificationConversationTarget } from "../../../../../shared/notification";
import type { Dispatch, SetStateAction } from "react";

export type UserQuestionState = {
  questionId: string;
  question: string;
  options: string[];
  status: "waiting" | "answered" | "cancelled";
  selectedOptions: string[];
  customAnswers: string[];
};

export type HookExecutionStatus =
  | "pass"
  | "warn"
  | "abort"
  | "error"
  | "needsDecision";

export type HookExecutionRecord = {
  /** The hook type that was triggered (e.g. "onUserMessage", "beforeToolCall"). */
  hookType: string;
  /** Resolved outcome kind from the hook execution. */
  status: HookExecutionStatus;
  /** Number of actions that were executed. */
  executedActions: number;
  /** Number of actions that were skipped. */
  skippedActions: number;
  /** Per-action results from the Rust backend. */
  results: Array<{
    actionType: string;
    success: boolean;
    command?: string | null;
    exitCode?: number | null;
    output?: string | null;
    error?: string | null;
    additionalContext?: string | null;
  }>;
  /** The original block message if the hook blocked the action. */
  blockMessage?: string | null;
  /** Timestamp (epoch ms) when the hook execution completed. */
  timestamp: number;
  /** When the hook is bound to a specific tool call (e.g. beforeSubAgentStart
   *  while a sub-agent activation runs, onSubAgentComplete when it finishes),
   *  the tool call's interactionId.  The renderer uses this to attach the
   *  hook record to the matching tool card instead of the message footer. */
  toolCallInteractionId?: string;
  /** When true, the hook returned a decision JSON and the user must
   *  approve or reject the action before the AI loop can continue. */
  pendingDecision?: boolean;
  /** Human-readable message from the decision JSON's `decision.message`. */
  decisionMessage?: string | null;
  /** Internal identifier for the pending runtime decision. Not serialized. */
  _decisionId?: string;
  /** Internal: resolve function injected by useAgentLoop to unblock the
   *  AI loop when the user clicks approve/reject.  Not serialized, not
   *  part of the public type contract — exists only at runtime. */
  _resolveDecision?: (approved: boolean) => void;
};

export type ToolCallInfo = {
  name: string;
  arguments: string;
  callId?: string;
  interactionId: string;
  status: "pending" | "running" | "completed" | "error";
  result?: string;
  streamingStdout?: string;
  streamingStderr?: string;
  /** 生图工具（imagegen-generate）流式预览图，按 index 排序。 */
  streamingImages?: Array<{
    index: number;
    mimeType: string;
    data: string;
  }>;
  userQuestion?: UserQuestionState;
  authorizationId?: string;
  authorizationConversationId?: string;
  sensitiveCommandMatches?: Array<{
    commandId: string;
    pattern: string;
    description: string;
  }>;
  /** Epoch milliseconds when the tool transitioned to "running".
   *  Used by the Bash tool UI to render a live timeout countdown. */
  startedAt?: number;
  /** UUID assigned by the Rust backend when the bash command runs in
   *  interactive mode (isInteractive=true).  The frontend uses this ID
   *  to send user input to the process stdin via `writeInteractiveStdin`. */
  interactiveSessionId?: string;
  /** UUID assigned by the Rust backend for every bash execution.  The
   *  frontend uses it to kill the subprocess on demand via
   *  `abortToolExecution` (the UI stop button and session aborts), instead
   *  of waiting for the timeout. */
  toolExecutionId?: string;
};

export type ChatConversationMessage = {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  thinking?: string;
  timestamp: string;
  status?: "sending" | "sent" | "error";
  responseId?: string;
  model?: string;
  toolCalls?: ToolCallInfo[];
  toolCallId?: string;
  toolName?: string;
  isRetrying?: boolean;
  retryAttempt?: number;
  retryError?: string;
  /** File-system checkpoint id created when the user sent this message.
   *  Used by rollback to restore the working directory to its pre-AI state. */
  checkpointId?: string;
  isContextCompaction?: boolean;
  /** Hook execution records for this message (e.g. onUserMessage hooks
   *  executed before the message was sent to the AI).  Stored on the user
   *  message so the UI can render what hooks ran and their outcomes. */
  hookExecutions?: HookExecutionRecord[];
};

export type UpsertedConversation = {
  record: ChatConversationRecord;
  timestamp: number;
};

/** Unified diff text captured for a file change, consumed by the "view
 *  diff" action of the file-changes panel. For creates the patch shows the
 *  full file content (empty file -> content); for edits it shows the
 *  searchContent -> replaceContent replacement region with context lines. */
export type FileChangeDiff = {
  patch: string;
  isBinary?: boolean;
};

/** A file that was modified (created or edited) by the main agent or a
 *  sub-agent during a conversation session. Recorded at tool-execution time
 *  and surfaced by the file-change stats panel. */
export type FileChangeRecord = {
  /** The filePath argument passed to the filesystem tool (as the model
   *  supplied it, e.g. relative to the workspace root). */
  filePath: string;
  kind: "create" | "edit" | "delete";
  /** Whether the change was made by the main agent loop or by a sub-agent
   *  running inside this conversation. */
  agent: "main" | "sub";
  /** Sub-agent display name, present when agent === "sub". */
  subAgentName?: string;
  /** Epoch milliseconds when the tool call completed successfully. */
  timestamp: number;
  /** Diff payload for the "view changes" action; absent when unavailable
   *  (e.g. the tool arguments carried no content). */
  diff?: FileChangeDiff;
};

export type SubAgentSessionEvent = {
  parentConversationId: string;
  conversationId: string;
  agentId: string;
  agentName: string;
  status: "running" | "completed" | "failed" | "cancelled";
  timestamp: number;
  /** The interactionId of the parent tool call that activated this sub-agent.
   *  Used to match the event to the correct SubAgentToolCall UI when multiple
   *  sub-agents run in parallel with the same agentId. */
  toolCallInteractionId?: string;
};

export type VisionAnalysisState = {
  /** describing = 调用外挂视觉 API 中；cached = 命中 blake3 缓存直接复用；
   *  done = 全部图片文本化完成；error = 文本化失败（请求将失败）。 */
  phase: "describing" | "cached" | "done" | "error";
  /** 当前已处理的图片序号（1 起）。 */
  index: number;
  /** 本次消息中需要文本化的图片总数。 */
  total: number;
  /** 外挂视觉模型名（配置了才带）。 */
  model?: string;
  /** phase === "error" 时的错误信息。 */
  error?: string;
};

export type ConversationSessionState = {
  messages: ChatConversationMessage[];
  messageRecords: ChatMessageRecord[];
  summary: string;
  isStreaming: boolean;
  isAborting: boolean;
  /** True when the user paused the agent loop. The loop checks this at the
   *  start of each iteration and blocks until resumed or cancelled. */
  isPaused: boolean;
  isLoadingOlderMessages: boolean;
  hasMoreMessages: boolean;
  isInitialHistoryLoaded: boolean;
  tokenUsage: TokenUsage | null;
  directoryId?: string;
  hasNewContent: boolean;
  forkedFromConversationId?: string;
  forkMessageCount?: number;
  /** Real-time token probe for the current agent-loop iteration.
   *  Reset to 0 when a new iteration starts; updated on every streaming
   *  chunk (content, thinking, and tool-call arguments) by the Rust
   *  backend via `ResponsesApiStreamChunk.streamTokenCount`. */
  streamTokenCount: number;
  /** Elapsed milliseconds since the streaming request started.
   *  Updated on every streaming chunk by the Rust backend. */
  streamElapsedMs: number;
  /** Time to first token in milliseconds. 0 until the first content
   *  or thinking delta arrives, then frozen for the iteration. */
  streamTtftMs: number;
  /** TTFT of the first model iteration in the active run. */
  runTtftMs: number;
  /** First checkpoint in the conversation, used as the cumulative diff baseline. */
  baselineCheckpointId?: string;
  /** Wall-clock timestamp (Date.now()) captured once when an agent loop
   *  starts, used by StreamMetrics to drive an accumulating elapsed timer
   *  that survives conversation switches between parallel streaming
   *  sessions. Reset to 0 when the loop finishes (normal end, abort, or
   *  rollback). Independent of the backend's per-iteration streamElapsedMs
   *  (which resets on every new createResponseStream call). */
  streamStartedAt: number;
  /** External-vision textify progress, driven by `ResponsesApiStreamChunk.
   *  visionStatus` events. Set while the backend describes user images with
   *  the external vision model; cleared when the textify pass finishes
   *  (phase done/error) so the intermediate status card disappears. */
  visionAnalysis?: VisionAnalysisState;
};

export type ConversationSessionRef = {
  streamId: string | null;
  /**
   * The in-flight `createResponseStream` promise. Resolved after the Rust
   * backend finishes `store_chat_exchange`. Rollback awaits this before
   * issuing delete/truncate to avoid concurrent write-transaction races.
   */
  streamPromise: Promise<unknown> | null;
  /**
   * The in-flight `generateConversationSummary` promise. Resolved after the
   * backend finishes `update_conversation_summary`. Rollback awaits this
   * before issuing delete/truncate to avoid concurrent write-transaction races.
   */
  summaryPromise: Promise<unknown> | null;
  isSending: boolean;
  isAbortRequested: boolean;
  /**
   * Generation counter incremented on every handleSendMessage and
   * handleAbort invocation. runAgentLoop captures the value at start
   * and treats a mismatch as a cancellation signal — this prevents
   * stale loops from continuing after isAbortRequested is reset by a
   * new send (the race window that occurs when aborting during tool
   * execution).
   */
  runId: number;
  /** Latest values reported by the current model iteration. */
  iterationTokenCount: number;
  iterationElapsedMs: number;
  directoryId?: string;
  checkpointIds: string[];
  /** Conversation ids of sub-agent sessions spawned by this conversation.
   *  Used to propagate an abort from the main flow down to every running
   *  sub-agent (and, recursively, their own sub-agents). */
  childSubAgentIds: Set<string>;
  /** Whether Plan Mode was active when this session was last used. */
  planMode: boolean;
  /** Whether Goal Mode was active when this session was last used. */
  goalMode: boolean;
  /** Goal Mode token budget in effect for this session (per-conversation
   *  override when set, otherwise the global default at session creation). */
  goalModeTokenBudget: number;
  /** Set once a sub-agent conversation's run has ended (completed, failed or
   *  cancelled). A terminated sub-agent conversation is read-only: the input
   *  box is hidden and handleSendMessage refuses to start a new loop in it.
   *  Only meaningful for sub-agent sessions; absent for main conversations. */
  subAgentTerminated?: boolean;
};

/** Global Plan/Goal Mode defaults loaded from persisted settings. These are
 *  the values new/never-configured conversations inherit. They are only
 *  mutated by explicit user toggles — never by conversation switches — so
 *  each conversation's mode stays fully isolated. */
export type GlobalModeDefaults = {
  planMode: boolean;
  goalMode: boolean;
  goalModeTokenBudget: number;
};

/** Per-session pause controller stored in pauseControllerRef. When `paused`
 *  is true, the agent loop awaits on `resolve` before proceeding to the next
 *  iteration. `resolve` is set back to null once the promise is settled. */
export type PauseController = {
  paused: boolean;
  resolve: (() => void) | null;
};

export type RollbackTodoItem = {
  id: string;
  content: string;
  status: string;
};

export type RollbackMode = "conversation-only" | "conversation-and-files";

export type RollbackPreview = {
  messageId: string;
  messageContent: string;
  changes: CheckpointFileChange[];
  checkpointId?: string;
  workDir?: string;
  convId?: string;
  responseId?: string;
  isFirstMessage: boolean;
  isContextCompaction: boolean;
  todoItems: RollbackTodoItem[];
  /** Captured at handleRollback time so confirmRollback can await it. */
  streamPromise: Promise<unknown> | null;
  /** Captured at handleRollback time so confirmRollback can await it. */
  summaryPromise: Promise<unknown> | null;
};

export type ToolAuthorizationDecision =
  | { status: "approved"; sensitiveCommandConfirmed?: boolean }
  | {
      status: "rejected";
      reason: string;
      /** 用户是否主动填写了拒绝理由。为 true 时拒绝理由作为工具结果
       *  回传 AI 并继续 Loop；为 false 或缺失时（如直接拒绝、中断、
       *  hook abort）全部拒绝则终止 AI 流程。 */
      userProvidedReason?: boolean;
    };

export type PendingToolAuthorization = {
  toolCall: ToolCallInfo;
  resolve: (decision: ToolAuthorizationDecision) => void;
};

export type PendingUserQuestion = {
  sessionKey: string;
  interactionId: string;
  resolve: (resultJson: string) => void;
  reject: (error: Error) => void;
};

export type PendingHookDecision = {
  sessionKey: string;
  resolve: (approved: boolean) => void;
};

export type UserQuestionTarget = {
  sessionKey: string;
  assistantMessageId: string;
};

export type PendingQueueItem = {
  text: string;
  options: ChatInputSendOptions;
};

export type ConversationNotificationContext = {
  conversationId: NotificationConversationTarget["conversationId"] | undefined;
  directoryId: NotificationConversationTarget["directoryId"] | undefined;
};

export type NotifyAiCompleteOptions = ConversationNotificationContext & {
  title: string | undefined;
};

export type NotifySensitiveCommandOptions = ConversationNotificationContext & {
  toolName: string;
};

export type NotifyUserInteractionOptions = ConversationNotificationContext & {
  reason: string;
};

/** Ref value type compatible with React's MutableRefObject */
export type RefValue<T> = { current: T };

/** Shared context passed to all sub-hooks */
export type ConversationContextValue = {
  // Params
  directoryId?: string;
  directoryPath?: string;

  // State values
  sessions: Record<string, ConversationSessionState>;
  activeConversationId: string | undefined;
  conversationVersion: number;
  /** 侧边栏会话列表刷新信号（置顶/删除/重命名等显式操作后 +1）。
   *  与 conversationVersion 解耦：AI 响应迭代不会触发列表全量重拉。 */
  conversationListVersion: number;
  upsertedConversation: UpsertedConversation | null;
  /** All sub-agent session events keyed by sub-agent conversationId. Multiple
   *  parallel sub-agents each keep their own entry so the UI can match every
   *  SubAgentToolCall to the correct live session. */
  subAgentSessionEvents: Record<string, SubAgentSessionEvent>;
  /** File changes recorded during this renderer session, keyed by
   *  conversationId. The main conversation collects both its own changes
   *  (agent: "main") and — via childSubAgentIds — every sub-agent's changes
   *  (agent: "sub"). Records are filled live by the tool-execution pipeline
   *  and re-hydrated from persisted history when a conversation is opened. */
  fileChangeStats: Record<string, FileChangeRecord[]>;
  /** Merge pre-built records into a conversation's stats, de-duplicating by
   *  (filePath, kind, timestamp, agent). Used to re-hydrate stats from
   *  persisted history after a restart or when reopening a conversation. */
  mergeFileChangeStats: (
    conversationId: string,
    records: FileChangeRecord[]
  ) => void;
  /** Conversation ids whose file-change stats have already been re-hydrated
   *  from persisted history during this renderer session. Guards against
   *  repeated sub-agent scans when the same conversation is reopened. */
  fileChangeStatsHydratedRef: RefValue<Set<string>>;
  streamingConversationIds: Set<string>;
  completedConversationIds: Set<string>;
  pendingUserQuestionConversationIds: Set<string>;
  attentionRequiredConversationIds: Set<string>;
  isLoadingInitialHistory: boolean;
  draftToRestore: string | null;
  rollbackPreview: RollbackPreview | null;
  /** True when the user explicitly clicked "New chat" while a pending or
   *  active session was still streaming. The UI should show the empty
   *  greeting instead of falling back to the pending session, and the
   *  agent loop must NOT auto-switch back to the migrated conversation. */
  newChatRequested: boolean;
  yoloMode: boolean;
  isUpdatingYoloMode: boolean;
  planMode: boolean;
  isUpdatingPlanMode: boolean;
  goalMode: boolean;
  isUpdatingGoalMode: boolean;
  goalModeTokenBudget: number;
  pendingToolAuthorizations: ToolCallInfo[];
  activePendingMessages: string[];
  compactionPreview: string;
  compactionError: string | null;
  isCompacting: boolean;
  /** Conversation currently running a compaction (auto or manual). The
   *  compaction preview/error UI is only shown for this conversation so it
   *  does not bleed into other conversations after a switch. */
  compactingConversationId: string | null;

  // Refs
  sessionsRefData: RefValue<Map<string, ConversationSessionRef>>;
  activeConversationIdRef: RefValue<string | undefined>;
  selectionRequestIdRef: RefValue<number>;
  /** In-flight initial history loads keyed by conversationId. Selections of
   *  the same conversation share a single load so switching away and back
   *  while a load is pending does not trigger a duplicate full re-fetch. */
  historyLoadPromisesRef: RefValue<Map<string, Promise<void>>>;
  loadingOlderConversationIdsRef: RefValue<Set<string>>;
  sessionsRef: RefValue<Record<string, ConversationSessionState>>;
  /** Ref mirror of newChatRequested for use inside async agent-loop closures
   *  that cannot read the latest React state directly. */
  newChatRequestedRef: RefValue<boolean>;
  pendingQueueRef: RefValue<Map<string, PendingQueueItem[]>>;
  /** 按会话保存的输入草稿（conversationId -> 序列化 segments 字符串，含
   *  文本/图片 chip 等）。切换会话或新建会话时 ChatInput 会因
   *  isLoadingInitialHistory 卸载，草稿存这里避免输入丢失；用 ref 存储
   *  避免每次输入触发全局重渲染。key 归一化：conversationId 为空时使用
   *  PENDING_SESSION_KEY（新会话草稿，发送成功后清除）。 */
  inputDraftsRef: RefValue<Record<string, string>>;
  handleSendMessageRef: RefValue<
    (message: string, options: ChatInputSendOptions) => void
  >;
  performCompactionRef: RefValue<
    (
      conversationId: string,
      model?: string,
      isAuto?: boolean,
      subAgentConfigProfile?: string,
      apiProfile?: string,
      subAgentToolsJson?: string,
      subAgentSystemPrompt?: string
    ) => Promise<string | null>
  >;
  yoloModeRef: RefValue<boolean>;
  planModeRef: RefValue<boolean>;
  goalModeRef: RefValue<boolean>;
  /** Global Plan/Goal Mode defaults (persisted settings). New and
   *  never-configured conversations inherit these; switches never write them. */
  globalModeDefaultsRef: RefValue<GlobalModeDefaults>;
  alwaysApprovedToolsRef: RefValue<Set<string>>;
  /** Per-conversation Plan Mode approval keys. Cleared only when Plan Mode is
   *  genuinely turned off (user toggle, Goal Mode mutual exclusion, new chat)
   *  — NOT on conversation switches, so an approved plan survives switching
   *  away and back. */
  planApprovedSessionKeysRef: RefValue<Set<string>>;
  pendingToolAuthorizationRef: RefValue<Map<string, PendingToolAuthorization>>;
  pendingUserQuestionRef: RefValue<Map<string, PendingUserQuestion>>;
  pendingHookDecisionRef: RefValue<Map<string, PendingHookDecision>>;
  userQuestionTargetRef: RefValue<Map<string, UserQuestionTarget>>;
  /** Fetches an API config fresh from storage. Called at each auto-compaction
   *  decision point so user edits to the config (e.g. the auto-compress
   *  threshold) take effect immediately without a restart. When `profileName`
   *  is given, the matching profile is returned (falling back to the active
   *  config); otherwise the active config is returned. Sub-agents pass their
   *  configured profile so the threshold matches their real context window. */
  getActiveApiConfig: (profileName?: string) => Promise<ApiConfigRecord | null>;
  /** Per-session pause controllers. Each entry controls whether the agent
   *  loop for that session should block before its next iteration. */
  pauseControllerRef: RefValue<Map<string, PauseController>>;

  // State setters
  setSessions: Dispatch<
    SetStateAction<Record<string, ConversationSessionState>>
  >;
  setActiveConversationId: Dispatch<SetStateAction<string | undefined>>;
  setConversationVersion: Dispatch<SetStateAction<number>>;
  setConversationListVersion: Dispatch<SetStateAction<number>>;
  setUpsertedConversation: Dispatch<
    SetStateAction<UpsertedConversation | null>
  >;
  setSubAgentSessionEvent: (event: SubAgentSessionEvent) => void;
  /** Record a successful file modification (filesystem-create /
   *  filesystem-replace_edit) against a conversation's stats. The main agent
   *  records with agent: "main"; sub-agents record with agent: "sub" under
   *  their own conversationId so the parent can merge them. */
  recordFileChange: (conversationId: string, record: FileChangeRecord) => void;
  setStreamingConversationIds: Dispatch<SetStateAction<Set<string>>>;
  setCompletedConversationIds: Dispatch<SetStateAction<Set<string>>>;
  setPendingUserQuestionConversationIds: Dispatch<SetStateAction<Set<string>>>;
  setIsLoadingInitialHistory: Dispatch<SetStateAction<boolean>>;
  setDraftToRestore: Dispatch<SetStateAction<string | null>>;
  setRollbackPreview: Dispatch<SetStateAction<RollbackPreview | null>>;
  setNewChatRequested: Dispatch<SetStateAction<boolean>>;
  setYoloModeState: Dispatch<SetStateAction<boolean>>;
  setIsUpdatingYoloMode: Dispatch<SetStateAction<boolean>>;
  setPlanModeState: Dispatch<SetStateAction<boolean>>;
  setIsUpdatingPlanMode: Dispatch<SetStateAction<boolean>>;
  setGoalModeState: Dispatch<SetStateAction<boolean>>;
  setIsUpdatingGoalMode: Dispatch<SetStateAction<boolean>>;
  setGoalModeTokenBudgetState: Dispatch<SetStateAction<number>>;
  setPendingToolAuthorizations: Dispatch<SetStateAction<ToolCallInfo[]>>;
  setActivePendingMessages: Dispatch<SetStateAction<string[]>>;
  setCompactionPreview: Dispatch<SetStateAction<string>>;
  setCompactionError: Dispatch<SetStateAction<string | null>>;
  setIsCompacting: Dispatch<SetStateAction<boolean>>;
  setCompactingConversationId: Dispatch<SetStateAction<string | null>>;

  // Basic session callbacks
  setActiveId: (id: string | undefined) => void;
  ensureSession: (key: string, dirId?: string) => void;
  updateSessionMessages: (
    key: string,
    updater: (messages: ChatConversationMessage[]) => ChatConversationMessage[]
  ) => void;
  updateSessionField: <K extends keyof ConversationSessionState>(
    key: string,
    field: K,
    value: ConversationSessionState[K]
  ) => void;
  migrateSession: (oldKey: string, newKey: string) => void;
  addStreamingId: (id: string) => void;
  removeStreamingId: (id: string) => void;

  // Input draft persistence (per-conversation, survives ChatInput unmount)
  saveInputDraft: (conversationId: string | undefined, content: string) => void;
  getInputDraft: (conversationId: string | undefined) => string | undefined;
  clearInputDraft: (conversationId: string | undefined) => void;

  // 通知系统：AI 流程结束 / 敏感命令拦截 / 用户交互确认时触发系统通知
  notifyAiComplete: (options: NotifyAiCompleteOptions) => void;
  notifySensitiveCommandIntercepted: (
    options: NotifySensitiveCommandOptions
  ) => void;
  notifyUserInteractionRequired: (
    options: NotifyUserInteractionOptions
  ) => void;
};

export type UseChatConversationResult = {
  messages: ChatConversationMessage[];
  summary: string;
  conversationVersion: number;
  conversationListVersion: number;
  upsertedConversation: UpsertedConversation | null;
  /** All sub-agent session events keyed by sub-agent conversationId. */
  subAgentSessionEvents: Record<string, SubAgentSessionEvent>;
  /** File changes recorded during this renderer session, keyed by
   *  conversationId. See FileChangeRecord for the shape. */
  fileChangeStats: Record<string, FileChangeRecord[]>;
  /** Records a successful file modification for a conversation. */
  recordFileChange: (conversationId: string, record: FileChangeRecord) => void;
  /** All conversation sessions, keyed by conversation id. Used by tool-call
   *  UIs (e.g. sub-agent activation) to inspect the live state of other
   *  sessions such as streaming sub-agent conversations. */
  sessions: Record<string, ConversationSessionState>;
  activeConversationId: string | undefined;
  conversationDirectoryId: string | undefined;
  tokenUsage: TokenUsage | null;
  /** Real-time token probe for the current agent-loop iteration.
   *  Updated on every streaming chunk by the Rust backend; reset to 0
   *  when a new iteration starts. */
  streamTokenCount: number;
  /** Elapsed milliseconds since the streaming request started. */
  streamElapsedMs: number;
  /** Time to first token in milliseconds. */
  streamTtftMs: number;
  /** TTFT captured from the first model iteration in the active run. */
  runTtftMs: number;
  /** First checkpoint in the active conversation. */
  baselineCheckpointId: string | undefined;
  /** Wall-clock timestamp (Date.now()) captured once when an agent loop
   *  starts. Drives the accumulating elapsed timer in StreamMetrics so it
   *  survives conversation switches between parallel streaming sessions. */
  streamStartedAt: number;
  /** External-vision textify progress for the active conversation. Present
   *  while the backend describes user images with the external vision model. */
  visionAnalysis: VisionAnalysisState | undefined;
  forkedFromConversationId: string | undefined;
  forkMessageCount: number | undefined;
  streamingConversationIds: Set<string>;
  completedConversationIds: Set<string>;
  attentionRequiredConversationIds: Set<string>;
  isLoadingOlderMessages: boolean;
  hasMoreMessages: boolean;
  isInitialHistoryLoaded: boolean;
  isLoadingInitialHistory: boolean;
  loadOlderMessages: () => Promise<void>;
  handleSendMessage: (message: string, options: ChatInputSendOptions) => void;
  pendingMessages: string[];
  withdrawPendingMessage: (index: number) => string | null;
  sendPendingMessageNow: (index: number) => void;
  compactConversation: (model?: string) => Promise<void>;
  compactionPreview: string;
  compactionError: string | null;
  isCompacting: boolean;
  compactingConversationId: string | null;
  handleSelectConversation: (
    conversationId: string,
    title?: string,
    tokenUsage?: TokenUsage | null,
    directoryId?: string
  ) => Promise<void>;
  handleNewChat: () => void;
  refreshConversations: () => void;
  /** 同步更新内存中某会话的 summary（如重命名会话后让 TopBar 标题即时刷新）。 */
  updateConversationSummary: (conversationId: string, summary: string) => void;
  isStreaming: boolean;
  isAborting: boolean;
  isPaused: boolean;
  handleAbort: () => void;
  handlePause: () => void;
  handleResume: () => void;
  abortConversation: (conversationId: string) => void;
  handleForkConversation: (
    conversationId: string,
    upToResponseId: string
  ) => Promise<void>;
  draftToRestore: string | null;
  autoSendToken: number;
  clearDraftToRestore: () => void;
  /** 保存/读取/清除某会话的输入草稿（含图片 chip）。详见
   *  ConversationContextValue.inputDraftsRef 的注释。 */
  saveInputDraft: (conversationId: string | undefined, content: string) => void;
  getInputDraft: (conversationId: string | undefined) => string | undefined;
  clearInputDraft: (conversationId: string | undefined) => void;
  buildFromContent: (content: string) => void;
  handleRollback: (messageId: string) => void;
  rollbackPreview: RollbackPreview | null;
  confirmRollback: (mode: RollbackMode) => Promise<void>;
  cancelRollback: () => void;
  yoloMode: boolean;
  isUpdatingYoloMode: boolean;
  setYoloMode: (enabled: boolean) => Promise<void>;
  refreshYoloMode: () => Promise<boolean>;
  planMode: boolean;
  isUpdatingPlanMode: boolean;
  setPlanMode: (enabled: boolean) => Promise<void>;
  refreshPlanMode: () => Promise<boolean>;
  goalMode: boolean;
  isUpdatingGoalMode: boolean;
  setGoalMode: (enabled: boolean) => Promise<void>;
  refreshGoalMode: () => Promise<boolean>;
  goalModeTokenBudget: number;
  setGoalModeTokenBudget: (budget: number) => Promise<void>;
  refreshGoalModeTokenBudget: () => Promise<void>;
  pendingToolAuthorizations: ToolCallInfo[];
  approveToolAuthorization: (toolCall: ToolCallInfo) => void;
  approveToolAuthorizationAlways: (toolCall: ToolCallInfo) => void;
  rejectToolAuthorization: (toolCall: ToolCallInfo, reason: string) => void;
  answerUserQuestion: (
    questionId: string,
    selectedOptions: string[],
    customAnswers: string[]
  ) => void;
  cancelUserQuestion: (questionId: string) => void;
};

// Re-export preload types for convenience
export type {
  ApiConfigRecord,
  ChatConversationRecord,
  ChatMessageRecord,
  CheckpointFileChange,
  TokenUsage,
  UserQuestionRequest,
};

export const PENDING_SESSION_KEY = "__pending__";
export const CHAT_MESSAGE_PAGE_SIZE = 10;
