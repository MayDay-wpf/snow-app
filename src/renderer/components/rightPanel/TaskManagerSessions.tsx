import { useEffect, useRef, useState } from "react";
import { Power, RefreshCw } from "lucide-react";
import type {
  LspSessionStatus,
  LspSessionTarget,
} from "../../../preload/types/lsp";
import { useI18n } from "../../i18n";
import { formatDisplayPath } from "../../utils/formatDisplayPath";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { DisplayPath } from "../common/DisplayPath";
import {
  processIdentity,
  sessionSampleIsFresh,
  summarizeProcesses,
  type SessionSnapshot,
  type TaskManagerRow,
} from "./taskManagerModel";
import {
  formatTaskBytes,
  formatTaskTotalCpu,
  taskProjectName,
} from "./taskManagerPresentation";

type Props = {
  isActive: boolean;
  sessions: LspSessionStatus[];
  rows: TaskManagerRow[];
  groups: Map<LspSessionStatus, TaskManagerRow[]>;
  snapshot: SessionSnapshot | null;
  processStale: boolean;
  sessionsStale: boolean;
  now: number;
  externalBusy: boolean;
  onBusyChange: (busy: boolean) => void;
  onRefresh: () => Promise<void>;
  onProject: (root: string) => void;
};
type PendingAction = {
  target: LspSessionTarget;
  identity: string;
  action: "stop" | "restart";
};

