import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Bot,
  BrainCircuit,
  Copy,
  Image as ImageIcon,
  ListOrdered,
  Network,
  RotateCcw,
  X,
} from "lucide-react";
import { AutoDismissNotice } from "../AutoDismissNotice";
import { Modal } from "../common/Modal";
import { useI18n } from "../../i18n";
import type { ApiConfigImportOutcome, ApiConfigRecord } from "../../../preload";
import { ApiSettingsActions } from "./apiSettings/ApiSettingsActions";
import { OAuthLoginDialog } from "./apiSettings/OAuthLoginDialog";
import {
  ApiSettingsFormActions,
  ApiSettingsFormPanel,
} from "./apiSettings/ApiSettingsFormPanel";
import { ApiSettingsEditModal } from "./apiSettings/ApiSettingsEditModal";
import { ApiSettingsSummary } from "./apiSettings/ApiSettingsSummary";
import { ApiSettingsTable } from "./apiSettings/ApiSettingsTable";
import { CodebaseModelsPanel } from "./apiSettings/CodebaseModelsPanel";
import { DecisionModelsPanel } from "./apiSettings/DecisionModelsPanel";
import { RetrySettingsPanel } from "./apiSettings/RetrySettingsPanel";
import { ImageGenSettingsPanel } from "./ImageGenSettingsPanel";
import {
  moveApiConfigName,
  orderApiConfigsByName,
} from "./apiSettings/apiConfigReorder";
import { buildDuplicateName } from "./duplicateName";
import {
  emptyApiConfigForm,
  toApiConfigPayload,
} from "./apiSettings/apiSettingsUtils";
import {
  consumeApiSettingsTab,
  peekApiSettingsTab,
} from "./apiSettings/apiSettingsTabRequest";
import type {
  ApiConfigFormData,
  ApiSettingsPanelProps,
  ApiSettingsTab,
} from "./apiSettings/types";

/** 导入文件中与现有配置同名的待确认状态。 */
type PendingApiConfigImport = {
  filePath: string;
  /** 文件中可导入的配置总数。 */
  totalCount: number;
  /** 文件中与现有配置同名的配置名。 */
  conflictNames: string[];
};

/** 冲突确认弹窗中最多直接列出的同名配置数量。 */
const MAX_LISTED_CONFLICTS = 8;

