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
};

export type GitDiffResult = {
  content: string;
  isBinary: boolean;
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
  refs: string;
  parents: string[];
  /** 本次提交新增的行数（来自 git log --shortstat）。 */
  additions: number;
  /** 本次提交删除的行数（来自 git log --shortstat）。 */
  deletions: number;
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
