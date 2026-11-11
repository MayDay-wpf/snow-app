/**
 * 前端内部工具错误码的展示层本地化。
 *
 * 工具结果 JSON 里的 `error` / `message` 属于协议与审计字段：它们会写入会话
 * 历史并回传给模型，因此必须保持英文原文不变。本模块只把已知错误码翻译成
 * 用户可读的本地化说明，供工具卡片展示，不改动任何持久化数据。
 */

type ToolErrorTranslate = (
  key: string,
  options?: { defaultValue?: string; values?: Record<string, string | number> },
) => string;

/** 已知内部工具错误码 → 本地化文案 key。 */
export const TOOL_ERROR_CODE_MESSAGE_KEYS: Record<string, string> = {
  "Invalid JSON arguments": "toolCall.subAgentMessage.error.invalidArgs",
  "conversationId and message are required":
    "toolCall.subAgentMessage.error.missingArgs",
  "Cannot send a message to yourself": "toolCall.subAgentMessage.error.self",
  "Target sub-agent does not exist or belongs to another conversation (session isolation: teammates must be in the same session)":
    "toolCall.subAgentMessage.error.isolation",
  "Target sub-agent is no longer running; messages can only be sent to teammates that are still active":
    "toolCall.subAgentMessage.error.notRunning",
};

/** 已有专门 UI 承载的错误码（如拒绝理由提示条）：卡片内不再重复展示。 */
const SILENT_ERROR_CODES = new Set(["TOOL_EXECUTION_DENIED"]);

/**
 * 把工具错误码/错误消息转换为本地化展示文案。
 * 未收录的错误码原样返回，保证任意错误信息都不会丢失。
 */
export const localizeToolError = (
  t: ToolErrorTranslate,
  message: string | null | undefined,
): string => {
  const raw = message?.trim();
  if (!raw) {
    return "";
  }

  if (SILENT_ERROR_CODES.has(raw)) {
    return "";
  }

  const key = TOOL_ERROR_CODE_MESSAGE_KEYS[raw];
  if (key) {
    return t(key, { defaultValue: raw });
  }

  return message ?? "";
};
