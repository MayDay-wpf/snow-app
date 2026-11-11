import { ipcRenderer, webFrame, type IpcRendererEvent } from "electron";
import type {
  ApiConfigExportFileResult,
  ApiConfigImportApplyResult,
  ApiConfigImportPickResult,
  ApiConfigInput,
  ApiConfigRecord,
  ApiModelsConfig,
  AppLogExportResult,
  AppLogPage,
  CodebaseSettingsInput,
  ConversationModesResult,
  ConversationRuntimeConfig,
  DailyUsageBreakdown,
  DetectedTerminal,
  ImportSnowCliApiConfigsResult,
  KeyboardShortcutsSettings,
  Model,
  ModelUsageBreakdown,
  OAuthLoginStart,
  OAuthLoginStatus,
  OAuthProviderInfo,
  OAuthQuotaSnapshot,
  PrivacyCustomRule,
  PrivacyRuleInfo,
  PrivacySettings,
  ProxyBrowserSettings,
  ResponsesApiRequest,
  ResponsesApiResult,
  ResponsesApiStreamChunk,
  ThemeBackgroundHistoryEntry,
  ThemeSettings,
  UsageRecordPage,
  UsageSummary,
} from "../types";

const CHAT_CREATE_RESPONSE_CHUNK_CHANNEL = "chat:create-response:chunk";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const createResponseStreamId = (): string => `response-${crypto.randomUUID()}`;

