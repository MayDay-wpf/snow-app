import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";
import { AutoDismissNotice } from "../AutoDismissNotice";
import { Modal } from "../common/Modal";
import { useI18n } from "../../i18n";
import type { ApiConfigRecord } from "../../../preload";
import { ApiSettingsActions } from "./apiSettings/ApiSettingsActions";
import {
  ApiSettingsFormActions,
  ApiSettingsFormPanel,
} from "./apiSettings/ApiSettingsFormPanel";
import { ApiSettingsSummary } from "./apiSettings/ApiSettingsSummary";
import { ApiSettingsTable } from "./apiSettings/ApiSettingsTable";
import { buildDuplicateName } from "./duplicateName";
import {
  DEFAULT_API_BASE_URL,
  DEFAULT_REQUEST_METHOD,
} from "./apiSettings/apiSettingsConstants";
import {
  emptyApiConfigForm,
  extractGoogleSearchFromConfigJson,
  extractResponsesFastModeFromConfigJson,
  extractResponsesVerbosityFromConfigJson,
  extractThinkingValueFromConfigJson,
  extractVisionGoogleSearchFromConfigJson,
  extractVisionMaxTokensFromConfigJson,
  extractVisionThinkingEffortFromConfigJson,
  extractVisionThinkingEnabledFromConfigJson,
  toApiConfigPayload,
} from "./apiSettings/apiSettingsUtils";
import { calculateAutoCompressThresholdPercent } from "./apiSettings/autoCompressThreshold";
import type {
  ApiConfigFormData,
  ApiSettingsPanelProps,
} from "./apiSettings/types";

