/**
 * 渲染进程内的事件总线,用于在不相关组件树之间通信。
 *
 * 使用场景: 工具调用组件(FilesystemEditToolCall / FilesystemCreateToolCall)
 * 需要请求右侧面板打开一个 diff 预览 tab,但它们不持有 RightPanel 的 ref。
 * 通过这个轻量发布订阅,工具调用组件发出事件,RightPanel 与 App 订阅即可。
 *
 * 设计原则:
 * - 不经过主进程 IPC,纯渲染进程内存事件,避免阻塞 Node.js 主线程。
 * - 同一事件可有多个订阅者;事件触发时同步遍历调用。
 */

import type { GitFileStatus } from "../../../preload";

export type OpenFileDiffPreviewPayload = {
  /** 用于推断语法高亮语言的文件名,同时作为 tab 标题 */
  fileName: string;
  /** 完整文件路径,用于 tab title tooltip 与唯一性 */
  filePath: string;
  /** 变更类型,用于 diff 预览的图标与语义。 */
  changeType: "added" | "modified" | "deleted";
} & (
  | {
      /** 已有真实 unified diff；不推造旧新全文或重生成 patch。 */
      patch: string;
      oldStartLine?: never;
      newStartLine?: never;
    }
  | {
      patch?: never;
      /** 对比模式的旧内容(edit 场景为 searchContent) */
      oldContent: string;
      /** 对比模式的新内容(create 场景为 content,edit 场景为 replaceContent) */
      newContent: string;
      /** 旧内容在真实源文件中的起始行号(1-based)。 */
      oldStartLine?: number;
      /** 新内容在真实源文件中的起始行号(1-based)。 */
      newStartLine?: number;
    }
);

export type OpenBrowserTabPayload = {
  /** 在右侧面板新建浏览器 tab 并导航到的 URL */
  url: string;
};

export type FocusBrowserTabPayload = {
  /** 需要切换到的浏览器实例 ID（browser MCP 工具返回的 instanceId） */
  instanceId: string;
};

export type OpenFilePayload = {
  /** 完整文件路径（支持相对路径的绝对化后的路径或 ssh:// 路径） */
  filePath: string;
  /** tab 标题与语法高亮推断用文件名；缺省时从 filePath 提取。 */
  fileName?: string;
  /** 是否为远程（SSH）文件。 */
  isSsh?: boolean;
  /** SSH 工作区 URL，用于在右侧面板按现有凭证链路建立/复用会话。 */
  sshWorkspacePath?: string;
  /** SSH 工作区 URL，用于校验远程文件写入边界。 */
  sshWorkspaceRoot?: string;
  /** 持久草稿绑定的稳定工作区 ID。 */
  sshWorkspaceId?: string;
  /** 远程会话 ID（已有会话时可直接传入）。 */
  sshSessionId?: string | null;
  /** 需要定位到的行号（1-based）。 */
  focusLine?: number;
};

export type OpenTerminalCommandPayload = {
  /** 终端工作目录（空串回退到当前工作区目录） */
  cwd: string;
  /** 在终端里执行的命令（自动补换行执行，输出留在终端内） */
  command: string;
  /** 终端 tab 标题（缺省为「终端」） */
  title?: string;
};

export type OpenPluginPanelPayload = {
  /** 目标插件 id */
  pluginId: string;
  /** 插件内面板 id（plugin.json 的 panels[].id） */
  panelId: string;
  /** tab 标题（缺省时回退到插件 id） */
  title?: string;
};

export type OpenExplorerPayload = {
  /** 资源管理器要展示的工作区目录 id */
  directoryId: string;
};

/** 资源管理器双击文件打开快速编辑弹窗：请求关闭该文件在右侧面板的阅读器 tab */
export type CloseFileTabPayload = {
  /** 文件路径（本地绝对路径或 SSH 裸远端路径，与打开时同一口径） */
  filePath: string;
  /** 是否为远程（SSH）文件 */
  isSsh: boolean;
  /** 远程会话 ID，需与打开该 tab 时使用的一致（本地忽略） */
  sshSessionId?: string | null;
};

