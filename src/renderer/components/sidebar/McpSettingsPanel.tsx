import {
  Download,
  Folder,
  Globe2,
  Loader2,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ImportResourceRecord,
  ImportResourceReleaseDisposition,
  ImportResourceSource,
  McpProjectServerStatus,
  WorkspaceDirectoryRecord,
} from "../../../preload";
import { useI18n } from "../../i18n";
import { AutoDismissNotice } from "../AutoDismissNotice";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { Modal } from "../common/Modal";
import { McpSettingsEditor, McpSettingsEditorActions } from "./mcpSettings/McpSettingsEditor";
import {
  McpSettingsList,
  type McpSettingsListItem,
} from "./mcpSettings/McpSettingsList";
import { McpSettingsSummary } from "./mcpSettings/McpSettingsSummary";
import { formatMcpError } from "./mcpSettings/mcpErrorMessages";
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
  onClose?: () => void;
};

type McpScope = "global" | "project";

export function McpSettingsPanel({
  activeDirectory,
  onClose,
}: McpSettingsPanelProps): React.JSX.Element {
  const { t } = useI18n();
  const [activeScope, setActiveScope] = useState<McpScope>("global");
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [projectServers, setProjectServers] = useState<
    McpProjectServerStatus[]
  >([]);
  const [projectServerConfigs, setProjectServerConfigs] = useState<
    ProjectMcpServerConfig[]
  >([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isReleasing, setIsReleasing] = useState(false);
  const [importResources, setImportResources] = useState<ImportResourceRecord[]>([]);
  const [pendingRelease, setPendingRelease] = useState<{
    resource: ImportResourceRecord;
    source: ImportResourceSource;
    disposition: ImportResourceReleaseDisposition;
  } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{
    server: McpSettingsListItem;
    scope: McpScope;
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
  const loadGenerationRef = useRef(0);

  const isBusy = isLoading || isSaving || isReleasing;

  const load = useCallback(async (): Promise<void> => {
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    setIsLoading(true);
    setError("");

    try {
      const [globalItems, projectItems, projectConfigItems, managedResources] = await Promise.all(
        [
          window.snow.listMcpServerConfigs(),
          activeDirectory
            ? window.snow.listMcpProjectServers(activeDirectory.directoryId)
            : Promise.resolve([]),
          activeDirectory
            ? window.snow.listProjectMcpServerConfigs(
                activeDirectory.directoryId
              )
            : Promise.resolve([]),
          window.snow.listManagedImportResources(),
        ]
      );
      if (loadGenerationRef.current !== generation) {
        return;
      }

      setServers(globalItems);
      setProjectServers(projectItems);
      setProjectServerConfigs(projectConfigItems);
      setImportResources(managedResources);
      setToolsByServerId((previous) => {
        const next = { ...previous };
        projectItems.forEach((server) => {
          if (server.tools.length > 0) {
            next[server.id] = server.tools;
          }
        });
        return next;
      });
    } catch (loadError) {
      if (loadGenerationRef.current === generation) {
        setError(
          loadError instanceof Error
            ? loadError.message
            : t("settings.mcpLoadError", {
                defaultValue: "Failed to load MCP servers",
              })
        );
      }
    } finally {
      if (loadGenerationRef.current === generation) {
        setIsLoading(false);
      }
    }
  }, [activeDirectory, t]);

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
        })
      );
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.mcpImportError", {
              defaultValue: "Failed to sync Snow CLI MCP settings",
            })
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
      -1
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

  const adoptImportedResource = async (
    resource: ImportResourceRecord | undefined
  ): Promise<void> => {
    const source = resource?.sources[0];
    if (!resource || !source) {
      return;
    }
    await window.snow.releaseManagedImportResource({
      resourceId: resource.resourceId,
      sourceId: source.sourceId,
      disposition: "adopt",
    });
  };

  const patchDraft = (patch: Partial<McpServerDraft>) => {
    setDraft((previous) => (previous ? { ...previous, ...patch } : null));
  };

  const updatePair = (
    group: "env" | "headers",
    pairId: string,
    field: "key" | "value",
    value: string
  ) => {
    setDraft((previous) =>
      previous
        ? {
            ...previous,
            [group]: previous[group].map((pair) =>
              pair.id === pairId ? { ...pair, [field]: value } : pair
            ),
          }
        : null
    );
  };

  const addPair = (group: "env" | "headers") => {
    setDraft((previous) =>
      previous
        ? { ...previous, [group]: [...previous[group], createMcpPair()] }
        : null
    );
  };

  const removePair = (group: "env" | "headers", pairId: string) => {
    setDraft((previous) =>
      previous
        ? {
            ...previous,
            [group]: previous[group].filter((pair) => pair.id !== pairId),
          }
        : null
    );
  };

  const updateArg = (argId: string, value: string) => {
    setDraft((previous) =>
      previous
        ? {
            ...previous,
            args: previous.args.map((arg) =>
              arg.id === argId ? { ...arg, value } : arg
            ),
          }
        : null
    );
  };

  const addArg = () => {
    setDraft((previous) =>
      previous
        ? { ...previous, args: [...previous.args, createMcpStringItem()] }
        : null
    );
  };

  const removeArg = (argId: string) => {
    setDraft((previous) =>
      previous
        ? { ...previous, args: previous.args.filter((arg) => arg.id !== argId) }
        : null
    );
  };

  const saveDraft = async () => {
    if (!draft) return;

    if (!draft.name.trim()) {
      setError(
        t("settings.mcpNameRequired", {
          defaultValue: "MCP server name is required.",
        })
      );
      setStatus("");
      return;
    }

    if (draft.transportType === "http" && !draft.url.trim()) {
      setError(
        t("settings.mcpUrlRequired", { defaultValue: "URL is required." })
      );
      setStatus("");
      return;
    }

    if (draft.transportType === "stdio" && !draft.command.trim()) {
      setError(
        t("settings.mcpCommandRequired", {
          defaultValue: "Command is required.",
        })
      );
      setStatus("");
      return;
    }

    if (hasDuplicatePairKey(draft.env) || hasDuplicatePairKey(draft.headers)) {
      setError(
        t("settings.mcpDuplicateKey", {
          defaultValue: "Environment and header names must be unique.",
        })
      );
      setStatus("");
      return;
    }

    const timeoutMs = draft.timeoutMs.trim() ? Number(draft.timeoutMs) : null;
    if (
      timeoutMs !== null &&
      (!Number.isInteger(timeoutMs) || timeoutMs <= 0)
    ) {
      setError(
        t("settings.mcpTimeoutInvalid", {
          defaultValue: "Timeout must be a positive integer.",
        })
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
        })
      );
      return;
    }
    const importResource = draft.serverId
      ? importResources.find((resource) =>
          resource.resourceType === "mcp" &&
          resource.scope === operationScope &&
          resource.projectId === (operationScope === "project" ? operationProjectId : undefined) &&
          resource.targetId === draft.serverId
        )
      : undefined;

    setIsSaving(true);
    setError("");
    setStatus("");

    try {
      if (operationScope === "global") {
        const maxSortOrder = servers.reduce(
          (max, server) => Math.max(max, server.sortOrder),
          -1
        );
        const items = await window.snow.upsertMcpServerConfig(
          toInput(draft, maxSortOrder + 1)
        );
        setServers(items);
      } else if (operationProjectId) {
        const maxSortOrder = projectServerConfigs.reduce(
          (max, server) => Math.max(max, server.sortOrder),
          -1
        );
        const items = await window.snow.upsertProjectMcpServerConfig(
          operationProjectId,
          toProjectInput(draft, maxSortOrder + 1)
        );
        if (loadGenerationRef.current !== generation) {
          return;
        }
        setProjectServerConfigs(items);
        const nextProjectServers = await window.snow.listMcpProjectServers(
          operationProjectId
        );
        if (loadGenerationRef.current !== generation) {
          return;
        }
        setProjectServers(nextProjectServers);
      }

      await adoptImportedResource(importResource);

      setDraft(null);
      setStatus(
        draft.serverId
          ? t("settings.mcpSaveSuccess", {
              defaultValue: "Saved MCP server.",
            })
          : t("settings.mcpAddSuccess", {
              defaultValue: "Added MCP server.",
            })
      );
    } catch (e) {
      if (
        operationScope === "global" ||
        loadGenerationRef.current === generation
      ) {
        setError(
          e instanceof Error
            ? e.message
            : t("settings.mcpSaveError", {
                defaultValue: "Failed to save MCP server",
              })
        );
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

  const toggleEnabled = async (server: McpServerConfig) => {
    setError("");
    setStatus("");

    try {
      const items = await window.snow.upsertMcpServerConfig({
        serverId: server.serverId,
        name: server.name,
        transportType: server.transportType,
        url: server.url,
        command: server.command,
        argsJson: server.argsJson,
        envJson: server.envJson,
        headersJson: server.headersJson,
        enabled: !server.enabled,
        ...(server.timeoutMs ? { timeoutMs: server.timeoutMs } : {}),
        sortOrder: server.sortOrder,
        source: server.source,
      });
      setServers(items);
      await adoptImportedResource(importResources.find((resource) =>
        resource.resourceType === "mcp" &&
        resource.scope === "global" &&
        resource.targetId === server.serverId
      ));
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.mcpSaveError", {
              defaultValue: "Failed to update MCP server",
            })
      );
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
        })
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
        })
      );
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.mcpDeleteError", {
              defaultValue: "Failed to delete MCP server",
            })
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
    importResource: importResources.find((resource) =>
      resource.resourceType === "mcp" &&
      resource.scope === "global" &&
      resource.targetId === server.serverId
    ),
  }));
  const projectListItems: McpSettingsListItem[] = projectServers.map(
    (server) => {
      const configServerId = server.id.replace(/^external:/, "");
      const projectConfig = projectServerConfigs.find(
        (item) => item.serverId === configServerId
      );
      return {
        serverId: server.id,
        name: server.name,
        enabled: server.enabled,
        globalEnabled: server.globalEnabled,
        detail:
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
              }),
        canManage: server.source === "project",
        importResource: projectConfig
          ? importResources.find((resource) =>
              resource.resourceType === "mcp" &&
              resource.scope === "project" &&
              resource.projectId === activeDirectory?.directoryId &&
              resource.targetId === projectConfig.serverId
            )
          : undefined,
      };
    }
  );
  const isGlobalScope = activeScope === "global";
  const activeServers = isGlobalScope ? globalListItems : projectListItems;
  const enabledCount = activeServers.filter(
    (server) => server.enabled && server.globalEnabled
  ).length;
  const listTitle = isGlobalScope
    ? t("settings.mcpGlobalListTitle", { defaultValue: "Global MCP servers" })
    : t("settings.mcpProjectListTitle", {
        defaultValue: "Project MCP servers",
      });
  const emptyMessage = isGlobalScope
    ? t("settings.mcpNoServers", {
        defaultValue:
          "No MCP servers yet. Sync from Snow CLI settings.json or add one manually.",
      })
    : t("settings.mcpProjectNoServers", {
        defaultValue: "No MCP servers are available for this project.",
      });

  const handleProjectToggle = async (
    server: McpSettingsListItem
  ): Promise<void> => {
    if (!activeDirectory || !server.globalEnabled || isBusy) {
      return;
    }

    const operationProjectId = activeDirectory.directoryId;
    const generation = loadGenerationRef.current;
    const configServerId = server.serverId.replace(/^external:/, "");
    const projectConfig = projectServerConfigs.find(
      (item) => item.serverId === configServerId
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
          !server.enabled
        );
      }
      await adoptImportedResource(projectConfig
        ? importResources.find((resource) =>
            resource.resourceType === "mcp" &&
            resource.scope === "project" &&
            resource.projectId === operationProjectId &&
            resource.targetId === projectConfig.serverId
          )
        : undefined);
      if (loadGenerationRef.current !== generation) {
        return;
      }

      const [nextProjectServers, nextProjectConfigs] = await Promise.all([
        window.snow.listMcpProjectServers(operationProjectId),
        window.snow.listProjectMcpServerConfigs(operationProjectId),
      ]);
      if (loadGenerationRef.current !== generation) {
        return;
      }
      setProjectServers(nextProjectServers);
      setProjectServerConfigs(nextProjectConfigs);
    } catch (updateError) {
      if (loadGenerationRef.current === generation) {
        setError(
          updateError instanceof Error
            ? updateError.message
            : t("settings.mcpSaveError", {
                defaultValue: "Failed to update MCP server",
              })
        );
      }
    } finally {
      if (loadGenerationRef.current === generation) {
        setIsSaving(false);
      }
    }
  };

  const handleProjectFetchTools = async (
    server: McpSettingsListItem
  ): Promise<void> => {
    if (!activeDirectory) {
      return;
    }

    const operationProjectId = activeDirectory.directoryId;
    const generation = loadGenerationRef.current;
    setFetchingToolServerIds((previous) =>
      new Set(previous).add(server.serverId)
    );
    setError("");
    setStatus("");
    try {
      const tools = await window.snow.listMcpProjectServerTools(
        operationProjectId,
        server.serverId
      );
      if (loadGenerationRef.current !== generation) {
        return;
      }
      setToolsByServerId((previous) => ({
        ...previous,
        [server.serverId]: tools,
      }));
      setStatus(
        t("settings.mcpFetchToolsSuccess", {
          defaultValue: "Fetched {{count}} tool(s) from {{name}}.",
          values: { count: tools.length, name: server.name },
        })
      );
    } catch (fetchError) {
      if (loadGenerationRef.current === generation) {
        setError(formatMcpError(fetchError, t));
      }
    } finally {
      if (loadGenerationRef.current === generation) {
        setFetchingToolServerIds((previous) => {
          const next = new Set(previous);
          next.delete(server.serverId);
          return next;
        });
      }
    }
  };

  const findGlobalServer = (serverId: string): McpServerConfig | undefined =>
    servers.find((server) => server.serverId === serverId);
  const findProjectServer = (
    scopeServerId: string
  ): ProjectMcpServerConfig | undefined => {
    const serverId = scopeServerId.replace(/^external:/, "");
    return projectServerConfigs.find((server) => server.serverId === serverId);
  };

  const handleProjectDelete = async (
    server: ProjectMcpServerConfig
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
        server.serverId
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
      const nextProjectServers = await window.snow.listMcpProjectServers(
        operationProjectId
      );
      if (loadGenerationRef.current !== generation) {
        return;
      }
      setProjectServers(nextProjectServers);
      setStatus(
        t("settings.mcpDeleteSuccess", {
          defaultValue: "Deleted MCP server.",
        })
      );
    } catch (deleteError) {
      if (loadGenerationRef.current === generation) {
        setError(
          deleteError instanceof Error
            ? deleteError.message
            : t("settings.mcpDeleteError", {
                defaultValue: "Failed to delete MCP server",
              })
        );
      }
    } finally {
      if (loadGenerationRef.current === generation) {
        setIsSaving(false);
      }
    }
  };

  const handleListToggle = (server: McpSettingsListItem): void => {
    if (isGlobalScope) {
      const globalServer = findGlobalServer(server.serverId);
      if (globalServer) {
        void toggleEnabled(globalServer);
      }
      return;
    }
    void handleProjectToggle(server);
  };

  const handleListFetchTools = (server: McpSettingsListItem): void => {
    if (isGlobalScope) {
      const globalServer = findGlobalServer(server.serverId);
      if (globalServer) {
        void handleFetchTools(globalServer);
      }
      return;
    }
    void handleProjectFetchTools(server);
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
    const source = server.importResource?.sources[0];
    if (server.importResource && source) {
      requestRelease(server.importResource, source, "delete");
      return;
    }
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

  const requestRelease = (
    resource: ImportResourceRecord,
    source: ImportResourceSource,
    disposition: ImportResourceReleaseDisposition
  ): void => setPendingRelease({ resource, source, disposition });

  const confirmRelease = async (): Promise<void> => {
    const pending = pendingRelease;
    if (!pending) {
      return;
    }
    setPendingRelease(null);
    setIsReleasing(true);
    setError("");
    setStatus("");
    try {
      await window.snow.releaseManagedImportResource({
        resourceId: pending.resource.resourceId,
        sourceId: pending.source.sourceId,
        disposition: pending.disposition,
      });
      await load();
      setStatus(
        pending.disposition === "adopt"
          ? t("settings.importResourceKeepCopySuccess", {
              defaultValue: "Kept the local copy and removed its import link.",
            })
          : t("settings.importResourceRemoveSuccess", {
              defaultValue: "Removed the imported resource association.",
            })
      );
    } catch (releaseError) {
      setError(
        releaseError instanceof Error
          ? releaseError.message
          : t("settings.importResourceRemoveError", {
              defaultValue: "Failed to remove imported resource.",
            })
      );
    } finally {
      setIsReleasing(false);
    }
  };

  const pendingDeleteIsSnowCli = pendingDelete
    ? pendingDelete.scope === "global"
      ? findGlobalServer(pendingDelete.server.serverId)?.source === "snow-cli"
      : findProjectServer(pendingDelete.server.serverId)?.source === "snow-cli"
    : false;

  return (
    <div className="api-settings-page" role="region">
      <div className="api-settings-page-header">
        <div className="api-settings-title-group">
          <strong>
            {t("settings.mcpTitle", { defaultValue: "MCP settings" })}
          </strong>
          <span className="settings-item-description">
            {t("settings.mcpSettingsInfo", {
              defaultValue: "Configure MCP servers and tools.",
            })}
          </span>
        </div>
        {onClose && (
          <button
            className="icon-btn ghost"
            onClick={onClose}
            type="button"
            aria-label={t("settings.closeMcpSettings", {
              defaultValue: "Close MCP settings",
            })}
            title={t("settings.closeMcpSettings", {
              defaultValue: "Close MCP settings",
            })}
          >
            <X size={15} strokeWidth={1.8} />
          </button>
        )}
      </div>

      <McpSettingsSummary
        totalCount={activeServers.length}
        enabledCount={enabledCount}
      />

      <div className="api-settings-actions">
        {isGlobalScope ? (
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
                {t("settings.mcpProjectRefresh", {
                  defaultValue: "Refresh project MCP",
                })}
              </span>
            </button>
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
          <small>{globalListItems.length}</small>
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

      <div className="api-settings-manual-form">
        <div className="api-settings-manual-header">
          <strong>{listTitle}</strong>
          <span>
            {isGlobalScope
              ? t("settings.mcpGlobalTabInfo", {
                  defaultValue:
                    "Manage external MCP servers shared by all projects.",
                })
              : t("settings.mcpProjectTabInfo", {
                  defaultValue:
                    "Manage project MCP servers for {{name}} and control inherited system or global servers.",
                  values: { name: activeDirectory?.name ?? "" },
                })}
          </span>
        </div>

        <div className="api-settings-form-body">
          <McpSettingsList
            servers={activeServers}
            isBusy={isBusy}
            listTitle={listTitle}
            emptyMessage={emptyMessage}
            toolsByServerId={toolsByServerId}
            fetchingToolServerIds={fetchingToolServerIds}
            onToggleEnabled={handleListToggle}
            onFetchTools={handleListFetchTools}
            onEdit={handleListEdit}
            onDelete={handleListDelete}
            onReleaseImportResource={requestRelease}
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
                isGlobalScope ? draft.serverId : `external:${draft.serverId}`
              )
            }
            onFetchTools={() => {
              if (isGlobalScope) {
                const server = servers.find(
                  (item) => item.serverId === draft.serverId
                );
                if (server) {
                  void handleFetchTools(server);
                }
                return;
              }
              const server = projectListItems.find(
                (item) => item.serverId === `external:${draft.serverId}`
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
            onSave={() => void saveDraft()}
          />
        )}
      </Modal>

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title={t("settings.mcpDeleteConfirmTitle", {
          defaultValue: "Delete MCP server",
        })}
        message={pendingDeleteIsSnowCli
          ? t("settings.mcpDeleteSnowCliConfirm", {
              defaultValue: "Delete {{name}} from Snow App and its Snow CLI settings file? This prevents it from returning after the next sync.",
              values: { name: pendingDelete?.server.name ?? "" },
            })
          : t("settings.mcpDeleteConfirm", {
              defaultValue: "Delete the MCP server {{name}}?",
              values: { name: pendingDelete?.server.name ?? "" },
            })}
        confirmLabel={t("settings.delete", { defaultValue: "Delete" })}
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        variant="danger"
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />

      <ConfirmDialog
        open={Boolean(pendingRelease)}
        title={pendingRelease?.disposition === "adopt"
          ? t("settings.importResourceKeepCopy", { defaultValue: "Keep local copy" })
          : t("settings.importResourceRemove", { defaultValue: "Remove imported resource" })}
        message={pendingRelease?.disposition === "adopt"
          ? t("settings.importResourceKeepCopyConfirm", {
              defaultValue: "Keep this local copy and remove its import association?",
            })
          : pendingRelease && pendingRelease.resource.sourceCount > 1
            ? t("settings.importResourceUnlinkConfirm", {
                defaultValue: "Remove this source association? Other sources will keep the resource available.",
              })
            : t("settings.importResourceRemoveConfirm", {
                defaultValue: "Remove this import association and delete the Snow-managed resource?",
              })}
        confirmLabel={pendingRelease?.disposition === "adopt"
          ? t("settings.importResourceKeepCopy", { defaultValue: "Keep copy" })
          : t("settings.remove", { defaultValue: "Remove" })}
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        variant={pendingRelease?.disposition === "adopt" ? "default" : "danger"}
        onConfirm={() => void confirmRelease()}
        onCancel={() => setPendingRelease(null)}
      />
    </div>
  );
}
