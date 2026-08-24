import { dirname } from "node:path/posix";
import { processFileContent } from "../utils/fileReader";
import {
  connectSsh,
  deleteSshFile,
  disconnectSsh,
  executeSshCommand,
  getSshProfileKey,
  getSshSession,
  listSshDirectory,
  parseSshUrl,
  readSshFile,
  readSshFileWithVersion,
  removeEmptySshDirectory,
  statSshEntry,
  isSshOperationError,
  toSshOperationErrorResult,
  writeInternalSshFile,
  writeSshFile,
  type SshConnectParams,
  type SshFileVersion,
  type SshFileWriteResult,
} from "./sshManager";
import { getDecryptedSecret, getSshCredential } from "./sshCredentials";
import {
  abortCheckpointScan,
  registerCheckpointScanAbort,
  unregisterCheckpointScanAbort,
} from "./sshCommandRegistry";

const REMOTE_SEARCH_MAX_DEPTH = 15;
const REMOTE_SEARCH_MAX_RESULTS = 200;
// Mirrors the local ripgrep timeout in native/src/mcp/servers/grep.rs so the
// SSH branch cannot hang the tool card forever when the remote side stalls.
const REMOTE_GREP_TIMEOUT_MS = 30_000;
const CODELENS_MAX_SOURCE_BYTES = 512 * 1024;

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
  contentBase64?: unknown;
  paths?: unknown;
  scanId?: unknown;
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
  remoteRootPath: string,
): string => {
  const relativePath = getRemoteRelativePath(remotePath, remoteRootPath);
  const normalizedWorkspacePath = workspacePath.replace(/\/+$/, "");

  return relativePath === "."
    ? normalizedWorkspacePath
    : `${normalizedWorkspacePath}/${relativePath}`;
};

export const buildSshConnectParams = (
  workspacePath: string,
): SshConnectParams => {
  const parsed = parseSshUrl(workspacePath);
  const credential = getSshCredential(
    parsed.host,
    parsed.port,
    parsed.username,
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

// ============================================================================
// 命令会话连接池：远程工作区命令（工具 IO、checkpoint 快照等）频率高且
// 多为短操作，逐命令新建 SSH 连接（TCP + 密钥交换 + 认证 + SFTP 子系统）
// 是 SSH 工作区最大的性能瓶颈。池按 host:port:user 复用会话，引用计数归
// 零后保留一段空闲时间再断开；传输层意外断开时下一次 acquire 自动重连。
// ============================================================================

type PooledCommandSession = {
  sessionId?: string;
  refs: number;
  idleTimer?: NodeJS.Timeout;
  connectPromise?: Promise<string>;
};

const COMMAND_SESSION_IDLE_TIMEOUT_MS = 60_000;
const commandSessionPool = new Map<string, PooledCommandSession>();

const releaseCommandSession = (profileKey: string): void => {
  const entry = commandSessionPool.get(profileKey);
  if (!entry) {
    return;
  }
  entry.refs = Math.max(0, entry.refs - 1);
  if (entry.refs > 0 || entry.idleTimer) {
    return;
  }
  entry.idleTimer = setTimeout(() => {
    entry.idleTimer = undefined;
    if (entry.refs > 0) {
      return;
    }
    if (entry.sessionId) {
      disconnectSsh(entry.sessionId);
    }
    commandSessionPool.delete(profileKey);
  }, COMMAND_SESSION_IDLE_TIMEOUT_MS);
};

const acquireCommandSession = async (
  params: SshConnectParams,
  options?: { signal?: AbortSignal },
): Promise<{ profileKey: string; sessionId: string }> => {
  const profileKey = getSshProfileKey(params);
  let entry = commandSessionPool.get(profileKey);
  if (!entry) {
    entry = { refs: 0 };
    commandSessionPool.set(profileKey, entry);
  }
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
  }
  entry.refs += 1;
  const poolEntry = entry;
  try {
    if (poolEntry.sessionId && getSshSession(poolEntry.sessionId)) {
      return { profileKey, sessionId: poolEntry.sessionId };
    }
    // 会话不存在或传输层已断开：（并发安全地）发起一次重连。
    poolEntry.sessionId = undefined;
    if (!poolEntry.connectPromise) {
      poolEntry.connectPromise = connectSsh(params, options).finally(() => {
        poolEntry.connectPromise = undefined;
      });
    }
    const sessionId = await poolEntry.connectPromise;
    poolEntry.sessionId = sessionId;
    return { profileKey, sessionId };
  } catch (error) {
    releaseCommandSession(profileKey);
    throw error;
  }
};

export const withSshSession = async <T>(
  workspacePath: string,
  action: (
    sessionId: string,
    remotePath: string,
    parsedPath: ReturnType<typeof parseSshUrl>,
  ) => Promise<T>,
  options?: { signal?: AbortSignal },
): Promise<T> => {
  const parsedPath = parseSshUrl(workspacePath);
  const { profileKey, sessionId } = await acquireCommandSession(
    buildSshConnectParams(workspacePath),
    options,
  );
  try {
    return await action(sessionId, parsedPath.remotePath, parsedPath);
  } finally {
    releaseCommandSession(profileKey);
  }
};

// 有界并发映射：SFTP 请求在同一通道上多路复用，限制并发数即可在
// 批量操作中同时压满带宽又不挤爆远程 sftp-server。
const mapWithConcurrency = async <T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
};

