import { ipcRenderer } from "electron";
import type {
  CustomCommandInput,
  CustomCommandRecord,
  CustomHeaderSchemeInput,
  CustomHeaderSchemeRecord,
  HookConfigInput,
  HookConfigRecord,
  HookExecuteInput,
  HookExecuteResult,
  HookScope,
  LspCommandProbeResult,
  LspInstallResult,
  LspServerConfigInput,
  LspServerConfigRecord,
  LspSessionStatus,
  McpServerConfigInput,
  McpServerConfigRecord,
  ProjectMcpServerConfigRecord,
  ProjectSensitiveCommandConfigInput,
  ProjectSensitiveCommandConfigRecord,
  ProjectStackDetection,
  SensitiveCommandConfigInput,
  SensitiveCommandConfigRecord,
  SensitiveCommandDecisionRecord,
  SubAgentConfigInput,
  SubAgentConfigRecord,
  SystemPromptItemInput,
  SystemPromptItemRecord,
} from "../types";

export const configApi = {
  listSystemPrompts: (): Promise<SystemPromptItemRecord[]> =>
    ipcRenderer.invoke("system-prompts:list"),
  upsertSystemPrompt: (item: SystemPromptItemInput): Promise<void> =>
    ipcRenderer.invoke("system-prompts:upsert", item),
  deleteSystemPrompt: (promptId: string): Promise<void> =>
    ipcRenderer.invoke("system-prompts:delete", promptId),
  importSnowCliSystemPromptConfig: (): Promise<SystemPromptItemRecord[]> =>
    ipcRenderer.invoke("system-prompts:import-snow-cli"),
  listCustomHeaderSchemes: (): Promise<CustomHeaderSchemeRecord[]> =>
    ipcRenderer.invoke("custom-header-schemes:list"),
  upsertCustomHeaderScheme: (
    item: CustomHeaderSchemeInput,
  ): Promise<CustomHeaderSchemeRecord[]> =>
    ipcRenderer.invoke("custom-header-schemes:upsert", item),
  deleteCustomHeaderScheme: (
    schemeId: string,
  ): Promise<CustomHeaderSchemeRecord[]> =>
    ipcRenderer.invoke("custom-header-schemes:delete", schemeId),
  importSnowCliCustomHeadersConfig: (): Promise<CustomHeaderSchemeRecord[]> =>
    ipcRenderer.invoke("custom-header-schemes:import-snow-cli"),
  listCustomCommands: (projectId?: string): Promise<CustomCommandRecord[]> =>
    ipcRenderer.invoke("custom-commands:list", projectId),
  upsertCustomCommand: (item: CustomCommandInput): Promise<void> =>
    ipcRenderer.invoke("custom-commands:upsert", item),
  deleteCustomCommand: (commandId: string): Promise<void> =>
    ipcRenderer.invoke("custom-commands:delete", commandId),
  listMcpServerConfigs: (): Promise<McpServerConfigRecord[]> =>
    ipcRenderer.invoke("mcp-server-configs:list"),
  upsertMcpServerConfig: (
    item: McpServerConfigInput,
  ): Promise<McpServerConfigRecord[]> =>
    ipcRenderer.invoke("mcp-server-configs:upsert", item),
  deleteMcpServerConfig: (serverId: string): Promise<McpServerConfigRecord[]> =>
    ipcRenderer.invoke("mcp-server-configs:delete", serverId),
  importSnowCliMcpConfig: (): Promise<McpServerConfigRecord[]> =>
    ipcRenderer.invoke("mcp-server-configs:import-snow-cli"),
  listLspServerConfigs: (): Promise<LspServerConfigRecord[]> =>
    ipcRenderer.invoke("lsp-server-configs:list"),
  upsertLspServerConfig: (
    item: LspServerConfigInput,
  ): Promise<LspServerConfigRecord[]> =>
    ipcRenderer.invoke("lsp-server-configs:upsert", item),
  deleteLspServerConfig: (lang: string): Promise<LspServerConfigRecord[]> =>
    ipcRenderer.invoke("lsp-server-configs:delete", lang),
  listProjectLspServerConfigs: (
    projectId: string,
  ): Promise<LspServerConfigRecord[]> =>
    ipcRenderer.invoke("project-lsp-server-configs:list", projectId),
  upsertProjectLspServerConfig: (
    projectId: string,
    item: LspServerConfigInput,
  ): Promise<LspServerConfigRecord[]> =>
    ipcRenderer.invoke("project-lsp-server-configs:upsert", projectId, item),
  deleteProjectLspServerConfig: (
    projectId: string,
    lang: string,
  ): Promise<LspServerConfigRecord[]> =>
    ipcRenderer.invoke("project-lsp-server-configs:delete", projectId, lang),
  /** 项目生效配置合并视图：全局记录 + 项目覆盖（同 lang 覆盖替换全局）。 */
  listEffectiveLspServerConfigs: (
    projectId?: string,
  ): Promise<LspServerConfigRecord[]> =>
    ipcRenderer.invoke("lsp-server-configs:effective:list", projectId),
  probeLspServerCommands: (
    projectId?: string,
  ): Promise<LspCommandProbeResult[]> =>
    ipcRenderer.invoke("lsp-server-configs:probe", projectId),
  /** 扫描项目根目录检测技术栈（纯文件系统，无副作用）。 */
  detectProjectStack: (projectRoot: string): Promise<ProjectStackDetection[]> =>
    ipcRenderer.invoke("lsp-project-stack:detect", projectRoot),
  /** 语言服务器会话运行时状态快照（不触发任何会话创建/回收，前端徽章轮询用）。
   *  传入 projectId 时只返回该项目根下的会话（徽章按当前项目过滤）。 */
  listLspSessionStatuses: (projectId?: string): Promise<LspSessionStatus[]> =>
    ipcRenderer.invoke("lsp-session-statuses:list", projectId),
  /** 手动启动（预热）指定项目和语言的 LSP 会话。 */
  startLspSession: (
    projectId: string,
    lang: string,
  ): Promise<LspSessionStatus> =>
    ipcRenderer.invoke("lsp-session:start", projectId, lang),
  /** 手动停止指定项目和语言的 LSP 会话（释放进程与内存）。 */
  stopLspSession: (projectId: string, lang: string): Promise<boolean> =>
    ipcRenderer.invoke("lsp-session:stop", projectId, lang),
  /** 手动重启指定项目和语言的 LSP 会话，可选清理持久化诊断缓存。 */
  restartLspSession: (
    projectId: string,
    lang: string,
    clearCache?: boolean,
  ): Promise<LspSessionStatus> =>
    ipcRenderer.invoke("lsp-session:restart", projectId, lang, clearCache),
  installLspServer: (
    lang: string,
    projectId?: string,
  ): Promise<LspInstallResult> =>
    ipcRenderer.invoke("lsp-server-configs:install", projectId, lang),
  listProjectMcpServerConfigs: (
    projectId: string,
  ): Promise<ProjectMcpServerConfigRecord[]> =>
    ipcRenderer.invoke("project-mcp-server-configs:list", projectId),
  upsertProjectMcpServerConfig: (
    projectId: string,
    item: McpServerConfigInput,
  ): Promise<ProjectMcpServerConfigRecord[]> =>
    ipcRenderer.invoke("project-mcp-server-configs:upsert", projectId, item),
  deleteProjectMcpServerConfig: (
    projectId: string,
    serverId: string,
  ): Promise<ProjectMcpServerConfigRecord[]> =>
    ipcRenderer.invoke(
      "project-mcp-server-configs:delete",
      projectId,
      serverId,
    ),
  listSubAgentConfigs: (projectId?: string): Promise<SubAgentConfigRecord[]> =>
    ipcRenderer.invoke("sub-agent-configs:list", projectId),
  getSubAgentConfig: (
    agentId: string,
    projectId?: string,
  ): Promise<SubAgentConfigRecord | null> =>
    ipcRenderer.invoke("sub-agent-configs:get", agentId, projectId),
  upsertSubAgentConfig: (
    projectId: string | undefined,
    item: SubAgentConfigInput,
  ): Promise<SubAgentConfigRecord[]> =>
    ipcRenderer.invoke("sub-agent-configs:upsert", projectId, item),
  deleteSubAgentConfig: (
    agentId: string,
    projectId?: string,
  ): Promise<SubAgentConfigRecord[]> =>
    ipcRenderer.invoke("sub-agent-configs:delete", agentId, projectId),
  listSensitiveCommandConfigs: (): Promise<SensitiveCommandConfigRecord[]> =>
    ipcRenderer.invoke("sensitive-command-configs:list"),
  upsertSensitiveCommandConfig: (
    item: SensitiveCommandConfigInput,
  ): Promise<SensitiveCommandConfigRecord[]> =>
    ipcRenderer.invoke("sensitive-command-configs:upsert", item),
  deleteSensitiveCommandConfig: (
    commandId: string,
  ): Promise<SensitiveCommandConfigRecord[]> =>
    ipcRenderer.invoke("sensitive-command-configs:delete", commandId),
  resetSensitiveCommandConfigs: (): Promise<SensitiveCommandConfigRecord[]> =>
    ipcRenderer.invoke("sensitive-command-configs:reset"),
  importSnowCliSensitiveCommandConfig: (): Promise<
    SensitiveCommandConfigRecord[]
  > => ipcRenderer.invoke("sensitive-command-configs:import-snow-cli"),
  listProjectSensitiveCommandConfigs: (
    projectId: string,
  ): Promise<ProjectSensitiveCommandConfigRecord[]> =>
    ipcRenderer.invoke("project-sensitive-command-configs:list", projectId),
  setProjectSensitiveCommandEnabled: (
    projectId: string,
    commandId: string,
    enabled: boolean,
  ): Promise<ProjectSensitiveCommandConfigRecord[]> =>
    ipcRenderer.invoke(
      "project-sensitive-command-configs:set-enabled",
      projectId,
      commandId,
      enabled,
    ),
  upsertProjectSensitiveCommandConfig: (
    projectId: string,
    item: ProjectSensitiveCommandConfigInput,
  ): Promise<ProjectSensitiveCommandConfigRecord[]> =>
    ipcRenderer.invoke(
      "project-sensitive-command-configs:upsert",
      projectId,
      item,
    ),
  deleteProjectSensitiveCommandConfig: (
    projectId: string,
    commandId: string,
  ): Promise<ProjectSensitiveCommandConfigRecord[]> =>
    ipcRenderer.invoke(
      "project-sensitive-command-configs:delete",
      projectId,
      commandId,
    ),
  checkSensitiveCommandMatch: (
    command: string,
    projectId?: string,
  ): Promise<
    Array<{
      commandId: string;
      pattern: string;
      description: string;
    }>
  > =>
    ipcRenderer.invoke(
      "sensitive-command-configs:check-match",
      command,
      projectId,
    ),
  /** 决策模型辅助：判定命中敏感规则的命令是否可直接放行（null = 未启用）。
   *  workingDirectory / description 是风险判定的上下文（执行目录、模型意图说明）。 */
  evaluateSensitiveCommandDecision: (
    command: string,
    projectId?: string,
    workingDirectory?: string,
    description?: string,
  ): Promise<SensitiveCommandDecisionRecord | null> =>
    ipcRenderer.invoke(
      "sensitive-command-configs:evaluate-decision",
      command,
      projectId,
      workingDirectory,
      description,
    ),
  listHookConfigs: (
    scope: HookScope,
    projectId?: string,
  ): Promise<HookConfigRecord[]> =>
    ipcRenderer.invoke("hook-configs:list", scope, projectId),
  upsertHookConfig: (item: HookConfigInput): Promise<void> =>
    ipcRenderer.invoke("hook-configs:upsert", item),
  deleteHookConfig: (
    hookType: string,
    scope: HookScope,
    projectId?: string,
  ): Promise<void> =>
    ipcRenderer.invoke("hook-configs:delete", hookType, scope, projectId),
  executeHooks: (input: HookExecuteInput): Promise<HookExecuteResult> =>
    ipcRenderer.invoke("hooks:execute", input),
};
