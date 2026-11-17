import { Trash2, Upload, X } from "lucide-react";
import { useI18n } from "../../../i18n";

type ApiSettingsSelectionBarProps = {
  count: number;
  isBusy: boolean;
  onExport: () => void;
  onDelete: () => void;
  onClear: () => void;
};

/** API 设置页各表格通用的多选操作栏：导出 / 删除 / 清空选择。 */
export function ApiSettingsSelectionBar({
  count,
  isBusy,
  onExport,
  onDelete,
  onClear,
}: ApiSettingsSelectionBarProps): React.JSX.Element | null {
  const { t } = useI18n();

  if (count === 0) {
    return null;
  }

  return (
    <div className="api-settings-selection-bar">
      <span>
        {t("settings.apiSelectedCount", {
          defaultValue: "{count} selected",
        }).replace("{count}", String(count))}
      </span>
      <div className="api-settings-selection-bar-actions">
        <button
          className="api-settings-action-btn primary"
          onClick={onExport}
          type="button"
          disabled={isBusy}
        >
          <Upload size={14} strokeWidth={1.8} />
          <span>
            {t("settings.apiExportSelected", {
              defaultValue: "Export selected",
            })}
          </span>
        </button>
        <button
          className="api-settings-action-btn danger"
          onClick={onDelete}
          type="button"
          disabled={isBusy}
        >
          <Trash2 size={14} strokeWidth={1.8} />
          <span>
            {t("settings.apiDeleteSelected", {
              defaultValue: "Delete selected",
            })}
          </span>
        </button>
        <button
          className="icon-btn ghost"
          onClick={onClear}
          type="button"
          title={t("settings.clearSelection", {
            defaultValue: "Clear selection",
          })}
          aria-label={t("settings.clearSelection", {
            defaultValue: "Clear selection",
          })}
        >
          <X size={13} strokeWidth={1.8} />
        </button>
      </div>
    </div>
  );
}
