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
  /** 忽略窗口聚焦抑制，用于用户显式开启的通知 */
  ignoreFocus?: boolean;
};

/** 内置提示音（除系统默认 / 自定义 / 静音之外的固定音效） */
export type BuiltinNotificationSound = "chime" | "bell" | "pop" | "wood";

/**
 * 通知提示音：
 * - system：使用系统通知自带音效（默认，行为与旧版本一致）
 * - custom：播放用户选择的 MP3，文件路径见 NotificationSettings.customSoundPath
 * - none：静音
 */
export type NotificationSoundPreset =
  "system" | BuiltinNotificationSound | "custom" | "none";

const BUILTIN_NOTIFICATION_SOUNDS: BuiltinNotificationSound[] = [
  "chime",
  "bell",
  "pop",
  "wood",
];

export const NOTIFICATION_SOUND_PRESETS: NotificationSoundPreset[] = [
  "system",
  ...BUILTIN_NOTIFICATION_SOUNDS,
  "custom",
  "none",
];

/** 系统通知设置（存于系统设置 notification_settings） */
export type NotificationSettings = {
  /** 窗口聚焦时是否仍然弹出系统通知（默认关闭：聚焦时不打扰） */
  notifyWhenFocused: boolean;
  sound: NotificationSoundPreset;
  /** 自定义提示音文件绝对路径，仅 sound 为 custom 时生效 */
  customSoundPath: string;
};

export const NOTIFICATION_SETTINGS_NAME = "系统通知";
export const NOTIFICATION_SETTINGS_CODE = "notification_settings";

const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  notifyWhenFocused: false,
  sound: "system",
  customSoundPath: "",
};

/** 主进程解析出的、需要在渲染进程播放的提示音 */
export type AppNotificationSound =
  | { kind: "preset"; preset: BuiltinNotificationSound }
  | { kind: "custom"; path: string };

export type AppNotificationResult = {
  /** 是否真的触发了通知（窗口聚焦被抑制时为 false） */
  shown: boolean;
  /** 需要播放的应用内提示音；系统默认音效 / 静音时为 null */
  sound: AppNotificationSound | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

export const isNotificationConversationTarget = (
  value: unknown,
): value is NotificationConversationTarget =>
  isRecord(value) &&
  value.kind === "conversation" &&
  isNonEmptyString(value.conversationId) &&
  isNonEmptyString(value.directoryId);

export const isAppNotificationOptions = (
  value: unknown,
): value is AppNotificationOptions =>
  isRecord(value) &&
  typeof value.title === "string" &&
  typeof value.body === "string" &&
  (value.silent === undefined || typeof value.silent === "boolean") &&
  (value.ignoreFocus === undefined || typeof value.ignoreFocus === "boolean") &&
  (value.target === undefined ||
    isNotificationConversationTarget(value.target));

export const normalizeNotificationSound = (
  value: unknown,
): NotificationSoundPreset =>
  typeof value === "string" &&
  (NOTIFICATION_SOUND_PRESETS as string[]).includes(value)
    ? (value as NotificationSoundPreset)
    : DEFAULT_NOTIFICATION_SETTINGS.sound;

/** 规范化任意来源的通知设置（缺失/非法字段回退默认值）。 */
const normalizeNotificationSettings = (
  value: unknown,
): NotificationSettings => {
  const source = isRecord(value) ? value : {};
  return {
    notifyWhenFocused:
      typeof source.notifyWhenFocused === "boolean"
        ? source.notifyWhenFocused
        : DEFAULT_NOTIFICATION_SETTINGS.notifyWhenFocused,
    sound: normalizeNotificationSound(source.sound),
    customSoundPath:
      typeof source.customSoundPath === "string"
        ? source.customSoundPath.trim()
        : DEFAULT_NOTIFICATION_SETTINGS.customSoundPath,
  };
};

/** 解析系统设置里存的 JSON 字符串（空值/损坏时回退默认值）。 */
export const parseNotificationSettings = (
  raw: string | null,
): NotificationSettings => {
  if (!raw) {
    return { ...DEFAULT_NOTIFICATION_SETTINGS };
  }
  try {
    return normalizeNotificationSettings(JSON.parse(raw) as unknown);
  } catch {
    return { ...DEFAULT_NOTIFICATION_SETTINGS };
  }
};
