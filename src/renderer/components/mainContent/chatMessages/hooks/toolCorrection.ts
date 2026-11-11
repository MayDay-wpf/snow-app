import type {
  ToolCorrectionAttempt,
  ToolCorrectionState,
} from "../utils/conversationTypes";

/** 最多执行 3 次修正后的工具调用。 */
export const TOOL_CORRECTION_MAX_ATTEMPTS = 3;

/**
 * 交互类、运行时类与长任务工具不参与自动纠错：
 * - bash 的失败语义不稳定（超时、部分输出、交互会话），无法可靠判断；
 * - 用户问答不是执行失败；
 * - 子代理 / Workflow / 生图有独立生命周期或副作用，重放代价高。
 */
const EXCLUDED_TOOL_NAMES = new Set([
  "bash-terminal-execute",
  "terminal-execute",
  "mcp__bash__terminal-execute",
  "user-interaction-askUserQuestion",
  "sub-agents-activate",
  "sub-agents-continue",
  "sub-agents-sendMessage",
  "workflow-workflow-generate",
  "workflow-workflow-resume",
  "imagegen-generate",
]);

/** 这些失败不是参数问题，纠错 Agent 无能为力。 */
const NON_CORRECTABLE_ERROR_CODES = new Set([
  "TOOL_EXECUTION_DENIED",
  "HOOK_DECISION_REJECTED",
  "HOOK_NOT_CONFIGURED",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const isToolCorrectionEligible = (toolName: string): boolean =>
  Boolean(toolName) && !EXCLUDED_TOOL_NAMES.has(toolName);

/**
 * 从工具结果 JSON 中判断执行失败并返回错误文本。
 * 仅识别结构化失败（error / success=false / isError），避免把普通文本误判为失败。
 */
export const detectToolFailure = (
  result: string | undefined,
): string | null => {
  if (!result) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }

  if (parsed.cancelled === true || parsed.skipped === true) {
    return null;
  }

  if (parsed.success === false) {
    const message =
      typeof parsed.error === "string"
        ? parsed.error
        : typeof parsed.message === "string"
          ? parsed.message
          : "";
    return message.trim() || "Tool execution failed";
  }

  if (typeof parsed.error === "string" && parsed.error.trim()) {
    return parsed.error.trim();
  }

  if (parsed.isError === true) {
    if (Array.isArray(parsed.content)) {
      const text = parsed.content
        .map((block) => {
          if (!isRecord(block)) {
            return "";
          }
          return typeof block.text === "string" ? block.text : "";
        })
        .filter((value) => value.trim().length > 0)
        .join("\n")
        .trim();
      return text || "Tool execution failed";
    }
    return "Tool execution failed";
  }

  return null;
};

export const isNonCorrectableToolFailure = (failure: string): boolean =>
  NON_CORRECTABLE_ERROR_CODES.has(failure.trim());

export type ToolCorrectionToolDefinition = {
  description: string;
  inputSchemaJson: string;
};

export type ToolCorrectionRunOptions = {
  toolName: string;
  originalArguments: string;
  failedResult: string;
  /** 会话绑定的 API 档案；省略时由后端使用全局激活档案。 */
  apiProfile?: string;
  /** 所属会话 ID，用于展开 {{session_id}} 自定义请求头。 */
  conversationId?: string;
  getToolDefinition: () => Promise<ToolCorrectionToolDefinition | null>;
  requestCorrection: (request: {
    toolName: string;
    toolDescription: string;
    inputSchemaJson: string;
    originalArgumentsJson: string;
    failure: string;
    attemptsJson: string;
    attempt: number;
    apiProfile?: string;
    conversationId?: string;
  }) => Promise<{ retry: boolean; argumentsJson: string; reasoning: string }>;
  /** 修正后的调用必须重新经过用户授权；返回 false 时终止纠错。 */
  authorize: (argumentsJson: string, attempt: number) => Promise<boolean>;
  execute: (argumentsJson: string, attempt: number) => Promise<string>;
  onUpdate: (state: ToolCorrectionState) => void;
  isCancelled: () => boolean;
};

export type ToolCorrectionSuccess = {
  arguments: string;
  result: string;
  /** 纠错模型对本次修正的说明。 */
  reasoning: string;
};

/** 模型侧工具结果的纠错附言：避免主流程重复发起同一个失败调用。 */
export const appendToolCorrectionNote = (
  result: string,
  reasoning: string,
): string => {
  const description = reasoning.trim();
  const truncatedDescription =
    description.length > 600 ? `${description.slice(0, 600)}...` : description;
  const detail = truncatedDescription
    ? `\nCorrection note: ${truncatedDescription}`
    : "";
  return `${result}\n\n[Tool Correction] This result was produced by a corrected retry after the original invocation failed.${detail}\nContinue with this result and do not repeat the original failing call.`;
};

/**
 * 落库时单个文本字段的上限：超长工具输出只保留前缀。纠错树只用于审计与
 * 复盘，完整结果本身已保存在工具结果消息里，不必重复入库。
 */
const PERSISTED_TEXT_MAX_CHARS = 20_000;

const truncatePersistedText = (
  value: string | undefined,
): string | undefined => {
  if (value === undefined || value.length <= PERSISTED_TEXT_MAX_CHARS) {
    return value;
  }
  return `${value.slice(0, PERSISTED_TEXT_MAX_CHARS)}\n...[truncated]`;
};

/** 序列化纠错状态用于持久化（重启后重建纠错树）。 */
export const serializeToolCorrectionState = (
  state: ToolCorrectionState,
): string =>
  JSON.stringify({
    ...state,
    attempts: state.attempts.map((attempt) => ({
      ...attempt,
      error: truncatePersistedText(attempt.error),
      result: truncatePersistedText(attempt.result),
    })),
  });

/**
 * 纠错主循环：最多 3 次「模型给出修正参数 -> 重新授权 -> 重新执行」。
 * 成功后返回最终参数与结果；失败时返回 null，调用方继续使用原始错误。
 */
export const runToolCorrection = async (
  options: ToolCorrectionRunOptions,
): Promise<ToolCorrectionSuccess | null> => {
  const originalFailure = detectToolFailure(options.failedResult) ?? "";
  const state: ToolCorrectionState = {
    status: "running",
    attempts: [],
    originalArguments: options.originalArguments,
  };
  const publish = (): void => {
    options.onUpdate({
      ...state,
      attempts: state.attempts.map((attempt) => ({ ...attempt })),
    });
  };

  publish();

  const definition = await options
    .getToolDefinition()
    .catch(() => null as ToolCorrectionToolDefinition | null);

  for (
    let attemptIndex = 1;
    attemptIndex <= TOOL_CORRECTION_MAX_ATTEMPTS;
    attemptIndex++
  ) {
    if (options.isCancelled()) {
      state.status = "abandoned";
      state.failureCode = "cancelled";
      publish();
      return null;
    }

    let response: {
      retry: boolean;
      argumentsJson: string;
      reasoning: string;
    };
    try {
      response = await options.requestCorrection({
        toolName: options.toolName,
        toolDescription: definition?.description ?? "",
        inputSchemaJson: definition?.inputSchemaJson ?? "",
        originalArgumentsJson: options.originalArguments,
        failure: originalFailure,
        attemptsJson: JSON.stringify(
          state.attempts.map((attempt) => ({
            argumentsJson: attempt.arguments,
            error: attempt.error ?? "",
          })),
        ),
        attempt: attemptIndex,
        apiProfile: options.apiProfile,
        conversationId: options.conversationId,
      });
    } catch (error) {
      state.status = "failed";
      state.failureCode = "model_error";
      state.failureDetail = errorText(error);
      publish();
      return null;
    }

    if (!response.retry || !response.argumentsJson.trim()) {
      state.status = "abandoned";
      state.failureCode = "not_repairable";
      if (response.reasoning.trim()) {
        state.failureDetail = response.reasoning.trim();
      }
      publish();
      return null;
    }

    let correctedArguments: string;
    try {
      const parsed: unknown = JSON.parse(response.argumentsJson);
      if (!isRecord(parsed)) {
        throw new Error("Corrected arguments must be a JSON object.");
      }
      correctedArguments = JSON.stringify(parsed);
    } catch (error) {
      state.status = "failed";
      state.failureCode = "model_error";
      state.failureDetail = errorText(error);
      publish();
      return null;
    }

    const attempt: ToolCorrectionAttempt = {
      index: attemptIndex,
      status: "running",
      arguments: correctedArguments,
      reasoning: response.reasoning.trim() || undefined,
      startedAt: Date.now(),
    };
    state.attempts.push(attempt);
    publish();

    let approved = false;
    try {
      approved = await options.authorize(correctedArguments, attemptIndex);
    } catch {
      approved = false;
    }
    if (!approved) {
      attempt.status = "rejected";
      attempt.finishedAt = Date.now();
      state.status = "abandoned";
      state.failureCode = "rejected";
      publish();
      return null;
    }

    if (options.isCancelled()) {
      attempt.status = "failed";
      attempt.error = "Conversation cancelled";
      attempt.finishedAt = Date.now();
      state.status = "abandoned";
      state.failureCode = "cancelled";
      publish();
      return null;
    }

    let correctedResult: string;
    try {
      correctedResult = await options.execute(correctedArguments, attemptIndex);
    } catch (error) {
      correctedResult = JSON.stringify({ error: errorText(error) });
    }

    const failure = detectToolFailure(correctedResult);
    if (!failure) {
      attempt.status = "succeeded";
      attempt.result = correctedResult;
      attempt.finishedAt = Date.now();
      state.status = "succeeded";
      publish();
      return {
        arguments: correctedArguments,
        result: correctedResult,
        reasoning: response.reasoning.trim(),
      };
    }

    attempt.status = "failed";
    attempt.error = failure;
    attempt.result = correctedResult;
    attempt.finishedAt = Date.now();
    publish();
  }

  state.status = "failed";
  state.failureCode = "max_attempts";
  publish();
  return null;
};
