import { BookOpen, Loader2, Sparkles, Upload } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApiConfigRecord, Model } from "../../../preload";
import { useI18n } from "../../i18n";
import { CustomSelect } from "../common/CustomSelect";
import { ApiModelCombobox } from "../sidebar/apiSettings/ApiModelCombobox";

export type RepoWikiSetupValues = {
  language: "zh-CN" | "en";
  apiProfile: string;
  model: string;
  diagrams: boolean;
  retries: number;
};

type RepoWikiSetupCardProps = {
  initialValues: RepoWikiSetupValues;
  isSubmitting: boolean;
  error: string | null;
  submitLabel: string;
  title: string;
  description: string;
  onSubmit: (values: RepoWikiSetupValues) => void;
  onCancel?: () => void;
  /** 空项目可直接从 JSON 导入已有 Wiki */
  onImport?: () => void;
  isImporting?: boolean;
  /** inline：嵌入信息面板的紧凑样式 */
  variant?: "card" | "inline";
};

const RETRY_OPTIONS = [0, 1, 2, 3, 4, 5];

export const RepoWikiSetupCard = ({
  initialValues,
  isSubmitting,
  error,
  submitLabel,
  title,
  description,
  onSubmit,
  onCancel,
  onImport,
  isImporting = false,
  variant = "card",
}: RepoWikiSetupCardProps): React.JSX.Element => {
  const { t } = useI18n();
  const [values, setValues] = useState<RepoWikiSetupValues>(initialValues);
  const [apiConfigs, setApiConfigs] = useState<ApiConfigRecord[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [modelsLoadedFor, setModelsLoadedFor] = useState<string | null>(null);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const modelRequestIdRef = useRef(0);

  useEffect(() => {
    void window.snow
      .listApiConfigs()
      .then(setApiConfigs)
      .catch(() => setApiConfigs([]));
  }, []);

  const activeConfig = useMemo(
    () => apiConfigs.find((config) => config.isActive) ?? apiConfigs[0] ?? null,
    [apiConfigs],
  );
  const selectedConfig = useMemo(
    () =>
      values.apiProfile
        ? (apiConfigs.find(
            (config) => config.profileName === values.apiProfile,
          ) ?? null)
        : activeConfig,
    [activeConfig, apiConfigs, values.apiProfile],
  );

  const loadModels = useCallback(
    async (force = false): Promise<void> => {
      if (!selectedConfig) return;
      const cacheKey = selectedConfig.profileName;
      if (isLoadingModels || (!force && modelsLoadedFor === cacheKey)) return;
      const requestId = ++modelRequestIdRef.current;
      setIsLoadingModels(true);
      setModelsError(null);
      try {
        const available = await window.snow.fetchAvailableModelsForConfig({
          baseUrl: selectedConfig.baseUrl,
          baseUrlMode: selectedConfig.baseUrlMode,
          apiKey: selectedConfig.apiKey,
          requestMethod: selectedConfig.requestMethod,
          customHeaderSchemeId: selectedConfig.customHeaderSchemeId,
          configJson: selectedConfig.configJson.trim() || undefined,
        });
        if (modelRequestIdRef.current !== requestId) return;
        setModels(available);
        setModelsLoadedFor(cacheKey);
      } catch (loadError) {
        if (modelRequestIdRef.current !== requestId) return;
        setModelsError(
          loadError instanceof Error
            ? loadError.message
            : t("chat.loadModelsError", {
                defaultValue: "Failed to load models",
              }),
        );
        setModelsLoadedFor(null);
      } finally {
        if (modelRequestIdRef.current === requestId) {
          setIsLoadingModels(false);
        }
      }
    },
    [isLoadingModels, modelsLoadedFor, selectedConfig, t],
  );

  const handleProfileChange = (profileName: string): void => {
    modelRequestIdRef.current += 1;
    setIsLoadingModels(false);
    setModels([]);
    setModelsLoadedFor(null);
    setModelsError(null);
    setValues((prev) => ({ ...prev, apiProfile: profileName, model: "" }));
  };

  const profileLabel = (config: ApiConfigRecord): string =>
    config.displayName.trim() || config.profileName;

  return (
    <div
      className={`repo-wiki-setup-card${variant === "inline" ? " inline" : ""}`}
    >
      <div className="repo-wiki-setup-head">
        <span className="repo-wiki-setup-icon" aria-hidden="true">
          <BookOpen size={18} />
        </span>
        <div className="repo-wiki-setup-copy">
          <strong>{title}</strong>
          <span>{description}</span>
        </div>
      </div>

      <div className="repo-wiki-setup-grid">
        <label className="repo-wiki-field">
          <span>{t("repoWiki.language", { defaultValue: "Language" })}</span>
          <CustomSelect
            onChange={(language) =>
              setValues((prev) => ({
                ...prev,
                language: language === "en" ? "en" : "zh-CN",
              }))
            }
            options={[
              { value: "zh-CN", label: "简体中文" },
              { value: "en", label: "English" },
            ]}
            value={values.language}
          />
        </label>

        <label className="repo-wiki-field">
          <span>
            {t("repoWiki.apiProfile", { defaultValue: "API config" })}
          </span>
          <CustomSelect
            onChange={handleProfileChange}
            options={[
              {
                value: "",
                label: activeConfig
                  ? t("repoWiki.defaultProfile", {
                      values: { value: profileLabel(activeConfig) },
                      defaultValue: `Default (${profileLabel(activeConfig)})`,
                    })
                  : t("repoWiki.defaultProfileEmpty", {
                      defaultValue: "Default",
                    }),
              },
              ...apiConfigs.map((config) => ({
                value: config.profileName,
                label: profileLabel(config),
              })),
            ]}
            value={values.apiProfile}
          />
        </label>

        <div className="repo-wiki-field repo-wiki-field-wide">
          <ApiModelCombobox
            disabled={!selectedConfig}
            error={modelsError}
            hasLoaded={modelsLoadedFor === selectedConfig?.profileName}
            isLoading={isLoadingModels}
            label={t("repoWiki.model", { defaultValue: "Model" })}
            loadingText={t("settings.loadingModels", {
              defaultValue: "Loading models...",
            })}
            models={models}
            noModelsText={t("chat.noModelsFound", {
              defaultValue: "No models found",
            })}
            onChange={(model) => setValues((prev) => ({ ...prev, model }))}
            onRequestModels={() => void loadModels()}
            onRetry={() => void loadModels(true)}
            placeholder={
              selectedConfig?.advancedModel ||
              t("repoWiki.modelPlaceholder", {
                defaultValue: "Use the advanced model of the config",
              })
            }
            retryText={t("common.retry", { defaultValue: "Retry" })}
            value={values.model}
          />
        </div>

        <label className="repo-wiki-field">
          <span>
            {t("repoWiki.retries", { defaultValue: "Retries per page" })}
          </span>
          <CustomSelect
            onChange={(retries) =>
              setValues((prev) => ({ ...prev, retries: Number(retries) || 0 }))
            }
            options={RETRY_OPTIONS.map((count) => ({
              value: String(count),
              label:
                count === 0
                  ? t("repoWiki.noRetry", { defaultValue: "No retry" })
                  : String(count),
            }))}
            value={String(values.retries)}
          />
        </label>

        <div className="repo-wiki-field repo-wiki-switch-field">
          <span>{t("repoWiki.diagrams", { defaultValue: "Diagrams" })}</span>
          <label className="toggle-switch">
            <input
              aria-label={t("repoWiki.diagrams", { defaultValue: "Diagrams" })}
              checked={values.diagrams}
              onChange={(event) =>
                setValues((prev) => ({
                  ...prev,
                  diagrams: event.target.checked,
                }))
              }
              type="checkbox"
            />
            <span className="toggle-slider" />
            <span>
              {t("repoWiki.diagramsHint", {
                defaultValue: "Mermaid diagrams backed by source",
              })}
            </span>
          </label>
        </div>
      </div>

      {error ? <div className="repo-wiki-error">{error}</div> : null}

      <div className="repo-wiki-setup-actions">
        {onImport ? (
          <button
            className="repo-wiki-btn"
            disabled={isSubmitting || isImporting}
            onClick={onImport}
            title={t("repoWiki.importHint", {
              defaultValue: "Import from a wiki JSON file",
            })}
            type="button"
          >
            {isImporting ? (
              <Loader2 className="spin" size={13} />
            ) : (
              <Upload size={13} />
            )}
            <span>{t("repoWiki.import", { defaultValue: "Import" })}</span>
          </button>
        ) : null}
        {onCancel ? (
          <button
            className="repo-wiki-btn"
            disabled={isSubmitting}
            onClick={onCancel}
            type="button"
          >
            {t("common.cancel", { defaultValue: "Cancel" })}
          </button>
        ) : null}
        <button
          className="repo-wiki-btn primary"
          disabled={isSubmitting || apiConfigs.length === 0}
          onClick={() => onSubmit(values)}
          type="button"
        >
          {isSubmitting ? (
            <Loader2 className="spin" size={13} />
          ) : (
            <Sparkles size={13} />
          )}
          <span>{submitLabel}</span>
        </button>
      </div>
    </div>
  );
};
