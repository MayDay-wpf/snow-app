import { ipcRenderer, webUtils, type IpcRendererEvent } from "electron";
import type {
  DirectoryEntry,
  DroppedPathEntry,
  FileContentResult,
  FileSearchAgentProgress,
  FileSearchResult,
  WorkspaceDirectoryInput,
  WorkspaceDirectoryRecord,
} from "../types";

const AGENT_SEARCH_PROGRESS_CHANNEL =
  "workspace-directories:search-files-by-agent:progress";

const agentSearchProgressCallbacks = new Map<
  string,
  (chunk: FileSearchAgentProgress) => void
>();
let agentSearchProgressListenerRegistered = false;

const ensureAgentSearchProgressListener = (): void => {
  if (agentSearchProgressListenerRegistered) {
    return;
  }
  agentSearchProgressListenerRegistered = true;
  ipcRenderer.on(
    AGENT_SEARCH_PROGRESS_CHANNEL,
    (_event, payload: unknown) => {
      const record = payload as Record<string, unknown> | null;
      const streamId = record?.streamId;
      const chunk = record?.chunk as FileSearchAgentProgress | undefined;
      if (typeof streamId !== "string" || !chunk) {
        return;
      }
      agentSearchProgressCallbacks.get(streamId)?.(chunk);
    }
  );
};

const createAgentSearchStreamId = (): string =>
  `agent-search-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export const workspaceApi = {
  listWorkspaceDirectories: (): Promise<WorkspaceDirectoryRecord[]> =>
    ipcRenderer.invoke("workspace-directories:list"),
  upsertWorkspaceDirectory: (
    item: WorkspaceDirectoryInput
  ): Promise<WorkspaceDirectoryRecord[]> =>
    ipcRenderer.invoke("workspace-directories:upsert", item),
  activateWorkspaceDirectory: (
    directoryId: string
  ): Promise<WorkspaceDirectoryRecord[]> =>
    ipcRenderer.invoke("workspace-directories:activate", directoryId),
  reorderWorkspaceDirectories: (
    items: WorkspaceDirectoryInput[]
  ): Promise<WorkspaceDirectoryRecord[]> =>
    ipcRenderer.invoke("workspace-directories:reorder", items),
  deleteWorkspaceDirectory: (
    directoryId: string
  ): Promise<WorkspaceDirectoryRecord[]> =>
    ipcRenderer.invoke("workspace-directories:delete", directoryId),
  createWorkspaceProject: (
    parentPath: string,
    projectName: string
  ): Promise<WorkspaceDirectoryRecord[]> =>
    ipcRenderer.invoke(
      "workspace-directories:create-project",
      parentPath,
      projectName
    ),
  selectWorkspaceDirectory: (dialogTitle?: string): Promise<string | null> =>
    ipcRenderer.invoke(
      "workspace-directories:select-local-directory",
      dialogTitle
    ),
  readDirectoryEntries: (dirPath: string): Promise<DirectoryEntry[]> =>
    ipcRenderer.invoke("workspace-directories:read-entries", dirPath),
  renameWorkspaceEntry: (
    rootPath: string,
    entryPath: string,
    newName: string
  ): Promise<void> =>
    ipcRenderer.invoke(
      "workspace-directories:rename-entry",
      rootPath,
      entryPath,
      newName
    ),
  deleteWorkspaceEntry: (rootPath: string, entryPath: string): Promise<void> =>
    ipcRenderer.invoke(
      "workspace-directories:delete-entry",
      rootPath,
      entryPath
    ),
  readFileContent: (filePath: string): Promise<FileContentResult> =>
    ipcRenderer.invoke("workspace-directories:read-file", filePath),
  writeFileContent: (filePath: string, content: string): Promise<void> =>
    ipcRenderer.invoke("workspace-directories:write-file", filePath, content),
  startDirectoryWatch: (dirPath: string): Promise<void> =>
    ipcRenderer.invoke("workspace-directories:start-watch", dirPath),
  stopDirectoryWatch: (dirPath: string): Promise<void> =>
    ipcRenderer.invoke("workspace-directories:stop-watch", dirPath),
  onDirectoryChanged: (callback: (dirPath: string) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, dirPath: string): void => {
      callback(dirPath);
    };

    ipcRenderer.on("workspace-directories:changed", handler);

    return () => {
      ipcRenderer.removeListener("workspace-directories:changed", handler);
    };
  },
  onWorkspaceDirectoryListChanged: (callback: () => void): (() => void) => {
    const handler = (): void => {
      callback();
    };

    ipcRenderer.on("workspace-directory-list:changed", handler);

    return () => {
      ipcRenderer.removeListener("workspace-directory-list:changed", handler);
    };
  },
  searchFiles: (dirPath: string, query: string): Promise<FileSearchResult[]> =>
    ipcRenderer.invoke("workspace-directories:search-files", dirPath, query),
  searchFilesByAgent: (
    query: string,
    workspacePath: string,
    onProgress?: (chunk: FileSearchAgentProgress) => void
  ): Promise<FileSearchResult[]> => {
    const streamId = createAgentSearchStreamId();
    ensureAgentSearchProgressListener();

    if (onProgress) {
      agentSearchProgressCallbacks.set(streamId, onProgress);
    }

    return ipcRenderer
      .invoke(
        "workspace-directories:search-files-by-agent",
        query,
        workspacePath,
        streamId
      )
      .finally(() => {
        agentSearchProgressCallbacks.delete(streamId);
      });
  },
  selectFiles: (
    dialogTitle?: string
  ): Promise<{ path: string; isDirectory: boolean }[] | null> =>
    ipcRenderer.invoke("workspace-directories:select-files", dialogTitle),
  selectDirectories: (
    dialogTitle?: string
  ): Promise<{ path: string; isDirectory: boolean }[] | null> =>
    ipcRenderer.invoke("workspace-directories:select-directories", dialogTitle),
  /**
   * 解析拖入编辑区的外部文件为真实磁盘路径列表。
   *
   * contextIsolation 下渲染进程无法直接访问 webUtils.getPathForFile，
   * 由 preload 通过该函数将 File 对象逐一解析为绝对路径，再交由主进程
   * 异步查询每个路径是否为目录，返回统一的结构供渲染层生成对应 chip。
   */
  resolveDroppedFiles: async (
    files: File[]
  ): Promise<DroppedPathEntry[]> => {
    const paths = files
      .map((file) => {
        try {
          return webUtils.getPathForFile(file);
        } catch {
          return null;
        }
      })
      .filter((path): path is string => typeof path === "string" && path.length > 0);
    if (paths.length === 0) {
      return [];
    }
    return ipcRenderer.invoke("workspace-directories:resolve-dropped-paths", paths);
  },
};
