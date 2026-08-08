export type NotificationConversationTarget = {
  kind: "conversation";
  conversationId: string;
  directoryId: string;
};

export type AppNotificationOptions = {
  title: string;
  body: string;
  silent?: boolean;
  target?: NotificationConversationTarget;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

export const isNotificationConversationTarget = (
  value: unknown
): value is NotificationConversationTarget =>
  isRecord(value) &&
  value.kind === "conversation" &&
  isNonEmptyString(value.conversationId) &&
  isNonEmptyString(value.directoryId);

export const isAppNotificationOptions = (
  value: unknown
): value is AppNotificationOptions =>
  isRecord(value) &&
  typeof value.title === "string" &&
  typeof value.body === "string" &&
  (value.silent === undefined || typeof value.silent === "boolean") &&
  (value.target === undefined ||
    isNotificationConversationTarget(value.target));
