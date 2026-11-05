/** 工具插件的一个工具（名称 / 描述）。 */
export type PluginToolInfo = {
  name: string;
  description: string;
};

/** 工具插件的一个 MCP 服务器及其工具清单（按项目作用域发现）。 */
export type PluginToolServerInfo = {
  pluginId: string;
  serverName: string;
  publicServerName: string;
  tools: PluginToolInfo[];
  error?: string | null;
};

/** 项目级插件作用域：`pluginOverrides` 缺省表示该项目可用全部已启用插件。 */
export type PluginsProjectScope = {
  projectId: string;
  pluginOverrides: Record<string, boolean>;
};

/** 插件完整记录（管理 UI 与插件运行时使用）。 */
export type PluginRecord = {
  pluginId: string;
  /** 本地化名称 JSON：{"default": "...", "zh-CN": "..."} */
  name: string;
  /** 本地化描述 JSON。 */
  description: string;
  version: string;
  author: string;
  homepage: string;
  license: string;
  /** lucide:IconName / 相对路径 / URL */
  icon: string;
  /** "esm" | "iframe" */
  renderMode: string;
  /** "plugin"（面板插件）| "oauth"（OAuth 登录插件） */
  kind: string;
  entry: string;
  enabled: boolean;
  installPath: string;
  sourcePath: string;
  manifestJson: string;
  /** 面板定义 JSON 数组：[{ id, title, entry, icon, widthHint }] */
  panels: string;
  /** 语言包映射 JSON：{"zh-CN": "locales/zh-CN.json"} */
  locales: string;
  /** 需要注入的样式文件列表 JSON。 */
  styles: string;
  /** 声明使用的敏感数据域。 */
  privacy: string[];
  privacyNote: string;
  minAppVersion: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

/** 插件持久化 KV 条目。 */
export type PluginStorageValue = {
  key: string;
  value: string;
};

export type PluginHttpRequestOptions = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  /** text（默认）在宿主侧按 UTF-8 解码；arraybuffer 只回传原始字节的 base64 */
  responseType?: "text" | "arraybuffer";
};

export type PluginHttpResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  /** responseType 为 arraybuffer 时返回，body 为空串 */
  bodyBase64?: string;
  url: string;
  error: string | null;
};

/** 主进程后台模块请求渲染层执行的一次 RPC（元数据 / 写动作）。 */
export type PluginBackgroundRequest = {
  id: string;
  pluginId: string;
  method: string;
  args: Record<string, unknown>;
};

/** 渲染层对后台 RPC 的回复。 */
export type PluginBackgroundResponse = {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};
