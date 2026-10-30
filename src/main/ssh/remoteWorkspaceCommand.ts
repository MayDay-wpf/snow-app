import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { dirname } from "node:path/posix";
import {
  parseRoleSettings,
  type RoleSettings,
} from "../../shared/roleSettings";
import { processFileContent } from "../utils/fileReader";
import {
  deleteSshFile,
  executeSshCommand,
  isSshPathWithinRoot,
  listSshDirectory,
  parseSshUrl,
  readSshFile,
  readSshFileWithVersion,
  removeEmptySshDirectory,
  renameSshFile,
  SshOperationError,
  statSshEntry,
  isSshOperationError,
  toSshOperationErrorResult,
  writeInternalSshFile,
  writeSshFile,
  type SshConnectParams,
  type SshFileVersion,
  type SshFileWriteResult,
} from "./sshManager";
import {
  getDecryptedSecret,
  getSshCredential,
  toSshJumpParams,
} from "./sshCredentials";
import {
  getSshWorkspaceProfileId,
  sshConnectionManager,
  sshWorkspaceNotConnectedError,
} from "./sshConnectionManager";
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
// filesystem-copy 的复核反馈上限：粘贴区域超过 COPY_REPORT_MAX_LINES 行时只回传
// 首尾各 COPY_REPORT_EDGE_LINES 行，中间折成一行省略标记（omittedLines 报告省略行数）。
const COPY_REPORT_MAX_LINES = 800;
const COPY_REPORT_EDGE_LINES = 30;
// review 上下文块：粘贴区域前后各 COPY_REVIEW_CONTEXT_LINES 行。
const COPY_REVIEW_CONTEXT_LINES = 5;

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
  sourceFilePath?: unknown;
  sourceStartLine?: unknown;
  sourceEndLine?: unknown;
  targetLine?: unknown;
  targetEndLine?: unknown;
  position?: unknown;
  deleteSource?: unknown;
  content?: unknown;
  overwrite?: unknown;
  pattern?: unknown;
  path?: unknown;
  fileGlob?: unknown;
  isRegex?: unknown;
  caseSensitive?: unknown;
  maxResults?: unknown;
  searchAll?: unknown;
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
  sourceDir?: unknown;
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

  if (credential?.jump) {
    connectParams.jump = toSshJumpParams(credential.jump);
  }

  return connectParams;
};

