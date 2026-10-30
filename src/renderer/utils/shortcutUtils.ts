import type {
  KeyboardShortcutAction,
  KeyboardShortcutsSettings,
} from "../../preload";

/**
 * 平台判断：macOS 使用 Cmd 键，其他平台使用 Ctrl 键。
 */
export const isMacOS = (): boolean => {
  if (typeof navigator === "undefined") return false;
  const platform =
    (navigator as Navigator & { platform?: string }).platform ?? "";
  const userAgent = navigator.userAgent ?? "";
  return /mac/i.test(platform) || /mac/i.test(userAgent);
};

/**
 * 规范化 key 中的主键名：
 * - 反引号 ` → backtick
 * - Escape → escape
 * - 方向键/Enter/Space → left/right/up/down/enter/space
 * - 其他字母统一小写
 */
const NAMED_KEY_ALIASES: Record<string, string> = {
  arrowleft: "left",
  arrowright: "right",
  arrowup: "up",
  arrowdown: "down",
  return: "enter",
  spacebar: "space",
};

const normalizeKeyName = (rawKey: string): string => {
  if (rawKey === "`") return "backtick";
  const lower = rawKey.toLowerCase();
  return NAMED_KEY_ALIASES[lower] ?? lower;
};

/**
 * 将 KeyboardEvent 转换为平台无关的规范化按键字符串。
 * 返回 null 表示该按键不可用（纯修饰键、或非可绑定按键）。
 *
 * 规则：
 * - 主修饰键统一记为 `mod`（macOS=Cmd，其他=Ctrl）
 * - Alt 修饰键记为 `alt`（如 `alt+p`）
 * - macOS 的 Ctrl 修饰键记为 `ctrl`（如 `ctrl+p`）
 * - Shift 修饰键记为 `shift`（如 `mod+shift+p`）
 * - 单键（如 Escape）无修饰键
 * - 仅支持 mod/ctrl/alt/shift 四类修饰组合
 *
 * 例如 Ctrl+F → "mod+f"，Alt+P → "alt+p"，macOS Ctrl+P → "ctrl+p"，
 * Cmd+Shift+P → "mod+shift+p"，Escape → "escape"
 */
export const eventToKey = (event: KeyboardEvent): string | null => {
  const isMac = isMacOS();
  const mod = isMac ? event.metaKey : event.ctrlKey;
  // 纯修饰键按下不可绑定
  if (
    event.key === "Control" ||
    event.key === "Meta" ||
    event.key === "Shift" ||
    event.key === "Alt"
  ) {
    return null;
  }

  const main = normalizeKeyName(event.key);

  // Escape 等特殊键不要求修饰键
  if (main === "escape") {
    return "escape";
  }

  // 其余按键必须有 mod、ctrl 或 alt 修饰，避免与普通输入冲突
  const modifiers: string[] = [];
  if (mod) {
    modifiers.push("mod");
  }
  // macOS 上 Ctrl 与 Cmd 是独立修饰键，单独记录
  if (isMac && event.ctrlKey) {
    modifiers.push("ctrl");
  }
  if (event.altKey) {
    modifiers.push("alt");
  }
  if (event.shiftKey) {
    modifiers.push("shift");
  }

  if (modifiers.length === 0) {
    return null;
  }
  return [...modifiers, main].join("+");
};

/**
 * 将规范化 key 转换为当前平台的显示文本。
 * `mod` 在 macOS 显示为 ⌘ Cmd，其他平台显示为 Ctrl。
 *
 * 例如 "mod+f" → "Ctrl + F"（Windows）/ "⌘ + F"（macOS）
 *      "escape" → "ESC"
 */
