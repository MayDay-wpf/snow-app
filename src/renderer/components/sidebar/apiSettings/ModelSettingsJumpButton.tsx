import { Settings } from "lucide-react";
import { useI18n } from "../../../i18n";
import { openApiSettingsTab } from "./apiSettingsTabRequest";
import type { ApiSettingsTab } from "./types";

type ModelSettingsJumpButtonProps = {
  /** 目标标签页：模型在哪维护就跳到哪一个。 */
  tab: ApiSettingsTab;
  disabled?: boolean;
};

/** 模型下拉旁的直达入口：API 设置页对应标签页维护模型。 */
export function ModelSettingsJumpButton({
  tab,
  disabled = false,
}: ModelSettingsJumpButtonProps): React.JSX.Element {
  const { t } = useI18n();

  return (
    <button
      className="model-settings-jump"
      type="button"
      disabled={disabled}
      onClick={() => openApiSettingsTab(tab)}
    >
      <Settings size={11} strokeWidth={1.9} aria-hidden="true" />
      {t("settings.modelSelectOpenApiSettings", {
        defaultValue: "Open API settings",
      })}
    </button>
  );
}
