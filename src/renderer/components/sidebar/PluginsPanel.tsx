import {
  ChevronDown,
  CircleArrowUp,
  Database,
  Download,
  FileCode2,
  FolderCog,
  FolderOpen,
  KeyRound,
  Loader2,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Store,
  Trash2,
  Upload,
  Puzzle,
  Wrench,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

import type {
  PluginsProjectScope,
  PluginToolServerInfo,
} from "../../../preload/types/plugins";
import { useEscapeClose } from "../../hooks/useEscapeClose";
import { useI18n } from "../../i18n";
import { resolveLocalized } from "../../plugins/manifest";
import {
  hasMarketUpdate,
  isMarketEntryTooNew,
  type MarketPluginEntry,
  type MarketTab,
} from "../../plugins/market";
import {
  findMarketEntry,
  marketStore,
  useMarketStore,
} from "../../plugins/marketStore";
import {
  clearPluginsPanelNavigation,
  peekPluginsPanelNavigation,
} from "../../plugins/panelNavigation";
import {
  METADATA_DOMAINS,
  describeMetadataDomains,
} from "../../plugins/metadata";
import type { PluginView } from "../../plugins/types";
import { pluginStore, usePluginStore } from "../../plugins/pluginStore";
import { runtimeSnapshot } from "../../plugins/runtimeSnapshot";
import { describeWriteDomains } from "../../plugins/writes";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { PluginIcon } from "../common/PluginIcon";
import { Tooltip } from "../common/Tooltip";
import { useChatConversationContext } from "../mainContent/chatMessages";
import { PluginCreateBox } from "./PluginCreateBox";
import { PluginMarketPanel } from "./PluginMarketPanel";
import { PluginMetadataCatalog } from "./PluginMetadataCatalog";
import { PluginPrivacyBadges } from "./PluginPrivacyBadges";
import {
  PluginPrivacyDialog,
  type PluginPrivacyTarget,
} from "./PluginPrivacyDialog";
import { PluginScriptsSection } from "./PluginScriptsSection";
import {
  clientScriptStore,
  useClientScriptStore,
} from "../../userscripts/clientScriptStore";

type PluginsPanelProps = {
  onClose: () => void;
};

/** 当前激活项目 id 与名称：项目范围开关的作用域。 */
const subscribeActiveProject = (listener: () => void): (() => void) =>
  runtimeSnapshot.subscribe(() => listener());

const readActiveProjectId = (): string =>
  runtimeSnapshot.get().activeDirectory?.directoryId ?? "";

const readActiveProjectName = (): string =>
  runtimeSnapshot.get().activeDirectory?.name ?? "";

export const PluginsPanel = ({
  onClose,
}: PluginsPanelProps): React.JSX.Element => {
  const { t, locale } = useI18n();
  const state = usePluginStore();
  const market = useMarketStore();
  const projectId = useSyncExternalStore(
    subscribeActiveProject,
    readActiveProjectId,
    readActiveProjectId,
  );
  const projectName = useSyncExternalStore(
    subscribeActiveProject,
    readActiveProjectName,
    readActiveProjectName,
  );
  const { buildFromContent } = useChatConversationContext();
  const [busyPluginId, setBusyPluginId] = useState<string | null>(null);
  const [updateAllProgress, setUpdateAllProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [isInstalling, setIsInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingUninstall, setPendingUninstall] = useState<PluginView | null>(
    null,
  );
  const [isUninstalling, setIsUninstalling] = useState(false);
  const [createRequest, setCreateRequest] = useState("");
  const [createOpen, setCreateOpen] = useState<boolean | null>(null);
  // 工具插件徽标（已注册工具数）与项目范围开关的数据源。
  const [toolCounts, setToolCounts] = useState<Record<string, number>>({});
  const [scopeOpen, setScopeOpen] = useState(false);
  const [scopeOverrides, setScopeOverrides] = useState<Record<string, boolean>>(
    {},
  );
  const [scopeBusyPluginId, setScopeBusyPluginId] = useState<string | null>(
    null,
  );
  // 外部（如 OAuth 登录选择）请求直达市场页的某个分类，只在挂载时消费一次
  const [initialNavigation] = useState(peekPluginsPanelNavigation);
  const [activeTab, setActiveTab] = useState<"list" | "market" | "metadata">(
    initialNavigation?.tab ?? "list",
  );
  const [listTab, setListTab] = useState<
    "plugins" | "oauth" | "tools" | "scripts"
  >("plugins");
  const [marketCategory, setMarketCategory] = useState<MarketTab>(
    initialNavigation?.category ?? "panel",
  );
  const [privacyTarget, setPrivacyTarget] =
    useState<PluginPrivacyTarget | null>(null);
  const clientScripts = useClientScriptStore();
  const [metadataPluginId, setMetadataPluginId] = useState("");
  const metadataPlugin = useMemo(
    () =>
      state.plugins.find((item) => item.pluginId === metadataPluginId) ?? null,
    [state.plugins, metadataPluginId],
  );
  const isEmpty = state.status === "ready" && state.plugins.length === 0;
  const createBoxOpen = createOpen ?? isEmpty;

  // 导航意图已在初始化时读取，挂载后清空避免影响下次打开
  useEffect(() => {
    clearPluginsPanelNavigation();
  }, []);

  // OAuth 插件单独成组（清单声明 kind: oauth，或存在 oauth.entry）。
  const panelPlugins = useMemo(
    () => state.plugins.filter((plugin) => plugin.kind === "plugin"),
    [state.plugins],
  );
  const oauthPlugins = useMemo(
    () => state.plugins.filter((plugin) => plugin.kind === "oauth"),
    [state.plugins],
  );
  // 工具插件向模型注册可调用工具，安装后还须在输入框用 @ 激活。
  const toolPlugins = useMemo(
    () => state.plugins.filter((plugin) => plugin.kind === "tool"),
    [state.plugins],
  );
  const visiblePlugins =
    listTab === "oauth"
      ? oauthPlugins
      : listTab === "tools"
        ? toolPlugins
        : panelPlugins;
  const isGroupEmpty =
    state.status === "ready" && !isEmpty && visiblePlugins.length === 0;

  // 可批量更新的插件（市场有更高版本且满足最低应用版本要求）。
  const updatablePlugins = useMemo(() => {
    const targets: { plugin: PluginView; entry: MarketPluginEntry }[] = [];
    for (const plugin of state.plugins) {
      const entry = findMarketEntry(market.entries, plugin.pluginId, "plugin");
      if (!entry || !hasMarketUpdate(plugin.version, entry.version)) {
        continue;
      }
      if (isMarketEntryTooNew(entry, market.appVersion)) {
        continue;
      }
      targets.push({ plugin, entry });
    }
    return targets;
  }, [market.appVersion, market.entries, state.plugins]);

  // 可更新的脚本插件数量（用于 tab 更新标记）
  const updatableScriptCount = useMemo(
    () =>
      clientScripts.scripts.filter((script) => {
        const entry = findMarketEntry(
          market.entries,
          script.scriptId,
          "script",
        );
        return (
          entry !== null &&
          hasMarketUpdate(script.version, entry.version) &&
          !isMarketEntryTooNew(entry, market.appVersion)
        );
      }).length,
    [clientScripts.scripts, market.appVersion, market.entries],
  );
  const totalUpdateCount = updatablePlugins.length + updatableScriptCount;
  const oauthUpdateCount = updatablePlugins.filter(
    (target) => target.plugin.kind === "oauth",
  ).length;
  const toolUpdateCount = updatablePlugins.filter(
    (target) => target.plugin.kind === "tool",
  ).length;
  const panelUpdateCount =
    updatablePlugins.length - oauthUpdateCount - toolUpdateCount;

  const renderUpdateIcon = (count: number, size: number) =>
    count > 0 ? (
      <span
        className="sidebar-update-icon"
        title={t("plugins.updateAvailable", {
          values: { count },
          defaultValue: "{{count}} plugin updates available",
        })}
      >
        <CircleArrowUp size={size} strokeWidth={2} />
      </span>
    ) : null;

  // 进入页面时拉取最新插件清单（侧栏徽标只关心数量，清单随页面加载）。
  useEffect(() => {
    void pluginStore.refresh();
    void clientScriptStore.ensureLoaded();
    void marketStore.ensureLoaded();
  }, []);

  // 工具插件徽标：发现各工具插件已注册的工具数，未发现时不显示数量。
  useEffect(() => {
    if (!state.plugins.some((plugin) => plugin.kind === "tool")) {
      setToolCounts({});
      return;
    }

    let disposed = false;
    void window.snow
      .listPluginTools()
      .then((servers: PluginToolServerInfo[]) => {
        if (disposed) {
          return;
        }
        const counts: Record<string, number> = {};
        for (const server of servers) {
          counts[server.pluginId] =
            (counts[server.pluginId] ?? 0) + server.tools.length;
        }
        setToolCounts(counts);
      })
      .catch((loadError) => {
        console.error("Failed to load plugin tools:", loadError);
        if (!disposed) {
          setToolCounts({});
        }
      });

    return () => {
      disposed = true;
    };
  }, [state.plugins]);

  // 项目范围：读取当前项目的插件覆盖（缺省表示跟随全局启用）。
  useEffect(() => {
    if (!projectId) {
      setScopeOverrides({});
      return;
    }

    let disposed = false;
    void window.snow
      .getPluginsProjectScope(projectId)
      .then((json) => {
        if (disposed) {
          return;
        }
        const scope = JSON.parse(json) as PluginsProjectScope;
        setScopeOverrides(scope.pluginOverrides ?? {});
      })
      .catch((scopeError) => {
        if (disposed) {
          return;
        }
        setScopeOverrides({});
        console.error("Failed to load plugin project scope:", scopeError);
      });

    return () => {
      disposed = true;
    };
  }, [projectId]);

  const handleSwitchListTab = useCallback(
    (tab: "plugins" | "oauth" | "tools" | "scripts") => {
      setListTab(tab);
      if (tab !== "tools") {
        setScopeOpen(false);
      }
    },
    [],
  );

  const openMetadata = useCallback((plugin: PluginView) => {
    setMetadataPluginId(plugin.pluginId);
    setActiveTab("metadata");
  }, []);

  const clearMetadataPlugin = useCallback(() => {
    setMetadataPluginId("");
  }, []);

  const openPrivacy = useCallback(
    (plugin: PluginView) => {
      setPrivacyTarget({
        name: resolveLocalized(plugin.name, locale) || plugin.pluginId,
        source: "plugin",
        scopes: plugin.privacy,
        note: plugin.privacyNote,
      });
    },
    [locale],
  );

  const handleInstall = useCallback(async () => {
    setIsInstalling(true);
    setError(null);
    try {
      const installed = await pluginStore.installFromDialog(
        t("plugins.installDialogTitle", {
          defaultValue: "Select plugin directory",
        }),
      );
      if (installed) {
        setError(null);
      }
    } catch (installError) {
      setError(
        installError instanceof Error
          ? installError.message
          : String(installError),
      );
    } finally {
      setIsInstalling(false);
    }
  }, [t]);

  const handleToggleEnabled = useCallback(async (plugin: PluginView) => {
    setBusyPluginId(plugin.pluginId);
    setError(null);
    try {
      await pluginStore.setEnabled(plugin.pluginId, !plugin.enabled);
    } catch (toggleError) {
      setError(
        toggleError instanceof Error
          ? toggleError.message
          : String(toggleError),
      );
    } finally {
      setBusyPluginId(null);
    }
  }, []);

  /** 项目范围勾选：写入项目覆盖后同步本地状态（缺省 = 跟随全局启用）。 */
  const handleScopeToggle = useCallback(
    async (plugin: PluginView, enabled: boolean) => {
      if (!projectId) {
        return;
      }
      setScopeBusyPluginId(plugin.pluginId);
      setError(null);
      try {
        await window.snow.setPluginsProjectPluginEnabled({
          projectId,
          pluginId: plugin.pluginId,
          enabled,
        });
        setScopeOverrides((prev) => ({ ...prev, [plugin.pluginId]: enabled }));
      } catch (toggleError) {
        setError(
          toggleError instanceof Error
            ? toggleError.message
            : String(toggleError),
        );
      } finally {
        setScopeBusyPluginId(null);
      }
    },
    [projectId],
  );

  const handleRescan = useCallback(async (plugin: PluginView) => {
    setBusyPluginId(plugin.pluginId);
    setError(null);
    try {
      await pluginStore.rescan(plugin.pluginId);
    } catch (rescanError) {
      setError(
        rescanError instanceof Error
          ? rescanError.message
          : String(rescanError),
      );
    } finally {
      setBusyPluginId(null);
    }
  }, []);

  const handleUpdate = useCallback(
    async (entry: MarketPluginEntry): Promise<void> => {
      setBusyPluginId(entry.id);
      setError(null);
      try {
        await pluginStore.installFromMarket(entry);
      } catch (updateError) {
        setError(
          updateError instanceof Error
            ? updateError.message
            : String(updateError),
        );
      } finally {
        setBusyPluginId(null);
      }
    },
    [],
  );

  // 依次更新所有可更新插件，失败的条目计入汇总提示。
  const handleUpdateAll = useCallback(async () => {
    const targets = updatablePlugins;
    if (targets.length === 0 || updateAllProgress) {
      return;
    }
    setError(null);
    setUpdateAllProgress({ done: 0, total: targets.length });
    let failed = 0;
    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index];
      setBusyPluginId(target.plugin.pluginId);
      try {
        await pluginStore.installFromMarket(target.entry);
      } catch {
        failed += 1;
      }
      setUpdateAllProgress({ done: index + 1, total: targets.length });
    }
    setBusyPluginId(null);
    setUpdateAllProgress(null);
    if (failed > 0) {
      setError(
        t("plugins.updateAllFailed", {
          values: { count: failed },
          defaultValue: "{{count}} plugin(s) failed to update",
        }),
      );
    }
  }, [t, updatablePlugins, updateAllProgress]);

  const confirmUninstall = useCallback(async () => {
    if (!pendingUninstall) {
      return;
    }
    setIsUninstalling(true);
    setError(null);
    try {
      await pluginStore.uninstall(pendingUninstall.pluginId, true);
      setPendingUninstall(null);
    } catch (uninstallError) {
      setError(
        uninstallError instanceof Error
          ? uninstallError.message
          : String(uninstallError),
      );
    } finally {
      setIsUninstalling(false);
    }
  }, [pendingUninstall]);

  useEscapeClose(() => {
    if (privacyTarget) {
      setPrivacyTarget(null);
      return;
    }
    if (pendingUninstall) {
      setPendingUninstall(null);
      return;
    }
    onClose();
  });

  const handleOpenFolder = useCallback(
    async (plugin: PluginView) => {
      try {
        await window.snow.showItemInFolder(plugin.installPath);
      } catch {
        try {
          await window.snow.openStorageDirectory(plugin.installPath);
        } catch {
          setError(
            t("plugins.openFolderFailed", {
              defaultValue: "Failed to open the plugin folder",
            }),
          );
        }
      }
    },
    [t],
  );

  const handleCreateWithAi = useCallback(() => {
    const requirement = createRequest.trim();
    if (!requirement) {
      return;
    }
    // Close the modal first so the chat view is visible underneath, then start
    // a new conversation that auto-sends the requirement — the AI reads the
    // plugin docs, scaffolds the plugin folder and installs it.
    setCreateRequest("");
    onClose();
    buildFromContent(
      t("plugins.createPrompt", {
        defaultValue:
          "Help me build a Snow App plugin.\n\nWhat I want: {{request}}",
        values: { request: requirement },
      }),
    );
  }, [buildFromContent, createRequest, onClose, t]);

  return (
    <div className="feature-page">
      <div className="plugins-panel-body">
        <div
          aria-label={t("plugins.title", { defaultValue: "Plugins" })}
          className="segmented-tabs"
          role="tablist"
        >
          <button
            aria-selected={activeTab === "list"}
            className={`segmented-tab${activeTab === "list" ? " active" : ""}`}
            onClick={() => setActiveTab("list")}
            role="tab"
            type="button"
          >
            <Puzzle size={14} strokeWidth={1.8} />
            <span>{t("plugins.tabList", { defaultValue: "Plugin list" })}</span>
            {renderUpdateIcon(totalUpdateCount, 13)}
            <small>{state.plugins.length + clientScripts.scripts.length}</small>
          </button>
          <button
            aria-selected={activeTab === "market"}
            className={`segmented-tab${activeTab === "market" ? " active" : ""}`}
            onClick={() => setActiveTab("market")}
            role="tab"
            type="button"
          >
            <Store size={14} strokeWidth={1.8} />
            <span>
              {t("plugins.market.tab", { defaultValue: "Plugin market" })}
            </span>
          </button>
          <button
            aria-selected={activeTab === "metadata"}
            className={`segmented-tab${activeTab === "metadata" ? " active" : ""}`}
            onClick={() => setActiveTab("metadata")}
            role="tab"
            type="button"
          >
            <Database size={14} strokeWidth={1.8} />
            <span>
              {t("plugins.metadata.action", {
                defaultValue: "Metadata catalog",
              })}
            </span>
            <small>{METADATA_DOMAINS.length}</small>
          </button>
        </div>

        {activeTab === "list" ? (
          <>
            <div
              className="import-settings-tabs plugin-list-tabs"
              role="tablist"
            >
              <Tooltip
                content={t("plugins.tabPluginsHint", {
                  defaultValue:
                    "Panel plugins open as tabs in the right panel: enter from the plus menu in the top bar (Plugins group) or the right panel tab bar. Some also add an input toolbar button, message footers or tool call cards.",
                })}
                placement="bottom"
              >
                <button
                  aria-selected={listTab === "plugins"}
                  className={`import-settings-tab ${
                    listTab === "plugins" ? "active" : ""
                  }`}
                  onClick={() => handleSwitchListTab("plugins")}
                  role="tab"
                  type="button"
                >
                  <Puzzle size={13} strokeWidth={1.8} />
                  {t("plugins.tabPlugins", { defaultValue: "Panel plugins" })}
                  <small>{panelPlugins.length}</small>
                  {renderUpdateIcon(panelUpdateCount, 12)}
                </button>
              </Tooltip>
              <Tooltip
                content={t("plugins.tabOAuthHint", {
                  defaultValue:
                    "Plugins that declare oauth.entry: they sign in to a third-party account and register it as an API profile. Enter from API settings > OAuth sign-in.",
                })}
                placement="bottom"
              >
                <button
                  aria-selected={listTab === "oauth"}
                  className={`import-settings-tab ${
                    listTab === "oauth" ? "active" : ""
                  }`}
                  onClick={() => handleSwitchListTab("oauth")}
                  role="tab"
                  type="button"
                >
                  <KeyRound size={13} strokeWidth={1.8} />
                  {t("plugins.tabOAuth", { defaultValue: "OAuth plugins" })}
                  <small>{oauthPlugins.length}</small>
                  {renderUpdateIcon(oauthUpdateCount, 12)}
                </button>
              </Tooltip>
              <Tooltip
                content={t("plugins.tabToolsHint", {
                  defaultValue:
                    "Tool plugins register callable tools over MCP: after installing, select the plugin with @ in the chat input; its tools are available only in that conversation.",
                })}
                placement="bottom"
              >
                <button
                  aria-selected={listTab === "tools"}
                  className={`import-settings-tab ${
                    listTab === "tools" ? "active" : ""
                  }`}
                  onClick={() => handleSwitchListTab("tools")}
                  role="tab"
                  type="button"
                >
                  <Wrench size={13} strokeWidth={1.8} />
                  {t("plugins.tabTools", { defaultValue: "Tool plugins" })}
                  <small>{toolPlugins.length}</small>
                  {renderUpdateIcon(toolUpdateCount, 12)}
                </button>
              </Tooltip>
              <Tooltip
                content={t("plugins.tabScriptsHint", {
                  defaultValue:
                    "Userscripts injected into web pages: chat input buttons, context menus and page-level helpers.",
                })}
                placement="bottom"
              >
                <button
                  aria-selected={listTab === "scripts"}
                  className={`import-settings-tab ${
                    listTab === "scripts" ? "active" : ""
                  }`}
                  onClick={() => handleSwitchListTab("scripts")}
                  role="tab"
                  type="button"
                >
                  <FileCode2 size={13} strokeWidth={1.8} />
                  {t("plugins.tabScripts", { defaultValue: "Script plugins" })}
                  <small>{clientScripts.scripts.length}</small>
                  {renderUpdateIcon(updatableScriptCount, 12)}
                </button>
              </Tooltip>
            </div>

            <div className="plugins-tab-content">
              {listTab !== "scripts" ? (
                <>
                  <div className="plugins-toolbar">
                    <button
                      className="plugins-toolbar-btn primary"
                      type="button"
                      disabled={isInstalling}
                      onClick={() => void handleInstall()}
                    >
                      <Upload size={14} strokeWidth={1.8} />
                      <span>
                        {isInstalling
                          ? t("plugins.installing", {
                              defaultValue: "Installing…",
                            })
                          : t("plugins.install", {
                              defaultValue: "Install from folder",
                            })}
                      </span>
                    </button>
                    <button
                      className="plugins-toolbar-btn"
                      type="button"
                      onClick={() => void pluginStore.refresh()}
                    >
                      <RefreshCw size={14} strokeWidth={1.8} />
                      <span>
                        {t("plugins.refresh", { defaultValue: "Refresh" })}
                      </span>
                    </button>
                    {updatablePlugins.length > 0 && (
                      <button
                        className="plugins-toolbar-btn primary"
                        type="button"
                        disabled={updateAllProgress !== null}
                        title={t("plugins.updateAllHint", {
                          values: { count: updatablePlugins.length },
                          defaultValue:
                            "{{count}} plugin(s) have a newer version",
                        })}
                        onClick={() => void handleUpdateAll()}
                      >
                        {updateAllProgress ? (
                          <Loader2 size={14} className="spin" />
                        ) : (
                          <Download size={14} strokeWidth={1.8} />
                        )}
                        <span>
                          {updateAllProgress
                            ? t("plugins.updatingAll", {
                                values: {
                                  done: updateAllProgress.done,
                                  total: updateAllProgress.total,
                                },
                                defaultValue: "Updating {{done}}/{{total}}…",
                              })
                            : t("plugins.updateAll", {
                                values: { count: updatablePlugins.length },
                                defaultValue: "Update all ({{count}})",
                              })}
                        </span>
                      </button>
                    )}
                    <button
                      aria-expanded={createBoxOpen}
                      className={`plugins-toolbar-btn${
                        createBoxOpen ? " active" : ""
                      }`}
                      type="button"
                      onClick={() => setCreateOpen(!createBoxOpen)}
                    >
                      <Sparkles size={14} strokeWidth={1.8} />
                      <span>
                        {t("plugins.createButton", {
                          defaultValue: "Generate with AI",
                        })}
                      </span>
                      <ChevronDown
                        className="plugins-create-toggle-chevron"
                        size={14}
                        strokeWidth={2}
                      />
                    </button>
                    {listTab === "tools" && (
                      <button
                        aria-expanded={scopeOpen}
                        className={`plugins-toolbar-btn${
                          scopeOpen ? " active" : ""
                        }`}
                        type="button"
                        disabled={!projectId || toolPlugins.length === 0}
                        title={
                          !projectId
                            ? t("plugins.projectScope.noProject", {
                                defaultValue:
                                  "Open a project to configure plugin scope",
                              })
                            : toolPlugins.length === 0
                              ? t("plugins.projectScope.noToolPlugins", {
                                  defaultValue: "No tool plugins installed",
                                })
                              : t("plugins.projectScope.title", {
                                  defaultValue: "Project scope",
                                })
                        }
                        onClick={() => setScopeOpen(!scopeOpen)}
                      >
                        <FolderCog size={14} strokeWidth={1.8} />
                        <span>
                          {t("plugins.projectScope.title", {
                            defaultValue: "Project scope",
                          })}
                        </span>
                      </button>
                    )}
                  </div>

                  {!isEmpty && createBoxOpen && (
                    <PluginCreateBox
                      autoFocus
                      className="plugins-create-inline"
                      value={createRequest}
                      placeholder={t("plugins.createPlaceholder", {
                        defaultValue:
                          "e.g. a panel that lists this project's recent git commits",
                      })}
                      submitLabel={t("plugins.createAction", {
                        defaultValue: "Build with AI",
                      })}
                      onChange={setCreateRequest}
                      onSubmit={handleCreateWithAi}
                    />
                  )}

                  {listTab === "tools" && scopeOpen && projectId && (
                    <div className="plugins-scope">
                      <div className="plugins-scope-header">
                        <div className="plugins-scope-title">
                          <FolderCog size={13} strokeWidth={1.8} />
                          <span>
                            {t("plugins.projectScope.scopeHeader", {
                              values: { name: projectName || projectId },
                              defaultValue: "Current project: {{name}}",
                            })}
                          </span>
                        </div>
                        <div className="plugins-scope-hint">
                          {t("plugins.projectScope.hint", {
                            defaultValue:
                              "Unchecked plugins are unavailable in this project; checked ones follow the global switch.",
                          })}
                        </div>
                      </div>
                      {toolPlugins.length === 0 ? (
                        <div className="plugins-scope-empty">
                          {t("plugins.projectScope.noToolPlugins", {
                            defaultValue: "No tool plugins installed",
                          })}
                        </div>
                      ) : (
                        toolPlugins.map((plugin) => {
                          const effective =
                            scopeOverrides[plugin.pluginId] ?? plugin.enabled;
                          const isScopeBusy =
                            scopeBusyPluginId === plugin.pluginId;
                          return (
                            <label
                              className="plugins-scope-row"
                              key={plugin.pluginId}
                            >
                              <input
                                type="checkbox"
                                checked={effective && plugin.enabled}
                                disabled={isScopeBusy || !plugin.enabled}
                                title={
                                  plugin.enabled
                                    ? undefined
                                    : t("plugins.projectScope.globalOff", {
                                        defaultValue: "Disabled globally",
                                      })
                                }
                                onChange={(event) =>
                                  void handleScopeToggle(
                                    plugin,
                                    event.target.checked,
                                  )
                                }
                              />
                              <span className="plugins-scope-name">
                                {resolveLocalized(plugin.name, locale) ||
                                  plugin.pluginId}
                              </span>
                              {!plugin.enabled && (
                                <span className="plugins-scope-state-tag">
                                  {t("plugins.projectScope.globalOff", {
                                    defaultValue: "Disabled globally",
                                  })}
                                </span>
                              )}
                              {isScopeBusy && (
                                <Loader2 size={12} className="spin" />
                              )}
                            </label>
                          );
                        })
                      )}
                    </div>
                  )}

                  {error && <div className="plugins-error">{error}</div>}

                  {state.status === "loading" && state.plugins.length === 0 && (
                    <div className="plugins-empty">
                      {t("plugins.loading", { defaultValue: "Loading…" })}
                    </div>
                  )}

                  {isEmpty && (
                    <div className="plugins-empty">
                      <Puzzle size={22} strokeWidth={1.6} />
                      <span>
                        {t("plugins.empty", {
                          defaultValue: "No plugins installed yet",
                        })}
                      </span>
                      <span className="plugins-empty-hint">
                        {t("plugins.createHint", {
                          defaultValue:
                            "Describe the plugin you want (Enter to send, Shift+Enter for a new line) and AI will build and install it.",
                        })}
                      </span>
                      {createBoxOpen && (
                        <PluginCreateBox
                          value={createRequest}
                          placeholder={t("plugins.createPlaceholder", {
                            defaultValue:
                              "e.g. a panel that lists this project's recent git commits",
                          })}
                          submitLabel={t("plugins.createAction", {
                            defaultValue: "Build with AI",
                          })}
                          onChange={setCreateRequest}
                          onSubmit={handleCreateWithAi}
                        />
                      )}
                    </div>
                  )}

                  {isGroupEmpty && (
                    <div className="plugins-empty">
                      {listTab === "oauth" ? (
                        <KeyRound size={22} strokeWidth={1.6} />
                      ) : listTab === "tools" ? (
                        <Wrench size={22} strokeWidth={1.6} />
                      ) : (
                        <Puzzle size={22} strokeWidth={1.6} />
                      )}
                      <span>
                        {listTab === "oauth"
                          ? t("plugins.oauthEmpty", {
                              defaultValue: "No OAuth plugins installed yet",
                            })
                          : listTab === "tools"
                            ? t("plugins.toolEmpty", {
                                defaultValue: "No tool plugins installed yet",
                              })
                            : t("plugins.panelEmpty", {
                                defaultValue: "No panel plugins installed yet",
                              })}
                      </span>
                    </div>
                  )}

                  <div className="plugins-list">
                    {visiblePlugins.map((plugin) => {
                      const isBusy = busyPluginId === plugin.pluginId;
                      const marketEntry = findMarketEntry(
                        market.entries,
                        plugin.pluginId,
                        "plugin",
                      );
                      const updateAvailable =
                        marketEntry !== null &&
                        hasMarketUpdate(plugin.version, marketEntry.version);
                      const updateTooNew =
                        marketEntry !== null &&
                        isMarketEntryTooNew(marketEntry, market.appVersion);
                      const metadata = describeMetadataDomains(plugin);
                      const readableDomains = metadata.filter(
                        (domain) => domain.granted,
                      ).length;
                      const writeDomains = describeWriteDomains(plugin, locale);
                      const writableActions = writeDomains.reduce(
                        (total, domain) =>
                          total +
                          domain.actions.filter((action) => action.granted)
                            .length,
                        0,
                      );
                      const totalWriteActions = writeDomains.reduce(
                        (total, domain) => total + domain.actions.length,
                        0,
                      );
                      return (
                        <div className="plugins-item" key={plugin.pluginId}>
                          <div className="plugins-item-head">
                            <span className="plugins-item-icon">
                              <PluginIcon
                                pluginId={plugin.pluginId}
                                icon={plugin.icon}
                                size={18}
                              />
                            </span>
                            <div className="plugins-item-title">
                              <span className="plugins-item-name">
                                {resolveLocalized(plugin.name, locale) ||
                                  plugin.pluginId}
                              </span>
                              <span className="plugins-item-meta">
                                v{plugin.version}
                                {plugin.author ? ` · ${plugin.author}` : ""}
                                {` · ${plugin.renderMode}`}
                              </span>
                            </div>
                            <div className="plugins-item-actions">
                              {marketEntry !== null && updateAvailable ? (
                                <button
                                  className="plugins-toolbar-btn primary"
                                  type="button"
                                  disabled={isBusy || updateTooNew}
                                  title={
                                    updateTooNew
                                      ? t("plugins.market.requiresApp", {
                                          values: {
                                            version: marketEntry.minAppVersion,
                                          },
                                          defaultValue:
                                            "Requires app v{{version}} or newer",
                                        })
                                      : t("plugins.market.updateHint", {
                                          values: {
                                            from: plugin.version,
                                            to: marketEntry.version,
                                          },
                                          defaultValue:
                                            "Installed v{{from}} → v{{to}}",
                                        })
                                  }
                                  onClick={() => void handleUpdate(marketEntry)}
                                >
                                  {isBusy ? (
                                    <Loader2 size={13} className="spin" />
                                  ) : (
                                    <Download size={13} strokeWidth={1.8} />
                                  )}
                                  <span>
                                    {t("plugins.market.update", {
                                      defaultValue: "Update",
                                    })}
                                  </span>
                                </button>
                              ) : null}
                              {plugin.kind === "tool" ? (
                                <div className="plugins-tool-switches">
                                  <div
                                    className="plugins-switch-item"
                                    title={
                                      plugin.enabled
                                        ? t("plugins.disableGlobal", {
                                            defaultValue: "Disable globally",
                                          })
                                        : t("plugins.enableGlobal", {
                                            defaultValue: "Enable globally",
                                          })
                                    }
                                  >
                                    <span className="plugins-switch-tag">
                                      {t("plugins.scope.globalShort", {
                                        defaultValue: "Global",
                                      })}
                                    </span>
                                    <button
                                      className="plugins-toggle"
                                      type="button"
                                      role="switch"
                                      aria-checked={plugin.enabled}
                                      aria-label={t(
                                        "plugins.scope.globalToggleLabel",
                                        { defaultValue: "Global switch" },
                                      )}
                                      disabled={isBusy}
                                      onClick={() =>
                                        void handleToggleEnabled(plugin)
                                      }
                                    >
                                      <span
                                        className={`plugins-toggle-track${
                                          plugin.enabled ? " on" : ""
                                        }`}
                                      >
                                        <span className="plugins-toggle-thumb" />
                                      </span>
                                    </button>
                                  </div>
                                  <div
                                    className="plugins-switch-item"
                                    title={
                                      !projectId
                                        ? t("plugins.projectScope.noProject", {
                                            defaultValue:
                                              "Open a project to configure plugin scope",
                                          })
                                        : !plugin.enabled
                                          ? t(
                                              "plugins.scope.projectUnavailableTooltip",
                                              {
                                                defaultValue:
                                                  "Disabled globally; unavailable in project",
                                              },
                                            )
                                          : (scopeOverrides[plugin.pluginId] ??
                                              true)
                                            ? t(
                                                "plugins.scope.disableProject",
                                                {
                                                  defaultValue:
                                                    "Disable in this project",
                                                },
                                              )
                                            : t("plugins.scope.enableProject", {
                                                defaultValue:
                                                  "Enable in this project",
                                              })
                                    }
                                  >
                                    <span className="plugins-switch-tag">
                                      {t("plugins.scope.projectShort", {
                                        defaultValue: "Current project",
                                      })}
                                    </span>
                                    <button
                                      className="plugins-toggle"
                                      type="button"
                                      role="switch"
                                      aria-checked={
                                        Boolean(projectId) &&
                                        plugin.enabled &&
                                        (scopeOverrides[plugin.pluginId] ??
                                          true)
                                      }
                                      aria-label={t(
                                        "plugins.scope.projectToggleLabel",
                                        { defaultValue: "Project switch" },
                                      )}
                                      disabled={
                                        !projectId ||
                                        isBusy ||
                                        scopeBusyPluginId === plugin.pluginId ||
                                        !plugin.enabled
                                      }
                                      onClick={() =>
                                        void handleScopeToggle(
                                          plugin,
                                          !(
                                            scopeOverrides[plugin.pluginId] ??
                                            true
                                          ),
                                        )
                                      }
                                    >
                                      <span
                                        className={`plugins-toggle-track${
                                          projectId &&
                                          plugin.enabled &&
                                          (scopeOverrides[plugin.pluginId] ??
                                            true)
                                            ? " on"
                                            : ""
                                        }`}
                                      >
                                        <span className="plugins-toggle-thumb" />
                                      </span>
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <button
                                  className="plugins-toggle"
                                  type="button"
                                  role="switch"
                                  aria-checked={plugin.enabled}
                                  disabled={isBusy}
                                  onClick={() =>
                                    void handleToggleEnabled(plugin)
                                  }
                                  title={
                                    plugin.enabled
                                      ? t("plugins.disable", {
                                          defaultValue: "Disable",
                                        })
                                      : t("plugins.enable", {
                                          defaultValue: "Enable",
                                        })
                                  }
                                >
                                  <span
                                    className={`plugins-toggle-track${
                                      plugin.enabled ? " on" : ""
                                    }`}
                                  >
                                    <span className="plugins-toggle-thumb" />
                                  </span>
                                </button>
                              )}
                              <button
                                className="plugins-icon-btn"
                                type="button"
                                disabled={isBusy}
                                title={t("plugins.rescan", {
                                  defaultValue: "Reload manifest",
                                })}
                                onClick={() => void handleRescan(plugin)}
                              >
                                <RefreshCw size={13} strokeWidth={1.8} />
                              </button>
                              <button
                                className="plugins-icon-btn"
                                type="button"
                                title={t("plugins.openFolder", {
                                  defaultValue: "Show in folder",
                                })}
                                onClick={() => void handleOpenFolder(plugin)}
                              >
                                <FolderOpen size={13} strokeWidth={1.8} />
                              </button>
                              <button
                                className="plugins-icon-btn danger"
                                type="button"
                                disabled={isBusy}
                                title={t("plugins.uninstall", {
                                  defaultValue: "Uninstall",
                                })}
                                onClick={() => setPendingUninstall(plugin)}
                              >
                                <Trash2 size={13} strokeWidth={1.8} />
                              </button>
                            </div>
                          </div>

                          <div className="plugins-item-badges">
                            {plugin.kind === "tool" ? (
                              <>
                                <span className="plugins-item-badge">
                                  {t("plugins.kindTool", {
                                    defaultValue: "Tool plugin",
                                  })}
                                </span>
                                {toolCounts[plugin.pluginId] > 0 && (
                                  <span className="plugins-item-badge">
                                    {t("plugins.toolCount", {
                                      values: {
                                        count: toolCounts[plugin.pluginId],
                                      },
                                      defaultValue: "{{count}} tools",
                                    })}
                                  </span>
                                )}
                                <span
                                  className={`plugins-item-badge scope-badge ${
                                    plugin.enabled ? "global-on" : "global-off"
                                  }`}
                                >
                                  {plugin.enabled
                                    ? t("plugins.scope.globalEnabled", {
                                        defaultValue: "Globally enabled",
                                      })
                                    : t("plugins.scope.globalDisabled", {
                                        defaultValue: "Globally disabled",
                                      })}
                                </span>
                                {projectId ? (
                                  <span
                                    className={`plugins-item-badge scope-badge ${
                                      !plugin.enabled
                                        ? "project-off"
                                        : (scopeOverrides[plugin.pluginId] ??
                                            true)
                                          ? "project-on"
                                          : "project-off"
                                    }`}
                                    title={
                                      !plugin.enabled
                                        ? t(
                                            "plugins.scope.projectUnavailableTooltip",
                                            {
                                              defaultValue:
                                                "Disabled globally; unavailable in project",
                                            },
                                          )
                                        : undefined
                                    }
                                  >
                                    {!plugin.enabled
                                      ? t("plugins.scope.projectUnavailable", {
                                          defaultValue:
                                            "Unavailable in project",
                                        })
                                      : (scopeOverrides[plugin.pluginId] ??
                                          true)
                                        ? t("plugins.scope.projectEnabled", {
                                            defaultValue: "Enabled in project",
                                          })
                                        : t("plugins.scope.projectDisabled", {
                                            defaultValue: "Disabled in project",
                                          })}
                                  </span>
                                ) : (
                                  <span className="plugins-item-badge scope-badge project-none">
                                    {t("plugins.scope.noProject", {
                                      defaultValue: "No project",
                                    })}
                                  </span>
                                )}
                              </>
                            ) : (
                              <span className="plugins-item-badge scope-badge global">
                                {t("plugins.scope.globalOnly", {
                                  defaultValue: "Global plugin",
                                })}
                              </span>
                            )}
                          </div>

                          {plugin.description.default ||
                          Object.keys(plugin.description).length > 0 ? (
                            <div className="plugins-item-description">
                              {resolveLocalized(plugin.description, locale)}
                            </div>
                          ) : null}

                          <PluginPrivacyBadges
                            scopes={plugin.privacy}
                            onOpen={() => openPrivacy(plugin)}
                          />

                          <button
                            className="plugins-metadata-link"
                            type="button"
                            title={t("plugins.metadata.openHint", {
                              defaultValue:
                                "Open the metadata catalog to compare every domain",
                            })}
                            onClick={() => openMetadata(plugin)}
                          >
                            <Database size={12} strokeWidth={1.8} />
                            <span>
                              {t("plugins.metadata.pluginEntry", {
                                values: {
                                  granted: readableDomains,
                                  total: metadata.length,
                                },
                                defaultValue: "Metadata {{granted}}/{{total}}",
                              })}
                            </span>
                          </button>

                          <button
                            className="plugins-metadata-link"
                            type="button"
                            title={t("plugins.write.openHint", {
                              defaultValue:
                                "Open the metadata catalog to compare every write action",
                            })}
                            onClick={() => openMetadata(plugin)}
                          >
                            <ShieldAlert size={12} strokeWidth={1.8} />
                            <span>
                              {t("plugins.write.entry", {
                                values: {
                                  granted: writableActions,
                                  total: totalWriteActions,
                                },
                                defaultValue: "Write {{granted}}/{{total}}",
                              })}
                            </span>
                          </button>

                          {plugin.privacyNote && (
                            <div className="plugins-privacy-note">
                              {plugin.privacyNote}
                            </div>
                          )}

                          <div
                            className="plugins-item-path"
                            title={plugin.installPath}
                          >
                            {plugin.installPath}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              ) : (
                <PluginScriptsSection
                  onClose={onClose}
                  onOpenPrivacy={setPrivacyTarget}
                />
              )}
            </div>
          </>
        ) : activeTab === "market" ? (
          <PluginMarketPanel
            initialCategory={marketCategory}
            onCategoryChange={setMarketCategory}
          />
        ) : (
          <PluginMetadataCatalog
            onClearPlugin={clearMetadataPlugin}
            plugin={metadataPlugin}
          />
        )}
      </div>

      <PluginPrivacyDialog
        target={privacyTarget}
        onClose={() => setPrivacyTarget(null)}
      />

      <ConfirmDialog
        open={pendingUninstall !== null}
        title={t("plugins.uninstallTitle", {
          defaultValue: "Uninstall plugin",
        })}
        message={t("plugins.uninstallMessage", {
          values: {
            name: pendingUninstall
              ? resolveLocalized(pendingUninstall.name, locale) ||
                pendingUninstall.pluginId
              : "",
          },
          defaultValue:
            "Remove “{{name}}” and delete its plugin folder? This cannot be undone.",
        })}
        confirmLabel={t("plugins.uninstall", { defaultValue: "Uninstall" })}
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        variant="danger"
        isConfirming={isUninstalling}
        onConfirm={() => void confirmUninstall()}
        onCancel={() => setPendingUninstall(null)}
      />
    </div>
  );
};
