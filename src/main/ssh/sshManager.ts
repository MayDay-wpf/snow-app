import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path/posix";
import { createRequire } from "node:module";
import { getSshHostKey, saveSshHostKey } from "./sshHostKeys";

const require2 = createRequire(import.meta.url);
const ssh2 = require2("ssh2") as typeof import("ssh2");
const { Client } = ssh2;

export type SshAuthMethod = "password" | "privateKey" | "agent";

export type SshConnectParams = {
  host: string;
  port: number;
  username: string;
  authMethod: SshAuthMethod;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
  /** Replaces a pinned host key only after an explicit renderer confirmation. */
  hostKeyPolicy?: "replace";
};

export type SshOperationSideEffect = "none" | "possible";
export type RemoteProcessTermination = "not_requested" | "unconfirmed";
export type SshCleanupResult = {
  temporaryFile: {
    status: "failed";
    message: string;
  };
};

export class SshOperationError extends Error {
  readonly code: string;
  readonly operation: string;
  readonly sideEffect: SshOperationSideEffect;
  readonly remoteProcessTermination?: RemoteProcessTermination;
  readonly cleanup?: SshCleanupResult;

  constructor(params: {
    code: string;
    operation: string;
    message: string;
    sideEffect?: SshOperationSideEffect;
    remoteProcessTermination?: RemoteProcessTermination;
    cleanup?: SshCleanupResult;
  }) {
    super(`[${params.code}] ${params.message}`);
    this.name = "SshOperationError";
    this.code = params.code;
    this.operation = params.operation;
    this.sideEffect = params.sideEffect ?? "none";
    this.remoteProcessTermination = params.remoteProcessTermination;
    this.cleanup = params.cleanup;
  }
}

export const isSshOperationError = (
  error: unknown
): error is SshOperationError => error instanceof SshOperationError;

export const toSshOperationErrorResult = (
  error: SshOperationError
): Record<string, unknown> => ({
  code: error.code,
  operation: error.operation,
  sideEffect: error.sideEffect,
  remoteProcessTermination: error.remoteProcessTermination,
  cleanup: error.cleanup,
  message: error.message.replace(/^\[[^\]]+\]\s*/, ""),
});

export type SshDirectoryEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
};

export type SshSession = {
  id: string;
  client: import("ssh2").Client;
  sftp: import("ssh2").SFTPWrapper;
  params: SshConnectParams;
  capabilities?: SshCapabilities;
};

export type SshCapabilities = {
  platform: "posix" | "windows";
  remoteOs?: string;
  remoteArch?: string;
  posixShell: boolean;
  systemdUser: boolean;
  tmux: boolean;
  setsid: boolean;
  nohup: boolean;
  powerShell: boolean;
};

export type SshFileSaveGuarantee =
  | "strong_atomic"
  | "atomic_best_effort"
  | "compatibility";

/** A content-addressed remote file version used as the write CAS precondition. */
export type SshFileVersion = {
  exists: boolean;
  sha256?: string;
  size?: number;
  mtime?: number;
};

export type SshFileWriteOptions = {
  signal?: AbortSignal;
  /** Required by user-facing write paths to prevent a stale editor overwrite. */
  expectedVersion: SshFileVersion;
  /** Absolute remote workspace path resolved by Main from a bound workspace ID. */
  workspaceRoot: string;
};

/**
 * Internal writes are limited to Snow-managed remote-job files. They bypass
 * user-file CAS because the job service owns those paths and their lifecycle.
 */
export type SshInternalFileWriteOptions = {
  signal?: AbortSignal;
  expectedVersion?: SshFileVersion;
  workspaceRoot?: string;
  /**
   * Explicit opt-in for Snow-managed files that must retain target inode
   * metadata. This is a compatibility write: it preserves ACLs, xattrs, and
   * security labels, but truncation is not atomic.
   */
  preserveInodeMetadata?: boolean;
};

export type SshFileWriteResult = {
  guarantee: SshFileSaveGuarantee;
  sideEffect: "committed";
  bytes: number;
  version: SshFileVersion;
  durability: {
    fsynced: boolean;
    posixRename: boolean;
  };
};

const sessions = new Map<string, SshSession>();

/**
 * A stable profile handle can be resolved to the current ephemeral SSH
 * session by SshConnectionManager. Keeping this indirection here lets the
 * existing SFTP/exec APIs stay compatible while reconnects replace a client.
 */
type SshSessionHandleResolver = (handle: string) => string | undefined;
let sessionHandleResolver: SshSessionHandleResolver | undefined;

export const setSshSessionHandleResolver = (
  resolver?: SshSessionHandleResolver
): void => {
  sessionHandleResolver = resolver;
};

export const getSshSession = (sessionIdOrHandle: string): SshSession | undefined => {
  const direct = sessions.get(sessionIdOrHandle);
  if (direct) {
    return direct;
  }
  const resolvedSessionId = sessionHandleResolver?.(sessionIdOrHandle);
  return resolvedSessionId ? sessions.get(resolvedSessionId) : undefined;
};

type SshClientFactory = () => import("ssh2").Client;
let sshClientFactory: SshClientFactory = () => new Client();

/** Test-only injection point for deterministic cancellation and disconnect races. */
export const setSshClientFactoryForTesting = (
  factory?: SshClientFactory
): void => {
  sshClientFactory = factory ?? (() => new Client());
};

