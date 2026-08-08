import {
  AlertCircle,
  Clipboard,
  LoaderCircle,
  RefreshCw,
  SquareTerminal,
  Square,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type {
  RemoteJobBinding,
  RemoteJobOutput,
  RemoteJobPtyAttachment,
} from "../../../preload";
import { useI18n } from "../../i18n";

type RemoteJobsPanelContentProps = {
  workspacePath: string;
  isActive: boolean;
  onAttach?: (attachment: RemoteJobPtyAttachment) => void;
};

const terminalStatus = new Set([
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "lost",
  "launch_failed",
  "indeterminate",
]);

const statusClass = (status: RemoteJobBinding["status"]): string =>
  `remote-jobs-status remote-jobs-status-${status}`;

type OutputDecoderState = {
  decoder: TextDecoder;
  nextOffset: number;
  output: string;
};

export function RemoteJobsPanelContent({
  workspacePath,
  isActive,
  onAttach,
}: RemoteJobsPanelContentProps): React.JSX.Element {
  const { t } = useI18n();
  const [jobs, setJobs] = useState<RemoteJobBinding[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RemoteJobOutput | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [startFormOpen, setStartFormOpen] = useState(false);
  const [draftCommand, setDraftCommand] = useState("");
  const [starting, setStarting] = useState(false);
  const outputDecodersRef = useRef(new Map<string, OutputDecoderState>());

  const selectedJob = useMemo(
    () => jobs.find((job) => job.jobId === selectedJobId) ?? null,
    [jobs, selectedJobId]
  );

  const loadDetail = useCallback(async (jobId: string): Promise<void> => {
    const previous = outputDecodersRef.current.get(jobId);
    const result = await window.snow.sshGetRemoteJob(jobId, {
      offset: previous?.nextOffset ?? 0,
      limit: 64 * 1024,
    });
    const decoderState =
      previous && previous.nextOffset === result.offset
        ? previous
        : { decoder: new TextDecoder(), nextOffset: result.offset, output: "" };
    let output = `${decoderState.output}${decoderState.decoder.decode(
      result.outputBytes,
      { stream: !result.eof }
    )}`;
    if (result.eof) {
      output += decoderState.decoder.decode();
    }
    outputDecodersRef.current.set(jobId, {
      decoder: decoderState.decoder,
      nextOffset: result.nextOffset,
      output,
    });
    setDetail({ ...result, output });
    setJobs((current) =>
      current.map((job) => (job.jobId === result.job.jobId ? result.job : job))
    );
  }, []);

  const refresh = useCallback(
    async (preserveSelection = true): Promise<void> => {
      setRefreshing(true);
      setError("");
      try {
        const nextJobs = await window.snow.sshListRemoteJobs(workspacePath);
        setJobs(nextJobs);
        const nextSelected =
          preserveSelection &&
          selectedJobId &&
          nextJobs.some((job) => job.jobId === selectedJobId)
            ? selectedJobId
            : (nextJobs[0]?.jobId ?? null);
        setSelectedJobId(nextSelected);
        if (nextSelected) {
          await loadDetail(nextSelected);
        } else {
          setDetail(null);
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [loadDetail, selectedJobId, workspacePath]
  );

  useEffect(() => {
    setLoading(true);
    setSelectedJobId(null);
    setDetail(null);
    outputDecodersRef.current.clear();
    void refresh(false);
  }, [refresh, workspacePath]);

  useEffect(() => {
    if (!isActive) {
      return;
    }
    const timer = window.setInterval(() => {
      void refresh();
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [isActive, refresh]);

  const selectJob = useCallback(
    (jobId: string): void => {
      setSelectedJobId(jobId);
      setError("");
      outputDecodersRef.current.delete(jobId);
      void loadDetail(jobId).catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    },
    [loadDetail]
  );

  const cancelJob = useCallback(async (): Promise<void> => {
    if (!selectedJob || terminalStatus.has(selectedJob.status)) {
      return;
    }
    setCancelling(true);
    setError("");
    try {
      const cancelled = await window.snow.sshCancelRemoteJob(selectedJob.jobId);
      setJobs((current) =>
        current.map((job) => (job.jobId === cancelled.jobId ? cancelled : job))
      );
      await loadDetail(cancelled.jobId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCancelling(false);
    }
  }, [loadDetail, selectedJob]);

  const copyAnalysisContext = useCallback(async (): Promise<void> => {
    if (!selectedJob) {
      return;
    }
    try {
      const context = await window.snow.sshGetRemoteJobAnalysisContext(
        selectedJob.jobId,
        { offset: 0, limit: 64 * 1024 }
      );
      await navigator.clipboard.writeText(context);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [selectedJob]);

  const attachJob = useCallback(async (): Promise<void> => {
    if (
      !selectedJob ||
      selectedJob.mode !== "interactive" ||
      detail?.state.status !== "running"
    ) {
      return;
    }
    setAttaching(true);
    setError("");
    try {
      const attachment = await window.snow.sshAttachRemoteJob(selectedJob.jobId, {
        cols: 100,
        rows: 30,
      });
      onAttach?.(attachment);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAttaching(false);
    }
  }, [detail?.state.status, onAttach, selectedJob]);

  const startInteractiveJob = useCallback(
    async (event: FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault();
      const command = draftCommand.trim();
      if (!command) {
        return;
      }
      setStarting(true);
      setError("");
      try {
        const job = await window.snow.sshStartRemoteJob({
          workspacePath,
          command,
          mode: "interactive",
        });
        outputDecodersRef.current.delete(job.jobId);
        setJobs((current) => [
          job,
          ...current.filter((currentJob) => currentJob.jobId !== job.jobId),
        ]);
        setSelectedJobId(job.jobId);
        setDetail(null);
        setDraftCommand("");
        setStartFormOpen(false);
        try {
          await loadDetail(job.jobId);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setStarting(false);
      }
    },
    [draftCommand, loadDetail, workspacePath]
  );

  return (
    <section className="remote-jobs-panel">
      <header className="remote-jobs-header">
        <div>
          <h2>{t("remoteJobs.title")}</h2>
          <span className="remote-jobs-workspace" title={workspacePath}>
            {workspacePath.replace(/^ssh:\/\/[^/]+/, "") || "/"}
          </span>
        </div>
        <div className="remote-jobs-header-actions">
          <button
            type="button"
            className="remote-jobs-start-button"
            onClick={() => {
              setError("");
              setStartFormOpen(true);
            }}
            title={t("remoteJobs.startInteractive")}
          >
            <SquareTerminal size={15} />
            <span>{t("remoteJobs.startInteractive")}</span>
          </button>
          <button
            type="button"
            className="remote-jobs-icon-button"
            onClick={() => void refresh()}
            disabled={refreshing}
            title={t("remoteJobs.refresh")}
            aria-label={t("remoteJobs.refresh")}
          >
            <RefreshCw size={15} className={refreshing ? "is-spinning" : ""} />
          </button>
        </div>
      </header>

      {startFormOpen ? (
        <form className="remote-jobs-start-form" onSubmit={startInteractiveJob}>
          <label htmlFor="remote-jobs-interactive-command">
            {t("remoteJobs.command")}
          </label>
          <textarea
            id="remote-jobs-interactive-command"
            value={draftCommand}
            onChange={(event) => setDraftCommand(event.target.value)}
            placeholder={t("remoteJobs.commandPlaceholder")}
            autoFocus
            disabled={starting}
            rows={3}
          />
          <div className="remote-jobs-start-actions">
            <button
              type="button"
              className="remote-jobs-form-button"
              onClick={() => {
                setStartFormOpen(false);
                setDraftCommand("");
              }}
              disabled={starting}
            >
              {t("common.cancel")}
            </button>
            <button
              type="submit"
              className="remote-jobs-form-button primary"
              disabled={starting || !draftCommand.trim()}
            >
              <SquareTerminal size={14} />
              <span>{t("remoteJobs.startInteractive")}</span>
            </button>
          </div>
        </form>
      ) : null}

      {error && (
        <div className="remote-jobs-error" role="alert">
          <AlertCircle size={15} />
          <span>{error}</span>
        </div>
      )}

      <div className="remote-jobs-body">
        <aside className="remote-jobs-list" aria-label={t("remoteJobs.jobList")}>
          {loading ? (
            <div className="remote-jobs-empty">
              <LoaderCircle size={16} className="is-spinning" />
              <span>{t("remoteJobs.loading")}</span>
            </div>
          ) : jobs.length === 0 ? (
            <div className="remote-jobs-empty">{t("remoteJobs.empty")}</div>
          ) : (
            jobs.map((job) => (
              <button
                key={job.jobId}
                type="button"
                className={`remote-jobs-item ${
                  job.jobId === selectedJobId ? "selected" : ""
                }`}
                onClick={() => selectJob(job.jobId)}
              >
                <span className={statusClass(job.status)}>{job.status}</span>
                <span className="remote-jobs-command" title={job.displayCommand}>
                  {job.displayCommand}
                </span>
                <span className="remote-jobs-backend">{job.backend}</span>
              </button>
            ))
          )}
        </aside>

        <div className="remote-jobs-detail">
          {selectedJob && detail ? (
            <>
              <div className="remote-jobs-detail-toolbar">
                <div>
                  <span className={statusClass(detail.state.status)}>
                    {detail.state.status}
                  </span>
                  <span className="remote-jobs-meta">
                    {selectedJob.backend} · {selectedJob.jobId.slice(0, 8)}
                  </span>
                </div>
                <div className="remote-jobs-actions">
                  <button
                    type="button"
                    className="remote-jobs-icon-button"
                    onClick={() => void copyAnalysisContext()}
                    title={t("remoteJobs.copyAnalysis")}
                    aria-label={t("remoteJobs.copyAnalysis")}
                  >
                    <Clipboard size={15} />
                  </button>
                  {selectedJob.mode === "interactive" &&
                  detail.state.status === "running" ? (
                    <button
                      type="button"
                      className="remote-jobs-icon-button"
                      onClick={() => void attachJob()}
                      disabled={attaching}
                      title={t("remoteJobs.attach")}
                      aria-label={t("remoteJobs.attach")}
                    >
                      <SquareTerminal size={15} />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="remote-jobs-icon-button danger"
                    onClick={() => void cancelJob()}
                    disabled={
                      cancelling || terminalStatus.has(detail.state.status)
                    }
                    title={t("remoteJobs.cancel")}
                    aria-label={t("remoteJobs.cancel")}
                  >
                    <Square size={14} fill="currentColor" />
                  </button>
                </div>
              </div>
              <pre className="remote-jobs-output">
                {detail.output || t("remoteJobs.noOutput")}
              </pre>
            </>
          ) : (
            <div className="remote-jobs-empty">{t("remoteJobs.selectJob")}</div>
          )}
        </div>
      </div>
    </section>
  );
}
