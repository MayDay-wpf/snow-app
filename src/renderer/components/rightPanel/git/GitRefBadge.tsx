import {
  CircleDot,
  Cloud,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  Tag,
} from "lucide-react";
import type {
  GitBranch as GitBranchType,
  GitWorktreeInfo,
} from "../../../../preload";
import { useI18n } from "../../../i18n";
import { formatDisplayPath } from "../../../utils/formatDisplayPath";
import { getWorktreeColor, type ParsedRef } from "./gitGraphRefs";
import { getWorktreeFolderName, isOtherWorktreePath } from "./gitGraphUtils";

type GitRefBadgeProps = {
  ref: ParsedRef;
  worktree?: GitWorktreeInfo;
  branchMap: Map<string, GitBranchType>;
  repoPath: string;
  onOpenMenu: (ref: ParsedRef, x: number, y: number) => void;
};

/** Renders one ref badge (local / remote / tag) with its original meaning. */
export function GitRefBadge({
  ref,
  worktree,
  branchMap,
  repoPath,
  onOpenMenu,
}: GitRefBadgeProps): React.JSX.Element {
  const { t } = useI18n();
  const branchInfo = branchMap.get(ref.name);
  const worktreePath = worktree?.worktreePath ?? branchInfo?.worktreePath;
  const isOtherWorktree = isOtherWorktreePath(worktreePath, repoPath);
  const worktreeFolder = worktreePath
    ? getWorktreeFolderName(worktreePath)
    : null;

  let title =
    ref.kind === "remote"
      ? t("git.graphRemoteBranch", { defaultValue: "Remote branch" })
      : ref.kind === "tag"
        ? t("git.graphTag", { defaultValue: "Tag" })
        : ref.name === "HEAD"
          ? t("git.graphDetachedHead", { defaultValue: "Detached HEAD" })
          : ref.isHead
            ? t("git.graphCurrentBranch", { defaultValue: "Current branch" })
            : t("git.graphLocalBranch", { defaultValue: "Local branch" });

  if (worktree) {
    title += `\n${t("git.graphWorktreeTooltip", {
      values: {
        path: formatDisplayPath(worktree.worktreePath),
        state: worktree.isDirty
          ? t("git.worktreeDirty")
          : t("git.graphWorktreeClean"),
        validity: worktree.isValid ? "" : ` · ${t("git.graphWorktreeInvalid")}`,
      },
    })}`;
  } else if (isOtherWorktree && worktreePath) {
    title += `\n${t("git.worktreeCheckedOut")}: ${formatDisplayPath(worktreePath)}`;
  }

  const icon =
    ref.kind === "remote" ? (
      <Cloud size={10} strokeWidth={2} />
    ) : ref.kind === "tag" ? (
      <Tag size={10} strokeWidth={2} />
    ) : ref.name === "HEAD" ? (
      <GitCommitHorizontal size={10} strokeWidth={2} />
    ) : ref.isHead ? (
      <CircleDot size={10} strokeWidth={2} />
    ) : isOtherWorktree ? (
      <FolderGit2 size={10} strokeWidth={2} />
    ) : (
      <GitBranch size={10} strokeWidth={2} />
    );

  const worktreeColor = worktree ? getWorktreeColor(worktree) : undefined;
  const displayText =
    isOtherWorktree && worktreeFolder
      ? `${ref.name} (${worktreeFolder})`
      : ref.name;

  return (
    <span
      className={`git-graph-ref ${ref.kind}${isOtherWorktree ? " worktree" : ""}`}
      title={title}
      style={
        worktreeColor
          ? { color: worktreeColor, borderColor: worktreeColor }
          : undefined
      }
      onClick={(e) => {
        e.stopPropagation();
        onOpenMenu(ref, e.clientX, e.clientY);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onOpenMenu(ref, e.clientX, e.clientY);
      }}
    >
      {worktreeColor && (
        <span
          aria-hidden="true"
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            backgroundColor: worktreeColor,
            flex: "0 0 auto",
          }}
        />
      )}
      {icon}
      {displayText}
    </span>
  );
}