const generateSessionId = (): string =>
  `ssh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

type ObservedSshHostKey = {
  fingerprint: string;
  keyType: string;
  publicKey: string;
};

const parseSshHostKeyType = (key: Buffer): string | null => {
  if (key.length < 5) {
    return null;
  }
  const keyTypeLength = key.readUInt32BE(0);
  const end = 4 + keyTypeLength;
  if (keyTypeLength === 0 || end > key.length) {
    return null;
  }
  const keyType = key.subarray(4, end).toString("ascii");
  return /^[A-Za-z0-9@._+-]+$/.test(keyType) ? keyType : null;
};

export const getSshProfileKey = (params: {
  host: string;
  port: number;
  username: string;
}): string => `${params.username}@${params.host}:${params.port}`;

export const connectSsh = (
  params: SshConnectParams,
  options?: { signal?: AbortSignal }
): Promise<string> => {
  return new Promise((resolve, reject) => {
    let settled = false;
    let observedHostKey: ObservedSshHostKey | null = null;
    let hostKeyMismatch: { expected: string; received: string } | null = null;
    const client = sshClientFactory();
    const signal = options?.signal;

    const connectConfig: import("ssh2").ConnectConfig = {
      host: params.host,
      port: params.port,
      username: params.username,
      readyTimeout: 15000,
      keepaliveInterval: 10_000,
      keepaliveCountMax: 3,
      agentForward: false,
      hostVerifier: (value: string | Buffer): boolean => {
        const key = Buffer.isBuffer(value) ? value : Buffer.from(value);
        const fingerprint = createHash("sha256").update(key).digest("hex");
        const keyType = parseSshHostKeyType(key);
        if (!keyType) {
          rejectConnection(
            new SshOperationError({
              code: "SSH_HOST_KEY_UNAVAILABLE",
              operation: "connect",
              message: "SSH server provided an invalid host key",
            })
          );
          return false;
        }
        const publicKey = key.toString("base64");
        const trusted = getSshHostKey(params.host, params.port);
        if (
          trusted &&
          (trusted.fingerprint !== fingerprint ||
            (trusted.publicKey && trusted.publicKey !== publicKey)) &&
          params.hostKeyPolicy !== "replace"
        ) {
          hostKeyMismatch = {
            expected: trusted.fingerprint,
            received: fingerprint,
          };
          rejectHostKeyMismatch();
          return false;
        }
        observedHostKey = { fingerprint, keyType, publicKey };
        return true;
      },
    };

    if (params.authMethod === "password" && params.password) {
      connectConfig.password = params.password;
    } else if (params.authMethod === "privateKey" && params.privateKeyPath) {
      try {
        connectConfig.privateKey = readFileSync(params.privateKeyPath, "utf-8");
      } catch {
        reject(
          new Error(`Failed to read private key file: ${params.privateKeyPath}`)
        );
        return;
      }
      if (params.passphrase) {
        connectConfig.passphrase = params.passphrase;
      }
    } else if (params.authMethod === "agent") {
      const agentSocket = process.env.SSH_AUTH_SOCK;
      if (!agentSocket) {
        reject(
          new SshOperationError({
            code: "SSH_AGENT_UNAVAILABLE",
            operation: "connect",
            message: "SSH agent authentication requires SSH_AUTH_SOCK",
          })
        );
        return;
      }
      connectConfig.agent = agentSocket;
    } else {
      reject(new Error("Invalid authentication method or missing credentials"));
      return;
    }

    const clearAbortListener = (): void => {
      signal?.removeEventListener("abort", onAbort);
    };

    const rejectConnection = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearAbortListener();
      try {
        client.end();
      } catch {
        // The transport may already be closed.
      }
      reject(error);
    };

    const rejectHostKeyMismatch = (): void => {
      if (!hostKeyMismatch) {
        return;
      }
      // ssh2 may only emit a transport close after a verifier rejection.
      // Reject here so that a known key mismatch cannot be masked as a
      // transient connection loss.
      rejectConnection(
        new SshOperationError({
          code: "SSH_HOST_KEY_CHANGED",
          operation: "connect",
          message: `Host key changed for ${params.host}:${params.port}. Expected ${hostKeyMismatch.expected}, received ${hostKeyMismatch.received}. Confirm the new fingerprint before reconnecting.`,
        })
      );
    };

    const onAbort = (): void => {
      rejectConnection(
        new SshOperationError({
          code: "SSH_OPERATION_CANCELLED",
          operation: "connect",
          message: "SSH connection cancelled",
        })
      );
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    client.on("ready", () => {
      client.sftp(
        (err: Error | undefined, sftp: import("ssh2").SFTPWrapper) => {
          if (err) {
            rejectConnection(
              new Error(`SFTP initialization failed: ${err.message}`)
            );
            return;
          }

          if (settled) {
            try {
              sftp.end();
              client.end();
            } catch {
              // The transport may already be closed.
            }
            return;
          }

          if (!observedHostKey) {
            rejectConnection(
              new SshOperationError({
                code: "SSH_HOST_KEY_UNAVAILABLE",
                operation: "connect",
                message: "SSH server did not provide a host key fingerprint",
              })
            );
            return;
          }

          try {
            saveSshHostKey({
              host: params.host,
              port: params.port,
              fingerprint: observedHostKey.fingerprint,
              keyType: observedHostKey.keyType,
              publicKey: observedHostKey.publicKey,
            });
          } catch (error) {
            rejectConnection(
              new Error(
                `Failed to persist SSH host key: ${
                  error instanceof Error ? error.message : String(error)
                }`
              )
            );
            return;
          }

          const id = generateSessionId();
          const session: SshSession = { id, client, sftp, params };
          sessions.set(id, session);
          settled = true;
          clearAbortListener();
          resolve(id);
        }
      );
    });

    client.on("error", (err: Error) => {
      if (!settled) {
        if (hostKeyMismatch) {
          rejectConnection(
            new SshOperationError({
              code: "SSH_HOST_KEY_CHANGED",
              operation: "connect",
              message: `Host key changed for ${params.host}:${params.port}. Expected ${hostKeyMismatch.expected}, received ${hostKeyMismatch.received}. Confirm the new fingerprint before reconnecting.`,
            })
          );
          return;
        }
        rejectConnection(new Error(err.message));
      }
    });

    client.on("close", () => {
      for (const [id, session] of sessions) {
        if (session.client === client) {
          sessions.delete(id);
          break;
        }
      }
      if (!settled) {
        rejectConnection(
          new Error("SSH connection closed before establishing session")
        );
      }
    });

    try {
      client.connect(connectConfig);
    } catch (err) {
      rejectConnection(
        new Error(err instanceof Error ? err.message : String(err))
      );
    }
  });
};

export const listSshDirectory = (
  sessionId: string,
  remotePath: string,
  options?: { signal?: AbortSignal }
): Promise<SshDirectoryEntry[]> => {
  return new Promise((resolve, reject) => {
    const session = getSshSession(sessionId);
    if (!session) {
      reject(new Error("SSH session not found. Please reconnect."));
      return;
    }

    const signal = options?.signal;
    let settled = false;
    const cleanup = (): void => {
      signal?.removeEventListener("abort", onAbort);
    };
    const settleAndReject = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = (): void => {
      settleAndReject(
        new SshOperationError({
          code: "SSH_OPERATION_CANCELLED",
          operation: "sftp_list",
          message: "Remote directory read cancelled",
        })
      );
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    session.sftp.readdir(remotePath, (err, list) => {
      if (settled) {
        return;
      }
      if (err) {
        settleAndReject(new Error(`Failed to read remote directory: ${err.message}`));
        return;
      }

      const entries: SshDirectoryEntry[] = list.map((item) => {
        const isDirectory = item.attrs.isDirectory();
        const name = item.filename;
        const fullPath =
          remotePath === "/" ? `/${name}` : `${remotePath}/${name}`;
        return {
          name,
          path: fullPath,
          isDirectory,
          size: isDirectory ? 0 : item.attrs.size,
        };
      });

      entries.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) {
          return a.isDirectory ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });

      settled = true;
      cleanup();
      resolve(entries);
    });
  });
};

export type SshCommandOptions = {
  /** Upper bound for the command lifetime; the exec channel is closed and the
   *  remote process signalled on timeout. Defaults to 5 minutes as an absolute
   *  safety net so an SSH exec can never hang forever. */
  timeoutMs?: number;
  /** External cancellation (e.g. conversation stop); aborts the same way as a
   *  timeout. */
  signal?: AbortSignal;
};

export const executeSshCommand = (
  sessionId: string,
  command: string,
  options?: SshCommandOptions
): Promise<string> => {
  return new Promise((resolve, reject) => {
    const session = getSshSession(sessionId);
    if (!session) {
      reject(new Error("SSH session not found. Please reconnect."));
      return;
    }

    const { timeoutMs = 300_000, signal } = options ?? {};
    let settled = false;
    let streamRef: import("ssh2").ClientChannel | undefined;
    let timer: NodeJS.Timeout | undefined;

    // Single-settlement state machine: exactly one of exec callback failure,
    // stream error, stream close, client error, client close, timeout or
    // cancellation resolves the Promise. Any later event is ignored.
    const cleanup = (): void => {
      if (timer) {
        clearTimeout(timer);
      }
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
      session.client.removeListener("error", onClientError);
      session.client.removeListener("close", onClientClose);
    };

    const terminate = (stream = streamRef): void => {
      // Best-effort: signal the remote process group and close the exec
      // channel so the pending wait settles instead of hanging forever.
      try {
        stream?.signal("KILL");
      } catch {
        // Channel may already be gone.
      }
      try {
        stream?.close();
      } catch {
        // Channel may already be gone.
      }
    };

    const settleAndReject = (error: Error, terminateRemote = true): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (terminateRemote) {
        terminate();
      }
      reject(error);
    };

    const onAbort = (): void => {
      settleAndReject(
        new SshOperationError({
          code: "SSH_COMMAND_CANCELLED",
          operation: "exec",
          message: "Remote command cancelled; remote process termination is unconfirmed",
          sideEffect: "possible",
          remoteProcessTermination: "unconfirmed",
        })
      );
    };
    const onClientError = (err: Error): void => {
      settleAndReject(
        new SshOperationError({
          code: "SSH_CONNECTION_ERROR",
          operation: "exec",
          message: `SSH connection error: ${err.message}`,
          sideEffect: "possible",
          remoteProcessTermination: "unconfirmed",
        }),
        false
      );
    };
    const onClientClose = (): void => {
      settleAndReject(
        new SshOperationError({
          code: "SSH_CONNECTION_CLOSED",
          operation: "exec",
          message: "SSH connection closed before command completed",
          sideEffect: "possible",
          remoteProcessTermination: "unconfirmed",
        }),
        false
      );
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }
    session.client.on("error", onClientError);
    session.client.on("close", onClientClose);
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      settleAndReject(
        new SshOperationError({
          code: "SSH_COMMAND_TIMED_OUT",
          operation: "exec",
          message: `Remote command timed out after ${timeoutMs}ms; remote process termination is unconfirmed`,
          sideEffect: "possible",
          remoteProcessTermination: "unconfirmed",
        })
      );
    }, timeoutMs);

    session.client.exec(command, (err, stream) => {
      if (err) {
        settleAndReject(
          new Error(`Failed to execute remote command: ${err.message}`)
        );
        return;
      }
      streamRef = stream;

      // The cancellation/timeout may occur while ssh2 is waiting for the
      // exec callback. A channel that arrives after settlement must be closed
      // immediately so the remote command cannot continue in the background.
      if (settled) {
        terminate(stream);
        return;
      }

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => {
        if (!settled) {
          stdout.push(chunk);
        }
      });
      stream.stderr.on("data", (chunk: Buffer) => {
        if (!settled) {
          stderr.push(chunk);
        }
      });
      stream.on("close", (exitCode: number | null) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        const errorOutput = Buffer.concat(stderr).toString("utf-8").trim();
        if (exitCode !== 0) {
          reject(
            new Error(
              errorOutput || `Remote command failed with exit code ${exitCode}`
            )
          );
          return;
        }
        resolve(Buffer.concat(stdout).toString("utf-8"));
      });
      stream.on("error", (streamError: Error) => {
        settleAndReject(
          new Error(`Failed to execute remote command: ${streamError.message}`)
        );
      });
    });
  });
};

/** Confirms that this SSH server permits PTY allocation before an interactive job starts. */
export const probeSshPty = (sessionId: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const session = getSshSession(sessionId);
    if (!session) {
      reject(new Error("SSH session not found. Please reconnect."));
      return;
    }
    session.client.exec("true", { pty: true }, (error, stream) => {
      if (error) {
        reject(new Error(`SSH PTY allocation failed: ${error.message}`));
        return;
      }
      stream.on("error", (streamError: Error) => {
        reject(new Error(`SSH PTY allocation failed: ${streamError.message}`));
      });
      stream.on("close", (exitCode: number | null) => {
        if (exitCode === 0) {
          resolve();
        } else {
          reject(
            new Error(
              `SSH PTY allocation was rejected with exit code ${exitCode ?? "unknown"}`
            )
          );
        }
      });
    });
  });

const POSIX_CAPABILITY_PROBE_COMMAND = [
  "for capability in sh systemctl tmux setsid nohup; do",
  '  if command -v "$capability" >/dev/null 2>&1; then',
  '    printf "%s=1\\n" "$capability"',
  "  else",
  '    printf "%s=0\\n" "$capability"',
  "  fi",
  "done",
  'runtime_dir="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"',
  'if XDG_RUNTIME_DIR="$runtime_dir" DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$runtime_dir/bus}" systemctl --user show-environment >/dev/null 2>&1; then printf "systemd_user=1\\n"; else printf "systemd_user=0\\n"; fi',
  'printf "os=%s\\narch=%s\\n" "$(uname -s 2>/dev/null || printf unknown)" "$(uname -m 2>/dev/null || printf unknown)"',
].join("\n");

const WINDOWS_CAPABILITY_PROBE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "[Console]::Out.WriteLine('platform=windows')",
  "[Console]::Out.WriteLine('powershell=1')",
].join("\r\n");

const WINDOWS_CAPABILITY_PROBE_COMMAND =
  "powershell.exe -NoProfile -NonInteractive -EncodedCommand " +
  Buffer.from(WINDOWS_CAPABILITY_PROBE_SCRIPT, "utf16le").toString("base64");

export const probeSshCapabilities = async (
  sessionId: string,
  options?: { signal?: AbortSignal }
): Promise<SshCapabilities> => {
  let platform: SshCapabilities["platform"] = "posix";
  let output: string;
  try {
    output = await executeSshCommand(sessionId, POSIX_CAPABILITY_PROBE_COMMAND, {
      timeoutMs: 5_000,
      signal: options?.signal,
    });
  } catch (posixError) {
    try {
      output = await executeSshCommand(sessionId, WINDOWS_CAPABILITY_PROBE_COMMAND, {
        timeoutMs: 10_000,
        signal: options?.signal,
      });
      platform = "windows";
    } catch {
      throw posixError;
    }
  }
  const values = new Map(
    output
      .trim()
      .split("\n")
      .flatMap((line) => {
        const [rawKey, rawValue] = line.split("=", 2);
        const key = rawKey?.trim();
        const value = rawValue?.trim();
        return key && value ? [[key, value] as const] : [];
      })
  );
  const capabilities: SshCapabilities = {
    platform,
    remoteOs: values.get("os")?.toLowerCase(),
    remoteArch: values.get("arch")?.toLowerCase(),
    posixShell: values.get("sh") === "1",
    systemdUser: values.get("systemd_user") === "1",
    tmux: values.get("tmux") === "1",
    setsid: values.get("setsid") === "1",
    nohup: values.get("nohup") === "1",
    powerShell: values.get("powershell") === "1",
  };
  const session = getSshSession(sessionId);
  if (session) {
    session.capabilities = capabilities;
  }
  return capabilities;
};

export const readSshFile = (
  sessionId: string,
  remotePath: string,
  options?: { signal?: AbortSignal }
): Promise<Buffer> => {
  return readSshFileRange(sessionId, remotePath, { signal: options?.signal });
};

/** Reads a bounded byte range directly through SFTP on POSIX and Windows OpenSSH. */
export const readSshFileRange = (
  sessionId: string,
  remotePath: string,
  options?: { offset?: number; length?: number; signal?: AbortSignal }
): Promise<Buffer> => {
  return new Promise((resolve, reject) => {
    const session = getSshSession(sessionId);
    if (!session) {
      reject(new Error("SSH session not found. Please reconnect."));
      return;
    }

    const chunks: Buffer[] = [];
    const signal = options?.signal;
    let settled = false;
    let stream:
      | ReturnType<import("ssh2").SFTPWrapper["createReadStream"]>
      | undefined;
    const cleanup = (): void => {
      signal?.removeEventListener("abort", onAbort);
    };
    const settleAndReject = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = (): void => {
      settleAndReject(
        new SshOperationError({
          code: "SSH_OPERATION_CANCELLED",
          operation: "sftp_read",
          message: "Remote file read cancelled",
        })
      );
      try {
        stream?.destroy();
      } catch {
        // Stream construction or teardown may already have failed.
      }
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }

    try {
      const offset = Math.max(0, Math.floor(options?.offset ?? 0));
      const length = options?.length;
      stream = session.sftp.createReadStream(
        remotePath,
        length === undefined
          ? { start: offset }
          : {
              start: offset,
              end: offset + Math.max(1, Math.floor(length)) - 1,
            }
      );
    } catch (error) {
      settleAndReject(
        new Error(
          `Failed to read remote file: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      );
      return;
    }
    const activeStream = stream;
    signal?.addEventListener("abort", onAbort, { once: true });

    activeStream.on("data", (chunk: Buffer) => {
      if (!settled) {
        chunks.push(chunk);
      }
    });

    activeStream.on("end", () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks));
    });

    activeStream.on("error", (err: Error) => {
      settleAndReject(new Error(`Failed to read remote file: ${err.message}`));
    });

    activeStream.read();
  });
};

