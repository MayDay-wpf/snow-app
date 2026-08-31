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
  /** 脚本文件在磁盘上的绝对路径。 */
  filePath: string;
  createdAt: string;
  updatedAt: string;
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
