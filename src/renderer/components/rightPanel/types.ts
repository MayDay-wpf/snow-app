import type {
  FileContentResult,
  GitDiffResult,
  GitFileStatus,
  WorkspaceDirectoryRecord,
} from "../../../preload";

export type RightPanelContentKey =
  | "git"
  | "terminal"
  | "browser"
  | "file"
  | "file-diff-preview"
  | "codebase";

export type RightPanelContentProps = {
  activeDirectory?: WorkspaceDirectoryRecord | null;
};

export type DiffTabData = {
  filePath: string;
  selectedFile: GitFileStatus;
  diffResult: GitDiffResult | null;
  diffLoading: boolean;
};

export type TerminalOpenOptions = {
  ptyId?: string;
  shellPath?: string;
  sessionId?: string;
};

export type TerminalTabData = {
  cwd: string;
  ptyId?: string;
  shellPath?: string;
  sessionId?: string;
};

export type BrowserTabData = {
  instanceId: string;
  url: string;
  /**
   * 实例内部的标签页快照（独立浏览器窗口「还原为标签页」时携带，
   * BrowserPanelContent 据此初始化多个内部标签页）。
   */
  tabs?: { url: string; title: string }[];
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

export type RightPanelTab = {
  id: string;
  type:
    | "git"
    | "diff"
    | "terminal"
    | "browser"
    | "file"
    | "file-diff-preview"
    | "codebase"
    | "drawing";
  title: string;
  data?:
    | DiffTabData
    | TerminalTabData
    | BrowserTabData
    | FileViewerTabData
    | FileDiffPreviewTabData
    | CodebaseTabData;
};

export type OpenDiffTabCallback = (
  file: GitFileStatus,
  diffResult: GitDiffResult | null,
  diffLoading: boolean
) => void;

export type OpenFileDiffPreviewTabCallback = (
  data: FileDiffPreviewTabData
) => void;

export type OpenFileTabCallback = (
  filePath: string,
  fileName: string,
  isSsh: boolean,
  sshSessionId?: string | null,
  sshWorkspaceRoot?: string
) => void;

export type { FileContentResult };
