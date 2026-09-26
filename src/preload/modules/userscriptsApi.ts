import { ipcRenderer } from "electron";
import type {
  ClientScriptCommand,
  ClientScriptContext,
  ClientScriptFailure,
  GreasyForkSearchResult,
  UserscriptFilePick,
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
  /** 弹出系统文件选择框并读取所选 .user.js 内容（从文件导入用）。取消时返回 null。 */
  pickUserscriptFile: (
    dialogTitle?: string,
  ): Promise<UserscriptFilePick | null> =>
    ipcRenderer.invoke("userscripts:pick-file", dialogTitle),
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
  // ===== 客户端 UI 脚本（桌面窗口定制） =====
  /** 发布桌面窗口界面上下文：主进程据此匹配客户端脚本并推给 preload 注入。 */
  publishClientContext: (context: ClientScriptContext): Promise<void> =>
    ipcRenderer.invoke("userscripts:client-context", context),
  /** 手动重新应用一次客户端脚本（脚本增删改后立即生效）。 */
  reapplyClientScripts: (): Promise<void> =>
    ipcRenderer.invoke("userscripts:client-apply"),
  /** 客户端脚本经 GM_registerMenuCommand 注册的命令。 */
  listClientScriptCommands: (): Promise<ClientScriptCommand[]> =>
    ipcRenderer.invoke("userscripts:client-commands"),
  runClientScriptCommand: (commandId: number): Promise<void> =>
    ipcRenderer.invoke("userscripts:client-run-command", commandId),
  /** 客户端脚本运行失败记录（连续失败会被自动禁用）。 */
  getClientScriptFailures: (): Promise<ClientScriptFailure[]> =>
    ipcRenderer.invoke("userscripts:client-errors"),
  /** 脚本集合变化广播：AI 经 config-set 安装 / 启停 / 删除时同样能感知。 */
  onUserscriptsChanged: (callback: () => void): (() => void) => {
    const handler = (): void => callback();
    ipcRenderer.on("userscripts:changed", handler);
    return () => {
      ipcRenderer.removeListener("userscripts:changed", handler);
    };
  },
};
