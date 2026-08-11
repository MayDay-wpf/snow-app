import { ExternalLink, X } from "lucide-react";

import { useI18n } from "../../i18n";
import { GitDiffView } from "../common/GitDiffView";
import { getFileTypeIcon } from "../../utils/fileIcons";
import type { GitDiffResult, GitFileContentResult, GitFileStatus, GitImageDiff } from "./git";
import type { OpenDiffTabCallback } from "./types";

type DiffViewerProps = {
  selectedFile: GitFileStatus;
  diffResult: GitDiffResult | null;
  diffLoading: boolean;
  /** 图片文件的旧/新版本预览数据；非图片文件为 null。 */
  imageDiff?: GitImageDiff | null;
  onOpenInTab?: OpenDiffTabCallback;
  onClose?: () => void;
};

/** 图片内容转 data URL（svg 为 utf8 文本，其余为 base64）。 */
const toDataUrl = (content: GitFileContentResult): string => {
  if (content.isSvg) {
    return `data:image/svg+xml;utf8,${encodeURIComponent(content.content)}`;
  }
  return `data:${content.mimeType};base64,${content.content}`;
};

const formatSize = (bytes: number): string => {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
};

function ImageDiffContent({
  imageDiff,
}: {
  imageDiff: GitImageDiff;
}): React.JSX.Element {
  const { t } = useI18n();
  const { old: oldContent, new: newContent } = imageDiff;

  if (!oldContent && !newContent) {
    return <div className="diff-viewer-binary">{t("rightPanel.binaryFile")}</div>;
  }

  const panels: { key: string; label: string; data: GitFileContentResult }[] = [];
  if (oldContent) {
    panels.push({ key: "old", label: t("rightPanel.imageDiffBefore"), data: oldContent });
  }
  if (newContent) {
    panels.push({ key: "new", label: t("rightPanel.imageDiffAfter"), data: newContent });
  }

  return (
    <div className={`diff-viewer-images${panels.length === 1 ? " single" : ""}`}>
      {panels.map((panel) => (
        <div key={panel.key} className="diff-viewer-image-panel">
          <div className="diff-viewer-image-panel-header">
            <span className="diff-viewer-image-panel-label">{panel.label}</span>
            <span className="diff-viewer-image-panel-meta">
              {formatSize(panel.data.size)}
            </span>
          </div>
          <div className="diff-viewer-image-canvas">
            <img
              src={toDataUrl(panel.data)}
              alt={panel.label}
              className="diff-viewer-image"
              draggable={false}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

export function DiffViewer({
  selectedFile,
  diffResult,
  diffLoading,
  imageDiff,
  onOpenInTab,
  onClose,
}: DiffViewerProps): React.JSX.Element {
  const { t } = useI18n();

  return (
    <div className="diff-viewer">
      <div className="diff-viewer-header">
        {getFileTypeIcon(
          selectedFile.path.split("/").pop() ?? selectedFile.path,
          false,
          false,
          { size: 14, className: "diff-viewer-file-icon" }
        )}
        <span className="diff-viewer-file-name" title={selectedFile.path}>
          {selectedFile.path}
        </span>
        {(onOpenInTab || onClose) && (
          <div className="diff-viewer-actions">
            {onOpenInTab && (
              <button
                type="button"
                className="icon-btn"
                title={t("rightPanel.openInNewTab")}
                aria-label={t("rightPanel.openInNewTab")}
                onClick={() =>
                  onOpenInTab(selectedFile, diffResult, diffLoading, imageDiff)
                }
              >
                <ExternalLink size={14} strokeWidth={1.8} />
              </button>
            )}
            {onClose && (
              <button
                type="button"
                className="icon-btn"
                title={t("rightPanel.closeDiff")}
                aria-label={t("rightPanel.closeDiff")}
                onClick={onClose}
              >
                <X size={14} strokeWidth={1.8} />
              </button>
            )}
          </div>
        )}
      </div>
      {diffLoading ? (
        <div className="diff-viewer-loading">{t("rightPanel.loadingDiff")}</div>
      ) : imageDiff ? (
        <ImageDiffContent imageDiff={imageDiff} />
      ) : diffResult?.isBinary ? (
        <div className="diff-viewer-binary">{t("rightPanel.binaryFile")}</div>
      ) : diffResult?.content ? (
        <div className="diff-viewer-content">
          <GitDiffView
            fileName={selectedFile.path}
            patch={diffResult.content}
          />
        </div>
      ) : (
        <div className="diff-viewer-empty">
          {t("rightPanel.noChangesToDisplay")}
        </div>
      )}
    </div>
  );
}
