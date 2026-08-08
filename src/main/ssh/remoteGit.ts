import {
  executeSshCommand,
  listSshDirectory,
  parseSshUrl,
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
  GitLogEntry,
  GitPushPullResult,
  GitRepoInfo,
  GitStageResult,
  GitStatusResult,
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

// ===== Command execution =====

/**
 * Runs a git command on the remote host via SSH. Rejects with the remote
 * stderr when git exits non-zero — same semantics as `run_git` in the
 * Rust backend. `safe.directory=*` is passed so repos owned by another
 * user (e.g. root-owned repos) are not rejected by git's dubious-ownership
 * check, keeping behaviour consistent with the local backend.
 */
const runRemoteGit = (workspacePath: string, args: string[]): Promise<string> =>
  withSshSession(workspacePath, async (sessionId, remotePath) => {
    const gitCommand = [
      "git",
      "-c",
      "core.quotepath=false",
      "-c",
      "safe.directory=*",
      ...args.map(shellQuote),
    ].join(" ");
    return executeSshCommand(
      sessionId,
      `cd -- ${shellQuote(remotePath)} && ${gitCommand}`
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
  args: string[]
): Promise<string> =>
  withSshSession(workspacePath, async (sessionId, remotePath) => {
    const gitCommand = [
      "git",
      "-c",
      "core.quotepath=false",
      "-c",
      "safe.directory=*",
      ...args.map(shellQuote),
    ].join(" ");
    return executeSshCommand(
      sessionId,
      `cd -- ${shellQuote(remotePath)} && (${gitCommand}) || true`
    );
  });

const withNetworkTimeout = <T>(promise: Promise<T>): Promise<T> =>
  Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(
        () => reject(new Error(`Remote git operation timed out after ${NETWORK_OP_TIMEOUT_MS}ms`)),
        NETWORK_OP_TIMEOUT_MS
      );
    }),
  ]);

// ===== Parsing helpers (mirror native/src/storage/services/git.rs) =====

const parseStatusChar = (c: string): string => (c === " " ? "" : c);

const deriveDisplayStatus = (indexStatus: string, workdirStatus: string): string => {
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

// ===== Public API (signatures mirror native git exports) =====

export const remoteGetGitStatus = async (
  workspacePath: string
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
  });

  let statusOut: string;
  try {
    statusOut = await runRemoteGit(workspacePath, [
      "status",
      "--porcelain=v1",
      "-b",
      "--find-renames",
      "-uall",
    ]);
  } catch {
    // Not a git repository (or git rejected the path) — the UI shows the
    // "not a repo" empty state instead of a raw git error.
    return emptyResult();
  }

  const lines = statusOut.split("\n").filter((l) => l.length > 0);

  let currentBranch = "";
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const files: GitFileStatus[] = [];

  for (const line of lines) {
    if (line.startsWith("## ")) {
      const branchPart = line.slice(3);

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
          : branchPart.split(" ")[0] ?? "";
      currentBranch = branchNameRaw.startsWith("HEAD")
        ? "HEAD"
        : branchNameRaw;
      continue;
    }

    // File status lines: "XY <path>"
    if (line.length < 3) {
      continue;
    }

    const indexStatus = parseStatusChar(line[0]);
    const workdirStatus = parseStatusChar(line[1]);
    let rest = line.slice(3);

    let filePath = rest;
    let oldPath: string | null = null;

    const arrowIdx = rest.indexOf(" -> ");
    if (arrowIdx >= 0) {
      oldPath = rest.slice(0, arrowIdx);
      filePath = rest.slice(arrowIdx + 4);
    }

    // Strip surrounding quotes
    if (filePath.startsWith('"') && filePath.endsWith('"') && filePath.length >= 2) {
      filePath = filePath.slice(1, -1);
    }

    files.push({
      path: filePath,
      oldPath,
      indexStatus: line[0],
      workdirStatus: line[1],
      status: deriveDisplayStatus(indexStatus, workdirStatus),
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
      if (f.workdirStatus && f.workdirStatus !== " " && f.workdirStatus !== "?") {
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
  };
};

export const remoteGetGitBranches = async (
  workspacePath: string
): Promise<GitBranch[]> => {
  let output: string;
  try {
    output = await runRemoteGit(workspacePath, [
      "branch",
      "--list",
      "--all",
      "--format=%(HEAD)%(refname:short) %(objectname:short) %(upstream:short)",
    ]);
  } catch {
    return [];
  }

  const branches: GitBranch[] = [];

  for (const rawLine of output.split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      continue;
    }

    const isCurrent = trimmed.startsWith("*");
    const rest = isCurrent ? trimmed.slice(1).trimStart() : trimmed;
    const parts = rest.split(/\s+/);
    const name = parts[0];
    if (!name || name === "HEAD") {
      continue;
    }

    const isRemote = name.includes("/");
    const remoteName = isRemote ? name.slice(0, name.indexOf("/")) : null;

    branches.push({ name, isCurrent, isRemote, remoteName });
  }

  return branches;
};

export const remoteStageFiles = async (
  workspacePath: string,
  filePaths: string[]
): Promise<GitStageResult> => {
  if (filePaths.length === 0) {
    return { success: true, message: "No files to stage" };
  }
  try {
    await runRemoteGit(workspacePath, ["add", "--", ...filePaths]);
    return { success: true, message: "Files staged successfully" };
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : String(err) };
  }
};

