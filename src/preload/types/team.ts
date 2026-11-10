/** 团队协作类型定义（与 Rust serde 模型一一对应，camelCase）。 */

/** 本机所参与的团队。 */
export type TeamInfo = {
  teamId: string;
  name: string;
  /** 本机在该团队中的角色。 */
  role: "host" | "member";
  inviteCode: string;
  hostPeerId: string;
  hostName: string;
  /** 队长可连地址（`host:port`）。 */
  hostEndpoint: string;
  selfPeerId: string;
  selfName: string;
  selfColor: string;
  /** 队长模式：是否注册系统级常驻服务。 */
  hostService: boolean;
  createdAt: string;
  updatedAt: string;
};

/** 团队与本地项目的关联（一个团队可关联多个项目）。 */
export type TeamProjectLink = {
  teamId: string;
  directoryId: string;
  name: string;
};

/** 团队成员。 */
export type TeamMemberRecord = {
  peerId: string;
  name: string;
  color: string;
  role: "host" | "member";
  online: boolean;
  joinedAt: string;
  lastSeen: string;
};

/** 待队长审核的加入申请（仅队长服务运行时存在）。 */
export type TeamJoinRequest = {
  requestId: string;
  /** 申请方设备标识（黑名单依据）。 */
  clientId: string;
  name: string;
  color: string;
  createdAt: string;
};

/** 被队长拉黑的设备。 */
export type TeamBlockedMember = {
  clientId: string;
  name: string;
  blockedAt: string;
};

/** 加入团队的结果：直接加入成功，或已提交申请等待队长审核。 */
export type TeamJoinResult = {
  status: "joined" | "pending";
  team: TeamInfo | null;
};

/** 团队协作状态快照（当前项目所属团队 + 运行时连接状态）。 */
export type TeamState = {
  team: TeamInfo | null;
  /** 团队协作总开关（设置页「团队协作」）。 */
  enabled: boolean;
  role: string;
  /** 队长：服务运行中；队员：已连上队长。 */
  connected: boolean;
  endpoint: string;
  /** 队长专属：可直接分享的邀请链接。 */
  inviteLink: string;
  /** 队长专属：队长服务监听端口（固定端口，可在团队设置中修改）。 */
  hostPort: number;
  members: TeamMemberRecord[];
  projects: TeamProjectLink[];
  /** 队长专属：待审核的加入申请。 */
  joinRequests: TeamJoinRequest[];
  /** 队员：当前项目已提交加入申请、等待队长审核。 */
  pendingJoin: boolean;
  /** 当前项目下是否残留旧版基于 Git 的团队数据。 */
  legacyAvailable: boolean;
};

/** Rust 推送给渲染层的团队事件。 */
export type TeamEventPayload = {
  /** status / snapshot / members / record-upserted / record-deleted /
   *  media-uploaded / error / idle / removed / join-request（队长：申请列表变化）
   *  / join-pending（队员：等待审核）/ join-rejected（队员：被拒绝或被拉黑）。 */
  event: string;
  teamId: string;
  payloadJson: string;
};

/** 通用记录类型（review 为旧版评审数据，前端不再使用）。 */
export type TeamRecordKind = "message" | "task" | "topic" | "note";

export type TeamHistoryEntry = {
  at: string;
  /** 操作者 peer id。 */
  by: string;
  action: string;
  detail: string;
};

export type TeamComment = {
  id: string;
  authorPeerId: string;
  content: string;
  createdAt: string;
};

export type TeamTask = {
  id: string;
  title: string;
  description: string;
  creatorPeerId: string;
  assigneePeerId: string;
  status: "todo" | "in_progress" | "review" | "done";
  priority: "low" | "medium" | "high";
  labels: string[];
  linkedFiles: string[];
  createdAt: string;
  updatedAt: string;
  history: TeamHistoryEntry[];
};

/** 议题投票（每人一票，可改票）。 */
export type TeamTopicVote = {
  peerId: string;
  choice: "open" | "closed";
  updatedAt: string;
};

/** 队长一票否决：写下即锁定最终结论，不再变化。 */
export type TeamTopicVeto = {
  by: string;
  decision: "open" | "closed";
  at: string;
};

/** 团队议题：成员投票决定开启 / 关闭，队长可一票否决。 */
export type TeamTopic = {
  id: string;
  title: string;
  description: string;
  taskId: string | null;
  creatorPeerId: string;
  votes: TeamTopicVote[];
  veto: TeamTopicVeto | null;
  createdAt: string;
  updatedAt: string;
  history: TeamHistoryEntry[];
  comments: TeamComment[];
};

export type TeamNote = {
  id: string;
  title: string;
  content: string;
  authorPeerId: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
};

export type TeamMessageAttachment = {
  /** 附件 id（内容存于团队附件表，按需读取）。 */
  id: string;
  name: string;
  size: number;
  isImage: boolean;
};

export type TeamMessage = {
  id: string;
  channel: string;
  authorPeerId: string;
  content: string;
  attachments?: TeamMessageAttachment[];
  createdAt: string;
};
