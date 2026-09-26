import {
  Database,
  FileCode2,
  FolderOpen,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Trash2,
  Upload,
  Puzzle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useEscapeClose } from "../../hooks/useEscapeClose";
import { useI18n } from "../../i18n";
import { resolveLocalized } from "../../plugins/manifest";
import {
  METADATA_DOMAINS,
  describeMetadataDomains,
} from "../../plugins/metadata";
import type { PluginView, SensitiveScope } from "../../plugins/types";
import { pluginStore, usePluginStore } from "../../plugins/pluginStore";
import { describeWriteDomains } from "../../plugins/writes";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { PluginIcon } from "../common/PluginIcon";
import { useChatConversationContext } from "../mainContent/chatMessages";
import { PluginMetadataCatalog } from "./PluginMetadataCatalog";
import { PluginScriptsSection } from "./PluginScriptsSection";
import {
  clientScriptStore,
  useClientScriptStore,
} from "../../userscripts/clientScriptStore";

type PluginsPanelProps = {
  onClose: () => void;
};

export const PluginsPanel = ({
  onClose,
}: PluginsPanelProps): React.JSX.Element => {
  const { t, locale } = useI18n();
  const state = usePluginStore();
  const { buildFromContent } = useChatConversationContext();
  const [busyPluginId, setBusyPluginId] = useState<string | null>(null);
  const [isInstalling, setIsInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingUninstall, setPendingUninstall] = useState<PluginView | null>(
    null,
  );
  const [isUninstalling, setIsUninstalling] = useState(false);
  const [createRequest, setCreateRequest] = useState("");
  const [activeTab, setActiveTab] = useState<"list" | "metadata">("list");
  const [listTab, setListTab] = useState<"plugins" | "scripts">("plugins");
  const clientScripts = useClientScriptStore();
  const [metadataPluginId, setMetadataPluginId] = useState("");
  const metadataPlugin = useMemo(
    () =>
      state.plugins.find((item) => item.pluginId === metadataPluginId) ?? null,
    [state.plugins, metadataPluginId],
  );

  // 进入页面时拉取最新插件清单（侧栏徽标只关心数量，清单随页面加载）。
  useEffect(() => {
    void pluginStore.refresh();
    void clientScriptStore.ensureLoaded();
  }, []);

  const openMetadata = useCallback((plugin: PluginView) => {
    setMetadataPluginId(plugin.pluginId);
    setActiveTab("metadata");
  }, []);

  const clearMetadataPlugin = useCallback(() => {
    setMetadataPluginId("");
  }, []);

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

  const handleCreateKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== "Enter" || event.shiftKey) {
        return;
      }
      const nativeEvent = event.nativeEvent as unknown as {
        isComposing?: boolean;
        keyCode?: number;
      };
      if (nativeEvent.isComposing || nativeEvent.keyCode === 229) {
        return;
      }
      event.preventDefault();
      handleCreateWithAi();
    },
    [handleCreateWithAi],
  );

  const scopeLabel = (scope: SensitiveScope): string =>
    t(`plugins.scopes.${scope}`, { defaultValue: scope });

  const renderScopeTags = (plugin: PluginView): React.JSX.Element | null => {
    if (plugin.privacy.length === 0) {
      return null;
    }
    return (
      <div className="plugins-privacy-tags">
        <ShieldAlert size={12} strokeWidth={1.8} />
        {plugin.privacy.map((scope) => (
          <span className="plugins-privacy-tag" key={scope}>
            {scopeLabel(scope)}
          </span>
        ))}
      </div>
    );
  };

  return (
    <div className="feature-page">
      <div className="plugins-panel-body">
        <div
          aria-label={t("plugins.title", { defaultValue: "Plugins" })}
          className="plugins-tabs"
          role="tablist"
        >
          <button
            aria-selected={activeTab === "list"}
            className={`plugins-tab${activeTab === "list" ? " active" : ""}`}
            onClick={() => setActiveTab("list")}
            role="tab"
            type="button"
          >
            <Puzzle size={14} strokeWidth={1.8} />
            <span>{t("plugins.tabList", { defaultValue: "Plugin list" })}</span>
            <small>{state.plugins.length + clientScripts.scripts.length}</small>
          </button>
          <button
            aria-selected={activeTab === "metadata"}
            className={`plugins-tab${activeTab === "metadata" ? " active" : ""}`}
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
              <button
                aria-selected={listTab === "plugins"}
                className={`import-settings-tab ${
                  listTab === "plugins" ? "active" : ""
                }`}
                onClick={() => setListTab("plugins")}
                role="tab"
                type="button"
              >
                <Puzzle size={13} strokeWidth={1.8} />
                {t("plugins.tabPlugins", { defaultValue: "Panel plugins" })}
                <small>{state.plugins.length}</small>
              </button>
              <button
                aria-selected={listTab === "scripts"}
                className={`import-settings-tab ${
                  listTab === "scripts" ? "active" : ""
                }`}
                onClick={() => setListTab("scripts")}
                role="tab"
                type="button"
              >
                <FileCode2 size={13} strokeWidth={1.8} />
                {t("plugins.tabScripts", { defaultValue: "Script plugins" })}
                <small>{clientScripts.scripts.length}</small>
              </button>
            </div>

            <div className="plugins-tab-content">
              {listTab === "plugins" ? (
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
                  </div>

                  {error && <div className="plugins-error">{error}</div>}

                  {state.status === "loading" && state.plugins.length === 0 && (
                    <div className="plugins-empty">
                      {t("plugins.loading", { defaultValue: "Loading…" })}
                    </div>
                  )}

                  {state.status === "ready" && state.plugins.length === 0 && (
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
                      <div className="plugins-create">
                        <textarea
                          className="plugins-create-input"
                          value={createRequest}
                          placeholder={t("plugins.createPlaceholder", {
                            defaultValue:
                              "e.g. a panel that lists this project's recent git commits",
                          })}
                          onChange={(event) =>
                            setCreateRequest(event.target.value)
                          }
                          onKeyDown={handleCreateKeyDown}
                        />
                        <div className="plugins-create-actions">
                          <button
                            className="plugins-toolbar-btn primary"
                            type="button"
                            disabled={createRequest.trim().length === 0}
                            onClick={handleCreateWithAi}
                          >
                            <Sparkles size={14} strokeWidth={1.8} />
                            <span>
                              {t("plugins.createAction", {
                                defaultValue: "Build with AI",
                              })}
                            </span>
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="plugins-list">
                    {state.plugins.map((plugin) => {
                      const isBusy = busyPluginId === plugin.pluginId;
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
                              <button
                                className="plugins-toggle"
                                type="button"
                                role="switch"
                                aria-checked={plugin.enabled}
                                disabled={isBusy}
                                onClick={() => void handleToggleEnabled(plugin)}
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

                          {plugin.description.default ||
                          Object.keys(plugin.description).length > 0 ? (
                            <div className="plugins-item-description">
                              {resolveLocalized(plugin.description, locale)}
                            </div>
                          ) : null}

                          {renderScopeTags(plugin)}

                          <button
                            className="plugins-metadata-link"
                            type="button"
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
                <PluginScriptsSection onClose={onClose} />
              )}
            </div>
          </>
        ) : (
          <PluginMetadataCatalog
            onClearPlugin={clearMetadataPlugin}
            plugin={metadataPlugin}
          />
        )}
      </div>

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
