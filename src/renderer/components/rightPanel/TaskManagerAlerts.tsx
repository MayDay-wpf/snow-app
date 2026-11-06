import { useEffect, useRef, useState } from "react";
import { Bell } from "lucide-react";
import { useI18n } from "../../i18n";
import { AutoDismissNotice } from "../AutoDismissNotice";
import {
  advanceUsageAlerts,
  alertOptionsValid,
  CONTINUOUS_SAMPLE_GAP_MS,
  emptyUsageAlerts,
  type AlertOptions,
  type UsageAlerts,
  type UsageSample,
} from "./taskManagerMonitoring";

type Props = {
  options: AlertOptions;
  onOptionsChange: (next: AlertOptions) => void;
  alerts: UsageAlerts;
  onDismiss: (metric: "cpu" | "memory") => void;
  samplingActive: boolean;
  valid: boolean;
  /** settings: settings panel only. notice-only: inline notice banners only. */
  mode: "settings" | "notice-only";
};

type HookArgs = {
  samples: UsageSample[];
  scopeKey: string;
  continuity: number;
  samplingActive: boolean;
  valid: boolean;
  /** Fired once per alert episode, when a metric newly becomes active and system notifications are enabled. */
  onTriggered: (metric: "cpu" | "memory", rule: AlertOptions) => void;
};

type AlertTranslate = ReturnType<typeof useI18n>["t"];

/** Shared wording for the inline banner and the system notification. */
export const alertTriggeredText = (
  t: AlertTranslate,
  metric: "cpu" | "memory",
  rule: AlertOptions,
): string =>
  t("taskManager.alertTriggered", {
    values: {
      metric: t(
        metric === "cpu"
          ? "taskManager.visibleCpu"
          : "taskManager.visibleMemory",
      ),
      threshold:
        metric === "cpu" ? `${rule.cpuPercent}%` : `${rule.memoryMiB} MiB`,
      duration: rule.durationSecs,
    },
  });

const DEFAULT_ALERT_OPTIONS: AlertOptions = {
  enabled: false,
  cpuPercent: 70,
  memoryMiB: 1024,
  durationSecs: 10,
  systemNotify: false,
};

/** 告警提示停留时长：够读完一句阈值说明，与系统通知互不影响 */
const ALERT_NOTICE_DURATION_MS = 6000;

/**
 * One monitoring instance per panel: both the settings form and the alert
 * notice render from this state, so they can never diverge. Ephemeral
 * preferences only - no automatic termination or config writes.
 */
export function useUsageAlerts({
  samples,
  scopeKey,
  continuity,
  samplingActive,
  valid,
  onTriggered,
}: HookArgs): {
  options: AlertOptions;
  setOptions: (next: AlertOptions) => void;
  alerts: UsageAlerts;
  dismiss: (metric: "cpu" | "memory") => void;
} {
  const [options, setOptions] = useState<AlertOptions>(DEFAULT_ALERT_OPTIONS);
  const [alerts, setAlerts] = useState<UsageAlerts>(emptyUsageAlerts);
  const alertsRef = useRef<UsageAlerts>(emptyUsageAlerts());
  const consumedAtRef = useRef(0);
  const latest = samples.at(-1);
  useEffect(() => {
    alertsRef.current = emptyUsageAlerts();
    consumedAtRef.current = latest?.atMs ?? 0;
    setAlerts(alertsRef.current);
    // The current sample predates this configuration/continuity boundary; do not reuse it.
    // Only thresholds and the enable switch are continuity boundaries; toggling
    // system notifications must not clear an active or dismissed alert.
  }, [
    options.enabled,
    options.cpuPercent,
    options.memoryMiB,
    options.durationSecs,
    scopeKey,
    continuity,
    samplingActive,
    valid,
  ]);
  useEffect(() => {
    if (!latest || latest.atMs <= consumedAtRef.current) return;
    consumedAtRef.current = latest.atMs;
    if (!samplingActive || !valid) return;
    const previous = alertsRef.current;
    const next = advanceUsageAlerts(previous, latest, options);
    alertsRef.current = next;
    setAlerts(next);
    if (!options.systemNotify) return;
    for (const metric of ["cpu", "memory"] as const) {
      if (next[metric].active && !previous[metric].active) {
        onTriggered(metric, options);
      }
    }
  }, [latest, options, samplingActive, valid, onTriggered]);
  useEffect(() => {
    if (!latest || !options.enabled || !samplingActive || !valid) return;
    const reset = (): void => {
      alertsRef.current = emptyUsageAlerts();
      setAlerts(alertsRef.current);
    };
    const remaining = latest.atMs + CONTINUOUS_SAMPLE_GAP_MS + 1 - Date.now();
    if (remaining <= 0) {
      reset();
      return;
    }
    const timer = window.setTimeout(reset, remaining);
    return () => window.clearTimeout(timer);
  }, [latest, options.enabled, samplingActive, valid]);
  const dismiss = (metric: "cpu" | "memory"): void => {
    alertsRef.current = {
      ...alertsRef.current,
      [metric]: { ...alertsRef.current[metric], dismissed: true },
    };
    setAlerts(alertsRef.current);
  };
  return { options, setOptions, alerts, dismiss };
}

