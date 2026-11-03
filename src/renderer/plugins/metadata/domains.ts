import type { Locale } from "../../../shared/locale";
import { pluginStore } from "../pluginStore";
import { runtimeSnapshot, type RuntimeSnapshot } from "../runtimeSnapshot";
import type { PluginView, SensitiveScope } from "../types";

export type MetadataContext = {
  locale: Locale;
  plugin: PluginView;
  params: Record<string, unknown>;
  snapshot: RuntimeSnapshot;
};

export type MetadataDomainDefinition = {
  id: string;
  /** 整域敏感：未声明对应隐私域时整个域返回失败。 */
  scope?: SensitiveScope;
  /** 字段级敏感：命中字段名的值在未声明时被剥离。 */
  sensitiveFields?: Record<string, SensitiveScope>;
  /** 依赖实时快照：快照变化时重新采集。 */
  live?: boolean;
  collect: (ctx: MetadataContext) => Promise<unknown>;
};

const safe = async <T>(producer: () => Promise<T>): Promise<T | null> => {
  try {
    return await producer();
  } catch {
    return null;
  }
};

const param = (ctx: MetadataContext, key: string, fallback: string): string => {
  const value = ctx.params[key];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
};

const projectId = (ctx: MetadataContext): string =>
  param(ctx, "projectId", ctx.snapshot.activeDirectory?.directoryId ?? "");

const projectPath = (ctx: MetadataContext): string =>
  param(ctx, "projectPath", ctx.snapshot.activeDirectory?.path ?? "");

const directoryId = (ctx: MetadataContext): string =>
  param(ctx, "directoryId", ctx.snapshot.activeDirectory?.directoryId ?? "");

const conversationId = (ctx: MetadataContext): string =>
  param(ctx, "conversationId", ctx.snapshot.conversation?.conversationId ?? "");

