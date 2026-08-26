import type { ReactNode } from "react";
import type { TeamMember } from "../../../../preload";
import { avatarColor, initials, isOnline, memberName } from "./teamUtils";

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
  email,
  currentEmail,
  size = 24,
}: {
  members: TeamMember[];
  email: string;
  currentEmail?: string;
  size?: number;
}): React.JSX.Element => {
  const member = members.find((m) => m.email === email);
  const displayName = memberName(members, email);
  const isMe = currentEmail !== undefined && email === currentEmail;
  return (
    <span
      className="team-member-chip"
      title={`${email}${isMe ? "（我）" : ""}`}
    >
      <TeamAvatar
        name={displayName}
        seed={member?.avatarSeed ?? email}
        size={size}
        online={member ? isOnline(member) : false}
      />
      <span>{displayName}</span>
      {isMe ? <span className="team-me-tag">我</span> : null}
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
