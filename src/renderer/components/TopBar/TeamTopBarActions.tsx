import { Copy, Loader2, Pencil, Server, X } from "lucide-react";
import { useState } from "react";
import { useI18n } from "../../i18n";
import { TeamAvatar } from "../mainContent/team/TeamShared";
import { useTeamTopBarSnapshot } from "./teamTopBarStore";

/**
 * TopBar 上的团队协作操作区（仅团队视图渲染）：展示团队名、连接状态、
 * 队长邀请入口与常驻服务开关，以及当前身份与关闭入口。数据由 TeamPanel
 * 通过 teamTopBarStore 发布，未就绪时只保留关闭按钮。
 */
export const TeamTopBarActions = ({
  onClose,
}: {
  onClose: () => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const team = useTeamTopBarSnapshot();
  const [copied, setCopied] = useState(false);
  const closeLabel = t("team.header.close", { defaultValue: "关闭团队协作" });

  const closeButton = (
    <button
      className="icon-btn ghost feature-page-close-btn"
      type="button"
      aria-label={closeLabel}
      title={closeLabel}
      onClick={onClose}
    >
      <X size={16} strokeWidth={1.8} />
    </button>
  );

  if (!team) {
    return closeButton;
  }

  const isHost = team.role === "host";
  const statusText = team.connected
    ? isHost
      ? t("team.header.hostRunning", { defaultValue: "服务运行中" })
      : t("team.header.memberConnected", { defaultValue: "已连接队长" })
    : isHost
      ? t("team.header.hostStopped", { defaultValue: "服务已停止" })
      : t("team.header.memberOffline", { defaultValue: "未连接队长" });
  const statusTitle = team.error ?? team.endpoint ?? statusText;

  const copyInvite = (): void => {
    if (!team.inviteLink) {
      return;
    }
    void navigator.clipboard
      .writeText(team.inviteLink)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => undefined);
  };

  return (
    <>
      <button
        className={`top-bar-team-sync${team.connected ? "" : " is-error"}`}
        type="button"
        aria-label={statusTitle}
        title={statusTitle}
      >
        <span
          className={`top-bar-team-status-dot${team.connected ? " is-online" : ""}`}
        />
        <span className="top-bar-team-sync-text">{statusText}</span>
      </button>
      {isHost ? (
        <>
          <button
            className={`top-bar-team-sync${team.hostService ? "" : " is-error"}`}
            type="button"
            aria-label={t("team.header.hostService", {
              defaultValue: "队长常驻服务",
            })}
            title={t("team.header.hostServiceHint", {
              defaultValue:
                "开启后，登录系统时自动后台启动 Snow，队长关窗或设备重启后团队仍保持在线。",
            })}
            disabled={team.hostServiceBusy}
            onClick={() => team.toggleHostService(!team.hostService)}
          >
            {team.hostServiceBusy ? (
              <Loader2 size={13} className="spin" />
            ) : (
              <Server size={13} />
            )}
            <span className="top-bar-team-sync-text">
              {t("team.header.hostService", { defaultValue: "常驻" })}
            </span>
          </button>
          <button
            className="top-bar-team-sync"
            type="button"
            aria-label={t("team.header.copyInvite", {
              defaultValue: "复制邀请链接",
            })}
            title={team.inviteLink || statusText}
            disabled={!team.inviteLink}
            onClick={copyInvite}
          >
            <Copy size={13} />
            <span className="top-bar-team-sync-text">
              {copied
                ? t("team.header.inviteCopied", { defaultValue: "已复制" })
                : t("team.header.invite", { defaultValue: "邀请" })}
            </span>
          </button>
        </>
      ) : null}
      <div className="top-bar-team-me">
        <TeamAvatar
          name={team.meName}
          seed={team.meSeed}
          size={22}
          online={team.connected}
        />
        <span className="top-bar-team-me-name">{team.meName}</span>
        <button
          className="icon-btn ghost top-bar-team-edit"
          type="button"
          aria-label={t("team.header.editIdentity", {
            defaultValue: "修改我的资料",
          })}
          title={t("team.header.editIdentity", {
            defaultValue: "修改我的资料",
          })}
          onClick={team.editIdentity}
        >
          <Pencil size={13} />
        </button>
      </div>
      {closeButton}
    </>
  );
};
