import {
  Boxes,
  Download,
  Folder,
  Globe2,
  Loader2,
  Plug,
  Plus,
  RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  McpProjectServerStatus,
  WorkspaceDirectoryRecord,
} from "../../../preload";
import { useI18n } from "../../i18n";
import { AutoDismissNotice } from "../AutoDismissNotice";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { Modal } from "../common/Modal";
import { resolveToolDisplayName } from "../mainContent/chatMessages/toolCalls/shared/toolDisplayName";
import { notifyMcpServerStateChanged } from "../mainContent/chatInput/mcpServerEvents";
import { LITE_MODE_CHANGED_EVENT } from "../mainContent/chatMessages/hooks/useToolAuthorization";
import {
  McpSettingsEditor,
  McpSettingsEditorActions,
} from "./mcpSettings/McpSettingsEditor";
import {
  McpSettingsList,
  type McpSettingsListItem,
} from "./mcpSettings/McpSettingsList";
import { McpSettingsSummary } from "./mcpSettings/McpSettingsSummary";
import { McpSearchInput, matchesMcpQuery } from "./mcpSettings/McpSearchInput";
import {
  formatMcpError,
  formatMcpSaveError,
} from "./mcpSettings/mcpErrorMessages";
import { builtinServerDescriptionKey } from "./mcpSettings/builtinServerDescriptions";
import { validateApiSpec } from "./mcpSettings/mcpApiUtils";
import {
  EMPTY_MCP_SERVER_DRAFT,
  createMcpPair,
  createMcpStringItem,
  getMcpServerEndpoint,
  hasDuplicatePairKey,
  toDraft,
  toInput,
  toProjectInput,
} from "./mcpSettings/mcpSettingsUtils";
import type {
  McpServerConfig,
  McpServerConfigLike,
  McpServerDraft,
  McpServerTool,
  ProjectMcpServerConfig,
} from "./mcpSettings/types";

type McpSettingsPanelProps = {
  activeDirectory?: WorkspaceDirectoryRecord | null;
};

type McpScope = "global" | "project";
type McpCategory = "external" | "builtin";

/** 全局内置列表项 id 前缀，避免与项目内置项（builtin:x）共用工具缓存键。 */
const GLOBAL_BUILTIN_KEY_PREFIX = "global:";

/** 精简模式禁用的内置服务器（与 Rust LITE_MODE_DISABLED_SERVER_IDS 一致）。 */
const LITE_MODE_SERVER_IDS = new Set([
  "builtin:browser",
  "builtin:app-control",
  "builtin:terminal",
  "builtin:computer-use",
]);

/** 默认关闭、需按项目启用的内置服务器（与 Rust DEFAULT_DISABLED_SERVER_IDS 一致）。 */
const PROJECT_OPT_IN_SERVER_IDS = new Set([
  "builtin:terminal",
  "builtin:lsp",
  "builtin:computer-use",
  "builtin:browser",
  "builtin:html",
  "builtin:decision",
]);

/** 全局内置服务器工具：全局视图下工具开关即全局黑名单，不应只读。 */
const toGlobalBuiltinTools = (
  servers: McpProjectServerStatus[],
): Record<string, McpServerTool[]> =>
  Object.fromEntries(
    servers.map((server) => [
      `${GLOBAL_BUILTIN_KEY_PREFIX}${server.id}`,
      server.tools.map((tool) => ({ ...tool, globalEnabled: true })),
    ]),
  );

/**
 * 后台补发现项目服务器工具时的并发上限。与 Rust 端全量发现的并发度分开：
 * 这里逐台触发单服务器发现（内部读写进程内缓存），喂满并发即可，
 * 不必把设置面板变成连接风暴。
 */
const PROJECT_TOOL_DISCOVERY_CONCURRENCY = 3;

/**
 * 把服务器列表里已返回的工具合并进本地缓存（工具为空的服务器保留旧值，
 * 避免快速列表 + 后台发现期间列表闪空）。
 */
const mergeServerTools = (
  previous: Record<string, McpServerTool[]>,
  servers: McpProjectServerStatus[],
): Record<string, McpServerTool[]> => {
  const next = { ...previous };
  servers.forEach((server) => {
    if (server.tools.length > 0) {
      next[server.id] = server.tools;
    }
  });
  return next;
};

