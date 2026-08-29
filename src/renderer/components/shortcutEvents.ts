/**
 * 快捷键动作事件总线。
 *
 * 快捷键引擎 (useKeyboardShortcuts) 统一在 document 上监听 keydown，
 * 但某些动作的目标状态分散在不同组件中（搜索/备忘录 modal 在
 * MainSidebarContent，待办面板在 TopBar，项目切换在 ProjectsSection）。
 *
 * 为避免将所有状态提升到 App 顶层（会破坏现有组件结构），
 * 使用这个轻量发布订阅总线：
 * - App.tsx 中的快捷键 handler 通过 emit() 触发动作
 * - 各目标组件通过 on() 订阅并执行实际 UI 操作
 *
 * 纯渲染进程内存事件，不经过主进程 IPC。
 */

export type ShortcutAction =
  | "toggle-search"
  | "toggle-memo"
  | "toggle-todo"
  | "cycle-project"
  | "open-project-explorer"
  | "open-api-profile-menu"
  | "focus-chat-input";

type ListenerMap = {
  "toggle-search": Set<() => void>;
  "toggle-memo": Set<() => void>;
  "toggle-todo": Set<() => void>;
  "cycle-project": Set<() => void>;
  "open-project-explorer": Set<() => void>;
  "open-api-profile-menu": Set<() => void>;
  "focus-chat-input": Set<() => void>;
};

const listeners: ListenerMap = {
  "toggle-search": new Set(),
  "toggle-memo": new Set(),
  "toggle-todo": new Set(),
  "cycle-project": new Set(),
  "open-project-explorer": new Set(),
  "open-api-profile-menu": new Set(),
  "focus-chat-input": new Set(),
};

export const shortcutEvents = {
  on(action: ShortcutAction, listener: () => void): () => void {
    listeners[action].add(listener);
    return () => {
      listeners[action].delete(listener);
    };
  },

  emit(action: ShortcutAction): void {
    const set = listeners[action];
    for (const listener of set) {
      listener();
    }
  },
};