export function TaskManagerSessions({
  isActive,
  sessions,
  rows,
  groups,
  snapshot,
  processStale,
  sessionsStale,
  now,
  externalBusy,
  onBusyChange,
  onRefresh,
  onProject,
}: Props): React.JSX.Element {
  const { t, locale } = useI18n();
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState("");
  const lockRef = useRef(false);
  const pendingRef = useRef(false);
  const activeRef = useRef(isActive);
  const mountedRef = useRef(true);
  activeRef.current = isActive;
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    pendingRef.current = pending !== null;
    onBusyChange(pending !== null || acting);
  }, [pending, acting, onBusyChange]);
  const verifiedRoot = (session: LspSessionStatus) => {
    const pid = session.resources?.pid;
    if (
      !isActive ||
      processStale ||
      sessionsStale ||
      session.status !== "running" ||
      !Number.isInteger(pid) ||
      pid == null ||
      pid <= 0 ||
      !Number.isInteger(session.restartCount) ||
      session.restartCount < 0 ||
      !sessionSampleIsFresh(session, now)
    )
      return undefined;
    const root = rows.find(
      (row) => row.pid === pid && row.lspSession === session,
    );
    return root && snapshot?.rootIdentities.get(pid) === processIdentity(root)
      ? root
      : undefined;
  };
  const begin = (
    session: LspSessionStatus,
    action: PendingAction["action"],
  ): void => {
    if (externalBusy || lockRef.current || pendingRef.current) return;
    const root = verifiedRoot(session);
    if (!root) return;
    pendingRef.current = true;
    setError("");
    setPending({
      action,
      identity: processIdentity(root),
      target: {
        lang: session.lang,
        projectRoot: session.projectRoot,
        expectedPid: root.pid,
        expectedRestartCount: session.restartCount,
      },
    });
  };
  const confirm = async (): Promise<void> => {
    if (!pending || lockRef.current || externalBusy) return;
    const currentSession = snapshot?.sessions.find(
      (session) =>
        session.lang === pending.target.lang &&
        session.projectRoot === pending.target.projectRoot,
    );
    const currentRoot = currentSession && verifiedRoot(currentSession);
    if (
      !currentRoot ||
      processIdentity(currentRoot) !== pending.identity ||
      currentRoot.pid !== pending.target.expectedPid ||
      currentSession!.restartCount !== pending.target.expectedRestartCount
    ) {
      setError(t("taskManager.sessionChanged"));
      return;
    }
    lockRef.current = true;
    setActing(true);
    setError("");
    try {
      // Fresh metadata plus process identity; the backend repeats the identity check atomically.
      const [freshSessions, freshProcesses] = await Promise.all([
        window.snow.listLspSessionStatuses(),
        window.snow.getProcessSnapshot(),
      ]);
      const matches = freshSessions.filter(
        (session) =>
          session.lang === pending.target.lang &&
          session.projectRoot === pending.target.projectRoot,
      );
      const session = matches[0];
      const roots = freshProcesses.filter(
        (process) => process.pid === pending.target.expectedPid,
      );
      if (
        !activeRef.current ||
        document.hidden ||
        !mountedRef.current ||
        matches.length !== 1 ||
        !session ||
        session.status !== "running" ||
        session.resources?.pid !== pending.target.expectedPid ||
        session.restartCount !== pending.target.expectedRestartCount ||
        !sessionSampleIsFresh(session, Date.now()) ||
        roots.length !== 1 ||
        roots[0].kind !== "child" ||
        processIdentity(roots[0]) !== pending.identity
      )
        throw new Error(t("taskManager.sessionChanged"));
      const result = await window.snow.manageLspSession(
        pending.target,
        pending.action,
      );
      if (
        (pending.action === "stop" && result !== null) ||
        (pending.action === "restart" &&
          (!result ||
            result.lang !== pending.target.lang ||
            result.projectRoot !== pending.target.projectRoot ||
            result.status !== "running"))
      )
        throw new Error(t("taskManager.sessionResultUnconfirmed"));
      if (mountedRef.current) setPending(null);
      await onRefresh();
    } catch (reason) {
      if (mountedRef.current)
        setError(
          reason instanceof Error
            ? reason.message
            : t("taskManager.sessionActionFailed"),
        );
    } finally {
      lockRef.current = false;
      if (mountedRef.current) setActing(false);
    }
  };
  const time = (value: number): string =>
    new Date(value).toLocaleTimeString(locale);
  return (
    <>
      <details className="task-manager-disclosure task-manager-sessions">
        <summary>
          {t("taskManager.sessionsTitle", {
            values: { count: sessions.length },
          })}
          {sessionsStale && (
            <span className="task-manager-badge">{t("taskManager.stale")}</span>
          )}
        </summary>
        <div className="task-manager-session-list">
          <p className="task-manager-hint">
            {t("taskManager.sessionAccounting")}
          </p>
          <p className="task-manager-hint">
            {t("taskManager.sessionActionHint")}
          </p>
          {sessionsStale && (
            <p className="task-manager-error" role="status">
              {t("taskManager.lspStale")}
            </p>
          )}
          {!sessions.length && (
            <p className="task-manager-hint">{t("lsp.resources.empty")}</p>
          )}
          {sessions.map((session, index) => {
            const group = groups.get(session) ?? [];
            const groupSummary = summarizeProcesses(group);
            const stale =
              sessionsStale ||
              processStale ||
              !sessionSampleIsFresh(session, now);
            const state =
              sessionsStale ||
              (session.status === "running" &&
                !sessionSampleIsFresh(session, now))
                ? "stale"
                : session.status;
            const root = verifiedRoot(session);
            const disabled =
              !root || externalBusy || pending !== null || acting;
            return (
              <div
                className="task-manager-session"
                key={`${session.lang}:${session.projectRoot}:${index}`}
                data-session-root={session.projectRoot}
              >
                <div className="task-manager-session-heading">
                  <span className="task-manager-badge">{session.lang}</span>
                  <strong title={formatDisplayPath(session.projectRoot)}>
                    {taskProjectName(session.projectRoot)}
                  </strong>
                  <span className={`task-manager-session-state is-${state}`}>
                    {t(`taskManager.session.${state}`)}
                  </span>
                </div>
                <button
                  type="button"
                  className="task-manager-project task-manager-project-link"
                  title={formatDisplayPath(session.projectRoot)}
                  aria-label={t("taskManager.filterProject", {
                    values: { project: formatDisplayPath(session.projectRoot) },
                  })}
                  onClick={() => onProject(session.projectRoot)}
                >
                  <DisplayPath path={session.projectRoot} />
                </button>
                <div className="task-manager-session-metrics">
                  <span>PID {session.resources?.pid ?? "—"}</span>
                  <span>
                    {t("taskManager.restarts", {
                      values: { count: session.restartCount },
                    })}
                  </span>
                  <span>
                    {t("lsp.resources.sampled")}:{" "}
                    {session.resources?.sampledAtMs
                      ? time(session.resources.sampledAtMs)
                      : "—"}
                  </span>
                </div>
                {group.length > 0 && !stale ? (
                  <div className="task-manager-session-metrics">
                    <span>
                      {t("taskManager.visibleGroup", {
                        values: { count: groupSummary.count },
                      })}
                    </span>
                    <span>{formatTaskBytes(groupSummary.memory)}</span>
                    <span>CPU {formatTaskTotalCpu(groupSummary)}</span>
                  </div>
                ) : (
                  <p className="task-manager-hint">
                    {t("taskManager.unlinkedSession")}
                  </p>
                )}
                <div className="task-manager-session-actions">
                  <button
                    type="button"
                    className="task-manager-refresh-btn"
                    data-session-action="stop"
                    disabled={disabled}
                    title={
                      root
                        ? t("taskManager.stopSession")
                        : t("taskManager.sessionActionUnavailable")
                    }
                    onClick={() => begin(session, "stop")}
                  >
                    <Power size={12} aria-hidden="true" />
                    {t("taskManager.stopSession")}
                  </button>
                  <button
                    type="button"
                    className="task-manager-refresh-btn"
                    data-session-action="restart"
                    disabled={disabled}
                    title={
                      root
                        ? t("taskManager.restartSession")
                        : t("taskManager.sessionActionUnavailable")
                    }
                    onClick={() => begin(session, "restart")}
                  >
                    <RefreshCw size={12} aria-hidden="true" />
                    {t("taskManager.restartSession")}
                  </button>
                </div>
                {!root && (
                  <p className="task-manager-hint">
                    {t("taskManager.sessionActionUnavailable")}
                  </p>
                )}
                {session.error && (
                  <p className="task-manager-session-error">{session.error}</p>
                )}
              </div>
            );
          })}
        </div>
      </details>
      <ConfirmDialog
        open={pending !== null}
        className="task-manager-session-confirm"
        variant="danger"
        title={t(
          pending?.action === "restart"
            ? "taskManager.restartSession"
            : "taskManager.stopSession",
        )}
        message={
          pending
            ? t("taskManager.sessionActionConfirm", {
                values: {
                  action: t(
                    pending.action === "restart"
                      ? "taskManager.restartSession"
                      : "taskManager.stopSession",
                  ),
                  lang: pending.target.lang,
                  root: formatDisplayPath(pending.target.projectRoot),
                  pid: pending.target.expectedPid,
                },
              })
            : ""
        }
        confirmLabel={t(
          pending?.action === "restart"
            ? "taskManager.restartSession"
            : "taskManager.stopSession",
        )}
        cancelLabel={t("common.cancel")}
        isConfirming={acting}
        onConfirm={() => void confirm()}
        onCancel={() => {
          if (!lockRef.current) {
            setPending(null);
            setError("");
          }
        }}
      >
        {error && (
          <p className="task-manager-kill-error" role="alert">
            {error}
          </p>
        )}
      </ConfirmDialog>
    </>
  );
}
