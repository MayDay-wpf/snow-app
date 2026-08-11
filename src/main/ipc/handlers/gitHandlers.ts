import { ipcMain } from "electron";
import type { NativeBridge, ResponsesApiStreamChunk } from "../../native/types";
import {
  remoteCheckoutBranch,
  remoteCommitChanges,
  remoteCreateBranch,
  remoteDiscardChanges,
  remoteDiscoverGitRepos,
  remoteFetchRemote,
  remoteGetCommitFiles,
  remoteGetCommitDiff,
  remoteGetCommitFileDiff,
  remoteGetFileDiff,
  remoteGetGitBranches,
  remoteGetGitLog,
  remoteGetGitStatus,
  remoteGetStagedDiff,
  remotePullChanges,
  remotePushChanges,
  remoteStageAll,
  remoteStageFiles,
  remoteUnstageAll,
  remoteUnstageFiles,
} from "../../ssh/remoteGit";
import { safeSend } from "../../utils/safeSend";

const GIT_COMMIT_MSG_CHUNK_CHANNEL = "git:commit-msg:chunk";

// ===== Git repo scan settings (stored in the app database via system settings) =====
// Mirrors VSCode's `git.repositoryScanMaxDepth` / `git.repositoryScanIgnoredFolders`:
// the default scan depth is 1 (only direct children of the workspace root),
// a negative value means unlimited. `ignoredFolders` are directory names
// (case-insensitive) that are never traversed during discovery.
const GIT_SETTINGS_NAME = "Git settings";
const GIT_SETTINGS_CODE = "git_settings";

type GitScanSettings = {
  maxDepth: number;
  ignoredFolders: string[];
  /** 文件变更监测防抖（毫秒），默认 400 */
  changeDebounceMs: number;
  /** 远程（ssh://）仓库状态轮询间隔（毫秒），默认 10000 */
  remotePollIntervalMs: number;
  /** 变更列表数量上限（0 = 不限制），默认 10000 */
  statusLimit: number;
  /** 文件变化时自动刷新 git status，默认 true */
  autoRefresh: boolean;
};

const DEFAULT_GIT_SCAN_SETTINGS: GitScanSettings = {
  maxDepth: 1,
  ignoredFolders: [],
  changeDebounceMs: 400,
  remotePollIntervalMs: 10000,
  statusLimit: 10000,
  autoRefresh: true,
};

const toPositiveInteger = (
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(Math.round(value), min), max);
};

const readGitScanSettings = async (
  native: NativeBridge
): Promise<GitScanSettings> => {
  try {
    const raw = await native.getSystemSettingValue(GIT_SETTINGS_CODE);
    if (!raw) {
      return DEFAULT_GIT_SCAN_SETTINGS;
    }
    const parsed = JSON.parse(raw) as Partial<GitScanSettings>;
    const maxDepth =
      typeof parsed.maxDepth === "number" && Number.isInteger(parsed.maxDepth)
        ? parsed.maxDepth
        : DEFAULT_GIT_SCAN_SETTINGS.maxDepth;
    const ignoredFolders = Array.isArray(parsed.ignoredFolders)
      ? parsed.ignoredFolders.filter(
          (folder): folder is string =>
            typeof folder === "string" && folder.trim().length > 0
        )
      : [];
    return {
      maxDepth,
      ignoredFolders,
      changeDebounceMs: toPositiveInteger(
        parsed.changeDebounceMs,
        DEFAULT_GIT_SCAN_SETTINGS.changeDebounceMs,
        50,
        60000
      ),
      remotePollIntervalMs: toPositiveInteger(
        parsed.remotePollIntervalMs,
        DEFAULT_GIT_SCAN_SETTINGS.remotePollIntervalMs,
        1000,
        600000
      ),
      statusLimit: toPositiveInteger(
        parsed.statusLimit,
        DEFAULT_GIT_SCAN_SETTINGS.statusLimit,
        0,
        1000000
      ),
      autoRefresh:
        typeof parsed.autoRefresh === "boolean"
          ? parsed.autoRefresh
          : DEFAULT_GIT_SCAN_SETTINGS.autoRefresh,
    };
  } catch {
    return DEFAULT_GIT_SCAN_SETTINGS;
  }
};

// `ssh://` workspace paths cannot be handled by the local Rust backend;
// they are dispatched to the SSH-backed implementation instead, which
// runs git on the remote host.
const isSshPath = (path: string): boolean => path.startsWith("ssh://");