/** 顶栏 Git 变更视图请求打开文件差异 */
export type OpenGitDiffPayload = {
  repoPath: string;
  file: GitFileStatus;
  staged: boolean;
};

/** 顶栏 Git 变更视图请求打开文件原文（路径可能是 ssh://） */
export type OpenGitFilePayload = {
  filePath: string;
  fileName: string;
};

type RightPanelEventMap = {
  "open-file-diff-preview": (payload: OpenFileDiffPreviewPayload) => void;
  "open-browser-tab": (payload: OpenBrowserTabPayload) => void;
  /** Restricted plugin link navigation; aliases the existing browser tab event. */
  "browser:navigate": (payload: OpenBrowserTabPayload) => void;
  "focus-browser-tab": (payload: FocusBrowserTabPayload) => void;
  "open-file": (payload: OpenFilePayload) => void;
  "open-terminal-command": (payload: OpenTerminalCommandPayload) => void;
  "open-plugin-panel": (payload: OpenPluginPanelPayload) => void;
  "open-explorer": (payload: OpenExplorerPayload) => void;
  /** 关闭某个文件在右侧面板的阅读器 tab（快速编辑弹窗接管该文件时使用） */
  "close-file": (payload: CloseFileTabPayload) => void;
  /** 切换资源管理器：已打开则关闭，否则打开（快捷键专用） */
  "toggle-explorer": (payload: OpenExplorerPayload) => void;
  "open-git-diff": (payload: OpenGitDiffPayload) => void;
  "open-git-file": (payload: OpenGitFilePayload) => void;
  "request-expand": () => void;
};

type EventKey = keyof RightPanelEventMap;

const listeners: {
  "open-file-diff-preview"?: Set<(payload: OpenFileDiffPreviewPayload) => void>;
  "open-browser-tab"?: Set<(payload: OpenBrowserTabPayload) => void>;
  "browser:navigate"?: Set<(payload: OpenBrowserTabPayload) => void>;
  "focus-browser-tab"?: Set<(payload: FocusBrowserTabPayload) => void>;
  "open-file"?: Set<(payload: OpenFilePayload) => void>;
  "open-terminal-command"?: Set<(payload: OpenTerminalCommandPayload) => void>;
  "open-plugin-panel"?: Set<(payload: OpenPluginPanelPayload) => void>;
  "open-explorer"?: Set<(payload: OpenExplorerPayload) => void>;
  "close-file"?: Set<(payload: CloseFileTabPayload) => void>;
  "toggle-explorer"?: Set<(payload: OpenExplorerPayload) => void>;
  "open-git-diff"?: Set<(payload: OpenGitDiffPayload) => void>;
  "open-git-file"?: Set<(payload: OpenGitFilePayload) => void>;
  "request-expand"?: Set<() => void>;
} = {};

export const rightPanelEvents = {
  on<K extends EventKey>(
    event: K,
    listener: RightPanelEventMap[K],
  ): () => void {
    const key = event === "browser:navigate" ? "open-browser-tab" : event;
    const set = listeners[key];
    if (!set) {
      // Different events carry different payloads; browser:navigate is an alias.
      (listeners as Record<string, Set<(...args: never[]) => void>>)[key] =
        new Set() as unknown as Set<RightPanelEventMap[K]>;
    }
    (listeners[key] as Set<RightPanelEventMap[K]>).add(listener);
    return () => {
      (listeners[key] as Set<RightPanelEventMap[K]> | undefined)?.delete(
        listener,
      );
    };
  },

  emit<K extends EventKey>(
    event: K,
    ...args: Parameters<RightPanelEventMap[K]>
  ): void {
    const key = event === "browser:navigate" ? "open-browser-tab" : event;
    const set = listeners[key] as Set<(...a: never[]) => void> | undefined;
    if (!set) return;
    for (const listener of set) {
      (listener as (...a: Parameters<RightPanelEventMap[K]>) => void)(...args);
    }
  },
};
