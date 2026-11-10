import {
  Ban,
  Check,
  Loader2,
  LogOut,
  UserMinus,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { useCallback, useState } from "react";
import type { TeamMemberRecord } from "../../../../preload";
import { useI18n } from "../../../i18n";
import { ConfirmDialog } from "../../common/ConfirmDialog";
import { TeamAvatar, TeamEmpty, TeamErrorNotice } from "./TeamShared";
import { formatTime, isOnline } from "./teamUtils";
import type { TeamData } from "./useTeamData";

/**
 * 团队成员：成员记录由团队数据库维护，在线状态由队长的连接广播（或最近
 * 心跳）推导。队长在此审核加入申请、管理成员；团队设置（常驻服务 / 邀请
 * 链接 / 黑名单）在「设置」页签。
 */
export const TeamMembers = ({
  team,
}: {
  team: TeamData;
}): React.JSX.Element => {
  const { t } = useI18n();
  const [confirmAction, setConfirmAction] = useState<
    "leave" | "disband" | null
  >(null);
  const [leaving, setLeaving] = useState(false);
  const [removingMember, setRemovingMember] = useState<TeamMemberRecord | null>(
    null,
  );
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const clearRemoveError = useCallback(() => setRemoveError(null), []);
  const [blockingMember, setBlockingMember] = useState<TeamMemberRecord | null>(
    null,
  );
  const [blocking, setBlocking] = useState(false);
  const [requestBusy, setRequestBusy] = useState<string | null>(null);
  const myPeerId = team.me.peerId;

  const sorted = [...team.members].sort((a, b) => {
    const aOnline = isOnline(a);
    const bOnline = isOnline(b);
    if (aOnline !== bOnline) {
      return aOnline ? -1 : 1;
    }
    return new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime();
  });

  const onlineCount = team.members.filter(isOnline).length;
  const isHost = team.role === "host";

  /** 退出团队（队员）/ 解散团队（队长）：身份不同，调用的接口也不同。 */
  const leave = (): void => {
    const action = confirmAction;
    if (!action) {
      return;
    }
    setLeaving(true);
    setRemoveError(null);
    void (action === "disband" ? team.disbandTeam() : team.leaveTeam())
      .catch((e: unknown) =>
        setRemoveError(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => {
        setLeaving(false);
        setConfirmAction(null);
      });
  };

  const removeMember = (member: TeamMemberRecord): void => {
    setRemoving(true);
    setRemoveError(null);
    void team
      .removeMember(member.peerId)
      .catch((e: unknown) =>
        setRemoveError(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => {
        setRemoving(false);
        setRemovingMember(null);
      });
  };

  /** 审核一条加入申请（同意 / 拒绝）。 */
  const respondRequest = (requestId: string, approve: boolean): void => {
    setRequestBusy(requestId);
    setRemoveError(null);
    void team
      .respondJoinRequest(requestId, approve)
      .catch((e: unknown) =>
        setRemoveError(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => setRequestBusy(null));
  };

  /** 拉黑成员：移出团队并禁止其再次加入。 */
  const blockMember = (member: TeamMemberRecord): void => {
    setBlocking(true);
    setRemoveError(null);
    void team
      .blockMember(member.peerId)
      .catch((e: unknown) =>
        setRemoveError(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => {
        setBlocking(false);
        setBlockingMember(null);
      });
  };

  return (
    <div className="team-tasks">
      <div className="team-tab-toolbar">
        <span className="team-tab-title">
          {t("team.members.title", { defaultValue: "成员" })}
          <span className="team-task-group-count">{team.members.length}</span>
          <span className="team-members-online">
            {t("team.members.onlineCount", { values: { count: onlineCount } })}
          </span>
        </span>
        <button
          type="button"
          className="team-btn team-btn-danger"
          disabled={leaving}
          onClick={() => setConfirmAction(isHost ? "disband" : "leave")}
        >
          {leaving ? (
            <Loader2 size={14} className="spin" />
          ) : (
            <LogOut size={14} />
          )}
          {isHost
            ? t("team.members.disband", { defaultValue: "解散团队" })
            : t("team.members.leave", { defaultValue: "退出团队" })}
        </button>
      </div>

      {isHost && team.joinRequests.length > 0 ? (
        <div className="team-requests">
          <span className="team-requests-title">
            <UserPlus size={14} strokeWidth={1.8} />
            {t("team.members.joinRequests", { defaultValue: "待审核加入申请" })}
            <span className="team-task-group-count">
              {team.joinRequests.length}
            </span>
          </span>
          {team.joinRequests.map((request) => (
            <div key={request.requestId} className="team-member-row">
              <TeamAvatar
                name={request.name}
                seed={request.color || request.clientId}
                size={32}
              />
              <div className="team-member-info">
                <div className="team-member-name">{request.name}</div>
                <div className="team-member-email">
                  {formatTime(request.createdAt)}
                </div>
              </div>
              <div className="team-member-actions">
                <button
                  type="button"
                  className="team-btn team-btn-primary"
                  disabled={requestBusy !== null}
                  onClick={() => respondRequest(request.requestId, true)}
                >
                  {requestBusy === request.requestId ? (
                    <Loader2 size={14} className="spin" />
                  ) : (
                    <Check size={14} />
                  )}
                  {t("team.members.approve", { defaultValue: "同意" })}
                </button>
                <button
                  type="button"
                  className="team-btn"
                  disabled={requestBusy !== null}
                  onClick={() => respondRequest(request.requestId, false)}
                >
                  <X size={14} />
                  {t("team.members.reject", { defaultValue: "拒绝" })}
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <TeamErrorNotice message={removeError} onDismiss={clearRemoveError} />

      {sorted.length === 0 ? (
        <TeamEmpty
          icon={<Users size={28} strokeWidth={1.4} />}
          text={t("team.members.empty", {
            defaultValue:
              "还没有成员。邀请链接分享给同事后，他们会出现在这里。",
          })}
        />
      ) : (
        <div className="team-member-list">
          {sorted.map((member) => {
            const isMe = member.peerId === myPeerId;
            const online = isOnline(member);
            return (
              <div key={member.peerId} className="team-member-row">
                <TeamAvatar
                  name={member.name}
                  seed={member.color || member.peerId}
                  size={36}
                  online={online}
                />
                <div className="team-member-info">
                  <div className="team-member-name">
                    {member.name}
                    {isMe ? (
                      <span className="team-me-tag">{t("team.me")}</span>
                    ) : null}
                    {online ? (
                      <span className="team-online-tag">
                        {t("team.members.online", { defaultValue: "在线" })}
                      </span>
                    ) : null}
                  </div>
                </div>
                <div className="team-member-side">
                  <span className="team-member-role">
                    {member.role === "host"
                      ? t("team.members.owner", { defaultValue: "队长" })
                      : t("team.members.member", { defaultValue: "成员" })}
                  </span>
                  <span className="team-feed-time">
                    {t("team.members.lastSeen", {
                      defaultValue: "最近活跃 {{time}}",
                      values: { time: formatTime(member.lastSeen) },
                    })}
                  </span>
                </div>
                {isHost && !isMe ? (
                  <div className="team-member-actions">
                    <button
                      type="button"
                      className="team-member-remove"
                      title={t("team.members.remove", {
                        defaultValue: "移除成员",
                      })}
                      aria-label={t("team.members.remove", {
                        defaultValue: "移除成员",
                      })}
                      disabled={
                        removingMember !== null || blockingMember !== null
                      }
                      onClick={() => setRemovingMember(member)}
                    >
                      <UserMinus size={14} />
                    </button>
                    <button
                      type="button"
                      className="team-member-remove"
                      title={t("team.members.block", {
                        defaultValue: "拉黑成员",
                      })}
                      aria-label={t("team.members.block", {
                        defaultValue: "拉黑成员",
                      })}
                      disabled={
                        removingMember !== null || blockingMember !== null
                      }
                      onClick={() => setBlockingMember(member)}
                    >
                      <Ban size={14} />
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={removingMember !== null}
        variant="danger"
        title={t("team.members.removeTitle", { defaultValue: "移除成员" })}
        message={t("team.members.removeMessage", {
          defaultValue:
            "将 {{name}} 移出团队并断开其连接；对方可再次凭邀请链接申请加入（需你审核）。",
          values: { name: removingMember?.name ?? "" },
        })}
        confirmLabel={t("team.members.remove", { defaultValue: "移除成员" })}
        cancelLabel={t("common.cancel", { defaultValue: "取消" })}
        isConfirming={removing}
        onConfirm={() => {
          const target = removingMember;
          if (target) {
            removeMember(target);
          }
        }}
        onCancel={() => setRemovingMember(null)}
      />

      <ConfirmDialog
        open={blockingMember !== null}
        variant="danger"
        title={t("team.members.blockTitle", { defaultValue: "拉黑成员" })}
        message={t("team.members.blockMessage", {
          defaultValue:
            "将 {{name}} 移出团队并加入黑名单，对方将无法再次加入，直到你解除拉黑。",
          values: { name: blockingMember?.name ?? "" },
        })}
        confirmLabel={t("team.members.block", { defaultValue: "拉黑成员" })}
        cancelLabel={t("common.cancel", { defaultValue: "取消" })}
        isConfirming={blocking}
        onConfirm={() => {
          const target = blockingMember;
          if (target) {
            blockMember(target);
          }
        }}
        onCancel={() => setBlockingMember(null)}
      />

      <ConfirmDialog
        open={confirmAction !== null}
        variant="danger"
        title={
          confirmAction === "disband"
            ? t("team.members.disbandTitle", { defaultValue: "解散团队" })
            : t("team.members.leaveTitle", { defaultValue: "退出团队" })
        }
        message={
          confirmAction === "disband"
            ? t("team.members.disbandMessage", {
                defaultValue:
                  "解散后团队数据会从本机删除，队员将无法继续同步；此操作无法撤销。",
              })
            : t("team.members.leaveMessage", {
                defaultValue:
                  "退出后本机会删除该团队数据；再次加入需使用邀请链接并由队长审核。",
              })
        }
        confirmLabel={
          confirmAction === "disband"
            ? t("team.members.disband", { defaultValue: "解散团队" })
            : t("team.members.leave", { defaultValue: "退出团队" })
        }
        cancelLabel={t("common.cancel", { defaultValue: "取消" })}
        isConfirming={leaving}
        onConfirm={leave}
        onCancel={() => setConfirmAction(null)}
      />
    </div>
  );
};

// 供页签图标复用
export const TeamMembersIcon = Users;