export const keyToDisplay = (key: string): string => {
  const isMac = isMacOS();
  const modLabel = isMac ? "⌘" : "Ctrl";
  const parts = key.split("+");
  const segments: string[] = [];

  for (const part of parts) {
    if (part === "mod") {
      segments.push(modLabel);
    } else if (part === "alt") {
      segments.push(isMac ? "⌥ Option" : "Alt");
    } else if (part === "ctrl") {
      segments.push(isMac ? "⌃" : "Ctrl");
    } else if (part === "shift") {
      segments.push("Shift");
    } else if (part === "backtick") {
      segments.push("`");
    } else if (part === "escape") {
      segments.push("ESC");
    } else if (part === "enter") {
      segments.push("Enter");
    } else if (part === "left") {
      segments.push("←");
    } else if (part === "right") {
      segments.push("→");
    } else if (part === "up") {
      segments.push("↑");
    } else if (part === "down") {
      segments.push("↓");
    } else if (part === "home") {
      segments.push("Home");
    } else if (part === "end") {
      segments.push("End");
    } else if (part === "tab") {
      segments.push("Tab");
    } else if (part === "space") {
      segments.push("Space");
    } else if (part.length === 1) {
      segments.push(part.toUpperCase());
    } else {
      segments.push(part);
    }
  }

  return segments.join(" + ");
};

/**
 * 检测当前是否有 Modal 打开。
 *
 * Modal 打开时 document.body.style.overflow 会被设为 "hidden"
 * （见 Modal.tsx 的 useEffect）。以此作为判断依据，避免 ESC
 * 快捷键与 Modal 的 ESC 关闭逻辑冲突。
 */
const isModalOpen = (): boolean => {
  return document.body.style.overflow === "hidden";
};

/**
 * 判断 KeyboardEvent 是否匹配给定的规范化 key。
 *
 * macOS 上 mod 对应 metaKey，其他平台对应 ctrlKey；`alt` 对应 altKey，
 * `ctrl` 对应 ctrlKey（主要用于 macOS 上的 Ctrl+P），`shift` 对应 shiftKey。
 * 非 macOS 平台上 mod 与 ctrl 是同一修饰键（都是 Ctrl），`mod+f` 与
 * `ctrl+f` 等价，合并校验；macOS 上两者独立，分别精确匹配。
 * ESC 仅在无 Modal 打开时触发，避免与 Modal ESC 关闭冲突。
 */
export const matchKey = (event: KeyboardEvent, key: string): boolean => {
  const isMac = isMacOS();
  const mod = isMac ? event.metaKey : event.ctrlKey;
  const parts = key.split("+");
  const hasMod = parts.includes("mod");
  const hasAlt = parts.includes("alt");
  const hasCtrl = parts.includes("ctrl");
  const hasShift = parts.includes("shift");
  const mainPart = parts.find(
    (p) => p !== "mod" && p !== "alt" && p !== "ctrl" && p !== "shift",
  );

  if (mainPart === undefined) return false;

  // 修饰键状态必须精确匹配
  if (isMac) {
    // macOS：Cmd 与 Ctrl 是两个独立修饰键，分别校验
    if (hasMod !== event.metaKey) return false;
    if (hasCtrl !== event.ctrlKey) return false;
  } else if ((hasMod || hasCtrl) !== event.ctrlKey) {
    // 其他平台：mod 即 Ctrl，两者等价，合并校验
    return false;
  }
  if (hasAlt !== event.altKey) return false;
  if (hasShift !== event.shiftKey) return false;

  const main = normalizeKeyName(event.key);

  if (mainPart === "escape") {
    if (main !== "escape") return false;
    if (isModalOpen()) return false;
    return true;
  }

  if (main !== mainPart) return false;
  return true;
};

/**
 * 判断按键是否需要 preventDefault，避免浏览器默认行为
 * （如 Ctrl+F 查找、Ctrl+D 书签等）干扰快捷键功能。
 * ESC 无默认行为需阻止。
 */
export const shouldPreventDefault = (key: string): boolean => {
  return key !== "escape";
};

/**
 * 32 个快捷键动作的有序列表。
 * 排列规则：台前生效的快捷键在前（默认 foregroundOnly=true），
 * 全局生效的 toggleWindow（默认 foregroundOnly=false）放最后。
 */
