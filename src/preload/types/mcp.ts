export type McpToolDefinition = {
  name: string;
  description: string;
  inputSchemaJson: string;
};

export type McpToolStatus = McpToolDefinition & {
  enabled: boolean;
};

export type SkillDefinition = {
  id: string;
  name: string;
  description: string;
  /** `plugin` = 由工具插件 `skills` 贡献点提供，启停跟随插件。 */
  location: "project" | "global" | "plugin";
  /** `plugin:<pluginId>` = 插件技能。 */
  source: "snow" | "agents" | `plugin:${string}`;
  path: string;
  allowedTools?: string[];
  enabled: boolean;
};

export type ProjectSkillDefinition = Omit<SkillDefinition, "enabled"> & {
  defaultEnabled: boolean;
  enabled: boolean;
};

export type SkillInstallResult = {
  success: boolean;
  skillId: string;
  path: string;
  installedAt: string;
  commitSha?: string;
  error?: string;
};

export type SkillBatchInstallResult = {
  success: boolean;
  results: SkillInstallResult[];
  installedCount: number;
  totalCount: number;
  commitSha?: string;
  error?: string;
};

export type GithubSkillRecord = {
  id: string;
  name: string;
  description: string;
  location: string;
  sourceUrl: string;
  installedAt: string;
  commitSha?: string;
};

export type SkillUninstallResult = {
  success: boolean;
  skillId: string;
  message: string;
  error?: string;
};

export type McpProjectToolStatus = McpToolDefinition & {
  /** 有效启用态：全局未禁用且项目未禁用。 */
  enabled: boolean;
  /** 全局层是否启用；为 false 时项目层开关无法覆盖。 */
  globalEnabled: boolean;
};

export type McpProjectServerStatus = {
  id: string;
  name: string;
  source: "system" | "external" | "project";
  globalEnabled: boolean;
  enabled: boolean;
  tools: McpProjectToolStatus[];
  /**
   * 工具尚未从 Rust 端进程内缓存获得（需要后台发现）。快速列表
   * （`listMcpProjectServersCached`）会把它置为 true；全量列表恒为 false。
   */
  toolsPending: boolean;
  error?: string;
};
/**
 * 子代理白名单中当前不可用的工具。reason：reserved | global_disabled |
 * lite_mode | not_ready | superseded | server_disabled | server_unavailable | not_found
 */
export type SubAgentUnavailableTool = {
  name: string;
  reason: string;
};
export type BashStreamChunk = {
  stream:
    "stdout" | "stderr" | "interactive_session" | "tool_execution" | "imagegen";
  data: string;
};

export type BrowserCommandRequest = {
  commandId: string;
  operation: string;
  argsJson: string;
};

export type BrowserCommandResponse = {
  commandId: string;
  resultJson?: string;
  error?: string;
};

export type TerminalCommandRequest = {
  commandId: string;
  operation: string;
  argsJson: string;
};

export type TerminalCommandResponse = {
  commandId: string;
  resultJson?: string;
  error?: string;
};

export type UserQuestionRequest = {
  questionId: string;
  interactionId: string;
  question: string;
  options: string[];
};

export type UserQuestionResponse = {
  questionId: string;
  resultJson?: string;
  error?: string;
};

export type McpServerConfigInput = {
  serverId: string;
  name: string;
  transportType: string;
  url: string;
  command: string;
  argsJson: string;
  envJson: string;
  headersJson: string;
  enabled: boolean;
  timeoutMs?: number;
  sortOrder: number;
  source: string;
};

export type McpServerConfigRecord = Omit<McpServerConfigInput, "timeoutMs"> & {
  id: string;
  timeoutMs: number | null;
  updatedAt: string;
};

export type ProjectMcpServerConfigRecord = Omit<
  McpServerConfigInput,
  "timeoutMs"
> & {
  timeoutMs: number | null;
  updatedAt: string;
};

export type McpApiHeader = {
  name: string;
  value: string;
};

/** 自定义 API MCP 测试请求（使用编辑中的草稿，无需保存）。 */
export type McpApiTestInput = {
  baseUrl: string;
  headersJson: string;
  specJson: string;
  endpointIndex: number;
  argumentsJson: string;
  timeoutMs?: number;
};

export type McpApiTestResult = {
  ok: boolean;
  error?: string | null;
  method: string;
  url: string;
  requestHeaders: McpApiHeader[];
  requestBody: string;
  status?: number | null;
  statusText: string;
  elapsedMs: number;
  responseHeaders: McpApiHeader[];
  contentType: string;
  body: string;
};
