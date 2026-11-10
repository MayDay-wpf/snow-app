import type {
  TeamMemberRecord,
  TeamMessage,
  TeamMessageAttachment,
  TeamNote,
  TeamTask,
  TeamTopic,
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

/** 成员展示名：按 peer id 查找，找不到时回退为 id 本身。 */
export const memberName = (
  members: TeamMemberRecord[],
  peerId: string,
): string => {
  const found = members.find((m) => m.peerId === peerId);
  if (found?.name) {
    return found.name;
  }
  return peerId || "?";
};

/** 成员头像种子（自定义色优先，其次 peer id 哈希）。 */
export const memberSeed = (
  members: TeamMemberRecord[],
  peerId: string,
): string => {
  const found = members.find((m) => m.peerId === peerId);
  return found?.color || peerId;
};

export const initials = (name: string): string => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const chars = parts
    .map((p) => p[0])
    .slice(0, 2)
    .join("");
  return (chars || "?").toUpperCase();
};

/** 头像调色板（可选自定义色的候选集合）。 */
export const AVATAR_COLORS = [
  "#e17076",
  "#eda283",
  "#6ba9d0",
  "#8fb96a",
  "#c98fdb",
  "#e0a35f",
  "#5fb9c0",
  "#d88a9a",
];

/** 自定义头像色（`#rrggbb`）判定。 */
export const isCustomAvatarColor = (seed: string): boolean =>
  /^#[0-9a-fA-F]{6}$/.test(seed.trim());

/** 头像图片（内嵌 base64 data URL）判定：只认图片，避免渲染外部 URL。 */
export const isAvatarImage = (seed: string): boolean =>
  /^data:image\/(?:png|jpe?g|webp|gif|avif);base64,/i.test(seed.trim());

/**
 * 头像颜色：种子为自定义色（`#rrggbb`）时直接使用，否则按种子前 6 位
 * （十六进制哈希）取调色板颜色；图片种子由头像组件直接渲染图片。
 */
export const avatarColor = (seed: string): string => {
  const trimmed = seed.trim();
  if (isCustomAvatarColor(trimmed)) {
    return trimmed;
  }
  const n = parseInt(trimmed.slice(0, 6) || "0", 16) || 0;
  return AVATAR_COLORS[n % AVATAR_COLORS.length];
};

/** i18n 翻译函数签名（与 useI18n 返回的 t 兼容）。 */
export type TranslateFn = (
  key: string,
  options?: { defaultValue?: string; values?: Record<string, string | number> },
) => string;

