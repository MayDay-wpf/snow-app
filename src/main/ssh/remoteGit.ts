import {
  executeSshCommand,
  listSshDirectory,
  parseSshUrl,
  SshOperationError,
  type SshDirectoryEntry,
} from "./sshManager";
import {
  buildRemoteWorkspaceUri,
  normalizeRemotePath,
  shellQuote,
  withSshSession,
} from "./remoteWorkspaceCommand";
import type {
  GitBranch,
  GitCheckoutResult,
  GitCommitFile,
  GitCommitResult,
  GitDiffResult,
  GitFileStatus,
  GitIdentity,
  GitLogEntry,
  GitPushPullResult,
  GitRemoteInfo,
  GitRepoInfo,
  GitStageResult,
  GitStatusResult,
  GitWorktree,
} from "../../preload";

// Timeout for network operations (push/pull/fetch). These may hang on a
// flaky connection; without a bound the UI action spinner would spin forever.
const NETWORK_OP_TIMEOUT_MS = 120_000;

// Maximum recursion depth when discovering git repositories over SFTP.
// Each directory level costs one SFTP round-trip, so keep it bounded.
const MAX_DISCOVERY_DEPTH = 10;

// Directories that should never be traversed during repo discovery —
// mirrors `is_skip_dir` in native/src/storage/services/git.rs.
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".nuxt",
  ".cache",
  ".gradle",
  "__pycache__",
  ".venv",
  "venv",
  ".idea",
  ".vscode",
  "Pods",
  ".swiftpm",
  ".build",
]);

// 目录扫描的错误分类：`git status` 在非仓库目录下的固定回答，只有这种结果
// 才允许降级为「不是仓库」；其余错误必须向上抛出，避免把可用仓库误判为空。
const NOT_A_GIT_REPO_PATTERN = /not a git repository|not a git work tree/i;

// 远程子树读取失败里「无权限 / 不存在」属于可以跳过的目录（/root、/proc、
// 扫描期间被删除等）；会话失效、传输中断等必须让整次扫描失败。
const SKIPPABLE_DIRECTORY_ERROR_PATTERN =
  /permission denied|no such file|not found|not a directory/i;

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// ===== Command execution =====

/**
 * Runs a git command on the remote host via SSH. Rejects with the remote
 * stderr when git exits non-zero — same semantics as `run_git` in the
 * Rust backend. `safe.directory=*` is passed so repos owned by another
 * user (e.g. root-owned repos) are not rejected by git's dubious-ownership
 * check, keeping behaviour consistent with the local backend.
 */
export const runRemoteGit = (
  workspacePath: string,
  args: string[],
): Promise<string> =>
  withSshSession(workspacePath, async (sessionId, remotePath) => {
    const gitCommand = [
      "git",
      "-c",
      "core.quotepath=false",
      "-c",
      "safe.directory=*",
      "-c",
      "color.ui=false",
      ...args.map(shellQuote),
    ].join(" ");
    return executeSshCommand(
      sessionId,
      `cd -- ${shellQuote(remotePath)} && ${gitCommand}`,
    );
  });

/**
 * Like `runRemoteGit` but returns stdout regardless of exit code (the
 * shell wrapper swallows failures) — mirrors `run_git_raw` in the Rust
 * backend. Used where git exits non-zero in normal operation, e.g.
 * `git log` on an empty repo or `git diff --no-index` for new files.
 */
const runRemoteGitRaw = (
  workspacePath: string,
  args: string[],
): Promise<string> =>
  withSshSession(workspacePath, async (sessionId, remotePath) => {
    const gitCommand = [
      "git",
      "-c",
      "core.quotepath=false",
      "-c",
      "safe.directory=*",
      "-c",
      "color.ui=false",
      ...args.map(shellQuote),
    ].join(" ");
    return executeSshCommand(
      sessionId,
      `cd -- ${shellQuote(remotePath)} && (${gitCommand}) || true`,
    );
  });

const withNetworkTimeout = <T>(promise: Promise<T>): Promise<T> =>
  Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(
        () =>
          reject(
            new Error(
              `Remote git operation timed out after ${NETWORK_OP_TIMEOUT_MS}ms`,
            ),
          ),
        NETWORK_OP_TIMEOUT_MS,
      );
    }),
  ]);

// ===== Parsing helpers (mirror native/src/storage/services/git.rs) =====

const parseStatusChar = (c: string): string => (c === " " ? "" : c);

const deriveDisplayStatus = (
  indexStatus: string,
  workdirStatus: string,
): string => {
  if (indexStatus === "R") {
    return "R";
  }
  if (indexStatus === "C") {
    return "C";
  }
  if (workdirStatus === "?") {
    return "U";
  }
  if (workdirStatus === "!") {
    return "I";
  }
  if (indexStatus === "A") {
    return "A";
  }
  if (indexStatus === "M") {
    return "M";
  }
  if (indexStatus === "D") {
    return "D";
  }
  if (workdirStatus === "M") {
    return "M";
  }
  if (workdirStatus === "D") {
    return "D";
  }
  if (indexStatus && workdirStatus) {
    return "MM";
  }
  if (indexStatus) {
    return indexStatus;
  }
  if (workdirStatus) {
    return workdirStatus;
  }
  return "?";
};