/**
 * A single monitoring instance owns the state; every surface renders from it.
 * The settings form is uncontrolled input-wise but fully driven by the caller's
 * options/alerts so the alert notice and the settings panel never diverge.
 */
export function TaskManagerAlerts({
  options,
  onOptionsChange,
  alerts,
  onDismiss,
  samplingActive,
  valid,
  mode,
}: Props): React.JSX.Element {
  const { t } = useI18n();
  const configValid = alertOptionsValid(options);
  const update = (patch: Partial<AlertOptions>): void =>
    onOptionsChange({ ...options, ...patch });
  const fields = [
    ["cpuPercent", "taskManager.alertCpu", 0, 100, 1],
    ["memoryMiB", "taskManager.alertMemory", 1, 1048576, 1],
    ["durationSecs", "taskManager.alertDuration", 3, 120, 1],
  ] as const;
  // CPU 与内存同时触发时依次提示：共用 AutoDismissNotice 的顶部浮层，避免重叠
  const pendingMetric = (["cpu", "memory"] as const).find(
    (metric) => alerts[metric].active && !alerts[metric].dismissed,
  );
  return (
    <>
      {mode === "settings" && (
        <section className="task-manager-card-section task-manager-alert-settings">
          <div className="task-manager-section-header">
            <Bell size={14} aria-hidden="true" />
            <strong>{t("taskManager.alertTitle")}</strong>
            <span className="task-manager-badge">
              {t(
                options.enabled
                  ? "taskManager.alertEnabled"
                  : "taskManager.alertDisabled",
              )}
            </span>
          </div>
          <div className="task-manager-alert-body">
            <label className="toggle-switch task-manager-alert-enable">
              <input
                type="checkbox"
                checked={options.enabled}
                onChange={(event) => update({ enabled: event.target.checked })}
              />
              <span className="toggle-slider" />
              <span>{t("taskManager.alertEnable")}</span>
            </label>
            <label className="toggle-switch task-manager-alert-enable">
              <input
                type="checkbox"
                checked={options.systemNotify}
                onChange={(event) =>
                  update({ systemNotify: event.target.checked })
                }
              />
              <span className="toggle-slider" />
              <span>{t("taskManager.alertSystemNotify")}</span>
            </label>
            <p className="task-manager-hint">{t("taskManager.alertHint")}</p>
            <div className="task-manager-budget-fields">
              {fields.map(([key, label, min, max, step]) => (
                <label key={key}>
                  <span>{t(label)}</span>
                  <input
                    type="number"
                    data-alert-field={key}
                    min={min}
                    max={max}
                    step={step}
                    value={Number.isFinite(options[key]) ? options[key] : ""}
                    onChange={(event) =>
                      update({
                        [key]:
                          event.target.value === ""
                            ? NaN
                            : Number(event.target.value),
                      })
                    }
                  />
                  <small>
                    {min}–{max}
                  </small>
                </label>
              ))}
            </div>
            {!configValid && (
              <p className="task-manager-error" role="status">
                {t("taskManager.alertInvalid")}
              </p>
            )}
            {options.enabled && configValid && (
              <p className="task-manager-hint">
                {t("taskManager.alertRules", {
                  values: {
                    cpu: options.cpuPercent,
                    memory: options.memoryMiB,
                    duration: options.durationSecs,
                  },
                })}
              </p>
            )}
            {options.enabled && (
              <p className="task-manager-hint">
                {t(
                  samplingActive && valid
                    ? "taskManager.alertMonitoring"
                    : "taskManager.alertWaiting",
                )}
              </p>
            )}
          </div>
        </section>
      )}
      {mode === "notice-only" && pendingMetric && (
        <AutoDismissNotice
          message={alertTriggeredText(t, pendingMetric, options)}
          tone="warning"
          durationMs={ALERT_NOTICE_DURATION_MS}
          onDismiss={() => onDismiss(pendingMetric)}
        />
      )}
    </>
  );
}
