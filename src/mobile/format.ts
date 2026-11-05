import type {
  SnowRemoteChatInputState,
  SnowRemoteState,
  SnowRemoteTokenUsage,
} from "../renderer/types/remoteControl";
import { localeBcp47, t } from "./i18n";

/** 会话列表中「最近更新时间」的相对时间描述。 */
export const relativeTime = (value: string): string => {
  const time = Date.parse(value);
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return t("remote.time.justNow");
  if (seconds < 3600)
    return t("remote.time.minutes", { count: Math.floor(seconds / 60) });
  if (seconds < 86400)
    return t("remote.time.hours", { count: Math.floor(seconds / 3600) });
  if (seconds < 604800)
    return t("remote.time.days", { count: Math.floor(seconds / 86400) });
  return new Date(time).toLocaleDateString(localeBcp47(), {
    month: "numeric",
    day: "numeric",
  });
};

/** 消息时间：已是 "H:MM"/"HH:MM(:SS)" 形态时直接截断展示，否则按时间戳格式化。 */
export const messageTime = (value: string | null | undefined): string => {
  if (!value) return "";
  const text = String(value).trim();
  if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(text)) return text.slice(0, 5);
  const time = Date.parse(text);
  return Number.isFinite(time)
    ? new Date(time).toLocaleTimeString(localeBcp47(), {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";
};

export const formatTokenAmount = (n: number): string =>
  n >= 1000000
    ? (n / 1000000).toFixed(1) + "M"
    : n >= 1000
      ? (n / 1000).toFixed(1) + "K"
      : String(n);

/** 会话生效的思考强度展示文案：优先取选项 label，回退原始值；无数据时占位。 */
export const effectiveThinkingLabel = (
  input: SnowRemoteChatInputState | null | undefined,
): string => {
  const value = input?.effectiveThinkingValue || "";
  if (!value) return t("remote.chips.empty");
  return (
    input?.thinkingOptions.find((option) => option.value === value)?.label ||
    value
  );
};

/**
 * 输入区上下文 chip：上下文占用百分比 + 用量 / 上限。
 * 口径与桌面端 TokenUsageRing 一致：total = input + output，以 maxContextTokens 为分母。
 */
export const contextLabel = (
  usage: SnowRemoteTokenUsage | null | undefined,
  limit: number | null | undefined,
): string => {
  if (!usage) {
    return t("remote.chips.context", { value: t("remote.chips.empty") });
  }
  const total = (usage.inputTokens || 0) + (usage.outputTokens || 0);
  const parts: string[] = [];
  if (typeof limit === "number" && limit > 0) {
    parts.push(Math.round(Math.min(total / limit, 1) * 100) + "%");
    parts.push(formatTokenAmount(total) + " / " + formatTokenAmount(limit));
  } else {
    parts.push(formatTokenAmount(total));
  }
  return t("remote.chips.context", { value: parts.join(" · ") });
};

/** 字节数的紧凑展示（GB / MB / KB / B，保留一位小数）。 */
export const formatBytes = (size: number): string =>
  size > 1073741824
    ? (size / 1073741824).toFixed(1) + " GB"
    : size > 1048576
      ? (size / 1048576).toFixed(1) + " MB"
      : size > 1024
        ? (size / 1024).toFixed(1) + " KB"
        : size + " B";

/** 判断两次快照是否是同一「会话上下文」（工作区 + 会话），用于附件失效。 */
export const sessionContextKey = (next: SnowRemoteState | null): string =>
  (next?.workspace ? next.workspace.directoryId : "") +
  "|" +
  (next?.activeConversationId || "");