const readTextFile = async (
  workspacePath: string,
  startLine: number | undefined,
  endLine: number | undefined,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> => {
  return withSshSession(
    workspacePath,
    async (sessionId, remotePath) => {
      const file = processFileContent(
        remotePath,
        await readSshFile(sessionId, remotePath, { signal }),
      );
      if (file.isBinary || file.isImage) {
        throw new Error(
          "Remote filesystem edit operations require a text file",
        );
      }

      const lines = file.content.split("\n");
      const totalLines = lines.length;
      const requestedStart = Math.max(1, Math.floor(startLine ?? 1));
      const requestedEnd = Math.max(
        requestedStart,
        Math.floor(endLine ?? totalLines),
      );
      const selected = lines.slice(requestedStart - 1, requestedEnd);

      return {
        content: selected
          .map(
            (line, index) =>
              `${String(requestedStart + index).padStart(6, " ")}: ${line}`,
          )
          .join("\n"),
        totalLines,
        startLine: requestedStart,
        endLine: Math.min(requestedEnd, totalLines),
      };
    },
    { signal },
  );
};

const resolveAuthorizedWorkspaceRoot = (
  workspacePath: string,
  workspaceRoot: unknown,
): string => {
  const root = validateSshWorkspacePath(workspaceRoot, "workspaceRoot");
  const target = parseSshUrl(workspacePath);
  const authorized = parseSshUrl(root);
  if (
    target.host !== authorized.host ||
    target.port !== authorized.port ||
    target.username !== authorized.username
  ) {
    throw new Error(
      "workspaceRoot must use the same SSH authority as filePath",
    );
  }
  return authorized.remotePath;
};

const readRemoteText = async (
  workspacePath: string,
  signal?: AbortSignal,
): Promise<{ content: string; version: SshFileVersion }> =>
  withSshSession(
    workspacePath,
    async (sessionId, remotePath) => {
      const loaded = await readSshFileWithVersion(sessionId, remotePath, {
        signal,
      });
      const file = processFileContent(remotePath, loaded.content);
      if (file.isBinary || file.isImage) {
        throw new Error(
          "Remote filesystem edit operations require a text file",
        );
      }
      return { content: file.content, version: loaded.version };
    },
    { signal },
  );

const writeRemoteText = async (
  workspacePath: string,
  workspaceRoot: string,
  content: string,
  expectedVersion: SshFileVersion,
  signal?: AbortSignal,
): Promise<SshFileWriteResult> =>
  withSshSession(
    workspacePath,
    async (sessionId, remotePath) =>
      writeSshFile(sessionId, remotePath, content, {
        signal,
        workspaceRoot,
        expectedVersion,
      }),
    { signal },
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
  workspacePath: string,
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
            await readSshFile(sessionId, rolePath),
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
            await readSshFile(sessionId, settingsPath),
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
      },
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

const isIndentationSensitivePath = (filePath: string): boolean => {
  const fileName =
    filePath.split(/[\\/]/).pop()?.toLowerCase() ?? filePath.toLowerCase();
  return (
    ["makefile", "gnumakefile", "snakefile"].includes(fileName) ||
    [".mk", ".py", ".pyw", ".pyi", ".yaml", ".yml"].some((suffix) =>
      fileName.endsWith(suffix),
    )
  );
};

const normalizeLineEndingsForMatch = (content: string): string =>
  content.replace(/\r\n/g, "\n").replace(/\r/g, "");

const adaptLineEndings = (text: string, fileContent: string): string => {
  if (!text || !fileContent) {
    return text;
  }
  const crlfCount = (fileContent.match(/\r\n/g) ?? []).length;
  const lfCount = (fileContent.match(/\n/g) ?? []).length;
  if (crlfCount > lfCount - crlfCount) {
    return normalizeLineEndingsForMatch(text).replace(/\n/g, "\r\n");
  }
  return normalizeLineEndingsForMatch(text);
};

const getLeadingHorizontalWhitespace = (line: string): string =>
  line.match(/^[ \t]*/)?.[0] ?? "";

const getFirstNonEmptyLine = (content: string): string | undefined =>
  content
    .split("\n")
    .find((line) => line.replace(/[ \t\r\ufeff]/g, "").length > 0);

const autoPadFirstLineToReference = (
  referenceLine: string,
  text: string,
): string | null => {
  const indent = getLeadingHorizontalWhitespace(referenceLine);
  if (!indent) {
    return null;
  }

  const lines = text.split("\n");
  const paddedLines = [...lines];
  const firstIndex = lines.findIndex(
    (line) => line.replace(/[ \t]/g, "").length > 0,
  );
  if (firstIndex < 0) {
    return null;
  }
  const firstLine = lines[firstIndex];
  if (getLeadingHorizontalWhitespace(firstLine) !== "") {
    return null;
  }
  paddedLines[firstIndex] = indent + firstLine;
  const padded = paddedLines.join("\n");
  return padded === text ? null : padded;
};

const autoPadSearchIndentation = (
  content: string,
  searchContent: string,
): string | null => {
  const fileLines = content.split("\n");
  const paddedLines: string[] = [];
  let changed = false;

  for (const searchLine of searchContent.split("\n")) {
    const trimmed = searchLine.replace(/^[ \t]+/, "");
    if (!trimmed) {
      paddedLines.push(searchLine);
      continue;
    }

    let matchedIndent: string | undefined;
    let found = false;
    for (const fileLine of fileLines) {
      if (fileLine.replace(/^[ \t]+/, "") !== trimmed) {
        continue;
      }
      found = true;
      const indent = getLeadingHorizontalWhitespace(fileLine);
      if (matchedIndent !== undefined && matchedIndent !== indent) {
        return null;
      }
      matchedIndent = indent;
    }
    if (!found) {
      return null;
    }

    const indent = matchedIndent ?? "";
    if (getLeadingHorizontalWhitespace(searchLine) !== indent) {
      changed = true;
    }
    paddedLines.push(indent + trimmed);
  }

  return changed ? paddedLines.join("\n") : null;
};

const validateCandidateIndentation = (
  filePath: string,
  matchedLine: string,
  candidateLine: string,
  candidateName: string,
): void => {
  const matchedIndent = getLeadingHorizontalWhitespace(matchedLine);
  const candidateIndent = getLeadingHorizontalWhitespace(candidateLine);
  if (matchedIndent === candidateIndent) {
    return;
  }

  throw new Error(
    `Edit rejected: leading indentation mismatch in indentation-sensitive file '${filePath}'. The matched region starts with ${JSON.stringify(
      matchedIndent,
    )} (${
      [...matchedIndent].length
    } characters), but ${candidateName} starts with ${JSON.stringify(
      candidateIndent,
    )} (${
      [...candidateIndent].length
    } characters). Copy the leading spaces/tabs from the matched region exactly; remote filesystem-replace_edit refuses to apply this edit to avoid silently breaking Python/YAML/Makefile structure.`,
  );
};

const validateSearchIndentation = (
  filePath: string,
  searchContent: string,
  matchedContent: string,
): void => {
  if (!isIndentationSensitivePath(filePath)) {
    return;
  }

  const matchedLine = getFirstNonEmptyLine(matchedContent);
  const searchLine = getFirstNonEmptyLine(searchContent);
  if (!matchedLine || !searchLine) {
    return;
  }

  validateCandidateIndentation(
    filePath,
    matchedLine,
    searchLine,
    "searchContent",
  );
};

const validateReplacementIndentation = (
  filePath: string,
  matchedContent: string,
  replacement: string,
): void => {
  if (!isIndentationSensitivePath(filePath)) {
    return;
  }

  const matchedLine = getFirstNonEmptyLine(matchedContent);
  const replacementLine = getFirstNonEmptyLine(replacement);
  if (!matchedLine || !replacementLine) {
    return;
  }

  validateCandidateIndentation(
    filePath,
    matchedLine,
    replacementLine,
    "replaceContent",
  );
};

const replaceContent = (
  filePath: string,
  content: string,
  searchContent: string,
  replacement: string,
  occurrence: number,
): { content: string; matchedLineStart: number; matchedLineEnd: number } => {
  if (occurrence < 1) {
    throw new Error("occurrence must be greater than zero");
  }

  let effectiveSearch = searchContent;
  if (isIndentationSensitivePath(filePath)) {
    const paddedSearch = autoPadSearchIndentation(content, searchContent);
    if (paddedSearch) {
      effectiveSearch = paddedSearch;
    }
  }

  const adaptedSearch = adaptLineEndings(effectiveSearch, content);
  const adaptedReplacement = adaptLineEndings(replacement, content);
  let offset = 0;
  let foundIndex = -1;
  for (let index = 0; index < occurrence; index += 1) {
    foundIndex = content.indexOf(adaptedSearch, offset);
    if (foundIndex < 0) {
      throw new Error(
        "searchContent not found in remote file. For Python/YAML/Makefile files, leading indentation is significant and must be copied exactly.",
      );
    }
    offset = foundIndex + Math.max(1, adaptedSearch.length);
  }

  const prefix = content.slice(0, foundIndex);
  let effectiveReplacement = adaptedReplacement;
  if (isIndentationSensitivePath(filePath)) {
    const lineStart = content.lastIndexOf("\n", foundIndex - 1) + 1;
    const lineEnd = content.indexOf("\n", foundIndex);
    const matchedLine = content.slice(
      lineStart,
      lineEnd < 0 ? content.length : lineEnd,
    );
    const beforeMatch = content.slice(lineStart, foundIndex);
    if (/^[ \t]*$/.test(beforeMatch)) {
      validateSearchIndentation(filePath, effectiveSearch, matchedLine);
      try {
        validateReplacementIndentation(
          filePath,
          matchedLine,
          adaptedReplacement,
        );
      } catch (error) {
        const padded = autoPadFirstLineToReference(
          matchedLine,
          adaptedReplacement,
        );
        if (!padded) {
          throw error;
        }
        validateReplacementIndentation(filePath, matchedLine, padded);
        effectiveReplacement = padded;
      }
    }
  }
  const matchedLineStart = prefix.split("\n").length;
  const matchedLineEnd =
    matchedLineStart + adaptedSearch.split("\n").length - 1;
  return {
    content: `${prefix}${effectiveReplacement}${content.slice(
      foundIndex + adaptedSearch.length,
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
  maxResults: number,
): string => {
  const flags = ["-nH"];
  if (!isRegex) {
    flags.push("-F");
  }
  if (!caseSensitive) {
    flags.push("-i");
  }
  const glob = shellGlobExpression(fileGlob);
  // Normalize the remote path so a trailing slash cannot turn the find
  // `-path` pattern into a double-slash glob (e.g. `/src//*.tsx`) that
  // matches nothing. grep then receives no file arguments and falls back to
  // reading the never-ending SSH exec channel stdin until the 30s timeout.
  const root = normalizeRemotePath(remotePath);
  const script = [
    `root=${shellQuote(root)}`,
    `pattern=${shellQuote(pattern)}`,
    `glob=${shellQuote(glob)}`,
    `limit=${Math.max(1, maxResults)}`,
    // Build the find `-path` pattern so `root=/` stays a single slash.
    `if [ "$root" = "/" ]; then pathpat="/$glob"; else pathpat="$root/$glob"; fi`,
    // `-exec grep ... {} +` never runs grep without file arguments (unlike
    // `$(find ...)` command substitution), so a zero-match glob returns
    // immediately instead of blocking on stdin. Excluded directories move
    // from grep (where they never applied, since grep only receives file
    // arguments) to the find `-prune` stage. `< /dev/null` guards grep's
    // stdin as a last resort, and `2>/dev/null` silences find/grep noise
    // (also inherited by grep via fork). `head` still truncates the output
    // and `|| true` absorbs the resulting SIGPIPE exit code.
    `find "$root" \\( -type d -name .git -o -type d -name node_modules -o -type d -name target \\) -prune -o -type f -path "$pathpat" -exec grep ${flags
      .map(shellQuote)
      .join(
        " ",
      )} -- "$pattern" {} + < /dev/null 2>/dev/null | head -n "$limit" || true`,
  ].join("\n");

  return `sh -lc ${shellQuote(script)}`;
};

const parseGrepLines = (
  output: string,
  workspacePath: string,
  remoteRootPath: string,
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
        file: buildRemoteWorkspaceUri(workspacePath, parsed[1], remoteRootPath),
        line: lineNumber,
        content: parsed[3],
      },
    ];
  });