const SFTP_WRITE_CHUNK_SIZE = 64 * 1024;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isSftpNotFound = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === 2 || code === "ENOENT" || code === "NO_SUCH_FILE";
};

const isUnsupportedOpenSshExtension = (error: unknown): boolean => {
  if (/does not support|not supported|unsupported/i.test(errorMessage(error))) {
    return true;
  }
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === 8
  );
};

type SftpAbortOptions = {
  signal?: AbortSignal;
  operation: string;
  message: string;
  sideEffect?: SshOperationSideEffect;
};

const atomicWriteAbortOptions = (
  signal: AbortSignal | undefined,
  sideEffect: SshOperationSideEffect = "none"
): SftpAbortOptions => ({
  signal,
  operation: "sftp_atomic_write",
  message: "Remote file save cancelled while waiting for SFTP",
  sideEffect,
});

const abortSftpChannel = (sftp: import("ssh2").SFTPWrapper): void => {
  try {
    // SFTP callbacks have no cancellation API. Ending this channel makes the
    // pending request settle and prevents a late callback from reviving it.
    sftp.end();
  } catch {
    // The channel may already be closed by the transport.
  }
};

const withSftpAbort = <T>(
  sftp: import("ssh2").SFTPWrapper,
  options: SftpAbortOptions | undefined,
  run: (
    resolvePromise: (value: T) => void,
    rejectPromise: (reason?: unknown) => void
  ) => void
): Promise<T> =>
  new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const signal = options?.signal;
    const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
    const resolveOnce = (value: T): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(value);
    };
    const rejectOnce = (reason?: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(reason);
    };
    const onAbort = (): void => {
      abortSftpChannel(sftp);
      rejectOnce(
        new SshOperationError({
          code: "SSH_OPERATION_CANCELLED",
          operation: options?.operation ?? "sftp",
          message: options?.message ?? "SFTP operation cancelled",
          sideEffect: options?.sideEffect,
        })
      );
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      run(resolveOnce, rejectOnce);
    } catch (error) {
      rejectOnce(error);
    }
  });

