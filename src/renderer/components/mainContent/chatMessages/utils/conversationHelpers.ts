import type {
  ChatConversationMessage,
  ToolCallInfo,
} from "./conversationTypes";
import type { ChatMessageRecord } from "../../../../../preload";
import { resolveResponseDisposition } from "./responseDisposition";

export const deleteCheckpoints = (checkpointIds: string[]): void => {
  for (const checkpointId of checkpointIds) {
    void window.snow.deleteCheckpoint(checkpointId).catch(() => {
      // Checkpoint cleanup is best effort.
    });
  }
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
  new Date().toLocaleTimeString("zh-CN", {
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
    error instanceof Error ? error.message : "AI 响应失败，请稍后重试。";
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
  data: string;
  mimeType: string;
};

const isMcpImageContentBlock = (
  value: unknown,
): value is McpImageContentBlock => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const block = value as Record<string, unknown>;
  return (
    block.type === "image" &&
    typeof block.data === "string" &&
    block.data.length > 0 &&
    typeof block.mimeType === "string" &&
    block.mimeType.startsWith("image/")
  );
};

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
            data: "[attached as multimodal image]",
          }
        : block,
    );
    const imageTags = images.map(
      (image) => `@@image:data:${image.mimeType};base64,${image.data}@@`,
    );
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
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
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
      if (typeof current === "object" && current !== null && !Array.isArray(current)) {
        return Object.keys(current).length > 0 ? JSON.stringify(current) : undefined;
      }
      return undefined;
    }
    if (typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)) {
      return Object.keys(candidate).length > 0 ? JSON.stringify(candidate) : undefined;
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
      const toolCalls =
        assistantDisposition?.kind === "incomplete"
          ? []
          : parseToolCalls(record.toolCallsJson).map((toolCall) => {
              const result = consumeToolResult(toolCall);
              return {
                ...toolCall,
                status:
                  result === undefined
                    ? ("error" as const)
                    : ("completed" as const),
                result,
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
        timestamp: record.createdAt,
        status: messageStatus,
        responseId: record.responseId || undefined,
        checkpointId: record.checkpointId || undefined,
        model: record.model || undefined,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        isContextCompaction: record.status === "context_compaction",
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
): boolean =>
  target.callId
    ? candidate.callId === target.callId
    : candidate.name === target.name &&
      candidate.arguments === target.arguments;

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
    "bash-terminal-execute": ["command"],
  };
  const requiredBooleanArguments: Record<string, readonly string[]> = {
    "filesystem-create": ["overwrite"],
  };
  const args = parsedArguments as Record<string, unknown>;
  const missing = [
    ...(requiredStringArguments[toolCall.name] ?? []).filter(
      (key) => typeof args[key] !== "string" || args[key].trim().length === 0,
    ),
    ...(requiredBooleanArguments[toolCall.name] ?? []).filter(
      (key) => typeof args[key] !== "boolean",
    ),
  ];
  if (missing.length > 0) {
    return JSON.stringify({
      error: "INVALID_MODEL_TOOL_CALL",
      message: `Model returned an incomplete call for tool "${toolCall.name}". Missing required arguments: ${missing.join(", ")}. The call was not executed.`,
    });
  }

  return null;
};
