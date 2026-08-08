import { dirname } from "node:path/posix";
import { processFileContent } from "../utils/fileReader";
import {
  connectSsh,
  disconnectSsh,
  executeSshCommand,
  listSshDirectory,
  parseSshUrl,
  readSshFile,
  readSshFileWithVersion,
  isSshOperationError,
  toSshOperationErrorResult,
  writeSshFile,
  type SshConnectParams,
  type SshFileVersion,
  type SshFileWriteResult,
} from "./sshManager";
import { getDecryptedSecret, getSshCredential } from "./sshCredentials";
import {
  cancelRemoteJob,
  getRemoteJob,
  listRemoteJobs,
  startRemoteJob,
  type RemoteJobBackendKind,
  type RemoteJobMode,
} from "./remoteJobs";

const REMOTE_SEARCH_MAX_DEPTH = 15;
const REMOTE_SEARCH_MAX_RESULTS = 200;
// Mirrors the local ripgrep timeout in native/src/mcp/servers/grep.rs so the
// SSH branch cannot hang the tool card forever when the remote side stalls.
const REMOTE_GREP_TIMEOUT_MS = 30_000;

export type RemoteWorkspaceCommand = {
  operation: string;
  argsJson: string;
};

type RemoteWorkspaceCommandArgs = {
  filePath?: unknown;
  startLine?: unknown;
  endLine?: unknown;
  searchContent?: unknown;
  replaceContent?: unknown;
  occurrence?: unknown;
  content?: unknown;
  overwrite?: unknown;
  pattern?: unknown;
  path?: unknown;
  fileGlob?: unknown;
  isRegex?: unknown;
  caseSensitive?: unknown;
  maxResults?: unknown;
  command?: unknown;
  workingDirectory?: unknown;
  timeout?: unknown;
  durable?: unknown;
  backend?: unknown;
  mode?: unknown;
  jobId?: unknown;
  offset?: unknown;
  limit?: unknown;
  workspaceId?: unknown;
  conversationId?: unknown;
  toolCallId?: unknown;
  workspaceRoot?: unknown;
};

type RemoteWorkspaceSearchMatch = {
  file: string;
  line: number;
  content: string;
};

export const shellQuote = (value: string): string =>
  `'${value.replace(/'/g, `'"'"'`)}'`;

export const normalizeRemotePath = (path: string): string => {
  const normalized = path.replace(/\/+$/, "");
  return normalized || "/";
};

const validateSshWorkspacePath = (path: unknown, fieldName: string): string => {
  if (typeof path !== "string" || !path.trim().startsWith("ssh://")) {
    throw new Error(`${fieldName} must be an SSH workspace path`);
  }
  return path.trim();
};

const getRemotePathName = (path: string): string => {
  const normalizedPath = normalizeRemotePath(path);
  const separatorIndex = normalizedPath.lastIndexOf("/");
  return normalizedPath.slice(separatorIndex + 1) || "/";
};

const getRemoteRelativePath = (path: string, rootPath: string): string => {
  const normalizedPath = normalizeRemotePath(path);
  const normalizedRoot = normalizeRemotePath(rootPath);

  if (normalizedPath === normalizedRoot) {
    return ".";
  }
  if (normalizedRoot === "/") {
    return normalizedPath.replace(/^\/+/, "");
  }
  if (normalizedPath.startsWith(`${normalizedRoot}/`)) {
    return normalizedPath.slice(normalizedRoot.length + 1);
  }

  return normalizedPath.replace(/^\/+/, "");
};

export const buildRemoteWorkspaceUri = (
  workspacePath: string,
  remotePath: string,
  remoteRootPath: string
): string => {
  const relativePath = getRemoteRelativePath(remotePath, remoteRootPath);
  const normalizedWorkspacePath = workspacePath.replace(/\/+$/, "");

  return relativePath === "."
    ? normalizedWorkspacePath
    : `${normalizedWorkspacePath}/${relativePath}`;
};

export const buildSshConnectParams = (workspacePath: string): SshConnectParams => {
  const parsed = parseSshUrl(workspacePath);
  const credential = getSshCredential(
    parsed.host,
    parsed.port,
    parsed.username
  );
  const connectParams: SshConnectParams = {
    host: parsed.host,
    port: parsed.port,
    username: parsed.username,
    authMethod: credential?.authMethod ?? "password",
  };

  if (credential?.privateKeyPath) {
    connectParams.privateKeyPath = credential.privateKeyPath;
  }

  const secret = credential?.encryptedSecret
    ? getDecryptedSecret(parsed.host, parsed.port, parsed.username)
    : null;
  if (secret) {
    if (connectParams.authMethod === "password") {
      connectParams.password = secret;
    } else {
      connectParams.passphrase = secret;
    }
  }

  return connectParams;
};

