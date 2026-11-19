import { useSyncExternalStore } from "react";

/** ESC 中断二次确认窗口（毫秒），超时自动收回提示。 */
export const ESCAPE_ABORT_CONFIRM_MS = 2000;

let armedKey: string | null = null;
let timer: number | null = null;
const listeners = new Set<() => void>();

const setArmed = (key: string | null): void => {
  if (timer !== null) {
    window.clearTimeout(timer);
    timer = null;
  }
  armedKey = key;
  if (key !== null) {
    timer = window.setTimeout(() => setArmed(null), ESCAPE_ABORT_CONFIRM_MS);
  }
  for (const listener of listeners) {
    listener();
  }
};

/**
 * 快捷键中断入口：运行中首次按下只提示，窗口期内同一会话再次按下才中断；
 * 未在运行时直接执行（保留子代理父任务停止等原有语义）。
 */
export const requestEscapeAbort = ({
  sessionKey,
  isStreaming,
  abort,
}: {
  sessionKey: string;
  isStreaming: boolean;
  abort: () => void;
}): void => {
  if (!isStreaming) {
    abort();
    return;
  }
  if (armedKey === sessionKey) {
    setArmed(null);
    abort();
    return;
  }
  setArmed(sessionKey);
};

export const disarmEscapeAbort = (sessionKey: string): void => {
  if (armedKey === sessionKey) {
    setArmed(null);
  }
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const useEscapeAbortArmed = (sessionKey: string): boolean =>
  useSyncExternalStore(subscribe, () => armedKey === sessionKey);
