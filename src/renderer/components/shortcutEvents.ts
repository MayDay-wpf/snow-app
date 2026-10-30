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
  | "open-todo"
  | "cycle-project"
  | "open-project-explorer"
  | "toggle-project-memory"
  | "toggle-scheduled-tasks"
  | "toggle-plugins"
  | "open-api-profile-menu"
  | "focus-chat-input"
  | "toggle-sidebar"
  | "toggle-right-panel"
  | "new-chat"
  | "new-chat-in-new-window"
  | "send-message"
  | "send-message-now"
  | "stop-generation"
  | "toggle-pet"
  | "prev-conversation"
  | "next-conversation"
  | "scroll-to-top"
  | "scroll-to-bottom"
  | "copy-last-response"
  | "open-settings"
  | "toggle-right-panel-fullscreen"
  | "show-shortcut-help"
  | "toggle-message-time"
  | "ui-zoom-in"
  | "ui-zoom-out"
  | "ui-zoom-reset";

type ListenerMap = {
  "toggle-search": Set<() => void>;
  "toggle-memo": Set<() => void>;
  "toggle-todo": Set<() => void>;
  "open-todo": Set<() => void>;
  "cycle-project": Set<() => void>;
  "open-project-explorer": Set<() => void>;
  "toggle-project-memory": Set<() => void>;
  "toggle-scheduled-tasks": Set<() => void>;
  "toggle-plugins": Set<() => void>;
  "open-api-profile-menu": Set<() => void>;
  "focus-chat-input": Set<() => void>;
  "toggle-sidebar": Set<() => void>;
  "toggle-right-panel": Set<() => void>;
  "new-chat": Set<() => void>;
  "new-chat-in-new-window": Set<() => void>;
  "send-message": Set<() => void>;
  "send-message-now": Set<() => void>;
  "stop-generation": Set<() => void>;
  "toggle-pet": Set<() => void>;
  "prev-conversation": Set<() => void>;
  "next-conversation": Set<() => void>;
  "scroll-to-top": Set<() => void>;
  "scroll-to-bottom": Set<() => void>;
  "copy-last-response": Set<() => void>;
  "open-settings": Set<() => void>;
  "toggle-right-panel-fullscreen": Set<() => void>;
  "show-shortcut-help": Set<() => void>;
  "toggle-message-time": Set<() => void>;
  "ui-zoom-in": Set<() => void>;
  "ui-zoom-out": Set<() => void>;
  "ui-zoom-reset": Set<() => void>;
};

const listeners: ListenerMap = {
  "toggle-search": new Set(),
  "toggle-memo": new Set(),
  "toggle-todo": new Set(),
  "open-todo": new Set(),
  "cycle-project": new Set(),
  "open-project-explorer": new Set(),
  "toggle-project-memory": new Set(),
  "toggle-scheduled-tasks": new Set(),
  "toggle-plugins": new Set(),
  "open-api-profile-menu": new Set(),
  "focus-chat-input": new Set(),
  "toggle-sidebar": new Set(),
  "toggle-right-panel": new Set(),
  "new-chat": new Set(),
  "new-chat-in-new-window": new Set(),
  "send-message": new Set(),
  "send-message-now": new Set(),
  "stop-generation": new Set(),
  "toggle-pet": new Set(),
  "prev-conversation": new Set(),
  "next-conversation": new Set(),
  "scroll-to-top": new Set(),
  "scroll-to-bottom": new Set(),
  "copy-last-response": new Set(),
  "open-settings": new Set(),
  "toggle-right-panel-fullscreen": new Set(),
  "show-shortcut-help": new Set(),
  "toggle-message-time": new Set(),
  "ui-zoom-in": new Set(),
  "ui-zoom-out": new Set(),
  "ui-zoom-reset": new Set(),
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