const sftpVoid = (
  sftp: import("ssh2").SFTPWrapper,
  run: (callback: (error?: Error | null) => void) => void,
  options?: SftpAbortOptions
): Promise<void> =>
  withSftpAbort(sftp, options, (resolvePromise, rejectPromise) => {
    run((error?: Error | null) => {
      if (error) {
        rejectPromise(error);
        return;
      }
      resolvePromise();
    });
  });

const sftpOpen = (
  sftp: import("ssh2").SFTPWrapper,
  path: string,
  mode: string,
  attributes?: { mode: number },
  options?: SftpAbortOptions
): Promise<Buffer> =>
  withSftpAbort(sftp, options, (resolvePromise, rejectPromise) => {
    const callback = (error: Error | undefined, handle: Buffer): void => {
      if (error) {
        rejectPromise(error);
        return;
      }
      resolvePromise(handle);
    };
    try {
      if (attributes) {
        sftp.open(path, mode as never, attributes, callback);
      } else {
        sftp.open(path, mode as never, callback);
      }
    } catch (error) {
      rejectPromise(error);
    }
  });

const sftpLstat = async (
  sftp: import("ssh2").SFTPWrapper,
  path: string,
  options?: SftpAbortOptions
): Promise<import("ssh2").Stats | null> =>
  withSftpAbort(sftp, options, (resolvePromise, rejectPromise) => {
    try {
      sftp.lstat(path, (error, stats) => {
        if (error) {
          if (isSftpNotFound(error)) {
            resolvePromise(null);
            return;
          }
          rejectPromise(error);
          return;
        }
        resolvePromise(stats);
      });
    } catch (error) {
      rejectPromise(error);
    }
  });

