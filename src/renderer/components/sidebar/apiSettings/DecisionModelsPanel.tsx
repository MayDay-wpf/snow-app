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
  DECISION_MODEL_BASE_URL_MODE_AUTO,
  DECISION_MODEL_BASE_URL_MODE_CUSTOM,
  DECISION_MODEL_CUSTOM_BASE_URL_EXAMPLE,
  DECISION_MODEL_PROVIDER_OPENAI,
  DECISION_MODEL_PROVIDER_TYPESAFE,
  DECISION_TOOL_MODEL_SETTING_CODE,
  DECISION_TOOL_MODEL_SETTING_NAME,
  createDecisionModel,
  decisionModelDefaultBaseUrl,
  decisionModelDefaultModel,
  decisionModelDefaultName,
  enabledDecisionModels,
  findDecisionModel,
  loadDecisionModels,
  normalizeDecisionModelProvider,
  resolveDecisionModelEndpoint,
  toDecisionModelConfig,
  type DecisionModelConfig,
  type DecisionModelProvider,
} from "../../../constants/decisionModels";
import { AutoDismissNotice } from "../../AutoDismissNotice";
import { ConfirmDialog } from "../../common/ConfirmDialog";
import { CustomSelect } from "../../common/CustomSelect";
import { Modal } from "../../common/Modal";
import {
  ModelConnectionStatus,
  ModelTestButton,
} from "../modelHealth/ModelConnectionStatus";
import type { ModelConnectionTestResult } from "../../../../preload";

/**
 * 决策模型管理面板（API 配置页的「决策模型」标签页）。
 *
 * 支持配置多个决策模型并单独启停：只有已启用的模型会出现在代码库代理审查等
 * 使用方的选择列表里。模型存在 Rust 的 decision_models 表，删除时 Rust 同步清空
 * 代码库审查、工具默认模型与敏感命令辅助对它的引用。每个模型可「测试连接」，
 * 最近一次检测结果存在模型行上，重启后仍显示在列表里。
 */
