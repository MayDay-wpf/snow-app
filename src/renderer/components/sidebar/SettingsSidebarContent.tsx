import { ArrowLeft } from "lucide-react";
import { useI18n } from "../../i18n";
import { SETTINGS_ITEMS, SETTINGS_VIEW_IDS } from "./settingsItems";
import type { SidebarContentProps } from "./types";

export function SettingsSidebarContent({
  activeMainView,
  onSelectMainView,
  onSwitchContent,
}: SidebarContentProps): React.JSX.Element {
  const { t } = useI18n();

  const handleExitSettings = (): void => {
    onSwitchContent("main");

    if (SETTINGS_VIEW_IDS.has(activeMainView)) {
      onSelectMainView("chat");
    }
  };

  return (
    <>
      <div className="sidebar-content-header">
        <button
          className="icon-btn ghost"
          onClick={handleExitSettings}
          type="button"
          aria-label={t("settings.backToMain", {
            defaultValue: "Back to main sidebar",
          })}
        >
          <ArrowLeft size={16} strokeWidth={1.8} />
        </button>
        <span className="sidebar-content-title">
          {t("settings.title", { defaultValue: "Settings" })}
        </span>
      </div>

      <div className="settings-content">
        <div className="sidebar-section settings-menu-section">
          <div className="settings-list">
            {SETTINGS_ITEMS.map((item) => {
              // browser-devices（显示尺寸设备）是浏览器设置面板内部的 tab，
              // 侧栏仍高亮「浏览器设置」条目。
              const activeItemView =
                activeMainView === "browser-devices"
                  ? "browser-settings"
                  : activeMainView;
              const isActive = item.view === activeItemView;

              return (
                <button
                  key={item.id}
                  className={`settings-item ${isActive ? "active" : ""}`}
                  onClick={() => onSelectMainView(item.view)}
                  type="button"
                >
                  <item.icon
                    className="settings-item-icon"
                    size={16}
                    strokeWidth={1.8}
                  />
                  <span className="settings-item-content">
                    <span className="settings-item-title">
                      {t(item.labelKey, { defaultValue: item.defaultLabel })}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}
