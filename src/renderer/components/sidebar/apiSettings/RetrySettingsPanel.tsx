import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../../../i18n";
import { AutoDismissNotice } from "../../AutoDismissNotice";
import {
  ApiSettingsFieldLabel,
  ApiSettingsHintIcon,
} from "./ApiSettingsFieldLabel";
import {
  parseRetryPolicy,
  serializeRetryPolicy,
  type RetryConfigState,
} from "./apiSettingsUtils";

const RETRY_POLICY_SETTING_NAME = "Retry policy";
const RETRY_POLICY_SETTING_CODE = "retry_policy";
const AUTO_SAVE_DELAY_MS = 400;

type RetryDefaultCategory = { id: string; keywords: string[] };

const CATEGORY_LABELS: Record<string, { key: string; defaultValue: string }> = {
  overloaded: {
    key: "settings.retryCategoryOverloaded",
    defaultValue: "Overloaded (529)",
  },
  network: {
    key: "settings.retryCategoryNetwork",
    defaultValue: "Network",
  },
  rateLimit: {
    key: "settings.retryCategoryRateLimit",
    defaultValue: "Rate limit (429)",
  },
  serverError: {
    key: "settings.retryCategoryServerError",
    defaultValue: "Server error (5xx)",
  },
  unavailable: {
    key: "settings.retryCategoryUnavailable",
    defaultValue: "Service unavailable",
  },
  terminated: {
    key: "settings.retryCategoryTerminated",
    defaultValue: "Connection terminated",
  },
  stream: {
    key: "settings.retryCategoryStream",
    defaultValue: "Stream errors",
  },
  idleTimeout: {
    key: "settings.retryCategoryIdleTimeout",
    defaultValue: "Stream idle timeout",
  },
  nonSse: {
    key: "settings.retryCategoryNonSse",
    defaultValue: "Non-SSE response",
  },
  emptyResponse: {
    key: "settings.retryCategoryEmptyResponse",
    defaultValue: "Empty response (no content or tool calls)",
  },
};

const parseDefaults = (raw: string): RetryDefaultCategory[] => {
  try {
    const parsed = JSON.parse(raw) as { categories?: unknown };
    if (!Array.isArray(parsed.categories)) return [];
    return parsed.categories.flatMap((item) => {
      if (
        typeof item !== "object" ||
        item === null ||
        typeof (item as { id?: unknown }).id !== "string" ||
        !Array.isArray((item as { keywords?: unknown }).keywords)
      ) {
        return [];
      }
      const category = item as { id: string; keywords: unknown[] };
      return [
        {
          id: category.id,
          keywords: category.keywords.filter(
            (keyword): keyword is string => typeof keyword === "string",
          ),
        },
      ];
    });
  } catch {
    return [];
  }
};

const buildDraftState = (
  raw: string | null,
  defaults: RetryDefaultCategory[],
): RetryConfigState => {
  const stored = parseRetryPolicy(raw);
  const categories: RetryConfigState["categories"] = {};
  for (const category of defaults) {
    const saved = stored.categories[category.id];
    categories[category.id] = {
      enabled: saved?.enabled ?? true,
      keywords: saved?.keywords.trim()
        ? saved.keywords
        : category.keywords.join(", "),
    };
  }
  return {
    always: stored.always,
    categories,
    customKeywords: stored.customKeywords,
  };
};

