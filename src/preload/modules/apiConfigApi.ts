import { ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  ApiConfigInput,
  ApiConfigRecord,
  ApiModelsConfig,
  AppLogPage,
  CodebaseSettingsInput,
  ConversationModesResult,
  DailyUsageBreakdown,
  DetectedTerminal,
  ImportSnowCliApiConfigsResult,
  KeyboardShortcutsSettings,
  Model,
  PrivacySettings,
  ProxyBrowserSettings,
  ResponsesApiRequest,
  ResponsesApiResult,
  ResponsesApiStreamChunk,
  ThemeSettings,
  UsageRecordPage,
  UsageSummary,
} from "../types";

const CHAT_CREATE_RESPONSE_CHUNK_CHANNEL = "chat:create-response:chunk";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const createResponseStreamId = (): string =>
  `response-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const createThemePaletteStreamId = (): string =>
  `theme-palette-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const normalizeResponseStreamChunk = (
  value: unknown
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
    streamTokenCount:
      typeof value.streamTokenCount === "number" ? value.streamTokenCount : 0,
    elapsedMs: typeof value.elapsedMs === "number" ? value.elapsedMs : 0,
    ttftMs: typeof value.ttftMs === "number" ? value.ttftMs : 0,
    visionStatus:
      typeof value.visionStatus === "string" ? value.visionStatus : undefined,
  };
};