// ============================================================================
// 远程工作区命令统一走工作区持有的 profile 连接：连接生命周期由活动工作区
// （渲染层）与后台任务显式持有，这里不再按需建连——未连接直接失败。
// ============================================================================

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
  const profile = sshConnectionManager.retain(
    getSshWorkspaceProfileId(workspacePath),
  );
  if (!profile?.sessionId) {
    throw sshWorkspaceNotConnectedError("remote_workspace");
  }
  if (options?.signal?.aborted) {
    sshConnectionManager.release(profile.profileId);
    throw new SshOperationError({
      code: "SSH_OPERATION_CANCELLED",
      operation: "remote_workspace",
      message: "Remote workspace operation cancelled",
    });
  }
  try {
    return await action(profile.sessionId, parsedPath.remotePath, parsedPath);
  } finally {
    sshConnectionManager.release(profile.profileId);
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
  overrideBuiltinPrompt: boolean;
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

        let roleSettings: RoleSettings = {
          includeGlobalRules: true,
          overrideBuiltinPrompt: false,
        };
        try {
          const settingsPath = `${projectRoot}/.snow/settings.json`;
          const settingsFile = processFileContent(
            settingsPath,
            await readSshFile(sessionId, settingsPath),
          );
          if (!settingsFile.isBinary && !settingsFile.isImage) {
            roleSettings = parseRoleSettings(settingsFile.content);
          }
        } catch {
          // Missing or invalid settings keep the defaults.
        }

        return { content, ...roleSettings };
      },
    );
  } catch {
    return {
      content: null,
      includeGlobalRules: true,
      overrideBuiltinPrompt: false,
    };
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

// 必填行号：复用 ensureOptionalPositiveInteger 的解析，把“缺失”也当作参数错误抛出，
// filesystem-copy 的行号是定位锚点，缺省会导致复制到意料之外的位置。
const ensureRequiredPositiveInteger = (
  value: unknown,
  fieldName: string,
): number => {
  const parsed = ensureOptionalPositiveInteger(value);
  if (parsed === undefined) {
    throw new Error(`${fieldName} is required`);
  }
  return parsed;
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

const findNthOccurrence = (
  content: string,
  needle: string,
  occurrence: number,
): number | null => {
  if (!needle) {
    return null;
  }
  const target = Math.max(1, occurrence);
  let count = 0;
  let offset = 0;
  while (offset <= content.length) {
    const relative = content.indexOf(needle, offset);
    if (relative < 0) {
      return null;
    }
    count += 1;
    if (count === target) {
      return relative;
    }
    offset = relative + needle.length;
  }
  return null;
};

const isBlankSourceLine = (line: string): boolean =>
  line.replace(/^[ \t\r]+/, "").replace(/[ \t\r]+$/, "").length === 0;

// searchContent 首行缩进与实际命中行不一致时的定点矫正。substring 能命中
// 意味着中间行是逐字匹配的，AI 的缩进基准只有首行失真：用命中行的真实缩进
// 重写 searchContent 首行，并把仍停留在旧缩进基准上的 replaceContent 行迁移
// 到真实缩进（多行 search 仅迁移首个非空行；单行 search 迁移全部非空行）。
const realignSearchFirstLineIndentation = (
  content: string,
  searchContent: string,
  replacement: string,
  occurrence: number,
): { search: string; replacement: string } | null => {
  const adaptedSearch = adaptLineEndings(searchContent, content);
  const foundIndex = findNthOccurrence(content, adaptedSearch, occurrence);
  if (foundIndex === null) {
    return null;
  }
  const lineStart = content.lastIndexOf("\n", foundIndex - 1) + 1;
  const beforeMatch = content.slice(lineStart, foundIndex);
  if (!/^[ \t]*$/.test(beforeMatch)) {
    return null;
  }
  const lineEnd = content.indexOf("\n", foundIndex);
  const matchedLine = content.slice(
    lineStart,
    lineEnd < 0 ? content.length : lineEnd,
  );
  const fileIndent = getLeadingHorizontalWhitespace(matchedLine);

  const newlineIndex = searchContent.indexOf("\n");
  const searchFirstLine =
    newlineIndex < 0 ? searchContent : searchContent.slice(0, newlineIndex);
  const searchRest =
    newlineIndex < 0 ? undefined : searchContent.slice(newlineIndex + 1);
  const searchIndent = getLeadingHorizontalWhitespace(searchFirstLine);
  const searchBody = searchFirstLine.replace(/^[ \t]+/, "");
  // 首行去缩进后为空说明缩进基准不在首行；缩进一致则无需矫正。
  if (!searchBody || searchIndent === fileIndent) {
    return null;
  }

  const realignedSearch =
    searchRest === undefined
      ? fileIndent + searchBody
      : `${fileIndent}${searchBody}\n${searchRest}`;

  const replaceLines = replacement.split("\n");
  const firstBodyIndex = replaceLines.findIndex(
    (line) => !isBlankSourceLine(line),
  );
  if (firstBodyIndex < 0) {
    // 空替换表示删除，不涉及缩进基准。
    return { search: realignedSearch, replacement };
  }
  const replaceIndent = getLeadingHorizontalWhitespace(
    replaceLines[firstBodyIndex],
  );
  // replaceContent 已按命中行缩进书写，或与旧缩进基准没有前缀关系
  // （无法解释其缩进意图）时保持原样，交由内置缩进校验兜底。
  if (replaceIndent === fileIndent || !replaceIndent.startsWith(searchIndent)) {
    return { search: realignedSearch, replacement };
  }

  const singleLineSearch = searchRest === undefined;
  const remapLine = (line: string): string => {
    const indent = getLeadingHorizontalWhitespace(line);
    if (
      line.replace(/^[ \t]+/, "").length === 0 ||
      !indent.startsWith(searchIndent)
    ) {
      return line;
    }
    return fileIndent + line.slice(indent.length);
  };
  const realignedReplacement = replaceLines
    .map((line, index) =>
      singleLineSearch || index === firstBodyIndex ? remapLine(line) : line,
    )
    .join("\n");
  return {
    search: realignedSearch,
    replacement:
      realignedReplacement === replacement ? replacement : realignedReplacement,
  };
};

// 缩进宽松匹配的行键：忽略行首空白与 CRLF/LF 差异后的行内容。
const relaxedLineKey = (line: string): string =>
  normalizeLineEndingsForMatch(line).replace(/^[ \t]+/, "");

// 按宽度平移一行的行首空白（不改动行内容本身，最低压到 0）。
const shiftLineIndent = (line: string, delta: number): string => {
  const indent = getLeadingHorizontalWhitespace(line);
  const body = line.slice(indent.length);
  const target = Math.max(0, [...indent].length + delta);
  let shifted = [...indent].slice(0, target).join("");
  if ([...shifted].length < target) {
    shifted += " ".repeat(target - [...shifted].length);
  }
  return shifted + body;
};

// 把 replaceContent 重新定基到命中区域的首行缩进：首个非空行已使用命中缩进
// → 原样返回；仍停留在 searchContent 的（错误）缩进基准上 → 整体迁移到命中
// 缩进并保留相对结构；两种基准都对不上 → 返回 null（保持拒绝语义）。
const rebaseReplacementToMatchedIndent = (
  searchFirstIndent: string,
  matchedFirstIndent: string,
  replacement: string,
): string | null => {
  if (searchFirstIndent === matchedFirstIndent) {
    return replacement;
  }
  const firstBodyLine = getFirstNonEmptyLine(replacement);
  if (!firstBodyLine) {
    // 空替换表示删除，不涉及缩进基准。
    return replacement;
  }
  const replaceIndent = getLeadingHorizontalWhitespace(firstBodyLine);
  if (replaceIndent === matchedFirstIndent) {
    return replacement;
  }
  if (!replaceIndent.startsWith(searchFirstIndent)) {
    return null;
  }
  const delta = [...matchedFirstIndent].length - [...searchFirstIndent].length;
  const rebased = replacement.split("\n").map((line) => {
    if (line.replace(/^[ \t]+/, "").length === 0) {
      return line;
    }
    const indent = getLeadingHorizontalWhitespace(line);
    if (indent.startsWith(searchFirstIndent)) {
      return matchedFirstIndent + line.slice(indent.length);
    }
    return shiftLineIndent(line, delta);
  });
  return rebased.join("\n");
};

interface IndentationRelaxedMatch {
  startLine: number;
  endLine: number;
  replacement: string;
  totalMatches: number;
}

// 缩进敏感文件专用的缩进宽松整行匹配：searchContent 整块丢失/错配行首缩进
// （精确与子串匹配均无法命中）时，按「去行首空白后逐行相等」定位命中区域，
// 并把 replaceContent 重新定基到命中区域的首行缩进。候选位置优先选择所有
// 非空行缩进呈统一偏移的（整体平移，语义最明确）。
const findIndentationRelaxedMatch = (
  searchContent: string,
  replacement: string,
  content: string,
  occurrence: number,
): IndentationRelaxedMatch | null => {
  const searchLines = searchContent.split("\n");
  const fileLines = content.split("\n");
  if (searchLines.length === 0 || searchLines.length > fileLines.length) {
    return null;
  }
  const searchKeys = searchLines.map(relaxedLineKey);

  const candidates: Array<{ start: number; uniform: boolean }> = [];
  for (
    let start = 0;
    start + searchLines.length <= fileLines.length;
    start += 1
  ) {
    const allMatch = searchKeys.every(
      (key, index) => relaxedLineKey(fileLines[start + index]) === key,
    );
    if (!allMatch) {
      continue;
    }
    let uniform = true;
    let expectedDelta: number | undefined;
    for (let index = 0; index < searchLines.length; index += 1) {
      if (!searchKeys[index]) {
        continue;
      }
      const delta =
        [...getLeadingHorizontalWhitespace(fileLines[start + index])].length -
        [...getLeadingHorizontalWhitespace(searchLines[index])].length;
      if (expectedDelta !== undefined && expectedDelta !== delta) {
        uniform = false;
        break;
      }
      expectedDelta = delta;
    }
    candidates.push({ start, uniform });
  }
  if (candidates.length === 0) {
    return null;
  }

  const preferred = candidates.some((candidate) => candidate.uniform)
    ? candidates
        .filter((candidate) => candidate.uniform)
        .map((candidate) => candidate.start)
    : candidates.map((candidate) => candidate.start);
  const start = preferred[Math.max(1, occurrence) - 1];
  if (start === undefined) {
    return null;
  }
  const end = start + searchLines.length;

  const searchFirstLine = getFirstNonEmptyLine(searchContent);
  const matchedFirstLine = getFirstNonEmptyLine(
    fileLines.slice(start, end).join("\n"),
  );
  if (!searchFirstLine || !matchedFirstLine) {
    return null;
  }
  const rebasedReplacement = rebaseReplacementToMatchedIndent(
    getLeadingHorizontalWhitespace(searchFirstLine),
    getLeadingHorizontalWhitespace(matchedFirstLine),
    replacement,
  );
  if (rebasedReplacement === null) {
    return null;
  }

  return {
    startLine: start,
    endLine: end,
    replacement: rebasedReplacement,
    totalMatches: preferred.length,
  };
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

const replaceContentOnce = (
  filePath: string,
  content: string,
  searchContent: string,
  replacement: string,
  occurrence: number,
): { content: string; matchedLineStart: number; matchedLineEnd: number } => {
  if (occurrence < 1) {
    throw new Error("occurrence must be greater than zero");
  }

  const adaptedSearch = adaptLineEndings(searchContent, content);
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
      validateSearchIndentation(filePath, searchContent, matchedLine);
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

// 缩进敏感文件下 searchContent 首行丢失/错配缩进是常见失误：先按原文尝试，
// 校验失败时按实际命中位置定点重建缩进后重试，避免可直接恢复的编辑被拒绝。
const replaceContent = (
  filePath: string,
  content: string,
  searchContent: string,
  replacement: string,
  occurrence: number,
): { content: string; matchedLineStart: number; matchedLineEnd: number } => {
  try {
    return replaceContentOnce(
      filePath,
      content,
      searchContent,
      replacement,
      occurrence,
    );
  } catch (firstError) {
    if (!isIndentationSensitivePath(filePath)) {
      throw firstError;
    }
    const realigned = realignSearchFirstLineIndentation(
      content,
      searchContent,
      replacement,
      occurrence,
    );
    if (!realigned) {
      throw firstError;
    }
    try {
      return replaceContentOnce(
        filePath,
        content,
        realigned.search,
        realigned.replacement,
        occurrence,
      );
    } catch {
      throw firstError;
    }
  }
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

// 远端 glob 查找：优先 rg --files，回退 find（find 的 * 跨目录，语义略宽）。
const REMOTE_FIND_SKIP_DIRS = [
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "target",
  "dist",
  "out",
  "build",
  ".next",
  ".nuxt",
  ".snow",
  ".cache",
  ".turbo",
  "__pycache__",
  ".venv",
  "venv",
  ".idea",
  ".vscode",
  "coverage",
  ".nyc_output",
  "release",
];

const buildRemoteFindCommand = (
  remotePath: string,
  pattern: string,
  maxResults: number,
  searchAll: boolean,
): string => {
  const root = normalizeRemotePath(remotePath);
  const limit = Math.max(1, maxResults);
  const skipGlobs = REMOTE_FIND_SKIP_DIRS.map(
    (name) => `--glob ${shellQuote(`!${name}`)}`,
  ).join(" ");
  const prune = REMOTE_FIND_SKIP_DIRS.map(
    (name) => `-type d -name ${shellQuote(name)}`,
  ).join(" -o ");
  const matcher = pattern.includes("/")
    ? `-path ${shellQuote(root === "/" ? `/${pattern}` : `${root}/${pattern}`)}`
    : `-name ${shellQuote(pattern)}`;
  // 无损全量：远端 rg 不遵守 ignore 规则，find 也不剪枝。
  const rgFlags = searchAll ? "--no-ignore" : skipGlobs;
  const findCommand = searchAll
    ? `find "$root" -type f ${matcher} -print 2>/dev/null | head -n "$limit"`
    : `find "$root" \\( ${prune} \\) -prune -o -type f ${matcher} -print 2>/dev/null | head -n "$limit"`;
  const script = [
    `root=${shellQuote(root)}`,
    `pat=${shellQuote(pattern)}`,
    `limit=${limit}`,
    `if command -v rg >/dev/null 2>&1; then`,
    `  rg --files --hidden --glob "$pat" ${rgFlags} "$root" 2>/dev/null | head -n "$limit"`,
    `else`,
    `  ${findCommand}`,
    `fi`,
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
  // 优先走精确子串匹配（含缩进定点矫正重试）；缩进敏感文件下若仍失败，
  // 尝试缩进宽松整行匹配（整块丢失/错配行首缩进时的兜底恢复）。
  let replaced: {
    content: string;
    matchedLineStart: number;
    matchedLineEnd: number;
  };
  let matchType = "exact";
  try {
    replaced = replaceContent(
      workspacePath,
      loaded.content,
      searchContent,
      replacement,
      occurrence,
    );
  } catch (error) {
    if (!isIndentationSensitivePath(workspacePath)) {
      throw error;
    }
    const relaxed = findIndentationRelaxedMatch(
      searchContent,
      replacement,
      loaded.content,
      occurrence,
    );
    if (!relaxed) {
      throw error;
    }
    const fileLines = loaded.content.split("\n");
    const newContent = [
      ...fileLines.slice(0, relaxed.startLine),
      ...relaxed.replacement.split("\n"),
      ...fileLines.slice(relaxed.endLine),
    ].join("\n");
    // 0 修改检测：宽松匹配未能带来实际变化时保持原错误。
    if (newContent === loaded.content) {
      throw error;
    }
    replaced = {
      content: newContent,
      matchedLineStart: relaxed.startLine + 1,
      matchedLineEnd: relaxed.endLine,
    };
    matchType = "indentation_relaxed";
  }
  const save = await writeRemoteText(
    workspacePath,
    workspaceRoot,
    replaced.content,
    loaded.version,
    signal,
  );

  return {
    success: true,
    occurrence,
    matchType,
    matchedLineStart: replaced.matchedLineStart,
    matchedLineEnd: replaced.matchedLineEnd,
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

const executeFilesystemCopy = async (
  args: RemoteWorkspaceCommandArgs,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> => {
  // 可见行数：与 filesystem-read 一致，忽略文件末尾换行产生的幽灵空元素。数组下标
  // 与 splice 仍沿用幽灵空串语义，只有校验与截断走这个口径。
  const visibleLineCount = (content: string, lines: string[]): number =>
    content === ""
      ? 0
      : content.endsWith("\n")
        ? lines.length - 1
        : lines.length;

  const targetPath = validateSshWorkspacePath(args.filePath, "filePath");
  const sourcePath = validateSshWorkspacePath(
    args.sourceFilePath,
    "sourceFilePath",
  );
  const workspaceRoot = resolveAuthorizedWorkspaceRoot(
    targetPath,
    args.workspaceRoot,
  );
  const targetUrl = parseSshUrl(targetPath);
  const sourceUrl = parseSshUrl(sourcePath);
  // 源与目标必须落在同一 SSH authority：workspaceRoot 只授权了一台主机，跨主机
  // 复制还需要第二条连接，直接拒绝比默默读到另一台机器的同名文件更安全。
  if (
    sourceUrl.host !== targetUrl.host ||
    sourceUrl.port !== targetUrl.port ||
    sourceUrl.username !== targetUrl.username
  ) {
    throw new Error(
      "sourceFilePath and filePath must use the same SSH authority",
    );
  }
  // 同文件判定：authority 已在上方校验一致，这里只需比较去掉尾部斜杠后的远端路径。
  const sameFile =
    normalizeRemotePath(sourceUrl.remotePath) ===
    normalizeRemotePath(targetUrl.remotePath);
  // deleteSource=true 即剪切/移动：粘贴后把源区间从源文件里删除（源文件即使被
  // 删空也只清空内容，文件本身保留）。
  const deleteSource = args.deleteSource === true;

  if (
    args.mode !== undefined &&
    args.mode !== "insert" &&
    args.mode !== "replace"
  ) {
    throw new Error('mode must be either "insert" or "replace"');
  }
  const mode: "insert" | "replace" =
    args.mode === "replace" ? "replace" : "insert";
  if (
    args.position !== undefined &&
    args.position !== "before" &&
    args.position !== "after"
  ) {
    throw new Error('position must be either "before" or "after"');
  }
  const position: "before" | "after" =
    args.position === "after" ? "after" : "before";
  // position 只在 insert 模式有意义：与 targetEndLine 的护栏对称，replace 下显式
  // 传入直接拒绝，避免参数被静默吞掉。
  if (mode === "replace" && args.position !== undefined) {
    throw new Error(
      'position is only used with mode="insert". Pass mode="insert" to insert the lines before/after targetLine, or drop position to overwrite the targetLine..targetEndLine range.',
    );
  }

  const sourceStartArg = ensureRequiredPositiveInteger(
    args.sourceStartLine,
    "sourceStartLine",
  );
  const sourceEndArg =
    ensureOptionalPositiveInteger(args.sourceEndLine) ?? sourceStartArg;
  // 目标锚点：replace 需要必填的锚点闭区间，insert 只需要可选参照行（省略即追加到末尾）。
  const anchor:
    | { mode: "replace"; startLine: number; endLine: number }
    | { mode: "insert"; line?: number } =
    mode === "replace"
      ? {
          mode: "replace",
          startLine: ensureRequiredPositiveInteger(
            args.targetLine,
            "targetLine",
          ),
          endLine: ensureRequiredPositiveInteger(
            args.targetEndLine,
            "targetEndLine",
          ),
        }
      : {
          mode: "insert",
          line: ensureOptionalPositiveInteger(args.targetLine),
        };

  // targetEndLine 只在 replace 模式有意义：insert 模式下出现多半是“想替换却漏写
  // mode”，静默按插入执行会悄悄多出一份副本，因此明确拒绝。
  if (anchor.mode === "insert" && args.targetEndLine !== undefined) {
    throw new Error(
      'targetEndLine is only used with mode="replace". Pass mode="replace" to overwrite a target range, or drop targetEndLine to insert the copied lines.',
    );
  }

  const source = await readRemoteText(sourcePath, signal);
  const sourceLines = source.content.split("\n");
  const sourceVisibleLines = visibleLineCount(source.content, sourceLines);
  if (sourceVisibleLines === 0) {
    throw new Error(
      `sourceFilePath ${sourcePath} is empty: there is no line to copy.`,
    );
  }
  // 源区间：逆序自动交换，末行越界截断到最后一行；起始行越界说明调用方行号
  // 算错，静默截断会复制到意料之外的内容，因此直接拒绝。
  const sourceStart = Math.min(sourceStartArg, sourceEndArg);
  if (sourceStart > sourceVisibleLines) {
    throw new Error(
      `sourceStartLine (${sourceStart}) is beyond the end of the source file (${sourceVisibleLines} lines)`,
    );
  }
  const sourceEnd = Math.min(
    Math.max(sourceStartArg, sourceEndArg),
    sourceVisibleLines,
  );

  // 目标锚点始终按“操作前”的行号解释。同文件剪切时 insert 的锚点若落在源区间内
  // （含两端），锚点行会被同一次删除一起拿走，位置语义含糊，因此直接拒绝；
  // 纯复制不受此限制（可以在区间内部再插一份副本）。
  if (
    deleteSource &&
    sameFile &&
    anchor.mode === "insert" &&
    anchor.line !== undefined &&
    sourceStart <= anchor.line &&
    anchor.line <= sourceEnd
  ) {
    throw new Error(
      `targetLine (${anchor.line}) falls inside the source range (${sourceStart}-${sourceEnd}) being cut from the same file; pick a target line outside that range`,
    );
  }

  // 目标文件：先判定存在性（同 filesystem-create），存在时连版本一起读出作为写入
  // 的 CAS 前置条件，不存在则用 { exists: false } 让写入走新建路径。
  const targetFile = await withSshSession(
    targetPath,
    async (sessionId, remotePath) => {
      const exists = (
        await executeSshCommand(sessionId, buildRemoteStatCommand(remotePath), {
          signal,
        })
      ).trim();
      if (!exists) {
        return {
          exists: false,
          content: "",
          version: { exists: false } as SshFileVersion,
        };
      }
      const loaded = await readSshFileWithVersion(sessionId, remotePath, {
        signal,
      });
      const file = processFileContent(remotePath, loaded.content);
      if (file.isBinary || file.isImage) {
        throw new Error("Remote filesystem copy requires a text target file");
      }
      return { exists: true, content: file.content, version: loaded.version };
    },
    { signal },
  );

  const targetLines = targetFile.exists ? targetFile.content.split("\n") : [];
  // 目标可见行数：目标不存在时按 0 行处理（新建文件没有可替换/可锚定的行）。
  const targetVisibleLines = targetFile.exists
    ? visibleLineCount(targetFile.content, targetLines)
    : 0;
  // 逐行原样搬运（不重新缩进、不改写内容）：行尾风格向目标文件靠拢，目标不存在
  // 时沿用源文件风格，让新建出来的文件与来源保持一致。
  const pastedText = adaptLineEndings(
    sourceLines.slice(sourceStart - 1, sourceEnd).join("\n"),
    targetFile.exists ? targetFile.content : source.content,
  );
  const pastedLines = pastedText.split("\n");

  // 源区间在快照上的 0-based 半开区间 [sourceStartIndex, sourceEndIndex)；
  // targetLine / targetEndLine 始终按“操作前”的行号解释（下面的修正只影响写入位置）。
  const sourceStartIndex = sourceStart - 1;
  const sourceEndIndex = sourceEnd;
  const removedLineCount = sourceEnd - sourceStart + 1;
  const cutWithinTarget = deleteSource && sameFile;
  // 同文件剪切只写一次：目标基线就是“快照删掉源区间”之后的行数组。
  const targetBaseLines = cutWithinTarget
    ? [
        ...targetLines.slice(0, sourceStartIndex),
        ...targetLines.slice(sourceEndIndex),
      ]
    : targetLines;
  // 删除点之前的下标不动，之后的下标整体前移被删除的行数（纯复制时是恒等映射）。
  const shiftAfterSourceRemoval = (index: number): number =>
    cutWithinTarget
      ? index -
        Math.min(Math.max(index - sourceStartIndex, 0), removedLineCount)
      : index;

  let newLines: string[];
  let pasteStartIndex: number;
  let replacedContent = "";
  if (anchor.mode === "replace") {
    if (!targetFile.exists) {
      throw new Error("mode=replace requires an existing target file");
    }
    if (targetVisibleLines === 0) {
      throw new Error(
        `Cannot replace lines in ${targetPath}: the file is empty. Use mode="insert" (default) instead.`,
      );
    }
    // 目标区间：逆序自动交换，末行越界截断到最后一行。
    const targetStart = Math.min(anchor.startLine, anchor.endLine);
    if (targetStart > targetVisibleLines) {
      throw new Error(
        `targetLine (${targetStart}) is beyond the end of the target file (${targetVisibleLines} lines)`,
      );
    }
    const targetEnd = Math.min(
      Math.max(anchor.startLine, anchor.endLine),
      targetVisibleLines,
    );
    // 同一文件的就地替换：两个区间重叠时行号会互相污染（先落盘的行会挪动待替换
    // 区间的位置），因此拒绝；不同文件或区间不重叠时照常执行。
    if (sameFile && targetStart <= sourceEnd && sourceStart <= targetEnd) {
      throw new Error(
        "Source and target ranges overlap in the same file; use non-overlapping ranges or copy from another file",
      );
    }
    // 被替换掉的内容按“操作前”的行号从快照取；写入位置再按同文件剪切的删除量修正。
    replacedContent = adaptLineEndings(
      targetLines.slice(targetStart - 1, targetEnd).join("\n"),
      targetFile.content,
    );
    pasteStartIndex = shiftAfterSourceRemoval(targetStart - 1);
    newLines = [
      ...targetBaseLines.slice(0, pasteStartIndex),
      ...pastedLines,
      ...targetBaseLines.slice(shiftAfterSourceRemoval(targetEnd)),
    ];
  } else {
    if (anchor.line !== undefined && anchor.line > targetVisibleLines + 1) {
      throw new Error(
        `targetLine ${anchor.line} is beyond the end of the target file (${targetPath} has ${targetVisibleLines} lines): use a line between 1 and ${targetVisibleLines + 1}, or omit targetLine to append at the end of the file.`,
      );
    }
    // insert：省略 targetLine ⇒ 追加到文件末尾；文件以换行结尾时（split 出的末尾
    // 空串）插入点落在该空串之前，既不凭空多出一个空行，也保留原有的结尾换行。
    // 显式 targetLine 的锚点截断按可见行数（targetLine = 可见行数 + 1 视作追加）。
    const insertIndex =
      anchor.line === undefined
        ? targetLines.length > 0 && targetLines[targetLines.length - 1] === ""
          ? targetLines.length - 1
          : targetLines.length
        : Math.min(anchor.line, targetVisibleLines + 1) -
          (position === "after" ? 0 : 1);
    pasteStartIndex = shiftAfterSourceRemoval(
      Math.max(0, Math.min(insertIndex, targetLines.length)),
    );
    newLines = [
      ...targetBaseLines.slice(0, pasteStartIndex),
      ...pastedLines,
      ...targetBaseLines.slice(pasteStartIndex),
    ];
  }

  const totalLines = newLines.length;
  const newContent = newLines.join("\n");
  // 同文件剪切若结果与原文逐字一致（块被挪到紧邻位置等），等价于没有移动，
  // 直接拒绝，避免回一次什么都没做的“成功剪切”。
  if (deleteSource && sameFile && newContent === targetFile.content) {
    throw new Error(
      "Cutting and pasting these ranges would leave the file unchanged (the lines are already at the target position); nothing was written",
    );
  }
  // 替换结果与原文逐字一致说明这次复制没有带来任何变化（多半是行号选错），
  // 直接拒绝，避免回一个虚假的“成功写入”。
  if (anchor.mode === "replace" && newContent === targetFile.content) {
    throw new Error(
      "mode=replace would produce an identical file (the copied lines match the replaced lines); nothing was written",
    );
  }

  // 源文件在这次操作后的行数组：纯复制保持原样；剪切是删掉源区间之后的结果，
  // 同文件剪切复用目标基线（源文件就是目标文件，不会再单独写回一次）。
  const sourceLinesAfter = deleteSource
    ? cutWithinTarget
      ? targetBaseLines
      : [
          ...sourceLines.slice(0, sourceStartIndex),
          ...sourceLines.slice(sourceEndIndex),
        ]
    : sourceLines;
  const sourceContentAfter = sourceLinesAfter.join("\n");
  // 与 filesystem-read 一致的可见行数口径：删空的源文件记 0 行。
  const sourceTotalLines = visibleLineCount(
    sourceContentAfter,
    sourceLinesAfter,
  );

  if (!targetFile.exists) {
    // 与 filesystem-create 一致：目标不存在时先补齐父目录，再由 writeSshFile 落盘。
    await withSshSession(
      targetPath,
      async (sessionId, remotePath) => {
        const parentPath = dirname(remotePath);
        if (parentPath && parentPath !== ".") {
          await executeSshCommand(
            sessionId,
            buildRemoteMkdirCommand(parentPath),
            { signal },
          );
        }
      },
      { signal },
    );
  }

  const save = await writeRemoteText(
    targetPath,
    workspaceRoot,
    newContent,
    targetFile.version,
    signal,
  );

  if (deleteSource && !sameFile) {
    // 跨文件剪切：目标先落盘，再删源文件里的区间（两侧 authority 相同，
    // workspaceRoot 对源文件同样适用）。源删除失败时把“目标已写入”说清楚，
    // 宁可留下重复副本，也不让调用方以为内容丢了。
    try {
      await writeRemoteText(
        sourcePath,
        workspaceRoot,
        sourceContentAfter,
        source.version,
        signal,
      );
    } catch (error) {
      throw new Error(
        `Target file was written, but removing the copied lines from the source file failed: ${
          error instanceof Error ? error.message : String(error)
        }. The source file still contains the copied lines, so a duplicate copy may now exist.`,
      );
    }
  }

  const matchedLineStart = pasteStartIndex + 1;
  const matchedLineEnd = pasteStartIndex + pastedLines.length;
  // 粘贴区域过大时只回传首尾各 COPY_REPORT_EDGE_LINES 行：先按真实行号建表，再把
  // 中间段 splice 成一行省略标记，review 与 pastedContent 共用这份折叠结果。
  const pastedReport = pastedLines.map((text, index) => ({
    line: matchedLineStart + index,
    text,
  }));
  const omittedLines =
    pastedLines.length > COPY_REPORT_MAX_LINES
      ? pastedLines.length - COPY_REPORT_EDGE_LINES * 2
      : 0;
  if (omittedLines > 0) {
    pastedReport.splice(COPY_REPORT_EDGE_LINES, omittedLines, {
      line: matchedLineStart + COPY_REPORT_EDGE_LINES,
      text: `... ${omittedLines} lines omitted ...`,
    });
  }

  const reviewStartLine = Math.max(
    1,
    matchedLineStart - COPY_REVIEW_CONTEXT_LINES,
  );
  const reviewEndLine = Math.min(
    totalLines,
    matchedLineEnd + COPY_REVIEW_CONTEXT_LINES,
  );
  const reviewBlocks: string[] = [];
  for (let line = reviewStartLine; line < matchedLineStart; line += 1) {
    reviewBlocks.push(
      `   ${String(line).padStart(6, " ")}: ${newLines[line - 1]}`,
    );
  }
  for (const entry of pastedReport) {
    reviewBlocks.push(
      `>>> ${String(entry.line).padStart(6, " ")}: ${entry.text}`,
    );
  }
  for (let line = matchedLineEnd + 1; line <= reviewEndLine; line += 1) {
    reviewBlocks.push(
      `   ${String(line).padStart(6, " ")}: ${newLines[line - 1]}`,
    );
  }

  // 剪切的附加回显：被删除的源行沿用同一套折叠规则（首尾各 30 行）；源复核窗口
  // 描述“源区间删除后”的上下文（前后各 5 行），整段删除不逐行标记，故不加 >>>。
  // 源文件被删空时 totalLines 与 endLine 为 0、content 为空串。
  const removedLines = deleteSource
    ? adaptLineEndings(
        sourceLines.slice(sourceStartIndex, sourceEndIndex).join("\n"),
        source.content,
      ).split("\n")
    : [];
  const removedContent =
    removedLines.length > COPY_REPORT_MAX_LINES
      ? [
          ...removedLines.slice(0, COPY_REPORT_EDGE_LINES),
          `... ${removedLines.length - COPY_REPORT_EDGE_LINES * 2} lines omitted ...`,
          ...removedLines.slice(removedLines.length - COPY_REPORT_EDGE_LINES),
        ].join("\n")
      : removedLines.join("\n");
  const sourceReviewStartLine = Math.max(
    1,
    sourceStartIndex - (COPY_REVIEW_CONTEXT_LINES - 1),
  );
  const sourceReviewEndLine = Math.min(
    sourceTotalLines,
    sourceStartIndex + COPY_REVIEW_CONTEXT_LINES,
  );
  const sourceReviewBlocks: string[] = [];
  if (deleteSource) {
    for (
      let line = sourceReviewStartLine;
      line <= sourceReviewEndLine;
      line += 1
    ) {
      sourceReviewBlocks.push(
        `   ${String(line).padStart(6, " ")}: ${sourceLinesAfter[line - 1]}`,
      );
    }
  }

  return {
    success: true,
    sourceFilePath: sourcePath,
    sourceLineStart: sourceStart,
    sourceLineEnd: sourceEnd,
    copiedLines: pastedLines.length,
    deleteSource,
    sourceTotalLines,
    targetFilePath: targetPath,
    mode: anchor.mode,
    ...(anchor.mode === "insert" ? { position } : {}),
    matchedLineStart,
    matchedLineEnd,
    totalLines,
    replacedContent,
    pastedContent: pastedReport.map((entry) => entry.text).join("\n"),
    omittedLines,
    ...(deleteSource
      ? {
          removedContent,
          sourceReview: {
            startLine: sourceReviewStartLine,
            endLine: sourceReviewEndLine,
            editedLineStart: 0,
            editedLineEnd: 0,
            totalLines: sourceTotalLines,
            content: sourceReviewBlocks.join("\n"),
          },
        }
      : {}),
    saveGuarantee: save.guarantee,
    sideEffect: save.sideEffect,
    review: {
      startLine: reviewStartLine,
      endLine: reviewEndLine,
      editedLineStart: matchedLineStart,
      editedLineEnd: matchedLineEnd,
      totalLines,
      content: reviewBlocks.join("\n"),
    },
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

const executeGrepFind = async (
  args: RemoteWorkspaceCommandArgs,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> => {
  const workspacePath = validateSshWorkspacePath(args.path, "path");
  const pattern = ensureString(args.pattern, "pattern").trim();
  if (!pattern) {
    throw new Error('pattern (glob) is required for tool "grep-find"');
  }
  const maxResults =
    typeof args.maxResults === "number" && Number.isFinite(args.maxResults)
      ? Math.max(1, Math.floor(args.maxResults))
      : 200;
  const searchAll = args.searchAll === true;

  return withSshSession(
    workspacePath,
    async (sessionId, remotePath) => {
      const output = await executeSshCommand(
        sessionId,
        buildRemoteFindCommand(remotePath, pattern, maxResults, searchAll),
        { timeoutMs: REMOTE_GREP_TIMEOUT_MS, signal },
      );
      const files = output
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .slice(0, maxResults)
        .map((filePath) =>
          buildRemoteWorkspaceUri(workspacePath, filePath, remotePath),
        );
      return {
        backend: "remote-find",
        pattern,
        path: workspacePath,
        searchAll,
        files,
        totalMatches: files.length,
        truncated: files.length >= maxResults,
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

/** 远程条目是否已不存在：stat 失败按「仍存在」处理，避免掩盖原始删除失败原因。 */
const isRemoteEntryGone = async (
  sessionId: string,
  remotePath: string,
): Promise<boolean> => {
  try {
    return (await statSshEntry(sessionId, remotePath)) === null;
  } catch {
    return false;
  }
};

/** 去掉 deleteSshFile 的统一包装前缀，只保留 SFTP 原始失败原因。 */
const describeRemoteDeleteFailure = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Failed to delete remote file:\s*/, "");
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
      } catch (error) {
        // 与本地 restore_entry 的 Missing 语义对齐：条目已经不在远程即视为
        // 删除成功，回滚恢复因此保持幂等，重复恢复不会被 ENOENT 卡死。
        if (await isRemoteEntryGone(sessionId, remotePath)) {
          return { deleted: true };
        }
        // 带上真实原因，否则用户只看到笼统的「删除远程文件失败」。
        return { deleted: false, reason: describeRemoteDeleteFailure(error) };
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

// ============================================================================
// 技能（SSH 工作区）：Rust 侧 skills_installer / skills 服务把 GitHub 仓库解压到
// 本地临时目录后，通过这几条命令把技能目录原子替换到远程 <工作区>/.snow/skills/<id>、
// 删除远程技能目录（卸载 / 安装回滚）、扫描远程技能目录树（列表 / 执行），以及
// 回写 SKILL.md（项目技能启停）。
// ============================================================================

const SKILL_STAGING_MARKER = ".snow-stage-";
const SKILL_BACKUP_MARKER = ".snow-previous-";
/** 技能入口文件名（与 Rust 侧 SKILL_FILE_NAME 一致）。 */
const SKILL_FILE_NAME = "SKILL.md";

type LocalSkillTreeEntry = {
  relativePath: string;
  isDirectory: boolean;
};

/** 收集本地技能目录的完整文件树（相对路径用 POSIX 分隔符；符号链接等其它类型跳过）。 */
const collectLocalSkillTree = async (
  root: string,
): Promise<LocalSkillTreeEntry[]> => {
  const entries: LocalSkillTreeEntry[] = [];
  const pending: Array<{ absolutePath: string; relativePath: string }> = [
    { absolutePath: root, relativePath: "" },
  ];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) {
      break;
    }
    const dirents = await readdir(current.absolutePath, {
      withFileTypes: true,
    });
    for (const dirent of dirents) {
      const relativePath = current.relativePath
        ? `${current.relativePath}/${dirent.name}`
        : dirent.name;
      if (dirent.isDirectory()) {
        entries.push({ relativePath, isDirectory: true });
        pending.push({
          absolutePath: join(current.absolutePath, dirent.name),
          relativePath,
        });
        continue;
      }
      if (dirent.isFile()) {
        entries.push({ relativePath, isDirectory: false });
      }
    }
  }
  return entries;
};

/** 目标目录同级的暂存/备份路径（点号前缀保证不会被技能扫描当成技能目录）。 */
const buildRemoteSiblingPath = (remotePath: string, marker: string): string => {
  const parent = dirname(remotePath);
  const name = remotePath.slice(parent === "/" ? 1 : parent.length + 1);
  const prefix = parent === "/" ? "" : parent;
  return `${prefix}/.${name}${marker}${randomUUID()}`;
};

/** 解析技能目录参数：目标必须与工作区同源，且位于工作区内。 */
const resolveSkillTargetPath = (
  args: RemoteWorkspaceCommandArgs,
): {
  workspaceRoot: string;
  targetPath: string;
  workspaceRemoteRoot: string;
  targetRemotePath: string;
} => {
  const workspaceRoot = validateSshWorkspacePath(
    args.workspaceRoot,
    "workspaceRoot",
  );
  const targetPath = validateSshWorkspacePath(args.path, "path");
  const workspaceRemoteRoot = resolveAuthorizedWorkspaceRoot(
    targetPath,
    workspaceRoot,
  );
  const targetRemotePath = parseSshUrl(targetPath).remotePath;
  if (!isSshPathWithinRoot(targetRemotePath, workspaceRemoteRoot)) {
    throw new Error("Skill destination must be inside the remote workspace");
  }
  return { workspaceRoot, targetPath, workspaceRemoteRoot, targetRemotePath };
};

const executeSkillsInstallDir = async (
  args: RemoteWorkspaceCommandArgs,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> => {
  const { workspaceRoot, targetPath, workspaceRemoteRoot, targetRemotePath } =
    resolveSkillTargetPath(args);
  const sourceDir = ensureString(args.sourceDir, "sourceDir");
  const entries = await collectLocalSkillTree(sourceDir);

  return withSshSession(
    workspaceRoot,
    async (sessionId) => {
      const stagingPath = buildRemoteSiblingPath(
        targetRemotePath,
        SKILL_STAGING_MARKER,
      );
      const backupPath = buildRemoteSiblingPath(
        targetRemotePath,
        SKILL_BACKUP_MARKER,
      );

      // 先把整个技能目录上传到暂存目录：上传中途失败时目标目录保持原样。
      await executeSshCommand(
        sessionId,
        `rm -rf -- ${shellQuote(stagingPath)}`,
        {
          signal,
        },
      );
      await executeSshCommand(sessionId, buildRemoteMkdirCommand(stagingPath), {
        signal,
      });
      for (const entry of entries) {
        const remoteEntryPath = `${stagingPath}/${entry.relativePath}`;
        if (entry.isDirectory) {
          await executeSshCommand(
            sessionId,
            buildRemoteMkdirCommand(remoteEntryPath),
            { signal },
          );
          continue;
        }
        const content = await readFile(join(sourceDir, entry.relativePath));
        await writeInternalSshFile(sessionId, remoteEntryPath, content, {
          signal,
          workspaceRoot: workspaceRemoteRoot,
        });
      }

      // 再原子替换：旧目录先改名保留，新目录就位后再删除；替换失败恢复旧目录。
      const replaced =
        (await statSshEntry(sessionId, targetRemotePath)) !== null;
      if (replaced) {
        await renameSshFile(sessionId, targetRemotePath, backupPath);
      }
      try {
        await renameSshFile(sessionId, stagingPath, targetRemotePath);
      } catch (error) {
        if (replaced) {
          await renameSshFile(sessionId, backupPath, targetRemotePath).catch(
            () => undefined,
          );
        }
        await executeSshCommand(
          sessionId,
          `rm -rf -- ${shellQuote(stagingPath)}`,
          { signal },
        ).catch(() => undefined);
        throw error;
      }
      if (replaced) {
        await executeSshCommand(
          sessionId,
          `rm -rf -- ${shellQuote(backupPath)}`,
          { signal },
        );
      }

      return {
        path: targetPath,
        replaced,
        fileCount: entries.filter((entry) => !entry.isDirectory).length,
      };
    },
    { signal },
  );
};

const executeSkillsRemoveDir = async (
  args: RemoteWorkspaceCommandArgs,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> => {
  const { workspaceRoot, targetPath, targetRemotePath } =
    resolveSkillTargetPath(args);
  return withSshSession(
    workspaceRoot,
    async (sessionId) => {
      await executeSshCommand(
        sessionId,
        `rm -rf -- ${shellQuote(targetRemotePath)}`,
        { signal },
      );
      return { path: targetPath, removed: true };
    },
    { signal },
  );
};

/** 技能目录扫描：单个技能根目录的条目上限，避免异常目录把响应撑爆。 */
const SKILL_SCAN_MAX_ENTRIES = 4000;
/** 与 Rust 侧 should_skip_skill_directory 保持一致：不进入点目录与这些目录。 */
const SKILL_SCAN_SKIP_DIRECTORIES = new Set([
  "templates",
  "examples",
  "node_modules",
]);

const shouldSkipRemoteSkillDirectory = (name: string): boolean =>
  name.startsWith(".") || SKILL_SCAN_SKIP_DIRECTORIES.has(name);

type RemoteSkillScanEntry = { path: string; type: "f" | "d" };

/**
 * 递归扫描一个远程技能根目录：返回全部条目（相对根目录的 POSIX 路径）与每个
 * SKILL.md 的原文。目录发现、ID 派生与 frontmatter 解析都留在 Rust 侧，
 * 这里只负责把目录树读回来。
 */
const scanRemoteSkillRoot = async (
  sessionId: string,
  remoteRoot: string,
  signal?: AbortSignal,
): Promise<{
  entries: RemoteSkillScanEntry[];
  files: Record<string, string>;
}> => {
  const entries: RemoteSkillScanEntry[] = [];
  const files: Record<string, string> = {};
  const rootStat = await statSshEntry(sessionId, remoteRoot);
  if (!rootStat?.isDirectory()) {
    return { entries, files };
  }

  const pending: string[] = [""];
  while (pending.length > 0 && entries.length < SKILL_SCAN_MAX_ENTRIES) {
    const relativeDirectory = pending.pop() as string;
    const absoluteDirectory = relativeDirectory
      ? `${remoteRoot}/${relativeDirectory}`
      : remoteRoot;
    const children = await listSshDirectory(sessionId, absoluteDirectory, {
      signal,
    });
    for (const child of children) {
      if (child.name === "." || child.name === "..") {
        continue;
      }
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${child.name}`
        : child.name;
      if (child.isDirectory) {
        if (shouldSkipRemoteSkillDirectory(child.name)) {
          continue;
        }
        entries.push({ path: relativePath, type: "d" });
        pending.push(relativePath);
        continue;
      }
      // 符号链接等其它类型与本地扫描一致地跳过。
      if (child.isSymbolicLink) {
        continue;
      }
      entries.push({ path: relativePath, type: "f" });
      if (child.name === SKILL_FILE_NAME) {
        const content = await readSshFile(
          sessionId,
          `${remoteRoot}/${relativePath}`,
          { signal },
        );
        files[relativePath] = content.toString("utf-8");
      }
    }
  }

  return { entries, files };
};

const executeSkillsScan = async (
  args: RemoteWorkspaceCommandArgs,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> => {
  const workspaceRoot = validateSshWorkspacePath(
    args.workspaceRoot,
    "workspaceRoot",
  );
  const paths = ensureSshPathList(args.paths, "paths");
  const workspaceRemoteRoot = resolveAuthorizedWorkspaceRoot(
    paths[0],
    workspaceRoot,
  );

  return withSshSession(
    workspaceRoot,
    async (sessionId) => {
      const roots: Array<{
        path: string;
        entries: RemoteSkillScanEntry[];
        files: Record<string, string>;
      }> = [];
      for (const uri of paths) {
        const remoteRoot = parseSshUrl(uri).remotePath;
        if (!isSshPathWithinRoot(remoteRoot, workspaceRemoteRoot)) {
          throw new Error("Skill root must be inside the remote workspace");
        }
        roots.push({
          path: uri,
          ...(await scanRemoteSkillRoot(sessionId, remoteRoot, signal)),
        });
      }
      return { roots };
    },
    { signal },
  );
};

const executeSkillsWriteFile = async (
  args: RemoteWorkspaceCommandArgs,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> => {
  const { workspaceRoot, targetPath, workspaceRemoteRoot, targetRemotePath } =
    resolveSkillTargetPath(args);
  const content = ensureString(args.content, "content");
  return withSshSession(
    workspaceRoot,
    async (sessionId) => {
      const save = await writeInternalSshFile(
        sessionId,
        targetRemotePath,
        content,
        { signal, workspaceRoot: workspaceRemoteRoot },
      );
      return { path: targetPath, bytes: save.bytes };
    },
    { signal },
  );
};

const dispatchRemoteWorkspaceOperation = async (
  operation: string,
  args: RemoteWorkspaceCommandArgs,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> => {
  switch (operation) {
    case "filesystem-read":
      return executeFilesystemRead(args, signal);
    case "filesystem-replace_edit":
      return executeFilesystemReplaceEdit(args, signal);
    case "filesystem-create":
      return executeFilesystemCreate(args, signal);
    case "filesystem-copy":
      return executeFilesystemCopy(args, signal);
    case "grep-search":
      return executeGrepSearch(args, signal);
    case "grep-find":
      return executeGrepFind(args, signal);
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
    case "skills-install-dir":
      return executeSkillsInstallDir(args, signal);
    case "skills-remove-dir":
      return executeSkillsRemoveDir(args, signal);
    case "skills-scan":
      return executeSkillsScan(args, signal);
    case "skills-write-file":
      return executeSkillsWriteFile(args, signal);
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