export function ApiSettingsTreePanel({
  onClose,
}: ApiSettingsPanelProps): React.JSX.Element {
  const { t } = useI18n();
  const [configs, setConfigs] = useState<ApiConfigRecord[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [addForm, setAddForm] = useState<ApiConfigFormData>(() =>
    emptyApiConfigForm(1, true)
  );
  const [editingProfileName, setEditingProfileName] = useState<string | null>(
    null
  );
  const [editForm, setEditForm] = useState<ApiConfigFormData | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  const isBusy = isLoading || isSaving;

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
            })
      );
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const onFieldChange =
    (form: "add" | "edit") =>
    (field: keyof ApiConfigFormData, value: string | boolean) => {
      if (field === "isActive" && value === false) {
        const currentForm = form === "add" ? addForm : editForm;
        const profileName = currentForm?.profileName;
        const willKeepAnotherActive = configs.some(
          (config) => config.isActive && config.profileName !== profileName
        );

        if (!willKeepAnotherActive) {
          setError(
            t("settings.apiAtLeastOneActive", {
              defaultValue: "At least one API profile must be enabled.",
            })
          );
          return;
        }
      }

      if (form === "add") {
        setAddForm((previous) => ({ ...previous, [field]: value }));
      } else if (editForm) {
        setEditForm({ ...editForm, [field]: value });
      }
    };

  const handleAddSubmit = async () => {
    if (!addForm.profileName.trim()) {
      setError(
        t("settings.apiManualProfileRequired", {
          defaultValue: "Profile name is required.",
        })
      );
      return;
    }

    setIsSaving(true);
    setError("");
    setStatus("");

    try {
      const list = await window.snow.upsertApiConfig(
        toApiConfigPayload(addForm, addForm.isActive, configs.length)
      );
      setConfigs(list);
      setAddForm(emptyApiConfigForm(list.length + 1, false));
      setShowAddForm(false);
      setStatus(
        t("settings.apiManualAddSuccess", {
          defaultValue: "Added API profile {name}.",
        }).replace("{name}", addForm.profileName.trim())
      );
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.apiAddError", {
              defaultValue: "Failed to add API config",
            })
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
          emptyApiConfigForm(configs.length + 1, configs.length === 0)
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
          result.configs.length === 0
        )
      );
      setStatus(
        t("settings.apiImportSuccess", {
          defaultValue: "Imported {count} Snow CLI profiles.",
        }).replace("{count}", result.importedCount.toString())
      );
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.apiImportError", {
              defaultValue: "Failed to import Snow CLI configs",
            })
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleDelete = async (profileName: string, displayName: string) => {
    setError("");
    setStatus("");

    try {
      const list = await window.snow.deleteApiConfig(profileName);
      setConfigs(list);
      setEditingProfileName(null);
      setEditForm(null);
      setStatus(
        t("settings.apiDeleteSuccess", {
          defaultValue: "Deleted API profile {name}.",
        }).replace("{name}", displayName)
      );
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.apiDeleteError", {
              defaultValue: "Failed to delete API config",
            })
      );
    }
  };

  const handleStartEdit = (config: ApiConfigRecord) => {
    setEditingProfileName(config.profileName);
    setShowAddForm(false);
    setError("");
    setStatus("");
    setEditForm({
      profileName: config.profileName,
      displayName: config.displayName,
      baseUrl: config.baseUrl || DEFAULT_API_BASE_URL,
      baseUrlMode: config.baseUrlMode || "auto",
      apiKey: config.apiKey || "",
      requestMethod: config.requestMethod || DEFAULT_REQUEST_METHOD,
      advancedModel: config.advancedModel || "",
      basicModel: config.basicModel || "",
      isActive: config.isActive,
      supportsVision: config.supportsVision,
      visionBaseUrl: config.visionBaseUrl || "",
      visionApiKey: config.visionApiKey || "",
      visionRequestMethod: config.visionRequestMethod || DEFAULT_REQUEST_METHOD,
      visionModel: config.visionModel || "",
      maxContextTokens:
        config.maxContextTokens != null ? String(config.maxContextTokens) : "",
      maxTokens: config.maxTokens != null ? String(config.maxTokens) : "",
      streamIdleTimeoutSec:
        config.streamIdleTimeoutSec != null
          ? String(config.streamIdleTimeoutSec)
          : "",
      enableAutoCompress: config.enableAutoCompress ?? true,
      autoCompressThreshold: calculateAutoCompressThresholdPercent(
        config.maxContextTokens,
        config.autoCompressThreshold
      ),
      maxRetries: config.maxRetries != null ? String(config.maxRetries) : "",
      retryBaseDelayMs:
        config.retryBaseDelayMs != null ? String(config.retryBaseDelayMs) : "",
      systemPromptIdsJson: config.systemPromptIdsJson ?? "",
      customHeaderSchemeId: config.customHeaderSchemeId ?? "",
      thinkingValue: extractThinkingValueFromConfigJson(
        config.configJson,
        config.requestMethod || DEFAULT_REQUEST_METHOD
      ),
      responsesVerbosity: extractResponsesVerbosityFromConfigJson(
        config.configJson
      ),
      responsesFastMode: extractResponsesFastModeFromConfigJson(
        config.configJson
      ),
      googleSearch: extractGoogleSearchFromConfigJson(config.configJson),
      visionGoogleSearch: extractVisionGoogleSearchFromConfigJson(
        config.configJson
      ),
      visionThinkingEnabled: extractVisionThinkingEnabledFromConfigJson(
        config.configJson
      ),
      visionThinkingEffort: extractVisionThinkingEffortFromConfigJson(
        config.configJson
      ),
      visionMaxTokens: extractVisionMaxTokensFromConfigJson(config.configJson),
      configJson: config.configJson,
    });
  };

  const handleSaveEdit = async () => {
    if (!editForm) return;

    setIsSaving(true);
    setError("");
    setStatus("");

    try {
      const list = await window.snow.upsertApiConfig(
        toApiConfigPayload(editForm, editForm.isActive, configs.length)
      );
      setConfigs(list);
      setEditingProfileName(null);
      setEditForm(null);
      setStatus(
        t("settings.apiEditSuccess", {
          defaultValue: "Updated API profile {name}.",
        }).replace("{name}", editForm.profileName)
      );
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.apiUpdateError", {
              defaultValue: "Failed to update API config",
            })
      );
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancelEdit = () => {
    setEditingProfileName(null);
    setEditForm(null);
  };

  const handleDuplicate = async (config: ApiConfigRecord) => {
    setError("");
    setStatus("");

    // 命名规则：*-Copy-n（n 为递增数字，避免与既有 profileName/displayName 冲突）。
    const profileName = buildDuplicateName(
      config.profileName,
      configs.map((item) => item.profileName)
    );
    const displayName = buildDuplicateName(
      config.displayName || config.profileName,
      configs.map((item) => item.displayName)
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
        systemPromptIdsJson: config.systemPromptIdsJson ?? "",
        customHeaderSchemeId: config.customHeaderSchemeId ?? "",
        configJson: config.configJson,
        source: config.source,
      });
      setConfigs(list);
      setStatus(
        t("settings.apiDuplicateSuccess", {
          defaultValue: "Duplicated API profile {name}.",
        }).replace("{name}", displayName)
      );
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.apiDuplicateError", {
              defaultValue: "Failed to duplicate API config",
            })
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
        systemPromptIdsJson: config.systemPromptIdsJson ?? "",
        customHeaderSchemeId: config.customHeaderSchemeId ?? "",
        configJson: config.configJson,
        source: config.source,
      });
      setConfigs(list);
      setStatus(
        t("settings.apiActivateSuccess", {
          defaultValue: "Activated {name}.",
        }).replace("{name}", config.displayName)
      );
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.apiActivateError", {
              defaultValue: "Failed to activate API config",
            })
      );
    }
  };

  return (
    <div className="api-settings-page" role="region">
      <div className="api-settings-page-header">
        <div className="api-settings-title-group">
          <strong>
            {t("settings.apiTreeTitle", { defaultValue: "API configuration" })}
          </strong>
          <span className="settings-item-description">
            {t("settings.apiSettingsInfo", {
              defaultValue: "Configure providers, models, and credentials.",
            })}
          </span>
        </div>
        {onClose && (
          <button
            className="icon-btn ghost"
            onClick={onClose}
            type="button"
            aria-label={t("settings.closeApiSettings", {
              defaultValue: "Close API settings",
            })}
            title={t("settings.closeApiSettings", {
              defaultValue: "Close API settings",
            })}
          >
            <X size={15} strokeWidth={1.8} />
          </button>
        )}
      </div>

      <ApiSettingsSummary configs={configs} />
      <ApiSettingsActions
        isBusy={isBusy}
        isLoading={isLoading}
        showAddForm={showAddForm}
        onImport={() => void handleImport()}
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
        onDuplicate={(config) => void handleDuplicate(config)}
        onEdit={handleStartEdit}
        onDelete={(profileName, displayName) =>
          void handleDelete(profileName, displayName)
        }
        onToggleActive={(config) => void handleToggleActive(config)}
      />

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
          isNew
          onChange={onFieldChange("add")}
          onCancel={toggleAddForm}
          onSave={() => void handleAddSubmit()}
          saveLabel={t("settings.saveApiConfig", {
            defaultValue: "Save API profile",
          })}
          asForm
        />
      </Modal>

      <Modal
        open={Boolean(editingProfileName && editForm)}
        title={`${t("settings.apiEditTitle", {
          defaultValue: "Edit profile",
        })}: ${editForm?.profileName ?? ""}`}
        description={t("settings.apiEditInfo", {
          defaultValue: "Leave API key blank to keep the existing value.",
        })}
        closeLabel={t("settings.cancel", { defaultValue: "Cancel" })}
        onClose={handleCancelEdit}
        closeDisabled={isBusy}
        size="large"
        className="api-settings-editor-modal"
        footer={
          editForm && (
            <ApiSettingsFormActions
              isSaving={isSaving}
              onCancel={handleCancelEdit}
              onSave={() => void handleSaveEdit()}
              saveLabel={t("settings.saveApiConfig", {
                defaultValue: "Save API profile",
              })}
            />
          )
        }
      >
        {editForm && (
          <ApiSettingsFormPanel
            data={editForm}
            isSaving={isSaving}
            isNew={false}
            onChange={onFieldChange("edit")}
            onCancel={handleCancelEdit}
            onSave={() => void handleSaveEdit()}
            saveLabel={t("settings.saveApiConfig", {
              defaultValue: "Save API profile",
            })}
          />
        )}
      </Modal>
    </div>
  );
}
