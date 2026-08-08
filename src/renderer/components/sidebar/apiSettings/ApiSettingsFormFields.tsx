import { useCallback, useEffect, useState, type ChangeEvent } from "react";
import { Eye, EyeOff } from "lucide-react";
import { useI18n } from "../../../i18n";
import { ApiModelCombobox } from "./ApiModelCombobox";
import { CustomSelect } from "../../common/CustomSelect";
import { SystemPromptSelect } from "./SystemPromptSelect";
import {
  DEFAULT_API_BASE_URL,
  DISABLED_STATUS_LABEL,
  ENABLED_STATUS_LABEL,
  REQUEST_METHODS,
} from "./apiSettingsConstants";
import { THINKING_OPTIONS_BY_METHOD } from "../../mainContent/chatInput/constants";
import {
  AUTO_COMPRESS_THRESHOLD_MAX_PERCENT,
  AUTO_COMPRESS_THRESHOLD_MIN_PERCENT,
  AUTO_COMPRESS_THRESHOLD_STEP_PERCENT,
  calculateAutoCompressThresholdTokens,
  normalizeAutoCompressThresholdPercent,
} from "./autoCompressThreshold";
import { resolveThinkingValue } from "./apiSettingsUtils";
import type {
  Model,
  SystemPromptItemRecord,
  CustomHeaderSchemeRecord,
} from "../../../../preload";
import type { ApiConfigFormData } from "./types";

type ModelField = "advancedModel" | "basicModel";

type TokenPreset = {
  value: string;
  label: string;
};

// 基于 2026 年主流模型能力整理的数值档位；仅展示规格，不绑定模型名称。
const CONTEXT_TOKEN_PRESETS: TokenPreset[] = [
  { value: "128000", label: "128K" },
  { value: "204800", label: "200K" },
  { value: "262144", label: "256K" },
  { value: "400000", label: "400K" },
  { value: "500000", label: "500K" },
  { value: "1000000", label: "1M" },
  { value: "1048576", label: "1M (1,048,576)" },
  { value: "1050000", label: "1.05M" },
];

const OUTPUT_TOKEN_PRESETS: TokenPreset[] = [
  { value: "16384", label: "16K" },
  { value: "32768", label: "32K" },
  { value: "65536", label: "64K" },
  { value: "128000", label: "128K" },
  { value: "131072", label: "128K (131,072)" },
  { value: "262144", label: "256K" },
  { value: "384000", label: "384K" },
  { value: "500000", label: "500K" },
];

type ApiSettingsFormFieldsProps = {
  data: ApiConfigFormData;
  onChange: (field: keyof ApiConfigFormData, value: string | boolean) => void;
  disabled: boolean;
  isNew: boolean;
};