const executeFilesystemRead = async (
  args: RemoteWorkspaceCommandArgs,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> => {
  const workspacePath = validateSshWorkspacePath(args.filePath, "filePath");
  const startLine = ensureOptionalPositiveInteger(args.startLine);
  const endLine = ensureOptionalPositiveInteger(args.endLine);

  return withSshSession(
    workspacePath,
    async (sessionId, remotePath) => {
      try {
        const entries = await listSshDirectory(sessionId, remotePath, {
          signal,
        });
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
    },
    { signal },
  );
};

const executeCodeLensReadSource = async (
  args: RemoteWorkspaceCommandArgs,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> => {
  const workspacePath = validateSshWorkspacePath(args.filePath, "filePath");
  // Rust performs the workspace containment check before dispatch. Electron
  // independently verifies the SSH authority so this operation cannot switch
  // hosts if malformed arguments reach the bridge.
  resolveAuthorizedWorkspaceRoot(workspacePath, args.workspaceRoot);

  return withSshSession(
    workspacePath,
    async (sessionId, remotePath) => {
      const buffer = await readSshFile(sessionId, remotePath, { signal });
      if (buffer.length > CODELENS_MAX_SOURCE_BYTES) {
        throw new Error(
          `CodeLens source file is too large (${buffer.length} bytes, max ${CODELENS_MAX_SOURCE_BYTES} bytes)`,
        );
      }

      const file = processFileContent(remotePath, buffer);
      const isValidUtf8 = Buffer.from(file.content, "utf8").equals(buffer);
      if (file.isBinary || file.isImage || !isValidUtf8) {
        throw new Error("CodeLens requires a UTF-8 text source file");
      }

      return {
        filePath: workspacePath,
        content: file.content,
        bytes: buffer.length,
      };
    },
    { signal },
  );
};

const executeFilesystemReplaceEdit = async (
  args: RemoteWorkspaceCommandArgs,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> => {
  const workspacePath = validateSshWorkspacePath(args.filePath, "filePath");
  const workspaceRoot = resolveAuthorizedWorkspaceRoot(
    workspacePath,
    args.workspaceRoot,
  );
  const searchContent = ensureString(args.searchContent, "searchContent");
  const replacement = ensureString(args.replaceContent, "replaceContent");
  const occurrence =
    typeof args.occurrence === "number" && Number.isFinite(args.occurrence)
      ? Math.floor(args.occurrence)
      : 1;
  const loaded = await readRemoteText(workspacePath, signal);
  const result = replaceContent(
    workspacePath,
    loaded.content,
    searchContent,
    replacement,
    occurrence,
  );
  const save = await writeRemoteText(
    workspacePath,
    workspaceRoot,
    result.content,
    loaded.version,
    signal,
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
  signal?: AbortSignal,
): Promise<Record<string, unknown>> => {
  const workspacePath = validateSshWorkspacePath(args.filePath, "filePath");
  const workspaceRoot = resolveAuthorizedWorkspaceRoot(
    workspacePath,
    args.workspaceRoot,
  );
  const content = ensureString(args.content, "content");
  const overwrite = args.overwrite === true;

  const save = await withSshSession(
    workspacePath,
    async (sessionId, remotePath) => {
      const exists = (
        await executeSshCommand(sessionId, buildRemoteStatCommand(remotePath), {
          signal,
        })
      ).trim();
      if (exists && !overwrite) {
        throw new Error(
          "Remote file already exists. To overwrite this file, set overwrite=true.",
        );
      }
      const parentPath = dirname(remotePath);
      if (parentPath && parentPath !== ".") {
        await executeSshCommand(
          sessionId,
          buildRemoteMkdirCommand(parentPath),
          {
            signal,
          },
        );
      }
      const expectedVersion: SshFileVersion = exists
        ? (await readSshFileWithVersion(sessionId, remotePath, { signal }))
            .version
        : { exists: false };
      return writeSshFile(sessionId, remotePath, content, {
        signal,
        workspaceRoot,
        expectedVersion,
      });
    },
    { signal },
  );

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
  signal?: AbortSignal,
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

  return withSshSession(
    workspacePath,
    async (sessionId, remotePath) => {
      const output = await executeSshCommand(
        sessionId,
        buildRemoteGrepCommand(
          remotePath,
          pattern,
          fileGlob,
          isRegex,
          caseSensitive,
          maxResults,
        ),
        { timeoutMs: REMOTE_GREP_TIMEOUT_MS, signal },
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
    },
    { signal },
  );
};

const executeBashCommand = async (
  args: RemoteWorkspaceCommandArgs,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> => {
  const workspacePath = validateSshWorkspacePath(
    args.workingDirectory,
    "workingDirectory",
  );
  const command = ensureString(args.command, "command");
  const timeout =
    typeof args.timeout === "number" && Number.isFinite(args.timeout)
      ? Math.max(1, Math.floor(args.timeout))
      : 30_000;

  return withSshSession(
    workspacePath,
    async (sessionId, remotePath) => {
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
    },
    { signal },
  );
};

// Mirrors SKIP_DIRS in native/src/storage/services/checkpoint/mod.rs so remote
// checkpoint scans skip the same heavy directories as local scans.
const CHECKPOINT_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  ".next",
  ".nuxt",
  "out",
  "coverage",
  ".cache",
  ".turbo",
  ".vercel",
  "target",
  "__pycache__",
  ".venv",
  "venv",
  ".idea",
  ".vscode",
  ".vs",
  ".snow",
  ".snowapp",
  "release",
  ".output",
  ".angular",
  ".parcel-cache",
]);

const executeCheckpointStat = async (
  args: RemoteWorkspaceCommandArgs,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> => {
  const workspacePath = validateSshWorkspacePath(args.path, "path");
  return withSshSession(
    workspacePath,
    async (sessionId, remotePath) => {
      const stats = await statSshEntry(sessionId, remotePath);
      if (!stats) {
        return { exists: false, isDirectory: false, size: 0, mtimeMs: 0 };
      }
      return {
        exists: true,
        isDirectory: stats.isDirectory(),
        size: stats.size,
        mtimeMs: stats.mtime * 1000,
      };
    },
    { signal },
  );
};

type CheckpointTreeEntry = {
  path: string;
  isDirectory: boolean;
  size: number;
  mtimeMs: number;
};

type CheckpointTreeResult = {
  entries: CheckpointTreeEntry[];
  gitignores: Array<{ dir: string; content: string }>;
};

const CHECKPOINT_TREE_TIMEOUT_MS = 120_000;
const CHECKPOINT_GITIGNORE_MARKER = "---SNOW-CHECKPOINT-GITIGNORES---";
const CHECKPOINT_GITIGNORE_START = "--SNOW-GITIGNORE-START-- ";
const CHECKPOINT_GITIGNORE_END = "--SNOW-GITIGNORE-END--";

// find 的 SKIP_DIRS 剪枝表达式：仅剪目录（与本地扫描语义一致，同名普通
// 文件保留）。括号必须转义后才能作为 find 的参数传给远程 shell。
const CHECKPOINT_SKIP_DIR_PRUNE = (() => {
  const names = [...CHECKPOINT_SKIP_DIRS]
    .map((name) => `-name ${shellQuote(name)}`)
    .join(" -o ");
  return `\\( -type d \\( ${names} \\) -prune \\)`;
})();

// 单个 .gitignore 内容转储脚本（POSIX sh，经 find -exec 调用）：
// 每个文件输出 START 行（含相对路径）+ 原始内容 + END 行。
const CHECKPOINT_GITIGNORE_DUMP_EXEC =
  `-exec sh -c 'for f in "$@"; do ` +
  `printf -- "${CHECKPOINT_GITIGNORE_START}%s\\n" "$f"; ` +
  `cat -- "$f"; ` +
  `printf -- "\\n${CHECKPOINT_GITIGNORE_END}\\n"; ` +
  `done' sh {} +`;

// 通过 exec 通道一次性拉取整棵文件树（含 mtime/size）与各目录 .gitignore
// 内容：一次网络往返完成原本每目录一次 SFTP readdir 的遍历。
// gnu 变体用 find -printf（NUL 分隔，文件名换行安全，mtime 纳秒级）；
// bsd 变体（macOS 等）用 stat -f，换行分隔且 mtime 为整秒。
const buildCheckpointTreeFindCommand = (
  remotePath: string,
  variant: "gnu" | "bsd",
): string => {
  const listFiles =
    variant === "gnu"
      ? `find . ${CHECKPOINT_SKIP_DIR_PRUNE} -o \\( -type f -printf '%T@\\t%s\\t%P\\0' \\)`
      : `find . ${CHECKPOINT_SKIP_DIR_PRUNE} -o \\( -type f -exec stat -f '%m\\t%z\\t%N' {} + \\)`;
  return [
    `cd -- ${shellQuote(remotePath)}`,
    `&& ${listFiles}`,
    `&& printf '\\n${CHECKPOINT_GITIGNORE_MARKER}\\n'`,
    `&& find . ${CHECKPOINT_SKIP_DIR_PRUNE} -o \\( -type f -name .gitignore ${CHECKPOINT_GITIGNORE_DUMP_EXEC} \\)`,
  ].join(" ");
};

const stripDotSlash = (path: string): string =>
  path.startsWith("./") ? path.slice(2) : path;

const tryParseCheckpointTreeRecord = (
  record: string,
): CheckpointTreeEntry | undefined => {
  const firstTab = record.indexOf("\t");
  const secondTab = firstTab >= 0 ? record.indexOf("\t", firstTab + 1) : -1;
  if (firstTab < 0 || secondTab < 0) {
    return undefined;
  }
  const mtime = Number(record.slice(0, firstTab));
  const size = Number(record.slice(firstTab + 1, secondTab));
  const path = stripDotSlash(record.slice(secondTab + 1));
  if (!path || !Number.isFinite(mtime) || !Number.isFinite(size)) {
    // 文件名含制表符/换行等极端情况：记录无法解析，跳过该文件
    // （等同内容抓取跳过，仅损失该文件的回滚能力）。
    return undefined;
  }
  return {
    path,
    isDirectory: false,
    size,
    mtimeMs: Math.floor(mtime * 1000),
  };
};

const parseCheckpointTreeGitignores = (
  section: string,
): Array<{ dir: string; content: string }> => {
  const gitignores: Array<{ dir: string; content: string }> = [];
  let current: { dir: string; lines: string[] } | undefined;
  for (const rawLine of section.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.startsWith(CHECKPOINT_GITIGNORE_START)) {
      const path = stripDotSlash(
        line.slice(CHECKPOINT_GITIGNORE_START.length).trim(),
      );
      const lastSlash = path.lastIndexOf("/");
      current = {
        dir: lastSlash >= 0 ? path.slice(0, lastSlash) : "",
        lines: [],
      };
      continue;
    }
    if (line === CHECKPOINT_GITIGNORE_END) {
      if (current) {
        gitignores.push({
          dir: current.dir,
          content: current.lines.join("\n"),
        });
        current = undefined;
      }
      continue;
    }
    current?.lines.push(rawLine);
  }
  return gitignores;
};

const parseCheckpointTreeOutput = (
  output: string,
  mtimeIsFloat: boolean,
): CheckpointTreeResult => {
  const markerIndex = output.indexOf(CHECKPOINT_GITIGNORE_MARKER);
  const fileSection = markerIndex >= 0 ? output.slice(0, markerIndex) : output;
  const gitignoreSection =
    markerIndex >= 0
      ? output.slice(markerIndex + CHECKPOINT_GITIGNORE_MARKER.length)
      : "";

  const entries: CheckpointTreeEntry[] = [];
  // gnu：NUL 分隔记录 "mtime秒.小数\tsize\t相对路径"；bsd：换行分隔。
  const records = mtimeIsFloat
    ? fileSection.split("\0")
    : fileSection.split("\n");
  for (const rawRecord of records) {
    const record = rawRecord.replace(/^\n+/, "");
    if (!record) {
      continue;
    }
    const entry = tryParseCheckpointTreeRecord(record);
    if (entry) {
      entries.push(entry);
    }
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return {
    entries,
    gitignores: parseCheckpointTreeGitignores(gitignoreSection),
  };
};

// 兜底遍历（远程 shell 不支持 find/stat，如 Windows OpenSSH 默认 shell）：
// SFTP 逐目录 readdir，语义与 find 变体一致。
const listCheckpointTreeViaSftpWalk = async (
  sessionId: string,
  remotePath: string,
  signal?: AbortSignal,
): Promise<CheckpointTreeResult> => {
  const entries: CheckpointTreeEntry[] = [];
  // 每个目录的 .gitignore 内容（dir 为相对根目录的 POSIX 路径，
  // 根目录为 ""）。Rust 侧复用与本地相同的 GitignoreMatcher 语义。
  const gitignores: Array<{ dir: string; content: string }> = [];
  const directories: Array<{ absolute: string; relative: string }> = [
    { absolute: remotePath, relative: "" },
  ];
  while (directories.length > 0) {
    const { absolute, relative } = directories.pop() as {
      absolute: string;
      relative: string;
    };
    const list = await listSshDirectory(sessionId, absolute, { signal });
    for (const entry of list) {
      // Symlinks are never captured (local scans skip them too).
      if (entry.isSymbolicLink) {
        continue;
      }
      const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        if (!CHECKPOINT_SKIP_DIRS.has(entry.name)) {
          directories.push({ absolute: entry.path, relative: entryRelative });
        }
        continue;
      }
      if (entry.name === ".gitignore") {
        // 收集规则内容供 Rust 侧过滤；读取失败只丢规则不中断扫描。
        try {
          const buf = await readSshFile(sessionId, entry.path, { signal });
          gitignores.push({
            dir: relative,
            content: buf.toString("utf-8"),
          });
        } catch {
          // Best effort — the file tree scan continues without these rules.
        }
      }
      entries.push({
        path: entryRelative,
        isDirectory: false,
        size: entry.size,
        mtimeMs: entry.mtime * 1000,
      });
    }
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { entries, gitignores };
};

const executeCheckpointListTree = async (
  args: RemoteWorkspaceCommandArgs,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> => {
  const workspacePath = validateSshWorkspacePath(args.path, "path");
  return withSshSession(
    workspacePath,
    async (sessionId, remotePath) => {
      // 优先 exec 通道 find 单命令拉全树（一次网络往返）；GNU find 不可用
      // （BSD/macOS 等）则换 stat -f 变体，均失败再退回 SFTP 逐目录遍历。
      const attempts: Array<{ command: string; mtimeIsFloat: boolean }> = [
        {
          command: buildCheckpointTreeFindCommand(remotePath, "gnu"),
          mtimeIsFloat: true,
        },
        {
          command: buildCheckpointTreeFindCommand(remotePath, "bsd"),
          mtimeIsFloat: false,
        },
      ];
      for (const attempt of attempts) {
        try {
          const output = await executeSshCommand(sessionId, attempt.command, {
            signal,
            timeoutMs: CHECKPOINT_TREE_TIMEOUT_MS,
          });
          return parseCheckpointTreeOutput(output, attempt.mtimeIsFloat);
        } catch (error) {
          // 连接级失败（断开/取消）直接上抛：回退变体共用同一传输层。
          if (isSshOperationError(error)) {
            throw error;
          }
        }
      }
      return listCheckpointTreeViaSftpWalk(sessionId, remotePath, signal);
    },
    { signal },
  );
};

// 单文件 stat+read 合并操作：checkpoint 单文件记录（before/after）原本需要
// 两次往返（stat 判存在性/目录、read 取内容），合并后一次往返完成。
const executeCheckpointReadFileWithStat = async (
  args: RemoteWorkspaceCommandArgs,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> => {
  const workspacePath = validateSshWorkspacePath(args.path, "path");
  return withSshSession(
    workspacePath,
    async (sessionId, remotePath) => {
      const stats = await statSshEntry(sessionId, remotePath);
      if (!stats) {
        return {
          exists: false,
          isDirectory: false,
          size: 0,
          mtimeMs: 0,
          content: null,
        };
      }
      if (stats.isDirectory()) {
        return {
          exists: true,
          isDirectory: true,
          size: 0,
          mtimeMs: stats.mtime * 1000,
          content: null,
        };
      }
      let content: Buffer;
      try {
        content = await readSshFile(sessionId, remotePath, { signal });
      } catch (error) {
        if (isSshOperationError(error)) {
          throw error;
        }
        // The file may have been removed between stat and read.
        return {
          exists: false,
          isDirectory: false,
          size: 0,
          mtimeMs: 0,
          content: null,
        };
      }
      return {
        exists: true,
        isDirectory: false,
        size: stats.size,
        mtimeMs: stats.mtime * 1000,
        content: content.toString("base64"),
      };
    },
    { signal },
  );
};

// 校验批量操作的路径参数（一组 ssh:// URI）。
const ensureSshPathList = (value: unknown, fieldName: string): string[] => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${fieldName} must be a non-empty array of SSH paths`);
  }
  return value.map((item, index) =>
    validateSshWorkspacePath(item, `${fieldName}[${index}]`),
  );
};

// 按 SSH authority 分组路径：checkpoint 条目可能经绝对路径标记指向工作区根
// 之外的位置，每个 authority 独立走连接池会话。
const groupSshPathsByAuthority = (
  paths: readonly string[],
): Map<string, Array<{ original: string; remotePath: string }>> => {
  const groups = new Map<
    string,
    Array<{ original: string; remotePath: string }>
  >();
  for (const path of paths) {
    const parsed = parseSshUrl(path);
    const key = `${parsed.username}@${parsed.host}:${parsed.port}`;
    const group = groups.get(key);
    if (group) {
      group.push({ original: path, remotePath: parsed.remotePath });
    } else {
      groups.set(key, [{ original: path, remotePath: parsed.remotePath }]);
    }
  }
  return groups;
};

const CHECKPOINT_STAT_CONCURRENCY = 32;
const CHECKPOINT_READ_CONCURRENCY = 8;

// 批量 stat：一次命令往返取回全部路径的元数据（连接池会话内 SFTP 并发），
// 替代逐文件 checkpoint-stat 的 N 次往返。
const executeCheckpointStatPaths = async (
  args: RemoteWorkspaceCommandArgs,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> => {
  const paths = ensureSshPathList(args.paths, "paths");
  const stats: Record<string, unknown> = {};
  for (const [authority, group] of groupSshPathsByAuthority(paths)) {
    await withSshSession(
      `ssh://${authority}`,
      async (sessionId) => {
        await mapWithConcurrency(
          group,
          CHECKPOINT_STAT_CONCURRENCY,
          async (item) => {
            const entry = await statSshEntry(sessionId, item.remotePath);
            stats[item.original] = entry
              ? {
                  exists: true,
                  isDirectory: entry.isDirectory(),
                  size: entry.size,
                  mtimeMs: entry.mtime * 1000,
                }
              : { exists: false, isDirectory: false, size: 0, mtimeMs: 0 };
          },
        );
      },
      { signal },
    );
  }
  return { stats };
};

// 批量读取文件内容（base64）：一次命令往返读回一批文件，替代逐文件
// checkpoint-read-file 的 N 次往返；stat 后消失的文件返回 null。
const executeCheckpointReadFiles = async (
  args: RemoteWorkspaceCommandArgs,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> => {
  const paths = ensureSshPathList(args.paths, "paths");
  const contents: Record<string, string | null> = {};
  for (const [authority, group] of groupSshPathsByAuthority(paths)) {
    await withSshSession(
      `ssh://${authority}`,
      async (sessionId) => {
        await mapWithConcurrency(
          group,
          CHECKPOINT_READ_CONCURRENCY,
          async (item) => {
            try {
              const buffer = await readSshFile(sessionId, item.remotePath, {
                signal,
              });
              contents[item.original] = buffer.toString("base64");
            } catch (error) {
              if (isSshOperationError(error)) {
                throw error;
              }
              // The file may have been removed between stat and read.
              contents[item.original] = null;
            }
          },
        );
      },
      { signal },
    );
  }
  return { contents };
};

const executeCheckpointWriteFile = async (
  args: RemoteWorkspaceCommandArgs,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> => {
  const workspacePath = validateSshWorkspacePath(args.path, "path");
  const contentBase64 = ensureString(args.contentBase64, "contentBase64");
  const data = Buffer.from(contentBase64, "base64");
  return withSshSession(
    workspacePath,
    async (sessionId, remotePath) => {
      const parentPath = dirname(remotePath);
      if (parentPath && parentPath !== ".") {
        await executeSshCommand(
          sessionId,
          buildRemoteMkdirCommand(parentPath),
          { signal },
        );
      }
      const save = await writeInternalSshFile(sessionId, remotePath, data, {
        signal,
      });
      return { bytes: save.bytes };
    },
    { signal },
  );
};

const executeCheckpointDeleteFile = async (
  args: RemoteWorkspaceCommandArgs,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> => {
  const workspacePath = validateSshWorkspacePath(args.path, "path");
  return withSshSession(
    workspacePath,
    async (sessionId, remotePath) => {
      try {
        await deleteSshFile(sessionId, remotePath);
        return { deleted: true };
      } catch {
        return { deleted: false };
      }
    },
    { signal },
  );
};

const executeCheckpointRemoveDir = async (
  args: RemoteWorkspaceCommandArgs,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> => {
  const workspacePath = validateSshWorkspacePath(args.path, "path");
  return withSshSession(
    workspacePath,
    async (sessionId, remotePath) => {
      const removed = await removeEmptySshDirectory(sessionId, remotePath);
      return { removed };
    },
    { signal },
  );
};

// 中止一轮 checkpoint 扫描：Rust 侧 checkpoint 预算超时后发起本操作，
// 通过 scanId 找到仍在进行的 SFTP/exec 遍历并真正终止它（仅靠 Rust 侧
// 丢弃 future 无法停掉 Electron 侧仍在运行的扫描）。
const executeCheckpointAbortScan = (
  args: RemoteWorkspaceCommandArgs,
): Record<string, unknown> => {
  const scanId =
    typeof args.scanId === "string" && args.scanId.trim()
      ? args.scanId.trim()
      : "";
  if (!scanId) {
    return { aborted: false };
  }
  return { aborted: abortCheckpointScan(scanId) };
};

const dispatchRemoteWorkspaceOperation = async (
  operation: string,
  args: RemoteWorkspaceCommandArgs,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> => {
  switch (operation) {
    case "filesystem-read":
      return executeFilesystemRead(args, signal);
    case "codelens-read-source":
      return executeCodeLensReadSource(args, signal);
    case "filesystem-replace_edit":
      return executeFilesystemReplaceEdit(args, signal);
    case "filesystem-create":
      return executeFilesystemCreate(args, signal);
    case "grep-search":
      return executeGrepSearch(args, signal);
    case "bash-terminal-execute":
      return executeBashCommand(args, signal);
    case "checkpoint-stat":
      return executeCheckpointStat(args, signal);
    case "checkpoint-stat-paths":
      return executeCheckpointStatPaths(args, signal);
    case "checkpoint-list-tree":
      return executeCheckpointListTree(args, signal);
    case "checkpoint-read-file-with-stat":
      return executeCheckpointReadFileWithStat(args, signal);
    case "checkpoint-read-files":
      return executeCheckpointReadFiles(args, signal);
    case "checkpoint-write-file":
      return executeCheckpointWriteFile(args, signal);
    case "checkpoint-delete-file":
      return executeCheckpointDeleteFile(args, signal);
    case "checkpoint-remove-dir":
      return executeCheckpointRemoveDir(args, signal);
    case "checkpoint-abort-scan":
      return executeCheckpointAbortScan(args);
    default:
      throw new Error(`Unsupported remote workspace operation: ${operation}`);
  }
};

export const dispatchRemoteWorkspaceCommand = async (
  command: RemoteWorkspaceCommand,
  options?: { signal?: AbortSignal },
): Promise<string> => {
  const outerSignal = options?.signal;
  let args: RemoteWorkspaceCommandArgs;
  try {
    args = JSON.parse(command.argsJson) as RemoteWorkspaceCommandArgs;
  } catch {
    throw new Error("Remote workspace command arguments must be valid JSON");
  }

  // 携带 scanId 的 checkpoint 命令属于同一轮扫描：为其注册独立的
  // AbortController（与工具调用级 signal 合并），Rust 超时后可通过
  // checkpoint-abort-scan 真正终止扫描；checkpoint-abort-scan 自身
  // 的 scanId 是中止目标，不再包裹。
  const scanId =
    typeof args.scanId === "string" && args.scanId.trim()
      ? args.scanId.trim()
      : undefined;
  const runOperation = (signal?: AbortSignal) =>
    runRemoteWorkspaceOperationWithSshErrorHandling(
      command.operation,
      args,
      signal,
    );
  if (!scanId || command.operation === "checkpoint-abort-scan") {
    return runOperation(outerSignal);
  }

  const scanController = new AbortController();
  const signal = outerSignal
    ? AbortSignal.any([scanController.signal, outerSignal])
    : scanController.signal;
  registerCheckpointScanAbort(scanId, scanController);
  try {
    return await runOperation(signal);
  } finally {
    unregisterCheckpointScanAbort(scanId, scanController);
  }
};

const runRemoteWorkspaceOperationWithSshErrorHandling = async (
  operation: string,
  args: RemoteWorkspaceCommandArgs,
  signal?: AbortSignal,
): Promise<string> => {
  try {
    const result = await dispatchRemoteWorkspaceOperation(
      operation,
      args,
      signal,
    );
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
