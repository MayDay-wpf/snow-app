import { useEffect, useState } from "react";
import { useI18n } from "../../../i18n";
import type { ApiConfigRecord } from "../../../../preload";
import { AutoDismissNotice } from "../../AutoDismissNotice";
import { Modal } from "../../common/Modal";
import {
  ApiSettingsFormActions,
  ApiSettingsFormPanel,
} from "./ApiSettingsFormPanel";
import { apiConfigToForm, toApiConfigPayload } from "./apiSettingsUtils";
import type { ApiConfigFormData } from "./types";

/** 后端 profile_name 唯一约束冲突的错误特征（本地列表过期时兜底识别）。 */
const DUPLICATE_PROFILE_NAME_ERROR =
  "UNIQUE constraint failed: api_configs.profile_name";

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
  /** 配置名重复的弹出提示（与表单内联错误分开，避免复用异常原文）。 */
  const [notice, setNotice] = useState("");

  // 打开时用最新配置列表做"至少一个启用"校验，并从待编辑配置初始化表单
  useEffect(() => {
    if (!config) {
      setEditForm(null);
      setError("");
      setNotice("");
      setIsSaving(false);
      return;
    }
    setError("");
    setNotice("");
    setIsSaving(false);
    setEditForm(apiConfigToForm(config));
    void window.snow
      .listApiConfigs()
      .then(setConfigs)
      .catch(() => setConfigs([]));
  }, [config]);

  const onFieldChange = (
    field: keyof ApiConfigFormData,
    value: string | boolean,
  ): void => {
    if (field === "isActive" && value === false) {
      const profileName = editForm?.profileName;
      const willKeepAnotherActive = configs.some(
        (item) => item.isActive && item.profileName !== profileName,
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
    // 函数式更新：单次交互可能连续触发多个字段的 onChange
    // （如 1M 上下文开关同时更新 oneMContext 与两个模型名），
    // 非函数式展开会基于同一旧快照互相覆盖，导致部分字段丢失。
    setEditForm((previous) =>
      previous ? { ...previous, [field]: value } : previous,
    );
  };

  /** 配置名与其它档案重复时的提示文案。 */
  const duplicateNameNotice = (profileName: string): string =>
    t("settings.apiProfileNameExists", {
      defaultValue: 'Profile name "{{name}}" already exists.',
      values: { name: profileName },
    });

  const handleSave = async (): Promise<void> => {
    if (!editForm) return;

    const profileName = editForm.profileName.trim();
    if (!profileName) {
      setError(
        t("settings.apiManualProfileRequired", {
          defaultValue: "Profile name is required.",
        }),
      );
      return;
    }

    // 原档案名：重命名时用于把自身排除在重复判定之外
    const previousProfileName = config?.profileName;
    const isDuplicateName = configs.some(
      (item) =>
        item.profileName === profileName &&
        item.profileName !== previousProfileName,
    );
    if (isDuplicateName) {
      setError("");
      setNotice(duplicateNameNotice(profileName));
      return;
    }

    setIsSaving(true);
    setError("");
    setNotice("");

    try {
      const payload = toApiConfigPayload(
        editForm,
        editForm.isActive,
        configs.length,
        // 原档案的 source（如 oauth-<provider id>）是 OAuth 标记，保存时不能丢。
        config?.source,
      );
      // 配置名变化时携带原配置名,由后端在同一事务内完成原子重命名
      const list = await window.snow.upsertApiConfig(
        previousProfileName && previousProfileName !== profileName
          ? { ...payload, previousProfileName }
          : payload,
      );
      onSaved(list, profileName);
    } catch (e) {
      const message = e instanceof Error ? e.message : "";
      if (message.includes(DUPLICATE_PROFILE_NAME_ERROR)) {
        // 本地列表过期时后端仍可能撞唯一约束：转成与前端校验一致的友好提示
        setNotice(duplicateNameNotice(profileName));
      } else {
        setError(
          e instanceof Error
            ? e.message
            : t("settings.apiUpdateError", {
                defaultValue: "Failed to update API config",
              }),
        );
      }
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
      <AutoDismissNotice
        message={notice}
        tone="error"
        onDismiss={() => setNotice("")}
      />
      {error && <div className="api-settings-form-error">{error}</div>}
      {editForm && (
        <ApiSettingsFormPanel
          data={editForm}
          savedConfig={config}
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
