import type { ReactNode } from "react";
import type { TeamMemberRecord } from "../../../../preload";
import { useI18n } from "../../../i18n";
import { AutoDismissNotice } from "../../AutoDismissNotice";
import {
  avatarColor,
  initials,
  isOnline,
  memberName,
  memberSeed,
} from "./teamUtils";

export type TeamAvatarProps = {
  name: string;
  seed: string;
  size?: number;
  online?: boolean;
};

export const TeamAvatar = ({
  name,
  seed,
  size = 28,
  online = false,
}: TeamAvatarProps): React.JSX.Element => (
  <span
    className={`team-avatar${online ? " is-online" : ""}`}
    style={{
      width: size,
      height: size,
      fontSize: Math.max(10, size * 0.38),
      background: avatarColor(seed || name),
    }}
    title={name}
  >
    {initials(name)}
  </span>
);

export const TeamMemberChip = ({
  members,
  peerId,
  currentPeerId,
  size = 24,
}: {
  members: TeamMemberRecord[];
  peerId: string;
  currentPeerId?: string;
  size?: number;
}): React.JSX.Element => {
  const { t } = useI18n();
  const member = members.find((m) => m.peerId === peerId);
  const displayName = memberName(members, peerId);
  const isMe = currentPeerId !== undefined && peerId === currentPeerId;
  return (
    <span
      className="team-member-chip"
      title={isMe ? `${displayName}${t("team.meInParens")}` : displayName}
    >
      <TeamAvatar
        name={displayName}
        seed={memberSeed(members, peerId)}
        size={size}
        online={member ? isOnline(member) : false}
      />
      <span>{displayName}</span>
      {isMe ? <span className="team-me-tag">{t("team.me")}</span> : null}
    </span>
  );
};

export const TeamEmpty = ({
  icon,
  text,
}: {
  icon: ReactNode;
  text: string;
}): React.JSX.Element => (
  <div className="team-empty">
    <span className="team-empty-icon">{icon}</span>
    <span>{text}</span>
  </div>
);

export const TeamSectionTitle = ({
  children,
}: {
  children: ReactNode;
}): React.JSX.Element => <div className="team-section-title">{children}</div>;

const TEAM_ERROR_NOTICE_MS = 4000;

/** 团队模式统一错误提示：顶部浮层自动消失，消失后回调清空错误态。 */
export const TeamErrorNotice = ({
  message,
  onDismiss,
}: {
  message: string | null;
  onDismiss: () => void;
}): React.JSX.Element | null =>
  message ? (
    <AutoDismissNotice
      message={message}
      tone="error"
      durationMs={TEAM_ERROR_NOTICE_MS}
      onDismiss={onDismiss}
    />
  ) : null;