/** 相对时间描述（x 秒/分钟/小时前，超过 30 天显示日期）。 */
export const timeAgo = (
  at: string | number,
  t: TranslateFn,
  now: number = Date.now(),
): string => {
  const parsed = new Date(at).getTime();
  if (Number.isNaN(parsed)) {
    return "";
  }
  const diff = Math.max(0, now - parsed);
  const sec = Math.floor(diff / 1000);
  if (sec < 10) {
    return t("team.relativeTime.justNow");
  }
  if (sec < 60) {
    return t("team.relativeTime.secondsAgo", { values: { count: sec } });
  }
  const min = Math.floor(sec / 60);
  if (min < 60) {
    return t("team.relativeTime.minutesAgo", { values: { count: min } });
  }
  const hour = Math.floor(min / 60);
  if (hour < 24) {
    return t("team.relativeTime.hoursAgo", { values: { count: hour } });
  }
  const day = Math.floor(hour / 24);
  if (day < 30) {
    return t("team.relativeTime.daysAgo", { values: { count: day } });
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

/** 在线状态由队长广播（`online`）或最近心跳推导。 */
export const isOnline = (member: TeamMemberRecord): boolean => {
  if (member.online) {
    return true;
  }
  const at = new Date(member.lastSeen).getTime();
  if (Number.isNaN(at)) {
    return false;
  }
  return Date.now() - at < 15 * 60 * 1000;
};

export const TASK_STATUSES = ["todo", "in_progress", "review", "done"] as const;

/** 议题投票方向。 */
export const TOPIC_CHOICES = ["open", "closed"] as const;

/** 议题票数统计（每人一票）。 */
export const topicTally = (
  topic: TeamTopic,
): { open: number; closed: number } => {
  let open = 0;
  let closed = 0;
  for (const vote of topic.votes) {
    if (vote.choice === "open") {
      open += 1;
    } else if (vote.choice === "closed") {
      closed += 1;
    }
  }
  return { open, closed };
};

/**
 * 议题最终结论：队长一票否决优先并锁定；否则按票数多数。
 * 平票（含无人投票）视为暂未定案。
 */
export const topicOutcome = (
  topic: TeamTopic,
): {
  decision: "open" | "closed" | null;
  locked: boolean;
  open: number;
  closed: number;
} => {
  const { open, closed } = topicTally(topic);
  if (topic.veto) {
    return { decision: topic.veto.decision, locked: true, open, closed };
  }
  if (open === closed) {
    return { decision: null, locked: false, open, closed };
  }
  return {
    decision: open > closed ? "open" : "closed",
    locked: false,
    open,
    closed,
  };
};

/** 笔记正文中的附件引用前缀（迁移旧数据时由 Rust 重写而来）。 */
export const MEDIA_REF_PREFIX = "team-media:";

/** 把笔记正文里的 `team-media:<id>` 引用解析为 data URL。 */
export const resolveMediaRefs = async (
  content: string,
  read: (mediaId: string) => Promise<string>,
): Promise<string> => {
  if (!content.includes(MEDIA_REF_PREFIX)) {
    return content;
  }
  const ids = new Set<string>();
  let rest = content;
  while (true) {
    const index = rest.indexOf(MEDIA_REF_PREFIX);
    if (index < 0) {
      break;
    }
    const tail = rest.slice(index + MEDIA_REF_PREFIX.length);
    const end = tail.search(/[)\s"']/);
    ids.add(end < 0 ? tail : tail.slice(0, end));
    rest = end < 0 ? "" : tail.slice(end);
  }
  let resolved = content;
  for (const id of ids) {
    if (!id) {
      continue;
    }
    try {
      const url = await read(id);
      resolved = resolved.split(`${MEDIA_REF_PREFIX}${id}`).join(url);
    } catch {
      // 附件缺失时保留原始引用
    }
  }
  return resolved;
};

// ===== 活动事件推导 =====

export type TeamEvent = {
  key: string;
  at: number;
  type: "message" | "task" | "topic" | "note" | "member";
  authorPeerId: string;
  /** message | created | assigned | status | comment | vote | veto | joined */
  action: string;
  title?: string;
  detail?: string;
  content?: string;
  attachments?: TeamMessageAttachment[];
  refKind?: "task" | "topic" | "note" | "message";
  refId?: string;
};

const historyEvents = (
  kind: "task" | "topic",
  title: string,
  history: { at: string; by: string; action: string; detail: string }[],
  refId: string,
): TeamEvent[] =>
  history.map((h, i) => ({
    key: `${refId}-h-${i}`,
    at: new Date(h.at).getTime(),
    type: kind,
    authorPeerId: h.by,
    action: h.action,
    title,
    detail: h.detail,
    refKind: kind,
    refId,
  }));

export const buildTeamEvents = (team: {
  messages: TeamMessage[];
  tasks: TeamTask[];
  topics: TeamTopic[];
  notes: TeamNote[];
  members: TeamMemberRecord[];
}): TeamEvent[] => {
  const events: TeamEvent[] = [];

  for (const msg of team.messages) {
    events.push({
      key: `msg-${msg.id}`,
      at: new Date(msg.createdAt).getTime(),
      type: "message",
      authorPeerId: msg.authorPeerId,
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

  for (const topic of team.topics) {
    events.push(
      ...historyEvents("topic", topic.title, topic.history, topic.id),
    );
  }

  for (const note of team.notes) {
    events.push({
      key: `note-${note.id}`,
      at: new Date(note.createdAt).getTime(),
      type: "note",
      authorPeerId: note.authorPeerId,
      action: "created",
      title: note.title,
      detail: note.content.slice(0, 120),
      refKind: "note",
      refId: note.id,
    });
  }

  for (const member of team.members) {
    events.push({
      key: `member-${member.peerId}`,
      at: new Date(member.joinedAt).getTime(),
      type: "member",
      authorPeerId: member.peerId,
      action: "joined",
      title: member.name,
      refKind: "note",
      refId: "",
    });
  }

  // 时间升序：早的在上、新的在下
  return events.filter((e) => !Number.isNaN(e.at)).sort((a, b) => a.at - b.at);
};
