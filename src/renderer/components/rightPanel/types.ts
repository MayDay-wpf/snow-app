import type {
  FileContentResult,
  FilePreviewResult,
  GitDiffResult,
  GitFileStatus,
  GitImageDiff,
  WorkspaceDirectoryRecord,
} from "../../../preload";
import type { BrowserAgentAccess } from "./browser/browserAgentAccess";

export type RightPanelContentKey =
  | "git"
  | "terminal"
  | "browser"
  | "file"
  | "file-diff-preview"
  | "codebase"
  | "drawing"
  | "plugin";

export type RightPanelContentProps = {
  activeDirectory?: WorkspaceDirectoryRecord | null;
};

export type DiffTabData = {
  filePath: string;
  selectedFile: GitFileStatus;
  diffResult: GitDiffResult | null;
  diffLoading: boolean;
  /** 图片文件的旧/新版本预览数据；非图片或未加载时为 null。 */
  imageDiff?: GitImageDiff | null;
};

export type TerminalOpenOptions = {
  /** tab 标题（缺省为「终端」）；终端上报的 shell 标题仍会覆盖它 */
  title?: string;
  ptyId?: string;
  shellPath?: string;
  sessionId?: string;
};

export type TerminalTabData = {
  cwd: string;
  ptyId?: string;
  shellPath?: string;
  sessionId?: string;
  /**
   * 迁移到独立面板窗口时携带的屏幕 + 回滚缓冲纯文本快照：挂载时先写入新
   * xterm 实例，使迁移前的输出历史保留可见。
   */
  snapshot?: string;
};

export type BrowserTabData = {
  instanceId: string;
  url: string;
  /** 创建时的 Agent 授权初始值（运行时以 browserAgentAccess 注册表为准） */
  agentAccess?: BrowserAgentAccess;
};

export type FileViewerTabData = {
  filePath: string;
  fileName: string;
  isSsh: boolean;
  sshSessionId?: string | null;
  sshWorkspaceRoot?: string;
  sshWorkspaceId?: string;
  focusLine?: number;
};

export type FileDiffPreviewTabData = {
  fileName: string;
  filePath: string;
  patch: string | null;
  oldStartLine?: number;
  newStartLine?: number;
  changeType: "added" | "modified" | "deleted";
};

export type CodebaseTabData = {
  projectId: string;
  projectName: string;
};

/** 资源管理器 tab 数据：绑定的工作区目录（切换项目时更新，驱动列表重新加载）。 */
export type ExplorerTabData = {
  directoryId: string;
};

/** 绘图工作台 tab 数据（画布内容保存在组件内部状态，无需持久化字段）。 */
export type DrawingTabData = Record<string, never>;

/** 插件面板 tab 数据：定位到具体插件下的某个面板。 */
export type PluginTabData = {
  pluginId: string;
  panelId: string;
};

/** 应用任务管理器 tab 数据（进程快照由组件自行轮询，无需持久化字段）。 */
export type TaskManagerTabData = Record<string, never>;

/**
 * 会话 tab 数据：主窗口的会话面板与独立面板窗口共用。
 * conversationId 是 tab 身份（拖入面板的那个会话）；viewConversationId 是
 * 通过 tab 标题下拉切换后当前展示的会话（子代理 / Workflow 节点），
 * 缺省或等于 conversationId 时展示根会话。
 */
export type ConversationTabData = {
  conversationId: string;
  viewConversationId?: string;
};

export type RightPanelTabType =
  | "git"
  | "diff"
  | "terminal"
  | "browser"
  | "file"
  | "file-diff-preview"
  | "codebase"
  | "explorer"
  | "drawing"
  | "plugin"
  | "tasks"
  | "conversation";

export type RightPanelTab = {
  id: string;
  type: RightPanelTabType;
  title: string;
  data?:
    | DiffTabData
    | TerminalTabData
    | BrowserTabData
    | FileViewerTabData
    | FileDiffPreviewTabData
    | CodebaseTabData
    | ExplorerTabData
    | DrawingTabData
    | PluginTabData
    | TaskManagerTabData
    | ConversationTabData;
};

export type OpenDiffTabCallback = (
  file: GitFileStatus,
  diffResult: GitDiffResult | null,
  diffLoading: boolean,
  imageDiff?: GitImageDiff | null,
) => void;

export type OpenFileDiffPreviewTabCallback = (
  data: FileDiffPreviewTabData,
) => void;

export type OpenFileTabCallback = (
  filePath: string,
  fileName: string,
  isSsh: boolean,
  sshSessionId?: string | null,
  sshWorkspaceRoot?: string,
) => void;

export type { FileContentResult, FilePreviewResult };
