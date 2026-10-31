import type {
  ChatConversationMessage,
  ToolCallInfo,
  ToolCorrectionAttempt,
  ToolCorrectionAttemptStatus,
  ToolCorrectionState,
  ToolCorrectionStatus,
  TokenUsage,
} from "./conversationTypes";
import type { ChatMessageRecord } from "../../../../../preload";
import { getActiveLocale, tGlobal } from "../../../../i18n";
import {
  isResponseHtmlPreviewEligible,
  resolveResponseDisposition,
} from "./responseDisposition";
import { IMAGE_DATA_PLACEHOLDER, isUploadImagePath } from "./inlineImages";

export const deleteCheckpoints = (checkpointIds: string[]): void => {
  for (const checkpointId of checkpointIds) {
    void window.snow.deleteCheckpoint(checkpointId).catch(() => {
      // Checkpoint cleanup is best effort.
    });
  }
};

/**
 * 从持久化消息记录里还原「上下文 token 快照」：最后一条 assistant（或压缩
 * 边界）行记录了产生它的那次请求用量，等价于当前的上下文规模。用于会话
 * 重新加载 / 回滚后恢复显示与自动压缩判断（schema v46+ 每条 assistant 行都
 * 持久化了该次请求用量）；查不到（旧数据全为 0）返回 null。
 */
export const tokenUsageFromMessageRecords = (
  records: {
    role: string;
    status: string;
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
  }[],
): TokenUsage | null => {
  const lastContextSnapshot = records.findLast(
    (record) =>
      record.role === "assistant" || record.status === "context_compaction",
  );
  if (!lastContextSnapshot) {
    return null;
  }
  const usage: TokenUsage = {
    inputTokens: lastContextSnapshot.inputTokens,
    outputTokens: lastContextSnapshot.outputTokens,
    cacheCreationInputTokens: lastContextSnapshot.cacheCreationInputTokens,
    cacheReadInputTokens: lastContextSnapshot.cacheReadInputTokens,
  };
  return usage.inputTokens + usage.outputTokens > 0 ? usage : null;
};

/**
 * 从 directoryId(local:<path> 或 ssh:ssh://... )提取工作目录路径。
 * 会话绑定创建时的 directoryId,而 checkpoint / 工具 cwd 需要真实路径。
 * 工具的 cwd 必须跟随会话自己的目录,而非运行时全局 activeDirectory,
 * 否则切换项目后 checkpoint 目录不匹配,所有工具都会被后端拦截。
 */
export const directoryIdToPath = (
  directoryId: string | undefined,
): string | undefined => {
  if (!directoryId) return undefined;
  if (directoryId.startsWith("local:")) {
    return directoryId.slice("local:".length);
  }
  if (directoryId.startsWith("ssh:")) {
    // SSH 工作区的 directoryId 形如 "ssh:ssh://user@host:22/path"，
    // 剥离 "ssh:" 前缀得到 checkpoint / 工具使用的 ssh:// URI。
    return directoryId.slice("ssh:".length);
  }
  return directoryId;
};

/** WorkTree 绑定缺失/失效（fail-closed），UI 据 code 映射为可读提示。 */
export class WorktreeBindingError extends Error {
  readonly code = "WORKTREE_BINDING_MISSING";
  constructor(message: string) {
    super(message);
    this.name = "WorktreeBindingError";
  }
}

export const isWorktreeBindingError = (
  error: unknown,
): error is WorktreeBindingError =>
  error instanceof WorktreeBindingError ||
  (typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "WORKTREE_BINDING_MISSING");

/** 本地运行失败原因：WorkTree 绑定错误走本地化文案，其余保留原始错误。 */
export const getRunFailureReason = (error: unknown): string =>
  isWorktreeBindingError(error)
    ? tGlobal("chat.error.worktreeBindingMissing")
    : getErrorMessage(error);

/** 会话是否持有属于该项目的有效 WorkTree 绑定。 */
export const hasValidConversationWorktree = async (
  conversationId: string,
  directoryId: string | undefined,
): Promise<boolean> => {
  if (!conversationId.trim() || !directoryId?.trim()) return false;
  const binding = await window.snow.getConversationWorktree(conversationId);
  return Boolean(
    binding &&
    binding.isValid &&
    binding.directoryId === directoryId &&
    binding.worktreePath.trim(),
  );
};