const createThemePaletteStreamId = (): string =>
  `theme-palette-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const normalizeResponseStreamChunk = (
  value: unknown,
): ResponsesApiStreamChunk | null => {
  if (!isRecord(value)) {
    return null;
  }

  return {
    contentDelta:
      typeof value.contentDelta === "string" ? value.contentDelta : "",
    thinkingDelta:
      typeof value.thinkingDelta === "string" ? value.thinkingDelta : "",
    content: typeof value.content === "string" ? value.content : "",
    thinking: typeof value.thinking === "string" ? value.thinking : "",
    retrying: typeof value.retrying === "boolean" ? value.retrying : false,
    retryAttempt:
      typeof value.retryAttempt === "number" ? value.retryAttempt : null,
    retryError: typeof value.retryError === "string" ? value.retryError : null,
    retryBackoffMs:
      typeof value.retryBackoffMs === "number" ? value.retryBackoffMs : null,
    streamTokenCount:
      typeof value.streamTokenCount === "number" ? value.streamTokenCount : 0,
    thinkingTokenCount:
      typeof value.thinkingTokenCount === "number"
        ? value.thinkingTokenCount
        : 0,
    thinkingDurationMs:
      typeof value.thinkingDurationMs === "number"
        ? value.thinkingDurationMs
        : 0,
    elapsedMs: typeof value.elapsedMs === "number" ? value.elapsedMs : 0,
    ttftMs: typeof value.ttftMs === "number" ? value.ttftMs : 0,
    visionStatus:
      typeof value.visionStatus === "string" ? value.visionStatus : undefined,
  };
};

// 全局单监听器 + streamId 注册表：每个在途流只登记自己的 handler，chunk 事件
// 按 streamId 直接分发。此前每条流各注册一个 ipcRenderer.on 监听器，同频道
// 的每个 chunk 会依次唤醒全部在途流的回调（N 路并行流 = 每 chunk N 次 JS 回调）。
const chatStreamChunkHandlers = new Map<
  string,
  (chunk: ResponsesApiStreamChunk) => void
>();

ipcRenderer.on(
  CHAT_CREATE_RESPONSE_CHUNK_CHANNEL,
  (_event: IpcRendererEvent, payload: unknown): void => {
    if (!isRecord(payload)) {
      return;
    }
    const streamId =
      typeof payload.streamId === "string" ? payload.streamId : "";
    const handler = streamId
      ? chatStreamChunkHandlers.get(streamId)
      : undefined;
    if (!handler) {
      return;
    }
    const chunk = normalizeResponseStreamChunk(payload.chunk);
    if (chunk) {
      handler(chunk);
    }
  },
);

export const apiConfigApi = {
  engineInfo: (): Promise<string> => ipcRenderer.invoke("native:engine-info"),
  getSystemSettingValue: (settingCode: string): Promise<string | null> =>
    ipcRenderer.invoke("settings:get-system-setting-value", settingCode),
  setSystemSetting: (
    settingName: string,
    settingCode: string,
    settingValue: string,
  ): Promise<void> =>
    ipcRenderer.invoke(
      "settings:set-system-setting",
      settingName,
      settingCode,
      settingValue,
    ),
  getYoloMode: (): Promise<boolean> =>
    ipcRenderer.invoke("settings:get-yolo-mode"),
  setYoloMode: (enabled: boolean): Promise<void> =>
    ipcRenderer.invoke("settings:set-yolo-mode", enabled),
  getLiteMode: (): Promise<boolean> =>
    ipcRenderer.invoke("settings:get-lite-mode"),
  setLiteMode: (enabled: boolean): Promise<void> =>
    ipcRenderer.invoke("settings:set-lite-mode", enabled),
  getAutoFormat: (): Promise<boolean> =>
    ipcRenderer.invoke("settings:get-auto-format"),
  setAutoFormat: (enabled: boolean): Promise<void> =>
    ipcRenderer.invoke("settings:set-auto-format", enabled),
  getToolCorrection: (): Promise<boolean> =>
    ipcRenderer.invoke("settings:get-tool-correction"),
  setToolCorrection: (enabled: boolean): Promise<void> =>
    ipcRenderer.invoke("settings:set-tool-correction", enabled),
  getContextFold: (): Promise<boolean> =>
    ipcRenderer.invoke("settings:get-context-fold"),
  setContextFold: (enabled: boolean): Promise<void> =>
    ipcRenderer.invoke("settings:set-context-fold", enabled),
  getConversationModes: (
    conversationId: string,
  ): Promise<ConversationModesResult> =>
    ipcRenderer.invoke("settings:get-conversation-modes", conversationId),
  setConversationModes: (
    conversationId: string,
    goalMode: boolean | null,
    worktreeMode: boolean | null,
    workflowMode: boolean | null,
    goalModeTokenBudget: number | null,
  ): Promise<void> =>
    ipcRenderer.invoke(
      "settings:set-conversation-modes",
      conversationId,
      goalMode,
      worktreeMode,
      workflowMode,
      goalModeTokenBudget,
    ),
  getConversationRuntimeConfig: (
    conversationId: string,
  ): Promise<ConversationRuntimeConfig> =>
    ipcRenderer.invoke(
      "settings:get-conversation-runtime-config",
      conversationId,
    ),
  setConversationRuntimeConfig: (
    conversationId: string,
    thinkingStrength: string | null,
    responsesFastMode: string | null,
  ): Promise<void> =>
    ipcRenderer.invoke(
      "settings:set-conversation-runtime-config",
      conversationId,
      thinkingStrength,
      responsesFastMode,
    ),
  setConversationRunStats: (
    conversationId: string,
    runInputTokens: number,
    runOutputTokens: number,
    runCacheCreationInputTokens: number,
    runCacheReadInputTokens: number,
    lastRunDurationMs: number,
    runTtftSumMs: number,
    runRequestCount: number,
  ): Promise<void> =>
    ipcRenderer.invoke(
      "settings:set-conversation-run-stats",
      conversationId,
      runInputTokens,
      runOutputTokens,
      runCacheCreationInputTokens,
      runCacheReadInputTokens,
      lastRunDurationMs,
      runTtftSumMs,
      runRequestCount,
    ),
  resetConversationRunStats: (conversationId: string): Promise<void> =>
    ipcRenderer.invoke("settings:reset-conversation-run-stats", conversationId),
  getRequestLogging: (): Promise<boolean> =>
    ipcRenderer.invoke("settings:get-request-logging"),
  setRequestLogging: (enabled: boolean): Promise<void> =>
    ipcRenderer.invoke("settings:set-request-logging", enabled),
  getRequestLoggingExpiry: (): Promise<number> =>
    ipcRenderer.invoke("settings:get-request-logging-expiry"),
  setRequestLoggingExpiry: (expiresAtMs: number): Promise<void> =>
    ipcRenderer.invoke("settings:set-request-logging-expiry", expiresAtMs),
  getPrivacySettings: (): Promise<PrivacySettings> =>
    ipcRenderer.invoke("settings:get-privacy-settings"),
  setPrivacySettings: (settings: PrivacySettings): Promise<void> =>
    ipcRenderer.invoke("settings:set-privacy-settings", settings),
  listPrivacyRules: (): Promise<PrivacyRuleInfo[]> =>
    ipcRenderer.invoke("settings:list-privacy-rules"),
  savePrivacyCustomRules: (content: string): Promise<PrivacyCustomRule[]> =>
    ipcRenderer.invoke("settings:save-privacy-custom-rules", content),
  previewPrivacyMask: (
    sample: string,
    disabledRules: string[],
    customRules: PrivacyCustomRule[],
  ): Promise<string> =>
    ipcRenderer.invoke(
      "settings:preview-privacy-mask",
      sample,
      disabledRules,
      customRules,
    ),
  getThemeSettings: (): Promise<ThemeSettings> =>
    ipcRenderer.invoke("settings:get-theme-settings"),
  setThemeSettings: (settings: ThemeSettings): Promise<void> =>
    ipcRenderer.invoke("settings:set-theme-settings", settings),
  selectThemeBackgroundImages: (dialogTitle?: string): Promise<string[]> =>
    ipcRenderer.invoke("theme:select-background-images", dialogTitle),
  listThemeBackgroundImages: (): Promise<ThemeBackgroundHistoryEntry[]> =>
    ipcRenderer.invoke("theme:list-background-images"),
  saveThemeBackgroundImage: (sourcePath: string): Promise<string> =>
    ipcRenderer.invoke("theme:save-background-image", sourcePath),
  deleteThemeBackgroundImage: (imagePath: string): Promise<void> =>
    ipcRenderer.invoke("theme:delete-background-image", imagePath),
  selectThemeStreamCursorSvg: (dialogTitle?: string): Promise<string | null> =>
    ipcRenderer.invoke("theme:select-stream-cursor-svg", dialogTitle),
  saveThemeStreamCursorSvg: (sourcePath: string): Promise<string> =>
    ipcRenderer.invoke("theme:save-stream-cursor-svg", sourcePath),
  selectThemeStreamCursorImage: (
    dialogTitle?: string,
  ): Promise<string | null> =>
    ipcRenderer.invoke("theme:select-stream-cursor-image", dialogTitle),
  saveThemeStreamCursorImage: (sourcePath: string): Promise<string> =>
    ipcRenderer.invoke("theme:save-stream-cursor-image", sourcePath),
  selectThemeStreamCursorScript: (
    dialogTitle?: string,
  ): Promise<string | null> =>
    ipcRenderer.invoke("theme:select-stream-cursor-script", dialogTitle),
  saveThemeStreamCursorScript: (sourcePath: string): Promise<string> =>
    ipcRenderer.invoke("theme:save-stream-cursor-script", sourcePath),
  readThemeStreamCursorScript: (scriptPath: string): Promise<string> =>
    ipcRenderer.invoke("theme:read-stream-cursor-script", scriptPath),
  deleteThemeStreamCursorSvg: (svgPath: string): Promise<void> =>
    ipcRenderer.invoke("theme:delete-stream-cursor-svg", svgPath),
  saveThemeChatAvatar: (sourcePath: string): Promise<string> =>
    ipcRenderer.invoke("theme:save-chat-avatar", sourcePath),
  deleteThemeChatAvatar: (avatarPath: string): Promise<void> =>
    ipcRenderer.invoke("theme:delete-chat-avatar", avatarPath),
  /** 主题设置被 AI 侧改动（config 的 streamCursor 作用域）后由主进程广播。 */
  onThemeSettingsChanged: (callback: () => void): (() => void) => {
    const handler = (): void => {
      callback();
    };
    ipcRenderer.on("theme:settings-changed", handler);
    return () => {
      ipcRenderer.removeListener("theme:settings-changed", handler);
    };
  },
  setThemeBackgroundColor: (color: string): Promise<void> =>
    ipcRenderer.invoke("theme:set-background-color", color),
  setThemeTrafficLightY: (y: number): Promise<void> =>
    ipcRenderer.invoke("theme:set-traffic-light-y", y),
  /**
   * 界面字号缩放：对本渲染 frame 应用 webFrame zoom（等效界面缩放），
   * 同步生效；范围收敛到 Electron 支持的 0.25–5。
   */
  setUiZoomFactor: (factor: number): void => {
    if (!Number.isFinite(factor)) {
      return;
    }
    webFrame.setZoomFactor(Math.min(Math.max(factor, 0.25), 5));
  },
  listToolApprovalProjectApprovedTools: (
    projectId: string,
  ): Promise<string[]> =>
    ipcRenderer.invoke("permissions:list-tool-approvals", projectId),
  setToolApprovalProjectToolApproved: (
    projectId: string,
    toolName: string,
    approved: boolean,
  ): Promise<void> =>
    ipcRenderer.invoke(
      "permissions:set-tool-approval",
      projectId,
      toolName,
      approved,
    ),
  setToolApprovalProjectToolsApproved: (
    projectId: string,
    toolNames: string[],
    approved: boolean,
  ): Promise<void> =>
    ipcRenderer.invoke(
      "permissions:set-tool-approvals",
      projectId,
      toolNames,
      approved,
    ),
  getAlwaysApprovedTools: (): Promise<string[]> =>
    ipcRenderer.invoke("permissions:get-always-approved-tools"),
  setAlwaysApprovedTools: (tools: string[]): Promise<void> =>
    ipcRenderer.invoke("permissions:set-always-approved-tools", tools),
  listReadonlyTools: (): Promise<string[]> =>
    ipcRenderer.invoke("permissions:list-readonly-tools"),
  listToolReadonlyActions: (): Promise<Record<string, string[]>> =>
    ipcRenderer.invoke("permissions:list-tool-readonly-actions"),
  listApiConfigs: (): Promise<ApiConfigRecord[]> =>
    ipcRenderer.invoke("api-configs:list"),
  listOAuthProviders: (): Promise<OAuthProviderInfo[]> =>
    ipcRenderer.invoke("api-configs:oauth-providers"),
  startOAuthLogin: (
    provider: string,
    advancedModel?: string,
    basicModel?: string,
  ): Promise<OAuthLoginStart> =>
    ipcRenderer.invoke(
      "api-configs:oauth-start",
      provider,
      advancedModel,
      basicModel,
    ),
  getOAuthLoginStatus: (sessionId: string): Promise<OAuthLoginStatus | null> =>
    ipcRenderer.invoke("api-configs:oauth-status", sessionId),
  submitOAuthCallback: (
    sessionId: string,
    callbackUrl: string,
  ): Promise<OAuthLoginStatus> =>
    ipcRenderer.invoke("api-configs:oauth-callback", sessionId, callbackUrl),
  submitOAuthLoginTokens: (
    sessionId: string,
    tokens: Record<string, unknown>,
  ): Promise<OAuthLoginStatus> =>
    ipcRenderer.invoke("api-configs:oauth-submit-tokens", sessionId, tokens),
  cancelOAuthLogin: (sessionId: string): Promise<boolean> =>
    ipcRenderer.invoke("api-configs:oauth-cancel", sessionId),
  getOAuthQuota: (profileName: string): Promise<OAuthQuotaSnapshot> =>
    ipcRenderer.invoke("api-configs:oauth-quota", profileName),
  getRetryDefaults: (): Promise<string> =>
    ipcRenderer.invoke("api-configs:retry-defaults"),
  upsertApiConfig: (config: ApiConfigInput): Promise<ApiConfigRecord[]> =>
    ipcRenderer.invoke("api-configs:upsert", config),
  deleteApiConfig: (profileName: string): Promise<ApiConfigRecord[]> =>
    ipcRenderer.invoke("api-configs:delete", profileName),
  reorderApiConfigs: (
    orderedProfileNames: string[],
  ): Promise<ApiConfigRecord[]> =>
    ipcRenderer.invoke("api-configs:reorder", orderedProfileNames),
  fetchAvailableModels: (): Promise<Model[]> =>
    ipcRenderer.invoke("api-models:fetch"),
  fetchAvailableModelsForConfig: (config: ApiModelsConfig): Promise<Model[]> =>
    ipcRenderer.invoke("api-models:fetch-for-config", config),
  createResponseStream: (
    request: ResponsesApiRequest,
    onChunk?: (chunk: ResponsesApiStreamChunk) => void,
    onStreamId?: (streamId: string) => void,
  ): Promise<ResponsesApiResult> => {
    const streamId = createResponseStreamId();
    onStreamId?.(streamId);
    if (onChunk) {
      chatStreamChunkHandlers.set(streamId, onChunk);
    }

    return ipcRenderer
      .invoke("chat:create-response-stream", request, streamId)
      .finally(() => {
        chatStreamChunkHandlers.delete(streamId);
      });
  },
  abortResponseStream: (streamId: string): Promise<boolean> =>
    ipcRenderer.invoke("chat:abort-response-stream", streamId),
  releaseModelRequest: (streamId: string): Promise<void> =>
    ipcRenderer.invoke("mcp:release-model-request", streamId),
  importSnowCliApiConfigs: (): Promise<ImportSnowCliApiConfigsResult> =>
    ipcRenderer.invoke("api-configs:import-snow-cli"),
  /** 导出选中的 API 配置为迁移 JSON 文件（含明文密钥），返回保存结果。 */
  exportApiConfigsFile: (
    profileNames: string[],
  ): Promise<ApiConfigExportFileResult> =>
    ipcRenderer.invoke("api-configs:export-file", profileNames),
  /** 弹出文件选择框并解析导入文件，返回预览（不写库）。 */
  pickApiConfigImportFile: (): Promise<ApiConfigImportPickResult> =>
    ipcRenderer.invoke("api-configs:pick-import-file"),
  /** 按同名冲突策略执行导入，返回导入结果与最新配置列表。 */
  importApiConfigsFile: (
    filePath: string,
    conflictStrategy: "overwrite" | "duplicate",
  ): Promise<ApiConfigImportApplyResult> =>
    ipcRenderer.invoke("api-configs:import-file", filePath, conflictStrategy),
  importSnowCliProxyConfig: (): Promise<ProxyBrowserSettings> =>
    ipcRenderer.invoke("proxy-browser-settings:import-snow-cli"),
  applyProxySettings: (): Promise<void> =>
    ipcRenderer.invoke("proxy-browser-settings:apply"),
  importSnowCliCodebaseSettings: (): Promise<CodebaseSettingsInput> =>
    ipcRenderer.invoke("codebase-settings:import-snow-cli"),
  selectBrowserExecutable: (dialogTitle?: string): Promise<string | null> =>
    ipcRenderer.invoke(
      "proxy-browser-settings:select-browser-executable",
      dialogTitle,
    ),
  detectTerminals: (): Promise<DetectedTerminal[]> =>
    ipcRenderer.invoke("terminal:detect-terminals"),
  validateTerminalShellPath: (
    shellPath: string,
  ): Promise<{ valid: boolean; reason?: string }> =>
    ipcRenderer.invoke("terminal-settings:validate-shell-path", shellPath),
  selectTerminalExecutable: (dialogTitle?: string): Promise<string | null> =>
    ipcRenderer.invoke("terminal-settings:select-executable", dialogTitle),
  generateThemePalette: (
    imagePath: string,
    profileName: string,
    onChunk?: (chunk: ResponsesApiStreamChunk) => void,
    onStreamId?: (streamId: string) => void,
  ): Promise<ResponsesApiResult> => {
    const streamId = createThemePaletteStreamId();
    onStreamId?.(streamId);

    const handleChunk = (_event: IpcRendererEvent, payload: unknown): void => {
      if (!isRecord(payload) || payload.streamId !== streamId) {
        return;
      }

      const chunk = normalizeResponseStreamChunk(payload.chunk);
      if (chunk) {
        onChunk?.(chunk);
      }
    };

    ipcRenderer.on("theme:generate-palette:chunk", handleChunk);

    return ipcRenderer
      .invoke("theme:generate-palette", imagePath, profileName, streamId)
      .finally(() => {
        ipcRenderer.removeListener("theme:generate-palette:chunk", handleChunk);
      });
  },
  abortThemePalette: (streamId: string): Promise<boolean> =>
    ipcRenderer.invoke("chat:abort-response-stream", streamId),
  listUsageRecords: (
    conversationId: string,
    directoryId: string,
    profileName: string,
    limit: number,
    offset: number,
  ): Promise<UsageRecordPage> =>
    ipcRenderer.invoke(
      "usage:list-records",
      conversationId,
      directoryId,
      profileName,
      limit,
      offset,
    ),
  getUsageSummary: (
    since: string,
    until: string,
    profileName: string,
  ): Promise<UsageSummary> =>
    ipcRenderer.invoke("usage:get-summary", since, until, profileName),
  getUsageDailyBreakdown: (
    since: string,
    until: string,
    profileName: string,
  ): Promise<DailyUsageBreakdown[]> =>
    ipcRenderer.invoke("usage:get-daily-breakdown", since, until, profileName),
  getUsageModelBreakdown: (
    since: string,
    until: string,
    profileName: string,
  ): Promise<ModelUsageBreakdown[]> =>
    ipcRenderer.invoke("usage:get-model-breakdown", since, until, profileName),
  /** 用量记录中出现过的 API 配置名称，供配置筛选下拉框使用。 */
  listUsageProfileNames: (): Promise<string[]> =>
    ipcRenderer.invoke("usage:list-profile-names"),
  /** 按日期范围删除用量记录（空字符串跳过对应边界），返回删除条数。 */
  deleteUsageRecords: (since: string, until: string): Promise<number> =>
    ipcRenderer.invoke("usage:delete-records", since, until),
  listAppLogs: (
    level: string,
    module: string,
    since: string,
    until: string,
    limit: number,
    offset: number,
  ): Promise<AppLogPage> =>
    ipcRenderer.invoke("logs:list", level, module, since, until, limit, offset),
  clearAppLogs: (): Promise<number> => ipcRenderer.invoke("logs:clear"),
  /** 系统日志里出现过的模块名（去重排序），供按模块筛选。 */
  listAppLogModules: (): Promise<string[]> =>
    ipcRenderer.invoke("logs:list-modules"),
  getAppLogsRetentionDays: (): Promise<number> =>
    ipcRenderer.invoke("settings:get-app-logs-retention-days"),
  setAppLogsRetentionDays: (days: number): Promise<void> =>
    ipcRenderer.invoke("settings:set-app-logs-retention-days", days),
  pruneAppLogs: (): Promise<number> => ipcRenderer.invoke("logs:prune"),
  /** 导出系统日志文件（自定义选择时传 ids；groupByDay 按天拆分到所选目录）。 */
  exportAppLogs: (
    level: string,
    module: string,
    since: string,
    until: string,
    ids: string[],
    format: "text" | "json",
    groupByDay: boolean,
  ): Promise<AppLogExportResult> =>
    ipcRenderer.invoke(
      "logs:export",
      level,
      module,
      since,
      until,
      ids,
      format,
      groupByDay,
    ),

  getKeyboardShortcutsSettings: (): Promise<KeyboardShortcutsSettings> =>
    ipcRenderer.invoke("settings:get-keyboard-shortcuts"),
  setKeyboardShortcutsSettings: (
    settings: KeyboardShortcutsSettings,
  ): Promise<void> =>
    ipcRenderer.invoke("settings:set-keyboard-shortcuts", settings),

  /** 把参考图路径解析为 data URL（绝对磁盘路径或 upload/ 相对路径，如 imagegen 参考图缩略图），失败返回 null */
  resolveUploadImage: (relativePath: string): Promise<string | null> =>
    ipcRenderer.invoke("images:resolve-upload-image", relativePath),
};
