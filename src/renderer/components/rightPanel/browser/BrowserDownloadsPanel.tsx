import { Download, FileText, FolderOpen, X, Check } from "lucide-react";
import type { BrowserDownloadItemEvent } from "../../../../preload/modules/systemApi";
import { useI18n } from "../../../i18n";

export type BrowserDownloadsPanelProps = {
  items: BrowserDownloadItemEvent[];
  onOpen: (id: number) => void;
  onShowInFolder: (id: number) => void;
  onCancel: (id: number) => void;
  onClose: () => void;
};

const formatBytes = (bytes: number): string => {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
};

/**
 * 浏览器工具栏的下载列表面板：进度、打开文件、打开所在目录、取消。
 */
export const BrowserDownloadsPanel = ({
  items,
  onOpen,
  onShowInFolder,
  onCancel,
  onClose,
}: BrowserDownloadsPanelProps): React.JSX.Element => {
  const { t } = useI18n();

  return (
    <div className="browser-downloads-panel">
      <div className="browser-downloads-header">
        <span>{t("browser.downloadsTitle")}</span>
        <button
          type="button"
          className="browser-downloads-close"
          onClick={onClose}
          aria-label={t("common.close")}
        >
          <X size={12} strokeWidth={2} />
        </button>
      </div>
      {items.length === 0 ? (
        <div className="browser-downloads-empty">
          <Download size={20} strokeWidth={1.5} />
          <span>{t("browser.downloadsEmpty")}</span>
        </div>
      ) : (
        <div className="browser-downloads-list">
          {items.map((item) => {
            const isActive = item.state === "progressing";
            const percent =
              item.totalBytes > 0
                ? Math.min(
                    100,
                    Math.round((item.receivedBytes / item.totalBytes) * 100),
                  )
                : null;
            return (
              <div key={item.id} className="browser-download-item">
                <div className="browser-download-icon">
                  {item.state === "completed" ? (
                    <Check size={14} strokeWidth={2} />
                  ) : (
                    <FileText size={14} strokeWidth={1.8} />
                  )}
                </div>
                <div className="browser-download-info">
                  <div className="browser-download-name" title={item.filename}>
                    {item.filename || item.url}
                  </div>
                  {isActive ? (
                    <>
                      <div className="browser-download-progress">
                        <div
                          className="browser-download-progress-bar"
                          style={{
                            width:
                              percent !== null ? `${percent}%` : "30%",
                          }}
                        />
                      </div>
                      <div className="browser-download-meta">
                        {percent !== null ? `${percent}%` : ""}
                        {item.totalBytes > 0
                          ? ` · ${formatBytes(item.receivedBytes)} / ${formatBytes(item.totalBytes)}`
                          : item.receivedBytes > 0
                            ? ` · ${formatBytes(item.receivedBytes)}`
                            : ""}
                      </div>
                    </>
                  ) : (
                    <div className="browser-download-meta">
                      {item.state === "completed"
                        ? formatBytes(item.totalBytes || item.receivedBytes)
                        : item.state === "cancelled"
                          ? t("browser.downloadCancelled")
                          : t("browser.downloadFailed")}
                    </div>
                  )}
                </div>
                <div className="browser-download-actions">
                  {item.state === "completed" && item.path && (
                    <>
                      <button
                        type="button"
                        className="browser-download-action"
                        title={t("browser.openFile")}
                        onClick={() => onOpen(item.id)}
                      >
                        {t("browser.openFile")}
                      </button>
                      <button
                        type="button"
                        className="browser-download-action"
                        title={t("browser.showInFolder")}
                        onClick={() => onShowInFolder(item.id)}
                      >
                        <FolderOpen size={13} strokeWidth={1.8} />
                      </button>
                    </>
                  )}
                  {isActive && (
                    <button
                      type="button"
                      className="browser-download-action"
                      title={t("browser.downloadCancel")}
                      onClick={() => onCancel(item.id)}
                    >
                      <X size={13} strokeWidth={2} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
