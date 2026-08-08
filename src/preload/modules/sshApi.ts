import { ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  FileContentResult,
  FileSearchResult,
  ParsedSshUrl,
  RemoteJobBinding,
  RemoteJobOutput,
  RemoteJobPtyAttachment,
  RemoteJobStartRequest,
  RemoteWorkspaceFileSearchOptions,
  SshCapabilities,
  SshAuthMethod,
  SshConfigHost,
  SshConnectParams,
  SshConnectResult,
  SshCredentialRecord,
  SshDirectoryEntry,
  SshFileWriteOptions,
  SshFileWriteResult,
  SshProfileConnection,
  RemoteDraftInput,
  RemoteDraftRecord,
} from "../types";

export const sshApi = {
  /**
   * 建立 SSH 会话。主进程返回结构化结果
   * `{ ok: true, sessionId }` 或 `{ ok: false, code, message, detail }`；
   * 失败时此处转换为 Error 抛出，对外签名保持 `Promise<string>` 不变。
   * 注意：contextBridge 序列化 Error 只保留 message，自定义属性会被丢弃，
   * 因此原始原因（detail）拼入 message；需要完整错误码的调用方
   * 请使用 `sshConnectDetailed`。
   */
  sshConnect: async (params: SshConnectParams): Promise<string> => {
    const result: unknown = await ipcRenderer.invoke("ssh:connect", params);
    if (
      result !== null &&
      typeof result === "object" &&
      (result as { ok?: unknown }).ok === false
    ) {
      const failure = result as {
        message?: unknown;
        detail?: unknown;
      };
      const message =
        typeof failure.message === "string"
          ? failure.message
          : "Failed to connect to SSH server";
      const detail =
        typeof failure.detail === "string" && failure.detail
          ? failure.detail
          : undefined;
      throw new Error(detail ? `${message} (${detail})` : message);
    }
    if (typeof result !== "string") {
      throw new Error("Unexpected SSH connect response");
    }
    return result;
  },
  /**
   * 建立 SSH 会话并返回完整结构化结果（成功/失败均不抛异常）。
   * 失败信息（错误码、友好消息、原始原因）不经过 Error 序列化，
   * 供需要精细展示的调用方（如连接向导）使用。
   */
  sshConnectDetailed: (
    params: SshConnectParams
  ): Promise<SshConnectResult> =>
    ipcRenderer.invoke("ssh:connect", params) as Promise<SshConnectResult>,
  /** 读取本地 ~/.ssh/config 中的主机条目（无文件或解析失败返回空数组）。 */
  sshListConfigHosts: (): Promise<SshConfigHost[]> =>
    ipcRenderer.invoke("ssh:list-config-hosts"),
  sshConnectProfile: (params: SshConnectParams): Promise<SshProfileConnection> =>
    ipcRenderer.invoke("ssh:profiles:connect", params),
  sshGetProfileConnection: (
    profileId: string
  ): Promise<SshProfileConnection | null> =>
    ipcRenderer.invoke("ssh:profiles:get", profileId),
  sshReleaseProfile: (profileId: string): Promise<void> =>
    ipcRenderer.invoke("ssh:profiles:release", profileId),
  sshListRemoteDrafts: (
    workspaceId: string,
    profileId?: string
  ): Promise<RemoteDraftRecord[]> =>
    ipcRenderer.invoke("ssh:drafts:list", workspaceId, profileId),
  sshUpsertRemoteDraft: (draft: RemoteDraftInput): Promise<RemoteDraftRecord> =>
    ipcRenderer.invoke("ssh:drafts:upsert", draft),
  sshDeleteRemoteDraft: (
    profileId: string,
    workspaceId: string,
    remotePath: string
  ): Promise<void> =>
    ipcRenderer.invoke("ssh:drafts:delete", profileId, workspaceId, remotePath),
  onSshProfileConnection: (
    callback: (connection: SshProfileConnection) => void
  ): (() => void) => {
    const handler = (_event: IpcRendererEvent, connection: SshProfileConnection): void => {
      callback(connection);
    };
    ipcRenderer.on("ssh:profile-state", handler);
    return () => ipcRenderer.removeListener("ssh:profile-state", handler);
  },
  sshListDirectory: (
    sessionId: string,
    remotePath: string
  ): Promise<SshDirectoryEntry[]> =>
    ipcRenderer.invoke("ssh:list-directory", sessionId, remotePath),
  sshExecuteCommand: (sessionId: string, command: string): Promise<string> =>
    ipcRenderer.invoke("ssh:execute-command", sessionId, command),
  sshProbeCapabilities: (sessionId: string): Promise<SshCapabilities> =>
    ipcRenderer.invoke("ssh:probe-capabilities", sessionId),
  searchRemoteWorkspaceFiles: (
    workspacePath: string,
    options: RemoteWorkspaceFileSearchOptions
  ): Promise<FileSearchResult[]> =>
    ipcRenderer.invoke("ssh:search-workspace-files", workspacePath, options),
  sshReadFile: (
    sessionId: string,
    remotePath: string
  ): Promise<FileContentResult> =>
    ipcRenderer.invoke("ssh:read-file", sessionId, remotePath),
  sshWriteFile: (
    sessionId: string,
    remotePath: string,
    content: string,
    options: SshFileWriteOptions
  ): Promise<SshFileWriteResult> =>
    ipcRenderer.invoke("ssh:write-file", sessionId, remotePath, content, options),
  sshDeleteEntry: (sessionId: string, remotePath: string): Promise<void> =>
    ipcRenderer.invoke("ssh:delete-entry", sessionId, remotePath),
  sshRenameEntry: (
    sessionId: string,
    remotePath: string,
    newName: string
  ): Promise<void> =>
    ipcRenderer.invoke("ssh:rename-entry", sessionId, remotePath, newName),
  sshDisconnect: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke("ssh:disconnect", sessionId),
  sshSaveCredential: (params: {
    host: string;
    port: number;
    username: string;
    authMethod: SshAuthMethod;
    privateKeyPath?: string;
    secret?: string;
  }): Promise<SshCredentialRecord> =>
    ipcRenderer.invoke("ssh:save-credential", params),
  sshGetCredential: (
    host: string,
    port: number,
    username: string
  ): Promise<SshCredentialRecord | null> =>
    ipcRenderer.invoke("ssh:get-credential", host, port, username),
  sshGetDecryptedSecret: (
    host: string,
    port: number,
    username: string
  ): Promise<string | null> =>
    ipcRenderer.invoke("ssh:get-decrypted-secret", host, port, username),
  sshListCredentials: (): Promise<SshCredentialRecord[]> =>
    ipcRenderer.invoke("ssh:list-credentials"),
  sshDeleteCredential: (
    host: string,
    port: number,
    username: string
  ): Promise<void> =>
    ipcRenderer.invoke("ssh:delete-credential", host, port, username),
  sshSelectPrivateKey: (dialogTitle?: string): Promise<string | null> =>
    ipcRenderer.invoke("ssh:select-private-key", dialogTitle),
  sshParseUrl: (sshUrl: string): Promise<ParsedSshUrl> =>
    ipcRenderer.invoke("ssh:parse-url", sshUrl),
  sshStartRemoteJob: (
    request: RemoteJobStartRequest
  ): Promise<RemoteJobBinding> => ipcRenderer.invoke("ssh:jobs:start", request),
  sshListRemoteJobs: (workspacePath?: string): Promise<RemoteJobBinding[]> =>
    ipcRenderer.invoke("ssh:jobs:list", workspacePath),
  sshGetRemoteJob: (
    jobId: string,
    options?: { offset?: number; limit?: number }
  ): Promise<RemoteJobOutput> =>
    ipcRenderer.invoke("ssh:jobs:get", jobId, options),
  sshCancelRemoteJob: (jobId: string): Promise<RemoteJobBinding> =>
    ipcRenderer.invoke("ssh:jobs:cancel", jobId),
  sshAttachRemoteJob: (
    jobId: string,
    viewport: { cols: number; rows: number }
  ): Promise<RemoteJobPtyAttachment> =>
    ipcRenderer.invoke("ssh:jobs:attach", jobId, viewport),
  sshGetRemoteJobAnalysisContext: (
    jobId: string,
    options?: { offset?: number; limit?: number }
  ): Promise<string> =>
    ipcRenderer.invoke("ssh:jobs:analysis-context", jobId, options),
  sshCleanupRemoteJobs: (): Promise<{ removed: string[] }> =>
    ipcRenderer.invoke("ssh:jobs:cleanup"),
};
