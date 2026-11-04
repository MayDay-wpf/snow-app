import type { Locale } from "../../../shared/locale";

export const responseFailureTranslations: Record<
  Locale,
  Record<string, string>
> = {
  en: {
    "chat.error.missingReason":
      "Response failed; no specific reason was retained",
    "chat.subAgentRetry.retry": "Retry",
    "toolCall.subAgent.retry": "Retry",
  },
  "zh-CN": {
    "chat.error.missingReason": "响应失败，未保留具体原因",
    "chat.subAgentRetry.retry": "重试",
    "toolCall.subAgent.retry": "重试",
  },
  "zh-TW": {
    "chat.error.missingReason": "回應失敗，未保留具體原因",
    "chat.subAgentRetry.retry": "重試",
    "toolCall.subAgent.retry": "重試",
  },
};
