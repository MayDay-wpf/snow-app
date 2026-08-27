/** 基于 Git 的团队协作类型定义（与 Rust serde 模型一一对应）。 */

export type TeamIdentity = {
  isRepo: boolean;
  /** 解析出的真实仓库根路径（团队操作都应使用它）。 */
  repoPath: string;
  name: string;
  email: string;
  remoteUrl: string;
  hasIdentity: boolean;
  error: string | null;
};

export type TeamSyncResult = {
  ok: boolean;
  initialized: boolean;
  pulled: boolean;
  pushed: boolean;
  localAhead: number;
  localBehind: number;
  error: string | null;
};

export type TeamHistoryEntry = {
  at: string;
  by: string;
  action: string;
  detail: string;
};

export type TeamComment = {
  id: string;
  authorEmail: string;
  content: string;
  createdAt: string;
};

export type TeamTask = {
  id: string;
  title: string;
  description: string;
  creatorEmail: string;
  assigneeEmail: string;
  status: "todo" | "in_progress" | "review" | "done";
  priority: "low" | "medium" | "high";
  labels: string[];
  linkedFiles: string[];
  createdAt: string;
  updatedAt: string;
  history: TeamHistoryEntry[];
};

export type TeamReview = {
  id: string;
  title: string;
  taskId: string | null;
  branch: string;
  baseBranch: string;
  creatorEmail: string;
  reviewerEmail: string;
  status: "pending" | "approved" | "rejected" | "merged";
  summary: string;
  createdAt: string;
  updatedAt: string;
  history: TeamHistoryEntry[];
  comments: TeamComment[];
};

export type TeamNote = {
  id: string;
  title: string;
  content: string;
  authorEmail: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
};

export type TeamMember = {
  email: string;
  name: string;
  role: string;
  avatarSeed: string;
  joinedAt: string;
  lastSeen: string;
};

export type TeamMessageAttachment = {
  /** 原文件名。 */
  name: string;
  /** `snow-team/media/<message_id>/<file>` 相对路径。 */
  path: string;
  size: number;
  isImage: boolean;
};

export type TeamMessage = {
  id: string;
  channel: string;
  authorEmail: string;
  content: string;
  attachments?: TeamMessageAttachment[];
  createdAt: string;
};

export type TeamRecordKind = "member" | "task" | "review" | "note" | "message";