const sftpRealpath = (
  sftp: import("ssh2").SFTPWrapper,
  path: string,
  options?: SftpAbortOptions
): Promise<string> =>
  withSftpAbort(sftp, options, (resolvePromise, rejectPromise) => {
    try {
      sftp.realpath(path, (error, resolvedPath) => {
        if (error) {
          rejectPromise(error);
          return;
        }
        resolvePromise(resolvedPath);
      });
    } catch (error) {
      rejectPromise(error);
    }
  });

const sha256 = (content: Buffer): string =>
  createHash("sha256").update(content).digest("hex");

const toFileVersion = (
  stats: import("ssh2").Stats,
  content: Buffer
): SshFileVersion => ({
  exists: true,
  sha256: sha256(content),
  size: stats.size,
  mtime: stats.mtime,
});

const sameMetadata = (
  first: import("ssh2").Stats,
  second: import("ssh2").Stats
): boolean =>
  first.size === second.size &&
  first.mtime === second.mtime &&
  first.mode === second.mode;

const sameFileVersion = (
  expected: SshFileVersion,
  actual: SshFileVersion
): boolean => {
  if (expected.exists !== actual.exists) {
    return false;
  }
  if (!expected.exists) {
    return true;
  }
  return (
    typeof expected.sha256 === "string" &&
    expected.sha256 === actual.sha256 &&
    expected.size === actual.size &&
    expected.mtime === actual.mtime
  );
};

const fileTypeError = (
  path: string,
  stats: import("ssh2").Stats
): SshOperationError => {
  if (stats.isSymbolicLink()) {
    return new SshOperationError({
      code: "SSH_FILE_SYMLINK_NOT_ALLOWED",
      operation: "sftp_atomic_write",
      message: `Refusing to replace symbolic link outside the verified workspace: ${path}`,
    });
  }
  return new SshOperationError({
    code: "SSH_FILE_TYPE_UNSUPPORTED",
    operation: "sftp_atomic_write",
    message: `Atomic replacement supports regular files only: ${path}`,
  });
};

const assertRegularFile = (
  path: string,
  stats: import("ssh2").Stats
): void => {
  if (!stats.isFile()) {
    throw fileTypeError(path, stats);
  }
};

const isWindowsRemotePath = (path: string): boolean =>
  /^\/?[A-Za-z]:\//.test(path.replace(/\\/g, "/"));

const normalizedRemotePath = (path: string): string => {
  const slashNormalized = path.replace(/\\/g, "/");
  if (isWindowsRemotePath(slashNormalized)) {
    const withoutLeadingSlash = slashNormalized.replace(/^\//, "");
    return withoutLeadingSlash.replace(/\/{2,}/g, "/").replace(/\/$/, "");
  }
  if (!slashNormalized.startsWith("/")) {
    throw new SshOperationError({
      code: "SSH_FILE_INVALID_PATH",
      operation: "sftp_atomic_write",
      message: "Remote file paths must be absolute POSIX paths",
    });
  }
  return resolve(slashNormalized);
};

const isWithinRemoteRoot = (path: string, root: string): boolean => {
  const left = normalizedRemotePath(path);
  const right = normalizedRemotePath(root);
  if (isWindowsRemotePath(left) || isWindowsRemotePath(right)) {
    const normalizedLeft = left.toLowerCase();
    const normalizedRight = right.toLowerCase();
    return (
      normalizedLeft === normalizedRight ||
      normalizedLeft.startsWith(`${normalizedRight}/`)
    );
  }
  return right === "/"
    ? left.startsWith("/")
    : left === right || left.startsWith(`${right}/`);
};

const assertWorkspaceBoundary = async (
  sftp: import("ssh2").SFTPWrapper,
  remotePath: string,
  workspaceRoot: string | undefined,
  signal?: AbortSignal
): Promise<void> => {
  if (!workspaceRoot) {
    return;
  }

  const normalizedPath = normalizedRemotePath(remotePath);
  const normalizedRoot = normalizedRemotePath(workspaceRoot);
  if (!isWithinRemoteRoot(normalizedPath, normalizedRoot)) {
    throw new SshOperationError({
      code: "SSH_FILE_OUTSIDE_WORKSPACE",
      operation: "sftp_atomic_write",
      message: "Remote file path is outside the authorized workspace",
    });
  }

  const [resolvedRoot, resolvedParent] = await Promise.all([
    sftpRealpath(sftp, normalizedRoot, atomicWriteAbortOptions(signal)),
    sftpRealpath(
      sftp,
      dirname(normalizedPath),
      atomicWriteAbortOptions(signal)
    ),
  ]);
  if (!isWithinRemoteRoot(resolvedParent, resolvedRoot)) {
    throw new SshOperationError({
      code: "SSH_FILE_OUTSIDE_WORKSPACE",
      operation: "sftp_atomic_write",
      message: "Remote file parent resolves outside the authorized workspace",
    });
  }
};

const assertNotAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) {
    throw new SshOperationError({
      code: "SSH_OPERATION_CANCELLED",
      operation: "sftp_atomic_write",
      message: "Remote atomic file save cancelled before replacement",
      sideEffect: "none",
    });
  }
};