export const withSshSession = async <T>(
  workspacePath: string,
  action: (
    sessionId: string,
    remotePath: string,
    parsedPath: ReturnType<typeof parseSshUrl>
  ) => Promise<T>,
  options?: { signal?: AbortSignal }
): Promise<T> => {
  const parsedPath = parseSshUrl(workspacePath);
  const sessionId = await connectSsh(buildSshConnectParams(workspacePath), options);
  try {
    return await action(sessionId, parsedPath.remotePath, parsedPath);
  } finally {
    disconnectSsh(sessionId);
  }
};

const readTextFile = async (
  workspacePath: string,
  startLine: number | undefined,
  endLine: number | undefined,
  signal?: AbortSignal
): Promise<Record<string, unknown>> => {
  return withSshSession(workspacePath, async (sessionId, remotePath) => {
    const file = processFileContent(
      remotePath,
      await readSshFile(sessionId, remotePath, { signal })
    );
    if (file.isBinary || file.isImage) {
      throw new Error("Remote filesystem edit operations require a text file");
    }

    const lines = file.content.split("\n");
    const totalLines = lines.length;
    const requestedStart = Math.max(1, Math.floor(startLine ?? 1));
    const requestedEnd = Math.max(
      requestedStart,
      Math.floor(endLine ?? totalLines)
    );
    const selected = lines.slice(requestedStart - 1, requestedEnd);

    return {
      content: selected
        .map(
          (line, index) =>
            `${String(requestedStart + index).padStart(6, " ")}: ${line}`
        )
        .join("\n"),
      totalLines,
      startLine: requestedStart,
      endLine: Math.min(requestedEnd, totalLines),
    };
  }, { signal });
};

const resolveAuthorizedWorkspaceRoot = (
  workspacePath: string,
  workspaceRoot: unknown
): string => {
  const root = validateSshWorkspacePath(workspaceRoot, "workspaceRoot");
  const target = parseSshUrl(workspacePath);
  const authorized = parseSshUrl(root);
  if (
    target.host !== authorized.host ||
    target.port !== authorized.port ||
    target.username !== authorized.username
  ) {
    throw new Error("workspaceRoot must use the same SSH authority as filePath");
  }
  return authorized.remotePath;
};

const readRemoteText = async (
  workspacePath: string,
  signal?: AbortSignal
): Promise<{ content: string; version: SshFileVersion }> =>
  withSshSession(workspacePath, async (sessionId, remotePath) => {
    const loaded = await readSshFileWithVersion(sessionId, remotePath, {
      signal,
    });
    const file = processFileContent(
      remotePath,
      loaded.content
    );
    if (file.isBinary || file.isImage) {
      throw new Error("Remote filesystem edit operations require a text file");
    }
    return { content: file.content, version: loaded.version };
  }, { signal });

const writeRemoteText = async (
  workspacePath: string,
  workspaceRoot: string,
  content: string,
  expectedVersion: SshFileVersion,
  signal?: AbortSignal
): Promise<SshFileWriteResult> =>
  withSshSession(
    workspacePath,
    async (sessionId, remotePath) =>
      writeSshFile(sessionId, remotePath, content, {
        signal,
        workspaceRoot,
        expectedVersion,
      }),
    { signal }
  );

/**
 * Read the project ROLE.md from a remote SSH workspace.
 *
 * Mirrors RoleEditorPanel's SSH access path (`<remotePath>/ROLE.md`) so the
 * Rust prompt builder can inject the project role even for `ssh://`
 * workspaces. Returns `null` when the file does not exist, is binary, or SSH
 * is unavailable — callers then fall back to the global ROLE.md.
 */
export type RemoteRoleContext = {
  content: string | null;
  includeGlobalRules: boolean;
};

