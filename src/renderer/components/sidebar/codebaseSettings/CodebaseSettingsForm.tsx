import { AlertTriangle, Eye, EyeOff, RotateCcw } from "lucide-react";
import { useState, type ChangeEvent } from "react";
import { useI18n } from "../../../i18n";
import {
  enabledDecisionModels,
  findDecisionModel,
  type DecisionModelConfig,
} from "../../../constants/decisionModels";
import type { ModelConnectionTestResult } from "../../../../preload";
import { CustomSelect } from "../../common/CustomSelect";
import {
  ModelConnectionStatus,
  ModelTestButton,
} from "../modelHealth/ModelConnectionStatus";
import { EMBEDDING_TYPE_OPTIONS } from "./codebaseSettingsConstants";
import type {
  CodebaseSettingsForm as CodebaseSettingsFormValue,
  ModelTestKind,
} from "./types";

type CodebaseSettingsFormProps = {
  form: CodebaseSettingsFormValue;
  /** 全局决策模型配置：这里只做选择，配置本身在「API 配置 → 决策模型」中维护。 */
  decisionModels: DecisionModelConfig[];
  isBusy: boolean;
  /** 嵌入 / 重排模型最近一次连接自检结果。 */
  embeddingHealth: ModelConnectionTestResult | null;
  rerankingHealth: ModelConnectionTestResult | null;
  /** 正在检测的模型类别（null = 无）。 */
  testingKind: ModelTestKind | null;
  onTest: (kind: ModelTestKind) => void;
  onUpdateField: (
    field: keyof CodebaseSettingsFormValue,
  ) => (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => void;
  onSetValue: (field: keyof CodebaseSettingsFormValue, value: string) => void;
  onBlurSave: (nextForm?: CodebaseSettingsFormValue) => void;
  onReset: () => void;
};

export function CodebaseSettingsForm({
  form,
  decisionModels,
  isBusy,
  embeddingHealth,
  rerankingHealth,
  testingKind,
  onTest,
  onUpdateField,
  onSetValue,
  onBlurSave,
  onReset,
}: CodebaseSettingsFormProps): React.JSX.Element {
  const { t } = useI18n();
  // 密钥字段与 API 配置编辑弹窗一致：回填已保存的密钥，并提供明文查看按钮。
  const [showEmbeddingKey, setShowEmbeddingKey] = useState(false);
  const [showRerankingKey, setShowRerankingKey] = useState(false);

  // 保存前就能发现的明显不可用配置：只提示、不阻止保存（本地 Ollama 等无需密钥）。
  const embeddingWarning =
    form.embeddingType !== "ollama" && !form.embeddingApiKey.trim()
      ? t("modelHealth.embeddingApiKeyEmpty")
      : "";
  const rerankingWarning =
    !form.rerankingModelName.trim() || !form.rerankingBaseUrl.trim()
      ? t("modelHealth.rerankingIncomplete")
      : "";

  const renderHealth = (
    kind: ModelTestKind,
    result: ModelConnectionTestResult | null,
    warning: string,
  ) => (
    <div className="model-health-section">
      <div className="model-health-section-actions">
        <ModelTestButton
          testing={testingKind === kind}
          disabled={isBusy || testingKind !== null}
          onClick={() => onTest(kind)}
        />
        {result ? null : <ModelConnectionStatus result={null} compact />}
      </div>
      {warning ? (
        <span className="model-health-warning">
          <AlertTriangle size={12} aria-hidden="true" />
          <span>{warning}</span>
        </span>
      ) : null}
      {result ? <ModelConnectionStatus result={result} /> : null}
    </div>
  );

  // 只能选用已启用的决策模型；已选模型被停用/删除时保留一个提示项，避免选择被静默改掉。
  const enabledModels = enabledDecisionModels(decisionModels);
  const isSelectionAvailable = enabledModels.some(
    (model) => model.id === form.agentReviewModelId,
  );
  const unavailableSelection =
    form.agentReviewModelId !== "" && !isSelectionAvailable
      ? findDecisionModel(decisionModels, form.agentReviewModelId)
      : null;
  const reviewModelOptions = [
    {
      value: "",
      label: t("settings.codebaseReviewModelLlm", {
        defaultValue: "LLM (basic model)",
      }),
    },
    ...enabledModels.map((model) => ({ value: model.id, label: model.name })),
    ...(form.agentReviewModelId !== "" && !isSelectionAvailable
      ? [
          {
            value: form.agentReviewModelId,
            label: `${
              unavailableSelection?.name ?? form.agentReviewModelId
            } · ${t("settings.codebaseReviewModelUnavailable", {
              defaultValue: "Unavailable",
            })}`,
          },
        ]
      : []),
  ];

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

  // 密钥字段：明文回填 + 眼睛按钮切换显示，复用 API 配置编辑弹窗的密码框样式。
  const renderSecretInput = (
    field: "embeddingApiKey" | "rerankingApiKey",
    label: string,
    visible: boolean,
    onToggleVisibility: () => void,
  ) => (
    <label className="api-settings-field">
      <span>{label}</span>
      <div className="api-settings-password-wrap">
        <input
          value={form[field]}
          onChange={onUpdateField(field)}
          onBlur={() => onBlurSave()}
          placeholder="sk-..."
          type={visible ? "text" : "password"}
          disabled={isBusy}
        />
        <button
          type="button"
          className="api-settings-password-toggle"
          onClick={onToggleVisibility}
          tabIndex={-1}
        >
          {visible ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>
    </label>
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
            <label className="api-settings-field">
              <span>
                {t("settings.codebaseEmbeddingType", {
                  defaultValue: "Embedding type",
                })}
              </span>
              <CustomSelect
                value={form.embeddingType}
                options={EMBEDDING_TYPE_OPTIONS}
                onChange={(value) => {
                  onSetValue("embeddingType", value);
                  onBlurSave({ ...form, embeddingType: value });
                }}
                disabled={isBusy}
              />
            </label>
            {renderTextInput(
              "embeddingModelName",
              t("settings.codebaseEmbeddingModelName", {
                defaultValue: "Embedding model name",
              }),
              "jina-embeddings-v3",
            )}
            {renderTextInput(
              "embeddingBaseUrl",
              t("settings.codebaseEmbeddingBaseUrl", {
                defaultValue: "Embedding base URL",
              }),
              "https://api.jina.ai/v1/embeddings",
            )}
            {renderTextInput(
              "embeddingDimensions",
              t("settings.codebaseEmbeddingDimensions", {
                defaultValue: "Embedding dimensions",
              }),
              "",
              "number",
              1,
              t("settings.codebaseEmbeddingDimensionsHint", {
                defaultValue:
                  "Leave empty to omit the dimensions parameter (some models do not support it).",
              }),
            )}
            {renderSecretInput(
              "embeddingApiKey",
              t("settings.codebaseEmbeddingApiKey", {
                defaultValue: "Embedding API key",
              }),
              showEmbeddingKey,
              () => setShowEmbeddingKey((value) => !value),
            )}
            {renderTextInput(
              "modelContextLength",
              t("settings.codebaseModelContextLength", {
                defaultValue: "Model context length (tokens)",
              }),
              "8192",
              "number",
              1,
              t("settings.codebaseModelContextLengthHint", {
                defaultValue:
                  "Max input tokens per chunk for the embedding model. Chunks are split to 80% of this value; over-long lines are hard-cut, and chunks the API still rejects are split again or skipped.",
              }),
            )}
          </div>
          {renderHealth("embedding", embeddingHealth, embeddingWarning)}
        </div>

        <div className="api-settings-form-section">
          <strong className="api-settings-form-section-title">
            {t("settings.codebaseRerankingSettings", {
              defaultValue: "Reranking settings",
            })}
          </strong>
          <div className="api-settings-form-grid">
            {renderTextInput(
              "rerankingModelName",
              t("settings.codebaseRerankingModelName", {
                defaultValue: "Reranking model name",
              }),
              "jina-reranker-v2-base-multilingual",
            )}
            {renderTextInput(
              "rerankingBaseUrl",
              t("settings.codebaseRerankingBaseUrl", {
                defaultValue: "Reranking base URL",
              }),
              "https://api.jina.ai/v1/rerank",
            )}
            {renderTextInput(
              "rerankingContextLength",
              t("settings.codebaseRerankingContextLength", {
                defaultValue: "Reranking context length",
              }),
              "4096",
              "number",
              1,
            )}
            {renderTextInput(
              "rerankingTopN",
              t("settings.codebaseRerankingTopN", {
                defaultValue: "Reranking top N",
              }),
              "5",
              "number",
              1,
            )}
            {renderSecretInput(
              "rerankingApiKey",
              t("settings.codebaseRerankingApiKey", {
                defaultValue: "Reranking API key",
              }),
              showRerankingKey,
              () => setShowRerankingKey((value) => !value),
            )}
          </div>
          {renderHealth("reranking", rerankingHealth, rerankingWarning)}
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
            <label className="api-settings-field">
              <span>
                {t("settings.codebaseReviewModel", {
                  defaultValue: "Review model",
                })}
              </span>
              <CustomSelect
                value={form.agentReviewModelId}
                options={reviewModelOptions}
                onChange={(value) => {
                  onSetValue("agentReviewModelId", value);
                  onBlurSave({ ...form, agentReviewModelId: value });
                }}
                disabled={isBusy}
              />
            </label>
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
