import { useCallback, useSyncExternalStore } from "react";

export const REPLY_PREDICTION_STORAGE_KEY = "snow.chat.replyPrediction";

const listeners = new Set<() => void>();

const read = (): boolean => {
  try {
    return window.localStorage.getItem(REPLY_PREDICTION_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
};

let current = typeof window === "undefined" ? false : read();

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const getSnapshot = (): boolean => current;

/** 非组件场景同步读取开关。 */
export const isReplyPredictionEnabled = getSnapshot;

/** 回复预测开关（默认关闭），模块级共享，多处订阅即时同步。 */
export const useReplyPredictionPreference = (): {
  replyPredictionEnabled: boolean;
  setReplyPredictionEnabled: (enabled: boolean) => void;
} => {
  const replyPredictionEnabled = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getSnapshot,
  );
  const setReplyPredictionEnabled = useCallback((enabled: boolean) => {
    current = enabled;
    try {
      window.localStorage.setItem(
        REPLY_PREDICTION_STORAGE_KEY,
        enabled ? "true" : "false",
      );
    } catch {
      // 存储不可用时仅本次会话生效
    }
    listeners.forEach((listener) => listener());
  }, []);
  return { replyPredictionEnabled, setReplyPredictionEnabled };
};
