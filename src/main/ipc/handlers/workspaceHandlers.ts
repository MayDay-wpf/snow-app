import { BrowserWindow, dialog, ipcMain } from "electron";
import { promises as fs } from "fs";
import { homedir } from "os";
import { extname, join } from "path";
import type {
  FileSearchAgentProgress,
  GitCloneProgress,
  NativeBridge,
} from "../../native/types";
import {
  createWorkspaceDirectoryInput,
  normalizeWorkspaceDirectory,
  normalizeWorkspaceDirectoryList,
} from "../../settings/workspaceDirectories";
import { parseSshUrl } from "../../ssh/sshManager";
import { deleteSshCredential } from "../../ssh/sshCredentials";
import {
  getSshWorkspaceProfileId,
  sshConnectionManager,
} from "../../ssh/sshConnectionManager";
import { startDirectoryWatch, stopDirectoryWatch } from "../../utils/fsWatcher";
import { startFileWatch, stopFileWatch } from "../../utils/fileWatcher";
import { safeSend } from "../../utils/safeSend";
import { broadcastWorkspaceDirectoryListChanged as broadcastDirectoryListChanged } from "../../utils/workspaceDirectoryBroadcast";

const AGENT_SEARCH_PROGRESS_CHANNEL =
  "workspace-directories:search-files-by-agent:progress";

const CLONE_PROGRESS_CHANNEL =
  "workspace-directories:clone-repository:progress";

// macOS 把 .app 等包当文件，选目录时要允许把它们当文件夹进入
const withPackageAsDirectory = (
  properties: Electron.OpenDialogOptions["properties"],
): Electron.OpenDialogOptions["properties"] =>
  process.platform === "darwin"
    ? [...(properties ?? []), "treatPackageAsDirectory"]
    : properties;

