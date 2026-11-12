export type RepoWikiPageStatus = "pending" | "generating" | "done" | "failed";

export type RepoWikiStatus =
  "running" | "paused" | "completed" | "failed" | "stopped";

export type RepoWikiPhase =
  "analyzing" | "catalog" | "pages" | "saving" | "done";

export type RepoWikiSource = {
  path: string;
  startLine: number;
  endLine: number;
};

export type RepoWikiPage = {
  id: string;
  title: string;
  description: string;
  parentId: string | null;
  files: string[];
  status: RepoWikiPageStatus;
  content: string;
  sources: RepoWikiSource[];
  error: string | null;
  updatedAt: number;
};

export type RepoWikiRecord = {
  version: number;
  projectPath: string;
  projectName: string;
  title: string;
  summary: string;
  language: string;
  apiProfile: string;
  model: string;
  diagrams: boolean;
  retries: number;
  autoRefresh: boolean;
  status: RepoWikiStatus;
  phase: RepoWikiPhase;
  error: string | null;
  branch: string | null;
  commit: string | null;
  createdAt: number;
  updatedAt: number;
  generatedAt: number | null;
  pages: RepoWikiPage[];
};

export type RepoWikiEvent = {
  projectPath: string;
  kind: "status" | "page" | "activity" | string;
  status: string;
  phase: string;
  pageId?: string | null;
  pageStatus?: string | null;
  activityTool?: string | null;
  activityTarget?: string | null;
  error?: string | null;
  totalPages: number;
  donePages: number;
  failedPages: number;
};

export type RepoWikiStartOptions = {
  projectPath: string;
  projectName?: string;
  language: "zh-CN" | "en";
  apiProfile?: string;
  model?: string;
  diagrams: boolean;
  retries: number;
};

export type RepoWikiSettingsOptions = Omit<RepoWikiStartOptions, "projectName">;
