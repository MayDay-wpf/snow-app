import { ipcRenderer, webUtils, type IpcRendererEvent } from "electron";
import type {
  BatchWorkspaceDeleteResult,
  DirectoryEntry,
  DroppedPathEntry,
  FileContentResult,
  FileSearchAgentProgress,
  FileSearchResult,
  GitCloneProgress,
  ProjectCollectionRecord,
  WorkspaceDirectoryInput,
  WorkspaceDirectoryRecord,
} from "../types";

const AGENT_SEARCH_PROGRESS_CHANNEL =
  "workspace-directories:search-files-by-agent:progress";

const CLONE_PROGRESS_CHANNEL =
  "workspace-directories:clone-repository:progress";

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
  ipcRenderer.on(AGENT_SEARCH_PROGRESS_CHANNEL, (_event, payload: unknown) => {
    const record = payload as Record<string, unknown> | null;
    const streamId = record?.streamId;
    const chunk = record?.chunk as FileSearchAgentProgress | undefined;
    if (typeof streamId !== "string" || !chunk) {
      return;
    }
    agentSearchProgressCallbacks.get(streamId)?.(chunk);
  });
};

const cloneProgressCallbacks = new Map<
  string,
  (chunk: GitCloneProgress) => void
>();
let cloneProgressListenerRegistered = false;

const ensureCloneProgressListener = (): void => {
  if (cloneProgressListenerRegistered) {
    return;
  }
  cloneProgressListenerRegistered = true;
  ipcRenderer.on(CLONE_PROGRESS_CHANNEL, (_event, payload: unknown) => {
    const record = payload as Record<string, unknown> | null;
    const streamId = record?.streamId;
    const chunk = record?.chunk as GitCloneProgress | undefined;
    if (typeof streamId !== "string" || !chunk) {
      return;
    }
    cloneProgressCallbacks.get(streamId)?.(chunk);
  });
};

