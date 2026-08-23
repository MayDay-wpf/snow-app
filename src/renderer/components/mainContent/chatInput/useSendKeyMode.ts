import { useCallback, useEffect, useState } from "react";

/** 发送消息的快捷键模式：Enter 发送 / Ctrl+Enter 发送。 */
export type SendKeyMode = "enter" | "ctrlEnter";

/** localStorage 持久化键名。 */
const SEND_KEY_MODE_STORAGE_KEY = "snow.chat.sendKeyMode";

const readStoredSendKeyMode = (): SendKeyMode => {
  try {
    const stored = window.localStorage.getItem(SEND_KEY_MODE_STORAGE_KEY);
    return stored === "ctrlEnter" ? "ctrlEnter" : "enter";
  } catch {
    return "enter";
  }
};

/**
 * 发送快捷键模式（全局单例，多个 ChatInput 实例共享同一个 localStorage 值）。
 * 首次写入时通过 CustomEvent 广播，保证其他实例同步切换。
 */
const sendKeyModeChangeEvent = "snow:chat-send-key-mode-change";
const sendKeyModeListeners = new Set<(mode: SendKeyMode) => void>();

const emitSendKeyModeChange = (mode: SendKeyMode): void => {
  sendKeyModeListeners.forEach((listener) => listener(mode));
};

export const useSendKeyMode = (): {
  sendKeyMode: SendKeyMode;
  setSendKeyMode: (mode: SendKeyMode) => void;
} => {
  const [sendKeyMode, setMode] = useState<SendKeyMode>(readStoredSendKeyMode);

  const setSendKeyMode = useCallback((mode: SendKeyMode): void => {
    setMode(mode);
    try {
      window.localStorage.setItem(SEND_KEY_MODE_STORAGE_KEY, mode);
    } catch {
      // 隐私模式等存储不可用时仅保留内存态。
    }
    emitSendKeyModeChange(mode);
  }, []);

  // 跨实例同步：任一实例写入后广播给所有挂载的实例。
  useEffect(() => {
    const onChange = (mode: SendKeyMode): void => setMode(mode);
    sendKeyModeListeners.add(onChange);
    return () => {
      sendKeyModeListeners.delete(onChange);
    };
  }, []);

  return { sendKeyMode, setSendKeyMode };
};
