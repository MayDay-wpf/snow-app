import { BrowserWindow, dialog, ipcMain } from "electron";
import { homedir } from "node:os";
import type { NativeBridge, RemoteDraftInput } from "../../native/types";
import {
  connectSsh,
  disconnectSsh,
  executeSshCommand,
  listSshDirectory,
  parseSshUrl,
  probeSshCapabilities,
  isSshPath,
  readSshFile,
  readSshFileWithVersion,
  resolveSshWorkspaceRoot,
  writeSshFile,
  deleteSshFile,
  renameSshFile,
  deleteSshDirectory,
  statSshEntry,
  type SshConnectParams,
  type SshFileVersion,
} from "../../ssh/sshManager";
import { sshConnectionManager } from "../../ssh/sshConnectionManager";
import { processFileContent } from "../../utils/fileReader";
import {
  saveSshCredentialWithPlainSecret,
  getSshCredential,
  getDecryptedSecret,
  listSshCredentials,
  deleteSshCredential,
} from "../../ssh/sshCredentials";
import {
  cancelRemoteJob,
  cleanupRemoteJobs,
  getRemoteJob,
  getRemoteJobAttachSpec,
  getRemoteJobAnalysisContext,
  listRemoteJobs,
  startRemoteJob,
  type RemoteJobBackendKind,
  type RemoteJobStartRequest,
} from "../../ssh/remoteJobs";
import { createRemoteJobPtySession } from "../../pty/ptyManager";
import { listSshConfigHosts } from "../../ssh/sshConfig";
import { classifySshConnectError } from "../../ssh/sshErrors";

const REMOTE_SEARCH_MAX_DEPTH = 15;
const REMOTE_SEARCH_MAX_RESULTS = 200;

const shellQuote = (value: string): string =>
  `'${value.replace(/'/g, `'"'"'`)}'`;

