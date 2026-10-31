import { BrowserWindow, dialog, ipcMain, nativeTheme } from "electron";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setFlagsFromString } from "node:v8";
import type {
  AppControlCommand,
  BashStreamChunk,
  BrowserCommand,
  BrowserCommandResponse,
  CodebaseEmbedProgress,
  MemoryOptimizeResult,
  NativeBridge,
  TerminalCommand,
  TerminalCommandResponse,
  UserQuestionCommand,
  UserQuestionResponse,
  AppLogInput,
  WebSearchCommand,
} from "../../native/types";
import {
  BROWSER_COMMAND_RESPONSE_CHANNEL,
  dispatchBrowserCommand,
  registerBrowserInstanceRenderer,
  registerBrowserRenderer,
  resolveBrowserCommand,
  unregisterBrowserInstanceRenderer,
  unregisterBrowserRenderer,
} from "../browserCommandBroker";
import {
  TERMINAL_COMMAND_RESPONSE_CHANNEL,
  dispatchTerminalCommand,
  registerTerminalRenderer,
  registerTerminalTabRenderer,
  resolveTerminalCommand,
  unregisterTerminalRenderer,
  unregisterTerminalTabRenderer,
} from "../terminalCommandBroker";
import {
  dispatchUserQuestion,
  resolveUserQuestion,
  USER_QUESTION_RESPONSE_CHANNEL,
} from "../userQuestionBroker";
import { refreshUserscriptSyncStore } from "../../app/userscriptSyncStore";
import {
  MAIN_LANGUAGE_SETTING_CODE,
  refreshMainLocale,
} from "../../i18n/mainI18n";
import {
  dispatchAppControl,
  resolveAppControl,
  APP_CONTROL_RESPONSE_CHANNEL,
} from "../appControlBroker";
import { dispatchRemoteWorkspaceCommand } from "../../ssh/remoteWorkspaceCommand";
import { dispatchBackgroundRemoteWorkspaceCommand } from "../../ssh/sshWorkspaceLease";
import {
  abortSshCommand,
  registerSshCommandAbort,
  unregisterSshCommandAbort,
} from "../../ssh/sshCommandRegistry";
import { safeSend } from "../../utils/safeSend";
import { dispatchWebSearchCommand } from "../../websearch/webSearchRegistry";
import { registerImageGenerationHandlers } from "./imageGenerationHandlers";
import { notifySubAgentCapacityChanged } from "../../subAgents/subAgentRunHost";
import {
  forwardMcpToolChunk,
  injectImageGenerationContext,
} from "./imageGenerationToolBridge";

/** 解析 config-* 工具参数中的 scope（非法 JSON 或缺失时返回 null）。 */
const readConfigScope = (argsJson: string): string | null => {
  try {
    const parsed: unknown = JSON.parse(argsJson);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const scope = (parsed as { scope?: unknown }).scope;
    return typeof scope === "string" ? scope.trim() : null;
  } catch {
    return null;
  }
};

/** 解析 config-* 参数 key 中逗号分隔的 id 列表。 */
const readConfigKeyList = (argsJson: string): string[] => {
  try {
    const key = (JSON.parse(argsJson) as { key?: unknown } | null)?.key;
    return typeof key === "string"
      ? key
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean)
      : [];
  } catch {
    return [];
  }
};

