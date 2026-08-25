import { app } from "electron";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { NativeBridge } from "./types";
import { storageReady } from "../app/storageReady";

const nativeRequire = createRequire(import.meta.url);

/**
 * Wraps a native binding in a Proxy that awaits `storageReady` before
 * invoking any method. This lets the window appear instantly while the
 * Rust SQLite database initialises in the background — IPC handlers
 * that call native methods will simply pause until storage is ready,
 * without each handler needing its own guard.
 */
const wrapWithStorageGate = <T extends object>(binding: T): T => {
  return new Proxy(binding, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") {
        return value;
      }
      return (...args: unknown[]) =>
        storageReady.then(() => value.apply(target, args));
    },
  }) as T;
};

let rawBinding: NativeBridge | null = null;

export const loadNativeBridge = (): NativeBridge => {
  try {
    const nativeEntry = join(app.getAppPath(), "native", "index.cjs");
    const binding: unknown = nativeRequire(nativeEntry);
    rawBinding = binding as NativeBridge;
    return wrapWithStorageGate(binding as NativeBridge);
  } catch (error) {
    console.warn(
      "Native Rust bridge is unavailable, using development fallback.",
      error,
    );

    return {
      initializeAppStorage: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to initialize Snow App storage",
          ),
        ),
      getSystemSettingValue: () =>
        Promise.reject(
          new Error("Rust native bridge is required to read system settings"),
        ),
      setSystemSetting: () =>
        Promise.reject(
          new Error("Rust native bridge is required to write system settings"),
        ),
      deleteSystemSetting: () =>
        Promise.reject(
          new Error("Rust native bridge is required to delete system settings"),
        ),
      getYoloMode: () =>
        Promise.reject(
          new Error("Rust native bridge is required to read YOLO mode"),
        ),
      setYoloMode: () =>
        Promise.reject(
          new Error("Rust native bridge is required to write YOLO mode"),
        ),
      getLiteMode: () =>
        Promise.reject(
          new Error("Rust native bridge is required to read Lite mode"),
        ),
      setLiteMode: () =>
        Promise.reject(
          new Error("Rust native bridge is required to write Lite mode"),
        ),
      getAutoFormat: () =>
        Promise.reject(
          new Error("Rust native bridge is required to read Auto format"),
        ),
      setAutoFormat: () =>
        Promise.reject(
          new Error("Rust native bridge is required to write Auto format"),
        ),
      getConversationModes: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to read conversation modes",
          ),
        ),
      setConversationModes: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to write conversation modes",
          ),
        ),
      getConversationRuntimeConfig: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to read conversation runtime config",
          ),
        ),
      setConversationRuntimeConfig: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to write conversation runtime config",
          ),
        ),
      setConversationRunStats: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to write conversation run stats",
          ),
        ),
      resetConversationRunStats: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to reset conversation run stats",
          ),
        ),
      getRequestLogging: () =>
        Promise.reject(
          new Error("Rust native bridge is required to read Request logging"),
        ),
      getRequestLoggingExpiry: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to read Request logging expiry",
          ),
        ),
      setRequestLoggingExpiry: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to write Request logging expiry",
          ),
        ),
      setRequestLogging: () =>
        Promise.reject(
          new Error("Rust native bridge is required to write Request logging"),
        ),
      getPrivacySettings: () =>
        Promise.reject(
          new Error("Rust native bridge is required to read privacy settings"),
        ),
      setPrivacySettings: () =>
        Promise.reject(
          new Error("Rust native bridge is required to write privacy settings"),
        ),
      getThemeSettings: () =>
        Promise.reject(
          new Error("Rust native bridge is required to read theme settings"),
        ),
      setThemeSettings: () =>
        Promise.reject(
          new Error("Rust native bridge is required to write theme settings"),
        ),
      getKeyboardShortcutsSettings: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to read keyboard shortcuts settings",
          ),
        ),
      setKeyboardShortcutsSettings: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to write keyboard shortcuts settings",
          ),
        ),
      saveThemeBackgroundImage: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to save theme background image",
          ),
        ),
      deleteThemeBackgroundImage: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to delete theme background image",
          ),
        ),
      saveThemeStreamCursorSvg: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to save theme stream cursor SVG",
          ),
        ),
      deleteThemeStreamCursorSvg: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to delete theme stream cursor SVG",
          ),
        ),
      listToolApprovalProjectApprovedTools: () =>
        Promise.reject(
          new Error("Rust native bridge is required to read tool approvals"),
        ),
      setToolApprovalProjectToolApproved: () =>
        Promise.reject(
          new Error("Rust native bridge is required to write tool approvals"),
        ),
      setToolApprovalProjectToolsApproved: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to write tool approvals in batch",
          ),
        ),
      getAlwaysApprovedTools: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to read always-approved tools",
          ),
        ),
      setAlwaysApprovedTools: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to write always-approved tools",
          ),
        ),
      listReadonlyTools: () =>
        Promise.reject(
          new Error("Rust native bridge is required to list read-only tools"),
        ),
      listApiConfigs: () =>
        Promise.reject(
          new Error("Rust native bridge is required to list API configs"),
        ),
      upsertApiConfig: () =>
        Promise.reject(
          new Error("Rust native bridge is required to write API configs"),
        ),
      deleteApiConfig: () =>
        Promise.reject(
          new Error("Rust native bridge is required to delete API configs"),
        ),
      listSystemPrompts: () =>
        Promise.reject(
          new Error("Rust native bridge is required to list system prompts"),
        ),
      upsertSystemPrompt: () =>
        Promise.reject(
          new Error("Rust native bridge is required to write system prompts"),
        ),
      deleteSystemPrompt: () =>
        Promise.reject(
          new Error("Rust native bridge is required to delete system prompts"),
        ),
      listCustomHeaderSchemes: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to list custom header schemes",
          ),
        ),
      upsertCustomHeaderScheme: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to write custom header schemes",
          ),
        ),
      deleteCustomHeaderScheme: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to delete custom header schemes",
          ),
        ),
      listWorkspaceDirectories: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to list workspace directories",
          ),
        ),
      upsertWorkspaceDirectory: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to write workspace directories",
          ),
        ),
      activateWorkspaceDirectory: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to activate workspace directories",
          ),
        ),
      reorderWorkspaceDirectories: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to reorder workspace directories",
          ),
        ),
      deleteWorkspaceDirectory: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to delete workspace directories",
          ),
        ),
      listProjectCollections: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to list project collections",
          ),
        ),
      createProjectCollection: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to create project collections",
          ),
        ),
      renameProjectCollection: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to rename project collections",
          ),
        ),
      deleteProjectCollection: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to delete project collections",
          ),
        ),
      addProjectToCollection: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to add projects to collections",
          ),
        ),
      removeProjectFromCollection: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to remove projects from collections",
          ),
        ),
      listRemoteDrafts: () =>
        Promise.reject(
          new Error("Rust native bridge is required to list remote drafts"),
        ),
      upsertRemoteDraft: () =>
        Promise.reject(
          new Error("Rust native bridge is required to write remote drafts"),
        ),
      deleteRemoteDraft: () =>
        Promise.reject(
          new Error("Rust native bridge is required to delete remote drafts"),
        ),
      listInstalledIdes: () =>
        Promise.reject(
          new Error("Rust native bridge is required to detect installed IDEs"),
        ),
      openInIde: () =>
        Promise.reject(
          new Error("Rust native bridge is required to open projects in IDEs"),
        ),
      createProjectDirectory: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to create project directories",
          ),
        ),
      cloneGitRepository: () =>
        Promise.reject(
          new Error("Rust native bridge is required to clone git repositories"),
        ),
      readDirectoryEntries: () =>
        Promise.reject(
          new Error("Rust native bridge is required to read directory entries"),
        ),
      renameWorkspaceEntry: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to rename workspace entries",
          ),
        ),
      deleteWorkspaceEntry: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to delete workspace entries",
          ),
        ),
      deleteWorkspaceEntries: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to batch delete workspace entries",
          ),
        ),
      readFileContent: () =>
        Promise.reject(
          new Error("Rust native bridge is required to read file content"),
        ),
      writeFileContent: () =>
        Promise.reject(
          new Error("Rust native bridge is required to write file content"),
        ),
      searchFiles: () =>
        Promise.reject(
          new Error("Rust native bridge is required to search files"),
        ),
      searchFilesByAgent: (_query, _workspacePath, _onProgress) =>
        Promise.reject(
          new Error("Rust native bridge is required to run AI file search"),
        ),
      listMcpServerConfigs: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to list MCP server configs",
          ),
        ),
      upsertMcpServerConfig: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to write MCP server configs",
          ),
        ),
      deleteMcpServerConfig: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to delete MCP server configs",
          ),
        ),
      listProjectMcpServerConfigs: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to list project MCP server configs",
          ),
        ),
      upsertProjectMcpServerConfig: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to write project MCP server configs",
          ),
        ),
      deleteProjectMcpServerConfig: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to delete project MCP server configs",
          ),
        ),
      listLspServerConfigs: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to list LSP server configs",
          ),
        ),
      upsertLspServerConfig: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to write LSP server configs",
          ),
        ),
      deleteLspServerConfig: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to delete LSP server configs",
          ),
        ),
      listProjectLspServerConfigs: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to list project LSP server configs",
          ),
        ),
      upsertProjectLspServerConfig: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to write project LSP server configs",
          ),
        ),
      deleteProjectLspServerConfig: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to delete project LSP server configs",
          ),
        ),
      listEffectiveLspServerConfigs: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to list effective LSP server configs",
          ),
        ),
      probeLspServerCommands: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to probe LSP server commands",
          ),
        ),
      detectProjectStack: () =>
        Promise.reject(
          new Error("Rust native bridge is required to detect project stack"),
        ),
      listLspSessionStatuses: (_projectId?: string) =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to list LSP session statuses",
          ),
        ),
      listImportResources: () =>
        Promise.reject(
          new Error("Rust native bridge is required to list import resources"),
        ),
      upsertImportResources: () =>
        Promise.reject(
          new Error("Rust native bridge is required to write import resources"),
        ),
      commitImportTransaction: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to commit imported resources",
          ),
        ),
      releaseImportResource: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to release import resources",
          ),
        ),
      listPlugins: () =>
        Promise.reject(
          new Error("Rust native bridge is required to list plugins"),
        ),
      upsertPlugins: () =>
        Promise.reject(
          new Error("Rust native bridge is required to write plugins"),
        ),
      setPluginState: () =>
        Promise.reject(
          new Error("Rust native bridge is required to update plugins"),
        ),
      deletePlugin: () =>
        Promise.reject(
          new Error("Rust native bridge is required to delete plugins"),
        ),
      listPluginMarketplaces: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to list plugin marketplaces",
          ),
        ),
      upsertPluginMarketplace: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to write plugin marketplaces",
          ),
        ),
      deletePluginMarketplace: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to delete plugin marketplaces",
          ),
        ),
      listHookConfigs: () =>
        Promise.reject(
          new Error("Rust native bridge is required to list hook configs"),
        ),
      upsertHookConfig: () =>
        Promise.reject(
          new Error("Rust native bridge is required to write hook configs"),
        ),
      deleteHookConfig: () =>
        Promise.reject(
          new Error("Rust native bridge is required to delete hook configs"),
        ),
      executeHooks: () =>
        Promise.reject(
          new Error("Rust native bridge is required to execute hooks"),
        ),
      listSubAgentConfigs: () =>
        Promise.reject(
          new Error("Rust native bridge is required to list sub-agent configs"),
        ),
      getSubAgentConfig: () =>
        Promise.reject(
          new Error("Rust native bridge is required to get sub-agent config"),
        ),
      upsertSubAgentConfig: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to write sub-agent configs",
          ),
        ),
      deleteSubAgentConfig: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to delete sub-agent configs",
          ),
        ),
      listSensitiveCommandConfigs: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to list sensitive command configs",
          ),
        ),
      upsertSensitiveCommandConfig: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to write sensitive command configs",
          ),
        ),
      deleteSensitiveCommandConfig: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to delete sensitive command configs",
          ),
        ),
      resetSensitiveCommandConfigs: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to reset sensitive command configs",
          ),
        ),
      listProjectSensitiveCommandConfigs: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to list project sensitive command configs",
          ),
        ),
      setProjectSensitiveCommandEnabled: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to update project sensitive command state",
          ),
        ),
      upsertProjectSensitiveCommandConfig: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to write project sensitive command configs",
          ),
        ),
      deleteProjectSensitiveCommandConfig: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to delete project sensitive command configs",
          ),
        ),
      checkSensitiveCommandMatch: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to check sensitive command matches",
          ),
        ),
      listChatConversations: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to list chat conversations",
          ),
        ),
      listChatConversationsPaginated: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to list chat conversations paginated",
          ),
        ),
      listChatConversationsByIds: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to list chat conversations by ids",
          ),
        ),
      listPinnedConversations: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to list pinned conversations",
          ),
        ),
      searchChatConversations: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to search chat conversations",
          ),
        ),
      getChatConversation: () =>
        Promise.reject(
          new Error("Rust native bridge is required to get chat conversation"),
        ),
      previewConversationAttachment: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to preview conversation attachment",
          ),
        ),
      listSubAgentConversations: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to list sub-agent conversations",
          ),
        ),
      listSubAgentConversationsByParents: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to list sub-agent conversations by parents",
          ),
        ),
      createSubAgentSession: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to create sub-agent session",
          ),
        ),
      updateSubAgentSessionStatus: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to update sub-agent session status",
          ),
        ),
      cancelRunningSubAgentSessions: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to cancel interrupted sub-agent sessions",
          ),
        ),
      updateConversationStatus: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to update conversation status",
          ),
        ),
      renameConversation: () =>
        Promise.reject(
          new Error("Rust native bridge is required to rename conversation"),
        ),
      updateConversationEmoji: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to update conversation emoji",
          ),
        ),
      updateConversationApiProfile: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to update conversation API profile",
          ),
        ),
      deleteConversation: () =>
        Promise.reject(
          new Error("Rust native bridge is required to delete conversation"),
        ),
      deleteConversations: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to batch delete conversations",
          ),
        ),
      archiveConversations: () =>
        Promise.reject(
          new Error("Rust native bridge is required to archive conversations"),
        ),
      listArchivedConversationsPaginated: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to list archived conversations paginated",
          ),
        ),
      restoreArchivedConversations: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to restore archived conversations",
          ),
        ),
      deleteArchivedConversations: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to delete archived conversations",
          ),
        ),
      listChatMessages: () =>
        Promise.reject(
          new Error("Rust native bridge is required to list chat messages"),
        ),
      listUserMessages: () =>
        Promise.reject(
          new Error("Rust native bridge is required to list user messages"),
        ),
      listChatMessagesPaginated: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to list chat messages paginated",
          ),
        ),
      findLatestToolResult: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to find latest tool result",
          ),
        ),
      forkConversation: () =>
        Promise.reject(
          new Error("Rust native bridge is required to fork conversation"),
        ),
      generateConversationSummary: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to generate conversation summary",
          ),
        ),
      cancelConversationSummary: () => false,
      fetchAvailableModels: () =>
        Promise.reject(
          new Error("Rust native bridge is required to fetch available models"),
        ),
      fetchAvailableModelsForConfig: () =>
        Promise.reject(
          new Error("Rust native bridge is required to fetch available models"),
        ),
      createResponseStream: () =>
        Promise.reject(
          new Error("Rust native bridge is required to stream AI responses"),
        ),
      abortResponseStream: () => false,
      abortToolExecution: () => false,
      engineInfo: () => "Rust native bridge is not built yet",
      sum: (a: number, b: number) => a + b,
      detectTerminals: () =>
        Promise.reject(
          new Error("Rust native bridge is required to detect terminals"),
        ),
      getGitStatus: () => {
        throw new Error("Rust native bridge is required for git status");
      },
      getGitBranches: () => {
        throw new Error("Rust native bridge is required for git branches");
      },
      gitStageFiles: () => {
        throw new Error("Rust native bridge is required for git stage");
      },
      gitDiscardChanges: () => {
        throw new Error("Rust native bridge is required for git discard");
      },
      getGitLog: () => {
        throw new Error("Rust native bridge is required for git log");
      },
      getGitCommitFiles: () => {
        throw new Error("Rust native bridge is required for git commit files");
      },
      getCommitDiff: () => {
        throw new Error("Rust native bridge is required for git commit diff");
      },
      gitCommitFileDiff: () => {
        throw new Error(
          "Rust native bridge is required for git commit file diff",
        );
      },
      discoverGitRepos: () => {
        throw new Error(
          "Rust native bridge is required for git repo discovery",
        );
      },
      generateCommitMessage: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required for AI commit message generation",
          ),
        ),
      generateCommitMessageFromDiff: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required for AI commit message generation",
          ),
        ),
      generateThemePalette: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required for AI theme palette generation",
          ),
        ),
      gitStageAll: () => {
        throw new Error("Rust native bridge is required for git stage all");
      },
      gitUnstageAll: () => {
        throw new Error("Rust native bridge is required for git unstage all");
      },
      gitUnstageFiles: () =>
        Promise.reject(
          new Error("Rust native bridge is required for git unstage files"),
        ),
      gitCommit: () => {
        throw new Error("Rust native bridge is required for git commit");
      },
      gitPush: () => {
        throw new Error("Rust native bridge is required for git push");
      },
      gitPull: () => {
        throw new Error("Rust native bridge is required for git pull");
      },
      gitFetch: () => {
        throw new Error("Rust native bridge is required for git fetch");
      },
      gitCheckout: () => {
        throw new Error("Rust native bridge is required for git checkout");
      },
      gitCreateBranch: () => {
        throw new Error("Rust native bridge is required for git create branch");
      },
      gitFileDiff: () => {
        throw new Error("Rust native bridge is required for git file diff");
      },
      gitFileContent: () => {
        throw new Error("Rust native bridge is required for git file content");
      },
      startGitWatch: () => {
        throw new Error("Rust native bridge is required for git watch");
      },
      stopGitWatch: () => {
        throw new Error("Rust native bridge is required to stop git watch");
      },
      listMcpTools: () =>
        Promise.reject(
          new Error("Rust native bridge is required to list MCP tools"),
        ),
      listAvailableSkills: () =>
        Promise.reject(
          new Error("Rust native bridge is required to list Skills"),
        ),
      setSkillEnabled: () =>
        Promise.reject(
          new Error("Rust native bridge is required to update Skills"),
        ),
      listProjectSkills: () =>
        Promise.reject(
          new Error("Rust native bridge is required to list project Skills"),
        ),
      setProjectSkillEnabled: () =>
        Promise.reject(
          new Error("Rust native bridge is required to update project Skills"),
        ),
      installSkillFromGithub: () =>
        Promise.reject(
          new Error("Rust native bridge is required to install Skills"),
        ),
      uninstallGithubSkill: () =>
        Promise.reject(
          new Error("Rust native bridge is required to uninstall Skills"),
        ),
      listGithubSkills: () =>
        Promise.reject(
          new Error("Rust native bridge is required to list GitHub Skills"),
        ),
      listMcpServerTools: () =>
        Promise.reject(
          new Error("Rust native bridge is required to list MCP server tools"),
        ),
      listMcpProjectServers: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to list project MCP servers",
          ),
        ),
      listMcpProjectServerTools: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to list project MCP server tools",
          ),
        ),
      setMcpProjectServerEnabled: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to update project MCP servers",
          ),
        ),
      setMcpProjectToolEnabled: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to update project MCP tools",
          ),
        ),
      setMcpToolEnabled: () =>
        Promise.reject(
          new Error("Rust native bridge is required to update MCP tools"),
        ),
      setMcpToolsEnabled: () =>
        Promise.reject(
          new Error("Rust native bridge is required to batch update MCP tools"),
        ),
      setMcpProjectToolsEnabled: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to batch update project MCP tools",
          ),
        ),
      authorizeSensitiveCommand: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to authorize sensitive commands",
          ),
        ),
      writeInteractiveStdin: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to write interactive stdin",
          ),
        ),
      setCheckpointRemoteCallback: () => {
        // Fallback: no Rust bridge means no SSH checkpoint support.
      },
      callMcpTool: () =>
        Promise.reject(
          new Error("Rust native bridge is required to call MCP tools"),
        ),
      createCheckpoint: () =>
        Promise.reject(
          new Error("Rust native bridge is required to create checkpoint"),
        ),
      restoreCheckpoint: () =>
        Promise.reject(
          new Error("Rust native bridge is required to restore checkpoint"),
        ),
      restoreCheckpoints: () =>
        Promise.reject(
          new Error("Rust native bridge is required to restore checkpoints"),
        ),
      deleteCheckpoint: () =>
        Promise.reject(
          new Error("Rust native bridge is required to delete checkpoint"),
        ),
      listCheckpointChanges: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to list checkpoint changes",
          ),
        ),
      listCheckpointChangesBatch: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to list checkpoint changes in batch",
          ),
        ),
      listCheckpointDiffs: () =>
        Promise.reject(
          new Error("Rust native bridge is required to list checkpoint diffs"),
        ),
      listCheckpointDiffsBatch: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to list checkpoint diffs in batch",
          ),
        ),
      appendToolMessage: () =>
        Promise.reject(
          new Error("Rust native bridge is required to append a tool message"),
        ),
      truncateConversationFromResponse: () =>
        Promise.reject(
          new Error("Rust native bridge is required to truncate conversation"),
        ),
      truncateConversationFromMessage: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to truncate conversation from message",
          ),
        ),
      listTodosForRollback: () =>
        Promise.reject(
          new Error("Rust native bridge is required to list todos"),
        ),
      getCodebaseProjectScopeSettings: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to get codebase project scope settings",
          ),
        ),
      setCodebaseProjectEnabled: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to set codebase project enabled",
          ),
        ),
      setCodebaseProjectAgentReview: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to set codebase project agent review",
          ),
        ),
      setCodebaseProjectReranking: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to set codebase project reranking",
          ),
        ),
      checkProjectHasGitignore: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to check project .gitignore",
          ),
        ),
      checkProjectIsRemote: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to check project remote workspace",
          ),
        ),
      startCodebaseEmbedding: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to start codebase embedding",
          ),
        ),
      pauseCodebaseEmbedding: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to pause codebase embedding",
          ),
        ),
      resumeCodebaseEmbedding: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to resume codebase embedding",
          ),
        ),
      cancelCodebaseEmbedding: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to cancel codebase embedding",
          ),
        ),
      isCodebaseEmbeddingActive: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to check codebase embedding status",
          ),
        ),
      getCodebaseIndexStats: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to get codebase index stats",
          ),
        ),
      listCodebaseIndexedFiles: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to list codebase indexed files",
          ),
        ),
      getCodebaseSphereLayout: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to compute codebase sphere layout",
          ),
        ),
      clearCodebaseIndex: () =>
        Promise.reject(
          new Error("Rust native bridge is required to clear codebase index"),
        ),
      startCodebaseWatch: () => {
        throw new Error(
          "Rust native bridge is required to start codebase watch",
        );
      },
      stopCodebaseWatch: () => {
        throw new Error(
          "Rust native bridge is required to stop codebase watch",
        );
      },
      syncCodebaseChanges: () =>
        Promise.reject(
          new Error("Rust native bridge is required to sync codebase changes"),
        ),
      previewCodebaseScan: () =>
        Promise.reject(
          new Error("Rust native bridge is required to preview codebase scan"),
        ),
      getResumableCodebaseSessions: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to get resumable codebase sessions",
          ),
        ),
      discardResumableCodebaseSession: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to discard resumable codebase session",
          ),
        ),
      listUsageRecords: () =>
        Promise.reject(
          new Error("Rust native bridge is required to list usage records"),
        ),
      getUsageSummary: () =>
        Promise.reject(
          new Error("Rust native bridge is required to get usage summary"),
        ),
      getUsageDailyBreakdown: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to get usage daily breakdown",
          ),
        ),
      getUsageModelBreakdown: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to get usage model breakdown",
          ),
        ),
      deleteUsageRecords: () =>
        Promise.reject(
          new Error("Rust native bridge is required to delete usage records"),
        ),
      writeAppLog: () =>
        Promise.reject(
          new Error("Rust native bridge is required to write app logs"),
        ),
      runPreScript: () =>
        Promise.reject(
          new Error("Rust native bridge is required to run pre-scripts"),
        ),
      listAppLogs: () =>
        Promise.reject(
          new Error("Rust native bridge is required to list app logs"),
        ),
      clearAppLogs: () =>
        Promise.reject(
          new Error("Rust native bridge is required to clear app logs"),
        ),
      exportConversation: () =>
        Promise.reject(
          new Error("Rust native bridge is required to export conversation"),
        ),
      listMemos: () =>
        Promise.reject(
          new Error("Rust native bridge is required to list memos"),
        ),
      createMemo: () =>
        Promise.reject(
          new Error("Rust native bridge is required to create memo"),
        ),
      updateMemoContent: () =>
        Promise.reject(
          new Error("Rust native bridge is required to update memo content"),
        ),
      updateMemoStatus: () =>
        Promise.reject(
          new Error("Rust native bridge is required to update memo status"),
        ),
      deleteMemo: () =>
        Promise.reject(
          new Error("Rust native bridge is required to delete memo"),
        ),
      getMemoCountSummary: () =>
        Promise.reject(
          new Error("Rust native bridge is required to count memos"),
        ),
      listScheduledTasks: () =>
        Promise.reject(
          new Error("Rust native bridge is required to list scheduled tasks"),
        ),
      upsertScheduledTask: () =>
        Promise.reject(
          new Error("Rust native bridge is required to save scheduled tasks"),
        ),
      deleteScheduledTask: () =>
        Promise.reject(
          new Error("Rust native bridge is required to delete scheduled tasks"),
        ),
      clearScheduledTasks: () =>
        Promise.reject(
          new Error("Rust native bridge is required to clear scheduled tasks"),
        ),
      appendScheduledTaskRun: () =>
        Promise.reject(
          new Error("Rust native bridge is required to record task runs"),
        ),
      finalizeScheduledTaskRun: () =>
        Promise.reject(
          new Error("Rust native bridge is required to finalize task runs"),
        ),
      reconcileScheduledTaskRuns: () =>
        Promise.reject(
          new Error("Rust native bridge is required to reconcile task runs"),
        ),
      sha256File: () =>
        Promise.reject(
          new Error("Rust native bridge is required to compute sha256"),
        ),
      getImageLibraryRoot: () =>
        Promise.reject(
          new Error("Rust native bridge is required to read image library"),
        ),
      getImageLibraryDir: () =>
        Promise.reject(
          new Error("Rust native bridge is required to read image library dir"),
        ),
      setImageLibraryDir: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to write image library dir",
          ),
        ),
      listImageLibrary: () =>
        Promise.reject(
          new Error("Rust native bridge is required to list image library"),
        ),
      listImageAlbums: () =>
        Promise.reject(
          new Error("Rust native bridge is required to list image albums"),
        ),
      createImageAlbum: () =>
        Promise.reject(
          new Error("Rust native bridge is required to create image albums"),
        ),
      renameImageAlbum: () =>
        Promise.reject(
          new Error("Rust native bridge is required to rename image albums"),
        ),
      deleteImageAlbum: () =>
        Promise.reject(
          new Error("Rust native bridge is required to delete image albums"),
        ),
      setImageAlbum: () =>
        Promise.reject(
          new Error("Rust native bridge is required to manage image albums"),
        ),
      setImageAlbumCover: () =>
        Promise.reject(
          new Error("Rust native bridge is required to set album covers"),
        ),
      reorderImageAlbums: () =>
        Promise.reject(
          new Error("Rust native bridge is required to reorder image albums"),
        ),
      importImageFiles: () =>
        Promise.reject(
          new Error("Rust native bridge is required to import images"),
        ),
      readImageLibraryFile: () =>
        Promise.reject(
          new Error("Rust native bridge is required to read library images"),
        ),
      deleteImageLibraryImage: () =>
        Promise.reject(
          new Error("Rust native bridge is required to delete library images"),
        ),
      countConversationImages: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to count conversation images",
          ),
        ),
      deleteConversationImages: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to cascade-delete conversation images",
          ),
        ),
      prepareImageLibraryMigration: () =>
        Promise.reject(
          new Error("Rust native bridge is required to migrate image library"),
        ),
      migrateImageLibraryChunk: () =>
        Promise.reject(
          new Error("Rust native bridge is required to migrate image library"),
        ),
      commitImageLibraryMigration: () =>
        Promise.reject(
          new Error("Rust native bridge is required to migrate image library"),
        ),
      rollbackImageLibraryMigration: () =>
        Promise.reject(
          new Error("Rust native bridge is required to migrate image library"),
        ),
      getCheckpointDir: () =>
        Promise.reject(
          new Error("Rust native bridge is required to read checkpoint dir"),
        ),
      setCheckpointDir: () =>
        Promise.reject(
          new Error("Rust native bridge is required to write checkpoint dir"),
        ),
      getUploadDir: () =>
        Promise.reject(
          new Error("Rust native bridge is required to read upload dir"),
        ),
      setUploadDir: () =>
        Promise.reject(
          new Error("Rust native bridge is required to write upload dir"),
        ),
      getCheckpointRoot: () =>
        Promise.reject(
          new Error("Rust native bridge is required to read checkpoint root"),
        ),
      getUploadRoot: () =>
        Promise.reject(
          new Error("Rust native bridge is required to read upload root"),
        ),
      prepareStorageMigration: () =>
        Promise.reject(
          new Error("Rust native bridge is required to migrate storage dirs"),
        ),
      migrateStorageChunk: () =>
        Promise.reject(
          new Error("Rust native bridge is required to migrate storage dirs"),
        ),
      commitStorageMigration: () =>
        Promise.reject(
          new Error("Rust native bridge is required to migrate storage dirs"),
        ),
      rollbackStorageMigration: () =>
        Promise.reject(
          new Error("Rust native bridge is required to migrate storage dirs"),
        ),
      getPathSize: () =>
        Promise.reject(
          new Error("Rust native bridge is required to compute path size"),
        ),
      repairDatabase: () =>
        Promise.reject(
          new Error("Rust native bridge is required to repair databases"),
        ),
      browserImportListSources: () =>
        Promise.reject(
          new Error("Rust native bridge is required to probe browser sources"),
        ),
      browserImportPasswords: () =>
        Promise.reject(
          new Error(
            "Rust native bridge is required to import browser passwords",
          ),
        ),
      browserImportCookies: () =>
        Promise.reject(
          new Error("Rust native bridge is required to import browser cookies"),
        ),
      installPetFromZip: () =>
        Promise.reject(
          new Error("Rust native bridge is required to install pets"),
        ),
      listInstalledPets: () =>
        Promise.reject(
          new Error("Rust native bridge is required to list pets"),
        ),
      uninstallPet: () =>
        Promise.reject(
          new Error("Rust native bridge is required to uninstall pets"),
        ),
    };
  }
};

let actualNative: NativeBridge | null = null;

/**
 * Lazily loads the native binding on first access. This defers the
 * expensive require() of the ~12 MB Rust .node file until the first
 * method call, so module loading and window creation are not blocked.
 */
const ensureNativeLoaded = (): NativeBridge => {
  if (!actualNative) {
    actualNative = loadNativeBridge();
  }
  return actualNative;
};

/**
 * Lazy Proxy: defers .node file loading until first property access.
 * The inner Proxy from wrapWithStorageGate still gates on
 * storageReady for individual method calls.
 */
export const native = new Proxy({} as NativeBridge, {
  get(_target, prop) {
    const actual = ensureNativeLoaded();
    const value = (actual as Record<string | symbol, unknown>)[prop];
    return typeof value === "function" ? value.bind(actual) : value;
  },
}) as NativeBridge;

/**
 * Returns the raw (un-proxied) native binding. Used by
 * `initializeApplicationServices` to bootstrap storage without
 * deadlocking on the `storageReady` gate that the Proxy enforces.
 */
export const getRawNative = (): NativeBridge => {
  ensureNativeLoaded();
  return rawBinding ?? native;
};
