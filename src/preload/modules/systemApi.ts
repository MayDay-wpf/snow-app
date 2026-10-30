import { ipcRenderer, type IpcRendererEvent } from "electron";
import { join } from "node:path";
import type {
  DetachedPanelPayload,
  DetachedPanelRuntimeMirror,
  DetachedPanelTabPayload,
} from "../../shared/detachedPanel";
import {
  DETACHED_PANEL_RUNTIME_MIRROR_BROADCAST_CHANNEL,
  DETACHED_PANEL_CLOSE_REQUESTED_CHANNEL,
  DETACHED_PANEL_CONVERSATION_ACTIVATE_BROADCAST_CHANNEL,
  DETACHED_PANEL_CONVERSATION_LIST_BROADCAST_CHANNEL,
  DETACHED_PANEL_CONVERSATION_OWNERS_BROADCAST_CHANNEL,
} from "../../shared/detachedPanel";
import { callMcpTool } from "./mcpToolStream";
import {
  isNotificationConversationTarget,
  type AppNotificationOptions,
  type NotificationConversationTarget,
} from "../../shared/notification";
import type {
  BrowserCommandRequest,
  BrowserCommandResponse,
  BrowserFrameOperationArgs,
  CheckpointFileChange,
  CheckpointFileDiff,
  CodebaseEmbedFailure,
  CodebaseEmbedProgress,
  CodebaseIndexedFilePage,
  CodebaseIndexStats,
  CodebaseProjectScopeSettings,
  CodebaseScanPreview,
  CodebaseSphereLayout,
  CodebaseSyncProgress,
  CodebaseSyncResult,
  McpApiTestInput,
  McpApiTestResult,
  McpProjectServerStatus,
  McpProjectToolStatus,
  McpToolDefinition,
  McpToolStatus,
  OpenBrowserTabInMainPayload,
  GithubSkillRecord,
  ProjectSkillDefinition,
  ReplyPredictionRequest,
  ReplyPredictionResult,
  ResumableCodebaseSession,
  SkillBatchInstallResult,
  SkillDefinition,
  SkillUninstallResult,
  SubAgentUnavailableTool,
  TerminalCommandRequest,
  TerminalCommandResponse,
  ToolCorrectionRequest,
  ToolCorrectionResponse,
  UpdateStatus,
  UserQuestionRequest,
  UserQuestionResponse,
} from "../types";

const BROWSER_COMMAND_CHANNEL = "browser:command";
const BROWSER_COMMAND_RESPONSE_CHANNEL = "browser:command-response";
const BROWSER_OPEN_TAB_CHANNEL = "browser:open-tab";
// 渲染端请求在主窗口右侧面板新建浏览器 tab：窗口 → 主进程 → 主窗口（broadcast）。
const BROWSER_OPEN_TAB_IN_MAIN_CHANNEL = "browser:open-tab-in-main";
const BROWSER_OPEN_TAB_IN_MAIN_BROADCAST_CHANNEL =
  "browser:open-tab-in-main-broadcast";
// 独立面板窗口「移回主窗口」：主进程转发 tab 快照给主窗口（broadcast）。
const DETACHED_PANEL_RETURN_BROADCAST_CHANNEL =
  "detached-panel:return-broadcast";
// 独立浏览器窗口确认元素选择后转发到主窗口聊天输入框。
const ELEMENT_TAG_FORWARD_CHANNEL = "element-tag:forward";
const ELEMENT_TAG_INSERT_CHANNEL = "element-tag:insert";
// 独立浏览器窗口「发送给 Agent」的文本片段转发到主窗口聊天输入框。
const CHAT_TEXT_FORWARD_CHANNEL = "chat-text:forward";
const CHAT_TEXT_INSERT_CHANNEL = "chat-text:insert";
// 独立浏览器窗口点击「浏览器设置」后经主进程转发到主窗口（Sidebar 打开设置）。
const APP_CONTROL_OPEN_SETTINGS_FORWARD_CHANNEL =
  "app-control:open-settings-forward";
const APP_CONTROL_OPEN_SETTINGS_BROADCAST_CHANNEL =
  "app-control:open-settings-broadcast";
// 独立浏览器窗口请求打开主窗口的项目 MCP 弹窗（窗口 → 主进程 → 主窗口）。
const PROJECT_MCP_OPEN_FORWARD_CHANNEL = "project-mcp:open-panel-forward";
const PROJECT_MCP_OPEN_BROADCAST_CHANNEL = "project-mcp:open-panel-broadcast";
// 面板 MCP 门禁横幅「不再提示」的应用级状态（主进程内存，广播到所有窗口）。
const PANEL_MCP_HINT_GET_CHANNEL = "panel-mcp:get-hint-suppressed";
const PANEL_MCP_HINT_SET_CHANNEL = "panel-mcp:set-hint-suppressed";
const PANEL_MCP_HINT_CHANGED_CHANNEL = "panel-mcp:hint-suppressed-changed";
const TERMINAL_COMMAND_CHANNEL = "terminal:command";
const TERMINAL_COMMAND_RESPONSE_CHANNEL = "terminal:command-response";
const USER_QUESTION_CHANNEL = "user-question:request";
const USER_QUESTION_RESPONSE_CHANNEL = "user-question:response";
const APP_CONTROL_CHANNEL = "app-control:request";
const APP_CONTROL_RESPONSE_CHANNEL = "app-control:response";
const CODEBASE_EMBED_PROGRESS_CHANNEL = "codebase:embed:progress";
const NOTIFICATION_ACTIVATED_CHANNEL = "notification:activated";
const MAX_BUFFERED_NOTIFICATION_ACTIVATIONS = 50;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type NotificationActivationSubscriber = (
  target: NotificationConversationTarget,
) => void;

const notificationActivationSubscribers =
  new Set<NotificationActivationSubscriber>();
const notificationActivationBuffer: NotificationConversationTarget[] = [];

const deliverNotificationActivation = (
  subscriber: NotificationActivationSubscriber,
  target: NotificationConversationTarget,
): void => {
  try {
    subscriber(target);
  } catch (error) {
    console.error("[notification] Activation subscriber failed", error);
  }
};

ipcRenderer.on(
  NOTIFICATION_ACTIVATED_CHANNEL,
  (_event: IpcRendererEvent, target: unknown): void => {
    if (!isNotificationConversationTarget(target)) {
      return;
    }

    if (notificationActivationSubscribers.size === 0) {
      if (
        notificationActivationBuffer.length >=
        MAX_BUFFERED_NOTIFICATION_ACTIVATIONS
      ) {
        notificationActivationBuffer.shift();
      }
      notificationActivationBuffer.push(target);
      return;
    }

    for (const subscriber of notificationActivationSubscribers) {
      deliverNotificationActivation(subscriber, target);
    }
  },
);

/**
 * 侧边浏览器内新建标签页事件（broadcast 模型）。
 *
 * 主进程在 webview guest 的 window.open / target=_blank 被判定为「标签页级
 * 打开」（非窗口级弹出）时发送。payload 携带发起请求的 guest webContents id，
 * 由渲染端 BrowserPanelContent 依据该 id 路由到对应的浏览器实例。
 */
export type BrowserOpenTabEvent = {
  guestWebContentsId: number;
  url: string;
  /** Electron WindowOpenDisposition，如 foreground-tab / background-tab */
  disposition: string;
};

type BrowserOpenTabSubscriber = (event: BrowserOpenTabEvent) => void;

const browserOpenTabSubscribers = new Set<BrowserOpenTabSubscriber>();

const deliverBrowserOpenTab = (
  subscriber: BrowserOpenTabSubscriber,
  event: BrowserOpenTabEvent,
): void => {
  try {
    subscriber(event);
  } catch (error) {
    console.error("[browser] Open-tab subscriber failed", error);
  }
};

ipcRenderer.on(
  BROWSER_OPEN_TAB_CHANNEL,
  (_event: IpcRendererEvent, payload: unknown): void => {
    if (
      !isRecord(payload) ||
      typeof payload.guestWebContentsId !== "number" ||
      typeof payload.url !== "string"
    ) {
      return;
    }
    const event: BrowserOpenTabEvent = {
      guestWebContentsId: payload.guestWebContentsId,
      url: payload.url,
      disposition:
        typeof payload.disposition === "string"
          ? payload.disposition
          : "foreground-tab",
    };
    for (const subscriber of browserOpenTabSubscribers) {
      deliverBrowserOpenTab(subscriber, event);
    }
  },
);

// ===== 浏览器下载事件（broadcast 到宿主窗口）=====

export type BrowserDownloadItemEvent = {
  id: number;
  url: string;
  filename: string;
  path: string;
  state: "progressing" | "completed" | "cancelled" | "interrupted";
  receivedBytes: number;
  totalBytes: number;
  startedAt: number;
  endedAt: number | null;
  gmRequestId: number;
};

type BrowserDownloadSubscriber = (items: BrowserDownloadItemEvent[]) => void;

const downloadSubscribers = new Set<BrowserDownloadSubscriber>();

// ===== 浏览器书签（收藏夹）=====

export type BrowserBookmark = {
  id: string;
  title: string;
  url: string;
  folder: string;
  createdAt: number;
};

/** 内置浏览器访问历史条目（时间戳单位：毫秒）。 */
export type BrowserHistoryEntry = {
  id: string;
  url: string;
  title: string;
  visitCount: number;
  createdAt: number;
  lastVisitAt: number;
};

/** 访问历史分页结果（total 为命中查询的全部条目数）。 */
export type BrowserHistoryPage = {
  items: BrowserHistoryEntry[];
  total: number;
};

type BrowserBookmarksChangedSubscriber = () => void;

const browserBookmarksSubscribers =
  new Set<BrowserBookmarksChangedSubscriber>();

ipcRenderer.on("browser:bookmarks-updated", () => {
  for (const subscriber of browserBookmarksSubscribers) {
    try {
      subscriber();
    } catch (error) {
      console.error("[browser] Bookmarks subscriber failed", error);
    }
  }
});