export const remoteUnstageFiles = async (
  workspacePath: string,
  filePaths: string[]
): Promise<GitStageResult> => {
  if (filePaths.length === 0) {
    return { success: true, message: "No files to unstage" };
  }
  try {
    await runRemoteGit(workspacePath, ["reset", "HEAD", "--", ...filePaths]);
    return { success: true, message: "Files unstaged successfully" };
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : String(err) };
  }
};

export const remoteStageAll = async (
  workspacePath: string
): Promise<GitStageResult> => {
  try {
    await runRemoteGit(workspacePath, ["add", "--all"]);
    return { success: true, message: "All changes staged" };
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : String(err) };
  }
};

export const remoteUnstageAll = async (
  workspacePath: string
): Promise<GitStageResult> => {
  try {
    await runRemoteGit(workspacePath, ["reset", "HEAD"]);
    return { success: true, message: "All changes unstaged" };
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : String(err) };
  }
};

export const remoteCommitChanges = async (
  workspacePath: string,
  message: string
): Promise<GitCommitResult> => {
  if (!message.trim()) {
    return { success: false, message: "Commit message is required", hash: null };
  }

  try {
    await runRemoteGit(workspacePath, ["commit", "-m", message]);
    let hash: string | null = null;
    try {
      const head = (await runRemoteGit(workspacePath, ["rev-parse", "HEAD"])).trim();
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

export const remotePushChanges = async (
  workspacePath: string
): Promise<GitPushPullResult> => {
  try {
    const stdout = await withNetworkTimeout(
      runRemoteGit(workspacePath, ["push"])
    );
    const message = stdout.trim() ? stdout.trim() : "Push successful";
    return { success: true, message };
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : String(err) };
  }
};

export const remotePullChanges = async (
  workspacePath: string
): Promise<GitPushPullResult> => {
  try {
    const stdout = await withNetworkTimeout(
      runRemoteGit(workspacePath, ["pull"])
    );
    const message = stdout.trim() ? stdout.trim() : "Pull successful";
    return { success: true, message };
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : String(err) };
  }
};

export const remoteFetchRemote = async (
  workspacePath: string
): Promise<GitPushPullResult> => {
  try {
    const hasRemote = (await runRemoteGit(workspacePath, ["remote"])).trim();
    if (!hasRemote) {
      return { success: true, message: "No remote configured" };
    }
    await withNetworkTimeout(
      runRemoteGit(workspacePath, ["fetch", "--quiet", "--prune"])
    );
    return { success: true, message: "Fetch successful" };
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : String(err) };
  }
};

