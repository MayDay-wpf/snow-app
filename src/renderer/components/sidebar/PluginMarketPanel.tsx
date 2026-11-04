import {
  BadgeCheck,
  Download,
  FileCode2,
  Globe,
  KeyRound,
  Loader2,
  Puzzle,
  RefreshCw,
  Search,
  ShieldAlert,
  Store,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useI18n } from "../../i18n";
import { useCommunityStore } from "../../plugins/communityStore";
import { resolveLocalized } from "../../plugins/manifest";
import {
  buildMarketDownloadUrl,
  filterCommunityEntries,
  formatCompactCount,
  hasMarketUpdate,
  isMarketEntryTooNew,
  PLUGIN_MARKET_REPO_URL,
  type MarketCategory,
  type MarketPluginEntry,
  type MarketTab,
} from "../../plugins/market";
import {
  readMarketHideInstalled,
  writeMarketHideInstalled,
} from "../../plugins/marketPreferences";
import { marketStore, useMarketStore } from "../../plugins/marketStore";
import { pluginStore, usePluginStore } from "../../plugins/pluginStore";
import { isSensitiveScope, type PluginView } from "../../plugins/types";
import type { UserscriptRecord } from "../../../preload/types/userscripts";
import { Modal } from "../common/Modal";
import { PluginMarketIcon } from "../common/PluginMarketIcon";
import { Tooltip } from "../common/Tooltip";
import { PluginCommunityPanel } from "./PluginCommunityPanel";
import { PluginPrivacyBadges } from "./PluginPrivacyBadges";
import {
  PluginPrivacyDialog,
  type PluginPrivacyTarget,
} from "./PluginPrivacyDialog";

type PluginMarketPanelProps = {
  /** 打开时的默认分类（来自插件面板的导航意图）。 */
  initialCategory?: MarketTab;
  /** 分类切换回调，供宿主面板记住当前分类。 */
  onCategoryChange?: (category: MarketTab) => void;
};