ipcRenderer.on(
  "browser:downloads-updated",
  (_event: IpcRendererEvent, items: unknown): void => {
    if (!Array.isArray(items)) {
      return;
    }
    const list: BrowserDownloadItemEvent[] = items
      .filter(isRecord)
      .map((raw) => ({
        id: typeof raw.id === "number" ? raw.id : 0,
        url: typeof raw.url === "string" ? raw.url : "",
        filename: typeof raw.filename === "string" ? raw.filename : "",
        path: typeof raw.path === "string" ? raw.path : "",
        state:
          raw.state === "completed" ||
          raw.state === "cancelled" ||
          raw.state === "interrupted"
            ? raw.state
            : "progressing",
        receivedBytes:
          typeof raw.receivedBytes === "number" ? raw.receivedBytes : 0,
        totalBytes: typeof raw.totalBytes === "number" ? raw.totalBytes : 0,
        startedAt: typeof raw.startedAt === "number" ? raw.startedAt : 0,
        endedAt: typeof raw.endedAt === "number" ? raw.endedAt : null,
        gmRequestId: typeof raw.gmRequestId === "number" ? raw.gmRequestId : 0,
      }));
    for (const subscriber of downloadSubscribers) {
      try {
        subscriber(list);
      } catch (error) {
        console.error("[browser] Download subscriber failed", error);
      }
    }
  },
);

type OpenBrowserTabInMainSubscriber = (
  payload: OpenBrowserTabInMainPayload,
) => void;

const openBrowserTabInMainSubscribers =
  new Set<OpenBrowserTabInMainSubscriber>();

// 主进程转发独立浏览器窗口内 guest 页面的「打开新标签页」请求（仅发送到主窗口）。
ipcRenderer.on(
  BROWSER_OPEN_TAB_IN_MAIN_BROADCAST_CHANNEL,
  (_event: IpcRendererEvent, payload: unknown): void => {
    if (!isRecord(payload) || typeof payload.url !== "string") {
      return;
    }
    const request: OpenBrowserTabInMainPayload = { url: payload.url };
    for (const subscriber of openBrowserTabInMainSubscribers) {
      try {
        subscriber(request);
      } catch (error) {
        console.error("[browser] Open-tab-in-main subscriber failed", error);
      }
    }
  },
);

/** 浏览器元素选择结果（与渲染端 ElementTag 同构，preload 独立定义避免跨端 import）。 */
export type ElementTagPayload = {
  url: string;
  tag: string;
  label: string;
  text: string;
  note: string;
  domTree: string;
};

type ElementTagInsertSubscriber = (tag: ElementTagPayload) => void;

const elementTagInsertSubscribers = new Set<ElementTagInsertSubscriber>();

const isElementTagPayload = (value: unknown): value is ElementTagPayload => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.url === "string" &&
    typeof value.tag === "string" &&
    typeof value.label === "string" &&
    typeof value.text === "string" &&
    typeof value.note === "string" &&
    typeof value.domTree === "string"
  );
};

const deliverElementTagInsert = (
  subscriber: ElementTagInsertSubscriber,
  tag: ElementTagPayload,
): void => {
  try {
    subscriber(tag);
  } catch (error) {
    console.error("[element-tag] Insert subscriber failed", error);
  }
};

// 主进程转发独立浏览器窗口确认的元素选择结果。
ipcRenderer.on(
  ELEMENT_TAG_INSERT_CHANNEL,
  (_event: IpcRendererEvent, payload: unknown): void => {
    if (!isElementTagPayload(payload)) {
      return;
    }
    for (const subscriber of elementTagInsertSubscribers) {
      deliverElementTagInsert(subscriber, payload);
    }
  },
);

export type ChatTextPayload = {
  text: string;
  source?: string;
};

/** 自建右键菜单可执行的编辑命令（由主进程 WebContents 真实执行）。 */
export type SnowEditCommand = "cut" | "copy" | "paste" | "selectAll";

type ChatTextInsertSubscriber = (payload: ChatTextPayload) => void;

const chatTextInsertSubscribers = new Set<ChatTextInsertSubscriber>();

const isChatTextPayload = (value: unknown): value is ChatTextPayload => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.text === "string" &&
    (value.source === undefined || typeof value.source === "string")
  );
};

const deliverChatTextInsert = (
  subscriber: ChatTextInsertSubscriber,
  payload: ChatTextPayload,
): void => {
  try {
    subscriber(payload);
  } catch (error) {
    console.error("[chat-text] Insert subscriber failed", error);
  }
};

ipcRenderer.on(
  CHAT_TEXT_INSERT_CHANNEL,
  (_event: IpcRendererEvent, payload: unknown): void => {
    if (!isChatTextPayload(payload)) {
      return;
    }
    for (const subscriber of chatTextInsertSubscribers) {
      deliverChatTextInsert(subscriber, payload);
    }
  },
);

/** 主窗口打开设置的请求（view 为目标设置视图 id，如 browser-settings）。 */
type OpenSettingsRequestSubscriber = (view: string) => void;
const openSettingsRequestSubscribers = new Set<OpenSettingsRequestSubscriber>();

const deliverOpenSettingsRequest = (
  subscriber: OpenSettingsRequestSubscriber,
  view: string,
): void => {
  try {
    subscriber(view);
  } catch (error) {
    console.error("[app-control] Open settings subscriber failed", error);
  }
};

// 主进程转发独立浏览器窗口的「打开设置」请求。
ipcRenderer.on(
  APP_CONTROL_OPEN_SETTINGS_BROADCAST_CHANNEL,
  (_event: IpcRendererEvent, view: unknown): void => {
    if (typeof view !== "string" || !view.trim()) {
      return;
    }
    for (const subscriber of openSettingsRequestSubscribers) {
      deliverOpenSettingsRequest(subscriber, view);
    }
  },
);

type OpenProjectMcpRequestSubscriber = (serverId: string) => void;
const openProjectMcpRequestSubscribers =
  new Set<OpenProjectMcpRequestSubscriber>();

type PanelMcpHintSubscriber = (suppressed: boolean) => void;
const panelMcpHintSubscribers = new Set<PanelMcpHintSubscriber>();

ipcRenderer.on(
  PANEL_MCP_HINT_CHANGED_CHANNEL,
  (_event: IpcRendererEvent, suppressed: unknown): void => {
    if (typeof suppressed !== "boolean") {
      return;
    }
    for (const subscriber of panelMcpHintSubscribers) {
      try {
        subscriber(suppressed);
      } catch (error) {
        console.error("[panel-mcp] Hint subscriber failed", error);
      }
    }
  },
);

ipcRenderer.on(
  PROJECT_MCP_OPEN_BROADCAST_CHANNEL,
  (_event: IpcRendererEvent, serverId: unknown): void => {
    if (typeof serverId !== "string") {
      return;
    }
    for (const subscriber of openProjectMcpRequestSubscribers) {
      try {
        subscriber(serverId);
      } catch (error) {
        console.error("[project-mcp] Open panel subscriber failed", error);
      }
    }
  },
);

// Codebase embed progress: broadcast model.
// The main process sends progress events with { sessionId, projectId, progress }.
// We maintain a Set of subscribers (one per active panel/hook instance) that
// each receive ALL embed progress events, filtered by projectId on the
// subscriber side. This decouples the listener from any specific session,
// so when the user switches projects and switches back, the new panel
// instance can still receive progress for the ongoing background embedding.
type EmbedProgressSubscriber = (
  progress: CodebaseEmbedProgress,
  projectId: string,
  sessionId: string,
) => void;

const codebaseEmbedProgressSubscribers = new Set<EmbedProgressSubscriber>();
let codebaseEmbedProgressListenerRegistered = false;

const ensureCodebaseEmbedProgressListener = (): void => {
  if (codebaseEmbedProgressListenerRegistered) {
    return;
  }
  codebaseEmbedProgressListenerRegistered = true;
  ipcRenderer.on(
    CODEBASE_EMBED_PROGRESS_CHANNEL,
    (_event, payload: unknown) => {
      if (!isRecord(payload)) {
        return;
      }
      const sessionId = payload.sessionId;
      if (typeof sessionId !== "string") {
        return;
      }
      const projectId =
        typeof payload.projectId === "string" ? payload.projectId : "";
      const progress = payload.progress;
      if (!isRecord(progress)) {
        return;
      }
      const normalized: CodebaseEmbedProgress = {
        phase: typeof progress.phase === "string" ? progress.phase : "",
        totalFiles:
          typeof progress.totalFiles === "number" ? progress.totalFiles : 0,
        processedFiles:
          typeof progress.processedFiles === "number"
            ? progress.processedFiles
            : 0,
        totalChunks:
          typeof progress.totalChunks === "number" ? progress.totalChunks : 0,
        processedChunks:
          typeof progress.processedChunks === "number"
            ? progress.processedChunks
            : 0,
        currentFile:
          typeof progress.currentFile === "string" ? progress.currentFile : "",
        error: typeof progress.error === "string" ? progress.error : "",
        elapsedMs:
          typeof progress.elapsedMs === "number" ? progress.elapsedMs : 0,
      };
      for (const subscriber of codebaseEmbedProgressSubscribers) {
        subscriber(normalized, projectId, sessionId);
      }
    },
  );
};

