import { ipcRenderer } from "electron";
import type { TeamIdentity, TeamRecordKind, TeamSyncResult } from "../types";

export const teamApi = {
  /** Rust 返回 JSON 字符串，此处解析为对象后再交给渲染层。 */
  teamGetIdentity: async (repoPath: string): Promise<TeamIdentity> =>
    JSON.parse(await ipcRenderer.invoke("team:get-identity", repoPath)),
  /** 定位真实仓库路径：向上找 .git，找不到再扫子目录；空串表示非仓库。 */
  teamResolveRepo: (path: string): Promise<string> =>
    ipcRenderer.invoke("team:resolve-repo", path),
  teamConfigureIdentity: async (
    repoPath: string,
    name: string,
    email: string,
  ): Promise<TeamIdentity> =>
    JSON.parse(
      await ipcRenderer.invoke(
        "team:configure-identity",
        repoPath,
        name,
        email,
      ),
    ),
  teamSync: async (repoPath: string): Promise<TeamSyncResult> =>
    JSON.parse(await ipcRenderer.invoke("team:sync", repoPath)),
  /** 列出某类团队记录，返回原始 JSON 字符串数组。 */
  teamList: (repoPath: string, kind: TeamRecordKind): Promise<string[]> =>
    ipcRenderer.invoke("team:list", repoPath, kind),
  teamUpsert: (
    repoPath: string,
    kind: TeamRecordKind,
    id: string,
    json: string,
  ): Promise<string> =>
    ipcRenderer.invoke("team:upsert", repoPath, kind, id, json),
  teamDelete: (
    repoPath: string,
    kind: TeamRecordKind,
    id: string,
  ): Promise<boolean> => ipcRenderer.invoke("team:delete", repoPath, kind, id),
  /** 保存团队笔记媒体文件（图片），返回 `snow-team/media/...` 相对路径。 */
  teamMediaSave: (
    repoPath: string,
    noteId: string,
    fileName: string,
    base64Data: string,
  ): Promise<string> =>
    ipcRenderer.invoke(
      "team:media-save",
      repoPath,
      noteId,
      fileName,
      base64Data,
    ),
  /** 读取团队媒体文件，返回 data URL。 */
  teamMediaRead: (repoPath: string, rel: string): Promise<string> =>
    ipcRenderer.invoke("team:media-read", repoPath, rel),
  /** 保存团队消息附件（图片或普通文件），返回 `snow-team/media/...` 相对路径。 */
  teamFileSave: (
    repoPath: string,
    messageId: string,
    fileName: string,
    base64Data: string,
  ): Promise<string> =>
    ipcRenderer.invoke(
      "team:file-save",
      repoPath,
      messageId,
      fileName,
      base64Data,
    ),
  /** 删除某条记录（消息/笔记）的整个媒体目录。 */
  teamMediaDelete: (repoPath: string, ownerId: string): Promise<boolean> =>
    ipcRenderer.invoke("team:media-delete", repoPath, ownerId),
};
