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
  | "codebase"
  | "remote-jobs";

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

export type RemoteJobsTabData = {
  workspacePath: string;
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
    | "remote-jobs";
  title: string;
  data?:
    | DiffTabData
    | TerminalTabData
    | BrowserTabData
    | FileViewerTabData
    | FileDiffPreviewTabData
    | CodebaseTabData
    | RemoteJobsTabData;
};

export type OpenDiffTabCallback = (
  file: GitFileStatus,
  diffResult: GitDiffResult | null,
  diffLoading: boolean
) => void;

export type OpenFileDiffPreviewTabCallback = (data: FileDiffPreviewTabData) => void;

export type OpenFileTabCallback = (
  filePath: string,
  fileName: string,
  isSsh: boolean,
  sshSessionId?: string | null,
  sshWorkspaceRoot?: string
) => void;

export type { FileContentResult };