export function DecisionModelsPanel(): React.JSX.Element {
  const { t } = useI18n();
  const [models, setModels] = useState<DecisionModelConfig[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  /** 编辑中的草稿（null = 编辑器关闭） */
  const [draft, setDraft] = useState<DecisionModelConfig | null>(null);
  /** 草稿是否为新建（决定编辑器标题与保存按钮文案） */
  const [isNewDraft, setIsNewDraft] = useState(false);
  /** 待确认删除的模型（null = 无） */
  const [pendingDelete, setPendingDelete] =
    useState<DecisionModelConfig | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  /** 各决策模型最近一次连接自检结果（按模型 id）。 */
  const [health, setHealth] = useState<
    Record<string, ModelConnectionTestResult>
  >({});
  /** 正在检测的模型 id（null = 无）。 */
  const [testingId, setTestingId] = useState<string | null>(null);
  /** decision-evaluate 工具的默认模型 id（空串 = 未设置）。 */
  const [toolModelId, setToolModelId] = useState("");

  const load = useCallback(async () => {
    setIsLoading(true);
    setError("");

    try {
      const [list, snapshot, toolModel] = await Promise.all([
        loadDecisionModels(),
        window.snow.getModelHealthSnapshot(),
        window.snow.getSystemSettingValue(DECISION_TOOL_MODEL_SETTING_CODE),
      ]);
      setModels(list);
      setToolModelId((toolModel ?? "").trim());
      setHealth(
        Object.fromEntries(
          snapshot.decision.map((result) => [result.targetId, result]),
        ),
      );
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.decisionModelLoadError", {
              defaultValue: "Failed to load decision models",
            }),
      );
    } finally {
      setIsLoading(false);
    }
  }, [t]);

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
            : t("settings.decisionModelSaveError", {
                defaultValue: "Failed to save decision models",
              }),
        );
        return false;
      } finally {
        setIsSaving(false);
      }
    },
    [t],
  );

  /** 保存 decision-evaluate 工具的默认模型，返回是否成功。 */
  const saveToolModel = useCallback(
    async (nextId: string, successMessage?: string): Promise<boolean> => {
      setIsSaving(true);
      setError("");
      setStatus("");

      try {
        await window.snow.setSystemSetting(
          DECISION_TOOL_MODEL_SETTING_NAME,
          DECISION_TOOL_MODEL_SETTING_CODE,
          nextId,
        );
        setToolModelId(nextId);
        if (successMessage) {
          setStatus(successMessage);
        }
        return true;
      } catch (e) {
        setError(
          e instanceof Error
            ? e.message
            : t("settings.decisionModelSaveError", {
                defaultValue: "Failed to save decision models",
              }),
        );
        return false;
      } finally {
        setIsSaving(false);
      }
    },
    [t],
  );

  /** 测试连接：用传入的配置（可以是未保存的草稿）发一条最小请求，结果持久化。 */
  const runTest = useCallback(
    async (model: DecisionModelConfig): Promise<void> => {
      setTestingId(model.id);
      setError("");
      setStatus("");

      try {
        const result = await window.snow.testDecisionModelConnection({
          id: model.id,
          baseUrl: model.baseUrl,
          baseUrlMode: model.baseUrlMode,
          provider: model.provider,
          apiKey: model.apiKey,
          model: model.model,
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
    [t],
  );

  const openNewDraft = (): void => {
    setError("");
    setStatus("");
    setDraft(createDecisionModel());
    setIsNewDraft(true);
    setShowApiKey(false);
  };

  const openEditDraft = (model: DecisionModelConfig): void => {
    setError("");
    setStatus("");
    setDraft({ ...model });
    setIsNewDraft(false);
    setShowApiKey(false);
  };

  const closeDraft = (): void => {
    if (!isSaving) {
      setDraft(null);
    }
  };

  const updateDraft = (
    field: keyof DecisionModelConfig,
    value: string,
  ): void => {
    setDraft((previous) =>
      previous ? { ...previous, [field]: value } : previous,
    );
  };

  /** 切换 provider：只替换仍是默认值的端点与模型名，手填的值保持不变。 */
  const changeProvider = (provider: DecisionModelProvider): void => {
    const defaultBaseUrls = [
      decisionModelDefaultBaseUrl(DECISION_MODEL_PROVIDER_TYPESAFE),
      decisionModelDefaultBaseUrl(DECISION_MODEL_PROVIDER_OPENAI),
    ].map((value) => value.replace(/\/+$/, "").toLowerCase());
    const defaultModels = [
      decisionModelDefaultModel(DECISION_MODEL_PROVIDER_TYPESAFE),
      decisionModelDefaultModel(DECISION_MODEL_PROVIDER_OPENAI),
    ].map((value) => value.toLowerCase());
    const defaultNames = [
      decisionModelDefaultName(DECISION_MODEL_PROVIDER_TYPESAFE),
      decisionModelDefaultName(DECISION_MODEL_PROVIDER_OPENAI),
    ].map((value) => value.toLowerCase());

    setDraft((previous) => {
      if (!previous) {
        return previous;
      }

      const currentBaseUrl = previous.baseUrl
        .trim()
        .replace(/\/+$/, "")
        .toLowerCase();
      const currentModel = previous.model.trim().toLowerCase();
      const currentName = previous.name.trim().toLowerCase();
      const keepBaseUrl =
        currentBaseUrl !== "" && !defaultBaseUrls.includes(currentBaseUrl);
      const keepModel =
        currentModel !== "" && !defaultModels.includes(currentModel);
      const keepName =
        currentName !== "" && !defaultNames.includes(currentName);

      return {
        ...previous,
        name: keepName ? previous.name : decisionModelDefaultName(provider),
        provider,
        baseUrl: keepBaseUrl
          ? previous.baseUrl
          : decisionModelDefaultBaseUrl(provider),
        model: keepModel ? previous.model : decisionModelDefaultModel(provider),
      };
    });
  };

  const saveDraft = async (): Promise<void> => {
    const current = draft;
    if (!current) {
      return;
    }

    if (!current.name.trim()) {
      setError(
        t("settings.decisionModelNameRequired", {
          defaultValue: "Name is required.",
        }),
      );
      return;
    }
    if (
      current.baseUrlMode === DECISION_MODEL_BASE_URL_MODE_CUSTOM &&
      !current.baseUrl.trim()
    ) {
      setError(
        t("settings.decisionModelBaseUrlRequired", {
          defaultValue: "The full request URL is required in custom mode.",
        }),
      );
      return;
    }
    if (!current.model.trim()) {
      setError(
        t("settings.decisionModelModelRequired", {
          defaultValue: "Model name is required.",
        }),
      );
      return;
    }

    const name = current.name.trim();
    const saved = await runMutation(
      async () => {
        const stored = toDecisionModelConfig(
          await window.snow.upsertDecisionModel(current),
        );
        setModels((previous) =>
          isNewDraft
            ? [...previous, stored]
            : previous.map((model) =>
                model.id === stored.id ? stored : model,
              ),
        );
      },
      isNewDraft
        ? t("settings.decisionModelAddSuccess", {
            values: { name },
            defaultValue: `Added decision model ${name}.`,
          })
        : t("settings.decisionModelSaveSuccess", {
            values: { name },
            defaultValue: `Saved decision model ${name}.`,
          }),
    );

    if (saved) {
      setDraft(null);
    }
  };

  /** 启停单个模型：停用后使用方（如代码库代理审查）不再能选到它。 */
  const toggleEnabled = async (model: DecisionModelConfig): Promise<void> => {
    const enabled = !model.enabled;
    await runMutation(
      async () => {
        await window.snow.setRegisteredModelEnabled(
          "decision",
          model.id,
          enabled,
        );
        setModels((previous) =>
          previous.map((item) =>
            item.id === model.id ? { ...item, enabled } : item,
          ),
        );
      },
      model.enabled
        ? t("settings.decisionModelDisabledSuccess", {
            values: { name: model.name },
            defaultValue: `Disabled ${model.name}.`,
          })
        : t("settings.decisionModelEnabledSuccess", {
            values: { name: model.name },
            defaultValue: `Enabled ${model.name}.`,
          }),
    );
  };

  const confirmDelete = async (): Promise<void> => {
    const target = pendingDelete;
    setPendingDelete(null);
    if (!target) {
      return;
    }

    // Rust 删除时同步清空工具默认模型、代码库审查与敏感命令辅助对它的引用。
    await runMutation(
      async () => {
        const result = await window.snow.deleteRegisteredModel(
          "decision",
          target.id,
        );
        setModels((previous) =>
          previous.filter((item) => item.id !== target.id),
        );
        if (result.clearedReferences.includes("decisionToolModel")) {
          setToolModelId("");
        }
      },
      t("settings.decisionModelDeleteSuccess", {
        values: { name: target.name },
        defaultValue: `Deleted ${target.name}.`,
      }),
    );
  };

  /** 工具默认模型选项：未设置 + 已启用模型；当前值失效时保留一项提示。 */
  const toolModelOptions = [
    {
      value: "",
      label: t("settings.decisionToolModelNone", {
        defaultValue: "Not set",
      }),
    },
    ...enabledDecisionModels(models).map((model) => ({
      value: model.id,
      label: model.name,
    })),
  ];
  if (
    toolModelId &&
    !toolModelOptions.some((option) => option.value === toolModelId)
  ) {
    toolModelOptions.push({
      value: toolModelId,
      label: t("settings.decisionToolModelUnavailable", {
        values: {
          name: findDecisionModel(models, toolModelId)?.name ?? toolModelId,
        },
        defaultValue: "{{name}} (unavailable)",
      }),
    });
  }

  return (
    <>
      <div className="api-settings-manual-header">
        <strong>
          {t("settings.decisionModelsTitle", {
            defaultValue: "Decision models",
          })}
        </strong>
        <span>
          {t("settings.decisionModelsInfo", {
            defaultValue:
              "Decision models judge each result on its own instead of generating text. Configure them once here and select one wherever a decision model is needed (for example codebase agent review).",
          })}
        </span>
      </div>

      <div className="api-settings-table-panel">
        <div className="api-settings-table-toolbar decision-model-toolbar">
          <div className="decision-model-tool-default">
            <span
              title={t("settings.decisionToolModelHint", {
                defaultValue:
                  "Used by the decision-evaluate tool when the call does not name a model.",
              })}
            >
              {t("settings.decisionToolModel", {
                defaultValue: "Default model for the decision tool",
              })}
            </span>
            <CustomSelect
              value={toolModelId}
              options={toolModelOptions}
              ariaLabel={t("settings.decisionToolModel", {
                defaultValue: "Default model for the decision tool",
              })}
              onChange={(value) => {
                if (value === toolModelId) {
                  return;
                }
                const selected = findDecisionModel(models, value);
                void saveToolModel(
                  value,
                  selected
                    ? t("settings.decisionToolModelSaved", {
                        values: { name: selected.name },
                        defaultValue:
                          "The decision tool now uses {{name}} by default.",
                      })
                    : t("settings.decisionToolModelCleared", {
                        defaultValue:
                          "The decision tool default model was cleared.",
                      }),
                );
              }}
              disabled={isSaving}
              dropdownMinWidth={200}
            />
          </div>
          <button
            type="button"
            className="api-settings-action-btn primary"
            onClick={openNewDraft}
            disabled={isSaving}
          >
            <Plus size={15} />
            <span>
              {t("settings.decisionModelAdd", {
                defaultValue: "Add decision model",
              })}
            </span>
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
            <div className="api-settings-empty">
              {t("settings.decisionModelsEmpty", {
                defaultValue:
                  "No decision model configured yet. Add one to use it for codebase agent review.",
              })}
            </div>
          ) : (
            <table className="api-settings-table">
              <thead>
                <tr>
                  <th>{t("settings.tableName", { defaultValue: "Name" })}</th>
                  <th>{t("settings.tableModel", { defaultValue: "Model" })}</th>
                  <th>
                    {t("settings.tableBaseUrl", {
                      defaultValue: "Base URL",
                    })}
                  </th>
                  <th>
                    {t("settings.tableStatus", { defaultValue: "Status" })}
                  </th>
                  <th>{t("modelHealth.column")}</th>
                  <th className="api-settings-table-actions-col">
                    {t("settings.tableActions", {
                      defaultValue: "Actions",
                    })}
                  </th>
                </tr>
              </thead>
              <tbody>
                {models.map((model) => (
                  <tr key={model.id}>
                    <td className="cell-name">
                      <strong>{model.name}</strong>
                    </td>
                    <td>{model.model}</td>
                    <td className="cell-url">
                      {resolveDecisionModelEndpoint(model) || "-"}
                    </td>
                    <td>
                      <label
                        className="toggle-switch api-settings-table-switch"
                        title={t("settings.decisionModelToggle", {
                          defaultValue: "Enable or disable this decision model",
                        })}
                        aria-label={t("settings.decisionModelToggle", {
                          defaultValue: "Enable or disable this decision model",
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
                            ? t("settings.enabled", {
                                defaultValue: "Enabled",
                              })
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
        title={
          isNewDraft
            ? t("settings.decisionModelEditorAddTitle", {
                defaultValue: "Add decision model",
              })
            : t("settings.decisionModelEditorEditTitle", {
                defaultValue: "Edit decision model",
              })
        }
        description={t("settings.decisionModelEditorInfo", {
          defaultValue:
            "The API key is stored locally and never leaves your machine except when calling this endpoint.",
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
                onClick={() => void runTest(draft)}
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
                {t("settings.decisionModelSave", {
                  defaultValue: "Save decision model",
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
                {t("settings.decisionModelName", { defaultValue: "Name" })}
              </span>
              <input
                value={draft.name}
                onChange={(event) => updateDraft("name", event.target.value)}
                disabled={isSaving}
                placeholder={decisionModelDefaultName(draft.provider)}
              />
            </label>
            <label className="api-settings-field">
              <span>
                {t("settings.decisionModelProvider", {
                  defaultValue: "Provider",
                })}
              </span>
              <CustomSelect
                value={draft.provider}
                options={[
                  {
                    value: DECISION_MODEL_PROVIDER_TYPESAFE,
                    label: t("settings.decisionModelProviderTypesafe", {
                      defaultValue: "TypeSafe System One",
                    }),
                  },
                  {
                    value: DECISION_MODEL_PROVIDER_OPENAI,
                    label: t("settings.decisionModelProviderOpenai", {
                      defaultValue: "OpenAI Decisions",
                    }),
                  },
                ]}
                onChange={(value) =>
                  changeProvider(normalizeDecisionModelProvider(value))
                }
                disabled={isSaving}
              />
            </label>
            <label className="api-settings-field">
              <span>
                {t("settings.decisionModelModel", {
                  defaultValue: "Model name",
                })}
              </span>
              <input
                value={draft.model}
                onChange={(event) => updateDraft("model", event.target.value)}
                disabled={isSaving}
                placeholder={decisionModelDefaultModel(draft.provider)}
              />
            </label>
            <label className="api-settings-field">
              <span>
                {t("settings.decisionModelBaseUrlMode", {
                  defaultValue: "Base URL mode",
                })}
              </span>
              <CustomSelect
                value={draft.baseUrlMode}
                options={[
                  {
                    value: DECISION_MODEL_BASE_URL_MODE_AUTO,
                    label: t("settings.decisionModelBaseUrlModeAuto", {
                      defaultValue: "Auto",
                    }),
                  },
                  {
                    value: DECISION_MODEL_BASE_URL_MODE_CUSTOM,
                    label: t("settings.decisionModelBaseUrlModeCustom", {
                      defaultValue: "Custom",
                    }),
                  },
                ]}
                onChange={(value) => updateDraft("baseUrlMode", value)}
                disabled={isSaving}
              />
            </label>
            <label className="api-settings-field wide">
              <span>
                {t("settings.decisionModelBaseUrl", {
                  defaultValue: "Base URL",
                })}
              </span>
              <input
                value={draft.baseUrl}
                onChange={(event) => updateDraft("baseUrl", event.target.value)}
                disabled={isSaving}
                placeholder={
                  draft.baseUrlMode === DECISION_MODEL_BASE_URL_MODE_CUSTOM
                    ? DECISION_MODEL_CUSTOM_BASE_URL_EXAMPLE
                    : decisionModelDefaultBaseUrl(draft.provider)
                }
              />
              <small className="api-settings-hint-text">
                {t("settings.decisionModelEndpointHint", {
                  values: { url: resolveDecisionModelEndpoint(draft) },
                  defaultValue: "Requests are sent to {{url}}.",
                })}
              </small>
            </label>
            <label className="api-settings-field wide">
              <span>
                {t("settings.decisionModelApiKey", {
                  defaultValue: "API key",
                })}
              </span>
              <div className="api-settings-password-wrap">
                <input
                  type={showApiKey ? "text" : "password"}
                  value={draft.apiKey}
                  onChange={(event) =>
                    updateDraft("apiKey", event.target.value)
                  }
                  disabled={isSaving}
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
              {draft.apiKey.trim() ? null : (
                <small className="model-health-warning">
                  {t("modelHealth.decisionApiKeyEmpty")}
                </small>
              )}
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
        title={t("settings.decisionModelDeleteTitle", {
          defaultValue: "Delete decision model",
        })}
        message={t("settings.decisionModelDeleteConfirm", {
          values: { name: pendingDelete?.name ?? "" },
          defaultValue:
            "Delete {{name}}? Codebase agent review falls back to the LLM model if it was selected.",
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
