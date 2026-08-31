import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Cookie,
  Download,
  Eye,
  EyeOff,
  Globe,
  KeyRound,
  Loader2,
  ScanSearch,
  Search,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { useI18n } from "../../../i18n";
import { TampermonkeyIcon } from "../../icons/tampermonkeyIcon";
import { AutoDismissNotice } from "../../AutoDismissNotice";
import { ConfirmDialog } from "../../common/ConfirmDialog";
import { useBrowserHomepage } from "../../rightPanel/browser/useBrowserHomepage";
import {
  BROWSER_LOGO_COMPONENTS,
  type BrowserLogoId,
} from "../../icons/browserLogos";
import { UserscriptsSection } from "./UserscriptsSection";

type BrowserSettingsPanelProps = {
  onClose?: () => void;
};

type PasswordRecord = {
  id: string;
  origin: string;
  username: string;
  createdAt: number;
  updatedAt: number;
};

type ImportSource = {
  id: string;
  name: string;
  profile: string;
  accountName: string;
  passwordDb: string;
  cookieDb: string;
  passwordCount: number;
  cookieCount: number;
  note: string;
};

const BROWSER_LOGOS = BROWSER_LOGO_COMPONENTS;

const displayHost = (origin: string): string => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

export function BrowserSettingsPanel({
  onClose,
}: BrowserSettingsPanelProps): React.JSX.Element {
  const { t } = useI18n();
  const { homepage, setHomepage } = useBrowserHomepage();

  // ---- 顶部 Tab：浏览器设置 / 用户脚本 ----
  const [activeTab, setActiveTab] = useState<"settings" | "userscripts">(
    "settings",
  );

  // ---- 起始页 ----
  const [homepageDraft, setHomepageDraft] = useState(homepage);
  useEffect(() => {
    setHomepageDraft(homepage);
  }, [homepage]);

  const handleSaveHomepage = useCallback(async (): Promise<void> => {
    const value = homepageDraft.trim();
    try {
      await setHomepage(value);
    } catch {
      // 保存失败时静默，输入框仍可继续编辑
    }
  }, [homepageDraft, setHomepage]);

  // ---- 密码管理 ----
  const [records, setRecords] = useState<PasswordRecord[]>([]);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [visibleId, setVisibleId] = useState<string | null>(null);
  const [plaintext, setPlaintext] = useState<Record<string, string>>({});
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [batchDeleteConfirm, setBatchDeleteConfirm] = useState(false);
  const [deletingBatch, setDeletingBatch] = useState(false);

  const loadRecords = useCallback(async (): Promise<void> => {
    setRecordsLoading(true);
    try {
      setRecords(await window.snow.browserPasswordsList());
    } catch {
      // 列表加载失败时保留旧数据
    } finally {
      setRecordsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRecords();
  }, [loadRecords]);

  const handleToggleVisible = async (id: string): Promise<void> => {
    if (visibleId === id) {
      setVisibleId(null);
      return;
    }
    setVisibleId(id);
    if (plaintext[id] === undefined) {
      try {
        const record = await window.snow.browserPasswordGet(id);
        setPlaintext((prev) => ({
          ...prev,
          [id]: record?.password ?? "",
        }));
      } catch {
        setPlaintext((prev) => ({ ...prev, [id]: "" }));
      }
    }
  };

  const handleDeleteRecord = async (id: string): Promise<void> => {
    setDeletingId(id);
    try {
      await window.snow.browserPasswordDelete(id);
      setRecords((prev) => prev.filter((item) => item.id !== id));
      setSelectedIds((prev) => {
        if (!prev.has(id)) {
          return prev;
        }
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    } catch {
      // 删除失败静默
    } finally {
      setDeletingId(null);
    }
  };

  const toggleSelectRecord = (id: string): void => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleSelectAll = (): void => {
    setSelectedIds((prev) => {
      const allSelected =
        filteredRecords.length > 0 &&
        filteredRecords.every((record) => prev.has(record.id));
      return allSelected
        ? new Set()
        : new Set(filteredRecords.map((r) => r.id));
    });
  };

  const handleBatchDelete = async (): Promise<void> => {
    const ids = [...selectedIds];
    if (ids.length === 0) {
      setBatchDeleteConfirm(false);
      return;
    }
    setDeletingBatch(true);
    try {
      await window.snow.browserPasswordDeleteBatch(ids);
      const idSet = new Set(ids);
      setRecords((prev) => prev.filter((item) => !idSet.has(item.id)));
      setSelectedIds(new Set());
      setPlaintext((prev) => {
        const next = { ...prev };
        for (const id of ids) {
          delete next[id];
        }
        return next;
      });
      setVisibleId((prev) => (prev !== null && idSet.has(prev) ? null : prev));
    } catch {
      // 删除失败静默
    } finally {
      setDeletingBatch(false);
      setBatchDeleteConfirm(false);
    }
  };

  const filteredRecords = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) {
      return records;
    }
    return records.filter((record) => {
      const host = displayHost(record.origin).toLowerCase();
      const username = record.username.toLowerCase();
      return host.includes(query) || username.includes(query);
    });
  }, [records, searchQuery]);

  // ---- 导入 ----
  // sources 为 null 表示尚未检测过本机浏览器（进入界面不自动检测）
  const [sources, setSources] = useState<ImportSource[] | null>(null);
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [importPasswords, setImportPasswords] = useState(true);
  const [importCookies, setImportCookies] = useState(true);
  const [importing, setImporting] = useState(false);
  const [status, setStatus] = useState("");
  const [warning, setWarning] = useState("");
  const [error, setError] = useState("");
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const loadSources = useCallback(async (): Promise<void> => {
    setSourcesLoading(true);
    setError("");
    try {
      const list = await window.snow.browserImportSources();
      if (!isMountedRef.current) {
        return;
      }
      setSources(list);
      setSelectedIndex((prev) =>
        prev !== null && prev < list.length ? prev : list.length > 0 ? 0 : null,
      );
    } catch (err) {
      if (isMountedRef.current) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (isMountedRef.current) {
        setSourcesLoading(false);
      }
    }
  }, []);

  const current =
    selectedIndex !== null && sources !== null ? sources[selectedIndex] : null;

  const canImport =
    current !== null &&
    !importing &&
    ((importPasswords && current.passwordCount > 0) ||
      (importCookies && current.cookieCount > 0));

  const handleImport = async (): Promise<void> => {
    if (!current) {
      return;
    }
    setImporting(true);
    setError("");
    setWarning("");
    setStatus("");
    try {
      const passwords =
        importPasswords && current.passwordCount > 0
          ? await window.snow.browserImportPasswords(
              current.id,
              current.profile,
            )
          : null;
      const cookies =
        importCookies && current.cookieCount > 0
          ? await window.snow.browserImportCookies(current.id, current.profile)
          : null;
      if (isMountedRef.current) {
        await loadRecords();
        // 汇总弹出式提示（AutoDismissNotice）。
        const parts: string[] = [];
        let failed = 0;
        if (passwords) {
          parts.push(
            t("settings.browserImportPasswordsResult", {
              values: {
                imported: passwords.imported,
                total: passwords.total,
              },
            }),
          );
          failed += passwords.skipped;
        }
        if (cookies) {
          parts.push(
            t("settings.browserImportCookiesResult", {
              values: {
                imported: cookies.imported,
                total: cookies.total,
              },
            }),
          );
          failed += cookies.failed;
        }
        if (parts.length > 0) {
          if (failed > 0) {
            // 部分失败：以警告提示展示完整统计。
            setStatus("");
            setWarning(
              `${parts.join("、")}（${t("settings.browserImportPartialFail", {
                values: { failed },
                defaultValue: "{{failed}} items failed",
              })}）`,
            );
          } else {
            setStatus(parts.join("、"));
          }
        }
      }
    } catch (err) {
      if (isMountedRef.current) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (isMountedRef.current) {
        setImporting(false);
      }
    }
  };

  return (
    <div className="api-settings-page" role="region">
      <div className="api-settings-page-header">
        <div className="api-settings-title-group">
          <strong>
            {t("settings.browserSettingsTitle", {
              defaultValue: "Browser settings",
            })}
          </strong>
          <span className="settings-item-description">
            {t("settings.browserSettingsInfo", {
              defaultValue:
                "Homepage, saved passwords and importing data from other browsers.",
            })}
          </span>
        </div>
        {onClose && (
          <button
            className="icon-btn ghost"
            onClick={onClose}
            type="button"
            aria-label={t("settings.closeBrowserSettings", {
              defaultValue: "Close browser settings",
            })}
            title={t("settings.closeBrowserSettings", {
              defaultValue: "Close browser settings",
            })}
          >
            <X size={15} strokeWidth={1.8} />
          </button>
        )}
      </div>

      {/* 顶部 Tab：浏览器设置 / 用户脚本 */}
      <div className="import-settings-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "settings"}
          className={`import-settings-tab ${activeTab === "settings" ? "active" : ""}`}
          onClick={() => setActiveTab("settings")}
        >
          {t("settings.browserSettingsTitle", {
            defaultValue: "Browser settings",
          })}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "userscripts"}
          className={`import-settings-tab ${
            activeTab === "userscripts" ? "active" : ""
          }`}
          onClick={() => setActiveTab("userscripts")}
        >
          <TampermonkeyIcon size={13} />
          {t("userscripts.title")}
        </button>
      </div>

      {activeTab === "userscripts" ? (
        <UserscriptsSection />
      ) : (
        <>
          {/* 概览卡片 */}
          <div className="api-settings-summary-grid browser-settings-summary-grid">
            <div className="api-settings-summary-card">
              <KeyRound size={15} strokeWidth={1.8} />
              <span>{records.length}</span>
              <small>
                {t("settings.browserSavedPasswords", {
                  defaultValue: "Saved passwords",
                })}
              </small>
            </div>
            <div className="api-settings-summary-card">
              <Cookie size={15} strokeWidth={1.8} />
              <span>
                {sources?.reduce(
                  (sum, source) => sum + source.cookieCount,
                  0,
                ) ?? 0}
              </span>
              <small>
                {t("settings.browserLocalCookies", {
                  defaultValue: "Cookies on this device",
                })}
              </small>
            </div>
            <div className="api-settings-summary-card wide">
              <Globe size={15} strokeWidth={1.8} />
              <span className="browser-settings-homepage-value">
                {homepage || "—"}
              </span>
              <small>
                {t("settings.browserHomepage", { defaultValue: "Homepage" })}
              </small>
            </div>
          </div>

          {/* 起始页 */}
          <div className="browser-settings-section">
            <div className="api-settings-form-section-header">
              <span className="api-settings-form-section-title">
                {t("settings.browserHomepage", { defaultValue: "Homepage" })}
              </span>
            </div>
            <div className="browser-settings-homepage-row">
              <input
                type="text"
                className="browser-settings-input"
                value={homepageDraft}
                onChange={(e) => setHomepageDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void handleSaveHomepage();
                  }
                }}
                onBlur={() => void handleSaveHomepage()}
                placeholder={t("settings.browserHomepagePlaceholder", {
                  defaultValue: "Enter URL, leave empty for blank page",
                })}
                spellCheck={false}
              />
              <span className="browser-settings-hint">
                {t("settings.browserHomepageHint", {
                  defaultValue: "Empty means a blank page",
                })}
              </span>
            </div>
          </div>

          {/* 从本机浏览器导入 */}
          <div className="browser-settings-section">
            <div className="api-settings-form-section-header">
              <span className="api-settings-form-section-title">
                {t("settings.browserImport", { defaultValue: "Import" })}
              </span>
            </div>
            <div className="browser-settings-hint-row">
              <ShieldCheck size={13} strokeWidth={1.8} />
              <span>
                {t("settings.browserImportHint", {
                  defaultValue:
                    "Imported passwords are encrypted into the vault; cookies are written into the current browser session",
                })}
              </span>
            </div>

            {sourcesLoading ? (
              <div className="browser-settings-loading">
                <Loader2 size={16} strokeWidth={1.8} className="spin" />
              </div>
            ) : sources === null ? (
              <div className="browser-settings-empty">
                <button
                  type="button"
                  className="browser-settings-scan-action"
                  onClick={() => void loadSources()}
                >
                  <ScanSearch size={13} strokeWidth={1.8} />
                  <span>
                    {t("settings.browserImportScan", {
                      defaultValue: "Scan local browsers",
                    })}
                  </span>
                </button>
              </div>
            ) : sources.length === 0 ? (
              <div className="browser-settings-empty">
                <span>
                  {t("settings.browserImportNoSources", {
                    defaultValue:
                      "No local browser data detected (close the browser first and retry)",
                  })}
                </span>
                <button
                  type="button"
                  className="browser-settings-scan-action"
                  onClick={() => void loadSources()}
                >
                  <ScanSearch size={13} strokeWidth={1.8} />
                  <span>
                    {t("settings.browserImportRescan", {
                      defaultValue: "Rescan",
                    })}
                  </span>
                </button>
              </div>
            ) : (
              <>
                <div className="browser-settings-source-list">
                  {sources.map((source, index) => (
                    <label
                      key={`${source.id}-${source.profile}`}
                      className={`browser-settings-source${
                        selectedIndex === index ? " is-selected" : ""
                      }`}
                    >
                      <input
                        type="radio"
                        name="browser-import-source"
                        checked={selectedIndex === index}
                        onChange={() => {
                          setSelectedIndex(index);
                        }}
                      />
                      {(() => {
                        const BrowserLogo =
                          BROWSER_LOGOS[source.id as BrowserLogoId];
                        return BrowserLogo ? (
                          <BrowserLogo
                            size={24}
                            className="browser-settings-source-logo"
                          />
                        ) : null;
                      })()}
                      <span className="browser-settings-source-info">
                        <span className="browser-settings-source-name">
                          {source.name}
                          {source.profile !== "Default" && (
                            <span className="browser-settings-source-profile">
                              {source.profile}
                            </span>
                          )}
                          {source.accountName && (
                            <span className="browser-settings-source-account">
                              {source.accountName}
                            </span>
                          )}
                        </span>
                        <span className="browser-settings-source-counts">
                          {t("settings.browserImportCounts", {
                            values: {
                              passwords: source.passwordCount,
                              cookies: source.cookieCount,
                            },
                            defaultValue:
                              "{{passwords}} passwords · {{cookies}} cookies",
                          })}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>

                {current?.note && (
                  <div className="browser-settings-warning">
                    <AlertTriangle size={13} strokeWidth={1.8} />
                    <span>{current.note}</span>
                  </div>
                )}

                {current && (
                  <div className="browser-settings-import-options">
                    <label className="browser-settings-import-option">
                      <input
                        type="checkbox"
                        checked={importPasswords}
                        disabled={current.passwordCount === 0}
                        onChange={(e) => setImportPasswords(e.target.checked)}
                      />
                      <KeyRound size={13} strokeWidth={1.8} />
                      <span>
                        {t("settings.browserImportPasswordsOption", {
                          values: { count: current.passwordCount },
                          defaultValue: "Import passwords ({{count}})",
                        })}
                      </span>
                    </label>
                    <label className="browser-settings-import-option">
                      <input
                        type="checkbox"
                        checked={importCookies}
                        disabled={current.cookieCount === 0}
                        onChange={(e) => setImportCookies(e.target.checked)}
                      />
                      <Cookie size={13} strokeWidth={1.8} />
                      <span>
                        {t("settings.browserImportCookiesOption", {
                          values: { count: current.cookieCount },
                          defaultValue: "Import cookies ({{count}})",
                        })}
                      </span>
                    </label>
                  </div>
                )}
              </>
            )}
          </div>

          {sources !== null && sources.length > 0 && (
            <div className="api-settings-actions browser-settings-actions">
              <button
                className="api-settings-action-btn primary"
                onClick={() => void handleImport()}
                type="button"
                disabled={!canImport}
              >
                {importing ? (
                  <Loader2 size={15} className="spin" />
                ) : (
                  <Download size={15} />
                )}
                <span>
                  {t("settings.browserImportAction", {
                    defaultValue: "Import selected",
                  })}
                </span>
              </button>
            </div>
          )}

          {/* 密码管理 */}
          <div className="browser-settings-section">
            <div className="api-settings-form-section-header">
              <span className="api-settings-form-section-title">
                {t("settings.browserPasswords", { defaultValue: "Passwords" })}
              </span>
            </div>

            <div className="api-settings-manual-form">
              <div className="api-settings-manual-header">
                <strong>
                  {t("settings.browserPasswordsManualTitle", {
                    defaultValue: "Manage saved passwords",
                  })}
                </strong>
                <span>
                  {t("settings.browserPasswordsHint", {
                    defaultValue:
                      "Stored AES-256-GCM encrypted, key protected by the OS keychain",
                  })}
                </span>
              </div>

              <div className="api-settings-form-body">
                {recordsLoading ? (
                  <div className="browser-settings-loading">
                    <Loader2 size={16} strokeWidth={1.8} className="spin" />
                  </div>
                ) : records.length === 0 ? (
                  <div className="browser-settings-empty">
                    {t("settings.browserPasswordsEmpty", {
                      defaultValue:
                        "No saved passwords yet. They are saved automatically when you submit a login form, or import them from another browser below.",
                    })}
                  </div>
                ) : (
                  <>
                    <div className="browser-settings-search-row">
                      <Search size={13} strokeWidth={1.8} />
                      <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder={t("settings.browserPasswordSearch", {
                          defaultValue: "Search site or username",
                        })}
                        spellCheck={false}
                      />
                      {searchQuery && (
                        <button
                          type="button"
                          className="browser-settings-search-clear"
                          onClick={() => setSearchQuery("")}
                          aria-label={t("common.clear", {
                            defaultValue: "Clear",
                          })}
                          title={t("common.clear", { defaultValue: "Clear" })}
                        >
                          <X size={13} strokeWidth={1.8} />
                        </button>
                      )}
                      {searchQuery && (
                        <span className="browser-settings-search-count">
                          {filteredRecords.length}/{records.length}
                        </span>
                      )}
                    </div>

                    {selectedIds.size > 0 && (
                      <div className="browser-settings-batch-bar">
                        <span>
                          {t("settings.browserPasswordSelectedCount", {
                            values: { count: selectedIds.size },
                            defaultValue: "{{count}} selected",
                          })}
                        </span>
                        <button
                          type="button"
                          className="browser-settings-batch-delete"
                          onClick={() => setBatchDeleteConfirm(true)}
                          disabled={deletingBatch}
                        >
                          {deletingBatch ? (
                            <Loader2
                              size={13}
                              strokeWidth={1.8}
                              className="spin"
                            />
                          ) : (
                            <Trash2 size={13} strokeWidth={1.8} />
                          )}
                          <span>
                            {t("settings.browserPasswordDeleteSelected", {
                              defaultValue: "Delete selected",
                            })}
                          </span>
                        </button>
                      </div>
                    )}

                    {filteredRecords.length === 0 ? (
                      <div className="browser-settings-empty">
                        {t("settings.browserPasswordSearchEmpty", {
                          defaultValue: "No passwords match your search",
                        })}
                      </div>
                    ) : (
                      <div className="browser-settings-table-wrap">
                        <table className="browser-settings-table">
                          <thead>
                            <tr>
                              <th className="browser-settings-table-select">
                                <input
                                  type="checkbox"
                                  checked={
                                    filteredRecords.length > 0 &&
                                    filteredRecords.every((record) =>
                                      selectedIds.has(record.id),
                                    )
                                  }
                                  ref={(el) => {
                                    if (el) {
                                      el.indeterminate =
                                        filteredRecords.some((record) =>
                                          selectedIds.has(record.id),
                                        ) &&
                                        !filteredRecords.every((record) =>
                                          selectedIds.has(record.id),
                                        );
                                    }
                                  }}
                                  onChange={toggleSelectAll}
                                  aria-label={t(
                                    "settings.browserPasswordSelectAll",
                                    { defaultValue: "Select all" },
                                  )}
                                  title={t(
                                    "settings.browserPasswordSelectAll",
                                    {
                                      defaultValue: "Select all",
                                    },
                                  )}
                                />
                              </th>
                              <th>
                                {t("settings.browserPasswordSite", {
                                  defaultValue: "Site",
                                })}
                              </th>
                              <th>
                                {t("settings.browserPasswordUser", {
                                  defaultValue: "Username",
                                })}
                              </th>
                              <th>
                                {t("settings.browserPasswordValue", {
                                  defaultValue: "Password",
                                })}
                              </th>
                              <th className="browser-settings-table-actions" />
                            </tr>
                          </thead>
                          <tbody>
                            {filteredRecords.map((record) => (
                              <tr
                                key={record.id}
                                className={
                                  selectedIds.has(record.id)
                                    ? "is-selected"
                                    : ""
                                }
                              >
                                <td className="browser-settings-table-select">
                                  <input
                                    type="checkbox"
                                    checked={selectedIds.has(record.id)}
                                    onChange={() =>
                                      toggleSelectRecord(record.id)
                                    }
                                    aria-label={t(
                                      "settings.browserPasswordSelectRecord",
                                      { defaultValue: "Select this password" },
                                    )}
                                  />
                                </td>
                                <td className="browser-settings-table-host">
                                  {displayHost(record.origin)}
                                </td>
                                <td className="browser-settings-table-user">
                                  {record.username || "—"}
                                </td>
                                <td className="browser-settings-table-secret">
                                  {visibleId === record.id
                                    ? plaintext[record.id] || "••••••"
                                    : "••••••"}
                                </td>
                                <td className="browser-settings-table-actions">
                                  <button
                                    type="button"
                                    className="browser-settings-icon-btn"
                                    onClick={() =>
                                      void handleToggleVisible(record.id)
                                    }
                                    aria-label={t(
                                      visibleId === record.id
                                        ? "settings.browserPasswordHide"
                                        : "settings.browserPasswordShow",
                                    )}
                                    title={t(
                                      visibleId === record.id
                                        ? "settings.browserPasswordHide"
                                        : "settings.browserPasswordShow",
                                    )}
                                  >
                                    {visibleId === record.id ? (
                                      <EyeOff size={14} strokeWidth={1.8} />
                                    ) : (
                                      <Eye size={14} strokeWidth={1.8} />
                                    )}
                                  </button>
                                  <button
                                    type="button"
                                    className="browser-settings-icon-btn is-danger"
                                    onClick={() =>
                                      void handleDeleteRecord(record.id)
                                    }
                                    disabled={deletingId === record.id}
                                    aria-label={t("common.delete", {
                                      defaultValue: "Delete",
                                    })}
                                    title={t("common.delete", {
                                      defaultValue: "Delete",
                                    })}
                                  >
                                    {deletingId === record.id ? (
                                      <Loader2
                                        size={14}
                                        strokeWidth={1.8}
                                        className="spin"
                                      />
                                    ) : (
                                      <Trash2 size={14} strokeWidth={1.8} />
                                    )}
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        </>
      )}

      <ConfirmDialog
        open={batchDeleteConfirm}
        title={t("settings.browserPasswordBatchDeleteTitle", {
          defaultValue: "Delete selected passwords",
        })}
        message={t("settings.browserPasswordBatchDeleteMessage", {
          values: { count: selectedIds.size },
          defaultValue:
            "Delete the {{count}} selected passwords? This action cannot be undone.",
        })}
        confirmLabel={t("common.delete", { defaultValue: "Delete" })}
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        variant="danger"
        onConfirm={() => void handleBatchDelete()}
        onCancel={() => setBatchDeleteConfirm(false)}
      />

      <AutoDismissNotice
        message={error || warning || status}
        tone={error ? "error" : warning ? "warning" : "success"}
        onDismiss={() => {
          setError("");
          setWarning("");
          setStatus("");
        }}
      />
    </div>
  );
}