/** Resolve the immutable execution/checkpoint root for a conversation. */
export const resolveConversationWorkspacePath = async (
  conversationId: string,
  directoryId: string | undefined,
  fallbackPath: string | undefined,
  worktreeMode?: boolean,
  explicitWorktreeId?: string | null,
): Promise<string | undefined> => {
  if (!directoryId?.trim()) {
    return fallbackPath;
  }

  // 1. 如果显式提供了预选或指定的 worktreeId，直接通过工作树列表验证并解析真实路径
  if (explicitWorktreeId?.trim()) {
    const list = await window.snow.gitListWorktrees(directoryId);
    const matched = list.find((item) => item.worktreeId === explicitWorktreeId);
    if (
      matched &&
      matched.isValid &&
      matched.directoryId === directoryId &&
      matched.worktreePath.trim()
    ) {
      return matched.worktreePath;
    }
    if (worktreeMode) {
      throw new WorktreeBindingError(
        "WorkTree binding is missing, invalid, or belongs to a different project directory",
      );
    }
  }

  // 2. 如果存在持久化会话 ID，从数据库持久化绑定中获取
  if (conversationId.trim()) {
    const binding = await window.snow.getConversationWorktree(conversationId);
    if (
      binding &&
      binding.isValid &&
      binding.directoryId === directoryId &&
      binding.worktreePath.trim()
    ) {
      return binding.worktreePath;
    }
    if (worktreeMode) {
      throw new WorktreeBindingError(
        "WorkTree binding is missing, invalid, or belongs to a different project directory",
      );
    }
  }

  // 3. 仅在显式开启 worktreeMode 且既无预选也无会话绑定时抛出错误
  if (worktreeMode) {
    throw new WorktreeBindingError(
      "WorkTree execution requires a conversation or preselected worktree, and project directory",
    );
  }

  return fallbackPath;
};

/** Persist the parent's binding for a child session before it can execute. */
export const inheritConversationWorktreeBinding = async (
  parentConversationId: string,
  childConversationId: string,
  directoryId: string,
  worktreeMode?: boolean,
): Promise<boolean> => {
  const binding =
    await window.snow.getConversationWorktree(parentConversationId);
  if (
    !binding ||
    !binding.isValid ||
    binding.directoryId !== directoryId ||
    !binding.worktreePath.trim()
  ) {
    if (worktreeMode) {
      throw new Error(
        "Parent WorkTree binding is missing, invalid, or belongs to a different project directory",
      );
    }
    return false;
  }
  await window.snow.setConversationWorktree(
    childConversationId,
    binding.worktreeId,
  );
  if (worktreeMode) {
    await window.snow.setConversationModes(
      childConversationId,
      false,
      true,
      false,
      null,
    );
  }
  return Boolean(worktreeMode);
};

/**
 * Kill every in-flight tool execution of a session (bash subprocesses, SSH
 * grep-search, remote filesystem commands, ...). Iterates the running tool
 * calls and calls the Rust abort API for each known execution id, so stopping
 * a session also terminates the underlying OS process / closes the SSH exec
 * channel instead of leaving it running until its timeout.
 * Fire-and-forget: an execution that just finished naturally is a no-op.
 */
export const killRunningToolExecutions = (
  messages: ChatConversationMessage[],
): void => {
  const executionIds = new Set<string>();
  for (const message of messages) {
    for (const toolCall of message.toolCalls ?? []) {
      if (
        (toolCall.status === "running" || toolCall.status === "pending") &&
        toolCall.toolExecutionId
      ) {
        executionIds.add(toolCall.toolExecutionId);
      }
    }
  }
  for (const executionId of executionIds) {
    void window.snow.abortToolExecution(executionId).catch(() => {
      // The execution may have just finished; nothing to do.
    });
  }
};

export const formatMessageTime = (): string =>
  new Date().toLocaleTimeString(getActiveLocale(), {
    hour: "2-digit",
    minute: "2-digit",
  });