type PorcelainEntry = {
  index: string;
  workdir: string;
  path: string;
  oldPath: string | null;
};

// 解析 `git status --porcelain=v1 -z`（与 Rust parse_porcelain_z 一致）：R/C 条目的原路径是紧随其后的一段。
const parsePorcelainZ = (
  output: string,
): { header: string | null; entries: PorcelainEntry[] } => {
  let header: string | null = null;
  const entries: PorcelainEntry[] = [];
  const parts = output.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.startsWith("## ")) {
      header = part.slice(3);
      continue;
    }
    if (part.length < 4 || part[2] !== " ") {
      continue;
    }
    const index = part[0];
    const workdir = part[1];
    const isRenameOrCopy = /[RC]/.test(index) || /[RC]/.test(workdir);
    const oldPath = isRenameOrCopy ? (parts[++i] ?? null) : null;
    entries.push({ index, workdir, path: part.slice(3), oldPath });
  }
  return { header, entries };
};

// ===== Public API (signatures mirror native git exports) =====

export const remoteGetGitStatus = async (
  workspacePath: string,
): Promise<GitStatusResult> => {
  const emptyResult = (): GitStatusResult => ({
    isRepo: false,
    currentBranch: "",
    upstream: null,
    ahead: 0,
    behind: 0,
    files: [],
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
    statusLimitHit: false,
  });

  let statusOut: string;
  try {
    statusOut = await runRemoteGit(workspacePath, [
      "status",
      "--porcelain=v1",
      "-z",
      "-b",
      "--find-renames",
      "-uall",
    ]);
  } catch (error) {
    // 非仓库目录 git 会明确回答 "not a git repository"；连接中断、命令超时、
    // 远端缺少 git 等错误必须向上抛出，不能伪装成「不是 Git 仓库」。
    if (NOT_A_GIT_REPO_PATTERN.test(errorText(error))) {
      return emptyResult();
    }
    throw error;
  }

  const { header, entries } = parsePorcelainZ(statusOut);

  let currentBranch = "";
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const files: GitFileStatus[] = [];

  if (header !== null) {
    const branchPart = header;

    // Parse upstream: "## main...origin/main [ahead 1, behind 2]"
    const ellipsisIdx = branchPart.indexOf("...");
    if (ellipsisIdx >= 0) {
      const after = branchPart.slice(ellipsisIdx + 3);
      const upstreamName = after.split(/\s+/)[0] ?? "";
      if (upstreamName) {
        upstream = upstreamName;
      }
    }

    // Parse ahead/behind counts
    const lower = branchPart.toLowerCase();
    const aheadIdx = lower.indexOf("ahead ");
    if (aheadIdx >= 0) {
      const rest = branchPart.slice(aheadIdx + 6);
      const match = rest.match(/^\d+/);
      if (match) {
        ahead = Number(match[0]);
      }
    }
    const behindIdx = lower.indexOf("behind ");
    if (behindIdx >= 0) {
      const rest = branchPart.slice(behindIdx + 7);
      const match = rest.match(/^\d+/);
      if (match) {
        behind = Number(match[0]);
      }
    }

    // Parse branch name
    const branchNameRaw =
      ellipsisIdx >= 0
        ? branchPart.slice(0, ellipsisIdx)
        : (branchPart.split(" ")[0] ?? "");
    currentBranch = branchNameRaw.startsWith("HEAD") ? "HEAD" : branchNameRaw;
  }

  for (const entry of entries) {
    files.push({
      path: entry.path,
      oldPath: entry.oldPath,
      indexStatus: entry.index,
      workdirStatus: entry.workdir,
      status: deriveDisplayStatus(
        parseStatusChar(entry.index),
        parseStatusChar(entry.workdir),
      ),
    });
  }

  let stagedCount = 0;
  let unstagedCount = 0;
  let untrackedCount = 0;

  for (const f of files) {
    if (f.workdirStatus === "?" || f.workdirStatus === "!") {
      untrackedCount += 1;
    } else {
      if (f.indexStatus && f.indexStatus !== " " && f.indexStatus !== "?") {
        stagedCount += 1;
      }
      if (
        f.workdirStatus &&
        f.workdirStatus !== " " &&
        f.workdirStatus !== "?"
      ) {
        unstagedCount += 1;
      }
    }
  }

  return {
    isRepo: true,
    currentBranch,
    upstream,
    ahead,
    behind,
    files,
    stagedCount,
    unstagedCount,
    untrackedCount,
    statusLimitHit: false,
  };
};

