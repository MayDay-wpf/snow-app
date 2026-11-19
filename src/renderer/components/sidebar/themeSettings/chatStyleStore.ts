/**
 * 全局聊天风格快照：主题应用 / 面板预览 / 启动缓存三条路径写入，
 * 聊天消息列表通过 useChatStyle 订阅（与 backgroundLayerStore 同构）。
 */
import { useSyncExternalStore } from "react";
import type { ThemeChatStyle } from "./types";

export const DEFAULT_CHAT_STYLE: ThemeChatStyle = {
  imMode: false,
  aiAvatarPath: "",
  userAvatarPath: "",
  characterCard: {
    name: "",
    tagline: "",
    personality: "",
    speakingStyle: "",
    background: "",
    greeting: "",
  },
};

let activeChatStyle: ThemeChatStyle = DEFAULT_CHAT_STYLE;
const listeners = new Set<() => void>();

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const getSnapshot = (): ThemeChatStyle => activeChatStyle;

/** 写入快照；字段未变化时保持旧引用，避免订阅方无谓重渲染。 */
export const setActiveChatStyle = (chatStyle: ThemeChatStyle): void => {
  const current = activeChatStyle;
  if (
    current.imMode === chatStyle.imMode &&
    current.aiAvatarPath === chatStyle.aiAvatarPath &&
    current.userAvatarPath === chatStyle.userAvatarPath &&
    JSON.stringify(current.characterCard) ===
      JSON.stringify(chatStyle.characterCard)
  ) {
    return;
  }
  activeChatStyle = { ...chatStyle };
  listeners.forEach((listener) => {
    listener();
  });
};

export const useChatStyle = (): ThemeChatStyle =>
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