export function ApiSettingsTreePanel({
  initialTab = "llm",
}: ApiSettingsPanelProps): React.JSX.Element {
  const { t } = useI18n();
  // 模型下拉的「前往 API 设置」会携带目标标签页，挂载时优先使用。
  const [activeTab, setActiveTab] = useState<ApiSettingsTab>(
    () => peekApiSettingsTab() ?? initialTab,
  );
  const [configs, setConfigs] = useState<ApiConfigRecord[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [addForm, setAddForm] = useState<ApiConfigFormData>(() =>
    emptyApiConfigForm(1, true),
  );
  const [editingConfig, setEditingConfig] = useState<ApiConfigRecord | null>(
    null,
  );
  const [pendingImport, setPendingImport] =
    useState<PendingApiConfigImport | null>(null);
  const [showOAuthLogin, setShowOAuthLogin] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  const isBusy = isLoading || isSaving || isImporting;

  const load = useCallback(async () => {
    setIsLoading(true);
    setError("");

    try {
      const list = await window.snow.listApiConfigs();
      setConfigs(list);
      setAddForm(emptyApiConfigForm(list.length + 1, list.length === 0));
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.apiLoadError", {
              defaultValue: "Failed to load API configs",
            }),
      );
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  // 目标标签页只消费一次，之后用户手动切换不再被外部请求覆盖。
  useEffect(() => {
    consumeApiSettingsTab();
  }, []);

  // 拖拽 / 上移下移排序：先本地重排给出即时反馈，再以 Rust 返回的权威顺序覆盖。
  const handleReorder = async (orderedNames: string[]): Promise<void> => {
    setError("");
    setConfigs((previous) => orderApiConfigsByName(previous, orderedNames));

    try {
      setConfigs(await window.snow.reorderApiConfigs(orderedNames));
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.apiReorderError", {
              defaultValue: "Failed to save the new order",
            }),
      );
      await load();
    }
  };

  const onFieldChange = (
    field: keyof ApiConfigFormData,
    value: string | boolean,
  ): void => {
    if (field === "isActive" && value === false) {
      const willKeepAnotherActive = configs.some(
        (config) =>
          config.isActive && config.profileName !== addForm.profileName,
      );

      if (!willKeepAnotherActive) {
        setError(
          t("settings.apiAtLeastOneActive", {
            defaultValue: "At least one API profile must be enabled.",
          }),
        );
        return;
      }
    }

    setAddForm((previous) => ({ ...previous, [field]: value }));
  };

  const handleAddSubmit = async () => {
    const profileName = addForm.profileName.trim();
    if (!profileName) {
      setError(
        t("settings.apiManualProfileRequired", {
          defaultValue: "Profile name is required.",
        }),
      );
      return;
    }

    // 同名时后端 upsert 会静默覆盖既有档案，先提示用户改名。
    if (configs.some((item) => item.profileName === profileName)) {
      setError(
        t("settings.apiProfileNameExists", {
          defaultValue: 'Profile name "{{name}}" already exists.',
          values: { name: profileName },
        }),
      );
      return;
    }

    setIsSaving(true);
    setError("");
    setStatus("");

    try {
      const list = await window.snow.upsertApiConfig(
        toApiConfigPayload(addForm, addForm.isActive, configs.length),
      );
      setConfigs(list);
      setAddForm(emptyApiConfigForm(list.length + 1, false));
      setShowAddForm(false);
      setStatus(
        t("settings.apiManualAddSuccess", {
          defaultValue: "Added API profile {name}.",
        }).replace("{name}", profileName),
      );
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.apiAddError", {
              defaultValue: "Failed to add API config",
            }),
      );
    } finally {
      setIsSaving(false);
    }
  };

  const toggleAddForm = () => {
    setError("");
    setStatus("");
    setShowAddForm((value) => {
      if (!value) {
        setAddForm(
          emptyApiConfigForm(configs.length + 1, configs.length === 0),
        );
      }
      return !value;
    });
  };

  const handleImport = async () => {
    setIsLoading(true);
    setError("");
    setStatus("");

    try {
      const result = await window.snow.importSnowCliApiConfigs();
      setConfigs(result.configs);
      setAddForm(
        emptyApiConfigForm(
          result.configs.length + 1,
          result.configs.length === 0,
        ),
      );
      setStatus(
        t("settings.apiImportSuccess", {
          defaultValue: "Imported {count} Snow CLI profiles.",
        }).replace("{count}", result.importedCount.toString()),
      );
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.apiImportError", {
              defaultValue: "Failed to import Snow CLI configs",
            }),
      );
    } finally {
      setIsLoading(false);
    }
  };

  /** 把导入结果拼成一条状态提示（覆盖/副本/忽略条目数按需追加）。 */
  const buildImportStatus = (outcome: ApiConfigImportOutcome): string => {
    let message = t("settings.apiImportFileSuccess", {
      defaultValue: "Imported {count} API profile(s).",
    }).replace("{count}", String(outcome.importedCount));

    if (outcome.overwrittenCount > 0) {
      message += ` ${t("settings.apiImportOverwriteCount", {
        defaultValue: "Overwrote {count} same-name profile(s).",
      }).replace("{count}", String(outcome.overwrittenCount))}`;
    }
    if (outcome.renamedCount > 0) {
      message += ` ${t("settings.apiImportRenamedCount", {
        defaultValue: "Kept {count} as new copies.",
      }).replace("{count}", String(outcome.renamedCount))}`;
    }
    if (outcome.skippedCount > 0) {
      message += ` ${t("settings.apiImportSkippedCount", {
        defaultValue: "Skipped {count} unrecognized entries.",
      }).replace("{count}", String(outcome.skippedCount))}`;
    }
    if (outcome.activatedProfileName) {
      message += ` ${t("settings.apiImportActivated", {
        defaultValue: "Activated {name}.",
      }).replace("{name}", outcome.activatedProfileName)}`;
    }

    return message;
  };

  const applyImport = async (
    filePath: string,
    conflictStrategy: "overwrite" | "duplicate",
  ) => {
    setIsSaving(true);
    setIsImporting(true);
    setError("");
    setStatus("");

    try {
      const result = await window.snow.importApiConfigsFile(
        filePath,
        conflictStrategy,
      );
      setConfigs(result.configs);
      setAddForm(
        emptyApiConfigForm(
          result.configs.length + 1,
          result.configs.length === 0,
        ),
      );
      setPendingImport(null);
      setStatus(buildImportStatus(result.outcome));
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.apiImportFileError", {
              defaultValue: "Failed to import API profiles",
            }),
      );
    } finally {
      setIsSaving(false);
      setIsImporting(false);
    }
  };

  const handleImportFile = async () => {
    setIsImporting(true);
    setError("");
    setStatus("");

    try {
      const result = await window.snow.pickApiConfigImportFile();
      if (result.canceled || !result.preview) {
        return;
      }

      const existingNames = new Set(
        configs.map((config) => config.profileName),
      );
      const conflictNames = result.preview.profiles
        .map((profile) => profile.profileName)
        .filter((profileName) => existingNames.has(profileName));

      if (conflictNames.length > 0) {
        setPendingImport({
          filePath: result.filePath,
          totalCount: result.preview.profiles.length,
          conflictNames,
        });
        return;
      }

      await applyImport(result.filePath, "overwrite");
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.apiImportFileError", {
              defaultValue: "Failed to import API profiles",
            }),
      );
    } finally {
      setIsImporting(false);
    }
  };

  const handleExportSelected = async (profileNames: string[]) => {
    setIsSaving(true);
    setError("");
    setStatus("");

    try {
      const result = await window.snow.exportApiConfigsFile(profileNames);
      if (result.canceled) {
        return;
      }

      setStatus(
        `${t("settings.apiExportSuccess", {
          defaultValue: "Exported {count} API profile(s) to {path}.",
        })
          .replace("{count}", String(result.exportedCount))
          .replace("{path}", result.filePath)} ${t(
          "settings.apiExportKeysWarning",
          {
            defaultValue:
              "The exported file contains API keys in plain text. Keep it safe.",
          },
        )}`,
      );
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.apiExportError", {
              defaultValue: "Failed to export API profiles",
            }),
      );
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (profileName: string, displayName: string) => {
    setError("");
    setStatus("");

    try {
      const list = await window.snow.deleteApiConfig(profileName);
      setConfigs(list);
      setEditingConfig(null);
      setStatus(
        t("settings.apiDeleteSuccess", {
          defaultValue: "Deleted API profile {name}.",
        }).replace("{name}", displayName),
      );
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.apiDeleteError", {
              defaultValue: "Failed to delete API config",
            }),
      );
    }
  };

  const handleDeleteSelected = async (profileNames: string[]) => {
    setError("");
    setStatus("");
    setIsSaving(true);

    try {
      // 逐个删除：Rust 侧每次删除都会保证至少保留一个激活配置。
      let list: ApiConfigRecord[] | undefined;
      for (const profileName of profileNames) {
        list = await window.snow.deleteApiConfig(profileName);
      }
      if (list) {
        setConfigs(list);
      }
      if (editingConfig && profileNames.includes(editingConfig.profileName)) {
        setEditingConfig(null);
      }
      setStatus(
        t("settings.apiDeleteSelectedSuccess", {
          defaultValue: "Deleted {count} API profiles.",
        }).replace("{count}", String(profileNames.length)),
      );
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.apiDeleteError", {
              defaultValue: "Failed to delete API config",
            }),
      );
    } finally {
      setIsSaving(false);
    }
  };

  const handleDuplicate = async (config: ApiConfigRecord) => {
    setError("");
    setStatus("");

    // 命名规则：*-Copy-n（n 为递增数字，避免与既有 profileName/displayName 冲突）。
    const profileName = buildDuplicateName(
      config.profileName,
      configs.map((item) => item.profileName),
    );
    const displayName = buildDuplicateName(
      config.displayName || config.profileName,
      configs.map((item) => item.displayName),
    );

    setIsSaving(true);
    try {
      const list = await window.snow.upsertApiConfig({
        profileName,
        displayName,
        // 复制后默认未启用（同时仅允许一个 active，避免覆盖当前启用项）。
        isActive: false,
        baseUrl: config.baseUrl,
        baseUrlMode: config.baseUrlMode,
        apiKey: config.apiKey,
        requestMethod: config.requestMethod,
        advancedModel: config.advancedModel,
        basicModel: config.basicModel,
        supportsVision: config.supportsVision,
        visionBaseUrl: config.visionBaseUrl,
        visionBaseUrlMode: config.visionBaseUrlMode || "auto",
        visionApiKey: config.visionApiKey,
        visionRequestMethod: config.visionRequestMethod,
        visionModel: config.visionModel,
        maxContextTokens: config.maxContextTokens,
        maxTokens: config.maxTokens,
        streamIdleTimeoutSec: config.streamIdleTimeoutSec,
        enableAutoCompress: config.enableAutoCompress,
        autoCompressThreshold: config.autoCompressThreshold,
        maxRetries: config.maxRetries,
        retryBaseDelayMs: config.retryBaseDelayMs,
        partialRetryMaxChars: config.partialRetryMaxChars,
        systemPromptIdsJson: config.systemPromptIdsJson ?? "",
        customHeaderSchemeId: config.customHeaderSchemeId ?? "",
        configJson: config.configJson,
        source: config.source,
      });
      const orderedNames = moveApiConfigName(
        list.map((item) => item.profileName),
        profileName,
        config.profileName,
        "after",
      );
      setConfigs(await window.snow.reorderApiConfigs([...orderedNames]));
      setStatus(
        t("settings.apiDuplicateSuccess", {
          defaultValue: "Duplicated API profile {name}.",
        }).replace("{name}", displayName),
      );
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.apiDuplicateError", {
              defaultValue: "Failed to duplicate API config",
            }),
      );
    } finally {
      setIsSaving(false);
    }
  };

  const handleToggleActive = async (config: ApiConfigRecord) => {
    if (config.isActive) return;

    setError("");
    setStatus("");

    try {
      const list = await window.snow.upsertApiConfig({
        profileName: config.profileName,
        displayName: config.displayName,
        isActive: true,
        baseUrl: config.baseUrl,
        baseUrlMode: config.baseUrlMode,
        apiKey: "",
        requestMethod: config.requestMethod,
        advancedModel: config.advancedModel,
        basicModel: config.basicModel,
        supportsVision: config.supportsVision,
        visionBaseUrl: config.visionBaseUrl,
        visionBaseUrlMode: config.visionBaseUrlMode || "auto",
        visionApiKey: "",
        visionRequestMethod: config.visionRequestMethod,
        visionModel: config.visionModel,
        maxContextTokens: config.maxContextTokens,
        maxTokens: config.maxTokens,
        streamIdleTimeoutSec: config.streamIdleTimeoutSec,
        enableAutoCompress: config.enableAutoCompress,
        autoCompressThreshold: config.autoCompressThreshold,
        maxRetries: config.maxRetries,
        retryBaseDelayMs: config.retryBaseDelayMs,
        partialRetryMaxChars: config.partialRetryMaxChars,
        systemPromptIdsJson: config.systemPromptIdsJson ?? "",
        customHeaderSchemeId: config.customHeaderSchemeId ?? "",
        configJson: config.configJson,
        source: config.source,
      });
      setConfigs(list);
      setStatus(
        t("settings.apiActivateSuccess", {
          defaultValue: "Activated {name}.",
        }).replace("{name}", config.displayName),
      );
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.apiActivateError", {
              defaultValue: "Failed to activate API config",
            }),
      );
    }
  };

  return (
    <div className="api-settings-page api-settings-tree-page" role="region">
      <div className="import-settings-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "llm"}
          className={`import-settings-tab ${activeTab === "llm" ? "active" : ""}`}
          onClick={() => setActiveTab("llm")}
        >
          <Bot size={13} strokeWidth={1.8} />
          {t("settings.apiTabLlmModels", { defaultValue: "LLM models" })}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "imagegen"}
          className={`import-settings-tab ${
            activeTab === "imagegen" ? "active" : ""
          }`}
          onClick={() => setActiveTab("imagegen")}
        >
          <ImageIcon size={13} strokeWidth={1.8} />
          {t("settings.apiTabImageModels", { defaultValue: "Image models" })}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "decision"}
          className={`import-settings-tab ${
            activeTab === "decision" ? "active" : ""
          }`}
          onClick={() => setActiveTab("decision")}
        >
          <BrainCircuit size={13} strokeWidth={1.8} />
          {t("settings.apiTabDecisionModels", {
            defaultValue: "Decision models",
          })}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "embedding"}
          className={`import-settings-tab ${
            activeTab === "embedding" ? "active" : ""
          }`}
          onClick={() => setActiveTab("embedding")}
        >
          <Network size={13} strokeWidth={1.8} />
          {t("settings.apiTabEmbeddingModels", {
            defaultValue: "Embedding models",
          })}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "reranking"}
          className={`import-settings-tab ${
            activeTab === "reranking" ? "active" : ""
          }`}
          onClick={() => setActiveTab("reranking")}
        >
          <ListOrdered size={13} strokeWidth={1.8} />
          {t("settings.apiTabRerankingModels", {
            defaultValue: "Reranking models",
          })}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "retry"}
          className={`import-settings-tab ${
            activeTab === "retry" ? "active" : ""
          }`}
          onClick={() => setActiveTab("retry")}
        >
          <RotateCcw size={13} strokeWidth={1.8} />
          {t("settings.apiTabRetry", { defaultValue: "Retry policy" })}
        </button>
      </div>

      {activeTab === "llm" ? (
        <>
          <ApiSettingsSummary configs={configs} />
          <ApiSettingsActions
            isBusy={isBusy}
            isLoading={isLoading}
            isImporting={isImporting}
            showAddForm={showAddForm}
            onImport={() => void handleImport()}
            onImportFile={() => void handleImportFile()}
            onOAuthLogin={() => setShowOAuthLogin(true)}
            onToggleAddForm={toggleAddForm}
          />

          <AutoDismissNotice
            message={error || status}
            tone={error ? "error" : "success"}
            onDismiss={() => {
              setError("");
              setStatus("");
            }}
          />

          <ApiSettingsTable
            configs={configs}
            isLoading={isLoading}
            isBusy={isBusy}
            onDuplicate={(config) => void handleDuplicate(config)}
            onEdit={setEditingConfig}
            onDelete={(profileName, displayName) =>
              void handleDelete(profileName, displayName)
            }
            onToggleActive={(config) => void handleToggleActive(config)}
            onExportSelected={(profileNames) =>
              void handleExportSelected(profileNames)
            }
            onDeleteSelected={(profileNames) =>
              void handleDeleteSelected(profileNames)
            }
            onReorder={(orderedNames) => void handleReorder(orderedNames)}
          />
        </>
      ) : activeTab === "imagegen" ? (
        <ImageGenSettingsPanel />
      ) : activeTab === "decision" ? (
        <DecisionModelsPanel />
      ) : activeTab === "embedding" ? (
        <CodebaseModelsPanel key="embedding" kind="embedding" />
      ) : activeTab === "reranking" ? (
        <CodebaseModelsPanel key="reranking" kind="reranking" />
      ) : (
        <RetrySettingsPanel />
      )}

      <Modal
        open={showAddForm}
        title={t("settings.apiManualFormTitle", {
          defaultValue: "Manual API profile",
        })}
        description={t("settings.apiManualFormInfo", {
          defaultValue: "Add a provider without importing Snow CLI profiles.",
        })}
        closeLabel={t("settings.cancel", { defaultValue: "Cancel" })}
        onClose={toggleAddForm}
        closeDisabled={isBusy}
        size="large"
        className="api-settings-editor-modal"
        footer={
          <ApiSettingsFormActions
            isSaving={isSaving}
            onCancel={toggleAddForm}
            onSave={() => void handleAddSubmit()}
            saveLabel={t("settings.saveApiConfig", {
              defaultValue: "Save API profile",
            })}
            asForm
          />
        }
      >
        <ApiSettingsFormPanel
          data={addForm}
          isSaving={isSaving}
          onChange={onFieldChange}
          onCancel={toggleAddForm}
          onSave={() => void handleAddSubmit()}
          saveLabel={t("settings.saveApiConfig", {
            defaultValue: "Save API profile",
          })}
          asForm
        />
      </Modal>

      <Modal
        open={pendingImport !== null}
        title={t("settings.apiImportPreviewTitle", {
          defaultValue: "Import API profiles",
        })}
        description={t("settings.apiImportPreviewInfo", {
          defaultValue:
            "{count} profile(s) in the file, {conflict} share a name with an existing profile.",
        })
          .replace("{count}", String(pendingImport?.totalCount ?? 0))
          .replace(
            "{conflict}",
            String((pendingImport?.conflictNames ?? []).length),
          )}
        closeLabel={t("settings.cancel", { defaultValue: "Cancel" })}
        onClose={() => setPendingImport(null)}
        closeDisabled={isSaving}
        footer={
          <>
            <button
              className="api-settings-form-btn secondary"
              onClick={() => setPendingImport(null)}
              type="button"
              disabled={isSaving}
            >
              <X size={15} strokeWidth={1.9} />
              <span>{t("settings.cancel", { defaultValue: "Cancel" })}</span>
            </button>
            <button
              className="api-settings-form-btn secondary"
              onClick={() =>
                pendingImport &&
                void applyImport(pendingImport.filePath, "duplicate")
              }
              type="button"
              disabled={isSaving}
            >
              <Copy size={15} strokeWidth={1.9} />
              <span>
                {t("settings.apiImportDuplicate", {
                  defaultValue: "Keep both as copies",
                })}
              </span>
            </button>
            <button
              className="api-settings-form-btn primary"
              onClick={() =>
                pendingImport &&
                void applyImport(pendingImport.filePath, "overwrite")
              }
              type="button"
              disabled={isSaving}
            >
              <AlertTriangle size={15} strokeWidth={1.9} />
              <span>
                {t("settings.apiImportOverwrite", {
                  defaultValue: "Overwrite existing",
                })}
              </span>
            </button>
          </>
        }
      >
        <div className="api-settings-import-conflict">
          <span>
            {t("settings.apiImportConflictHint", {
              defaultValue: "Choose how to handle the duplicated names:",
            })}
          </span>
          <ul>
            {pendingImport?.conflictNames
              .slice(0, MAX_LISTED_CONFLICTS)
              .map((profileName) => (
                <li key={profileName}>{profileName}</li>
              ))}
            {pendingImport &&
              pendingImport.conflictNames.length > MAX_LISTED_CONFLICTS && (
                <li>
                  +{pendingImport.conflictNames.length - MAX_LISTED_CONFLICTS}
                </li>
              )}
          </ul>
        </div>
      </Modal>

      <OAuthLoginDialog
        open={showOAuthLogin}
        onClose={() => setShowOAuthLogin(false)}
        onCompleted={(result) => {
          setError("");
          setStatus(
            t("settings.oauthCompleted", {
              defaultValue:
                "Signed in successfully. Channel {name} is now active.",
            }).replace(
              "{name}",
              result.displayName || result.profileName || "OAuth",
            ),
          );
          void load();
        }}
      />

      <ApiSettingsEditModal
        config={editingConfig}
        onClose={() => setEditingConfig(null)}
        onSaved={(list, profileName) => {
          setConfigs(list);
          setEditingConfig(null);
          setStatus(
            t("settings.apiEditSuccess", {
              defaultValue: "Updated API profile {name}.",
            }).replace("{name}", profileName),
          );
        }}
      />
    </div>
  );
}
