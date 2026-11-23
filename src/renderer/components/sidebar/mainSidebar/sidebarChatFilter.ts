import { useCallback, useSyncExternalStore } from "react";

/** 会话列表过滤：true 表示只显示运行中与置顶会话，历史会话收进「加载更多会话」。 */
const STORAGE_KEY = "sidebar-only-running-pinned-chats";

const readStoredValue = (): boolean => {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
};

let currentValue: boolean = readStoredValue();
const listeners = new Set<() => void>();

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const getSnapshot = (): boolean => currentValue;

export const setSidebarOnlyRunningPinnedChats = (value: boolean): void => {
  if (currentValue === value) {
    return;
  }
  currentValue = value;
  try {
    localStorage.setItem(STORAGE_KEY, value ? "1" : "0");
  } catch {}
  for (const listener of listeners) {
    listener();
  }
};

export function useSidebarOnlyRunningPinnedChats(): {
  onlyRunningPinned: boolean;
  toggleOnlyRunningPinned: () => void;
} {
  const onlyRunningPinned = useSyncExternalStore(subscribe, getSnapshot);
  const toggleOnlyRunningPinned = useCallback((): void => {
    setSidebarOnlyRunningPinnedChats(!getSnapshot());
  }, []);
  return { onlyRunningPinned, toggleOnlyRunningPinned };
}