export const readRemoteRoleContext = async (
  workspacePath: string
): Promise<RemoteRoleContext> => {
  try {
    return await withSshSession(
      workspacePath,
      async (sessionId, remotePath) => {
        const projectRoot = remotePath.replace(/\/+$/, "");
        const rolePath = `${projectRoot}/ROLE.md`;
        let content: string | null = null;
        try {
          const file = processFileContent(
            rolePath,
            await readSshFile(sessionId, rolePath)
          );
          if (!file.isBinary && !file.isImage) {
            content = file.content.trim() || null;
          }
        } catch {
          content = null;
        }

        let includeGlobalRules = true;
        try {
          const settingsPath = `${projectRoot}/.snow/settings.json`;
          const settingsFile = processFileContent(
            settingsPath,
            await readSshFile(sessionId, settingsPath)
          );
          if (!settingsFile.isBinary && !settingsFile.isImage) {
            const settings = JSON.parse(settingsFile.content) as {
              role?: { includeGlobalRules?: unknown };
            };
            if (typeof settings.role?.includeGlobalRules === "boolean") {
              includeGlobalRules = settings.role.includeGlobalRules;
            }
          }
        } catch {
          includeGlobalRules = true;
        }

        return { content, includeGlobalRules };
      }
    );
  } catch {
    return { content: null, includeGlobalRules: true };
  }
};

const buildRemoteMkdirCommand = (remotePath: string): string =>
  `mkdir -p -- ${shellQuote(remotePath)}`;

const buildRemoteStatCommand = (remotePath: string): string =>
  `if [ -e ${shellQuote(remotePath)} ]; then printf present; fi`;

