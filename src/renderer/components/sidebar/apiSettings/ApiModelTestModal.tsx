import { Loader2, PlugZap, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  Model,
  ModelConnectionTestResult,
  SystemPromptItemRecord,
} from "../../../../preload";
import { useI18n } from "../../../i18n";
import { Modal } from "../../common/Modal";
import { ModelConnectionStatus } from "../modelHealth/ModelConnectionStatus";
import { ApiModelCombobox } from "./ApiModelCombobox";
import type { ApiConfigItem } from "./types";

const TEST_RESULT_SETTING_NAME = "API model connection tests";
const TEST_RESULT_SETTING_CODE = "api_model_health";

type StoredApiModelTest = {
  result: ModelConnectionTestResult;
  responseText: string;
};

type ApiModelTestModalProps = {
  config: ApiConfigItem | null;
  onClose: () => void;
  onTestingChange: (profileName: string, testing: boolean) => void;
};

const makeResultKey = (profileName: string, model: string): string =>
  JSON.stringify([profileName, model.trim()]);

const readStoredResults = (
  raw: string | null,
): Record<string, StoredApiModelTest> => {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, StoredApiModelTest>)
      : {};
  } catch {
    return {};
  }
};

const resolveConfiguredPrompts = (
  config: ApiConfigItem,
  prompts: SystemPromptItemRecord[],
): string[] => {
  const setting = config.systemPromptIdsJson.trim();
  const globalPrompts = prompts
    .filter((prompt) => prompt.scope === "global")
    .sort((left, right) => left.sortOrder - right.sortOrder);
  if (setting === "__DISABLED__") return [];
  if (!setting) {
    return globalPrompts
      .filter((prompt) => prompt.isActive)
      .map((prompt) => prompt.content.trim())
      .filter(Boolean);
  }
  try {
    const ids: unknown = JSON.parse(setting);
    if (!Array.isArray(ids)) return [];
    return ids
      .filter((id): id is string => typeof id === "string")
      .map(
        (id) =>
          prompts.find((prompt) => prompt.promptId === id)?.content.trim() ??
          "",
      )
      .filter(Boolean);
  } catch {
    return [];
  }
};

