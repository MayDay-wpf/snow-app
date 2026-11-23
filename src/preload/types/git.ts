export type GitWorktreeInfo = {
  worktreeId: string;
  directoryId: string;
  repositoryPath: string;
  worktreePath: string;
  branchName: string | null;
  headOid: string;
  isDetached: boolean;
  isDirty: boolean;
  isValid: boolean;
};

/** 会话列表按页批量使用的工作树绑定视图。 */
export type ConversationWorktreeInfo = {
  conversationId: string;
  worktreeId: string;
  directoryId: string;
  repositoryPath: string;
  worktreePath: string;
  branchName: string | null;
  /** 工作树仍存在于其仓库中；外部删除后为 false。 */
  isValid: boolean;
};

export type GitFileStatus = {
  path: string;
  oldPath: string | null;
  indexStatus: string;
  workdirStatus: string;
  status: string;
};

export type GitStatusResult = {
  isRepo: boolean;
  currentBranch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFileStatus[];
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  /** True when the change list was truncated by the configured status limit. */
  statusLimitHit: boolean;
};

export type GitBranch = {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  remoteName: string | null;
  upstream?: string | null;
  ahead?: number;
  behind?: number;
  isGone?: boolean;
  worktreePath?: string | null;
};

export type GitWorktree = {
  path: string;
  head: string;
  branch: string | null;
  isCurrent: boolean;
  isLocked: boolean;
  lockReason: string | null;
  isPrunable?: boolean;
};

export type GitDiffResult = {
  content: string;
  isBinary: boolean;
  /** git 命令失败时的错误消息（成功时为空字符串）。 */
  error: string;
};

/** 单个 git 文件内容（工作区或某 revision），图片为 base64 + MIME。 */
export type GitFileContentResult = {
  content: string;
  isBinary: boolean;
  isImage: boolean;
  isSvg: boolean;
  mimeType: string;
  encoding: string;
  size: number;
};

/** 图片 diff 预览：旧版本（HEAD/父提交/索引）与新版本（工作区/提交）。 */
export type GitImageDiff = {
  old: GitFileContentResult | null;
  new: GitFileContentResult | null;
};

export type GitStageResult = {
  success: boolean;
  message: string;
};

export type GitCommitResult = {
  success: boolean;
  message: string;
  hash: string | null;
};

export type GitPushPullResult = {
  success: boolean;
  message: string;
};

export type GitCheckoutResult = {
  success: boolean;
  message: string;
};

export type GitLogEntry = {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  date: string;
  message: string;
  body?: string | null;
  refs: string;
  parents: string[];
  /** 本次提交新增的行数（来自 git log --shortstat）。 */
  additions: number;
  /** 本次提交删除的行数（来自 git log --shortstat）。 */
  deletions: number;
  /** 本次提交改动的文件数（git log --shortstat 的 "N file(s) changed"）。 */
  filesChanged: number;
  /** 是否已推送到远端：被任一远端跟踪分支（refs/remotes/*）包含。 */
  pushed: boolean;
  /** 是否落后：在 upstream 上但 HEAD 尚未包含（未拉取）。 */
  behind: boolean;
};
export type GitCommitFile = {
  path: string;
  status: string;
};

export type GitRepoInfo = {
  path: string;
  name: string;
  currentBranch: string;
};

export type GitIdentity = {
  isRepo: boolean;
  repoPath: string;
  name: string;
  email: string;
  remoteUrl: string;
  hasIdentity: boolean;
  error: string | null;
};

export type GitRemoteInfo = {
  name: string;
  fetchUrl: string | null;
  pushUrl: string | null;
};
