import { BrowserWindow, dialog, ipcMain } from "electron";
import { readFile } from "node:fs/promises";
import type { NativeBridge, RepoWikiEvent } from "../../native/types";
import { safeSend } from "../../utils/safeSend";

const REPO_WIKI_EVENT_CHANNEL = "repo-wiki:event";

const projectBaseName = (path: string): string =>
  path.split(/[\\/]/).filter(Boolean).pop() || "repo";

const dialogWindow = (
  event: Electron.IpcMainInvokeEvent,
): BrowserWindow | null => BrowserWindow.fromWebContents(event.sender);

const requirePath = (value: unknown): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Project path is required");
  }
  return value.trim();
};

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const normalizeRetries = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(5, Math.max(0, Math.floor(value)))
    : 0;

export const registerRepoWikiHandlers = (native: NativeBridge): void => {
  // Rust 任务事件广播到所有窗口
  native.setRepoWikiEventHandler((event: RepoWikiEvent) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && window.webContents) {
        safeSend(window.webContents, REPO_WIKI_EVENT_CHANNEL, event);
      }
    }
  });

  ipcMain.handle("repo-wiki:load", async (_event, projectPath: unknown) => {
    const raw = await native.repoWikiLoad(requirePath(projectPath));
    return raw ? (JSON.parse(raw) as unknown) : null;
  });

  ipcMain.handle("repo-wiki:start", (_event, options: unknown) => {
    const record = (options ?? {}) as Record<string, unknown>;
    return native.repoWikiStart({
      projectPath: requirePath(record.projectPath),
      projectName: optionalString(record.projectName),
      language: record.language === "en" ? "en" : "zh-CN",
      apiProfile: optionalString(record.apiProfile),
      model: optionalString(record.model),
      diagrams: record.diagrams !== false,
      retries: normalizeRetries(record.retries),
    });
  });

  ipcMain.handle("repo-wiki:update-settings", (_event, options: unknown) => {
    const record = (options ?? {}) as Record<string, unknown>;
    return native.repoWikiUpdateSettings({
      projectPath: requirePath(record.projectPath),
      language: record.language === "en" ? "en" : "zh-CN",
      apiProfile: optionalString(record.apiProfile),
      model: optionalString(record.model),
      diagrams: record.diagrams !== false,
      retries: normalizeRetries(record.retries),
    });
  });

  ipcMain.handle("repo-wiki:stop", async (_event, projectPath: unknown) =>
    native.repoWikiStop(requirePath(projectPath)),
  );

  ipcMain.handle("repo-wiki:pause", (_event, projectPath: unknown) =>
    native.repoWikiPause(requirePath(projectPath)),
  );

  ipcMain.handle("repo-wiki:resume", (_event, projectPath: unknown) =>
    native.repoWikiResume(requirePath(projectPath)),
  );

  ipcMain.handle(
    "repo-wiki:retry-page",
    (_event, projectPath: unknown, pageId: unknown) => {
      if (typeof pageId !== "string" || !pageId.trim()) {
        throw new Error("Wiki page id is required");
      }
      return native.repoWikiRetryPage(requirePath(projectPath), pageId.trim());
    },
  );

  ipcMain.handle(
    "repo-wiki:export",
    async (event, projectPath: unknown, projectName: unknown) => {
      const path = requirePath(projectPath);
      const name = optionalString(projectName) ?? projectBaseName(path);
      const options: Electron.SaveDialogOptions = {
        title: "Export Repo Wiki",
        defaultPath: `${name}-wiki-${new Date().toISOString().slice(0, 10)}.zip`,
        filters: [{ name: "Markdown archive", extensions: ["zip"] }],
      };
      const window = dialogWindow(event);
      const result = window
        ? await dialog.showSaveDialog(window, options)
        : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) {
        return { canceled: true, filePath: "", pageCount: 0 };
      }
      const pageCount = await native.repoWikiExport(path, result.filePath);
      return { canceled: false, filePath: result.filePath, pageCount };
    },
  );

  ipcMain.handle("repo-wiki:import", async (event, projectPath: unknown) => {
    const path = requirePath(projectPath);
    const options: Electron.OpenDialogOptions = {
      title: "Import Repo Wiki",
      properties: ["openFile"],
      filters: [{ name: "Wiki JSON", extensions: ["json"] }],
    };
    const window = dialogWindow(event);
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    const filePath = result.filePaths?.[0];
    if (result.canceled || !filePath) {
      return { canceled: true, filePath: "", pageCount: 0 };
    }
    const json = await readFile(filePath, "utf-8");
    const pageCount = await native.repoWikiImport(path, json);
    return { canceled: false, filePath, pageCount };
  });

  ipcMain.handle("repo-wiki:delete", (_event, projectPath: unknown) =>
    native.repoWikiDelete(requirePath(projectPath)),
  );

  ipcMain.handle(
    "repo-wiki:set-auto-refresh",
    (_event, projectPath: unknown, enabled: unknown) =>
      native.repoWikiSetAutoRefresh(requirePath(projectPath), enabled === true),
  );

  ipcMain.handle(
    "repo-wiki:notify-turn-ended",
    (_event, projectPath: unknown) => {
      if (typeof projectPath !== "string" || !projectPath.trim()) {
        return false;
      }
      return native.repoWikiNotifyTurnEnded(projectPath.trim());
    },
  );

  ipcMain.handle("repo-wiki:file-path", async (_event, projectPath: unknown) =>
    native.repoWikiFilePath(requirePath(projectPath)),
  );
};
