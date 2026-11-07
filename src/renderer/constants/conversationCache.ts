export const CONVERSATION_CACHE_TTL_SETTING = "conversation_cache_ttl_minutes";

export const CONVERSATION_CACHE_TTL_SETTING_NAME = "会话缓存";

export const CONVERSATION_CACHE_TTL_DEFAULT_MINUTES = 3;

export const CONVERSATION_CACHE_TTL_MIN_MINUTES = 1;

export const CONVERSATION_CACHE_TTL_MAX_MINUTES = 10080;

export const CONVERSATION_CACHE_TTL_CHANGED_EVENT =
  "snow:conversation-cache-ttl-changed";

export const normalizeConversationCacheTtlMinutes = (
  raw: string | null,
): number => {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed)) {
    return CONVERSATION_CACHE_TTL_DEFAULT_MINUTES;
  }
  return Math.min(
    CONVERSATION_CACHE_TTL_MAX_MINUTES,
    Math.max(CONVERSATION_CACHE_TTL_MIN_MINUTES, parsed),
  );
};