const closeHandle = async (
  sftp: import("ssh2").SFTPWrapper,
  handle: Buffer | undefined,
  signal?: AbortSignal,
  sideEffect: SshOperationSideEffect = "none"
): Promise<void> => {
  if (!handle) {
    return;
  }
  await sftpVoid(
    sftp,
    (callback) => sftp.close(handle, callback),
    atomicWriteAbortOptions(signal, sideEffect)
  );
};

const cleanupTemporaryFile = async (
  sftp: import("ssh2").SFTPWrapper,
  temporaryPath: string,
  signal?: AbortSignal
): Promise<string | null> => {
  try {
    await sftpVoid(
      sftp,
      (callback) => sftp.unlink(temporaryPath, callback),
      atomicWriteAbortOptions(signal)
    );
    return null;
  } catch (error) {
    return isSftpNotFound(error) ? null : errorMessage(error);
  }
};

const writeHandle = async (
  sftp: import("ssh2").SFTPWrapper,
  handle: Buffer,
  data: Buffer,
  signal: AbortSignal | undefined
): Promise<void> => {
  for (let offset = 0; offset < data.length; offset += SFTP_WRITE_CHUNK_SIZE) {
    assertNotAborted(signal);
    const length = Math.min(SFTP_WRITE_CHUNK_SIZE, data.length - offset);
    await sftpVoid(
      sftp,
      (callback) => sftp.write(handle, data, offset, length, offset, callback),
      atomicWriteAbortOptions(signal)
    );
  }
  assertNotAborted(signal);
};

const tryFsync = async (
  sftp: import("ssh2").SFTPWrapper,
  handle: Buffer,
  signal?: AbortSignal,
  sideEffect: SshOperationSideEffect = "none"
): Promise<boolean> => {
  try {
    await sftpVoid(
      sftp,
      (callback) => sftp.ext_openssh_fsync(handle, callback),
      atomicWriteAbortOptions(signal, sideEffect)
    );
    return true;
  } catch (error) {
    if (isUnsupportedOpenSshExtension(error)) {
      return false;
    }
    throw error;
  }
};

const tryPosixRename = async (
  sftp: import("ssh2").SFTPWrapper,
  temporaryPath: string,
  remotePath: string,
  signal?: AbortSignal
): Promise<boolean> => {
  try {
    await sftpVoid(
      sftp,
      (callback) => sftp.ext_openssh_rename(temporaryPath, remotePath, callback),
      atomicWriteAbortOptions(signal, "possible")
    );
    return true;
  } catch (error) {
    if (!isUnsupportedOpenSshExtension(error)) {
      throw error;
    }
  }
  return false;
};

const writeCompatibilityFile = async (
  sftp: import("ssh2").SFTPWrapper,
  remotePath: string,
  data: Buffer,
  targetExists: boolean,
  signal: AbortSignal | undefined
): Promise<boolean> => {
  let handle: Buffer | undefined;
  try {
    // Opening an existing file in place preserves its inode-bound ACLs,
    // xattrs, and security labels. This is intentionally visible as a
    // compatibility write because truncation is not atomic.
    handle = await sftpOpen(
      sftp,
      remotePath,
      "w",
      targetExists ? undefined : { mode: 0o600 },
      atomicWriteAbortOptions(signal, "possible")
    );
    await writeHandle(sftp, handle, data, signal);
    const fsynced = await tryFsync(sftp, handle, signal, "possible");
    await closeHandle(sftp, handle, signal, "possible");
    handle = undefined;
    return fsynced;
  } finally {
    if (handle) {
      await closeHandle(sftp, handle, signal, "possible").catch(() => undefined);
    }
  }
};

const copyBasicPosixMode = async (
  sftp: import("ssh2").SFTPWrapper,
  handle: Buffer,
  targetStats: import("ssh2").Stats | null,
  signal?: AbortSignal
): Promise<void> => {
  if (!targetStats) {
    return;
  }

  // An atomic replacement always creates a new inode. SFTP can copy the
  // basic rwx mode, but has no portable ACL/xattr transfer operation. The
  // temporary file receives directory-default metadata; target-specific ACLs,
  // xattrs, labels, and special mode bits require an explicit compatibility
  // write that preserves the target inode.
  await sftpVoid(
    sftp,
    (callback) => sftp.fchmod(handle, targetStats.mode & 0o777, callback),
    atomicWriteAbortOptions(signal)
  );
};

const createTemporaryPath = (remotePath: string): string => {
  const parent = dirname(remotePath);
  const name = basename(remotePath);
  const prefix = parent === "/" ? "" : parent;
  return `${prefix}/.${name}.snow-${randomBytes(12).toString("hex")}.tmp`;
};

export const readSshFileWithVersion = async (
  sessionId: string,
  remotePath: string,
  options?: { signal?: AbortSignal }
): Promise<{ content: Buffer; version: SshFileVersion }> => {
  const session = getSshSession(sessionId);
  if (!session) {
    throw new Error("SSH session not found. Please reconnect.");
  }

  const before = await sftpLstat(
    session.sftp,
    remotePath,
    atomicWriteAbortOptions(options?.signal)
  );
  if (!before) {
    throw new SshOperationError({
      code: "SSH_FILE_NOT_FOUND",
      operation: "sftp_read",
      message: "Remote file does not exist",
    });
  }
  assertRegularFile(remotePath, before);
  const content = await readSshFile(sessionId, remotePath, options);
  const after = await sftpLstat(
    session.sftp,
    remotePath,
    atomicWriteAbortOptions(options?.signal)
  );
  if (!after || !sameMetadata(before, after)) {
    throw new SshOperationError({
      code: "SSH_FILE_CHANGED_DURING_READ",
      operation: "sftp_read",
      message: "Remote file changed while it was being read; reload before editing",
    });
  }
  assertRegularFile(remotePath, after);
  return { content, version: toFileVersion(after, content) };
};

