import {
  Archive,
  Download,
  Loader2,
  RefreshCw,
  Search,
  ShieldAlert,
  Star,
  Store,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useI18n } from "../../i18n";
import {
  communityStore,
  useCommunityStore,
} from "../../plugins/communityStore";
import {
  COMMUNITY_PLUGIN_TOPIC,
  COMMUNITY_PLUGIN_TOPICS_URL,
  formatCommunityTime,
  formatCompactCount,
  isCommunityRepoSource,
  type CommunityPluginEntry,
  type CommunityScriptItem,
} from "../../plugins/market";
import { marketStore, useMarketStore } from "../../plugins/marketStore";
import { pluginStore, usePluginStore } from "../../plugins/pluginStore";
import type { UserscriptRecord } from "../../../preload/types/userscripts";
import { Modal } from "../common/Modal";
import { PluginMarketIcon } from "../common/PluginMarketIcon";
import { Tooltip } from "../common/Tooltip";

/**
 * 插件市场的「社区插件」标签页。
 *
 * 检索 GitHub 上打了 `snow-plugins` 主题的第三方插件仓库，作为官方市场的
 * 开放补充通道：这里没有人工收录、没有索引锁定的 SHA-256，因此条目统一标注
 * 「社区插件 · 未发布到市场」，安装前必须经用户二次确认；已在官方市场收录的
 * 仓库额外标注，引导用户回到官方标签页安装（带哈希校验）。
 */
