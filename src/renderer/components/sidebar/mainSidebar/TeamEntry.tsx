import { Users } from "lucide-react";
import type { TeamInfo } from "../../../../preload";
import { useI18n } from "../../../i18n";
import { TeamAvatar } from "../../mainContent/team/TeamShared";

/**
 * 侧边栏的团队协作入口：展示当前项目所属团队与累计待办徽标
 * （未读动态 + 我的任务 + 待我评审 + 加入申请）。
 * 团队数据存于本机数据库，由队长设备的 WebSocket 服务实时同步。
 */
export const TeamEntry = ({
  team,
  badgeCount = 0,
  onClick,
}: {
  team: TeamInfo | null;
  badgeCount?: number;
  onClick: () => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const displayName = team?.selfName || team?.name || t("team.nameFallback");
  const label = t("team.sidebarEntry", { defaultValue: "团队协作" });

  return (
    <button
      type="button"
      className="nav-item team-entry"
      onClick={onClick}
      title={
        badgeCount > 0
          ? `${label} · ${t("team.sidebarBadge", {
              defaultValue: "{{count}} 条待处理",
              values: { count: badgeCount },
            })}`
          : label
      }
    >
      {team ? (
        <TeamAvatar
          name={displayName}
          seed={team.selfColor || team.selfPeerId}
          size={22}
        />
      ) : (
        <Users size={16} strokeWidth={1.8} />
      )}
      <span>{label}</span>
      {badgeCount > 0 ? (
        <span className="sidebar-memo-badge">{badgeCount}</span>
      ) : null}
    </button>
  );
};
