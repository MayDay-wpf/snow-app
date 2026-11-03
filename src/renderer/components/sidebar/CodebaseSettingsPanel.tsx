import { Download, Loader2 } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { AutoDismissNotice } from "../AutoDismissNotice";
import { useI18n } from "../../i18n";
import { useBlurAutoSave } from "../../hooks/useBlurAutoSave";
import {
  loadDecisionModels,
  type DecisionModelConfig,
} from "../../constants/decisionModels";
import {
  type EmbeddingModelConfig,
  type RerankingModelConfig,
} from "../../constants/codebaseModels";
import { CodebaseSettingsForm } from "./codebaseSettings/CodebaseSettingsForm";
import { CodebaseSettingsSummary } from "./codebaseSettings/CodebaseSettingsSummary";
import {
  CODEBASE_SETTING_CODE,
  CODEBASE_SETTING_NAME,
  DEFAULT_CODEBASE_SETTINGS,
} from "./codebaseSettings/codebaseSettingsConstants";
import {
  normalizeCodebaseSettings,
  readCodebaseSettingsJson,
  toCodebaseForm,
  toCodebaseSettings,
} from "./codebaseSettings/codebaseSettingsUtils";
import type {
  CodebaseSettings,
  CodebaseSettingsForm as CodebaseSettingsFormValue,
} from "./codebaseSettings/types";
import type { ModelConnectionTestResult } from "../../../preload";

const toHealthMap = (
  results: ModelConnectionTestResult[] | undefined,
): Record<string, ModelConnectionTestResult> =>
  Object.fromEntries(
    (results ?? []).map((result) => [result.targetId, result]),
  );

