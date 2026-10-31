import { useMemo, useState } from "react";
import { Check, Columns2, Rows3, Send, Trash2, WrapText } from "lucide-react";

import { useI18n } from "../../i18n";
import { GitDiffView, type DiffCommentContext } from "../common/GitDiffView";
import { buildAllCommentsMessage } from "../common/DiffComments";
import {
  setDiffViewMode,
  setDiffWrapLines,
  useDiffViewMode,
  useDiffWrapLines,
} from "../common/diffViewPreferences";
import { getFileTypeIcon } from "../../utils/fileIcons";
import { writeBackToChatInput } from "../mainContent/chatInput/chatInputDraftBridge";
import { useDiffReviewComments } from "./useDiffReviewComments";
import type {
  GitDiffResult,
  GitFileContentResult,
  GitFileStatus,
  GitImageDiff,
} from "./git";

type DiffViewerProps = {
  selectedFile: GitFileStatus;
  diffResult: GitDiffResult | null;
  diffLoading: boolean;
  /** 图片文件的旧/新版本预览数据；非图片文件为 null。 */
  imageDiff?: GitImageDiff | null;
  /** 评论所属项目（工作目录）；未提供时停用行内评论。 */
  directoryId?: string | null;
  /** 渲染在 diff 内容末尾（同一滚动容器内），如分页加载区。 */
  contentFooter?: React.ReactNode;
  /** 无 diff 内容时的提示文案；缺省为「没有可显示的变更」。 */
  emptyMessage?: string;
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
    return (
      <div className="diff-viewer-binary">{t("rightPanel.binaryFile")}</div>
    );
  }

  const panels: { key: string; label: string; data: GitFileContentResult }[] =
    [];
  if (oldContent) {
    panels.push({
      key: "old",
      label: t("rightPanel.imageDiffBefore"),
      data: oldContent,
    });
  }
  if (newContent) {
    panels.push({
      key: "new",
      label: t("rightPanel.imageDiffAfter"),
      data: newContent,
    });
  }

  return (
    <div
      className={`diff-viewer-images${panels.length === 1 ? " single" : ""}`}
    >
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
  directoryId,
  contentFooter,
  emptyMessage,
}: DiffViewerProps): React.JSX.Element {
  const { t } = useI18n();
  const viewMode = useDiffViewMode();
  const wrapLines = useDiffWrapLines();
  const [sendAllDone, setSendAllDone] = useState(false);
  const [clearArmed, setClearArmed] = useState(false);

  const {
    comments,
    createComment,
    updateComment,
    deleteComment,
    clearComments,
  } = useDiffReviewComments(
    directoryId,
    diffLoading ? null : selectedFile.path,
  );

  const commentContext = useMemo<DiffCommentContext | null>(() => {
    if (!directoryId) {
      return null;
    }
    return {
      comments,
      onCreate: createComment,
      onUpdate: updateComment,
      onDelete: deleteComment,
    };
  }, [directoryId, comments, createComment, updateComment, deleteComment]);

  const handleSelectViewMode = (mode: "unified" | "split"): void => {
    setDiffViewMode(mode);
  };

  const handleToggleWrapLines = (): void => {
    setDiffWrapLines(!wrapLines);
  };

  const handleSendAll = (): void => {
    if (comments.length === 0) {
      return;
    }
    const written = writeBackToChatInput(
      buildAllCommentsMessage(selectedFile.path, comments, t),
    );
    if (written) {
      setSendAllDone(true);
      window.setTimeout(() => setSendAllDone(false), 2000);
    }
  };

  const handleClearAll = (): void => {
    if (!clearArmed) {
      setClearArmed(true);
      window.setTimeout(() => setClearArmed(false), 3000);
      return;
    }
    setClearArmed(false);
    clearComments();
  };

  return (
    <div className="diff-viewer">
      <div className="diff-viewer-header">
        {getFileTypeIcon(
          selectedFile.path.split("/").pop() ?? selectedFile.path,
          false,
          false,
          { size: 14, className: "diff-viewer-file-icon" },
        )}
        <span className="diff-viewer-file-name" title={selectedFile.path}>
          {selectedFile.path}
        </span>
        <div className="diff-viewer-header-actions">
          {comments.length > 0 ? (
            <>
              <button
                type="button"
                className="diff-viewer-action-btn"
                title={t("diffComments.sendAll")}
                aria-label={t("diffComments.sendAll")}
                onClick={handleSendAll}
              >
                {sendAllDone ? (
                  <Check size={13} strokeWidth={1.8} />
                ) : (
                  <Send size={13} strokeWidth={1.8} />
                )}
                <span className="diff-viewer-comment-count">
                  {comments.length}
                </span>
              </button>
              <button
                type="button"
                className={`diff-viewer-action-btn${
                  clearArmed ? " danger" : ""
                }`}
                title={
                  clearArmed
                    ? t("diffComments.confirmClear")
                    : t("diffComments.clearAll")
                }
                aria-label={t("diffComments.clearAll")}
                onClick={handleClearAll}
              >
                <Trash2 size={13} strokeWidth={1.8} />
              </button>
            </>
          ) : null}
          <button
            type="button"
            className={`diff-viewer-wrap-btn${wrapLines ? " active" : ""}`}
            title={t("diffViewer.wrapLines")}
            aria-label={t("diffViewer.wrapLines")}
            aria-pressed={wrapLines}
            onClick={handleToggleWrapLines}
          >
            <WrapText size={13} strokeWidth={1.8} />
          </button>
          <div className="diff-viewer-mode-switch">
            <button
              type="button"
              className={`diff-viewer-mode-btn${
                viewMode === "unified" ? " active" : ""
              }`}
              title={t("diffViewer.unifiedMode")}
              aria-label={t("diffViewer.unifiedMode")}
              onClick={() => handleSelectViewMode("unified")}
            >
              <Rows3 size={13} strokeWidth={1.8} />
            </button>
            <button
              type="button"
              className={`diff-viewer-mode-btn${
                viewMode === "split" ? " active" : ""
              }`}
              title={t("diffViewer.splitMode")}
              aria-label={t("diffViewer.splitMode")}
              onClick={() => handleSelectViewMode("split")}
            >
              <Columns2 size={13} strokeWidth={1.8} />
            </button>
          </div>
        </div>
      </div>
      {diffLoading ? (
        <div className="diff-viewer-loading">{t("rightPanel.loadingDiff")}</div>
      ) : imageDiff ? (
        <ImageDiffContent imageDiff={imageDiff} />
      ) : diffResult?.error ? (
        <div className="diff-viewer-error">
          <div className="diff-viewer-error-title">
            {t("rightPanel.diffLoadFailed")}
          </div>
          <div className="diff-viewer-error-message">{diffResult.error}</div>
        </div>
      ) : diffResult?.isBinary ? (
        <div className="diff-viewer-binary">{t("rightPanel.binaryFile")}</div>
      ) : diffResult?.content ? (
        <div className="diff-viewer-content">
          <GitDiffView
            fileName={selectedFile.path}
            patch={diffResult.content}
            viewMode={viewMode}
            wrapLines={wrapLines}
            commentContext={commentContext}
          />
          {contentFooter}
        </div>
      ) : (
        <div className="diff-viewer-empty">
          {emptyMessage ?? t("rightPanel.noChangesToDisplay")}
        </div>
      )}
    </div>
  );
}
