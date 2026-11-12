import {
  AlertTriangle,
  BookOpen,
  ChevronDown,
  ChevronRight,
  Circle,
  Download,
  FileText,
  FolderGit2,
  Info,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  Square,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  RepoWikiPage,
  RepoWikiRecord,
  WorkspaceDirectoryRecord,
} from "../../../preload";
import { useI18n } from "../../i18n";
import { useSplitResize } from "../../hooks/useSplitResize";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { MarkdownBlock } from "../mainContent/chatMessages/components/markdownRenderer";
import { usePathClickOpen } from "../mainContent/chatMessages/hooks/usePathClickOpen";
import {
  closeRepoWikiTarget,
  ensureRepoWikiTarget,
  selectRepoWikiTarget,
  useRepoWikiTargets,
  type RepoWikiTarget,
} from "./repoWikiNavigation";
import {
  RepoWikiSetupCard,
  type RepoWikiSetupValues,
} from "./RepoWikiSetupCard";
import { useRepoWiki } from "./useRepoWiki";
import "./repoWiki.css";

type RepoWikiPanelProps = {
  activeDirectory: WorkspaceDirectoryRecord | null;
};

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const formatTime = (value: number | null | undefined): string =>
  value ? new Date(value).toLocaleString() : "-";

const PageStatusIcon = ({
  status,
}: {
  status: RepoWikiPage["status"];
}): React.JSX.Element => {
  if (status === "generating") {
    return <Loader2 className="spin" size={13} />;
  }
  if (status === "failed") {
    return <AlertTriangle className="repo-wiki-icon-failed" size={13} />;
  }
  if (status === "pending") {
    return <Circle className="repo-wiki-icon-pending" size={11} />;
  }
  return <FileText size={13} />;
};