export const registerNativeHandlers = (native: NativeBridge): void => {
  registerImageGenerationHandlers(native);
  // SSH checkpoint 与仓库 Wiki 后台任务需要一个独立于工具调用链的远程命令
  // 通道：renderer 的 checkpoint 导出 API（create/restore/list）与 Wiki 任务
  // 都不经过 callMcpTool，无法把 onRemoteWorkspaceCommand 传入 Rust。这里注册
  // 一次全局回调，复用同一套命令分发；后台通道在执行期间显式持有工作区连接，
  // 结束后释放（工具调用通道仍要求工作区已连接）。
  native.setCheckpointRemoteCallback?.((command) =>
    dispatchBackgroundRemoteWorkspaceCommand(command),
  );
  ipcMain.handle("native:engine-info", () => native.engineInfo());
  // 「优化占用」的内存部分（仅 Windows 支持）：先触发主进程 V8 full GC 回收
  // JS 堆，再由 Rust 收缩 OS 工作集，避免 JS 堆与不活跃页长期虚高常驻内存。
  // macOS / Linux 的堆整理接口在多线程 GUI 进程中存在崩溃风险，快速失败，
  // 前端据此仅展示磁盘释放结果。
  ipcMain.handle(
    "settings:optimize-memory",
    async (): Promise<MemoryOptimizeResult> => {
      if (process.platform !== "win32") {
        throw new Error("Memory optimization is only supported on Windows");
      }
      try {
        // Electron 主进程默认未暴露 gc；运行时注入 --expose_gc 标志后启用。
        // 注入失败或 global.gc 不存在时静默跳过，后续仍执行 Rust 工作集收缩。
        setFlagsFromString("--expose_gc");
        (globalThis as unknown as { gc?: () => void }).gc?.();
      } catch {
        // Ignore: GC 能力不可用不影响流程
      }
      return native.optimizeMemory();
    },
  );
  ipcMain.handle(
    "settings:get-system-setting-value",
    async (_event, settingCode: string) =>
      native.getSystemSettingValue(settingCode),
  );
  ipcMain.handle(
    "settings:set-system-setting",
    async (
      _event,
      settingName: string,
      settingCode: string,
      settingValue: string,
    ) => {
      const result = await native.setSystemSetting(
        settingName,
        settingCode,
        settingValue,
      );
      // A successful capacity-setting commit must wake durable waiters in every
      // execution window. Reuse the original host invalidation, never a model
      // polling request. A same-value save is a harmless extra invalidation.
      if (
        settingCode === "sub_agent_max_concurrency" ||
        settingCode === "sub_agent_global_max_concurrency"
      ) {
        notifySubAgentCapacityChanged();
      }
      // 语言设置变化后刷新主进程文案缓存（托盘等原生菜单随之重建）。
      if (settingCode === MAIN_LANGUAGE_SETTING_CODE) {
        await refreshMainLocale();
      }
      return result;
    },
  );
  ipcMain.handle("settings:get-yolo-mode", () => native.getYoloMode());
  ipcMain.handle("settings:set-yolo-mode", (_event, enabled: boolean) =>
    native.setYoloMode(enabled),
  );
  ipcMain.handle("settings:get-lite-mode", () => native.getLiteMode());
  ipcMain.handle("settings:set-lite-mode", (_event, enabled: boolean) =>
    native.setLiteMode(enabled),
  );
  ipcMain.handle("settings:get-auto-format", () => native.getAutoFormat());
  ipcMain.handle("settings:set-auto-format", (_event, enabled: boolean) =>
    native.setAutoFormat(enabled),
  );
  ipcMain.handle("settings:get-tool-correction", () =>
    native.getToolCorrection(),
  );
  ipcMain.handle("settings:set-tool-correction", (_event, enabled: boolean) =>
    native.setToolCorrection(enabled),
  );
  ipcMain.handle(
    "settings:get-conversation-modes",
    (_event, conversationId: string) =>
      native.getConversationModes(conversationId),
  );
  ipcMain.handle(
    "settings:set-conversation-modes",
    (
      _event,
      conversationId: string,
      goalMode: boolean | null,
      worktreeMode: boolean | null,
      workflowMode: boolean | null,
      goalModeTokenBudget: number | null,
    ) =>
      native.setConversationModes(
        conversationId,
        goalMode,
        worktreeMode,
        workflowMode,
        goalModeTokenBudget,
      ),
  );
  ipcMain.handle(
    "settings:get-conversation-runtime-config",
    (_event, conversationId: string) =>
      native.getConversationRuntimeConfig(conversationId),
  );
  ipcMain.handle(
    "settings:set-conversation-runtime-config",
    (
      _event,
      conversationId: string,
      thinkingStrength: string | null,
      responsesFastMode: string | null,
    ) =>
      native.setConversationRuntimeConfig(
        conversationId,
        thinkingStrength,
        responsesFastMode,
      ),
  );
  ipcMain.handle(
    "settings:set-conversation-run-stats",
    (
      _event,
      conversationId: string,
      runInputTokens: number,
      runOutputTokens: number,
      runCacheCreationInputTokens: number,
      runCacheReadInputTokens: number,
      lastRunDurationMs: number,
      runTtftSumMs: number,
      runRequestCount: number,
    ) =>
      native.setConversationRunStats(
        conversationId,
        runInputTokens,
        runOutputTokens,
        runCacheCreationInputTokens,
        runCacheReadInputTokens,
        lastRunDurationMs,
        runTtftSumMs,
        runRequestCount,
      ),
  );
  ipcMain.handle(
    "settings:reset-conversation-run-stats",
    (_event, conversationId: string) =>
      native.resetConversationRunStats(conversationId),
  );
  ipcMain.handle("settings:get-request-logging", () =>
    native.getRequestLogging(),
  );
  ipcMain.handle("settings:set-request-logging", (_event, enabled: boolean) =>
    native.setRequestLogging(enabled),
  );
  ipcMain.handle("settings:get-request-logging-expiry", () =>
    native.getRequestLoggingExpiry(),
  );
  ipcMain.handle(
    "settings:set-request-logging-expiry",
    (_event, expiresAtMs: number) =>
      native.setRequestLoggingExpiry(expiresAtMs),
  );
  ipcMain.handle("settings:get-privacy-settings", () =>
    native.getPrivacySettings(),
  );
  ipcMain.handle(
    "settings:set-privacy-settings",
    (_event, settings: unknown) => {
      if (!settings || typeof settings !== "object") {
        throw new Error("Privacy settings must be an object");
      }
      return native.setPrivacySettings(settings as never);
    },
  );
  ipcMain.handle("settings:list-privacy-rules", () =>
    native.listPrivacyRules(),
  );
  ipcMain.handle(
    "settings:save-privacy-custom-rules",
    (_event, content: unknown) => {
      if (typeof content !== "string") {
        throw new Error("Custom rules content must be a string");
      }
      return native.savePrivacyCustomRules(content);
    },
  );
  ipcMain.handle(
    "settings:preview-privacy-mask",
    (_event, sample: unknown, disabledRules: unknown, customRules: unknown) => {
      if (typeof sample !== "string") {
        throw new Error("Preview sample must be a string");
      }
      return native.previewPrivacyMask(
        sample,
        Array.isArray(disabledRules) ? (disabledRules as string[]) : [],
        Array.isArray(customRules) ? (customRules as never) : [],
      );
    },
  );
  ipcMain.handle("settings:get-theme-settings", () =>
    native.getThemeSettings(),
  );
  ipcMain.handle("settings:set-theme-settings", (_event, settings: unknown) => {
    if (!settings || typeof settings !== "object") {
      throw new Error("Theme settings must be an object");
    }
    const themeSettings = settings as { mode?: unknown };
    const mode = themeSettings.mode;
    // 同步 nativeTheme.themeSource，使窗口 chrome 和 shouldUseDarkColors
    // 立即跟随用户选择，而不是仅在启动时从后端读取。
    if (mode === "light" || mode === "dark" || mode === "system") {
      nativeTheme.themeSource = mode;
    }
    return native.setThemeSettings(settings as never);
  });
  ipcMain.handle("settings:get-keyboard-shortcuts", () =>
    native.getKeyboardShortcutsSettings(),
  );
  ipcMain.handle(
    "settings:set-keyboard-shortcuts",
    (_event, settings: unknown) => {
      if (!settings || typeof settings !== "object") {
        throw new Error("Keyboard shortcuts settings must be an object");
      }
      return native.setKeyboardShortcutsSettings(settings as never);
    },
  );
  ipcMain.handle(
    "theme:save-background-image",
    (_event, sourcePath: unknown) => {
      if (typeof sourcePath !== "string" || !sourcePath.trim()) {
        throw new Error("Background image source path is required");
      }
      return native.saveThemeBackgroundImage(sourcePath);
    },
  );
  ipcMain.handle(
    "theme:delete-background-image",
    (_event, imagePath: unknown) => {
      if (typeof imagePath !== "string") {
        throw new Error("Background image path must be a string");
      }
      return native.deleteThemeBackgroundImage(imagePath);
    },
  );
  ipcMain.handle(
    "theme:save-stream-cursor-svg",
    (_event, sourcePath: unknown) => {
      if (typeof sourcePath !== "string" || !sourcePath.trim()) {
        throw new Error("Stream cursor SVG source path is required");
      }
      return native.saveThemeStreamCursorSvg(sourcePath);
    },
  );
  ipcMain.handle(
    "theme:save-stream-cursor-image",
    (_event, sourcePath: unknown) => {
      if (typeof sourcePath !== "string" || !sourcePath.trim()) {
        throw new Error("Stream cursor image source path is required");
      }
      return native.saveThemeStreamCursorImage(sourcePath);
    },
  );
  ipcMain.handle(
    "theme:save-stream-cursor-script",
    (_event, sourcePath: unknown) => {
      if (typeof sourcePath !== "string" || !sourcePath.trim()) {
        throw new Error("Stream cursor script source path is required");
      }
      return native.saveThemeStreamCursorScript(sourcePath);
    },
  );
  ipcMain.handle(
    "theme:read-stream-cursor-script",
    (_event, scriptPath: unknown) => {
      if (typeof scriptPath !== "string" || !scriptPath.trim()) {
        throw new Error("Stream cursor script path is required");
      }
      return native.readThemeStreamCursorScript(scriptPath);
    },
  );
  ipcMain.handle(
    "theme:delete-stream-cursor-svg",
    (_event, svgPath: unknown) => {
      if (typeof svgPath !== "string") {
        throw new Error("Stream cursor SVG path must be a string");
      }
      return native.deleteThemeStreamCursorSvg(svgPath);
    },
  );
  ipcMain.handle("theme:save-chat-avatar", (_event, sourcePath: unknown) => {
    if (typeof sourcePath !== "string" || !sourcePath.trim()) {
      throw new Error("Chat avatar source path is required");
    }
    return native.saveThemeChatAvatar(sourcePath);
  });
  ipcMain.handle("theme:delete-chat-avatar", (_event, avatarPath: unknown) => {
    if (typeof avatarPath !== "string") {
      throw new Error("Chat avatar path must be a string");
    }
    return native.deleteThemeChatAvatar(avatarPath);
  });
  ipcMain.handle("codebase:get-project-scope", (_event, projectId: unknown) => {
    if (typeof projectId !== "string" || !projectId.trim()) {
      throw new Error("Project id is required");
    }
    return native.getCodebaseProjectScopeSettings(projectId.trim());
  });
  ipcMain.handle(
    "codebase:set-project-enabled",
    (event, projectId: unknown, enabled: unknown) => {
      if (typeof projectId !== "string" || !projectId.trim()) {
        throw new Error("Project id is required");
      }
      if (typeof enabled !== "boolean") {
        throw new Error("Codebase enabled state must be a boolean");
      }
      const normalizedProjectId = projectId.trim();
      return native
        .setCodebaseProjectEnabled(normalizedProjectId, enabled)
        .then(() => {
          safeSend(event.sender, "codebase:scope-changed", {
            projectId: normalizedProjectId,
            key: "enabled",
            enabled,
          });
        });
    },
  );
  ipcMain.handle(
    "codebase:set-project-agent-review",
    (_event, projectId: unknown, enabled: unknown) => {
      if (typeof projectId !== "string" || !projectId.trim()) {
        throw new Error("Project id is required");
      }
      if (typeof enabled !== "boolean") {
        throw new Error("Codebase agent review state must be a boolean");
      }
      return native.setCodebaseProjectAgentReview(projectId.trim(), enabled);
    },
  );
  ipcMain.handle(
    "codebase:set-project-reranking",
    (_event, projectId: unknown, enabled: unknown) => {
      if (typeof projectId !== "string" || !projectId.trim()) {
        throw new Error("Project id is required");
      }
      if (typeof enabled !== "boolean") {
        throw new Error("Codebase reranking state must be a boolean");
      }
      return native.setCodebaseProjectReranking(projectId.trim(), enabled);
    },
  );
  ipcMain.handle(
    "codebase:check-project-gitignore",
    (_event, projectId: unknown) => {
      if (typeof projectId !== "string" || !projectId.trim()) {
        throw new Error("Project id is required");
      }
      return native.checkProjectHasGitignore(projectId.trim());
    },
  );
  ipcMain.handle(
    "codebase:check-project-remote",
    (_event, projectId: unknown) => {
      if (typeof projectId !== "string" || !projectId.trim()) {
        throw new Error("Project id is required");
      }
      return native.checkProjectIsRemote(projectId.trim());
    },
  );
  ipcMain.handle(
    "codebase:start-embedding",
    async (event, projectId: unknown, sessionId: unknown) => {
      if (typeof projectId !== "string" || !projectId.trim()) {
        throw new Error("Project id is required");
      }
      if (typeof sessionId !== "string" || !sessionId.trim()) {
        throw new Error("Session id is required");
      }
      const normalizedProjectId = projectId.trim();
      const normalizedSessionId = sessionId.trim();
      return native.startCodebaseEmbedding(
        normalizedProjectId,
        normalizedSessionId,
        (progress: CodebaseEmbedProgress) => {
          safeSend(event.sender, "codebase:embed:progress", {
            sessionId: normalizedSessionId,
            projectId: normalizedProjectId,
            progress,
          });
        },
      );
    },
  );
  ipcMain.handle("codebase:pause-embedding", (_event, sessionId: unknown) => {
    if (typeof sessionId !== "string" || !sessionId.trim()) {
      throw new Error("Session id is required");
    }
    return native.pauseCodebaseEmbedding(sessionId.trim());
  });
  ipcMain.handle("codebase:resume-embedding", (_event, sessionId: unknown) => {
    if (typeof sessionId !== "string" || !sessionId.trim()) {
      throw new Error("Session id is required");
    }
    return native.resumeCodebaseEmbedding(sessionId.trim());
  });
  ipcMain.handle("codebase:cancel-embedding", (_event, sessionId: unknown) => {
    if (typeof sessionId !== "string" || !sessionId.trim()) {
      throw new Error("Session id is required");
    }
    return native.cancelCodebaseEmbedding(sessionId.trim());
  });
  ipcMain.handle(
    "codebase:is-embedding-active",
    (_event, projectId: unknown) => {
      if (typeof projectId !== "string" || !projectId.trim()) {
        throw new Error("Project id is required");
      }
      return native.isCodebaseEmbeddingActive(projectId.trim());
    },
  );
  ipcMain.handle("codebase:get-index-stats", (_event, projectId: unknown) => {
    if (typeof projectId !== "string" || !projectId.trim()) {
      throw new Error("Project id is required");
    }
    return native.getCodebaseIndexStats(projectId.trim());
  });
  ipcMain.handle(
    "codebase:list-indexed-files",
    (_event, projectId: unknown, page: unknown, pageSize: unknown) => {
      if (typeof projectId !== "string" || !projectId.trim()) {
        throw new Error("Project id is required");
      }
      if (typeof page !== "number" || !Number.isInteger(page) || page < 1) {
        throw new Error("Page must be a positive integer");
      }
      if (
        typeof pageSize !== "number" ||
        !Number.isInteger(pageSize) ||
        pageSize < 1 ||
        pageSize > 100
      ) {
        throw new Error("Page size must be an integer between 1 and 100");
      }
      return native.listCodebaseIndexedFiles(projectId.trim(), page, pageSize);
    },
  );
  ipcMain.handle(
    "codebase:get-sphere-layout",
    (_event, projectId: unknown, limit: unknown) => {
      if (typeof projectId !== "string" || !projectId.trim()) {
        throw new Error("Project id is required");
      }
      if (
        typeof limit !== "number" ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 2000
      ) {
        throw new Error("Limit must be an integer between 1 and 2000");
      }
      return native.getCodebaseSphereLayout(projectId.trim(), limit);
    },
  );
  ipcMain.handle("codebase:clear-index", (_event, projectId: unknown) => {
    if (typeof projectId !== "string" || !projectId.trim()) {
      throw new Error("Project id is required");
    }
    return native.clearCodebaseIndex(projectId.trim());
  });
  ipcMain.handle(
    "codebase:start-watch",
    (event, projectId: unknown, projectPath: unknown) => {
      if (typeof projectId !== "string" || !projectId.trim()) {
        throw new Error("Project id is required");
      }
      if (typeof projectPath !== "string" || !projectPath.trim()) {
        throw new Error("Project path is required");
      }
      const normalizedProjectId = projectId.trim();
      const normalizedProjectPath = projectPath.trim();
      native.startCodebaseWatch(
        normalizedProjectId,
        normalizedProjectPath,
        (changedProjectId: string) => {
          safeSend(event.sender, "codebase:files-changed", changedProjectId);
        },
      );
    },
  );
  ipcMain.handle("codebase:stop-watch", (_event, projectId: unknown) => {
    if (typeof projectId !== "string" || !projectId.trim()) {
      throw new Error("Project id is required");
    }
    return native.stopCodebaseWatch(projectId.trim());
  });
  ipcMain.handle("codebase:cancel-sync", (_event, projectId: unknown) => {
    if (typeof projectId !== "string" || !projectId.trim()) {
      throw new Error("Project id is required");
    }
    return native.cancelCodebaseSync(projectId.trim());
  });
  ipcMain.handle("codebase:sync-changes", async (event, projectId: unknown) => {
    if (typeof projectId !== "string" || !projectId.trim()) {
      throw new Error("Project id is required");
    }
    const normalizedProjectId = projectId.trim();
    return native.syncCodebaseChanges(normalizedProjectId, (progress) => {
      safeSend(event.sender, "codebase:sync:progress", {
        projectId: normalizedProjectId,
        progress,
      });
    });
  });
  ipcMain.handle("codebase:preview-scan", (_event, projectId: unknown) => {
    if (typeof projectId !== "string" || !projectId.trim()) {
      throw new Error("Project id is required");
    }
    return native.previewCodebaseScan(projectId.trim());
  });
  ipcMain.handle(
    "codebase:get-resumable-sessions",
    (_event, projectId: unknown) => {
      if (typeof projectId !== "string" || !projectId.trim()) {
        throw new Error("Project id is required");
      }
      return native.getResumableCodebaseSessions(projectId.trim());
    },
  );
  ipcMain.handle(
    "codebase:discard-resumable-session",
    (_event, sessionId: unknown) => {
      if (typeof sessionId !== "string" || !sessionId.trim()) {
        throw new Error("Session id is required");
      }
      return native.discardResumableCodebaseSession(sessionId.trim());
    },
  );
  ipcMain.handle(
    "codebase:get-last-embed-failure",
    (_event, projectId: unknown) => {
      if (typeof projectId !== "string" || !projectId.trim()) {
        throw new Error("Project id is required");
      }
      return native.getLastCodebaseEmbedFailure(projectId.trim());
    },
  );
  ipcMain.handle(
    "permissions:list-tool-approvals",
    (_event, projectId: unknown) => {
      if (typeof projectId !== "string" || !projectId.trim()) {
        throw new Error("Project id is required");
      }
      return native.listToolApprovalProjectApprovedTools(projectId.trim());
    },
  );
  ipcMain.handle(
    "permissions:set-tool-approval",
    (_event, projectId: unknown, toolName: unknown, approved: unknown) => {
      if (typeof projectId !== "string" || !projectId.trim()) {
        throw new Error("Project id is required");
      }
      if (typeof toolName !== "string" || !toolName.trim()) {
        throw new Error("Tool name is required");
      }
      if (typeof approved !== "boolean") {
        throw new Error("Tool approval state must be a boolean");
      }
      return native.setToolApprovalProjectToolApproved(
        projectId.trim(),
        toolName.trim(),
        approved,
      );
    },
  );
  ipcMain.handle("permissions:get-always-approved-tools", () =>
    native.getAlwaysApprovedTools(),
  );
  ipcMain.handle(
    "permissions:set-tool-approvals",
    (_event, projectId: unknown, toolNames: unknown, approved: unknown) => {
      if (typeof projectId !== "string" || !projectId.trim()) {
        throw new Error("Project id is required");
      }
      if (
        !Array.isArray(toolNames) ||
        toolNames.some((name) => typeof name !== "string")
      ) {
        throw new Error("Tool names must be an array of strings");
      }
      if (typeof approved !== "boolean") {
        throw new Error("Tool approval state must be a boolean");
      }
      return native.setToolApprovalProjectToolsApproved(
        projectId.trim(),
        toolNames as string[],
        approved,
      );
    },
  );
  ipcMain.handle(
    "permissions:set-always-approved-tools",
    (_event, tools: unknown) => {
      if (
        !Array.isArray(tools) ||
        tools.some((tool) => typeof tool !== "string")
      ) {
        throw new Error("Tools must be an array of strings");
      }
      return native.setAlwaysApprovedTools(tools as string[]);
    },
  );
  ipcMain.handle("permissions:list-readonly-tools", () =>
    native.listReadonlyTools(),
  );

  ipcMain.handle("native:sum", (_event, a: number, b: number) =>
    native.sum(a, b),
  );
  ipcMain.handle("terminal:detect-terminals", () => native.detectTerminals());

  ipcMain.handle(
    "debug:write-log",
    (_event, level: unknown, entry: unknown) => {
      const logEntry = entry as Record<string, unknown>;
      const input: AppLogInput = {
        level: typeof level === "string" ? level : "INFO",
        module: typeof logEntry?.module === "string" ? logEntry.module : "",
        func: typeof logEntry?.func === "string" ? logEntry.func : "",
        line: typeof logEntry?.line === "number" ? logEntry.line : undefined,
        message: typeof logEntry?.message === "string" ? logEntry.message : "",
        input: typeof logEntry?.input === "string" ? logEntry.input : undefined,
        output:
          typeof logEntry?.output === "string" ? logEntry.output : undefined,
        duration:
          typeof logEntry?.duration === "string"
            ? logEntry.duration
            : undefined,
        context:
          typeof logEntry?.context === "string" ? logEntry.context : undefined,
        error: typeof logEntry?.error === "string" ? logEntry.error : undefined,
        source: "renderer",
      };
      return native.writeAppLog(input);
    },
  );

  ipcMain.handle(
    "scheduled-task:run-pre-script",
    (
      _event,
      command: unknown,
      cwd: unknown,
      timeoutMs: unknown,
      envJson: unknown,
    ) => {
      if (typeof command !== "string" || !command.trim()) {
        throw new Error("Pre-script command is required");
      }
      if (typeof cwd !== "string" || !cwd.trim()) {
        throw new Error("Pre-script cwd is required");
      }
      const timeout =
        typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
          ? Math.round(timeoutMs)
          : 60_000;
      const env = typeof envJson === "string" ? envJson : "{}";
      return native.runPreScript(command.trim(), cwd.trim(), timeout, env);
    },
  );

  ipcMain.handle("mcp:list-tools", () => native.listMcpTools());
  ipcMain.handle("mcp:correct-tool-call", (_event, request: unknown) => {
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw new Error("Tool correction request is required");
    }
    const record = request as Record<string, unknown>;
    const toolName =
      typeof record.toolName === "string" ? record.toolName.trim() : "";
    if (!toolName) {
      throw new Error("Tool name is required for tool-call correction");
    }
    const attemptsJson =
      typeof record.attemptsJson === "string" && record.attemptsJson.trim()
        ? record.attemptsJson
        : "[]";
    return native.correctToolCall({
      toolName,
      toolDescription:
        typeof record.toolDescription === "string"
          ? record.toolDescription
          : "",
      inputSchemaJson:
        typeof record.inputSchemaJson === "string"
          ? record.inputSchemaJson
          : "",
      originalArgumentsJson:
        typeof record.originalArgumentsJson === "string"
          ? record.originalArgumentsJson
          : "{}",
      failure: typeof record.failure === "string" ? record.failure : "",
      attemptsJson,
      attempt:
        typeof record.attempt === "number" && Number.isFinite(record.attempt)
          ? Math.max(1, Math.round(record.attempt))
          : 1,
      apiProfile:
        typeof record.apiProfile === "string" && record.apiProfile.trim()
          ? record.apiProfile.trim()
          : undefined,
      conversationId:
        typeof record.conversationId === "string" &&
        record.conversationId.trim()
          ? record.conversationId.trim()
          : undefined,
    });
  });
  ipcMain.handle("chat:predict-reply", (_event, request: unknown) => {
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw new Error("Reply prediction request is required");
    }
    const record = request as Record<string, unknown>;
    const requestId =
      typeof record.requestId === "string" ? record.requestId.trim() : "";
    const conversationId =
      typeof record.conversationId === "string"
        ? record.conversationId.trim()
        : "";
    if (!requestId || !conversationId) {
      throw new Error("Reply prediction requires requestId and conversationId");
    }
    return native.predictReply({
      requestId,
      conversationId,
      apiProfile:
        typeof record.apiProfile === "string" && record.apiProfile.trim()
          ? record.apiProfile.trim()
          : undefined,
    });
  });
  ipcMain.handle("chat:abort-reply-prediction", (_event, requestId: unknown) =>
    typeof requestId === "string" && requestId
      ? native.abortReplyPrediction(requestId)
      : false,
  );
  ipcMain.handle("skills:list", (_event, projectId: unknown) => {
    if (
      projectId !== undefined &&
      (typeof projectId !== "string" || !projectId.trim())
    ) {
      throw new Error("Project id must be a non-empty string");
    }

    return native.listAvailableSkills(
      typeof projectId === "string" ? projectId.trim() : undefined,
    );
  });
  ipcMain.handle(
    "skills:set-enabled",
    (_event, projectId: unknown, skillId: unknown, enabled: unknown) => {
      if (
        projectId !== undefined &&
        (typeof projectId !== "string" || !projectId.trim())
      ) {
        throw new Error("Project id must be a non-empty string");
      }
      if (typeof skillId !== "string" || !skillId.trim()) {
        throw new Error("Skill id is required");
      }
      if (typeof enabled !== "boolean") {
        throw new Error("Skill enabled state must be a boolean");
      }

      return native.setSkillEnabled(
        typeof projectId === "string" ? projectId.trim() : undefined,
        skillId.trim(),
        enabled,
      );
    },
  );
  ipcMain.handle("skills:list-project", (_event, projectId: unknown) => {
    if (typeof projectId !== "string" || !projectId.trim()) {
      throw new Error("Project id is required");
    }
    return native.listProjectSkills(projectId.trim());
  });
  ipcMain.handle(
    "skills:set-project-enabled",
    (_event, projectId: unknown, skillId: unknown, enabled: unknown) => {
      if (typeof projectId !== "string" || !projectId.trim()) {
        throw new Error("Project id is required");
      }
      if (typeof skillId !== "string" || !skillId.trim()) {
        throw new Error("Skill id is required");
      }
      if (typeof enabled !== "boolean") {
        throw new Error("Skill enabled state must be a boolean");
      }
      return native.setProjectSkillEnabled(
        projectId.trim(),
        skillId.trim(),
        enabled,
      );
    },
  );
  ipcMain.handle(
    "skills:install-github",
    (_event, url: unknown, location: unknown, projectId: unknown) => {
      if (typeof url !== "string" || !url.trim()) {
        throw new Error("GitHub URL is required");
      }
      if (location !== "global" && location !== "project") {
        throw new Error('Location must be "global" or "project"');
      }
      if (
        projectId !== undefined &&
        (typeof projectId !== "string" || !projectId.trim())
      ) {
        throw new Error("Project id must be a non-empty string");
      }
      return native.installSkillFromGithub(
        url.trim(),
        location,
        typeof projectId === "string" ? projectId.trim() : undefined,
      );
    },
  );
  ipcMain.handle(
    "skills:uninstall-github",
    (_event, skillId: unknown, projectId: unknown) => {
      if (typeof skillId !== "string" || !skillId.trim()) {
        throw new Error("Skill id is required");
      }
      if (
        projectId !== undefined &&
        (typeof projectId !== "string" || !projectId.trim())
      ) {
        throw new Error("Project id must be a non-empty string");
      }
      return native.uninstallGithubSkill(
        skillId.trim(),
        typeof projectId === "string" ? projectId.trim() : undefined,
      );
    },
  );
  ipcMain.handle("skills:list-github", () => native.listGithubSkills());
  ipcMain.handle("mcp:list-server-tools", (_event, configServerId: unknown) => {
    if (typeof configServerId !== "string" || !configServerId.trim()) {
      throw new Error("MCP server id is required");
    }

    return native.listMcpServerTools(configServerId.trim());
  });
  // 自定义 API MCP：按草稿发送测试请求
  ipcMain.handle("mcp:test-api-endpoint", (_event, input: unknown) => {
    if (!input || typeof input !== "object") {
      throw new Error("Test input is required");
    }
    const source = input as Record<string, unknown>;
    const text = (value: unknown): string =>
      typeof value === "string" ? value : "";
    const endpointIndex = Number(source.endpointIndex);
    if (!Number.isInteger(endpointIndex) || endpointIndex < 0) {
      throw new Error("Endpoint index is invalid");
    }
    const timeoutMs = Number(source.timeoutMs);
    return native.testMcpApiEndpoint({
      baseUrl: text(source.baseUrl),
      headersJson: text(source.headersJson) || "{}",
      specJson: text(source.specJson) || "{}",
      endpointIndex,
      argumentsJson: text(source.argumentsJson) || "{}",
      ...(Number.isInteger(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {}),
    });
  });
  ipcMain.handle("mcp:list-project-servers", (_event, projectId: unknown) => {
    if (typeof projectId !== "string" || !projectId.trim()) {
      throw new Error("Project id is required");
    }

    return native.listMcpProjectServers(projectId.trim());
  });
  ipcMain.handle("mcp:list-global-servers", () =>
    native.listMcpGlobalServers(),
  );
  ipcMain.handle("mcp:list-global-builtin-servers", () =>
    native.listMcpGlobalBuiltinServers(),
  );
  ipcMain.handle(
    "mcp:diagnose-sub-agent-tools",
    (_event, projectId: unknown, toolsJson: unknown) => {
      if (typeof toolsJson !== "string") {
        throw new Error("Sub-agent toolsJson is required");
      }
      const scopedProjectId =
        typeof projectId === "string" && projectId.trim()
          ? projectId.trim()
          : undefined;
      return native.diagnoseSubAgentTools(scopedProjectId, toolsJson);
    },
  );
  // 快速列表：只读 Rust 端进程内工具发现缓存，未命中的服务器由渲染层
  // 后台逐台补发现（保存 / 启停 / 删除配置后的刷新走这里，不阻塞 UI）。
  ipcMain.handle(
    "mcp:list-project-servers-cached",
    (_event, projectId: unknown) => {
      if (typeof projectId !== "string" || !projectId.trim()) {
        throw new Error("Project id is required");
      }

      return native.listMcpProjectServersCached(projectId.trim());
    },
  );
  ipcMain.handle(
    "mcp:list-project-server-tools",
    (_event, projectId: unknown, serverId: unknown) => {
      if (typeof projectId !== "string" || !projectId.trim()) {
        throw new Error("Project id is required");
      }
      if (typeof serverId !== "string" || !serverId.trim()) {
        throw new Error("MCP server id is required");
      }

      return native.listMcpProjectServerTools(
        projectId.trim(),
        serverId.trim(),
      );
    },
  );
  ipcMain.handle(
    "mcp:set-project-server-enabled",
    (_event, projectId: unknown, serverId: unknown, enabled: unknown) => {
      if (typeof projectId !== "string" || !projectId.trim()) {
        throw new Error("Project id is required");
      }
      if (typeof serverId !== "string" || !serverId.trim()) {
        throw new Error("MCP server id is required");
      }
      if (typeof enabled !== "boolean") {
        throw new Error("MCP server enabled state must be a boolean");
      }

      return native.setMcpProjectServerEnabled(
        projectId.trim(),
        serverId.trim(),
        enabled,
      );
    },
  );
  ipcMain.handle(
    "mcp:set-global-server-enabled",
    (_event, serverId: unknown, enabled: unknown) => {
      if (typeof serverId !== "string" || !serverId.trim()) {
        throw new Error("MCP server id is required");
      }
      if (typeof enabled !== "boolean") {
        throw new Error("MCP server enabled state must be a boolean");
      }

      return native.setMcpGlobalServerEnabled(serverId.trim(), enabled);
    },
  );
  ipcMain.handle(
    "mcp:set-project-tool-enabled",
    (_event, projectId: unknown, toolName: unknown, enabled: unknown) => {
      if (typeof projectId !== "string" || !projectId.trim()) {
        throw new Error("Project id is required");
      }
      if (typeof toolName !== "string" || !toolName.trim()) {
        throw new Error("MCP tool name is required");
      }
      if (typeof enabled !== "boolean") {
        throw new Error("MCP tool enabled state must be a boolean");
      }

      return native.setMcpProjectToolEnabled(
        projectId.trim(),
        toolName.trim(),
        enabled,
      );
    },
  );
  ipcMain.handle(
    "mcp:set-tool-enabled",
    (_event, toolName: unknown, enabled: unknown) => {
      if (typeof toolName !== "string" || !toolName.trim()) {
        throw new Error("MCP tool name is required");
      }
      if (typeof enabled !== "boolean") {
        throw new Error("MCP tool enabled state must be a boolean");
      }

      return native.setMcpToolEnabled(toolName.trim(), enabled);
    },
  );
  ipcMain.handle(
    "mcp:set-tools-enabled",
    (_event, toolNames: unknown, enabled: unknown) => {
      if (
        !Array.isArray(toolNames) ||
        toolNames.length === 0 ||
        toolNames.some((name) => typeof name !== "string" || !name.trim())
      ) {
        throw new Error("MCP tool names must be a non-empty array of strings");
      }
      if (typeof enabled !== "boolean") {
        throw new Error("MCP tool enabled state must be a boolean");
      }

      return native.setMcpToolsEnabled(
        toolNames.map((name) => name.trim()),
        enabled,
      );
    },
  );
  ipcMain.handle(
    "mcp:set-project-tools-enabled",
    (_event, projectId: unknown, toolNames: unknown, enabled: unknown) => {
      if (typeof projectId !== "string" || !projectId.trim()) {
        throw new Error("Project id is required");
      }
      if (
        !Array.isArray(toolNames) ||
        toolNames.length === 0 ||
        toolNames.some((name) => typeof name !== "string" || !name.trim())
      ) {
        throw new Error("MCP tool names must be a non-empty array of strings");
      }
      if (typeof enabled !== "boolean") {
        throw new Error("MCP tool enabled state must be a boolean");
      }

      return native.setMcpProjectToolsEnabled(
        projectId.trim(),
        toolNames.map((name) => name.trim()),
        enabled,
      );
    },
  );
  ipcMain.handle("browser:renderer-register", (event) => {
    registerBrowserRenderer(event.sender);
  });
  ipcMain.handle("browser:renderer-unregister", (event) => {
    unregisterBrowserRenderer(event.sender);
  });
  // 渲染端注册/注销 MCP 浏览器实例时上报归属，供命令按 instanceId 路由
  // （浏览器 tab 弹出到独立窗口后，命令须转发给持有该实例的新窗口）。
  ipcMain.on("browser:instance-registered", (event, instanceId: unknown) => {
    if (typeof instanceId === "string" && instanceId.trim()) {
      registerBrowserInstanceRenderer(instanceId.trim(), event.sender);
    }
  });
  ipcMain.on("browser:instance-unregistered", (event, instanceId: unknown) => {
    if (typeof instanceId === "string" && instanceId.trim()) {
      unregisterBrowserInstanceRenderer(instanceId.trim(), event.sender);
    }
  });
  ipcMain.on(
    BROWSER_COMMAND_RESPONSE_CHANNEL,
    (event, response: BrowserCommandResponse) => {
      if (!response || typeof response.commandId !== "string") {
        return;
      }
      resolveBrowserCommand(event.sender, response);
    },
  );
  ipcMain.handle("terminal:renderer-register", (event) => {
    registerTerminalRenderer(event.sender);
  });
  ipcMain.handle("terminal:renderer-unregister", (event) => {
    unregisterTerminalRenderer(event.sender);
  });
  // 终端 tab 挂载/卸载时上报归属（tab 迁移到独立面板窗口后据此路由 MCP 命令）。
  ipcMain.on("terminal:tab-registered", (event, tabId: unknown) => {
    if (typeof tabId === "string" && tabId.trim()) {
      registerTerminalTabRenderer(tabId.trim(), event.sender);
    }
  });
  ipcMain.on("terminal:tab-unregistered", (event, tabId: unknown) => {
    if (typeof tabId === "string" && tabId.trim()) {
      unregisterTerminalTabRenderer(tabId.trim(), event.sender);
    }
  });
  ipcMain.on(
    TERMINAL_COMMAND_RESPONSE_CHANNEL,
    (event, response: TerminalCommandResponse) => {
      if (!response || typeof response.commandId !== "string") {
        return;
      }
      resolveTerminalCommand(event.sender, response);
    },
  );
  ipcMain.on(
    USER_QUESTION_RESPONSE_CHANNEL,
    (event, response: UserQuestionResponse) => {
      if (!response || typeof response.questionId !== "string") {
        return;
      }
      resolveUserQuestion(event.sender, response);
    },
  );
  ipcMain.on(
    APP_CONTROL_RESPONSE_CHANNEL,
    (
      event,
      response: { requestId: string; resultJson?: string; error?: string },
    ) => {
      if (!response || typeof response.requestId !== "string") {
        return;
      }
      resolveAppControl(event.sender, response);
    },
  );
  ipcMain.handle(
    "mcp:authorize-sensitive-command",
    async (_event, command: unknown) => {
      if (typeof command !== "string" || !command.trim()) {
        throw new Error("Sensitive command is required");
      }

      const token = randomUUID();
      await native.authorizeSensitiveCommand(command, token);
      return token;
    },
  );
  ipcMain.handle(
    "mcp:write-interactive-stdin",
    async (_event, sessionId: unknown, input: unknown) => {
      if (typeof sessionId !== "string" || !sessionId.trim()) {
        throw new Error("Session ID is required");
      }
      if (typeof input !== "string") {
        throw new Error("Input must be a string");
      }

      await native.writeInteractiveStdin(sessionId.trim(), input);
    },
  );
  ipcMain.handle(
    "mcp:abort-tool-execution",
    (_event, toolExecutionId: unknown, reason: unknown) => {
      if (typeof toolExecutionId !== "string" || !toolExecutionId.trim()) {
        throw new Error("Tool execution ID is required");
      }
      const normalizedToolExecutionId = toolExecutionId.trim();
      // Why the abort happened: "timeout" (renderer countdown watchdog) or
      // "shutdown" vs the default "user" (stop button / session abort). The
      // Rust executor records it so an automatic timeout is never reported
      // as a user cancellation.
      const normalizedReason =
        reason === "timeout" || reason === "shutdown" ? reason : "user";
      // Cancel any in-flight SSH command for this execution first so the
      // Electron-side promise settles (exec channel closed) instead of
      // waiting forever; the Rust-side token is cancelled right after.
      abortSshCommand(normalizedToolExecutionId);
      return native.abortToolExecution(
        normalizedToolExecutionId,
        normalizedReason,
      );
    },
  );
  ipcMain.handle(
    "mcp:call-tool",
    async (
      event,
      toolFullName: unknown,
      argsJson: unknown,
      projectId: unknown,
      checkpointIds: unknown,
      checkpointWorkDir: unknown,
      sensitiveAuthorizationToken: unknown,
      streamId: unknown,
      interactionId: unknown,
      subAgentAllowedTools: unknown,
      conversationId: unknown,
    ) => {
      if (typeof toolFullName !== "string" || !toolFullName.trim()) {
        throw new Error("Tool full name is required");
      }
      if (typeof argsJson !== "string") {
        throw new Error("Arguments JSON string is required");
      }
      if (
        projectId !== undefined &&
        (typeof projectId !== "string" || !projectId.trim())
      ) {
        throw new Error("Project id must be a non-empty string");
      }
      if (
        checkpointIds !== undefined &&
        (!Array.isArray(checkpointIds) ||
          checkpointIds.some((id) => typeof id !== "string" || !id.trim()))
      ) {
        throw new Error("Checkpoint ids must be non-empty strings");
      }
      if (
        checkpointWorkDir !== undefined &&
        (typeof checkpointWorkDir !== "string" || !checkpointWorkDir.trim())
      ) {
        throw new Error("Checkpoint working directory must be a string");
      }
      if (
        sensitiveAuthorizationToken !== undefined &&
        (typeof sensitiveAuthorizationToken !== "string" ||
          !sensitiveAuthorizationToken.trim())
      ) {
        throw new Error(
          "Sensitive command authorization token must be a string",
        );
      }
      if (typeof streamId !== "string" || !streamId.trim()) {
        throw new Error("Tool stream ID is required");
      }
      if (typeof interactionId !== "string" || !interactionId.trim()) {
        throw new Error("Tool interaction ID is required");
      }
      if (
        conversationId !== undefined &&
        (typeof conversationId !== "string" || !conversationId.trim())
      ) {
        throw new Error("Conversation id must be a non-empty string");
      }

      const normalizedStreamId = streamId.trim();
      const normalizedInteractionId = interactionId.trim();
      const normalizedSubAgentAllowedTools =
        Array.isArray(subAgentAllowedTools) &&
        subAgentAllowedTools.every(
          (tool) => typeof tool === "string" && tool.trim(),
        )
          ? (subAgentAllowedTools as string[])
          : undefined;

      // One AbortController per tool call: remote workspace commands (SSH)
      // receive its signal so `abortToolExecution` can close the exec channel.
      // The Rust layer emits a `tool_execution` chunk with a UUID before any
      // remote command runs; we map every emitted id to this controller.
      const sshAbortController = new AbortController();
      const remoteExecutionIds = new Set<string>();
      const normalizedProjectId = (projectId as string | undefined)?.trim();
      const normalizedConversationId = (
        conversationId as string | undefined
      )?.trim();
      const runtimeArgsJson = injectImageGenerationContext(
        toolFullName.trim(),
        argsJson,
        normalizedConversationId ?? "",
        normalizedInteractionId,
      );
      const callPromise = native.callMcpTool(
        toolFullName.trim(),
        runtimeArgsJson,
        normalizedProjectId,
        (checkpointIds as string[] | undefined)?.map((id) => id.trim()),
        (checkpointWorkDir as string | undefined)?.trim(),
        (sensitiveAuthorizationToken as string | undefined)?.trim(),
        (chunk: BashStreamChunk) => {
          if (
            chunk.stream === "tool_execution" &&
            typeof chunk.data === "string" &&
            chunk.data.trim()
          ) {
            const executionId = chunk.data.trim();
            remoteExecutionIds.add(executionId);
            registerSshCommandAbort(executionId, sshAbortController);
          }
          forwardMcpToolChunk(
            event.sender,
            normalizedStreamId,
            normalizedConversationId ?? "",
            chunk,
          );
        },
        (command: BrowserCommand) =>
          dispatchBrowserCommand(event.sender, command),
        (command: WebSearchCommand) =>
          dispatchWebSearchCommand(native, command),
        (question: UserQuestionCommand) =>
          dispatchUserQuestion(event.sender, question, normalizedInteractionId),
        (command: AppControlCommand) =>
          dispatchAppControl(event.sender, command),
        (command) =>
          dispatchRemoteWorkspaceCommand(command, {
            signal: sshAbortController.signal,
          }),
        (command: TerminalCommand) =>
          dispatchTerminalCommand(event.sender, command),
        normalizedSubAgentAllowedTools,
        normalizedConversationId,
      );

      try {
        const result = await callPromise;
        // memory 写工具成功后广播记忆变更：AI 可在主对话/子代理/工作流
        // 任意路径改库，仅此处统一可见，侧边栏徽标据此刷新。
        const toolName = toolFullName.trim();
        if (
          toolName === "memory-save" ||
          toolName === "memory-update" ||
          toolName === "memory-delete"
        ) {
          safeSend(event.sender, "memories:changed", normalizedProjectId);
        }
        // 插件安装/启停/卸载（config-set / config-delete 的 plugins 作用域）
        // 成功后广播插件变更：AI 同样可在主对话/子代理/定时任务任意路径改库，
        // 渲染层的插件列表与侧边栏插件徽标仅在此处能感知。
        if (
          (toolName === "config-set" || toolName === "config-delete") &&
          readConfigScope(argsJson) === "plugins"
        ) {
          safeSend(event.sender, "plugins:changed");
        }
        // 用户脚本（config-set / config-delete 的 userscripts 作用域）：AI 可
        // 直接安装客户端脚本，刷新匹配缓存并广播，让脚本列表与注入立即生效。
        if (
          (toolName === "config-set" || toolName === "config-delete") &&
          readConfigScope(argsJson) === "userscripts"
        ) {
          refreshUserscriptSyncStore(native);
          safeSend(event.sender, "userscripts:changed");
        }
        // 自定义命令（config-set / config-delete 的 customCommands 作用域）：
        // AI 写库后渲染层的命令面板与 / 菜单无从感知，广播后统一刷新。
        if (
          (toolName === "config-set" || toolName === "config-delete") &&
          readConfigScope(argsJson) === "customCommands"
        ) {
          safeSend(event.sender, "customCommands:changed");
        }
        // 备忘录（memos 作用域）：广播刷新备忘面板，delete 时附带被删 memoId。
        if (
          (toolName === "config-set" || toolName === "config-delete") &&
          readConfigScope(argsJson) === "memos"
        ) {
          safeSend(
            event.sender,
            "memos:changed",
            toolName === "config-delete" ? readConfigKeyList(argsJson) : [],
          );
        }
        // 流式指示器（streamCursor 作用域）写入主题设置：通知所有窗口重载主题。
        if (
          (toolName === "config-set" || toolName === "config-delete") &&
          readConfigScope(argsJson) === "streamCursor"
        ) {
          for (const win of BrowserWindow.getAllWindows()) {
            safeSend(win.webContents, "theme:settings-changed");
          }
        }
        return result;
      } finally {
        for (const executionId of remoteExecutionIds) {
          unregisterSshCommandAbort(executionId);
        }
      }
    },
  );

  ipcMain.handle("checkpoint:create", (_event, workDir: unknown) => {
    if (typeof workDir !== "string" || !workDir.trim()) {
      throw new Error(
        "Working directory path is required to create checkpoint",
      );
    }
    return native.createCheckpoint(workDir);
  });
  ipcMain.handle(
    "checkpoint:restore",
    (_event, checkpointId: unknown, workDir: unknown) => {
      if (typeof checkpointId !== "string" || !checkpointId.trim()) {
        throw new Error("Checkpoint id is required to restore checkpoint");
      }
      if (typeof workDir !== "string" || !workDir.trim()) {
        throw new Error(
          "Working directory path is required to restore checkpoint",
        );
      }
      return native.restoreCheckpoint(checkpointId.trim(), workDir);
    },
  );
  ipcMain.handle(
    "checkpoint:restore-batch",
    (_event, checkpointIds: unknown, workDir: unknown) => {
      if (
        !Array.isArray(checkpointIds) ||
        checkpointIds.length === 0 ||
        checkpointIds.some((id) => typeof id !== "string" || !id.trim())
      ) {
        throw new Error("Checkpoint ids must be a non-empty string array");
      }
      if (typeof workDir !== "string" || !workDir.trim()) {
        throw new Error(
          "Working directory path is required to restore checkpoints",
        );
      }
      return native.restoreCheckpoints(
        checkpointIds.map((id) => id.trim()),
        workDir.trim(),
      );
    },
  );
  ipcMain.handle("checkpoint:delete", (_event, checkpointId: unknown) => {
    if (typeof checkpointId !== "string" || !checkpointId.trim()) {
      throw new Error("Checkpoint id is required to delete checkpoint");
    }
    return native.deleteCheckpoint(checkpointId.trim());
  });
  ipcMain.handle(
    "checkpoint:list-changes",
    (_event, checkpointId: unknown, workDir: unknown) => {
      if (typeof checkpointId !== "string" || !checkpointId.trim()) {
        throw new Error("Checkpoint id is required to list changes");
      }
      if (typeof workDir !== "string" || !workDir.trim()) {
        throw new Error(
          "Working directory path is required to list checkpoint changes",
        );
      }
      return native.listCheckpointChanges(checkpointId.trim(), workDir);
    },
  );
  ipcMain.handle(
    "checkpoint:list-changes-batch",
    (_event, checkpointIds: unknown, workDir: unknown, includeAll: unknown) => {
      if (
        !Array.isArray(checkpointIds) ||
        checkpointIds.length === 0 ||
        checkpointIds.some((id) => typeof id !== "string" || !id.trim())
      ) {
        throw new Error("Checkpoint ids must be a non-empty string array");
      }
      if (typeof workDir !== "string" || !workDir.trim()) {
        throw new Error(
          "Working directory path is required to list checkpoint changes",
        );
      }
      if (includeAll !== undefined && typeof includeAll !== "boolean") {
        throw new Error("includeAll must be a boolean when provided");
      }
      return native.listCheckpointChangesBatch(
        checkpointIds.map((id) => id.trim()),
        workDir.trim(),
        includeAll === true,
      );
    },
  );
  ipcMain.handle(
    "checkpoint:list-summaries-batch",
    (_event, checkpointIds: unknown, workDir: unknown, includeAll: unknown) => {
      if (
        !Array.isArray(checkpointIds) ||
        checkpointIds.length === 0 ||
        checkpointIds.some((id) => typeof id !== "string" || !id.trim())
      ) {
        throw new Error("Checkpoint ids must be a non-empty string array");
      }
      if (typeof workDir !== "string" || !workDir.trim()) {
        throw new Error(
          "Working directory path is required to list checkpoint summaries",
        );
      }
      if (includeAll !== undefined && typeof includeAll !== "boolean") {
        throw new Error("includeAll must be a boolean when provided");
      }
      return native.listCheckpointSummariesBatch(
        checkpointIds.map((id) => id.trim()),
        workDir.trim(),
        includeAll === true,
      );
    },
  );

  ipcMain.handle(
    "checkpoint:read-diff-page",
    (
      _event,
      checkpointIds: unknown,
      workDir: unknown,
      path: unknown,
      startRow: unknown,
      maxRows: unknown,
      maxBytes: unknown,
    ) => {
      if (
        !Array.isArray(checkpointIds) ||
        checkpointIds.length === 0 ||
        checkpointIds.some((id) => typeof id !== "string" || !id.trim())
      ) {
        throw new Error("Checkpoint ids must be a non-empty string array");
      }
      if (typeof workDir !== "string" || !workDir.trim()) {
        throw new Error(
          "Working directory path is required to read checkpoint diff",
        );
      }
      if (typeof path !== "string" || !path) {
        throw new Error("File path is required to read checkpoint diff");
      }
      const isRowCount = (value: unknown): value is number =>
        typeof value === "number" && Number.isInteger(value) && value >= 0;
      if (
        !isRowCount(startRow) ||
        !isRowCount(maxRows) ||
        !isRowCount(maxBytes)
      ) {
        throw new Error(
          "startRow, maxRows and maxBytes must be non-negative integers",
        );
      }
      return native.readCheckpointDiffPage(
        checkpointIds.map((id) => id.trim()),
        workDir.trim(),
        path,
        startRow,
        maxRows,
        maxBytes,
      );
    },
  );

  ipcMain.handle(
    "usage:list-records",
    (
      _event,
      conversationId: unknown,
      directoryId: unknown,
      profileName: unknown,
      limit: unknown,
      offset: unknown,
    ) => {
      const convId =
        typeof conversationId === "string" ? conversationId.trim() : "";
      const dirId = typeof directoryId === "string" ? directoryId.trim() : "";
      const profile = typeof profileName === "string" ? profileName.trim() : "";
      const safeLimit = typeof limit === "number" && limit > 0 ? limit : 50;
      const safeOffset = typeof offset === "number" && offset > 0 ? offset : 0;
      return native.listUsageRecords(
        convId,
        dirId,
        profile,
        safeLimit,
        safeOffset,
      );
    },
  );

  ipcMain.handle(
    "usage:get-summary",
    (_event, since: unknown, until: unknown, profileName: unknown) => {
      const sinceStr = typeof since === "string" ? since.trim() : "";
      const untilStr = typeof until === "string" ? until.trim() : "";
      const profile = typeof profileName === "string" ? profileName.trim() : "";
      return native.getUsageSummary(sinceStr, untilStr, profile);
    },
  );

  ipcMain.handle(
    "usage:get-daily-breakdown",
    (_event, since: unknown, until: unknown, profileName: unknown) => {
      const sinceStr = typeof since === "string" ? since.trim() : "";
      const untilStr = typeof until === "string" ? until.trim() : "";
      const profile = typeof profileName === "string" ? profileName.trim() : "";
      return native.getUsageDailyBreakdown(sinceStr, untilStr, profile);
    },
  );

  ipcMain.handle(
    "usage:get-model-breakdown",
    (_event, since: unknown, until: unknown, profileName: unknown) => {
      const sinceStr = typeof since === "string" ? since.trim() : "";
      const untilStr = typeof until === "string" ? until.trim() : "";
      const profile = typeof profileName === "string" ? profileName.trim() : "";
      return native.getUsageModelBreakdown(sinceStr, untilStr, profile);
    },
  );

  ipcMain.handle("usage:list-profile-names", () =>
    native.listUsageProfileNames(),
  );

  ipcMain.handle(
    "usage:delete-records",
    (_event, since: unknown, until: unknown) => {
      const sinceStr = typeof since === "string" ? since.trim() : "";
      const untilStr = typeof until === "string" ? until.trim() : "";
      return native.deleteUsageRecords(sinceStr, untilStr);
    },
  );

  ipcMain.handle(
    "logs:list",
    (
      _event,
      level: unknown,
      module: unknown,
      since: unknown,
      until: unknown,
      limit: unknown,
      offset: unknown,
    ) => {
      const levelStr = typeof level === "string" ? level.trim() : "";
      const moduleStr = typeof module === "string" ? module.trim() : "";
      const sinceStr = typeof since === "string" ? since.trim() : "";
      const untilStr = typeof until === "string" ? until.trim() : "";
      const safeLimit = typeof limit === "number" && limit > 0 ? limit : 100;
      const safeOffset = typeof offset === "number" && offset > 0 ? offset : 0;
      return native.listAppLogs(
        levelStr,
        moduleStr,
        sinceStr,
        untilStr,
        safeLimit,
        safeOffset,
      );
    },
  );

  ipcMain.handle("logs:clear", () => native.clearAppLogs());

  ipcMain.handle("logs:list-modules", () => native.listAppLogModules());

  ipcMain.handle("settings:get-app-logs-retention-days", () =>
    native.getAppLogsRetentionDays(),
  );

  ipcMain.handle(
    "settings:set-app-logs-retention-days",
    (_event, days: unknown) => {
      const safeDays =
        typeof days === "number" && Number.isFinite(days)
          ? Math.max(0, Math.trunc(days))
          : 7;
      return native.setAppLogsRetentionDays(safeDays);
    },
  );

  ipcMain.handle("logs:prune", () => native.pruneAppLogs());

  // 导出系统日志：Rust 生成格式化内容，主进程负责保存对话框与写文件。
  ipcMain.handle(
    "logs:export",
    async (
      event,
      level: unknown,
      module: unknown,
      since: unknown,
      until: unknown,
      ids: unknown,
      format: unknown,
      groupByDay: unknown,
    ) => {
      const levelStr = typeof level === "string" ? level.trim() : "";
      const moduleStr = typeof module === "string" ? module.trim() : "";
      const sinceStr = typeof since === "string" ? since.trim() : "";
      const untilStr = typeof until === "string" ? until.trim() : "";
      const idList = Array.isArray(ids)
        ? ids
            .filter(
              (item): item is string =>
                typeof item === "string" && item.trim().length > 0,
            )
            .map((item) => item.trim())
        : [];
      const exportFormat = format === "json" ? "json" : "text";
      const extension = exportFormat === "json" ? "json" : "log";
      const fileLabel = exportFormat === "json" ? "JSON" : "Log";
      const perDay = groupByDay === true;

      const files = await native.exportAppLogs(
        levelStr,
        moduleStr,
        sinceStr,
        untilStr,
        idList,
        exportFormat,
        perDay,
      );
      if (files.length === 0) {
        return { canceled: false, files: [], count: 0 };
      }

      const browserWindow = BrowserWindow.fromWebContents(event.sender);
      const totalCount = files.reduce((sum, file) => sum + file.count, 0);

      // 按天拆分：选择一个目录，每天写一个文件。
      if (perDay) {
        const options: Electron.OpenDialogOptions = {
          title: "Export logs",
          properties: ["openDirectory", "createDirectory"],
        };
        const result = browserWindow
          ? await dialog.showOpenDialog(browserWindow, options)
          : await dialog.showOpenDialog(options);
        if (result.canceled || result.filePaths.length === 0) {
          return { canceled: true, files: [], count: 0 };
        }

        const directory = result.filePaths[0];
        const written: string[] = [];
        for (const file of files) {
          const target = join(directory, `${file.fileName}.${extension}`);
          await writeFile(target, file.content, "utf-8");
          written.push(target);
        }
        return { canceled: false, files: written, count: totalCount };
      }

      const now = new Date();
      const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(
        2,
        "0",
      )}${String(now.getDate()).padStart(2, "0")}`;
      const saveOptions: Electron.SaveDialogOptions = {
        title: "Export logs",
        defaultPath: `${files[0].fileName}-${stamp}.${extension}`,
        filters: [{ name: fileLabel, extensions: [extension] }],
      };
      const result = browserWindow
        ? await dialog.showSaveDialog(browserWindow, saveOptions)
        : await dialog.showSaveDialog(saveOptions);
      if (result.canceled || !result.filePath) {
        return { canceled: true, files: [], count: 0 };
      }

      await writeFile(result.filePath, files[0].content, "utf-8");
      return { canceled: false, files: [result.filePath], count: totalCount };
    },
  );
};