export const registerGitHandlers = (native: NativeBridge): void => {
  // ===== Git file watcher handlers =====
  ipcMain.handle("git:start-watch", async (event, repoPath: unknown) => {
    if (typeof repoPath !== "string" || !repoPath.trim()) {
      throw new Error("Repository path is required");
    }
    const trimmed = repoPath.trim();
    if (isSshPath(trimmed)) {
      // Remote repos have no local file watcher; the renderer polls
      // `git:status` instead (see useGitStatus).
      return;
    }
    const settings = await readGitScanSettings(native);
    native.startGitWatch(
      trimmed,
      settings.changeDebounceMs,
      (changedRepoPath: string) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send("git:status-changed", changedRepoPath);
        }
      }
    );
  });

  ipcMain.handle("git:stop-watch", (_event, repoPath: unknown) => {
    if (typeof repoPath !== "string" || !repoPath.trim()) {
      throw new Error("Repository path is required");
    }
    const trimmed = repoPath.trim();
    if (isSshPath(trimmed)) {
      return;
    }
    native.stopGitWatch(trimmed);
  });

  // ===== Git handlers =====
  ipcMain.handle("git:status", async (_event, repoPath: unknown) => {
    if (typeof repoPath !== "string" || !repoPath.trim()) {
      throw new Error("Repository path is required");
    }
    const trimmed = repoPath.trim();
    if (isSshPath(trimmed)) {
      return remoteGetGitStatus(trimmed);
    }
    const settings = await readGitScanSettings(native);
    return native.getGitStatus(trimmed, settings.statusLimit);
  });

  ipcMain.handle("git:branches", async (_event, repoPath: unknown) => {
    if (typeof repoPath !== "string" || !repoPath.trim()) {
      throw new Error("Repository path is required");
    }
    const trimmed = repoPath.trim();
    return isSshPath(trimmed)
      ? remoteGetGitBranches(trimmed)
      : native.getGitBranches(trimmed);
  });

  ipcMain.handle(
    "git:stage",
    async (_event, repoPath: unknown, filePaths: unknown) => {
      if (typeof repoPath !== "string" || !repoPath.trim()) {
        throw new Error("Repository path is required");
      }
      const paths = Array.isArray(filePaths)
        ? filePaths.filter((f): f is string => typeof f === "string")
        : [];
      const trimmed = repoPath.trim();
      return isSshPath(trimmed)
        ? remoteStageFiles(trimmed, paths)
        : native.gitStageFiles(trimmed, paths);
    }
  );

  ipcMain.handle(
    "git:unstage",
    async (_event, repoPath: unknown, filePaths: unknown) => {
      if (typeof repoPath !== "string" || !repoPath.trim()) {
        throw new Error("Repository path is required");
      }
      const paths = Array.isArray(filePaths)
        ? filePaths.filter((f): f is string => typeof f === "string")
        : [];
      const trimmed = repoPath.trim();
      return isSshPath(trimmed)
        ? remoteUnstageFiles(trimmed, paths)
        : native.gitUnstageFiles(trimmed, paths);
    }
  );

  ipcMain.handle("git:stage-all", async (_event, repoPath: unknown) => {
    if (typeof repoPath !== "string" || !repoPath.trim()) {
      throw new Error("Repository path is required");
    }
    const trimmed = repoPath.trim();
    return isSshPath(trimmed)
      ? remoteStageAll(trimmed)
      : native.gitStageAll(trimmed);
  });

  ipcMain.handle("git:unstage-all", async (_event, repoPath: unknown) => {
    if (typeof repoPath !== "string" || !repoPath.trim()) {
      throw new Error("Repository path is required");
    }
    const trimmed = repoPath.trim();
    return isSshPath(trimmed)
      ? remoteUnstageAll(trimmed)
      : native.gitUnstageAll(trimmed);
  });

  ipcMain.handle(
    "git:commit",
    async (_event, repoPath: unknown, message: unknown) => {
      if (typeof repoPath !== "string" || !repoPath.trim()) {
        throw new Error("Repository path is required");
      }
      if (typeof message !== "string" || !message.trim()) {
        throw new Error("Commit message is required");
      }
      const trimmed = repoPath.trim();
      return isSshPath(trimmed)
        ? remoteCommitChanges(trimmed, message)
        : native.gitCommit(trimmed, message);
    }
  );

  ipcMain.handle("git:push", async (_event, repoPath: unknown) => {
    if (typeof repoPath !== "string" || !repoPath.trim()) {
      throw new Error("Repository path is required");
    }
    const trimmed = repoPath.trim();
    return isSshPath(trimmed)
      ? remotePushChanges(trimmed)
      : native.gitPush(trimmed);
  });

  ipcMain.handle("git:pull", async (_event, repoPath: unknown) => {
    if (typeof repoPath !== "string" || !repoPath.trim()) {
      throw new Error("Repository path is required");
    }
    const trimmed = repoPath.trim();
    return isSshPath(trimmed)
      ? remotePullChanges(trimmed)
      : native.gitPull(trimmed);
  });

  ipcMain.handle("git:fetch", async (_event, repoPath: unknown) => {
    if (typeof repoPath !== "string" || !repoPath.trim()) {
      throw new Error("Repository path is required");
    }
    const trimmed = repoPath.trim();
    return isSshPath(trimmed)
      ? remoteFetchRemote(trimmed)
      : native.gitFetch(trimmed);
  });

  ipcMain.handle(
    "git:checkout",
    async (_event, repoPath: unknown, branchName: unknown) => {
      if (typeof repoPath !== "string" || !repoPath.trim()) {
        throw new Error("Repository path is required");
      }
      if (typeof branchName !== "string" || !branchName.trim()) {
        throw new Error("Branch name is required");
      }
      const trimmed = repoPath.trim();
      return isSshPath(trimmed)
        ? remoteCheckoutBranch(trimmed, branchName.trim())
        : native.gitCheckout(trimmed, branchName.trim());
    }
  );

  ipcMain.handle(
    "git:create-branch",
    async (_event, repoPath: unknown, branchName: unknown) => {
      if (typeof repoPath !== "string" || !repoPath.trim()) {
        throw new Error("Repository path is required");
      }
      if (typeof branchName !== "string" || !branchName.trim()) {
        throw new Error("Branch name is required");
      }
      const trimmed = repoPath.trim();
      return isSshPath(trimmed)
        ? remoteCreateBranch(trimmed, branchName.trim())
        : native.gitCreateBranch(trimmed, branchName.trim());
    }
  );

  ipcMain.handle(
    "git:file-diff",
    async (_event, repoPath: unknown, filePath: unknown, staged: unknown) => {
      if (typeof repoPath !== "string" || !repoPath.trim()) {
        throw new Error("Repository path is required");
      }
      if (typeof filePath !== "string" || !filePath.trim()) {
        throw new Error("File path is required");
      }
      const trimmed = repoPath.trim();
      return isSshPath(trimmed)
        ? remoteGetFileDiff(trimmed, filePath.trim(), staged === true)
        : native.gitFileDiff(trimmed, filePath.trim(), staged === true);
    }
  );

  ipcMain.handle(
    "git:file-content",
    async (
      _event,
      repoPath: unknown,
      filePath: unknown,
      revision: unknown
    ) => {
      if (typeof repoPath !== "string" || !repoPath.trim()) {
        throw new Error("Repository path is required");
      }
      if (typeof filePath !== "string" || !filePath.trim()) {
        throw new Error("File path is required");
      }
      const trimmed = repoPath.trim();
      const rev = typeof revision === "string" ? revision.trim() || null : null;
      if (isSshPath(trimmed)) {
        // Remote (SSH) repos cannot read file bytes locally — the caller
        // falls back to the binary-file placeholder.
        throw new Error("File content preview is not supported for remote repositories");
      }
      return native.gitFileContent(trimmed, filePath.trim(), rev);
    }
  );

  ipcMain.handle(
    "git:discard",
    async (_event, repoPath: unknown, filePaths: unknown) => {
      if (typeof repoPath !== "string" || !repoPath.trim()) {
        throw new Error("Repository path is required");
      }
      const paths = Array.isArray(filePaths)
        ? filePaths.filter((f): f is string => typeof f === "string")
        : [];
      const trimmed = repoPath.trim();
      return isSshPath(trimmed)
        ? remoteDiscardChanges(trimmed, paths)
        : native.gitDiscardChanges(trimmed, paths);
    }
  );

  ipcMain.handle(
    "git:log",
    async (_event, repoPath: unknown, skip: unknown, limit: unknown) => {
      if (typeof repoPath !== "string" || !repoPath.trim()) {
        throw new Error("Repository path is required");
      }
      const skipCount =
        typeof skip === "number" && skip > 0 ? Math.floor(skip) : 0;
      const maxCount = typeof limit === "number" && limit > 0 ? limit : 50;
      const trimmed = repoPath.trim();
      return isSshPath(trimmed)
        ? remoteGetGitLog(trimmed, skipCount, maxCount)
        : native.getGitLog(trimmed, skipCount, maxCount);
    }
  );

  ipcMain.handle(
    "git:commit-files",
    async (_event, repoPath: unknown, hash: unknown) => {
      if (typeof repoPath !== "string" || !repoPath.trim()) {
        throw new Error("Repository path is required");
      }
      if (typeof hash !== "string" || !hash.trim()) {
        throw new Error("Commit hash is required");
      }
      const trimmed = repoPath.trim();
      return isSshPath(trimmed)
        ? remoteGetCommitFiles(trimmed, hash.trim())
        : native.getGitCommitFiles(trimmed, hash.trim());
    }
  );

  ipcMain.handle(
    "git:commit-diff",
    async (_event, repoPath: unknown, hash: unknown) => {
      if (typeof repoPath !== "string" || !repoPath.trim()) {
        throw new Error("Repository path is required");
      }
      if (typeof hash !== "string" || !hash.trim()) {
        throw new Error("Commit hash is required");
      }
      const trimmed = repoPath.trim();
      return isSshPath(trimmed)
        ? remoteGetCommitDiff(trimmed, hash.trim())
        : native.getCommitDiff(trimmed, hash.trim());
    }
  );

  ipcMain.handle(
    "git:commit-file-diff",
    async (_event, repoPath: unknown, hash: unknown, filePath: unknown) => {
      if (typeof repoPath !== "string" || !repoPath.trim()) {
        throw new Error("Repository path is required");
      }
      if (typeof hash !== "string" || !hash.trim()) {
        throw new Error("Commit hash is required");
      }
      if (typeof filePath !== "string" || !filePath.trim()) {
        throw new Error("File path is required");
      }
      const trimmed = repoPath.trim();
      return isSshPath(trimmed)
        ? remoteGetCommitFileDiff(trimmed, hash.trim(), filePath.trim())
        : native.gitCommitFileDiff(trimmed, hash.trim(), filePath.trim());
    }
  );
  // ===== Git repo discovery =====
  ipcMain.handle("git:discover-repos", async (_event, rootPath: unknown) => {
    if (typeof rootPath !== "string" || !rootPath.trim()) {
      throw new Error("Root path is required");
    }
    const trimmed = rootPath.trim();
    if (isSshPath(trimmed)) {
      return remoteDiscoverGitRepos(trimmed);
    }
    const settings = await readGitScanSettings(native);
    return native.discoverGitRepos(
      trimmed,
      settings.maxDepth,
      settings.ignoredFolders
    );
  });

  // ===== Git repo scan settings =====
  ipcMain.handle("git-settings:get", async () => readGitScanSettings(native));

  ipcMain.handle("git-settings:set", async (_event, value: unknown) => {
    const source = (value ?? {}) as Partial<GitScanSettings>;
    const maxDepth =
      typeof source.maxDepth === "number" && Number.isInteger(source.maxDepth)
        ? source.maxDepth
        : DEFAULT_GIT_SCAN_SETTINGS.maxDepth;
    const ignoredFolders = Array.isArray(source.ignoredFolders)
      ? source.ignoredFolders.filter(
          (folder): folder is string =>
            typeof folder === "string" && folder.trim().length > 0
        )
      : [];
    const normalized: GitScanSettings = {
      maxDepth,
      ignoredFolders,
      changeDebounceMs: toPositiveInteger(
        source.changeDebounceMs,
        DEFAULT_GIT_SCAN_SETTINGS.changeDebounceMs,
        50,
        60000
      ),
      remotePollIntervalMs: toPositiveInteger(
        source.remotePollIntervalMs,
        DEFAULT_GIT_SCAN_SETTINGS.remotePollIntervalMs,
        1000,
        600000
      ),
      statusLimit: toPositiveInteger(
        source.statusLimit,
        DEFAULT_GIT_SCAN_SETTINGS.statusLimit,
        0,
        1000000
      ),
      autoRefresh:
        typeof source.autoRefresh === "boolean"
          ? source.autoRefresh
          : DEFAULT_GIT_SCAN_SETTINGS.autoRefresh,
    };
    await native.setSystemSetting(
      GIT_SETTINGS_NAME,
      GIT_SETTINGS_CODE,
      JSON.stringify(normalized)
    );
    return normalized;
  });

  // ===== AI commit message generation =====
  ipcMain.handle(
    "git:generate-commit-message",
    async (event, repoPath: unknown, streamId: unknown) => {
      if (typeof repoPath !== "string" || !repoPath.trim()) {
        throw new Error("Repository path is required");
      }
      if (typeof streamId !== "string" || !streamId.trim()) {
        throw new Error("Stream ID is required");
      }

      const normalizedStreamId = streamId.trim();
      const trimmed = repoPath.trim();

      const onChunk = (chunk: ResponsesApiStreamChunk): void => {
        safeSend(event.sender, GIT_COMMIT_MSG_CHUNK_CHANNEL, {
          streamId: normalizedStreamId,
          chunk,
        });
      };

      if (isSshPath(trimmed)) {
        // The diff must be produced on the remote host; the AI generation
        // itself still runs through the Rust backend.
        const stagedDiff = await remoteGetStagedDiff(trimmed);
        return await native.generateCommitMessageFromDiff(
          stagedDiff,
          onChunk,
          normalizedStreamId
        );
      }

      return await native.generateCommitMessage(
        trimmed,
        onChunk,
        normalizedStreamId
      );
    }
  );
};
