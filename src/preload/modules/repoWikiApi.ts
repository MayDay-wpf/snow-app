import { ipcRenderer } from "electron";
import type {
  RepoWikiEvent,
  RepoWikiRecord,
  RepoWikiSettingsOptions,
  RepoWikiStartOptions,
} from "../types";

const REPO_WIKI_EVENT_CHANNEL = "repo-wiki:event";

const eventSubscribers = new Set<(event: RepoWikiEvent) => void>();
let eventListenerRegistered = false;

const ensureEventListener = (): void => {
  if (eventListenerRegistered) {
    return;
  }
  eventListenerRegistered = true;
  ipcRenderer.on(REPO_WIKI_EVENT_CHANNEL, (_event, payload: unknown) => {
    if (!payload || typeof payload !== "object") {
      return;
    }
    for (const callback of eventSubscribers) {
      callback(payload as RepoWikiEvent);
    }
  });
};

export type RepoWikiTransferResult = {
  canceled: boolean;
  filePath: string;
  pageCount: number;
};

export const repoWikiApi = {
  repoWikiLoad: (projectPath: string): Promise<RepoWikiRecord | null> =>
    ipcRenderer.invoke("repo-wiki:load", projectPath),
  repoWikiStart: (options: RepoWikiStartOptions): Promise<void> =>
    ipcRenderer.invoke("repo-wiki:start", options),
  repoWikiStop: (projectPath: string): Promise<boolean> =>
    ipcRenderer.invoke("repo-wiki:stop", projectPath),
  repoWikiPause: (projectPath: string): Promise<void> =>
    ipcRenderer.invoke("repo-wiki:pause", projectPath),
  repoWikiResume: (projectPath: string): Promise<void> =>
    ipcRenderer.invoke("repo-wiki:resume", projectPath),
  repoWikiRetryPage: (projectPath: string, pageId: string): Promise<void> =>
    ipcRenderer.invoke("repo-wiki:retry-page", projectPath, pageId),
  repoWikiExport: (
    projectPath: string,
    projectName?: string,
  ): Promise<RepoWikiTransferResult> =>
    ipcRenderer.invoke("repo-wiki:export", projectPath, projectName),
  repoWikiImport: (projectPath: string): Promise<RepoWikiTransferResult> =>
    ipcRenderer.invoke("repo-wiki:import", projectPath),
  repoWikiDelete: (projectPath: string): Promise<boolean> =>
    ipcRenderer.invoke("repo-wiki:delete", projectPath),
  repoWikiSetAutoRefresh: (
    projectPath: string,
    enabled: boolean,
  ): Promise<void> =>
    ipcRenderer.invoke("repo-wiki:set-auto-refresh", projectPath, enabled),
  repoWikiUpdateSettings: (options: RepoWikiSettingsOptions): Promise<void> =>
    ipcRenderer.invoke("repo-wiki:update-settings", options),
  repoWikiNotifyTurnEnded: (projectPath: string): Promise<boolean> =>
    ipcRenderer.invoke("repo-wiki:notify-turn-ended", projectPath),
  repoWikiFilePath: (projectPath: string): Promise<string> =>
    ipcRenderer.invoke("repo-wiki:file-path", projectPath),
  onRepoWikiEvent: (callback: (event: RepoWikiEvent) => void): (() => void) => {
    ensureEventListener();
    eventSubscribers.add(callback);
    return () => {
      eventSubscribers.delete(callback);
    };
  },
};
