export type WorkspaceDirectoryKind = "local" | "ssh";

export type WorkspaceDirectoryInput = {
  directoryId: string;
  name: string;
  path: string;
  kind: WorkspaceDirectoryKind;
  isActive: boolean;
  sortOrder: number;
  source: string;
};

export type WorkspaceDirectoryRecord = WorkspaceDirectoryInput & {
  id: string;
  updatedAt: string;
};

export type DirectoryEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
};

export type FileSearchResult = {
  path: string;
  relativePath: string;
  name: string;
  isDirectory: boolean;
  matchedName: boolean;
  lineMatches: Array<{ line: number; text: string }>;
};

/** 自然语言文件搜索 agent 的进度回调数据（每次工具调用一条）。 */
import type { SshFileVersion } from "./ssh";

export type FileSearchAgentProgress = {
  round: number;
  tool: string;
  argsJson: string;
  resultPreview: string;
};

export type FileContentResult = {
  content: string;
  isBinary: boolean;
  isImage: boolean;
  isSvg: boolean;
  mimeType: string;
  encoding: string;
  size: number;
  /** Present only for remote SSH reads and used as the save CAS token. */
  remoteVersion?: SshFileVersion;
};

/**
 * 从外部拖入编辑区的文件解析结果。
 *
 * path 为磁盘绝对路径（由 webUtils.getPathForFile 解析），
 * isDirectory 标记该路径是否为目录（由主进程 fs.stat 查询）。
 * 用于在渲染层统一生成文件 chip 或图片 chip。
 */
export type DroppedPathEntry = {
  path: string;
  isDirectory: boolean;
};
