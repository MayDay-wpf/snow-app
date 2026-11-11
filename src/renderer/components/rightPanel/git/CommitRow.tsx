import { GitCommitHorizontal } from "lucide-react";
import type {
  GitBranch as GitBranchType,
  GitCommitFile,
  GitLogEntry,
  GitWorktreeInfo,
} from "../../../../preload";
import { useI18n } from "../../../i18n";
import { formatDisplayPath } from "../../../utils/formatDisplayPath";
import { CommitDetail } from "./CommitDetail";
import { GitRefBadge } from "./GitRefBadge";
import {
  BEHIND_COLOR,
  DOT_RADIUS,
  LANE_COLORS,
  LANE_WIDTH,
  LINE_WIDTH,
  ROW_HEIGHT,
  UNPUSHED_COLOR,
  UNPUSHED_DASH,
  type GraphRow,
} from "./gitGraphLayout";
import {
  getCommitWorktrees,
  getWorktreeColor,
  parseRefs,
  type ParsedRef,
} from "./gitGraphRefs";
import { formatDate } from "./gitGraphUtils";

const ARC_KAPPA = 0.5523;
// 未推送提交的空心圆填充（绿色，区别于泳道色）
const UNPUSHED_FILL = "var(--accent-green-bg)";

type CommitRowProps = {
  row: GraphRow;
  graphWidth: number;
  isSelected: boolean;
  worktrees: GitWorktreeInfo[];
  branchMap: Map<string, GitBranchType>;
  repoPath: string;
  commitFiles: GitCommitFile[];
  isLoadingFiles: boolean;
  viewedCommitFile: { hash: string; path: string } | null;
  onActivate: (hash: string) => void;
  onHoverStart: (commit: GitLogEntry, anchor: HTMLElement) => void;
  onHoverEnd: () => void;
  onDragStart: (
    event: React.DragEvent<HTMLDivElement>,
    commit: GitLogEntry,
  ) => void;
  onRowMenu: (event: React.MouseEvent, commit: GitLogEntry) => void;
  onRefMenu: (ref: ParsedRef, x: number, y: number) => void;
  onFileMenu: (event: React.MouseEvent, file: GitCommitFile) => void;
  onSelectFile: (hash: string, path: string) => void;
  onOpenFileDiff: (
    file: GitCommitFile,
    hash: string,
    parentHash: string | null,
  ) => void;
};