export const SHORTCUT_ACTIONS: KeyboardShortcutAction[] = [
  "cancelSession",
  "sendMessage",
  "sendMessageNow",
  "stopGeneration",
  "newChat",
  "newChatInNewWindow",
  "prevConversation",
  "nextConversation",
  "scrollToTop",
  "scrollToBottom",
  "copyLastResponse",
  "focusInput",
  "openSearch",
  "openMemo",
  "openTodo",
  "cycleProject",
  "openProjectExplorer",
  "openProjectMemory",
  "openScheduledTasks",
  "openPlugins",
  "cycleApiProfile",
  "openSettings",
  "toggleSidebar",
  "toggleRightPanel",
  "toggleRightPanelFullscreen",
  "togglePet",
  "cycleDetachedWindow",
  "toggleWindow",
  "showShortcutHelp",
  "toggleMessageTime",
  "uiZoomIn",
  "uiZoomOut",
  "uiZoomReset",
  "browserToggleShareWithAgent",
  "browserPickElement",
];

/**
 * 快捷键动作的静态元数据：描述文案 key + 描述默认值 + 帮助浮层分组。
 * group: conversation（会话操作）/ navigation（界面导航）/
 * browser（浏览器面板）/ window（窗口与全局）。
 */
type ShortcutMeta = {
  descKey: string;
  descDefault: string;
  group: "conversation" | "navigation" | "browser" | "window";
};

