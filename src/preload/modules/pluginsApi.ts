import { ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  PluginBackgroundRequest,
  PluginBackgroundResponse,
  PluginHttpRequestOptions,
  PluginHttpResponse,
  PluginRecord,
  PluginStorageValue,
  PluginToolServerInfo,
} from "../types/plugins";
import type { UserscriptRecord } from "../types/userscripts";

export const pluginsApi = {
  /** 列出全部已安装插件。 */
  listPlugins: (): Promise<PluginRecord[]> =>
    ipcRenderer.invoke("plugins:list"),
  /** 发现已启用工具插件的工具清单（按项目作用域，不受会话 `@` 门控）。 */
  listPluginTools: (projectId?: string): Promise<PluginToolServerInfo[]> =>
    ipcRenderer.invoke("plugins:list-tools", projectId),
  /** 读取项目级插件作用域（JSON 字符串）。 */
  getPluginsProjectScope: (projectId: string): Promise<string> =>
    ipcRenderer.invoke("plugins:project-scope-get", projectId),
  /** 设置某插件在某项目内的可用状态（全局启用是总闸）。 */
  setPluginsProjectPluginEnabled: (payload: {
    projectId: string;
    pluginId: string;
    enabled: boolean;
  }): Promise<void> => ipcRenderer.invoke("plugins:project-scope-set", payload),
  /** 插件根目录绝对路径（~/.snowapp/plugins）。 */
  getPluginsDirectory: (): Promise<string> =>
    ipcRenderer.invoke("plugins:get-directory"),
  /** 弹出系统目录选择框（安装插件用）。取消时返回 null。 */
  pickPluginDirectory: (dialogTitle?: string): Promise<string | null> =>
    ipcRenderer.invoke("plugins:pick-directory", dialogTitle),
  /** 从本地目录安装（或更新）插件：自动扫描 plugin.json 并复制到插件目录。 */
  installPlugin: (sourceDir: string): Promise<PluginRecord> =>
    ipcRenderer.invoke("plugins:install", sourceDir),
  /** 拉取插件市场索引 JSON（Rust 侧负责镜像降级与缓存）。 */
  fetchPluginRegistry: (forceRefresh?: boolean): Promise<string> =>
    ipcRenderer.invoke("plugins:market-registry", forceRefresh === true),
  /** 拉取市场条目下载量统计（Rust 侧负责 GitHub API 拉取与缓存）。 */
  fetchPluginMarketStats: (
    targets: string,
    forceRefresh?: boolean,
  ): Promise<string> =>
    ipcRenderer.invoke("plugins:market-stats", targets, forceRefresh === true),
  /** 从插件市场安装（或更新）插件：下载 zip、校验 SHA256 后复用目录安装链路。 */
  installPluginFromMarket: (payload: {
    pluginId: string;
    downloadUrl: string;
    sha256: string;
    sourceUrl: string;
  }): Promise<PluginRecord> =>
    ipcRenderer.invoke("plugins:market-install", payload),
  /** 从插件市场安装（或更新）用户脚本：下载 .user.js、校验 SHA256 后写入脚本库。 */
  installScriptFromMarket: (payload: {
    scriptId: string;
    downloadUrl: string;
    sha256: string;
    sourceUrl: string;
  }): Promise<UserscriptRecord> =>
    ipcRenderer.invoke("plugins:market-install-script", payload),
  /** 检索 GitHub 社区插件仓库（snow-plugins 主题；Rust 侧带限流回退与缓存）。 */
  fetchPluginCommunity: (
    query: string,
    forceRefresh?: boolean,
  ): Promise<string> =>
    ipcRenderer.invoke("plugins:community-list", query, forceRefresh === true),
  /**
   * 解析并安装社区来源：Rust 侧按最新 Release tag 下载该 tag 的不可变快照后按内容
   * 判定（面板插件 / 单个用户脚本直接安装，多个用户脚本返回候选清单）。
   * 返回 JSON 结果，由渲染层 `parseCommunityResolve` 解析。
   */
  resolvePluginCommunitySource: (payload: {
    repo: string;
    releaseTag?: string;
    token?: string;
    selection?: string[];
  }): Promise<string> =>
    ipcRenderer.invoke("plugins:community-resolve", payload),
  /** 重新读取插件目录中的 plugin.json 并刷新元数据。 */
  rescanPlugin: (pluginId: string): Promise<PluginRecord> =>
    ipcRenderer.invoke("plugins:rescan", pluginId),
  /** 启用 / 禁用插件。 */
  setPluginEnabled: (pluginId: string, enabled: boolean): Promise<void> =>
    ipcRenderer.invoke("plugins:set-enabled", pluginId, enabled),
  /** 卸载插件；deleteFiles 为 true 时同时删除插件目录。 */
  deletePlugin: (pluginId: string, deleteFiles: boolean): Promise<void> =>
    ipcRenderer.invoke("plugins:delete", pluginId, deleteFiles),
  /** 读取插件目录内的文本文件（入口代码 / 样式 / 语言包）。 */
  readPluginFile: (pluginId: string, relativePath: string): Promise<string> =>
    ipcRenderer.invoke("plugins:read-file", pluginId, relativePath),
  /** 读取插件目录内的二进制资源，返回 data URL（失败返回 null）。 */
  readPluginAsset: (
    pluginId: string,
    relativePath: string,
  ): Promise<string | null> =>
    ipcRenderer.invoke("plugins:read-asset", pluginId, relativePath),
  /** 读取插件的持久化 KV 数据。 */
  getPluginValues: (pluginId: string): Promise<PluginStorageValue[]> =>
    ipcRenderer.invoke("plugins:get-values", pluginId),
  /** 写入插件的持久化 KV 数据。 */
  setPluginValue: (
    pluginId: string,
    key: string,
    value: string,
  ): Promise<void> =>
    ipcRenderer.invoke("plugins:set-value", pluginId, key, value),
  /** 删除插件的持久化 KV 数据。 */
  deletePluginValue: (pluginId: string, key: string): Promise<void> =>
    ipcRenderer.invoke("plugins:delete-value", pluginId, key),
  requestPluginHttp: (
    options: PluginHttpRequestOptions,
  ): Promise<PluginHttpResponse> =>
    ipcRenderer.invoke("plugins:http-request", options),
  /** 插件集合被 AI 侧改动（config-manage 的 plugins 作用域）后由主进程广播。 */
  onPluginsChanged: (callback: () => void): (() => void) => {
    const handler = (): void => {
      callback();
    };

    ipcRenderer.on("plugins:changed", handler);

    return () => {
      ipcRenderer.removeListener("plugins:changed", handler);
    };
  },
  /** 主进程后台模块请求渲染层执行元数据 / 写动作（RPC 请求）。 */
  onPluginBackgroundRequest: (
    callback: (request: PluginBackgroundRequest) => void,
  ): (() => void) => {
    const handler = (
      _event: IpcRendererEvent,
      request: PluginBackgroundRequest,
    ): void => {
      callback(request);
    };

    ipcRenderer.on("plugin-background:request", handler);

    return () => {
      ipcRenderer.removeListener("plugin-background:request", handler);
    };
  },
  /** 回复主进程后台模块的 RPC 请求。 */
  respondPluginBackground: (response: PluginBackgroundResponse): void => {
    ipcRenderer.send("plugin-background:response", response);
  },
};
