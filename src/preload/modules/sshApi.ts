import { ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  BatchWorkspaceDeleteResult,
  FileContentResult,
  FileSearchResult,
  ParsedSshUrl,
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
   * 成功时提取 `sessionId`，失败时转换为 Error 抛出，对外签名保持
   * `Promise<string>` 不变；同时兼容旧版主进程直接返回字符串会话 ID
   * 的情况，只有完全畸形的响应才抛出 Unexpected SSH connect response。
   * 注意：contextBridge 序列化 Error 只保留 message，自定义属性会被丢弃，
   * 因此原始原因（detail）拼入 message；需要完整错误码的调用方
   * 请使用 `sshConnectDetailed`。
   */
  sshConnect: async (params: SshConnectParams): Promise<string> => {
    const result: unknown = await ipcRenderer.invoke("ssh:connect", params);
    if (result !== null && typeof result === "object") {
      const response = result as {
        ok?: unknown;
        sessionId?: unknown;
        message?: unknown;
        detail?: unknown;
      };
      if (response.ok === true && typeof response.sessionId === "string") {
        return response.sessionId;
      }
      if (response.ok === false) {
        const message =
          typeof response.message === "string"
            ? response.message
            : "Failed to connect to SSH server";
        const detail =
          typeof response.detail === "string" && response.detail
            ? response.detail
            : undefined;
        throw new Error(detail ? `${message} (${detail})` : message);
      }
    }
    if (typeof result === "string") {
      return result;
    }
    throw new Error("Unexpected SSH connect response");
  },
  /**
   * 建立 SSH 会话并返回完整结构化结果（成功/失败均不抛异常）。
   * 失败信息（错误码、友好消息、原始原因）不经过 Error 序列化，
   * 供需要精细展示的调用方（如连接向导）使用。
   */
  sshConnectDetailed: (params: SshConnectParams): Promise<SshConnectResult> =>
    ipcRenderer.invoke("ssh:connect", params) as Promise<SshConnectResult>,
  /** 读取本地 ~/.ssh/config 中的主机条目（无文件或解析失败返回空数组）。 */
  sshListConfigHosts: (): Promise<SshConfigHost[]> =>
    ipcRenderer.invoke("ssh:list-config-hosts"),
  sshConnectProfile: (
    params: SshConnectParams
  ): Promise<SshProfileConnection> =>
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
    const handler = (
      _event: IpcRendererEvent,
      connection: SshProfileConnection
    ): void => {
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
    ipcRenderer.invoke(
      "ssh:write-file",
      sessionId,
      remotePath,
      content,
      options
    ),
  sshDeleteEntry: (sessionId: string, remotePath: string): Promise<void> =>
    ipcRenderer.invoke("ssh:delete-entry", sessionId, remotePath),
  sshDeleteEntries: (
    sessionId: string,
    remotePaths: string[]
  ): Promise<BatchWorkspaceDeleteResult> =>
    ipcRenderer.invoke("ssh:delete-entries", sessionId, remotePaths),
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
};
