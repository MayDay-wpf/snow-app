import { Braces, CircleAlert, Loader2, Settings, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { LspSessionStatus } from "../../../../preload";
import { useI18n } from "../../../i18n";

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

/** This reports process liveness, not indexing or semantic-query readiness. */
export function LspStatusBadge({
  projectId,
  onOpenSettings,
}: {
  projectId?: string;
  onOpenSettings?: () => void;
}): React.JSX.Element | null {
  const { t } = useI18n();
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
    if (!projectId) return;
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
  }, [projectId]);

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

  if (!projectId) return null;
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
        className={`plan-mode-badge lsp-status-badge${current?.stale || problemCount > 0 ? " has-problems" : runningCount > 0 ? " is-active" : " is-idle"}`}
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
            <strong>{t("chatInput.lspBadgeTitle")}</strong>
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
          <div className="lsp-status-popover-list">
            <p className="lsp-status-popover-empty">
              {t("chatInput.lspBadgeProcessOnly")}
            </p>
            {current?.stale && (
              <p className="lsp-status-popover-empty" role="status">
                {t("chatInput.lspBadgeStale")}
              </p>
            )}
            {current?.updatedAt && (
              <p className="lsp-status-popover-empty">
                {t("chatInput.lspBadgeUpdated", {
                  values: {
                    time: new Date(current.updatedAt).toLocaleTimeString(),
                  },
                })}
              </p>
            )}
            {!current ? (
              <p className="lsp-status-popover-empty" role="status">
                {title}
              </p>
            ) : items.length === 0 ? (
              <p className="lsp-status-popover-empty">
                {current.stale
                  ? t("chatInput.lspBadgeUnknown")
                  : t("chatInput.lspBadgeEmpty")}
              </p>
            ) : (
              items.map((session) => (
                <div
                  key={`${session.lang}:${session.projectRoot}`}
                  className={`lsp-status-row ${current.stale ? "stale" : session.status}`}
                >
                  <span className="lsp-status-dot" aria-hidden="true" />
                  <strong className="lsp-status-lang">{session.lang}</strong>
                  <span
                    className="lsp-status-project"
                    title={session.projectRoot}
                  >
                    {session.projectRoot}
                  </span>
                  <span className="lsp-status-label">
                    {t(STATUS_LABEL_KEY[session.status])}
                  </span>
                  {session.error && (
                    <span className="lsp-status-error" title={session.error}>
                      {session.error}
                    </span>
                  )}
                </div>
              ))
            )}
          </div>
          {onOpenSettings && (
            <div className="lsp-status-popover-footer">
              <button
                type="button"
                className="api-settings-form-btn secondary"
                onClick={() => {
                  setOpen(false);
                  onOpenSettings();
                }}
              >
                <Settings size={13} aria-hidden="true" />
                {t("chatInput.lspBadgeOpenSettings")}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
