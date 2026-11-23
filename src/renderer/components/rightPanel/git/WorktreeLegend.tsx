import type { GitWorktreeInfo } from "../../../../preload";
import { useI18n } from "../../../i18n";
import { formatDisplayPath } from "../../../utils/formatDisplayPath";
import { LANE_COLORS } from "./gitGraphLayout";
import { getWorktreeColor } from "./gitGraphRefs";

type WorktreeLegendProps = {
  worktrees: GitWorktreeInfo[];
  matchedWorktreeIds: Set<string>;
};

export function WorktreeLegend({
  worktrees,
  matchedWorktreeIds,
}: WorktreeLegendProps): React.JSX.Element | null {
  const { t } = useI18n();

  if (worktrees.length === 0) {
    return null;
  }

  return (
    <div
      role="group"
      aria-label={t("git.graphWorktreeLegend")}
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: "4px 10px",
        padding: "4px 8px 8px",
      }}
    >
      <span style={{ color: "var(--text-secondary)", fontSize: 10 }}>
        {t("git.graphWorktreeLegend")}
      </span>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          fontSize: 10,
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 12,
            height: 2,
            backgroundColor: getWorktreeColor(worktrees[0]),
          }}
        />
        {t("git.graphWorktreePathLegend")}
      </span>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          fontSize: 10,
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 12,
            height: 2,
            background: `linear-gradient(90deg, ${LANE_COLORS.slice(0, 3).join(", ")})`,
          }}
        />
        {t("git.graphSharedAncestryLegend")}
      </span>
      {worktrees.map((worktree) => {
        const color = getWorktreeColor(worktree);
        return (
          <span
            key={worktree.worktreeId}
            title={`${t("git.graphWorktreeTooltip", {
              values: {
                path: formatDisplayPath(worktree.worktreePath),
                state: worktree.isDirty
                  ? t("git.worktreeDirty")
                  : t("git.graphWorktreeClean"),
                validity: worktree.isValid
                  ? ""
                  : ` · ${t("git.graphWorktreeInvalid")}`,
              },
            })}${
              matchedWorktreeIds.has(worktree.worktreeId)
                ? ""
                : `\n${t("git.graphWorktreeNotLoaded")}`
            }`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              color,
              fontSize: 10,
              opacity: worktree.isValid ? 1 : 0.7,
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                backgroundColor: color,
                outline: worktree.isValid
                  ? undefined
                  : "1px dashed var(--accent-red-text)",
              }}
            />
            {worktree.branchName ??
              `${t("git.graphDetachedHead")} ${worktree.headOid.slice(0, 7)}`}
            {!worktree.isValid && (
              <span style={{ color: "var(--accent-red-text)" }}>
                ({t("git.graphWorktreeInvalid")})
              </span>
            )}
            {!matchedWorktreeIds.has(worktree.worktreeId) && (
              <span style={{ color: "var(--text-secondary)" }}>
                ({t("git.graphWorktreeNotLoaded")})
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}
