import { Folder, Globe2, Loader2, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ApiConfigRecord,
  Model,
  SubAgentConfigRecord,
} from "../../../preload";
import { AutoDismissNotice } from "../AutoDismissNotice";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { Modal } from "../common/Modal";
import { useI18n } from "../../i18n";
import { formatMcpError } from "./mcpSettings/mcpErrorMessages";
import {
  loadSubAgentConcurrencyLimits,
  saveSubAgentConcurrencyLimits,
  sessionConcurrencyUpperBound,
  SUB_AGENT_GLOBAL_MAX_CONCURRENCY_DEFAULT,
  SUB_AGENT_GLOBAL_MAX_CONCURRENCY_MAX,
  SUB_AGENT_GLOBAL_MAX_CONCURRENCY_MIN,
  SUB_AGENT_SESSION_MAX_CONCURRENCY_DEFAULT,
  SUB_AGENT_SESSION_MAX_CONCURRENCY_MIN,
} from "../mainContent/chatMessages/hooks/subAgentRunControl";
import {
  SubAgentEditor,
  SubAgentEditorActions,
} from "./subAgent/SubAgentEditor";
import { SubAgentList } from "./subAgent/SubAgentList";
import { SubAgentExecutionModeControl } from "./subAgent/SubAgentExecutionModeControl";
import { SubAgentSummary } from "./subAgent/SubAgentSummary";
import {
  createDraftFromItem,
  EMPTY_SUB_AGENT_DRAFT,
  SUB_AGENT_RESERVED_TOOL_NAMES,
  toSubAgentInput,
  usesAllTools,
} from "./subAgent/subAgentUtils";
import type {
  SubAgentDraft,
  SubAgentSettingsPanelProps,
  SubAgentToolOption,
} from "./subAgent/types";

/** 精简模式整体禁用的内置服务器（对子代理同样生效，与 Rust LITE_MODE_DISABLED_SERVER_IDS 一致）。 */
const LITE_MODE_SERVER_IDS = new Set([
  "builtin:browser",
  "builtin:app-control",
  "builtin:terminal",
  "builtin:computer-use",
]);

