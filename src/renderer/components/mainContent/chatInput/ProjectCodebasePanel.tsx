import {
  AlertCircle,
  ArrowUpDown,
  BrainCircuit,
  Database,
  FileWarning,
  Globe,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Settings,
  Square,
  Trash2,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CodebaseProjectScopeSettings } from "../../../../preload";
import type {
  CodebaseIndexStats,
  CodebaseScanPreview,
} from "../../../../preload/types/settings";
import { useI18n } from "../../../i18n";
import { useCodebaseEmbedding } from "../../../hooks/useCodebaseEmbedding";
import { useCodebaseSync } from "../../../hooks/useCodebaseSync";
import { APP_CONTROL_OPEN_SETTINGS_EVENT } from "../../../hooks/useAppControl";
import { ConfirmDialog } from "../../common/ConfirmDialog";
import { Modal } from "../../common/Modal";

/** 派发该事件打开当前项目的代码库管理弹窗（TopBar 同步指示器使用）。 */
export const OPEN_PROJECT_CODEBASE_PANEL_EVENT = "project-codebase:open-panel";

type ProjectCodebasePanelProps = {
  open: boolean;
  projectId?: string;
  projectName?: string;
  onClose: () => void;
};

type ToggleKey = "enabled" | "enableAgentReview" | "enableReranking";

