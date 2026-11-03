import {
  Eye,
  EyeOff,
  Loader2,
  Pencil,
  Plus,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../../../i18n";
import {
  DEFAULT_EMBEDDING_CONTEXT_LENGTH,
  DEFAULT_RERANKING_CONTEXT_LENGTH,
  EMBEDDING_TYPE_OPTIONS,
  createEmbeddingModel,
  createRerankingModel,
  embeddingTypeLabel,
  type EmbeddingModelConfig,
  type RerankingModelConfig,
} from "../../../constants/codebaseModels";
import { AutoDismissNotice } from "../../AutoDismissNotice";
import { ConfirmDialog } from "../../common/ConfirmDialog";
import { CustomSelect } from "../../common/CustomSelect";
import { Modal } from "../../common/Modal";
import { CODEBASE_SETTING_CODE } from "../codebaseSettings/codebaseSettingsConstants";
import {
  ModelConnectionStatus,
  ModelTestButton,
} from "../modelHealth/ModelConnectionStatus";
import type { ModelConnectionTestResult } from "../../../../preload";

export type CodebaseModelKind = "embedding" | "reranking";

/** 面板内部统一用嵌入模型的形状，重排模型忽略 embeddingType / dimensions。 */
type UnifiedModel = EmbeddingModelConfig;

/** 编辑草稿：数字字段以字符串编辑，保存时再校验。 */
type ModelDraft = Omit<UnifiedModel, "dimensions" | "contextLength"> & {
  dimensions: string;
  contextLength: string;
};

const toUnified = (model: RerankingModelConfig): UnifiedModel => ({
  ...model,
  embeddingType: "",
  dimensions: 0,
});

const fromUnified = (model: UnifiedModel): RerankingModelConfig => ({
  id: model.id,
  name: model.name,
  modelName: model.modelName,
  baseUrl: model.baseUrl,
  apiKey: model.apiKey,
  contextLength: model.contextLength,
  enabled: model.enabled,
});

type KindSpec = {
  /** codebase_settings 中保存选择的字段。 */
  selectionKey: "embeddingModelId" | "rerankingModelId";
  healthKey: "embeddingModels" | "rerankingModels";
  defaultContextLength: number;
  list: () => Promise<UnifiedModel[]>;
  save: (model: UnifiedModel) => Promise<UnifiedModel>;
  create: () => UnifiedModel;
};

const KIND_SPECS: Record<CodebaseModelKind, KindSpec> = {
  embedding: {
    selectionKey: "embeddingModelId",
    healthKey: "embeddingModels",
    defaultContextLength: DEFAULT_EMBEDDING_CONTEXT_LENGTH,
    list: () => window.snow.listEmbeddingModels(),
    save: (model) => window.snow.upsertEmbeddingModel(model),
    create: createEmbeddingModel,
  },
  reranking: {
    selectionKey: "rerankingModelId",
    healthKey: "rerankingModels",
    defaultContextLength: DEFAULT_RERANKING_CONTEXT_LENGTH,
    list: async () => (await window.snow.listRerankingModels()).map(toUnified),
    save: async (model) =>
      toUnified(await window.snow.upsertRerankingModel(fromUnified(model))),
    create: () => toUnified(createRerankingModel()),
  },
};

const toDraft = (model: UnifiedModel): ModelDraft => ({
  ...model,
  dimensions: model.dimensions > 0 ? String(model.dimensions) : "",
  contextLength: String(model.contextLength),
});

const parsePositive = (value: string): number | null => {
  const parsed = Number(value.trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

/** 读取 codebase_settings 的原始对象（解析失败返回空对象）。 */
const readCodebaseObject = (raw: string | null): Record<string, unknown> => {
  if (!raw) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

type CodebaseModelsPanelProps = {
  kind: CodebaseModelKind;
};

/**
 * 嵌入 / 重排模型管理面板（API 配置页的「嵌入模型」「重排模型」标签页）。
 *
 * 配置多个模型并单独启停，代码库设置只能选用已启用的模型。模型存在 Rust 的
 * embedding_models / reranking_models 表，索引 / 检索时按代码库选中的 id 展开配置；
 * 删除被选中的模型时 Rust 一并清空代码库的选择。
 */
export function CodebaseModelsPanel({
  kind,
}: CodebaseModelsPanelProps): React.JSX.Element {
  const { t } = useI18n();
  const spec = KIND_SPECS[kind];
  const isEmbedding = kind === "embedding";
  const [models, setModels] = useState<UnifiedModel[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [draft, setDraft] = useState<ModelDraft | null>(null);
  const [isNewDraft, setIsNewDraft] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<UnifiedModel | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [health, setHealth] = useState<
    Record<string, ModelConnectionTestResult>
  >({});
  const [testingId, setTestingId] = useState<string | null>(null);
  /** 代码库当前选中的模型 id（用于「使用中」标记）。 */
  const [selectedId, setSelectedId] = useState("");

  const texts = isEmbedding
    ? {
        title: t("settings.apiTabEmbeddingModels", {
          defaultValue: "Embedding models",
        }),
        info: t("settings.embeddingModelsInfo", {
          defaultValue:
            "Embedding models turn code chunks into vectors for codebase indexing and semantic search. Configure them here, then pick one in Codebase settings.",
        }),
        empty: t("settings.embeddingModelsEmpty", {
          defaultValue:
            "No embedding model yet. Add one to use it in Codebase settings.",
        }),
        add: t("settings.embeddingModelAdd", {
          defaultValue: "Add embedding model",
        }),
        addTitle: t("settings.embeddingModelEditorAddTitle", {
          defaultValue: "Add embedding model",
        }),
        editTitle: t("settings.embeddingModelEditorEditTitle", {
          defaultValue: "Edit embedding model",
        }),
        deleteTitle: t("settings.embeddingModelDeleteTitle", {
          defaultValue: "Delete embedding model",
        }),
        modelName: t("settings.codebaseEmbeddingModelName", {
          defaultValue: "Embedding model name",
        }),
        baseUrl: t("settings.codebaseEmbeddingBaseUrl", {
          defaultValue: "Embedding base URL",
        }),
        apiKey: t("settings.codebaseEmbeddingApiKey", {
          defaultValue: "Embedding API key",
        }),
        contextLength: t("settings.codebaseModelContextLength", {
          defaultValue: "Model context length (tokens)",
        }),
        modelPlaceholder: "jina-embeddings-v3",
        baseUrlPlaceholder: "https://api.jina.ai/v1/embeddings",
      }
    : {
        title: t("settings.apiTabRerankingModels", {
          defaultValue: "Reranking models",
        }),
        info: t("settings.rerankingModelsInfo", {
          defaultValue:
            "Reranking models reorder search results to improve relevance. Configure them here, then pick one (or none) in Codebase settings.",
        }),
        empty: t("settings.rerankingModelsEmpty", {
          defaultValue:
            "No reranking model yet. Add one to use it in Codebase settings.",
        }),
        add: t("settings.rerankingModelAdd", {
          defaultValue: "Add reranking model",
        }),
        addTitle: t("settings.rerankingModelEditorAddTitle", {
          defaultValue: "Add reranking model",
        }),
        editTitle: t("settings.rerankingModelEditorEditTitle", {
          defaultValue: "Edit reranking model",
        }),
        deleteTitle: t("settings.rerankingModelDeleteTitle", {
          defaultValue: "Delete reranking model",
        }),
        modelName: t("settings.codebaseRerankingModelName", {
          defaultValue: "Reranking model name",
        }),
        baseUrl: t("settings.codebaseRerankingBaseUrl", {
          defaultValue: "Reranking base URL",
        }),
        apiKey: t("settings.codebaseRerankingApiKey", {
          defaultValue: "Reranking API key",
        }),
        contextLength: t("settings.codebaseRerankingContextLength", {
          defaultValue: "Reranking context length",
        }),
        modelPlaceholder: "jina-reranker-v2-base-multilingual",
        baseUrlPlaceholder: "https://api.jina.ai/v1/rerank",
      };

  const load = useCallback(async () => {
    setIsLoading(true);
    setError("");

    try {
      const [list, snapshot, codebaseRaw] = await Promise.all([
        spec.list(),
        window.snow.getModelHealthSnapshot(),
        window.snow.getSystemSettingValue(CODEBASE_SETTING_CODE),
      ]);
      setModels(list);
      setHealth(
        Object.fromEntries(
          (snapshot[spec.healthKey] ?? []).map((result) => [
            result.targetId,
            result,
          ]),
        ),
      );
      const selection = readCodebaseObject(codebaseRaw)[spec.selectionKey];
      setSelectedId(typeof selection === "string" ? selection.trim() : "");
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.codebaseModelLoadError", {
              defaultValue: "Failed to load models",
            }),
      );
    } finally {
      setIsLoading(false);
    }
  }, [spec, t]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 执行一次写操作（新增 / 编辑 / 启停 / 删除共用），返回是否成功。 */
  const runMutation = useCallback(
    async (
      action: () => Promise<void>,
      successMessage: string,
    ): Promise<boolean> => {
      setIsSaving(true);
      setError("");
      setStatus("");

      try {
        await action();
        setStatus(successMessage);
        return true;
      } catch (e) {
        setError(
          e instanceof Error
            ? e.message
            : t("settings.codebaseModelSaveError", {
                defaultValue: "Failed to save models",
              }),
        );
        return false;
      } finally {
        setIsSaving(false);
      }
    },
    [t],
  );

  /** 测试连接：用传入配置（可以是未保存的草稿）发一条最小请求，结果持久化。 */
  const runTest = useCallback(
    async (model: UnifiedModel): Promise<void> => {
      setTestingId(model.id);
      setError("");
      setStatus("");

      try {
        const result = isEmbedding
          ? await window.snow.testEmbeddingConnection({
              id: model.id,
              embeddingType: model.embeddingType,
              modelName: model.modelName,
              baseUrl: model.baseUrl,
              apiKey: model.apiKey,
              dimensions: model.dimensions,
            })
          : await window.snow.testRerankingConnection({
              id: model.id,
              modelName: model.modelName,
              baseUrl: model.baseUrl,
              apiKey: model.apiKey,
            });
        setHealth((previous) => ({ ...previous, [model.id]: result }));
      } catch (e) {
        setError(
          t("modelHealth.testError", {
            values: { message: e instanceof Error ? e.message : String(e) },
          }),
        );
      } finally {
        setTestingId(null);
      }
    },
    [isEmbedding, t],
  );

  /** 草稿 -> 模型；校验失败返回错误文案。 */
  const draftToModel = (
    current: ModelDraft,
  ): { model: UnifiedModel } | { error: string } => {
    const modelName = current.modelName.trim();
    if (!modelName) {
      return {
        error: t("settings.codebaseModelModelRequired", {
          defaultValue: "Model name is required.",
        }),
      };
    }
    if (!current.baseUrl.trim()) {
      return {
        error: t("settings.codebaseModelBaseUrlRequired", {
          defaultValue: "Base URL is required.",
        }),
      };
    }

    let dimensions = 0;
    if (isEmbedding && current.dimensions.trim()) {
      const parsed = parsePositive(current.dimensions);
      if (parsed === null) {
        return {
          error: t("settings.codebaseValidationDimensionsPositive", {
            defaultValue: "Embedding dimensions must be greater than 0.",
          }),
        };
      }
      dimensions = parsed;
    }

    const contextLength = parsePositive(current.contextLength);
    if (contextLength === null) {
      return {
        error: t("settings.codebaseModelContextLengthPositive", {
          defaultValue: "Context length must be greater than 0.",
        }),
      };
    }

    return {
      model: {
        ...current,
        name: current.name.trim() || modelName,
        modelName,
        dimensions,
        contextLength,
      },
    };
  };

  /** 草稿可能尚未通过校验，测试时只做宽松转换。 */
  const draftForTest = (current: ModelDraft): UnifiedModel => ({
    ...current,
    dimensions: isEmbedding ? (parsePositive(current.dimensions) ?? 0) : 0,
    contextLength:
      parsePositive(current.contextLength) ?? spec.defaultContextLength,
  });

  const openNewDraft = (): void => {
    setError("");
    setStatus("");
    setDraft(toDraft(spec.create()));
    setIsNewDraft(true);
    setShowApiKey(false);
  };

  const openEditDraft = (model: UnifiedModel): void => {
    setError("");
    setStatus("");
    setDraft(toDraft(model));
    setIsNewDraft(false);
    setShowApiKey(false);
  };

  const closeDraft = (): void => {
    if (!isSaving) {
      setDraft(null);
    }
  };

  const updateDraft = (field: keyof ModelDraft, value: string): void => {
    setDraft((previous) =>
      previous ? { ...previous, [field]: value } : previous,
    );
  };

  const saveDraft = async (): Promise<void> => {
    const current = draft;
    if (!current) {
      return;
    }

    const converted = draftToModel(current);
    if ("error" in converted) {
      setError(converted.error);
      return;
    }

    const model = converted.model;
    const saved = await runMutation(
      async () => {
        const stored = await spec.save(model);
        setModels((previous) =>
          isNewDraft
            ? [...previous, stored]
            : previous.map((item) => (item.id === stored.id ? stored : item)),
        );
      },
      isNewDraft
        ? t("settings.codebaseModelAddSuccess", {
            values: { name: model.name },
            defaultValue: "Added {{name}}.",
          })
        : t("settings.codebaseModelSaveSuccess", {
            values: { name: model.name },
            defaultValue: "Saved {{name}}.",
          }),
    );

    if (saved) {
      setDraft(null);
    }
  };

  const toggleEnabled = async (model: UnifiedModel): Promise<void> => {
    const enabled = !model.enabled;
    await runMutation(
      async () => {
        await window.snow.setRegisteredModelEnabled(kind, model.id, enabled);
        setModels((previous) =>
          previous.map((item) =>
            item.id === model.id ? { ...item, enabled } : item,
          ),
        );
      },
      model.enabled
        ? t("settings.codebaseModelDisabledSuccess", {
            values: { name: model.name },
            defaultValue: "Disabled {{name}}.",
          })
        : t("settings.codebaseModelEnabledSuccess", {
            values: { name: model.name },
            defaultValue: "Enabled {{name}}.",
          }),
    );
  };

  const confirmDelete = async (): Promise<void> => {
    const target = pendingDelete;
    setPendingDelete(null);
    if (!target) {
      return;
    }

    // Rust 删除时同步清空代码库对它的选择。
    await runMutation(
      async () => {
        const result = await window.snow.deleteRegisteredModel(kind, target.id);
        setModels((previous) =>
          previous.filter((item) => item.id !== target.id),
        );
        if (
          result.clearedReferences.includes(`codebase.${spec.selectionKey}`)
        ) {
          setSelectedId("");
        }
      },
      t("settings.codebaseModelDeleteSuccess", {
        values: { name: target.name },
        defaultValue: "Deleted {{name}}.",
      }),
    );
  };

  const embeddingWarning = (model: {
    embeddingType: string;
    apiKey: string;
  }): string =>
    isEmbedding && model.embeddingType !== "ollama" && !model.apiKey.trim()
      ? t("modelHealth.embeddingApiKeyEmpty")
      : "";

  return (
    <>
      <div className="api-settings-manual-header">
        <strong>{texts.title}</strong>
        <span>{texts.info}</span>
      </div>

      <div className="api-settings-table-panel">
        <div className="api-settings-table-toolbar">
          <button
            type="button"
            className="api-settings-action-btn primary"
            onClick={openNewDraft}
            disabled={isSaving}
          >
            <Plus size={15} />
            <span>{texts.add}</span>
          </button>
        </div>

        <div className="api-settings-table-wrap">
          {isLoading && models.length === 0 ? (
            <div className="api-settings-empty">
              <Loader2 size={16} className="spin" />
              {t("settings.decisionModelsLoading", {
                defaultValue: "Loading...",
              })}
            </div>
          ) : models.length === 0 ? (
            <div className="api-settings-empty">{texts.empty}</div>
          ) : (
            <table className="api-settings-table">
              <thead>
                <tr>
                  <th>{t("settings.tableName", { defaultValue: "Name" })}</th>
                  <th>{t("settings.tableModel", { defaultValue: "Model" })}</th>
                  {isEmbedding ? (
                    <th>
                      {t("settings.codebaseEmbeddingType", {
                        defaultValue: "Embedding type",
                      })}
                    </th>
                  ) : null}
                  <th>
                    {t("settings.tableBaseUrl", { defaultValue: "Base URL" })}
                  </th>
                  <th>
                    {t("settings.tableStatus", { defaultValue: "Status" })}
                  </th>
                  <th>{t("modelHealth.column")}</th>
                  <th className="api-settings-table-actions-col">
                    {t("settings.tableActions", { defaultValue: "Actions" })}
                  </th>
                </tr>
              </thead>
              <tbody>
                {models.map((model) => (
                  <tr key={model.id}>
                    <td className="cell-name">
                      <strong>{model.name}</strong>
                      {model.id === selectedId ? (
                        <span className="badge">
                          {t("settings.codebaseModelInUse", {
                            defaultValue: "In use",
                          })}
                        </span>
                      ) : null}
                    </td>
                    <td>{model.modelName}</td>
                    {isEmbedding ? (
                      <td>{embeddingTypeLabel(model.embeddingType)}</td>
                    ) : null}
                    <td className="cell-url">{model.baseUrl || "-"}</td>
                    <td>
                      <label
                        className="toggle-switch api-settings-table-switch"
                        title={t("settings.codebaseModelToggle", {
                          defaultValue: "Enable or disable this model",
                        })}
                        aria-label={t("settings.codebaseModelToggle", {
                          defaultValue: "Enable or disable this model",
                        })}
                      >
                        <input
                          type="checkbox"
                          checked={model.enabled}
                          onChange={() => void toggleEnabled(model)}
                          disabled={isSaving}
                        />
                        <span className="toggle-slider" aria-hidden="true" />
                        <span>
                          {model.enabled
                            ? t("settings.enabled", { defaultValue: "Enabled" })
                            : t("settings.disabled", {
                                defaultValue: "Disabled",
                              })}
                        </span>
                      </label>
                    </td>
                    <td>
                      <ModelConnectionStatus
                        result={health[model.id]}
                        compact
                      />
                    </td>
                    <td className="api-settings-table-actions-col">
                      <div className="api-settings-table-actions">
                        <ModelTestButton
                          iconOnly
                          testing={testingId === model.id}
                          disabled={isSaving || testingId !== null}
                          onClick={() => void runTest(model)}
                        />
                        <button
                          className="icon-btn ghost"
                          onClick={() => openEditDraft(model)}
                          disabled={isSaving}
                          type="button"
                          title={t("settings.edit", { defaultValue: "Edit" })}
                          aria-label={t("settings.edit", {
                            defaultValue: "Edit",
                          })}
                        >
                          <Pencil size={13} strokeWidth={1.8} />
                        </button>
                        <button
                          className="icon-btn ghost danger"
                          onClick={() => setPendingDelete(model)}
                          disabled={isSaving}
                          type="button"
                          title={t("settings.delete", {
                            defaultValue: "Delete",
                          })}
                          aria-label={t("settings.delete", {
                            defaultValue: "Delete",
                          })}
                        >
                          <Trash2 size={13} strokeWidth={1.8} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <AutoDismissNotice
        message={error || status}
        tone={error ? "error" : "success"}
        onDismiss={() => {
          setError("");
          setStatus("");
        }}
      />

      <Modal
        open={draft !== null}
        title={isNewDraft ? texts.addTitle : texts.editTitle}
        description={t("settings.codebaseModelEditorInfo", {
          defaultValue:
            "The API key is stored locally and only sent when calling this model.",
        })}
        closeLabel={t("settings.cancel", { defaultValue: "Cancel" })}
        onClose={closeDraft}
        closeDisabled={isSaving}
        className="api-settings-editor-modal"
        footer={
          <>
            {draft ? (
              <ModelTestButton
                testing={testingId === draft.id}
                disabled={isSaving || testingId !== null}
                onClick={() => void runTest(draftForTest(draft))}
              />
            ) : null}
            <button
              type="button"
              className="api-settings-form-btn secondary"
              onClick={closeDraft}
              disabled={isSaving}
            >
              <X size={15} strokeWidth={1.9} />
              <span>{t("settings.cancel", { defaultValue: "Cancel" })}</span>
            </button>
            <button
              type="button"
              className="api-settings-form-btn primary"
              onClick={() => void saveDraft()}
              disabled={isSaving}
            >
              {isSaving ? (
                <Loader2 size={15} className="spin" />
              ) : (
                <Save size={15} strokeWidth={1.9} />
              )}
              <span>
                {t("settings.codebaseModelSave", {
                  defaultValue: "Save model",
                })}
              </span>
            </button>
          </>
        }
      >
        {draft && (
          <div className="api-settings-form-grid">
            <label className="api-settings-field">
              <span>
                {t("settings.codebaseModelName", { defaultValue: "Name" })}
              </span>
              <input
                value={draft.name}
                onChange={(event) => updateDraft("name", event.target.value)}
                disabled={isSaving}
                placeholder={draft.modelName || texts.modelPlaceholder}
              />
            </label>
            {isEmbedding ? (
              <label className="api-settings-field">
                <span>
                  {t("settings.codebaseEmbeddingType", {
                    defaultValue: "Embedding type",
                  })}
                </span>
                <CustomSelect
                  value={draft.embeddingType}
                  options={EMBEDDING_TYPE_OPTIONS}
                  onChange={(value) => updateDraft("embeddingType", value)}
                  disabled={isSaving}
                />
              </label>
            ) : null}
            <label className="api-settings-field">
              <span>{texts.modelName}</span>
              <input
                value={draft.modelName}
                onChange={(event) =>
                  updateDraft("modelName", event.target.value)
                }
                disabled={isSaving}
                placeholder={texts.modelPlaceholder}
              />
            </label>
            <label className="api-settings-field">
              <span>{texts.contextLength}</span>
              <input
                value={draft.contextLength}
                onChange={(event) =>
                  updateDraft("contextLength", event.target.value)
                }
                disabled={isSaving}
                type="number"
                min={1}
                placeholder={String(spec.defaultContextLength)}
              />
              {isEmbedding ? (
                <small className="api-settings-hint-text">
                  {t("settings.codebaseModelContextLengthHint", {
                    defaultValue:
                      "Max input tokens per chunk for the embedding model. Chunks are split to 80% of this value; over-long lines are hard-cut, and chunks the API still rejects are split again or skipped.",
                  })}
                </small>
              ) : null}
            </label>
            {isEmbedding ? (
              <label className="api-settings-field">
                <span>
                  {t("settings.codebaseEmbeddingDimensions", {
                    defaultValue: "Embedding dimensions",
                  })}
                </span>
                <input
                  value={draft.dimensions}
                  onChange={(event) =>
                    updateDraft("dimensions", event.target.value)
                  }
                  disabled={isSaving}
                  type="number"
                  min={1}
                />
                <small className="api-settings-hint-text">
                  {t("settings.codebaseEmbeddingDimensionsHint", {
                    defaultValue:
                      "Leave empty to omit the dimensions parameter (some models do not support it).",
                  })}
                </small>
              </label>
            ) : null}
            <label className="api-settings-field wide">
              <span>{texts.baseUrl}</span>
              <input
                value={draft.baseUrl}
                onChange={(event) => updateDraft("baseUrl", event.target.value)}
                disabled={isSaving}
                placeholder={texts.baseUrlPlaceholder}
              />
            </label>
            <label className="api-settings-field wide">
              <span>{texts.apiKey}</span>
              <div className="api-settings-password-wrap">
                <input
                  type={showApiKey ? "text" : "password"}
                  value={draft.apiKey}
                  onChange={(event) =>
                    updateDraft("apiKey", event.target.value)
                  }
                  disabled={isSaving}
                  placeholder="sk-..."
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
              {embeddingWarning(draft) ? (
                <small className="model-health-warning">
                  {embeddingWarning(draft)}
                </small>
              ) : null}
            </label>
            {health[draft.id] ? (
              <div className="api-settings-field wide">
                <ModelConnectionStatus result={health[draft.id]} />
              </div>
            ) : null}
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={pendingDelete !== null}
        variant="danger"
        title={texts.deleteTitle}
        message={t("settings.codebaseModelDeleteConfirm", {
          values: { name: pendingDelete?.name ?? "" },
          defaultValue:
            "Delete {{name}}? If the codebase uses it, the codebase selection is cleared too.",
        })}
        confirmLabel={t("settings.delete", { defaultValue: "Delete" })}
        cancelLabel={t("settings.cancel", { defaultValue: "Cancel" })}
        isConfirming={isSaving}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </>
  );
}
