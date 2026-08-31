import { ipcRenderer } from "electron";
import type {
  GreasyForkSearchResult,
  UserscriptRecord,
  UserscriptValue,
} from "../types/userscripts";

export const userscriptsApi = {
  // ===== 脚本管理 =====
  listUserscripts: (): Promise<UserscriptRecord[]> =>
    ipcRenderer.invoke("userscripts:list"),
  createUserscript: (raw: string): Promise<UserscriptRecord> =>
    ipcRenderer.invoke("userscripts:create", raw),
  updateUserscript: (
    scriptId: string,
    raw: string,
  ): Promise<UserscriptRecord> =>
    ipcRenderer.invoke("userscripts:update", scriptId, raw),
  deleteUserscript: (scriptId: string): Promise<void> =>
    ipcRenderer.invoke("userscripts:delete", scriptId),
  setUserscriptEnabled: (scriptId: string, enabled: boolean): Promise<void> =>
    ipcRenderer.invoke("userscripts:set-enabled", scriptId, enabled),
  /** 读取脚本文件完整内容（含元数据头），编辑器加载用。 */
  readUserscriptSource: (scriptId: string): Promise<string> =>
    ipcRenderer.invoke("userscripts:read-source", scriptId),
  // ===== Greasy Fork 搜索 / 安装 =====
  searchUserscripts: (
    query: string,
    perPage?: number,
    page?: number,
  ): Promise<GreasyForkSearchResult> =>
    ipcRenderer.invoke("userscripts:search", query, perPage ?? 20, page ?? 1),
  installUserscript: (codeUrl: string): Promise<UserscriptRecord> =>
    ipcRenderer.invoke("userscripts:install", codeUrl),
  // ===== GM 值（管理 UI 查看用） =====
  getUserscriptValues: (scriptId: string): Promise<UserscriptValue[]> =>
    ipcRenderer.invoke("userscripts:gm-get-values", scriptId),
};
