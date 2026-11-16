import { useSyncExternalStore } from "react";
import { matchKey } from "./shortcutUtils";

/**
 * 会话记录显示方案：
 * - classic：经典时间线工具卡
 * - chips：紧凑胶囊工具行
 * - minimal：极简，每轮中间过程折叠为「已处理 Xs」
 */
export type ToolCardStyle = "classic" | "chips" | "minimal";

const STYLE_CYCLE: readonly ToolCardStyle[] = ["classic", "chips", "minimal"];

/** 固定快捷键，不进入可配置快捷键面板。 */
export const TOOL_CARD_STYLE_SHORTCUT_KEY = "mod+shift+u";

const STORAGE_KEY = "snow:tool-card-style";
const ROOT_ATTRIBUTE = "data-tool-card-style";

const isToolCardStyle = (value: unknown): value is ToolCardStyle =>
  typeof value === "string" &&
  (STYLE_CYCLE as readonly string[]).includes(value);

const readStoredStyle = (): ToolCardStyle => {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isToolCardStyle(raw) ? raw : "classic";
  } catch {
    return "classic";
  }
};

let currentStyle: ToolCardStyle | null = null;
const listeners = new Set<() => void>();

const applyToolCardStyle = (style: ToolCardStyle): void => {
  document.documentElement.setAttribute(ROOT_ATTRIBUTE, style);
};

export const getToolCardStyle = (): ToolCardStyle => {
  if (currentStyle === null) {
    currentStyle = readStoredStyle();
  }
  return currentStyle;
};

const setToolCardStyle = (style: ToolCardStyle): void => {
  currentStyle = style;
  try {
    window.localStorage.setItem(STORAGE_KEY, style);
  } catch {
    // 存储不可用时仅在本次会话生效
  }
  applyToolCardStyle(style);
  for (const listener of listeners) {
    listener();
  }
};

/** 按 经典 -> 简洁 -> 极简 循环切换。 */
export const cycleToolCardStyle = (): ToolCardStyle => {
  const index = STYLE_CYCLE.indexOf(getToolCardStyle());
  const next = STYLE_CYCLE[(index + 1) % STYLE_CYCLE.length];
  setToolCardStyle(next);
  return next;
};

const subscribeToolCardStyle = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const useToolCardStyle = (): ToolCardStyle =>
  useSyncExternalStore(
    subscribeToolCardStyle,
    getToolCardStyle,
    getToolCardStyle,
  );

/** 首屏同步应用上次选择，避免闪烁。 */
export const initToolCardStyle = (): void => {
  applyToolCardStyle(getToolCardStyle());
};

/** 安装固定快捷键监听（mod+shift+u），返回卸载函数。 */
export const installToolCardStyleShortcut = (): (() => void) => {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat) {
      return;
    }
    if (!matchKey(event, TOOL_CARD_STYLE_SHORTCUT_KEY)) {
      return;
    }
    event.preventDefault();
    cycleToolCardStyle();
  };
  document.addEventListener("keydown", onKeyDown);
  return () => document.removeEventListener("keydown", onKeyDown);
};