export const PluginCommunityPanel = (): React.JSX.Element => {
  const { t } = useI18n();
  const community = useCommunityStore();
  const market = useMarketStore();
  const pluginState = usePluginStore();
  const [draft, setDraft] = useState("");
  const [pendingEntry, setPendingEntry] = useState<CommunityPluginEntry | null>(
    null,
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  /** 多脚本仓库的勾选阶段：Rust 侧已下载并解压，等待用户选择要安装的脚本。 */
  const [scriptSelection, setScriptSelection] = useState<{
    token: string;
    items: CommunityScriptItem[];
  } | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  /** 已安装的用户脚本（勾选列表标出「将覆盖」，列表按来源仓库标出「已安装」）。 */
  const [userscripts, setUserscripts] = useState<UserscriptRecord[]>([]);

  const refreshUserscripts = useCallback((): void => {
    void window.snow
      .listUserscripts()
      .then(setUserscripts)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    void communityStore.ensureLoaded();
    // 官方索引仅用于标记「官方市场已有」；拉取失败不影响社区列表。
    void marketStore.ensureLoaded().catch(() => undefined);
    refreshUserscripts();
    return window.snow.onUserscriptsChanged(refreshUserscripts);
  }, [refreshUserscripts]);

  const installedScriptIds = useMemo(
    () => new Set(userscripts.map((script) => script.scriptId)),
    [userscripts],
  );

  /** 官方市场已收录的仓库地址（小写比对）。 */
  const officialRepos = useMemo(
    () => new Set(market.entries.map((entry) => entry.repo.toLowerCase())),
    [market.entries],
  );

  /** 已安装：来源仓库命中的面板插件，或来源仓库命中的用户脚本（脚本集合仓库）。 */
  const isInstalled = useCallback(
    (entry: CommunityPluginEntry): boolean =>
      pluginState.plugins.some((plugin) =>
        isCommunityRepoSource(entry.repo, plugin.sourcePath),
      ) ||
      userscripts.some(
        (script) =>
          script.sourceRepo !== "" &&
          isCommunityRepoSource(entry.repo, script.sourceRepo),
      ),
    [pluginState.plugins, userscripts],
  );

  const installedCount = useMemo(
    () => community.entries.filter(isInstalled).length,
    [community.entries, isInstalled],
  );

  const submitSearch = useCallback((): void => {
    void communityStore.search(draft.trim());
  }, [draft]);

  const toggleSelection = useCallback((path: string): void => {
    setSelectedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const closeDialog = useCallback((): void => {
    setPendingEntry(null);
    setScriptSelection(null);
    setSelectedPaths(new Set());
    setInstallError(null);
  }, []);

  const confirmInstall = useCallback(async (): Promise<void> => {
    if (!pendingEntry) {
      return;
    }
    setBusyId(pendingEntry.id);
    setInstallError(null);
    try {
      const result = await pluginStore.resolveFromCommunity(
        pendingEntry.repo,
        pendingEntry.defaultBranch,
        scriptSelection
          ? { token: scriptSelection.token, selection: [...selectedPaths] }
          : undefined,
      );
      if (result.outcome === "selection-required") {
        setScriptSelection({ token: result.token, items: result.items });
        setSelectedPaths(new Set(result.items.map((item) => item.path)));
        return;
      }
      closeDialog();
    } catch (failure) {
      setInstallError(
        failure instanceof Error ? failure.message : String(failure),
      );
    } finally {
      setBusyId(null);
    }
  }, [closeDialog, pendingEntry, scriptSelection, selectedPaths]);

  const isBusy = busyId !== null;
  const loading = community.status === "loading";
  const pendingInOfficialMarket =
    pendingEntry !== null && officialRepos.has(pendingEntry.repo.toLowerCase());

  return (
    <div className="plugins-tab-content">
      <div className="plugins-toolbar">
        <form
          className="plugin-market-search"
          onSubmit={(event) => {
            event.preventDefault();
            submitSearch();
          }}
        >
          <Search size={13} strokeWidth={1.8} />
          <input
            className="plugin-market-search-input"
            type="search"
            value={draft}
            placeholder={t("plugins.market.communitySearchPlaceholder", {
              defaultValue: "Search community repos…",
            })}
            onChange={(event) => setDraft(event.target.value)}
          />
        </form>
        <button
          className="plugins-toolbar-btn"
          type="button"
          disabled={loading}
          onClick={submitSearch}
        >
          <Search size={14} strokeWidth={1.8} />
          <span>
            {t("plugins.market.communitySearch", { defaultValue: "Search" })}
          </span>
        </button>
        <button
          className="plugins-toolbar-btn"
          type="button"
          disabled={loading}
          onClick={() => void communityStore.search(draft.trim(), true)}
        >
          <RefreshCw size={14} strokeWidth={1.8} />
          <span>{t("plugins.refresh", { defaultValue: "Refresh" })}</span>
        </button>
        {community.searched ? (
          <span className="plugin-market-summary">
            {t("plugins.market.communitySummary", {
              values: { total: community.total, installed: installedCount },
              defaultValue:
                "{{total}} community repos · {{installed}} installed",
            })}
          </span>
        ) : null}
      </div>

      <div className="plugin-market-source">
        <Users size={12} strokeWidth={1.8} />
        <span>{t("plugins.market.source", { defaultValue: "Source" })}:</span>
        <button
          className="plugin-market-source-link"
          type="button"
          onClick={() => window.open(COMMUNITY_PLUGIN_TOPICS_URL, "_blank")}
        >
          github.com/topics/{COMMUNITY_PLUGIN_TOPIC}
        </button>
        {community.updatedAt > 0 ? (
          <span className="plugin-market-updated">
            {t("plugins.market.updatedAt", {
              values: { time: formatCommunityTime(community.updatedAt) },
              defaultValue: "Updated {{time}}",
            })}
          </span>
        ) : null}
      </div>

      <div className="plugin-market-notice">
        <ShieldAlert size={13} strokeWidth={1.8} />
        <span>
          {t("plugins.market.communityNotice", {
            values: { topic: COMMUNITY_PLUGIN_TOPIC },
            defaultValue:
              "Community plugins are published by third-party authors on GitHub (their repository carries the snow-plugins topic). They are not submitted to the official plugin market and are not reviewed — read the source and the privacy declarations before installing.",
          })}
        </span>
      </div>

      {community.limited ? (
        <div className="plugin-market-requires">
          {t("plugins.market.communityLimited", {
            values: { reason: community.limitedReason },
            defaultValue:
              "GitHub is rate limiting or unreachable; showing the cached result: {{reason}}",
          })}
        </div>
      ) : null}

      {community.status === "error" ? (
        <div className="plugins-empty">
          <ShieldAlert size={22} strokeWidth={1.6} />
          <span>
            {t("plugins.market.communityLoadError", {
              defaultValue: "Failed to search community plugins",
            })}
          </span>
          {community.error ? (
            <span className="plugins-empty-hint">{community.error}</span>
          ) : null}
          <button
            className="plugins-toolbar-btn"
            type="button"
            onClick={() => void communityStore.search(draft.trim(), true)}
          >
            <RefreshCw size={14} strokeWidth={1.8} />
            <span>{t("plugins.market.retry", { defaultValue: "Retry" })}</span>
          </button>
        </div>
      ) : null}

      {loading && community.entries.length === 0 ? (
        <div className="plugins-empty">
          <Loader2 size={20} className="spin" />
          <span>{t("plugins.loading", { defaultValue: "Loading…" })}</span>
        </div>
      ) : null}

      {community.status === "ready" && community.entries.length === 0 ? (
        <div className="plugins-empty">
          <Users size={22} strokeWidth={1.6} />
          <span>
            {t("plugins.market.communityEmpty", {
              defaultValue: "No community plugins found",
            })}
          </span>
          <span className="plugins-empty-hint">
            {t("plugins.market.communityEmptyHint", {
              values: { topic: COMMUNITY_PLUGIN_TOPIC },
              defaultValue:
                "Add the snow-plugins topic to a GitHub repository to list it here.",
            })}
          </span>
        </div>
      ) : null}

      <div className="plugins-list">
        {community.entries.map((entry) => {
          const installed = isInstalled(entry);
          const inOfficialMarket = officialRepos.has(entry.repo.toLowerCase());
          const entryBusy = busyId === entry.id;
          const pushedAt = formatCommunityTime(entry.pushedAt);
          return (
            <div className="plugins-item plugin-market-item" key={entry.id}>
              <div className="plugins-item-head">
                <span className="plugins-item-icon">
                  <PluginMarketIcon icon={entry.icon} />
                </span>
                <div className="plugins-item-title">
                  <span className="plugins-item-name-row">
                    <span className="plugins-item-name">{entry.id}</span>
                    <Tooltip
                      content={t("plugins.market.communityBadgeHint", {
                        defaultValue:
                          "Community plugin: published by a third-party author, not published to the official plugin market and not reviewed.",
                      })}
                    >
                      <span className="plugin-market-badge community">
                        <Users size={11} strokeWidth={2} />
                        {t("plugins.market.communityBadge", {
                          defaultValue: "Community",
                        })}
                      </span>
                    </Tooltip>
                    {inOfficialMarket ? (
                      <Tooltip
                        content={t("plugins.market.communityInMarketHint", {
                          defaultValue:
                            "This repository is also listed in the official plugin market; installing from there verifies the archive SHA-256.",
                        })}
                      >
                        <span className="plugin-market-badge official">
                          <Store size={11} strokeWidth={2} />
                          {t("plugins.market.communityInMarket", {
                            defaultValue: "In official market",
                          })}
                        </span>
                      </Tooltip>
                    ) : null}
                  </span>
                  <span className="plugins-item-meta">
                    <span className="plugin-market-downloads">
                      <Star size={11} strokeWidth={1.8} />
                      {formatCompactCount(entry.stars)}
                    </span>
                    {entry.license ? ` · ${entry.license}` : ""}
                    {entry.archived
                      ? ` · ${t("plugins.market.communityArchived", {
                          defaultValue: "Archived",
                        })}`
                      : ""}
                  </span>
                </div>
                <div className="plugins-item-actions">
                  {installed ? (
                    <span className="plugin-market-installed">
                      {t("plugins.market.installed", {
                        defaultValue: "Installed",
                      })}
                    </span>
                  ) : (
                    <button
                      className="plugins-toolbar-btn primary"
                      type="button"
                      disabled={entryBusy || entry.archived}
                      title={
                        entry.archived
                          ? t("plugins.market.communityArchivedHint", {
                              defaultValue:
                                "This repository is archived and cannot be installed",
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
                        {t("plugins.market.install", {
                          defaultValue: "Install",
                        })}
                      </span>
                    </button>
                  )}
                </div>
              </div>

              {entry.description ? (
                <div className="plugins-item-description">
                  {entry.description}
                </div>
              ) : null}

              <div className="plugin-market-item-foot">
                {entry.archived ? (
                  <span className="plugin-market-requires">
                    <Archive size={11} strokeWidth={1.8} />
                    {t("plugins.market.communityArchived", {
                      defaultValue: "Archived",
                    })}
                  </span>
                ) : null}
                {pushedAt ? (
                  <span className="plugin-market-update-hint">
                    {t("plugins.market.communityPushedAt", {
                      values: { time: pushedAt },
                      defaultValue: "Last push {{time}}",
                    })}
                  </span>
                ) : null}
                <button
                  className="plugin-market-repo-link"
                  type="button"
                  onClick={() => window.open(entry.repo, "_blank")}
                >
                  {entry.id}
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
        description={pendingEntry ? pendingEntry.id : ""}
        open={pendingEntry !== null}
        size="medium"
        title={
          scriptSelection
            ? t("plugins.market.communitySelectTitle", {
                defaultValue: "Choose scripts to install",
              })
            : t("plugins.market.communityConfirmTitle", {
                defaultValue: "Install community plugin",
              })
        }
        footer={
          <>
            <button
              className="confirm-dialog-btn cancel"
              type="button"
              disabled={isBusy}
              onClick={closeDialog}
            >
              {t("common.cancel", { defaultValue: "Cancel" })}
            </button>
            <button
              className="confirm-dialog-btn primary"
              type="button"
              disabled={
                isBusy ||
                pendingEntry === null ||
                (scriptSelection !== null && selectedPaths.size === 0)
              }
              onClick={() => void confirmInstall()}
            >
              {isBusy ? <Loader2 size={14} className="spin" /> : null}
              {isBusy
                ? t("plugins.market.installing", {
                    defaultValue: "Installing…",
                  })
                : scriptSelection
                  ? t("plugins.market.communityInstallSelected", {
                      values: { count: selectedPaths.size },
                      defaultValue: "Install selected ({{count}})",
                    })
                  : t("plugins.market.install", { defaultValue: "Install" })}
            </button>
          </>
        }
        onClose={() => {
          if (!isBusy) {
            closeDialog();
          }
        }}
      >
        {scriptSelection ? (
          <div className="plugin-market-confirm">
            <p>
              {t("plugins.market.communitySelectHint", {
                values: { count: scriptSelection.items.length },
                defaultValue:
                  "This repository has no plugin.json but ships {{count}} userscripts from its latest commit. Pick the ones to install:",
              })}
            </p>
            <div className="plugin-market-scripts">
              {scriptSelection.items.map((item) => (
                <label className="plugin-market-script" key={item.path}>
                  <input
                    type="checkbox"
                    checked={selectedPaths.has(item.path)}
                    onChange={() => toggleSelection(item.path)}
                  />
                  <span className="plugin-market-script-body">
                    <span className="plugin-market-script-name">
                      {item.name || item.id}
                      {item.version ? <small>v{item.version}</small> : null}
                      {installedScriptIds.has(item.id) ? (
                        <span className="plugin-market-badge official">
                          {t("plugins.market.communityScriptInstalled", {
                            defaultValue: "Installed · will be replaced",
                          })}
                        </span>
                      ) : null}
                    </span>
                    <span className="plugin-market-script-path">
                      {item.path}
                    </span>
                    {item.description ? (
                      <span className="plugin-market-script-desc">
                        {item.description}
                      </span>
                    ) : null}
                  </span>
                </label>
              ))}
            </div>
            {installError ? (
              <div className="plugins-error">{installError}</div>
            ) : null}
          </div>
        ) : pendingEntry ? (
          <div className="plugin-market-confirm">
            {pendingEntry.description ? (
              <p>{pendingEntry.description}</p>
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
                {pendingEntry.id}
              </button>
            </div>
            {pendingInOfficialMarket ? (
              <div className="plugin-market-hint">
                <Store size={12} strokeWidth={1.8} />
                <span>
                  {t("plugins.market.communityInMarketHint", {
                    defaultValue:
                      "This repository is also listed in the official plugin market; installing from there verifies the archive SHA-256.",
                  })}
                </span>
              </div>
            ) : null}
            <div className="plugin-market-network-warning">
              <ShieldAlert size={13} strokeWidth={1.8} />
              <span>
                {t("plugins.market.communityInstallWarning", {
                  defaultValue:
                    "Community plugins are not reviewed: the app installs the latest commit of the repository default branch as-is, with no SHA-256 verification. Continue only if you trust this source.",
                })}
              </span>
            </div>
            {installError ? (
              <div className="plugins-error">{installError}</div>
            ) : null}
          </div>
        ) : null}
      </Modal>
    </div>
  );
};
