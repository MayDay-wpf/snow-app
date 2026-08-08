import { ipcRenderer, type IpcRendererEvent } from "electron";
import { join } from "node:path";
import {
  isNotificationConversationTarget,
  type AppNotificationOptions,
  type NotificationConversationTarget,
} from "../../shared/notification";
import type {
  BashStreamChunk,
  BrowserCommandRequest,
  BrowserCommandResponse,
  CheckpointFileChange,
  CheckpointFileDiff,
  CodebaseEmbedProgress,
  CodebaseIndexedFilePage,
  CodebaseIndexStats,
  CodebaseProjectScopeSettings,
  CodebaseScanPreview,
  CodebaseSphereLayout,
  CodebaseSyncProgress,
  CodebaseSyncResult,
  McpProjectServerStatus,
  McpProjectToolStatus,
  McpToolDefinition,
  GithubSkillRecord,
  ProjectSkillDefinition,
  ResumableCodebaseSession,
  SkillBatchInstallResult,
  SkillDefinition,
  SkillUninstallResult,
  TerminalCommandRequest,
  TerminalCommandResponse,
  UpdateStatus,
  UserQuestionRequest,
  UserQuestionResponse,
} from "../types";

const MCP_TOOL_CHUNK_CHANNEL = "mcp:call-tool:chunk";
const BROWSER_COMMAND_CHANNEL = "browser:command";
const BROWSER_COMMAND_RESPONSE_CHANNEL = "browser:command-response";
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
  target: NotificationConversationTarget
) => void;

const notificationActivationSubscribers =
  new Set<NotificationActivationSubscriber>();
const notificationActivationBuffer: NotificationConversationTarget[] = [];

const deliverNotificationActivation = (
  subscriber: NotificationActivationSubscriber,
  target: NotificationConversationTarget
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
  }
);

