import { useEffect, useState } from "react";
import { useI18n } from "../../../i18n";
import type { ApiConfigRecord } from "../../../../preload";
import { Modal } from "../../common/Modal";
import {
  ApiSettingsFormActions,
  ApiSettingsFormPanel,
} from "./ApiSettingsFormPanel";
import {
  DEFAULT_API_BASE_URL,
  DEFAULT_REQUEST_METHOD,
} from "./apiSettingsConstants";
import { calculateAutoCompressThresholdPercent } from "./autoCompressThreshold";
import {
  extractGoogleSearchFromConfigJson,
  extractOneMContextFromConfigJson,
  extractResponsesFastModeFromConfigJson,
  extractResponsesVerbosityFromConfigJson,
  extractThinkingValueFromConfigJson,
  extractToolResultTokenLimitFromConfigJson,
  extractVisionGoogleSearchFromConfigJson,
  extractVisionMaxConcurrencyFromConfigJson,
  extractVisionMaxTokensFromConfigJson,
  extractVisionThinkingEffortFromConfigJson,
  extractVisionThinkingEnabledFromConfigJson,
  toApiConfigPayload,
} from "./apiSettingsUtils";
import type { ApiConfigFormData } from "./types";

type ApiSettingsEditModalProps = {
  /** 当前编辑的配置；为 null 时弹窗关闭。 */
  config: ApiConfigRecord | null;
  onClose: () => void;
  /** 保存成功后回调（返回最新配置列表与保存后的 profileName）。 */
  onSaved: (configs: ApiConfigRecord[], profileName: string) => void;
};

/** API 配置编辑弹窗：与设置页表格的编辑共享同一份表单与保存逻辑。 */
export function ApiSettingsEditModal({
  config,
  onClose,
  onSaved,
}: ApiSettingsEditModalProps): React.JSX.Element {
  const { t } = useI18n();
  const [configs, setConfigs] = useState<ApiConfigRecord[]>([]);
  const [editForm, setEditForm] = useState<ApiConfigFormData | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");

  // 打开时用最新配置列表做"至少一个启用"校验，并从待编辑配置初始化表单
  useEffect(() => {
    if (!config) {
      setEditForm(null);
      setError("");
      setIsSaving(false);
      return;
    }
    setError("");
    setIsSaving(false);
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
      visionRequestMethod:
        config.visionRequestMethod || DEFAULT_REQUEST_METHOD,
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
      toolResultTokenLimit: extractToolResultTokenLimitFromConfigJson(
        config.configJson
      ),
      maxRetries: config.maxRetries != null ? String(config.maxRetries) : "",
      retryBaseDelayMs:
        config.retryBaseDelayMs != null ? String(config.retryBaseDelayMs) : "",
      partialRetryMaxChars:
        config.partialRetryMaxChars != null
          ? String(config.partialRetryMaxChars)
          : "",
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
      oneMContext: extractOneMContextFromConfigJson(config.configJson),
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
      visionMaxConcurrency: extractVisionMaxConcurrencyFromConfigJson(
        config.configJson
      ),
      configJson: config.configJson,
    });
    void window.snow
      .listApiConfigs()
      .then(setConfigs)
      .catch(() => setConfigs([]));
  }, [config]);

  const onFieldChange = (
    field: keyof ApiConfigFormData,
    value: string | boolean
  ): void => {
    if (field === "isActive" && value === false) {
      const profileName = editForm?.profileName;
      const willKeepAnotherActive = configs.some(
        (item) => item.isActive && item.profileName !== profileName
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
    // 函数式更新：单次交互可能连续触发多个字段的 onChange
    // （如 1M 上下文开关同时更新 oneMContext 与两个模型名），
    // 非函数式展开会基于同一旧快照互相覆盖，导致部分字段丢失。
    setEditForm((previous) =>
      previous ? { ...previous, [field]: value } : previous
    );
  };

  const handleSave = async (): Promise<void> => {
    if (!editForm) return;

    const profileName = editForm.profileName.trim();
    if (!profileName) {
      setError(
        t("settings.apiManualProfileRequired", {
          defaultValue: "Profile name is required.",
        })
      );
      return;
    }

    setIsSaving(true);
    setError("");

    try {
      const payload = toApiConfigPayload(
        editForm,
        editForm.isActive,
        configs.length
      );
      // 配置名变化时携带原配置名,由后端在同一事务内完成原子重命名
      const previousProfileName = config?.profileName;
      const list = await window.snow.upsertApiConfig(
        previousProfileName && previousProfileName !== profileName
          ? { ...payload, previousProfileName }
          : payload
      );
      onSaved(list, profileName);
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

  return (
    <Modal
      open={Boolean(config && editForm)}
      title={`${t("settings.apiEditTitle", {
        defaultValue: "Edit profile",
      })}: ${editForm?.profileName ?? ""}`}
      description={t("settings.apiEditInfo", {
        defaultValue: "Leave API key blank to keep the existing value.",
      })}
      closeLabel={t("settings.cancel", { defaultValue: "Cancel" })}
      onClose={onClose}
      closeDisabled={isSaving}
      size="large"
      className="api-settings-editor-modal"
      footer={
        editForm && (
          <ApiSettingsFormActions
            isSaving={isSaving}
            onCancel={onClose}
            onSave={() => void handleSave()}
            saveLabel={t("settings.saveApiConfig", {
              defaultValue: "Save API profile",
            })}
          />
        )
      }
    >
      {error && <div className="api-settings-form-error">{error}</div>}
      {editForm && (
        <ApiSettingsFormPanel
          data={editForm}
          isSaving={isSaving}
          onChange={onFieldChange}
          onCancel={onClose}
          onSave={() => void handleSave()}
          saveLabel={t("settings.saveApiConfig", {
            defaultValue: "Save API profile",
          })}
        />
      )}
    </Modal>
  );
}
