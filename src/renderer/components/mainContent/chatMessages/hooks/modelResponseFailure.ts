import { tGlobal } from "../../../../i18n/translate";
import type {
  ChatConversationMessage,
  ConversationContextValue,
} from "../utils/conversationTypes";

export const modelFailureReason = (reason?: string | null): string =>
  reason?.trim() || tGlobal("chat.error.missingReason");

type FailedModelResponse = {
  content?: string | null;
  thinking?: string | null;
  failureReason?: string | null;
  id?: string | null;
  model?: string | null;
};

/** Keep generated text separate from safe provider diagnostics. */
export const failedModelMessage = (
  current: ChatConversationMessage,
  response: FailedModelResponse,
): ChatConversationMessage => ({
  ...current,
  content: response.content || current.content || "",
  thinking: response.thinking || current.thinking || undefined,
  failureReason: response.failureReason?.trim() || undefined,
  status: "error",
  responseId: response.id || current.responseId,
  model: response.model || current.model,
  htmlPreviewEligible: false,
  toolCalls: undefined,
  isThinkingActive: false,
  isRetrying: false,
  retryAttempt: undefined,
  retryError: undefined,
});

const isApiResponseCancelled = (status?: string | null): boolean =>
  status === "cancelled" || status === "canceled";

/** Execution cancellation is independent of the display disposition. */
export const settleApiCancellation = (
  ctx: ConversationContextValue,
  sessionKey: string,
  messageId: string,
  response: FailedModelResponse & { status?: string | null },
): boolean => {
  if (!isApiResponseCancelled(response.status)) return false;
  const ref = ctx.sessionsRefData.current.get(sessionKey);
  // Explicit immediate-send cancellation keeps its existing soft boundary.
  if (ref?.isAbortRequested && ref.forceSendAbort) return false;
  if (ref) ref.isAbortRequested = true;
  ctx.updateSessionMessages(sessionKey, (messages) =>
    messages.map((message) =>
      message.id === messageId
        ? {
            ...failedModelMessage(message, response),
            status: "sent",
            failureReason: undefined,
          }
        : message,
    ),
  );
  return true;
};