const completeCompatibilityWrite = async (
  sessionId: string,
  sftp: import("ssh2").SFTPWrapper,
  remotePath: string,
  data: Buffer,
  targetExists: boolean,
  signal: AbortSignal | undefined
): Promise<SshFileWriteResult> => {
  const fsynced = await writeCompatibilityFile(
    sftp,
    remotePath,
    data,
    targetExists,
    signal
  );
  const version = (await readSshFileWithVersion(sessionId, remotePath, { signal }))
    .version;
  if (
    !version.exists ||
    version.size !== data.length ||
    version.sha256 !== sha256(data)
  ) {
    throw new SshOperationError({
      code: "SSH_FILE_VERIFY_FAILED",
      operation: "sftp_compatibility_write",
      message: "Remote compatibility save completed but content verification failed",
      sideEffect: "possible",
    });
  }
  return {
    guarantee: "compatibility",
    sideEffect: "committed",
    bytes: data.length,
    version,
    durability: { fsynced, posixRename: false },
  };
};

const writeSshFileWithOptions = async (
  sessionId: string,
  remotePath: string,
  content: string | Buffer,
  options?: SshInternalFileWriteOptions
): Promise<SshFileWriteResult> => {
  const session = getSshSession(sessionId);
  if (!session) {
    throw new Error("SSH session not found. Please reconnect.");
  }

  const normalizedPath = normalizedRemotePath(remotePath);
  const signal = options?.signal;
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf-8");
  const temporaryPath = createTemporaryPath(normalizedPath);
  let handle: Buffer | undefined;
  let temporaryCreated = false;
  let renameAttempted = false;
  let renamed = false;
  let compatibilityWriteStarted = false;

  try {
    assertNotAborted(signal);
    await assertWorkspaceBoundary(
      session.sftp,
      normalizedPath,
      options?.workspaceRoot,
      signal
    );

    const initialStats = await sftpLstat(
      session.sftp,
      normalizedPath,
      atomicWriteAbortOptions(signal)
    );
    if (initialStats) {
      assertRegularFile(normalizedPath, initialStats);
    }

    if (options?.expectedVersion) {
      const actualVersion = initialStats
        ? (await readSshFileWithVersion(sessionId, normalizedPath, { signal })).version
        : { exists: false };
      if (!sameFileVersion(options.expectedVersion, actualVersion)) {
        throw new SshOperationError({
          code: "SSH_FILE_CONFLICT",
          operation: "sftp_atomic_write",
          message: "Remote file changed since it was loaded; reload and resolve the conflict",
        });
      }
    }

    if (initialStats && options?.preserveInodeMetadata) {
      compatibilityWriteStarted = true;
      return await completeCompatibilityWrite(
        sessionId,
        session.sftp,
        normalizedPath,
        data,
        true,
        signal
      );
    }

    const mode = 0o600;
    handle = await sftpOpen(
      session.sftp,
      temporaryPath,
      "wx",
      { mode },
      atomicWriteAbortOptions(signal)
    );
    temporaryCreated = true;
    await writeHandle(session.sftp, handle, data, signal);

    assertNotAborted(signal);
    await assertWorkspaceBoundary(
      session.sftp,
      normalizedPath,
      options?.workspaceRoot,
      signal
    );
    const currentStats = await sftpLstat(
      session.sftp,
      normalizedPath,
      atomicWriteAbortOptions(signal)
    );
    if (currentStats) {
      assertRegularFile(normalizedPath, currentStats);
    }
    if (options?.expectedVersion) {
      const currentVersion = currentStats
        ? (await readSshFileWithVersion(sessionId, normalizedPath, { signal })).version
        : { exists: false };
      if (!sameFileVersion(options.expectedVersion, currentVersion)) {
        throw new SshOperationError({
          code: "SSH_FILE_CONFLICT",
          operation: "sftp_atomic_write",
          message: "Remote file changed before replacement; reload and resolve the conflict",
        });
      }
    }

    await copyBasicPosixMode(session.sftp, handle, currentStats, signal);
    const fsynced = await tryFsync(session.sftp, handle, signal);
    await closeHandle(session.sftp, handle, signal);
    handle = undefined;

    renameAttempted = true;
    const usedPosixRename = await tryPosixRename(
      session.sftp,
      temporaryPath,
      normalizedPath,
      signal
    );
    if (!usedPosixRename) {
      const cleanupFailure = await cleanupTemporaryFile(
        session.sftp,
        temporaryPath,
        signal
      );
      if (cleanupFailure) {
        throw new SshOperationError({
          code: "SSH_FILE_TEMPORARY_CLEANUP_FAILED",
          operation: "sftp_atomic_write",
          message: `Cannot safely fall back to compatibility save; temporary cleanup failed: ${cleanupFailure}`,
        });
      }
      temporaryCreated = false;
      assertNotAborted(signal);
      compatibilityWriteStarted = true;
      return await completeCompatibilityWrite(
        sessionId,
        session.sftp,
        normalizedPath,
        data,
        false,
        signal
      );
    }
    renamed = true;
    const version = (
      await readSshFileWithVersion(sessionId, normalizedPath, { signal })
    ).version;
    if (
      !version.exists ||
      version.size !== data.length ||
      version.sha256 !== sha256(data)
    ) {
      throw new SshOperationError({
        code: "SSH_FILE_VERIFY_FAILED",
        operation: "sftp_atomic_write",
        message: "Remote file replacement completed but content verification failed",
        sideEffect: "possible",
      });
    }

    return {
      // Without a server-side CAS lock, another writer can still race between
      // the final hash check and rename. Do not overstate this as strong atomic.
      guarantee: "atomic_best_effort",
      sideEffect: "committed",
      bytes: data.length,
      version,
      durability: { fsynced, posixRename: usedPosixRename },
    };
  } catch (error) {
    let cleanupFailure: string | null = null;
    if (!renamed) {
      try {
        await closeHandle(session.sftp, handle, signal, "possible");
      } catch (closeError) {
        cleanupFailure = `close failed: ${errorMessage(closeError)}`;
      }
      if (temporaryCreated) {
        const unlinkFailure = await cleanupTemporaryFile(
          session.sftp,
          temporaryPath,
          signal
        );
        cleanupFailure = cleanupFailure ?? unlinkFailure;
      }
    }

    if (error instanceof SshOperationError) {
      const sideEffect =
        (renameAttempted || compatibilityWriteStarted) && error.sideEffect === "none"
          ? "possible"
          : error.sideEffect;
      if (cleanupFailure || sideEffect !== error.sideEffect) {
        throw new SshOperationError({
          code: error.code,
          operation: error.operation,
          message: `${error.message.replace(/^\[[^\]]+\]\s*/, "")}${
            cleanupFailure ? `; temporary cleanup ${cleanupFailure}` : ""
          }`,
          sideEffect,
          remoteProcessTermination: error.remoteProcessTermination,
          cleanup: cleanupFailure
            ? {
                temporaryFile: {
                  status: "failed",
                  message: cleanupFailure,
                },
              }
            : undefined,
        });
      }
      throw error;
    }
    throw new SshOperationError({
      code: "SSH_FILE_WRITE_FAILED",
      operation: "sftp_atomic_write",
      message: `Atomic remote file save failed: ${errorMessage(error)}${
        cleanupFailure ? `; temporary cleanup ${cleanupFailure}` : ""
      }`,
      sideEffect:
        renameAttempted || compatibilityWriteStarted ? "possible" : "none",
      cleanup: cleanupFailure
        ? {
            temporaryFile: {
              status: "failed",
              message: cleanupFailure,
            },
          }
        : undefined,
    });
  }
};

