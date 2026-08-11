import { ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  GitBranch,
  GitCheckoutResult,
  GitCommitFile,
  GitCommitResult,
  GitDiffResult,
  GitFileContentResult,
  GitLogEntry,
  GitPushPullResult,
  GitRepoInfo,
  GitStageResult,
  GitStatusResult,
  ResponsesApiResult,
  ResponsesApiStreamChunk,
} from "../types";

const GIT_COMMIT_MSG_CHUNK_CHANNEL = "git:commit-msg:chunk";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const createCommitMsgStreamId = (): string =>
  `commit-msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const normalizeStreamChunk = (
  value: unknown
): ResponsesApiStreamChunk | null => {
  if (!isRecord(value)) {
    return null;
  }

  return {
    contentDelta:
      typeof value.contentDelta === "string" ? value.contentDelta : "",
    thinkingDelta:
      typeof value.thinkingDelta === "string" ? value.thinkingDelta : "",
    content: typeof value.content === "string" ? value.content : "",
    thinking: typeof value.thinking === "string" ? value.thinking : "",
    retrying: typeof value.retrying === "boolean" ? value.retrying : false,
    retryAttempt:
      typeof value.retryAttempt === "number" ? value.retryAttempt : null,
    retryError: typeof value.retryError === "string" ? value.retryError : null,
    streamTokenCount:
      typeof value.streamTokenCount === "number" ? value.streamTokenCount : 0,
    elapsedMs: typeof value.elapsedMs === "number" ? value.elapsedMs : 0,
    ttftMs: typeof value.ttftMs === "number" ? value.ttftMs : 0,
  };
};

export const gitApi = {
  gitStatus: (repoPath: string): Promise<GitStatusResult> =>
    ipcRenderer.invoke("git:status", repoPath),
  startGitWatch: (repoPath: string): Promise<void> =>
    ipcRenderer.invoke("git:start-watch", repoPath),
  stopGitWatch: (repoPath: string): Promise<void> =>
    ipcRenderer.invoke("git:stop-watch", repoPath),
  onGitStatusChanged: (callback: (repoPath: string) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, repoPath: string): void => {
      callback(repoPath);
    };

    ipcRenderer.on("git:status-changed", handler);

    return () => {
      ipcRenderer.removeListener("git:status-changed", handler);
    };
  },
  gitBranches: (repoPath: string): Promise<GitBranch[]> =>
    ipcRenderer.invoke("git:branches", repoPath),
  gitStage: (repoPath: string, filePaths: string[]): Promise<GitStageResult> =>
    ipcRenderer.invoke("git:stage", repoPath, filePaths),
  gitUnstage: (
    repoPath: string,
    filePaths: string[]
  ): Promise<GitStageResult> =>
    ipcRenderer.invoke("git:unstage", repoPath, filePaths),
  gitStageAll: (repoPath: string): Promise<GitStageResult> =>
    ipcRenderer.invoke("git:stage-all", repoPath),
  gitUnstageAll: (repoPath: string): Promise<GitStageResult> =>
    ipcRenderer.invoke("git:unstage-all", repoPath),
  gitCommit: (repoPath: string, message: string): Promise<GitCommitResult> =>
    ipcRenderer.invoke("git:commit", repoPath, message),
  gitPush: (repoPath: string): Promise<GitPushPullResult> =>
    ipcRenderer.invoke("git:push", repoPath),
  gitPull: (repoPath: string): Promise<GitPushPullResult> =>
    ipcRenderer.invoke("git:pull", repoPath),
  gitFetch: (repoPath: string): Promise<GitPushPullResult> =>
    ipcRenderer.invoke("git:fetch", repoPath),
  gitCheckout: (
    repoPath: string,
    branchName: string
  ): Promise<GitCheckoutResult> =>
    ipcRenderer.invoke("git:checkout", repoPath, branchName),
  gitCreateBranch: (
    repoPath: string,
    branchName: string
  ): Promise<GitCheckoutResult> =>
    ipcRenderer.invoke("git:create-branch", repoPath, branchName),
  gitFileDiff: (
    repoPath: string,
    filePath: string,
    staged: boolean
  ): Promise<GitDiffResult> =>
    ipcRenderer.invoke("git:file-diff", repoPath, filePath, staged),
  gitFileContent: (
    repoPath: string,
    filePath: string,
    revision: string | null
  ): Promise<GitFileContentResult> =>
    ipcRenderer.invoke("git:file-content", repoPath, filePath, revision),
  gitDiscardChanges: (
    repoPath: string,
    filePaths: string[]
  ): Promise<GitStageResult> =>
    ipcRenderer.invoke("git:discard", repoPath, filePaths),
  gitLog: (
    repoPath: string,
    skip: number,
    limit: number
  ): Promise<GitLogEntry[]> =>
    ipcRenderer.invoke("git:log", repoPath, skip, limit),
  gitCommitFiles: (repoPath: string, hash: string): Promise<GitCommitFile[]> =>
    ipcRenderer.invoke("git:commit-files", repoPath, hash),
  gitCommitDiff: (repoPath: string, hash: string): Promise<GitDiffResult> =>
    ipcRenderer.invoke("git:commit-diff", repoPath, hash),
  gitCommitFileDiff: (
    repoPath: string,
    hash: string,
    filePath: string
  ): Promise<GitDiffResult> =>
    ipcRenderer.invoke("git:commit-file-diff", repoPath, hash, filePath),
  discoverGitRepos: (rootPath: string): Promise<GitRepoInfo[]> =>
    ipcRenderer.invoke("git:discover-repos", rootPath),
  getGitScanSettings: (): Promise<{
    maxDepth: number;
    ignoredFolders: string[];
    changeDebounceMs: number;
    remotePollIntervalMs: number;
    statusLimit: number;
    autoRefresh: boolean;
  }> => ipcRenderer.invoke("git-settings:get"),
  setGitScanSettings: (value: {
    maxDepth: number;
    ignoredFolders: string[];
    changeDebounceMs: number;
    remotePollIntervalMs: number;
    statusLimit: number;
    autoRefresh: boolean;
  }): Promise<{
    maxDepth: number;
    ignoredFolders: string[];
    changeDebounceMs: number;
    remotePollIntervalMs: number;
    statusLimit: number;
    autoRefresh: boolean;
  }> => ipcRenderer.invoke("git-settings:set", value),
  generateCommitMessage: (
    repoPath: string,
    onChunk?: (chunk: ResponsesApiStreamChunk) => void,
    onStreamId?: (streamId: string) => void
  ): Promise<ResponsesApiResult> => {
    const streamId = createCommitMsgStreamId();
    onStreamId?.(streamId);

    const handleChunk = (_event: IpcRendererEvent, payload: unknown): void => {
      if (!isRecord(payload) || payload.streamId !== streamId) {
        return;
      }

      const chunk = normalizeStreamChunk(payload.chunk);
      if (chunk) {
        onChunk?.(chunk);
      }
    };

    ipcRenderer.on(GIT_COMMIT_MSG_CHUNK_CHANNEL, handleChunk);

    return ipcRenderer
      .invoke("git:generate-commit-message", repoPath, streamId)
      .finally(() => {
        ipcRenderer.removeListener(GIT_COMMIT_MSG_CHUNK_CHANNEL, handleChunk);
      });
  },
  abortCommitMessage: (streamId: string): Promise<boolean> =>
    ipcRenderer.invoke("chat:abort-response-stream", streamId),
};
