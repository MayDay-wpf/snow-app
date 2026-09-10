import { Ban, Globe, MonitorCog, Route } from "lucide-react";
import { useI18n } from "../../../i18n";
import { getSearchEngineLabel, SearchEngineIcon } from "./SearchEngineIcon";
import type { ProxyBrowserSettingsValue } from "./types";

type ProxyBrowserSettingsSummaryProps = {
  preview: ProxyBrowserSettingsValue;
};

export function ProxyBrowserSettingsSummary({
  preview,
}: ProxyBrowserSettingsSummaryProps): React.JSX.Element {
  const { t } = useI18n();
  const proxyUrl = preview.enabled
    ? `http://${preview.host || "127.0.0.1"}:${preview.port}`
    : "-";
  const browserLabel =
    preview.browserPath ||
    t("settings.autoDetectBrowser", { defaultValue: "Auto detect" });

  return (
    <div className="api-settings-summary-grid proxy-browser-settings-summary-grid">
      <div className="api-settings-summary-card">
        <Globe size={15} strokeWidth={1.8} />
        <span>
          {preview.enabled
            ? t("settings.enabled", { defaultValue: "Enabled" })
            : t("settings.disabled", { defaultValue: "Disabled" })}
        </span>
        <small>{t("settings.proxyStatus", { defaultValue: "Proxy" })}</small>
      </div>
      <div className="api-settings-summary-card">
        <Route size={15} strokeWidth={1.8} />
        <span>{proxyUrl}</span>
        <small>
          {t("settings.proxyEndpoint", { defaultValue: "Proxy endpoint" })}
        </small>
      </div>
      <div className="api-settings-summary-card">
        <SearchEngineIcon value={preview.searchEngine} size={15} />
        <span>{getSearchEngineLabel(preview.searchEngine)}</span>
        <small>
          {t("settings.searchEngine", { defaultValue: "Search engine" })}
        </small>
      </div>
      <div className="api-settings-summary-card">
        <MonitorCog size={15} strokeWidth={1.8} />
        <span>{browserLabel}</span>
        <small>
          {t("settings.browserPath", {
            defaultValue: "Browser executable path",
          })}
        </small>
      </div>
      <div className="api-settings-summary-card">
        <Ban size={15} strokeWidth={1.8} />
        <span>
          {preview.blockedPatterns.length > 0
            ? preview.blockedPatterns.length
            : "-"}
        </span>
        <small>
          {t("settings.blockedRulesCount", {
            defaultValue: "Blocking rules",
          })}
        </small>
      </div>
    </div>
  );
}
