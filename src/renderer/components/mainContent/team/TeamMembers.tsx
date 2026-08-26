import { Users } from "lucide-react";
import type { TeamMember } from "../../../../preload";
import { useI18n } from "../../../i18n";
import type { TeamData } from "./useTeamData";
import { TeamAvatar, TeamEmpty } from "./TeamShared";
import { formatTime, isOnline } from "./teamUtils";

/**
 * 团队成员：由 snow/team 分支上的成员记录自动推导（谁在团队数据平面
 * 活跃过，谁就在成员列表里）。lastSeen 由同步心跳维护，用于在线状态。
 */
export const TeamMembers = ({
  team,
}: {
  team: TeamData;
}): React.JSX.Element => {
  const { t } = useI18n();
  const myEmail = team.identity?.email ?? "";

  const sorted = [...team.members].sort((a, b) => {
    const aOnline = isOnline(a);
    const bOnline = isOnline(b);
    if (aOnline !== bOnline) {
      return aOnline ? -1 : 1;
    }
    return new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime();
  });

  const onlineCount = team.members.filter(isOnline).length;

  return (
    <div className="team-tasks">
      <div className="team-tab-toolbar">
        <span className="team-tab-title">
          {t("team.members.title", { defaultValue: "成员" })}
          <span className="team-task-group-count">{team.members.length}</span>
          <span className="team-members-online">{onlineCount} 在线</span>
        </span>
      </div>

      {sorted.length === 0 ? (
        <TeamEmpty
          icon={<Users size={28} strokeWidth={1.4} />}
          text={t("team.members.empty", {
            defaultValue:
              "还没有成员记录。团队数据同步后，活跃的成员会自动出现在这里。",
          })}
        />
      ) : (
        <div className="team-member-list">
          {sorted.map((member: TeamMember) => {
            const isMe = member.email === myEmail;
            const online = isOnline(member);
            return (
              <div key={member.email} className="team-member-row">
                <TeamAvatar
                  name={member.name}
                  seed={member.avatarSeed}
                  size={36}
                  online={online}
                />
                <div className="team-member-info">
                  <div className="team-member-name">
                    {member.name}
                    {isMe ? <span className="team-me-tag">我</span> : null}
                    {online ? (
                      <span className="team-online-tag">
                        {t("team.members.online", { defaultValue: "在线" })}
                      </span>
                    ) : null}
                  </div>
                  <div className="team-member-email">{member.email}</div>
                </div>
                <div className="team-member-side">
                  <span className="team-member-role">
                    {member.role === "owner"
                      ? t("team.members.owner", { defaultValue: "负责人" })
                      : t("team.members.member", { defaultValue: "成员" })}
                  </span>
                  <span className="team-feed-time">
                    {t("team.members.lastSeen", {
                      defaultValue: "最近活跃 {{time}}",
                      values: { time: formatTime(member.lastSeen) },
                    })}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

// 供页签图标复用
export const TeamMembersIcon = Users;
