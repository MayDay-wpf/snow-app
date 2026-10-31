import { useMemo, useState } from "react";
import { ArrowLeft, Eye, FileMinus2, FilePlus2, FilePen } from "lucide-react";
import { useI18n } from "../../../../i18n";
import { Modal } from "../../../common/Modal";
import { getFileTypeIcon } from "../../../../utils/fileIcons";
import {
  FileDiffPreview,
  type FileDiffPreviewItem,
} from "../../../common/FileDiffPreview";
import {
  countFileChangeLines,
  countUniqueFiles,
} from "../../chatMessages/hooks/fileChangeTracking";
import type { FileChangeRecord } from "../../chatMessages/utils/conversationTypes";

type FileChangesPanelProps = {
  /** Whether the panel is visible. Controlled by the /changes command. */
  open: boolean;
  /** 回滚链计算出的文件变更，与回滚确认弹窗同源。 */
  changes: FileChangeRecord[];
  onClose: () => void;
};

/**
 * Modal opened by the /changes slash command, listing the files the rollback
 * chain of the active conversation would restore — the same records the
 * rollback dialog shows (see useConversationFileChanges). The "view changes"
 * action switches to a diff preview (same FileDiffPreview as the rollback
 * dialog).
 */
export const FileChangesPanel = ({
  open,
  changes,
  onClose,
}: FileChangesPanelProps): React.JSX.Element | null => {
  const { t } = useI18n();
  const [isDiffView, setIsDiffView] = useState(false);
  const [selectedDiffPath, setSelectedDiffPath] = useState<string | null>(null);

  const summary = useMemo(() => {
    const mainCount = changes.filter(
      (change) => change.agent === "main",
    ).length;
    return {
      uniqueFiles: countUniqueFiles(changes),
      mainCount,
      subCount: changes.length - mainCount,
    };
  }, [changes]);

  const lineStats = useMemo(
    () => changes.map((change) => countFileChangeLines([change])),
    [changes],
  );

  // Records without a diff payload (e.g. tool arguments carried no content)
  // stay in the list but are excluded from the diff preview. Rollback-chain
  // records carry a checkpoint source instead: their diff is paged on demand.
  const diffItems = useMemo<FileDiffPreviewItem[]>(
    () =>
      changes.flatMap((change): FileDiffPreviewItem[] => {
        const changeType =
          change.kind === "create"
            ? "added"
            : change.kind === "delete"
              ? "deleted"
              : "modified";
        if (change.checkpointSource) {
          return [
            {
              path: change.filePath,
              changeType,
              checkpointSource: change.checkpointSource,
            },
          ];
        }
        if (!change.diff?.patch) {
          return [];
        }
        return [
          {
            path: change.filePath,
            changeType,
            content: change.diff.patch,
            isBinary: change.diff.isBinary ?? false,
          },
        ];
      }),
    [changes],
  );

  const isSubChange = (change: FileChangeRecord): boolean =>
    change.agent === "sub";

  const handleClose = (): void => {
    setIsDiffView(false);
    setSelectedDiffPath(null);
    onClose();
  };

  const handleBackToList = (): void => {
    setIsDiffView(false);
    setSelectedDiffPath(null);
  };

  const handleOpenDiff = (filePath: string): void => {
    setSelectedDiffPath(filePath);
    setIsDiffView(true);
  };

  const handleViewAllDiffs = (): void => {
    setSelectedDiffPath(null);
    setIsDiffView(true);
  };

  return (
    <Modal
      className={`file-changes-modal${isDiffView ? " is-diff-view" : ""}`}
      closeLabel={t("chat.fileChanges.close")}
      description={t("chat.fileChanges.description")}
      onClose={handleClose}
      open={open}
      size="large"
      title={
        isDiffView
          ? t("chat.fileChanges.diffTitle")
          : t("chat.fileChanges.title")
      }
      footer={
        !isDiffView && changes.length > 0 && diffItems.length > 0 ? (
          <button
            type="button"
            className="file-changes-view-diff-btn"
            onClick={handleViewAllDiffs}
          >
            <Eye size={14} />
            {t("chat.fileChanges.viewDiff")}
          </button>
        ) : undefined
      }
    >
      {isDiffView ? (
        <div className="file-changes-diff-view">
          <div className="file-changes-diff-toolbar">
            <button
              type="button"
              className="rollback-preview-back"
              onClick={handleBackToList}
              aria-label={t("chat.fileChanges.backToList")}
              title={t("chat.fileChanges.backToList")}
            >
              <ArrowLeft size={15} />
            </button>
            <span className="file-changes-diff-toolbar-title">
              {t("chat.fileChanges.diffTitle")}
            </span>
          </div>
          <FileDiffPreview
            key={selectedDiffPath ?? "__all__"}
            diffs={diffItems}
            initialSelectedPath={selectedDiffPath}
            isLoading={false}
            hasError={false}
            labels={{
              loading: "",
              error: "",
              empty: t("chat.fileChanges.diffEmpty"),
              selectFile: t("chat.fileChanges.selectFile"),
            }}
          />
        </div>
      ) : changes.length === 0 ? (
        <div className="file-changes-empty">
          <span className="file-changes-empty-title">
            {t("chat.fileChanges.emptyTitle")}
          </span>
          <span className="file-changes-empty-hint">
            {t("chat.fileChanges.emptyHint")}
          </span>
        </div>
      ) : (
        <div className="file-changes-body">
          <div className="file-changes-summary">
            <span className="file-changes-summary-text">
              {t("chat.fileChanges.summary", {
                values: { count: summary.uniqueFiles },
              })}
            </span>
            <span className="file-changes-badges">
              <span className="file-changes-badge is-main">
                {t("chat.fileChanges.agentMain", {
                  values: { count: summary.mainCount },
                })}
              </span>
              {summary.subCount > 0 ? (
                <span className="file-changes-badge is-sub">
                  {t("chat.fileChanges.agentSub", {
                    values: { count: summary.subCount },
                  })}
                </span>
              ) : null}
            </span>
          </div>

          <ul className="file-changes-list">
            {changes.map((change, index) => {
              const fileName =
                change.filePath.split(/[\\/]/).pop() || change.filePath;
              const stats = lineStats[index];
              const hasDiff = Boolean(
                change.checkpointSource || change.diff?.patch,
              );
              return (
                <li
                  className="file-changes-row"
                  key={`${change.filePath}-${change.timestamp}-${index}`}
                >
                  <button
                    type="button"
                    className={`file-changes-row-btn${
                      hasDiff ? "" : " is-static"
                    }`}
                    onClick={
                      hasDiff
                        ? () => handleOpenDiff(change.filePath)
                        : undefined
                    }
                    aria-disabled={hasDiff ? undefined : true}
                    title={change.filePath}
                  >
                    <span className="file-changes-row-icon" aria-hidden="true">
                      {change.kind === "create" ? (
                        <FilePlus2 size={13} strokeWidth={2} />
                      ) : change.kind === "delete" ? (
                        <FileMinus2 size={13} strokeWidth={2} />
                      ) : (
                        <FilePen size={13} strokeWidth={2} />
                      )}
                    </span>
                    <span className="file-changes-path">
                      {getFileTypeIcon(fileName, false, false, {
                        size: 13,
                        "aria-hidden": true,
                      })}
                      <span className="file-changes-path-text">
                        {change.filePath}
                      </span>
                    </span>
                    {stats.additions > 0 || stats.deletions > 0 ? (
                      <span className="file-changes-line-stats">
                        {stats.additions > 0 ? (
                          <span className="file-changes-diff-add">
                            +{stats.additions}
                          </span>
                        ) : null}
                        {stats.deletions > 0 ? (
                          <span className="file-changes-diff-del">
                            -{stats.deletions}
                          </span>
                        ) : null}
                      </span>
                    ) : null}
                    <span className={`file-changes-kind is-${change.kind}`}>
                      {change.kind === "create"
                        ? t("chat.fileChanges.kindCreate")
                        : change.kind === "delete"
                          ? t("chat.fileChanges.kindDelete")
                          : t("chat.fileChanges.kindEdit")}
                    </span>
                    <span
                      className={`file-changes-agent${
                        isSubChange(change) ? " is-sub" : ""
                      }`}
                    >
                      {isSubChange(change)
                        ? (change.subAgentName ??
                          t("chat.fileChanges.agentSubName"))
                        : t("chat.fileChanges.agentMainName")}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Modal>
  );
};