export function McpSettingsPanel({
  activeDirectory,
}: McpSettingsPanelProps): React.JSX.Element {
  const { t } = useI18n();
  const [activeScope, setActiveScope] = useState<McpScope>("global");
  const [activeCategory, setActiveCategory] = useState<McpCategory>("external");
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [globalBuiltinServers, setGlobalBuiltinServers] = useState<
    McpProjectServerStatus[]
  >([]);
  const [projectServers, setProjectServers] = useState<
    McpProjectServerStatus[]
  >([]);
  const [projectServerConfigs, setProjectServerConfigs] = useState<
    ProjectMcpServerConfig[]
  >([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{
    server: McpSettingsListItem;
    scope: McpScope;
  } | null>(null);
  const [pendingGlobalToggle, setPendingGlobalToggle] = useState<{
    server: McpSettingsListItem;
    kind: "builtin" | "external";
    nextEnabled: boolean;
    askProject: boolean;
  } | null>(null);
  const [draft, setDraft] = useState<McpServerDraft | null>(null);
  const [toolsByServerId, setToolsByServerId] = useState<
    Record<string, McpServerTool[]>
  >({});
  const [fetchingToolServerIds, setFetchingToolServerIds] = useState<
    Set<string>
  >(() => new Set());
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [serverQuery, setServerQuery] = useState("");
  const loadGenerationRef = useRef(0);
  // 正在进行后台工具发现的服务器（按 scope 服务器 id 去重），
  // 避免同一台服务器被并发发现两次。
  const discoveringServerIdsRef = useRef<Set<string>>(new Set());

  const isBusy = isLoading || isSaving;

  /**
   * 单台项目服务器的工具发现：调用 Rust 端发现（内部读写进程内缓存），
   * 成功后写入 toolsByServerId。后台补发现与手动「获取工具」共用。
   */
  const fetchProjectServerTools = useCallback(
    async (
      projectId: string,
      scopeServerId: string,
      generation: number,
    ): Promise<McpServerTool[]> => {
      const tools = await window.snow.listMcpProjectServerTools(
        projectId,
        scopeServerId,
      );
      if (loadGenerationRef.current === generation) {
        setToolsByServerId((previous) => ({
          ...previous,
          [scopeServerId]: tools,
        }));
      }
      return tools;
    },
    [],
  );

  /**
   * 后台补发现 `toolsPending` 的服务器：并发上限
   * PROJECT_TOOL_DISCOVERY_CONCURRENCY，逐台显示「发现中」，单台失败静默
   * （工具数保持待获取，用户可手动重试）。整个过程不阻塞列表刷新与保存。
   */
  const discoverPendingProjectServers = useCallback(
    async (
      projectId: string,
      servers: McpProjectServerStatus[],
      generation: number,
    ): Promise<void> => {
      const pendingIds = servers
        .filter((server) => server.toolsPending)
        .map((server) => server.id)
        .filter((serverId) => !discoveringServerIdsRef.current.has(serverId));
      if (pendingIds.length === 0) {
        return;
      }
      pendingIds.forEach((serverId) =>
        discoveringServerIdsRef.current.add(serverId),
      );
      setFetchingToolServerIds(
        (previous) => new Set([...previous, ...pendingIds]),
      );
      // 可变工作队列：多个 worker 共同消费（updater 里用的是上面的快照）。
      const queue = [...pendingIds];

      const worker = async (): Promise<void> => {
        for (;;) {
          const serverId = queue.shift();
          if (!serverId) {
            return;
          }
          try {
            await fetchProjectServerTools(projectId, serverId, generation);
          } catch {
            // 后台发现失败不打扰用户：保留待获取状态，可手动重试。
          } finally {
            discoveringServerIdsRef.current.delete(serverId);
            setFetchingToolServerIds((previous) => {
              const next = new Set(previous);
              next.delete(serverId);
              return next;
            });
          }
        }
      };

      await Promise.all(
        Array.from(
          {
            length: Math.min(PROJECT_TOOL_DISCOVERY_CONCURRENCY, queue.length),
          },
          () => worker(),
        ),
      );
    },
    [fetchProjectServerTools],
  );

  /**
   * 快速刷新项目服务器列表：只读 Rust 端进程内工具缓存（不连接服务器），
   * 待发现的服务器交给后台补发现。保存 / 启停 / 删除配置后的刷新都走它，
   * 保证配置写入立即返回，不被慢服务器的 connect + tools/list 拖住。
   */
  const refreshProjectServers = useCallback(
    async (projectId: string, generation: number): Promise<void> => {
      const nextServers =
        await window.snow.listMcpProjectServersCached(projectId);
      if (loadGenerationRef.current !== generation) {
        return;
      }
      setProjectServers(nextServers);
      setToolsByServerId((previous) => mergeServerTools(previous, nextServers));
      void discoverPendingProjectServers(projectId, nextServers, generation);
    },
    [discoverPendingProjectServers],
  );

  /** 刷新全局内置服务器列表（只读进程内注册表，不连接外部服务器）。 */
  const refreshGlobalBuiltinServers = useCallback(async (): Promise<void> => {
    const items = await window.snow.listMcpGlobalBuiltinServers();
    setGlobalBuiltinServers(items);
    setToolsByServerId((previous) => ({
      ...previous,
      ...toGlobalBuiltinTools(items),
    }));
  }, []);

  const load = useCallback(async (): Promise<void> => {
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    setIsLoading(true);
    setError("");

    try {
      const [
        globalItems,
        globalBuiltinItems,
        projectItems,
        projectConfigItems,
      ] = await Promise.all([
        window.snow.listMcpServerConfigs(),
        window.snow.listMcpGlobalBuiltinServers(),
        activeDirectory
          ? window.snow.listMcpProjectServersCached(activeDirectory.directoryId)
          : Promise.resolve([]),
        activeDirectory
          ? window.snow.listProjectMcpServerConfigs(activeDirectory.directoryId)
          : Promise.resolve([]),
      ]);
      if (loadGenerationRef.current !== generation) {
        return;
      }

      setServers(globalItems);
      setGlobalBuiltinServers(globalBuiltinItems);
      setProjectServers(projectItems);
      setProjectServerConfigs(projectConfigItems);
      setToolsByServerId((previous) => ({
        ...mergeServerTools(previous, projectItems),
        ...toGlobalBuiltinTools(globalBuiltinItems),
      }));
      // 列表先渲染，工具在后台逐台发现（列表项显示「发现中」）。
      if (activeDirectory) {
        void discoverPendingProjectServers(
          activeDirectory.directoryId,
          projectItems,
          generation,
        );
      }
    } catch (loadError) {
      if (loadGenerationRef.current === generation) {
        setError(
          loadError instanceof Error
            ? loadError.message
            : t("settings.mcpLoadError", {
                defaultValue: "Failed to load MCP servers",
              }),
        );
      }
    } finally {
      if (loadGenerationRef.current === generation) {
        setIsLoading(false);
      }
    }
  }, [activeDirectory, t, discoverPendingProjectServers]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!activeDirectory && activeScope === "project") {
      setActiveScope("global");
    }
  }, [activeDirectory, activeScope]);

  useEffect(() => {
    setDraft(null);
    setProjectServers([]);
    setProjectServerConfigs([]);
    setToolsByServerId({});
    setFetchingToolServerIds(new Set());
    setStatus("");
    setError("");
  }, [activeDirectory?.directoryId]);

  const handleImport = async () => {
    setIsLoading(true);
    setError("");
    setStatus("");

    try {
      await window.snow.importSnowCliMcpConfig();
      await load();
      setDraft(null);
      setStatus(
        t("settings.mcpImportSuccess", {
          defaultValue: "Synced MCP servers from Snow CLI.",
        }),
      );
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.mcpImportError", {
              defaultValue: "Failed to sync Snow CLI MCP settings",
            }),
      );
    } finally {
      setIsLoading(false);
    }
  };

  const startAdd = () => {
    const scopedServers =
      activeScope === "global" ? servers : projectServerConfigs;
    const maxSortOrder = scopedServers.reduce(
      (max, server) => Math.max(max, server.sortOrder),
      -1,
    );
    setDraft({
      ...EMPTY_MCP_SERVER_DRAFT,
      sortOrder: maxSortOrder + 1,
      source: activeScope === "global" ? "manual" : "project",
    });
    setError("");
    setStatus("");
  };

  const startEdit = (server: McpServerConfigLike) => {
    setDraft(toDraft(server));
    setError("");
    setStatus("");
  };

  const cancelDraft = () => {
    setDraft(null);
    setError("");
  };

  const patchDraft = (patch: Partial<McpServerDraft>) => {
    setDraft((previous) => (previous ? { ...previous, ...patch } : null));
    setError("");
  };

  const updatePair = (
    group: "env" | "headers",
    pairId: string,
    field: "key" | "value",
    value: string,
  ) => {
    setDraft((previous) =>
      previous
        ? {
            ...previous,
            [group]: previous[group].map((pair) =>
              pair.id === pairId ? { ...pair, [field]: value } : pair,
            ),
          }
        : null,
    );
    setError("");
  };

  const addPair = (group: "env" | "headers") => {
    setDraft((previous) =>
      previous
        ? { ...previous, [group]: [...previous[group], createMcpPair()] }
        : null,
    );
    setError("");
  };

  const removePair = (group: "env" | "headers", pairId: string) => {
    setDraft((previous) =>
      previous
        ? {
            ...previous,
            [group]: previous[group].filter((pair) => pair.id !== pairId),
          }
        : null,
    );
    setError("");
  };

  const updateArg = (argId: string, value: string) => {
    setDraft((previous) =>
      previous
        ? {
            ...previous,
            args: previous.args.map((arg) =>
              arg.id === argId ? { ...arg, value } : arg,
            ),
          }
        : null,
    );
    setError("");
  };

  const addArg = () => {
    setDraft((previous) =>
      previous
        ? { ...previous, args: [...previous.args, createMcpStringItem()] }
        : null,
    );
    setError("");
  };

  const removeArg = (argId: string) => {
    setDraft((previous) =>
      previous
        ? { ...previous, args: previous.args.filter((arg) => arg.id !== argId) }
        : null,
    );
    setError("");
  };

  const saveDraft = async (overrideDraft?: McpServerDraft) => {
    const currentDraft = overrideDraft ?? draft;
    if (!currentDraft) return;

    if (!currentDraft.name.trim()) {
      setError(
        t("settings.mcpNameRequired", {
          defaultValue: "MCP server name is required.",
        }),
      );
      setStatus("");
      return;
    }

    if (currentDraft.transportType === "http" && !currentDraft.url.trim()) {
      setError(
        t("settings.mcpUrlRequired", { defaultValue: "URL is required." }),
      );
      setStatus("");
      return;
    }

    if (
      currentDraft.transportType === "stdio" &&
      !currentDraft.command.trim()
    ) {
      setError(
        t("settings.mcpCommandRequired", {
          defaultValue: "Command is required.",
        }),
      );
      setStatus("");
      return;
    }

    if (currentDraft.transportType === "api") {
      const apiError = validateApiSpec(currentDraft.api);
      if (apiError) {
        setError(
          t(apiError.key, {
            defaultValue: apiError.defaultValue,
            values: apiError.values,
          }),
        );
        setStatus("");
        return;
      }
    }

    if (
      hasDuplicatePairKey(currentDraft.env) ||
      hasDuplicatePairKey(currentDraft.headers) ||
      hasDuplicatePairKey(currentDraft.api.cookies) ||
      currentDraft.api.endpoints.some((endpoint) =>
        hasDuplicatePairKey(endpoint.headers),
      )
    ) {
      setError(
        t("settings.mcpDuplicateKey", {
          defaultValue: "Environment and header names must be unique.",
        }),
      );
      setStatus("");
      return;
    }

    const timeoutMs = currentDraft.timeoutMs.trim()
      ? Number(currentDraft.timeoutMs)
      : null;
    if (
      timeoutMs !== null &&
      (!Number.isInteger(timeoutMs) || timeoutMs <= 0)
    ) {
      setError(
        t("settings.mcpTimeoutInvalid", {
          defaultValue: "Timeout must be a positive integer.",
        }),
      );
      setStatus("");
      return;
    }

    const operationScope = activeScope;
    const operationProjectId = activeDirectory?.directoryId;
    const generation = loadGenerationRef.current;
    if (operationScope === "project" && !operationProjectId) {
      setError(
        t("settings.mcpProjectRequired", {
          defaultValue: "Select a project before saving a project MCP server.",
        }),
      );
      return;
    }
    setIsSaving(true);
    setError("");
    setStatus("");

    try {
      if (operationScope === "global") {
        const maxSortOrder = servers.reduce(
          (max, server) => Math.max(max, server.sortOrder),
          -1,
        );
        const items = await window.snow.upsertMcpServerConfig(
          toInput(currentDraft, maxSortOrder + 1),
        );
        setServers(items);
        // 已获取过工具的服务器保存后静默刷新，避免展示旧 schema
        if (currentDraft.serverId && toolsByServerId[currentDraft.serverId]) {
          void refreshGlobalServerTools(currentDraft.serverId);
        }
      } else if (operationProjectId) {
        const maxSortOrder = projectServerConfigs.reduce(
          (max, server) => Math.max(max, server.sortOrder),
          -1,
        );
        const items = await window.snow.upsertProjectMcpServerConfig(
          operationProjectId,
          toProjectInput(currentDraft, maxSortOrder + 1),
        );
        if (loadGenerationRef.current !== generation) {
          return;
        }
        setProjectServerConfigs(items);
        // 快速刷新（只读缓存）+ 后台补发现：保存本身不被工具发现阻塞。
        await refreshProjectServers(operationProjectId, generation);
      }

      setDraft(null);
      setStatus(
        currentDraft.serverId
          ? t("settings.mcpSaveSuccess", {
              defaultValue: "Saved MCP server.",
            })
          : t("settings.mcpAddSuccess", {
              defaultValue: "Added MCP server.",
            }),
      );
    } catch (e) {
      if (
        operationScope === "global" ||
        loadGenerationRef.current === generation
      ) {
        setError(formatMcpSaveError(e, t));
      }
    } finally {
      if (
        operationScope === "global" ||
        loadGenerationRef.current === generation
      ) {
        setIsSaving(false);
      }
    }
  };

  /** 保存后静默重新发现全局服务器工具；失败时丢弃旧缓存。 */
  const refreshGlobalServerTools = async (serverId: string): Promise<void> => {
    setFetchingToolServerIds((previous) => new Set(previous).add(serverId));
    try {
      const tools = await window.snow.listMcpServerTools(serverId);
      setToolsByServerId((previous) => ({ ...previous, [serverId]: tools }));
    } catch {
      setToolsByServerId((previous) => {
        const next = { ...previous };
        delete next[serverId];
        return next;
      });
    } finally {
      setFetchingToolServerIds((previous) => {
        const next = new Set(previous);
        next.delete(serverId);
        return next;
      });
    }
  };

  const handleFetchTools = async (server: McpServerConfig) => {
    setFetchingToolServerIds((previous) => {
      const next = new Set(previous);
      next.add(server.serverId);
      return next;
    });
    setError("");
    setStatus("");

    try {
      const tools = await window.snow.listMcpServerTools(server.serverId);
      setToolsByServerId((previous) => ({
        ...previous,
        [server.serverId]: tools,
      }));
      setStatus(
        t("settings.mcpFetchToolsSuccess", {
          defaultValue: "Fetched {{count}} tool(s) from {{name}}.",
          values: { count: tools.length, name: server.name },
        }),
      );
    } catch (e) {
      setError(formatMcpError(e, t));
    } finally {
      setFetchingToolServerIds((previous) => {
        const next = new Set(previous);
        next.delete(server.serverId);
        return next;
      });
    }
  };

  const handleToggleTool = async (
    server: McpSettingsListItem,
    tool: McpServerTool,
    enabled: boolean,
  ): Promise<void> => {
    if (
      isBusy ||
      !server.globalEnabled ||
      !server.enabled ||
      tool.globalEnabled === false
    ) {
      return;
    }
    if (activeScope === "project" && !activeDirectory) {
      return;
    }
    setError("");
    setStatus("");

    const updateToolState = (nextEnabled: boolean): void => {
      setToolsByServerId((previous) => {
        const current = previous[server.serverId];
        if (!current) {
          return previous;
        }
        return {
          ...previous,
          [server.serverId]: current.map((item) =>
            item.name === tool.name ? { ...item, enabled: nextEnabled } : item,
          ),
        };
      });
    };

    updateToolState(enabled);
    try {
      if (activeScope === "global") {
        await window.snow.setMcpToolEnabled(tool.name, enabled);
      } else if (activeDirectory) {
        await window.snow.setMcpProjectToolEnabled(
          activeDirectory.directoryId,
          tool.name,
          enabled,
        );
      }
    } catch (e) {
      updateToolState(!enabled);
      setError(
        e instanceof Error
          ? formatMcpError(e, t)
          : t("settings.mcpToolToggleError", {
              defaultValue: "Failed to update MCP tool",
            }),
      );
    }
  };

  const handleToggleAllTools = async (
    server: McpSettingsListItem,
    enabled: boolean,
  ): Promise<void> => {
    if (isBusy || !server.globalEnabled || !server.enabled) {
      return;
    }
    if (activeScope === "project" && !activeDirectory) {
      return;
    }
    const tools = toolsByServerId[server.serverId];
    if (!tools || tools.length === 0) {
      return;
    }
    const toolNames = tools.map((tool) => tool.name);
    setError("");
    setStatus("");

    const updateAllToolsState = (nextEnabled: boolean): void => {
      setToolsByServerId((previous) => {
        const current = previous[server.serverId];
        if (!current) {
          return previous;
        }
        return {
          ...previous,
          // 全局已禁用的工具项目层无法覆盖，有效态恒为关闭。
          [server.serverId]: current.map((item) => ({
            ...item,
            enabled: item.globalEnabled !== false && nextEnabled,
          })),
        };
      });
    };

    updateAllToolsState(enabled);
    try {
      if (activeScope === "global") {
        await window.snow.setMcpToolsEnabled(toolNames, enabled);
      } else if (activeDirectory) {
        await window.snow.setMcpProjectToolsEnabled(
          activeDirectory.directoryId,
          toolNames,
          enabled,
        );
      }
    } catch (e) {
      updateAllToolsState(!enabled);
      setError(
        e instanceof Error
          ? formatMcpError(e, t)
          : t("settings.mcpToolToggleError", {
              defaultValue: "Failed to update MCP tool",
            }),
      );
    }
  };

  const handleDelete = async (server: McpServerConfig) => {
    setError("");
    setStatus("");

    try {
      const items = await window.snow.deleteMcpServerConfig(server.serverId);
      setServers(items);
      setToolsByServerId((previous) => {
        const next = { ...previous };
        delete next[server.serverId];
        return next;
      });
      setStatus(
        t("settings.mcpDeleteSuccess", {
          defaultValue: "Deleted MCP server.",
        }),
      );
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.mcpDeleteError", {
              defaultValue: "Failed to delete MCP server",
            }),
      );
    }
  };

  const globalListItems: McpSettingsListItem[] = servers.map((server) => ({
    serverId: server.serverId,
    name: server.name,
    enabled: server.enabled,
    globalEnabled: true,
    detail: `${server.transportType} · ${getMcpServerEndpoint(server) || "-"}`,
    canManage: true,
  }));
  const projectListItems: McpSettingsListItem[] = projectServers.map(
    (server) => {
      const configServerId = server.id.replace(/^external:/, "");
      const projectConfig = projectServerConfigs.find(
        (item) => item.serverId === configServerId,
      );
      // 内置服务说明：内置服务固定不变，文案来自 i18n
      const descriptionKey = builtinServerDescriptionKey(server.id);
      const builtinDescription = descriptionKey ? t(descriptionKey) : "";
      const sourceDetail =
        server.source === "system"
          ? t("settings.mcpProjectSystemServer", {
              defaultValue: "Built-in system MCP server",
            })
          : server.source === "project"
            ? `${t("settings.mcpProjectOwnedServer", {
                defaultValue: "Project MCP server",
              })} · ${
                projectConfig
                  ? `${projectConfig.transportType} · ${
                      getMcpServerEndpoint(projectConfig) || "-"
                    }`
                  : "-"
              }`
            : t("settings.mcpProjectExternalServer", {
                defaultValue: "Global external MCP server",
              });
      return {
        serverId: server.id,
        name: server.name,
        enabled: server.enabled,
        globalEnabled: server.globalEnabled,
        detail: builtinDescription
          ? `${sourceDetail} · ${builtinDescription}`
          : sourceDetail,
        canManage: server.source === "project",
      };
    },
  );
  const globalBuiltinListItems: McpSettingsListItem[] =
    globalBuiltinServers.map((server) => {
      const descriptionKey = builtinServerDescriptionKey(server.id);
      const details = [
        t("settings.mcpProjectSystemServer", {
          defaultValue: "Built-in system MCP server",
        }),
      ];
      if (server.error === "imagegen:not_configured") {
        details.push(
          t("settings.mcpImagegenNotConfigured", {
            defaultValue: "No image generation channel configured",
          }),
        );
      } else if (PROJECT_OPT_IN_SERVER_IDS.has(server.id)) {
        details.push(
          t("settings.mcpBuiltinProjectOptIn", {
            defaultValue: "Must also be enabled per project",
          }),
        );
      }
      if (descriptionKey) {
        details.push(t(descriptionKey));
      }
      return {
        serverId: `${GLOBAL_BUILTIN_KEY_PREFIX}${server.id}`,
        name: server.name,
        enabled: server.enabled,
        globalEnabled: server.globalEnabled,
        detail: details.join(" · "),
        canManage: false,
      };
    });
  const projectBuiltinListItems = projectListItems.filter((server) =>
    server.serverId.startsWith("builtin:"),
  );
  const projectExternalListItems = projectListItems.filter(
    (server) => !server.serverId.startsWith("builtin:"),
  );
  const isGlobalScope = activeScope === "global";
  const isBuiltinCategory = activeCategory === "builtin";
  const isGlobalBuiltinView = isGlobalScope && isBuiltinCategory;
  const scopeExternalItems = isGlobalScope
    ? globalListItems
    : projectExternalListItems;
  const scopeBuiltinItems = isGlobalScope
    ? globalBuiltinListItems
    : projectBuiltinListItems;
  const activeServers = isBuiltinCategory
    ? scopeBuiltinItems
    : scopeExternalItems;
  // 按服务器名称、详情及已获取的工具名/描述过滤
  const filteredServers = activeServers.filter(
    (server) =>
      matchesMcpQuery(serverQuery, server.name, server.detail) ||
      (toolsByServerId[server.serverId] ?? []).some((tool) =>
        matchesMcpQuery(
          serverQuery,
          resolveToolDisplayName(t, tool.name),
          tool.description,
        ),
      ),
  );
  const enabledCount = activeServers.filter(
    (server) => server.enabled && server.globalEnabled,
  ).length;
  const listTitle = isBuiltinCategory
    ? isGlobalScope
      ? t("settings.mcpGlobalBuiltinListTitle", {
          defaultValue: "Global built-in MCP servers",
        })
      : t("settings.mcpProjectBuiltinListTitle", {
          defaultValue: "Project built-in MCP servers",
        })
    : isGlobalScope
      ? t("settings.mcpGlobalListTitle", {
          defaultValue: "Global MCP servers",
        })
      : t("settings.mcpProjectListTitle", {
          defaultValue: "Project MCP servers",
        });
  const listInfo = isBuiltinCategory
    ? isGlobalScope
      ? t("settings.mcpGlobalBuiltinTabInfo", {
          defaultValue:
            "Master switch for built-in servers. Servers turned off here are unavailable in every project and cannot be enabled per project.",
        })
      : t("settings.mcpProjectBuiltinTabInfo", {
          defaultValue:
            "Control built-in servers for {{name}}. Servers turned off globally cannot be enabled here.",
          values: { name: activeDirectory?.name ?? "" },
        })
    : isGlobalScope
      ? t("settings.mcpGlobalTabInfo", {
          defaultValue: "Manage external MCP servers shared by all projects.",
        })
      : t("settings.mcpProjectTabInfo", {
          defaultValue:
            "Manage project MCP servers for {{name}} and control inherited system or global servers.",
          values: { name: activeDirectory?.name ?? "" },
        });
  const emptyMessage =
    serverQuery.trim() && activeServers.length > 0
      ? t("settings.mcpServerSearchEmpty", {
          defaultValue: "No MCP servers match the search.",
        })
      : isBuiltinCategory
        ? t("settings.mcpBuiltinNoServers", {
            defaultValue: "No built-in MCP servers.",
          })
        : isGlobalScope
          ? t("settings.mcpNoServers", {
              defaultValue:
                "No MCP servers yet. Sync from Snow CLI settings.json or add one manually.",
            })
          : t("settings.mcpProjectNoServers", {
              defaultValue: "No MCP servers are available for this project.",
            });

  const handleGlobalBuiltinFetchTools = async (
    server: McpSettingsListItem,
  ): Promise<void> => {
    setFetchingToolServerIds((previous) =>
      new Set(previous).add(server.serverId),
    );
    setError("");
    try {
      await refreshGlobalBuiltinServers();
    } catch (fetchError) {
      setError(formatMcpError(fetchError, t));
    } finally {
      setFetchingToolServerIds((previous) => {
        const next = new Set(previous);
        next.delete(server.serverId);
        return next;
      });
    }
  };

  const handleProjectToggle = async (
    server: McpSettingsListItem,
  ): Promise<void> => {
    if (!activeDirectory || !server.globalEnabled || isBusy) {
      return;
    }

    const operationProjectId = activeDirectory.directoryId;
    const generation = loadGenerationRef.current;
    const configServerId = server.serverId.replace(/^external:/, "");
    const projectConfig = projectServerConfigs.find(
      (item) => item.serverId === configServerId,
    );
    setIsSaving(true);
    setError("");
    setStatus("");
    try {
      if (projectConfig) {
        await window.snow.upsertProjectMcpServerConfig(operationProjectId, {
          serverId: projectConfig.serverId,
          name: projectConfig.name,
          transportType: projectConfig.transportType,
          url: projectConfig.url,
          command: projectConfig.command,
          argsJson: projectConfig.argsJson,
          envJson: projectConfig.envJson,
          headersJson: projectConfig.headersJson,
          enabled: !projectConfig.enabled,
          ...(projectConfig.timeoutMs
            ? { timeoutMs: projectConfig.timeoutMs }
            : {}),
          sortOrder: projectConfig.sortOrder,
          source: "project",
        });
      } else {
        await window.snow.setMcpProjectServerEnabled(
          operationProjectId,
          server.serverId,
          !server.enabled,
        );
        // 手动启用被精简模式禁用的内置服务器（browser / app-control /
        // terminal / computer-use）时，Rust 侧会自动关闭精简模式；派发事件
        // 让会话层重新读取状态。
        if (!server.enabled && LITE_MODE_SERVER_IDS.has(server.serverId)) {
          window.dispatchEvent(new CustomEvent(LITE_MODE_CHANGED_EVENT));
          void refreshGlobalBuiltinServers().catch(() => undefined);
        }
      }
      if (loadGenerationRef.current !== generation) {
        return;
      }

      const nextProjectConfigs =
        await window.snow.listProjectMcpServerConfigs(operationProjectId);
      if (loadGenerationRef.current !== generation) {
        return;
      }
      setProjectServerConfigs(nextProjectConfigs);
      // 启停本身很快：列表刷新走快速路径，工具由后台补发现。
      await refreshProjectServers(operationProjectId, generation);
    } catch (updateError) {
      if (loadGenerationRef.current === generation) {
        setError(formatMcpSaveError(updateError, t));
      }
    } finally {
      if (loadGenerationRef.current === generation) {
        setIsSaving(false);
      }
    }
  };

  const handleProjectFetchTools = async (
    server: McpSettingsListItem,
  ): Promise<void> => {
    if (!activeDirectory) {
      return;
    }

    const operationProjectId = activeDirectory.directoryId;
    const generation = loadGenerationRef.current;
    setFetchingToolServerIds((previous) =>
      new Set(previous).add(server.serverId),
    );
    setError("");
    setStatus("");
    try {
      const tools = await fetchProjectServerTools(
        operationProjectId,
        server.serverId,
        generation,
      );
      if (loadGenerationRef.current !== generation) {
        return;
      }
      setStatus(
        t("settings.mcpFetchToolsSuccess", {
          defaultValue: "Fetched {{count}} tool(s) from {{name}}.",
          values: { count: tools.length, name: server.name },
        }),
      );
    } catch (fetchError) {
      if (loadGenerationRef.current === generation) {
        setError(formatMcpError(fetchError, t));
      }
    } finally {
      setFetchingToolServerIds((previous) => {
        const next = new Set(previous);
        next.delete(server.serverId);
        return next;
      });
    }
  };

  const findGlobalServer = (serverId: string): McpServerConfig | undefined =>
    servers.find((server) => server.serverId === serverId);
  const findProjectServer = (
    scopeServerId: string,
  ): ProjectMcpServerConfig | undefined => {
    const serverId = scopeServerId.replace(/^external:/, "");
    return projectServerConfigs.find((server) => server.serverId === serverId);
  };

  /** 项目层是否已启用该服务器；未加载到条目时按已启用处理。 */
  const isProjectServerEnabled = (scopeServerId: string): boolean => {
    const projectServer = projectServers.find(
      (server) => server.id === scopeServerId,
    );
    return projectServer ? projectServer.enabled : true;
  };

  /** 把全局列表项 id 还原成项目层使用的服务器 id。 */
  const toProjectScopeServerId = (
    server: McpSettingsListItem,
    kind: "builtin" | "external",
  ): string =>
    kind === "builtin"
      ? server.serverId.slice(GLOBAL_BUILTIN_KEY_PREFIX.length)
      : `external:${server.serverId}`;

  /**
   * 全局启停入口：停用前提醒各项目会一并停用；启用时若当前项目尚未启用，
   * 弹窗询问是否同时为当前项目启用。
   */
  const requestGlobalToggle = (
    server: McpSettingsListItem,
    kind: "builtin" | "external",
  ): void => {
    if (isBusy || !server.globalEnabled) {
      return;
    }
    const nextEnabled = !server.enabled;
    const askProject =
      nextEnabled &&
      Boolean(activeDirectory) &&
      !isProjectServerEnabled(toProjectScopeServerId(server, kind));
    if (!nextEnabled || askProject) {
      setPendingGlobalToggle({ server, kind, nextEnabled, askProject });
      return;
    }
    void applyGlobalToggle(server, kind, nextEnabled, false);
  };

  /** 执行全局启停，并按需同时为当前项目启用。 */
  const applyGlobalToggle = async (
    server: McpSettingsListItem,
    kind: "builtin" | "external",
    nextEnabled: boolean,
    alsoProject: boolean,
  ): Promise<void> => {
    const generation = loadGenerationRef.current;
    const projectId = activeDirectory?.directoryId;
    const scopeServerId = toProjectScopeServerId(server, kind);
    setIsSaving(true);
    setError("");
    setStatus("");
    try {
      if (kind === "builtin") {
        await window.snow.setMcpGlobalServerEnabled(scopeServerId, nextEnabled);
        // 启用精简模式服务器时 Rust 侧会关闭精简模式
        if (nextEnabled && LITE_MODE_SERVER_IDS.has(scopeServerId)) {
          window.dispatchEvent(new CustomEvent(LITE_MODE_CHANGED_EVENT));
        }
        notifyMcpServerStateChanged();
        await refreshGlobalBuiltinServers();
      } else {
        const globalServer = findGlobalServer(server.serverId);
        if (!globalServer) {
          return;
        }
        const items = await window.snow.upsertMcpServerConfig({
          serverId: globalServer.serverId,
          name: globalServer.name,
          transportType: globalServer.transportType,
          url: globalServer.url,
          command: globalServer.command,
          argsJson: globalServer.argsJson,
          envJson: globalServer.envJson,
          headersJson: globalServer.headersJson,
          enabled: nextEnabled,
          ...(globalServer.timeoutMs
            ? { timeoutMs: globalServer.timeoutMs }
            : {}),
          sortOrder: globalServer.sortOrder,
          source: globalServer.source,
        });
        setServers(items);
      }
      if (alsoProject && projectId) {
        await window.snow.setMcpProjectServerEnabled(
          projectId,
          scopeServerId,
          true,
        );
        if (LITE_MODE_SERVER_IDS.has(scopeServerId)) {
          window.dispatchEvent(new CustomEvent(LITE_MODE_CHANGED_EVENT));
        }
      }
      if (projectId) {
        await refreshProjectServers(projectId, generation);
      }
      setStatus(
        nextEnabled
          ? t("settings.mcpGlobalEnableSuccess", {
              defaultValue: "Enabled globally.",
            })
          : t("settings.mcpGlobalDisableSuccess", {
              defaultValue: "Disabled globally for every project.",
            }),
      );
    } catch (updateError) {
      setError(formatMcpSaveError(updateError, t));
    } finally {
      setIsSaving(false);
    }
  };

  const handleProjectDelete = async (
    server: ProjectMcpServerConfig,
  ): Promise<void> => {
    if (!activeDirectory) {
      return;
    }
    const operationProjectId = activeDirectory.directoryId;
    const generation = loadGenerationRef.current;
    setIsSaving(true);
    setError("");
    setStatus("");
    try {
      const items = await window.snow.deleteProjectMcpServerConfig(
        operationProjectId,
        server.serverId,
      );
      if (loadGenerationRef.current !== generation) {
        return;
      }
      setProjectServerConfigs(items);
      setToolsByServerId((previous) => {
        const next = { ...previous };
        delete next[`external:${server.serverId}`];
        return next;
      });
      // 删除后同样走快速刷新：被删服务器已不在列表，其他服务器缓存不受
      // 影响（Rust 侧只失效被删服务器的缓存），无需重新连接。
      await refreshProjectServers(operationProjectId, generation);
      setStatus(
        t("settings.mcpDeleteSuccess", {
          defaultValue: "Deleted MCP server.",
        }),
      );
    } catch (deleteError) {
      if (loadGenerationRef.current === generation) {
        setError(
          deleteError instanceof Error
            ? deleteError.message
            : t("settings.mcpDeleteError", {
                defaultValue: "Failed to delete MCP server",
              }),
        );
      }
    } finally {
      if (loadGenerationRef.current === generation) {
        setIsSaving(false);
      }
    }
  };

  const handleListToggle = (server: McpSettingsListItem): void => {
    if (isGlobalBuiltinView) {
      requestGlobalToggle(server, "builtin");
      return;
    }
    if (isGlobalScope) {
      requestGlobalToggle(server, "external");
      return;
    }
    void handleProjectToggle(server);
  };

  const handleListFetchTools = (server: McpSettingsListItem): void => {
    if (isGlobalBuiltinView) {
      void handleGlobalBuiltinFetchTools(server);
      return;
    }
    if (isGlobalScope) {
      const globalServer = findGlobalServer(server.serverId);
      if (globalServer) {
        void handleFetchTools(globalServer);
      }
      return;
    }
    void handleProjectFetchTools(server);
  };

  const handleListToggleTool = (
    server: McpSettingsListItem,
    tool: McpServerTool,
    enabled: boolean,
  ): void => {
    void handleToggleTool(server, tool, enabled);
  };

  const handleListToggleAllTools = (
    server: McpSettingsListItem,
    enabled: boolean,
  ): void => {
    void handleToggleAllTools(server, enabled);
  };

  const handleListEdit = (server: McpSettingsListItem): void => {
    if (isGlobalScope) {
      const globalServer = findGlobalServer(server.serverId);
      if (globalServer) {
        startEdit(globalServer);
      }
      return;
    }
    const projectServer = findProjectServer(server.serverId);
    if (projectServer) {
      startEdit(projectServer);
    }
  };

  const handleListDelete = (server: McpSettingsListItem): void => {
    setPendingDelete({ server, scope: activeScope });
  };

  const confirmDelete = async (): Promise<void> => {
    const pending = pendingDelete;
    if (!pending) {
      return;
    }
    setPendingDelete(null);

    if (pending.scope === "global") {
      const globalServer = findGlobalServer(pending.server.serverId);
      if (globalServer) {
        await handleDelete(globalServer);
      }
      return;
    }

    const projectServer = findProjectServer(pending.server.serverId);
    if (projectServer) {
      await handleProjectDelete(projectServer);
    }
  };

  const pendingDeleteIsSnowCli = pendingDelete
    ? pendingDelete.scope === "global"
      ? findGlobalServer(pendingDelete.server.serverId)?.source === "snow-cli"
      : findProjectServer(pendingDelete.server.serverId)?.source === "snow-cli"
    : false;

  return (
    <div className="api-settings-page" role="region">
      <McpSettingsSummary
        totalCount={activeServers.length}
        enabledCount={enabledCount}
      />

      <div className="api-settings-actions">
        {isGlobalScope && !isBuiltinCategory ? (
          <>
            <button
              className="api-settings-action-btn primary"
              onClick={() => void handleImport()}
              type="button"
              disabled={isBusy}
            >
              {isLoading ? (
                <Loader2 size={15} className="spin" />
              ) : (
                <Download size={15} />
              )}
              <span>
                {t("settings.syncSnowCliMcp", {
                  defaultValue: "Sync Snow CLI MCP settings",
                })}
              </span>
            </button>
            <button
              className="api-settings-action-btn secondary"
              onClick={startAdd}
              type="button"
              disabled={isBusy}
            >
              <Plus size={15} />
              <span>
                {t("settings.mcpAddNew", { defaultValue: "Add server" })}
              </span>
            </button>
          </>
        ) : (
          <>
            <button
              className="api-settings-action-btn secondary"
              onClick={() => void load()}
              type="button"
              disabled={isBusy || fetchingToolServerIds.size > 0}
            >
              <RefreshCw size={15} className={isLoading ? "spin" : ""} />
              <span>
                {isGlobalScope
                  ? t("settings.mcpBuiltinRefresh", {
                      defaultValue: "Refresh built-in MCP",
                    })
                  : t("settings.mcpProjectRefresh", {
                      defaultValue: "Refresh project MCP",
                    })}
              </span>
            </button>
            {!isBuiltinCategory && (
              <button
                className="api-settings-action-btn secondary"
                onClick={startAdd}
                type="button"
                disabled={isBusy || !activeDirectory}
              >
                <Plus size={15} />
                <span>
                  {t("settings.mcpAddProjectServer", {
                    defaultValue: "Add project server",
                  })}
                </span>
              </button>
            )}
          </>
        )}
      </div>

      <AutoDismissNotice
        message={error || status}
        tone={error ? "error" : "success"}
        onDismiss={() => {
          setError("");
          setStatus("");
        }}
      />

      <div
        className="skills-settings-tabs"
        role="tablist"
        aria-label={t("settings.mcpScopeTabs", {
          defaultValue: "MCP scope",
        })}
      >
        <button
          className={`skills-settings-tab ${isGlobalScope ? "active" : ""}`}
          type="button"
          role="tab"
          aria-selected={isGlobalScope}
          onClick={() => setActiveScope("global")}
        >
          <Globe2 size={14} strokeWidth={1.8} />
          <span>{t("settings.mcpTabGlobal", { defaultValue: "Global" })}</span>
          <small>
            {globalListItems.length + globalBuiltinListItems.length}
          </small>
        </button>
        <button
          className={`skills-settings-tab ${!isGlobalScope ? "active" : ""}`}
          type="button"
          role="tab"
          aria-selected={!isGlobalScope}
          onClick={() => setActiveScope("project")}
          disabled={!activeDirectory}
        >
          <Folder size={14} strokeWidth={1.8} />
          <span>
            {t("settings.mcpTabProject", { defaultValue: "Project" })}
          </span>
          <small>{projectListItems.length}</small>
        </button>
      </div>

      <div
        className="import-settings-tabs mcp-category-tabs"
        role="tablist"
        aria-label={t("settings.mcpCategoryTabs", {
          defaultValue: "MCP category",
        })}
      >
        <button
          className={`import-settings-tab ${!isBuiltinCategory ? "active" : ""}`}
          type="button"
          role="tab"
          aria-selected={!isBuiltinCategory}
          onClick={() => setActiveCategory("external")}
        >
          <Plug size={13} strokeWidth={1.8} />
          <span>
            {t("settings.mcpCategoryExternal", { defaultValue: "External" })}
          </span>
          <small>{scopeExternalItems.length}</small>
        </button>
        <button
          className={`import-settings-tab ${isBuiltinCategory ? "active" : ""}`}
          type="button"
          role="tab"
          aria-selected={isBuiltinCategory}
          onClick={() => setActiveCategory("builtin")}
        >
          <Boxes size={13} strokeWidth={1.8} />
          <span>
            {t("settings.mcpCategoryBuiltin", { defaultValue: "Built-in" })}
          </span>
          <small>{scopeBuiltinItems.length}</small>
        </button>
      </div>

      <div className="api-settings-manual-form">
        <div className="api-settings-manual-header">
          <strong>{listTitle}</strong>
          <span>{listInfo}</span>
        </div>

        <div className="api-settings-form-body">
          <McpSearchInput
            value={serverQuery}
            onChange={setServerQuery}
            placeholder={t("settings.mcpServerSearchPlaceholder", {
              defaultValue: "Search servers or tools",
            })}
          />
          <McpSettingsList
            servers={filteredServers}
            isBusy={isBusy}
            listTitle={listTitle}
            emptyMessage={emptyMessage}
            toolsByServerId={toolsByServerId}
            fetchingToolServerIds={fetchingToolServerIds}
            onToggleEnabled={handleListToggle}
            onFetchTools={handleListFetchTools}
            onToggleTool={handleListToggleTool}
            onToggleAllTools={handleListToggleAllTools}
            onEdit={handleListEdit}
            onDelete={handleListDelete}
          />
        </div>
      </div>

      <Modal
        open={Boolean(draft)}
        title={t("settings.mcpEditorTitle", {
          defaultValue: "MCP server editor",
        })}
        description={
          draft?.name || t("settings.mcpAddNew", { defaultValue: "Add server" })
        }
        closeLabel={t("settings.cancel", { defaultValue: "Cancel" })}
        onClose={cancelDraft}
        closeDisabled={isBusy}
        size="large"
        className="mcp-settings-editor-modal"
        footer={
          draft && (
            <McpSettingsEditorActions
              isBusy={isBusy}
              isSaving={isSaving}
              onCancel={cancelDraft}
            />
          )
        }
      >
        {draft && (
          <McpSettingsEditor
            draft={draft}
            isBusy={isBusy}
            isSaving={isSaving}
            errorMessage={error}
            onDismissError={() => setError("")}
            tools={
              draft.serverId
                ? toolsByServerId[
                    isGlobalScope
                      ? draft.serverId
                      : `external:${draft.serverId}`
                  ]
                : undefined
            }
            isFetchingTools={
              Boolean(draft.serverId) &&
              fetchingToolServerIds.has(
                isGlobalScope ? draft.serverId : `external:${draft.serverId}`,
              )
            }
            onFetchTools={() => {
              if (isGlobalScope) {
                const server = servers.find(
                  (item) => item.serverId === draft.serverId,
                );
                if (server) {
                  void handleFetchTools(server);
                }
                return;
              }
              const server = projectListItems.find(
                (item) => item.serverId === `external:${draft.serverId}`,
              );
              if (server) {
                void handleProjectFetchTools(server);
              }
            }}
            onDraftChange={patchDraft}
            onUpdatePair={updatePair}
            onAddPair={addPair}
            onRemovePair={removePair}
            onUpdateArg={updateArg}
            onAddArg={addArg}
            onRemoveArg={removeArg}
            onCancel={cancelDraft}
            onSave={(overrideDraft) => void saveDraft(overrideDraft)}
          />
        )}
      </Modal>

      <ConfirmDialog
        open={Boolean(pendingGlobalToggle)}
        title={
          pendingGlobalToggle?.nextEnabled
            ? t("settings.mcpGlobalEnableTitle", {
                defaultValue: "Enable global MCP server",
              })
            : t("settings.mcpGlobalDisableTitle", {
                defaultValue: "Disable global MCP server",
              })
        }
        message={
          pendingGlobalToggle?.nextEnabled
            ? t("settings.mcpGlobalEnableConfirm", {
                defaultValue:
                  "Also enable {{name}} for the current project {{project}}?",
                values: {
                  name: pendingGlobalToggle?.server.name ?? "",
                  project: activeDirectory?.name ?? "",
                },
              })
            : t("settings.mcpGlobalDisableConfirm", {
                defaultValue:
                  "Disabling {{name}} globally also stops it in every project, including the current one. Disable anyway?",
                values: { name: pendingGlobalToggle?.server.name ?? "" },
              })
        }
        confirmLabel={
          pendingGlobalToggle?.askProject
            ? t("settings.mcpGlobalEnableBoth", {
                defaultValue: "Global and current project",
              })
            : t("settings.disable", { defaultValue: "Disable" })
        }
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        extraLabel={
          pendingGlobalToggle?.askProject
            ? t("settings.mcpGlobalEnableOnly", { defaultValue: "Global only" })
            : undefined
        }
        onExtra={() => {
          const pending = pendingGlobalToggle;
          if (!pending) {
            return;
          }
          setPendingGlobalToggle(null);
          void applyGlobalToggle(pending.server, pending.kind, true, false);
        }}
        variant={pendingGlobalToggle?.nextEnabled ? "default" : "warning"}
        onConfirm={() => {
          const pending = pendingGlobalToggle;
          if (!pending) {
            return;
          }
          setPendingGlobalToggle(null);
          void applyGlobalToggle(
            pending.server,
            pending.kind,
            pending.nextEnabled,
            pending.askProject,
          );
        }}
        onCancel={() => setPendingGlobalToggle(null)}
      />

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title={t("settings.mcpDeleteConfirmTitle", {
          defaultValue: "Delete MCP server",
        })}
        message={
          pendingDeleteIsSnowCli
            ? t("settings.mcpDeleteSnowCliConfirm", {
                defaultValue:
                  "Delete {{name}} from Snow App and its Snow CLI settings file? This prevents it from returning after the next sync.",
                values: { name: pendingDelete?.server.name ?? "" },
              })
            : t("settings.mcpDeleteConfirm", {
                defaultValue: "Delete the MCP server {{name}}?",
                values: { name: pendingDelete?.server.name ?? "" },
              })
        }
        confirmLabel={t("settings.delete", { defaultValue: "Delete" })}
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        variant="danger"
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
