import { Folder, Globe2, Loader2, Plus, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ApiConfigRecord,
  Model,
  SubAgentConfigRecord,
} from "../../../preload";
import { AutoDismissNotice } from "../AutoDismissNotice";
import { Modal } from "../common/Modal";
import { useI18n } from "../../i18n";
import { formatMcpError } from "./mcpSettings/mcpErrorMessages";
import { SubAgentEditor, SubAgentEditorActions } from "./subAgent/SubAgentEditor";
import { SubAgentList } from "./subAgent/SubAgentList";
import { SubAgentSummary } from "./subAgent/SubAgentSummary";
import {
  createDraftFromItem,
  EMPTY_SUB_AGENT_DRAFT,
  toSubAgentInput,
  usesAllTools,
} from "./subAgent/subAgentUtils";
import type {
  SubAgentDraft,
  SubAgentSettingsPanelProps,
  SubAgentToolOption,
} from "./subAgent/types";

export function SubAgentSettingsPanel({
  activeDirectory,
  onClose,
}: SubAgentSettingsPanelProps): React.JSX.Element {
  const { t } = useI18n();
  const [agents, setAgents] = useState<SubAgentConfigRecord[]>([]);
  const [apiConfigs, setApiConfigs] = useState<ApiConfigRecord[]>([]);
  const [draft, setDraft] = useState<SubAgentDraft | null>(null);
  const [toolOptions, setToolOptions] = useState<SubAgentToolOption[]>([]);
  const [modelOptions, setModelOptions] = useState<Model[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isToolCatalogLoading, setIsToolCatalogLoading] = useState(false);
  const [isModelCatalogLoading, setIsModelCatalogLoading] = useState(false);
  const [toolCatalogError, setToolCatalogError] = useState("");
  const [modelCatalogError, setModelCatalogError] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [activeScope, setActiveScope] = useState<"global" | "project">(
    "global"
  );
  const toolCatalogGenerationRef = useRef(0);
  const modelCatalogGenerationRef = useRef(0);
  const projectId = activeDirectory?.directoryId;
  const isGlobalScope = activeScope === "global";
  /** 当前作用域对应的 projectId：全局 Tab 为 undefined，项目 Tab 为当前项目。 */
  const scopeProjectId = isGlobalScope ? undefined : projectId;
  const isBusy = isLoading || isSaving;

  const load = useCallback(async () => {
    setIsLoading(true);
    setError("");
    try {
      const [nextAgents, nextApiConfigs] = await Promise.all([
        window.snow.listSubAgentConfigs(scopeProjectId),
        window.snow.listApiConfigs(),
      ]);
      // 全局 Tab 只显示全局子代理（projectId 为空）；项目 Tab 由后端按项目过滤。
      setAgents(
        isGlobalScope
          ? nextAgents.filter((agent) => !agent.projectId)
          : nextAgents
      );
      setApiConfigs(nextApiConfigs);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : t("settings.subAgentLoadError", {
              defaultValue: "Failed to load sub-agent configurations",
            })
      );
    } finally {
      setIsLoading(false);
    }
  }, [t, scopeProjectId, isGlobalScope]);

  const loadProjectTools = useCallback(async () => {
    const generation = toolCatalogGenerationRef.current + 1;
    toolCatalogGenerationRef.current = generation;
    setToolOptions([]);
    setToolCatalogError("");
    if (!projectId) {
      setIsToolCatalogLoading(false);
      return;
    }

    setIsToolCatalogLoading(true);
    try {
      const servers = await window.snow.listMcpProjectServers(projectId);
      const availableServers = servers.filter(
        (server) => server.globalEnabled && server.enabled && !server.error
      );
      // Rust 侧 listMcpProjectServers 已并发发现各启用外部服务器的
      // 工具并随列表返回（进程内 TTL 缓存，重复打开面板直接命中），
      // 无需再逐个服务器发起 IPC；单个服务器发现失败仅被过滤，
      // 不再拖垮整个列表。
      const uniqueTools = new Map<string, SubAgentToolOption>();
      for (const server of availableServers) {
        for (const tool of server.tools) {
          if (!tool.enabled || uniqueTools.has(tool.name)) {
            continue;
          }
          uniqueTools.set(tool.name, {
            name: tool.name,
            description: tool.description,
            serverId: server.id,
            serverName: server.name,
          });
        }
      }
      if (toolCatalogGenerationRef.current === generation) {
        setToolOptions(Array.from(uniqueTools.values()));
      }
    } catch (catalogError) {
      if (toolCatalogGenerationRef.current === generation) {
        setToolCatalogError(formatMcpError(catalogError, t));
      }
    } finally {
      if (toolCatalogGenerationRef.current === generation) {
        setIsToolCatalogLoading(false);
      }
    }
  }, [projectId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // 活动项目变为空时（切换到无项目），项目 Tab 失去作用域上下文，
  // 强制回到全局 Tab，避免以 undefined projectId 误加载全部子代理。
  useEffect(() => {
    if (!activeDirectory) {
      setActiveScope("global");
    }
  }, [activeDirectory]);

  useEffect(() => {
    void loadProjectTools();
  }, [loadProjectTools]);

  useEffect(() => {
    const generation = modelCatalogGenerationRef.current + 1;
    modelCatalogGenerationRef.current = generation;
    setModelOptions([]);
    setModelCatalogError("");

    const profileName = draft?.configProfile.trim() ?? "";
    if (!profileName) {
      setIsModelCatalogLoading(false);
      return;
    }

    const apiConfig = apiConfigs.find(
      (config) => config.profileName === profileName
    );
    if (!apiConfig) {
      setIsModelCatalogLoading(false);
      return;
    }

    setIsModelCatalogLoading(true);
    void window.snow
      .fetchAvailableModelsForConfig({
        baseUrl: apiConfig.baseUrl,
        baseUrlMode: apiConfig.baseUrlMode,
        apiKey: apiConfig.apiKey,
        requestMethod: apiConfig.requestMethod,
        customHeaderSchemeId: apiConfig.customHeaderSchemeId,
      })
      .then((models) => {
        if (modelCatalogGenerationRef.current === generation) {
          setModelOptions(models);
        }
      })
      .catch((modelError: unknown) => {
        if (modelCatalogGenerationRef.current === generation) {
          setModelCatalogError(
            modelError instanceof Error
              ? modelError.message
              : t("settings.subAgentModelsLoadError", {
                  defaultValue: "Failed to load models for this API profile",
                })
          );
        }
      })
      .finally(() => {
        if (modelCatalogGenerationRef.current === generation) {
          setIsModelCatalogLoading(false);
        }
      });
  }, [apiConfigs, draft?.configProfile, t]);

  const startAdd = (): void => {
    const maxSortOrder = agents.reduce(
      (maximum, agent) => Math.max(maximum, agent.sortOrder),
      -1
    );
    setDraft({
      ...EMPTY_SUB_AGENT_DRAFT,
      configProfile: "",
      sortOrder: maxSortOrder + 1,
    });
    setError("");
    setStatus("");
  };

  const startEdit = (agent: SubAgentConfigRecord): void => {
    setDraft(createDraftFromItem(agent));
    setError("");
    setStatus("");
  };

  const cancelDraft = (): void => {
    setDraft(null);
    setError("");
  };

  const saveDraft = async (): Promise<void> => {
    if (!draft) return;
    if (!draft.name.trim()) {
      setError(
        t("settings.subAgentNameRequired", {
          defaultValue: "Sub-agent name is required.",
        })
      );
      return;
    }
    if (
      draft.configProfile &&
      !apiConfigs.some((config) => config.profileName === draft.configProfile)
    ) {
      setError(
        t("settings.subAgentApiProfileUnavailable", {
          defaultValue: "The selected API profile is no longer available.",
        })
      );
      return;
    }
    const allToolsEnabled = usesAllTools(draft.toolNames);
    if (!projectId && draft.toolNames.length > 0 && !allToolsEnabled) {
      setError(
        t("settings.subAgentToolsNoProject", {
          defaultValue: "Select a project before choosing MCP tools.",
        })
      );
      return;
    }
    if (isToolCatalogLoading && !allToolsEnabled) {
      setError(
        t("settings.subAgentToolsLoading", {
          defaultValue: "Loading project MCP tools...",
        })
      );
      return;
    }
    if (toolCatalogError && !allToolsEnabled) {
      setError(toolCatalogError);
      return;
    }
    const availableToolNames = new Set(toolOptions.map((tool) => tool.name));
    if (
      !allToolsEnabled &&
      draft.toolNames.some((toolName) => !availableToolNames.has(toolName))
    ) {
      setError(
        t("settings.subAgentToolsUnavailable", {
          defaultValue:
            "Some saved MCP tools are not enabled for the current project.",
        })
      );
      return;
    }

    setIsSaving(true);
    setError("");
    setStatus("");
    try {
      const isExisting = Boolean(draft.agentId);
      const nextAgents = await window.snow.upsertSubAgentConfig(
        scopeProjectId,
        toSubAgentInput(draft)
      );
      setAgents(
        isGlobalScope
          ? nextAgents.filter((agent) => !agent.projectId)
          : nextAgents
      );
      setDraft(null);
      setStatus(
        isExisting
          ? t("settings.subAgentSaveSuccess", {
              defaultValue: "Saved sub-agent configuration.",
            })
          : t("settings.subAgentAddSuccess", {
              defaultValue: "Added sub-agent configuration.",
            })
      );
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : t("settings.subAgentSaveError", {
              defaultValue: "Failed to save sub-agent configuration",
            })
      );
    } finally {
      setIsSaving(false);
    }
  };

  const deleteAgent = async (agent: SubAgentConfigRecord): Promise<void> => {
    if (agent.builtin) return;
    setIsLoading(true);
    setError("");
    setStatus("");
    try {
      const nextAgents = await window.snow.deleteSubAgentConfig(
        agent.agentId,
        agent.projectId || undefined
      );
      setAgents(
        isGlobalScope
          ? nextAgents.filter((item) => !item.projectId)
          : nextAgents
      );
      setStatus(
        t("settings.subAgentDeleteSuccess", {
          defaultValue: "Deleted sub-agent configuration.",
        })
      );
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : t("settings.subAgentDeleteError", {
              defaultValue: "Failed to delete sub-agent configuration",
            })
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="api-settings-page" role="region">
      <div className="api-settings-page-header">
        <div className="api-settings-title-group">
          <strong>
            {t("settings.subAgentTitle", {
              defaultValue: "Sub-agent settings",
            })}
          </strong>
          <span className="settings-item-description">
            {t("settings.subAgentSettingsInfo", {
              defaultValue: "Manage specialized AI sub-agents.",
            })}
          </span>
        </div>
        {onClose && (
          <button
            className="icon-btn ghost"
            onClick={onClose}
            type="button"
            aria-label={t("settings.closeSubAgentSettings", {
              defaultValue: "Close sub-agent settings",
            })}
            title={t("settings.closeSubAgentSettings", {
              defaultValue: "Close sub-agent settings",
            })}
          >
            <X size={15} strokeWidth={1.8} />
          </button>
        )}
      </div>

      <SubAgentSummary
        agents={agents}
        availableToolCount={toolOptions.length}
      />

      <div
        className="skills-settings-tabs"
        role="tablist"
        aria-label={t("settings.subAgentScopeTabs", {
          defaultValue: "Sub-agent scope",
        })}
      >
        <button
          className={`skills-settings-tab ${isGlobalScope ? "active" : ""}`}
          type="button"
          role="tab"
          aria-selected={isGlobalScope}
          onClick={() => {
            setActiveScope("global");
            setDraft(null);
          }}
        >
          <Globe2 size={14} strokeWidth={1.8} />
          <span>
            {t("settings.subAgentTabGlobal", { defaultValue: "Global" })}
          </span>
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
            {t("settings.subAgentTabProject", { defaultValue: "Project" })}
          </span>
        </button>
      </div>

      <div className="api-settings-actions">
        <button
          className="api-settings-action-btn primary"
          onClick={startAdd}
          type="button"
          disabled={isBusy}
        >
          <Plus size={15} />
          <span>
            {t("settings.subAgentAddNew", { defaultValue: "Add sub-agent" })}
          </span>
        </button>
        <button
          className="api-settings-action-btn secondary"
          onClick={() => void load()}
          type="button"
          disabled={isBusy}
        >
          {isLoading ? (
            <Loader2 size={15} className="spin" />
          ) : (
            <RefreshCw size={15} />
          )}
          <span>{t("settings.refresh", { defaultValue: "Refresh" })}</span>
        </button>
      </div>

      <AutoDismissNotice
        message={error || status}
        tone={error ? "error" : "success"}
        onDismiss={() => {
          setError("");
          setStatus("");
        }}
      />

      <div className="api-settings-manual-form">
        <div className="api-settings-manual-header">
          <strong>
            {t("settings.subAgentManageTitle", {
              defaultValue: "Manage sub-agents",
            })}
          </strong>
          <span>
            {isGlobalScope
              ? t("settings.subAgentGlobalTabInfo", {
                  defaultValue:
                    "Manage sub-agents shared by all projects. Sub-agent configurations are stored in the local database.",
                })
              : t("settings.subAgentProjectTabInfo", {
                  defaultValue:
                    "Manage sub-agents for {{name}}. Project sub-agents override global ones with the same id.",
                  values: { name: activeDirectory?.name ?? "" },
                })}
          </span>
        </div>
        <div className="api-settings-form-body">
          <SubAgentList
            agents={agents}
            isBusy={isBusy}
            onEdit={startEdit}
            onDelete={(agent) => void deleteAgent(agent)}
          />
        </div>
      </div>

      <Modal
        open={Boolean(draft)}
        title={t("settings.subAgentEditorTitle", {
          defaultValue: "Sub-agent editor",
        })}
        description={
          draft?.name ||
          t("settings.subAgentAddNew", { defaultValue: "Add sub-agent" })
        }
        closeLabel={t("settings.cancel", { defaultValue: "Cancel" })}
        onClose={cancelDraft}
        closeDisabled={isBusy}
        size="large"
        className="sub-agent-editor-modal"
        footer={
          draft && (
            <SubAgentEditorActions
              isBusy={isBusy}
              isSaving={isSaving}
              onCancel={cancelDraft}
            />
          )
        }
      >
        {draft && (
          <SubAgentEditor
            apiConfigs={apiConfigs}
            draft={draft}
            isBusy={isBusy}
            isSaving={isSaving}
            isToolCatalogLoading={isToolCatalogLoading}
            isModelCatalogLoading={isModelCatalogLoading}
            modelCatalogError={modelCatalogError}
            modelOptions={modelOptions}
            projectId={projectId}
            toolCatalogError={toolCatalogError}
            toolOptions={toolOptions}
            onDraftChange={(patch) =>
              setDraft((previous) =>
                previous ? { ...previous, ...patch } : previous
              )
            }
            onCancel={cancelDraft}
            onSave={() => void saveDraft()}
          />
        )}
      </Modal>
    </div>
  );
}