export function ApiSettingsFormFields({
  data,
  onChange,
  disabled,
  isNew,
}: ApiSettingsFormFieldsProps): React.JSX.Element {
  const { t } = useI18n();
  const [showApiKey, setShowApiKey] = useState(false);
  const [showVisionKey, setShowVisionKey] = useState(false);
  const [modelOptions, setModelOptions] = useState<Model[]>([]);
  const [isLoadingModelOptions, setIsLoadingModelOptions] = useState(false);
  const [modelOptionsError, setModelOptionsError] = useState<string | null>(
    null
  );
  const [loadedModelOptionsKey, setLoadedModelOptionsKey] = useState<
    string | null
  >(null);
  const [systemPrompts, setSystemPrompts] = useState<SystemPromptItemRecord[]>(
    []
  );
  const [customHeaderSchemes, setCustomHeaderSchemes] = useState<
    CustomHeaderSchemeRecord[]
  >([]);

  const loadBindingOptions = useCallback(async () => {
    try {
      const [prompts, schemes] = await Promise.all([
        window.snow.listSystemPrompts(),
        window.snow.listCustomHeaderSchemes(),
      ]);
      setSystemPrompts(prompts);
      setCustomHeaderSchemes(schemes);
    } catch {
      // ignore – binding selectors will just show empty option lists
    }
  }, []);

  useEffect(() => {
    void loadBindingOptions();
  }, [loadBindingOptions]);

  // When the request method changes, the set of valid thinking-strength options
  // changes with it. If the current value is not among the new method's options,
  // reset it to the default so the dropdown never shows an invalid selection.
  useEffect(() => {
    const resolved = resolveThinkingValue(
      data.thinkingValue,
      data.requestMethod
    );
    if (resolved !== data.thinkingValue) {
      onChange("thinkingValue", resolved);
    }
  }, [data.requestMethod, data.thinkingValue, onChange]);

  const loadModelOptions = useCallback(
    async (force = false) => {
      const configKey = [
        data.baseUrl.trim(),
        data.baseUrlMode.trim(),
        data.apiKey.trim(),
        data.requestMethod.trim(),
        data.customHeaderSchemeId.trim(),
      ].join("\n");

      if (
        isLoadingModelOptions ||
        (!force && loadedModelOptionsKey === configKey)
      ) {
        return;
      }

      setIsLoadingModelOptions(true);
      setModelOptionsError(null);

      try {
        const availableModels = await window.snow.fetchAvailableModelsForConfig(
          {
            baseUrl: data.baseUrl,
            baseUrlMode: data.baseUrlMode,
            apiKey: data.apiKey,
            requestMethod: data.requestMethod,
            customHeaderSchemeId: data.customHeaderSchemeId,
          }
        );
        setModelOptions(availableModels);
        setLoadedModelOptionsKey(configKey);
      } catch (error) {
        setModelOptionsError(
          error instanceof Error
            ? error.message
            : t("chat.loadModelsError", {
                defaultValue: "Failed to load models",
              })
        );
        setLoadedModelOptionsKey(null);
      } finally {
        setIsLoadingModelOptions(false);
      }
    },
    [
      data.apiKey,
      data.baseUrl,
      data.baseUrlMode,
      data.customHeaderSchemeId,
      data.requestMethod,
      isLoadingModelOptions,
      loadedModelOptionsKey,
      t,
    ]
  );

  const handleModelInputFocus = useCallback(() => {
    void loadModelOptions();
  }, [loadModelOptions]);

  const handleRetryModelOptions = useCallback(() => {
    void loadModelOptions(true);
  }, [loadModelOptions]);

  const changeField =
    (field: keyof ApiConfigFormData) =>
    (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      const value =
        event.target instanceof HTMLInputElement &&
        event.target.type === "checkbox"
          ? event.target.checked
          : event.target.value;
      onChange(field, value);
    };

  const autoCompressThresholdPercent = normalizeAutoCompressThresholdPercent(
    data.autoCompressThreshold
  );
  const autoCompressThresholdTokens = calculateAutoCompressThresholdTokens(
    data.maxContextTokens,
    autoCompressThresholdPercent
  );

  const renderModelField = (
    field: ModelField,
    label: string,
    placeholder: string
  ) => (
    <ApiModelCombobox
      label={label}
      value={data[field]}
      placeholder={placeholder}
      disabled={disabled}
      models={modelOptions}
      isLoading={isLoadingModelOptions}
      error={modelOptionsError}
      hasLoaded={Boolean(loadedModelOptionsKey)}
      loadingText={t("settings.loadingModels", {
        defaultValue: "Loading models...",
      })}
      noModelsText={t("chat.noModelsFound", {
        defaultValue: "No models found",
      })}
      retryText={t("common.retry", { defaultValue: "Retry" })}
      onChange={(value) => onChange(field, value)}
      onRequestModels={handleModelInputFocus}
      onRetry={handleRetryModelOptions}
    />
  );

  return (
    <div className="api-settings-form-body">
      <div className="api-settings-form-section">
        <strong className="api-settings-form-section-title">
          {t("settings.formBasic", { defaultValue: "Basic" })}
        </strong>
        <div className="api-settings-form-grid">
          {isNew && (
            <label className="api-settings-field">
              <span>
                {t("settings.apiProfileName", { defaultValue: "Profile name" })}
              </span>
              <input
                value={data.profileName}
                onChange={changeField("profileName")}
                placeholder="openai"
                required
                disabled={disabled}
              />
            </label>
          )}
          <label className="api-settings-field">
            <span>
              {t("settings.apiDisplayName", { defaultValue: "Display name" })}
            </span>
            <input
              value={data.displayName}
              onChange={changeField("displayName")}
              placeholder={data.profileName}
              disabled={disabled}
            />
          </label>
          <label className="api-settings-field wide">
            <span>
              {t("settings.apiBaseUrl", { defaultValue: "Base URL" })}
            </span>
            <input
              value={data.baseUrl}
              onChange={changeField("baseUrl")}
              placeholder={DEFAULT_API_BASE_URL}
              disabled={disabled}
            />
          </label>
          <label className="api-settings-field">
            <span>
              {t("settings.apiBaseUrlMode", { defaultValue: "Base URL mode" })}
            </span>
            <CustomSelect
              value={data.baseUrlMode}
              options={[
                { value: "auto", label: "auto" },
                { value: "custom", label: "custom" },
              ]}
              onChange={(value) => onChange("baseUrlMode", value)}
              disabled={disabled}
            />
          </label>
          <label className="api-settings-field">
            <span>{t("settings.apiKey", { defaultValue: "API key" })}</span>
            <div className="api-settings-password-wrap">
              <input
                value={data.apiKey}
                onChange={changeField("apiKey")}
                placeholder="sk-..."
                type={showApiKey ? "text" : "password"}
                disabled={disabled}
              />
              <button
                type="button"
                className="api-settings-password-toggle"
                onClick={() => setShowApiKey((value) => !value)}
                tabIndex={-1}
              >
                {showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </label>
          <label className="api-settings-field">
            <span>
              {t("settings.apiRequestMethod", {
                defaultValue: "Request method",
              })}
            </span>
            <CustomSelect
              value={data.requestMethod}
              options={REQUEST_METHODS.map((method) => ({
                value: method,
                label: method,
              }))}
              onChange={(value) => onChange("requestMethod", value)}
              disabled={disabled}
            />
          </label>
          <label className="api-settings-field">
            <span>
              {t("chat.thinkingStrength", {
                defaultValue: "Thinking strength",
              })}
            </span>
            <CustomSelect
              value={data.thinkingValue}
              options={(
                THINKING_OPTIONS_BY_METHOD[
                  (data.requestMethod ||
                    "chat") as keyof typeof THINKING_OPTIONS_BY_METHOD
                ] || THINKING_OPTIONS_BY_METHOD.chat
              ).map((option) => ({
                value: option.value,
                label: option.label,
              }))}
              onChange={(value) => onChange("thinkingValue", value)}
              disabled={disabled}
            />
          </label>
          {data.requestMethod === "gemini" && (
            <div className="api-settings-field">
              <span>
                {t("settings.apiGoogleSearch", {
                  defaultValue: "Google search",
                })}
              </span>
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={data.googleSearch}
                  onChange={changeField("googleSearch")}
                  disabled={disabled}
                  hidden
                />
                <span className="toggle-slider" />
                <span>
                  {t(
                    data.googleSearch
                      ? "settings.enabled"
                      : "settings.disabled"
                  )}
                </span>
              </label>
              <small className="api-settings-hint-text">
                {t("settings.apiGoogleSearchHint", {
                  defaultValue:
                    "When enabled, Gemini chat requests inject the Google Search tool for real-time web grounding.",
                })}
              </small>
            </div>
          )}
          {data.requestMethod === "responses" && (
            <>
              <label className="api-settings-field">
                <span>{t("settings.apiResponsesVerbosity")}</span>
                <CustomSelect
                  value={data.responsesVerbosity}
                  options={[
                    {
                      value: "",
                      label: t("settings.apiResponsesVerbosityDefault"),
                    },
                    { value: "low", label: "Low" },
                    { value: "medium", label: "Medium" },
                    { value: "high", label: "High" },
                  ]}
                  onChange={(value) => onChange("responsesVerbosity", value)}
                  disabled={disabled}
                />
                <small className="api-settings-hint-text">
                  {t("settings.apiResponsesVerbosityHint")}
                </small>
              </label>
              <div className="api-settings-field">
                <span>{t("settings.apiResponsesFastMode")}</span>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={data.responsesFastMode}
                    onChange={changeField("responsesFastMode")}
                    disabled={disabled}
                    hidden
                  />
                  <span className="toggle-slider" />
                  <span>
                    {t(
                      data.responsesFastMode
                        ? "settings.enabled"
                        : "settings.disabled"
                    )}
                  </span>
                </label>
                <small className="api-settings-hint-text">
                  {t("settings.apiResponsesFastModeHint")}
                </small>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="api-settings-form-section">
        <strong className="api-settings-form-section-title">
          {t("settings.formPromptHeaders", {
            defaultValue: "Prompt & Headers",
          })}
        </strong>
        <div className="api-settings-form-grid">
          <div className="api-settings-field">
            <span>
              {t("settings.apiSystemPrompts", {
                defaultValue: "System prompts",
              })}
            </span>
            <SystemPromptSelect
              value={data.systemPromptIdsJson}
              prompts={systemPrompts}
              onChange={(value) => onChange("systemPromptIdsJson", value)}
              disabled={disabled}
            />
            <small className="api-settings-hint-text">
              {t("settings.apiSystemPromptsHint", {
                defaultValue:
                  "Leave empty to inherit global active profile setting.",
              })}
            </small>
          </div>
          <label className="api-settings-field">
            <span>
              {t("settings.apiCustomHeaderScheme", {
                defaultValue: "Custom header scheme",
              })}
            </span>
            <CustomSelect
              value={data.customHeaderSchemeId}
              options={[
                {
                  value: "",
                  label: t("settings.apiHeaderSchemeInherit", {
                    defaultValue: "Inherit global",
                  }),
                },
                {
                  value: "__DISABLED__",
                  label: t("settings.apiHeaderSchemeDisabled", {
                    defaultValue: "Do not use",
                  }),
                },
                ...customHeaderSchemes.map((scheme) => ({
                  value: scheme.schemeId,
                  label: scheme.name || scheme.schemeId,
                })),
              ]}
              onChange={(value) => onChange("customHeaderSchemeId", value)}
              disabled={disabled}
            />
          </label>
        </div>
      </div>

      <div className="api-settings-form-section">
        <strong className="api-settings-form-section-title">
          {t("settings.formModels", { defaultValue: "Models" })}
        </strong>
        <div className="api-settings-form-grid">
          {renderModelField(
            "advancedModel",
            t("settings.apiAdvancedModel", {
              defaultValue: "Advanced model",
            }),
            "gpt-4.1"
          )}
          {renderModelField(
            "basicModel",
            t("settings.apiBasicModel", { defaultValue: "Basic model" }),
            "gpt-4.1-mini"
          )}
          <label className="api-settings-field">
            <span>
              {t("settings.apiMaxContext", {
                defaultValue: "Max context (tokens)",
              })}
            </span>
            <input
              value={data.maxContextTokens}
              onChange={changeField("maxContextTokens")}
              placeholder="e.g. 128000"
              type="number"
              min={0}
              list="api-context-token-presets"
              disabled={disabled}
            />
            <datalist id="api-context-token-presets">
              {CONTEXT_TOKEN_PRESETS.map((preset) => (
                <option key={preset.value} value={preset.value}>
                  {preset.label}
                </option>
              ))}
            </datalist>
            <small className="api-settings-hint-text">
              {t("settings.apiTokenPresetsHint", {
                defaultValue:
                  "Choose a common preset from the input suggestions, or enter a custom value.",
              })}
            </small>
          </label>
          <label className="api-settings-field">
            <span>
              {t("settings.apiMaxTokens", { defaultValue: "Max tokens" })}
            </span>
            <input
              value={data.maxTokens}
              onChange={changeField("maxTokens")}
              placeholder="e.g. 4096"
              type="number"
              min={0}
              list="api-output-token-presets"
              disabled={disabled}
            />
            <datalist id="api-output-token-presets">
              {OUTPUT_TOKEN_PRESETS.map((preset) => (
                <option key={preset.value} value={preset.value}>
                  {preset.label}
                </option>
              ))}
            </datalist>
            <small className="api-settings-hint-text">
              {t("settings.apiMaxTokensHint", {
                defaultValue: "Leave empty to omit this parameter from requests.",
              })}
            </small>
          </label>
        </div>
      </div>

      <div className="api-settings-form-section">
        <div className="api-settings-form-section-header">
          <strong className="api-settings-form-section-title">
            {t("settings.formVision", { defaultValue: "Vision" })}
          </strong>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={data.supportsVision}
              onChange={changeField("supportsVision")}
              disabled={disabled}
              hidden
            />
            <span className="toggle-slider" />
            <span>
              {t("settings.apiSupportsVision", {
                defaultValue: "Supports vision",
              })}
            </span>
          </label>
        </div>
        {!data.supportsVision && (
          <div className="api-settings-form-grid">
            <label className="api-settings-field wide">
              <span>
                {t("settings.apiVisionBaseUrl", {
                  defaultValue: "Vision Base URL",
                })}
              </span>
              <input
                value={data.visionBaseUrl}
                onChange={changeField("visionBaseUrl")}
                placeholder={DEFAULT_API_BASE_URL}
                disabled={disabled}
              />
            </label>
            <label className="api-settings-field">
              <span>
                {t("settings.apiVisionApiKey", {
                  defaultValue: "Vision API key",
                })}
              </span>
              <div className="api-settings-password-wrap">
                <input
                  value={data.visionApiKey}
                  onChange={changeField("visionApiKey")}
                  placeholder="sk-..."
                  type={showVisionKey ? "text" : "password"}
                  disabled={disabled}
                />
                <button
                  type="button"
                  className="api-settings-password-toggle"
                  onClick={() => setShowVisionKey((value) => !value)}
                  tabIndex={-1}
                >
                  {showVisionKey ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </label>
            <label className="api-settings-field">
              <span>
                {t("settings.apiVisionRequestMethod", {
                  defaultValue: "Vision method",
                })}
              </span>
              <CustomSelect
                value={data.visionRequestMethod}
                options={REQUEST_METHODS.map((method) => ({
                  value: method,
                  label: method,
                }))}
                onChange={(value) => onChange("visionRequestMethod", value)}
                disabled={disabled}
              />
            </label>
            <label className="api-settings-field">
              <span>
                {t("settings.apiVisionModel", { defaultValue: "Vision model" })}
              </span>
              <input
                value={data.visionModel}
                onChange={changeField("visionModel")}
                placeholder="gpt-4.1"
                disabled={disabled}
              />
            </label>
            {data.visionRequestMethod === "gemini" && (
              <div className="api-settings-field">
                <span>
                  {t("settings.apiGoogleSearch", {
                    defaultValue: "Google search",
                  })}
                </span>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={data.visionGoogleSearch}
                    onChange={changeField("visionGoogleSearch")}
                    disabled={disabled}
                    hidden
                  />
                  <span className="toggle-slider" />
                  <span>
                    {t(
                      data.visionGoogleSearch
                        ? "settings.enabled"
                        : "settings.disabled"
                    )}
                  </span>
                </label>
                <small className="api-settings-hint-text">
                  {t("settings.apiGoogleSearchHint", {
                    defaultValue:
                      "When enabled, Gemini requests inject the Google Search tool (native Gemini grounding) for real-time web information.",
                  })}
                </small>
              </div>
            )}
            <div className="api-settings-field">
              <span>
                {t("settings.apiVisionThinking", {
                  defaultValue: "Thinking",
                })}
              </span>
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={data.visionThinkingEnabled}
                  onChange={changeField("visionThinkingEnabled")}
                  disabled={disabled}
                  hidden
                />
                <span className="toggle-slider" />
                <span>
                  {t(
                    data.visionThinkingEnabled
                      ? "settings.enabled"
                      : "settings.disabled"
                  )}
                </span>
              </label>
              <small className="api-settings-hint-text">
                {t("settings.apiVisionThinkingHint", {
                  defaultValue:
                    "Disabled by default for speed. When disabled, Gemini requests explicitly set thinking budget to 0; Anthropic is always non-thinking.",
                })}
              </small>
            </div>
            {data.visionThinkingEnabled &&
              (data.visionRequestMethod === "chat" ||
                data.visionRequestMethod === "responses") && (
                <label className="api-settings-field">
                  <span>
                    {t("settings.apiVisionThinkingEffort", {
                      defaultValue: "Thinking effort",
                    })}
                  </span>
                  <CustomSelect
                    value={data.visionThinkingEffort || "medium"}
                    options={(
                      THINKING_OPTIONS_BY_METHOD[
                        (data.visionRequestMethod ||
                          "chat") as keyof typeof THINKING_OPTIONS_BY_METHOD
                      ] || THINKING_OPTIONS_BY_METHOD.chat
                    )
                      .filter((option) => option.value !== "none")
                      .map((option) => ({
                        value: option.value,
                        label: option.label,
                      }))}
                    onChange={(value) =>
                      onChange("visionThinkingEffort", value)
                    }
                    disabled={disabled}
                  />
                </label>
              )}
            <label className="api-settings-field">
              <span>
                {t("settings.apiVisionMaxTokens", {
                  defaultValue: "Max output tokens",
                })}
              </span>
              <input
                value={data.visionMaxTokens}
                onChange={changeField("visionMaxTokens")}
                placeholder="4096"
                type="number"
                min={256}
                disabled={disabled}
              />
              <small className="api-settings-hint-text">
                {t("settings.apiVisionMaxTokensHint", {
                  defaultValue: "Maximum output tokens for image descriptions. Defaults to 4096 when empty.",
                })}
              </small>
            </label>
          </div>
        )}
      </div>

      <div className="api-settings-form-section">
        <strong className="api-settings-form-section-title">
          {t("settings.formRuntime", { defaultValue: "Runtime" })}
        </strong>
        <div className="api-settings-form-grid">
          <label className="api-settings-field">
            <span>
              {t("settings.apiStreamIdleTimeout", {
                defaultValue: "Stream idle timeout (s)",
              })}
            </span>
            <input
              value={data.streamIdleTimeoutSec}
              onChange={changeField("streamIdleTimeoutSec")}
              placeholder="e.g. 60"
              type="number"
              min={0}
              disabled={disabled}
            />
          </label>
          <label className="api-settings-field">
            <span>
              {t("settings.apiMaxRetries", {
                defaultValue: "Max retries",
              })}
            </span>
            <input
              value={data.maxRetries}
              onChange={changeField("maxRetries")}
              placeholder="5"
              type="number"
              min={0}
              disabled={disabled}
            />
          </label>
          <label className="api-settings-field">
            <span>
              {t("settings.apiRetryBaseDelayMs", {
                defaultValue: "Retry delay (ms)",
              })}
            </span>
            <input
              value={data.retryBaseDelayMs}
              onChange={changeField("retryBaseDelayMs")}
              placeholder="3000"
              type="number"
              min={0}
              disabled={disabled}
            />
          </label>
          <div className="api-settings-field api-settings-auto-compress-field">
            <div className="api-settings-auto-compress-header">
              <span>
                {t("settings.apiAutoCompressThreshold", {
                  defaultValue: "Auto compress threshold",
                })}
              </span>
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={data.enableAutoCompress}
                  onChange={changeField("enableAutoCompress")}
                  disabled={disabled}
                  hidden
                />
                <span className="toggle-slider" />
                <span>
                  {data.enableAutoCompress
                    ? t("settings.active", {
                        defaultValue: ENABLED_STATUS_LABEL,
                      })
                    : t("settings.inactive", {
                        defaultValue: DISABLED_STATUS_LABEL,
                      })}
                </span>
              </label>
            </div>
            <div className="api-settings-threshold-slider-row">
              <input
                value={autoCompressThresholdPercent}
                onChange={changeField("autoCompressThreshold")}
                type="range"
                min={AUTO_COMPRESS_THRESHOLD_MIN_PERCENT}
                max={AUTO_COMPRESS_THRESHOLD_MAX_PERCENT}
                step={AUTO_COMPRESS_THRESHOLD_STEP_PERCENT}
                disabled={disabled || !data.enableAutoCompress}
              />
              <strong>{autoCompressThresholdPercent}%</strong>
            </div>
            <span className="api-settings-threshold-hint">
              {autoCompressThresholdTokens == null
                ? t("settings.apiAutoCompressThresholdNeedMaxContext", {
                    defaultValue:
                      "Set max context first to calculate the token threshold.",
                  })
                : t("settings.apiAutoCompressThresholdCalculated", {
                    defaultValue: "Calculated threshold: {tokens} tokens",
                  }).replace("{tokens}", String(autoCompressThresholdTokens))}
            </span>
          </div>
          <label className="api-settings-field">
            <span>
              {t("settings.apiSetActive", { defaultValue: "Enable profile" })}
            </span>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={data.isActive}
                onChange={changeField("isActive")}
                disabled={disabled}
                hidden
              />
              <span className="toggle-slider" />
              <span>
                {data.isActive
                  ? t("settings.active", { defaultValue: ENABLED_STATUS_LABEL })
                  : t("settings.inactive", {
                      defaultValue: DISABLED_STATUS_LABEL,
                    })}
              </span>
            </label>
          </label>
        </div>
      </div>
    </div>
  );
}