export function RetrySettingsPanel(): React.JSX.Element {
  const { t } = useI18n();
  const [defaults, setDefaults] = useState<RetryDefaultCategory[]>([]);
  const [draft, setDraft] = useState<RetryConfigState | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const saveTimerRef = useRef<number | null>(null);
  const pendingStateRef = useRef<RetryConfigState | null>(null);

  const persist = useCallback(
    async (state: RetryConfigState): Promise<void> => {
      try {
        await window.snow.setSystemSetting(
          RETRY_POLICY_SETTING_NAME,
          RETRY_POLICY_SETTING_CODE,
          serializeRetryPolicy(state),
        );
        pendingStateRef.current = null;
        setError("");
        setStatus(
          t("settings.retrySaveSuccess", {
            defaultValue: "Retry settings saved.",
          }),
        );
      } catch (e) {
        setError(
          e instanceof Error
            ? e.message
            : t("settings.retrySaveError", {
                defaultValue: "Failed to save retry settings",
              }),
        );
      }
    },
    [t],
  );

  const load = useCallback(async () => {
    setIsLoading(true);
    setError("");
    try {
      const [policyRaw, defaultsJson] = await Promise.all([
        window.snow.getSystemSettingValue(RETRY_POLICY_SETTING_CODE),
        window.snow.getRetryDefaults(),
      ]);
      const parsedDefaults = parseDefaults(defaultsJson);
      setDefaults(parsedDefaults);
      setDraft(buildDraftState(policyRaw, parsedDefaults));
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.retryLoadError", {
              defaultValue: "Failed to load retry settings",
            }),
      );
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        const pending = pendingStateRef.current;
        if (pending) {
          void window.snow.setSystemSetting(
            RETRY_POLICY_SETTING_NAME,
            RETRY_POLICY_SETTING_CODE,
            serializeRetryPolicy(pending),
          );
        }
      }
    };
  }, []);

  const applyDraft = (
    updater: (previous: RetryConfigState) => RetryConfigState,
  ): void => {
    if (!draft) return;
    const next = updater(draft);
    setDraft(next);
    pendingStateRef.current = next;
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void persist(next);
    }, AUTO_SAVE_DELAY_MS);
  };

  const updateCategory = (categoryId: string, keywords: string): void => {
    applyDraft((previous) => ({
      ...previous,
      categories: {
        ...previous.categories,
        [categoryId]: {
          enabled: previous.categories[categoryId]?.enabled ?? true,
          keywords,
        },
      },
    }));
  };

  const toggleCategory = (categoryId: string, enabled: boolean): void => {
    applyDraft((previous) => ({
      ...previous,
      categories: {
        ...previous.categories,
        [categoryId]: {
          enabled,
          keywords:
            previous.categories[categoryId]?.keywords ??
            defaults
              .find((item) => item.id === categoryId)
              ?.keywords.join(", ") ??
            "",
        },
      },
    }));
  };

  const busy = isLoading;

  return (
    <>
      <div className="api-settings-manual-header">
        <strong>
          {t("settings.retryPanelTitle", { defaultValue: "Retry policy" })}
          <ApiSettingsHintIcon
            hint={t("settings.retryPanelInfo", {
              defaultValue:
                "Configure which errors are retried. Applies to all API profiles. Changes are saved automatically.",
            })}
          />
        </strong>
      </div>

      <div className="api-settings-form-body">
        <div className="api-settings-form-section">
          <strong className="api-settings-form-section-title">
            {t("settings.retryGeneralTitle", { defaultValue: "General" })}
          </strong>
          <div className="api-settings-form-grid">
            <div className="api-settings-field">
              <ApiSettingsFieldLabel
                hint={t("settings.retryAlwaysHint", {
                  defaultValue:
                    "When enabled, any error is retried regardless of the categories below. The retry count is still capped by Max retries, and aborted or cancelled requests are never retried.",
                })}
              >
                {t("settings.retryAlways", { defaultValue: "Retry any error" })}
              </ApiSettingsFieldLabel>
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={draft?.always ?? false}
                  onChange={(event) =>
                    applyDraft((previous) => ({
                      ...previous,
                      always: event.target.checked,
                    }))
                  }
                  disabled={busy || !draft}
                  hidden
                />
                <span className="toggle-slider" />
                <span>
                  {draft?.always
                    ? t("settings.enabled", { defaultValue: "Enabled" })
                    : t("settings.disabled", { defaultValue: "Disabled" })}
                </span>
              </label>
            </div>
          </div>
        </div>

        {!draft?.always && (
          <div className="api-settings-form-section">
            <strong className="api-settings-form-section-title">
              {t("settings.retryCategoriesTitle", {
                defaultValue: "Retryable error categories",
              })}
            </strong>
            <div className="api-settings-form-grid">
              {defaults.map((category) => {
                const label = CATEGORY_LABELS[category.id];
                const state = draft?.categories[category.id];
                return (
                  <div className="api-settings-field wide" key={category.id}>
                    <span>
                      {label
                        ? t(label.key, { defaultValue: label.defaultValue })
                        : category.id}
                    </span>
                    {/* 条件型类别（如 emptyResponse）没有关键词，只渲染开关：
                        关键词对它没有任何作用，显示一个永远为空的输入框只会误导。 */}
                    {category.keywords.length > 0 ? (
                      <input
                        value={state?.keywords ?? ""}
                        placeholder={category.keywords.join(", ")}
                        onChange={(event) =>
                          updateCategory(category.id, event.target.value)
                        }
                        disabled={busy || !draft}
                      />
                    ) : null}
                    <label className="toggle-switch">
                      <input
                        type="checkbox"
                        checked={state?.enabled ?? true}
                        onChange={(event) =>
                          toggleCategory(category.id, event.target.checked)
                        }
                        disabled={busy || !draft}
                        hidden
                      />
                      <span className="toggle-slider" />
                      <span>
                        {state?.enabled !== false
                          ? t("settings.enabled", { defaultValue: "Enabled" })
                          : t("settings.disabled", {
                              defaultValue: "Disabled",
                            })}
                      </span>
                    </label>
                  </div>
                );
              })}
              <label className="api-settings-field wide">
                <ApiSettingsFieldLabel
                  hint={t("settings.retryCustomKeywordsHint", {
                    defaultValue:
                      "Comma-separated keywords matched against the error message in addition to all enabled categories above. Matching is a case-insensitive substring test; leave a category empty to restore its defaults. Aborted or cancelled requests are never retried.",
                  })}
                >
                  {t("settings.retryCustomKeywords", {
                    defaultValue: "Extra keywords",
                  })}
                </ApiSettingsFieldLabel>
                <input
                  value={draft?.customKeywords ?? ""}
                  placeholder="quota exceeded, billing"
                  onChange={(event) =>
                    applyDraft((previous) => ({
                      ...previous,
                      customKeywords: event.target.value,
                    }))
                  }
                  disabled={busy || !draft}
                />
              </label>
            </div>
          </div>
        )}

        <AutoDismissNotice
          message={error || status}
          tone={error ? "error" : "success"}
          onDismiss={() => {
            setError("");
            setStatus("");
          }}
        />
      </div>
    </>
  );
}