export const createMessageId = (
  role: ChatConversationMessage["role"],
): string => `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Extract a user-facing message from an unknown error. Electron wraps every
 * rejected ipcMain.handle as "Error invoking remote method '<channel>': ..."
 * which leaks internal IPC names (e.g. mcp:call-tool); strip that wrapper so
 * only the underlying reason reaches the UI / model.
 */
export const getErrorMessage = (error: unknown): string => {
  const message =
    error instanceof Error
      ? error.message
      : tGlobal("chat.responseFailedFallback");
  return message.replace(
    /^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/,
    "",
  );
};

/** Treat provider terminal failures and locally persisted errors identically. */
export const isResponseErrorStatus = (status: string): boolean =>
  status === "error" || status === "failed";

type McpImageContentBlock = {
  type: "image";
  data?: string;
  path?: string;
  mimeType: string;
};

/** 图片块：带真实 base64，或 data 为占位符、图片已由 Rust 落盘到 upload/。 */
const isMcpImageContentBlock = (
  value: unknown,
): value is McpImageContentBlock => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const block = value as Record<string, unknown>;
  if (
    block.type !== "image" ||
    typeof block.mimeType !== "string" ||
    !block.mimeType.startsWith("image/")
  ) {
    return false;
  }
  const hasInlineData =
    typeof block.data === "string" &&
    block.data.length > 0 &&
    block.data !== IMAGE_DATA_PLACEHOLDER;
  return hasInlineData || isUploadImagePath(block.path);
};

/** 图片块转为模型可见的内联标签：落盘路径优先，Rust 组装请求时按路径读盘。 */
const imageBlockTag = (block: McpImageContentBlock): string =>
  isUploadImagePath(block.path)
    ? `@@image:${block.path}@@`
    : `@@image:data:${block.mimeType};base64,${block.data}@@`;

export const formatMcpToolResultForModel = (result: string): string => {
  try {
    const parsed = JSON.parse(result) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return result;
    }
    const record = parsed as Record<string, unknown>;
    if (!Array.isArray(record.content)) {
      return result;
    }

    const images = record.content.filter(isMcpImageContentBlock);
    if (images.length === 0) {
      return result;
    }
    const sanitizedContent = record.content.map((block) =>
      isMcpImageContentBlock(block)
        ? {
            type: "image",
            mimeType: block.mimeType,
            data: IMAGE_DATA_PLACEHOLDER,
          }
        : block,
    );
    const imageTags = images.map(imageBlockTag);
    return `${JSON.stringify({
      ...record,
      content: sanitizedContent,
    })}\n${imageTags.join("\n")}`;
  } catch {
    return result;
  }
};

export const normalizeToolCallArguments = (args: unknown): string => {
  if (typeof args === "string") {
    return args;
  }
  if (typeof args === "object" && args !== null) {
    return JSON.stringify(args);
  }
  return "{}";
};

export const isUserQuestionCancellationResult = (
  resultJson: string,
): boolean => {
  try {
    const parsed: unknown = JSON.parse(resultJson);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>).cancelled === true
    );
  } catch {
    return false;
  }
};

export const isValidToolName = (name: string): boolean => {
  // Valid format: {server_id}-{tool_name}, must contain at least one `-`
  // and have non-empty parts on both sides of the first `-`.
  const dashIndex = name.indexOf("-");
  if (dashIndex <= 0) {
    return false;
  }
  const toolName = name.slice(dashIndex + 1);
  return toolName.length > 0;
};

const POLLUTION_CHARS = /[<>[\]#\s"'`]/;

const normalizeToolCallName = (tc: Record<string, unknown>): string => {
  const directName = typeof tc.name === "string" ? tc.name.trim() : "";
  let name = directName;
  if (!name) {
    const func = tc.function;
    if (typeof func === "object" && func !== null && !Array.isArray(func)) {
      const funcRecord = func as Record<string, unknown>;
      name = typeof funcRecord.name === "string" ? funcRecord.name.trim() : "";
    }
  }
  if (!name) {
    const functionCall = tc.functionCall ?? tc.function_call;
    if (
      typeof functionCall === "object" &&
      functionCall !== null &&
      !Array.isArray(functionCall)
    ) {
      const functionCallRecord = functionCall as Record<string, unknown>;
      name =
        typeof functionCallRecord.name === "string"
          ? functionCallRecord.name.trim()
          : "";
    }
  }
  if (!name) {
    return "";
  }

  // Only extract a valid {server}-{tool} fragment when the name is actually
  // polluted (the AI copied "[Tool: name#callId]" from conversation history
  // or leaked internal XML tags). Clean names are preserved verbatim —
  // including provider-specific formats such as Gemini relays' "server:tool"
  // names, which the extraction regex would otherwise truncate (e.g.
  // "file-directory-list:file-directory-list" -> "file-directory-list"),
  // breaking functionResponse/functionCall name matching on the next request.
  if (POLLUTION_CHARS.test(name)) {
    const mcpMatch = name.match(/[A-Za-z0-9_-]+-[A-Za-z0-9_-]+/);
    if (mcpMatch) {
      return mcpMatch[0];
    }
  }

  return name;
};