export const systemApi = {
  getCodebaseProjectScopeSettings: (
    projectId: string,
  ): Promise<CodebaseProjectScopeSettings> =>
    ipcRenderer.invoke("codebase:get-project-scope", projectId),
  setCodebaseProjectEnabled: (
    projectId: string,
    enabled: boolean,
  ): Promise<void> =>
    ipcRenderer.invoke("codebase:set-project-enabled", projectId, enabled),
  setCodebaseProjectAgentReview: (
    projectId: string,
    enabled: boolean,
  ): Promise<void> =>
    ipcRenderer.invoke("codebase:set-project-agent-review", projectId, enabled),
  setCodebaseProjectReranking: (
    projectId: string,
    enabled: boolean,
  ): Promise<void> =>
    ipcRenderer.invoke("codebase:set-project-reranking", projectId, enabled),
  checkProjectHasGitignore: (projectId: string): Promise<boolean> =>
    ipcRenderer.invoke("codebase:check-project-gitignore", projectId),
  checkProjectIsRemote: (projectId: string): Promise<boolean> =>
    ipcRenderer.invoke("codebase:check-project-remote", projectId),
  startCodebaseEmbedding: (
    projectId: string,
    sessionId: string,
  ): Promise<void> => {
    ensureCodebaseEmbedProgressListener();
    return ipcRenderer.invoke("codebase:start-embedding", projectId, sessionId);
  },
  pauseCodebaseEmbedding: (sessionId: string): Promise<boolean> =>
    ipcRenderer.invoke("codebase:pause-embedding", sessionId),
  resumeCodebaseEmbedding: (sessionId: string): Promise<boolean> =>
    ipcRenderer.invoke("codebase:resume-embedding", sessionId),
  cancelCodebaseEmbedding: (sessionId: string): Promise<boolean> =>
    ipcRenderer.invoke("codebase:cancel-embedding", sessionId),
  isCodebaseEmbeddingActive: (projectId: string): Promise<boolean> =>
    ipcRenderer.invoke("codebase:is-embedding-active", projectId),
  onCodebaseEmbedProgress: (
    callback: (
      progress: CodebaseEmbedProgress,
      projectId: string,
      sessionId: string,
    ) => void,
  ): (() => void) => {
    ensureCodebaseEmbedProgressListener();
    codebaseEmbedProgressSubscribers.add(callback);
    return () => {
      codebaseEmbedProgressSubscribers.delete(callback);
    };
  },
  getCodebaseIndexStats: (projectId: string): Promise<CodebaseIndexStats> =>
    ipcRenderer.invoke("codebase:get-index-stats", projectId),
  listCodebaseIndexedFiles: (
    projectId: string,
    page: number,
    pageSize: number,
  ): Promise<CodebaseIndexedFilePage> =>
    ipcRenderer.invoke(
      "codebase:list-indexed-files",
      projectId,
      page,
      pageSize,
    ),
  getCodebaseSphereLayout: (
    projectId: string,
    limit: number,
  ): Promise<CodebaseSphereLayout> =>
    ipcRenderer.invoke("codebase:get-sphere-layout", projectId, limit),
  clearCodebaseIndex: (projectId: string): Promise<void> =>
    ipcRenderer.invoke("codebase:clear-index", projectId),
  startCodebaseWatch: (projectId: string, projectPath: string): Promise<void> =>
    ipcRenderer.invoke("codebase:start-watch", projectId, projectPath),
  stopCodebaseWatch: (projectId: string): Promise<void> =>
    ipcRenderer.invoke("codebase:stop-watch", projectId),
  cancelCodebaseSync: (projectId: string): Promise<boolean> =>
    ipcRenderer.invoke("codebase:cancel-sync", projectId),
  syncCodebaseChanges: (
    projectId: string,
    onProgress?: (progress: CodebaseSyncProgress) => void,
  ): Promise<CodebaseSyncResult> => {
    if (onProgress) {
      const handler = (_event: IpcRendererEvent, payload: unknown) => {
        if (!isRecord(payload)) {
          return;
        }
        const progress = payload.progress;
        if (!isRecord(progress)) {
          return;
        }
        onProgress({
          phase: typeof progress.phase === "string" ? progress.phase : "",
          filesToEmbed:
            typeof progress.filesToEmbed === "number"
              ? progress.filesToEmbed
              : 0,
          processedFiles:
            typeof progress.processedFiles === "number"
              ? progress.processedFiles
              : 0,
          deletedFiles:
            typeof progress.deletedFiles === "number"
              ? progress.deletedFiles
              : 0,
          skippedFiles:
            typeof progress.skippedFiles === "number"
              ? progress.skippedFiles
              : 0,
          currentFile:
            typeof progress.currentFile === "string"
              ? progress.currentFile
              : "",
          error: typeof progress.error === "string" ? progress.error : "",
        });
      };
      ipcRenderer.on("codebase:sync:progress", handler);
      return ipcRenderer
        .invoke("codebase:sync-changes", projectId)
        .finally(() => {
          ipcRenderer.removeListener("codebase:sync:progress", handler);
        });
    }
    return ipcRenderer.invoke("codebase:sync-changes", projectId);
  },
  onCodebaseFilesChanged: (
    callback: (projectId: string) => void,
  ): (() => void) => {
    const handler = (_event: IpcRendererEvent, projectId: string): void => {
      callback(projectId);
    };

    ipcRenderer.on("codebase:files-changed", handler);

    return () => {
      ipcRenderer.removeListener("codebase:files-changed", handler);
    };
  },
  onCodebaseSyncProgress: (
    callback: (progress: CodebaseSyncProgress, projectId: string) => void,
  ): (() => void) => {
    const handler = (_event: IpcRendererEvent, payload: unknown): void => {
      if (!isRecord(payload)) {
        return;
      }
      const progress = payload.progress;
      if (!isRecord(progress)) {
        return;
      }
      const projectId =
        typeof payload.projectId === "string" ? payload.projectId : "";
      callback(
        {
          phase: typeof progress.phase === "string" ? progress.phase : "",
          filesToEmbed:
            typeof progress.filesToEmbed === "number"
              ? progress.filesToEmbed
              : 0,
          processedFiles:
            typeof progress.processedFiles === "number"
              ? progress.processedFiles
              : 0,
          deletedFiles:
            typeof progress.deletedFiles === "number"
              ? progress.deletedFiles
              : 0,
          skippedFiles:
            typeof progress.skippedFiles === "number"
              ? progress.skippedFiles
              : 0,
          currentFile:
            typeof progress.currentFile === "string"
              ? progress.currentFile
              : "",
          error: typeof progress.error === "string" ? progress.error : "",
        },
        projectId,
      );
    };

    ipcRenderer.on("codebase:sync:progress", handler);

    return () => {
      ipcRenderer.removeListener("codebase:sync:progress", handler);
    };
  },
  onCodebaseScopeChanged: (
    callback: (payload: {
      projectId: string;
      key: "enabled" | "enableAgentReview" | "enableReranking";
      enabled: boolean;
    }) => void,
  ): (() => void) => {
    const handler = (_event: IpcRendererEvent, payload: unknown): void => {
      if (!isRecord(payload)) {
        return;
      }
      const projectId = payload.projectId;
      const key = payload.key;
      const enabled = payload.enabled;
      if (
        typeof projectId !== "string" ||
        (key !== "enabled" &&
          key !== "enableAgentReview" &&
          key !== "enableReranking") ||
        typeof enabled !== "boolean"
      ) {
        return;
      }
      callback({ projectId, key, enabled });
    };

    ipcRenderer.on("codebase:scope-changed", handler);

    return () => {
      ipcRenderer.removeListener("codebase:scope-changed", handler);
    };
  },
  previewCodebaseScan: (projectId: string): Promise<CodebaseScanPreview> =>
    ipcRenderer.invoke("codebase:preview-scan", projectId),
  getResumableCodebaseSessions: (
    projectId: string,
  ): Promise<ResumableCodebaseSession[]> =>
    ipcRenderer.invoke("codebase:get-resumable-sessions", projectId),
  discardResumableCodebaseSession: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke("codebase:discard-resumable-session", sessionId),
  /** 项目最近一次失败的索引运行（下次索引开始前保留，重启后仍可回看）。 */
  getLastCodebaseEmbedFailure: (
    projectId: string,
  ): Promise<CodebaseEmbedFailure | null> =>
    ipcRenderer.invoke("codebase:get-last-embed-failure", projectId),
  listMcpTools: (): Promise<McpToolDefinition[]> =>
    ipcRenderer.invoke("mcp:list-tools"),
  correctToolCall: (
    request: ToolCorrectionRequest,
  ): Promise<ToolCorrectionResponse> =>
    ipcRenderer.invoke("mcp:correct-tool-call", request),
  predictReply: (
    request: ReplyPredictionRequest,
  ): Promise<ReplyPredictionResult> =>
    ipcRenderer.invoke("chat:predict-reply", request),
  abortReplyPrediction: (requestId: string): Promise<boolean> =>
    ipcRenderer.invoke("chat:abort-reply-prediction", requestId),
  listAvailableSkills: (projectId?: string): Promise<SkillDefinition[]> =>
    ipcRenderer.invoke("skills:list", projectId),
  setSkillEnabled: (
    projectId: string | undefined,
    skillId: string,
    enabled: boolean,
  ): Promise<void> =>
    ipcRenderer.invoke("skills:set-enabled", projectId, skillId, enabled),
  listProjectSkills: (projectId: string): Promise<ProjectSkillDefinition[]> =>
    ipcRenderer.invoke("skills:list-project", projectId),
  setProjectSkillEnabled: (
    projectId: string,
    skillId: string,
    enabled: boolean,
  ): Promise<void> =>
    ipcRenderer.invoke(
      "skills:set-project-enabled",
      projectId,
      skillId,
      enabled,
    ),
  installSkillFromGithub: (
    url: string,
    location: "global" | "project",
    projectId?: string,
  ): Promise<SkillBatchInstallResult> =>
    ipcRenderer.invoke("skills:install-github", url, location, projectId),
  uninstallGithubSkill: (
    skillId: string,
    projectId?: string,
  ): Promise<SkillUninstallResult> =>
    ipcRenderer.invoke("skills:uninstall-github", skillId, projectId),
  listGithubSkills: (): Promise<GithubSkillRecord[]> =>
    ipcRenderer.invoke("skills:list-github"),
  listMcpServerTools: (configServerId: string): Promise<McpToolStatus[]> =>
    ipcRenderer.invoke("mcp:list-server-tools", configServerId),
  /** 自定义 API MCP：按草稿发送测试请求。 */
  testMcpApiEndpoint: (input: McpApiTestInput): Promise<McpApiTestResult> =>
    ipcRenderer.invoke("mcp:test-api-endpoint", input),
  listMcpProjectServers: (
    projectId: string,
  ): Promise<McpProjectServerStatus[]> =>
    ipcRenderer.invoke("mcp:list-project-servers", projectId),
  /** 全局 MCP 服务器目录：不依赖项目，供全局子代理选择工具。 */
  listMcpGlobalServers: (): Promise<McpProjectServerStatus[]> =>
    ipcRenderer.invoke("mcp:list-global-servers"),
  /** 全局内置 MCP 服务器目录（不连接外部服务器）。 */
  listMcpGlobalBuiltinServers: (): Promise<McpProjectServerStatus[]> =>
    ipcRenderer.invoke("mcp:list-global-builtin-servers"),
  /** 诊断子代理白名单中当前不可用的工具（激活时回传主控并写入子代理提示词）。 */
  diagnoseSubAgentTools: (
    projectId: string | undefined,
    toolsJson: string,
  ): Promise<SubAgentUnavailableTool[]> =>
    ipcRenderer.invoke("mcp:diagnose-sub-agent-tools", projectId, toolsJson),
  /**
   * 项目 MCP 服务器快速列表：外部服务器工具只读 Rust 端进程内缓存，
   * 不连接服务器；`toolsPending` 为 true 的服务器需要后台补发现
   * （见 `listMcpProjectServerTools`）。保存 / 启停 / 删除配置后的刷新
   * 用它，避免被慢服务器的工具发现阻塞。
   */
  listMcpProjectServersCached: (
    projectId: string,
  ): Promise<McpProjectServerStatus[]> =>
    ipcRenderer.invoke("mcp:list-project-servers-cached", projectId),
  listMcpProjectServerTools: (
    projectId: string,
    serverId: string,
  ): Promise<McpProjectToolStatus[]> =>
    ipcRenderer.invoke("mcp:list-project-server-tools", projectId, serverId),
  setMcpProjectServerEnabled: (
    projectId: string,
    serverId: string,
    enabled: boolean,
  ): Promise<void> =>
    ipcRenderer.invoke(
      "mcp:set-project-server-enabled",
      projectId,
      serverId,
      enabled,
    ),
  setMcpProjectToolEnabled: (
    projectId: string,
    toolName: string,
    enabled: boolean,
  ): Promise<void> =>
    ipcRenderer.invoke(
      "mcp:set-project-tool-enabled",
      projectId,
      toolName,
      enabled,
    ),
  /**
   * 订阅「侧边浏览器内新建标签页」请求。返回取消订阅函数。
   * 渲染端每个 BrowserPanelContent 实例在挂载时订阅，按 guestWebContentsId
   * 判断事件是否属于自己的某个 webview，是则在实例内部新建标签页。
   */
  onBrowserOpenTab: (
    callback: (event: BrowserOpenTabEvent) => void,
  ): (() => void) => {
    browserOpenTabSubscribers.add(callback);
    return () => {
      browserOpenTabSubscribers.delete(callback);
    };
  },
  /** 订阅浏览器下载列表变化（全量快照推送）。 */
  onDownloadsUpdated: (
    callback: (items: BrowserDownloadItemEvent[]) => void,
  ): (() => void) => {
    downloadSubscribers.add(callback);
    return () => {
      downloadSubscribers.delete(callback);
    };
  },
  listBrowserDownloads: (): Promise<BrowserDownloadItemEvent[]> =>
    ipcRenderer.invoke("browser:downloads-list"),
  openBrowserDownload: (id: number): Promise<boolean> =>
    ipcRenderer.invoke("browser:download-open", id),
  showBrowserDownloadInFolder: (id: number): Promise<boolean> =>
    ipcRenderer.invoke("browser:download-show-in-folder", id),
  cancelBrowserDownload: (id: number): Promise<boolean> =>
    ipcRenderer.invoke("browser:download-cancel", id),
  /**
   * 将元素选择结果转发给主窗口聊天输入框（独立浏览器窗口专用：
   * 该窗口内没有 ChatInputView，INSERT_ELEMENT_TAG_EVENT 事件无法跨
   * 渲染进程到达主窗口，须经主进程转发）。
   */
  forwardElementTagToChat: (tag: ElementTagPayload): void => {
    ipcRenderer.send(ELEMENT_TAG_FORWARD_CHANNEL, tag);
  },
  /**
   * 订阅主进程转发过来的元素选择结果（主窗口 ChatInputView 使用），
   * 插入为 element chip。返回取消订阅函数。
   */
  onElementTagInserted: (
    callback: (tag: ElementTagPayload) => void,
  ): (() => void) => {
    elementTagInsertSubscribers.add(callback);
    return () => {
      elementTagInsertSubscribers.delete(callback);
    };
  },
  /**
   * 将文本片段（页面正文 / 控制台日志 / 网络请求）转发给主窗口聊天输入框
   * （独立浏览器窗口专用，同 forwardElementTagToChat 的跨进程转发思路）。
   */
  forwardTextToChat: (payload: ChatTextPayload): void => {
    ipcRenderer.send(CHAT_TEXT_FORWARD_CHANNEL, payload);
  },
  /** 订阅主进程转发过来的文本片段（主窗口 ChatInputView 使用）。 */
  onChatTextInserted: (
    callback: (payload: ChatTextPayload) => void,
  ): (() => void) => {
    chatTextInsertSubscribers.add(callback);
    return () => {
      chatTextInsertSubscribers.delete(callback);
    };
  },
  /**
   * 请求主窗口打开设置面板（独立浏览器窗口专用：该窗口内没有 Sidebar，
   * APP_CONTROL_OPEN_SETTINGS_EVENT 事件无法跨渲染进程到达主窗口，
   * 须经主进程转发并聚焦主窗口）。
   */
  forwardOpenSettingsToMain: (view: string): void => {
    ipcRenderer.send(APP_CONTROL_OPEN_SETTINGS_FORWARD_CHANNEL, view);
  },
  /**
   * 订阅主进程转发过来的「打开设置」请求（主窗口 Sidebar 使用）。
   * 返回取消订阅函数。
   */
  onOpenSettingsRequest: (callback: (view: string) => void): (() => void) => {
    openSettingsRequestSubscribers.add(callback);
    return () => {
      openSettingsRequestSubscribers.delete(callback);
    };
  },
  /**
   * 请求主窗口打开项目 MCP 弹窗（独立浏览器窗口专用：该窗口没有聊天
   * 输入区，事件无法跨渲染进程到达主窗口，须经主进程转发并聚焦主窗口）。
   * serverId 为需要在弹窗中单独展示的服务器（空串表示展示全部）。
   */
  forwardOpenProjectMcpToMain: (serverId: string): void => {
    ipcRenderer.send(PROJECT_MCP_OPEN_FORWARD_CHANNEL, serverId);
  },
  /**
   * 订阅主进程转发过来的「打开项目 MCP 弹窗」请求（主窗口使用）。
   * 返回取消订阅函数。
   */
  onOpenProjectMcpRequest: (
    callback: (serverId: string) => void,
  ): (() => void) => {
    openProjectMcpRequestSubscribers.add(callback);
    return () => {
      openProjectMcpRequestSubscribers.delete(callback);
    };
  },
  /**
   * 面板 MCP 门禁横幅「不再提示」的应用级状态（主进程内存，重启后恢复
   * 提示；所有窗口共享）。
   */
  getPanelMcpHintSuppressed: (): Promise<boolean> =>
    ipcRenderer.invoke(PANEL_MCP_HINT_GET_CHANNEL),
  setPanelMcpHintSuppressed: (suppressed: boolean): void => {
    ipcRenderer.send(PANEL_MCP_HINT_SET_CHANNEL, suppressed);
  },
  /**
   * 订阅「不再提示」状态变更（主进程广播到所有窗口）。返回取消订阅函数。
   */
  onPanelMcpHintSuppressedChanged: (
    callback: (suppressed: boolean) => void,
  ): (() => void) => {
    panelMcpHintSubscribers.add(callback);
    return () => {
      panelMcpHintSubscribers.delete(callback);
    };
  },
  setMcpToolEnabled: (toolName: string, enabled: boolean): Promise<void> =>
    ipcRenderer.invoke("mcp:set-tool-enabled", toolName, enabled),
  /** 全局启停内置 MCP 服务器（serverId 形如 builtin:browser）。 */
  setMcpGlobalServerEnabled: (
    serverId: string,
    enabled: boolean,
  ): Promise<void> =>
    ipcRenderer.invoke("mcp:set-global-server-enabled", serverId, enabled),
  setMcpToolsEnabled: (toolNames: string[], enabled: boolean): Promise<void> =>
    ipcRenderer.invoke("mcp:set-tools-enabled", toolNames, enabled),
  setMcpProjectToolsEnabled: (
    projectId: string,
    toolNames: string[],
    enabled: boolean,
  ): Promise<void> =>
    ipcRenderer.invoke(
      "mcp:set-project-tools-enabled",
      projectId,
      toolNames,
      enabled,
    ),
  registerBrowserCommandHandler: (
    handler: (request: BrowserCommandRequest) => Promise<string>,
  ): (() => void) => {
    const listener = (
      _event: IpcRendererEvent,
      request: BrowserCommandRequest,
    ): void => {
      if (
        !request ||
        typeof request.commandId !== "string" ||
        typeof request.operation !== "string" ||
        typeof request.argsJson !== "string"
      ) {
        return;
      }

      void handler(request)
        .then((resultJson) => {
          const response: BrowserCommandResponse = {
            commandId: request.commandId,
            resultJson,
          };
          ipcRenderer.send(BROWSER_COMMAND_RESPONSE_CHANNEL, response);
        })
        .catch((error: unknown) => {
          const response: BrowserCommandResponse = {
            commandId: request.commandId,
            error: error instanceof Error ? error.message : String(error),
          };
          ipcRenderer.send(BROWSER_COMMAND_RESPONSE_CHANNEL, response);
        });
    };

    ipcRenderer.on(BROWSER_COMMAND_CHANNEL, listener);
    void ipcRenderer.invoke("browser:renderer-register");
    return () => {
      ipcRenderer.removeListener(BROWSER_COMMAND_CHANNEL, listener);
      void ipcRenderer.invoke("browser:renderer-unregister");
    };
  },
  /**
   * 渲染端请求在主窗口右侧面板新建浏览器 tab（如设置页历史记录）：经主进程转发给主窗口，
   * 由 RightPanel 新建浏览器 tab。
   */
  openBrowserTabInMainWindow: (payload: OpenBrowserTabInMainPayload): void => {
    ipcRenderer.send(BROWSER_OPEN_TAB_IN_MAIN_CHANNEL, payload);
  },
  /**
   * 订阅主进程转发过来的「打开新浏览器 tab」请求（主窗口 RightPanel
   * 使用）。返回取消订阅函数。
   */
  onOpenBrowserTabInMain: (
    callback: (payload: OpenBrowserTabInMainPayload) => void,
  ): (() => void) => {
    openBrowserTabInMainSubscribers.add(callback);
    return () => {
      openBrowserTabInMainSubscribers.delete(callback);
    };
  },
  /** 上报 MCP 浏览器实例归属（供主进程按 instanceId 路由命令）。 */
  notifyBrowserInstanceRegistered: (instanceId: string): void => {
    ipcRenderer.send("browser:instance-registered", instanceId);
  },
  notifyBrowserInstanceUnregistered: (instanceId: string): void => {
    ipcRenderer.send("browser:instance-unregistered", instanceId);
  },
  /**
   * 右侧面板 tab「在新窗口中打开」：主进程创建独立面板窗口承载该 tab，
   * 终端会话随之交接保留。返回后由调用方从源面板移除该 tab。
   */
  openDetachedPanelWindow: (payload: DetachedPanelPayload): Promise<void> =>
    ipcRenderer.invoke("detached-panel:open", payload),
  /** 独立面板窗口渲染后凭 token 取回初始化 payload。 */
  takeDetachedPanelPayload: (
    token: string,
  ): Promise<DetachedPanelPayload | null> =>
    ipcRenderer.invoke("detached-panel:take", token),
  /**
   * 独立面板窗口 tab「移回主窗口」：主进程转发给主窗口恢复为 tab。
   * 返回 false 表示主窗口不可用，调用方应保留源窗口中的 tab。
   */
  returnDetachedPanelTab: (tab: DetachedPanelTabPayload): Promise<boolean> =>
    ipcRenderer.invoke("detached-panel:return", tab),
  /** 订阅移回主窗口的 tab（主窗口 RightPanel 使用）。返回取消订阅函数。 */
  onDetachedPanelReturn: (
    callback: (tab: DetachedPanelTabPayload) => void,
  ): (() => void) => {
    const handler = (
      _event: IpcRendererEvent,
      tab: DetachedPanelTabPayload,
    ): void => {
      callback(tab);
    };
    ipcRenderer.on(DETACHED_PANEL_RETURN_BROADCAST_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(
        DETACHED_PANEL_RETURN_BROADCAST_CHANNEL,
        handler,
      );
    };
  },
  /**
   * 主窗口的运行时快照镜像（不含 panels）变化时调用：主进程缓存并转发给所有独立面板窗口。
   * 仅主窗口有效，独立窗口调用会被主进程忽略。
   */
  publishDetachedRuntimeMirror: (
    mirror: DetachedPanelRuntimeMirror,
  ): Promise<void> =>
    ipcRenderer.invoke("detached-panel:runtime-mirror-publish", mirror),
  /** 独立面板窗口挂载时取回最近一份运行时快照镜像（尚未发布过则为 null）。 */
  takeDetachedRuntimeMirror: (): Promise<DetachedPanelRuntimeMirror | null> =>
    ipcRenderer.invoke("detached-panel:runtime-mirror-take"),
  /** 订阅运行时快照镜像广播（独立面板窗口使用）。返回取消订阅函数。 */
  onDetachedRuntimeMirror: (
    callback: (mirror: DetachedPanelRuntimeMirror) => void,
  ): (() => void) => {
    const handler = (
      _event: IpcRendererEvent,
      mirror: DetachedPanelRuntimeMirror,
    ): void => {
      callback(mirror);
    };
    ipcRenderer.on(DETACHED_PANEL_RUNTIME_MIRROR_BROADCAST_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(
        DETACHED_PANEL_RUNTIME_MIRROR_BROADCAST_CHANNEL,
        handler,
      );
    };
  },
  /** 独立面板窗口上报其归属会话 id（会话 tab 与运行中的会话）。 */
  reportDetachedConversations: (conversationIds: string[]): Promise<void> =>
    ipcRenderer.invoke("detached-panel:report-conversations", conversationIds),
  /** 主窗口点击已归属会话时调用：聚焦所在独立窗口。返回 false 表示无归属窗口。 */
  focusDetachedConversation: (conversationId: string): Promise<boolean> =>
    ipcRenderer.invoke("detached-panel:focus-conversation", conversationId),
  /** 快捷键循环聚焦独立会话窗口。返回 false 表示当前没有独立窗口。 */
  focusNextDetachedPanelWindow: (): Promise<boolean> =>
    ipcRenderer.invoke("detached-panel:focus-next"),
  /** 主窗口挂载时取回当前归属的会话 id。 */
  takeDetachedConversationOwners: (): Promise<string[]> =>
    ipcRenderer.invoke("detached-panel:conversation-owners-take"),
  /** 订阅归属会话变化（主窗口使用）。返回取消订阅函数。 */
  onDetachedConversationOwnersChanged: (
    callback: (conversationIds: string[]) => void,
  ): (() => void) => {
    const handler = (_event: IpcRendererEvent, ids: string[]): void => {
      callback(ids);
    };
    ipcRenderer.on(
      DETACHED_PANEL_CONVERSATION_OWNERS_BROADCAST_CHANNEL,
      handler,
    );
    return () => {
      ipcRenderer.removeListener(
        DETACHED_PANEL_CONVERSATION_OWNERS_BROADCAST_CHANNEL,
        handler,
      );
    };
  },
  /** 订阅会话激活请求（独立面板窗口使用）。返回取消订阅函数。 */
  onDetachedConversationActivate: (
    callback: (conversationId: string) => void,
  ): (() => void) => {
    const handler = (
      _event: IpcRendererEvent,
      conversationId: string,
    ): void => {
      callback(conversationId);
    };
    ipcRenderer.on(
      DETACHED_PANEL_CONVERSATION_ACTIVATE_BROADCAST_CHANNEL,
      handler,
    );
    return () => {
      ipcRenderer.removeListener(
        DETACHED_PANEL_CONVERSATION_ACTIVATE_BROADCAST_CHANNEL,
        handler,
      );
    };
  },
  /** 订阅独立面板窗口的关闭请求（独立窗口使用，用于弹出二次确认）。返回取消订阅函数。 */
  onDetachedPanelCloseRequested: (callback: () => void): (() => void) => {
    const handler = (): void => {
      callback();
    };
    ipcRenderer.on(DETACHED_PANEL_CLOSE_REQUESTED_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(
        DETACHED_PANEL_CLOSE_REQUESTED_CHANNEL,
        handler,
      );
    };
  },
  /** 独立面板窗口用户确认关闭（或无需确认时）调用：主进程真正关闭该窗口。 */
  confirmDetachedPanelClose: (): Promise<void> =>
    ipcRenderer.invoke("detached-panel:confirm-close"),
  /** 独立面板窗口的会话列表 / 树形数据变化时调用：主进程通知主窗口重新拉取。 */
  notifyDetachedConversationListChanged: (): Promise<void> =>
    ipcRenderer.invoke("detached-panel:conversation-list-changed"),
  /** 订阅独立窗口会话列表变化（主窗口使用）。返回取消订阅函数。 */
  onDetachedConversationListChanged: (callback: () => void): (() => void) => {
    const handler = (): void => {
      callback();
    };
    ipcRenderer.on(DETACHED_PANEL_CONVERSATION_LIST_BROADCAST_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(
        DETACHED_PANEL_CONVERSATION_LIST_BROADCAST_CHANNEL,
        handler,
      );
    };
  },
  /** 终端 tab 挂载/卸载时上报归属（MCP 终端命令据此路由到持有者）。 */
  notifyTerminalTabRegistered: (tabId: string): void => {
    ipcRenderer.send("terminal:tab-registered", tabId);
  },
  notifyTerminalTabUnregistered: (tabId: string): void => {
    ipcRenderer.send("terminal:tab-unregistered", tabId);
  },
  registerTerminalCommandHandler: (
    handler: (request: TerminalCommandRequest) => Promise<string>,
  ): (() => void) => {
    const listener = (
      _event: IpcRendererEvent,
      request: TerminalCommandRequest,
    ): void => {
      if (
        !request ||
        typeof request.commandId !== "string" ||
        typeof request.operation !== "string" ||
        typeof request.argsJson !== "string"
      ) {
        return;
      }

      void handler(request)
        .then((resultJson) => {
          const response: TerminalCommandResponse = {
            commandId: request.commandId,
            resultJson,
          };
          ipcRenderer.send(TERMINAL_COMMAND_RESPONSE_CHANNEL, response);
        })
        .catch((error: unknown) => {
          const response: TerminalCommandResponse = {
            commandId: request.commandId,
            error: error instanceof Error ? error.message : String(error),
          };
          ipcRenderer.send(TERMINAL_COMMAND_RESPONSE_CHANNEL, response);
        });
    };

    ipcRenderer.on(TERMINAL_COMMAND_CHANNEL, listener);
    void ipcRenderer.invoke("terminal:renderer-register");
    return () => {
      ipcRenderer.removeListener(TERMINAL_COMMAND_CHANNEL, listener);
      void ipcRenderer.invoke("terminal:renderer-unregister");
    };
  },
  registerUserQuestionHandler: (
    handler: (request: UserQuestionRequest) => Promise<string>,
  ): (() => void) => {
    const listener = (
      _event: IpcRendererEvent,
      request: UserQuestionRequest,
    ): void => {
      if (
        !request ||
        typeof request.questionId !== "string" ||
        typeof request.interactionId !== "string" ||
        typeof request.question !== "string" ||
        !Array.isArray(request.options) ||
        request.options.some((option) => typeof option !== "string")
      ) {
        return;
      }

      void handler(request)
        .then((resultJson) => {
          const response: UserQuestionResponse = {
            questionId: request.questionId,
            resultJson,
          };
          ipcRenderer.send(USER_QUESTION_RESPONSE_CHANNEL, response);
        })
        .catch((error: unknown) => {
          const response: UserQuestionResponse = {
            questionId: request.questionId,
            error: error instanceof Error ? error.message : String(error),
          };
          ipcRenderer.send(USER_QUESTION_RESPONSE_CHANNEL, response);
        });
    };

    ipcRenderer.on(USER_QUESTION_CHANNEL, listener);
    return () => {
      ipcRenderer.removeListener(USER_QUESTION_CHANNEL, listener);
    };
  },
  registerAppControlHandler: (
    handler: (request: {
      requestId: string;
      action: string;
      payloadJson: string;
    }) => Promise<string>,
  ): (() => void) => {
    const listener = (
      _event: IpcRendererEvent,
      request: { requestId: string; action: string; payloadJson: string },
    ): void => {
      if (
        !request ||
        typeof request.requestId !== "string" ||
        typeof request.action !== "string" ||
        typeof request.payloadJson !== "string"
      ) {
        return;
      }

      void handler(request)
        .then((resultJson) => {
          ipcRenderer.send(APP_CONTROL_RESPONSE_CHANNEL, {
            requestId: request.requestId,
            resultJson,
          });
        })
        .catch((error: unknown) => {
          ipcRenderer.send(APP_CONTROL_RESPONSE_CHANNEL, {
            requestId: request.requestId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    };

    ipcRenderer.on(APP_CONTROL_CHANNEL, listener);
    return () => {
      ipcRenderer.removeListener(APP_CONTROL_CHANNEL, listener);
    };
  },
  issueSensitiveCommandAuthorization: (command: string): Promise<string> =>
    ipcRenderer.invoke("mcp:authorize-sensitive-command", command),
  writeInteractiveStdin: (sessionId: string, input: string): Promise<void> =>
    ipcRenderer.invoke("mcp:write-interactive-stdin", sessionId, input),
  abortToolExecution: (
    toolExecutionId: string,
    reason?: string,
  ): Promise<boolean> =>
    ipcRenderer.invoke("mcp:abort-tool-execution", toolExecutionId, reason),
  callMcpTool,
  createCheckpoint: (workDir: string): Promise<string> =>
    ipcRenderer.invoke("checkpoint:create", workDir),
  restoreCheckpoint: (checkpointId: string, workDir: string): Promise<void> =>
    ipcRenderer.invoke("checkpoint:restore", checkpointId, workDir),
  restoreCheckpoints: (
    checkpointIds: string[],
    workDir: string,
  ): Promise<void> =>
    ipcRenderer.invoke("checkpoint:restore-batch", checkpointIds, workDir),
  deleteCheckpoint: (checkpointId: string): Promise<void> =>
    ipcRenderer.invoke("checkpoint:delete", checkpointId),
  listCheckpointChanges: (
    checkpointId: string,
    workDir: string,
  ): Promise<CheckpointFileChange[]> =>
    ipcRenderer.invoke("checkpoint:list-changes", checkpointId, workDir),
  listCheckpointChangesBatch: (
    checkpointIds: string[],
    workDir: string,
    includeAll?: boolean,
  ): Promise<CheckpointFileChange[]> =>
    ipcRenderer.invoke(
      "checkpoint:list-changes-batch",
      checkpointIds,
      workDir,
      includeAll ?? false,
    ),
  listCheckpointDiffs: (
    checkpointId: string,
    workDir: string,
    includeAll?: boolean,
  ): Promise<CheckpointFileDiff[]> =>
    ipcRenderer.invoke(
      "checkpoint:list-diffs",
      checkpointId,
      workDir,
      includeAll ?? false,
    ),
  listCheckpointDiffsBatch: (
    checkpointIds: string[],
    workDir: string,
    includeAll?: boolean,
  ): Promise<CheckpointFileDiff[]> =>
    ipcRenderer.invoke(
      "checkpoint:list-diffs-batch",
      checkpointIds,
      workDir,
      includeAll ?? false,
    ),
  writeLog: (level: string, entry: unknown): Promise<void> =>
    ipcRenderer.invoke("debug:write-log", level, entry),
  sum: (a: number, b: number): Promise<number> =>
    ipcRenderer.invoke("native:sum", a, b),
  showNotification: (options: AppNotificationOptions): Promise<void> =>
    ipcRenderer.invoke("notification:show", options),
  onNotificationActivated: (
    callback: (target: NotificationConversationTarget) => void,
  ): (() => void) => {
    notificationActivationSubscribers.add(callback);

    const bufferedTargets = notificationActivationBuffer.splice(0);
    for (const target of bufferedTargets) {
      deliverNotificationActivation(callback, target);
    }

    return () => {
      notificationActivationSubscribers.delete(callback);
    };
  },
  getAppVersion: (): Promise<string> => ipcRenderer.invoke("app:get-version"),
  downloadUpdate: (): Promise<UpdateStatus> =>
    ipcRenderer.invoke("updater:download-update"),
  installUpdate: (): Promise<void> =>
    ipcRenderer.invoke("updater:install-update"),
  getUpdateStatus: (): Promise<UpdateStatus> =>
    ipcRenderer.invoke("updater:get-status"),
  checkForUpdates: (): Promise<UpdateStatus> =>
    ipcRenderer.invoke("updater:check-for-updates"),
  onUpdateStatusChanged: (
    callback: (status: UpdateStatus) => void,
  ): (() => void) => {
    const handler = (_event: IpcRendererEvent, status: UpdateStatus): void => {
      callback(status);
    };

    ipcRenderer.on("updater:status-changed", handler);

    return () => {
      ipcRenderer.removeListener("updater:status-changed", handler);
    };
  },
};

export const ptyApi = {
  ptyCreate: (options: {
    cwd: string;
    cols: number;
    rows: number;
    shellPath?: string;
    sessionId?: string;
  }): Promise<string> => ipcRenderer.invoke("pty:create", options),
  ptyWrite: (id: string, data: string): Promise<void> =>
    ipcRenderer.invoke("pty:write", id, data),
  ptyResize: (id: string, cols: number, rows: number): Promise<void> =>
    ipcRenderer.invoke("pty:resize", id, cols, rows),
  ptyKill: (id: string): Promise<void> => ipcRenderer.invoke("pty:kill", id),
  /**
   * 接管已有会话（终端 tab 迁移到其他窗口后挂载）：转移输出通道与回收归属，
   * 返回 false 表示会话已不存在。
   */
  ptyAttach: (id: string): Promise<boolean> =>
    ipcRenderer.invoke("pty:attach", id),
  onPtyOutput: (
    callback: (data: { id: string; data: string }) => void,
  ): (() => void) => {
    const handler = (
      _event: IpcRendererEvent,
      payload: { id: string; data: string },
    ): void => {
      callback(payload);
    };

    ipcRenderer.on("pty:output", handler);

    return () => {
      ipcRenderer.removeListener("pty:output", handler);
    };
  },
  onPtyExit: (
    callback: (data: { id: string; exitCode: number }) => void,
  ): (() => void) => {
    const handler = (
      _event: IpcRendererEvent,
      payload: { id: string; exitCode: number },
    ): void => {
      callback(payload);
    };

    ipcRenderer.on("pty:exit", handler);

    return () => {
      ipcRenderer.removeListener("pty:exit", handler);
    };
  },
};

export const windowApi = {
  minimizeWindow: (): Promise<void> => ipcRenderer.invoke("window:minimize"),
  hideWindowToTray: (): Promise<void> =>
    ipcRenderer.invoke("window:hide-to-tray"),
  /** 快捷键设置变更后通知主进程重注册全局快捷键。 */
  reloadGlobalShortcut: (): Promise<void> =>
    ipcRenderer.invoke("shortcuts:reload-global"),
  onGlobalShortcutTriggered: (
    handler: (action: string) => void,
  ): (() => void) => {
    const listener = (_event: IpcRendererEvent, action: unknown): void => {
      if (typeof action === "string") {
        handler(action);
      }
    };
    ipcRenderer.on("shortcuts:global-triggered", listener);
    return () => {
      ipcRenderer.removeListener("shortcuts:global-triggered", listener);
    };
  },
  setTrayActiveSessions: (count: number): Promise<void> =>
    ipcRenderer.invoke("tray:set-active-sessions", count),
  toggleMaximizeWindow: (): Promise<void> =>
    ipcRenderer.invoke("window:maximize-toggle"),
  closeWindow: (): Promise<void> => ipcRenderer.invoke("window:close"),
  confirmCloseWindow: (): Promise<void> =>
    ipcRenderer.invoke("window:confirm-close"),
  isWindowMaximized: (): Promise<boolean> =>
    ipcRenderer.invoke("window:is-maximized"),
  /** 窗口置顶（图钉）：设置后返回主进程确认的最新置顶状态。 */
  setWindowAlwaysOnTop: (alwaysOnTop: boolean): Promise<boolean> =>
    ipcRenderer.invoke("window:set-always-on-top", alwaysOnTop),
  isWindowAlwaysOnTop: (): Promise<boolean> =>
    ipcRenderer.invoke("window:is-always-on-top"),
  /** 原生全屏（macOS 绿灯全屏）状态：全屏时系统隐藏红绿灯，顶栏改用 LOGO 填补。 */
  isWindowFullScreen: (): Promise<boolean> =>
    ipcRenderer.invoke("window:is-full-screen"),
  clearWindowState: (): Promise<void> =>
    ipcRenderer.invoke("window:clear-state"),
  /** 错误边界"重新加载"：由主进程强制刷新渲染进程（比 location.reload 可靠）。 */
  reloadWindow: (): Promise<void> => ipcRenderer.invoke("window:reload"),
  /** 开关当前窗口的开发者工具（独立窗口，发行版同样可用）。 */
  toggleDevTools: (): Promise<void> =>
    ipcRenderer.invoke("window:toggle-devtools"),
  startWindowDrag: (): Promise<void> => ipcRenderer.invoke("window:start-drag"),
  stopWindowDrag: (): Promise<void> => ipcRenderer.invoke("window:stop-drag"),
  writeImageToClipboard: (dataUrl: string): Promise<void> =>
    ipcRenderer.invoke("clipboard:write-image", dataUrl),
  readClipboardText: (): Promise<string> =>
    ipcRenderer.invoke("clipboard:read-text"),
  writeClipboardText: (text: string): Promise<void> =>
    ipcRenderer.invoke("clipboard:write-text", text),
  /** 剪贴板是否有可粘贴的内容（文本、图片或文件）：右键菜单「粘贴」的禁用依据。 */
  hasClipboardContent: (): Promise<boolean> =>
    ipcRenderer.invoke("clipboard:has-content"),
  /** 执行编辑命令（剪切/复制/粘贴/全选）：主进程派发真实编辑命令。 */
  runEditCommand: (command: SnowEditCommand): Promise<void> =>
    ipcRenderer.invoke("edit:command", command),
  /** 在系统文件管理器中显示指定路径（文件高亮选中，目录直接打开）。 */
  showItemInFolder: (path: string): Promise<void> =>
    ipcRenderer.invoke("shell:show-item-in-folder", path),
  /** 使用系统默认应用打开文件；失败返回错误信息，成功为 null。 */
  openPathWithSystemApp: (path: string): Promise<string | null> =>
    ipcRenderer.invoke("shell:open-path", path),
  clearBrowserCache: (): Promise<void> =>
    ipcRenderer.invoke("browser:clear-cache"),
  clearBrowserCookies: (): Promise<void> =>
    ipcRenderer.invoke("browser:clear-cookies"),
  openBrowserDevTools: (webContentsId: number): Promise<void> =>
    ipcRenderer.invoke("browser:open-devtools", webContentsId),
  browserNetworkRequests: (
    webContentsId: number,
    options?: {
      filter?: string;
      resourceTypes?: string[];
      /** 只返回这些 HTTP 方法（大小写不敏感），例如 ["OPTIONS"] 查看 CORS 预检。 */
      methods?: string[];
      includeStatic?: boolean;
      pageIdx?: number;
      pageSize?: number;
      includePreserved?: boolean;
    },
  ): Promise<{
    records: unknown[];
    total: number;
    pageIdx: number;
    pageSize: number;
    hasMore: boolean;
    archivedGenerations: number;
    source: "cdp" | "webrequest";
    preflightTotal: number;
  }> => ipcRenderer.invoke("browser:network-requests", webContentsId, options),
  /** 查询单条网络请求的完整详情（请求/响应头 + 请求/响应体；可配置 body 落盘）。 */
  browserNetworkDetails: (
    webContentsId: number,
    requestId: string,
    options?: {
      maxBodyBytes?: number;
      requestFilePath?: string;
      responseFilePath?: string;
    },
  ): Promise<unknown> =>
    ipcRenderer.invoke(
      "browser:network-details",
      webContentsId,
      requestId,
      options,
    ),
  /** 截图（CDP Page.captureScreenshot）：格式/质量/元素裁剪/整页/落盘。 */
  browserCaptureScreenshot: (
    webContentsId: number,
    request: {
      format?: "png" | "jpeg" | "webp";
      quality?: number;
      fullPage?: boolean;
      clip?: {
        x: number;
        y: number;
        width: number;
        height: number;
        scale?: number;
      };
      filePath?: string;
    },
  ): Promise<{
    mimeType: string;
    bytes: number;
    savedTo: string | null;
    data?: string;
  }> =>
    ipcRenderer.invoke("browser:capture-screenshot", webContentsId, request),
  /** 控制台记录（CDP Runtime/Log）：查询（分页/过滤/preserved）。 */
  browserConsoleRecords: (
    webContentsId: number,
    options?: {
      level?: number;
      types?: string[];
      pageIdx?: number;
      pageSize?: number;
      includePreserved?: boolean;
    },
  ): Promise<{
    messages: unknown[];
    total: number;
    pageIdx: number;
    pageSize: number;
    hasMore: boolean;
    archivedGenerations: number;
    cdpAvailable: boolean;
  }> => ipcRenderer.invoke("browser:console-records", webContentsId, options),
  /** 控制台单条记录。 */
  browserConsoleRecord: (
    webContentsId: number,
    messageId: number,
  ): Promise<unknown | null> =>
    ipcRenderer.invoke("browser:console-record", webContentsId, messageId),
  /** 清空控制台记录（含归档代际）。 */
  browserConsoleClear: (webContentsId: number): Promise<{ cleared: number }> =>
    ipcRenderer.invoke("browser:console-clear", webContentsId),
  /** 性能 trace：start / stop / insight。 */
  browserTraceStart: (
    webContentsId: number,
    categories?: string[],
  ): Promise<{ started: boolean; startedAt: string; categories: string[] }> =>
    ipcRenderer.invoke("browser:trace-start", webContentsId, categories),
  browserTraceStop: (
    webContentsId: number,
    options?: { filePath?: string },
  ): Promise<unknown> =>
    ipcRenderer.invoke("browser:trace-stop", webContentsId, options),
  browserTraceInsight: (
    webContentsId: number,
    insightId: string,
  ): Promise<{ found: boolean; detail?: Record<string, unknown> }> =>
    ipcRenderer.invoke("browser:trace-insight", webContentsId, insightId),
  /** 页面仿真（配色/CPU/地理位置/请求头/网络档位/UA/视口）。 */
  browserEmulate: (
    webContentsId: number,
    params: {
      colorScheme?: "dark" | "light" | "auto";
      cpuThrottlingRate?: number;
      extraHttpHeaders?: Record<string, string> | null;
      geolocation?: {
        latitude: number;
        longitude: number;
        accuracy?: number;
      } | null;
      networkConditions?: string | null;
      userAgent?: string | null;
      viewport?: string | null;
    },
  ): Promise<Record<string, unknown>> =>
    ipcRenderer.invoke("browser:emulate", webContentsId, params),
  browserResizePage: (
    webContentsId: number,
    width: number,
    height: number,
  ): Promise<{ width: number; height: number }> =>
    ipcRenderer.invoke("browser:resize-page", webContentsId, width, height),
  /** 元素 CSS 级联检查（匹配规则 / 内联 / 继承 / computed）。 */
  browserCssStyles: (
    webContentsId: number,
    query: {
      selector?: string;
      backendNodeId?: number;
      pageIdx?: number;
      pageSize?: number;
    },
  ): Promise<unknown> =>
    ipcRenderer.invoke("browser:css-styles", webContentsId, query),
  /** 页面审计：axe-core 无障碍 + 轻量 SEO / 最佳实践。 */
  browserAudit: (
    webContentsId: number,
    categories?: string[],
  ): Promise<unknown> =>
    ipcRenderer.invoke("browser:audit", webContentsId, categories),
  /** 堆快照操作（take/summary/query/details/edges/retainers/paths/strings/compare）。 */
  browserHeap: (
    action:
      | "take"
      | "summary"
      | "query"
      | "details"
      | "edges"
      | "retainers"
      | "paths"
      | "strings"
      | "compare",
    params: Record<string, unknown>,
  ): Promise<unknown> => ipcRenderer.invoke("browser:heap", action, params),
  /** 录屏：CDP 帧采集 + MJPEG AVI 合成。 */
  browserScreencastStart: (
    webContentsId: number,
    options?: {
      filePath?: string;
      quality?: number;
      maxWidth?: number;
      maxFrames?: number;
      maxDurationMs?: number;
      /** Renderer 持有渲染租约的唯一代际标识，不属于 MCP 参数。 */
      recordingId?: string;
    },
  ): Promise<{
    started: boolean;
    file: string;
    startedAt: string;
    recordingId: string;
  }> => ipcRenderer.invoke("browser:screencast-start", webContentsId, options),
  browserScreencastStop: (
    webContentsId: number,
    recordingId?: string,
  ): Promise<unknown> =>
    ipcRenderer.invoke("browser:screencast-stop", webContentsId, recordingId),
  /** 实际停止通知（含自动停止/销毁/detach/错误），仅发送给拥有者 Renderer。 */
  onBrowserScreencastStopped: (
    callback: (event: { webContentsId: number; recordingId: string }) => void,
  ): (() => void) => {
    const handler = (_event: IpcRendererEvent, payload: unknown): void => {
      if (!payload || typeof payload !== "object") return;
      const record = payload as {
        webContentsId?: unknown;
        recordingId?: unknown;
      };
      if (
        typeof record.webContentsId !== "number" ||
        !Number.isSafeInteger(record.webContentsId) ||
        record.webContentsId <= 0 ||
        typeof record.recordingId !== "string" ||
        !record.recordingId
      )
        return;
      callback({
        webContentsId: record.webContentsId,
        recordingId: record.recordingId,
      });
    };
    ipcRenderer.on("browser:screencast-stopped", handler);
    return () =>
      ipcRenderer.removeListener("browser:screencast-stopped", handler);
  },
  /** 模拟网络状态：offline=true 离线，false 恢复在线。 */
  browserNetworkState: (
    webContentsId: number,
    offline: boolean,
  ): Promise<{ state: "online" | "offline" }> =>
    ipcRenderer.invoke("browser:network-state", webContentsId, offline),
  /** 设置路由 mock 规则（全量替换；空数组 = 恢复真实网络）。 */
  browserRouteSet: (
    webContentsId: number,
    rules: {
      pattern: string;
      status?: number;
      body?: string;
      contentType?: string;
      headers?: Record<string, string>;
    }[],
  ): Promise<{ active: number }> =>
    ipcRenderer.invoke("browser:route-set", webContentsId, rules),
  /** 清除全部路由 mock 规则。 */
  browserRouteClear: (webContentsId: number): Promise<{ active: number }> =>
    ipcRenderer.invoke("browser:route-clear", webContentsId),
  /** 保存登录态（cookie + localStorage）为加密文件；返回文件路径与统计，不回显内容。 */
  browserStorageSave: (
    webContentsId: number,
    fileName?: string,
  ): Promise<{
    ok: boolean;
    file: string;
    cookieCount: number;
    originCount: number;
    capturedUrl: string;
    capturedAt: string;
    error?: string;
  }> => ipcRenderer.invoke("browser:storage-save", webContentsId, fileName),
  /** 从加密文件恢复登录态（恢复前自动加密备份当前状态）。 */
  browserStorageRestore: (
    webContentsId: number,
    fileName: string,
  ): Promise<{
    ok: boolean;
    restoredCookies: number;
    cookieFailures: number;
    restoredOrigins: number;
    originFailures: number;
    backupFile: string | null;
    warnings: string[];
    error?: string;
  }> => ipcRenderer.invoke("browser:storage-restore", webContentsId, fileName),
  /** 列出当前会话 cookie（默认脱敏值，showValues=true 返回明文）。 */
  browserCookies: (
    webContentsId: number,
    domain?: string,
    showValues?: boolean,
  ): Promise<unknown[]> =>
    ipcRenderer.invoke(
      "browser:cookies-list",
      webContentsId,
      domain,
      showValues,
    ),
  /** 删除指定 cookie（name + domain）。 */
  browserCookieDelete: (
    webContentsId: number,
    name: string,
    domain: string,
  ): Promise<{ deleted: boolean }> =>
    ipcRenderer.invoke("browser:cookie-delete", webContentsId, name, domain),
  /** 内置浏览器 webview 密码助手 preload 的绝对路径（供 <webview preload> 使用）。 */
  browserWebviewPreloadPath: join(__dirname, "webview-browser.cjs"),
  /**
   * 对内置浏览器 webview guest 应用「显示尺寸」设备模拟（主进程
   * enableDeviceEmulation + UA 覆盖）；params 传 null 关闭模拟并还原 UA。
   */
  browserDeviceEmulation: (
    webContentsId: number,
    params: {
      width: number;
      height: number;
      dpr: number;
      mobile: boolean;
      userAgent: string;
    } | null,
  ): Promise<void> =>
    ipcRenderer.invoke("browser:device-emulation", webContentsId, params),
  /** 列出密码保险库中的全部记录（不含明文密码）。 */
  browserPasswordsList: (): Promise<
    {
      id: string;
      origin: string;
      username: string;
      createdAt: number;
      updatedAt: number;
    }[]
  > => ipcRenderer.invoke("browser-passwords:list"),
  /** 取单条密码记录的明文（密码管理 UI 显式查看时调用）。 */
  browserPasswordGet: (
    id: string,
  ): Promise<{ username: string; password: string } | null> =>
    ipcRenderer.invoke("browser-passwords:get", id),
  /** 保存/更新密码记录（同 origin + username 覆盖）。 */
  browserPasswordSave: (payload: {
    origin: string;
    username: string;
    password: string;
  }): Promise<{ id: string; updated: boolean }> =>
    ipcRenderer.invoke("browser-passwords:save", payload),
  /** 删除一条密码记录。 */
  browserPasswordDelete: (id: string): Promise<boolean> =>
    ipcRenderer.invoke("browser-passwords:delete", id),
  /** 批量删除密码记录，返回实际删除数量。 */
  browserPasswordDeleteBatch: (ids: string[]): Promise<number> =>
    ipcRenderer.invoke("browser-passwords:delete-batch", ids),
  /** 探测本机浏览器源（Chrome/Edge/Chromium/Firefox）及其数据量。 */
  browserImportSources: (): Promise<
    {
      id: string;
      name: string;
      profile: string;
      accountName: string;
      passwordDb: string;
      cookieDb: string;
      passwordCount: number;
      cookieCount: number;
      bookmarkCount: number;
      note: string;
    }[]
  > => ipcRenderer.invoke("browser-import:sources"),
  /** 从指定浏览器源导入密码到保险库。 */
  browserImportPasswords: (
    sourceId: string,
    profile: string,
  ): Promise<{ total: number; imported: number; skipped: number }> =>
    ipcRenderer.invoke("browser-import:passwords", sourceId, profile),
  /** 从指定浏览器源导入 Cookie 到当前会话。 */
  browserImportCookies: (
    sourceId: string,
    profile: string,
  ): Promise<{ total: number; imported: number; failed: number }> =>
    ipcRenderer.invoke("browser-import:cookies", sourceId, profile),
  /** 列出全部书签（收藏栏展示）。 */
  browserBookmarksList: (): Promise<BrowserBookmark[]> =>
    ipcRenderer.invoke("browser-bookmarks:list"),
  /** 收藏/更新当前页（同 URL 覆盖标题；folder 可选文件夹路径）。 */
  browserBookmarkAdd: (
    url: string,
    title: string,
    folder?: string,
  ): Promise<{ id: string; created: boolean }> =>
    ipcRenderer.invoke("browser-bookmarks:add", url, title, folder),
  /** 删除一条书签。 */
  browserBookmarkDelete: (id: string): Promise<boolean> =>
    ipcRenderer.invoke("browser-bookmarks:delete", id),
  /** 批量删除书签，返回实际删除数量。 */
  browserBookmarkDeleteBatch: (ids: string[]): Promise<number> =>
    ipcRenderer.invoke("browser-bookmarks:delete-batch", ids),
  /** 编辑书签（标题 / URL / 文件夹路径），返回更新后的记录。 */
  browserBookmarkUpdate: (
    id: string,
    url: string,
    title: string,
    folder: string,
  ): Promise<BrowserBookmark | null> =>
    ipcRenderer.invoke("browser-bookmarks:update", id, url, title, folder),
  /** 从指定浏览器源导入书签（按 URL 去重合并到收藏夹）。 */
  browserImportBookmarks: (
    sourceId: string,
    profile: string,
  ): Promise<{ total: number; imported: number; skipped: number }> =>
    ipcRenderer.invoke("browser-bookmarks:import", sourceId, profile),
  /**
   * 订阅书签变更（导入/收藏/删除后触发，收藏栏据此重新拉取）。
   * 返回取消订阅函数。
   */
  onBrowserBookmarksUpdated: (callback: () => void): (() => void) => {
    browserBookmarksSubscribers.add(callback);
    return () => {
      browserBookmarksSubscribers.delete(callback);
    };
  },
  /** 记录一次内置浏览器的页面访问（非 http(s) 地址会被忽略）。 */
  browserHistoryRecord: (url: string, title: string): Promise<boolean> =>
    ipcRenderer.invoke("browser-history:record", url, title),
  /** 页面标题迟到更新：只改标题，不计入访问次数。 */
  browserHistoryUpdateTitle: (url: string, title: string): Promise<boolean> =>
    ipcRenderer.invoke("browser-history:update-title", url, title),
  /** 地址栏补全检索（查询为空时返回最近访问）。 */
  browserHistorySearch: (
    query: string,
    limit = 8,
  ): Promise<BrowserHistoryEntry[]> =>
    ipcRenderer.invoke("browser-history:search", query, limit),
  /** 设置页历史列表（查询过滤 + 分页）。 */
  browserHistoryList: (
    query: string,
    offset = 0,
    limit = 50,
  ): Promise<BrowserHistoryPage> =>
    ipcRenderer.invoke("browser-history:list", query, offset, limit),
  /** 删除单条历史记录。 */
  browserHistoryDelete: (id: string): Promise<boolean> =>
    ipcRenderer.invoke("browser-history:delete", id),
  /** 清空全部历史记录，返回删除数量。 */
  browserHistoryClear: (): Promise<number> =>
    ipcRenderer.invoke("browser-history:clear"),
  /** Frame operations execute in the main process; frame IDs never select another guest. */
  browserFrameOperation: (
    webContentsId: number,
    operation: string,
    args: BrowserFrameOperationArgs,
  ): Promise<unknown> =>
    ipcRenderer.invoke(
      "browser:frame-operation",
      webContentsId,
      operation,
      args,
    ),
  /** 执行白名单内的 CDP 命令（Accessibility.getFullAXTree / DOM.resolveNode / Runtime.callFunctionOn）。 */
  browserCdpCommand: (
    webContentsId: number,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> =>
    ipcRenderer.invoke("browser:cdp-command", webContentsId, method, params),
  /** 录制页面性能 trace（durationMs 毫秒）并返回精简统计。 */
  browserTrace: (
    webContentsId: number,
    durationMs: number,
  ): Promise<{
    ok: boolean;
    durationMs: number;
    eventCount: number;
    longTasks: { count: number; totalMs: number; longestMs: number };
    topEventTypes: { name: string; count: number }[];
    error?: string;
    note?: string;
  }> => ipcRenderer.invoke("browser:trace", webContentsId, durationMs),
  browserNetworkDetail: (
    webContentsId: number,
    requestId: number,
  ): Promise<unknown | null> =>
    ipcRenderer.invoke("browser:network-request", webContentsId, requestId),
  browserNetworkClear: (webContentsId: number): Promise<{ cleared: number }> =>
    ipcRenderer.invoke("browser:network-clear", webContentsId),
  browserDialogs: (webContentsId: number): Promise<unknown[]> =>
    ipcRenderer.invoke("browser:dialogs-list", webContentsId),
  browserDialogRespond: (
    webContentsId: number,
    accept: boolean,
    promptText?: string,
  ): Promise<{ responded: boolean; remaining: number; error?: string }> =>
    ipcRenderer.invoke(
      "browser:dialog-respond",
      webContentsId,
      accept,
      promptText,
    ),
  onWindowMaximizeStateChanged: (
    callback: (isMaximized: boolean) => void,
  ): (() => void) => {
    const handler = (_event: IpcRendererEvent, isMaximized: boolean): void => {
      callback(isMaximized);
    };

    ipcRenderer.on("window:maximize-state-changed", handler);

    return () => {
      ipcRenderer.removeListener("window:maximize-state-changed", handler);
    };
  },
  onWindowFullScreenChanged: (
    callback: (isFullScreen: boolean) => void,
  ): (() => void) => {
    const handler = (_event: IpcRendererEvent, isFullScreen: boolean): void => {
      callback(isFullScreen);
    };

    ipcRenderer.on("window:full-screen-changed", handler);

    return () => {
      ipcRenderer.removeListener("window:full-screen-changed", handler);
    };
  },
  onCloseRequested: (callback: () => void): (() => void) => {
    const handler = (_event: IpcRendererEvent): void => {
      callback();
    };

    ipcRenderer.on("window:close-requested", handler);

    return () => {
      ipcRenderer.removeListener("window:close-requested", handler);
    };
  },
  /** 主进程推送窗口缩窄方向：edge 为被拖动的边缘，contentWidth 为内容区宽度。 */
  onWindowResizeEdgeChanged: (
    callback: (info: { edge: "left" | "right"; contentWidth: number }) => void,
  ): (() => void) => {
    const handler = (_event: IpcRendererEvent, info: unknown): void => {
      if (!info || typeof info !== "object") {
        return;
      }
      const record = info as Record<string, unknown>;
      if (
        (record.edge === "left" || record.edge === "right") &&
        typeof record.contentWidth === "number"
      ) {
        callback({ edge: record.edge, contentWidth: record.contentWidth });
      }
    };

    ipcRenderer.on("window:resize-edge-changed", handler);

    return () => {
      ipcRenderer.removeListener("window:resize-edge-changed", handler);
    };
  },
};