const ensureString = (value: unknown, fieldName: string): string => {
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string`);
  }
  return value;
};

const ensureOptionalPositiveInteger = (value: unknown): number | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Line range values must be finite numbers");
  }
  return Math.max(1, Math.floor(value));
};

const replaceContent = (
  content: string,
  searchContent: string,
  replacement: string,
  occurrence: number
): { content: string; matchedLineStart: number; matchedLineEnd: number } => {
  if (occurrence < 1) {
    throw new Error("occurrence must be greater than zero");
  }

  let offset = 0;
  let foundIndex = -1;
  for (let index = 0; index < occurrence; index += 1) {
    foundIndex = content.indexOf(searchContent, offset);
    if (foundIndex < 0) {
      throw new Error("searchContent not found in remote file");
    }
    offset = foundIndex + Math.max(1, searchContent.length);
  }

  const prefix = content.slice(0, foundIndex);
  const matchedLineStart = prefix.split("\n").length;
  const matchedLineEnd =
    matchedLineStart + searchContent.split("\n").length - 1;
  return {
    content: `${prefix}${replacement}${content.slice(
      foundIndex + searchContent.length
    )}`,
    matchedLineStart,
    matchedLineEnd,
  };
};

const shellGlobExpression = (fileGlob: string | undefined): string => {
  if (!fileGlob) {
    return "*";
  }
  return fileGlob;
};

const buildRemoteGrepCommand = (
  remotePath: string,
  pattern: string,
  fileGlob: string | undefined,
  isRegex: boolean,
  caseSensitive: boolean,
  maxResults: number
): string => {
  const flags = ["-nH"];
  if (!isRegex) {
    flags.push("-F");
  }
  if (!caseSensitive) {
    flags.push("-i");
  }
  flags.push(
    "--exclude-dir=.git",
    "--exclude-dir=node_modules",
    "--exclude-dir=target"
  );
  const glob = shellGlobExpression(fileGlob);
  const script = [
    `root=${shellQuote(remotePath)}`,
    `pattern=${shellQuote(pattern)}`,
    `glob=${shellQuote(glob)}`,
    `limit=${Math.max(1, maxResults)}`,
    `grep ${flags.map(shellQuote).join(" ")} -- ${shellQuote(
      pattern
    )} $(find "$root" -type f -path "$root/$glob" -print) 2>/dev/null | head -n "$limit" || true`,
  ].join("\n");

  return `sh -lc ${shellQuote(script)}`;
};

const parseGrepLines = (
  output: string,
  workspacePath: string,
  remoteRootPath: string
): RemoteWorkspaceSearchMatch[] =>
  output.split("\n").flatMap((line) => {
    // Parse from the LEFT: `path:line:content` with the FIRST `:<digits>:`
    // pair as the separator. Content may contain colons (e.g. `case "x": y`),
    // so splitting from the last two colons would misparse the line number
    // and silently drop the match. File paths with embedded colons are
    // extremely rare on POSIX, and the lazy quantifier still skips them when
    // a `:<digits>:` separator exists later in the line.
    const parsed = /^(.+?):(\d+):(.*)$/.exec(line);
    if (!parsed) {
      return [];
    }
    const lineNumber = Number(parsed[2]);
    if (!Number.isInteger(lineNumber)) {
      return [];
    }
    return [
      {
        file: buildRemoteWorkspaceUri(
          workspacePath,
          parsed[1],
          remoteRootPath
        ),
        line: lineNumber,
        content: parsed[3],
      },
    ];
  });

const executeFilesystemRead = async (
  args: RemoteWorkspaceCommandArgs,
  signal?: AbortSignal
): Promise<Record<string, unknown>> => {
  const workspacePath = validateSshWorkspacePath(args.filePath, "filePath");
  const startLine = ensureOptionalPositiveInteger(args.startLine);
  const endLine = ensureOptionalPositiveInteger(args.endLine);

  return withSshSession(workspacePath, async (sessionId, remotePath) => {
    try {
      const entries = await listSshDirectory(sessionId, remotePath, { signal });
      return {
        content: entries
          .map((entry) => `${entry.name}${entry.isDirectory ? "/" : ""}`)
          .join("\n"),
      };
    } catch (error) {
      if (isSshOperationError(error)) {
        throw error;
      }
      return readTextFile(workspacePath, startLine, endLine, signal);
    }
  }, { signal });
};

const executeFilesystemReplaceEdit = async (
  args: RemoteWorkspaceCommandArgs,
  signal?: AbortSignal
): Promise<Record<string, unknown>> => {
  const workspacePath = validateSshWorkspacePath(args.filePath, "filePath");
  const workspaceRoot = resolveAuthorizedWorkspaceRoot(
    workspacePath,
    args.workspaceRoot
  );
  const searchContent = ensureString(args.searchContent, "searchContent");
  const replacement = ensureString(args.replaceContent, "replaceContent");
  const occurrence =
    typeof args.occurrence === "number" && Number.isFinite(args.occurrence)
      ? Math.floor(args.occurrence)
      : 1;
  const loaded = await readRemoteText(workspacePath, signal);
  const result = replaceContent(
    loaded.content,
    searchContent,
    replacement,
    occurrence
  );
  const save = await writeRemoteText(
    workspacePath,
    workspaceRoot,
    result.content,
    loaded.version,
    signal
  );

  return {
    success: true,
    occurrence,
    matchType: "exact",
    matchedLineStart: result.matchedLineStart,
    matchedLineEnd: result.matchedLineEnd,
    saveGuarantee: save.guarantee,
    sideEffect: save.sideEffect,
  };
};

const executeFilesystemCreate = async (
  args: RemoteWorkspaceCommandArgs,
  signal?: AbortSignal
): Promise<Record<string, unknown>> => {
  const workspacePath = validateSshWorkspacePath(args.filePath, "filePath");
  const workspaceRoot = resolveAuthorizedWorkspaceRoot(
    workspacePath,
    args.workspaceRoot
  );
  const content = ensureString(args.content, "content");
  const overwrite = args.overwrite === true;

  const save = await withSshSession(workspacePath, async (sessionId, remotePath) => {
    const exists = (
      await executeSshCommand(sessionId, buildRemoteStatCommand(remotePath), {
        signal,
      })
    ).trim();
    if (exists && !overwrite) {
      throw new Error(
        "Remote file already exists. To overwrite this file, set overwrite=true."
      );
    }
    const parentPath = dirname(remotePath);
    if (parentPath && parentPath !== ".") {
      await executeSshCommand(sessionId, buildRemoteMkdirCommand(parentPath), {
        signal,
      });
    }
    const expectedVersion: SshFileVersion = exists
      ? (await readSshFileWithVersion(sessionId, remotePath, { signal })).version
      : { exists: false };
    return writeSshFile(sessionId, remotePath, content, {
      signal,
      workspaceRoot,
      expectedVersion,
    });
  }, { signal });

  return {
    success: true,
    path: workspacePath,
    bytes: Buffer.byteLength(content, "utf8"),
    lines: content.split("\n").length,
    saveGuarantee: save.guarantee,
    sideEffect: save.sideEffect,
  };
};

const executeGrepSearch = async (
  args: RemoteWorkspaceCommandArgs,
  signal?: AbortSignal
): Promise<Record<string, unknown>> => {
  const workspacePath = validateSshWorkspacePath(args.path, "path");
  const pattern = ensureString(args.pattern, "pattern");
  const fileGlob =
    typeof args.fileGlob === "string" && args.fileGlob.trim()
      ? args.fileGlob.trim()
      : undefined;
  const isRegex = args.isRegex !== false;
  const caseSensitive = args.caseSensitive !== false;
  const maxResults =
    typeof args.maxResults === "number" && Number.isFinite(args.maxResults)
      ? Math.max(1, Math.floor(args.maxResults))
      : 100;

  return withSshSession(workspacePath, async (sessionId, remotePath) => {
    const output = await executeSshCommand(
      sessionId,
      buildRemoteGrepCommand(
        remotePath,
        pattern,
        fileGlob,
        isRegex,
        caseSensitive,
        maxResults
      ),
      { timeoutMs: REMOTE_GREP_TIMEOUT_MS, signal }
    );
    const matches = parseGrepLines(output, workspacePath, remotePath);
    return {
      backend: "remote-grep",
      pattern,
      path: workspacePath,
      fileGlob,
      matches,
      totalMatches: matches.length,
      truncated: matches.length >= maxResults,
      rawOutput: output.slice(0, 50_000),
    };
  }, { signal });
};

const executeBashCommand = async (
  args: RemoteWorkspaceCommandArgs,
  signal?: AbortSignal
): Promise<Record<string, unknown>> => {
  const workspacePath = validateSshWorkspacePath(
    args.workingDirectory,
    "workingDirectory"
  );
  const command = ensureString(args.command, "command");
  const timeout =
    typeof args.timeout === "number" && Number.isFinite(args.timeout)
      ? Math.max(1, Math.floor(args.timeout))
      : 30_000;
  const durable = args.durable === true;
  const backend =
    args.backend === "snow-agent" ||
    args.backend === "systemd-user" ||
    args.backend === "tmux" ||
    args.backend === "posix-detach"
      ? (args.backend as RemoteJobBackendKind)
      : undefined;
  if (args.backend !== undefined && !backend) {
    throw new Error("Unsupported Remote Job backend");
  }

  if (durable) {
    const mode = remoteJobMode(args.mode);
    const job = await startRemoteJob({
      workspacePath,
      workspaceId:
        typeof args.workspaceId === "string" ? args.workspaceId : undefined,
      command,
      timeoutMs: timeout,
      backend,
      mode,
      jobId: typeof args.jobId === "string" ? args.jobId : undefined,
      conversationId:
        typeof args.conversationId === "string"
          ? args.conversationId
          : undefined,
      toolCallId:
        typeof args.toolCallId === "string" ? args.toolCallId : undefined,
    }, { signal, cancellationPolicy: "cancel_remote" });
    const accepted =
      job.status === "preparing" ||
      job.status === "launching" ||
      job.status === "running";
    return {
      accepted,
      durable: true,
      job,
      message:
        accepted
          ? "Remote Job accepted. Use remote-job-status or remote-job-read to continue analysis."
          : "Remote Job launch is not confirmed. Use remote-job-status before retrying.",
    };
  }

  return withSshSession(workspacePath, async (sessionId, remotePath) => {
    const wrappedCommand = `cd -- ${shellQuote(remotePath)} && ${command}`;
    // The timeout lives inside executeSshCommand so a timed-out command also
    // closes the exec channel and signals the remote process instead of
    // merely racing the promise and leaking the underlying process.
    const output = await executeSshCommand(sessionId, wrappedCommand, {
      timeoutMs: timeout,
      signal,
    });

    return {
      stdout: output,
      stderr: "",
      exitCode: 0,
      command,
      executedAt: new Date().toISOString(),
    };
  }, { signal });
};

const ensureRemoteJobId = (value: unknown): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("jobId is required");
  }
  return value.trim();
};

const remoteJobMode = (value: unknown): RemoteJobMode | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (value === "batch" || value === "interactive") {
    return value;
  }
  throw new Error("Unsupported Remote Job mode");
};

const remoteJobReadOptions = (
  args: RemoteWorkspaceCommandArgs
): { offset?: number; limit?: number } => {
  const normalize = (value: unknown, name: string): number | undefined => {
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`${name} must be a non-negative number`);
    }
    return Math.floor(value);
  };
  return {
    offset: normalize(args.offset, "offset"),
    limit: normalize(args.limit, "limit"),
  };
};

const executeRemoteJobStart = async (
  args: RemoteWorkspaceCommandArgs,
  signal?: AbortSignal
): Promise<Record<string, unknown>> => {
  const workspacePath = validateSshWorkspacePath(
    args.workingDirectory,
    "workingDirectory"
  );
  const command = ensureString(args.command, "command");
  const timeout =
    typeof args.timeout === "number" && Number.isFinite(args.timeout)
      ? Math.max(1, Math.floor(args.timeout))
      : undefined;
  const backend =
    args.backend === "systemd-user" ||
    args.backend === "tmux" ||
    args.backend === "posix-detach"
      ? (args.backend as RemoteJobBackendKind)
      : undefined;
  if (args.backend !== undefined && !backend) {
    throw new Error("Unsupported Remote Job backend");
  }
  const mode = remoteJobMode(args.mode);
  const job = await startRemoteJob({
    workspacePath,
    workspaceId:
      typeof args.workspaceId === "string" ? args.workspaceId : undefined,
    command,
    timeoutMs: timeout,
    backend,
    mode,
    jobId: typeof args.jobId === "string" ? args.jobId : undefined,
    conversationId:
      typeof args.conversationId === "string" ? args.conversationId : undefined,
    toolCallId: typeof args.toolCallId === "string" ? args.toolCallId : undefined,
  }, { signal, cancellationPolicy: "cancel_remote" });
  return {
    accepted:
      job.status === "preparing" ||
      job.status === "launching" ||
      job.status === "running",
    job,
  };
};

const executeRemoteJobStatus = async (
  args: RemoteWorkspaceCommandArgs
): Promise<Record<string, unknown>> => {
  const job = await getRemoteJob(ensureRemoteJobId(args.jobId), {
    offset: 0,
    limit: 1,
  });
  return { job: job.job, state: job.state };
};

const executeRemoteJobRead = async (
  args: RemoteWorkspaceCommandArgs
): Promise<Record<string, unknown>> => {
  const result = await getRemoteJob(
    ensureRemoteJobId(args.jobId),
    remoteJobReadOptions(args)
  );
  return {
    job: result.job,
    state: result.state,
    output: result.output,
    offset: result.offset,
    nextOffset: result.nextOffset,
    eof: result.eof,
  };
};

const executeRemoteJobCancel = async (
  args: RemoteWorkspaceCommandArgs
): Promise<Record<string, unknown>> => ({
  job: await cancelRemoteJob(ensureRemoteJobId(args.jobId)),
});

const executeRemoteJobList = async (
  args: RemoteWorkspaceCommandArgs
): Promise<Record<string, unknown>> => {
  const workspacePath =
    typeof args.workingDirectory === "string" && args.workingDirectory.trim()
      ? validateSshWorkspacePath(args.workingDirectory, "workingDirectory")
      : undefined;
  return { jobs: await listRemoteJobs(workspacePath) };
};

export const dispatchRemoteWorkspaceCommand = async (
  command: RemoteWorkspaceCommand,
  options?: { signal?: AbortSignal }
): Promise<string> => {
  const signal = options?.signal;
  let args: RemoteWorkspaceCommandArgs;
  try {
    args = JSON.parse(command.argsJson) as RemoteWorkspaceCommandArgs;
  } catch {
    throw new Error("Remote workspace command arguments must be valid JSON");
  }

  try {
    let result: Record<string, unknown>;
    switch (command.operation) {
      case "filesystem-read":
        result = await executeFilesystemRead(args, signal);
        break;
      case "filesystem-replace_edit":
        result = await executeFilesystemReplaceEdit(args, signal);
        break;
      case "filesystem-create":
        result = await executeFilesystemCreate(args, signal);
        break;
      case "grep-search":
        result = await executeGrepSearch(args, signal);
        break;
      case "bash-terminal-execute":
        result = await executeBashCommand(args, signal);
        break;
      case "remote-job-start":
        result = await executeRemoteJobStart(args, signal);
        break;
      case "remote-job-status":
        result = await executeRemoteJobStatus(args);
        break;
      case "remote-job-read":
        result = await executeRemoteJobRead(args);
        break;
      case "remote-job-cancel":
        result = await executeRemoteJobCancel(args);
        break;
      case "remote-job-list":
        result = await executeRemoteJobList(args);
        break;
      default:
        throw new Error(
          `Unsupported remote workspace operation: ${command.operation}`
        );
    }
    return JSON.stringify(result);
  } catch (error) {
    if (isSshOperationError(error)) {
      return JSON.stringify({
        success: false,
        error: toSshOperationErrorResult(error),
      });
    }
    throw error;
  }
};