const normalizeToolCallArgumentsFromTc = (
  tc: Record<string, unknown>,
): string => {
  const candidates = [
    tc.arguments,
    tc.args,
    tc.input,
    (tc.function as Record<string, unknown> | undefined)?.arguments,
    (tc.function as Record<string, unknown> | undefined)?.args,
    (tc.functionCall as Record<string, unknown> | undefined)?.args,
    (tc.functionCall as Record<string, unknown> | undefined)?.arguments,
    (tc.function_call as Record<string, unknown> | undefined)?.args,
    (tc.function_call as Record<string, unknown> | undefined)?.arguments,
  ];

  const normalizeCandidate = (candidate: unknown): string | undefined => {
    if (typeof candidate === "string") {
      let current: unknown = candidate.trim();
      // Some relays serialize functionCall/arguments twice. Unwrap only JSON
      // objects so ordinary string arguments retain their original value.
      for (let depth = 0; depth < 2 && typeof current === "string"; depth++) {
        if (!current || current === "{}") break;
        try {
          const parsed: unknown = JSON.parse(current);
          if (
            typeof parsed !== "object" ||
            parsed === null ||
            Array.isArray(parsed)
          ) {
            break;
          }
          current = parsed;
        } catch {
          break;
        }
      }
      if (typeof current === "string") {
        return current.length > 0 ? current : undefined;
      }
      if (
        typeof current === "object" &&
        current !== null &&
        !Array.isArray(current)
      ) {
        return Object.keys(current).length > 0
          ? JSON.stringify(current)
          : undefined;
      }
      return undefined;
    }
    if (
      typeof candidate === "object" &&
      candidate !== null &&
      !Array.isArray(candidate)
    ) {
      return Object.keys(candidate).length > 0
        ? JSON.stringify(candidate)
        : undefined;
    }
    return undefined;
  };

  for (const cand of candidates) {
    const normalized = normalizeCandidate(cand);
    if (normalized && normalized !== "{}") {
      return normalized;
    }
  }

  for (const cand of candidates) {
    const normalized = normalizeCandidate(cand);
    if (normalized) {
      return normalized;
    }
  }

  /*
   * A few Gemini relays wrap the actual call one level below `call` or
   * `functionCall`. Keep this fallback deliberately narrow: it only unwraps
   * known provider keys and never guesses arbitrary object fields.
   */
  for (const wrapperKey of ["call", "functionCall", "function_call"]) {
    const wrapper = tc[wrapperKey];
    if (typeof wrapper === "string") {
      try {
        const parsed = JSON.parse(wrapper) as Record<string, unknown>;
        const nested = normalizeToolCallArgumentsFromTc(parsed);
        if (nested !== "{}") return nested;
      } catch {
        // Keep the empty-argument fallback below.
      }
    }
  }

  return "{}";
};

const normalizeToolCallId = (
  tc: Record<string, unknown>,
): string | undefined => {
  const readCallId = (record: Record<string, unknown>): string | undefined => {
    for (const key of ["call_id", "callId", "id"]) {
      if (typeof record[key] === "string") {
        return record[key];
      }
    }
    return undefined;
  };

  const topLevelCallId = readCallId(tc);
  if (topLevelCallId) {
    return topLevelCallId;
  }

  for (const key of ["functionCall", "function_call"]) {
    const functionCall = tc[key];
    if (
      typeof functionCall === "object" &&
      functionCall !== null &&
      !Array.isArray(functionCall)
    ) {
      const nestedCallId = readCallId(functionCall as Record<string, unknown>);
      if (nestedCallId) {
        return nestedCallId;
      }
    }
  }

  return undefined;
};