const numberParam = (
  ctx: MetadataContext,
  key: string,
  fallback: number,
): number => {
  const value = ctx.params[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
};

const stringParam = (ctx: MetadataContext, key: string, fallback: string) => {
  const value = ctx.params[key];
  return typeof value === "string" ? value : fallback;
};

const daysAgoIso = (days: number): string =>
  new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

export const METADATA_DOMAINS: MetadataDomainDefinition[] = [
  {
    id: "app",
    collect: async (ctx) => ({
      appVersion: await safe(() => window.snow.getAppVersion()),
      updateStatus: await safe(() => window.snow.getUpdateStatus()),
      engine: await safe(() => window.snow.engineInfo()),
      storageLocations: await safe(() => window.snow.getStorageLocations()),
      pluginsDirectory: await safe(() => window.snow.getPluginsDirectory()),
      locale: ctx.locale,
      language: navigator.language,
      platform: navigator.platform,
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      startedAt: performance.timeOrigin,
      now: Date.now(),
    }),
  },
  {
    id: "processes",
    sensitiveFields: { title: "privacyConfig", url: "privacyConfig" },
    collect: async () => {
      const snapshot = await safe(() => window.snow.getProcessSnapshot());
      if (!snapshot) {
        return null;
      }
      let totalMemoryBytes = 0;
      let totalCpuPercent = 0;
      let hasCpuBaseline = false;
      const processes = snapshot.map((entry) => {
        totalMemoryBytes += entry.memoryBytes;
        if (entry.cpuPercent >= 0) {
          totalCpuPercent += entry.cpuPercent;
          hasCpuBaseline = true;
        }
        return {
          pid: entry.pid,
          parentPid: entry.parentPid,
          name: entry.name,
          exePath: entry.exePath,
          kind: entry.kind,
          serviceName: entry.serviceName,
          title: entry.title,
          url: entry.url,
          cpuPercent: entry.cpuPercent,
          memoryBytes: entry.memoryBytes,
          threadCount: entry.threadCount,
          killable: entry.killable,
        };
      });
      return {
        count: processes.length,
        totalMemoryBytes,
        totalCpuPercent: hasCpuBaseline ? totalCpuPercent : null,
        processes,
      };
    },
  },
  {
    id: "theme",
    sensitiveFields: { backgroundValue: "privacyConfig" },
    collect: () => safe(() => window.snow.getThemeSettings()),
  },
  {
    id: "privacy",
    scope: "privacyConfig",
    collect: () => safe(() => window.snow.getPrivacySettings()),
  },
  {
    id: "settings",
    sensitiveFields: {
      proxyPassword: "privacyConfig",
      apiKey: "apiKeys",
    },
    collect: async (ctx) => ({
      liteMode: await safe(() => window.snow.getLiteMode()),
      autoFormat: await safe(() => window.snow.getAutoFormat()),
      toolCorrection: await safe(() => window.snow.getToolCorrection()),
      yoloMode: await safe(() => window.snow.getYoloMode()),
      requestLogging: {
        enabled: await safe(() => window.snow.getRequestLogging()),
        expiresAt: await safe(() => window.snow.getRequestLoggingExpiry()),
      },
      keyboardShortcuts: await safe(() =>
        window.snow.getKeyboardShortcutsSettings(),
      ),
      conversationModes: await safe(() =>
        window.snow.getConversationModes(conversationId(ctx)),
      ),
      conversationRuntime: await safe(() =>
        window.snow.getConversationRuntimeConfig(conversationId(ctx)),
      ),
      gitScan: await safe(() => window.snow.getGitScanSettings()),
      imageLibraryDir: await safe(() => window.snow.getImageLibraryDir()),
      storageLocations: await safe(() => window.snow.getStorageLocations()),
    }),
  },
  {
    id: "apiProfiles",
    sensitiveFields: {
      apiKey: "apiKeys",
      visionApiKey: "apiKeys",
    },
    collect: () => safe(() => window.snow.listApiConfigs()),
  },
  {
    // 渠道实时模型清单：用档案已保存的凭据向服务商拉取，只返回模型 ID，
    // 不返回密钥。仅在显式传入 profileName 时才发起网络请求。
    id: "apiModels",
    collect: async (ctx) => {
      const profileName = param(ctx, "profileName", "");
      if (!profileName) return null;
      const configs = await safe(() => window.snow.listApiConfigs());
      const config = configs?.find((item) => item.profileName === profileName);
      if (!config) return null;
      const models = await safe(() =>
        window.snow.fetchAvailableModelsForConfig({
          baseUrl: config.baseUrl,
          baseUrlMode: config.baseUrlMode,
          apiKey: config.apiKey,
          requestMethod: config.requestMethod,
          customHeaderSchemeId: config.customHeaderSchemeId,
          configJson:
            typeof config.configJson === "string" && config.configJson.trim()
              ? config.configJson
              : undefined,
        }),
      );
      return {
        profileName: config.profileName,
        models: models ? models.map((model) => model.id) : null,
      };
    },
  },
  {
    id: "systemPrompts",
    scope: "systemPrompts",
    collect: () => safe(() => window.snow.listSystemPrompts()),
  },
  {
    id: "customHeaders",
    scope: "customHeaders",
    collect: () => safe(() => window.snow.listCustomHeaderSchemes()),
  },
  {
    id: "mcp",
    sensitiveFields: {
      env: "mcpSecrets",
      headers: "mcpSecrets",
      url: "mcpSecrets",
    },
    collect: async (ctx) => ({
      servers: await safe(() => window.snow.listMcpServerConfigs()),
      projectServers: projectId(ctx)
        ? await safe(() =>
            window.snow.listProjectMcpServerConfigs(projectId(ctx)),
          )
        : null,
      tools: await safe(() => window.snow.listMcpTools()),
      projectServersWithTools: projectId(ctx)
        ? await safe(() => window.snow.listMcpProjectServers(projectId(ctx)))
        : null,
    }),
  },
  {
    id: "subAgents",
    sensitiveFields: {
      systemPrompt: "subAgents",
      toolsJson: "subAgents",
    },
    collect: (ctx) =>
      safe(() => window.snow.listSubAgentConfigs(projectId(ctx) || undefined)),
  },
  {
    id: "hooks",
    collect: async (ctx) => ({
      global: await safe(() => window.snow.listHookConfigs("global")),
      project: projectId(ctx)
        ? await safe(() =>
            window.snow.listHookConfigs("project", projectId(ctx)),
          )
        : null,
    }),
  },
  {
    id: "skills",
    collect: async (ctx) => ({
      available: await safe(() =>
        window.snow.listAvailableSkills(projectId(ctx) || undefined),
      ),
      project: projectId(ctx)
        ? await safe(() => window.snow.listProjectSkills(projectId(ctx)))
        : null,
    }),
  },
  {
    id: "lsp",
    collect: async (ctx) => ({
      servers: await safe(() => window.snow.listLspServerConfigs()),
      effective: await safe(() =>
        window.snow.listEffectiveLspServerConfigs(projectId(ctx) || undefined),
      ),
      sessions: await safe(() =>
        window.snow.listLspSessionStatuses(projectId(ctx) || undefined),
      ),
    }),
  },
  {
    id: "permissions",
    collect: async (ctx) => ({
      alwaysApprovedTools: await safe(() =>
        window.snow.getAlwaysApprovedTools(),
      ),
      readonlyTools: await safe(() => window.snow.listReadonlyTools()),
      projectApprovedTools: projectId(ctx)
        ? await safe(() =>
            window.snow.listToolApprovalProjectApprovedTools(projectId(ctx)),
          )
        : null,
      sensitiveCommands: await safe(() =>
        window.snow.listSensitiveCommandConfigs(),
      ),
    }),
  },
  {
    id: "codebase",
    collect: async (ctx) => ({
      projectScope: projectId(ctx)
        ? await safe(() =>
            window.snow.getCodebaseProjectScopeSettings(projectId(ctx)),
          )
        : null,
      indexStats: projectId(ctx)
        ? await safe(() => window.snow.getCodebaseIndexStats(projectId(ctx)))
        : null,
      indexedFiles: projectId(ctx)
        ? await safe(() =>
            window.snow.listCodebaseIndexedFiles(
              projectId(ctx),
              numberParam(ctx, "page", 1),
              numberParam(ctx, "pageSize", 50),
            ),
          )
        : null,
      resumableSessions: projectId(ctx)
        ? await safe(() =>
            window.snow.getResumableCodebaseSessions(projectId(ctx)),
          )
        : null,
    }),
  },
  {
    id: "personalization",
    scope: "personalization",
    collect: () => safe(() => window.snow.getGlobalRole()),
  },
  {
    id: "projects",
    live: true,
    collect: async (ctx) => ({
      directories: await safe(() => window.snow.listWorkspaceDirectories()),
      collections: await safe(() => window.snow.listProjectCollections()),
      relinks: directoryId(ctx)
        ? await safe(() =>
            window.snow.listWorkspaceDirectoryRelinks(directoryId(ctx)),
          )
        : null,
      active: runtimeSnapshot.get().activeDirectory,
      activeSessionDirectoryIds:
        runtimeSnapshot.get().activeSessionDirectoryIds,
    }),
  },
  {
    id: "git",
    scope: "git",
    live: true,
    collect: async (ctx) => ({
      repoPath: projectPath(ctx),
      status: projectPath(ctx)
        ? await safe(() => window.snow.gitStatus(projectPath(ctx)))
        : null,
      branches: projectPath(ctx)
        ? await safe(() => window.snow.gitBranches(projectPath(ctx)))
        : null,
      identity: projectPath(ctx)
        ? await safe(() => window.snow.gitIdentity(projectPath(ctx)))
        : null,
    }),
  },
  {
    id: "memory",
    scope: "memory",
    collect: async (ctx) => ({
      stats: directoryId(ctx)
        ? await safe(() => window.snow.getProjectMemoryStats(directoryId(ctx)))
        : null,
      items: directoryId(ctx)
        ? await safe(() =>
            window.snow.listProjectMemories(
              directoryId(ctx),
              numberParam(ctx, "limit", 200),
              numberParam(ctx, "offset", 0),
            ),
          )
        : null,
    }),
  },
  {
    id: "memos",
    scope: "memos",
    collect: async (ctx) => ({
      summary: directoryId(ctx)
        ? await safe(() => window.snow.getMemoCountSummary(directoryId(ctx)))
        : null,
      items: directoryId(ctx)
        ? await safe(() =>
            window.snow.listMemos(
              directoryId(ctx),
              numberParam(ctx, "limit", 200),
              numberParam(ctx, "offset", 0),
            ),
          )
        : null,
    }),
  },
  {
    id: "scheduledTasks",
    sensitiveFields: { prompt: "scheduledTasks", preScript: "scheduledTasks" },
    collect: () => safe(() => window.snow.listScheduledTasks()),
  },
  {
    id: "conversations",
    scope: "conversations",
    live: true,
    collect: async (ctx) => ({
      directoryId: directoryId(ctx),
      items: directoryId(ctx)
        ? await safe(() => window.snow.listChatConversations(directoryId(ctx)))
        : null,
      pinned: directoryId(ctx)
        ? await safe(() =>
            window.snow.listPinnedConversations(directoryId(ctx)),
          )
        : null,
      active: runtimeSnapshot.get().conversation,
    }),
  },
  {
    id: "messages",
    scope: "messages",
    live: true,
    collect: async (ctx) => ({
      conversationId: conversationId(ctx),
      live: runtimeSnapshot.get().conversation,
      items: conversationId(ctx)
        ? await safe(() => window.snow.listChatMessages(conversationId(ctx)))
        : null,
      userMessages: conversationId(ctx)
        ? await safe(() => window.snow.listUserMessages(conversationId(ctx)))
        : null,
    }),
  },
  {
    id: "runtime",
    live: true,
    collect: async (ctx) => {
      const snapshot = runtimeSnapshot.get();
      return {
        conversation: snapshot.conversation,
        chatInput: snapshot.chatInput,
        streamingSessions: snapshot.streamingSessions,
        panels: snapshot.panels,
        activeDirectory: snapshot.activeDirectory,
        activeSessionDirectoryIds: snapshot.activeSessionDirectoryIds,
        revisions: {
          workspace: snapshot.workspaceRevision,
          memories: snapshot.memoriesRevision,
          scheduledTasks: snapshot.scheduledTasksRevision,
          conversationList: snapshot.conversationListRevision,
          plugins: snapshot.pluginsRevision,
        },
        locale: ctx.locale,
      };
    },
  },
  {
    id: "panels",
    live: true,
    collect: async () => runtimeSnapshot.get().panels,
  },
  {
    id: "interactions",
    scope: "messages",
    collect: async () => {
      const state = await window.__snowRemoteControl?.getState();
      return {
        authorizations: (state?.pendingAuthorizations ?? []).map((item) => ({
          authorizationId: item.authorizationId ?? null,
          interactionId: item.interactionId,
          name: item.name,
          status: item.status,
          sensitive: item.sensitive === true,
          arguments: item.arguments ?? null,
        })),
        questions: (state?.pendingQuestions ?? []).map((item) => ({
          questionId: item.questionId,
          question: item.question,
          options: item.options,
        })),
      };
    },
  },
  {
    id: "usage",
    scope: "usage",
    collect: async (ctx) => {
      const since = stringParam(ctx, "since", daysAgoIso(30));
      const until = stringParam(ctx, "until", new Date().toISOString());
      const profile = stringParam(ctx, "profileName", "");
      return {
        profileNames: await safe(() => window.snow.listUsageProfileNames()),
        summary: await safe(() =>
          window.snow.getUsageSummary(since, until, profile),
        ),
        daily: await safe(() =>
          window.snow.getUsageDailyBreakdown(since, until, profile),
        ),
        models: await safe(() =>
          window.snow.getUsageModelBreakdown(since, until, profile),
        ),
        records: await safe(() =>
          window.snow.listUsageRecords(
            stringParam(ctx, "conversationId", ""),
            stringParam(ctx, "directoryId", ""),
            profile,
            numberParam(ctx, "limit", 100),
            numberParam(ctx, "offset", 0),
          ),
        ),
      };
    },
  },
  {
    id: "logs",
    scope: "logs",
    collect: (ctx) =>
      safe(() =>
        window.snow.listAppLogs(
          stringParam(ctx, "level", ""),
          stringParam(ctx, "module", ""),
          stringParam(ctx, "since", ""),
          stringParam(ctx, "until", ""),
          numberParam(ctx, "limit", 200),
          numberParam(ctx, "offset", 0),
        ),
      ),
  },
  {
    id: "ide",
    collect: () => safe(() => window.snow.listInstalledIdes()),
  },
  {
    id: "userscripts",
    scope: "userscripts",
    collect: () => safe(() => window.snow.listUserscripts()),
  },
  {
    id: "ssh",
    scope: "ssh",
    collect: async (ctx) => ({
      credentials: await safe(() => window.snow.sshListCredentials()),
      configHosts: await safe(() => window.snow.sshListConfigHosts()),
      remoteDrafts: directoryId(ctx)
        ? await safe(() => window.snow.sshListRemoteDrafts(directoryId(ctx)))
        : null,
    }),
  },
  {
    id: "remoteControl",
    scope: "remoteControl",
    collect: async () => ({
      pairing: await safe(() => window.snow.getRemoteControlPairingState()),
      tunnel: await safe(() => window.snow.getRemoteTunnelStatus()),
    }),
  },
  {
    id: "browser",
    scope: "browserData",
    collect: async () => ({
      passwords: await safe(() => window.snow.browserPasswordsList()),
      bookmarks: await safe(() => window.snow.browserBookmarksList()),
      downloads: await safe(() => window.snow.listBrowserDownloads()),
      importSources: await safe(() => window.snow.browserImportSources()),
    }),
  },
  {
    id: "imageLibrary",
    collect: async () => ({
      images: await safe(() => window.snow.listImageLibrary()),
      albums: await safe(() => window.snow.listImageAlbums()),
      directory: await safe(() => window.snow.getImageLibraryDir()),
    }),
  },
  {
    id: "pets",
    collect: async () => ({
      installed: await safe(() => window.snow.listInstalledPets()),
      settings: await safe(() => window.snow.getPetSettings()),
    }),
  },
  {
    id: "plugins",
    scope: "plugins",
    live: true,
    collect: async () =>
      pluginStore.getState().plugins.map((plugin) => ({
        pluginId: plugin.pluginId,
        name: plugin.name,
        description: plugin.description,
        version: plugin.version,
        author: plugin.author,
        homepage: plugin.homepage,
        license: plugin.license,
        icon: plugin.icon,
        renderMode: plugin.renderMode,
        kind: plugin.kind,
        entry: plugin.entry,
        panels: plugin.panels,
        privacy: plugin.privacy,
        privacyNote: plugin.privacyNote,
        enabled: plugin.enabled,
        installPath: plugin.installPath,
        sourcePath: plugin.sourcePath,
        minAppVersion: plugin.minAppVersion,
        createdAt: plugin.createdAt,
        updatedAt: plugin.updatedAt,
      })),
  },
];
