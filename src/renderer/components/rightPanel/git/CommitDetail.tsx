import type { GitCommitFile, GitLogEntry } from "../../../../preload";
import { useI18n } from "../../../i18n";
import { LANE_WIDTH, LINE_WIDTH, UNPUSHED_DASH } from "./gitGraphLayout";
import { getCommitFileColor, getCommitFileLabel } from "./gitGraphUtils";

type CommitDetailProps = {
  commit: GitLogEntry;
  graphWidth: number;
  bottomLines: number[];
  bottomColors: string[];
  bottomDashed: boolean[];
  commitFiles: GitCommitFile[];
  isLoadingFiles: boolean;
  viewedCommitFile: { hash: string; path: string } | null;
  onSelectFile: (hash: string, path: string) => void;
  onOpenFileDiff: (
    file: GitCommitFile,
    hash: string,
    parentHash: string | null,
  ) => void;
  onFileContextMenu: (event: React.MouseEvent, file: GitCommitFile) => void;
};

export function CommitDetail({
  commit,
  graphWidth,
  bottomLines,
  bottomColors,
  bottomDashed,
  commitFiles,
  isLoadingFiles,
  viewedCommitFile,
  onSelectFile,
  onOpenFileDiff,
  onFileContextMenu,
}: CommitDetailProps): React.JSX.Element {
  const { t } = useI18n();

  return (
    <div className="git-graph-detail" style={{ paddingLeft: graphWidth + 20 }}>
      {/* Extend the lanes that continue below this row through the
          expanded detail area so the graph columns stay visually
          continuous instead of being cut off by the detail panel. */}
      <svg className="git-graph-detail-lines" width={graphWidth} height="100%">
        {bottomLines.map((lane) => (
          <line
            key={`detail-${lane}`}
            x1={lane * LANE_WIDTH + LANE_WIDTH / 2}
            y1="0%"
            x2={lane * LANE_WIDTH + LANE_WIDTH / 2}
            y2="100%"
            stroke={bottomColors[lane]}
            strokeWidth={LINE_WIDTH}
            strokeDasharray={bottomDashed[lane] ? UNPUSHED_DASH : undefined}
          />
        ))}
      </svg>
      {commit.body && (
        <div className="git-graph-detail-message-body">{commit.body}</div>
      )}
      {commitFiles.length > 0 ? (
        <div className="git-graph-detail-files">
          {commitFiles.map((file, i) => {
            const isViewed =
              viewedCommitFile?.hash === commit.hash &&
              viewedCommitFile.path === file.path;
            return (
              <div
                key={i}
                className={`git-graph-detail-file${isViewed ? " active" : ""}`}
                onClick={() => onSelectFile(commit.hash, file.path)}
                onDoubleClick={() => {
                  onSelectFile(commit.hash, file.path);
                  onOpenFileDiff(file, commit.hash, commit.parents[0] ?? null);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onFileContextMenu(event, file);
                }}
                title={t("git.viewCommitFileDiff", {
                  defaultValue: "View File Diff in This Commit",
                })}
              >
                <span
                  className={`git-file-status ${getCommitFileColor(
                    file.status,
                  )}`}
                >
                  {getCommitFileLabel(file.status)}
                </span>
                <span className="git-graph-detail-path" title={file.path}>
                  {file.path}
                </span>
              </div>
            );
          })}
        </div>
      ) : isLoadingFiles ? (
        <span className="git-graph-detail-loading">
          {t("git.graphLoading")}
        </span>
      ) : (
        <span className="git-graph-detail-empty">
          {t("git.graphNoCommits")}
        </span>
      )}
    </div>
  );
}
