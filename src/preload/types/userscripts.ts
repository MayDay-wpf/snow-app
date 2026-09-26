/** 用户脚本完整记录（管理 UI 使用）。 */
export type UserscriptRecord = {
  scriptId: string;
  name: string;
  version: string;
  description: string;
  namespace: string;
  author: string;
  enabled: boolean;
  runAt: "document-start" | "document-end" | "document-idle";
  noframes: boolean;
  grant: string[];
  matches: string[];
  includes: string[];
  excludes: string[];
  requires: string[];
  /** 作用域：`browser`（内置浏览器）/ `client`（桌面客户端 UI）/ `all`。 */
  target: "browser" | "client" | "all";
  /** 客户端脚本生效的主内容视图（空 = 全部视图）。 */
  views: string[];
  /** 客户端脚本生效的界面区域。 */
  surfaces: string[];
  /** 生命周期作用域：`global` = 应用启动即常驻。 */
  scope: string;
  /** 是否隔离世界执行（沙箱档）；false = 主世界完全权限档。 */
  sandbox: boolean;
  /** 脚本文件在磁盘上的绝对路径。 */
  filePath: string;
  createdAt: string;
  updatedAt: string;
};

/** 桌面窗口当前界面上下文（渲染层发布，客户端脚本匹配依据）。 */
export type ClientScriptContext = {
  view: string;
  surfaces: string[];
  tabs: string[];
  theme: string;
  locale: string;
  projectId: string | null;
  appReady: boolean;
  /** 当前会话 id（null = 新会话 / 无活动会话）。 */
  conversationId: string | null;
  /** 当前会话是否正在流式输出。 */
  isStreaming: boolean;
};

/** 主进程推给 preload 的客户端脚本载荷。 */
export type ClientScriptPayload = {
  scriptId: string;
  name: string;
  version: string;
  description: string;
  runAt: string;
  /** true = 隔离世界沙箱档；false = 主世界完全权限档。 */
  sandbox: boolean;
  /** `global` = 常驻脚本（应用启动执行，不随视图卸载）。 */
  scope: string;
  views: string[];
  surfaces: string[];
  code: string;
  raw: string;
  gmValues: Record<string, string>;
};

/** 客户端脚本运行失败记录（管理面板展示）。 */
export type ClientScriptFailure = {
  scriptId: string;
  count: number;
  message: string;
  at: number;
  disabled: boolean;
};

/** 客户端脚本注册的菜单命令（管理面板触发）。 */
export type ClientScriptCommand = {
  id: number;
  scriptId: string;
  title: string;
};

/** webview preload 匹配查询返回项。 */
export type UserscriptMatchItem = {
  scriptId: string;
  name: string;
  version: string;
  description: string;
  runAt: "document-start" | "document-end" | "document-idle";
  noframes: boolean;
  grant: string[];
  /** @require 声明的外部脚本 URL（主进程负责下载并拼接）。 */
  requires: string[];
  /** GM 值快照：主进程 match 时内嵌，preload 注入后同步读取。 */
  gmValues?: Record<string, string>;
  code: string;
  raw: string;
};

/** GM 值条目。 */
export type UserscriptValue = {
  key: string;
  value: string;
};

/** Greasy Fork 搜索结果项。 */
export type GreasyForkSearchItem = {
  name: string;
  description: string;
  totalInstalls: number;
  dailyInstalls: number;
  url: string;
  codeUrl: string;
  namespace: string;
  updatedAt: string;
  ratingScore: number;
};

/** Greasy Fork 搜索结果（相对分页：API 无总数，以 hasMore 判断是否有下一页）。 */
export type GreasyForkSearchResult = {
  page: number;
  hasMore: boolean;
  results: GreasyForkSearchItem[];
};

/** 本地脚本文件选择结果（从文件导入，渲染层编辑器预填用）。 */
export type UserscriptFilePick = {
  fileName: string;
  content: string;
};
