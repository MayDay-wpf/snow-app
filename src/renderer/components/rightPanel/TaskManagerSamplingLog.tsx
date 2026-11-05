import { useEffect, useRef, useState } from "react";
import { FileClock } from "lucide-react";
import type { ProcessSamplingLogState } from "../../../preload/types/taskManager";
import { useI18n } from "../../i18n";
import { DisplayPath } from "../common/DisplayPath";

const INTERVAL_MIN_SECS = 5;
const INTERVAL_MAX_SECS = 3600;
const INTERVAL_DEFAULT_SECS = 60;

const parseInterval = (text: string): number | null => {
  const value = Number(text.trim());
  return Number.isInteger(value) &&
    value >= INTERVAL_MIN_SECS &&
    value <= INTERVAL_MAX_SECS
    ? value
    : null;
};

/** 进程采样日志：全局开关与采样间隔，由主进程定时写入，与面板是否打开无关。 */
export function TaskManagerSamplingLog(): React.JSX.Element {
  const { t } = useI18n();
  const [state, setState] = useState<ProcessSamplingLogState | null>(null);
  const [intervalText, setIntervalText] = useState(
    String(INTERVAL_DEFAULT_SECS),
  );
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  useEffect(() => {
    let disposed = false;
    window.snow
      .getProcessSamplingLog()
      .then((value) => {
        if (disposed) return;
        setState(value);
        setIntervalText(String(value.intervalSecs));
      })
      .catch(() => {
        if (!disposed) setError(t("taskManager.samplingLoadError"));
      });
    return () => {
      disposed = true;
    };
  }, [t]);

  const parsed = parseInterval(intervalText);

  const save = async (
    enabled: boolean,
    intervalSecs: number,
  ): Promise<void> => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError("");
    try {
      const next = await window.snow.setProcessSamplingLog({
        enabled,
        intervalSecs,
      });
      setState(next);
      setIntervalText(String(next.intervalSecs));
    } catch {
      setError(t("taskManager.samplingSaveError"));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const commitInterval = (): void => {
    if (!state || parsed === null || parsed === state.intervalSecs) return;
    void save(state.enabled, parsed);
  };

  const enabled = state?.enabled ?? false;
  const controlsDisabled = !state || saving;

  return (
    <section className="task-manager-card-section task-manager-sampling-log">
      <div className="task-manager-section-header">
        <FileClock size={14} aria-hidden="true" />
        <strong>{t("taskManager.samplingTitle")}</strong>
        <span className="task-manager-badge">
          {t(
            enabled ? "taskManager.alertEnabled" : "taskManager.alertDisabled",
          )}
        </span>
      </div>
      <div className="task-manager-sampling-body">
        <label className="toggle-switch task-manager-alert-enable">
          <input
            type="checkbox"
            checked={enabled}
            disabled={controlsDisabled}
            onChange={(event) =>
              void save(
                event.target.checked,
                parsed ?? state?.intervalSecs ?? INTERVAL_DEFAULT_SECS,
              )
            }
          />
          <span className="toggle-slider" />
          <span>{t("taskManager.samplingEnable")}</span>
        </label>
        <label className="task-manager-sampling-interval">
          <span>{t("taskManager.samplingInterval")}</span>
          <input
            type="number"
            inputMode="numeric"
            min={INTERVAL_MIN_SECS}
            max={INTERVAL_MAX_SECS}
            step={1}
            value={intervalText}
            disabled={controlsDisabled}
            aria-invalid={parsed === null}
            onChange={(event) => setIntervalText(event.target.value)}
            onBlur={commitInterval}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitInterval();
            }}
          />
          <small>{t("taskManager.samplingIntervalHint")}</small>
        </label>
        {parsed === null && (
          <p className="task-manager-error" role="status">
            {t("taskManager.samplingInvalid")}
          </p>
        )}
        {error && (
          <p className="task-manager-error" role="alert">
            {error}
          </p>
        )}
        {state && (
          <div className="task-manager-sampling-directory">
            <span>{t("taskManager.samplingFile")}</span>
            <DisplayPath path={state.filePath} />
          </div>
        )}
        <p className="task-manager-hint">{t("taskManager.samplingHint")}</p>
      </div>
    </section>
  );
}