export const SHORTCUT_META: Record<KeyboardShortcutAction, ShortcutMeta> = {
  cancelSession: {
    descKey: "settings.shortcutCancelSession",
    descDefault: "Interrupt current session",
    group: "conversation",
  },
  sendMessage: {
    descKey: "settings.shortcutSendMessage",
    descDefault: "Send current input",
    group: "conversation",
  },
  sendMessageNow: {
    descKey: "settings.shortcutSendMessageNow",
    descDefault: "Send input or first pending message immediately",
    group: "conversation",
  },
  stopGeneration: {
    descKey: "settings.shortcutStopGeneration",
    descDefault: "Stop generating",
    group: "conversation",
  },
  newChat: {
    descKey: "settings.shortcutNewChat",
    descDefault: "Start a new conversation",
    group: "conversation",
  },
  newChatInNewWindow: {
    descKey: "settings.shortcutNewChatInNewWindow",
    descDefault: "Start a new conversation in a new window",
    group: "conversation",
  },
  prevConversation: {
    descKey: "settings.shortcutPrevConversation",
    descDefault: "Switch to previous conversation",
    group: "conversation",
  },
  nextConversation: {
    descKey: "settings.shortcutNextConversation",
    descDefault: "Switch to next conversation",
    group: "conversation",
  },
  scrollToTop: {
    descKey: "settings.shortcutScrollToTop",
    descDefault: "Scroll chat to top",
    group: "conversation",
  },
  scrollToBottom: {
    descKey: "settings.shortcutScrollToBottom",
    descDefault: "Scroll chat to bottom",
    group: "conversation",
  },
  copyLastResponse: {
    descKey: "settings.shortcutCopyLastResponse",
    descDefault: "Copy last AI response",
    group: "conversation",
  },
  focusInput: {
    descKey: "settings.shortcutFocusInput",
    descDefault: "Focus chat input",
    group: "conversation",
  },
  openSearch: {
    descKey: "settings.shortcutOpenSearch",
    descDefault: "Open global search",
    group: "navigation",
  },
  openMemo: {
    descKey: "settings.shortcutOpenMemo",
    descDefault: "Open memos",
    group: "navigation",
  },
  openTodo: {
    descKey: "settings.shortcutOpenTodo",
    descDefault: "Open todo list",
    group: "navigation",
  },
  cycleProject: {
    descKey: "settings.shortcutCycleProject",
    descDefault: "Cycle through projects",
    group: "navigation",
  },
  openProjectExplorer: {
    descKey: "settings.shortcutOpenExplorer",
    descDefault: "Toggle current project explorer",
    group: "navigation",
  },
  openProjectMemory: {
    descKey: "settings.shortcutOpenProjectMemory",
    descDefault: "Open project memory",
    group: "navigation",
  },
  openScheduledTasks: {
    descKey: "settings.shortcutOpenScheduledTasks",
    descDefault: "Open scheduled tasks",
    group: "navigation",
  },
  openPlugins: {
    descKey: "settings.shortcutOpenPlugins",
    descDefault: "Open plugins",
    group: "navigation",
  },
  cycleApiProfile: {
    descKey: "settings.shortcutCycleApiProfile",
    descDefault: "Open API provider picker",
    group: "navigation",
  },
  openSettings: {
    descKey: "settings.shortcutOpenSettings",
    descDefault: "Open settings",
    group: "navigation",
  },
  toggleSidebar: {
    descKey: "settings.shortcutToggleSidebar",
    descDefault: "Collapse/expand left sidebar",
    group: "navigation",
  },
  toggleRightPanel: {
    descKey: "settings.shortcutToggleRightPanel",
    descDefault: "Collapse/expand right panel",
    group: "navigation",
  },
  toggleRightPanelFullscreen: {
    descKey: "settings.shortcutToggleRightPanelFullscreen",
    descDefault: "Toggle right panel fullscreen",
    group: "navigation",
  },
  togglePet: {
    descKey: "settings.shortcutTogglePet",
    descDefault: "Show/hide desktop pet",
    group: "window",
  },
  cycleDetachedWindow: {
    descKey: "settings.shortcutCycleDetachedWindow",
    descDefault: "Cycle through independent session windows",
    group: "window",
  },
  toggleWindow: {
    descKey: "settings.shortcutToggleWindow",
    descDefault: "Show/hide main window",
    group: "window",
  },
  showShortcutHelp: {
    descKey: "settings.shortcutShowShortcutHelp",
    descDefault: "Show shortcut cheat sheet",
    group: "window",
  },
  toggleMessageTime: {
    descKey: "settings.shortcutToggleMessageTime",
    descDefault: "Show/hide message timestamps",
    group: "conversation",
  },
  uiZoomIn: {
    descKey: "settings.shortcutUiZoomIn",
    descDefault: "Increase UI font size",
    group: "window",
  },
  uiZoomOut: {
    descKey: "settings.shortcutUiZoomOut",
    descDefault: "Decrease UI font size",
    group: "window",
  },
  uiZoomReset: {
    descKey: "settings.shortcutUiZoomReset",
    descDefault: "Reset UI font size",
    group: "window",
  },
  browserToggleShareWithAgent: {
    descKey: "settings.shortcutBrowserToggleShareWithAgent",
    descDefault: "Share current browser tab with the agent",
    group: "browser",
  },
  browserPickElement: {
    descKey: "settings.shortcutBrowserPickElement",
    descDefault: "Pick an element on the browser page",
    group: "browser",
  },
};

/**
 * 帮助浮层分组顺序。
 */
export const SHORTCUT_GROUP_ORDER = [
  "conversation",
  "navigation",
  "browser",
  "window",
] as const;

export type ShortcutGroup = (typeof SHORTCUT_GROUP_ORDER)[number];

/**
 * 动作能否由主进程 globalShortcut 全局注册：单键（escape 等）
 * 会抢占整个系统的按键，一律不支持；带修饰键的组合键均可。
 */
export const isGlobalCapableKey = (key: string): boolean => {
  if (key === "escape") return false;
  return key.includes("+");
};

/**
 * 冲突检测：在 settings 中查找与 targetKey 相同的其他 action。
 * 返回冲突的 action 列表（不含 excludeAction 自身）。
 */
export const findConflicts = (
  settings: KeyboardShortcutsSettings,
  targetKey: string,
  excludeAction: KeyboardShortcutAction,
): KeyboardShortcutAction[] => {
  const conflicts: KeyboardShortcutAction[] = [];
  for (const action of SHORTCUT_ACTIONS) {
    if (action === excludeAction) continue;
    if (settings[action]?.key === targetKey) {
      conflicts.push(action);
    }
  }
  return conflicts;
};