const normalizeRemotePath = (path: string): string => {
  const normalized = path.replace(/\/+$/, "");
  return normalized || "/";
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

const buildRemoteWorkspaceUri = (
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

const getRemotePathName = (path: string): string => {
  const normalizedPath = normalizeRemotePath(path);
  const separatorIndex = normalizedPath.lastIndexOf("/");
  return normalizedPath.slice(separatorIndex + 1) || "/";
};

const toRemoteWorkspaceSearchResult = (
  workspacePath: string,
  remotePath: string,
  remoteRootPath: string,
  isDirectory: boolean
): {
  path: string;
  relativePath: string;
  name: string;
  isDirectory: boolean;
  matchedName: boolean;
  lineMatches: Array<{ line: number; text: string }>;
} => ({
  path: buildRemoteWorkspaceUri(workspacePath, remotePath, remoteRootPath),
  relativePath: getRemoteRelativePath(remotePath, remoteRootPath),
  name: getRemotePathName(remotePath),
  isDirectory,
  matchedName: true,
  lineMatches: [],
});

const buildRemoteWorkspaceSearchCommand = (
  rootPath: string,
  query: string
): string => {
  // Path-aware search: a query containing "/" (e.g. "prompt/" or
  // "prompt/utils") resolves the part before the last "/" as a directory
  // path and lists the directory itself plus its children.
  if (query.includes("/")) {
    return buildRemoteWorkspacePathSearchCommand(rootPath, query);
  }

  const script = [
    `root=${shellQuote(rootPath)}`,
    `query=${shellQuote(query)}`,
    `max_depth=${REMOTE_SEARCH_MAX_DEPTH}`,
    `max_results=${REMOTE_SEARCH_MAX_RESULTS}`,
    "count=0",
    'find "$root" -maxdepth "$max_depth" \\( -type d \\( -name .git -o -name node_modules -o -name target -o -name dist -o -name build -o -name .next -o -name .snow \\) -prune \\) -o -mindepth 1 -print | while IFS= read -r path; do',
    '  [ "$count" -ge "$max_results" ] && break',
    "  name=${path##*/}",
    '  case "$name" in .* ) continue ;; esac',
    "  lower_name=$(printf '%s' \"$name\" | tr '[:upper:]' '[:lower:]')",
    "  lower_query=$(printf '%s' \"$query\" | tr '[:upper:]' '[:lower:]')",
    '  if printf \'%s\' "$lower_name" | grep -Fq -- "$lower_query"; then',
    '    if [ -d "$path" ]; then kind=d; else kind=f; fi',
    '    printf \'%s\\t%s\\n\' "$kind" "$path"',
    "    count=$((count + 1))",
    "  fi",
    "done",
  ].join("\n");

  return `sh -lc ${shellQuote(script)}`;
};

// Path-aware search for remote workspaces: resolves the directory path from
// the query segments, then lists the directory itself (when it is not the
// workspace root) and its direct children filtered by the trailing name
// query (empty means list all). Falls back to the regular name search when
// the directory does not exist.
const buildRemoteWorkspacePathSearchCommand = (
  rootPath: string,
  query: string
): string => {
  const parts = query.split("/");
  const nameQuery = parts[parts.length - 1] ?? "";
  const dirParts = parts.slice(0, -1).filter(Boolean);
  const dirPath =
    dirParts.length === 0
      ? rootPath
      : `${rootPath}/${dirParts.join("/")}`.replace(/\/+/g, "/");
  // Directory segment used for workspace-wide matching when the exact
  // directory does not exist (e.g. "prompt" for "prompt/utils/").
  const matchSegment = dirParts[0] ?? nameQuery;

  // Workspace-wide fallback: collect directories at any depth whose name
  // starts with the first query segment, then list each directory itself
  // plus its direct children filtered by the trailing name query.
  const fallbackScript = [
    `root=${shellQuote(rootPath)}`,
    `seg=${shellQuote(matchSegment)}`,
    `name_query=${shellQuote(nameQuery)}`,
    `max_depth=${REMOTE_SEARCH_MAX_DEPTH}`,
    `max_results=${REMOTE_SEARCH_MAX_RESULTS}`,
    "count=0",
    'find "$root" -maxdepth "$max_depth" \\( -type d \\( -name .git -o -name node_modules -o -name target -o -name dist -o -name build -o -name .next -o -name .snow \\) -prune \\) -o -type d -print | while IFS= read -r cand; do',
    '  [ "$count" -ge "$max_results" ] && break',
    '  [ "$cand" = "$root" ] && continue',
    "  base=${cand##*/}",
    '  case "$base" in .* ) continue ;; esac',
    "  lower_base=$(printf '%s' \\\"$base\\\" | tr '[:upper:]' '[:lower:]')",
    "  lower_seg=$(printf '%s' \\\"$seg\\\" | tr '[:upper:]' '[:lower:]')",
    '  case "$lower_base" in "$lower_seg"* )',
    "    printf 'd\\t%s\\n' \"$cand\"",
    "    count=$((count + 1))",
    '    find "$cand" -maxdepth 1 -mindepth 1 -print | while IFS= read -r path; do',
    '      [ "$count" -ge "$max_results" ] && break',
    "      name=${path##*/}",
    '      case "$name" in .* ) continue ;; esac',
    "      lower_name=$(printf '%s' \\\"$name\\\" | tr '[:upper:]' '[:lower:]')",
    "      lower_query=$(printf '%s' \\\"$name_query\\\" | tr '[:upper:]' '[:lower:]')",
    '      if [ -z "$name_query" ] || printf \'%s\' "$lower_name" | grep -Fq -- "$lower_query"; then',
    '        if [ -d "$path" ]; then kind=d; else kind=f; fi',
    '        printf \'%s\\t%s\\n\' "$kind" "$path"',
    "        count=$((count + 1))",
    "      fi",
    "    done",
    "    ;;",
    "  esac",
    "done",
  ].join("\n");

  const script = [
    `root=${shellQuote(rootPath)}`,
    `dir=${shellQuote(dirPath)}`,
    `name_query=${shellQuote(nameQuery)}`,
    `max_results=${REMOTE_SEARCH_MAX_RESULTS}`,
    "count=0",
    // Include the directory itself when it is not the workspace root.
    'if [ -d "$dir" ] && [ "$dir" != "$root" ]; then',
    "  printf 'd\\t%s\\n' \"$dir\"",
    "  count=$((count + 1))",
    "fi",
    // List the direct children of the directory.
    'if [ -d "$dir" ]; then',
    '  find "$dir" -maxdepth 1 -mindepth 1 -print | while IFS= read -r path; do',
    '    [ "$count" -ge "$max_results" ] && break',
    "    name=${path##*/}",
    '    case "$name" in .* ) continue ;; esac',
    "    lower_name=$(printf '%s' \\\"$name\\\" | tr '[:upper:]' '[:lower:]')",
    "    lower_query=$(printf '%s' \\\"$name_query\\\" | tr '[:upper:]' '[:lower:]')",
    '    if [ -z "$name_query" ] || printf \'%s\' "$lower_name" | grep -Fq -- "$lower_query"; then',
    '      if [ -d "$path" ]; then kind=d; else kind=f; fi',
    '      printf \'%s\\t%s\\n\' "$kind" "$path"',
    "      count=$((count + 1))",
    "    fi",
    "  done",
    // Directory not found: fall back to the regular name search.
    "else",
    fallbackScript,
    "fi",
  ].join("\n");

  return `sh -lc ${shellQuote(script)}`;
};

const parseRemoteWorkspaceSearchResults = (
  output: string,
  workspacePath: string,
  remoteRootPath: string
): Array<{
  path: string;
  relativePath: string;
  name: string;
  isDirectory: boolean;
  matchedName: boolean;
  lineMatches: Array<{ line: number; text: string }>;
}> => {
  return output
    .split("\n")
    .flatMap((line) => {
      const [kind, remotePath] = line.split("\t", 2);
      if ((kind !== "d" && kind !== "f") || !remotePath) {
        return [];
      }

      return [
        toRemoteWorkspaceSearchResult(
          workspacePath,
          remotePath,
          remoteRootPath,
          kind === "d"
        ),
      ];
    })
    .sort((left, right) => {
      if (left.isDirectory !== right.isDirectory) {
        return left.isDirectory ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    })
    .slice(0, REMOTE_SEARCH_MAX_RESULTS);
};

export const registerSshHandlers = (_native: NativeBridge): void => {
  const normalizeSshConnectParams = (value: unknown): SshConnectParams => {
    if (typeof value !== "object" || value === null) {
      throw new Error("SSH connect params must be an object");
    }
    const obj = value as Record<string, unknown>;
    const host = typeof obj.host === "string" ? obj.host.trim() : "";
    const port = typeof obj.port === "number" ? obj.port : 22;
    const username =
      typeof obj.username === "string" ? obj.username.trim() : "";
    const authMethod =
      obj.authMethod === "password" ||
      obj.authMethod === "privateKey" ||
      obj.authMethod === "agent"
        ? (obj.authMethod as SshConnectParams["authMethod"])
        : "password";

    if (!host) {
      throw new Error("SSH host is required");
    }
    if (!username) {
      throw new Error("SSH username is required");
    }

    const result: SshConnectParams = { host, port, username, authMethod };
    if (typeof obj.password === "string" && obj.password) {
      result.password = obj.password;
    }
    if (typeof obj.privateKeyPath === "string" && obj.privateKeyPath) {
      result.privateKeyPath = obj.privateKeyPath;
    }
    if (typeof obj.passphrase === "string" && obj.passphrase) {
      result.passphrase = obj.passphrase;
    }
    if (obj.hostKeyPolicy === "replace") {
      result.hostKeyPolicy = "replace";
    }
    return result;
  };

  const normalizeSshFileVersion = (value: unknown): SshFileVersion => {
    if (typeof value !== "object" || value === null) {
      throw new Error("Remote file version must be an object");
    }
    const input = value as Record<string, unknown>;
    if (typeof input.exists !== "boolean") {
      throw new Error("Remote file version must include exists");
    }
    if (!input.exists) {
      return { exists: false };
    }
    if (
      typeof input.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/i.test(input.sha256) ||
      typeof input.size !== "number" ||
      !Number.isSafeInteger(input.size) ||
      input.size < 0 ||
      typeof input.mtime !== "number" ||
      !Number.isFinite(input.mtime) ||
      input.mtime < 0
    ) {
      throw new Error("Remote file version is invalid");
    }
    return {
      exists: true,
      sha256: input.sha256,
      size: input.size,
      mtime: input.mtime,
    };
  };

  const normalizeProfileId = (value: unknown): string => {
    if (typeof value !== "string" || !value.trim().startsWith("ssh-profile:")) {
      throw new Error("SSH profile ID is required");
    }
    return value.trim();
  };

  const normalizeRemoteDraftInput = (value: unknown): RemoteDraftInput => {
    if (typeof value !== "object" || value === null) {
      throw new Error("Remote draft must be an object");
    }
    const input = value as Record<string, unknown>;
    const profileId = normalizeProfileId(input.profileId);
    const workspaceId =
      typeof input.workspaceId === "string" ? input.workspaceId.trim() : "";
    const remotePath =
      typeof input.remotePath === "string" ? input.remotePath.trim() : "";
    const baseVersionJson =
      typeof input.baseVersionJson === "string" ? input.baseVersionJson : "";
    const content = typeof input.content === "string" ? input.content : null;
    const status = input.status;
    if (!workspaceId || !remotePath || content === null) {
      throw new Error("Remote draft workspace, path, and content are required");
    }
    if (status !== "pending" && status !== "conflict") {
      throw new Error("Remote draft status is invalid");
    }
    try {
      JSON.parse(baseVersionJson);
    } catch {
      throw new Error("Remote draft base version must be JSON");
    }
    return {
      profileId,
      workspaceId,
      remotePath,
      baseVersionJson,
      content,
      status,
    };
  };

  sshConnectionManager.subscribe((state) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send("ssh:profile-state", state);
      }
    }
  });

  ipcMain.handle("ssh:profiles:connect", async (_event, params: unknown) =>
    sshConnectionManager.acquire(normalizeSshConnectParams(params))
  );
  ipcMain.handle("ssh:profiles:get", (_event, profileId: unknown) =>
    sshConnectionManager.get(normalizeProfileId(profileId))
  );
  ipcMain.handle("ssh:profiles:release", (_event, profileId: unknown) => {
    sshConnectionManager.release(normalizeProfileId(profileId));
  });
  ipcMain.handle(
    "ssh:drafts:list",
    (_event, workspaceId: unknown, profileId: unknown) => {
      if (typeof workspaceId !== "string" || !workspaceId.trim()) {
        throw new Error("Remote draft workspace ID is required");
      }
      return _native.listRemoteDrafts(
        workspaceId.trim(),
        profileId === undefined || profileId === null
          ? undefined
          : normalizeProfileId(profileId)
      );
    }
  );
  ipcMain.handle("ssh:drafts:upsert", (_event, draft: unknown) =>
    _native.upsertRemoteDraft(normalizeRemoteDraftInput(draft))
  );
  ipcMain.handle(
    "ssh:drafts:delete",
    (_event, profileId: unknown, workspaceId: unknown, remotePath: unknown) => {
      if (typeof workspaceId !== "string" || !workspaceId.trim()) {
        throw new Error("Remote draft workspace ID is required");
      }
      if (typeof remotePath !== "string" || !remotePath.trim()) {
        throw new Error("Remote draft path is required");
      }
      return _native.deleteRemoteDraft(
        normalizeProfileId(profileId),
        workspaceId.trim(),
        remotePath.trim()
      );
    }
  );

  const normalizeSshFileWriteOptions = async (
    sessionId: string,
    value: unknown
  ): Promise<{ expectedVersion: SshFileVersion; workspaceRoot: string }> => {
    if (typeof value !== "object" || value === null) {
      throw new Error("Atomic remote file save requires write options");
    }
    const input = value as Record<string, unknown>;
    if (input.workspaceRoot !== undefined) {
      throw new Error("Atomic remote file save does not accept workspaceRoot");
    }
    if (typeof input.workspaceId !== "string" || !input.workspaceId.trim()) {
      throw new Error("Atomic remote file save requires a workspace ID");
    }
    if (input.expectedVersion === undefined) {
      throw new Error("Atomic remote file save requires an expected file version");
    }
    const workspaceId = input.workspaceId.trim();
    const workspaces = await _native.listWorkspaceDirectories();
    const workspace = workspaces.find(
      (directory) => directory.directoryId === workspaceId
    );
    if (!workspace || workspace.kind !== "ssh") {
      throw new Error("Atomic remote file save workspace is not an SSH workspace");
    }
    return {
      workspaceRoot: resolveSshWorkspaceRoot(
        sessionId,
        workspace.path
      ),
      expectedVersion: normalizeSshFileVersion(input.expectedVersion),
    };
  };

  const normalizeRemoteJobStartRequest = (
    value: unknown
  ): RemoteJobStartRequest => {
    if (typeof value !== "object" || value === null) {
      throw new Error("Remote Job request must be an object");
    }
    const input = value as Record<string, unknown>;
    const workspacePath =
      typeof input.workspacePath === "string" ? input.workspacePath.trim() : "";
    const command = typeof input.command === "string" ? input.command : "";
    if (!workspacePath.startsWith("ssh://")) {
      throw new Error("Remote Job workspace must be an SSH path");
    }
    if (!command.trim()) {
      throw new Error("Remote Job command is required");
    }
    const backend =
      input.backend === "snow-agent" ||
      input.backend === "systemd-user" ||
      input.backend === "tmux" ||
      input.backend === "posix-detach"
        ? (input.backend as RemoteJobBackendKind)
        : undefined;
    if (input.backend !== undefined && !backend) {
      throw new Error("Unknown Remote Job backend");
    }
    const mode =
      input.mode === "batch" || input.mode === "interactive"
        ? input.mode
        : undefined;
    if (input.mode !== undefined && !mode) {
      throw new Error("Unknown Remote Job mode");
    }
    const optionalString = (candidate: unknown): string | undefined =>
      typeof candidate === "string" && candidate.trim()
        ? candidate.trim()
        : undefined;
    if (
      input.timeoutMs !== undefined &&
      (typeof input.timeoutMs !== "number" || !Number.isFinite(input.timeoutMs))
    ) {
      throw new Error("Remote Job timeout must be a number");
    }
    return {
      workspacePath,
      command,
      workspaceId: optionalString(input.workspaceId),
      timeoutMs: input.timeoutMs as number | undefined,
      jobId: optionalString(input.jobId),
      backend,
      mode,
      conversationId: optionalString(input.conversationId),
      toolCallId: optionalString(input.toolCallId),
    };
  };

  const normalizeJobId = (value: unknown): string => {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error("Remote Job ID is required");
    }
    return value.trim();
  };

  const normalizeJobReadOptions = (
    value: unknown
  ): { offset?: number; limit?: number } => {
    if (value === undefined || value === null) {
      return {};
    }
    if (typeof value !== "object") {
      throw new Error("Remote Job read options must be an object");
    }
    const input = value as Record<string, unknown>;
    const normalize = (candidate: unknown, label: string): number | undefined => {
      if (candidate === undefined) {
        return undefined;
      }
      if (
        typeof candidate !== "number" ||
        !Number.isFinite(candidate) ||
        candidate < 0
      ) {
        throw new Error(`Remote Job ${label} must be a non-negative number`);
      }
      return Math.floor(candidate);
    };
    return {
      offset: normalize(input.offset, "offset"),
      limit: normalize(input.limit, "limit"),
    };
  };

  const normalizeJobAttachViewport = (
    value: unknown
  ): { cols: number; rows: number } => {
    if (typeof value !== "object" || value === null) {
      throw new Error("Remote Job attach viewport is required");
    }
    const input = value as Record<string, unknown>;
    const normalize = (candidate: unknown, label: string): number => {
      if (
        typeof candidate !== "number" ||
        !Number.isFinite(candidate) ||
        candidate < 1
      ) {
        throw new Error(`Remote Job attach ${label} must be a positive number`);
      }
      return Math.min(500, Math.floor(candidate));
    };
    return {
      cols: normalize(input.cols, "cols"),
      rows: normalize(input.rows, "rows"),
    };
  };

  ipcMain.handle("ssh:connect", async (_event, params: unknown) => {
    // 连接失败不抛异常，而是返回结构化结果：渲染层拿到稳定的错误码
    // （network/timeout/auth/sftp/invalid/unknown）做本地化展示，原始
    // 技术消息放在 detail 中供排查，避免透传 ssh2 的英文原始错误。
    try {
      const connectParams = normalizeSshConnectParams(params);
      const sessionId = await connectSsh(connectParams);
      return { ok: true as const, sessionId };
    } catch (err) {
      const info = classifySshConnectError(err);
      return {
        ok: false as const,
        code: info.code,
        message: info.message,
        detail: info.detail,
      };
    }
  });

  ipcMain.handle(
    "ssh:list-directory",
    async (_event, sessionId: unknown, remotePath: unknown) => {
      if (typeof sessionId !== "string" || !sessionId.trim()) {
        throw new Error("SSH session ID is required");
      }
      if (typeof remotePath !== "string" || !remotePath.trim()) {
        throw new Error("Remote directory path is required");
      }
      return listSshDirectory(sessionId.trim(), remotePath.trim());
    }
  );

  ipcMain.handle(
    "ssh:execute-command",
    async (_event, sessionId: unknown, command: unknown) => {
      if (typeof sessionId !== "string" || !sessionId.trim()) {
        throw new Error("SSH session ID is required");
      }
      if (typeof command !== "string" || !command.trim()) {
        throw new Error("Remote command is required");
      }
      return executeSshCommand(sessionId.trim(), command);
    }
  );

  ipcMain.handle("ssh:probe-capabilities", async (_event, sessionId: unknown) => {
    if (typeof sessionId !== "string" || !sessionId.trim()) {
      throw new Error("SSH session ID is required");
    }
    return probeSshCapabilities(sessionId.trim());
  });

  ipcMain.handle("ssh:jobs:start", async (_event, request: unknown) =>
    startRemoteJob(normalizeRemoteJobStartRequest(request))
  );
  ipcMain.handle("ssh:jobs:list", async (_event, workspacePath: unknown) => {
    if (workspacePath === undefined || workspacePath === null) {
      return listRemoteJobs();
    }
    if (
      typeof workspacePath !== "string" ||
      !workspacePath.trim().startsWith("ssh://")
    ) {
      throw new Error("Remote Job workspace must be an SSH path");
    }
    return listRemoteJobs(workspacePath.trim());
  });
  ipcMain.handle(
    "ssh:jobs:get",
    async (_event, jobId: unknown, options: unknown) =>
      getRemoteJob(normalizeJobId(jobId), normalizeJobReadOptions(options))
  );
  ipcMain.handle("ssh:jobs:cancel", async (_event, jobId: unknown) =>
    cancelRemoteJob(normalizeJobId(jobId))
  );
  ipcMain.handle(
    "ssh:jobs:attach",
    async (event, jobId: unknown, viewport: unknown) => {
      const spec = await getRemoteJobAttachSpec(normalizeJobId(jobId));
      const size = normalizeJobAttachViewport(viewport);
      return {
        jobId: spec.jobId,
        backend: spec.backend,
        ptyId: await createRemoteJobPtySession(
          event.sender,
          spec.workspacePath,
          spec.remoteCommand,
          size.cols,
          size.rows
        ),
      };
    }
  );
  ipcMain.handle(
    "ssh:jobs:analysis-context",
    async (_event, jobId: unknown, options: unknown) =>
      getRemoteJobAnalysisContext(
        normalizeJobId(jobId),
        normalizeJobReadOptions(options)
      )
  );
  ipcMain.handle("ssh:jobs:cleanup", () => cleanupRemoteJobs());

  ipcMain.handle(
    "ssh:search-workspace-files",
    async (_event, workspacePath: unknown, options: unknown) => {
      if (
        typeof workspacePath !== "string" ||
        !isSshPath(workspacePath.trim())
      ) {
        throw new Error("Remote workspace path is required");
      }
      if (typeof options !== "object" || options === null) {
        throw new Error("Remote workspace search options are required");
      }

      const { query, listChildren } = options as Record<string, unknown>;
      if (typeof query !== "string") {
        throw new Error("Remote workspace query must be a string");
      }
      if (typeof listChildren !== "boolean") {
        throw new Error("Remote workspace listChildren option is required");
      }
      if (!listChildren && !query.trim()) {
        return [];
      }

      const parsed = parseSshUrl(workspacePath.trim());
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

      const sessionId = await connectSsh(connectParams);
      try {
        if (listChildren) {
          return (await listSshDirectory(sessionId, parsed.remotePath)).map(
            (entry) =>
              toRemoteWorkspaceSearchResult(
                workspacePath.trim(),
                entry.path,
                parsed.remotePath,
                entry.isDirectory
              )
          );
        }

        const output = await executeSshCommand(
          sessionId,
          buildRemoteWorkspaceSearchCommand(parsed.remotePath, query.trim())
        );
        return parseRemoteWorkspaceSearchResults(
          output,
          workspacePath.trim(),
          parsed.remotePath
        );
      } finally {
        disconnectSsh(sessionId);
      }
    }
  );

  ipcMain.handle(
    "ssh:read-file",
    async (_event, sessionId: unknown, remotePath: unknown) => {
      if (typeof sessionId !== "string" || !sessionId.trim()) {
        throw new Error("SSH session ID is required");
      }
      if (typeof remotePath !== "string" || !remotePath.trim()) {
        throw new Error("Remote file path is required");
      }
      const file = await readSshFileWithVersion(
        sessionId.trim(),
        remotePath.trim()
      );
      return {
        ...processFileContent(remotePath.trim(), file.content),
        remoteVersion: file.version,
      };
    }
  );

  ipcMain.handle(
    "ssh:write-file",
    async (
      _event,
      sessionId: unknown,
      remotePath: unknown,
      content: unknown,
      options: unknown
    ) => {
      if (typeof sessionId !== "string" || !sessionId.trim()) {
        throw new Error("SSH session ID is required");
      }
      if (typeof remotePath !== "string" || !remotePath.trim()) {
        throw new Error("Remote file path is required");
      }
      if (typeof content !== "string") {
        throw new Error("File content must be a string");
      }
      return writeSshFile(
        sessionId.trim(),
        remotePath.trim(),
        content,
        await normalizeSshFileWriteOptions(sessionId.trim(), options)
      );
    }
  );

  ipcMain.handle(
    "ssh:delete-entry",
    async (_event, sessionId: unknown, remotePath: unknown) => {
      if (typeof sessionId !== "string" || !sessionId.trim()) {
        throw new Error("SSH session ID is required");
      }
      if (typeof remotePath !== "string" || !remotePath.trim()) {
        throw new Error("Remote path is required");
      }

      const trimmedSessionId = sessionId.trim();
      const trimmedPath = remotePath.trim();

      // Determine whether the entry is a file or directory so we can call the
      // appropriate deletion routine (SFTP unlink for files, recursive rm -rf
      // for directories via the exec channel).
      const stats = await statSshEntry(trimmedSessionId, trimmedPath);
      if (!stats) {
        throw new Error("Remote path does not exist");
      }
      if (stats.isDirectory()) {
        return deleteSshDirectory(trimmedSessionId, trimmedPath);
      }
      return deleteSshFile(trimmedSessionId, trimmedPath);
    }
  );

  ipcMain.handle(
    "ssh:rename-entry",
    async (
      _event,
      sessionId: unknown,
      remotePath: unknown,
      newName: unknown
    ) => {
      if (typeof sessionId !== "string" || !sessionId.trim()) {
        throw new Error("SSH session ID is required");
      }
      if (typeof remotePath !== "string" || !remotePath.trim()) {
        throw new Error("Remote path is required");
      }
      if (typeof newName !== "string" || !newName.trim()) {
        throw new Error("New entry name is required");
      }

      const trimmedPath = remotePath.trim();
      const trimmedNewName = newName.trim();

      // Build the destination path by replacing the last path segment with the
      // new name, matching the behavior of the local rename implementation.
      const separatorIndex = trimmedPath.lastIndexOf("/");
      const parentDir =
        separatorIndex > 0 ? trimmedPath.slice(0, separatorIndex) : "/";
      const newPath =
        parentDir === "/"
          ? `/${trimmedNewName}`
          : `${parentDir}/${trimmedNewName}`;

      return renameSshFile(sessionId.trim(), trimmedPath, newPath);
    }
  );

  ipcMain.handle("ssh:disconnect", (_event, sessionId: unknown) => {
    if (typeof sessionId !== "string") {
      return;
    }
    disconnectSsh(sessionId);
  });

  ipcMain.handle("ssh:save-credential", (_event, params: unknown) => {
    if (typeof params !== "object" || params === null) {
      throw new Error("SSH credential params must be an object");
    }
    const obj = params as Record<string, unknown>;
    const host = typeof obj.host === "string" ? obj.host.trim() : "";
    const port = typeof obj.port === "number" ? obj.port : 22;
    const username =
      typeof obj.username === "string" ? obj.username.trim() : "";
    const authMethod =
      obj.authMethod === "password" ||
      obj.authMethod === "privateKey" ||
      obj.authMethod === "agent"
        ? (obj.authMethod as SshConnectParams["authMethod"])
        : "password";

    if (!host || !username) {
      throw new Error("SSH host and username are required");
    }

    return saveSshCredentialWithPlainSecret({
      host,
      port,
      username,
      authMethod,
      privateKeyPath:
        typeof obj.privateKeyPath === "string" ? obj.privateKeyPath : undefined,
      secret: typeof obj.secret === "string" ? obj.secret : undefined,
    });
  });

  ipcMain.handle(
    "ssh:get-credential",
    (_event, host: unknown, port: unknown, username: unknown) => {
      if (typeof host !== "string" || typeof username !== "string") {
        return null;
      }
      const portNum = typeof port === "number" ? port : 22;
      return getSshCredential(host.trim(), portNum, username.trim());
    }
  );

  ipcMain.handle(
    "ssh:get-decrypted-secret",
    (_event, host: unknown, port: unknown, username: unknown) => {
      if (typeof host !== "string" || typeof username !== "string") {
        return null;
      }
      const portNum = typeof port === "number" ? port : 22;
      return getDecryptedSecret(host.trim(), portNum, username.trim());
    }
  );

  ipcMain.handle("ssh:list-credentials", () => listSshCredentials());

  // 读取本地 ~/.ssh/config 中的主机条目，供渲染层快速导入 SSH 连接。
  ipcMain.handle("ssh:list-config-hosts", () => listSshConfigHosts());

  ipcMain.handle(
    "ssh:delete-credential",
    (_event, host: unknown, port: unknown, username: unknown) => {
      if (typeof host !== "string" || typeof username !== "string") {
        return;
      }
      const portNum = typeof port === "number" ? port : 22;
      deleteSshCredential(host.trim(), portNum, username.trim());
    }
  );

  ipcMain.handle(
    "ssh:select-private-key",
    async (event, dialogTitle: unknown) => {
      const browserWindow = BrowserWindow.fromWebContents(event.sender);
      const title =
        typeof dialogTitle === "string" && dialogTitle.trim()
          ? dialogTitle.trim()
          : "Select private key file";
      const homeDir = homedir();
      const options: Electron.OpenDialogOptions = {
        title,
        properties: ["openFile"],
        defaultPath: `${homeDir}/.ssh`,
      };
      const result = browserWindow
        ? await dialog.showOpenDialog(browserWindow, options)
        : await dialog.showOpenDialog(options);
      return result.canceled ? null : result.filePaths[0] ?? null;
    }
  );

  ipcMain.handle("ssh:parse-url", (_event, sshUrl: unknown) => {
    if (typeof sshUrl !== "string" || !sshUrl.trim()) {
      throw new Error("SSH URL is required");
    }
    if (!isSshPath(sshUrl.trim())) {
      throw new Error("Path is not an SSH URL");
    }
    return parseSshUrl(sshUrl.trim());
  });
};