const parseTrackInfo = (
  track: string,
): { ahead: number; behind: number; isGone: boolean } => {
  let ahead = 0;
  let behind = 0;
  let isGone = false;

  for (const part of track.split(",")) {
    const trimmed = part.trim();
    if (trimmed === "gone") {
      isGone = true;
    } else if (trimmed.startsWith("ahead ")) {
      const num = parseInt(trimmed.slice("ahead ".length).trim(), 10);
      if (!Number.isNaN(num)) ahead = num;
    } else if (trimmed.startsWith("behind ")) {
      const num = parseInt(trimmed.slice("behind ".length).trim(), 10);
      if (!Number.isNaN(num)) behind = num;
    }
  }

  return { ahead, behind, isGone };
};

export const remoteGetGitWorktrees = async (
  workspacePath: string,
): Promise<GitWorktree[]> => {
  let output: string;
  try {
    output = await runRemoteGit(workspacePath, [
      "worktree",
      "list",
      "--porcelain",
    ]);
  } catch {
    return [];
  }

  const worktrees: GitWorktree[] = [];
  let currentPath: string | null = null;
  let currentHead: string | null = null;
  let currentBranch: string | null = null;
  let isLocked = false;
  let lockReason: string | null = null;
  let isPrunable = false;

  const normalizedWorkspace = workspacePath
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();

  for (const rawLine of output.split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      if (currentPath && currentHead) {
        const normPath = currentPath
          .replace(/\\/g, "/")
          .replace(/\/+$/, "")
          .toLowerCase();
        worktrees.push({
          path: currentPath,
          head: currentHead,
          branch: currentBranch,
          isCurrent: normPath === normalizedWorkspace,
          isLocked,
          lockReason,
          isPrunable,
        });
        currentPath = null;
        currentHead = null;
        currentBranch = null;
        isLocked = false;
        lockReason = null;
        isPrunable = false;
      }
      continue;
    }

    if (trimmed.startsWith("worktree ")) {
      currentPath = trimmed.slice("worktree ".length).trim();
    } else if (trimmed.startsWith("HEAD ")) {
      currentHead = trimmed.slice("HEAD ".length).trim();
    } else if (trimmed.startsWith("branch ")) {
      const branchRef = trimmed.slice("branch ".length).trim();
      currentBranch = branchRef.startsWith("refs/heads/")
        ? branchRef.slice("refs/heads/".length)
        : branchRef;
    } else if (trimmed.startsWith("locked")) {
      isLocked = true;
      if (trimmed.startsWith("locked ")) {
        lockReason = trimmed.slice("locked ".length).trim();
      }
    } else if (trimmed.startsWith("prunable")) {
      isPrunable = true;
    }
  }

  if (currentPath && currentHead) {
    const normPath = currentPath
      .replace(/\\/g, "/")
      .replace(/\/+$/, "")
      .toLowerCase();
    worktrees.push({
      path: currentPath,
      head: currentHead,
      branch: currentBranch,
      isCurrent: normPath === normalizedWorkspace,
      isLocked,
      lockReason,
      isPrunable,
    });
  }

  return worktrees;
};

export const remoteGetGitBranches = async (
  workspacePath: string,
): Promise<GitBranch[]> => {
  const worktreesPromise = remoteGetGitWorktrees(workspacePath).catch(() => []);
  let output: string;
  try {
    output = await runRemoteGit(workspacePath, [
      "branch",
      "--list",
      "--all",
      "--format=%(HEAD)\t%(refname)\t%(refname:short)\t%(upstream:short)\t%(upstream:track,nobracket)",
    ]);
  } catch {
    return [];
  }

  const worktrees = await worktreesPromise;
  const branchToWorktree = new Map<string, string>();
  for (const wt of worktrees) {
    if (wt.branch) {
      branchToWorktree.set(wt.branch, wt.path);
    }
  }

  const branches: GitBranch[] = [];

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.replace(/[\r\n]+$/, "");
    if (!line.trim()) {
      continue;
    }

    const parts = line.split("\t");
    if (parts.length < 2) {
      continue;
    }

    const isCurrent = parts[0].includes("*");
    const refname = parts[1].trim();
    const upstreamRaw = parts[3]?.trim() ?? "";
    const trackRaw = parts[4]?.trim() ?? "";

    // 排除空引用、本地 HEAD 符号引用以及远程 HEAD 符号引用（如 refs/remotes/origin/HEAD）
    if (!refname || refname === "HEAD" || refname.endsWith("/HEAD")) {
      continue;
    }

    if (refname.startsWith("refs/heads/")) {
      const name = refname.slice("refs/heads/".length);
      if (!name) {
        continue;
      }
      const { ahead, behind, isGone } = parseTrackInfo(trackRaw);
      branches.push({
        name,
        isCurrent,
        isRemote: false,
        remoteName: null,
        upstream: upstreamRaw || null,
        ahead,
        behind,
        isGone,
        worktreePath: branchToWorktree.get(name) ?? null,
      });
    } else if (refname.startsWith("refs/remotes/")) {
      const remotesPart = refname.slice("refs/remotes/".length);
      if (!remotesPart) {
        continue;
      }
      const slashIdx = remotesPart.indexOf("/");
      if (slashIdx <= 0) {
        continue;
      }
      const remoteName = remotesPart.slice(0, slashIdx);
      const branchName = remotesPart.slice(slashIdx + 1);
      if (branchName === "HEAD") {
        continue;
      }
      branches.push({
        name: remotesPart,
        isCurrent,
        isRemote: true,
        remoteName,
        upstream: null,
        ahead: 0,
        behind: 0,
        isGone: false,
        worktreePath: null,
      });
    }
  }

  return branches;
};