export const RepoWikiPanel = ({
  activeDirectory,
}: RepoWikiPanelProps): React.JSX.Element => {
  const { t, locale } = useI18n();
  const { current: target, opened } = useRepoWikiTargets();

  // 直接打开页面时以当前项目为目标
  useEffect(() => {
    if (target || !activeDirectory?.path) {
      return;
    }
    ensureRepoWikiTarget({
      directoryId: activeDirectory.directoryId,
      path: activeDirectory.path,
      name: activeDirectory.name,
    });
  }, [activeDirectory, target]);

  const projectPath = target?.path ?? null;
  const { wiki, isLoading, loadError, activity, reload } =
    useRepoWiki(projectPath);
  const pathClick = usePathClickOpen(
    projectPath ?? undefined,
    target?.directoryId || undefined,
  );
  const {
    containerRef: layoutRef,
    width: sidebarWidth,
    onResizeStart,
  } = useSplitResize({
    variableName: "--repo-wiki-split-width",
    storageKey: "snow:repo-wiki:sidebar-width",
    defaultWidth: 280,
  });

  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isSetupOpen, setIsSetupOpen] = useState(false);
  const [isMetaOpen, setIsMetaOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [retryingPageId, setRetryingPageId] = useState<string | null>(null);
  const [isTransferring, setIsTransferring] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [wikiFilePath, setWikiFilePath] = useState("");
  const [isEditingSettings, setIsEditingSettings] = useState(false);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  useEffect(() => {
    setSelectedPageId(null);
    setIsSetupOpen(false);
    setIsEditingSettings(false);
    setSettingsError(null);
    setActionError(null);
    setWikiFilePath("");
    if (projectPath) {
      void window.snow
        .repoWikiFilePath(projectPath)
        .then(setWikiFilePath)
        .catch(() => setWikiFilePath(""));
    }
  }, [projectPath]);

  const pages = wiki?.pages ?? [];
  const isPaused = wiki?.status === "paused";
  const isRunning = wiki?.status === "running" || isPaused;
  const donePages = pages.filter((page) => page.status === "done").length;
  const failedPages = pages.filter((page) => page.status === "failed").length;

  // 选中页失效时回落到第一篇可读页面
  useEffect(() => {
    if (pages.length === 0) {
      return;
    }
    if (selectedPageId && pages.some((page) => page.id === selectedPageId)) {
      return;
    }
    const firstReadable = pages.find((page) => page.content) ?? pages[0];
    setSelectedPageId(firstReadable.id);
  }, [pages, selectedPageId]);

  const childrenByParent = useMemo(() => {
    const map = new Map<string, RepoWikiPage[]>();
    for (const page of pages) {
      if (page.parentId) {
        map.set(page.parentId, [...(map.get(page.parentId) ?? []), page]);
      }
    }
    return map;
  }, [pages]);
  const topLevelPages = useMemo(
    () =>
      pages.filter(
        (page) =>
          !page.parentId || !pages.some((item) => item.id === page.parentId),
      ),
    [pages],
  );
  const selectedPage = pages.find((page) => page.id === selectedPageId) ?? null;
  const showSetup = !wiki || isSetupOpen || (pages.length === 0 && !isRunning);

  const defaultSetupValues = (
    record: RepoWikiRecord | null,
  ): RepoWikiSetupValues => ({
    language: record
      ? record.language === "en"
        ? "en"
        : "zh-CN"
      : locale.startsWith("zh")
        ? "zh-CN"
        : "en",
    apiProfile: record?.apiProfile ?? "",
    model: record?.model ?? "",
    diagrams: record?.diagrams ?? true,
    retries: record?.retries ?? 0,
  });

  const handleStart = async (values: RepoWikiSetupValues): Promise<void> => {
    if (!target) return;
    setIsSubmitting(true);
    setActionError(null);
    try {
      await window.snow.repoWikiStart({
        projectPath: target.path,
        projectName: target.name,
        language: values.language,
        apiProfile: values.apiProfile || undefined,
        model: values.model.trim() || undefined,
        diagrams: values.diagrams,
        retries: values.retries,
      });
      setIsSetupOpen(false);
      await reload();
    } catch (error) {
      setActionError(errorText(error));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleStop = (): void => {
    if (!target) return;
    void window.snow.repoWikiStop(target.path).catch((error: unknown) => {
      setActionError(errorText(error));
    });
  };

  const handleDelete = async (): Promise<void> => {
    if (!target) return;
    setIsDeleteOpen(false);
    try {
      await window.snow.repoWikiDelete(target.path);
      setSelectedPageId(null);
      await reload();
    } catch (error) {
      setActionError(errorText(error));
    }
  };

  const handlePauseResume = (): void => {
    if (!target) return;
    const action = isPaused
      ? window.snow.repoWikiResume(target.path)
      : window.snow.repoWikiPause(target.path);
    void action
      .then(() => reload())
      .catch((error: unknown) => setActionError(errorText(error)));
  };

  const handleRetryPage = async (pageId: string): Promise<void> => {
    if (!target) return;
    setRetryingPageId(pageId);
    setActionError(null);
    try {
      await window.snow.repoWikiRetryPage(target.path, pageId);
      await reload();
    } catch (error) {
      setActionError(errorText(error));
    } finally {
      setRetryingPageId(null);
    }
  };

  const handleExport = async (): Promise<void> => {
    if (!target || isRunning) return;
    setIsTransferring(true);
    setActionError(null);
    try {
      await window.snow.repoWikiExport(target.path, target.name);
    } catch (error) {
      setActionError(errorText(error));
    } finally {
      setIsTransferring(false);
    }
  };

  const handleImport = async (): Promise<void> => {
    if (!target || isRunning) return;
    setIsTransferring(true);
    setActionError(null);
    try {
      const result = await window.snow.repoWikiImport(target.path);
      if (!result.canceled) {
        setSelectedPageId(null);
        setIsSetupOpen(false);
        await reload();
      }
    } catch (error) {
      setActionError(errorText(error));
    } finally {
      setIsTransferring(false);
    }
  };

  const handleAutoRefreshChange = async (enabled: boolean): Promise<void> => {
    if (!target) return;
    try {
      await window.snow.repoWikiSetAutoRefresh(target.path, enabled);
      await reload();
    } catch (error) {
      setActionError(errorText(error));
    }
  };

  const openSettingsEditor = (): void => {
    setSettingsError(null);
    setIsEditingSettings(true);
  };

  const closeSettingsEditor = (): void => {
    setSettingsError(null);
    setIsEditingSettings(false);
  };

  const handleSaveSettings = async (
    values: RepoWikiSetupValues,
  ): Promise<void> => {
    if (!target) return;
    setIsSavingSettings(true);
    setSettingsError(null);
    try {
      await window.snow.repoWikiUpdateSettings({
        projectPath: target.path,
        language: values.language,
        apiProfile: values.apiProfile || undefined,
        model: values.model.trim() || undefined,
        diagrams: values.diagrams,
        retries: values.retries,
      });
      setIsEditingSettings(false);
      await reload();
    } catch (error) {
      setSettingsError(errorText(error));
    } finally {
      setIsSavingSettings(false);
    }
  };

  const phaseLabel = (phase: string): string => {
    switch (phase) {
      case "analyzing":
        return t("repoWiki.phaseAnalyzing", {
          defaultValue: "Analyzing the codebase",
        });
      case "catalog":
        return t("repoWiki.phaseCatalog", {
          defaultValue: "Generating the catalog",
        });
      case "pages":
        return t("repoWiki.phasePages", { defaultValue: "Generating pages" });
      case "saving":
        return t("repoWiki.phaseSaving", { defaultValue: "Saving the wiki" });
      default:
        return t("repoWiki.phaseRunning", { defaultValue: "Generating" });
    }
  };

  const activityLabel = (): string => {
    if (!activity?.activityTool) {
      return "";
    }
    const values = { target: activity.activityTarget ?? "" };
    if (activity.activityTool === "search") {
      return t("repoWiki.activitySearch", {
        values,
        defaultValue: "Searching {{target}}",
      });
    }
    if (activity.activityTool === "find") {
      return t("repoWiki.activityFind", {
        values,
        defaultValue: "Finding {{target}}",
      });
    }
    if (activity.activityTool === "edit") {
      return t("repoWiki.activityEdit", {
        values,
        defaultValue: "Editing {{target}}",
      });
    }
    if (activity.activityTool === "catalog") {
      return t("repoWiki.activityCatalog", {
        values,
        defaultValue: "Updating the catalog: {{target}}",
      });
    }
    return t("repoWiki.activityRead", {
      values,
      defaultValue: "Reading {{target}}",
    });
  };

  const renderPageItem = (
    page: RepoWikiPage,
    depth: number,
  ): React.JSX.Element => {
    const children = childrenByParent.get(page.id) ?? [];
    return (
      <li key={page.id}>
        <button
          className={`repo-wiki-tree-item status-${page.status}${
            page.id === selectedPageId ? " active" : ""
          }`}
          onClick={() => setSelectedPageId(page.id)}
          style={{ paddingLeft: 26 + depth * 14 }}
          title={page.description || page.title}
          type="button"
        >
          <PageStatusIcon status={page.status} />
          <span className="repo-wiki-tree-label">{page.title}</span>
        </button>
        {children.length > 0 ? (
          <ul className="repo-wiki-tree">
            {children.map((child) => renderPageItem(child, depth + 1))}
          </ul>
        ) : null}
      </li>
    );
  };

  const renderProject = (item: RepoWikiTarget): React.JSX.Element => {
    const isCurrent = item.path === target?.path;
    return (
      <li className="repo-wiki-project" key={item.path}>
        <div className={`repo-wiki-project-row${isCurrent ? " active" : ""}`}>
          <button
            className="repo-wiki-project-btn"
            onClick={() => selectRepoWikiTarget(item.path)}
            title={item.path}
            type="button"
          >
            {isCurrent ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            <FolderGit2 size={14} />
            <span className="repo-wiki-tree-label">{item.name}</span>
          </button>
          {opened.length > 1 ? (
            <button
              aria-label={t("repoWiki.closeProject", {
                defaultValue: "Close project",
              })}
              className="repo-wiki-icon-btn ghost"
              onClick={() => closeRepoWikiTarget(item.path)}
              title={t("repoWiki.closeProject", {
                defaultValue: "Close project",
              })}
              type="button"
            >
              <X size={12} />
            </button>
          ) : null}
        </div>
        {isCurrent ? (
          pages.length > 0 ? (
            <ul className="repo-wiki-tree">
              {topLevelPages.map((page) => renderPageItem(page, 0))}
            </ul>
          ) : (
            <div className="repo-wiki-tree-empty">
              {isLoading
                ? t("common.loading", { defaultValue: "Loading..." })
                : isRunning
                  ? phaseLabel(wiki?.phase ?? "")
                  : t("repoWiki.notGenerated", {
                      defaultValue: "Not generated yet",
                    })}
            </div>
          )
        ) : null}
      </li>
    );
  };

  const renderMeta = (record: RepoWikiRecord): React.JSX.Element => {
    if (isEditingSettings) {
      return (
        <RepoWikiSetupCard
          description={t("repoWiki.editSettingsDescription", {
            defaultValue:
              "Existing pages are kept as they are. Auto updates and page retries use the new settings; use Regenerate to rewrite the whole wiki.",
          })}
          error={settingsError}
          initialValues={defaultSetupValues(record)}
          isSubmitting={isSavingSettings}
          key={`${record.projectPath}:settings`}
          onCancel={closeSettingsEditor}
          onSubmit={(values) => void handleSaveSettings(values)}
          submitLabel={t("common.save", { defaultValue: "Save" })}
          title={t("repoWiki.editSettingsTitle", {
            defaultValue: "Edit generation settings",
          })}
          variant="inline"
        />
      );
    }
    return (
      <div className="repo-wiki-meta">
        <dl className="repo-wiki-meta-list">
          <dt>{t("repoWiki.metaBranch", { defaultValue: "Branch" })}</dt>
          <dd>{record.branch ?? "-"}</dd>
          <dt>{t("repoWiki.metaCommit", { defaultValue: "Commit" })}</dt>
          <dd className="mono">
            {record.commit ? record.commit.slice(0, 12) : "-"}
          </dd>
          <dt>{t("repoWiki.language", { defaultValue: "Language" })}</dt>
          <dd>{record.language === "en" ? "English" : "简体中文"}</dd>
          <dt>{t("repoWiki.apiProfile", { defaultValue: "API config" })}</dt>
          <dd>{record.apiProfile || "-"}</dd>
          <dt>{t("repoWiki.model", { defaultValue: "Model" })}</dt>
          <dd>{record.model || "-"}</dd>
          <dt>{t("repoWiki.retries", { defaultValue: "Retries per page" })}</dt>
          <dd>
            {record.retries > 0
              ? record.retries
              : t("repoWiki.noRetry", { defaultValue: "No retry" })}
          </dd>
          <dt>{t("repoWiki.diagrams", { defaultValue: "Diagrams" })}</dt>
          <dd>
            {record.diagrams
              ? t("repoWiki.diagramsOn", { defaultValue: "On" })
              : t("repoWiki.diagramsOff", { defaultValue: "Off" })}
          </dd>
          <dt>{t("repoWiki.metaUpdated", { defaultValue: "Updated" })}</dt>
          <dd>{formatTime(record.generatedAt ?? record.updatedAt)}</dd>
          <dt>{t("repoWiki.metaPages", { defaultValue: "Pages" })}</dt>
          <dd>
            {donePages}/{pages.length}
            {failedPages > 0
              ? ` · ${t("repoWiki.failedCount", {
                  values: { count: failedPages },
                  defaultValue: "{{count}} failed",
                })}`
              : ""}
          </dd>
          <dt>{t("repoWiki.metaFile", { defaultValue: "Wiki file" })}</dt>
          <dd>
            {wikiFilePath ? (
              <code className="md-file-path" data-file-path={wikiFilePath}>
                {wikiFilePath}
              </code>
            ) : (
              "-"
            )}
          </dd>
        </dl>
        <button
          className="repo-wiki-btn repo-wiki-meta-edit"
          disabled={isRunning}
          onClick={openSettingsEditor}
          title={
            isRunning
              ? t("repoWiki.editSettingsBusy", {
                  defaultValue:
                    "Stop the running task before editing the settings",
                })
              : t("repoWiki.editSettingsTitle", {
                  defaultValue: "Edit generation settings",
                })
          }
          type="button"
        >
          <Pencil size={12} />
          <span>{t("repoWiki.editSettings", { defaultValue: "Edit" })}</span>
        </button>
      </div>
    );
  };

  const renderPage = (page: RepoWikiPage): React.JSX.Element => {
    if (!page.content) {
      return (
        <div className="repo-wiki-placeholder">
          {page.status === "failed" ? (
            <>
              <AlertTriangle className="repo-wiki-icon-failed" size={20} />
              <strong>
                {t("repoWiki.pageFailed", {
                  defaultValue: "This page failed to generate",
                })}
              </strong>
              {page.error ? <span>{page.error}</span> : null}
            </>
          ) : page.status === "generating" ? (
            <>
              <Loader2 className="spin" size={20} />
              <strong>
                {t("repoWiki.pageGenerating", {
                  defaultValue: "Generating this page...",
                })}
              </strong>
              {activity?.pageId === page.id ? (
                <span>{activityLabel()}</span>
              ) : null}
            </>
          ) : (
            <>
              <Circle className="repo-wiki-icon-pending" size={18} />
              <strong>
                {t("repoWiki.pagePending", {
                  defaultValue: "Waiting to be generated",
                })}
              </strong>
              {page.description ? <span>{page.description}</span> : null}
            </>
          )}
        </div>
      );
    }
    return (
      <article className="repo-wiki-article">
        {page.status === "failed" && page.error ? (
          <div className="repo-wiki-error">
            {t("repoWiki.pageRefreshFailed", {
              values: { error: page.error },
              defaultValue: "Last refresh failed: {{error}}",
            })}
          </div>
        ) : null}
        <MarkdownBlock
          className="repo-wiki-markdown ai-message"
          content={page.content}
        />
        {page.files.length > 0 ? (
          <div className="repo-wiki-files">
            <span className="repo-wiki-files-title">
              {t("repoWiki.relatedFiles", { defaultValue: "Related files" })}
            </span>
            <div className="repo-wiki-files-list">
              {page.files.map((file) => (
                <code className="md-file-path" data-file-path={file} key={file}>
                  {file}
                </code>
              ))}
            </div>
          </div>
        ) : null}
      </article>
    );
  };

  const renderBody = (): React.JSX.Element => {
    if (!target) {
      return (
        <div className="repo-wiki-placeholder">
          <BookOpen size={22} />
          <strong>
            {t("repoWiki.noProject", { defaultValue: "No project" })}
          </strong>
          <span>
            {t("repoWiki.noProjectHint", {
              defaultValue: "Open Repo Wiki from a project's context menu.",
            })}
          </span>
        </div>
      );
    }
    if (isLoading && !wiki) {
      return (
        <div className="repo-wiki-placeholder">
          <Loader2 className="spin" size={20} />
        </div>
      );
    }
    if (showSetup) {
      const regenerating = Boolean(wiki && pages.length > 0);
      return (
        <div className="repo-wiki-setup-wrap">
          <RepoWikiSetupCard
            description={t("repoWiki.setupDescription", {
              defaultValue:
                "The AI reads the codebase with read-only tools and writes an architecture guide with source references. Results are stored locally, not in the repository.",
            })}
            error={
              actionError ??
              (wiki?.status === "failed" && wiki.error ? wiki.error : null)
            }
            initialValues={defaultSetupValues(wiki)}
            isSubmitting={isSubmitting}
            key={`${target.path}:${regenerating ? "regen" : "new"}`}
            onCancel={regenerating ? () => setIsSetupOpen(false) : undefined}
            onImport={
              regenerating || isRunning ? undefined : () => void handleImport()
            }
            isImporting={isTransferring}
            onSubmit={(values) => void handleStart(values)}
            submitLabel={
              regenerating
                ? t("repoWiki.regenerate", { defaultValue: "Regenerate" })
                : t("repoWiki.generate", { defaultValue: "Generate Wiki" })
            }
            title={
              regenerating
                ? t("repoWiki.regenerateTitle", {
                    defaultValue: "Regenerate the wiki",
                  })
                : t("repoWiki.setupTitle", {
                    defaultValue: "Generate a wiki for {{name}}",
                    values: { name: target.name },
                  })
            }
          />
        </div>
      );
    }
    if (pages.length === 0) {
      return (
        <div className="repo-wiki-placeholder">
          <Loader2 className="spin" size={20} />
          <strong>{phaseLabel(wiki.phase)}</strong>
          {activity ? <span>{activityLabel()}</span> : null}
        </div>
      );
    }
    if (!selectedPage) {
      return <div />;
    }
    const retrying = retryingPageId === selectedPage.id;
    return (
      <div className="repo-wiki-page-body">
        <div className="repo-wiki-page-toolbar">
          <span
            className="repo-wiki-page-title"
            title={selectedPage.description}
          >
            {selectedPage.title}
          </span>
          {!isRunning ? (
            <button
              className="repo-wiki-btn"
              disabled={retrying}
              onClick={() => void handleRetryPage(selectedPage.id)}
              title={t("repoWiki.retryPageHint", {
                defaultValue:
                  "Regenerate this chapter only (works for both successful and failed pages)",
              })}
              type="button"
            >
              {retrying ? (
                <Loader2 className="spin" size={13} />
              ) : (
                <RefreshCw size={13} />
              )}
              <span>
                {t("repoWiki.retryPage", { defaultValue: "Retry page" })}
              </span>
            </button>
          ) : null}
        </div>
        {renderPage(selectedPage)}
      </div>
    );
  };

  const showToolbar = Boolean(target && wiki);

  return (
    <div className="feature-page repo-wiki-page">
      <div
        className={`repo-wiki-layout${isSidebarCollapsed ? " collapsed" : ""}`}
        ref={layoutRef}
        style={
          {
            "--repo-wiki-split-width": `${sidebarWidth}px`,
          } as React.CSSProperties
        }
      >
        {!isSidebarCollapsed ? (
          <>
            <aside className="repo-wiki-sidebar">
              <div className="repo-wiki-sidebar-header">
                <span>
                  {t("repoWiki.projects", { defaultValue: "Projects" })}
                </span>
                {failedPages > 0 ? (
                  <span className="repo-wiki-failed-badge">
                    {t("repoWiki.failedCount", {
                      values: { count: failedPages },
                      defaultValue: "{{count}} failed",
                    })}
                  </span>
                ) : null}
                <button
                  aria-label={t("repoWiki.collapseSidebar", {
                    defaultValue: "Collapse",
                  })}
                  className="repo-wiki-icon-btn ghost"
                  onClick={() => setIsSidebarCollapsed(true)}
                  title={t("repoWiki.collapseSidebar", {
                    defaultValue: "Collapse",
                  })}
                  type="button"
                >
                  <PanelLeftClose size={14} />
                </button>
              </div>
              <ul className="repo-wiki-projects">
                {opened.map(renderProject)}
              </ul>
            </aside>
            <div
              aria-orientation="vertical"
              className="panel-resizer layout-resizer split-resizer repo-wiki-resizer"
              onPointerDown={onResizeStart}
              role="separator"
            />
          </>
        ) : null}

        <section
          className="repo-wiki-main"
          onAuxClick={pathClick.onAuxClick}
          onClick={pathClick.onClick}
        >
          {target ? (
            <header className="repo-wiki-toolbar">
              {isSidebarCollapsed ? (
                <button
                  aria-label={t("repoWiki.expandSidebar", {
                    defaultValue: "Show catalog",
                  })}
                  className="repo-wiki-icon-btn"
                  onClick={() => setIsSidebarCollapsed(false)}
                  title={t("repoWiki.expandSidebar", {
                    defaultValue: "Show catalog",
                  })}
                  type="button"
                >
                  <PanelLeftOpen size={14} />
                </button>
              ) : null}
              <div className="repo-wiki-title">
                <strong>{wiki?.title || target.name}</strong>
                {wiki ? (
                  <span className={`repo-wiki-status status-${wiki.status}`}>
                    {wiki.status === "running"
                      ? phaseLabel(wiki.phase)
                      : wiki.status === "paused"
                        ? t("repoWiki.statusPaused", { defaultValue: "Paused" })
                        : wiki.status === "failed"
                          ? t("repoWiki.statusFailed", {
                              defaultValue: "Failed",
                            })
                          : wiki.status === "stopped"
                            ? t("repoWiki.statusStopped", {
                                defaultValue: "Stopped",
                              })
                            : t("repoWiki.statusCompleted", {
                                defaultValue: "Up to date",
                              })}
                  </span>
                ) : null}
              </div>
              {showToolbar && wiki ? (
                <div className="repo-wiki-actions">
                  <label
                    className="toggle-switch"
                    title={t("repoWiki.autoRefreshHint", {
                      defaultValue:
                        "After each conversation turn, pages whose source files changed are refreshed automatically",
                    })}
                  >
                    <input
                      checked={wiki.autoRefresh}
                      onChange={(event) =>
                        void handleAutoRefreshChange(event.target.checked)
                      }
                      type="checkbox"
                    />
                    <span className="toggle-slider" />
                    <span>
                      {t("repoWiki.autoRefresh", {
                        defaultValue: "Auto update",
                      })}
                    </span>
                  </label>
                  <button
                    className={`repo-wiki-icon-btn${isMetaOpen ? " active" : ""}`}
                    onClick={() => {
                      if (isMetaOpen) closeSettingsEditor();
                      setIsMetaOpen(!isMetaOpen);
                    }}
                    title={t("repoWiki.metadata", { defaultValue: "Metadata" })}
                    type="button"
                  >
                    <Info size={14} />
                  </button>
                  <button
                    aria-label={t("repoWiki.import", {
                      defaultValue: "Import",
                    })}
                    className="repo-wiki-icon-btn"
                    disabled={isRunning || isTransferring}
                    onClick={() => void handleImport()}
                    title={
                      isRunning
                        ? t("repoWiki.transferBusy", {
                            defaultValue:
                              "Stop the running task before importing or exporting",
                          })
                        : t("repoWiki.importHint", {
                            defaultValue: "Import from a wiki JSON file",
                          })
                    }
                    type="button"
                  >
                    <Upload size={14} />
                  </button>
                  <button
                    aria-label={t("repoWiki.export", {
                      defaultValue: "Export",
                    })}
                    className="repo-wiki-icon-btn"
                    disabled={isRunning || isTransferring}
                    onClick={() => void handleExport()}
                    title={
                      isRunning
                        ? t("repoWiki.transferBusy", {
                            defaultValue:
                              "Stop the running task before importing or exporting",
                          })
                        : t("repoWiki.exportHint", {
                            defaultValue: "Export as a Markdown zip archive",
                          })
                    }
                    type="button"
                  >
                    {isTransferring ? (
                      <Loader2 className="spin" size={14} />
                    ) : (
                      <Download size={14} />
                    )}
                  </button>
                  {isRunning ? (
                    <>
                      <button
                        className="repo-wiki-btn"
                        onClick={handlePauseResume}
                        type="button"
                      >
                        {isPaused ? <Play size={12} /> : <Pause size={12} />}
                        <span>
                          {isPaused
                            ? t("repoWiki.resume", { defaultValue: "Resume" })
                            : t("repoWiki.pause", { defaultValue: "Pause" })}
                        </span>
                      </button>
                      <button
                        className="repo-wiki-btn danger"
                        onClick={handleStop}
                        type="button"
                      >
                        <Square size={12} />
                        <span>
                          {t("repoWiki.stop", { defaultValue: "Stop" })}
                        </span>
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        className="repo-wiki-btn"
                        disabled={pages.length === 0}
                        onClick={() => setIsSetupOpen(true)}
                        type="button"
                      >
                        <RefreshCw size={13} />
                        <span>
                          {t("repoWiki.regenerate", {
                            defaultValue: "Regenerate",
                          })}
                        </span>
                      </button>
                      <button
                        aria-label={t("repoWiki.delete", {
                          defaultValue: "Delete wiki",
                        })}
                        className="repo-wiki-icon-btn danger"
                        onClick={() => setIsDeleteOpen(true)}
                        title={t("repoWiki.delete", {
                          defaultValue: "Delete wiki",
                        })}
                        type="button"
                      >
                        <Trash2 size={14} />
                      </button>
                    </>
                  )}
                </div>
              ) : null}
            </header>
          ) : null}

          {showToolbar && wiki && isMetaOpen ? renderMeta(wiki) : null}

          {showToolbar && wiki && isRunning && pages.length > 0 ? (
            <div className="repo-wiki-progress">
              {isPaused ? (
                <Pause size={13} />
              ) : (
                <Loader2 className="spin" size={13} />
              )}
              <span className="repo-wiki-progress-phase">
                {isPaused
                  ? t("repoWiki.pausedHint", {
                      defaultValue: "Paused — current request will finish",
                    })
                  : phaseLabel(wiki.phase)}
              </span>
              <span className="repo-wiki-progress-count">
                {donePages}/{pages.length}
              </span>
              <span className="repo-wiki-progress-activity">
                {activityLabel()}
              </span>
              <span className="repo-wiki-progress-bar" aria-hidden="true">
                <span
                  style={{
                    width: `${pages.length ? Math.round((donePages / pages.length) * 100) : 0}%`,
                  }}
                />
              </span>
            </div>
          ) : null}

          {(actionError || loadError) && !showSetup ? (
            <div className="repo-wiki-error repo-wiki-inline-error">
              {actionError ?? loadError}
            </div>
          ) : null}

          <div className="repo-wiki-body">{renderBody()}</div>
        </section>
      </div>
      <ConfirmDialog
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        confirmLabel={t("repoWiki.delete", { defaultValue: "Delete wiki" })}
        message={t("repoWiki.deleteConfirm", {
          defaultValue:
            "Delete the local wiki of this project? You can regenerate it at any time.",
        })}
        onCancel={() => setIsDeleteOpen(false)}
        onConfirm={() => void handleDelete()}
        open={isDeleteOpen}
        title={t("repoWiki.delete", { defaultValue: "Delete wiki" })}
        variant="danger"
      />
    </div>
  );
};