const formatElapsed = (ms: number): string => {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
};

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export const ProjectCodebasePanel = ({
  open,
  projectId,
  projectName,
  onClose,
}: ProjectCodebasePanelProps): React.JSX.Element => {
  const { t } = useI18n();

  // ── Scope & gitignore (project-scoped data) ──────────────────────────
  const [scope, setScope] = useState<CodebaseProjectScopeSettings | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingKey, setPendingKey] = useState<ToggleKey | null>(null);
  const [hasGitignore, setHasGitignore] = useState<boolean | null>(null);
  const [isRemoteProject, setIsRemoteProject] = useState(false);

  // ── Index stats & scan preview (project-scoped data) ─────────────────
  const [indexStats, setIndexStats] = useState<CodebaseIndexStats | null>(null);
  const [indexStatsLoaded, setIndexStatsLoaded] = useState(false);
  const [scanPreview, setScanPreview] = useState<CodebaseScanPreview | null>(
    null,
  );
  const [isScanningPreview, setIsScanningPreview] = useState(false);

  // ── Disable-with-embedding confirmation ─────────────────────────────
  // When the user tries to disable codebase indexing while embedding is
  // still active, we show a confirmation dialog. If confirmed, the embedding
  // is cancelled and the index (and related tables) are deleted.
  const [showDisableConfirm, setShowDisableConfirm] = useState(false);

  // ── Generation guard for async loads (scope/stats/scan/resumable) ────
  // Ensures that when the user switches projects, stale async results from
  // the previous project don't overwrite the new project's state.
  const loadGenerationRef = useRef(0);

  // ── Embedding state (fully isolated by projectId via the hook) ──────
  // The hook uses a generation counter internally: every project switch
  // bumps the counter, permanently invalidating any in-flight progress
  // callbacks from the previous project — even if the user switches back.
  const loadIndexStats = useCallback(async (): Promise<void> => {
    if (!projectId) {
      return;
    }
    try {
      const stats = await window.snow.getCodebaseIndexStats(projectId);
      setIndexStats(stats);
    } catch {
      setIndexStats(null);
    } finally {
      setIndexStatsLoaded(true);
    }
  }, [projectId]);

  const embedding = useCodebaseEmbedding({
    projectId,
    onEmbeddingDone: () => {
      void loadIndexStats();
    },
  });

  const isEmbedding =
    embedding.embedState === "running" || embedding.embedState === "paused";

  // ── Sync progress (fully isolated by projectId via the hook) ────────
  const sync = useCodebaseSync({
    projectId,
    suppress: isEmbedding,
    onSyncDone: () => {
      void loadIndexStats();
    },
  });

  const isEnabled = scope?.enabled ?? false;

  // ── Load scope & gitignore when project changes ──────────────────────
  const loadScope = useCallback(async (): Promise<void> => {
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    setPendingKey(null);
    setScope(null);
    setError(null);
    setHasGitignore(null);
    setIsRemoteProject(false);

    if (!projectId) {
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    try {
      const [nextScope, nextHasGitignore] = await Promise.all([
        window.snow.getCodebaseProjectScopeSettings(projectId),
        window.snow.checkProjectHasGitignore(projectId),
      ]);
      let nextIsRemote = false;
      try {
        nextIsRemote = await window.snow.checkProjectIsRemote(projectId);
      } catch {
        // Remote detection is best-effort: treat it as a local project
        // when the check fails so scope loading is not blocked.
      }
      if (loadGenerationRef.current === generation) {
        setScope(nextScope);
        setHasGitignore(nextHasGitignore);
        setIsRemoteProject(nextIsRemote);
      }
    } catch (loadError) {
      if (loadGenerationRef.current === generation) {
        setError(
          loadError instanceof Error ? loadError.message : String(loadError),
        );
      }
    } finally {
      if (loadGenerationRef.current === generation) {
        setIsLoading(false);
      }
    }
  }, [projectId]);

  const loadScanPreview = useCallback(async (): Promise<void> => {
    if (!projectId) {
      return;
    }
    setIsScanningPreview(true);
    try {
      const preview = await window.snow.previewCodebaseScan(projectId);
      setScanPreview(preview);
    } catch {
      setScanPreview(null);
    } finally {
      setIsScanningPreview(false);
    }
  }, [projectId]);

  // ── Reset project-scoped data when the panel opens or project changes ─
  useEffect(() => {
    if (open) {
      sync.clearSyncProgress();
      setScanPreview(null);
      setIndexStats(null);
      setIndexStatsLoaded(false);
      void loadScope();
      void loadIndexStats();
      void embedding.loadResumableSession();
      return;
    }

    // When closing: reset scope-loading state and sync progress.
    // Embedding state is owned by the hook and isolated by projectId, so
    // it does not need to be reset here — the hook's internal generation
    // guard prevents stale callbacks from leaking.
    sync.clearSyncProgress();
    setScanPreview(null);
    setIndexStats(null);
    setIndexStatsLoaded(false);
    loadGenerationRef.current += 1;
    setPendingKey(null);
    setIsLoading(false);
    setShowDisableConfirm(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectId, loadScope, loadIndexStats]);

  // ── Auto-load scan preview when codebase is enabled and no index yet ─
  useEffect(() => {
    if (
      open &&
      isEnabled &&
      !isEmbedding &&
      !scanPreview &&
      indexStatsLoaded &&
      !indexStats?.isIndexed
    ) {
      void loadScanPreview();
    }
  }, [
    open,
    isEnabled,
    isEmbedding,
    scanPreview,
    indexStatsLoaded,
    indexStats,
    loadScanPreview,
  ]);

  // ── Toggle handlers ──────────────────────────────────────────────────
  const toggle = async (key: ToggleKey, enabled: boolean): Promise<void> => {
    if (!projectId || pendingKey) {
      return;
    }

    // When disabling codebase indexing while embedding is still active,
    // intercept and show a confirmation dialog instead of proceeding
    // directly. The user may not realise that disabling will discard
    // all in-progress embedding work and the existing index.
    if (key === "enabled" && !enabled && isEmbedding) {
      setShowDisableConfirm(true);
      return;
    }

    const generation = loadGenerationRef.current;
    setPendingKey(key);
    setError(null);
    setScope((current) => (current ? { ...current, [key]: enabled } : current));

    try {
      if (key === "enabled") {
        await window.snow.setCodebaseProjectEnabled(projectId, enabled);
      } else if (key === "enableAgentReview") {
        await window.snow.setCodebaseProjectAgentReview(projectId, enabled);
      } else {
        await window.snow.setCodebaseProjectReranking(projectId, enabled);
      }
    } catch (updateError) {
      if (loadGenerationRef.current === generation) {
        setScope((current) =>
          current ? { ...current, [key]: !enabled } : current,
        );
        setError(
          updateError instanceof Error
            ? updateError.message
            : String(updateError),
        );
      }
    } finally {
      if (loadGenerationRef.current === generation) {
        setPendingKey(null);
      }
    }
  };

  const handleClearIndex = useCallback(async (): Promise<void> => {
    if (!projectId) {
      return;
    }
    try {
      await window.snow.clearCodebaseIndex(projectId);
      setIndexStats(null);
      setIndexStatsLoaded(false);
      // Clear preview so it auto-reloads after clearing the index.
      setScanPreview(null);
      void loadIndexStats();
    } catch (clearError) {
      setError(
        clearError instanceof Error ? clearError.message : String(clearError),
      );
    }
  }, [projectId, loadIndexStats]);

  // ── Open the codebase settings page from the embed error state ───────
  // Dispatches the same event the app-control MCP tool uses, extended with
  // the target settings view so the Sidebar can navigate directly there.
  const handleOpenCodebaseSettings = useCallback((): void => {
    window.dispatchEvent(
      new CustomEvent(APP_CONTROL_OPEN_SETTINGS_EVENT, {
        detail: { view: "codebase-settings" },
      }),
    );
  }, []);

  // ── Confirm disable while embedding is active ────────────────────────
  // User confirmed: cancel the in-progress embedding, clear the index and
  // related tables, then actually disable codebase indexing for the project.
  const confirmDisableWithEmbedding = useCallback(async (): Promise<void> => {
    if (!projectId) {
      setShowDisableConfirm(false);
      return;
    }

    setShowDisableConfirm(false);
    const generation = loadGenerationRef.current;
    setPendingKey("enabled");
    setError(null);

    try {
      // 1. Cancel any in-progress embedding session.
      if (isEmbedding) {
        await embedding.cancelEmbedding();
      }

      // 2. Clear the existing index and related tables.
      await window.snow.clearCodebaseIndex(projectId);
      setIndexStats(null);
      setIndexStatsLoaded(false);
      setScanPreview(null);

      // 3. Disable codebase indexing for the project.
      await window.snow.setCodebaseProjectEnabled(projectId, false);
      if (loadGenerationRef.current === generation) {
        setScope((current) =>
          current ? { ...current, enabled: false } : current,
        );
      }
    } catch (disableError) {
      if (loadGenerationRef.current === generation) {
        setError(
          disableError instanceof Error
            ? disableError.message
            : String(disableError),
        );
        // Reload scope to reflect the actual server-side state.
        void loadScope();
      }
    } finally {
      if (loadGenerationRef.current === generation) {
        setPendingKey(null);
      }
    }
  }, [projectId, isEmbedding, embedding, loadScope]);

  const renderToggle = (
    key: ToggleKey,
    label: string,
    description: string,
    Icon: LucideIcon,
  ): React.JSX.Element => {
    const checked = scope?.[key] ?? false;
    const isPending = pendingKey === key;

    return (
      <article
        className={`project-sensitive-command-row${
          checked ? " is-enabled" : ""
        }`}
      >
        <Icon size={15} />
        <div className="project-sensitive-command-content">
          <div>
            <code>{label}</code>
          </div>
          <span>{description}</span>
        </div>
        <label
          className="toggle-switch"
          title={
            checked
              ? t("projectCodebase.disableForProject")
              : t("projectCodebase.enableForProject")
          }
        >
          <input
            aria-label={
              checked
                ? t("projectCodebase.disableForProject")
                : t("projectCodebase.enableForProject")
            }
            checked={checked}
            disabled={isPending}
            hidden
            onChange={(event) => void toggle(key, event.target.checked)}
            type="checkbox"
          />
          <span className="toggle-slider" />
        </label>
      </article>
    );
  };

  const progressPercent =
    embedding.embedProgress && embedding.embedProgress.totalChunks > 0
      ? Math.round(
          (embedding.embedProgress.processedChunks /
            embedding.embedProgress.totalChunks) *
            100,
        )
      : 0;

  const phaseLabel = embedding.embedProgress
    ? t(`projectCodebase.phase.${embedding.embedProgress.phase}`)
    : "";

  // ── Embed error state: message + recoverability classification ───────
  // `embedError` is captured by the hook both from the terminal progress
  // event ("error" phase) and from rejected IPC calls, so it always holds
  // the failure reason. Configuration-missing errors are not retryable —
  // the user must configure the embedding model first, so we guide them
  // to the codebase settings page instead of offering a retry button.
  const embedErrorMessage =
    embedding.embedError ?? embedding.embedProgress?.error ?? "";
  const isEmbedConfigMissing =
    embedding.embedState === "error" &&
    /required|not configured|api key|base url|model name/i.test(
      embedErrorMessage,
    );

  return (
    <>
      <Modal
        className="project-sensitive-command-modal project-codebase-modal"
        closeLabel={t("projectCodebase.close")}
        description={
          projectId
            ? t("projectCodebase.description", {
                values: { project: projectName || projectId },
              })
            : t("projectCodebase.noProject")
        }
        onClose={onClose}
        open={open}
        size="large"
        title={t("projectCodebase.title")}
      >
        {!projectId ? (
          <div className="project-sensitive-command-state">
            <AlertCircle size={18} />
            <span>{t("projectCodebase.noProject")}</span>
          </div>
        ) : isLoading && !scope ? (
          <div className="project-sensitive-command-state">
            <Loader2 className="spin" size={18} />
            <span>{t("projectCodebase.loading")}</span>
          </div>
        ) : isRemoteProject ? (
          <div className="project-sensitive-command-state project-codebase-gitignore-warning">
            <Globe size={18} />
            <span>{t("projectCodebase.remoteUnsupported")}</span>
          </div>
        ) : hasGitignore === false ? (
          <div className="project-sensitive-command-state project-codebase-gitignore-warning">
            <FileWarning size={18} />
            <span>{t("projectCodebase.gitignoreMissing")}</span>
          </div>
        ) : (
          <>
            <div className="project-sensitive-command-toolbar">
              <div>
                <span>{t("projectCodebase.scopeNote")}</span>
              </div>
              <div>
                <button
                  className="project-sensitive-command-toolbar-btn"
                  disabled={isLoading || pendingKey !== null || isEmbedding}
                  onClick={() => {
                    void loadScope();
                    void loadIndexStats();
                  }}
                  type="button"
                >
                  <RefreshCw className={isLoading ? "spin" : ""} size={14} />
                  <span>{t("projectCodebase.refresh")}</span>
                </button>
              </div>
            </div>

            {error ? (
              <div className="project-sensitive-command-error">
                <AlertCircle size={15} />
                <span>{error}</span>
              </div>
            ) : null}

            <div className="project-sensitive-command-groups project-codebase-list">
              {renderToggle(
                "enabled",
                t("projectCodebase.toggleEnabled"),
                t("projectCodebase.toggleEnabledDescription"),
                Database,
              )}
              {renderToggle(
                "enableAgentReview",
                t("projectCodebase.toggleAgentReview"),
                t("projectCodebase.toggleAgentReviewDescription"),
                BrainCircuit,
              )}
              {renderToggle(
                "enableReranking",
                t("projectCodebase.toggleReranking"),
                t("projectCodebase.toggleRerankingDescription"),
                ArrowUpDown,
              )}
            </div>

            {isEnabled ? (
              <div className="project-codebase-embedding-section">
                <div className="project-codebase-embedding-header">
                  <Database size={15} />
                  <div>
                    <strong>{t("projectCodebase.embedding.title")}</strong>
                    <span>{t("projectCodebase.embedding.description")}</span>
                  </div>
                </div>

                {sync.syncProgress && indexStats?.isIndexed && !isEmbedding ? (
                  <div className="project-codebase-files-changed-hint">
                    <Loader2 size={14} className="spin" />
                    <span>{t("projectCodebase.syncing")}</span>
                  </div>
                ) : null}

                {embedding.resumableSession && !isEmbedding ? (
                  <div className="project-codebase-resumable-session">
                    <div className="project-codebase-resumable-info">
                      <RotateCcw size={15} />
                      <div>
                        <strong>
                          {t("projectCodebase.resume.title")}
                          <span className="project-codebase-resumable-status">
                            {embedding.resumableSession.status === "paused"
                              ? t("projectCodebase.resume.statusPaused")
                              : t("projectCodebase.resume.statusInterrupted")}
                          </span>
                        </strong>
                        <span>{t("projectCodebase.resume.description")}</span>
                        {embedding.resumableSession.totalFiles > 0 ? (
                          <span className="project-codebase-resumable-progress">
                            {t("projectCodebase.resume.progress", {
                              values: {
                                processed:
                                  embedding.resumableSession.processedFiles,
                                total: embedding.resumableSession.totalFiles,
                                chunks:
                                  embedding.resumableSession.processedChunks,
                              },
                            })}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <div className="project-codebase-resumable-actions">
                      <button
                        className="project-codebase-embed-btn primary"
                        disabled={embedding.isResuming}
                        onClick={() => void embedding.resumeSession()}
                        type="button"
                      >
                        {embedding.isResuming ? (
                          <Loader2 className="spin" size={14} />
                        ) : (
                          <Play size={14} />
                        )}
                        <span>{t("projectCodebase.resume.resume")}</span>
                      </button>
                      <button
                        className="project-codebase-embed-btn"
                        disabled={embedding.isResuming}
                        onClick={() => void embedding.discardSession()}
                        type="button"
                      >
                        <X size={14} />
                        <span>{t("projectCodebase.resume.discard")}</span>
                      </button>
                    </div>
                  </div>
                ) : null}

                {(embedding.embedState === "completed" ||
                  indexStats?.isIndexed) &&
                indexStats &&
                !isEmbedding ? (
                  <div className="project-codebase-index-stats">
                    <div className="project-codebase-stat-item">
                      <span className="project-codebase-stat-label">
                        {t("projectCodebase.stats.files")}
                      </span>
                      <span className="project-codebase-stat-value">
                        {indexStats.totalFiles}
                      </span>
                    </div>
                    <div className="project-codebase-stat-item">
                      <span className="project-codebase-stat-label">
                        {t("projectCodebase.stats.chunks")}
                      </span>
                      <span className="project-codebase-stat-value">
                        {indexStats.totalChunks}
                      </span>
                    </div>
                    <div className="project-codebase-stat-item">
                      <span className="project-codebase-stat-label">
                        {t("projectCodebase.stats.size")}
                      </span>
                      <span className="project-codebase-stat-value">
                        {formatBytes(indexStats.totalSizeBytes)}
                      </span>
                    </div>
                  </div>
                ) : null}

                {scanPreview && !indexStats?.isIndexed && !isEmbedding ? (
                  <div className="project-codebase-scan-preview">
                    <div className="project-codebase-stat-item">
                      <span className="project-codebase-stat-label">
                        {t("projectCodebase.preview.files")}
                      </span>
                      <span className="project-codebase-stat-value">
                        {scanPreview.fileCount}
                      </span>
                    </div>
                    <div className="project-codebase-stat-item">
                      <span className="project-codebase-stat-label">
                        {t("projectCodebase.preview.chunks")}
                      </span>
                      <span className="project-codebase-stat-value">
                        {scanPreview.estimatedChunks}
                      </span>
                    </div>
                    <div className="project-codebase-stat-item">
                      <span className="project-codebase-stat-label">
                        {t("projectCodebase.preview.size")}
                      </span>
                      <span className="project-codebase-stat-value">
                        {formatBytes(scanPreview.totalSizeBytes)}
                      </span>
                    </div>
                  </div>
                ) : isScanningPreview &&
                  !indexStats?.isIndexed &&
                  !isEmbedding ? (
                  <div className="project-codebase-scan-preview">
                    <Loader2 className="spin" size={14} />
                    <span>{t("projectCodebase.preview.scanning")}</span>
                  </div>
                ) : null}

                {embedding.embedProgress ? (
                  <div className="project-codebase-embed-progress">
                    <div className="project-codebase-embed-progress-info">
                      <span className="project-codebase-embed-phase">
                        {phaseLabel}
                      </span>
                      {embedding.embedProgress.currentFile ? (
                        <span
                          className="project-codebase-embed-file"
                          title={embedding.embedProgress.currentFile}
                        >
                          {embedding.embedProgress.currentFile}
                        </span>
                      ) : null}
                      <span className="project-codebase-embed-counts">
                        {embedding.embedProgress.processedChunks} /{" "}
                        {embedding.embedProgress.totalChunks}
                        {embedding.embedProgress.totalFiles > 0
                          ? ` (${embedding.embedProgress.processedFiles}/${embedding.embedProgress.totalFiles})`
                          : ""}
                      </span>
                      {embedding.embedProgress.elapsedMs > 0 ? (
                        <span className="project-codebase-embed-elapsed">
                          {formatElapsed(embedding.embedProgress.elapsedMs)}
                        </span>
                      ) : null}
                    </div>
                    <div className="project-codebase-embed-progress-bar">
                      <div
                        className="project-codebase-embed-progress-fill"
                        style={{ width: `${progressPercent}%` }}
                      />
                    </div>
                  </div>
                ) : null}

                {embedding.embedState === "error" ? (
                  <div className="project-codebase-embed-error">
                    <div className="project-codebase-embed-error-header">
                      <AlertCircle size={14} />
                      <span>{t("projectCodebase.embedding.errorTitle")}</span>
                    </div>
                    {embedErrorMessage ? (
                      <div className="project-codebase-embed-error-message">
                        {embedErrorMessage}
                      </div>
                    ) : null}
                    {isEmbedConfigMissing ? (
                      <div className="project-codebase-embed-error-hint">
                        {t("projectCodebase.embedding.errorConfigHint")}
                      </div>
                    ) : null}
                  </div>
                ) : null}

                <div className="project-codebase-embed-actions">
                  {embedding.embedState === "error" ? (
                    <button
                      className="project-codebase-embed-btn primary"
                      onClick={() => {
                        // Retry reuses the same flows as the start button:
                        // resume the interrupted session when one exists,
                        // otherwise start a fresh embedding run.
                        if (embedding.resumableSession) {
                          void embedding.resumeSession();
                        } else {
                          void embedding.startEmbedding();
                        }
                      }}
                      type="button"
                    >
                      <RotateCcw size={14} />
                      <span>{t("projectCodebase.embedding.retry")}</span>
                    </button>
                  ) : null}
                  {embedding.embedState === "error" && isEmbedConfigMissing ? (
                    <button
                      className="project-codebase-embed-btn"
                      onClick={handleOpenCodebaseSettings}
                      type="button"
                    >
                      <Settings size={14} />
                      <span>{t("projectCodebase.embedding.openSettings")}</span>
                    </button>
                  ) : null}
                  {(embedding.embedState === "idle" ||
                    embedding.embedState === "completed") &&
                  !embedding.resumableSession ? (
                    <button
                      className="project-codebase-embed-btn primary"
                      disabled={isEmbedding}
                      onClick={() => void embedding.startEmbedding()}
                      type="button"
                    >
                      <Play size={14} />
                      <span>
                        {embedding.embedState === "completed" ||
                        indexStats?.isIndexed
                          ? t("projectCodebase.embedding.reindex")
                          : t("projectCodebase.embedding.start")}
                      </span>
                    </button>
                  ) : null}
                  {embedding.embedState === "running" ? (
                    <button
                      className="project-codebase-embed-btn"
                      onClick={() => void embedding.pauseEmbedding()}
                      type="button"
                    >
                      <Pause size={14} />
                      <span>{t("projectCodebase.embedding.pause")}</span>
                    </button>
                  ) : null}
                  {embedding.embedState === "paused" ? (
                    <button
                      className="project-codebase-embed-btn primary"
                      onClick={() => void embedding.resumeEmbedding()}
                      type="button"
                    >
                      <Play size={14} />
                      <span>{t("projectCodebase.embedding.resume")}</span>
                    </button>
                  ) : null}
                  {isEmbedding ? (
                    <button
                      className="project-codebase-embed-btn danger"
                      onClick={() => void embedding.cancelEmbedding()}
                      type="button"
                    >
                      <Square size={14} />
                      <span>{t("projectCodebase.embedding.cancel")}</span>
                    </button>
                  ) : null}
                  {indexStats &&
                  indexStats.isIndexed &&
                  !isEmbedding &&
                  !embedding.resumableSession ? (
                    <button
                      className="project-codebase-embed-btn danger"
                      onClick={() => void handleClearIndex()}
                      type="button"
                    >
                      <Trash2 size={14} />
                      <span>{t("projectCodebase.embedding.clear")}</span>
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}

            <div className="project-codebase-config-hint">
              <BrainCircuit size={14} />
              <span>{t("projectCodebase.configHint")}</span>
            </div>
          </>
        )}
      </Modal>
      <ConfirmDialog
        cancelLabel={t("projectCodebase.disableConfirmCancel")}
        confirmLabel={t("projectCodebase.disableConfirmAction")}
        message={t("projectCodebase.disableConfirmMessage")}
        onCancel={() => setShowDisableConfirm(false)}
        onConfirm={() => void confirmDisableWithEmbedding()}
        open={showDisableConfirm}
        title={t("projectCodebase.disableConfirmTitle")}
        variant="danger"
      />
    </>
  );
};