export const PluginMarketPanel = ({
  initialCategory = "panel",
  onCategoryChange,
}: PluginMarketPanelProps): React.JSX.Element => {
  const { t, locale } = useI18n();
  const pluginState = usePluginStore();
  const market = useMarketStore();
  const community = useCommunityStore();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<MarketTab>(initialCategory);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [pendingEntry, setPendingEntry] = useState<MarketPluginEntry | null>(
    null,
  );
  const [privacyTarget, setPrivacyTarget] =
    useState<PluginPrivacyTarget | null>(null);
  const [userscripts, setUserscripts] = useState<UserscriptRecord[]>([]);
  const [hideInstalled, setHideInstalled] = useState(readMarketHideInstalled);

  const selectCategory = useCallback(
    (next: MarketCategory): void => {
      setCategory(next);
      onCategoryChange?.(next);
    },
    [onCategoryChange],
  );

  const refreshUserscripts = useCallback((): void => {
    void window.snow
      .listUserscripts()
      .then(setUserscripts)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    void marketStore.ensureLoaded();
    refreshUserscripts();
    return window.snow.onUserscriptsChanged(refreshUserscripts);
  }, [refreshUserscripts]);

  const installedById = useMemo(() => {
    const map = new Map<string, PluginView>();
    for (const plugin of pluginState.plugins) {
      map.set(plugin.pluginId, plugin);
    }
    return map;
  }, [pluginState.plugins]);

  const findInstalled = useCallback(
    (entry: MarketPluginEntry): { version: string } | null => {
      if (entry.kind === "script") {
        const script = userscripts.find((item) => item.scriptId === entry.id);
        return script ? { version: script.version } : null;
      }
      const plugin = installedById.get(entry.id);
      return plugin ? { version: plugin.version } : null;
    },
    [installedById, userscripts],
  );

  const categoryEntries = useMemo(
    () => market.entries.filter((entry) => entry.category === category),
    [market.entries, category],
  );

  // 已安装且无新版本的条目：开启过滤时隐藏（有更新的条目仍需可见）
  const installedStats = useMemo(() => {
    let installed = 0;
    const hideableIds = new Set<string>();
    for (const entry of categoryEntries) {
      const current = findInstalled(entry);
      if (!current) {
        continue;
      }
      installed += 1;
      if (!hasMarketUpdate(current.version, entry.version)) {
        hideableIds.add(entry.id);
      }
    }
    return { installed, hideableIds };
  }, [categoryEntries, findInstalled]);

  const filteredEntries = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    const base = hideInstalled
      ? categoryEntries.filter(
          (entry) => !installedStats.hideableIds.has(entry.id),
        )
      : categoryEntries;
    if (!keyword) {
      return base;
    }
    return base.filter((entry) => {
      const haystack = [
        entry.id,
        resolveLocalized(entry.name, locale),
        resolveLocalized(entry.description, locale),
        entry.author,
        ...entry.tags,
      ]
        .join("\n")
        .toLowerCase();
      return haystack.includes(keyword);
    });
  }, [categoryEntries, hideInstalled, installedStats, locale, query]);

  const toggleHideInstalled = useCallback((): void => {
    setHideInstalled((current) => {
      const next = !current;
      writeMarketHideInstalled(next);
      return next;
    });
  }, []);

  const categoryCounts = useMemo(() => {
    const counts: Record<MarketCategory, number> = {
      panel: 0,
      oauth: 0,
      script: 0,
    };
    for (const entry of market.entries) {
      counts[entry.category] += 1;
    }
    return counts;
  }, [market.entries]);

  // 与社区列表同口径：排除已收录官方索引的仓库
  const communityCount = useMemo(
    () =>
      community.searched
        ? filterCommunityEntries(
            community.entries,
            market.entries.map((entry) => entry.repo),
          ).length
        : undefined,
    [community.searched, community.entries, market.entries],
  );

  const categoryTabs: {
    id: MarketTab;
    icon: React.JSX.Element;
    label: string;
    hint: string;
    /** 标签上的计数；社区通道未检索时不显示。 */
    count?: number;
  }[] = [
    {
      id: "panel",
      icon: <Puzzle size={13} strokeWidth={1.8} />,
      label: t("plugins.tabPlugins", { defaultValue: "Panel plugins" }),
      hint: t("plugins.tabPluginsHint", {
        defaultValue:
          "Panel plugins open as tabs in the right panel: enter from the plus menu in the top bar (Plugins group) or the right panel tab bar. Some also add an input toolbar button, message footers or tool call cards.",
      }),
      count: categoryCounts.panel,
    },
    {
      id: "oauth",
      icon: <KeyRound size={13} strokeWidth={1.8} />,
      label: t("plugins.tabOAuth", { defaultValue: "OAuth plugins" }),
      hint: t("plugins.tabOAuthHint", {
        defaultValue:
          "Plugins that declare oauth.entry: they sign in to a third-party account and register it as an API profile. Enter from API settings > OAuth sign-in.",
      }),
      count: categoryCounts.oauth,
    },
    {
      id: "script",
      icon: <FileCode2 size={13} strokeWidth={1.8} />,
      label: t("plugins.tabScripts", { defaultValue: "Script plugins" }),
      hint: t("plugins.tabScriptsHint", {
        defaultValue:
          "Userscripts injected into web pages: chat input buttons, context menus and page-level helpers.",
      }),
      count: categoryCounts.script,
    },
    {
      id: "community",
      icon: <Users size={13} strokeWidth={1.8} />,
      label: t("plugins.market.tabCommunity", {
        defaultValue: "Community plugins",
      }),
      hint: t("plugins.market.tabCommunityHint", {
        defaultValue:
          "Third-party plugin repositories on GitHub that carry the snow-plugins topic: published by their authors, not submitted to the official plugin market and not reviewed.",
      }),
      count: communityCount,
    },
  ];

  const openPrivacy = useCallback(
    (entry: MarketPluginEntry): void => {
      setPrivacyTarget({
        name: resolveLocalized(entry.name, locale) || entry.id,
        source: "plugin",
        scopes: entry.privacy.filter(isSensitiveScope),
        note: "",
      });
    },
    [locale],
  );

  const confirmInstall = useCallback(async (): Promise<void> => {
    if (!pendingEntry) {
      return;
    }
    setBusyId(pendingEntry.id);
    setInstallError(null);
    try {
      await pluginStore.installFromMarket(pendingEntry);
      setPendingEntry(null);
    } catch (installFailure) {
      setInstallError(
        installFailure instanceof Error
          ? installFailure.message
          : String(installFailure),
      );
    } finally {
      setBusyId(null);
    }
  }, [pendingEntry]);

  const isBusy = busyId !== null;
  const pendingDownloadUrl = pendingEntry
    ? buildMarketDownloadUrl(pendingEntry)
    : null;

  return (
    <>
      <div className="import-settings-tabs plugin-list-tabs" role="tablist">
        {categoryTabs.map((tab) => (
          <Tooltip content={tab.hint} key={tab.id} placement="bottom">
            <button
              aria-selected={category === tab.id}
              className={`import-settings-tab ${
                category === tab.id ? "active" : ""
              }`}
              onClick={() => setCategory(tab.id)}
              role="tab"
              type="button"
            >
              {tab.icon}
              {tab.label}
              {tab.count === undefined ? null : <small>{tab.count}</small>}
            </button>
          </Tooltip>
        ))}
      </div>
      {category === "community" ? (
        <PluginCommunityPanel />
      ) : (
        <div className="plugins-tab-content">
          <div className="plugins-toolbar">
            <div className="plugin-market-search">
              <Search size={13} strokeWidth={1.8} />
              <input
                className="plugin-market-search-input"
                type="search"
                value={query}
                placeholder={t("plugins.market.searchPlaceholder", {
                  defaultValue: "Search plugins…",
                })}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <span className="plugin-market-summary">
              {t("plugins.market.summary", {
                values: {
                  total: categoryCounts[category],
                  installed: installedStats.installed,
                },
                defaultValue: "{{total}} plugins · {{installed}} installed",
              })}
            </span>
            <button
              aria-checked={hideInstalled}
              className={`plugins-toolbar-btn plugin-market-hide-installed${
                hideInstalled ? " active" : ""
              }`}
              role="switch"
              type="button"
              title={t("plugins.market.hideInstalledHint", {
                defaultValue:
                  "Hide installed plugins that are already up to date; plugins with updates stay visible.",
              })}
              onClick={toggleHideInstalled}
            >
              <span
                className={`plugins-toggle-track${hideInstalled ? " on" : ""}`}
              >
                <span className="plugins-toggle-thumb" />
              </span>
              <span>
                {t("plugins.market.hideInstalled", {
                  defaultValue: "Hide installed",
                })}
              </span>
            </button>
            <button
              className="plugins-toolbar-btn"
              type="button"
              disabled={market.status === "loading"}
              onClick={() => void marketStore.refresh()}
            >
              <RefreshCw size={14} strokeWidth={1.8} />
              <span>{t("plugins.refresh", { defaultValue: "Refresh" })}</span>
            </button>
          </div>

          <div className="plugin-market-source">
            <Store size={12} strokeWidth={1.8} />
            <span>
              {t("plugins.market.source", { defaultValue: "Source" })}:
            </span>
            <button
              className="plugin-market-source-link"
              type="button"
              onClick={() => window.open(PLUGIN_MARKET_REPO_URL, "_blank")}
            >
              {PLUGIN_MARKET_REPO_URL.replace("https://github.com/", "")}
            </button>
            {market.updatedAt ? (
              <span className="plugin-market-updated">
                {t("plugins.market.updatedAt", {
                  values: { time: market.updatedAt },
                  defaultValue: "Updated {{time}}",
                })}
              </span>
            ) : null}
          </div>

          {market.status === "error" && (
            <div className="plugins-empty">
              <ShieldAlert size={22} strokeWidth={1.6} />
              <span>
                {t("plugins.market.loadError", {
                  defaultValue: "Failed to load the plugin market",
                })}
              </span>
              {market.error ? (
                <span className="plugins-empty-hint">{market.error}</span>
              ) : null}
              <button
                className="plugins-toolbar-btn"
                type="button"
                onClick={() => void marketStore.refresh()}
              >
                <RefreshCw size={14} strokeWidth={1.8} />
                <span>
                  {t("plugins.market.retry", { defaultValue: "Retry" })}
                </span>
              </button>
            </div>
          )}

          {market.status === "loading" && market.entries.length === 0 && (
            <div className="plugins-empty">
              <Loader2 size={20} className="spin" />
              <span>{t("plugins.loading", { defaultValue: "Loading…" })}</span>
            </div>
          )}

          {market.status === "ready" && filteredEntries.length === 0 && (
            <div className="plugins-empty">
              <Store size={22} strokeWidth={1.6} />
              <span>
                {categoryCounts[category] === 0
                  ? t("plugins.market.empty", {
                      defaultValue: "No plugins in the market yet",
                    })
                  : hideInstalled && !query.trim()
                    ? t("plugins.market.allInstalled", {
                        defaultValue: "All plugins are already installed",
                      })
                    : t("plugins.market.noMatch", {
                        defaultValue: "No matching plugins",
                      })}
              </span>
            </div>
          )}

          <div className="plugins-list">
            {filteredEntries.map((entry) => {
              const installed = findInstalled(entry);
              const downloadUrl = buildMarketDownloadUrl(entry);
              const tooNew = isMarketEntryTooNew(entry, market.appVersion);
              const isUpdate =
                installed !== null &&
                hasMarketUpdate(installed.version, entry.version);
              const isCurrent = installed !== null && !isUpdate;
              const entryBusy = busyId === entry.id;
              const downloads = market.stats[entry.id];
              return (
                <div className="plugins-item plugin-market-item" key={entry.id}>
                  <div className="plugins-item-head">
                    <span className="plugins-item-icon">
                      <PluginMarketIcon icon={entry.icon} />
                    </span>
                    <div className="plugins-item-title">
                      <span className="plugins-item-name-row">
                        <span className="plugins-item-name">
                          {resolveLocalized(entry.name, locale) || entry.id}
                        </span>
                        {entry.verified ? (
                          <Tooltip
                            content={t("plugins.market.badgeVerifiedHint", {
                              defaultValue:
                                "Merged into the official plugin store snow-plugin-store after a manual review by the maintainers. Review the privacy declarations before installing.",
                            })}
                          >
                            <span className="plugin-market-badge verified">
                              <BadgeCheck size={11} strokeWidth={2} />
                              {t("plugins.market.badgeVerified", {
                                defaultValue: "Verified",
                              })}
                            </span>
                          </Tooltip>
                        ) : (
                          <Tooltip
                            content={t("plugins.market.badgeOfficialHint", {
                              defaultValue:
                                "Listed in the official plugin store snow-plugin-store: the index entry and its archive hash were validated. Listing is not a security endorsement — review the privacy declarations before installing.",
                            })}
                          >
                            <span className="plugin-market-badge official">
                              <Store size={11} strokeWidth={2} />
                              {t("plugins.market.badgeOfficial", {
                                defaultValue: "Official store",
                              })}
                            </span>
                          </Tooltip>
                        )}
                      </span>
                      <span className="plugins-item-meta">
                        v{entry.version}
                        {entry.author ? ` · ${entry.author}` : ""}
                        {entry.kind === "script"
                          ? ` · ${t("plugins.market.kindScript", {
                              defaultValue: "Script",
                            })}`
                          : ""}
                        {entry.tags.length > 0
                          ? ` · ${entry.tags.join(" / ")}`
                          : ""}
                      </span>
                    </div>
                    <div className="plugins-item-actions">
                      {isCurrent ? (
                        <span className="plugin-market-installed">
                          {t("plugins.market.installed", {
                            defaultValue: "Installed",
                          })}
                        </span>
                      ) : (
                        <button
                          className="plugins-toolbar-btn primary"
                          type="button"
                          disabled={entryBusy || tooNew || !downloadUrl}
                          title={
                            tooNew
                              ? t("plugins.market.requiresApp", {
                                  values: { version: entry.minAppVersion },
                                  defaultValue:
                                    "Requires app v{{version}} or newer",
                                })
                              : undefined
                          }
                          onClick={() => {
                            setInstallError(null);
                            setPendingEntry(entry);
                          }}
                        >
                          {entryBusy ? (
                            <Loader2 size={14} className="spin" />
                          ) : (
                            <Download size={13} strokeWidth={1.8} />
                          )}
                          <span>
                            {isUpdate
                              ? t("plugins.market.update", {
                                  defaultValue: "Update",
                                })
                              : t("plugins.market.install", {
                                  defaultValue: "Install",
                                })}
                          </span>
                        </button>
                      )}
                    </div>
                  </div>

                  {resolveLocalized(entry.description, locale) ? (
                    <div className="plugins-item-description">
                      {resolveLocalized(entry.description, locale)}
                    </div>
                  ) : null}

                  <PluginPrivacyBadges
                    scopes={entry.privacy.filter(isSensitiveScope)}
                    onOpen={() => openPrivacy(entry)}
                  />

                  <div className="plugin-market-item-foot">
                    {isUpdate ? (
                      <span className="plugin-market-update-hint">
                        {t("plugins.market.updateHint", {
                          values: {
                            from: installed?.version ?? "",
                            to: entry.version,
                          },
                          defaultValue: "Installed v{{from}} → v{{to}}",
                        })}
                      </span>
                    ) : null}
                    {tooNew ? (
                      <span className="plugin-market-requires">
                        {t("plugins.market.requiresApp", {
                          values: { version: entry.minAppVersion },
                          defaultValue: "Requires app v{{version}} or newer",
                        })}
                      </span>
                    ) : null}
                    {typeof downloads === "number" ? (
                      <span
                        className="plugin-market-downloads"
                        title={t("plugins.market.downloads", {
                          defaultValue: "Downloads",
                        })}
                      >
                        <Download size={11} strokeWidth={1.8} />
                        {formatCompactCount(downloads)}
                      </span>
                    ) : null}
                    <button
                      className="plugin-market-repo-link"
                      type="button"
                      onClick={() => window.open(entry.repo, "_blank")}
                    >
                      {entry.repo.replace("https://github.com/", "")}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          <Modal
            closeDisabled={isBusy}
            closeLabel={t("common.cancel", { defaultValue: "Cancel" })}
            closeOnEscape
            description={
              pendingEntry
                ? resolveLocalized(pendingEntry.name, locale) || pendingEntry.id
                : ""
            }
            open={pendingEntry !== null}
            size="medium"
            title={t("plugins.market.confirmTitle", {
              defaultValue: "Install plugin",
            })}
            footer={
              <>
                <button
                  className="confirm-dialog-btn cancel"
                  type="button"
                  disabled={isBusy}
                  onClick={() => setPendingEntry(null)}
                >
                  {t("common.cancel", { defaultValue: "Cancel" })}
                </button>
                <button
                  className="confirm-dialog-btn primary"
                  type="button"
                  disabled={isBusy || !pendingDownloadUrl}
                  onClick={() => void confirmInstall()}
                >
                  {isBusy ? <Loader2 size={14} className="spin" /> : null}
                  {isBusy
                    ? t("plugins.market.installing", {
                        defaultValue: "Installing…",
                      })
                    : pendingEntry && findInstalled(pendingEntry)
                      ? t("plugins.market.update", { defaultValue: "Update" })
                      : t("plugins.market.install", {
                          defaultValue: "Install",
                        })}
                </button>
              </>
            }
            onClose={() => {
              if (!isBusy) {
                setPendingEntry(null);
                setInstallError(null);
              }
            }}
          >
            {pendingEntry ? (
              <div className="plugin-market-confirm">
                <div className="plugin-market-confirm-meta">
                  <span>v{pendingEntry.version}</span>
                  {pendingEntry.author ? (
                    <span>{pendingEntry.author}</span>
                  ) : null}
                  {pendingEntry.verified ? (
                    <span className="plugin-market-badge verified">
                      <BadgeCheck size={11} strokeWidth={2} />
                      {t("plugins.market.badgeVerified", {
                        defaultValue: "Verified",
                      })}
                    </span>
                  ) : (
                    <span className="plugin-market-badge official">
                      <Store size={11} strokeWidth={2} />
                      {t("plugins.market.badgeOfficial", {
                        defaultValue: "Official store",
                      })}
                    </span>
                  )}
                </div>
                {resolveLocalized(pendingEntry.description, locale) ? (
                  <p>{resolveLocalized(pendingEntry.description, locale)}</p>
                ) : null}
                <div className="plugin-market-confirm-row">
                  <span>
                    {t("plugins.market.source", { defaultValue: "Source" })}
                  </span>
                  <button
                    className="plugin-market-repo-link"
                    type="button"
                    onClick={() => window.open(pendingEntry.repo, "_blank")}
                  >
                    {pendingEntry.repo.replace("https://github.com/", "")}
                  </button>
                </div>
                <div className="plugin-market-confirm-row">
                  <span>SHA256</span>
                  <code className="plugin-market-hash">
                    {pendingEntry.sha256.slice(0, 16)}…
                  </code>
                </div>
                <PluginPrivacyBadges
                  scopes={pendingEntry.privacy.filter(isSensitiveScope)}
                  onOpen={() => openPrivacy(pendingEntry)}
                />
                {pendingEntry.privacy.includes("network") ? null : (
                  <div className="plugin-market-network-warning">
                    <Globe size={13} strokeWidth={1.8} />
                    <span>
                      {t("plugins.market.networkUndeclared", {
                        defaultValue:
                          "This plugin does not declare network access. The app will not block its outbound connections; make sure the source is trusted before installing.",
                      })}
                    </span>
                  </div>
                )}
                {isMarketEntryTooNew(pendingEntry, market.appVersion) ? (
                  <div className="plugin-market-requires">
                    {t("plugins.market.requiresApp", {
                      values: { version: pendingEntry.minAppVersion },
                      defaultValue: "Requires app v{{version}} or newer",
                    })}
                  </div>
                ) : null}
                {installError ? (
                  <div className="plugins-error">{installError}</div>
                ) : null}
              </div>
            ) : null}
          </Modal>

          <PluginPrivacyDialog
            target={privacyTarget}
            onClose={() => setPrivacyTarget(null)}
          />
        </div>
      )}
    </>
  );
};