const createMcpToolStreamId = (): string =>
  `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const normalizeBashStreamChunk = (value: unknown): BashStreamChunk | null => {
  if (
    !isRecord(value) ||
    (value.stream !== "stdout" &&
      value.stream !== "stderr" &&
      value.stream !== "interactive_session" &&
      value.stream !== "tool_execution") ||
    typeof value.data !== "string"
  ) {
    return null;
  }

  return { stream: value.stream, data: value.data };
};

const mcpToolChunkCallbacks = new Map<
  string,
  (chunk: BashStreamChunk) => void
>();
let mcpToolChunkListenerRegistered = false;

const ensureMcpToolChunkListener = (): void => {
  if (mcpToolChunkListenerRegistered) {
    return;
  }
  mcpToolChunkListenerRegistered = true;
  ipcRenderer.on(MCP_TOOL_CHUNK_CHANNEL, (_event, payload: unknown) => {
    if (!isRecord(payload)) {
      return;
    }
    const streamId = payload.streamId;
    if (typeof streamId !== "string") {
      return;
    }
    const callback = mcpToolChunkCallbacks.get(streamId);
    if (!callback) {
      return;
    }
    const chunk = normalizeBashStreamChunk(payload.chunk);
    if (chunk) {
      callback(chunk);
    }
  });
};

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
  sessionId: string
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
    }
  );
};

export const systemApi = {
  getCodebaseProjectScopeSettings: (
    projectId: string
  ): Promise<CodebaseProjectScopeSettings> =>
    ipcRenderer.invoke("codebase:get-project-scope", projectId),
  setCodebaseProjectEnabled: (
    projectId: string,
    enabled: boolean
  ): Promise<void> =>
    ipcRenderer.invoke("codebase:set-project-enabled", projectId, enabled),
  setCodebaseProjectAgentReview: (
    projectId: string,
    enabled: boolean
  ): Promise<void> =>
    ipcRenderer.invoke("codebase:set-project-agent-review", projectId, enabled),
  setCodebaseProjectReranking: (
    projectId: string,
    enabled: boolean
  ): Promise<void> =>
    ipcRenderer.invoke("codebase:set-project-reranking", projectId, enabled),
  checkProjectHasGitignore: (projectId: string): Promise<boolean> =>
    ipcRenderer.invoke("codebase:check-project-gitignore", projectId),
  checkProjectIsRemote: (projectId: string): Promise<boolean> =>
    ipcRenderer.invoke("codebase:check-project-remote", projectId),
  startCodebaseEmbedding: (
    projectId: string,
    sessionId: string
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
      sessionId: string
    ) => void
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
    pageSize: number
  ): Promise<CodebaseIndexedFilePage> =>
    ipcRenderer.invoke("codebase:list-indexed-files", projectId, page, pageSize),
  getCodebaseSphereLayout: (
    projectId: string,
    limit: number
  ): Promise<CodebaseSphereLayout> =>
    ipcRenderer.invoke("codebase:get-sphere-layout", projectId, limit),
  clearCodebaseIndex: (projectId: string): Promise<void> =>
    ipcRenderer.invoke("codebase:clear-index", projectId),
  startCodebaseWatch: (projectId: string, projectPath: string): Promise<void> =>
    ipcRenderer.invoke("codebase:start-watch", projectId, projectPath),
  stopCodebaseWatch: (projectId: string): Promise<void> =>
    ipcRenderer.invoke("codebase:stop-watch", projectId),
  syncCodebaseChanges: (
    projectId: string,
    onProgress?: (progress: CodebaseSyncProgress) => void
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
    callback: (projectId: string) => void
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
    callback: (progress: CodebaseSyncProgress, projectId: string) => void
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
        projectId
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
    }) => void
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
    projectId: string
  ): Promise<ResumableCodebaseSession[]> =>
    ipcRenderer.invoke("codebase:get-resumable-sessions", projectId),
  discardResumableCodebaseSession: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke("codebase:discard-resumable-session", sessionId),
  listMcpTools: (): Promise<McpToolDefinition[]> =>
    ipcRenderer.invoke("mcp:list-tools"),
  listAvailableSkills: (projectId?: string): Promise<SkillDefinition[]> =>
    ipcRenderer.invoke("skills:list", projectId),
  setSkillEnabled: (
    projectId: string | undefined,
    skillId: string,
    enabled: boolean
  ): Promise<void> =>
    ipcRenderer.invoke("skills:set-enabled", projectId, skillId, enabled),
  listProjectSkills: (projectId: string): Promise<ProjectSkillDefinition[]> =>
    ipcRenderer.invoke("skills:list-project", projectId),
  setProjectSkillEnabled: (
    projectId: string,
    skillId: string,
    enabled: boolean
  ): Promise<void> =>
    ipcRenderer.invoke(
      "skills:set-project-enabled",
      projectId,
      skillId,
      enabled
    ),
  installSkillFromGithub: (
    url: string,
    location: "global" | "project",
    projectId?: string
  ): Promise<SkillBatchInstallResult> =>
    ipcRenderer.invoke("skills:install-github", url, location, projectId),
  uninstallGithubSkill: (
    skillId: string,
    projectId?: string
  ): Promise<SkillUninstallResult> =>
    ipcRenderer.invoke("skills:uninstall-github", skillId, projectId),
  listGithubSkills: (): Promise<GithubSkillRecord[]> =>
    ipcRenderer.invoke("skills:list-github"),
  listMcpServerTools: (configServerId: string): Promise<McpToolDefinition[]> =>
    ipcRenderer.invoke("mcp:list-server-tools", configServerId),
  listMcpProjectServers: (
    projectId: string
  ): Promise<McpProjectServerStatus[]> =>
    ipcRenderer.invoke("mcp:list-project-servers", projectId),
  listMcpProjectServerTools: (
    projectId: string,
    serverId: string
  ): Promise<McpProjectToolStatus[]> =>
    ipcRenderer.invoke("mcp:list-project-server-tools", projectId, serverId),
  setMcpProjectServerEnabled: (
    projectId: string,
    serverId: string,
    enabled: boolean
  ): Promise<void> =>
    ipcRenderer.invoke(
      "mcp:set-project-server-enabled",
      projectId,
      serverId,
      enabled
    ),
  setMcpProjectToolEnabled: (
    projectId: string,
    toolName: string,
    enabled: boolean
  ): Promise<void> =>
    ipcRenderer.invoke(
      "mcp:set-project-tool-enabled",
      projectId,
      toolName,
      enabled
    ),
  registerBrowserCommandHandler: (
    handler: (request: BrowserCommandRequest) => Promise<string>
  ): (() => void) => {
    const listener = (
      _event: IpcRendererEvent,
      request: BrowserCommandRequest
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
  registerTerminalCommandHandler: (
    handler: (request: TerminalCommandRequest) => Promise<string>
  ): (() => void) => {
    const listener = (
      _event: IpcRendererEvent,
      request: TerminalCommandRequest
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
    handler: (request: UserQuestionRequest) => Promise<string>
  ): (() => void) => {
    const listener = (
      _event: IpcRendererEvent,
      request: UserQuestionRequest
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
    }) => Promise<string>
  ): (() => void) => {
    const listener = (
      _event: IpcRendererEvent,
      request: { requestId: string; action: string; payloadJson: string }
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
  abortToolExecution: (toolExecutionId: string): Promise<boolean> =>
    ipcRenderer.invoke("mcp:abort-tool-execution", toolExecutionId),
  callMcpTool: (
    toolFullName: string,
    argsJson: string,
    projectId?: string,
    checkpointIds?: string[],
    checkpointWorkDir?: string,
    sensitiveAuthorizationToken?: string,
    onChunk?: (chunk: BashStreamChunk) => void,
    interactionId?: string,
    subAgentAllowedTools?: string[],
    planMode?: boolean,
    planApproved?: boolean
  ): Promise<string> => {
    const streamId = createMcpToolStreamId();
    ensureMcpToolChunkListener();

    if (onChunk) {
      mcpToolChunkCallbacks.set(streamId, onChunk);
    }

    return ipcRenderer
      .invoke(
        "mcp:call-tool",
        toolFullName,
        argsJson,
        projectId,
        checkpointIds,
        checkpointWorkDir,
        sensitiveAuthorizationToken,
        streamId,
        interactionId ?? streamId,
        subAgentAllowedTools,
        planMode,
        planApproved
      )
      .finally(() => {
        mcpToolChunkCallbacks.delete(streamId);
      });
  },
  createCheckpoint: (workDir: string): Promise<string> =>
    ipcRenderer.invoke("checkpoint:create", workDir),
  restoreCheckpoint: (checkpointId: string, workDir: string): Promise<void> =>
    ipcRenderer.invoke("checkpoint:restore", checkpointId, workDir),
  deleteCheckpoint: (checkpointId: string): Promise<void> =>
    ipcRenderer.invoke("checkpoint:delete", checkpointId),
  listCheckpointChanges: (
    checkpointId: string,
    workDir: string
  ): Promise<CheckpointFileChange[]> =>
    ipcRenderer.invoke("checkpoint:list-changes", checkpointId, workDir),
  listCheckpointDiffs: (
    checkpointId: string,
    workDir: string,
    includeAll?: boolean
  ): Promise<CheckpointFileDiff[]> =>
    ipcRenderer.invoke(
      "checkpoint:list-diffs",
      checkpointId,
      workDir,
      includeAll ?? false
    ),
  writeLog: (level: string, entry: unknown): Promise<void> =>
    ipcRenderer.invoke("debug:write-log", level, entry),
  sum: (a: number, b: number): Promise<number> =>
    ipcRenderer.invoke("native:sum", a, b),
  showNotification: (options: AppNotificationOptions): Promise<void> =>
    ipcRenderer.invoke("notification:show", options),
  onNotificationActivated: (
    callback: (target: NotificationConversationTarget) => void
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
    callback: (status: UpdateStatus) => void
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
  onPtyOutput: (
    callback: (data: { id: string; data: string }) => void
  ): (() => void) => {
    const handler = (
      _event: IpcRendererEvent,
      payload: { id: string; data: string }
    ): void => {
      callback(payload);
    };

    ipcRenderer.on("pty:output", handler);

    return () => {
      ipcRenderer.removeListener("pty:output", handler);
    };
  },
  onPtyExit: (
    callback: (data: { id: string; exitCode: number }) => void
  ): (() => void) => {
    const handler = (
      _event: IpcRendererEvent,
      payload: { id: string; exitCode: number }
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
  setTrayActiveSessions: (count: number): Promise<void> =>
    ipcRenderer.invoke("tray:set-active-sessions", count),
  toggleMaximizeWindow: (): Promise<void> =>
    ipcRenderer.invoke("window:maximize-toggle"),
  closeWindow: (): Promise<void> => ipcRenderer.invoke("window:close"),
  confirmCloseWindow: (): Promise<void> =>
    ipcRenderer.invoke("window:confirm-close"),
  isWindowMaximized: (): Promise<boolean> =>
    ipcRenderer.invoke("window:is-maximized"),
  clearWindowState: (): Promise<void> =>
    ipcRenderer.invoke("window:clear-state"),
  startWindowDrag: (): Promise<void> => ipcRenderer.invoke("window:start-drag"),
  stopWindowDrag: (): Promise<void> => ipcRenderer.invoke("window:stop-drag"),
  writeImageToClipboard: (dataUrl: string): Promise<void> =>
    ipcRenderer.invoke("clipboard:write-image", dataUrl),
  readClipboardText: (): Promise<string> =>
    ipcRenderer.invoke("clipboard:read-text"),
  writeClipboardText: (text: string): Promise<void> =>
    ipcRenderer.invoke("clipboard:write-text", text),
  /** 在系统文件管理器中显示指定路径（文件高亮选中，目录直接打开）。 */
  showItemInFolder: (path: string): Promise<void> =>
    ipcRenderer.invoke("shell:show-item-in-folder", path),
  clearBrowserCache: (): Promise<void> =>
    ipcRenderer.invoke("browser:clear-cache"),
  clearBrowserCookies: (): Promise<void> =>
    ipcRenderer.invoke("browser:clear-cookies"),
  openBrowserDevTools: (webContentsId: number): Promise<void> =>
    ipcRenderer.invoke("browser:open-devtools", webContentsId),
  browserNetworkRequests: (
    webContentsId: number,
    filter?: string,
    limit?: number,
    includeStatic?: boolean
  ): Promise<unknown[]> =>
    ipcRenderer.invoke(
      "browser:network-requests",
      webContentsId,
      filter,
      limit,
      includeStatic
    ),
  /** 查询单条网络请求的完整详情（请求/响应头 + 请求/响应体）。 */
  browserNetworkDetails: (
    webContentsId: number,
    requestId: string,
    maxBodyBytes?: number
  ): Promise<unknown> =>
    ipcRenderer.invoke(
      "browser:network-details",
      webContentsId,
      requestId,
      maxBodyBytes
    ),
  /** 模拟网络状态：offline=true 离线，false 恢复在线。 */
  browserNetworkState: (
    webContentsId: number,
    offline: boolean
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
    }[]
  ): Promise<{ active: number }> =>
    ipcRenderer.invoke("browser:route-set", webContentsId, rules),
  /** 清除全部路由 mock 规则。 */
  browserRouteClear: (webContentsId: number): Promise<{ active: number }> =>
    ipcRenderer.invoke("browser:route-clear", webContentsId),
  /** 保存登录态（cookie + localStorage）为加密文件；返回文件路径与统计，不回显内容。 */
  browserStorageSave: (
    webContentsId: number,
    fileName?: string
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
    fileName: string
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
    showValues?: boolean
  ): Promise<unknown[]> =>
    ipcRenderer.invoke(
      "browser:cookies-list",
      webContentsId,
      domain,
      showValues
    ),
  /** 删除指定 cookie（name + domain）。 */
  browserCookieDelete: (
    webContentsId: number,
    name: string,
    domain: string
  ): Promise<{ deleted: boolean }> =>
    ipcRenderer.invoke("browser:cookie-delete", webContentsId, name, domain),
  /** 内置浏览器 webview 密码助手 preload 的绝对路径（供 <webview preload> 使用）。 */
  browserWebviewPreloadPath: join(__dirname, "webview-browser.mjs"),
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
    id: string
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
      note: string;
    }[]
  > => ipcRenderer.invoke("browser-import:sources"),
  /** 从指定浏览器源导入密码到保险库。 */
  browserImportPasswords: (
    sourceId: string,
    profile: string
  ): Promise<{ total: number; imported: number; skipped: number }> =>
    ipcRenderer.invoke("browser-import:passwords", sourceId, profile),
  /** 从指定浏览器源导入 Cookie 到当前会话。 */
  browserImportCookies: (
    sourceId: string,
    profile: string
  ): Promise<{ total: number; imported: number; failed: number }> =>
    ipcRenderer.invoke("browser-import:cookies", sourceId, profile),
  /** 执行白名单内的 CDP 命令（Accessibility.getFullAXTree / DOM.resolveNode / Runtime.callFunctionOn）。 */
  browserCdpCommand: (
    webContentsId: number,
    method: string,
    params?: Record<string, unknown>
  ): Promise<unknown> =>
    ipcRenderer.invoke("browser:cdp-command", webContentsId, method, params),
  /** 录制页面性能 trace（durationMs 毫秒）并返回精简统计。 */
  browserTrace: (
    webContentsId: number,
    durationMs: number
  ): Promise<{
    ok: boolean;
    durationMs: number;
    eventCount: number;
    longTasks: { count: number; totalMs: number; longestMs: number };
    topEventTypes: { name: string; count: number }[];
    error?: string;
    note?: string;
  }> => ipcRenderer.invoke("browser:trace", webContentsId, durationMs),
  browserNetworkRequest: (recordId: number): Promise<unknown | null> =>
    ipcRenderer.invoke("browser:network-request", recordId),
  browserNetworkClear: (
    webContentsId: number
  ): Promise<{ cleared: number }> =>
    ipcRenderer.invoke("browser:network-clear", webContentsId),
  browserDialogs: (webContentsId: number): Promise<unknown[]> =>
    ipcRenderer.invoke("browser:dialogs-list", webContentsId),
  browserDialogRespond: (
    webContentsId: number,
    accept: boolean,
    promptText?: string
  ): Promise<{ responded: boolean; remaining: number; error?: string }> =>
    ipcRenderer.invoke(
      "browser:dialog-respond",
      webContentsId,
      accept,
      promptText
    ),
  onWindowMaximizeStateChanged: (
    callback: (isMaximized: boolean) => void
  ): (() => void) => {
    const handler = (_event: IpcRendererEvent, isMaximized: boolean): void => {
      callback(isMaximized);
    };

    ipcRenderer.on("window:maximize-state-changed", handler);

    return () => {
      ipcRenderer.removeListener("window:maximize-state-changed", handler);
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
};
