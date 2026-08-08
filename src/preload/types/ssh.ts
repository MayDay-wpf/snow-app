export type SshAuthMethod = "password" | "privateKey" | "agent";

export type SshConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "degraded"
  | "reconnecting"
  | "offline"
  | "auth_required"
  | "host_key_changed";

/** A stable SSH profile handle; sessionId changes whenever the transport reconnects. */
export type SshProfileConnection = {
  profileId: string;
  sessionId?: string;
  generation: number;
  status: SshConnectionStatus;
  lastError?: string;
};

/**
 * SSH 连接失败的错误码，由主进程 `ssh:connect` handler 分类产生，
 * 渲染层据此展示本地化的友好提示。
 */
export type SshConnectErrorCode =
  | "network"
  | "timeout"
  | "auth"
  | "sftp"
  | "invalid"
  | "unknown";

/** preload 抛出的 SSH 连接错误：携带错误码与原始技术细节。 */
export type SshConnectError = Error & {
  code?: SshConnectErrorCode;
  detail?: string;
};

/**
 * `ssh:connect` 的结构化返回结果。注意：contextBridge 序列化 Error 时
 * 会丢弃自定义属性（code/detail），因此需要完整错误信息的调用方
 * （如连接向导）应使用 `sshConnectDetailed` 直接消费本类型。
 */
export type SshConnectResult =
  | { ok: true; sessionId: string }
  | { ok: false; code: SshConnectErrorCode; message: string; detail: string };

export type SshConnectParams = {
  host: string;
  port: number;
  username: string;
  authMethod: SshAuthMethod;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
  hostKeyPolicy?: "replace";
};

export type SshDirectoryEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
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

export type SshFileVersion = {
  exists: boolean;
  sha256?: string;
  size?: number;
  mtime?: number;
};

export type SshFileWriteOptions = {
  /** Stable SSH workspace record that Main resolves to the authorized root. */
  workspaceId: string;
  /** Required write CAS precondition for all user-reachable saves. */
  expectedVersion: SshFileVersion;
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

export type RemoteDraftStatus = "pending" | "conflict";

export type RemoteDraftInput = {
  profileId: string;
  workspaceId: string;
  remotePath: string;
  baseVersionJson: string;
  content: string;
  status: RemoteDraftStatus;
};

export type RemoteDraftRecord = RemoteDraftInput & {
  id: string;
  updatedAt: string;
};

export type RemoteWorkspaceFileSearchOptions = {
  query: string;
  listChildren: boolean;
};

export type SshCredentialRecord = {
  profileKey: string;
  host: string;
  port: number;
  username: string;
  authMethod: SshAuthMethod;
  privateKeyPath?: string;
  encryptedSecret?: string;
};

export type ParsedSshUrl = {
  host: string;
  port: number;
  username: string;
  remotePath: string;
};

export type RemoteJobStatus =
  | "preparing"
  | "launching"
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "lost"
  | "launch_failed"
  | "indeterminate";

export type RemoteJobBackendKind =
  | "snow-agent"
  | "systemd-user"
  | "tmux"
  | "posix-detach";

export type RemoteJobCancellationPolicy = "cancel_remote" | "detach_only";
export type RemoteJobMode = "batch" | "interactive";

export type RemoteJobBinding = {
  jobId: string;
  workspacePath: string;
  workspaceId: string;
  profileId: string;
  commandHash: string;
  displayCommand: string;
  backend: RemoteJobBackendKind;
  mode: RemoteJobMode;
  cancellationPolicy?: RemoteJobCancellationPolicy;
  createdAt: string;
  updatedAt: string;
  status: RemoteJobStatus;
  revision: number;
  conversationId?: string;
  toolCallId?: string;
  lastOutputOffset: number;
  lastError?: string;
};

export type RemoteJobState = {
  schemaVersion: number;
  jobId: string;
  status: RemoteJobStatus;
  revision: number;
  backend?: RemoteJobBackendKind;
  mode?: RemoteJobMode;
  runnerPid?: number;
  exitCode?: number;
  createdAt?: string;
  startedAt?: string;
  updatedAt: string;
  completedAt?: string;
  reason?: string;
  truncated?: boolean;
};

export type RemoteJobStartRequest = {
  workspacePath: string;
  workspaceId?: string;
  command: string;
  timeoutMs?: number;
  jobId?: string;
  backend?: RemoteJobBackendKind;
  mode?: RemoteJobMode;
  conversationId?: string;
  toolCallId?: string;
};

export type RemoteJobOutput = {
  job: RemoteJobBinding;
  state: RemoteJobState;
  output: string;
  /** Raw UTF-8 bytes. Decode incremental reads with TextDecoder stream mode. */
  outputBytes: Uint8Array;
  offset: number;
  nextOffset: number;
  eof: boolean;
};

export type RemoteJobPtyAttachment = {
  jobId: string;
  backend: RemoteJobBackendKind;
  ptyId: string;
};

/** 本地 ~/.ssh/config 中解析出的主机条目。 */
export type SshConfigHost = {
  /** `Host` 关键字的值（别名） */
  alias: string;
  /** 实际主机名（HostName，缺失时回退为 alias） */
  host: string;
  /** 登录用户名（User） */
  user?: string;
  /** 端口（Port），默认 22 */
  port: number;
  /** 私钥文件路径（IdentityFile） */
  identityFile?: string;
};