/**
 * Format structured tool results into the `[Tool: identifier]\n<result>`
 * text format that is persisted as the `content` of tool messages in the
 * database. `buildConversationMessages` (history replay) and the Rust
 * `extract_tool_result` helper both parse this format to reconstruct the
 * link between a tool call and its result, so the content MUST stay in sync
 * with the regex in `buildConversationMessages`.
 *
 * The identifier is `name#callId` when a callId is available, otherwise just
 * `name`. Segments are joined with `\n\n`.
 */
export const formatToolResultsContent = (
  structuredResults: ReadonlyArray<{
    name: string;
    callId: string;
    result: string;
  }>,
): string =>
  structuredResults
    .map((entry) => {
      const identifier = entry.callId
        ? `${entry.name}#${entry.callId}`
        : entry.name;
      return `[Tool: ${identifier}]\n${entry.result}`;
    })
    .join("\n\n");

export const parseToolCalls = (
  toolCallsJson: string | undefined,
): ToolCallInfo[] => {
  if (!toolCallsJson) {
    return [];
  }

  try {
    const parsed = JSON.parse(toolCallsJson);
    if (Array.isArray(parsed) && parsed.length > 0) {
      const parseBatchId = `${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      return parsed
        .map((tc: unknown, index: number): ToolCallInfo | null => {
          if (typeof tc !== "object" || tc === null || Array.isArray(tc)) {
            return null;
          }
          const record = tc as Record<string, unknown>;
          const name = normalizeToolCallName(record) || "unknown";
          const callId = normalizeToolCallId(record);
          return {
            name,
            arguments: normalizeToolCallArgumentsFromTc(record),
            callId,
            interactionId: callId
              ? `tool-${callId}`
              : `tool-${parseBatchId}-${index}`,
            status: "pending" as const,
          };
        })
        .filter((tc): tc is ToolCallInfo => tc !== null);
    }
  } catch {
    // Not valid JSON, no tool calls
  }

  return [];
};

const TOOL_CORRECTION_STATUSES: ReadonlySet<string> = new Set([
  "running",
  "succeeded",
  "failed",
  "abandoned",
]);

const TOOL_CORRECTION_ATTEMPT_STATUSES: ReadonlySet<string> = new Set([
  "running",
  "failed",
  "succeeded",
  "rejected",
]);

const parsePersistedCorrectionAttempt = (
  value: unknown,
  fallbackIndex: number,
): ToolCorrectionAttempt | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const rawStatus = typeof record.status === "string" ? record.status : "";
  if (!TOOL_CORRECTION_ATTEMPT_STATUSES.has(rawStatus)) {
    return null;
  }

  const startedAt = typeof record.startedAt === "number" ? record.startedAt : 0;
  // 应用重启后不可能还有执行中的纠错：把遗留的 running 收敛为失败，
  // 避免历史卡片一直显示「纠错中」。
  const interrupted = rawStatus === "running";
  const status: ToolCorrectionAttemptStatus = interrupted
    ? "failed"
    : (rawStatus as ToolCorrectionAttemptStatus);
  const finishedAt =
    typeof record.finishedAt === "number"
      ? record.finishedAt
      : interrupted
        ? startedAt
        : undefined;

  return {
    index: typeof record.index === "number" ? record.index : fallbackIndex,
    status,
    arguments: typeof record.arguments === "string" ? record.arguments : "",
    reasoning:
      typeof record.reasoning === "string" ? record.reasoning : undefined,
    error: typeof record.error === "string" ? record.error : undefined,
    result: typeof record.result === "string" ? record.result : undefined,
    startedAt,
    finishedAt,
  };
};

const parsePersistedCorrection = (
  value: unknown,
): ToolCorrectionState | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const rawStatus = typeof record.status === "string" ? record.status : "";
  if (!TOOL_CORRECTION_STATUSES.has(rawStatus)) {
    return null;
  }

  const attempts = Array.isArray(record.attempts)
    ? record.attempts
        .map((attempt, index) =>
          parsePersistedCorrectionAttempt(attempt, index + 1),
        )
        .filter((attempt): attempt is ToolCorrectionAttempt => attempt !== null)
    : [];

  const interrupted = rawStatus === "running";
  const status: ToolCorrectionStatus = interrupted
    ? "abandoned"
    : (rawStatus as ToolCorrectionStatus);
  const persistedFailureCode =
    typeof record.failureCode === "string" ? record.failureCode : "";

  return {
    status,
    attempts,
    originalArguments:
      typeof record.originalArguments === "string"
        ? record.originalArguments
        : "",
    failureCode: interrupted
      ? "cancelled"
      : (persistedFailureCode as ToolCorrectionState["failureCode"]) ||
        undefined,
    failureDetail:
      typeof record.failureDetail === "string"
        ? record.failureDetail
        : undefined,
  };
};

/**
 * 解析持久化的纠错状态映射（callId -> state）。历史重放时挂回对应工具
 * 调用，重启后仍能展开查看纠错树（审计用途）。
 */
export const parseToolCorrections = (
  correctionsJson: string | undefined,
): Record<string, ToolCorrectionState> => {
  if (!correctionsJson) {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(correctionsJson);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {};
    }

    const corrections: Record<string, ToolCorrectionState> = {};
    for (const [callId, value] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      const correction = parsePersistedCorrection(value);
      if (correction) {
        corrections[callId] = correction;
      }
    }
    return corrections;
  } catch {
    return {};
  }
};

/**
 * Strips hook-appended sections ([Hook Context] and [Hook Warning]) from
 * user message content. These sections are appended to the message before
 * sending to the AI and persist in the database, but should not be shown
 * to the user as part of their original message — otherwise the displayed
 * text becomes much longer than what the user actually typed.
 */
const stripHookSections = (content: string): string =>
  content.replace(/\n\n\[Hook (?:Warning|Context)\]\n[\s\S]*$/, "");

export const buildConversationMessages = (
  records: ChatMessageRecord[],
): ChatConversationMessage[] => {
  const toolResultQueues = new Map<string, string[]>();
  for (const record of records) {
    if (record.role !== "tool" || !record.content) {
      continue;
    }

    for (const segment of record.content.split("\n\n")) {
      const match = segment.match(/^\[Tool:\s*(.+?)\]\n([\s\S]*)$/);
      if (!match) {
        continue;
      }
      const queue = toolResultQueues.get(match[1]) ?? [];
      queue.push(match[2]);
      toolResultQueues.set(match[1], queue);
    }
  }

  const consumeToolResult = (toolCall: ToolCallInfo): string | undefined => {
    const identifiers = toolCall.callId
      ? [`${toolCall.name}#${toolCall.callId}`, toolCall.name]
      : [toolCall.name];

    for (const identifier of identifiers) {
      const queue = toolResultQueues.get(identifier);
      if (queue && queue.length > 0) {
        return queue.shift();
      }
    }

    return undefined;
  };

  return records
    .filter((record) => record.role !== "tool")
    .map((record) => {
      const assistantDisposition =
        record.role === "user" ? null : resolveResponseDisposition(record);
      const toolCorrections = parseToolCorrections(record.toolCorrectionsJson);
      const toolCalls =
        assistantDisposition?.kind === "incomplete"
          ? []
          : parseToolCalls(record.toolCallsJson).map((toolCall) => {
              const result = consumeToolResult(toolCall);
              const correction = toolCall.callId
                ? toolCorrections[toolCall.callId]
                : undefined;
              return {
                ...toolCall,
                status:
                  result === undefined
                    ? ("error" as const)
                    : ("completed" as const),
                result,
                ...(correction ? { correction } : {}),
              };
            });
      const messageStatus: NonNullable<ChatConversationMessage["status"]> =
        record.role === "user"
          ? isResponseErrorStatus(record.status)
            ? "error"
            : "sent"
          : assistantDisposition?.kind === "error"
            ? "error"
            : assistantDisposition?.kind === "incomplete"
              ? "incomplete"
              : "sent";

      return {
        id: record.id,
        role: record.role === "user" ? "user" : "assistant",
        content:
          record.role === "user"
            ? stripHookSections(record.content)
            : record.content,
        thinking: record.thinking || undefined,
        thinkingDurationMs: record.thinkingDurationMs || undefined,
        thinkingTokenCount: record.thinkingTokenCount || undefined,
        timestamp: record.createdAt,
        status: messageStatus,
        failureReason:
          assistantDisposition?.kind === "error"
            ? record.failureReason || undefined
            : undefined,
        htmlPreviewEligible:
          record.role !== "user" && isResponseHtmlPreviewEligible(record),
        responseId: record.responseId || undefined,
        checkpointId: record.checkpointId || undefined,
        model: record.model || undefined,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        isContextCompaction: record.status === "context_compaction",
        // 自动重试元数据：空响应终态重载后仍能显示「重试已耗尽 (N)」与上游
        // 错误原文，而不是只剩一条通用说明。
        ...(record.retryAttempts > 0
          ? {
              retryAttempt: record.retryAttempts,
              retryError: record.retryError || undefined,
            }
          : {}),
        ...(assistantDisposition?.kind === "incomplete"
          ? {
              incompleteVariant: assistantDisposition.variant,
              interruptionReason: assistantDisposition.reason,
              recoveryOutcome: assistantDisposition.recoveryOutcome,
            }
          : {}),
      };
    });
};

export const isSameToolCall = (
  candidate: ToolCallInfo,
  target: ToolCallInfo,
): boolean => {
  if (candidate.name !== target.name) return false;
  if (target.callId) {
    return (
      candidate.callId === target.callId &&
      (!target.interactionId ||
        candidate.interactionId === target.interactionId)
    );
  }
  return (
    Boolean(target.interactionId) &&
    candidate.interactionId === target.interactionId
  );
};

export const updateFirstMatchingToolCall = (
  toolCalls: ToolCallInfo[] | undefined,
  target: ToolCallInfo,
  expectedStatus:
    ToolCallInfo["status"] | ReadonlyArray<ToolCallInfo["status"]>,
  update: (toolCall: ToolCallInfo) => ToolCallInfo,
): ToolCallInfo[] | undefined => {
  if (!toolCalls) {
    return undefined;
  }

  let hasUpdated = false;
  return toolCalls.map((toolCall) => {
    if (
      hasUpdated ||
      !(Array.isArray(expectedStatus)
        ? expectedStatus.includes(toolCall.status)
        : toolCall.status === expectedStatus) ||
      !isSameToolCall(toolCall, target)
    ) {
      return toolCall;
    }

    hasUpdated = true;
    return update(toolCall);
  });
};

/**
 * Validate tool call before execution. Returns an error message string if
 * the tool call should not be executed, or null if it is valid.
 *
 * When the AI provides malformed tool names or invalid JSON arguments, we
 * return a descriptive error instead of calling the Rust backend. This error
 * is fed back into the conversation so the AI can self-correct in the next
 * iteration of the agent loop.
 */
export const validateToolCall = (toolCall: ToolCallInfo): string | null => {
  if (!isValidToolName(toolCall.name)) {
    return JSON.stringify({
      error: `Invalid tool name format: "${toolCall.name}". Tool names must follow the format "{server}-{tool}". Please check the available tool definitions and use the correct full name.`,
    });
  }

  // Validate that arguments is parseable JSON
  let parsedArguments: unknown = {};
  if (toolCall.arguments) {
    try {
      parsedArguments = JSON.parse(toolCall.arguments);
    } catch {
      return JSON.stringify({
        error: `Arguments for tool "${
          toolCall.name
        }" is not valid JSON: ${toolCall.arguments.slice(
          0,
          200,
        )}. Please provide arguments as a valid JSON object.`,
      });
    }
  }

  if (
    typeof parsedArguments !== "object" ||
    parsedArguments === null ||
    Array.isArray(parsedArguments)
  ) {
    return JSON.stringify({
      error: `Arguments for tool "${toolCall.name}" must be a JSON object.`,
    });
  }

  // Providers may emit a syntactically valid empty object for an incomplete
  // function call. Do not forward those calls to MCP: its parameter error can
  // otherwise be replayed to the model and form a retry loop.
  const requiredStringArguments: Record<string, readonly string[]> = {
    "filesystem-read": ["filePath"],
    "filesystem-create": ["filePath", "content"],
    "filesystem-replace_edit": ["filePath", "searchContent", "replaceContent"],
    "filesystem-copy": ["filePath", "sourceFilePath"],
    "bash-terminal-execute": ["command"],
    "imagegen-generate": ["prompt"],
  };
  const requiredNumberArguments: Record<string, readonly string[]> = {
    "filesystem-copy": ["sourceStartLine"],
  };
  const args = parsedArguments as Record<string, unknown>;
  const missing = [
    ...(requiredStringArguments[toolCall.name] ?? []).filter(
      (key) => typeof args[key] !== "string" || args[key].trim().length === 0,
    ),
    ...(requiredNumberArguments[toolCall.name] ?? []).filter(
      (key) => typeof args[key] !== "number",
    ),
  ];
  if (missing.length > 0) {
    return JSON.stringify({
      error: "INVALID_MODEL_TOOL_CALL",
      message: `Model returned an incomplete call for tool "${toolCall.name}". Missing required arguments: ${missing.join(
        ", ",
      )}. The call was not executed.`,
    });
  }

  return null;
};

/** 每次翻页后等待会话窗口刷新的轮询间隔与次数（渲染写回通常在下一帧）。 */
const MESSAGE_LOAD_GROWTH_POLL_MS = 20;
const MESSAGE_LOAD_GROWTH_ATTEMPTS = 25;

/** 跨页定位的预算：页数与总时长同时兜底，目标过旧时给出失败结果。 */
export type MessageLoadBudget = {
  /** 最多向前翻多少页。 */
  maxPages: number;
  /** 总时长上限（毫秒）。 */
  timeoutMs: number;
};

/**
 * 默认预算：远控桥沿用（手机端在 HTTP 请求内等待，不宜过长）。桌面临时定位
 * 历史消息时可按需放宽（见 useRollbackPicker）。
 */
export const DEFAULT_MESSAGE_LOAD_BUDGET: MessageLoadBudget = {
  maxPages: 30,
  timeoutMs: 8_000,
};

export type MessageWindowAccess = {
  /** 目标消息是否已在内存消息窗口内。 */
  isLoaded: (messageId: string) => boolean;
  /** 是否还有更早的分页未加载。 */
  hasMoreMessages: () => boolean;
  /** 窗口内已加载的消息条数：翻页后据此确认渲染是否写回。 */
  getLoadedCount: () => number;
  /** 加载更早一页（会话上下文同一条 loadOlderMessages 通道）。 */
  loadOlderMessages: () => Promise<void>;
  /** 可选：调用方放弃本次定位（关闭面板 / 取消）时提前退出。 */
  isCancelled?: () => boolean;
};

/**
 * 确保目标消息进入会话的内存消息窗口，返回是否已就绪。
 *
 * 会话历史按页加载（每页 CHAT_MESSAGE_PAGE_SIZE 条），分页窗口之外的历史
 * 消息没有内存副本；而回滚的检查点清单、截断边界与回滚后的内存消息更新
 * 都以内存窗口为基准，跨页目标直接回滚会静默失败。这里沿 loadOlderMessages
 * 逐页向前推进，并等待渲染写回（翻页结果是异步 setSessions），直到目标进入
 * 窗口；预算耗尽时返回 false 由调用方提示。
 */
export const ensureMessageLoaded = async (
  messageId: string,
  access: MessageWindowAccess,
  budget: MessageLoadBudget = DEFAULT_MESSAGE_LOAD_BUDGET,
): Promise<boolean> => {
  const isCancelled = access.isCancelled ?? ((): boolean => false);
  const deadline = Date.now() + budget.timeoutMs;

  for (let page = 0; page < budget.maxPages; page += 1) {
    if (access.isLoaded(messageId)) {
      return true;
    }
    if (isCancelled() || !access.hasMoreMessages() || Date.now() >= deadline) {
      return false;
    }

    const loadedCount = access.getLoadedCount();
    await access.loadOlderMessages();
    if (isCancelled()) {
      return false;
    }

    // 没有增长（并发加载卡住 / 请求失败）时不空转。
    let grew = false;
    for (
      let attempt = 0;
      attempt < MESSAGE_LOAD_GROWTH_ATTEMPTS;
      attempt += 1
    ) {
      if (access.getLoadedCount() > loadedCount) {
        grew = true;
        break;
      }
      if (isCancelled()) {
        return false;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, MESSAGE_LOAD_GROWTH_POLL_MS),
      );
    }
    if (!grew) {
      return false;
    }
  }

  return access.isLoaded(messageId);
};