export function CommitRow({
  row,
  graphWidth,
  isSelected,
  worktrees,
  branchMap,
  repoPath,
  commitFiles,
  isLoadingFiles,
  viewedCommitFile,
  onActivate,
  onHoverStart,
  onHoverEnd,
  onDragStart,
  onRowMenu,
  onRefMenu,
  onFileMenu,
  onSelectFile,
  onOpenFileDiff,
}: CommitRowProps): React.JSX.Element {
  const { t } = useI18n();
  const dotColor = LANE_COLORS[row.dotLane % LANE_COLORS.length];
  // Current HEAD's halo and worktree markers are distinct from topology lane colors.
  const parsedRefs = parseRefs(row.commit.refs);
  const isHead = parsedRefs.some((ref) => ref.isHead);
  const commitWorktrees = getCommitWorktrees(row.commit, parsedRefs, worktrees);
  const localRefWorktree = (ref: ParsedRef) =>
    ref.kind === "local" && ref.name !== "HEAD"
      ? commitWorktrees.find((worktree) => worktree.branchName === ref.name)
      : undefined;
  // At a branch point (curve leaving the dot), the curve leads into
  // the target lane and only reaches it at the bottom of the row.
  // If that lane had no line coming from above, drawing its vertical
  // bottom line from the dot height would make the new branch appear
  // to extend one extra segment before the curve actually joins it.
  // Skip such lines — the next row's top line continues them.
  const curveTargets = new Set(row.curves.map((c) => c.to));
  const bottomLines = row.bottomLines.filter(
    (lane) => !(curveTargets.has(lane) && !row.topLines.includes(lane)),
  );

  // 圆点外装饰环（HEAD 光环、worktree 圈）的最大半径：连线在环外截止，
  // 避免线头伸进环内压住空心圆。
  const dotOuterRadius = Math.max(
    DOT_RADIUS,
    isHead ? DOT_RADIUS + 3 : 0,
    commitWorktrees.length > 0
      ? DOT_RADIUS + 5 + (commitWorktrees.length - 1) * 3
      : 0,
  );
  const dotGap = dotOuterRadius + 1;

  return (
    <div>
      <div
        className={`git-graph-row${isSelected ? " selected" : ""}${
          row.commit.behind ? " behind" : ""
        }`}
        onClick={() => onActivate(row.commit.hash)}
        onContextMenu={(event) => {
          event.preventDefault();
          onRowMenu(event, row.commit);
        }}
        onMouseEnter={(event) => onHoverStart(row.commit, event.currentTarget)}
        onMouseLeave={onHoverEnd}
        draggable
        onDragStart={(event) => onDragStart(event, row.commit)}
      >
        <svg className="git-graph-svg" width={graphWidth} height={ROW_HEIGHT}>
          {row.topLines.map((lane) => (
            <line
              key={`top-${lane}`}
              x1={lane * LANE_WIDTH + LANE_WIDTH / 2}
              y1={-LINE_WIDTH / 2}
              x2={lane * LANE_WIDTH + LANE_WIDTH / 2}
              y2={ROW_HEIGHT / 2 - (lane === row.dotLane ? dotGap : 0)}
              stroke={row.topColors[lane]}
              strokeWidth={LINE_WIDTH}
              strokeDasharray={row.topDashed[lane] ? UNPUSHED_DASH : undefined}
            />
          ))}
          {bottomLines.map((lane) => (
            <line
              key={`bottom-${lane}`}
              x1={lane * LANE_WIDTH + LANE_WIDTH / 2}
              y1={ROW_HEIGHT / 2 + (lane === row.dotLane ? dotGap : 0)}
              x2={lane * LANE_WIDTH + LANE_WIDTH / 2}
              y2={ROW_HEIGHT + LINE_WIDTH / 2}
              stroke={row.bottomColors[lane]}
              strokeWidth={LINE_WIDTH}
              strokeDasharray={
                row.bottomDashed[lane] ? UNPUSHED_DASH : undefined
              }
            />
          ))}
          {row.curves.map((c, i) => {
            const fromX = c.from * LANE_WIDTH + LANE_WIDTH / 2;
            const toX = c.to * LANE_WIDTH + LANE_WIDTH / 2;
            const startY = ROW_HEIGHT / 2 + dotGap;
            const endY = ROW_HEIGHT + LINE_WIDTH / 2;
            return (
              <path
                key={`curve-${i}`}
                d={`M ${fromX},${startY} C ${
                  fromX + (toX - fromX) * ARC_KAPPA
                },${startY} ${toX},${
                  endY - (endY - startY) * ARC_KAPPA
                } ${toX},${endY}`}
                fill="none"
                stroke={c.color}
                strokeWidth={LINE_WIDTH}
                strokeDasharray={c.dashed ? UNPUSHED_DASH : undefined}
              />
            );
          })}
          {row.merges.map((m, i) => {
            const fromX = m.from * LANE_WIDTH + LANE_WIDTH / 2;
            const dotX = row.dotLane * LANE_WIDTH + LANE_WIDTH / 2;
            const startY = -LINE_WIDTH / 2;
            const endY = ROW_HEIGHT / 2 - dotGap;
            return (
              <path
                key={`merge-${i}`}
                d={`M ${fromX},${startY} C ${fromX},${
                  startY + (endY - startY) * ARC_KAPPA
                } ${dotX + (fromX - dotX) * ARC_KAPPA},${endY} ${dotX},${endY}`}
                fill="none"
                stroke={m.color}
                strokeWidth={LINE_WIDTH}
                strokeDasharray={m.dashed ? UNPUSHED_DASH : undefined}
              />
            );
          })}
          {isHead && (
            <circle
              cx={row.dotLane * LANE_WIDTH + LANE_WIDTH / 2}
              cy={ROW_HEIGHT / 2}
              r={DOT_RADIUS + 3}
              fill="none"
              stroke="var(--accent-blue-text)"
              strokeWidth={1.5}
            />
          )}
          {commitWorktrees.map((worktree, index) => (
            <circle
              key={`worktree-${worktree.worktreeId}`}
              cx={row.dotLane * LANE_WIDTH + LANE_WIDTH / 2}
              cy={ROW_HEIGHT / 2}
              r={DOT_RADIUS + 5 + index * 3}
              fill="none"
              stroke={getWorktreeColor(worktree)}
              strokeWidth={2}
            />
          ))}
          {row.commit.behind ? (
            <circle
              cx={row.dotLane * LANE_WIDTH + LANE_WIDTH / 2}
              cy={ROW_HEIGHT / 2}
              r={DOT_RADIUS}
              fill="var(--bg-primary)"
              stroke={BEHIND_COLOR}
              strokeWidth={2}
              strokeDasharray="2.5 1.8"
            />
          ) : (
            <circle
              cx={row.dotLane * LANE_WIDTH + LANE_WIDTH / 2}
              cy={ROW_HEIGHT / 2}
              r={DOT_RADIUS}
              fill={row.commit.pushed ? dotColor : UNPUSHED_FILL}
              stroke={row.commit.pushed ? "var(--bg-primary)" : UNPUSHED_COLOR}
              strokeWidth={row.commit.pushed ? 2 : 2.5}
            />
          )}
        </svg>
        <div className="git-graph-info">
          <span className="git-graph-message">{row.commit.message}</span>
          {(parsedRefs.length > 0 ||
            commitWorktrees.some((worktree) => worktree.isDetached)) && (
            <span className="git-graph-refs">
              {parsedRefs.map((ref) => {
                const worktree = localRefWorktree(ref);
                return (
                  <GitRefBadge
                    key={`${ref.kind}/${ref.name}/${worktree?.worktreeId ?? ""}`}
                    ref={ref}
                    worktree={worktree}
                    branchMap={branchMap}
                    repoPath={repoPath}
                    onOpenMenu={onRefMenu}
                  />
                );
              })}
              {commitWorktrees
                .filter((worktree) => worktree.isDetached)
                .map((worktree) => {
                  const color = getWorktreeColor(worktree);
                  return (
                    <span
                      key={`detached-${worktree.worktreeId}`}
                      className="git-graph-ref local"
                      style={{ color, borderColor: color }}
                      title={`${t("git.graphDetachedHead")}\n${t(
                        "git.graphWorktreeTooltip",
                        {
                          values: {
                            path: formatDisplayPath(worktree.worktreePath),
                            state: worktree.isDirty
                              ? t("git.worktreeDirty")
                              : t("git.graphWorktreeClean"),
                            validity: worktree.isValid
                              ? ""
                              : ` · ${t("git.graphWorktreeInvalid")}`,
                          },
                        },
                      )}`}
                    >
                      <GitCommitHorizontal size={10} strokeWidth={2} />
                      {t("git.graphDetachedHead")}
                    </span>
                  );
                })}
            </span>
          )}
          <span className="git-graph-meta">
            <span className="git-graph-author">{row.commit.author}</span>
            <span className="git-graph-date">
              {formatDate(row.commit.date)}
            </span>
          </span>
        </div>
      </div>
      {isSelected && (
        <CommitDetail
          commit={row.commit}
          graphWidth={graphWidth}
          bottomLines={row.bottomLines}
          bottomColors={row.bottomColors}
          bottomDashed={row.bottomDashed}
          commitFiles={commitFiles}
          isLoadingFiles={isLoadingFiles}
          viewedCommitFile={viewedCommitFile}
          onSelectFile={onSelectFile}
          onOpenFileDiff={onOpenFileDiff}
          onFileContextMenu={onFileMenu}
        />
      )}
    </div>
  );
}
