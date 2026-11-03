import { AlertTriangle, RotateCcw } from "lucide-react";
import type { ChangeEvent } from "react";
import { useI18n } from "../../../i18n";
import {
  enabledDecisionModels,
  findDecisionModel,
  type DecisionModelConfig,
} from "../../../constants/decisionModels";
import {
  enabledModels,
  findModelById,
  type EmbeddingModelConfig,
  type RerankingModelConfig,
} from "../../../constants/codebaseModels";
import type { ModelConnectionTestResult } from "../../../../preload";
import { CustomSelect } from "../../common/CustomSelect";
import { ModelSettingsJumpButton } from "../apiSettings/ModelSettingsJumpButton";
import { ModelConnectionStatus } from "../modelHealth/ModelConnectionStatus";
import type { CodebaseSettingsForm as CodebaseSettingsFormValue } from "./types";

type CodebaseSettingsFormProps = {
  form: CodebaseSettingsFormValue;
  /** 全局决策模型配置：这里只做选择，配置本身在「API 配置 → 决策模型」中维护。 */
  decisionModels: DecisionModelConfig[];
  /** 全局嵌入 / 重排模型：这里只做选择，配置在「API 配置」对应标签页维护。 */
  embeddingModels: EmbeddingModelConfig[];
  rerankingModels: RerankingModelConfig[];
  /** 各模型最近一次连接自检结果（按模型 id）。 */
  embeddingHealth: Record<string, ModelConnectionTestResult>;
  rerankingHealth: Record<string, ModelConnectionTestResult>;
  isBusy: boolean;
  onUpdateField: (
    field: keyof CodebaseSettingsFormValue,
  ) => (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => void;
  onSetValue: (field: keyof CodebaseSettingsFormValue, value: string) => void;
  onBlurSave: (nextForm?: CodebaseSettingsFormValue) => void;
  onReset: () => void;
};

type SelectableModel = { id: string; name: string; enabled: boolean };

export function CodebaseSettingsForm({
  form,
  decisionModels,
  embeddingModels,
  rerankingModels,
  embeddingHealth,
  rerankingHealth,
  isBusy,
  onUpdateField,
  onSetValue,
  onBlurSave,
  onReset,
}: CodebaseSettingsFormProps): React.JSX.Element {
  const { t } = useI18n();
  const unavailableLabel = t("settings.codebaseReviewModelUnavailable", {
    defaultValue: "Unavailable",
  });

  // 只能选用已启用的模型；已选模型被停用/删除时保留一个提示项，避免选择被静默改掉。
  const buildModelOptions = (
    models: SelectableModel[],
    selected: string,
    noneLabel: string,
  ): Array<{ value: string; label: string }> => {
    const enabled = enabledModels(models);
    const options = [
      { value: "", label: noneLabel },
      ...enabled.map((model) => ({ value: model.id, label: model.name })),
    ];
    if (selected && !enabled.some((model) => model.id === selected)) {
      const missing = findModelById(models, selected);
      options.push({
        value: selected,
        label: `${missing?.name ?? selected} · ${unavailableLabel}`,
      });
    }
    return options;
  };

  const isSelectionUsable = (
    models: SelectableModel[],
    selected: string,
  ): boolean =>
    selected !== "" &&
    models.some((model) => model.id === selected && model.enabled);

  const embeddingOptions = buildModelOptions(
    embeddingModels,
    form.embeddingModelId,
    t("settings.codebaseEmbeddingModelNone", { defaultValue: "Not selected" }),
  );
  const rerankingOptions = buildModelOptions(
    rerankingModels,
    form.rerankingModelId,
    t("settings.codebaseRerankingModelNone", { defaultValue: "No reranking" }),
  );
  const embeddingUsable = isSelectionUsable(
    embeddingModels,
    form.embeddingModelId,
  );
  const rerankingUsable = isSelectionUsable(
    rerankingModels,
    form.rerankingModelId,
  );

  // 决策模型选项：同样只列已启用的，失效选择保留提示项。
  const enabledReviewModels = enabledDecisionModels(decisionModels);
  const isReviewSelectionAvailable = enabledReviewModels.some(
    (model) => model.id === form.agentReviewModelId,
  );
  const unavailableReview =
    form.agentReviewModelId !== "" && !isReviewSelectionAvailable
      ? findDecisionModel(decisionModels, form.agentReviewModelId)
      : null;
  const reviewModelOptions = [
    {
      value: "",
      label: t("settings.codebaseReviewModelLlm", {
        defaultValue: "LLM (basic model)",
      }),
    },
    ...enabledReviewModels.map((model) => ({
      value: model.id,
      label: model.name,
    })),
    ...(form.agentReviewModelId !== "" && !isReviewSelectionAvailable
      ? [
          {
            value: form.agentReviewModelId,
            label: `${
              unavailableReview?.name ?? form.agentReviewModelId
            } · ${unavailableLabel}`,
          },
        ]
      : []),
  ];

  const selectModel = (
    field: "embeddingModelId" | "rerankingModelId" | "agentReviewModelId",
    value: string,
  ): void => {
    onSetValue(field, value);
    onBlurSave({ ...form, [field]: value });
  };

  const renderTextInput = (
    field: keyof CodebaseSettingsFormValue,
    label: string,
    placeholder = "",
    type: "text" | "number" = "text",
    min?: number,
    hint?: string,
  ) => (
    <label className="api-settings-field">
      <span>{label}</span>
      <input
        value={String(form[field])}
        onChange={onUpdateField(field)}
        onBlur={() => onBlurSave()}
        placeholder={placeholder}
        type={type}
        min={min}
        disabled={isBusy}
      />
      {hint ? <span className="api-settings-field-hint">{hint}</span> : null}
    </label>
  );

  /** 选中模型的最近一次检测结果；未选择时给出提示。 */
  const renderSelectionState = (
    usable: boolean,
    health: ModelConnectionTestResult | undefined,
    warning: string,
  ) => (
    <div className="model-health-section">
      {usable ? (
        <ModelConnectionStatus result={health ?? null} compact />
      ) : warning ? (
        <span className="model-health-warning">
          <AlertTriangle size={12} aria-hidden="true" />
          <span>{warning}</span>
        </span>
      ) : null}
    </div>
  );

  return (
    <div className="api-settings-manual-form">
      <div className="api-settings-manual-header">
        <strong>
          {t("settings.codebaseManualTitle", {
            defaultValue: "Manual configuration",
          })}
        </strong>
        <span>
          {t("settings.codebaseManualInfo", {
            defaultValue:
              "These values are saved in the local app database and can be synced from Snow CLI settings.json files.",
          })}
        </span>
      </div>

      <div className="api-settings-form-body">
        <div className="api-settings-form-section">
          <strong className="api-settings-form-section-title">
            {t("settings.codebaseEmbeddingSettings", {
              defaultValue: "Embedding settings",
            })}
          </strong>
          <div className="api-settings-form-grid">
            <div className="api-settings-field">
              <div className="api-settings-field-head">
                <span>
                  {t("settings.codebaseEmbeddingModel", {
                    defaultValue: "Embedding model",
                  })}
                </span>
                <ModelSettingsJumpButton tab="embedding" />
              </div>
              <CustomSelect
                value={form.embeddingModelId}
                options={embeddingOptions}
                onChange={(value) => selectModel("embeddingModelId", value)}
                disabled={isBusy}
              />
            </div>
          </div>
          {renderSelectionState(
            embeddingUsable,
            embeddingHealth[form.embeddingModelId],
            t("settings.codebaseEmbeddingModelMissing", {
              defaultValue:
                "No usable embedding model is selected, so codebase indexing cannot run.",
            }),
          )}
          <span className="settings-item-description">
            {t("settings.codebaseEmbeddingModelHint", {
              defaultValue:
                "Embedding models are managed in API configuration → Embedding models; only enabled ones can be selected here. Rebuild the index after switching models.",
            })}
          </span>
        </div>

        <div className="api-settings-form-section">
          <strong className="api-settings-form-section-title">
            {t("settings.codebaseRerankingSettings", {
              defaultValue: "Reranking settings",
            })}
          </strong>
          <div className="api-settings-form-grid">
            <div className="api-settings-field">
              <div className="api-settings-field-head">
                <span>
                  {t("settings.codebaseRerankingModel", {
                    defaultValue: "Reranking model",
                  })}
                </span>
                <ModelSettingsJumpButton tab="reranking" />
              </div>
              <CustomSelect
                value={form.rerankingModelId}
                options={rerankingOptions}
                onChange={(value) => selectModel("rerankingModelId", value)}
                disabled={isBusy}
              />
            </div>
            {renderTextInput(
              "rerankingTopN",
              t("settings.codebaseRerankingTopN", {
                defaultValue: "Reranking top N",
              }),
              "5",
              "number",
              1,
            )}
          </div>
          {renderSelectionState(
            rerankingUsable,
            rerankingHealth[form.rerankingModelId],
            "",
          )}
          <span className="settings-item-description">
            {t("settings.codebaseRerankingModelHint", {
              defaultValue:
                "Reranking models are managed in API configuration → Reranking models; only enabled ones can be selected here.",
            })}
          </span>
        </div>

        <div className="api-settings-form-section">
          <strong className="api-settings-form-section-title">
            {t("settings.codebaseAgentReviewSettings", {
              defaultValue: "Agent review settings",
            })}
          </strong>
          <span className="settings-item-description">
            {t("settings.codebaseAgentReviewInfo", {
              defaultValue:
                "Agent review removes irrelevant search results. The LLM (basic model) judges them by default; a decision model judges every result on its own. When a refined query is needed, the LLM only writes the new query.",
            })}
          </span>
          <div className="api-settings-form-grid">
            <div className="api-settings-field">
              <div className="api-settings-field-head">
                <span>
                  {t("settings.codebaseReviewModel", {
                    defaultValue: "Review model",
                  })}
                </span>
                <ModelSettingsJumpButton tab="decision" />
              </div>
              <CustomSelect
                value={form.agentReviewModelId}
                options={reviewModelOptions}
                onChange={(value) => selectModel("agentReviewModelId", value)}
                disabled={isBusy}
              />
            </div>
            {/* 只有选择决策模型审查时才需要相关性阈值；留空 = 二分类判定。 */}
            {form.agentReviewModelId !== ""
              ? renderTextInput(
                  "agentReviewRelevanceThreshold",
                  t("settings.codebaseRelevanceThreshold", {
                    defaultValue: "Relevance threshold (0-1)",
                  }),
                  "0.50",
                  "number",
                  0,
                  t("settings.codebaseRelevanceThresholdHint", {
                    defaultValue:
                      "Keep results whose relevance probability reaches this value. Leave empty for binary verdicts.",
                  }),
                )
              : null}
          </div>
          <span className="settings-item-description">
            {t("settings.codebaseReviewModelHint", {
              defaultValue:
                "Decision models are managed in API configuration → Decision models; only enabled ones can be selected here.",
            })}
          </span>
        </div>

        <div className="api-settings-form-section">
          <strong className="api-settings-form-section-title">
            {t("settings.codebaseBatchChunkingSettings", {
              defaultValue: "Batch and chunking",
            })}
          </strong>
          <div className="api-settings-form-grid">
            {renderTextInput(
              "batchMaxLines",
              t("settings.codebaseBatchMaxLines", {
                defaultValue: "Batch max lines",
              }),
              "10",
              "number",
              1,
            )}
            {renderTextInput(
              "batchConcurrency",
              t("settings.codebaseBatchConcurrency", {
                defaultValue: "Batch concurrency",
              }),
              "3",
              "number",
              1,
            )}
            {renderTextInput(
              "chunkingMaxLinesPerChunk",
              t("settings.codebaseChunkingMaxLinesPerChunk", {
                defaultValue: "Max lines per chunk",
              }),
              "200",
              "number",
              1,
            )}
            {renderTextInput(
              "chunkingMinLinesPerChunk",
              t("settings.codebaseChunkingMinLinesPerChunk", {
                defaultValue: "Min lines per chunk",
              }),
              "10",
              "number",
              1,
            )}
            {renderTextInput(
              "chunkingMinCharsPerChunk",
              t("settings.codebaseChunkingMinCharsPerChunk", {
                defaultValue: "Min chars per chunk",
              }),
              "20",
              "number",
              1,
            )}
            {renderTextInput(
              "chunkingOverlapLines",
              t("settings.codebaseChunkingOverlapLines", {
                defaultValue: "Overlap lines",
              }),
              "20",
              "number",
              0,
            )}
          </div>
        </div>
      </div>

      <div className="api-settings-form-actions">
        <button
          className="api-settings-form-btn secondary"
          onClick={onReset}
          type="button"
          disabled={isBusy}
        >
          <RotateCcw size={15} strokeWidth={1.9} />
          <span>{t("settings.reset", { defaultValue: "Reset" })}</span>
        </button>
      </div>
    </div>
  );
}