const createAgentSearchStreamId = (): string =>
  `agent-search-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const createCloneStreamId = (): string =>
  `clone-repo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export const workspaceApi = {
  listWorkspaceDirectories: (): Promise<WorkspaceDirectoryRecord[]> =>
    ipcRenderer.invoke("workspace-directories:list"),
  upsertWorkspaceDirectory: (
    item: WorkspaceDirectoryInput,
  ): Promise<WorkspaceDirectoryRecord[]> =>
    ipcRenderer.invoke("workspace-directories:upsert", item),
  activateWorkspaceDirectory: (
    directoryId: string,
  ): Promise<WorkspaceDirectoryRecord[]> =>
    ipcRenderer.invoke("workspace-directories:activate", directoryId),
  reorderWorkspaceDirectories: (
    items: WorkspaceDirectoryInput[],
  ): Promise<WorkspaceDirectoryRecord[]> =>
    ipcRenderer.invoke("workspace-directories:reorder", items),
  deleteWorkspaceDirectory: (
    directoryId: string,
  ): Promise<WorkspaceDirectoryRecord[]> =>
    ipcRenderer.invoke("workspace-directories:delete", directoryId),
  listProjectCollections: (): Promise<ProjectCollectionRecord[]> =>
    ipcRenderer.invoke("project-collections:list"),
  createProjectCollection: (name: string): Promise<ProjectCollectionRecord[]> =>
    ipcRenderer.invoke("project-collections:create", name),
  renameProjectCollection: (
    collectionId: string,
    name: string,
  ): Promise<ProjectCollectionRecord[]> =>
    ipcRenderer.invoke("project-collections:rename", collectionId, name),
  deleteProjectCollection: (
    collectionId: string,
  ): Promise<ProjectCollectionRecord[]> =>
    ipcRenderer.invoke("project-collections:delete", collectionId),
  reorderProjectCollectionMembers: (
    collectionId: string,
    orderedMemberIds: string[],
  ): Promise<ProjectCollectionRecord[]> =>
    ipcRenderer.invoke(
      "project-collections:reorder-members",
      collectionId,
      orderedMemberIds,
    ),
  moveProjectToCollection: (
    collectionId: string,
    directoryId: string,
    orderedMemberIds: string[],
  ): Promise<ProjectCollectionRecord[]> =>
    ipcRenderer.invoke(
      "project-collections:move-member",
      collectionId,
      directoryId,
      orderedMemberIds,
    ),
  removeProjectFromAllCollections: (
    directoryId: string,
  ): Promise<ProjectCollectionRecord[]> =>
    ipcRenderer.invoke(
      "project-collections:remove-member-from-all",
      directoryId,
    ),
  removeProjectFromCollection: (
    collectionId: string,
    directoryId: string,
  ): Promise<ProjectCollectionRecord[]> =>
    ipcRenderer.invoke(
      "project-collections:remove-member",
      collectionId,
      directoryId,
    ),
  createWorkspaceProject: (
    parentPath: string,
    projectName: string,
  ): Promise<WorkspaceDirectoryRecord[]> =>
    ipcRenderer.invoke(
      "workspace-directories:create-project",
      parentPath,
      projectName,
    ),
  /**
   * 克隆 Git 仓库：在 `parentPath` 下按 git 惯例以项目名新建子目录
   * 进行克隆，完成后由主进程登记为活动工作区目录。
   * `onProgress` 接收 git stderr 解析出的实时进度（行文本 + 百分比）。
   */
  cloneWorkspaceRepository: (
    repoUrl: string,
    parentPath: string,
    onProgress?: (chunk: GitCloneProgress) => void,
  ): Promise<WorkspaceDirectoryRecord[]> => {
    const streamId = createCloneStreamId();
    ensureCloneProgressListener();

    if (onProgress) {
      cloneProgressCallbacks.set(streamId, onProgress);
    }

    return ipcRenderer
      .invoke(
        "workspace-directories:clone-repository",
        repoUrl,
        parentPath,
        streamId,
      )
      .finally(() => {
        cloneProgressCallbacks.delete(streamId);
      });
  },
  selectWorkspaceDirectory: (dialogTitle?: string): Promise<string | null> =>
    ipcRenderer.invoke(
      "workspace-directories:select-local-directory",
      dialogTitle,
    ),
  readDirectoryEntries: (dirPath: string): Promise<DirectoryEntry[]> =>
    ipcRenderer.invoke("workspace-directories:read-entries", dirPath),
  renameWorkspaceEntry: (
    rootPath: string,
    entryPath: string,
    newName: string,
  ): Promise<void> =>
    ipcRenderer.invoke(
      "workspace-directories:rename-entry",
      rootPath,
      entryPath,
      newName,
    ),
  deleteWorkspaceEntry: (rootPath: string, entryPath: string): Promise<void> =>
    ipcRenderer.invoke(
      "workspace-directories:delete-entry",
      rootPath,
      entryPath,
    ),
  deleteWorkspaceEntries: (
    rootPath: string,
    entryPaths: string[],
  ): Promise<BatchWorkspaceDeleteResult> =>
    ipcRenderer.invoke(
      "workspace-directories:delete-entries",
      rootPath,
      entryPaths,
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
    onProgress?: (chunk: FileSearchAgentProgress) => void,
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
        streamId,
      )
      .finally(() => {
        agentSearchProgressCallbacks.delete(streamId);
      });
  },
  selectFiles: (
    dialogTitle?: string,
  ): Promise<{ path: string; isDirectory: boolean }[] | null> =>
    ipcRenderer.invoke("workspace-directories:select-files", dialogTitle),
  selectDirectories: (
    dialogTitle?: string,
  ): Promise<{ path: string; isDirectory: boolean }[] | null> =>
    ipcRenderer.invoke("workspace-directories:select-directories", dialogTitle),
  /**
   * 解析拖入编辑区的外部文件为真实磁盘路径列表。
   *
   * contextIsolation 下渲染进程无法直接访问 webUtils.getPathForFile，
   * 由 preload 通过该函数将 File 对象逐一解析为绝对路径，再交由主进程
   * 异步查询每个路径是否为目录，返回统一的结构供渲染层生成对应 chip。
   */
  resolveDroppedFiles: async (files: File[]): Promise<DroppedPathEntry[]> => {
    const paths = files
      .map((file) => {
        try {
          return webUtils.getPathForFile(file);
        } catch {
          return null;
        }
      })
      .filter(
        (path): path is string => typeof path === "string" && path.length > 0,
      );
    if (paths.length === 0) {
      return [];
    }
    return ipcRenderer.invoke(
      "workspace-directories:resolve-dropped-paths",
      paths,
    );
  },
};
