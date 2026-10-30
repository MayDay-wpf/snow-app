import { Braces, CircleAlert, Clock, Loader2, Settings, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { LspSessionStatus } from "../../../../preload";
import { useI18n } from "../../../i18n";
import { DisplayPath } from "../../common/DisplayPath";
import { MCP_SERVER_STATE_CHANGED_EVENT } from "./mcpServerEvents";

const POLL_INTERVAL_MS = 3000;
const STATUS_LABEL_KEY: Record<LspSessionStatus["status"], string> = {
  running: "chatInput.lspBadgeStatusRunning",
  dead: "chatInput.lspBadgeStatusDead",
  exited: "chatInput.lspBadgeStatusExited",
};
type Snapshot = {
  projectId: string;
  items: LspSessionStatus[];
  updatedAt?: number;
  stale: boolean;
};

const LSP_SERVER_ID = "builtin:lsp";

/** LSP 是默认关闭的内置服务器，只有项目 MCP 面板显式启用后入口才显示。 */
const useLspServerEnabled = (projectId?: string): boolean => {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    if (!projectId) {
      setEnabled(false);
      return;
    }
    let disposed = false;
    const loadEnabled = async (): Promise<void> => {
      try {
        const servers =
          await window.snow.listMcpProjectServersCached(projectId);
        const server = servers.find((item) => item.id === LSP_SERVER_ID);
        if (!disposed) {
          setEnabled(Boolean(server?.globalEnabled && server.enabled));
        }
      } catch {
        if (!disposed) {
          setEnabled(false);
        }
      }
    };
    void loadEnabled();
    window.addEventListener(MCP_SERVER_STATE_CHANGED_EVENT, loadEnabled);
    return () => {
      disposed = true;
      window.removeEventListener(MCP_SERVER_STATE_CHANGED_EVENT, loadEnabled);
    };
  }, [projectId]);

  return enabled;
};