export function CodebaseSettingsPanel(): React.JSX.Element {
  const { t } = useI18n();
  const [form, setForm] = useState<CodebaseSettingsFormValue>(() =>
    toCodebaseForm(DEFAULT_CODEBASE_SETTINGS),
  );
  const [lastSaved, setLastSaved] = useState<CodebaseSettings>(
    DEFAULT_CODEBASE_SETTINGS,
  );
  /** 全局决策 / 嵌入 / 重排模型：本页只选择，配置在「API 配置」对应标签页维护。 */
  const [decisionModels, setDecisionModels] = useState<DecisionModelConfig[]>(
    [],
  );
  const [embeddingModels, setEmbeddingModels] = useState<
    EmbeddingModelConfig[]
  >([]);
  const [rerankingModels, setRerankingModels] = useState<
    RerankingModelConfig[]
  >([]);
  const [embeddingHealth, setEmbeddingHealth] = useState<
    Record<string, ModelConnectionTestResult>
  >({});
  const [rerankingHealth, setRerankingHealth] = useState<
    Record<string, ModelConnectionTestResult>
  >({});
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError("");

    try {
      const [
        rawSettings,
        storedDecisionModels,
        storedEmbeddingModels,
        storedRerankingModels,
        healthSnapshot,
      ] = await Promise.all([
        window.snow.getSystemSettingValue(CODEBASE_SETTING_CODE),
        loadDecisionModels(),
        window.snow.listEmbeddingModels(),
        window.snow.listRerankingModels(),
        window.snow.getModelHealthSnapshot(),
      ]);
      // 旧版内联的模型 / Jev 字段已由 Rust 启动迁移转为模型表 + id。
      setDecisionModels(storedDecisionModels);
      setEmbeddingModels(storedEmbeddingModels);
      setRerankingModels(storedRerankingModels);
      setEmbeddingHealth(toHealthMap(healthSnapshot.embeddingModels));
      setRerankingHealth(toHealthMap(healthSnapshot.rerankingModels));
      const normalized = normalizeCodebaseSettings(
        readCodebaseSettingsJson(rawSettings),
      );

      setForm(toCodebaseForm(normalized));
      setLastSaved(normalized);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.codebaseLoadError", {
              defaultValue: "Failed to load codebase settings",
            }),
      );
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const isBusy = isLoading || isSaving;
  const preview = toCodebaseSettings(form);

  const updateField =
    (field: keyof CodebaseSettingsFormValue) =>
    (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      const value =
        event.target instanceof HTMLInputElement &&
        event.target.type === "checkbox"
          ? event.target.checked
          : event.target.value;

      setForm((previous) => ({ ...previous, [field]: value }));
    };

  const setValue = (field: keyof CodebaseSettingsFormValue, value: string) => {
    setForm((previous) => ({ ...previous, [field]: value }));
  };

  const validatePositiveInteger = (
    value: string,
    message: string,
  ): string | null => {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? null : message;
  };

  const validate = useCallback(
    (currentForm: CodebaseSettingsFormValue): string | null => {
      const numericChecks: Array<[string, string]> = [
        [
          currentForm.batchMaxLines,
          t("settings.codebaseValidationMaxLinesPositive", {
            defaultValue: "Batch max lines must be greater than 0.",
          }),
        ],
        [
          currentForm.batchConcurrency,
          t("settings.codebaseValidationConcurrencyPositive", {
            defaultValue: "Batch concurrency must be greater than 0.",
          }),
        ],
        [
          currentForm.chunkingMaxLinesPerChunk,
          t("settings.codebaseValidationMaxLinesPerChunkPositive", {
            defaultValue: "Max lines per chunk must be greater than 0.",
          }),
        ],
        [
          currentForm.chunkingMinLinesPerChunk,
          t("settings.codebaseValidationMinLinesPerChunkPositive", {
            defaultValue: "Min lines per chunk must be greater than 0.",
          }),
        ],
        [
          currentForm.rerankingTopN,
          t("settings.codebaseValidationRerankingTopNPositive", {
            defaultValue: "Reranking top N must be greater than 0.",
          }),
        ],
      ];

      for (const [value, message] of numericChecks) {
        const validationError = validatePositiveInteger(value, message);

        if (validationError) {
          return validationError;
        }
      }

      const overlapLines = Number.parseInt(
        currentForm.chunkingOverlapLines,
        10,
      );
      const maxLinesPerChunk = Number.parseInt(
        currentForm.chunkingMaxLinesPerChunk,
        10,
      );

      if (!Number.isInteger(overlapLines) || overlapLines < 0) {
        return t("settings.codebaseValidationOverlapLinesNonNegative", {
          defaultValue: "Overlap lines must be 0 or greater.",
        });
      }

      if (
        Number.isInteger(maxLinesPerChunk) &&
        overlapLines >= maxLinesPerChunk
      ) {
        return t("settings.codebaseValidationOverlapLessThanMaxLines", {
          defaultValue: "Overlap lines must be less than max lines per chunk.",
        });
      }

      // 阈值只在选择决策模型后生效；留空表示沿用二分类判定。
      if (
        currentForm.agentReviewModelId.trim() &&
        currentForm.agentReviewRelevanceThreshold.trim()
      ) {
        const threshold = Number(currentForm.agentReviewRelevanceThreshold);
        if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
          return t("settings.codebaseValidationRelevanceThreshold", {
            defaultValue:
              "Relevance threshold must be a number between 0 and 1.",
          });
        }
      }

      return null;
    },
    [t],
  );

  const saveSettings = useCallback(
    async (settings: CodebaseSettings) => {
      setIsSaving(true);
      setError("");
      try {
        await window.snow.setSystemSetting(
          CODEBASE_SETTING_NAME,
          CODEBASE_SETTING_CODE,
          JSON.stringify(settings),
        );
        const normalized = normalizeCodebaseSettings(settings);
        if (isMountedRef.current) {
          setForm(toCodebaseForm(normalized));
          setLastSaved(normalized);
          setStatus(
            t("settings.codebaseSaveSuccess", {
              defaultValue: "Saved codebase settings.",
            }),
          );
        }
      } catch (e) {
        if (isMountedRef.current) {
          setError(
            e instanceof Error
              ? e.message
              : t("settings.codebaseSaveError", {
                  defaultValue: "Failed to save codebase settings",
                }),
          );
        }
      } finally {
        if (isMountedRef.current) {
          setIsSaving(false);
        }
      }
    },
    [t],
  );

  // 失焦保存：输入框失焦或即时控件变更时立即保存，验证失败则不保存，卸载时立即冲刷避免丢失。
  const commitSave = useBlurAutoSave(
    form,
    validate,
    toCodebaseSettings,
    lastSaved,
    saveSettings,
    setError,
  );

  const handleImport = async () => {
    setIsLoading(true);
    setError("");
    setStatus("");

    try {
      await window.snow.importSnowCliCodebaseSettings();
      // Rust 已把同步来的模型配置迁入嵌入/重排模型列表，整体重载以拿到新列表与选择。
      await load();
      setStatus(
        t("settings.codebaseImportSuccess", {
          defaultValue: "Synced codebase settings from Snow CLI.",
        }),
      );
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.codebaseImportError", {
              defaultValue: "Failed to sync Snow CLI codebase settings",
            }),
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="api-settings-page" role="region">
      <CodebaseSettingsSummary
        preview={preview}
        lastSaved={lastSaved}
        embeddingModels={embeddingModels}
        rerankingModels={rerankingModels}
      />

      <div className="api-settings-actions">
        <button
          className="api-settings-action-btn primary"
          onClick={() => void handleImport()}
          type="button"
          disabled={isBusy}
        >
          {isLoading ? (
            <Loader2 size={15} className="spin" />
          ) : (
            <Download size={15} />
          )}
          <span>
            {t("settings.syncSnowCliCodebase", {
              defaultValue: "Sync Snow CLI codebase config",
            })}
          </span>
        </button>
      </div>

      <AutoDismissNotice
        message={error || status}
        tone={error ? "error" : "success"}
        onDismiss={() => {
          setError("");
          setStatus("");
        }}
      />

      <CodebaseSettingsForm
        form={form}
        decisionModels={decisionModels}
        embeddingModels={embeddingModels}
        rerankingModels={rerankingModels}
        embeddingHealth={embeddingHealth}
        rerankingHealth={rerankingHealth}
        isBusy={isBusy}
        onUpdateField={updateField}
        onSetValue={setValue}
        onBlurSave={commitSave}
        onReset={() => {
          // 重置只恢复参数，保留当前选择的嵌入 / 重排模型。
          const defaults: CodebaseSettings = {
            ...DEFAULT_CODEBASE_SETTINGS,
            embeddingModelId: lastSaved.embeddingModelId,
            rerankingModelId: lastSaved.rerankingModelId,
          };
          setForm(toCodebaseForm(defaults));
          void saveSettings(defaults);
        }}
      />
    </div>
  );
}