export const remoteGetGitIdentity = async (
  workspacePath: string,
): Promise<GitIdentity> => {
  const emptyResult = (error: string): GitIdentity => ({
    isRepo: false,
    repoPath: "",
    name: "",
    email: "",
    remoteUrl: "",
    hasIdentity: false,
    error,
  });

  let topLevel: string;
  try {
    topLevel = (
      await runRemoteGit(workspacePath, ["rev-parse", "--show-toplevel"])
    ).trim();
  } catch {
    return emptyResult("not a git repository");
  }
  if (!topLevel) {
    return emptyResult("not a git repository");
  }

  const name = (
    await runRemoteGitRaw(workspacePath, ["config", "user.name"])
  ).trim();
  const email = (
    await runRemoteGitRaw(workspacePath, ["config", "user.email"])
  ).trim();
  const remoteUrl = (
    await runRemoteGitRaw(workspacePath, ["remote", "get-url", "origin"])
  ).trim();

  const remoteRootPath = normalizeRemotePath(
    parseSshUrl(workspacePath).remotePath,
  );

  return {
    isRepo: true,
    repoPath: buildRemoteWorkspaceUri(workspacePath, topLevel, remoteRootPath),
    name,
    email,
    remoteUrl,
    hasIdentity: Boolean(name && email),
    error: null,
  };
};

