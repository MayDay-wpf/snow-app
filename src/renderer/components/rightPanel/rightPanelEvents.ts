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

export type OpenFileDiffPreviewPayload = {
  /** 用于推断语法高亮语言的文件名,同时作为 tab 标题 */
  fileName: string;
  /** 完整文件路径,用于 tab title tooltip 与唯一性 */
  filePath: string;
  /** 对比模式的旧内容(edit 场景为 searchContent) */
  oldContent: string;
  /** 对比模式的新内容(create 场景为 content,edit 场景为 replaceContent) */
  newContent: string;
  /**
   * 旧内容在真实源文件中的起始行号(1-based)。
   * 用于编辑工具调用时,让 diff 显示正确的源文件行号。
   */
  oldStartLine?: number;
  /** 新内容在真实源文件中的起始行号(1-based)。 */
  newStartLine?: number;
  /** 变更类型,用于 diff 预览的图标与语义。 */
  changeType: "added" | "modified" | "deleted";
};

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

type RightPanelEventMap = {
  "open-file-diff-preview": (payload: OpenFileDiffPreviewPayload) => void;
  "open-browser-tab": (payload: OpenBrowserTabPayload) => void;
  "focus-browser-tab": (payload: FocusBrowserTabPayload) => void;
  "open-file": (payload: OpenFilePayload) => void;
  "request-expand": () => void;
};

type EventKey = keyof RightPanelEventMap;

const listeners: {
  "open-file-diff-preview"?: Set<(payload: OpenFileDiffPreviewPayload) => void>;
  "open-browser-tab"?: Set<(payload: OpenBrowserTabPayload) => void>;
  "focus-browser-tab"?: Set<(payload: FocusBrowserTabPayload) => void>;
  "open-file"?: Set<(payload: OpenFilePayload) => void>;
  "request-expand"?: Set<() => void>;
} = {};

export const rightPanelEvents = {
  on<K extends EventKey>(
    event: K,
    listener: RightPanelEventMap[K]
  ): () => void {
    const set = listeners[event];
    if (!set) {
      // 不同事件的 listener 类型不同，用类型断言统一初始化
      (listeners as Record<string, Set<(...args: never[]) => void>>)[event] =
        new Set() as unknown as Set<RightPanelEventMap[K]>;
    }
    (listeners[event] as Set<RightPanelEventMap[K]>).add(listener);
    return () => {
      (listeners[event] as Set<RightPanelEventMap[K]> | undefined)?.delete(
        listener
      );
    };
  },

  emit<K extends EventKey>(
    event: K,
    ...args: Parameters<RightPanelEventMap[K]>
  ): void {
    const set = listeners[event] as
      | Set<(...a: never[]) => void>
      | undefined;
    if (!set) {
      return;
    }
    for (const listener of set) {
      (listener as (...a: Parameters<RightPanelEventMap[K]>) => void)(
        ...args
      );
    }
  },
};