export const writeSshFile = (
  sessionId: string,
  remotePath: string,
  content: string | Buffer,
  options: SshFileWriteOptions
): Promise<SshFileWriteResult> =>
  writeSshFileWithOptions(sessionId, remotePath, content, options);

export const writeInternalSshFile = (
  sessionId: string,
  remotePath: string,
  content: string | Buffer,
  options?: SshInternalFileWriteOptions
): Promise<SshFileWriteResult> =>
  writeSshFileWithOptions(sessionId, remotePath, content, options);

export const deleteSshFile = (
  sessionId: string,
  remotePath: string
): Promise<void> => {
  return new Promise((resolve, reject) => {
    const session = getSshSession(sessionId);
    if (!session) {
      reject(new Error("SSH session not found. Please reconnect."));
      return;
    }

    session.sftp.unlink(remotePath, (err) => {
      if (err) {
        reject(new Error(`Failed to delete remote file: ${err.message}`));
        return;
      }
      resolve();
    });
  });
};

export const renameSshFile = (
  sessionId: string,
  oldPath: string,
  newPath: string
): Promise<void> => {
  return new Promise((resolve, reject) => {
    const session = getSshSession(sessionId);
    if (!session) {
      reject(new Error("SSH session not found. Please reconnect."));
      return;
    }

    session.sftp.rename(oldPath, newPath, (err) => {
      if (err) {
        reject(new Error(`Failed to rename remote file: ${err.message}`));
        return;
      }
      resolve();
    });
  });
};

export const deleteSshDirectory = (
  sessionId: string,
  remotePath: string
): Promise<void> => {
  // SFTP rmdir only works on empty directories. For recursive removal we
  // shell out to `rm -rf` via the existing exec channel, which is the most
  // reliable cross-platform approach on remote servers.
  const quoted = `'${remotePath.replace(/'/g, `'\"'\"'`)}'`;
  return executeSshCommand(sessionId, `rm -rf ${quoted}`).then(() => undefined);
};

export const statSshEntry = (
  sessionId: string,
  remotePath: string
): Promise<import("ssh2").Stats | null> => {
  return new Promise((resolve, reject) => {
    const session = getSshSession(sessionId);
    if (!session) {
      reject(new Error("SSH session not found. Please reconnect."));
      return;
    }

    session.sftp.stat(
      remotePath,
      (err: Error | undefined, stats: import("ssh2").Stats) => {
        if (err) {
          // Path may have been removed; return null instead of rejecting.
          resolve(null);
          return;
        }
        resolve(stats);
      }
    );
  });
};

export const disconnectSsh = (sessionId: string): void => {
  const resolvedSessionId = sessions.has(sessionId)
    ? sessionId
    : sessionHandleResolver?.(sessionId);
  if (!resolvedSessionId) {
    return;
  }
  const session = sessions.get(resolvedSessionId);
  if (!session) {
    return;
  }
  try {
    session.sftp.end();
    session.client.end();
  } catch {
    // Ignore
  }
  sessions.delete(resolvedSessionId);
};

export const disconnectAllSsh = (): void => {
  for (const [, session] of sessions) {
    try {
      session.sftp.end();
      session.client.end();
    } catch {
      // Ignore
    }
  }
  sessions.clear();
};

export const isSshPath = (path: string): boolean => path.startsWith("ssh://");

export type ParsedSshUrl = {
  host: string;
  port: number;
  username: string;
  remotePath: string;
};

export const parseSshUrl = (sshUrl: string): ParsedSshUrl => {
  const withoutPrefix = sshUrl.replace(/^ssh:\/\//, "");
  const atIndex = withoutPrefix.indexOf("@");
  if (atIndex < 0) {
    throw new Error("Invalid SSH URL: missing username");
  }
  const username = withoutPrefix.slice(0, atIndex);
  const hostPortAndPath = withoutPrefix.slice(atIndex + 1);
  const slashIndex = hostPortAndPath.indexOf("/");
  const hostPort =
    slashIndex >= 0 ? hostPortAndPath.slice(0, slashIndex) : hostPortAndPath;
  const remotePath = slashIndex >= 0 ? hostPortAndPath.slice(slashIndex) : "/";
  const colonIndex = hostPort.indexOf(":");
  const host = colonIndex >= 0 ? hostPort.slice(0, colonIndex) : hostPort;
  const port =
    colonIndex >= 0 ? parseInt(hostPort.slice(colonIndex + 1), 10) : 22;
  return { host, port, username, remotePath };
};

/**
 * Converts a renderer-provided SSH workspace URI into a verified remote root
 * for an existing session. The renderer never gets to authorize a different
 * host, account, or port through the write API.
 */
export const resolveSshWorkspaceRoot = (
  sessionId: string,
  workspaceUrl: string
): string => {
  const session = getSshSession(sessionId);
  if (!session) {
    throw new Error("SSH session not found. Please reconnect.");
  }
  const parsed = parseSshUrl(workspaceUrl);
  if (
    parsed.host !== session.params.host ||
    parsed.port !== session.params.port ||
    parsed.username !== session.params.username
  ) {
    throw new SshOperationError({
      code: "SSH_WORKSPACE_SESSION_MISMATCH",
      operation: "sftp_atomic_write",
      message: "Authorized workspace does not match the active SSH session",
    });
  }
  return normalizedRemotePath(parsed.remotePath);
};

export const buildSshUrl = (parsed: ParsedSshUrl): string =>
  `ssh://${parsed.username}@${parsed.host}:${parsed.port}${parsed.remotePath}`;
