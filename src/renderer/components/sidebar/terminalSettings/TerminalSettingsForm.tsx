import { RotateCcw } from "lucide-react";
import { type ChangeEvent, type FocusEvent } from "react";
import { useI18n } from "../../../i18n";
import { CustomSelect } from "../../common/CustomSelect";
import { FONT_WEIGHT_OPTIONS } from "./terminalSettingsConstants";
import { TerminalCombobox } from "./TerminalCombobox";
import type {
  DetectedTerminalOption,
  TerminalSettingsForm as TerminalSettingsFormValue,
} from "./types";

type TerminalSettingsFormProps = {
  form: TerminalSettingsFormValue;
  isBusy: boolean;
  isSelectingExecutable: boolean;
  detectedTerminals: DetectedTerminalOption[];
  onUpdateField: (
    field: keyof TerminalSettingsFormValue
  ) => (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => void;
  onSetValue: (field: keyof TerminalSettingsFormValue, value: string) => void;
  onShellPathChange: (value: string) => void;
  /** 传入 nextForm 时以该值保存（下拉选择后 state 尚未重渲染，需显式携带新值）。 */
  onBlurSave: (nextForm?: TerminalSettingsFormValue) => void;
  onReset: () => void;
  onSelectExecutable: () => void;
};

export function TerminalSettingsForm({
  form,
  isBusy,
  isSelectingExecutable,
  detectedTerminals,
  onUpdateField,
  onSetValue,
  onShellPathChange,
  onBlurSave,
  onReset,
  onSelectExecutable,
}: TerminalSettingsFormProps): React.JSX.Element {
  const { t } = useI18n();

  // 焦点移入下拉控件（字重下拉 / Shell 组合框）不算真正失焦，不触发保存；
  // 下拉控件完成选择后会携带新值主动保存。
  const handleInputBlur = (event: FocusEvent<HTMLInputElement>) => {
    const next = event.relatedTarget as HTMLElement | null;
    if (next?.closest(".custom-select, .terminal-combobox")) {
      return;
    }
    onBlurSave();
  };

  return (
    <div className="api-settings-manual-form">
      <div className="api-settings-manual-header">
        <strong>
          {t("settings.terminalManualTitle", {
            defaultValue: "Manual configuration",
          })}
        </strong>
        <span>
          {t("settings.terminalManualInfo", {
            defaultValue:
              "These values are saved in Snow App system settings and used when launching the integrated terminal.",
          })}
        </span>
      </div>

      <div className="api-settings-form-body">
        {/* ===== Shell ===== */}
        <div className="api-settings-form-section">
          <div className="api-settings-form-section-header">
            <strong className="api-settings-form-section-title">
              {t("settings.terminalSectionShell", { defaultValue: "Shell" })}
            </strong>
          </div>

          <div className="api-settings-form-grid">
            <TerminalCombobox
              value={form.shellPath}
              placeholder={t("settings.terminalShellPathPlaceholder", {
                defaultValue: "Leave empty to auto-detect",
              })}
              disabled={isBusy}
              isSelectingExecutable={isSelectingExecutable}
              detectedTerminals={detectedTerminals}
              browseLabel={t("settings.terminalSelectExecutable", {
                defaultValue: "Browse",
              })}
              emptyText={t("settings.terminalNoDetectedTerminals", {
                defaultValue: "No terminals detected",
              })}
              onChange={onShellPathChange}
              onCommit={(path) => {
                onShellPathChange(path);
                onBlurSave({ ...form, shellPath: path });
              }}
              onBlur={() => onBlurSave()}
              onBrowse={onSelectExecutable}
            />
          </div>
        </div>

        {/* ===== Font ===== */}
        <div className="api-settings-form-section">
          <div className="api-settings-form-section-header">
            <strong className="api-settings-form-section-title">
              {t("settings.terminalSectionFont", { defaultValue: "Font" })}
            </strong>
          </div>

          <div className="api-settings-form-grid">
            <label className="api-settings-field wide">
              <span>
                {t("settings.terminalFontFamily", {
                  defaultValue: "Font family",
                })}
              </span>
              <input
                value={form.fontFamily}
                onChange={onUpdateField("fontFamily")}
                onBlur={handleInputBlur}
                placeholder={t("settings.terminalFontFamilyPlaceholder", {
                  defaultValue: "e.g. Consolas, Monaco, monospace",
                })}
                disabled={isBusy}
              />
            </label>
            <label className="api-settings-field">
              <span>
                {t("settings.terminalFontSize", { defaultValue: "Font size" })}
              </span>
              <input
                value={form.fontSize}
                onChange={onUpdateField("fontSize")}
                onBlur={handleInputBlur}
                type="number"
                min={6}
                max={72}
                disabled={isBusy}
              />
            </label>
            <label className="api-settings-field">
              <span>
                {t("settings.terminalFontWeight", {
                  defaultValue: "Font weight",
                })}
              </span>
              <CustomSelect
                value={form.fontWeight}
                options={FONT_WEIGHT_OPTIONS}
                onChange={(value) => {
                  onSetValue("fontWeight", value);
                  onBlurSave({ ...form, fontWeight: value });
                }}
                disabled={isBusy}
              />
            </label>
            <label className="api-settings-field">
              <span>
                {t("settings.terminalLineHeight", {
                  defaultValue: "Line height",
                })}
              </span>
              <input
                value={form.lineHeight}
                onChange={onUpdateField("lineHeight")}
                onBlur={handleInputBlur}
                type="number"
                min={0.5}
                max={3}
                step={0.1}
                disabled={isBusy}
              />
            </label>
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
