import { useEffect, useRef, useState } from "react";
import type { LspResourcePolicy } from "../../../../preload/types/lsp";
import { useI18n } from "../../../i18n";
import { ApiSettingsHintIcon } from "../apiSettings/ApiSettingsFieldLabel";

/** Budget editor only: monitoring belongs to the task manager's shared refresh cycle. */
export function LspResourcePanel({
  isActive,
}: {
  isActive: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const [policy, setPolicy] = useState<LspResourcePolicy | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const savingRef = useRef(false);
  useEffect(() => {
    if (!isActive || policy) return;
    let disposed = false;
    setError("");
    void window.snow
      .getLspResourcePolicy()
      .then((value) => {
        if (!disposed) setPolicy(value);
      })
      .catch(() => {
        if (!disposed) setError(t("taskManager.budgetLoadError"));
      });
    return () => {
      disposed = true;
    };
  }, [isActive, policy, loadAttempt, t]);
  const fields = [
    ["maxSessions", 1, 32],
    ["idleTimeoutSecs", 60, 86400],
    ["maxConcurrentStarts", 1, 8],
  ] as const;
  const valid =
    policy &&
    fields.every(
      ([key, min, max]) =>
        Number.isInteger(policy[key]) &&
        policy[key] >= min &&
        policy[key] <= max,
    );
  const save = async (): Promise<void> => {
    if (!isActive || !policy || !valid || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      setPolicy(await window.snow.setLspResourcePolicy(policy));
      setSaved(true);
    } catch {
      setError(t("taskManager.budgetSaveError"));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  return (
    <section className="task-manager-budget">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="task-manager-budget-fields">
          {fields.map(([key, min, max]) => (
            <label key={key}>
              <span>
                {t(`lsp.resources.${key}`)}
                <ApiSettingsHintIcon
                  hint={t("taskManager.fieldRange", {
                    values: { min, max },
                  })}
                />
              </span>
              <input
                type="number"
                min={min}
                max={max}
                step={1}
                required
                disabled={!isActive || !policy || saving}
                value={
                  policy && Number.isFinite(policy[key]) ? policy[key] : ""
                }
                onChange={(event) => {
                  setSaved(false);
                  setPolicy((current) =>
                    current
                      ? {
                          ...current,
                          [key]:
                            event.target.value === ""
                              ? NaN
                              : Number(event.target.value),
                        }
                      : current,
                  );
                }}
              />
            </label>
          ))}
        </div>
        <button
          className="task-manager-refresh-btn task-manager-budget-save"
          type="submit"
          disabled={!isActive || !valid || saving}
        >
          {saving ? t("taskManager.savingBudget") : t("lsp.resources.save")}
        </button>
      </form>
      {!policy && !error && (
        <p role="status">{t("taskManager.loadingBudget")}</p>
      )}
      {error && (
        <p className="task-manager-error" role="alert">
          {error}
        </p>
      )}
      {!policy && error && (
        <button
          className="task-manager-refresh-btn"
          type="button"
          disabled={!isActive}
          onClick={() => setLoadAttempt((value) => value + 1)}
        >
          {t("taskManager.refresh")}
        </button>
      )}
      {saved && <p role="status">{t("taskManager.budgetSaved")}</p>}
    </section>
  );
}