export const remoteCheckoutBranch = async (
  workspacePath: string,
  branchName: string
): Promise<GitCheckoutResult> => {
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

  // Remote tracking branch (e.g. "origin/main") — checkout the local name,
  // creating a tracking branch if it does not exist yet.
  const slashIdx = branchName.indexOf("/");
  if (slashIdx >= 0) {
    const localName = branchName.slice(slashIdx + 1);
    if (localName) {
      const localResult = await tryCheckout(localName);
      if (localResult.success) {
        return localResult;
      }
      try {
        await runRemoteGit(workspacePath, ["checkout", "-b", localName, branchName]);
        return {
          success: true,
          message: `Switched to ${localName} (tracking ${branchName})`,
        };
      } catch (err) {
        return {
          success: false,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    }
  }

  return tryCheckout(branchName);
};

export const remoteCreateBranch = async (
  workspacePath: string,
  branchName: string
): Promise<GitCheckoutResult> => {
  try {
    await runRemoteGit(workspacePath, ["checkout", "-b", branchName]);
    return { success: true, message: `Created and switched to ${branchName}` };
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : String(err) };
  }
};

export const remoteGetFileDiff = async (
  workspacePath: string,
  filePath: string,
  staged: boolean
): Promise<GitDiffResult> => {
  const diffArgs = staged
    ? ["diff", "--cached", "--", filePath]
    : ["diff", "--", filePath];

  try {
    let stdout = await runRemoteGit(workspacePath, diffArgs);

    if (stdout.includes("Binary files")) {
      // Git's heuristic may falsely flag text files as binary (e.g. files
      // containing NUL bytes). Retry with --text to force a text-mode diff.
      const textArgs = staged
        ? ["diff", "--cached", "--text", "--", filePath]
        : ["diff", "--text", "--", filePath];
      let textDiff = "";
      try {
        textDiff = await runRemoteGit(workspacePath, textArgs);
      } catch {
        // keep empty
      }
      if (textDiff) {
        return { content: textDiff, isBinary: false };
      }
      return { content: "Binary file - diff not available", isBinary: true };
    }

    // No diff and not staged: the file may be untracked (new). Generate a
    // full-file diff via `git diff --no-index /dev/null <file>`, which
    // exits with code 1 when files differ — handled by runRemoteGitRaw.
    if (!staged && !stdout) {
      const fullDiff = await runRemoteGitRaw(workspacePath, [
        "diff",
        "--no-index",
        "--text",
        "/dev/null",
        filePath,
      ]);
      if (fullDiff) {
        return { content: fullDiff, isBinary: false };
      }
    }

    return { content: stdout, isBinary: false };
  } catch (err) {
    return {
      content: err instanceof Error ? err.message : String(err),
      isBinary: false,
    };
  }
};

export const remoteDiscardChanges = async (
  workspacePath: string,
  filePaths: string[]
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
    return { success: false, message: err instanceof Error ? err.message : String(err) };
  }

  const pathSet = new Set(filePaths);
  const untracked: string[] = [];
  const tracked: string[] = [];

  for (const entry of statusOutput.split("\0")) {
    if (!entry) {
      continue;
    }
    // porcelain -z format: "XY<space><path>" (NUL-terminated, no quotes)
    const xy = entry.slice(0, 2);
    const path = entry.slice(3).trimStart().replace(/^"+/, "");
    if (pathSet.has(path)) {
      if (xy.startsWith("?")) {
        untracked.push(path);
      } else {
        tracked.push(path);
      }
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
      return { success: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  if (untracked.length > 0) {
    try {
      await runRemoteGit(workspacePath, ["clean", "-f", "--", ...untracked]);
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  return { success: true, message: "Changes discarded successfully" };
};

export const remoteGetGitLog = async (
  workspacePath: string,
  skip: number,
  limit: number
): Promise<GitLogEntry[]> => {
  const skipCount = skip > 0 ? Math.floor(skip) : 0;
  const maxCount = limit <= 0 ? 50 : Math.floor(limit);

  let output: string;
  try {
    output = await runRemoteGitRaw(workspacePath, [
      "log",
      "--all",
      "--decorate=full",
      "--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%D%x1f%P",
      "--date=iso",
      "--skip",
      String(skipCount),
      "--max-count",
      String(maxCount),
    ]);
  } catch {
    return [];
  }

  const entries: GitLogEntry[] = [];

  for (const line of output.split("\n")) {
    if (!line) {
      continue;
    }
    const parts = line.split("\x1f");
    if (parts.length < 8) {
      continue;
    }
    entries.push({
      hash: parts[0],
      shortHash: parts[1],
      author: parts[2],
      email: parts[3],
      date: parts[4],
      message: parts[5],
      refs: parts[6],
      parents: parts[7].split(/\s+/).filter(Boolean),
    });
  }

  return entries;
};

export const remoteGetCommitFiles = async (
  workspacePath: string,
  hash: string
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
  workspacePath: string
): Promise<string> => runRemoteGit(workspacePath, ["diff", "--cached"]);

export const remoteGetCommitDiff = async (
  workspacePath: string,
  hash: string
): Promise<GitDiffResult> => {
  const diffArgs = ["show", "--format=", "--find-renames", hash];

  try {
    let stdout = await runRemoteGit(workspacePath, diffArgs);

    if (stdout.includes("Binary files")) {
      // Git's heuristic may falsely flag text files as binary (e.g. files
      // containing NUL bytes). Retry with --text to force a text-mode diff.
      let textDiff = "";
      try {
        textDiff = await runRemoteGit(workspacePath, [
          "show",
          "--format=",
          "--text",
          hash,
        ]);
      } catch {
        // keep empty
      }
      if (textDiff) {
        return { content: textDiff, isBinary: false };
      }
      return { content: "Binary file - diff not available", isBinary: true };
    }

    return { content: stdout, isBinary: false };
  } catch (err) {
    return {
      content: err instanceof Error ? err.message : String(err),
      isBinary: false,
    };
  }
};

/** Diff of a single file within a single commit (`git show <hash> -- <path>`). */
export const remoteGetCommitFileDiff = async (
  workspacePath: string,
  hash: string,
  filePath: string
): Promise<GitDiffResult> => {
  const diffArgs = ["show", "--format=", "--find-renames", hash, "--", filePath];

  try {
    let stdout = await runRemoteGit(workspacePath, diffArgs);

    if (stdout.includes("Binary files")) {
      // Git's heuristic may falsely flag text files as binary (e.g. files
      // containing NUL bytes). Retry with --text to force a text-mode diff.
      let textDiff = "";
      try {
        textDiff = await runRemoteGit(workspacePath, [
          "show",
          "--format=",
          "--text",
          hash,
          "--",
          filePath,
        ]);
      } catch {
        // keep empty
      }
      if (textDiff) {
        return { content: textDiff, isBinary: false };
      }
      return { content: "Binary file - diff not available", isBinary: true };
    }

    return { content: stdout, isBinary: false };
  } catch (err) {
    return {
      content: err instanceof Error ? err.message : String(err),
      isBinary: false,
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
  workspacePath: string
): Promise<GitRepoInfo[]> => {
  const parsed = parseSshUrl(workspacePath);
  const remoteRootPath = normalizeRemotePath(parsed.remotePath);

  return withSshSession(workspacePath, async (sessionId) => {
    const repos: GitRepoInfo[] = [];

    const isRepoRoot = async (remotePath: string): Promise<boolean> => {
      try {
        const entries = await listSshDirectory(sessionId, remotePath);
        return entries.some((entry) => entry.name === ".git");
      } catch {
        return false;
      }
    };

    const getCurrentBranch = async (remotePath: string): Promise<string> => {
      try {
        const branch = (
          await executeSshCommand(
            sessionId,
            `cd -- ${shellQuote(remotePath)} && (git -c core.quotepath=false -c safe.directory=* rev-parse --abbrev-ref HEAD) || true`
          )
        )
          .trim();
        return !branch || branch === "HEAD" ? "" : branch;
      } catch {
        return "";
      }
    };

    const scan = async (
      remotePath: string,
      depth: number
    ): Promise<void> => {
      if (await isRepoRoot(remotePath)) {
        const uri = buildRemoteWorkspaceUri(workspacePath, remotePath, remoteRootPath);
        const name = remotePath.split("/").filter(Boolean).pop() ?? remotePath;
        repos.push({
          path: uri,
          name,
          currentBranch: await getCurrentBranch(remotePath),
        });
        return;
      }

      if (depth >= MAX_DISCOVERY_DEPTH) {
        return;
      }

      let entries;
      try {
        entries = await listSshDirectory(sessionId, remotePath);
      } catch {
        return;
      }

      for (const entry of entries) {
        if (!entry.isDirectory || SKIP_DIRS.has(entry.name)) {
          continue;
        }
        await scan(entry.path, depth + 1);
      }
    };

    // The workspace root itself may be a repo.
    if (await isRepoRoot(remoteRootPath)) {
      const uri = buildRemoteWorkspaceUri(workspacePath, remoteRootPath, remoteRootPath);
      const name =
        remoteRootPath.split("/").filter(Boolean).pop() ?? remoteRootPath;
      repos.push({
        path: uri,
        name,
        currentBranch: await getCurrentBranch(remoteRootPath),
      });
    } else {
      await scan(remoteRootPath, 0);
    }

    repos.sort((a, b) => a.path.localeCompare(b.path));
    return repos;
  });
};
