import type {
  McpServerConfigRecord,
  McpToolDefinition,
  ProjectMcpServerConfigRecord,
} from "../../../../preload";

export type McpServerConfig = McpServerConfigRecord;
export type ProjectMcpServerConfig = ProjectMcpServerConfigRecord;
export type McpServerConfigLike = Omit<McpServerConfig, "id">;
/**
 * `globalEnabled` 仅项目作用域的工具携带：为 false 表示已在全局禁用，
 * 项目层开关无法覆盖（全局作用域工具不含该字段）。
 */
export type McpServerTool = McpToolDefinition & {
  enabled: boolean;
  globalEnabled?: boolean;
};

export type McpKeyValuePair = {
  id: string;
  key: string;
  value: string;
};

export type McpStringItem = {
  id: string;
  value: string;
};

export type McpApiParamDraft = {
  id: string;
  name: string;
  /** string | number | integer | boolean | object | array */
  type: string;
  required: boolean;
  description: string;
  /** query | path | header | body */
  location: string;
  defaultValue: string;
};

export type McpApiEndpointDraft = {
  id: string;
  name: string;
  description: string;
  method: string;
  path: string;
  headers: McpKeyValuePair[];
  params: McpApiParamDraft[];
  /** none | json | form | multipart | raw */
  bodyType: string;
  bodyTemplate: string;
  rawContentType: string;
};

/** 自定义 API 传输的接口定义（持久化到 argsJson）。 */
export type McpApiSpecDraft = {
  cookies: McpKeyValuePair[];
  endpoints: McpApiEndpointDraft[];
};

export type McpServerDraft = {
  serverId: string;
  name: string;
  transportType: string;
  url: string;
  command: string;
  args: McpStringItem[];
  env: McpKeyValuePair[];
  headers: McpKeyValuePair[];
  api: McpApiSpecDraft;
  /** HTTP 传输是否走 OAuth 浏览器授权（其他传输恒为 false）。 */
  oauth: boolean;
  enabled: boolean;
  timeoutMs: string;
  sortOrder: number;
  source: string;
};