/** This reports process liveness, not indexing or semantic-query readiness. */
export function LspStatusBadge({
  projectId,
  onOpenSettings,
}: {
  projectId?: string;
  onOpenSettings?: () => void;
}): React.JSX.Element | null {
  const { locale, t } = useI18n();
  const lspEnabled = useLspServerEnabled(projectId);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverId = useId();

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setOpen(false);
    setSnapshot(null);
    if (!projectId || !lspEnabled) return;
    const fetchStatuses = async (): Promise<void> => {
      try {
        const items = await window.snow.listLspSessionStatuses(projectId);
        if (!disposed)
          setSnapshot({
            projectId,
            items,
            updatedAt: Date.now(),
            stale: false,
          });
      } catch {
        if (!disposed)
          setSnapshot((previous) => ({
            projectId,
            items: previous?.projectId === projectId ? previous.items : [],
            updatedAt:
              previous?.projectId === projectId
                ? previous.updatedAt
                : undefined,
            stale: true,
          }));
      } finally {
        // Schedule only after the previous request settles: no overlap or out-of-order snapshots.
        if (!disposed)
          timer = setTimeout(() => void fetchStatuses(), POLL_INTERVAL_MS);
      }
    };
    void fetchStatuses();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [lspEnabled, projectId]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (
        event.target instanceof Node &&
        !rootRef.current?.contains(event.target)
      )
        setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (!projectId || !lspEnabled) return null;
  // A scope switch hides the previous project's snapshot during the very first render.
  const current = snapshot?.projectId === projectId ? snapshot : null;
  const items = current?.items ?? [];
  const runningCount = items.filter((item) => item.status === "running").length;
  const problemCount = items.filter((item) => item.status !== "running").length;
  const title = !current
    ? t("chatInput.lspBadgeLoading")
    : current.stale
      ? t("chatInput.lspBadgeStale")
      : problemCount > 0
        ? t("chatInput.lspBadgeTitleProblems", {
            values: { count: problemCount },
          })
        : runningCount > 0
          ? t("chatInput.lspBadgeTitleRunning", {
              values: { count: runningCount },
            })
          : t("chatInput.lspBadgeTitleIdle");
  return (
    <div className="tooltip-wrapper lsp-status-badge-root" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`mode-badge lsp-status-badge${current?.stale || problemCount > 0 ? " has-problems" : runningCount > 0 ? " is-active" : " is-idle"}`}
        aria-label={title}
        title={title}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={popoverId}
        onClick={() => setOpen((value) => !value)}
      >
        {!current ? (
          <Loader2 size={14} className="spin" aria-hidden="true" />
        ) : current.stale || problemCount > 0 ? (
          <CircleAlert size={14} aria-hidden="true" />
        ) : (
          <Braces size={14} aria-hidden="true" />
        )}
        {!current?.stale && runningCount > 0 && (
          <span className="lsp-status-badge-count">{runningCount}</span>
        )}
      </button>
      {open && (
        <div
          className="lsp-status-popover"
          id={popoverId}
          role="dialog"
          aria-label={t("chatInput.lspBadgeTitle")}
        >
          <div className="lsp-status-popover-header">
            <div className="lsp-status-popover-title-row">
              <Braces
                size={13}
                className="lsp-status-popover-icon"
                aria-hidden="true"
              />
              <strong>{t("chatInput.lspBadgeTitle")}</strong>
              {!current?.stale && runningCount > 0 && (
                <span className="lsp-status-popover-pill">
                  {t("chatInput.lspBadgeRunning", {
                    values: { running: runningCount, total: items.length },
                  })}
                </span>
              )}
            </div>
            <button
              type="button"
              className="icon-btn ghost"
              aria-label={t("common.close")}
              onClick={() => {
                setOpen(false);
                triggerRef.current?.focus();
              }}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>

          <div className="lsp-status-popover-body">
            {!current ? (
              <div className="lsp-status-popover-state" role="status">
                <Loader2
                  size={18}
                  className="spin lsp-status-state-icon"
                  aria-hidden="true"
                />
                <span className="lsp-status-state-text">{title}</span>
              </div>
            ) : items.length === 0 ? (
              <div className="lsp-status-popover-state">
                <div className="lsp-status-empty-icon-wrap" aria-hidden="true">
                  <Braces size={18} />
                </div>
                <span className="lsp-status-state-text">
                  {current.stale
                    ? t("chatInput.lspBadgeUnknown")
                    : t("chatInput.lspBadgeEmpty")}
                </span>
              </div>
            ) : (
              <div className="lsp-status-popover-list">
                {items.map((session) => (
                  <div
                    key={`${session.lang}:${session.projectRoot}`}
                    className={`lsp-status-card ${current.stale ? "stale" : session.status}`}
                  >
                    <div className="lsp-status-card-header">
                      <div className="lsp-status-card-main">
                        <span className="lsp-status-dot" aria-hidden="true" />
                        <span className="lsp-status-lang-badge">
                          {session.lang}
                        </span>
                        <DisplayPath
                          className="lsp-status-project"
                          path={session.projectRoot}
                        />
                      </div>
                      <span className="lsp-status-card-badge">
                        {t(STATUS_LABEL_KEY[session.status])}
                      </span>
                    </div>
                    {session.error && (
                      <div className="lsp-status-error" title={session.error}>
                        {session.error}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="lsp-status-popover-footer">
            <div className="lsp-status-popover-footer-meta">
              {current?.stale ? (
                <span className="lsp-status-stale-tag" role="status">
                  <CircleAlert size={11} aria-hidden="true" />
                  {t("chatInput.lspBadgeStale")}
                </span>
              ) : current?.updatedAt ? (
                <span className="lsp-status-time-tag">
                  <Clock size={11} aria-hidden="true" />
                  {t("chatInput.lspBadgeUpdated", {
                    values: {
                      time: new Date(current.updatedAt).toLocaleTimeString(
                        locale,
                      ),
                    },
                  })}
                </span>
              ) : null}
            </div>
            {onOpenSettings && (
              <button
                type="button"
                className="lsp-status-settings-btn"
                onClick={() => {
                  setOpen(false);
                  onOpenSettings();
                }}
              >
                <Settings size={12} aria-hidden="true" />
                <span>{t("chatInput.lspBadgeOpenSettings")}</span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