const safeEndpoint = (value: string): string => {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return value.split(/[?#]/, 1)[0];
  }
};

export function ApiModelTestModal({
  config,
  onClose,
  onTestingChange,
}: ApiModelTestModalProps): React.JSX.Element {
  const { t } = useI18n();
  const [model, setModel] = useState("");
  const [models, setModels] = useState<Model[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [promptContents, setPromptContents] = useState<string[]>([]);
  const [promptsLoaded, setPromptsLoaded] = useState(false);
  const [promptError, setPromptError] = useState("");
  const [storedResults, setStoredResults] = useState<
    Record<string, StoredApiModelTest>
  >({});
  const [isTesting, setIsTesting] = useState(false);
  const [streamedContent, setStreamedContent] = useState("");
  const [testError, setTestError] = useState("");

  const resultKey = useMemo(
    () =>
      config && model.trim() ? makeResultKey(config.profileName, model) : "",
    [config, model],
  );
  const lastTest = resultKey ? storedResults[resultKey] : undefined;

  const loadModelOptions = useCallback(async () => {
    if (!config) return;
    setIsLoadingModels(true);
    setModelError(null);
    try {
      const available = await window.snow.fetchAvailableModelsForConfig({
        baseUrl: config.baseUrl,
        baseUrlMode: config.baseUrlMode,
        apiKey: config.apiKey,
        requestMethod: config.requestMethod,
        customHeaderSchemeId: config.customHeaderSchemeId,
        configJson: config.configJson.trim() || undefined,
        profileName: config.profileName,
      });
      setModels(available);
      setModelsLoaded(true);
    } catch (error) {
      setModelError(error instanceof Error ? error.message : String(error));
      setModelsLoaded(false);
    } finally {
      setIsLoadingModels(false);
    }
  }, [config]);

  useEffect(() => {
    if (!config) return;
    setModel(config.advancedModel || config.basicModel);
    setModels([]);
    setModelsLoaded(false);
    setModelError(null);
    setPromptContents([]);
    setPromptsLoaded(false);
    setPromptError("");
    setStreamedContent("");
    setTestError("");
    void loadModelOptions();
    void window.snow
      .listSystemPrompts()
      .then((prompts) => {
        setPromptContents(resolveConfiguredPrompts(config, prompts));
        setPromptsLoaded(true);
      })
      .catch((error) => {
        setPromptError(error instanceof Error ? error.message : String(error));
        setPromptsLoaded(true);
      });
    void window.snow
      .getSystemSettingValue(TEST_RESULT_SETTING_CODE)
      .then((raw) => {
        setStoredResults(readStoredResults(raw));
      })
      .catch(() => setStoredResults({}));
  }, [config, loadModelOptions]);

  const runTest = async (): Promise<void> => {
    if (!config || !model.trim() || !promptsLoaded || promptError || isTesting)
      return;
    const selectedModel = model.trim();
    setIsTesting(true);
    onTestingChange(config.profileName, true);
    setStreamedContent("");
    setTestError("");
    const startedAt = Date.now();
    let responseText = "";
    let failureMessage = "";

    try {
      const response = await window.snow.createResponseStream(
        {
          messages: [
            ...promptContents.map((content) => ({
              role: "system" as const,
              content,
            })),
            { role: "user", content: "Say 1" },
          ],
          model: selectedModel,
          apiProfile: config.profileName,
          skipContext: true,
          allowedToolsJson: "[]",
        },
        (chunk) => {
          responseText = chunk.content;
          setStreamedContent(chunk.content);
        },
      );
      responseText = response.content || responseText;
      setStreamedContent(responseText);
      if (response.status !== "completed" || !responseText.trim()) {
        failureMessage =
          response.failureReason || response.status || "Empty response";
      }
    } catch (error) {
      failureMessage = error instanceof Error ? error.message : String(error);
    }

    const result: ModelConnectionTestResult = {
      targetId: makeResultKey(config.profileName, selectedModel),
      ok: !failureMessage,
      httpStatus: null,
      latencyMs: Date.now() - startedAt,
      endpoint: safeEndpoint(config.baseUrl),
      model: selectedModel,
      error: failureMessage || null,
      testedAt: Date.now(),
    };
    const entry = { result, responseText };
    setTestError("");
    setStoredResults((previous) => ({ ...previous, [result.targetId]: entry }));

    try {
      const latest = readStoredResults(
        await window.snow.getSystemSettingValue(TEST_RESULT_SETTING_CODE),
      );
      await window.snow.setSystemSetting(
        TEST_RESULT_SETTING_NAME,
        TEST_RESULT_SETTING_CODE,
        JSON.stringify({ ...latest, [result.targetId]: entry }),
      );
    } catch {
      setTestError(
        t("settings.apiModelTestSaveError", {
          defaultValue:
            "The test completed, but its result could not be saved.",
        }),
      );
    } finally {
      setIsTesting(false);
      onTestingChange(config.profileName, false);
    }
  };

  return (
    <Modal
      open={config !== null}
      title={t("settings.apiModelTestTitle", {
        defaultValue: "Test API model",
      })}
      description={t("settings.apiModelTestDescription", {
        defaultValue:
          "Send “Say 1” using this profile's request method, system prompts, and custom headers.",
      })}
      closeLabel={t("settings.cancel", { defaultValue: "Cancel" })}
      onClose={onClose}
      closeDisabled={isTesting}
      size="large"
      className="api-model-test-modal"
      footer={
        <>
          <button
            className="api-settings-form-btn secondary"
            type="button"
            onClick={onClose}
            disabled={isTesting}
          >
            <X size={15} strokeWidth={1.9} />
            <span>{t("settings.cancel", { defaultValue: "Cancel" })}</span>
          </button>
          <button
            className="api-settings-form-btn primary"
            type="button"
            onClick={() => void runTest()}
            disabled={
              isTesting ||
              !model.trim() ||
              !promptsLoaded ||
              Boolean(promptError)
            }
          >
            {isTesting ? (
              <Loader2 size={15} className="spin" />
            ) : (
              <PlugZap size={15} />
            )}
            <span>
              {isTesting
                ? t("modelHealth.testing", { defaultValue: "Testing..." })
                : t("settings.apiModelTestStart", {
                    defaultValue: "Test model",
                  })}
            </span>
          </button>
        </>
      }
    >
      <div className="api-model-test-layout">
        <section className="api-model-test-selection">
          <ApiModelCombobox
            label={t("settings.apiModelTestSelectModel", {
              defaultValue: "Model",
            })}
            value={model}
            placeholder={t("settings.apiModelTestModelPlaceholder", {
              defaultValue: "Select or enter a model",
            })}
            disabled={isTesting}
            models={models}
            isLoading={isLoadingModels}
            error={modelError}
            hasLoaded={modelsLoaded}
            loadingText={t("settings.loadingModels", {
              defaultValue: "Loading models...",
            })}
            noModelsText={t("chat.noModelsFound", {
              defaultValue: "No models found",
            })}
            retryText={t("common.retry", { defaultValue: "Retry" })}
            onChange={setModel}
            onRequestModels={() => {
              if (!modelsLoaded && !isLoadingModels) void loadModelOptions();
            }}
            onRetry={() => void loadModelOptions()}
          />
          <p className="api-model-test-profile">{config?.displayName}</p>
          {promptError ? (
            <div className="api-settings-form-error">{promptError}</div>
          ) : null}
          {!promptsLoaded && (
            <p className="api-model-test-profile">
              {t("settings.apiModelTestLoadingPrompts", {
                defaultValue: "Loading profile system prompts...",
              })}
            </p>
          )}
          {lastTest ? <ModelConnectionStatus result={lastTest.result} /> : null}
          {testError ? (
            <div className="api-settings-form-error">{testError}</div>
          ) : null}
        </section>
        <section className="api-model-test-response">
          <strong>
            {t("settings.apiModelTestResponse", { defaultValue: "Response" })}
          </strong>
          <pre aria-live="polite">
            {isTesting
              ? streamedContent ||
                t("settings.apiModelTestWaiting", {
                  defaultValue: "Waiting for response…",
                })
              : lastTest?.responseText ||
                lastTest?.result.error ||
                (testError
                  ? testError
                  : t("settings.apiModelTestEmpty", {
                      defaultValue: "The streaming response will appear here.",
                    }))}
          </pre>
        </section>
      </div>
    </Modal>
  );
}
