import type { ToolCallInfo } from "../../utils/conversationTypes";

export type ParsedQuestionArgs = {
  question: string;
  options: string[];
};

export type ParsedQuestionResult = {
  cancelled: boolean;
  selectedOptions: string[];
  customAnswers: string[];
};

/** 提问卡片的终态展示枚举（等待 / 已回答 / 已取消 / 已中断 / 失败）。 */
export type UserQuestionStatus =
  "waiting" | "answered" | "cancelled" | "interrupted" | "error";

export type UserQuestionView = {
  question: string;
  options: string[];
  questionId?: string;
  questionState: ToolCallInfo["userQuestion"];
  parsedResult: ParsedQuestionResult | null;
  status: UserQuestionStatus;
  /** 工具已运行但题目尚未下发（userQuestion 快照未到）。 */
  isWaitingForRequest: boolean;
  isInteractive: boolean;
  /** 结算仍处于暂存态（同一批还有提问未作答、agent loop 未续上），可撤销重答。 */
  isRevertable: boolean;
};

export const parseUserQuestionArgs = (
  argumentsJson: string,
): ParsedQuestionArgs | null => {
  try {
    const parsed: unknown = JSON.parse(argumentsJson);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null;
    }

    const record = parsed as Record<string, unknown>;
    if (typeof record.question !== "string" || !Array.isArray(record.options)) {
      return null;
    }

    const options = record.options.filter(
      (option): option is string =>
        typeof option === "string" && Boolean(option.trim()),
    );
    return {
      question: record.question.trim(),
      options,
    };
  } catch {
    return null;
  }
};

export const parseUserQuestionResult = (
  resultJson: string | undefined,
): ParsedQuestionResult | null => {
  if (!resultJson) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(resultJson);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null;
    }

    const record = parsed as Record<string, unknown>;
    if (record.answered !== true && record.cancelled !== true) {
      return null;
    }

    const readAnswers = (value: unknown): string[] =>
      Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [];
    return {
      cancelled: record.cancelled === true,
      selectedOptions: readAnswers(record.selectedOptions),
      customAnswers: readAnswers(record.customAnswers),
    };
  } catch {
    return null;
  }
};

/**
 * 提问展示态判定：卡片与 Tab 组共用（两处各自判定会出现状态漂移）。
 *
 * 终态判定约定（与 useUserQuestion 的结算收口一致）：工具已结束但没有走
 * answered/cancelled 协议结算时按"已中断"处理，卡片必须显示终态并禁用表单，
 * 否则会停在"等待回答"且点击无反馈（提问卡片泄漏）。
 */
export const resolveUserQuestionView = (
  toolCall: ToolCallInfo,
): UserQuestionView => {
  const questionState = toolCall.userQuestion;
  const parsedArgs = parseUserQuestionArgs(toolCall.arguments);
  const parsedResult = parseUserQuestionResult(toolCall.result);
  const isCancelled =
    questionState?.status === "cancelled" || parsedResult?.cancelled === true;
  const isAnswered =
    questionState?.status === "answered" ||
    Boolean(parsedResult && !parsedResult.cancelled);
  const isSettled = isAnswered || isCancelled;
  const isInterrupted =
    questionState?.interrupted === true ||
    (!isSettled && toolCall.status === "completed");
  const isWaitingForRequest = toolCall.status === "running" && !questionState;

  const status: UserQuestionStatus = isInterrupted
    ? "interrupted"
    : isCancelled
      ? "cancelled"
      : isAnswered
        ? "answered"
        : toolCall.status === "error"
          ? "error"
          : "waiting";

  return {
    question: questionState?.question ?? parsedArgs?.question ?? "",
    options: questionState?.options ?? parsedArgs?.options ?? [],
    questionId: questionState?.questionId,
    questionState,
    parsedResult,
    status,
    isWaitingForRequest,
    isInteractive: Boolean(
      questionState &&
      !isSettled &&
      !isInterrupted &&
      (toolCall.status === "running" || toolCall.status === "pending"),
    ),
    // 撤销入口只在结算尚未回传给 agent loop 时出现：工具已结束（终态 / 结果
    // 已到）说明 loop 已续上，此时撤销已无意义（运行时也会忽略）。
    isRevertable: Boolean(
      questionState?.revertable === true &&
      !isInterrupted &&
      !parsedResult &&
      (toolCall.status === "running" || toolCall.status === "pending"),
    ),
  };
};
