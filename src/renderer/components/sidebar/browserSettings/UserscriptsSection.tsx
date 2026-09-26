import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FileUp,
  Loader2,
  Pencil,
  Plus,
  RotateCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useI18n } from "../../../i18n";
import {
  scriptEditorStore,
  useScriptEditorStore,
} from "../../../userscripts/scriptEditorStore";
import { AutoDismissNotice } from "../../AutoDismissNotice";
import { ConfirmDialog } from "../../common/ConfirmDialog";
import type {
  GreasyForkSearchItem,
  UserscriptRecord,
} from "../../../../preload/types/userscripts";

/**
 * 用户脚本管理（油猴兼容），嵌入 BrowserSettingsPanel 的 Tab 内容区。
 * 复用 api-settings / browser-settings 主题类，不引入独立页面壳。
 */

type Notice = { type: "success" | "error"; text: string } | null;

/** 新脚本默认模板。 */
const NEW_SCRIPT_TEMPLATE = `// ==UserScript==
// @name         My Script
// @namespace    snow-app
// @version      1.0
// @description  Describe what this script does
// @author       You
// @match        https://example.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

console.log("Hello from userscript!");
`;

const formatInstalls = (count: number): string => {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
};

export function UserscriptsSection(): React.JSX.Element {
  const { t } = useI18n();

  // ---- 已安装脚本 ----
  const [scripts, setScripts] = useState<UserscriptRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<Notice>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // ---- 编辑器 ----
  const editorState = useScriptEditorStore();
  const [importing, setImporting] = useState(false);

  // ---- 搜索 / 安装 ----
  const [tab, setTab] = useState<"installed" | "search">("installed");
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<GreasyForkSearchItem[]>(
    [],
  );
  const [searchPage, setSearchPage] = useState(1);
  const [searchHasMore, setSearchHasMore] = useState(false);
  const [installingUrl, setInstallingUrl] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);

  const loadScripts = useCallback(async (): Promise<void> => {
    try {
      // 客户端 UI 脚本在「插件 → 脚本插件」标签页管理，这里只列浏览器脚本。
      const records = await window.snow.listUserscripts();
      setScripts(records.filter((item) => item.target !== "client"));
    } catch (error) {
      console.error("Failed to list userscripts:", error);
      setNotice({ type: "error", text: t("userscripts.loadFailed") });
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadScripts();
  }, [loadScripts]);

  const startCreate = useCallback((): void => {
    scriptEditorStore.openNew("browser", {
      fileName: "userscript.user.js",
      title: t("userscripts.createNew"),
      content: NEW_SCRIPT_TEMPLATE,
    });
  }, [t]);

  /** 从本地 .user.js 文件导入：选择 → 预填编辑器，保存时才写库。 */
  const startImport = useCallback(async (): Promise<void> => {
    setImporting(true);
    try {
      const picked = await window.snow.pickUserscriptFile(
        t("userscripts.importPickTitle"),
      );
      if (!picked) {
        return; // 用户取消选择，静默返回。
      }
      scriptEditorStore.openNew("browser", {
        fileName: picked.fileName,
        title: t("userscripts.createNew"),
        content: picked.content,
      });
    } catch (error) {
      console.error("Failed to import userscript file:", error);
      setNotice({
        type: "error",
        text: `${t("userscripts.importFailed")} ${
          error instanceof Error ? error.message : ""
        }`,
      });
    } finally {
      setImporting(false);
    }
  }, [t]);

  const startEdit = useCallback(
    async (script: UserscriptRecord): Promise<void> => {
      try {
        // 脚本原文存放在磁盘文件，按需异步读取。
        const content = await window.snow.readUserscriptSource(script.scriptId);
        scriptEditorStore.openEdit("browser", {
          scriptId: script.scriptId,
          fileName: `${script.name}.user.js`,
          title: `${t("userscripts.edit")} — ${script.name}`,
          content,
        });
      } catch (error) {
        console.error("Failed to read userscript source:", error);
        setNotice({ type: "error", text: t("userscripts.readFailed") });
      }
    },
    [t],
  );

  const handledSaveRevision = useRef(editorState.lastSave?.revision ?? 0);
  useEffect(() => {
    const saved = editorState.lastSave;
    if (
      !saved ||
      saved.kind !== "browser" ||
      saved.revision === handledSaveRevision.current
    ) {
      return;
    }
    handledSaveRevision.current = saved.revision;
    void loadScripts();
    setNotice({
      type: "success",
      text:
        saved.action === "created"
          ? t("userscripts.created")
          : t("userscripts.updated"),
    });
  }, [editorState.lastSave, loadScripts, t]);

  const toggleEnabled = useCallback(
    async (script: UserscriptRecord): Promise<void> => {
      try {
        await window.snow.setUserscriptEnabled(
          script.scriptId,
          !script.enabled,
        );
        setScripts((prev) =>
          prev.map((item) =>
            item.scriptId === script.scriptId
              ? { ...item, enabled: !script.enabled }
              : item,
          ),
        );
      } catch (error) {
        console.error("Failed to toggle userscript:", error);
        setNotice({ type: "error", text: t("userscripts.toggleFailed") });
      }
    },
    [t],
  );

  const confirmDelete = useCallback(async (): Promise<void> => {
    if (!deletingId) {
      return;
    }
    try {
      await window.snow.deleteUserscript(deletingId);
      setScripts((prev) => prev.filter((item) => item.scriptId !== deletingId));
      setNotice({ type: "success", text: t("userscripts.deleted") });
    } catch (error) {
      console.error("Failed to delete userscript:", error);
      setNotice({ type: "error", text: t("userscripts.deleteFailed") });
    } finally {
      setDeletingId(null);
    }
  }, [deletingId, t]);

  // ---- 搜索 ----
  /** page 从 1 起；提交新关键词时重置为 1，翻页时传目标页码。 */
  const runSearch = useCallback(
    async (page: number): Promise<void> => {
      const keyword = searchQuery.trim();
      if (!keyword) {
        return;
      }
      setSearching(true);
      setHasSearched(true);
      try {
        const result = await window.snow.searchUserscripts(keyword, 20, page);
        setSearchResults(result.results);
        setSearchPage(result.page);
        setSearchHasMore(result.hasMore);
      } catch (error) {
        console.error("Failed to search userscripts:", error);
        setNotice({ type: "error", text: t("userscripts.searchFailed") });
        setSearchResults([]);
        setSearchHasMore(false);
      } finally {
        setSearching(false);
      }
    },
    [searchQuery, t],
  );

  const installScript = useCallback(
    async (item: GreasyForkSearchItem): Promise<void> => {
      setInstallingUrl(item.codeUrl);
      try {
        await window.snow.installUserscript(item.codeUrl);
        setNotice({ type: "success", text: t("userscripts.installed") });
        await loadScripts();
        setTab("installed");
      } catch (error) {
        console.error("Failed to install userscript:", error);
        setNotice({
          type: "error",
          text: `${t("userscripts.installFailed")} ${
            error instanceof Error ? error.message : ""
          }`,
        });
      } finally {
        setInstallingUrl(null);
      }
    },
    [loadScripts, t],
  );

  const installedNames = useMemo(
    () => new Set(scripts.map((script) => script.name)),
    [scripts],
  );

  return (
    <div className="browser-settings-section userscripts-section">
      {/* 区块标题 + 操作按钮 */}
      <div className="api-settings-form-section-header">
        <span className="api-settings-form-section-title">
          {t("userscripts.title")}
        </span>
        <div className="userscripts-section-actions">
          <button
            type="button"
            className="browser-settings-scan-action"
            onClick={() => void loadScripts()}
          >
            <RotateCw size={13} strokeWidth={1.8} />
            <span>{t("userscripts.refresh")}</span>
          </button>
          <button
            type="button"
            className="browser-settings-scan-action"
            onClick={() => void startImport()}
            disabled={importing}
            title={t("userscripts.importFromFile")}
          >
            {importing ? (
              <Loader2 size={13} strokeWidth={1.8} className="spin" />
            ) : (
              <FileUp size={13} strokeWidth={1.8} />
            )}
            <span>{t("userscripts.importFromFile")}</span>
          </button>
          <button
            type="button"
            className="browser-settings-scan-action"
            onClick={startCreate}
          >
            <Plus size={13} strokeWidth={1.8} />
            <span>{t("userscripts.createNew")}</span>
          </button>
        </div>
      </div>

      {/* 次级 Tab：已安装 / 搜索下载 */}
      <div className="import-settings-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "installed"}
          className={`import-settings-tab ${tab === "installed" ? "active" : ""}`}
          onClick={() => setTab("installed")}
        >
          {t("userscripts.installedTab")}
          <span className="userscripts-tab-count">{scripts.length}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "search"}
          className={`import-settings-tab ${tab === "search" ? "active" : ""}`}
          onClick={() => setTab("search")}
        >
          {t("userscripts.searchTab")}
        </button>
      </div>

      {tab === "installed" ? (
        loading ? (
          <div className="browser-settings-loading">
            <Loader2 size={16} strokeWidth={1.8} className="spin" />
          </div>
        ) : scripts.length === 0 ? (
          <div className="browser-settings-empty">
            <span>{t("userscripts.empty")}</span>
          </div>
        ) : (
          <div className="browser-settings-table-wrap">
            <table className="api-settings-table">
              <thead>
                <tr>
                  <th>{t("userscripts.name")}</th>
                  <th>{t("userscripts.matches")}</th>
                  <th>{t("userscripts.runAt")}</th>
                  <th className="browser-settings-table-actions" />
                </tr>
              </thead>
              <tbody>
                {scripts.map((script) => (
                  <tr key={script.scriptId}>
                    <td className="cell-name">
                      <strong>{script.name}</strong>
                      {script.description && (
                        <span className="userscripts-cell-desc">
                          {script.description}
                        </span>
                      )}
                      <span className="userscripts-cell-version">
                        v{script.version}
                      </span>
                    </td>
                    <td>
                      <span className="userscripts-cell-matches">
                        {script.matches.length > 0
                          ? script.matches.slice(0, 2).join(" ")
                          : t("userscripts.matchAll")}
                        {script.matches.length > 2
                          ? ` +${script.matches.length - 2}`
                          : ""}
                      </span>
                    </td>
                    <td>
                      <span className="userscripts-cell-runat">
                        {script.runAt.replace("document-", "")}
                      </span>
                    </td>
                    <td className="browser-settings-table-actions">
                      <label
                        className="toggle-switch"
                        title={
                          script.enabled
                            ? t("userscripts.disable")
                            : t("userscripts.enable")
                        }
                      >
                        <input
                          type="checkbox"
                          checked={script.enabled}
                          onChange={() => void toggleEnabled(script)}
                        />
                        <span className="toggle-slider" />
                      </label>
                      <button
                        type="button"
                        className="browser-settings-icon-btn"
                        onClick={() => void startEdit(script)}
                        title={t("userscripts.edit")}
                        aria-label={t("userscripts.edit")}
                      >
                        <Pencil size={14} strokeWidth={1.8} />
                      </button>
                      <button
                        type="button"
                        className="browser-settings-icon-btn is-danger"
                        onClick={() => setDeletingId(script.scriptId)}
                        title={t("userscripts.delete")}
                        aria-label={t("userscripts.delete")}
                      >
                        <Trash2 size={14} strokeWidth={1.8} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : (
        <>
          {/* 搜索下载：输入框与搜索按钮同行，按钮独立于输入框容器外 */}
          <div className="userscripts-search-row">
            <div className="browser-settings-search-row">
              <Search size={13} strokeWidth={1.8} />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void runSearch(1);
                  }
                }}
                placeholder={t("userscripts.searchPlaceholder")}
                spellCheck={false}
              />
              {searchQuery && (
                <button
                  type="button"
                  className="browser-settings-search-clear"
                  onClick={() => setSearchQuery("")}
                  aria-label={t("common.clear", { defaultValue: "Clear" })}
                  title={t("common.clear", { defaultValue: "Clear" })}
                >
                  <X size={13} strokeWidth={1.8} />
                </button>
              )}
            </div>
            <button
              type="button"
              className="browser-settings-scan-action userscripts-search-submit"
              onClick={() => void runSearch(1)}
              disabled={searching || !searchQuery.trim()}
            >
              {searching ? (
                <Loader2 size={13} strokeWidth={1.8} className="spin" />
              ) : (
                <Search size={13} strokeWidth={1.8} />
              )}
              <span>{t("userscripts.search")}</span>
            </button>
          </div>

          <div className="browser-settings-hint-row">
            <span>
              {t("userscripts.searchSource")}{" "}
              <a
                href="https://greasyfork.org/zh-CN"
                target="_blank"
                rel="noreferrer"
                className="userscripts-search-link"
              >
                Greasy Fork <ExternalLink size={11} strokeWidth={1.8} />
              </a>
            </span>
          </div>

          {searching ? (
            <div className="browser-settings-loading">
              <Loader2 size={16} strokeWidth={1.8} className="spin" />
            </div>
          ) : searchResults.length === 0 ? (
            hasSearched ? (
              <div className="browser-settings-empty">
                <span>{t("userscripts.noResults")}</span>
              </div>
            ) : null
          ) : (
            <>
              <div className="browser-settings-table-wrap">
                <table className="api-settings-table">
                  <thead>
                    <tr>
                      <th>{t("userscripts.name")}</th>
                      <th>{t("userscripts.installs")}</th>
                      <th className="browser-settings-table-actions" />
                    </tr>
                  </thead>
                  <tbody>
                    {searchResults.map((item) => {
                      const installed = installedNames.has(item.name);
                      return (
                        <tr key={item.codeUrl}>
                          <td className="cell-name">
                            <strong>{item.name}</strong>
                            {item.description && (
                              <span className="userscripts-cell-desc">
                                {item.description}
                              </span>
                            )}
                            <span className="userscripts-cell-rating">
                              {item.ratingScore > 0
                                ? `★ ${item.ratingScore.toFixed(1)}`
                                : ""}
                            </span>
                            {item.url && (
                              <a
                                href={item.url}
                                target="_blank"
                                rel="noreferrer"
                                className="userscripts-search-link"
                              >
                                {t("userscripts.viewDetail")}
                                <ExternalLink size={11} strokeWidth={1.8} />
                              </a>
                            )}
                          </td>
                          <td>
                            <span className="userscripts-cell-installs">
                              {formatInstalls(item.totalInstalls)}
                            </span>
                          </td>
                          <td className="browser-settings-table-actions">
                            <button
                              type="button"
                              className={`api-settings-action-btn ${
                                installed ? "secondary" : "primary"
                              } userscripts-install-btn`}
                              disabled={
                                installingUrl === item.codeUrl || installed
                              }
                              onClick={() => void installScript(item)}
                            >
                              {installingUrl === item.codeUrl ? (
                                <Loader2
                                  size={14}
                                  strokeWidth={1.8}
                                  className="spin"
                                />
                              ) : installed ? (
                                <Check size={14} strokeWidth={1.8} />
                              ) : (
                                <Download size={14} strokeWidth={1.8} />
                              )}
                              <span>
                                {installed
                                  ? t("userscripts.installedLabel")
                                  : t("userscripts.install")}
                              </span>
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {/* 相对分页：API 不返回总数，hasMore 控制下一页可用性 */}
          {hasSearched && (searchResults.length > 0 || searchPage > 1) && (
            <div className="userscripts-pagination">
              <button
                type="button"
                className="userscripts-page-btn"
                disabled={searching || searchPage <= 1}
                onClick={() => void runSearch(searchPage - 1)}
                title={t("userscripts.prevPage")}
                aria-label={t("userscripts.prevPage")}
              >
                <ChevronLeft size={14} strokeWidth={1.8} />
              </button>
              <span className="userscripts-page-indicator">
                {t("userscripts.pageIndicator", {
                  values: { page: String(searchPage) },
                })}
              </span>
              <button
                type="button"
                className="userscripts-page-btn"
                disabled={searching || !searchHasMore}
                onClick={() => void runSearch(searchPage + 1)}
                title={t("userscripts.nextPage")}
                aria-label={t("userscripts.nextPage")}
              >
                <ChevronRight size={14} strokeWidth={1.8} />
              </button>
            </div>
          )}
        </>
      )}

      {deletingId && (
        <ConfirmDialog
          open
          title={t("userscripts.deleteConfirmTitle")}
          message={t("userscripts.deleteConfirmMessage")}
          confirmLabel={t("userscripts.delete")}
          variant="danger"
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeletingId(null)}
        />
      )}

      {notice && (
        <AutoDismissNotice
          message={notice.text}
          tone={notice.type === "success" ? "success" : "error"}
          onDismiss={() => setNotice(null)}
        />
      )}
    </div>
  );
}
