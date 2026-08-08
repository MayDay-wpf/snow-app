import { BrowserWindow, dialog, ipcMain } from "electron";
import { promises as fs } from "fs";
import type {
  FileSearchAgentProgress,
  NativeBridge,
} from "../../native/types";
import {
  createWorkspaceDirectoryInput,
  normalizeWorkspaceDirectory,
  normalizeWorkspaceDirectoryList,
} from "../../settings/workspaceDirectories";
import { startDirectoryWatch, stopDirectoryWatch } from "../../utils/fsWatcher";
import { safeSend } from "../../utils/safeSend";

const AGENT_SEARCH_PROGRESS_CHANNEL =
  "workspace-directories:search-files-by-agent:progress";

const broadcastDirectoryListChanged = (): void => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && window.webContents) {
      safeSend(window.webContents, "workspace-directory-list:changed");
    }
  }
};

export const registerWorkspaceHandlers = (native: NativeBridge): void => {
  ipcMain.handle("workspace-directories:list", () =>
    native.listWorkspaceDirectories()
  );
  ipcMain.handle(
    "workspace-directories:upsert",
    async (_event, item: unknown) => {
      const existingCount = (await native.listWorkspaceDirectories()).length;
      await native.upsertWorkspaceDirectory(
        normalizeWorkspaceDirectory(item, existingCount)
      );
      const directories = await native.listWorkspaceDirectories();
      broadcastDirectoryListChanged();
      return directories;
    }
  );
  ipcMain.handle(
    "workspace-directories:activate",
    async (_event, directoryId: unknown) => {
      if (typeof directoryId !== "string" || !directoryId.trim()) {
        throw new Error("Workspace directory ID is required");
      }

      await native.activateWorkspaceDirectory(directoryId.trim());
      const directories = await native.listWorkspaceDirectories();
      broadcastDirectoryListChanged();
      return directories;
    }
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
    }
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
    }
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
        properties: ["openDirectory"],
      };
      const result = browserWindow
        ? await dialog.showOpenDialog(browserWindow, options)
        : await dialog.showOpenDialog(options);

      return result.canceled ? null : result.filePaths[0] ?? null;
    }
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
        projectName.trim()
      );
      const existingCount = (await native.listWorkspaceDirectories()).length;
      await native.upsertWorkspaceDirectory(
        createWorkspaceDirectoryInput(createdPath, "local", existingCount)
      );
      const directories = await native.listWorkspaceDirectories();
      broadcastDirectoryListChanged();
      return directories;
    }
  );

  // ===== Directory entries / watch / search =====
  ipcMain.handle(
    "workspace-directories:read-entries",
    (_event, dirPath: unknown) => {
      if (typeof dirPath !== "string" || !dirPath.trim()) {
        throw new Error("Directory path is required");
      }

      return native.readDirectoryEntries(dirPath.trim());
    }
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
        newName.trim()
      );
    }
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
    }
  );

  ipcMain.handle(
    "workspace-directories:read-file",
    (_event, filePath: unknown) => {
      if (typeof filePath !== "string" || !filePath.trim()) {
        throw new Error("File path is required");
      }
      return native.readFileContent(filePath.trim());
    }
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
    }
  );

  ipcMain.handle(
    "workspace-directories:start-watch",
    (_event, dirPath: unknown) => {
      if (typeof dirPath !== "string" || !dirPath.trim()) {
        throw new Error("Directory path is required");
      }

      startDirectoryWatch(dirPath.trim());
    }
  );

  ipcMain.handle(
    "workspace-directories:stop-watch",
    (_event, dirPath: unknown) => {
      if (typeof dirPath !== "string" || !dirPath.trim()) {
        throw new Error("Directory path is required");
      }

      stopDirectoryWatch(dirPath.trim());
    }
  );

  ipcMain.handle(
    "workspace-directories:search-files",
    (_event, dirPath: unknown, query: unknown) => {
      if (typeof dirPath !== "string" || !dirPath.trim()) {
        throw new Error("Directory path is required");
      }
      if (typeof query !== "string" || !query.trim()) {
        return [];
      }

      return native.searchFiles(dirPath.trim(), query.trim());
    }
  );

  ipcMain.handle(
    "workspace-directories:search-files-by-agent",
    (event, query: unknown, workspacePath: unknown, streamId: unknown) => {
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
        }
      );
    }
  );

  // ===== File picker dialogs (multi-select) =====
  // Windows 原生对话框不支持在 openFile + openDirectory 混合模式下
  // 同时多选文件与文件夹（实际只呈现文件夹视图），因此拆分为
  // 独立的文件选择与文件夹选择两个入口，保证文案与行为一致。
  const showPickDialog = async (
    event: Electron.IpcMainInvokeEvent,
    dialogTitle: unknown,
    properties: Array<"openFile" | "openDirectory" | "multiSelections">,
    fallbackTitle: string
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
      })
    );

    return entries;
  };

  ipcMain.handle(
    "workspace-directories:select-files",
    (event, dialogTitle: unknown) =>
      showPickDialog(event, dialogTitle, ["openFile", "multiSelections"], "Select files")
  );

  ipcMain.handle(
    "workspace-directories:select-directories",
    (event, dialogTitle: unknown) =>
      showPickDialog(
        event,
        dialogTitle,
        ["openDirectory", "multiSelections"],
        "Select folders"
      )
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
        (p): p is string => typeof p === "string" && p.length > 0
      );
      const entries = await Promise.all(
        safePaths.map(async (path) => {
          try {
            const stat = await fs.stat(path);
            return { path, isDirectory: stat.isDirectory() };
          } catch {
            return { path, isDirectory: false };
          }
        })
      );
      return entries;
    }
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

      return result.canceled ? null : result.filePaths[0] ?? null;
    }
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
    }
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

      return result.canceled ? null : result.filePaths[0] ?? null;
    }
  );
  ipcMain.handle(
    "theme:select-background-image",
    async (event, dialogTitle: unknown) => {
      const browserWindow = BrowserWindow.fromWebContents(event.sender);
      const title =
        typeof dialogTitle === "string" && dialogTitle.trim()
          ? dialogTitle.trim()
          : "Select background image";
      const options: Electron.OpenDialogOptions = {
        title,
        properties: ["openFile"],
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

      return result.canceled ? null : result.filePaths[0] ?? null;
    }
  );
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

      return result.canceled ? null : result.filePaths[0] ?? null;
    }
  );
};