export const registerWorkspaceHandlers = (native: NativeBridge): void => {
  ipcMain.handle("workspace-directories:list", () =>
    native.listWorkspaceDirectories(),
  );
  ipcMain.handle(
    "workspace-directories:upsert",
    async (_event, item: unknown) => {
      const existingCount = (await native.listWorkspaceDirectories()).length;
      await native.upsertWorkspaceDirectory(
        normalizeWorkspaceDirectory(item, existingCount),
      );
      const directories = await native.listWorkspaceDirectories();
      broadcastDirectoryListChanged();
      return directories;
    },
  );
  ipcMain.handle(
    "workspace-directories:activate",
    async (_event, directoryId: unknown) => {
      if (typeof directoryId !== "string" || !directoryId.trim()) {
        throw new Error("Workspace directory ID is required");
      }

      const normalizedDirectoryId = directoryId.trim();
      const report = await native.verifyWorkspaceDirectory(
        normalizedDirectoryId,
      );

      if (report.state !== "ok" && report.state !== "remote") {
        throw new Error(
          `WORKSPACE_DIRECTORY_UNAVAILABLE:${report.state}:${report.path}`,
        );
      }

      await native.activateWorkspaceDirectory(normalizedDirectoryId);
      const directories = await native.listWorkspaceDirectories();
      broadcastDirectoryListChanged();
      return directories;
    },
  );
  ipcMain.handle(
    "workspace-directories:reorder",
    async (_event, items: unknown) => {
      const existingCount = (await native.listWorkspaceDirectories()).length;
      const directories = normalizeWorkspaceDirectoryList(items, existingCount);

      if (typeof native.reorderWorkspaceDirectories === "function") {
        await native.reorderWorkspaceDirectories(directories);
      } else {
        for (const directory of directories) {
          await native.upsertWorkspaceDirectory(directory);
        }
      }

      const result = await native.listWorkspaceDirectories();
      broadcastDirectoryListChanged();
      return result;
    },
  );
  ipcMain.handle(
    "workspace-directories:delete",
    async (_event, directoryId: unknown) => {
      if (typeof directoryId !== "string" || !directoryId.trim()) {
        throw new Error("Workspace directory ID is required");
      }

      await native.deleteWorkspaceDirectory(directoryId.trim());
      const directories = await native.listWorkspaceDirectories();
      broadcastDirectoryListChanged();
      return directories;
    },
  );

  // ===== Project collections（项目合集） =====
  // 合集是收纳项目的纯元数据容器，变更后广播 workspace-directory-list:changed，
  // 让侧边栏与合集列表一起刷新。
  const requireText = (value: unknown, label: string): string => {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`${label} is required`);
    }
    return value.trim();
  };

  // 校验合集成员顺序列表：必须是非空字符串数组（去重交给 Rust 端校验）
  const requireDirectoryIdList = (value: unknown): string[] => {
    if (
      !Array.isArray(value) ||
      value.some((id) => typeof id !== "string" || !id.trim())
    ) {
      throw new Error(
        "Ordered member directory IDs must be a list of non-empty strings",
      );
    }
    return (value as string[]).map((id) => id.trim());
  };

  // ===== Path health / relink（项目位置移动的自动兼容） =====
  ipcMain.handle(
    "workspace-directories:verify",
    (_event, directoryId: unknown) =>
      native.verifyWorkspaceDirectory(
        requireText(directoryId, "Workspace directory ID"),
      ),
  );
  ipcMain.handle(
    "workspace-directories:relink",
    async (
      _event,
      oldDirectoryId: unknown,
      newPath: unknown,
      dryRun: unknown,
    ) => {
      const normalizedOldId = requireText(
        oldDirectoryId,
        "Workspace directory ID",
      );
      const normalizedNewPath = requireText(
        newPath,
        "Workspace directory path",
      );
      const isDryRun = dryRun === true;

      // 迁移前记录旧路径，迁移后按新路径重建目录监听。
      const previousPath = isDryRun
        ? ""
        : ((await native.listWorkspaceDirectories()).find(
            (directory) => directory.directoryId === normalizedOldId,
          )?.path ?? "");

      const report = await native.relinkWorkspaceDirectory(
        normalizedOldId,
        normalizedNewPath,
        isDryRun,
      );

      if (!isDryRun) {
        if (previousPath) {
          stopDirectoryWatch(previousPath);
        }
        startDirectoryWatch(report.newPath);
        if (typeof native.stopCodebaseWatch === "function") {
          native.stopCodebaseWatch(report.oldDirectoryId);
        }
      }

      const directories = await native.listWorkspaceDirectories();
      if (!isDryRun) {
        broadcastDirectoryListChanged();
      }

      return { report, directories };
    },
  );
  ipcMain.handle(
    "workspace-directories:relink-undo",
    async (_event, relinkId: unknown) => {
      const report = await native.undoWorkspaceDirectoryRelink(
        requireText(relinkId, "Relink record ID"),
      );

      const directories = await native.listWorkspaceDirectories();
      broadcastDirectoryListChanged();
      return { report, directories };
    },
  );
  ipcMain.handle(
    "workspace-directories:relink-history",
    (_event, directoryId: unknown, limit: unknown) => {
      const normalizedLimit =
        typeof limit === "number" && Number.isFinite(limit)
          ? Math.trunc(limit)
          : 50;

      return native.listWorkspaceDirectoryRelinks(
        requireText(directoryId, "Workspace directory ID"),
        normalizedLimit,
      );
    },
  );

  // 修改远程目录的连接（登录信息 / 端口 / 远程目录）：走 relink 迁移，
  // 让会话、记忆、草稿等数据跟随新的 directory_id 一起搬家。
  ipcMain.handle(
    "workspace-directories:update-ssh-connection",
    async (_event, directoryId: unknown, sshUrl: unknown) => {
      const sourceId = requireText(directoryId, "Workspace directory ID");
      const targetUrl = requireText(sshUrl, "SSH connection URL");
      if (!targetUrl.startsWith("ssh://")) {
        throw new Error("SSH connection URL must start with ssh://");
      }

      const existing = (await native.listWorkspaceDirectories()).find(
        (directory) => directory.directoryId === sourceId,
      );
      if (!existing || existing.kind !== "ssh") {
        throw new Error("Only SSH workspace directories can be edited");
      }
      // 提前解析一次：无效 URL 在写库前就报错，避免迁移出半成品目录。
      parseSshUrl(targetUrl);

      const report = await native.relinkWorkspaceDirectory(
        sourceId,
        targetUrl,
        false,
      );

      // 旧连接的 profile 与可能复用的新 profile 都必须丢弃缓存参数，
      // 否则仍会拿旧凭据/旧地址重连。
      for (const path of [existing.path, targetUrl]) {
        try {
          sshConnectionManager.invalidate(getSshWorkspaceProfileId(path));
        } catch {
          // 路径无法解析成 profile 时无需处理
        }
      }

      const directories = await native.listWorkspaceDirectories();

      // 登录身份变化后清理旧凭据；仍被其他目录引用时保留。
      try {
        const previous = parseSshUrl(existing.path);
        const next = parseSshUrl(targetUrl);
        const previousKey = `${previous.username}@${previous.host}:${previous.port}`;
        const nextKey = `${next.username}@${next.host}:${next.port}`;
        if (previousKey !== nextKey) {
          const stillReferenced = directories.some((directory) => {
            if (
              directory.kind !== "ssh" ||
              directory.directoryId === sourceId
            ) {
              return false;
            }
            try {
              const parsed = parseSshUrl(directory.path);
              return (
                `${parsed.username}@${parsed.host}:${parsed.port}` ===
                previousKey
              );
            } catch {
              return false;
            }
          });
          if (!stillReferenced) {
            deleteSshCredential(
              previous.host,
              previous.port,
              previous.username,
            );
          }
        }
      } catch {
        // 解析失败时保留原凭据，避免误删
      }

      broadcastDirectoryListChanged();
      return { report, directories };
    },
  );

  ipcMain.handle("project-collections:list", () =>
    native.listProjectCollections(),
  );
  ipcMain.handle(
    "project-collections:create",
    async (_event, name: unknown, memberDirectoryIds: unknown) => {
      await native.createProjectCollection(
        requireText(name, "Collection name"),
        memberDirectoryIds === undefined
          ? []
          : requireDirectoryIdList(memberDirectoryIds),
      );
      const collections = await native.listProjectCollections();
      broadcastDirectoryListChanged();
      return collections;
    },
  );
  ipcMain.handle(
    "project-collections:update-color",
    async (_event, collectionId: unknown, color: unknown) => {
      await native.updateProjectCollectionColor(
        requireText(collectionId, "Collection ID"),
        requireText(color, "Collection color"),
      );
      const collections = await native.listProjectCollections();
      broadcastDirectoryListChanged();
      return collections;
    },
  );
  ipcMain.handle(
    "project-collections:set-member-linked",
    async (
      _event,
      collectionId: unknown,
      directoryId: unknown,
      linked: unknown,
    ) => {
      await native.setProjectCollectionMemberLinked(
        requireText(collectionId, "Collection ID"),
        requireText(directoryId, "Workspace directory ID"),
        linked === true,
      );
      const collections = await native.listProjectCollections();
      broadcastDirectoryListChanged();
      return collections;
    },
  );
  ipcMain.handle(
    "project-collections:rename",
    async (_event, collectionId: unknown, name: unknown) => {
      await native.renameProjectCollection(
        requireText(collectionId, "Collection ID"),
        requireText(name, "Collection name"),
      );
      const collections = await native.listProjectCollections();
      broadcastDirectoryListChanged();
      return collections;
    },
  );
  ipcMain.handle(
    "project-collections:delete",
    async (_event, collectionId: unknown) => {
      await native.deleteProjectCollection(
        requireText(collectionId, "Collection ID"),
      );
      const collections = await native.listProjectCollections();
      broadcastDirectoryListChanged();
      return collections;
    },
  );
  ipcMain.handle(
    "project-collections:reorder-members",
    async (_event, collectionId: unknown, orderedMemberIds: unknown) => {
      await native.reorderProjectCollectionMembers(
        requireText(collectionId, "Collection ID"),
        requireDirectoryIdList(orderedMemberIds),
      );
      const collections = await native.listProjectCollections();
      broadcastDirectoryListChanged();
      return collections;
    },
  );
  ipcMain.handle(
    "project-collections:reorder",
    async (_event, orderedCollectionIds: unknown) => {
      await native.reorderProjectCollections(
        requireDirectoryIdList(orderedCollectionIds),
      );
      const collections = await native.listProjectCollections();
      broadcastDirectoryListChanged();
      return collections;
    },
  );
  ipcMain.handle(
    "project-collections:move-member",
    async (
      _event,
      collectionId: unknown,
      directoryId: unknown,
      orderedMemberIds: unknown,
    ) => {
      await native.moveProjectToCollection(
        requireText(collectionId, "Collection ID"),
        requireText(directoryId, "Workspace directory ID"),
        requireDirectoryIdList(orderedMemberIds),
      );
      const collections = await native.listProjectCollections();
      broadcastDirectoryListChanged();
      return collections;
    },
  );
  ipcMain.handle(
    "project-collections:remove-member-from-all",
    async (_event, directoryId: unknown) => {
      await native.removeProjectFromAllCollections(
        requireText(directoryId, "Workspace directory ID"),
      );
      const collections = await native.listProjectCollections();
      broadcastDirectoryListChanged();
      return collections;
    },
  );
  ipcMain.handle(
    "project-collections:remove-member",
    async (_event, collectionId: unknown, directoryId: unknown) => {
      await native.removeProjectFromCollection(
        requireText(collectionId, "Collection ID"),
        requireText(directoryId, "Workspace directory ID"),
      );
      const collections = await native.listProjectCollections();
      broadcastDirectoryListChanged();
      return collections;
    },
  );
  ipcMain.handle(
    "workspace-directories:select-local-directory",
    async (event, dialogTitle: unknown) => {
      const browserWindow = BrowserWindow.fromWebContents(event.sender);
      const title =
        typeof dialogTitle === "string" && dialogTitle.trim()
          ? dialogTitle.trim()
          : "Select workspace directory";
      const options: Electron.OpenDialogOptions = {
        title,
        properties: withPackageAsDirectory(["openDirectory"]),
      };
      const result = browserWindow
        ? await dialog.showOpenDialog(browserWindow, options)
        : await dialog.showOpenDialog(options);

      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
  );
  ipcMain.handle(
    "workspace-directories:create-project",
    async (_event, parentPath: unknown, projectName: unknown) => {
      if (typeof parentPath !== "string" || !parentPath.trim()) {
        throw new Error("Parent directory path is required");
      }
      if (typeof projectName !== "string" || !projectName.trim()) {
        throw new Error("Project name is required");
      }

      // 在 Rust 后端创建项目目录，随后作为活动本地工作区目录持久化。
      const createdPath = await native.createProjectDirectory(
        parentPath.trim(),
        projectName.trim(),
      );
      const existingCount = (await native.listWorkspaceDirectories()).length;
      await native.upsertWorkspaceDirectory(
        createWorkspaceDirectoryInput(createdPath, "local", existingCount),
      );
      const directories = await native.listWorkspaceDirectories();
      broadcastDirectoryListChanged();
      return directories;
    },
  );
  ipcMain.handle(
    "workspace-directories:clone-repository",
    async (event, repoUrl: unknown, parentPath: unknown, streamId: unknown) => {
      if (typeof repoUrl !== "string" || !repoUrl.trim()) {
        throw new Error("Repository URL is required");
      }
      if (typeof parentPath !== "string" || !parentPath.trim()) {
        throw new Error("Parent directory is required");
      }
      if (typeof streamId !== "string" || !streamId.trim()) {
        throw new Error("Clone progress stream ID is required");
      }

      const normalizedStreamId = streamId.trim();
      // 克隆由 Rust 后端以 tokio 异步子进程执行（不阻塞主进程），
      // 按 git 惯例在所选目录下以项目名新建子目录进行克隆，进度行
      // 通过广播通道实时推送给发起窗口。克隆运行期间可用
      // "workspace-directories:clone-repository:cancel" 以同一个 streamId
      // 中止（Rust 侧杀掉进程树并清理半成品目录）。克隆成功后把实际
      // 克隆目录登记为活动本地工作区目录。
      const clonedPath = await native.cloneGitRepository(
        repoUrl.trim(),
        parentPath.trim(),
        (chunk: GitCloneProgress) => {
          safeSend(event.sender, CLONE_PROGRESS_CHANNEL, {
            streamId: normalizedStreamId,
            chunk,
          });
        },
        normalizedStreamId,
      );
      const existingCount = (await native.listWorkspaceDirectories()).length;
      await native.upsertWorkspaceDirectory(
        createWorkspaceDirectoryInput(clonedPath, "local", existingCount),
      );
      const directories = await native.listWorkspaceDirectories();
      broadcastDirectoryListChanged();
      return directories;
    },
  );
  ipcMain.handle(
    "workspace-directories:clone-repository:cancel",
    async (_event, streamId: unknown) => {
      if (typeof streamId !== "string" || !streamId.trim()) {
        throw new Error("Clone progress stream ID is required");
      }

      // 取消请求交给 Rust 后端处理：命中在跑的任务时杀进程树 + 清理
      // 半成品目录；任务已结束则返回 false（调用方无需额外处理）。
      return native.cancelGitClone(streamId.trim());
    },
  );

  // ===== Directory entries / watch / search =====
  ipcMain.handle(
    "workspace-directories:read-entries",
    (_event, dirPath: unknown) => {
      if (typeof dirPath !== "string" || !dirPath.trim()) {
        throw new Error("Directory path is required");
      }

      return native.readDirectoryEntries(dirPath.trim());
    },
  );

  ipcMain.handle(
    "workspace-directories:rename-entry",
    (_event, rootPath: unknown, entryPath: unknown, newName: unknown) => {
      if (typeof rootPath !== "string" || !rootPath.trim()) {
        throw new Error("Workspace root path is required");
      }
      if (typeof entryPath !== "string" || !entryPath.trim()) {
        throw new Error("Workspace entry path is required");
      }
      if (typeof newName !== "string" || !newName.trim()) {
        throw new Error("Workspace entry name is required");
      }

      return native.renameWorkspaceEntry(
        rootPath.trim(),
        entryPath.trim(),
        newName.trim(),
      );
    },
  );

  ipcMain.handle(
    "workspace-directories:delete-entry",
    (_event, rootPath: unknown, entryPath: unknown) => {
      if (typeof rootPath !== "string" || !rootPath.trim()) {
        throw new Error("Workspace root path is required");
      }
      if (typeof entryPath !== "string" || !entryPath.trim()) {
        throw new Error("Workspace entry path is required");
      }

      return native.deleteWorkspaceEntry(rootPath.trim(), entryPath.trim());
    },
  );

  ipcMain.handle(
    "workspace-directories:delete-entries",
    (_event, rootPath: unknown, entryPaths: unknown) => {
      if (typeof rootPath !== "string" || !rootPath.trim()) {
        throw new Error("Workspace root path is required");
      }
      if (
        !Array.isArray(entryPaths) ||
        entryPaths.length === 0 ||
        !entryPaths.every((p) => typeof p === "string" && p.trim().length > 0)
      ) {
        throw new Error("Workspace entry paths are required");
      }

      return native.deleteWorkspaceEntries(
        rootPath.trim(),
        entryPaths.map((p) => (p as string).trim()),
      );
    },
  );

  ipcMain.handle(
    "workspace-directories:copy-files-into",
    (
      _event,
      rootPath: unknown,
      targetDir: unknown,
      sourcePaths: unknown,
      replaceExisting: unknown,
    ) => {
      if (typeof rootPath !== "string" || !rootPath.trim()) {
        throw new Error("Workspace root path is required");
      }
      if (typeof targetDir !== "string" || !targetDir.trim()) {
        throw new Error("Upload target directory is required");
      }
      if (
        !Array.isArray(sourcePaths) ||
        sourcePaths.length === 0 ||
        !sourcePaths.every((p) => typeof p === "string" && p.trim().length > 0)
      ) {
        throw new Error("Source file paths are required");
      }

      return native.copyFilesIntoDirectory(
        rootPath.trim(),
        targetDir.trim(),
        sourcePaths.map((p) => (p as string).trim()),
        replaceExisting === true,
      );
    },
  );

  ipcMain.handle(
    "workspace-directories:read-file",
    (_event, filePath: unknown) => {
      if (typeof filePath !== "string" || !filePath.trim()) {
        throw new Error("File path is required");
      }
      return native.readFileContent(filePath.trim());
    },
  );

  ipcMain.handle(
    "workspace-directories:read-file-preview",
    (_event, filePath: unknown, section: unknown) => {
      if (typeof filePath !== "string" || !filePath.trim()) {
        throw new Error("File path is required");
      }
      return native.readFilePreview(
        filePath.trim(),
        typeof section === "string" && section ? section : null,
      );
    },
  );

  ipcMain.handle(
    "workspace-directories:write-file",
    (_event, filePath: unknown, content: unknown) => {
      if (typeof filePath !== "string" || !filePath.trim()) {
        throw new Error("File path is required");
      }
      if (typeof content !== "string") {
        throw new Error("File content must be a string");
      }
      return native.writeFileContent(filePath.trim(), content);
    },
  );

  ipcMain.handle(
    "workspace-directories:resolve-file-link",
    (_event, rootDir: unknown, rawPath: unknown) => {
      if (typeof rawPath !== "string" || !rawPath.trim()) {
        throw new Error("File path is required");
      }
      const root =
        typeof rootDir === "string" && rootDir.trim() ? rootDir.trim() : null;
      return native.resolveFileLink(root, rawPath.trim());
    },
  );

  ipcMain.handle(
    "workspace-directories:start-watch",
    (_event, dirPath: unknown) => {
      if (typeof dirPath !== "string" || !dirPath.trim()) {
        throw new Error("Directory path is required");
      }

      startDirectoryWatch(dirPath.trim());
    },
  );

  ipcMain.handle(
    "workspace-directories:stop-watch",
    (_event, dirPath: unknown) => {
      if (typeof dirPath !== "string" || !dirPath.trim()) {
        throw new Error("Directory path is required");
      }

      stopDirectoryWatch(dirPath.trim());
    },
  );

  // 单文件监听（文件阅读器自动刷新）：本地文件走 Rust notify，不轮询。
  ipcMain.handle(
    "workspace-directories:start-file-watch",
    (event, filePath: unknown) => {
      if (typeof filePath !== "string" || !filePath.trim()) {
        throw new Error("File path is required");
      }

      startFileWatch(native, event.sender, filePath.trim());
    },
  );

  ipcMain.handle(
    "workspace-directories:stop-file-watch",
    (event, filePath: unknown) => {
      if (typeof filePath !== "string" || !filePath.trim()) {
        throw new Error("File path is required");
      }

      stopFileWatch(native, event.sender, filePath.trim());
    },
  );

  ipcMain.handle(
    "workspace-directories:search-files",
    (_event, dirPath: unknown, query: unknown, linked: unknown) => {
      if (typeof dirPath !== "string" || !dirPath.trim()) {
        throw new Error("Directory path is required");
      }
      if (typeof query !== "string" || !query.trim()) {
        return [];
      }

      return native.searchFiles(
        dirPath.trim(),
        query.trim(),
        typeof linked === "boolean" ? linked : undefined,
      );
    },
  );

  ipcMain.handle(
    "workspace-directories:search-file-contents",
    (_event, dirPath: unknown, query: unknown, linked: unknown) => {
      if (typeof dirPath !== "string" || !dirPath.trim()) {
        throw new Error("Directory path is required");
      }
      if (typeof query !== "string" || !query.trim()) {
        return [];
      }

      return native.searchFileContents(
        dirPath.trim(),
        query.trim(),
        typeof linked === "boolean" ? linked : undefined,
      );
    },
  );

  ipcMain.handle(
    "workspace-directories:search-files-by-agent",
    (
      event,
      query: unknown,
      workspacePath: unknown,
      streamId: unknown,
      linked: unknown,
    ) => {
      if (typeof query !== "string" || !query.trim()) {
        return [];
      }
      if (typeof workspacePath !== "string" || !workspacePath.trim()) {
        return [];
      }
      if (typeof streamId !== "string" || !streamId.trim()) {
        throw new Error("Agent search stream ID is required");
      }

      const normalizedStreamId = streamId.trim();
      return native.searchFilesByAgent(
        query.trim(),
        workspacePath.trim(),
        (chunk: FileSearchAgentProgress) => {
          safeSend(event.sender, AGENT_SEARCH_PROGRESS_CHANNEL, {
            streamId: normalizedStreamId,
            chunk,
          });
        },
        typeof linked === "boolean" ? linked : undefined,
      );
    },
  );

  // ===== File picker dialogs (multi-select) =====
  // Windows 原生对话框不支持在 openFile + openDirectory 混合模式下
  // 同时多选文件与文件夹（实际只呈现文件夹视图），因此拆分为
  // 独立的文件选择与文件夹选择两个入口，保证文案与行为一致。
  const showPickDialog = async (
    event: Electron.IpcMainInvokeEvent,
    dialogTitle: unknown,
    properties: Electron.OpenDialogOptions["properties"],
    fallbackTitle: string,
  ): Promise<{ path: string; isDirectory: boolean }[] | null> => {
    const browserWindow = BrowserWindow.fromWebContents(event.sender);
    const title =
      typeof dialogTitle === "string" && dialogTitle.trim()
        ? dialogTitle.trim()
        : fallbackTitle;
    const options: Electron.OpenDialogOptions = {
      title,
      properties,
    };
    const result = browserWindow
      ? await dialog.showOpenDialog(browserWindow, options)
      : await dialog.showOpenDialog(options);

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    const entries = await Promise.all(
      result.filePaths.map(async (path) => {
        try {
          const stat = await fs.stat(path);
          return { path, isDirectory: stat.isDirectory() };
        } catch {
          return { path, isDirectory: false };
        }
      }),
    );

    return entries;
  };

  ipcMain.handle(
    "workspace-directories:select-files",
    (event, dialogTitle: unknown) =>
      showPickDialog(
        event,
        dialogTitle,
        ["openFile", "multiSelections"],
        "Select files",
      ),
  );

  ipcMain.handle(
    "workspace-directories:select-directories",
    (event, dialogTitle: unknown) =>
      showPickDialog(
        event,
        dialogTitle,
        withPackageAsDirectory(["openDirectory", "multiSelections"]),
        "Select folders",
      ),
  );

  // ===== Resolve dropped external file paths =====
  // 从文件管理器拖入的外部文件，preload 已通过 webUtils.getPathForFile
  // 解析为绝对路径；主进程在此异步批量查询每个路径是否为目录，
  // 返回统一结构供渲染层生成文件/图片 chip。全部异步，不阻塞主进程。
  ipcMain.handle(
    "workspace-directories:resolve-dropped-paths",
    async (_event, paths: unknown) => {
      if (!Array.isArray(paths)) {
        return [];
      }
      const safePaths = paths.filter(
        (p): p is string => typeof p === "string" && p.length > 0,
      );
      const entries = await Promise.all(
        safePaths.map(async (path) => {
          try {
            const stat = await fs.stat(path);
            return { path, isDirectory: stat.isDirectory() };
          } catch {
            return { path, isDirectory: false };
          }
        }),
      );
      return entries;
    },
  );

  // ===== Dialog handlers (browser executable, terminal executable) =====
  ipcMain.handle(
    "proxy-browser-settings:select-browser-executable",
    async (event, dialogTitle: unknown) => {
      const browserWindow = BrowserWindow.fromWebContents(event.sender);
      const title =
        typeof dialogTitle === "string" && dialogTitle.trim()
          ? dialogTitle.trim()
          : "Select browser executable";
      const options: Electron.OpenDialogOptions = {
        title,
        properties: ["openFile"],
        filters:
          process.platform === "win32"
            ? [
                { name: "Applications", extensions: ["exe"] },
                { name: "All files", extensions: ["*"] },
              ]
            : [{ name: "All files", extensions: ["*"] }],
      };
      const result = browserWindow
        ? await dialog.showOpenDialog(browserWindow, options)
        : await dialog.showOpenDialog(options);

      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
  );
  ipcMain.handle(
    "terminal-settings:validate-shell-path",
    async (_event, shellPath: unknown) => {
      const path = typeof shellPath === "string" ? shellPath.trim() : "";
      if (!path) {
        return { valid: true };
      }
      // 纯文件名（如 wsl.exe / bash）交由运行时按 PATH 解析，此处无法确认；
      // 含路径分隔符的路径（绝对或相对）必须真实存在。
      const hasSeparator = path.includes("/") || path.includes("\\");
      if (!hasSeparator) {
        return { valid: true };
      }
      try {
        await fs.access(path);
        return { valid: true };
      } catch {
        return { valid: false, reason: `Shell executable not found: ${path}` };
      }
    },
  );
  ipcMain.handle(
    "terminal-settings:select-executable",
    async (event, dialogTitle: unknown) => {
      const browserWindow = BrowserWindow.fromWebContents(event.sender);
      const title =
        typeof dialogTitle === "string" && dialogTitle.trim()
          ? dialogTitle.trim()
          : "Select terminal executable";
      const options: Electron.OpenDialogOptions = {
        title,
        properties: ["openFile"],
        filters:
          process.platform === "win32"
            ? [
                { name: "Applications", extensions: ["exe", "bat", "cmd"] },
                { name: "All files", extensions: ["*"] },
              ]
            : [{ name: "All files", extensions: ["*"] }],
      };
      const result = browserWindow
        ? await dialog.showOpenDialog(browserWindow, options)
        : await dialog.showOpenDialog(options);

      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
  );
  ipcMain.handle(
    "theme:select-background-images",
    async (event, dialogTitle: unknown) => {
      const browserWindow = BrowserWindow.fromWebContents(event.sender);
      const title =
        typeof dialogTitle === "string" && dialogTitle.trim()
          ? dialogTitle.trim()
          : "Select background images";
      const options: Electron.OpenDialogOptions = {
        title,
        properties: ["openFile", "multiSelections"],
        filters: [
          {
            name: "Images",
            extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"],
          },
          { name: "All files", extensions: ["*"] },
        ],
      };
      const result = browserWindow
        ? await dialog.showOpenDialog(browserWindow, options)
        : await dialog.showOpenDialog(options);

      return result.canceled ? [] : result.filePaths;
    },
  );
  /**
   * 列出受管背景图目录（~/.snowapp/backgrounds/）中的历史图片，
   * 按修改时间倒序返回，供「历史图片」弹窗重新加入列表或清理文件。
   */
  ipcMain.handle("theme:list-background-images", async () => {
    const backgroundsDir = join(homedir(), ".snowapp", "backgrounds");
    const allowedExtensions = new Set([
      "png",
      "jpg",
      "jpeg",
      "gif",
      "webp",
      "bmp",
      "svg",
    ]);
    const entries = await fs
      .readdir(backgroundsDir, { withFileTypes: true })
      .catch(() => null);
    if (!entries) {
      // 目录不存在（尚未使用过背景图）时返回空列表。
      return [];
    }
    const items: {
      path: string;
      fileName: string;
      modifiedAt: number;
      size: number;
    }[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      const extension = extname(entry.name).slice(1).toLowerCase();
      if (!allowedExtensions.has(extension)) {
        continue;
      }
      const fullPath = join(backgroundsDir, entry.name);
      try {
        const stat = await fs.stat(fullPath);
        items.push({
          path: fullPath,
          fileName: entry.name,
          modifiedAt: stat.mtimeMs,
          size: stat.size,
        });
      } catch {
        // 单个文件读取失败时跳过，不影响其余列表。
      }
    }
    items.sort((a, b) => b.modifiedAt - a.modifiedAt);
    return items;
  });
  ipcMain.handle(
    "theme:select-stream-cursor-svg",
    async (event, dialogTitle: unknown) => {
      const browserWindow = BrowserWindow.fromWebContents(event.sender);
      const title =
        typeof dialogTitle === "string" && dialogTitle.trim()
          ? dialogTitle.trim()
          : "Select stream cursor SVG";
      const options: Electron.OpenDialogOptions = {
        title,
        properties: ["openFile"],
        filters: [
          { name: "SVG", extensions: ["svg"] },
          { name: "All files", extensions: ["*"] },
        ],
      };
      const result = browserWindow
        ? await dialog.showOpenDialog(browserWindow, options)
        : await dialog.showOpenDialog(options);

      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
  );
  ipcMain.handle(
    "theme:select-stream-cursor-image",
    async (event, dialogTitle: unknown) => {
      const browserWindow = BrowserWindow.fromWebContents(event.sender);
      const title =
        typeof dialogTitle === "string" && dialogTitle.trim()
          ? dialogTitle.trim()
          : "Select stream cursor image";
      const options: Electron.OpenDialogOptions = {
        title,
        properties: ["openFile"],
        filters: [
          {
            name: "Images",
            extensions: [
              "gif",
              "png",
              "apng",
              "webp",
              "jpg",
              "jpeg",
              "avif",
              "bmp",
              "svg",
              "ico",
            ],
          },
          { name: "All files", extensions: ["*"] },
        ],
      };
      const result = browserWindow
        ? await dialog.showOpenDialog(browserWindow, options)
        : await dialog.showOpenDialog(options);

      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
  );
  ipcMain.handle(
    "theme:select-stream-cursor-script",
    async (event, dialogTitle: unknown) => {
      const browserWindow = BrowserWindow.fromWebContents(event.sender);
      const title =
        typeof dialogTitle === "string" && dialogTitle.trim()
          ? dialogTitle.trim()
          : "Select stream cursor script";
      const options: Electron.OpenDialogOptions = {
        title,
        properties: ["openFile"],
        filters: [
          { name: "JavaScript", extensions: ["js", "mjs"] },
          { name: "All files", extensions: ["*"] },
        ],
      };
      const result = browserWindow
        ? await dialog.showOpenDialog(browserWindow, options)
        : await dialog.showOpenDialog(options);

      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
  );
};

/**
 * 启动体检：批量校验全部项目路径后广播刷新。
 * 目录在应用外被移动后，不点开项目也能在侧边栏看到失效徽章。
 */
export const refreshWorkspaceDirectoryHealth = async (
  native: NativeBridge,
): Promise<void> => {
  await native.verifyAllWorkspaceDirectories();
  broadcastDirectoryListChanged();
};