export const remoteStageFiles = async (
  workspacePath: string,
  filePaths: string[],
): Promise<GitStageResult> => {
  if (filePaths.length === 0) {
    return { success: true, message: "No files to stage" };
  }
  try {
    await runRemoteGit(workspacePath, ["add", "--", ...filePaths]);
    return { success: true, message: "Files staged successfully" };
  } catch (err) {
    return {
      success: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
};

export const remoteUnstageFiles = async (
  workspacePath: string,
  filePaths: string[],
): Promise<GitStageResult> => {
  if (filePaths.length === 0) {
    return { success: true, message: "No files to unstage" };
  }
  try {
    await runRemoteGit(workspacePath, ["reset", "HEAD", "--", ...filePaths]);
    return { success: true, message: "Files unstaged successfully" };
  } catch (err) {
    return {
      success: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
};

export const remoteStageAll = async (
  workspacePath: string,
): Promise<GitStageResult> => {
  try {
    await runRemoteGit(workspacePath, ["add", "--all"]);
    return { success: true, message: "All changes staged" };
  } catch (err) {
    return {
      success: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
};

export const remoteUnstageAll = async (
  workspacePath: string,
): Promise<GitStageResult> => {
  try {
    await runRemoteGit(workspacePath, ["reset", "HEAD"]);
    return { success: true, message: "All changes unstaged" };
  } catch (err) {
    return {
      success: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
};

export const remoteCommitChanges = async (
  workspacePath: string,
  message: string,
): Promise<GitCommitResult> => {
  if (!message.trim()) {
    return {
      success: false,
      message: "Commit message is required",
      hash: null,
    };
  }

  try {
    await runRemoteGit(workspacePath, ["commit", "-m", message]);
    let hash: string | null = null;
    try {
      const head = (
        await runRemoteGit(workspacePath, ["rev-parse", "HEAD"])
      ).trim();
      hash = head.length >= 8 ? head.slice(0, 8) : head;
    } catch {
      // hash lookup is best-effort
    }
    return { success: true, message: "Commit successful", hash };
  } catch (err) {
    return {
      success: false,
      message: err instanceof Error ? err.message : String(err),
      hash: null,
    };
  }
};

export const remoteGetRemotes = async (
  workspacePath: string,
): Promise<GitRemoteInfo[]> => {
  try {
    const stdout = await runRemoteGit(workspacePath, ["remote", "-v"]);
    const lines = stdout.split("\n");
    const remotesMap = new Map<
      string,
      { fetchUrl?: string; pushUrl?: string }
    >();
    const order: string[] = [];
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      const parts = line.split(/\s+/);
      if (parts.length < 2) continue;
      const name = parts[0];
      const url = parts[1];
      const kind = parts[2] || "";
      if (!remotesMap.has(name)) {
        order.push(name);
        remotesMap.set(name, {});
      }
      const entry = remotesMap.get(name)!;
      if (kind.includes("fetch")) {
        entry.fetchUrl = url;
      } else if (kind.includes("push")) {
        entry.pushUrl = url;
      } else {
        if (!entry.fetchUrl) entry.fetchUrl = url;
        if (!entry.pushUrl) entry.pushUrl = url;
      }
    }
    return order.map((name) => {
      const entry = remotesMap.get(name)!;
      return {
        name,
        fetchUrl: entry.fetchUrl ?? entry.pushUrl ?? null,
        pushUrl: entry.pushUrl ?? entry.fetchUrl ?? null,
      };
    });
  } catch {
    return [];
  }
};

export const remotePushChanges = async (
  workspacePath: string,
  remote?: string,
  branch?: string,
  setUpstream?: boolean,
): Promise<GitPushPullResult> => {
  try {
    const args = ["push"];
    if (setUpstream) {
      args.push("-u");
    }
    if (remote && remote.trim()) {
      args.push(remote.trim());
      if (branch && branch.trim()) {
        args.push(branch.trim());
      }
    }
    const stdout = await withNetworkTimeout(runRemoteGit(workspacePath, args));
    const message = stdout.trim() ? stdout.trim() : "Push successful";
    return { success: true, message };
  } catch (err) {
    return {
      success: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
};

export const remotePullChanges = async (
  workspacePath: string,
  remote?: string,
  branch?: string,
): Promise<GitPushPullResult> => {
  try {
    const args = ["pull"];
    if (remote && remote.trim()) {
      args.push(remote.trim());
      if (branch && branch.trim()) {
        args.push(branch.trim());
      }
    }
    const stdout = await withNetworkTimeout(runRemoteGit(workspacePath, args));
    const message = stdout.trim() ? stdout.trim() : "Pull successful";
    return { success: true, message };
  } catch (err) {
    return {
      success: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
};

export const remoteFetchRemote = async (
  workspacePath: string,
): Promise<GitPushPullResult> => {
  try {
    const hasRemote = (await runRemoteGit(workspacePath, ["remote"])).trim();
    if (!hasRemote) {
      return { success: true, message: "No remote configured" };
    }
    await withNetworkTimeout(
      runRemoteGit(workspacePath, ["fetch", "--quiet", "--prune"]),
    );
    return { success: true, message: "Fetch successful" };
  } catch (err) {
    return {
      success: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
};

export const remoteCheckoutBranch = async (
  workspacePath: string,
  branchName: string,
): Promise<GitCheckoutResult> => {
  const trimmed = branchName.trim();
  if (!trimmed) {
    return { success: false, message: "Branch name cannot be empty" };
  }

  const tryCheckout = async (name: string): Promise<GitCheckoutResult> => {
    try {
      await runRemoteGit(workspacePath, ["checkout", name]);
      return { success: true, message: `Switched to ${name}` };
    } catch (err) {
      return {
        success: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  };

  const refExists = async (ref: string): Promise<boolean> => {
    try {
      await runRemoteGit(workspacePath, [
        "show-ref",
        "--verify",
        "--quiet",
        ref,
      ]);
      return true;
    } catch {
      return false;
    }
  };

  // 1. 本地分支优先：支持带 '/' 的本地分支名（如 fix/xxx）
  if (await refExists(`refs/heads/${trimmed}`)) {
    return tryCheckout(trimmed);
  }

  // 2. 远程分支：创建或切换对应本地跟踪分支
  if (await refExists(`refs/remotes/${trimmed}`)) {
    const slashIdx = trimmed.indexOf("/");
    const localName = slashIdx >= 0 ? trimmed.slice(slashIdx + 1) : trimmed;
    if (localName) {
      if (await refExists(`refs/heads/${localName}`)) {
        const localResult = await tryCheckout(localName);
        if (localResult.success) {
          return localResult;
        }
      }
      try {
        await runRemoteGit(workspacePath, [
          "checkout",
          "-b",
          localName,
          trimmed,
        ]);
        return {
          success: true,
          message: `Switched to ${localName} (tracking ${trimmed})`,
        };
      } catch (err) {
        return {
          success: false,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    }
  }

  // 3. 兜底直接 checkout
  return tryCheckout(trimmed);
};

export const remoteCreateBranch = async (
  workspacePath: string,
  branchName: string,
): Promise<GitCheckoutResult> => {
  try {
    await runRemoteGit(workspacePath, ["checkout", "-b", branchName]);
    return { success: true, message: `Created and switched to ${branchName}` };
  } catch (err) {
    return {
      success: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
};

/** 已知图片扩展名。对这些文件不做 `--text` 强制文本 diff：二进制内容
 *  按文本输出会产生巨大乱码 patch，渲染端解析会卡死。 */
const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "bmp",
  "webp",
  "ico",
  "svg",
  "tif",
  "tiff",
  "avif",
]);

const isImagePath = (filePath: string): boolean => {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTENSIONS.has(ext);
};

export const remoteGetFileDiff = async (
  workspacePath: string,
  filePath: string,
  staged: boolean,
): Promise<GitDiffResult> => {
  // `--no-ext-diff` 保证输出是标准 patch：远端 gitconfig 配置了
  // `diff.external` / `GIT_EXTERNAL_DIFF` 时，外部程序会产出无法解析的内容。
  const diffArgs = staged
    ? ["diff", "--cached", "--no-ext-diff", "--", filePath]
    : ["diff", "--no-ext-diff", "--", filePath];

  try {
    let stdout = await runRemoteGit(workspacePath, diffArgs);

    if (stdout.includes("Binary files")) {
      // 图片扩展名：直接判定为二进制，绝不 `--text` 重试
      // （会 dump 出巨大乱码 patch，渲染端解析卡死）。
      if (isImagePath(filePath)) {
        return {
          content: "Binary file - diff not available",
          isBinary: true,
          error: "",
        };
      }
      // Git's heuristic may falsely flag text files as binary (e.g. files
      // containing NUL bytes). Retry with --text to force a text-mode diff.
      const textArgs = staged
        ? ["diff", "--cached", "--text", "--no-ext-diff", "--", filePath]
        : ["diff", "--text", "--no-ext-diff", "--", filePath];
      let textDiff = "";
      try {
        textDiff = await runRemoteGit(workspacePath, textArgs);
      } catch {
        // keep empty
      }
      if (textDiff) {
        return { content: textDiff, isBinary: false, error: "" };
      }
      return {
        content: "Binary file - diff not available",
        isBinary: true,
        error: "",
      };
    }

    // No diff and not staged: the file may be untracked (new). Generate a
    // full-file diff via `git diff --no-index /dev/null <file>`, which
    // exits with code 1 when files differ — handled by runRemoteGitRaw.
    if (!staged && !stdout) {
      if (isImagePath(filePath)) {
        return {
          content: "Binary file - diff not available",
          isBinary: true,
          error: "",
        };
      }
      const fullDiff = await runRemoteGitRaw(workspacePath, [
        "diff",
        "--no-index",
        "--text",
        "/dev/null",
        filePath,
      ]);
      if (fullDiff) {
        return { content: fullDiff, isBinary: false, error: "" };
      }
    }

    return { content: stdout, isBinary: false, error: "" };
  } catch (err) {
    // 请求失败时返回结构化错误（content 为空），前端据此显示「加载失败」
    // 提示，而不是把错误消息当成 diff 内容渲染成空白。
    return {
      content: "",
      isBinary: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
};

export const remoteDiscardChanges = async (
  workspacePath: string,
  filePaths: string[],
): Promise<GitStageResult> => {
  if (filePaths.length === 0) {
    return { success: true, message: "No files to discard" };
  }

  // Partition into untracked ("?" workdir status) and tracked files, then
  // `git clean` the former and `git checkout --` the latter — mirrors the
  // Rust backend implementation.
  let statusOutput: string;
  try {
    statusOutput = await runRemoteGit(workspacePath, [
      "status",
      "--porcelain",
      "-z",
      "-uall",
    ]);
  } catch (err) {
    return {
      success: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  const pathSet = new Set(filePaths);
  const untracked: string[] = [];
  const tracked: string[] = [];

  for (const entry of parsePorcelainZ(statusOutput).entries) {
    if (!pathSet.has(entry.path)) {
      continue;
    }
    if (entry.index === "?") {
      untracked.push(entry.path);
    } else {
      tracked.push(entry.path);
    }
  }

  // A requested path missing from status output is treated as tracked
  // (checkout -- will handle it or produce an error).
  for (const p of pathSet) {
    if (!untracked.includes(p) && !tracked.includes(p)) {
      tracked.push(p);
    }
  }

  if (tracked.length > 0) {
    try {
      await runRemoteGit(workspacePath, ["checkout", "--", ...tracked]);
    } catch (err) {
      return {
        success: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  if (untracked.length > 0) {
    try {
      await runRemoteGit(workspacePath, ["clean", "-f", "--", ...untracked]);
    } catch (err) {
      return {
        success: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return { success: true, message: "Changes discarded successfully" };
};

/**
 * 远端仓库中「只提交到本地、尚未推送」的提交哈希集合（不被任何远端
 * 跟踪分支包含）。无远端跟踪分支时返回空集合，全部提交视为已推送 ——
 * 与 Rust 后端的 mark_pushed 行为一致。两条 git 命令拼进同一条 shell
 * 语句执行，避免多一次 SSH 往返。
 */
const remoteUnpushedHashes = (workspacePath: string): Promise<Set<string>> =>
  withSshSession(workspacePath, async (sessionId, remotePath) => {
    const gitPrefix =
      "git -c core.quotepath=false -c 'safe.directory=*' -c color.ui=false";
    const remoteRefsProbe = `${gitPrefix} for-each-ref --count=1 --format='%(refname)' refs/remotes | grep -q .`;
    const listUnpushed = `${gitPrefix} rev-list --all --not --remotes`;
    try {
      const output = await executeSshCommand(
        sessionId,
        `cd -- ${shellQuote(remotePath)} && (${remoteRefsProbe}) && ${listUnpushed} || true`,
      );
      return new Set(
        output
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
      );
    } catch {
      return new Set();
    }
  });

/**
 * 只遍历当前分支（HEAD）可达的提交（与 Rust 的 get_git_log 一致）：不用
 * `--all`，避免其他分支（如其他 fork 远端的 main）独有的提交混进提交图。
 * 行序同样与 Rust 端一致，取 `--topo-order`（git log --graph / VSCode 同款）。
 */
export const remoteGetGitLog = async (
  workspacePath: string,
  skip: number,
  limit: number,
): Promise<GitLogEntry[]> => {
  const skipCount = skip > 0 ? Math.floor(skip) : 0;
  const maxCount = limit <= 0 ? 50 : Math.floor(limit);

  // 额外遍历 upstream，让落后（未拉取）的远端提交也进入提交图。
  const upstream = (
    await runRemoteGitRaw(workspacePath, [
      "rev-parse",
      "--verify",
      "--quiet",
      "@{upstream}",
    ]).catch(() => "")
  ).trim();

  let output: string;
  try {
    output = await runRemoteGitRaw(workspacePath, [
      "log",
      "HEAD",
      ...(upstream ? [upstream] : []),
      "--topo-order",
      "--decorate=full",
      "--shortstat",
      "--pretty=format:%x1e%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%D%x1f%P%x1f%b%x1f",
      "--date=iso",
      "--skip",
      String(skipCount),
      "--max-count",
      String(maxCount),
    ]);
  } catch {
    return [];
  }

  const unpushed = await remoteUnpushedHashes(workspacePath);
  const behind = new Set(
    upstream
      ? (
          await runRemoteGitRaw(workspacePath, [
            "rev-list",
            `HEAD..${upstream}`,
          ]).catch(() => "")
        )
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
      : [],
  );
  const entries: GitLogEntry[] = [];

  // `--shortstat` appends a diffstat line (e.g. "1 file changed,
  // 5 insertions(+), 2 deletions(-)") after each commit's pretty line so the
  // renderer can show per-commit added/removed line counts. Merge commits
  // with no changes produce no shortstat line (counts stay 0).
  for (const chunk of output.split("\x1e")) {
    const trimmed = chunk.replace(/^[\r\n]+|[\r\n]+$/g, "");
    if (!trimmed) {
      continue;
    }
    const parts = trimmed.split("\x1f");
    if (parts.length >= 9) {
      const bodyRaw = parts[8].trim();
      const statText = parts[9] ?? "";
      entries.push({
        hash: parts[0],
        shortHash: parts[1],
        author: parts[2],
        email: parts[3],
        date: parts[4],
        message: parts[5],
        body: bodyRaw || null,
        refs: parts[6],
        parents: parts[7].split(/\s+/).filter(Boolean),
        additions: parseShortstatCount(statText, "insertion"),
        deletions: parseShortstatCount(statText, "deletion"),
        filesChanged: parseShortstatCount(statText, "file"),
        pushed: !unpushed.has(parts[0]),
        behind: behind.has(parts[0]),
      });
    }
  }

  return entries;
};

/** 解析 git `--shortstat` 行中 `keyword` 前的数字（"5 insertions(+)" → 5）。 */
const parseShortstatCount = (line: string, keyword: string): number => {
  let result = 0;
  let rest = line;
  let idx = rest.indexOf(keyword);
  while (idx !== -1) {
    const match = rest.slice(0, idx).match(/(\d+)\s*$/);
    if (match) {
      result = parseInt(match[1], 10);
    }
    rest = rest.slice(idx + keyword.length);
    idx = rest.indexOf(keyword);
  }
  return result;
};

export const remoteGetCommitFiles = async (
  workspacePath: string,
  hash: string,
): Promise<GitCommitFile[]> => {
  let output: string;
  try {
    output = await runRemoteGitRaw(workspacePath, [
      "diff-tree",
      "--no-commit-id",
      "--name-status",
      "-r",
      hash,
    ]);
  } catch {
    return [];
  }

  const files: GitCommitFile[] = [];

  for (const line of output.split("\n")) {
    if (!line) {
      continue;
    }
    const tabIdx = line.indexOf("\t");
    if (tabIdx < 0) {
      continue;
    }
    files.push({
      status: line.slice(0, tabIdx),
      path: line.slice(tabIdx + 1),
    });
  }

  return files;
};

export const remoteGetStagedDiff = async (
  workspacePath: string,
): Promise<string> => runRemoteGit(workspacePath, ["diff", "--cached"]);

export const remoteGetCommitDiff = async (
  workspacePath: string,
  hash: string,
): Promise<GitDiffResult> => {
  const diffArgs = [
    "show",
    "--format=",
    "--find-renames",
    "--no-ext-diff",
    hash,
  ];

  try {
    let stdout = await runRemoteGit(workspacePath, diffArgs);

    if (stdout.includes("Binary files")) {
      // Git's heuristic may falsely flag text files as binary (e.g. files
      // containing NUL bytes). Retry with --text to force a text-mode diff,
      // bounded to 256 KB — a larger dump means a genuinely binary file.
      let textDiff = "";
      try {
        textDiff = await runRemoteGit(workspacePath, [
          "show",
          "--format=",
          "--text",
          "--no-ext-diff",
          hash,
        ]);
      } catch {
        // keep empty
      }
      if (textDiff && textDiff.length <= 256 * 1024) {
        return { content: textDiff, isBinary: false, error: "" };
      }
      return {
        content: "Binary file - diff not available",
        isBinary: true,
        error: "",
      };
    }

    return { content: stdout, isBinary: false, error: "" };
  } catch (err) {
    return {
      content: "",
      isBinary: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
};

/** Diff of a single file within a single commit (`git show <hash> -- <path>`). */
export const remoteGetCommitFileDiff = async (
  workspacePath: string,
  hash: string,
  filePath: string,
): Promise<GitDiffResult> => {
  const diffArgs = [
    "show",
    "--format=",
    "--find-renames",
    "--no-ext-diff",
    hash,
    "--",
    filePath,
  ];

  try {
    let stdout = await runRemoteGit(workspacePath, diffArgs);

    if (stdout.includes("Binary files")) {
      // 图片扩展名：直接判定为二进制，绝不 `--text` 重试
      // （会 dump 出巨大乱码 patch，渲染端解析卡死）。
      if (isImagePath(filePath)) {
        return {
          content: "Binary file - diff not available",
          isBinary: true,
          error: "",
        };
      }
      // Git's heuristic may falsely flag text files as binary (e.g. files
      // containing NUL bytes). Retry with --text to force a text-mode diff,
      // bounded to 256 KB — a larger dump means a genuinely binary file.
      let textDiff = "";
      try {
        textDiff = await runRemoteGit(workspacePath, [
          "show",
          "--format=",
          "--text",
          "--no-ext-diff",
          hash,
          "--",
          filePath,
        ]);
      } catch {
        // keep empty
      }
      if (textDiff && textDiff.length <= 256 * 1024) {
        return { content: textDiff, isBinary: false, error: "" };
      }
      return {
        content: "Binary file - diff not available",
        isBinary: true,
        error: "",
      };
    }

    return { content: stdout, isBinary: false, error: "" };
  } catch (err) {
    return {
      content: "",
      isBinary: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
};

/**
 * Discovers git repositories under the remote workspace root by walking
 * the directory tree over SFTP (mirrors `discover_git_repos` in the Rust
 * backend). Found repos are reported with `ssh://` workspace URIs so the
 * UI can pass them straight back to the other remote git operations.
 */
export const remoteDiscoverGitRepos = async (
  workspacePath: string,
): Promise<GitRepoInfo[]> => {
  const parsed = parseSshUrl(workspacePath);
  const remoteRootPath = normalizeRemotePath(parsed.remotePath);

  return withSshSession(workspacePath, async (sessionId) => {
    const repos: GitRepoInfo[] = [];

    const getCurrentBranch = async (remotePath: string): Promise<string> => {
      try {
        const branch = (
          await executeSshCommand(
            sessionId,
            `cd -- ${shellQuote(remotePath)} && (git -c core.quotepath=false -c safe.directory=* rev-parse --abbrev-ref HEAD) || true`,
          )
        ).trim();
        return !branch || branch === "HEAD" ? "" : branch;
      } catch {
        return "";
      }
    };

    const addRepo = async (remotePath: string): Promise<void> => {
      const uri = buildRemoteWorkspaceUri(
        workspacePath,
        remotePath,
        remoteRootPath,
      );
      const name = remotePath.split("/").filter(Boolean).pop() ?? remotePath;
      repos.push({
        path: uri,
        name,
        currentBranch: await getCurrentBranch(remotePath),
      });
    };

    // 一次 readdir 同时判断「本层是不是仓库」与「是否继续下钻」，避免每个
    // 目录读两遍。子目录错误按可跳过（无权限 / 已删除）与致命错误区分处理。
    const walk = async (
      remotePath: string,
      entries: SshDirectoryEntry[],
      depth: number,
    ): Promise<void> => {
      if (entries.some((entry) => entry.name === ".git")) {
        await addRepo(remotePath);
        return;
      }
      if (depth >= MAX_DISCOVERY_DEPTH) {
        return;
      }

      for (const entry of entries) {
        if (!entry.isDirectory || SKIP_DIRS.has(entry.name)) {
          continue;
        }
        let childEntries: SshDirectoryEntry[];
        try {
          childEntries = await listSshDirectory(sessionId, entry.path);
        } catch (error) {
          if (SKIPPABLE_DIRECTORY_ERROR_PATTERN.test(errorText(error))) {
            continue;
          }
          throw error;
        }
        await walk(entry.path, childEntries, depth + 1);
      }
    };

    // 根目录读不出来通常是会话或传输问题：必须报错，不能返回空列表让界面
    // 误判「这个工作区没有仓库」。
    let rootEntries: SshDirectoryEntry[];
    try {
      rootEntries = await listSshDirectory(sessionId, remoteRootPath);
    } catch (error) {
      throw new SshOperationError({
        code: "SSH_GIT_DISCOVERY_FAILED",
        operation: "git_discover",
        message: `Failed to read remote workspace directory: ${errorText(error)}`,
      });
    }

    await walk(remoteRootPath, rootEntries, 0);

    repos.sort((a, b) => a.path.localeCompare(b.path));
    return repos;
  });
};
