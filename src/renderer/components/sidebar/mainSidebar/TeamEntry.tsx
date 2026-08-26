import { Users } from "lucide-react";
import type { TeamIdentity } from "../../../../preload";
import { useI18n } from "../../../i18n";
import { useTeamSummary } from "../../mainContent/team/useTeamData";
import { TeamAvatar } from "../../mainContent/team/TeamShared";
import { memberName } from "../../mainContent/team/teamUtils";

/**
 * 侧边栏顶部的团队协作入口：展示当前 git 身份头像 + 待办徽标。
 * 身份与待办数由团队数据平面（snow/team 分支）推导，无需任何后端。
 */
export const TeamEntry = ({
  repoPath,
  onClick,
  identity,
  pendingCount,
}: {
  repoPath: string;
  onClick: () => void;
  identity?: TeamIdentity | null;
  pendingCount?: number;
}): React.JSX.Element => {
  const { t } = useI18n();
  const summary = useTeamSummary(repoPath);
  const effIdentity = identity !== undefined ? identity : summary.identity;
  const effPendingCount = pendingCount ?? summary.pendingCount;
  const displayName =
    effIdentity?.name || memberName([], effIdentity?.email ?? "") || "团队";

  return (
    <button
      type="button"
      className="nav-item team-entry"
      onClick={onClick}
      title={t("team.sidebarEntry", {
        defaultValue: "团队协作（基于 Git）",
      })}
    >
      {effIdentity?.hasIdentity ? (
        <TeamAvatar name={displayName} seed={effIdentity.email} size={22} />
      ) : (
        <Users size={16} strokeWidth={1.8} />
      )}
      <span>{t("team.sidebarEntry", { defaultValue: "团队协作" })}</span>
      {effPendingCount > 0 ? (
        <span className="sidebar-memo-badge">{effPendingCount}</span>
      ) : null}
    </button>
  );
};
