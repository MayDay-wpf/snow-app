import { Monitor, Type, Zap } from "lucide-react";
import { useI18n } from "../../../i18n";
import type { TerminalSettingsValue } from "./types";

type TerminalSettingsSummaryProps = {
  preview: TerminalSettingsValue;
};

export function TerminalSettingsSummary({
  preview,
}: TerminalSettingsSummaryProps): React.JSX.Element {
  const { t } = useI18n();

  const shellLabel =
    preview.shellPath ||
    t("settings.terminalShellAuto", { defaultValue: "Auto" });

  return (
    <div className="api-settings-summary-grid">
      <div className="api-settings-summary-card">
        <Monitor size={15} strokeWidth={1.8} />
        <span>{shellLabel}</span>
        <small>{t("settings.terminalShell", { defaultValue: "Shell" })}</small>
      </div>
      <div className="api-settings-summary-card">
        <Type size={15} strokeWidth={1.8} />
        <span>
          {preview.fontFamily ||
            t("settings.terminalFontDefault", { defaultValue: "Default" })}
        </span>
        <small>
          {t("settings.terminalFontSize", { defaultValue: "Font size" })}:{" "}
          {preview.fontSize}
        </small>
      </div>
      <div className="api-settings-summary-card">
        <Zap size={15} strokeWidth={1.8} />
        <span>
          {t(preview.gpuRendering ? "settings.enabled" : "settings.disabled")}
        </span>
        <small>
          {t("settings.terminalGpuRendering", {
            defaultValue: "GPU rendering (WebGL)",
          })}
        </small>
      </div>
    </div>
  );
}
