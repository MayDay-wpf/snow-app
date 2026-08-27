import type {
  TeamMember,
  TeamMessage,
  TeamMessageAttachment,
  TeamNote,
  TeamReview,
  TeamTask,
} from "../../../../preload";

/** 解析 Rust 侧返回的原始 JSON 记录数组。 */
export const parseRecords = <T>(raw: string[]): T[] => {
  const out: T[] = [];
  for (const item of raw) {
    try {
      const parsed = JSON.parse(item) as T;
      if (parsed) {
        out.push(parsed);
      }
    } catch {
      // 跳过损坏记录
    }
  }
  return out;
};

export const nowIso = (): string => new Date().toISOString();

export const newId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const memberName = (members: TeamMember[], email: string): string => {
  const found = members.find((m) => m.email === email);
  if (found?.name) {
    return found.name;
  }
  const local = email.split("@")[0] ?? email;
  return local || email;
};

export const initials = (name: string): string => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const chars = parts
    .map((p) => p[0])
    .slice(0, 2)
    .join("");
  return (chars || "?").toUpperCase();
};

const AVATAR_COLORS = [
  "#e17076",
  "#eda283",
  "#6ba9d0",
  "#8fb96a",
  "#c98fdb",
  "#e0a35f",
  "#5fb9c0",
  "#d88a9a",
];

export const avatarColor = (seed: string): string => {
  const n = parseInt(seed.slice(0, 6) || "0", 16) || 0;
  return AVATAR_COLORS[n % AVATAR_COLORS.length];
};

/** 相对时间描述（x 秒/分钟/小时前，超过 1 天显示日期）。 */
export const timeAgo = (
  at: string | number,
  now: number = Date.now(),
): string => {
  const parsed = new Date(at).getTime();
  if (Number.isNaN(parsed)) {
    return "";
  }
  const diff = Math.max(0, now - parsed);
  const sec = Math.floor(diff / 1000);
  if (sec < 10) {
    return "刚刚";
  }
  if (sec < 60) {
    return `${sec} 秒前`;
  }
  const min = Math.floor(sec / 60);
  if (min < 60) {
    return `${min} 分钟前`;
  }
  const hour = Math.floor(min / 60);
  if (hour < 24) {
    return `${hour} 小时前`;
  }
  const day = Math.floor(hour / 24);
  if (day < 30) {
    return `${day} 天前`;
  }
  return new Date(at).toLocaleDateString();
};

export const formatTime = (iso: string): string => {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) {
    return "";
  }
  return at.toLocaleString();
};

// 在线窗口需大于 Rust 侧心跳刷新间隔（10 分钟），否则自己会误判离线
export const isOnline = (member: TeamMember): boolean => {
  const at = new Date(member.lastSeen).getTime();
  if (Number.isNaN(at)) {
    return false;
  }
  return Date.now() - at < 15 * 60 * 1000;
};

export const TASK_STATUSES = ["todo", "in_progress", "review", "done"] as const;
export const REVIEW_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "merged",
] as const;

// ===== 活动事件推导 =====

export type TeamEvent = {
  key: string;
  at: number;
  type: "message" | "task" | "review" | "note" | "member";
  authorEmail: string;
  /** message | created | assigned | status | comment | approved | rejected | merged | joined */
  action: string;
  title?: string;
  detail?: string;
  content?: string;
  attachments?: TeamMessageAttachment[];
  refKind?: "task" | "review" | "note" | "message";
  refId?: string;
};

const historyEvents = (
  kind: "task" | "review",
  title: string,
  history: { at: string; by: string; action: string; detail: string }[],
  refId: string,
): TeamEvent[] =>
  history.map((h, i) => ({
    key: `${refId}-h-${i}`,
    at: new Date(h.at).getTime(),
    type: kind,
    authorEmail: h.by,
    action: h.action,
    title,
    detail: h.detail,
    refKind: kind,
    refId,
  }));

export const buildTeamEvents = (team: {
  messages: TeamMessage[];
  tasks: TeamTask[];
  reviews: TeamReview[];
  notes: TeamNote[];
  members: TeamMember[];
}): TeamEvent[] => {
  const events: TeamEvent[] = [];

  for (const msg of team.messages) {
    events.push({
      key: `msg-${msg.id}`,
      at: new Date(msg.createdAt).getTime(),
      type: "message",
      authorEmail: msg.authorEmail,
      action: "message",
      content: msg.content,
      attachments: msg.attachments ?? [],
      refKind: "message",
      refId: msg.id,
    });
  }

  for (const task of team.tasks) {
    events.push(...historyEvents("task", task.title, task.history, task.id));
  }

  for (const review of team.reviews) {
    events.push(
      ...historyEvents("review", review.title, review.history, review.id),
    );
  }

  for (const note of team.notes) {
    events.push({
      key: `note-${note.id}`,
      at: new Date(note.createdAt).getTime(),
      type: "note",
      authorEmail: note.authorEmail,
      action: "created",
      title: note.title,
      detail: note.content.slice(0, 120),
      refKind: "note",
      refId: note.id,
    });
  }

  for (const member of team.members) {
    events.push({
      key: `member-${member.email}`,
      at: new Date(member.joinedAt).getTime(),
      type: "member",
      authorEmail: member.email,
      action: "joined",
      title: member.name,
      refKind: "note",
      refId: "",
    });
  }

  // 时间升序：早的在上、新的在下（成员加入等早期事件位置固定，新动态追加到底部）
  return events.filter((e) => !Number.isNaN(e.at)).sort((a, b) => a.at - b.at);
};
