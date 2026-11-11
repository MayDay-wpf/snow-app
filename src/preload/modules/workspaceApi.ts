import { ipcRenderer, webUtils, type IpcRendererEvent } from "electron";
import type {
  BatchWorkspaceCopyResult,
  BatchWorkspaceDeleteResult,
  DirectoryEntry,
  DroppedPathEntry,
  FileContentResult,
  FilePreviewResult,
  FileSearchAgentProgress,
  FileSearchResult,
  GitCloneProgress,
  ProjectCollectionRecord,
  ResolvedFileLink,
  WorkspaceDirectoryInput,
  WorkspaceDirectoryRecord,
  WorkspaceDirectoryVerifyReport,
  WorkspaceRelinkRecord,
  WorkspaceRelinkResult,
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
  verifyWorkspaceDirectory: (
    directoryId: string,
  ): Promise<WorkspaceDirectoryVerifyReport> =>
    ipcRenderer.invoke("workspace-directories:verify", directoryId),
  relinkWorkspaceDirectory: (
    oldDirectoryId: string,
    newPath: string,
    dryRun = false,
  ): Promise<WorkspaceRelinkResult> =>
    ipcRenderer.invoke(
      "workspace-directories:relink",
      oldDirectoryId,
      newPath,
      dryRun,
    ),
  undoWorkspaceDirectoryRelink: (
    relinkId: string,
  ): Promise<WorkspaceRelinkResult> =>
    ipcRenderer.invoke("workspace-directories:relink-undo", relinkId),
  /** 修改远程目录的连接信息；数据随新的 directory_id 一起迁移。 */
  updateSshWorkspaceConnection: (
    directoryId: string,
    sshUrl: string,
  ): Promise<WorkspaceRelinkResult> =>
    ipcRenderer.invoke(
      "workspace-directories:update-ssh-connection",
      directoryId,
      sshUrl,
    ),
  listWorkspaceDirectoryRelinks: (
    directoryId: string,
    limit = 50,
  ): Promise<WorkspaceRelinkRecord[]> =>
    ipcRenderer.invoke(
      "workspace-directories:relink-history",
      directoryId,
      limit,
    ),
  listProjectCollections: (): Promise<ProjectCollectionRecord[]> =>
    ipcRenderer.invoke("project-collections:list"),
  /** 创建合集 / 关联项目组；memberDirectoryIds 非空时创建即完成关联。 */
  createProjectCollection: (
    name: string,
    memberDirectoryIds: string[] = [],
  ): Promise<ProjectCollectionRecord[]> =>
    ipcRenderer.invoke("project-collections:create", name, memberDirectoryIds),
  updateProjectCollectionColor: (
    collectionId: string,
    color: string,
  ): Promise<ProjectCollectionRecord[]> =>
    ipcRenderer.invoke("project-collections:update-color", collectionId, color),
  /** 切换成员的「参与关联」：断连后该目录仍留在合集里，只是不参与关联。 */
  setProjectCollectionMemberLinked: (
    collectionId: string,
    directoryId: string,
    linked: boolean,
  ): Promise<ProjectCollectionRecord[]> =>
    ipcRenderer.invoke(
      "project-collections:set-member-linked",
      collectionId,
      directoryId,
      linked,
    ),
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
  reorderProjectCollections: (
    orderedCollectionIds: string[],
  ): Promise<ProjectCollectionRecord[]> =>
    ipcRenderer.invoke("project-collections:reorder", orderedCollectionIds),
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
   * `onProgress` 接收 git stderr 解析出的实时进度（行文本 + 百分比）；
   * `onStreamId` 同步回调本次克隆的 streamId，供
   * `cancelCloneWorkspaceRepository` 中止（弹窗关闭后克隆仍在后台进行）。
   */
  cloneWorkspaceRepository: (
    repoUrl: string,
    parentPath: string,
    onProgress?: (chunk: GitCloneProgress) => void,
    onStreamId?: (streamId: string) => void,
  ): Promise<WorkspaceDirectoryRecord[]> => {
    const streamId = createCloneStreamId();
    ensureCloneProgressListener();
    onStreamId?.(streamId);

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
  /**
   * 中止正在进行的克隆：Rust 侧杀掉整棵 git 进程树并清理半成品目标
   * 目录，返回是否命中在跑的任务（已完成/已中止时为 false）。
   */
  cancelCloneWorkspaceRepository: (streamId: string): Promise<boolean> =>
    ipcRenderer.invoke(
      "workspace-directories:clone-repository:cancel",
      streamId,
    ),
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
  /** 本地上传：把外部普通文件复制进工作区目录；replaceExisting=false 时同名自动另存。 */
  copyFilesIntoDirectory: (
    rootPath: string,
    targetDir: string,
    sourcePaths: string[],
    replaceExisting: boolean,
  ): Promise<BatchWorkspaceCopyResult> =>
    ipcRenderer.invoke(
      "workspace-directories:copy-files-into",
      rootPath,
      targetDir,
      sourcePaths,
      replaceExisting,
    ),
  readFileContent: (filePath: string): Promise<FileContentResult> =>
    ipcRenderer.invoke("workspace-directories:read-file", filePath),
  /** 结构化只读预览；section 为工作表名或数据表名，缺省取第一个。 */
  readFilePreview: (
    filePath: string,
    section?: string | null,
  ): Promise<FilePreviewResult> =>
    ipcRenderer.invoke(
      "workspace-directories:read-file-preview",
      filePath,
      section ?? null,
    ),
  writeFileContent: (filePath: string, content: string): Promise<void> =>
    ipcRenderer.invoke("workspace-directories:write-file", filePath, content),
  /** 解析正文中的文件路径引用：返回磁盘上真实存在的条目，找不到为 null。 */
  resolveFileLink: (
    rootDir: string | null,
    rawPath: string,
  ): Promise<ResolvedFileLink | null> =>
    ipcRenderer.invoke(
      "workspace-directories:resolve-file-link",
      rootDir,
      rawPath,
    ),
  startDirectoryWatch: (dirPath: string): Promise<void> =>
    ipcRenderer.invoke("workspace-directories:start-watch", dirPath),
  stopDirectoryWatch: (dirPath: string): Promise<void> =>
    ipcRenderer.invoke("workspace-directories:stop-watch", dirPath),
  onDirectoryChanged: (
    callback: (change: { dirPath: string; paths: string[] }) => void,
  ): (() => void) => {
    const handler = (
      _event: IpcRendererEvent,
      change: { dirPath: string; paths: string[] },
    ): void => {
      callback(change);
    };

    ipcRenderer.on("workspace-directories:changed", handler);

    return () => {
      ipcRenderer.removeListener("workspace-directories:changed", handler);
    };
  },
  watchFile: (filePath: string): Promise<void> =>
    ipcRenderer.invoke("workspace-directories:start-file-watch", filePath),
  unwatchFile: (filePath: string): Promise<void> =>
    ipcRenderer.invoke("workspace-directories:stop-file-watch", filePath),
  onFileChanged: (callback: (filePath: string) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, filePath: string): void => {
      callback(filePath);
    };

    ipcRenderer.on("workspace-directories:file-changed", handler);

    return () => {
      ipcRenderer.removeListener("workspace-directories:file-changed", handler);
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
  /** linked 默认 true：项目属于关联项目组时一次覆盖组内全部根；
   *  false 只搜索给定根目录（`@:项目/` 显式限定的成员）。 */
  searchFiles: (
    dirPath: string,
    query: string,
    linked?: boolean,
  ): Promise<FileSearchResult[]> =>
    ipcRenderer.invoke(
      "workspace-directories:search-files",
      dirPath,
      query,
      linked,
    ),
  searchFileContents: (
    dirPath: string,
    query: string,
    linked?: boolean,
  ): Promise<FileSearchResult[]> =>
    ipcRenderer.invoke(
      "workspace-directories:search-file-contents",
      dirPath,
      query,
      linked,
    ),
  searchFilesByAgent: (
    query: string,
    workspacePath: string,
    onProgress?: (chunk: FileSearchAgentProgress) => void,
    linked?: boolean,
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
        linked,
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