export const apiConfigApi = {
  engineInfo: (): Promise<string> => ipcRenderer.invoke("native:engine-info"),
  getSystemSettingValue: (settingCode: string): Promise<string | null> =>
    ipcRenderer.invoke("settings:get-system-setting-value", settingCode),
  setSystemSetting: (
    settingName: string,
    settingCode: string,
    settingValue: string
  ): Promise<void> =>
    ipcRenderer.invoke(
      "settings:set-system-setting",
      settingName,
      settingCode,
      settingValue
    ),
  getYoloMode: (): Promise<boolean> =>
    ipcRenderer.invoke("settings:get-yolo-mode"),
  setYoloMode: (enabled: boolean): Promise<void> =>
    ipcRenderer.invoke("settings:set-yolo-mode", enabled),
  getConversationModes: (conversationId: string): Promise<ConversationModesResult> =>
    ipcRenderer.invoke("settings:get-conversation-modes", conversationId),
  setConversationModes: (
    conversationId: string,
    planMode: boolean | null,
    goalMode: boolean | null,
    goalModeTokenBudget: number | null
  ): Promise<void> =>
    ipcRenderer.invoke(
      "settings:set-conversation-modes",
      conversationId,
      planMode,
      goalMode,
      goalModeTokenBudget
    ),
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
  getThemeSettings: (): Promise<ThemeSettings> =>
    ipcRenderer.invoke("settings:get-theme-settings"),
  setThemeSettings: (settings: ThemeSettings): Promise<void> =>
    ipcRenderer.invoke("settings:set-theme-settings", settings),
  selectThemeBackgroundImage: (dialogTitle?: string): Promise<string | null> =>
    ipcRenderer.invoke("theme:select-background-image", dialogTitle),
  saveThemeBackgroundImage: (sourcePath: string): Promise<string> =>
    ipcRenderer.invoke("theme:save-background-image", sourcePath),
  deleteThemeBackgroundImage: (imagePath: string): Promise<void> =>
    ipcRenderer.invoke("theme:delete-background-image", imagePath),
  selectThemeStreamCursorSvg: (dialogTitle?: string): Promise<string | null> =>
    ipcRenderer.invoke("theme:select-stream-cursor-svg", dialogTitle),
  saveThemeStreamCursorSvg: (sourcePath: string): Promise<string> =>
    ipcRenderer.invoke("theme:save-stream-cursor-svg", sourcePath),
  deleteThemeStreamCursorSvg: (svgPath: string): Promise<void> =>
    ipcRenderer.invoke("theme:delete-stream-cursor-svg", svgPath),
  setThemeBackgroundColor: (color: string): Promise<void> =>
    ipcRenderer.invoke("theme:set-background-color", color),
  listToolApprovalProjectApprovedTools: (
    projectId: string
  ): Promise<string[]> =>
    ipcRenderer.invoke("permissions:list-tool-approvals", projectId),
  setToolApprovalProjectToolApproved: (
    projectId: string,
    toolName: string,
    approved: boolean
  ): Promise<void> =>
    ipcRenderer.invoke(
      "permissions:set-tool-approval",
      projectId,
      toolName,
      approved
    ),
  listApiConfigs: (): Promise<ApiConfigRecord[]> =>
    ipcRenderer.invoke("api-configs:list"),
  upsertApiConfig: (config: ApiConfigInput): Promise<ApiConfigRecord[]> =>
    ipcRenderer.invoke("api-configs:upsert", config),
  deleteApiConfig: (profileName: string): Promise<ApiConfigRecord[]> =>
    ipcRenderer.invoke("api-configs:delete", profileName),
  fetchAvailableModels: (): Promise<Model[]> =>
    ipcRenderer.invoke("api-models:fetch"),
  fetchAvailableModelsForConfig: (config: ApiModelsConfig): Promise<Model[]> =>
    ipcRenderer.invoke("api-models:fetch-for-config", config),
  createResponseStream: (
    request: ResponsesApiRequest,
    onChunk?: (chunk: ResponsesApiStreamChunk) => void,
    onStreamId?: (streamId: string) => void
  ): Promise<ResponsesApiResult> => {
    const streamId = createResponseStreamId();
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

    ipcRenderer.on(CHAT_CREATE_RESPONSE_CHUNK_CHANNEL, handleChunk);

    return ipcRenderer
      .invoke("chat:create-response-stream", request, streamId)
      .finally(() => {
        ipcRenderer.removeListener(
          CHAT_CREATE_RESPONSE_CHUNK_CHANNEL,
          handleChunk
        );
      });
  },
  abortResponseStream: (streamId: string): Promise<boolean> =>
    ipcRenderer.invoke("chat:abort-response-stream", streamId),
  importSnowCliApiConfigs: (): Promise<ImportSnowCliApiConfigsResult> =>
    ipcRenderer.invoke("api-configs:import-snow-cli"),
  importSnowCliProxyConfig: (): Promise<ProxyBrowserSettings> =>
    ipcRenderer.invoke("proxy-browser-settings:import-snow-cli"),
  applyProxySettings: (): Promise<void> =>
    ipcRenderer.invoke("proxy-browser-settings:apply"),
  importSnowCliCodebaseSettings: (): Promise<CodebaseSettingsInput> =>
    ipcRenderer.invoke("codebase-settings:import-snow-cli"),
  selectBrowserExecutable: (dialogTitle?: string): Promise<string | null> =>
    ipcRenderer.invoke(
      "proxy-browser-settings:select-browser-executable",
      dialogTitle
    ),
  detectTerminals: (): Promise<DetectedTerminal[]> =>
    ipcRenderer.invoke("terminal:detect-terminals"),
  validateTerminalShellPath: (shellPath: string): Promise<{ valid: boolean; reason?: string }> =>
    ipcRenderer.invoke("terminal-settings:validate-shell-path", shellPath),
  selectTerminalExecutable: (dialogTitle?: string): Promise<string | null> =>
    ipcRenderer.invoke("terminal-settings:select-executable", dialogTitle),
  generateThemePalette: (
    imagePath: string,
    profileName: string,
    onChunk?: (chunk: ResponsesApiStreamChunk) => void,
    onStreamId?: (streamId: string) => void
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
    limit: number,
    offset: number
  ): Promise<UsageRecordPage> =>
    ipcRenderer.invoke(
      "usage:list-records",
      conversationId,
      directoryId,
      limit,
      offset
    ),
  getUsageSummary: (since: string, until: string): Promise<UsageSummary> =>
    ipcRenderer.invoke("usage:get-summary", since, until),
  getUsageDailyBreakdown: (
    since: string,
    until: string
  ): Promise<DailyUsageBreakdown[]> =>
    ipcRenderer.invoke("usage:get-daily-breakdown", since, until),
  listAppLogs: (
    level: string,
    module: string,
    since: string,
    until: string,
    limit: number,
    offset: number
  ): Promise<AppLogPage> =>
    ipcRenderer.invoke("logs:list", level, module, since, until, limit, offset),
  clearAppLogs: (): Promise<number> => ipcRenderer.invoke("logs:clear"),

  getKeyboardShortcutsSettings: (): Promise<KeyboardShortcutsSettings> =>
    ipcRenderer.invoke("settings:get-keyboard-shortcuts"),
  setKeyboardShortcutsSettings: (
    settings: KeyboardShortcutsSettings
  ): Promise<void> =>
    ipcRenderer.invoke("settings:set-keyboard-shortcuts", settings),

  /** 把参考图路径解析为 data URL（绝对磁盘路径或 upload/ 相对路径，如 imagegen 参考图缩略图），失败返回 null */
  resolveUploadImage: (relativePath: string): Promise<string | null> =>
    ipcRenderer.invoke("images:resolve-upload-image", relativePath),
};
