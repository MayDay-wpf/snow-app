import { Loader2, Save, X } from "lucide-react";
import { useI18n } from "../../../i18n";
import type { ApiConfigRecord } from "../../../../preload";
import { ApiSettingsFormFields } from "./ApiSettingsFormFields";
import type { ApiConfigFormData } from "./types";

type ApiSettingsFormPanelProps = {
  data: ApiConfigFormData;
  isSaving: boolean;
  onChange: (field: keyof ApiConfigFormData, value: string | boolean) => void;
  onCancel: () => void;
  onSave: () => void;
  saveLabel: string;
  asForm?: boolean;
  /** 已保存的配置（编辑时传入），用于展示 OAuth 配额。 */
  savedConfig?: ApiConfigRecord | null;
  /** 传入时显示系统提示词 / 自定义请求头设置页直达入口，跳转前调用。 */
  onSettingsJump?: () => void;
};

export function ApiSettingsFormPanel({
  data,
  isSaving,
  onChange,
  onCancel,
  onSave,
  saveLabel,
  asForm = false,
  savedConfig = null,
  onSettingsJump,
}: ApiSettingsFormPanelProps): React.JSX.Element {
  const { t } = useI18n();
  const fields = (
    <ApiSettingsFormFields
      data={data}
      onChange={onChange}
      disabled={isSaving}
      savedConfig={savedConfig}
      onSettingsJump={onSettingsJump}
    />
  );

  if (asForm) {
    return (
      <form
        id="api-settings-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSave();
        }}
      >
        {fields}
      </form>
    );
  }

  return fields;
}

type ApiSettingsFormActionsProps = {
  isSaving: boolean;
  onCancel: () => void;
  onSave: () => void;
  saveLabel: string;
  asForm?: boolean;
};

export function ApiSettingsFormActions({
  isSaving,
  onCancel,
  onSave,
  saveLabel,
  asForm = false,
}: ApiSettingsFormActionsProps): React.JSX.Element {
  const { t } = useI18n();
  return (
    <>
      <button
        className="api-settings-form-btn secondary"
        onClick={onCancel}
        type="button"
        disabled={isSaving}
      >
        <X size={15} strokeWidth={1.9} />
        <span>{t("settings.cancel", { defaultValue: "Cancel" })}</span>
      </button>
      <button
        className="api-settings-form-btn primary"
        onClick={asForm ? undefined : onSave}
        type={asForm ? "submit" : "button"}
        form={asForm ? "api-settings-form" : undefined}
        disabled={isSaving}
      >
        {isSaving ? (
          <Loader2 size={15} className="spin" />
        ) : (
          <Save size={15} strokeWidth={1.9} />
        )}
        <span>{saveLabel}</span>
      </button>
    </>
  );
}