export function SubAgentSettingsPanel({
  activeDirectory,
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
  const [pendingDeletion, setPendingDeletion] =
    useState<SubAgentConfigRecord | null>(null);
  const [activeScope, setActiveScope] = useState<"global" | "project">(
    "global",
  );
  const toolCatalogGenerationRef = useRef(0);
  const modelCatalogGenerationRef = useRef(0);
  const projectId = activeDirectory?.directoryId;
  const isGlobalScope = activeScope === "global";
  /** 当前作用域对应的 projectId：全局 Tab 为 undefined，项目 Tab 为当前项目。 */
  const scopeProjectId = isGlobalScope ? undefined : projectId;
  const isBusy = isLoading || isSaving;
  // 全局/单会话两层上限共享一份持久化设置，运行时分别计算占用。
  const [globalMaxConcurrency, setGlobalMaxConcurrency] = useState(
    String(SUB_AGENT_GLOBAL_MAX_CONCURRENCY_DEFAULT),
  );
  const [sessionMaxConcurrency, setSessionMaxConcurrency] = useState(
    String(SUB_AGENT_SESSION_MAX_CONCURRENCY_DEFAULT),
  );
  // 单会话上限不得超过全局上限；任一层为 0 都表示该层不限制。
  const sessionUpperBound = sessionConcurrencyUpperBound(
    Number.parseInt(globalMaxConcurrency, 10) || 0,
  );

  useEffect(() => {
    void loadSubAgentConcurrencyLimits().then((limits) => {
      setGlobalMaxConcurrency(String(limits.global));
      setSessionMaxConcurrency(String(limits.session));
    });
  }, []);

  const saveMaxConcurrency = async (
    field: "global" | "session",
  ): Promise<void> => {
    const before = await loadSubAgentConcurrencyLimits();
    try {
      const next = await saveSubAgentConcurrencyLimits(
        field === "global"
          ? { global: globalMaxConcurrency }
          : { session: sessionMaxConcurrency },
      );
      setGlobalMaxConcurrency(String(next.global));
      setSessionMaxConcurrency(String(next.session));
      if (next.global === before.global && next.session === before.session) {
        return;
      }
      setStatus(
        t("settings.subAgentConcurrencySaved", {
          defaultValue: "Saved sub-agent concurrency limit.",
        }),
      );
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : t("settings.subAgentConcurrencySaveError", {
              defaultValue: "Failed to save sub-agent concurrency limit",
            }),
      );
      const current = await loadSubAgentConcurrencyLimits();
      setGlobalMaxConcurrency(String(current.global));
      setSessionMaxConcurrency(String(current.session));
    }
  };

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
          : nextAgents,
      );
      setApiConfigs(nextApiConfigs);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : t("settings.subAgentLoadError", {
              defaultValue: "Failed to load sub-agent configurations",
            }),
      );
    } finally {
      setIsLoading(false);
    }
  }, [t, scopeProjectId, isGlobalScope]);

  const loadToolCatalog = useCallback(async () => {
    const generation = toolCatalogGenerationRef.current + 1;
    toolCatalogGenerationRef.current = generation;
    setToolOptions([]);
    setToolCatalogError("");

    setIsToolCatalogLoading(true);
    try {
      // 全局 Tab 使用不依赖项目的全局目录；项目 Tab 使用当前项目目录。
      const [servers, liteMode] = await Promise.all([
        scopeProjectId
          ? window.snow.listMcpProjectServers(scopeProjectId)
          : window.snow.listMcpGlobalServers(),
        window.snow.getLiteMode().catch(() => false),
      ]);
      // 项目 Tab 也列出项目内已关闭的服务器/工具：子代理显式勾选可豁免项目启停；
      // 全局层（全局禁用、全局黑名单、精简模式）与发现失败仍排除。
      const availableServers = servers.filter(
        (server) =>
          server.globalEnabled &&
          !server.error &&
          (Boolean(scopeProjectId) || server.enabled) &&
          !(
            liteMode &&
            server.source === "system" &&
            LITE_MODE_SERVER_IDS.has(server.id)
          ),
      );
      // 项目内关闭的外部服务器不随列表返回工具，按需单独发现。
      const serverTools = await Promise.all(
        availableServers.map(async (server) =>
          scopeProjectId &&
          !server.enabled &&
          server.source !== "system" &&
          server.tools.length === 0
            ? window.snow
                .listMcpProjectServerTools(scopeProjectId, server.id)
                .catch(() => [])
            : server.tools,
        ),
      );
      // Rust 侧已并发发现各启用服务器的工具并随列表返回（进程内 TTL 缓存），
      // 单个服务器发现失败仅被过滤，不再拖垮整个列表。
      const uniqueTools = new Map<string, SubAgentToolOption>();
      availableServers.forEach((server, index) => {
        for (const tool of serverTools[index]) {
          if (
            !tool.globalEnabled ||
            uniqueTools.has(tool.name) ||
            SUB_AGENT_RESERVED_TOOL_NAMES.has(tool.name)
          ) {
            continue;
          }
          uniqueTools.set(tool.name, {
            name: tool.name,
            description: tool.description,
            serverId: server.id,
            serverName: server.name,
            projectDisabled:
              Boolean(scopeProjectId) && (!server.enabled || !tool.enabled),
          });
        }
      });
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
  }, [scopeProjectId, t]);

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
    void loadToolCatalog();
  }, [loadToolCatalog]);

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
      (config) => config.profileName === profileName,
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
        configJson: apiConfig.configJson.trim() || undefined,
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
                }),
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
      -1,
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
        }),
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
        }),
      );
      return;
    }
    const allToolsEnabled = usesAllTools(draft.toolNames);
    if (isToolCatalogLoading && !allToolsEnabled) {
      setError(
        t("settings.subAgentToolsLoading", {
          defaultValue: "Loading MCP tools...",
        }),
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
          defaultValue: "Some saved MCP tools are unavailable.",
        }),
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
        toSubAgentInput(draft),
      );
      setAgents(
        isGlobalScope
          ? nextAgents.filter((agent) => !agent.projectId)
          : nextAgents,
      );
      setDraft(null);
      setStatus(
        isExisting
          ? t("settings.subAgentSaveSuccess", {
              defaultValue: "Saved sub-agent configuration.",
            })
          : t("settings.subAgentAddSuccess", {
              defaultValue: "Added sub-agent configuration.",
            }),
      );
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : t("settings.subAgentSaveError", {
              defaultValue: "Failed to save sub-agent configuration",
            }),
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
        agent.projectId || undefined,
      );
      setAgents(
        isGlobalScope
          ? nextAgents.filter((item) => !item.projectId)
          : nextAgents,
      );
      setStatus(
        t("settings.subAgentDeleteSuccess", {
          defaultValue: "Deleted sub-agent configuration.",
        }),
      );
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : t("settings.subAgentDeleteError", {
              defaultValue: "Failed to delete sub-agent configuration",
            }),
      );
    } finally {
      setIsLoading(false);
    }
  };

  const confirmDelete = (): void => {
    if (!pendingDeletion || isBusy) return;
    const agent = pendingDeletion;
    setPendingDeletion(null);
    void deleteAgent(agent);
  };

  return (
    <div className="api-settings-page" role="region">
      <SubAgentSummary
        agents={agents}
        availableToolCount={toolOptions.length}
      />

      <div className="api-settings-manual-form">
        <div className="api-settings-manual-header">
          <strong>
            {t("settings.subAgentConcurrencyTitle", {
              defaultValue: "Run limits",
            })}
          </strong>
          <span>
            {t("settings.subAgentConcurrencyInfo", {
              defaultValue:
                "Two layers: the global limit caps sub-agents running across all conversations (0 = unlimited); the per-conversation limit caps each conversation (0 = unlimited) and never exceeds the global limit. Extra sub-agents queue and start when a slot frees up.",
            })}
          </span>
        </div>
        <div className="api-settings-form-grid api-settings-form-grid-responsive">
          <SubAgentExecutionModeControl
            onStatus={setStatus}
            onError={setError}
          />
          <label className="api-settings-field">
            <span>
              {t("settings.subAgentGlobalConcurrencyLabel", {
                defaultValue: "Global concurrency limit (0 = unlimited)",
              })}
            </span>
            <input
              type="number"
              min={SUB_AGENT_GLOBAL_MAX_CONCURRENCY_MIN}
              max={SUB_AGENT_GLOBAL_MAX_CONCURRENCY_MAX}
              step={1}
              value={globalMaxConcurrency}
              onChange={(event) => setGlobalMaxConcurrency(event.target.value)}
              onBlur={() => void saveMaxConcurrency("global")}
              title={t("settings.subAgentGlobalConcurrencyHint", {
                defaultValue: "Range 0-2000; 0 means unlimited.",
              })}
            />
          </label>
          <label className="api-settings-field">
            <span>
              {t("settings.subAgentSessionConcurrencyLabel", {
                defaultValue:
                  "Per-conversation concurrency limit (0 = unlimited)",
              })}
            </span>
            <input
              type="number"
              min={SUB_AGENT_SESSION_MAX_CONCURRENCY_MIN}
              max={sessionUpperBound}
              step={1}
              value={sessionMaxConcurrency}
              onChange={(event) => setSessionMaxConcurrency(event.target.value)}
              onBlur={() => void saveMaxConcurrency("session")}
              title={t("settings.subAgentSessionConcurrencyHint", {
                defaultValue:
                  "Range 0-2000, default 0 (unlimited); otherwise never above the global limit.",
              })}
            />
          </label>
        </div>
      </div>

      <div
        className="segmented-tabs segmented-tabs--spaced"
        role="tablist"
        aria-label={t("settings.subAgentScopeTabs", {
          defaultValue: "Sub-agent scope",
        })}
      >
        <button
          className={`segmented-tab ${isGlobalScope ? "active" : ""}`}
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
          className={`segmented-tab ${!isGlobalScope ? "active" : ""}`}
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
            onDelete={(agent) => setPendingDeletion(agent)}
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
            isGlobalScope={isGlobalScope}
            isSaving={isSaving}
            isToolCatalogLoading={isToolCatalogLoading}
            isModelCatalogLoading={isModelCatalogLoading}
            modelCatalogError={modelCatalogError}
            modelOptions={modelOptions}
            toolCatalogError={toolCatalogError}
            toolOptions={toolOptions}
            onDraftChange={(patch) =>
              setDraft((previous) =>
                previous ? { ...previous, ...patch } : previous,
              )
            }
            onCancel={cancelDraft}
            onSave={() => void saveDraft()}
          />
        )}
      </Modal>

      <ConfirmDialog
        open={pendingDeletion !== null}
        title={t("settings.subAgentDeleteTitle", {
          defaultValue: "Delete sub-agent",
        })}
        message={t("settings.subAgentDeleteConfirm", {
          defaultValue:
            'Delete sub-agent "{{name}}"? This action cannot be undone.',
          values: { name: pendingDeletion?.name ?? "" },
        })}
        confirmLabel={t("settings.delete", { defaultValue: "Delete" })}
        cancelLabel={t("settings.cancel", { defaultValue: "Cancel" })}
        onConfirm={confirmDelete}
        onCancel={() => setPendingDeletion(null)}
        variant="danger"
      />
    </div>
  );
}
